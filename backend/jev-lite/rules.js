'use strict';
/**
 * jev-lite trading rules.
 *
 * Every rule: (candles, params) => array-like of target positions, one per
 * candle. 1 = 100% long, -1 = 100% short, 0 = flat, fractions allowed.
 * Position at index i must use only candles[0..i] (no lookahead). The
 * backtester executes at the NEXT bar's open.
 *
 * The engine injects params.barSeconds, params.barsPerYear, params.maxLeverage.
 * "…Days" params are converted to bars for the timeframe in use, so the same
 * rule config works on 1h, 4h or 1d candles.
 *
 * candles: [{ timestamp, open, high, low, close, volume }]
 */

// ---------------------------------------------------------------- indicators

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

function ema(values, n) {
  const out = new Float64Array(values.length).fill(NaN);
  const k = 2 / (n + 1);
  let e = NaN;
  for (let i = 0; i < values.length; i++) {
    e = Number.isNaN(e) ? values[i] : values[i] * k + e * (1 - k);
    if (i >= n - 1) out[i] = e;
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

/** Wilder RSI on closes. */
function rsi(values, n) {
  const out = new Float64Array(values.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    if (i <= n) {
      avgGain += gain / n;
      avgLoss += loss / n;
      if (i < n) continue;
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
    }
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** Wilder ATR. */
function atr(candles, n) {
  const out = new Float64Array(candles.length).fill(NaN);
  let a = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    if (i <= n) {
      a += tr / n;
      if (i < n) continue;
    } else {
      a = (a * (n - 1) + tr) / n;
    }
    out[i] = a;
  }
  return out;
}

/** Annualised realised volatility of close-to-close returns over n bars. */
function realizedVol(closes, n, barsPerYear) {
  const rets = new Float64Array(closes.length);
  for (let i = 1; i < closes.length; i++) rets[i] = closes[i] / closes[i - 1] - 1;
  const sd = rollingStd(rets, n);
  const out = new Float64Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) out[i] = sd[i] * Math.sqrt(barsPerYear);
  return out;
}

// ---------------------------------------------------------------- helpers

const closes = (candles) => candles.map((c) => c.close);

function barSecondsOf(candles, params) {
  return params.barSeconds || candles[1].timestamp - candles[0].timestamp;
}

function daysToBars(days, candles, params) {
  return Math.max(1, Math.round((days * 86400) / barSecondsOf(candles, params)));
}

function barsPerYearOf(candles, params) {
  return params.barsPerYear || (365 * 86400) / barSecondsOf(candles, params);
}

// ---------------------------------------------------------------- original bar-based rules

/** Trend following: long while fast SMA > slow SMA (periods in bars). */
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

/** Donchian breakout (periods in bars): long when close > prior N-bar high, exit below prior M-bar low. */
function breakout(candles, params = {}) {
  const entry = params.entry || 55;
  const exit = params.exit || 20;
  return donchianCore(candles, entry, exit, false);
}

/** Always long. Benchmark. */
function buyAndHold(candles) {
  return new Int8Array(candles.length).fill(1);
}

// ---------------------------------------------------------------- day-parameterised rules

/**
 * Price vs SMA trend filter. Long when close > SMA*(1+band), flat (or short)
 * when close < SMA*(1-band). Hysteresis band reduces whipsaw.
 * params: { days=200, band=0, short=false }
 */
function smaTrend(candles, params = {}) {
  const n = daysToBars(params.days || 200, candles, params);
  const band = params.band || 0;
  const short = !!params.short;
  const c = closes(candles);
  const m = sma(c, n);
  const pos = new Int8Array(candles.length);
  let state = 0;
  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(m[i])) {
      pos[i] = 0;
      continue;
    }
    if (c[i] > m[i] * (1 + band)) state = 1;
    else if (c[i] < m[i] * (1 - band)) state = short ? -1 : 0;
    pos[i] = state;
  }
  return pos;
}

/** EMA crossover. params: { fastDays=50, slowDays=200, short=false } */
function emaCross(candles, params = {}) {
  const fast = daysToBars(params.fastDays || 50, candles, params);
  const slow = daysToBars(params.slowDays || 200, candles, params);
  if (fast >= slow) throw new Error('emaCross: fastDays must be < slowDays');
  const short = !!params.short;
  const c = closes(candles);
  const f = ema(c, fast);
  const s = ema(c, slow);
  const pos = new Int8Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(s[i])) continue;
    pos[i] = f[i] > s[i] ? 1 : short ? -1 : 0;
  }
  return pos;
}

/** Time-series momentum: sign of trailing return. params: { lookbackDays=90, short=false } */
function tsmom(candles, params = {}) {
  const L = daysToBars(params.lookbackDays || 90, candles, params);
  const short = !!params.short;
  const c = closes(candles);
  const pos = new Int8Array(candles.length);
  for (let i = L; i < candles.length; i++) {
    pos[i] = c[i] > c[i - L] ? 1 : short ? -1 : 0;
  }
  return pos;
}

