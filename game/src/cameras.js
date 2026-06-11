// cameras.js — four selectable camera rigs: chase (baseline ¾), drone (market-map overview),
// fp (first person), shoulder (SSX-style low chase). One class owns the camera every frame;
// main.js only constructs it, calls setMode() (keys 1–4 / ?cam= / __ski.setCam) and update().
// Chase geometry stays in CFG.CAM (config.js); all OTHER rig constants live here (style rule:
// every magic number gets a one-line justification).
//
// FP lateral-context decision (task spec asked for documentation): at a true 1.7 m eye height
// the neighboring 1 m-wide lane plateaus occlude each other — with K_HEIGHT=25 adjacent lanes
// differ by multiple meters, so head-height fp sees only your own lane's walls. We ship the
// "tall skier" compromise: EYE=2.8 m clears the adjacent ridgeline (≈1 lane-step of extra
// height) so ±2–3 neighbor lanes' ridges/valleys stay readable, and FOV=75° pulls those
// neighbors into the periphery. Pure 1.7 m + 60° was tried mentally against the geometry and
// rejected: it reads as skiing in a slot canyon with zero market context.

import * as THREE from 'three';
import { CFG } from './config.js';

export const CAM_MODES = ['chase', 'drone', 'fp', 'shoulder'];

const DRONE = {
  FOV: 55,    // narrower than chase (60): flattens perspective so lanes read as a market map, not a canyon
  BACK: 45,   // m behind the skier; with UP=110 the cam-to-skier depression is atan(110/45) ≈ 68°
  UP: 110,    // m above: skier is ~119 m away — small in frame, terrain-map readability extreme
  SIDE: 0,    // dead-centered: the overview is about the lane grid; lateral skew would shear the map read
  AHEAD: 15,  // look-at 15 days past the frontier: view pitch atan(110/60) ≈ 61° — inside the 55–65° band
  DROP: 0,    // look-at at skier height: the whiteout band fills the top of frame, map fills the rest
  DAMP: 0.35, // per-second residual (heavy damping): the overview drifts like a weather cam, never twitches
};

const SHOULDER = {
  FOV: 70,     // SSX-style wide-ish lens: terrain towers and streams past in the periphery
  BACK: 3.5,   // task spec 3–4 m back: close enough that lane walls fill the frame
  UP: 1.5,     // task spec: just over the shoulder — slope reads at skier eye level
  SIDE: 0.6,   // slight over-the-shoulder offset so the skier body doesn't dead-center-block the lane ahead
  AHEAD: 10,   // look 10 days out: near-horizon framing, whiteout dead ahead at speed
  DROP: 1.0,   // m below skier: tips the frame down just enough to keep snow in the lower half
  DAMP: 0.0002, // tighter than chase (0.0008): a 3.5 m cam must track carves near-rigidly or the skier exits frame
};

const FP = {
  FOV: 75,  // wide lens: brings neighbor-lane ridges into the periphery (lateral-context fix, header note)
  EYE: 2.8, // "tall skier" eye height in m — see header note; 1.7 m true-head occludes all lateral context
  AHEAD: 12, // look-at 12 days ahead: frames the frontier curtain + the next ~10–15 days' slope band
  DROP: 4,   // look-at 4 m below eye: pitch atan(4/12) ≈ 18° down — slope readable, horizon still in frame
  ROLL_MAX: 6 * Math.PI / 180,  // comfort cap on carve lean (task spec ~6°): beyond this fp rolls nauseate
  ROLL_PER_VS: 0.012,           // rad of roll per m/s lateral speed: hits the 6° cap near hard-carve speeds (~9 m/s)
  ROLL_DAMP: 0.02,              // per-second residual on roll easing: lean follows the carve with no head-snap
  SHAKE_RAD: 0.006,             // max angular jitter ≈ 0.34°: felt as speed, safely below discomfort
  SHAKE_SLOPE_REF: 2.5,         // |dh/dday·w| (m/day) for full shake ≈ a |10%| daily move at K=25 — crash/rally days only
  SHAKE_HZ1: 11, SHAKE_HZ2: 17, // incommensurate jitter frequencies: reads as rumble, not metronome wobble
};

// fp ski meshes, camera-local space (camera looks down −z): tips visible at frame bottom (task spec)
const FP_SKI = {
  X: 0.16,            // half stance width: hip-width at the ~arm's-length scale the camera sees skis
  Y: -1.35, Z: -1.1,  // hung low/forward: at FOV 75 the skis occupy the bottom ~15% of frame, never the slope read
  W: 0.10, H: 0.04, LEN: 1.9, // ≈ real ski proportions at the 1 m lane scale used by makeSkier()
  TIP_UP: 4 * Math.PI / 180,  // slight tip rise so the boxes silhouette as skis, not planks
};

// drone whiteout-to-black horizon band (task spec): a gradient quad past the frontier
const BAND = {
  DIST: 80,     // m beyond the frontier: past every look-at point, far inside the 4000 m sky sphere
  W: 1600,      // covers the drone frustum at ~200 m view distance (~230 m needed) with wide margin for damping drift
  H: 500,       // tall enough that neither gradient edge is visible at the 55–65° drone pitch
  Y_CENTER: 120, // band center this far above the skier: the white→black ramp spans the visible top of frame
};

function makeFpSkis() {
  const g = new THREE.Group();
  // MeshBasicMaterial: camera-mounted props must not depend on world light direction
  const mat = new THREE.MeshBasicMaterial({ color: 0x222831 }); // same dark slate as the body skis
  for (const dx of [-FP_SKI.X, FP_SKI.X]) {
    const ski = new THREE.Mesh(new THREE.BoxGeometry(FP_SKI.W, FP_SKI.H, FP_SKI.LEN), mat);
    ski.position.set(dx, FP_SKI.Y, FP_SKI.Z);
    ski.rotation.x = FP_SKI.TIP_UP;
    g.add(ski);
  }
  return g;
}

