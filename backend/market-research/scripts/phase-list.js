#!/usr/bin/env node
'use strict';

const { parseRawArgs } = require('../phase-tracker/core/args');
const { migrate } = require('../phase-tracker/storage/migrate');
const { listRuns } = require('../phase-tracker/storage/runs-repo');

const HELP = `Usage: npm run phase:list [--status <STATUS>] [--limit <N>] [--json] [--db-path <PATH>]

Optional:
  --status    Filter by run status (pending, running, completed, failed, cancelled)
  --limit     Max number of runs to show (default: 20)
  --json      Output raw JSON instead of formatted text
  --db-path   Custom SQLite database path
  --help      Show this help message`;

function padRight(str, len) {
  const s = String(str || '');
  return s.length >= len ? s.substring(0, len) : s + ' '.repeat(len - s.length);
}

function main() {
  const raw = parseRawArgs(process.argv.slice(2));

  if (raw.help !== undefined) {
    console.log(HELP);
    process.exit(0);
  }

  const status = raw.status || null;
  const limit = raw.limit ? parseInt(raw.limit, 10) : 20;
  const jsonMode = raw.json !== undefined;
  const dbPath = raw['db-path'] || undefined;

  if (status && !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(status)) {
    console.error(
      `Error: Invalid --status "${status}". Valid: pending, running, completed, failed, cancelled`
    );
    process.exit(1);
  }

  migrate(dbPath);

  const runs = listRuns({ status, limit, dbPath });

  if (jsonMode) {
    console.log(JSON.stringify(runs, null, 2));
    process.exit(0);
  }

  if (runs.length === 0) {
    console.log('No runs found.');
    process.exit(0);
  }

  console.log(
    '\n' +
      padRight('ID', 20) +
      padRight('Country', 16) +
      padRight('Industry', 24) +
      padRight('Status', 12) +
      padRight('Through', 10) +
      'Created'
  );
  console.log('-'.repeat(100));

  for (const r of runs) {
    console.log(
      padRight(r.id, 20) +
        padRight(r.country, 16) +
        padRight(r.industry, 24) +
        padRight(r.status, 12) +
        padRight(r.target_stage || '-', 10) +
        (r.created_at || '-')
    );
  }
  console.log(`\nTotal: ${runs.length} run(s)\n`);

  process.exit(0);
}

main();
