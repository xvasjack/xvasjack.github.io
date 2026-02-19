'use strict';

/**
 * Header/Footer Drift RunInfo
 *
 * Precise per-slide runInfo for header and footer line geometry drift.
 * Scans every slide in a generated PPTX for line shapes whose Y-position
 * corresponds to header-top, header-bottom, or footer lines, then computes
 * delta from the Escort template ground truth.
 *
 * Does NOT modify the PPTX — runInfo only.
 *
 * Output: structured report with per-slide blocking keys, expected vs actual
 * geometry, delta values, and severity classification.
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const templatePatterns = require('./template-patterns.json');

function resolveTemplateColor(rawColor, fallback = '293F55') {
  const raw = String(rawColor || '').trim();
  if (/^[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase();

  const schemeMatch = raw.match(/^scheme:([a-z0-9_]+)$/i);
  if (schemeMatch) {
    const schemeKey = schemeMatch[1];
    const styleColor = String(templatePatterns.style?.colors?.[schemeKey] || '').trim();
    if (/^[0-9a-f]{6}$/i.test(styleColor)) return styleColor.toUpperCase();

    const themeEntry = templatePatterns.theme?.colorScheme?.[schemeKey];
    const themeColor = String(themeEntry?.val || themeEntry?.lastClr || '').trim();
    if (/^[0-9a-f]{6}$/i.test(themeColor)) return themeColor.toUpperCase();
  }

  return String(fallback || '293F55').toUpperCase();
}

// ---------------------------------------------------------------------------
// Template ground truth (EMU)
// ---------------------------------------------------------------------------

const EXPECTED = Object.freeze({
  headerTopY: Math.round(Number(templatePatterns.style?.headerLines?.top?.y || 1.0208) * 914400),
  headerBottomY: Math.round(
    Number(templatePatterns.style?.headerLines?.bottom?.y || 1.0972) * 914400
  ),
  footerY: Math.round(Number(templatePatterns.pptxPositions?.footerLine?.y || 7.2361) * 914400),
  headerTopThicknessEmu: Math.round(
    Number(templatePatterns.style?.headerLines?.top?.thickness || 4.5) * 12700
  ),
  headerBottomThicknessEmu: Math.round(
    Number(templatePatterns.style?.headerLines?.bottom?.thickness || 2.25) * 12700
  ),
  footerThicknessEmu: Math.round(
    Number(templatePatterns.pptxPositions?.footerLine?.thickness || 2.25) * 12700
  ),
  headerTopColor: resolveTemplateColor(templatePatterns.style?.headerLines?.top?.color, '293F55'),
  headerBottomColor: resolveTemplateColor(
    templatePatterns.style?.headerLines?.bottom?.color,
    '293F55'
  ),
  footerColor: resolveTemplateColor(
    templatePatterns.pptxPositions?.footerLine?.color,
    templatePatterns.style?.headerLines?.bottom?.color || '293F55'
  ),
  slideWidthEmu: Number(templatePatterns.style?.slideWidthEmu || 12192000),
});

// ---------------------------------------------------------------------------
// Severity thresholds (EMU)
// ---------------------------------------------------------------------------

const DRIFT_THRESHOLD_INFO = 500; // < 500 EMU is negligible
const DRIFT_THRESHOLD_WARNING = 2500; // 500..2500 EMU is a warning
// > 2500 EMU is blocking (error)

function classifySeverity(deltaEmu) {
  const abs = Math.abs(deltaEmu);
  if (abs <= DRIFT_THRESHOLD_INFO) return 'info';
  if (abs <= DRIFT_THRESHOLD_WARNING) return 'warning';
  return 'error';
}

// ---------------------------------------------------------------------------
// Line extraction from slide XML
// ---------------------------------------------------------------------------

/**
 * Extract line shapes from a slide XML string.
 * Returns array of { y, w, thickness, color } for horizontal lines (h=0, x=0).
 *
 * Looks for <p:cxnSp> and <p:sp> elements that represent horizontal lines:
 * - x=0 (full-width lines)
 * - h=0 or near-zero (horizontal, not vertical)
 */
