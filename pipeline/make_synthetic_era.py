#!/usr/bin/env python
"""Synthetic 4-lane fixture era 'synthetic' for terrain tests (PLAN section 6.3).

Lanes (400 trading days, padded to 128):
  SYN0  steady uptrend, +20%/yr -- the "held winner" path
  SYN1  bankruptcy: drifts down, then -97% over the last 30 days, dies day 300 (crevasse)
  SYN2  acquisition: steady, +25% jump, dies day 350 (ledge/kicker)
  SYN3  IPO at day 100: tests datum offset c_i continuity (no canyon at listing)

Also writes plausible ghost (SPY) + flat 3% r_f, builds the real tiles via
export_tiles.build_era, and saves the pre-quantization float z as truth.npz so
analysis/terrain_tests.py can round-trip the int16 encoding.

Deterministic: fixed RNG seed. Run: .venv/bin/python pipeline/make_synthetic_era.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_tiles

SEED = 20260610          # build date of the fixture; any fixed seed works, this one is documented
N_DAYS = 400             # ~1.6 trading years: enough room for death-at-300/350 plus aftermath void
TPY = 252                # trading days per year (annualization)
NOISE = 0.005            # ~8%/yr daily vol: visible texture without drowning the scripted events
BK_DAY = 300             # bankruptcy lane's last trading day (task spec)
BK_CRASH_DAYS = 30       # the -97% terminal collapse is spread over the final 30 days (task spec)
BK_FINAL_RET = 0.03      # terminal 30d price ratio: -97% < -80% rule => 'bankruptcy' (CONTRACTS 1)
ACQ_DAY = 350            # acquisition lane's last trading day (task spec)
ACQ_JUMP = 1.25          # +25% one-day takeover premium => terminal 30d return > -80% => 'acquisition'
IPO_DAY = 100            # SYN3 lists at day 100 to exercise the c_i datum offset (PLAN 1)
RF_ANNUAL = 0.03         # flat 3% risk-free (task spec)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data" / "synthetic_src"
OUT_ROOT = ROOT / "game" / "public" / "tiles"


def _price_df(dates, log_rets, p0=100.0):
    """Build a CONTRACTS-section-1 parquet frame from daily log returns (first day = p0)."""
    z = np.concatenate([[0.0], np.cumsum(log_rets)])
    px = p0 * np.exp(z)
    return pd.DataFrame({
        "date": [d.strftime("%Y-%m-%d") for d in dates],
        "open": px, "high": px, "low": px, "close": px,  # OHLC = close: fixture has no intraday data
        "adjusted_close": px,
        "volume": np.full(len(dates), 1_000_000, dtype=np.int64),  # constant: rank is irrelevant for 4 lanes
    })


def make_fixture():
    rng = np.random.default_rng(SEED)
    dates = pd.bdate_range("2010-01-04", periods=N_DAYS)  # arbitrary modern start, weekday calendar

    # SYN0: steady +20%/yr
    r0 = np.log(1.20) / TPY + NOISE * rng.standard_normal(N_DAYS - 1)

    # SYN1: -15%/yr drift, then -97% over days (BK_DAY-BK_CRASH_DAYS, BK_DAY]; dead after BK_DAY
    n1 = BK_DAY + 1
    r1 = np.log(0.85) / TPY + NOISE * rng.standard_normal(n1 - 1)
    crash = np.log(BK_FINAL_RET) / BK_CRASH_DAYS  # exact -97% over the final 30 days
    r1[-BK_CRASH_DAYS:] = crash + 0.1 * NOISE * rng.standard_normal(BK_CRASH_DAYS)
    r1[-BK_CRASH_DAYS:] += (np.log(BK_FINAL_RET) - r1[-BK_CRASH_DAYS:].sum()) / BK_CRASH_DAYS  # pin total exactly

    # SYN2: steady +10%/yr; +25% jump 5 days before death (a ledge you can launch from); dead after ACQ_DAY
    n2 = ACQ_DAY + 1
    r2 = np.log(1.10) / TPY + NOISE * rng.standard_normal(n2 - 1)
    r2[n2 - 7] = np.log(ACQ_JUMP)  # jump at day 345 (= ACQ_DAY-5): index n2-7 is the return INTO day 345
    r2[n2 - 6:] = 0.0              # deal price pins the stock flat for its last 5 sessions

    # SYN3: IPO at day 100, +12%/yr drift
    n3 = N_DAYS - IPO_DAY
    r3 = np.log(1.12) / TPY + NOISE * rng.standard_normal(n3 - 1)

    # SPY ghost: +8%/yr with index-like vol (~13%/yr)
    rg = np.log(1.08) / TPY + 0.008 * rng.standard_normal(N_DAYS - 1)

    pq = DATA_DIR / "parquet"
    pq.mkdir(parents=True, exist_ok=True)
    frames = {
        "SYN0": _price_df(dates, r0),
        "SYN1": _price_df(dates[:n1], r1),
        "SYN2": _price_df(dates[:n2], r2),
        "SYN3": _price_df(dates[IPO_DAY:], r3, p0=40.0),  # IPO price unlike neighbors: c_i must repair the datum
        "SPY": _price_df(dates, rg, p0=110.0),
    }
    for sym, df in frames.items():
        df.to_parquet(pq / f"{sym}.parquet", index=False)

    uni = pd.DataFrame([
        {"symbol": "SYN0", "name": "Steady Uptrend Corp", "exchange": "SYN", "type": "Common Stock",
         "is_delisted": False, "first_date": frames["SYN0"]["date"].iloc[0],
         "last_date": frames["SYN0"]["date"].iloc[-1], "median_dollar_vol_63d_last": 1e8,
         "termination": "alive"},
        {"symbol": "SYN1", "name": "Bankrupt Inc", "exchange": "SYN", "type": "Common Stock",
         "is_delisted": True, "first_date": frames["SYN1"]["date"].iloc[0],
         "last_date": frames["SYN1"]["date"].iloc[-1], "median_dollar_vol_63d_last": 1e7,
         "termination": "bankruptcy"},  # terminal 30d return = -97% < -80% (CONTRACTS 1 rule)
        {"symbol": "SYN2", "name": "Acquired Co", "exchange": "SYN", "type": "Common Stock",
         "is_delisted": True, "first_date": frames["SYN2"]["date"].iloc[0],
         "last_date": frames["SYN2"]["date"].iloc[-1], "median_dollar_vol_63d_last": 5e7,
         "termination": "acquisition"},  # terminal 30d return ~ +25% (CONTRACTS 1 rule)
        {"symbol": "SYN3", "name": "Fresh IPO Ltd", "exchange": "SYN", "type": "Common Stock",
         "is_delisted": False, "first_date": frames["SYN3"]["date"].iloc[0],
         "last_date": frames["SYN3"]["date"].iloc[-1], "median_dollar_vol_63d_last": 2e7,
         "termination": "alive"},
    ])
    uni.to_parquet(DATA_DIR / "universe.parquet", index=False)

    pd.DataFrame({
        "date": [d.strftime("%Y-%m-%d") for d in dates],
        "rf_annual": np.full(N_DAYS, RF_ANNUAL),
    }).to_parquet(DATA_DIR / "rf.parquet", index=False)

    order = ["SYN0", "SYN1", "SYN2", "SYN3"]
    (DATA_DIR / "synthetic_order.json").write_text(json.dumps(order))

    era = {
        "name": "synthetic",
        "start": dates[0].strftime("%Y-%m-%d"),
        "end": dates[-1].strftime("%Y-%m-%d"),
        "burnin_start": dates[0].strftime("%Y-%m-%d"),
        "top_n": 4,
    }
    # also drop an eras.json into the fixture data dir so the CLIs work on it verbatim
    (DATA_DIR / "eras.json").write_text(json.dumps({"synthetic": era}, indent=2))

    Z, manifest = export_tiles.build_era(era, order, DATA_DIR, OUT_ROOT)

    born = np.array([m["born"] for m in manifest["lanes"][:4]])
    dead = np.array([m["dead"] for m in manifest["lanes"][:4]])
    np.savez(OUT_ROOT / "synthetic" / "truth.npz", z=Z, born=born, dead=dead,
             c=np.array([m["c"] for m in manifest["lanes"][:4]]))

    ok = (manifest["nDays"] == N_DAYS and manifest["nLanes"] == 128
          and dead.tolist() == [-1, BK_DAY, ACQ_DAY, -1] and born.tolist() == [0, 0, 0, IPO_DAY])
    print(f"GATE {json.dumps({'ok': bool(ok), 'era': 'synthetic', 'nDays': manifest['nDays'], 'nLanes': manifest['nLanes'], 'born': born.tolist(), 'dead': dead.tolist()})}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(make_fixture())
