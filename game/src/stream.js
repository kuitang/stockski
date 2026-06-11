// stream.js — tile fetch + LRU cache + monotone-cubic time interpolation (CONTRACTS §2/§3).
// Causality is enforced at the NETWORK layer here: ensure(τ) never requests a tile whose
// start day exceeds τ (plan §4.5). Decode: int16/Z_SCALE, Z_NAN sentinel -> NaN.

import { CFG } from './config.js';

export const PREFETCH_DAYS = 40;  // resident history window behind τ — matches the render window (plan §7)
export const VIEW_LANES = 200;    // lanes either side of the skier that exist as meshes (task spec)
// prefetch one extra lane-tile beyond the mesh window so seam columns always have loaded neighbors
export const PREFETCH_LANES = VIEW_LANES + CFG.TILE_LANES;
const CACHE_TILES = 256;          // ~256 × 16 KiB int16 tiles ≈ 4 MiB resident — plan §5 streaming budget
const LANE_KEY = 4096;            // numeric key stride T*4096+L: far above any era's lane-tile count (12k/128 = 94)

// Fritsch–Carlson slope: 0 at local extrema (sign change) else harmonic mean of the two
// secants (uniform 1-day spacing) — guarantees monotone segments, no overshoot (plan §1).
function fcSlope(a, b) {
  if (a * b <= 0) return 0;
  return (2 * a * b) / (a + b);
}

// --- tile obfuscation decode (CONTRACTS §2 "enc" v1): per-tile lane shuffle + xorshift32 XOR.
// Keys derive from era/tile coords — deters copying integers out of a public deploy; not DRM.
const SEED_FALLBACK = 0x9e3779b9; // golden-ratio constant: any fixed nonzero seed works for xorshift

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
  return x;
}

