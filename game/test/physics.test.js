// physics.test.js — analytic mock-world tests for skier dynamics + portfolio identity.
// Each test cites the plan section it verifies (PLAN §6.4).
import { describe, it, expect } from 'vitest';
import { Skier, PHYS } from '../src/physics.js';
import { CFG } from '../src/config.js';
import { dialStep, expoFromDrag, detentGate, DETENT_HOLD_MS } from '../src/input.js';
import { exposureLevel, fmtW, MC_PROX } from '../src/hud.js';

const DT = 1 / CFG.PHYS_HZ; // fixed 120 Hz timestep (plan §3)
const DPS = CFG.CLOCK_DPS;  // 2 trading days / sec (plan §0)

/**
 * Analytic mock world: closed-form h(s, day) and per-lane rates.
 * Lanes are 1 m wide (CFG.LANE_M); u = 0 everywhere (plateau) unless overridden.
 */
function makeWorld({ h = () => 0, rate = () => 0, rf = 0, voidLanes = [] } = {}) {
  const dead = new Set(voidLanes);
  const eps = 1e-5; // central-difference step: exact for the linear/quadratic closed forms used here
  return {
    daysPerSec: DPS,
    rfAnnual: () => rf,
    laneRate: (lane, dayF) => (dead.has(lane) ? NaN : rate(lane, dayF)),
    heightAt(s, dayF) {
      const lane = Math.floor(s / CFG.LANE_M);
      if (dead.has(lane)) return null;
      return {
        h: h(s, dayF),
        dh_ds: (h(s + eps, dayF) - h(s - eps, dayF)) / (2 * eps),
        dh_dt: (h(s, dayF + eps) - h(s, dayF - eps)) / (2 * eps),
        lane,
        u: 0,
      };
    },
  };
}

const stepsForDays = (D) => Math.round(D / (DPS * DT));

describe('portfolio identity (PLAN §2.1)', () => {
  it('§2.1: pure-sideways path scores exactly zero — altitude is not wealth', () => {
    // bumpy static terrain, zero rates, zero r_f: climbing laterally must earn nothing
    const world = makeWorld({ h: (s) => 2 * Math.sin(s), rate: () => 0, rf: 0 });
    const sk = new Skier(world, { s0: 0.5, day0: 0, w0: 1 });
    const n = stepsForDays(5);
    let st;
    for (let i = 0; i < n; i++) {
      st = sk.step(DT, { steer: i < n / 2 ? 1 : -1, wTarget: 1 });
    }
    expect(st.s).not.toBe(0.5); // motion actually happened
    expect(Math.abs(st.logW)).toBeLessThan(1e-12);
  });

  it('§2.1/§6.4: held lane for D days reproduces exactly the sum of that lane\'s daily rates', () => {
    const R = 0.001; // log-return per trading day for the held lane
    const world = makeWorld({
      h: () => 0,
      rate: (lane) => (lane === 3 ? R : 0.05), // neighbors differ: any blend leakage would show
      rf: 0.1, // nonzero r_f: must not leak in at w = 1
    });
    const D = 10;
    const sk = new Skier(world, { s0: 3.5, day0: 0, w0: 1 }); // plateau center of lane 3
    let st;
    for (let i = 0; i < stepsForDays(D); i++) st = sk.step(DT, { steer: 0, wTarget: 1 });
    expect(st.lane).toBe(3);
    expect(Math.abs(st.logW - D * R)).toBeLessThan(1e-9);
  });

  it('§2.2/§3: w = 0 for D days compounds at r_f exactly — cash floats free at the bill rate', () => {
    const RF = 0.063; // annualized; daily = RF/252
    const world = makeWorld({ h: () => 0, rate: () => 0.02, rf: RF });
    const D = 10;
    const sk = new Skier(world, { s0: 1.5, day0: 0, w0: 0 });
    let st;
    for (let i = 0; i < stepsForDays(D); i++) st = sk.step(DT, { steer: 0, wTarget: 0 });
    expect(st.grounded).toBe(false); // zero exposure = zero terrain coupling
    expect(Math.abs(st.logW - (D * RF) / PHYS.TRADING_DAYS)).toBeLessThan(1e-12);
  });
});

