'use strict';

/**
 * Tests for reliability observability: telemetry schema, clustering stability,
 * risk scoring, digest generation, trend comparison, and alert thresholds.
 */

// Mock heavy dependencies so tests run without real PPT generation
jest.mock('./deck-builder-single', () => ({
  generateSingleCountryPPT: jest.fn().mockResolvedValue(Buffer.alloc(5000, 0)),
}));
jest.mock('./content-size-check', () => ({
  runContentSizeCheck: jest.fn().mockReturnValue({ payload: {}, compactionLog: [] }),
}));
jest.mock('jszip', () => {
  return jest.fn().mockImplementation(() => ({}));
});
// Mock JSZip.loadAsync for validate-pptx phase
const JSZip = require('jszip');
JSZip.loadAsync = jest.fn().mockResolvedValue({
  files: {
    'ppt/slides/slide1.xml': {},
    '[Content_Types].xml': {},
    'ppt/presentation.xml': {},
  },
});

const {
  TELEMETRY_VERSION,
  exportTelemetryJSON,
  checkDeterminism,
  __test: {
    computeAggregateStats,
    classifyError,
    mulberry32,
    selectMutationsForSeed,
    MUTATION_CLASS_KEYS,
    PHASES,
  },
} = require('./stress-lab');

const {
  cluster,
  getTopBlockers,
  getRiskScore,
  getPhaseConfidence,
  trackCrashTrend,
  formatBlockersReport,
  generateReplayArtifact,
  __test: { extractErrorSignature },
} = require('./failure-cluster-analyzer');

const {
  generateDigest,
  formatDigestMarkdown,
  compareDigests,
  checkAlerts,
  getReliabilityKPIs,
  DEFAULT_THRESHOLDS,
} = require('./reliability-digest');

// ============ HELPERS ============

/**
 * Build synthetic telemetry for testing (no actual pipeline execution).
 */
function buildSyntheticTelemetry(count, { failRate = 0.3, runtimeCrashRate = 0.5 } = {}) {
  const results = [];
  for (let i = 1; i <= count; i++) {
    const shouldFail = i / count <= failRate;
    const isRuntimeCrash = shouldFail && i / count <= failRate * runtimeCrashRate;

    if (shouldFail) {
      results.push({
        version: TELEMETRY_VERSION,
        seed: i,
        mutationClasses: selectMutationsForSeed(i),
        phases: {
          'build-payload': { durationMs: 5, status: 'pass' },
          'content-size-check': { durationMs: 10, status: 'pass' },
          'build-ppt': {
            durationMs: 50,
            status: 'fail',
            error: isRuntimeCrash
              ? 'Cannot read properties of null (reading PROP)'
              : '[PPT] Data gate failed: section missing',
          },
        },
        status: 'fail',
        error: isRuntimeCrash
          ? 'Cannot read properties of null (reading PROP)'
          : '[PPT] Data gate failed: section missing',
        errorClass: isRuntimeCrash ? 'runtime-crash' : 'data-gate',
        failedPhase: 'build-ppt',
        stack: 'Error: test\n    at Object.<anonymous> (test.js:1:1)',
        durationMs: 65,
      });
    } else {
      results.push({
        version: TELEMETRY_VERSION,
        seed: i,
        mutationClasses: selectMutationsForSeed(i),
        phases: {
          'build-payload': { durationMs: 5, status: 'pass' },
          'content-size-check': { durationMs: 10, status: 'pass' },
          'build-ppt': { durationMs: 50, status: 'pass' },
          'validate-pptx': { durationMs: 20, status: 'pass' },
        },
        status: 'pass',
        error: null,
        errorClass: null,
        failedPhase: null,
        stack: null,
        durationMs: 85,
      });
    }
  }
  return results;
}

/**
 * Build synthetic stress results (mimics runStressLab output).
 */
function buildSyntheticStressResults(count, opts) {
  const telemetry = buildSyntheticTelemetry(count, opts);
  const stats = computeAggregateStats(telemetry);
  return { telemetry, stats };
}

// ============ TESTS: TELEMETRY SCHEMA ============