function extractHorizontalLines(slideXml) {
  const lines = [];
  if (!slideXml || typeof slideXml !== 'string') return lines;

  // Match shape blocks that contain both an offset and extent
  // We look for connection shapes and regular shapes with line properties
  const shapeBlocks = [
    ...slideXml.matchAll(/<p:cxnSp>([\s\S]*?)<\/p:cxnSp>/g),
    ...slideXml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g),
  ];

  for (const block of shapeBlocks) {
    const xml = block[1] || block[0] || '';

    // Extract offset: <a:off x="..." y="..."/>
    const offMatch = xml.match(/<a:off\s+x="(\d+)"\s+y="(\d+)"/);
    if (!offMatch) continue;

    const x = Number(offMatch[1]);
    const y = Number(offMatch[2]);

    // Extract extent: <a:ext cx="..." cy="..."/>
    const extMatch = xml.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
    if (!extMatch) continue;

    const cx = Number(extMatch[1]);
    const cy = Number(extMatch[2]);

    // Only interested in horizontal lines: x=0, cy=0, cx spans significant width
    if (x > 10000) continue; // not a full-width line (allow small tolerance)
    if (cy > 10000) continue; // not horizontal
    if (cx < EXPECTED.slideWidthEmu * 0.5) continue; // too narrow to be a header/footer line

    // Extract line width if present
    const lnMatch = xml.match(/<a:ln\s+w="(\d+)"/);
    const thickness = lnMatch ? Number(lnMatch[1]) : null;

    // Extract line color (solid fill inside ln)
    let color = null;
    const lnBlock = xml.match(/<a:ln[^>]*>([\s\S]*?)<\/a:ln>/);
    if (lnBlock) {
      const srgbMatch = lnBlock[1].match(/<a:srgbClr\s+val="([A-Fa-f0-9]{6})"/);
      if (srgbMatch) color = srgbMatch[1].toUpperCase();
    }

    lines.push({ x, y, cx, cy, thickness, color });
  }

  return lines;
}

/**
 * Classify a detected line as header-top, header-bottom, footer, or unknown.
 * Uses nearest-match against expected Y positions.
 */
function classifyLine(line) {
  const y = line.y;
  const candidates = [
    { role: 'header_top', expectedY: EXPECTED.headerTopY },
    { role: 'header_bottom', expectedY: EXPECTED.headerBottomY },
    { role: 'footer', expectedY: EXPECTED.footerY },
  ];

  let bestRole = 'unknown';
  let bestDelta = Infinity;
  let bestExpectedY = null;

  for (const c of candidates) {
    const delta = Math.abs(y - c.expectedY);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestRole = c.role;
      bestExpectedY = c.expectedY;
    }
  }

  // If the nearest match is still very far (> 2x the distance between header lines),
  // classify as unknown
  const headerGap = Math.abs(EXPECTED.headerBottomY - EXPECTED.headerTopY);
  if (bestDelta > headerGap * 5) {
    return { role: 'unknown', expectedY: null, delta: bestDelta };
  }

  return { role: bestRole, expectedY: bestExpectedY, delta: bestDelta };
}

// ---------------------------------------------------------------------------
// Per-slide drift analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a single slide for header/footer line drift.
 *
 * @param {string} slideXml - Raw XML content of the slide
 * @param {string} slideName - e.g. "slide3.xml"
 * @param {number} slideNumber - Numeric slide index
 * @param {string|null} slideKey - Block key associated with this slide, if known
 * @returns {object} Drift analysis for this slide
 */
