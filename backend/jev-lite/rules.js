'use strict';
/**
 * jev-lite trading rules.
 *
 * Every rule: (candles, params) => Int8Array of target positions, one per
 * candle, 1 = long, 0 = flat. Position at index i must use only
 * candles[0..i] (no lookahead). The backtester executes at the NEXT bar's open.
 *
 * candles: [{ timestamp, open, high, low, close, volume }]
 */

function sma(values, n) {
  const out = new Float64Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function rollingStd(values, n, means) {
  const out = new Float64Array(values.length).fill(NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];
    if (i >= n) {
      sum -= values[i - n];
      sumSq -= values[i - n] * values[i - n];
    }
    if (i >= n - 1) {
      const mean = means ? means[i] : sum / n;
      const v = Math.max(0, sumSq / n - mean * mean);
      out[i] = Math.sqrt(v);
    }
  }
  return out;
}

// max of values[i-n+1..i], O(n) via monotonic deque
function rollingMax(values, n) {
  const out = new Float64Array(values.length).fill(NaN);
  const dq = [];
  for (let i = 0; i < values.length; i++) {
    while (dq.length && values[dq[dq.length - 1]] <= values[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = values[dq[0]];
  }
  return out;
}

function rollingMin(values, n) {
  const out = new Float64Array(values.length).fill(NaN);
  const dq = [];
  for (let i = 0; i < values.length; i++) {
    while (dq.length && values[dq[dq.length - 1]] >= values[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = values[dq[0]];
  }
  return out;
}

const closes = (candles) => candles.map((c) => c.close);

/** Trend following: long while fast SMA > slow SMA. */
function momentum(candles, params = {}) {
  const fast = params.fast || 20;
  const slow = params.slow || 50;
  if (fast >= slow) throw new Error('momentum: fast must be < slow');
  const c = closes(candles);
  const f = sma(c, fast);
  const s = sma(c, slow);
  const pos = new Int8Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    pos[i] = !Number.isNaN(s[i]) && f[i] > s[i] ? 1 : 0;
  }
  return pos;
}

/** Bollinger-style: enter long when z-score < -entryZ, exit when z-score > exitZ. */
function meanReversion(candles, params = {}) {
  const period = params.period || 20;
  const entryZ = params.entryZ ?? 2;
  const exitZ = params.exitZ ?? 0;
  const c = closes(candles);
  const m = sma(c, period);
  const sd = rollingStd(c, period, m);
  const pos = new Int8Array(candles.length);
  let inPos = 0;
  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(m[i]) || sd[i] === 0) {
      pos[i] = inPos;
      continue;
    }
    const z = (c[i] - m[i]) / sd[i];
    if (!inPos && z < -entryZ) inPos = 1;
    else if (inPos && z > exitZ) inPos = 0;
    pos[i] = inPos;
  }
  return pos;
}

/** Donchian breakout: long when close > prior N-bar high, exit when close < prior M-bar low. */
function breakout(candles, params = {}) {
  const entry = params.entry || 55;
  const exit = params.exit || 20;
  const highs = candles.map((x) => x.high);
  const lows = candles.map((x) => x.low);
  const hh = rollingMax(highs, entry);
  const ll = rollingMin(lows, exit);
  const pos = new Int8Array(candles.length);
  let inPos = 0;
  for (let i = 1; i < candles.length; i++) {
    // channel built from bars up to i-1 so the breakout bar itself is excluded
    const prevHigh = hh[i - 1];
    const prevLow = ll[i - 1];
    if (!inPos && !Number.isNaN(prevHigh) && candles[i].close > prevHigh) inPos = 1;
    else if (inPos && !Number.isNaN(prevLow) && candles[i].close < prevLow) inPos = 0;
    pos[i] = inPos;
  }
  return pos;
}

/** Always long. Benchmark. */
function buyAndHold(candles) {
  return new Int8Array(candles.length).fill(1);
}

const RULES = { momentum, meanReversion, breakout, buyAndHold };

module.exports = {
  RULES,
  momentum,
  meanReversion,
  breakout,
  buyAndHold,
  indicators: { sma, rollingStd, rollingMax, rollingMin },
};
