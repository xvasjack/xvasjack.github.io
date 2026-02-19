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
 * Supports: --key=value, --flag (boolean true)
 */
function parseRawArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq < 0) {
      out[arg.slice(2)] = 'true';
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
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
 * Required: --country, --industry, --through
 * Optional: --run-id, --client-context, --strict-template, --attempts-per-stage
 *
 * Returns { valid: true, args: PhaseRunArgs } or { valid: false, errors: string[] }.
 */
function parsePhaseRunArgs(argv) {
  const raw = parseRawArgs(argv);
  const errors = [];

  // Check for --help
  if (raw.help !== undefined) {
    return { valid: false, help: true, errors: [] };
  }

  // Required fields
  const country = raw.country;
  const industry = raw.industry;
  const through = raw.through;

  if (!country) errors.push('Missing required: --country');
  if (!industry) errors.push('Missing required: --industry');
  if (!through) errors.push('Missing required: --through');

  // Validate --through stage ID
  if (through && !isValidStage(through)) {
    errors.push(`Invalid --through stage: "${through}". Valid stages: ${STAGE_ORDER.join(', ')}`);
  }

  // Optional fields with defaults
  const runId = raw['run-id'] || generateRunId();

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
    },
  };
}

/**
 * Build help text for phase-run CLI.
 */
function phaseRunHelp() {
  return `Usage: node scripts/phase-run.js --country=<country> --industry=<industry> --through=<stage>

Required:
  --country             Target country (e.g. "Vietnam")
  --industry            Target industry (e.g. "Energy Services")
  --through             Run through this stage (inclusive). Valid: ${STAGE_ORDER.join(', ')}

Optional:
  --run-id              Custom run ID (auto-generated if omitted)
  --client-context      Freeform client context string
  --strict-template     Strict template mode (default: true)
  --attempts-per-stage  Max attempts per stage, fail-fast=1 (default: 1)
  --help                Show this help message`;
}

module.exports = {
  DEFAULTS,
  parseRawArgs,
  generateRunId,
  parsePhaseRunArgs,
  phaseRunHelp,
};
