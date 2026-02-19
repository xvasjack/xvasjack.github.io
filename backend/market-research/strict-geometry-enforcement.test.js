'use strict';

/**
 * Tests for strict geometry enforcement behavior.
 *
 * Validates that:
 * 1. enforceStrict() in route-geometry-enforcer.js throws on mismatch (no fallback)
 * 2. enforce() still recovers gracefully in non-strict mode
 * 3. Error codes and telemetry are correct for both modes
 */

const {
  enforce,
  enforceStrict,
  getMetrics,
  getFailures,
  resetMetrics,
  RouteGeometryError,
  ERROR_CODES,
  __test: {
    inferPatternGeometry,
    layoutSatisfiesGeometry,
    describeActualGeometry,
    getTemplateSlideLayout,
    GEOMETRY_TABLE,
    GEOMETRY_CHART,
    GEOMETRY_TEXT,
  },
} = require('./route-geometry-enforcer');

const TABLE_CONTEXTS = new Set([
  'foundationalActs',
  'nationalPolicy',
  'investmentRestrictions',
  'keyIncentives',
  'regulatorySummary',
  'japanesePlayers',
  'localMajor',
  'foreignPlayers',
  'partnerAssessment',
  'caseStudy',
  'maActivity',
  'entryStrategy',
  'implementation',
  'targetSegments',
  'goNoGo',
  'timingIntelligence',
  'lessonsLearned',
  'dealEconomics',
]);

const CHART_CONTEXTS = new Set([
  'marketSizeAndGrowth',
  'supplyAndDemandDynamics',
  'supplyAndDemandData',
  'pricingAndTariffStructures',
  'pricingAndEconomics',
  'pricingAndCostBenchmarks',
  'infrastructureAndGrid',
  'tpes',
  'finalDemand',
  'electricity',
  'gasLng',
  'pricing',
  'escoMarket',
]);

beforeEach(() => {
  resetMetrics();
});

// ===========================================================================
// Strict mode: fail-fast on geometry mismatch
// ===========================================================================
describe('strict mode: fail-fast on geometry mismatch', () => {
  test('enforceStrict throws immediately when table block targets non-table slide', () => {
    let caught = null;
    try {
      enforceStrict({
        blockKey: 'foundationalActs',
        dataType: 'table',
        data: {},
        templateSelection: 1, // cover slide, no table geometry
        tableContextKeys: TABLE_CONTEXTS,
        chartContextKeys: CHART_CONTEXTS,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(RouteGeometryError);
    expect(caught.code).toBe(ERROR_CODES.RGE004_STRICT_MODE_MISMATCH);
    expect(caught.blockKey).toBe('foundationalActs');
    expect(caught.expectedGeometry).toBe(GEOMETRY_TABLE);
    expect(caught.evidence).toContain('Strict mode');
  });

  test('enforceStrict throws for chart block on non-chart slide', () => {
    // Slide 7 is a regulatory_table slide (no chart geometry)
    let caught = null;
    try {
      enforceStrict({
        blockKey: 'marketSizeAndGrowth',
        dataType: 'chart',
        data: {},
        templateSelection: 7, // table slide, no chart geometry
        tableContextKeys: TABLE_CONTEXTS,
        chartContextKeys: CHART_CONTEXTS,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(RouteGeometryError);
    expect(caught.code).toBe(ERROR_CODES.RGE004_STRICT_MODE_MISMATCH);
    expect(caught.blockKey).toBe('marketSizeAndGrowth');
    expect(caught.expectedGeometry).toBe(GEOMETRY_CHART);
  });
});

// ===========================================================================
// Non-strict mode: recovery with telemetry
// ===========================================================================
describe('non-strict mode: recovery with telemetry', () => {
  test('enforce recovers table block from wrong slide', () => {
    const result = enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      templateSelection: 1, // cover slide
      tableContextKeys: TABLE_CONTEXTS,
      chartContextKeys: CHART_CONTEXTS,
    });
    expect(result.recovered).toBe(true);
    expect(result.fromSlide).toBe(1);
    expect(result.toSlide).not.toBe(1);
    expect(result.reasonCode).toBe('geometry_recovery');
    expect(result.fallbackDepth).toBeGreaterThan(0);
  });

  test('enforce tracks recovery in metrics', () => {
    enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      templateSelection: 1,
      tableContextKeys: TABLE_CONTEXTS,
      chartContextKeys: CHART_CONTEXTS,
    });
    const metrics = getMetrics();
    expect(metrics.recoveredCount).toBe(1);
    expect(metrics.hardFailCount).toBe(0);
    expect(metrics.maxFallbackDepth).toBeGreaterThan(0);
  });

  test('enforce includes provenance chain showing recovery path', () => {
    const result = enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      templateSelection: 1,
      tableContextKeys: TABLE_CONTEXTS,
      chartContextKeys: CHART_CONTEXTS,
    });
    expect(Array.isArray(result.provenanceChain)).toBe(true);
    expect(result.provenanceChain.length).toBeGreaterThan(1);
    // First step should be FAIL (primary mismatch)
    expect(result.provenanceChain[0].result).toBe('FAIL');
    // Last step should be OK (recovery found)
    const lastStep = result.provenanceChain[result.provenanceChain.length - 1];
    expect(lastStep.result).toBe('OK');
  });
});

