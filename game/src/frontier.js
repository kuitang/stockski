// frontier.js — the WHITEOUT (plan §7): translucent storm curtain + dense fog wall at the
// frontier z = −τ·DAY_M, scene fog tuned so nothing beyond τ resolves, and the fresh-snow
// shimmer clock (drives the snow material's uTau uniform; visuals.js owns the shader).

import * as THREE from 'three';
import { CFG } from './config.js';

const CURTAIN_W = 1600; // m: wider than the ±200-lane mesh window + camera swing — edges never visible
const CURTAIN_H = 600;  // m: |z|≈12 log-units at K=25 is ±300 m — covers any era's altitude range
const CURTAIN_AHEAD = 1.3; // m past the skier's ski tips (~1.15 m) so the plane never slices the model
const WALL_AHEAD = 6;   // m: dense backdrop a few "days" into the void — kills any silhouette beyond τ
const FOG_NEAR = 25;    // m: history within the chase view stays crisp
const FOG_FAR = 110;    // m: ≈ camera→frontier distance + the 40-day history window, then white

export class Frontier {
  /**
   * @param {THREE.Scene} scene
   * @param {{uTau:{value:number}}} [snowUniforms] from visuals.makeSnowMaterial() — shimmer + frontier clip
   */
  constructor(scene, snowUniforms = null) {
    this.snowUniforms = snowUniforms;
    this.curtain = new THREE.Mesh(
      new THREE.PlaneGeometry(CURTAIN_W, CURTAIN_H),
      new THREE.MeshBasicMaterial({
        color: 0xf4f7fb,
        transparent: true,
        opacity: 0.55,   // translucent storm curtain: the whiteout reads as weather, not a wall
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,      // the curtain IS the weather; fogging it would dim the white
      })
    );
    this.wall = new THREE.Mesh(
      new THREE.PlaneGeometry(CURTAIN_W, CURTAIN_H),
      new THREE.MeshBasicMaterial({ color: 0xfdfdff, side: THREE.DoubleSide, fog: false })
    );
    this.curtain.frustumCulled = false; // always dead ahead; culling churn not worth it
    this.wall.frustumCulled = false;
    scene.add(this.curtain, this.wall);
    // dense white fog: beyond the frontier everything dissolves into the storm (plan §7 whiteout)
    scene.fog = new THREE.Fog(0xf4f7fb, FOG_NEAR, FOG_FAR);
  }

  /**
   * @param {number} tau world clock (fractional trading days)
   * @param {number} [x] skier lateral position (m) — keeps the finite planes centered on the view
   * @param {number} [y] skier altitude (m)
   */
  update(tau, x = 0, y = 0) {
    const z = -tau * CFG.DAY_M; // CONTRACTS §3: the frontier lives at world z = −τ·DAY_M
    this.curtain.position.set(x, y, z - CURTAIN_AHEAD);
    this.wall.position.set(x, y, z - WALL_AHEAD);
    if (this.snowUniforms) this.snowUniforms.uTau.value = tau; // frontier clip + shimmer age
  }

  dispose() {
    this.curtain.geometry.dispose();
    this.curtain.material.dispose();
    this.wall.geometry.dispose();
    this.wall.material.dispose();
  }
}
