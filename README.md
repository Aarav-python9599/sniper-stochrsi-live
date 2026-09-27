# CORE Agent — Live

An autonomous crypto paper-trading agent that runs on a schedule via GitHub Actions, independent of any personal device being on.

- **`trade.mjs`** — the actual trading cycle: fetches real prices from CoinGecko, runs the survival mechanic (Vitality/hunger/Last Stand) and multi-position momentum strategy, updates `state.json`.
- **`.github/workflows/trade.yml`** — runs `trade.mjs` every 15 minutes and commits the updated state back to this repo. Trigger a run manually from the **Actions** tab if you don't want to wait.
- **`index.html`** — a read-only dashboard (served via GitHub Pages) that displays `state.json`. It does no trading of its own.
- **`state.json`** — the agent's current wallet, positions, trade log, and Vitality. This is the single source of truth; the dashboard just reads it.

**Data source:** CoinGecko only. Binance was deliberately excluded — it geo-blocks API requests from US IP ranges, which is where GitHub Actions runners are hosted, so it would fail on every scheduled run.

This is a paper-trading simulation. No real exchange account, no real funds, ever.