function analyzeSlide(slideXml, slideName, slideNumber, slideKey) {
  const lines = extractHorizontalLines(slideXml);
  const driftEntries = [];
  const matchedRoles = new Set();

  for (const line of lines) {
    const classification = classifyLine(line);
    if (classification.role === 'unknown') continue;

    matchedRoles.add(classification.role);

    const severity = classifySeverity(classification.delta);
    const expectedThickness = getExpectedThickness(classification.role);
    const thicknessDelta =
      line.thickness != null && expectedThickness != null
        ? Math.abs(line.thickness - expectedThickness)
        : null;

    const expectedColor = getExpectedColor(classification.role);
    const colorMatch =
      line.color != null && expectedColor != null
        ? String(line.color).toUpperCase() === String(expectedColor).toUpperCase()
        : null;

    driftEntries.push({
      role: classification.role,
      slideKey: slideKey || null,
      slideNumber,
      slideName,
      expected: {
        y: classification.expectedY,
        yInches: Number((classification.expectedY / 914400).toFixed(4)),
        thickness: expectedThickness,
        color: expectedColor,
      },
      actual: {
        y: line.y,
        yInches: Number((line.y / 914400).toFixed(4)),
        thickness: line.thickness,
        color: line.color,
      },
      delta: {
        yEmu: classification.delta,
        yInches: Number((classification.delta / 914400).toFixed(4)),
        thicknessEmu: thicknessDelta,
      },
      severity,
      colorMatch,
    });
  }

  // Check for missing lines (expected but not found)
  const expectedRoles = ['header_top', 'header_bottom', 'footer'];
  const missingRoles = expectedRoles.filter((r) => !matchedRoles.has(r));

  return {
    slideNumber,
    slideName,
    slideKey: slideKey || null,
    lineCount: lines.length,
    driftEntries,
    missingRoles,
    hasBlockingDrift: driftEntries.some((e) => e.severity === 'error'),
    hasWarningDrift: driftEntries.some((e) => e.severity === 'warning'),
  };
}

function getExpectedThickness(role) {
  if (role === 'header_top') return EXPECTED.headerTopThicknessEmu;
  if (role === 'header_bottom') return EXPECTED.headerBottomThicknessEmu;
  if (role === 'footer') return EXPECTED.footerThicknessEmu;
  return null;
}

function getExpectedColor(role) {
  if (role === 'header_top') return EXPECTED.headerTopColor;
  if (role === 'header_bottom') return EXPECTED.headerBottomColor;
  if (role === 'footer') return EXPECTED.footerColor;
  return null;
}

// ---------------------------------------------------------------------------
// Full PPTX drift scan
// ---------------------------------------------------------------------------

/**
 * Scan a generated PPTX buffer for header/footer line drift across all slides.
 *
 * @param {Buffer} pptxBuffer - The generated PPTX file buffer
 * @param {Object} [options]
 * @param {Array<{generatedSlideNumber: number, templateSlideNumber: number, blockKey: string|null}>} [options.slideMapping]
 *   Mapping of generated slide numbers to block keys (from templateCloneSlides)
 * @returns {Object} Full drift runInfo report
 */
