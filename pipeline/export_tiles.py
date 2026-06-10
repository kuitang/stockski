#!/usr/bin/env python
"""Export tiled heightfield + manifest for one era (CONTRACTS section 2).

Input : data/<era>_order.json, data/parquet/*.parquet, data/universe.parquet,
        data/rf.parquet, data/parquet/SPY.parquet, era from pipeline/eras.json.
Output: game/public/tiles/<era>/manifest.json and z/t<T>_l<L>.bin
        (little-endian int16, row-major [day][lane], TILE_DAYS*TILE_LANES entries).

z_i(d) = c_i + log(P_i(d) / P_i(first day in era)) (PLAN section 1).
Datum offset c_i: lanes alive at era start get c_i = 0; lanes born later get the
plain median z of the nearest 21 alive lanes at their listing date (cap-weighted
median is unavailable without point-in-time caps -- noted per task spec).
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Mirrors of game/src/config.js CFG (CONTRACTS section 0) -- pipeline cannot import JS.
K_HEIGHT = 25      # h = K * z; stored tiles hold z, K is informational in the manifest
TILE_DAYS = 64     # tile time extent (CONTRACTS section 0)
TILE_LANES = 128   # tile lane extent; nLanes padded to a multiple of this (CONTRACTS section 2)
Z_SCALE = 1000     # int16 fixed point: stored = round(z * 1000)
Z_NAN = -32768     # int16 sentinel: no terrain (pre-IPO / post-death void)
Z_MAX_INT = 32767  # clip ceiling so a legitimate extreme z can never collide with the sentinel
NEIGHBORHOOD = 21  # datum offset: median over the nearest 21 alive lanes ~ a local "neighborhood" (PLAN 1)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ordering import load_era  # same CLI/--config contract (CONTRACTS section 5)


def load_sectors(data_dir: Path) -> dict:
    """Sector per symbol from EODHD symbol-list JSONs if present, else empty (-> 'Unknown')."""
    sectors = {}
    for p in sorted(set(data_dir.glob("**/*symbols*.json"))):
        try:
            recs = json.loads(p.read_text())
        except Exception:
            continue
        if not isinstance(recs, list):
            continue
        for r in recs:
            if isinstance(r, dict) and "Code" in r:
                sec = r.get("Sector") or r.get("sector")
                if sec:
                    sectors[str(r["Code"])] = str(sec)
    return sectors


def _load_adj_close(data_dir: Path, sym: str) -> pd.Series:
    df = pd.read_parquet(data_dir / "parquet" / f"{sym}.parquet",
                         columns=["date", "adjusted_close"])
    return pd.Series(df["adjusted_close"].values, index=pd.to_datetime(df["date"])).sort_index()


def build_era(era: dict, order: list, data_dir: Path, out_root: Path):
    """Build tiles + manifest. Returns (Z_float [nDays x nRealLanes], manifest dict)."""
    data_dir, out_root = Path(data_dir), Path(out_root)
    start, end = pd.Timestamp(era["start"]), pd.Timestamp(era["end"])
    uni = pd.read_parquet(data_dir / "universe.parquet").set_index("symbol")
    sectors = load_sectors(data_dir)

    # --- per-lane price series inside the era; union trading calendar ----------
    series = {}
    for sym in order:
        s = _load_adj_close(data_dir, sym)
        s = s[(s.index >= start) & (s.index <= end)].dropna()
        if len(s) > 0:
            series[sym] = s
    lanes_syms = [s for s in order if s in series]
    dropped = [s for s in order if s not in series]
    if dropped:
        print(f"note: {len(dropped)} ordered symbols had no era prices and were dropped: {dropped[:10]}")

    dates = pd.DatetimeIndex(sorted(set().union(*[set(s.index) for s in series.values()])))
    n_days = len(dates)
    n_real = len(lanes_syms)
    n_lanes = math.ceil(n_real / TILE_LANES) * TILE_LANES  # pad to tile multiple (CONTRACTS 2)

    Z = np.full((n_days, n_real), np.nan)
    born = np.zeros(n_real, dtype=int)
    last = np.zeros(n_real, dtype=int)
    for li, sym in enumerate(lanes_syms):
        s = series[sym].reindex(dates)
        b = int(dates.get_loc(s.first_valid_index()))
        l = int(dates.get_loc(s.last_valid_index()))
        # forward-fill inside the validity span: a non-trading day still has a last price,
        # and pinholes in the terrain would be artifacts, not market facts
        s.iloc[b:l + 1] = s.iloc[b:l + 1].ffill()
        born[li], last[li] = b, l
        Z[b:l + 1, li] = np.log(s.iloc[b:l + 1].values / s.iloc[b])

    # --- datum offsets c_i (PLAN section 1) -------------------------------------
    # Cap-weighted local median is unavailable (no point-in-time caps in v1 data),
    # so we use the plain median -- noted here per the task spec.
    c = np.zeros(n_real)
    finalized = born == 0  # lanes alive at era start: c_i = 0 by definition
    for li in sorted(np.flatnonzero(~finalized), key=lambda i: (born[i], i)):
        b = born[li]
        alive = np.flatnonzero(finalized & (born <= b) & (last >= b))
        if len(alive) > 0:
            d = np.abs(alive - li)
            d = np.minimum(d, n_real - d)  # circular lane distance (the stock axis wraps)
            nearest = alive[np.argsort(d, kind="stable")[:NEIGHBORHOOD]]
            c[li] = float(np.median(Z[b, nearest]))
        Z[:, li] += c[li]
        finalized[li] = True

    # --- lane metadata ----------------------------------------------------------
    lanes_meta = []
    for li, sym in enumerate(lanes_syms):
        u = uni.loc[sym] if sym in uni.index else None
        delisted = bool(u["is_delisted"]) if u is not None else False
        term = str(u["termination"]) if u is not None else "unknown"
        # dead = -1 <=> alive at era end (CONTRACTS 2): data reaching the last era day
        # and not delisted within the era counts as alive
        dead = -1 if (last[li] == n_days - 1 and not delisted) else int(last[li])
        lanes_meta.append({
            "sym": sym,
            "name": str(u["name"]) if u is not None else sym,
            "sector": sectors.get(sym, "Unknown"),
            "c": float(c[li]),
            "born": int(born[li]),
            "dead": dead,
            "term": term if dead != -1 else "alive",
        })
    for _ in range(n_real, n_lanes):  # padding lanes: born = -1 marks "never exists"
        lanes_meta.append({"sym": "", "name": "", "sector": "Unknown",
                           "c": 0.0, "born": -1, "dead": -1, "term": "unknown"})

    # --- ghost (SPY cumulative log return, aligned to dates) ---------------------
    spy = _load_adj_close(data_dir, "SPY")
    spy = spy[(spy.index >= start) & (spy.index <= end)].reindex(dates).ffill()
    fv = spy.first_valid_index()
    ghost_z = np.zeros(n_days) if fv is None else np.log(spy.values / spy.loc[fv])
    ghost_z = np.where(np.isfinite(ghost_z), ghost_z, 0.0)  # leading gap (SPY not yet listed) -> flat 0

    # --- r_f (trailing-only; forward-fill is causal, leading gaps -> 0) ----------
    rf_df = pd.read_parquet(data_dir / "rf.parquet")
    rf_s = pd.Series(rf_df["rf_annual"].values, index=pd.to_datetime(rf_df["date"])).sort_index()
    rf = rf_s.reindex(dates).ffill().fillna(0.0)

    # --- quantize + write tiles ---------------------------------------------------
    Zq = np.full((n_days, n_lanes), Z_NAN, dtype=np.int16)
    fin = np.isfinite(Z)
    Zq[:, :n_real][fin] = np.clip(np.round(Z[fin] * Z_SCALE), -Z_MAX_INT, Z_MAX_INT).astype(np.int16)

    era_dir = out_root / era["name"]
    (era_dir / "z").mkdir(parents=True, exist_ok=True)
    n_t = math.ceil(n_days / TILE_DAYS)
    n_l = n_lanes // TILE_LANES
    for T in range(n_t):
        for L in range(n_l):
            tile = np.full((TILE_DAYS, TILE_LANES), Z_NAN, dtype=np.int16)
            d0, d1 = T * TILE_DAYS, min((T + 1) * TILE_DAYS, n_days)
            tile[: d1 - d0, :] = Zq[d0:d1, L * TILE_LANES:(L + 1) * TILE_LANES]
            tile.astype("<i2").tofile(era_dir / "z" / f"t{T}_l{L}.bin")

    manifest = {
        "era": era["name"],
        "kHeight": K_HEIGHT,
        "tileDays": TILE_DAYS,
        "tileLanes": TILE_LANES,
        "nDays": n_days,
        "nLanes": n_lanes,
        "dates": [d.strftime("%Y-%m-%d") for d in dates],
        "lanes": lanes_meta,
        "ghost": {"sym": "SPY", "z": [float(v) for v in ghost_z]},
        "rf": [float(v) for v in rf.values],
    }
    (era_dir / "manifest.json").write_text(json.dumps(manifest))
    return Z, manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--era", required=True)
    ap.add_argument("--data-dir", default="data/")
    ap.add_argument("--out", default="game/public/tiles/")
    ap.add_argument("--config", default=str(Path(__file__).parent / "eras.json"))
    args = ap.parse_args(argv)

    data_dir = Path(args.data_dir)
    era = load_era(Path(args.config), args.era)
    order = json.loads((data_dir / f"{era['name']}_order.json").read_text())
    Z, manifest = build_era(era, order, data_dir, Path(args.out))
    print(f"GATE {json.dumps({'ok': True, 'era': era['name'], 'nDays': manifest['nDays'], 'nLanes': manifest['nLanes']})}")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).parent))
    sys.exit(main())
