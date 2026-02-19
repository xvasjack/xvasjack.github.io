'use strict';

const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_BASE = path.join(PROJECT_ROOT, 'reports', 'phase-runs');

/**
 * Build the directory path for a specific attempt's artifacts.
 * Pattern: reports/phase-runs/<runId>/stages/<stage>/attempt-<n>/
 */
function attemptDir(runId, stage, attempt) {
  return path.join(RUNS_BASE, runId, 'stages', stage, `attempt-${attempt}`);
}

/**
 * Build the full path for a specific artifact file.
 */
function artifactPath(runId, stage, attempt, filename) {
  return path.join(attemptDir(runId, stage, attempt), filename);
}

/**
 * Build the relative path (from project root) for storage in DB.
 */
function artifactRelPath(runId, stage, attempt, filename) {
  return path.relative(PROJECT_ROOT, artifactPath(runId, stage, attempt, filename));
}

/**
 * Standard artifact filenames.
 */
const ARTIFACT_FILES = {
  OUTPUT_JSON: 'output.json',
  OUTPUT_MD: 'output.md',
  META_JSON: 'meta.json',
  ERROR_JSON: 'error.json',
  EVENTS_NDJSON: 'events.ndjson',
};

module.exports = {
  PROJECT_ROOT,
  RUNS_BASE,
  attemptDir,
  artifactPath,
  artifactRelPath,
  ARTIFACT_FILES,
};
