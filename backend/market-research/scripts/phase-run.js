#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { parsePhaseRunArgs, phaseRunHelp } = require('../phase-tracker/core/args');
const { runThrough } = require('../phase-tracker/core/runner');
const { formatStage } = require('../phase-tracker/core/stage-order');

async function main() {
  const result = parsePhaseRunArgs(process.argv.slice(2));

  if (result.help) {
    console.log(phaseRunHelp());
    process.exit(0);
  }

  if (!result.valid) {
    console.error('Error: Invalid arguments');
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    console.error('');
    console.error(phaseRunHelp());
    process.exit(1);
  }

  const { args } = result;

  console.log(`Run ID:            ${args.runId}`);
  console.log(`Through:           ${formatStage(args.through)}`);
  console.log(`Strict template:   ${args.strictTemplate}`);
  if (args.country) console.log(`Country:           ${args.country}`);
  if (args.industry) console.log(`Industry:          ${args.industry}`);
  if (args.clientContext) console.log(`Client context:    ${args.clientContext}`);
  console.log('');

  try {
    const runResult = await runThrough({
      runId: args.runId,
      through: args.through,
      country: args.country,
      industry: args.industry,
      clientContext: args.clientContext,
      strictTemplate: args.strictTemplate,
      dbPath: args.dbPath,
    });

    console.log('\n' + '='.repeat(60));
    console.log(`Run ${runResult.runId}: ${runResult.status}`);
    console.log('='.repeat(60));

    for (const s of runResult.stages) {
      const icon = s.status === 'completed' ? '+' : 'X';
      const duration = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '';
      const gate =
        s.gateResults && typeof s.gateResults.pass === 'boolean'
          ? s.gateResults.pass
            ? 'PASS'
            : 'FAIL'
          : '';
      console.log(
        `  [${icon}] Stage ${s.stage}: ${s.status} ${duration} ${gate}${s.error ? ` -- ${s.error}` : ''}`
      );
    }

    process.exit(runResult.status === 'failed' ? 1 : 0);
  } catch (err) {
    console.error(`\nFatal: ${err.message}`);
    process.exit(1);
  }
}

main();
