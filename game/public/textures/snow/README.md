# Snow texture set

Source: ambientCG "Snow 005" — https://ambientcg.com/view?id=Snow005
Direct download: https://ambientcg.com/get?file=Snow005_1K-JPG.zip
License: CC0 1.0 (public domain) — https://docs.ambientcg.com/license/

Kept maps (1K JPG):
- `Snow005_1K_Color.jpg` — albedo (sRGB)
- `Snow005_1K_NormalGL.jpg` — normal map, OpenGL convention (the one Three.js expects)
- `Snow005_1K_Roughness.jpg` — roughness

Other maps from the zip (displacement, DirectX normal, .blend/.usdc/.mtlx) were discarded —
terrain geometry carries the macro shape; these are micro-grain detail only.

Textures are OPTIONAL at runtime: visuals.js falls back to the untextured snow material
if any map fails to load (no hard dependency, mobile/offline safe).
