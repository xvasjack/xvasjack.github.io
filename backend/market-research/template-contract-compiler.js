#!/usr/bin/env node
'use strict';

/**
 * Template Contract Compiler
 *
 * Parses template-patterns.json to extract per-slide geometry contracts and
 * validates runtime slide mappings (from ppt-single-country.js) against them.
 *
 * Exports: compile(), drift(), doctor()
 * CLI:     node template-contract-compiler.js --doctor
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants — mirrored from ppt-utils.js / ppt-single-country.js
// ---------------------------------------------------------------------------

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

const SECTION_DIVIDER_TEMPLATE_SLIDES = { 1: 5, 2: 11, 3: 20, 4: 30, 5: 30 };

const DATA_TYPE_PATTERN_MAP = Object.freeze({
  time_series_multi_insight: 'chart_insight_panels',
  time_series_annotated: 'chart_with_grid',
  two_related_series: 'chart_callout_dual',
  time_series_simple: 'chart_with_grid',
  composition_breakdown: 'chart_with_grid',
  company_comparison: 'company_comparison',
  regulation_list: 'regulatory_table',
  policy_analysis: 'regulatory_table',
  case_study: 'case_study_rows',
  financial_performance: 'dual_chart_financial',
  opportunities_vs_barriers: 'regulatory_table',
  section_summary: 'regulatory_table',
  definitions: 'glossary',
});

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------
const CONTRACT_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadTemplatePatterns(filePath) {
  const resolvedPath = filePath || path.join(__dirname, 'template-patterns.json');
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  return JSON.parse(raw);
}

function sha256(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function isValidRect(rect) {
  return (
    rect &&
    typeof rect === 'object' &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.w) &&
    Number.isFinite(rect.h)
  );
}

function rectFromPos(pos) {
  if (!pos || typeof pos !== 'object') return null;
  const x = Number(pos.x ?? pos.left);
  const y = Number(pos.y ?? pos.top);
  const w = Number(pos.w ?? pos.width);
  const h = Number(pos.h ?? pos.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return null;
  }
  return { x, y, w, h };
}

function classifyGeometryType(patternKey, elements) {
  if (!elements) return 'text';
  if (elements.table) return 'table';
  if (elements.chart || elements.chartLeft || elements.chartRight) return 'chart';
  if (elements.insightPanels) return 'chart'; // chart + panels
  if (elements.rows) return 'table'; // case_study_rows
  if (elements.quadrants) return 'matrix';
  if (elements.tocTable) return 'table';
  if (patternKey === 'cover') return 'image';
  return 'text';
}

function extractElementConstraints(elements) {
  if (!elements || typeof elements !== 'object') return {};
  const constraints = {};
  for (const [key, val] of Object.entries(elements)) {
    if (Array.isArray(val)) {
      constraints[key] = val.map((item) => {
        const rect = rectFromPos(item);
        return rect ? { ...rect, ...item } : item;
      });
    } else if (val && typeof val === 'object' && (val.x !== undefined || val.left !== undefined)) {
      constraints[key] = rectFromPos(val) || val;
    } else {
      constraints[key] = val;
    }
  }
  return constraints;
}

function inferMaxTableDimensions(slideLayout) {
  if (!slideLayout) return { maxRows: 16, maxCols: 9, maxCellChars: 3000 };
  const content = slideLayout.content || slideLayout.table;
  if (!content) return { maxRows: 16, maxCols: 9, maxCellChars: 3000 };
  // Heuristic: row height ~0.3", col width ~1.2"
  const h = content.h || 5.0;
  const w = content.w || 12.6;
  const maxRows = Math.max(4, Math.min(40, Math.floor(h / 0.16)));
  const maxCols = Math.max(3, Math.min(20, Math.floor(w / 0.58)));
  return { maxRows, maxCols, maxCellChars: 3000 };
}

function buildSlideLayout(slideDetail) {
  if (!slideDetail) return null;
  const elements = Array.isArray(slideDetail.elements) ? slideDetail.elements : [];
  const shapes = elements.filter((e) => e?.type === 'shape' && e?.position);
  const tables = elements
    .filter((e) => e?.type === 'table' && e?.position)
    .map((e) => rectFromPos(e.position))
    .filter(Boolean);
  const charts = elements
    .filter((e) => e?.type === 'chart' && e?.position)
    .map((e) => rectFromPos(e.position))
    .filter((r) => r && r.w > 0.2 && r.h > 0.2);

  const titleShape = shapes.find(
    (s) => /^title/i.test(String(s?.name || '')) && s.position?.y < 1.3
  );
  const title = titleShape ? rectFromPos(titleShape.position) : null;

  const largestTable = tables.length > 0 ? tables.sort((a, b) => b.w * b.h - a.w * a.h)[0] : null;

  return {
    slideNumber: slideDetail.slideNumber,
    title,
    table: largestTable,
    charts,
    elementCount: elements.length,
    elementTypes: [...new Set(elements.map((e) => e?.type).filter(Boolean))],
  };
}

// ---------------------------------------------------------------------------
// compile() — main compiler
// ---------------------------------------------------------------------------

/**
 * Compile template-patterns.json into executable geometry contracts.
 *
 * @param {object} [options]
 * @param {string} [options.templatePath] - Path to template-patterns.json
 * @param {object} [options.templateData] - Pre-loaded template data (skips file read)
 * @returns {object} Compiled contract bundle
 */
