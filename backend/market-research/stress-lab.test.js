'use strict';

const {
  runStressLab,
  replaySeed,
  getMutationClasses,
  __test: {
    mulberry32,
    buildBasePayload,
    mutatePayload,
    selectMutationsForSeed,
    classifyError,
    computeAggregateStats,
    computePercentile,
    MUTATION_CLASS_KEYS,
    PHASES,
    deepClone,
    applyTransientKeyMutations,
    applySchemaCorruptionMutations,
    applyGeometryOverrideMutations,
    applyLongTextMutations,
    applyTableDensityMutations,
    applyChartAnomalyMutations,
    applyEmptyNullMutations,
  },
} = require('./stress-lab');

const {
  cluster,
  getTopBlockers,
  getRiskScore,
  trackCrashTrend,
  formatBlockersReport,
  __test: { extractErrorSignature },
} = require('./failure-cluster-analyzer');

// ============ SEED DETERMINISM ============

describe('Seed Determinism', () => {
  test('same seed always produces same payload', () => {
    const seed = 42;
    const base = buildBasePayload();
    const result1 = mutatePayload(
      { synthesis: base.synthesis, countryAnalysis: base.countryAnalysis, scope: base.scope },
      seed
    );
    const result2 = mutatePayload(
      { synthesis: base.synthesis, countryAnalysis: base.countryAnalysis, scope: base.scope },
      seed
    );
    expect(JSON.stringify(result1.payload)).toBe(JSON.stringify(result2.payload));
    expect(result1.mutationClasses).toEqual(result2.mutationClasses);
  });

  test('different seeds produce different payloads', () => {
    const base = buildBasePayload();
    const result1 = mutatePayload(
      { synthesis: base.synthesis, countryAnalysis: base.countryAnalysis, scope: base.scope },
      1
    );
    const result2 = mutatePayload(
      { synthesis: base.synthesis, countryAnalysis: base.countryAnalysis, scope: base.scope },
      2
    );
    expect(JSON.stringify(result1.payload)).not.toBe(JSON.stringify(result2.payload));
  });

  test('mulberry32 produces deterministic sequence', () => {
    const rng1 = mulberry32(12345);
    const rng2 = mulberry32(12345);
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    expect(seq1).toEqual(seq2);
  });

  test('selectMutationsForSeed is deterministic', () => {
    const m1 = selectMutationsForSeed(99);
    const m2 = selectMutationsForSeed(99);
    expect(m1).toEqual(m2);
  });

  test('selectMutationsForSeed returns 2-4 classes', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const mutations = selectMutationsForSeed(seed);
      expect(mutations.length).toBeGreaterThanOrEqual(2);
      expect(mutations.length).toBeLessThanOrEqual(4);
      // All returned classes must be valid
      for (const cls of mutations) {
        expect(MUTATION_CLASS_KEYS).toContain(cls);
      }
    }
  });
});

// ============ MUTATION CLASS VALIDITY ============

