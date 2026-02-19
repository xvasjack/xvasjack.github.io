'use strict';

// ============================================================
// Operator Automation Tests
// Tests for: ops-runbook, post-run-summary, perf-profiler
// ============================================================

const {
  validateLocal,
  triageError,
  getPlaybook,
  getCommands,
  runLocalReadiness,
  recommendActions,
  executeRunbook,
  getProfile,
  generateCommandCookbook,
  getSafeToRunVerdict,
  ERROR_PATTERNS,
  PLAYBOOKS,
  COMMANDS,
  ERROR_CODE_RUNBOOKS,
  PROFILES,
} = require('./ops-runbook');

const {
  generateSummary,
  formatSummary,
  getTimingReport,
  getMemoryReport,
} = require('./post-run-summary');

const {
  metricsStore,
  getPerformanceSummary,
} = require('./perf-profiler');

// ============================================================
// Runbook Decision Output Consistency
// Same error -> same steps
// ============================================================

describe('Runbook decision output consistency', () => {
  test('executeRunbook returns identical steps for same error code across calls', () => {
    const result1 = executeRunbook('PPT_STRUCTURAL_VALIDATION');
    const result2 = executeRunbook('PPT_STRUCTURAL_VALIDATION');
    expect(result1.found).toBe(true);
    expect(result2.found).toBe(true);
    expect(result1.steps).toEqual(result2.steps);
    expect(result1.title).toBe(result2.title);
    expect(result1.severity).toBe(result2.severity);
  });

  test('executeRunbook returns identical steps for OOM across calls', () => {
    const result1 = executeRunbook('OOM');
    const result2 = executeRunbook('OOM');
    expect(result1.steps).toEqual(result2.steps);
  });

  test('executeRunbook returns consistent availableCodes', () => {
    const result1 = executeRunbook('OOM');
    const result2 = executeRunbook('GEMINI_API_ERROR');
    expect(result1.availableCodes).toEqual(result2.availableCodes);
  });

  test('all ERROR_CODE_RUNBOOKS have required fields', () => {
    for (const [code, rb] of Object.entries(ERROR_CODE_RUNBOOKS)) {
      expect(rb.code).toBe(code);
      expect(typeof rb.title).toBe('string');
      expect(rb.title.length).toBeGreaterThan(0);
      expect(['critical', 'high', 'medium', 'low']).toContain(rb.severity);
      expect(Array.isArray(rb.steps)).toBe(true);
      expect(rb.steps.length).toBeGreaterThan(0);
      for (const step of rb.steps) {
        expect(typeof step.action).toBe('string');
        expect(typeof step.command).toBe('string');
      }
    }
  });

  test('executeRunbook with unknown code returns found=false and availableCodes', () => {
    const result = executeRunbook('NONEXISTENT_CODE');
    expect(result.found).toBe(false);
    expect(result.steps).toBeNull();
    expect(result.availableCodes.length).toBeGreaterThan(0);
  });

  test('executeRunbook with null returns found=false', () => {
    const result = executeRunbook(null);
    expect(result.found).toBe(false);
  });

  test('triageError returns consistent results for same message', () => {
    const msg = 'PPT structural check failed for slide 5';
    const r1 = triageError(msg);
    const r2 = triageError(msg);
    expect(r1).toEqual(r2);
    expect(r1.matched).toBe(true);
  });
});

// ============================================================
// Command Recommendation Correctness
// ============================================================

