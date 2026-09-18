const paper = require('../jev-lite/paper');

const DAY = 86400;
const T0 = 1672531200; // 2023-01-01

function candles(closes) {
  return closes.map((c, i) => ({
    timestamp: T0 + i * DAY,
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: 1,
  }));
}
const up = candles(Array.from({ length: 120 }, (_, i) => 100 + i));
const down = candles(Array.from({ length: 120 }, (_, i) => 300 - i));

function mockFetch(byUrl) {
  return async (url) => {
    const key = Object.keys(byUrl).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => byUrl[key] };
  };
}

describe('jev-lite paper: signal', () => {
  test('long in uptrend, cash in downtrend, needs 76 candles', () => {
    const s = paper.computeSignal(up);
    expect(s.target).toBe(1);
    expect(s.asOf).toBe(up[119].timestamp);
    expect(s.smas).toHaveLength(4);
    expect(s.smas.every((m) => m.above)).toBe(true);
    expect(paper.computeSignal(down).target).toBe(0);
    expect(() => paper.computeSignal(up.slice(0, 50))).toThrow(/need >= 76/);
  });

  test('fractional target when only some SMAs are below price', () => {
    // flat then a dip: shorter SMAs go above price first
    const c = candles([...Array(100).fill(100), ...Array(20).fill(97)]);
    const s = paper.computeSignal(c);
    expect(s.target).toBeGreaterThanOrEqual(0);
    expect(s.target).toBeLessThanOrEqual(1);
    expect(Number.isInteger(s.target * 4)).toBe(true); // multiples of 0.25
  });
});

describe('jev-lite paper: market data parsing', () => {
  test('fetchDailyCandles drops the in-progress candle and sorts ascending', async () => {
    const now = (T0 + 3 * DAY + 3600) * 1000; // 01:00 UTC on day 3
    const ohlc = [2, 0, 1, 3].map((i) => ({
      timestamp: String(T0 + i * DAY),
      open: '1',
      high: '2',
      low: '0.5',
      close: String(10 + i),
      volume: '5',
    }));
    const fetchImpl = mockFetch({ '/ohlc/': { data: { pair: 'BTC/USD', ohlc } } });
    const out = await paper.fetchDailyCandles({ fetchImpl, now });
    expect(out.map((c) => c.close)).toEqual([10, 11, 12]); // day 3 is in progress
    expect(out[0].timestamp).toBe(T0);
    await expect(paper.fetchDailyCandles({ fetchImpl: mockFetch({}), now })).rejects.toThrow();
  });

  test('fetchLastPrice parses ticker and rejects bad values', async () => {
    expect(
      await paper.fetchLastPrice({ fetchImpl: mockFetch({ '/ticker/': { last: '76354.94' } }) })
    ).toBe(76354.94);
    await expect(
      paper.fetchLastPrice({ fetchImpl: mockFetch({ '/ticker/': { last: 'x' } }) })
    ).rejects.toThrow();
  });
});

