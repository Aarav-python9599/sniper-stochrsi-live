// CORE agent — headless cycle, run on a schedule by GitHub Actions.
// Mechanical momentum trading on real prices. No survival mechanic, no "vitality" —
// pure rule-based entries/exits, fixed position sizing.
import { readFile, writeFile } from 'fs/promises';

const STATE_PATH = new URL('./state.json', import.meta.url);
const ASSETS = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL' };
const BUY_TRIGGER = 0.15;   // % uptick to enter
const TAKE_PROFIT = 2.0;    // % gain to exit
const STOP_LOSS = 1.0;      // % loss to exit
const POSITION_SIZE = 0.15; // fixed 15% of balance per trade
const MAX_POSITIONS = 3;    // one per asset, at most

// CoinGecko blocks requests with no/default User-Agent as an anti-bot measure —
// this is the fix for the 403s seen from GitHub Actions runners.
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; core-agent/1.0; +https://github.com/Aarav-python9599/core-agent-live)' };

function defaultState() {
  return {
    balance: 10000, startBalance: 10000,
    positions: {}, trades: [], wins: 0, losses: 0,
    priceHistory: { bitcoin: [], ethereum: [], solana: [] },
    lastRun: null, cycles: 0, lastError: null, feedSource: null
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

async function fetchFromCoinGecko() {
  const ids = Object.keys(ASSETS).join(',');
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { headers: HEADERS });
  if (!res.ok) throw new Error('coingecko HTTP ' + res.status);
  const data = await res.json();
  const out = {};
  Object.keys(ASSETS).forEach(id => { if (data[id]) out[id] = Number(data[id].usd); });
  if (!Object.keys(out).length) throw new Error('empty coingecko response');
  return out;
}

// Kraken fallback — different provider entirely, in case CoinGecko blocks this runner's IP range outright
const KRAKEN_PAIRS = { bitcoin: 'XBTUSD', ethereum: 'ETHUSD', solana: 'SOLUSD' };
async function fetchFromKraken() {
  const pairs = Object.values(KRAKEN_PAIRS).join(',');
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`, { headers: HEADERS });
  if (!res.ok) throw new Error('kraken HTTP ' + res.status);
  const data = await res.json();
  if (data.error && data.error.length) throw new Error('kraken: ' + data.error.join(', '));
  const out = {};
  Object.entries(KRAKEN_PAIRS).forEach(([id, pair]) => {
    // kraken echoes back its own internal pair key, which can differ slightly from what we sent
    const key = Object.keys(data.result || {}).find(k => k.includes(pair.slice(0, 3)) || k === pair);
    if (key && data.result[key]) out[id] = Number(data.result[key].c[0]); // c[0] = last trade price
  });
  if (!Object.keys(out).length) throw new Error('empty/unmatched kraken response');
  return out;
}

async function fetchMarket() {
  try { return { prices: await fetchFromCoinGecko(), source: 'coingecko' }; }
  catch (e1) {
    try { return { prices: await fetchFromKraken(), source: 'kraken (fallback)' }; }
    catch (e2) { throw new Error(`coingecko failed (${e1.message}) -> kraken failed (${e2.message})`); }
  }
}

function pushTrade(state, asset, side, price, pnl) {
  const time = new Date().toISOString();
  state.trades.push({ time, asset, side, price, pnl: pnl || 0 });
  if (state.trades.length > 200) state.trades.shift();
  if (pnl !== undefined) { pnl >= 0 ? state.wins++ : state.losses++; }
}

function doBuy(state, asset, price) {
  const spend = state.balance * POSITION_SIZE;
  const qty = spend / price;
  state.positions[asset] = { entryPrice: price, qty, spend };
  pushTrade(state, asset, 'BUY', price);
}

function doSell(state, asset, price) {
  const pos = state.positions[asset];
  const proceeds = pos.qty * price;
  const pnl = proceeds - pos.spend;
  state.balance += pnl;
  pushTrade(state, asset, 'SELL', price, pnl);
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

  let traded = [];
  let openCount = Object.keys(state.positions).length;
  Object.keys(ASSETS).forEach(asset => {
    const price = market.prices[asset];
    if (!price) return;
    const hist = state.priceHistory[asset];
    const pos = state.positions[asset];
    if (pos) {
      const pnlPct = (price - pos.entryPrice) / pos.entryPrice * 100;
      if (pnlPct >= TAKE_PROFIT || pnlPct <= -STOP_LOSS) {
        doSell(state, asset, price); traded.push(`SELL ${asset}`); openCount--;
      }
    } else if (openCount < MAX_POSITIONS && hist.length >= 2) {
      const prevPrice = hist[hist.length - 2].p;
      if (price > prevPrice * (1 + BUY_TRIGGER / 100)) {
        doBuy(state, asset, price); traded.push(`BUY ${asset}`); openCount++;
      }
    }
  });

  state.cycles++;
  state.lastRun = new Date().toISOString();
  state.lastError = null;
  state.feedSource = market.source;
  await saveState(state);

  console.log(`Cycle ${state.cycles} @ ${state.lastRun} via ${market.source}`);
  console.log(`Balance: $${state.balance.toFixed(2)} | Open: ${Object.keys(state.positions).length}/${MAX_POSITIONS}`);
  console.log(traded.length ? `Trades: ${traded.join(', ')}` : 'No trades this cycle');
}

runCycle().catch(e => { console.error('FATAL:', e); process.exit(1); });
