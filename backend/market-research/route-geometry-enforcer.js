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
 * Integration: call enforce() before rendering each block in ppt-single-country.js.
 */

const templatePatterns = require('./template-patterns.json');

// ---------------------------------------------------------------------------
// Re-implement minimal versions of ppt-utils helpers we need, avoiding import
// ---------------------------------------------------------------------------

/**
 * BLOCK_TEMPLATE_PATTERN_MAP — deterministic block -> pattern key mapping.
 * Mirrors the frozen map in ppt-utils.js.
 */
const BLOCK_TEMPLATE_PATTERN_MAP = Object.freeze({
  foundationalActs: 'regulatory_table',
  nationalPolicy: 'regulatory_table',
  investmentRestrictions: 'regulatory_table',
  keyIncentives: 'regulatory_table',
  regulatorySummary: 'regulatory_table',
  marketSizeAndGrowth: 'chart_insight_panels',
  supplyAndDemandDynamics: 'chart_with_grid',
  supplyAndDemandData: 'chart_with_grid',
  pricingAndTariffStructures: 'chart_insight_panels',
  pricingAndEconomics: 'chart_insight_panels',
  pricingAndCostBenchmarks: 'chart_insight_panels',
  infrastructureAndGrid: 'chart_with_grid',
  tpes: 'chart_insight_panels',
  finalDemand: 'chart_insight_panels',
  electricity: 'chart_insight_panels',
  gasLng: 'chart_with_grid',
  pricing: 'chart_insight_panels',
  escoMarket: 'chart_insight_panels',
  japanesePlayers: 'company_comparison',
  localMajor: 'company_comparison',
  foreignPlayers: 'company_comparison',
  caseStudy: 'case_study_rows',
  maActivity: 'company_comparison',
  dealEconomics: 'regulatory_table',
  partnerAssessment: 'company_comparison',
  entryStrategy: 'regulatory_table',
  implementation: 'case_study_rows',
  targetSegments: 'company_comparison',
  goNoGo: 'regulatory_table',
  opportunitiesObstacles: 'regulatory_table',
  keyInsights: 'regulatory_table',
  timingIntelligence: 'regulatory_table',
  lessonsLearned: 'regulatory_table',
});

/**
 * BLOCK_TEMPLATE_SLIDE_MAP — deterministic block -> template slide mapping.
 * Mirrors the frozen map in ppt-utils.js.
 */
const BLOCK_TEMPLATE_SLIDE_MAP = Object.freeze({
  foundationalActs: 7,
  nationalPolicy: 8,
  investmentRestrictions: 9,
  keyIncentives: 10,
  regulatorySummary: 6,
  marketSizeAndGrowth: 13,
  supplyAndDemandDynamics: 14,
  supplyAndDemandData: 14,
  pricingAndTariffStructures: 16,
  pricingAndEconomics: 16,
  pricingAndCostBenchmarks: 16,
  infrastructureAndGrid: 17,
  tpes: 13,
  finalDemand: 14,
  electricity: 15,
  gasLng: 17,
  pricing: 16,
  escoMarket: 18,
  japanesePlayers: 22,
  localMajor: 22,
  foreignPlayers: 22,
  caseStudy: 23,
  maActivity: 24,
  dealEconomics: 12,
  partnerAssessment: 22,
  entryStrategy: 12,
  implementation: 28,
  targetSegments: 22,
  goNoGo: 12,
  opportunitiesObstacles: 12,
  keyInsights: 12,
  timingIntelligence: 12,
  lessonsLearned: 12,
});

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
    const defaultSlides = Array.isArray(defaultDef?.templateSlides) ? defaultDef.templateSlides : [];
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
  if (k.includes('table') || k.includes('company') || k.includes('case_study')) return GEOMETRY_TABLE;
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
  const tableSet = tableContextKeys instanceof Set ? tableContextKeys : new Set(tableContextKeys || []);
  const chartSet = chartContextKeys instanceof Set ? chartContextKeys : new Set(chartContextKeys || []);

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
// Fallback chain builder
// ---------------------------------------------------------------------------

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

  // 2. Pattern's templateSlides
  const patternKey = BLOCK_TEMPLATE_PATTERN_MAP[blockKey];
  if (patternKey) {
    const patternDef = (templatePatterns.patterns || {})[patternKey];
    const slides = Array.isArray(patternDef?.templateSlides) ? patternDef.templateSlides : [];
    for (const s of slides) addSlide(s, `pattern:${patternKey}`);
  }

  // 3. Scan all patterns for matching geometry slides
  const patterns = templatePatterns.patterns || {};
  for (const [pk, pDef] of Object.entries(patterns)) {
    if (pk === patternKey) continue;
    const slides = Array.isArray(pDef?.templateSlides) ? pDef.templateSlides : [];
    const patternGeo = inferPatternGeometry(pk);
    if (requiredGeometry === GEOMETRY_TEXT || patternGeo === requiredGeometry) {
      for (const s of slides) addSlide(s, `cross-pattern:${pk}`);
    }
  }

  return chain;
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
// Hard fail error
// ---------------------------------------------------------------------------

