'use strict';
/**
 * Contrarian test: buy when price is X% below the 200d SMA, sell when it comes
 * back to the SMA (or above / after a max hold). Daily bars 2014-2026 and 2023-2026.
 * Writes results/DIP_BUY.md.
 *
 *   node scripts/dip-buy.js
 */
const fs = require('fs');
const path = require('path');
const { RULES } = require('../rules');
const { loadTimeframe, runBacktest, segmentMetrics, pct, num } = require('../backtest');

const RESULTS_DIR = path.join(__dirname, '..', 'results');
const COST = { feeBps: 10, slippageBps: 5 };
const ymd = (y) => Date.UTC(y, 0, 1) / 1000;
const BPY = 365;

function mdTable(rows) {
  const cols = Object.keys(rows[0]);
  return [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`),
  ].join('\n');
}

function evaluate(all, fromTs, variants) {
  const last = all[all.length - 1].timestamp + 1;
  const years = (last - fromTs) / (365 * 86400);
  return variants.map((v) => {
    const res = runBacktest(all, RULES[v.rule], {
      ...COST,
      params: v.params,
      oosStart: '2023-01-01',
    });
    const s = segmentMetrics(res.equity, res.returns, all, fromTs, last, BPY);
    const cagr = Math.pow(1 + s.return, 1 / years) - 1;
    const yearly = {};
    let posYears = 0;
    let nYears = 0;
    for (let y = new Date(fromTs * 1000).getUTCFullYear(); y <= 2026; y++) {
      const ys = segmentMetrics(res.equity, res.returns, all, ymd(y), ymd(y + 1), BPY);
      if (!ys) continue;
      nYears++;
      if (ys.return > 0) posYears++;
      yearly[`Y${y}`] = pct(ys.return);
    }
    // exposure within the reported window
    const a = all.findIndex((c) => c.timestamp >= fromTs);
    const p = res.positions.slice(a);
    const exposure = p.filter((x) => x !== 0).length / p.length;
    const trades = res.trades.filter((t) => t.entryTs >= fromTs);
    return {
      strategy: v.label,
      return: pct(s.return),
      cagr: pct(cagr),
      maxDD: pct(s.maxDrawdown),
      sharpe: num(s.sharpe),
      exposure: pct(exposure),
      trades: trades.length,
      winRate: trades.length ? pct(trades.filter((t) => t.pnlPct > 0).length / trades.length) : '-',
      positiveYears: `${posYears}/${nYears}`,
      ...yearly,
    };
  });
}

function main() {
  const all = loadTimeframe('1d-long').filter((c) => c.timestamp >= ymd(2013));
  const variants = [
    { label: 'buyAndHold', rule: 'buyAndHold', params: {} },
    {
      label: 'trend: ensemble sma40-75',
      rule: 'ensemble',
      params: { members: [40, 50, 60, 75].map((d) => ({ rule: 'smaTrend', params: { days: d } })) },
    },
    ...[0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5].map((dip) => ({
      label: `dipBuy ${dip * 100}% below 200d, sell at 200d`,
      rule: 'dipBuy',
      params: { days: 200, dip },
    })),
    ...[0.1, 0.2, 0.3].map((dip) => ({
      label: `dipBuy ${dip * 100}% below 200d, sell 20% above 200d`,
      rule: 'dipBuy',
      params: { days: 200, dip, exitAbove: 0.2 },
    })),
    ...[0.2, 0.3].map((dip) => ({
      label: `dipBuy ${dip * 100}% below 200d, sell at 200d or 90 days`,
      rule: 'dipBuy',
      params: { days: 200, dip, maxHoldDays: 90 },
    })),
    ...[0.1, 0.2].map((dip) => ({
      label: `dipBuy ${dip * 100}% below 100d, sell at 100d`,
      rule: 'dipBuy',
      params: { days: 100, dip },
    })),
  ];
  const report = ['# Contrarian dip-buy test\n'];
  report.push(
    'Buy when close is X% below the 200-day SMA; sell when close is back at/above the SMA (or variant). Long only, 15 bps/side, daily Bitstamp BTC/USD, SMAs warmed up from 2013.\n'
  );
  for (const [title, from] of [
    ['2014-2026', ymd(2014)],
    ['2023-2026', ymd(2023)],
  ]) {
    report.push(`## ${title}\n`, mdTable(evaluate(all, from, variants)), '');
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, 'DIP_BUY.md'), report.join('\n') + '\n');
  console.log(report.join('\n'));
}

main();
