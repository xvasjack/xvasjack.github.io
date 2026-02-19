'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_PATTERNS_PATH = path.resolve(__dirname, '..', '..', 'template-patterns.json');

// ── Load template spec ───────────────────────────────────────────────────────
let _cachedSpec = null;
function loadTemplateSpec() {
  if (_cachedSpec) return _cachedSpec;
  if (!fs.existsSync(TEMPLATE_PATTERNS_PATH)) {
    throw new Error(`Template patterns file not found: ${TEMPLATE_PATTERNS_PATH}`);
  }
  _cachedSpec = JSON.parse(fs.readFileSync(TEMPLATE_PATTERNS_PATH, 'utf-8'));
  return _cachedSpec;
}

// ── Position tolerance ───────────────────────────────────────────────────────
const POSITION_TOLERANCE = 0.15; // inches

function positionWithinTolerance(actual, expected, tolerance = POSITION_TOLERANCE) {
  if (actual == null || expected == null) return true; // skip if missing
  return Math.abs(Number(actual) - Number(expected)) <= tolerance;
}

// ── Validate slide positions ─────────────────────────────────────────────────
function validateSlidePositions(slideObj, spec) {
  const violations = [];
  const positions = spec.pptxPositions || spec.positions;
  if (!positions) return violations;

  const checks = [
    { key: 'title', fields: ['x', 'y', 'w', 'h'] },
    { key: 'titleBar', fields: ['x', 'y', 'w', 'h'] },
    { key: 'contentArea', fields: ['x', 'y', 'w', 'h'] },
    { key: 'sourceBar', fields: ['x', 'y', 'w', 'h'] },
  ];

  for (const check of checks) {
    const expected = positions[check.key];
    const actual = slideObj?.[check.key];
    if (!expected || !actual) continue;
    for (const f of check.fields) {
      if (!positionWithinTolerance(actual[f], expected[f])) {
        violations.push({
          type: 'position',
          element: check.key,
          field: f,
          expected: expected[f],
          actual: actual[f],
          delta: Math.abs(Number(actual[f]) - Number(expected[f])),
        });
      }
    }
  }
  return violations;
}

// ── Validate colors ──────────────────────────────────────────────────────────
function validateColors(slideColors, spec) {
  const violations = [];
  const expectedColors = spec?.style?.colors;
  if (!expectedColors || !slideColors) return violations;

  const criticalColorKeys = ['dk1', 'dk2', 'accent1', 'accent3', 'accent6', 'lt1'];
  for (const key of criticalColorKeys) {
    const expected = String(expectedColors[key] || '').toUpperCase();
    const actual = String(slideColors[key] || '').toUpperCase();
    if (!expected || !actual) continue;
    if (actual !== expected) {
      violations.push({
        type: 'color',
        element: key,
        expected,
        actual,
      });
    }
  }
  return violations;
}

// ── Validate fonts ───────────────────────────────────────────────────────────
function validateFonts(slideFonts, spec) {
  const violations = [];
  const expectedFonts = spec?.style?.fonts;
  if (!expectedFonts || !slideFonts) return violations;

  if (expectedFonts.heading && slideFonts.heading) {
    if (slideFonts.heading !== expectedFonts.heading) {
      violations.push({
        type: 'font',
        element: 'heading',
        expected: expectedFonts.heading,
        actual: slideFonts.heading,
      });
    }
  }
  if (expectedFonts.body && slideFonts.body) {
    if (slideFonts.body !== expectedFonts.body) {
      violations.push({
        type: 'font',
        element: 'body',
        expected: expectedFonts.body,
        actual: slideFonts.body,
      });
    }
  }
  return violations;
}

// ── Validate table borders ───────────────────────────────────────────────────
function validateTableBorders(tableConfig, spec) {
  const violations = [];
  const expectedTable = spec?.style?.table;
  if (!expectedTable || !tableConfig) return violations;

  if (expectedTable.borderColor && tableConfig.borderColor) {
    const exp = String(expectedTable.borderColor).toUpperCase();
    const act = String(tableConfig.borderColor).toUpperCase();
    if (act !== exp) {
      violations.push({
        type: 'table_border',
        element: 'borderColor',
        expected: exp,
        actual: act,
      });
    }
  }
  return violations;
}

