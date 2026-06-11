// main.js — composition root (CONTRACTS §3): era selection + manifest fallback chain,
// fixed-timestep physics accumulator at CFG.PHYS_HZ, ¾ chase camera into the whiteout,
// renderer setup, ESC pause. G2/G3 modules (physics/input/hud/labels/ghost/carve/debug)
// are wired when present via import.meta.glob — absent files fall back to local stubs.

import * as THREE from 'three';
import { CFG } from './config.js';
import { TileStream } from './stream.js';
import { heightAt, TerrainTiles } from './terrain.js';
import { WorldClock } from './clock.js';
import { Frontier } from './frontier.js';
import { setupSky, setupLights, makeSnowMaterial, makeSkier } from './visuals.js';

// optional sibling modules: import.meta.glob compiles to {} for files that don't exist,
// so the core builds and runs standalone before the integrator lands G2/G3 modules
const OPTIONAL = import.meta.glob([
  './physics.js', './input.js', './hud.js', './labels.js', './ghost.js', './carve.js', './debug.js',
]);
import.meta.glob('./ui.css', { eager: true }); // HUD styles, if the HUD agent shipped them
async function loadOptional(name) {
  const loader = OPTIONAL[`./${name}.js`];
  if (!loader) return null;
  try { return await loader(); } catch (e) { console.warn(`optional module ${name} failed:`, e); return null; }
}

const START_TAU = 1;        // spawn at day 1 (task spec): one revealed day-strip behind you, dayRet defined
const SPAWN_WAIT_MS = 8000; // first-tile budget: matches plan §7 mobile load target (< 8 s)
const RESPAWN_DELAY_MS = 1800; // long enough to read the death cause, short enough to retry eagerly
const CAM = CFG.CAM;        // ¾ chase camera geometry: high, pitched down, zoomed out (CFG.CAM, config.js)
const STUB_LAT_MS = 6;      // physics-stub lateral speed m/s (~6 lanes/s): brisk terrain eyeballing
const STUB_FLOAT_M = 1.5;   // physics-stub visual float at w=0 — mirrors plan §3 "float ∝ (1−w)"
const START_WEALTH_FALLBACK = 100000; // $100k start if hud.js (which owns START_WEALTH) is absent

/** Minimal glued-to-terrain skier used until physics.js exists (same ctor/step shape). */
class PhysicsStub {
  constructor(world, { s0 = 0, day0 = 0 } = {}) {
    this.world = world;
    this.s = s0;
    this.day = day0;
    this.w = 1;
    this.logW = 0;
    const q = world.heightAt(s0, day0);
    this.y = q ? q.h : 0;
    this.lane = q ? q.lane : 0;
    this.u = q ? q.u : 0;
    this.grounded = !!q;
  }
  step(dt, input = {}) {
    this.day += this.world.daysPerSec * dt;
    this.s += (input.steer ?? 0) * STUB_LAT_MS * dt;
    this.w = input.wTarget ?? 1;
    const q = this.world.heightAt(this.s, this.day);
    if (q) {
      this.y = q.h + STUB_FLOAT_M * (1 - this.w);
      this.lane = q.lane;
      this.u = q.u;
      this.grounded = this.w > 0;
    } else {
      this.grounded = false; // stub holds altitude over void (no death until physics.js lands)
    }
    return {
      s: this.s, y: this.y, vs: 0, vy: 0, w: this.w, u: this.u, lane: this.lane,
      grounded: this.grounded, logW: this.logW, dead: false, deathCause: null,
    };
  }
}

/** Minimal keyboard input used until input.js exists (same poll() shape). */
class InputStub {
  constructor() {
    this.keys = new Set();
    this.wTarget = 1;
    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
  }
  poll() {
    const k = this.keys;
    const steer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const DIAL = 0.02; // per-poll dial step ≈ full sweep in ~1 s at 60 fps
    if (k.has('KeyW') || k.has('ArrowUp')) this.wTarget = Math.min(1, this.wTarget + DIAL);
    if (k.has('KeyS') || k.has('ArrowDown')) this.wTarget = Math.max(0, this.wTarget - DIAL);
    if (k.has('Space')) this.wTarget = 0; // slam to cash (plan §2.3)
    if (k.has('KeyE')) this.wTarget = 1;  // re-land full exposure
    return { steer, wTarget: this.wTarget, jump: false };
  }
}