function lanePerm(seed, tl) {
  let x = seed || SEED_FALLBACK;
  const perm = new Array(tl);
  for (let i = 0; i < tl; i++) perm[i] = i;
  for (let i = tl - 1; i > 0; i--) {
    x = xs32(x);
    const j = x % (i + 1);
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  return perm;
}

/** XOR first, then unshuffle: plain[r][perm[c]] = enc[r][c] (inverse of the encoder). */
export function decodeTile(buf, era, T, L, tl) {
  const u = new Uint16Array(buf);
  let x = fnv1a(`${era}:${T}:${L}:carve-not-copy`) || SEED_FALLBACK;
  for (let i = 0; i < u.length; i++) {
    x = xs32(x);
    u[i] ^= x & 0xffff;
  }
  const enc = new Int16Array(buf);
  const perm = lanePerm(fnv1a(`${era}:${T}:${L}:lane-shuffle`) || SEED_FALLBACK, tl);
  const out = new Int16Array(enc.length);
  const rows = enc.length / tl;
  for (let r = 0; r < rows; r++) {
    const base = r * tl;
    for (let c = 0; c < tl; c++) out[base + perm[c]] = enc[base + c];
  }
  return out;
}

export class TileStream {
  /**
   * @param {string|null} manifestUrl  e.g. 'tiles/recent2y/manifest.json'
   * @param {{manifest:object, fetchTile:(T:number,L:number)=>Int16Array|Promise<Int16Array>}} [provider]
   *        in-memory provider (synthfallback) used when no static tiles are served
   */
  constructor(manifestUrl, provider = null) {
    this.manifestUrl = manifestUrl;
    this.provider = provider;
    this.baseUrl = manifestUrl ? manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1) : '';
    this.manifest = null;
    this.cache = new Map();   // numeric key -> Int16Array; Map iteration order = LRU order
    this.inflight = new Set();
    this.onEvict = null;      // (key, {T, L}) => void — terrain disposes the tile's mesh (task spec)
  }

  async load() {
    if (this.provider) {
      this.manifest = this.provider.manifest;
    } else {
      const res = await fetch(this.manifestUrl);
      if (!res.ok) throw new Error(`manifest ${this.manifestUrl}: HTTP ${res.status}`);
      this.manifest = await res.json();
    }
    this.td = this.manifest.tileDays ?? CFG.TILE_DAYS;
    this.tl = this.manifest.tileLanes ?? CFG.TILE_LANES;
    this.nDayTiles = Math.ceil(this.manifest.nDays / this.td);
    this.nLaneTiles = Math.ceil(this.manifest.nLanes / this.tl);
    return this;
  }

  hasTile(T, L) {
    return this.cache.has(T * LANE_KEY + L);
  }

  /** Prefetch the window [τ-PREFETCH_DAYS, τ] × lanes near the skier. NEVER requests a tile
   *  whose start day > τ — no-future at the network layer (plan §4.5). */
  ensure(tau, centerLane = 0) {
    const m = this.manifest;
    const dayHi = Math.min(Math.floor(tau), m.nDays - 1);
    if (dayHi < 0) return;
    const dayLo = Math.max(0, dayHi - PREFETCH_DAYS);
    const tLo = Math.floor(dayLo / this.td);
    const tHi = Math.floor(dayHi / this.td);
    const laneTiles = new Set();
    const lLo = Math.floor((centerLane - PREFETCH_LANES) / this.tl);
    const lHi = Math.floor((centerLane + PREFETCH_LANES) / this.tl);
    for (let L = lLo; L <= lHi; L++) {
      laneTiles.add(((L % this.nLaneTiles) + this.nLaneTiles) % this.nLaneTiles);
    }
    for (let T = tLo; T <= tHi; T++) {
      if (T * this.td > tau) continue; // CAUSALITY: tile starts after τ — must not exist yet (plan §4.5)
      for (const L of laneTiles) this._request(T, L);
    }
  }

  _request(T, L) {
    const key = T * LANE_KEY + L;
    if (this.cache.has(key) || this.inflight.has(key)) return;
    this.inflight.add(key);
    const p = this.provider
      ? Promise.resolve(this.provider.fetchTile(T, L))
      : fetch(`${this.baseUrl}z/t${T}_l${L}.bin`)
          .then((r) => {
            if (!r.ok) throw new Error(`tile t${T}_l${L}: HTTP ${r.status}`);
            return r.arrayBuffer();
          })
          .then((buf) =>
            this.manifest.enc?.v === 1
              ? decodeTile(buf, this.manifest.era, T, L, this.tl)
              : new Int16Array(buf)
          );
    p.then((tile) => this._insert(key, tile))
      .catch(() => {}) // missing tile = permanent void; zRaw stays null there
      .finally(() => this.inflight.delete(key));
  }

  _insert(key, tile) {
    this.cache.set(key, tile);
    while (this.cache.size > CACHE_TILES) {
      const oldest = this.cache.keys().next().value; // Map order: least-recently-touched first
      this.cache.delete(oldest);
      this.onEvict?.(oldest, { T: Math.floor(oldest / LANE_KEY), L: oldest % LANE_KEY });
    }
  }

  /** Raw daily sample. Returns number; NaN = genuine void (Z_NAN in a loaded tile);
   *  null = tile not resident (not yet fetched, beyond τ, or outside the era). */
  _raw(day, lane) {
    const m = this.manifest;
    if (day < 0 || day >= m.nDays) return null;
    const n = m.nLanes;
    lane = ((lane % n) + n) % n; // lane axis is circular (plan §0 cylinder topology)
    const T = Math.floor(day / this.td);
    const L = Math.floor(lane / this.tl);
    const key = T * LANE_KEY + L;
    const tile = this.cache.get(key);
    if (tile === undefined) return null;
    this.cache.delete(key); // LRU touch: re-insert at the back of Map order
    this.cache.set(key, tile);
    const v = tile[(day - T * this.td) * this.tl + (lane - L * this.tl)];
    return v === CFG.Z_NAN ? NaN : v / CFG.Z_SCALE;
  }

  /** Last revealed close at or before day d−1 for `lane`, walking back through any
   *  not-yet-resident gap. Look-back bound = one tile of days: a boundary fetch gap is at
   *  worst one tile deep while the prefetch window keeps the previous tile resident.
   *  Returns a finite z to hold, NaN if the lane is genuinely void behind us
   *  (post-delisting / pre-IPO), or null if nothing at all is resident to hold. */
  _heldBack(d, lane) {
    const lo = Math.max(0, d - this.td);
    for (let k = d - 1; k >= lo; k--) {
      const v = this._raw(k, lane);
      if (v !== null) return v; // finite close to hold, or NaN = real void behind
    }
    return null;
  }

  /**
   * PCHIP (Fritsch–Carlson monotone cubic Hermite) over the lane's daily z values.
   * Monotone => every interpolated price stays between the bracketing real closes (plan §1).
   * Returns {z, dz} with dz in z-units per trading day; {NaN, NaN} for void.
   * NOT-RESIDENT ≠ VOID: when day d's tile is merely not resident yet (it only became
   * requestable this instant — causality forbids asking before τ, plan §4.5 — or the
   * fetch is in flight), hold the last revealed close flat instead of returning NaN,
   * so a LIVE lane never reads as a phantom crevasse at 64-day tile boundaries.
   */
  zLaneDeriv(lane, dayF) {
    const d = Math.floor(dayF);
    const f = dayF - d;
    const y1 = this._raw(d, lane);
    if (y1 === null) {
      const held = this._heldBack(d, lane);
      return Number.isFinite(held) ? { z: held, dz: 0 } : { z: NaN, dz: NaN };
    }
    if (Number.isNaN(y1)) return { z: NaN, dz: NaN };
    if (f === 0) {
      // exact node: value is the close itself; slope is the FC node slope (one-sided at gaps)
      const y0 = this._raw(d - 1, lane);
      const y2n = this._raw(d + 1, lane);
      const hasPrev = y0 !== null && !Number.isNaN(y0);
      const hasNext = y2n !== null && !Number.isNaN(y2n);
      let dz = 0;
      if (hasPrev && hasNext) dz = fcSlope(y1 - y0, y2n - y1);
      else if (hasPrev) dz = y1 - y0;
      else if (hasNext) dz = y2n - y1;
      return { z: y1, dz };
    }
    const y2 = this._raw(d + 1, lane);
    // frontier hold: the next close lives in a tile that cannot be requested yet (start > τ) —
    // ride the last revealed close flat rather than fall through a phantom void (plan §4.5)
    if (y2 === null) return { z: y1, dz: 0 };
    if (Number.isNaN(y2)) return { z: NaN, dz: NaN }; // real void: the lane stopped extruding (plan §4.7)
    const delta = y2 - y1;
    const y0 = this._raw(d - 1, lane);
    const y3 = this._raw(d + 2, lane);
    const m1 = y0 === null || Number.isNaN(y0) ? delta : fcSlope(y1 - y0, delta);
    const m2 = y3 === null || Number.isNaN(y3) ? delta : fcSlope(delta, y3 - y2);
    const f2 = f * f;
    const f3 = f2 * f;
    const z =
      (2 * f3 - 3 * f2 + 1) * y1 +
      (f3 - 2 * f2 + f) * m1 +
      (-2 * f3 + 3 * f2) * y2 +
      (f3 - f2) * m2;
    const dz =
      (6 * f2 - 6 * f) * y1 +
      (3 * f2 - 4 * f + 1) * m1 +
      (-6 * f2 + 6 * f) * y2 +
      (3 * f2 - 2 * f) * m2;
    return { z, dz };
  }

  /** CONTRACTS §3: PCHIP in time for one lane; NaN for void. */
  zLane(lane, dayF) {
    return this.zLaneDeriv(lane, dayF).z;
  }

  /** CONTRACTS §3: PCHIP in t, raw per-lane in s (no lateral blending here — terrain.js does that). */
  z(dayF, laneF) {
    return this.zLane(Math.floor(laneF), dayF);
  }
}
