#!/usr/bin/env node
'use strict';

const { parseRawArgs } = require('../phase-tracker/core/args');
const { migrate } = require('../phase-tracker/storage/migrate');
const { getRun } = require('../phase-tracker/storage/runs-repo');
const { getCompletedStages, getNextPendingStage } = require('../phase-tracker/core/runner');
const { buildScorecard, formatScorecardTerminal } = require('../phase-tracker/core/scorecard');

const HELP = `Usage: npm run phase:status -- --run-id <ID> [--json] [--db-path <PATH>]

Required:
  --run-id    The run ID to inspect

Optional:
  --json      Output raw JSON instead of formatted text
  --db-path   Custom SQLite database path
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

  const dbPath = raw['db-path'] || undefined;
  const jsonMode = raw.json !== undefined;

  migrate(dbPath);

  const run = getRun(runId, dbPath);
  if (!run) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }

  const completed = getCompletedStages(runId, dbPath);
  const nextPending = getNextPendingStage(runId, dbPath);
  const scorecard = buildScorecard(runId, dbPath);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          run: {
            id: run.id,
            country: run.country,
            industry: run.industry,
            status: run.status,
            targetStage: run.target_stage,
            createdAt: run.created_at,
            updatedAt: run.updated_at,
            finishedAt: run.finished_at,
          },
          completedStages: completed,
          nextPendingStage: nextPending,
          scorecard: scorecard.summary,
          stages: scorecard.stages,
        },
        null,
        2
      )
    );
  } else {
    console.log(`\nRun: ${run.id}`);
    console.log(`Country: ${run.country}`);
    console.log(`Industry: ${run.industry}`);
    console.log(`Status: ${run.status}`);
    console.log(`Target: --through ${run.target_stage}`);
    console.log(`Created: ${run.created_at}`);
    if (run.finished_at) console.log(`Finished: ${run.finished_at}`);
    console.log(`Completed stages: ${completed.length > 0 ? completed.join(', ') : '(none)'}`);
    console.log(`Next pending: ${nextPending || '(all done)'}`);
    console.log(formatScorecardTerminal(scorecard));
  }

  process.exit(0);
}

main();
