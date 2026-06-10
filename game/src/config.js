// World constants — CONTRACTS §0 verbatim (single source of truth for magic numbers).
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