describe('exposure scaling and forces (PLAN §3)', () => {
  it('§3: w = 0.5 halves both the slope force and N versus w = 1', () => {
    const world = makeWorld({ h: (s) => 0.3 * s }); // constant lateral slope, below saturation
    const full = new Skier(world, { s0: 0.5, day0: 0, w0: 1 });
    const half = new Skier(world, { s0: 0.5, day0: 0, w0: 0.5 });
    const a = full.step(DT, { steer: 0, wTarget: 1 });
    const b = half.step(DT, { steer: 0, wTarget: 0.5 });
    expect(b.slopeForce).toBeCloseTo(0.5 * a.slopeForce, 12);
    expect(b.N).toBeCloseTo(0.5 * a.N, 12);
    expect(a.N).toBeGreaterThan(0);
  });

  it('§3: lateral slope beyond tan(35°) clamps the force to the 35° value — forces clamp, geometry doesn\'t', () => {
    const tanMax = Math.tan((CFG.THETA_MAX_DEG * Math.PI) / 180);
    const atLimit = new Skier(makeWorld({ h: (s) => tanMax * s }), { s0: 0.5, w0: 1 });
    const cliff = new Skier(makeWorld({ h: (s) => 5 * s }), { s0: 0.5, w0: 1 }); // ~78° raw
    const a = atLimit.step(DT, { steer: 0, wTarget: 1 });
    const b = cliff.step(DT, { steer: 0, wTarget: 1 });
    expect(b.slopeForce).toBeCloseTo(a.slopeForce, 12);
    expect(Math.abs(b.slopeForce)).toBeGreaterThan(0);
  });

  it('§3/§6.4: N collapse — scripted crash drives N to 0 and steering authority to 0 (avalanche emerges)', () => {
    // h falls quadratically in time: a_terrain = -2B·dps² = -16 m/s² < -g, so N must hit 0
    const B = 2; // m/day²: chosen so 2·B·dps² = 16 > g — the floor drops faster than gravity can follow
    const world = makeWorld({ h: (s, day) => -B * day * day });
    const sk = new Skier(world, { s0: 0.5, day0: 0, w0: 1 });
    let st;
    for (let i = 0; i < 4; i++) st = sk.step(DT, { steer: 1, wTarget: 1 }); // finite-diff needs 2 steps to see d²h/dt²
    expect(st.N).toBe(0);
    expect(st.grip).toBe(0);
    expect(st.steerForce).toBe(0); // no normal force, edges have nothing to bite
    expect(st.skidding).toBe(true); // full steer demanded, zero granted
  });

  it('§3: skid flag when steering demand exceeds grip; full weight on flat carves cleanly', () => {
    const world = makeWorld({ h: () => 0 });
    const half = new Skier(world, { s0: 0.5, w0: 0.5 });
    const a = half.step(DT, { steer: 1, wTarget: 0.5 });
    expect(a.skidding).toBe(true); // demand μmg > grip μ·(0.5 mg): excess ignored
    expect(a.steerForce).toBeCloseTo(a.grip, 12);
    const full = new Skier(world, { s0: 0.5, w0: 1 });
    const b = full.step(DT, { steer: 1, wTarget: 1 });
    expect(b.skidding).toBe(false); // demand exactly meets grip at w = 1 on flat
    expect(b.steerForce).toBeCloseTo(PHYS.MU_EDGE * PHYS.MASS * PHYS.G, 12);
  });
});

describe('w dial detent (PLAN §3)', () => {
  it('§3: detent hysteresis — w snaps to 1 above W_DETENT and stays until wTarget < W_DETENT − 0.1', () => {
    const world = makeWorld({ h: () => 0 });
    const sk = new Skier(world, { s0: 0.5, w0: 0.5 });
    let st;
    for (let i = 0; i < 60; i++) st = sk.step(DT, { steer: 0, wTarget: 1 });
    expect(st.w).toBe(1); // crossed 0.92 → snapped
    for (let i = 0; i < 120; i++) st = sk.step(DT, { steer: 0, wTarget: CFG.W_DETENT - 0.05 });
    expect(st.w).toBe(1); // 0.87 is inside the hysteresis band: stays latched
    for (let i = 0; i < 120; i++) st = sk.step(DT, { steer: 0, wTarget: CFG.W_DETENT - 0.12 });
    expect(st.w).toBeCloseTo(CFG.W_DETENT - 0.12, 9); // deliberate input below band: unlatched, dialed down
  });
});

