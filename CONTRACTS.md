# Stock Universe Skier — Integration Contracts (v1)

Everything that crosses a module boundary is specified here. Agents own files; contracts own interfaces.
The build plan (user-provided, §-references) is the spec for *behavior*; this file is the spec for *interfaces*.
Magic numbers carry one-line justifications (style rule).

## 0. World constants (game/src/config.js — single owner)

```js
export const CFG = {
  DAY_M: 1,            // 1 trading day = 1 m along time axis (plan §1)
  LANE_M: 1,           // 1 lane = 1 m circumference (plan §1)
  K_HEIGHT: 25,        // h = K * z(log return); tune at aesthetics gate (plan §1/§6)
  ALPHA_PLATEAU: 0.5,  // inner flat fraction of lane width: "all-in" has finite measure (plan §1)
  THETA_MAX_DEG: 35,   // lateral force/grip slope saturation; geometry stays true (plan §3)
  PHYS_HZ: 120,        // fixed timestep accumulator; sim identical across devices (plan §3/§7)
  CLOCK_DPS: 2,        // default world-clock trading days/sec (plan §0)
  W_DETENT: 0.92,      // w >= this snaps to 1 (sticky full exposure, plan §3); leaving needs deliberate input
  TILE_DAYS: 64,       // tile time extent (plan §6.6)
  TILE_LANES: 128,     // tile lane extent (plan §6.6)
  Z_SCALE: 1000,       // int16 fixed-point: z stored as round(z*1000)
  Z_NAN: -32768,       // int16 sentinel: no terrain (pre-IPO / post-death void)
}
```

## 1. Canonical price schema (pipeline, parquet)

`data/parquet/<SYMBOL>.parquet` — one file per EODHD symbol (symbol incl. `.US` stripped):
columns `date` (ISO str), `open, high, low, close, adjusted_close` (float64), `volume` (int64).
Raw EODHD JSON cached at `data/raw/<SYMBOL>.json` (download once, audit once).

`data/universe.parquet`: `symbol, name, exchange, type, is_delisted (bool), first_date, last_date,
median_dollar_vol_63d_last (float), termination ('alive'|'bankruptcy'|'acquisition'|'unknown')`.
Termination rule (plan §6.3): terminal 30-trading-day return < −80% ⇒ bankruptcy; else acquisition.

`data/rf.parquet`: `date, rf_annual` (decimal, e.g. 0.052), from FRED DTB3 w/ ^IRX fallback; forward-filled
to trading days; **trailing only** (value for day d uses data ≤ d).

## 2. Tile + manifest format (pipeline → game; HTTP-served static files)

Era build output under `game/public/tiles/<era>/`:

- `manifest.json`:
```jsonc
{
  "era": "recent2y",
  "kHeight": 25,                  // K used implicitly by game; tiles store z, not h
  "tileDays": 64, "tileLanes": 128,
  "nDays": 520, "nLanes": 3072,   // nLanes padded to multiple of tileLanes
  "dates": ["2024-06-10", ...],   // length nDays, trading calendar (union)
  "lanes": [                      // length nLanes, CIRCULAR spectral order (index = lane id)
    { "sym": "AAPL", "name": "Apple Inc", "sector": "Technology",
      "c": 0.0,                   // datum offset c_i (plan §1)
      "born": 0, "dead": 519,     // day-index validity span inclusive; dead=-1 => alive at era end
      "term": "alive" }, ...
  ],
  "ghost": { "sym": "SPY", "z": [0.0, ...] },     // SPY cumulative log return per day (causal)
  "rf": [0.052, ...],                              // per-day annualized r_f (causal)
  "metrics": { "mom20": "tiles/<era>/mom20/", ... } // optional causal overlay tile dirs
}
```
- Tile obfuscation (`"enc": {"v": 1}` in manifest): deters literal copy-paste of the int16 grid out of a
  public deployment — NOT DRM (the AGPL decoder ships with the game; plan §5 license caution, user-accepted).
  Encoding, applied by `pipeline/obfuscate_tiles.py` per tile, decoded in `stream.js`:
  1. Lane shuffle: `perm` = Fisher-Yates of `[0..tileLanes)` driven by xorshift32 seeded
     `fnv1a("<era>:<T>:<L>:lane-shuffle")`; encoded column c holds plaintext column `perm[c]`.
  2. Keystream: every uint16 word XORed with successive `xorshift32(fnv1a("<era>:<T>:<L>:carve-not-copy"))`
     outputs (low 16 bits), applied after the shuffle. Seeds of 0 are replaced with 0x9E3779B9.
  Decoder order: XOR first, then unshuffle (`plain[r][perm[c]] = enc[r][c]`). Plain (`enc` absent) tiles
  remain supported — both formats are valid per this contract.
- `z/t<T>_l<L>.bin`: little-endian int16, row-major `[day][lane]`, `TILE_DAYS*TILE_LANES` entries.
  Day rows are tile-local: global day = T*TILE_DAYS + row; lane = L*TILE_LANES + col.
  Value = round(z_i(d)*1000) where z_i = c_i + log(P/P_first) (plan §1); Z_NAN where no terrain.
  Lane padding columns (beyond real lanes) are Z_NAN. **No file may contain days > era end; the game
  must additionally never REQUEST/render days > τ (plan §4.5).**