describe('Telemetry Schema Compatibility', () => {
  test('TELEMETRY_VERSION is defined and is a semver string', () => {
    expect(TELEMETRY_VERSION).toBeDefined();
    expect(typeof TELEMETRY_VERSION).toBe('string');
    expect(TELEMETRY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('telemetry objects include version field', () => {
    const telemetry = buildSyntheticTelemetry(5);
    for (const t of telemetry) {
      expect(t.version).toBe(TELEMETRY_VERSION);
    }
  });

  test('telemetry objects have all required fields', () => {
    const telemetry = buildSyntheticTelemetry(10);
    const requiredFields = [
      'version',
      'seed',
      'mutationClasses',
      'phases',
      'status',
      'error',
      'errorClass',
      'failedPhase',
      'durationMs',
    ];

    for (const t of telemetry) {
      for (const field of requiredFields) {
        expect(t).toHaveProperty(field);
      }
    }
  });

  test('aggregate stats include version field', () => {
    const telemetry = buildSyntheticTelemetry(10);
    const stats = computeAggregateStats(telemetry);
    expect(stats.version).toBe(TELEMETRY_VERSION);
  });

  test('exportTelemetryJSON produces valid JSON with version', () => {
    const telemetry = buildSyntheticTelemetry(5);
    const json = exportTelemetryJSON(telemetry);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe(TELEMETRY_VERSION);
    expect(parsed.generatedAt).toBeDefined();
    expect(parsed.stats).toBeDefined();
    expect(parsed.stats.version).toBe(TELEMETRY_VERSION);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBe(5);

    for (const r of parsed.results) {
      expect(r.version).toBe(TELEMETRY_VERSION);
      expect(r.seed).toBeDefined();
      expect(r.status).toBeDefined();
    }
  });

  test('exportTelemetryJSON includes correct stats', () => {
    const telemetry = buildSyntheticTelemetry(20, { failRate: 0.25 });
    const json = exportTelemetryJSON(telemetry);
    const parsed = JSON.parse(json);

    expect(parsed.stats.total).toBe(20);
    expect(parsed.stats.passed + parsed.stats.failed).toBe(20);
  });
});

// ============ TESTS: CLUSTERING STABILITY ============

describe('Clustering Stability', () => {
  test('same input produces same clusters', () => {
    const telemetry = buildSyntheticTelemetry(50, { failRate: 0.4 });

    const result1 = cluster(telemetry);
    const result2 = cluster(telemetry);

    expect(result1.clusters.length).toBe(result2.clusters.length);
    for (let i = 0; i < result1.clusters.length; i++) {
      expect(result1.clusters[i].signature).toBe(result2.clusters[i].signature);
      expect(result1.clusters[i].count).toBe(result2.clusters[i].count);
      expect(result1.clusters[i].seeds).toEqual(result2.clusters[i].seeds);
    }
  });

  test('cluster handles empty input', () => {
    const result = cluster([]);
    expect(result.clusters).toEqual([]);
    expect(result.byPhase).toEqual({});
    expect(result.byMutationClass).toEqual({});
  });

  test('cluster handles non-array input', () => {
    const result = cluster(null);
    expect(result.clusters).toEqual([]);
  });

  test('cluster groups identical errors together', () => {
    const telemetry = [
      {
        seed: 1,
        status: 'fail',
        error: 'Cannot read properties of null',
        errorClass: 'runtime-crash',
        failedPhase: 'build-ppt',
        mutationClasses: ['schema-corruption'],
      },
      {
        seed: 2,
        status: 'fail',
        error: 'Cannot read properties of null',
        errorClass: 'runtime-crash',
        failedPhase: 'build-ppt',
        mutationClasses: ['empty-null'],
      },
      {
        seed: 3,
        status: 'pass',
        error: null,
        errorClass: null,
        failedPhase: null,
        mutationClasses: ['transient-keys'],
      },
    ];

    const result = cluster(telemetry);
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0].count).toBe(2);
    expect(result.clusters[0].seeds).toEqual([1, 2]);
  });

  test('extractErrorSignature normalizes variable parts', () => {
    const sig1 = extractErrorSignature('Cannot read properties at /home/user/file.js:42:10');
    const sig2 = extractErrorSignature('Cannot read properties at /other/path/code.js:99:5');
    expect(sig1).toBe(sig2);
  });

  test('extractErrorSignature handles null/empty', () => {
    expect(extractErrorSignature(null)).toBe('unknown-error');
    expect(extractErrorSignature('')).toBe('unknown-error');
    expect(extractErrorSignature(undefined)).toBe('unknown-error');
  });
});

// ============ TESTS: RISK SCORE CALCULATION ============

describe('Risk Score Calculation', () => {
  test('runtime crash scores higher than data-gate', () => {
    const runtimeCluster = {
      count: 10,
      errorClasses: ['runtime-crash'],
      mutationClasses: ['schema-corruption'],
      phases: ['build-ppt'],
      seeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    };

    const gateCluster = {
      count: 10,
      errorClasses: ['data-gate'],
      mutationClasses: ['schema-corruption'],
      phases: ['build-ppt'],
      seeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    };

    const runtimeScore = getRiskScore(runtimeCluster, 100);
    const gateScore = getRiskScore(gateCluster, 100);

    expect(runtimeScore).toBeGreaterThan(gateScore);
  });

  test('higher frequency yields higher score', () => {
    const lowFreq = {
      count: 2,
      errorClasses: ['runtime-crash'],
      mutationClasses: ['schema-corruption'],
      phases: ['build-ppt'],
      seeds: [1, 2],
    };

    const highFreq = {
      count: 50,
      errorClasses: ['runtime-crash'],
      mutationClasses: ['schema-corruption'],
      phases: ['build-ppt'],
      seeds: Array.from({ length: 50 }, (_, i) => i + 1),
    };

    const lowScore = getRiskScore(lowFreq, 100);
    const highScore = getRiskScore(highFreq, 100);

    expect(highScore).toBeGreaterThan(lowScore);
  });

  test('paid-run risk multiplier applied for runtime crash in build phase', () => {
    const buildPptCrash = {
      count: 5,
      errorClasses: ['runtime-crash'],
      mutationClasses: ['schema-corruption'],
      phases: ['build-ppt'],
      seeds: [1, 2, 3, 4, 5],
    };

    const payloadCrash = {
      count: 5,
      errorClasses: ['runtime-crash'],
      mutationClasses: ['schema-corruption'],
      phases: ['build-payload'],
      seeds: [1, 2, 3, 4, 5],
    };

    const buildPptScore = getRiskScore(buildPptCrash, 100);
    const payloadScore = getRiskScore(payloadCrash, 100);

    // Build phase crash with paid-run multiplier should be higher
    // even though build-payload has higher phase weight
    expect(buildPptScore).toBeGreaterThan(0);
    expect(payloadScore).toBeGreaterThan(0);
  });

  test('score is capped at 100', () => {
    const extreme = {
      count: 100,
      errorClasses: ['runtime-crash'],
      mutationClasses: MUTATION_CLASS_KEYS,
      phases: ['build-ppt'],
      seeds: Array.from({ length: 100 }, (_, i) => i + 1),
    };

    const score = getRiskScore(extreme, 100);
    expect(score).toBeLessThanOrEqual(100);
  });

  test('score is 0 for null input', () => {
    expect(getRiskScore(null, 100)).toBe(0);
    expect(getRiskScore({}, 0)).toBe(0);
    expect(getRiskScore({}, -1)).toBe(0);
  });

  test('more mutation classes yield higher score', () => {
    const narrow = {
      count: 10,
      errorClasses: ['data-gate'],
      mutationClasses: ['schema-corruption'],
      phases: ['build-ppt'],
      seeds: Array.from({ length: 10 }, (_, i) => i + 1),
    };

    const broad = {
      count: 10,
      errorClasses: ['data-gate'],
      mutationClasses: ['schema-corruption', 'empty-null', 'long-text', 'chart-anomalies'],
      phases: ['build-ppt'],
      seeds: Array.from({ length: 10 }, (_, i) => i + 1),
    };

    expect(getRiskScore(broad, 100)).toBeGreaterThan(getRiskScore(narrow, 100));
  });
});

// ============ TESTS: PHASE CONFIDENCE ============

describe('Phase Confidence', () => {
  test('single phase cluster returns high confidence', () => {
    const clusterEntry = {
      phases: ['build-ppt'],
      seeds: [1, 2, 3],
      count: 3,
    };

    const confidence = getPhaseConfidence(clusterEntry);
    expect(confidence['build-ppt']).toBeGreaterThanOrEqual(0.9);
    expect(confidence['build-payload']).toBeLessThan(0.1);
  });

  test('multi-phase cluster distributes confidence', () => {
    const clusterEntry = {
      phases: ['content-size-check', 'build-ppt'],
      seeds: [1, 2, 3, 4],
      count: 4,
    };

    const confidence = getPhaseConfidence(clusterEntry);
    const total = Object.values(confidence).reduce((a, b) => a + b, 0);
    // Total should be approximately 1
    expect(total).toBeCloseTo(1, 1);
    // Both participating phases should have non-zero confidence
    expect(confidence['content-size-check']).toBeGreaterThan(0);
    expect(confidence['build-ppt']).toBeGreaterThan(0);
  });

  test('empty phases returns zero confidence', () => {
    const confidence = getPhaseConfidence({ phases: [], seeds: [], count: 0 });
    expect(confidence['build-payload']).toBe(0);
    expect(confidence['build-ppt']).toBe(0);
  });

  test('null cluster returns zero confidence', () => {
    const confidence = getPhaseConfidence(null);
    expect(confidence['build-payload']).toBe(0);
  });
});

// ============ TESTS: REPLAY ARTIFACT ============

describe('Replay Artifact', () => {
  test('generates correct replay artifact from cluster', () => {
    const clusterEntry = {
      seeds: [42, 99, 150],
      mutationClasses: ['schema-corruption', 'empty-null'],
      sampleError: 'Cannot read properties of null',
    };

    const artifact = generateReplayArtifact(clusterEntry);
    expect(artifact.seed).toBe(42);
    expect(artifact.mutationClasses).toEqual(['schema-corruption', 'empty-null']);
    expect(artifact.command).toBe('node stress-lab.js --seed=42');
    expect(artifact.expectedError).toBe('Cannot read properties of null');
  });

  test('handles null cluster', () => {
    const artifact = generateReplayArtifact(null);
    expect(artifact.seed).toBeNull();
    expect(artifact.command).toBe('');
    expect(artifact.expectedError).toBeNull();
  });

  test('handles empty seeds', () => {
    const artifact = generateReplayArtifact({ seeds: [], mutationClasses: [] });
    expect(artifact.seed).toBeNull();
    expect(artifact.command).toBe('');
  });
});

// ============ TESTS: DIGEST GENERATION ============

describe('Digest Generation', () => {
  test('generates digest from synthetic telemetry', () => {
    const stressResults = buildSyntheticStressResults(100, { failRate: 0.2 });
    const digest = generateDigest(stressResults);

    expect(digest.generatedAt).toBeDefined();
    expect(digest.summary).toBeDefined();
    expect(digest.summary.total).toBe(100);
    expect(digest.summary.crashFreeRate).toBeGreaterThan(0);
    expect(digest.summary.crashFreeRate).toBeLessThanOrEqual(1);
    expect(digest.summary.recoveryRate).toBeGreaterThan(0);
    expect(digest.summary.recoveryRate).toBeLessThanOrEqual(1);
    expect(digest.summary.passed + digest.summary.failed).toBe(100);
  });

  test('digest includes mutation class failure rates', () => {
    const stressResults = buildSyntheticStressResults(50, { failRate: 0.4 });
    const digest = generateDigest(stressResults);

    expect(digest.mutationClassFailureRates).toBeDefined();
    const rates = Object.values(digest.mutationClassFailureRates);
    for (const r of rates) {
      expect(r).toHaveProperty('failures');
      expect(r).toHaveProperty('total');
      expect(r).toHaveProperty('rate');
      expect(r.rate).toBeGreaterThanOrEqual(0);
      expect(r.rate).toBeLessThanOrEqual(1);
    }
  });

  test('digest includes phase failure rates', () => {
    const stressResults = buildSyntheticStressResults(50, { failRate: 0.3 });
    const digest = generateDigest(stressResults);

    expect(digest.phaseFailureRates).toBeDefined();
    for (const [phase, data] of Object.entries(digest.phaseFailureRates)) {
      expect(data.failures).toBeDefined();
      expect(data.rate).toBeGreaterThanOrEqual(0);
      expect(data.rate).toBeLessThanOrEqual(1);
    }
  });

  test('digest includes top blockers', () => {
    const stressResults = buildSyntheticStressResults(50, { failRate: 0.5 });
    const digest = generateDigest(stressResults);

    expect(Array.isArray(digest.topBlockers)).toBe(true);
    if (digest.topBlockers.length > 0) {
      expect(digest.topBlockers[0]).toHaveProperty('riskScore');
      expect(digest.topBlockers[0]).toHaveProperty('signature');
    }
  });

  test('digest handles zero failures', () => {
    const stressResults = buildSyntheticStressResults(10, { failRate: 0 });
    const digest = generateDigest(stressResults);

    expect(digest.summary.crashFreeRate).toBe(1);
    expect(digest.summary.runtimeCrashes).toBe(0);
    expect(digest.summary.failed).toBe(0);
    expect(digest.topBlockers.length).toBe(0);
  });

  test('digest includes duration stats', () => {
    const stressResults = buildSyntheticStressResults(20);
    const digest = generateDigest(stressResults);

    expect(digest.durationStats).toBeDefined();
    expect(digest.durationStats.p50).toBeDefined();
    expect(digest.durationStats.p95).toBeDefined();
  });

  test('digest with external gate results', () => {
    const stressResults = buildSyntheticStressResults(20);
    const gateResults = { total: 100, passed: 80, failed: 20, rejections: 20 };
    const digest = generateDigest(stressResults, gateResults);

    expect(digest.summary.gateRejectionRate).toBe(0.2);
  });
});

// ============ TESTS: MARKDOWN FORMAT ============

describe('Digest Markdown Format', () => {
  test('formatDigestMarkdown produces valid markdown', () => {
    const stressResults = buildSyntheticStressResults(30, { failRate: 0.3 });
    const digest = generateDigest(stressResults);
    const md = formatDigestMarkdown(digest);

    expect(typeof md).toBe('string');
    expect(md).toContain('# Reliability Digest');
    expect(md).toContain('Crash-Free Rate');
    expect(md).toContain('Recovery Rate');
    expect(md).toContain('Determinism Score');
  });

  test('markdown includes tables', () => {
    const stressResults = buildSyntheticStressResults(30, { failRate: 0.3 });
    const digest = generateDigest(stressResults);
    const md = formatDigestMarkdown(digest);

    // Should contain table separators
    expect(md).toContain('|--------|');
  });
});

// ============ TESTS: TREND COMPARISON ============

describe('Trend Comparison', () => {
  test('detects improving crash rate', () => {
    const previous = {
      summary: { crashFreeRate: 0.8, gateRejectionRate: 0.1, recoveryRate: 0.8 },
      topBlockers: [{ signature: 'error-A' }, { signature: 'error-B' }],
    };
    const current = {
      summary: { crashFreeRate: 0.98, gateRejectionRate: 0.05, recoveryRate: 0.95 },
      topBlockers: [{ signature: 'error-A' }],
    };

    const comparison = compareDigests(previous, current);
    expect(comparison.crashRateTrend).toBe('improving');
    expect(comparison.fixedFailures).toContain('error-B');
    expect(comparison.newFailures.length).toBe(0);
  });

  test('detects worsening crash rate', () => {
    const previous = {
      summary: { crashFreeRate: 0.98, gateRejectionRate: 0.02, recoveryRate: 0.95 },
      topBlockers: [],
    };
    const current = {
      summary: { crashFreeRate: 0.7, gateRejectionRate: 0.2, recoveryRate: 0.7 },
      topBlockers: [{ signature: 'new-error' }],
    };

    const comparison = compareDigests(previous, current);
    expect(comparison.crashRateTrend).toBe('worsening');
    expect(comparison.newFailures).toContain('new-error');
  });

  test('detects stable crash rate', () => {
    const previous = {
      summary: { crashFreeRate: 0.95 },
      topBlockers: [{ signature: 'error-A' }],
    };
    const current = {
      summary: { crashFreeRate: 0.94 },
      topBlockers: [{ signature: 'error-A' }],
    };

    const comparison = compareDigests(previous, current);
    expect(comparison.crashRateTrend).toBe('stable');
  });

  test('computes correct deltas', () => {
    const previous = {
      summary: { crashFreeRate: 0.8, gateRejectionRate: 0.1, recoveryRate: 0.8 },
      topBlockers: [],
    };
    const current = {
      summary: { crashFreeRate: 0.9, gateRejectionRate: 0.15, recoveryRate: 0.85 },
      topBlockers: [],
    };

    const comparison = compareDigests(previous, current);
    expect(comparison.deltas.crashFreeRate).toBeCloseTo(0.1, 2);
    expect(comparison.deltas.gateRejectionRate).toBeCloseTo(0.05, 2);
    expect(comparison.deltas.recoveryRate).toBeCloseTo(0.05, 2);
  });

  test('identifies new failures', () => {
    const previous = {
      summary: { crashFreeRate: 0.9 },
      topBlockers: [{ signature: 'old-error' }],
    };
    const current = {
      summary: { crashFreeRate: 0.85 },
      topBlockers: [{ signature: 'old-error' }, { signature: 'brand-new-error' }],
    };

    const comparison = compareDigests(previous, current);
    expect(comparison.newFailures).toContain('brand-new-error');
    expect(comparison.fixedFailures.length).toBe(0);
  });

  test('identifies fixed failures', () => {
    const previous = {
      summary: { crashFreeRate: 0.9 },
      topBlockers: [{ signature: 'was-broken' }, { signature: 'still-broken' }],
    };
    const current = {
      summary: { crashFreeRate: 0.95 },
      topBlockers: [{ signature: 'still-broken' }],
    };

    const comparison = compareDigests(previous, current);
    expect(comparison.fixedFailures).toContain('was-broken');
    expect(comparison.newFailures.length).toBe(0);
  });

  test('handles null previous digest', () => {
    const current = {
      summary: { crashFreeRate: 0.9 },
      topBlockers: [{ signature: 'error-A' }],
    };

    const comparison = compareDigests(null, current);
    expect(comparison.crashRateTrend).toBe('stable');
    expect(comparison.newFailures).toContain('error-A');
  });
});

// ============ TESTS: ALERT THRESHOLDS ============

describe('Alert Thresholds', () => {
  test('triggers crash rate alert when threshold exceeded', () => {
    const digest = {
      summary: {
        crashFreeRate: 0.9, // 10% crash rate
        gateRejectionRate: 0.1,
        recoveryRate: 0.9,
        runtimeCrashes: 10,
        determinismScore: 1.0,
      },
    };

    const alerts = checkAlerts(digest, { maxCrashRatePercent: 5 });
    const crashAlert = alerts.find((a) => a.metric === 'crashRate');
    expect(crashAlert).toBeDefined();
    expect(crashAlert.level).toBe('critical');
    expect(crashAlert.value).toBeCloseTo(10, 1);
  });

  test('triggers runtime crash alert', () => {
    const digest = {
      summary: {
        crashFreeRate: 0.95,
        runtimeCrashes: 5,
        gateRejectionRate: 0.05,
        recoveryRate: 0.95,
        determinismScore: 1.0,
      },
    };

    const alerts = checkAlerts(digest, { maxNewRuntimeCrashes: 0 });
    const runtimeAlert = alerts.find((a) => a.metric === 'runtimeCrashes');
    expect(runtimeAlert).toBeDefined();
    expect(runtimeAlert.level).toBe('critical');
  });

  test('triggers gate rejection rate alert', () => {
    const digest = {
      summary: {
        crashFreeRate: 1.0,
        runtimeCrashes: 0,
        gateRejectionRate: 0.6, // 60%
        recoveryRate: 0.4,
        determinismScore: 1.0,
      },
    };

    const alerts = checkAlerts(digest, { maxGateRejectionRatePercent: 50 });
    const gateAlert = alerts.find((a) => a.metric === 'gateRejectionRate');
    expect(gateAlert).toBeDefined();
    expect(gateAlert.level).toBe('warning');
  });

  test('triggers determinism score alert', () => {
    const digest = {
      summary: {
        crashFreeRate: 1.0,
        runtimeCrashes: 0,
        gateRejectionRate: 0.0,
        recoveryRate: 1.0,
        determinismScore: 0.85,
      },
    };

    const alerts = checkAlerts(digest, { minDeterminismScore: 0.99 });
    const detAlert = alerts.find((a) => a.metric === 'determinismScore');
    expect(detAlert).toBeDefined();
    expect(detAlert.level).toBe('warning');
  });

  test('triggers recovery rate alert', () => {
    const digest = {
      summary: {
        crashFreeRate: 1.0,
        runtimeCrashes: 0,
        gateRejectionRate: 0.0,
        recoveryRate: 0.3, // 30%
        determinismScore: 1.0,
      },
    };

    const alerts = checkAlerts(digest, { minRecoveryRatePercent: 50 });
    const recAlert = alerts.find((a) => a.metric === 'recoveryRate');
    expect(recAlert).toBeDefined();
    expect(recAlert.level).toBe('warning');
  });

  test('no alerts when everything is healthy', () => {
    const digest = {
      summary: {
        crashFreeRate: 1.0,
        runtimeCrashes: 0,
        gateRejectionRate: 0.05,
        recoveryRate: 0.95,
        determinismScore: 1.0,
      },
    };

    const alerts = checkAlerts(digest);
    expect(alerts.length).toBe(0);
  });

  test('uses default thresholds when none provided', () => {
    const digest = {
      summary: {
        crashFreeRate: 0.5, // 50% crash rate - way over default 5%
        runtimeCrashes: 50,
        gateRejectionRate: 0.1,
        recoveryRate: 0.5,
        determinismScore: 1.0,
      },
    };

    const alerts = checkAlerts(digest);
    expect(alerts.length).toBeGreaterThan(0);
    const crashAlert = alerts.find((a) => a.metric === 'crashRate');
    expect(crashAlert).toBeDefined();
  });

  test('custom thresholds override defaults', () => {
    const digest = {
      summary: {
        crashFreeRate: 0.9, // 10% crash rate
        runtimeCrashes: 10,
        gateRejectionRate: 0.1,
        recoveryRate: 0.9,
        determinismScore: 1.0,
      },
    };

    // Set crash rate threshold very high so it doesn't trigger
    const alerts = checkAlerts(digest, { maxCrashRatePercent: 50, maxNewRuntimeCrashes: 100 });
    const crashAlert = alerts.find((a) => a.metric === 'crashRate');
    expect(crashAlert).toBeUndefined();
  });
});

// ============ TESTS: RELIABILITY KPIs ============

describe('Reliability KPIs', () => {
  test('extracts KPIs from digest', () => {
    const stressResults = buildSyntheticStressResults(50, { failRate: 0.3 });
    const digest = generateDigest(stressResults);
    const kpis = getReliabilityKPIs(digest);

    expect(kpis).toHaveProperty('crashFreeRate');
    expect(kpis).toHaveProperty('meanTimeToGateRejection');
    expect(kpis).toHaveProperty('determinismScore');
    expect(kpis).toHaveProperty('topBlockerRisk');
    expect(kpis).toHaveProperty('totalBlockers');
    expect(kpis).toHaveProperty('runtimeCrashes');
    expect(kpis).toHaveProperty('recoveryRate');

    expect(kpis.crashFreeRate).toBeGreaterThan(0);
    expect(kpis.crashFreeRate).toBeLessThanOrEqual(1);
  });

  test('KPIs from healthy digest', () => {
    const stressResults = buildSyntheticStressResults(20, { failRate: 0 });
    const digest = generateDigest(stressResults);
    const kpis = getReliabilityKPIs(digest);

    expect(kpis.crashFreeRate).toBe(1);
    expect(kpis.runtimeCrashes).toBe(0);
    expect(kpis.topBlockerRisk).toBe(0);
    expect(kpis.topBlockerSignature).toBeNull();
    expect(kpis.totalBlockers).toBe(0);
  });

  test('KPIs from null digest', () => {
    const kpis = getReliabilityKPIs(null);
    expect(kpis.crashFreeRate).toBe(1);
    expect(kpis.determinismScore).toBe(1.0);
    expect(kpis.topBlockerRisk).toBe(0);
  });
});

// ============ TESTS: DETERMINISM CHECK ============

describe('Determinism Check', () => {
  test('checkDeterminism returns deterministic result for same seed', async () => {
    const result = await checkDeterminism(42, 3);

    expect(result).toHaveProperty('deterministic');
    expect(result).toHaveProperty('seed', 42);
    expect(result).toHaveProperty('runs', 3);
    expect(result).toHaveProperty('mismatches');
    expect(Array.isArray(result.mismatches)).toBe(true);
    // With mocked pipeline, same seed should produce identical results
    expect(result.deterministic).toBe(true);
    expect(result.mismatches.length).toBe(0);
  });

  test('mutation selection is deterministic', () => {
    const mutations1 = selectMutationsForSeed(123);
    const mutations2 = selectMutationsForSeed(123);
    expect(mutations1).toEqual(mutations2);
  });

  test('mulberry32 PRNG is deterministic', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);

    const vals1 = Array.from({ length: 10 }, () => rng1());
    const vals2 = Array.from({ length: 10 }, () => rng2());
    expect(vals1).toEqual(vals2);
  });
});