// ── Run the strict template gate ─────────────────────────────────────────────
// Accepts pptMetrics or a slide-level inspection object.
// Returns { pass, violations, blockingSlideKeys, summary }.
function runStrictTemplateGate(pptInspection) {
  const spec = loadTemplateSpec();
  const allViolations = [];

  if (!pptInspection || typeof pptInspection !== 'object') {
    return {
      pass: false,
      violations: [{ type: 'fatal', message: 'No PPT inspection data provided' }],
      blockingSlideKeys: ['(no data)'],
      summary: 'No PPT inspection data provided',
    };
  }

  // If pptInspection has slides array, validate each
  if (Array.isArray(pptInspection.slides)) {
    for (const slide of pptInspection.slides) {
      const slideKey = slide.key || slide.title || slide.index || 'unknown';
      const posViolations = validateSlidePositions(slide, spec);
      for (const v of posViolations) {
        allViolations.push({ ...v, slideKey });
      }
    }
  }

  // Validate global colors
  if (pptInspection.colors) {
    const colorViolations = validateColors(pptInspection.colors, spec);
    allViolations.push(...colorViolations);
  }

  // Validate global fonts
  if (pptInspection.fonts) {
    const fontViolations = validateFonts(pptInspection.fonts, spec);
    allViolations.push(...fontViolations);
  }

  // Validate table borders
  if (pptInspection.table) {
    const tableViolations = validateTableBorders(pptInspection.table, spec);
    allViolations.push(...tableViolations);
  }

  // Determine blocking slide keys
  const blockingSlideKeys = [
    ...new Set(allViolations.filter((v) => v.slideKey).map((v) => v.slideKey)),
  ];

  const pass = allViolations.length === 0;

  // Build human-readable summary
  const summaryLines = [];
  if (!pass) {
    summaryLines.push(`Template strict gate FAILED: ${allViolations.length} violation(s)`);
    if (blockingSlideKeys.length > 0) {
      summaryLines.push(`Blocking slide keys: ${blockingSlideKeys.join(', ')}`);
    }
    const byType = {};
    for (const v of allViolations) {
      byType[v.type] = (byType[v.type] || 0) + 1;
    }
    for (const [type, count] of Object.entries(byType)) {
      summaryLines.push(`  ${type}: ${count}`);
    }
    for (const v of allViolations.slice(0, 15)) {
      const detail = v.slideKey ? `[${v.slideKey}] ` : '';
      summaryLines.push(
        `  - ${detail}${v.type}: ${v.element} expected=${v.expected} actual=${v.actual}`
      );
    }
    if (allViolations.length > 15) {
      summaryLines.push(`  ... and ${allViolations.length - 15} more`);
    }
  } else {
    summaryLines.push('Template strict gate PASSED');
  }

  return {
    pass,
    violations: allViolations,
    blockingSlideKeys,
    summary: summaryLines.join('\n'),
  };
}

// ── Build error artifact for template failures ───────────────────────────────
function buildTemplateErrorArtifact(gateResult) {
  return {
    pass: gateResult.pass,
    violationCount: gateResult.violations.length,
    blockingSlideKeys: gateResult.blockingSlideKeys,
    violations: gateResult.violations,
    summary: gateResult.summary,
    templateSource: (() => {
      try {
        return loadTemplateSpec()?._meta?.source || 'unknown';
      } catch (_) {
        return 'unknown';
      }
    })(),
  };
}

module.exports = {
  loadTemplateSpec,
  validateSlidePositions,
  validateColors,
  validateFonts,
  validateTableBorders,
  runStrictTemplateGate,
  buildTemplateErrorArtifact,
  POSITION_TOLERANCE,
};
