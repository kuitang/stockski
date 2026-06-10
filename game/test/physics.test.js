// physics.test.js — analytic mock-world tests for skier dynamics + portfolio identity.
// Each test cites the plan section it verifies (PLAN §6.4).
import { describe, it, expect } from 'vitest';
import { Skier, PHYS } from '../src/physics.js';
import { CFG } from '../src/config.js';

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
