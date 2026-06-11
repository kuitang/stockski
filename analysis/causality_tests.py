#!/usr/bin/env python
"""Causality acceptance test (PLAN section 4 / section 6.5).

Plants a synthetic step change in a small REAL slice of the data and asserts that
NO exported quantity reflects it before its day D:

  * copies ~32 real symbols (a contiguous run of data/recent2y_order.json, plus
    in-window IPOs to exercise the datum-offset path) + SPY + rf.parquet into a
    temp data dir;
  * injects a +50% price step on day D (a fixed mid-era date) into one symbol's
    close/adjusted_close, in a second copy of the data dir;
  * runs the real pipeline CLI (export_tiles.main, which also embeds the ghost
    and r_f series in the manifest; there is no metrics.py in the pipeline yet,
    so "metrics" artifacts are reported as absent) on baseline + perturbed dirs;
  * compares every exported artifact: tile z values, manifest ghost, manifest rf,
    manifest dates and lane metadata. Lane ORDERING is exempt per PLAN 4.1 (it is
    a build-time layout fit, pooled over all eras); the same order file is fed to
    both runs.
  * repeats with the step injected into SPY (ghost channel) and into rf.parquet
    (r_f channel);
  * verifies export_tiles never emits days beyond the era end: manifest dates
    are <= end, tile files stop at ceil(nDays/TILE_DAYS), and rows past nDays in
    the last tile row-block are all Z_NAN sentinel.

Deterministic, offline (no network). Run:
  .venv/bin/python analysis/causality_tests.py
Prints per-artifact PASS/FAIL lines and a final machine-readable GATE line.
"""
import io
import json
import math
import shutil
import sys
from contextlib import redirect_stdout
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import export_tiles  # the real exporter under test (CONTRACTS section 2)

DATA = ROOT / "data"
TMP = DATA / "tmp_causality"           # all artifacts live here; never under game/public (live server)
ERA_NAME = "causal"
ERA_START = "2024-06-10"               # = recent2y start (pipeline/eras.json)
ERA_END = "2025-06-10"                 # fixed end < latest data: also exercises the era-end clamp
D_DATE = "2024-12-10"                  # step day D: mid-era, ~126 trading days in
STEP = 1.5                             # +50% step (task spec)
N_BASE = 30                            # contiguous full-span lanes: small but multi-lane (2+ lane tiles? no: 1 tile col, fine)
TILE_DAYS = export_tiles.TILE_DAYS
TILE_LANES = export_tiles.TILE_LANES
Z_NAN = export_tiles.Z_NAN

results = []  # (artifact, passed, detail)


def check(artifact: str, passed: bool, detail: str = ""):
    results.append((artifact, bool(passed), detail))
    print(f"{'PASS' if passed else 'FAIL'}  {artifact}" + (f"  -- {detail}" if detail else ""))


