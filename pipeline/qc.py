#!/usr/bin/env python
"""qc.py — PLAN §6.3 quality control + era universe table (CONTRACTS §1).

Per symbol (era window = burn-in start .. era end):
  * zero/negative closes: clipped to last positive close, logged.
  * overnight |log return| > 60% (BREAK_ABS_LOGRET): flagged as a discontinuity
    break; v1 policy = log to data/qc_report.json and DROP symbols with more than
    MAX_BREAKS unexplained breaks (no per-event verification yet).
  * termination classification: alive if last date within ALIVE_GRACE_DAYS calendar
    days of era end; else terminal 30-trading-day return < -80% => bankruptcy,
    else acquisition (PLAN §6.3).
  * delisted-list candidates kept only if their history ends inside the era window
    (the symbol list has no dates; decided here, post-download).
  * share-class dedup: among symbols whose normalized company name matches, keep
    the class with the higher trailing 63d median dollar volume (e.g. keep GOOGL,
    drop GOOG); logged.

Writes data/universe.parquet:
  symbol, name, exchange, type, is_delisted, first_date, last_date,
  median_dollar_vol_63d_last, termination
Prints machine-readable `GATE {json}` last; exits nonzero on gate failure.
"""
import argparse
import json
import math
import os
import re
import sys

import numpy as np
import pandas as pd

BREAK_ABS_LOGRET = 0.60   # PLAN §6.3: overnight |log return| > 60% => discontinuity flag
MAX_BREAKS = 3            # v1 policy (task spec): >3 unexplained breaks => drop symbol
ALIVE_GRACE_DAYS = 7      # last print within 7 calendar days of era end => still listed (covers weekend+holiday)
TERM_WINDOW_TD = 30       # PLAN §6.3: terminal return measured over final 30 trading days
BANKRUPT_RET = -0.80      # PLAN §6.3: terminal 30d return < -80% => bankruptcy, else acquisition
DV_WINDOW_TD = 63         # PLAN §0: universe ranking = trailing 63d median dollar volume
MIN_WINDOW_ROWS = 2       # need >= 2 closes inside the era window to define even one return
MIN_USABLE_GATE = 6000    # task sanity gate: recent2y should yield >6000 usable symbols

# Tokens stripped when normalizing company names for share-class dedup: legal-form
# suffixes plus explicit class designators (CLASS A, CL B, SERIES C, ...).
NAME_STRIP_RE = re.compile(
    r"\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LP|LLC|SA|AG|NV|"
    r"HOLDING|HOLDINGS|GROUP|THE|COMMON|STOCK|SHARES|ORDINARY|ADR|ADS|"
    r"CLASS|CL|SERIES)\b|[^A-Z0-9 ]"
)


def resolve_era(era_cfg: dict, spy_dates: pd.Series):
    """Return (burnin_start, start, end) as ISO strings on the SPY trading calendar."""
    end = era_cfg.get("end") or spy_dates.iloc[-1]
    end = min(end, spy_dates.iloc[-1])
    start = era_cfg["start"]
    if "burnin_start" in era_cfg:
        burnin_start = era_cfg["burnin_start"]
    else:
        prior = spy_dates[spy_dates < start]
        nb = era_cfg.get("burnin_days", 0)
        burnin_start = prior.iloc[-nb] if nb and len(prior) >= nb else (prior.iloc[0] if len(prior) else start)
    return burnin_start, start, end