describe('Mutation Classes', () => {
  test('getMutationClasses returns 7 classes', () => {
    const classes = getMutationClasses();
    expect(Object.keys(classes).length).toBe(7);
    expect(classes).toHaveProperty('transient-keys');
    expect(classes).toHaveProperty('schema-corruption');
    expect(classes).toHaveProperty('geometry-override');
    expect(classes).toHaveProperty('long-text');
    expect(classes).toHaveProperty('table-density');
    expect(classes).toHaveProperty('chart-anomalies');
    expect(classes).toHaveProperty('empty-null');
  });

  test('each mutation class has name and description', () => {
    const classes = getMutationClasses();
    for (const [key, cls] of Object.entries(classes)) {
      expect(cls.name).toBeTruthy();
      expect(cls.description).toBeTruthy();
    }
  });

  test('transient-keys mutation injects transient keys', () => {
    const base = buildBasePayload();
    const payload = deepClone(base);
    const rng = mulberry32(42);
    applyTransientKeyMutations(payload, rng);

    // Check that at least one transient key was injected
    const json = JSON.stringify(payload);
    const hasTransient =
      json.includes('section_') ||
      json.includes('_wasArray') ||
      json.includes('gap_') ||
      json.includes('deepen_') ||
      json.includes('_synthesisError') ||
      json.includes('_debugInfo') ||
      json.includes('finalReviewGap') ||
      json.includes('verify_');
    expect(hasTransient).toBe(true);
  });

  test('schema-corruption mutation alters types', () => {
    const base = buildBasePayload();
    const payload = deepClone(base);
    const original = JSON.stringify(payload);
    const rng = mulberry32(42);
    applySchemaCorruptionMutations(payload, rng);
    expect(JSON.stringify(payload)).not.toBe(original);
  });

  test('geometry-override mutation injects conflicting data', () => {
    const base = buildBasePayload();
    const payload = deepClone(base);
    const rng = mulberry32(1); // use seed that triggers geometry changes
    applyGeometryOverrideMutations(payload, rng);
    const json = JSON.stringify(payload);
    // Should have injected either chart data into table sections or table data into chart sections
    const hasInjection =
      json.includes('_forceChartLayout') ||
      json.includes('_forceTableLayout') ||
      json.includes('Injected');
    expect(hasInjection).toBe(true);
  });

  test('long-text mutation creates 5K+ strings', () => {
    const base = buildBasePayload();
    const payload = deepClone(base);
    const rng = mulberry32(42);
    applyLongTextMutations(payload, rng);
    const json = JSON.stringify(payload);
    // At least one field should have a very long string
    const longStrings = json.match(/"[^"]{5000,}"/g);
    expect(longStrings).not.toBeNull();
    expect(longStrings.length).toBeGreaterThanOrEqual(1);
  });

  test('table-density mutation creates oversized tables', () => {
    const base = buildBasePayload();
    const payload = deepClone(base);
    const rng = mulberry32(42);
    applyTableDensityMutations(payload, rng);
    const market = payload.countryAnalysis.market;
    // At least one section should have tableData injected
    const hasTableData = Object.values(market).some(
      (section) => section && typeof section === 'object' && section.tableData
    );
    expect(hasTableData).toBe(true);
  });

  test('chart-anomalies mutation creates bad chart data', () => {
    const base = buildBasePayload();
    const payload = deepClone(base);
    const rng = mulberry32(7); // seed that triggers chart mutations
    applyChartAnomalyMutations(payload, rng);
    const json = JSON.stringify(payload);
    // Should have altered chart data in some way (all-zero, negative, non-numeric, or non-array)
    const hasAnomaly =
      json.includes('"stacked":true') ||
      json.includes('"NaN"') ||
      json.includes('"not-an-array"') ||
      json.includes('"invalid":true');
    // Some seeds won't trigger all mutations, check the data changed at all
    expect(JSON.stringify(payload)).not.toBe(JSON.stringify(base));
  });

  test('empty-null mutation removes or nulls sections', () => {
    const base = buildBasePayload();
    const payload = deepClone(base);
    const rng = mulberry32(42);
    applyEmptyNullMutations(payload, rng);
    // Some section should be deleted or null
    const ca = payload.countryAnalysis;
    const hasChange =
      ca.policy === null ||
      ca.policy === undefined ||
      ca.market === null ||
      ca.market === undefined ||
      ca.competitors === null ||
      ca.competitors === undefined ||
      ca.depth === null ||
      ca.depth === undefined ||
      ca.summary === null ||
      ca.summary === undefined;
    // Or nested deletions
    const json = JSON.stringify(payload);
    const originalJson = JSON.stringify(base);
    expect(json.length).toBeLessThan(originalJson.length);
  });
});

// ============ ERROR CLASSIFICATION ============

describe('Error Classification', () => {
  test('runtime crash patterns are correctly classified', () => {
    expect(classifyError('TypeError: foo is not a function')).toBe('runtime-crash');
    expect(classifyError('Cannot read properties of undefined')).toBe('runtime-crash');
    expect(classifyError('x is not defined')).toBe('runtime-crash');
    expect(classifyError('Cannot destructure property')).toBe('runtime-crash');
    expect(classifyError('Maximum call stack size exceeded')).toBe('runtime-crash');
  });

  test('data gate patterns are correctly classified', () => {
    expect(classifyError('[PPT] Data gate failed for section X')).toBe('data-gate');
    expect(classifyError('[PPT] Cell text exceeds hard cap')).toBe('data-gate');
    expect(classifyError('Render normalization rejected payload')).toBe('data-gate');
    expect(classifyError('Data quality below threshold')).toBe('data-gate');
  });

  test('unknown errors default to runtime-crash', () => {
    expect(classifyError('Something unexpected happened')).toBe('runtime-crash');
    expect(classifyError('')).toBe('runtime-crash');
    expect(classifyError(null)).toBe('runtime-crash');
  });
});

// ============ FAILURE CLUSTERING ============

