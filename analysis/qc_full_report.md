# Phase 1 — full-era data completion + QC audit

Date: 2026-06-11. Era `full` (pipeline/eras.json): playable 2000-01-03 → 2026-06-10, burn-in from
1999-01-04, dynamic top-3000 universe. Inputs: EODHD EOD histories in `data/raw` / `data/parquet`
(20,680 symbols incl. SPY). Outputs: `data/universe.parquet` (17,799 lanes), `data/qc_report.json`
(full repair/sever/break logs), this report. Reproduce:
`pipeline/build_universe.py --era full --delisted` → `download_prices.py --era full --rps 12`
→ `qc.py --era full` (all with `.venv` python).

## 1. Recycled-ticker archives (phase0 finding #1) — RESOLVED

`build_universe.py`'s `^[A-Z]{1,5}$` regex dropped EODHD's recycled-ticker archive codes. A scan of
all 109,520 US symbol records found **two archive families** (each archive = the dead PRIOR user of
a now-reused ticker, its own lane; the live successor is a different lane):

| pattern | examples | Common-Stock candidates |
|---|---|---|
| `_old`, `_old1/2`, `_oldoldold` | `BSC_old` (Bear Stearns), `JAVA_old` (Sun), `GM_old`, `ABI_old1` (Applied Biosystems) | 1,394 |
| trailing digit `SYM1`/`SYM2` | `AAP1` (Amway Asia Pacific), `AM2` (Antero Midstream LP), `ACCS2` (Access Health) | 1,315 |

The digit family is the older convention and is dense in 1990s/2000s deaths — exactly the era this
phase needed. `build_universe.py` now admits both via `ARCHIVE_RE`; all **2,709** archive candidates
were downloaded (idempotent, `--rps 12`, 0 failures, 0 empty), and **2,413 archive lanes** pass QC
into the universe. Exchange test symbols (`ZAZZT` family, "LISTED TEST STOCK" names — 13 records)
are now excluded by code+name pattern; real companies like Aehr Test Systems are unaffected.

## 2. QC pipeline (qc.py, full range)

Per-symbol order of operations (full structured logs in `data/qc_report.json`):

