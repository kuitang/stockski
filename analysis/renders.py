#!/usr/bin/env python
"""renders.py - matplotlib renders for the HUMAN aesthetics gate (PLAN $6 validation 2).

Reads the exported full-era tiles (game/public/tiles/full, plain int16 per CONTRACTS $2)
plus data/full_order.json, and writes PNGs to analysis/renders/:

  1. arc300_{alphabetical,sector,spectral}.png - the same 300-lane arc centered on the
     megacap region as a 3D surface + hillshaded heatmap, identical color scale, so a
     human can SEE what spectral ordering buys over naive orderings.
  2. era_{dotcom,gfc,covid,bear2022,full}.png - top-down heatmaps (lanes x days, z color),
     shared color scale across all five.
  3. k_sensitivity.png - one 100-lane x 200-day slice rendered as shaded relief at
     k = 15 / 25 / 40 (h = k*z, world units 1 m/day, 1 m/lane) for tuning K_HEIGHT.

Prints 'GATE {"pngs":N}' as the last line.
"""

import json
import os
import sys

import numpy as np

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import Normalize

ROOT = "/home/kuitang/git/stockski"
TILES = os.path.join(ROOT, "game/public/tiles/full")
OUT = os.path.join(ROOT, "analysis/renders")
DPI = 150

Z_SCALE = 1000.0   # int16 fixed point (CONTRACTS $0)
Z_NAN = -32768     # no-terrain sentinel (CONTRACTS $0)
K_DEFAULT = 25     # CFG.K_HEIGHT; tuned here (PLAN $1/$6)

ARC_LANES = 300    # task spec: 300-lane arc for the ordering comparison
K_STRIP_LANES = 100
K_STRIP_DAYS = 200
K_VALUES = (15, 25, 40)

# Megacap anchors used only to sanity-check the dv-weighted window choice.
MEGACAPS = ["AAPL", "MSFT", "AMZN", "NVDA", "JPM", "JNJ", "WMT", "PG", "HD",
            "INTC", "CSCO", "ORCL", "IBM", "GE", "PFE", "XOM", "KO"]


def load_manifest():
    with open(os.path.join(TILES, "manifest.json")) as f:
        return json.load(f)


def load_grid(man):
    """Load every z tile into one int16 [day][lane] array (~150 MB)."""
    td, tl = man["tileDays"], man["tileLanes"]
    n_days, n_lanes = man["nDays"], man["nLanes"]
    nt = (n_days + td - 1) // td
    nl = n_lanes // tl
    grid = np.full((nt * td, n_lanes), Z_NAN, dtype=np.int16)
    for t in range(nt):
        for l in range(nl):
            path = os.path.join(TILES, "z", f"t{t}_l{l}.bin")
            tile = np.fromfile(path, dtype="<i2").reshape(td, tl)
            grid[t * td:(t + 1) * td, l * tl:(l + 1) * tl] = tile
    return grid[:n_days]  # trim final-tile padding rows


def zf(grid_slice):
    """int16 fixed-point -> float32 z with NaN voids."""
    out = grid_slice.astype(np.float32) / Z_SCALE
    out[grid_slice == Z_NAN] = np.nan
    return out


def megacap_window(man, grid, width):
    """Circular window of `width` lanes maximizing the COUNT of top-100
    trailing-dollar-volume live names (universe.parquet) -> the megacap arc.
    (Manifest dv0 has scale outliers - e.g. MRVL 5.8e13 - so summed-dv is unusable.)"""
    import pandas as pd
    lanes = man["lanes"]
    n = len(lanes)
    u = pd.read_parquet(os.path.join(ROOT, "data/universe.parquet"))
    top = set(u[u.termination == "alive"]
              .nlargest(100, "median_dollar_vol_63d_last").symbol)
    ind = np.array([1.0 if l["sym"] in top else 0.0 for l in lanes])
    # circular moving sum via wrap-padded cumsum
    pad = np.concatenate([ind, ind[:width]])
    cs = np.concatenate([[0.0], np.cumsum(pad)])
    sums = cs[width:width + n] - cs[:n]
    start = int(np.argmax(sums))
    idx = [(start + j) % n for j in range(width)]
    win_syms = {lanes[i]["sym"] for i in idx}
    inside = [s for s in MEGACAPS if s in win_syms]
    print(f"megacap arc: lanes [{start}..{(start + width - 1) % n}] (circular), "
          f"{int(sums[start])} top-100-dollar-volume names inside; "
          f"anchors present: {inside}")
    return idx


