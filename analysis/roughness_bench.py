#!/usr/bin/env python
"""Roughness benchmark (PLAN section 6, validation 1) on the FULL era.

R(pi) = mean |z_i - z_neighbor| over all (day, alive adjacent circular pair)
entries, computed PER DECADE (2000s / 2010s / 2020s), for orderings:

  random (x20, mean), alphabetical, cap-order (last-day 63d median dollar
  volume as proxy -- point-in-time caps unavailable on this plan, documented),
  sector-grouped (NASDAQ screener sectors; delisted lanes lack a sector ->
  'Unknown' bucket, documented), PCA-first-loading, hierarchical clustering +
  optimal leaf ordering (scipy; subsampled to 3000 lanes if the full-size OLO
  exceeds the 10-minute budget), circular spectral (ours, data/full_order.json),
  and spectral + local windowed 2-opt (segment reversals up to WINDOW lanes,
  up to 50 passes, early stop on convergence).

ACCEPT (PLAN): R(spectral) <= 0.5 * R(alphabetical) in EVERY decade AND
R(spectral) < R(sector-grouped) overall. If the 2-opt gain < 5%, ship
spectral-only (PLAN section 6.4).

Notes on methodology:
  * z_i(t) = log(P_adj(t) / P_adj(t_first,i)) with t_first,i = the lane's first
    trading day inside the playable window (2000-01-03 ->). Datum offsets c_i
    are EXCLUDED: c_i depends on the lane ordering itself (neighborhood median
    at listing), so including it would make the comparison circular. c_i = 0
    for every lane in every ordering -- a fair, ordering-independent field.
  * "Alive pair": both lanes have a finite z on that day (inside their listed
    span, bar actually present). All orderings are scored on the identical Z
    matrix; only the permutation differs. Every ordering is scored as a CIRCLE
    (wrap edge included) since the terrain is a cylinder.
  * Correlations for PCA / hierarchical reuse the pipeline's method
    (pipeline/ordering.py): earliest trailing 126-day return window per symbol
    (era incl. 1999 burn-in), pairwise-complete Pearson, >= 60 overlap days.

Run: .venv/bin/python analysis/roughness_bench.py
Output: table appended to analysis/report.md; machine-readable GATE line last.
"""
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import Process
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline.ordering import pairwise_corr, MIN_OVERLAP, CORR_WINDOW  # noqa: E402

DATA = ROOT / "data"
CACHE = DATA / "roughness_cache"
ERA_START = "2000-01-03"      # playable full-era start (PLAN section 0)
BURNIN_START = "1999-01-04"   # corr windows may begin in burn-in, like the pipeline
N_RANDOM = 20                 # task spec: random baseline = mean of 20 draws
WINDOW = 8                    # 2-opt: max reversed-segment length; "local" = a few lanes
MAX_PASSES = 50               # task spec
OLO_BUDGET_S = 600            # task spec: subsample to 3000 lanes if > 10 min
OLO_SUBSAMPLE = 3000
SEED = 0

DECADES = [("2000s", "2000-01-01", "2009-12-31"),
           ("2010s", "2010-01-01", "2019-12-31"),
           ("2020s", "2020-01-01", "2099-12-31")]


# ---------------------------------------------------------------- data loading