def normalize_name(name: str) -> str:
    s = NAME_STRIP_RE.sub(" ", (name or "").upper())
    # Drop single trailing letters left over from class designators ("ALPHABET A" -> "ALPHABET").
    toks = [t for t in s.split() if t]
    while toks and len(toks[-1]) == 1:
        toks.pop()
    return " ".join(toks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--era", default="recent2y")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "eras.json"))
    ap.add_argument("--out", default="game/public/tiles/", help="unused here; uniform CLI per CONTRACTS §5")
    args = ap.parse_args()

    eras = json.load(open(args.config))
    if args.era not in eras:
        sys.exit(f"unknown era {args.era!r}")
    spy_pq = os.path.join(args.data_dir, "parquet", "SPY.parquet")
    if not os.path.exists(spy_pq):
        sys.exit("missing data/parquet/SPY.parquet; run download_prices.py / rf_spy.py first")
    spy_dates = pd.read_parquet(spy_pq, columns=["date"])["date"]
    burnin_start, start, end = resolve_era(eras[args.era], spy_dates)
    end_ts = pd.Timestamp(end)

    cand_path = os.path.join(args.data_dir, "universe_src", f"candidates_{args.era}.json")
    candidates = json.load(open(cand_path))
    parquet_dir = os.path.join(args.data_dir, "parquet")

    rows, clip_log, break_log = [], {}, {}
    drops = {"no_data": [], "insufficient_window_data": [], "delisted_outside_window": [],
             "qc_breaks": [], "dup_class": []}
    downloaded = 0

    for cand in candidates:
        sym = cand["symbol"]
        pq = os.path.join(parquet_dir, f"{sym}.parquet")
        if not os.path.exists(pq):
            drops["no_data"].append(sym)
            continue
        downloaded += 1
        df = pd.read_parquet(pq, columns=["date", "close", "adjusted_close", "volume"])
        df = df[df["date"] <= end]
        if df.empty:
            drops["no_data"].append(sym)
            continue
        first_date, last_date = df["date"].iloc[0], df["date"].iloc[-1]

        # Zero/negative price clipping: replace with last positive close, log.
        adj = df["adjusted_close"].to_numpy(copy=True)
        bad = ~(adj > 0) | ~np.isfinite(adj)
        if bad.any():
            clip_log[sym] = int(bad.sum())
            s = pd.Series(adj).mask(bad).ffill().bfill()
            adj = s.to_numpy()
            df["adjusted_close"] = adj
        if not np.isfinite(adj).all() or not (adj > 0).all():
            drops["no_data"].append(sym)  # never a positive price: unusable
            continue

        # Delisted-list candidates: era membership = history ends inside the window.
        if cand.get("is_delisted") and not (burnin_start <= last_date <= end):
            drops["delisted_outside_window"].append(sym)
            continue

        win = df[(df["date"] >= burnin_start) & (df["date"] <= end)]
        if len(win) < MIN_WINDOW_ROWS:
            drops["insufficient_window_data"].append(sym)
            continue

        # Discontinuity breaks inside the era window (incl. burn-in).
        wadj = win["adjusted_close"].to_numpy()
        logret = np.diff(np.log(wadj))
        brk = np.abs(logret) > BREAK_ABS_LOGRET
        if brk.any():
            dates = win["date"].to_numpy()
            break_log[sym] = [{"date": str(dates[i + 1]), "logret": round(float(logret[i]), 4)}
                              for i in np.flatnonzero(brk)]
            if int(brk.sum()) > MAX_BREAKS:
                drops["qc_breaks"].append(sym)
                continue

        # Termination classification (PLAN §6.3).
        if (end_ts - pd.Timestamp(last_date)).days <= ALIVE_GRACE_DAYS:
            termination = "alive"
        else:
            a = df["adjusted_close"].to_numpy()
            base = a[-(TERM_WINDOW_TD + 1)] if len(a) > TERM_WINDOW_TD else a[0]
            term_ret = a[-1] / base - 1.0 if base > 0 else 0.0
            termination = "bankruptcy" if term_ret < BANKRUPT_RET else "acquisition"

        # Trailing 63d median dollar volume at the symbol's last in-window date (causal).
        tail = win.tail(DV_WINDOW_TD)
        dv = float(np.nanmedian((tail["close"] * tail["volume"]).to_numpy(dtype="float64")))
        if not math.isfinite(dv):
            dv = 0.0

        rows.append({"symbol": sym, "name": cand["name"], "exchange": cand["exchange"],
                     "type": cand["type"],
                     "is_delisted": bool(cand.get("is_delisted")) or termination != "alive",
                     "first_date": first_date, "last_date": last_date,
                     "median_dollar_vol_63d_last": dv, "termination": termination})

    # Share-class dedup: same normalized name => keep the more liquid class.
    uni = pd.DataFrame(rows)
    dedup_pairs = []
    if not uni.empty:
        uni["_norm"] = uni["name"].map(normalize_name)
        keep_idx = []
        for norm, grp in uni.groupby("_norm", sort=False):
            if norm == "" or len(grp) == 1:
                keep_idx.extend(grp.index)
                continue
            grp = grp.sort_values("median_dollar_vol_63d_last", ascending=False)
            keep_idx.append(grp.index[0])
            losers = grp["symbol"].iloc[1:].tolist()
            drops["dup_class"].extend(losers)
            dedup_pairs.append({"name": norm, "kept": grp["symbol"].iloc[0], "dropped": losers})
        uni = uni.loc[sorted(keep_idx)].drop(columns="_norm").reset_index(drop=True)

    out_pq = os.path.join(args.data_dir, "universe.parquet")
    tmp = out_pq + ".tmp"
    uni.to_parquet(tmp, index=False)
    os.replace(tmp, out_pq)

    usable = len(uni)
    report = {
        "era": args.era, "window": {"burnin_start": burnin_start, "start": start, "end": end},
        "candidates": len(candidates), "downloaded": downloaded, "usable": usable,
        "drops": {k: {"count": len(v), "symbols": sorted(v)} for k, v in drops.items()},
        "clipped_nonpositive_prices": clip_log,
        "breaks_flagged": {k: v for k, v in sorted(break_log.items())},
        "n_break_symbols": len(break_log),
        "dedup_share_classes": dedup_pairs,
        "termination_counts": uni["termination"].value_counts().to_dict() if usable else {},
    }
    rpt_path = os.path.join(args.data_dir, "qc_report.json")
    json.dump(report, open(rpt_path, "w"), indent=1)
    print(f"wrote {out_pq} ({usable} rows), {rpt_path}")

    dropped = downloaded - usable
    gate = {"era": args.era, "candidates": len(candidates), "downloaded": downloaded,
            "usable": usable, "dropped": dropped}
    print("GATE " + json.dumps(gate))
    sys.exit(0 if usable >= MIN_USABLE_GATE else 1)


if __name__ == "__main__":
    main()
