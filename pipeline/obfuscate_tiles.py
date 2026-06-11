#!/usr/bin/env python
"""Obfuscate an exported era's tiles in place (CONTRACTS §2 "enc" v1).

Per-tile seeded lane shuffle + xorshift32 keystream XOR. Keys are DERIVED from
era/tile coordinates (never stored): this deters copying the integers out of a
public deployment; it is deliberately not DRM — the AGPL decoder ships in stream.js.

Usage: obfuscate_tiles.py --era-dir game/public/tiles/recent2y
Idempotent: skips eras whose manifest already carries enc.v == 1.
"""
import argparse
import json
import re
from pathlib import Path

import numpy as np

MASK = 0xFFFFFFFF
SEED_FALLBACK = 0x9E3779B9  # golden-ratio constant: any fixed nonzero value works for xorshift


def fnv1a(s: str) -> int:
    h = 2166136261
    for b in s.encode():
        h ^= b
        h = (h * 16777619) & MASK
    return h


def xs32(x: int) -> int:
    x = (x ^ (x << 13)) & MASK
    x ^= x >> 17
    x = (x ^ (x << 5)) & MASK
    return x


def keystream(seed: int, n: int) -> np.ndarray:
    x = seed or SEED_FALLBACK
    out = np.empty(n, dtype=np.uint16)
    for i in range(n):
        x = xs32(x)
        out[i] = x & 0xFFFF
    return out


def lane_perm(seed: int, tl: int) -> np.ndarray:
    x = seed or SEED_FALLBACK
    perm = np.arange(tl)
    for i in range(tl - 1, 0, -1):  # Fisher-Yates, PRNG-driven so both sides derive it identically
        x = xs32(x)
        j = x % (i + 1)
        perm[i], perm[j] = perm[j], perm[i]
    return perm


def encode_tile(plain: np.ndarray, era: str, T: int, L: int, tl: int) -> np.ndarray:
    rows = plain.reshape(-1, tl)
    perm = lane_perm(fnv1a(f"{era}:{T}:{L}:lane-shuffle"), tl)
    shuf = rows[:, perm]  # encoded column c holds plaintext column perm[c]
    u = shuf.astype(np.int16).view(np.uint16).ravel()
    u ^= keystream(fnv1a(f"{era}:{T}:{L}:carve-not-copy"), u.size)
    return u.view(np.int16)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--era-dir", required=True)
    args = ap.parse_args()
    era_dir = Path(args.era_dir)
    manifest_path = era_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("enc", {}).get("v") == 1:
        print(f"{manifest['era']}: already encoded, nothing to do")
        return
    era, tl = manifest["era"], manifest.get("tileLanes", 128)
    n = 0
    for f in sorted((era_dir / "z").glob("t*_l*.bin")):
        T, L = map(int, re.match(r"t(\d+)_l(\d+)\.bin", f.name).groups())
        plain = np.fromfile(f, dtype=np.int16)
        encode_tile(plain, era, T, L, tl).tofile(f)
        n += 1
    manifest["enc"] = {"v": 1}
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"{era}: encoded {n} tiles (enc v1)")


if __name__ == "__main__":
    main()
