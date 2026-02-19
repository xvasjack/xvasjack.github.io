'use strict';

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

describe('preflight-gates', () => {
  // -----------------------------------------------------------------------
  // 1. Quick mode runs and returns array of results
  // -----------------------------------------------------------------------
  test('runQuick returns array of check results with expected shape', () => {
    const results = runQuick();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const r of results) {
      expect(r).toHaveProperty('name');
      expect(r).toHaveProperty('pass');
      expect(r).toHaveProperty('severity');
      expect(r).toHaveProperty('status');
      expect(r).toHaveProperty('durationMs');
    }
  });

  // -----------------------------------------------------------------------
  // 2. Quick mode includes expected gate names
  // -----------------------------------------------------------------------
  test('runQuick includes dirty tree, HEAD content, and module exports', () => {
    const results = runQuick();
    const names = results.map((r) => r.name);
    expect(names.some((n) => /clean|dirty|tree/i.test(n))).toBe(true);
    expect(names.some((n) => /head.*content/i.test(n))).toBe(true);
    expect(names.some((n) => /module.*export|export.*contract/i.test(n))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 3. runGates with mode=quick delegates to runQuick
  // -----------------------------------------------------------------------
  test('runGates mode=quick returns same check names as runQuick', () => {
    const gateResults = runGates({ mode: 'quick' });
    const quickResults = runQuick();
    expect(gateResults.length).toBe(quickResults.length);
    for (let i = 0; i < gateResults.length; i++) {
      expect(gateResults[i].name).toBe(quickResults[i].name);
    }
  });

  // -----------------------------------------------------------------------
  // 4. checkDirtyTree returns expected shape
  // -----------------------------------------------------------------------
  test('checkDirtyTree returns valid check result', () => {
    const r = checkDirtyTree();
    expect(r).toHaveProperty('name');
    expect(typeof r.pass).toBe('boolean');
    expect([SEVERITY.BLOCKING, SEVERITY.DEGRADED]).toContain(r.severity);
    expect(typeof r.durationMs).toBe('number');
  });

  // -----------------------------------------------------------------------
  // 5. checkTemplateContract validates template-patterns.json
  // -----------------------------------------------------------------------
  test('checkTemplateContract passes when template-patterns.json is valid', () => {
    const r = checkTemplateContract();
    if (fs.existsSync(path.join(PROJECT_ROOT, 'template-patterns.json'))) {
      expect(r.pass).toBe(true);
      expect(r.details).toMatch(/valid|top-level keys/i);
    }
  });

  // -----------------------------------------------------------------------
  // 6. Missing module export detected correctly
  // -----------------------------------------------------------------------
  test('checkModuleExportContracts detects missing module', () => {
    const saved = { ...MODULE_EXPORT_CONTRACTS };
    MODULE_EXPORT_CONTRACTS['nonexistent-module-xyz-12345.js'] = {
      functions: ['fakeFunction'],
    };

    try {
      const r = checkModuleExportContracts();
      expect(r.pass).toBe(false);
      expect(r.evidence.some((e) => /nonexistent-module-xyz/i.test(e))).toBe(true);
    } finally {
      delete MODULE_EXPORT_CONTRACTS['nonexistent-module-xyz-12345.js'];
      for (const key of Object.keys(saved)) {
        if (!(key in MODULE_EXPORT_CONTRACTS)) {
          MODULE_EXPORT_CONTRACTS[key] = saved[key];
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // 7. Report format: JSON report has correct structure
  // -----------------------------------------------------------------------
  test('generateJsonReport returns valid structure', () => {
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
    expect(report.preflight).toBe(true);
    expect(report.version).toBe('3.0');
    expect(report.overallPass).toBe(false);
    expect(report.checks.length).toBe(2);
    expect(typeof report.readinessScore).toBe('number');
  });

  // -----------------------------------------------------------------------
  // 8. Report format: overallPass ignores non-BLOCKING failures
  // -----------------------------------------------------------------------
  test('generateJsonReport overallPass ignores DEGRADED/INFO failures', () => {
    const checks = [
      { name: 'A', pass: true, severity: SEVERITY.BLOCKING, status: 'PASS', durationMs: 1 },
      { name: 'B', pass: false, severity: SEVERITY.DEGRADED, status: 'WARN', durationMs: 1, details: 'degraded' },
      { name: 'C', pass: false, severity: SEVERITY.INFO, status: 'INFO', durationMs: 1, details: 'info' },
    ];
    const meta = { timestamp: 'now', nodeVersion: 'v22', gitBranch: 'test', mode: 'quick' };
    const report = generateJsonReport(checks, meta);
    expect(report.overallPass).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 9. Markdown report contains expected sections
  // -----------------------------------------------------------------------
  test('generateMarkdownReport contains expected content', () => {
    const checks = [
      { name: 'Gate A', pass: true, severity: SEVERITY.BLOCKING, status: 'PASS', durationMs: 10 },
      { name: 'Gate B', pass: false, severity: SEVERITY.BLOCKING, status: 'FAIL', durationMs: 5, details: 'something broke', evidence: ['err detail'] },
    ];
    const meta = { timestamp: '2026-02-14', nodeVersion: 'v22', gitBranch: 'main', mode: 'full', stressSeeds: 50 };
    const md = generateMarkdownReport(checks, meta);
    expect(md).toContain('PREFLIGHT GATE REPORT');
    expect(md).toContain('Readiness Score');
    expect(md).toContain('FAIL');
    expect(md).toContain('Failures');
    expect(md).toContain('something broke');
    expect(md).toContain('err detail');
    expect(md).toContain('50');
  });

  // -----------------------------------------------------------------------
  // 10. Readiness score calculation
  // -----------------------------------------------------------------------
  test('computeReadinessScore 100 when all pass', () => {
    const results = [
      { pass: true, severity: SEVERITY.BLOCKING },
      { pass: true, severity: SEVERITY.BLOCKING },
      { pass: true, severity: SEVERITY.DEGRADED },
    ];
    expect(computeReadinessScore(results)).toBe(100);
  });

  test('computeReadinessScore 0 when all fail', () => {
    const results = [
      { pass: false, severity: SEVERITY.BLOCKING },
      { pass: false, severity: SEVERITY.BLOCKING },
    ];
    expect(computeReadinessScore(results)).toBe(0);
  });

  test('computeReadinessScore partial score', () => {
    const results = [
      { pass: true, severity: SEVERITY.BLOCKING },
      { pass: false, severity: SEVERITY.BLOCKING },
    ];
    expect(computeReadinessScore(results)).toBe(50);
  });

  // -----------------------------------------------------------------------
  // 11. getReadinessScore wraps computeReadinessScore
  // -----------------------------------------------------------------------
  test('getReadinessScore consistent with computeReadinessScore', () => {
    const results = [
      { pass: true, severity: SEVERITY.BLOCKING },
      { pass: true, severity: SEVERITY.INFO },
    ];
    expect(getReadinessScore(results)).toBe(computeReadinessScore(results));
  });

  // -----------------------------------------------------------------------
  // 12. parseArgs defaults
  // -----------------------------------------------------------------------
  test('parseArgs default mode is quick', () => {
    const args = parseArgs([]);
    expect(args.mode).toBe('quick');
    expect(args.stressSeeds).toBeNull();
    expect(args.help).toBe(false);
  });

  test('parseArgs --mode=full', () => {
    expect(parseArgs(['--mode=full']).mode).toBe('full');
  });

  test('parseArgs --stress-seeds=50', () => {
    expect(parseArgs(['--stress-seeds=50']).stressSeeds).toBe(50);
  });

  test('parseArgs stress seeds capped at 200', () => {
    expect(parseArgs(['--stress-seeds=999']).stressSeeds).toBe(200);
  });

  test('parseArgs --help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 13. SEVERITY constants
  // -----------------------------------------------------------------------
  test('SEVERITY constants are correct', () => {
    expect(SEVERITY.BLOCKING).toBe('BLOCKING');
    expect(SEVERITY.DEGRADED).toBe('DEGRADED');
    expect(SEVERITY.INFO).toBe('INFO');
  });

  // -----------------------------------------------------------------------
  // 14. checkRouteGeometry returns INFO when file missing
  // -----------------------------------------------------------------------
  test('checkRouteGeometry returns INFO skip when file not found', () => {
    const r = checkRouteGeometry();
    if (!fs.existsSync(path.join(PROJECT_ROOT, 'route-geometry-enforcer.js'))) {
      expect(r.pass).toBe(true);
      expect(r.severity).toBe(SEVERITY.INFO);
      expect(r.details).toMatch(/skip|not found/i);
    }
  });

  // -----------------------------------------------------------------------
  // 15. checkSchemaFirewall returns INFO when file missing
  // -----------------------------------------------------------------------
  test('checkSchemaFirewall returns INFO skip when file not found', () => {
    const r = checkSchemaFirewall();
    if (!fs.existsSync(path.join(PROJECT_ROOT, 'schema-firewall.js'))) {
      expect(r.pass).toBe(true);
      expect(r.severity).toBe(SEVERITY.INFO);
    }
  });

  // -----------------------------------------------------------------------
  // 16. checkIntegrityPipeline returns INFO when file missing
  // -----------------------------------------------------------------------
  test('checkIntegrityPipeline returns INFO skip when file not found', () => {
    const r = checkIntegrityPipeline();
    if (!fs.existsSync(path.join(PROJECT_ROOT, 'pptx-fileSafety-pipeline.js'))) {
      expect(r.pass).toBe(true);
      expect(r.severity).toBe(SEVERITY.INFO);
    }
  });

  // -----------------------------------------------------------------------
  // 17. MODULE_EXPORT_CONTRACTS covers critical modules
  // -----------------------------------------------------------------------
  test('MODULE_EXPORT_CONTRACTS covers critical modules', () => {
    const expectedModules = [
      'deck-builder-single.js',
      'deck-file-check.js',
      'content-gates.js',
      'research-engine.js',
      'content-size-check.js',
      'cleanup-temp-fields.js',
    ];
    for (const mod of expectedModules) {
      expect(mod in MODULE_EXPORT_CONTRACTS).toBe(true);
      expect(Array.isArray(MODULE_EXPORT_CONTRACTS[mod].functions)).toBe(true);
      expect(MODULE_EXPORT_CONTRACTS[mod].functions.length).toBeGreaterThan(0);
    }
  });

  // -----------------------------------------------------------------------
  // 18. No false passes with wrong export
  // -----------------------------------------------------------------------
  test('checkModuleExportContracts no false passes with wrong export', () => {
    const original = MODULE_EXPORT_CONTRACTS['content-gates.js'];
    MODULE_EXPORT_CONTRACTS['content-gates.js'] = {
      functions: [...original.functions, 'THIS_FUNCTION_DOES_NOT_EXIST_ABC'],
    };

    try {
      const r = checkModuleExportContracts();
      expect(r.pass).toBe(false);
      expect(r.evidence.some((e) => /content-gates/i.test(e))).toBe(true);
    } finally {
      MODULE_EXPORT_CONTRACTS['content-gates.js'] = original;
    }
  });

  // -----------------------------------------------------------------------
  // 19. TEMPLATE_PATTERNS_EXPECTED_KEYS
  // -----------------------------------------------------------------------
  test('TEMPLATE_PATTERNS_EXPECTED_KEYS contains essential keys', () => {
    expect(TEMPLATE_PATTERNS_EXPECTED_KEYS).toContain('_meta');
    expect(TEMPLATE_PATTERNS_EXPECTED_KEYS).toContain('positions');
    expect(TEMPLATE_PATTERNS_EXPECTED_KEYS).toContain('patterns');
  });

  // -----------------------------------------------------------------------
  // 20. Empty results produce score of 0
  // -----------------------------------------------------------------------
  test('computeReadinessScore empty array returns 0', () => {
    expect(computeReadinessScore([])).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 21. checkHeadContent returns valid result
  // -----------------------------------------------------------------------
  test('checkHeadContent returns valid check result', () => {
    const r = checkHeadContent();
    expect(r).toHaveProperty('name');
    expect(r).toHaveProperty('pass');
    expect(r.severity).toBe(SEVERITY.BLOCKING);
    expect(typeof r.durationMs).toBe('number');
  });

  // -----------------------------------------------------------------------
  // 22. Full mode includes more gates than quick
  // -----------------------------------------------------------------------
  test('runFull returns more checks than runQuick', () => {
    const quick = runQuick();
    const full = runFull();
    expect(full.length).toBeGreaterThan(quick.length);
  });
});
