// startbox.js — first-run explainer + always-available controls reference.
// The world clock is paused while the box is up; any key/click/tap starts the run.
// A low-contrast one-line hint stays docked bottom-center afterwards ("out of the face");
// ? or H reopens the box. Skipped under automation (navigator.webdriver) so the
// Playwright contract (CONTRACTS §4: __ski.ready ⇒ world running) is unchanged.

const BOX_Z = 60; // above the death overlay (50): the explainer must win at first paint

function el(tag, css, html) {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (html != null) e.innerHTML = html;
  return e;
}

const KEY_ROWS = [
  ['A / D', 'steer — rebalance between adjacent stocks'],
  ['W / S', 'exposure dial 0–2× — your market weighting'],
  ['Space', 'sell everything to cash — fly free (earns T-bill rate)'],
  ['E', 'land fully invested (1×)'],
  ['R', 'risk-on: 2× leverage (borrowed at T-bill + spread)'],
  ['Esc', 'pause'],
  ['?', 'show this card'],
];
const TOUCH_ROWS = [
  ['left thumb', 'drag sideways to steer'],
  ['right thumb', 'drag up/down: exposure dial 0–2×'],
  ['flick down', 'sell all to cash (fly)'],
  ['tap-hold', 'land fully invested (1×)'],
];

export function initStartBox({ era, isTouch, pause, resume, skip }) {
  if (skip) return;

  const rows = (isTouch ? TOUCH_ROWS : KEY_ROWS)
    .map(([k, v]) => `<tr><td style="padding:2px 14px 2px 0;white-space:nowrap;color:#1d3557;font-weight:700">${k}</td><td style="padding:2px 0;color:#33415c">${v}</td></tr>`)
    .join('');

  const box = el('div',
    `position:fixed;inset:0;display:grid;place-items:center;z-index:${BOX_Z};` +
    'background:rgba(246,248,252,0.55);backdrop-filter:blur(3px);font:15px/1.45 system-ui,sans-serif;');
  box.appendChild(el('div',
    'max-width:520px;margin:16px;padding:22px 26px;border-radius:14px;background:rgba(255,255,255,0.94);' +
    'box-shadow:0 12px 40px rgba(29,53,87,0.25);color:#22303c;',
    `<div style="font:800 22px system-ui;letter-spacing:0.5px;color:#1d3557">STOCK UNIVERSE SKIER</div>
     <p style="margin:10px 0 6px">You are skiing the <b>real US stock market</b> (era: ${era}). Every lane is a
     stock; height is its cumulative return; fresh snow falls at "today" and the future is whiteout.
     Your position <b>is</b> a real portfolio — steering rebalances, the dial sets exposure,
     and your wealth is exactly what that portfolio would have earned. Beat the hovering
     <b>SPY ghost</b>. Bankrupt stocks are crevasses; acquisitions are kickers; at 2× leverage,
     margin calls are fatal.</p>
     <table style="border-collapse:collapse;margin:8px 0 4px">${rows}</table>
     <div style="margin-top:12px;text-align:center;color:#5a6b7b;font-weight:600">
       ${isTouch ? 'tap anywhere to ski' : 'press any key or click to ski'}</div>`));

  const hint = el('div',
    'position:fixed;left:50%;transform:translateX(-50%);bottom:max(8px, env(safe-area-inset-bottom));' +
    'z-index:30;font:12px system-ui,sans-serif;color:rgba(34,48,60,0.45);pointer-events:none;' +
    'white-space:nowrap;text-shadow:0 1px 2px rgba(255,255,255,0.6);',
    isTouch
      ? 'left thumb steer · right thumb exposure 0–2×'
      : 'A/D steer · W/S exposure 0–2× · Space cash · E 1× · R 2× · Esc pause · ? help');

  let open = false;
  function show() {
    if (open) return;
    open = true;
    pause();
    document.body.appendChild(box);
  }
  function dismiss() {
    if (!open) return;
    open = false;
    box.remove();
    resume();
  }

  // dismiss on any key/click/tap; capture phase so the opening keystroke never reaches the game
  addEventListener('keydown', (e) => {
    if (!open) {
      if (e.key === '?' || e.code === 'KeyH') show();
      return;
    }
    e.stopPropagation();
    if (e.code !== 'Escape') dismiss(); // Esc keeps native pause semantics
  }, true);
  box.addEventListener('pointerdown', (e) => { e.stopPropagation(); dismiss(); }, true);

  document.body.appendChild(hint);
  show();
}
