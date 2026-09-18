const path = require('path');
const fs = require('fs');
const {
  RULES,
  momentum,
  meanReversion,
  breakout,
  buyAndHold,
  indicators,
} = require('../jev-lite/rules');
const { runBacktest, loadCandles, DATA_FILES } = require('../jev-lite/backtest');

function mk(closes) {
  return closes.map((c, i) => ({
    timestamp: 1672531200 + i * 3600,
    open: c,
    high: c * 1.001,
    low: c * 0.999,
    close: c,
    volume: 1,
  }));
}

describe('jev-lite indicators', () => {
  test('sma', () => {
    const s = indicators.sma([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(s[1])).toBe(true);
    expect(s[2]).toBe(2);
    expect(s[4]).toBe(4);
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
});

describe('jev-lite rules', () => {
  const up = mk(Array.from({ length: 200 }, (_, i) => 100 + i));
  const down = mk(Array.from({ length: 200 }, (_, i) => 300 - i));

  test('every rule returns one position per candle, values 0/1', () => {
    for (const [name, rule] of Object.entries(RULES)) {
      const pos = rule(up);
      expect(pos.length).toBe(up.length);
      for (const p of pos) expect([0, 1]).toContain(p);
      expect(name).toBeTruthy();
    }
  });

  test('momentum long in uptrend, flat in downtrend', () => {
    expect(momentum(up)[199]).toBe(1);
    expect(momentum(down)[199]).toBe(0);
    expect(() => momentum(up, { fast: 50, slow: 20 })).toThrow();
  });

  test('meanReversion enters after sharp drop and exits after recovery', () => {
    const closes = Array(40).fill(100);
    for (let i = 0; i < 40; i++) closes[i] += Math.sin(i) * 0.5; // small noise so sd > 0
    closes.push(90); // crash: z << -2
    const c = mk(closes);
    const pos = meanReversion(c, { period: 20 });
    expect(pos[40]).toBe(1);
    // recover above the mean -> exit
    const rec = mk([...closes, 100, 100, 101]);
    expect(meanReversion(rec, { period: 20 })[rec.length - 1]).toBe(0);
  });

  test('breakout enters on new high and exits on new low', () => {
    const closes = Array(60).fill(100);
    closes.push(110); // breaks 55-bar high
    const c = mk(closes);
    expect(breakout(c)[60]).toBe(1);
    const after = [...closes, ...Array(21).fill(110), 80];
    const pos = breakout(mk(after));
    expect(pos[pos.length - 2]).toBe(1);
    expect(pos[pos.length - 1]).toBe(0);
  });

  test('buyAndHold always long', () => {
    expect(Array.from(buyAndHold(up)).every((p) => p === 1)).toBe(true);
  });
});

describe('jev-lite backtest engine', () => {
  test('buyAndHold with zero cost matches raw price move', () => {
    const c = mk([100, 110, 121, 133.1]);
    const { metrics, trades } = runBacktest(c, buyAndHold, { feeBps: 0, slippageBps: 0 });
    // enters at open[1]=110, exits at close[3]=133.1
    expect(metrics.totalReturn).toBeCloseTo(133.1 / 110 - 1, 6);
    expect(trades).toHaveLength(1);
    expect(metrics.exposure).toBe(1);
    expect(metrics.maxDrawdown).toBe(0);
  });

  test('costs are charged on entry and exit', () => {
    const c = mk([100, 100, 100, 100]);
    const { metrics } = runBacktest(c, buyAndHold, { feeBps: 10, slippageBps: 0 });
    expect(metrics.totalReturn).toBeCloseTo(0.999 * 0.999 - 1, 3); // metrics rounded to 4dp
    expect(metrics.sharpe).toBeLessThan(0);
  });

  test('flat rule has zero return and no trades', () => {
    const c = mk([100, 120, 80, 150]);
    const flat = (cs) => new Int8Array(cs.length);
    const { metrics, trades } = runBacktest(c, flat, {});
    expect(metrics.totalReturn).toBe(0);
    expect(trades).toHaveLength(0);
    expect(metrics.winRate).toBeNull();
  });

  test('position decided at bar i executes at bar i+1 open (no lookahead)', () => {
    const c = mk([100, 100, 200, 200, 200]);
    // long only at index 1 -> enter open[2]=200, exit open[3]=200 -> zero pnl
    const rule = (cs) => Int8Array.from(cs.map((_, i) => (i === 1 ? 1 : 0)));
    const { trades } = runBacktest(c, rule, { feeBps: 0, slippageBps: 0 });
    expect(trades).toHaveLength(1);
    expect(trades[0].entryPx).toBe(200);
    expect(trades[0].pnlPct).toBeCloseTo(0, 10);
  });

  test('rejects wrong-length rule output', () => {
    const c = mk([1, 2, 3, 4]);
    expect(() => runBacktest(c, () => new Int8Array(2))).toThrow();
  });
});

describe('jev-lite data files', () => {
  test.each(Object.entries(DATA_FILES))(
    '%s candles are contiguous 2023-01-01 onward',
    (tf, file) => {
      const p = path.join(__dirname, '..', 'jev-lite', 'data', file);
      expect(fs.existsSync(p)).toBe(true);
      const candles = loadCandles(p);
      const step = tf === '1h' ? 3600 : 900;
      expect(candles[0].timestamp).toBe(Date.UTC(2023, 0, 1) / 1000);
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
});