function donchianCore(candles, entryBars, exitBars, short) {
  const highs = candles.map((x) => x.high);
  const lows = candles.map((x) => x.low);
  const entryHi = rollingMax(highs, entryBars);
  const entryLo = rollingMin(lows, entryBars);
  const exitLo = rollingMin(lows, exitBars);
  const exitHi = rollingMax(highs, exitBars);
  const pos = new Int8Array(candles.length);
  let state = 0;
  for (let i = 1; i < candles.length; i++) {
    // channels built from bars up to i-1 so the breakout bar itself is excluded
    const close = candles[i].close;
    // exits first, then entries on the same bar (stop-and-reverse when both trigger)
    if (state === 1 && !Number.isNaN(exitLo[i - 1]) && close < exitLo[i - 1]) state = 0;
    else if (state === -1 && !Number.isNaN(exitHi[i - 1]) && close > exitHi[i - 1]) state = 0;
    if (state === 0) {
      if (!Number.isNaN(entryHi[i - 1]) && close > entryHi[i - 1]) state = 1;
      else if (short && !Number.isNaN(entryLo[i - 1]) && close < entryLo[i - 1]) state = -1;
    }
    pos[i] = state;
  }
  return pos;
}

/** Turtle-style Donchian in days. params: { entryDays=20, exitDays=10, short=false } */
function donchian(candles, params = {}) {
  const entry = daysToBars(params.entryDays || 20, candles, params);
  const exit = daysToBars(params.exitDays || 10, candles, params);
  return donchianCore(candles, entry, exit, !!params.short);
}

/**
 * Donchian entry + chandelier (ATR trailing) exit. Long only.
 * params: { entryDays=20, atrBars=14, k=3 }
 */
function chandelier(candles, params = {}) {
  const entry = daysToBars(params.entryDays || 20, candles, params);
  const atrBars = params.atrBars || 14;
  const k = params.k ?? 3;
  const highs = candles.map((x) => x.high);
  const hh = rollingMax(highs, entry);
  const a = atr(candles, atrBars);
  const pos = new Int8Array(candles.length);
  let state = 0;
  let peak = 0;
  for (let i = 1; i < candles.length; i++) {
    const close = candles[i].close;
    if (state === 0) {
      if (!Number.isNaN(hh[i - 1]) && !Number.isNaN(a[i]) && close > hh[i - 1]) {
        state = 1;
        peak = close;
      }
    } else {
      if (close > peak) peak = close;
      if (close < peak - k * a[i]) state = 0;
    }
    pos[i] = state;
  }
  return pos;
}

/**
 * RSI dip-buy inside an uptrend. Long when RSI < entry and close > SMA(trendDays);
 * exit when RSI > exit or close < SMA. params: { rsiBars=14, entry=30, exit=55, trendDays=200 }
 */
function rsiDip(candles, params = {}) {
  const rsiBars = params.rsiBars || 14;
  const entry = params.entry ?? 30;
  const exit = params.exit ?? 55;
  const trend = daysToBars(params.trendDays || 200, candles, params);
  const c = closes(candles);
  const r = rsi(c, rsiBars);
  const m = sma(c, trend);
  const pos = new Int8Array(candles.length);
  let state = 0;
  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(r[i]) || Number.isNaN(m[i])) continue;
    const up = c[i] > m[i];
    if (state === 0 && up && r[i] < entry) state = 1;
    else if (state === 1 && (r[i] > exit || !up)) state = 0;
    pos[i] = state;
  }
  return pos;
}

/**
 * Trend + momentum agreement. Long when close > SMA(smaDays) AND trailing
 * momDays return > 0; short (if enabled) when both negative; else flat.
 * params: { smaDays=200, momDays=90, short=false }
 */
function trendCombo(candles, params = {}) {
  const n = daysToBars(params.smaDays || 200, candles, params);
  const L = daysToBars(params.momDays || 90, candles, params);
  const short = !!params.short;
  const c = closes(candles);
  const m = sma(c, n);
  const pos = new Int8Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(m[i]) || i < L) continue;
    const t = c[i] > m[i];
    const mo = c[i] > c[i - L];
    if (t && mo) pos[i] = 1;
    else if (short && !t && !mo) pos[i] = -1;
  }
  return pos;
}

/**
 * Volatility targeting wrapper: base rule position scaled by targetVol / realisedVol,
 * capped at maxLeverage. params: { base='smaTrend', baseParams={}, targetVol=0.4,
 * volDays=20, maxLeverage (injected by engine, default 1) }
 */
