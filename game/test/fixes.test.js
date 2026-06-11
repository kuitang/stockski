// fixes.test.js — regression tests for the verified findings:
//  (1/4) tile-boundary "phantom void": not-resident must hold, not kill, and no daily
//        return may be dropped from logW (PLAN §2.1 wealth identity, §4.5 causality)
//  (2)   acquisition lane end = forced w→0 kicker, never a loss (PLAN §2.3)
//  (3)   terrain's (lane, u) pair must match physics' blend convention (PLAN §2.1)
import { describe, it, expect } from 'vitest';
import { CFG } from '../src/config.js';
import { Skier, PHYS } from '../src/physics.js';
import { heightAt } from '../src/terrain.js';
import { TileStream } from '../src/stream.js';

const DT = 1 / CFG.PHYS_HZ; // fixed 120 Hz timestep (plan §3)
const DPS = CFG.CLOCK_DPS;  // 2 trading days / sec (plan §0)
const stepsForDays = (D) => Math.round(D / (DPS * DT));

// ---------------- (3) terrain (lane, u) convention ----------------

describe('terrain (lane,u) matches the physics blend convention (PLAN §2.1)', () => {
  // stub stream: lane k's level is exactly k, so the effective blend is directly readable
  const stream = { manifest: { nLanes: 8 }, zLaneDeriv: (lane) => ({ z: lane, dz: 0 }) };
  const blend = (q) => (1 - q.u) * q.lane + q.u * (q.lane + 1); // physics' effective lane level

  it('left half of a plateau reports (i, u=1): all weight on lane i+1, h consistent', () => {
    // α = 0.08: lane 4's exact-track plateau spans [4.46, 4.54] lane units; 4.47 is its left
    // half (×LANE_M → meters, so the test holds at any shipped lane width)
    const q = heightAt(4.47 * CFG.LANE_M, 0, stream);
    expect(q.lane).toBe(3);
    expect(q.u).toBe(1);
    expect(blend(q)).toBeCloseTo(4, 12);          // 100% lane 4 — the plateau the skier stands on
    expect(q.h / CFG.K_HEIGHT).toBeCloseTo(4, 12); // and the rendered height agrees
  });

  it('physics blend equals h/K everywhere across plateau, margin and seam (no jump)', () => {
    for (let s = 3.0; s <= 5.0; s += 1 / 64) {
      const q = heightAt(s, 0, stream);
      expect(blend(q)).toBeCloseTo(q.h / CFG.K_HEIGHT, 10);
    }
  });

  it('wealth on a margin uses (1-u)·r_lane + u·r_{lane+1} (the right pair of lanes)', () => {
    const world = {
      daysPerSec: DPS,
      rfAnnual: () => 0,
      laneRate: (lane) => (lane === 2 ? 0.001 : lane === 3 ? 0.003 : 99), // 99: wrong pair would explode
      heightAt: () => ({ h: 0, dh_ds: 0, dh_dt: 0, lane: 2, u: 0.75 }),  // upper half of the margin
    };
    const D = 4;
    const sk = new Skier(world, { s0: 2.75, day0: 0, w0: 1 });
    let st;
    for (let i = 0; i < stepsForDays(D); i++) st = sk.step(DT, { steer: 0, wTarget: 1 });
    expect(st.logW).toBeCloseTo(D * (0.25 * 0.001 + 0.75 * 0.003), 9);
  });
});

// ---------------- (1/4) tile-boundary hold + telescoping wealth ----------------

describe('stream: not-resident ≠ void at tile boundaries (PLAN §4.5)', () => {
  function mkStream(allowT) {
    const nLanes = CFG.TILE_LANES;
    const manifest = { era: 't', tileDays: CFG.TILE_DAYS, tileLanes: nLanes, nDays: 128, nLanes };
    const provider = {
      manifest,
      fetchTile(T) {
        if (T > allowT) return new Promise(() => {}); // simulate a fetch that never lands
        const a = new Int16Array(CFG.TILE_DAYS * nLanes);
        for (let r = 0; r < CFG.TILE_DAYS; r++)
          for (let c = 0; c < nLanes; c++) a[r * nLanes + c] = T * CFG.TILE_DAYS + r; // z = day/1000
        return a;
      },
    };
    return new TileStream(null, provider);
  }

  it('holds the last revealed close flat (dz=0) while the day-64 tile is in flight', async () => {
    const stream = await mkStream(0).load();
    stream.ensure(64.5, 0); // tile 0 lands, tile 1 stays in flight
    await new Promise((r) => setTimeout(r, 0));
    const q = stream.zLaneDeriv(0, 64.5);
    expect(q.z).toBeCloseTo(0.063, 12); // held at the day-63 close — a LIVE lane, not a void
    expect(q.dz).toBe(0);
    const h = heightAt(0.5, 64.5, stream);
    expect(Number.isFinite(h.h)).toBe(true); // terrain under the skier exists: no phantom crevasse
  });
});

