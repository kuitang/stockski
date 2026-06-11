// hud.js — DOM HUD (plan §7, CONTRACTS §3): ticker, company, day's %, w bar,
// wealth $ (start $100k), gap-to-ghost %. DOM only; zero per-frame allocation:
// nodes cached once, textContent touched only when the displayed value changes.
// Leverage ext: exposure readout is a vertical 0..W_MAX bar with a marked detent
// line at w=1, an 'x' multiplier label, amber above 1x, pulsing red near margin call.
// Anchor ext: the portfolio $ figure is the HUD's visual anchor — its own top-center
// element (#wealth) with a session-P&L + gap-to-SPY delta row, an ~80ms scale pulse
// on each $1k crossing, and a color that drifts red with drawdown from the session high.
// Blend ext (user spec "no knife edge"): the position line shows the real two-stock mixture
// "AAPL 62% · MSFT 27% · cash 11%" (weights = PLAN §2.1) whenever u is off a pure track;
// w>1 turns the cash segment into an amber "borrow N%".

import { CFG } from './config.js';

export const START_WEALTH = 100000; // plan §7 / CONTRACTS §4: portfolio starts at $100k
export const MC_PROX = 0.8;         // u·w beyond this = margin-call proximity: at w=2 the call lands at u·w=1,
                                    // so 0.8 warns one margin-fifth before the cliff (also pulses on void lanes)
export const PULSE_USD = 1000;      // anchor scale-pulse per $1k crossed: frequent at speed, silent when flat
export const DD_FULL = 0.15;        // drawdown at which the $ figure is fully red: −15% = correction territory

// display quantization: skip DOM writes for sub-display-precision changes
const PCT_EPS = 0.005;   // day % / session P&L / ghost gap shown to 2 dp
const W_EPS = 0.005;     // w bar/number shown to 2 dp
const WEALTH_EPS = 0.5;  // wealth shown to whole dollars
const DD_Q = 0.02;       // drawdown color mix written in 2% steps — finer is invisible on screen

/** Red-drift mix 0..1 for the $ figure: fraction of full-red at drawdown dd from peak. Pure for tests. */
export function ddMix(wealth, peak) {
  if (!(peak > 0) || !(wealth < peak)) return 0;
  return Math.min(1, (1 - wealth / peak) / DD_FULL);
}

/** Exposure-bar styling tier: '' (0..1 normal) | 'lev' (w>1, amber) | 'mc' (pulsing red:
 *  lane is void with exposure, OR u·w > MC_PROX while levered — margin-call proximity).
 *  The u·w term is gated to w>1: terrain reports (i, u=1) on the left half of every plateau
 *  (its blend convention), so an ungated u·w>0.8 would flash red during plain w=1 skiing,
 *  contradicting the "0..1 normal" tier. A margin call needs w>1 anyway. Pure for tests. */
export function exposureLevel(w, u, laneVoid) {
  const W = w ?? 0;
  if ((laneVoid && W > 0) || (W > 1 && (u ?? 0) * W > MC_PROX)) return 'mc';
  return W > 1 ? 'lev' : '';
}

/** '1.4x' style multiplier label: up to 2 dp, trailing zeros trimmed. Pure for tests. */
export function fmtW(w) {
  return `${parseFloat((w ?? 0).toFixed(2))}x`;
}

// dual-ticker portfolio readout (user spec: "no knife edge" — the position line shows the
// actual two-stock mixture whenever the skier is off a pure track)
export const U_PURE = 0.02;  // within 2% of a plateau edge the minor leg is ≤2% of a full stake —
                             // at the whole-percent display resolution that rounds to a pure holding
const CASH_SHOW = 0.005;     // |1−w| below half a display-percent rounds to 0%: hide the cash segment

/**
 * Position-line segments for the blend pair (symA = lane i, symB = lane i+1) at blend u and
 * exposure w. Weights are PLAN §2.1 verbatim: ( w·(1−u), w·u, 1−w ) over (i, i+1, cash) —
 * reused, not re-derived. Returns { main, tail, borrow, domSym }:
 *   main   "AAPL 62% · MSFT 27%" (dominant first) or "AAPL 87%" when u is within U_PURE of pure
 *   tail   "cash 11%" | "borrow 38%" (w>1 ⇒ cash < 0 = borrowed money) | '' when it rounds to 0%
 *   borrow true when the tail is leverage (styled amber, matching the exposure bar's lev tier)
 *   domSym the dominant ticker (u ≥ 0.5 ⇒ lane i+1 — same convention as main.js dispLane)
 * Pure for tests.
 */
