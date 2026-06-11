// Round-trip regression for the CONTRACTS §2 enc-v1 tile decoder. The JS-side encoder here
// mirrors pipeline/obfuscate_tiles.py; cross-language equivalence is checked at build time
// by analysis (python-encoded fixture decoded by decodeTile) and end-to-end by Playwright
// wealth-identity tests, which would fail loudly on any mis-decode.
import { describe, it, expect } from 'vitest';
import { decodeTile } from '../src/stream.js';

const MASK = 0xffffffff;
const SEED_FALLBACK = 0x9e3779b9;

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function xs32(x) {
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  x = (x ^ (x << 5)) >>> 0;
  return (x & MASK) >>> 0;
}
function lanePerm(seed, tl) {
  let x = seed || SEED_FALLBACK;
  const perm = Array.from({ length: tl }, (_, i) => i);
  for (let i = tl - 1; i > 0; i--) {
    x = xs32(x);
    const j = x % (i + 1);
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}
function encodeTile(plain, era, T, L, tl) {
  const rows = plain.length / tl;
  const perm = lanePerm(fnv1a(`${era}:${T}:${L}:lane-shuffle`) || SEED_FALLBACK, tl);
  const shuf = new Int16Array(plain.length);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < tl; c++) shuf[r * tl + c] = plain[r * tl + perm[c]];
  const u = new Uint16Array(shuf.buffer);
  let x = fnv1a(`${era}:${T}:${L}:carve-not-copy`) || SEED_FALLBACK;
  for (let i = 0; i < u.length; i++) {
    x = xs32(x);
    u[i] ^= x & 0xffff;
  }
  return shuf;
}

describe('enc-v1 tile obfuscation', () => {
  it('decodeTile inverts the encoder exactly, sentinel included', () => {
    const tl = 128;
    const days = 64;
    const plain = new Int16Array(days * tl);
    let x = 123456789; // deterministic fixture (no Math.random — same rule as the sim)
    for (let i = 0; i < plain.length; i++) {
      x = xs32(x);
      plain[i] = i % 977 === 0 ? -32768 : ((x & 0xffff) << 16) >> 16; // sprinkle Z_NAN sentinels
    }
    const enc = encodeTile(plain.slice(), 'recent2y', 3, 7, tl);
    const dec = decodeTile(enc.buffer, 'recent2y', 3, 7, tl);
    expect(Array.from(dec)).toEqual(Array.from(plain));
  });

  it('encoded bytes share no aligned run with plaintext (the integers are not copyable)', () => {
    const tl = 128;
    const plain = new Int16Array(64 * tl).fill(1234);
    const enc = encodeTile(plain.slice(), 'recent2y', 0, 0, tl);
    let matches = 0;
    for (let i = 0; i < plain.length; i++) if (enc[i] === plain[i]) matches++;
    expect(matches / plain.length).toBeLessThan(0.01); // chance-level collisions only
  });
});
