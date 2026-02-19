'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * Apply the schema to the database.
 * Safe to call multiple times (CREATE IF NOT EXISTS).
 */
function migrate(dbPath) {
  const db = openDb(dbPath);
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);
  return db;
}

module.exports = { migrate };
