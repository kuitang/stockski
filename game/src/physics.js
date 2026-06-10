// physics.js — skier dynamics + portfolio identity (PLAN §2/§3, CONTRACTS §3).
// PURE ES module: no three.js, no DOM, no Math.random, no Date.now.
// Deterministic: state is a pure function of (world, initial conditions, input sequence).
//
// World interface (provided by terrain/stream composition, mocked in tests):
//   {
//     heightAt(s, dayF) -> { h,        // terrain height (m) at lateral s, fractional day dayF
//                            dh_ds,    // ∂h/∂s (m per m, TRUE geometry — never saturated here)
//                            dh_dt,    // ∂h/∂day (m per trading day)
//                            lane,     // integer lane id under s
//                            u }       // lateral blend 0..1 toward lane+1 (plan §1 smoothstep)
//                        | null        // void: no terrain (pre-IPO gap / post-death plateau end)
//     laneRate(lane, dayF) -> dz/dday  // log-return per trading day for that lane; NaN if void
//     rfAnnual(dayF)       -> r_f      // annualized risk-free rate (decimal), causal (plan §2.2)
//     daysPerSec           -> number   // world-clock speed (trading days per real second)
//   }

import { CFG } from './config.js';

// --- physical constants (each magic number justified, PLAN style rule) ---
export const PHYS = {
  G: 9.81,            // standard gravity m/s²; the one true coupling that w scales (plan §3)
  MASS: 1,            // unit mass: forces are per-kg accelerations, N reads directly in g-units
  MU_EDGE: 1.2,       // edge friction coefficient: ~1.2 g max lateral hold at full weight, real slalom-carve range
  DIAL_RATE: 2.0,     // w units/sec: full 0→1 rotation in 0.5 s ≈ one trading day at default clock — liquidity, not teleport (plan §2.3)
  DETENT_RELEASE: 0.1,// hysteresis width below W_DETENT to unlatch w=1: leaving full exposure needs deliberate input (plan §3)
  D_KILL: 50,         // m below live-neighbor floor = dead: ~ -86% at k=25, unrecoverable yet reads instantly (plan §3)
  GROUND_DRAG: 0.4,   // 1/s snow-glide drag: lateral speed halves in ~1.7 s so valleys don't ring forever
  FLIGHT_DRAG: 0.5,   // 1/s ghost-mode damping: drift halves in ~1.4 s — gentle, keeps w=0 flight controllable
  AIR_THRUST: 6,      // m/s² lateral thrust at w=0: cash repositioning is financially free (sell→cash→buy), crosses a lane in <1 s
  SINK_RATE: 2,       // m/s terminal sink per unit w on a void lane: slow enough to read the halt and dial w→0 (plan §3: death REQUIRES w=1)
  NEIGHBOR_PROBE: 8,  // lanes scanned each side for the live-neighbor floor: beyond 8 lanes a void reads as open field, not a crevasse wall
  TRADING_DAYS: 252,  // trading days per year: converts annualized r_f to per-trading-day rate (plan §2)
};

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
// void lane carries no trading: a halted name contributes 0 to the integral (loss lands via death, plan §3)
const nz = (r) => (Number.isFinite(r) ? r : 0);

export class Skier {
  /**
   * @param world  see interface above
   * @param opts   { s0, day0, w0? }  (w0 optional, defaults to 1: spawn fully weighted on snow)
   */
  constructor(world, { s0 = 0, day0 = 0, w0 = 1 } = {}) {
    this.world = world;
    this.s = s0;
    this.day = day0;
    this.w = clamp(w0, 0, 1);
    // spawning above the detent counts as snapped — w=1 is the sticky state (plan §3)
    this._snapped = this.w > CFG.W_DETENT;
    if (this._snapped) this.w = 1;
    this.vs = 0;
    this.vy = 0;
    this.logW = 0;
    this.dead = false;
    this.deathCause = null;
    this.skidding = false;
    this.N = 0;
    this.grip = 0;
    this.slopeForce = 0;
    this.steerForce = 0;
    const q = world.heightAt(s0, day0);
    if (q) {
      this.y = q.h;
      this.lane = q.lane;
      this.u = q.u;
      this.grounded = this.w > 0;
      // seed the finite-difference path velocity: at rest, only the terrain moves under us
      this._vHPrev = q.dh_dt * world.daysPerSec;
    } else {
      this.y = 0;
      this.lane = Math.floor(s0 / CFG.LANE_M);
      this.u = 0;
      this.grounded = false;
      this._vHPrev = 0;
    }
  }