def load_z_and_returns(symbols):
    """Z (days x n float32, NaN = not alive) on the SPY trading calendar from
    ERA_START, plus the earliest 126-day return window per symbol (burn-in incl.)."""
    spy = pd.read_parquet(DATA / "parquet" / "SPY.parquet", columns=["date"])
    cal = pd.DatetimeIndex(pd.to_datetime(spy["date"]))
    cal = cal[cal >= ERA_START]
    cal_pos = {d: i for i, d in enumerate(cal)}
    n, T = len(symbols), len(cal)
    Z = np.full((T, n), np.nan, dtype=np.float32)
    ret_cols = {}

    def one(j_sym):
        j, sym = j_sym
        p = DATA / "parquet" / f"{sym}.parquet"
        if not p.exists():
            return None
        df = pd.read_parquet(p, columns=["date", "adjusted_close"])
        d = pd.to_datetime(df["date"])
        v = df["adjusted_close"].to_numpy(dtype=np.float64)
        ok = np.isfinite(v) & (v > 0) & (d >= BURNIN_START).to_numpy()
        d, v = d[ok], v[ok]
        if len(v) == 0:
            return None
        # earliest 126-day log-return window (incl. burn-in), pipeline-identical
        r = pd.Series(np.diff(np.log(v))[:CORR_WINDOW], index=d.iloc[1:CORR_WINDOW + 1])
        # z inside the playable window, based at the lane's first bar there
        m = (d >= ERA_START).to_numpy()
        dd, vv = d[m], v[m]
        if len(vv) == 0:
            return j, None, None, r
        z = np.log(vv / vv.iloc[0] if isinstance(vv, pd.Series) else vv / vv[0])
        rows = np.fromiter((cal_pos.get(x, -1) for x in dd), dtype=np.int64)
        keep = rows >= 0
        return j, rows[keep], z[keep].astype(np.float32), r

    with ThreadPoolExecutor(max_workers=16) as ex:
        for res in ex.map(one, enumerate(symbols)):
            if res is None:
                continue
            j, rows, z, r = res
            if rows is not None and len(rows):
                Z[rows, j] = z
            if len(r):
                ret_cols[symbols[j]] = r
    rets = pd.DataFrame(ret_cols).sort_index()
    return Z, cal, rets


# ---------------------------------------------------------------- roughness

def decade_slices(cal):
    out = []
    for name, a, b in DECADES:
        idx = np.flatnonzero((cal >= a) & (cal <= b))
        out.append((name, idx[0], idx[-1] + 1))
    return out


def roughness(Z, order, slices):
    """Per-decade and overall R = mean |dz| over alive adjacent circular pairs."""
    A = Z[:, order]
    D = np.abs(A - np.roll(A, -1, axis=1))   # NaN where either side dead
    out, s_all, c_all = {}, 0.0, 0
    for name, a, b in slices:
        d = D[a:b]
        c = int(np.sum(np.isfinite(d)))
        s = float(np.nansum(d))
        out[name] = s / c if c else np.nan
        s_all += s
        c_all += c
    out["overall"] = s_all / c_all if c_all else np.nan
    return out


# ---------------------------------------------------------------- orderings

def pca_first_loading_order(rho, overlap):
    """Sort lanes by their loading on the first eigenvector of the corr matrix."""
    from scipy.sparse.linalg import eigsh
    C = np.where(np.isfinite(rho) & (overlap >= MIN_OVERLAP), rho, 0.0).astype(np.float32)
    C = (C + C.T) / 2
    np.fill_diagonal(C, 1.0)
    rng = np.random.default_rng(SEED)
    _, vec = eigsh(C, k=1, which="LA", v0=rng.standard_normal(C.shape[0]))
    v1 = vec[:, 0] * np.sign(vec[:, 0].sum() or 1.0)
    return np.argsort(v1)


def _olo_worker(rho_path, idx_path, out_path):
    """Subprocess: average-linkage + optimal leaf ordering on d = sqrt(2(1-rho))."""
    from scipy.cluster.hierarchy import linkage, optimal_leaf_ordering, leaves_list
    from scipy.spatial.distance import squareform
    rho = np.load(rho_path)
    idx = np.load(idx_path)
    r = rho[np.ix_(idx, idx)].astype(np.float64)
    r[~np.isfinite(r)] = 0.0           # no estimate -> neutral distance sqrt(2)
    r = np.clip((r + r.T) / 2, -1.0, 1.0)
    D = np.sqrt(np.maximum(2.0 * (1.0 - r), 0.0))
    np.fill_diagonal(D, 0.0)
    cond = squareform(D, checks=False)
    L = linkage(cond, method="average")
    L = optimal_leaf_ordering(L, cond)
    np.save(out_path, idx[leaves_list(L)])


