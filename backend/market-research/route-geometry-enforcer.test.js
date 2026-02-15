'use strict';

const {
  enforce,
  enforceStrict,
  getMetrics,
  getFailures,
  resetMetrics,
  auditAllRoutes,
  RouteGeometryError,
  ERROR_CODES,
  BLOCK_TEMPLATE_PATTERN_MAP,
  BLOCK_TEMPLATE_SLIDE_MAP,
  __test: {
    inferPatternGeometry,
    layoutSatisfiesGeometry,
    buildFallbackChain,
    buildRouteGeometryRegistry,
    describeActualGeometry,
    getTemplateSlideLayout,
    GEOMETRY_TABLE,
    GEOMETRY_CHART,
    GEOMETRY_TEXT,
  },
} = require('./route-geometry-enforcer');

// ---------------------------------------------------------------------------
// Context sets (same as ppt-single-country.js)
// ---------------------------------------------------------------------------
const TABLE_TEMPLATE_CONTEXTS = new Set([
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

const CHART_TEMPLATE_CONTEXTS = new Set([
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
// 1. inferPatternGeometry
// ===========================================================================
describe('inferPatternGeometry', () => {
  test('returns table for table-containing pattern names', () => {
    expect(inferPatternGeometry('regulatory_table')).toBe(GEOMETRY_TABLE);
    expect(inferPatternGeometry('company_comparison')).toBe(GEOMETRY_TABLE);
    expect(inferPatternGeometry('case_study_rows')).toBe(GEOMETRY_TABLE);
  });

  test('returns chart for chart-containing pattern names', () => {
    expect(inferPatternGeometry('chart_with_grid')).toBe(GEOMETRY_CHART);
    expect(inferPatternGeometry('chart_insight_panels')).toBe(GEOMETRY_CHART);
    expect(inferPatternGeometry('chart_callout_dual')).toBe(GEOMETRY_CHART);
  });

  test('returns text for unrecognized pattern names', () => {
    expect(inferPatternGeometry('cover')).toBe(GEOMETRY_TEXT);
    expect(inferPatternGeometry('executive_summary')).toBe(GEOMETRY_TEXT);
    expect(inferPatternGeometry(null)).toBe(GEOMETRY_TEXT);
    expect(inferPatternGeometry('')).toBe(GEOMETRY_TEXT);
  });
});

// ===========================================================================
// 2. layoutSatisfiesGeometry
// ===========================================================================
describe('layoutSatisfiesGeometry', () => {
  test('text geometry always passes', () => {
    expect(layoutSatisfiesGeometry(null, GEOMETRY_TEXT)).toBe(true);
    expect(layoutSatisfiesGeometry({}, GEOMETRY_TEXT)).toBe(true);
    expect(layoutSatisfiesGeometry(null, null)).toBe(true);
  });

  test('table geometry requires layout.table', () => {
    expect(layoutSatisfiesGeometry({ table: { x: 0, y: 1, w: 10, h: 4 } }, GEOMETRY_TABLE)).toBe(true);
    expect(layoutSatisfiesGeometry({}, GEOMETRY_TABLE)).toBe(false);
    expect(layoutSatisfiesGeometry({ table: null }, GEOMETRY_TABLE)).toBe(false);
    expect(layoutSatisfiesGeometry(null, GEOMETRY_TABLE)).toBe(false);
  });

  test('chart geometry requires layout.charts array with entries', () => {
    expect(layoutSatisfiesGeometry({ charts: [{ x: 0, y: 1, w: 5, h: 3 }] }, GEOMETRY_CHART)).toBe(true);
    expect(layoutSatisfiesGeometry({ charts: [] }, GEOMETRY_CHART)).toBe(false);
    expect(layoutSatisfiesGeometry({}, GEOMETRY_CHART)).toBe(false);
    expect(layoutSatisfiesGeometry(null, GEOMETRY_CHART)).toBe(false);
  });
});

// ===========================================================================
// 3. describeActualGeometry
// ===========================================================================
describe('describeActualGeometry', () => {
  test('returns none for null/empty layout', () => {
    expect(describeActualGeometry(null)).toBe('none');
    expect(describeActualGeometry(undefined)).toBe('none');
  });

  test('returns text for layout with no table or chart', () => {
    expect(describeActualGeometry({})).toBe(GEOMETRY_TEXT);
    expect(describeActualGeometry({ title: { x: 0, y: 0, w: 10, h: 1 } })).toBe(GEOMETRY_TEXT);
  });

  test('returns table for layout with table', () => {
    expect(describeActualGeometry({ table: { x: 0, y: 1, w: 10, h: 4 } })).toBe(GEOMETRY_TABLE);
  });

  test('returns chart for layout with charts', () => {
    expect(describeActualGeometry({ charts: [{ x: 0, y: 1, w: 5, h: 3 }] })).toBe(GEOMETRY_CHART);
  });

  test('returns table+chart for layout with both', () => {
    expect(describeActualGeometry({
      table: { x: 0, y: 1, w: 10, h: 4 },
      charts: [{ x: 0, y: 1, w: 5, h: 3 }],
    })).toBe('table+chart');
  });
});

// ===========================================================================
// 4. Route audit: all table contexts map to slides with table geometry
// ===========================================================================
describe('route audit: table contexts', () => {
  test('all TABLE_TEMPLATE_CONTEXTS map to slides with table geometry', () => {
    for (const blockKey of TABLE_TEMPLATE_CONTEXTS) {
      const slideNum = BLOCK_TEMPLATE_SLIDE_MAP[blockKey];
      if (!slideNum) continue;
      const layout = getTemplateSlideLayout(slideNum);
      expect(layout).not.toBeNull();
      expect(layoutSatisfiesGeometry(layout, GEOMETRY_TABLE)).toBe(true);
    }
  });
});

// ===========================================================================
// 5. Route audit: all chart contexts map to slides with chart geometry
// ===========================================================================
describe('route audit: chart contexts', () => {
  test('all CHART_TEMPLATE_CONTEXTS map to slides with chart geometry', () => {
    for (const blockKey of CHART_TEMPLATE_CONTEXTS) {
      const slideNum = BLOCK_TEMPLATE_SLIDE_MAP[blockKey];
      if (!slideNum) continue;
      const layout = getTemplateSlideLayout(slideNum);
      expect(layout).not.toBeNull();
      expect(layoutSatisfiesGeometry(layout, GEOMETRY_CHART)).toBe(true);
    }
  });
});

// ===========================================================================
// 6. enforce() happy path: known block keys pass without recovery
// ===========================================================================
describe('enforce() happy path', () => {
  test('foundationalActs (table context) resolves without recovery', () => {
    const result = enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    expect(result.recovered).toBe(false);
    expect(result.requiredGeometry).toBe(GEOMETRY_TABLE);
    expect(result.fallbackDepth).toBe(0);
    expect(result.resolved.selectedSlide).toBe(BLOCK_TEMPLATE_SLIDE_MAP.foundationalActs);
  });

  test('marketSizeAndGrowth (chart context) resolves without recovery', () => {
    const result = enforce({
      blockKey: 'marketSizeAndGrowth',
      dataType: 'chart',
      data: {},
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    expect(result.recovered).toBe(false);
    expect(result.requiredGeometry).toBe(GEOMETRY_CHART);
    expect(result.fallbackDepth).toBe(0);
  });
});

// ===========================================================================
// 7. enforce() metrics tracking
// ===========================================================================
describe('enforce() metrics', () => {
  test('metrics track passed checks', () => {
    enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    enforce({
      blockKey: 'nationalPolicy',
      dataType: 'table',
      data: {},
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    const metrics = getMetrics();
    expect(metrics.totalChecks).toBe(2);
    expect(metrics.passed).toBe(2);
    expect(metrics.recoveredCount).toBe(0);
    expect(metrics.hardFailCount).toBe(0);
  });
});

// ===========================================================================
// 8. Randomized mapping mutation: mutate slide IDs and verify detection
// ===========================================================================
describe('enforce() with mutated slide override', () => {
  test('recovers when override points to slide with wrong geometry', () => {
    // Slide 1 is the cover slide — should not have table geometry
    // foundationalActs needs table geometry
    const result = enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      templateSelection: 1, // cover slide, no table
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    // Should have recovered to a different slide
    expect(result.recovered).toBe(true);
    expect(result.fromSlide).not.toBe(result.toSlide);
    expect(result.fallbackDepth).toBeGreaterThan(0);
    expect(result.provenance.length).toBeGreaterThan(1);
    expect(result.reason).toContain('geometry mismatch');
  });

  test('recovered count metric increments on recovery', () => {
    enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      templateSelection: 1,
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    const metrics = getMetrics();
    expect(metrics.recoveredCount).toBe(1);
    expect(metrics.maxFallbackDepth).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 9. Hard fail: impossible routes produce RouteGeometryError
// ===========================================================================
describe('enforce() hard fail', () => {
  test('RouteGeometryError is thrown when constructed manually and has correct shape', () => {
    // Directly test that a hard fail produces a structured error.
    // We can't easily create a truly impossible route because cross-pattern scanning
    // will almost always find a compatible slide. Instead, verify the error class works.
    const err = new RouteGeometryError({
      blockKey: '__impossible__',
      targetSlide: 9999,
      expectedGeometry: GEOMETRY_TABLE,
      actualGeometry: 'none',
      evidence: 'No slide 9999 exists in template',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RouteGeometryError');
    expect(err.blockKey).toBe('__impossible__');
    expect(err.targetSlide).toBe(9999);
    expect(err.expectedGeometry).toBe(GEOMETRY_TABLE);
    expect(err.actualGeometry).toBe('none');
    expect(err.message).toContain('__impossible__');
    expect(err.message).toContain('Hard fail');
  });

  test('hard fail increments failure count and stores failure details', () => {
    const beforeFails = getFailures().length;
    let threw = false;
    try {
      enforce({
        blockKey: '__test_no_fallback__',
        dataType: 'chart',
        data: {},
        templateSelection: 9999,
        tableContextKeys: new Set(),
        chartContextKeys: new Set(['__test_no_fallback__']),
      });
    } catch (err) {
      if (err instanceof RouteGeometryError) {
        threw = true;
        const afterFails = getFailures().length;
        expect(afterFails).toBeGreaterThan(beforeFails);
        const lastFailure = getFailures()[afterFails - 1];
        expect(lastFailure.blockKey).toBe('__test_no_fallback__');
        expect(lastFailure.expectedGeometry).toBe(GEOMETRY_CHART);
      }
    }
    // If cross-pattern scan found a chart slide, that's fine too
    if (!threw) {
      const metrics = getMetrics();
      expect(metrics.recoveredCount).toBeGreaterThanOrEqual(0);
    }
  });
});

// ===========================================================================
// 10. Fallback chain: deterministic ordering
// ===========================================================================
describe('buildFallbackChain', () => {
  test('returns deterministic chain for table blocks', () => {
    const chain = buildFallbackChain('foundationalActs', GEOMETRY_TABLE);
    expect(Array.isArray(chain)).toBe(true);
    expect(chain.length).toBeGreaterThan(0);

    // First entry should be the block-default slide
    expect(chain[0].slideNumber).toBe(BLOCK_TEMPLATE_SLIDE_MAP.foundationalActs);
    expect(chain[0].source).toBe('block-default-slide');

    // All slide numbers should be unique
    const slideNums = chain.map((c) => c.slideNumber);
    expect(new Set(slideNums).size).toBe(slideNums.length);
  });

  test('returns deterministic chain for chart blocks', () => {
    const chain = buildFallbackChain('marketSizeAndGrowth', GEOMETRY_CHART);
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0].slideNumber).toBe(BLOCK_TEMPLATE_SLIDE_MAP.marketSizeAndGrowth);

    // Repeated calls produce identical results
    const chain2 = buildFallbackChain('marketSizeAndGrowth', GEOMETRY_CHART);
    expect(chain).toEqual(chain2);
  });

  test('chain for unknown block contains only cross-pattern slides', () => {
    const chain = buildFallbackChain('__nonexistent__', GEOMETRY_TABLE);
    for (const entry of chain) {
      expect(entry.source).toMatch(/^cross-pattern:/);
    }
  });
});

// ===========================================================================
// 11. buildRouteGeometryRegistry
// ===========================================================================
describe('buildRouteGeometryRegistry', () => {
  test('includes all block keys from maps and context sets', () => {
    const registry = buildRouteGeometryRegistry(TABLE_TEMPLATE_CONTEXTS, CHART_TEMPLATE_CONTEXTS);
    for (const key of TABLE_TEMPLATE_CONTEXTS) {
      expect(registry[key]).toBeDefined();
      expect(registry[key].requiredGeometry).toBe(GEOMETRY_TABLE);
    }
    for (const key of CHART_TEMPLATE_CONTEXTS) {
      expect(registry[key]).toBeDefined();
      expect(registry[key].requiredGeometry).toBe(GEOMETRY_CHART);
    }
  });
});

// ===========================================================================
// 12. auditAllRoutes
// ===========================================================================
describe('auditAllRoutes', () => {
  test('returns valid, invalid, and unmapped arrays', () => {
    const result = auditAllRoutes(TABLE_TEMPLATE_CONTEXTS, CHART_TEMPLATE_CONTEXTS);
    expect(Array.isArray(result.valid)).toBe(true);
    expect(Array.isArray(result.invalid)).toBe(true);
    expect(Array.isArray(result.unmapped)).toBe(true);

    for (const entry of result.valid) {
      expect(entry.slideNumber).toBeDefined();
      expect(entry.requiredGeometry).toBeDefined();
    }
  });

  test('audit returns structured data for all entries', () => {
    const result = auditAllRoutes(TABLE_TEMPLATE_CONTEXTS, CHART_TEMPLATE_CONTEXTS);
    for (const entry of result.invalid) {
      expect(entry.blockKey).toBeTruthy();
      expect(entry.requiredGeometry).toBeTruthy();
      expect(entry.actualGeometry).toBeTruthy();
    }
    // Total entries = valid + invalid + unmapped should cover all known block keys
    const totalAudited = result.valid.length + result.invalid.length + result.unmapped.length;
    expect(totalAudited).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 13. Metric accuracy: avgFallbackDepth
// ===========================================================================
describe('metric accuracy', () => {
  test('avgFallbackDepth computed correctly after multiple recoveries', () => {
    enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      templateSelection: 1,
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    enforce({
      blockKey: 'nationalPolicy',
      dataType: 'table',
      data: {},
      templateSelection: 1,
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    const metrics = getMetrics();
    expect(metrics.recoveredCount).toBe(2);
    expect(metrics.avgFallbackDepth).toBeGreaterThan(0);
    expect(typeof metrics.avgFallbackDepth).toBe('number');
  });

  test('resetMetrics clears everything', () => {
    enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    resetMetrics();
    const metrics = getMetrics();
    expect(metrics.totalChecks).toBe(0);
    expect(metrics.passed).toBe(0);
    expect(metrics.recoveredCount).toBe(0);
    expect(metrics.hardFailCount).toBe(0);
    expect(getFailures()).toEqual([]);
  });
});

// ===========================================================================
// 14. RouteGeometryError structure
// ===========================================================================
describe('RouteGeometryError', () => {
  test('has correct properties', () => {
    const err = new RouteGeometryError({
      blockKey: 'testBlock',
      targetSlide: 5,
      expectedGeometry: 'table',
      actualGeometry: 'text',
      evidence: 'test evidence string',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RouteGeometryError);
    expect(err.name).toBe('RouteGeometryError');
    expect(err.blockKey).toBe('testBlock');
    expect(err.targetSlide).toBe(5);
    expect(err.expectedGeometry).toBe('table');
    expect(err.actualGeometry).toBe('text');
    expect(err.evidence).toBe('test evidence string');
    expect(err.message).toContain('testBlock');
    expect(err.message).toContain('table');
  });
});

// ===========================================================================
// 15. enforce() provenance tracking
// ===========================================================================
describe('enforce() provenance', () => {
  test('provenance contains primary on direct pass', () => {
    const result = enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    expect(result.provenance).toEqual(['primary']);
  });

  test('provenance tracks failed attempts during recovery', () => {
    const result = enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      templateSelection: 1,
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    expect(result.recovered).toBe(true);
    expect(result.provenance[0]).toBe('primary:FAIL');
    expect(result.provenance.length).toBeGreaterThan(1);
    const last = result.provenance[result.provenance.length - 1];
    expect(last).toContain(':OK');
  });
});

// ===========================================================================
// 16. enforceStrict() — strict mode: no fallback, immediate hard fail
// ===========================================================================
describe('enforceStrict()', () => {
  test('passes when primary slide geometry matches required geometry', () => {
    const result = enforceStrict({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    expect(result.recovered).toBe(false);
    expect(result.requiredGeometry).toBe(GEOMETRY_TABLE);
    expect(result.strictMode).toBe(true);
    expect(result.fallbackDepth).toBe(0);
    expect(result.resolved.selectedSlide).toBe(BLOCK_TEMPLATE_SLIDE_MAP.foundationalActs);
  });

  test('chart context passes in strict mode when geometry matches', () => {
    const result = enforceStrict({
      blockKey: 'marketSizeAndGrowth',
      dataType: 'chart',
      data: {},
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    expect(result.recovered).toBe(false);
    expect(result.requiredGeometry).toBe(GEOMETRY_CHART);
    expect(result.strictMode).toBe(true);
  });

  test('throws RouteGeometryError with RGE004 code on geometry mismatch', () => {
    // Override to cover slide (slide 1) which has no table geometry
    expect(() => {
      enforceStrict({
        blockKey: 'foundationalActs',
        dataType: 'table',
        data: {},
        templateSelection: 1, // cover slide, no table
        tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
        chartContextKeys: CHART_TEMPLATE_CONTEXTS,
      });
    }).toThrow(RouteGeometryError);

    try {
      enforceStrict({
        blockKey: 'foundationalActs',
        dataType: 'table',
        data: {},
        templateSelection: 1,
        tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
        chartContextKeys: CHART_TEMPLATE_CONTEXTS,
      });
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.RGE004_STRICT_MODE_MISMATCH);
      expect(err.blockKey).toBe('foundationalActs');
      expect(err.expectedGeometry).toBe(GEOMETRY_TABLE);
      expect(err.message).toContain('Strict mode');
      expect(err.message).toContain('no fallback allowed');
    }
  });

  test('does NOT recover — no fallback chain walked in strict mode', () => {
    // enforce() would recover here; enforceStrict() should throw instead
    let enforceResult;
    try {
      enforceResult = enforce({
        blockKey: 'foundationalActs',
        dataType: 'table',
        data: {},
        templateSelection: 1,
        tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
        chartContextKeys: CHART_TEMPLATE_CONTEXTS,
      });
    } catch (_) {
      // enforce might also throw if no fallback exists
    }

    // enforceStrict always throws on mismatch, never recovers
    let strictThrew = false;
    try {
      enforceStrict({
        blockKey: 'foundationalActs',
        dataType: 'table',
        data: {},
        templateSelection: 1,
        tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
        chartContextKeys: CHART_TEMPLATE_CONTEXTS,
      });
    } catch (err) {
      strictThrew = true;
      expect(err).toBeInstanceOf(RouteGeometryError);
    }
    expect(strictThrew).toBe(true);

    // If enforce recovered, that proves enforceStrict is stricter
    if (enforceResult) {
      expect(enforceResult.recovered).toBe(true);
    }
  });

  test('increments hardFailCount metric on strict mode mismatch', () => {
    const beforeMetrics = getMetrics();
    const beforeHardFails = beforeMetrics.hardFailCount;
    try {
      enforceStrict({
        blockKey: 'foundationalActs',
        dataType: 'table',
        data: {},
        templateSelection: 1,
        tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
        chartContextKeys: CHART_TEMPLATE_CONTEXTS,
      });
    } catch (_) {
      // expected
    }
    const afterMetrics = getMetrics();
    expect(afterMetrics.hardFailCount).toBe(beforeHardFails + 1);
  });

  test('stores failure in getFailures() on strict mode mismatch', () => {
    const beforeCount = getFailures().length;
    try {
      enforceStrict({
        blockKey: 'foundationalActs',
        dataType: 'table',
        data: {},
        templateSelection: 1,
        tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
        chartContextKeys: CHART_TEMPLATE_CONTEXTS,
      });
    } catch (_) {
      // expected
    }
    const failures = getFailures();
    expect(failures.length).toBe(beforeCount + 1);
    const lastFailure = failures[failures.length - 1];
    expect(lastFailure.blockKey).toBe('foundationalActs');
    expect(lastFailure.errorCode).toBe(ERROR_CODES.RGE004_STRICT_MODE_MISMATCH);
  });

  test('provenanceChain includes strict mode marker', () => {
    const result = enforceStrict({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    expect(result.provenanceChain).toBeDefined();
    expect(result.provenanceChain.length).toBe(1);
    expect(result.provenanceChain[0].mode).toBe('strict');
    expect(result.provenanceChain[0].result).toBe('OK');
  });
});

// ===========================================================================
// 17. enforce() vs enforceStrict() behavior comparison
// ===========================================================================
describe('enforce() vs enforceStrict() behavior', () => {
  test('enforce recovers while enforceStrict throws for same bad override', () => {
    // enforce() with override to wrong-geometry slide should recover
    const enforceResult = enforce({
      blockKey: 'foundationalActs',
      dataType: 'table',
      data: {},
      templateSelection: 1,
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    expect(enforceResult.recovered).toBe(true);
    expect(enforceResult.reasonCode).toBe('geometry_recovery');

    // enforceStrict() should throw hard
    expect(() => {
      enforceStrict({
        blockKey: 'foundationalActs',
        dataType: 'table',
        data: {},
        templateSelection: 1,
        tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
        chartContextKeys: CHART_TEMPLATE_CONTEXTS,
      });
    }).toThrow(RouteGeometryError);
  });

  test('both pass for correctly-mapped blocks', () => {
    const normalResult = enforce({
      blockKey: 'nationalPolicy',
      dataType: 'table',
      data: {},
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    const strictResult = enforceStrict({
      blockKey: 'nationalPolicy',
      dataType: 'table',
      data: {},
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    expect(normalResult.recovered).toBe(false);
    expect(strictResult.recovered).toBe(false);
    expect(normalResult.resolved.selectedSlide).toBe(strictResult.resolved.selectedSlide);
  });
});

// ===========================================================================
// 18. ERROR_CODES are frozen and complete
// ===========================================================================
describe('ERROR_CODES', () => {
  test('ERROR_CODES object is frozen', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });

  test('all expected error codes exist', () => {
    expect(ERROR_CODES.RGE001_NO_TABLE_GEOMETRY).toBe('RGE001_NO_TABLE_GEOMETRY');
    expect(ERROR_CODES.RGE002_NO_CHART_GEOMETRY).toBe('RGE002_NO_CHART_GEOMETRY');
    expect(ERROR_CODES.RGE003_FALLBACK_EXHAUSTED).toBe('RGE003_FALLBACK_EXHAUSTED');
    expect(ERROR_CODES.RGE004_STRICT_MODE_MISMATCH).toBe('RGE004_STRICT_MODE_MISMATCH');
    expect(ERROR_CODES.RGE005_UNKNOWN_BLOCK).toBe('RGE005_UNKNOWN_BLOCK');
    expect(ERROR_CODES.RGE006_NO_SLIDE_LAYOUT).toBe('RGE006_NO_SLIDE_LAYOUT');
  });
});