describe('jev-lite paper: account', () => {
  const sig = (asOf, target) => ({ asOf, close: 100, target, smas: [], strategy: 's' });
  const cost = paper.COST_BPS / 10000;

  test('buys to target, pays fee, benchmarks buy & hold', () => {
    const st = paper.newState(0);
    const { traded } = paper.step(st, sig(1, 1), 100, { now: 1000 });
    expect(traded.side).toBe('buy');
    expect(st.btc).toBeCloseTo(100, 6); // 10000 / 100
    expect(st.cash).toBeCloseTo(-10000 * cost, 6);
    expect(st.bhBtc).toBeCloseTo((10000 * (1 - cost)) / 100, 8);
    expect(st.history).toHaveLength(1);
    expect(paper.summary(st, 100).returnPct).toBeCloseTo(-cost * 100, 4);
  });

  test('same signal twice is idempotent, force re-runs', () => {
    const st = paper.newState(0);
    paper.step(st, sig(1, 1), 100);
    const r = paper.step(st, sig(1, 1), 110);
    expect(r.skipped).toBe('already processed');
    expect(st.history).toHaveLength(1);
    const f = paper.step(st, sig(1, 1), 110, { force: true });
    expect(f.skipped).toBeNull();
    expect(st.history).toHaveLength(2);
  });

  test('sells to cash on target 0 and tracks equity vs buy & hold', () => {
    const st = paper.newState(0);
    paper.step(st, sig(1, 1), 100);
    const { traded } = paper.step(st, sig(2, 0), 120);
    expect(traded.side).toBe('sell');
    expect(st.btc).toBe(0);
    // 100 BTC sold at 120 = 12000 minus fees on both sides
    expect(st.cash).toBeCloseTo(12000 - 10000 * cost - 12000 * cost, 4);
    const s = paper.summary(st, 60);
    expect(s.equity).toBeCloseTo(st.cash, 2);
    expect(s.buyHoldReturnPct).toBeLessThan(0);
    expect(s.returnPct).toBeGreaterThan(0);
  });

  test('small rebalances below 1% of equity are ignored', () => {
    const st = paper.newState(0);
    paper.step(st, sig(1, 1), 100);
    const { traded } = paper.step(st, sig(2, 0.995), 100);
    expect(traded).toBeNull();
    expect(st.target).toBe(0.995);
  });

  test('report has subject with position, price and both returns', () => {
    const st = paper.newState(0);
    const s = {
      asOf: T0,
      close: 100,
      target: 0.75,
      strategy: 'x',
      smas: [{ days: 40, sma: 95, above: true }],
    };
    const { traded } = paper.step(st, s, 100);
    const r = paper.formatReport(st, s, 100, traded);
    expect(r.subject).toMatch(/LONG 75%/);
    expect(r.subject).toMatch(/\$100/);
    expect(r.subject).toMatch(/B&H/);
    expect(r.html).toMatch(/SMA 40d/);
    expect(r.html).toMatch(/Trade:/);
  });
});

describe('jev-lite paper: replay matches backtest engine', () => {
  test('2025-01-01 onward within 2 percentage points', () => {
    const { replay } = require('../jev-lite/scripts/replay-paper');
    const r = replay({ from: '2025-01-01' });
    expect(Math.abs(r.paperReturnPct - r.backtestReturnPct)).toBeLessThan(2);
    expect(Math.abs(r.paperBuyHoldPct - r.backtestBuyHoldPct)).toBeLessThan(2);
    expect(r.paperTrades).toBeGreaterThan(0);
  });
});

describe('jev-lite local run.js', () => {
  test('text report lists position, SMAs, equity and buy & hold', () => {
    const { textReport } = require('../jev-lite/run');
    const st = paper.newState(0);
    const s = {
      asOf: T0,
      close: 100,
      target: 0.5,
      strategy: 'x',
      smas: [{ days: 40, sma: 95, above: true }],
    };
    const { traded } = paper.step(st, s, 100);
    const txt = textReport(st, s, 100, traded);
    expect(txt).toMatch(/position: LONG 50%/);
    expect(txt).toMatch(/SMA 40d/);
    expect(txt).toMatch(/trade: buy/);
    expect(txt).toMatch(/buy&hold/);
  });
});

describe('jev-lite server', () => {
  test('msUntilNextRun is within 24h and status route works without state', async () => {
    process.env.JEV_STATE_FILE = require('path').join(
      require('os').tmpdir(),
      `jev-${Date.now()}.json`
    );
    const { app, msUntilNextRun } = require('../jev-lite/server');
    const ms = msUntilNextRun(new Date('2026-01-01T00:04:00Z'));
    expect(ms).toBe(60 * 1000);
    expect(msUntilNextRun(new Date('2026-01-01T00:06:00Z'))).toBe((24 * 60 - 1) * 60 * 1000);
    const request = require('supertest');
    const res = await request(app).get('/api/jev-lite/status');
    expect(res.status).toBe(200);
    expect(res.body.started).toBe(false);
    const h = await request(app).get('/health');
    expect(h.body.service).toBe('jev-lite');
  });
});