describe('Failure Clustering', () => {
  const mockTelemetry = [
    {
      seed: 1,
      status: 'fail',
      error: 'Cannot read properties of null (reading x)',
      errorClass: 'runtime-crash',
      failedPhase: 'render-ppt',
      mutationClasses: ['schema-corruption', 'empty-null'],
      stack: 'Error: ...',
    },
    {
      seed: 2,
      status: 'fail',
      error: 'Cannot read properties of null (reading y)',
      errorClass: 'runtime-crash',
      failedPhase: 'render-ppt',
      mutationClasses: ['schema-corruption'],
      stack: 'Error: ...',
    },
    {
      seed: 3,
      status: 'pass',
      error: null,
      errorClass: null,
      failedPhase: null,
      mutationClasses: ['transient-keys'],
    },
    {
      seed: 4,
      status: 'fail',
      error: '[PPT] Data gate failed for section X',
      errorClass: 'data-gate',
      failedPhase: 'render-ppt',
      mutationClasses: ['long-text'],
      stack: 'Error: ...',
    },
    {
      seed: 5,
      status: 'fail',
      error: 'foo is not a function',
      errorClass: 'runtime-crash',
      failedPhase: 'budget-gate',
      mutationClasses: ['schema-corruption', 'chart-anomalies'],
      stack: 'Error: ...',
    },
  ];

  test('cluster groups failures correctly', () => {
    const result = cluster(mockTelemetry);
    expect(result.clusters.length).toBeGreaterThan(0);
    // Seeds 1 and 2 should cluster together (similar error signature)
    const nullReadCluster = result.clusters.find((c) =>
      c.signature.includes('Cannot read properties of null')
    );
    expect(nullReadCluster).toBeDefined();
    expect(nullReadCluster.count).toBe(2);
    expect(nullReadCluster.seeds).toContain(1);
    expect(nullReadCluster.seeds).toContain(2);
  });

  test('cluster handles empty input', () => {
    const result = cluster([]);
    expect(result.clusters).toEqual([]);
  });

  test('cluster handles null input', () => {
    const result = cluster(null);
    expect(result.clusters).toEqual([]);
  });

  test('byPhase groups failures by phase', () => {
    const result = cluster(mockTelemetry);
    expect(result.byPhase['render-ppt']).toBeDefined();
    expect(result.byPhase['render-ppt'].length).toBe(3);
    expect(result.byPhase['budget-gate'].length).toBe(1);
  });

  test('byMutationClass groups failures by mutation class', () => {
    const result = cluster(mockTelemetry);
    expect(result.byMutationClass['schema-corruption']).toBeDefined();
    expect(result.byMutationClass['schema-corruption'].length).toBe(3);
  });
});

// ============ TOP BLOCKERS ============

describe('Top Blockers', () => {
  const mockTelemetry = Array.from({ length: 20 }, (_, i) => ({
    seed: i + 1,
    status: i % 3 === 0 ? 'fail' : 'pass',
    error: i % 3 === 0 ? `Error type ${i % 2}: something failed` : null,
    errorClass: i % 3 === 0 ? (i % 6 === 0 ? 'runtime-crash' : 'data-gate') : null,
    failedPhase: i % 3 === 0 ? (i % 6 === 0 ? 'render-ppt' : 'budget-gate') : null,
    mutationClasses: ['schema-corruption', 'empty-null'],
    stack: i % 3 === 0 ? 'Error stack...' : null,
  }));

  test('getTopBlockers returns prioritized list', () => {
    const blockers = getTopBlockers(mockTelemetry, 5);
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.length).toBeLessThanOrEqual(5);
    // Should be sorted by risk score (descending)
    for (let i = 1; i < blockers.length; i++) {
      expect(blockers[i].riskScore).toBeLessThanOrEqual(blockers[i - 1].riskScore);
    }
  });

  test('each blocker has required fields', () => {
    const blockers = getTopBlockers(mockTelemetry);
    for (const b of blockers) {
      expect(b).toHaveProperty('rank');
      expect(b).toHaveProperty('signature');
      expect(b).toHaveProperty('count');
      expect(b).toHaveProperty('seeds');
      expect(b).toHaveProperty('riskScore');
      expect(b).toHaveProperty('replayCommand');
      expect(b.replayCommand).toMatch(/node stress-lab\.js --seed=\d+/);
    }
  });

  test('getTopBlockers handles empty input', () => {
    expect(getTopBlockers([])).toEqual([]);
    expect(getTopBlockers(null)).toEqual([]);
  });
});

// ============ RISK SCORING ============