describe('Command recommendation correctness', () => {
  test('recommendActions with no runInfo returns info action', () => {
    const result = recommendActions(null);
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].severity).toBe('info');
    expect(result.summary).toContain('No runInfo');
  });

  test('recommendActions with error stage produces critical action', () => {
    const diag = {
      error: 'PPT structural check failed',
      stage: 'error',
    };
    const result = recommendActions(diag);
    expect(result.actions.length).toBeGreaterThan(0);
    const critical = result.actions.find((a) => a.severity === 'critical');
    expect(critical).toBeDefined();
  });

  test('recommendActions with notReadyCountries produces high severity action', () => {
    const diag = {
      notReadyCountries: [{ country: 'Vietnam', effectiveScore: 40 }],
    };
    const result = recommendActions(diag);
    const high = result.actions.find((a) => a.severity === 'high');
    expect(high).toBeDefined();
    expect(high.issue).toContain('not ready');
  });

  test('recommendActions with synthesis gate failure', () => {
    const diag = {
      synthesisGate: { pass: false, overall: 45 },
    };
    const result = recommendActions(diag);
    const high = result.actions.find((a) => a.issue.includes('Synthesis'));
    expect(high).toBeDefined();
    expect(high.severity).toBe('high');
  });

  test('recommendActions with PPT data gate failures', () => {
    const diag = {
      pptDataGateFailures: [{ block: 'marketOverview', issue: 'empty' }],
    };
    const result = recommendActions(diag);
    expect(result.actions.length).toBeGreaterThan(0);
  });

  test('recommendActions with content size check high risk', () => {
    const diag = {
      contentSizeCheck: {
        Vietnam: { risk: 'high', issues: ['overflow'], compacted: 5 },
      },
    };
    const result = recommendActions(diag);
    const medium = result.actions.find((a) => a.issue.includes('Budget gate'));
    expect(medium).toBeDefined();
  });

  test('recommendActions with low template coverage', () => {
    const diag = {
      ppt: { templateCoverage: 80, slideRenderFailureCount: 0 },
    };
    const result = recommendActions(diag);
    const coverage = result.actions.find((a) => a.issue.includes('template coverage'));
    expect(coverage).toBeDefined();
  });

  test('recommendActions summary counts critical actions', () => {
    const diag = {
      error: 'JavaScript heap out of memory',
      stage: 'error',
    };
    const result = recommendActions(diag);
    expect(result.summary).toContain('critical');
  });

  test('recommendActions with healthy runInfo returns no actions', () => {
    const diag = {
      stage: 'complete',
      ppt: { templateCoverage: 99, slideRenderFailureCount: 0 },
    };
    const result = recommendActions(diag);
    expect(result.summary).toContain('healthy');
  });

  test('getCommands returns all categories when no filter', () => {
    const cmds = getCommands();
    expect(Object.keys(cmds).length).toBeGreaterThan(3);
  });

  test('getCommands returns filtered category', () => {
    const cmds = getCommands('Health Checks');
    expect(Object.keys(cmds)).toEqual(['Health Checks']);
    expect(cmds['Health Checks'].length).toBeGreaterThan(0);
  });
});

// ============================================================
// Local Readiness Workflow (all 3 profiles)
// ============================================================

