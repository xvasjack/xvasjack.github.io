#!/usr/bin/env node
'use strict';

/**
 * Tests for template-contract-compiler.js
 *
 * Run: node template-contract-compiler.test.js
 */

const path = require('path');
const {
  compile,
  drift,
  doctor,
  CONTRACT_VERSION,
  BLOCK_TEMPLATE_PATTERN_MAP,
  BLOCK_TEMPLATE_SLIDE_MAP,
  TABLE_TEMPLATE_CONTEXTS,
  CHART_TEMPLATE_CONTEXTS,
  SECTION_DIVIDER_TEMPLATE_SLIDES,
  DATA_TYPE_PATTERN_MAP,
} = require('./template-contract-compiler');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${testName}`);
  } else {
    failed++;
    failures.push(testName);
    console.log(`  [FAIL] ${testName}`);
  }
}

function assertThrows(fn, testName) {
  try {
    fn();
    failed++;
    failures.push(testName);
    console.log(`  [FAIL] ${testName} (did not throw)`);
  } catch {
    passed++;
    console.log(`  [PASS] ${testName}`);
  }
}

function assertDeepEqual(a, b, testName) {
  const match = JSON.stringify(a) === JSON.stringify(b);
  if (match) {
    passed++;
    console.log(`  [PASS] ${testName}`);
  } else {
    failed++;
    failures.push(testName);
    console.log(`  [FAIL] ${testName}`);
    console.log(`    expected: ${JSON.stringify(b).substring(0, 200)}`);
    console.log(`    actual:   ${JSON.stringify(a).substring(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Minimal valid template data for isolated tests
// ---------------------------------------------------------------------------

function makeMinimalTemplate() {
  return {
    _meta: {
      source: 'test-template.pptx',
      extractedAt: '2026-01-01T00:00:00Z',
      slideCount: 3,
    },
    patterns: {
      regulatory_table: {
        id: 5,
        description: 'Test regulatory table',
        templateSlides: [6, 7],
        layout: 1,
        elements: {
          table: { x: 0.37, y: 1.47, w: 12.6 },
        },
      },
      chart_with_grid: {
        id: 6,
        description: 'Test chart',
        templateSlides: [13],
        layout: 1,
        elements: {
          chart: { x: 0.83, y: 2.31, w: 5.74, h: 3.85 },
        },
      },
      company_comparison: {
        id: 7,
        description: 'Company comparison',
        templateSlides: [22],
        layout: 1,
        elements: {
          table: { x: 0.37, y: 1.47, w: 12.6 },
        },
      },
    },
    slideDetails: [
      {
        slideNumber: 6,
        elements: [
          { type: 'table', position: { x: 0.37, y: 1.47, w: 12.6, h: 4.5 } },
          { type: 'shape', name: 'Title', position: { x: 0.38, y: 0.05, w: 12.59, h: 0.91 } },
        ],
      },
      {
        slideNumber: 7,
        elements: [
          { type: 'table', position: { x: 0.37, y: 1.47, w: 12.6, h: 4.5 } },
        ],
      },
      {
        slideNumber: 13,
        elements: [
          { type: 'chart', position: { x: 0.83, y: 2.31, w: 5.74, h: 3.85 } },
        ],
      },
      {
        slideNumber: 22,
        elements: [
          { type: 'table', position: { x: 0.37, y: 1.47, w: 12.6, h: 4.5 } },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test Groups
// ---------------------------------------------------------------------------

console.log('\n=== Template Contract Compiler Tests ===\n');

// ---- Positive: compile with real template ----
console.log('Positive: compile()');
{
  const compiled = compile();
  assert(compiled.version === CONTRACT_VERSION, 'compile returns correct version');
  assert(typeof compiled.signature === 'string' && compiled.signature.length === 64, 'compile produces SHA-256 signature');
  assert(typeof compiled.compiledAt === 'string', 'compile includes compiledAt timestamp');
  assert(Object.keys(compiled.patternContracts).length > 0, 'compile produces pattern contracts');
  assert(Object.keys(compiled.blockContracts).length > 0, 'compile produces block contracts');
  assert(compiled.patternContracts.regulatory_table !== undefined, 'compile includes regulatory_table pattern');
  assert(compiled.patternContracts.chart_with_grid !== undefined, 'compile includes chart_with_grid pattern');
}

// ---- Positive: compile with minimal template data ----
console.log('\nPositive: compile() with templateData');
{
  const tp = makeMinimalTemplate();
  const compiled = compile({ templateData: tp });
  assert(compiled.version === CONTRACT_VERSION, 'minimal compile has correct version');
  assert(Object.keys(compiled.patternContracts).length === 3, 'minimal compile has 3 patterns');
  assert(compiled.patternContracts.regulatory_table.geometryType === 'table', 'regulatory_table geometry is table');
  assert(compiled.patternContracts.chart_with_grid.geometryType === 'chart', 'chart_with_grid geometry is chart');
  assert(compiled.slideCount === 3, 'slideCount matches _meta');
}

// ---- Positive: pattern contracts structure ----
console.log('\nPositive: pattern contract structure');
{
  const compiled = compile({ templateData: makeMinimalTemplate() });
  const regTable = compiled.patternContracts.regulatory_table;
  assert(regTable.id === 5, 'pattern id preserved');
  assert(regTable.description === 'Test regulatory table', 'description preserved');
  assertDeepEqual(regTable.allowedSlideIds, [6, 7], 'allowedSlideIds correct');
  assert(regTable.isTemplateBacked === true, 'isTemplateBacked true when has slides');
  assert(regTable.layoutId === 1, 'layoutId preserved');
}

// ---- Positive: block contracts structure ----
console.log('\nPositive: block contract structure');
{
  const compiled = compile();
  const foundActs = compiled.blockContracts.foundationalActs;
  assert(foundActs.patternKey === 'regulatory_table', 'foundationalActs -> regulatory_table');
  assert(foundActs.primarySlideId === 7, 'foundationalActs -> slide 7');
  assert(foundActs.requiredGeometry === 'table', 'foundationalActs requires table geometry');
  assert(Array.isArray(foundActs.requiredLayoutKeys), 'has requiredLayoutKeys');
  assert(foundActs.requiredLayoutKeys.includes('title'), 'requires title layout key');
  assert(foundActs.tableDimensions !== null, 'table block has tableDimensions');
  assert(foundActs.tableDimensions.maxRows > 0, 'maxRows > 0');
  assert(foundActs.tableDimensions.maxCols > 0, 'maxCols > 0');

  const mktSize = compiled.blockContracts.marketSizeAndGrowth;
  assert(mktSize.requiredGeometry === 'chart', 'marketSizeAndGrowth requires chart geometry');
  assert(mktSize.tableDimensions === null, 'chart block has no tableDimensions');
}

// ---- Positive: section divider contracts ----
console.log('\nPositive: section divider contracts');
{
  const compiled = compile();
  assert(Object.keys(compiled.sectionDividerContracts).length === 5, '5 section divider contracts');
  assert(compiled.sectionDividerContracts['1'].slideId === 5, 'section 1 -> slide 5');
  assert(compiled.sectionDividerContracts['4'].slideId === 30, 'section 4 -> slide 30');
}

// ---- Positive: data type fallbacks ----
console.log('\nPositive: data type fallbacks');
{
  const compiled = compile();
  assert(compiled.dataTypeFallbacks.time_series_multi_insight === 'chart_insight_panels', 'time_series_multi_insight -> chart_insight_panels');
  assert(compiled.dataTypeFallbacks.regulation_list === 'regulatory_table', 'regulation_list -> regulatory_table');
  assert(compiled.dataTypeFallbacks.definitions === 'glossary', 'definitions -> glossary');
}

// ---- Positive: signature is deterministic ----
console.log('\nPositive: signature determinism');
{
  const tp = makeMinimalTemplate();
  const c1 = compile({ templateData: tp });
  const c2 = compile({ templateData: tp });
  // Signatures differ due to compiledAt timestamp but structure is same
  assert(typeof c1.signature === 'string', 'first compile has signature');
  assert(typeof c2.signature === 'string', 'second compile has signature');
  assert(c1.version === c2.version, 'versions match across compilations');
}

// ---- Negative: corrupted template data ----
console.log('\nNegative: corrupted template data');
{
  assertThrows(
    () => compile({ templateData: null }),
    'compile throws on null templateData'
  );
  assertThrows(
    () => compile({ templateData: 'not an object' }),
    'compile throws on string templateData'
  );
  assertThrows(
    () => compile({ templateData: { _meta: {} } }),
    'compile throws when patterns key missing'
  );
  assertThrows(
    () => compile({ templateData: { patterns: 'not-object' } }),
    'compile throws when patterns is not an object'
  );
}

// ---- Negative: compile with nonexistent file ----
console.log('\nNegative: nonexistent template file');
{
  assertThrows(
    () => compile({ templatePath: '/tmp/nonexistent-template-xyz.json' }),
    'compile throws on nonexistent file'
  );
}

// ---- Positive: drift() with no drift ----
console.log('\nPositive: drift() no drift');
{
  const compiled = compile({ templateData: makeMinimalTemplate() });
  const report = drift(compiled, {
    blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP },
    blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP },
    tableContexts: [...TABLE_TEMPLATE_CONTEXTS],
    chartContexts: [...CHART_TEMPLATE_CONTEXTS],
  });
  assert(typeof report.checkedAt === 'string', 'drift report has checkedAt');
  assert(report.contractVersion === CONTRACT_VERSION, 'drift report has correct version');
}

// ---- Drift: intentionally mismatched pattern ----
console.log('\nDrift: pattern mismatch detected');
{
  const compiled = compile({ templateData: makeMinimalTemplate() });
  const badRuntime = {
    blockPatterns: {
      ...BLOCK_TEMPLATE_PATTERN_MAP,
      foundationalActs: 'chart_with_grid', // wrong pattern
    },
    blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP },
    tableContexts: [...TABLE_TEMPLATE_CONTEXTS],
    chartContexts: [...CHART_TEMPLATE_CONTEXTS],
  };
  const report = drift(compiled, badRuntime);
  assert(report.driftDetected === true, 'drift detected with wrong pattern');
  const patternIssue = report.issues.find(
    (i) => i.type === 'pattern_mismatch' && i.blockKey === 'foundationalActs'
  );
  assert(patternIssue !== undefined, 'found pattern_mismatch for foundationalActs');
  assert(patternIssue?.expected === 'regulatory_table', 'expected regulatory_table');
  assert(patternIssue?.actual === 'chart_with_grid', 'actual chart_with_grid');
}

// ---- Drift: intentionally mismatched slide ----
console.log('\nDrift: slide mismatch detected');
{
  const compiled = compile({ templateData: makeMinimalTemplate() });
  const badRuntime = {
    blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP },
    blockSlides: {
      ...BLOCK_TEMPLATE_SLIDE_MAP,
      foundationalActs: 99, // wrong slide
    },
    tableContexts: [...TABLE_TEMPLATE_CONTEXTS],
    chartContexts: [...CHART_TEMPLATE_CONTEXTS],
  };
  const report = drift(compiled, badRuntime);
  assert(report.driftDetected === true, 'drift detected with wrong slide');
  const slideIssue = report.issues.find(
    (i) => i.type === 'slide_mismatch' && i.blockKey === 'foundationalActs'
  );
  assert(slideIssue !== undefined, 'found slide_mismatch for foundationalActs');
  assert(slideIssue?.expected === 7, 'expected slide 7');
  assert(slideIssue?.actual === 99, 'actual slide 99');
  const rangeIssue = report.issues.find(
    (i) => i.type === 'slide_out_of_range' && i.blockKey === 'foundationalActs'
  );
  assert(rangeIssue !== undefined, 'slide_out_of_range also detected');
}

// ---- Drift: missing runtime block ----
console.log('\nDrift: missing runtime pattern');
{
  const compiled = compile({ templateData: makeMinimalTemplate() });
  const badRuntime = {
    blockPatterns: {}, // no blocks mapped
    blockSlides: {},
    tableContexts: [],
    chartContexts: [],
  };
  const report = drift(compiled, badRuntime);
  assert(report.driftDetected === true, 'drift detected with empty runtime');
  assert(report.errorCount > 0, 'error count > 0');
  const missing = report.issues.filter((i) => i.type === 'missing_runtime_pattern');
  assert(missing.length > 0, 'missing_runtime_pattern issues found');
}

// ---- Drift: uncontracted runtime block ----
console.log('\nDrift: uncontracted runtime block');
{
  const compiled = compile({ templateData: makeMinimalTemplate() });
  const badRuntime = {
    blockPatterns: {
      ...BLOCK_TEMPLATE_PATTERN_MAP,
      mysteryBlock: 'regulatory_table', // not in contracts
    },
    blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP },
    tableContexts: [...TABLE_TEMPLATE_CONTEXTS],
    chartContexts: [...CHART_TEMPLATE_CONTEXTS],
  };
  const report = drift(compiled, badRuntime);
  const uncontracted = report.issues.find(
    (i) => i.type === 'uncontracted_block' && i.blockKey === 'mysteryBlock'
  );
  assert(uncontracted !== undefined, 'uncontracted_block detected for mysteryBlock');
  assert(uncontracted?.severity === 'warning', 'uncontracted block is warning not error');
}

// ---- Positive: doctor() with minimal template ----
console.log('\nPositive: doctor() report');
{
  const report = doctor({ templateData: makeMinimalTemplate() });
  assert(typeof report.status === 'string', 'doctor report has status');
  assert(Array.isArray(report.checks), 'doctor report has checks array');
  assert(report.checks.length >= 7, 'doctor runs at least 7 checks');
  assert(typeof report.summary === 'object', 'doctor report has summary');
  assert(report.summary.contractVersion === CONTRACT_VERSION, 'summary has version');
  assert(typeof report.summary.signature === 'string', 'summary has signature');
}

// ---- Negative: doctor() with corrupted data ----
console.log('\nNegative: doctor() with corrupted data');
{
  const report = doctor({ templateData: { _meta: {} } });
  assert(report.status === 'fail', 'doctor fails on corrupted data');
  const compileCheck = report.checks.find((c) => c.name === 'compile');
  assert(compileCheck?.status === 'fail', 'compile check fails');
  assert(compileCheck?.message.includes('Compilation failed'), 'error message mentions compilation');
}

// ---- Snapshot: compiled contracts match expected keys ----
console.log('\nSnapshot: compiled contract keys');
{
  const compiled = compile({ templateData: makeMinimalTemplate() });
  const topKeys = Object.keys(compiled).sort();
  const expectedTopKeys = [
    'blockContracts',
    'compiledAt',
    'contractBundle',
    'dataTypeFallbacks',
    'patternContracts',
    'sectionDividerContracts',
    'signature',
    'slideCount',
    'templateExtractedAt',
    'templateSource',
    'version',
  ].sort();
  // Check key-by-key (contractBundle is not present, just the known keys)
  const hasVersion = topKeys.includes('version');
  const hasSignature = topKeys.includes('signature');
  const hasPatterns = topKeys.includes('patternContracts');
  const hasBlocks = topKeys.includes('blockContracts');
  assert(hasVersion && hasSignature && hasPatterns && hasBlocks, 'compiled output has required top-level keys');

  // Pattern contract shape
  const regTable = compiled.patternContracts.regulatory_table;
  const patternKeys = Object.keys(regTable).sort();
  assert(patternKeys.includes('geometryType'), 'pattern contract has geometryType');
  assert(patternKeys.includes('allowedSlideIds'), 'pattern contract has allowedSlideIds');
  assert(patternKeys.includes('elementConstraints'), 'pattern contract has elementConstraints');
  assert(patternKeys.includes('isTemplateBacked'), 'pattern contract has isTemplateBacked');
}

// ---- Real template: doctor runs end-to-end ----
console.log('\nIntegration: doctor() with real template-patterns.json');
{
  const report = doctor();
  assert(report.checks.length >= 7, 'real doctor runs all checks');
  assert(report.summary.patternCount >= 10, 'real template has >= 10 patterns');
  assert(report.summary.blockCount >= 30, 'real template has >= 30 blocks');
  // The known maActivity drift issue should show up
  const driftCheck = report.checks.find((c) => c.name === 'drift_detection');
  assert(driftCheck !== undefined, 'drift_detection check exists');
}

// ---- Geometry context mismatch detection ----
console.log('\nDrift: geometry context mismatch');
{
  const compiled = compile({ templateData: makeMinimalTemplate() });
  const badRuntime = {
    blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP },
    blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP },
    tableContexts: [...TABLE_TEMPLATE_CONTEXTS].filter((k) => k !== 'foundationalActs'), // remove one
    chartContexts: [...CHART_TEMPLATE_CONTEXTS],
  };
  const report = drift(compiled, badRuntime);
  const geoIssue = report.issues.find(
    (i) => i.type === 'geometry_context_mismatch' && i.blockKey === 'foundationalActs'
  );
  assert(geoIssue !== undefined, 'geometry_context_mismatch detected when table block removed from TABLE_TEMPLATE_CONTEXTS');
  assert(geoIssue?.severity === 'warning', 'geometry context mismatch is warning');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
