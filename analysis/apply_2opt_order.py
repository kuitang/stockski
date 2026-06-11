#!/usr/bin/env python
"""Persist the spectral+2opt lane order that roughness_bench measured but never saved.

The benchmark proved 2-opt cuts roughness 68% (PLAN §6: keep 2-opt if gain >= 5%), so the
shipped order MUST be spectral+2opt. This re-runs the exact same deterministic two_opt()
on the cached Z matrix, verifies the gain, backs up the spectral-only order, and rewrites
data/full_order.json for export_tiles to consume.
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from roughness_bench import two_opt, roughness, DECADES, decade_slices, DATA, CACHE  # noqa: E402

order_path = DATA / "full_order.json"
symbols = json.load(open(order_path))
Z = np.load(CACHE / "Z.npy")
cal = np.array(json.load(open(CACHE / "cal.json")))  # decade_slices needs vectorized str compare
n = len(symbols)
assert Z.shape[1] == n, f"cache/order mismatch: Z has {Z.shape[1]} lanes, order has {n}"

slices = decade_slices(cal)
spectral = np.arange(n)
r0 = roughness(Z, spectral, slices)["overall"]
o2, passes, nrev = two_opt(Z, spectral, slices)
r1 = roughness(Z, o2, slices)["overall"]
gain = 100.0 * (r0 - r1) / r0
print(f"2-opt re-run: {passes} passes, {nrev} reversals, overall R {r0:.4f} -> {r1:.4f} (gain {gain:.2f}%)")
assert gain > 50, "expected ~68% gain; refusing to ship a degenerate re-run"

shutil.copy(order_path, DATA / "full_order_spectral_only.json")
json.dump([symbols[i] for i in o2], open(order_path, "w"))
print(f"saved spectral+2opt order ({n} lanes) to {order_path}; spectral-only backed up")
