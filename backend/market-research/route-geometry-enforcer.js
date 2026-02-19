'use strict';

/**
 * Route Geometry Enforcer
 *
 * Validates that every PPT block's content type (table, chart, text) targets a
 * slide whose geometry actually supports that content.  Provides deterministic
 * fallback chains with provenance tracking, structured hard-fail errors, and
 * route health metrics.
 *
 * Self-contained: reads template-patterns.json directly to avoid pulling in
 * the full ppt-utils.js dependency chain (which drags in ai-clients/node-fetch).
 *
 * Integration: call enforce() before building each block in deck-builder-single.js.
 */

const templatePatterns = require('./template-patterns.json');
const {
  BLOCK_TEMPLATE_PATTERN_MAP,
  BLOCK_TEMPLATE_SLIDE_MAP,
} = require('./template-contract-compiler');

/**
 * Minimal getTemplateSlideLayout — extracts layout from template-patterns.json slideDetails.
 * Mirrors the logic in ppt-utils.js getTemplateSlideLayout().
 */
const _layoutCache = new Map();

function _isValidPos(pos) {
  return (
    pos &&
    Number.isFinite(pos.x) &&
    Number.isFinite(pos.y) &&
    Number.isFinite(pos.w) &&
    Number.isFinite(pos.h)
  );
}

function _rectFromPos(pos) {
  return { x: pos.x, y: pos.y, w: pos.w, h: pos.h };
}

function _rectArea(r) {
  if (!_isValidPos(r)) return 0;
  return Math.max(0, r.w) * Math.max(0, r.h);
}

function getTemplateSlideLayout(slideNumber) {
  const numeric = Number(slideNumber);
  if (!Number.isFinite(numeric)) return null;
  if (_layoutCache.has(numeric)) return _layoutCache.get(numeric);

  const slide = (templatePatterns.slideDetails || []).find(
    (s) => Number(s?.slideNumber) === numeric
  );
  if (!slide) {
    _layoutCache.set(numeric, null);
    return null;
  }

  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  const tables = elements
    .filter((e) => e?.type === 'table' && _isValidPos(e?.position))
    .map((e) => _rectFromPos(e.position));
  const charts = elements
    .filter((e) => e?.type === 'chart' && _isValidPos(e?.position))
    .map((e) => _rectFromPos(e.position))
    .filter((r) => r.w > 0.2 && r.h > 0.2)
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const shapes = elements.filter((e) => e?.type === 'shape' && _isValidPos(e?.position));
  const titleShape = shapes
    .filter((s) => /^title/i.test(String(s?.name || '')) && s.position.y < 1.3)
    .sort((a, b) => a.position.y - b.position.y)[0];
  const title = titleShape ? _rectFromPos(titleShape.position) : null;

  const largestTable = tables.slice().sort((a, b) => _rectArea(b) - _rectArea(a))[0] || null;

  const layout = {
    slideNumber: numeric,
    title,
    source: null,
    content: null,
    table: largestTable,
    charts,
    callouts: [],
  };
  _layoutCache.set(numeric, layout);
  return layout;
}

/**
 * Minimal resolveTemplatePattern — resolves a block key to its template pattern and slide.
 * Mirrors the logic in ppt-utils.js resolveTemplatePattern().
 */
