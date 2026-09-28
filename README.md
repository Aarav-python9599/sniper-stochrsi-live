# CORE Agent - Live

Mechanical crypto paper-trading agent, run on a schedule by GitHub Actions (no personal device needed).

- `trade.mjs` - one trading cycle: real prices (CoinGecko, Kraken fallback), momentum entry, fixed TP/SL, updates `state.json`
- `.github/workflows/trade.yml` - runs every 15 min, commits `state.json`
- `index.html` - read-only dashboard (GitHub Pages)

Paper trading only. No real funds or exchange account.
