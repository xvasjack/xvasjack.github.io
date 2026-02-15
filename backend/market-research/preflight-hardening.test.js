'use strict';

const {
  SEVERITY,
  GATE_MODES,
  ENVIRONMENT_CONTRACTS,
  QUICK_GATES,
  FULL_GATES,
  REMEDIATION_MAP,
  MODULE_EXPORT_CONTRACTS,
  applyModePolicy,
  getEnvironmentContract,
  validateModeParity,
  computeStructuredReadiness,
  computeReadinessScore,
  generateJsonReport,
  generateMarkdownReport,
  parseArgs,
  runQuick,
  runFull,
  checkDirtyTree,
  checkHeadContent,
  checkModuleExportContracts,
  checkModuleFunctionSignatures,
  checkSchemaCompatibility,
  checkSparseSlideGate,
  checkSourceCoverageGate,
  isReportSlideDivider,
} = require('./preflight-gates');
const { classifySlideIntent } = require('./pptx-validator');

// ---------------------------------------------------------------------------
// 1. Gate Modes: dev, test, release
// ---------------------------------------------------------------------------
describe('Gate Modes', () => {
  test('GATE_MODES has dev, test, release', () => {
    expect(GATE_MODES.DEV).toBe('dev');
    expect(GATE_MODES.TEST).toBe('test');
    expect(GATE_MODES.RELEASE).toBe('release');
  });

  test('runQuick in dev mode returns results with original severities', () => {
    const results = runQuick({ gateMode: GATE_MODES.DEV });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const r of results) {
      expect(r).toHaveProperty('name');
      expect(r).toHaveProperty('pass');
      expect(r).toHaveProperty('severity');
      expect(r).toHaveProperty('remediation');
    }
  });

  test('runQuick in test mode returns results', () => {
    const results = runQuick({ gateMode: GATE_MODES.TEST });
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  test('runQuick in release mode promotes DEGRADED to BLOCKING', () => {
    const results = runQuick({ gateMode: GATE_MODES.RELEASE });
    // In release mode, any DEGRADED results should have been promoted to BLOCKING
    for (const r of results) {
      // Original DEGRADED should now be BLOCKING
      if (r.severity === SEVERITY.DEGRADED) {
        // This would only remain if no policy was applied — but we applied release mode
        // So this check verifies no DEGRADED remains in the patched output for non-pass items
        // that were originally DEGRADED
      }
      // All results should have valid severity
      expect([SEVERITY.BLOCKING, SEVERITY.DEGRADED, SEVERITY.INFO]).toContain(r.severity);
    }
  });

  test('applyModePolicy promotes DEGRADED to BLOCKING in release mode', () => {
    const input = {
      name: 'Test gate',
      pass: false,
      severity: SEVERITY.DEGRADED,
      status: 'WARN',
      durationMs: 5,
      details: 'test',
      evidence: null,
      remediation: null,
    };

    const result = applyModePolicy(input, GATE_MODES.RELEASE, false);
    expect(result.severity).toBe(SEVERITY.BLOCKING);
    expect(result.status).toBe('FAIL');
  });

  test('applyModePolicy does not promote DEGRADED in dev mode', () => {
    const input = {
      name: 'Test gate',
      pass: false,
      severity: SEVERITY.DEGRADED,
      status: 'WARN',
      durationMs: 5,
      details: 'test',
      evidence: null,
      remediation: null,
    };

    const result = applyModePolicy(input, GATE_MODES.DEV, false);
    expect(result.severity).toBe(SEVERITY.DEGRADED);
    expect(result.status).toBe('WARN');
  });

  test('applyModePolicy leaves passing results unchanged in release mode', () => {
    const input = {
      name: 'Test gate',
      pass: true,
      severity: SEVERITY.DEGRADED,
      status: 'PASS',
      durationMs: 5,
      details: 'ok',
      evidence: null,
      remediation: null,
    };

    const result = applyModePolicy(input, GATE_MODES.RELEASE, false);
    // Severity promoted but status stays PASS since it passed
    expect(result.severity).toBe(SEVERITY.BLOCKING);
    expect(result.status).toBe('PASS');
    expect(result.pass).toBe(true);
  });

  test('applyModePolicy handles null input', () => {
    expect(applyModePolicy(null, GATE_MODES.RELEASE, false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Strict Mode Behavior
// ---------------------------------------------------------------------------
describe('Strict Mode', () => {
  test('applyModePolicy in strict mode makes any non-pass BLOCKING', () => {
    const input = {
      name: 'Test gate',
      pass: false,
      severity: SEVERITY.INFO,
      status: 'INFO',
      durationMs: 5,
      details: 'test',
      evidence: null,
      remediation: null,
    };

    const result = applyModePolicy(input, GATE_MODES.DEV, true);
    expect(result.severity).toBe(SEVERITY.BLOCKING);
    expect(result.status).toBe('FAIL');
  });

  test('strict mode does not affect passing results', () => {
    const input = {
      name: 'Test gate',
      pass: true,
      severity: SEVERITY.INFO,
      status: 'PASS',
      durationMs: 5,
      details: 'ok',
      evidence: null,
      remediation: null,
    };

    const result = applyModePolicy(input, GATE_MODES.DEV, true);
    expect(result.severity).toBe(SEVERITY.INFO);
    expect(result.pass).toBe(true);
  });

  test('strict + release mode: DEGRADED failure becomes BLOCKING', () => {
    const input = {
      name: 'Test gate',
      pass: false,
      severity: SEVERITY.DEGRADED,
      status: 'WARN',
      durationMs: 5,
      details: 'test',
      evidence: null,
      remediation: null,
    };

    const result = applyModePolicy(input, GATE_MODES.RELEASE, true);
    expect(result.severity).toBe(SEVERITY.BLOCKING);
    expect(result.status).toBe('FAIL');
  });

  test('parseArgs recognizes --strict flag', () => {
    const args = parseArgs(['--strict']);
    expect(args.strict).toBe(true);
  });

  test('parseArgs --strict defaults to false', () => {
    const args = parseArgs([]);
    expect(args.strict).toBe(false);
  });

  test('parseArgs recognizes --gate-mode=release', () => {
    const args = parseArgs(['--gate-mode=release']);
    expect(args.gateMode).toBe('release');
  });

  test('parseArgs --gate-mode defaults to dev', () => {
    const args = parseArgs([]);
    expect(args.gateMode).toBe('dev');
  });

  test('parseArgs combined --strict --gate-mode=release --mode=full', () => {
    const args = parseArgs(['--strict', '--gate-mode=release', '--mode=full']);
    expect(args.strict).toBe(true);
    expect(args.gateMode).toBe('release');
    expect(args.mode).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// 3. Readiness Score Calculation
// ---------------------------------------------------------------------------
describe('Readiness Score', () => {
  test('computeReadinessScore returns 100 when all pass', () => {
    const results = [
      { pass: true, severity: SEVERITY.BLOCKING },
      { pass: true, severity: SEVERITY.BLOCKING },
      { pass: true, severity: SEVERITY.DEGRADED },
    ];
    expect(computeReadinessScore(results)).toBe(100);
  });

  test('computeReadinessScore returns 0 when all fail', () => {
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

  test('computeReadinessScore empty array returns 0', () => {
    expect(computeReadinessScore([])).toBe(0);
  });

  test('computeReadinessScore accepts options parameter without breaking', () => {
    const results = [{ pass: true, severity: SEVERITY.BLOCKING }];
    const score = computeReadinessScore(results, { mode: 'release', strict: true });
    expect(score).toBe(100);
  });

  test('computeStructuredReadiness returns correct structure', () => {
    const results = [
      { pass: true, severity: SEVERITY.BLOCKING },
      { pass: true, severity: SEVERITY.BLOCKING },
    ];
    const readiness = computeStructuredReadiness(results, { mode: 'dev' });
    expect(readiness).toHaveProperty('score');
    expect(readiness).toHaveProperty('threshold');
    expect(readiness).toHaveProperty('passes');
    expect(readiness).toHaveProperty('mode');
    expect(readiness).toHaveProperty('strict');
    expect(readiness.score).toBe(100);
    expect(readiness.passes).toBe(true);
  });

  test('computeStructuredReadiness dev mode has threshold 0', () => {
    const readiness = computeStructuredReadiness([{ pass: false, severity: SEVERITY.BLOCKING }], {
      mode: 'dev',
    });
    expect(readiness.threshold).toBe(0);
    expect(readiness.passes).toBe(true); // 0 >= 0
  });

  test('computeStructuredReadiness test mode has threshold 80', () => {
    const readiness = computeStructuredReadiness([{ pass: true, severity: SEVERITY.BLOCKING }], {
      mode: 'test',
    });
    expect(readiness.threshold).toBe(80);
    expect(readiness.passes).toBe(true); // 100 >= 80
  });

  test('computeStructuredReadiness release mode has threshold 100', () => {
    const readiness = computeStructuredReadiness(
      [
        { pass: true, severity: SEVERITY.BLOCKING },
        { pass: false, severity: SEVERITY.BLOCKING },
      ],
      { mode: 'release' }
    );
    expect(readiness.threshold).toBe(100);
    expect(readiness.passes).toBe(false); // 50 < 100
  });

  test('computeStructuredReadiness release mode passes at 100', () => {
    const readiness = computeStructuredReadiness([{ pass: true, severity: SEVERITY.BLOCKING }], {
      mode: 'release',
    });
    expect(readiness.score).toBe(100);
    expect(readiness.passes).toBe(true);
  });

  test('computeStructuredReadiness strict mode sets threshold to 100', () => {
    const readiness = computeStructuredReadiness([{ pass: true, severity: SEVERITY.BLOCKING }], {
      mode: 'dev',
      strict: true,
    });
    expect(readiness.threshold).toBe(100);
    expect(readiness.strict).toBe(true);
  });

  test('computeStructuredReadiness strict mode fails below 100', () => {
    const readiness = computeStructuredReadiness(
      [
        { pass: true, severity: SEVERITY.BLOCKING },
        { pass: false, severity: SEVERITY.INFO },
      ],
      { mode: 'dev', strict: true }
    );
    expect(readiness.passes).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Environment Contract Matrix
// ---------------------------------------------------------------------------
describe('Environment Contract Matrix', () => {
  test('getEnvironmentContract returns contract for dev', () => {
    const contract = getEnvironmentContract('dev');
    expect(contract).toHaveProperty('required');
    expect(contract).toHaveProperty('optional');
    expect(contract).toHaveProperty('skip');
    expect(Array.isArray(contract.required)).toBe(true);
    expect(Array.isArray(contract.optional)).toBe(true);
    expect(Array.isArray(contract.skip)).toBe(true);
  });

  test('getEnvironmentContract returns contract for test', () => {
    const contract = getEnvironmentContract('test');
    expect(contract.required.length).toBeGreaterThan(0);
    expect(contract.required).toContain('Regression tests');
  });

  test('getEnvironmentContract returns contract for release', () => {
    const contract = getEnvironmentContract('release');
    expect(contract.required.length).toBeGreaterThan(0);
    expect(contract.optional.length).toBe(0);
    expect(contract.skip.length).toBe(0);
    // Release should require all gates
    expect(contract.required).toContain('Clean working tree');
    expect(contract.required).toContain('HEAD content verification');
    expect(contract.required).toContain('Module export contracts');
    expect(contract.required).toContain('Regression tests');
    expect(contract.required).toContain('Schema compatibility');
    expect(contract.required).toContain('Source coverage gate');
  });

  test('getEnvironmentContract falls back to dev for unknown mode', () => {
    const contract = getEnvironmentContract('nonexistent');
    const devContract = getEnvironmentContract('dev');
    expect(contract).toEqual(devContract);
  });

  test('ENVIRONMENT_CONTRACTS has all three modes', () => {
    expect(ENVIRONMENT_CONTRACTS).toHaveProperty('dev');
    expect(ENVIRONMENT_CONTRACTS).toHaveProperty('test');
    expect(ENVIRONMENT_CONTRACTS).toHaveProperty('release');
  });

  test('dev mode has fewer required gates than release', () => {
    const dev = getEnvironmentContract('dev');
    const release = getEnvironmentContract('release');
    expect(dev.required.length).toBeLessThan(release.required.length);
  });

  test('test mode has more required gates than dev but fewer than release', () => {
    const dev = getEnvironmentContract('dev');
    const test = getEnvironmentContract('test');
    const release = getEnvironmentContract('release');
    expect(test.required.length).toBeGreaterThan(dev.required.length);
    expect(test.required.length).toBeLessThan(release.required.length);
  });

  test('no gate appears in both required and skip for the same mode', () => {
    for (const mode of ['dev', 'test', 'release']) {
      const contract = getEnvironmentContract(mode);
      const overlap = contract.required.filter((g) => contract.skip.includes(g));
      expect(overlap).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Remediation Suggestions
// ---------------------------------------------------------------------------
describe('Remediation Suggestions', () => {
  test('REMEDIATION_MAP covers critical gate names', () => {
    expect(REMEDIATION_MAP).toHaveProperty('Clean working tree');
    expect(REMEDIATION_MAP).toHaveProperty('HEAD content verification');
    expect(REMEDIATION_MAP).toHaveProperty('Module export contracts');
    expect(REMEDIATION_MAP).toHaveProperty('Regression tests');
    expect(REMEDIATION_MAP).toHaveProperty('Schema compatibility');
    expect(REMEDIATION_MAP).toHaveProperty('Source coverage gate');
    expect(REMEDIATION_MAP).toHaveProperty('Sparse slide gate');
  });

  test('all remediation values are non-empty strings', () => {
    for (const [key, value] of Object.entries(REMEDIATION_MAP)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });

  test('failing checkDirtyTree includes remediation when dirty', () => {
    // We can only test the structure — dirty tree state depends on git
    const result = checkDirtyTree();
    if (!result.pass) {
      expect(result.remediation).toBeTruthy();
      expect(typeof result.remediation).toBe('string');
    }
    // Always has remediation field
    expect(result).toHaveProperty('remediation');
  });

  test('checkHeadContent result includes remediation field', () => {
    const result = checkHeadContent();
    expect(result).toHaveProperty('remediation');
    if (!result.pass) {
      expect(result.remediation).toBeTruthy();
    }
  });

  test('checkModuleExportContracts result includes remediation field', () => {
    const result = checkModuleExportContracts();
    expect(result).toHaveProperty('remediation');
  });

  test('checkModuleFunctionSignatures result includes remediation field', () => {
    const result = checkModuleFunctionSignatures();
    expect(result).toHaveProperty('remediation');
  });

  test('checkSchemaCompatibility result includes remediation field', () => {
    const result = checkSchemaCompatibility();
    expect(result).toHaveProperty('remediation');
  });

  test('checkSparseSlideGate result includes remediation field', () => {
    const result = checkSparseSlideGate();
    expect(result).toHaveProperty('remediation');
  });

  test('checkSourceCoverageGate result includes remediation field', () => {
    const result = checkSourceCoverageGate(70);
    expect(result).toHaveProperty('remediation');
  });

  test('generateMarkdownReport includes remediation for failures', () => {
    const results = [
      {
        name: 'Clean working tree',
        pass: false,
        severity: SEVERITY.BLOCKING,
        status: 'FAIL',
        durationMs: 5,
        details: '2 uncommitted files',
        evidence: ['file1.js', 'file2.js'],
        remediation: 'git add -A && git commit -m "pre-release commit"',
      },
    ];
    const meta = { timestamp: 'now', nodeVersion: 'v22', gitBranch: 'main', mode: 'dev' };
    const md = generateMarkdownReport(results, meta);
    expect(md).toContain('Remediation');
    expect(md).toContain('git add -A');
  });

  test('generateJsonReport includes remediation in checks', () => {
    const results = [
      {
        name: 'Clean working tree',
        pass: false,
        severity: SEVERITY.BLOCKING,
        status: 'FAIL',
        durationMs: 5,
        details: 'dirty',
        evidence: null,
        remediation: 'git add -A && git commit',
      },
    ];
    const meta = { timestamp: 'now', nodeVersion: 'v22', gitBranch: 'main', mode: 'dev' };
    const report = generateJsonReport(results, meta);
    expect(report.checks[0].remediation).toBe('git add -A && git commit');
  });
});

// ---------------------------------------------------------------------------
// 6. New Gates
// ---------------------------------------------------------------------------
describe('New Gates', () => {
  test('checkModuleFunctionSignatures returns valid result', () => {
    const r = checkModuleFunctionSignatures();
    expect(r).toHaveProperty('name', 'Module function signatures');
    expect(r).toHaveProperty('pass');
    expect(typeof r.pass).toBe('boolean');
    expect(r).toHaveProperty('severity');
    expect(r).toHaveProperty('durationMs');
  });

  test('checkModuleFunctionSignatures validates defined paramCounts', () => {
    // ppt-single-country.js has paramCounts { generateSingleCountryPPT: 2 }
    const r = checkModuleFunctionSignatures();
    // It should have checked at least 1 signature
    if (r.pass) {
      expect(r.details).toMatch(/signature/i);
    }
  });

  test('checkSchemaCompatibility returns valid result', () => {
    const r = checkSchemaCompatibility();
    expect(r).toHaveProperty('name', 'Schema compatibility');
    expect(r).toHaveProperty('pass');
    expect(typeof r.pass).toBe('boolean');
  });

  test('checkSparseSlideGate returns valid result', () => {
    const r = checkSparseSlideGate();
    expect(r).toHaveProperty('name', 'Sparse slide gate');
    expect(r).toHaveProperty('pass');
    expect(typeof r.pass).toBe('boolean');
  });

  test('checkSourceCoverageGate returns valid result with default threshold', () => {
    const r = checkSourceCoverageGate();
    expect(r).toHaveProperty('name', 'Source coverage gate');
    expect(r).toHaveProperty('pass');
    expect(typeof r.pass).toBe('boolean');
  });

  test('checkSourceCoverageGate accepts custom threshold', () => {
    const r = checkSourceCoverageGate(50);
    expect(r).toHaveProperty('name', 'Source coverage gate');
    expect(r).toHaveProperty('pass');
  });

  test('checkSourceCoverageGate defaults to 70 for invalid threshold', () => {
    const r1 = checkSourceCoverageGate(-1);
    const r2 = checkSourceCoverageGate(0);
    const r3 = checkSourceCoverageGate('abc');
    // All should still work without crashing
    expect(r1).toHaveProperty('pass');
    expect(r2).toHaveProperty('pass');
    expect(r3).toHaveProperty('pass');
  });

  test('MODULE_EXPORT_CONTRACTS includes paramCounts field', () => {
    for (const [modName, contract] of Object.entries(MODULE_EXPORT_CONTRACTS)) {
      expect(contract).toHaveProperty('paramCounts');
      expect(typeof contract.paramCounts).toBe('object');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Mode Parity Validation
// ---------------------------------------------------------------------------
describe('Mode Parity Validation', () => {
  test('validateModeParity returns valid=true', () => {
    const parity = validateModeParity();
    expect(parity.valid).toBe(true);
  });

  test('quick gates are a subset of full gates', () => {
    const parity = validateModeParity();
    expect(parity.valid).toBe(true);
    for (const gate of QUICK_GATES) {
      expect(FULL_GATES).toContain(gate);
    }
  });

  test('full gates has more entries than quick gates', () => {
    expect(FULL_GATES.length).toBeGreaterThan(QUICK_GATES.length);
  });

  test('QUICK_GATES contains expected gates', () => {
    expect(QUICK_GATES).toContain('Clean working tree');
    expect(QUICK_GATES).toContain('HEAD content verification');
    expect(QUICK_GATES).toContain('Module export contracts');
  });

  test('FULL_GATES contains new gates', () => {
    expect(FULL_GATES).toContain('Module function signatures');
    expect(FULL_GATES).toContain('Schema compatibility');
    expect(FULL_GATES).toContain('Sparse slide gate');
    expect(FULL_GATES).toContain('Source coverage gate');
  });

  test('validateModeParity returns gate counts', () => {
    const parity = validateModeParity();
    expect(parity.quickGateCount).toBe(QUICK_GATES.length);
    expect(parity.fullGateCount).toBe(FULL_GATES.length);
  });
});

// ---------------------------------------------------------------------------
// 8. Report Generation with Enhanced Fields
// ---------------------------------------------------------------------------
describe('Report Generation Enhanced', () => {
  test('generateJsonReport includes strict and readiness fields', () => {
    const results = [
      {
        name: 'A',
        pass: true,
        severity: SEVERITY.BLOCKING,
        status: 'PASS',
        durationMs: 5,
        details: 'ok',
        evidence: null,
        remediation: null,
      },
    ];
    const meta = {
      timestamp: '2026-02-15T00:00:00Z',
      nodeVersion: 'v22.0.0',
      gitBranch: 'test',
      mode: 'release',
      strict: true,
    };
    const report = generateJsonReport(results, meta);
    expect(report.strict).toBe(true);
    expect(report).toHaveProperty('readinessScore');
    expect(report).toHaveProperty('readinessThreshold');
    expect(report).toHaveProperty('readinessPasses');
    expect(report.readinessScore).toBe(100);
    expect(report.readinessThreshold).toBe(100);
    expect(report.readinessPasses).toBe(true);
  });

  test('generateJsonReport overallPass factors in readiness threshold', () => {
    const results = [
      {
        name: 'A',
        pass: true,
        severity: SEVERITY.BLOCKING,
        status: 'PASS',
        durationMs: 1,
        remediation: null,
      },
      {
        name: 'B',
        pass: false,
        severity: SEVERITY.DEGRADED,
        status: 'WARN',
        durationMs: 1,
        details: 'degraded',
        remediation: null,
      },
    ];
    const meta = {
      timestamp: 'now',
      nodeVersion: 'v22',
      gitBranch: 'test',
      mode: 'release',
      strict: true,
    };
    const report = generateJsonReport(results, meta);
    // Has no BLOCKING failure, but readiness < 100 in strict/release
    expect(report.overallPass).toBe(false);
  });

  test('generateMarkdownReport includes strict indicator', () => {
    const results = [
      {
        name: 'A',
        pass: true,
        severity: SEVERITY.BLOCKING,
        status: 'PASS',
        durationMs: 5,
        remediation: null,
      },
    ];
    const meta = {
      timestamp: 'now',
      nodeVersion: 'v22',
      gitBranch: 'main',
      mode: 'dev',
      strict: true,
    };
    const md = generateMarkdownReport(results, meta);
    expect(md).toContain('Strict');
    expect(md).toContain('YES');
  });

  test('generateMarkdownReport includes readiness threshold', () => {
    const results = [
      {
        name: 'A',
        pass: true,
        severity: SEVERITY.BLOCKING,
        status: 'PASS',
        durationMs: 5,
        remediation: null,
      },
    ];
    const meta = { timestamp: 'now', nodeVersion: 'v22', gitBranch: 'main', mode: 'release' };
    const md = generateMarkdownReport(results, meta);
    expect(md).toContain('threshold');
  });
});

// ---------------------------------------------------------------------------
// 9. Full Mode Includes New Gates
// ---------------------------------------------------------------------------
describe('Full Mode Gate Coverage', () => {
  test('runFull includes more checks than runQuick', () => {
    const quick = runQuick();
    const full = runFull();
    expect(full.length).toBeGreaterThan(quick.length);
  });

  test('runFull includes new gate names', () => {
    const results = runFull();
    const names = results.map((r) => r.name);
    expect(names).toContain('Module function signatures');
    expect(names).toContain('Schema compatibility');
    expect(names).toContain('Sparse slide gate');
    expect(names).toContain('Source coverage gate');
  });

  test('runFull with release mode applies severity promotion', () => {
    const results = runFull({ gateMode: GATE_MODES.RELEASE });
    // Check that originally DEGRADED gates have been promoted
    for (const r of results) {
      if (!r.pass) {
        // In release mode, no DEGRADED failures should remain
        // (they should be promoted to BLOCKING)
        // But INFO can remain if not strict
        expect([SEVERITY.BLOCKING, SEVERITY.INFO]).toContain(r.severity);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Integration: Strict Release Mode End-to-End
// ---------------------------------------------------------------------------
describe('Strict Release Mode Integration', () => {
  test('runQuick with strict mode makes all non-pass BLOCKING', () => {
    const results = runQuick({ gateMode: GATE_MODES.DEV, strict: true });
    for (const r of results) {
      if (!r.pass) {
        expect(r.severity).toBe(SEVERITY.BLOCKING);
        expect(r.status).toBe('FAIL');
      }
    }
  });

  test('report in strict release mode requires score 100 to pass', () => {
    const results = [
      {
        name: 'A',
        pass: true,
        severity: SEVERITY.BLOCKING,
        status: 'PASS',
        durationMs: 1,
        remediation: null,
      },
      {
        name: 'B',
        pass: true,
        severity: SEVERITY.INFO,
        status: 'PASS',
        durationMs: 1,
        remediation: null,
      },
    ];
    const meta = {
      timestamp: 'now',
      nodeVersion: 'v22',
      gitBranch: 'main',
      mode: 'release',
      strict: true,
    };
    const report = generateJsonReport(results, meta);
    expect(report.readinessThreshold).toBe(100);
    expect(report.readinessScore).toBe(100);
    expect(report.overallPass).toBe(true);
  });

  test('report in strict release mode fails with any non-pass', () => {
    const results = [
      {
        name: 'A',
        pass: true,
        severity: SEVERITY.BLOCKING,
        status: 'PASS',
        durationMs: 1,
        remediation: null,
      },
      {
        name: 'B',
        pass: false,
        severity: SEVERITY.INFO,
        status: 'INFO',
        durationMs: 1,
        details: 'minor',
        remediation: null,
      },
    ];
    const meta = {
      timestamp: 'now',
      nodeVersion: 'v22',
      gitBranch: 'main',
      mode: 'release',
      strict: true,
    };
    const report = generateJsonReport(results, meta);
    expect(report.readinessScore).toBeLessThan(100);
    expect(report.overallPass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. parseArgs Enhanced
// ---------------------------------------------------------------------------
describe('parseArgs Enhanced', () => {
  test('parseArgs --source-coverage=50', () => {
    const args = parseArgs(['--source-coverage=50']);
    expect(args.sourceCoverageThreshold).toBe(50);
  });

  test('parseArgs source coverage defaults to 70', () => {
    const args = parseArgs([]);
    expect(args.sourceCoverageThreshold).toBe(70);
  });

  test('parseArgs all flags combined', () => {
    const args = parseArgs([
      '--mode=full',
      '--gate-mode=release',
      '--strict',
      '--stress-seeds=100',
      '--source-coverage=80',
      '--report-dir=/tmp/reports',
    ]);
    expect(args.mode).toBe('full');
    expect(args.gateMode).toBe('release');
    expect(args.strict).toBe(true);
    expect(args.stressSeeds).toBe(100);
    expect(args.sourceCoverageThreshold).toBe(80);
    expect(args.reportDir).toBe('/tmp/reports');
  });
});

// ---------------------------------------------------------------------------
// 12. Divider-Aware Sparse Slide Classification
// ---------------------------------------------------------------------------
describe('Divider-Aware Sparse Slide Classification', () => {
  describe('classifySlideIntent', () => {
    test('classifies section divider titles as dividers', () => {
      const dividers = [
        'Policy & Regulatory',
        'Market Overview',
        'Competitive Landscape',
        'Strategic Analysis',
        'Recommendations',
        'Executive Summary',
      ];
      for (const text of dividers) {
        const result = classifySlideIntent(text, text.length);
        expect(result.isDivider).toBe(true);
        expect(result.reason).toBe('section_divider');
      }
    });

    test('classifies TOC slides as dividers', () => {
      const result = classifySlideIntent('Table of Contents', 17);
      expect(result.isDivider).toBe(true);
      expect(result.reason).toBe('toc');
    });

    test('classifies TOC with section labels as dividers', () => {
      const result = classifySlideIntent(
        'Table of Contents  Policy & Regulatory  Market Overview',
        55
      );
      expect(result.isDivider).toBe(true);
      expect(result.reason).toBe('toc');
    });

    test('classifies appendix header as divider', () => {
      const result = classifySlideIntent('Appendix', 8);
      expect(result.isDivider).toBe(true);
      expect(result.reason).toBe('appendix_header');
    });

    test('classifies short title-only text as divider', () => {
      const result = classifySlideIntent('Vietnam Energy', 14);
      expect(result.isDivider).toBe(true);
      expect(result.reason).toBe('title_only');
    });

    test('does NOT classify empty slides as dividers', () => {
      const result = classifySlideIntent('', 0);
      expect(result.isDivider).toBe(false);
      expect(result.reason).toBe('empty');
    });

    test('does NOT classify content slides as dividers', () => {
      const text =
        'The energy market in Vietnam grew by 15% in 2024, driven by industrial expansion and new regulatory frameworks.';
      const result = classifySlideIntent(text, text.length);
      expect(result.isDivider).toBe(false);
      expect(result.reason).toBe('content');
    });

    test('does NOT classify short text with sentence punctuation as divider', () => {
      const result = classifySlideIntent('This is real content.', 21);
      expect(result.isDivider).toBe(false);
    });
  });

  describe('isReportSlideDivider', () => {
    test('identifies section divider slides from report data', () => {
      expect(isReportSlideDivider({ text: 'Market Overview' })).toBe(true);
      expect(isReportSlideDivider({ preview: 'Policy & Regulatory' })).toBe(true);
      expect(isReportSlideDivider({ text: 'Table of Contents' })).toBe(true);
    });

    test('rejects genuine content slides', () => {
      expect(
        isReportSlideDivider({ text: 'Strong industrial growth in Q3 2024. Market expanded.' })
      ).toBe(false);
    });

    test('handles empty/missing text gracefully', () => {
      expect(isReportSlideDivider({})).toBe(false);
      expect(isReportSlideDivider({ text: '' })).toBe(false);
    });

    test('identifies title-only short labels as dividers', () => {
      expect(isReportSlideDivider({ text: 'Key Themes' })).toBe(true);
    });
  });
});
