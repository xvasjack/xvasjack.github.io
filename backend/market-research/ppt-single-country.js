const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');
const JSZip = require('jszip');

// Template images extracted from Escort template
const COVER_BG_B64 = fs
  .readFileSync(path.join(__dirname, 'assets/cover-bg.png'))
  .toString('base64');
const DIVIDER_BG_B64 = fs
  .readFileSync(path.join(__dirname, 'assets/divider-bg.png'))
  .toString('base64');
const LOGO_DARK_B64 = fs
  .readFileSync(path.join(__dirname, 'assets/logo-dark.png'))
  .toString('base64');
const LOGO_WHITE_B64 = fs
  .readFileSync(path.join(__dirname, 'assets/logo-white.png'))
  .toString('base64');

const {
  truncate,
  truncateSubtitle,
  fitTextToShape,
  safeArray,
  sanitizeHyperlinkUrl,
  ensureWebsite,
  isValidCompany,
  dedupeCompanies,
  enrichCompanyDesc,
  calculateColumnWidths,
  addSourceFootnote,
  addCalloutBox,
  addInsightsPanel,
  addOpportunitiesObstaclesSummary,
  addStackedBarChart,
  addLineChart,
  addBarChart,
  addPieChart,
  safeTableHeight,
  resolveTemplatePattern,
  getTemplateSlideLayout,
  addDualChart,
  addChevronFlow,
  addInsightPanelsFromPattern,
  addCalloutOverlay,
  addMatrix,
  addCaseStudyRows,
  addFinancialCharts,
  templatePatterns,
  addTocSlide,
  addSectionDivider,
  addOpportunitiesBarriersSlide,
  addHorizontalFlowTable,
  flattenPlayerProfile,
  C_WHITE,
  C_BLACK,
  C_BORDER,
  C_MUTED,
  C_LIGHT_GRAY,
  C_GRAY_BG,
  C_SECONDARY,
  TABLE_BORDER_WIDTH,
  C_BORDER_STYLE,
  C_TABLE_HEADER,
  C_CALLOUT_FILL,
  C_CALLOUT_BORDER,
  TABLE_CELL_MARGIN,
} = require('./ppt-utils');
const { ensureString: _ensureString } = require('./shared/utils');
const { validatePptData, blockHasRenderableData } = require('./quality-gates');
const {
  scanRelationshipTargets,
  scanPackageConsistency,
  normalizeSlideNonVisualIds,
  normalizeAbsoluteRelationshipTargets,
  extractAllText,
  reconcileContentTypesAndPackage,
} = require('./pptx-validator');
const { normalizeThemeToTemplate } = require('./theme-normalizer');
const { applyTemplateClonePostprocess } = require('./template-clone-postprocess');
const {
  isTransientKey,
  sanitizeTransientKeys,
  createSanitizationContext,
  logSanitizationResult,
} = require('./transient-key-sanitizer');
const {
  TABLE_TEMPLATE_CONTEXTS: _TABLE_TEMPLATE_CONTEXTS,
  CHART_TEMPLATE_CONTEXTS: _CHART_TEMPLATE_CONTEXTS,
  SECTION_DIVIDER_TEMPLATE_SLIDES: _SECTION_DIVIDER_TEMPLATE_SLIDES,
} = require('./template-contract-compiler');
const {
  scanDrift: scanHeaderFooterDrift,
  writeReport: writeHeaderFooterDriftReport,
} = require('./header-footer-drift-diagnostics');

const STRICT_TEMPLATE_FIDELITY = !/^(0|false|no|off)$/i.test(
  String(process.env.STRICT_TEMPLATE_FIDELITY || 'true').trim()
);
const RENDER_COMPACTION_MODE = String(process.env.RENDER_COMPACTION_MODE || 'bounded')
  .trim()
  .toLowerCase();
const TABLE_FLEX_MODE = String(process.env.TABLE_FLEX_MODE || 'bounded')
  .trim()
  .toLowerCase();

function envNumber(name, fallback, { min = null, max = null } = {}) {
  const raw = Number(process.env[name]);
  let value = Number.isFinite(raw) ? raw : fallback;
  if (Number.isFinite(min)) value = Math.max(min, value);
  if (Number.isFinite(max)) value = Math.min(max, value);
  return value;
}

const TABLE_FLEX_MAX_WIDTH_SCALE = envNumber('TABLE_FLEX_MAX_WIDTH_SCALE', 1.55, {
  min: 1,
  max: 1.6,
});
const TABLE_FLEX_MAX_HEIGHT_SCALE = envNumber('TABLE_FLEX_MAX_HEIGHT_SCALE', 1.5, {
  min: 1,
  max: 1.8,
});
const TABLE_FLEX_MIN_ROW_HEIGHT = envNumber('TABLE_FLEX_MIN_ROW_HEIGHT', 0.16, {
  min: 0.1,
  max: 0.28,
});
const TABLE_FLEX_MIN_COL_WIDTH = envNumber('TABLE_FLEX_MIN_COL_WIDTH', 0.58, {
  min: 0.35,
  max: 1.0,
});
const TABLE_FLEX_MAX_ROWS = envNumber('TABLE_FLEX_MAX_ROWS', 16, {
  min: 4,
  max: 40,
});
const TABLE_FLEX_MAX_COLS = envNumber('TABLE_FLEX_MAX_COLS', 9, {
  min: 3,
  max: 20,
});
const TABLE_VARIANT_MAX_WIDTH_DELTA = envNumber('TABLE_VARIANT_MAX_WIDTH_DELTA', 0.1, {
  min: 0.05,
  max: 0.3,
});
const TABLE_VARIANT_MAX_HEIGHT_DELTA = envNumber('TABLE_VARIANT_MAX_HEIGHT_DELTA', 0.12, {
  min: 0.05,
  max: 0.35,
});

// Typography standards requested by user.
const TITLE_FONT_PT = 20;
const MESSAGE_FONT_PT = 16;
const CONTENT_FONT_PT = 14;
const CONTENT_MIN_FONT_PT = 12;
const FOOTNOTE_FONT_PT = 10;
const TABLE_RETHINK_MAX_PASSES = envNumber('TABLE_RETHINK_MAX_PASSES', 2, {
  min: 1,
  max: 4,
});

// PPTX-safe ensureString: strips XML-invalid control characters after conversion.
// PPTX = ZIP of XML files. Characters \x00-\x08, \x0B, \x0C, \x0E-\x1F are invalid in
// XML 1.0 and cause "PowerPoint can't read this file" errors.
// eslint-disable-next-line no-control-regex
const XML_INVALID_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const PPT_TEXT_GLYPH_NORMALIZATIONS = [
  [/\u2013|\u2014|\u2212/g, '-'],
  [/\u2018|\u2019|\u2032/g, "'"],
  [/\u201C|\u201D|\u2033/g, '"'],
  [/\u2026/g, '...'],
  [/\u00A0/g, ' '],
  [/\u2192/g, '->'],
  [/\u2190/g, '<-'],
  [/\u2022/g, '- '],
  [/\u200B/g, ''],
  [/\u2028|\u2029/g, ' '],
];
function normalizePptTextGlyphs(value) {
  let text = String(value || '');
  for (const [pattern, replacement] of PPT_TEXT_GLYPH_NORMALIZATIONS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}
function stripInvalidSurrogates(value) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i] + value[i + 1];
        i++;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    out += value[i];
  }
  return out;
}
function ensureString(value, defaultValue) {
  const normalized = normalizePptTextGlyphs(_ensureString(value, defaultValue));
  return stripInvalidSurrogates(normalized.replace(XML_INVALID_CHARS, ''));
}

function getRequiredTemplateGeometry(blockKey, tableContextKeys, chartContextKeys) {
  const normalizedKey = ensureString(blockKey, '').trim();
  if (!normalizedKey) return null;
  const tableSet =
    tableContextKeys instanceof Set ? tableContextKeys : new Set(tableContextKeys || []);
  if (tableSet.has(normalizedKey)) return 'table';
  const chartSet =
    chartContextKeys instanceof Set ? chartContextKeys : new Set(chartContextKeys || []);
  if (chartSet.has(normalizedKey)) return 'chart';
  return null;
}

function layoutHasRequiredTemplateGeometry(layout, requiredGeometry) {
  if (!requiredGeometry) return true;
  if (!layout || typeof layout !== 'object') return false;
  if (requiredGeometry === 'table') return Boolean(layout.table);
  if (requiredGeometry === 'chart') return Array.isArray(layout.charts) && layout.charts.length > 0;
  return true;
}