def hierarchical_olo_order(rho, n):
    """Full-size if it fits the 10-min budget, else 3000-lane subsample (documented)."""
    rho_path, out_path = CACHE / "rho.npy", CACHE / "olo_order.npy"
    for sub_n, tag in [(n, "full"), (OLO_SUBSAMPLE, f"subsample{OLO_SUBSAMPLE}")]:
        idx = (np.arange(n) if sub_n >= n
               else np.sort(np.random.default_rng(SEED).choice(n, sub_n, replace=False)))
        idx_path = CACHE / "olo_idx.npy"
        np.save(idx_path, idx)
        out_path.unlink(missing_ok=True)
        p = Process(target=_olo_worker, args=(str(rho_path), str(idx_path), str(out_path)))
        t0 = time.monotonic()
        p.start()
        p.join(OLO_BUDGET_S)
        if p.is_alive():
            p.terminate()
            p.join()
            print(f"hier+OLO {tag}: exceeded {OLO_BUDGET_S}s budget, falling back", flush=True)
            continue
        if p.exitcode == 0 and out_path.exists():
            print(f"hier+OLO {tag}: done in {time.monotonic() - t0:.0f}s", flush=True)
            return np.load(out_path), idx, tag
        print(f"hier+OLO {tag}: worker failed (exit {p.exitcode}), falling back", flush=True)
    raise RuntimeError("hierarchical+OLO failed even on the subsample")


def two_opt(Z, order0, slices):
    """Local windowed 2-opt on the circle: reverse segments of length 2..WINDOW,
    accept iff overall R (sum/count over ALL days) strictly decreases. Per pass,
    offset-cost arrays are precomputed vectorized; accepted moves dirty their
    neighborhood and conflicting candidates wait for the next pass."""
    pos = np.asarray(order0).copy()
    n = len(pos)
    passes_run, total_acc = 0, 0
    for p_i in range(MAX_PASSES):
        A = Z[:, pos]
        sums = np.empty((WINDOW + 1, n), dtype=np.float64)
        cnts = np.empty((WINDOW + 1, n), dtype=np.int64)
        for k in range(1, WINDOW + 1):
            Dk = np.abs(A - np.roll(A, -k, axis=1))
            fin = np.isfinite(Dk)
            sums[k] = np.where(fin, Dk, 0.0).sum(axis=0)
            cnts[k] = fin.sum(axis=0)
        S, C = float(sums[1].sum()), int(cnts[1].sum())
        dirty = np.zeros(n, dtype=bool)
        accepted = 0
        for i in range(n):
            best = None
            for L in range(2, WINDOW + 1):
                lo, hi = (i - 1) % n, (i + L - 1) % n
                touch = [(i + t) % n for t in range(-1, L + 1)]
                if dirty[touch].any():
                    continue
                ds = sums[L][lo] + sums[L][i] - sums[1][lo] - sums[1][hi]
                dc = cnts[L][lo] + cnts[L][i] - cnts[1][lo] - cnts[1][hi]
                if C + dc <= 0:
                    continue
                if (S + ds) / (C + dc) < S / C - 1e-15:
                    if best is None or (S + ds) / (C + dc) < best[0]:
                        best = ((S + ds) / (C + dc), L, ds, dc)
                if L >= n - 1:
                    break
            if best is not None:
                _, L, ds, dc = best
                seg = [(i + t) % n for t in range(L)]
                pos[seg] = pos[seg[::-1]]
                S, C = S + ds, C + dc
                dirty[[(i + t) % n for t in range(-WINDOW - 1, L + WINDOW + 1)]] = True
                accepted += 1
        passes_run += 1
        total_acc += accepted
        print(f"2-opt pass {p_i + 1}: {accepted} reversals, R~{S / C:.5f}", flush=True)
        if accepted == 0:
            break
    return pos, passes_run, total_acc


# ---------------------------------------------------------------- main

