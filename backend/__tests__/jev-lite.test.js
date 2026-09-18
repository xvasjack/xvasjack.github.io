const path = require('path');
const fs = require('fs');
const {
  RULES,
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
  volTarget,
  levered,
  ensemble,
  skipDays,
  hours,
  indicators,
  daysToBars,
} = require('../jev-lite/rules');
const {
  runBacktest,
  runCatalog,
  loadCandles,
  loadTimeframe,
  resample,
  segmentMetrics,
  DATA_FILES,
} = require('../jev-lite/backtest');
const { CATALOG } = require('../jev-lite/strategies');

const T0 = 1672531200; // 2023-01-01 UTC

function mk(closes, step = 3600) {
  return closes.map((c, i) => ({
    timestamp: T0 + i * step,
    open: c,
    high: c * 1.001,
    low: c * 0.999,
    close: c,
    volume: 1,
  }));
}
const daily = (closes) => mk(closes, 86400);
const NOCOST = { feeBps: 0, slippageBps: 0 };

describe('jev-lite indicators', () => {
  test('sma', () => {
    const s = indicators.sma([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(s[1])).toBe(true);
    expect(s[2]).toBe(2);
    expect(s[4]).toBe(4);
  });
  test('ema warms up and tracks constant series', () => {
    const e = indicators.ema([5, 5, 5, 5, 5], 3);
    expect(Number.isNaN(e[1])).toBe(true);
    expect(e[4]).toBeCloseTo(5, 10);
  });
  test('rollingMax / rollingMin', () => {
    const v = [5, 1, 3, 9, 2, 2];
    expect(Array.from(indicators.rollingMax(v, 3)).slice(2)).toEqual([5, 9, 9, 9]);
    expect(Array.from(indicators.rollingMin(v, 3)).slice(2)).toEqual([1, 1, 2, 2]);
  });
  test('rollingStd', () => {
    const sd = indicators.rollingStd([2, 4, 4, 4, 5, 5, 7, 9], 8);
    expect(sd[7]).toBeCloseTo(2, 10);
  });
  test('rsi is 100 on a pure uptrend and 0 on a pure downtrend', () => {
    const up = indicators.rsi(
      Array.from({ length: 30 }, (_, i) => 100 + i),
      14
    );
    const down = indicators.rsi(
      Array.from({ length: 30 }, (_, i) => 100 - i),
      14
    );
    expect(up[29]).toBe(100);
    expect(down[29]).toBeCloseTo(0, 10);
    expect(Number.isNaN(up[5])).toBe(true);
  });
  test('atr equals constant range on flat candles', () => {
    const c = mk(Array(30).fill(100));
    const a = indicators.atr(c, 14);
    expect(a[29]).toBeCloseTo(0.2, 6); // high-low = 100.1 - 99.9
  });
  test('daysToBars converts by bar size', () => {
    const c = daily([1, 2, 3]);
    expect(daysToBars(50, c, {})).toBe(50);
    expect(daysToBars(2, mk([1, 2, 3]), {})).toBe(48);
    expect(daysToBars(2, c, { barSeconds: 14400 })).toBe(12);
  });
});

describe('jev-lite rules', () => {
  const up = mk(Array.from({ length: 200 }, (_, i) => 100 + i));
  const down = mk(Array.from({ length: 200 }, (_, i) => 300 - i));

  test('every rule returns one position per candle within [-1, 1]', () => {
    const c = daily(Array.from({ length: 400 }, (_, i) => 100 + 20 * Math.sin(i / 15) + i / 10));
    for (const [name, rule] of Object.entries(RULES)) {
      const params = name === 'levered' ? { leverage: 1 } : {};
      const pos = rule(c, params);
      expect(pos.length).toBe(c.length);
      for (const p of pos) {
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(-1);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  test('momentum long in uptrend, flat in downtrend', () => {
    expect(momentum(up)[199]).toBe(1);
    expect(momentum(down)[199]).toBe(0);
    expect(() => momentum(up, { fast: 50, slow: 20 })).toThrow();
  });

  test('meanReversion enters after sharp drop and exits after recovery', () => {
    const closes = Array(40).fill(100);
    for (let i = 0; i < 40; i++) closes[i] += Math.sin(i) * 0.5;
    closes.push(90);
    expect(meanReversion(mk(closes), { period: 20 })[40]).toBe(1);
    const rec = mk([...closes, 100, 100, 101]);
    expect(meanReversion(rec, { period: 20 })[rec.length - 1]).toBe(0);
  });

  test('breakout enters on new high and exits on new low', () => {
    const closes = Array(60).fill(100);
    closes.push(110);
    expect(breakout(mk(closes))[60]).toBe(1);
    const pos = breakout(mk([...closes, ...Array(21).fill(110), 80]));
    expect(pos[pos.length - 2]).toBe(1);
    expect(pos[pos.length - 1]).toBe(0);
  });

  test('buyAndHold always long', () => {
    expect(Array.from(buyAndHold(up)).every((p) => p === 1)).toBe(true);
  });

  test('smaTrend: long above SMA, flat/short below, band adds hysteresis', () => {
    const c = daily([...Array(30).fill(100), ...Array(10).fill(110), ...Array(10).fill(90)]);
    const p = smaTrend(c, { days: 10 });
    expect(p[35]).toBe(1);
    expect(p[49]).toBe(0);
    expect(smaTrend(c, { days: 10, short: true })[49]).toBe(-1);
    // close 100.5 vs SMA 100 is inside a 2% band -> keeps previous state (0)
    const flat = daily([...Array(20).fill(100), 100.5]);
    expect(smaTrend(flat, { days: 10, band: 0.02 })[20]).toBe(0);
    expect(smaTrend(flat, { days: 10 })[20]).toBe(1);
  });

  test('emaCross and tsmom follow trend direction', () => {
    const upD = daily(Array.from({ length: 120 }, (_, i) => 100 + i));
    const downD = daily(Array.from({ length: 120 }, (_, i) => 300 - i));
    expect(emaCross(upD, { fastDays: 5, slowDays: 20 })[119]).toBe(1);
    expect(emaCross(downD, { fastDays: 5, slowDays: 20 })[119]).toBe(0);
    expect(emaCross(downD, { fastDays: 5, slowDays: 20, short: true })[119]).toBe(-1);
    expect(() => emaCross(upD, { fastDays: 20, slowDays: 5 })).toThrow();
    expect(tsmom(upD, { lookbackDays: 30 })[119]).toBe(1);
    expect(tsmom(upD, { lookbackDays: 30 })[10]).toBe(0); // warmup
    expect(tsmom(downD, { lookbackDays: 30, short: true })[119]).toBe(-1);
  });

  test('donchian long/short entries and exits', () => {
    const closes = [...Array(30).fill(100), 110, ...Array(12).fill(110), 80, ...Array(5).fill(80)];
    const c = daily(closes);
    const p = donchian(c, { entryDays: 20, exitDays: 10, short: true });
    expect(p[30]).toBe(1); // breaks 20d high
    expect(p[43]).toBe(-1); // 80 < prior 20d low (99.9) after exiting long
    const longOnly = donchian(c, { entryDays: 20, exitDays: 10 });
    expect(longOnly[43]).toBe(0);
  });

  test('chandelier exits when price falls k*ATR below the peak', () => {
    const closes = [...Array(30).fill(100), 110, 112, 114, 100, 100];
    const p = chandelier(daily(closes), { entryDays: 20, atrBars: 5, k: 3 });
    expect(p[30]).toBe(1);
    expect(p[32]).toBe(1);
    expect(p[33]).toBe(0);
  });

  test('rsiDip only buys dips inside an uptrend', () => {
    // long uptrend then an 8-bar pullback that stays above the 40d SMA (RSI5 < 30 from bar 6)
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
    closes.push(216, 214, 212, 210, 208, 206, 204, 202);
    const c = daily(closes);
    const p = rsiDip(c, { rsiBars: 5, entry: 30, exit: 55, trendDays: 40 });
    expect(p[64]).toBe(0);
    expect(p[65]).toBe(1);
    expect(p[c.length - 1]).toBe(1);
    // same RSI readings but price below the trend SMA -> no entry
    const bear = daily(Array.from({ length: 68 }, (_, i) => 300 - i * 2));
    expect(
      Array.from(rsiDip(bear, { rsiBars: 5, entry: 30, exit: 55, trendDays: 40 })).every(
        (x) => x === 0
      )
    ).toBe(true);
  });

  test('trendCombo needs both trend and momentum', () => {
    const upD = daily(Array.from({ length: 120 }, (_, i) => 100 + i));
    expect(trendCombo(upD, { smaDays: 20, momDays: 10 })[119]).toBe(1);
    const downD = daily(Array.from({ length: 120 }, (_, i) => 300 - i));
    expect(trendCombo(downD, { smaDays: 20, momDays: 10 })[119]).toBe(0);
    expect(trendCombo(downD, { smaDays: 20, momDays: 10, short: true })[119]).toBe(-1);
  });

  test('ensemble averages member positions', () => {
    const c = daily(Array.from({ length: 120 }, (_, i) => 100 + i));
    const p = ensemble(c, {
      members: [
        { rule: 'buyAndHold', params: {} },
        { rule: 'smaTrend', params: { days: 200 } }, // never warms up -> 0
      ],
    });
    expect(p[119]).toBeCloseTo(0.5, 10);
    expect(() => ensemble(c, { members: [{ rule: 'nope' }] })).toThrow();
  });

  test('levered multiplies, volTarget scales by realised vol and caps', () => {
    const c = daily(Array.from({ length: 120 }, (_, i) => 100 + i));
    expect(levered(c, { base: 'buyAndHold', leverage: 2 })[100]).toBe(2);
    const vt = volTarget(c, { base: 'buyAndHold', targetVol: 0.5, volDays: 20, maxLeverage: 1.5 });
    for (let i = 30; i < 120; i++) {
      expect(vt[i]).toBeGreaterThan(0);
      expect(vt[i]).toBeLessThanOrEqual(1.5);
    }
    // constant candles: vol 0 -> falls back to base position
    const flat = daily(Array(40).fill(100));
    expect(volTarget(flat, { base: 'buyAndHold', targetVol: 0.5, volDays: 20 })[39]).toBe(1);
  });

  test('calendar rules use the NEXT bar timestamp', () => {
    // T0 = Sunday 2023-01-01. Daily bars: index i is day i.
    const c = daily(Array(14).fill(100));
    const p = skipDays(c, { days: [5] }); // Friday
    // position at index i applies to bar i+1; Friday is index 5 -> pos[4] = 0
    expect(p[4]).toBe(0);
    expect(p[5]).toBe(1);
    const h = mk(Array(48).fill(100));
    const ph = hours(h, { from: 13, to: 15 });
    expect(ph[12]).toBe(1); // next bar is 13:00
    expect(ph[14]).toBe(0); // next bar is 15:00
    expect(hours(h, { from: 22, to: 2 })[23]).toBe(1); // wraps midnight
  });
});

describe('jev-lite backtest engine', () => {
  test('buyAndHold with zero cost matches raw price move', () => {
    const c = mk([100, 110, 121, 133.1]);
    const { metrics, trades } = runBacktest(c, buyAndHold, NOCOST);
    expect(metrics.totalReturn).toBeCloseTo(133.1 / 110 - 1, 6);
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('long');
    expect(metrics.exposure).toBe(1);
    expect(metrics.maxDrawdown).toBe(0);
  });

  test('costs are charged on entry and exit and reduce Sharpe', () => {
    const c = mk([100, 100, 100, 100]);
    const { metrics } = runBacktest(c, buyAndHold, { feeBps: 10, slippageBps: 0 });
    expect(metrics.totalReturn).toBeCloseTo(0.999 * 0.999 - 1, 3);
    expect(metrics.sharpe).toBeLessThan(0);
  });

  test('flat rule has zero return and no trades', () => {
    const c = mk([100, 120, 80, 150]);
    const { metrics, trades } = runBacktest(c, (cs) => new Int8Array(cs.length), {});
    expect(metrics.totalReturn).toBe(0);
    expect(trades).toHaveLength(0);
    expect(metrics.winRate).toBeNull();
  });

  test('position decided at bar i executes at bar i+1 open (no lookahead)', () => {
    const c = mk([100, 100, 200, 200, 200]);
    const rule = (cs) => Int8Array.from(cs.map((_, i) => (i === 1 ? 1 : 0)));
    const { trades } = runBacktest(c, rule, NOCOST);
    expect(trades).toHaveLength(1);
    expect(trades[0].entryPx).toBe(200);
    expect(trades[0].pnlPct).toBeCloseTo(0, 10);
  });

  test('short position profits from a falling price and pays funding', () => {
    const c = mk([100, 100, 90, 81, 81]);
    const rule = (cs) => Int8Array.from(cs.map((_, i) => (i >= 1 && i <= 2 ? -1 : 0)));
    const { metrics, trades } = runBacktest(c, rule, NOCOST);
    // short from open[2]=90 to open[4]=81 -> +10% on a linear short
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe('short');
    expect(metrics.totalReturn).toBeCloseTo(0.1, 6);
    const funded = runBacktest(c, rule, { ...NOCOST, shortFundingApr: 0.5 });
    expect(funded.metrics.totalReturn).toBeLessThan(0.1);
  });

  test('leverage doubles exposure, is clamped, and pays borrow above 1x', () => {
    const c = mk([100, 100, 110, 110]);
    const two = (cs) => Float64Array.from(cs.map(() => 2));
    const lev = runBacktest(c, two, { ...NOCOST, maxLeverage: 2, borrowApr: 0 });
    expect(lev.metrics.totalReturn).toBeCloseTo(0.2, 6); // enter open[1]=100, 2x on +10%
    const clamped = runBacktest(c, two, { ...NOCOST, maxLeverage: 1, borrowApr: 0 });
    expect(clamped.metrics.totalReturn).toBeCloseTo(0.1, 6);
    const borrow = runBacktest(c, two, { ...NOCOST, maxLeverage: 2, borrowApr: 1 });
    expect(borrow.metrics.totalReturn).toBeLessThan(0.2);
    expect(borrow.metrics.totalReturn).toBeGreaterThan(0.19);
  });

  test('wipeout sets equity to zero and stops trading', () => {
    const c = mk([100, 100, 100, 40, 40, 40]);
    const three = (cs) => Float64Array.from(cs.map(() => 3));
    const r = runBacktest(c, three, { ...NOCOST, maxLeverage: 3, borrowApr: 0 });
    expect(r.wiped).toBe(true);
    expect(r.metrics.totalReturn).toBe(-1);
    expect(r.metrics.maxDrawdown).toBe(1);
    expect(r.equity[r.equity.length - 1]).toBe(0);
  });

  test('fractional position changes do not open new trades', () => {
    const c = mk([100, 100, 100, 100, 100, 100]);
    const rule = (cs) => Float64Array.from(cs.map((_, i) => (i < 4 ? (i % 2 ? 0.5 : 1) : 0)));
    const { trades, metrics } = runBacktest(c, rule, NOCOST);
    expect(trades).toHaveLength(1);
    expect(metrics.turnoverPerYear).toBeGreaterThan(0);
  });

  test('rejects wrong-length rule output', () => {
    expect(() => runBacktest(mk([1, 2, 3, 4]), () => new Int8Array(2))).toThrow();
  });

  test('segment / yearly metrics and IS-OOS split', () => {
    const closes = Array.from({ length: 730 }, (_, i) => 100 * Math.pow(1.001, i));
    const c = daily(closes);
    const r = runBacktest(c, buyAndHold, { ...NOCOST, oosStart: '2024-01-01' });
    expect(Object.keys(r.metrics.yearly)).toEqual(['2023', '2024']);
    expect(r.metrics.inSample.from).toBe('2023-01-01');
    expect(r.metrics.outOfSample.from).toBe('2024-01-01');
    const total = (1 + r.metrics.inSample.return) * (1 + r.metrics.outOfSample.return) - 1;
    expect(total).toBeCloseTo(r.metrics.totalReturn, 3);
    const seg = segmentMetrics(r.equity, r.returns, c, c[10].timestamp, c[20].timestamp, 365);
    expect(seg.bars).toBe(10);
    expect(seg.return).toBeCloseTo(Math.pow(1.001, 10) - 1, 3);
    expect(segmentMetrics(r.equity, r.returns, c, 0, 1, 365)).toBeNull();
  });
});

describe('jev-lite resample', () => {
  test('aggregates 1h into 4h with correct OHLCV and drops partial buckets', () => {
    const c = [];
    for (let i = 0; i < 10; i++) {
      c.push({
        timestamp: T0 + i * 3600,
        open: 100 + i,
        high: 110 + i,
        low: 90 + i,
        close: 101 + i,
        volume: 1,
      });
    }
    const r = resample(c, 14400);
    expect(r).toHaveLength(2); // bars 0-3, 4-7; 8-9 partial dropped
    expect(r[0]).toEqual({ timestamp: T0, open: 100, high: 113, low: 90, close: 104, volume: 4 });
    expect(r[1].open).toBe(104);
    expect(r[1].close).toBe(108);
  });
  test('offset shifts the bucket boundary', () => {
    const c = [];
    for (let i = 0; i < 12; i++) {
      c.push({ timestamp: T0 + i * 3600, open: i, high: i, low: i, close: i, volume: 1 });
    }
    const r = resample(c, 14400, 3600);
    expect(r).toHaveLength(2);
    expect(r[0].timestamp).toBe(T0 + 3600);
    expect(r[0].open).toBe(1);
    expect(r[0].close).toBe(4);
  });
  test('rejects non-multiple sizes', () => {
    expect(() => resample(mk([1, 2, 3]), 5000)).toThrow();
  });
});

describe('jev-lite data files', () => {
  test.each(Object.entries(DATA_FILES))(
    '%s candles are contiguous 2023-01-01 onward',
    (tf, file) => {
      const p = path.join(__dirname, '..', 'jev-lite', 'data', file);
      expect(fs.existsSync(p)).toBe(true);
      const candles = loadCandles(p);
      const step = { '15m': 900, '1h': 3600, '1d-long': 86400 }[tf];
      expect(candles[0].timestamp).toBe(tf === '1d-long' ? Date.UTC(2012, 0, 1) / 1000 : T0);
      expect(candles.length).toBeGreaterThan(10000);
      let gaps = 0;
      let badOhlc = 0;
      for (let i = 1; i < candles.length; i++) {
        if (candles[i].timestamp - candles[i - 1].timestamp !== step) gaps++;
        const x = candles[i];
        if (x.high < Math.max(x.open, x.close) || x.low > Math.min(x.open, x.close)) badOhlc++;
      }
      expect(gaps).toBe(0);
      expect(badOhlc).toBe(0);
    }
  );

  test('1d and 4h resample from 1h and align to UTC midnight', () => {
    const d = loadTimeframe('1d');
    const h4 = loadTimeframe('4h');
    expect(d[0].timestamp).toBe(T0);
    expect(new Date(d[100].timestamp * 1000).getUTCHours()).toBe(0);
    expect(h4.length).toBeGreaterThan(d.length * 5.9);
    expect(d.length).toBeGreaterThan(1300);
  });
});

describe('jev-lite strategy catalog', () => {
  test('every catalog entry runs and produces finite metrics', () => {
    const res = runCatalog(CATALOG, { feeBps: 10, slippageBps: 5 });
    expect(res).toHaveLength(CATALOG.length);
    const names = new Set();
    for (const r of res) {
      expect(names.has(r.name)).toBe(false);
      names.add(r.name);
      expect(Number.isFinite(r.metrics.totalReturn)).toBe(true);
      expect(Number.isFinite(r.metrics.sharpe)).toBe(true);
      expect(r.metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
      expect(r.metrics.maxDrawdown).toBeLessThanOrEqual(1);
      expect(r.metrics.outOfSample).not.toBeNull();
    }
    const bh = res.find((r) => r.name === 'buyAndHold');
    expect(bh.metrics.totalReturn).toBeCloseTo(bh.metrics.buyHoldReturn, 1);
  });
});