function resolveTemplateRouteWithGeometryGuard({
  blockKey,
  dataType,
  data,
  templateSelection = null,
  tableContextKeys = [],
  chartContextKeys = [],
} = {}) {
  const requiredGeometry = getRequiredTemplateGeometry(
    blockKey,
    tableContextKeys,
    chartContextKeys
  );
  const baseInput = { blockKey, dataType, data };
  const primaryResolved = resolveTemplatePattern({
    ...baseInput,
    templateSelection,
  });
  const primarySlide = Number(primaryResolved?.selectedSlide);
  const primaryLayout =
    Number.isFinite(primarySlide) && primarySlide > 0 ? getTemplateSlideLayout(primarySlide) : null;

  if (layoutHasRequiredTemplateGeometry(primaryLayout, requiredGeometry)) {
    return {
      resolved: primaryResolved,
      layout: primaryLayout,
      requiredGeometry,
      recovered: false,
      fromSlide: primarySlide,
      toSlide: primarySlide,
      reason: null,
    };
  }

  const queue = [];
  const seen = new Set();
  const addCandidate = (route, reason) => {
    if (!route || typeof route !== 'object') return;
    const slide = Number(route.selectedSlide);
    if (!Number.isFinite(slide) || slide <= 0) return;
    const dedupeKey = `${ensureString(route.patternKey, '')}:${slide}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    queue.push({ route: { ...route, selectedSlide: slide }, reason: ensureString(reason, '') });
  };

  addCandidate(primaryResolved, 'primary');

  const hasExplicitOverride = !(
    templateSelection === null ||
    templateSelection === undefined ||
    (typeof templateSelection === 'string' && !templateSelection.trim())
  );
  let defaultResolved = null;
  if (hasExplicitOverride) {
    defaultResolved = resolveTemplatePattern({ ...baseInput, templateSelection: null });
    addCandidate(defaultResolved, 'default-route');
  }

  const primarySlides = Array.isArray(primaryResolved?.templateSlides)
    ? primaryResolved.templateSlides
    : [];
  for (const slideId of primarySlides) {
    const slide = Number(slideId);
    if (!Number.isFinite(slide) || slide <= 0) continue;
    addCandidate({ ...primaryResolved, selectedSlide: slide }, 'primary-pattern-scan');
  }

  const defaultSlides = Array.isArray(defaultResolved?.templateSlides)
    ? defaultResolved.templateSlides
    : [];
  for (const slideId of defaultSlides) {
    const slide = Number(slideId);
    if (!Number.isFinite(slide) || slide <= 0) continue;
    addCandidate({ ...defaultResolved, selectedSlide: slide }, 'default-pattern-scan');
  }

  for (const candidate of queue) {
    const layout = getTemplateSlideLayout(candidate.route.selectedSlide);
    if (!layoutHasRequiredTemplateGeometry(layout, requiredGeometry)) continue;
    if (candidate.route.selectedSlide === primarySlide) {
      return {
        resolved: candidate.route,
        layout,
        requiredGeometry,
        recovered: false,
        fromSlide: primarySlide,
        toSlide: primarySlide,
        reason: candidate.reason || null,
      };
    }
    return {
      resolved: {
        ...candidate.route,
        source: 'geometryRecovery',
      },
      layout,
      requiredGeometry,
      recovered: true,
      fromSlide: primarySlide,
      toSlide: candidate.route.selectedSlide,
      reason: candidate.reason || null,
    };
  }

  return {
    resolved: primaryResolved,
    layout: primaryLayout,
    requiredGeometry,
    recovered: false,
    fromSlide: primarySlide,
    toSlide: null,
    reason: null,
  };
}

// Safety wrapper: ensure any value going into a table cell is a plain, XML-safe string.
// AI sometimes returns nested objects/arrays — this prevents pptxgenjs crashes.
// XML sanitization happens in ensureString() above.
function safeCell(value, maxLen) {
  const str = ensureString(value).replace(/\s+/g, ' ').trim();
  if (!str) return '';
  const hardCap = 3000;
  if (str.length > hardCap) {
    console.warn(
      `[PPT-SIZE-OVERFLOW] Cell text exceeds hard cap (${str.length} > ${hardCap}). Truncating to ${hardCap} chars instead of crashing.`
    );
    // Inline truncation — bypass DISABLE_TEXT_TRUNCATION since this is a safety cap, not content preference.
    const cut = str.substring(0, hardCap);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > hardCap * 0.8 ? cut.substring(0, lastSpace) : cut).trim() + '...';
  }
  const requestedLimit = Number(maxLen);
  let effectiveLimit = hardCap;
  if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
    const rounded = Math.max(16, Math.min(Math.round(requestedLimit), hardCap));
    // Treat tiny per-field caps as hints, not hard clipping limits. Hard clipping at 15-40 chars
    // caused pervasive visible truncation ("...") in final decks.
    if (rounded <= 40) effectiveLimit = 220;
    else if (rounded <= 80) effectiveLimit = 300;
    else if (rounded <= 120) effectiveLimit = 360;
    else if (rounded <= 260) effectiveLimit = 600;
    else effectiveLimit = rounded;
  }
  if (str.length <= effectiveLimit) return str;
  if (STRICT_TEMPLATE_FIDELITY) {
    // Preserve full text in strict mode; downstream gates should block unrenderable layouts.
    return str;
  }
  return truncate(str, effectiveLimit, true);
}

function limitWords(text, maxWords) {
  const cleaned = ensureString(text).replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length <= maxWords) return cleaned;
  return `${words.slice(0, maxWords).join(' ')}...`;
}

function getRenderTextLimit(pathKey) {
  if (RENDER_COMPACTION_MODE === 'off') return Number.POSITIVE_INFINITY;
  const key = ensureString(pathKey).toLowerCase();
  if (!key) return RENDER_COMPACTION_MODE === 'legacy' ? 900 : 1400;
  if (key === 'url' || key === 'website') return 2048;
  if (key.includes('slidetitle')) return RENDER_COMPACTION_MODE === 'legacy' ? 180 : 320;
  if (key.includes('subtitle')) return RENDER_COMPACTION_MODE === 'legacy' ? 420 : 700;
  if (key.includes('description') || key.includes('strategicassessment'))
    return RENDER_COMPACTION_MODE === 'legacy' ? 520 : 900;
  if (key.includes('requirements') || key.includes('penalties') || key.includes('enforcement'))
    return RENDER_COMPACTION_MODE === 'legacy' ? 420 : 720;
  if (
    key.includes('overview') ||
    key.includes('narrative') ||
    key.includes('riskjustification') ||
    key.includes('windowofopportunity')
  ) {
    return RENDER_COMPACTION_MODE === 'legacy' ? 620 : 1200;
  }
  if (
    key.includes('keyinsight') ||
    key.includes('recommendation') ||
    key.includes('applicability') ||
    key.includes('gotomarketapproach') ||
    key.includes('keymessage')
  ) {
    return RENDER_COMPACTION_MODE === 'legacy' ? 900 : 1500;
  }
  if (
    key.includes('details') ||
    key.includes('rationale') ||
    key.includes('implication') ||
    key.includes('timing')
  ) {
    return RENDER_COMPACTION_MODE === 'legacy' ? 520 : 1000;
  }
  return RENDER_COMPACTION_MODE === 'legacy' ? 900 : 1400;
}

function getRenderArrayLimit(pathKey) {
  if (RENDER_COMPACTION_MODE === 'off') return Number.POSITIVE_INFINITY;
  const key = ensureString(pathKey).toLowerCase();
  const isLegacy = RENDER_COMPACTION_MODE === 'legacy';
  if (!key) return isLegacy ? 8 : 14;
  if (key === 'sources') return isLegacy ? 8 : 12;
  if (key === 'keymetrics') return isLegacy ? 8 : 12;
  if (
    [
      'players',
      'partners',
      'segments',
      'toptargets',
      'recentdeals',
      'potentialtargets',
      'phases',
      'triggers',
      'criteria',
      'opportunities',
      'obstacles',
      'keyinsights',
      'activities',
      'milestones',
      'failures',
      'successfactors',
      'warningsignstowatch',
    ].includes(key)
  ) {
    return isLegacy ? 5 : 10;
  }
  return isLegacy ? 8 : 14;
}

function compactRenderString(pathKey, value) {
  const str = ensureString(value).replace(/\s+/g, ' ').trim();
  if (!str) return '';
  const limit = getRenderTextLimit(pathKey);
  if (str.length <= limit) return str;
  return truncate(str, limit, true);
}

function compactRenderPayload(node, path = []) {
  if (node == null) return node;
  const pathKey = ensureString(path[path.length - 1] || '');

  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return compactRenderString(pathKey, node);
  }

  if (Array.isArray(node)) {
    // Preserve chart series/categories payload exactly; trimming those distorts charts.
    if (path.includes('chartData')) return node;
    const maxItems = getRenderArrayLimit(pathKey);
    if (!Number.isFinite(maxItems) || maxItems >= node.length) {
      return node.map((item, idx) => compactRenderPayload(item, [...path, idx]));
    }
    return node.slice(0, maxItems).map((item, idx) => compactRenderPayload(item, [...path, idx]));
  }

  if (typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = compactRenderPayload(v, [...path, k]);
    }
    return out;
  }

  return node;
}

// Render-time transient key detection delegated to ./transient-key-sanitizer.js (canonical module).

const MARKET_CANONICAL_ALIAS_MAP = {
  marketSizeAndGrowth: ['marketSizeAndGrowth', 'market_size_and_growth'],
  supplyAndDemandDynamics: [
    'supplyAndDemandDynamics',
    'supplyAndDemandData',
    'supply_and_demand_dynamics',
    'supply_and_demand_data',
  ],
  pricingAndTariffStructures: [
    'pricingAndTariffStructures',
    'pricingAndEconomics',
    'pricingAndCostBenchmarks',
    'pricing_and_tariff_structures',
    'pricing_and_economics',
    'pricing_and_cost_benchmarks',
  ],
};

const MARKET_LEGACY_KEYS = [
  'tpes',
  'finalDemand',
  'electricity',
  'gasLng',
  'pricing',
  'escoMarket',
];

const MARKET_RENDER_ALLOWED_KEYS = new Set([
  ...Object.keys(MARKET_CANONICAL_ALIAS_MAP),
  ...MARKET_LEGACY_KEYS,
  'sources',
]);

const POLICY_ALIAS_MAP = {
  foundationalActs: [
    'foundationalActs',
    'regulatoryFramework',
    'regulatoryFrameworkAndLicensing',
    'regulatory_framework_and_licensing',
  ],
  nationalPolicy: [
    'nationalPolicy',
    'energyMasterPlan',
    'energyTransitionPolicy',
    'energy_master_plan_and_decarbonization',
  ],
  investmentRestrictions: [
    'investmentRestrictions',
    'foreignOwnership',
    'foreignOwnershipAndInvestmentLaws',
    'foreign_ownership_and_investment_laws',
    'localContentRequirements',
    'local_content_requirements',
  ],
  keyIncentives: ['keyIncentives', 'investmentIncentives', 'incentives'],
  regulatorySummary: ['regulatorySummary', 'regulationSummary'],
  sources: ['sources'],
};

const COMPETITOR_ALIAS_MAP = {
  japanesePlayers: ['japanesePlayers', 'japanesePlayer', 'japanPlayers'],
  localMajor: ['localMajor', 'majorPlayers', 'localPlayers'],
  foreignPlayers: ['foreignPlayers', 'internationalPlayers'],
  caseStudy: ['caseStudy', 'entryCaseStudy'],
  maActivity: ['maActivity', 'mnaActivity', 'maAndJv'],
};

const DEPTH_ALIAS_MAP = {
  dealEconomics: ['dealEconomics', 'businessModelAndEconomics', 'business_model_and_economics'],
  partnerAssessment: ['partnerAssessment', 'partners'],
  entryStrategy: ['entryStrategy'],
  implementation: ['implementation', 'implementationRoadmap'],
  targetSegments: ['targetSegments'],
};
// Production safety guard: never allow transient/non-template sections to reach renderer.
const STRICT_RENDER_NORMALIZATION = true;

// sanitizeRenderPayload replaced by sanitizeTransientKeys from canonical module.
function sanitizeRenderPayload(value) {
  return sanitizeTransientKeys(value);
}

function selectFirstAliasValue(input, aliases) {
  if (!input || typeof input !== 'object') return null;
  for (const alias of aliases) {
    if (!Object.prototype.hasOwnProperty.call(input, alias)) continue;
    const value = input[alias];
    if (value == null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return { alias, value };
  }
  return null;
}

function normalizeByAliasMap(rawSection, aliasMap, options = {}) {
  const cleaned = sanitizeRenderPayload(rawSection);
  if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned)) {
    return { data: {}, droppedKeys: [] };
  }

  const output = {};
  const consumed = new Set();
  for (const [canonicalKey, aliases] of Object.entries(aliasMap || {})) {
    const match = selectFirstAliasValue(cleaned, aliases);
    if (!match) continue;
    output[canonicalKey] = match.value;
    consumed.add(match.alias);
    if (match.alias !== canonicalKey) consumed.add(canonicalKey);
  }

  for (const key of options.passThroughKeys || []) {
    if (Object.prototype.hasOwnProperty.call(cleaned, key)) {
      output[key] = cleaned[key];
      consumed.add(key);
    }
  }

  const droppedKeys = Object.keys(cleaned).filter((key) => !consumed.has(key));
  return { data: output, droppedKeys };
}

function normalizeMarketForRender(rawSection) {
  const cleaned = sanitizeRenderPayload(rawSection);
  if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned)) {
    return { data: {}, droppedKeys: [] };
  }

  const output = {};
  const consumed = new Set();

  for (const [canonicalKey, aliases] of Object.entries(MARKET_CANONICAL_ALIAS_MAP)) {
    const match = selectFirstAliasValue(cleaned, aliases);
    if (!match) continue;
    output[canonicalKey] = match.value;
    consumed.add(match.alias);
    if (match.alias !== canonicalKey) consumed.add(canonicalKey);
  }

  // Backward compatibility: preserve legacy market blocks when canonical sections
  // are absent, so strict render normalization does not reject otherwise valid
  // historical payloads used by local fixtures/replays.
  if (Object.keys(output).length === 0) {
    for (const key of MARKET_LEGACY_KEYS) {
      const value = cleaned[key];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      output[key] = value;
      consumed.add(key);
    }
  }

  if (Array.isArray(cleaned.sources) && cleaned.sources.length > 0) {
    output.sources = cleaned.sources;
    consumed.add('sources');
  }

  const droppedKeys = Object.keys(cleaned).filter((key) => !consumed.has(key));
  return { data: output, droppedKeys };
}

function humanizeKeyLabel(key) {
  return ensureString(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeRegulatorySummaryRows(raw) {
  const rows = [];
  const pushRow = (entry, fallbackLabel = '') => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const label = ensureString(entry.label || entry.domain || fallbackLabel);
    const currentState = ensureString(entry.currentState || entry.current || entry.asIs || '');
    const transition = ensureString(entry.transition || entry.change || entry.shift || '');
    const futureState = ensureString(entry.futureState || entry.targetState || entry.toBe || '');
    if (!label && !currentState && !transition && !futureState) return;
    rows.push({ label, currentState, transition, futureState });
  };

  if (Array.isArray(raw)) {
    raw.forEach((entry) => pushRow(entry));
    return rows;
  }
  if (!raw || typeof raw !== 'object') return rows;

  if (Array.isArray(raw.items)) {
    raw.items.forEach((entry) => pushRow(entry));
  }

  pushRow(raw);

  for (const [key, value] of Object.entries(raw)) {
    if (String(key).startsWith('_')) continue;
    if (key === 'items') continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      pushRow(value, humanizeKeyLabel(key));
      continue;
    }
    if (typeof value === 'string' && value.trim()) {
      pushRow(
        {
          label: humanizeKeyLabel(key),
          currentState: value,
        },
        humanizeKeyLabel(key)
      );
    }
  }

  return rows;
}

function collectPackageConsistencyIssues(packageConsistency) {
  const packageIssues = [];
  if (packageConsistency.missingCriticalParts.length > 0) {
    packageIssues.push(
      `missing critical parts: ${packageConsistency.missingCriticalParts.join(', ')}`
    );
  }
  if (packageConsistency.duplicateRelationshipIds.length > 0) {
    const dup = packageConsistency.duplicateRelationshipIds
      .slice(0, 5)
      .map((x) => `${x.relFile}:${x.relId}`)
      .join(', ');
    packageIssues.push(`duplicate relationship ids: ${dup}`);
  }
  if (packageConsistency.duplicateSlideIds.length > 0) {
    packageIssues.push(
      `duplicate slide ids: ${packageConsistency.duplicateSlideIds.slice(0, 5).join(', ')}`
    );
  }
  if (packageConsistency.duplicateSlideRelIds.length > 0) {
    packageIssues.push(
      `duplicate slide rel ids: ${packageConsistency.duplicateSlideRelIds.slice(0, 5).join(', ')}`
    );
  }
  if (
    Array.isArray(packageConsistency.missingRelationshipReferences) &&
    packageConsistency.missingRelationshipReferences.length > 0
  ) {
    const preview = packageConsistency.missingRelationshipReferences
      .slice(0, 5)
      .map((x) => `${x.ownerPart}:${x.relId}`)
      .join(', ');
    packageIssues.push(`dangling xml relationship refs: ${preview}`);
  }
  if (
    Array.isArray(packageConsistency.duplicateNonVisualShapeIds) &&
    packageConsistency.duplicateNonVisualShapeIds.length > 0
  ) {
    const dupShapePreview = packageConsistency.duplicateNonVisualShapeIds
      .slice(0, 5)
      .map((x) => `${x.slide}:id=${x.id}(x${x.count})`)
      .join(', ');
    packageIssues.push(`duplicate non-visual shape ids: ${dupShapePreview}`);
  }
  if (packageConsistency.danglingOverrides.length > 0) {
    packageIssues.push(
      `dangling overrides: ${packageConsistency.danglingOverrides.slice(0, 5).join(', ')}`
    );
  }
  if (packageConsistency.missingSlideOverrides.length > 0) {
    packageIssues.push(
      `missing slide overrides: ${packageConsistency.missingSlideOverrides.slice(0, 5).join(', ')}`
    );
  }
  if (packageConsistency.missingChartOverrides.length > 0) {
    packageIssues.push(
      `missing chart overrides: ${packageConsistency.missingChartOverrides.slice(0, 5).join(', ')}`
    );
  }
  if (
    Array.isArray(packageConsistency.missingExpectedOverrides) &&
    packageConsistency.missingExpectedOverrides.length > 0
  ) {
    const missingExpectedPreview = packageConsistency.missingExpectedOverrides
      .slice(0, 5)
      .map((x) =>
        x && typeof x === 'object'
          ? `${x.part || '(unknown)'}${x.expectedContentType ? `->${x.expectedContentType}` : ''}`
          : String(x)
      )
      .join(', ');
    packageIssues.push(`missing expected overrides: ${missingExpectedPreview}`);
  }
  if (
    Array.isArray(packageConsistency.contentTypeMismatches) &&
    packageConsistency.contentTypeMismatches.length > 0
  ) {
    const mismatchPreview = packageConsistency.contentTypeMismatches
      .slice(0, 5)
      .map(
        (x) =>
          `${x.part}:${x.contentType || '(empty)'}${x.expectedContentType ? `=>${x.expectedContentType}` : ''}`
      )
      .join(', ');
    packageIssues.push(`content type mismatches: ${mismatchPreview}`);
  }
  return packageIssues;
}

// PptxGenJS can emit absolute relationship targets (/ppt/...).
// Rewrite them to owner-relative paths to maximize PowerPoint compatibility.
async function normalizeChartRelationshipTargets(pptxBuffer) {
  if (!Buffer.isBuffer(pptxBuffer) || pptxBuffer.length === 0) return pptxBuffer;
  const zip = await JSZip.loadAsync(pptxBuffer);
  const relFiles = Object.keys(zip.files).filter((name) => /\.rels$/i.test(name));
  let mutatedTargets = 0;

  const ownerPartFromRel = (relFile) => {
    const normalized = ensureString(relFile);
    if (normalized === '_rels/.rels') return '';
    const m = normalized.match(/^(.*)\/_rels\/([^/]+)\.rels$/);
    if (!m) return '';
    const baseDir = m[1];
    const ownerPart = m[2];
    return baseDir ? `${baseDir}/${ownerPart}` : ownerPart;
  };

  for (const relFile of relFiles) {
    const relEntry = zip.file(relFile);
    if (!relEntry) continue;
    const xml = await relEntry.async('string');
    const ownerPart = ownerPartFromRel(relFile);
    const ownerDir = ownerPart ? path.posix.dirname(ownerPart) : '';
    const nextXml = xml.replace(/Target=(["'])\/ppt\/([^"']+)\1/g, (full, quote, absolutePath) => {
      const packageTarget = `ppt/${absolutePath}`;
      const relative = ownerDir ? path.posix.relative(ownerDir, packageTarget) : packageTarget;
      const normalized = ensureString(relative).replace(/\\/g, '/');
      if (!normalized) return full;
      mutatedTargets++;
      return `Target=${quote}${normalized}${quote}`;
    });
    if (nextXml !== xml) {
      zip.file(relFile, nextXml);
    }
  }

  if (mutatedTargets === 0) return pptxBuffer;
  console.log(
    `[PPT] Normalized ${mutatedTargets} absolute relationship target(s) to relative paths`
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Deep formatting audit against extracted template metadata.
// This catches silent regressions (slide size drift, runaway margins, line geometry drift)
// before a deck is shipped.
async function auditGeneratedPptFormatting(pptxBuffer, { strictMode = false } = {}) {
  const issues = [];
  const checks = {};

  try {
    const zip = await JSZip.loadAsync(pptxBuffer);
    const expectedW = Number(templatePatterns.style?.slideWidthEmu || 12192000);
    const expectedH = Number(templatePatterns.style?.slideHeightEmu || 6858000);

    const presentationXml = await zip.file('ppt/presentation.xml')?.async('string');
    if (!presentationXml) {
      issues.push({
        severity: 'critical',
        code: 'missing_presentation_xml',
        message: 'ppt/presentation.xml not found in generated deck',
      });
    } else {
      const sz = presentationXml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
      if (sz) {
        const w = Number(sz[1]);
        const h = Number(sz[2]);
        const dw = Math.abs(w - expectedW);
        const dh = Math.abs(h - expectedH);
        checks.slideSize = { widthEmu: w, heightEmu: h, deltaWidthEmu: dw, deltaHeightEmu: dh };
        if (dw > 1200 || dh > 1200) {
          issues.push({
            severity: 'critical',
            code: 'slide_size_mismatch',
            message: `Slide size drift too large: got ${w}x${h}, expected ${expectedW}x${expectedH}`,
          });
        }
      } else {
        issues.push({
          severity: 'critical',
          code: 'slide_size_missing',
          message: 'Unable to parse <p:sldSz> in presentation.xml',
        });
      }
    }

    // Derive expected line widths from template contract (1 pt = 12700 EMU).
    const EMU_PER_PT = 12700;
    const expectedLineWidthsEmu = [...(templatePatterns.style?.expectedLineWidthsEmu || [])];
    // If template-patterns.json does not have an explicit list, compute from
    // the header/footer thickness values in the contract.
    if (expectedLineWidthsEmu.length === 0) {
      const thicknesses = [
        templatePatterns.style?.headerLines?.top?.thickness,
        templatePatterns.style?.headerLines?.bottom?.thickness,
        templatePatterns.pptxPositions?.footerLine?.thickness,
      ].filter((v) => Number.isFinite(Number(v)));
      for (const pt of thicknesses) {
        const emu = Math.round(Number(pt) * EMU_PER_PT);
        if (emu > 0 && !expectedLineWidthsEmu.includes(emu)) {
          expectedLineWidthsEmu.push(emu);
        }
      }
    }
    expectedLineWidthsEmu.sort((a, b) => a - b);

    // Collect line widths from ALL slide layouts AND slide masters.
    // The Escort template carries header/footer connector lines in slideLayout1
    // and slide masters, NOT in slideLayout3. Searching only slideLayout3 was
    // the root cause of the false-positive line_width_signature_mismatch warning.
    const allLineWidths = new Set();
    const lineGeometryXmlSources = [];

    const layoutAndMasterFiles = Object.keys(zip.files).filter(
      (name) =>
        /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name) ||
        /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)
    );

    let primaryLineGeometryXml = null;
    for (const partName of layoutAndMasterFiles) {
      const partEntry = zip.file(partName);
      if (!partEntry) continue;
      const partXml = await partEntry.async('string');
      const widths = [...partXml.matchAll(/<a:ln w="(\d+)"/g)].map((m) => Number(m[1]));
      for (const w of widths) allLineWidths.add(w);
      if (widths.length > 0) {
        lineGeometryXmlSources.push(partName);
        // Prefer the first layout/master that contains line geometry for Y-position checks
        if (!primaryLineGeometryXml) primaryLineGeometryXml = partXml;
      }
    }

    checks.lineGeometrySources = lineGeometryXmlSources;
    checks.headerFooterLineWidths = [...allLineWidths].sort((a, b) => a - b);

    // Y-position drift checks use the first layout/master that has line geometry
    if (primaryLineGeometryXml) {
      const expectedTopY = Math.round(
        Number(templatePatterns.style?.headerLines?.top?.y || 1.0208) * 914400
      );
      const expectedBottomY = Math.round(
        Number(templatePatterns.style?.headerLines?.bottom?.y || 1.0972) * 914400
      );
      const expectedFooterY = Math.round(
        Number(templatePatterns.pptxPositions?.footerLine?.y || 7.2361) * 914400
      );
      const yMatches = [...primaryLineGeometryXml.matchAll(/<a:off x="0" y="(\d+)"/g)].map((m) =>
        Number(m[1])
      );
      const nearest = (target) => {
        if (!yMatches.length) return null;
        let best = yMatches[0];
        let delta = Math.abs(best - target);
        for (const y of yMatches.slice(1)) {
          const d = Math.abs(y - target);
          if (d < delta) {
            best = y;
            delta = d;
          }
        }
        return { y: best, delta };
      };

      const top = nearest(expectedTopY);
      const bottom = nearest(expectedBottomY);
      const footer = nearest(expectedFooterY);
      checks.headerFooterY = {
        expected: { top: expectedTopY, bottom: expectedBottomY, footer: expectedFooterY },
        actual: { top: top?.y || null, bottom: bottom?.y || null, footer: footer?.y || null },
        delta: {
          top: top?.delta || null,
          bottom: bottom?.delta || null,
          footer: footer?.delta || null,
        },
      };

      if ((top?.delta || 0) > 2500 || (bottom?.delta || 0) > 2500 || (footer?.delta || 0) > 2500) {
        const layoutDriftDetails = [];
        if (top?.delta > 500) {
          layoutDriftDetails.push({
            role: 'header_top',
            expectedY: expectedTopY,
            actualY: top.y,
            deltaEmu: top.delta,
            severity: top.delta > 2500 ? 'error' : 'warning',
          });
        }
        if (bottom?.delta > 500) {
          layoutDriftDetails.push({
            role: 'header_bottom',
            expectedY: expectedBottomY,
            actualY: bottom.y,
            deltaEmu: bottom.delta,
            severity: bottom.delta > 2500 ? 'error' : 'warning',
          });
        }
        if (footer?.delta > 500) {
          layoutDriftDetails.push({
            role: 'footer',
            expectedY: expectedFooterY,
            actualY: footer.y,
            deltaEmu: footer.delta,
            severity: footer.delta > 2500 ? 'error' : 'warning',
          });
        }
        const blockingSeverity = layoutDriftDetails.some((d) => d.severity === 'error')
          ? 'error'
          : 'warning';
        issues.push({
          severity: blockingSeverity === 'error' ? 'critical' : 'warning',
          code: 'header_footer_line_drift',
          message: `Header/footer line drift detected (delta EMU: top=${top?.delta}, bottom=${bottom?.delta}, footer=${footer?.delta})`,
          slideKey: '_layout',
          slideNumber: 0,
          details: layoutDriftDetails,
        });
      }
    } else if (lineGeometryXmlSources.length === 0) {
      // No layouts or masters had any line geometry at all
      issues.push({
        severity: 'warning',
        code: 'missing_line_geometry',
        message:
          'No slide layouts or slide masters contain line geometry; skipping Y-position audit',
      });
    }

    // Line-width signature check: verify expected widths from template contract
    // are present SOMEWHERE across layouts/masters.
    if (expectedLineWidthsEmu.length > 0) {
      const missingWidths = expectedLineWidthsEmu.filter((emu) => !allLineWidths.has(emu));
      if (missingWidths.length > 0) {
        const blockingSlideKeys =
          lineGeometryXmlSources.length > 0
            ? lineGeometryXmlSources.join(', ')
            : '(no line geometry sources found)';
        const severity = strictMode ? 'critical' : 'warning';
        issues.push({
          severity,
          code: 'line_width_signature_mismatch',
          message:
            `Expected header/footer line thickness signature (${expectedLineWidthsEmu.join(', ')} EMU) not fully present. ` +
            `Missing: ${missingWidths.join(', ')} EMU. ` +
            `Searched: ${lineGeometryXmlSources.length} layout/master file(s). ` +
            `Found widths: [${[...allLineWidths].sort((a, b) => a - b).join(', ')}]. ` +
            (strictMode ? `Blocking slide keys: ${blockingSlideKeys}` : ''),
          slideKey: '_line_width',
          ...(strictMode ? { blockingSlideKeys } : {}),
        });
      }
    }

    const expectedMarginEmu = Math.round(
      Number(templatePatterns.style?.table?.cellMarginLR || 0.04) * 914400
    );
    const runawayMarginThresholdEmu = Math.max(expectedMarginEmu * 20, 1200000);
    const slideXmlEntries = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name)
    );
    const marginValues = [];
    const marginOutliers = [];
    const anchorCounts = { ctr: 0, t: 0, b: 0, other: 0 };
    const borderWidths = [];
    const longTextRuns = [];
    const longTableCells = [];
    const LONG_TEXT_RUN_WARNING_LEN = 900;
    // Calibrated against Escort template baseline where valid table cells can exceed 500 chars.
    const LONG_TABLE_CELL_WARNING_LEN = 620;

    for (const name of slideXmlEntries) {
      const xml = await zip.file(name)?.async('string');
      if (!xml) continue;

      // Detect likely formatting overflow: very long text in one shape tends to produce
      // unreadable slides and visible corruption after PowerPoint auto-repair.
      for (const tm of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) {
        const text = ensureString(tm[1] || '');
        if (text.length > LONG_TEXT_RUN_WARNING_LEN) {
          longTextRuns.push({
            slide: name.replace(/^ppt\/slides\//, ''),
            length: text.length,
          });
        }
      }

      for (const cm of xml.matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)) {
        const cellXml = cm[0] || '';
        const cellText = [...cellXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
          .map((m) => ensureString(m[1] || ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (cellText.length > LONG_TABLE_CELL_WARNING_LEN) {
          longTableCells.push({
            slide: name.replace(/^ppt\/slides\//, ''),
            length: cellText.length,
          });
        }
      }

      if (!xml.includes('<a:tcPr')) continue;

      const tcProps = [...xml.matchAll(/<a:tcPr([^>]*)>/g)];
      for (const m of tcProps) {
        const attrs = m[1] || '';
        const marL = attrs.match(/marL="(\d+)"/);
        const marR = attrs.match(/marR="(\d+)"/);
        if (marL) {
          const value = Number(marL[1]);
          marginValues.push(value);
          if (value > runawayMarginThresholdEmu) {
            marginOutliers.push({
              slide: name.replace(/^ppt\/slides\//, ''),
              side: 'L',
              value,
            });
          }
        }
        if (marR) {
          const value = Number(marR[1]);
          marginValues.push(value);
          if (value > runawayMarginThresholdEmu) {
            marginOutliers.push({
              slide: name.replace(/^ppt\/slides\//, ''),
              side: 'R',
              value,
            });
          }
        }
        const anchor = attrs.match(/anchor="([^"]+)"/)?.[1];
        if (anchor === 'ctr') anchorCounts.ctr++;
        else if (anchor === 't') anchorCounts.t++;
        else if (anchor === 'b') anchorCounts.b++;
        else anchorCounts.other++;
      }

      for (const bm of xml.matchAll(/<a:ln[LRBT] w="(\d+)"/g)) {
        borderWidths.push(Number(bm[1]));
      }
    }

    if (marginValues.length > 0) {
      const maxMargin = Math.max(...marginValues);
      const nearExpected = marginValues.filter(
        (v) => Math.abs(v - expectedMarginEmu) <= 1000
      ).length;
      const nearExpectedRatio = nearExpected / marginValues.length;
      checks.tableMargins = {
        expectedMarginEmu,
        runawayThresholdEmu: runawayMarginThresholdEmu,
        minMarginEmu: Math.min(...marginValues),
        maxMarginEmu: maxMargin,
        nearExpectedRatio: Number(nearExpectedRatio.toFixed(3)),
        outlierCount: marginOutliers.length,
      };
      if (marginOutliers.length > 0) {
        checks.tableMarginOutliers = marginOutliers.slice(0, 20);
      }

      if (maxMargin > runawayMarginThresholdEmu) {
        const affectedSlides = [...new Set(marginOutliers.map((m) => m.slide))].slice(0, 8);
        issues.push({
          severity: 'critical',
          code: 'table_margin_runaway',
          message: `Runaway table margin detected (max mar*= ${maxMargin} EMU, outliers=${marginOutliers.length}, slides=${affectedSlides.join(', ') || 'unknown'})`,
        });
      } else if (nearExpectedRatio < 0.8) {
        issues.push({
          severity: 'warning',
          code: 'table_margin_drift',
          message: `Table margins drift from template baseline (near-expected ratio=${nearExpectedRatio.toFixed(2)})`,
        });
      }
    }

    const totalAnchors = anchorCounts.ctr + anchorCounts.t + anchorCounts.b + anchorCounts.other;
    checks.tableAnchors = { ...anchorCounts, total: totalAnchors };
    if (totalAnchors > 0) {
      const topRatio = anchorCounts.t / totalAnchors;
      if (topRatio > 0.85) {
        issues.push({
          severity: 'warning',
          code: 'table_anchor_top_heavy',
          message: `Most table cells are top-anchored (ratio=${topRatio.toFixed(2)}); template is typically center-anchored`,
        });
      }
    }

    if (borderWidths.length > 0) {
      const uniqueBorderWidths = [...new Set(borderWidths)].sort((a, b) => a - b);
      checks.tableBorderWidths = uniqueBorderWidths;
      if (!uniqueBorderWidths.includes(38100)) {
        issues.push({
          severity: 'warning',
          code: 'table_outer_border_missing',
          message: 'No 3pt (38100 EMU) table borders detected; template usually includes them',
        });
      }
    }

    checks.longTextRuns = longTextRuns.slice(0, 20);
    checks.longTableCells = longTableCells.slice(0, 20);
    if (longTextRuns.length > 0) {
      const examples = longTextRuns
        .slice(0, 6)
        .map((x) => `${x.slide}:${x.length}`)
        .join(', ');
      issues.push({
        severity: 'warning',
        code: 'long_text_run_density',
        message: `Very long text runs detected (len>${LONG_TEXT_RUN_WARNING_LEN} chars), e.g. ${examples}`,
      });
    }
    if (longTableCells.length > 0) {
      const examples = longTableCells
        .slice(0, 6)
        .map((x) => `${x.slide}:${x.length}`)
        .join(', ');
      issues.push({
        severity: 'warning',
        code: 'long_table_cell_density',
        message: `Overly long table cells detected (len>${LONG_TABLE_CELL_WARNING_LEN} chars), e.g. ${examples}`,
      });
    }

    // Per-slide header/footer drift scan using dedicated diagnostics module
    try {
      const driftReport = await scanHeaderFooterDrift(pptxBuffer);
      checks.headerFooterDrift = driftReport;

      if (driftReport.summary && !driftReport.summary.pass) {
        const blockingKeys = driftReport.blockingSlideKeys || [];
        const blockingNumbers = driftReport.blockingSlideNumbers || [];
        for (const entry of (driftReport.slides || []).filter((s) => s.hasBlockingDrift)) {
          for (const drift of entry.driftEntries.filter((d) => d.severity === 'error')) {
            issues.push({
              severity: 'critical',
              code: 'header_footer_line_drift_per_slide',
              slideKey: drift.slideKey || entry.slideKey || `slide${entry.slideNumber}`,
              slideNumber: entry.slideNumber,
              message: `Slide ${entry.slideNumber} (${drift.slideKey || entry.slideKey || 'unknown'}): ${drift.role} line drift ${drift.delta.yEmu} EMU (expected y=${drift.expected.y}, actual y=${drift.actual.y})`,
              details: drift,
            });
          }
        }
        if (blockingKeys.length > 0) {
          console.error(
            `[PPT TEMPLATE] Header/footer drift: ${blockingKeys.length} blocking slide(s): ${blockingKeys.slice(0, 10).join(', ')}`
          );
        }
      }

      // Write drift report to disk for diagnostics
      try {
        writeHeaderFooterDriftReport(driftReport);
      } catch (writeErr) {
        console.warn(`[PPT TEMPLATE] Failed to write drift report: ${writeErr.message}`);
      }
    } catch (driftErr) {
      console.warn(`[PPT TEMPLATE] Per-slide drift scan failed: ${driftErr.message}`);
    }
  } catch (err) {
    issues.push({
      severity: 'critical',
      code: 'format_audit_exception',
      message: `Formatting audit failed: ${err.message}`,
    });
  }

  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  return {
    pass: criticalCount === 0,
    criticalCount,
    warningCount,
    issues,
    checks,
  };
}

/**
 * Compute a 0-100 fit score predicting how well rows will render in expectedRect.
 * Used to choose fallback rendering strategy before attempting table render.
 * Module-level so it can be exported via __test for regression testing.
 */
function computeTableFitScore(rows, expectedRect) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      score: 100,
      breakdown: { rowScore: 100, colScore: 100, densityScore: 100, geometryScore: 100 },
      recommendation: 'standard',
    };
  }
  const rowCount = rows.length;
  let colCount = 0;
  for (let i = 0; i < rows.length; i++) {
    if (Array.isArray(rows[i]) && rows[i].length > colCount) colCount = rows[i].length;
  }
  const rectH = Number(expectedRect?.h) || 3.5;
  const rectW = Number(expectedRect?.w) || 8.5;
  const rowHeight = rowCount > 0 ? rectH / rowCount : rectH;
  const colWidth = colCount > 0 ? rectW / colCount : rectW;

  let rowScore = 100;
  if (rowCount > TABLE_FLEX_MAX_ROWS) {
    rowScore = Math.max(0, 100 - (rowCount - TABLE_FLEX_MAX_ROWS) * 12);
  } else if (rowCount > Math.floor(TABLE_FLEX_MAX_ROWS * 0.8)) {
    rowScore = 80;
  }

  let colScore = 100;
  if (colCount > TABLE_FLEX_MAX_COLS) {
    colScore = Math.max(0, 100 - (colCount - TABLE_FLEX_MAX_COLS) * 15);
  } else if (colCount > Math.floor(TABLE_FLEX_MAX_COLS * 0.8)) {
    colScore = 80;
  }

  let geometryScore = 100;
  if (rowHeight < TABLE_FLEX_MIN_ROW_HEIGHT) {
    geometryScore = Math.max(0, Math.round((rowHeight / TABLE_FLEX_MIN_ROW_HEIGHT) * 100));
  }
  if (colWidth < TABLE_FLEX_MIN_COL_WIDTH) {
    const colGeoScore = Math.max(0, Math.round((colWidth / TABLE_FLEX_MIN_COL_WIDTH) * 100));
    geometryScore = Math.min(geometryScore, colGeoScore);
  }

  let totalLen = 0;
  let cellCount = 0;
  for (let ri = 0; ri < rows.length; ri++) {
    if (!Array.isArray(rows[ri])) continue;
    for (let ci = 0; ci < rows[ri].length; ci++) {
      const cell = rows[ri][ci];
      const text =
        typeof cell === 'string'
          ? cell
          : cell && typeof cell === 'object'
            ? String(cell.text || '')
            : String(cell || '');
      totalLen += text.length;
      cellCount++;
    }
  }
  const avgLen = cellCount > 0 ? totalLen / cellCount : 0;
  let densityScore = 100;
  if (avgLen > 360) {
    densityScore = Math.max(0, 100 - Math.round((avgLen - 360) / 10));
  } else if (avgLen > 220) {
    densityScore = 80;
  }

  const score = Math.round((rowScore + colScore + geometryScore + densityScore) / 4);
  let recommendation = 'standard';
  if (score < 40) recommendation = 'fallback';
  else if (score < 70) recommendation = 'truncate';
  else if (score < 90) recommendation = 'compact';

  return {
    score,
    breakdown: { rowScore, colScore, densityScore, geometryScore },
    recommendation,
  };
}

function shouldAllowCompetitiveOptionalGroupGap(sectionName, pptGate, blocks) {
  if (sectionName !== 'Competitive Landscape') return false;
  if (!pptGate || typeof pptGate !== 'object') return false;
  if (!Array.isArray(blocks) || blocks.length === 0) return false;

  const chartIssues = Array.isArray(pptGate.chartIssues) ? pptGate.chartIssues : [];
  if (chartIssues.length > 0) return false;
  if (Number(pptGate.severeOverflowCount || 0) > 0) return false;

  const nonRenderableGroups = Array.isArray(pptGate.nonRenderableGroups)
    ? pptGate.nonRenderableGroups
    : [];
  if (nonRenderableGroups.length === 0) return false;

  const optionalGroups = new Set(['japanesePlayers', 'maActivity', 'caseStudy']);
  if (!nonRenderableGroups.every((group) => optionalGroups.has(String(group || '').trim()))) {
    return false;
  }

  const renderableGroups = new Set();
  for (const block of blocks) {
    const groupKey = String(block?.key || '').trim();
    if (!groupKey) continue;
    if (blockHasRenderableData(block)) renderableGroups.add(groupKey);
  }

  return renderableGroups.has('localMajor') && renderableGroups.has('foreignPlayers');
}

// ============ SECTION-BASED SLIDE GENERATOR ============
// Generates slides dynamically based on data depth using pattern library
async function generateSingleCountryPPT(synthesis, countryAnalysis, scope) {
  console.log(`Generating section-based single-country PPT for ${(synthesis || {}).country}...`);

  const pptx = new pptxgen();

  // Set exact slide size to match YCP template (13.3333" x 7.5" = 12192000 x 6858000 EMU)
  pptx.defineLayout({ name: 'YCP', width: 13.3333, height: 7.5 });
  pptx.layout = 'YCP';

  // YCP Theme Colors (from Escort template extraction — template-patterns.json)
  const tpColors = templatePatterns.style?.colors || {};
  const COLORS = {
    headerLine: tpColors.dk2 || '1F497D',
    accent3: tpColors.accent3 || '011AB7',
    accent1: tpColors.accent1 || '007FFF',
    dk2: tpColors.dk2 || '1F497D',
    white: tpColors.lt1 || 'FFFFFF',
    black: tpColors.dk1 || '000000',
    gray: 'F2F2F2',
    footerText: '808080',
    green: '2E7D32',
    orange: tpColors.orange || 'E46C0A',
    red: 'B71C1C',
    hyperlink: '0066CC',
    border: C_BORDER,
    muted: C_MUTED,
    lightGray: C_LIGHT_GRAY,
    secondary: C_SECONDARY,
    warningFill: 'FFF8E1',
    darkGray: '444444',
  };

  // ===== DEFINE MASTER SLIDES =====
  // "No Bar" for cover slide — clean background, no header line
  pptx.defineSlideMaster({
    title: 'NO_BAR',
    background: { color: COLORS.white },
    objects: [],
  });

  // "Main" for content slides — white background with double header lines (from Escort template)
  const tpPos = templatePatterns.pptxPositions || {};
  const hlTop = tpPos.headerLineTop || { x: 0, y: 1.0208, w: 13.3333, h: 0 };
  const hlBot = tpPos.headerLineBottom || { x: 0, y: 1.0972, w: 13.3333, h: 0 };
  const flPos = tpPos.footerLine || { x: 0, y: 7.2361, w: 13.3333, h: 0 };
  // Footer elements from template extraction
  const tpFooter = templatePatterns.style?.footer || {};
  const crPos = tpFooter.copyrightPos || { x: 4.11, y: 7.26, w: 5.12, h: 0.24, fontSize: 8 };
  const crText = tpFooter.copyrightText || '(C) YCP 2026';
  pptx.defineSlideMaster({
    title: 'YCP_MAIN',
    background: { color: COLORS.white },
    objects: [
      {
        line: {
          x: hlTop.x,
          y: hlTop.y,
          w: hlTop.w,
          h: 0,
          line: { color: hlTop.color || '293F55', width: hlTop.thickness || 4.5 },
        },
      },
      {
        line: {
          x: hlBot.x,
          y: hlBot.y,
          w: hlBot.w,
          h: 0,
          line: { color: hlBot.color || '293F55', width: hlBot.thickness || 2.25 },
        },
      },
      // Footer line (thin separator above copyright)
      {
        line: {
          x: flPos.x,
          y: flPos.y,
          w: flPos.w,
          h: 0,
          line: { color: flPos.color || '293F55', width: flPos.thickness || 2.25 },
        },
      },
      // Copyright text
      {
        text: {
          text: crText,
          options: {
            x: crPos.x,
            y: crPos.y,
            w: crPos.w,
            h: crPos.h,
            fontSize: crPos.fontSize || 8,
            fontFace: 'Segoe UI',
            color: COLORS.footerText,
            align: 'center',
          },
        },
      },
      {
        image: {
          data: `image/png;base64,${LOGO_DARK_B64}`,
          x: 0.38,
          y: 7.3,
          w: 0.47,
          h: 0.17,
        },
      },
    ],
  });

  // Legacy alias — keep for any remaining references
  pptx.defineSlideMaster({
    title: 'YCP_MASTER',
    background: { color: COLORS.white },
    objects: [],
  });

  pptx.defineSlideMaster({
    title: 'DIVIDER_NAVY',
    background: { data: `image/png;base64,${DIVIDER_BG_B64}` },
    objects: [
      {
        image: {
          data: `image/png;base64,${LOGO_WHITE_B64}`,
          x: 0.6322,
          y: 0.5847,
          w: 2.4367,
          h: 0.8692,
        },
      },
    ],
  });

  pptx.author = 'YCP Market Research';
  pptx.title = `${(synthesis || {}).country} - ${scope.industry} Market Analysis`;
  pptx.subject = scope.projectType;

  // Set default font to Segoe UI (YCP standard)
  pptx.theme = { headFontFace: 'Segoe UI', bodyFontFace: 'Segoe UI' };
  const FONT = 'Segoe UI';

  // Slide numbers (from template footer extraction)
  const pgPos = tpFooter.pageNumPos || { x: 10.22, y: 7.28, w: 3.11, h: 0.2 };
  pptx.slideNumber = {
    x: pgPos.x,
    y: pgPos.y,
    w: pgPos.w,
    h: pgPos.h,
    fontSize: 10,
    fontFace: FONT,
    color: COLORS.footerText,
  };

  // Use countryAnalysis for detailed data (policy, market, competitors, etc.)
  // synthesis contains metadata like isSingleCountry, confidenceScore, etc.
  let policy = countryAnalysis.policy || {};
  let market = countryAnalysis.market || {};
  let competitors = countryAnalysis.competitors || {};
  let depth = countryAnalysis.depth || {};
  // Provide safe defaults for summary to prevent empty slides
  const rawSummary = countryAnalysis.summary || countryAnalysis.summaryAssessment || {};
  let summary = {
    timingIntelligence: rawSummary.timingIntelligence || {},
    lessonsLearned: rawSummary.lessonsLearned || {},
    opportunities: rawSummary.opportunities || [],
    obstacles: rawSummary.obstacles || [],
    ratings: rawSummary.ratings || { attractiveness: 0, feasibility: 0 },
    keyInsights: rawSummary.keyInsights || [],
    goNoGo: rawSummary.goNoGo || {},
    recommendation: rawSummary.recommendation || '',
  };
  const renderNormalizationWarnings = [];
  const renderNormalizationErrors = [];
  {
    const policyNormalized = normalizeByAliasMap(policy, POLICY_ALIAS_MAP, {
      passThroughKeys: ['sources'],
    });
    policy = policyNormalized.data;
    if (policyNormalized.droppedKeys.length > 0) {
      const msg = `[policy] dropped non-template keys: ${policyNormalized.droppedKeys.join(', ')}`;
      renderNormalizationWarnings.push(msg);
      renderNormalizationErrors.push(msg);
    }

    const marketNormalized = normalizeMarketForRender(market);
    market = marketNormalized.data;
    if (marketNormalized.droppedKeys.length > 0) {
      const msg = `[market] dropped transient/non-template keys: ${marketNormalized.droppedKeys.join(', ')}`;
      renderNormalizationWarnings.push(msg);
      renderNormalizationErrors.push(msg);
    }
    const unsupportedMarketKeys = Object.keys(market).filter(
      (key) => !MARKET_RENDER_ALLOWED_KEYS.has(key)
    );
    if (unsupportedMarketKeys.length > 0) {
      const msg = `[market] unsupported render keys after normalization: ${unsupportedMarketKeys.join(', ')}`;
      renderNormalizationWarnings.push(msg);
      renderNormalizationErrors.push(msg);
    }

    const competitorsNormalized = normalizeByAliasMap(competitors, COMPETITOR_ALIAS_MAP, {
      passThroughKeys: ['sources'],
    });
    competitors = competitorsNormalized.data;
    if (competitorsNormalized.droppedKeys.length > 0) {
      const msg = `[competitors] dropped non-template keys: ${competitorsNormalized.droppedKeys.join(', ')}`;
      renderNormalizationWarnings.push(msg);
      renderNormalizationErrors.push(msg);
    }

    const depthNormalized = normalizeByAliasMap(depth, DEPTH_ALIAS_MAP, {
      passThroughKeys: ['sources'],
    });
    depth = depthNormalized.data;
    if (depthNormalized.droppedKeys.length > 0) {
      const msg = `[depth] dropped non-template keys: ${depthNormalized.droppedKeys.join(', ')}`;
      renderNormalizationWarnings.push(msg);
      renderNormalizationErrors.push(msg);
    }
  }
  if (STRICT_RENDER_NORMALIZATION && renderNormalizationErrors.length > 0) {
    const errorSummary = renderNormalizationErrors.slice(0, 6).join(' | ');
    throw new Error(`Render normalization rejected non-template/transient keys: ${errorSummary}`);
  }
  // Render compaction: keep deck layout readable and stable even when synthesis is verbose.
  policy = compactRenderPayload(policy, ['policy']) || {};
  market = compactRenderPayload(market, ['market']) || {};
  competitors = compactRenderPayload(competitors, ['competitors']) || {};
  depth = compactRenderPayload(depth, ['depth']) || {};
  summary = compactRenderPayload(summary, ['summary']) || summary;

  const country = countryAnalysis.country || (synthesis || {}).country;
  const templateSlideSelections =
    (scope && (scope.templateSlideSelections || scope.templateSelections)) || {};
  // Per-request strict geometry mode: when true, geometry recovery/table recovery
  // are hard failures instead of warn+continue. Defaults to STRICT_TEMPLATE_FIDELITY env var.
  const strictGeometryMode = Boolean(
    scope && typeof scope.templateStrictMode === 'boolean'
      ? scope.templateStrictMode
      : STRICT_TEMPLATE_FIDELITY
  );
  const templateUsageStats = {
    resolved: [],
    nonTemplatePatterns: [],
    slideRenderFailures: [],
    tableRecoveries: [],
    tableFallbacks: [],
  };
  const templateCloneSlideMap = [];
  // Canonical source: template-contract-compiler.js
  const SECTION_DIVIDER_TEMPLATE_SLIDES = _SECTION_DIVIDER_TEMPLATE_SLIDES;
  const activeTemplateContext = { blockKey: null, slideNumber: null, layout: null };
  const layoutFidelityStats = {
    checks: 0,
    aligned: 0,
    maxDelta: 0,
    missingGeometry: [],
  };
  const TABLE_TEMPLATE_CONTEXTS = _TABLE_TEMPLATE_CONTEXTS;
  const CHART_TEMPLATE_CONTEXTS = _CHART_TEMPLATE_CONTEXTS;
  const templateTableStyleCache = new Map();

  function schemeToHexColor(scheme) {
    const key = String(scheme || '').toLowerCase();
    if (key === 'bg1' || key === 'lt1') return C_WHITE;
    if (key === 'tx1' || key === 'dk1') return C_BLACK;
    if (key.startsWith('accent')) {
      return String(templatePatterns.style?.colors?.[key] || C_BORDER)
        .replace('#', '')
        .toUpperCase();
    }
    return C_BORDER;
  }

  function dashToBorderType(dash, fallback = 'solid') {
    const v = String(dash || '').toLowerCase();
    if (!v) return fallback;
    if (v === 'sysdash') return 'dash';
    if (v === 'solid') return 'solid';
    if (v === 'dash') return 'dash';
    return fallback;
  }

  function parseTemplateBorder(borderNode, fallback) {
    const def = fallback || {
      pt: TABLE_BORDER_WIDTH || 1,
      type: C_BORDER_STYLE || 'dash',
      color: C_BORDER,
    };
    if (!borderNode || typeof borderNode !== 'object') return { ...def };
    const width = Number(borderNode.width);
    const fill = borderNode.fill || {};
    let color = def.color;
    if (fill.type === 'color' && fill.color) {
      color = String(fill.color).replace('#', '').toUpperCase();
    } else if (fill.type === 'scheme' && fill.scheme) {
      color = schemeToHexColor(fill.scheme);
    }
    return {
      pt: Number.isFinite(width) && width > 0 ? width : def.pt,
      type: dashToBorderType(borderNode.dash, def.type),
      color: color || def.color,
    };
  }

  function getTemplateTableStyleProfile(slideNumber) {
    const numeric = Number(slideNumber);
    if (!Number.isFinite(numeric)) return null;
    if (templateTableStyleCache.has(numeric)) return templateTableStyleCache.get(numeric);

    const slide = (templatePatterns.slideDetails || []).find(
      (s) => Number(s?.slideNumber) === numeric
    );
    const table = (slide?.elements || []).find((el) => el?.type === 'table')?.table;
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    if (!rows.length) {
      templateTableStyleCache.set(numeric, null);
      return null;
    }

    const headerCell = (rows[0]?.cells || []).find((c) => c?.cellProps);
    const bodyCells = rows.slice(1).flatMap((r) => (Array.isArray(r?.cells) ? r.cells : []));
    const bodyCell =
      bodyCells.find((c) => c?.cellProps?.borders?.lnT?.width === 1) ||
      bodyCells.find((c) => c?.cellProps) ||
      headerCell;
    const marginSource = bodyCell?.cellProps || headerCell?.cellProps || {};

    const innerBorder = parseTemplateBorder(
      bodyCell?.cellProps?.borders?.lnT || bodyCell?.cellProps?.borders?.lnL,
      {
        pt: TABLE_BORDER_WIDTH || 1,
        type: C_BORDER_STYLE || 'dash',
        color: C_BORDER,
      }
    );
    const outerBorder = parseTemplateBorder(
      headerCell?.cellProps?.borders?.lnL || headerCell?.cellProps?.borders?.lnT,
      {
        pt: Number(templatePatterns.style?.table?.outerBorderWidth || 3),
        type: 'solid',
        color: C_WHITE,
      }
    );

    const margin = [...TABLE_CELL_MARGIN];
    const baselineCols = rows.reduce(
      (max, row) => Math.max(max, Array.isArray(row?.cells) ? row.cells.length : 0),
      0
    );

    const profile = {
      margin,
      valign: marginSource.anchor === 'ctr' ? 'mid' : 'top',
      innerBorder,
      outerBorder,
      baselineRows: rows.length,
      baselineCols: baselineCols || 1,
    };
    templateTableStyleCache.set(numeric, profile);
    return profile;
  }

  function isDefaultTableBorder(border) {
    if (!border || typeof border !== 'object') return false;
    const pt = Number(border.pt ?? border.width ?? 0);
    const type = dashToBorderType(border.type || border.style, '');
    const expectedType = dashToBorderType(C_BORDER_STYLE, '');
    const color = String(border.color || '')
      .replace('#', '')
      .toUpperCase();
    const expectedColor = String(C_BORDER || '')
      .replace('#', '')
      .toUpperCase();
    return (
      Math.abs(pt - Number(TABLE_BORDER_WIDTH || 1)) < 0.01 &&
      type === expectedType &&
      color === expectedColor
    );
  }

  function withPatchedCellOptions(cell, patch) {
    const patchOptions = patch || {};
    const patchBorder = patchOptions.border || null;
    const baseCell =
      cell && typeof cell === 'object' && !Array.isArray(cell)
        ? {
            ...cell,
            text: safeCell(Object.prototype.hasOwnProperty.call(cell, 'text') ? cell.text : ''),
          }
        : { text: safeCell(cell) };
    const baseOptions = { ...(baseCell.options || {}) };
    const nextOptions = { ...baseOptions, ...patchOptions };
    if (patchBorder) {
      nextOptions.border = { ...(baseOptions.border || {}), ...patchBorder };
    }
    return { ...baseCell, options: nextOptions };
  }

  // Enrichment fallback: use synthesis when available, otherwise fall back to countryAnalysis summary
  const enrichment = synthesis || {};

  // Format projects field — handles both string and array-of-objects from AI synthesis
  function formatProjects(projects) {
    if (!projects) return '';
    if (typeof projects === 'string') return projects;
    if (Array.isArray(projects)) {
      return projects
        .slice(0, 3)
        .map((proj) => {
          if (typeof proj === 'string') return proj;
          if (proj && typeof proj === 'object') {
            const parts = [proj.name || proj.project || ''];
            if (proj.value) parts.push(proj.value);
            if (proj.year) parts.push(proj.year);
            if (proj.status) parts.push(proj.status);
            return parts.filter(Boolean).join(' - ');
          }
          return String(proj);
        })
        .filter(Boolean)
        .join('; ');
    }
    return ensureString(projects);
  }

  // Enrich thin company descriptions by combining available data fields
  // Target: 50+ words with specific metrics, strategic context, and market relevance
  function enrichDescription(company) {
    if (!company || typeof company !== 'object') return company;
    const desc = ensureString(company.description, '');
    const wordCount = desc ? desc.split(/\s+/).filter(Boolean).length : 0;
    if (wordCount >= 45) return company; // Already rich enough
    // Build a richer description from available fields
    const parts = [];
    if (desc) parts.push(desc);
    // Financial metrics first (most valuable for consulting output)
    if (company.revenue && !desc.includes(company.revenue))
      parts.push(`Revenue: ${company.revenue}.`);
    if (company.marketShare && !desc.includes(company.marketShare))
      parts.push(`Market share: ${company.marketShare}.`);
    if (company.growthRate) parts.push(`Growth rate: ${company.growthRate}.`);
    if (company.employees) parts.push(`Workforce: ${company.employees} employees.`);
    // Strategic assessment (support both singular and plural field names)
    if (company.strengths) parts.push(`Key strengths: ${company.strengths}.`);
    else if (company.strength) parts.push(`Key strength: ${company.strength}.`);
    if (company.weaknesses) parts.push(`Weaknesses: ${company.weaknesses}.`);
    else if (company.weakness) parts.push(`Weakness: ${company.weakness}.`);
    if (company.competitiveAdvantage)
      parts.push(`Competitive advantage: ${company.competitiveAdvantage}.`);
    if (company.keyDifferentiator) parts.push(`Key differentiator: ${company.keyDifferentiator}.`);
    // Market presence
    if (company.projects) parts.push(`Key projects: ${formatProjects(company.projects)}.`);
    if (company.assessment) parts.push(company.assessment);
    if (company.success) parts.push(company.success);
    if (company.presence) parts.push(`Market presence: ${company.presence}.`);
    if (company.type) parts.push(`Company type: ${company.type}.`);
    // Origin and market entry
    if (company.origin && company.entryYear)
      parts.push(`${company.origin}-based, entered market in ${company.entryYear}.`);
    else if (company.origin) parts.push(`Origin: ${company.origin}.`);
    else if (company.entryYear) parts.push(`Entered market: ${company.entryYear}.`);
    if (company.mode) parts.push(`Entry mode: ${company.mode}.`);
    // Partnership/acquisition fit
    if (company.partnershipFit) parts.push(`Partnership fit: ${company.partnershipFit}/5.`);
    if (company.acquisitionFit) parts.push(`Acquisition fit: ${company.acquisitionFit}/5.`);
    if (company.estimatedValuation) parts.push(`Est. valuation: ${company.estimatedValuation}.`);
    // Additional context
    // Financial highlights
    if (company.financialHighlights?.investmentToDate)
      parts.push(`Investment to date: ${company.financialHighlights.investmentToDate}.`);
    if (company.financialHighlights?.profitMargin)
      parts.push(`Profit margin: ${company.financialHighlights.profitMargin}.`);
    if (company.investmentToDate && !company.financialHighlights?.investmentToDate)
      parts.push(`Investment to date: ${company.investmentToDate}.`);
    if (company.profitMargin && !company.financialHighlights?.profitMargin)
      parts.push(`Profit margin: ${company.profitMargin}.`);
    if (company.services) parts.push(`Core services: ${company.services}.`);
    if (company.clients) parts.push(`Key clients: ${company.clients}.`);
    if (company.founded) parts.push(`Founded: ${company.founded}.`);
    if (company.headquarters) parts.push(`HQ: ${company.headquarters}.`);
    if (company.specialization) parts.push(`Specialization: ${company.specialization}.`);
    if (company.certifications) parts.push(`Certifications: ${company.certifications}.`);
    if (company.recentActivity) parts.push(`Recent activity: ${company.recentActivity}.`);
    if (company.strategy) parts.push(`Strategy: ${company.strategy}.`);
    // Let thin descriptions stay thin — no fabricated filler
    const result = parts.join(' ').trim();
    company.description = result;
    return company;
  }

  // Apply validation, deduplication, and description enrichment to all player arrays
  function enrichPlayerArray(arr) {
    if (!Array.isArray(arr)) return [];
    return dedupeCompanies(
      arr.filter(isValidCompany).map(ensureWebsite).map(flattenPlayerProfile).map(enrichDescription)
    );
  }
  if (competitors.japanesePlayers?.players)
    competitors.japanesePlayers.players = enrichPlayerArray(competitors.japanesePlayers.players);
  if (competitors.localMajor?.players)
    competitors.localMajor.players = enrichPlayerArray(competitors.localMajor.players);
  if (competitors.foreignPlayers?.players)
    competitors.foreignPlayers.players = enrichPlayerArray(competitors.foreignPlayers.players);
  if (depth.partnerAssessment?.partners)
    depth.partnerAssessment.partners = enrichPlayerArray(depth.partnerAssessment.partners);
  if (competitors.maActivity?.potentialTargets)
    competitors.maActivity.potentialTargets = enrichPlayerArray(
      competitors.maActivity.potentialTargets
    );

  // Global cross-array dedup: remove companies that appear in multiple arrays
  const globalSeen = new Set();
  function globalDedup(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.filter((item) => {
      const key = String(item.name || '')
        .trim()
        .toLowerCase()
        .replace(
          /\b(ltd|inc|corp|co|llc|plc|sdn\s*bhd|pte|pvt|limited|corporation|company)\b\.?/gi,
          ''
        )
        .replace(/[^a-z0-9]/g, '');
      if (!key || globalSeen.has(key)) return false;
      globalSeen.add(key);
      return true;
    });
  }
  if (competitors.japanesePlayers?.players)
    competitors.japanesePlayers.players = globalDedup(competitors.japanesePlayers.players);
  if (competitors.localMajor?.players)
    competitors.localMajor.players = globalDedup(competitors.localMajor.players);
  if (competitors.foreignPlayers?.players)
    competitors.foreignPlayers.players = globalDedup(competitors.foreignPlayers.players);
  if (depth.partnerAssessment?.partners)
    depth.partnerAssessment.partners = globalDedup(depth.partnerAssessment.partners);
  if (competitors.maActivity?.potentialTargets)
    competitors.maActivity.potentialTargets = globalDedup(competitors.maActivity.potentialTargets);

  // Debug: confirm data source
  console.log(`  [PPT] Using countryAnalysis data for ${country}`);
  console.log(`  [PPT] policy keys: ${Object.keys(policy).join(', ') || 'EMPTY'}`);
  console.log(`  [PPT] market keys: ${Object.keys(market).join(', ') || 'EMPTY'}`);
  console.log(`  [PPT] depth keys: ${Object.keys(depth).join(', ') || 'EMPTY'}`);
  console.log(`  [PPT] summary.goNoGo: ${summary.goNoGo ? 'present' : 'EMPTY'}`);
  if (renderNormalizationWarnings.length > 0) {
    console.warn(`[PPT NORMALIZE] ${renderNormalizationWarnings.join(' | ')}`);
  }

  // Keep titles readable but avoid over-aggressive truncation.
  function truncateTitle(text) {
    if (!text) return '';
    const str = String(text).trim();
    if (str.length <= 110) return str;
    const cut = str.substring(0, 110);
    const lastSpace = cut.lastIndexOf(' ');
    return lastSpace > 70 ? cut.substring(0, lastSpace) : cut;
  }

  // Standard slide layout — positions from Escort template extraction
  const tpTitle = tpPos.title || { x: 0.3758, y: 0.0488, w: 12.5862, h: 0.9097 };
  const tpContent = tpPos.contentArea || { x: 0.3758, y: 1.5, w: 12.5862, h: 5.0 };
  const tpSource = tpPos.sourceBar || { x: 0.3758, y: 6.6944, w: 12.5862, h: 0.25 };
  // Title font from template extraction
  const tpTitleFont = templatePatterns.style?.fonts?.title || {};
  const tpTitleFontSize = TITLE_FONT_PT;
  const tpTitleBold = tpTitleFont.bold !== undefined ? tpTitleFont.bold : false;
  const CONTENT_WIDTH = tpContent.w; // Full content width for 16:9 widescreen
  const LEFT_MARGIN = tpContent.x; // Left margin from template
  const TITLE_X = tpTitle.x; // Title x position
  const TITLE_W = tpTitle.w; // Title width
  const SOURCE_W = tpSource.w; // Footer/source width
  const CONTENT_Y = tpContent.y; // Content area top Y from template

  // Maximum y for content shapes (source bar y = bottom of content zone)
  const CONTENT_BOTTOM = tpSource.y;
  // Footer y position
  const FOOTER_Y = tpSource.y;

  function rectDelta(a, b) {
    if (!a || !b) return null;
    const dx = Math.abs((a.x || 0) - (b.x || 0));
    const dy = Math.abs((a.y || 0) - (b.y || 0));
    const dw = Math.abs((a.w || 0) - (b.w || 0));
    const dh = Math.abs((a.h || 0) - (b.h || 0));
    return Math.max(dx, dy, dw, dh);
  }

  function recordGeometryCheck(kind, context, expectedRect, actualRect) {
    const delta = rectDelta(expectedRect, actualRect);
    if (delta == null) return;
    layoutFidelityStats.checks += 1;
    if (delta <= 0.01) layoutFidelityStats.aligned += 1;
    layoutFidelityStats.maxDelta = Math.max(layoutFidelityStats.maxDelta, delta);
    const allowedDelta = kind === 'table' && TABLE_FLEX_MODE === 'bounded' ? 0.12 : 0.05;
    if (delta > allowedDelta) {
      layoutFidelityStats.missingGeometry.push({
        kind,
        context,
        reason: `delta=${delta.toFixed(3)}in`,
      });
    }
  }

  function noteMissingGeometry(kind, context, reason) {
    layoutFidelityStats.missingGeometry.push({ kind, context, reason });
  }

  function getActiveLayoutRect(kind, fallbackRect, index = 0) {
    const layout = activeTemplateContext.layout;
    if (!layout) return fallbackRect;
    if (kind === 'title' && layout.title) return { ...fallbackRect, ...layout.title };
    if (kind === 'source' && layout.source) return { ...fallbackRect, ...layout.source };
    if (kind === 'content' && layout.content) return { ...fallbackRect, ...layout.content };
    if (kind === 'table' && layout.table) return { ...fallbackRect, ...layout.table };
    if (kind === 'chart') {
      const charts = Array.isArray(layout.charts) ? layout.charts : [];
      if (charts[index]) return { ...fallbackRect, ...charts[index] };
      if (charts[0]) return { ...fallbackRect, ...charts[0] };
    }
    return fallbackRect;
  }

  // Helper: apply alternating row fill for readability (skip header row at idx 0)
  function applyAlternateRowFill(_rows) {
    // No-op: Escort template uses no alternate row shading
  }

  function registerTemplateCloneSlide(templateSlideNumber, blockKey = null) {
    const generatedSlideNumber = Number(Array.isArray(pptx.slides) ? pptx.slides.length : NaN);
    const templateSlide = Number(templateSlideNumber);
    if (!Number.isFinite(generatedSlideNumber) || generatedSlideNumber <= 0) return;
    if (!Number.isFinite(templateSlide) || templateSlide <= 0) return;
    templateCloneSlideMap.push({
      generatedSlideNumber,
      templateSlideNumber: templateSlide,
      blockKey: blockKey ? ensureString(blockKey) : null,
    });
  }

  // Helper: clamp shape height so bottom doesn't exceed CONTENT_BOTTOM
  function clampH(y, h) {
    const maxH = Math.max(0.3, CONTENT_BOTTOM - y);
    return Math.min(h, maxH);
  }

  // Options: { sources: [{url, title}], dataQuality: 'high'|'medium'|'low'|'estimated' }
  function addSlideWithTitle(title, subtitle = '', options = {}) {
    // Use YCP_MAIN master (has header line built in)
    const slide = pptx.addSlide({ masterName: 'YCP_MAIN' });
    const activeLayout = options.templateLayout || activeTemplateContext.layout || null;
    const titleRect = getActiveLayoutRect('title', tpTitle);
    const sourceRect = getActiveLayoutRect('source', tpSource);
    const titleText = truncateTitle(title);
    const compactTitleBox = titleRect.h <= 1.0;
    const titleLen = ensureString(titleText).length;
    let subtitleMaxLen = compactTitleBox ? 220 : 320;
    if (titleLen > 95) subtitleMaxLen = Math.min(subtitleMaxLen, 180);
    if (titleLen > 120) subtitleMaxLen = Math.min(subtitleMaxLen, 140);
    const subtitleText = truncateSubtitle(subtitle, subtitleMaxLen, true);
    const subtitleFontSize = MESSAGE_FONT_PT;
    const shouldRenderSubtitle =
      subtitleText &&
      subtitleText.length > (compactTitleBox ? 16 : 10) &&
      !(compactTitleBox && titleLen > 110);

    // Title shape (position + font from template extraction)
    // Escort template uses title (20pt) + subtitle thesis (16pt) in same shape, separated by line break
    if (shouldRenderSubtitle) {
      slide.addText(
        [
          {
            text: titleText,
            options: {
              fontSize: tpTitleFontSize,
              bold: tpTitleBold,
              color: COLORS.black,
              fontFace: FONT,
              // Force subtitle onto a new line within the same title box.
              breakLine: true,
            },
          },
          {
            text: subtitleText,
            options: {
              fontSize: subtitleFontSize,
              bold: false,
              color: COLORS.black,
              fontFace: FONT,
              paraSpaceBefore: 2,
            },
          },
        ],
        {
          x: titleRect.x,
          y: titleRect.y,
          w: titleRect.w,
          h: titleRect.h + (compactTitleBox ? 0.12 : 0.2),
          valign: 'top',
          fit: 'shrink',
        }
      );
    } else {
      slide.addText(titleText, {
        x: titleRect.x,
        y: titleRect.y,
        w: titleRect.w,
        h: titleRect.h,
        fontSize: tpTitleFontSize,
        bold: tpTitleBold,
        color: COLORS.black,
        fontFace: FONT,
        valign: 'top',
        fit: 'shrink',
      });
    }
    if (activeLayout?.title) {
      recordGeometryCheck('title', activeTemplateContext.blockKey || 'slide', activeLayout.title, {
        x: titleRect.x,
        y: titleRect.y,
        w: titleRect.w,
        h: titleRect.h,
      });
    }
    // Header line is provided by YCP_MAIN master — no manual line needed

    // Merge data quality indicator + source citations into ONE shape to prevent overlap
    const hasDataQuality = options.dataQuality === 'estimated' || options.dataQuality === 'low';
    const sourcesToRender = options.sources || options.citations;
    const footerParts = [];

    if (hasDataQuality) {
      const legend =
        options.dataQuality === 'estimated'
          ? '* Estimated data - verify independently'
          : '+ Limited data availability';
      footerParts.push({
        text: legend + (sourcesToRender && sourcesToRender.length > 0 ? '   |   ' : ''),
        options: { fontSize: FOOTNOTE_FONT_PT, italic: true, color: COLORS.black, fontFace: FONT },
      });
    }

    if (sourcesToRender && sourcesToRender.length > 0) {
      footerParts.push({
        text: 'Sources: ',
        options: { fontSize: FOOTNOTE_FONT_PT, fontFace: FONT, color: COLORS.muted },
      });

      sourcesToRender.slice(0, 3).forEach((source, idx) => {
        if (idx > 0)
          footerParts.push({
            text: ', ',
            options: { fontSize: FOOTNOTE_FONT_PT, fontFace: FONT, color: COLORS.muted },
          });

        const sourceUrl = sanitizeHyperlinkUrl(typeof source === 'object' ? source.url : source);
        const sourceTitle = typeof source === 'object' ? source.title : null;

        if (sourceUrl) {
          let displayText;
          try {
            const url = new URL(sourceUrl);
            displayText = sourceTitle || url.hostname.replace('www.', '');
          } catch (e) {
            displayText = sourceTitle || truncate(sourceUrl, 30);
          }
          footerParts.push({
            text: displayText,
            options: {
              fontSize: FOOTNOTE_FONT_PT,
              fontFace: FONT,
              color: COLORS.hyperlink,
              hyperlink: { url: sourceUrl },
            },
          });
        } else {
          footerParts.push({
            text: sourceTitle || String(source),
            options: { fontSize: FOOTNOTE_FONT_PT, fontFace: FONT, color: COLORS.muted },
          });
        }
      });
    } else if (!hasDataQuality) {
      // Default source when none provided
      footerParts.push({
        text: 'Source: YCP Analysis',
        options: { fontSize: FOOTNOTE_FONT_PT, fontFace: FONT, color: COLORS.muted },
      });
    }

    if (footerParts.length > 0) {
      slide.addText(footerParts, {
        x: sourceRect.x ?? LEFT_MARGIN,
        y: sourceRect.y ?? FOOTER_Y,
        w: sourceRect.w ?? SOURCE_W,
        h: sourceRect.h || tpSource.h || 0.25,
        valign: 'top',
      });
      if (activeLayout?.source) {
        recordGeometryCheck(
          'source',
          activeTemplateContext.blockKey || 'slide',
          activeLayout.source,
          {
            x: sourceRect.x ?? LEFT_MARGIN,
            y: sourceRect.y ?? FOOTER_Y,
            w: sourceRect.w ?? SOURCE_W,
            h: sourceRect.h || tpSource.h || 0.25,
          }
        );
      }
    }

    return slide;
  }

  // Helper for table header row
  function tableHeader(cols) {
    return cols.map((text) => ({
      text,
      options: {
        bold: false,
        fontSize: 14,
        color: '000000',
        fontFace: FONT,
      },
    }));
  }

  // Guard addTable calls so malformed rows never create broken slide XML.
  function normalizeTableRows(rows, context = 'table') {
    if (!Array.isArray(rows)) {
      console.warn(`[PPT] ${context}: expected rows array, got ${typeof rows}`);
      return null;
    }

    const normalized = rows
      .map((row, idx) => {
        if (Array.isArray(row)) {
          const cells = row
            .map((cell) => {
              if (cell == null) return { text: '' };
              if (typeof cell === 'object' && !Array.isArray(cell)) {
                const normalizedCell = { ...cell };
                normalizedCell.text = safeCell(
                  Object.prototype.hasOwnProperty.call(normalizedCell, 'text')
                    ? normalizedCell.text
                    : ''
                );
                return normalizedCell;
              }
              return { text: safeCell(cell) };
            })
            .filter(Boolean);
          return cells.length > 0 ? cells : null;
        }

        if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
          const normalizedRow = { ...row };
          normalizedRow.text = safeCell(
            Object.prototype.hasOwnProperty.call(normalizedRow, 'text') ? normalizedRow.text : ''
          );
          return [normalizedRow];
        }

        if (typeof row === 'string' || typeof row === 'number' || typeof row === 'boolean') {
          return [{ text: safeCell(row) }];
        }

        console.warn(`[PPT] ${context}: dropping invalid row at index ${idx}`);
        return null;
      })
      .filter((row) => Array.isArray(row) && row.length > 0);

    if (normalized.length === 0) {
      console.warn(`[PPT] ${context}: no valid rows after normalization`);
      return null;
    }

    return normalized;
  }

  function tableCellText(cell) {
    if (cell == null) return '';
    if (typeof cell === 'object' && !Array.isArray(cell)) {
      return ensureString(
        Object.prototype.hasOwnProperty.call(cell, 'text') ? cell.text : ''
      ).trim();
    }
    return ensureString(cell).trim();
  }

  function compactTableColumns(rows, options = {}, context = 'table') {
    if (!Array.isArray(rows) || rows.length === 0) return { rows, options };
    const colCount = rows.reduce(
      (max, row) => Math.max(max, Array.isArray(row) ? row.length : 0),
      0
    );
    if (colCount <= 1) return { rows, options };

    const usedColumns = [];
    for (let col = 0; col < colCount; col++) {
      let hasContent = false;
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        if (tableCellText(row[col]).length > 0) {
          hasContent = true;
          break;
        }
      }
      usedColumns.push(hasContent);
    }

    let keepIndexes = usedColumns.map((used, idx) => (used ? idx : -1)).filter((idx) => idx >= 0);
    if (keepIndexes.length === 0) keepIndexes = [0];
    if (keepIndexes.length === colCount) return { rows, options };

    const compactedRows = rows.map((row) =>
      keepIndexes.map((idx) => (row && row[idx] !== undefined ? row[idx] : { text: '' }))
    );

    let compactedOptions = options;
    if (options && typeof options === 'object') {
      compactedOptions = { ...options };
      if (Array.isArray(compactedOptions.colW) && compactedOptions.colW.length >= colCount) {
        const original = compactedOptions.colW.map((w) => Number(w) || 0);
        let filtered = keepIndexes.map((idx) => original[idx] || 0);
        const sumOriginal = original.reduce((acc, w) => acc + w, 0);
        const sumFiltered = filtered.reduce((acc, w) => acc + w, 0);
        if (sumOriginal > 0 && sumFiltered > 0) {
          const scale = sumOriginal / sumFiltered;
          filtered = filtered.map((w) => Number((w * scale).toFixed(3)));
        }
        compactedOptions.colW = filtered;
      }
    }

    console.log(`[PPT] ${context}: compacted table columns ${colCount} -> ${keepIndexes.length}`);
    return { rows: compactedRows, options: compactedOptions };
  }

  // Normalize table margins to inches to avoid pt-vs-inch regressions in table XML.
  // Heuristic: margins >2 are interpreted as points and converted to inches.
  function normalizeTableMarginValue(raw) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    if (numeric < 0) return 0;
    if (numeric > 2) {
      const inches = numeric / 72;
      if (Number.isFinite(inches) && inches <= 2) return Number(inches.toFixed(4));
    }
    return numeric;
  }

  function normalizeTableMarginArray(margin, fallback = TABLE_CELL_MARGIN) {
    if (!Array.isArray(margin) || margin.length !== 4) return null;
    return margin.map((value, idx) => {
      const normalized = normalizeTableMarginValue(value);
      if (normalized == null) return Number(fallback?.[idx] || 0);
      return normalized;
    });
  }

  function sanitizeTableCellMargins(rows, context = 'table') {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    let corrected = 0;
    const sanitized = rows.map((row) => {
      if (!Array.isArray(row)) return row;
      return row.map((cell) => {
        if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return cell;
        if (!cell.options || !Array.isArray(cell.options.margin)) return cell;
        const normalizedMargin = normalizeTableMarginArray(cell.options.margin);
        if (!normalizedMargin) return cell;
        const changed = normalizedMargin.some(
          (value, idx) => Math.abs(value - Number(cell.options.margin[idx] ?? 0)) > 1e-6
        );
        if (!changed) return cell;
        corrected++;
        return {
          ...cell,
          options: {
            ...cell.options,
            margin: normalizedMargin,
          },
        };
      });
    });
    if (corrected > 0) {
      console.warn(`[PPT] ${context}: normalized ${corrected} table cell margin(s) to inch units`);
    }
    return sanitized;
  }

  function compactTableRowsForDensity(
    rows,
    { headerMaxChars = 220, bodyMaxChars = 360, strictMode = STRICT_TEMPLATE_FIDELITY } = {},
    context = 'table'
  ) {
    if (!Array.isArray(rows) || rows.length === 0) return { rows, changed: 0 };
    let changed = 0;
    const overflowSamples = [];
    const compactedRows = rows.map((row, rowIdx) => {
      if (!Array.isArray(row)) return row;
      const cap = rowIdx === 0 ? headerMaxChars : bodyMaxChars;
      return row.map((cell, colIdx) => {
        if (cell == null) return cell;
        if (typeof cell === 'string') {
          if (cell.length <= cap) return cell;
          if (strictMode) {
            overflowSamples.push({
              row: rowIdx,
              col: colIdx,
              cap,
              len: cell.length,
              severe: cell.length > Math.round(cap * 2.2),
              sample: cell.substring(0, 120),
            });
            return cell;
          }
          changed++;
          return truncate(cell, cap, true);
        }
        if (typeof cell === 'object' && !Array.isArray(cell)) {
          const text = ensureString(cell.text, '');
          if (!text || text.length <= cap) return cell;
          if (strictMode) {
            overflowSamples.push({
              row: rowIdx,
              col: colIdx,
              cap,
              len: text.length,
              severe: text.length > Math.round(cap * 2.2),
              sample: text.substring(0, 120),
            });
            return cell;
          }
          changed++;
          return {
            ...cell,
            text: truncate(text, cap, true),
          };
        }
        const asText = ensureString(cell, '');
        if (!asText || asText.length <= cap) return cell;
        if (strictMode) {
          overflowSamples.push({
            row: rowIdx,
            col: colIdx,
            cap,
            len: asText.length,
            severe: asText.length > Math.round(cap * 2.2),
            sample: asText.substring(0, 120),
          });
          return cell;
        }
        changed++;
        return truncate(asText, cap, true);
      });
    });
    if (overflowSamples.length > 0) {
      const preview = overflowSamples
        .slice(0, 4)
        .map(
          (entry) => `r${entry.row}c${entry.col} len=${entry.len}>${entry.cap} "${entry.sample}"`
        )
        .join(' | ');
      console.warn(
        `[PPT] ${context}: ${overflowSamples.length} table cell(s) exceed density budget in strict mode (${preview})`
      );
    }
    if (changed > 0) {
      console.log(`[PPT] ${context}: compacted ${changed} dense table cell(s) for readability`);
    }
    return { rows: compactedRows, changed, overflowSamples };
  }

  const TABLE_RETHINK_FILLER_PATTERNS = [
    /\bit is important to note that\b/gi,
    /\bit should be noted that\b/gi,
    /\bin order to\b/gi,
    /\bfor the purpose of\b/gi,
    /\bfrom the perspective of\b/gi,
    /\bin terms of\b/gi,
    /\bas part of\b/gi,
    /\bdue to the fact that\b/gi,
  ];

  function normalizeTableCellToText(cell) {
    if (cell == null) return '';
    if (typeof cell === 'string') return ensureString(cell);
    if (typeof cell === 'object' && !Array.isArray(cell)) return ensureString(cell.text, '');
    return ensureString(cell, '');
  }

  function compressTableCellNarrative(value, cap) {
    const raw = ensureString(value).replace(/\s+/g, ' ').trim();
    if (!raw || !Number.isFinite(cap) || cap <= 0 || raw.length <= cap) return raw;

    let text = raw;
    for (const re of TABLE_RETHINK_FILLER_PATTERNS) {
      text = text.replace(re, ' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length <= cap) return text;

    const chunks = text
      .split(/(?<=[.!?;:])\s+/)
      .map((chunk, idx) => ({ idx, chunk: chunk.trim() }))
      .filter((entry) => entry.chunk.length > 0);

    if (chunks.length > 1) {
      const scored = chunks
        .map((entry) => {
          const chunkText = entry.chunk;
          const hasNumber = /\d/.test(chunkText) ? 3 : 0;
          const hasPercentOrCurrency = /[%$€¥]/.test(chunkText) ? 2 : 0;
          const hasAllCaps = /\b[A-Z]{2,}\b/.test(chunkText) ? 1 : 0;
          const keywordBoost = /\b(cagr|target|deadline|risk|cost|investment|revenue)\b/i.test(
            chunkText
          )
            ? 2
            : 0;
          const lengthPenalty = chunkText.length > 220 ? -1 : 0;
          return {
            ...entry,
            score: hasNumber + hasPercentOrCurrency + hasAllCaps + keywordBoost + lengthPenalty,
          };
        })
        .sort((a, b) => b.score - a.score || a.idx - b.idx);
      let used = 0;
      const selected = [];
      for (const item of scored) {
        const candidateLength = used === 0 ? item.chunk.length : used + 1 + item.chunk.length;
        if (candidateLength > cap && selected.length > 0) continue;
        selected.push(item);
        used = candidateLength;
        if (used >= Math.floor(cap * 0.9)) break;
      }
      if (selected.length > 0) {
        text = selected
          .sort((a, b) => a.idx - b.idx)
          .map((x) => x.chunk)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }

    if (text.length <= cap) return text;
    const words = text.split(/\s+/).filter(Boolean);
    const out = [];
    let used = 0;
    for (const word of words) {
      const extra = out.length === 0 ? word.length : word.length + 1;
      if (used + extra > cap) break;
      out.push(word);
      used += extra;
    }
    if (out.length === 0) return text.slice(0, cap);
    return out
      .join(' ')
      .replace(/[,:;]$/, '')
      .trim();
  }

  function patchTableCellText(cell, nextText) {
    if (typeof cell === 'string') return nextText;
    if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
      return {
        ...cell,
        text: nextText,
      };
    }
    return nextText;
  }

  function rethinkDenseTableRows(
    rows,
    { headerMaxChars = 220, bodyMaxChars = 360, maxPasses = TABLE_RETHINK_MAX_PASSES } = {},
    context = 'table'
  ) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { rows, rewritten: 0, overflowSamples: [] };
    }
    let workingRows = rows;
    let rewritten = 0;
    let latestOverflow = [];
    const maxIterations = Math.max(1, Math.min(6, Number(maxPasses) || 1));

    for (let pass = 1; pass <= maxIterations; pass++) {
      const probe = compactTableRowsForDensity(
        workingRows,
        { headerMaxChars, bodyMaxChars, strictMode: true },
        `${context}:rethink-probe`
      );
      latestOverflow = Array.isArray(probe.overflowSamples) ? probe.overflowSamples : [];
      const severe = latestOverflow.filter((entry) => entry.severe);
      if (severe.length === 0) break;

      let passRewriteCount = 0;
      const severeIndex = new Set(severe.map((entry) => `${entry.row}:${entry.col}`));
      const nextRows = workingRows.map((row, rowIdx) => {
        if (!Array.isArray(row)) return row;
        const cap = rowIdx === 0 ? headerMaxChars : bodyMaxChars;
        return row.map((cell, colIdx) => {
          if (!severeIndex.has(`${rowIdx}:${colIdx}`)) return cell;
          const raw = normalizeTableCellToText(cell);
          if (!raw) return cell;
          const compacted = compressTableCellNarrative(raw, cap);
          if (!compacted || compacted === raw) return cell;
          passRewriteCount++;
          return patchTableCellText(cell, compacted);
        });
      });

      if (passRewriteCount === 0) break;
      rewritten += passRewriteCount;
      workingRows = nextRows;
      console.warn(
        `[PPT] ${context}: dynamic-fit rethink pass ${pass} rewrote ${passRewriteCount} severe table cell(s)`
      );
    }

    const finalProbe = compactTableRowsForDensity(
      workingRows,
      { headerMaxChars, bodyMaxChars, strictMode: true },
      `${context}:rethink-final`
    );
    latestOverflow = Array.isArray(finalProbe.overflowSamples) ? finalProbe.overflowSamples : [];
    return {
      rows: workingRows,
      rewritten,
      overflowSamples: latestOverflow,
    };
  }

  function countTableColumns(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    return rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  }

  function tablePressureBand(pressure) {
    if (pressure >= 1.95) return 'max';
    if (pressure >= 1.55) return 'plus';
    if (pressure >= 1.22) return 'soft';
    if (pressure >= 1.08) return 'mini';
    return 'std';
  }

  function pickTableVariant(rowPressure, colPressure) {
    const rowBand = tablePressureBand(rowPressure);
    const colBand = tablePressureBand(colPressure);
    const matrix = {
      std_std: { name: 'standard', widthNudge: 0, heightNudge: 0 },
      std_mini: { name: 'wide_micro', widthNudge: 0.02, heightNudge: 0 },
      std_soft: { name: 'wide_soft', widthNudge: 0.04, heightNudge: 0 },
      std_plus: { name: 'wide_plus', widthNudge: 0.08, heightNudge: 0 },
      std_max: { name: 'wide_max', widthNudge: 0.1, heightNudge: 0 },
      mini_std: { name: 'tall_micro', widthNudge: 0, heightNudge: 0.02 },
      mini_mini: { name: 'balanced_micro', widthNudge: 0.02, heightNudge: 0.02 },
      mini_soft: { name: 'balanced_micro_soft', widthNudge: 0.03, heightNudge: 0.03 },
      soft_std: { name: 'tall_soft', widthNudge: 0, heightNudge: 0.04 },
      soft_mini: { name: 'balanced_tall_micro', widthNudge: 0.02, heightNudge: 0.04 },
      plus_std: { name: 'tall_plus', widthNudge: 0, heightNudge: 0.08 },
      max_std: { name: 'tall_max', widthNudge: 0, heightNudge: 0.1 },
      soft_soft: { name: 'balanced_soft', widthNudge: 0.04, heightNudge: 0.04 },
      soft_plus: { name: 'balanced_wide_plus', widthNudge: 0.08, heightNudge: 0.05 },
      soft_max: { name: 'balanced_wide_max', widthNudge: 0.1, heightNudge: 0.06 },
      plus_soft: { name: 'balanced_tall_plus', widthNudge: 0.05, heightNudge: 0.08 },
      plus_plus: { name: 'balanced_plus', widthNudge: 0.08, heightNudge: 0.08 },
      plus_max: { name: 'balanced_plus_max', widthNudge: 0.1, heightNudge: 0.1 },
      max_soft: { name: 'balanced_max_soft', widthNudge: 0.06, heightNudge: 0.1 },
      max_plus: { name: 'balanced_max_plus', widthNudge: 0.1, heightNudge: 0.1 },
      max_max: { name: 'balanced_max', widthNudge: 0.1, heightNudge: 0.1 },
    };
    return matrix[`${rowBand}_${colBand}`] || matrix.std_std;
  }

  function applyBoundedTemplateTableFlex(
    tableRows,
    addOptions,
    expectedTableRect,
    templateStyleProfile,
    context = 'table'
  ) {
    if (!addOptions || typeof addOptions !== 'object' || !expectedTableRect) {
      return {
        options: addOptions,
        metrics: null,
      };
    }
    const rowCount = Array.isArray(tableRows) ? tableRows.length : 0;
    const colCount = countTableColumns(tableRows);
    const baselineRows = Math.max(1, Number(templateStyleProfile?.baselineRows) || rowCount || 1);
    const baselineCols = Math.max(1, Number(templateStyleProfile?.baselineCols) || colCount || 1);
    const rowPressure = rowCount > 0 ? rowCount / baselineRows : 1;
    const colPressure = colCount > 0 ? colCount / baselineCols : 1;
    const variant = pickTableVariant(rowPressure, colPressure);
    const sourceRect = getActiveLayoutRect('source', tpSource) || tpSource;
    const contentRect = getActiveLayoutRect('content', tpContent) || tpContent;
    const anchorX = Number(expectedTableRect.x);
    const anchorY = Number(expectedTableRect.y);
    const baseW = Number(expectedTableRect.w);
    const baseH = Number(expectedTableRect.h);
    const maxW = Math.max(0.6, Number(contentRect.x) + Number(contentRect.w) - anchorX);
    const maxH = Math.max(0.6, Number(sourceRect.y) - 0.02 - anchorY);
    const allowFlex = TABLE_FLEX_MODE === 'bounded';
    const enforceBudget = TABLE_FLEX_MODE !== 'off';
    const pressureWidthScale =
      allowFlex && colPressure > 1 ? Math.min(TABLE_FLEX_MAX_WIDTH_SCALE, colPressure) : 1;
    const pressureHeightScale =
      allowFlex && rowPressure > 1 ? Math.min(TABLE_FLEX_MAX_HEIGHT_SCALE, rowPressure) : 1;
    const requestedWidthScale = allowFlex
      ? Math.min(TABLE_FLEX_MAX_WIDTH_SCALE, pressureWidthScale + variant.widthNudge)
      : 1;
    const requestedHeightScale = allowFlex
      ? Math.min(TABLE_FLEX_MAX_HEIGHT_SCALE, pressureHeightScale + variant.heightNudge)
      : 1;
    let widthScale = requestedWidthScale;
    let heightScale = requestedHeightScale;
    const widthVariantDelta = Math.max(0, requestedWidthScale - pressureWidthScale);
    const heightVariantDelta = Math.max(0, requestedHeightScale - pressureHeightScale);
    const widthDeltaTooMuch = widthVariantDelta > TABLE_VARIANT_MAX_WIDTH_DELTA + 0.001;
    const heightDeltaTooMuch = heightVariantDelta > TABLE_VARIANT_MAX_HEIGHT_DELTA + 0.001;
    if (widthDeltaTooMuch) {
      widthScale = Math.min(
        TABLE_FLEX_MAX_WIDTH_SCALE,
        pressureWidthScale + TABLE_VARIANT_MAX_WIDTH_DELTA
      );
    }
    if (heightDeltaTooMuch) {
      heightScale = Math.min(
        TABLE_FLEX_MAX_HEIGHT_SCALE,
        pressureHeightScale + TABLE_VARIANT_MAX_HEIGHT_DELTA
      );
    }
    const targetW = Math.max(0.6, Math.min(maxW, baseW * widthScale));
    const targetH = Math.max(0.6, Math.min(maxH, baseH * heightScale));
    const nextOptions = {
      ...addOptions,
      x: anchorX,
      y: anchorY,
      w: Number(targetW.toFixed(3)),
      h: Number(targetH.toFixed(3)),
    };
    const rowHeight = rowCount > 0 ? targetH / rowCount : targetH;
    const colWidth = colCount > 0 ? targetW / colCount : targetW;

    let flexRecovered = false;
    if (STRICT_TEMPLATE_FIDELITY && enforceBudget) {
      const violations = [];
      if (widthDeltaTooMuch) {
        violations.push(
          `variant width nudge ${(widthVariantDelta * 100).toFixed(1)}% exceeds max ${(TABLE_VARIANT_MAX_WIDTH_DELTA * 100).toFixed(1)}%`
        );
      }
      if (heightDeltaTooMuch) {
        violations.push(
          `variant height nudge ${(heightVariantDelta * 100).toFixed(1)}% exceeds max ${(TABLE_VARIANT_MAX_HEIGHT_DELTA * 100).toFixed(1)}%`
        );
      }
      if (rowCount > TABLE_FLEX_MAX_ROWS) {
        violations.push(`rows=${rowCount} exceed maxRows=${TABLE_FLEX_MAX_ROWS}`);
      }
      if (colCount > TABLE_FLEX_MAX_COLS) {
        violations.push(`cols=${colCount} exceed maxCols=${TABLE_FLEX_MAX_COLS}`);
      }
      if (rowHeight < TABLE_FLEX_MIN_ROW_HEIGHT - 0.005) {
        violations.push(
          `rowHeight=${rowHeight.toFixed(3)}in below minimum=${TABLE_FLEX_MIN_ROW_HEIGHT.toFixed(3)}in`
        );
      }
      if (colWidth < TABLE_FLEX_MIN_COL_WIDTH - 0.01) {
        violations.push(
          `colWidth=${colWidth.toFixed(3)}in below minimum=${TABLE_FLEX_MIN_COL_WIDTH.toFixed(3)}in`
        );
      }
      if (violations.length > 0) {
        if (strictGeometryMode) {
          throw new Error(
            `[STRICT GEOMETRY] Hard fail: table flexibility exceeded in strict mode. Block "${context}": ${violations.join('; ')}. Table recovery not allowed in strict geometry mode.`
          );
        }
        console.warn(
          `[PPT TEMPLATE] ${context}: bounded table flexibility exceeded — attempting recovery (${violations.join('; ')})`
        );
        // Recovery: truncate rows if over max
        if (rowCount > TABLE_FLEX_MAX_ROWS && Array.isArray(tableRows)) {
          const keep = TABLE_FLEX_MAX_ROWS - 1; // leave room for summary row
          const truncated = tableRows.length - keep;
          tableRows.length = keep;
          tableRows.push([
            {
              text: `+${truncated} more items (table capacity exceeded)`,
              options: { colspan: colCount, italic: true, color: '999999' },
            },
          ]);
        }
        // Recovery: drop excess columns
        if (colCount > TABLE_FLEX_MAX_COLS && Array.isArray(tableRows)) {
          for (let ri = 0; ri < tableRows.length; ri++) {
            if (Array.isArray(tableRows[ri]) && tableRows[ri].length > TABLE_FLEX_MAX_COLS) {
              tableRows[ri] = tableRows[ri].slice(0, TABLE_FLEX_MAX_COLS);
            }
          }
        }
        // Re-compute dimensions after recovery
        const recoveredRowCount = Array.isArray(tableRows) ? tableRows.length : rowCount;
        const recoveredColCount = countTableColumns(tableRows);
        const recoveredRowHeight = recoveredRowCount > 0 ? targetH / recoveredRowCount : targetH;
        const recoveredColWidth = recoveredColCount > 0 ? targetW / recoveredColCount : targetW;
        nextOptions.h = Number(targetH.toFixed(3));
        nextOptions.w = Number(targetW.toFixed(3));
        templateUsageStats.tableFallbacks.push({
          key: context,
          reason: violations.join('; '),
          recoveryType: 'bounded-flex',
          originalRows: rowCount,
          originalCols: colCount,
          recoveredRows: recoveredRowCount,
          recoveredCols: recoveredColCount,
        });
        templateUsageStats.tableRecoveries.push({
          key: context,
          reason: violations.join('; '),
          recoveryType: 'bounded-flex',
          originalRows: rowCount,
          recoveredRows: recoveredRowCount,
        });
        console.log(
          `[PPT] ${context}: table-flex recovery applied (rows: ${rowCount}->${recoveredRowCount}, cols: ${colCount}->${recoveredColCount})`
        );
        flexRecovered = true;
      }
    }

    return {
      options: nextOptions,
      metrics: {
        rowCount,
        colCount,
        baselineRows,
        baselineCols,
        rowPressure,
        colPressure,
        rowHeight,
        colWidth,
        variant: variant.name,
        pressureWidthScale,
        pressureHeightScale,
        requestedWidthScale,
        requestedHeightScale,
        widthScale,
        heightScale,
        recovered: flexRecovered,
      },
    };
  }

  function safeAddTable(slide, rows, options = {}, context = 'table') {
    let resolvedContext = ensureString(context, '').trim() || 'table';
    if (resolvedContext === 'table') {
      const activeBlockKey = ensureString(activeTemplateContext.blockKey, '').trim();
      if (activeBlockKey && TABLE_TEMPLATE_CONTEXTS.has(activeBlockKey)) {
        resolvedContext = activeBlockKey;
      }
    }
    const normalizedRows = normalizeTableRows(rows, resolvedContext);
    if (!normalizedRows) return false;
    let addOptions = options && typeof options === 'object' ? { ...options } : options;
    const compacted = compactTableColumns(normalizedRows, addOptions, resolvedContext);
    let tableRows = compacted.rows;
    addOptions = compacted.options;
    tableRows = sanitizeTableCellMargins(tableRows, resolvedContext);
    const hadAutoPage =
      addOptions &&
      typeof addOptions === 'object' &&
      (Object.prototype.hasOwnProperty.call(addOptions, 'autoPage') ||
        Object.prototype.hasOwnProperty.call(addOptions, 'autoPageRepeatHeader') ||
        Object.prototype.hasOwnProperty.call(addOptions, 'autoPageHeaderRows'));
    if (addOptions && typeof addOptions === 'object') {
      // Enforce deterministic template geometry: auto-paging can mutate layout and
      // has known intermittent failures in pptxgenjs. We disable it at source.
      delete addOptions.autoPage;
      delete addOptions.autoPageRepeatHeader;
      delete addOptions.autoPageHeaderRows;
      if (hadAutoPage) {
        console.log(
          `[PPT] ${resolvedContext}: stripped autoPage flags for deterministic rendering`
        );
      }
      const normalizedMargin = normalizeTableMarginArray(addOptions.margin);
      if (normalizedMargin) addOptions.margin = normalizedMargin;
    }
    const templateStyleProfile =
      TABLE_TEMPLATE_CONTEXTS.has(resolvedContext) &&
      Number.isFinite(Number(activeTemplateContext.slideNumber))
        ? getTemplateTableStyleProfile(activeTemplateContext.slideNumber)
        : null;
    if (templateStyleProfile && addOptions && typeof addOptions === 'object') {
      // Keep table internals close to the selected template slide (not just x/y geometry).
      addOptions.margin = [...templateStyleProfile.margin];
      if (!addOptions.valign || addOptions.valign === 'top') {
        addOptions.valign = templateStyleProfile.valign;
      }
      if (!addOptions.border || isDefaultTableBorder(addOptions.border)) {
        addOptions.border = { ...templateStyleProfile.innerBorder };
      }
      for (let ri = 0; ri < tableRows.length; ri++) {
        if (!Array.isArray(tableRows[ri])) continue;
        tableRows[ri] = tableRows[ri].map((cell) =>
          withPatchedCellOptions(cell, {
            margin: [...templateStyleProfile.margin],
            valign: templateStyleProfile.valign,
          })
        );
      }
      if (Array.isArray(tableRows[0])) {
        tableRows[0] = tableRows[0].map((cell) =>
          withPatchedCellOptions(cell, { border: templateStyleProfile.outerBorder })
        );
      }
      for (let ri = 1; ri < tableRows.length; ri++) {
        if (!Array.isArray(tableRows[ri]) || tableRows[ri].length === 0) continue;
        tableRows[ri][0] = withPatchedCellOptions(tableRows[ri][0], {
          border: templateStyleProfile.outerBorder,
        });
      }
    }
    const shouldAlignToTemplate =
      typeof addOptions === 'object' &&
      TABLE_TEMPLATE_CONTEXTS.has(resolvedContext) &&
      activeTemplateContext.layout;
    if (shouldAlignToTemplate) {
      const expectedTableRect = getActiveLayoutRect('table', null);
      if (expectedTableRect) {
        const requestedRect = {
          x: addOptions.x,
          y: addOptions.y,
          w: addOptions.w,
          h: addOptions.h,
        };
        const aligned = applyBoundedTemplateTableFlex(
          tableRows,
          addOptions,
          expectedTableRect,
          templateStyleProfile,
          resolvedContext
        );
        addOptions = aligned.options;
        recordGeometryCheck('table', resolvedContext, expectedTableRect, {
          x: addOptions.x,
          y: addOptions.y,
          w: addOptions.w,
          h: addOptions.h,
        });
        const preDelta = rectDelta(expectedTableRect, requestedRect);
        if (preDelta != null && preDelta > 0.05) {
          console.log(
            `[PPT TEMPLATE] ${resolvedContext}: aligned table geometry to slide ${activeTemplateContext.slideNumber} (delta=${preDelta.toFixed(3)}in)`
          );
        }
        if (
          aligned.metrics &&
          (aligned.metrics.widthScale > 1.01 || aligned.metrics.heightScale > 1.01)
        ) {
          console.log(
            `[PPT TEMPLATE] ${resolvedContext}: applied bounded table flex variant=${aligned.metrics.variant || 'standard'} (rows=${aligned.metrics.rowCount}/${aligned.metrics.baselineRows}, cols=${aligned.metrics.colCount}/${aligned.metrics.baselineCols}, widthScale=${aligned.metrics.widthScale.toFixed(2)}, heightScale=${aligned.metrics.heightScale.toFixed(2)})`
          );
        }
      } else {
        // Some template slides (e.g., chart-first layouts) do not expose explicit table
        // geometry in extracted metadata. In that case keep renderer geometry without
        // treating it as a hard-fidelity failure.
        console.warn(
          `[PPT TEMPLATE] ${resolvedContext}: no explicit table geometry for template slide ${activeTemplateContext.slideNumber}; using renderer geometry`
        );
      }
    }
    if (addOptions && typeof addOptions === 'object') {
      const y = Number(addOptions.y);
      const h = Number(addOptions.h);
      // Keep table bottoms slightly above source/footer line to avoid visual collisions.
      if (Number.isFinite(y) && Number.isFinite(h) && h > 0) {
        const activeSourceRect = getActiveLayoutRect('source', tpSource);
        const maxBottom = Number(activeSourceRect?.y) - 0.02;
        const bottom = y + h;
        if (Number.isFinite(maxBottom) && bottom > maxBottom) {
          addOptions.h = Math.max(0.3, maxBottom - y);
        }
      }
    }
    // Pre-flight fit score check — route to appropriate recovery strategy
    const fitScoreRect = { w: Number(addOptions?.w) || 8.5, h: Number(addOptions?.h) || 3.5 };
    const fitResult = computeTableFitScore(tableRows, fitScoreRect);
    if (fitResult.recommendation === 'fallback') {
      if (strictGeometryMode) {
        throw new Error(
          `[STRICT GEOMETRY] Hard fail: table fit score=${fitResult.score} (${fitResult.recommendation}) for block "${resolvedContext}". Table recovery not allowed in strict geometry mode. Breakdown: rows=${fitResult.breakdown?.rowScore}, cols=${fitResult.breakdown?.colScore}, density=${fitResult.breakdown?.densityScore}, geometry=${fitResult.breakdown?.geometryScore}.`
        );
      }
      console.warn(
        `[PPT] ${resolvedContext}: table fit score=${fitResult.score} (${fitResult.recommendation}) — applying aggressive recovery`
      );
      if (tableRows.length > TABLE_FLEX_MAX_ROWS) {
        const keep = Math.min(TABLE_FLEX_MAX_ROWS - 1, 10);
        const truncated = tableRows.length - keep;
        tableRows.length = keep;
        tableRows.push([
          {
            text: `+${truncated} more items (table too large for slide)`,
            options: { colspan: countTableColumns(tableRows) || 1, italic: true, color: '999999' },
          },
        ]);
      }
      const maxCols = Math.min(TABLE_FLEX_MAX_COLS, 6);
      for (let ri = 0; ri < tableRows.length; ri++) {
        if (Array.isArray(tableRows[ri]) && tableRows[ri].length > maxCols) {
          tableRows[ri] = tableRows[ri].slice(0, maxCols);
        }
      }
      templateUsageStats.tableRecoveries.push({
        key: resolvedContext,
        reason: `fit-score-fallback: score=${fitResult.score}`,
        recoveryType: 'fit-score-fallback',
        originalScore: fitResult.score,
        breakdown: fitResult.breakdown,
      });
    } else if (fitResult.recommendation === 'truncate') {
      if (strictGeometryMode) {
        throw new Error(
          `[STRICT GEOMETRY] Hard fail: table fit score=${fitResult.score} (${fitResult.recommendation}) for block "${resolvedContext}". Table truncation not allowed in strict geometry mode. Breakdown: rows=${fitResult.breakdown?.rowScore}, cols=${fitResult.breakdown?.colScore}, density=${fitResult.breakdown?.densityScore}, geometry=${fitResult.breakdown?.geometryScore}.`
        );
      }
      console.log(
        `[PPT] ${resolvedContext}: table fit score=${fitResult.score} (${fitResult.recommendation}) — applying truncation`
      );
      if (tableRows.length > TABLE_FLEX_MAX_ROWS) {
        const keep = TABLE_FLEX_MAX_ROWS - 1;
        const truncated = tableRows.length - keep;
        tableRows.length = keep;
        tableRows.push([
          {
            text: `+${truncated} more items`,
            options: { colspan: countTableColumns(tableRows) || 1, italic: true, color: '999999' },
          },
        ]);
      }
      if (countTableColumns(tableRows) > TABLE_FLEX_MAX_COLS) {
        for (let ri = 0; ri < tableRows.length; ri++) {
          if (Array.isArray(tableRows[ri]) && tableRows[ri].length > TABLE_FLEX_MAX_COLS) {
            tableRows[ri] = tableRows[ri].slice(0, TABLE_FLEX_MAX_COLS);
          }
        }
      }
      templateUsageStats.tableRecoveries.push({
        key: resolvedContext,
        reason: `fit-score-truncate: score=${fitResult.score}`,
        recoveryType: 'fit-score-truncate',
        originalScore: fitResult.score,
        breakdown: fitResult.breakdown,
      });
    }
    // Absolute hard cap: no cell should ever exceed 800 chars regardless of density settings
    for (let ri = 0; ri < tableRows.length; ri++) {
      if (!Array.isArray(tableRows[ri])) continue;
      for (let ci = 0; ci < tableRows[ri].length; ci++) {
        const cell = tableRows[ri][ci];
        if (typeof cell === 'string' && cell.length > 800) {
          tableRows[ri][ci] = cell.slice(0, 797) + '...';
        } else if (
          cell &&
          typeof cell === 'object' &&
          typeof cell.text === 'string' &&
          cell.text.length > 800
        ) {
          cell.text = cell.text.slice(0, 797) + '...';
        }
      }
    }
    if (addOptions && typeof addOptions === 'object') {
      const configuredFontSize = Number(addOptions.fontSize);
      if (Number.isFinite(configuredFontSize) && configuredFontSize > 0) {
        addOptions.fontSize = Math.max(
          CONTENT_MIN_FONT_PT,
          Math.min(CONTENT_FONT_PT, configuredFontSize)
        );
      } else {
        addOptions.fontSize = CONTENT_FONT_PT;
      }
      const rowCount = Array.isArray(tableRows) ? tableRows.length : 0;
      const tableHeight = Number(addOptions.h);
      if (rowCount > 0 && Number.isFinite(tableHeight) && tableHeight > 0) {
        const rowHeight = tableHeight / Math.max(1, rowCount);
        let headerMaxChars = 220;
        let bodyMaxChars = 360;
        let preferredFontSize = null;
        if (rowHeight < 0.18) {
          headerMaxChars = 180;
          bodyMaxChars = 320;
          preferredFontSize = 12;
        } else if (rowHeight < 0.22) {
          headerMaxChars = 220;
          bodyMaxChars = 380;
          preferredFontSize = 12;
        } else if (rowHeight < 0.26) {
          headerMaxChars = 260;
          bodyMaxChars = 440;
          preferredFontSize = 13;
        } else if (rowHeight < 0.3) {
          headerMaxChars = 300;
          bodyMaxChars = 520;
          preferredFontSize = 14;
        }
        if (preferredFontSize != null) {
          const current = Number(addOptions.fontSize);
          const candidate =
            Number.isFinite(current) && current > 0
              ? Math.min(current, preferredFontSize)
              : preferredFontSize;
          addOptions.fontSize = Math.max(CONTENT_MIN_FONT_PT, Math.min(CONTENT_FONT_PT, candidate));
        }
        const compacted = compactTableRowsForDensity(
          tableRows,
          { headerMaxChars, bodyMaxChars, strictMode: STRICT_TEMPLATE_FIDELITY },
          resolvedContext
        );
        tableRows = compacted.rows;
        if (STRICT_TEMPLATE_FIDELITY && Array.isArray(compacted.overflowSamples)) {
          let severe = compacted.overflowSamples.filter((entry) => entry.severe);
          if (severe.length > 0) {
            const rethink = rethinkDenseTableRows(
              tableRows,
              {
                headerMaxChars,
                bodyMaxChars,
                maxPasses: TABLE_RETHINK_MAX_PASSES,
              },
              resolvedContext
            );
            if (rethink.rewritten > 0) {
              tableRows = rethink.rows;
              severe = (rethink.overflowSamples || []).filter((entry) => entry.severe);
              console.warn(
                `[PPT] ${resolvedContext}: dynamic-fit rethink rewritten=${rethink.rewritten}, severeRemaining=${severe.length}`
              );
            }
          }
          if (severe.length > 0) {
            if (strictGeometryMode) {
              const preview = severe
                .slice(0, 4)
                .map((entry) => `r${entry.row}c${entry.col}:${entry.len}>${entry.cap}`)
                .join(', ');
              throw new Error(
                `[STRICT GEOMETRY] Hard fail: density-overflow in block "${resolvedContext}". ${severe.length} severe cell(s) exceed density budget: ${preview}. Cell truncation not allowed in strict geometry mode.`
              );
            }
            // Recovery: hard-truncate remaining severe cells to their cap
            for (const entry of severe) {
              if (
                entry.row >= 0 &&
                entry.row < tableRows.length &&
                Array.isArray(tableRows[entry.row])
              ) {
                const cell = tableRows[entry.row][entry.col];
                if (typeof cell === 'string') {
                  tableRows[entry.row][entry.col] = cell.slice(0, entry.cap - 3) + '...';
                } else if (cell && typeof cell === 'object' && typeof cell.text === 'string') {
                  cell.text = cell.text.slice(0, entry.cap - 3) + '...';
                }
              }
            }
            const preview = severe
              .slice(0, 4)
              .map((entry) => `r${entry.row}c${entry.col}:${entry.len}>${entry.cap}`)
              .join(', ');
            console.warn(
              `[PPT] ${resolvedContext}: density-overflow recovery applied — hard-truncated ${severe.length} severe cell(s); ${preview}`
            );
            templateUsageStats.tableFallbacks.push({
              key: resolvedContext,
              reason: `density-overflow: ${severe.length} severe cells`,
              recoveryType: 'density-truncate',
              severeCells: severe.length,
            });
            templateUsageStats.tableRecoveries.push({
              key: resolvedContext,
              reason: `density-overflow: ${severe.length} severe cells hard-truncated`,
              recoveryType: 'density-truncate',
              severeCells: severe.length,
            });
          }
        }
      }
    }
    try {
      slide.addTable(tableRows, addOptions);
      return true;
    } catch (err) {
      console.error(
        `[PPT] ${resolvedContext} addTable failed: ${err.message} | rows=${tableRows.length}`
      );
      templateUsageStats.slideRenderFailures.push({
        key: resolvedContext,
        pattern: 'table',
        error: err.message,
      });
      return false;
    }
  }

  // Helper to show "Data unavailable" message on slides with missing data
  function addDataUnavailableMessage(slide, message = 'Data not available for this section') {
    slide.addText(message, {
      x: LEFT_MARGIN,
      y: 3.0,
      w: CONTENT_WIDTH,
      h: 1.0,
      fontSize: 14,
      color: COLORS.muted,
      fontFace: FONT,
      align: 'center',
      valign: 'middle',
    });
  }

  // Helper to extract citations from raw research data for a specific topic category
  function getCitationsForCategory(category) {
    if (!countryAnalysis.rawData) return [];
    const citations = [];
    for (const [key, data] of Object.entries(countryAnalysis.rawData)) {
      if (key.startsWith(category)) {
        // Collect structured citations ({url, title} objects)
        if (data.citations && Array.isArray(data.citations)) {
          citations.push(...data.citations);
        }
        // Fallback: extract URLs from raw content text
        if (citations.length === 0 && data.content && typeof data.content === 'string') {
          const urlRegex = /https?:\/\/[^\s"'<>)\]},]+/g;
          const matches = data.content.match(urlRegex) || [];
          for (const url of matches) {
            const cleanUrl = url.replace(/[.,;:]+$/, '');
            citations.push({
              url: cleanUrl,
              title: cleanUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
            });
          }
        }
      }
    }
    // Deduplicate by URL and limit to 5
    const seen = new Set();
    const unique = [];
    for (const c of citations) {
      const urlKey = typeof c === 'object' ? c.url : String(c);
      if (urlKey && !seen.has(urlKey)) {
        seen.add(urlKey);
        unique.push(c);
      }
    }
    return unique.slice(0, 5);
  }

  // Helper to get data quality for a category (returns lowest quality among topics)
  function getDataQualityForCategory(category) {
    if (!countryAnalysis.rawData) return 'unknown';
    const qualities = [];
    for (const [key, data] of Object.entries(countryAnalysis.rawData)) {
      if (key.startsWith(category) && data.dataQuality) {
        qualities.push(data.dataQuality);
      }
    }
    // Return worst quality level
    if (qualities.includes('estimated')) return 'estimated';
    if (qualities.includes('low')) return 'low';
    if (qualities.includes('medium')) return 'medium';
    if (qualities.includes('high')) return 'high';
    return 'unknown';
  }

  // ============ DATA BLOCK CLASSIFICATION ============

  // Hardening switches: template-first rendering for production decks.
  // Dynamic discovery and raw/thin fallback slides are useful for debugging,
  // but they introduce layout drift and unpredictable slide structures.
  const ENABLE_DYNAMIC_BLOCK_DISCOVERY = false;
  const ALLOW_NON_TEMPLATE_FALLBACK_SLIDES = false;

  // Set of all known hardcoded keys across all sections — used by dynamic key discovery
  // to avoid creating duplicate blocks for keys already handled by hardcoded logic
  const KNOWN_HARDCODED_KEYS = new Set([
    // Policy
    'foundationalActs',
    'nationalPolicy',
    'investmentRestrictions',
    'keyIncentives',
    'regulatorySummary',
    'sources',
    // Market (energy-specific fallback keys)
    'tpes',
    'finalDemand',
    'electricity',
    'gasLng',
    'pricing',
    'escoMarket',
    // Competitors
    'japanesePlayers',
    'localMajor',
    'foreignPlayers',
    'caseStudy',
    'maActivity',
    // Depth
    'dealEconomics',
    'partnerAssessment',
    'entryStrategy',
    'implementation',
    'targetSegments',
    // Summary/Recommendations
    'goNoGo',
    'opportunitiesObstacles',
    'keyInsights',
    'timingIntelligence',
    'lessonsLearned',
    'opportunities',
    'obstacles',
    'ratings',
    'recommendation',
    // Meta keys to skip
    '_synthesisError',
    '_wasArray',
    'message',
    'slideTitle',
    'subtitle',
    'keyMessage',
    'section',
    'dataType',
    'sources',
    'confidenceScore',
  ]);

  // isTransientSynthesisKey replaced by isTransientKey from canonical module.
  function isTransientSynthesisKey(key) {
    return isTransientKey(key);
  }

  const SEMANTIC_EMPTY_TEXT_PATTERNS = [
    /\binsufficient research data\b/i,
    /\binsufficient data\b/i,
    /\bdata unavailable\b/i,
    /\bno data available\b/i,
    /\bnot available\b/i,
    /\bcould not be verified\b/i,
    /\bdetails pending further research\b/i,
    /\banalysis pending additional research\b/i,
    /\btbd\b/i,
    /\bn\/a\b/i,
  ];

  const TRUNCATION_ARTIFACT_TEXT_PATTERNS = [
    /\bunterminated string\b/i,
    /\bunexpected end of json\b/i,
    /\bexpected double-quoted property name\b/i,
    /\bexpected ',' or '}' after property value\b/i,
    /\bparse error\b/i,
    /\bstrategy 3\.5\b/i,
    /\bstrategy 4\b/i,
    /\bline \d+ column \d+\b/i,
  ];

  function hasSemanticEmptyText(value) {
    const text = ensureString(value).replace(/\s+/g, ' ').trim();
    if (!text) return true;
    return SEMANTIC_EMPTY_TEXT_PATTERNS.some((re) => re.test(text));
  }

  function hasTruncationArtifactText(value) {
    const text = ensureString(value).replace(/\s+/g, ' ').trim();
    if (!text) return false;
    return TRUNCATION_ARTIFACT_TEXT_PATTERNS.some((re) => re.test(text));
  }

  function hasMeaningfulNarrative(value, minWords = 6) {
    const text = ensureString(value).replace(/\s+/g, ' ').trim();
    if (!text) return false;
    if (hasSemanticEmptyText(text) || hasTruncationArtifactText(text)) return false;
    if ((text.startsWith('{') || text.startsWith('[')) && text.includes(':'))
      return text.length >= 20;
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words >= minWords) return true;
    if (words >= 3 && /\d/.test(text)) return true;
    return false;
  }

  function hasMeaningfulContent(value, depth = 0) {
    if (depth > 7) return false;
    if (value == null) return false;
    if (typeof value === 'string') return hasMeaningfulNarrative(value);
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.some((item) => hasMeaningfulContent(item, depth + 1));
    if (typeof value !== 'object') return false;

    for (const [k, v] of Object.entries(value)) {
      if (isTransientSynthesisKey(k)) continue;
      if (SKIP_KEYS.has(k) && !['subtitle', 'keyMessage', 'slideTitle'].includes(k)) continue;
      if (hasMeaningfulContent(v, depth + 1)) return true;
    }
    return false;
  }

  function sanitizeSectionPayload(value, depth = 0) {
    if (depth > 8) return value;
    if (value == null) return value;
    if (typeof value === 'string') {
      if (hasTruncationArtifactText(value) || hasSemanticEmptyText(value)) return '';
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => sanitizeSectionPayload(item, depth + 1));
    if (typeof value !== 'object') return value;

    const cleaned = {};
    for (const [key, child] of Object.entries(value)) {
      if (isTransientSynthesisKey(key)) continue;
      cleaned[key] = sanitizeSectionPayload(child, depth + 1);
    }
    return cleaned;
  }

  // Keys that should never be treated as data blocks (metadata, flags, primitives)
  const SKIP_KEYS = new Set([
    '_synthesisError',
    '_wasArray',
    'message',
    'slideTitle',
    'subtitle',
    'keyMessage',
    'section',
    'dataType',
    'sources',
    'confidenceScore',
  ]);

  /**
   * Detect the best dataType for an unknown/dynamic data block based on its data shape.
   * This is purely structural — no industry-specific keywords.
   */
  function detectDynamicDataType(data) {
    if (!data || typeof data !== 'object') return 'section_summary';

    // Has players/partners array → company comparison
    if (Array.isArray(data.players) && data.players.length > 0) return 'company_comparison';
    if (Array.isArray(data.partners) && data.partners.length > 0) return 'company_comparison';

    // Has chartData with series → market chart
    if (data.chartData?.series && data.chartData.series.length > 0)
      return 'time_series_multi_insight';
    if (data.chartData?.values && data.chartData.values.length > 0) return 'composition_breakdown';

    // Has acts/regulations array → regulation list
    if (Array.isArray(data.acts) && data.acts.length > 0) return 'regulation_list';
    if (Array.isArray(data.regulations) && data.regulations.length > 0) return 'regulation_list';

    // Has options array (entry strategy, etc.) → comparison table
    if (Array.isArray(data.options) && data.options.length > 0) return 'comparison_table';

    // Has phases array → timeline/roadmap
    if (Array.isArray(data.phases) && data.phases.length > 0) return 'timeline';

    // Has segments/targets arrays → structured list
    if (Array.isArray(data.segments) && data.segments.length > 0) return 'structured_list';
    if (Array.isArray(data.targets) && data.targets.length > 0) return 'structured_list';

    // Has criteria array (go/no-go style) → assessment
    if (Array.isArray(data.criteria) && data.criteria.length > 0) return 'assessment';

    // Has key findings / data points arrays → data summary
    if (Array.isArray(data.keyFindings) && data.keyFindings.length > 0) return 'data_summary';
    if (Array.isArray(data.dataPoints) && data.dataPoints.length > 0) return 'data_summary';

    // Has failures/case studies → case study
    if (Array.isArray(data.failures) && data.failures.length > 0) return 'case_study';
    if (Array.isArray(data.caseStudies) && data.caseStudies.length > 0) return 'case_study';

    // Has deadlines/triggers → timing
    if (Array.isArray(data.deadlines) && data.deadlines.length > 0) return 'timing';
    if (Array.isArray(data.triggers) && data.triggers.length > 0) return 'timing';

    // Has opportunities/obstacles structure → opportunities_vs_barriers
    if (Array.isArray(data.opportunities) && Array.isArray(data.obstacles))
      return 'opportunities_vs_barriers';

    // Fallback: generic section summary
    return 'section_summary';
  }

  /**
   * Generate a human-readable label from a data key.
   * Handles: camelCase, snake_case, and prefixed keys.
   */
  function keyToLabel(key) {
    // Remove common prefixes like policy_, market_, depth_, etc.
    let label = key.replace(/^(policy|market|competitors|depth|insight|context)_\d*_?/i, '');
    // camelCase → words
    label = label.replace(/([A-Z])/g, ' $1');
    // snake_case → words
    label = label.replace(/_/g, ' ');
    // Capitalize first letter of each word
    label = label.replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    return label || key;
  }

  /**
   * Discover dynamic keys in sectionData that aren't handled by hardcoded block logic.
   * Returns an array of blocks for unknown keys with auto-detected data types.
   */
  function discoverDynamicBlocks(sectionData, sectionCategory, citations, dataQuality) {
    const dynamicBlocks = [];
    if (!ENABLE_DYNAMIC_BLOCK_DISCOVERY) return dynamicBlocks;
    if (!sectionData || typeof sectionData !== 'object') return dynamicBlocks;

    for (const [key, value] of Object.entries(sectionData)) {
      // Skip known keys, metadata, primitives, and arrays at top level
      if (KNOWN_HARDCODED_KEYS.has(key)) continue;
      if (SKIP_KEYS.has(key)) continue;
      if (isTransientSynthesisKey(key)) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

      const dataType = detectDynamicDataType(value);
      const label = value.slideTitle
        ? value.slideTitle.replace(new RegExp(`^${country}\\s*-?\\s*`, 'i'), '').trim()
        : keyToLabel(key);

      dynamicBlocks.push({
        key: key,
        _isDynamic: true,
        _sectionCategory: sectionCategory,
        dataType: value.dataType || dataType,
        data: value,
        title: value.slideTitle || `${country} - ${label}`,
        subtitle: value.subtitle || value.keyInsight || value.keyMessage || '',
        citations: value.sources && Array.isArray(value.sources) ? value.sources : citations,
        dataQuality: value.dataQuality || dataQuality,
      });
    }

    return dynamicBlocks;
  }

  function resolveBlockTemplate(block) {
    const overrideSelection = templateSlideSelections?.[block.key];
    const routeDecision = resolveTemplateRouteWithGeometryGuard({
      blockKey: block.key,
      dataType: block.dataType,
      data: block.data,
      templateSelection: overrideSelection,
      tableContextKeys: TABLE_TEMPLATE_CONTEXTS,
      chartContextKeys: CHART_TEMPLATE_CONTEXTS,
    });
    const resolved = routeDecision.resolved;
    const layout = routeDecision.layout;
    if (routeDecision.recovered) {
      const recoveryMsg = `[PPT TEMPLATE] ${block.key}: recovered ${routeDecision.requiredGeometry || 'template'} route from slide ${routeDecision.fromSlide || 'n/a'} to ${routeDecision.toSlide || 'n/a'} (${routeDecision.reason || 'compatibility'})`;
      if (strictGeometryMode) {
        throw new Error(
          `[STRICT GEOMETRY] Hard fail: geometry recovery not allowed in strict mode. Block "${block.key}" required ${routeDecision.requiredGeometry || 'template'} geometry on slide ${routeDecision.fromSlide || 'n/a'} but had to recover to slide ${routeDecision.toSlide || 'n/a'}. Fix the template mapping or slide geometry.`
        );
      }
      console.warn(recoveryMsg);
    }
    const sourceLabel = ensureString(resolved.source, '').toLowerCase();
    const hasFallbackSource = sourceLabel.includes('fallback');
    const hasTemplateSlide =
      Number.isFinite(Number(resolved.selectedSlide)) && Number(resolved.selectedSlide) > 0;
    if (hasFallbackSource || !resolved.isTemplateBacked || !hasTemplateSlide) {
      throw new Error(
        `[PPT TEMPLATE] Missing explicit template route for block "${block.key}" (pattern=${resolved.patternKey || 'none'}, slide=${resolved.selectedSlide || 'none'}, source=${resolved.source || 'unknown'})`
      );
    }
    if (!layout) {
      throw new Error(
        `[PPT TEMPLATE] Missing extracted layout for block "${block.key}" on template slide ${resolved.selectedSlide}`
      );
    }
    const missingLayoutKeys = ['title', 'source', 'content'].filter(
      (key) =>
        !layout[key] ||
        !Number.isFinite(Number(layout[key].x)) ||
        !Number.isFinite(Number(layout[key].y)) ||
        !Number.isFinite(Number(layout[key].w)) ||
        !Number.isFinite(Number(layout[key].h))
    );
    if (missingLayoutKeys.length > 0) {
      throw new Error(
        `[PPT TEMPLATE] Incomplete layout extraction for block "${block.key}" (slide ${resolved.selectedSlide} missing: ${missingLayoutKeys.join(', ')})`
      );
    }
    if (TABLE_TEMPLATE_CONTEXTS.has(block.key) && !layout.table) {
      throw new Error(
        `[PPT TEMPLATE] Missing table geometry for table block "${block.key}" on template slide ${resolved.selectedSlide}`
      );
    }
    if (
      CHART_TEMPLATE_CONTEXTS.has(block.key) &&
      (!Array.isArray(layout.charts) || layout.charts.length === 0)
    ) {
      throw new Error(
        `[PPT TEMPLATE] Missing chart geometry for chart block "${block.key}" on template slide ${resolved.selectedSlide}`
      );
    }
    block._templatePattern = resolved.patternKey;
    block._templateSlide = resolved.selectedSlide;
    block._templateSource = resolved.source;
    templateUsageStats.resolved.push({
      key: block.key,
      pattern: resolved.patternKey,
      slide: resolved.selectedSlide,
      source: resolved.source,
      templateBacked: resolved.isTemplateBacked,
    });
    if (!resolved.isTemplateBacked) {
      templateUsageStats.nonTemplatePatterns.push({
        key: block.key,
        pattern: resolved.patternKey,
      });
    }
    return resolved;
  }

  // Classify data blocks in a section for pattern selection
  function classifyDataBlocks(sectionName, sectionData) {
    const blocks = [];

    switch (sectionName) {
      case 'Policy & Regulations': {
        // Prefer synthesis-level sources, fall back to raw data citations
        const policySynthSources =
          sectionData.sources &&
          Array.isArray(sectionData.sources) &&
          sectionData.sources.length > 0
            ? sectionData.sources
            : getCitationsForCategory('policy_');
        const foundActs = sectionData.foundationalActs || {};
        blocks.push({
          key: 'foundationalActs',
          dataType: 'regulation_list',
          data: foundActs,
          title:
            foundActs.slideTitle ||
            `${country} - ${scope.industry || 'Industry'} Foundational Acts`,
          subtitle: foundActs.subtitle || foundActs.keyMessage || '',
          citations: policySynthSources,
          dataQuality: getDataQualityForCategory('policy_'),
        });

        const natPolicy = sectionData.nationalPolicy || {};
        blocks.push({
          key: 'nationalPolicy',
          dataType: 'policy_analysis',
          data: natPolicy,
          title:
            natPolicy.slideTitle || `${country} - National ${scope.industry || 'Industry'} Policy`,
          subtitle: natPolicy.policyDirection || '',
          citations: policySynthSources,
          dataQuality: getDataQualityForCategory('policy_'),
        });

        const investRestrict = sectionData.investmentRestrictions || {};
        blocks.push({
          key: 'investmentRestrictions',
          dataType: 'regulation_list',
          data: investRestrict,
          title: investRestrict.slideTitle || `${country} - Foreign Investment Rules`,
          subtitle: investRestrict.riskJustification || '',
          citations: policySynthSources,
          dataQuality: getDataQualityForCategory('policy_'),
        });

        const keyIncentives = sectionData.keyIncentives || [];
        if (Array.isArray(keyIncentives) && keyIncentives.length > 0) {
          blocks.push({
            key: 'keyIncentives',
            dataType: 'regulation_list',
            data: { incentives: keyIncentives },
            title: `${country} - Key Investment Incentives`,
            subtitle: `${keyIncentives.length} incentive programs identified`,
            citations: policySynthSources,
            dataQuality: getDataQualityForCategory('policy_'),
          });
        }

        // Dynamic key discovery: pick up any synthesis keys not handled above
        if (ENABLE_DYNAMIC_BLOCK_DISCOVERY) {
          const policyDynamic = discoverDynamicBlocks(
            sectionData,
            'policy',
            policySynthSources,
            getDataQualityForCategory('policy_')
          );
          if (policyDynamic.length > 0) {
            console.log(
              `  [PPT] Policy: discovered ${policyDynamic.length} dynamic block(s): ${policyDynamic.map((b) => b.key).join(', ')}`
            );
            blocks.push(...policyDynamic);
          }
        }
        break;
      }

      case 'Market Overview': {
        const marketCitations = getCitationsForCategory('market_');
        const marketDQ = getDataQualityForCategory('market_');
        // Hardcoded fallback keys (energy-specific)
        const hardcodedMarketKeys = [
          'tpes',
          'finalDemand',
          'electricity',
          'gasLng',
          'pricing',
          'escoMarket',
        ];
        const hardcodedLabels = {
          tpes: 'Total Primary Energy Supply',
          finalDemand: 'Final Energy Demand',
          electricity: 'Electricity & Power',
          gasLng: 'Gas & LNG Market',
          pricing: 'Energy Pricing',
          escoMarket: 'ESCO Market',
        };

        // Canonical market sections from synthesis contract (stable template mapping).
        const canonicalMarketCandidates = [
          {
            keys: ['marketSizeAndGrowth'],
            defaultTitle: `${country} - Market Size & Growth`,
          },
          {
            keys: ['supplyAndDemandDynamics', 'supplyAndDemandData'],
            defaultTitle: `${country} - Supply & Demand Dynamics`,
          },
          {
            keys: ['pricingAndTariffStructures', 'pricingAndEconomics', 'pricingAndCostBenchmarks'],
            defaultTitle: `${country} - Pricing & Tariff Structures`,
          },
        ];

        const marketKeys = [];
        for (const candidate of canonicalMarketCandidates) {
          const matchedKey = candidate.keys.find(
            (k) =>
              sectionData[k] &&
              typeof sectionData[k] === 'object' &&
              !Array.isArray(sectionData[k]) &&
              !isTransientSynthesisKey(k)
          );
          if (matchedKey) {
            marketKeys.push({ key: matchedKey, defaultTitle: candidate.defaultTitle });
          }
        }

        // Legacy energy schema fallback when canonical keys are absent.
        if (marketKeys.length === 0) {
          for (const key of hardcodedMarketKeys) {
            const value = sectionData[key];
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            if (isTransientSynthesisKey(key)) continue;
            marketKeys.push({ key, defaultTitle: `${country} - ${hardcodedLabels[key] || key}` });
          }
        }

        // Optional debugging fallback (disabled in production).
        if (marketKeys.length === 0 && ENABLE_DYNAMIC_BLOCK_DISCOVERY) {
          for (const key of Object.keys(sectionData || {})) {
            if (KNOWN_HARDCODED_KEYS.has(key) || SKIP_KEYS.has(key)) continue;
            if (isTransientSynthesisKey(key)) continue;
            const value = sectionData[key];
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            marketKeys.push({
              key,
              defaultTitle: `${country} - ${keyToLabel(key)}`,
            });
          }
        }

        for (const marketKey of marketKeys) {
          const key = marketKey.key;
          const subData = sectionData[key] || {};
          const label =
            hardcodedLabels[key] ||
            subData.slideTitle ||
            (key.startsWith('section_')
              ? `Market Analysis ${parseInt(key.split('_')[1] || '0', 10) + 1}`
              : key
                  .replace(/([A-Z])/g, ' $1')
                  .replace(/^./, (s) => s.toUpperCase())
                  .trim());
          // Prefer synthesis-level sources over raw data citations
          const subSources =
            subData.sources && Array.isArray(subData.sources) && subData.sources.length > 0
              ? subData.sources
              : marketCitations;
          blocks.push({
            key: key,
            _isMarket: true,
            dataType: subData.dataType || detectMarketDataType(key, subData),
            data: subData,
            title: subData.slideTitle || marketKey.defaultTitle || `${country} - ${label}`,
            subtitle: subData.subtitle || subData.keyMessage || '',
            citations: subSources,
            dataQuality: marketDQ,
          });
        }
        break;
      }

      case 'Competitive Landscape': {
        const compRawCitations = getCitationsForCategory('competitors_');
        // Prefer synthesis-level sources from any competitor sub-section
        const compSynthSources = [
          sectionData.japanesePlayers,
          sectionData.localMajor,
          sectionData.foreignPlayers,
        ]
          .filter((d) => d?.sources && Array.isArray(d.sources))
          .flatMap((d) => d.sources);
        const compCitations =
          compSynthSources.length > 0 ? compSynthSources.slice(0, 5) : compRawCitations;
        const compDQ = getDataQualityForCategory('competitors_');

        blocks.push({
          key: 'japanesePlayers',
          dataType: 'company_comparison',
          data: sectionData.japanesePlayers || {},
          title:
            (sectionData.japanesePlayers || {}).slideTitle ||
            `${country} - Japanese ${scope.industry || 'Industry'} Companies`,
          subtitle:
            (sectionData.japanesePlayers || {}).marketInsight ||
            (sectionData.japanesePlayers || {}).subtitle ||
            '',
          citations: compCitations,
          dataQuality: compDQ,
        });

        blocks.push({
          key: 'localMajor',
          dataType: 'company_comparison',
          data: sectionData.localMajor || {},
          title: (sectionData.localMajor || {}).slideTitle || `${country} - Major Local Players`,
          subtitle:
            (sectionData.localMajor || {}).concentration ||
            (sectionData.localMajor || {}).subtitle ||
            '',
          citations: compCitations,
          dataQuality: compDQ,
        });

        blocks.push({
          key: 'foreignPlayers',
          dataType: 'company_comparison',
          data: sectionData.foreignPlayers || {},
          title:
            (sectionData.foreignPlayers || {}).slideTitle ||
            `${country} - Foreign ${scope.industry || 'Industry'} Companies`,
          subtitle:
            (sectionData.foreignPlayers || {}).competitiveInsight ||
            (sectionData.foreignPlayers || {}).subtitle ||
            '',
          citations: compCitations,
          dataQuality: compDQ,
        });

        blocks.push({
          key: 'caseStudy',
          dataType: 'case_study',
          data: sectionData.caseStudy || {},
          title: (sectionData.caseStudy || {}).slideTitle || `${country} - Market Entry Case Study`,
          subtitle:
            (sectionData.caseStudy || {}).applicability ||
            (sectionData.caseStudy || {}).subtitle ||
            '',
          citations: compCitations,
          dataQuality: compDQ,
        });

        blocks.push({
          key: 'maActivity',
          dataType: 'section_summary',
          data: sectionData.maActivity || {},
          title: (sectionData.maActivity || {}).slideTitle || `${country} - M&A Activity`,
          subtitle:
            (sectionData.maActivity || {}).valuationMultiples ||
            (sectionData.maActivity || {}).subtitle ||
            '',
          citations: compCitations,
          dataQuality: compDQ,
        });

        // Dynamic key discovery: pick up any competitor keys not handled above
        if (ENABLE_DYNAMIC_BLOCK_DISCOVERY) {
          const compDynamic = discoverDynamicBlocks(
            sectionData,
            'competitors',
            compCitations,
            compDQ
          );
          if (compDynamic.length > 0) {
            console.log(
              `  [PPT] Competitors: discovered ${compDynamic.length} dynamic block(s): ${compDynamic.map((b) => b.key).join(', ')}`
            );
            blocks.push(...compDynamic);
          }
        }
        break;
      }

      case 'Strategic Analysis': {
        const depthCitations = getCitationsForCategory('depth_');
        const depthDQ = getDataQualityForCategory('depth_');

        // Support both new generic key (dealEconomics) and legacy key (escoEconomics)
        const dealEconData = sectionData.dealEconomics || sectionData.escoEconomics || {};
        blocks.push({
          key: 'dealEconomics',
          dataType: 'financial_performance',
          data: dealEconData,
          title:
            dealEconData.slideTitle ||
            `${country} - ${scope.industry || 'Industry'} Deal Economics`,
          subtitle: dealEconData.keyInsight || dealEconData.subtitle || '',
          citations: depthCitations,
          dataQuality: depthDQ,
        });

        blocks.push({
          key: 'partnerAssessment',
          dataType: 'company_comparison',
          data: sectionData.partnerAssessment || {},
          title:
            (sectionData.partnerAssessment || {}).slideTitle || `${country} - Partner Assessment`,
          subtitle:
            (sectionData.partnerAssessment || {}).recommendedPartner ||
            (sectionData.partnerAssessment || {}).subtitle ||
            '',
          citations: depthCitations,
          dataQuality: depthDQ,
        });

        blocks.push({
          key: 'entryStrategy',
          dataType: 'section_summary',
          data: sectionData.entryStrategy || {},
          title:
            (sectionData.entryStrategy || {}).slideTitle || `${country} - Entry Strategy Options`,
          subtitle:
            (sectionData.entryStrategy || {}).recommendation ||
            (sectionData.entryStrategy || {}).subtitle ||
            '',
          citations: depthCitations,
          dataQuality: depthDQ,
        });

        blocks.push({
          key: 'implementation',
          dataType: 'section_summary',
          data: sectionData.implementation || {},
          title:
            (sectionData.implementation || {}).slideTitle || `${country} - Implementation Roadmap`,
          subtitle: `Total: ${(sectionData.implementation || {}).totalInvestment || 'TBD'} | Breakeven: ${(sectionData.implementation || {}).breakeven || 'TBD'}`,
          citations: depthCitations,
          dataQuality: depthDQ,
        });

        blocks.push({
          key: 'targetSegments',
          dataType: 'section_summary',
          data: sectionData.targetSegments || {},
          title:
            (sectionData.targetSegments || {}).slideTitle ||
            `${country} - Target Customer Segments`,
          subtitle:
            (sectionData.targetSegments || {}).goToMarketApproach ||
            (sectionData.targetSegments || {}).subtitle ||
            '',
          citations: depthCitations,
          dataQuality: depthDQ,
        });

        // Dynamic key discovery: pick up any depth/strategic keys not handled above
        if (ENABLE_DYNAMIC_BLOCK_DISCOVERY) {
          const depthDynamic = discoverDynamicBlocks(sectionData, 'depth', depthCitations, depthDQ);
          if (depthDynamic.length > 0) {
            console.log(
              `  [PPT] Strategic Analysis: discovered ${depthDynamic.length} dynamic block(s): ${depthDynamic.map((b) => b.key).join(', ')}`
            );
            blocks.push(...depthDynamic);
          }
        }
        break;
      }

      case 'Recommendations': {
        blocks.push({
          key: 'goNoGo',
          dataType: 'section_summary',
          data: sectionData.goNoGo || {},
          title: `${country} - Go/No-Go Assessment`,
          subtitle: (sectionData.goNoGo || {}).overallVerdict || 'Investment Decision Framework',
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'opportunitiesObstacles',
          dataType: 'opportunities_vs_barriers',
          data: {
            opportunities: sectionData.opportunities,
            obstacles: sectionData.obstacles,
            ratings: sectionData.ratings,
            recommendation: sectionData.recommendation,
          },
          title: `${country} - Opportunities & Obstacles`,
          subtitle: sectionData.recommendation || '',
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'keyInsights',
          dataType: 'section_summary',
          data: { insights: sectionData.keyInsights, recommendation: sectionData.recommendation },
          title: `${country} - Key Insights`,
          subtitle: 'Strategic implications for market entry',
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'timingIntelligence',
          dataType: 'section_summary',
          data: sectionData.timingIntelligence || {},
          title: (sectionData.timingIntelligence || {}).slideTitle || `${country} - Why Now?`,
          subtitle:
            (sectionData.timingIntelligence || {}).windowOfOpportunity ||
            'Time-sensitive factors driving urgency',
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'lessonsLearned',
          dataType: 'case_study',
          data: sectionData.lessonsLearned || {},
          title:
            (sectionData.lessonsLearned || {}).slideTitle || `${country} - Lessons from Market`,
          subtitle: (sectionData.lessonsLearned || {}).subtitle || 'What previous entrants learned',
          citations: [],
          dataQuality: 'unknown',
        });

        // Dynamic key discovery: pick up any recommendation/summary keys not handled above
        if (ENABLE_DYNAMIC_BLOCK_DISCOVERY) {
          const recoDynamic = discoverDynamicBlocks(sectionData, 'summary', [], 'unknown');
          if (recoDynamic.length > 0) {
            console.log(
              `  [PPT] Recommendations: discovered ${recoDynamic.length} dynamic block(s): ${recoDynamic.map((b) => b.key).join(', ')}`
            );
            blocks.push(...recoDynamic);
          }
        }
        break;
      }
    }

    return blocks;
  }

  // Auto-detect market data type from sub-section data shape
  function detectMarketDataType(key, data) {
    if (data.chartData?.series && data.chartData.series.length >= 2) {
      return 'time_series_multi_insight';
    }
    if (data.chartData?.series) return 'time_series_simple';
    if (data.chartData?.values) return 'composition_breakdown';
    if (key === 'gasLng' && data.chartData?.series) return 'two_related_series';
    return 'section_summary';
  }

  // ============ PATTERN-BASED SLIDE GENERATION ============

  // Generate a slide for a market chart block with insight panels (chart left 60%, insights right 40%)
  function generateMarketChartSlide(slide, block) {
    const data = block.data;
    const chartData = data.chartData;
    const pattern = ensureString(block._templatePattern, '').trim();
    if (!pattern) {
      throw new Error(`[PPT TEMPLATE] Missing template pattern for market block "${block.key}"`);
    }
    if (!templatePatterns.patterns?.[pattern]) {
      throw new Error(
        `[PPT TEMPLATE] Unknown template pattern "${pattern}" for market block "${block.key}"`
      );
    }

    // Collect insights for the panel
    const insights = collectMarketInsights(block.key, data);

    if (
      pattern === 'chart_callout_dual' &&
      chartData?.series &&
      chartData.series.length >= 2 &&
      block.dataType !== 'composition_breakdown'
    ) {
      // Dual chart: split series into two charts and prefer exact template chart boxes when available.
      const halfLen = Math.ceil(chartData.series.length / 2);
      const leftSeries = { ...chartData, series: chartData.series.slice(0, halfLen) };
      const rightSeries = { ...chartData, series: chartData.series.slice(halfLen) };
      const leftRect = getActiveLayoutRect('chart', { x: 0.36, y: 1.86, w: 6.1, h: 3.8 }, 0);
      const rightRect = getActiveLayoutRect('chart', { x: 6.86, y: 1.86, w: 6.1, h: 3.8 }, 1);
      const hasTemplateDualCharts =
        activeTemplateContext.layout &&
        Array.isArray(activeTemplateContext.layout.charts) &&
        activeTemplateContext.layout.charts.length >= 2;
      if (hasTemplateDualCharts) {
        const chartType = block.key === 'gasLng' ? 'line' : 'bar';
        const chartTitle = getChartTitle(block.key, data);
        if (chartType === 'line') {
          addLineChart(slide, chartTitle, leftSeries, leftRect);
          addLineChart(slide, chartTitle, rightSeries, rightRect);
        } else {
          addStackedBarChart(slide, chartTitle, leftSeries, leftRect);
          addStackedBarChart(slide, chartTitle, rightSeries, rightRect);
        }
        recordGeometryCheck(
          'chart',
          `${block.key}:left`,
          activeTemplateContext.layout.charts[0],
          leftRect
        );
        recordGeometryCheck(
          'chart',
          `${block.key}:right`,
          activeTemplateContext.layout.charts[1],
          rightRect
        );
      } else {
        if (CHART_TEMPLATE_CONTEXTS.has(block.key)) {
          noteMissingGeometry(
            'chart',
            block.key,
            `No dual-chart geometry found for selected template slide ${activeTemplateContext.slideNumber}`
          );
        }
        addDualChart(
          slide,
          { chartData: leftSeries, title: '', type: 'bar' },
          { chartData: rightSeries, title: '', type: 'bar' },
          null,
          {
            callout: insights.length > 0 ? { title: 'Key Insight', text: insights[0] } : null,
          }
        );
      }
      return;
    }

    // Standard chart + insight panels layout
    const hasChartSeries = chartData && chartData.series && chartData.series.length > 0;
    const hasChartValues = chartData && chartData.values && chartData.values.length > 0;

    if (hasChartSeries || hasChartValues) {
      // Chart on left 60% — positions from template JSON
      const chartPattern =
        templatePatterns.patterns?.[pattern]?.elements ||
        templatePatterns.patterns?.chart_insight_panels?.elements ||
        {};
      const chartPos = chartPattern.chart || {};
      const fallbackRect = {
        x: chartPos.x || LEFT_MARGIN,
        y: chartPos.y || CONTENT_Y,
        w: chartPos.w || 7.8,
        h: chartPos.h || 4.5,
      };
      const resolvedChartRect = getActiveLayoutRect('chart', fallbackRect, 0);
      const chartOpts = {
        x: resolvedChartRect.x,
        y: resolvedChartRect.y,
        w: resolvedChartRect.w,
        h: resolvedChartRect.h,
      };
      const hasInsightPanelRoom = chartOpts.x + chartOpts.w <= 8.3;
      if (activeTemplateContext.layout?.charts?.[0]) {
        recordGeometryCheck('chart', block.key, activeTemplateContext.layout.charts[0], chartOpts);
      } else if (CHART_TEMPLATE_CONTEXTS.has(block.key)) {
        noteMissingGeometry(
          'chart',
          block.key,
          `No chart geometry found for selected template slide ${activeTemplateContext.slideNumber}`
        );
      }
      const chartTitle = getChartTitle(block.key, data);

      if (hasChartSeries) {
        // Determine chart type
        if (
          block.key === 'gasLng' ||
          block.key === 'pricing' ||
          block.dataType === 'time_series_annotated'
        ) {
          addLineChart(slide, chartTitle, chartData, chartOpts);
        } else {
          addStackedBarChart(slide, chartTitle, chartData, chartOpts);
        }
      } else if (hasChartValues) {
        if (block.key === 'electricity') {
          addPieChart(slide, chartTitle, chartData, chartOpts);
        } else {
          addBarChart(slide, chartTitle, chartData, chartOpts);
        }
      }

      // Insight panels on right 40% using pattern library
      if (insights.length > 0 && hasInsightPanelRoom) {
        const insightPanels = insights.slice(0, 3).map((text, idx) => ({
          title: idx === 0 ? 'Key Insight' : idx === 1 ? 'Market Data' : 'Opportunity',
          text: ensureString(text),
        }));
        addInsightPanelsFromPattern(slide, insightPanels);
      }

      // Add callout overlay on chart area for key data point
      if (data.keyInsight) {
        addCalloutOverlay(slide, ensureString(data.keyInsight));
      }
      // Add synthesis-driven market outlook if available (fallback to countryAnalysis)
      const growthTrajectory =
        enrichment.marketOpportunityAssessment?.growthTrajectory ||
        countryAnalysis?.summary?.marketOpportunityAssessment?.growthTrajectory ||
        null;
      if (growthTrajectory) {
        addCalloutBox(
          slide,
          'Market Outlook',
          typeof growthTrajectory === 'string'
            ? growthTrajectory
            : JSON.stringify(growthTrajectory),
          { x: LEFT_MARGIN + 0.5, y: 5.55, w: 7.0, h: 1.0, type: 'insight' }
        );
      }
    } else {
      // No chart data - render text insights as structured content blocks
      if (insights.length > 0) {
        const overview = data.overview ? ensureString(data.overview) : null;
        const keyInsight = data.keyInsight ? ensureString(data.keyInsight) : null;
        let currentY = CONTENT_Y;

        // Main overview block
        if (overview) {
          addCalloutBox(slide, 'Overview', overview, {
            x: LEFT_MARGIN,
            y: currentY,
            w: CONTENT_WIDTH,
            h: 1.4,
            type: 'insight',
          });
          currentY += 1.55;
        }

        // Remaining insights as bullet list
        const remainingInsights = insights
          .filter((ins) => ins !== overview && ins !== keyInsight)
          .slice(0, 6);
        if (remainingInsights.length > 0) {
          const bulletText = remainingInsights.map((t) => `\u2022 ${ensureString(t)}`).join('\n');
          slide.addText(bulletText, {
            x: LEFT_MARGIN,
            y: currentY,
            w: CONTENT_WIDTH,
            h: Math.min(2.5, remainingInsights.length * 0.45 + 0.3),
            fontSize: 12,
            fontFace: FONT,
            color: COLORS.darkGray,
            valign: 'top',
            wrap: true,
            lineSpacingMultiple: 1.2,
          });
          currentY += Math.min(2.5, remainingInsights.length * 0.45 + 0.3) + 0.15;
        }

        // Key insight callout at bottom
        if (keyInsight) {
          addCalloutOverlay(slide, keyInsight, {
            x: LEFT_MARGIN + 0.5,
            y: currentY,
            w: CONTENT_WIDTH - 1.0,
            h: 0.55,
          });
        }
      } else {
        // Last resort: scan ALL string fields in data for anything renderable
        const fallbackTexts = [];
        if (data && typeof data === 'object') {
          for (const [fk, fv] of Object.entries(data)) {
            if (typeof fv === 'string' && fv.length > 20 && fv.length < 3000) {
              fallbackTexts.push(ensureString(fv));
            }
          }
        }
        if (fallbackTexts.length > 0) {
          const combinedText = fallbackTexts.slice(0, 4).join('\n\n');
          slide.addText(combinedText, {
            x: LEFT_MARGIN,
            y: CONTENT_Y,
            w: CONTENT_WIDTH,
            h: 4.5,
            fontSize: CONTENT_MIN_FONT_PT,
            fontFace: FONT,
            color: COLORS.darkGray,
            valign: 'top',
            wrap: true,
            lineSpacingMultiple: 1.3,
          });
        } else {
          addDataUnavailableMessage(slide, `${block.key} data not available`);
        }
      }
    }
  }

  // Collect market insights from structured data for a given market sub-section
  function collectMarketInsights(key, data) {
    const insights = [];

    switch (key) {
      case 'tpes':
        if (data.structuredData?.marketBreakdown?.totalPrimaryEnergySupply) {
          const bd = data.structuredData.marketBreakdown.totalPrimaryEnergySupply;
          if (bd.naturalGasPercent) insights.push(`Natural Gas: ${bd.naturalGasPercent}`);
          if (bd.renewablePercent) insights.push(`Renewable: ${bd.renewablePercent}`);
        }
        // keyInsight rendered in callout overlay, not duplicated here
        if (data.narrative) insights.push(ensureString(data.narrative));
        break;

      case 'finalDemand':
        if (data.structuredData?.marketBreakdown?.totalFinalConsumption) {
          const c = data.structuredData.marketBreakdown.totalFinalConsumption;
          if (c.industryPercent) insights.push(`Industry: ${c.industryPercent}`);
          if (c.transportPercent) insights.push(`Transport: ${c.transportPercent}`);
        }
        safeArray(data.keyDrivers, 2).forEach((d) => insights.push(ensureString(d)));
        break;

      case 'electricity':
        if (data.demandGrowth) insights.push(`Demand Growth: ${data.demandGrowth}`);
        if (data.totalCapacity) insights.push(`Capacity: ${data.totalCapacity}`);
        if (data.keyTrend) insights.push(ensureString(data.keyTrend));
        if (data.structuredData?.marketBreakdown?.electricityGeneration) {
          const gen = data.structuredData.marketBreakdown.electricityGeneration;
          if (gen.current) insights.push(`Current: ${gen.current}`);
          if (gen.projected2030) insights.push(`2030 Target: ${gen.projected2030}`);
        }
        break;

      case 'gasLng':
        if (data.structuredData?.infrastructureCapacity) {
          const infra = data.structuredData.infrastructureCapacity;
          if (infra.lngImportCurrent) insights.push(`LNG Import: ${infra.lngImportCurrent}`);
          if (infra.lngImportPlanned) insights.push(`Planned: ${infra.lngImportPlanned}`);
          if (infra.pipelineCapacity) insights.push(`Pipeline: ${infra.pipelineCapacity}`);
        }
        if (data.pipelineNetwork) insights.push(ensureString(data.pipelineNetwork));
        break;

      case 'pricing':
        if (data.structuredData?.priceComparison) {
          const prices = data.structuredData.priceComparison;
          if (prices.generationCost) insights.push(`Generation: ${prices.generationCost}`);
          if (prices.retailPrice) insights.push(`Retail: ${prices.retailPrice}`);
          if (prices.industrialRate) insights.push(`Industrial: ${prices.industrialRate}`);
        }
        if (data.outlook) insights.push(ensureString(data.outlook));
        if (data.comparison) insights.push(`Regional: ${ensureString(data.comparison)}`);
        break;

      case 'escoMarket':
        if (data.marketSize) insights.push(`Market Size: ${data.marketSize}`);
        if (data.growthRate) insights.push(`Growth: ${data.growthRate}`);
        if (data.structuredData?.escoMarketState) {
          const state = data.structuredData.escoMarketState;
          if (state.registeredESCOs) insights.push(`Registered ESCOs: ${state.registeredESCOs}`);
          if (state.totalProjects) insights.push(`Total Projects: ${state.totalProjects}`);
        }
        if (data.keyDrivers) insights.push(ensureString(data.keyDrivers));
        break;

      default:
        // Generic insight extraction for dynamic market keys.
        if (data.overview) insights.push(ensureString(data.overview));
        if (data.keyInsight) insights.push(ensureString(data.keyInsight));
        if (Array.isArray(data.keyMetrics)) {
          data.keyMetrics.forEach((m) => {
            if (m && m.metric && m.value) {
              insights.push(`${m.metric}: ${m.value}${m.context ? ` (${m.context})` : ''}`);
            }
          });
        }
        if (data.narrative) insights.push(ensureString(data.narrative));
        safeArray(data.keyDrivers, 3).forEach((d) => insights.push(ensureString(d)));
        if (data.marketSize) insights.push(`Market Size: ${data.marketSize}`);
        if (data.growthRate) insights.push(`Growth: ${data.growthRate}`);
        if (data.demandGrowth) insights.push(`Demand Growth: ${data.demandGrowth}`);
        if (data.totalCapacity) insights.push(`Capacity: ${data.totalCapacity}`);
        // Keep fallback extraction intentionally narrow to avoid verbose/truncated blocks.
        if (insights.length === 0 && data && typeof data === 'object') {
          const fallbackFields = [
            'outlook',
            'comparison',
            'regulatoryImpact',
            'demandOutlook',
            'supplyOutlook',
          ];
          for (const field of fallbackFields) {
            const value = data[field];
            if (typeof value === 'string' && value.length > 15) {
              insights.push(ensureString(value));
            }
            if (insights.length >= 4) break;
          }
        }
        break;
    }

    return insights;
  }

  // Get chart title based on market sub-section key
  function getChartTitle(key, data) {
    const unit = data.chartData?.unit || '';
    switch (key) {
      case 'tpes':
        return `TPES by Source (${unit || 'Mtoe'})`;
      case 'finalDemand':
        return `Demand by Sector (${unit || '%'})`;
      case 'electricity':
        return `Power Generation Mix (${unit || '%'})`;
      case 'gasLng':
        return `Gas Supply Trend (${unit || 'bcm'})`;
      case 'pricing':
        return 'Energy Price Trends';
      case 'escoMarket':
        return `Market Segments (${unit || '%'})`;
      default:
        return data.chartData?.title || 'Market Data';
    }
  }

  // Generate slides for a specific market sub-section that also has a table (e.g. gasLng terminals, escoMarket segments)
  function addMarketSubTable(slide, block) {
    const data = block.data;
    const hasChart = !!(
      (data.chartData?.series && data.chartData.series.length > 0) ||
      (data.chartData?.values && data.chartData.values.length > 0)
    );

    if (block.key === 'gasLng') {
      const terminals = safeArray(data.lngTerminals, 3);
      const termStartY = hasChart ? 5.65 : 2.5;
      if (terminals.length > 0 && termStartY < CONTENT_BOTTOM - 0.6) {
        const termRows = [tableHeader(['Terminal', 'Capacity', 'Utilization'])];
        terminals.forEach((t) => {
          termRows.push([
            { text: safeCell(t.name, 30) },
            { text: safeCell(t.capacity) },
            { text: safeCell(t.utilization) },
          ]);
        });
        const termColWidths = calculateColumnWidths(termRows, CONTENT_WIDTH);
        applyAlternateRowFill(termRows);
        safeAddTable(slide, termRows, {
          x: LEFT_MARGIN,
          y: termStartY,
          w: CONTENT_WIDTH,
          h: Math.min(0.8, CONTENT_BOTTOM - termStartY),
          fontSize: 14,
          fontFace: FONT,
          border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
          margin: TABLE_CELL_MARGIN,
          colW: termColWidths.length > 0 ? termColWidths : [4.0, 4.25, 4.35],
          valign: 'top',
        });
      }
    }

    if (block.key === 'escoMarket') {
      const segments = safeArray(data.segments, 4);
      if (segments.length > 0) {
        const segRows = [tableHeader(['Segment', 'Size', 'Share'])];
        segments.forEach((s) => {
          segRows.push([
            { text: safeCell(s.name) },
            { text: safeCell(s.size) },
            { text: safeCell(s.share) },
          ]);
        });
        const segColWidths = calculateColumnWidths(segRows, CONTENT_WIDTH);
        const segStartY = hasChart ? 6.1 : 3.2;
        applyAlternateRowFill(segRows);
        safeAddTable(slide, segRows, {
          x: LEFT_MARGIN,
          y: segStartY,
          w: CONTENT_WIDTH,
          h: Math.min(1.3, segRows.length * 0.35 + 0.2, CONTENT_BOTTOM - segStartY),
          fontSize: 14,
          fontFace: FONT,
          border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
          margin: TABLE_CELL_MARGIN,
          colW: segColWidths.length > 0 ? segColWidths : [5.48, 3.56, 3.56],
          valign: 'top',
        });
      }
    }
  }

  // Generate a slide for a company comparison block (Japanese/Local/Foreign players)
  function generateCompanySlide(slide, block) {
    const data = block.data;
    const players = safeArray(data.players || data.partners, 5)
      .map(ensureWebsite)
      .map(enrichDescription);

    // Build dynamic insights
    const compInsights = [];
    if (data.marketInsight) compInsights.push(ensureString(data.marketInsight));
    if (data.concentration) compInsights.push(ensureString(data.concentration));
    if (data.competitiveInsight) compInsights.push(ensureString(data.competitiveInsight));
    if (data.recommendedPartner) compInsights.push(`Top Pick: ${data.recommendedPartner}`);
    if (players.length > 0) {
      compInsights.push(`${players.length} players identified`);
      const topPlayer = players[0];
      if (topPlayer.marketShare)
        compInsights.push(`Leader: ${topPlayer.name} (${topPlayer.marketShare})`);
    }

    if (players.length === 0) {
      addDataUnavailableMessage(slide, `${block.key} data not available`);
      return;
    }

    const tableStartY = CONTENT_Y;

    // Determine columns based on block type
    let headerCols, rowBuilder, defaultColW;

    if (block.key === 'partnerAssessment') {
      headerCols = [
        'Company',
        'Type',
        'Revenue',
        'Partnership Fit',
        'Acquisition Fit',
        'Description',
      ];
      defaultColW = [1.8, 1.2, 1.2, 1.2, 1.2, 6.0];
      rowBuilder = (p) => {
        const website = sanitizeHyperlinkUrl(p.website);
        return [
          website
            ? {
                text: safeCell(p.name, 35),
                options: { hyperlink: { url: website }, color: COLORS.hyperlink },
              }
            : { text: safeCell(p.name, 35) },
          { text: safeCell(p.type, 30) },
          { text: safeCell(p.revenue) },
          { text: p.partnershipFit ? `${safeCell(p.partnershipFit)}/5` : '' },
          { text: p.acquisitionFit ? `${safeCell(p.acquisitionFit)}/5` : '' },
          { text: safeCell(p.description, 220), options: { fontSize: 14 } },
        ];
      };
    } else if (block.key === 'foreignPlayers') {
      headerCols = ['Company', 'Origin', 'Mode', 'Description'];
      defaultColW = [1.8, 1.2, 1.2, 8.4];
      rowBuilder = (p) => {
        // Build description with revenue and entryYear prepended (skip if already in description)
        const descParts = [];
        const baseDesc =
          safeCell(p.description, 220) ||
          `${safeCell(p.success, 140)} ${formatProjects(p.projects)}`.trim() ||
          '';
        if (p.revenue && !baseDesc.includes(safeCell(p.revenue)))
          descParts.push(`Revenue: ${safeCell(p.revenue)}.`);
        if (p.entryYear && !baseDesc.includes(safeCell(p.entryYear)))
          descParts.push(`Entered: ${safeCell(p.entryYear)}.`);
        if (baseDesc) descParts.push(baseDesc);
        const desc = safeCell(descParts.join(' '), 240);
        const website = sanitizeHyperlinkUrl(p.website);
        return [
          website
            ? {
                text: safeCell(p.name),
                options: { hyperlink: { url: website }, color: COLORS.hyperlink },
              }
            : { text: safeCell(p.name) },
          { text: safeCell(p.origin) },
          { text: safeCell(p.mode) },
          { text: ensureString(desc), options: { fontSize: 14 } },
        ];
      };
    } else if (block.key === 'localMajor') {
      headerCols = ['Company', 'Type', 'Revenue', 'Description'];
      defaultColW = [1.8, 1.2, 1.2, 8.4];
      rowBuilder = (p) => {
        // Build description with revenue prepended if not already in a column
        const descParts = [];
        const baseDesc =
          safeCell(p.description, 220) ||
          `${safeCell(p.strengths, 120)} ${safeCell(p.weaknesses, 120)}`.trim() ||
          (p.projects ? `Projects: ${formatProjects(p.projects)}` : '') ||
          '';
        if (baseDesc) descParts.push(baseDesc);
        const desc = safeCell(descParts.join(' '), 240);
        const website = sanitizeHyperlinkUrl(p.website);
        return [
          website
            ? {
                text: safeCell(p.name),
                options: { hyperlink: { url: website }, color: COLORS.hyperlink },
              }
            : { text: safeCell(p.name) },
          { text: safeCell(p.type) },
          { text: safeCell(p.revenue) },
          { text: ensureString(desc), options: { fontSize: 14 } },
        ];
      };
    } else {
      // japanesePlayers default
      headerCols = ['Company', 'Entry Year', 'Mode', 'Description'];
      defaultColW = [2.0, 1.0, 1.2, 8.4];
      rowBuilder = (p) => {
        // Build description with revenue prepended (skip if already in description)
        const descParts = [];
        const baseDesc =
          safeCell(p.description, 220) || formatProjects(p.projects) || safeCell(p.assessment, 140);
        if (p.revenue && (!baseDesc || !baseDesc.includes(safeCell(p.revenue))))
          descParts.push(`Revenue: ${safeCell(p.revenue)}.`);
        if (baseDesc) descParts.push(baseDesc);
        const desc = safeCell(descParts.join(' '), 240);
        const website = sanitizeHyperlinkUrl(p.website);
        return [
          website
            ? {
                text: safeCell(p.name),
                options: { hyperlink: { url: website }, color: COLORS.hyperlink },
              }
            : { text: safeCell(p.name) },
          { text: safeCell(p.entryYear) },
          { text: safeCell(p.mode) },
          { text: ensureString(desc), options: { fontSize: 14 } },
        ];
      };
    }

    const rows = [tableHeader(headerCols)];
    players.forEach((p) => rows.push(rowBuilder(p)));
    const colWidths = calculateColumnWidths(rows, CONTENT_WIDTH);
    const tableH = safeTableHeight(rows.length, { fontSize: 14, maxH: 4.5 });

    applyAlternateRowFill(rows);
    safeAddTable(
      slide,
      rows,
      {
        x: LEFT_MARGIN,
        y: tableStartY,
        w: CONTENT_WIDTH,
        h: tableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: colWidths.length > 0 ? colWidths : defaultColW,
        valign: 'top',
      },
      block.key
    );

    // Add insights below table
    const compInsightY = tableStartY + tableH + 0.15;
    if (compInsights.length > 0) {
      addCalloutBox(slide, 'Competitive Insights', compInsights.slice(0, 4).join(' | '), {
        x: LEFT_MARGIN,
        y: compInsightY,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
    }
    // Add synthesis-driven competitive insight if available (fallback to countryAnalysis)
    let compRecoY = compInsights.length > 0 ? compInsightY + 0.65 + 0.1 : compInsightY;
    const whiteSpaces =
      enrichment.competitivePositioning?.whiteSpaces ||
      countryAnalysis?.summary?.competitivePositioning?.whiteSpaces ||
      null;
    if (
      whiteSpaces &&
      (Array.isArray(whiteSpaces) ? whiteSpaces.length > 0 : true) &&
      compRecoY < CONTENT_BOTTOM - 0.55
    ) {
      addCalloutBox(
        slide,
        'Competitive Insight',
        Array.isArray(whiteSpaces) ? whiteSpaces.join('. ') : String(whiteSpaces),
        { x: LEFT_MARGIN, y: compRecoY, w: CONTENT_WIDTH, h: 0.8, type: 'insight' }
      );
      compRecoY += 0.8 + 0.1;
    }

    // Potential partners from Stage 3 competitivePositioning
    const potentialPartners =
      enrichment.competitivePositioning?.potentialPartners ||
      countryAnalysis?.summary?.competitivePositioning?.potentialPartners ||
      null;
    if (
      potentialPartners &&
      (Array.isArray(potentialPartners) ? potentialPartners.length > 0 : true) &&
      compRecoY < CONTENT_BOTTOM - 0.55
    ) {
      addCalloutBox(
        slide,
        'Potential Partners',
        Array.isArray(potentialPartners) ? potentialPartners.join(', ') : String(potentialPartners),
        { x: LEFT_MARGIN, y: compRecoY, w: CONTENT_WIDTH, h: 0.8, type: 'insight' }
      );
      compRecoY += 0.8 + 0.1;
    }

    // Strategic assessment panel: show top 2-3 players' strategicAssessment
    const playersWithAssessment = players.filter((p) => p.strategicAssessment).slice(0, 3);
    if (playersWithAssessment.length > 0 && compRecoY < CONTENT_BOTTOM - 0.5) {
      const assessmentParts = [];
      playersWithAssessment.forEach((p, idx) => {
        if (idx > 0) {
          assessmentParts.push({
            text: '\n',
            options: { fontSize: CONTENT_MIN_FONT_PT, color: COLORS.darkGray, fontFace: FONT },
          });
        }
        assessmentParts.push({
          text: ensureString(p.name) + ': ',
          options: {
            fontSize: CONTENT_MIN_FONT_PT,
            bold: true,
            color: COLORS.darkGray,
            fontFace: FONT,
          },
        });
        assessmentParts.push({
          text: ensureString(p.strategicAssessment),
          options: { fontSize: CONTENT_MIN_FONT_PT, color: COLORS.darkGray, fontFace: FONT },
        });
      });
      const assessH = Math.min(clampH(compRecoY, 1.2), 0.3 + playersWithAssessment.length * 0.3);
      slide.addText(assessmentParts, {
        x: LEFT_MARGIN,
        y: compRecoY,
        w: CONTENT_WIDTH,
        h: assessH,
        fill: { color: COLORS.white },
        line: { color: COLORS.gray, pt: 1 },
        margin: [4, 8, 4, 8],
        valign: 'top',
      });
    }
  }

  // Generate a pattern-based slide for a single data block.
  // Hard-fail on render errors so malformed slides never reach output.
  function generatePatternSlide(block) {
    const templateLayout =
      Number.isFinite(Number(block._templateSlide)) && block._templateSlide > 0
        ? getTemplateSlideLayout(block._templateSlide)
        : null;
    activeTemplateContext.blockKey = block.key;
    activeTemplateContext.slideNumber = block._templateSlide || null;
    activeTemplateContext.layout = templateLayout;
    if (block._templateSlide && !templateLayout) {
      noteMissingGeometry(
        'layout',
        block.key,
        `No extracted layout found for template slide ${block._templateSlide}`
      );
    }
    const slide = addSlideWithTitle(block.title, block.subtitle, {
      citations: block.citations,
      dataQuality: block.dataQuality,
      templateLayout,
    });
    registerTemplateCloneSlide(block._templateSlide, block.key);
    if (block._templatePattern) {
      console.log(
        `  [PPT TEMPLATE] ${block.key} -> ${block._templatePattern}${block._templateSlide ? ` (slide ${block._templateSlide})` : ''} [${block._templateSource || 'auto'}]`
      );
    }

    try {
      const renderMarketBlock = () => {
        generateMarketChartSlide(slide, block);
        addMarketSubTable(slide, block);
      };
      const rendererRegistry = {
        // Policy
        foundationalActs: () => renderFoundationalActs(slide, block.data),
        nationalPolicy: () => renderNationalPolicy(slide, block.data),
        investmentRestrictions: () => renderInvestmentRestrictions(slide, block.data),
        keyIncentives: () => renderKeyIncentives(slide, block.data),
        regulatorySummary: () => renderFoundationalActs(slide, block.data),
        // Market
        marketSizeAndGrowth: renderMarketBlock,
        supplyAndDemandDynamics: renderMarketBlock,
        supplyAndDemandData: renderMarketBlock,
        pricingAndTariffStructures: renderMarketBlock,
        pricingAndEconomics: renderMarketBlock,
        pricingAndCostBenchmarks: renderMarketBlock,
        infrastructureAndGrid: renderMarketBlock,
        tpes: renderMarketBlock,
        finalDemand: renderMarketBlock,
        electricity: renderMarketBlock,
        gasLng: renderMarketBlock,
        pricing: renderMarketBlock,
        escoMarket: renderMarketBlock,
        // Competitors
        japanesePlayers: () => generateCompanySlide(slide, block),
        localMajor: () => generateCompanySlide(slide, block),
        foreignPlayers: () => generateCompanySlide(slide, block),
        partnerAssessment: () => generateCompanySlide(slide, block),
        caseStudy: () => renderCaseStudy(slide, block.data),
        maActivity: () => renderMAActivity(slide, block.data),
        // Depth
        dealEconomics: () => renderDealEconomics(slide, block.data),
        escoEconomics: () => renderDealEconomics(slide, block.data), // legacy key
        entryStrategy: () => renderEntryStrategy(slide, block.data),
        implementation: () => renderImplementation(slide, block.data),
        targetSegments: () => renderTargetSegments(slide, block.data),
        // Summary
        goNoGo: () => renderGoNoGo(slide, block.data),
        opportunitiesObstacles: () => renderOpportunitiesObstacles(slide, block.data),
        keyInsights: () => renderKeyInsights(slide, block.data),
        timingIntelligence: () => renderTimingIntelligence(slide, block.data),
        lessonsLearned: () => renderLessonsLearned(slide, block.data),
      };
      const renderer = rendererRegistry[block.key];
      if (typeof renderer !== 'function') {
        const knownKeys = Object.keys(rendererRegistry).sort().join(', ');
        throw new Error(
          `Unsupported block key "${block.key}" (pattern=${block._templatePattern || 'none'}). Known keys: ${knownKeys}`
        );
      }
      renderer();
    } catch (err) {
      console.error(`[PPT] Slide "${block.key}" failed: ${err.message}`);
      templateUsageStats.slideRenderFailures.push({
        key: block.key,
        pattern: block._templatePattern || null,
        error: err.message,
      });
      // Recovery: add placeholder instead of crashing — let remaining slides render
      addDataUnavailableMessage(slide, 'Content rendering failed for this section');
    }

    return slide;
  }

  // ============ GENERIC CONTENT SLIDE RENDERER ============
  // Renders any dynamic/unknown block by detecting the data shape and choosing
  // the best layout: table, chart+insights, bullet list, or text content.
  // This ensures dynamic framework topics always produce visible slides.

  function renderGenericContentSlide(slide, block) {
    const data = block.data;
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
      addDataUnavailableMessage(slide, `${block.key} data not available`);
      return;
    }

    const detectedType = block.dataType || detectDynamicDataType(data);
    console.log(`  [PPT] Generic render for "${block.key}" (type: ${detectedType})`);

    // Route to existing specialized renderers where data shape matches
    switch (detectedType) {
      case 'company_comparison': {
        // Delegate to the company slide renderer
        generateCompanySlide(slide, block);
        return;
      }

      case 'time_series_multi_insight':
      case 'time_series_simple':
      case 'composition_breakdown': {
        // Delegate to market chart renderer
        generateMarketChartSlide(slide, block);
        return;
      }

      case 'opportunities_vs_barriers': {
        renderOpportunitiesObstacles(slide, data);
        return;
      }

      case 'case_study': {
        renderCaseStudy(slide, data);
        return;
      }

      default:
        break;
    }

    // Generic rendering: extract structured content from the data
    let currentY = CONTENT_Y;

    // 1. Overview / narrative text block
    const overview = data.overview || data.narrative || data.summary || data.description || '';
    if (overview && typeof overview === 'string' && overview.length > 15) {
      addCalloutBox(slide, 'Overview', ensureString(overview), {
        x: LEFT_MARGIN,
        y: currentY,
        w: CONTENT_WIDTH,
        h: 1.4,
        type: 'insight',
      });
      currentY += 1.55;
    }

    // 2. Table from array data (find first significant array of objects)
    const arrayFields = Object.entries(data).filter(
      ([k, v]) =>
        Array.isArray(v) &&
        v.length > 0 &&
        typeof v[0] === 'object' &&
        v[0] !== null &&
        !['sources', 'citations'].includes(k)
    );

    if (arrayFields.length > 0 && currentY < CONTENT_BOTTOM - 1.0) {
      const [arrayKey, arrayData] = arrayFields[0];
      const items = arrayData.slice(0, 8); // Max 8 rows

      // Auto-detect columns from first item's keys (skip long text fields for columns)
      const sampleItem = items[0];
      const allKeys = Object.keys(sampleItem).filter(
        (k) => typeof sampleItem[k] !== 'object' || sampleItem[k] === null
      );

      if (allKeys.length > 0) {
        // Use up to 5 columns
        const colKeys = allKeys.slice(0, 5);
        const headerLabels = colKeys.map((k) =>
          k
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, (s) => s.toUpperCase())
            .trim()
        );

        const rows = [tableHeader(headerLabels)];
        items.slice(0, 8).forEach((item) => {
          rows.push(
            colKeys.map((k) => ({
              text: safeCell(item[k] != null ? String(item[k]) : '', 140),
            }))
          );
        });

        const tableH = safeTableHeight(rows.length, {
          fontSize: 14,
          maxH: Math.max(1.0, CONTENT_BOTTOM - currentY - 1.0),
        });
        const colW = calculateColumnWidths(rows, CONTENT_WIDTH);
        applyAlternateRowFill(rows);
        safeAddTable(
          slide,
          rows,
          {
            x: LEFT_MARGIN,
            y: currentY,
            w: CONTENT_WIDTH,
            h: tableH,
            fontSize: 14,
            fontFace: FONT,
            border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
            margin: TABLE_CELL_MARGIN,
            colW: colW.length > 0 ? colW : undefined,
            valign: 'top',
          },
          block.key || 'genericTable'
        );
        currentY += tableH + 0.15;
      }
    }

    // 3. Key metrics as formatted text
    const keyMetrics = data.keyMetrics || data.dataPoints || data.keyFindings || [];
    if (Array.isArray(keyMetrics) && keyMetrics.length > 0 && currentY < CONTENT_BOTTOM - 0.5) {
      const metricTexts = keyMetrics.slice(0, 5).map((m) => {
        if (typeof m === 'string') return m;
        if (m.metric && m.value)
          return `${m.metric}: ${m.value}${m.context ? ` (${m.context})` : ''}`;
        if (m.finding) return `${m.finding}${m.data ? ` — ${m.data}` : ''}`;
        return ensureString(m);
      });
      const bulletText = metricTexts.map((t) => `\u2022 ${ensureString(t)}`).join('\n');
      const bulletsH = Math.min(2.0, metricTexts.length * 0.4 + 0.2, CONTENT_BOTTOM - currentY);
      slide.addText(bulletText, {
        x: LEFT_MARGIN,
        y: currentY,
        w: CONTENT_WIDTH,
        h: bulletsH,
        fontSize: 12,
        fontFace: FONT,
        color: COLORS.darkGray,
        valign: 'top',
        wrap: true,
        lineSpacingMultiple: 1.2,
      });
      currentY += bulletsH + 0.15;
    }

    // 4. Key insight callout
    const keyInsight = data.keyInsight || data.keyMessage || data.recommendation || '';
    if (
      keyInsight &&
      typeof keyInsight === 'string' &&
      keyInsight.length > 10 &&
      currentY < CONTENT_BOTTOM - 0.5
    ) {
      addCalloutOverlay(slide, ensureString(keyInsight), {
        x: LEFT_MARGIN + 0.5,
        y: currentY,
        w: CONTENT_WIDTH - 1.0,
        h: 0.55,
      });
      currentY += 0.7;
    }

    // 5. Last resort: scan ALL remaining string fields for renderable content
    if (currentY <= CONTENT_Y + 0.1) {
      // Nothing was rendered yet — extract any text from data
      const fallbackTexts = [];
      for (const [fk, fv] of Object.entries(data)) {
        if (typeof fv === 'string' && fv.length > 20 && fv.length < 3000) {
          fallbackTexts.push(ensureString(fv));
        } else if (Array.isArray(fv) && fv.length > 0 && typeof fv[0] === 'string') {
          fv.slice(0, 4).forEach((s) => {
            if (typeof s === 'string' && s.length > 10) fallbackTexts.push(ensureString(s));
          });
        }
      }
      if (fallbackTexts.length > 0) {
        const combinedText = fallbackTexts.slice(0, 6).join('\n\n');
        slide.addText(combinedText, {
          x: LEFT_MARGIN,
          y: CONTENT_Y,
          w: CONTENT_WIDTH,
          h: Math.min(4.5, CONTENT_BOTTOM - CONTENT_Y),
          fontSize: CONTENT_MIN_FONT_PT,
          fontFace: FONT,
          color: COLORS.darkGray,
          valign: 'top',
          wrap: true,
          lineSpacingMultiple: 1.3,
        });
      } else {
        addDataUnavailableMessage(slide, `${block.key} data not available`);
      }
    }
  }

  // ============ SECTION RENDERERS ============

  function renderFoundationalActs(slide, data) {
    const acts = safeArray(data.acts, 5);
    if (acts.length > 0) {
      const actsRows = [tableHeader(['Act Name', 'Year', 'Requirements', 'Enforcement'])];
      acts.forEach((act) => {
        // Combine penalties into requirements cell to preserve table width
        let reqText = safeCell(act.requirements, 150);
        const penaltiesText = ensureString(act.penalties);
        if (penaltiesText) {
          reqText += `\nPenalties: ${ensureString(penaltiesText)}`;
        }
        actsRows.push([
          { text: safeCell(act.name, 45) },
          { text: safeCell(act.year) },
          { text: reqText },
          { text: safeCell(act.enforcement, 80) },
        ]);
      });
      const actsTableH = safeTableHeight(actsRows.length, { fontSize: 14, maxH: 4.5 });
      applyAlternateRowFill(actsRows);
      safeAddTable(
        slide,
        actsRows,
        {
          x: LEFT_MARGIN,
          y: CONTENT_Y,
          w: CONTENT_WIDTH,
          h: actsTableH,
          fontSize: 14,
          fontFace: FONT,
          border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
          margin: TABLE_CELL_MARGIN,
          colW: [2.96, 1.08, 4.53, 4.03],
          valign: 'top',
        },
        'foundationalActs'
      );
      // Key message summary below table if available
      let actsNextY = CONTENT_Y + actsTableH + 0.15;
      const keyMessage = ensureString(data.keyMessage);
      if (keyMessage && actsNextY < CONTENT_BOTTOM - 0.5) {
        slide.addText(ensureString(keyMessage), {
          x: LEFT_MARGIN,
          y: actsNextY,
          w: CONTENT_WIDTH,
          h: 0.35,
          fontSize: CONTENT_MIN_FONT_PT,
          italic: true,
          color: COLORS.secondary,
          fontFace: FONT,
        });
        actsNextY += 0.4;
      }
      // Synthesis-driven regulatory insight if available (fallback to countryAnalysis)
      const actsRecoY = actsNextY + 0.7 + 0.1;
      const keyRegulations =
        enrichment.regulatoryPathway?.keyRegulations ||
        countryAnalysis?.summary?.regulatoryPathway?.keyRegulations ||
        null;
      if (keyRegulations && actsRecoY < CONTENT_BOTTOM - 0.7) {
        addCalloutBox(
          slide,
          'Regulatory Insight',
          typeof keyRegulations === 'string' ? keyRegulations : JSON.stringify(keyRegulations),
          { x: LEFT_MARGIN, y: actsRecoY, w: CONTENT_WIDTH, h: 0.6, type: 'insight' }
        );
      }
    } else {
      addDataUnavailableMessage(slide, 'Legislation data not available');
      return;
    }
  }

  function renderNationalPolicy(slide, data) {
    const targets = safeArray(data.targets, 4);
    if (targets.length === 0 && safeArray(data.keyInitiatives, 4).length === 0) {
      addDataUnavailableMessage(slide, 'National policy data not available');
      return;
    }
    let policyNextY = CONTENT_Y;
    if (targets.length > 0) {
      const targetRows = [tableHeader(['Metric', 'Target', 'Deadline', 'Status'])];
      targets.forEach((t) => {
        targetRows.push([
          { text: safeCell(t.metric) },
          { text: safeCell(t.target, 80) },
          { text: safeCell(t.deadline, 60) },
          { text: safeCell(t.status, 80) },
        ]);
      });
      const policyTableH = safeTableHeight(targetRows.length, { fontSize: 14, maxH: 2.5 });
      applyAlternateRowFill(targetRows);
      safeAddTable(slide, targetRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: policyTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: [4.13, 3.09, 2.69, 2.69],
        valign: 'top',
      });
      policyNextY = CONTENT_Y + policyTableH + 0.15;
    }
    const initiatives = safeArray(data.keyInitiatives, 4);
    if (initiatives.length > 0) {
      const initY = policyNextY;
      slide.addText('Key Initiatives', {
        x: LEFT_MARGIN,
        y: initY,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 14,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      const initBulletsH = clampH(initY + 0.35, 1.4);
      slide.addText(
        initiatives.map((i) => ({ text: ensureString(i), options: { bullet: true } })),
        {
          x: LEFT_MARGIN,
          y: initY + 0.35,
          w: CONTENT_WIDTH,
          h: initBulletsH,
          fontSize: 12,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
    }
    // Add synthesis-driven policy timeline if available (fallback to countryAnalysis)
    const policyTimeline =
      enrichment.regulatoryPathway?.timeline ||
      countryAnalysis?.summary?.regulatoryPathway?.timeline ||
      null;
    if (policyTimeline && policyNextY < CONTENT_BOTTOM - 0.8) {
      addCalloutBox(
        slide,
        'Policy Timeline',
        typeof policyTimeline === 'string' ? policyTimeline : JSON.stringify(policyTimeline),
        { x: LEFT_MARGIN, y: policyNextY, w: CONTENT_WIDTH, h: 0.7, type: 'insight' }
      );
      policyNextY += 0.7 + 0.15;
    }
  }

  function renderInvestmentRestrictions(slide, data) {
    const ownership = data.ownershipLimits || {};
    // Early return if all data fields are empty
    if (
      !ownership.general &&
      !ownership.promoted &&
      !data.riskLevel &&
      safeArray(data.incentives, 1).length === 0 &&
      !data.riskJustification
    ) {
      addDataUnavailableMessage(slide, 'Investment restrictions data not available');
      return;
    }
    const ownershipRows = [tableHeader(['Category', 'Limit', 'Details'])];
    if (ownership.general)
      ownershipRows.push([
        { text: 'General Sectors' },
        { text: safeCell(ownership.general) },
        { text: safeCell(ownership.exceptions, 100) },
      ]);
    if (ownership.promoted)
      ownershipRows.push([
        {
          text: safeCell(ownership.category || ownership.type || 'Promoted Investment'),
        },
        { text: safeCell(ownership.promoted) },
        {
          text: safeCell(ownership.promotedDetails || ownership.incentiveDetails || ''),
        },
      ]);
    let investNextY = CONTENT_Y;
    if (ownershipRows.length > 1) {
      const ownerTableH = safeTableHeight(ownershipRows.length, { fontSize: 14, maxH: 1.8 });
      applyAlternateRowFill(ownershipRows);
      safeAddTable(slide, ownershipRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: ownerTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: [3.36, 2.02, 7.22],
        valign: 'top',
      });
      investNextY = CONTENT_Y + ownerTableH + 0.15;
    }
    const incentivesList = safeArray(data.incentives, 3);
    if (incentivesList.length > 0) {
      const incRows = [tableHeader(['Incentive', 'Benefit', 'Eligibility'])];
      incentivesList.forEach((inc) => {
        incRows.push([
          { text: safeCell(inc.name) },
          { text: safeCell(inc.benefit) },
          { text: safeCell(inc.eligibility, 50) },
        ]);
      });
      const incTableH = safeTableHeight(incRows.length, {
        fontSize: 14,
        maxH: Math.max(0.6, CONTENT_BOTTOM - investNextY - 1.0),
      });
      applyAlternateRowFill(incRows);
      safeAddTable(slide, incRows, {
        x: LEFT_MARGIN,
        y: investNextY,
        w: CONTENT_WIDTH,
        h: incTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: [3.36, 3.36, 5.88],
        valign: 'top',
      });
      investNextY = investNextY + incTableH + 0.15;
    }
    if (data.riskLevel && investNextY < CONTENT_BOTTOM - 0.4) {
      const riskLevelStr = ensureString(data.riskLevel, '').toLowerCase();
      const riskColor = riskLevelStr.includes('high')
        ? COLORS.red
        : riskLevelStr.includes('low')
          ? COLORS.green
          : COLORS.orange;
      slide.addText(`Regulatory Risk: ${safeCell(data.riskLevel).toUpperCase()}`, {
        x: LEFT_MARGIN,
        y: investNextY,
        w: CONTENT_WIDTH,
        h: 0.4,
        fontSize: 14,
        bold: true,
        color: riskColor,
        fontFace: FONT,
      });
      investNextY += 0.45;
      // Show riskJustification below the risk level label
      const riskJustification = ensureString(data.riskJustification);
      if (riskJustification && investNextY < CONTENT_BOTTOM - 0.4) {
        slide.addText(ensureString(riskJustification), {
          x: LEFT_MARGIN,
          y: investNextY,
          w: CONTENT_WIDTH,
          h: 0.35,
          fontSize: CONTENT_MIN_FONT_PT,
          color: COLORS.secondary,
          fontFace: FONT,
        });
        investNextY += 0.4;
      }
    }
    // Licensing requirements from Stage 3
    const licensingReqs =
      enrichment.regulatoryPathway?.licensingRequirements ||
      countryAnalysis?.summary?.regulatoryPathway?.licensingRequirements ||
      null;
    if (licensingReqs && investNextY < CONTENT_BOTTOM - 0.8) {
      addCalloutBox(
        slide,
        'Licensing Requirements',
        typeof licensingReqs === 'string' ? licensingReqs : JSON.stringify(licensingReqs),
        { x: LEFT_MARGIN, y: investNextY, w: CONTENT_WIDTH, h: 0.7, type: 'insight' }
      );
      investNextY += 0.7 + 0.15;
    }
    const regRisks =
      enrichment.regulatoryPathway?.risks ||
      countryAnalysis?.summary?.regulatoryPathway?.risks ||
      null;
    if (regRisks && investNextY < CONTENT_BOTTOM - 0.8) {
      addCalloutBox(
        slide,
        'Investment Risk',
        typeof regRisks === 'string' ? regRisks : JSON.stringify(regRisks),
        { x: LEFT_MARGIN, y: investNextY, w: CONTENT_WIDTH, h: 0.7, type: 'warning' }
      );
    }
  }

  function renderKeyIncentives(slide, data) {
    const incentives = safeArray(data.incentives, 5);
    if (incentives.length === 0) {
      addDataUnavailableMessage(slide, 'Key incentives data not available');
      return;
    }
    const incRows = [tableHeader(['Initiative', 'Key Content', 'Highlights', 'Implications'])];
    incentives.forEach((inc) => {
      incRows.push([
        { text: safeCell(inc.initiative || inc.name, 25) },
        { text: safeCell(inc.keyContent, 60) },
        { text: safeCell(inc.highlights, 40) },
        { text: safeCell(inc.implications, 50) },
      ]);
    });
    const incTableH = safeTableHeight(incRows.length, { fontSize: 14, maxH: 4.5 });
    applyAlternateRowFill(incRows);
    safeAddTable(
      slide,
      incRows,
      {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: incTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: [2.5, 3.5, 3.1, 3.5],
        valign: 'top',
      },
      'keyIncentives'
    );
  }

  function renderCaseStudy(slide, data) {
    const successCases = safeArray(data.successes, 3);
    const failureCases = safeArray(data.failures, 3);
    const normalizedLessons = [
      ...safeArray(data.keyLessons, 4),
      ...safeArray(data.successFactors, 3),
      ...failureCases.map((f) => ensureString(f?.lesson)).filter(Boolean),
    ].filter(Boolean);
    const hasStructuredCaseRows = successCases.length > 0 || failureCases.length > 0;

    if (!data.company && normalizedLessons.length === 0 && !hasStructuredCaseRows) {
      addDataUnavailableMessage(slide, 'Case study data not available');
      return;
    }

    // Use addCaseStudyRows pattern for rich rendering
    const caseRows = [
      { label: 'Company', content: safeCell(data.company, 220) },
      { label: 'Entry Year', content: safeCell(data.entryYear, 120) },
      { label: 'Entry Mode', content: safeCell(data.entryMode, 220) },
      { label: 'Investment', content: safeCell(data.investment, 220) },
      { label: 'Outcome', content: safeCell(data.outcome, 320) },
    ].filter((row) => row.content);
    if (caseRows.length === 0 && hasStructuredCaseRows) {
      const leadCase = successCases[0] || failureCases[0] || {};
      caseRows.push(
        { label: 'Company', content: safeCell(leadCase.company || leadCase.name, 220) },
        { label: 'Entry Mode', content: safeCell(leadCase.entryMode || leadCase.mode, 220) },
        { label: 'Outcome', content: safeCell(leadCase.outcome || leadCase.result, 320) },
        {
          label: 'Key Factor',
          content: safeCell(
            leadCase.keySuccessFactor || leadCase.reason || leadCase.lesson || data.subtitle,
            320
          ),
        }
      );
    }
    const lessons = normalizedLessons.slice(0, 4);
    const hasRightLessons = lessons.length > 0;
    if (caseRows.length > 0) {
      const casePatternOverride = hasRightLessons
        ? {
            ...(templatePatterns.patterns?.case_study_rows?.elements || {}),
            labelX: LEFT_MARGIN,
            labelW: 1.95,
            contentX: LEFT_MARGIN + 2.05,
            // Preserve room for right-side lesson panels (~x>=8.6) with a visible gutter.
            contentW: 6.2,
          }
        : undefined;
      addCaseStudyRows(slide, caseRows, null, casePatternOverride);
    }

    // Key lessons as insight panels on right side
    if (lessons.length > 0) {
      const lessonPanels = lessons.map((l, idx) => ({
        title: `Lesson ${idx + 1}`,
        text: ensureString(l),
      }));
      addInsightPanelsFromPattern(slide, lessonPanels);
    }

    if (data.applicability) {
      const sourceRect = getActiveLayoutRect('source', tpSource);
      const sourceTop = Number(sourceRect?.y) || Number(tpSource.y) || 6.7;
      const applicabilityText = `Applicability: ${ensureString(data.applicability)}`;

      if (hasRightLessons) {
        // Case-study slide uses right-side lesson panels; place applicability beneath them
        // without hard character clipping.
        const boxX = 8.78;
        const boxW = 4.12;
        const boxY = 5.84;
        const boxH = Math.max(0.5, Math.min(0.86, sourceTop - boxY - 0.03));
        if (boxH >= 0.24) {
          addCalloutBox(slide, '', applicabilityText, {
            x: boxX,
            y: boxY,
            w: boxW,
            h: boxH,
            type: 'insight',
          });
        }
      } else {
        // No right panels: keep applicability at the bottom of the content lane.
        const boxX = LEFT_MARGIN;
        const boxW = 8.45;
        const boxH = 0.42;
        const minY = CONTENT_Y + 4.95;
        const boxY = Math.max(minY, sourceTop - boxH - 0.06);
        if (boxY + boxH <= sourceTop - 0.02) {
          addCalloutOverlay(slide, applicabilityText, { x: boxX, y: boxY, w: boxW, h: boxH });
        }
      }
    }
  }

  function renderMAActivity(slide, data) {
    const deals =
      (safeArray(data.recentDeals, 3).length > 0
        ? safeArray(data.recentDeals, 3)
        : safeArray(data.keyDeals, 3).map((deal) => ({
            year: deal.year || deal.date || 'N/A',
            buyer: deal.buyer || deal.acquirer || 'N/A',
            target: deal.target || deal.asset || 'N/A',
            value: deal.value || deal.enterpriseValue || 'N/A',
            rationale: deal.rationale || deal.thesis || deal.notes || '',
          }))) || [];
    const potentialTargets = safeArray(data.potentialTargets, 3)
      .map(ensureWebsite)
      .map(enrichDescription);
    const fallbackTargets = safeArray(data.dealPipeline || data.targets || [], 3)
      .map((target) => ({
        name: target.name || target.company || target.target || 'N/A',
        estimatedValue: target.estimatedValue || target.value || 'N/A',
        rationale: target.rationale || target.notes || '',
        timing: target.timing || target.window || 'N/A',
        website: target.website || target.url || '',
      }))
      .map(ensureWebsite)
      .map(enrichDescription);
    const normalizedTargets = potentialTargets.length > 0 ? potentialTargets : fallbackTargets;

    const maInsights = [];
    if (data.valuationMultiples) maInsights.push(`Multiples: ${data.valuationMultiples}`);
    if (data.structuredData?.maActivity?.dealVolume) {
      maInsights.push(`Deal Volume: ${data.structuredData.maActivity.dealVolume}`);
    }
    if (deals.length > 0) maInsights.push(`${deals.length} recent deals identified`);
    if (normalizedTargets.length > 0)
      maInsights.push(`${normalizedTargets.length} potential targets`);

    if (deals.length === 0 && normalizedTargets.length === 0) {
      addDataUnavailableMessage(slide, 'M&A activity data not available');
      return;
    }

    let maNextY = CONTENT_Y;
    if (deals.length > 0) {
      slide.addText('Recent Transactions', {
        x: LEFT_MARGIN,
        y: maNextY,
        w: 8.5,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      maNextY += 0.35;
      const dealRows = [tableHeader(['Year', 'Buyer', 'Target', 'Value', 'Rationale'])];
      deals.forEach((d) => {
        dealRows.push([
          { text: safeCell(d.year) },
          { text: safeCell(d.buyer) },
          { text: safeCell(d.target) },
          { text: safeCell(d.value) },
          { text: safeCell(d.rationale, 30) },
        ]);
      });
      const dealColWidths = calculateColumnWidths(dealRows, CONTENT_WIDTH);
      const dealTableH = safeTableHeight(dealRows.length, { fontSize: 14, maxH: 2.0 });
      applyAlternateRowFill(dealRows);
      safeAddTable(slide, dealRows, {
        x: LEFT_MARGIN,
        y: maNextY,
        w: CONTENT_WIDTH,
        h: dealTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: dealColWidths.length > 0 ? dealColWidths : [1.08, 2.42, 2.42, 2.02, 4.66],
        valign: 'top',
      });
      maNextY += dealTableH + 0.15;
    }

    if (normalizedTargets.length > 0) {
      slide.addText('Potential Acquisition Targets', {
        x: LEFT_MARGIN,
        y: maNextY,
        w: 8.5,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      maNextY += 0.35;
      const targetRows = [tableHeader(['Company', 'Est. Value', 'Rationale', 'Timing'])];
      normalizedTargets.forEach((t) => {
        const website = sanitizeHyperlinkUrl(t.website);
        const nameCell = website
          ? {
              text: safeCell(t.name),
              options: { hyperlink: { url: website }, color: COLORS.hyperlink },
            }
          : { text: safeCell(t.name) };
        targetRows.push([
          nameCell,
          { text: safeCell(t.estimatedValue) },
          { text: safeCell(t.rationale, 40) },
          { text: safeCell(t.timing) },
        ]);
      });
      const targetColWidths = calculateColumnWidths(targetRows, CONTENT_WIDTH);
      const maTargetTableH = safeTableHeight(targetRows.length, {
        fontSize: 14,
        maxH: Math.max(0.6, CONTENT_BOTTOM - maNextY - 1.0),
      });
      applyAlternateRowFill(targetRows);
      safeAddTable(slide, targetRows, {
        x: LEFT_MARGIN,
        y: maNextY,
        w: CONTENT_WIDTH,
        h: maTargetTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: targetColWidths.length > 0 ? targetColWidths : [2.69, 2.02, 5.48, 2.41],
        valign: 'top',
      });
      maNextY += maTargetTableH + 0.15;
    }

    if (maInsights.length > 0) {
      addCalloutBox(slide, 'M&A Insights', maInsights.slice(0, 4).join(' | '), {
        x: LEFT_MARGIN,
        y: maNextY,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
    }
  }

  function renderDealEconomics(slide, data) {
    const rawDealSize = data.typicalDealSize;
    let dealSizeText = '';
    let dealSize = {};
    if (typeof rawDealSize === 'string') {
      dealSizeText = rawDealSize;
    } else if (rawDealSize && typeof rawDealSize === 'object') {
      dealSize = rawDealSize;
      dealSizeText =
        dealSize.average ||
        (dealSize.min && dealSize.max
          ? `${dealSize.min} - ${dealSize.max}`
          : dealSize.min || dealSize.max || 'Deal size under research');
    }
    const terms = data.contractTerms || {};
    const financials = data.financials || {};

    const econInsights = [];
    if (dealSizeText) econInsights.push(`Avg Deal: ${dealSizeText}`);
    if (financials.irr) econInsights.push(`Expected IRR: ${financials.irr}`);
    if (financials.paybackPeriod) econInsights.push(`Payback: ${financials.paybackPeriod}`);
    if (terms.duration) econInsights.push(`Contract: ${terms.duration}`);
    if (data.keyInsight) econInsights.push(ensureString(data.keyInsight));

    const econRows = [tableHeader(['Metric', 'Value', 'Notes'])];
    if (dealSizeText)
      econRows.push([
        { text: 'Typical Deal Size' },
        { text: safeCell(dealSizeText) },
        { text: dealSize.average ? `Avg: ${safeCell(dealSize.average)}` : '' },
      ]);
    if (terms.duration)
      econRows.push([
        { text: 'Contract Duration' },
        { text: safeCell(terms.duration) },
        { text: '' },
      ]);
    const revSplit = terms.revenueSplit || terms.savingsSplit;
    if (revSplit)
      econRows.push([
        { text: 'Revenue Split' },
        { text: safeCell(revSplit) },
        { text: safeCell(terms.guaranteeStructure) },
      ]);
    if (financials.paybackPeriod)
      econRows.push([
        { text: 'Payback Period' },
        { text: safeCell(financials.paybackPeriod) },
        { text: '' },
      ]);
    if (financials.irr)
      econRows.push([{ text: 'Expected IRR' }, { text: safeCell(financials.irr) }, { text: '' }]);
    if (financials.marginProfile)
      econRows.push([
        { text: 'Gross Margin' },
        { text: safeCell(financials.marginProfile) },
        { text: '' },
      ]);

    const financing = safeArray(data.financingOptions, 3);
    if (econRows.length === 1 && financing.length === 0) {
      addDataUnavailableMessage(slide, 'Economics data not available');
      return;
    }
    if (econRows.length > 1) {
      const econColWidths = calculateColumnWidths(econRows, CONTENT_WIDTH);
      applyAlternateRowFill(econRows);
      safeAddTable(slide, econRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: financing.length > 0 ? 3.0 : 4.0,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: econColWidths.length > 0 ? econColWidths : [2.5, 3.0, 7.1],
        valign: 'top',
      });
      if (econInsights.length > 0) {
        const econTableH = financing.length > 0 ? 3.0 : 4.0;
        addCalloutBox(slide, 'Deal Economics', econInsights.slice(0, 4).join(' | '), {
          x: LEFT_MARGIN,
          y: CONTENT_Y + econTableH + 0.15,
          w: CONTENT_WIDTH,
          h: 0.65,
          type: 'insight',
        });
      }
    }
    if (financing.length > 0) {
      addCalloutBox(
        slide,
        'Financing Options',
        financing.map((f) => `- ${ensureString(f)}`).join('\n'),
        {
          x: LEFT_MARGIN,
          y:
            econInsights.length > 0 ? CONTENT_Y + 3.0 + 0.15 + 0.65 + 0.15 : CONTENT_Y + 3.0 + 0.15,
          w: CONTENT_WIDTH,
          h: 0.8,
          type: 'insight',
        }
      );
    }
  }

  function renderEntryStrategy(slide, data) {
    const options = safeArray(data.options, 3);

    const stratInsights = [];
    if (data.recommendation)
      stratInsights.push(`Recommended: ${ensureString(data.recommendation)}`);
    if (options.length > 0) {
      stratInsights.push(`${options.length} entry options analyzed`);
      const lowestRisk = options.find((o) =>
        ensureString(o.riskLevel, '').toLowerCase().includes('low')
      );
      const fastest = options.find((o) => {
        const t = ensureString(o.timeline, '');
        return t.includes('12') || t.includes('6');
      });
      if (lowestRisk) stratInsights.push(`Low Risk: ${lowestRisk.mode}`);
      if (fastest) stratInsights.push(`Fastest: ${fastest.mode} (${fastest.timeline})`);
    }

    let entryNextY = 4.7;
    if (options.length === 0) {
      addDataUnavailableMessage(slide, 'Entry strategy analysis not available');
      return;
    } else {
      const optRows = [
        tableHeader(['Option', 'Timeline', 'Investment', 'Control', 'Risk', 'Pros', 'Cons']),
      ];
      options.forEach((opt) => {
        optRows.push([
          { text: safeCell(opt.mode) },
          { text: safeCell(opt.timeline) },
          { text: safeCell(opt.investment) },
          { text: safeCell(opt.controlLevel) },
          { text: safeCell(opt.riskLevel) },
          {
            text: safeArray(opt.pros, 3)
              .map((p) => `+ ${safeCell(p, 50)}`)
              .join('\n'),
            options: { fontSize: 14 },
          },
          {
            text: safeArray(opt.cons, 3)
              .map((c) => `- ${safeCell(c, 50)}`)
              .join('\n'),
            options: { fontSize: 14 },
          },
        ]);
      });
      const optColWidths = calculateColumnWidths(optRows, CONTENT_WIDTH);
      const optTableH = safeTableHeight(optRows.length, { fontSize: 14, maxH: 2.5 });
      applyAlternateRowFill(optRows);
      safeAddTable(slide, optRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: optTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: optColWidths.length > 0 ? optColWidths : [1.5, 1.3, 1.5, 1.3, 1.1, 3.0, 2.9],
        valign: 'top',
      });
      entryNextY = CONTENT_Y + optTableH + 0.15;
      if (stratInsights.length > 0) {
        addCalloutBox(slide, 'Strategy Insights', stratInsights.slice(0, 4).join(' | '), {
          x: LEFT_MARGIN,
          y: entryNextY,
          w: CONTENT_WIDTH,
          h: 0.8,
          type: 'insight',
        });
        entryNextY += 0.8 + 0.15;
      }
    }

    // Harvey Balls comparison
    const harvey = data.harveyBalls || {};
    if (harvey.criteria && Array.isArray(harvey.criteria) && harvey.criteria.length > 0) {
      const harveyBaseY = entryNextY;
      slide.addText('Comparison Matrix (1-5 scale)', {
        x: LEFT_MARGIN,
        y: harveyBaseY,
        w: CONTENT_WIDTH,
        h: 0.25,
        fontSize: 14,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      const renderHarvey = (arr, idx) => {
        if (!Array.isArray(arr) || idx >= arr.length) return '';
        const val = Math.max(0, Math.min(5, parseInt(arr[idx], 10) || 0));
        return '\u25CF'.repeat(val) + '\u25CB'.repeat(5 - val);
      };
      // Derive column headers from options data or harvey ball keys
      const harveyModes =
        options.length > 0
          ? options.map((o) => o.mode || o.name || 'Option')
          : data.entryModes || ['Joint Venture', 'Acquisition', 'Greenfield'];
      const harveyKeys =
        options.length > 0
          ? options.map((o) => (o.mode || o.name || '').toLowerCase().replace(/\s+/g, ''))
          : ['jv', 'acquisition', 'greenfield'];
      // Map friendly keys to harvey data keys
      const keyMap = {
        jointventure: 'jv',
        jv: 'jv',
        acquisition: 'acquisition',
        greenfield: 'greenfield',
      };
      const harveyRows = [tableHeader(['Criteria', ...harveyModes.slice(0, 3)])];
      harvey.criteria.forEach((crit, idx) => {
        const row = [{ text: safeCell(crit) }];
        harveyKeys.slice(0, 3).forEach((key) => {
          const mappedKey = keyMap[key] || key;
          row.push({ text: renderHarvey(harvey[mappedKey], idx) });
        });
        harveyRows.push(row);
      });
      const harveyColWidths = calculateColumnWidths(harveyRows, CONTENT_WIDTH);
      applyAlternateRowFill(harveyRows);
      safeAddTable(slide, harveyRows, {
        x: LEFT_MARGIN,
        y: harveyBaseY + 0.3,
        w: CONTENT_WIDTH,
        h: Math.min(0.3 + harvey.criteria.length * 0.25, 2.5),
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: harveyColWidths.length > 0 ? harveyColWidths : [3.36, 3.09, 3.02, 3.13],
        valign: 'middle',
      });
    }
  }

  function renderImplementation(slide, data) {
    const phases = safeArray(data.phases, 3);
    if (phases.length === 0) {
      addDataUnavailableMessage(slide, 'Implementation roadmap data not available');
      return;
    }

    const totalInvestment = ensureString(data.totalInvestment || '').trim();
    const breakeven = ensureString(data.breakeven || '').trim();
    const summaryParts = [];
    if (totalInvestment) summaryParts.push(`Total investment: ${totalInvestment}`);
    if (breakeven) summaryParts.push(`Breakeven: ${breakeven}`);

    let cardsTopY = CONTENT_Y + 0.08;
    if (summaryParts.length > 0) {
      addCalloutBox(slide, 'Roadmap Summary', summaryParts.join('\n'), {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: 0.62,
        type: 'insight',
      });
      cardsTopY = CONTENT_Y + 0.77;
    }

    const gap = 0.12;
    const phaseCount = Math.min(phases.length, 3);
    const cardW = (CONTENT_WIDTH - gap * (phaseCount - 1)) / phaseCount;
    const headerH = 0.28;
    const cardH = Math.max(2.8, Math.min(3.6, CONTENT_BOTTOM - cardsTopY - 0.95));

    for (let i = 0; i < phaseCount; i++) {
      const phase = phases[i] || {};
      const cardX = LEFT_MARGIN + i * (cardW + gap);
      const phaseColor = i === 0 ? COLORS.accent1 : i === 1 ? COLORS.dk2 : COLORS.orange;

      slide.addShape('roundRect', {
        x: cardX,
        y: cardsTopY,
        w: cardW,
        h: headerH,
        fill: { color: phaseColor },
        line: { color: phaseColor, pt: 0.5 },
      });
      const phaseTitle = fitTextToShape(
        ensureString(phase.name || `Phase ${i + 1}`),
        cardW - 0.14,
        0.2,
        11
      );
      slide.addText(phaseTitle.text, {
        x: cardX + 0.07,
        y: cardsTopY + 0.03,
        w: cardW - 0.14,
        h: headerH - 0.04,
        fontSize: phaseTitle.fontSize,
        bold: true,
        color: COLORS.white,
        fontFace: FONT,
        align: 'center',
        valign: 'middle',
        fit: 'shrink',
      });

      slide.addShape('rect', {
        x: cardX,
        y: cardsTopY + headerH + 0.03,
        w: cardW,
        h: cardH,
        fill: { color: COLORS.white },
        line: { color: COLORS.border, pt: TABLE_BORDER_WIDTH },
      });

      const phaseBodyParts = [];
      const activities = safeArray(phase.activities, 4).map((a) => `- ${ensureString(a)}`);
      if (activities.length > 0) phaseBodyParts.push(activities.join('\n'));
      const milestones = safeArray(phase.milestones, 2).map((m) => ensureString(m));
      if (milestones.length > 0) phaseBodyParts.push(`Milestones: ${milestones.join(', ')}`);
      if (phase.investment) phaseBodyParts.push(`Investment: ${ensureString(phase.investment)}`);
      if (phase.timeline) phaseBodyParts.push(`Timeline: ${ensureString(phase.timeline)}`);

      const phaseBody = fitTextToShape(
        ensureString(phaseBodyParts.join('\n')),
        cardW - 0.18,
        cardH - 0.12,
        10
      );
      slide.addText(phaseBody.text, {
        x: cardX + 0.09,
        y: cardsTopY + headerH + 0.08,
        w: cardW - 0.18,
        h: cardH - 0.12,
        fontSize: phaseBody.fontSize,
        color: COLORS.black,
        fontFace: FONT,
        valign: 'top',
        fit: 'shrink',
      });
    }

    const nextSteps = enrichment.nextSteps || countryAnalysis?.summary?.nextSteps || null;
    if (nextSteps) {
      const nextStepsText =
        typeof nextSteps === 'string'
          ? nextSteps
          : Array.isArray(nextSteps)
            ? nextSteps.join('; ')
            : JSON.stringify(nextSteps);
      addCalloutBox(slide, 'Next Steps', nextStepsText, {
        x: LEFT_MARGIN,
        y: CONTENT_BOTTOM - 0.72,
        w: CONTENT_WIDTH,
        h: 0.62,
        type: 'insight',
      });
    }
  }

  function renderTargetSegments(slide, data) {
    const segmentsList = safeArray(data.segments, 3);

    const segInsights = [];
    if (data.goToMarketApproach) segInsights.push(ensureString(data.goToMarketApproach));
    if (segmentsList.length > 0) {
      segInsights.push(`${segmentsList.length} target segments identified`);
      const highPriority = segmentsList.find((s) => s.priority >= 4);
      if (highPriority) segInsights.push(`Top Priority: ${highPriority.name}`);
    }

    let nextSegY = CONTENT_Y;
    if (segmentsList.length === 0) {
      addDataUnavailableMessage(slide, 'Target segment data not available');
      return;
    }
    if (segmentsList.length > 0) {
      const segmentRows = [
        tableHeader(['Segment', 'Size', 'Market Intensity', 'Decision Maker', 'Priority']),
      ];
      segmentsList.forEach((s) => {
        segmentRows.push([
          { text: safeCell(s.name, 25) },
          { text: safeCell(s.size, 20) },
          { text: safeCell(s.marketIntensity || s.energyIntensity, 15) },
          { text: safeCell(s.decisionMaker, 18) },
          { text: s.priority ? `${safeCell(s.priority)}/5` : '' },
        ]);
      });
      const segColWidths = calculateColumnWidths(segmentRows, CONTENT_WIDTH);
      const segTableH = Math.min(1.8, segmentRows.length * 0.4 + 0.2);
      applyAlternateRowFill(segmentRows);
      safeAddTable(slide, segmentRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: segTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: segColWidths.length > 0 ? segColWidths : [2.5, 2.5, 2.1, 2.5, 3.0],
        valign: 'top',
      });
      nextSegY = CONTENT_Y + segTableH + 0.15;
      if (segInsights.length > 0) {
        addCalloutBox(slide, 'Market Approach', segInsights.slice(0, 2).join(' | '), {
          x: LEFT_MARGIN,
          y: nextSegY,
          w: CONTENT_WIDTH,
          h: 0.65,
          type: 'insight',
        });
        nextSegY += 0.65 + 0.15;
      }
    }

    // Top targets
    const topTargets = safeArray(data.topTargets, 3)
      .map((t) => {
        if (t && t.company && !t.name) t.name = t.company;
        return t;
      })
      .filter(isValidCompany)
      .map(ensureWebsite)
      .map(enrichDescription);

    if (topTargets.length > 0 && nextSegY < CONTENT_BOTTOM - 1.0) {
      const priorityYBase = nextSegY;
      slide.addText('Priority Target Companies', {
        x: LEFT_MARGIN,
        y: priorityYBase,
        w: CONTENT_WIDTH,
        h: 0.25,
        fontSize: 14,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      const targetCompRows = [tableHeader(['Company', 'Industry', 'Annual Spend', 'Location'])];
      topTargets.forEach((t) => {
        const website = sanitizeHyperlinkUrl(t.website);
        const nameCell = website
          ? {
              text: safeCell(t.company || t.name, 25),
              options: { hyperlink: { url: website }, color: COLORS.hyperlink },
            }
          : { text: safeCell(t.company || t.name, 25) };
        targetCompRows.push([
          nameCell,
          { text: safeCell(t.industry, 30) },
          { text: safeCell(t.annualSpend || t.energySpend, 25) },
          { text: safeCell(t.location, 30) },
        ]);
      });
      const targetColWidths = calculateColumnWidths(targetCompRows, CONTENT_WIDTH);
      const targetTableStartY = priorityYBase + 0.45;
      const targetTableH = Math.min(1.0, Math.max(0.4, CONTENT_BOTTOM - targetTableStartY));
      applyAlternateRowFill(targetCompRows);
      safeAddTable(slide, targetCompRows, {
        x: LEFT_MARGIN,
        y: targetTableStartY,
        w: CONTENT_WIDTH,
        h: targetTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: targetColWidths.length > 0 ? targetColWidths : [3.36, 3.09, 3.02, 3.13],
        valign: 'top',
      });
    }
  }

  function renderGoNoGo(slide, data) {
    const goNoGoCriteria = safeArray(data.criteria, 6);
    if (goNoGoCriteria.length === 0) {
      addDataUnavailableMessage(slide, 'Go/no-go criteria not available');
      return;
    }
    if (goNoGoCriteria.length > 0) {
      const goNoGoRows = [tableHeader(['Criterion', 'Status', 'Evidence'])];
      goNoGoCriteria.forEach((c) => {
        const isMet = c.met === true || c.met === 'true';
        const isNotMet = c.met === false || c.met === 'false';
        const statusIcon = isMet ? '\u2713' : isNotMet ? '\u2717' : '?';
        const statusColor = isMet ? COLORS.green : isNotMet ? COLORS.red : COLORS.orange;
        goNoGoRows.push([
          { text: safeCell(c.criterion, 60) },
          { text: statusIcon, options: { color: statusColor, bold: true, align: 'center' } },
          { text: safeCell(c.evidence, 80) },
        ]);
      });
      const goNoGoTableH = safeTableHeight(goNoGoRows.length, { fontSize: 14, maxH: 3.5 });
      applyAlternateRowFill(goNoGoRows);
      safeAddTable(slide, goNoGoRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: goNoGoTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: [4.03, 1.08, 7.49],
        valign: 'top',
      });
    }
    // Verdict box
    const goNoGoTableBottom =
      goNoGoCriteria.length > 0
        ? CONTENT_Y + safeTableHeight(goNoGoCriteria.length + 1, { fontSize: 14, maxH: 3.5 }) + 0.15
        : 1.5;
    const verdictStr = ensureString(data.overallVerdict, '');
    const verdictColor =
      verdictStr.includes('GO') && !verdictStr.includes('NO')
        ? COLORS.green
        : verdictStr.includes('NO')
          ? COLORS.red
          : COLORS.orange;
    if (data.overallVerdict) {
      slide.addText(`VERDICT: ${data.overallVerdict}`, {
        x: LEFT_MARGIN,
        y: goNoGoTableBottom,
        w: CONTENT_WIDTH,
        h: 0.45,
        fontSize: 16,
        bold: true,
        color: COLORS.white,
        fill: { color: verdictColor },
        fontFace: FONT,
        align: 'center',
        valign: 'middle',
      });
    }
    let goNoGoNextY = goNoGoTableBottom + 0.45 + 0.1;
    const conditions = safeArray(data.conditions, 3);
    if (conditions.length > 0) {
      slide.addText(
        [{ text: 'Conditions: ', options: { bold: true } }].concat(
          conditions.map((c, i) => ({ text: `${i > 0 ? ' | ' : ''}${ensureString(c)}` }))
        ),
        {
          x: LEFT_MARGIN,
          y: goNoGoNextY,
          w: CONTENT_WIDTH,
          h: 0.45,
          fontSize: CONTENT_MIN_FONT_PT,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
      goNoGoNextY += 0.45 + 0.1;
    }
  }

  function renderOpportunitiesObstacles(slide, data) {
    // Use matrix pattern for richer visual display
    const oppsFormatted = safeArray(data.opportunities, 5)
      .filter(Boolean)
      .map((o) =>
        typeof o === 'string'
          ? o
          : [
              o.opportunity || '',
              o.size ? `(${o.size})` : '',
              o.timing ? `Timing: ${o.timing}` : '',
              o.action ? `Action: ${o.action}` : '',
            ]
              .filter(Boolean)
              .join(' ')
      );
    const obsFormatted = safeArray(data.obstacles, 5)
      .filter(Boolean)
      .map((o) =>
        typeof o === 'string'
          ? o
          : [
              o.obstacle || '',
              o.severity ? `[${o.severity}]` : '',
              o.mitigation ? `Mitigation: ${o.mitigation}` : '',
            ]
              .filter(Boolean)
              .join(' ')
      );

    // Early return if no data at all
    const ratings = data.ratings || {};
    if (
      oppsFormatted.length === 0 &&
      obsFormatted.length === 0 &&
      !ratings.attractiveness &&
      !ratings.feasibility
    ) {
      addDataUnavailableMessage(slide, 'Opportunities and obstacles data not available');
      return;
    }

    const summaryLayout = addOpportunitiesObstaclesSummary(slide, oppsFormatted, obsFormatted, {
      x: LEFT_MARGIN,
      y: CONTENT_Y,
      fullWidth: CONTENT_WIDTH,
      // Reserve vertical room for ratings + recommendation callouts at bottom.
      maxBodyH: Math.max(1.8, CONTENT_BOTTOM - CONTENT_Y - 2.0),
    });
    let ratingBottomY = null;

    if (ratings.attractiveness || ratings.feasibility) {
      // Build rating text parts with rationale
      const ratingParts = [];
      const ratingTextParts = [];
      if (ratings.attractiveness)
        ratingTextParts.push(`Attractiveness: ${ratings.attractiveness}/10`);
      if (ratings.feasibility) ratingTextParts.push(`Feasibility: ${ratings.feasibility}/10`);
      ratingParts.push({
        text: ratingTextParts.join(' | '),
        options: { fontSize: 12, bold: true, color: COLORS.dk2, fontFace: FONT },
      });
      const rationale = [];
      if (ratings.attractivenessRationale) {
        rationale.push(`Attractiveness: ${safeCell(ratings.attractivenessRationale, 260)}`);
      }
      if (ratings.feasibilityRationale) {
        rationale.push(`Feasibility: ${safeCell(ratings.feasibilityRationale, 260)}`);
      }
      if (rationale.length > 0) {
        ratingParts.push({
          text: '\n' + rationale.join(' | '),
          options: { fontSize: CONTENT_MIN_FONT_PT, color: COLORS.secondary, fontFace: FONT },
        });
      }
      const ratingH = rationale.length > 0 ? 0.62 : 0.25;
      const ratingY = Math.max(
        summaryLayout?.bodyBottomY != null ? summaryLayout.bodyBottomY + 0.12 : CONTENT_Y + 4.4,
        CONTENT_BOTTOM - (rationale.length > 0 ? 1.3 : 1.1)
      );
      slide.addText(ratingParts, {
        x: LEFT_MARGIN,
        y: ratingY,
        w: CONTENT_WIDTH,
        h: ratingH,
        valign: 'top',
      });
      ratingBottomY = ratingY + ratingH;
    }
    // Show recommendation only if real data exists
    if (data.recommendation) {
      const recommendationText = safeCell(
        ensureString(data.recommendation).replace(/\s+/g, ' '),
        480
      );
      let recommendationY = CONTENT_BOTTOM - 0.75;
      if (Number.isFinite(ratingBottomY)) {
        recommendationY = Math.max(recommendationY, ratingBottomY + 0.08);
      }
      let recommendationH = CONTENT_BOTTOM - recommendationY;
      if (recommendationH < 0.5) {
        recommendationY = CONTENT_BOTTOM - 0.5;
        recommendationH = 0.5;
      }
      addCalloutBox(slide, 'Strategic Recommendation', recommendationText, {
        x: LEFT_MARGIN,
        y: recommendationY,
        w: CONTENT_WIDTH,
        h: recommendationH,
        type: 'recommendation',
      });
    }
  }

  // Dynamic text sizing: reduce font size to fit, never truncate content
  function dynamicText(text, maxChars, baseFontPt, floorPt) {
    const minPt = Math.max(CONTENT_MIN_FONT_PT, floorPt || CONTENT_MIN_FONT_PT);
    if (!text) return { text: '', fontSize: baseFontPt };
    if (text.length <= maxChars) return { text, fontSize: baseFontPt };
    for (let fs = baseFontPt - 1; fs >= minPt; fs--) {
      const scaledMax = Math.floor(maxChars * (baseFontPt / fs));
      if (text.length <= scaledMax) return { text, fontSize: fs };
    }
    // Keep full text in strict mode and let fidelity gates fail loudly if layout cannot hold it.
    if (STRICT_TEMPLATE_FIDELITY) return { text: ensureString(text), fontSize: minPt };
    const floorScaledMax = Math.max(maxChars, Math.floor(maxChars * (baseFontPt / minPt)));
    return { text: truncate(ensureString(text), floorScaledMax, true), fontSize: minPt };
  }

  function renderKeyInsights(slide, data) {
    const insights = safeArray(data.insights, 3);
    // Prefer synthesis keyInsights over countryAnalysis insights (fallback chain)
    const synthesisInsights =
      enrichment.keyInsights || countryAnalysis?.summary?.keyInsights || null;
    const insightSource =
      synthesisInsights && synthesisInsights.length > 0 ? synthesisInsights : data.insights || [];
    const resolvedInsights = safeArray(insightSource, 3);
    if (resolvedInsights.length === 0 && insights.length === 0) {
      addDataUnavailableMessage(slide, 'Key insights data not available');
      return;
    }
    const finalInsights = resolvedInsights.length > 0 ? resolvedInsights : insights;
    const panelInsights = finalInsights.slice(0, 3);
    const panelGap = 0.16;
    const sourceRect = getActiveLayoutRect('source', tpSource);
    const sourceTop = Number(sourceRect?.y) || Number(tpSource.y) || 6.7;
    const hasRecommendation = !!ensureString(data.recommendation || '').trim();
    const recommendationReserve = hasRecommendation ? 1.18 : 0.0;
    const panelTop = CONTENT_Y;
    const panelBottom = Math.max(panelTop + 0.9, sourceTop - 0.08 - recommendationReserve);
    const panelCount = Math.max(1, panelInsights.length);
    const totalGaps = panelGap * (panelCount - 1);
    const panelH = Math.max(0.7, (panelBottom - panelTop - totalGaps) / panelCount);
    let panelY = panelTop;

    panelInsights.forEach((insight, idx) => {
      const rawTitle =
        typeof insight === 'string'
          ? `Insight ${idx + 1}`
          : ensureString(insight.title) || `Insight ${idx + 1}`;
      let rawContent = '';
      if (typeof insight === 'string') {
        rawContent = insight;
      } else {
        const parts = [];
        if (insight.data) parts.push(ensureString(insight.data));
        if (insight.pattern) parts.push(`So what: ${ensureString(insight.pattern)}`);
        if (insight.implication) parts.push(`Action: ${ensureString(insight.implication)}`);
        if (insight.timing) parts.push(`Timing: ${ensureString(insight.timing)}`);
        rawContent = parts.join('\n');
      }

      slide.addShape('rect', {
        x: LEFT_MARGIN,
        y: panelY,
        w: CONTENT_WIDTH,
        h: panelH,
        fill: { color: COLORS.white },
        line: { color: COLORS.border, pt: TABLE_BORDER_WIDTH },
      });

      const titleStripH = Math.min(0.34, Math.max(0.24, panelH * 0.25));
      slide.addShape('rect', {
        x: LEFT_MARGIN,
        y: panelY,
        w: CONTENT_WIDTH,
        h: titleStripH,
        fill: { color: COLORS.calloutFill || 'D9D9D9' },
        line: { color: COLORS.border, pt: TABLE_BORDER_WIDTH },
      });

      const titleSized = fitTextToShape(rawTitle, CONTENT_WIDTH - 0.2, titleStripH - 0.06, 12);
      slide.addText(titleSized.text, {
        x: LEFT_MARGIN + 0.1,
        y: panelY + 0.03,
        w: CONTENT_WIDTH - 0.2,
        h: titleStripH - 0.05,
        fontSize: titleSized.fontSize,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
        fit: 'shrink',
      });

      const bodyH = Math.max(0.18, panelH - titleStripH - 0.08);
      const bodySized = fitTextToShape(ensureString(rawContent), CONTENT_WIDTH - 0.2, bodyH, 10);
      slide.addText(bodySized.text, {
        x: LEFT_MARGIN + 0.1,
        y: panelY + titleStripH + 0.03,
        w: CONTENT_WIDTH - 0.2,
        h: bodyH,
        fontSize: bodySized.fontSize,
        fontFace: FONT,
        color: COLORS.black,
        valign: 'top',
        fit: 'shrink',
      });

      panelY += panelH + panelGap;
    });

    if (hasRecommendation) {
      const recommendationText = ensureString(data.recommendation);
      const recommendationY = panelBottom + 0.06;
      const recommendationH = Math.max(0.64, sourceTop - recommendationY - 0.04);
      addCalloutBox(slide, 'RECOMMENDATION', recommendationText, {
        x: LEFT_MARGIN,
        y: recommendationY,
        w: CONTENT_WIDTH,
        h: recommendationH,
        type: 'recommendation',
      });
    }
  }

  function renderTimingIntelligence(slide, data) {
    const triggers = safeArray(data.triggers, 4);

    if (triggers.length > 0) {
      const triggerRows = [tableHeader(['Trigger', 'Impact', 'Action Required'])];
      triggers.forEach((t) => {
        triggerRows.push([
          { text: safeCell(t.trigger, 60) },
          { text: safeCell(t.impact, 50) },
          { text: safeCell(t.action, 50) },
        ]);
      });
      const triggerColWidths = calculateColumnWidths(triggerRows, CONTENT_WIDTH);
      applyAlternateRowFill(triggerRows);
      safeAddTable(slide, triggerRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: Math.min(0.3 + triggerRows.length * 0.35, 3.5),
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: triggerColWidths.length > 0 ? triggerColWidths : [4.0, 4.25, 4.35],
        valign: 'top',
      });
    } else {
      addDataUnavailableMessage(slide, 'Timing data not available');
      return;
    }
    const triggerTableH =
      triggers.length > 0 ? Math.min(0.3 + (triggers.length + 1) * 0.35, 3.5) : 0;
    const windowY =
      (triggers.length > 0 ? Math.min(CONTENT_Y + triggerTableH + 0.15, 4.5) : 3.8) + 0.85;
    if (data.windowOfOpportunity) {
      addCalloutBox(slide, 'WINDOW OF OPPORTUNITY', data.windowOfOpportunity, {
        x: LEFT_MARGIN,
        y: windowY,
        w: CONTENT_WIDTH,
        h: 0.9,
        type: 'recommendation',
      });
    } else {
      const timingConsiderations =
        enrichment.marketOpportunityAssessment?.timingConsiderations ||
        countryAnalysis?.summary?.marketOpportunityAssessment?.timingConsiderations ||
        null;
      if (timingConsiderations) {
        addCalloutBox(
          slide,
          'Timing Window',
          typeof timingConsiderations === 'string'
            ? timingConsiderations
            : JSON.stringify(timingConsiderations),
          { x: LEFT_MARGIN, y: windowY, w: CONTENT_WIDTH, h: 0.9, type: 'insight' }
        );
      }
    }
  }

  function renderLessonsLearned(slide, data) {
    let lessonsNextY = CONTENT_Y;
    const failures = safeArray(data.failures, 3);
    if (failures.length > 0) {
      slide.addText('FAILURES TO AVOID', {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: 4.5,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.red,
        fontFace: FONT,
      });
      lessonsNextY += 0.35;
      const failureRows = [tableHeader(['Company', 'Reason', 'Lesson'])];
      failures.forEach((f) => {
        failureRows.push([
          { text: `${safeCell(f.company)} (${safeCell(f.year)})` },
          { text: safeCell(f.reason, 60) },
          { text: safeCell(f.lesson, 60) },
        ]);
      });
      const failTableH = safeTableHeight(failureRows.length, { fontSize: 14, maxH: 2.0 });
      applyAlternateRowFill(failureRows);
      safeAddTable(slide, failureRows, {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: CONTENT_WIDTH,
        h: failTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
        margin: TABLE_CELL_MARGIN,
        colW: [2.96, 4.7, 4.94],
        valign: 'top',
      });
      lessonsNextY += failTableH + 0.15;
    }
    const successFactors = safeArray(data.successFactors, 3);
    if (successFactors.length > 0 && lessonsNextY < CONTENT_BOTTOM - 0.2) {
      slide.addText('SUCCESS FACTORS', {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.green,
        fontFace: FONT,
      });
      const sfH = Math.min(1.0, successFactors.length * 0.3 + 0.1);
      if (lessonsNextY + 0.35 + sfH <= CONTENT_BOTTOM - 0.2) {
        slide.addText(
          successFactors.map((s) => ({ text: ensureString(s), options: { bullet: true } })),
          {
            x: LEFT_MARGIN,
            y: lessonsNextY + 0.35,
            w: CONTENT_WIDTH,
            h: sfH,
            fontSize: CONTENT_MIN_FONT_PT,
            fontFace: FONT,
            color: COLORS.black,
            valign: 'top',
          }
        );
        lessonsNextY += 0.35 + sfH + 0.15;
      }
    }
    const warningSigns = safeArray(data.warningSignsToWatch, 3);
    if (failures.length === 0 && successFactors.length === 0 && warningSigns.length === 0) {
      addDataUnavailableMessage(slide, 'Lessons learned data not available');
      return;
    }
    if (warningSigns.length > 0 && lessonsNextY < CONTENT_BOTTOM - 0.2) {
      slide.addText('WARNING SIGNS', {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.orange,
        fontFace: FONT,
      });
      lessonsNextY += 0.35;
      const warningBulletsH = Math.min(1.5, Math.max(0.4, CONTENT_BOTTOM - lessonsNextY));
      if (lessonsNextY + warningBulletsH <= CONTENT_BOTTOM) {
        slide.addText(
          warningSigns.map((w) => ({ text: ensureString(w), options: { bullet: true } })),
          {
            x: LEFT_MARGIN,
            y: lessonsNextY,
            w: CONTENT_WIDTH,
            h: warningBulletsH,
            fontSize: CONTENT_MIN_FONT_PT,
            fontFace: FONT,
            color: COLORS.black,
            valign: 'top',
          }
        );
      }
    }
  }

  // ============ SECTION GENERATION ============
  // Generate an entire section: TOC divider + content slides
  // Check if a section has any real content (not just empty objects or "Data unavailable" placeholders)
  function sectionHasContent(blocks) {
    return blocks.some((b) => blockHasRenderableData(b));
  }

  // Section names for TOC slides (Policy first, then Market — matches Escort template)
  const SECTION_NAMES = [
    'Policy & Regulatory',
    'Market Overview',
    'Competitive Landscape',
    'Strategic Analysis',
    'Recommendations',
    'Appendix',
  ];

  // 2C: Extract usable content from rawData when synthesis failed
  function extractRawDataFallback(sectionName) {
    if (!countryAnalysis.rawData) return null;
    const prefixMap = {
      'Market Overview': 'market_',
      'Policy & Regulatory': 'policy_',
      'Competitive Landscape': 'competitors_',
      'Strategic Analysis': 'depth_',
      Recommendations: 'insight_',
    };
    const prefix = prefixMap[sectionName];
    if (!prefix) return null;
    const parts = [];
    for (const [key, data] of Object.entries(countryAnalysis.rawData)) {
      if (key.startsWith(prefix) && data?.content) {
        const snippet =
          typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
        parts.push(`${key}: ${snippet}`);
      }
    }
    if (parts.length === 0) return null;
    return parts.slice(0, 5).join('\n\n');
  }

  // 2D: Extract narrative from thin object data when canonical blocks are sparse
  function extractNarrativeFromThinData(sectionData) {
    if (!sectionData || typeof sectionData !== 'object') return null;
    const sectionEntries = Object.entries(sectionData).filter(([key, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      if (ensureString(key).startsWith('_')) return false;
      return Boolean(value.overview || value.keyInsight || Array.isArray(value.keyMetrics));
    });
    if (sectionEntries.length === 0) return null;

    const parts = [];
    for (const [, sec] of sectionEntries) {
      if (sec.overview) parts.push(sec.overview);
      if (sec.keyInsight) parts.push(`Key Insight: ${sec.keyInsight}`);
      if (Array.isArray(sec.keyMetrics) && sec.keyMetrics.length > 0) {
        const metricStrs = sec.keyMetrics
          .filter((m) => m.metric && m.value)
          .map((m) => `${m.metric}: ${m.value}${m.context ? ` (${m.context})` : ''}`);
        if (metricStrs.length > 0) parts.push('Metrics: ' + metricStrs.join('; '));
      }
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  function normalizeSectionForRender(sectionName, rawSection) {
    const cleaned = sanitizeSectionPayload(rawSection);
    switch (sectionName) {
      case 'Policy & Regulations':
        return normalizeByAliasMap(cleaned, POLICY_ALIAS_MAP).data;
      case 'Market Overview':
        return normalizeMarketForRender(cleaned).data;
      case 'Competitive Landscape':
        return normalizeByAliasMap(cleaned, COMPETITOR_ALIAS_MAP).data;
      case 'Strategic Analysis':
        return normalizeByAliasMap(cleaned, DEPTH_ALIAS_MAP).data;
      case 'Recommendations':
      default:
        return cleaned;
    }
  }

  function generateSection(sectionName, sectionNumber, totalSections, sectionData) {
    // Section divider slide with navy background
    const dividerBefore = pptx.slides.length;
    addSectionDivider(pptx, sectionName, sectionNumber, totalSections, 'DIVIDER_NAVY');
    if (pptx.slides.length > dividerBefore) {
      registerTemplateCloneSlide(
        SECTION_DIVIDER_TEMPLATE_SLIDES[sectionNumber] || 30,
        `sectionDivider:${sectionName}`
      );
    }

    // Detect _synthesisError sentinel — synthesis completely failed for this section
    if (sectionData && sectionData._synthesisError) {
      console.warn(
        `[PPT] Section "${sectionName}" has _synthesisError: ${sectionData.message || 'unknown'}`
      );
      const slide = addSlideWithTitle(`${sectionName}`, '');
      slide.addText(`${sectionData.message || 'Synthesis data unavailable for this section.'}`, {
        x: LEFT_MARGIN,
        y: 3.0,
        w: CONTENT_WIDTH,
        h: 1.0,
        fontSize: 14,
        color: COLORS.muted,
        fontFace: FONT,
        align: 'center',
        valign: 'middle',
      });
      return 1;
    }

    // Map display name to internal classifyDataBlocks name
    const classifyName =
      sectionName === 'Policy & Regulatory' ? 'Policy & Regulations' : sectionName;
    const normalizedSection = normalizeSectionForRender(classifyName, sectionData);
    const blocks = classifyDataBlocks(classifyName, normalizedSection);
    for (const block of blocks) {
      resolveBlockTemplate(block);
    }
    const pptGate = validatePptData(blocks);
    console.log('[Quality Gate] PPT data:', JSON.stringify(pptGate));
    const allowCompetitiveOptionalGap = shouldAllowCompetitiveOptionalGroupGap(
      sectionName,
      pptGate,
      blocks
    );
    if (pptGate.pass === false && allowCompetitiveOptionalGap) {
      console.warn(
        `[Quality Gate] ${sectionName}: allowing optional competitor gaps (${(pptGate.nonRenderableGroups || []).join(', ')}) because core groups are renderable`
      );
      pptGate.pass = true;
    }
    if (pptGate.pass === false) {
      const groupSummary = Array.isArray(pptGate.nonRenderableGroups)
        ? pptGate.nonRenderableGroups.join(', ')
        : '';
      const emptySummary = Array.isArray(pptGate.emptyBlocks)
        ? pptGate.emptyBlocks.slice(0, 6).join(' ; ')
        : '';
      const chartSummary = Array.isArray(pptGate.chartIssues)
        ? pptGate.chartIssues.slice(0, 4).join(' ; ')
        : '';
      const gateMessage =
        `[PPT] Data gate failed for "${sectionName}"` +
        `${groupSummary ? ` [non-renderable groups: ${groupSummary}]` : ''}` +
        `${emptySummary ? ` [empty: ${emptySummary}]` : ''}` +
        `${chartSummary ? ` [charts: ${chartSummary}]` : ''}`;
      if (STRICT_TEMPLATE_FIDELITY) {
        throw new Error(gateMessage);
      }
      console.warn(`${gateMessage}. Continuing because STRICT_TEMPLATE_FIDELITY is disabled.`);
    }

    if (!sectionHasContent(blocks)) {
      // 2D: Thin data narrative — extract overview/keyInsight/metrics from thin section objects
      if (ALLOW_NON_TEMPLATE_FALLBACK_SLIDES && blocks.length < 2) {
        const narrativeContent = extractNarrativeFromThinData(normalizedSection);
        if (narrativeContent) {
          console.log(
            `[PPT] Using thin-data narrative for "${sectionName}" (${blocks.length} blocks)`
          );
          const slide = addSlideWithTitle(`${sectionName}`, 'Summary Analysis');
          slide.addText(ensureString(narrativeContent), {
            x: LEFT_MARGIN,
            y: CONTENT_Y,
            w: CONTENT_WIDTH,
            h: 5.0,
            fontSize: 12,
            color: COLORS.black,
            fontFace: FONT,
            valign: 'top',
            lineSpacingMultiple: 1.4,
          });
          return 1;
        }
      }
      // 2C: rawData fallback — try to extract something useful from rawData
      if (ALLOW_NON_TEMPLATE_FALLBACK_SLIDES) {
        const rawFallbackContent = extractRawDataFallback(sectionName);
        if (rawFallbackContent) {
          const slide = addSlideWithTitle(`${sectionName}`, 'Data from Raw Research (Unprocessed)');
          slide.addText(ensureString(rawFallbackContent), {
            x: LEFT_MARGIN,
            y: CONTENT_Y,
            w: CONTENT_WIDTH,
            h: 5.0,
            fontSize: CONTENT_MIN_FONT_PT,
            color: COLORS.black,
            fontFace: FONT,
            valign: 'top',
          });
          return 1;
        }
      }
      // Section has no real content - render one summary slide instead of hollow slides
      const slide = addSlideWithTitle(`${sectionName}`, 'Limited Data Available');
      slide.addText('Detailed analysis for this section requires additional research data.', {
        x: LEFT_MARGIN,
        y: 2.5,
        w: CONTENT_WIDTH,
        h: 1.5,
        fontSize: 16,
        color: COLORS.secondary,
        fontFace: FONT,
        valign: 'top',
      });
      return 1;
    }

    // Track unavailable slides per section (Bug 25: limit to 1 per section)
    let unavailableCount = 0;
    for (const block of blocks) {
      const blockDataStr = JSON.stringify(block.data || {});
      const isLikelyEmpty =
        !hasMeaningfulContent(block.data) ||
        hasSemanticEmptyText(blockDataStr) ||
        hasTruncationArtifactText(blockDataStr);
      if (isLikelyEmpty) {
        unavailableCount++;
        if (unavailableCount > 1) continue; // Skip extra unavailable slides
      }
      generatePatternSlide(block);
    }
    return blocks.length;
  }

  // ============ MAIN FLOW ============

  // Section definitions — Policy first, Market second (matches Escort template)
  const sectionDefs = [
    { name: 'Policy & Regulatory', data: policy },
    { name: 'Market Overview', data: market },
    { name: 'Competitive Landscape', data: competitors },
    { name: 'Strategic Analysis', data: depth },
    { name: 'Recommendations', data: null }, // uses summary
  ];

  // classifyDataBlocks still uses "Policy & Regulations" internally — map the name
  function classifyBlocksForSection(sec) {
    const classifyName = sec.name === 'Policy & Regulatory' ? 'Policy & Regulations' : sec.name;
    const rawSection = sec.name === 'Recommendations' ? summary : sec.data;
    const normalizedSection = normalizeSectionForRender(classifyName, rawSection);
    return classifyDataBlocks(classifyName, normalizedSection);
  }

  // Pre-calculate block counts and content status
  const sectionBlockInfo = sectionDefs.map((sec) => {
    const blocks = classifyBlocksForSection(sec);
    const hasContent = sectionHasContent(blocks);
    return { count: blocks.length, hasContent };
  });
  const sectionBlockCounts = sectionBlockInfo.map((info) => info.count);

  // ===== SLIDE 1: COVER (uses NO_BAR master) =====
  const titleSlide = pptx.addSlide({ masterName: 'NO_BAR' });
  titleSlide.background = { data: `image/png;base64,${COVER_BG_B64}` };
  // Use client/project name if available, otherwise country
  const coverTitle = scope.clientName || ensureString(country, 'UNKNOWN').toUpperCase();
  const coverSubtitle = scope.projectName
    ? `${scope.projectName} - ${scope.industry} Market Selection`
    : `${scope.industry} - Market Overview & Analysis`;
  const coverPattern = templatePatterns.patterns?.cover?.elements || {};
  const compPos = coverPattern.companyName || { x: 0.46, y: 1.63, w: 9.35, h: 2.83 };
  const projPos = coverPattern.projectTitle || { x: 0.46, y: 4.86, w: 9.35, h: 1.65 };
  titleSlide.addText(coverTitle, {
    x: compPos.x,
    y: compPos.y,
    w: compPos.w,
    h: compPos.h,
    fontSize: coverPattern.companyName?.fontSize || 36,
    color: COLORS.dk2,
    fontFace: FONT,
    fit: 'shrink',
  });
  titleSlide.addText(coverSubtitle, {
    x: projPos.x,
    y: projPos.y,
    w: projPos.w,
    h: projPos.h,
    fontSize: coverPattern.projectTitle?.fontSize || 18,
    color: COLORS.accent1,
    fontFace: FONT,
    fit: 'shrink',
  });
  // Cover logo
  const coverLogo = coverPattern.logo || {};
  titleSlide.addImage({
    data: `image/png;base64,${LOGO_DARK_B64}`,
    x: coverLogo.x || 0.45,
    y: coverLogo.y || 0.32,
    w: coverLogo.w || 1.14,
    h: coverLogo.h || 0.4,
  });
  // Date element (position from template)
  const coverDate = coverPattern.date || {};
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: coverDate.x || 0.46,
    y: coverDate.y || 5.94,
    w: coverDate.w || 9,
    h: coverDate.h || 0.3,
    fontSize: coverDate.fontSize || 10,
    color: COLORS.secondary,
    fontFace: FONT,
  });
  registerTemplateCloneSlide(1, 'cover');

  // ===== SLIDE 2: TABLE OF CONTENTS (no section highlighted) =====
  addTocSlide(pptx, -1, SECTION_NAMES, COLORS, FONT, country);
  registerTemplateCloneSlide(2, 'toc');

  // ===== SLIDE 3: EXECUTIVE SUMMARY =====
  const execSlide = pptx.addSlide({ masterName: 'YCP_MAIN' });
  execSlide.addText('Executive Summary', {
    x: TITLE_X,
    y: tpTitle.y,
    w: TITLE_W,
    h: tpTitle.h,
    fontSize: tpTitleFontSize,
    fontFace: FONT,
    color: COLORS.dk2,
    bold: tpTitleBold,
  });
  const execContentRaw =
    synthesis.executiveSummary ||
    synthesis.summary?.executiveSummary ||
    summary.recommendation ||
    `This report provides a comprehensive analysis of the ${scope.industry || 'target'} market in ${country || 'the selected country'}. Detailed findings are presented in the following sections.`;
  // Fix 0: executiveSummary can be an array of strings — join them
  const execTextRaw = Array.isArray(execContentRaw)
    ? execContentRaw.join('\n\n')
    : String(execContentRaw || '');
  const execSentenceChunks = execTextRaw
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let execLines =
    execSentenceChunks.length > 1
      ? execSentenceChunks
          .slice(0, 6)
          .map((s) => `• ${ensureString(s)}`)
          .filter(Boolean)
      : [ensureString(execTextRaw)].filter(Boolean);
  if (execLines.length === 1 && execLines[0].length > 640) {
    const words = execLines[0].split(/\s+/).filter(Boolean);
    const midpoint = Math.ceil(words.length / 2);
    const firstHalf = words.slice(0, midpoint).join(' ').trim();
    const secondHalf = words.slice(midpoint).join(' ').trim();
    execLines = [firstHalf, secondHalf].filter(Boolean);
  }
  const maxExecShapeChars = 560;
  const expandedExecLines = [];
  for (const line of execLines) {
    if (!line) continue;
    if (line.length <= maxExecShapeChars) {
      expandedExecLines.push(line);
      continue;
    }
    const words = line.split(/\s+/).filter(Boolean);
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxExecShapeChars && current) {
        expandedExecLines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) expandedExecLines.push(current);
  }
  const execShapeTexts = [];
  let shapeText = '';
  for (const line of expandedExecLines) {
    const candidate = shapeText ? `${shapeText}\n${line}` : line;
    if (candidate.length > maxExecShapeChars && shapeText) {
      execShapeTexts.push(shapeText);
      shapeText = line;
    } else {
      shapeText = candidate;
    }
  }
  if (shapeText) execShapeTexts.push(shapeText);
  const shapesToRender =
    execShapeTexts.length > 0
      ? execShapeTexts
      : [expandedExecLines.join('\n') || ensureString(execTextRaw)];
  const totalShapes = Math.max(1, Math.min(4, shapesToRender.length));
  const boxGap = 0.12;
  const boxHeight = Math.max(0.45, (tpContent.h - boxGap * (totalShapes - 1)) / totalShapes);
  for (let i = 0; i < totalShapes; i++) {
    const start = i * Math.ceil(shapesToRender.length / totalShapes);
    const end = Math.min(
      shapesToRender.length,
      (i + 1) * Math.ceil(shapesToRender.length / totalShapes)
    );
    const mergedText = shapesToRender.slice(start, end).join('\n').trim();
    if (!mergedText) continue;
    const fitted = fitTextToShape(mergedText, CONTENT_WIDTH, boxHeight, 14);
    execSlide.addText(fitted.text, {
      x: LEFT_MARGIN,
      y: tpContent.y + i * (boxHeight + boxGap),
      w: CONTENT_WIDTH,
      h: boxHeight,
      fontSize: fitted.fontSize,
      fontFace: FONT,
      color: COLORS.black,
      lineSpacingMultiple: 1.3,
      valign: 'top',
    });
  }
  registerTemplateCloneSlide(3, 'executiveSummary');

  // ===== SLIDE 4: OPPORTUNITIES & BARRIERS (after Exec Summary, matches template) =====
  const oppData = {
    opportunities: summary.opportunities,
    obstacles: summary.obstacles,
    summary: countryAnalysis.summary,
  };
  if (
    (Array.isArray(oppData.opportunities) && oppData.opportunities.length > 0) ||
    (Array.isArray(oppData.obstacles) && oppData.obstacles.length > 0)
  ) {
    const oppSlideCountBefore = pptx.slides.length;
    addOpportunitiesBarriersSlide(pptx, oppData, FONT);
    if (pptx.slides.length > oppSlideCountBefore) {
      registerTemplateCloneSlide(4, 'opportunitiesBarriers');
    }
  }

  // ===== GENERATE ALL SECTIONS =====
  const sectionConfigs = [
    { name: 'Policy & Regulatory', num: 1, data: policy },
    { name: 'Market Overview', num: 2, data: market },
    { name: 'Competitive Landscape', num: 3, data: competitors },
    { name: 'Strategic Analysis', num: 4, data: depth },
    { name: 'Recommendations', num: 5, data: summary },
  ];

  for (const sec of sectionConfigs) {
    try {
      generateSection(sec.name, sec.num, 6, sec.data);

      // Regulatory transition summary slide after Policy section
      if (sec.name === 'Policy & Regulatory' && policy?.regulatorySummary) {
        const regData = policy.regulatorySummary;
        const regSummarySlide = addSlideWithTitle(
          `${country} - Regulatory Transition Summary`,
          '',
          {
            citations: getCitationsForCategory('policy_'),
            dataQuality: getDataQualityForCategory('policy_'),
          }
        );
        registerTemplateCloneSlide(6, 'regulatorySummaryTransition');
        const regRows = normalizeRegulatorySummaryRows(regData);
        if (regRows.length > 0) {
          // Always render with the template's horizontal flow geometry for policy consistency.
          addHorizontalFlowTable(regSummarySlide, regRows, { font: FONT });
        } else if (typeof regData === 'object' && Object.keys(regData).length > 0) {
          // Keep policy rendering template-anchored even for malformed structures.
          const fallbackRows = [];
          const summaryText = ensureString(
            regData.overview || regData.summary || regData.narrative || ''
          );
          if (summaryText) {
            fallbackRows.push({
              label: 'Regulatory Summary',
              currentState: summaryText,
              transition: '',
              futureState: '',
            });
          }
          for (const [k, v] of Object.entries(regData)) {
            if (fallbackRows.length >= 4) break;
            if (String(k).startsWith('_')) continue;
            if (typeof v !== 'string' || !v.trim()) continue;
            fallbackRows.push({
              label: humanizeKeyLabel(k),
              currentState: ensureString(v),
              transition: '',
              futureState: '',
            });
          }
          if (fallbackRows.length > 0) {
            addHorizontalFlowTable(regSummarySlide, fallbackRows, { font: FONT });
          } else {
            addDataUnavailableMessage(
              regSummarySlide,
              `${country} regulatory summary not renderable in table format`
            );
          }
        }
      }
    } catch (sectionErr) {
      console.error(`[PPT] Section "${sec.name}" crashed: ${sectionErr?.message}`);
      throw new Error(
        `Section "${sec.name}" generation failed: ${sectionErr?.message || 'Unknown error'}`
      );
    }
  }

  // ===== APPENDIX: FINAL SUMMARY SLIDE (Section 6) =====
  addTocSlide(pptx, 5, SECTION_NAMES, COLORS, FONT, country); // Highlight "Appendix"
  registerTemplateCloneSlide(30, 'appendixToc');
  const finalSlide = addSlideWithTitle(
    `${country} - Research Summary`,
    `Analysis completed ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
  );
  const metricsRows = [tableHeader(['Metric', 'Value', 'Confidence'])];
  const escoMarketSize = market.escoMarket?.marketSize;
  if (escoMarketSize) {
    metricsRows.push([
      { text: 'Market Size' },
      { text: safeCell(escoMarketSize, 40) },
      {
        text: `${safeCell(enrichment.confidenceScore || countryAnalysis?.summary?.confidenceScore) || '--'}/100`,
      },
    ]);
  }
  const dealEcon = depth.dealEconomics || depth.escoEconomics;
  if (dealEcon?.typicalDealSize?.average) {
    metricsRows.push([
      { text: 'Typical Deal Size' },
      { text: safeCell(dealEcon.typicalDealSize.average) },
      { text: '' },
    ]);
  }
  const moa = enrichment.marketOpportunityAssessment || {};
  if (moa.totalAddressableMarket) {
    metricsRows.push([
      { text: 'Total Addressable Market (TAM)' },
      { text: safeCell(moa.totalAddressableMarket, 40) },
      { text: '' },
    ]);
  }
  if (moa.serviceableMarket) {
    metricsRows.push([
      { text: 'Serviceable Market (SAM)' },
      { text: safeCell(moa.serviceableMarket, 40) },
      { text: '' },
    ]);
  }
  const finalRatings = summary.ratings || {};
  if (finalRatings.attractiveness) {
    metricsRows.push([
      { text: 'Attractiveness' },
      { text: `${safeCell(finalRatings.attractiveness)}/10` },
      {
        text: finalRatings.attractivenessRationale
          ? safeCell(finalRatings.attractivenessRationale, 80)
          : '',
      },
    ]);
  }
  if (finalRatings.feasibility) {
    metricsRows.push([
      { text: 'Feasibility' },
      { text: `${safeCell(finalRatings.feasibility)}/10` },
      {
        text: finalRatings.feasibilityRationale
          ? safeCell(finalRatings.feasibilityRationale, 80)
          : '',
      },
    ]);
  }
  if (metricsRows.length > 1) {
    const metricsTableH = Math.min(2.5, metricsRows.length * 0.35 + 0.2);
    applyAlternateRowFill(metricsRows);
    safeAddTable(finalSlide, metricsRows, {
      x: LEFT_MARGIN,
      y: CONTENT_Y,
      w: CONTENT_WIDTH,
      h: metricsTableH,
      fontSize: 14,
      fontFace: FONT,
      border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: COLORS.border },
      margin: TABLE_CELL_MARGIN,
      colW: [3.36, 4.7, 4.54],
      valign: 'top',
    });
  }
  const finalGoNoGo = summary.goNoGo || {};
  if (finalGoNoGo.overallVerdict) {
    const finalVerdictStr = ensureString(finalGoNoGo.overallVerdict, '');
    const finalVerdictType =
      finalVerdictStr.includes('GO') && !finalVerdictStr.includes('NO')
        ? 'positive'
        : finalVerdictStr.includes('NO')
          ? 'negative'
          : 'warning';
    addCalloutBox(
      finalSlide,
      `VERDICT: ${finalGoNoGo.overallVerdict}`,
      (finalGoNoGo.conditions || []).slice(0, 2).join('; ') || '--',
      { y: 4.0, h: 0.9, type: finalVerdictType }
    );
  }
  addSourceFootnote(
    finalSlide,
    [
      'Government statistical agencies',
      'Industry associations',
      'Company filings and annual reports',
    ],
    COLORS,
    FONT
  );

  // Phase 2e: Enforce empty slide ratio — reject garbage decks
  const allSlides = pptx.slides || [];
  const contentSlides = allSlides.slice(3); // Skip cover, TOC, exec summary
  if (contentSlides.length > 0) {
    let emptySlideCount = 0;
    for (const sl of contentSlides) {
      const slideText = JSON.stringify(sl.data || sl);
      if (hasSemanticEmptyText(slideText) || hasTruncationArtifactText(slideText)) {
        emptySlideCount++;
      }
    }
    const emptyRatio = emptySlideCount / contentSlides.length;
    if (emptyRatio > 0.4) {
      throw new Error(
        `PPT empty slide ratio too high: ${(emptyRatio * 100).toFixed(0)}% (${emptySlideCount}/${contentSlides.length}) content slides are empty. Research data insufficient for quality output.`
      );
    }
  }

  const nonTemplate = templateUsageStats.nonTemplatePatterns;
  if (nonTemplate.length > 0) {
    const details = [...new Set(nonTemplate.map((x) => `${x.key}:${x.pattern}`))].join(', ');
    console.warn(`[PPT TEMPLATE] Non-template patterns used (${nonTemplate.length}): ${details}`);
  }
  if (templateUsageStats.slideRenderFailures.length > 0) {
    const failKeys = [
      ...new Set(
        templateUsageStats.slideRenderFailures.map(
          (f) => `${f.key}${f.pattern ? `:${f.pattern}` : ''}`
        )
      ),
    ].join(', ');
    const totalResolvedBlocks = Math.max(templateUsageStats.resolved.length, 1);
    if (strictGeometryMode) {
      throw new Error(
        `[STRICT GEOMETRY] Hard fail: ${templateUsageStats.slideRenderFailures.length} slide rendering failure(s) for blocks: ${failKeys}. Any render failure is a hard fail in strict geometry mode.`
      );
    }
    console.warn(
      `[PPT TEMPLATE] Recoverable rendering failures (${templateUsageStats.slideRenderFailures.length}/${totalResolvedBlocks}): ${failKeys}`
    );
    // Only throw if more than half of slides failed (truly unrecoverable)
    if (templateUsageStats.slideRenderFailures.length > totalResolvedBlocks * 0.5) {
      throw new Error(
        `PPT rendering failures too severe (${templateUsageStats.slideRenderFailures.length}/${totalResolvedBlocks}): ${failKeys}`
      );
    }
  }
  if (templateUsageStats.tableRecoveries.length > 0) {
    const recoveredKeys = [...new Set(templateUsageStats.tableRecoveries.map((r) => r.key))].join(
      ', '
    );
    if (strictGeometryMode) {
      throw new Error(
        `[STRICT GEOMETRY] Hard fail: ${templateUsageStats.tableRecoveries.length} table recovery/recoveries used for blocks: ${recoveredKeys}. Table recovery not allowed in strict geometry mode.`
      );
    }
    console.warn(
      `[PPT TEMPLATE] Table recoveries used (${templateUsageStats.tableRecoveries.length}): ${recoveredKeys}`
    );
  }
  const geometryIssues = [
    ...new Set(
      layoutFidelityStats.missingGeometry.map(
        (g) => `${g.kind}:${g.context}${g.reason ? ` (${g.reason})` : ''}`
      )
    ),
  ];
  if (geometryIssues.length > 0) {
    if (strictGeometryMode || STRICT_TEMPLATE_FIDELITY) {
      throw new Error(
        `Template fidelity violation: geometry issues (${geometryIssues.length}): ${geometryIssues.slice(0, 10).join(', ')}`
      );
    }
    console.warn(
      `[PPT TEMPLATE] Geometry issues (${geometryIssues.length}): ${geometryIssues.slice(0, 10).join(', ')}`
    );
  }

  const fallbackTemplateMappings = templateUsageStats.resolved.filter((entry) =>
    /fallback/i.test(ensureString(entry?.source).toLowerCase())
  );
  if (fallbackTemplateMappings.length > 0) {
    const fallbackKeys = [
      ...new Set(
        fallbackTemplateMappings.map(
          (entry) =>
            `${entry.key}${entry.pattern ? `:${entry.pattern}` : ''} [${entry.source || 'fallback'}]`
        )
      ),
    ].slice(0, 20);
    throw new Error(
      `Template mapping fallback detected (${fallbackTemplateMappings.length} block(s)): ${fallbackKeys.join(', ')}. Add explicit template mappings for these block keys.`
    );
  }

  let pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  pptxBuffer = await normalizeChartRelationshipTargets(pptxBuffer);

  const templateCloneResult = await applyTemplateClonePostprocess(pptxBuffer, {
    templatePath: path.join(
      __dirname,
      '..',
      '..',
      '251219_Escort_Phase 1 Market Selection_V3.pptx'
    ),
    maxSlides: 34,
    slideTemplateMap: templateCloneSlideMap,
    enabled: true,
  });
  pptxBuffer = templateCloneResult.buffer;
  if (templateCloneResult.changed) {
    console.log(
      `[PPT TEMPLATE] Clone mode applied: mappedPairs=${templateCloneResult.stats.mappedPairs || 0}, slides=${templateCloneResult.stats.clonedSlides}, fallbackSlides=${templateCloneResult.stats.fallbackSlides || 0}, textReplacements=${templateCloneResult.stats.textReplacements}, droppedTokens=${templateCloneResult.stats.droppedTokens}, chartRelPatched=${templateCloneResult.stats.chartRelPatched}, copiedSupportParts=${templateCloneResult.stats.copiedSupportParts}, copiedReferencedParts=${templateCloneResult.stats.copiedReferencedParts || 0}, contextFit(ai=${templateCloneResult.stats.contextFitAISlides || 0},heuristic=${templateCloneResult.stats.contextFitHeuristicSlides || 0},none=${templateCloneResult.stats.contextFitNoneSlides || 0})`
    );
  } else {
    console.warn('[PPT TEMPLATE] Clone mode not applied (no slide clones performed)');
  }

  pptxBuffer = await normalizeThemeToTemplate(pptxBuffer, {
    colors: {
      dk1: tpColors.dk1 || '000000',
      lt1: tpColors.lt1 || 'FFFFFF',
      dk2: tpColors.dk2 || '1F497D',
      lt2: tpColors.lt2 || '1F497D',
      accent1: tpColors.accent1 || '007FFF',
      accent2: tpColors.accent2 || 'EDFDFF',
      accent3: tpColors.accent3 || '011AB7',
      accent4: tpColors.accent4 || '1524A9',
      accent5: tpColors.accent5 || '001C44',
      accent6: tpColors.accent6 || 'E46C0A',
    },
    majorFontFace: 'Segoe UI',
    minorFontFace: 'Segoe UI',
  });
  if (typeof normalizeAbsoluteRelationshipTargets === 'function') {
    const absoluteRelNormalize = await normalizeAbsoluteRelationshipTargets(pptxBuffer);
    pptxBuffer = absoluteRelNormalize.buffer;
    if (absoluteRelNormalize.changed) {
      console.log(
        `[PPT] Normalized ${absoluteRelNormalize.stats.normalizedTargets} absolute relationship target(s)`
      );
    }
  }
  const nonVisualIdNormalize = await normalizeSlideNonVisualIds(pptxBuffer);
  pptxBuffer = nonVisualIdNormalize.buffer;
  if (nonVisualIdNormalize.changed) {
    console.log(
      `[PPT] Normalized duplicate slide shape ids (${nonVisualIdNormalize.stats.reassignedIds} id reassignment(s) across ${nonVisualIdNormalize.stats.slidesAdjusted} slide(s))`
    );
  }
  const contentTypeReconcile = await reconcileContentTypesAndPackage(pptxBuffer);
  pptxBuffer = contentTypeReconcile.buffer;
  if (contentTypeReconcile.changed) {
    const touched = [
      ...(contentTypeReconcile.stats.addedDefaults || []),
      ...(contentTypeReconcile.stats.correctedDefaults || []),
      ...(contentTypeReconcile.stats.addedOverrides || []),
      ...(contentTypeReconcile.stats.correctedOverrides || []),
      ...(contentTypeReconcile.stats.removedDangling || []),
    ].length;
    console.log(`[PPT] Reconciled content types (${touched} adjustment(s))`);
  }
  const formattingAudit = await auditGeneratedPptFormatting(pptxBuffer, {
    strictMode: strictGeometryMode,
  });
  if (!formattingAudit.pass) {
    const criticalIssues = formattingAudit.issues
      .filter((i) => i.severity === 'critical')
      .map((i) => `${i.code}: ${i.message}`);
    if (criticalIssues.length > 0) {
      console.error(
        `[PPT TEMPLATE] Formatting audit critical issues: ${criticalIssues.join(' | ')}`
      );
      if (Array.isArray(formattingAudit.checks?.tableMarginOutliers)) {
        const outlierPreview = formattingAudit.checks.tableMarginOutliers
          .slice(0, 8)
          .map((o) => `${o.slide}:${o.side}=${o.value}`)
          .join(', ');
        if (outlierPreview) {
          console.error(`[PPT TEMPLATE] Margin outlier preview: ${outlierPreview}`);
        }
      }
    }
    const criticalCodes = formattingAudit.issues
      .filter((i) => i.severity === 'critical')
      .map((i) => i.code)
      .join(', ');
    throw new Error(`PPT formatting audit failed: critical issues detected (${criticalCodes})`);
  }
  if (formattingAudit.warningCount > 0) {
    const warningIssues = formattingAudit.issues.filter((i) => i.severity === 'warning');
    const warningCodes = warningIssues.map((i) => i.code).join(', ');
    if (strictGeometryMode) {
      // Strict mode: formatting warnings (drift/mismatch) are hard failures.
      // Extract blocking slide keys from each warning issue for precise diagnostics.
      const blockingSlideKeys = warningIssues.map((i) => {
        const slideMatch = (i.message || '').match(/slide\S*\s*(\S+)/i);
        return i.code + (slideMatch ? `:${slideMatch[1]}` : '');
      });
      const rootCauses = warningIssues.map((i) => `[${i.code}] ${i.message}`);
      throw new Error(
        `PPT formatting audit strict-mode failure: ${formattingAudit.warningCount} warning(s) promoted to hard fail.\n` +
          `Blocking slide keys: ${blockingSlideKeys.join(', ')}\n` +
          `Root causes:\n${rootCauses.map((r) => `  - ${r}`).join('\n')}`
      );
    }
    console.warn(
      `[PPT TEMPLATE] Formatting audit warnings (${formattingAudit.warningCount}): ${warningCodes}`
    );
  }
  const relZip = await JSZip.loadAsync(pptxBuffer);
  const relIntegrity = await scanRelationshipTargets(relZip);
  if (relIntegrity.missingInternalTargets.length > 0) {
    const examples = relIntegrity.missingInternalTargets
      .slice(0, 5)
      .map((m) => `${m.relFile} -> ${m.target} (${m.reason})`)
      .join(' | ');
    throw new Error(
      `PPT relationship integrity failed: ${relIntegrity.missingInternalTargets.length} broken internal target(s); ${examples}`
    );
  }
  if (
    Array.isArray(relIntegrity.invalidExternalTargets) &&
    relIntegrity.invalidExternalTargets.length > 0
  ) {
    const examples = relIntegrity.invalidExternalTargets
      .slice(0, 5)
      .map((m) => `${m.relFile} -> ${m.target || '(empty)'} (${m.reason})`)
      .join(' | ');
    throw new Error(
      `PPT external relationship integrity failed: ${relIntegrity.invalidExternalTargets.length} invalid external target(s); ${examples}`
    );
  }
  if (relIntegrity.checkedInternal > 0) {
    console.log(
      `[PPT] Relationship integrity check passed (${relIntegrity.checkedInternal} targets)`
    );
  }
  const packageConsistency = await scanPackageConsistency(relZip);
  const packageIssues = collectPackageConsistencyIssues(packageConsistency);
  if (packageIssues.length > 0) {
    throw new Error(`PPT package consistency failed: ${packageIssues.join(' | ')}`);
  }

  // Last-mile reconcile + re-scan to catch any final [Content_Types] drift before delivery.
  const finalReconcile = await reconcileContentTypesAndPackage(pptxBuffer);
  pptxBuffer = finalReconcile.buffer;
  if (finalReconcile.changed) {
    const touched = [
      ...(finalReconcile.stats.addedDefaults || []),
      ...(finalReconcile.stats.correctedDefaults || []),
      ...(finalReconcile.stats.addedOverrides || []),
      ...(finalReconcile.stats.correctedOverrides || []),
      ...(finalReconcile.stats.removedDangling || []),
    ].length;
    console.log(`[PPT] Final content-type reconcile applied (${touched} adjustment(s))`);
  }
  const finalZip = await JSZip.loadAsync(pptxBuffer);
  const finalPackageConsistency = await scanPackageConsistency(finalZip);
  const finalPackageIssues = collectPackageConsistencyIssues(finalPackageConsistency);
  if (finalPackageIssues.length > 0) {
    throw new Error(`PPT package final consistency failed: ${finalPackageIssues.join(' | ')}`);
  }
  console.log('[PPT] Final package consistency check passed');

  const sparseSlideCharThreshold = envNumber('PPT_SPARSE_SLIDE_CHAR_THRESHOLD', 60, {
    min: 20,
    max: 120,
  });
  const allowedSparseTexts = new Set(
    SECTION_NAMES.flatMap((name) => {
      const normalized = ensureString(name).replace(/\s+/g, ' ').trim().toLowerCase();
      return [normalized, normalized.replace(/&/g, '&amp;')];
    })
  );
  const isAllowedSparseSlideText = (normalizedText) => {
    const txt = ensureString(normalizedText).trim().toLowerCase();
    if (!txt) return false;
    if (allowedSparseTexts.has(txt)) return true;
    // TOC slides are intentionally sparse and may include active section labels.
    if (txt.startsWith('table of contents')) return true;
    if (txt.startsWith('appendix')) return true;
    return false;
  };
  const finalTextAudit = await extractAllText(finalZip);
  const unexpectedSparseSlides = (finalTextAudit.slides || [])
    .map((slide) => {
      const normalizedText = ensureString(slide.fullText).replace(/\s+/g, ' ').trim().toLowerCase();
      return {
        slide: slide.slideNum,
        charCount: slide.charCount,
        normalizedText,
        preview: ensureString(slide.fullText).replace(/\s+/g, ' ').trim().slice(0, 90),
      };
    })
    .filter((slide) => Number(slide.charCount || 0) < sparseSlideCharThreshold)
    .filter((slide) => !isAllowedSparseSlideText(slide.normalizedText));
  if (unexpectedSparseSlides.length > 0) {
    const preview = unexpectedSparseSlides
      .slice(0, 8)
      .map((s) => `slide ${s.slide} (${s.charCount} chars): "${s.preview || '(empty)'}"`)
      .join(' | ');
    throw new Error(
      `PPT content coverage failed: ${unexpectedSparseSlides.length} sparse slide(s) below ${sparseSlideCharThreshold} chars outside allowed divider slides; ${preview}`
    );
  }
  console.log(
    `[PPT] Sparse-slide guard passed (threshold=${sparseSlideCharThreshold}, sparse=${unexpectedSparseSlides.length})`
  );

  const totalSlides = 4 + sectionDefs.length + sectionBlockCounts.reduce((a, b) => a + b, 0) + 2; // cover + TOC + exec + opps + sections + appendix TOC + summary
  const templateBackedCount = templateUsageStats.resolved.filter((x) => x.templateBacked).length;
  const templateTotal = templateUsageStats.resolved.length;
  const templateCoverage =
    templateTotal > 0 ? Math.round((templateBackedCount / templateTotal) * 100) : 100;
  const pptMetrics = {
    strictGeometryMode,
    templateCoverage,
    templateBackedCount,
    templateTotal,
    nonTemplatePatternCount: templateUsageStats.nonTemplatePatterns.length,
    slideRenderFailureCount: templateUsageStats.slideRenderFailures.length,
    tableRecoveryCount: templateUsageStats.tableRecoveries.length,
    tableRecoveryKeys: [...new Set(templateUsageStats.tableRecoveries.map((r) => r.key))],
    tableFallbackCount: templateUsageStats.tableFallbacks.length,
    tableFallbackKeys: [...new Set(templateUsageStats.tableFallbacks.map((f) => f.key))],
    tableRecoveryTypes: templateUsageStats.tableRecoveries.reduce((acc, r) => {
      acc[r.recoveryType] = (acc[r.recoveryType] || 0) + 1;
      return acc;
    }, {}),
    geometryCheckCount: layoutFidelityStats.checks,
    geometryAlignedCount: layoutFidelityStats.aligned,
    geometryMaxDelta: Number(layoutFidelityStats.maxDelta.toFixed(4)),
    geometryIssueCount: geometryIssues.length,
    geometryIssueKeys: geometryIssues.slice(0, 20),
    slideRenderFailureKeys: [
      ...new Set(templateUsageStats.slideRenderFailures.map((f) => f.key || 'unknown')),
    ],
    formattingAuditIssueCount: formattingAudit.issues.length,
    formattingAuditCriticalCount: formattingAudit.criticalCount,
    formattingAuditWarningCount: formattingAudit.warningCount,
    formattingAuditIssueCodes: formattingAudit.issues.map((i) => i.code),
    formattingAuditChecks: formattingAudit.checks,
    sparseSlideThreshold: sparseSlideCharThreshold,
    sparseSlideUnexpectedCount: unexpectedSparseSlides.length,
    fallbackTemplateMappingCount: fallbackTemplateMappings.length,
    fallbackTemplateMappingKeys: fallbackTemplateMappings
      .map((entry) => `${entry.key}:${entry.source || 'fallback'}`)
      .slice(0, 30),
    templateCloneApplied: templateCloneResult.changed,
    templateCloneStats: templateCloneResult.stats,
  };
  console.log(
    `[PPT TEMPLATE] Coverage: ${templateCoverage}% (${templateBackedCount}/${templateTotal}) template-backed block mappings`
  );
  if (templateUsageStats.tableRecoveries.length > 0) {
    const recoveredKeys = [...new Set(templateUsageStats.tableRecoveries.map((r) => r.key))].join(
      ', '
    );
    console.warn(
      `[PPT] Table recoveries applied for ${templateUsageStats.tableRecoveries.length} table(s): ${recoveredKeys}`
    );
  }
  console.log(
    `Section-based PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB, ~${totalSlides} slides`
  );
  // Attach run metrics for diagnostics/quality gating in server pipeline.
  pptxBuffer.__pptMetrics = pptMetrics;
  return pptxBuffer;
}

// Standalone version of globalDedup for testing (the real one is closure-scoped)
function _dedupeGlobalCompanyList(arr, seenSet) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((item) => {
    const key = String(item.name || '')
      .trim()
      .toLowerCase()
      .replace(
        /\b(ltd|inc|corp|co|llc|plc|sdn\s*bhd|pte|pvt|limited|corporation|company)\b\.?/gi,
        ''
      )
      .replace(/[^a-z0-9]/g, '');
    if (!key || seenSet.has(key)) return false;
    seenSet.add(key);
    return true;
  });
}

module.exports = {
  generateSingleCountryPPT,
  auditGeneratedPptFormatting,
  __test: {
    shouldAllowCompetitiveOptionalGroupGap,
    resolveTemplateRouteWithGeometryGuard,
    computeTableFitScore,
    safeCell,
    dedupeGlobalCompanyList: _dedupeGlobalCompanyList,
    isTransientKey,
    sanitizeTransientKeys,
  },
};
