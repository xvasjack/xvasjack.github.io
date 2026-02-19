'use strict';

const crypto = require('node:crypto');
const { openDb } = require('./db');

const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30 seconds

function now() {
  return new Date().toISOString();
}

/**
 * Try to acquire an exclusive lock on a runId.
 * Expired locks are cleaned up automatically.
 *
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.holder] - lock holder identifier
 * @param {number} [opts.ttlMs] - lock TTL in ms (default 5min)
 * @param {string} [opts.dbPath]
 * @returns {{ acquired: boolean, holder: string, lockId: string } | { acquired: false, holder: string }}
 */
function acquireRunLock(runId, { holder, ttlMs = DEFAULT_LOCK_TTL_MS, dbPath } = {}) {
  const db = openDb(dbPath);
  const lockHolder = holder || `worker-${crypto.randomBytes(4).toString('hex')}`;
  const ts = now();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  // Clean up expired locks first
  db.prepare('DELETE FROM run_locks WHERE run_id = ? AND expires_at < ?').run(runId, ts);

  // Check for existing lock
  const existing = db.prepare('SELECT * FROM run_locks WHERE run_id = ?').get(runId);
  if (existing) {
    return { acquired: false, holder: existing.holder };
  }

  // Try to insert lock
  try {
    db.prepare(
      `
      INSERT INTO run_locks (run_id, holder, acquired_at, heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `
    ).run(runId, lockHolder, ts, ts, expiresAt);
    return { acquired: true, holder: lockHolder, lockId: runId };
  } catch (err) {
    // Unique constraint violation — another worker grabbed it
    if (err.message && err.message.includes('UNIQUE')) {
      const current = db.prepare('SELECT holder FROM run_locks WHERE run_id = ?').get(runId);
      return { acquired: false, holder: current ? current.holder : 'unknown' };
    }
    throw err;
  }
}

/**
 * Release the lock on a runId. Only the holder can release.
 * @returns {boolean} true if released
 */
function releaseRunLock(runId, holder, dbPath) {
  const db = openDb(dbPath);
  const result = db
    .prepare('DELETE FROM run_locks WHERE run_id = ? AND holder = ?')
    .run(runId, holder);
  return result.changes > 0;
}

/**
 * Heartbeat to keep the lock alive. Extends expiry.
 * @returns {boolean} true if heartbeat was recorded
 */
function heartbeatRunLock(runId, holder, { ttlMs = DEFAULT_LOCK_TTL_MS, dbPath } = {}) {
  const db = openDb(dbPath);
  const ts = now();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const result = db
    .prepare(
      `
    UPDATE run_locks SET heartbeat_at = ?, expires_at = ?
    WHERE run_id = ? AND holder = ?
  `
    )
    .run(ts, expiresAt, runId, holder);
  return result.changes > 0;
}

/**
 * Check if a run is currently locked.
 */
function isRunLocked(runId, dbPath) {
  const db = openDb(dbPath);
  const ts = now();
  // Clean expired
  db.prepare('DELETE FROM run_locks WHERE run_id = ? AND expires_at < ?').run(runId, ts);
  const lock = db.prepare('SELECT * FROM run_locks WHERE run_id = ?').get(runId);
  return lock || null;
}

/**
 * Force-release all expired locks (maintenance).
 */
function cleanExpiredLocks(dbPath) {
  const db = openDb(dbPath);
  const ts = now();
  const result = db.prepare('DELETE FROM run_locks WHERE expires_at < ?').run(ts);
  return result.changes;
}

module.exports = {
  acquireRunLock,
  releaseRunLock,
  heartbeatRunLock,
  isRunLocked,
  cleanExpiredLocks,
  DEFAULT_LOCK_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
};
