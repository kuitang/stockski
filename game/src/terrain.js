// terrain.js — height composition (plateau/margin smoothstep, plan §1) + per-tile THREE meshes.
// heightAt is the single height authority: physics and meshes both sample it, so the skier
// rides exactly the surface that renders. Void (pre-IPO / post-death) = NaN = skipped triangles.

import * as THREE from 'three';
import { CFG } from './config.js';
import { PREFETCH_DAYS, VIEW_LANES } from './stream.js';
import { SNOW_TEX_TILE_M } from './visuals.js';

const A2 = CFG.ALPHA_PLATEAU / 2;     // plateau half-width in lane units (plan §1)
const MARGIN = 1 - CFG.ALPHA_PLATEAU; // margin width between adjacent plateaus in lane units

/**
 * CONTRACTS §3: height + analytic partials at lateral s (m), fractional day dayF.
 * Lane i's plateau is centered at s = (i + 0.5)·LANE_M; margin midpoints sit at integer s.
 * Returns {h, dh_ds, dh_dt, lane, u}; h is NaN over void.
 */
export function heightAt(s, dayF, stream) {
  const n = stream.manifest.nLanes;
  const sl = (((s / CFG.LANE_M) % n) + n) % n; // lane axis wraps: cylinder topology (plan §0)
  const p = Math.floor(sl - 0.5);
  const q = sl - 0.5 - p; // 0 at lane p's plateau center, 1 at lane p+1's center
  const i = ((p % n) + n) % n;
  const j = (i + 1) % n;
  let u, du_dq;
  if (q <= A2) {
    u = 0; du_dq = 0;                  // inner plateau: 100% lane i (plan §1)
  } else if (q >= 1 - A2) {
    u = 1; du_dq = 0;                  // inner plateau: 100% lane j
  } else {
    const ur = (q - A2) / MARGIN;
    u = ur * ur * (3 - 2 * ur);        // smoothstep blend u = 3u_r² − 2u_r³ (plan §1)
    du_dq = (6 * ur * (1 - ur)) / MARGIN;
  }
  const zi = u < 1 ? stream.zLaneDeriv(i, dayF) : { z: 0, dz: 0 }; // unused side weighted by 0
  const zj = u > 0 ? stream.zLaneDeriv(j, dayF) : { z: 0, dz: 0 };
  const K = CFG.K_HEIGHT;
  const h = K * ((1 - u) * zi.z + u * zj.z);
  const dh_ds = (K * du_dq * (zj.z - zi.z)) / CFG.LANE_M;     // TRUE geometry; physics saturates forces, not us (plan §3)
  const dh_dt = K * ((1 - u) * zi.dz + u * zj.dz);            // m per trading day
  // lane is ALWAYS the left lane i of the blend pair: u is the blend toward lane+1, exactly
  // the convention physics' wealth identity assumes (plan §2.1) — returning j for u ≥ 0.5
  // would make physics accrue the WRONG pair of lanes over half the lateral domain.
  // The dominant holding for display purposes is lane + (u >= 0.5 ? 1 : 0).
  return { h, dh_ds, dh_dt, lane: i, u };
}

/**
 * One THREE.BufferGeometry per (time-tile, lane-tile). Vertex grid: integer days ×
 * 3 lateral samples per lane (margin midpoint + both plateau edges — the minimum that
 * renders plateau/margin exactly, since plateaus are flat and the margin midpoint pins
 * the smoothstep's center). Void = skipped triangles. Day strips are revealed by
 * drawRange as τ advances; the snow shader additionally discards fragments at z < −τ
 * so the visible snow edge is EXACTLY the frontier.
 */
export class TerrainTiles {
  constructor(scene, stream, material) {
    this.scene = scene;
    this.stream = stream;
    this.material = material;
    this.recs = new Map(); // "T_L" -> {mesh, rowEnd, startDay, quadRows, centerX, stitched, T, L}
    // dispose mesh + geometry when the stream evicts a tile from its LRU (task spec)
    stream.onEvict = (_key, { T, L }) => this._dispose(`${T}_${L}`);
  }

  /** Create/reveal/dispose tile meshes for the window [τ−PREFETCH_DAYS, τ] × ±VIEW_LANES of sCenter. */
  update(tau, sCenter) {
    const st = this.stream;
    const m = st.manifest;
    const n = m.nLanes;
    const span = n * CFG.LANE_M;
    const dayHi = Math.min(Math.floor(tau), m.nDays - 1);
    if (dayHi < 0) return;
    const dayLo = Math.max(0, dayHi - PREFETCH_DAYS);
    const tLo = Math.floor(dayLo / st.td);
    const tHi = Math.floor(dayHi / st.td);
    const cLane = (((sCenter / CFG.LANE_M) % n) + n) % n;
    const lLo = Math.floor((cLane - VIEW_LANES) / st.tl);
    const lHi = Math.floor((cLane + VIEW_LANES) / st.tl);
    const want = new Set();
    for (let T = tLo; T <= tHi; T++) {
      if (T * st.td > tau) continue; // belt-and-braces causality at geometry layer (plan §4.5)
      for (let L0 = lLo; L0 <= lHi; L0++) {
        const L = ((L0 % st.nLaneTiles) + st.nLaneTiles) % st.nLaneTiles;
        const key = `${T}_${L}`;
        want.add(key);
        const rec = this.recs.get(key);
        if (!rec) {
          if (this._buildable(T, L)) this._build(T, L);
        } else if (!rec.stitched && this._stitchReady(T, L)) {
          this._dispose(key); // next tile arrived: rebuild including the shared boundary row
          this._build(T, L);
        }
      }
    }
    for (const key of [...this.recs.keys()]) {
      if (!want.has(key)) this._dispose(key);
    }
    for (const rec of this.recs.values()) {
      // reveal day strips: quad row r (days startDay+r .. +r+1) appears once τ enters it;
      // the shader frontier-clips at z = −τ so no fragment beyond τ ever shows
      const vis = Math.max(0, Math.min(Math.floor(tau) - rec.startDay + 1, rec.quadRows));
      rec.mesh.geometry.setDrawRange(0, rec.rowEnd[vis]);
      rec.mesh.visible = vis > 0;
      // lane axis wraps: park each mesh at the image of its lane range nearest the skier
      rec.mesh.position.x = span * Math.round((sCenter - rec.centerX) / span);
    }
  }

