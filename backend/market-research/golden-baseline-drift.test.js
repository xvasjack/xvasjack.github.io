'use strict';

/**
 * Golden Baseline Drift System — Tests
 *
 * Covers:
 * 1. Structural baseline capture (geometry, text, fonts, colors, sections, templates)
 * 2. Structural drift detection (strict violations vs tolerated drift)
 * 3. Geometry invariant enforcement (position/dimension drift)
 * 4. Text invariant enforcement (headings, slide titles, country)
 * 5. Font/color specification drift
 * 6. Section/template structure drift
 * 7. Combined gate + structural drift checks
 * 8. Baseline persistence (save/load/delete)
 * 9. Stable output reproducibility (same input = same baseline)
 * 10. Intentional drift detection (changed geometry, missing placeholder)
 *
 * Run: node golden-baseline-drift.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  captureStructuralBaseline,
  saveStructuralBaseline,
  loadStructuralBaseline,
  deleteStructuralBaseline,
  compareStructuralBaseline,
  detectStructuralDrift,
  runFullDriftCheck,
  createBaseline,
  loadBaseline,
  deleteBaseline,
  compareToBaseline,
  detectDrift,
  DRIFT_THRESHOLDS,
  __test: {
    flattenObject,
    extractSlideDimensions,
    extractGeometryInvariants,
    extractTextInvariants,
    extractFontSpecifications,
    extractColorSpecifications,
    extractSectionStructure,
    extractTemplateStructure,
    compareSlideDimensions,
    compareGeometryInvariants,
    compareFontSpecifications,
    compareColorSpecifications,
    compareSectionStructure,
    compareTextInvariants,
    compareTemplateStructure,
    STRUCTURAL_BASELINES_DIR,
  },
} = require('./golden-baseline-manager');

// ============ TEST FIXTURES ============

const GOLD_TEMPLATE_PATTERNS = {
  style: {
    slideWidth: 13.3333,
    slideHeight: 7.5,
    slideWidthEmu: 12192000,
    slideHeightEmu: 6858000,
    fonts: {
      majorLatin: 'Segoe UI',
      minorLatin: 'Segoe UI',
      title: { family: 'Segoe UI', size: 20, bold: false },
      tableHeader: { family: 'Segoe UI', size: 14, bold: false },
      tableBody: { family: 'Segoe UI', size: 14, bold: false },
      footer: { family: 'Segoe UI', size: 8 },
      source: { family: 'Segoe UI', size: 10 },
    },
    colors: {
      dk1: '000000',
      lt1: 'FFFFFF',
      dk2: '1F497D',
      accent1: '007FFF',
      accent2: 'EDFDFF',
      accent6: 'E46C0A',
      tableHeaderFill: 'FFFFFF',
      chartSeries: ['1736B6', '8EC1FF', 'D6D7D9'],
    },
  },
  pptxPositions: {
    title: { x: 0.3758, y: 0.0488, w: 12.5862, h: 0.9097 },
    contentArea: { x: 0.3758, y: 1.5, w: 12.5862, h: 5 },
    sourceBar: { x: 0.3758, y: 6.6944, w: 12.5862, h: 0.27 },
    headerLineTop: { x: 0, y: 1.0208, w: 13.3333, h: 0 },
    footerLine: { x: 0, y: 7.2361, w: 13.3333, h: 0 },
  },
  patterns: {
    cover: {
      id: 1,
      layout: 3,
      templateSlides: [1],
      elements: {
        companyName: { x: 0.4555, y: 1.6333, w: 9.3541, h: 2.8349 },
        projectTitle: { x: 0.4555, y: 4.862, w: 9.3541, h: 1.6491 },
        logo: { x: 0.4467, y: 0.3228, w: 1.1389, h: 0.4027 },
      },
    },
    regulatory_table: {
      id: 5,
      layout: 1,
      templateSlides: [6, 7, 8],
      elements: {
        titleBar: { x: 0.38, y: 0.05, w: 12.59, h: 0.91 },
        table: { x: 0.3667, y: 1.467, w: 12.6 },
      },
    },
    chart_with_grid: {
      id: 6,
      layout: 1,
      templateSlides: [13, 14, 15],
      elements: {
        titleBar: { x: 0.38, y: 0.05, w: 12.59, h: 0.91 },
        chart: { x: 0.83, y: 2.31, w: 5.74, h: 3.85 },
      },
    },
  },
};

const GOLD_COUNTRY_ANALYSIS = {
  country: 'Test Country',
  policy: {
    foundationalActs: {
      slideTitle: 'Test Country - Foundational Acts',
      overview: 'Regulatory framework supports investment',
    },
    nationalPolicy: {
      slideTitle: 'Test Country - National Policy',
      overview: 'Government targets growth',
    },
    investmentRestrictions: {
      slideTitle: 'Test Country - Foreign Investment Rules',
      overview: 'Foreign ownership limits apply',
    },
  },
  market: {
    marketSizeAndGrowth: {
      slideTitle: 'Test Country - Market Size & Growth',
      overview: 'TAM exceeds USD 12 billion',
      chartData: { series: [{ name: '2024', value: 10 }] },
    },
    supplyAndDemandDynamics: {
      slideTitle: 'Test Country - Supply & Demand',
      overview: 'Demand exceeds supply',
    },
  },
  competitors: {
    localMajor: {
      slideTitle: 'Test Country - Local Players',
      players: [{ name: 'Local Corp' }],
    },
    foreignPlayers: {
      slideTitle: 'Test Country - Foreign Players',
      players: [{ name: 'Global Inc' }],
    },
  },
  depth: {
    dealEconomics: {
      slideTitle: 'Test Country - Deal Economics',
      overview: 'Attractive deal structures',
    },
    entryStrategy: {
      slideTitle: 'Test Country - Entry Strategy',
      overview: 'Phased JV entry',
    },
  },
  summary: {
    recommendations: {
      slideTitle: 'Test Country - Recommendations',
      overview: 'Go with staged investment',
    },
    goNoGo: {
      slideTitle: 'Test Country - Go/No-Go',
      overallVerdict: 'GO',
    },
  },
};

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  FAIL: ${name} — ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  FAIL: ${name} — ${err.message}`);
  }
}

// ============ TESTS ============

console.log('\n[Golden Baseline Drift Tests]');

// --- 1. Structural Baseline Capture ---

console.log('\n  --- Structural Baseline Capture ---');

test('captureStructuralBaseline returns complete snapshot', () => {
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  assert(snapshot._meta, 'Should have _meta');
  assert(snapshot._meta.version === '2.0.0', 'Version should be 2.0.0');
  assert(snapshot.slideDimensions, 'Should have slideDimensions');
  assert(snapshot.geometryInvariants, 'Should have geometryInvariants');
  assert(snapshot.textInvariants, 'Should have textInvariants');
  assert(snapshot.fontSpecifications, 'Should have fontSpecifications');
  assert(snapshot.colorSpecifications, 'Should have colorSpecifications');
  assert(snapshot.sectionStructure, 'Should have sectionStructure');
  assert(snapshot.templateStructure, 'Should have templateStructure');
});

test('extractSlideDimensions captures correct values', () => {
  const dims = extractSlideDimensions(GOLD_TEMPLATE_PATTERNS);
  assert.strictEqual(dims.widthInches, 13.3333);
  assert.strictEqual(dims.heightInches, 7.5);
  assert.strictEqual(dims.widthEmu, 12192000);
  assert.strictEqual(dims.heightEmu, 6858000);
});

test('extractSlideDimensions handles missing style', () => {
  const dims = extractSlideDimensions({});
  assert.strictEqual(dims.widthInches, 13.3333); // defaults
  assert.strictEqual(dims.heightInches, 7.5);
});

test('extractGeometryInvariants captures positions', () => {
  const geo = extractGeometryInvariants(GOLD_TEMPLATE_PATTERNS);
  assert(geo.title, 'Should capture title position');
  assert.strictEqual(geo.title.x, 0.3758);
  assert.strictEqual(geo.title.y, 0.0488);
  assert(geo.contentArea, 'Should capture contentArea position');
  assert.strictEqual(geo.contentArea.w, 12.5862);
});

test('extractGeometryInvariants captures pattern element positions', () => {
  const geo = extractGeometryInvariants(GOLD_TEMPLATE_PATTERNS);
  assert(geo['cover.companyName'], 'Should capture cover.companyName');
  assert.strictEqual(geo['cover.companyName'].x, 0.4555);
  assert.strictEqual(geo['cover.companyName'].y, 1.6333);
  assert(geo['chart_with_grid.chart'], 'Should capture chart_with_grid.chart');
  assert.strictEqual(geo['chart_with_grid.chart'].w, 5.74);
});

test('extractTextInvariants captures sections and titles', () => {
  const text = extractTextInvariants(GOLD_COUNTRY_ANALYSIS);
  assert.strictEqual(text.country, 'Test Country');
  assert.deepStrictEqual(text.sectionHeadings, [
    'policy',
    'market',
    'competitors',
    'depth',
    'summary',
  ]);
  assert(text.slideTitles.length >= 5, 'Should have at least 5 slide titles');
  assert(
    text.slideTitles.some((t) => t.slideTitle === 'Test Country - Foundational Acts'),
    'Should contain foundationalActs title'
  );
});

test('extractTextInvariants handles null input', () => {
  const text = extractTextInvariants(null);
  assert.deepStrictEqual(text, {});
});

test('extractFontSpecifications captures all fonts', () => {
  const fonts = extractFontSpecifications(GOLD_TEMPLATE_PATTERNS);
  assert.strictEqual(fonts.majorLatin, 'Segoe UI');
  assert.strictEqual(fonts.title.family, 'Segoe UI');
  assert.strictEqual(fonts.title.size, 20);
  assert.strictEqual(fonts.tableHeader.size, 14);
});

test('extractColorSpecifications captures all colors', () => {
  const colors = extractColorSpecifications(GOLD_TEMPLATE_PATTERNS);
  assert.strictEqual(colors.dk1, '000000');
  assert.strictEqual(colors.accent1, '007FFF');
  assert.strictEqual(colors.accent6, 'E46C0A');
  assert(Array.isArray(colors.chartSeries), 'chartSeries should be array');
});

test('extractSectionStructure maps all sections', () => {
  const structure = extractSectionStructure(GOLD_COUNTRY_ANALYSIS);
  assert.strictEqual(structure.policy.present, true);
  assert(structure.policy.subKeys.includes('foundationalActs'));
  assert(structure.policy.subKeys.includes('nationalPolicy'));
  assert.strictEqual(structure.market.present, true);
  assert.strictEqual(structure.competitors.present, true);
  assert.strictEqual(structure.depth.present, true);
  assert.strictEqual(structure.summary.present, true);
});

test('extractTemplateStructure maps patterns', () => {
  const structure = extractTemplateStructure(GOLD_TEMPLATE_PATTERNS);
  assert(structure.cover, 'Should have cover pattern');
  assert.strictEqual(structure.cover.id, 1);
  assert.strictEqual(structure.cover.layout, 3);
  assert(structure.cover.elementKeys.includes('companyName'));
  assert(structure.cover.elementKeys.includes('projectTitle'));
  assert(structure.cover.elementKeys.includes('logo'));
});

// --- 2. Reproducibility ---

console.log('\n  --- Reproducibility ---');

test('same input produces identical structural baselines (deterministic)', () => {
  const snapshot1 = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);
  const snapshot2 = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  // Remove timestamps for comparison
  delete snapshot1._meta.capturedAt;
  delete snapshot2._meta.capturedAt;

  assert.deepStrictEqual(snapshot1, snapshot2, 'Two captures from same input must be identical');
});

test('comparing identical snapshots produces zero drift', () => {
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);
  const drift = detectStructuralDrift(snapshot, snapshot, DRIFT_THRESHOLDS);
  assert.strictEqual(
    drift.strictViolations.length,
    0,
    'No strict violations for identical snapshots'
  );
  assert.strictEqual(drift.toleratedDrift.length, 0, 'No tolerated drift for identical snapshots');
  assert.strictEqual(drift.totalDriftItems, 0, 'Total drift should be 0');
});

// --- 3. Geometry Drift Detection ---

console.log('\n  --- Geometry Drift Detection ---');

test('geometry drift beyond tolerance triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { title: { x: 0.3758, y: 0.0488, w: 12.5862, h: 0.9097 } };
  const current = { title: { x: 0.5, y: 0.0488, w: 12.5862, h: 0.9097 } }; // x shifted 0.1243

  compareGeometryInvariants(baseline, current, DRIFT_THRESHOLDS, report);
  assert(
    report.strictViolations.some((v) => v.category === 'geometry-drift' && v.dimension === 'x'),
    'Should detect strict geometry drift on x'
  );
});

test('geometry drift within tolerance triggers tolerated drift', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { title: { x: 0.3758, y: 0.0488, w: 12.5862, h: 0.9097 } };
  const current = { title: { x: 0.379, y: 0.0488, w: 12.5862, h: 0.9097 } }; // x shifted 0.0032

  compareGeometryInvariants(baseline, current, DRIFT_THRESHOLDS, report);
  assert.strictEqual(report.strictViolations.length, 0, 'Should not have strict violations');
  assert(
    report.toleratedDrift.some((v) => v.category === 'geometry-drift-minor'),
    'Should have tolerated geometry drift'
  );
});

test('missing geometry element triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = {
    title: { x: 0.38, y: 0.05, w: 12.59, h: 0.91 },
    content: { x: 0.38, y: 1.5, w: 12.59, h: 5 },
  };
  const current = { title: { x: 0.38, y: 0.05, w: 12.59, h: 0.91 } }; // content missing

  compareGeometryInvariants(baseline, current, DRIFT_THRESHOLDS, report);
  assert(
    report.strictViolations.some((v) => v.category === 'geometry-removed'),
    'Should detect removed geometry element'
  );
});

test('new geometry element triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { title: { x: 0.38, y: 0.05, w: 12.59, h: 0.91 } };
  const current = {
    title: { x: 0.38, y: 0.05, w: 12.59, h: 0.91 },
    newElem: { x: 1, y: 2, w: 3, h: 4 },
  };

  compareGeometryInvariants(baseline, current, DRIFT_THRESHOLDS, report);
  assert(
    report.strictViolations.some((v) => v.category === 'geometry-added'),
    'Should detect added geometry element'
  );
});

// --- 4. Slide Dimension Drift ---

console.log('\n  --- Slide Dimension Drift ---');

test('changed slide dimensions trigger strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = {
    widthInches: 13.3333,
    heightInches: 7.5,
    widthEmu: 12192000,
    heightEmu: 6858000,
  };
  const current = { widthInches: 10.0, heightInches: 7.5, widthEmu: 9144000, heightEmu: 6858000 };

  compareSlideDimensions(baseline, current, DRIFT_THRESHOLDS, report);
  assert(
    report.strictViolations.some((v) => v.field === 'widthInches'),
    'Should detect width change'
  );
  assert(
    report.strictViolations.some((v) => v.field === 'widthEmu'),
    'Should detect EMU width change'
  );
});

test('identical slide dimensions produce no drift', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const dims = { widthInches: 13.3333, heightInches: 7.5, widthEmu: 12192000, heightEmu: 6858000 };

  compareSlideDimensions(dims, dims, DRIFT_THRESHOLDS, report);
  assert.strictEqual(report.strictViolations.length, 0);
  assert.strictEqual(report.toleratedDrift.length, 0);
});

// --- 5. Font Drift ---

console.log('\n  --- Font Drift ---');

test('font family change triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { majorLatin: 'Segoe UI', title: { family: 'Segoe UI', size: 20 } };
  const current = { majorLatin: 'Arial', title: { family: 'Arial', size: 20 } };

  compareFontSpecifications(baseline, current, report);
  assert(
    report.strictViolations.some((v) => v.category === 'font-changed' && v.field === 'majorLatin'),
    'Should detect font family change'
  );
});

test('font size change triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { title: { family: 'Segoe UI', size: 20 } };
  const current = { title: { family: 'Segoe UI', size: 18 } };

  compareFontSpecifications(baseline, current, report);
  assert(
    report.strictViolations.some((v) => v.category === 'font-changed'),
    'Should detect font size change'
  );
});

test('removed font spec triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { majorLatin: 'Segoe UI', footer: { family: 'Segoe UI', size: 8 } };
  const current = { majorLatin: 'Segoe UI' };

  compareFontSpecifications(baseline, current, report);
  assert(
    report.strictViolations.some((v) => v.category === 'font-removed'),
    'Should detect removed font spec'
  );
});

test('new font spec triggers tolerated drift', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { majorLatin: 'Segoe UI' };
  const current = { majorLatin: 'Segoe UI', newFont: { family: 'Consolas', size: 12 } };

  compareFontSpecifications(baseline, current, report);
  assert(
    report.toleratedDrift.some((v) => v.category === 'font-added'),
    'Should detect added font spec as tolerated'
  );
});

// --- 6. Color Drift ---

console.log('\n  --- Color Drift ---');

test('color value change triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { accent1: '007FFF', dk1: '000000' };
  const current = { accent1: 'FF0000', dk1: '000000' };

  compareColorSpecifications(baseline, current, report);
  assert(
    report.strictViolations.some((v) => v.category === 'color-changed' && v.field === 'accent1'),
    'Should detect color value change'
  );
});

test('removed color triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { accent1: '007FFF', accent2: 'EDFDFF' };
  const current = { accent1: '007FFF' };

  compareColorSpecifications(baseline, current, report);
  assert(
    report.strictViolations.some((v) => v.category === 'color-removed'),
    'Should detect removed color'
  );
});

test('new color triggers tolerated drift', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { accent1: '007FFF' };
  const current = { accent1: '007FFF', newColor: 'AABBCC' };

  compareColorSpecifications(baseline, current, report);
  assert(
    report.toleratedDrift.some((v) => v.category === 'color-added'),
    'Should detect added color as tolerated'
  );
});

// --- 7. Section Structure Drift ---

console.log('\n  --- Section Structure Drift ---');

test('missing section triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = {
    policy: { present: true, subKeys: ['foundationalActs'] },
    market: { present: true, subKeys: ['marketSizeAndGrowth'] },
  };
  const current = {
    policy: { present: true, subKeys: ['foundationalActs'] },
    market: { present: false, subKeys: [] },
  };

  compareSectionStructure(baseline, current, report);
  assert(
    report.strictViolations.some((v) => v.category === 'section-missing' && v.section === 'market'),
    'Should detect missing section'
  );
});

test('removed subkey triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { policy: { present: true, subKeys: ['foundationalActs', 'nationalPolicy'] } };
  const current = { policy: { present: true, subKeys: ['foundationalActs'] } };

  compareSectionStructure(baseline, current, report);
  assert(
    report.strictViolations.some(
      (v) => v.category === 'subkey-removed' && v.subKey === 'nationalPolicy'
    ),
    'Should detect removed subkey'
  );
});

test('added subkey triggers tolerated drift', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { policy: { present: true, subKeys: ['foundationalActs'] } };
  const current = { policy: { present: true, subKeys: ['foundationalActs', 'newSubKey'] } };

  compareSectionStructure(baseline, current, report);
  assert(
    report.toleratedDrift.some((v) => v.category === 'subkey-added' && v.subKey === 'newSubKey'),
    'Should detect added subkey as tolerated'
  );
});

// --- 8. Text Invariant Drift ---

console.log('\n  --- Text Invariant Drift ---');

test('country mismatch triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { country: 'Vietnam', sectionHeadings: ['policy'], slideTitles: [] };
  const current = { country: 'Thailand', sectionHeadings: ['policy'], slideTitles: [] };

  compareTextInvariants(baseline, current, DRIFT_THRESHOLDS, report);
  assert(
    report.strictViolations.some((v) => v.category === 'country-mismatch'),
    'Should detect country mismatch'
  );
});

test('removed heading triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = {
    country: 'Test',
    sectionHeadings: ['policy', 'market', 'competitors'],
    slideTitles: [],
  };
  const current = { country: 'Test', sectionHeadings: ['policy', 'market'], slideTitles: [] };

  compareTextInvariants(baseline, current, DRIFT_THRESHOLDS, report);
  assert(
    report.strictViolations.some(
      (v) => v.category === 'heading-removed' && v.heading === 'competitors'
    ),
    'Should detect removed heading'
  );
});

test('removed slide title triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = {
    country: 'Test',
    sectionHeadings: ['policy'],
    slideTitles: [
      { section: 'policy', subKey: 'foundationalActs', slideTitle: 'Acts' },
      { section: 'policy', subKey: 'nationalPolicy', slideTitle: 'Policy' },
    ],
  };
  const current = {
    country: 'Test',
    sectionHeadings: ['policy'],
    slideTitles: [{ section: 'policy', subKey: 'foundationalActs', slideTitle: 'Acts' }],
  };

  compareTextInvariants(baseline, current, DRIFT_THRESHOLDS, report);
  assert(
    report.strictViolations.some((v) => v.category === 'slide-title-removed'),
    'Should detect removed slide title'
  );
});

// --- 9. Template Structure Drift ---

console.log('\n  --- Template Structure Drift ---');

test('removed pattern triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = {
    cover: { id: 1, layout: 3, elementKeys: ['companyName', 'logo'] },
    table: { id: 5, layout: 1, elementKeys: ['titleBar'] },
  };
  const current = {
    cover: { id: 1, layout: 3, elementKeys: ['companyName', 'logo'] },
  };

  compareTemplateStructure(baseline, current, report);
  assert(
    report.strictViolations.some((v) => v.category === 'pattern-removed' && v.pattern === 'table'),
    'Should detect removed pattern'
  );
});

test('layout change triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { cover: { id: 1, layout: 3, elementKeys: ['companyName'] } };
  const current = { cover: { id: 1, layout: 2, elementKeys: ['companyName'] } };

  compareTemplateStructure(baseline, current, report);
  assert(
    report.strictViolations.some((v) => v.category === 'pattern-layout-changed'),
    'Should detect layout change'
  );
});

test('removed element key triggers strict violation', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = {
    cover: { id: 1, layout: 3, elementKeys: ['companyName', 'logo', 'projectTitle'] },
  };
  const current = { cover: { id: 1, layout: 3, elementKeys: ['companyName', 'logo'] } };

  compareTemplateStructure(baseline, current, report);
  assert(
    report.strictViolations.some(
      (v) => v.category === 'pattern-element-removed' && v.element === 'projectTitle'
    ),
    'Should detect removed element'
  );
});

test('added element key triggers tolerated drift', () => {
  const report = { strictViolations: [], toleratedDrift: [] };
  const baseline = { cover: { id: 1, layout: 3, elementKeys: ['companyName'] } };
  const current = { cover: { id: 1, layout: 3, elementKeys: ['companyName', 'newElement'] } };

  compareTemplateStructure(baseline, current, report);
  assert(
    report.toleratedDrift.some((v) => v.category === 'pattern-element-added'),
    'Should detect added element as tolerated'
  );
});

// --- 10. Structural Baseline Persistence ---

console.log('\n  --- Structural Baseline Persistence ---');

test('save and load structural baseline round-trips correctly', () => {
  const testName = '__test-golden-drift-persistence';
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    saveStructuralBaseline(testName, snapshot);
    const loaded = loadStructuralBaseline(testName);
    assert(loaded, 'Should load saved baseline');
    assert.deepStrictEqual(loaded, snapshot, 'Loaded should match saved');
  } finally {
    deleteStructuralBaseline(testName);
  }
});

test('deleteStructuralBaseline removes the file', () => {
  const testName = '__test-golden-drift-delete';
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);
  saveStructuralBaseline(testName, snapshot);

  const deleted = deleteStructuralBaseline(testName);
  assert.strictEqual(deleted, true, 'Should return true on delete');

  const loaded = loadStructuralBaseline(testName);
  assert.strictEqual(loaded, null, 'Should return null after delete');
});

test('loadStructuralBaseline returns null for nonexistent baseline', () => {
  const loaded = loadStructuralBaseline('__nonexistent-test-baseline');
  assert.strictEqual(loaded, null);
});

test('deleteStructuralBaseline returns false for nonexistent baseline', () => {
  const deleted = deleteStructuralBaseline('__nonexistent-test-baseline');
  assert.strictEqual(deleted, false);
});

// --- 11. Full Structural Comparison via compareStructuralBaseline ---

console.log('\n  --- Full Structural Comparison ---');

test('compareStructuralBaseline returns PASS for identical snapshots', () => {
  const testName = '__test-golden-drift-pass';
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    saveStructuralBaseline(testName, snapshot);
    const result = compareStructuralBaseline(testName, snapshot);

    assert.strictEqual(result.baselineFound, true);
    assert.strictEqual(result.hasDrift, false);
    assert.strictEqual(result.hasStrictViolations, false);
    assert.strictEqual(result.hasToleratedDrift, false);
    assert.strictEqual(result.verdict, 'PASS');
  } finally {
    deleteStructuralBaseline(testName);
  }
});

test('compareStructuralBaseline returns FAIL for geometry violations', () => {
  const testName = '__test-golden-drift-fail';
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    saveStructuralBaseline(testName, snapshot);

    // Modify geometry in current snapshot
    const drifted = JSON.parse(JSON.stringify(snapshot));
    if (drifted.geometryInvariants.title) {
      drifted.geometryInvariants.title.x = 5.0; // big drift
    }

    const result = compareStructuralBaseline(testName, drifted);
    assert.strictEqual(result.baselineFound, true);
    assert.strictEqual(result.hasStrictViolations, true);
    assert.strictEqual(result.verdict, 'FAIL');
  } finally {
    deleteStructuralBaseline(testName);
  }
});

test('compareStructuralBaseline returns WARN for tolerated-only drift', () => {
  const testName = '__test-golden-drift-warn';
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    saveStructuralBaseline(testName, snapshot);

    // Add a new color (tolerated)
    const drifted = JSON.parse(JSON.stringify(snapshot));
    drifted.colorSpecifications.newAccent = 'AABBCC';

    const result = compareStructuralBaseline(testName, drifted);
    assert.strictEqual(result.baselineFound, true);
    assert.strictEqual(result.hasStrictViolations, false);
    assert.strictEqual(result.hasToleratedDrift, true);
    assert.strictEqual(result.verdict, 'WARN');
  } finally {
    deleteStructuralBaseline(testName);
  }
});

test('compareStructuralBaseline handles missing baseline', () => {
  const result = compareStructuralBaseline('__nonexistent', {});
  assert.strictEqual(result.baselineFound, false);
  assert(result.error.includes('No structural baseline'));
});

// --- 12. Intentional Drift Scenarios ---

console.log('\n  --- Intentional Drift Scenarios ---');

test('removing a section from countryAnalysis causes strict drift', () => {
  const testName = '__test-golden-drift-section';
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    saveStructuralBaseline(testName, snapshot);

    // Remove competitors section
    const modified = { ...GOLD_COUNTRY_ANALYSIS };
    delete modified.competitors;
    const driftedSnapshot = captureStructuralBaseline(modified, GOLD_TEMPLATE_PATTERNS);

    const result = compareStructuralBaseline(testName, driftedSnapshot);
    assert.strictEqual(result.hasStrictViolations, true);
    assert.strictEqual(result.verdict, 'FAIL');
    assert(
      result.drift.strictViolations.some(
        (v) => v.category === 'section-missing' && v.section === 'competitors'
      ),
      'Should identify competitors as missing section'
    );
  } finally {
    deleteStructuralBaseline(testName);
  }
});

test('changing font family causes strict drift', () => {
  const testName = '__test-golden-drift-font';
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    saveStructuralBaseline(testName, snapshot);

    const drifted = JSON.parse(JSON.stringify(snapshot));
    drifted.fontSpecifications.majorLatin = 'Century Gothic';

    const result = compareStructuralBaseline(testName, drifted);
    assert.strictEqual(result.hasStrictViolations, true);
    assert(
      result.drift.strictViolations.some(
        (v) => v.category === 'font-changed' && v.field === 'majorLatin'
      ),
      'Should identify font family change'
    );
  } finally {
    deleteStructuralBaseline(testName);
  }
});

test('changing slide dimensions causes strict drift', () => {
  const testName = '__test-golden-drift-dims';
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    saveStructuralBaseline(testName, snapshot);

    const drifted = JSON.parse(JSON.stringify(snapshot));
    drifted.slideDimensions.widthInches = 10.0;
    drifted.slideDimensions.widthEmu = 9144000;

    const result = compareStructuralBaseline(testName, drifted);
    assert.strictEqual(result.hasStrictViolations, true);
    assert(
      result.drift.strictViolations.some((v) => v.field === 'widthInches'),
      'Should identify width change'
    );
  } finally {
    deleteStructuralBaseline(testName);
  }
});

test('changing country in analysis causes strict drift', () => {
  const testName = '__test-golden-drift-country';
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    saveStructuralBaseline(testName, snapshot);

    const modified = JSON.parse(JSON.stringify(GOLD_COUNTRY_ANALYSIS));
    modified.country = 'Wrong Country';
    const driftedSnapshot = captureStructuralBaseline(modified, GOLD_TEMPLATE_PATTERNS);

    const result = compareStructuralBaseline(testName, driftedSnapshot);
    assert.strictEqual(result.hasStrictViolations, true);
    assert(
      result.drift.strictViolations.some((v) => v.category === 'country-mismatch'),
      'Should detect country mismatch'
    );
  } finally {
    deleteStructuralBaseline(testName);
  }
});

test('minor geometry shift within tolerance causes WARN not FAIL', () => {
  const testName = '__test-golden-drift-minor';
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    saveStructuralBaseline(testName, snapshot);

    const drifted = JSON.parse(JSON.stringify(snapshot));
    // Shift one position by 0.02 inches (within 0.05 tolerance)
    if (drifted.geometryInvariants.title) {
      drifted.geometryInvariants.title.x += 0.02;
    }

    const result = compareStructuralBaseline(testName, drifted);
    assert.strictEqual(result.hasStrictViolations, false, 'Minor shift should not be strict');
    assert.strictEqual(result.hasToleratedDrift, true, 'Minor shift should be tolerated');
    assert.strictEqual(result.verdict, 'WARN');
  } finally {
    deleteStructuralBaseline(testName);
  }
});

// --- 13. Combined Gate + Structural Drift ---

console.log('\n  --- Combined Drift Check ---');

test('runFullDriftCheck returns PASS when both match', () => {
  const testName = '__test-golden-drift-full';
  const gateResults = { pass: true, score: 85, failures: [] };
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    createBaseline(testName, gateResults);
    saveStructuralBaseline(testName, snapshot);

    const result = runFullDriftCheck(
      testName,
      gateResults,
      GOLD_COUNTRY_ANALYSIS,
      GOLD_TEMPLATE_PATTERNS
    );
    assert.strictEqual(result.overallVerdict, 'PASS');
    assert.strictEqual(result.gate.hasDrift, false);
    assert.strictEqual(result.structural.verdict, 'PASS');
  } finally {
    deleteBaseline(testName);
    deleteStructuralBaseline(testName);
  }
});

test('runFullDriftCheck returns FAIL when structural has strict violations', () => {
  const testName = '__test-golden-drift-full-fail';
  const gateResults = { pass: true, score: 85, failures: [] };
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    createBaseline(testName, gateResults);
    saveStructuralBaseline(testName, snapshot);

    // Remove a section
    const modified = { ...GOLD_COUNTRY_ANALYSIS };
    delete modified.depth;

    const result = runFullDriftCheck(testName, gateResults, modified, GOLD_TEMPLATE_PATTERNS);
    assert.strictEqual(result.overallVerdict, 'FAIL');
    assert(result.verdictReasons.includes('structural-strict'));
  } finally {
    deleteBaseline(testName);
    deleteStructuralBaseline(testName);
  }
});

test('runFullDriftCheck returns FAIL when gate has new failures', () => {
  const testName = '__test-golden-drift-full-gate-fail';
  const baselineGates = { pass: true, score: 85, failures: [] };
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    createBaseline(testName, baselineGates);
    saveStructuralBaseline(testName, snapshot);

    const currentGates = { pass: false, score: 40, failures: ['New critical failure'] };
    const result = runFullDriftCheck(
      testName,
      currentGates,
      GOLD_COUNTRY_ANALYSIS,
      GOLD_TEMPLATE_PATTERNS
    );
    assert.strictEqual(result.overallVerdict, 'FAIL');
    assert(result.verdictReasons.includes('gate-drift'));
  } finally {
    deleteBaseline(testName);
    deleteStructuralBaseline(testName);
  }
});

test('runFullDriftCheck returns WARN for tolerated-only drift', () => {
  const testName = '__test-golden-drift-full-warn';
  const gateResults = { pass: true, score: 85, failures: [] };
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    createBaseline(testName, gateResults);
    saveStructuralBaseline(testName, snapshot);

    // Add a new section heading (tolerated)
    const modified = JSON.parse(JSON.stringify(GOLD_COUNTRY_ANALYSIS));
    modified.insights = { whyNow: { slideTitle: 'Why Now', overview: 'ok' } };

    const result = runFullDriftCheck(testName, gateResults, modified, GOLD_TEMPLATE_PATTERNS);
    assert.strictEqual(result.overallVerdict, 'WARN');
    assert(result.verdictReasons.includes('structural-tolerated'));
  } finally {
    deleteBaseline(testName);
    deleteStructuralBaseline(testName);
  }
});

// --- 14. Edge Cases ---

console.log('\n  --- Edge Cases ---');

test('detectStructuralDrift handles null baseline', () => {
  const drift = detectStructuralDrift(null, {}, DRIFT_THRESHOLDS);
  assert.strictEqual(drift.totalDriftItems, 1);
  assert(drift.strictViolations.some((v) => v.category === 'missing-data'));
});

test('detectStructuralDrift handles null current', () => {
  const drift = detectStructuralDrift({}, null, DRIFT_THRESHOLDS);
  assert.strictEqual(drift.totalDriftItems, 1);
  assert(drift.strictViolations.some((v) => v.category === 'missing-data'));
});

test('flattenObject handles nested objects', () => {
  const flat = flattenObject({ a: { b: { c: 1 } }, d: 'hello' });
  assert.strictEqual(flat['a.b.c'], 1);
  assert.strictEqual(flat.d, 'hello');
});

test('flattenObject handles arrays as JSON strings', () => {
  const flat = flattenObject({ colors: ['red', 'blue'] });
  assert.strictEqual(flat.colors, '["red","blue"]');
});

test('flattenObject handles null input', () => {
  const flat = flattenObject(null);
  assert.deepStrictEqual(flat, {});
});

test('DRIFT_THRESHOLDS has expected structure', () => {
  assert(DRIFT_THRESHOLDS.geometry, 'Should have geometry thresholds');
  assert.strictEqual(DRIFT_THRESHOLDS.geometry.strict, 0);
  assert.strictEqual(DRIFT_THRESHOLDS.geometry.tolerated, 0.05);
  assert(DRIFT_THRESHOLDS.slideDimensions, 'Should have slideDimensions thresholds');
  assert(DRIFT_THRESHOLDS.fontSize, 'Should have fontSize thresholds');
  assert(DRIFT_THRESHOLDS.color, 'Should have color thresholds');
  assert(DRIFT_THRESHOLDS.text, 'Should have text thresholds');
});

test('captureStructuralBaseline with empty analysis', () => {
  const snapshot = captureStructuralBaseline({}, GOLD_TEMPLATE_PATTERNS);
  assert(snapshot.sectionStructure, 'Should still have section structure');
  // All sections should be not present
  for (const section of Object.values(snapshot.sectionStructure)) {
    assert.strictEqual(section.present, false, 'Sections should be marked not present');
  }
});

test('captureStructuralBaseline with empty template patterns', () => {
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, {});
  assert(snapshot.slideDimensions, 'Should still have slide dimensions with defaults');
  assert.deepStrictEqual(snapshot.fontSpecifications, {});
  assert.deepStrictEqual(snapshot.colorSpecifications, {});
  assert.deepStrictEqual(snapshot.templateStructure, {});
});

// --- 15. Drift Threshold Override ---

console.log('\n  --- Drift Threshold Override ---');

test('custom thresholds can widen geometry tolerance', () => {
  const testName = '__test-golden-drift-custom-thresh';
  const snapshot = captureStructuralBaseline(GOLD_COUNTRY_ANALYSIS, GOLD_TEMPLATE_PATTERNS);

  try {
    saveStructuralBaseline(testName, snapshot);

    const drifted = JSON.parse(JSON.stringify(snapshot));
    if (drifted.geometryInvariants.title) {
      drifted.geometryInvariants.title.x += 0.08; // would be strict at default 0.05
    }

    // Default threshold: strict violation
    const resultDefault = compareStructuralBaseline(testName, drifted);
    assert.strictEqual(resultDefault.hasStrictViolations, true, 'Default should be strict');

    // Custom wider threshold: tolerated
    const wideThresholds = {
      ...DRIFT_THRESHOLDS,
      geometry: { strict: 0, tolerated: 0.1 },
    };
    const resultWide = compareStructuralBaseline(testName, drifted, wideThresholds);
    assert.strictEqual(
      resultWide.hasStrictViolations,
      false,
      'Wide tolerance should not be strict'
    );
    assert.strictEqual(resultWide.hasToleratedDrift, true, 'Wide tolerance should be tolerated');
  } finally {
    deleteStructuralBaseline(testName);
  }
});

// ============ SUMMARY ============

console.log(`\n[Golden Baseline Drift Tests] ${passed} passed, ${failed} failed`);

const inJest = Boolean(process.env.JEST_WORKER_ID);

if (inJest) {
  global.describe('golden baseline drift harness', () => {
    global.test('all harness checks pass', () => {
      if (failed > 0) {
        const details = failures.map((f) => `- ${f.name}: ${f.error}`).join('\n');
        throw new Error(`${failed} harness check(s) failed:\n${details}`);
      }
      global.expect(passed).toBeGreaterThan(0);
    });
  });
} else if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
