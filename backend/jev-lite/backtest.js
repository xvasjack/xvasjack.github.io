'use strict';
/**
 * jev-lite backtester.
 *
 * Long/flat, single asset, all-in sizing. Positions decided at bar i close are
 * executed at bar i+1 open. Fees + slippage charged on every position change.
 *
 * CLI:
 *   node backtest.js                      # all rules, 1h + 15m
 *   node backtest.js --tf 1h --rule momentum
 *   node backtest.js --fee 10 --slip 5    # bps per side
 * Writes results/backtest-results.json.
 */
const fs = require('fs');
const path = require('path');
const { RULES } = require('./rules');

const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_DIR = path.join(__dirname, 'results');
const BARS_PER_YEAR = { '1h': 24 * 365, '15m': 96 * 365 };
const DATA_FILES = { '1h': 'btcusd_1h.csv', '15m': 'btcusd_15m.csv' };

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

/**
 * @param {Array} candles
 * @param {Function} rule  (candles, params) => positions
 * @param {Object} opts   { feeBps=10, slippageBps=5, params={}, barsPerYear }
 */
function runBacktest(candles, rule, opts = {}) {
  const feeBps = opts.feeBps ?? 10;
  const slippageBps = opts.slippageBps ?? 5;
  const cost = (feeBps + slippageBps) / 10000;
  const barsPerYear = opts.barsPerYear || BARS_PER_YEAR['1h'];
  const n = candles.length;
  if (n < 3) throw new Error('need at least 3 candles');

  const pos = rule(candles, opts.params || {});
  if (pos.length !== n) throw new Error('rule returned wrong length');

  const equity = new Float64Array(n);
  const returns = new Float64Array(n); // per-bar strategy return, open[i] -> open[i+1]
  equity[0] = 1;
  let held = 0;
  let eq = 1;
  const trades = [];
  let open = null;

  for (let i = 1; i < n; i++) {
    const target = pos[i - 1];
    const px = candles[i].open;
    let costMult = 1;
    if (target !== held) {
      costMult = 1 - cost;
      eq *= costMult;
      if (target === 1) {
        open = { entryIdx: i, entryTs: candles[i].timestamp, entryPx: px, entryEq: eq };
      } else if (open) {
        trades.push(closeTrade(open, i, candles[i].timestamp, px, eq));
        open = null;
      }
      held = target;
    }
    const next = i + 1 < n ? candles[i + 1].open : candles[i].close;
    const r = held ? next / px - 1 : 0;
    eq *= 1 + r;
    returns[i] = costMult * (1 + r) - 1; // net of cost so Sharpe reflects fees
    equity[i] = eq;
  }
  if (open) {
    const last = candles[n - 1];
    eq *= 1 - cost;
    returns[n - 1] = (1 + returns[n - 1]) * (1 - cost) - 1;
    trades.push(closeTrade(open, n - 1, last.timestamp, last.close, eq));
    equity[n - 1] = eq;
  }

  return {
    equity: Array.from(equity),
    trades,
    metrics: metrics(equity, returns, trades, pos, candles, barsPerYear),
  };
}

function closeTrade(o, exitIdx, exitTs, exitPx, exitEq) {
  return {
    entryTs: o.entryTs,
    exitTs,
    entryPx: o.entryPx,
    exitPx,
    bars: exitIdx - o.entryIdx,
    pnlPct: exitEq / o.entryEq - 1,
  };
}