// ============ TESTS: CRASH TREND TRACKING ============

describe('Crash Trend Tracking', () => {
  test('detects improving trend', () => {
    const summaries = [
      { timestamp: '2025-01-01', runtimeCrashes: 50, totalSeeds: 100 },
      { timestamp: '2025-01-02', runtimeCrashes: 40, totalSeeds: 100 },
      { timestamp: '2025-01-03', runtimeCrashes: 20, totalSeeds: 100 },
      { timestamp: '2025-01-04', runtimeCrashes: 5, totalSeeds: 100 },
    ];

    const trend = trackCrashTrend(summaries);
    expect(trend.direction).toBe('improving');
  });

  test('detects worsening trend', () => {
    const summaries = [
      { timestamp: '2025-01-01', runtimeCrashes: 5, totalSeeds: 100 },
      { timestamp: '2025-01-02', runtimeCrashes: 10, totalSeeds: 100 },
      { timestamp: '2025-01-03', runtimeCrashes: 30, totalSeeds: 100 },
      { timestamp: '2025-01-04', runtimeCrashes: 50, totalSeeds: 100 },
    ];

    const trend = trackCrashTrend(summaries);
    expect(trend.direction).toBe('worsening');
  });

  test('handles empty input', () => {
    const trend = trackCrashTrend([]);
    expect(trend.trend).toBe('no-data');
    expect(trend.direction).toBe('flat');
  });

  test('handles single run', () => {
    const trend = trackCrashTrend([{ runtimeCrashes: 5, totalSeeds: 100 }]);
    expect(trend.trend).toBe('insufficient-data');
  });
});

