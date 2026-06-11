// input.js — keyboard + touch input (plan §7, CONTRACTS §3; leverage ext: dial spans 0..CFG.W_MAX).
// Exports: Input class -> poll(): {steer, wTarget, jump}; plus pure helpers for tests.
// Only world-constant import is CFG.W_MAX (the leverage cap); everything else is input-feel local.

import { CFG } from './config.js';

export const DIAL_RATE = 1.2;     // w units/sec via W/S keys: same dial feel as v1 — 0->2 now takes ~1.7 s
export const STEER_ATTACK = 7;    // 1/s toward target: full lock in ~0.14 s — responsive but visibly smoothed
export const STEER_RELEASE = 10;  // 1/s back to 0: releasing keys straightens faster than it locks (return-to-center)
export const STEER_DRAG_PX = 90;  // px of horizontal thumb drag for full steering lock — comfortable one-thumb arc
export const FLICK_VY = 1200;     // px/s downward at touch release => slam wTarget=0 (plan §7 flick-down threshold)
export const HOLD_MS = 350;       // press-and-hold this long on the exposure zone => re-land wTarget=1 (plan §7)
export const HOLD_MOVE_PX = 10;   // finger may wander at most this far and still count as a hold, not a drag
export const DETENT_HOLD_MS = 80; // touch drag crossing w=1 pins there this long — haptic-style resistance the
                                  // thumb feels before committing to leverage (or back out of it)
const MAX_POLL_DT = 0.1;          // s; cap poll dt so a background-tab gap can't spin the dial across its range

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Pure dial math: move w by dir (-1|0|+1) at DIAL_RATE for dt seconds, clamped to [0, max].
 *  Default max = 1 keeps the original helper contract; Input.poll passes CFG.W_MAX (leverage). */
export function dialStep(w, dir, dt, max = 1) {
  return clamp(w + dir * DIAL_RATE * dt, 0, max);
}

/** Pure touch-dial mapping: full exposure-zone travel (zone height px) sweeps the whole 0..W_MAX
 *  dial — at 2x range the same thumb arc covers leverage without re-gripping. dyPx > 0 = drag UP. */
export function expoFromDrag(w0, dyPx, zoneHpx) {
  return clamp(w0 + (dyPx / Math.max(zoneHpx, 1)) * CFG.W_MAX, 0, CFG.W_MAX);
}

/** Pure detent gate for touch: when the drag target crosses w=1, pin it at 1 for DETENT_HOLD_MS
 *  (hold-resistance), then let it through. `st` carries {detentT: null|ms} across moves. */
export function detentGate(prevTarget, rawTarget, st, now) {
  if (st.detentT === null && (prevTarget - 1) * (rawTarget - 1) < 0) st.detentT = now; // crossing
  if (st.detentT !== null) {
    if (now - st.detentT < DETENT_HOLD_MS) return 1; // resist: thumb must dwell through the detent
    st.detentT = null; // dwell served: pass through
  }
  return rawTarget;
}

/** Pure steering smoothing: move cur toward target; faster when returning to center. */
export function steerStep(cur, target, dt) {
  const rate = target === 0 ? STEER_RELEASE : STEER_ATTACK;
  const maxMove = rate * dt;
  return cur + clamp(target - cur, -maxMove, maxMove);
}

/** Flick-down detector: positive vy = finger moving down the screen. */
export function isFlickDown(vyPxPerSec) {
  return vyPxPerSec > FLICK_VY;
}

/** Tap-hold detector: long press with negligible travel. */
export function isTapHold(durMs, movedPx) {
  return durMs >= HOLD_MS && movedPx < HOLD_MOVE_PX;
}

export class Input {
  /**
   * @param {EventTarget} [surface] game surface element (canvas/body) for touch; key
   *   listeners go on window. Omit (e.g. in node tests) to skip listener attachment.
   */
  constructor(surface) {
    this.steer = 0;
    this.wTarget = 1; // spawn fully weighted: grounded skiing is the default state (plan §3 detent)
    this._keys = new Set();
    this._lastT = null;
    // touch state: one finger per gesture zone (plan §7: gesture zones = whole thirds)
    this._steerTouch = null; // {id, x0}
    this._expoTouch = null;  // {id, y0, w0, t0, lastY, lastT, vy, moved}
    this._touchSteerTarget = null; // null when no steer finger down
    this._detach = null;
    if (surface) this.attach(surface);
  }

  attach(surface) {
    const win = typeof window !== 'undefined' ? window : null;
    const onKeyDown = (e) => this._key(e, true);
    const onKeyUp = (e) => this._key(e, false);
    const onTouchStart = (e) => { e.preventDefault(); this._touchStart(e); };
    const onTouchMove = (e) => { e.preventDefault(); this._touchMove(e); };
    const onTouchEnd = (e) => { e.preventDefault(); this._touchEnd(e); };
    const onGesture = (e) => e.preventDefault(); // iOS Safari pinch-zoom (plan §7: gesturestart prevented)
    win?.addEventListener('keydown', onKeyDown);
    win?.addEventListener('keyup', onKeyUp);
    // non-passive so preventDefault actually blocks scroll/rubber-band (plan §7 lockdown contract)
    const opts = { passive: false };
    surface.addEventListener('touchstart', onTouchStart, opts);
    surface.addEventListener('touchmove', onTouchMove, opts);
    surface.addEventListener('touchend', onTouchEnd, opts);
    surface.addEventListener('touchcancel', onTouchEnd, opts);
    const doc = typeof document !== 'undefined' ? document : null;
    doc?.addEventListener('gesturestart', onGesture, opts);
    this._detach = () => {
      win?.removeEventListener('keydown', onKeyDown);
      win?.removeEventListener('keyup', onKeyUp);
      surface.removeEventListener('touchstart', onTouchStart);
      surface.removeEventListener('touchmove', onTouchMove);
      surface.removeEventListener('touchend', onTouchEnd);
      surface.removeEventListener('touchcancel', onTouchEnd);
      doc?.removeEventListener('gesturestart', onGesture);
    };
  }

