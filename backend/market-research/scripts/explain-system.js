#!/usr/bin/env node
'use strict';

const path = require('path');
const { SYSTEM_MAP } = require(path.join(__dirname, '..', 'system-map.js'));

function print() {
  console.log('\n=== MARKET RESEARCH SYSTEM (PLAIN ENGLISH) ===\n');
  console.log(`Name: ${SYSTEM_MAP.name}`);
  console.log(`Purpose: ${SYSTEM_MAP.oneLinePurpose}\n`);

  console.log('Priorities:');
  SYSTEM_MAP.priorities.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log('');

  console.log(`Main API endpoint: ${SYSTEM_MAP.mainEndpoint}\n`);

  console.log('Pipeline stages:');
  for (const s of SYSTEM_MAP.stages) {
    console.log(`  ${s.id}. ${s.name}`);
    console.log(`     What it does: ${s.plain}`);
    console.log(`     Main file: ${s.file}`);
  }
  console.log('');

  console.log('Key files:');
  for (const [k, v] of Object.entries(SYSTEM_MAP.keyFiles)) {
    console.log(`  - ${k}: ${v}`);
  }
  console.log('');

  console.log('Common words (plain meaning):');
  for (const [k, v] of Object.entries(SYSTEM_MAP.wordsYouWillSee)) {
    console.log(`  - ${k}: ${v}`);
  }
  console.log('');

  console.log('Default mode:');
  console.log(
    `  CONTENT_FIRST_MODE=${SYSTEM_MAP.defaultMode.contentFirstMode ? 'true' : 'false'}`
  );
  console.log(`  Meaning: ${SYSTEM_MAP.defaultMode.meaning}\n`);

  console.log('Read in this order:');
  SYSTEM_MAP.whereToStartReading.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log('\n==============================================\n');
}

print();

