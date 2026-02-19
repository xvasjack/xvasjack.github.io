'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { attemptDir, artifactRelPath, ARTIFACT_FILES } = require('./pathing');
const { openDb } = require('../storage/db');

/**
 * Atomically write a file: write to .tmp, then rename.
 * Ensures no partial reads even under concurrent access.
 */
function atomicWriteSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + `.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Write an artifact file and record it in the database.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.stage
 * @param {number} opts.attempt
 * @param {string} opts.filename - one of ARTIFACT_FILES or custom
 * @param {string|object} opts.content - string or object (will be JSON.stringified)
 * @param {string} [opts.contentType='application/json']
 * @param {string} [opts.dbPath]
 */
function writeArtifact({ runId, stage, attempt, filename, content, contentType, dbPath }) {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const filePath = path.join(attemptDir(runId, stage, attempt), filename);
  const relPath = artifactRelPath(runId, stage, attempt, filename);

  // Atomic write to disk
  atomicWriteSync(filePath, serialized);

  // Record in DB
  const db = openDb(dbPath);
  const sizeBytes = Buffer.byteLength(serialized, 'utf-8');
  const ct =
    contentType ||
    (filename.endsWith('.md')
      ? 'text/markdown'
      : filename.endsWith('.ndjson')
        ? 'application/x-ndjson'
        : 'application/json');

  db.prepare(
    `
    INSERT OR REPLACE INTO artifacts (run_id, stage, attempt, filename, path, size_bytes, content_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(runId, stage, attempt, filename, relPath, sizeBytes, ct);

  return { path: filePath, relPath, sizeBytes };
}

/**
 * Append an event line to events.ndjson for the attempt.
 */
function appendEventLine({ runId, stage, attempt, event, dbPath }) {
  const dir = attemptDir(runId, stage, attempt);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, ARTIFACT_FILES.EVENTS_NDJSON);
  const line = (typeof event === 'string' ? event : JSON.stringify(event)) + '\n';
  fs.appendFileSync(filePath, line, 'utf-8');
}

/**
 * Write the standard set of artifacts for a completed stage attempt.
 */
function writeStageArtifacts({ runId, stage, attempt, output, meta, events, dbPath }) {
  const results = {};

  if (output !== undefined) {
    results.outputJson = writeArtifact({
      runId,
      stage,
      attempt,
      filename: ARTIFACT_FILES.OUTPUT_JSON,
      content: output,
      dbPath,
    });
  }

  if (meta !== undefined) {
    results.metaJson = writeArtifact({
      runId,
      stage,
      attempt,
      filename: ARTIFACT_FILES.META_JSON,
      content: meta,
      dbPath,
    });
  }

  if (events && events.length > 0) {
    const ndjson = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    results.eventsNdjson = writeArtifact({
      runId,
      stage,
      attempt,
      filename: ARTIFACT_FILES.EVENTS_NDJSON,
      content: ndjson,
      contentType: 'application/x-ndjson',
      dbPath,
    });
  }

  return results;
}

/**
 * Write error artifact for a failed stage attempt.
 */
function writeErrorArtifact({ runId, stage, attempt, error, dbPath }) {
  const errorObj =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : error;

  return writeArtifact({
    runId,
    stage,
    attempt,
    filename: ARTIFACT_FILES.ERROR_JSON,
    content: errorObj,
    dbPath,
  });
}

/**
 * Save artifact record to the database (for externally-written files).
 */
function saveArtifactRecord({ runId, stage, attempt, filename, filePath, dbPath }) {
  const db = openDb(dbPath);
  const relPath = artifactRelPath(runId, stage, attempt, filename);
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(filePath).size;
  } catch {
    /* file may not exist yet */
  }

  const ct = filename.endsWith('.md')
    ? 'text/markdown'
    : filename.endsWith('.ndjson')
      ? 'application/x-ndjson'
      : 'application/json';

  db.prepare(
    `
    INSERT OR REPLACE INTO artifacts (run_id, stage, attempt, filename, path, size_bytes, content_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(runId, stage, attempt, filename, relPath, sizeBytes, ct);
}

module.exports = {
  atomicWriteSync,
  writeArtifact,
  appendEventLine,
  writeStageArtifacts,
  writeErrorArtifact,
  saveArtifactRecord,
};
