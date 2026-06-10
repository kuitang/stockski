// ui.test.js — DOM-free unit tests for the UI layer (vitest, node environment).
// Covers: input dial/steer math, carve ring-buffer + P&L color logic, ghost altitude
// interpolation, label LOD pure helpers, debug runScript determinism with injected fakes.

import { describe, it, expect } from 'vitest';
import {
  Input, dialStep, steerStep, isFlickDown, isTapHold,
  DIAL_RATE, FLICK_VY, HOLD_MS, HOLD_MOVE_PX,
} from '../src/input.js';
import { CarveBuffer, carveColor, ageAlpha, CARVE_POINTS, SPACING_DAYS } from '../src/carve.js';
import { ghostZAt } from '../src/ghost.js';
import { labelText, labelColor, laneOffset, NEAR_LANES } from '../src/labels.js';
import { Debug, stepsForDays, tickClock, START_WEALTH } from '../src/debug.js';
import { CFG } from '../src/config.js';

// ---------------- input: dial math ----------------

describe('input dial', () => {
  it('moves at 1.2 units/sec', () => {
    expect(dialStep(0, 1, 0.5)).toBeCloseTo(0.6, 10);
    expect(dialStep(1, -1, 0.25)).toBeCloseTo(0.7, 10);
  });

  it('sweeps full range in under 1 second (a dial, not a switch)', () => {
    expect(1 / DIAL_RATE).toBeLessThan(1);
    // integrate at 60 Hz from 0: must reach 1 strictly before 1 s
    let w = 0, t = 0;
    while (w < 1 && t < 2) { w = dialStep(w, 1, 1 / 60); t += 1 / 60; }
    expect(t).toBeLessThan(1);
    expect(w).toBe(1);
  });

  it('clamps to [0, 1]', () => {
    expect(dialStep(0.95, 1, 1)).toBe(1);
    expect(dialStep(0.05, -1, 1)).toBe(0);
  });
});