function resolveTemplatePattern({ blockKey, dataType, data, templateSelection } = {}) {
  const patterns = templatePatterns.patterns || {};
  const defaultPattern = BLOCK_TEMPLATE_PATTERN_MAP[blockKey] || _choosePattern(dataType, data);
  let patternKey = defaultPattern;
  let source = BLOCK_TEMPLATE_PATTERN_MAP[blockKey] ? 'block-default' : 'dataType-fallback';
  let selectedSlide = null;

  let overridePattern = null;
  let overrideSlide = null;
  if (templateSelection && typeof templateSelection === 'object') {
    overridePattern = templateSelection.pattern || null;
    overrideSlide = templateSelection.slide ?? null;
  } else if (Number.isFinite(Number(templateSelection))) {
    overrideSlide = Number(templateSelection);
  } else if (typeof templateSelection === 'string' && templateSelection.trim()) {
    const trimmed = templateSelection.trim();
    if (Number.isFinite(Number(trimmed))) overrideSlide = Number(trimmed);
    else overridePattern = trimmed;
  }

  if (overridePattern && patterns[overridePattern]) {
    patternKey = overridePattern;
    source = 'override-pattern';
  }

  if (overrideSlide != null) {
    const fromSlide = _getPatternKeyForSlideId(overrideSlide);
    if (fromSlide) {
      patternKey = fromSlide;
      selectedSlide = Number(overrideSlide);
      source = 'override-slide';
    }
  }

  if (!patterns[patternKey]) {
    patternKey = defaultPattern;
    source = 'fallback';
  }

  let patternDef = patterns[patternKey] || null;
  let templateSlides = Array.isArray(patternDef?.templateSlides) ? patternDef.templateSlides : [];
  let isTemplateBacked = templateSlides.length > 0;

  if (!isTemplateBacked && patternKey !== defaultPattern) {
    const defaultDef = patterns[defaultPattern];
    const defaultSlides = Array.isArray(defaultDef?.templateSlides)
      ? defaultDef.templateSlides
      : [];
    if (defaultDef && defaultSlides.length > 0) {
      patternKey = defaultPattern;
      patternDef = defaultDef;
      templateSlides = defaultSlides;
      isTemplateBacked = true;
      source = `${source}-nonTemplateFallback`;
    }
  }

  if (selectedSlide == null && templateSlides.length > 0) {
    const mappedSlide = BLOCK_TEMPLATE_SLIDE_MAP[blockKey];
    if (Number.isFinite(Number(mappedSlide)) && templateSlides.includes(Number(mappedSlide))) {
      selectedSlide = Number(mappedSlide);
      source = source === 'block-default' ? 'block-default-slide' : `${source}-blockSlide`;
    } else {
      selectedSlide = templateSlides[0];
    }
  }

  return {
    patternKey,
    patternDef,
    templateSlides,
    selectedSlide,
    isTemplateBacked,
    source,
  };
}

function _getPatternKeyForSlideId(slideId) {
  if (!Number.isFinite(Number(slideId))) return null;
  const numericId = Number(slideId);
  const patterns = templatePatterns.patterns || {};
  for (const [patternKey, patternDef] of Object.entries(patterns)) {
    if (
      Array.isArray(patternDef?.templateSlides) &&
      patternDef.templateSlides.includes(numericId)
    ) {
      return patternKey;
    }
  }
  return null;
}

function _choosePattern(dataType) {
  if (dataType === 'table') return 'regulatory_table';
  if (dataType === 'chart') return 'chart_with_grid';
  return 'regulatory_table';
}

// ---------------------------------------------------------------------------
// Constants: valid geometry types
// ---------------------------------------------------------------------------

const GEOMETRY_TABLE = 'table';
const GEOMETRY_CHART = 'chart';
const GEOMETRY_TEXT = 'text';

/**
 * Pattern key -> required geometry.
 */
function inferPatternGeometry(patternKey) {
  if (!patternKey || typeof patternKey !== 'string') return GEOMETRY_TEXT;
  const k = patternKey.toLowerCase();
  if (k.includes('table') || k.includes('company') || k.includes('case_study'))
    return GEOMETRY_TABLE;
  if (k.includes('chart')) return GEOMETRY_CHART;
  return GEOMETRY_TEXT;
}

/**
 * Check whether a layout object satisfies a required geometry.
 */
