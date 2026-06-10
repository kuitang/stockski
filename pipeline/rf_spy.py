#!/usr/bin/env python
"""rf_spy.py — SPY full history (EODHD) + risk-free rate (FRED DTB3) → data/rf.parquet.

Per PLAN §2.2/§5 and CONTRACTS §1: r_f = 13-week T-bill from FRED DTB3 (plain CSV,
no key), decimal annualized, forward-filled onto SPY's trading calendar. Forward
fill is trailing-causal by construction: the value for day d is the latest DTB3
print on or before d. SPY raw/parquet reuse the download_prices cache layout.
"""
import argparse
import io
import json
import os
import sys
import time
import urllib.request

import pandas as pd

FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3"


def read_token() -> str:
    """EODHD token from env, falling back to repo .env (never hardcoded)."""
    tok = os.environ.get("EODHD_API_TOKEN")
    if tok:
        return tok
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if line.startswith("EODHD_API_TOKEN="):
                return line.split("=", 1)[1].strip()
    sys.exit("EODHD_API_TOKEN not found in env or .env")


def ensure_spy(data_dir: str, token: str) -> pd.DataFrame:
    raw_path = os.path.join(data_dir, "raw", "SPY.json")
    pq_path = os.path.join(data_dir, "parquet", "SPY.parquet")
    os.makedirs(os.path.dirname(raw_path), exist_ok=True)
    os.makedirs(os.path.dirname(pq_path), exist_ok=True)
    if os.path.exists(raw_path):
        rows = json.load(open(raw_path))
    else:
        url = f"https://eodhd.com/api/eod/SPY.US?api_token={token}&fmt=json&period=d"
        with urllib.request.urlopen(url, timeout=120) as r:
            rows = json.load(r)
        tmp = raw_path + ".tmp"
        json.dump(rows, open(tmp, "w"))
        os.replace(tmp, raw_path)
    df = pd.DataFrame(rows)[["date", "open", "high", "low", "close", "adjusted_close", "volume"]]
    df["date"] = df["date"].astype(str)
    for c in ("open", "high", "low", "close", "adjusted_close"):
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
    df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0).astype("int64")
    df = df.sort_values("date").drop_duplicates("date").reset_index(drop=True)
    if not os.path.exists(pq_path):
        tmp = pq_path + ".tmp"
        df.to_parquet(tmp, index=False)
        os.replace(tmp, pq_path)
    return df


def fetch_dtb3(data_dir: str, token: str) -> tuple:
    """Return (source, DataFrame[date, rate_pct]) from FRED DTB3, falling back to
    EODHD ^IRX (IRX.INDX, the 13-week T-bill discount rate) per PLAN §5/CONTRACTS §1."""
    cache = os.path.join(data_dir, "universe_src", "dtb3.csv")
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    if not os.path.exists(cache):
        for attempt in range(3):  # FRED's CSV gateway 504s/times out transiently; 3 tries then fallback
            try:
                req = urllib.request.Request(FRED_URL, headers={"User-Agent": "stockski-pipeline/1.0"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    text = r.read().decode("utf-8")
                tmp = cache + ".tmp"
                open(tmp, "w").write(text)
                os.replace(tmp, cache)
                break
            except Exception as e:  # noqa: BLE001 — retry, then fall back to ^IRX
                print(f"FRED DTB3 attempt {attempt + 1} failed: {e}")
                time.sleep(3 * (attempt + 1))  # linear backoff: FRED gateway recovers in seconds when it does
    if os.path.exists(cache):
        df = pd.read_csv(cache)
        df.columns = ["date", "rate_pct"]  # FRED header is DATE/observation_date + DTB3 depending on vintage
        df["date"] = df["date"].astype(str)
        df["rate_pct"] = pd.to_numeric(df["rate_pct"], errors="coerce")  # "." = market holiday → NaN, ffilled below
        return "FRED DTB3", df

    # Fallback: ^IRX via EODHD — same instrument (13-week bill, annualized percent).
    irx_cache = os.path.join(data_dir, "universe_src", "irx.json")
    if os.path.exists(irx_cache):
        rows = json.load(open(irx_cache))
    else:
        url = f"https://eodhd.com/api/eod/IRX.INDX?api_token={token}&fmt=json&period=d"
        with urllib.request.urlopen(url, timeout=120) as r:
            rows = json.load(r)
        tmp = irx_cache + ".tmp"
        json.dump(rows, open(tmp, "w"))
        os.replace(tmp, irx_cache)
    df = pd.DataFrame(rows)[["date", "close"]].rename(columns={"close": "rate_pct"})
    df["date"] = df["date"].astype(str)
    df["rate_pct"] = pd.to_numeric(df["rate_pct"], errors="coerce")
    return "EODHD ^IRX", df


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--era", default="recent2y")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "eras.json"))
    ap.add_argument("--out", default="game/public/tiles/", help="unused here; uniform CLI per CONTRACTS §5")
    args = ap.parse_args()

    token = read_token()
    spy = ensure_spy(args.data_dir, token)
    source, dtb3 = fetch_dtb3(args.data_dir, token)

    # Forward-fill (causal: only past prints flow forward) onto SPY's trading calendar.
    rate = dtb3.set_index("date")["rate_pct"].sort_index().ffill() / 100.0  # quoted in percent → decimal annualized
    rate_df = rate.rename("rf_annual").reset_index()
    rate_df["dt"] = pd.to_datetime(rate_df["date"])  # asof merge needs ordered (datetime) keys
    cal = pd.DataFrame({"date": spy["date"]})
    cal["dt"] = pd.to_datetime(cal["date"])
    # merge_asof = latest DTB3/IRX print at-or-before each trading day (trailing-only, CONTRACTS §1).
    rf = pd.merge_asof(cal, rate_df[["dt", "rf_annual"]], on="dt", direction="backward")
    rf = rf[["date", "rf_annual"]]
    n_missing = int(rf["rf_annual"].isna().sum())
    if n_missing:
        # Only the earliest SPY days (pre-1954 impossible; DTB3 starts 1954) could lack a prior print.
        rf = rf.dropna(subset=["rf_annual"]).reset_index(drop=True)
    out_path = os.path.join(args.data_dir, "rf.parquet")
    tmp = out_path + ".tmp"
    rf.to_parquet(tmp, index=False)
    os.replace(tmp, out_path)

    summary = {"rf_source": source,
               "spy_first": spy["date"].iloc[0], "spy_last": spy["date"].iloc[-1],
               "rf_rows": len(rf), "rf_last": float(rf["rf_annual"].iloc[-1]),
               "rf_missing_dropped": n_missing}
    print(f"wrote {out_path}")
    print("GATE " + json.dumps(summary))


if __name__ == "__main__":
    main()
