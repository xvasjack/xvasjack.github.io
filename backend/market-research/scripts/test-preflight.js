#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  verifyHeadContent,
  checkDirtyTree,
  checkModuleImports,
  parseArgs,
  generateJsonReport,
  generateMarkdownReport,
  DEFAULT_HEAD_CHECKS,
} = require('./preflight-release');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function main() {
  console.log('');
  console.log('test-preflight.js');
  console.log('');

  // -----------------------------------------------------------------------
  // verifyHeadContent
  // -----------------------------------------------------------------------
  test('verifyHeadContent: passing case with real patterns', () => {
    const result = verifyHeadContent([
      { file: 'server.js', patterns: ['collectPreRenderStructureIssues'] },
      { file: 'quality-gates.js', patterns: ['validatePptData'] },
    ]);
    assert.strictEqual(result.pass, true, `expected pass=true, got ${result.pass}`);
    assert.strictEqual(
      result.failures.length,
      0,
      `expected 0 failures, got ${JSON.stringify(result.failures)}`
    );
    assert.strictEqual(result.passedPatterns, 2, `expected 2 passed patterns`);
    assert.strictEqual(result.totalPatterns, 2, `expected 2 total patterns`);
  });

  test('verifyHeadContent: failing case with missing pattern', () => {
    const badPattern = 'THIS_PATTERN_DOES_NOT_EXIST_ANYWHERE_12345';
    const result = verifyHeadContent([{ file: 'server.js', patterns: [badPattern] }]);
    assert.strictEqual(result.pass, false, `expected pass=false`);
    assert.ok(result.failures.length > 0, 'expected at least one failure');
    const entry = result.failures.find((f) => f.file === 'server.js');
    assert.ok(entry, 'expected failure entry for server.js');
    assert.ok(entry.missing.includes(badPattern), `expected missing to include bad pattern`);
  });

  test('verifyHeadContent: failing case with nonexistent file', () => {
    const result = verifyHeadContent([{ file: 'nonexistent-file-xyz.js', patterns: ['anything'] }]);
    assert.strictEqual(result.pass, false, `expected pass=false`);
    assert.ok(result.failures.length > 0, 'expected at least one failure');
    const entry = result.failures.find((f) => f.file === 'nonexistent-file-xyz.js');
    assert.ok(entry, 'expected failure entry for nonexistent file');
  });

  test('verifyHeadContent: mixed case — some found, some not', () => {
    const result = verifyHeadContent([
      {
        file: 'server.js',
        patterns: ['collectPreRenderStructureIssues', 'NONEXISTENT_PATTERN_XYZ'],
      },
    ]);
    assert.strictEqual(result.pass, false, 'mixed case should fail');
    assert.strictEqual(result.passedPatterns, 1, 'one pattern should pass');
    assert.strictEqual(result.totalPatterns, 2, 'two total patterns');
  });

  test('verifyHeadContent: DEFAULT_HEAD_CHECKS all pass', () => {
    const result = verifyHeadContent(DEFAULT_HEAD_CHECKS);
    assert.strictEqual(
      result.pass,
      true,
      `DEFAULT_HEAD_CHECKS should pass; failures: ${JSON.stringify(result.failures)}`
    );
  });

  // -----------------------------------------------------------------------
  // checkDirtyTree
  // -----------------------------------------------------------------------
  test('checkDirtyTree: returns expected shape', () => {
    const result = checkDirtyTree();
    assert.ok('pass' in result, 'should have pass field');
    assert.ok('dirty' in result, 'should have dirty field');
    assert.ok(Array.isArray(result.dirty), 'dirty should be array');
    assert.ok(
      typeof result.pass === 'boolean' || result.restricted,
      'pass should be boolean or restricted'
    );
  });

  // -----------------------------------------------------------------------
  // checkModuleImports
  // -----------------------------------------------------------------------
  test('checkModuleImports: loads all modules', () => {
    const result = checkModuleImports();
    assert.strictEqual(
      result.pass,
      true,
      `expected all modules to load; failures: ${JSON.stringify(result.failures)}`
    );
    assert.strictEqual(result.total, 12, `expected 12 modules, got ${result.total}`);
    assert.strictEqual(result.loadedCount, 12, `expected 12 loaded, got ${result.loadedCount}`);
  });

  test('checkModuleImports: returns correct shape', () => {
    const result = checkModuleImports();
    assert.ok('pass' in result, 'should have pass');
    assert.ok('failures' in result, 'should have failures');
    assert.ok('total' in result, 'should have total');
    assert.ok('loadedCount' in result, 'should have loadedCount');
    assert.ok(Array.isArray(result.failures), 'failures should be array');
  });

  // -----------------------------------------------------------------------
  // parseArgs
  // -----------------------------------------------------------------------
  test('parseArgs: empty args', () => {
    const result = parseArgs([]);
    assert.strictEqual(result.stressSeeds, null, 'stressSeeds should be null');
    assert.strictEqual(result.help, false, 'help should be false');
    assert.strictEqual(result.strict, false, 'strict should be false');
    assert.strictEqual(result.gateMode, 'dev', 'gateMode should be dev');
    assert.ok(result.reportDir, 'reportDir should be set');
  });

  test('parseArgs: --stress-seeds=30', () => {
    const result = parseArgs(['--stress-seeds=30']);
    assert.strictEqual(result.stressSeeds, 30, 'stressSeeds should be 30');
  });

  test('parseArgs: --stress-seeds capped at 100', () => {
    const result = parseArgs(['--stress-seeds=999']);
    assert.strictEqual(result.stressSeeds, 100, 'stressSeeds should be capped at 100');
  });

  test('parseArgs: --help', () => {
    const result = parseArgs(['--help']);
    assert.strictEqual(result.help, true, 'help should be true');
  });

  test('parseArgs: --report-dir', () => {
    const result = parseArgs(['--report-dir=/tmp/test-reports']);
    assert.strictEqual(result.reportDir, '/tmp/test-reports');
  });

  test('parseArgs: combined flags', () => {
    const result = parseArgs(['--stress-seeds=50', '--report-dir=/tmp/x']);
    assert.strictEqual(result.stressSeeds, 50);
    assert.strictEqual(result.reportDir, '/tmp/x');
  });

  test('parseArgs: --strict flag', () => {
    const result = parseArgs(['--strict']);
    assert.strictEqual(result.strict, true, 'strict should be true');
  });

  test('parseArgs: --mode=release flag', () => {
    const result = parseArgs(['--mode=release']);
    assert.strictEqual(result.gateMode, 'release', 'gateMode should be release');
  });

  test('parseArgs: --mode=test flag', () => {
    const result = parseArgs(['--mode=test']);
    assert.strictEqual(result.gateMode, 'test', 'gateMode should be test');
  });

  test('parseArgs: combined --strict --mode=release', () => {
    const result = parseArgs(['--strict', '--mode=release']);
    assert.strictEqual(result.strict, true);
    assert.strictEqual(result.gateMode, 'release');
  });

  // -----------------------------------------------------------------------
  // generateJsonReport
  // -----------------------------------------------------------------------
  test('generateJsonReport: returns valid structure', () => {
    const checks = [
      { name: 'Test check', pass: true, status: 'PASS', durationMs: 10, details: null },
      { name: 'Fail check', pass: false, status: 'FAIL', durationMs: 5, details: 'broken' },
    ];
    const meta = {
      timestamp: '2026-01-01T00:00:00Z',
      nodeVersion: 'v20.0.0',
      gitBranch: 'main',
      stressSeeds: null,
      strict: false,
      gateMode: 'dev',
    };
    const report = generateJsonReport(checks, meta);
    assert.strictEqual(report.preflight, true, 'should have preflight flag');
    assert.strictEqual(report.version, '2.0', 'should have version');
    assert.strictEqual(report.timestamp, '2026-01-01T00:00:00Z');
    assert.strictEqual(report.overallPass, false, 'should be false when any check fails');
    assert.strictEqual(report.checks.length, 2, 'should have 2 checks');
    assert.strictEqual(report.checks[0].pass, true);
    assert.strictEqual(report.checks[1].pass, false);
    assert.strictEqual(report.strict, false, 'should include strict field');
    assert.strictEqual(report.gateMode, 'dev', 'should include gateMode field');
  });

  test('generateJsonReport: overallPass true when all pass', () => {
    const checks = [{ name: 'A', pass: true, status: 'PASS', durationMs: 1 }];
    const meta = { timestamp: 'now', nodeVersion: 'v20', gitBranch: 'main', stressSeeds: null };
    const report = generateJsonReport(checks, meta);
    assert.strictEqual(report.overallPass, true);
  });

  test('generateJsonReport: SKIP does not block overallPass', () => {
    const checks = [
      { name: 'A', pass: true, status: 'PASS' },
      { name: 'B', pass: true, status: 'SKIP' },
    ];
    const meta = { timestamp: 'now', nodeVersion: 'v20', gitBranch: 'main', stressSeeds: null };
    const report = generateJsonReport(checks, meta);
    assert.strictEqual(report.overallPass, true, 'SKIP should not block overall pass');
  });

  // -----------------------------------------------------------------------
  // generateMarkdownReport
  // -----------------------------------------------------------------------
  test('generateMarkdownReport: contains expected sections', () => {
    const checks = [
      { name: 'Clean tree', pass: true, status: 'PASS', durationMs: 5 },
      {
        name: 'HEAD content',
        pass: false,
        status: 'FAIL',
        durationMs: 10,
        details: 'missing pattern X',
      },
    ];
    const meta = {
      timestamp: '2026-01-01T00:00:00Z',
      nodeVersion: 'v20.0.0',
      gitBranch: 'main',
      stressSeeds: null,
    };
    const md = generateMarkdownReport(checks, meta);
    assert.ok(md.includes('PREFLIGHT RELEASE REPORT'), 'should have header');
    assert.ok(md.includes('2026-01-01'), 'should have timestamp');
    assert.ok(md.includes('FAIL'), 'should have FAIL indicator');
    assert.ok(md.includes('PASS'), 'should have PASS indicator');
    assert.ok(md.includes('missing pattern X'), 'should include failure details');
  });

  test('generateMarkdownReport: includes stress seeds when present', () => {
    const checks = [{ name: 'A', pass: true, status: 'PASS', durationMs: 1 }];
    const meta = { timestamp: 'now', nodeVersion: 'v20', gitBranch: 'main', stressSeeds: 30 };
    const md = generateMarkdownReport(checks, meta);
    assert.ok(md.includes('30'), 'should mention stress seed count');
  });

  test('generateMarkdownReport: includes strict indicator', () => {
    const checks = [{ name: 'A', pass: true, status: 'PASS', durationMs: 1 }];
    const meta = { timestamp: 'now', nodeVersion: 'v20', gitBranch: 'main', strict: true };
    const md = generateMarkdownReport(checks, meta);
    assert.ok(md.includes('Strict'), 'should mention strict mode');
  });

  test('generateMarkdownReport: includes gate mode', () => {
    const checks = [{ name: 'A', pass: true, status: 'PASS', durationMs: 1 }];
    const meta = { timestamp: 'now', nodeVersion: 'v20', gitBranch: 'main', gateMode: 'release' };
    const md = generateMarkdownReport(checks, meta);
    assert.ok(md.includes('release'), 'should mention gate mode');
  });

  // -----------------------------------------------------------------------
  // DEFAULT_HEAD_CHECKS
  // -----------------------------------------------------------------------
  test('DEFAULT_HEAD_CHECKS: has correct structure', () => {
    assert.ok(Array.isArray(DEFAULT_HEAD_CHECKS), 'should be array');
    assert.ok(
      DEFAULT_HEAD_CHECKS.length >= 5,
      `should have >=5 entries, got ${DEFAULT_HEAD_CHECKS.length}`
    );
    for (const check of DEFAULT_HEAD_CHECKS) {
      assert.ok(typeof check.file === 'string', 'each check needs file');
      assert.ok(Array.isArray(check.patterns), 'each check needs patterns array');
      assert.ok(check.patterns.length > 0, `${check.file} should have at least one pattern`);
    }
  });

  // -----------------------------------------------------------------------
  // Integration: failing scenario produces actionable output
  // -----------------------------------------------------------------------
  test('integration: failing scenario has actionable failure info', () => {
    const result = verifyHeadContent([
      { file: 'server.js', patterns: ['FAKE_FUNCTION_THAT_DOES_NOT_EXIST'] },
    ]);
    assert.strictEqual(result.pass, false);
    assert.ok(result.failures[0].file === 'server.js', 'failure should name the file');
    assert.ok(
      result.failures[0].missing[0] === 'FAKE_FUNCTION_THAT_DOES_NOT_EXIST',
      'failure should name the missing pattern'
    );
  });

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}
