'use strict';

/**
 * JSON-schema-style type contracts for the phase-tracker.
 * Used for documentation and runtime validation.
 *
 * These are plain JS objects — no build step, no JSON Schema lib.
 */

/** Valid run statuses */
const RUN_STATUSES = Object.freeze(['pending', 'running', 'completed', 'failed', 'cancelled']);

/** Valid stage attempt statuses */
const ATTEMPT_STATUSES = Object.freeze(['running', 'completed', 'failed', 'skipped']);

/**
 * Shape of a Run record.
 *
 * @typedef {object} Run
 * @property {string}  id             - Unique run identifier (e.g. 'run-m1abc-1f2e3d4a')
 * @property {string}  industry       - Industry being researched
 * @property {string}  country        - Target country
 * @property {string}  [clientContext] - Freeform client context (JSON string)
 * @property {string}  [targetStage]  - Stage to stop at (run-through-and-stop)
 * @property {string}  status         - One of RUN_STATUSES
 * @property {string}  createdAt      - ISO-8601 UTC
 * @property {string}  updatedAt      - ISO-8601 UTC
 * @property {string}  [finishedAt]   - ISO-8601 UTC (set when terminal)
 * @property {object}  [error]        - Error details if failed
 */
const RunSchema = Object.freeze({
  type: 'object',
  required: ['id', 'industry', 'country', 'status', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', pattern: '^run-[a-z0-9]+-[a-f0-9]+$' },
    industry: { type: 'string', minLength: 1 },
    country: { type: 'string', minLength: 1 },
    clientContext: { type: ['string', 'null'] },
    targetStage: { type: ['string', 'null'] },
    status: { type: 'string', enum: RUN_STATUSES },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    finishedAt: { type: ['string', 'null'], format: 'date-time' },
    error: { type: ['object', 'null'] },
  },
});

/**
 * Shape of a StageAttempt record.
 *
 * @typedef {object} StageAttempt
 * @property {number}  id         - Auto-increment PK
 * @property {string}  runId      - Parent run
 * @property {string}  stage      - Stage ID (e.g. '2', '3a')
 * @property {number}  attempt    - 1-indexed attempt number
 * @property {string}  status     - One of ATTEMPT_STATUSES
 * @property {string}  startedAt  - ISO-8601 UTC
 * @property {string}  [finishedAt] - ISO-8601 UTC
 * @property {number}  [durationMs] - Elapsed time
 * @property {string}  [error]    - Error JSON if failed
 */
const StageAttemptSchema = Object.freeze({
  type: 'object',
  required: ['id', 'runId', 'stage', 'attempt', 'status', 'startedAt'],
  properties: {
    id: { type: 'integer' },
    runId: { type: 'string' },
    stage: { type: 'string' },
    attempt: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ATTEMPT_STATUSES },
    startedAt: { type: 'string', format: 'date-time' },
    finishedAt: { type: ['string', 'null'], format: 'date-time' },
    durationMs: { type: ['integer', 'null'] },
    error: { type: ['string', 'null'] },
  },
});

/**
 * Shape of an Artifact Manifest entry.
 *
 * @typedef {object} ArtifactEntry
 * @property {string}  filename    - e.g. 'output.json'
 * @property {string}  path        - Relative path from project root
 * @property {number}  sizeBytes   - File size
 * @property {string}  contentType - MIME type
 * @property {string}  createdAt   - ISO-8601 UTC
 */
const ArtifactEntrySchema = Object.freeze({
  type: 'object',
  required: ['filename', 'path', 'sizeBytes', 'contentType', 'createdAt'],
  properties: {
    filename: { type: 'string' },
    path: { type: 'string' },
    sizeBytes: { type: 'integer', minimum: 0 },
    contentType: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
});

/**
 * Shape of a full Artifact Manifest for a stage attempt.
 *
 * @typedef {object} ArtifactManifest
 * @property {string}          runId
 * @property {string}          stage
 * @property {number}          attempt
 * @property {ArtifactEntry[]} files
 */
const ArtifactManifestSchema = Object.freeze({
  type: 'object',
  required: ['runId', 'stage', 'attempt', 'files'],
  properties: {
    runId: { type: 'string' },
    stage: { type: 'string' },
    attempt: { type: 'integer', minimum: 1 },
    files: { type: 'array', items: ArtifactEntrySchema },
  },
});

/**
 * Shape of CLI args for phase-run.
 *
 * @typedef {object} PhaseRunArgs
 * @property {string}  runId           - Unique run identifier
 * @property {string}  country         - Target country
 * @property {string}  industry        - Target industry
 * @property {string}  through         - Stage to run through (inclusive)
 * @property {string}  [clientContext]  - Freeform client context
 * @property {boolean} strictTemplate  - Whether to enforce strict template mode
 * @property {number}  attemptsPerStage - Max attempts per stage (fail-fast = 1)
 */
const PhaseRunArgsSchema = Object.freeze({
  type: 'object',
  required: ['runId', 'country', 'industry', 'through'],
  properties: {
    runId: { type: 'string', minLength: 1 },
    country: { type: 'string', minLength: 1 },
    industry: { type: 'string', minLength: 1 },
    through: { type: 'string', description: 'Target stage ID to run through' },
    clientContext: { type: ['string', 'null'] },
    strictTemplate: { type: 'boolean', default: true },
    attemptsPerStage: { type: 'integer', minimum: 1, default: 1 },
  },
});

/**
 * Minimal runtime validator — checks required fields and types.
 * Returns { valid: true } or { valid: false, errors: string[] }.
 */
function validateShape(obj, schema) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['Value must be a non-null object'] };
  }

  for (const key of schema.required || []) {
    if (obj[key] === undefined || obj[key] === null) {
      errors.push(`Missing required field: ${key}`);
    }
  }

  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const val = obj[key];
    if (val === undefined || val === null) continue;

    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    const jsType = typeof val;
    const valid = types.some((t) => {
      if (t === 'string') return jsType === 'string';
      if (t === 'integer') return Number.isInteger(val);
      if (t === 'number') return jsType === 'number';
      if (t === 'boolean') return jsType === 'boolean';
      if (t === 'object') return jsType === 'object';
      if (t === 'array') return Array.isArray(val);
      if (t === 'null') return val === null;
      return true;
    });
    if (!valid) {
      errors.push(`Field "${key}" expected type ${types.join('|')}, got ${jsType}`);
    }

    if (spec.enum && !spec.enum.includes(val)) {
      errors.push(`Field "${key}" must be one of [${spec.enum.join(', ')}], got "${val}"`);
    }
    if (spec.minLength && jsType === 'string' && val.length < spec.minLength) {
      errors.push(`Field "${key}" must be at least ${spec.minLength} characters`);
    }
    if (spec.minimum !== undefined && typeof val === 'number' && val < spec.minimum) {
      errors.push(`Field "${key}" must be >= ${spec.minimum}, got ${val}`);
    }
  }

  return errors.length ? { valid: false, errors } : { valid: true };
}

module.exports = {
  RUN_STATUSES,
  ATTEMPT_STATUSES,
  RunSchema,
  StageAttemptSchema,
  ArtifactEntrySchema,
  ArtifactManifestSchema,
  PhaseRunArgsSchema,
  validateShape,
};
