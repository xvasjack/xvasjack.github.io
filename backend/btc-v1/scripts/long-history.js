'use strict';
/**
 * Long-history check (daily bars 2013-2026, Bitstamp). Does the 40-75d SMA
 * trend filter found on 2023-2026 also work on earlier cycles?
 * Writes results/LONG_HISTORY.md + results/long-history.json.
 *
 *   node scripts/long-history.js
 */
const fs = require('fs');
const path = require('path');
const { RULES } = require('../rules');
const { loadTimeframe, runBacktest, segmentMetrics, pct, num } = require('../backtest');

const RESULTS_DIR = path.join(__dirname, '..', 'results');
const COST = { feeBps: 10, slippageBps: 5 };
const ymd = (y, m = 1, d = 1) => Date.UTC(y, m - 1, d) / 1000;
const WARMUP_FROM = ymd(2013); // data fed to rules (warmup year)
const REPORT_FROM = ymd(2014); // metrics reported from here
const PERIODS = [
  ['2014-2015 bear', ymd(2014), ymd(2016)],
  ['2016-2017 bull', ymd(2016), ymd(2018)],
  ['2018 bear', ymd(2018), ymd(2019)],
  ['2019-2021 bull', ymd(2019), ymd(2022)],
  ['2022 bear', ymd(2022), ymd(2023)],
  ['2023-2026', ymd(2023), ymd(2027)],
];
const BPY = 365;

function mdTable(rows) {
  if (!rows.length) return '_no rows_\n';
  const cols = Object.keys(rows[0]);
  return [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`),
  ].join('\n');
}

function main() {
  const all = loadTimeframe('1d-long').filter((c) => c.timestamp >= WARMUP_FROM);
  const last = all[all.length - 1].timestamp + 1;
  const run = (rule, params, opts = {}) =>
    runBacktest(all, RULES[rule], { ...COST, params, oosStart: '2023-01-01', ...opts });
  const seg = (r, a, b) => segmentMetrics(r.equity, r.returns, all, a, b, BPY);
  const yearsList = [];
  for (let y = 2014; y <= 2026; y++) yearsList.push(y);

  const variants = [
    { label: 'buyAndHold', rule: 'buyAndHold', params: {} },
    ...[20, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300].map((d) => ({
      label: `smaTrend-${d}d`,
      rule: 'smaTrend',
      params: { days: d },
    })),
    {
      label: 'ensemble sma40-75',
      rule: 'ensemble',
      params: { members: [40, 50, 60, 75].map((d) => ({ rule: 'smaTrend', params: { days: d } })) },
    },
    {
      label: 'ensemble sma40-200',
      rule: 'ensemble',
      params: {
        members: [40, 50, 60, 75, 100, 150, 200].map((d) => ({
          rule: 'smaTrend',
          params: { days: d },
        })),
      },
    },
    { label: 'tsmom-90d', rule: 'tsmom', params: { lookbackDays: 90 } },
    { label: 'tsmom-180d', rule: 'tsmom', params: { lookbackDays: 180 } },
    { label: 'emaCross-50/200', rule: 'emaCross', params: { fastDays: 50, slowDays: 200 } },
    { label: 'donchian-55/20', rule: 'donchian', params: { entryDays: 55, exitDays: 20 } },
  ];
  const runs = variants.map((v) => ({ ...v, res: run(v.rule, v.params) }));

  const json = { generatedAt: new Date().toISOString(), sections: {} };
  const report = [`# btc-v1 long-history check\n`];
  report.push(
    `Daily Bitstamp BTC/USD, rules warmed up from 2013-01-01, metrics reported 2014-01-01 .. ${new Date((last - 1) * 1000).toISOString().slice(0, 10)}. Costs 15 bps/side. Long only, no leverage.\n`
  );

  // 1. full period summary
  const summary = runs.map((r) => {
    const s = seg(r.res, REPORT_FROM, last);
    const years = (last - REPORT_FROM) / (365 * 86400);
    const cagr = Math.pow(1 + s.return, 1 / years) - 1;
    return {
      strategy: r.label,
      return: pct(s.return),
      cagr: pct(cagr),
      maxDD: pct(s.maxDrawdown),
      sharpe: num(s.sharpe),
      calmar: num(s.maxDrawdown > 0 ? cagr / s.maxDrawdown : null),
      trades: r.res.trades.length,
      exposure: pct(r.res.metrics.exposure),
    };
  });
  report.push(`## 2014-2026 full period\n`, mdTable(summary), '');
  json.sections.summary = summary;

  // 2. by market regime
  const regime = runs.map((r) => {
    const row = { strategy: r.label };
    for (const [name, a, b] of PERIODS) {
      const s = seg(r.res, a, b);
      row[name] = s ? `${pct(s.return)} / dd ${pct(s.maxDrawdown)}` : '-';
    }
    return row;
  });
  report.push(`## By regime (return / max drawdown)\n`, mdTable(regime), '');
  json.sections.regime = regime;

  // 3. yearly returns
  const yearly = runs.map((r) => {
    const row = { strategy: r.label };
    let pos = 0;
    for (const y of yearsList) {
      const s = seg(r.res, ymd(y), ymd(y + 1));
      row[`Y${y}`] = s ? pct(s.return) : '-';
      if (s && s.return > 0) pos++;
    }
    row.positive = `${pos}/${yearsList.length}`;
    return row;
  });
  report.push(`## Yearly returns\n`, mdTable(yearly), '');
  json.sections.yearly = yearly;

  // 4. walk-forward on SMA length: pick by Sharpe on all prior years (from 2014), test next year
  const smaRuns = runs.filter((r) => r.rule === 'smaTrend');
  const bh = runs.find((r) => r.label === 'buyAndHold');
  const wf = [];
  let cum = 1;
  let cumBH = 1;
  let worst = 0;
  let worstBH = 0;
  for (let y = 2016; y <= 2026; y++) {
    let best = null;
    for (const r of smaRuns) {
      const s = seg(r.res, REPORT_FROM, ymd(y));
      if (s && (!best || s.sharpe > best.s.sharpe)) best = { r, s };
    }
    const t = seg(best.r.res, ymd(y), ymd(y + 1));
    const b = seg(bh.res, ymd(y), ymd(y + 1));
    cum *= 1 + t.return;
    cumBH *= 1 + b.return;
    worst = Math.max(worst, t.maxDrawdown);
    worstBH = Math.max(worstBH, b.maxDrawdown);
    wf.push({
      testYear: y,
      picked: best.r.label,
      fit_sharpe: num(best.s.sharpe),
      test_return: pct(t.return),
      test_maxDD: pct(t.maxDrawdown),
      BH_return: pct(b.return),
      BH_maxDD: pct(b.maxDrawdown),
    });
  }
  wf.push({
    testYear: 'compound 2016-2026',
    picked: '-',
    fit_sharpe: '-',
    test_return: pct(cum - 1),
    test_maxDD: `worst yr ${pct(worst)}`,
    BH_return: pct(cumBH - 1),
    BH_maxDD: `worst yr ${pct(worstBH)}`,
  });
  report.push(
    `## Walk-forward SMA length (chosen each year by Sharpe on 2014..previous year)\n`,
    mdTable(wf),
    ''
  );
  json.sections.walkForward = wf;

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, 'LONG_HISTORY.md'), report.join('\n') + '\n');
  fs.writeFileSync(path.join(RESULTS_DIR, 'long-history.json'), JSON.stringify(json, null, 2));
  console.log(report.join('\n'));
}

main();