describe('Local readiness workflow', () => {
  test('runLocalReadiness with fast-check mode returns structured result', () => {
    const result = runLocalReadiness({ mode: 'fast-check' });
    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('mode', 'fast-check');
    expect(result).toHaveProperty('checks');
    expect(result).toHaveProperty('duration');
    expect(result).toHaveProperty('verdict');
    expect(typeof result.pass).toBe('boolean');
    expect(typeof result.duration).toBe('number');
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  test('fast-check includes env-vars, key-files, module-syntax, template-contract', () => {
    const result = runLocalReadiness({ mode: 'fast-check' });
    const checkNames = result.checks.map((c) => c.name);
    expect(checkNames).toContain('env-vars');
    expect(checkNames).toContain('key-files');
    expect(checkNames).toContain('module-syntax');
    expect(checkNames).toContain('template-contract');
  });

  test('release-check includes all fast-check checks plus regression-tests and preflight-gates', () => {
    const profile = getProfile('release-check');
    expect(profile).not.toBeNull();
    expect(profile.checks).toContain('env-vars');
    expect(profile.checks).toContain('key-files');
    expect(profile.checks).toContain('module-syntax');
    expect(profile.checks).toContain('template-contract');
    expect(profile.checks).toContain('regression-tests');
    expect(profile.checks).toContain('preflight-gates');
  });

  test('deep-audit includes all release-check checks plus stress-test and fileSafety-pipeline', () => {
    const profile = getProfile('deep-audit');
    expect(profile).not.toBeNull();
    expect(profile.checks).toContain('stress-test');
    expect(profile.checks).toContain('fileSafety-pipeline');
    expect(profile.checks).toContain('regression-tests');
  });

  test('invalid mode returns failed result', () => {
    const result = runLocalReadiness({ mode: 'nonexistent-mode' });
    expect(result.pass).toBe(false);
    expect(result.verdict).toContain('Invalid mode');
  });

  test('strict mode fails on any check failure', () => {
    // With strict=true, missing env vars should cause overall failure
    const oldKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const result = runLocalReadiness({ mode: 'fast-check', strict: true });
      const envCheck = result.checks.find((c) => c.name === 'env-vars');
      if (envCheck && !envCheck.pass) {
        expect(result.pass).toBe(false);
      }
    } finally {
      if (oldKey) process.env.GEMINI_API_KEY = oldKey;
    }
  });

  test('each check has name, pass, and output fields', () => {
    const result = runLocalReadiness({ mode: 'fast-check' });
    for (const check of result.checks) {
      expect(check).toHaveProperty('name');
      expect(check).toHaveProperty('pass');
      expect(check).toHaveProperty('output');
      expect(typeof check.name).toBe('string');
      expect(typeof check.pass).toBe('boolean');
      expect(typeof check.output).toBe('string');
    }
  });

  test('getProfile returns correct profile for each mode', () => {
    expect(getProfile('fast-check')).not.toBeNull();
    expect(getProfile('fast-check').name).toBe('fast-check');
    expect(getProfile('release-check')).not.toBeNull();
    expect(getProfile('deep-audit')).not.toBeNull();
    expect(getProfile('nonexistent')).toBeNull();
  });

  test('all profiles have required structure', () => {
    for (const [name, prof] of Object.entries(PROFILES)) {
      expect(prof.name).toBe(name);
      expect(typeof prof.description).toBe('string');
      expect(Array.isArray(prof.checks)).toBe(true);
      expect(prof.checks.length).toBeGreaterThan(0);
      expect(typeof prof.estimatedSeconds).toBe('number');
    }
  });
});

// ============================================================
// Safe-to-Run Verdict Logic
// ============================================================

describe('Safe-to-run verdict logic', () => {
  test('all critical checks passing returns safe=true', () => {
    const checks = [
      { name: 'env-vars', pass: true, output: 'All set' },
      { name: 'key-files', pass: true, output: 'All present' },
      { name: 'module-syntax', pass: true, output: 'All OK' },
      { name: 'template-contract', pass: true, output: 'Compiled' },
    ];
    const verdict = getSafeToRunVerdict(checks);
    expect(verdict.safe).toBe(true);
    expect(verdict.verdict).toContain('SAFE');
    expect(verdict.blockers).toHaveLength(0);
    expect(verdict.evidence).toHaveLength(4);
  });

  test('missing env-vars blocks safe verdict', () => {
    const checks = [
      { name: 'env-vars', pass: false, output: 'Missing: GEMINI_API_KEY' },
      { name: 'key-files', pass: true, output: 'All present' },
      { name: 'module-syntax', pass: true, output: 'All OK' },
    ];
    const verdict = getSafeToRunVerdict(checks);
    expect(verdict.safe).toBe(false);
    expect(verdict.verdict).toContain('UNSAFE');
    expect(verdict.blockers.length).toBeGreaterThan(0);
    expect(verdict.blockers[0]).toContain('env-vars');
  });

  test('module-syntax failure blocks safe verdict', () => {
    const checks = [
      { name: 'env-vars', pass: true, output: 'All set' },
      { name: 'key-files', pass: true, output: 'All present' },
      { name: 'module-syntax', pass: false, output: 'SyntaxError in content-size-check.js' },
    ];
    const verdict = getSafeToRunVerdict(checks);
    expect(verdict.safe).toBe(false);
    expect(verdict.blockers[0]).toContain('module-syntax');
  });

  test('key-files failure blocks safe verdict', () => {
    const checks = [
      { name: 'env-vars', pass: true, output: 'All set' },
      { name: 'key-files', pass: false, output: 'Missing: server.js' },
      { name: 'module-syntax', pass: true, output: 'All OK' },
    ];
    const verdict = getSafeToRunVerdict(checks);
    expect(verdict.safe).toBe(false);
  });

  test('majority failure adds additional blocker', () => {
    const checks = [
      { name: 'env-vars', pass: false, output: 'Missing' },
      { name: 'key-files', pass: false, output: 'Missing' },
      { name: 'module-syntax', pass: false, output: 'Error' },
    ];
    const verdict = getSafeToRunVerdict(checks);
    expect(verdict.safe).toBe(false);
    expect(verdict.blockers.length).toBeGreaterThanOrEqual(3);
  });

  test('non-critical check failure does not block', () => {
    const checks = [
      { name: 'env-vars', pass: true, output: 'All set' },
      { name: 'key-files', pass: true, output: 'All present' },
      { name: 'module-syntax', pass: true, output: 'All OK' },
      { name: 'stress-test', pass: false, output: 'Timeout' },
    ];
    const verdict = getSafeToRunVerdict(checks);
    expect(verdict.safe).toBe(true);
    expect(verdict.verdict).toContain('SAFE');
  });

  test('empty checks array returns unsafe', () => {
    const verdict = getSafeToRunVerdict([]);
    expect(verdict.safe).toBe(false);
    expect(verdict.verdict).toContain('UNSAFE');
  });

  test('null checks returns unsafe', () => {
    const verdict = getSafeToRunVerdict(null);
    expect(verdict.safe).toBe(false);
  });

  test('evidence contains correct statuses', () => {
    const checks = [
      { name: 'env-vars', pass: true, output: 'All set' },
      { name: 'key-files', pass: false, output: 'Missing: server.js' },
    ];
    const verdict = getSafeToRunVerdict(checks);
    expect(verdict.evidence).toHaveLength(2);
    expect(verdict.evidence[0].status).toBe('PASS');
    expect(verdict.evidence[1].status).toBe('FAIL');
  });
});

// ============================================================
// Timing Report Generation
// ============================================================

describe('Timing report generation', () => {
  test('getTimingReport with null summary returns empty report', () => {
    const report = getTimingReport(null);
    expect(report.totalMs).toBe(0);
    expect(report.stages).toEqual([]);
    expect(report.bottleneck).toBeNull();
  });

  test('getTimingReport with valid summary returns structured report', () => {
    const summary = {
      duration: {
        totalMs: 30000,
        totalSec: 30,
        stages: {
          countryResearch: { durationMs: 15000, durationSec: 15, failed: false },
          synthesis: { durationMs: 10000, durationSec: 10, failed: false },
          pptGeneration: { durationMs: 5000, durationSec: 5, failed: false },
        },
        slowestStage: 'countryResearch',
        slowestStageMs: 15000,
      },
    };
    const report = getTimingReport(summary);
    expect(report.totalMs).toBe(30000);
    expect(report.totalSec).toBe(30);
    expect(report.stages.length).toBe(3);
    expect(report.bottleneck).toBe('countryResearch');
    expect(report.bottleneckPercent).toBe(50);
  });

  test('getTimingReport stages sorted by duration descending', () => {
    const summary = {
      duration: {
        totalMs: 30000,
        totalSec: 30,
        stages: {
          a: { durationMs: 5000, durationSec: 5, failed: false },
          b: { durationMs: 15000, durationSec: 15, failed: false },
          c: { durationMs: 10000, durationSec: 10, failed: false },
        },
        slowestStage: 'b',
        slowestStageMs: 15000,
      },
    };
    const report = getTimingReport(summary);
    expect(report.stages[0].name).toBe('b');
    expect(report.stages[1].name).toBe('c');
    expect(report.stages[2].name).toBe('a');
  });

  test('getTimingReport is valid JSON', () => {
    const summary = generateSummary({});
    const report = getTimingReport(summary);
    const json = JSON.stringify(report);
    expect(() => JSON.parse(json)).not.toThrow();
    // No ANSI codes
    expect(json.includes(String.fromCharCode(0x1b))).toBe(false);
  });
});

// ============================================================
// Memory Report Generation
// ============================================================

describe('Memory report generation', () => {
  test('getMemoryReport with null summary returns empty report', () => {
    const report = getMemoryReport(null);
    expect(report.peakHeapMB).toBe(0);
    expect(report.gcPressure).toBe('none');
    expect(report.headroomMB).toBe(450);
  });

  test('getMemoryReport with valid summary returns structured report', () => {
    const summary = {
      memory: {
        peakHeapMB: 200,
        peakRssMB: 300,
        peakStage: 'synthesis',
        headroomMB: 150,
        memoryLimitMB: 450,
        utilizationPercent: 67,
        current: { heapUsed: 150 },
      },
      duration: {
        totalMs: 60000,
        stages: {
          research: { durationMs: 30000 },
          synthesis: { durationMs: 30000 },
        },
      },
    };
    const report = getMemoryReport(summary);
    expect(report.peakHeapMB).toBe(200);
    expect(report.peakRssMB).toBe(300);
    expect(report.peakStage).toBe('synthesis');
    expect(report.gcPressure).toBe('moderate');
    expect(report.memoryLimitMB).toBe(450);
  });

  test('getMemoryReport GC pressure levels', () => {
    // Critical: > 90%
    const critical = getMemoryReport({
      memory: { utilizationPercent: 95, peakHeapMB: 400, peakRssMB: 430, headroomMB: 20, memoryLimitMB: 450 },
    });
    expect(critical.gcPressure).toBe('critical');

    // High: > 75%
    const high = getMemoryReport({
      memory: { utilizationPercent: 80, peakHeapMB: 300, peakRssMB: 360, headroomMB: 90, memoryLimitMB: 450 },
    });
    expect(high.gcPressure).toBe('high');

    // Low: < 50%
    const low = getMemoryReport({
      memory: { utilizationPercent: 30, peakHeapMB: 100, peakRssMB: 135, headroomMB: 315, memoryLimitMB: 450 },
    });
    expect(low.gcPressure).toBe('low');
  });

  test('getMemoryReport is valid JSON', () => {
    const summary = generateSummary({});
    const report = getMemoryReport(summary);
    const json = JSON.stringify(report);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.includes(String.fromCharCode(0x1b))).toBe(false);
  });
});

