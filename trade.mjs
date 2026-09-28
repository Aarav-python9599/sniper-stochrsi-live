// SNIPER - Weekly Stochastic RSI macro DCA system (paper trading), BTC.
// Buy zone: %K and %D both < 15  -> DCA in; bullish K/D cross -> deploy the rest.
// Sell zone: %K and %D both > 80 -> DCA out; bearish K/D cross -> exit fully.
import { readFile, writeFile } from 'fs/promises';
import { computeStochRSI } from './indicators.mjs';

const STATE_PATH = new URL('./state.json', import.meta.url);
const BUY_ZONE = 15, SELL_ZONE = 80, TRANCHE = 0.20;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; sniper-agent/1.0)' };

const defaultState = () => ({
  cash: 10000, startBalance: 10000, qty: 0, costBasis: 0, phase: 'neutral',
  lastTrancheDay: null, trades: [], series: [], price: null,
  lastRun: null, cycles: 0, lastError: null, feedSource: null
});

async function loadState() {
  try { return { ...defaultState(), ...JSON.parse(await readFile(STATE_PATH, 'utf8')) }; }
  catch { return defaultState(); }
}
const saveState = s => writeFile(STATE_PATH, JSON.stringify(s, null, 2));

// Primary: Kraken weekly candles. Last candle is the still-forming week.
async function fromKraken() {
  const res = await fetch('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=10080', { headers: HEADERS });
  if (!res.ok) throw new Error('kraken HTTP ' + res.status);
  const j = await res.json();
  if (j.error && j.error.length) throw new Error('kraken: ' + j.error.join(', '));
  const key = Object.keys(j.result).find(k => k !== 'last');
  const rows = j.result[key];
  if (!rows || rows.length < 40) throw new Error('kraken: too few candles');
  return rows.map(r => ({ t: r[0] * 1000, c: Number(r[4]) }));
}

// Fallback: CoinGecko daily prices bucketed into 7-day weeks (closes only, all RSI needs).
async function fromCoinGecko() {
  const url = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=400&interval=daily';
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error('coingecko HTTP ' + res.status);
  const j = await res.json();
  const WEEK = 7 * 86400000;
  const buckets = new Map();
  (j.prices || []).forEach(([ts, p]) => buckets.set(Math.floor(ts / WEEK), { t: Math.floor(ts / WEEK) * WEEK, c: p }));
  const out = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  if (out.length < 40) throw new Error('coingecko: too few weekly buckets');
  return out;
}

async function getWeekly() {
  try { return { candles: await fromKraken(), source: 'kraken' }; }
  catch (e1) {
    try { return { candles: await fromCoinGecko(), source: 'coingecko (fallback)' }; }
    catch (e2) { throw new Error(`kraken failed (${e1.message}) -> coingecko failed (${e2.message})`); }
  }
}

function trade(state, side, price, usd, reason) {
  state.trades.push({ time: new Date().toISOString(), side, price, usd, reason });
  if (state.trades.length > 200) state.trades.shift();
}

async function run() {
  const state = await loadState();
  let data;
  try { data = await getWeekly(); }
  catch (e) {
    console.log('FEED ERROR:', e.message);
    state.lastRun = new Date().toISOString(); state.lastError = e.message;
    await saveState(state); return;
  }

  const closes = data.candles.map(c => c.c);
  const { k, d } = computeStochRSI(closes);
  const n = closes.length - 1;
  const K = k[n], D = d[n], pK = k[n - 1], pD = d[n - 1];
  if ([K, D, pK, pD].some(v => v == null)) {
    state.lastError = 'not enough history to compute StochRSI'; await saveState(state); return;
  }
  const price = closes[n];
  const today = new Date().toISOString().slice(0, 10);
  const inBuy = K < BUY_ZONE && D < BUY_ZONE;
  const inSell = K > SELL_ZONE && D > SELL_ZONE;
  const bullCross = pK <= pD && K > D;
  const bearCross = pK >= pD && K < D;
  const canTranche = state.lastTrancheDay !== today; // at most one DCA slice per day

  if (inBuy && state.cash > 1 && canTranche) {
    const usd = state.cash * TRANCHE;
    state.qty += usd / price; state.costBasis += usd; state.cash -= usd;
    trade(state, 'BUY', price, usd, 'DCA - oversold zone'); state.phase = 'accumulating'; state.lastTrancheDay = today;
  } else if (state.phase === 'accumulating' && bullCross && state.cash > 1) {
    const usd = state.cash;
    state.qty += usd / price; state.costBasis += usd; state.cash = 0;
    trade(state, 'BUY', price, usd, 'Bullish cross - full deployment'); state.phase = 'neutral';
  }

  if (inSell && state.qty > 0 && canTranche) {
    const q = state.qty * TRANCHE, usd = q * price;
    state.costBasis *= (1 - TRANCHE); state.qty -= q; state.cash += usd;
    trade(state, 'SELL', price, usd, 'DCA out - overbought zone'); state.phase = 'distributing'; state.lastTrancheDay = today;
  } else if (state.phase === 'distributing' && bearCross && state.qty > 0) {
    const usd = state.qty * price;
    state.cash += usd; state.qty = 0; state.costBasis = 0;
    trade(state, 'SELL', price, usd, 'Bearish cross - full exit'); state.phase = 'neutral';
  }

  state.price = price;
  state.series = data.candles.slice(-52).map((c, i, arr) => {
    const idx = data.candles.length - arr.length + i;
    return { t: c.t, c: c.c, k: k[idx], d: d[idx] };
  });
  state.cycles++; state.lastRun = new Date().toISOString(); state.lastError = null; state.feedSource = data.source;
  await saveState(state);
  console.log(`Cycle ${state.cycles} via ${data.source} | price ${price.toFixed(0)} | K ${K.toFixed(1)} D ${D.toFixed(1)} | phase ${state.phase} | cash ${state.cash.toFixed(2)} qty ${state.qty.toFixed(6)}`);
}
run().catch(e => { console.error('FATAL', e); process.exit(1); });
