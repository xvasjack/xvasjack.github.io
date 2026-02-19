'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'reports', 'phase-runs', 'phase-tracker.sqlite');

/** @type {Map<string, DatabaseSync>} */
const pool = new Map();

/**
 * Open (or reuse) a SQLite database at the given path.
 * Applies WAL mode and busy timeout for concurrent access.
 */
function openDb(dbPath = DEFAULT_DB_PATH) {
  if (pool.has(dbPath)) return pool.get(dbPath);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');

  pool.set(dbPath, db);
  return db;
}

/**
 * Close a specific database (or all if no path given).
 */
function closeDb(dbPath) {
  if (dbPath) {
    const db = pool.get(dbPath);
    if (db) {
      db.close();
      pool.delete(dbPath);
    }
  } else {
    for (const [p, db] of pool) {
      db.close();
      pool.delete(p);
    }
  }
}

/**
 * Run a function inside a transaction. Rolls back on error.
 */
function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, closeDb, withTransaction, DEFAULT_DB_PATH, PROJECT_ROOT };
