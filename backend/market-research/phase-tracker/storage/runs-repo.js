'use strict';

const crypto = require('node:crypto');
const { openDb, withTransaction } = require('./db');

function now() {
  return new Date().toISOString();
}

function generateRunId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `run-${ts}-${rand}`;
}

/**
 * Create a new run record.
 * @param {object} opts
 * @param {string} opts.industry
 * @param {string} opts.country
 * @param {string} [opts.clientContext] - JSON string
 * @param {string} [opts.targetStage]
 * @param {string} [opts.id] - custom runId (auto-generated if omitted)
 * @param {string} [opts.dbPath]
 * @returns {{ id: string }}
 */
function createRun({ industry, country, clientContext, targetStage, id, dbPath } = {}) {
  const db = openDb(dbPath);
  const runId = id || generateRunId();
  const stmt = db.prepare(`
    INSERT INTO runs (id, industry, country, client_context, target_stage, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `);
  const ts = now();
  stmt.run(runId, industry, country, clientContext || null, targetStage || null, ts, ts);
  return { id: runId };
}

/**
 * Get a run by id.
 */
function getRun(runId, dbPath) {
  const db = openDb(dbPath);
  const stmt = db.prepare('SELECT * FROM runs WHERE id = ?');
  return stmt.get(runId) || null;
}

/**
 * List runs, optionally filtered by status.
 * @param {object} [opts]
 * @param {string} [opts.status]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.dbPath]
 */
function listRuns({ status, limit = 50, dbPath } = {}) {
  const db = openDb(dbPath);
  if (status) {
    const stmt = db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC LIMIT ?');
    return stmt.all(status, limit);
  }
  const stmt = db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?');
  return stmt.all(limit);
}

/**
 * Update run status.
 */
function updateRunStatus(runId, status, error, dbPath) {
  const db = openDb(dbPath);
  const ts = now();
  const finishedAt = ['completed', 'failed', 'cancelled'].includes(status) ? ts : null;
  const stmt = db.prepare(`
    UPDATE runs SET status = ?, updated_at = ?, finished_at = COALESCE(?, finished_at), error = COALESCE(?, error)
    WHERE id = ?
  `);
  stmt.run(status, ts, finishedAt, error || null, runId);
}

module.exports = { createRun, getRun, listRuns, updateRunStatus, generateRunId };