// ===========================================================================
// Strict vs non-strict: same inputs, different behavior
// ===========================================================================
describe('strict vs non-strict: same inputs, different behavior', () => {
  const mismatchOpts = {
    blockKey: 'foundationalActs',
    dataType: 'table',
    data: {},
    templateSelection: 1, // wrong geometry
    tableContextKeys: TABLE_CONTEXTS,
    chartContextKeys: CHART_CONTEXTS,
  };

  test('enforce succeeds via recovery where enforceStrict throws', () => {
    // Non-strict: recovers
    const result = enforce(mismatchOpts);
    expect(result.recovered).toBe(true);

    // Strict: throws
    expect(() => enforceStrict(mismatchOpts)).toThrow(RouteGeometryError);
  });

  test('metrics differ: enforce increments recoveredCount, enforceStrict increments hardFailCount', () => {
    resetMetrics();
    enforce(mismatchOpts);
    const afterEnforce = getMetrics();
    expect(afterEnforce.recoveredCount).toBe(1);
    expect(afterEnforce.hardFailCount).toBe(0);

    resetMetrics();
    try {
      enforceStrict(mismatchOpts);
    } catch (_) {
      // expected
    }
    const afterStrict = getMetrics();
    expect(afterStrict.recoveredCount).toBe(0);
    expect(afterStrict.hardFailCount).toBe(1);
  });
});

// ===========================================================================
// Both modes pass for correctly-mapped blocks
// ===========================================================================
describe('both modes pass for correctly-mapped blocks', () => {
  const correctBlocks = [
    { key: 'foundationalActs', geometry: GEOMETRY_TABLE },
    { key: 'nationalPolicy', geometry: GEOMETRY_TABLE },
    { key: 'marketSizeAndGrowth', geometry: GEOMETRY_CHART },
  ];

  for (const { key, geometry } of correctBlocks) {
    test(`${key} (${geometry}) passes in both modes`, () => {
      const normalResult = enforce({
        blockKey: key,
        dataType: geometry,
        data: {},
        tableContextKeys: TABLE_CONTEXTS,
        chartContextKeys: CHART_CONTEXTS,
      });
      expect(normalResult.recovered).toBe(false);

      const strictResult = enforceStrict({
        blockKey: key,
        dataType: geometry,
        data: {},
        tableContextKeys: TABLE_CONTEXTS,
        chartContextKeys: CHART_CONTEXTS,
      });
      expect(strictResult.recovered).toBe(false);
      expect(strictResult.strictMode).toBe(true);
      expect(normalResult.resolved.selectedSlide).toBe(strictResult.resolved.selectedSlide);
    });
  }
});

// ===========================================================================
// Error structure completeness
// ===========================================================================
describe('RouteGeometryError includes exact block keys', () => {
  test('error contains blockKey, targetSlide, expectedGeometry, and actualGeometry', () => {
    try {
      enforceStrict({
        blockKey: 'foundationalActs',
        dataType: 'table',
        data: {},
        templateSelection: 1,
        tableContextKeys: TABLE_CONTEXTS,
        chartContextKeys: CHART_CONTEXTS,
      });
      fail('Should have thrown');
    } catch (err) {
      expect(err.blockKey).toBe('foundationalActs');
      expect(err.targetSlide).toBeDefined();
      expect(err.expectedGeometry).toBe(GEOMETRY_TABLE);
      expect(typeof err.actualGeometry).toBe('string');
      expect(err.code).toBe(ERROR_CODES.RGE004_STRICT_MODE_MISMATCH);
      // Error message should include the block key for debugging
      expect(err.message).toContain('foundationalActs');
    }
  });

  test('failure is stored with full runInfo data', () => {
    try {
      enforceStrict({
        blockKey: 'localMajor',
        dataType: 'table',
        data: {},
        templateSelection: 1,
        tableContextKeys: TABLE_CONTEXTS,
        chartContextKeys: CHART_CONTEXTS,
      });
    } catch (_) {
      // expected
    }
    const failures = getFailures();
    const lastFailure = failures[failures.length - 1];
    expect(lastFailure.blockKey).toBe('localMajor');
    expect(lastFailure.errorCode).toBe(ERROR_CODES.RGE004_STRICT_MODE_MISMATCH);
    expect(lastFailure.expectedGeometry).toBe(GEOMETRY_TABLE);
    expect(typeof lastFailure.actualGeometry).toBe('string');
    expect(typeof lastFailure.evidence).toBe('string');
    expect(Array.isArray(lastFailure.provenanceChain)).toBe(true);
  });
});
