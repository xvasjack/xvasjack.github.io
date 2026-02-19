#!/usr/bin/env node
'use strict';

/**
 * phase-list — List all known pipeline runs.
 *
 * Usage:
 *   node scripts/phase-list.js
 *   node scripts/phase-list.js --status=completed
 *   node scripts/phase-list.js --limit=10 --json
 */

const { parseRawArgs } = require('../phase-tracker/core/args');

const HELP = `Usage: node scripts/phase-list.js [--status=<status>] [--limit=<n>] [--json]

Optional:
  --status    Filter by run status (pending, running, completed, failed, cancelled)
  --limit     Max number of runs to show (default: 20)
  --json      Output raw JSON instead of formatted text
  --help      Show this help message`;

function main() {
  const raw = parseRawArgs(process.argv.slice(2));

  if (raw.help !== undefined) {
    console.log(HELP);
    process.exit(0);
  }

  const status = raw.status || null;
  const limit = raw.limit ? parseInt(raw.limit, 10) : 20;
  const jsonMode = raw.json !== undefined;

  if (status && !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(status)) {
    console.error(
      `Error: Invalid --status "${status}". Valid: pending, running, completed, failed, cancelled`
    );
    process.exit(1);
  }

  if (isNaN(limit) || limit < 1) {
    console.error('Error: --limit must be a positive integer');
    process.exit(1);
  }

  // --- Placeholder: DB lookup will be wired in a later session ---
  const placeholder = {
    runs: [],
    filter: { status, limit },
    message: 'Database not yet wired — run listing goes here',
  };

  if (jsonMode) {
    console.log(JSON.stringify(placeholder, null, 2));
  } else {
    console.log('Runs: (none — database not yet wired)');
    if (status) console.log(`  Filter: status=${status}`);
    console.log(`  Limit:  ${limit}`);
  }

  process.exit(0);
}

main();