  _neighbors(T, L) {
    const nLT = this.stream.nLaneTiles;
    return [(L - 1 + nLT) % nLT, (L + 1) % nLT];
  }

  // boundary columns blend with lanes one over => the adjacent lane-tiles must be resident
  _buildable(T, L) {
    const st = this.stream;
    if (!st.hasTile(T, L)) return false;
    const [lm, lp] = this._neighbors(T, L);
    return st.hasTile(T, lm) && st.hasTile(T, lp);
  }

  // the stitch row (first day of tile T+1) is buildable once T+1 and its lane neighbors are resident
  _stitchReady(T, L) {
    const st = this.stream;
    const [lm, lp] = this._neighbors(T, L);
    return st.hasTile(T + 1, L) && st.hasTile(T + 1, lm) && st.hasTile(T + 1, lp);
  }

  _build(T, L) {
    const st = this.stream;
    const m = st.manifest;
    const td = st.td;
    const tl = st.tl;
    const startDay = T * td;
    const lastEraDay = m.nDays - 1;
    const wantStitch = startDay + td <= lastEraDay;
    const canStitch = wantStitch && this._stitchReady(T, L);
    // include the next tile's first day row when possible so tiles share an edge (C0 in time)
    const endDay = canStitch ? startDay + td : Math.min(startDay + td - 1, lastEraDay);
    const rows = endDay - startDay + 1;
    if (rows < 2) return;
    const lane0 = L * tl;
    const W = 3 * tl + 1; // 3 samples/lane + trailing margin midpoint shared with the next lane-tile
    const xs = new Float64Array(W);
    for (let l = 0; l < tl; l++) {
      xs[3 * l] = lane0 + l;              // margin midpoint (u = 0.5 between lanes l−1 and l)
      xs[3 * l + 1] = lane0 + l + 0.5 - A2; // left plateau edge of lane l
      xs[3 * l + 2] = lane0 + l + 0.5 + A2; // right plateau edge of lane l
    }
    xs[W - 1] = lane0 + tl;

    const pos = new Float32Array(rows * W * 3);
    const uv = new Float32Array(rows * W * 2); // planar world (x, z)/SNOW_TEX_TILE_M for the snow texture set
    const voidMask = new Uint8Array(rows * W);
    for (let r = 0; r < rows; r++) {
      const day = startDay + r;
      for (let c = 0; c < W; c++) {
        const q = heightAt(xs[c] * CFG.LANE_M, day, st);
        const k = r * W + c;
        const bad = Number.isNaN(q.h);
        pos[3 * k] = xs[c] * CFG.LANE_M;
        pos[3 * k + 1] = bad ? 0 : q.h; // parked at 0, never referenced by an index (keeps normals/bounds finite)
        pos[3 * k + 2] = -day * CFG.DAY_M; // CONTRACTS §3: world z = −day
        // pre-translation (s, −day) coords: wraparound parking moves meshes by span = nLanes·LANE_M,
        // a multiple of TILE_LANES = 128 m, i.e. an integer number of 4 m texture repeats — seam-safe
        uv[2 * k] = pos[3 * k] / SNOW_TEX_TILE_M;
        uv[2 * k + 1] = pos[3 * k + 2] / SNOW_TEX_TILE_M;
        if (bad) voidMask[k] = 1;
      }
    }

    // index buffer ordered by day row, with per-row prefix counts so drawRange reveals whole strips
    const idx = [];
    const rowEnd = [0];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < W - 1; c++) {
        const a = r * W + c;
        const b = a + 1;
        const d = a + W;
        const e = d + 1;
        if (voidMask[a] || voidMask[b] || voidMask[d] || voidMask[e]) continue; // void = crevasse (plan §7)
        idx.push(a, e, d, a, b, e); // CCW seen from +y: normals point up
      }
      rowEnd.push(idx.length);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geo, this.material);
    this.scene.add(mesh);
    this.recs.set(`${T}_${L}`, {
      mesh,
      rowEnd,
      startDay,
      quadRows: rows - 1,
      centerX: (lane0 + tl / 2) * CFG.LANE_M,
      stitched: canStitch || endDay === lastEraDay, // era end: nothing left to stitch
      T,
      L,
    });
  }

  _dispose(key) {
    const rec = this.recs.get(key);
    if (!rec) return;
    this.scene.remove(rec.mesh);
    rec.mesh.geometry.dispose(); // free GPU buffers on eviction (task spec)
    this.recs.delete(key);
  }

  dispose() {
    for (const key of [...this.recs.keys()]) this._dispose(key);
  }
}
