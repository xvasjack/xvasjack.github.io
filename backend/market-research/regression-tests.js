#!/usr/bin/env node
/**
 * Regression test suite for deck generation hardening.
 *
 * Focus:
 * 1) Root-cause unit checks for template-clone token filtering.
 * 2) End-to-end generation + validation for Vietnam/Thailand outputs.
 * 3) Country-leak checks on TOC/cover text.
 * 4) "No repair needed" package normalization checks.
 *
 * Run:
 *   node regression-tests.js
 *   node regression-tests.js --rounds=2
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  readPPTX,
  extractSlideText,
  extractAllText,
  normalizeAbsoluteRelationshipTargets,
  normalizeSlideNonVisualIds,
  reconcileContentTypesAndPackage,
} = require('./pptx-validator');
const { getExpectations, runValidation } = require('./validate-output');
const { __test: cloneTest } = require('./template-clone-postprocess');
const { validatePptData } = require('./quality-gates');
const { __test: serverTest } = require('./server');
const { __test: orchestratorTest } = require('./research-orchestrator');
const { __test: singlePptTest } = require('./ppt-single-country');
const { resolveTemplatePattern, getTemplateSlideLayout } = require('./ppt-utils');

const ROOT = __dirname;
const VIETNAM_SCRIPT = path.join(ROOT, 'test-vietnam-research.js');
const THAILAND_SCRIPT = path.join(ROOT, 'test-ppt-generation.js');
const VIETNAM_PPT = path.join(ROOT, 'vietnam-output.pptx');
const THAILAND_PPT = path.join(ROOT, 'test-output.pptx');

const TABLE_ROUTE_KEYS = Object.freeze([
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

const CHART_ROUTE_KEYS = Object.freeze([
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

function parseRounds(argv) {
  const match = argv.find((arg) => arg.startsWith('--rounds='));
  const value = Number.parseInt((match || '').split('=')[1] || '2', 10);
  if (!Number.isFinite(value) || value <= 0) return 2;
  return Math.min(value, 5);
}

function runNodeScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => {
      const chunk = String(buf || '');
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (buf) => {
      const chunk = String(buf || '');
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Script failed (${path.basename(scriptPath)}): exit=${code}\n${stderr || stdout}`
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function assertRegex(text, re, message) {
  if (!re.test(text)) {
    throw new Error(message);
  }
}

function assertNotRegex(text, re, message) {
  if (re.test(text)) {
    throw new Error(message);
  }
}

async function ensureCountryIntegrity({ pptxPath, country, wrongCountry }) {
  const { zip } = await readPPTX(pptxPath);
  const textData = await extractAllText(zip);
  const slideCount = Number(textData.slideCount || 0);
  if (slideCount <= 0) throw new Error(`No slides found in ${pptxPath}`);

  const cover = await extractSlideText(zip, 1);
  const coverText = String(cover.fullText || '').replace(/\s+/g, ' ');
  assertRegex(
    coverText,
    new RegExp(`\\b${country}\\b`, 'i'),
    `Cover slide missing country "${country}" in ${path.basename(pptxPath)}`
  );
  assertNotRegex(
    coverText,
    new RegExp(`\\b${wrongCountry}\\b`, 'i'),
    `Cover slide leaked wrong country "${wrongCountry}" in ${path.basename(pptxPath)}`
  );

  const tocSlides = [];
  let tocSlidesWithCountry = 0;
  for (let i = 1; i <= slideCount; i++) {
    const slide = await extractSlideText(zip, i);
    const text = String(slide.fullText || '').replace(/\s+/g, ' ');
    if (!/table of contents/i.test(text)) continue;
    tocSlides.push(i);
    if (new RegExp(`\\b${country}\\b`, 'i').test(text)) tocSlidesWithCountry++;
    assertNotRegex(
      text,
      new RegExp(`\\b${wrongCountry}\\b`, 'i'),
      `TOC slide ${i} leaked wrong country "${wrongCountry}" in ${path.basename(pptxPath)}`
    );
  }
  if (tocSlides.length === 0) {
    throw new Error(`No TOC slide found in ${path.basename(pptxPath)}`);
  }
  if (tocSlidesWithCountry === 0) {
    throw new Error(
      `No TOC slide contains expected country "${country}" in ${path.basename(pptxPath)}`
    );
  }
}

async function ensureNoRepairNeeded(pptxPath) {
  const buffer = fs.readFileSync(pptxPath);
  const absRel = await normalizeAbsoluteRelationshipTargets(buffer);
  if (absRel.changed) {
    throw new Error(
      `${path.basename(pptxPath)} still needs relationship-target normalization (${absRel.stats?.normalizedTargets || 0})`
    );
  }

  const idNorm = await normalizeSlideNonVisualIds(buffer);
  if (idNorm.changed) {
    throw new Error(
      `${path.basename(pptxPath)} still needs non-visual shape ID normalization (${idNorm.stats?.reassignedIds || 0})`
    );
  }

  const ctRecon = await reconcileContentTypesAndPackage(buffer);
  if (ctRecon.changed) {
    const touched = [
      ...(ctRecon.stats?.addedDefaults || []),
      ...(ctRecon.stats?.correctedDefaults || []),
      ...(ctRecon.stats?.addedOverrides || []),
      ...(ctRecon.stats?.correctedOverrides || []),
      ...(ctRecon.stats?.removedDangling || []),
    ].length;
    throw new Error(
      `${path.basename(pptxPath)} still needs content-type reconciliation (${touched} adjustment(s))`
    );
  }
}

async function ensureSparseSlideDiscipline(pptxPath) {
  const { zip } = await readPPTX(pptxPath);
  const textData = await extractAllText(zip);
  const allowedSparse = new Set([
    'policy & regulatory',
    'market overview',
    'competitive landscape',
    'strategic analysis',
    'recommendations',
    'appendix',
  ]);
  const threshold = 60;
  const violations = [];
  for (const slide of textData.slides || []) {
    const charCount = Number(slide.charCount || 0);
    if (charCount >= threshold) continue;
    const normalized = String(slide.fullText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!normalized) {
      violations.push(`slide ${slide.slideNum} empty text`);
      continue;
    }
    if (normalized.startsWith('table of contents')) continue;
    if (normalized.startsWith('appendix')) continue;
    if (allowedSparse.has(normalized)) continue;
    violations.push(`slide ${slide.slideNum} (${charCount} chars): "${normalized.slice(0, 80)}"`);
  }
  if (violations.length > 0) {
    throw new Error(
      `${path.basename(pptxPath)} sparse-slide discipline failed: ${violations.slice(0, 8).join(' | ')}`
    );
  }
}

function runTemplateCloneUnitChecks() {
  assert.strictEqual(cloneTest.isLockedTemplateText('Table of Contents'), true);
  assert.strictEqual(cloneTest.isLockedTemplateText('Source: YCP Analysis'), false);
  assert.strictEqual(cloneTest.shouldSkipGeneratedToken('Table of Contents'), true);
  assert.strictEqual(cloneTest.shouldSkipGeneratedToken('Source: YCP Analysis'), false);
  assert.strictEqual(cloneTest.shouldSkipGeneratedToken('Thailand | Recommendations'), false);

  const sourceTokenXml = '<p:sld><a:t>Source: YCP Analysis</a:t><a:t>Thailand</a:t></p:sld>';
  const extracted = cloneTest.extractTextTokens(sourceTokenXml);
  assert(
    extracted.some((t) => /source:\s*ycp analysis/i.test(t)),
    'Generated source token should remain available for clone replacement'
  );
  assert(
    extracted.some((t) => /\bthailand\b/i.test(t)),
    'Generated country token should remain available for clone replacement'
  );
}

function runPptGateUnitChecks() {
  const longText = 'A'.repeat(1800);
  const analysis = {
    country: 'Vietnam',
    policy: { regulatorySummary: longText },
    market: {
      marketSizeAndGrowth: {
        overview: longText,
        chartData: {
          series: [
            { name: '2024', value: 10 },
            { name: '2025', value: 12 },
          ],
        },
      },
    },
    competitors: { localMajor: { overview: 'Strong local coverage and execution capability.' } },
    depth: { entryStrategy: { overview: 'Phased JV entry with local EPC integration.' } },
    insights: { whyNow: { overview: 'Regulatory and demand timing window remains open.' } },
    summary: { recommendations: { overview: 'Go with staged investment and risk controls.' } },
  };

  const blocks = serverTest.buildPptGateBlocks(analysis);
  assert(blocks.length >= 5, 'Expected section gate blocks to be created');
  for (const block of blocks) {
    if (typeof block?.content === 'string') {
      assert(
        block.content.length <= 560,
        `Gate block content should be bounded (got ${block.content.length})`
      );
    }
  }

  const marketBlock = blocks.find((b) => b?.key === 'market');
  assert(marketBlock, 'Expected market gate block');
  assert.strictEqual(
    marketBlock.chartData,
    null,
    'Underfilled section-level chart preview should not hard-fail pre-render gate'
  );

  const gate = validatePptData(blocks);
  assert.strictEqual(
    gate.pass,
    true,
    `Expected pre-render PPT gate pass; got ${JSON.stringify(gate)}`
  );
}

function runCompetitiveGateUnitChecks() {
  assert(
    singlePptTest && typeof singlePptTest.shouldAllowCompetitiveOptionalGroupGap === 'function',
    'ppt-single-country __test helper missing: shouldAllowCompetitiveOptionalGroupGap'
  );

  const coreContent =
    'Strong execution footprint with quantified contracts, recurring revenues, and industrial customer concentration across multiple regions.';
  const blocks = [
    { key: 'localMajor', type: 'section', title: 'localMajor', content: coreContent },
    { key: 'foreignPlayers', type: 'section', title: 'foreignPlayers', content: coreContent },
    {
      key: 'japanesePlayers',
      type: 'section',
      title: 'japanesePlayers',
      content: 'Data unavailable',
    },
    { key: 'maActivity', type: 'section', title: 'maActivity', content: 'Data unavailable' },
  ];

  const gate = validatePptData(blocks);
  assert.strictEqual(
    gate.pass,
    false,
    `Expected generic gate to flag optional-gap competitor blocks before section-aware override; got ${JSON.stringify(gate)}`
  );
  const allowOverride = singlePptTest.shouldAllowCompetitiveOptionalGroupGap(
    'Competitive Landscape',
    gate,
    blocks
  );
  assert.strictEqual(
    allowOverride,
    true,
    'Expected section-aware competitor gate override when only optional groups are missing'
  );

  const blocksMissingCore = blocks.filter((b) => b.key !== 'foreignPlayers');
  const gateMissingCore = validatePptData(blocksMissingCore);
  const denyOverride = singlePptTest.shouldAllowCompetitiveOptionalGroupGap(
    'Competitive Landscape',
    gateMissingCore,
    blocksMissingCore
  );
  assert.strictEqual(
    denyOverride,
    false,
    'Override must not apply when core competitor groups are missing'
  );
}

function runTemplateRouteRecoveryUnitChecks() {
  assert(
    singlePptTest && typeof singlePptTest.resolveTemplateRouteWithGeometryGuard === 'function',
    'ppt-single-country __test helper missing: resolveTemplateRouteWithGeometryGuard'
  );

  // 1) Default route sanity: every block's selected template slide must carry required geometry.
  for (const blockKey of TABLE_ROUTE_KEYS) {
    const resolved = resolveTemplatePattern({ blockKey });
    const layout = getTemplateSlideLayout(resolved.selectedSlide);
    assert(
      Boolean(layout && layout.table),
      `Default template route for table block "${blockKey}" lacks table geometry (slide=${resolved.selectedSlide}, pattern=${resolved.patternKey})`
    );
  }
  for (const blockKey of CHART_ROUTE_KEYS) {
    const resolved = resolveTemplatePattern({ blockKey });
    const layout = getTemplateSlideLayout(resolved.selectedSlide);
    assert(
      Array.isArray(layout?.charts) && layout.charts.length > 0,
      `Default template route for chart block "${blockKey}" lacks chart geometry (slide=${resolved.selectedSlide}, pattern=${resolved.patternKey})`
    );
  }

  // 2) Override recovery sanity: force incompatible override and verify route recovers.
  for (const blockKey of TABLE_ROUTE_KEYS) {
    const route = singlePptTest.resolveTemplateRouteWithGeometryGuard({
      blockKey,
      dataType: blockKey === 'dealEconomics' ? 'financial_performance' : 'section_summary',
      data:
        blockKey === 'dealEconomics'
          ? { typicalDealSize: { average: '$1.2M' } }
          : { overview: 'table route recovery check' },
      templateSelection: 26, // chart-only slide override (incompatible for table blocks)
      tableContextKeys: TABLE_ROUTE_KEYS,
      chartContextKeys: CHART_ROUTE_KEYS,
    });
    assert.strictEqual(
      route.recovered,
      true,
      `Table block "${blockKey}" should recover from chart-only override`
    );
    assert(
      Boolean(route.layout && route.layout.table),
      `Recovered table route for "${blockKey}" must include table geometry (selected=${route.resolved?.selectedSlide})`
    );
    assert.notStrictEqual(
      Number(route.resolved?.selectedSlide),
      26,
      `Recovered table route for "${blockKey}" must not stay on chart slide 26`
    );
  }

  for (const blockKey of CHART_ROUTE_KEYS) {
    const route = singlePptTest.resolveTemplateRouteWithGeometryGuard({
      blockKey,
      dataType: 'time_series_multi_insight',
      data: {
        chartData: {
          series: [
            { name: '2024', value: 10 },
            { name: '2025', value: 12 },
          ],
        },
      },
      templateSelection: 12, // table-only slide override (incompatible for chart blocks)
      tableContextKeys: TABLE_ROUTE_KEYS,
      chartContextKeys: CHART_ROUTE_KEYS,
    });
    assert.strictEqual(
      route.recovered,
      true,
      `Chart block "${blockKey}" should recover from table-only override`
    );
    assert(
      Array.isArray(route.layout?.charts) && route.layout.charts.length > 0,
      `Recovered chart route for "${blockKey}" must include chart geometry (selected=${route.resolved?.selectedSlide})`
    );
    assert.notStrictEqual(
      Number(route.resolved?.selectedSlide),
      12,
      `Recovered chart route for "${blockKey}" must not stay on table slide 12`
    );
  }
}

function runCrossPatternGeometryRecoveryChecks() {
  assert(
    singlePptTest && typeof singlePptTest.resolveTemplateRouteWithGeometryGuard === 'function',
    'ppt-single-country __test helper missing: resolveTemplateRouteWithGeometryGuard'
  );

  const tableFallbackRoute = singlePptTest.resolveTemplateRouteWithGeometryGuard({
    blockKey: 'syntheticTableGeometryBlock',
    dataType: 'financial_performance',
    data: { overview: 'Synthetic table fallback probe' },
    templateSelection: { pattern: 'dual_chart_financial' }, // chart-only pattern (26/29)
    tableContextKeys: ['syntheticTableGeometryBlock'],
    chartContextKeys: [],
  });
  assert.strictEqual(
    tableFallbackRoute.recovered,
    true,
    'Cross-pattern fallback should recover synthetic table block from chart-only pattern'
  );
  assert.strictEqual(
    tableFallbackRoute.resolved?.source,
    'crossPatternGeometryRecovery',
    'Table cross-pattern fallback source should be crossPatternGeometryRecovery'
  );
  assert.strictEqual(
    tableFallbackRoute.reason,
    'cross-pattern-fallback',
    'Table cross-pattern fallback should record reason'
  );
  assert(
    Boolean(tableFallbackRoute.layout && tableFallbackRoute.layout.table),
    `Cross-pattern table fallback must land on table geometry (selected=${tableFallbackRoute.resolved?.selectedSlide})`
  );

  const chartFallbackRoute = singlePptTest.resolveTemplateRouteWithGeometryGuard({
    blockKey: 'syntheticChartGeometryBlock',
    dataType: 'company_comparison',
    data: { players: [{ name: 'A' }] },
    templateSelection: { pattern: 'company_comparison' }, // table-only pattern (22)
    tableContextKeys: [],
    chartContextKeys: ['syntheticChartGeometryBlock'],
  });
  assert.strictEqual(
    chartFallbackRoute.recovered,
    true,
    'Cross-pattern fallback should recover synthetic chart block from table-only pattern'
  );
  assert.strictEqual(
    chartFallbackRoute.resolved?.source,
    'crossPatternGeometryRecovery',
    'Chart cross-pattern fallback source should be crossPatternGeometryRecovery'
  );
  assert.strictEqual(
    chartFallbackRoute.reason,
    'cross-pattern-fallback',
    'Chart cross-pattern fallback should record reason'
  );
  assert(
    Array.isArray(chartFallbackRoute.layout?.charts) && chartFallbackRoute.layout.charts.length > 0,
    `Cross-pattern chart fallback must land on chart geometry (selected=${chartFallbackRoute.resolved?.selectedSlide})`
  );
}

async function runDynamicTimeoutUnitChecks() {
  assert(
    orchestratorTest && typeof orchestratorTest.runInBatchesUntilDeadline === 'function',
    'research-orchestrator __test helper missing: runInBatchesUntilDeadline'
  );
  assert(
    orchestratorTest && typeof orchestratorTest.computeDynamicResearchTimeoutMs === 'function',
    'research-orchestrator __test helper missing: computeDynamicResearchTimeoutMs'
  );

  const fullOutcome = await orchestratorTest.runInBatchesUntilDeadline(
    [1, 2, 3],
    1,
    async (item) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return item;
    },
    { deadlineMs: null, delayMs: 0 }
  );
  assert.strictEqual(fullOutcome.timedOut, false, 'No-deadline batch runner should not timeout');
  assert.strictEqual(
    fullOutcome.results.length,
    3,
    `Expected all items without timeout; got ${fullOutcome.results.length}`
  );

  const timeoutOutcome = await orchestratorTest.runInBatchesUntilDeadline(
    [1, 2, 3, 4],
    1,
    async (item) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return item;
    },
    { deadlineMs: Date.now() + 180, delayMs: 0 }
  );
  assert.strictEqual(timeoutOutcome.timedOut, true, 'Expected timeout under tight deadline');
  assert(
    timeoutOutcome.results.length >= 1 && timeoutOutcome.results.length < 4,
    `Timeout path should retain partial completed batches; got ${timeoutOutcome.results.length}`
  );

  const tinyTimeout = orchestratorTest.computeDynamicResearchTimeoutMs(1);
  const largerTimeout = orchestratorTest.computeDynamicResearchTimeoutMs(25);
  assert(
    largerTimeout >= tinyTimeout,
    `Timeout should be non-decreasing with topic count (${tinyTimeout} -> ${largerTimeout})`
  );
}

function runPreRenderStructureUnitChecks() {
  const base = {
    country: 'Vietnam',
    policy: {
      foundationalActs: { overview: 'ok' },
      nationalPolicy: { overview: 'ok' },
      investmentRestrictions: { overview: 'ok' },
      regulatorySummary: { overview: 'ok' },
      keyIncentives: { overview: 'ok' },
      sources: [],
    },
    market: {
      marketSizeAndGrowth: { overview: 'ok' },
      supplyAndDemandDynamics: { overview: 'ok' },
      pricingAndTariffStructures: { overview: 'ok' },
    },
    competitors: {
      localMajor: { players: [{ name: 'A' }] },
      foreignPlayers: { players: [{ name: 'B' }] },
      // intentionally missing japanesePlayers
      caseStudy: { company: 'X' },
    },
    depth: {
      dealEconomics: { overview: 'ok' },
      partnerAssessment: { overview: 'ok' },
      entryStrategy: { overview: 'ok' },
      implementation: { overview: 'ok' },
      targetSegments: { overview: 'ok' },
    },
    summary: {
      timingIntelligence: { overview: 'ok' },
      lessonsLearned: { overview: 'ok' },
      keyInsights: [],
      recommendation: 'ok',
      goNoGo: { overallVerdict: 'GO' },
      opportunities: [],
      obstacles: [],
      ratings: {},
    },
  };

  const issuesNoJapan = serverTest.collectPreRenderStructureIssues([base]);
  assert.strictEqual(
    issuesNoJapan.length,
    0,
    `Missing japanesePlayers should not hard-fail pre-render structure gate: ${issuesNoJapan.join(' | ')}`
  );

  const withFinalReviewMeta = {
    ...base,
    finalReview: {
      overallGrade: 'A',
      coherenceScore: 90,
      issues: [],
    },
  };
  const issuesWithFinalReviewMeta = serverTest.collectPreRenderStructureIssues([
    withFinalReviewMeta,
  ]);
  assert.strictEqual(
    issuesWithFinalReviewMeta.length,
    0,
    `Stable finalReview metadata should not hard-fail pre-render structure gate: ${issuesWithFinalReviewMeta.join(' | ')}`
  );

  const withTransientFinalReviewGap = {
    ...base,
    finalReviewGap1: { section: 'market', issue: 'transient' },
  };
  const issuesWithTransientFinalReviewGap = serverTest.collectPreRenderStructureIssues([
    withTransientFinalReviewGap,
  ]);
  assert(
    issuesWithTransientFinalReviewGap.some((x) =>
      /transient top-level key "finalReviewGap1" is not allowed/i.test(x)
    ),
    `Transient finalReviewGap top-level key should still fail gate; got: ${issuesWithTransientFinalReviewGap.join(' | ')}`
  );

  const missingCore = {
    ...base,
    competitors: {
      foreignPlayers: { players: [{ name: 'B' }] },
    },
  };
  const issuesMissingCore = serverTest.collectPreRenderStructureIssues([missingCore]);
  assert(
    issuesMissingCore.some((x) => /competitors missing required sections: localMajor/i.test(x)),
    `Missing localMajor should still fail pre-render structure gate; got: ${issuesMissingCore.join(' | ')}`
  );
}

function runRenderTransientKeyUnitChecks() {
  assert(
    singlePptTest && typeof singlePptTest.isTransientRenderKey === 'function',
    'ppt-single-country __test helper missing: isTransientRenderKey'
  );
  assert(
    singlePptTest && typeof singlePptTest.sanitizeRenderPayload === 'function',
    'ppt-single-country __test helper missing: sanitizeRenderPayload'
  );

  const mustBlock = [
    'section_0',
    'section_1',
    'section-2',
    'gap_1',
    'gap-2',
    'verify_1',
    'finalReviewGap1',
    'final_review_gap_3',
    'deepen_market',
    'marketDeepenFinalReviewGap1',
    'marketDeepen_2',
    'market_deepen_3',
    'competitorsDeepen1',
    'competitors_deepen_2',
    'policyDeepen1',
    'contextDeepen_1',
    'depthDeepen2',
    'insightsDeepen3',
    'insights_deepen_4',
    '_wasArray',
    'market_wasArray',
    '_synthesisError',
    '_internalMeta',
  ];
  for (const key of mustBlock) {
    assert.strictEqual(
      singlePptTest.isTransientRenderKey(key),
      true,
      `isTransientRenderKey should block "${key}"`
    );
  }

  const mustAllow = [
    'marketSizeAndGrowth',
    'supplyAndDemandDynamics',
    'pricingAndTariffStructures',
    'localMajor',
    'foreignPlayers',
    'dealEconomics',
    'overview',
    'sources',
    'chartData',
    'players',
  ];
  for (const key of mustAllow) {
    assert.strictEqual(
      singlePptTest.isTransientRenderKey(key),
      false,
      `isTransientRenderKey should allow "${key}"`
    );
  }

  const dirtyPayload = {
    marketSizeAndGrowth: { overview: 'Valid content' },
    marketDeepenFinalReviewGap1: { overview: 'Should be dropped' },
    section_0: { overview: 'Should be dropped' },
    _wasArray: true,
    supplyAndDemandDynamics: {
      overview: 'Valid nested',
      deepen_extra: { detail: 'Transient nested key' },
      chartData: { series: [1, 2, 3] },
    },
  };
  const cleanedPayload = singlePptTest.sanitizeRenderPayload(dirtyPayload);
  assert(
    cleanedPayload.marketSizeAndGrowth &&
      cleanedPayload.marketSizeAndGrowth.overview === 'Valid content',
    'sanitizeRenderPayload must preserve canonical keys'
  );
  assert(
    !Object.prototype.hasOwnProperty.call(cleanedPayload, 'marketDeepenFinalReviewGap1'),
    'sanitizeRenderPayload must drop marketDeepenFinalReviewGap1'
  );
  assert(
    !Object.prototype.hasOwnProperty.call(cleanedPayload, 'section_0'),
    'sanitizeRenderPayload must drop section_0'
  );
  assert(
    !Object.prototype.hasOwnProperty.call(cleanedPayload, '_wasArray'),
    'sanitizeRenderPayload must drop _wasArray'
  );
  assert(
    cleanedPayload.supplyAndDemandDynamics &&
      cleanedPayload.supplyAndDemandDynamics.overview === 'Valid nested',
    'sanitizeRenderPayload must preserve valid nested content'
  );
  assert(
    !Object.prototype.hasOwnProperty.call(
      cleanedPayload.supplyAndDemandDynamics || {},
      'deepen_extra'
    ),
    'sanitizeRenderPayload must drop transient keys in nested objects'
  );
  assert(
    cleanedPayload.supplyAndDemandDynamics &&
      Array.isArray(cleanedPayload.supplyAndDemandDynamics.chartData?.series),
    'sanitizeRenderPayload must preserve non-transient nested data'
  );
}

async function validateDeck(pptxPath, country, industry) {
  const result = await runValidation(pptxPath, getExpectations(country, industry));
  if (!result.valid) {
    const preview = (result.results?.failed || [])
      .slice(0, 8)
      .map((f) => `${f.check}: expected ${f.expected}, got ${f.actual}`)
      .join(' | ');
    throw new Error(
      `Validation failed for ${path.basename(pptxPath)} (${country}): ${preview || 'unknown'}`
    );
  }
  console.log(
    `[Regression] Validation PASS (${country}) slides=${result.report?.slides?.count || 0} visual=${result.visual?.score || 0}`
  );
}

function runOversizedTextUnitChecks() {
  assert(
    singlePptTest && typeof singlePptTest.safeCell === 'function',
    'ppt-single-country __test helper missing: safeCell'
  );

  // 8k, 12k, 20k char strings — must not throw, must return bounded string
  for (const len of [8000, 12000, 20000]) {
    const oversized = 'A'.repeat(len);
    let result;
    assert.doesNotThrow(() => {
      result = singlePptTest.safeCell(oversized);
    }, `safeCell must not throw on ${len}-char input`);
    assert(typeof result === 'string', `safeCell(${len}) must return a string`);
    assert(
      result.length <= 3010,
      `safeCell(${len}) must truncate to ≤3010 chars (3000 + ellipsis), got ${result.length}`
    );
    assert(result.length > 0, `safeCell(${len}) must not return empty string`);
  }

  // Normal-length input should pass through unchanged
  const normal = 'Hello world, this is a test cell value.';
  assert.strictEqual(
    singlePptTest.safeCell(normal),
    normal,
    'Normal text should pass through unchanged'
  );

  // Empty/null should return empty
  assert.strictEqual(singlePptTest.safeCell(''), '', 'Empty string should return empty');
  assert.strictEqual(singlePptTest.safeCell(null), '', 'null should return empty');
  assert.strictEqual(singlePptTest.safeCell(undefined), '', 'undefined should return empty');
}

function runTableOverflowRecoveryUnitChecks() {
  assert(
    singlePptTest && typeof singlePptTest.computeTableFitScore === 'function',
    'ppt-single-country __test helper missing: computeTableFitScore'
  );

  // Build synthetic oversized table: 25 rows x 12 columns, 500+ char cells
  const longCell = 'A'.repeat(550);
  const headerRow = Array.from({ length: 12 }, (_, i) => `Column ${i + 1}`);
  const bodyRow = Array.from({ length: 12 }, () => longCell);
  const oversizedRows = [headerRow, ...Array.from({ length: 24 }, () => [...bodyRow])];

  // Verify computeTableFitScore returns low score for oversized table
  const fitResult = singlePptTest.computeTableFitScore(oversizedRows, { w: 8.5, h: 3.5 });
  assert(
    fitResult.score < 70,
    `Expected fit score < 70 for oversized table; got ${fitResult.score}`
  );
  assert(
    fitResult.recommendation !== 'standard',
    `Expected non-standard recommendation for oversized table; got ${fitResult.recommendation}`
  );

  // Verify score breakdown penalizes oversized dimensions
  assert(
    fitResult.breakdown.rowScore <= 10,
    `rowScore should be very low for 25 rows (exceeds maxRows=16); got ${fitResult.breakdown.rowScore}`
  );
  assert(
    fitResult.breakdown.colScore <= 60,
    `colScore should be penalized for 12 cols (exceeds maxCols=9); got ${fitResult.breakdown.colScore}`
  );
  assert(
    fitResult.breakdown.densityScore < 100,
    `densityScore should penalize 550-char cells; got ${fitResult.breakdown.densityScore}`
  );

  // Verify normal table gets high score
  const normalRows = [
    ['Header A', 'Header B', 'Header C'],
    ['Data 1', 'Data 2', 'Data 3'],
    ['Data 4', 'Data 5', 'Data 6'],
  ];
  const normalFit = singlePptTest.computeTableFitScore(normalRows, { w: 8.5, h: 3.5 });
  assert(
    normalFit.score >= 90,
    `Expected fit score >= 90 for normal table; got ${normalFit.score}`
  );
  assert.strictEqual(
    normalFit.recommendation,
    'standard',
    `Expected 'standard' recommendation for normal table; got ${normalFit.recommendation}`
  );

  // Verify empty table gets perfect score
  const emptyFit = singlePptTest.computeTableFitScore([], { w: 8.5, h: 3.5 });
  assert.strictEqual(
    emptyFit.score,
    100,
    `Expected score 100 for empty table; got ${emptyFit.score}`
  );
}

async function runRound(round, total) {
  console.log(`\n[Regression] Round ${round}/${total}`);

  runTemplateCloneUnitChecks();
  console.log('[Regression] Unit checks PASS (template-clone filter behavior)');
  runPptGateUnitChecks();
  console.log('[Regression] Unit checks PASS (pre-render PPT gate block shaping)');
  runCompetitiveGateUnitChecks();
  console.log('[Regression] Unit checks PASS (competitive optional-group gate override)');
  runTemplateRouteRecoveryUnitChecks();
  console.log('[Regression] Unit checks PASS (template route geometry recovery)');
  runCrossPatternGeometryRecoveryChecks();
  console.log('[Regression] Unit checks PASS (cross-pattern geometry fallback recovery)');
  await runDynamicTimeoutUnitChecks();
  console.log('[Regression] Unit checks PASS (dynamic timeout partial-result handling)');
  runPreRenderStructureUnitChecks();
  console.log('[Regression] Unit checks PASS (pre-render structure gating)');
  runRenderTransientKeyUnitChecks();
  console.log('[Regression] Unit checks PASS (render-layer transient key filtering)');
  runOversizedTextUnitChecks();
  console.log('[Regression] Unit checks PASS (oversized text graceful degradation)');
  runTableOverflowRecoveryUnitChecks();
  console.log('[Regression] Unit checks PASS (table overflow recovery + fit score)');

  await runNodeScript(VIETNAM_SCRIPT);
  await runNodeScript(THAILAND_SCRIPT);

  if (!fs.existsSync(VIETNAM_PPT)) throw new Error(`Missing generated file: ${VIETNAM_PPT}`);
  if (!fs.existsSync(THAILAND_PPT)) throw new Error(`Missing generated file: ${THAILAND_PPT}`);

  await validateDeck(VIETNAM_PPT, 'Vietnam', 'Energy Services');
  await validateDeck(THAILAND_PPT, 'Thailand', 'Energy Services');

  await ensureCountryIntegrity({
    pptxPath: VIETNAM_PPT,
    country: 'Vietnam',
    wrongCountry: 'Thailand',
  });
  await ensureCountryIntegrity({
    pptxPath: THAILAND_PPT,
    country: 'Thailand',
    wrongCountry: 'Vietnam',
  });
  console.log('[Regression] Country integrity PASS (cover + TOC country checks)');

  await ensureSparseSlideDiscipline(VIETNAM_PPT);
  await ensureSparseSlideDiscipline(THAILAND_PPT);
  console.log('[Regression] Sparse-slide discipline PASS (non-divider sparse slides blocked)');

  await ensureNoRepairNeeded(VIETNAM_PPT);
  await ensureNoRepairNeeded(THAILAND_PPT);
  console.log('[Regression] Package normalization PASS (no repair transforms needed)');
}

async function main() {
  const rounds = parseRounds(process.argv.slice(2));
  for (let i = 1; i <= rounds; i++) {
    await runRound(i, rounds);
  }
  console.log(`\n[Regression] PASS (${rounds} round(s))`);
}

main().catch((err) => {
  console.error(`\n[Regression] FAIL: ${err.message}`);
  process.exit(1);
});
