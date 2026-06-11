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
  * SPLICE SEVERING: an unexplained one-day |move| beyond what a continuous company
    can print (> +395% / < -92%; see SPLICE_*_LOGRET) is a data splice — the series
    is severed there exactly like a reuse gap (live keeps last segment, dead first).
  * EXCHANGE TEST SYMBOLS (ZAZZT family, "LISTED TEST STOCK" names) are dropped:
    synthetic prices. Real companies named "* Test Systems" (AEHR, EGLT1) are kept.
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
# Splice severing: a one-day move beyond these is not a return a continuous company can
# print — it is a data splice (reverse-merger relist, unadjusted reverse split, recycled
# ticker with no calendar gap). Largest real one-day gains (buyout premiums, squeezes)
# are ~+130%..+300% (logret <= ~1.4); +1.6 (+395%) is safely beyond. Real one-day mid-life
# crashes do reach -90% (logret -2.3, fraud/trial failures), so the down threshold is
# -2.5 (-92%); terminal collapses and post-halt repricings are carved out before this.
SPLICE_UP_LOGRET = 1.6
SPLICE_DOWN_LOGRET = -2.5
# Transient spike repair: a >60% jump that fully reverts within a few bars (net move from
# the pre-spike close < 25%) is a bad print / feed glitch (observed: exact x2 or x228
# one-or-two-bar excursions on ABK, ABN), not two real moves. The spike bars are flattened
# to the pre-spike close instead of severing the series there.
SPIKE_MAX_BARS = 10
SPIKE_NET_TOL = 0.25
UNTRADEABLE_CLOSE = 0.01  # raw close < 1 cent = sub-penny quote noise, not a tradeable print (canary only)
# Canary robustness: a real listed stock returning > +2000% in ONE calendar year is once-a-
# decade rare; sub-dollar quote-ladder junk does it routinely and one x700 lane shifts a
# 5,000-lane equal-weight mean by >10pp. Returns are CAPPED (not dropped) at +20x for the
# canary mean; the uncapped mean and per-year cap counts are reported alongside.
CANARY_CAP_RET = 20.0
# Exchange test symbols (ZAZZT family etc.) carry absurd synthetic prices.
TEST_CODE_RE = re.compile(r"^Z[A-Z]ZZT$")
TEST_NAME_RE = re.compile(r"TEST (STOCK|SYMBOL)|LISTED TEST|TICK PILOT")
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


def repair_spikes(adj: np.ndarray):
    """Flatten transient spikes (constants above). Returns (repaired copy, repair list of
    (start_idx, end_idx, logret)). Each repair removes >= 1 break, so the loop terminates."""
    a = adj.copy()
    repairs = []
    while True:
        lr = np.diff(np.log(a))
        done = True
        for i in np.flatnonzero(np.abs(lr) > BREAK_ABS_LOGRET):
            for j in range(i + 1, min(i + 1 + SPIKE_MAX_BARS, len(a) - 1)):
                if abs(math.log(a[j + 1] / a[i])) < SPIKE_NET_TOL:
                    a[i + 1:j + 1] = a[i]
                    repairs.append((int(i + 1), int(j), float(lr[i])))
                    done = False
                    break
            if not done:
                break  # recompute lr after each repair
        if done:
            return a, repairs


def classify_breaks(adj: np.ndarray, vol: np.ndarray, dead: bool):
    """Indices i where |log(adj[i+1]/adj[i])| > BREAK_ABS_LOGRET, with a class each:
    halt_reprice / stale_close / terminal / unexplained (module docstring)."""
    logret = np.diff(np.log(adj))
    out = []
    n = len(adj)
    for i in np.flatnonzero(np.abs(logret) > BREAK_ABS_LOGRET):
        run, j = 0, i
        while j > 0 and vol[j] == 0 and adj[j] == adj[j - 1]:
            run += 1
            j -= 1
        if run >= HALT_RUN_MIN:
            cls = "halt_reprice"
        elif vol[i] == 0:
            cls = "stale_close"
        elif dead and i + 1 >= n - TERM_WINDOW_TD:
            cls = "terminal"
        else:
            cls = "unexplained"
        out.append((int(i), float(logret[i]), cls))
    return out


