// debug.js — Playwright test API (CONTRACTS §4): installs window.__ski EXACTLY per contract.
// runScript drives the fixed-step loop synchronously while paused — deterministic by construction
// (fixed dt, no Math.random, same spawn => identical logW across runs).

import { CFG } from './config.js';

export const START_WEALTH = 100000; // CONTRACTS §4 wealth readout: portfolio starts at $100k

/** Pure: number of fixed physics steps needed to advance `days` world-days at `daysPerSec`. */
export function stepsForDays(days, physHz = CFG.PHYS_HZ, daysPerSec = CFG.CLOCK_DPS) {
  if (!(days > 0) || !(daysPerSec > 0)) return 0;
  return Math.round((days * physHz) / daysPerSec);
}

/** Pure: advance a clock-like object by one fixed step; uses clock.tick if it exists. */
export function tickClock(clock, dt) {
  if (typeof clock.tick === 'function') clock.tick(dt);
  else clock.tau += clock.daysPerSec * dt;
}

export class Debug {
  /**
   * @param {object} deps
   * @param {object} deps.skier   physics Skier (CONTRACTS §3); step(dt, input, terrainFn, clock) -> State;
   *                              if it exposes .state (latest State) that is preferred for state()
   * @param {object} deps.clock   WorldClock {tau, daysPerSec, pause, resume, setSpeed, ...}
   * @param {object} deps.stream  TileStream {manifest, ensure(tau)}
   * @param {object} deps.hud     Hud (unused for now; reserved so HUD assertions can be added)
   * @param {(lane:number, day:number) => void} deps.spawn  teleport + reset wealth (test only)
   * @param {string} deps.version git-ish build string
   * @param {(s:number, dayF:number) => object} [deps.terrainFn]  terrain.heightAt closure for runScript;
   *                              falls back to skier.terrainFn if the integrator bound one there
   * @param {() => number} [deps.getFps]  live fps probe from the render loop
   * @param {object} [target]    where to install __ski (defaults to globalThis === window in browsers)
   */
  constructor(deps, target = globalThis) {
    this.deps = deps;
    this.override = null;     // main loop should use: dbg.override ?? input.poll()
    this._lastState = null;   // latest physics State seen via runScript
    const api = {
      ready: false,           // main flips to true after first tiles + skier spawned
      version: deps.version,
      state: () => this.state(),
      setInput: (o) => { this.override = { steer: o.steer ?? 0, wTarget: o.wTarget ?? 1, jump: false }; },
      clearInput: () => { this.override = null; },
      setSpeed: (dps) => deps.clock.setSpeed(dps),
      pause: () => deps.clock.pause(),
      resume: () => deps.clock.resume(),
      spawn: (lane, day) => deps.spawn(lane, day),
      runScript: (steps) => this.runScript(steps),
      manifestSummary: () => this.manifestSummary(),
    };
    target.__ski = api;
    this.api = api;
  }

  /** Latest physics State: prefer a live skier.state property, else the last runScript result. */
  _skierState() {
    return this.deps.skier.state ?? this._lastState ?? {};
  }

  state() {
    const { clock, stream } = this.deps;
    const st = this._skierState();
    const m = stream.manifest ?? {};
    const tau = clock.tau;
    const nDays = m.nDays ?? 0;
    const d = Math.min(Math.max(Math.floor(tau), 0), Math.max(nDays - 1, 0));
    const lane = st.lane ?? 0;
    return {
      tau,
      dateStr: m.dates?.[d] ?? '',
      s: st.s ?? 0,
      lane,
      sym: m.lanes?.[lane]?.sym ?? '',
      u: st.u ?? 0,
      w: st.w ?? 0,
      grounded: st.grounded ?? false,
      dead: st.dead ?? false,
      logW: st.logW ?? 0,
      wealth: START_WEALTH * Math.exp(st.logW ?? 0),
      ghostLogW: m.ghost?.z?.[d] ?? 0,
      fps: this.deps.getFps ? this.deps.getFps() : 0,
      pos: { x: st.s ?? 0, y: st.y ?? 0, z: -tau * CFG.DAY_M },
    };
  }

  manifestSummary() {
    const m = this.deps.stream.manifest ?? {};
    const dates = m.dates ?? [];
    return {
      era: m.era ?? '',
      nDays: m.nDays ?? 0,
      nLanes: m.nLanes ?? 0,
      dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : [],
    };
  }

  /**
   * Drive the sim synchronously while paused: steps = [{days, steer, wTarget}].
   * Each fixed step advances the clock then the skier — identical ordering to main's
   * accumulator loop, so scripted runs match live runs exactly.
   * @returns {Promise<object>} final state() snapshot
   */
  async runScript(steps) {
    const { skier, clock, stream, terrainFn } = this.deps;
    clock.pause(); // render loop must not also advance tau while we step synchronously
    const dt = 1 / CFG.PHYS_HZ;
    const tFn = terrainFn ?? skier.terrainFn ?? null;
    for (const step of steps) {
      const input = { steer: step.steer ?? 0, wTarget: step.wTarget ?? 1, jump: false };
      const n = stepsForDays(step.days, CFG.PHYS_HZ, clock.daysPerSec);
      let lastDay = -1;
      for (let i = 0; i < n; i++) {
        tickClock(clock, dt);
        const day = Math.floor(clock.tau);
        if (day !== lastDay) { // prefetch once per day boundary, not per 120 Hz step
          lastDay = day;
          stream.ensure?.(clock.tau);
        }
        this._lastState = skier.step(dt, input, tFn, clock);
      }
      await Promise.resolve(); // yield so pending tile fetches/microtasks can settle between steps
    }
    return this.state();
  }
}
