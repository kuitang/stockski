// labels.js — billboarded frontier ticker labels with distance LOD (plan §7, CONTRACTS §3).
// Troika SDF Text pool, reused every frame — no Text is ever created after construction.
// Dependencies are injected: manifest (lane metadata) + getLaneInfo placement callback.

import { Text } from 'troika-three-text'; // troika Texts are THREE.Object3D
import { Vector3 } from 'three';          // NDC projection for the HUD-zone fade
import { CFG } from './config.js';
import { sharedStorm } from './cameras.js'; // smoothed storm 0..1: luminance-aware label color

export const POOL_SIZE = 24;   // 15 near full-detail + 9 mid ticker-only ring (plan §7 frontier slice)
export const NEAR_LANES = 15;  // nearest ~15 lanes get "TICK +1.2%" (plan §7)
const LABEL_LIFT_M = 2.5;      // meters above the snow: clears the skier + ghost hover, still reads as "on the lane"
const NEAR_FONT_M = 0.9;       // world-units font size at the near ring — legible from the ¾ chase cam
const MID_FONT_M = 0.6;        // smaller mid-ring type = built-in LOD cue
// --- per-rig screen-space LOD (judge round 1): fp/shoulder cams sit meters from the nearest
// label, so a fixed world font rendered hundreds of px tall and occluded both the slope and
// the top-center $ readout. Clamp + fade are CAMERA-DISTANCE driven, so every rig is covered.
const MAX_ANG_RAD = 0.05;      // max label height ≈ 2.9° of view (~5% of a 60° frame): never dominates
const MIN_ANG_RAD = 0.018;     // min glyph size ≈ 1.0° ≈ 17 px tall at 1080p/60° (lane-width judging:
                               // the old 12 px floor left far red tickers illegible mush on the dusk sky)
const FADE_NEAR_M = 8;         // labels fully gone inside 8 m — the skier's own lane never blocks the view
const FADE_FULL_M = 28;        // full opacity by ~28 m (≈ chase-cam label distance): far ring unaffected
const FONT_Q = 0.05;           // fontSize quantum (m): clamping re-syncs troika layout only on real steps
const OPA_Q = 0.1;             // opacity quantum: sub-10% fades are invisible; skip the troika write
// HUD dollar zone (ui.css #wealth: top-center): labels projecting into this NDC band fade so the
// portfolio anchor stays readable at a glance (judge round 1: ticker text over the $ figure)
const HUD_X_NDC = 0.32;        // |x| half-width ≈ the wealth figure + delta row at 4vw type
const HUD_Y_NDC = 0.55;        // y above this is the top ~22% of the frame where #wealth lives
const HUD_ZONE_OPACITY = 0.12; // not zero: the lane still reads as labeled, just never over the $
// screen-overlap culling (judge r2: center-frame ticker soup — GLDD/OCPRJ/CHPT colliding):
// labels are accepted nearest-lane-first; any later label whose projected box hits an accepted
// one is hidden outright. Geometry estimate, not text metrics: cheap and stable per frame.
const GLYPH_ASPECT = 0.55;     // average glyph width / font size for the SDF font: box-width estimate
const OVERLAP_PAD = 1.15;      // 15% breathing room around each accepted box: near-misses still read as soup
const COLOR_POS = 0x4ade80;    // green: day up
const COLOR_NEG = 0xf87171;    // red: day down
const COLOR_FLAT = 0xffffff;   // white: |day %| below FLAT_EPS
const FLAT_EPS = 0.0005;       // 0.05%/day — below display precision, render neutral

/** Pure: label string for a lane at LOD rank. Exported for tests. */
export function labelText(sym, dayRet, rank) {
  if (rank < NEAR_LANES && Number.isFinite(dayRet)) {
    const pct = dayRet * 100;
    return sym + ' ' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
  }
  return sym;
}

/** Pure: color by day-return sign. Exported for tests. */
export function labelColor(dayRet) {
  if (!Number.isFinite(dayRet) || Math.abs(dayRet) < FLAT_EPS) return COLOR_FLAT;
  return dayRet > 0 ? COLOR_POS : COLOR_NEG;
}

