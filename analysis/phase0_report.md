# Phase 0 — EODHD acceptance test report

Date: 2026-06-10. Source: EODHD "All World" $19.99/mo plan, token in `.env`. Raw responses cached in
`data/phase0/raw/`; price-path plots in `data/phase0/*_path.png`; full structured verdicts in the
workflow result (8 agents, ~178k tokens).

## Verdicts

| Icon | Symbol | Span | Verdict |
|---|---|---|---|
| Enron | ENRNQ.US | 1997-12-31 → 2004-11-17 | **PASS** — peak $90.00 on 2000-08-23; first close <$1 exactly 2001-11-28; all |logret|>60% days match real events (Dynegy collapse, Ch.11, NYSE→OTC) |
| Lehman | LEH.US | 1997-12-31 → 2008-09-17 | **PASS** — peak $85.80 on 2007-02-02; Apr-2006 2:1 split smooth in adjusted; $0.21 on 2008-09-15 |
| Bear Stearns | BSC_old.US + BSC.US | 1999-01-04 → 2008-05-30 | **PASS** — $170 peak Jan-2007; 57→30 on 2008-03-14; ~$3-5 on 03-17; pinned ~$10 to 05-30. NOTE: EODHD archives the recycled ticker as `BSC_old` — `_old` suffix pattern confirmed, must be handled in the universe builder |
| Sun Micro | JAVA.US | 1986-03-04 → 2010-01-26 | **PASS** — ~$250 adj peak Sep-2000; −95%+ into 2002; Dec-2000 2:1 AND Nov-2007 1:4 reverse split both smooth in adjusted (the pre-2018 split-quality check); ends $9.50 Oracle cash. NOTE: ticker-reuse contamination present — series must be truncated at acquisition |
| WaMu | WAMUQ.US | 1997-12-31 → 2012-03-20 | **PASS** — $40s in 2006-07; collapse on 2008-09-25 seizure; pennies after |
| **WorldCom** | MCWEQ.US | 2001-06-08 → 2004-04-20 | **FAIL** — EODHD has NO pre-recap WorldCom history. Series begins at the Jun-2001 WCOM tracking-stock recapitalization ($18.06). The 2000 level (~$45-50) and the H1-2000→H1-2001 decline leg are missing. Adversarial recheck ruled out wrong-symbol (scanned all 109k US symbols; WCOM/WCOEQ return empty), wrong ground truth, unit error, and fetch truncation. Within its window the series is clean and tracks the fraud collapse correctly (incl. the Jun-2002 ~$6→$0.24 cliff). |

## Coverage

- Delisted US symbols: **57,824** (31,867 Common Stock); live: 51,696 (18,339 Common Stock).
- Year-2000 coverage estimate: **~10,958 common stocks** with calendar-2000 bars (sampled, seed 42;
  wide CI but lower bound comfortably > the 4,000 threshold). Lists saved to `data/phase0/us_symbols_*.json`.

## Gate decision

Numeric gate: 5/6 icons + coverage **pass**; WorldCom is a real, confirmed vendor gap (not fixable by
symbol archaeology). v1 (recent-2y era) is unaffected. Deep-era impact: the WorldCom lane would be born
2001-06 with a datum offset — its bubble peak and first collapse leg simply absent.

**Escalation is a spending decision → user's call** (Sharadar trial, or accept the gap; Norgate upgrade
already planned). Build proceeds; deep-era unlock (Phase 4) carries this as a documented known gap.

## Pipeline consequences discovered here (binding on Phase 1)

1. **`_old` suffix**: EODHD archives recycled tickers as `SYM_old.US` (Bear Stearns precedent). The
   universe builder must enumerate and download `_old` variants and stitch/segment them as separate lanes.
2. **Ticker-reuse contamination**: some delisted series (JAVA) contain post-death bars from a later user
   of the symbol — QC must truncate at the termination event (terminal-price pin + volume signature).
3. **Pre-adjusted delisted series**: for old dead tickers EODHD serves close == adjusted_close (already
   split-adjusted, splits endpoint empty). Use `adjusted_close` everywhere; do not expect raw/adj divergence.
4. **403 endpoints on this plan**: symbol-change-history and fundamentals are Forbidden at $19.99 tier —
   ticker-recycling QC must rely on price-discontinuity severing (PLAN §5) instead of the rename API.
5. Halted names can show stale closes with zero volume (MCWEQ Jun 26–28 2002) — QC should treat
   zero-volume flat runs around death as halt artifacts, not returns.
