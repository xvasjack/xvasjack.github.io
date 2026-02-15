'use strict';

/**
 * Tests for header-footer-drift-diagnostics.js
 *
 * Validates that drift diagnostics always include:
 * - Exact blocking slide keys
 * - Expected vs actual geometry
 * - Delta values
 * - Severity classification
 */

const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const {
  scanDrift,
  writeReport,
  analyzeSlide,
  classifySeverity,
  classifyLine,
  extractHorizontalLines,
  EXPECTED,
  DRIFT_THRESHOLD_INFO,
  DRIFT_THRESHOLD_WARNING,
  __test: { getExpectedThickness, getExpectedColor },
} = require('./header-footer-drift-diagnostics');

// ---------------------------------------------------------------------------
// Helpers: Build synthetic PPTX with controllable line positions
// ---------------------------------------------------------------------------

function makeSlideXml(lines = []) {
  // lines: array of { y, cx, thickness, color }
  // Each becomes a <p:cxnSp> horizontal line at x=0
  const shapes = lines
    .map(
      (l) => `
    <p:cxnSp>
      <p:spPr>
        <a:xfrm>
          <a:off x="0" y="${l.y}"/>
          <a:ext cx="${l.cx || EXPECTED.slideWidthEmu}" cy="0"/>
        </a:xfrm>
        <a:ln w="${l.thickness || 28575}">
          <a:solidFill>
            <a:srgbClr val="${l.color || '293F55'}"/>
          </a:solidFill>
        </a:ln>
      </p:spPr>
    </p:cxnSp>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
      ${shapes}
    </p:spTree>
  </p:cSld>
</p:sld>`;
}

function makeLayoutXml(lines = []) {
  const shapes = lines
    .map(
      (l) => `
    <p:sp>
      <p:spPr>
        <a:xfrm>
          <a:off x="0" y="${l.y}"/>
          <a:ext cx="${l.cx || EXPECTED.slideWidthEmu}" cy="0"/>
        </a:xfrm>
        <a:ln w="${l.thickness || 28575}">
          <a:solidFill>
            <a:srgbClr val="${l.color || '293F55'}"/>
          </a:solidFill>
        </a:ln>
      </p:spPr>
    </p:sp>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
      ${shapes}
    </p:spTree>
  </p:cSld>
</p:sldLayout>`;
}

async function buildTestPptx(slideConfigs = [], layoutLines = null) {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slideConfigs.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n  ')}
</Types>`
  );

  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldSz cx="${EXPECTED.slideWidthEmu}" cy="6858000"/>
  <p:sldIdLst>
    ${slideConfigs.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('\n    ')}
  </p:sldIdLst>
</p:presentation>`
  );

  for (let i = 0; i < slideConfigs.length; i++) {
    zip.file(`ppt/slides/slide${i + 1}.xml`, makeSlideXml(slideConfigs[i].lines || []));
  }

  if (layoutLines) {
    zip.file('ppt/slideLayouts/slideLayout3.xml', makeLayoutXml(layoutLines));
  }

  return zip.generateAsync({ type: 'nodebuffer' });
}

// Exact template positions for reference
const TEMPLATE_HEADER_TOP_Y = EXPECTED.headerTopY;
const TEMPLATE_HEADER_BOTTOM_Y = EXPECTED.headerBottomY;
const TEMPLATE_FOOTER_Y = EXPECTED.footerY;

// ---------------------------------------------------------------------------
// Tests: classifySeverity
// ---------------------------------------------------------------------------

describe('classifySeverity', () => {
  test('returns info for delta <= 500 EMU', () => {
    expect(classifySeverity(0)).toBe('info');
    expect(classifySeverity(100)).toBe('info');
    expect(classifySeverity(500)).toBe('info');
  });

  test('returns warning for delta 501..2500 EMU', () => {
    expect(classifySeverity(501)).toBe('warning');
    expect(classifySeverity(1500)).toBe('warning');
    expect(classifySeverity(2500)).toBe('warning');
  });

  test('returns error for delta > 2500 EMU', () => {
    expect(classifySeverity(2501)).toBe('error');
    expect(classifySeverity(10000)).toBe('error');
    expect(classifySeverity(914400)).toBe('error');
  });

  test('handles negative deltas by absolute value', () => {
    expect(classifySeverity(-100)).toBe('info');
    expect(classifySeverity(-2000)).toBe('warning');
    expect(classifySeverity(-5000)).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Tests: classifyLine
// ---------------------------------------------------------------------------

describe('classifyLine', () => {
  test('identifies header_top line', () => {
    const result = classifyLine({ y: TEMPLATE_HEADER_TOP_Y });
    expect(result.role).toBe('header_top');
    expect(result.delta).toBe(0);
    expect(result.expectedY).toBe(TEMPLATE_HEADER_TOP_Y);
  });

  test('identifies header_bottom line', () => {
    const result = classifyLine({ y: TEMPLATE_HEADER_BOTTOM_Y });
    expect(result.role).toBe('header_bottom');
    expect(result.delta).toBe(0);
  });

  test('identifies footer line', () => {
    const result = classifyLine({ y: TEMPLATE_FOOTER_Y });
    expect(result.role).toBe('footer');
    expect(result.delta).toBe(0);
  });

  test('classifies a drifted header_top line', () => {
    const driftedY = TEMPLATE_HEADER_TOP_Y + 5000;
    const result = classifyLine({ y: driftedY });
    expect(result.role).toBe('header_top');
    expect(result.delta).toBe(5000);
  });

  test('classifies very distant line as unknown', () => {
    // Position very far from any expected line
    const result = classifyLine({ y: 3000000 });
    expect(result.role).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Tests: extractHorizontalLines
// ---------------------------------------------------------------------------

describe('extractHorizontalLines', () => {
  test('extracts connection shapes with correct attributes', () => {
    const xml = makeSlideXml([{ y: TEMPLATE_HEADER_TOP_Y, thickness: 57150, color: '293F55' }]);
    const lines = extractHorizontalLines(xml);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const line = lines[0];
    expect(line.y).toBe(TEMPLATE_HEADER_TOP_Y);
    expect(line.thickness).toBe(57150);
    expect(line.color).toBe('293F55');
  });

  test('ignores non-horizontal shapes (cy > 10000)', () => {
    const xml = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree><p:grpSpPr/>
        <p:cxnSp>
          <p:spPr>
            <a:xfrm>
              <a:off x="0" y="${TEMPLATE_HEADER_TOP_Y}"/>
              <a:ext cx="${EXPECTED.slideWidthEmu}" cy="500000"/>
            </a:xfrm>
            <a:ln w="57150"><a:solidFill><a:srgbClr val="293F55"/></a:solidFill></a:ln>
          </p:spPr>
        </p:cxnSp>
      </p:spTree></p:cSld></p:sld>`;
    const lines = extractHorizontalLines(xml);
    expect(lines.length).toBe(0);
  });

  test('ignores narrow shapes (cx < 50% slide width)', () => {
    const xml = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <p:cSld><p:spTree><p:grpSpPr/>
        <p:cxnSp>
          <p:spPr>
            <a:xfrm>
              <a:off x="0" y="${TEMPLATE_HEADER_TOP_Y}"/>
              <a:ext cx="1000000" cy="0"/>
            </a:xfrm>
            <a:ln w="57150"><a:solidFill><a:srgbClr val="293F55"/></a:solidFill></a:ln>
          </p:spPr>
        </p:cxnSp>
      </p:spTree></p:cSld></p:sld>`;
    const lines = extractHorizontalLines(xml);
    expect(lines.length).toBe(0);
  });

  test('returns empty for null/undefined input', () => {
    expect(extractHorizontalLines(null)).toEqual([]);
    expect(extractHorizontalLines(undefined)).toEqual([]);
    expect(extractHorizontalLines('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: analyzeSlide
// ---------------------------------------------------------------------------

describe('analyzeSlide', () => {
  test('returns correct structure with all required fields', () => {
    const xml = makeSlideXml([
      { y: TEMPLATE_HEADER_TOP_Y },
      { y: TEMPLATE_HEADER_BOTTOM_Y },
      { y: TEMPLATE_FOOTER_Y },
    ]);
    const result = analyzeSlide(xml, 'slide5.xml', 5, 'marketSizeAndGrowth');

    expect(result.slideNumber).toBe(5);
    expect(result.slideName).toBe('slide5.xml');
    expect(result.slideKey).toBe('marketSizeAndGrowth');
    expect(result.hasBlockingDrift).toBe(false);
    expect(result.hasWarningDrift).toBe(false);
    expect(Array.isArray(result.driftEntries)).toBe(true);
    expect(Array.isArray(result.missingRoles)).toBe(true);
  });

  test('detects blocking drift and includes exact geometry', () => {
    const driftedY = TEMPLATE_HEADER_TOP_Y + 5000; // >2500 = error
    const xml = makeSlideXml([
      { y: driftedY },
      { y: TEMPLATE_HEADER_BOTTOM_Y },
      { y: TEMPLATE_FOOTER_Y },
    ]);
    const result = analyzeSlide(xml, 'slide3.xml', 3, 'regulatorySummary');

    expect(result.hasBlockingDrift).toBe(true);

    const blockingEntry = result.driftEntries.find((e) => e.severity === 'error');
    expect(blockingEntry).toBeDefined();
    expect(blockingEntry.slideKey).toBe('regulatorySummary');
    expect(blockingEntry.slideNumber).toBe(3);
    expect(blockingEntry.role).toBe('header_top');
    expect(blockingEntry.expected.y).toBe(TEMPLATE_HEADER_TOP_Y);
    expect(blockingEntry.actual.y).toBe(driftedY);
    expect(blockingEntry.delta.yEmu).toBe(5000);
    expect(blockingEntry.severity).toBe('error');
  });

  test('detects warning-level drift', () => {
    const driftedY = TEMPLATE_FOOTER_Y + 1500; // 500..2500 = warning
    const xml = makeSlideXml([
      { y: TEMPLATE_HEADER_TOP_Y },
      { y: TEMPLATE_HEADER_BOTTOM_Y },
      { y: driftedY },
    ]);
    const result = analyzeSlide(xml, 'slide7.xml', 7, 'pricingAndEconomics');

    expect(result.hasBlockingDrift).toBe(false);
    expect(result.hasWarningDrift).toBe(true);

    const warningEntry = result.driftEntries.find((e) => e.severity === 'warning');
    expect(warningEntry).toBeDefined();
    expect(warningEntry.role).toBe('footer');
    expect(warningEntry.delta.yEmu).toBe(1500);
  });

  test('reports missing roles when lines are absent', () => {
    // Only header_top present, missing header_bottom and footer
    const xml = makeSlideXml([{ y: TEMPLATE_HEADER_TOP_Y }]);
    const result = analyzeSlide(xml, 'slide1.xml', 1, 'coverSlide');

    expect(result.missingRoles).toContain('header_bottom');
    expect(result.missingRoles).toContain('footer');
    expect(result.missingRoles).not.toContain('header_top');
  });

  test('includes thickness and color diagnostics', () => {
    const xml = makeSlideXml([{ y: TEMPLATE_HEADER_TOP_Y, thickness: 57150, color: '293F55' }]);
    const result = analyzeSlide(xml, 'slide2.xml', 2, 'executiveSummary');

    const entry = result.driftEntries.find((e) => e.role === 'header_top');
    expect(entry).toBeDefined();
    expect(entry.actual.thickness).toBe(57150);
    expect(entry.actual.color).toBe('293F55');
    expect(entry.expected.thickness).toBe(EXPECTED.headerTopThicknessEmu);
    expect(entry.expected.color).toBe(EXPECTED.headerTopColor);
    expect(entry.colorMatch).toBe(true);
  });

  test('handles null slide key gracefully', () => {
    const xml = makeSlideXml([{ y: TEMPLATE_HEADER_TOP_Y }]);
    const result = analyzeSlide(xml, 'slide1.xml', 1, null);
    expect(result.slideKey).toBeNull();
    const entry = result.driftEntries[0];
    expect(entry.slideKey).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: scanDrift (full PPTX scan)
// ---------------------------------------------------------------------------

describe('scanDrift', () => {
  test('produces a complete report structure', async () => {
    const pptx = await buildTestPptx([
      {
        lines: [
          { y: TEMPLATE_HEADER_TOP_Y },
          { y: TEMPLATE_HEADER_BOTTOM_Y },
          { y: TEMPLATE_FOOTER_Y },
        ],
      },
    ]);

    const report = await scanDrift(pptx);

    expect(report._meta).toBeDefined();
    expect(report._meta.generatedAt).toBeTruthy();
    expect(report._meta.expectedGeometry).toBeDefined();
    expect(report._meta.thresholds).toBeDefined();
    expect(report.summary).toBeDefined();
    expect(report.summary.totalSlides).toBe(1);
    expect(report.summary.pass).toBe(true);
    expect(Array.isArray(report.blockingSlideKeys)).toBe(true);
    expect(Array.isArray(report.blockingSlideNumbers)).toBe(true);
    expect(Array.isArray(report.slides)).toBe(true);
  });

  test('identifies blocking slides with explicit keys', async () => {
    const driftedY = TEMPLATE_HEADER_TOP_Y + 5000;
    const pptx = await buildTestPptx([
      {
        lines: [
          { y: TEMPLATE_HEADER_TOP_Y },
          { y: TEMPLATE_HEADER_BOTTOM_Y },
          { y: TEMPLATE_FOOTER_Y },
        ],
      },
      {
        lines: [
          { y: driftedY }, // drift on slide 2
          { y: TEMPLATE_HEADER_BOTTOM_Y },
          { y: TEMPLATE_FOOTER_Y },
        ],
      },
    ]);

    const slideMapping = [
      { generatedSlideNumber: 1, templateSlideNumber: 5, blockKey: 'executiveSummary' },
      { generatedSlideNumber: 2, templateSlideNumber: 7, blockKey: 'regulatorySummary' },
    ];

    const report = await scanDrift(pptx, { slideMapping });

    expect(report.summary.pass).toBe(false);
    expect(report.summary.slidesWithBlockingDrift).toBe(1);
    expect(report.summary.errorCount).toBeGreaterThan(0);
    expect(report.blockingSlideKeys).toContain('regulatorySummary');
    expect(report.blockingSlideNumbers).toContain(2);
    // Slide 1 should NOT be blocking
    expect(report.blockingSlideKeys).not.toContain('executiveSummary');
  });

  test('blocking slide keys are always explicit (never empty when drift exists)', async () => {
    // This is the key contract: if there is blocking drift, we must know WHICH slides
    const driftedY = TEMPLATE_FOOTER_Y + 10000; // massive drift
    const pptx = await buildTestPptx([
      {
        lines: [{ y: TEMPLATE_HEADER_TOP_Y }, { y: TEMPLATE_HEADER_BOTTOM_Y }, { y: driftedY }],
      },
      {
        lines: [{ y: TEMPLATE_HEADER_TOP_Y }, { y: TEMPLATE_HEADER_BOTTOM_Y }, { y: driftedY }],
      },
    ]);

    const slideMapping = [
      { generatedSlideNumber: 1, templateSlideNumber: 5, blockKey: 'marketOverview' },
      { generatedSlideNumber: 2, templateSlideNumber: 8, blockKey: 'competitorAnalysis' },
    ];

    const report = await scanDrift(pptx, { slideMapping });

    expect(report.summary.pass).toBe(false);
    // MUST have explicit blocking keys for every drifted slide
    expect(report.blockingSlideKeys.length).toBe(2);
    expect(report.blockingSlideKeys).toContain('marketOverview');
    expect(report.blockingSlideKeys).toContain('competitorAnalysis');
    expect(report.blockingSlideNumbers).toContain(1);
    expect(report.blockingSlideNumbers).toContain(2);
  });

  test('uses slide number as fallback key when blockKey is null', async () => {
    const driftedY = TEMPLATE_HEADER_TOP_Y + 5000;
    const pptx = await buildTestPptx([
      {
        lines: [{ y: driftedY }, { y: TEMPLATE_HEADER_BOTTOM_Y }, { y: TEMPLATE_FOOTER_Y }],
      },
    ]);

    // No slideMapping provided
    const report = await scanDrift(pptx);

    expect(report.summary.pass).toBe(false);
    expect(report.blockingSlideKeys.length).toBe(1);
    // Falls back to "slideN" format
    expect(report.blockingSlideKeys[0]).toBe('slide1');
  });

  test('report includes expected vs actual geometry for all drift entries', async () => {
    const driftedY = TEMPLATE_HEADER_TOP_Y + 3000;
    const pptx = await buildTestPptx([
      {
        lines: [
          { y: driftedY, thickness: 57150, color: '293F55' },
          { y: TEMPLATE_HEADER_BOTTOM_Y },
          { y: TEMPLATE_FOOTER_Y },
        ],
      },
    ]);

    const report = await scanDrift(pptx, {
      slideMapping: [{ generatedSlideNumber: 1, templateSlideNumber: 5, blockKey: 'testBlock' }],
    });

    const slideAnalysis = report.slides[0];
    const driftEntry = slideAnalysis.driftEntries.find((e) => e.role === 'header_top');

    expect(driftEntry).toBeDefined();
    expect(driftEntry.expected.y).toBe(TEMPLATE_HEADER_TOP_Y);
    expect(driftEntry.expected.yInches).toBeDefined();
    expect(driftEntry.actual.y).toBe(driftedY);
    expect(driftEntry.actual.yInches).toBeDefined();
    expect(driftEntry.delta.yEmu).toBe(3000);
    expect(driftEntry.delta.yInches).toBeDefined();
    expect(driftEntry.severity).toBe('error');
    expect(driftEntry.slideKey).toBe('testBlock');
    expect(driftEntry.slideNumber).toBe(1);
  });

  test('passes when all lines are at exact template positions', async () => {
    const pptx = await buildTestPptx([
      {
        lines: [
          { y: TEMPLATE_HEADER_TOP_Y },
          { y: TEMPLATE_HEADER_BOTTOM_Y },
          { y: TEMPLATE_FOOTER_Y },
        ],
      },
      {
        lines: [
          { y: TEMPLATE_HEADER_TOP_Y },
          { y: TEMPLATE_HEADER_BOTTOM_Y },
          { y: TEMPLATE_FOOTER_Y },
        ],
      },
    ]);

    const report = await scanDrift(pptx);
    expect(report.summary.pass).toBe(true);
    expect(report.summary.errorCount).toBe(0);
    expect(report.blockingSlideKeys.length).toBe(0);
  });

  test('handles empty PPTX with no slides', async () => {
    const pptx = await buildTestPptx([]);
    const report = await scanDrift(pptx);
    expect(report.summary.totalSlides).toBe(0);
    expect(report.summary.pass).toBe(true);
  });

  test('layout analysis is included when slideLayout3 exists', async () => {
    const layoutLines = [
      { y: TEMPLATE_HEADER_TOP_Y, thickness: 57150, color: '293F55' },
      { y: TEMPLATE_HEADER_BOTTOM_Y, thickness: 28575, color: '293F55' },
      { y: TEMPLATE_FOOTER_Y, thickness: 28575, color: '293F55' },
    ];

    const pptx = await buildTestPptx([{ lines: [{ y: TEMPLATE_HEADER_TOP_Y }] }], layoutLines);

    const report = await scanDrift(pptx);
    expect(report.layoutAnalysis).toBeDefined();
    expect(report.layoutAnalysis.slideKey).toBe('_layout');
    expect(report.layoutAnalysis.driftEntries.length).toBeGreaterThan(0);
  });

  test('summary maxDelta tracks the worst offender', async () => {
    const smallDrift = TEMPLATE_HEADER_TOP_Y + 1000;
    const bigDrift = TEMPLATE_FOOTER_Y + 8000;

    const pptx = await buildTestPptx([
      {
        lines: [{ y: smallDrift }, { y: TEMPLATE_HEADER_BOTTOM_Y }, { y: TEMPLATE_FOOTER_Y }],
      },
      {
        lines: [{ y: TEMPLATE_HEADER_TOP_Y }, { y: TEMPLATE_HEADER_BOTTOM_Y }, { y: bigDrift }],
      },
    ]);

    const report = await scanDrift(pptx, {
      slideMapping: [
        { generatedSlideNumber: 1, templateSlideNumber: 5, blockKey: 'slideA' },
        { generatedSlideNumber: 2, templateSlideNumber: 7, blockKey: 'slideB' },
      ],
    });

    expect(report.summary.maxDelta).toBeDefined();
    expect(report.summary.maxDelta.yEmu).toBe(8000);
    expect(report.summary.maxDelta.role).toBe('footer');
    expect(report.summary.maxDelta.slideNumber).toBe(2);
    expect(report.summary.maxDelta.slideKey).toBe('slideB');
  });
});

// ---------------------------------------------------------------------------
// Tests: writeReport
// ---------------------------------------------------------------------------

describe('writeReport', () => {
  const testReportDir = path.join(__dirname, '__test_reports_hf_drift__');

  afterAll(() => {
    // Clean up test report directory
    try {
      const reportFile = path.join(
        testReportDir,
        'reports',
        'formatting',
        'header-footer-drift.json'
      );
      if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
      const fmtDir = path.join(testReportDir, 'reports', 'formatting');
      if (fs.existsSync(fmtDir)) fs.rmdirSync(fmtDir);
      const repDir = path.join(testReportDir, 'reports');
      if (fs.existsSync(repDir)) fs.rmdirSync(repDir);
      if (fs.existsSync(testReportDir)) fs.rmdirSync(testReportDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  test('writes report to correct path', () => {
    const sampleReport = {
      _meta: { generatedAt: new Date().toISOString() },
      summary: { pass: true },
      blockingSlideKeys: [],
    };

    const reportPath = writeReport(sampleReport, testReportDir);
    expect(reportPath).toContain('header-footer-drift.json');
    expect(fs.existsSync(reportPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(written.summary.pass).toBe(true);
    expect(written._meta.generatedAt).toBeDefined();
  });

  test('creates formatting directory if it does not exist', () => {
    const freshDir = path.join(__dirname, '__test_reports_hf_drift_fresh__');
    try {
      const reportPath = writeReport({ summary: { pass: false } }, freshDir);
      expect(fs.existsSync(reportPath)).toBe(true);
    } finally {
      // Cleanup
      try {
        const reportFile = path.join(freshDir, 'reports', 'formatting', 'header-footer-drift.json');
        if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
        const fmtDir = path.join(freshDir, 'reports', 'formatting');
        if (fs.existsSync(fmtDir)) fs.rmdirSync(fmtDir);
        const repDir = path.join(freshDir, 'reports');
        if (fs.existsSync(repDir)) fs.rmdirSync(repDir);
        if (fs.existsSync(freshDir)) fs.rmdirSync(freshDir);
      } catch {
        // Ignore cleanup
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: EXPECTED constants integrity
// ---------------------------------------------------------------------------

describe('EXPECTED template constants', () => {
  test('header top Y matches template-patterns.json', () => {
    expect(EXPECTED.headerTopY).toBe(Math.round(1.0208 * 914400));
  });

  test('header bottom Y matches template-patterns.json', () => {
    expect(EXPECTED.headerBottomY).toBe(Math.round(1.0972 * 914400));
  });

  test('footer Y matches template-patterns.json', () => {
    expect(EXPECTED.footerY).toBe(Math.round(7.2361 * 914400));
  });

  test('slide width matches template-patterns.json', () => {
    expect(EXPECTED.slideWidthEmu).toBe(12192000);
  });

  test('expected thicknesses are positive', () => {
    expect(EXPECTED.headerTopThicknessEmu).toBeGreaterThan(0);
    expect(EXPECTED.headerBottomThicknessEmu).toBeGreaterThan(0);
    expect(EXPECTED.footerThicknessEmu).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: diagnostics always include blocking slide keys (contract test)
// ---------------------------------------------------------------------------

describe('blocking slide key contract', () => {
  test('every slide with error-severity drift appears in blockingSlideKeys', async () => {
    const pptx = await buildTestPptx([
      { lines: [{ y: TEMPLATE_HEADER_TOP_Y + 10000 }] },
      { lines: [{ y: TEMPLATE_HEADER_TOP_Y }] },
      { lines: [{ y: TEMPLATE_FOOTER_Y + 10000 }] },
    ]);

    const slideMapping = [
      { generatedSlideNumber: 1, blockKey: 'blockA' },
      { generatedSlideNumber: 2, blockKey: 'blockB' },
      { generatedSlideNumber: 3, blockKey: 'blockC' },
    ];

    const report = await scanDrift(pptx, { slideMapping });

    // blockA and blockC have error drift, blockB does not
    expect(report.blockingSlideKeys).toContain('blockA');
    expect(report.blockingSlideKeys).not.toContain('blockB');
    expect(report.blockingSlideKeys).toContain('blockC');
  });

  test('drift entries always include slideKey, slideNumber, expected, actual, delta, severity', async () => {
    const pptx = await buildTestPptx([
      {
        lines: [{ y: TEMPLATE_HEADER_TOP_Y + 3000, thickness: 57150, color: '293F55' }],
      },
    ]);

    const report = await scanDrift(pptx, {
      slideMapping: [{ generatedSlideNumber: 1, blockKey: 'testKey' }],
    });

    for (const slide of report.slides) {
      for (const entry of slide.driftEntries) {
        expect(entry).toHaveProperty('slideKey');
        expect(entry).toHaveProperty('slideNumber');
        expect(entry).toHaveProperty('expected');
        expect(entry).toHaveProperty('actual');
        expect(entry).toHaveProperty('delta');
        expect(entry).toHaveProperty('severity');
        expect(entry.expected).toHaveProperty('y');
        expect(entry.actual).toHaveProperty('y');
        expect(entry.delta).toHaveProperty('yEmu');
        expect(['info', 'warning', 'error']).toContain(entry.severity);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: __test helpers
// ---------------------------------------------------------------------------

describe('internal helpers', () => {
  test('getExpectedThickness returns correct values for each role', () => {
    expect(getExpectedThickness('header_top')).toBe(EXPECTED.headerTopThicknessEmu);
    expect(getExpectedThickness('header_bottom')).toBe(EXPECTED.headerBottomThicknessEmu);
    expect(getExpectedThickness('footer')).toBe(EXPECTED.footerThicknessEmu);
    expect(getExpectedThickness('unknown')).toBeNull();
  });

  test('getExpectedColor returns correct values for each role', () => {
    expect(getExpectedColor('header_top')).toBe(EXPECTED.headerTopColor);
    expect(getExpectedColor('header_bottom')).toBe(EXPECTED.headerBottomColor);
    expect(getExpectedColor('footer')).toBe(EXPECTED.footerColor);
    expect(getExpectedColor('unknown')).toBeNull();
  });
});