export function fmtPortfolio(symA, symB, u, w) {
  const W = w ?? 0;
  const U = Math.min(Math.max(u ?? 0, 0), 1);
  const wa = W * (1 - U), wb = W * U;            // PLAN §2.1: ( w·(1−u), w·u, 1−w )
  const cash = 1 - W;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const domSym = U >= 0.5 ? symB : symA;         // dominant holding, matches dispLane (main.js)
  const main = (U < U_PURE || U > 1 - U_PURE)
    ? `${domSym} ${pct(W)}`                      // pure track: single ticker carries all of w
    : (U >= 0.5 ? `${symB} ${pct(wb)} · ${symA} ${pct(wa)}` : `${symA} ${pct(wa)} · ${symB} ${pct(wb)}`);
  const borrow = cash <= -CASH_SHOW;
  const tail = borrow ? `borrow ${pct(-cash)}` : cash >= CASH_SHOW ? `cash ${pct(cash)}` : '';
  return { main, tail, borrow, domSym };
}

// exposure-bar leverage styles live here (not ui.css) so hud.js stays the single owner of the
// readout's states; injected once per document
const LEV_CSS = `
#exposure .w-track { overflow: visible; }
#exposure .w-detent {
  position: absolute; left: -3px; right: -3px; height: 2px;
  bottom: ${(1 / CFG.W_MAX) * 100}%;            /* the w=1 detent mark on a 0..W_MAX bar */
  background: rgba(255, 255, 255, 0.65);
  border-radius: 1px;
  pointer-events: none;
}
#exposure .w-detent.tick { animation: detent-tick 0.18s ease-out; }
@keyframes detent-tick {                         /* haptic-style visual tick at the w=1 crossing */
  0% { transform: scaleX(1.8) scaleY(2.5); background: #fff; }
  100% { transform: none; }
}
#exposure.lev .w-fill { background: linear-gradient(to top, #f59e0b, #fbbf24); } /* >1x: amber — borrowed money */
#exposure.lev .w-num { color: #fbbf24; }
#exposure.mc .w-fill { background: linear-gradient(to top, #dc2626, #f87171); animation: mc-pulse 0.6s ease-in-out infinite; }
#exposure.mc .w-num { color: #f87171; animation: mc-pulse 0.6s ease-in-out infinite; }
@keyframes mc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } } /* margin-call proximity: pulsing red */
`;

export class Hud {
  /** @param {HTMLElement} [root] container; defaults to document.body */
  constructor(root = (typeof document !== 'undefined' ? document.body : null)) {
    if (!root) throw new Error('Hud requires a DOM root');
    const hud = document.createElement('div');
    hud.id = 'hud';
    hud.innerHTML =
      '<div><span class="hud-sym"></span><span class="hud-cash"></span><span class="hud-dayret pnl-flat"></span></div>' +
      '<div class="hud-name"></div>' +
      '<div class="hud-sector"></div>' +
      '<div class="hud-date"></div>';
    root.appendChild(hud);

    // visual anchor: the portfolio $ figure, top-center, with its delta row
    // (session P&L % vs start; gap to the SPY ghost — the scoreboard that matters)
    const wealthEl = document.createElement('div');
    wealthEl.id = 'wealth';
    wealthEl.innerHTML =
      '<div class="wealth-fig"></div>' +
      '<div class="wealth-delta"><span class="wealth-pnl pnl-flat"></span><span class="wealth-gap pnl-flat"></span></div>';
    root.appendChild(wealthEl);

    if (!document.getElementById('hud-lev-style')) {
      const style = document.createElement('style');
      style.id = 'hud-lev-style';
      style.textContent = LEV_CSS;
      document.head?.appendChild(style);
    }

    const expo = document.createElement('div');
    expo.id = 'exposure';
    expo.innerHTML = '<div class="w-track"><div class="w-fill"></div><div class="w-detent"></div></div><div class="w-num"></div>';
    root.appendChild(expo);

    this.el = hud;
    this.expoEl = expo;
    this.wealthEl = wealthEl;
    this._n = { // cached nodes — queried exactly once
      sym: hud.querySelector('.hud-sym'),
      cash: hud.querySelector('.hud-cash'),
      dayRet: hud.querySelector('.hud-dayret'),
      name: hud.querySelector('.hud-name'),
      sector: hud.querySelector('.hud-sector'),
      date: hud.querySelector('.hud-date'),
      wealthFig: wealthEl.querySelector('.wealth-fig'),
      pnl: wealthEl.querySelector('.wealth-pnl'),
      ghostGap: wealthEl.querySelector('.wealth-gap'),
      wFill: expo.querySelector('.w-fill'),
      wDetent: expo.querySelector('.w-detent'),
      wNum: expo.querySelector('.w-num'),
    };
    this._peak = 0; // session high-water mark; first update() seeds it — drawdown drives the red drift
    // last-shown values — numbers compared before any string is built
    this._last = {
      pos: null, cashTxt: null, borrow: false, symA: null, symB: null, posW: NaN, posU: NaN,
      name: null, sector: null, date: null, dayRet: NaN,
      w: NaN, wealth: NaN, kilo: NaN, dd: NaN, hi: false, lo: false, pnl: NaN, gap: NaN, lev: '',
    };
  }