describe('void, death and recovery (PLAN §2.3/§3)', () => {
  it('§3: w = 1 on a void lane falls, dies below the live-neighbor floor − D_KILL, wealth is lost', () => {
    const world = makeWorld({ h: () => 0, rate: () => 0.01, rf: 0.05, voidLanes: [5] });
    const sk = new Skier(world, { s0: 5.5, day0: 0, w0: 1 });
    let st;
    for (let i = 0; i < 600 && !sk.dead; i++) st = sk.step(DT, { steer: 0, wTarget: 1 });
    expect(st.dead).toBe(true);
    expect(st.deathCause).toBe('crevasse');
    expect(st.logW).toBe(-Infinity); // log(1 − w_eff_lost) at w = 1: total loss
    expect(st.y).toBeLessThan(0 - PHYS.D_KILL); // fell below the live floor by the kill depth
  });

  it('§3: 0 < w < 1 on void floats — slow sink, no death, recoverable via w → 0', () => {
    const world = makeWorld({ h: () => 0, rf: 0, voidLanes: [5] });
    const sk = new Skier(world, { s0: 5.5, day0: 0, w0: 0.5 });
    let st;
    for (let i = 0; i < 600; i++) st = sk.step(DT, { steer: 0, wTarget: 0.5 });
    st = sk.step(DT, { steer: 0, wTarget: 0.5 });
    expect(st.dead).toBe(false); // death REQUIRES full weighting
    expect(st.y).toBeLessThan(0); // the cash fraction floats you, but you drift down
    expect(st.y).toBeGreaterThan(-PHYS.D_KILL); // ...slowly: still well above kill depth after 5 s
    // dial to cash: sink stops (gravity off at w = 0)
    for (let i = 0; i < 120; i++) st = sk.step(DT, { steer: 0, wTarget: 0 });
    const yAfterRelease = st.y;
    for (let i = 0; i < 240; i++) st = sk.step(DT, { steer: 0, wTarget: 0 });
    expect(st.w).toBe(0);
    expect(st.dead).toBe(false);
    expect(Math.abs(st.y - yAfterRelease)).toBeLessThan(0.1); // residual vy damped away: recovered
  });

  it('§3: w = 1 on void with no live neighbor in reach dies immediately (open void, no floor)', () => {
    const voids = [];
    for (let l = -10; l <= 20; l++) voids.push(l); // void wider than the probe radius on both sides
    const world = makeWorld({ h: () => 0, voidLanes: voids });
    const sk = new Skier(world, { s0: 5.5, day0: 0, w0: 1 });
    const st = sk.step(DT, { steer: 0, wTarget: 1 });
    expect(st.dead).toBe(true);
    expect(st.deathCause).toBe('void');
    expect(st.logW).toBe(-Infinity);
  });

  it('§3/§2.3: re-weighting with terrain present lands (ghost mode → buy any stock)', () => {
    const world = makeWorld({ h: () => 1.5, rate: () => 0, rf: 0 });
    const sk = new Skier(world, { s0: 2.5, day0: 0, w0: 0 });
    let st = sk.step(DT, { steer: 0, wTarget: 0 });
    expect(st.grounded).toBe(false);
    for (let i = 0; i < 120; i++) st = sk.step(DT, { steer: 0, wTarget: 1 }); // dial up: land
    expect(st.grounded).toBe(true);
    expect(st.y).toBeCloseTo(1.5, 12); // y = h constraint re-engaged at the buy
    expect(st.w).toBe(1);
  });
});

