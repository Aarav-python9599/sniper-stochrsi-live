// CORE agent — headless cycle, run on a schedule by GitHub Actions.
// Same mechanics as the browser version: real prices only, hunger/vitality survival,
// multi-position capacity scaled by Vitality, Last Stand fight-for-survival.
import { readFile, writeFile } from 'fs/promises';

const STATE_PATH = new URL('./state.json', import.meta.url);
const ASSET_META = { bitcoin: { sym: 'BTC' }, ethereum: { sym: 'ETH' }, solana: { sym: 'SOL' } };
const LAST_STAND_LIMIT = 6;

function defaultState() {
  return {
    balance: 10000, startBalance: 10000, power: 50,
    positions: {}, trades: [], wins: 0, losses: 0,
    fighting: false, fightCycles: 0, dead: false,
    priceHistory: { bitcoin: [], ethereum: [], solana: [] },
    strategy: { mode: 'momentum', buyTrigger: 0.15, takeProfit: 2.0, stopLoss: 1.0, sizeBase: 10, trailingStop: true },
    lastRun: null, cycles: 0
  };
}

async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) {
    return defaultState();
  }
}

async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function fetchMarket() {
  const ids = Object.keys(ASSET_META).join(',');
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
  if (!res.ok) throw new Error('coingecko HTTP ' + res.status);
  const data = await res.json();
  const out = {};
  Object.keys(ASSET_META).forEach(id => { if (data[id]) out[id] = Number(data[id].usd); });
  if (!Object.keys(out).length) throw new Error('empty coingecko response');
  return { prices: out, source: 'coingecko' };
}

function avgOf(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

function maxPositions(power) {
  if (power >= 85) return 4;
  if (power >= 60) return 3;
  if (power >= 30) return 2;
  return 1;
}

function checkEntry(mode, hist, price, strategy) {
  const prices = hist.map(h => h.p);
  const n = prices.length;
  if (mode === 'momentum') {
    if (n < 2) return false;
    return price > prices[n - 2] * (1 + strategy.buyTrigger / 100);
  }
  if (mode === 'conservative') {
    if (n < 2) return false;
    return price > prices[n - 2] * (1 + (strategy.buyTrigger * 1.8) / 100);
  }
  return false;
}

function checkExit(price, position, strategy) {
  const pnlPct = (price - position.entryPrice) / position.entryPrice * 100;
  if (pnlPct >= strategy.takeProfit) return true;
  if (strategy.trailingStop) {
    const fromPeak = (price - position.peak) / position.peak * 100;
    if (fromPeak <= -strategy.stopLoss) return true;
  } else if (pnlPct <= -strategy.stopLoss) return true;
  return false;
}

function adjustPower(state, delta) { state.power = Math.max(0, Math.min(100, state.power + delta)); }

function evaluateSurvival(state) {
  if (state.dead) return;
  if (state.power > 0) { if (state.fighting) { state.fighting = false; state.fightCycles = 0; } return; }
  if (!state.fighting) { state.fighting = true; state.fightCycles = 0; }
}

function pushTrade(state, asset, side, price, pnl) {
  const time = new Date().toISOString();
  state.trades.push({ time, asset, side, price, pnl: pnl || 0 });
  if (state.trades.length > 200) state.trades.shift();
  if (pnl !== undefined) { pnl >= 0 ? state.wins++ : state.losses++; }
}

function doBuy(state, asset, price) {
  let sizePct = (state.strategy.sizeBase / 100) + (state.power / 100) * 0.20;
  if (state.strategy.mode === 'conservative') sizePct *= 0.55;
  if (state.fighting) sizePct = 0.04;
  const spend = state.balance * Math.min(sizePct, 0.6);
  const qty = spend / price;
  state.positions[asset] = { entryPrice: price, qty, spend, peak: price };
  pushTrade(state, asset, 'BUY', price);
}

function doSell(state, asset, price) {
  const pos = state.positions[asset];
  const proceeds = pos.qty * price;
  const pnl = proceeds - pos.spend;
  state.balance += pnl;
  pushTrade(state, asset, 'SELL', price, pnl);
  adjustPower(state, (pnl / pos.spend) * 400);
  delete state.positions[asset];
}

async function runCycle() {
  const state = await loadState();
  let market;
  try {
    market = await fetchMarket();
  } catch (e) {
    console.log('FEED ERROR, skipping this cycle:', e.message);
    state.lastRun = new Date().toISOString();
    state.lastError = e.message;
    await saveState(state);
    return;
  }

  const now = Date.now();
  Object.entries(market.prices).forEach(([asset, price]) => {
    const hist = state.priceHistory[asset] || [];
    hist.push({ t: now, p: price });
    if (hist.length > 300) hist.shift();
    state.priceHistory[asset] = hist;
  });

  const decayFactor = 0.35 + (state.power / 100) * 0.15;
  adjustPower(state, -0.4 * decayFactor);
  evaluateSurvival(state);

  let traded = [];
  const cap = maxPositions(state.power);
  let openCount = Object.keys(state.positions).length;
  Object.keys(ASSET_META).forEach(asset => {
    const price = market.prices[asset];
    if (!price) return;
    const hist = state.priceHistory[asset];
    const pos = state.positions[asset];
    if (pos) {
      pos.peak = Math.max(pos.peak, price);
      if (checkExit(price, pos, state.strategy)) {
        doSell(state, asset, price); traded.push(`SELL ${asset}`); openCount--;
      }
    } else if (openCount < cap) {
      if (checkEntry(state.strategy.mode, hist, price, state.strategy)) {
        doBuy(state, asset, price); traded.push(`BUY ${asset}`); openCount++;
      }
    }
  });
  evaluateSurvival(state);

  if (state.fighting) {
    state.fightCycles++;
    if (state.fightCycles > LAST_STAND_LIMIT && Object.keys(state.positions).length === 0) {
      state.dead = true; state.fighting = false;
    }
  }

  state.cycles++;
  state.lastRun = new Date().toISOString();
  state.lastError = null;
  state.feedSource = market.source;
  await saveState(state);

  console.log(`Cycle ${state.cycles} @ ${state.lastRun} via ${market.source}`);
  console.log(`Vitality: ${Math.round(state.power)} | Balance: $${state.balance.toFixed(2)} | Open: ${Object.keys(state.positions).length}/${cap}`);
  console.log(traded.length ? `Trades: ${traded.join(', ')}` : 'No trades this cycle');
}

runCycle().catch(e => { console.error('FATAL:', e); process.exit(1); });