describe('input steering smoothing', () => {
  it('approaches the target without overshoot', () => {
    let s = 0;
    for (let i = 0; i < 200; i++) s = steerStep(s, 1, 1 / 120);
    expect(s).toBeCloseTo(1, 6);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('returns to 0 when released, faster than attack', () => {
    let s = 0;
    const stepsToFull = (() => {
      let n = 0;
      while (s < 1) { s = steerStep(s, 1, 1 / 120); n++; }
      return n;
    })();
    let n0 = 0;
    while (s > 0) { s = steerStep(s, 0, 1 / 120); n0++; }
    expect(s).toBe(0);
    expect(n0).toBeLessThan(stepsToFull); // release rate > attack rate
  });

  it('is smoothed: a single 120 Hz step never jumps to full lock', () => {
    expect(steerStep(0, 1, 1 / 120)).toBeLessThan(0.2);
  });
});

describe('input gesture detectors', () => {
  it('flick-down requires > 1200 px/s downward', () => {
    expect(isFlickDown(FLICK_VY + 1)).toBe(true);
    expect(isFlickDown(FLICK_VY - 1)).toBe(false);
    expect(isFlickDown(-2000)).toBe(false); // upward flick is not a slam
  });

  it('tap-hold requires >= 350 ms and < 10 px travel', () => {
    expect(isTapHold(HOLD_MS + 1, 0)).toBe(true);
    expect(isTapHold(HOLD_MS - 1, 0)).toBe(false);
    expect(isTapHold(HOLD_MS + 100, HOLD_MOVE_PX)).toBe(false);
  });
});

describe('Input.poll keyboard integration (no DOM: synthetic key events)', () => {
  const key = (code) => ({ code, preventDefault() {} });

  it('W key spins the dial up at DIAL_RATE via poll dt', () => {
    const inp = new Input(); // no surface: no listeners, pure state machine
    inp.wTarget = 0.5;
    inp._key(key('KeyW'), true);
    inp.poll(1000);            // first poll: dt = 0 baseline
    inp.poll(1100);            // +0.1 s
    expect(inp.wTarget).toBeCloseTo(0.5 + DIAL_RATE * 0.1, 10);
  });

  it('SPACE slams wTarget to 0; E sets it to 1', () => {
    const inp = new Input();
    inp._key(key('Space'), true);
    expect(inp.wTarget).toBe(0);
    inp._key(key('KeyE'), true);
    expect(inp.wTarget).toBe(1);
  });

  it('steer smooths toward held key and returns to 0 on release', () => {
    const inp = new Input();
    inp._key(key('KeyD'), true);
    inp.poll(0);
    inp.poll(50); // 50 ms
    const mid = inp.poll(100).steer;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    inp._key(key('KeyD'), false);
    let out;
    for (let t = 150; t <= 1000; t += 50) out = inp.poll(t);
    expect(out.steer).toBe(0);
  });
});

// ---------------- carve: ring buffer + colors ----------------

describe('carveColor', () => {
  it('maps dlogW sign to green/red/white', () => {
    expect(carveColor(0.01)).toEqual([0.29, 0.87, 0.5]);
    expect(carveColor(-0.01)).toEqual([0.97, 0.44, 0.44]);
    expect(carveColor(0)).toEqual([1, 1, 1]);
  });
});

describe('CarveBuffer', () => {
  it('decimates samples closer than SPACING_DAYS apart', () => {
    const b = new CarveBuffer(8);
    expect(b.push(0, 0, 0, 0, 0)).toBe(true);
    expect(b.push(1, 0, 0, 0, SPACING_DAYS / 2)).toBe(false); // too soon
    expect(b.push(1, 0, 0, 0, SPACING_DAYS)).toBe(true);
    expect(b.count).toBe(2);
  });

  it('wraps as a ring buffer and preserves oldest->newest order', () => {
    const b = new CarveBuffer(4);
    for (let i = 0; i < 6; i++) b.push(i, 0, 0, 0, i); // tau = i, always spaced
    expect(b.count).toBe(4); // capacity, not 6
    const xs = [];
    for (let i = 0; i < b.count; i++) xs.push(b.x[b.slot(i)]);
    expect(xs).toEqual([2, 3, 4, 5]); // oldest two (0,1) overwritten
  });

  it('colors each sample by the logW delta since the previous sample', () => {
    const b = new CarveBuffer(8);
    b.push(0, 0, 0, 0.0, 0); // first sample: dlogW = 0 -> white
    b.push(0, 0, 0, 0.5, 1); // gain -> green
    b.push(0, 0, 0, 0.2, 2); // loss -> red
    expect([b.r[b.slot(0)], b.g[b.slot(0)], b.b[b.slot(0)]]).toEqual([1, 1, 1]);
    expect(b.g[b.slot(1)]).toBeGreaterThan(b.r[b.slot(1)]); // green
    expect(b.r[b.slot(2)]).toBeGreaterThan(b.g[b.slot(2)]); // red
  });

  it('default capacity is ~2000 points', () => {
    expect(CARVE_POINTS).toBe(2000);
  });

  it('ageAlpha fades old samples and keeps the newest opaque', () => {
    expect(ageAlpha(99, 100)).toBe(1);
    expect(ageAlpha(0, 100)).toBeCloseTo(0.01, 10);
    expect(ageAlpha(0, 1)).toBe(1);
  });
});

// ---------------- ghost altitude ----------------

describe('ghostZAt', () => {
  const z = [0, 0.1, 0.3];
  it('interpolates linearly across the revealed day segment', () => {
    expect(ghostZAt(z, 0)).toBeCloseTo(0, 10);
    expect(ghostZAt(z, 0.5)).toBeCloseTo(0.05, 10);
    expect(ghostZAt(z, 1)).toBeCloseTo(0.1, 10);
    expect(ghostZAt(z, 1.5)).toBeCloseTo(0.2, 10);
  });
  it('clamps beyond the series ends', () => {
    expect(ghostZAt(z, -1)).toBeCloseTo(0, 10);
    expect(ghostZAt(z, 99)).toBeCloseTo(0.3, 10);
  });
});

// ---------------- labels: pure LOD helpers ----------------

describe('labels helpers', () => {
  it('near ranks get TICK +x.x%, mid ranks ticker only', () => {
    expect(labelText('AAPL', 0.012, 0)).toBe('AAPL +1.2%');
    expect(labelText('AAPL', -0.012, NEAR_LANES - 1)).toBe('AAPL -1.2%');
    expect(labelText('AAPL', 0.012, NEAR_LANES)).toBe('AAPL');
  });
  it('colors by day-return sign with a flat deadband', () => {
    expect(labelColor(0.01)).toBe(0x4ade80);
    expect(labelColor(-0.01)).toBe(0xf87171);
    expect(labelColor(0)).toBe(0xffffff);
    expect(labelColor(NaN)).toBe(0xffffff);
  });
  it('laneOffset visits lanes nearest-first', () => {
    expect([0, 1, 2, 3, 4].map(laneOffset)).toEqual([0, -1, 1, -2, 2]);
  });
});

// ---------------- debug: runScript with injected fakes ----------------

function makeFakes() {
  // fake skier: integrates logW at a deterministic rate proportional to w, drifts s by steer
  const skier = {
    state: null,
    step(dt, input, _terrainFn, clock) {
      const prev = skier.state ?? { s: 0, y: 0, w: 1, u: 0, lane: 0, grounded: true, logW: 0, dead: false };
      const st = {
        ...prev,
        s: prev.s + input.steer * dt,
        w: input.wTarget,
        logW: prev.logW + input.wTarget * 0.01 * dt * clock.daysPerSec, // 1%/day when fully weighted
      };
      skier.state = st;
      return st;
    },
  };
  const clock = {
    tau: 0,
    daysPerSec: CFG.CLOCK_DPS,
    paused: false,
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    setSpeed(d) { this.daysPerSec = d; },
  };
  const ensured = [];
  const stream = {
    manifest: {
      era: 'test', nDays: 10, nLanes: 4,
      dates: Array.from({ length: 10 }, (_, i) => `2025-01-${String(i + 1).padStart(2, '0')}`),
      lanes: [{ sym: 'AAA' }, { sym: 'BBB' }, { sym: 'CCC' }, { sym: 'DDD' }],
      ghost: { z: Array.from({ length: 10 }, (_, i) => i * 0.001) },
      rf: Array(10).fill(0.05),
    },
    ensure(tau) { ensured.push(tau); },
  };
  const spawns = [];
  return { skier, clock, stream, ensured, spawns, hud: {}, spawn: (l, d) => spawns.push([l, d]), version: 'test-1' };
}

describe('debug helpers', () => {
  it('stepsForDays converts world-days to fixed physics steps', () => {
    expect(stepsForDays(1, 120, 2)).toBe(60);   // 1 day at 2 days/s = 0.5 s = 60 steps
    expect(stepsForDays(0, 120, 2)).toBe(0);
    expect(stepsForDays(2.5, 120, 2)).toBe(150);
  });
  it('tickClock falls back to tau += daysPerSec*dt when no tick()', () => {
    const c = { tau: 1, daysPerSec: 2 };
    tickClock(c, 1 / 120);
    expect(c.tau).toBeCloseTo(1 + 2 / 120, 12);
  });
});

describe('Debug / window.__ski', () => {
  it('installs the exact CONTRACTS §4 surface on the target', () => {
    const f = makeFakes();
    const target = {};
    new Debug(f, target);
    const api = target.__ski;
    expect(api.ready).toBe(false);
    expect(api.version).toBe('test-1');
    for (const k of ['state', 'setInput', 'clearInput', 'setSpeed', 'pause', 'resume', 'spawn', 'runScript', 'manifestSummary']) {
      expect(typeof api[k], k).toBe('function');
    }
  });

  it('runScript pauses, advances tau by the scripted days, and resolves final state', async () => {
    const f = makeFakes();
    const target = {};
    new Debug(f, target);
    const fin = await target.__ski.runScript([{ days: 2, steer: 0, wTarget: 1 }]);
    expect(f.clock.paused).toBe(true);
    expect(fin.tau).toBeCloseTo(2, 9);
    // tau accumulates 240 * (2/120) in FP and may land just under 2.0; dateStr must match floor(tau)
    expect(fin.dateStr).toBe(f.stream.manifest.dates[Math.floor(fin.tau)]);
    expect(fin.logW).toBeCloseTo(0.02, 9); // fake skier: 1%/day fully weighted
    expect(fin.wealth).toBeCloseTo(START_WEALTH * Math.exp(0.02), 6);
    expect(fin.ghostLogW).toBe(f.stream.manifest.ghost.z[Math.floor(fin.tau)]); // same floor(tau) day index
    expect(fin.pos.z).toBeCloseTo(-2 * CFG.DAY_M, 9);
    expect(f.ensured.length).toBeGreaterThan(0); // prefetch happened at day boundaries
  });

  it('is deterministic: identical logW across two runs of the same script', async () => {
    const script = [
      { days: 1, steer: 0.5, wTarget: 1 },
      { days: 1, steer: -0.5, wTarget: 0.3 },
      { days: 0.5, steer: 0, wTarget: 0 },
    ];
    const run = async () => {
      const f = makeFakes();
      const target = {};
      new Debug(f, target);
      return target.__ski.runScript(script);
    };
    const [a, b] = [await run(), await run()];
    expect(a.logW).toBe(b.logW);
    expect(a.s).toBe(b.s);
    expect(a.tau).toBe(b.tau);
  });

  it('setInput stores an override and clearInput removes it', () => {
    const f = makeFakes();
    const target = {};
    const dbg = new Debug(f, target);
    target.__ski.setInput({ steer: -1, wTarget: 0.5 });
    expect(dbg.override).toEqual({ steer: -1, wTarget: 0.5, jump: false });
    target.__ski.clearInput();
    expect(dbg.override).toBe(null);
  });

  it('manifestSummary reports era and date range', () => {
    const f = makeFakes();
    const target = {};
    new Debug(f, target);
    expect(target.__ski.manifestSummary()).toEqual({
      era: 'test', nDays: 10, nLanes: 4, dateRange: ['2025-01-01', '2025-01-10'],
    });
  });
});
