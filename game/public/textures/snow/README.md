# Snow texture sets

License: CC0 1.0 (public domain) — https://docs.ambientcg.com/license/

Two sets ship for A/B (`?snowtex=Snow005|Snow006`, see `src/visuals.js`); the DEFAULT
(winner by screenshot A/B, 2026-06) is **Snow006** — its normal map carries real
wind-sculpted drift relief where Snow005 is uniform fine noise that reads flat.

- "Snow 005" — https://ambientcg.com/view?id=Snow005 (`Snow005_1K-JPG.zip`)
- "Snow 006" — https://ambientcg.com/view?id=Snow006 (`Snow006_1K-JPG.zip`)

Kept maps per set (1K JPG): `*_Color.jpg` (albedo, sRGB), `*_NormalGL.jpg` (normal,
OpenGL convention — the one Three.js expects), `*_Roughness.jpg`.

Other maps from the zips (displacement, AO, DirectX normal, .blend/.usdc/.mtlx) were
discarded — terrain geometry carries the macro shape; these are micro-grain detail only.

Measured mean LINEAR albedo (drives the in-shader fresh-snow albedo boost + the
detail-octave normalizer in `visuals.js`): Snow005 ≈ 0.30, Snow006 ≈ 0.58.

Textures are OPTIONAL at runtime: visuals.js falls back to the untextured snow material
if any map fails to load (no hard dependency, mobile/offline safe).