async function scanDrift(pptxBuffer, options = {}) {
  const slideMapping = options.slideMapping || [];
  const zip = await JSZip.loadAsync(pptxBuffer);

  // Build a lookup from slide number -> blockKey
  const slideKeyLookup = {};
  for (const entry of slideMapping) {
    if (entry.generatedSlideNumber != null && entry.blockKey) {
      slideKeyLookup[entry.generatedSlideNumber] = entry.blockKey;
    }
  }

  // Find all slide XML files
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = Number(a.match(/slide(\d+)/)?.[1] || 0);
      const numB = Number(b.match(/slide(\d+)/)?.[1] || 0);
      return numA - numB;
    });

  // Also check the main layout (slideLayout3.xml) for baseline reference
  const layoutFile = 'ppt/slideLayouts/slideLayout3.xml';
  const layoutXml = await zip.file(layoutFile)?.async('string');
  let layoutAnalysis = null;
  if (layoutXml) {
    layoutAnalysis = analyzeSlide(layoutXml, 'slideLayout3.xml', 0, '_layout');
  }

  // Analyze each slide
  const slideAnalyses = [];
  const blockingSlideKeys = [];
  const blockingSlideNumbers = [];
  const warningSlideKeys = [];

  for (const slidePath of slideFiles) {
    const slideXml = await zip.file(slidePath)?.async('string');
    if (!slideXml) continue;

    const slideNum = Number(slidePath.match(/slide(\d+)/)?.[1] || 0);
    const slideName = slidePath.replace(/^ppt\/slides\//, '');
    const slideKey = slideKeyLookup[slideNum] || null;

    const analysis = analyzeSlide(slideXml, slideName, slideNum, slideKey);
    slideAnalyses.push(analysis);

    if (analysis.hasBlockingDrift) {
      blockingSlideKeys.push(slideKey || `slide${slideNum}`);
      blockingSlideNumbers.push(slideNum);
    } else if (analysis.hasWarningDrift) {
      warningSlideKeys.push(slideKey || `slide${slideNum}`);
    }
  }

  // Aggregate statistics
  const allDriftEntries = slideAnalyses.flatMap((s) => s.driftEntries);
  const errorCount = allDriftEntries.filter((e) => e.severity === 'error').length;
  const warningCount = allDriftEntries.filter((e) => e.severity === 'warning').length;
  const infoCount = allDriftEntries.filter((e) => e.severity === 'info').length;

  const maxDeltaEntry = allDriftEntries.reduce(
    (max, e) => (e.delta.yEmu > (max?.delta?.yEmu || 0) ? e : max),
    null
  );

  const report = {
    _meta: {
      generatedAt: new Date().toISOString(),
      description: 'Header/footer line drift runInfo against Escort template ground truth',
      thresholds: {
        infoMaxEmu: DRIFT_THRESHOLD_INFO,
        warningMaxEmu: DRIFT_THRESHOLD_WARNING,
        errorMinEmu: DRIFT_THRESHOLD_WARNING + 1,
      },
      expectedGeometry: {
        headerTopY: EXPECTED.headerTopY,
        headerTopYInches: Number((EXPECTED.headerTopY / 914400).toFixed(4)),
        headerBottomY: EXPECTED.headerBottomY,
        headerBottomYInches: Number((EXPECTED.headerBottomY / 914400).toFixed(4)),
        footerY: EXPECTED.footerY,
        footerYInches: Number((EXPECTED.footerY / 914400).toFixed(4)),
      },
    },
    summary: {
      totalSlides: slideAnalyses.length,
      slidesWithBlockingDrift: blockingSlideNumbers.length,
      slidesWithWarningDrift: warningSlideKeys.length,
      totalDriftEntries: allDriftEntries.length,
      errorCount,
      warningCount,
      infoCount,
      pass: errorCount === 0,
      maxDelta: maxDeltaEntry
        ? {
            yEmu: maxDeltaEntry.delta.yEmu,
            yInches: maxDeltaEntry.delta.yInches,
            role: maxDeltaEntry.role,
            slideNumber: maxDeltaEntry.slideNumber,
            slideKey: maxDeltaEntry.slideKey,
          }
        : null,
    },
    blockingSlideKeys: [...new Set(blockingSlideKeys)],
    blockingSlideNumbers: [...new Set(blockingSlideNumbers)],
    warningSlideKeys: [...new Set(warningSlideKeys)],
    layoutAnalysis,
    slides: slideAnalyses,
  };

  return report;
}

// ---------------------------------------------------------------------------
// Report writer
// ---------------------------------------------------------------------------

/**
 * Write the drift report to reports/formatting/header-footer-drift.json.
 *
 * @param {Object} report - The drift runInfo report from scanDrift()
 * @param {string} [baseDir] - Base directory (defaults to __dirname)
 * @returns {string} Path to the written report file
 */
function writeReport(report, baseDir) {
  const dir = path.join(baseDir || __dirname, 'reports', 'formatting');
  fs.mkdirSync(dir, { recursive: true });
  const reportPath = path.join(dir, 'header-footer-drift.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return reportPath;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  scanDrift,
  writeReport,
  analyzeSlide,
  classifySeverity,
  classifyLine,
  extractHorizontalLines,
  EXPECTED,
  DRIFT_THRESHOLD_INFO,
  DRIFT_THRESHOLD_WARNING,
  // For testing internals
  __test: {
    getExpectedThickness,
    getExpectedColor,
  },
};
