'use strict';

const { openDb } = require('./db');

function now() {
  return new Date().toISOString();
}

/**
 * Start a new stage attempt. Returns the attempt record.
 * Auto-increments attempt number for the given run+stage.
 */
function startStageAttempt(runId, stage, dbPath) {
  const db = openDb(dbPath);

  // Determine next attempt number
  const prev = db
    .prepare('SELECT MAX(attempt) as maxAttempt FROM stage_attempts WHERE run_id = ? AND stage = ?')
    .get(runId, stage);
  const attempt = (prev && prev.maxAttempt ? prev.maxAttempt : 0) + 1;

  const ts = now();
  const stmt = db.prepare(`
    INSERT INTO stage_attempts (run_id, stage, attempt, status, started_at)
    VALUES (?, ?, ?, 'running', ?)
  `);
  stmt.run(runId, stage, attempt, ts);

  const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
  return { id, run_id: runId, stage, attempt, status: 'running', started_at: ts };
}

/**
 * Mark a stage attempt as completed.
 */
function finishStageAttempt(runId, stage, attempt, dbPath) {
  const db = openDb(dbPath);
  const ts = now();
  const started = db
    .prepare('SELECT started_at FROM stage_attempts WHERE run_id = ? AND stage = ? AND attempt = ?')
    .get(runId, stage, attempt);

  let durationMs = null;
  if (started && started.started_at) {
    durationMs = Date.now() - new Date(started.started_at).getTime();
  }

  const stmt = db.prepare(`
    UPDATE stage_attempts
    SET status = 'completed', finished_at = ?, duration_ms = ?
    WHERE run_id = ? AND stage = ? AND attempt = ?
  `);
  stmt.run(ts, durationMs, runId, stage, attempt);
}

/**
 * Mark a stage attempt as failed.
 */
function failStageAttempt(runId, stage, attempt, error, dbPath) {
  const db = openDb(dbPath);
  const ts = now();
  const started = db
    .prepare('SELECT started_at FROM stage_attempts WHERE run_id = ? AND stage = ? AND attempt = ?')
    .get(runId, stage, attempt);

  let durationMs = null;
  if (started && started.started_at) {
    durationMs = Date.now() - new Date(started.started_at).getTime();
  }

  const errorJson = typeof error === 'string' ? error : JSON.stringify(error);
  const stmt = db.prepare(`
    UPDATE stage_attempts
    SET status = 'failed', finished_at = ?, duration_ms = ?, error = ?
    WHERE run_id = ? AND stage = ? AND attempt = ?
  `);
  stmt.run(ts, durationMs, errorJson, runId, stage, attempt);
}

/**
 * Get all attempts for a run, optionally filtered by stage.
 */
function getStageAttempts(runId, stage, dbPath) {
  const db = openDb(dbPath);
  if (stage) {
    return db
      .prepare('SELECT * FROM stage_attempts WHERE run_id = ? AND stage = ? ORDER BY attempt')
      .all(runId, stage);
  }
  return db
    .prepare('SELECT * FROM stage_attempts WHERE run_id = ? ORDER BY stage, attempt')
    .all(runId);
}

/**
 * Get the latest attempt for a specific stage.
 */
function getLatestAttempt(runId, stage, dbPath) {
  const db = openDb(dbPath);
  return (
    db
      .prepare(
        'SELECT * FROM stage_attempts WHERE run_id = ? AND stage = ? ORDER BY attempt DESC LIMIT 1'
      )
      .get(runId, stage) || null
  );
}

/**
 * Append an event to the events table.
 */
function appendEvent({ runId, stage, attempt, type, message, data, dbPath }) {
  const db = openDb(dbPath);
  const dataJson = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : null;
  db.prepare(
    `
    INSERT INTO events (run_id, stage, attempt, type, message, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `
  ).run(runId, stage || null, attempt || null, type, message, dataJson);
}

/**
 * Get events for a run, optionally filtered by stage.
 */
function getEvents(runId, { stage, type, dbPath } = {}) {
  const db = openDb(dbPath);
  if (stage && type) {
    return db
      .prepare('SELECT * FROM events WHERE run_id = ? AND stage = ? AND type = ? ORDER BY id')
      .all(runId, stage, type);
  }
  if (stage) {
    return db
      .prepare('SELECT * FROM events WHERE run_id = ? AND stage = ? ORDER BY id')
      .all(runId, stage);
  }
  if (type) {
    return db
      .prepare('SELECT * FROM events WHERE run_id = ? AND type = ? ORDER BY id')
      .all(runId, type);
  }
  return db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id').all(runId);
}

module.exports = {
  startStageAttempt,
  finishStageAttempt,
  failStageAttempt,
  getStageAttempts,
  getLatestAttempt,
  appendEvent,
  getEvents,
};
