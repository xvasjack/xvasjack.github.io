'use strict';
/**
 * jev-lite backtester.
 *
 * Single asset. Position per bar in [-maxLeverage, +maxLeverage] (1 = 100% long,
 * -1 = 100% short, 0.5 = half size). Position decided at bar i close is executed
 * at bar i+1 open. Fee + slippage charged on every unit of position change.
 * Optional short funding cost (annualised) charged while short.
 *
 * CLI:
 *   node backtest.js                          # run strategy catalog (strategies.js)
 *   node backtest.js --rule smaTrend --tf 1d  # single rule from rules.js, default params
 *   node backtest.js --fee 10 --slip 5        # bps per side (defaults)
 *   node backtest.js --oos 2025-01-01         # out-of-sample start (default)
 * Writes results/backtest-results.json.
 */
const fs = require('fs');
const path = require('path');
const { RULES } = require('./rules');

const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_DIR = path.join(__dirname, 'results');
const YEAR_SECONDS = 365 * 86400;
const TF_SECONDS = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const DATA_FILES = { '15m': 'btcusd_15m.csv', '1h': 'btcusd_1h.csv' };
const BARS_PER_YEAR = Object.fromEntries(
  Object.entries(TF_SECONDS).map(([tf, s]) => [tf, YEAR_SECONDS / s])
);
const DEFAULT_OOS = '2025-01-01';

// ---------------------------------------------------------------- data

function loadCandles(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const p = l.split(',');
    out.push({
      timestamp: +p[0],
      open: +p[1],
      high: +p[2],
      low: +p[3],
      close: +p[4],
      volume: +p[5],
    });
  }
  return out;
}

function inferBarSeconds(candles) {
  if (candles.length < 2) throw new Error('need at least 2 candles');
  return candles[1].timestamp - candles[0].timestamp;
}

/**
 * Aggregate candles into larger UTC-aligned buckets (boundary shifted by offsetSeconds).
 * Drops partial first/last buckets.
 */
function resample(candles, seconds, offsetSeconds = 0) {
  const src = inferBarSeconds(candles);
  if (seconds % src !== 0) throw new Error(`cannot resample ${src}s bars into ${seconds}s`);
  const expected = seconds / src;
  const out = [];
  let cur = null;
  for (const c of candles) {
    const b = Math.floor((c.timestamp - offsetSeconds) / seconds) * seconds + offsetSeconds;
    if (!cur || cur.timestamp !== b) {
      if (cur && cur.bars === expected) out.push(cur);
      cur = {
        timestamp: b,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        bars: 1,
      };
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
      cur.bars++;
    }
  }
  if (cur && cur.bars === expected) out.push(cur);
  for (const c of out) delete c.bars;
  return out;
}

const tfCache = {};
/** Load a timeframe: 15m/1h from disk, 4h/1d resampled from 1h. Cached. */
function loadTimeframe(tf) {
  if (tfCache[tf]) return tfCache[tf];
  let candles;
  if (DATA_FILES[tf]) candles = loadCandles(path.join(DATA_DIR, DATA_FILES[tf]));
  else if (TF_SECONDS[tf]) candles = resample(loadTimeframe('1h'), TF_SECONDS[tf]);
  else throw new Error(`unknown timeframe ${tf}`);
  tfCache[tf] = candles;
  return candles;
}

// ---------------------------------------------------------------- engine

/**
 * @param {Array} candles
 * @param {Function} rule  (candles, params) => positions (array-like, one per candle)
 * @param {Object} opts   { feeBps=10, slippageBps=5, params={}, maxLeverage=1,
 *                          shortFundingApr=0, borrowApr=0.1 (on |pos|>1 only),
 *                          oosStart='2025-01-01' }
 */
