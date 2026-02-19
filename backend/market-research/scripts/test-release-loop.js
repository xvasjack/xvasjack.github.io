#!/usr/bin/env node
'use strict';

/**
 * Tests for release-loop.js flowManager.
 *
 * Tests:
 *   1. parseArgs defaults and overrides
 *   2. generateReport produces valid JSON and markdown
 *   3. REMEDIATION map has entries for all expected steps
 *   4. Module loads without error
 *   5. Happy path simulation (mocked steps)
 *   6. Failure path simulation with exit codes and remediation
 *
 * Run:
 *   node scripts/test-release-loop.js
 */

const assert = require('assert');
const path = require('path');

// Load the module under test
const { parseArgs, generateReport, REMEDIATION, runReleaseLoop } = require('./release-loop');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  [FAIL] ${name}: ${err.message}`);
  }
}

console.log('');
console.log('=== release-loop.js tests ===');
console.log('');

// ---------------------------------------------------------------------------
// parseArgs tests
// ---------------------------------------------------------------------------
console.log('parseArgs:');

test('defaults', () => {
  const args = parseArgs([]);
  assert.strictEqual(args.stressSeeds, 30);
  assert.strictEqual(args.skipPpt, false);
  assert.strictEqual(args.verbose, false);
  assert.strictEqual(args.help, false);
});

test('--stress-seeds=100', () => {
  const args = parseArgs(['--stress-seeds=100']);
  assert.strictEqual(args.stressSeeds, 100);
});

test('--stress-seeds=300', () => {
  const args = parseArgs(['--stress-seeds=300']);
  assert.strictEqual(args.stressSeeds, 300);
});

test('--skip-ppt', () => {
  const args = parseArgs(['--skip-ppt']);
  assert.strictEqual(args.skipPpt, true);
});

test('--verbose', () => {
  const args = parseArgs(['--verbose']);
  assert.strictEqual(args.verbose, true);
});

test('-v shorthand', () => {
  const args = parseArgs(['-v']);
  assert.strictEqual(args.verbose, true);
});

test('--help', () => {
  const args = parseArgs(['--help']);
  assert.strictEqual(args.help, true);
});

test('-h shorthand', () => {
  const args = parseArgs(['-h']);
  assert.strictEqual(args.help, true);
});

test('combined flags', () => {
  const args = parseArgs(['--stress-seeds=50', '--skip-ppt', '--verbose']);
  assert.strictEqual(args.stressSeeds, 50);
  assert.strictEqual(args.skipPpt, true);
  assert.strictEqual(args.verbose, true);
});

test('invalid stress-seeds ignored', () => {
  const args = parseArgs(['--stress-seeds=abc']);
  assert.strictEqual(args.stressSeeds, 30);
});

test('negative stress-seeds ignored', () => {
  const args = parseArgs(['--stress-seeds=-5']);
  assert.strictEqual(args.stressSeeds, 30);
});

// ---------------------------------------------------------------------------
// generateReport tests
// ---------------------------------------------------------------------------
console.log('');
console.log('generateReport:');

test('produces valid JSON report for GO verdict', () => {
  const steps = [
    { name: 'preflight', pass: true, exitCode: 0, durationMs: 100, stdout: '', stderr: '', error: null },
    { name: 'regression-round-1', pass: true, exitCode: 0, durationMs: 200, stdout: '', stderr: '', error: null },
    { name: 'stress-test', pass: true, exitCode: 0, durationMs: 500, stdout: '', stderr: '', error: null },
    { name: 'regression-round-2', pass: true, exitCode: 0, durationMs: 200, stdout: '', stderr: '', error: null },
    { name: 'regression-round-3', pass: true, exitCode: 0, durationMs: 200, stdout: '', stderr: '', error: null },
    { name: 'ppt-generation', pass: true, exitCode: 0, durationMs: 300, stdout: '', stderr: '', error: null },
  ];
  const metadata = {
    verdict: 'GO',
    failedStep: null,
    stressSeeds: 30,
    skipPpt: false,
    totalDurationMs: 1500,
    timestamp: '2026-02-15T00:00:00.000Z',
    nodeVersion: 'v20.0.0',
  };
  const report = generateReport(steps, metadata);

  assert.strictEqual(report.json.releaseLoop, true);
  assert.strictEqual(report.json.verdict, 'GO');
  assert.strictEqual(report.json.steps.length, 6);
  assert.strictEqual(report.json.failedStep, null);
  assert.strictEqual(report.json.remediation, null);
  assert.ok(report.json.steps.every((s) => s.pass === true));

  // JSON is valid
  const reparsed = JSON.parse(JSON.stringify(report.json));
  assert.strictEqual(reparsed.verdict, 'GO');
});

test('produces valid JSON report for NO-GO verdict', () => {
  const steps = [
    { name: 'preflight', pass: true, exitCode: 0, durationMs: 100, stdout: '', stderr: '', error: null },
    { name: 'regression-round-1', pass: false, exitCode: 1, durationMs: 200, stdout: 'some output', stderr: 'some error', error: null },
  ];
  const metadata = {
    verdict: 'NO-GO',
    failedStep: 'regression-round-1',
    stressSeeds: 30,
    skipPpt: false,
    totalDurationMs: 300,
    timestamp: '2026-02-15T00:00:00.000Z',
    nodeVersion: 'v20.0.0',
  };
  const report = generateReport(steps, metadata);

  assert.strictEqual(report.json.verdict, 'NO-GO');
  assert.strictEqual(report.json.failedStep, 'regression-round-1');
  assert.ok(Array.isArray(report.json.remediation));
  assert.ok(report.json.remediation.length > 0);
});

test('markdown report contains verdict', () => {
  const steps = [
    { name: 'preflight', pass: true, exitCode: 0, durationMs: 100, stdout: '', stderr: '', error: null },
  ];
  const metadata = {
    verdict: 'GO',
    failedStep: null,
    stressSeeds: 30,
    skipPpt: false,
    totalDurationMs: 100,
    timestamp: '2026-02-15T00:00:00.000Z',
    nodeVersion: 'v20.0.0',
  };
  const report = generateReport(steps, metadata);

  assert.ok(report.markdown.includes('RELEASE LOOP REPORT'));
  assert.ok(report.markdown.includes('GO'));
  assert.ok(report.markdown.includes('preflight'));
  assert.ok(report.markdown.includes('PASS'));
});

test('markdown report contains remediation for failure', () => {
  const steps = [
    { name: 'stress-test', pass: false, exitCode: 1, durationMs: 500, stdout: '', stderr: 'crash detail', error: null },
  ];
  const metadata = {
    verdict: 'NO-GO',
    failedStep: 'stress-test',
    stressSeeds: 30,
    skipPpt: false,
    totalDurationMs: 500,
    timestamp: '2026-02-15T00:00:00.000Z',
    nodeVersion: 'v20.0.0',
  };
  const report = generateReport(steps, metadata);

  assert.ok(report.markdown.includes('Remediation'));
  assert.ok(report.markdown.includes('stress'));
  assert.ok(report.markdown.includes('crash detail'));
});

test('skipped step in report', () => {
  const steps = [
    { name: 'ppt-generation', pass: true, exitCode: 0, durationMs: 0, stdout: '', stderr: '', error: null, skipped: true },
  ];
  const metadata = {
    verdict: 'GO',
    failedStep: null,
    stressSeeds: 30,
    skipPpt: true,
    totalDurationMs: 0,
    timestamp: '2026-02-15T00:00:00.000Z',
    nodeVersion: 'v20.0.0',
  };
  const report = generateReport(steps, metadata);

  const pptStep = report.json.steps.find((s) => s.name === 'ppt-generation');
  assert.strictEqual(pptStep.skipped, true);
});

// ---------------------------------------------------------------------------
// REMEDIATION map tests
// ---------------------------------------------------------------------------
console.log('');
console.log('REMEDIATION:');

test('has entries for all expected step names', () => {
  const expectedSteps = [
    'preflight',
    'regression-round-1',
    'stress-test',
    'regression-round-2',
    'regression-round-3',
    'ppt-generation',
    'final-check',
  ];
  for (const step of expectedSteps) {
    assert.ok(
      Array.isArray(REMEDIATION[step]),
      `Missing REMEDIATION entry for "${step}"`
    );
    assert.ok(
      REMEDIATION[step].length > 0,
      `REMEDIATION["${step}"] is empty`
    );
  }
});

test('remediation entries are strings', () => {
  for (const [key, steps] of Object.entries(REMEDIATION)) {
    for (const step of steps) {
      assert.strictEqual(typeof step, 'string', `REMEDIATION["${key}"] contains non-string`);
    }
  }
});

// ---------------------------------------------------------------------------
// Module contract tests
// ---------------------------------------------------------------------------
console.log('');
console.log('Module contract:');

test('exports runReleaseLoop function', () => {
  assert.strictEqual(typeof runReleaseLoop, 'function');
});

test('exports parseArgs function', () => {
  assert.strictEqual(typeof parseArgs, 'function');
});

test('exports generateReport function', () => {
  assert.strictEqual(typeof generateReport, 'function');
});

test('exports REMEDIATION object', () => {
  assert.ok(typeof REMEDIATION === 'object' && REMEDIATION !== null);
});

test('help flag returns exitCode 0 and HELP verdict', () => {
  // Suppress console output during help test
  const origLog = console.log;
  console.log = () => {};
  try {
    const result = runReleaseLoop(['--help']);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.verdict, 'HELP');
  } finally {
    console.log = origLog;
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log(`=== ${passed + failed} tests: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
console.log('');
process.exit(0);
