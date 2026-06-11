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
//     laneZ?(lane, dayF)   -> z        // OPTIONAL cumulative log-return level (held flat across
//                                      // tile-fetch gaps); when present, wealth accrues from exact
//                                      // z DIFFERENCES so the per-step sum telescopes — no daily
//                                      // return is ever dropped at 64-day tile boundaries
//     laneTerm?(lane)      -> {term, dead} | null  // OPTIONAL manifest termination info for the
//                                      // acquisition kicker (plan §2.3); dead = last day index
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
  BORROW_SPREAD: 0.015, // annual spread over r_f on the borrowed (1−w)<0 leg when w>1: brokers don't lend
                        // at the T-bill rate — ~150 bp is the cheap end of retail margin over benchmark
};

// Detent band is symmetric about w=1 (plan §3 + leverage ext): crossing into [W_DETENT, 2−W_DETENT]
// from either side latches w=1; pushing past 1 needs deliberate input exactly like dropping below.
const W_DETENT_HI = 2 - CFG.W_DETENT; // mirror of CFG.W_DETENT above 1 (0.92 → 1.08)

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
    this.w = clamp(w0, 0, CFG.W_MAX); // [0, 2]: w>1 borrows the (1−w)<0 leg at r_f + spread (plan §2 ext)
    // spawning inside the detent band counts as snapped — w=1 is the sticky state (plan §3)
    this._snapped = this.w > CFG.W_DETENT && this.w < W_DETENT_HI;
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
    this._zEnd = null; // end-of-step laneZ cache: telescoping wealth sum (see _stockReturn)
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
   * @param input  { steer: -1..1, wTarget: 0..CFG.W_MAX }
   * @returns state snapshot (CONTRACTS §3 State + probe internals)
   */
  step(dtSec, input = {}) {
    if (this.dead) return this._state();
    const steer = clamp(input.steer ?? 0, -1, 1);
    const dps = this.world.daysPerSec;
    const dday = dps * dtSec;

    // terrain at the start-of-step instant (left endpoint of this slice of time)
    const q = this.world.heightAt(this.s, this.day);
    if (q) { this.lane = q.lane; this.u = q.u; }

    // Acquisition KICKER (plan §2.3): the dominant holding's lane ended as a high ledge —
    // shareholders are cashed out at the final (premium) price: forced w→0 mid-air,
    // never a loss. The wealth integral below then ticks at r_f, exactly "cash for shares".
    if (!q && this.w > 0 && this._acquiredOut()) {
      this.w = 0;
      this._snapped = false;
    }

    // over void there is nothing to BUY: wTarget can hold or reduce exposure but not raise it
    // (you cannot buy a delisted name — nor lever further into one; bankruptcy death still
    // requires RIDING IN fully weighted with the detent latched, plan §2.3 — that path is untouched)
    let wTarget = clamp(input.wTarget ?? this.w, 0, CFG.W_MAX);
    if (!q) wTarget = Math.min(wTarget, this.w);
    this._dial(wTarget, dtSec);

    // MARGIN CALL (plan §2 ext, leverage): with w·u_dead ≥ 1 on a dead leg the effective loss
    // log(1 − w·u_dead) is −∞ — equity is wiped before the crater bottoms out, so the broker
    // liquidates instantly: total loss even at u < 1. At w = 2 the death region invades the
    // margin to u = 0.5 exactly. Only reachable when w > 1 (at w ≤ 1, w·u ≥ 1 means w = 1 on
    // the dead plateau — that stays the cinematic crevasse fall below, same total loss).
    if (this.w > 1 && this.w * this._voidExposure(q) >= 1) {
      this._die('margin-call');
      return this._state();
    }

    // --- WEALTH: the invariant (plan §2.1). Sideways motion changes nothing except u. ---
    // w > 1 prices the borrow on the (1−w) < 0 leg at r_f + BORROW_SPREAD (you PAY the spread);
    // w ≤ 1 lends the (1−w) ≥ 0 leg at the plain T-bill rate — the formula is otherwise unchanged.
    const rfLeg = this.world.rfAnnual(this.day) + (this.w > 1 ? PHYS.BORROW_SPREAD : 0);
    const rfDaily = rfLeg / PHYS.TRADING_DAYS;
    this.logW += this._stockReturn(dday) + (1 - this.w) * rfDaily * dday;

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

  // w moves toward wTarget at DIAL_RATE; detent at 1 with hysteresis BOTH directions (plan §3 + leverage):
  // pushing past 1 into leverage needs deliberate input, dropping below 1 likewise. No detent at
  // W_MAX = 2 — that is a hard cap, not a sticky state.
  _dial(wTarget, dt) {
    if (this._snapped) {
      const below = wTarget < CFG.W_DETENT - PHYS.DETENT_RELEASE; // deliberate pull under the band
      const above = wTarget > W_DETENT_HI + PHYS.DETENT_RELEASE;  // deliberate push into leverage
      if (below || above) {
        this._snapped = false; // unlatch and let the dial run past 1
      } else {
        this.w = 1;
        return;
      }
    }
    const prev = this.w;
    const maxStep = PHYS.DIAL_RATE * dt;
    const dw = clamp(wTarget - this.w, -maxStep, maxStep);
    this.w += dw;
    // detent engages only when CROSSING into the band toward 1 from outside — continuing the
    // dial away from 1 after a deliberate unlatch must not re-latch mid-band
    const upIn = dw > 0 && prev <= CFG.W_DETENT && this.w > CFG.W_DETENT;  // from below
    const downIn = dw < 0 && prev >= W_DETENT_HI && this.w < W_DETENT_HI;  // from above (leverage)
    if (upIn || downIn) {
      this.w = 1; // sticky full exposure: finite-measure wipeout condition (plan §3)
      this._snapped = true;
    }
  }

  /** Fraction of the current blend pair that sits on LOSS-bearing void terrain — the u_dead in the
   *  margin-call rule w·u_dead ≥ 1. Wholly on a dead plateau (q = null) ⇒ 1 (the acquisition case
   *  was already cashed out by the kicker before this runs). Acquisition-terminated legs are
   *  excluded in the margin too: shareholders got cash at the final price, never a loss (plan §2.3).
   *  Prefers laneZ (finite ⇒ live, matches the wealth path); falls back to laneRate for mock worlds. */
  _voidExposure(q) {
    if (!q) return 1;
    const vI = this._laneVoid(this.lane) && !this._isAcquired(this.lane);
    const vJ = this._laneVoid(this.lane + 1) && !this._isAcquired(this.lane + 1);
    return (vI ? 1 - q.u : 0) + (vJ ? q.u : 0);
  }

  _isAcquired(lane) {
    const info = this.world.laneTerm?.(lane);
    return !!info && info.term === 'acquisition';
  }

  _laneVoid(lane) {
    const w = this.world;
    if (typeof w.laneZ === 'function') return !Number.isFinite(w.laneZ(lane, this.day));
    return !Number.isFinite(w.laneRate(lane, this.day));
  }

  /** True when the lane carrying the skier's dominant weight ended by ACQUISITION and the
   *  clock is past its last trading day — the ledge case, never a crevasse (plan §2.3). */
  _acquiredOut() {
    const hold = this.u >= 0.5 ? this.lane + 1 : this.lane; // dominant holding of the blend pair
    const info = this.world.laneTerm?.(hold);
    return !!info && info.term === 'acquisition' && info.dead >= 0 && this.day > info.dead;
  }

  /** w-weighted stock log-return over [day, day+dday] (plan §2.1).
   *  Prefers exact close-to-close z DIFFERENCES (world.laneZ): the per-step sum telescopes to
   *  z(end)−z(start) on a held lane, so the wealth identity survives tile-fetch latency at
   *  64-day tile boundaries — a frontier-held (stale) z contributes 0 until the tile lands,
   *  then the whole catch-up arrives in one step, independent of fetch timing.
   *  Falls back to laneRate·dday for analytic mock worlds without laneZ. */
  _stockReturn(dday) {
    if (this.w === 0) { this._zEnd = null; return 0; } // cash: no stock term, restart cache on re-land
    const { world } = this;
    if (typeof world.laneZ !== 'function') {
      const rI = nz(world.laneRate(this.lane, this.day));
      const rJ = nz(world.laneRate(this.lane + 1, this.day));
      return this.w * ((1 - this.u) * rI + this.u * rJ) * dday;
    }
    const d1 = this.day + dday;
    // start-of-step z: reuse last step's END values when the lane pair is unchanged, so a tile
    // landing BETWEEN two steps cannot drop its return into the crack between evaluations
    const c = this._zEnd && this._zEnd.lane === this.lane ? this._zEnd : null;
    const zi0 = c ? c.zi : world.laneZ(this.lane, this.day);
    const zj0 = c ? c.zj : world.laneZ(this.lane + 1, this.day);
    const zi1 = world.laneZ(this.lane, d1);
    const zj1 = world.laneZ(this.lane + 1, d1);
    this._zEnd = { lane: this.lane, zi: zi1, zj: zj1 };
    // void/halted endpoint: a dead name contributes 0 to the integral (loss lands via death, plan §3)
    const dI = Number.isFinite(zi0) && Number.isFinite(zi1) ? zi1 - zi0 : 0;
    const dJ = Number.isFinite(zj0) && Number.isFinite(zj1) ? zj1 - zj0 : 0;
    return this.w * ((1 - this.u) * dI + this.u * dJ);
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
    // steering is a LANE-space command (PLAN Amendments: ?lanew= experiment): with wider lanes the
    // same input must cover proportionally more meters, so both the edge's lateral hold and the
    // player's demand scale by LANE_M — steering feels like lanes/sec at any lane width, the
    // carve/skid ratio (demand/grip) is width-invariant, and grip ∝ N is preserved (constant factor)
    this.grip = PHYS.MU_EDGE * this.N * CFG.LANE_M;
    // steering demand is what the edge asks at nominal full weight; actual N decides what it gets
    const demand = steer * PHYS.MU_EDGE * PHYS.MASS * PHYS.G * CFG.LANE_M;
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
    // ×LANE_M: ghost-mode repositioning is a lane-space action — keeps AIR_THRUST's
    // "crosses a lane in <1 s" true at any ?lanew= (PLAN Amendments)
    this.vs += steer * PHYS.AIR_THRUST * CFG.LANE_M * dt;
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