function makeBand() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(BAND.W, BAND.H), // faces +z by default — toward the camera behind the skier
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false, // overlay on the sky: must never punch holes in the depth buffer
      fog: false,
      uniforms: {
        white: { value: new THREE.Color(0xf6f8fc) }, // matches scene background: band grows OUT of the whiteout
        black: { value: new THREE.Color(0x10141d) }, // near-black storm slate, not pure black (keeps alpine palette)
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform vec3 white, black;
        void main() {
          // 0.25→0.85: color ramp sits in the band's upper half — whiteout below, black storm above
          float t = smoothstep(0.25, 0.85, vUv.y);
          // 0.05→0.35: alpha-in over the lower edge so the band dissolves seamlessly into the whiteout
          float a = smoothstep(0.05, 0.35, vUv.y);
          gl_FragColor = vec4(mix(white, black, t), a);
        }`,
    })
  );
  mesh.frustumCulled = false; // always cheap (one quad) and must never pop at frame edges
  return mesh;
}

export class CameraRig {
  /**
   * @param {object} o
   * @param {THREE.PerspectiveCamera} o.camera
   * @param {THREE.Scene} o.scene
   * @param {THREE.Object3D} o.skierMesh  hidden while in fp mode
   * @param {object} [o.chase]            chase rig geometry (defaults to CFG.CAM)
   * @param {(s:number, dayF:number) => {dh_dt:number}} [o.terrainFn] slope probe for fp speed-shake
   */
  constructor({ camera, scene, skierMesh, chase = CFG.CAM, terrainFn = null }) {
    this.camera = camera;
    this.skierMesh = skierMesh;
    this.chase = chase;
    this.terrainFn = terrainFn;
    this.mode = 'chase';
    this._snap = true; // first update (and every mode switch) teleports instead of lerping in from origin
    this._t = 0;       // shake phase clock (render seconds)
    this._roll = 0;    // smoothed fp lean
    this._v = new THREE.Vector3();
    scene.add(camera); // camera must be in the scene graph so its fp-ski children render
    this._skis = makeFpSkis();
    this._skis.visible = false;
    camera.add(this._skis);
    this._band = makeBand();
    this._band.visible = false;
    scene.add(this._band);
    this.setMode('chase');
  }

  /** Switch rigs at runtime; returns false (and stays put) on unknown names — safe for raw ?cam=. */
  setMode(name) {
    if (!CAM_MODES.includes(name)) return false;
    this.mode = name;
    this._snap = true;
    this._roll = 0;
    this.camera.fov =
      name === 'drone' ? DRONE.FOV : name === 'fp' ? FP.FOV : name === 'shoulder' ? SHOULDER.FOV : this.chase.FOV;
    this.camera.updateProjectionMatrix();
    this._skis.visible = name === 'fp';
    this._band.visible = name === 'drone';
    if (this.skierMesh) this.skierMesh.visible = name !== 'fp'; // fp: body hidden, skis are camera-mounted
    return true;
  }

  /** Per-frame. state = physics State snapshot; tau = world clock; dt = render delta (s). */
  update(state, tau, dt) {
    this._t += dt;
    const z = -tau * CFG.DAY_M; // skier pinned to the frontier (CONTRACTS §3)
    if (this.mode === 'fp') return this._updateFp(state, z, tau, dt);

    const P = this.mode === 'drone' ? DRONE : this.mode === 'shoulder' ? SHOULDER : this.chase;
    const target = this._v.set(state.s + (P.SIDE ?? 0), state.y + P.UP, z + P.BACK);
    if (this._snap) {
      this.camera.position.copy(target);
      this._snap = false;
    } else {
      this.camera.position.lerp(target, 1 - Math.pow(P.DAMP, dt)); // frame-rate-independent smoothing
    }
    this.camera.lookAt(state.s, state.y - P.DROP, z - P.AHEAD);
    if (this.mode === 'drone') {
      // band tracks the skier so the horizon gradient is always dead ahead of the overview
      this._band.position.set(state.s, state.y + BAND.Y_CENTER, z - BAND.DIST);
    }
  }

  _updateFp(state, z, tau, dt) {
    const cam = this.camera;
    // hard lateral lock (task spec): zero positional lag — in first person, lag IS motion sickness
    cam.position.set(state.s, state.y + FP.EYE, z);
    this._snap = false;
    cam.lookAt(state.s, state.y + FP.EYE - FP.DROP, z - FP.AHEAD);
    // lean roll into the carve, eased and capped for comfort
    const rollT = THREE.MathUtils.clamp(-(state.vs ?? 0) * FP.ROLL_PER_VS, -FP.ROLL_MAX, FP.ROLL_MAX);
    this._roll += (rollT - this._roll) * (1 - Math.pow(FP.ROLL_DAMP, dt));
    cam.rotateZ(this._roll);
    // speed-shake ∝ |slope·w| (task spec): the ground rumbles when you ride a big move fully weighted
    if (this.terrainFn) {
      const q = this.terrainFn(state.s, tau);
      const sw = Math.abs((Number.isFinite(q?.dh_dt) ? q.dh_dt : 0) * (state.w ?? 0));
      const amp = FP.SHAKE_RAD * Math.min(sw / FP.SHAKE_SLOPE_REF, 1);
      if (amp > 0) {
        cam.rotateX(amp * Math.sin(this._t * FP.SHAKE_HZ1 * 2 * Math.PI));
        cam.rotateY(amp * Math.sin(this._t * FP.SHAKE_HZ2 * 2 * Math.PI));
      }
    }
  }
}