function compile(options = {}) {
  const tp =
    options.templateData !== undefined
      ? options.templateData
      : loadTemplatePatterns(options.templatePath);

  if (!tp || typeof tp !== 'object') {
    throw new Error('Invalid template-patterns.json: not an object');
  }
  if (!tp.patterns || typeof tp.patterns !== 'object') {
    throw new Error('Invalid template-patterns.json: missing "patterns" key');
  }

  const meta = tp._meta || {};
  const patterns = tp.patterns;
  const slideDetails = Array.isArray(tp.slideDetails) ? tp.slideDetails : [];

  // Build slide layout cache
  const slideLayoutMap = new Map();
  for (const sd of slideDetails) {
    const num = Number(sd?.slideNumber);
    if (Number.isFinite(num)) {
      slideLayoutMap.set(num, buildSlideLayout(sd));
    }
  }

  // Compile per-pattern contracts
  const patternContracts = {};
  for (const [patternKey, patternDef] of Object.entries(patterns)) {
    const templateSlides = Array.isArray(patternDef.templateSlides)
      ? patternDef.templateSlides
      : [];
    const geometryType = classifyGeometryType(patternKey, patternDef.elements);
    const elementConstraints = extractElementConstraints(patternDef.elements);

    // Per-slide layout snapshots
    const slideLayouts = {};
    for (const slideId of templateSlides) {
      const layout = slideLayoutMap.get(Number(slideId));
      if (layout) {
        slideLayouts[slideId] = layout;
      }
    }

    patternContracts[patternKey] = {
      id: patternDef.id,
      description: patternDef.description || '',
      aliasOf: patternDef.aliasOf || null,
      geometryType,
      allowedSlideIds: templateSlides,
      layoutId: patternDef.layout ?? null,
      elementConstraints,
      slideLayouts,
      isTemplateBacked: templateSlides.length > 0,
    };
  }

  // Compile per-block contracts
  const blockContracts = {};
  for (const [blockKey, patternKey] of Object.entries(BLOCK_TEMPLATE_PATTERN_MAP)) {
    const patternContract = patternContracts[patternKey];
    const slideId = BLOCK_TEMPLATE_SLIDE_MAP[blockKey];
    const slideLayout = slideId ? slideLayoutMap.get(Number(slideId)) : null;

    let requiredGeometry = null;
    if (TABLE_TEMPLATE_CONTEXTS.has(blockKey)) requiredGeometry = 'table';
    else if (CHART_TEMPLATE_CONTEXTS.has(blockKey)) requiredGeometry = 'chart';

    const tableDimensions =
      requiredGeometry === 'table' ? inferMaxTableDimensions(slideLayout) : null;

    // Fallback chain: try all slides for this pattern if primary fails
    const fallbackChain = patternContract
      ? patternContract.allowedSlideIds.filter((s) => s !== slideId)
      : [];

    blockContracts[blockKey] = {
      patternKey,
      requiredGeometry,
      primarySlideId: slideId || null,
      allowedSlideIds: patternContract ? patternContract.allowedSlideIds : [],
      fallbackChain,
      geometryType: patternContract ? patternContract.geometryType : 'text',
      requiredLayoutKeys: ['title', 'source', 'content'],
      tableDimensions,
      slideLayout: slideLayout
        ? {
            hasTable: Boolean(slideLayout.table),
            hasCharts: slideLayout.charts.length > 0,
            elementCount: slideLayout.elementCount,
          }
        : null,
    };
  }

  // Compile section divider contracts
  const sectionDividerContracts = {};
  for (const [sectionNum, slideId] of Object.entries(SECTION_DIVIDER_TEMPLATE_SLIDES)) {
    sectionDividerContracts[sectionNum] = {
      slideId,
      patternKey: 'section_divider',
      hasLayout: slideLayoutMap.has(Number(slideId)),
    };
  }

  // Data type fallback mapping
  const dataTypeFallbacks = { ...DATA_TYPE_PATTERN_MAP };

  const contractBundle = {
    version: CONTRACT_VERSION,
    compiledAt: new Date().toISOString(),
    templateSource: meta.source || 'unknown',
    templateExtractedAt: meta.extractedAt || null,
    slideCount: meta.slideCount || slideDetails.length,
    patternContracts,
    blockContracts,
    sectionDividerContracts,
    dataTypeFallbacks,
    signature: null, // filled below
  };

  contractBundle.signature = sha256(contractBundle);
  return contractBundle;
}