  /**
   * Advance one fixed timestep.
   * @param dtSec  seconds (caller uses 1/CFG.PHYS_HZ)
   * @param input  { steer: -1..1, wTarget: 0..1 }
   * @returns state snapshot (CONTRACTS §3 State + probe internals)
   */
  step(dtSec, input = {}) {
    if (this.dead) return this._state();
    const steer = clamp(input.steer ?? 0, -1, 1);
    const wTarget = clamp(input.wTarget ?? this.w, 0, 1);
    const dps = this.world.daysPerSec;
    const dday = dps * dtSec;

    this._dial(wTarget, dtSec);

    // terrain at the start-of-step instant (left endpoint of this slice of time)
    const q = this.world.heightAt(this.s, this.day);
    if (q) { this.lane = q.lane; this.u = q.u; }

    // --- WEALTH: the invariant (plan §2.1). Sideways motion changes nothing except u. ---
    const rI = nz(this.world.laneRate(this.lane, this.day));
    const rJ = nz(this.world.laneRate(this.lane + 1, this.day));
    const rfDaily = this.world.rfAnnual(this.day) / PHYS.TRADING_DAYS;
    this.logW +=
      (this.w * ((1 - this.u) * rI + this.u * rJ) + (1 - this.w) * rfDaily) * dday;

    // world clock advances; the skier is pinned to the frontier (plan §0)
    this.day += dday;

    // reset per-step probes
    this.skidding = false;
    this.N = 0;
    this.grip = 0;
    this.slopeForce = 0;
    this.steerForce = 0;

    if (q && this.w > 0) this._stepGrounded(q, steer, dtSec, dps);
    else if (!q && this.w === 1) this._stepCrevasse(dtSec);
    else if (!q && this.w > 0) this._stepFloat(dtSec);
    else this._stepFlight(steer, dtSec);

    return this._state();
  }

  // w moves toward wTarget at DIAL_RATE; detent at 1 with hysteresis (plan §2.3/§3)
  _dial(wTarget, dt) {
    if (this._snapped) {
      if (wTarget < CFG.W_DETENT - PHYS.DETENT_RELEASE) {
        this._snapped = false; // deliberate input: unlatch and let the dial run below
      } else {
        this.w = 1;
        return;
      }
    }
    const maxStep = PHYS.DIAL_RATE * dt;
    const dw = clamp(wTarget - this.w, -maxStep, maxStep);
    this.w += dw;
    // detent engages only when pushing UP into it — dialing down through the band must not re-latch
    if (dw > 0 && this.w > CFG.W_DETENT) {
      this.w = 1; // sticky full exposure: finite-measure wipeout condition (plan §3)
      this._snapped = true;
    }
  }

