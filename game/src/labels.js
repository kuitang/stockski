// labels.js — billboarded frontier ticker labels with distance LOD (plan §7, CONTRACTS §3).
// Troika SDF Text pool, reused every frame — no Text is ever created after construction.
// Dependencies are injected: manifest (lane metadata) + getLaneInfo placement callback.

import { Text } from 'troika-three-text'; // (troika Texts are THREE.Object3D — three itself not needed here)
import { CFG } from './config.js';

export const POOL_SIZE = 24;   // 15 near full-detail + 9 mid ticker-only ring (plan §7 frontier slice)
export const NEAR_LANES = 15;  // nearest ~15 lanes get "TICK +1.2%" (plan §7)
const LABEL_LIFT_M = 2.5;      // meters above the snow: clears the skier + ghost hover, still reads as "on the lane"
const NEAR_FONT_M = 0.9;       // world-units font size at the near ring — legible from the ¾ chase cam
const MID_FONT_M = 0.6;        // smaller mid-ring type = built-in LOD cue
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
      t.outlineWidth = '6%';      // thin dark outline keeps SDF text legible over white snow
      t.outlineColor = 0x0a101a;
      t.visible = false;
      t.frustumCulled = false;    // labels hug the frontier curtain; culling thrashes at the edge
      scene.add(t);
      this.pool.push(t);
      this._shown.push({ text: '', color: COLOR_FLAT, font: NEAR_FONT_M });
    }
  }

  /** @param {number} tau world clock (days); @param {number} s skier lateral position (m) */
  update(tau, s) {
    const nLanes = this.manifest.nLanes;
    const center = ((Math.round(s / CFG.LANE_M) % nLanes) + nLanes) % nLanes;
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
      const col = labelColor(info.dayRet);
      const font = rank < NEAR_LANES ? NEAR_FONT_M : MID_FONT_M;
      let dirty = false;
      if (cache.text !== txt) { cache.text = txt; t.text = txt; dirty = true; }
      if (cache.color !== col) { cache.color = col; t.color = col; dirty = true; }
      if (cache.font !== font) { cache.font = font; t.fontSize = font; dirty = true; }
      t.position.set(info.x, info.y + LABEL_LIFT_M, info.z);
      if (this.camera) t.quaternion.copy(this.camera.quaternion); // billboard
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