/** Era selection: ?era= (default recent2y) -> 'synthetic' static tiles -> in-memory fallback. */
async function pickStream() {
  const era = new URLSearchParams(location.search).get('era') || 'recent2y';
  const candidates = era === 'synthetic' ? ['synthetic'] : [era, 'synthetic'];
  for (const e of candidates) {
    try {
      return await new TileStream(`tiles/${e}/manifest.json`).load();
    } catch { /* 404 -> next candidate */ }
  }
  const { makeSynthProvider } = await import('./synthfallback.js');
  return await new TileStream(null, makeSynthProvider()).load();
}

const msgEl = () => document.getElementById('msg');
function showMsg(text) { const el = msgEl(); if (el) { el.textContent = text; el.style.display = text ? 'block' : 'none'; } }

/** Full-screen death overlay (plan §7 death/respawn): created lazily so index.html stays minimal. */
function deathEl() {
  let el = document.getElementById('death');
  if (!el) {
    el = document.createElement('div');
    el.id = 'death';
    // mirrors #pause styling: centered, non-interactive, above the HUD
    el.style.cssText =
      'position:fixed;inset:0;display:none;place-items:center;text-align:center;' +
      'font:700 28px system-ui,sans-serif;color:#7a1f1f;background:rgba(246,248,252,0.7);' +
      'z-index:50;pointer-events:none;white-space:pre-line;';
    document.body.appendChild(el);
  }
  return el;
}
function showDeath(text) {
  const el = deathEl();
  el.textContent = text ?? '';
  el.style.display = text ? 'grid' : 'none';
}

/** Spawn lane (task spec): manifest symbol with the highest first-day dollar volume
 *  (lane.dv0, written by export_tiles.py). Manifests without dv0 (synthetic) fall back to
 *  the first lane alive at day 0 that survives the whole era — lane 0 for synthetic —
 *  so a fresh player is never dropped onto a lane that delists under them at spawn. */
function pickSpawnLane(m) {
  const isReal = (l) => l.born === 0 && l.sym && !String(l.sym).startsWith('_'); // alive at era start, not padding
  let best = -1;
  let bestDv = 0; // dv0 must be strictly positive: a zero-volume first day is not a tradable spawn
  for (let i = 0; i < m.lanes.length; i++) {
    const l = m.lanes[i];
    if (!isReal(l)) continue;
    const dv = Number(l.dv0);
    if (Number.isFinite(dv) && dv > bestDv) { bestDv = dv; best = i; }
  }
  if (best >= 0) return best;
  const survivor = m.lanes.findIndex((l) => isReal(l) && l.dead === -1);
  if (survivor >= 0) return survivor;
  const first = m.lanes.findIndex(isReal);
  return first >= 0 ? first : 0;
}