function runBacktest(candles, rule, opts = {}) {
  const feeBps = opts.feeBps ?? 10;
  const slippageBps = opts.slippageBps ?? 5;
  const cost = (feeBps + slippageBps) / 10000;
  const barSeconds = opts.barSeconds || inferBarSeconds(candles);
  const barsPerYear = opts.barsPerYear || YEAR_SECONDS / barSeconds;
  const maxLeverage = opts.maxLeverage ?? 1;
  const shortFundingApr = opts.shortFundingApr ?? 0;
  const borrowApr = opts.borrowApr ?? 0.1; // charged on |position| above 1x (margin borrow)
  const oosStart = toTs(opts.oosStart || DEFAULT_OOS);
  const n = candles.length;
  if (n < 3) throw new Error('need at least 3 candles');

  const params = { barSeconds, barsPerYear, maxLeverage, ...(opts.params || {}) };
  const raw = rule(candles, params);
  if (!raw || raw.length !== n) throw new Error('rule returned wrong length');
  const pos = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let p = Number(raw[i]);
    if (!Number.isFinite(p)) p = 0;
    pos[i] = Math.max(-maxLeverage, Math.min(maxLeverage, p));
  }

  const equity = new Float64Array(n);
  const returns = new Float64Array(n); // per-bar strategy return net of all costs
  equity[0] = 1;
  let held = 0;
  let eq = 1;
  let turnover = 0;
  const trades = [];
  let open = null;
  let wiped = false;

  for (let i = 1; i < n; i++) {
    const eqStart = eq;
    const target = pos[i - 1];
    const px = candles[i].open;
    const delta = target - held;
    if (delta !== 0) {
      turnover += Math.abs(delta);
      eq *= 1 - cost * Math.abs(delta);
      const flip = open && (target === 0 || Math.sign(target) !== open.side);
      if (flip) {
        trades.push(closeTrade(open, i, candles[i].timestamp, px, eq));
        open = null;
      }
      if (!open && target !== 0) {
        open = {
          entryIdx: i,
          entryTs: candles[i].timestamp,
          entryPx: px,
          entryEq: eq,
          side: Math.sign(target),
        };
      }
      held = target;
    }
    const next = i + 1 < n ? candles[i + 1].open : candles[i].close;
    const r = next / px - 1;
    eq *= 1 + held * r;
    if (held < 0 && shortFundingApr) {
      eq *= 1 - (shortFundingApr * -held * barSeconds) / YEAR_SECONDS;
    }
    if (Math.abs(held) > 1 && borrowApr) {
      eq *= 1 - (borrowApr * (Math.abs(held) - 1) * barSeconds) / YEAR_SECONDS;
    }
    if (eq <= 0) {
      eq = 0;
      wiped = true;
    }
    returns[i] = eqStart > 0 ? eq / eqStart - 1 : 0;
    equity[i] = eq;
    if (wiped) {
      for (let j = i + 1; j < n; j++) equity[j] = 0;
      if (open) trades.push(closeTrade(open, i, candles[i].timestamp, candles[i].close, 0));
      open = null;
      held = 0;
      break;
    }
  }
  if (open) {
    const last = candles[n - 1];
    const before = eq;
    eq *= 1 - cost * Math.abs(held);
    turnover += Math.abs(held);
    returns[n - 1] = (1 + returns[n - 1]) * (eq / before) - 1;
    trades.push(closeTrade(open, n - 1, last.timestamp, last.close, eq));
    equity[n - 1] = eq;
  }

  return {
    equity: Array.from(equity),
    returns: Array.from(returns),
    positions: Array.from(pos),
    trades,
    wiped,
    metrics: metrics({
      equity,
      returns,
      trades,
      pos,
      candles,
      barsPerYear,
      turnover,
      oosStart,
      wiped,
    }),
  };
}

function closeTrade(o, exitIdx, exitTs, exitPx, exitEq) {
  return {
    side: o.side > 0 ? 'long' : 'short',
    entryTs: o.entryTs,
    exitTs,
    entryPx: o.entryPx,
    exitPx,
    bars: exitIdx - o.entryIdx,
    pnlPct: exitEq / o.entryEq - 1,
  };
}

// ---------------------------------------------------------------- metrics