class RouteGeometryError extends Error {
  constructor({ blockKey, targetSlide, expectedGeometry, actualGeometry, evidence }) {
    const msg = `[ROUTE GEOMETRY] Hard fail: block "${blockKey}" targeting slide ${targetSlide} requires ${expectedGeometry} geometry but slide has ${actualGeometry}. ${evidence || ''}`;
    super(msg);
    this.name = 'RouteGeometryError';
    this.blockKey = blockKey;
    this.targetSlide = targetSlide;
    this.expectedGeometry = expectedGeometry;
    this.actualGeometry = actualGeometry;
    this.evidence = evidence || '';
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
// Core enforcement
// ---------------------------------------------------------------------------

/**
 * enforce() — the main entry point.
 *
 * Call before rendering each block. Validates that the resolved route targets
 * a slide whose geometry is compatible with the content being rendered.
 *
 * @param {Object} opts
 * @param {string} opts.blockKey
 * @param {string} opts.dataType
 * @param {*}      opts.data
 * @param {*}      [opts.templateSelection]
 * @param {Set|Array} opts.tableContextKeys
 * @param {Set|Array} opts.chartContextKeys
 * @returns {Object} { resolved, layout, requiredGeometry, recovered, fromSlide, toSlide, reason, fallbackDepth, provenance }
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

  const tableSet = tableContextKeys instanceof Set ? tableContextKeys : new Set(tableContextKeys || []);
  const chartSet = chartContextKeys instanceof Set ? chartContextKeys : new Set(chartContextKeys || []);

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
    Number.isFinite(primarySlide) && primarySlide > 0
      ? getTemplateSlideLayout(primarySlide)
      : null;

  // Fast path: primary is fine
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
      fallbackDepth: 0,
      provenance: ['primary'],
    };
  }

  // Primary failed geometry check -> walk fallback chain
  const fallbackChain = buildFallbackChain(blockKey, requiredGeometry);
  const provenance = ['primary:FAIL'];

  for (let depth = 0; depth < fallbackChain.length; depth++) {
    const candidate = fallbackChain[depth];
    const layout = getTemplateSlideLayout(candidate.slideNumber);

    if (!layoutSatisfiesGeometry(layout, requiredGeometry)) {
      provenance.push(`${candidate.source}:slide${candidate.slideNumber}:FAIL`);
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
      fallbackDepth,
      provenance,
    };
  }

  // Hard fail: no valid route found
  _metrics.hardFailCount++;
  const actualGeometry = describeActualGeometry(primaryLayout);
  const evidence = `Fallback chain exhausted (${fallbackChain.length} candidates). Block pattern: ${primaryResolved?.patternKey || 'none'}, primary slide: ${primarySlide || 'none'}`;

  const failure = {
    blockKey,
    targetSlide: primarySlide || null,
    expectedGeometry: requiredGeometry,
    actualGeometry,
    evidence,
    fallbackChainLength: fallbackChain.length,
    provenance,
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
  getMetrics,
  getFailures,
  resetMetrics,
  auditAllRoutes,
  RouteGeometryError,
  // Internal maps re-exported for ppt-single-country.js integration
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