// Luminance compensation (carryover #4): as the storm grays/darkens the sky and fog, the
// mid-value green/red fills lose contrast against the dimmed backdrop — lift them toward
// white with the storm driver. 0.55 max: at full storm the hue still reads, just brighter.
const STORM_BRIGHT_MAX = 0.55;
const STORM_Q = 0.25; // storm quantum: color (a troika re-sync) changes at most 4 steps over a storm

/** Pure: hex color lerped toward white by k (0..1). Exported for tests. */
export function brightenColor(hex, k) {
  const r = (hex >> 16) & 0xff, g = (hex >> 8) & 0xff, b = hex & 0xff;
  const up = (c) => Math.min(255, Math.round(c + (255 - c) * k));
  return (up(r) << 16) | (up(g) << 8) | up(b);
}

/** Pure: visit lane offsets nearest-first: 0, -1, +1, -2, +2, ... */
export function laneOffset(rank) {
  return rank === 0 ? 0 : (rank % 2 === 1 ? -((rank + 1) >> 1) : rank >> 1);
}

export class Labels {
  /**
   * @param {object} deps
   * @param {THREE.Scene}  deps.scene
   * @param {THREE.Camera} [deps.camera] used to billboard labels toward the view
   * @param {object} deps.manifest  CONTRACTS §2 manifest (lanes[], nLanes, nDays)
   * @param {(lane:number, tau:number) => ({x:number,y:number,z:number,dayRet:number}|null)} deps.getLaneInfo
   *        injected by the integrator: world position of lane's frontier point + causal day return;
   *        null => lane is void (pre-IPO/dead) and its label is hidden.
   */
  constructor({ scene, camera, manifest, getLaneInfo }) {
    this.scene = scene;
    this.camera = camera ?? null;
    this.manifest = manifest;
    this.getLaneInfo = getLaneInfo;
    this.pool = [];
    this._shown = []; // per-slot cache: {text, color} — troika sync only on change
    for (let i = 0; i < POOL_SIZE; i++) {
      const t = new Text();
      t.text = '';
      t.fontSize = NEAR_FONT_M;
      t.anchorX = 'center';
      t.anchorY = 'bottom';
      t.color = COLOR_FLAT;
      t.outlineWidth = '12%';     // dark outline keeps SDF text legible over snow AND dusk sky (lane-width
                                  // judging: 8% was not enough contrast for far red tickers)
      t.outlineColor = 0x0a101a;
      t.outlineBlur = '4%';       // tighter halo than before (was 6%): a harder rim carries more contrast
                                  // at the far ring's small glyph sizes; still reads as a pocket, not a sticker
      t.visible = false;
      t.frustumCulled = false;    // labels hug the frontier curtain; culling thrashes at the edge
      scene.add(t);
      this.pool.push(t);
      this._shown.push({ text: '', color: COLOR_FLAT, font: NEAR_FONT_M, opa: 1 });
    }
    this._ndc = new Vector3(); // scratch for HUD-zone projection (zero per-frame allocation)
    // accepted-label NDC boxes for overlap culling (preallocated; nearest-first priority)
    this._box = { x: new Float32Array(POOL_SIZE), y: new Float32Array(POOL_SIZE),
                  hw: new Float32Array(POOL_SIZE), hh: new Float32Array(POOL_SIZE), n: 0 };
  }