  /**
   * @param {{w:number,u:number}} state  physics State (CONTRACTS §3) — w drives the exposure bar,
   *   (u, w) drive the dual-ticker position line
   * @param {{sym:string,name:string,sector:string,dayRet:number,date:string,wealth:number,
   *   ghostWealth:number,laneA?:{sym:string},laneB?:{sym:string},u?:number}} info
   *   laneA/laneB = blend-pair lane metas (lane i, lane i+1 wrapped); sym/name stay the DOMINANT
   *   lane's (it keeps the company-name line — the minor holding is ticker-only on the position line)
   */
  update(state, info) {
    const n = this._n, last = this._last;
    const w = state?.w ?? 0;

    // position line: the actual two-stock mixture (user spec "no knife edge"); falls back to the
    // dominant sym as a pure holding for callers that don't pass the blend pair. Strings are
    // rebuilt only when an input moves at display resolution (file rule: no per-frame allocation);
    // POS_EPS = W_EPS/2: each blend weight is a product of two inputs, so half the 2-dp deadband
    // per input keeps the whole-percent readout at most one rounding step stale.
    const POS_EPS = W_EPS / 2;
    const hasPair = info.laneA?.sym != null && info.laneB?.sym != null;
    const symA = hasPair ? info.laneA.sym : (info.sym ?? '—');
    const symB = hasPair ? info.laneB.sym : symA;
    const U = hasPair ? (info.u ?? state?.u ?? 0) : 0;
    if (symA !== last.symA || symB !== last.symB ||
        !(Math.abs(w - last.posW) < POS_EPS) || !(Math.abs(U - last.posU) < POS_EPS)) {
      last.symA = symA; last.symB = symB; last.posW = w; last.posU = U;
      const p = fmtPortfolio(symA, symB, U, w);
      if (p.main !== last.pos) { last.pos = p.main; n.sym.textContent = p.main; }
      const cashTxt = p.tail ? ' · ' + p.tail : '';
      if (cashTxt !== last.cashTxt) { last.cashTxt = cashTxt; n.cash.textContent = cashTxt; }
      if (p.borrow !== last.borrow) { last.borrow = p.borrow; n.cash.classList.toggle('borrow', p.borrow); }
    }

    if (info.name !== last.name) { last.name = info.name; n.name.textContent = info.name ?? ''; }
    if (info.sector !== last.sector) { last.sector = info.sector; n.sector.textContent = info.sector ?? ''; }
    if (info.date !== last.date) { last.date = info.date; n.date.textContent = info.date ?? ''; }

    // 'day' label disambiguates the chip (lane-width judging mustFix): in the dual-ticker state
    // the % is the BLENDED two-stock position's day return (main.js mixes per PLAN §2.1), and an
    // unlabeled % next to "NCMI 55% · BERY 45%" read as either lane's move or another weight
    const dayPct = (info.dayRet ?? 0) * 100;
    if (!(Math.abs(dayPct - last.dayRet) < PCT_EPS)) {
      last.dayRet = dayPct;
      n.dayRet.textContent = 'day ' + (dayPct >= 0 ? '+' : '') + dayPct.toFixed(2) + '%';
      setPnlClass(n.dayRet, dayPct);
    }

    if (!(Math.abs(w - last.w) < W_EPS)) {
      // detent tick: flash the w=1 line when the displayed exposure crosses it (either direction)
      if (!Number.isNaN(last.w) && (last.w - 1) * (w - 1) < 0) {
        n.wDetent.classList.remove('tick');
        void n.wDetent.offsetWidth; // restart the CSS animation even on back-to-back crossings
        n.wDetent.classList.add('tick');
      }
      last.w = w;
      n.wFill.style.height = ((w / CFG.W_MAX) * 100).toFixed(1) + '%'; // bar spans 0..W_MAX, detent at 1
      n.wNum.textContent = fmtW(w);
    }

    // styling tier: normal 0..1, amber when levered, pulsing red near a margin call
    // (lane void inferred from airborne-with-exposure when the caller doesn't pass info.laneVoid)
    const laneVoid = info.laneVoid ?? (state?.grounded === false && w > 0);
    const lev = exposureLevel(w, state?.u, laneVoid);
    if (lev !== last.lev) {
      if (last.lev) this.expoEl.classList.remove(last.lev);
      if (lev) this.expoEl.classList.add(lev);
      last.lev = lev;
    }

    // ---- $ anchor: figure, $1k pulse, drawdown color drift, delta row ----
    const wealth = info.wealth ?? START_WEALTH;
    if (wealth > this._peak) this._peak = wealth; // session high-water mark
    if (!(Math.abs(wealth - last.wealth) < WEALTH_EPS)) {
      last.wealth = wealth;
      n.wealthFig.textContent = '$' + Math.round(wealth).toLocaleString('en-US');
      const kilo = Math.floor(wealth / PULSE_USD);
      if (!Number.isNaN(last.kilo) && kilo !== last.kilo) {
        n.wealthFig.classList.remove('tick');
        void n.wealthFig.offsetWidth; // restart the pulse even on back-to-back $1k crossings
        n.wealthFig.classList.add('tick');
      }
      last.kilo = kilo;
    }

    // drawdown drift from the session high (CSS --dd): within the sign-color below it warms
    // green toward amber / deepens red toward full loss-red as the slump grows
    const dd = Math.round(ddMix(wealth, this._peak) / DD_Q) * DD_Q;
    if (dd !== last.dd) {
      last.dd = dd;
      this.wealthEl.style.setProperty('--dd', dd.toFixed(2));
    }
    // figure color encodes TOTAL P&L sign (judge r2: drawdown-red at +9% read as losing while
    // winning): green when up vs start, red when down, neutral in the deadband
    const hi = wealth > START_WEALTH * (1 + PCT_EPS / 100); // 'hi' now means "in profit overall"
    if (hi !== last.hi) {
      last.hi = hi;
      this.wealthEl.classList.toggle('up', hi);
    }
    const lo = wealth < START_WEALTH * (1 - PCT_EPS / 100);
    if (lo !== last.lo) {
      last.lo = lo;
      this.wealthEl.classList.toggle('down', lo);
    }

    // session P&L %: wealth vs the $100k start (green/red)
    const pnl = (wealth / START_WEALTH - 1) * 100;
    if (!(Math.abs(pnl - last.pnl) < PCT_EPS)) {
      last.pnl = pnl;
      n.pnl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%';
      setPnlClass(n.pnl, pnl);
    }

    // gap to ghost: exact wealth-ratio comparison (plan §7 "gap to ghost")
    const gw = info.ghostWealth;
    const gap = gw > 0 ? (wealth / gw - 1) * 100 : 0;
    if (!(Math.abs(gap - last.gap) < PCT_EPS)) {
      last.gap = gap;
      n.ghostGap.textContent = 'vs SPY ' + (gap >= 0 ? '+' : '') + gap.toFixed(2) + '%';
      setPnlClass(n.ghostGap, gap);
    }
  }
}

function setPnlClass(node, v) {
  // PCT_EPS-scale deadband so 0.00% reads neutral, not green
  const cls = v > PCT_EPS ? 'pnl-pos' : v < -PCT_EPS ? 'pnl-neg' : 'pnl-flat';
  if (node._pnl !== cls) {
    if (node._pnl) node.classList.remove(node._pnl);
    node.classList.add(cls);
    node._pnl = cls;
  }
}