function layoutSatisfiesGeometry(layout, requiredGeometry) {
  if (!requiredGeometry || requiredGeometry === GEOMETRY_TEXT) return true;
  if (!layout || typeof layout !== 'object') return false;
  if (requiredGeometry === GEOMETRY_TABLE) return Boolean(layout.table);
  if (requiredGeometry === GEOMETRY_CHART) {
    return Array.isArray(layout.charts) && layout.charts.length > 0;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Route-Geometry pairing registry
// ---------------------------------------------------------------------------

function buildRouteGeometryRegistry(tableContextKeys, chartContextKeys) {
  const registry = {};
  const tableSet =
    tableContextKeys instanceof Set ? tableContextKeys : new Set(tableContextKeys || []);
  const chartSet =
    chartContextKeys instanceof Set ? chartContextKeys : new Set(chartContextKeys || []);

  const allBlockKeys = new Set([
    ...Object.keys(BLOCK_TEMPLATE_PATTERN_MAP),
    ...Object.keys(BLOCK_TEMPLATE_SLIDE_MAP),
    ...tableSet,
    ...chartSet,
  ]);

  for (const blockKey of allBlockKeys) {
    const patternKey = BLOCK_TEMPLATE_PATTERN_MAP[blockKey] || null;
    const slideNumber = BLOCK_TEMPLATE_SLIDE_MAP[blockKey] || null;

    let requiredGeometry = GEOMETRY_TEXT;
    if (tableSet.has(blockKey)) {
      requiredGeometry = GEOMETRY_TABLE;
    } else if (chartSet.has(blockKey)) {
      requiredGeometry = GEOMETRY_CHART;
    } else if (patternKey) {
      requiredGeometry = inferPatternGeometry(patternKey);
    }

    registry[blockKey] = { patternKey, slideNumber, requiredGeometry };
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Fallback chain builder — Task 2: deterministic ordering by slideNumber
// ---------------------------------------------------------------------------

/**
 * Build a deterministic fallback chain for a block.
 * Cross-pattern slides are sorted by slideNumber to eliminate
 * nondeterminism from object key iteration order.
 */
function buildFallbackChain(blockKey, requiredGeometry) {
  const chain = [];
  const seen = new Set();

  const addSlide = (slideNum, source) => {
    const n = Number(slideNum);
    if (!Number.isFinite(n) || n <= 0) return;
    if (seen.has(n)) return;
    seen.add(n);
    chain.push({ slideNumber: n, source });
  };

  // 1. Primary slide
  const primarySlide = BLOCK_TEMPLATE_SLIDE_MAP[blockKey];
  if (primarySlide) addSlide(primarySlide, 'block-default-slide');

  // 2. Pattern's templateSlides (sorted for determinism)
  const patternKey = BLOCK_TEMPLATE_PATTERN_MAP[blockKey];
  if (patternKey) {
    const patternDef = (templatePatterns.patterns || {})[patternKey];
    const slides = Array.isArray(patternDef?.templateSlides)
      ? [...patternDef.templateSlides].sort((a, b) => a - b)
      : [];
    for (const s of slides) addSlide(s, `pattern:${patternKey}`);
  }

  // 3. Scan all patterns for matching geometry slides
  //    Sort pattern keys alphabetically for deterministic iteration,
  //    then sort each pattern's slides by slideNumber.
  const patterns = templatePatterns.patterns || {};
  const sortedPatternKeys = Object.keys(patterns).sort();
  const crossPatternCandidates = [];

  for (const pk of sortedPatternKeys) {
    if (pk === patternKey) continue;
    const pDef = patterns[pk];
    const slides = Array.isArray(pDef?.templateSlides) ? pDef.templateSlides : [];
    const patternGeo = inferPatternGeometry(pk);
    if (requiredGeometry === GEOMETRY_TEXT || patternGeo === requiredGeometry) {
      for (const s of slides) {
        crossPatternCandidates.push({ slideNumber: Number(s), source: `cross-pattern:${pk}` });
      }
    }
  }

  // Sort cross-pattern candidates by slideNumber for deterministic ordering
  crossPatternCandidates.sort((a, b) => a.slideNumber - b.slideNumber);
  for (const candidate of crossPatternCandidates) {
    addSlide(candidate.slideNumber, candidate.source);
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Task 3: getDeterministicFallback — single deterministic fallback per block
// ---------------------------------------------------------------------------

/**
 * Get a single deterministic fallback slide for a block context.
 * Returns the first geometry-compatible slide in the deterministic fallback chain,
 * or null if no fallback exists.
 *
 * @param {string} blockKey
 * @returns {{ slideNumber: number, source: string, layout: object } | null}
 */
function getDeterministicFallback(blockKey) {
  if (!blockKey || typeof blockKey !== 'string') return null;

  const patternKey = BLOCK_TEMPLATE_PATTERN_MAP[blockKey];
  let requiredGeometry = GEOMETRY_TEXT;
  if (patternKey) requiredGeometry = inferPatternGeometry(patternKey);

  const primarySlide = BLOCK_TEMPLATE_SLIDE_MAP[blockKey];
  const chain = buildFallbackChain(blockKey, requiredGeometry);

  // Skip the primary slide — we want the fallback, not the primary
  for (const candidate of chain) {
    if (candidate.slideNumber === primarySlide) continue;
    const layout = getTemplateSlideLayout(candidate.slideNumber);
    if (layoutSatisfiesGeometry(layout, requiredGeometry)) {
      return {
        slideNumber: candidate.slideNumber,
        source: candidate.source,
        layout,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Metrics + failure tracking
// ---------------------------------------------------------------------------

let _metrics = {
  totalChecks: 0,
  passed: 0,
  recoveredCount: 0,
  hardFailCount: 0,
  maxFallbackDepth: 0,
  fallbackDepthSum: 0,
};

let _failures = [];

function resetMetrics() {
  _metrics = {
    totalChecks: 0,
    passed: 0,
    recoveredCount: 0,
    hardFailCount: 0,
    maxFallbackDepth: 0,
    fallbackDepthSum: 0,
  };
  _failures = [];
  _layoutCache.clear();
}

// ---------------------------------------------------------------------------
// Task 6: Structured error codes for RouteGeometryError
// ---------------------------------------------------------------------------

const ERROR_CODES = Object.freeze({
  RGE001_NO_TABLE_GEOMETRY: 'RGE001_NO_TABLE_GEOMETRY',
  RGE002_NO_CHART_GEOMETRY: 'RGE002_NO_CHART_GEOMETRY',
  RGE003_FALLBACK_EXHAUSTED: 'RGE003_FALLBACK_EXHAUSTED',
  RGE004_STRICT_MODE_MISMATCH: 'RGE004_STRICT_MODE_MISMATCH',
  RGE005_UNKNOWN_BLOCK: 'RGE005_UNKNOWN_BLOCK',
  RGE006_NO_SLIDE_LAYOUT: 'RGE006_NO_SLIDE_LAYOUT',
});

function _resolveErrorCode(expectedGeometry, actualGeometry, fallbackExhausted) {
  if (fallbackExhausted) return ERROR_CODES.RGE003_FALLBACK_EXHAUSTED;
  if (expectedGeometry === GEOMETRY_TABLE) return ERROR_CODES.RGE001_NO_TABLE_GEOMETRY;
  if (expectedGeometry === GEOMETRY_CHART) return ERROR_CODES.RGE002_NO_CHART_GEOMETRY;
  return ERROR_CODES.RGE003_FALLBACK_EXHAUSTED;
}

// ---------------------------------------------------------------------------
// Hard fail error — enhanced with error codes (Task 6)
// ---------------------------------------------------------------------------

class RouteGeometryError extends Error {
  constructor({
    blockKey,
    targetSlide,
    expectedGeometry,
    actualGeometry,
    evidence,
    errorCode,
    provenance,
  }) {
    const code = errorCode || _resolveErrorCode(expectedGeometry, actualGeometry, true);
    const msg = `[ROUTE GEOMETRY] [${code}] Hard fail: block "${blockKey}" targeting slide ${targetSlide} requires ${expectedGeometry} geometry but slide has ${actualGeometry}. ${evidence || ''}`;
    super(msg);
    this.name = 'RouteGeometryError';
    this.code = code;
    this.blockKey = blockKey;
    this.targetSlide = targetSlide;
    this.expectedGeometry = expectedGeometry;
    this.actualGeometry = actualGeometry;
    this.evidence = evidence || '';
    this.provenance = provenance || [];
  }
}

function describeActualGeometry(layout) {
  if (!layout || typeof layout !== 'object') return 'none';
  const parts = [];
  if (layout.table) parts.push(GEOMETRY_TABLE);
  if (Array.isArray(layout.charts) && layout.charts.length > 0) parts.push(GEOMETRY_CHART);
  if (parts.length === 0) parts.push(GEOMETRY_TEXT);
  return parts.join('+');
}

// ---------------------------------------------------------------------------
// Core enforcement — Task 4: enhanced provenance logging
// ---------------------------------------------------------------------------

/**
 * enforce() — the main entry point.
 *
 * Call before building each block. Validates that the resolved route targets
 * a slide whose geometry is compatible with the content being built.
 *
 * Task 4: Always includes full structured provenance:
 *   - requestedSlide: the originally requested slide
 *   - recoveredSlide: the slide actually used (same if no recovery)
 *   - reasonCode: null | 'geometry_recovery' | 'fallback_exhausted'
 *   - provenanceChain: array of { step, slideNumber, source, result }
 *
 * @param {Object} opts
 * @param {string} opts.blockKey
 * @param {string} opts.dataType
 * @param {*}      opts.data
 * @param {*}      [opts.templateSelection]
 * @param {Set|Array} opts.tableContextKeys
 * @param {Set|Array} opts.chartContextKeys
 * @returns {Object} Full enforcement result with structured provenance
 * @throws {RouteGeometryError} if no valid route found
 */
function enforce({
  blockKey,
  dataType,
  data,
  templateSelection = null,
  tableContextKeys = [],
  chartContextKeys = [],
} = {}) {
  _metrics.totalChecks++;

  const tableSet =
    tableContextKeys instanceof Set ? tableContextKeys : new Set(tableContextKeys || []);
  const chartSet =
    chartContextKeys instanceof Set ? chartContextKeys : new Set(chartContextKeys || []);

  // Determine required geometry
  let requiredGeometry = GEOMETRY_TEXT;
  if (tableSet.has(blockKey)) {
    requiredGeometry = GEOMETRY_TABLE;
  } else if (chartSet.has(blockKey)) {
    requiredGeometry = GEOMETRY_CHART;
  } else {
    const patternKey = BLOCK_TEMPLATE_PATTERN_MAP[blockKey];
    if (patternKey) requiredGeometry = inferPatternGeometry(patternKey);
  }

  // Resolve the primary route
  const primaryResolved = resolveTemplatePattern({
    blockKey,
    dataType,
    data,
    templateSelection,
  });

  const primarySlide = Number(primaryResolved?.selectedSlide);
  const primaryLayout =
    Number.isFinite(primarySlide) && primarySlide > 0 ? getTemplateSlideLayout(primarySlide) : null;

  // Build structured provenance chain (Task 4)
  const provenanceChain = [];

  // Fast path: primary is fine
  if (layoutSatisfiesGeometry(primaryLayout, requiredGeometry)) {
    _metrics.passed++;
    provenanceChain.push({
      step: 0,
      slideNumber: primarySlide,
      source: primaryResolved.source,
      result: 'OK',
    });
    return {
      resolved: primaryResolved,
      layout: primaryLayout,
      requiredGeometry,
      recovered: false,
      fromSlide: primarySlide,
      toSlide: primarySlide,
      reason: null,
      reasonCode: null,
      fallbackDepth: 0,
      provenance: ['primary'],
      provenanceChain,
      requestedSlide: primarySlide,
      recoveredSlide: primarySlide,
    };
  }

  // Primary failed geometry check -> walk fallback chain
  provenanceChain.push({
    step: 0,
    slideNumber: primarySlide,
    source: primaryResolved.source,
    result: 'FAIL',
    actualGeometry: describeActualGeometry(primaryLayout),
    requiredGeometry,
  });

  const fallbackChain = buildFallbackChain(blockKey, requiredGeometry);
  const provenance = ['primary:FAIL'];

  for (let depth = 0; depth < fallbackChain.length; depth++) {
    const candidate = fallbackChain[depth];
    const layout = getTemplateSlideLayout(candidate.slideNumber);

    if (!layoutSatisfiesGeometry(layout, requiredGeometry)) {
      provenance.push(`${candidate.source}:slide${candidate.slideNumber}:FAIL`);
      provenanceChain.push({
        step: depth + 1,
        slideNumber: candidate.slideNumber,
        source: candidate.source,
        result: 'FAIL',
        actualGeometry: describeActualGeometry(layout),
      });
      continue;
    }

    // Found a valid fallback
    const fallbackDepth = depth + 1;
    _metrics.recoveredCount++;
    _metrics.fallbackDepthSum += fallbackDepth;
    if (fallbackDepth > _metrics.maxFallbackDepth) {
      _metrics.maxFallbackDepth = fallbackDepth;
    }

    provenance.push(`${candidate.source}:slide${candidate.slideNumber}:OK`);
    provenanceChain.push({
      step: depth + 1,
      slideNumber: candidate.slideNumber,
      source: candidate.source,
      result: 'OK',
    });

    const fallbackResolved = {
      ...primaryResolved,
      selectedSlide: candidate.slideNumber,
      source: 'geometryRecovery',
    };

    return {
      resolved: fallbackResolved,
      layout,
      requiredGeometry,
      recovered: true,
      fromSlide: primarySlide,
      toSlide: candidate.slideNumber,
      reason: `geometry mismatch: needed ${requiredGeometry}, recovered via ${candidate.source}`,
      reasonCode: 'geometry_recovery',
      fallbackDepth,
      provenance,
      provenanceChain,
      requestedSlide: primarySlide,
      recoveredSlide: candidate.slideNumber,
    };
  }

  // Hard fail: no valid route found
  _metrics.hardFailCount++;
  const actualGeometry = describeActualGeometry(primaryLayout);
  const evidence = `Fallback chain exhausted (${fallbackChain.length} candidates). Block pattern: ${primaryResolved?.patternKey || 'none'}, primary slide: ${primarySlide || 'none'}`;
  const errorCode = _resolveErrorCode(requiredGeometry, actualGeometry, true);

  provenanceChain.push({
    step: fallbackChain.length + 1,
    slideNumber: null,
    source: 'exhausted',
    result: 'HARD_FAIL',
  });

  const failure = {
    blockKey,
    targetSlide: primarySlide || null,
    expectedGeometry: requiredGeometry,
    actualGeometry,
    evidence,
    errorCode,
    fallbackChainLength: fallbackChain.length,
    provenance,
    provenanceChain,
  };
  _failures.push(failure);

  throw new RouteGeometryError(failure);
}

// ---------------------------------------------------------------------------
// Task 10: enforceStrict() — no fallback, throws immediately on mismatch
// ---------------------------------------------------------------------------

/**
 * Strict mode enforcement: throws immediately if the primary slide's geometry
 * does not match. No fallback chain is walked.
 *
 * @param {Object} opts - Same parameters as enforce()
 * @returns {Object} Same shape as enforce() return (never recovered)
 * @throws {RouteGeometryError} with code RGE004_STRICT_MODE_MISMATCH on any mismatch
 */
function enforceStrict({
  blockKey,
  dataType,
  data,
  templateSelection = null,
  tableContextKeys = [],
  chartContextKeys = [],
} = {}) {
  _metrics.totalChecks++;

  const tableSet =
    tableContextKeys instanceof Set ? tableContextKeys : new Set(tableContextKeys || []);
  const chartSet =
    chartContextKeys instanceof Set ? chartContextKeys : new Set(chartContextKeys || []);

  // Determine required geometry
  let requiredGeometry = GEOMETRY_TEXT;
  if (tableSet.has(blockKey)) {
    requiredGeometry = GEOMETRY_TABLE;
  } else if (chartSet.has(blockKey)) {
    requiredGeometry = GEOMETRY_CHART;
  } else {
    const patternKey = BLOCK_TEMPLATE_PATTERN_MAP[blockKey];
    if (patternKey) requiredGeometry = inferPatternGeometry(patternKey);
  }

  // Resolve the primary route
  const primaryResolved = resolveTemplatePattern({
    blockKey,
    dataType,
    data,
    templateSelection,
  });

  const primarySlide = Number(primaryResolved?.selectedSlide);
  const primaryLayout =
    Number.isFinite(primarySlide) && primarySlide > 0 ? getTemplateSlideLayout(primarySlide) : null;

  const provenanceChain = [
    {
      step: 0,
      slideNumber: primarySlide,
      source: primaryResolved.source,
      result: layoutSatisfiesGeometry(primaryLayout, requiredGeometry) ? 'OK' : 'FAIL',
      mode: 'strict',
    },
  ];

  if (layoutSatisfiesGeometry(primaryLayout, requiredGeometry)) {
    _metrics.passed++;
    return {
      resolved: primaryResolved,
      layout: primaryLayout,
      requiredGeometry,
      recovered: false,
      fromSlide: primarySlide,
      toSlide: primarySlide,
      reason: null,
      reasonCode: null,
      fallbackDepth: 0,
      provenance: ['primary:strict'],
      provenanceChain,
      requestedSlide: primarySlide,
      recoveredSlide: primarySlide,
      strictMode: true,
    };
  }

  // Strict mode: hard fail immediately, no fallback
  _metrics.hardFailCount++;
  const actualGeometry = describeActualGeometry(primaryLayout);
  const errorCode = ERROR_CODES.RGE004_STRICT_MODE_MISMATCH;
  const evidence = `Strict mode: no fallback allowed. Block "${blockKey}" requires ${requiredGeometry} on slide ${primarySlide} but slide has ${actualGeometry}.`;

  const failure = {
    blockKey,
    targetSlide: primarySlide || null,
    expectedGeometry: requiredGeometry,
    actualGeometry,
    evidence,
    errorCode,
    fallbackChainLength: 0,
    provenance: ['primary:strict:FAIL'],
    provenanceChain,
  };
  _failures.push(failure);

  throw new RouteGeometryError(failure);
}

// ---------------------------------------------------------------------------
// Route audit: validate ALL known block mappings
// ---------------------------------------------------------------------------

function auditAllRoutes(tableContextKeys, chartContextKeys) {
  const registry = buildRouteGeometryRegistry(tableContextKeys, chartContextKeys);
  const valid = [];
  const invalid = [];
  const unmapped = [];

  for (const [blockKey, entry] of Object.entries(registry)) {
    if (!entry.slideNumber) {
      unmapped.push({ blockKey, ...entry });
      continue;
    }

    const layout = getTemplateSlideLayout(entry.slideNumber);
    const satisfies = layoutSatisfiesGeometry(layout, entry.requiredGeometry);

    if (satisfies) {
      valid.push({
        blockKey,
        slideNumber: entry.slideNumber,
        requiredGeometry: entry.requiredGeometry,
        actualGeometry: describeActualGeometry(layout),
      });
    } else {
      invalid.push({
        blockKey,
        slideNumber: entry.slideNumber,
        requiredGeometry: entry.requiredGeometry,
        actualGeometry: describeActualGeometry(layout),
        patternKey: entry.patternKey,
      });
    }
  }

  return { valid, invalid, unmapped };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function getMetrics() {
  return {
    ..._metrics,
    avgFallbackDepth:
      _metrics.recoveredCount > 0
        ? Number((_metrics.fallbackDepthSum / _metrics.recoveredCount).toFixed(2))
        : 0,
  };
}

function getFailures() {
  return [..._failures];
}

module.exports = {
  enforce,
  enforceStrict,
  getDeterministicFallback,
  getMetrics,
  getFailures,
  resetMetrics,
  auditAllRoutes,
  RouteGeometryError,
  ERROR_CODES,
  // Internal maps re-exported for deck-builder-single.js integration
  BLOCK_TEMPLATE_PATTERN_MAP,
  BLOCK_TEMPLATE_SLIDE_MAP,
  // Exported for testing
  __test: {
    inferPatternGeometry,
    layoutSatisfiesGeometry,
    buildFallbackChain,
    buildRouteGeometryRegistry,
    describeActualGeometry,
    getTemplateSlideLayout,
    resolveTemplatePattern,
    GEOMETRY_TABLE,
    GEOMETRY_CHART,
    GEOMETRY_TEXT,
  },
};
