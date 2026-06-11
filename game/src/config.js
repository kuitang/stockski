// World constants — CONTRACTS §0 verbatim (single source of truth for magic numbers).

// LANE_M is runtime-settable at boot via ?lanew= for tuning (lane-width experiment, PLAN
// Amendments): heights are UNCHANGED, only the lateral axis stretches, so lateral slopes h_s
// shrink by 1/LANE_M — the de-knifing mechanism.
// Guarded for non-browser contexts (vitest/node have no `location`): tests see the default.
const LANE_M_DEFAULT = 4; // 1 lane = 4 m: lane-width judging verdict (2026-06) — w4 scored best
                          // (medians w2=5, w4=7.5, w8=6); the de-knifed surface must be the default
const LANE_M_MIN = 4;     // widths < 4 retired by the same verdict: at LANE_M=2 a dz≈2 neighbor gap
                          // still renders ~88° inter-lane walls (smoothstep removes the crease, not the cliff)
const laneWParam =
  typeof location !== 'undefined'
    ? parseFloat(new URLSearchParams(location.search).get('lanew'))
    : NaN;

export const CFG = {
  DAY_M: 1,            // 1 trading day = 1 m along time axis (plan §1)
  LANE_M: Number.isFinite(laneWParam) && laneWParam > 0 ? Math.max(laneWParam, LANE_M_MIN) : LANE_M_DEFAULT,
  K_HEIGHT: 25,        // h = K * z(log return); tune at aesthetics gate (plan §1/§6)
  ALPHA_PLATEAU: 0.08, // inner "exact track" strip at each lane center: thin enough that almost the
                       // whole surface is a smooth two-stock mixture (user spec: no knife edge), wide
                       // enough that single-stock holding / the HUD single-ticker state stays reachable
  THETA_MAX_DEG: 35,   // lateral force/grip slope saturation; geometry stays true (plan §3)
  PHYS_HZ: 120,        // fixed timestep accumulator; sim identical across devices (plan §3/§7)
  CLOCK_DPS: 2,        // default world-clock trading days/sec (plan §0)
  W_DETENT: 0.92,      // w >= this snaps to 1 (sticky full exposure, plan §3); leaving needs deliberate input
  TILE_DAYS: 64,       // tile time extent (plan §6.6)
  TILE_LANES: 128,     // tile lane extent (plan §6.6)
  Z_SCALE: 1000,       // int16 fixed-point: z stored as round(z*1000)
  Z_NAN: -32768,       // int16 sentinel: no terrain (pre-IPO / post-death void)
  // ¾ chase camera (plan §0), retuned per judge round 1: tighter + pitched further down so the
  // skier reads (was a speck) and the frontier strip owns the lower-middle frame (was 60% empty sky)
  CAM: {
    FOV: 62,     // vertical FOV deg, up from 60: a touch more speed-stretch; ≤70 avoids fisheye
    BACK: 12,    // m behind the skier (was 16): skier ~35% larger in frame; still < PREFETCH_DAYS=40
    UP: 18,      // m above (was 16, judge r2): higher vantage lifts the terrain skyline up the frame
    SIDE: 4,     // m lateral offset = the "¾" in ¾ chase cam; small vs BACK/UP so it flavors, not skews
    AHEAD: 14,   // look-at this many m past the skier into the whiteout: frontier-centered framing
    DROP: 22,    // look-at m below skier (was 15; judge r2: calm frame was ~55% dead sky): pitch ≈ 58° —
                 // frontier strip + lane labels own ~2/3 of frame, the void mood band the top third
    DAMP: 0.0008, // per-second residual of camera lag (lerp): lateral carving reads smooth, never rigid
  },
  W_MAX: 2,            // leverage hard cap = Reg-T initial margin (50% ⇒ max 2x buying power); at w=2 the
                       // crater log(1−w·u) hits −∞ already at u=0.5 — margin-call territory (plan stretch → v1)
}
