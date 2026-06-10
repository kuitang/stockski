// clock.js — world clock τ in fractional trading days (CONTRACTS §3).
// Owns pause/speed and month-boundary checkpoints derived from the manifest trading calendar
// (plan §7: death/respawn rewinds the clock to the last month boundary).

import { CFG } from './config.js';

export class WorldClock {
  /**
   * @param {object} [opts]
   * @param {number}   [opts.daysPerSec] trading days per real second (default CFG.CLOCK_DPS)
   * @param {string[]} [opts.dates]     manifest.dates — ISO trading calendar; defines month boundaries
   * @param {number}   [opts.startTau]  starting τ (fractional trading days)
   */
  constructor({ daysPerSec = CFG.CLOCK_DPS, dates = [], startTau = 0 } = {}) {
    this.daysPerSec = daysPerSec;
    this.tau = startTau;
    this.paused = false;
    this.maxTau = dates.length > 0 ? dates.length - 1 : Infinity; // clamp at era end: the future does not exist
    // month boundaries: first trading day of each calendar month (ISO "YYYY-MM" change), plus day 0
    this.boundaries = [0];
    for (let d = 1; d < dates.length; d++) {
      if (dates[d].slice(0, 7) !== dates[d - 1].slice(0, 7)) this.boundaries.push(d);
    }
    this._ckpt = this._latestBoundary(startTau);
    this._bi = this._firstBoundaryAfter(this._ckpt);
  }

  /** Advance τ by dtSec of real time (no-op while paused). Auto-checkpoints crossed month boundaries. */
  update(dtSec) {
    if (this.paused) return this.tau;
    return this.tick(dtSec);
  }

  /** Advance τ IGNORING pause — debug.runScript drives time synchronously while the clock is
   *  paused (it pauses so the render loop can't double-step). Same clamp + checkpoint bookkeeping. */
  tick(dtSec) {
    this.tau = Math.min(this.tau + this.daysPerSec * dtSec, this.maxTau);
    while (this._bi < this.boundaries.length && this.boundaries[this._bi] <= this.tau) {
      this._ckpt = this.boundaries[this._bi];
      this._bi++;
    }
    return this.tau;
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }
  setSpeed(daysPerSec) { this.daysPerSec = daysPerSec; }

  /** τ (trading days) of the active checkpoint — the latest month boundary reached. */
  get checkpointTau() { return this._ckpt; }

  /** Re-anchor the checkpoint at the latest month boundary ≤ current τ. Returns it. */
  checkpoint() {
    this._ckpt = this._latestBoundary(this.tau);
    this._bi = this._firstBoundaryAfter(this._ckpt);
    return this._ckpt;
  }

  /** Rewind τ to the active checkpoint (plan §7 respawn: a meta device, exempt from the invariant). */
  rewind() {
    this.tau = this._ckpt;
    this._bi = this._firstBoundaryAfter(this._ckpt);
    return this.tau;
  }

  _latestBoundary(tau) {
    let c = this.boundaries[0] ?? 0;
    for (const b of this.boundaries) {
      if (b <= tau) c = b;
      else break;
    }
    return c;
  }

  _firstBoundaryAfter(tau) {
    const i = this.boundaries.findIndex((b) => b > tau);
    return i < 0 ? this.boundaries.length : i;
  }
}
