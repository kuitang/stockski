#!/usr/bin/env python
"""download_prices.py — full-history EODHD EOD download per candidate symbol.

Per CONTRACTS §1/§5. For each symbol in data/universe_src/candidates_<era>.json
(plus SPY, always — ghost + trading calendar):
  data/raw/<SYM>.json      raw EODHD JSON, cached; SKIP if file exists (resumable)
  data/parquet/<SYM>.parquet  columns date(str), open/high/low/close/adjusted_close
                              (float64), volume(int64)
Rate-limited token bucket shared across a thread pool (--rps, default 12: EODHD
allows 1000 req/min, 12 rps ~ 720/min keeps headroom). Progress every 200 symbols
to data/download_progress.txt. Re-runs are no-ops on completed symbols.
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

PROGRESS_EVERY = 200  # symbols between progress lines, per task spec
MAX_RETRIES = 3  # transient HTTP/network errors: 3 tries before recording failure
PARQUET_COLS = ["date", "open", "high", "low", "close", "adjusted_close", "volume"]  # CONTRACTS §1


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


class RateLimiter:
    """Token bucket: at most rps requests/sec across all worker threads."""

    def __init__(self, rps: float):
        self.interval = 1.0 / rps
        self.lock = threading.Lock()
        self.next_t = time.monotonic()

    def acquire(self):
        with self.lock:
            now = time.monotonic()
            self.next_t = max(self.next_t, now)
            wait = self.next_t - now
            self.next_t += self.interval
        if wait > 0:
            time.sleep(wait)


def fetch_eod(symbol: str, token: str, limiter: RateLimiter):
    url = f"https://eodhd.com/api/eod/{symbol}.US?api_token={token}&fmt=json&period=d"
    last_err = None
    for attempt in range(MAX_RETRIES):
        limiter.acquire()
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:  # unknown symbol: definitive, cache as empty
                return []
            last_err = e
        except Exception as e:  # noqa: BLE001 — network layer, retry then record
            last_err = e
        time.sleep(2 ** attempt)  # exponential backoff: 1s, 2s on retries
    raise RuntimeError(f"{symbol}: {last_err}")


def write_parquet(symbol: str, rows: list, parquet_dir: str):
    if not rows:
        return False
    df = pd.DataFrame(rows)
    if not set(PARQUET_COLS) <= set(df.columns):
        return False
    df = df[PARQUET_COLS]
    df["date"] = df["date"].astype(str)
    for c in ("open", "high", "low", "close", "adjusted_close"):
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
    df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0).astype("int64")
    df = df.sort_values("date").drop_duplicates("date").reset_index(drop=True)
    tmp = os.path.join(parquet_dir, f"{symbol}.parquet.tmp")
    df.to_parquet(tmp, index=False)
    os.replace(tmp, os.path.join(parquet_dir, f"{symbol}.parquet"))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--era", default="recent2y")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "eras.json"))
    ap.add_argument("--out", default="game/public/tiles/", help="unused here; uniform CLI per CONTRACTS §5")
    ap.add_argument("--rps", type=float, default=12.0)
    ap.add_argument("--workers", type=int, default=16,
                    help="16 threads keeps the 12 rps bucket saturated despite per-request latency")
    args = ap.parse_args()

    token = read_token()
    raw_dir = os.path.join(args.data_dir, "raw")
    parquet_dir = os.path.join(args.data_dir, "parquet")
    os.makedirs(raw_dir, exist_ok=True)
    os.makedirs(parquet_dir, exist_ok=True)
    progress_path = os.path.join(args.data_dir, "download_progress.txt")

    cand_path = os.path.join(args.data_dir, "universe_src", f"candidates_{args.era}.json")
    if not os.path.exists(cand_path):
        sys.exit(f"missing {cand_path}; run build_universe.py first")
    symbols = [r["symbol"] for r in json.load(open(cand_path))]
    if "SPY" not in symbols:
        symbols.append("SPY")  # ghost series + master trading calendar, always downloaded (PLAN §6.2)

    limiter = RateLimiter(args.rps)
    lock = threading.Lock()
    stats = {"done": 0, "fetched": 0, "cached": 0, "empty": 0, "failed": 0}
    failures = []
    t0 = time.time()

    def log_progress(force=False):
        if stats["done"] % PROGRESS_EVERY == 0 or force:
            line = (f"{time.strftime('%H:%M:%S')} {stats['done']}/{len(symbols)} "
                    f"fetched={stats['fetched']} cached={stats['cached']} empty={stats['empty']} "
                    f"failed={stats['failed']} elapsed={time.time() - t0:.0f}s\n")
            with open(progress_path, "a") as f:
                f.write(line)
            print(line, end="")

    def work(symbol: str):
        raw_path = os.path.join(raw_dir, f"{symbol}.json")
        pq_path = os.path.join(parquet_dir, f"{symbol}.parquet")
        try:
            if os.path.exists(raw_path):
                rows = None
                if not os.path.exists(pq_path):  # raw cached but parquet missing: rebuild locally
                    rows = json.load(open(raw_path))
                    write_parquet(symbol, rows, parquet_dir)
                with lock:
                    stats["cached"] += 1
            else:
                rows = fetch_eod(symbol, token, limiter)
                tmp = raw_path + ".tmp"
                json.dump(rows, open(tmp, "w"))
                os.replace(tmp, raw_path)
                write_parquet(symbol, rows, parquet_dir)
                with lock:
                    stats["fetched"] += 1
                    if not rows:
                        stats["empty"] += 1
        except Exception as e:  # noqa: BLE001
            with lock:
                stats["failed"] += 1
                failures.append({"symbol": symbol, "error": str(e)})
        finally:
            with lock:
                stats["done"] += 1
                log_progress()

    with open(progress_path, "a") as f:
        f.write(f"=== {time.strftime('%Y-%m-%d %H:%M:%S')} era={args.era} n={len(symbols)} rps={args.rps} ===\n")
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(work, symbols))
    log_progress(force=True)

    if failures:
        json.dump(failures, open(os.path.join(args.data_dir, "download_failures.json"), "w"), indent=1)
    downloaded = sum(1 for s in symbols
                     if os.path.exists(os.path.join(parquet_dir, f"{s}.parquet")))
    summary = {"era": args.era, "symbols": len(symbols), "downloaded": downloaded,
               "fetched": stats["fetched"], "cached": stats["cached"],
               "empty": stats["empty"], "failed": stats["failed"]}
    print("GATE " + json.dumps(summary))
    sys.exit(1 if stats["failed"] > len(symbols) * 0.02 else 0)  # >2% hard failures = gate failure (flaky run, rerun resumes)


if __name__ == "__main__":
    main()