def yearly_returns(dates: np.ndarray, adj: np.ndarray, close: np.ndarray, year_min: int):
    """{year: simple return} per calendar year. Reference = last close of the previous
    present year, else (IPO year) the first close of the year if >= MIN_IPO_YEAR_BARS bars.
    Year-returns where either endpoint's RAW close is sub-penny are excluded — those are
    quote noise, not tradeable prints (adjusted closes may be legitimately tiny, raw not)."""
    years = np.array([int(d[:4]) for d in dates])
    out = {}
    prev_year, prev_last, prev_close = None, None, 0.0
    for y in np.unique(years):
        m = years == y
        a, c = adj[m], close[m]
        if int(y) >= year_min and c[-1] >= UNTRADEABLE_CLOSE:
            if prev_year == y - 1 and prev_last and prev_last > 0 and prev_close >= UNTRADEABLE_CLOSE:
                out[int(y)] = float(a[-1] / prev_last - 1.0)
            elif prev_year != y - 1 and len(a) >= MIN_IPO_YEAR_BARS and a[0] > 0 and c[0] >= UNTRADEABLE_CLOSE:
                out[int(y)] = float(a[-1] / a[0] - 1.0)
        prev_year, prev_last, prev_close = y, float(a[-1]), float(c[-1])
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
    spy = pd.read_parquet(spy_pq, columns=["date", "close", "adjusted_close"])
    spy_dates = spy["date"]
    burnin_start, start, end = resolve_era(eras[args.era], spy_dates)
    end_ts = pd.Timestamp(end)
    start_year = int(start[:4])
    spy_cal = spy_dates.to_numpy()

    cand_path = os.path.join(args.data_dir, "universe_src", f"candidates_{args.era}.json")
    candidates = json.load(open(cand_path))
    parquet_dir = os.path.join(args.data_dir, "parquet")

    rows, clip_log, break_log = [], {}, {}
    sever_log, splice_log, pin_log, spike_repair_log = [], [], {}, {}
    drops = {"no_data": [], "test_symbol": [], "insufficient_window_data": [],
             "delisted_outside_window": [], "qc_breaks": [], "dup_class": []}
    sym_years, sym_yret = {}, {}
    downloaded = 0

    for n_done, cand in enumerate(candidates):
        if n_done and n_done % 2000 == 0:
            print(f"  qc {n_done}/{len(candidates)} ...", flush=True)
        sym = cand["symbol"]
        if TEST_CODE_RE.match(sym) or TEST_NAME_RE.search((cand.get("name") or "").upper()):
            drops["test_symbol"].append(sym)  # exchange test symbol: synthetic prices
            continue
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

        # Transient spike repair (constants above): flatten fully-reverting bad prints so a
        # glitch pair does not sever an otherwise continuous series (e.g. ABK 2003/2009/2011).
        if len(df) > 2:
            a = df["adjusted_close"].to_numpy()
            a2, repairs = repair_spikes(a)
            if repairs:
                dts = df["date"].to_numpy()
                spike_repair_log[sym] = {
                    "n": len(repairs),
                    "sample": [{"date": str(dts[s]), "bars": e - s + 1, "logret": round(lr, 2)}
                               for s, e, lr in repairs[:5]],
                }
                df = df.assign(adjusted_close=a2)

        # Splice severing: one-day moves no continuous company can print (constants above).
        # UP > +395%: severed regardless of class — no real resumption/repricing gains that
        # much in a day (observed carve-out abuses: zero-volume flat run then a x600,000
        # "reprice" = recycled-ticker splice). DOWN < -92%: post-halt repricings and terminal
        # collapses are real (fraud halts resume near zero) and are carved out.
        if len(df) > 1:
            a = df["adjusted_close"].to_numpy()
            v = df["volume"].to_numpy()
            cuts = [i for i, lr, cls in classify_breaks(a, v, dead=not is_listed_now)
                    if lr > SPLICE_UP_LOGRET
                    or (lr < SPLICE_DOWN_LOGRET and cls in ("unexplained", "stale_close"))]
            if cuts:
                dts = df["date"].to_numpy()
                bounds = [0] + [c + 1 for c in cuts] + [len(df)]
                segs = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
                lo, hi = segs[-1] if is_listed_now else segs[0]
                splice_log.append({
                    "symbol": sym, "kept": "last" if is_listed_now else "first",
                    "kept_span": [str(dts[lo]), str(dts[hi - 1])],
                    "removed_bars": int(len(df) - (hi - lo)),
                    "splices": [{"date": str(dts[c + 1]), "logret": round(float(np.log(a[c + 1] / a[c])), 2)}
                                for c in cuts[:8]],
                })
                df = df.iloc[lo:hi]

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

        # Remaining discontinuity breaks inside the era window, classified + logged.
        evts = classify_breaks(win["adjusted_close"].to_numpy(), win["volume"].to_numpy(),
                               dead=termination != "alive")
        if evts:
            wd = win["date"].to_numpy()
            break_log[sym] = [{"date": str(wd[i + 1]), "logret": round(lr, 4), "class": cls}
                              for i, lr, cls in evts]
            if sum(1 for _, _, cls in evts if cls == "unexplained") > MAX_BREAKS:
                drops["qc_breaks"].append(sym)
                continue

        # Trailing 63d median dollar volume at the symbol's last in-window date (causal).
        tail = win.tail(DV_WINDOW_TD)
        dv = float(np.nanmedian((tail["close"] * tail["volume"]).to_numpy(dtype="float64")))
        if not math.isfinite(dv):
            dv = 0.0

        yret, yrs = yearly_returns(win["date"].to_numpy(), win["adjusted_close"].to_numpy(),
                                   win["close"].to_numpy(), start_year)
        sym_years[sym] = yrs
        sym_yret[sym] = yret

        rows.append({"symbol": sym, "name": cand["name"], "exchange": cand["exchange"],
                     "type": cand["type"],
                     "is_delisted": bool(cand.get("is_delisted")) or termination != "alive",
                     "first_date": first_date, "last_date": last_date,
                     "median_dollar_vol_63d_last": dv, "termination": termination})

    # Share-class dedup: same normalized name AND overlapping spans => keep the LONGEST
    # span (a rename split across archive codes must keep the full-history one, e.g.
    # JAVA_old 1997-2010 over SUNW_old 2003-07), tie-break higher dollar volume (GOOGL
    # over GOOG). Non-overlapping namesakes are temporal ticker recycling: both kept.
    uni = pd.DataFrame(rows)
    dedup_pairs = []
    if not uni.empty:
        uni["_norm"] = uni["name"].map(normalize_name)
        drop_idx = set()
        span = (pd.to_datetime(uni["last_date"]) - pd.to_datetime(uni["first_date"])).dt.days
        uni["_span"] = span
        for norm, grp in uni.groupby("_norm", sort=False):
            if norm == "" or len(grp) == 1:
                continue
            grp = grp.sort_values(["_span", "median_dollar_vol_63d_last"], ascending=False)
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
        uni = uni.drop(index=sorted(drop_idx)).drop(columns=["_norm", "_span"]).reset_index(drop=True)

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
    spy_yret, _ = yearly_returns(spy_win["date"].to_numpy(), spy_win["adjusted_close"].to_numpy(),
                                 spy_win["close"].to_numpy(), start_year)
    canary = []
    for y in years:
        rs = np.array(year_rets[y], dtype="float64")
        if not len(rs) or y not in spy_yret:
            continue
        capped = np.minimum(rs, CANARY_CAP_RET)
        ew = float(capped.mean())
        med = float(np.median(rs))
        row = {"year": y, "n": int(len(rs)), "ew_mean": round(ew, 4),
               "ew_mean_uncapped": round(float(rs.mean()), 4),
               "n_capped": int((rs > CANARY_CAP_RET).sum()), "median": round(med, 4),
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
        "splice_severed": splice_log,
        "spike_repaired": spike_repair_log,
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
