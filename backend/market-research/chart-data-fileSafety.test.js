'use strict';

const {
  normalizeChartPayload,
  inferChartIntent,
  detectLengthMismatches,
  REASON,
  __test: { coerceNumber, coerceString },
} = require('./chart-data-normalizer');

const {
  scoreChartQuality,
  runChartGate,
  generateChartDiagnostics,
  ChartGateError,
  GATE_CODE,
} = require('./chart-quality-gate');

// ─── Seeded PRNG (mulberry32) for fuzz tests ───────────────────────────────

function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeValidChart(overrides = {}) {
  return {
    categories: ['2020', '2021', '2022', '2023'],
    series: [
      { name: 'Revenue', values: [10, 20, 30, 40] },
      { name: 'Cost', values: [5, 10, 15, 20] },
    ],
    unit: 'USD',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// normalizeChartPayload
// ═══════════════════════════════════════════════════════════════════════════

describe('normalizeChartPayload', () => {
  // ── Valid input ──

  test('returns valid outcome for clean data', () => {
    const data = makeValidChart();
    const result = normalizeChartPayload(data);

    expect(result.normalized).not.toBeNull();
    expect(result.wasModified).toBe(false);
    expect(result.issues).toHaveLength(0);
    expect(result.outcome.status).toBe('valid');
    expect(result.outcome.reasonCode).toBe(REASON.VALID);
  });

  test('preserves unit and projectedStartIndex', () => {
    const data = makeValidChart({ unit: 'MW', projectedStartIndex: 2 });
    const result = normalizeChartPayload(data);

    expect(result.normalized.unit).toBe('MW');
    expect(result.normalized.projectedStartIndex).toBe(2);
  });

  // ── Null / undefined / non-object ──

  test('rejects null input', () => {
    const result = normalizeChartPayload(null);
    expect(result.normalized).toBeNull();
    expect(result.outcome.status).toBe('rejected');
    expect(result.outcome.reasonCode).toBe(REASON.NULL_INPUT);
  });

  test('rejects undefined input', () => {
    const result = normalizeChartPayload(undefined);
    expect(result.normalized).toBeNull();
    expect(result.outcome.reasonCode).toBe(REASON.NULL_INPUT);
  });

  test('rejects string input', () => {
    const result = normalizeChartPayload('not a chart');
    expect(result.normalized).toBeNull();
    expect(result.outcome.reasonCode).toBe(REASON.NULL_INPUT);
  });

  test('rejects number input', () => {
    const result = normalizeChartPayload(42);
    expect(result.normalized).toBeNull();
    expect(result.outcome.reasonCode).toBe(REASON.NULL_INPUT);
  });

  // ── Missing categories ──

  test('rejects missing categories', () => {
    const data = { series: [{ name: 'A', values: [1, 2] }] };
    const result = normalizeChartPayload(data);
    expect(result.outcome.reasonCode).toBe(REASON.MISSING_CATEGORIES);
  });

  test('rejects empty categories array', () => {
    const data = { categories: [], series: [{ name: 'A', values: [] }] };
    const result = normalizeChartPayload(data);
    expect(result.outcome.reasonCode).toBe(REASON.EMPTY_CATEGORIES);
  });

  test('rejects single category (too few)', () => {
    const data = { categories: ['2020'], series: [{ name: 'A', values: [10] }] };
    const result = normalizeChartPayload(data);
    expect(result.outcome.reasonCode).toBe(REASON.TOO_FEW_CATEGORIES);
  });

  // ── Missing/empty series ──

  test('rejects null series', () => {
    const data = { categories: ['2020', '2021'], series: null };
    const result = normalizeChartPayload(data);
    expect(result.outcome.reasonCode).toBe(REASON.MISSING_SERIES);
  });

  test('rejects undefined series', () => {
    const data = { categories: ['2020', '2021'] };
    const result = normalizeChartPayload(data);
    expect(result.outcome.reasonCode).toBe(REASON.MISSING_SERIES);
  });

  test('rejects empty series array', () => {
    const data = { categories: ['2020', '2021'], series: [] };
    const result = normalizeChartPayload(data);
    expect(result.outcome.reasonCode).toBe(REASON.EMPTY_SERIES);
  });

  test('rejects series that is a string', () => {
    const data = { categories: ['2020', '2021'], series: 'not_an_array' };
    const result = normalizeChartPayload(data);
    expect(result.outcome.reasonCode).toBe(REASON.MISSING_SERIES);
  });

  // ── Value coercion ──

  test('coerces string values to numbers', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: ['10', '20', '30'] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.series[0].values).toEqual([10, 20, 30]);
    expect(result.wasModified).toBe(true);
    expect(result.outcome.status).toBe('normalized');
  });

  test('coerces NaN to 0', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [1, NaN, 3] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.series[0].values).toEqual([1, 0, 3]);
    expect(result.wasModified).toBe(true);
  });

  test('coerces null values to 0', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [1, null, 3] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.series[0].values).toEqual([1, 0, 3]);
    expect(result.wasModified).toBe(true);
  });

  test('coerces undefined values to 0', () => {
    const data = {
      categories: ['A', 'B'],
      series: [{ name: 'S1', values: [undefined, 5] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.series[0].values).toEqual([0, 5]);
  });

  test('coerces Infinity to 0', () => {
    const data = {
      categories: ['A', 'B'],
      series: [{ name: 'S1', values: [Infinity, -Infinity] }],
    };
    const result = normalizeChartPayload(data);
    // Both Infinity values coerce to 0 -> all zeros -> rejected (normalized is null)
    expect(result.normalized).toBeNull();
    expect(result.outcome.status).toBe('rejected');
    expect(result.outcome.reasonCode).toBe(REASON.ALL_ZEROS);
  });

  // ── Category coercion ──

  test('coerces numeric categories to strings', () => {
    const data = {
      categories: [2020, 2021, 2022],
      series: [{ name: 'S1', values: [1, 2, 3] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.categories).toEqual(['2020', '2021', '2022']);
    expect(result.wasModified).toBe(true);
  });

  // ── Length mismatch handling ──

  test('pads short series with zeros', () => {
    const data = {
      categories: ['A', 'B', 'C', 'D'],
      series: [{ name: 'S1', values: [1, 2] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.series[0].values).toEqual([1, 2, 0, 0]);
    expect(result.wasModified).toBe(true);
  });

  test('trims long series to match categories', () => {
    const data = {
      categories: ['A', 'B'],
      series: [{ name: 'S1', values: [1, 2, 3, 4, 5] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.series[0].values).toEqual([1, 2]);
    expect(result.wasModified).toBe(true);
  });

  // ── All-zeros rejection ──

  test('rejects all-zeros data', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [
        { name: 'S1', values: [0, 0, 0] },
        { name: 'S2', values: [0, 0, 0] },
      ],
    };
    const result = normalizeChartPayload(data);
    expect(result.outcome.status).toBe('rejected');
    expect(result.outcome.reasonCode).toBe(REASON.ALL_ZEROS);
  });

  test('does NOT reject if at least one value is non-zero', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [0, 0, 1] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.outcome.status).toBe('valid');
  });

  // ── Skipping invalid series entries ──

  test('skips non-object series entries', () => {
    const data = {
      categories: ['A', 'B'],
      series: [null, { name: 'Good', values: [1, 2] }, 'bad'],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.series).toHaveLength(1);
    expect(result.normalized.series[0].name).toBe('Good');
    expect(result.wasModified).toBe(true);
  });

  test('skips series with non-array values', () => {
    const data = {
      categories: ['A', 'B'],
      series: [
        { name: 'Bad', values: 'not_array' },
        { name: 'Good', values: [3, 4] },
      ],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.series).toHaveLength(1);
    expect(result.normalized.series[0].name).toBe('Good');
  });

  test('rejects when all series entries are invalid', () => {
    const data = {
      categories: ['A', 'B'],
      series: [null, { name: 'Bad', values: 'nope' }, 42],
    };
    const result = normalizeChartPayload(data);
    expect(result.outcome.reasonCode).toBe(REASON.NO_VALID_SERIES);
  });

  // ── Mixed types in values ──

  test('handles mixed types in values array', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [10, '20', null] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.series[0].values).toEqual([10, 20, 0]);
    expect(result.wasModified).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// inferChartIntent
// ═══════════════════════════════════════════════════════════════════════════

describe('inferChartIntent', () => {
  test('returns unknown for null input', () => {
    expect(inferChartIntent(null)).toBe('unknown');
  });

  test('returns unknown for empty data', () => {
    expect(inferChartIntent({ categories: [], series: [] })).toBe('unknown');
  });

  test('detects time_series from year categories', () => {
    const data = {
      categories: ['2020', '2021', '2022', '2023'],
      series: [{ name: 'Rev', values: [10, 20, 30, 40] }],
    };
    expect(inferChartIntent(data)).toBe('time_series');
  });

  test('detects time_series from date categories', () => {
    const data = {
      categories: ['2020-01', '2020-02', '2020-03'],
      series: [{ name: 'Rev', values: [10, 20, 30] }],
    };
    expect(inferChartIntent(data)).toBe('time_series');
  });

  test('detects time_series from quarter categories', () => {
    const data = {
      categories: ['Q1 2020', 'Q2 2020', 'Q3 2020'],
      series: [{ name: 'Rev', values: [10, 20, 30] }],
    };
    expect(inferChartIntent(data)).toBe('time_series');
  });

  test('detects composition when single series sums to ~100', () => {
    const data = {
      categories: ['Coal', 'Gas', 'Renewables'],
      series: [{ name: 'Mix', values: [40, 35, 25] }],
    };
    expect(inferChartIntent(data)).toBe('composition');
  });

  test('detects composition with sum within 5% tolerance', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'Mix', values: [48, 30, 25] }], // sum = 103
    };
    expect(inferChartIntent(data)).toBe('composition');
  });

  test('detects comparison for multiple series with non-temporal categories', () => {
    const data = {
      categories: ['Company A', 'Company B', 'Company C'],
      series: [
        { name: 'Revenue', values: [100, 200, 150] },
        { name: 'Profit', values: [20, 40, 30] },
      ],
    };
    expect(inferChartIntent(data)).toBe('comparison');
  });

  test('returns unknown for single series with non-composition values', () => {
    const data = {
      categories: ['Alpha', 'Beta', 'Gamma'],
      series: [{ name: 'Metric', values: [500, 600, 700] }], // sum != ~100
    };
    expect(inferChartIntent(data)).toBe('unknown');
  });

  test('returns unknown for missing series array', () => {
    expect(inferChartIntent({ categories: ['A', 'B'] })).toBe('unknown');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// detectLengthMismatches
// ═══════════════════════════════════════════════════════════════════════════

describe('detectLengthMismatches', () => {
  test('returns no mismatch for balanced data', () => {
    const data = makeValidChart();
    const result = detectLengthMismatches(data);
    expect(result.hasMismatch).toBe(false);
    expect(result.mismatches).toHaveLength(0);
  });

  test('detects series shorter than categories', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [1, 2] }],
    };
    const result = detectLengthMismatches(data);
    expect(result.hasMismatch).toBe(true);
    expect(result.mismatches[0].seriesLength).toBe(2);
    expect(result.mismatches[0].categoriesLength).toBe(3);
  });

  test('detects series longer than categories', () => {
    const data = {
      categories: ['A', 'B'],
      series: [{ name: 'S1', values: [1, 2, 3, 4] }],
    };
    const result = detectLengthMismatches(data);
    expect(result.hasMismatch).toBe(true);
  });

  test('handles null input gracefully', () => {
    const result = detectLengthMismatches(null);
    expect(result.hasMismatch).toBe(false);
  });

  test('detects mismatch in specific series only', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [
        { name: 'Good', values: [1, 2, 3] },
        { name: 'Bad', values: [1, 2] },
      ],
    };
    const result = detectLengthMismatches(data);
    expect(result.hasMismatch).toBe(true);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].seriesName).toBe('Bad');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// scoreChartQuality
