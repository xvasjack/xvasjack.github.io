// Tests for perf-profiler, ops-runbook, and post-run-summary modules.

'use strict';

const {
  PIPELINE_STAGES,
  SEQUENTIAL_STAGES,
  PARALLELIZABLE_STAGES,
  metricsStore,
  profile,
  getStageMetrics,
  getHighCostStages,
  getParallelismRecommendations,
  contentSizeCheckTelemetry,
  estimatePayloadSize,
} = require('./perf-profiler');

const { triageError, getPlaybook, getCommands, validateLocal } = require('./ops-runbook');

const { generateSummary, formatSummary, HEALTH_THRESHOLDS } = require('./post-run-summary');

// Helper to sleep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  metricsStore.clear();
});

// ============ perf-profiler tests ============

describe('perf-profiler', () => {
  test('1. PIPELINE_STAGES contains all expected stages', () => {
    expect(PIPELINE_STAGES).toContain('scopeParsing');
    expect(PIPELINE_STAGES).toContain('countryResearch');
    expect(PIPELINE_STAGES).toContain('synthesis');
    expect(PIPELINE_STAGES).toContain('pptGeneration');
    expect(PIPELINE_STAGES).toContain('emailDelivery');
    expect(PIPELINE_STAGES.length).toBeGreaterThanOrEqual(10);
  });

  test('2. SEQUENTIAL and PARALLELIZABLE stages do not overlap', () => {
    for (const stage of SEQUENTIAL_STAGES) {
      expect(PARALLELIZABLE_STAGES.has(stage)).toBe(false);
    }
    for (const stage of PARALLELIZABLE_STAGES) {
      expect(SEQUENTIAL_STAGES.has(stage)).toBe(false);
    }
  });

  test('3. profile() records correct timing for a stage', async () => {
    metricsStore.startRun('test-timing');

    const fn = profile('testStage', async () => {
      await sleep(50);
      return { data: 'result' };
    });

    const result = await fn();
    expect(result).toEqual({ data: 'result' });

    const run = metricsStore.endRun(true);
    expect(run.stages.testStage).toBeDefined();
    expect(run.stages.testStage.durationMs).toBeGreaterThanOrEqual(40);
    expect(run.stages.testStage.durationMs).toBeLessThan(500);
    expect(run.stages.testStage.failed).toBe(false);
    expect(run.stages.testStage.error).toBeNull();
  });

  test('4. profile() records failure when function throws', async () => {
    metricsStore.startRun('test-failure');

    const fn = profile('failStage', async () => {
      throw new Error('Stage exploded');
    });

    await expect(fn()).rejects.toThrow('Stage exploded');

    const run = metricsStore.endRun(false);
    expect(run.stages.failStage.failed).toBe(true);
    expect(run.stages.failStage.error).toBe('Stage exploded');
    expect(run.stages.failStage.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('5. Memory telemetry captures snapshots at stage boundaries', async () => {
    metricsStore.startRun('test-memory');

    const fn = profile('memStage', async () => {
      // Allocate some memory to ensure measurable usage
      const arr = new Array(1000).fill('x'.repeat(100));
      return arr.length;
    });

    await fn();
    const run = metricsStore.endRun(true);

    const stage = run.stages.memStage;
    expect(stage.memoryAtStart).toBeDefined();
    expect(stage.memoryAtStart.heapUsedMB).toBeGreaterThanOrEqual(0);
    expect(stage.memoryAtStart.rssMB).toBeGreaterThan(0);
    expect(stage.memoryAtEnd).toBeDefined();
    expect(stage.memoryAtEnd.heapUsedMB).toBeGreaterThanOrEqual(0);
    expect(stage.memoryAtEnd.rssMB).toBeGreaterThan(0);
  });

  test('6. estimatePayloadSize handles various types', () => {
    expect(estimatePayloadSize(null)).toBe(0);
    expect(estimatePayloadSize(undefined)).toBe(0);
    expect(estimatePayloadSize('hello')).toBe(5);
    expect(estimatePayloadSize(Buffer.from('test'))).toBe(4);
    expect(estimatePayloadSize({ key: 'value' })).toBeGreaterThan(0);
    expect(estimatePayloadSize([1, 2, 3])).toBeGreaterThan(0);
  });

  test('7. getStageMetrics computes p50/p95 across multiple runs', async () => {
    // Simulate 3 runs with the same stage
    for (let i = 0; i < 3; i++) {
      metricsStore.startRun(`run-${i}`);
      metricsStore.recordStageStart('research');
      await sleep(20 + i * 10);
      metricsStore.recordStageEnd('research', { payloadSizeBytes: 1000 + i * 500 });
      metricsStore.endRun(true);
    }

    const metrics = getStageMetrics();
    expect(metrics.runs).toBe(3);
    expect(metrics.stages.research).toBeDefined();
    expect(metrics.stages.research.runs).toBe(3);
    expect(metrics.stages.research.failureRate).toBe(0);
    expect(metrics.stages.research.p50DurationMs).toBeGreaterThan(0);
    expect(metrics.stages.research.p95DurationMs).toBeGreaterThanOrEqual(
      metrics.stages.research.p50DurationMs
    );
    expect(metrics.stages.research.avgPayloadSizeBytes).toBeGreaterThan(0);
  });

  test('8. getHighCostStages identifies the correct failing stage', async () => {
    // Run 1: fail at synthesis (late stage)
    metricsStore.startRun('run-fail-1');
    metricsStore.recordStageStart('scopeParsing');
    await sleep(10);
    metricsStore.recordStageEnd('scopeParsing');
    metricsStore.recordStageStart('countryResearch');
    await sleep(30);
    metricsStore.recordStageEnd('countryResearch');
    metricsStore.recordStageStart('synthesis');
    await sleep(10);
    metricsStore.recordStageEnd('synthesis', { failed: true, error: 'quality too low' });
    metricsStore.endRun(false);

    // Run 2: succeed
    metricsStore.startRun('run-ok-2');
    metricsStore.recordStageStart('scopeParsing');
    await sleep(10);
    metricsStore.recordStageEnd('scopeParsing');
    metricsStore.recordStageStart('countryResearch');
    await sleep(30);
    metricsStore.recordStageEnd('countryResearch');
    metricsStore.recordStageStart('synthesis');
    await sleep(10);
    metricsStore.recordStageEnd('synthesis');
    metricsStore.endRun(true);

    const result = getHighCostStages();
    expect(result.stages.length).toBeGreaterThan(0);
    // Synthesis should have the highest cost of failure since it fails late
    const synthStage = result.stages.find((s) => s.stage === 'synthesis');
    expect(synthStage).toBeDefined();
    expect(synthStage.failureRate).toBe(0.5);
    expect(synthStage.costOfFailure).toBeGreaterThan(0);
  });

  test('9. getParallelismRecommendations returns entries', async () => {
    // Need at least one run with a parallelizable stage
    metricsStore.startRun('run-par');
    metricsStore.recordStageStart('countryResearch');
    await sleep(10);
    metricsStore.recordStageEnd('countryResearch');
    metricsStore.recordStageStart('scopeParsing');
    await sleep(10);
    metricsStore.recordStageEnd('scopeParsing');
    metricsStore.endRun(true);

    const recs = getParallelismRecommendations();
    expect(Array.isArray(recs)).toBe(true);
    expect(recs.length).toBeGreaterThan(0);

    const crRec = recs.find((r) => r.stage === 'countryResearch');
    expect(crRec).toBeDefined();
    expect(crRec.isParallelizable).toBe(true);
    expect(crRec.maxConcurrencyUnder450MB).toBeGreaterThanOrEqual(1);

    const spRec = recs.find((r) => r.stage === 'scopeParsing');
    expect(spRec).toBeDefined();
    expect(spRec.isParallelizable).toBe(false);
  });

  test('10. contentSizeCheckTelemetry generates correct telemetry', () => {
    const budgetResult = {
      report: {
        risk: 'medium',
        issues: ['Field "market.overview" is 800 chars (limit 600)'],
        fieldBudgets: [
          { section: 'market', key: 'overview', charCount: 800, limit: 600, exceeded: true },
          { section: 'policy', key: 'summary', charCount: 400, limit: 500, exceeded: false },
        ],
        tableDensity: [
          { section: 'competitors', key: 'list', rows: 20, cols: 5, overBudget: true },
        ],
        chartSanity: [
          { section: 'market', key: 'growth', dataPoints: 6, issue: null },
          { section: 'market', key: 'empty', dataPoints: 1, issue: 'Too few points' },
        ],
      },
      compactionLog: [
        { section: 'market', key: 'overview', action: 'trimmed', before: 800, after: 600 },
      ],
    };

    const telemetry = contentSizeCheckTelemetry(budgetResult, 'Vietnam');
    expect(telemetry.country).toBe('Vietnam');
    expect(telemetry.risk).toBe('medium');
    expect(telemetry.fieldsCompacted).toBe(1);
    expect(telemetry.qualityImpact).toBe('minimal');
    expect(telemetry.fieldAnalysis.total).toBe(2);
    expect(telemetry.fieldAnalysis.exceeded).toBe(1);
    expect(telemetry.tableAnalysis.overBudget).toBe(1);
    expect(telemetry.chartAnalysis.withIssues).toBe(1);
    expect(telemetry.compactionDetails[0].reduction).toBe(25); // 25% reduction
  });

  test('11. contentSizeCheckTelemetry handles null input', () => {
    const telemetry = contentSizeCheckTelemetry(null, 'Test');
    expect(telemetry.country).toBe('Test');
    expect(telemetry.error).toBeDefined();
  });
});

// ============ ops-runbook tests ============

describe('ops-runbook', () => {
  test('12. triageError matches known error patterns', () => {
    const result = triageError('PPT structural check failed: Min slides');
    expect(result.matched).toBe(true);
    expect(result.rootCause).toContain('malformed');
    expect(result.fix.length).toBeGreaterThan(0);
  });

  test('13. triageError returns generic steps for unknown errors', () => {
    const result = triageError('Something completely unexpected happened');
    expect(result.matched).toBe(false);
    expect(result.fix).toBeDefined();
    expect(result.fix.length).toBeGreaterThan(0);
  });

  test('14. triageError handles null/empty input', () => {
    expect(triageError(null).matched).toBe(false);
    expect(triageError('').matched).toBe(false);
    expect(triageError(undefined).matched).toBe(false);
  });

  test('15. getPlaybook returns known playbook', () => {
    const result = getPlaybook('ppt-repair');
    expect(result.found).toBe(true);
    expect(result.title).toContain('repair');
    expect(result.steps.length).toBeGreaterThan(0);
  });

  test('16. getPlaybook lists available playbooks for unknown name', () => {
    const result = getPlaybook('nonexistent');
    expect(result.found).toBe(false);
    expect(result.availablePlaybooks.length).toBeGreaterThan(0);
    expect(result.availablePlaybooks).toContain('ppt-repair');
    expect(result.availablePlaybooks).toContain('quality-gate-failing');
  });

  test('17. getCommands returns all categories', () => {
    const cmds = getCommands();
    expect(Object.keys(cmds).length).toBeGreaterThan(3);
    expect(cmds['Health Checks']).toBeDefined();
    expect(cmds['Debugging']).toBeDefined();
    expect(Array.isArray(cmds['Health Checks'])).toBe(true);
    for (const entry of cmds['Health Checks']) {
      expect(entry.cmd).toBeDefined();
      expect(entry.desc).toBeDefined();
    }
  });

  test('18. getCommands filters by category', () => {
    const cmds = getCommands('Debugging');
    expect(Object.keys(cmds)).toEqual(['Debugging']);
  });

  test('19. validateLocal returns step results', () => {
    const result = validateLocal();
    expect(result).toHaveProperty('passed');
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.steps.length).toBeGreaterThanOrEqual(3);
    for (const step of result.steps) {
      expect(step).toHaveProperty('name');
      expect(step).toHaveProperty('passed');
      expect(step).toHaveProperty('output');
      expect(step).toHaveProperty('command');
    }
  });

  test('20. triageError matches memory errors', () => {
    const result = triageError('FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory');
    expect(result.matched).toBe(true);
    expect(result.rootCause).toContain('memory');
  });

  test('21. triageError matches content size check errors', () => {
    const result = triageError('Budget gate risk is high for Vietnam');
    expect(result.matched).toBe(true);
    expect(result.rootCause).toContain('overflow');
  });
});

// ============ post-run-summary tests ============

describe('post-run-summary', () => {
  test('22. generateSummary returns valid structure with no input', () => {
    const summary = generateSummary();
    expect(summary).toHaveProperty('timestamp');
    expect(summary).toHaveProperty('duration');
    expect(summary).toHaveProperty('memory');
    expect(summary).toHaveProperty('qualityGates');
    expect(summary).toHaveProperty('contentSizeCheck');
    expect(summary).toHaveProperty('fileSafety');
    expect(summary).toHaveProperty('health');
    expect(summary.health.status).toBe('healthy');
  });

  test('23. generateSummary includes profiler data when available', async () => {
    metricsStore.startRun('summary-test');
    metricsStore.recordStageStart('synthesis');
    await sleep(20);
    metricsStore.recordStageEnd('synthesis');
    metricsStore.endRun(true);

    const summary = generateSummary({
      startTime: Date.now() - 5000,
      endTime: Date.now(),
    });

    expect(summary.duration.totalMs).toBeGreaterThan(0);
    expect(summary.memory.current.heapUsed).toBeGreaterThan(0);
  });

  test('24. generateSummary incorporates runInfo', () => {
    const runInfo = {
      countries: [
        { country: 'Vietnam', synthesisScores: { overall: 75 }, synthesisValid: true },
        { country: 'Thailand', synthesisScores: { overall: 65 }, synthesisValid: true },
      ],
      contentSizeCheck: {
        Vietnam: { risk: 'medium', issues: ['field too long'], compacted: 2 },
        Thailand: { risk: 'low', issues: [], compacted: 0 },
      },
      pptStructure: {
        valid: true,
        passed: 8,
        failed: 0,
        warnings: 1,
      },
    };

    const summary = generateSummary({ runInfo });

    expect(summary.qualityGates.researchQuality.avgScore).toBe(70);
    expect(summary.contentSizeCheck.totalCompactions).toBe(2);
    expect(summary.contentSizeCheck.worstRisk).toBe('medium');
    expect(summary.fileSafety.valid).toBe(true);
    expect(summary.fileSafety.score).toBeGreaterThan(80);
  });

  test('25. formatSummary produces readable text', () => {
    const summary = generateSummary();
    const text = formatSummary(summary);

    expect(typeof text).toBe('string');
    expect(text).toContain('POST-RUN SUMMARY');
    expect(text).toContain('Duration:');
    expect(text).toContain('Memory:');
    expect(text).toContain('Quality Gates:');
    expect(text).toContain('Content Size Check:');
    expect(text).toContain('FileSafety:');
    expect(text).toContain('Health:');
  });

  test('26. health assessment flags unhealthy when fileSafety fails', () => {
    const runInfo = {
      pptStructure: {
        valid: false,
        passed: 5,
        failed: 4,
        warnings: 1,
      },
    };

    const summary = generateSummary({ runInfo });
    expect(summary.health.status).toBe('unhealthy');
    expect(summary.health.issues.length).toBeGreaterThan(0);
    expect(summary.health.issues.some((i) => i.includes('fileSafety'))).toBe(true);
  });

  test('27. health assessment flags degraded when content size check risk is high', () => {
    const runInfo = {
      contentSizeCheck: {
        Vietnam: { risk: 'high', issues: ['a', 'b', 'c'], compacted: 12 },
      },
    };

    const summary = generateSummary({ runInfo });
    expect(summary.health.status).toBe('degraded');
    expect(summary.health.issues.some((i) => i.includes('compaction') || i.includes('risk'))).toBe(
      true
    );
  });
});
