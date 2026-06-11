#!/usr/bin/env python
"""build_universe.py — fetch EODHD US symbol lists and emit era candidate list.

Per PLAN §5/§6.1 and CONTRACTS §5. Outputs:
  data/universe_src/us_symbols_live.json      (raw EODHD exchange-symbol-list)
  data/universe_src/us_symbols_delisted.json  (raw, &delisted=1)
  data/universe_src/candidates_<era>.json     (filtered candidate records)

Candidate filter (PLAN §6.1): Type == "Common Stock", symbol ^[A-Z]{1,5}$,
exchange in {NYSE, NYSE ARCA, NYSE MKT, NASDAQ, AMEX, BATS}, name-keyword drop of
warrants/rights/units/preferred. Share-class dedup happens post-download in qc.py
(needs 63d median dollar volume, which needs prices).

For recent2y the delisted list carries no dates, so delisted candidates are decided
post-download (qc.py keeps only those whose EOD history ends inside the era window);
pass --delisted to include them in the candidate/download set.
"""
import argparse
import json
import os
import re
import sys
import urllib.request

EXCHANGES = {"NYSE", "NYSE ARCA", "NYSE MKT", "NASDAQ", "AMEX", "BATS"}  # PLAN §6.1 listed-primary venues
SYMBOL_RE = re.compile(r"^[A-Z]{1,5}$")  # PLAN: plain 1-5 capital letters; excludes share-class dots, units, warrants suffixes
# EODHD recycled-ticker archives (phase0 finding #1): a dead prior user of a now-reused ticker is
# served under an archive code and is its OWN lane (the live successor is a different company/lane).
# Two archive families exist in the US list:
#   SYM_old, SYM_old1, SYM_old2, SYM_oldoldold  -> r"_old(?:old)*\d?$"
#   SYM1, SYM2 (trailing digit, e.g. AAP1 = Amway Asia Pacific, the pre-Advance-Auto user of AAP)
ARCHIVE_RE = re.compile(r"^[A-Z]{1,5}(?:_old(?:old)*\d?|\d)$")
# Word-boundary match so e.g. UNITED/WRIGHT survive while "UNITS"/"RIGHTS" instruments are dropped.
NAME_DROP_RE = re.compile(r"\b(WARRANTS?|RIGHTS?|UNITS?|PREFERRED|PREF|PFD)\b")
# Exchange test symbols (synthetic prices). Real "* Test Systems" companies are NOT matched.
# ^[A-Z]?TEST$ adds the NYSE/BATS connectivity-test family (CTEST/NTEST/ZTEST/PTEST/ATEST),
# and ZTST is Cboe's listed test symbol — all have name == code; found live in the
# full-era ordering, 2026-06. (NTST/ATST/STST are real companies and do NOT match.)
TEST_CODE_RE = re.compile(r"^Z[A-Z]ZZT$|^[A-Z]?TEST$|^ZTST$")
TEST_NAME_RE = re.compile(r"TEST (STOCK|SYMBOL)|LISTED TEST|TICK PILOT")


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


def fetch_symbol_list(token: str, delisted: bool, dest: str, phase0_src: str) -> list:
    """Download (or reuse cached phase0 copy of) the US exchange symbol list."""
    if not os.path.exists(dest):
        if os.path.exists(phase0_src):
            print(f"reusing cached {phase0_src}")
            data = json.load(open(phase0_src))
        else:
            url = (
                "https://eodhd.com/api/exchange-symbol-list/US"
                f"?api_token={token}&fmt=json" + ("&delisted=1" if delisted else "")
            )
            print(f"fetching {'delisted' if delisted else 'live'} US symbol list ...")
            with urllib.request.urlopen(url, timeout=120) as r:
                data = json.load(r)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = dest + ".tmp"
        json.dump(data, open(tmp, "w"))
        os.replace(tmp, dest)
    return json.load(open(dest))


def is_candidate(rec: dict) -> bool:
    if rec.get("Type") != "Common Stock":
        return False
    if rec.get("Exchange") not in EXCHANGES:
        return False
    code = rec.get("Code") or ""
    if not (SYMBOL_RE.match(code) or ARCHIVE_RE.match(code)):
        return False
    if TEST_CODE_RE.match(code):
        return False
    name = (rec.get("Name") or "").upper()
    return not (NAME_DROP_RE.search(name) or TEST_NAME_RE.search(name))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--era", default="recent2y")
    ap.add_argument("--data-dir", default="data")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "eras.json"))
    ap.add_argument("--out", default="game/public/tiles/", help="unused here; uniform CLI per CONTRACTS §5")
    ap.add_argument("--delisted", action="store_true",
                    help="include delisted candidates in the download set (era membership decided post-download in qc.py)")
    args = ap.parse_args()

    eras = json.load(open(args.config))
    if args.era not in eras:
        sys.exit(f"unknown era {args.era!r}; have {list(eras)}")

    token = read_token()
    src_dir = os.path.join(args.data_dir, "universe_src")
    phase0 = os.path.join(args.data_dir, "phase0")
    live = fetch_symbol_list(token, False, os.path.join(src_dir, "us_symbols_live.json"),
                             os.path.join(phase0, "us_symbols_live.json"))
    deli = fetch_symbol_list(token, True, os.path.join(src_dir, "us_symbols_delisted.json"),
                             os.path.join(phase0, "us_symbols_delisted.json"))

    candidates = {}
    for rec in live:
        if is_candidate(rec):
            candidates[rec["Code"]] = {
                "symbol": rec["Code"], "name": rec.get("Name") or "",
                "exchange": rec["Exchange"], "type": rec["Type"], "is_delisted": False,
            }
    n_live = len(candidates)
    n_del = 0
    if args.delisted:
        for rec in deli:
            if is_candidate(rec) and rec["Code"] not in candidates:
                candidates[rec["Code"]] = {
                    "symbol": rec["Code"], "name": rec.get("Name") or "",
                    "exchange": rec["Exchange"], "type": rec["Type"], "is_delisted": True,
                }
                n_del += 1

    out = os.path.join(src_dir, f"candidates_{args.era}.json")
    rows = sorted(candidates.values(), key=lambda r: r["symbol"])
    tmp = out + ".tmp"
    json.dump(rows, open(tmp, "w"), indent=0)
    os.replace(tmp, out)
    n_arch = sum(1 for r in rows if ARCHIVE_RE.match(r["symbol"]))
    print(f"wrote {out}: {len(rows)} candidates ({n_live} live, {n_del} delisted, {n_arch} recycled-ticker archives)")
    print('GATE ' + json.dumps({"era": args.era, "candidates": len(rows), "live": n_live,
                                "delisted": n_del, "archives": n_arch}))


if __name__ == "__main__":
    main()
