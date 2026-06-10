// ghost.js — SPY ghost skier (plan §7, CONTRACTS §3): a translucent marker hovering at
// h = K_HEIGHT * ghost.z[day] over a fixed reference lane arc, trailing a faint persistent track.
// Beating its altitude with earned altitude = beating the market (exact log-wealth comparison).

import * as THREE from 'three';
import { CFG } from './config.js';

const HOVER_M = 1.5;        // ghost floats like a w=0 skier — clearly above the snow, under the labels
const GHOST_OPACITY = 0.4;  // translucent: reference, not obstacle
const TRACK_PTS = 4096;     // preallocated track vertices; step (below) is sized so this spans the whole era
const TRACK_OPACITY = 0.25; // "faint persistent track" (plan §7)
const GHOST_COLOR = 0x9fc5ff; // pale ice-blue: reads as spectral against white snow + green/red P&L tints

/** Pure: causal ghost altitude (z, log units) at fractional day tau.
 *  Interpolates across the revealed segment [floor(tau), floor(tau)+1] — the same convention as
 *  the frontier terrain strip the player skis (plan §1 time interpolation, §4.6). Exported for tests. */
export function ghostZAt(zArr, tau) {
  const n = zArr.length;
  if (n === 0) return 0;
  const d0 = Math.min(Math.max(Math.floor(tau), 0), n - 1);
  const d1 = Math.min(d0 + 1, n - 1);
  const f = Math.min(Math.max(tau - d0, 0), 1);
  return zArr[d0] + (zArr[d1] - zArr[d0]) * f;
}

export class Ghost {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {object} deps.manifest  CONTRACTS §2 manifest — uses manifest.ghost.z and nDays
   * @param {number} [deps.refLane] fixed reference lane the ghost hovers over; defaults to the
   *        SPY lane if present in the manifest, else lane 0 (the integrator should pass the
   *        megacap-arc lane once ordering is known).
   */
  constructor({ scene, manifest, refLane }) {
    this.scene = scene;
    this.manifest = manifest;
    const spyLane = manifest.lanes ? manifest.lanes.findIndex((l) => l.sym === 'SPY') : -1;
    this.refLane = refLane ?? (spyLane >= 0 ? spyLane : 0);
    // hover x: center of the reference lane's plateau
    this._x = (this.refLane + 0.5) * CFG.LANE_M;

    // marker: capsule ~ skier silhouette; 0.35/0.9 m ~ torso proportions at 1 m lane scale
    this.mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 0.9, 4, 12),
      new THREE.MeshBasicMaterial({
        color: GHOST_COLOR,
        transparent: true,
        opacity: GHOST_OPACITY,
        depthWrite: false, // translucent marker must not punch holes in snow/labels behind it
      })
    );
    this.mesh.frustumCulled = false; // always near the frontier; culling churn not worth it
    scene.add(this.mesh);

    // persistent faint track line, preallocated; step sized so TRACK_PTS covers the full era
    this._trackStep = Math.max(0.5, (manifest.nDays ?? TRACK_PTS) / TRACK_PTS); // >= 2 pts/day cap for short eras
    this._trackPos = new Float32Array(TRACK_PTS * 3);
    this._trackCount = 0;
    this._lastTrackTau = -Infinity;
    const geo = new THREE.BufferGeometry();
    this._trackAttr = new THREE.BufferAttribute(this._trackPos, 3);
    this._trackAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._trackAttr);
    geo.setDrawRange(0, 0);
    this.track = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: TRACK_OPACITY, depthWrite: false })
    );
    this.track.frustumCulled = false; // spans the whole run; sphere recompute every frame is worse
    scene.add(this.track);
  }

  /** Current ghost world position components (also used by HUD/debug callers if handy). */
  altitudeAt(tau) {
    return CFG.K_HEIGHT * ghostZAt(this.manifest.ghost.z, tau);
  }

  /** @param {number} tau world clock in trading days */
  update(tau) {
    const h = this.altitudeAt(tau);
    const y = h + HOVER_M;
    const z = -tau * CFG.DAY_M; // CONTRACTS §3 coordinates: world z = -day
    this.mesh.position.set(this._x, y, z);

    // append a track point at fixed tau spacing (persistent; never rewritten)
    if (tau - this._lastTrackTau >= this._trackStep && this._trackCount < TRACK_PTS) {
      const i = this._trackCount * 3;
      this._trackPos[i] = this._x;
      this._trackPos[i + 1] = y;
      this._trackPos[i + 2] = z;
      this._trackCount++;
      this._lastTrackTau = tau;
      this._trackAttr.needsUpdate = true;
      this.track.geometry.setDrawRange(0, this._trackCount);
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.scene.remove(this.track);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.track.geometry.dispose();
    this.track.material.dispose();
  }
}
