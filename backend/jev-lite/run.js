'use strict';
/**
 * Local paper trader. No server, no email, no cloud. State in state/paper-state.json.
 *
 *   node run.js            run once: fetch, signal, rebalance, print
 *   node run.js status     print account
 *   node run.js signal     print today's signal only
 *   node run.js --loop     run now, then every day at 00:05 UTC (keep terminal open)
 *   node run.js --force    re-run even if today's candle was already processed
 */
const paper = require('./paper');
const storage = require('./storage');

function textReport(state, signal, price, traded) {
  const s = paper.summary(state, price);
  const pos = signal.target === 0 ? 'CASH' : `LONG ${Math.round(signal.target * 100)}%`;
  const lines = [
    `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC  BTC $${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `position: ${pos}`,
    ...signal.smas.map(
      (m) =>
        `  SMA ${m.days}d  $${m.sma.toLocaleString('en-US', { maximumFractionDigits: 0 })}  price ${m.above ? 'above' : 'below'}`
    ),
    traded
      ? `trade: ${traded.side} ${traded.btc} BTC ($${traded.usd}) at $${traded.price}, fee $${traded.fee}`
      : 'trade: none',
    `equity: $${s.equity} (${s.returnPct >= 0 ? '+' : ''}${s.returnPct}%)   buy&hold: $${s.buyHoldEquity} (${s.buyHoldReturnPct >= 0 ? '+' : ''}${s.buyHoldReturnPct}%)`,
    `drawdown: ${s.drawdownPct}%   days: ${s.days}   trades: ${s.trades}`,
  ];
  return lines.join('\n');
}

async function runOnce({ force = false } = {}) {
  const state = (await storage.load()) || paper.newState();
  const candles = await paper.fetchDailyCandles();
  const signal = paper.computeSignal(candles);
  const price = await paper.fetchLastPrice();
  const { traded, skipped } = paper.step(state, signal, price, { force });
  if (skipped) {
    console.log(`already processed today's candle. use --force to redo.\n`);
    console.log(textReport(state, signal, price, null));
    return;
  }
  await storage.save(state);
  console.log(textReport(state, signal, price, traded));
  console.log(`saved -> ${storage.LOCAL_FILE}`);
}

async function status() {
  const state = await storage.load();
  if (!state) return console.log('no state yet. run: node run.js');
  const price = state.history[state.history.length - 1].price;
  console.log(textReport(state, state.lastSignal, price, null));
  console.log(`last run: ${state.lastRun}`);
}

async function signalOnly() {
  const candles = await paper.fetchDailyCandles();
  const s = paper.computeSignal(candles);
  const pos = s.target === 0 ? 'CASH' : `LONG ${Math.round(s.target * 100)}%`;
  console.log(`close $${s.close}  ->  ${pos}`);
  for (const m of s.smas)
    console.log(`  SMA ${m.days}d $${m.sma} price ${m.above ? 'above' : 'below'}`);
}

function msUntil0005() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 5));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

async function loop() {
  await runOnce().catch((e) => console.error('run failed:', e.message));
  const ms = msUntil0005();
  console.log(`next run in ${(ms / 3600000).toFixed(1)}h`);
  setTimeout(loop, ms);
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const job = a.includes('status')
    ? status()
    : a.includes('signal')
      ? signalOnly()
      : a.includes('--loop')
        ? loop()
        : runOnce({ force: a.includes('--force') });
  job.catch((e) => {
    console.error('failed:', e.message);
    process.exit(1);
  });
}

module.exports = { textReport, runOnce };