// ============================================================
// CI-Artifact Output Format Check (valid JSON)
// ============================================================

describe('CI-artifact output format check', () => {
  test('generateSummary output is serializable to valid JSON', () => {
    const summary = generateSummary({
      startTime: Date.now() - 30000,
      endTime: Date.now(),
    });
    const json = JSON.stringify(summary);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('formatSummary output contains no ANSI escape codes', () => {
    const summary = generateSummary({});
    const text = formatSummary(summary);
    const esc = String.fromCharCode(0x1b);
    expect(text.includes(esc)).toBe(false);
  });

  test('getTimingReport output is valid JSON without ANSI', () => {
    const summary = generateSummary({ startTime: Date.now() - 5000, endTime: Date.now() });
    const report = getTimingReport(summary);
    const json = JSON.stringify(report);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.includes(String.fromCharCode(0x1b))).toBe(false);
  });

  test('getMemoryReport output is valid JSON without ANSI', () => {
    const summary = generateSummary({});
    const report = getMemoryReport(summary);
    const json = JSON.stringify(report);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.includes(String.fromCharCode(0x1b))).toBe(false);
  });

  test('recommendActions output is valid JSON', () => {
    const result = recommendActions({ stage: 'complete' });
    const json = JSON.stringify(result);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('executeRunbook output is valid JSON', () => {
    const result = executeRunbook('OOM');
    const json = JSON.stringify(result);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('getSafeToRunVerdict output is valid JSON', () => {
    const checks = [{ name: 'env-vars', pass: true, output: 'ok' }];
    const verdict = getSafeToRunVerdict(checks);
    const json = JSON.stringify(verdict);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('generateCommandCookbook output is valid JSON', () => {
    const cookbook = generateCommandCookbook();
    const json = JSON.stringify(cookbook);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(cookbook).toHaveProperty('generated');
    expect(cookbook).toHaveProperty('timestamp');
  });
});

// ============================================================
// Performance Summary (perf-profiler)
// ============================================================

describe('Performance summary', () => {
  beforeEach(() => {
    metricsStore.clear();
  });

  test('getPerformanceSummary with no data returns hasData=false', () => {
    const summary = getPerformanceSummary();
    expect(summary.hasData).toBe(false);
    expect(summary.latest).toBeNull();
  });

  test('getPerformanceSummary with recorded run returns full breakdown', () => {
    metricsStore.startRun('test-run-1');
    metricsStore.recordStageStart('scopeParsing');
    metricsStore.recordStageEnd('scopeParsing', {});
    metricsStore.recordStageStart('countryResearch');
    metricsStore.recordStageEnd('countryResearch', {});
    metricsStore.endRun(true);

    const summary = getPerformanceSummary();
    expect(summary.hasData).toBe(true);
    expect(summary.latest).not.toBeNull();
    expect(summary.latest.runId).toBe('test-run-1');
    expect(summary.latest.success).toBe(true);
    expect(summary.latest.stageCount).toBe(2);
    expect(summary.latest.stages.length).toBe(2);
    expect(summary.latest.memory).toHaveProperty('peakHeapMB');
    expect(summary.latest.parallelism).toHaveProperty('parallelStageCount');
  });

  test('getPerformanceSummary tracks parallelism utilization', () => {
    metricsStore.startRun('test-run-2');
    metricsStore.recordStageStart('countryResearch'); // parallelizable
    metricsStore.recordStageEnd('countryResearch', {});
    metricsStore.recordStageStart('synthesis'); // sequential
    metricsStore.recordStageEnd('synthesis', {});
    metricsStore.endRun(true);

    const summary = getPerformanceSummary();
    expect(summary.latest.parallelism.parallelStageCount).toBe(1);
    expect(typeof summary.latest.parallelism.parallelismUtilization).toBe('number');
  });

  test('getPerformanceSummary output is valid JSON', () => {
    metricsStore.startRun('test-run-3');
    metricsStore.recordStageStart('scopeParsing');
    metricsStore.recordStageEnd('scopeParsing', {});
    metricsStore.endRun(true);

    const summary = getPerformanceSummary();
    const json = JSON.stringify(summary);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('getPerformanceSummary stages sorted by duration descending', () => {
    metricsStore.startRun('test-run-4');

    // Simulate stages with different durations by manipulating store directly
    metricsStore.recordStageStart('scopeParsing');
    metricsStore.recordStageEnd('scopeParsing', {});
    metricsStore.recordStageStart('countryResearch');
    // Add a small delay
    const cr = metricsStore.getCurrentRun().stages.countryResearch;
    cr.startTime = cr.startTime - 100; // make it look like 100ms longer
    metricsStore.recordStageEnd('countryResearch', {});

    metricsStore.endRun(true);

    const summary = getPerformanceSummary();
    if (summary.latest.stages.length >= 2) {
      expect(summary.latest.stages[0].durationMs).toBeGreaterThanOrEqual(summary.latest.stages[1].durationMs);
    }
  });
});

// ============================================================
// Existing ops-runbook functions still work
// ============================================================

describe('Existing ops-runbook exports preserved', () => {
  test('validateLocal returns { passed, steps }', () => {
    const result = validateLocal();
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('steps');
    expect(Array.isArray(result.steps)).toBe(true);
  });

  test('triageError matches known patterns', () => {
    const result = triageError('PPT structural check failed');
    expect(result.matched).toBe(true);
    expect(result.rootCause).toBeTruthy();
    expect(Array.isArray(result.fix)).toBe(true);
  });

  test('triageError with null returns unmatched', () => {
    const result = triageError(null);
    expect(result.matched).toBe(false);
  });

  test('getPlaybook returns known playbook', () => {
    const result = getPlaybook('ppt-repair');
    expect(result.found).toBe(true);
    expect(result.title).toBeTruthy();
    expect(Array.isArray(result.steps)).toBe(true);
  });

  test('getPlaybook with unknown name returns not found', () => {
    const result = getPlaybook('nonexistent');
    expect(result.found).toBe(false);
    expect(result.availablePlaybooks.length).toBeGreaterThan(0);
  });

  test('ERROR_PATTERNS is non-empty array', () => {
    expect(Array.isArray(ERROR_PATTERNS)).toBe(true);
    expect(ERROR_PATTERNS.length).toBeGreaterThan(5);
  });

  test('PLAYBOOKS has expected keys', () => {
    expect(PLAYBOOKS).toHaveProperty('ppt-repair');
    expect(PLAYBOOKS).toHaveProperty('quality-gate-failing');
    expect(PLAYBOOKS).toHaveProperty('slow-pipeline');
  });

  test('COMMANDS has expected categories', () => {
    expect(COMMANDS).toHaveProperty('Health Checks');
    expect(COMMANDS).toHaveProperty('Debugging');
    expect(COMMANDS).toHaveProperty('Profiling');
  });
});

// ============================================================
// generateCommandCookbook
// ============================================================

describe('generateCommandCookbook', () => {
  test('returns generated array and timestamp', () => {
    const cookbook = generateCommandCookbook();
    expect(Array.isArray(cookbook.generated)).toBe(true);
    expect(typeof cookbook.timestamp).toBe('string');
  });

  test('finds CLI scripts in market-research directory', () => {
    const cookbook = generateCommandCookbook();
    // ops-runbook.js itself has CLI usage comments
    const opsEntry = cookbook.generated.find((g) => g.file === 'ops-runbook.js');
    expect(opsEntry).toBeDefined();
    expect(opsEntry.commands.length).toBeGreaterThan(0);
  });

  test('each entry has file and commands array', () => {
    const cookbook = generateCommandCookbook();
    for (const entry of cookbook.generated) {
      expect(typeof entry.file).toBe('string');
      expect(Array.isArray(entry.commands)).toBe(true);
      for (const cmd of entry.commands) {
        expect(typeof cmd).toBe('string');
      }
    }
  });
});

// ============================================================
// Integration: end-to-end readiness -> verdict flow
// ============================================================

describe('End-to-end readiness to verdict flow', () => {
  test('runLocalReadiness fast-check -> getSafeToRunVerdict produces coherent result', () => {
    const readiness = runLocalReadiness({ mode: 'fast-check' });
    const verdict = getSafeToRunVerdict(readiness.checks);
    expect(typeof verdict.safe).toBe('boolean');
    expect(typeof verdict.verdict).toBe('string');
    expect(Array.isArray(verdict.evidence)).toBe(true);
    expect(verdict.evidence.length).toBe(readiness.checks.length);
  });
});
