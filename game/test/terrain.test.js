// terrain.test.js — lane-blend geometry tests for the de-knifed lateral structure
// (PLAN §1 as amended: ALPHA_PLATEAU = 0.08, runtime LANE_M via ?lanew=).
//  (1) blend formula values at α = 0.08: thin exact-track plateaus, 92% smoothstep margins
//  (2) C1 continuity at BOTH plateau edges and the margin midpoint (no knife edge anywhere)
//  (3) lateral slope dh_ds shrinks by exactly 1/LANE_M (the de-knifing mechanism)
//  (4) mesh sampling: margins get >= 5 segments so the smoothstep renders as a curve
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CFG } from '../src/config.js';
import { heightAt, TerrainTiles } from '../src/terrain.js';

const A2 = CFG.ALPHA_PLATEAU / 2;     // 0.04: plateau half-width in lane units
const MARGIN = 1 - CFG.ALPHA_PLATEAU; // 0.92: smoothstep margin width in lane units
const L = CFG.LANE_M;                 // lane-unit positions → meters: tests hold at ANY shipped width
const EPS = 1e-6;  // one-sided finite-difference step for the continuity probes
const TOL = 1e-4;  // derivative-jump tolerance: O(EPS) truncation of the one-sided differences

// stub stream: lane k's level is exactly k => u is directly readable from h/K - lane
const stream = { manifest: { nLanes: 8 }, zLaneDeriv: (lane) => ({ z: lane, dz: 0 }) };

describe('blend formula at ALPHA_PLATEAU = 0.08 (PLAN §1 amended)', () => {
  it('plateau is exactly the alpha strip: full weight on lane 3 inside, blending outside', () => {
    // lane 3's plateau spans [3.5 - A2, 3.5 + A2]; left half reports (2, u=1), right half (3, u=0)
    const w3 = (q) => (q.lane === 3 ? 1 - q.u : q.lane === 2 ? q.u : 0); // portfolio weight on lane 3
    expect(w3(heightAt((3.5 - A2 + 1e-9) * L, 0, stream))).toBe(1);
    expect(w3(heightAt(3.5 * L, 0, stream))).toBe(1);
    expect(w3(heightAt((3.5 + A2 - 1e-9) * L, 0, stream))).toBe(1);
    // just outside the strip the two-stock mixture begins immediately (user spec: no knife edge)
    expect(w3(heightAt((3.5 + A2 + 1e-3) * L, 0, stream))).toBeLessThan(1);
    expect(w3(heightAt((3.5 - A2 - 1e-3) * L, 0, stream))).toBeLessThan(1);
  });

  it('margin midpoint is the 50/50 portfolio; quarter points match u = 3ur² − 2ur³', () => {
    // margin between lanes 3 and 4 spans s in (3.5 + A2, 4.5 - A2); s = 3.5 + A2 + MARGIN*ur
    for (const ur of [0.25, 0.5, 0.75]) {
      const q = heightAt((3.5 + A2 + MARGIN * ur) * L, 0, stream);
      const u = ur * ur * (3 - 2 * ur);
      expect(q.lane).toBe(3);
      expect(q.u).toBeCloseTo(u, 12);
      expect(q.h / CFG.K_HEIGHT).toBeCloseTo(3 + u, 12); // h = K((1-u)z_i + u z_j)
    }
    expect(heightAt(4.0 * L, 0, stream).u).toBeCloseTo(0.5, 12); // integer lane-units = margin midpoint
  });

  it('C1 continuity: dh_ds matches one-sided numerics at both plateau edges + midpoint', () => {
    const h = (s) => heightAt(s, 0, stream).h;
    for (const b of [(3.5 + A2) * L, (4.5 - A2) * L, 4.0 * L]) { // right edge, next left edge, margin midpoint (meters)
      const dPlus = (h(b + EPS) - h(b)) / EPS;
      const dMinus = (h(b) - h(b - EPS)) / EPS;
      expect(Math.abs(dPlus - dMinus)).toBeLessThan(TOL); // no derivative jump: smooth shoulder
      expect(heightAt(b, 0, stream).dh_ds).toBeCloseTo((dPlus + dMinus) / 2, 3); // analytic agrees
    }
  });
});

describe('runtime LANE_M (?lanew= experiment, PLAN Amendments)', () => {
  it('heights unchanged, lateral slope dh_ds shrinks by exactly 1/LANE_M', () => {
    const saved = CFG.LANE_M;
    try {
      CFG.LANE_M = 1;
      const a = heightAt(3.8, 0, stream); // mid-margin, same lane-unit position both ways
      CFG.LANE_M = 4;
      const b = heightAt(3.8 * 4, 0, stream);
      expect(b.h).toBeCloseTo(a.h, 12);          // heights are UNCHANGED
      expect(b.u).toBeCloseTo(a.u, 12);          // same portfolio at the same lane-unit point
      expect(b.dh_ds).toBeCloseTo(a.dh_ds / 4, 12); // de-knifing: h_s scales as 1/LANE_M
    } finally {
      CFG.LANE_M = saved;
    }
  });
});

describe('mesh sampling: margins are curves, not facets', () => {
  it('builds >= 5 lateral segments inside each smoothstep margin', () => {
    // minimal one-tile stream stub satisfying TerrainTiles' surface
    const tl = 128;
    const st = {
      manifest: { nLanes: tl, nDays: 64 },
      td: 64,
      tl,
      nLaneTiles: 1,
      hasTile: () => true,
      zLaneDeriv: (lane) => ({ z: lane % 2, dz: 0 }), // alternating ridges: every margin is a slope
    };
    const scene = { add() {}, remove() {} };
    const tiles = new TerrainTiles(scene, st, new THREE.MeshBasicMaterial());
    tiles.update(63, 0);
    const rec = tiles.recs.get('0_0');
    expect(rec).toBeTruthy();
    const pos = rec.mesh.geometry.getAttribute('position');
    // first row: collect x samples strictly inside the margin between lane 0 and lane 1 plateaus
    const lo = (0.5 + A2) * CFG.LANE_M;
    const hi = (1.5 - A2) * CFG.LANE_M;
    const xs = [];
    for (let c = 0; ; c++) {
      const x = pos.getX(c);
      if (c > 0 && x <= pos.getX(c - 1)) break; // wrapped into row 2
      if (x >= lo - 1e-9 && x <= hi + 1e-9) xs.push(x);
    }
    expect(xs.length - 1).toBeGreaterThanOrEqual(5); // >= 5 segments per margin (task spec; we ship 6)
    // and the samples must include interior points, not just edges + midpoint
    const interior = xs.filter((x) => x > lo + 1e-9 && x < hi - 1e-9 && Math.abs(x - 1) > 1e-9);
    expect(interior.length).toBeGreaterThanOrEqual(4);
  });
});
