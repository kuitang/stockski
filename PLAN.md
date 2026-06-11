# Stock Universe Skier — Build Plan (final, deep-history edition)

A 3D Three.js SKIING game: ski along the living edge of the market, 2000 → present, through the dot-com bust (2000–02), the GFC (2008), the COVID crash (2020), and the 2022 bear. Feel references: Alto's Adventure (flow, minimalism), SSX (speed on big terrain). The surface is a cylinder — time along the axis, US stocks around the circumference, height = cumulative log return. A world clock advances "now" and terrain falls as fresh snow at the frontier (the future beyond it is WHITEOUT); the skier is pinned to the frontier, can never see the future, and controls only lateral position and a market-exposure dial. INVARIANT: the player's state is a real, long-only, self-financing portfolio at every instant, and every game mechanic corresponds to an investable action (assumptions disclosed in §2.4).

De-risked already: NASDAQ screener endpoint works (~7,100 live US stocks with caps/sectors); yfinance 1.4.1 downloads cleanly; 3000-stock universe construction verified.

## 0. Locked decisions

* Engine: Three.js (Vite + ES modules). Terrain streamed in tiles (deep history is too big to preload; streaming also enforces no-future at the network layer).
* Topology: cylinder, periodic stock axis, circular spectral ordering, no seam. Flat-with-wraparound render first; tube mode later.
* Timeline: playable 2000 → present (~6,600 trading days) with burn-in year 1999 (EODHD v1: delisting coverage starts ~Jan 2000); Norgate upgrade unlocks playable 1996 with 1995 burn-in (full bubble arc). Era-select start dates and clock speeds (default 2 trading days/sec; full run ≈ 1 h). v1 gate plays the most recent 2 years first; deep eras unlock after data audit (§8). 1970 was evaluated and rejected: pre-1990 survivorship-free data is CRSP-or-nothing (Norgate's pre-1990 delisted coverage is explicitly incomplete), and 56-year dispersion/ordering-staleness/run-length costs outweigh the content.
* Universe: dynamic, POINT-IN-TIME. At any date, lanes = the top-3000 by trailing 63-day median dollar volume (EODHD v1: causal, covers dead and living; Norgate upgrade: actual historical Russell 3000 constituents; Sharadar: cap-rank from point-in-time daily caps). Union over the window ≈ 8–12k lanes (top-3000 membership churns ~250+/yr); every member ever gets one permanent lane.
* Frontier: skier pinned to τ; forward motion supplied by the clock; player controls lateral s and exposure w (= WEIGHTING; see §3) only. Rear-view on hold. (Two inputs ⇒ thumb-native on mobile; see §7 Mobile.)
* Camera: v1 = ¾ chase cam (frontier curtain + recent history); selectable cameras (reverse cam, 2.5D side-on) post-v1.
* Overlays: off by default, toggleable, strictly causal.

## 1. The height field

For stock i with adjusted close P_i(t):

```
z_i(t) = c_i + log( P_i(t) / P_i(t_first,i) )
```

* Datum offsets c_i (required for deep history): c_i = the height of lane i's live neighborhood at its listing date (cap-weighted local median), constant per lane. With mixed listing dates, anchoring every lane at 0 would make each IPO a canyon floor ~its neighbors' accumulated return below them — a normalization artifact. A constant offset changes no slope anywhere, so P&L (= time-slope) is untouched; only the financially meaningless "free altitude" datum is repaired. Lanes alive at window start use c_i = 0.
* World scale: 1 day = 1 m, 1 lane = 1 m, h = k·z, k = 25 (tune in §6).
* Lateral lane structure: inner plateau (α = 0.5 of lane width, laterally flat — 100% of invested capital in that stock; finite width so "all-in" has finite measure); margins blend neighbors via smoothstep u = 3u_r²−2u_r³, h = k((1−u)z_i + u·z_{i+1}).
* Time interpolation: monotone cubic Hermite (PCHIP). Not Catmull-Rom — Catmull-Rom overshoots, which would create synthetic intraday prices outside the bracketing closes; monotone Hermite keeps every interpolated price between real consecutive closes while remaining C¹ for physics, and each day's slope still integrates exactly to the true close-to-close log return.
* Dispersion note: time-direction slopes are stationary (daily returns), but lateral gaps grow ~√t over decades; see §3 lateral-force saturation.

## 2. The portfolio identity (core invariant) + investability audit

2.1 State → portfolio. At every instant, with lateral blend u(s) and exposure w:

```
weights = ( w·(1−u), w·u, 1−w )  over  (lane i, lane i+1, cash);  Σ = 1, all ≥ 0
dlogW = [ w·((1−u)·r_i + u·r_{i+1}) + (1−w)·r_f ] dt
```

Score = logW ("earned altitude"), rendered as the skier's CARVE TRACK — the line cut into the snow is the path through the market, tinted by P&L. Altitude ≠ wealth: sideways motion is frictionless rebalancing; only the w-scaled time-component of climb is P&L. A pure-sideways path scores zero.

2.2 r_f = real 13-week T-bill (^IRX), trailing/causal, daily. Available from well before the window; eras like 2023–24 (r_f ≈ 5%) vs 2012–15 (r_f ≈ 0) make cash a genuinely different strategy across eras, historically faithfully.

2.3 Audited investable mappings (each mechanic ↔ a real action):

* Steering: rebalancing between two adjacent (correlated) stocks.
* Weighting dial / partial unweight: stock-cash mix; full UNWEIGHT (w→0) = sell to cash and float.
* Ghost-mode flight + landing anywhere: hold cash at r_f, then buy any stock at its current price. Re-entry is never blocked; the cost of sitting out is missed gains on the wealth ribbon, not a lockout. (An "anchoring" lockout was rejected for v1: behavioral bias, not markets.)
* Acquisition KICKER: lane ends as a high ledge built by the data's real premium; forced w→0 mid-air = receiving cash for shares.
* Bankruptcy CREVASSE: after the last trading day the dead plateau is a bottomless crevasse; margin depth log(1−w·u) below the live neighbor = the exact portfolio loss; death requires skiing in fully weighted (w = 1 on the dead plateau = 100% in the bankrupt name), finite-measure via plateau width + the w = 1 detent (§3). IPO gaps = crevasse fields (no terrain before listing).
* Involuntary gravity drift: changes your portfolio without intent — still a real portfolio at all times (forced trading, the invariant holds).
* Edge-grip limits (carve vs skid): physical only, no wealth effect; metaphor = you cannot rotate a portfolio instantly (liquidity).

2.4 Disclosed assumptions (the honest fine print): zero transaction costs, spreads, and taxes; continuous rebalancing; intra-day moves execute at synthetic prices that are bounded by the adjacent real closes (guaranteed by monotone interpolation); no borrow/leverage in v1. Transaction-cost drag = stretch goal. Respawn-at-checkpoint rewinds the world clock — a meta/game device, exempt from the invariant by design.

## 3. Physics: gravity IS market exposure (exposure = WEIGHTING)

Every terrain force is multiplied by w. One law covers everything. Ski vocabulary maps 1:1 onto the law — no equation changes from the bike draft; all §6 physics tests carry over.

* Grounded (w = 1): y constrained to h(s, τ(t)). Lateral slope force −g·h_s/(1+h_s²); normal force on moving terrain N = m(g + a_terrain); lateral grip (max steering force) ∝ N — Coulomb friction. Emergent, do not "fix": a crash is an AVALANCHE — the slope itself moves, N collapses, edges have nothing to bite, and you cannot steer out of a developing crash (skill = anticipation, as on real avalanche terrain); rallies press you down → max edge grip until the rise decelerates and the floor drops out (kicker pop unless you unweight via w); winners are ridges, losers valleys → holding a leader is an active balance, mean reversion is the passive pull.
* Lateral force saturation (deep-history necessity): lateral gaps grow ~√t; by the 2000s raw inter-neighborhood slopes are cliffs. The slope used by the force/grip model saturates at |h_s| ≤ tan θ_max (θ_max ≈ 35°, one justified constant). Terrain geometry stays true; only forces clamp. Long-range lateral relocation is meant to go through ghost mode — financially exact anyway (sell → cash → buy).
* Exposure scaling (0 < w < 1): g → w·g, a_terrain → w·a_terrain, grip ∝ N(w). This IS unweighting — the real ski technique of releasing edge pressure to float. Render: progressively lightened stance, float height ∝ (1−w). Steering presents as edge angle; grip ∝ N decides CARVE (controlled) vs SKID (forced drift when steering demand exceeds grip). Edge-chatter audio within ~20% of the grip limit — the player HEARS N collapsing before a crash takes control.
* Cash (w = 0): fully unweighted — the skier floats free of the mountain (no exposure, no gravity), free 3D drift, land on any lane any time; score ticks at r_f.
* Detent at w = 1: full exposure is a sticky snap-in state (deliberate input to leave) so the wipeout condition has finite measure in (s, w).
* Fixed timestep 120 Hz; t ≡ τ enforced as a constraint.

## 4. Causality rules (no future, anywhere)

1. Lane ordering: fit on each stock's earliest available trailing window (all eras pooled), computed once, never re-run (terrain shear). This uses later-era data for map LAYOUT only — and unborn lanes render identically to permanent void, so nothing observable leaks before each IPO. Documented as the single, invisible, prices-free exception.
2. Universe membership is point-in-time: trailing dollar-volume rank (EODHD) or Norgate Russell history / Sharadar daily caps. The back-adjusted-cap hack survives only in free-data dev mode (cap_now × P(then)/P(now); ignores share-count changes — document).
3. All rolling metrics trailing-only; no centered windows; no full-sample normalization (trailing z-scores only); warm-up before display.
4. Terrain color frozen at reveal time (day-d strip uses data ≤ d).
5. Terrain for day d exists iff d ≤ τ; skier pinned to τ ⇒ zero lookahead by construction.
6. r_f and ghost series computed day-by-day from data ≤ τ.
7. Delistings get no advance warning — a dying lane stops extruding under your wheels. Causal overlays may hint at distress; that is the realistic amount.

Acceptance test: plant a synthetic step change; assert no runtime-visible quantity (ordering aside per 4.1, colors, metrics, ghost, r_f) reflects it before its day.

## 5. Data sources

(EODHD $19.99/mo is the v1 decision; Norgate upgrade path; Sharadar middle option; CRSP if academic access; yfinance/Stooq = survivor dev mode only. See original plan for full ranked details, cross-source facts, and the LICENSE/redistribution caution: heightfield is reversible into prices, so public release needs license review. Personal/tailnet use is fine.)

Key facts: EODHD delisted via standard EOD API; pre-2018 delistings have EOD ONLY (validate split adjustment on old dead tickers — Phase 0). ~11k delisted US names, delistings covered since ~Jan 2000 ⇒ playable start ~2000, burn-in 1999. Universe ranked by TRAILING 63-DAY MEDIAN DOLLAR VOLUME. US Stock Symbol Rename History API for ticker recycling. SPY ghost from 1993 covers whole window. r_f from FRED DTB3 (fallback ^IRX). QC: overnight |r| > 60% → verify or sever; clip absurd ticks; cross-check yearly aggregates vs index; log every repair. Scale: ~7,800 days × ~8–12k union lanes (int16) ≈ 125–190 MB heightfield → mandatory tile streaming keyed to τ.

## 6. Pipeline + validation (gates before game code)

Pipeline (`pipeline/`): (1) universe (EODHD symbol lists + trailing 63d median dollar-volume rank); (2) prices via source adapter → canonical schema (permanent_id, date, close_adj [, OHLC], validity span, delisting date+type) → parquet; always also SPY + r_f; (3) QC (discontinuity severing, decade cross-checks, repair log, termination classification: terminal 30d return < −80% ⇒ bankruptcy, else acquisition); (4) ordering: pairwise-complete correlations on earliest trailing windows (≥60 overlap days; else seat next to most-correlated proxy); W = (1+ρ)/2, L = D−W, eigsh → v₂,v₃ → sort by atan2(v₃,v₂); optional local 2-opt, ship spectral-only if gain < 5%; (5) causal metrics (trailing 20d momentum, vol), ghost series, r_f; (6) export tiled heightfield (int16 z×1000, NaN sentinel; 64-day × 128-lane tiles), metrics tiles, manifest.

Validation (`analysis/`): (1) roughness benchmark R(π)/R(random) PER DECADE vs random/alphabetical/cap/sector/PCA/hierarchical+OLO/spectral/spectral+2opt — accept: spectral ≤ 0.5× alphabetical in every decade, beats sector-grouped overall, sectors emerge as contiguous arcs; (2) renders for human review, tune k and θ_max; (3) terrain tests on synthetic 3-lane fixture (one bankruptcy one acquisition): crater depth = k·log(1−w·u), C¹ continuity at plateau/margin boundaries and lane seam, datum-offset continuity at synthetic IPO, monotone-interpolation bound; (4) physics tests: N collapse under scripted crash, grip ∝ N, w = 0.5 halves coupling, detent, saturation at θ_max, wealth integral matches closed form (r_f-only path; pure-sideways scores exactly 0; held-lane reproduces the stock's return); (5) causality test (§4); spot-check 5 tickers vs independent fetches.

## 7. Game build (`game/`, Three.js)

* Terrain: snow-surfaced streamed tiles, frustum-culled, wraparound; void = skipped triangles (crevasses). Frontier: day-strips fall in as FRESH SNOWFALL at τ; beyond it, WHITEOUT; storm-edge curtain at t = τ. Blizzard intensity may track trailing (causal) volatility. Carve track persists behind the skier, tinted by P&L (this IS the wealth ribbon).
* Frontier slice (signature view): billboarded labels with distance LOD — nearest ~15 lanes: ticker + today's %; mid: ticker; far: sector-arc rim labels. SDF text (troika-three-text). HUD underfoot readout: ticker, company, sector, day's return, w, live portfolio value, gap to ghost.
* SPY ghost skier: hovers at its own altitude over the megacap arc, cutting its own faint track; beating its altitude with earned altitude = beating the market (exact log-wealth comparison).
* Overlays: trailing-momentum tint; + vol shimmer, neighbor-correlation hint — renderer reads precomputed causal metrics only.
* Era select: start at any month; clock speed options; deep eras display survivor-mode disclosure where applicable.
* Death/respawn: month-boundary checkpoints; respawn rewinds clock and wealth to checkpoint.
* Mobile & adaptive (first-class): LEFT thumb = lateral steering (horizontal drag, relative); RIGHT thumb = exposure dial (vertical drag, persistent slider), flick-down = full UNWEIGHT, tap-hold = re-land w→1. Tilt steering behind a setting (iOS permission from user gesture only). Touch targets ≥ 44×44 pt, gesture zones = whole thirds, env(safe-area-inset-*) padding, `touch-action: none` + `overscroll-behavior: none` + non-passive preventDefault + `position: fixed` 100dvh (never 100vh) + gesturestart prevented. Acceptance: monkey-drag every region on iOS Safari + Android Chrome — zero rubber-band/pull-to-refresh/back-swipe. Adaptive quality ladder via 3 s frame-time probe (pixelRatio 2/1.5/1.0, AA off mobile, tile radius + label count scale, no postprocessing mobile, dynamic res if frame > 20 ms); physics fixed 120 Hz regardless. powerPreference high-performance; dispose off-screen tiles; webglcontextlost handling; pause on visibilitychange; audio only from user gesture; landscape-primary + rotate prompt; PWA manifest. HUD small screens: ticker + day % + wealth + w; labels nearest ~6.
* Performance: 60 fps mid-range laptop; 60 fps recent flagship phone, ≥ 30 fps 3-year-old mid-range at low tier; load < 5 s desktop / < 8 s mobile.

## 8. Phases & gates

```
pipeline/   build_universe.py, download_prices.py, qc.py, ordering.py,
            metrics.py, ghost.py, export_tiles.py
analysis/   roughness_bench.py, renders.py, terrain_tests.py,
            physics_tests.py, causality_tests.py, report.md
game/       index.html, src/{terrain,stream,frontier,physics,exposure,
            hud,labels,ghost,main}.js
data/       (gitignored)
```

Phase 0 — EODHD acceptance tests (Enron/WorldCom/Lehman/Bear paths vs known history; split-adjustment spot-check on pre-2018 delisted splitter; delisted enumeration; year-2000 coverage counts). Gate: tests pass or escalate to Sharadar/Norgate. Phase 1 — pipeline on FULL range (download once, audit once). Gate: QC report incl. per-decade coverage + repair log; causality tests pass. Phase 2 — analysis. Gate: §6 criteria incl. per-decade roughness; human review. Phase 3 — game on most recent 2-year era only. Gate: §7 performance; death/launch/exposure demoed on synthetic fixture first. Phase 4 — deep eras unlocked behind Phase-1 audit; survivor-mode labeling in UI.

Stretch: tube render; polar galaxy-map flyover; leverage w > 1; behavioral hard mode; transaction-cost drag; CRSP migration.

Style rule: derive geometry and rules from the math. Every remaining magic number (k, α, θ_max, clock rate, D_kill, hover height, detent threshold) gets a one-line justification comment.

## Amendments

Amendment 1 (2026-06, user-decided; overrides §1 lateral lane structure). User spec, verbatim: "there should be no knife edge. You should be able to smoothly interpolate between two adjacent stocks. This is a portfolio mixture of the two. In reality you can hold many but for this dimension let's just say two. So in general display 2 tickers and your portfolio weighting unless you are on one exact track and then just show one."

* α = 0.5 → 0.08. The inner plateau becomes a thin "exact track" strip at each lane center: single-stock holding (and the HUD's single-ticker state) stays achievable with finite measure, but everywhere else the surface is a smooth two-stock smoothstep mixture — the margin now spans 92% of the inter-center distance. C¹ continuity at both plateau edges holds exactly as before (the smoothstep's endpoints still have zero derivative). HUD: show both tickers + the portfolio weighting whenever u ∉ {0, 1}; one ticker only on the exact track.
* Runtime lane width: CFG.LANE_M is settable at boot via `?lanew=` for tuning (default 4, clamped to ≥ 4 after the 2026-06 lane-width judging: w4 scored best and widths ≤ 2 retain near-vertical inter-lane walls). Heights are unchanged — only the lateral axis stretches — so lateral slopes h_s shrink by 1/LANE_M, which is the de-knifing mechanism (§3 force saturation still applies on top). Lane-space inputs (grounded steering authority/grip clamp, ghost-mode lateral thrust) scale by LANE_M so steering feels like lanes/sec, not meters/sec, at any width; the carve/skid ratio is width-invariant and grip ∝ N is preserved.
* Mesh sampling: with a 92% margin the old 3-samples-per-lane grid would facet; margins are now sampled at 6 segments each (≥ 5 floor; even count keeps the integer-s margin midpoint a shared vertex at tile seams) so the smoothstep reads as a curve.
* Tiles/pipeline unaffected: tiles store per-lane z, not blends; the blend lives entirely in game/src/terrain.js (and its mirrored Python reference in analysis/terrain_tests.py).