## 3. Game module ownership (game/src/)

| file | owns | exports (ES module) |
|---|---|---|
| config.js | constants above | `CFG` |
| stream.js | tile fetch+cache+eviction keyed to τ | `class TileStream { constructor(manifestUrl); load(); z(dayF, laneF): number|NaN /* PCHIP in t, raw per-lane in s */; zLane(lane, dayF): number|NaN; ensure(tau): void /* prefetch window */; manifest }` |
| terrain.js | height composition + meshes | `heightAt(s, dayF, stream): {h, dh_ds, dh_dt, lane, u}` implementing plateau/margin smoothstep (plan §1) on top of stream.zLane; builds/updates THREE meshes per tile; void = skipped triangles |
| physics.js | skier dynamics, PURE (no THREE) | `class Skier { step(dt, input, terrainFn, clock): State }` — input `{steer:-1..1, wTarget:0..1, jump?:bool}`; implements w-scaled gravity/N/grip/saturation/detent/avalanche (plan §3), portfolio identity dlogW (plan §2) incl. r_f; `State = {s, y, vs, vy, w, u, lane, grounded, logW, dead, deathCause}` |
| clock.js | world clock τ, pause, speed, checkpoints | `class WorldClock { tau, daysPerSec, pause(), resume(), setSpeed(), checkpoint(), rewind() }` |
| frontier.js | whiteout curtain, snowfall strip at τ | `class Frontier { update(tau) }` |
| labels.js | troika SDF ticker labels, LOD | `class Labels { update(tau, s) }` |
| hud.js | DOM HUD (ticker, day %, w, wealth, ghost gap) | `class Hud { update(state, info) }` |
| ghost.js | SPY ghost altitude + faint track | `class Ghost { update(tau) }` |
| input.js | keyboard + touch zones (plan §7 mobile) | `class Input { poll(): {steer, wTarget, jump} }` — keys: A/D or ←/→ steer; W/S or ↑/↓ exposure dial; SPACE slam w→0; E re-land w→1 |
| carve.js | carve track ribbon tinted by P&L | `class Carve { push(state) }` |
| main.js | composition root, render loop, fixed-step accumulator | — |
| debug.js | test API (below) | installs `window.__ski` |

Coordinates: **world z = -day** (so the skier moves in the -z direction as τ advances; history lies at
larger z behind them), `x = s` (lateral, wraps mod nLanes·LANE_M), `y = h`. Skier sits at `z = -τ·DAY_M`;
chase camera behind/above at `z = -τ·DAY_M + back`, looking down-slope toward the whiteout.

## 4. Debug/test API (Playwright contract) — window.__ski

```js
window.__ski = {
  ready,                        // boolean, true after first tiles + skier spawned
  version,                      // git-ish build string
  state(),                      // {tau, dateStr, s, lane, sym, u, w, grounded, dead, logW, wealth, ghostLogW, fps, pos:{x,y,z}}
  setInput({steer, wTarget}),   // overrides Input until clearInput()
  clearInput(),
  setSpeed(daysPerSec), pause(), resume(),
  spawn(lane, day),             // teleport+reset wealth (test only)
  runScript(steps),             // [{days, steer, wTarget}] -> Promise<finalState>, deterministic fixed-step
  manifestSummary(),            // {era, nDays, nLanes, dateRange}
}
```
Determinism requirement: with `setInput` fixed and same spawn, `runScript` must produce identical logW
across runs (fixed timestep, no Math.random in physics).

Automated runs MUST load with `?nointro=1` (skips the start-box overlay, which otherwise pauses the
world until a keypress; `navigator.webdriver` is not reliably set by MCP-driven browsers).
Playwright acceptance (analysis/playwright/): pure-sideways path scores 0; held-lane path reproduces the
stock's log return ±1e-6 (vs manifest-derived truth); w=0 path compounds at r_f; FPS ≥ 30 headless;
no network request for any tile with T*TILE_DAYS > τ_max reached (causality at network layer).

## 5. Pipeline CLI contracts (pipeline/, run with .venv python)

All scripts: `--era recent2y|full --data-dir data/ --out game/public/tiles/` + `--config pipeline/eras.json`.
`eras.json` defines `{name, start, end, burnin_start, top_n}`; `recent2y` = top 3000 by trailing 63d median
dollar volume, last 2y + 63d burn-in. Secrets via env `EODHD_API_TOKEN` (read from .env, never committed).
`download_prices.py`: resumable (skips existing raw JSON), `--rps 8` rate limit, writes parquet per §1.
Exit nonzero on gate failure; print machine-readable summary line `GATE {json}` last.

## 6. Ports / serving (this host)

- Vite dev: 5173 (free). Published static build: **8090** via `python -m http.server` or caddy on
  100.87.13.37 (Tailscale). Ports 2718/3000/4369/5432/7391/7777/8123/8790 are TAKEN — never bind them.