async function boot() {
  const stream = await pickStream();
  const m = stream.manifest;
  showMsg(`era ${m.era} · ${m.nDays} days × ${m.nLanes} lanes · loading snow…`);

  // --- renderer / scene / camera -------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); // DPR cap: >2 buys nothing on snow, costs fill rate (plan §7)
  renderer.setSize(innerWidth, innerHeight);
  document.getElementById('app').appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6f8fc); // storm white: void beyond the frontier reads as whiteout
  const camera = new THREE.PerspectiveCamera(CAM.FOV, innerWidth / innerHeight, 0.1, 5000);
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  const sky = setupSky(scene);
  setupLights(scene);
  const { material: snowMat, uniforms: snowUniforms } = makeSnowMaterial();
  const terrain = new TerrainTiles(scene, stream, snowMat);
  const frontier = new Frontier(scene, snowUniforms);
  const skierMesh = makeSkier();
  scene.add(skierMesh);

  // --- clock + spawn --------------------------------------------------------------------
  const clock = new WorldClock({ daysPerSec: CFG.CLOCK_DPS, dates: m.dates, startTau: START_TAU });

  // spawn lane per task spec: highest first-day-dollar-volume symbol, lane 0 for synthetic
  const spawnLane = pickSpawnLane(m);
  const spawnS = (spawnLane + 0.5) * CFG.LANE_M; // plateau center of the spawn lane (terrain.js convention)

  stream.ensure(clock.tau, spawnLane);
  const t0 = performance.now();
  while (performance.now() - t0 < SPAWN_WAIT_MS) {
    if (Number.isFinite(stream.zLane(spawnLane, Math.floor(clock.tau)))) break;
    stream.ensure(clock.tau, spawnLane);
    await new Promise((r) => setTimeout(r, 50));
  }

  // --- physics world adapter (physics.js world interface) --------------------------------
  const wrapLane = (l) => ((l % m.nLanes) + m.nLanes) % m.nLanes;
  // dominant holding of the blend pair (terrain lane = left lane i, u = blend toward i+1):
  // the symbol "under foot" for HUD/labels is lane+1 once the majority of weight is there
  const dispLane = (st) => wrapLane((st.lane ?? 0) + ((st.u ?? 0) >= 0.5 ? 1 : 0));
  const world = {
    heightAt: (s, dayF) => {
      const q = heightAt(s, dayF, stream);
      return Number.isNaN(q.h) ? null : q; // physics.js expects null for void
    },
    laneRate: (lane, dayF) => stream.zLaneDeriv(lane, dayF).dz, // dz/dday, NaN if void
    laneZ: (lane, dayF) => stream.zLaneDeriv(lane, dayF).z, // held z level: exact wealth telescoping
    laneTerm: (lane) => {
      const l = m.lanes[wrapLane(lane)];
      return l ? { term: l.term, dead: l.dead } : null; // acquisition kicker info (plan §2.3)
    },
    rfAnnual: (dayF) => {
      const d = Math.min(Math.max(Math.floor(dayF), 0), m.nDays - 1);
      return m.rf?.[d] ?? 0;
    },
    get daysPerSec() { return clock.daysPerSec; },
  };

  // --- optional modules ------------------------------------------------------------------
  const [physMod, inputMod, hudMod, labelsMod, ghostMod, carveMod, debugMod] = await Promise.all(
    ['physics', 'input', 'hud', 'labels', 'ghost', 'carve', 'debug'].map(loadOptional)
  );
  const SkierClass = physMod?.Skier ?? PhysicsStub;
  const makeSkierSim = (s0, day0, logW0 = 0) => {
    const sk = new SkierClass(world, { s0, day0 });
    sk.logW = logW0; // respawn restores checkpoint wealth (plan §7)
    return sk;
  };
  let skier = makeSkierSim(spawnS, clock.tau);
  let state = snapshot(skier);

  const input = inputMod?.Input ? new inputMod.Input(renderer.domElement) : new InputStub();
  let inputOverride = null; // debug setInput hook (fallback path)
  let dbg = null;           // debug.js Debug instance, if present
  const pollInput = () => dbg?.override ?? inputOverride ?? input.poll();

  const startWealth = hudMod?.START_WEALTH ?? START_WEALTH_FALLBACK;
  let hud = null, labels = null, ghost = null, carve = null;
  try { if (hudMod?.Hud) hud = new hudMod.Hud(); } catch (e) { console.warn('hud init failed:', e); }
  try { if (ghostMod?.Ghost) ghost = new ghostMod.Ghost({ scene, manifest: m }); } catch (e) { console.warn('ghost init failed:', e); }
  try { if (carveMod?.Carve) carve = new carveMod.Carve({ scene, clock }); } catch (e) { console.warn('carve init failed:', e); }
  try {
    if (labelsMod?.Labels) {
      labels = new labelsMod.Labels({
        scene, camera, manifest: m,
        getLaneInfo: (lane, tau) => {
          const q = stream.zLaneDeriv(lane, tau);
          if (Number.isNaN(q.z)) return null;
          // lane axis wraps: place the label at the lane image nearest the skier
          const span = m.nLanes * CFG.LANE_M;
          const x0 = (lane + 0.5) * CFG.LANE_M;
          const x = x0 + span * Math.round((state.s - x0) / span);
          return { x, y: CFG.K_HEIGHT * q.z, z: -tau * CFG.DAY_M, dayRet: dayReturn(lane, tau) };
        },
      });
    }
  } catch (e) { console.warn('labels init failed:', e); }

  // causal day return: log close(d) − log close(d−1), data ≤ τ only (plan §4.3)
  function dayReturn(lane, tau) {
    const d = Math.min(Math.floor(tau), m.nDays - 1);
    if (d < 1) return NaN;
    const a = stream.zLane(lane, d);
    const b = stream.zLane(lane, d - 1);
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : NaN;
  }

  // ghost log-wealth, rebased to spawn so the comparison starts level (plan §7)
  const ghostZ = (tau) => {
    const z = m.ghost?.z;
    if (!z?.length) return 0;
    const d = Math.min(Math.max(Math.floor(tau), 0), z.length - 1);
    const d1 = Math.min(d + 1, z.length - 1);
    return z[d] + (z[d1] - z[d]) * Math.min(Math.max(tau - d, 0), 1);
  };
  const ghostZ0 = ghostZ(clock.tau);

  // --- checkpoint / death ----------------------------------------------------------------
  let ckpt = { tau: clock.checkpointTau, s: spawnS, logW: 0 };
  let deathPending = false;
  function maybeCheckpoint() {
    if (clock.checkpointTau !== ckpt.tau && !state.dead) {
      ckpt = { tau: clock.checkpointTau, s: state.s, logW: state.logW };
    }
  }
  function handleDeath() {
    if (!state.dead || deathPending) return;
    deathPending = true;
    const ckptDate = m.dates[Math.min(ckpt.tau, m.nDays - 1)] ?? '';
    showDeath(`WIPEOUT — ${state.deathCause ?? 'crash'}\nrewinding to checkpoint ${ckptDate}…`);
    setTimeout(() => {
      clock.rewind(); // plan §7: respawn rewinds the world clock to the month-boundary checkpoint
      skier = makeSkierSim(ckpt.s, clock.tau, ckpt.logW); // …and wealth to its checkpointed value
      state = snapshot(skier);
      deathPending = false;
      showDeath('');
    }, RESPAWN_DELAY_MS);
  }

  function snapshot(sk) {
    return {
      s: sk.s, y: sk.y, vs: sk.vs ?? 0, vy: sk.vy ?? 0, w: sk.w, u: sk.u ?? 0,
      lane: sk.lane ?? 0, grounded: !!sk.grounded, logW: sk.logW,
      dead: !!sk.dead, deathCause: sk.deathCause ?? null,
    };
  }

  // --- pause (ESC) -----------------------------------------------------------------------
  let paused = false;
  const pauseEl = document.getElementById('pause');
  function setPaused(p) {
    paused = p;
    if (p) clock.pause(); else clock.resume();
    if (pauseEl) pauseEl.style.display = p ? 'grid' : 'none';
  }
  addEventListener('keydown', (e) => { if (e.code === 'Escape') setPaused(!paused); });
  // background tab: the world must not run unwatched (plan §7)
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });
  renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); setPaused(true); });

  // --- debug hook (debug.js Debug class, CONTRACTS §4) -------------------------------------
  let fps = 0;
  // stable facade: debug.js holds one skier reference, but main swaps skiers on respawn/spawn
  const skierFacade = {
    get state() { return state; },
    step: (dt, inp) => { state = skier.step(dt, inp); return state; },
    terrainFn: (s, dayF) => heightAt(s, dayF, stream),
  };
  try {
    if (debugMod?.Debug) {
      dbg = new debugMod.Debug({
        skier: skierFacade,
        clock,
        stream,
        hud,
        spawn: (lane, day) => { // teleport + reset wealth (test only, CONTRACTS §4)
          clock.tau = day;
          clock.checkpoint();
          skier = makeSkierSim((lane + 0.5) * CFG.LANE_M, day, 0);
          state = snapshot(skier);
          ckpt = { tau: clock.checkpointTau, s: state.s, logW: 0 };
        },
        version: '0.1.0-g1',
        terrainFn: (s, dayF) => heightAt(s, dayF, stream),
        getFps: () => fps,
      });
    }
  } catch (e) { console.warn('debug init failed:', e); }
  if (!dbg && !window.__ski) {
    // minimal Playwright surface until debug.js lands (CONTRACTS §4 — partial, see integrator notes)
    window.__ski = {
      ready: false,
      version: '0.1.0-g1',
      state: () => ({
        tau: clock.tau,
        dateStr: m.dates[Math.min(Math.floor(clock.tau), m.nDays - 1)],
        s: state.s, lane: dispLane(state), sym: m.lanes[dispLane(state)]?.sym,
        u: state.u, w: state.w, grounded: state.grounded, dead: state.dead,
        logW: state.logW, wealth: startWealth * Math.exp(state.logW),
        ghostLogW: ghostZ(clock.tau) - ghostZ0, fps,
        pos: { x: skierMesh.position.x, y: skierMesh.position.y, z: skierMesh.position.z },
      }),
      setInput: (inp) => { inputOverride = inp; },
      clearInput: () => { inputOverride = null; },
      setSpeed: (d) => clock.setSpeed(d),
      pause: () => setPaused(true),
      resume: () => setPaused(false),
      manifestSummary: () => ({
        era: m.era, nDays: m.nDays, nLanes: m.nLanes,
        dateRange: [m.dates[0], m.dates[m.nDays - 1]],
      }),
    };
  }

  // --- fixed-timestep loop (CFG.PHYS_HZ) ---------------------------------------------------
  const H = 1 / CFG.PHYS_HZ;
  function stepWorld(nSteps, inp = pollInput()) {
    for (let i = 0; i < nSteps; i++) {
      clock.update(H);
      state = skier.step(H, inp);
      carve?.push(state);
      maybeCheckpoint();
    }
  }

  let acc = 0;
  let last = performance.now();
  let firstFrame = true;
  function frame(now) {
    requestAnimationFrame(frame);
    const dtRaw = (now - last) / 1000;
    last = now;
    const dt = Math.min(dtRaw, 0.25); // clamp: a tab-switch hitch must not warp τ by minutes
    if (dtRaw > 0) fps = fps * 0.95 + (1 / Math.max(dtRaw, 1e-4)) * 0.05; // EMA, ~1 s horizon

    // also gate on clock.paused: debug pause()/runScript pause only the CLOCK — stepping the
    // skier then would advance skier.day past a frozen τ and break the frontier pin
    if (!paused && !clock.paused && !deathPending) {
      acc += dt;
      const inp = pollInput();
      while (acc >= H) {
        acc -= H;
        stepWorld(1, inp);
      }
      handleDeath();
      if (clock.tau >= clock.maxTau) {
        // era end: τ clamps but skier.day would keep integrating into nonexistent days — stop the run
        setPaused(true);
        showMsg(`era complete — ${m.dates[m.nDays - 1] ?? ''}`);
      }
    }

    // streaming + geometry keyed to τ and the skier's lane neighborhood
    stream.ensure(clock.tau, (((state.s / CFG.LANE_M) % m.nLanes) + m.nLanes) % m.nLanes);
    terrain.update(clock.tau, state.s);

    // skier pinned to the frontier: world z = −τ·DAY_M (CONTRACTS §3)
    const z = -clock.tau * CFG.DAY_M;
    skierMesh.position.set(state.s, state.y, z);
    skierMesh.rotation.y = -(state.vs ?? 0) * 0.04; // lean into the carve: 0.04 rad per m/s reads as edging
    frontier.update(clock.tau, state.s, state.y);

    // ¾ chase camera: high behind the skier, pitched down at a point past the frontier — the
    // skier sits small in the lower third and never occludes the slope read ahead (CFG.CAM)
    const camTarget = _camV.set(state.s + CAM.SIDE, state.y + CAM.UP, z + CAM.BACK);
    if (firstFrame) camera.position.copy(camTarget);
    else camera.position.lerp(camTarget, 1 - Math.pow(CAM.DAMP, dt));
    camera.lookAt(state.s, state.y - CAM.DROP, z - CAM.AHEAD);
    sky.position.copy(camera.position); // sky is at infinity: never parallax

    if (hud) {
      const lane = dispLane(state); // dominant holding: the symbol actually under foot
      const meta = m.lanes[lane] ?? {};
      hud.update(state, {
        sym: meta.sym ?? '—',
        name: meta.name ?? '',
        sector: meta.sector ?? '',
        date: m.dates[Math.min(Math.floor(clock.tau), m.nDays - 1)] ?? '',
        dayRet: dayReturn(lane, clock.tau),
        wealth: startWealth * Math.exp(state.logW),
        ghostWealth: startWealth * Math.exp(ghostZ(clock.tau) - ghostZ0),
      });
    }
    labels?.update(clock.tau, state.s);
    ghost?.update(clock.tau);
    carve?.update?.();

    renderer.render(scene, camera);
    if (firstFrame) {
      firstFrame = false;
      showMsg('');
      if (window.__ski) window.__ski.ready = true;
    }
  }
  const _camV = new THREE.Vector3();
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  showMsg(`failed to start: ${e?.message ?? e}`);
});
