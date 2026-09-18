'use strict';
/**
 * Research report: catalog at several cost levels, parameter sweeps, leverage
 * sweeps, timeframe / day-boundary robustness, walk-forward parameter selection.
 * Writes results/REPORT.md + results/research.json.
 *
 *   node scripts/research.js [--oos 2025-01-01]
 */
const fs = require('fs');
const path = require('path');
const { RULES } = require('../rules');
const { CATALOG } = require('../strategies');
const {
  loadTimeframe,
  resample,
  runBacktest,
  runCatalog,
  segmentMetrics,
  pct,
  num,
  TF_SECONDS,
  DEFAULT_OOS,
} = require('../backtest');

const RESULTS_DIR = path.join(__dirname, '..', 'results');
const args = process.argv.slice(2);
const OOS = args.includes('--oos') ? args[args.indexOf('--oos') + 1] : DEFAULT_OOS;
const COST_LEVELS = [
  { label: '5bps', feeBps: 5, slippageBps: 0 },
  { label: '15bps', feeBps: 10, slippageBps: 5 },
  { label: '30bps', feeBps: 20, slippageBps: 10 },
];
const BASE_COST = COST_LEVELS[1];
const ymd = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;

function row(label, m, extra = {}) {
  return {
    ...extra,
    strategy: label,
    return: pct(m.totalReturn),
    cagr: pct(m.cagr),
    maxDD: pct(m.maxDrawdown),
    sharpe: num(m.sharpe),
    calmar: num(m.calmar),
    trades: m.trades,
    exposure: pct(m.exposure),
    IS_sharpe: num(m.inSample && m.inSample.sharpe),
    OOS_return: pct(m.outOfSample && m.outOfSample.return),
    OOS_sharpe: num(m.outOfSample && m.outOfSample.sharpe),
    OOS_maxDD: pct(m.outOfSample && m.outOfSample.maxDrawdown),
    ...Object.fromEntries(Object.entries(m.yearly).map(([y, v]) => [`Y${y}`, pct(v.return)])),
  };
}

function runOn(candles, ruleName, params, opts = {}) {
  return runBacktest(candles, RULES[ruleName], {
    feeBps: opts.feeBps ?? BASE_COST.feeBps,
    slippageBps: opts.slippageBps ?? BASE_COST.slippageBps,
    oosStart: opts.oosStart || OOS,
    params,
    maxLeverage: opts.maxLeverage,
  });
}

function run(tf, ruleName, params, opts = {}) {
  return runOn(loadTimeframe(tf), ruleName, params, opts).metrics;
}

function sweep(title, tf, ruleName, variants, opts = {}) {
  const rows = variants.map((v) =>
    row(v.label, run(tf, ruleName, v.params, { ...opts, ...v.opts }), { tf })
  );
  return { title, rows };
}

/**
 * Walk-forward: for each test year, pick the variant with the best in-sample score
 * on all data BEFORE that year, then report its return IN that year. Tests whether
 * the parameter could have been chosen in advance.
 */
