'use strict';
/**
 * Replay the paper trader over historical daily candles and compare with the
 * backtest engine running the same strategy. Guards against a mismatch between
 * the live code path (paper.js) and the research numbers (backtest.js).
 *
 *   node scripts/replay-paper.js [--from 2023-01-01]
 */
const { loadTimeframe, runBacktest } = require('../backtest');
const { RULES } = require('../rules');
const paper = require('../paper');

function replay({ from = '2023-01-01', warmupBars = 200, candles } = {}) {
  const all = candles || loadTimeframe('1d-long');
  const fromTs = Date.parse(from + 'T00:00:00Z') / 1000;
  const start = Math.max(
    warmupBars,
    all.findIndex((c) => c.timestamp >= fromTs)
  );
  const state = paper.newState(all[start].timestamp * 1000);
  // signal from candles[..i] (completed), fill at open of i+1 (like the engine)
  for (let i = start; i < all.length - 1; i++) {
    const window = all.slice(i - warmupBars + 1, i + 1);
    const signal = paper.computeSignal(window);
    paper.step(state, signal, all[i + 1].open, { now: all[i + 1].timestamp * 1000 });
  }
  const lastPx = all[all.length - 1].close;
  const paperSummary = paper.summary(state, lastPx);

  const slice = all.slice(start - warmupBars + 1);
  const bt = runBacktest(slice, RULES.ensemble, {
    feeBps: paper.COST_BPS,
    slippageBps: 0,
    params: {
      members: paper.STRATEGY.members.map((d) => ({ rule: 'smaTrend', params: { days: d } })),
    },
    oosStart: from,
  });
  const btSeg = bt.metrics.outOfSample; // from `from` onward, same span as the paper replay
  return {
    from: new Date(all[start].timestamp * 1000).toISOString().slice(0, 10),
    to: new Date(all[all.length - 1].timestamp * 1000).toISOString().slice(0, 10),
    paperReturnPct: paperSummary.returnPct,
    backtestReturnPct: +(btSeg.return * 100).toFixed(2),
    paperTrades: state.trades.length,
    backtestTrades: bt.trades.length,
    paperBuyHoldPct: paperSummary.buyHoldReturnPct,
    backtestBuyHoldPct: +(btSeg.buyHold * 100).toFixed(2),
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : '2023-01-01';
  console.log(JSON.stringify(replay({ from }), null, 2));
}

module.exports = { replay };