1. **Non-positive price clipping** — 538 symbols, replaced with last positive close.
2. **Ticker-reuse gap severing** (phase0 #2) — a gap > 30 *trading* days (SPY calendar) followed by
   resurrection = a different user of the symbol. Delisted symbols keep the FIRST segment (the
   original company), live ones keep the LAST (the live list refers to the current user; the prior
   user is archived). **1,542 symbols severed** (e.g. `KBL` Keebler truncated 2001-03-26, removing
   2010-18 junk; `ACER`, `VIEW`).
3. **Stale-pin trim** (phase0 #5) — trailing zero-volume flat closes on dead series are halt /
   registration artifacts, trimmed so the termination date is the last real print. 2,063 symbols.
4. **Transient spike repair** — a >60% jump that fully reverts (net < 25%) within 10 bars is a bad
   print (observed exact ×2 and ×228 one-bar excursions), flattened to the pre-spike close rather
   than severing. **3,881 symbols repaired** — this recovered icon lanes such as `ABK` (Ambac), whose
   2003 glitch pair previously cost its entire 2004-2011 GFC arc.
5. **Splice severing** — a one-day move no continuous company can print (> +395% logret +1.6, or
   < −92% logret −2.5) is a data splice (reverse-merger relist, recycled ticker without a calendar
   gap, unadjusted reverse split): severed like a reuse gap. Carve-outs for REAL events: post-halt
   repricings and terminal collapses on the downside (Lehman −94%-days survive). Up-moves > +395%
   sever regardless — the worst offender was a zero-volume "halt" followed by a ×630,000 "reprice"
   (`SFI` 2012). **1,596 symbols severed.**
6. **Break classification** (overnight |logret| > 60%, PLAN §5): `halt_reprice` (≥3 zero-volume flat
   closes before — phase0 #5), `stale_close` (prior bar zero volume), `terminal` (last 30 bars of a
   dead series — phase0 verified these match real events for ENRNQ/LEH/BSC), else `unexplained`.
   Isolated unexplained breaks are kept (real one-day crashes exist); **>3 unexplained ⇒ dropped
   (799 symbols)**, all junk-quote series. The rename/fundamentals APIs are 403 at this plan tier
   (phase0 #4), so classification is price/volume-signature only. 6,222 symbols have ≥1 logged break.
7. **Termination** (PLAN §6.3): alive 5,620 / acquisition 11,800 / bankruptcy 379. Known mechanical
   limitation: a stock that collapsed months before its final print (ENRNQ pennies for 2002-04)
   classifies "acquisition" because its FINAL 30 days are flat; the game-relevant crevasse geometry
   is driven by the price path itself, which is correct.
8. **Share-class dedup** — same normalized name AND >50% span overlap ⇒ keep the longest span
   (tie-break: dollar volume). 1,476 dropped (`GOOG` vs `GOOGL`; `SUNW_old` vs `JAVA_old` — a rename
   split across two archive codes, full-history `JAVA_old` kept). The >50%-overlap rule keeps
   temporal namesakes as separate lanes: old GM (`GM_old`, †2011) and new `GM` coexisted 4 months
   and are BOTH kept.

## 3. Per-decade / per-year usable-lane coverage

| decade | min lanes/yr | max | mean |
|---|---|---|---|
| 2000s | 5,485 (2009) | 7,340 (2000) | 6,155 |
| 2010s | 5,370 (2012) | 5,683 (2015) | 5,536 |
| 2020s | 5,790 (2026) | 6,720 (2021) | 6,130 |

Every year 2000-2026 has ≥ **5,370** usable lanes (gate: ≥2,500); year 2000 has **7,340**
(gate: ≥3,000). The dynamic top-3000 universe is therefore over-subscribed ~1.8-2.4× in every year.
Full per-year table in `data/qc_report.json:year_coverage`.

## 4. Yearly equal-weight mean vs SPY (survivorship/QC canary)

Per-lane calendar-year simple returns (prev-year-close to year-close, adjusted), excluding
sub-penny raw closes (<$0.01, untradeable quote noise) and capping single-lane returns at +2000%
for the mean (a real listed +20x-in-a-year is once-a-decade rare; quote-ladder junk does it
routinely and one ×700 lane moves a 5,500-lane mean >10pp — cap counts are logged, ≤11/yr,
uncapped means also reported). Flag = |EW − SPY| > 25pp.

| yr | n | EW mean | median | SPY | diff pp | | yr | n | EW mean | median | SPY | diff pp |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2000 | 7327 | −2.9% | −10.6% | −9.7% | +6.9 | | 2014 | 5582 | +5.3% | +3.4% | +13.5% | −8.1 |
| **2001** | 6714 | +18.7% | +4.3% | −11.8% | **+30.4** | | 2015 | 5638 | −4.9% | −4.1% | +1.2% | −6.1 |
| 2002 | 6137 | −6.2% | −9.4% | −21.6% | +15.3 | | 2016 | 5625 | +19.0% | +12.6% | +12.0% | +7.0 |
| **2003** | 6053 | +76.4% | +38.6% | +28.2% | **+48.2** | | 2017 | 5599 | +17.7% | +9.5% | +21.7% | −4.0 |
| 2004 | 6018 | +23.4% | +12.6% | +10.7% | +12.7 | | 2018 | 5556 | −10.0% | −11.2% | −4.6% | −5.5 |
| 2005 | 6005 | +10.6% | +1.9% | +4.8% | +5.8 | | 2019 | 5517 | +21.5% | +16.1% | +31.2% | −9.8 |
| 2006 | 5973 | +21.1% | +12.5% | +15.9% | +5.2 | | 2020 | 5834 | +31.9% | +3.9% | +18.3% | +13.6 |
| 2007 | 5929 | +3.3% | −4.3% | +5.2% | −1.9 | | 2021 | 6694 | +14.4% | +3.7% | +28.7% | −14.4 |
| 2008 | 5659 | −39.0% | −44.1% | −36.8% | −2.2 | | 2022 | 6473 | −20.2% | −18.3% | −18.2% | −2.1 |
| **2009** | 5421 | +64.5% | +33.2% | +26.4% | **+38.2** | | 2023 | 6124 | +11.1% | +4.5% | +26.2% | −15.1 |
| 2010 | 5446 | +28.3% | +17.9% | +15.1% | +13.2 | | 2024 | 5837 | +10.9% | +1.9% | +24.9% | −14.0 |
| 2011 | 5343 | −6.3% | −5.9% | +1.9% | −8.2 | | 2025 | 5871 | +10.9% | +1.2% | +17.7% | −6.9 |
| 2012 | 5337 | +18.8% | +12.7% | +16.0% | +2.8 | | 2026* | 5733 | +4.6% | +1.0% | +6.7% | −2.1 |
| 2013 | 5380 | +39.1% | +26.8% | +32.3% | +6.8 | | | | | | | (*partial yr) |

**Flagged years — all three explained** as the well-documented divergence between an equal-weighted
all-cap mean and the cap-weighted S&P 500, NOT survivorship:

- **2001 (+30.4pp)**: megacap tech crashed (SPY −11.8%) while small/value rallied — Russell 2000
  +2.5%, Russell 2000 Value +14.0%; equal-weighting overweights exactly that cohort. Median lane
  +4.3% confirms a broadly positive small-cap year, with 6,714 lanes including the dot-com dead.
- **2003 (+48.2pp)**: post-bear reflation. Russell 2000 +47.3% — already ~at our EW mean's
  midpoint — and CRSP microcap deciles returned +60-90%; median lane +38.6%.
- **2009 (+38.2pp)**: the March-2009 low-price junk rally; Russell 2000 +27.2% but low-priced
  decile portfolios roughly doubled. Median +33.2%.

Counter-evidence that the panel is NOT survivorship-biased (the failure the canary exists to catch):
(a) **2008: EW −39.0% vs SPY −36.8%** — the universe falls *harder* than the index, so dead/dying
lanes are present; (b) 2000 EW −2.9% ≈ Russell 2000's −3.0%; (c) **2021-24 EW trails SPY by
14-15pp/yr**, matching the megacap-concentration era (equal-weight S&P / small caps underperformed
the cap-weighted index by double digits those years) — a survivor-skewed panel would not show this.

## 5. Icon lane spot-checks (vs phase0 verdicts)

| lane | span kept | termination | note |
|---|---|---|---|
| ENRNQ Enron | 1997-12-31 → 2004-11-17 | acquisition† | †mechanical rule; path shows the 2001 collapse correctly |
| LEH Lehman | 1997-12-31 → 2008-09-17 | bankruptcy | |
| BSC_old Bear Stearns | 1999-01-04 → 2008-03-14 | acquisition | archive lane; live BSC is a different lane |
| JAVA_old Sun Micro | 1997-12-31 → 2010-01-26 | acquisition | reuse contamination gone (vendor now serves clean `_old`); kept over partial `SUNW_old` |
| MCWEQ WorldCom | 2001-06-08 → 2004-04-20 | bankruptcy | pre-recap history still a vendor gap (phase0 FAIL, documented) |
| GM_old / GM | 1997→2011-03-31 / 2010-11→alive | acquisition / alive | both kept as separate lanes |
| ABK Ambac | 1997-12-31 → 2011-08-23 | acquisition | recovered by spike repair |

## 6. Known gaps / caveats (carried forward)

- **WorldCom pre-2001**: vendor has no pre-recap WCOM history (phase0 finding; unfixable here).
- **Post-delisting OTC continuations excluded by venue filter**: WAMUQ (Washington Mutual) and
  MTLQU (Motors Liquidation) live on `OTCMKTS`/`PINK`, outside PLAN §6.1's listed-venue set, and
  WaMu's NYSE-era ticker (WM) has no `_old` archive — so the WaMu lane is absent. Raw WAMUQ data is
  cached from phase0 if a venue-policy exception is ever wanted.
- Some delisted archives start exactly 1997-12-31 or 2003-09-10 (vendor archive depth tiers, e.g.
  FNM, FRE, EK start 2003-09-10) — those lanes are born mid-era with datum offsets per PLAN §1.
- A handful of EODHD delisted-list names are wrong (e.g. `FRE` labeled "Fresenius" but the series
  is Freddie Mac's 2003-2010 NYSE run); prices, not names, drive terrain.
- 799 symbols dropped for >3 unexplained breaks are overwhelmingly sub-dollar quote-ladder series;
  `ABC` (AmerisourceBergen) is among them but its full 1995-2026 history survives as `COR` (Cencora).

## 7. Gate

```
GATE {"y2000_lanes": 7340, "min_year_lanes": 5370, "canary_years": [2001, 2003, 2009], "old_variants_added": 2413}
```

- year-2000 usable lanes **7,340 ≥ 3,000** PASS
- every year 2000-present **≥ 5,370 ≥ 2,500** PASS
- canary flags **2001/2003/2009 all explained** (EW-vs-cap-weight structure, §4) PASS

**Phase 1 gate: PASS.**
