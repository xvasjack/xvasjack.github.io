#!/usr/bin/env node
'use strict';

/**
 * phase-status — Show the status of a pipeline run.
 *
 * Usage:
 *   node scripts/phase-status.js --run-id=run-abc123
 *   node scripts/phase-status.js --run-id=run-abc123 --json
 */

const { parseRawArgs } = require('../phase-tracker/core/args');

const HELP = `Usage: node scripts/phase-status.js --run-id=<id> [--json]

Required:
  --run-id    The run ID to inspect

Optional:
  --json      Output raw JSON instead of formatted text
  --help      Show this help message`;

function main() {
  const raw = parseRawArgs(process.argv.slice(2));

  if (raw.help !== undefined) {
    console.log(HELP);
    process.exit(0);
  }

  const runId = raw['run-id'];
  if (!runId) {
    console.error('Error: Missing required --run-id');
    console.error('');
    console.error(HELP);
    process.exit(1);
  }

  const jsonMode = raw.json !== undefined;

  // --- Placeholder: DB lookup will be wired in a later session ---
  const placeholder = {
    runId,
    status: 'not-found',
    message: 'Database not yet wired — run lookup goes here',
    stages: [],
  };

  if (jsonMode) {
    console.log(JSON.stringify(placeholder, null, 2));
  } else {
    console.log(`Run:    ${placeholder.runId}`);
    console.log(`Status: ${placeholder.status}`);
    console.log(`Note:   ${placeholder.message}`);
  }

  process.exit(0);
}

main();