describe('physics: laneZ z-difference wealth telescopes across a held boundary (PLAN §2.1)', () => {
  it('catches up the boundary daily return exactly whenever the tile lands', () => {
    // lane climbs 0.001/day; days past 63 read as held (stale) until `revealed` flips mid-run
    let revealed = false;
    const world = {
      daysPerSec: DPS,
      rfAnnual: () => 0,
      laneRate: () => { throw new Error('laneZ path must be used when laneZ exists'); },
      laneZ: (_lane, dayF) => 0.001 * (revealed ? dayF : Math.min(dayF, 63)),
      heightAt: (s) => ({ h: 0, dh_ds: 0, dh_dt: 0, lane: Math.floor(s), u: 0 }),
    };
    const sk = new Skier(world, { s0: 5.5, day0: 60, w0: 1 });
    const n = stepsForDays(6);
    let st;
    for (let i = 0; i < n; i++) {
      if (i === Math.floor(0.8 * n)) revealed = true; // tile lands at some arbitrary later instant
      st = sk.step(DT, { steer: 0, wTarget: 1 });
    }
    expect(st.dead).toBe(false);
    expect(st.logW).toBeCloseTo(0.001 * 6, 12); // z(66) − z(60): no daily return dropped
  });
});

// ---------------- (2) acquisition kicker ----------------

describe('acquisition lane end (PLAN §2.3)', () => {
  it('forces w→0 (cash for shares), never dies, then compounds at r_f', () => {
    const DEAD = 10; // last trading day index of the acquired lane
    const RF = 0.05;
    const world = {
      daysPerSec: DPS,
      rfAnnual: () => RF,
      laneRate: (_l, dayF) => (dayF > DEAD ? NaN : 0), // flat to the end, void after
      heightAt: (s, dayF) =>
        dayF > DEAD ? null : { h: 2, dh_ds: 0, dh_dt: 0, lane: Math.floor(s), u: 0 },
      laneTerm: () => ({ term: 'acquisition', dead: DEAD }),
    };
    const sk = new Skier(world, { s0: 4.5, day0: 8, w0: 1 });
    let st;
    // input demands w=1 the whole time — there is nothing to buy over the void, so it must not re-latch
    for (let i = 0; i < stepsForDays(6); i++) st = sk.step(DT, { steer: 0, wTarget: 1 });
    expect(st.dead).toBe(false);
    expect(st.deathCause).toBe(null);
    expect(st.w).toBe(0); // forced cash-out holds
    const rfDays = 8 + 6 - DEAD; // days spent in cash after the ledge
    expect(Math.abs(st.logW - (rfDays * RF) / PHYS.TRADING_DAYS)).toBeLessThan(1e-5); // ± one 120 Hz slice
    expect(st.logW).toBeGreaterThan(0); // an acquisition is never a loss
  });

  it('bankruptcy lane end still dies when ridden in fully weighted (unchanged)', () => {
    const DEAD = 10;
    const world = {
      daysPerSec: DPS,
      rfAnnual: () => 0,
      laneRate: (_l, dayF) => (dayF > DEAD ? NaN : 0),
      heightAt: (s, dayF) => {
        const lane = Math.floor(s);
        if (lane === 4 && dayF > DEAD) return null; // only lane 4 dies: neighbors give the floor
        return { h: 0, dh_ds: 0, dh_dt: 0, lane, u: 0 };
      },
      laneTerm: (lane) => (lane === 4 ? { term: 'bankruptcy', dead: DEAD } : { term: 'alive', dead: -1 }),
    };
    const sk = new Skier(world, { s0: 4.5, day0: 8, w0: 1 });
    let st;
    for (let i = 0; i < 1200 && !sk.dead; i++) st = sk.step(DT, { steer: 0, wTarget: 1 });
    expect(st.dead).toBe(true);
    expect(st.deathCause).toBe('crevasse');
    expect(st.logW).toBe(-Infinity);
  });
});