function volTarget(candles, params = {}) {
  const baseName = params.base || 'smaTrend';
  const base = RULES[baseName];
  if (!base) throw new Error(`volTarget: unknown base rule ${baseName}`);
  const basePos = base(candles, { ...params, ...(params.baseParams || {}) });
  const targetVol = params.targetVol ?? 0.4;
  const volBars = daysToBars(params.volDays || 20, candles, params);
  const maxLev = params.maxLeverage ?? 1;
  const rv = realizedVol(closes(candles), volBars, barsPerYearOf(candles, params));
  const pos = new Float64Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const b = basePos[i];
    if (!b) continue;
    const scale = Number.isNaN(rv[i]) || rv[i] === 0 ? 1 : Math.min(maxLev, targetVol / rv[i]);
    pos[i] = b * scale;
  }
  return pos;
}

/**
 * Contrarian dip buy: enter long when close < SMA(days) * (1 - dip); exit when
 * close > SMA(days) * (1 + exitAbove) or after maxHoldDays (0 = no limit).
 * params: { days=200, dip=0.2, exitAbove=0, maxHoldDays=0 }
 */
function dipBuy(candles, params = {}) {
  const n = daysToBars(params.days || 200, candles, params);
  const dip = params.dip ?? 0.2;
  const exitAbove = params.exitAbove ?? 0;
  const maxHold = params.maxHoldDays ? daysToBars(params.maxHoldDays, candles, params) : 0;
  const c = closes(candles);
  const m = sma(c, n);
  const pos = new Int8Array(candles.length);
  let state = 0;
  let entered = -1;
  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(m[i])) continue;
    if (state === 0) {
      if (c[i] < m[i] * (1 - dip)) {
        state = 1;
        entered = i;
      }
    } else if (c[i] > m[i] * (1 + exitAbove) || (maxHold && i - entered >= maxHold)) {
      state = 0;
    }
    pos[i] = state;
  }
  return pos;
}

/**
 * Constant leverage wrapper: base rule position x leverage (engine clamps to maxLeverage
 * and charges borrowApr on the part above 1x). params: { base='smaTrend', baseParams={}, leverage=2 }
 */
function levered(candles, params = {}) {
  const baseName = params.base || 'smaTrend';
  const base = RULES[baseName];
  if (!base) throw new Error(`levered: unknown base rule ${baseName}`);
  const basePos = base(candles, { ...params, ...(params.baseParams || {}) });
  const L = params.leverage ?? 2;
  const pos = new Float64Array(candles.length);
  for (let i = 0; i < candles.length; i++) pos[i] = basePos[i] * L;
  return pos;
}

/**
 * Equal-weight ensemble of rules: position = mean of member positions (fractional).
 * params: { members: [{ rule, params }] }
 */
function ensemble(candles, params = {}) {
  const members = params.members || [
    { rule: 'smaTrend', params: { days: 50 } },
    { rule: 'smaTrend', params: { days: 100 } },
    { rule: 'smaTrend', params: { days: 200 } },
    { rule: 'tsmom', params: { lookbackDays: 90 } },
    { rule: 'tsmom', params: { lookbackDays: 180 } },
    { rule: 'donchian', params: { entryDays: 20, exitDays: 10 } },
    { rule: 'emaCross', params: { fastDays: 20, slowDays: 100 } },
  ];
  if (!members.length) throw new Error('ensemble: no members');
  const pos = new Float64Array(candles.length);
  for (const m of members) {
    const rule = RULES[m.rule];
    if (!rule) throw new Error(`ensemble: unknown rule ${m.rule}`);
    const p = rule(candles, { ...params, ...(m.params || {}) });
    for (let i = 0; i < candles.length; i++) pos[i] += p[i] / members.length;
  }
  return pos;
}

// ---------------------------------------------------------------- calendar rules (timestamps are known in advance)

/** Long except during listed UTC weekdays (0=Sun..6=Sat). params: { days=[5] } */
function skipDays(candles, params = {}) {
  const skip = new Set(params.days || [5]);
  const bs = barSecondsOf(candles, params);
  const pos = new Int8Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const nextDay = new Date((candles[i].timestamp + bs) * 1000).getUTCDay();
    pos[i] = skip.has(nextDay) ? 0 : 1;
  }
  return pos;
}

/** Long only while the NEXT bar's UTC hour is in [from, to). params: { from=13, to=21 } */
function hours(candles, params = {}) {
  const from = params.from ?? 13;
  const to = params.to ?? 21;
  const bs = barSecondsOf(candles, params);
  const pos = new Int8Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const h = new Date((candles[i].timestamp + bs) * 1000).getUTCHours();
    const inWin = from <= to ? h >= from && h < to : h >= from || h < to;
    pos[i] = inWin ? 1 : 0;
  }
  return pos;
}

const RULES = {
  momentum,
  meanReversion,
  breakout,
  buyAndHold,
  smaTrend,
  emaCross,
  tsmom,
  donchian,
  chandelier,
  rsiDip,
  trendCombo,
  dipBuy,
  volTarget,
  levered,
  ensemble,
  skipDays,
  hours,
};

module.exports = {
  RULES,
  ...RULES,
  indicators: { sma, ema, rollingStd, rollingMax, rollingMin, rsi, atr, realizedVol },
  daysToBars,
};