  // Grounded: y = h constraint, every terrain force scaled by w (plan §3)
  _stepGrounded(q, steer, dt, dps) {
    const tanMax = Math.tan((CFG.THETA_MAX_DEG * Math.PI) / 180);
    // forces clamp, geometry doesn't (plan §3 saturation)
    const hsSat = clamp(q.dh_ds, -tanMax, tanMax);
    this.slopeForce = (-PHYS.MASS * this.w * PHYS.G * hsSat) / (1 + hsSat * hsSat);

    // constraint's vertical velocity along the path uses TRUE geometry
    const vH = q.dh_ds * this.vs + q.dh_dt * dps;
    const aTerrain = (vH - this._vHPrev) / dt; // finite-difference d²h/dt² along the path
    this._vHPrev = vH;

    // N = m(g·w + w·a_terrain); collapse → avalanche emerges, no special case (plan §3)
    this.N = Math.max(0, PHYS.MASS * this.w * (PHYS.G + aTerrain));
    this.grip = PHYS.MU_EDGE * this.N;
    // steering demand is what the edge asks at nominal full weight; actual N decides what it gets
    const demand = steer * PHYS.MU_EDGE * PHYS.MASS * PHYS.G;
    this.skidding = Math.abs(demand) > this.grip; // demand beyond grip => skid, excess ignored
    this.steerForce = clamp(demand, -this.grip, this.grip);

    const aS = (this.slopeForce + this.steerForce) / PHYS.MASS;
    this.vs += aS * dt;
    this.vs *= Math.exp(-PHYS.GROUND_DRAG * dt);
    this.s += this.vs * dt;

    const q1 = this.world.heightAt(this.s, this.day);
    if (q1) {
      this.y = q1.h; // constraint: ride the surface
      this.vy = q1.dh_ds * this.vs + q1.dh_dt * dps;
      this.lane = q1.lane;
      this.u = q1.u;
      this.grounded = true;
    } else {
      this.grounded = false; // skied off an edge; void handling next step
    }
  }

  // w snapped at 1 on a void lane: 100% in a dead name — fall into the crevasse (plan §2.3/§3)
  _stepCrevasse(dt) {
    this.grounded = false;
    this.vy -= PHYS.G * this.w * dt; // w = 1: full gravity, y integrates down
    this.y += this.vy * dt;
    this.vs *= Math.exp(-PHYS.FLIGHT_DRAG * dt);
    this.s += this.vs * dt;
    const floor = this._neighborFloor();
    if (floor === null) this._die('void'); // w=1 on void with nothing to measure against
    else if (this.y < floor - PHYS.D_KILL) this._die('crevasse');
  }

  // 0 < w < 1 on void: the cash fraction floats you — slow sink, recoverable via w→0 (plan §3)
  _stepFloat(dt) {
    this.grounded = false;
    this.vy = -PHYS.SINK_RATE * this.w; // terminal sink ∝ exposure to the halted name
    this.y += this.vy * dt;
    this.vs *= Math.exp(-PHYS.FLIGHT_DRAG * dt);
    this.s += this.vs * dt;
  }

  // w = 0: zero exposure = zero terrain coupling — gravity off, free drift at r_f (plan §3)
  _stepFlight(steer, dt) {
    this.grounded = false;
    this.vs += steer * PHYS.AIR_THRUST * dt;
    this.vs *= Math.exp(-PHYS.FLIGHT_DRAG * dt);
    this.vy *= Math.exp(-PHYS.FLIGHT_DRAG * dt);
    this.s += this.vs * dt;
    this.y += this.vy * dt;
    // track the lane below so re-weighting (landing) buys the right name
    const q1 = this.world.heightAt(this.s, this.day);
    if (q1) {
      this.lane = q1.lane;
      this.u = q1.u;
    }
  }

  _neighborFloor() {
    // nearest live terrain within probe radius; both sides at same distance → higher wall wins
    for (let d = 1; d <= PHYS.NEIGHBOR_PROBE; d++) {
      const qa = this.world.heightAt(this.s + d * CFG.LANE_M, this.day);
      const qb = this.world.heightAt(this.s - d * CFG.LANE_M, this.day);
      if (qa && qb) return Math.max(qa.h, qb.h);
      if (qa) return qa.h;
      if (qb) return qb.h;
    }
    return null;
  }

  _die(cause) {
    this.dead = true;
    this.deathCause = cause;
    this.logW = -Infinity; // wealth LOST: log(1 - w_eff_lost) with full weight on a zero (plan §2.3)
  }

  _state() {
    return {
      s: this.s,
      y: this.y,
      vs: this.vs,
      vy: this.vy,
      w: this.w,
      u: this.u,
      lane: this.lane,
      grounded: this.grounded,
      logW: this.logW,
      dead: this.dead,
      deathCause: this.deathCause,
      // probe internals (plan §6.4 physics tests)
      day: this.day,
      skidding: this.skidding,
      N: this.N,
      grip: this.grip,
      slopeForce: this.slopeForce,
      steerForce: this.steerForce,
    };
  }
}