def main():
    t0 = time.monotonic()
    CACHE.mkdir(exist_ok=True)
    symbols = json.load(open(DATA / "full_order.json"))
    n = len(symbols)
    sym_idx = {s: i for i, s in enumerate(symbols)}
    print(f"lanes: {n} (data/full_order.json)", flush=True)

    zc, cc, rc = CACHE / "Z.npy", CACHE / "cal.json", CACHE / "rho.npy"
    if zc.exists() and cc.exists() and rc.exists():
        Z = np.load(zc)
        cal = pd.DatetimeIndex(json.load(open(cc)))
        rho = np.load(rc)
        overlap = np.load(CACHE / "overlap.npy")
        print("loaded Z/rho from cache", flush=True)
    else:
        Z, cal, rets = load_z_and_returns(symbols)
        print(f"Z built: {Z.shape}, {time.monotonic() - t0:.0f}s", flush=True)
        rets = rets.reindex(columns=symbols)  # column j == lane j; missing -> NaN col
        rho, overlap = pairwise_corr(rets.to_numpy(dtype=np.float32))
        np.save(zc, Z)
        json.dump([str(d.date()) for d in cal], open(cc, "w"))
        np.save(rc, rho.astype(np.float32))
        np.save(CACHE / "overlap.npy", overlap.astype(np.int32))
        rho = rho.astype(np.float32)
        print(f"corr built: {time.monotonic() - t0:.0f}s", flush=True)

    slices = decade_slices(cal)
    R = {}

    # --- random x20 (mean per decade)
    rng = np.random.default_rng(SEED)
    accs = []
    for _ in range(N_RANDOM):
        accs.append(roughness(Z, rng.permutation(n), slices))
    R["random(x20 mean)"] = {k: float(np.mean([a[k] for a in accs])) for k in accs[0]}

    # --- alphabetical
    R["alphabetical"] = roughness(Z, np.argsort(np.array(symbols)), slices)

    # --- cap-order (last-day 63d median dollar volume proxy; documented)
    uni = pd.read_parquet(DATA / "universe.parquet",
                          columns=["symbol", "median_dollar_vol_63d_last"])
    dvmap = dict(zip(uni["symbol"], uni["median_dollar_vol_63d_last"]))
    dv = np.array([dvmap.get(s, 0.0) or 0.0 for s in symbols])
    R["cap-order (dv proxy)"] = roughness(Z, np.argsort(-dv), slices)

    # --- sector-grouped (NASDAQ screener; delisted -> Unknown bucket)
    scr = json.load(open(DATA / "universe_src" / "nasdaq_screener.json"))
    smap = {r["symbol"]: (r.get("sector") or "Unknown") for r in scr["data"]["rows"]}
    secs = [smap.get(s, "Unknown") for s in symbols]
    known = sum(1 for x in secs if x != "Unknown")
    sec_order = np.array(sorted(range(n), key=lambda i: (secs[i], symbols[i])))
    R["sector-grouped"] = roughness(Z, sec_order, slices)
    print(f"sector coverage: {known}/{n} lanes ({100 * known / n:.0f}%)", flush=True)

    # --- PCA first loading
    R["PCA-first-loading"] = roughness(Z, pca_first_loading_order(rho, overlap), slices)
    print(f"pca done {time.monotonic() - t0:.0f}s", flush=True)

    # --- hierarchical + OLO
    olo_order, olo_idx, olo_tag = hierarchical_olo_order(rho, n)
    if len(olo_idx) == n:
        R[f"hierarchical+OLO ({olo_tag})"] = roughness(Z, olo_order, slices)
    else:  # subsample: score on the SAME subsample, with its own random baseline
        Zs = Z[:, olo_idx]
        rel = {v: i for i, v in enumerate(olo_idx)}
        sub_order = np.array([rel[v] for v in olo_order])
        R[f"hierarchical+OLO ({olo_tag})*"] = roughness(Zs, sub_order, slices)
        sub_acc = [roughness(Zs, rng.permutation(len(olo_idx)), slices) for _ in range(N_RANDOM)]
        R[f"random on {olo_tag}* (x20 mean)"] = {
            k: float(np.mean([a[k] for a in sub_acc])) for k in sub_acc[0]}

    # --- circular spectral (ours) = identity over full_order.json
    spectral = np.arange(n)
    R["spectral (ours)"] = roughness(Z, spectral, slices)

    # --- spectral + local windowed 2-opt
    o2, passes, nrev = two_opt(Z, spectral, slices)
    R["spectral+2opt"] = roughness(Z, o2, slices)
    print(f"2-opt: {passes} passes, {nrev} reversals, {time.monotonic() - t0:.0f}s", flush=True)

    # ------------------------------------------------------------ verdict
    dec = [d[0] for d in DECADES]
    spec, alpha = R["spectral (ours)"], R["alphabetical"]
    sva = [round(spec[d] / alpha[d], 4) for d in dec]
    vs_sector = round(spec["overall"] / R["sector-grouped"]["overall"], 4)
    gain = 100.0 * (spec["overall"] - R["spectral+2opt"]["overall"]) / spec["overall"]
    accept = all(r <= 0.5 for r in sva) and vs_sector < 1.0

    rnd = R["random(x20 mean)"]
    lines = [
        "",
        "## Roughness benchmark — FULL era (analysis/roughness_bench.py)",
        "",
        f"Date: {pd.Timestamp.now():%Y-%m-%d}. Lanes: {n} (data/full_order.json), calendar "
        f"{cal[0]:%Y-%m-%d} → {cal[-1]:%Y-%m-%d} ({len(cal)} days, SPY calendar). "
        "R = mean |z_i − z_neighbor| over alive adjacent circular pairs; z uses c_i=0 "
        "(datum offsets are ordering-dependent, excluded for fairness). "
        "Cap-order proxies point-in-time cap with LAST-DAY trailing 63d median dollar volume "
        "(historical caps unavailable on this EODHD tier). Sector-grouped uses NASDAQ-screener "
        f"sectors (live names only): {known}/{n} lanes covered, the rest in one 'Unknown' bucket.",
        "",
        "| ordering | R 2000s | R 2010s | R 2020s | R overall | R/R(random) overall |",
        "|---|---|---|---|---|---|",
    ]
    for name, r in R.items():
        base = rnd["overall"] if "subsample" not in name else \
            R.get(f"random on {olo_tag}* (x20 mean)", rnd)["overall"]
        lines.append(f"| {name} | {r['2000s']:.4f} | {r['2010s']:.4f} | {r['2020s']:.4f} "
                     f"| {r['overall']:.4f} | {r['overall'] / base:.3f} |")
    if any("subsample" in k for k in R):
        lines.append("")
        lines.append(f"\\* hierarchical+OLO exceeded the 10-min budget at full size; scored on a "
                     f"random {OLO_SUBSAMPLE}-lane subsample against its own random baseline "
                     "(not directly comparable to full-universe rows).")
    lines += [
        "",
        f"- spectral / alphabetical per decade: {dict(zip(dec, sva))} (accept needs ≤ 0.5 in every decade)",
        f"- spectral / sector-grouped overall: {vs_sector} (accept needs < 1)",
        f"- 2-opt (window {WINDOW}, {passes} passes, {nrev} reversals): gain {gain:.2f}% "
        f"→ {'ship spectral-only (gain < 5%)' if gain < 5 else '2-opt worth keeping (gain ≥ 5%)'}",
        f"- **ACCEPT: {accept}**",
        "",
    ]
    report = ROOT / "analysis" / "report.md"
    prev = report.read_text() if report.exists() else "# Stock Universe Skier — analysis report\n"
    report.write_text(prev + "\n".join(lines))
    print(f"appended results to {report}", flush=True)

    print("GATE " + json.dumps({"accept": bool(accept), "spectral_vs_alpha": sva,
                                "vs_sector": vs_sector, "twoopt_gain_pct": round(gain, 2)}))
    return 0 if accept else 1


if __name__ == "__main__":
    sys.exit(main())
