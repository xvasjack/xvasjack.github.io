'use strict';
/**
 * Strategy catalog run by `node backtest.js`.
 *
 * Parameters are textbook / a-priori values (200d SMA, 50/200 golden cross,
 * Turtle 20/10 and 55/20, 90d TSMOM, 3xATR chandelier). They were NOT fitted
 * to this dataset; see scripts/research.js for parameter sensitivity.
 *
 * entry: { name, tf, rule, params, maxLeverage?, shortFundingApr?, note? }
 */

const CATALOG = [
  // benchmarks
  { name: 'buyAndHold', tf: '1d', rule: 'buyAndHold', params: {} },

  // original bar-based rules (1h), for reference
  { name: 'momentum-20/50 (1h)', tf: '1h', rule: 'momentum', params: { fast: 20, slow: 50 } },
  { name: 'meanReversion-20 (1h)', tf: '1h', rule: 'meanReversion', params: { period: 20 } },
  { name: 'breakout-55/20 (1h)', tf: '1h', rule: 'breakout', params: { entry: 55, exit: 20 } },

  // price vs SMA trend filters
  { name: 'smaTrend-200d', tf: '1d', rule: 'smaTrend', params: { days: 200 } },
  { name: 'smaTrend-100d', tf: '1d', rule: 'smaTrend', params: { days: 100 } },
  { name: 'smaTrend-50d', tf: '1d', rule: 'smaTrend', params: { days: 50 } },
  { name: 'smaTrend-200d-band2%', tf: '1d', rule: 'smaTrend', params: { days: 200, band: 0.02 } },
  { name: 'smaTrend-100d-band2%', tf: '1d', rule: 'smaTrend', params: { days: 100, band: 0.02 } },
  { name: 'smaTrend-100d (4h)', tf: '4h', rule: 'smaTrend', params: { days: 100 } },
  {
    name: 'smaTrend-100d-band2% L/S',
    tf: '1d',
    rule: 'smaTrend',
    params: { days: 100, band: 0.02, short: true },
  },
  { name: 'smaTrend-200d L/S', tf: '1d', rule: 'smaTrend', params: { days: 200, short: true } },

  // EMA crosses
  { name: 'emaCross-50/200', tf: '1d', rule: 'emaCross', params: { fastDays: 50, slowDays: 200 } },
  { name: 'emaCross-20/100', tf: '1d', rule: 'emaCross', params: { fastDays: 20, slowDays: 100 } },
  { name: 'emaCross-10/50', tf: '1d', rule: 'emaCross', params: { fastDays: 10, slowDays: 50 } },
  {
    name: 'emaCross-20/100 L/S',
    tf: '1d',
    rule: 'emaCross',
    params: { fastDays: 20, slowDays: 100, short: true },
  },

  // time-series momentum
  { name: 'tsmom-30d', tf: '1d', rule: 'tsmom', params: { lookbackDays: 30 } },
  { name: 'tsmom-90d', tf: '1d', rule: 'tsmom', params: { lookbackDays: 90 } },
  { name: 'tsmom-180d', tf: '1d', rule: 'tsmom', params: { lookbackDays: 180 } },
  { name: 'tsmom-90d L/S', tf: '1d', rule: 'tsmom', params: { lookbackDays: 90, short: true } },

  // Donchian / Turtle
  { name: 'donchian-20/10', tf: '1d', rule: 'donchian', params: { entryDays: 20, exitDays: 10 } },
  { name: 'donchian-55/20', tf: '1d', rule: 'donchian', params: { entryDays: 55, exitDays: 20 } },
  {
    name: 'donchian-55/20 L/S',
    tf: '1d',
    rule: 'donchian',
    params: { entryDays: 55, exitDays: 20, short: true },
  },
  {
    name: 'chandelier-20d/3ATR',
    tf: '1d',
    rule: 'chandelier',
    params: { entryDays: 20, atrBars: 14, k: 3 },
  },

  // dip buying inside uptrend
  {
    name: 'rsiDip-4h (RSI14<30, >200d)',
    tf: '4h',
    rule: 'rsiDip',
    params: { rsiBars: 14, entry: 30, exit: 55, trendDays: 200 },
  },
  {
    name: 'rsiDip-1d (RSI14<30, >200d)',
    tf: '1d',
    rule: 'rsiDip',
    params: { rsiBars: 14, entry: 30, exit: 55, trendDays: 200 },
  },

  // agreement of trend + momentum
  {
    name: 'trendCombo-200/90',
    tf: '1d',
    rule: 'trendCombo',
    params: { smaDays: 200, momDays: 90 },
  },
  {
    name: 'trendCombo-100/30',
    tf: '1d',
    rule: 'trendCombo',
    params: { smaDays: 100, momDays: 30 },
  },
  {
    name: 'trendCombo-100/30 L/S',
    tf: '1d',
    rule: 'trendCombo',
    params: { smaDays: 100, momDays: 30, short: true },
  },

  // volatility targeting
  {
    name: 'volTarget(smaTrend-100d) 40% 1x',
    tf: '1d',
    rule: 'volTarget',
    params: { base: 'smaTrend', baseParams: { days: 100 }, targetVol: 0.4, volDays: 20 },
    maxLeverage: 1,
  },
  {
    name: 'volTarget(smaTrend-100d) 40% 2x',
    tf: '1d',
    rule: 'volTarget',
    params: { base: 'smaTrend', baseParams: { days: 100 }, targetVol: 0.4, volDays: 20 },
    maxLeverage: 2,
    note: 'uses up to 2x leverage; liquidation not modelled beyond equity<=0',
  },
  {
    name: 'volTarget(buyAndHold) 40% 1x',
    tf: '1d',
    rule: 'volTarget',
    params: { base: 'buyAndHold', targetVol: 0.4, volDays: 20 },
    maxLeverage: 1,
  },

  // ensembles (average of several trend rules -> fractional position, less parameter luck)
  { name: 'ensemble-trend7', tf: '1d', rule: 'ensemble', params: {} },
  {
    name: 'ensemble-sma40-75',
    tf: '1d',
    rule: 'ensemble',
    params: { members: [40, 50, 60, 75].map((d) => ({ rule: 'smaTrend', params: { days: d } })) },
    note: 'average of smaTrend 40/50/60/75d; plateau found in sweep, see results/REPORT.md',
  },
  {
    name: 'ensemble-sma40-75 1.5x',
    tf: '1d',
    rule: 'levered',
    params: {
      base: 'ensemble',
      baseParams: {
        members: [40, 50, 60, 75].map((d) => ({ rule: 'smaTrend', params: { days: d } })),
      },
      leverage: 1.5,
    },
    maxLeverage: 1.5,
    note: 'up to 1.5x, 10%/yr borrow on the part above 1x',
  },
  {
    name: 'ensemble-trend7 1.5x',
    tf: '1d',
    rule: 'levered',
    params: { base: 'ensemble', leverage: 1.5 },
    maxLeverage: 1.5,
    note: 'up to 1.5x, 10%/yr borrow on the part above 1x',
  },

  // constant leverage on a trend filter
  {
    name: 'smaTrend-50d 2x',
    tf: '1d',
    rule: 'levered',
    params: { base: 'smaTrend', baseParams: { days: 50 }, leverage: 2 },
    maxLeverage: 2,
    note: '2x when long, 10%/yr borrow on the part above 1x, liquidation not modelled',
  },
  {
    name: 'trendCombo-200/90 2x',
    tf: '1d',
    rule: 'levered',
    params: { base: 'trendCombo', baseParams: { smaDays: 200, momDays: 90 }, leverage: 2 },
    maxLeverage: 2,
    note: '2x when long, 10%/yr borrow on the part above 1x, liquidation not modelled',
  },
  {
    name: 'volTarget(ensemble) 60% 2x',
    tf: '1d',
    rule: 'volTarget',
    params: { base: 'ensemble', targetVol: 0.6, volDays: 20 },
    maxLeverage: 2,
    note: 'dynamic leverage up to 2x, 10%/yr borrow above 1x',
  },

  // calendar effects (in-sample discoveries, treat with suspicion)
  { name: 'skipFriday', tf: '1d', rule: 'skipDays', params: { days: [5] } },
  { name: 'skipWeekend', tf: '1d', rule: 'skipDays', params: { days: [0, 6] } },
  { name: 'usHours-13-21utc (1h)', tf: '1h', rule: 'hours', params: { from: 13, to: 21 } },
];

module.exports = { CATALOG };