// ---------------------------------------------------------------------------
// drift() — contract drift detector
// ---------------------------------------------------------------------------

/**
 * Compare runtime slide mappings against compiled contracts.
 * Reports mismatches between what ppt-single-country.js uses at runtime
 * and what the compiled contracts expect.
 *
 * @param {object} compiledContracts - Output of compile()
 * @param {object} [runtimeMappings] - Optional override; defaults to the
 *   hardcoded maps (BLOCK_TEMPLATE_PATTERN_MAP / BLOCK_TEMPLATE_SLIDE_MAP)
 * @returns {object} Drift report
 */
function drift(compiledContracts, runtimeMappings = null) {
  const runtime = runtimeMappings || {
    blockPatterns: { ...BLOCK_TEMPLATE_PATTERN_MAP },
    blockSlides: { ...BLOCK_TEMPLATE_SLIDE_MAP },
    tableContexts: [...TABLE_TEMPLATE_CONTEXTS],
    chartContexts: [...CHART_TEMPLATE_CONTEXTS],
  };

  const issues = [];
  const blockContracts = compiledContracts.blockContracts || {};

  // 1. Check every block contract against runtime
  for (const [blockKey, contract] of Object.entries(blockContracts)) {
    const runtimePattern = runtime.blockPatterns?.[blockKey];
    const runtimeSlide = runtime.blockSlides?.[blockKey];

    if (!runtimePattern) {
      issues.push({
        type: 'missing_runtime_pattern',
        blockKey,
        expected: contract.patternKey,
        actual: null,
        severity: 'error',
        message: `Block "${blockKey}" has a compiled contract but no runtime pattern mapping`,
      });
      continue;
    }

    if (runtimePattern !== contract.patternKey) {
      issues.push({
        type: 'pattern_mismatch',
        blockKey,
        expected: contract.patternKey,
        actual: runtimePattern,
        severity: 'error',
        message: `Block "${blockKey}" pattern drift: contract="${contract.patternKey}" runtime="${runtimePattern}"`,
      });
    }

    if (runtimeSlide !== contract.primarySlideId) {
      issues.push({
        type: 'slide_mismatch',
        blockKey,
        expected: contract.primarySlideId,
        actual: runtimeSlide,
        severity: 'error',
        message: `Block "${blockKey}" slide drift: contract=${contract.primarySlideId} runtime=${runtimeSlide}`,
      });
    }

    // Geometry context check
    const isRuntimeTable = runtime.tableContexts?.includes(blockKey);
    const isRuntimeChart = runtime.chartContexts?.includes(blockKey);
    const expectedGeometry = contract.requiredGeometry;

    if (expectedGeometry === 'table' && !isRuntimeTable) {
      issues.push({
        type: 'geometry_context_mismatch',
        blockKey,
        expected: 'table',
        actual: isRuntimeChart ? 'chart' : 'none',
        severity: 'warning',
        message: `Block "${blockKey}" expects table geometry but not in TABLE_TEMPLATE_CONTEXTS`,
      });
    }
    if (expectedGeometry === 'chart' && !isRuntimeChart) {
      issues.push({
        type: 'geometry_context_mismatch',
        blockKey,
        expected: 'chart',
        actual: isRuntimeTable ? 'table' : 'none',
        severity: 'warning',
        message: `Block "${blockKey}" expects chart geometry but not in CHART_TEMPLATE_CONTEXTS`,
      });
    }

    // Check slide is within allowed range
    if (
      runtimeSlide &&
      contract.allowedSlideIds.length > 0 &&
      !contract.allowedSlideIds.includes(runtimeSlide)
    ) {
      issues.push({
        type: 'slide_out_of_range',
        blockKey,
        expected: contract.allowedSlideIds,
        actual: runtimeSlide,
        severity: 'error',
        message: `Block "${blockKey}" runtime slide ${runtimeSlide} not in allowed set [${contract.allowedSlideIds.join(',')}]`,
      });
    }
  }

  // 2. Check for runtime blocks not in contracts
  for (const blockKey of Object.keys(runtime.blockPatterns || {})) {
    if (!blockContracts[blockKey]) {
      issues.push({
        type: 'uncontracted_block',
        blockKey,
        expected: null,
        actual: runtime.blockPatterns[blockKey],
        severity: 'warning',
        message: `Runtime block "${blockKey}" has no compiled contract`,
      });
    }
  }

  return {
    driftDetected: issues.length > 0,
    issueCount: issues.length,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
    issues,
    checkedAt: new Date().toISOString(),
    contractVersion: compiledContracts.version,
    contractSignature: compiledContracts.signature,
  };
}