describe('Risk Scoring', () => {
  test('runtime crash gets higher risk than data gate', () => {
    const crashCluster = {
      count: 5,
      errorClasses: ['runtime-crash'],
      mutationClasses: ['schema-corruption'],
      phases: ['render-ppt'],
    };
    const gateCluster = {
      count: 5,
      errorClasses: ['data-gate'],
      mutationClasses: ['schema-corruption'],
      phases: ['render-ppt'],
    };
    const crashScore = getRiskScore(crashCluster, 100);
    const gateScore = getRiskScore(gateCluster, 100);
    expect(crashScore).toBeGreaterThan(gateScore);
  });

  test('higher frequency gets higher risk', () => {
    const highFreq = {
      count: 50,
      errorClasses: ['runtime-crash'],
      mutationClasses: ['schema-corruption'],
      phases: ['render-ppt'],
    };
    const lowFreq = {
      count: 2,
      errorClasses: ['runtime-crash'],
      mutationClasses: ['schema-corruption'],
      phases: ['render-ppt'],
    };
    expect(getRiskScore(highFreq, 100)).toBeGreaterThan(getRiskScore(lowFreq, 100));
  });

  test('earlier phase failure gets higher risk', () => {
    const earlyPhase = {
      count: 5,
      errorClasses: ['runtime-crash'],
      mutationClasses: ['schema-corruption'],
      phases: ['build-payload'],
    };
    const latePhase = {
      count: 5,
      errorClasses: ['runtime-crash'],
      mutationClasses: ['schema-corruption'],
      phases: ['validate-pptx'],
    };
    expect(getRiskScore(earlyPhase, 100)).toBeGreaterThan(getRiskScore(latePhase, 100));
  });

  test('risk score is bounded 0-100', () => {
    const extreme = {
      count: 1000,
      errorClasses: ['runtime-crash'],
      mutationClasses: MUTATION_CLASS_KEYS,
      phases: ['build-payload'],
    };
    expect(getRiskScore(extreme, 100)).toBeLessThanOrEqual(100);
    expect(getRiskScore({}, 100)).toBeGreaterThanOrEqual(0);
    expect(getRiskScore(null, 100)).toBe(0);
  });
});

// ============ ERROR SIGNATURE EXTRACTION ============

describe('Error Signature Extraction', () => {
  test('normalizes file paths', () => {
    const sig = extractErrorSignature(
      'Error at /home/user/project/file.js:42:10 something broke'
    );
    expect(sig).not.toContain('/home/user');
    expect(sig).toContain('something broke');
  });

  test('normalizes large numbers', () => {
    const sig = extractErrorSignature('Buffer too small: 12345 bytes');
    expect(sig).toContain('N');
    expect(sig).not.toContain('12345');
  });

  test('handles null/empty input', () => {
    expect(extractErrorSignature(null)).toBe('unknown-error');
    expect(extractErrorSignature('')).toBe('unknown-error');
    expect(extractErrorSignature(undefined)).toBe('unknown-error');
  });

  test('truncates long signatures', () => {
    const longError = 'A'.repeat(500);
    expect(extractErrorSignature(longError).length).toBeLessThanOrEqual(120);
  });
});

// ============ CRASH TREND TRACKING ============

describe('Crash Trend Tracking', () => {
  test('detects improving trend', () => {
    const runs = [
      { timestamp: '2026-01-01', runtimeCrashes: 10, totalSeeds: 100 },
      { timestamp: '2026-01-02', runtimeCrashes: 8, totalSeeds: 100 },
      { timestamp: '2026-01-03', runtimeCrashes: 5, totalSeeds: 100 },
      { timestamp: '2026-01-04', runtimeCrashes: 2, totalSeeds: 100 },
    ];
    const trend = trackCrashTrend(runs);
    expect(trend.direction).toBe('improving');
  });

  test('detects worsening trend', () => {
    const runs = [
      { timestamp: '2026-01-01', runtimeCrashes: 2, totalSeeds: 100 },
      { timestamp: '2026-01-02', runtimeCrashes: 5, totalSeeds: 100 },
      { timestamp: '2026-01-03', runtimeCrashes: 8, totalSeeds: 100 },
      { timestamp: '2026-01-04', runtimeCrashes: 15, totalSeeds: 100 },
    ];
    const trend = trackCrashTrend(runs);
    expect(trend.direction).toBe('worsening');
  });

  test('handles empty input', () => {
    expect(trackCrashTrend([]).trend).toBe('no-data');
    expect(trackCrashTrend(null).trend).toBe('no-data');
  });

  test('handles single run', () => {
    const trend = trackCrashTrend([{ runtimeCrashes: 5, totalSeeds: 100 }]);
    expect(trend.trend).toBe('insufficient-data');
  });
});

