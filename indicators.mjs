// RSI (Wilder) and Stochastic RSI (14,14,3,3 = TradingView defaults)
export function computeRSI(closes, len = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < len + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= len; i++) { const d = closes[i] - closes[i - 1]; d >= 0 ? g += d : l -= d; }
  let ag = g / len, al = l / len;
  out[len] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (len - 1) + (d > 0 ? d : 0)) / len;
    al = (al * (len - 1) + (d < 0 ? -d : 0)) / len;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function sma(arr, len) {
  return arr.map((_, i) => {
    if (i - len + 1 < 0) return null;
    const w = arr.slice(i - len + 1, i + 1);
    return w.some(v => v == null) ? null : w.reduce((a, b) => a + b, 0) / len;
  });
}
export function computeStochRSI(closes, rsiLen = 14, stochLen = 14, smoothK = 3, smoothD = 3) {
  const rsi = computeRSI(closes, rsiLen);
  const raw = rsi.map((v, i) => {
    if (v == null) return null;
    const w = rsi.slice(Math.max(0, i - stochLen + 1), i + 1).filter(x => x != null);
    if (w.length < stochLen) return null;
    const mn = Math.min(...w), mx = Math.max(...w);
    return mx === mn ? 50 : (v - mn) / (mx - mn) * 100;
  });
  const k = sma(raw, smoothK);
  return { k, d: sma(k, smoothD) };
}
