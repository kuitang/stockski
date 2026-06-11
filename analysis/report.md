# Stock Universe Skier — analysis report (Phases 1–2 synthesis)

Date: 2026-06-11. Era `full`: playable 2000-01-03 → 2026-06-10, burn-in 1999, dynamic top-3000
universe (EODHD All-World, all 17,971 era symbols cached in `data/raw` + `data/parquet`).
Detail reports: `analysis/qc_full_report.md` (Phase 1), `analysis/phase0_report.md` (vendor
acceptance), `analysis/renders/INDEX.md` (aesthetics gate).

## 1. Phase 1 — full-era data audit: PASS

```
GATE {"y2000_lanes": 7340, "min_year_lanes": 5370, "canary_years": [2001, 2003, 2009], "old_variants_added": 2413}
```

17,799 usable lanes from 20,679 candidates, including **2,413 recycled-ticker archive lanes**
(`SYM_old` and trailing-digit `SYM1/2` families — both conventions found and admitted; dense in
1990s/2000s deaths, exactly the era that needed them). QC severed 1,542 ticker-reuse series,
repaired 3,881 transient bad-print spikes (recovering icons like Ambac's GFC arc), severed 1,596
data splices, trimmed 2,063 stale-pin tails, and dropped 799 junk-quote series. Termination:
5,620 alive / 11,800 acquisition / 379 bankruptcy.

Per-decade usable-lane coverage (full per-year table in `data/qc_report.json:year_coverage`):

| decade | min lanes/yr | max | mean |
|---|---|---|---|
| 2000s | 5,485 (2009) | 7,340 (2000) | 6,155 |
| 2010s | 5,370 (2012) | 5,683 (2015) | 5,536 |
| 2020s | 5,790 (2026) | 6,720 (2021) | 6,130 |

Every year ≥ 5,370 lanes (gate ≥ 2,500); year 2000 has 7,340 (gate ≥ 3,000) — the top-3000
universe is over-subscribed ~1.8–2.4× everywhere. Survivorship canary (yearly equal-weight mean
vs SPY) flagged 2001/2003/2009; all three are the documented equal-weight-vs-cap-weight
divergence (small-cap/junk rallies), not survivorship — counter-evidence: 2008 EW −39.0% falls
*harder* than SPY −36.8% (the dead are present), and 2021–24 EW trails SPY 14–15 pp/yr as it
should in the megacap era.

## 2. Ordering + tile export: PASS

```
GATE {"nLanes": 10765, "nDays": 6880, "bytes": 152410644, "ordering_seconds": 142.7}
```

Point-in-time top-3000 union = 10,826 ordered lanes; circular spectral order via k-NN(64)
sparsified W + sparse eigensolver in **142.7 s** at full size (`data/full_order.json`).
61 ordered symbols had no in-era prices after QC and were dropped at export → **10,765 real
lanes**, padded to 10,880 (85 × 128-lane tiles) × 6,880 days, **145 MB** of int16 z-tiles at
`game/public/tiles/full/` (manifest + `z/t<T>_l<L>.bin` per CONTRACTS §2).

## 3. Roughness benchmark: gate ACCEPT=False (spectral-only) — 2-opt closes the gap

```
GATE {"accept": false, "spectral_vs_alpha": [0.8678, 0.8154, 0.8029], "vs_sector": 0.8512, "twoopt_gain_pct": 68.24}
```

Lanes: 10,826 (`data/full_order.json`), calendar 2000-01-03 → 2026-06-10 (6,649 days, SPY
calendar). R = mean |z_i − z_neighbor| over alive adjacent circular pairs; z uses c_i=0 (datum
offsets are ordering-dependent, excluded for fairness). Cap-order proxies point-in-time cap with
LAST-DAY trailing 63d median dollar volume (historical caps unavailable on this EODHD tier).
Sector-grouped uses NASDAQ-screener sectors (live names only): 3,803/10,826 lanes covered, the
rest in one 'Unknown' bucket.

| ordering | R 2000s | R 2010s | R 2020s | R overall | R/R(random) overall |
|---|---|---|---|---|---|
| random(x20 mean) | 1.5137 | 2.1419 | 2.3401 | 1.9377 | 1.000 |
| alphabetical | 1.4738 | 2.1576 | 2.2801 | 1.9113 | 0.986 |
| cap-order (dv proxy) | 1.3900 | 1.8914 | 1.9436 | 1.7137 | 0.884 |
| sector-grouped | 1.4076 | 1.9040 | 2.1543 | 1.8238 | 0.941 |
| PCA-first-loading | 1.3428 | 2.0103 | 2.0978 | 1.7095 | 0.882 |
| hierarchical+OLO (subsample3000)* | 1.2391 | 1.7733 | 1.7689 | 1.5269 | 0.798 |
| random on subsample3000* (x20 mean) | 1.5005 | 2.1339 | 2.2661 | 1.9135 | 1.000 |
| spectral (ours) | 1.2790 | 1.7593 | 1.8306 | 1.5524 | 0.801 |
| spectral+2opt | 0.5062 | 0.4759 | 0.4923 | 0.4930 | 0.254 |

\* hierarchical+OLO exceeded the 10-min budget at full size; scored on a random 3000-lane
subsample against its own random baseline (not directly comparable to full-universe rows).

- spectral / alphabetical per decade: 0.8678 / 0.8154 / 0.8029 — **fails** the ≤ 0.5 criterion
  (spectral-only), hence ACCEPT=False as gated.
- spectral / sector-grouped overall: 0.8512 — passes the beats-sector criterion.
- 2-opt (window 8, 50 passes, 17,171 reversals): **gain 68.24%** ≥ 5% ⇒ 2-opt is kept. The
  shipped spectral+2opt order is 0.34 / 0.22 / 0.22 × alphabetical per decade — under 0.5 in
  every decade, i.e. the PLAN §6 acceptance bar is met by the order we actually ship; only the
  spectral-only intermediate misses it.

## 4. Causality acceptance test: PASS

```
GATE {"causality": "pass", "artifacts_checked": 26}
```

`analysis/causality_tests.py` plants a +50% step on a fixed mid-era day D into (run 1) one real
stock's prices, (run 2) SPY (ghost channel), (run 3) `rf.parquet`, re-runs the real export
pipeline, and diffs every exported artifact (tile z, manifest ghost, manifest rf, dates, lane
metadata) against an unperturbed baseline — **26 artifacts checked, zero pre-D leakage**, with
power checks confirming the step IS visible on days ≥ D in the right channel and only there.
Also verifies no tile contains days beyond era end (causality at the file layer, PLAN §4.5).
Lane ordering is exempt per PLAN §4.1 (build-time layout, same order file fed to both runs).

## 5. Renders index (aesthetics gate inputs — `analysis/renders/`)

- `arc300_spectral.png` vs `arc300_alphabetical.png` vs `arc300_sector.png` — same 300-lane
  megacap arc under shipped / alphabetical / sector order (smooth ridgelines vs unskiable static).
- `era_dotcom.png`, `era_gfc.png`, `era_covid.png`, `era_bear2022.png` — all-lane top-down,
  era-relative dz (blue up / red down): tech-arc collapse, 2008 cliff, Mar-2020 crevasse +
  bifurcated recovery, 2022 grind.
- `era_full.png` — full 2000–2026 sweep, absolute z; lane births/deaths as void wedges.
- `k_sensitivity.png` — K_HEIGHT strip at k = 15/25/40, true meters, for picking skiable relief.

## 6. Known gaps carried forward (phase 0 → here)

- **WorldCom (MCWEQ)**: EODHD has NO pre-recap history — the lane is born 2001-06 at the WCOM
  tracking-stock recap; the 2000 peak (~$45–50) and the H1-2000→H1-2001 decline leg are absent.
  Adversarial recheck (all 109k US symbols) ruled out symbol archaeology; a real vendor gap.
  Within its window the series is clean (incl. the Jun-2002 $6→$0.24 cliff). v1 (recent-2y)
  unaffected; deep eras carry this as a documented gap. **Escalation = spending decision
  (Sharadar trial / Norgate) → user's call.**
- **`_old` / recycled-ticker archives**: phase-0 finding, RESOLVED in Phase 1 — both archive
  conventions (`_old*`, trailing digit) enumerated, downloaded, QC'd: 2,413 lanes added (Bear
  Stearns `BSC_old`, Sun `JAVA_old`, `GM_old` all present as separate lanes from their live
  successors). Ticker-reuse contamination handled by gap/splice severing; pre-2018 delisted
  series are pre-adjusted (use `adjusted_close`); rename/fundamentals APIs are 403 at this tier
  so QC is price/volume-signature only; zero-volume stale pins trimmed.
- WaMu lane absent (post-delisting venue is OTC, outside the listed-venue filter; raw WAMUQ
  cached if a venue exception is ever wanted). Some archives start at vendor depth tiers
  (1997-12-31 / 2003-09-10) and are born mid-era with datum offsets per PLAN §1.

## 7. Escape hatches (documented, ready if needed)

- **Ordering at scale — kNN+LOBPCG fallback**: `pipeline/ordering.py` replaces the dense
  Laplacian with k-NN(64)-sparsified W and preconditioned LOBPCG, with eigsh shift-invert on
  sparse L as backstop (the backstop actually fired this run after LOBPCG's postprocessing
  failure — 142.7 s end-to-end at 10,826 lanes, well within budget). If the universe grows
  (Norgate Russell union), the same path scales.
- **Norgate upgrade path** (PLAN §0/§5): unlocks playable 1996 with 1995 burn-in (full bubble
  arc), actual historical Russell 3000 membership instead of the dollar-volume proxy, and is the
  structural fix for vendor gaps like WorldCom pre-2001.

OPEN GATES FOR USER: aesthetics (see renders/), game feel (play :8090), WorldCom escalation decision.