describe('leverage w > 1, capped at W_MAX = 2 (PLAN §2/§3 ext: stretch goal pulled into v1)', () => {
  // margin-blend mock: skier pinned at a fixed (lane, u) blend; chosen lanes may be void (dead)
  const marginWorld = ({ u, deadLanes = [], rf = 0, rate = 0, laneTerm } = {}) => {
    const dead = new Set(deadLanes);
    return {
      daysPerSec: DPS,
      rfAnnual: () => rf,
      laneRate: (lane) => (dead.has(lane) ? NaN : rate),
      heightAt: () => ({ h: 0, dh_ds: 0, dh_dt: 0, lane: 4, u }),
      ...(laneTerm ? { laneTerm } : {}),
    };
  };

  it('§2 ext: hard cap — wTarget beyond W_MAX clamps, and w0 above it spawns at exactly 2', () => {
    const world = makeWorld({ h: () => 0 });
    const sk = new Skier(world, { s0: 0.5, w0: 3 });
    expect(sk.w).toBe(CFG.W_MAX);
    let st;
    for (let i = 0; i < 240; i++) st = sk.step(DT, { steer: 0, wTarget: 5 });
    expect(st.w).toBe(CFG.W_MAX); // 2 is a hard cap, no detent there
  });

  it('§2 ext closed form: w = 2 held lane earns 2·r − (r_f + BORROW_SPREAD) per day', () => {
    const R = 0.001, RF = 0.04;
    const world = makeWorld({ h: () => 0, rate: (lane) => (lane === 3 ? R : 0.07), rf: RF });
    const D = 10;
    const sk = new Skier(world, { s0: 3.5, day0: 0, w0: 2 });
    let st;
    for (let i = 0; i < stepsForDays(D); i++) st = sk.step(DT, { steer: 0, wTarget: 2 });
    expect(st.lane).toBe(3);
    // (1−w) = −1: the borrowed leg PAYS r_f + spread — the formula prices the loan itself
    expect(st.logW).toBeCloseTo(D * (2 * R - (RF + PHYS.BORROW_SPREAD) / PHYS.TRADING_DAYS), 9);
  });

  it('§2 ext closed form: w = 1.5 pays the spread only on the borrowed half', () => {
    const R = 0.002, RF = 0.05;
    const world = makeWorld({ h: () => 0, rate: () => R, rf: RF });
    const D = 8;
    const sk = new Skier(world, { s0: 3.5, day0: 0, w0: 1.5 });
    let st;
    for (let i = 0; i < stepsForDays(D); i++) st = sk.step(DT, { steer: 0, wTarget: 1.5 });
    expect(st.logW).toBeCloseTo(D * (1.5 * R - 0.5 * (RF + PHYS.BORROW_SPREAD) / PHYS.TRADING_DAYS), 9);
  });

  it('§2 ext: no borrow spread at w ≤ 1 — the (1−w) ≥ 0 leg still lends at plain r_f', () => {
    const R = 0.002, RF = 0.05;
    const world = makeWorld({ h: () => 0, rate: () => R, rf: RF });
    const D = 8;
    const sk = new Skier(world, { s0: 3.5, day0: 0, w0: 0.5 });
    let st;
    for (let i = 0; i < stepsForDays(D); i++) st = sk.step(DT, { steer: 0, wTarget: 0.5 });
    expect(st.logW).toBeCloseTo(D * (0.5 * R + 0.5 * RF / PHYS.TRADING_DAYS), 9);
  });

  it('§3 ext: gravity/N/grip keep scaling linearly through w > 1 — w = 2 doubles w = 1', () => {
    const world = makeWorld({ h: (s) => 0.3 * s }); // constant slope below saturation
    const full = new Skier(world, { s0: 0.5, w0: 1 });
    const lev = new Skier(world, { s0: 0.5, w0: 2 });
    const a = full.step(DT, { steer: 0, wTarget: 1 });
    const b = lev.step(DT, { steer: 0, wTarget: 2 });
    expect(b.slopeForce).toBeCloseTo(2 * a.slopeForce, 12); // leverage presses you into the slope harder
    expect(b.N).toBeCloseTo(2 * a.N, 12);
    expect(b.grip).toBeCloseTo(2 * a.grip, 12);
    expect(a.N).toBeGreaterThan(0);
  });

  it('§2 ext: MARGIN CALL — w·u_dead ≥ 1 in the margin is instant total loss even at u < 1', () => {
    // w = 2 blended u = 0.5 into a dead lane: log(1 − 2·0.5) = −∞ — death invades the margin to u = 0.5 exactly
    const sk = new Skier(marginWorld({ u: 0.5, deadLanes: [5] }), { s0: 4.95, day0: 0, w0: 2 });
    const st = sk.step(DT, { steer: 0, wTarget: 2 });
    expect(st.dead).toBe(true);
    expect(st.deathCause).toBe('margin-call');
    expect(st.logW).toBe(-Infinity);
  });

  it('§2 ext: just inside the margin-call boundary survives (w·u_dead < 1)', () => {
    const a = new Skier(marginWorld({ u: 0.49, deadLanes: [5] }), { s0: 4.95, day0: 0, w0: 2 });
    const b = new Skier(marginWorld({ u: 0.5, deadLanes: [5] }), { s0: 4.95, day0: 0, w0: 1.9 });
    let sa, sb;
    for (let i = 0; i < 300; i++) {
      sa = a.step(DT, { steer: 0, wTarget: 2 });   // 2·0.49 = 0.98 < 1
      sb = b.step(DT, { steer: 0, wTarget: 1.9 }); // 1.9·0.5 = 0.95 < 1
    }
    expect(sa.dead).toBe(false);
    expect(sb.dead).toBe(false);
  });

  it('§2 ext: w = 2 wholly on a void plateau margin-calls instantly (w = 1 keeps the crevasse fall)', () => {
    const world = makeWorld({ h: () => 0, voidLanes: [5] });
    const sk = new Skier(world, { s0: 5.5, day0: 0, w0: 2 });
    const st = sk.step(DT, { steer: 0, wTarget: 2 });
    expect(st.dead).toBe(true); // broker liquidates before the crater bottoms out
    expect(st.deathCause).toBe('margin-call');
    expect(st.logW).toBe(-Infinity);
  });

  it('§2.3: a leveraged holder of an ACQUIRED name is cashed out, never margin-called', () => {
    const DEAD = 10;
    const world = {
      daysPerSec: DPS,
      rfAnnual: () => 0,
      laneRate: (_l, dayF) => (dayF > DEAD ? NaN : 0),
      heightAt: (s, dayF) =>
        dayF > DEAD ? null : { h: 2, dh_ds: 0, dh_dt: 0, lane: Math.floor(s), u: 0 },
      laneTerm: () => ({ term: 'acquisition', dead: DEAD }),
    };
    const sk = new Skier(world, { s0: 4.5, day0: 8, w0: 2 });
    let st;
    for (let i = 0; i < stepsForDays(6); i++) st = sk.step(DT, { steer: 0, wTarget: 2 });
    expect(st.dead).toBe(false);
    expect(st.deathCause).toBe(null);
    expect(st.w).toBe(0); // kicker: cash for shares, leverage unwound
    expect(st.logW).toBeGreaterThan(-0.001); // only ~2 days of borrow spread, never a loss event
  });

  it('§3 ext: detent hysteresis BOTH ways — pushing past 1 needs deliberate input, dropping below likewise', () => {
    const world = makeWorld({ h: () => 0 });
    const sk = new Skier(world, { s0: 0.5, w0: 0.5 });
    let st;
    // upward: dialing toward 1.05 crosses the band from below and latches at exactly 1
    for (let i = 0; i < 120; i++) st = sk.step(DT, { steer: 0, wTarget: 1.05 });
    expect(st.w).toBe(1);
    // 1.15 is still inside the upper release band (≤ 2 − W_DETENT + 0.1 = 1.18): stays latched
    for (let i = 0; i < 120; i++) st = sk.step(DT, { steer: 0, wTarget: 1.15 });
    expect(st.w).toBe(1);
    // deliberate push past the band: unlatches and dials up into leverage
    for (let i = 0; i < 120; i++) st = sk.step(DT, { steer: 0, wTarget: 1.3 });
    expect(st.w).toBeCloseTo(1.3, 9);
    for (let i = 0; i < 120; i++) st = sk.step(DT, { steer: 0, wTarget: 2 });
    expect(st.w).toBe(2);
    // downward: dialing from 2 toward 1.05 crosses the band from above and latches at exactly 1
    for (let i = 0; i < 120; i++) st = sk.step(DT, { steer: 0, wTarget: 1.05 });
    expect(st.w).toBe(1);
    // 0.87 is inside the lower release band (≥ W_DETENT − 0.1 = 0.82): stays latched
    for (let i = 0; i < 120; i++) st = sk.step(DT, { steer: 0, wTarget: CFG.W_DETENT - 0.05 });
    expect(st.w).toBe(1);
    // deliberate pull below the band: unlatches and dials down
    for (let i = 0; i < 120; i++) st = sk.step(DT, { steer: 0, wTarget: 0.5 });
    expect(st.w).toBeCloseTo(0.5, 9);
  });
});