def pick_symbols():
    """A contiguous run of the real spectral order with full era coverage, plus in-window IPOs.

    universe.parquet first_date is QC-window-restricted, so IPO candidates are verified
    against the PARQUET's actual first date (full history) -- the exporter sees the parquet."""
    order = json.loads((DATA / "recent2y_order.json").read_text())
    uni = pd.read_parquet(DATA / "universe.parquet").set_index("symbol")

    def pq_span(sym):
        d = pd.read_parquet(DATA / "parquet" / f"{sym}.parquet", columns=["date"])["date"]
        return str(d.min()), str(d.max())

    base, ipo_pre, ipo_post = [], None, None
    for sym in order:
        if sym not in uni.index or not (DATA / "parquet" / f"{sym}.parquet").exists():
            continue
        fd_u, ld_u = str(uni.loc[sym, "first_date"]), str(uni.loc[sym, "last_date"])
        if ld_u < ERA_END:
            continue
        if fd_u <= ERA_START:
            if len(base) < N_BASE:
                base.append(sym)
        elif ERA_START < fd_u < ERA_END and (ipo_pre is None or ipo_post is None):
            fd, ld = pq_span(sym)  # confirm it is a true in-era IPO in the data the exporter reads
            if ld >= ERA_END:
                # one born before D (c_i must be unaffected), one after (c_i may legitimately move)
                if ERA_START < fd < D_DATE and ipo_pre is None:
                    ipo_pre = sym
                elif D_DATE < fd < ERA_END and ipo_post is None:
                    ipo_post = sym
        if len(base) >= N_BASE and ipo_pre and ipo_post:
            break
    assert len(base) == N_BASE and ipo_pre and ipo_post, "slice selection failed"
    syms = base[: N_BASE // 2] + [ipo_pre] + base[N_BASE // 2 :] + [ipo_post]
    return syms, ipo_pre, ipo_post


def make_data_dir(dst: Path, syms, perturb=None):
    """Copy the slice into dst; perturb = ('stock', sym) | ('spy',) | ('rf',) injects the +50% step
    (or +50% rate step for rf) on every day >= D_DATE."""
    if dst.exists():
        shutil.rmtree(dst)
    (dst / "parquet").mkdir(parents=True)

    def step_prices(df):
        m = pd.to_datetime(df["date"]) >= pd.Timestamp(D_DATE)
        for col in ("open", "high", "low", "close", "adjusted_close"):
            df.loc[m, col] = df.loc[m, col] * STEP
        return df

    for sym in syms + ["SPY"]:
        df = pd.read_parquet(DATA / "parquet" / f"{sym}.parquet")
        if perturb == ("stock", sym) or (perturb == ("spy",) and sym == "SPY"):
            df = step_prices(df)
        df.to_parquet(dst / "parquet" / f"{sym}.parquet", index=False)

    uni = pd.read_parquet(DATA / "universe.parquet")
    uni[uni["symbol"].isin(syms)].to_parquet(dst / "universe.parquet", index=False)

    rf = pd.read_parquet(DATA / "rf.parquet")
    if perturb == ("rf",):
        m = pd.to_datetime(rf["date"]) >= pd.Timestamp(D_DATE)
        rf.loc[m, "rf_annual"] = rf.loc[m, "rf_annual"] * STEP
    rf.to_parquet(dst / "rf.parquet", index=False)

    (dst / f"{ERA_NAME}_order.json").write_text(json.dumps(syms))
    (dst / "eras.json").write_text(json.dumps({ERA_NAME: {
        "name": ERA_NAME, "start": ERA_START, "end": ERA_END, "top_n": len(syms)}}))


def run_export(data_dir: Path, out_root: Path):
    """Run the real CLI entry point; returns (manifest, {tile name: int16 array})."""
    buf = io.StringIO()
    with redirect_stdout(buf):  # keep the exporter's own GATE line out of our report
        rc = export_tiles.main(["--era", ERA_NAME, "--data-dir", str(data_dir),
                                "--out", str(out_root), "--config", str(data_dir / "eras.json")])
    assert rc == 0, f"export_tiles failed for {data_dir}:\n{buf.getvalue()}"
    era_dir = out_root / ERA_NAME
    manifest = json.loads((era_dir / "manifest.json").read_text())
    tiles = {p.name: np.fromfile(p, dtype="<i2").reshape(TILE_DAYS, TILE_LANES)
             for p in sorted((era_dir / "z").glob("t*_l*.bin"))}
    return manifest, tiles


def day_split(manifest):
    """Index of first day >= D_DATE in the era calendar."""
    return int(np.searchsorted(np.array(manifest["dates"], dtype="U10"), D_DATE))


def compare_tiles(name, base_tiles, pert_tiles, d_idx, expect_late_diff_lane=None):
    """Assert tile z equality for all global days < d_idx; optionally that days >= d_idx DO differ."""
    assert base_tiles.keys() == pert_tiles.keys(), "tile file sets differ"
    pre_ok, late_diff_rows = True, 0
    for tname in base_tiles:
        T = int(tname.split("_")[0][1:])
        g0 = T * TILE_DAYS
        rows_pre = max(0, min(d_idx - g0, TILE_DAYS))
        a, b = base_tiles[tname], pert_tiles[tname]
        if rows_pre and not np.array_equal(a[:rows_pre], b[:rows_pre]):
            pre_ok = False
        late_diff_rows += int(np.sum(np.any(a[rows_pre:] != b[rows_pre:], axis=1)))
    check(f"{name}: tile z, all days < D identical", pre_ok)
    if expect_late_diff_lane is not None:
        check(f"{name}: tile z, step visible on days >= D (test has power)", late_diff_rows > 0,
              f"{late_diff_rows} differing day-rows after D")
    else:
        check(f"{name}: tile z unaffected on ALL days (perturbation not in tiles channel)",
              late_diff_rows == 0)


def compare_series(name, a, b, d_idx, expect_late_diff):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    check(f"{name}: days < D identical", np.array_equal(a[:d_idx], b[:d_idx]))
    if expect_late_diff:
        check(f"{name}: step visible on days >= D (test has power)",
              not np.array_equal(a[d_idx:], b[d_idx:]))
    else:
        check(f"{name}: unaffected on ALL days", np.array_equal(a[d_idx:], b[d_idx:]))


def compare_lane_meta(name, base_m, pert_m, d_idx):
    """Lane metadata: everything identical except c (datum offset) of lanes born >= D, which may
    legitimately read the perturbed neighborhood at its (post-D) listing day -- that lane has no
    terrain before D, so nothing observable leaks before D."""
    ok, detail = True, ""
    for lb, lp in zip(base_m["lanes"], pert_m["lanes"]):
        for k in ("sym", "name", "sector", "born", "dead", "term", "dv0"):
            if lb[k] != lp[k]:
                ok, detail = False, f"lane {lb['sym']}: field {k} {lb[k]} != {lp[k]}"
        if lb["c"] != lp["c"] and not (lb["born"] >= d_idx):
            ok, detail = False, f"lane {lb['sym']} born {lb['born']} < D={d_idx}: c moved {lb['c']} -> {lp['c']}"
    check(f"{name}: lane metadata (born/dead/term/dv0; c for lanes born < D) identical", ok, detail)
    check(f"{name}: era calendar identical", base_m["dates"] == pert_m["dates"])


def check_era_end(manifest, tiles, out_root):
    end = ERA_END
    dates = manifest["dates"]
    check("era-end: no manifest date beyond era end", max(dates) <= end,
          f"last date {max(dates)} <= {end}")
    n_days, n_lanes = manifest["nDays"], manifest["nLanes"]
    n_t, n_l = math.ceil(n_days / TILE_DAYS), n_lanes // TILE_LANES
    extra = [n for n in tiles if int(n.split("_")[0][1:]) >= n_t]
    check("era-end: no tile file starts at/after the era's last day-block",
          len(tiles) == n_t * n_l and not extra,
          f"{len(tiles)} tiles == {n_t}x{n_l}; extra={extra}")
    pad_ok = all(np.all(tiles[f"t{n_t - 1}_l{L}.bin"][n_days - (n_t - 1) * TILE_DAYS:] == Z_NAN)
                 for L in range(n_l))
    check("era-end: tile rows past the last era day are all Z_NAN (no data beyond end)", pad_ok)
    # ghost/rf are day-indexed arrays in the manifest: same length as the clamped calendar
    check("era-end: ghost and rf series stop at era end",
          len(manifest["ghost"]["z"]) == n_days and len(manifest["rf"]) == n_days)


def main():
    syms, ipo_pre, ipo_post = pick_symbols()
    target = syms[5]  # an arbitrary full-span lane (not SPY, not an IPO lane)
    print(f"slice: {len(syms)} real symbols, era {ERA_START}..{ERA_END}, step day D={D_DATE}")
    print(f"step target: {target} (x{STEP} from D); IPO lanes: {ipo_pre} (born<D), {ipo_post} (born>D)\n")

    runs = {
        "baseline": None,
        "stock": ("stock", target),
        "spy": ("spy",),
        "rf": ("rf",),
    }
    arts = {}
    for tag, perturb in runs.items():
        ddir = TMP / f"data_{tag}"
        make_data_dir(ddir, syms, perturb)
        arts[tag] = run_export(ddir, TMP / f"tiles_{tag}")

    base_m, base_t = arts["baseline"]
    d_idx = day_split(base_m)
    print(f"era calendar: {base_m['nDays']} days, D = day index {d_idx} ({base_m['dates'][d_idx]})\n")
    assert 0 < d_idx < base_m["nDays"] - 5, "D must be strictly inside the era"

    check("pipeline: metrics artifacts", "metrics" not in base_m,
          "no metrics.py in pipeline yet; manifest has no metrics key (nothing to leak)")

    born = {l["sym"]: l["born"] for l in base_m["lanes"]}
    check("fixture: IPO lanes exercise the datum-offset path",
          0 < born[ipo_pre] < d_idx <= born[ipo_post],
          f"{ipo_pre} born day {born[ipo_pre]} (<D), {ipo_post} born day {born[ipo_post]} (>=D)")

    # --- run 1: step in one stock's prices --------------------------------------
    m, t = arts["stock"]
    compare_tiles("stock-step", base_t, t, d_idx, expect_late_diff_lane=target)
    compare_series("stock-step: manifest ghost", base_m["ghost"]["z"], m["ghost"]["z"], d_idx,
                   expect_late_diff=False)
    compare_series("stock-step: manifest rf", base_m["rf"], m["rf"], d_idx, expect_late_diff=False)
    compare_lane_meta("stock-step", base_m, m, d_idx)

    # --- run 2: step in SPY (ghost channel) -------------------------------------
    m, t = arts["spy"]
    compare_series("spy-step: manifest ghost", base_m["ghost"]["z"], m["ghost"]["z"], d_idx,
                   expect_late_diff=True)
    compare_tiles("spy-step", base_t, t, d_idx)  # SPY is not a lane: tiles fully unaffected
    compare_series("spy-step: manifest rf", base_m["rf"], m["rf"], d_idx, expect_late_diff=False)

    # --- run 3: step in r_f ------------------------------------------------------
    m, t = arts["rf"]
    compare_series("rf-step: manifest rf", base_m["rf"], m["rf"], d_idx, expect_late_diff=True)
    compare_tiles("rf-step", base_t, t, d_idx)
    compare_series("rf-step: manifest ghost", base_m["ghost"]["z"], m["ghost"]["z"], d_idx,
                   expect_late_diff=False)

    # --- era-end clamp ------------------------------------------------------------
    check_era_end(base_m, base_t, TMP / "tiles_baseline")

    n_fail = sum(1 for _, p, _ in results if not p)
    print(f"\n{len(results)} artifact checks, {n_fail} failed")
    print("GATE " + json.dumps({"causality": "pass" if n_fail == 0 else "fail",
                                "artifacts_checked": len(results)}))
    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
