'use strict';
/**
 * btc-v1 paper-trading service.
 *
 * Runs the daily job at BTC_RUN_HOUR_UTC:BTC_RUN_MINUTE (default 00:05 UTC),
 * catches up on start if the latest completed daily candle was not processed.
 *
 * Routes:
 *   GET  /health
 *   GET  /api/btc-v1/status     account summary + last signal
 *   GET  /api/btc-v1/signal     live signal (no state change)
 *   POST /api/btc-v1/run        run the job now (header x-run-token = BTC_RUN_TOKEN); body { force }
 *
 * Env: SENDGRID_API_KEY, SENDER_EMAIL, BTC_EMAIL (recipient, default SENDER_EMAIL),
 *      BTC_RUN_TOKEN, BTC_RUN_HOUR_UTC, BTC_RUN_MINUTE, BTC_CATCHUP_ON_START (default 1),
 *      R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME for durable state.
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sharedPath = require('fs').existsSync(`${__dirname}/shared`) ? './shared' : '../shared';
const { securityHeaders, rateLimiter, corsOptions } = require(`${sharedPath}/security`);
const { requestLogger, healthCheck, errorHandler, notFoundHandler } = require(
  `${sharedPath}/middleware`
);
const { setupGlobalErrorHandlers } = require(`${sharedPath}/logging`);
const { sendEmail } = require(`${sharedPath}/email`);
const paper = require('./paper');
const storage = require('./storage');

setupGlobalErrorHandlers();

const PORT = process.env.PORT || 3011;
const RUN_HOUR = Number(process.env.BTC_RUN_HOUR_UTC ?? 0);
const RUN_MINUTE = Number(process.env.BTC_RUN_MINUTE ?? 5);
const RECIPIENT = process.env.BTC_EMAIL || process.env.SENDER_EMAIL;
const RUN_TOKEN = process.env.BTC_RUN_TOKEN;

let running = false;
let lastError = null;
let lastRunAt = null;

async function runOnce({ force = false, email = true } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    const state = (await storage.load()) || paper.newState();
    const candles = await paper.fetchDailyCandles();
    const signal = paper.computeSignal(candles);
    const price = await paper.fetchLastPrice();
    const { traded, skipped } = paper.step(state, signal, price, { force });
    if (skipped) {
      console.log(`[btc-v1] ${skipped} (signal asOf ${signal.asOf})`);
      return { skipped, signal, summary: paper.summary(state, price) };
    }
    const where = await storage.save(state);
    lastRunAt = new Date().toISOString();
    lastError = null;
    const report = paper.formatReport(state, signal, price, traded);
    console.log(`[btc-v1] ${report.subject} (state -> ${where})`);
    if (email && RECIPIENT && process.env.SENDGRID_API_KEY) {
      await sendEmail({
        to: RECIPIENT,
        subject: report.subject,
        html: report.html,
        fromName: 'btc-v1',
      }).catch((e) => console.error('[btc-v1] email failed:', e.message));
    }
    return { traded, signal, summary: paper.summary(state, price), report: report.subject };
  } catch (e) {
    lastError = { at: new Date().toISOString(), message: e.message };
    console.error('[btc-v1] run failed:', e);
    throw e;
  } finally {
    running = false;
  }
}

function msUntilNextRun(now = new Date()) {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RUN_HOUR, RUN_MINUTE, 0)
  );
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function schedule() {
  const ms = msUntilNextRun();
  console.log(`[btc-v1] next run in ${(ms / 3600000).toFixed(2)}h`);
  setTimeout(async () => {
    await runOnce().catch(() => {});
    schedule();
  }, ms).unref();
}

// ---------------------------------------------------------------- app

const app = express();
app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(express.json({ limit: '10kb' }));
app.use(requestLogger);
app.use(rateLimiter);

app.get('/health', healthCheck('btc-v1'));

app.get('/api/btc-v1/status', async (_req, res, next) => {
  try {
    const state = await storage.load();
    if (!state) return res.json({ started: false, storage: storage.backend(), lastError });
    const price = state.history.length ? state.history[state.history.length - 1].price : null;
    res.json({
      started: true,
      storage: storage.backend(),
      summary: price ? paper.summary(state, price) : null,
      lastSignal: state.lastSignal,
      lastTrades: state.trades.slice(-5),
      history: state.history.slice(-60),
      lastRunAt,
      lastError,
    });
  } catch (e) {
    next(e);
  }
});

app.get('/api/btc-v1/signal', async (_req, res, next) => {
  try {
    const candles = await paper.fetchDailyCandles();
    res.json(paper.computeSignal(candles));
  } catch (e) {
    next(e);
  }
});

app.post('/api/btc-v1/run', async (req, res, next) => {
  try {
    if (RUN_TOKEN && req.get('x-run-token') !== RUN_TOKEN) {
      return res.status(401).json({ error: 'bad token' });
    }
    const out = await runOnce({ force: !!(req.body && req.body.force) });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

app.use(notFoundHandler);
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `[btc-v1] listening on ${PORT}, storage=${storage.backend()}, recipient=${RECIPIENT || 'none'}`
    );
    if (process.env.BTC_CATCHUP_ON_START !== '0') {
      runOnce().catch(() => {});
    }
    schedule();
  });
}

module.exports = { app, runOnce, msUntilNextRun };
