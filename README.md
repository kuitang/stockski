# Stock Universe Skier

A real-time 3D skiing game over the living edge of the US stock market. Time runs along the
mountain, ~3,000 point-in-time most-traded stocks run across it, height is cumulative log return.
You are pinned to "now": fresh terrain falls as snow at the frontier, the future is whiteout.
Your position **is** a real, long-only (optionally 2×-levered), self-financing portfolio at every
instant — every mechanic maps to an investable action. Bankruptcies are crevasses. Acquisitions
are kickers. Cash is flight.

Design: [PLAN.md](PLAN.md) · interfaces: [CONTRACTS.md](CONTRACTS.md) · data audit: [analysis/phase0_report.md](analysis/phase0_report.md)

## Controls

A/D steer · W/S exposure dial (0 → 2× leverage, detent at 1×) · Space = sell to cash (flight) ·
E = fully invested · R = 2× levered. Touch: left thumb steers, right thumb is the exposure dial.

## Develop

```
cd game && npm install && npm run dev     # http://localhost:5173/?era=synthetic
npx vitest run                            # physics/wealth-identity/decoder tests
```

The data pipeline (`pipeline/`, Python) builds era tiles from EOD price data; see CONTRACTS §2/§5.
`data/` and full-era tiles are not in the repo.

## Data & licensing

Code is **AGPL-3.0-or-later** (see [LICENSE](LICENSE)). Market data underlying the published demo
tiles is sourced from [EODHD](https://eodhd.com); tiles are quantized, transformed, and obfuscated
(CONTRACTS §2) and are not a market-data redistribution. The risk-free series derives from FRED DTB3.
This is a game, not investment advice; simulation assumptions are disclosed in PLAN §2.4.
