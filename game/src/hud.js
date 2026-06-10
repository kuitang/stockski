// hud.js — DOM HUD (plan §7, CONTRACTS §3): ticker, company, day's %, w bar,
// wealth $ (start $100k), gap-to-ghost %. DOM only; zero per-frame allocation:
// nodes cached once, textContent touched only when the displayed value changes.

export const START_WEALTH = 100000; // plan §7 / CONTRACTS §4: portfolio starts at $100k

// display quantization: skip DOM writes for sub-display-precision changes
const PCT_EPS = 0.005;   // day % and ghost gap shown to 2 dp
const W_EPS = 0.005;     // w bar/number shown to 2 dp
const WEALTH_EPS = 0.5;  // wealth shown to whole dollars

export class Hud {
  /** @param {HTMLElement} [root] container; defaults to document.body */
  constructor(root = (typeof document !== 'undefined' ? document.body : null)) {
    if (!root) throw new Error('Hud requires a DOM root');
    const hud = document.createElement('div');
    hud.id = 'hud';
    hud.innerHTML =
      '<div><span class="hud-sym"></span><span class="hud-dayret pnl-flat"></span></div>' +
      '<div class="hud-name"></div>' +
      '<div class="hud-sector"></div>' +
      '<div class="hud-date"></div>' +
      '<div class="hud-wealth"></div>' +
      '<div class="hud-ghostgap pnl-flat"></div>';
    root.appendChild(hud);

    const expo = document.createElement('div');
    expo.id = 'exposure';
    expo.innerHTML = '<div class="w-track"><div class="w-fill"></div></div><div class="w-num"></div>';
    root.appendChild(expo);

    this.el = hud;
    this.expoEl = expo;
    this._n = { // cached nodes — queried exactly once
      sym: hud.querySelector('.hud-sym'),
      dayRet: hud.querySelector('.hud-dayret'),
      name: hud.querySelector('.hud-name'),
      sector: hud.querySelector('.hud-sector'),
      date: hud.querySelector('.hud-date'),
      wealth: hud.querySelector('.hud-wealth'),
      ghostGap: hud.querySelector('.hud-ghostgap'),
      wFill: expo.querySelector('.w-fill'),
      wNum: expo.querySelector('.w-num'),
    };
    // last-shown values — numbers compared before any string is built
    this._last = { sym: null, name: null, sector: null, date: null, dayRet: NaN, w: NaN, wealth: NaN, gap: NaN };
  }

  /**
   * @param {{w:number}} state  physics State (CONTRACTS §3) — w drives the exposure bar
   * @param {{sym:string,name:string,sector:string,dayRet:number,date:string,wealth:number,ghostWealth:number}} info
   */
  update(state, info) {
    const n = this._n, last = this._last;

    if (info.sym !== last.sym) { last.sym = info.sym; n.sym.textContent = info.sym ?? ''; }
    if (info.name !== last.name) { last.name = info.name; n.name.textContent = info.name ?? ''; }
    if (info.sector !== last.sector) { last.sector = info.sector; n.sector.textContent = info.sector ?? ''; }
    if (info.date !== last.date) { last.date = info.date; n.date.textContent = info.date ?? ''; }

    const dayPct = (info.dayRet ?? 0) * 100;
    if (!(Math.abs(dayPct - last.dayRet) < PCT_EPS)) {
      last.dayRet = dayPct;
      n.dayRet.textContent = (dayPct >= 0 ? '+' : '') + dayPct.toFixed(2) + '%';
      setPnlClass(n.dayRet, dayPct);
    }

    const w = state?.w ?? 0;
    if (!(Math.abs(w - last.w) < W_EPS)) {
      last.w = w;
      n.wFill.style.height = (w * 100).toFixed(1) + '%';
      n.wNum.textContent = 'w ' + w.toFixed(2);
    }

    const wealth = info.wealth ?? START_WEALTH;
    if (!(Math.abs(wealth - last.wealth) < WEALTH_EPS)) {
      last.wealth = wealth;
      n.wealth.textContent = '$' + Math.round(wealth).toLocaleString('en-US');
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