def load_sectors():
    """Sector labels from the cached NASDAQ screener dump (live stocks only;
    EODHD fundamentals are 403 on this plan - phase0 report $4). Missing -> 'Unknown'."""
    path = os.path.join(ROOT, "data/tmp_nasdaq_screener.json")
    sectors = {}
    if os.path.exists(path):
        with open(path) as f:
            rows = json.load(f)["data"]["rows"]
        for r in rows:
            sectors[r["symbol"]] = r.get("sector") or "Unknown"
    return sectors


def year_ticks(dates, ax, day0=0, stride_days=1):
    """Yearly ticks on a day-index x axis; monthly when the span is short."""
    monthly = len(dates) < 600
    key = (lambda d: d[:7]) if monthly else (lambda d: d[:4])
    ticks, labels = [], []
    last = None
    for i, d in enumerate(dates):
        k = key(d)
        if k != last:
            ticks.append((i - day0) / stride_days)
            labels.append(k)
            last = k
    ax.set_xticks(ticks)
    ax.set_xticklabels(labels, fontsize=7, rotation=45 if monthly else 0)


# ---------------------------------------------------------------- render 1

def render_arc_orderings(man, grid, out_paths):
    lanes = man["lanes"]
    dates = man["dates"]
    idx = megacap_window(man, grid, ARC_LANES)
    sectors = load_sectors()

    syms = [lanes[i]["sym"] for i in idx]
    orders = {
        "spectral": idx,  # manifest order IS the spectral order (data/full_order.json)
        "alphabetical": [i for _, i in sorted(zip(syms, idx))],
        "sector": [i for _, i in sorted(
            zip([(sectors.get(lanes[i]["sym"], "Unknown"), lanes[i]["sym"])
                 for i in idx], idx))],
    }

    full = zf(grid)  # full-resolution float view
    # shared color scale: same 300 lanes in every ordering -> same data, same scale
    pool = full[::16][:, idx]
    vmin, vmax = np.nanpercentile(pool, [2, 98])
    norm = Normalize(vmin=vmin, vmax=vmax)
    cmap = plt.get_cmap("terrain").copy()
    cmap.set_bad("#202028")

    # 3D surface over the first 500 trading days (dot-com era) - the window where
    # this arc is fully populated; full sweep goes in the heatmap panel below.
    d3_days, d3_stride = 500, 2
    n_paths = []
    for name, order in orders.items():
        Z = full[:d3_days:d3_stride][:, order]  # [250][300]
        Zh = full[:, order]                     # [day][300] full sweep
        dayS = np.arange(Z.shape[0]) * d3_stride
        X, Y = np.meshgrid(np.arange(ARC_LANES), dayS)

        fig = plt.figure(figsize=(13, 10))
        gs = fig.add_gridspec(2, 1, height_ratios=[2.0, 1.0])
        ax3 = fig.add_subplot(gs[0], projection="3d")
        fc = cmap(norm(np.ma.masked_invalid(Z)))
        ax3.plot_surface(X, Y, np.nan_to_num(Z, nan=vmin), facecolors=fc,
                         rstride=1, cstride=1, linewidth=0, antialiased=False,
                         shade=False)
        ax3.set_xlabel("lane (within arc)", fontsize=8)
        ax3.set_ylabel(f"trading day ({dates[0]} + {d3_days}d)", fontsize=8)
        ax3.set_zlabel("z", fontsize=8)
        ax3.set_title(f"3D surface, first {d3_days} days (dot-com era)", fontsize=9)
        ax3.view_init(elev=45, azim=-60)
        ax3.set_box_aspect((4, 5, 1), zoom=1.2)

        ax2 = fig.add_subplot(gs[1])
        ax2.imshow(Zh.T, origin="lower", aspect="auto", cmap=cmap, norm=norm,
                   interpolation="nearest")
        ax2.set_ylabel("lane (within arc)", fontsize=8)
        ax2.set_xlabel("date", fontsize=8)
        year_ticks(dates, ax2)
        ax2.set_title("top-down heatmap, full resolution "
                      "(smooth color across lanes = good ordering)", fontsize=9)

        fig.suptitle(f"Megacap 300-lane arc, {name} ordering - "
                     f"2000-2026, identical color scale "
                     f"[{vmin:.2f}, {vmax:.2f}]", fontsize=12)
        fig.colorbar(plt.cm.ScalarMappable(norm=norm, cmap=cmap), ax=ax2,
                     fraction=0.025, pad=0.01, label="z")
        fig.tight_layout(rect=(0, 0, 1, 0.97))
        p = os.path.join(OUT, f"arc300_{name}.png")
        fig.savefig(p, dpi=DPI)
        plt.close(fig)
        n_paths.append(p)
        print("wrote", p)
    return n_paths, idx


# ---------------------------------------------------------------- render 2

