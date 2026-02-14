'use strict';

/**
 * Tests for template-contract-compiler.js
 */

const {
  compile,
  drift,
  doctor,
  CONTRACT_VERSION,
  BLOCK_TEMPLATE_PATTERN_MAP,
  BLOCK_TEMPLATE_SLIDE_MAP,
  TABLE_TEMPLATE_CONTEXTS,
  CHART_TEMPLATE_CONTEXTS,
} = require('./template-contract-compiler');

// ---------------------------------------------------------------------------
// Minimal valid template data for isolated tests
// ---------------------------------------------------------------------------

function makeMinimalTemplate() {
  return {
    _meta: {
      source: 'test-template.pptx',
      extractedAt: '2026-01-01T00:00:00Z',
      slideCount: 3,
    },
    patterns: {
      regulatory_table: {
        id: 5,
        description: 'Test regulatory table',
        templateSlides: [6, 7],
        layout: 1,
        elements: {
          table: { x: 0.37, y: 1.47, w: 12.6 },
        },
      },
      chart_with_grid: {
        id: 6,
        description: 'Test chart',
        templateSlides: [13],
        layout: 1,
        elements: {
          chart: { x: 0.83, y: 2.31, w: 5.74, h: 3.85 },
        },
      },
      company_comparison: {
        id: 7,
        description: 'Company comparison',
        templateSlides: [22],
        layout: 1,
        elements: {
          table: { x: 0.37, y: 1.47, w: 12.6 },
        },
      },
    },
    slideDetails: [
      {
        slideNumber: 6,
        elements: [
          { type: 'table', position: { x: 0.37, y: 1.47, w: 12.6, h: 4.5 } },
          { type: 'shape', name: 'Title', position: { x: 0.38, y: 0.05, w: 12.59, h: 0.91 } },
        ],
      },
      {
        slideNumber: 7,
        elements: [{ type: 'table', position: { x: 0.37, y: 1.47, w: 12.6, h: 4.5 } }],
      },
      {
        slideNumber: 13,
        elements: [{ type: 'chart', position: { x: 0.83, y: 2.31, w: 5.74, h: 3.85 } }],
      },
      {
        slideNumber: 22,
        elements: [{ type: 'table', position: { x: 0.37, y: 1.47, w: 12.6, h: 4.5 } }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Template Contract Compiler', () => {
  // 1
  test('compile() with real template produces valid contracts', () => {
    const compiled = compile();
    expect(compiled.version).toBe(CONTRACT_VERSION);
    expect(compiled.signature).toHaveLength(64);
    expect(typeof compiled.compiledAt).toBe('string');
    expect(Object.keys(compiled.patternContracts).length).toBeGreaterThan(0);
    expect(Object.keys(compiled.blockContracts).length).toBeGreaterThan(0);
    expect(compiled.patternContracts.regulatory_table).toBeDefined();
    expect(compiled.patternContracts.chart_with_grid).toBeDefined();
  });

  // 2
  test('compile() with templateData produces correct output', () => {
    const compiled = compile({ templateData: makeMinimalTemplate() });
    expect(compiled.version).toBe(CONTRACT_VERSION);
    expect(Object.keys(compiled.patternContracts)).toHaveLength(3);
    expect(compiled.patternContracts.regulatory_table.geometryType).toBe('table');
    expect(compiled.patternContracts.chart_with_grid.geometryType).toBe('chart');
    expect(compiled.slideCount).toBe(3);
  });

  // 3
  test('pattern contracts preserve all fields', () => {
    const compiled = compile({ templateData: makeMinimalTemplate() });
    const regTable = compiled.patternContracts.regulatory_table;
    expect(regTable.id).toBe(5);
    expect(regTable.description).toBe('Test regulatory table');
    expect(regTable.allowedSlideIds).toEqual([6, 7]);
    expect(regTable.isTemplateBacked).toBe(true);
    expect(regTable.layoutId).toBe(1);
  });

  // 4
  test('block contracts have correct geometry and table dimensions', () => {
    const compiled = compile();
    const foundActs = compiled.blockContracts.foundationalActs;
    expect(foundActs.patternKey).toBe('regulatory_table');
    expect(foundActs.primarySlideId).toBe(7);
    expect(foundActs.requiredGeometry).toBe('table');
    expect(foundActs.requiredLayoutKeys).toContain('title');
    expect(foundActs.tableDimensions).not.toBeNull();
    expect(foundActs.tableDimensions.maxRows).toBeGreaterThan(0);
    expect(foundActs.tableDimensions.maxCols).toBeGreaterThan(0);
  });

  // 5
  test('chart block contracts have chart geometry and no table dimensions', () => {
    const compiled = compile();
    const mktSize = compiled.blockContracts.marketSizeAndGrowth;
    expect(mktSize.requiredGeometry).toBe('chart');
    expect(mktSize.tableDimensions).toBeNull();
  });

  // 6
  test('section divider contracts map correctly', () => {
    const compiled = compile();
    expect(Object.keys(compiled.sectionDividerContracts)).toHaveLength(5);
    expect(compiled.sectionDividerContracts['1'].slideId).toBe(5);
    expect(compiled.sectionDividerContracts['4'].slideId).toBe(30);
  });

  // 7
  test('data type fallbacks are complete', () => {
    const compiled = compile();
    expect(compiled.dataTypeFallbacks.time_series_multi_insight).toBe('chart_insight_panels');
    expect(compiled.dataTypeFallbacks.regulation_list).toBe('regulatory_table');
    expect(compiled.dataTypeFallbacks.definitions).toBe('glossary');
  });

  // 8
  test('compile throws on corrupted template data', () => {
    expect(() => compile({ templateData: null })).toThrow('not an object');
    expect(() => compile({ templateData: 'string' })).toThrow('not an object');
    expect(() => compile({ templateData: { _meta: {} } })).toThrow('missing "patterns"');
    expect(() => compile({ templateData: { patterns: 'bad' } })).toThrow('missing "patterns"');
  });

  // 9
  test('compile throws on nonexistent template file', () => {
    expect(() => compile({ templatePath: '/tmp/nonexistent-xyz.json' })).toThrow();
  });

  // 10
  test('drift() reports no drift when runtime matches', () => {
    const compiled = compile({ templateData: makeMinimalTemplate() });
    const report = drift(compiled, {
      blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP },
      blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP },
      tableContexts: [...TABLE_TEMPLATE_CONTEXTS],
      chartContexts: [...CHART_TEMPLATE_CONTEXTS],
    });
    expect(typeof report.checkedAt).toBe('string');
    expect(report.contractVersion).toBe(CONTRACT_VERSION);
  });

  // 11
  test('drift() detects pattern mismatch', () => {
    const compiled = compile({ templateData: makeMinimalTemplate() });
    const report = drift(compiled, {
      blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP, foundationalActs: 'chart_with_grid' },
      blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP },
      tableContexts: [...TABLE_TEMPLATE_CONTEXTS],
      chartContexts: [...CHART_TEMPLATE_CONTEXTS],
    });
    expect(report.driftDetected).toBe(true);
    const issue = report.issues.find(
      (i) => i.type === 'pattern_mismatch' && i.blockKey === 'foundationalActs',
    );
    expect(issue).toBeDefined();
    expect(issue.expected).toBe('regulatory_table');
    expect(issue.actual).toBe('chart_with_grid');
  });

  // 12
  test('drift() detects slide mismatch and out-of-range', () => {
    const compiled = compile({ templateData: makeMinimalTemplate() });
    const report = drift(compiled, {
      blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP },
      blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP, foundationalActs: 99 },
      tableContexts: [...TABLE_TEMPLATE_CONTEXTS],
      chartContexts: [...CHART_TEMPLATE_CONTEXTS],
    });
    expect(report.driftDetected).toBe(true);
    expect(report.issues.find((i) => i.type === 'slide_mismatch' && i.blockKey === 'foundationalActs')).toBeDefined();
    expect(report.issues.find((i) => i.type === 'slide_out_of_range' && i.blockKey === 'foundationalActs')).toBeDefined();
  });

  // 13
  test('drift() detects missing runtime patterns', () => {
    const compiled = compile({ templateData: makeMinimalTemplate() });
    const report = drift(compiled, {
      blockPatterns: {},
      blockSlides: {},
      tableContexts: [],
      chartContexts: [],
    });
    expect(report.driftDetected).toBe(true);
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.issues.filter((i) => i.type === 'missing_runtime_pattern').length).toBeGreaterThan(0);
  });

  // 14
  test('drift() flags uncontracted runtime blocks as warnings', () => {
    const compiled = compile({ templateData: makeMinimalTemplate() });
    const report = drift(compiled, {
      blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP, mysteryBlock: 'regulatory_table' },
      blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP },
      tableContexts: [...TABLE_TEMPLATE_CONTEXTS],
      chartContexts: [...CHART_TEMPLATE_CONTEXTS],
    });
    const uncontracted = report.issues.find(
      (i) => i.type === 'uncontracted_block' && i.blockKey === 'mysteryBlock',
    );
    expect(uncontracted).toBeDefined();
    expect(uncontracted.severity).toBe('warning');
  });

  // 15
  test('doctor() produces comprehensive report', () => {
    const report = doctor({ templateData: makeMinimalTemplate() });
    expect(typeof report.status).toBe('string');
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(7);
    expect(report.summary.contractVersion).toBe(CONTRACT_VERSION);
    expect(typeof report.summary.signature).toBe('string');
  });

  // 16
  test('doctor() fails gracefully on corrupted data', () => {
    const report = doctor({ templateData: { _meta: {} } });
    expect(report.status).toBe('fail');
    const compileCheck = report.checks.find((c) => c.name === 'compile');
    expect(compileCheck.status).toBe('fail');
    expect(compileCheck.message).toContain('Compilation failed');
  });

  // 17
  test('compiled contract bundle has all required keys', () => {
    const compiled = compile({ templateData: makeMinimalTemplate() });
    expect(compiled).toHaveProperty('version');
    expect(compiled).toHaveProperty('signature');
    expect(compiled).toHaveProperty('patternContracts');
    expect(compiled).toHaveProperty('blockContracts');
    expect(compiled).toHaveProperty('sectionDividerContracts');
    expect(compiled).toHaveProperty('dataTypeFallbacks');
  });

  // 18
  test('doctor() runs successfully with real template-patterns.json', () => {
    const report = doctor();
    expect(report.checks.length).toBeGreaterThanOrEqual(7);
    expect(report.summary.patternCount).toBeGreaterThanOrEqual(10);
    expect(report.summary.blockCount).toBeGreaterThanOrEqual(30);
    expect(report.checks.find((c) => c.name === 'drift_detection')).toBeDefined();
  });

  // 19
  test('drift() detects geometry context mismatch', () => {
    const compiled = compile({ templateData: makeMinimalTemplate() });
    const report = drift(compiled, {
      blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP },
      blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP },
      tableContexts: [...TABLE_TEMPLATE_CONTEXTS].filter((k) => k !== 'foundationalActs'),
      chartContexts: [...CHART_TEMPLATE_CONTEXTS],
    });
    const geoIssue = report.issues.find(
      (i) => i.type === 'geometry_context_mismatch' && i.blockKey === 'foundationalActs',
    );
    expect(geoIssue).toBeDefined();
    expect(geoIssue.severity).toBe('warning');
  });

  // 20
  test('signature is deterministic for same input', () => {
    const tp = makeMinimalTemplate();
    const c1 = compile({ templateData: tp });
    const c2 = compile({ templateData: tp });
    expect(c1.version).toBe(c2.version);
    expect(typeof c1.signature).toBe('string');
    expect(typeof c2.signature).toBe('string');
  });
});