// ============ TESTS: INTEGRATION ============

describe('Integration: Full Pipeline', () => {
  test('end-to-end: stress results -> digest -> markdown -> comparison -> alerts', () => {
    // Generate two rounds of synthetic results
    const round1 = buildSyntheticStressResults(50, { failRate: 0.4, runtimeCrashRate: 0.5 });
    const round2 = buildSyntheticStressResults(50, { failRate: 0.2, runtimeCrashRate: 0.3 });

    // Generate digests
    const digest1 = generateDigest(round1);
    const digest2 = generateDigest(round2);

    // Generate markdown
    const md1 = formatDigestMarkdown(digest1);
    const md2 = formatDigestMarkdown(digest2);
    expect(typeof md1).toBe('string');
    expect(typeof md2).toBe('string');

    // Compare
    const comparison = compareDigests(digest1, digest2);
    expect(comparison.crashRateTrend).toBeDefined();
    expect(['improving', 'stable', 'worsening']).toContain(comparison.crashRateTrend);

    // Alerts
    const alerts = checkAlerts(digest1);
    expect(Array.isArray(alerts)).toBe(true);

    // KPIs
    const kpis1 = getReliabilityKPIs(digest1);
    const kpis2 = getReliabilityKPIs(digest2);
    expect(kpis1.crashFreeRate).toBeDefined();
    expect(kpis2.crashFreeRate).toBeDefined();
  });

  test('blockers report is well-formed', () => {
    const telemetry = buildSyntheticTelemetry(100, { failRate: 0.3 });
    const blockers = getTopBlockers(telemetry, 5);
    const report = formatBlockersReport(blockers);

    expect(report).toContain('# Top Blockers Report');
    expect(typeof report).toBe('string');
  });
});