function walkForward(title, tf, ruleName, variants, years, pickBy = 'sharpe') {
  const candles = loadTimeframe(tf);
  const bpy = (365 * 86400) / TF_SECONDS[tf];
  const runs = variants.map((v) => ({ ...v, res: runOn(candles, ruleName, v.params, v.opts) }));
  const bh = runOn(candles, 'buyAndHold', {}, { feeBps: 0, slippageBps: 0 });
  const rows = [];
  let cum = 1;
  let cumBH = 1;
  let worstDD = 0;
  for (const Y of years) {
    const fitFrom = candles[0].timestamp;
    const fitTo = ymd(Y, 1, 1);
    const testTo = ymd(Y + 1, 1, 1);
    let best = null;
    for (const r of runs) {
      const seg = segmentMetrics(r.res.equity, r.res.returns, candles, fitFrom, fitTo, bpy);
      if (!seg) continue;
      const score = pickBy === 'calmar' ? seg.return / Math.max(seg.maxDrawdown, 0.01) : seg.sharpe;
      if (!best || score > best.score) best = { r, score, seg };
    }
    const test = segmentMetrics(best.r.res.equity, best.r.res.returns, candles, fitTo, testTo, bpy);
    const bhTest = segmentMetrics(bh.equity, bh.returns, candles, fitTo, testTo, bpy);
    cum *= 1 + test.return;
    cumBH *= 1 + bhTest.return;
    worstDD = Math.max(worstDD, test.maxDrawdown);
    rows.push({
      testYear: Y,
      picked: best.r.label,
      fit_sharpe: num(best.seg.sharpe),
      fit_maxDD: pct(best.seg.maxDrawdown),
      test_return: pct(test.return),
      test_sharpe: num(test.sharpe),
      test_maxDD: pct(test.maxDrawdown),
      BH_return: pct(bhTest.return),
      BH_maxDD: pct(bhTest.maxDrawdown),
    });
  }
  rows.push({
    testYear: 'compound',
    picked: '-',
    fit_sharpe: '-',
    fit_maxDD: '-',
    test_return: pct(cum - 1),
    test_sharpe: '-',
    test_maxDD: `worst yr ${pct(worstDD)}`,
    BH_return: pct(cumBH - 1),
    BH_maxDD: '-',
  });
  return { title: `${title} (pick by ${pickBy})`, rows };
}

