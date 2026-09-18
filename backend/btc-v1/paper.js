'use strict';
/**
 * Paper trader for the btc-v1 trend strategy (ensemble of smaTrend 40/50/60/75d).
 *
 * Once a day (after the 00:00 UTC daily close): fetch daily candles from Bitstamp,
 * compute the target position (0..1), rebalance a virtual account at the current
 * price with the same fee model as the backtest, and log equity vs buy & hold.
 *
 * Pure functions here take injected fetch/time so they are testable offline.
 */
const nodeFetch = require('node-fetch');
const { ensemble, indicators } = require('./rules');

const STRATEGY = {
  name: 'ensemble smaTrend 40/50/60/75d',
  members: [40, 50, 60, 75],
};
const COST_BPS = Number(process.env.BTC_COST_BPS || 15); // fee + slippage per side
const START_CASH = Number(process.env.BTC_START_CASH || 10000);
const MIN_TRADE_FRACTION = 0.01; // ignore rebalances smaller than 1% of equity
const DAY = 86400;
const BITSTAMP = 'https://www.bitstamp.net/api/v2';

// ---------------------------------------------------------------- market data

/** Completed daily candles, ascending. Drops the in-progress candle. */
async function fetchDailyCandles({ limit = 200, fetchImpl = nodeFetch, now = Date.now() } = {}) {
  const res = await fetchImpl(`${BITSTAMP}/ohlc/btcusd/?step=${DAY}&limit=${limit}`);
  if (!res.ok) throw new Error(`bitstamp ohlc ${res.status}`);
  const json = await res.json();
  const rows = json && json.data && json.data.ohlc;
  if (!Array.isArray(rows) || !rows.length) throw new Error('bitstamp ohlc: empty');
  const nowSec = Math.floor(now / 1000);
  return rows
    .map((r) => ({
      timestamp: +r.timestamp,
      open: +r.open,
      high: +r.high,
      low: +r.low,
      close: +r.close,
      volume: +r.volume,
    }))
    .filter((c) => Number.isFinite(c.close) && c.timestamp + DAY <= nowSec)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchLastPrice({ fetchImpl = nodeFetch } = {}) {
  const res = await fetchImpl(`${BITSTAMP}/ticker/btcusd/`);
  if (!res.ok) throw new Error(`bitstamp ticker ${res.status}`);
  const json = await res.json();
  const px = Number(json && json.last);
  if (!Number.isFinite(px) || px <= 0) throw new Error('bitstamp ticker: bad price');
  return px;
}

// ---------------------------------------------------------------- signal

/** Target position in [0,1] from completed daily candles (ascending). */
function computeSignal(candles) {
  const need = Math.max(...STRATEGY.members) + 1;
  if (!candles || candles.length < need) {
    throw new Error(`need >= ${need} daily candles, got ${candles ? candles.length : 0}`);
  }
  const params = {
    barSeconds: DAY,
    members: STRATEGY.members.map((d) => ({ rule: 'smaTrend', params: { days: d } })),
  };
  const pos = ensemble(candles, params);
  const i = candles.length - 1;
  const closes = candles.map((c) => c.close);
  const smas = STRATEGY.members.map((d) => {
    const v = indicators.sma(closes, d)[i];
    return { days: d, sma: round(v, 2), above: closes[i] > v };
  });
  return {
    asOf: candles[i].timestamp, // open time of the last completed daily candle
    close: closes[i],
    target: round(pos[i], 4),
    smas,
    strategy: STRATEGY.name,
  };
}

// ---------------------------------------------------------------- account

function newState(now = Date.now()) {
  return {
    version: 1,
    strategy: STRATEGY.name,
    costBps: COST_BPS,
    startedAt: new Date(now).toISOString(),
    startCash: START_CASH,
    cash: START_CASH,
    btc: 0,
    bhBtc: null, // buy & hold benchmark: BTC bought with startCash at first run
    target: 0,
    lastRun: null,
    lastSignal: null,
    trades: [],
    history: [],
  };
}

function equityOf(state, price) {
  return state.cash + state.btc * price;
}

/**
 * Apply a signal at a price. Idempotent per signal.asOf unless force.
 * Returns { state, traded, skipped }.
 */
function step(state, signal, price, { now = Date.now(), force = false } = {}) {
  if (!force && state.lastSignal && state.lastSignal.asOf >= signal.asOf) {
    return { state, traded: null, skipped: 'already processed' };
  }
  const cost = COST_BPS / 10000;
  if (state.bhBtc == null) state.bhBtc = (state.startCash * (1 - cost)) / price;

  const equity = equityOf(state, price);
  const targetUsd = signal.target * equity;
  const currentUsd = state.btc * price;
  const delta = targetUsd - currentUsd; // >0 buy, <0 sell
  let traded = null;
  if (Math.abs(delta) >= MIN_TRADE_FRACTION * equity) {
    const fee = Math.abs(delta) * cost;
    state.btc += delta / price;
    state.cash -= delta + fee;
    if (Math.abs(state.btc) < 1e-12) state.btc = 0;
    traded = {
      ts: new Date(now).toISOString(),
      side: delta > 0 ? 'buy' : 'sell',
      price,
      usd: round(Math.abs(delta), 2),
      btc: round(Math.abs(delta) / price, 8),
      fee: round(fee, 2),
      target: signal.target,
    };
    state.trades.push(traded);
  }
  state.target = signal.target;
  state.lastSignal = signal;
  state.lastRun = new Date(now).toISOString();
  state.history.push({
    ts: state.lastRun,
    asOf: signal.asOf,
    price,
    target: signal.target,
    equity: round(equityOf(state, price), 2),
    bhEquity: round(state.bhBtc * price, 2),
  });
  return { state, traded, skipped: null };
}

function summary(state, price) {
  const equity = equityOf(state, price);
  const bh = state.bhBtc != null ? state.bhBtc * price : state.startCash;
  const peak = state.history.reduce((m, h) => Math.max(m, h.equity), equity);
  return {
    strategy: state.strategy,
    startedAt: state.startedAt,
    lastRun: state.lastRun,
    price,
    target: state.target,
    btc: round(state.btc, 8),
    cash: round(state.cash, 2),
    equity: round(equity, 2),
    returnPct: round((equity / state.startCash - 1) * 100, 2),
    buyHoldEquity: round(bh, 2),
    buyHoldReturnPct: round((bh / state.startCash - 1) * 100, 2),
    drawdownPct: round((1 - equity / peak) * 100, 2),
    trades: state.trades.length,
    days: state.history.length,
  };
}

// ---------------------------------------------------------------- report

function formatReport(state, signal, price, traded) {
  const s = summary(state, price);
  const posLabel = signal.target === 0 ? 'CASH' : `LONG ${Math.round(signal.target * 100)}%`;
  const subject = `btc-v1 paper: ${posLabel} | BTC ${fmt(price, 0)} | equity ${fmt(s.equity)} (${sign(s.returnPct)}%) vs B&H ${sign(s.buyHoldReturnPct)}%`;
  const smaRows = signal.smas
    .map(
      (m) =>
        `<tr><td>SMA ${m.days}d</td><td>${fmt(m.sma)}</td><td>${m.above ? 'above' : 'below'}</td></tr>`
    )
    .join('');
  const tradeLine = traded
    ? `<p><b>Trade:</b> ${traded.side} ${traded.btc} BTC (${fmt(traded.usd)}) at ${fmt(traded.price)}, fee ${fmt(traded.fee)}</p>`
    : '<p>No trade today.</p>';
  const recent = state.trades
    .slice(-5)
    .reverse()
    .map(
      (t) =>
        `<tr><td>${t.ts.slice(0, 10)}</td><td>${t.side}</td><td>${fmt(t.usd)}</td><td>${fmt(t.price)}</td><td>${t.target}</td></tr>`
    )
    .join('');
  const html = `
<h2>btc-v1 paper trader</h2>
<p>${state.strategy}. Signal as of daily close ${new Date((signal.asOf + DAY) * 1000).toISOString().slice(0, 10)} 00:00 UTC. Close ${fmt(signal.close)}. Position: <b>${posLabel}</b>.</p>
<table border="1" cellpadding="4"><tr><th>indicator</th><th>value</th><th>price is</th></tr>${smaRows}</table>
${tradeLine}
<table border="1" cellpadding="4">
<tr><td>Equity</td><td>${fmt(s.equity)}</td><td>${sign(s.returnPct)}%</td></tr>
<tr><td>Buy &amp; hold</td><td>${fmt(s.buyHoldEquity)}</td><td>${sign(s.buyHoldReturnPct)}%</td></tr>
<tr><td>Drawdown from peak</td><td colspan="2">${s.drawdownPct}%</td></tr>
<tr><td>Cash / BTC</td><td>${fmt(s.cash)}</td><td>${s.btc} BTC</td></tr>
<tr><td>Days / trades</td><td>${s.days}</td><td>${s.trades}</td></tr>
</table>
${recent ? `<h3>Last trades</h3><table border="1" cellpadding="4"><tr><th>date</th><th>side</th><th>usd</th><th>price</th><th>target</th></tr>${recent}</table>` : ''}
<p style="color:#888">Paper only. Fees ${state.costBps} bps/side. Signal uses completed daily candles; fills at ticker price when the job runs.</p>`;
  return { subject, html };
}

const round = (x, d) => (Number.isFinite(x) ? +x.toFixed(d) : x);
const fmt = (x, d = 2) =>
  '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sign = (x) => (x >= 0 ? '+' : '') + x;

module.exports = {
  STRATEGY,
  COST_BPS,
  START_CASH,
  fetchDailyCandles,
  fetchLastPrice,
  computeSignal,
  newState,
  step,
  summary,
  formatReport,
  equityOf,
};
