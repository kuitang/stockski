# pipeline/ — EODHD data pipeline (PLAN §6, CONTRACTS §1/§5)

All scripts share the CLI `--era recent2y|full --data-dir data/ --out game/public/tiles/
--config pipeline/eras.json`, read `EODHD_API_TOKEN` from env or repo `.env` (never
hardcoded/committed), print a machine-readable `GATE {json}` line last, and exit
nonzero on gate failure. Every step is idempotent: re-runs skip cached artifacts.

Run order (recent2y):

```bash
.venv/bin/python pipeline/build_universe.py  --era recent2y --data-dir data
.venv/bin/python pipeline/download_prices.py --era recent2y --data-dir data --rps 12
.venv/bin/python pipeline/rf_spy.py          --era recent2y --data-dir data
.venv/bin/python pipeline/qc.py              --era recent2y --data-dir data
```

## eras.json

`recent2y` = {start: 2024-06-10 (first trading day ~2y before build date), end: null
(= latest available, resolved to SPY's last date at QC time), burnin_days: 63, top_n: 3000}.
`full` = {start: 2000-01-03, burnin_start: 1999-01-04, end: null, top_n: 3000}.

## build_universe.py

Fetches the US exchange symbol lists (live and `&delisted=1`) into
`data/universe_src/us_symbols_{live,delisted}.json`, reusing `data/phase0/us_symbols_*.json`
if present. Candidate filter (PLAN §6.1): `Type == "Common Stock"`, symbol `^[A-Z]{1,5}$`,
exchange ∈ {NYSE, NYSE ARCA, NYSE MKT, NASDAQ, AMEX, BATS}, word-boundary name-keyword
drop of warrants/rights/units/preferred. Writes `data/universe_src/candidates_<era>.json`.

The delisted list carries no dates, so delisted candidates can only be assigned to an
era after their histories are downloaded; pass `--delisted` to add all delisted
candidates to the download set — `qc.py` then keeps only those whose EOD history ends
inside the era window. (The recent2y v1 run downloads live candidates only.)
Share-class dedup also happens post-download in `qc.py` (it needs dollar volume).

## download_prices.py

Full-history EOD per symbol (`/api/eod/SYM.US?...&fmt=json&period=d`), plus SPY always.
Raw JSON cached at `data/raw/SYM.json` (**skipped if present — resumable**); canonical
parquet at `data/parquet/SYM.parquet` with columns
`date, open, high, low, close, adjusted_close, volume` (CONTRACTS §1). Token-bucket
rate limit `--rps 12` (EODHD allows 1000/min) shared across a 16-thread pool; progress
appended to `data/download_progress.txt` every 200 symbols; failures (after 3 retries)
recorded in `data/download_failures.json`. Gate fails if >2% of symbols hard-fail.

## rf_spy.py

Ensures SPY raw+parquet, fetches FRED DTB3 (plain CSV, no key; cached at
`data/universe_src/dtb3.csv`), converts percent → decimal annualized, and forward-fills
onto SPY's trading calendar via backward `merge_asof` — i.e. the value for day d is the
latest DTB3 print ≤ d (trailing-causal). Writes `data/rf.parquet` (`date, rf_annual`).

## qc.py (PLAN §6.3)

Per candidate with a parquet, restricted to the era window (burn-in start … end):

* zero/negative prices clipped to the last positive close and logged;
* overnight |log return| > 60% flagged as a discontinuity break; v1 policy: log all
  breaks to `data/qc_report.json` and **drop** symbols with > 3 unexplained breaks;
* delisted-list candidates kept only if their history ends inside the window;
* termination: `alive` if last date within 7 calendar days of era end; else terminal
  30-trading-day return < −80% ⇒ `bankruptcy`, else `acquisition`;
* share-class dedup: symbols with the same normalized company name (legal suffixes and
  class designators stripped) collapse to the class with the higher trailing 63-day
  median dollar volume (keep GOOGL, drop GOOG); pairs logged;
* `is_delisted` in the output is provenance OR non-alive termination (a "live"-listed
  symbol whose prints stopped months ago is effectively delisted).

Writes `data/universe.parquet`
(`symbol, name, exchange, type, is_delisted, first_date, last_date,
median_dollar_vol_63d_last, termination`) and `data/qc_report.json`.
Gate: usable symbols ≥ 6000 for recent2y, printed as
`GATE {"era":...,"candidates":N,"downloaded":N,"usable":N,"dropped":N}`
(`dropped` = downloaded − usable).
