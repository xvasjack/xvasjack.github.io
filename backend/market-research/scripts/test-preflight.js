#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  verifyHeadContent,
  checkDirtyTree,
  checkGitAvailable,
  checkGitBranch,
  checkHeadSha,
  checkGitDivergence,
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
      { file: 'content-gates.js', patterns: ['validatePptData'] },
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
    assert.ok(typeof result.pass === 'boolean', 'pass should be boolean');
  });

  test('checkDirtyTree: dirty result includes remediation', () => {
    // If the tree happens to be dirty, remediation should exist
    const result = checkDirtyTree();
    if (!result.pass && !result.gitUnavailable) {
      assert.ok(result.remediation, 'dirty tree failure should include remediation');
      assert.ok(
        result.remediation.includes('git stash') || result.remediation.includes('git commit'),
        'remediation should suggest git stash or commit'
      );
    }
    // If clean, remediation should be null
    if (result.pass) {
      assert.strictEqual(result.remediation, null, 'clean tree should have null remediation');
    }
  });

  test('checkDirtyTree: gitUnavailable path returns pass=false', () => {
    // We can't easily simulate git unavailable in-process, but we can verify
    // the shape contract: if gitUnavailable is set, pass must be false
    const result = checkDirtyTree();
    if (result.gitUnavailable) {
      assert.strictEqual(result.pass, false, 'gitUnavailable should mean pass=false');
      assert.ok(result.remediation, 'gitUnavailable should include remediation');
    }
    // In normal env, gitUnavailable should not be set
    assert.ok(!result.gitUnavailable, 'git should be available in test environment');
  });

  // -----------------------------------------------------------------------
  // checkGitAvailable
  // -----------------------------------------------------------------------
  test('checkGitAvailable: git is available in test env', () => {
    const result = checkGitAvailable();
    assert.strictEqual(result.pass, true, 'git should be available');
  });

  test('checkGitAvailable: returns correct shape', () => {
    const result = checkGitAvailable();
    assert.ok('pass' in result, 'should have pass field');
    // On success, no error or remediation needed
    if (result.pass) {
      assert.ok(!result.error, 'no error on pass');
    }
  });

  // -----------------------------------------------------------------------
  // checkGitBranch
  // -----------------------------------------------------------------------
  test('checkGitBranch: returns expected shape', () => {
    const result = checkGitBranch('main');
    assert.ok('pass' in result, 'should have pass field');
    assert.ok('branch' in result, 'should have branch field');
  });

  test('checkGitBranch: wrong branch returns failure with remediation', () => {
    const result = checkGitBranch('nonexistent-branch-xyz-99999');
    // We're almost certainly not on this branch
    assert.strictEqual(result.pass, false, 'should fail on wrong branch');
    assert.ok(result.remediation, 'should include remediation');
    assert.ok(
      result.remediation.includes('git checkout'),
      'remediation should suggest git checkout'
    );
  });

  test('checkGitBranch: current branch matches expected', () => {
    // Get actual current branch first
    const initial = checkGitBranch('main');
    const actualBranch = initial.branch;
    if (actualBranch && actualBranch !== '(detached HEAD)') {
      const result = checkGitBranch(actualBranch);
      assert.strictEqual(result.pass, true, `should pass when expected matches actual '${actualBranch}'`);
    }
  });

  // -----------------------------------------------------------------------
  // checkHeadSha
  // -----------------------------------------------------------------------
  test('checkHeadSha: returns expected shape', () => {
    const result = checkHeadSha();
    assert.ok('pass' in result, 'should have pass field');
    assert.ok('sha' in result, 'should have sha field');
  });

  test('checkHeadSha: SHA is valid in test env', () => {
    const result = checkHeadSha();
    assert.strictEqual(result.pass, true, 'HEAD SHA should be resolvable');
    assert.ok(result.sha, 'sha should be non-empty');
    assert.ok(result.sha.length >= 7, 'sha should be at least 7 chars');
    assert.ok(Array.isArray(result.branches), 'should have branches array');
    assert.ok(result.branches.length > 0, 'HEAD should be on at least one branch');
  });

  // -----------------------------------------------------------------------
  // checkGitDivergence
  // -----------------------------------------------------------------------
  test('checkGitDivergence: returns expected shape', () => {
    const result = checkGitDivergence();
    assert.ok('pass' in result, 'should have pass field');
    assert.ok('ahead' in result, 'should have ahead field');
    assert.ok('behind' in result, 'should have behind field');
  });

  test('checkGitDivergence: failure includes remediation', () => {
    const result = checkGitDivergence('origin/nonexistent-branch-xyz-99999');
    // This should fail because the remote branch doesn't exist
    assert.strictEqual(result.pass, false, 'should fail for nonexistent remote branch');
    assert.ok(result.remediation, 'should include remediation');
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
    assert.strictEqual(result.expectedBranch, 'main', 'expectedBranch should default to main');
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

  test('parseArgs: --expected-branch=staging', () => {
    const result = parseArgs(['--expected-branch=staging']);
    assert.strictEqual(result.expectedBranch, 'staging', 'expectedBranch should be staging');
  });

  test('parseArgs: combined --strict --expected-branch=release', () => {
    const result = parseArgs(['--strict', '--expected-branch=release']);
    assert.strictEqual(result.strict, true);
    assert.strictEqual(result.expectedBranch, 'release');
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
  // Integration: strict mode git checks
  // -----------------------------------------------------------------------
  test('integration: all git check functions are exported', () => {
    assert.ok(typeof checkGitAvailable === 'function', 'checkGitAvailable should be exported');
    assert.ok(typeof checkGitBranch === 'function', 'checkGitBranch should be exported');
    assert.ok(typeof checkHeadSha === 'function', 'checkHeadSha should be exported');
    assert.ok(typeof checkGitDivergence === 'function', 'checkGitDivergence should be exported');
  });

  test('integration: git checks all return objects with pass field', () => {
    const results = [
      checkGitAvailable(),
      checkGitBranch('main'),
      checkHeadSha(),
      checkGitDivergence(),
    ];
    for (const r of results) {
      assert.ok('pass' in r, 'each git check result should have pass field');
      assert.ok(typeof r.pass === 'boolean', 'pass should be boolean');
    }
  });

  test('integration: failed git checks always include remediation', () => {
    // Test with impossible branch name to guarantee failure
    const branchResult = checkGitBranch('impossible-branch-name-xyz-99999');
    assert.strictEqual(branchResult.pass, false);
    assert.ok(branchResult.remediation, 'failed branch check must have remediation');
    assert.ok(branchResult.remediation.length > 10, 'remediation should be descriptive');

    // Test with impossible remote branch
    const divResult = checkGitDivergence('origin/impossible-branch-xyz-99999');
    assert.strictEqual(divResult.pass, false);
    assert.ok(divResult.remediation, 'failed divergence check must have remediation');
    assert.ok(divResult.remediation.length > 10, 'remediation should be descriptive');
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