// ═══════════════════════════════════════════════════════════════════════════

describe('scoreChartQuality', () => {
  test('returns 0 for null input', () => {
    expect(scoreChartQuality(null)).toBe(0);
  });

  test('returns 0 for empty object', () => {
    expect(scoreChartQuality({})).toBe(0);
  });

  test('returns high score for clean data', () => {
    const data = makeValidChart();
    const score = scoreChartQuality(data);
    expect(score).toBeGreaterThanOrEqual(80);
  });

  test('returns perfect 100 for ideal data', () => {
    const data = {
      categories: ['2020', '2021', '2022', '2023'],
      series: [
        { name: 'Revenue', values: [100, 120, 140, 160] },
        { name: 'Cost', values: [80, 90, 100, 110] },
      ],
    };
    const score = scoreChartQuality(data);
    expect(score).toBe(100);
  });

  test('gives partial score for categories only', () => {
    const data = { categories: ['A', 'B'], series: [] };
    const score = scoreChartQuality(data);
    expect(score).toBe(10); // only categories completeness
  });

  test('penalizes non-string categories', () => {
    const data = {
      categories: [2020, 2021, 2022],
      series: [{ name: 'S1', values: [10, 20, 30] }],
    };
    const score = scoreChartQuality(data);
    const cleanScore = scoreChartQuality({
      categories: ['2020', '2021', '2022'],
      series: [{ name: 'S1', values: [10, 20, 30] }],
    });
    expect(score).toBeLessThan(cleanScore);
  });

  test('penalizes non-numeric values', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: ['10', '20', '30'] }],
    };
    const score = scoreChartQuality(data);
    expect(score).toBeLessThan(100);
  });

  test('gives 0 range score for all-zero values', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [0, 0, 0] }],
    };
    const score = scoreChartQuality(data);
    // Should have completeness (30) + type (25) + range (0) + balance (20) = 75
    expect(score).toBeLessThanOrEqual(75);
  });

  test('penalizes series length mismatch', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [10, 20] }], // 2 != 3
    };
    const score = scoreChartQuality(data);
    const balancedScore = scoreChartQuality({
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [10, 20, 30] }],
    });
    expect(score).toBeLessThan(balancedScore);
  });

  test('penalizes missing series names', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: '', values: [10, 20, 30] }],
    };
    const score = scoreChartQuality(data);
    expect(score).toBeLessThan(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runChartGate
// ═══════════════════════════════════════════════════════════════════════════

describe('runChartGate', () => {
  test('passes clean data with default options', () => {
    const data = makeValidChart();
    const result = runChartGate(data);
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.issues).toEqual([]);
    expect(result.reasonCodes).toEqual([]);
  });

  test('fails null input', () => {
    const result = runChartGate(null);
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasonCodes).toContain(REASON.NULL_INPUT);
  });

  test('fails empty series', () => {
    const result = runChartGate({ categories: ['A', 'B'], series: [] });
    expect(result.pass).toBe(false);
    expect(result.reasonCodes).toContain(REASON.EMPTY_SERIES);
  });

  test('custom minScore threshold', () => {
    const data = makeValidChart();
    // Score should be high — pass at 90
    const result = runChartGate(data, { minScore: 90 });
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.pass).toBe(true);
  });

  test('fails when score below custom minScore', () => {
    // Gate scores RAW data quality. Data with issues scores below 100.
    const data = {
      categories: [2020, 2021, 2022], // numeric (not string) categories
      series: [{ name: '', values: ['10', '20'] }], // string values, missing name, length mismatch
    };
    // Raw data scores ~47 — well below 95
    const result = runChartGate(data, { minScore: 95 });
    expect(result.pass).toBe(false);
    expect(result.reasonCodes).toContain('BELOW_MIN_SCORE');
  });

  test('includes normalization issues', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: ['1', '2', '3'] }],
    };
    const result = runChartGate(data);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.reasonCodes).toContain(REASON.COERCED_VALUES);
  });

  test('detects length mismatches from original data', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [1, 2] }],
    };
    const result = runChartGate(data);
    expect(result.reasonCodes).toContain(REASON.SERIES_LENGTH_MISMATCH);
  });

  // ── Strict mode ──

  test('strict mode throws ChartGateError for rejected data', () => {
    expect(() => {
      runChartGate(null, { strict: true });
    }).toThrow(ChartGateError);
  });

  test('strict mode error has structured code', () => {
    let caught;
    try {
      runChartGate(null, { strict: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ChartGateError);
    expect(caught.code).toBe(GATE_CODE.REJECTED_BY_NORMALIZER);
    expect(caught.reasonCodes).toContain(REASON.NULL_INPUT);
  });

  test('strict mode throws for below-min-score', () => {
    const data = {
      categories: [2020, 2021, 2022],
      series: [{ name: '', values: ['10', '20'] }],
    };
    expect(() => {
      runChartGate(data, { strict: true, minScore: 95 });
    }).toThrow(ChartGateError);

    try {
      runChartGate(data, { strict: true, minScore: 95 });
    } catch (e) {
      expect(e.code).toBe(GATE_CODE.BELOW_MIN_SCORE);
      expect(e.score).toBeLessThan(95);
    }
  });

  test('strict mode does NOT throw for passing data', () => {
    const data = makeValidChart();
    const result = runChartGate(data, { strict: true, minScore: 50 });
    expect(result.pass).toBe(true);
  });

  test('non-strict mode returns result object even for bad data', () => {
    const result = runChartGate(null, { strict: false });
    expect(result).toHaveProperty('pass', false);
    expect(result).toHaveProperty('score', 0);
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('reasonCodes');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// generateChartDiagnostics
// ═══════════════════════════════════════════════════════════════════════════

describe('generateChartDiagnostics', () => {
  test('handles null blocks array', () => {
    const diag = generateChartDiagnostics(null);
    expect(diag.totalBlocks).toBe(0);
    expect(diag.chartsFound).toBe(0);
    expect(diag.perBlock).toEqual([]);
  });

  test('handles empty blocks array', () => {
    const diag = generateChartDiagnostics([]);
    expect(diag.totalBlocks).toBe(0);
    expect(diag.chartsFound).toBe(0);
  });

  test('counts valid charts correctly', () => {
    const blocks = [
      {
        chartData: makeValidChart(),
      },
      {
        chartData: makeValidChart(),
      },
    ];
    const diag = generateChartDiagnostics(blocks);
    expect(diag.totalBlocks).toBe(2);
    expect(diag.chartsFound).toBe(2);
    expect(diag.chartsValid).toBe(2);
    expect(diag.chartsRejected).toBe(0);
  });

  test('counts rejected charts correctly', () => {
    const blocks = [
      // This block has chart shape (categories and series are arrays) but is rejected (empty categories)
      { chartData: { categories: [], series: [{ name: 'S', values: [] }] } },
      // This block has chart shape but is rejected (single category)
      { chartData: { categories: ['A'], series: [{ name: 'S', values: [1] }] } },
    ];
    const diag = generateChartDiagnostics(blocks);
    expect(diag.chartsFound).toBe(2);
    expect(diag.chartsRejected).toBe(2);
    expect(diag.chartsValid).toBe(0);
  });

  test('identifies blocks with chart data shape', () => {
    const blocks = [
      { chartData: { categories: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }] } },
      { title: 'No chart here' },
      { chartData: { categories: ['X', 'Y'], series: [] } },
    ];
    const diag = generateChartDiagnostics(blocks);
    expect(diag.chartsFound).toBe(2); // blocks 0 and 2 have chart shape
    expect(diag.perBlock[1].hasChart).toBe(false);
  });

  test('provides per-block status and score', () => {
    const blocks = [{ chartData: makeValidChart() }];
    const diag = generateChartDiagnostics(blocks);
    const entry = diag.perBlock[0];
    expect(entry.hasChart).toBe(true);
    expect(entry.status).toBe('valid');
    expect(entry.score).toBeGreaterThan(0);
    expect(entry.intent).toBeDefined();
  });

  test('counts normalized charts', () => {
    const blocks = [
      {
        chartData: {
          categories: ['A', 'B', 'C'],
          series: [{ name: 'S', values: ['1', '2', '3'] }], // needs coercion
        },
      },
    ];
    const diag = generateChartDiagnostics(blocks);
    expect(diag.chartsNormalized).toBe(1);
  });

  test('includes timestamp', () => {
    const diag = generateChartDiagnostics([]);
    expect(diag.timestamp).toBeDefined();
    expect(typeof diag.timestamp).toBe('string');
  });

  test('handles blocks that are chart data directly (no chartData wrapper)', () => {
    const blocks = [makeValidChart()];
    const diag = generateChartDiagnostics(blocks);
    expect(diag.chartsFound).toBe(1);
    expect(diag.chartsValid).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ChartGateError
// ═══════════════════════════════════════════════════════════════════════════

describe('ChartGateError', () => {
  test('is an instance of Error', () => {
    const err = new ChartGateError('test', 'CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ChartGateError);
  });

  test('has structured properties', () => {
    const err = new ChartGateError('msg', 'MY_CODE', {
      score: 30,
      issues: ['a', 'b'],
      reasonCodes: ['X'],
    });
    expect(err.name).toBe('ChartGateError');
    expect(err.code).toBe('MY_CODE');
    expect(err.score).toBe(30);
    expect(err.issues).toEqual(['a', 'b']);
    expect(err.reasonCodes).toEqual(['X']);
    expect(err.message).toBe('msg');
  });

  test('has defaults for optional details', () => {
    const err = new ChartGateError('msg', 'CODE');
    expect(err.score).toBe(0);
    expect(err.issues).toEqual([]);
    expect(err.reasonCodes).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

describe('coerceNumber', () => {
  test('returns number for valid number', () => {
    expect(coerceNumber(42)).toBe(42);
  });

  test('returns 0 for null', () => {
    expect(coerceNumber(null)).toBe(0);
  });

  test('returns 0 for undefined', () => {
    expect(coerceNumber(undefined)).toBe(0);
  });

  test('returns 0 for NaN', () => {
    expect(coerceNumber(NaN)).toBe(0);
  });

  test('converts string to number', () => {
    expect(coerceNumber('123')).toBe(123);
  });

  test('returns 0 for non-numeric string', () => {
    expect(coerceNumber('hello')).toBe(0);
  });

  test('returns 0 for Infinity', () => {
    expect(coerceNumber(Infinity)).toBe(0);
  });

  test('returns 0 for -Infinity', () => {
    expect(coerceNumber(-Infinity)).toBe(0);
  });

  test('handles negative numbers', () => {
    expect(coerceNumber(-5.5)).toBe(-5.5);
  });
});

describe('coerceString', () => {
  test('returns string for string', () => {
    expect(coerceString('hello')).toBe('hello');
  });

  test('returns empty string for null', () => {
    expect(coerceString(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(coerceString(undefined)).toBe('');
  });

  test('converts number to string', () => {
    expect(coerceString(42)).toBe('42');
  });

  test('converts boolean to string', () => {
    expect(coerceString(true)).toBe('true');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression tests for malformed payloads
// ═══════════════════════════════════════════════════════════════════════════

describe('Malformed payload regression tests', () => {
  test('negative values in composition-like data', () => {
    const data = {
      categories: ['Coal', 'Gas', 'Renewables'],
      series: [{ name: 'Mix', values: [-10, 60, 50] }], // sum = 100 but has negative
    };
    // Should still normalize (negatives are valid numbers)
    const result = normalizeChartPayload(data);
    expect(result.normalized).not.toBeNull();
    // But quality score should be penalized
    const score = scoreChartQuality(result.normalized);
    expect(score).toBeDefined();
  });

  test('deeply nested null values', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [null, null, null] }],
    };
    const result = normalizeChartPayload(data);
    // All null -> all 0 -> rejected as all zeros
    expect(result.outcome.status).toBe('rejected');
    expect(result.outcome.reasonCode).toBe(REASON.ALL_ZEROS);
  });

  test('boolean values in series', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [true, false, true] }],
    };
    const result = normalizeChartPayload(data);
    // true->1, false->0, true->1
    expect(result.normalized.series[0].values).toEqual([1, 0, 1]);
  });

  test('object values in series', () => {
    const data = {
      categories: ['A', 'B'],
      series: [{ name: 'S1', values: [{}, []] }],
    };
    const result = normalizeChartPayload(data);
    // {} -> NaN -> 0, [] -> 0 -> all zeros -> rejected (normalized is null)
    expect(result.normalized).toBeNull();
    expect(result.outcome.status).toBe('rejected');
    expect(result.outcome.reasonCode).toBe(REASON.ALL_ZEROS);
  });

  test('extremely large values', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [1e15, 1e16, 1e17] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized).not.toBeNull();
    expect(result.wasModified).toBe(false);
  });

  test('extremely small (near-zero) values', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [1e-10, 2e-10, 3e-10] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized).not.toBeNull();
    expect(result.outcome.status).toBe('valid');
  });

  test('empty string values in categories', () => {
    const data = {
      categories: ['', '', ''],
      series: [{ name: 'S1', values: [1, 2, 3] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.categories).toEqual(['', '', '']);
  });

  test('series with no name field', () => {
    const data = {
      categories: ['A', 'B'],
      series: [{ values: [10, 20] }],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.series[0].name).toBe('Series 1');
  });

  test('series array containing empty objects', () => {
    const data = {
      categories: ['A', 'B'],
      series: [{}],
    };
    const result = normalizeChartPayload(data);
    // {} has no .values array -> skipped -> no valid series
    expect(result.outcome.reasonCode).toBe(REASON.NO_VALID_SERIES);
  });

  test('mixed valid and invalid series', () => {
    const data = {
      categories: ['X', 'Y', 'Z'],
      series: [
        { name: 'Good', values: [10, 20, 30] },
        null,
        { name: 'Also Good', values: [5, 15, 25] },
        { values: 'broken' },
      ],
    };
    const result = normalizeChartPayload(data);
    expect(result.normalized.series).toHaveLength(2);
    expect(result.wasModified).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Seeded fuzz tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Seeded fuzz tests — chart payload corruption', () => {
  // Mutation functions that corrupt chart payloads in specific ways
  const MUTATIONS = [
    // Null out categories
    (data) => ({ ...data, categories: null }),
    // Empty categories
    (data) => ({ ...data, categories: [] }),
    // Null out series
    (data) => ({ ...data, series: null }),
    // Empty series
    (data) => ({ ...data, series: [] }),
    // Inject NaN values
    (data, rng) => {
      const series = data.series.map((s) => {
        const values = s.values.map((v) => (rng() < 0.3 ? NaN : v));
        return { ...s, values };
      });
      return { ...data, series };
    },
    // Inject null values
    (data, rng) => {
      const series = data.series.map((s) => {
        const values = s.values.map((v) => (rng() < 0.3 ? null : v));
        return { ...s, values };
      });
      return { ...data, series };
    },
    // Inject string values
    (data, rng) => {
      const series = data.series.map((s) => {
        const values = s.values.map((v) => (rng() < 0.3 ? String(v) : v));
        return { ...s, values };
      });
      return { ...data, series };
    },
    // Shorten series (length mismatch)
    (data) => {
      const series = data.series.map((s) => ({
        ...s,
        values: s.values.slice(0, Math.max(0, s.values.length - 2)),
      }));
      return { ...data, series };
    },
    // Lengthen series (length mismatch)
    (data) => {
      const series = data.series.map((s) => ({
        ...s,
        values: [...s.values, 999, 888, 777],
      }));
      return { ...data, series };
    },
    // Remove series names
    (data) => {
      const series = data.series.map((s) => ({ values: s.values }));
      return { ...data, series };
    },
    // Replace series with non-objects
    (data, rng) => {
      const series = data.series.map((s) => (rng() < 0.5 ? null : s));
      return { ...data, series };
    },
    // All-zero values
    (data) => {
      const series = data.series.map((s) => ({
        ...s,
        values: s.values.map(() => 0),
      }));
      return { ...data, series };
    },
    // Inject Infinity
    (data, rng) => {
      const series = data.series.map((s) => ({
        ...s,
        values: s.values.map((v) => (rng() < 0.2 ? Infinity : v)),
      }));
      return { ...data, series };
    },
    // Make categories numeric
    (data) => ({
      ...data,
      categories: data.categories.map((c) => Number(c) || Math.floor(Math.random() * 2030)),
    }),
    // Replace entire data with primitive
    () => 'not a chart',
    // Replace with empty object
    () => ({}),
    // Single category
    (data) => ({
      ...data,
      categories: [data.categories[0]],
      series: data.series.map((s) => ({ ...s, values: [s.values[0]] })),
    }),
  ];

  const BASE_PAYLOAD = makeValidChart({
    categories: ['2020', '2021', '2022', '2023', '2024'],
    series: [
      { name: 'Revenue', values: [100, 120, 140, 160, 180] },
      { name: 'Cost', values: [80, 90, 100, 110, 120] },
      { name: 'Margin', values: [20, 30, 40, 50, 60] },
    ],
  });

  // Run 100 seeded fuzz iterations
  const FUZZ_SEEDS = Array.from({ length: 100 }, (_, i) => i + 1);

  test.each(FUZZ_SEEDS)('seed %i: normalizer never throws', (seed) => {
    const rng = mulberry32(seed);

    // Pick 1-3 mutations based on seed
    const mutationCount = 1 + Math.floor(rng() * 3);
    let mutated = JSON.parse(JSON.stringify(BASE_PAYLOAD));

    for (let m = 0; m < mutationCount; m++) {
      const mutIdx = Math.floor(rng() * MUTATIONS.length);
      try {
        mutated = MUTATIONS[mutIdx](mutated, rng);
      } catch {
        // Some mutations may fail on already-broken data; that's fine
      }
    }

    // normalizeChartPayload must never throw
    expect(() => normalizeChartPayload(mutated)).not.toThrow();

    const result = normalizeChartPayload(mutated);

    // Result must have required structure
    expect(result).toHaveProperty('normalized');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('wasModified');
    expect(result).toHaveProperty('outcome');
    expect(result.outcome).toHaveProperty('status');
    expect(result.outcome).toHaveProperty('reasonCode');
    expect(['valid', 'normalized', 'rejected']).toContain(result.outcome.status);
  });

  test.each(FUZZ_SEEDS)('seed %i: scoreChartQuality returns 0-100', (seed) => {
    const rng = mulberry32(seed);
    const mutIdx = Math.floor(rng() * MUTATIONS.length);
    let mutated = JSON.parse(JSON.stringify(BASE_PAYLOAD));
    try {
      mutated = MUTATIONS[mutIdx](mutated, rng);
    } catch {
      // ok
    }

    const score = scoreChartQuality(mutated);
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  test.each(FUZZ_SEEDS)('seed %i: runChartGate never throws in non-strict', (seed) => {
    const rng = mulberry32(seed);
    const mutIdx = Math.floor(rng() * MUTATIONS.length);
    let mutated = JSON.parse(JSON.stringify(BASE_PAYLOAD));
    try {
      mutated = MUTATIONS[mutIdx](mutated, rng);
    } catch {
      // ok
    }

    expect(() => runChartGate(mutated, { strict: false })).not.toThrow();

    const result = runChartGate(mutated, { strict: false });
    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('reasonCodes');
  });

  test.each(FUZZ_SEEDS.slice(0, 50))(
    'seed %i: strict mode throws ChartGateError or returns result (never generic error)',
    (seed) => {
      const rng = mulberry32(seed);
      const mutIdx = Math.floor(rng() * MUTATIONS.length);
      let mutated = JSON.parse(JSON.stringify(BASE_PAYLOAD));
      try {
        mutated = MUTATIONS[mutIdx](mutated, rng);
      } catch {
        // ok
      }

      try {
        const result = runChartGate(mutated, { strict: true, minScore: 70 });
        // If it didn't throw, it must have passed
        expect(result.pass).toBe(true);
      } catch (e) {
        // Must be ChartGateError, not a generic Error
        expect(e).toBeInstanceOf(ChartGateError);
        expect(typeof e.code).toBe('string');
        expect(e.code.length).toBeGreaterThan(0);
      }
    }
  );

  // Verify determinism: same seed produces same result
  test('same seed produces identical results', () => {
    const seed = 42;
    const rng1 = mulberry32(seed);
    const rng2 = mulberry32(seed);

    const mutIdx1 = Math.floor(rng1() * MUTATIONS.length);
    const mutIdx2 = Math.floor(rng2() * MUTATIONS.length);
    expect(mutIdx1).toBe(mutIdx2);

    let mutated1 = JSON.parse(JSON.stringify(BASE_PAYLOAD));
    let mutated2 = JSON.parse(JSON.stringify(BASE_PAYLOAD));
    const rng1b = mulberry32(seed);
    const rng2b = mulberry32(seed);
    rng1b();
    rng2b(); // consume first value (same as mutIdx)

    mutated1 = MUTATIONS[mutIdx1](mutated1, rng1b);
    mutated2 = MUTATIONS[mutIdx2](mutated2, rng2b);

    const result1 = normalizeChartPayload(mutated1);
    const result2 = normalizeChartPayload(mutated2);

    expect(result1.outcome.status).toBe(result2.outcome.status);
    expect(result1.outcome.reasonCode).toBe(result2.outcome.reasonCode);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: full pipeline flow
// ═══════════════════════════════════════════════════════════════════════════

describe('Integration: normalize -> gate -> runInfo', () => {
  test('valid chart passes full pipeline', () => {
    const data = makeValidChart();

    // Step 1: normalize
    const norm = normalizeChartPayload(data);
    expect(norm.outcome.status).toBe('valid');

    // Step 2: gate
    const gate = runChartGate(data);
    expect(gate.pass).toBe(true);

    // Step 3: runInfo
    const diag = generateChartDiagnostics([{ chartData: data }]);
    expect(diag.chartsValid).toBe(1);
    expect(diag.chartsRejected).toBe(0);
  });

  test('data needing coercion flows through pipeline', () => {
    const data = {
      categories: [2020, 2021, 2022],
      series: [{ name: 'S1', values: ['10', '20', '30'] }],
    };

    const norm = normalizeChartPayload(data);
    expect(norm.outcome.status).toBe('normalized');
    expect(norm.normalized.categories).toEqual(['2020', '2021', '2022']);
    expect(norm.normalized.series[0].values).toEqual([10, 20, 30]);

    const gate = runChartGate(data);
    expect(gate.pass).toBe(true); // coerced data should still pass

    const diag = generateChartDiagnostics([{ chartData: data }]);
    expect(diag.chartsNormalized).toBe(1);
  });

  test('rejected data flows through pipeline', () => {
    const data = null;

    const norm = normalizeChartPayload(data);
    expect(norm.outcome.status).toBe('rejected');

    const gate = runChartGate(data);
    expect(gate.pass).toBe(false);
  });

  test('multiple blocks with mixed quality', () => {
    const blocks = [
      { chartData: makeValidChart() },
      { chartData: null },
      {
        chartData: {
          categories: ['A', 'B', 'C'],
          series: [{ name: 'S', values: ['1', '2', '3'] }],
        },
      },
      { title: 'Text-only block' },
    ];

    const diag = generateChartDiagnostics(blocks);
    expect(diag.totalBlocks).toBe(4);
    expect(diag.chartsFound).toBe(2); // block 0 and 2 have chart shape
    expect(diag.chartsValid).toBe(1); // block 0
    expect(diag.chartsNormalized).toBe(1); // block 2
  });
});
