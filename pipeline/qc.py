#!/usr/bin/env python
"""qc.py — PLAN §6.3 quality control + era universe table (CONTRACTS §1).

Full-range QC per phase0 findings (analysis/phase0_report.md):
  * zero/negative closes: replaced with last positive close, logged (#-clipped).
  * TICKER-REUSE SEVERING (finding #2): a gap of > GAP_SEVER_TD trading days between
    consecutive bars means a later user of the recycled symbol; the series is severed
    at the gap. Delisted symbols keep the FIRST segment (the original company —
    the resurrection is the later user); live symbols keep the LAST segment (the
    live list refers to the current user; the prior user is archived as *_old / SYM1).
  * STALE-PIN TRIM (findings #2/#5): trailing run of zero-volume bars with an
    unchanged close on a delisted series is a halt/registration artifact, not
    trading; trimmed so the termination date is the last real print.
  * DISCONTINUITY BREAKS (PLAN §5): overnight |log return| > BREAK_ABS_LOGRET is
    flagged and classified:
      halt_reprice — preceded by >= HALT_RUN_MIN zero-volume flat closes (finding #5:
                     a halted name re-pricing on resumption is a real event);
      stale_close  — prior bar had zero volume (gap vs a stale quote, not a trade);
      terminal     — within the last TERM_WINDOW_TD bars of a dead series (collapse /
                     takeover repricing; phase0 verified these match real events);
      unexplained  — none of the above. Isolated unexplained breaks are kept (real
                     single-day crashes beyond -45%/+82% exist, esp. biotech); a
                     symbol with > MAX_BREAKS unexplained breaks is junk data => dropped.
    (The symbol-change/fundamentals APIs are 403 on this plan — finding #4 — so
    classification is price/volume-signature only.)
  * termination classification (PLAN §6.3): alive if last print within
    ALIVE_GRACE_DAYS of era end; else terminal 30-trading-day return < -80% =>
    bankruptcy, else acquisition.
  * share-class dedup: same normalized company name AND overlapping date spans =>
    keep the class with higher trailing 63d median dollar volume. Non-overlapping
    same-name symbols are temporal recycling (old GM / new GM), both kept.
  * per-year coverage counts + equal-weight mean annual return vs SPY canary:
    a year whose EW mean lane return differs from SPY by > CANARY_PP is flagged
    (survivorship / QC canary; small-cap EW vs cap-weighted SPY divergence is the
    expected benign explanation and is cross-checked in the report).

Writes data/universe.parquet (CONTRACTS §1), data/qc_report.json, and for
--era full also analysis/qc_full_report.md.
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

BREAK_ABS_LOGRET = 0.60   # PLAN §5: overnight |log return| > 60% => discontinuity flag
MAX_BREAKS = 3            # >3 unexplained breaks => junk series, drop symbol
ALIVE_GRACE_DAYS = 7      # last print within 7 calendar days of era end => still listed (weekend+holiday)
TERM_WINDOW_TD = 30       # PLAN §6.3: terminal return measured over final 30 trading days
BANKRUPT_RET = -0.80      # PLAN §6.3: terminal 30d return < -80% => bankruptcy, else acquisition
DV_WINDOW_TD = 63         # PLAN §0: universe ranking = trailing 63d median dollar volume
MIN_WINDOW_ROWS = 2       # need >= 2 closes inside the era window to define even one return
GAP_SEVER_TD = 30         # phase0 finding #2: > 30 trading days of no data then resurrection => ticker reuse
HALT_RUN_MIN = 3          # phase0 finding #5: >= 3 zero-volume flat closes = halt, not returns
MIN_IPO_YEAR_BARS = 5     # partial first-year return needs >= 5 bars to mean anything
CANARY_PP = 0.25          # task gate: |EW mean - SPY| > 25pp => flag year
ARCHIVE_RE = re.compile(r"^[A-Z]{1,5}(?:_old(?:old)*\d?|\d)$")  # recycled-ticker archives (build_universe.py)

# Era-specific numeric gates. recent2y: usable count (original Phase-1 sanity gate).
# full: task gate — year-2000 lanes >= 3000 and every year 2000..present >= 2500.
ERA_GATES = {"recent2y": {"min_usable": 6000}, "full": {"y2000": 3000, "min_year": 2500}}

# Tokens stripped when normalizing company names for share-class dedup.
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
    toks = [t for t in s.split() if t]
    while toks and len(toks[-1]) == 1:  # trailing class letters: "ALPHABET A" -> "ALPHABET"
        toks.pop()
    return " ".join(toks)


def trading_gaps(dates: np.ndarray, spy_dates: np.ndarray) -> np.ndarray:
    """Approx trading-day gap between consecutive bars via position on the SPY calendar.
    Dates before the SPY calendar start all map to index 0 (gap 0) — irrelevant here:
    every era window starts >= 1999, well inside SPY (1993-)."""
    idx = np.searchsorted(spy_dates, dates)
    return np.diff(idx)


def yearly_returns(dates: np.ndarray, adj: np.ndarray, year_min: int):
    """{year: simple return} per calendar year. Reference = last close of the previous
    present year, else (IPO year) the first close of the year if >= MIN_IPO_YEAR_BARS bars."""
    years = np.array([int(d[:4]) for d in dates])
    out = {}
    prev_year, prev_last = None, None
    for y in np.unique(years):
        m = years == y
        a = adj[m]
        if int(y) >= year_min:
            if prev_year == y - 1 and prev_last and prev_last > 0:
                out[int(y)] = float(a[-1] / prev_last - 1.0)
            elif len(a) >= MIN_IPO_YEAR_BARS and a[0] > 0:
                out[int(y)] = float(a[-1] / a[0] - 1.0)
        prev_year, prev_last = y, float(a[-1])
    return out, set(int(v) for v in np.unique(years))


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
    spy = pd.read_parquet(spy_pq, columns=["date", "adjusted_close"])
    spy_dates = spy["date"]
    burnin_start, start, end = resolve_era(eras[args.era], spy_dates)
    end_ts = pd.Timestamp(end)
    start_year = int(start[:4])
    spy_cal = spy_dates.to_numpy()

    cand_path = os.path.join(args.data_dir, "universe_src", f"candidates_{args.era}.json")
    candidates = json.load(open(cand_path))
    parquet_dir = os.path.join(args.data_dir, "parquet")

    rows, clip_log, break_log = [], {}, {}
    sever_log, pin_log = [], {}
    drops = {"no_data": [], "insufficient_window_data": [], "delisted_outside_window": [],
             "qc_breaks": [], "dup_class": []}
    sym_years, sym_yret = {}, {}
    downloaded = 0

    for n_done, cand in enumerate(candidates):
        if n_done and n_done % 2000 == 0:
            print(f"  qc {n_done}/{len(candidates)} ...", flush=True)
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

        # Zero/negative price clipping: replace with last positive close, log.
        adj = df["adjusted_close"].to_numpy(copy=True)
        bad = ~(adj > 0) | ~np.isfinite(adj)
        if bad.any():
            clip_log[sym] = int(bad.sum())
            adj = pd.Series(adj).mask(bad).ffill().bfill().to_numpy()
            df["adjusted_close"] = adj
        if not np.isfinite(adj).all() or not (adj > 0).all():
            drops["no_data"].append(sym)  # never a positive price: unusable
            continue

        is_listed_now = not cand.get("is_delisted")

        # Ticker-reuse severing (finding #2): split at > GAP_SEVER_TD trading-day gaps.
        dates_full = df["date"].to_numpy()
        if len(df) > 1:
            gaps = trading_gaps(dates_full, spy_cal)
            cuts = np.flatnonzero(gaps > GAP_SEVER_TD)
            if len(cuts):
                bounds = [0] + (cuts + 1).tolist() + [len(df)]
                segs = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
                lo, hi = segs[-1] if is_listed_now else segs[0]
                sever_log.append({
                    "symbol": sym, "kept": "last" if is_listed_now else "first",
                    "kept_span": [str(dates_full[lo]), str(dates_full[hi - 1])],
                    "removed_bars": int(len(df) - (hi - lo)),
                    "gaps": [{"from": str(dates_full[c]), "to": str(dates_full[c + 1]),
                              "trading_days": int(gaps[c])} for c in cuts[:8]],
                })
                df = df.iloc[lo:hi]

        # Stale-pin trim (findings #2/#5): trailing zero-volume flat closes on dead series.
        if not is_listed_now and len(df) > 1:
            a = df["adjusted_close"].to_numpy()
            v = df["volume"].to_numpy()
            k = len(df) - 1
            while k > 0 and v[k] == 0 and a[k] == a[k - 1]:
                k -= 1
            if k < len(df) - 1:
                pin_log[sym] = int(len(df) - 1 - k)
                df = df.iloc[:k + 1]

        first_date, last_date = df["date"].iloc[0], df["date"].iloc[-1]

        # Delisted-list candidates: era membership = (severed) history ends inside the window.
        if cand.get("is_delisted") and not (burnin_start <= last_date <= end):
            drops["delisted_outside_window"].append(sym)
            continue

        win = df[(df["date"] >= burnin_start) & (df["date"] <= end)]
        if len(win) < MIN_WINDOW_ROWS:
            drops["insufficient_window_data"].append(sym)
            continue

        # Termination classification (PLAN §6.3) — on the severed/trimmed series.
        if (end_ts - pd.Timestamp(last_date)).days <= ALIVE_GRACE_DAYS:
            termination = "alive"
        else:
            a = df["adjusted_close"].to_numpy()
            base = a[-(TERM_WINDOW_TD + 1)] if len(a) > TERM_WINDOW_TD else a[0]
            term_ret = a[-1] / base - 1.0 if base > 0 else 0.0
            termination = "bankruptcy" if term_ret < BANKRUPT_RET else "acquisition"

        # Discontinuity breaks inside the era window, classified (module docstring).
        wadj = win["adjusted_close"].to_numpy()
        wvol = win["volume"].to_numpy()
        logret = np.diff(np.log(wadj))
        brk = np.flatnonzero(np.abs(logret) > BREAK_ABS_LOGRET)
        if len(brk):
            n_win = len(win)
            events, n_unexplained = [], 0
            for i in brk:
                run = 0
                j = i
                while j > 0 and wvol[j] == 0 and wadj[j] == wadj[j - 1]:
                    run += 1
                    j -= 1
                if run >= HALT_RUN_MIN:
                    cls = "halt_reprice"
                elif wvol[i] == 0:
                    cls = "stale_close"
                elif termination != "alive" and i + 1 >= n_win - TERM_WINDOW_TD:
                    cls = "terminal"
                else:
                    cls = "unexplained"
                    n_unexplained += 1
                events.append({"date": str(win["date"].iloc[i + 1]),
                               "logret": round(float(logret[i]), 4), "class": cls})
            break_log[sym] = events
            if n_unexplained > MAX_BREAKS:
                drops["qc_breaks"].append(sym)
                continue

        # Trailing 63d median dollar volume at the symbol's last in-window date (causal).
        tail = win.tail(DV_WINDOW_TD)
        dv = float(np.nanmedian((tail["close"] * tail["volume"]).to_numpy(dtype="float64")))
        if not math.isfinite(dv):
            dv = 0.0

        yret, yrs = yearly_returns(win["date"].to_numpy(), win["adjusted_close"].to_numpy(), start_year)
        sym_years[sym] = yrs
        sym_yret[sym] = yret

        rows.append({"symbol": sym, "name": cand["name"], "exchange": cand["exchange"],
                     "type": cand["type"],
                     "is_delisted": bool(cand.get("is_delisted")) or termination != "alive",
                     "first_date": first_date, "last_date": last_date,
                     "median_dollar_vol_63d_last": dv, "termination": termination})

    # Share-class dedup: same normalized name AND overlapping spans => keep the more
    # liquid class. Non-overlapping namesakes are temporal ticker recycling: both kept.
    uni = pd.DataFrame(rows)
    dedup_pairs = []
    if not uni.empty:
        uni["_norm"] = uni["name"].map(normalize_name)
        drop_idx = set()
        for norm, grp in uni.groupby("_norm", sort=False):
            if norm == "" or len(grp) == 1:
                continue
            grp = grp.sort_values("median_dollar_vol_63d_last", ascending=False)
            kept = []
            for idx in grp.index:
                f, l = uni.at[idx, "first_date"], uni.at[idx, "last_date"]
                clash = next((k for k in kept
                              if not (l < uni.at[k, "first_date"] or f > uni.at[k, "last_date"])), None)
                if clash is None:
                    kept.append(idx)
                else:
                    drop_idx.add(idx)
                    dedup_pairs.append({"name": norm, "kept": uni.at[clash, "symbol"],
                                        "dropped": uni.at[idx, "symbol"]})
        if drop_idx:
            drops["dup_class"] = sorted(uni.loc[sorted(drop_idx), "symbol"])
        uni = uni.drop(index=sorted(drop_idx)).drop(columns="_norm").reset_index(drop=True)

    out_pq = os.path.join(args.data_dir, "universe.parquet")
    tmp = out_pq + ".tmp"
    uni.to_parquet(tmp, index=False)
    os.replace(tmp, out_pq)

    # ---- per-year coverage + EW-vs-SPY canary (usable lanes only) -------------------
    usable_syms = set(uni["symbol"]) if not uni.empty else set()
    end_year = int(end[:4])
    years = list(range(start_year, end_year + 1))
    year_counts = {y: 0 for y in years}
    year_rets = {y: [] for y in years}
    for sym in usable_syms:
        for y in sym_years.get(sym, ()):
            if start_year <= y <= end_year:
                year_counts[y] += 1
        for y, r in sym_yret.get(sym, {}).items():
            if start_year <= y <= end_year:
                year_rets[y].append(r)

    spy_win = spy[(spy["date"] >= burnin_start) & (spy["date"] <= end)]
    spy_yret, _ = yearly_returns(spy_win["date"].to_numpy(),
                                 spy_win["adjusted_close"].to_numpy(), start_year)
    canary = []
    for y in years:
        rs = np.array(year_rets[y], dtype="float64")
        if not len(rs) or y not in spy_yret:
            continue
        ew = float(rs.mean())
        med = float(np.median(rs))
        win1 = float(np.clip(rs, np.quantile(rs, 0.01), np.quantile(rs, 0.99)).mean())
        row = {"year": y, "n": int(len(rs)), "ew_mean": round(ew, 4),
               "ew_mean_wins1pct": round(win1, 4), "median": round(med, 4),
               "spy": round(spy_yret[y], 4), "diff_pp": round((ew - spy_yret[y]) * 100, 1),
               "flag": abs(ew - spy_yret[y]) > CANARY_PP}
        canary.append(row)
    flagged_years = [c["year"] for c in canary if c["flag"]]

    decades = {}
    for label, lo, hi in (("2000s", 2000, 2009), ("2010s", 2010, 2019), ("2020s", 2020, end_year)):
        ys = [y for y in years if lo <= y <= hi]
        if ys:
            cs = [year_counts[y] for y in ys]
            decades[label] = {"years": [lo, ys[-1]], "min_lanes": min(cs), "max_lanes": max(cs),
                              "mean_lanes": round(float(np.mean(cs)), 1)}

    usable = len(uni)
    n_archive = int(sum(1 for s in usable_syms if ARCHIVE_RE.match(s)))
    report = {
        "era": args.era, "window": {"burnin_start": burnin_start, "start": start, "end": end},
        "candidates": len(candidates), "downloaded": downloaded, "usable": usable,
        "archive_lanes_usable": n_archive,
        "drops": {k: {"count": len(v), "symbols": sorted(v)} for k, v in drops.items()},
        "clipped_nonpositive_prices": clip_log,
        "reuse_severed": sever_log,
        "stale_pin_trimmed": pin_log,
        "breaks_flagged": {k: v for k, v in sorted(break_log.items())},
        "n_break_symbols": len(break_log),
        "dedup_share_classes": dedup_pairs,
        "termination_counts": uni["termination"].value_counts().to_dict() if usable else {},
        "year_coverage": {str(y): year_counts[y] for y in years},
        "decade_coverage": decades,
        "canary_ew_vs_spy": canary,
        "canary_flagged_years": flagged_years,
    }
    rpt_path = os.path.join(args.data_dir, "qc_report.json")
    json.dump(report, open(rpt_path, "w"), indent=1)
    print(f"wrote {out_pq} ({usable} rows), {rpt_path}")

    if args.era == "full":
        g = ERA_GATES["full"]
        y2000 = year_counts.get(2000, 0)
        min_year = min(year_counts[y] for y in years)
        gate = {"y2000_lanes": y2000, "min_year_lanes": min_year,
                "canary_years": flagged_years, "old_variants_added": n_archive}
        ok = y2000 >= g["y2000"] and min_year >= g["min_year"]
    else:
        gate = {"era": args.era, "candidates": len(candidates), "downloaded": downloaded,
                "usable": usable, "dropped": downloaded - usable}
        ok = usable >= ERA_GATES.get(args.era, {}).get("min_usable", 0)
    print("GATE " + json.dumps(gate))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
