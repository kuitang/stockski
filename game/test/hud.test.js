// hud.test.js — pure-helper tests for the dual-ticker portfolio readout (user spec
// "no knife edge"): fmtPortfolio renders PLAN §2.1 weights ( w·(1−u), w·u, 1−w ) as the
// HUD position line, incl. the w>1 borrow (negative cash) case.

import { describe, it, expect } from 'vitest';
import { fmtPortfolio, U_PURE } from '../src/hud.js';

describe('fmtPortfolio (PLAN §2.1 weights -> position line)', () => {
  it('mid-margin shows both tickers + cash, dominant first', () => {
    // w=0.89, u≈0.303: weights = (0.62, 0.27, 0.11) — the spec example line
    const p = fmtPortfolio('AAPL', 'MSFT', 0.27 / 0.89, 0.89);
    expect(p.main).toBe('AAPL 62% · MSFT 27%');
    expect(p.tail).toBe('cash 11%');
    expect(p.borrow).toBe(false);
    expect(p.domSym).toBe('AAPL');
  });

  it('puts the dominant ticker first when u > 0.5 (matches dispLane convention)', () => {
    const p = fmtPortfolio('AAPL', 'MSFT', 0.7, 1);
    expect(p.main).toBe('MSFT 70% · AAPL 30%');
    expect(p.tail).toBe(''); // 1−w = 0 rounds to 0%: no cash segment
    expect(p.domSym).toBe('MSFT');
  });

  it('within U_PURE of a plateau edge collapses to a single ticker', () => {
    expect(fmtPortfolio('AAPL', 'MSFT', 0, 1).main).toBe('AAPL 100%');
    expect(fmtPortfolio('AAPL', 'MSFT', U_PURE / 2, 0.87)).toMatchObject({
      main: 'AAPL 87%', tail: 'cash 13%', borrow: false, domSym: 'AAPL',
    });
    expect(fmtPortfolio('AAPL', 'MSFT', 1 - U_PURE / 2, 1)).toMatchObject({
      main: 'MSFT 100%', domSym: 'MSFT',
    });
  });

  it('shows both tickers exactly at the U_PURE boundary (u in [0.02, 0.98] inclusive)', () => {
    expect(fmtPortfolio('AAPL', 'MSFT', U_PURE, 1).main).toBe('AAPL 98% · MSFT 2%');
    expect(fmtPortfolio('AAPL', 'MSFT', 1 - U_PURE, 1).main).toBe('MSFT 98% · AAPL 2%');
  });

  it('w=2 (max leverage): cash is negative -> amber borrow segment', () => {
    const p = fmtPortfolio('AAPL', 'MSFT', 0.5, 2);
    // w·(1−u) = w·u = 1 at the seam; the 50/50 tie breaks toward lane i+1 (dispLane's >= rule)
    expect(p.main).toBe('MSFT 100% · AAPL 100%');
    expect(p.tail).toBe('borrow 100%');           // 1−w = −1
    expect(p.borrow).toBe(true);
  });

  it('w=1.38 on a pure track: "AAPL 138% · borrow 38%" (the spec example)', () => {
    const p = fmtPortfolio('AAPL', 'MSFT', 0, 1.38);
    expect(p.main).toBe('AAPL 138%');
    expect(p.tail).toBe('borrow 38%');
    expect(p.borrow).toBe(true);
  });

  it('w=0 (ghost/cash): weights are zero, cash 100%', () => {
    const p = fmtPortfolio('AAPL', 'MSFT', 0.4, 0);
    expect(p.main).toBe('AAPL 0% · MSFT 0%');
    expect(p.tail).toBe('cash 100%');
    expect(p.borrow).toBe(false);
  });

  it('rounded segments always come from the exact §2.1 weights (sum drift only from rounding)', () => {
    // sweep: parse the rendered percents back and compare to the formula within rounding (0.5%)
    for (let u = 0.05; u < 1; u += 0.13) {
      for (const w of [0.3, 0.75, 1, 1.6, 2]) {
        const p = fmtPortfolio('A', 'B', u, w);
        const nums = (p.main + (p.tail ? ' · ' + p.tail : '')).match(/-?\d+(?=%)/g).map(Number);
        const want = [w * (1 - u), w * u, 1 - w].map((x) => Math.abs(x) * 100);
        const got = u >= 0.5 ? [nums[1], nums[0], nums[2] ?? 0] : [nums[0], nums[1], nums[2] ?? 0];
        for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k])).toBeLessThanOrEqual(0.5);
      }
    }
  });
});
