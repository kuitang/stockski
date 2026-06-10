// input.js — keyboard + touch input (plan §7, CONTRACTS §3).
// Exports: Input class -> poll(): {steer, wTarget, jump}; plus pure helpers for tests.
// No imports: all tunables are local input-feel constants, not world constants.

export const DIAL_RATE = 1.2;     // w units/sec via W/S keys: full 0->1 sweep in ~0.83 s — feels like a dial, not a switch
export const STEER_ATTACK = 7;    // 1/s toward target: full lock in ~0.14 s — responsive but visibly smoothed
export const STEER_RELEASE = 10;  // 1/s back to 0: releasing keys straightens faster than it locks (return-to-center)
export const STEER_DRAG_PX = 90;  // px of horizontal thumb drag for full steering lock — comfortable one-thumb arc
export const EXPO_DRAG_PX = 220;  // px of vertical drag for a full 0..1 exposure sweep — slider feel, hard to fat-finger
export const FLICK_VY = 1200;     // px/s downward at touch release => slam wTarget=0 (plan §7 flick-down threshold)
export const HOLD_MS = 350;       // press-and-hold this long on the exposure zone => re-land wTarget=1 (plan §7)
export const HOLD_MOVE_PX = 10;   // finger may wander at most this far and still count as a hold, not a drag
const MAX_POLL_DT = 0.1;          // s; cap poll dt so a background-tab gap can't spin the dial across its range

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Pure dial math: move w by dir (-1|0|+1) at DIAL_RATE for dt seconds, clamped to [0,1]. */
export function dialStep(w, dir, dt) {
  return clamp(w + dir * DIAL_RATE * dt, 0, 1);
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
      c === 'Space' || c === 'KeyE';
    if (!game) return;
    e.preventDefault(); // SPACE scrolls / arrows scroll the page otherwise
    if (down) {
      this._keys.add(c);
      if (c === 'Space') this.wTarget = 0; // slam: full unweight to cash (plan §2.3)
      if (c === 'KeyE') this.wTarget = 1;  // re-land: full exposure
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
        this._expoTouch = { id: t.identifier, y0: t.clientY, w0: this.wTarget, t0: now, lastY: t.clientY, lastT: now, vy: 0, moved: 0 };
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
        // drag up = more exposure, drag down = less (down also primes the flick slam)
        this.wTarget = clamp(x.w0 + (x.y0 - t.clientY) / EXPO_DRAG_PX, 0, 1);
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

    // keyboard exposure dial
    const up = this._keys.has('KeyW') || this._keys.has('ArrowUp');
    const down = this._keys.has('KeyS') || this._keys.has('ArrowDown');
    const dir = (up ? 1 : 0) - (down ? 1 : 0);
    if (dir !== 0) this.wTarget = dialStep(this.wTarget, dir, dt);

    return { steer: this.steer, wTarget: this.wTarget, jump: false };
  }
}
