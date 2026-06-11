// visuals.js — sky gradient, lights, snow material (slope tint + frontier clip + fresh-snow
// shimmer), and the placeholder skier mesh (plan §7 visual language: Alto's-Adventure minimalism).

import * as THREE from 'three';
import { CFG } from './config.js';

/** Gradient sky: huge inverted sphere, white storm horizon -> pale alpine blue zenith.
 *  Caller re-centers it on the camera each frame (sky is at infinity, never parallaxes). */
export function setupSky(scene) {
  const sky = new THREE.Mesh(
    // 4000 m radius: beyond the fog far plane and any terrain, inside the camera far plane
    new THREE.SphereGeometry(4000, 16, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x9db8e8) }, // pale alpine zenith
        bot: { value: new THREE.Color(0xf6f8fc) }, // storm-white horizon merges with the whiteout
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 top, bot;
        void main() {
          // 1.4/+0.25: horizon band sits slightly below eye level so the whiteout wraps the view
          float t = clamp(normalize(vDir).y * 1.4 + 0.25, 0.0, 1.0);
          gl_FragColor = vec4(mix(bot, top, t), 1.0);
        }`,
    })
  );
  sky.frustumCulled = false; // always surrounds the camera
  scene.add(sky);
  return sky;
}

/** Hemisphere (cool sky over snow bounce) + one warm low sun raking across the day strips. */
export function setupLights(scene) {
  const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x8a94a8, 0.9); // 0.9: snow is mostly ambient-lit under overcast
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);           // 1.6: enough contrast to read slope shading
  sun.position.set(120, 200, 80); // direction only (directional light): high warm sun, slightly behind-right
  scene.add(hemi, sun);
  return { hemi, sun };
}

/** One snow-texture repeat per 4×4 world m (lanes are 1 m): small enough that grain reads
 *  at skiing speed, large enough to avoid moire/banding at distance. terrain.js divides
 *  world (x, z) by this when writing the uv attribute. */
export const SNOW_TEX_TILE_M = 4;

/**
 * Snow PBR texture set (ambientCG Snow005, CC0 — see game/public/textures/snow/README.md),
 * loaded async and attached to the material when ALL maps arrive. If any fetch fails the
 * material simply stays untextured (mobile/offline fallback — no hard dependency).
 */
function loadSnowTextures(material) {
  const loader = new THREE.TextureLoader();
  const one = (file, srgb) =>
    new Promise((resolve, reject) => {
      loader.load(
        `textures/snow/${file}`,
        (tex) => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping; // planar world UVs tile forever
          tex.anisotropy = 4; // cheap, big sharpness win at the grazing angles a chase cam lives at
          if (srgb) tex.colorSpace = THREE.SRGBColorSpace; // albedo is authored sRGB; data maps stay linear
          resolve(tex);
        },
        undefined,
        reject
      );
    });
  Promise.all([
    one('Snow005_1K_Color.jpg', true),
    one('Snow005_1K_NormalGL.jpg', false),   // GL convention — what Three.js expects
    one('Snow005_1K_Roughness.jpg', false),
  ])
    .then(([map, normalMap, roughnessMap]) => {
      material.map = map;
      material.normalMap = normalMap;
      // 0.4: micro-grain only — terrain geometry carries the macro shape (task spec)
      material.normalScale.set(0.4, 0.4);
      material.roughnessMap = roughnessMap; // multiplies the 0.92 base: dry snow stays diffuse
      material.needsUpdate = true; // recompile with USE_MAP etc.; onBeforeCompile re-applies our patches
    })
    .catch(() => {}); // untextured fallback is the material as constructed
}

/**
 * Snow-white standard material with three shader extensions:
 *  1. slope tint — steeper faces shade toward blue ice (plan §7); applied MULTIPLICATIVELY
 *     after map_fragment so the albedo texture grain survives on steep faces;
 *  2. frontier clip — fragments at world z < −τ·DAY_M are discarded, so the visible snow
 *     edge IS the frontier and nothing beyond τ can ever render (plan §4.5);
 *  3. fresh-snow shimmer — emissive boost on the newest ~2 day-strips, fading as they age.
 * Plus a CC0 snow PBR texture set (albedo/normal/roughness), loaded async with an
 * untextured fallback. Returns {material, uniforms}; frontier.js drives uniforms.uTau.
 */
export function makeSnowMaterial() {
  const uniforms = { uTau: { value: 0 } };
  const material = new THREE.MeshStandardMaterial({
    color: 0xf7fafd,  // near-white with a cold cast — pure white clips under the sun
    roughness: 0.92,  // dry snow: almost fully diffuse
    metalness: 0.0,
  });
  loadSnowTextures(material);
  const dayM = CFG.DAY_M.toFixed(4); // world z = −day·DAY_M (CONTRACTS §3)
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTau = uniforms.uTau;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vSnowWp;\nvarying float vSnowUp;'
      )
      .replace(
        '#include <beginnormal_vertex>',
        // tiles are translated only (never rotated), so objectNormal.y IS world up-ness
        '#include <beginnormal_vertex>\nvSnowUp = objectNormal.y;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvSnowWp = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vSnowWp;\nvarying float vSnowUp;\nuniform float uTau;'
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `// frontier clip: the future does not exist (plan §4.5)
        if (vSnowWp.z < -uTau * ${dayM}) discard;
        #include <clipping_planes_fragment>`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // slope-based tint: steeper = bluer ice (plan §7); 0.12..0.65 up-ness band, 0.85 max blend.
          // MULTIPLICATIVE (color_fragment runs after map_fragment): texture grain survives the tint;
          // (0.60, 0.72, 0.90) ≈ old constant / the near-white base, so the untextured look is unchanged.
          float steep = clamp(1.0 - vSnowUp, 0.0, 1.0);
          diffuseColor.rgb *= mix(vec3(1.0), vec3(0.60, 0.72, 0.90), smoothstep(0.12, 0.65, steep) * 0.85);
        }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // fresh-snow shimmer: full glow for the newest day-strip, gone by age 2 (task spec)
          float age = uTau + vSnowWp.z / ${dayM}; // days since this strip fell (z = −day)
          totalEmissiveRadiance += vec3(0.28) * clamp(2.0 - age, 0.0, 1.0);
        }`
      );
  };
  return { material, uniforms };
}

/** Placeholder skier: small capsule body + two box skis (real model is post-v1). */
export function makeSkier() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 0.9, 4, 12), // ~1.6 m silhouette at 1 m lane scale
    new THREE.MeshStandardMaterial({ color: 0xd84a2f, roughness: 0.6 }) // warm red: pops against snow + ice blue
  );
  body.position.y = 1.0; // capsule center: feet at the group origin (terrain height)
  g.add(body);
  const skiMat = new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.4 });
  for (const dx of [-0.22, 0.22]) { // hip-width stance
    const ski = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 1.8), skiMat); // ~1.8 m skis
    ski.position.set(dx, 0.025, -0.25); // tips forward: travel direction is −z (CONTRACTS §3)
    g.add(ski);
  }
  return g;
}