function metrics(equity, returns, trades, pos, candles, barsPerYear) {
  const n = equity.length;
  const finalEq = equity[n - 1];
  const years = (candles[n - 1].timestamp - candles[0].timestamp) / (365 * 86400);
  const totalReturn = finalEq - 1;
  const cagr = years > 0 ? Math.pow(finalEq, 1 / years) - 1 : 0;

  let peak = equity[0];
  let maxDD = 0;
  for (let i = 0; i < n; i++) {
    if (equity[i] > peak) peak = equity[i];
    const dd = 1 - equity[i] / peak;
    if (dd > maxDD) maxDD = dd;
  }

  let sum = 0;
  let sumSq = 0;
  for (let i = 1; i < n; i++) {
    sum += returns[i];
    sumSq += returns[i] * returns[i];
  }
  const m = n > 1 ? sum / (n - 1) : 0;
  const variance = n > 2 ? Math.max(0, sumSq / (n - 1) - m * m) : 0;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(barsPerYear) : 0;

  let exposure = 0;
  for (let i = 0; i < pos.length; i++) exposure += pos[i] ? 1 : 0;
  exposure /= pos.length;

  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlPct, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnlPct, 0);
  const buyHold = candles[n - 1].close / candles[0].open - 1;

  return {
    bars: n,
    years: round(years, 3),
    totalReturn: round(totalReturn, 4),
    cagr: round(cagr, 4),
    maxDrawdown: round(maxDD, 4),
    sharpe: round(sharpe, 3),
    calmar: maxDD > 0 ? round(cagr / maxDD, 3) : null,
    exposure: round(exposure, 4),
    trades: trades.length,
    winRate: trades.length ? round(wins.length / trades.length, 4) : null,
    avgTradePct: trades.length
      ? round(trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length, 5)
      : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : null,
    buyHoldReturn: round(buyHold, 4),
  };
}

const round = (x, d) => (Number.isFinite(x) ? +x.toFixed(d) : x);

function runAll({ timeframes, rules, feeBps, slippageBps }) {
  const results = {};
  for (const tf of timeframes) {
    const candles = loadCandles(path.join(DATA_DIR, DATA_FILES[tf]));
    results[tf] = {
      candles: candles.length,
      from: new Date(candles[0].timestamp * 1000).toISOString(),
      to: new Date(candles[candles.length - 1].timestamp * 1000).toISOString(),
      rules: {},
    };
    for (const name of rules) {
      const { metrics: mt, trades } = runBacktest(candles, RULES[name], {
        feeBps,
        slippageBps,
        barsPerYear: BARS_PER_YEAR[tf],
      });
      results[tf].rules[name] = { ...mt, lastTrades: trades.slice(-3) };
    }
  }
  return results;
}

const pct = (x) => (x * 100).toFixed(1) + '%';

function printTable(results) {
  const cols = ['rule', 'return', 'cagr', 'maxDD', 'sharpe', 'trades', 'winRate', 'PF', 'exposure'];
  for (const [tf, r] of Object.entries(results)) {
    const bh = pct(Object.values(r.rules)[0].buyHoldReturn);
    console.log(
      `\n== ${tf}  ${r.candles} bars  ${r.from.slice(0, 10)} .. ${r.to.slice(0, 10)}  (B&H ${bh})`
    );
    const rows = [cols];
    for (const [name, m] of Object.entries(r.rules)) {
      rows.push([
        name,
        pct(m.totalReturn),
        pct(m.cagr),
        pct(m.maxDrawdown),
        String(m.sharpe),
        String(m.trades),
        m.winRate == null ? '-' : pct(m.winRate),
        m.profitFactor == null ? '-' : String(m.profitFactor),
        pct(m.exposure),
      ]);
    }
    const w = cols.map((_, i) => Math.max(...rows.map((row) => row[i].length)));
    for (const row of rows) console.log(row.map((c, i) => c.padEnd(w[i])).join('  '));
  }
}

function parseArgs(argv) {
  const a = { tf: null, rule: null, fee: 10, slip: 5 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--tf') a.tf = argv[++i];
    else if (k === '--rule') a.rule = argv[++i];
    else if (k === '--fee') a.fee = +argv[++i];
    else if (k === '--slip') a.slip = +argv[++i];
  }
  return a;
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  const timeframes = a.tf ? [a.tf] : Object.keys(DATA_FILES);
  const rules = a.rule ? [a.rule] : Object.keys(RULES);
  for (const tf of timeframes) if (!DATA_FILES[tf]) throw new Error(`unknown tf ${tf}`);
  for (const r of rules) if (!RULES[r]) throw new Error(`unknown rule ${r}`);
  const results = runAll({ timeframes, rules, feeBps: a.fee, slippageBps: a.slip });
  printTable(results);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, 'backtest-results.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    feeBps: a.fee,
    slippageBps: a.slip,
    results,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`\nwrote ${outFile}`);
}

module.exports = { loadCandles, runBacktest, runAll, BARS_PER_YEAR, DATA_FILES };
