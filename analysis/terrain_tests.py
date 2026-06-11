#!/usr/bin/env python
"""Terrain tests on the synthetic fixture era (PLAN section 6.3) + ordering smoke test.

Python REFERENCE implementation of the lane-blend height h(s) (PLAN section 1 as
amended: plateau alpha = 0.08 "exact track" strip, 92% smoothstep margins) and PCHIP
time interpolation, then:

  (a) crater/margin depth: blend equals k*((1-u)*z_live + u*z_dead), hand-computed values
  (b) C1 continuity at plateau/margin boundaries and across the lane 3 -> 0 wraparound seam
  (c) datum continuity at the IPO lane (z at birth == local median of alive neighbors)
  (d) PCHIP monotone bound: interpolant stays between bracketing closes (1000 random samples)
  (e) round-trip: decoded int16 tiles match the generator's float z within quantization

Plus: smoke-test pipeline/ordering.py on 30 synthetic correlated series with 3 planted
sector blocks -- each block must come out contiguous in the circular order.

Run: .venv/bin/python pipeline/make_synthetic_era.py && .venv/bin/python analysis/terrain_tests.py
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.interpolate import PchipInterpolator

ROOT = Path(__file__).resolve().parent.parent
TILES = ROOT / "game" / "public" / "tiles" / "synthetic"

# Mirrors of game/src/config.js CFG (CONTRACTS section 0). CFG is the single owner;
# these are MIRRORED constants (Python cannot import ES modules) -- keep in sync by hand.
K = 25.0          # h = K * z
ALPHA = 0.08      # inner "exact track" plateau fraction of lane width (PLAN Amendments:
                  # user spec "no knife edge" -- margins span 92% of inter-center distance)
TILE_DAYS = 64
TILE_LANES = 128
Z_SCALE = 1000
Z_NAN = -32768

DERIV_EPS = 1e-5  # step for 2nd-order one-sided differences: truncation ~1e-7, roundoff ~1e-9
C1_TOL = 1e-6     # task-specified continuity tolerance on the derivative jump
QUANT_TOL = 0.5 / Z_SCALE + 1e-12  # int16 round(z*1000): max half-step error + float eps

FAILURES = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    if not ok:
        FAILURES.append(name)


# --------------------------- reference height field ---------------------------

def height(s, z, k=K, alpha=ALPHA):
    """Reference h(s) for one day-row z (length n, circular). Lane centers at integer s.

    Cell [i, i+1): plateau of lane i for f <= alpha/2, plateau of lane i+1 for
    f >= 1 - alpha/2, smoothstep margin between (PLAN section 1).
    """
    n = len(z)
    x = s % n
    i = int(np.floor(x)) % n
    f = x - np.floor(x)
    half = alpha / 2.0
    if f <= half:
        return k * z[i]
    j = (i + 1) % n
    if f >= 1.0 - half:
        return k * z[j]
    ur = (f - half) / (1.0 - alpha)
    u = ur * ur * (3.0 - 2.0 * ur)  # smoothstep u = 3u_r^2 - 2u_r^3 (PLAN 1)
    return k * ((1.0 - u) * z[i] + u * z[j])


def dheight(s, z, k=K, alpha=ALPHA):
    """Analytic dh/ds of the reference height (used to cross-check the numerics)."""
    n = len(z)
    x = s % n
    i = int(np.floor(x)) % n
    f = x - np.floor(x)
    half = alpha / 2.0
    if f <= half or f >= 1.0 - half:
        return 0.0
    j = (i + 1) % n
    ur = (f - half) / (1.0 - alpha)
    return k * (z[j] - z[i]) * 6.0 * ur * (1.0 - ur) / (1.0 - alpha)


def num_dplus(fn, s, e=DERIV_EPS):
    """2nd-order one-sided derivative from the right: error O(e^2)."""
    return (-3.0 * fn(s) + 4.0 * fn(s + e) - fn(s + 2 * e)) / (2.0 * e)


def num_dminus(fn, s, e=DERIV_EPS):
    return (3.0 * fn(s) - 4.0 * fn(s - e) + fn(s - 2 * e)) / (2.0 * e)


# --------------------------- tile decoding ---------------------------
# Obfuscation decode (CONTRACTS section 2 "enc" v1): mirrors game/src/stream.js decodeTile —
# XOR keystream first, then lane unshuffle (plain[r][perm[c]] = enc[r][c]). Not DRM.

SEED_FALLBACK = 0x9E3779B9  # golden-ratio constant: stand-in for a zero seed (CONTRACTS 2)


def _fnv1a(s: str) -> int:
    h = 0x811C9DC5
    for ch in s.encode():
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def _xs32(x: int) -> int:
    x = (x ^ (x << 13)) & 0xFFFFFFFF
    x ^= x >> 17
    x = (x ^ (x << 5)) & 0xFFFFFFFF
    return x


def _lane_perm(seed: int, tl: int) -> np.ndarray:
    x = seed or SEED_FALLBACK
    perm = np.arange(tl)
    for i in range(tl - 1, 0, -1):  # Fisher-Yates, xorshift32-driven (CONTRACTS 2)
        x = _xs32(x)
        j = x % (i + 1)
        perm[i], perm[j] = perm[j], perm[i]
    return perm


def _decode_enc_tile(buf: bytes, era: str, T: int, L: int, tl: int) -> np.ndarray:
    u = np.frombuffer(buf, dtype="<u2").copy()
    x = _fnv1a(f"{era}:{T}:{L}:carve-not-copy") or SEED_FALLBACK
    ks = np.empty(u.size, dtype=np.uint16)
    for i in range(u.size):
        x = _xs32(x)
        ks[i] = x & 0xFFFF
    u ^= ks
    enc = u.view(np.int16).reshape(-1, tl)
    perm = _lane_perm(_fnv1a(f"{era}:{T}:{L}:lane-shuffle") or SEED_FALLBACK, tl)
    out = np.empty_like(enc)
    out[:, perm] = enc  # plain[r][perm[c]] = enc[r][c]
    return out.reshape(-1)


def decode_tiles(era_dir: Path):
    man = json.loads((era_dir / "manifest.json").read_text())
    nd, nl = man["nDays"], man["nLanes"]
    nt = -(-nd // man["tileDays"])
    nlt = nl // man["tileLanes"]
    encoded = (man.get("enc") or {}).get("v") == 1
    Z = np.full((nt * man["tileDays"], nl), Z_NAN, dtype=np.int16)
    for T in range(nt):
        for L in range(nlt):
            buf = (era_dir / "z" / f"t{T}_l{L}.bin").read_bytes()
            raw = (_decode_enc_tile(buf, man["era"], T, L, man["tileLanes"])
                   if encoded else np.frombuffer(buf, dtype="<i2"))
            assert raw.size == man["tileDays"] * man["tileLanes"], "tile size mismatch"
            Z[T * man["tileDays"]:(T + 1) * man["tileDays"],
              L * man["tileLanes"]:(L + 1) * man["tileLanes"]] = raw.reshape(
                  man["tileDays"], man["tileLanes"])
    Zf = Z[:nd].astype(np.float64) / Z_SCALE
    Zf[Z[:nd] == Z_NAN] = np.nan
    return man, Zf


# --------------------------- terrain tests ---------------------------

def run_terrain_tests():
    man, Zq = decode_tiles(TILES)
    truth = np.load(TILES / "truth.npz")
    Zt, born, dead = truth["z"], truth["born"], truth["dead"]
    n_real = Zt.shape[1]

    # (a) margin/crater depth vs hand-computed values.
    # z_live = 0.1, z_dead stand-in = -3.5 (the game clamps a truly bottomless dead lane;
    # here we verify only the blend formula). With alpha = 0.08 the margin between lanes
    # 0 and 1 spans s in (0.04, 0.96); s = 0.04 + 0.92*ur. The expected h values depend
    # only on ur (the smoothstep argument), so they are unchanged from the alpha=0.5 era.
    zrow = np.array([0.1, -3.5, 0.2, 0.05])
    hand = [(0.25, -11.5625),   # u = 0.15625: 25*(0.84375*0.1 + 0.15625*-3.5)
            (0.50, -42.5),      # u = 0.5:     25*(0.05 - 1.75)
            (0.75, -73.4375)]   # u = 0.84375: 25*(0.15625*0.1 + 0.84375*-3.5)
    for ur, expect in hand:
        got = height(0.04 + 0.92 * ur, zrow)
        check(f"(a) margin depth ur={ur}", abs(got - expect) < 1e-12, f"{got} vs {expect}")

    # (b) C1 continuity: numerical one-sided derivatives agree at every
    # plateau/margin boundary and across the lane 3 -> 0 wraparound seam.
    day = 200  # all four synthetic lanes alive on day 200
    rows = {"hand": zrow, "day200": Zt[day, :]}
    for label, row in rows.items():
        fn = lambda s: height(s, row)
        # plateau edges at i +- alpha/2 = i +- 0.04; 4.0 == 0.0: the wraparound seam
        boundaries = [0.04, 0.96, 1.04, 3.04, 3.96, 4.0]
        for b in boundaries:
            dp, dm = num_dplus(fn, b), num_dminus(fn, b)
            check(f"(b) C1 at s={b} [{label}]", abs(dp - dm) < C1_TOL, f"jump={abs(dp-dm):.2e}")
            hp, hm = fn(b + 1e-12), fn(b - 1e-12)
            check(f"(b) C0 at s={b} [{label}]", abs(hp - hm) < C1_TOL, f"jump={abs(hp-hm):.2e}")
        # analytic derivative sanity vs central differences mid-margin
        for s in [0.4, 3.5, 3.6]:
            num = (fn(s + DERIV_EPS) - fn(s - DERIV_EPS)) / (2 * DERIV_EPS)
            check(f"(b) analytic dh/ds at s={s} [{label}]", abs(num - dheight(s, row)) < C1_TOL,
                  f"num={num:.6f} ana={dheight(s, row):.6f}")
    # seam blends z[3] and z[0]: mid-seam height must be their average
    mid = height(3.5, zrow)
    check("(b) seam blends lanes 3 and 0", abs(mid - K * 0.5 * (zrow[3] + zrow[0])) < 1e-12)

    # (c) datum continuity at the IPO lane: z at birth equals the plain median of the
    # nearest alive lanes' z that day (cap-weighted unavailable -> plain median, PLAN 1)
    b3 = int(born[3])
    alive = [i for i in range(3) if born[i] <= b3 <= (dead[i] if dead[i] >= 0 else 10**9)]
    local_med = float(np.median(Zt[b3, alive]))
    check("(c) IPO datum continuity", abs(Zt[b3, 3] - local_med) < 1e-9,
          f"z_ipo={Zt[b3,3]:.12f} median={local_med:.12f}")

    # (d) PCHIP monotone bound: every interpolated value lies between bracketing closes
    rng = np.random.default_rng(7)  # any fixed seed; 7 documents "this is the sample draw"
    interps, spans = {}, {}
    for li in range(n_real):
        lo, hi = int(born[li]), int(dead[li]) if dead[li] >= 0 else Zt.shape[0] - 1
        days = np.arange(lo, hi + 1)
        interps[li] = PchipInterpolator(days, Zq[lo:hi + 1, li])
        spans[li] = (lo, hi)
    ok_d, worst = True, 0.0
    for _ in range(1000):
        li = int(rng.integers(0, n_real))
        lo, hi = spans[li]
        t = rng.uniform(lo, hi)
        k0, k1 = int(np.floor(t)), int(np.ceil(t))
        v = float(interps[li](t))
        lo_v = min(Zq[k0, li], Zq[k1, li]) - 1e-9
        hi_v = max(Zq[k0, li], Zq[k1, li]) + 1e-9
        if not (lo_v <= v <= hi_v):
            ok_d = False
            worst = max(worst, max(lo_v - v, v - hi_v))
    check("(d) PCHIP bounded by bracketing closes (1000 samples)", ok_d, f"worst excess={worst:.2e}")

    # (e) round-trip: decoded tiles match the generator's float z within quantization
    fin_t = np.isfinite(Zt)
    fin_q = np.isfinite(Zq[:, :n_real])
    check("(e) NaN/void mask round-trips", bool(np.array_equal(fin_t, fin_q)))
    err = np.max(np.abs(Zq[:, :n_real][fin_t] - Zt[fin_t])) if fin_t.any() else 0.0
    check("(e) z round-trip within int16 quantization", err <= QUANT_TOL, f"max err={err:.2e}")
    check("(e) padding lanes are all void", bool(np.all(~np.isfinite(Zq[:, n_real:]))))

    # fixture shape sanity straight off the manifest
    check("manifest shape", man["nDays"] == 400 and man["nLanes"] == 128,
          f"nDays={man['nDays']} nLanes={man['nLanes']}")


# --------------------------- ordering smoke test ---------------------------

N_SMOKE = 30      # 30 series, 3 planted blocks of 10 (task spec)
BLOCK = 10
SMOKE_DAYS = 300  # > 126-day correlation window + ranking warm-up
BETA = 0.02       # common-factor loading: intra-block corr = beta^2/(beta^2+sigma^2) ~ 0.86
SIGMA = 0.008     # idiosyncratic daily vol


def run_ordering_smoke():
    tmp = ROOT / "data" / "tmp_ordering_smoke"
    shutil.rmtree(tmp, ignore_errors=True)
    (tmp / "parquet").mkdir(parents=True)
    rng = np.random.default_rng(42)  # any fixed seed; 42 documents "this is the smoke fixture"
    dates = pd.bdate_range("2015-01-05", periods=SMOKE_DAYS)
    factors = rng.standard_normal((3, SMOKE_DAYS - 1))
    uni_rows = []
    for i in range(N_SMOKE):
        sym = f"T{i:02d}"
        blk = i // BLOCK
        r = 0.0003 + BETA * factors[blk] + SIGMA * rng.standard_normal(SMOKE_DAYS - 1)
        px = 50.0 * np.exp(np.concatenate([[0.0], np.cumsum(r)]))
        pd.DataFrame({
            "date": [d.strftime("%Y-%m-%d") for d in dates],
            "open": px, "high": px, "low": px, "close": px,
            "adjusted_close": px,
            "volume": np.full(SMOKE_DAYS, 1_000_000, dtype=np.int64),
        }).to_parquet(tmp / "parquet" / f"{sym}.parquet", index=False)
        uni_rows.append({"symbol": sym, "name": sym, "exchange": "SYN", "type": "Common Stock",
                         "is_delisted": False, "first_date": dates[0].strftime("%Y-%m-%d"),
                         "last_date": dates[-1].strftime("%Y-%m-%d"),
                         "median_dollar_vol_63d_last": 5e7, "termination": "alive"})
    pd.DataFrame(uni_rows).to_parquet(tmp / "universe.parquet", index=False)
    era = {"name": "smoke", "start": dates[0].strftime("%Y-%m-%d"),
           "end": dates[-1].strftime("%Y-%m-%d"),
           "burnin_start": dates[0].strftime("%Y-%m-%d"), "top_n": N_SMOKE}
    (tmp / "eras.json").write_text(json.dumps({"smoke": era}))

    proc = subprocess.run(
        [sys.executable, str(ROOT / "pipeline" / "ordering.py"),
         "--era", "smoke", "--data-dir", str(tmp), "--config", str(tmp / "eras.json"),
         "--out", str(tmp)],
        capture_output=True, text=True)
    check("ordering CLI exit 0", proc.returncode == 0, proc.stderr.strip()[-200:])
    if proc.returncode != 0:
        return False

    order = json.loads((tmp / "smoke_order.json").read_text())
    check("ordering covers all 30 symbols", sorted(order) == sorted(f"T{i:02d}" for i in range(N_SMOKE)))
    pos = {s: k for k, s in enumerate(order)}
    all_contig = True
    for blk in range(3):
        members = {pos[f"T{i:02d}"] for i in range(blk * BLOCK, (blk + 1) * BLOCK)}
        # circular contiguity: an arc of 10 seats has exactly 9 cyclically-adjacent pairs inside it
        adj = sum(((p + 1) % N_SMOKE) in members for p in members)
        contig = adj == BLOCK - 1
        all_contig &= contig
        check(f"block {blk} contiguous in circular order", contig, f"adjacent pairs={adj}")
    return all_contig and not any(f.startswith("ordering") for f in FAILURES)


def main():
    run_terrain_tests()
    terrain_ok = len(FAILURES) == 0
    before = len(FAILURES)
    run_ordering_smoke()
    smoke_ok = len(FAILURES) == before
    gate = {"terrain_tests": "pass" if terrain_ok else "fail",
            "ordering_smoke": "pass" if smoke_ok else "fail",
            "failures": FAILURES}
    print(f"GATE {json.dumps(gate)}")
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    sys.exit(main())