// ---------------------------------------------------------------------------
// doctor() — full diagnostic report
// ---------------------------------------------------------------------------

/**
 * Run a full diagnostic on the template contract system.
 *
 * @param {object} [options]
 * @param {string} [options.templatePath]
 * @param {object} [options.templateData]
 * @returns {object} Doctor report
 */
function doctor(options = {}) {
  const report = {
    status: 'ok',
    checks: [],
    summary: {},
  };

  // 1. Compile
  let compiled;
  try {
    compiled = compile(options);
    report.checks.push({
      name: 'compile',
      status: 'pass',
      message: `Compiled ${Object.keys(compiled.patternContracts).length} pattern contracts, ${Object.keys(compiled.blockContracts).length} block contracts`,
    });
  } catch (err) {
    report.status = 'fail';
    report.checks.push({
      name: 'compile',
      status: 'fail',
      message: `Compilation failed: ${err.message}`,
    });
    return report;
  }

  // 2. Contract integrity
  const sig = compiled.signature;
  const recomputed = sha256({ ...compiled, signature: null });
  if (sig === recomputed) {
    report.checks.push({
      name: 'signature_integrity',
      status: 'pass',
      message: `SHA-256 signature verified: ${sig.substring(0, 16)}...`,
    });
  } else {
    report.status = 'fail';
    report.checks.push({
      name: 'signature_integrity',
      status: 'fail',
      message: `Signature mismatch: expected ${recomputed.substring(0, 16)}... got ${sig.substring(0, 16)}...`,
    });
  }

  // 3. Pattern coverage
  const patternsWithSlides = Object.entries(compiled.patternContracts).filter(
    ([, c]) => c.isTemplateBacked
  );
  const patternsWithoutSlides = Object.entries(compiled.patternContracts).filter(
    ([, c]) => !c.isTemplateBacked
  );
  report.checks.push({
    name: 'pattern_coverage',
    status: patternsWithoutSlides.length > 1 ? 'warning' : 'pass',
    message: `${patternsWithSlides.length} template-backed patterns, ${patternsWithoutSlides.length} custom-only (${patternsWithoutSlides.map(([k]) => k).join(', ') || 'none'})`,
  });

  // 4. Block-to-slide mapping completeness
  const blocksWithoutSlide = Object.entries(compiled.blockContracts).filter(
    ([, c]) => !c.primarySlideId
  );
  report.checks.push({
    name: 'block_slide_coverage',
    status: blocksWithoutSlide.length > 0 ? 'fail' : 'pass',
    message:
      blocksWithoutSlide.length > 0
        ? `${blocksWithoutSlide.length} blocks missing slide mapping: ${blocksWithoutSlide.map(([k]) => k).join(', ')}`
        : `All ${Object.keys(compiled.blockContracts).length} blocks have explicit slide mappings`,
  });

  // 5. Geometry verification per block
  const geometryIssues = [];
  for (const [blockKey, contract] of Object.entries(compiled.blockContracts)) {
    if (
      contract.requiredGeometry === 'table' &&
      contract.slideLayout &&
      !contract.slideLayout.hasTable
    ) {
      geometryIssues.push(
        `${blockKey}: needs table but slide ${contract.primarySlideId} has no table`
      );
    }
    if (
      contract.requiredGeometry === 'chart' &&
      contract.slideLayout &&
      !contract.slideLayout.hasCharts
    ) {
      geometryIssues.push(
        `${blockKey}: needs chart but slide ${contract.primarySlideId} has no charts`
      );
    }
  }
  report.checks.push({
    name: 'geometry_validation',
    status: geometryIssues.length > 0 ? 'warning' : 'pass',
    message:
      geometryIssues.length > 0
        ? `${geometryIssues.length} geometry issues: ${geometryIssues.slice(0, 5).join('; ')}`
        : 'All block geometry requirements satisfied by their slide layouts',
  });

  // 6. Drift detection
  const driftReport = drift(compiled);
  report.checks.push({
    name: 'drift_detection',
    status: driftReport.errorCount > 0 ? 'fail' : driftReport.warningCount > 0 ? 'warning' : 'pass',
    message: driftReport.driftDetected
      ? `${driftReport.errorCount} errors, ${driftReport.warningCount} warnings`
      : 'No drift detected between contracts and runtime mappings',
  });

  // 7. Slide utilization
  const usedSlides = new Set();
  for (const contract of Object.values(compiled.patternContracts)) {
    for (const s of contract.allowedSlideIds) usedSlides.add(s);
  }
  const totalSlides = compiled.slideCount || 0;
  const unusedSlides = [];
  for (let i = 1; i <= totalSlides; i++) {
    if (!usedSlides.has(i)) unusedSlides.push(i);
  }
  report.checks.push({
    name: 'slide_utilization',
    status: 'info',
    message: `${usedSlides.size}/${totalSlides} template slides referenced. Unused: [${unusedSlides.join(', ') || 'none'}]`,
  });

  // 8. Alias chain validation
  const aliasIssues = [];
  for (const [patternKey, contract] of Object.entries(compiled.patternContracts)) {
    if (contract.aliasOf && !compiled.patternContracts[contract.aliasOf]) {
      aliasIssues.push(`${patternKey} aliases "${contract.aliasOf}" which does not exist`);
    }
  }
  report.checks.push({
    name: 'alias_validation',
    status: aliasIssues.length > 0 ? 'fail' : 'pass',
    message:
      aliasIssues.length > 0
        ? `Broken aliases: ${aliasIssues.join('; ')}`
        : 'All pattern aliases resolve correctly',
  });

  // Summary
  const failCount = report.checks.filter((c) => c.status === 'fail').length;
  const warnCount = report.checks.filter((c) => c.status === 'warning').length;
  const passCount = report.checks.filter((c) => c.status === 'pass').length;

  report.status = failCount > 0 ? 'fail' : warnCount > 0 ? 'warning' : 'ok';
  report.summary = {
    total: report.checks.length,
    pass: passCount,
    warning: warnCount,
    fail: failCount,
    contractVersion: compiled.version,
    signature: compiled.signature,
    patternCount: Object.keys(compiled.patternContracts).length,
    blockCount: Object.keys(compiled.blockContracts).length,
  };

  return report;
}