function metrics({
  equity,
  returns,
  trades,
  pos,
  candles,
  barsPerYear,
  turnover,
  oosStart,
  wiped,
}) {
  const n = equity.length;
  const first = candles[0].timestamp;
  const last = candles[n - 1].timestamp;
  const years = (last - first) / YEAR_SECONDS;
  const full = segmentMetrics(equity, returns, candles, first, last + 1, barsPerYear);

  let exposure = 0;
  let absPos = 0;
  for (let i = 0; i < pos.length; i++) {
    if (pos[i] !== 0) exposure++;
    absPos += Math.abs(pos[i]);
  }

  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlPct, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnlPct, 0);

  const yearly = {};
  for (let y = utcYear(first); y <= utcYear(last); y++) {
    const seg = segmentMetrics(
      equity,
      returns,
      candles,
      ymd(y, 1, 1),
      ymd(y + 1, 1, 1),
      barsPerYear
    );
    if (seg) yearly[y] = { return: seg.return, buyHold: seg.buyHold, maxDrawdown: seg.maxDrawdown };
  }

  return {
    bars: n,
    from: iso(first),
    to: iso(last),
    years: round(years, 3),
    totalReturn: full.return,
    cagr: round(years > 0 ? Math.pow(Math.max(0, 1 + full.return), 1 / years) - 1 : 0, 4),
    maxDrawdown: full.maxDrawdown,
    sharpe: full.sharpe,
    calmar:
      full.maxDrawdown > 0 && years > 0
        ? round((Math.pow(Math.max(0, 1 + full.return), 1 / years) - 1) / full.maxDrawdown, 3)
        : null,
    exposure: round(exposure / pos.length, 4),
    avgLeverage: round(absPos / pos.length, 4),
    turnoverPerYear: round(years > 0 ? turnover / years : turnover, 2),
    trades: trades.length,
    winRate: trades.length ? round(wins.length / trades.length, 4) : null,
    avgTradePct: trades.length
      ? round(trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length, 5)
      : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : null,
    buyHoldReturn: full.buyHold,
    wiped: !!wiped,
    inSample: segmentMetrics(equity, returns, candles, first, oosStart, barsPerYear),
    outOfSample: segmentMetrics(equity, returns, candles, oosStart, last + 1, barsPerYear),
    oosStart: iso(oosStart),
    yearly,
  };
}

/** Metrics for bars with fromTs <= timestamp < toTs, using the full-run equity curve. */
function segmentMetrics(equity, returns, candles, fromTs, toTs, barsPerYear) {
  const n = candles.length;
  let a = -1;
  let b = -1;
  for (let i = 0; i < n; i++) {
    const ts = candles[i].timestamp;
    if (ts >= fromTs && ts < toTs) {
      if (a < 0) a = i;
      b = i;
    }
  }
  if (a < 0 || b < a) return null;
  const startEq = a > 0 ? equity[a - 1] : equity[0];
  if (startEq <= 0) {
    return {
      from: iso(candles[a].timestamp),
      to: iso(candles[b].timestamp),
      return: -1,
      maxDrawdown: 1,
      sharpe: null,
      buyHold: null,
      bars: b - a + 1,
    };
  }
  const ret = equity[b] / startEq - 1;
  let peak = startEq;
  let maxDD = 0;
  for (let i = a; i <= b; i++) {
    if (equity[i] > peak) peak = equity[i];
    const dd = 1 - equity[i] / peak;
    if (dd > maxDD) maxDD = dd;
  }
  let sum = 0;
  let sumSq = 0;
  let cnt = 0;
  for (let i = Math.max(a, 1); i <= b; i++) {
    sum += returns[i];
    sumSq += returns[i] * returns[i];
    cnt++;
  }
  const m = cnt ? sum / cnt : 0;
  const variance = cnt > 1 ? Math.max(0, sumSq / cnt - m * m) : 0;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(barsPerYear) : 0;
  return {
    from: iso(candles[a].timestamp),
    to: iso(candles[b].timestamp),
    bars: b - a + 1,
    return: round(ret, 4),
    maxDrawdown: round(maxDD, 4),
    sharpe: round(sharpe, 3),
    buyHold: round(candles[b].close / candles[a].open - 1, 4),
  };
}

const round = (x, d) => (Number.isFinite(x) ? +x.toFixed(d) : x);
const utcYear = (ts) => new Date(ts * 1000).getUTCFullYear();
const ymd = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
function toTs(x) {
  if (typeof x === 'number') return x;
  const t = Date.parse(x.length === 10 ? x + 'T00:00:00Z' : x);
  if (Number.isNaN(t)) throw new Error(`bad date ${x}`);
  return t / 1000;
}

// ---------------------------------------------------------------- catalog runner

/**
 * Run a list of strategy entries: { name, tf, rule, params, maxLeverage, shortFundingApr }.
 * Returns [{ name, tf, rule, params, metrics, lastTrades }].
 */
