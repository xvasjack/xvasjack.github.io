'use strict';

const crypto = require('node:crypto');
const { isValidStage, STAGE_ORDER } = require('./stage-order');

/**
 * Default values for optional CLI arguments.
 */
const DEFAULTS = Object.freeze({
  strictTemplate: true,
  attemptsPerStage: 1,
});

/**
 * Parse raw argv (process.argv.slice(2)) into a key-value map.
 * Supports: --key=value, --key value, --flag (boolean true)
 */
function parseRawArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[arg.slice(2)] = argv[++i];
    } else {
      out[arg.slice(2)] = 'true';
    }
  }
  return out;
}

/**
 * Generate a unique run ID.
 */
function generateRunId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `run-${ts}-${rand}`;
}

/**
 * Parse and validate phase-run CLI arguments.
 *
 * Required: --run-id, --through
 * Required for NEW runs: --country, --industry
 * Optional: --client-context, --strict-template, --attempts-per-stage
 *
 * Returns { valid: true, args } or { valid: false, errors }.
 */
function parsePhaseRunArgs(argv) {
  const raw = parseRawArgs(argv);
  const errors = [];

  if (raw.help !== undefined) {
    return { valid: false, help: true, errors: [] };
  }

  // Required fields
  const runId = raw['run-id'];
  const through = raw.through;

  if (!runId) errors.push('Missing required: --run-id');
  if (!through) errors.push('Missing required: --through');

  if (through && !isValidStage(through)) {
    errors.push(`Invalid --through stage: "${through}". Valid stages: ${STAGE_ORDER.join(', ')}`);
  }

  // Country/industry are optional at parse time (runner validates at runtime)
  const country = raw.country || null;
  const industry = raw.industry || null;

  const strictTemplateRaw = raw['strict-template'];
  let strictTemplate = DEFAULTS.strictTemplate;
  if (strictTemplateRaw !== undefined) {
    strictTemplate = !['false', '0', 'no', 'off'].includes(strictTemplateRaw.toLowerCase());
  }

  const attemptsRaw = raw['attempts-per-stage'];
  let attemptsPerStage = DEFAULTS.attemptsPerStage;
  if (attemptsRaw !== undefined) {
    const parsed = parseInt(attemptsRaw, 10);
    if (isNaN(parsed) || parsed < 1) {
      errors.push(`--attempts-per-stage must be a positive integer, got "${attemptsRaw}"`);
    } else {
      attemptsPerStage = parsed;
    }
  }

  const clientContext = raw['client-context'] || null;
  const dbPath = raw['db-path'] || null;

  if (errors.length > 0) {
    return { valid: false, help: false, errors };
  }

  return {
    valid: true,
    help: false,
    errors: [],
    args: {
      runId,
      country,
      industry,
      through,
      clientContext,
      strictTemplate,
      attemptsPerStage,
      dbPath,
    },
  };
}

/**
 * Build help text for phase-run CLI.
 */
function phaseRunHelp() {
  return `Usage: npm run phase:run -- --run-id <ID> --through <STAGE> [options]

Required:
  --run-id              Unique run identifier (e.g. vn-es-001)
  --through             Run through this stage (inclusive). Valid: ${STAGE_ORDER.join(', ')}

Required for NEW runs:
  --country             Target country (e.g. "Vietnam")
  --industry            Target industry (e.g. "Energy Services")

Optional:
  --client-context      Freeform client context string
  --strict-template     Strict template mode (default: true)
  --attempts-per-stage  Max attempts per stage, fail-fast=1 (default: 1)
  --db-path             Custom SQLite database path
  --help                Show this help message

Examples:
  npm run phase:run -- --run-id vn-es-001 --country Vietnam --industry "Energy Services" --through 2
  npm run phase:run -- --run-id vn-es-001 --through 2a
  npm run phase:run -- --run-id vn-es-001 --through 9`;
}

module.exports = {
  DEFAULTS,
  parseRawArgs,
  generateRunId,
  parsePhaseRunArgs,
  phaseRunHelp,
};