// ---------------------------------------------------------------------------
// auditCoverage() — Task 1: report which blocks have contracts
// ---------------------------------------------------------------------------

/**
 * Audit contract coverage for all rendered blocks.
 * Reports which blocks have contracts, which don't, and coverage %.
 *
 * @param {object} [options]
 * @param {string} [options.templatePath]
 * @param {object} [options.templateData]
 * @param {string[]} [options.renderedBlocks] - list of block keys actually rendered at runtime
 * @returns {object} Coverage report
 */
function auditCoverage(options = {}) {
  let compiled;
  try {
    compiled = compile(options);
  } catch (err) {
    return {
      error: err.message,
      coveredBlocks: [],
      uncoveredBlocks: [],
      coveragePercent: 0,
      totalBlocks: 0,
    };
  }

  const contractedBlockKeys = new Set(Object.keys(compiled.blockContracts));
  const renderedBlocks = Array.isArray(options.renderedBlocks)
    ? options.renderedBlocks
    : Object.keys(BLOCK_TEMPLATE_PATTERN_MAP);

  const coveredBlocks = [];
  const uncoveredBlocks = [];

  for (const blockKey of renderedBlocks) {
    if (contractedBlockKeys.has(blockKey)) {
      const contract = compiled.blockContracts[blockKey];
      coveredBlocks.push({
        blockKey,
        patternKey: contract.patternKey,
        primarySlideId: contract.primarySlideId,
        requiredGeometry: contract.requiredGeometry,
        hasSlideLayout: Boolean(contract.slideLayout),
      });
    } else {
      uncoveredBlocks.push({ blockKey });
    }
  }

  const total = renderedBlocks.length;
  const coveragePercent = total > 0 ? Number(((coveredBlocks.length / total) * 100).toFixed(1)) : 0;

  return {
    coveredBlocks,
    uncoveredBlocks,
    coveragePercent,
    totalBlocks: total,
    contractedBlockCount: contractedBlockKeys.size,
    renderedBlockCount: renderedBlocks.length,
    auditedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// checkSparseContent() — Task 5: flag blocks with sparse content
// ---------------------------------------------------------------------------

const SPARSE_CONTENT_THRESHOLD = 60;

/**
 * Check for blocks whose content is too sparse for their template geometry.
 * Flags any block where content length < SPARSE_CONTENT_THRESHOLD (60 chars).
 *
 * @param {object} blockContracts - from compile().blockContracts
 * @param {object} contentMap - { blockKey: contentString | { text: string } }
 * @returns {object} { sparse: [...], adequate: [...], skipped: [...] }
 */
function checkSparseContent(blockContracts, contentMap) {
  if (!blockContracts || typeof blockContracts !== 'object') {
    return { sparse: [], adequate: [], skipped: [], threshold: SPARSE_CONTENT_THRESHOLD };
  }
  if (!contentMap || typeof contentMap !== 'object') {
    return { sparse: [], adequate: [], skipped: [], threshold: SPARSE_CONTENT_THRESHOLD };
  }

  const sparse = [];
  const adequate = [];
  const skipped = [];

  for (const [blockKey, contract] of Object.entries(blockContracts)) {
    const rawContent = contentMap[blockKey];
    if (rawContent === undefined || rawContent === null) {
      skipped.push({ blockKey, reason: 'no_content_provided' });
      continue;
    }

    let text = '';
    if (typeof rawContent === 'string') {
      text = rawContent;
    } else if (typeof rawContent === 'object' && rawContent.text) {
      text = String(rawContent.text);
    } else if (typeof rawContent === 'object') {
      text = JSON.stringify(rawContent);
    }

    const charCount = text.trim().length;
    const entry = {
      blockKey,
      charCount,
      requiredGeometry: contract.requiredGeometry,
      patternKey: contract.patternKey,
      primarySlideId: contract.primarySlideId,
    };

    if (charCount < SPARSE_CONTENT_THRESHOLD) {
      sparse.push({ ...entry, severity: charCount === 0 ? 'empty' : 'sparse' });
    } else {
      adequate.push(entry);
    }
  }

  return { sparse, adequate, skipped, threshold: SPARSE_CONTENT_THRESHOLD };
}

// ---------------------------------------------------------------------------
// generateDriftReport() — Task 7: JSON artifact comparing contracts vs runtime
// ---------------------------------------------------------------------------

/**
 * Generate a comprehensive drift report artifact as a JSON-serializable object.
 * Compares compiled contracts against runtime mappings and produces a report
 * suitable for saving to disk or sending to monitoring.
 *
 * @param {object} [options]
 * @param {string} [options.templatePath]
 * @param {object} [options.templateData]
 * @param {object} [options.runtimeMappings]
 * @returns {object} Drift report artifact
 */
function generateDriftReport(options = {}) {
  let compiled;
  try {
    compiled = compile(options);
  } catch (err) {
    return {
      reportType: 'drift_report',
      generatedAt: new Date().toISOString(),
      error: err.message,
      driftDetected: false,
      issues: [],
    };
  }

  const driftResult = drift(compiled, options.runtimeMappings || null);
  const coverage = auditCoverage(options);

  const blockSummary = {};
  for (const [blockKey, contract] of Object.entries(compiled.blockContracts)) {
    const matchingIssues = driftResult.issues.filter((i) => i.blockKey === blockKey);
    blockSummary[blockKey] = {
      contract: {
        patternKey: contract.patternKey,
        primarySlideId: contract.primarySlideId,
        requiredGeometry: contract.requiredGeometry,
        geometryType: contract.geometryType,
      },
      issueCount: matchingIssues.length,
      issues: matchingIssues,
      status: matchingIssues.length === 0 ? 'clean' : 'drifted',
    };
  }

  return {
    reportType: 'drift_report',
    generatedAt: new Date().toISOString(),
    contractVersion: compiled.version,
    contractSignature: compiled.signature,
    templateSource: compiled.templateSource,
    driftDetected: driftResult.driftDetected,
    summary: {
      totalBlocks: Object.keys(compiled.blockContracts).length,
      totalIssues: driftResult.issueCount,
      errorCount: driftResult.errorCount,
      warningCount: driftResult.warningCount,
      coveragePercent: coverage.coveragePercent,
    },
    blockSummary,
    allIssues: driftResult.issues,
  };
}

// ---------------------------------------------------------------------------
// CLI: --doctor, --compile, --drift, --audit
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const templatePath = args.find((a) => a.startsWith('--template='))?.split('=')[1];

  if (args.includes('--doctor')) {
    const report = doctor({ templatePath });

    console.log('\n=== Template Contract Doctor Report ===\n');
    for (const check of report.checks) {
      const icon =
        check.status === 'pass'
          ? '[PASS]'
          : check.status === 'fail'
            ? '[FAIL]'
            : check.status === 'warning'
              ? '[WARN]'
              : '[INFO]';
      console.log(`  ${icon} ${check.name}: ${check.message}`);
    }
    console.log(`\nOverall: ${report.status.toUpperCase()}`);
    console.log(
      `  ${report.summary.pass} pass, ${report.summary.warning} warnings, ${report.summary.fail} failures`
    );
    console.log(
      `  Contract v${report.summary.contractVersion} | Signature: ${report.summary.signature?.substring(0, 24)}...`
    );
    console.log(`  ${report.summary.patternCount} patterns, ${report.summary.blockCount} blocks\n`);

    process.exit(report.status === 'fail' ? 1 : 0);
  } else if (args.includes('--compile')) {
    const compiled = compile({ templatePath });
    console.log(JSON.stringify(compiled, null, 2));
  } else if (args.includes('--drift')) {
    const compiled = compile({ templatePath });
    const driftReport = drift(compiled);
    console.log(JSON.stringify(driftReport, null, 2));
  } else if (args.includes('--audit')) {
    // Task 11: CLI audit command — prints all mismatches
    const compiled = compile({ templatePath });
    const coverage = auditCoverage({ templatePath });
    const driftReport = drift(compiled);

    console.log('\n=== Template Contract Audit ===\n');

    // Coverage
    console.log(
      `Coverage: ${coverage.coveragePercent}% (${coverage.coveredBlocks.length}/${coverage.totalBlocks} blocks)`
    );
    if (coverage.uncoveredBlocks.length > 0) {
      console.log(`\nUncovered blocks:`);
      for (const b of coverage.uncoveredBlocks) {
        console.log(`  - ${b.blockKey}`);
      }
    }

    // Drift mismatches
    if (driftReport.driftDetected) {
      console.log(
        `\nDrift issues (${driftReport.issueCount} total, ${driftReport.errorCount} errors, ${driftReport.warningCount} warnings):`
      );
      for (const issue of driftReport.issues) {
        const severity = issue.severity === 'error' ? '[ERROR]' : '[WARN]';
        console.log(`  ${severity} ${issue.blockKey}: ${issue.message}`);
      }
    } else {
      console.log('\nNo drift detected.');
    }

    // Block contract details
    console.log(`\nBlock contracts (${Object.keys(compiled.blockContracts).length}):`);
    const sortedBlocks = Object.entries(compiled.blockContracts).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [blockKey, contract] of sortedBlocks) {
      const geo = contract.requiredGeometry || 'null';
      const slide = contract.primarySlideId || 'null';
      console.log(`  ${blockKey}: pattern=${contract.patternKey} slide=${slide} geometry=${geo}`);
    }

    console.log('');
    process.exit(driftReport.errorCount > 0 ? 1 : 0);
  } else {
    console.log('Usage:');
    console.log('  node template-contract-compiler.js --doctor   Full diagnostic report');
    console.log(
      '  node template-contract-compiler.js --compile  Output compiled contracts as JSON'
    );
    console.log('  node template-contract-compiler.js --drift    Run drift detection');
    console.log(
      '  node template-contract-compiler.js --audit    Print all mismatches and coverage'
    );
    console.log('  Options: --template=<path>  Custom template-patterns.json path');
  }
}

module.exports = {
  compile,
  drift,
  doctor,
  auditCoverage,
  checkSparseContent,
  generateDriftReport,
  // Exposed for testing
  CONTRACT_VERSION,
  BLOCK_TEMPLATE_PATTERN_MAP,
  BLOCK_TEMPLATE_SLIDE_MAP,
  TABLE_TEMPLATE_CONTEXTS,
  CHART_TEMPLATE_CONTEXTS,
  SECTION_DIVIDER_TEMPLATE_SLIDES,
  DATA_TYPE_PATTERN_MAP,
  SPARSE_CONTENT_THRESHOLD,
};