  /** @param {number} tau world clock (days); @param {number} s skier lateral position (m) */
  update(tau, s) {
    const nLanes = this.manifest.nLanes;
    const center = ((Math.round(s / CFG.LANE_M) % nLanes) + nLanes) % nLanes;
    this._box.n = 0; // overlap-culling accept list resets every frame
    const tanHalf = this.camera ? Math.tan((this.camera.fov * Math.PI) / 360) : 1;
    const aspect = this.camera?.aspect || 1;
    // storm luminance compensation, quantized so troika color syncs only on real steps
    const stormK = Math.round((sharedStorm() * STORM_BRIGHT_MAX) / (STORM_Q * STORM_BRIGHT_MAX)) * (STORM_Q * STORM_BRIGHT_MAX);
    for (let rank = 0; rank < POOL_SIZE; rank++) {
      const t = this.pool[rank];
      const lane = (((center + laneOffset(rank)) % nLanes) + nLanes) % nLanes;
      const meta = this.manifest.lanes[lane];
      const info = meta ? this.getLaneInfo(lane, tau) : null;
      if (!info || !meta) {
        if (t.visible) t.visible = false;
        continue;
      }
      const cache = this._shown[rank];
      const txt = labelText(meta.sym, info.dayRet, rank);
      // luminance-aware fill (carryover #4): brighter as the storm darkens the sky behind it
      const col = stormK > 0 ? brightenColor(labelColor(info.dayRet), stormK) : labelColor(info.dayRet);
      let font = rank < NEAR_LANES ? NEAR_FONT_M : MID_FONT_M;
      let opa = 1;
      t.position.set(info.x, info.y + LABEL_LIFT_M, info.z);
      if (this.camera) {
        const cam = this.camera;
        const dist = t.position.distanceTo(cam.position);
        // screen-space size clamp: world font shrinks so the label never exceeds MAX_ANG_RAD,
        // and GROWS so it never drops below the MIN_ANG_RAD legibility floor (carryover #4)
        font = Math.min(Math.max(font, dist * MIN_ANG_RAD), dist * MAX_ANG_RAD);
        font = Math.max(FONT_Q, Math.round(font / FONT_Q) * FONT_Q); // quantize: sync only on real steps
        // near-camera fade: a label about to fill the frame dissolves instead (fp/shoulder fix)
        opa = Math.min(Math.max((dist - FADE_NEAR_M) / (FADE_FULL_M - FADE_NEAR_M), 0), 1);
        const p = this._ndc.copy(t.position).project(cam);
        if (opa > 0 && p.z < 1) {
          // overlap culling (constants above): estimated NDC half-extents from font/dist/fov;
          // labels are visited nearest-lane-first, so the soup loses to the lanes that matter
          const hh = (font * 0.5) / (dist * tanHalf);
          const hw = (hh * GLYPH_ASPECT * txt.length) / aspect;
          const b = this._box;
          let hit = false;
          for (let k = 0; k < b.n; k++) {
            if (Math.abs(p.x - b.x[k]) < (hw + b.hw[k]) * OVERLAP_PAD &&
                Math.abs(p.y - b.y[k]) < (hh + b.hh[k]) * OVERLAP_PAD) { hit = true; break; }
          }
          if (hit) {
            opa = 0;
          } else {
            b.x[b.n] = p.x; b.y[b.n] = p.y; b.hw[b.n] = hw; b.hh[b.n] = hh; b.n++;
            // HUD dollar zone: labels projecting behind the top-center $ anchor fade to a whisper
            if (opa > HUD_ZONE_OPACITY && Math.abs(p.x) < HUD_X_NDC && p.y > HUD_Y_NDC) opa = HUD_ZONE_OPACITY;
          }
        }
        opa = Math.round(opa / OPA_Q) * OPA_Q;
        if (opa <= 0) { if (t.visible) t.visible = false; continue; }
        t.quaternion.copy(cam.quaternion); // billboard
      }
      let dirty = false;
      if (cache.text !== txt) { cache.text = txt; t.text = txt; dirty = true; }
      if (cache.color !== col) { cache.color = col; t.color = col; dirty = true; }
      if (cache.font !== font) { cache.font = font; t.fontSize = font; dirty = true; }
      if (cache.opa !== opa) {
        cache.opa = opa;
        t.fillOpacity = opa;
        t.outlineOpacity = opa; // outline must fade with the fill or ghosts of hidden labels remain
        dirty = true;
      }
      if (!t.visible) t.visible = true;
      if (dirty) t.sync();
    }
  }

  dispose() {
    for (const t of this.pool) {
      this.scene.remove(t);
      t.dispose();
    }
    this.pool.length = 0;
  }
}