  dispose() { this._detach?.(); }

  _key(e, down) {
    const c = e.code;
    const game = c === 'KeyA' || c === 'KeyD' || c === 'KeyW' || c === 'KeyS' ||
      c === 'ArrowLeft' || c === 'ArrowRight' || c === 'ArrowUp' || c === 'ArrowDown' ||
      c === 'Space' || c === 'KeyE' || c === 'KeyR';
    if (!game) return;
    e.preventDefault(); // SPACE scrolls / arrows scroll the page otherwise
    if (down) {
      this._keys.add(c);
      if (c === 'Space') this.wTarget = 0;          // slam: full unweight to cash (plan §2.3)
      if (c === 'KeyE') this.wTarget = 1;           // re-land: exactly 1x — full unlevered exposure, not max
      if (c === 'KeyR') this.wTarget = CFG.W_MAX;   // risk-on: 2x leverage (physics detent still gates the crossing)
    } else {
      this._keys.delete(c);
    }
  }

  _zone(x) {
    const w = (typeof window !== 'undefined' && window.innerWidth) || 1;
    return x < w / 3 ? 'steer' : x > (2 * w) / 3 ? 'expo' : null; // thirds (plan §7 mobile)
  }

  _touchStart(e) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const t of e.changedTouches) {
      const zone = this._zone(t.clientX);
      if (zone === 'steer' && !this._steerTouch) {
        this._steerTouch = { id: t.identifier, x0: t.clientX };
        this._touchSteerTarget = 0;
      } else if (zone === 'expo' && !this._expoTouch) {
        this._expoTouch = { id: t.identifier, y0: t.clientY, w0: this.wTarget, t0: now, lastY: t.clientY, lastT: now, vy: 0, moved: 0, detentT: null };
      }
    }
  }

  _touchMove(e) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const t of e.changedTouches) {
      if (this._steerTouch && t.identifier === this._steerTouch.id) {
        // relative horizontal drag (plan §7): delta from touch-down maps to steer lock
        this._touchSteerTarget = clamp((t.clientX - this._steerTouch.x0) / STEER_DRAG_PX, -1, 1);
      } else if (this._expoTouch && t.identifier === this._expoTouch.id) {
        const x = this._expoTouch;
        const dtMs = now - x.lastT;
        if (dtMs > 0) {
          const inst = ((t.clientY - x.lastY) / dtMs) * 1000;
          x.vy = 0.6 * inst + 0.4 * x.vy; // light EMA: flick velocity robust to one jittery touch sample
        }
        x.moved = Math.max(x.moved, Math.abs(t.clientY - x.y0));
        x.lastY = t.clientY; x.lastT = now;
        // drag up = more exposure, drag down = less (down also primes the flick slam);
        // full zone travel = full 0..W_MAX sweep, with the 80 ms hold-resistance at the w=1 detent
        const zoneH = (typeof window !== 'undefined' && window.innerHeight) || 1;
        const raw = expoFromDrag(x.w0, x.y0 - t.clientY, zoneH);
        this.wTarget = detentGate(this.wTarget, raw, x, now);
      }
    }
  }

  _touchEnd(e) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const t of e.changedTouches) {
      if (this._steerTouch && t.identifier === this._steerTouch.id) {
        this._steerTouch = null;
        this._touchSteerTarget = null; // finger up -> smoothed return-to-center via poll()
      } else if (this._expoTouch && t.identifier === this._expoTouch.id) {
        const x = this._expoTouch;
        this._expoTouch = null;
        if (isFlickDown(x.vy)) this.wTarget = 0;                       // flick-down = full UNWEIGHT
        else if (isTapHold(now - x.t0, x.moved)) this.wTarget = 1;     // tap-hold = re-land w->1
      }
    }
  }

  /** Per-frame poll. Returns {steer, wTarget, jump}. Optional `now` (ms) for deterministic tests. */
  poll(now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    const dt = this._lastT === null ? 0 : clamp((now - this._lastT) / 1000, 0, MAX_POLL_DT);
    this._lastT = now;

    // keyboard steering target
    const left = this._keys.has('KeyA') || this._keys.has('ArrowLeft');
    const right = this._keys.has('KeyD') || this._keys.has('ArrowRight');
    const keyTarget = (right ? 1 : 0) - (left ? 1 : 0);
    // touch steer (when a steer finger is down) overrides keyboard
    const target = this._touchSteerTarget !== null ? this._touchSteerTarget : keyTarget;
    this.steer = steerStep(this.steer, target, dt);

    // keyboard exposure dial: W/S sweep the full 0..W_MAX range (leverage above 1)
    const up = this._keys.has('KeyW') || this._keys.has('ArrowUp');
    const down = this._keys.has('KeyS') || this._keys.has('ArrowDown');
    const dir = (up ? 1 : 0) - (down ? 1 : 0);
    if (dir !== 0) this.wTarget = dialStep(this.wTarget, dir, dt, CFG.W_MAX);

    return { steer: this.steer, wTarget: this.wTarget, jump: false };
  }
}