ERAS = [
    ("dotcom",   "2000-01-03", "2002-12-31", "Dot-com bust 2000-2002"),
    ("gfc",      "2007-01-03", "2009-12-31", "GFC 2007-2009"),
    ("covid",    "2020-01-02", "2020-12-31", "COVID 2020"),
    ("bear2022", "2022-01-03", "2022-12-30", "2022 bear"),
    ("full",     None,         None,         "Full sweep 2000-2026"),
]


def render_eras(man, grid):
    dates = man["dates"]
    n_lanes = man["nLanes"]
    # absolute scale (full sweep): robust percentiles of the whole window
    sample = zf(grid[::8])
    vmin, vmax = np.nanpercentile(sample, [1, 99])

    def day_index(target):
        # first trading day >= target
        for i, d in enumerate(dates):
            if d >= target:
                return i
        return len(dates) - 1

    paths = []
    for key, d0, d1, title in ERAS:
        full_sweep = d0 is None
        if full_sweep:
            i0, i1, stride = 0, len(dates), 4  # downsampled in time
        else:
            i0, i1, stride = day_index(d0), day_index(d1) + 1, 1
        Z = zf(grid[i0:i1:stride])  # [day][lane]
        if full_sweep:
            # absolute z: the mountain range as shipped
            cmap = plt.get_cmap("terrain").copy()
            norm = Normalize(vmin=vmin, vmax=vmax)
            label = "z (cum log return + datum)"
            sub = "absolute z"
        else:
            # era-relative dz = z - z(era start) per lane: constant per-lane shift
            # (financially meaningless datum, PLAN $1) so the ERA's story is visible
            Z = Z - Z[0]
            a = np.nanpercentile(np.abs(Z), 98)
            cmap = plt.get_cmap("RdYlBu").copy()  # blue=up, red=down, snow-friendly
            norm = Normalize(vmin=-a, vmax=a)
            label = "z - z(era start)  (cum log return within era)"
            sub = "era-relative dz, symmetric scale"
        cmap.set_bad("#202028")
        fig, ax = plt.subplots(figsize=(13, 8))
        ax.imshow(Z.T, origin="lower", aspect="auto", cmap=cmap, norm=norm,
                  interpolation="nearest")
        ax.set_ylabel(f"lane (spectral order, 0..{n_lanes - 1})", fontsize=8)
        ax.set_xlabel("date", fontsize=8)
        year_ticks(dates[i0:i1], ax, day0=0, stride_days=stride)
        ax.set_title(f"{title} - top-down heatmap ({dates[i0]} to {dates[i1 - 1]}, "
                     f"{n_lanes} lanes; {sub}; dark = no terrain)", fontsize=11)
        fig.colorbar(plt.cm.ScalarMappable(norm=norm, cmap=cmap), ax=ax,
                     fraction=0.025, pad=0.01, label=label)
        fig.tight_layout()
        p = os.path.join(OUT, f"era_{key}.png")
        fig.savefig(p, dpi=DPI)
        plt.close(fig)
        paths.append(p)
        print("wrote", p)
    return paths


# ---------------------------------------------------------------- render 3

