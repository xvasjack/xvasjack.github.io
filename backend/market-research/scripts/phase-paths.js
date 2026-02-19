#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { parseRawArgs } = require('../phase-tracker/core/args');
const { isValidStage, STAGE_ORDER } = require('../phase-tracker/core/stage-order');
const { attemptDir, RUNS_BASE } = require('../phase-tracker/artifacts/pathing');
const { migrate } = require('../phase-tracker/storage/migrate');
const { getRun } = require('../phase-tracker/storage/runs-repo');

const HELP = `Usage: npm run phase:paths -- --run-id <ID> [--stage <STAGE>] [--json] [--db-path <PATH>]

Required:
  --run-id     The run ID to inspect

Optional:
  --stage      Specific stage to show paths for
  --json       Output raw JSON instead of formatted text
  --db-path    Custom SQLite database path
  --help       Show this help message

Examples:
  npm run phase:paths -- --run-id vn-es-001
  npm run phase:paths -- --run-id vn-es-001 --stage 2a`;

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => {
      const full = path.join(dir, f);
      try {
        const stat = fs.statSync(full);
        return { filename: f, path: full, sizeBytes: stat.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

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

  const stage = raw.stage || null;
  const jsonMode = raw.json !== undefined;
  const dbPath = raw['db-path'] || undefined;

  if (stage && !isValidStage(stage)) {
    console.error(`Error: Invalid --stage "${stage}". Valid: ${STAGE_ORDER.join(', ')}`);
    process.exit(1);
  }

  migrate(dbPath);

  const run = getRun(runId, dbPath);
  if (!run) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }

  const stages = stage ? [stage] : STAGE_ORDER;
  const result = {};

  for (const s of stages) {
    // Check attempt 1 (fail-fast mode only uses attempt 1)
    const dir = attemptDir(runId, s, 1);
    const files = listFiles(dir);
    if (files.length > 0) {
      result[s] = { dir, files };
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({ runId, runsBase: RUNS_BASE, stages: result }, null, 2));
    process.exit(0);
  }

  console.log(`\nRun: ${runId}`);
  console.log(`Base: ${RUNS_BASE}`);
  console.log('');

  const stageKeys = Object.keys(result);
  if (stageKeys.length === 0) {
    console.log('No artifacts found.');
    process.exit(0);
  }

  for (const s of stageKeys) {
    console.log(`Stage ${s}: ${result[s].dir}`);
    for (const f of result[s].files) {
      const sizeKb = (f.sizeBytes / 1024).toFixed(1);
      console.log(`  ${f.filename} (${sizeKb} KB)`);
    }
    console.log('');
  }

  process.exit(0);
}

main();