function mdTable(rows) {
  if (!rows.length) return '_no rows_\n';
  const cols = Object.keys(rows[0]);
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  return [
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${cols.map((c) => esc(r[c] ?? '')).join(' | ')} |`),
  ].join('\n');
}

function main() {
  const report = [];
  const json = { generatedAt: new Date().toISOString(), oosStart: OOS, sections: {} };
  const d1 = loadTimeframe('1d');
  const h1 = loadTimeframe('1h');
  const bh = run('1d', 'buyAndHold', {});

  report.push(`# jev-lite research report\n`);
  report.push(
    `Generated ${json.generatedAt}. Data: Bitstamp BTC/USD ${bh.from} .. ${bh.to} (${d1.length} daily bars, 1d/4h resampled from 1h).`
  );
  report.push(
    `Execution: signal at bar close, fill at next bar open. Costs per side = fee + slippage. Out-of-sample (OOS) = from ${OOS}. IS = before that.`
  );
  report.push(
    `Buy & hold: return ${pct(bh.totalReturn)}, CAGR ${pct(bh.cagr)}, maxDD ${pct(bh.maxDrawdown)}, Sharpe ${num(bh.sharpe)}, OOS return ${pct(bh.outOfSample.return)}.\n`
  );
  report.push(
    `How to read: a strategy is only interesting if OOS_sharpe and Y2025/Y2026 hold up, if neighbouring parameters in the sweeps behave similarly, and if the walk-forward test (parameter chosen using only prior years) still works. Sharpe is annualised from per-bar returns net of costs. Calmar = CAGR / maxDD. Leverage > 1 pays 10%/yr borrow on the part above 1x; liquidation is not modelled.\n`
  );

  // 1. catalog at each cost level
  for (const cost of COST_LEVELS) {
    const res = runCatalog(CATALOG, {
      feeBps: cost.feeBps,
      slippageBps: cost.slippageBps,
      oosStart: OOS,
    });
    res.sort((a, b) => (b.metrics.sharpe ?? -9) - (a.metrics.sharpe ?? -9));
    const rows = res.map((r) => row(r.name, r.metrics, { tf: r.tf }));
    json.sections[`catalog_${cost.label}`] = res.map((r) => ({
      name: r.name,
      tf: r.tf,
      params: r.params,
      maxLeverage: r.maxLeverage,
      metrics: r.metrics,
    }));
    report.push(
      `## Catalog @ ${cost.label} per side (fee ${cost.feeBps} + slip ${cost.slippageBps})\n`
    );
    report.push(mdTable(rows) + '\n');
  }

  // 2. sweeps
  const smaLengths = [10, 15, 20, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300];
  const sweeps = [];
  sweeps.push(
    sweep(
      'smaTrend: SMA length (days), long only, 1d',
      '1d',
      'smaTrend',
      smaLengths.map((d) => ({ label: `smaTrend-${d}d`, params: { days: d } }))
    )
  );
  sweeps.push(
    sweep(
      'smaTrend-50d: hysteresis band',
      '1d',
      'smaTrend',
      [0, 0.005, 0.01, 0.02, 0.03, 0.05].map((b) => ({
        label: `band ${(b * 100).toFixed(1)}%`,
        params: { days: 50, band: b },
      }))
    )
  );
  sweeps.push({
    title: 'smaTrend-50d across timeframes (same 50 calendar days)',
    rows: ['1h', '4h', '1d'].map((tf) =>
      row(`smaTrend-50d (${tf})`, run(tf, 'smaTrend', { days: 50 }), { tf })
    ),
  });
  sweeps.push({
    title: 'smaTrend on daily bars with shifted day boundary (bars close at hh:00 UTC)',
    rows: [].concat(
      ...[50, 60].map((days) =>
        [0, 4, 8, 12, 16, 20].map((h) => {
          const bars = resample(h1, 86400, h * 3600);
          return row(
            `smaTrend-${days}d @ ${String(h).padStart(2, '0')}:00`,
            runOn(bars, 'smaTrend', { days }).metrics,
            { tf: '1d' }
          );
        })
      )
    ),
  });
  sweeps.push(
    sweep(
      'tsmom: lookback (days), long only, 1d',
      '1d',
      'tsmom',
      [10, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300].map((d) => ({
        label: `tsmom-${d}d`,
        params: { lookbackDays: d },
      }))
    )
  );
  sweeps.push(
    sweep(
      'donchian: entry days (exit = entry/2), long only, 1d',
      '1d',
      'donchian',
      [10, 20, 30, 40, 55, 80, 100].map((d) => ({
        label: `donchian-${d}/${Math.round(d / 2)}`,
        params: { entryDays: d, exitDays: Math.round(d / 2) },
      }))
    )
  );
  const emaGrid = [];
  for (const f of [5, 10, 20, 30, 50])
    for (const s of [50, 100, 150, 200])
      if (f < s)
        emaGrid.push({ label: `emaCross-${f}/${s}`, params: { fastDays: f, slowDays: s } });
  sweeps.push(sweep('emaCross: fast/slow grid (days), long only, 1d', '1d', 'emaCross', emaGrid));
  const comboGrid = [];
  for (const s of [50, 100, 150, 200])
    for (const m of [30, 60, 90, 120, 180])
      comboGrid.push({ label: `trendCombo-${s}/${m}`, params: { smaDays: s, momDays: m } });
  sweeps.push(
    sweep('trendCombo: SMA/momentum grid (days), long only, 1d', '1d', 'trendCombo', comboGrid)
  );
  sweeps.push(
    sweep(
      'rsiDip on 4h: entry/exit thresholds',
      '4h',
      'rsiDip',
      [
        [25, 50],
        [30, 55],
        [35, 60],
        [40, 60],
        [30, 70],
      ].map(([e, x]) => ({
        label: `rsiDip-${e}/${x}`,
        params: { rsiBars: 14, entry: e, exit: x, trendDays: 200 },
      }))
    )
  );
  const smaEnsemble = {
    members: [40, 50, 60, 75].map((d) => ({ rule: 'smaTrend', params: { days: d } })),
  };
  sweeps.push(
    sweep(
      'leverage: ensemble of smaTrend 40/50/60/75d x L (10%/yr borrow above 1x)',
      '1d',
      'levered',
      [1, 1.25, 1.5, 2, 2.5, 3].map((L) => ({
        label: `sma40-75 ensemble x${L}`,
        params: { base: 'ensemble', baseParams: smaEnsemble, leverage: L },
        opts: { maxLeverage: L },
      }))
    )
  );
  sweeps.push(
    sweep(
      'leverage: smaTrend-50d x L (10%/yr borrow above 1x)',
      '1d',
      'levered',
      [1, 1.25, 1.5, 2, 2.5, 3].map((L) => ({
        label: `smaTrend-50d x${L}`,
        params: { base: 'smaTrend', baseParams: { days: 50 }, leverage: L },
        opts: { maxLeverage: L },
      }))
    )
  );
  sweeps.push(
    sweep(
      'leverage: ensemble-trend7 x L (10%/yr borrow above 1x)',
      '1d',
      'levered',
      [1, 1.25, 1.5, 2, 2.5, 3].map((L) => ({
        label: `ensemble-trend7 x${L}`,
        params: { base: 'ensemble', leverage: L },
        opts: { maxLeverage: L },
      }))
    )
  );
  sweeps.push(
    sweep(
      'volTarget(sma40-75 ensemble): target vol, cap 2x',
      '1d',
      'volTarget',
      [0.3, 0.4, 0.5, 0.6, 0.8, 1.0].map((tv) => ({
        label: `volTarget ${(tv * 100).toFixed(0)}%`,
        params: { base: 'ensemble', baseParams: smaEnsemble, targetVol: tv, volDays: 20 },
        opts: { maxLeverage: 2 },
      }))
    )
  );
  sweeps.push({
    title: 'OOS start sensitivity: sma40-75 ensemble vs buy & hold',
    rows: ['2024-01-01', '2024-07-01', '2025-01-01', '2025-07-01', '2026-01-01'].map((oos) => {
      const m = runOn(d1, 'ensemble', smaEnsemble, { oosStart: oos }).metrics;
      const b = runOn(d1, 'buyAndHold', {}, { feeBps: 0, slippageBps: 0, oosStart: oos }).metrics;
      return {
        oosStart: oos,
        OOS_return: pct(m.outOfSample.return),
        OOS_sharpe: num(m.outOfSample.sharpe),
        OOS_maxDD: pct(m.outOfSample.maxDrawdown),
        BH_OOS_return: pct(b.outOfSample.return),
        BH_OOS_maxDD: pct(b.outOfSample.maxDrawdown),
      };
    }),
  });

  report.push(`## Parameter sweeps @ ${BASE_COST.label} per side\n`);
  for (const s of sweeps) {
    report.push(`### ${s.title}\n`);
    report.push(mdTable(s.rows) + '\n');
    json.sections[`sweep:${s.title}`] = s.rows;
  }

  // 3. walk-forward parameter selection
  const wfs = [];
  const years = [2024, 2025, 2026];
  const smaVariants = smaLengths.map((d) => ({ label: `smaTrend-${d}d`, params: { days: d } }));
  wfs.push(
    walkForward(
      'walk-forward smaTrend length 10..300d',
      '1d',
      'smaTrend',
      smaVariants,
      years,
      'sharpe'
    )
  );
  wfs.push(
    walkForward(
      'walk-forward smaTrend length 10..300d',
      '1d',
      'smaTrend',
      smaVariants,
      years,
      'calmar'
    )
  );
  const tsVariants = [10, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300].map((d) => ({
    label: `tsmom-${d}d`,
    params: { lookbackDays: d },
  }));
  wfs.push(walkForward('walk-forward tsmom lookback', '1d', 'tsmom', tsVariants, years, 'sharpe'));
  wfs.push(
    walkForward('walk-forward trendCombo grid', '1d', 'trendCombo', comboGrid, years, 'sharpe')
  );
  wfs.push(walkForward('walk-forward emaCross grid', '1d', 'emaCross', emaGrid, years, 'sharpe'));
  report.push(`## Walk-forward parameter selection @ ${BASE_COST.label} per side\n`);
  report.push(
    `For each test year the parameter is chosen using ONLY data before that year, then applied to that year. "compound" chains the three test years (2024-2026).\n`
  );
  for (const w of wfs) {
    report.push(`### ${w.title}\n`);
    report.push(mdTable(w.rows) + '\n');
    json.sections[`walkforward:${w.title}`] = w.rows;
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, 'REPORT.md'), report.join('\n') + '\n');
  fs.writeFileSync(path.join(RESULTS_DIR, 'research.json'), JSON.stringify(json, null, 2));
  console.log(report.join('\n'));
  console.log(`\nwrote ${path.join(RESULTS_DIR, 'REPORT.md')}`);
}

main();