def render_k_strip(man, grid, arc_idx):
    """100-lane x 200-day slice as shaded-relief-style RIDGELINE PROFILES at
    k = 15/25/40. Each lane is one profile h(t) = k*z(t) in true meters; lanes are
    drawn back-to-front with 1 m offset (the true lane pitch) and painter occlusion,
    so the picture is a side-on view of the actual world geometry - the user reads
    skiable steepness directly. Window = COVID crash through the contiguous 100-lane
    stretch (near the megacap arc if possible) with the best terrain coverage."""
    dates = man["dates"]
    n_lanes = man["nLanes"]
    i0 = next(i for i, d in enumerate(dates) if d >= "2020-01-02")
    days = slice(i0, i0 + K_STRIP_DAYS)
    Zall = zf(grid[days])  # [200][allLanes]

    # contiguous (circular) 100-lane window with max alive coverage, preferring
    # windows overlapping the megacap arc
    cov = 1.0 - np.isnan(Zall).mean(axis=0)  # per-lane coverage in the slice
    w = K_STRIP_LANES
    pad = np.concatenate([cov, cov[:w]])
    cs = np.concatenate([[0.0], np.cumsum(pad)])
    wcov = (cs[w:w + n_lanes] - cs[:n_lanes]) / w
    arc = set(arc_idx)
    pref = np.array([wcov[s] if any(((s + j) % n_lanes) in arc for j in (0, w - 1))
                     else -1.0 for s in range(n_lanes)])
    start = int(np.argmax(pref))
    if wcov[start] < 0.9:  # arc too dead here -> best window anywhere
        start = int(np.argmax(wcov))
    lanes100 = [(start + j) % n_lanes for j in range(w)]
    Z = Zall[:, lanes100]  # [200][100]
    print(f"k-strip window: lanes [{start}..{(start + w - 1) % n_lanes}], "
          f"coverage {wcov[start]:.1%}, days {dates[i0]}..{dates[i0 + K_STRIP_DAYS - 1]}")

    zmid = np.nanmedian(Z)  # common datum shift for display only
    cmap = plt.get_cmap("terrain")
    cnorm = Normalize(*np.nanpercentile(Z, [2, 98]))
    t = np.arange(K_STRIP_DAYS)  # meters along time (1 m/day)

    fig, axes = plt.subplots(1, len(K_VALUES), figsize=(17, 7))
    for ax, k in zip(axes, K_VALUES):
        ax.set_facecolor("#15151c")
        floor = k * (np.nanmin(Z) - zmid) - 3  # common apron under the nearest lane
        # painter order: far lane (99) first, near lane (0) last
        for j in range(w - 1, -1, -1):
            y = j * 1.0 + k * (Z[:, j] - zmid)  # 1 m lane pitch + h in meters
            col = cmap(cnorm(np.nanmean(Z[:, j]))) if not np.all(np.isnan(Z[:, j])) \
                else (0.3, 0.3, 0.3, 1)
            ax.fill_between(t, floor, y, where=~np.isnan(y),
                            color=col, alpha=1.0, lw=0)
            ax.plot(t, y, color="black", lw=0.3)
        ax.set_aspect(1.0)  # meters x meters: steepness on screen = steepness in game
        ax.set_ylabel("meters (1 m lane pitch + k*z)", fontsize=8)
        ax.set_title(f"k = {k}", fontsize=12)
        ax.margins(x=0)
        ax.set_xlabel("meters along time axis", fontsize=8)
    fig.suptitle(f"K_HEIGHT sensitivity - 100-lane x {K_STRIP_DAYS}-day slice from "
                 f"{dates[i0]} (COVID crash) as side-on ridgeline profiles, equal "
                 f"aspect, 1 m/day x 1 m/lane pitch - tune k: relief vs lane pitch",
                 fontsize=11)
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    p = os.path.join(OUT, "k_sensitivity.png")
    fig.savefig(p, dpi=DPI)
    plt.close(fig)
    print("wrote", p)
    return [p]


# ---------------------------------------------------------------- main

CAPTIONS = {
    "arc300_spectral.png": "Same 300-lane megacap arc, SPECTRAL (shipped) order - lanes flow smoothly; ridgelines are coherent neighborhoods.",
    "arc300_alphabetical.png": "Same 300 lanes, ALPHABETICAL order - high-frequency lane-to-lane noise; terrain is unskiable static.",
    "arc300_sector.png": "Same 300 lanes, SECTOR-GROUPED order (NASDAQ screener sectors, alphabetical within) - smoother than alphabetical, still seams at sector boundaries.",
    "era_dotcom.png": "Dot-com bust 2000-2002, all 10,880 lanes top-down (era-relative dz, blue=up red=down) - tech arcs collapse while value arcs hold.",
    "era_gfc.png": "GFC 2007-2009, all lanes top-down (era-relative dz) - broad 2008 cliff across the whole cylinder.",
    "era_covid.png": "COVID 2020, all lanes top-down (era-relative dz) - vertical Mar-2020 crevasse then bifurcated recovery.",
    "era_bear2022.png": "2022 bear, all lanes top-down (era-relative dz) - slow grind down, growth arcs sag hardest.",
    "era_full.png": "Full sweep 2000-2026 (days downsampled 4x), absolute z, all lanes - lane births/deaths visible as dark void wedges.",
    "k_sensitivity.png": "K_HEIGHT tuning strip: 100 contiguous lanes x 200 days (COVID crash) as side-on ridgeline profiles at k=15/25/40, true meters and equal aspect - pick the k whose relief reads as skiable.",
}


def main():
    os.makedirs(OUT, exist_ok=True)
    man = load_manifest()
    print(f"era={man['era']} nDays={man['nDays']} nLanes={man['nLanes']}")
    grid = load_grid(man)
    print(f"grid loaded: {grid.shape}, {grid.nbytes / 1e6:.0f} MB")

    paths = []
    arc_paths, arc_idx = render_arc_orderings(man, grid, OUT)
    paths += arc_paths
    paths += render_eras(man, grid)
    paths += render_k_strip(man, grid, arc_idx)

    with open(os.path.join(OUT, "INDEX.md"), "w") as f:
        f.write("# Aesthetics-gate renders (PLAN $6 validation 2)\n\n")
        for p in paths:
            name = os.path.basename(p)
            f.write(f"- `{name}` - {CAPTIONS[name]}\n")

    print(f'GATE {{"pngs":{len(paths)}}}')


if __name__ == "__main__":
    main()
