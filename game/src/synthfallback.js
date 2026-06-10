// synthfallback.js — in-memory procedural manifest + tiles, used only when BOTH the requested
// era and the 'synthetic' era manifests 404 (task spec). Keeps the game core testable standalone:
// 4 deterministic lanes × 400 days, same int16/Z_NAN encoding as real tiles.

import { CFG } from './config.js';

const N_REAL = 4;    // 4 procedural lanes: enough to exercise plateau, margin, void, and wrap
const N_DAYS = 400;  // ~1.6 trading years: spans several month-boundary checkpoints

/** Deterministic smooth log-return path per lane (no Math.random: replays identically). */
function zOf(day, lane) {
  return (
    0.25 * Math.sin(0.045 * day + lane * 1.9) +   // ~140-day swing: rolling hills
    0.12 * Math.sin(0.013 * day * (1 + 0.3 * lane) + lane) + // lane-detuned ripple: lanes diverge
    0.0015 * day * (1 + 0.2 * lane)               // gentle uptrend: the run climbs like a bull market
  );
}

export function makeSynthProvider() {
  const nLanes = CFG.TILE_LANES; // pad the 4 real lanes to one full lane-tile (manifest rule, CONTRACTS §2)

  // synthetic trading calendar: weekdays from 2024-01-01
  const dates = [];
  let t = Date.UTC(2024, 0, 1);
  while (dates.length < N_DAYS) {
    const d = new Date(t);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) dates.push(d.toISOString().slice(0, 10));
    t += 86400e3;
  }

  const lanes = [];
  for (let i = 0; i < nLanes; i++) {
    lanes.push(
      i < N_REAL
        ? { sym: `SYN${i}`, name: `Synthetic ${i}`, sector: 'Synthetic', c: 0, born: 0, dead: -1, term: 'alive' }
        : { sym: `_PAD${i}`, name: 'pad', sector: '', c: 0, born: -1, dead: -1, term: 'unknown' }
    );
  }

  const manifest = {
    era: 'synthetic-mem',
    kHeight: CFG.K_HEIGHT,
    tileDays: CFG.TILE_DAYS,
    tileLanes: CFG.TILE_LANES,
    nDays: N_DAYS,
    nLanes,
    dates,
    lanes,
    ghost: { sym: 'SPY', z: Array.from({ length: N_DAYS }, (_, d) => 0.5 * zOf(d, 0) ) }, // tamer SPY-ish path
    rf: new Array(N_DAYS).fill(0.04), // flat 4% annualized: a visible cash drift without era drama
  };

  return {
    manifest,
    /** Same layout as z/t<T>_l<L>.bin: row-major [day][lane], int16 z×Z_SCALE, Z_NAN void. */
    fetchTile(T, L) {
      const a = new Int16Array(CFG.TILE_DAYS * CFG.TILE_LANES).fill(CFG.Z_NAN);
      for (let r = 0; r < CFG.TILE_DAYS; r++) {
        const day = T * CFG.TILE_DAYS + r;
        if (day >= N_DAYS) break;
        for (let c = 0; c < N_REAL; c++) {
          const lane = L * CFG.TILE_LANES + c;
          if (lane >= N_REAL) break;
          a[r * CFG.TILE_LANES + c] = Math.round(zOf(day, lane) * CFG.Z_SCALE);
        }
      }
      return a;
    },
  };
}
