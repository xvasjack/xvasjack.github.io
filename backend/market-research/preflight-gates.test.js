#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
  runGates,
  runQuick,
  runFull,
  getReadinessScore,
  checkDirtyTree,
  checkHeadContent,
  checkModuleExportContracts,
  checkTemplateContract,
  checkRouteGeometry,
  checkSchemaFirewall,
  checkIntegrityPipeline,
  generateJsonReport,
  generateMarkdownReport,
  computeReadinessScore,
  parseArgs,
  MODULE_EXPORT_CONTRACTS,
  TEMPLATE_PATTERNS_EXPECTED_KEYS,
  SEVERITY,
} = require('./preflight-gates');

const PROJECT_ROOT = path.resolve(__dirname);

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
  console.log('preflight-gates.test.js');
  console.log('');

  // -----------------------------------------------------------------------
  // 1. Quick mode runs and returns array of results
  // -----------------------------------------------------------------------
  test('runQuick: returns array of check results', () => {
    const results = runQuick();
    assert.ok(Array.isArray(results), 'should return array');
    assert.ok(results.length >= 3, `should have >= 3 checks, got ${results.length}`);
    for (const r of results) {
      assert.ok('name' in r, 'each result should have name');
      assert.ok('pass' in r, 'each result should have pass');
      assert.ok('severity' in r, 'each result should have severity');
      assert.ok('status' in r, 'each result should have status');
      assert.ok('durationMs' in r, 'each result should have durationMs');
    }
  });

  // -----------------------------------------------------------------------
  // 2. Quick mode includes expected gate names
  // -----------------------------------------------------------------------
  test('runQuick: includes dirty tree, HEAD content, and module exports', () => {
    const results = runQuick();
    const names = results.map((r) => r.name);
    assert.ok(names.some((n) => /clean|dirty|tree/i.test(n)), 'should have dirty tree check');
    assert.ok(names.some((n) => /head.*content/i.test(n)), 'should have HEAD content check');
    assert.ok(names.some((n) => /module.*export|export.*contract/i.test(n)), 'should have module export check');
  });

  // -----------------------------------------------------------------------
  // 3. runGates with mode=quick delegates to runQuick
  // -----------------------------------------------------------------------
  test('runGates: mode=quick returns same results as runQuick', () => {
    const gateResults = runGates({ mode: 'quick' });
    const quickResults = runQuick();
    assert.strictEqual(gateResults.length, quickResults.length, 'same number of checks');
    for (let i = 0; i < gateResults.length; i++) {
      assert.strictEqual(gateResults[i].name, quickResults[i].name, `check ${i} same name`);
    }
  });

  // -----------------------------------------------------------------------
  // 4. checkDirtyTree returns expected shape
  // -----------------------------------------------------------------------
  test('checkDirtyTree: returns valid check result', () => {
    const r = checkDirtyTree();
    assert.ok('name' in r, 'should have name');
    assert.ok(typeof r.pass === 'boolean', 'pass should be boolean');
    assert.ok(r.severity === SEVERITY.BLOCKING || r.severity === SEVERITY.DEGRADED, 'severity should be BLOCKING or DEGRADED');
    assert.ok(typeof r.durationMs === 'number', 'durationMs should be number');
  });

  // -----------------------------------------------------------------------
  // 5. checkTemplateContract validates template-patterns.json
  // -----------------------------------------------------------------------
  test('checkTemplateContract: passes when template-patterns.json is valid', () => {
    const r = checkTemplateContract();
    // template-patterns.json exists in this codebase
    if (fs.existsSync(path.join(PROJECT_ROOT, 'template-patterns.json'))) {
      assert.strictEqual(r.pass, true, `template check should pass; details: ${r.details}`);
      assert.ok(/valid/i.test(r.details) || /top-level keys/i.test(r.details), 'details should mention validity');
    }
  });

  // -----------------------------------------------------------------------
  // 6. Missing module export detected correctly
  // -----------------------------------------------------------------------
  test('checkModuleExportContracts: detects missing module when file does not exist', () => {
    // Temporarily add a fake module to contracts
    const originalContracts = { ...MODULE_EXPORT_CONTRACTS };
    MODULE_EXPORT_CONTRACTS['nonexistent-module-xyz-12345.js'] = {
      functions: ['fakeFunction'],
    };

    const r = checkModuleExportContracts();
    assert.strictEqual(r.pass, false, 'should fail when a required module is missing');
    assert.ok(r.evidence.some((e) => /nonexistent-module-xyz/i.test(e)), 'evidence should name the missing module');

    // Restore
    delete MODULE_EXPORT_CONTRACTS['nonexistent-module-xyz-12345.js'];
    // Restore any removed keys
    for (const key of Object.keys(originalContracts)) {
      if (!(key in MODULE_EXPORT_CONTRACTS)) {
        MODULE_EXPORT_CONTRACTS[key] = originalContracts[key];
      }
    }
  });

  // -----------------------------------------------------------------------
  // 7. Report format: JSON report has correct structure
  // -----------------------------------------------------------------------
  test('generateJsonReport: returns valid structure', () => {
    const checks = [
      { name: 'A', pass: true, severity: SEVERITY.BLOCKING, status: 'PASS', durationMs: 5, details: 'ok' },
      { name: 'B', pass: false, severity: SEVERITY.BLOCKING, status: 'FAIL', durationMs: 3, details: 'broken', evidence: ['err1'] },
    ];
    const meta = {
      timestamp: '2026-02-14T00:00:00Z',
      nodeVersion: 'v22.0.0',
      gitBranch: 'test',
      mode: 'quick',
      stressSeeds: null,
    };
    const report = generateJsonReport(checks, meta);
    assert.strictEqual(report.preflight, true);
    assert.strictEqual(report.version, '3.0');
    assert.strictEqual(report.overallPass, false, 'should be false when BLOCKING check fails');
    assert.strictEqual(report.checks.length, 2);
    assert.ok(typeof report.readinessScore === 'number');
  });

  // -----------------------------------------------------------------------
  // 8. Report format: overallPass ignores non-BLOCKING failures
  // -----------------------------------------------------------------------
  test('generateJsonReport: overallPass ignores DEGRADED/INFO failures', () => {
    const checks = [
      { name: 'A', pass: true, severity: SEVERITY.BLOCKING, status: 'PASS', durationMs: 1 },
      { name: 'B', pass: false, severity: SEVERITY.DEGRADED, status: 'WARN', durationMs: 1, details: 'degraded' },
      { name: 'C', pass: false, severity: SEVERITY.INFO, status: 'INFO', durationMs: 1, details: 'info' },
    ];
    const meta = { timestamp: 'now', nodeVersion: 'v22', gitBranch: 'test', mode: 'quick' };
    const report = generateJsonReport(checks, meta);
    assert.strictEqual(report.overallPass, true, 'non-BLOCKING failures should not block overall pass');
  });

  // -----------------------------------------------------------------------
  // 9. Markdown report contains expected sections
  // -----------------------------------------------------------------------
  test('generateMarkdownReport: contains expected content', () => {
    const checks = [
      { name: 'Gate A', pass: true, severity: SEVERITY.BLOCKING, status: 'PASS', durationMs: 10 },
      { name: 'Gate B', pass: false, severity: SEVERITY.BLOCKING, status: 'FAIL', durationMs: 5, details: 'something broke', evidence: ['err detail'] },
    ];
    const meta = { timestamp: '2026-02-14', nodeVersion: 'v22', gitBranch: 'main', mode: 'full', stressSeeds: 50 };
    const md = generateMarkdownReport(checks, meta);
    assert.ok(md.includes('PREFLIGHT GATE REPORT'), 'should have header');
    assert.ok(md.includes('Readiness Score'), 'should have readiness score');
    assert.ok(md.includes('FAIL'), 'should have FAIL status');
    assert.ok(md.includes('Failures'), 'should have Failures section');
    assert.ok(md.includes('something broke'), 'should include failure details');
    assert.ok(md.includes('err detail'), 'should include evidence');
    assert.ok(md.includes('50'), 'should include stress seeds');
  });

  // -----------------------------------------------------------------------
  // 10. Readiness score calculation
  // -----------------------------------------------------------------------
  test('computeReadinessScore: 100 when all pass', () => {
    const results = [
      { pass: true, severity: SEVERITY.BLOCKING },
      { pass: true, severity: SEVERITY.BLOCKING },
      { pass: true, severity: SEVERITY.DEGRADED },
    ];
    assert.strictEqual(computeReadinessScore(results), 100);
  });

  test('computeReadinessScore: 0 when all fail', () => {
    const results = [
      { pass: false, severity: SEVERITY.BLOCKING },
      { pass: false, severity: SEVERITY.BLOCKING },
    ];
    assert.strictEqual(computeReadinessScore(results), 0);
  });

  test('computeReadinessScore: partial score', () => {
    const results = [
      { pass: true, severity: SEVERITY.BLOCKING },  // weight 15, earned 15
      { pass: false, severity: SEVERITY.BLOCKING },  // weight 15, earned 0
    ];
    const score = computeReadinessScore(results);
    assert.strictEqual(score, 50, `expected 50, got ${score}`);
  });

  // -----------------------------------------------------------------------
  // 11. getReadinessScore is consistent with computeReadinessScore
  // -----------------------------------------------------------------------
  test('getReadinessScore: wraps computeReadinessScore', () => {
    const results = [
      { pass: true, severity: SEVERITY.BLOCKING },
      { pass: true, severity: SEVERITY.INFO },
    ];
    assert.strictEqual(getReadinessScore(results), computeReadinessScore(results));
  });

  // -----------------------------------------------------------------------
  // 12. parseArgs: mode defaults to quick
  // -----------------------------------------------------------------------
  test('parseArgs: default mode is quick', () => {
    const args = parseArgs([]);
    assert.strictEqual(args.mode, 'quick');
    assert.strictEqual(args.stressSeeds, null);
    assert.strictEqual(args.help, false);
  });

  test('parseArgs: --mode=full', () => {
    const args = parseArgs(['--mode=full']);
    assert.strictEqual(args.mode, 'full');
  });

  test('parseArgs: --stress-seeds=50', () => {
    const args = parseArgs(['--stress-seeds=50']);
    assert.strictEqual(args.stressSeeds, 50);
  });

  test('parseArgs: stress seeds capped at 200', () => {
    const args = parseArgs(['--stress-seeds=999']);
    assert.strictEqual(args.stressSeeds, 200);
  });

  test('parseArgs: --help', () => {
    const args = parseArgs(['--help']);
    assert.strictEqual(args.help, true);
  });

  // -----------------------------------------------------------------------
  // 13. Exit codes: BLOCKING failure means non-zero
  // -----------------------------------------------------------------------
  test('SEVERITY constants are correct', () => {
    assert.strictEqual(SEVERITY.BLOCKING, 'BLOCKING');
    assert.strictEqual(SEVERITY.DEGRADED, 'DEGRADED');
    assert.strictEqual(SEVERITY.INFO, 'INFO');
  });

  // -----------------------------------------------------------------------
  // 14. checkRouteGeometry: returns INFO when file missing
  // -----------------------------------------------------------------------
  test('checkRouteGeometry: returns INFO skip when file not found', () => {
    const r = checkRouteGeometry();
    if (!fs.existsSync(path.join(PROJECT_ROOT, 'route-geometry-enforcer.js'))) {
      assert.strictEqual(r.pass, true, 'missing file should pass (INFO skip)');
      assert.strictEqual(r.severity, SEVERITY.INFO, 'severity should be INFO');
      assert.ok(/skip|not found/i.test(r.details), 'details should mention skip');
    }
  });

  // -----------------------------------------------------------------------
  // 15. checkSchemaFirewall: returns INFO when file missing
  // -----------------------------------------------------------------------
  test('checkSchemaFirewall: returns INFO skip when file not found', () => {
    const r = checkSchemaFirewall();
    if (!fs.existsSync(path.join(PROJECT_ROOT, 'schema-firewall.js'))) {
      assert.strictEqual(r.pass, true, 'missing file should pass (INFO skip)');
      assert.strictEqual(r.severity, SEVERITY.INFO);
    }
  });

  // -----------------------------------------------------------------------
  // 16. checkIntegrityPipeline: returns INFO when file missing
  // -----------------------------------------------------------------------
  test('checkIntegrityPipeline: returns INFO skip when file not found', () => {
    const r = checkIntegrityPipeline();
    if (!fs.existsSync(path.join(PROJECT_ROOT, 'pptx-integrity-pipeline.js'))) {
      assert.strictEqual(r.pass, true, 'missing file should pass (INFO skip)');
      assert.strictEqual(r.severity, SEVERITY.INFO);
    }
  });

  // -----------------------------------------------------------------------
  // 17. MODULE_EXPORT_CONTRACTS has expected modules
  // -----------------------------------------------------------------------
  test('MODULE_EXPORT_CONTRACTS: covers critical modules', () => {
    const expectedModules = [
      'ppt-single-country.js',
      'pptx-validator.js',
      'quality-gates.js',
      'research-orchestrator.js',
      'budget-gate.js',
      'transient-key-sanitizer.js',
    ];
    for (const mod of expectedModules) {
      assert.ok(mod in MODULE_EXPORT_CONTRACTS, `should include ${mod}`);
      assert.ok(Array.isArray(MODULE_EXPORT_CONTRACTS[mod].functions), `${mod} should have functions array`);
      assert.ok(MODULE_EXPORT_CONTRACTS[mod].functions.length > 0, `${mod} should have >= 1 required function`);
    }
  });

  // -----------------------------------------------------------------------
  // 18. No false passes — deliberately broken module fails
  // -----------------------------------------------------------------------
  test('checkModuleExportContracts: no false passes with wrong export', () => {
    // Add a contract that requires a function that does NOT exist on quality-gates
    const original = MODULE_EXPORT_CONTRACTS['quality-gates.js'];
    MODULE_EXPORT_CONTRACTS['quality-gates.js'] = {
      functions: [...original.functions, 'THIS_FUNCTION_DOES_NOT_EXIST_ABC'],
    };

    const r = checkModuleExportContracts();
    assert.strictEqual(r.pass, false, 'should fail when required export does not exist');
    assert.ok(r.evidence.some((e) => /quality-gates/i.test(e)), 'should name the module');

    // Restore
    MODULE_EXPORT_CONTRACTS['quality-gates.js'] = original;
  });

  // -----------------------------------------------------------------------
  // 19. TEMPLATE_PATTERNS_EXPECTED_KEYS constant is correct
  // -----------------------------------------------------------------------
  test('TEMPLATE_PATTERNS_EXPECTED_KEYS: contains essential keys', () => {
    assert.ok(TEMPLATE_PATTERNS_EXPECTED_KEYS.includes('_meta'), 'should include _meta');
    assert.ok(TEMPLATE_PATTERNS_EXPECTED_KEYS.includes('positions'), 'should include positions');
    assert.ok(TEMPLATE_PATTERNS_EXPECTED_KEYS.includes('patterns'), 'should include patterns');
  });

  // -----------------------------------------------------------------------
  // 20. Empty results produce score of 0
  // -----------------------------------------------------------------------
  test('computeReadinessScore: empty array returns 0', () => {
    assert.strictEqual(computeReadinessScore([]), 0);
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
