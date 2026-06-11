#!/usr/bin/env python
"""Circular spectral lane ordering (PLAN paragraph 6.4).

Input : data/parquet/*.parquet, data/universe.parquet, one era from pipeline/eras.json.
Output: data/<era>_order.json -- a JSON list of symbols in circular lane order.

Method (PLAN paragraph 6.4 / paragraph 4.1):
  * Top-N selection: point-in-time rank by trailing 63d median dollar volume
    (close * volume), recomputed monthly inside the era; union of memberships.
  * Per symbol: EARLIEST available trailing 126-day window of daily log returns
    inside the era (incl. burn-in).
  * Pairwise-complete Pearson correlations (>= 60 overlap days); symbols with no
    qualifying pair are seated next to their most-correlated proxy by whatever
    overlap is available.
  * W = (1 + rho) / 2 (zero where no estimate), L = D - W,
    scipy.sparse.linalg.eigsh smallest eigenvectors -> v2, v3 ->
    circular order by atan2(v3, v2).
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix, csr_matrix, identity
from scipy.sparse.linalg import LinearOperator, eigsh, lobpcg, splu

CORR_WINDOW = 126     # ~6 months of daily returns: earliest window long enough for a stable corr (PLAN 6.4)
MIN_OVERLAP = 60      # pairs sharing fewer days get no edge in W (PLAN 6.4)
RANK_WINDOW = 63      # trailing 63-trading-day median dollar volume defines the universe rank (PLAN 0)
MIN_RANK_OBS = 21     # >= 1 month of trading before a symbol is rankable (a 2-day IPO median is noise)
PROXY_MIN_OVERLAP = 5 # proxy seating: 5 shared days is the floor for a correlation to even have a sign
EIG_SIGMA = -1e-6     # shift-invert target just below 0: L is PSD, so this finds the smallest eigenpairs
SEED = 0              # fixed eigsh starting vector -> bit-identical ordering across runs
EIG_DENSE_MAX = 2000  # above this n the dense-as-csr shift-invert LU is effectively a dense O(n^3)
                      # sequential factorization (the era-start cohort is a dense block); switch to the
                      # sanctioned fallback: k-NN sparsified W + LOBPCG (task spec)
KNN_K = 64            # k-NN sparsification degree for the large-n fallback (task spec)
LOBPCG_TOL = 1e-8     # residual tolerance: v2/v3 angles must be stable to well below one lane
LOBPCG_MAXITER = 200  # with the splu(L+eps I) preconditioner LOBPCG converges in O(10) iterations


def load_era(config_path: Path, name: str) -> dict:
    """eras.json may be a dict keyed by name, a {'eras':[...]} wrapper, or a bare list."""
    cfg = json.loads(Path(config_path).read_text())
    if isinstance(cfg, dict) and name in cfg:
        era = dict(cfg[name])
    elif isinstance(cfg, dict) and "eras" in cfg:
        era = dict(next(e for e in cfg["eras"] if e["name"] == name))
    elif isinstance(cfg, list):
        era = dict(next(e for e in cfg if e["name"] == name))
    else:
        raise KeyError(f"era {name!r} not found in {config_path}")
    era.setdefault("name", name)
    return era


def load_wide_frames(data_dir: Path, symbols, start, end):
    """Return (adj_close, dollar_volume) wide DataFrames (date x symbol), float32."""
    adj, dv = {}, {}
    for sym in symbols:
        p = data_dir / "parquet" / f"{sym}.parquet"
        if not p.exists():
            continue
        df = pd.read_parquet(p, columns=["date", "close", "adjusted_close", "volume"])
        idx = pd.to_datetime(df["date"])
        m = (idx >= start) & (idx <= end)
        if not m.any():
            continue
        idx = idx[m]
        adj[sym] = pd.Series(df.loc[m.values, "adjusted_close"].values, index=idx)
        # dollar volume = UNADJUSTED close * volume (CONTRACTS section 1 / PLAN 0)
        dv[sym] = pd.Series(
            (df.loc[m.values, "close"] * df.loc[m.values, "volume"]).values, index=idx
        )
    adj_w = pd.DataFrame(adj).sort_index().astype(np.float32)
    dv_w = pd.DataFrame(dv).sort_index().astype(np.float32)
    return adj_w, dv_w


def point_in_time_top_n(dv_wide: pd.DataFrame, start, end, top_n: int) -> list:
    """Union of monthly point-in-time top-N memberships by trailing 63d median dollar volume."""
    med = dv_wide.rolling(RANK_WINDOW, min_periods=MIN_RANK_OBS).median()
    days = med.index[(med.index >= start) & (med.index <= end)]
    if len(days) == 0:
        raise ValueError("era window contains no trading days")
    # monthly recompute for speed (task spec): first trading day of each month, plus era start
    periods = days.to_period("M")
    rank_days = [days[0]] + [days[periods == p][0] for p in periods.unique()]
    selected: set = set()
    for d in pd.DatetimeIndex(rank_days).unique():
        row = med.loc[d].dropna()
        selected |= set(row.nlargest(top_n).index)
    return sorted(selected)


def earliest_return_windows(adj_wide: pd.DataFrame, symbols) -> pd.DataFrame:
    """Per symbol: first CORR_WINDOW daily log returns inside the era; aligned on union dates."""
    cols = {}
    for sym in symbols:
        s = adj_wide[sym].dropna()
        r = np.log(s).diff().dropna()
        if len(r) == 0:
            continue
        cols[sym] = r.iloc[:CORR_WINDOW]
    return pd.DataFrame(cols).sort_index()


def pairwise_corr(R: np.ndarray):
    """Pairwise-complete Pearson correlation on a float32 (days x n) matrix with NaN holes.

    Returns (rho, overlap_counts); rho is NaN where undefined (overlap < 2 or zero variance).
    """
    R = R.astype(np.float32, copy=False)  # memory care (task spec): float32 aligned-returns matrix
    M = np.isfinite(R)
    X = np.where(M, R, 0).astype(np.float32)
    Mf = M.astype(np.float32)
    n = (Mf.T @ Mf).astype(np.float64)
    Sx = (X.T @ Mf).astype(np.float64)        # Sx[i,j] = sum of x_i over overlap(i,j)
    Sxx = ((X * X).T @ Mf).astype(np.float64)
    Sxy = (X.T @ X).astype(np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        mi = Sx / n          # mean of i on overlap(i,j)
        mj = Sx.T / n        # mean of j on overlap(i,j)
        cov = Sxy / n - mi * mj
        vi = Sxx / n - mi * mi
        vj = Sxx.T / n - mj * mj
        rho = cov / np.sqrt(vi * vj)
    rho = np.clip(rho, -1.0, 1.0)
    bad = (~np.isfinite(rho)) | (n < 2) | (vi <= 0) | (vj <= 0)
    rho[bad] = np.nan
    return rho, n


def _knn_sparsify(W: np.ndarray, k: int = KNN_K) -> csr_matrix:
    """Keep the k strongest edges per row, symmetrized by max (union k-NN graph)."""
    n = W.shape[0]
    kk = min(k, n - 1)
    idx = np.argpartition(W, -kk, axis=1)[:, -kk:]
    rows = np.repeat(np.arange(n), kk)
    cols = idx.ravel()
    vals = W[rows, cols]
    keep = vals > 0
    S = coo_matrix((vals[keep], (rows[keep], cols[keep])), shape=(n, n)).tocsr()
    return S.maximum(S.T)


def _small_eigs(L_sparse: csr_matrix, n: int, rng: np.random.Generator):
    """3 smallest eigenpairs of sparse L via preconditioned LOBPCG (task-spec fallback);
    eigsh shift-invert on the SPARSE L is the backstop if LOBPCG fails to converge."""
    M = LinearOperator((n, n), matvec=splu((L_sparse + 1e-8 * identity(n)).tocsc()).solve)
    X = rng.standard_normal((n, 6))  # extra block vectors stabilize the smallest triplet
    X[:, 0] = 1.0                    # seed the (near-)nullspace direction explicitly
    try:
        vals, vecs = lobpcg(L_sparse, X, M=M, largest=False, tol=LOBPCG_TOL,
                            maxiter=LOBPCG_MAXITER)
        srt = np.argsort(vals)[:3]
        return vals[srt], vecs[:, srt], "knn64+lobpcg"
    except Exception as e:
        print(f"note: lobpcg failed ({e}); backstop eigsh shift-invert on sparse L", flush=True)
        v0 = rng.standard_normal(n)
        vals, vecs = eigsh(L_sparse, k=3, sigma=EIG_SIGMA, which="LM", v0=v0)
        srt = np.argsort(vals)
        return vals[srt], vecs[:, srt], "knn64+eigsh_sparse"


def spectral_circular_order(rho: np.ndarray, overlap: np.ndarray, rng: np.random.Generator):
    """Return (index order around the circle, eig-method note). Isolated nodes proxy-seated after."""
    n = rho.shape[0]
    valid = np.isfinite(rho) & (overlap >= MIN_OVERLAP)
    np.fill_diagonal(valid, False)
    W = np.where(valid, (1.0 + rho) / 2.0, 0.0)  # similarity in [0,1]; zero where no estimate (task spec)
    W = (W + W.T) / 2.0                          # enforce exact symmetry for eigsh
    has_edge = W.sum(axis=1) > 0
    core = np.flatnonzero(has_edge)
    isolated = np.flatnonzero(~has_edge)
    eig_method = "trivial"

    if len(core) >= 4:  # eigsh needs k=3 < n; below that any order is trivially "circular"
        Wc = W[np.ix_(core, core)]
        if len(core) <= EIG_DENSE_MAX:
            L = np.diag(Wc.sum(axis=1)) - Wc
            v0 = rng.standard_normal(len(core))  # fixed seed -> deterministic eigenvectors
            vals, vecs = eigsh(csr_matrix(L), k=3, sigma=EIG_SIGMA, which="LM", v0=v0)
            srt = np.argsort(vals)
            v2, v3 = vecs[:, srt[1]], vecs[:, srt[2]]
            eig_method = "dense_eigsh_shift_invert"
        else:
            S = _knn_sparsify(Wc)
            Ls = csr_matrix(
                coo_matrix((np.asarray(S.sum(axis=1)).ravel(),
                            (np.arange(len(core)), np.arange(len(core)))),
                           shape=S.shape)) - S
            vals, vecs, eig_method = _small_eigs(Ls.tocsr(), len(core), rng)
            v2, v3 = vecs[:, 1], vecs[:, 2]
        theta = np.arctan2(v3, v2)
        order = list(core[np.argsort(theta)])
    else:
        order = list(core)

    # Proxy seating (PLAN 6.4): no >=60-day edge -> sit next to the most-correlated
    # already-placed symbol using whatever overlap exists.
    for i in isolated:
        placed = np.array(order, dtype=int)
        if len(placed) == 0:
            order.append(int(i))
            continue
        r = rho[i, placed].copy()
        r[overlap[i, placed] < PROXY_MIN_OVERLAP] = np.nan
        if np.all(~np.isfinite(r)):
            order.append(int(i))  # no usable overlap with anyone: park at the end of the arc
        else:
            j = int(np.nanargmax(r))
            order.insert(j + 1, int(i))
    return order, eig_method


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--era", required=True)
    ap.add_argument("--data-dir", default="data/")
    ap.add_argument("--out", default="game/public/tiles/")  # CONTRACTS 5 uniform CLI; ordering writes to data-dir
    ap.add_argument("--config", default=str(Path(__file__).parent / "eras.json"))
    args = ap.parse_args(argv)

    data_dir = Path(args.data_dir)
    era = load_era(Path(args.config), args.era)
    start = pd.Timestamp(era["start"])
    # end: null in eras.json means "through the latest available data" (CONTRACTS 5)
    end = pd.Timestamp(era["end"]) if era.get("end") else pd.Timestamp.max
    if era.get("burnin_start"):
        burnin = pd.Timestamp(era["burnin_start"])
    elif era.get("burnin_days"):
        # burnin_days counts business days before era start (eras.json recent2y form)
        burnin = start - pd.tseries.offsets.BDay(int(era["burnin_days"]))
    else:
        burnin = start
    top_n = int(era["top_n"])

    t0 = time.monotonic()

    def mark(stage):
        print(f"stage: {stage} done at {time.monotonic() - t0:.1f}s", flush=True)

    uni = pd.read_parquet(data_dir / "universe.parquet")
    # SPY is the ghost, never a lane (PLAN 7); everything else in the universe is a candidate
    candidates = [s for s in uni["symbol"].astype(str) if s != "SPY"]
    adj_w, dv_w = load_wide_frames(data_dir, candidates, burnin, end)
    mark(f"load_wide_frames n={adj_w.shape[1]} days={adj_w.shape[0]}")
    if adj_w.shape[1] == 0:
        print('GATE {"ok": false, "error": "no price data in era window"}')
        return 1

    selected = point_in_time_top_n(dv_w, start, end, top_n)
    mark(f"point_in_time_top_n selected={len(selected)}")
    del dv_w
    rets = earliest_return_windows(adj_w, selected)
    mark(f"earliest_return_windows shape={rets.shape}")
    del adj_w
    syms = list(rets.columns)
    if len(syms) == 0:
        print('GATE {"ok": false, "error": "no symbols with returns in era window"}')
        return 1

    rho, overlap = pairwise_corr(rets.to_numpy(dtype=np.float32))
    mark("pairwise_corr")
    rng = np.random.default_rng(SEED)
    order_idx, eig_method = spectral_circular_order(rho, overlap, rng)
    mark(f"spectral_circular_order method={eig_method}")
    order = [syms[i] for i in order_idx]

    out_path = data_dir / f"{era['name']}_order.json"
    out_path.write_text(json.dumps(order, indent=0))
    print(f"GATE {json.dumps({'ok': True, 'era': era['name'], 'n_lanes': len(order), 'eig': eig_method, 'seconds': round(time.monotonic() - t0, 1), 'order': str(out_path)})}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