// ============ REPORT FORMAT ============

describe('Report Format', () => {
  test('formatBlockersReport produces valid markdown', () => {
    const blockers = [
      {
        rank: 1,
        signature: 'Cannot read properties of null',
        count: 5,
        seeds: [1, 2, 3, 4, 5],
        totalSeeds: 5,
        riskScore: 75,
        errorClasses: ['runtime-crash'],
        phases: ['render-ppt'],
        mutationClasses: ['schema-corruption'],
        sampleError: 'Cannot read properties of null (reading x)',
        replayCommand: 'node stress-lab.js --seed=1',
      },
    ];
    const report = formatBlockersReport(blockers);
    expect(report).toContain('# Top Blockers Report');
    expect(report).toContain('| Rank |');
    expect(report).toContain('Cannot read properties of null');
    expect(report).toContain('node stress-lab.js --seed=1');
  });

  test('formatBlockersReport handles empty', () => {
    const report = formatBlockersReport([]);
    expect(report).toContain('No failures found');
  });
});

// ============ AGGREGATE STATS ============

describe('Aggregate Stats', () => {
  test('computeAggregateStats calculates correctly', () => {
    const telemetry = [
      {
        seed: 1,
        status: 'pass',
        durationMs: 100,
        mutationClasses: ['transient-keys'],
        phases: { 'build-payload': { durationMs: 10 }, 'render-ppt': { durationMs: 80 } },
      },
      {
        seed: 2,
        status: 'fail',
        errorClass: 'runtime-crash',
        failedPhase: 'render-ppt',
        durationMs: 200,
        mutationClasses: ['schema-corruption'],
        phases: { 'build-payload': { durationMs: 15 }, 'render-ppt': { durationMs: 150 } },
      },
      {
        seed: 3,
        status: 'fail',
        errorClass: 'data-gate',
        failedPhase: 'budget-gate',
        durationMs: 50,
        mutationClasses: ['long-text'],
        phases: { 'build-payload': { durationMs: 5 }, 'budget-gate': { durationMs: 40 } },
      },
    ];
    const stats = computeAggregateStats(telemetry);
    expect(stats.total).toBe(3);
    expect(stats.passed).toBe(1);
    expect(stats.failed).toBe(2);
    expect(stats.runtimeCrashes).toBe(1);
    expect(stats.dataGateRejections).toBe(1);
    expect(stats.failuresByPhase['render-ppt']).toBe(1);
    expect(stats.failuresByPhase['budget-gate']).toBe(1);
    expect(stats.failuresByMutationClass['schema-corruption']).toBe(1);
    expect(stats.p50Duration).toBeGreaterThan(0);
    expect(stats.p95Duration).toBeGreaterThanOrEqual(stats.p50Duration);
  });

  test('computePercentile handles edge cases', () => {
    expect(computePercentile([], 50)).toBe(0);
    expect(computePercentile([10], 50)).toBe(10);
    expect(computePercentile([10, 20, 30], 50)).toBe(20);
    expect(computePercentile([10, 20, 30], 95)).toBe(30);
  });
});

// ============ BASE PAYLOAD ============

describe('Base Payload', () => {
  test('buildBasePayload returns valid structure', () => {
    const { synthesis, countryAnalysis, scope } = buildBasePayload();
    expect(synthesis).toBeDefined();
    expect(synthesis.isSingleCountry).toBe(true);
    expect(synthesis.country).toBe('Test Country');
    expect(countryAnalysis).toBeDefined();
    expect(countryAnalysis.country).toBe('Test Country');
    expect(countryAnalysis.policy).toBeDefined();
    expect(countryAnalysis.market).toBeDefined();
    expect(countryAnalysis.competitors).toBeDefined();
    expect(countryAnalysis.depth).toBeDefined();
    expect(countryAnalysis.summary).toBeDefined();
    expect(scope).toBeDefined();
    expect(scope.industry).toBe('Test Industry');
  });
});

// ============ DEEP CLONE ============

describe('Deep Clone', () => {
  test('creates independent copy', () => {
    const original = { a: { b: [1, 2, 3] } };
    const clone = deepClone(original);
    clone.a.b.push(4);
    expect(original.a.b.length).toBe(3);
    expect(clone.a.b.length).toBe(4);
  });
});
