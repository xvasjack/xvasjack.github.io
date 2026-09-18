'use strict';
/**
 * Local paper trader. No server, no email, no cloud. State in state/paper-state.json.
 *
 *   node run.js            run once: fetch, signal, rebalance, print
 *   node run.js status     print account
 *   node run.js signal     print today's signal only
 *   node run.js --loop     run now, then every day at 00:05 UTC (keep terminal open), notifies
 *   node run.js --notify   run once + desktop notification (use this from Task Scheduler / cron)
 *   node run.js --force    re-run even if today's candle was already processed
 * Every run appends one line to state/log.txt.
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

/** One-line summary for notifications / log. */
function oneLiner(state, signal, price, traded) {
  const s = paper.summary(state, price);
  const pos = signal.target === 0 ? 'CASH' : `LONG ${Math.round(signal.target * 100)}%`;
  const act = traded ? `${traded.side.toUpperCase()} $${traded.usd}` : 'no trade';
  return `BTC $${Math.round(price)} | ${pos} | ${act} | equity $${s.equity} (${s.returnPct >= 0 ? '+' : ''}${s.returnPct}%) vs hold ${s.buyHoldReturnPct >= 0 ? '+' : ''}${s.buyHoldReturnPct}%`;
}

/** Desktop notification, no dependencies: Windows toast / macOS / Linux notify-send. */
function notify(title, message) {
  const { execFile } = require('child_process');
  const q = (s) => s.replace(/'/g, "''");
  try {
    if (process.platform === 'win32') {
      const ps = `[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);$t=$x.GetElementsByTagName('text');$t.Item(0).AppendChild($x.CreateTextNode('${q(title)}'))|Out-Null;$t.Item(1).AppendChild($x.CreateTextNode('${q(message)}'))|Out-Null;[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('jev-lite').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
      execFile('powershell', ['-NoProfile', '-Command', ps], () => {});
    } else if (process.platform === 'darwin') {
      execFile(
        'osascript',
        ['-e', `display notification "${message}" with title "${title}"`],
        () => {}
      );
    } else {
      execFile('notify-send', [title, message], () => {});
    }
  } catch (_e) {
    // notification is best effort
  }
}

function appendLog(line) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(path.dirname(storage.LOCAL_FILE), 'log.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${new Date().toISOString()}  ${line}\n`);
}

async function runOnce({ force = false, notifyUser = false } = {}) {
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
  const line = oneLiner(state, signal, price, traded);
  appendLog(line);
  if (notifyUser)
    notify(traded ? `jev-lite: ${traded.side.toUpperCase()}` : 'jev-lite: no trade', line);
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
  await runOnce({ notifyUser: true }).catch((e) => {
    console.error('run failed:', e.message);
    notify('jev-lite: run failed', e.message);
  });
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
        : runOnce({ force: a.includes('--force'), notifyUser: a.includes('--notify') });
  job.catch((e) => {
    console.error('failed:', e.message);
    if (a.includes('--notify')) notify('jev-lite: run failed', e.message);
    process.exit(1);
  });
}

module.exports = { textReport, oneLiner, runOnce };
