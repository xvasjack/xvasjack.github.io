#!/usr/bin/env node
'use strict';

/**
 * phase-run — Run the market-research pipeline through a target stage and stop.
 *
 * Usage:
 *   node scripts/phase-run.js --country=Vietnam --industry="Energy Services" --through=3
 *   node scripts/phase-run.js --country=Germany --industry=Fintech --through=9 --run-id=run-custom-123
 *
 * See --help for full options.
 */

const { parsePhaseRunArgs, phaseRunHelp } = require('../phase-tracker/core/args');
const { stagesThrough, formatStage } = require('../phase-tracker/core/stage-order');

function main() {
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
  const stages = stagesThrough(args.through);

  console.log(`Run ID:            ${args.runId}`);
  console.log(`Country:           ${args.country}`);
  console.log(`Industry:          ${args.industry}`);
  console.log(`Through:           ${args.through}`);
  console.log(`Strict template:   ${args.strictTemplate}`);
  console.log(`Attempts/stage:    ${args.attemptsPerStage}`);
  if (args.clientContext) {
    console.log(`Client context:    ${args.clientContext}`);
  }
  console.log('');
  console.log(`Stages to execute (${stages.length}):`);
  for (const stageId of stages) {
    console.log(`  ${formatStage(stageId)}`);
  }
  console.log('');

  // --- Placeholder: stage execution will be wired in a later session ---
  for (const stageId of stages) {
    console.log(`[PLACEHOLDER] Stage ${stageId}: not yet wired — service call goes here`);
  }

  console.log('');
  console.log('Done (skeleton only — no stages executed).');
  process.exit(0);
}

main();
