#!/usr/bin/env node
'use strict';

/**
 * phase-paths — Show artifact paths for a run/stage/attempt.
 *
 * Usage:
 *   node scripts/phase-paths.js --run-id=run-abc123
 *   node scripts/phase-paths.js --run-id=run-abc123 --stage=2
 *   node scripts/phase-paths.js --run-id=run-abc123 --stage=2 --attempt=1
 *   node scripts/phase-paths.js --run-id=run-abc123 --json
 */

const { parseRawArgs } = require('../phase-tracker/core/args');
const { isValidStage, STAGE_ORDER } = require('../phase-tracker/core/stage-order');
const { attemptDir, ARTIFACT_FILES, RUNS_BASE } = require('../phase-tracker/artifacts/pathing');

const HELP = `Usage: node scripts/phase-paths.js --run-id=<id> [--stage=<stage>] [--attempt=<n>] [--json]

Required:
  --run-id     The run ID to inspect

Optional:
  --stage      Specific stage to show paths for
  --attempt    Specific attempt number (requires --stage)
  --json       Output raw JSON instead of formatted text
  --help       Show this help message`;

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
  const attempt = raw.attempt ? parseInt(raw.attempt, 10) : null;
  const jsonMode = raw.json !== undefined;

  if (stage && !isValidStage(stage)) {
    console.error(`Error: Invalid --stage "${stage}". Valid: ${STAGE_ORDER.join(', ')}`);
    process.exit(1);
  }

  if (attempt !== null && !stage) {
    console.error('Error: --attempt requires --stage');
    process.exit(1);
  }

  if (attempt !== null && (isNaN(attempt) || attempt < 1)) {
    console.error('Error: --attempt must be a positive integer');
    process.exit(1);
  }

  const result = { runId, runsBase: RUNS_BASE, paths: [] };

  if (stage && attempt) {
    // Single attempt
    const dir = attemptDir(runId, stage, attempt);
    result.paths.push({
      stage,
      attempt,
      dir,
      files: Object.values(ARTIFACT_FILES).map((f) => `${dir}/${f}`),
    });
  } else if (stage) {
    // All attempts for a stage (show template for attempts 1-3)
    for (let a = 1; a <= 3; a++) {
      const dir = attemptDir(runId, stage, a);
      result.paths.push({
        stage,
        attempt: a,
        dir,
        files: Object.values(ARTIFACT_FILES).map((f) => `${dir}/${f}`),
      });
    }
  } else {
    // All stages, attempt 1
    for (const sid of STAGE_ORDER) {
      const dir = attemptDir(runId, sid, 1);
      result.paths.push({
        stage: sid,
        attempt: 1,
        dir,
      });
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Run:  ${runId}`);
    console.log(`Base: ${RUNS_BASE}`);
    console.log('');
    for (const p of result.paths) {
      const label = `Stage ${p.stage}, attempt ${p.attempt}`;
      console.log(`${label}:`);
      console.log(`  dir: ${p.dir}`);
      if (p.files) {
        for (const f of p.files) {
          console.log(`       ${f}`);
        }
      }
    }
  }

  process.exit(0);
}

main();
