'use strict';

/**
 * Template Contract Unification Tests
 *
 * Ensures all modules import mapping constants from the canonical source
 * (template-contract-compiler.js) and that no copy-paste drift exists.
 */

const {
  BLOCK_TEMPLATE_PATTERN_MAP,
  BLOCK_TEMPLATE_SLIDE_MAP,
  TABLE_TEMPLATE_CONTEXTS,
  CHART_TEMPLATE_CONTEXTS,
  SECTION_DIVIDER_TEMPLATE_SLIDES,
  DATA_TYPE_PATTERN_MAP,
  verifyMappingParity,
  assertMappingParity,
  compile,
} = require('./template-contract-compiler');

// ---------------------------------------------------------------------------
// 1. Contract compilation tests
// ---------------------------------------------------------------------------

describe('Template Contract Compilation', () => {
  test('compile() succeeds with real template-patterns.json', () => {
    const compiled = compile();
    expect(compiled.version).toBeDefined();
    expect(compiled.signature).toHaveLength(64);
    expect(Object.keys(compiled.blockContracts).length).toBeGreaterThan(0);
    expect(Object.keys(compiled.patternContracts).length).toBeGreaterThan(0);
  });

  test('all BLOCK_TEMPLATE_PATTERN_MAP keys have entries in BLOCK_TEMPLATE_SLIDE_MAP', () => {
    const patternKeys = Object.keys(BLOCK_TEMPLATE_PATTERN_MAP);
    const slideKeys = Object.keys(BLOCK_TEMPLATE_SLIDE_MAP);
    for (const key of patternKeys) {
      expect(slideKeys).toContain(key);
    }
  });

  test('all BLOCK_TEMPLATE_SLIDE_MAP keys have entries in BLOCK_TEMPLATE_PATTERN_MAP', () => {
    const patternKeys = Object.keys(BLOCK_TEMPLATE_PATTERN_MAP);
    const slideKeys = Object.keys(BLOCK_TEMPLATE_SLIDE_MAP);
    for (const key of slideKeys) {
      expect(patternKeys).toContain(key);
    }
  });

  test('TABLE_TEMPLATE_CONTEXTS and CHART_TEMPLATE_CONTEXTS are disjoint', () => {
    for (const key of TABLE_TEMPLATE_CONTEXTS) {
      expect(CHART_TEMPLATE_CONTEXTS.has(key)).toBe(false);
    }
    for (const key of CHART_TEMPLATE_CONTEXTS) {
      expect(TABLE_TEMPLATE_CONTEXTS.has(key)).toBe(false);
    }
  });

  test('all TABLE_TEMPLATE_CONTEXTS entries exist in BLOCK_TEMPLATE_PATTERN_MAP', () => {
    for (const key of TABLE_TEMPLATE_CONTEXTS) {
      expect(BLOCK_TEMPLATE_PATTERN_MAP[key]).toBeDefined();
    }
  });

  test('all CHART_TEMPLATE_CONTEXTS entries exist in BLOCK_TEMPLATE_PATTERN_MAP', () => {
    for (const key of CHART_TEMPLATE_CONTEXTS) {
      expect(BLOCK_TEMPLATE_PATTERN_MAP[key]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-module mapping parity tests
// ---------------------------------------------------------------------------

describe('Cross-Module Mapping Parity', () => {
  test('route-geometry-enforcer uses canonical BLOCK_TEMPLATE_PATTERN_MAP', () => {
    const rge = require('./route-geometry-enforcer');
    expect(rge.BLOCK_TEMPLATE_PATTERN_MAP).toBe(BLOCK_TEMPLATE_PATTERN_MAP);
  });

  test('route-geometry-enforcer uses canonical BLOCK_TEMPLATE_SLIDE_MAP', () => {
    const rge = require('./route-geometry-enforcer');
    expect(rge.BLOCK_TEMPLATE_SLIDE_MAP).toBe(BLOCK_TEMPLATE_SLIDE_MAP);
  });

  test('verifyMappingParity passes when consumer matches canonical', () => {
    const result = verifyMappingParity({
      name: 'test-consumer',
      blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP },
      blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP },
      tableContexts: new Set(TABLE_TEMPLATE_CONTEXTS),
      chartContexts: new Set(CHART_TEMPLATE_CONTEXTS),
      sectionDividers: { ...SECTION_DIVIDER_TEMPLATE_SLIDES },
      dataTypePatterns: { ...DATA_TYPE_PATTERN_MAP },
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('verifyMappingParity detects missing blockPattern key', () => {
    const modified = { ...BLOCK_TEMPLATE_PATTERN_MAP };
    delete modified.foundationalActs;
    const result = verifyMappingParity({
      name: 'test-missing',
      blockPatterns: modified,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('missing key "foundationalActs"'))).toBe(true);
  });

  test('verifyMappingParity detects extra blockPattern key', () => {
    const modified = { ...BLOCK_TEMPLATE_PATTERN_MAP, newBlock: 'regulatory_table' };
    const result = verifyMappingParity({
      name: 'test-extra',
      blockPatterns: modified,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('extra key "newBlock"'))).toBe(true);
  });

  test('verifyMappingParity detects value mismatch in blockPattern', () => {
    const modified = { ...BLOCK_TEMPLATE_PATTERN_MAP, foundationalActs: 'chart_with_grid' };
    const result = verifyMappingParity({
      name: 'test-mismatch',
      blockPatterns: modified,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('value mismatch for "foundationalActs"'))).toBe(true);
  });

  test('verifyMappingParity detects slide mismatch', () => {
    const modified = { ...BLOCK_TEMPLATE_SLIDE_MAP, foundationalActs: 999 };
    const result = verifyMappingParity({
      name: 'test-slide-mismatch',
      blockSlides: modified,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('value mismatch for "foundationalActs"'))).toBe(true);
  });

  test('verifyMappingParity detects missing tableContext entry', () => {
    const modified = new Set(TABLE_TEMPLATE_CONTEXTS);
    modified.delete('foundationalActs');
    const result = verifyMappingParity({
      name: 'test-table-missing',
      tableContexts: modified,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('missing entry "foundationalActs"'))).toBe(true);
  });

  test('verifyMappingParity detects extra chartContext entry', () => {
    const modified = new Set(CHART_TEMPLATE_CONTEXTS);
    modified.add('fakeEntry');
    const result = verifyMappingParity({
      name: 'test-chart-extra',
      chartContexts: modified,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('extra entry "fakeEntry"'))).toBe(true);
  });

  test('verifyMappingParity detects sectionDivider mismatch', () => {
    const modified = { ...SECTION_DIVIDER_TEMPLATE_SLIDES, 1: 99 };
    const result = verifyMappingParity({
      name: 'test-divider-mismatch',
      sectionDividers: modified,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('value mismatch for "1"'))).toBe(true);
  });

  test('verifyMappingParity handles null input gracefully', () => {
    const result = verifyMappingParity(null);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('verifyMappingParity skips checks for omitted mapping types', () => {
    const result = verifyMappingParity({
      name: 'test-partial',
      blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP },
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Negative tests: prove drift detector catches divergence
// ---------------------------------------------------------------------------

describe('Drift Detector Catches Divergence', () => {
  test('assertMappingParity throws on pattern drift', () => {
    expect(() =>
      assertMappingParity({
        name: 'drifted-consumer',
        blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP, foundationalActs: 'WRONG_PATTERN' },
      })
    ).toThrow('Template contract drift detected');
  });

  test('assertMappingParity throws on slide drift', () => {
    expect(() =>
      assertMappingParity({
        name: 'drifted-consumer',
        blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP, marketSizeAndGrowth: 999 },
      })
    ).toThrow('Template contract drift detected');
  });

  test('assertMappingParity throws on missing block key', () => {
    const partial = { ...BLOCK_TEMPLATE_PATTERN_MAP };
    delete partial.keyInsights;
    expect(() =>
      assertMappingParity({
        name: 'drifted-consumer',
        blockPatterns: partial,
      })
    ).toThrow('Template contract drift detected');
  });

  test('assertMappingParity does NOT throw when mappings match', () => {
    expect(() =>
      assertMappingParity({
        name: 'correct-consumer',
        blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP },
        blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP },
        tableContexts: TABLE_TEMPLATE_CONTEXTS,
        chartContexts: CHART_TEMPLATE_CONTEXTS,
        sectionDividers: { ...SECTION_DIVIDER_TEMPLATE_SLIDES },
      })
    ).not.toThrow();
  });

  test('assertMappingParity error message includes canonical source reminder', () => {
    try {
      assertMappingParity({
        name: 'test',
        blockPatterns: { foundationalActs: 'WRONG' },
      });
      fail('Should have thrown');
    } catch (e) {
      expect(e.message).toContain('template-contract-compiler.js');
      expect(e.message).toContain('canonical source');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Consistency invariants
// ---------------------------------------------------------------------------

describe('Mapping Consistency Invariants', () => {
  test('every block in TABLE_TEMPLATE_CONTEXTS maps to table-like pattern', () => {
    const tablePatterns = ['regulatory_table', 'company_comparison', 'case_study_rows'];
    for (const key of TABLE_TEMPLATE_CONTEXTS) {
      const pattern = BLOCK_TEMPLATE_PATTERN_MAP[key];
      expect(tablePatterns).toContain(pattern);
    }
  });

  test('every block in CHART_TEMPLATE_CONTEXTS maps to chart-like pattern', () => {
    const chartPatterns = ['chart_insight_panels', 'chart_with_grid', 'chart_callout_dual'];
    for (const key of CHART_TEMPLATE_CONTEXTS) {
      const pattern = BLOCK_TEMPLATE_PATTERN_MAP[key];
      expect(chartPatterns).toContain(pattern);
    }
  });

  test('SECTION_DIVIDER_TEMPLATE_SLIDES covers sections 1-5', () => {
    expect(SECTION_DIVIDER_TEMPLATE_SLIDES).toHaveProperty('1');
    expect(SECTION_DIVIDER_TEMPLATE_SLIDES).toHaveProperty('2');
    expect(SECTION_DIVIDER_TEMPLATE_SLIDES).toHaveProperty('3');
    expect(SECTION_DIVIDER_TEMPLATE_SLIDES).toHaveProperty('4');
    expect(SECTION_DIVIDER_TEMPLATE_SLIDES).toHaveProperty('5');
  });

  test('all slide IDs are positive integers', () => {
    for (const [key, slide] of Object.entries(BLOCK_TEMPLATE_SLIDE_MAP)) {
      expect(Number.isInteger(slide)).toBe(true);
      expect(slide).toBeGreaterThan(0);
    }
    for (const [key, slide] of Object.entries(SECTION_DIVIDER_TEMPLATE_SLIDES)) {
      expect(Number.isInteger(slide)).toBe(true);
      expect(slide).toBeGreaterThan(0);
    }
  });

  test('DATA_TYPE_PATTERN_MAP values are valid pattern keys', () => {
    const validPatterns = [
      'chart_insight_panels', 'chart_with_grid', 'chart_callout_dual',
      'company_comparison', 'regulatory_table', 'case_study_rows',
      'dual_chart_financial', 'glossary',
    ];
    for (const [dataType, pattern] of Object.entries(DATA_TYPE_PATTERN_MAP)) {
      expect(validPatterns).toContain(pattern);
    }
  });
});
