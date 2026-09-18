'use strict';
/**
 * Local runner. No server, no email, no cloud.
 *
 *   node run.js check      fetch price, POPUP with today's answer (stays until closed). Use this daily.
 *   node run.js            paper account: fetch, signal, rebalance, print (optional)
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

/** One-line summary for notifications / log: which SMAs price is above, and target % in BTC. */
function oneLiner(state, signal, price, traded) {
  const above = signal.smas.filter((m) => m.above).map((m) => `${m.days}d`);
  const n = `${above.length}/${signal.smas.length}`;
  const hits = above.length ? above.join(' ') : 'none';
  const act = traded ? ` | ${traded.side.toUpperCase()} $${traded.usd}` : '';
  return `BTC $${Math.round(price)} | above ${n}: ${hits} | be ${Math.round(signal.target * 100)}% in BTC${act}`;
}

/** Desktop notification, no dependencies: Windows toast / macOS / Linux notify-send. */
function notify(title, message) {
  const { execFile } = require('child_process');
  const q = (s) => s.replace(/'/g, "''");
  try {
    if (process.platform === 'win32') {
      const ps = `[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);$t=$x.GetElementsByTagName('text');$t.Item(0).AppendChild($x.CreateTextNode('${q(title)}'))|Out-Null;$t.Item(1).AppendChild($x.CreateTextNode('${q(message)}'))|Out-Null;[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('btc-v1').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
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
  if (notifyUser) notify(`btc-v1: ${Math.round(signal.target * 100)}% BTC`, line);
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

/** Text for the daily popup. No account, just the rule. */
function checkText(signal, price, now = new Date()) {
  const above = signal.smas.filter((m) => m.above);
  const n = above.length;
  const total = signal.smas.length;
  const lines = [
    `${now.toISOString().slice(0, 10)}   BTC $${Math.round(price).toLocaleString('en-US')}`,
    '',
    `Price is above ${n} of ${total} averages:`,
    ...signal.smas.map(
      (m) =>
        `  ${m.above ? 'YES' : 'no '}  ${m.days}-day avg  $${Math.round(m.sma).toLocaleString('en-US')}`
    ),
    '',
    `=> Be ${Math.round(signal.target * 100)}% in BTC, ${100 - Math.round(signal.target * 100)}% in cash`,
  ];
  return lines.join('\n');
}

/** Popup window that stays until closed (Windows MessageBox / macOS dialog / zenity). */
function popup(title, message) {
  const { execFile } = require('child_process');
  const q = (s) => s.replace(/'/g, "''");
  try {
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${q(message).replace(/\n/g, "'+[char]10+'")}', '${q(title)}') | Out-Null`;
      execFile('powershell', ['-NoProfile', '-Command', ps], () => {});
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', `display dialog "${message}" with title "${title}"`], () => {});
    } else {
      execFile('zenity', ['--info', '--title', title, '--text', message], () => {});
    }
  } catch (_e) {
    // best effort
  }
}

/** Filename that IS the notification, e.g. "2026-09-18  be 75% in BTC  (above 3 of 4).txt" */
function signalFileName(signal, now = new Date()) {
  const n = signal.smas.filter((m) => m.above).length;
  return `${now.toISOString().slice(0, 10)}  be ${Math.round(signal.target * 100)}% in BTC  (above ${n} of ${signal.smas.length}).txt`;
}

/** Write the signal file into Desktop/BTC signal/, keep only the newest `keep` files. */
function writeDesktopFile(signal, text, { dir, now = new Date(), keep = 7 } = {}) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const folder =
    dir || process.env.BTC_DESKTOP_DIR || path.join(os.homedir(), 'Desktop', 'BTC signal');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, signalFileName(signal, now));
  fs.writeFileSync(file, text + '\n');
  const old = fs
    .readdirSync(folder)
    .filter((f) => /^\d{4}-\d{2}-\d{2} {2}be \d+% in BTC {2}\(above \d of \d\)\.txt$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) fs.unlinkSync(path.join(folder, f));
  return file;
}

/** `node run.js check`: fetch, write Desktop file, show popup, log one line. */
async function check() {
  const candles = await paper.fetchDailyCandles();
  const signal = paper.computeSignal(candles);
  const price = await paper.fetchLastPrice();
  const text = checkText(signal, price);
  console.log(text);
  appendLog(
    `check | BTC $${Math.round(price)} | above ${signal.smas.filter((m) => m.above).length}/${signal.smas.length} | be ${Math.round(signal.target * 100)}% in BTC`
  );
  try {
    console.log(`written -> ${writeDesktopFile(signal, text)}`);
  } catch (e) {
    console.error('could not write desktop file:', e.message);
  }
  if (!process.argv.includes('--no-popup')) {
    popup(`btc-v1: be ${Math.round(signal.target * 100)}% in BTC`, text);
  }
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
    notify('btc-v1: run failed', e.message);
  });
  const ms = msUntil0005();
  console.log(`next run in ${(ms / 3600000).toFixed(1)}h`);
  setTimeout(loop, ms);
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const job = a.includes('check')
    ? check()
    : a.includes('status')
      ? status()
      : a.includes('signal')
        ? signalOnly()
        : a.includes('--loop')
          ? loop()
          : runOnce({ force: a.includes('--force'), notifyUser: a.includes('--notify') });
  job.catch((e) => {
    console.error('failed:', e.message);
    if (a.includes('--notify')) notify('btc-v1: run failed', e.message);
    if (a.includes('check')) popup('btc-v1: check failed', `${e.message}\n\nIs the internet on?`);
    process.exit(1);
  });
}

module.exports = { textReport, oneLiner, checkText, signalFileName, writeDesktopFile, runOnce };