function runCatalog(entries, opts = {}) {
  const out = [];
  for (const e of entries) {
    const candles = loadTimeframe(e.tf);
    const rule = typeof e.rule === 'function' ? e.rule : RULES[e.rule];
    if (!rule) throw new Error(`unknown rule ${e.rule}`);
    const res = runBacktest(candles, rule, {
      feeBps: opts.feeBps,
      slippageBps: opts.slippageBps,
      oosStart: opts.oosStart,
      params: e.params || {},
      maxLeverage: e.maxLeverage,
      shortFundingApr: e.shortFundingApr ?? opts.shortFundingApr,
      borrowApr: e.borrowApr ?? opts.borrowApr,
    });
    out.push({
      name: e.name,
      tf: e.tf,
      rule: typeof e.rule === 'function' ? e.rule.name : e.rule,
      params: e.params || {},
      maxLeverage: e.maxLeverage ?? 1,
      note: e.note,
      metrics: res.metrics,
      lastTrades: res.trades.slice(-3),
    });
  }
  return out;
}

const pct = (x) => (x == null ? '-' : (x * 100).toFixed(1) + '%');
const num = (x, d = 2) => (x == null ? '-' : Number(x).toFixed(d));

function formatTable(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(w[i])).join('  ');
  return [line(cols), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

function catalogRows(results) {
  return results.map((r) => {
    const m = r.metrics;
    return {
      strategy: r.name,
      tf: r.tf,
      return: pct(m.totalReturn),
      cagr: pct(m.cagr),
      maxDD: pct(m.maxDrawdown),
      sharpe: num(m.sharpe),
      calmar: num(m.calmar),
      trades: m.trades,
      exp: pct(m.exposure),
      IS_ret: pct(m.inSample && m.inSample.return),
      IS_sh: num(m.inSample && m.inSample.sharpe),
      OOS_ret: pct(m.outOfSample && m.outOfSample.return),
      OOS_sh: num(m.outOfSample && m.outOfSample.sharpe),
      OOS_dd: pct(m.outOfSample && m.outOfSample.maxDrawdown),
      ...Object.fromEntries(Object.entries(m.yearly).map(([y, v]) => [`Y${y}`, pct(v.return)])),
    };
  });
}

function parseArgs(argv) {
  const a = { tf: null, rule: null, fee: 10, slip: 5, oos: DEFAULT_OOS, sort: 'sharpe' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--tf') a.tf = argv[++i];
    else if (k === '--rule') a.rule = argv[++i];
    else if (k === '--fee') a.fee = +argv[++i];
    else if (k === '--slip') a.slip = +argv[++i];
    else if (k === '--oos') a.oos = argv[++i];
    else if (k === '--sort') a.sort = argv[++i];
  }
  return a;
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  let entries;
  if (a.rule) {
    if (!RULES[a.rule]) throw new Error(`unknown rule ${a.rule}`);
    entries = [{ name: a.rule, tf: a.tf || '1d', rule: a.rule, params: {} }];
  } else {
    const { CATALOG } = require('./strategies');
    entries = a.tf ? CATALOG.filter((e) => e.tf === a.tf) : CATALOG;
  }
  const results = runCatalog(entries, { feeBps: a.fee, slippageBps: a.slip, oosStart: a.oos });
  const key =
    a.sort === 'oos'
      ? (r) => r.metrics.outOfSample?.sharpe ?? -1e9
      : (r) => r.metrics[a.sort] ?? -1e9;
  results.sort((x, y) => key(y) - key(x));
  console.log(
    `fee ${a.fee}bps + slip ${a.slip}bps per side | OOS from ${a.oos} | sorted by ${a.sort}\n`
  );
  console.log(formatTable(catalogRows(results)));
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, 'backtest-results.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    feeBps: a.fee,
    slippageBps: a.slip,
    oosStart: a.oos,
    results,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`\nwrote ${outFile}`);
}

module.exports = {
  loadCandles,
  loadTimeframe,
  resample,
  inferBarSeconds,
  runBacktest,
  runCatalog,
  segmentMetrics,
  catalogRows,
  formatTable,
  pct,
  num,
  BARS_PER_YEAR,
  TF_SECONDS,
  DATA_FILES,
  DEFAULT_OOS,
};