describe('leverage input + HUD helpers (plan §7 ext)', () => {
  it('input: W/S dial sweeps 0..W_MAX at the same 1.2/s rate when given the leveraged max', () => {
    expect(dialStep(1.9, 1, 1, CFG.W_MAX)).toBe(2);    // clamps at the cap
    expect(dialStep(1.0, 1, 0.5, CFG.W_MAX)).toBeCloseTo(1.6, 10); // same rate above 1
    expect(dialStep(0.95, 1, 1)).toBe(1);              // default max stays 1 (legacy helper contract)
  });

  it('input: touch maps full zone travel to 0..W_MAX', () => {
    expect(expoFromDrag(0, 400, 400)).toBe(CFG.W_MAX); // full-height drag = full dial
    expect(expoFromDrag(0, 200, 400)).toBeCloseTo(1, 10);
    expect(expoFromDrag(2, -100, 400)).toBeCloseTo(1.5, 10);
    expect(expoFromDrag(1, -9999, 400)).toBe(0);
  });

  it('input: detent gate pins the touch target at w=1 for 80 ms on a crossing, both directions', () => {
    const st = { detentT: null };
    expect(detentGate(0.9, 1.2, st, 1000)).toBe(1);                       // crossing up: pinned
    expect(detentGate(1, 1.4, st, 1000 + DETENT_HOLD_MS - 1)).toBe(1);    // still resisting
    expect(detentGate(1, 1.4, st, 1000 + DETENT_HOLD_MS)).toBe(1.4);      // dwell served: passes
    const dn = { detentT: null };
    expect(detentGate(1.3, 0.7, dn, 5000)).toBe(1);                       // crossing down: pinned
    expect(detentGate(1, 0.6, dn, 5000 + DETENT_HOLD_MS + 1)).toBe(0.6);
    const same = { detentT: null };
    expect(detentGate(0.4, 0.8, same, 0)).toBe(0.8);                      // no crossing: transparent
  });

  it('hud: bar tiers — 0..1 normal, >1 amber, pulsing red on void or leveraged u·w proximity', () => {
    expect(exposureLevel(1, 0, false)).toBe('');
    expect(exposureLevel(1.4, 0, false)).toBe('lev');
    expect(exposureLevel(1.4, 0.7, false)).toBe('mc');  // 1.4·0.7 = 0.98 > MC_PROX: margin-call territory
    expect(exposureLevel(2, 0.39, false)).toBe('lev');  // 2·0.39 = 0.78 ≤ MC_PROX: amber, not yet red
    expect(exposureLevel(1.2, 0, true)).toBe('mc');     // lane is void with exposure
    expect(exposureLevel(0.5, 0, true)).toBe('mc');     // void at any positive exposure
    expect(exposureLevel(0, 0, true)).toBe('');         // ghost flight over a crevasse: no exposure, no alarm
    expect(MC_PROX).toBe(0.8);
  });

  it('hud: numeric multiplier label reads like \'1.4x\'', () => {
    expect(fmtW(1.4)).toBe('1.4x');
    expect(fmtW(2)).toBe('2x');
    expect(fmtW(0.75)).toBe('0.75x');
    expect(fmtW(1)).toBe('1x');
  });
});

describe('determinism (CONTRACTS §4)', () => {
  it('§4: identical inputs produce identical logW and state across runs', () => {
    const mk = () =>
      makeWorld({ h: (s, d) => Math.sin(s) + 0.01 * d, rate: (l) => 0.0005 * (l + 1), rf: 0.04 });
    const run = () => {
      const sk = new Skier(mk(), { s0: 2.5, day0: 0, w0: 1 });
      let st;
      for (let i = 0; i < 480; i++) {
        st = sk.step(DT, { steer: Math.sin(i / 30), wTarget: i < 240 ? 1 : 0.5 });
      }
      return st;
    };
    const a = run();
    const b = run();
    expect(a.logW).toBe(b.logW);
    expect(a.s).toBe(b.s);
    expect(a.y).toBe(b.y);
    expect(a.w).toBe(b.w);
  });
});
