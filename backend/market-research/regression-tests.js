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
  classifySlideIntent,
} = require('./pptx-validator');
const { getExpectations, runValidation } = require('./validate-output');
const { __test: cloneTest } = require('./template-clone-postprocess');
const { validatePptData } = require('./quality-gates');
const { __test: serverTest } = require('./server');
const { __test: orchestratorTest } = require('./research-orchestrator');
const { __test: singlePptTest } = require('./ppt-single-country');
const {
  isTransientKey,
  sanitizeTransientKeys,
  createSanitizationContext,
} = require('./transient-key-sanitizer');
const { runStressTest } = require('./stress-test-harness');
const {
  runStressLab,
  checkDeterminism,
  DEFAULT_SEEDS,
  DEEP_SEEDS,
  __test: stressLabTest,
} = require('./stress-lab');
const { clusterWithSummary, __test: clusterTest } = require('./failure-cluster-analyzer');

const ROOT = __dirname;
const VIETNAM_SCRIPT = path.join(ROOT, 'test-vietnam-research.js');
const THAILAND_SCRIPT = path.join(ROOT, 'test-ppt-generation.js');
const VIETNAM_PPT = path.join(ROOT, 'vietnam-output.pptx');
const THAILAND_PPT = path.join(ROOT, 'test-output.pptx');
const ROUND_ARTIFACT_PATHS = [VIETNAM_PPT, THAILAND_PPT];

// NEW DEFAULT: Fresh generated artifacts persist after each round.
// Set RESTORE_OLD_ARTIFACTS=1 to revert to legacy behavior (snapshot + restore) for debugging.
// PRESERVE_GENERATED_PPTS is kept as a legacy alias for backward compat (both disable restore).
const RESTORE_OLD_ARTIFACTS = /^(1|true|yes|on)$/i.test(
  String(process.env.RESTORE_OLD_ARTIFACTS || '').trim()
);
const PRESERVE_GENERATED_PPTS = /^(1|true|yes|on)$/i.test(
  String(process.env.PRESERVE_GENERATED_PPTS || '').trim()
);
// Artifacts persist by default. Only restore if explicitly opted in AND legacy preserve is NOT set.
const SHOULD_RESTORE_ARTIFACTS = RESTORE_OLD_ARTIFACTS && !PRESERVE_GENERATED_PPTS;

const REPORTS_LATEST_DIR = path.join(ROOT, 'reports', 'latest');

function parseRounds(argv) {
  const match = argv.find((arg) => arg.startsWith('--rounds='));
  const value = Number.parseInt((match || '').split('=')[1] || '2', 10);
  if (!Number.isFinite(value) || value <= 0) return 2;
  return Math.min(value, 5);
}

function parseStress(argv) {
  return argv.some((arg) => arg === '--stress');
}

function parseDeep(argv) {
  return argv.some((arg) => arg === '--deep' || arg === '--nightly');
}

function parseStressSeeds(argv) {
  const match = argv.find((arg) => arg.startsWith('--stress-seeds='));
  const value = Number.parseInt((match || '').split('=')[1] || '30', 10);
  if (!Number.isFinite(value) || value <= 0) return 30;
  return Math.min(value, 1000);
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

function snapshotArtifactState(filePaths) {
  return (filePaths || []).map((filePath) => {
    if (!fs.existsSync(filePath)) {
      return { filePath, existed: false, buffer: null };
    }
    return {
      filePath,
      existed: true,
      buffer: fs.readFileSync(filePath),
    };
  });
}

function restoreArtifactState(snapshot) {
  for (const entry of snapshot || []) {
    const filePath = entry?.filePath;
    if (!filePath) continue;
    if (entry.existed) {
      fs.writeFileSync(filePath, entry.buffer);
      continue;
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
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
  if (typeof normalizeAbsoluteRelationshipTargets !== 'function') {
    throw new Error(
      'pptx-validator contract broken: normalizeAbsoluteRelationshipTargets export is missing'
    );
  }
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
  const threshold = 60;
  const violations = [];
  for (const slide of textData.slides || []) {
    const charCount = Number(slide.charCount || 0);
    if (charCount >= threshold) continue;
    const fullText = String(slide.fullText || '');
    const intent = classifySlideIntent(fullText, charCount);
    if (intent.isDivider) continue;
    // Genuinely sparse content slide — violation
    const normalized = fullText.replace(/\s+/g, ' ').trim().toLowerCase();
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

  // dealEconomics with financial_performance routes to chart slides (26,29).
  // When tableContextKeys lists it as needing table geometry but only chart slides
  // are available in the pattern, recovery is impossible — function should return
  // recovered=false and still provide the primary resolved route.
  const tableRoute = singlePptTest.resolveTemplateRouteWithGeometryGuard({
    blockKey: 'dealEconomics',
    dataType: 'financial_performance',
    data: { typicalDealSize: { average: '$1.2M' } },
    templateSelection: 26,
    tableContextKeys: ['dealEconomics'],
    chartContextKeys: ['marketSizeAndGrowth'],
  });
  assert.strictEqual(typeof tableRoute.recovered, 'boolean', 'recovered should be a boolean');
  assert.ok(
    tableRoute.resolved && typeof tableRoute.resolved === 'object',
    'should always return a resolved route object'
  );
  assert.strictEqual(
    tableRoute.requiredGeometry,
    'table',
    'dealEconomics should require table geometry'
  );

  // No-override case: default route should resolve without crash
  const defaultRoute = singlePptTest.resolveTemplateRouteWithGeometryGuard({
    blockKey: 'dealEconomics',
    dataType: 'financial_performance',
    data: { typicalDealSize: { average: '$1.2M' } },
    templateSelection: null,
    tableContextKeys: ['dealEconomics'],
    chartContextKeys: ['marketSizeAndGrowth'],
  });
  assert.ok(
    defaultRoute.resolved && typeof defaultRoute.resolved === 'object',
    'default route should resolve without crash'
  );

  // Chart block with no geometry requirement should pass through unchanged
  const chartRoute = singlePptTest.resolveTemplateRouteWithGeometryGuard({
    blockKey: 'marketSizeAndGrowth',
    dataType: 'time_series_multi_insight',
    data: {
      chartData: {
        series: [
          { name: '2024', value: 10 },
          { name: '2025', value: 12 },
        ],
      },
    },
    templateSelection: null,
    tableContextKeys: ['dealEconomics'],
    chartContextKeys: ['marketSizeAndGrowth'],
  });
  assert.ok(
    chartRoute.resolved && typeof chartRoute.resolved === 'object',
    'chart route should resolve without crash'
  );
  assert.strictEqual(
    chartRoute.requiredGeometry,
    'chart',
    'marketSizeAndGrowth should require chart geometry'
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

  // Runtime flow: sanitize FIRST, then gate. finalReviewGap1 is transient and gets stripped.
  const withTransientFinalReviewGap = {
    ...base,
    finalReviewGap1: { section: 'market', issue: 'transient' },
  };
  const sanitizerCtx = createSanitizationContext();
  const sanitizedPayload = sanitizeTransientKeys(withTransientFinalReviewGap, sanitizerCtx);
  assert.strictEqual(
    sanitizerCtx.droppedTransientKeyCount >= 1,
    true,
    `sanitizeTransientKeys should drop finalReviewGap1 (dropped ${sanitizerCtx.droppedTransientKeyCount})`
  );
  assert.strictEqual(
    'finalReviewGap1' in sanitizedPayload,
    false,
    'finalReviewGap1 must be stripped by sanitizer before reaching gate'
  );
  const issuesWithTransientFinalReviewGap = serverTest.collectPreRenderStructureIssues([
    sanitizedPayload,
  ]);
  assert.strictEqual(
    issuesWithTransientFinalReviewGap.filter((x) => /transient/i.test(x)).length,
    0,
    `After sanitization, no transient-key issues should remain; got: ${issuesWithTransientFinalReviewGap.join(' | ')}`
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

function runTransientKeySanitizerUnitChecks() {
  // --- isTransientKey: TRUE cases ---
  const trueCases = [
    'section_0',
    'section-1',
    'section2',
    'gap_1',
    'gap-2',
    'verify_1',
    'verify-2',
    'finalReviewGap1',
    'final_review_gap_2',
    '_wasArray',
    '_synthesisError',
    '_debugInfo',
    '0',
    '1',
    '42',
    'marketDeepen_2',
    'deepen_policy',
    'competitorsDeepen_1',
    'policyDeepen_0',
    'insightsdeepen',
    'depthdeepen',
  ];
  for (const key of trueCases) {
    assert.strictEqual(isTransientKey(key), true, `isTransientKey("${key}") should be true`);
  }

  // --- isTransientKey: FALSE cases ---
  const falseCases = [
    'finalReview',
    'marketSizeAndGrowth',
    'foundationalActs',
    'japanesePlayers',
    'goNoGo',
    'sources',
    'slideTitle',
    'keyInsights',
    'recommendation',
    'partnerAssessment',
  ];
  for (const key of falseCases) {
    assert.strictEqual(isTransientKey(key), false, `isTransientKey("${key}") should be false`);
  }

  // --- sanitizeTransientKeys: flat object ---
  {
    const ctx = createSanitizationContext();
    const input = {
      marketSizeAndGrowth: { overview: 'ok' },
      section_0: { junk: true },
      _wasArray: true,
      finalReview: { grade: 'A' },
    };
    const result = sanitizeTransientKeys(input, ctx);
    assert.strictEqual('marketSizeAndGrowth' in result, true, 'stable key preserved');
    assert.strictEqual('finalReview' in result, true, 'finalReview preserved');
    assert.strictEqual('section_0' in result, false, 'section_0 dropped');
    assert.strictEqual('_wasArray' in result, false, '_wasArray dropped');
    assert.strictEqual(ctx.droppedTransientKeyCount, 2, 'count=2');
  }

  // --- sanitizeTransientKeys: nested ---
  {
    const ctx = createSanitizationContext();
    const input = {
      policy: {
        foundationalActs: { overview: 'ok' },
        deepen_policy: { junk: true },
        gap_1: { junk: true },
      },
    };
    const result = sanitizeTransientKeys(input, ctx);
    assert.strictEqual('foundationalActs' in result.policy, true, 'nested stable preserved');
    assert.strictEqual('deepen_policy' in result.policy, false, 'nested transient dropped');
    assert.strictEqual('gap_1' in result.policy, false, 'nested gap dropped');
    assert.strictEqual(ctx.droppedTransientKeyCount, 2, 'nested count=2');
  }

  // --- sanitizeTransientKeys: array of objects ---
  {
    const ctx = createSanitizationContext();
    const input = [
      { name: 'A', _debugInfo: 'x' },
      { name: 'B', section_0: {} },
    ];
    const result = sanitizeTransientKeys(input, ctx);
    assert.strictEqual(result[0].name, 'A', 'array element stable preserved');
    assert.strictEqual('_debugInfo' in result[0], false, 'array element transient dropped');
    assert.strictEqual('section_0' in result[1], false, 'array element section dropped');
    assert.strictEqual(ctx.droppedTransientKeyCount, 2, 'array count=2');
  }

  // --- sanitizeTransientKeys: null/string pass through ---
  {
    const ctx = createSanitizationContext();
    assert.strictEqual(sanitizeTransientKeys(null, ctx), null, 'null passthrough');
    assert.strictEqual(sanitizeTransientKeys('hello', ctx), 'hello', 'string passthrough');
    assert.strictEqual(sanitizeTransientKeys(42, ctx), 42, 'number passthrough');
    assert.strictEqual(ctx.droppedTransientKeyCount, 0, 'no drops for primitives');
  }

  // --- Integration: noisy synthesis payload ---
  {
    const ctx = createSanitizationContext();
    const noisy = {
      foundationalActs: { overview: 'ok' },
      nationalPolicy: { overview: 'ok' },
      investmentRestrictions: { overview: 'ok' },
      regulatorySummary: { overview: 'ok' },
      section_0: { wrapped: true },
      section_1: { wrapped: true },
      section_2: { wrapped: true },
      _wasArray: true,
      deepen_market: { junk: true },
      finalReviewGap1: { issue: 'transient' },
    };
    const result = sanitizeTransientKeys(noisy, ctx);
    assert.strictEqual(Object.keys(result).length, 4, 'only 4 canonical keys remain');
    assert.strictEqual(ctx.droppedTransientKeyCount, 6, '6 transient keys dropped');
    for (const key of Object.keys(result)) {
      assert.strictEqual(isTransientKey(key), false, `remaining key "${key}" is not transient`);
    }
  }

  // --- Integration: full country analysis with transient in all sections ---
  {
    const ctx = createSanitizationContext();
    const full = {
      country: 'Vietnam',
      finalReview: { grade: 'A' },
      finalReviewGap1: { issue: 'x' },
      _wasArray: true,
      policy: {
        foundationalActs: { overview: 'ok' },
        section_0: { junk: true },
      },
      market: {
        marketSizeAndGrowth: { overview: 'ok' },
        deepen_market: { junk: true },
      },
      competitors: {
        localMajor: { players: [] },
        gap_1: { junk: true },
      },
      depth: {
        dealEconomics: { overview: 'ok' },
        verify_1: { junk: true },
      },
      summary: {
        goNoGo: { verdict: 'GO' },
        competitorsDeepen_1: { junk: true },
      },
    };
    const result = sanitizeTransientKeys(full, ctx);
    assert.strictEqual('finalReview' in result, true, 'finalReview preserved in full');
    assert.strictEqual('finalReviewGap1' in result, false, 'finalReviewGap1 dropped');
    assert.strictEqual('_wasArray' in result, false, '_wasArray dropped');
    assert.strictEqual('section_0' in result.policy, false, 'nested section dropped');
    assert.strictEqual('deepen_market' in result.market, false, 'nested deepen dropped');
    assert.strictEqual('gap_1' in result.competitors, false, 'nested gap dropped');
    assert.strictEqual('verify_1' in result.depth, false, 'nested verify dropped');
    assert.strictEqual('competitorsDeepen_1' in result.summary, false, 'nested deepen dropped');
    assert(
      ctx.droppedTransientKeyCount >= 7,
      `dropped at least 7, got ${ctx.droppedTransientKeyCount}`
    );
    assert(ctx.droppedTransientKeySamples.length > 0, 'samples populated');
  }
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

  // Extreme table (50x20 with 1000-char cells)
  const extremeCell = 'X'.repeat(1000);
  const extremeHeader = Array.from({ length: 20 }, (_, i) => `Col${i}`);
  const extremeBody = Array.from({ length: 20 }, () => extremeCell);
  const extremeRows = [extremeHeader, ...Array.from({ length: 49 }, () => [...extremeBody])];
  const extremeFit = singlePptTest.computeTableFitScore(extremeRows, { w: 8.5, h: 3.5 });
  assert(extremeFit.score < 30, `Expected score<30 for 50x20 extreme; got ${extremeFit.score}`);
  assert.strictEqual(extremeFit.recommendation, 'fallback');

  // Wide table (3 rows x 15 cols)
  const wideRows = [
    Array.from({ length: 15 }, (_, i) => `H${i}`),
    Array.from({ length: 15 }, () => 'short'),
    Array.from({ length: 15 }, () => 'short'),
  ];
  const wideFit = singlePptTest.computeTableFitScore(wideRows, { w: 8.5, h: 3.5 });
  assert(
    wideFit.breakdown.colScore < 50,
    `colScore < 50 for 15-col; got ${wideFit.breakdown.colScore}`
  );

  // Tall table (30 rows x 3 cols)
  const tallRows = [['A', 'B', 'C'], ...Array.from({ length: 29 }, () => ['d1', 'd2', 'd3'])];
  const tallFit = singlePptTest.computeTableFitScore(tallRows, { w: 8.5, h: 3.5 });
  assert(
    tallFit.breakdown.rowScore < 10,
    `rowScore<10 for 30 rows; got ${tallFit.breakdown.rowScore}`
  );
  assert(
    tallFit.breakdown.geometryScore < 50,
    `geometryScore<50 for 30 rows; got ${tallFit.breakdown.geometryScore}`
  );

  // Dense cells only (normal dimensions, 800-char cells)
  const denseCell = 'W'.repeat(800);
  const denseRows = [
    ['HA', 'HB'],
    [denseCell, denseCell],
    [denseCell, denseCell],
  ];
  const denseFit = singlePptTest.computeTableFitScore(denseRows, { w: 8.5, h: 3.5 });
  assert(
    denseFit.breakdown.densityScore < 60,
    `densityScore<60 for 800-char; got ${denseFit.breakdown.densityScore}`
  );

  // At-boundary table (16 rows x 9 cols = exactly at MAX)
  const boundaryRows = [
    Array.from({ length: 9 }, (_, i) => `C${i}`),
    ...Array.from({ length: 15 }, () => Array.from({ length: 9 }, () => 'data')),
  ];
  const boundaryFit = singlePptTest.computeTableFitScore(boundaryRows, { w: 8.5, h: 3.5 });
  assert(
    boundaryFit.breakdown.rowScore >= 80,
    `rowScore>=80 at max; got ${boundaryFit.breakdown.rowScore}`
  );
  assert(
    boundaryFit.breakdown.colScore >= 80,
    `colScore>=80 at max; got ${boundaryFit.breakdown.colScore}`
  );

  // Single-row table
  const singleRowFit = singlePptTest.computeTableFitScore([['A', 'B']], { w: 8.5, h: 3.5 });
  assert.strictEqual(
    singleRowFit.score,
    100,
    `single-row should be 100; got ${singleRowFit.score}`
  );

  // Null/undefined rect handling
  const noRectFit = singlePptTest.computeTableFitScore(
    [
      ['A', 'B'],
      ['C', 'D'],
    ],
    null
  );
  assert(noRectFit.score > 0, 'null rect should not crash');
  const undefinedRectFit = singlePptTest.computeTableFitScore([['A']], undefined);
  assert(undefinedRectFit.score > 0, 'undefined rect should not crash');

  // Mixed-type rows (string, object, null)
  const mixedRows = [
    ['Header', { text: 'Complex' }, null],
    [42, { text: 'Cell' }, ''],
  ];
  const mixedFit = singlePptTest.computeTableFitScore(mixedRows, { w: 8.5, h: 3.5 });
  assert(mixedFit.score >= 0 && mixedFit.score <= 100, `score 0-100; got ${mixedFit.score}`);

  console.log('[Regression] Extreme table fit-score edge cases PASS');
}

function runDividerAwareSparseUnitChecks() {
  // --- classifySlideIntent: divider slides should be classified as isDivider=true ---

  // Section divider titles
  const dividerCases = [
    { text: 'Policy & Regulatory', reason: 'section_divider' },
    { text: 'Market Overview', reason: 'section_divider' },
    { text: 'Competitive Landscape', reason: 'section_divider' },
    { text: 'Strategic Analysis', reason: 'section_divider' },
    { text: 'Recommendations', reason: 'section_divider' },
    { text: 'Appendix', reason: 'appendix_header' },
    { text: 'Executive Summary', reason: 'section_divider' },
    { text: 'Table of Contents', reason: 'toc' },
    { text: 'Table of Contents  Policy & Regulatory  Market Overview', reason: 'toc' },
  ];

  for (const { text, reason } of dividerCases) {
    const result = classifySlideIntent(text, text.length);
    assert.strictEqual(
      result.isDivider,
      true,
      `classifySlideIntent("${text}") should be divider (reason=${reason}), got isDivider=${result.isDivider}, reason=${result.reason}`
    );
  }

  // Title-only heuristic: short text, no sentence structure
  const titleOnly = classifySlideIntent('Vietnam Energy', 14);
  assert.strictEqual(
    titleOnly.isDivider,
    true,
    'Short title-only text should be classified as divider'
  );
  assert.strictEqual(titleOnly.reason, 'title_only');

  // --- classifySlideIntent: content slides should NOT be classified as dividers ---

  const contentCases = [
    '', // empty is NOT a divider
    'The energy market in Vietnam grew by 15% in 2024, driven by industrial expansion.',
    'Key findings include strong policy support and growing FDI inflows. Investment barriers remain.',
  ];

  for (const text of contentCases) {
    const result = classifySlideIntent(text, text.length);
    assert.strictEqual(
      result.isDivider,
      false,
      `classifySlideIntent("${text.slice(0, 40)}...") should NOT be divider, got isDivider=${result.isDivider}, reason=${result.reason}`
    );
  }

  // Empty slide: should be classified as NOT divider (genuinely empty = bad)
  const emptyResult = classifySlideIntent('', 0);
  assert.strictEqual(emptyResult.isDivider, false, 'Empty slide is NOT a divider');
  assert.strictEqual(emptyResult.reason, 'empty');

  // Long text under 80 chars WITH sentence punctuation should NOT be a divider
  const shortSentence = classifySlideIntent('This is a real content slide.', 29);
  assert.strictEqual(
    shortSentence.isDivider,
    false,
    'Short text with sentence punctuation should not be classified as divider'
  );
}

// --- Crash signature regression checks (type-mismatch hardening) ---
const { addLineChart, addStackedBarChart, enrichCompanyDesc } = require('./ppt-utils');

function runCrashSignatureRegressionChecks() {
  // 1. dedupeGlobalCompanyList must handle non-array inputs without throwing
  const dedup = singlePptTest.dedupeGlobalCompanyList;
  assert(typeof dedup === 'function', 'dedupeGlobalCompanyList should be exported');
  for (const bad of ['string', 123, null, undefined, { a: 1 }, true]) {
    const result = dedup(bad, new Set());
    assert(Array.isArray(result), 'dedup(' + JSON.stringify(bad) + ') should return array');
    assert.strictEqual(result.length, 0, 'dedup(' + JSON.stringify(bad) + ') should return empty');
  }
  // Valid input
  const seen = new Set();
  const valid = dedup(
    [{ name: 'Acme Corp' }, { name: 'Acme Corp Ltd' }, { name: 'Beta Inc' }],
    seen
  );
  assert(Array.isArray(valid), 'valid dedup should return array');
  assert(valid.length >= 1, 'valid dedup should return at least 1 item');

  // 2. addLineChart / addStackedBarChart must not crash when series is non-array
  const mockSlide = { addText: () => {}, addChart: () => {}, addShape: () => {} };
  for (const badSeries of ['string', 123, null, { a: 1 }]) {
    const badData = { categories: ['2024', '2025'], series: badSeries };
    addLineChart(mockSlide, 'Test', badData);
    addStackedBarChart(mockSlide, 'Test', badData);
  }

  // 3. enrichCompanyDesc must not crash when description is non-string
  for (const badDesc of [123, ['arr'], { obj: true }, true, null, undefined]) {
    const company = { name: 'Test Co', description: badDesc };
    const result = enrichCompanyDesc(company, 'US', 'Tech');
    assert(
      result && typeof result === 'object',
      'enrichCompanyDesc should return object for desc=' + JSON.stringify(badDesc)
    );
  }
}

// --- Stress lab deterministic replay checks ---
function runStressLabDeterminismChecks() {
  // Same seed must produce identical scenario metadata
  const scenario1a = stressLabTest.getSeedScenario(42);
  const scenario1b = stressLabTest.getSeedScenario(42);
  assert.deepStrictEqual(scenario1a, scenario1b, 'Same seed must produce identical scenario');

  // Different seeds should produce different scenarios (at least some)
  const scenarios = new Set();
  for (let seed = 1; seed <= 50; seed++) {
    const s = stressLabTest.getSeedScenario(seed);
    scenarios.add(`${s.country}|${s.industry}|${s.projectType}`);
  }
  assert(
    scenarios.size >= 5,
    `Expected at least 5 distinct scenarios from 50 seeds, got ${scenarios.size}`
  );

  // Same seed must produce identical mutation classes
  const mutations1a = stressLabTest.selectMutationsForSeed(42);
  const mutations1b = stressLabTest.selectMutationsForSeed(42);
  assert.deepStrictEqual(
    mutations1a,
    mutations1b,
    'Same seed must produce identical mutation classes'
  );

  // Same seed must produce identical mutated payload
  const base1 = stressLabTest.buildBasePayload(42);
  const base2 = stressLabTest.buildBasePayload(42);
  assert.strictEqual(
    JSON.stringify(base1),
    JSON.stringify(base2),
    'Same seed must produce identical base payload'
  );

  // Verify seed diversity constants
  assert(stressLabTest.SEED_COUNTRIES.length >= 4, 'Need at least 4 countries for diversity');
  assert(stressLabTest.SEED_INDUSTRIES.length >= 4, 'Need at least 4 industries for diversity');
  assert(
    stressLabTest.SEED_PROJECT_TYPES.length >= 3,
    'Need at least 3 project types for diversity'
  );

  // Verify 300+ seeds cover all scenario dimensions
  const allCountries = new Set();
  const allIndustries = new Set();
  const allProjectTypes = new Set();
  for (let seed = 1; seed <= 300; seed++) {
    const s = stressLabTest.getSeedScenario(seed);
    allCountries.add(s.country);
    allIndustries.add(s.industry);
    allProjectTypes.add(s.projectType);
  }
  assert.strictEqual(
    allCountries.size,
    stressLabTest.SEED_COUNTRIES.length,
    `300 seeds should cover all ${stressLabTest.SEED_COUNTRIES.length} countries, got ${allCountries.size}`
  );
  assert.strictEqual(
    allIndustries.size,
    stressLabTest.SEED_INDUSTRIES.length,
    `300 seeds should cover all ${stressLabTest.SEED_INDUSTRIES.length} industries, got ${allIndustries.size}`
  );
  assert.strictEqual(
    allProjectTypes.size,
    stressLabTest.SEED_PROJECT_TYPES.length,
    `300 seeds should cover all ${stressLabTest.SEED_PROJECT_TYPES.length} project types, got ${allProjectTypes.size}`
  );
}

// --- Failure cluster analyzer checks ---
function runFailureClusterAnalyzerChecks() {
  // extractErrorSignature normalizes similar errors
  const sig1 = clusterTest.extractErrorSignature(
    "Cannot read properties of undefined (reading 'map')"
  );
  const sig2 = clusterTest.extractErrorSignature(
    "Cannot read properties of undefined (reading 'filter')"
  );
  assert(
    typeof sig1 === 'string' && sig1.length > 0,
    'extractErrorSignature should return non-empty string'
  );

  // extractStackSignature
  const stack = `Error: test
    at renderSlide (/app/ppt-single-country.js:123:45)
    at generatePPT (/app/ppt-single-country.js:456:12)
    at runSeed (/app/stress-lab.js:789:10)`;
  const stackSig = clusterTest.extractStackSignature(stack);
  assert(stackSig.includes('renderSlide'), 'Stack signature should include function name');
  assert(stackSig.includes('ppt-single-country.js'), 'Stack signature should include file name');

  // extractStackSignature handles null/empty
  assert.strictEqual(clusterTest.extractStackSignature(null), '');
  assert.strictEqual(clusterTest.extractStackSignature(''), '');

  // extractCombinedSignature
  const combined = clusterTest.extractCombinedSignature('Cannot read properties', stack);
  assert(combined.includes('Cannot read properties'), 'Combined should include error');
  assert(combined.includes('['), 'Combined should include stack bracket');

  // clusterWithSummary handles empty
  const emptySummary = clusterWithSummary([]);
  assert.strictEqual(emptySummary.clusters.length, 0, 'Empty input = no clusters');
  assert.strictEqual(emptySummary.topBlockers.length, 0, 'Empty input = no blockers');

  // clusterWithSummary handles non-array
  const nullSummary = clusterWithSummary(null);
  assert.strictEqual(nullSummary.clusters.length, 0, 'null input = no clusters');

  // clusterWithSummary clusters failures correctly
  const mockTelemetry = [
    { seed: 1, status: 'pass' },
    {
      seed: 2,
      status: 'fail',
      error: 'Cannot read properties of null',
      errorClass: 'runtime-crash',
      failedPhase: 'render-ppt',
      mutationClasses: ['transient-keys'],
      stack: '',
    },
    {
      seed: 3,
      status: 'fail',
      error: 'Cannot read properties of null',
      errorClass: 'runtime-crash',
      failedPhase: 'render-ppt',
      mutationClasses: ['schema-corruption'],
      stack: '',
    },
    {
      seed: 4,
      status: 'fail',
      error: '[PPT] Data gate failed',
      errorClass: 'data-gate',
      failedPhase: 'render-ppt',
      mutationClasses: ['empty-null'],
      stack: '',
    },
    { seed: 5, status: 'pass' },
  ];
  const summary = clusterWithSummary(mockTelemetry, { topN: 10 });
  assert(summary.clusters.length >= 1, 'Should have at least 1 cluster');
  assert(summary.stats.totalFailures === 3, 'Should count 3 failures');
  assert(summary.stats.runtimeCrashes === 2, 'Should count 2 runtime crashes');
  assert(summary.stats.uniqueSignatures >= 1, 'Should have at least 1 unique signature');
  assert(summary.topBlockers.length >= 1, 'Should have at least 1 top blocker');
  assert(
    summary.topBlockers[0].replayCommand.includes('--seed='),
    'Blocker should have replay command'
  );

  // Verify most frequent cluster is ranked first
  const topCluster = summary.clusters[0];
  assert(
    topCluster.count >= 2,
    'Top cluster should have count >= 2 (the null error appears twice)'
  );
}

// --- Stress lab runtime mode checks ---
function runStressLabRuntimeModeChecks() {
  assert.strictEqual(DEFAULT_SEEDS, 30, 'DEFAULT_SEEDS should be 30 for quick mode');
  assert.strictEqual(DEEP_SEEDS, 300, 'DEEP_SEEDS should be 300 for deep/nightly mode');
}

/**
 * Write latest validation summary to reports/latest/ as both JSON and markdown.
 * Called after each round completes validation.
 */
function writeValidationSummary(round, validationResults) {
  try {
    fs.mkdirSync(REPORTS_LATEST_DIR, { recursive: true });

    const summary = {
      timestamp: new Date().toISOString(),
      round,
      artifactPersistence: SHOULD_RESTORE_ARTIFACTS ? 'restored' : 'persisted',
      results: validationResults,
    };

    // Write JSON
    const jsonPath = path.join(REPORTS_LATEST_DIR, 'validation-summary.json');
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

    // Write markdown
    const mdPath = path.join(REPORTS_LATEST_DIR, 'validation-summary.md');
    const mdLines = [
      `# Validation Summary`,
      ``,
      `**Timestamp:** ${summary.timestamp}`,
      `**Round:** ${round}`,
      `**Artifact Persistence:** ${summary.artifactPersistence}`,
      ``,
      `## Results`,
      ``,
      `| Deck | Country | Status | Details |`,
      `|------|---------|--------|---------|`,
    ];

    for (const result of validationResults) {
      const status = result.pass ? 'PASS' : 'FAIL';
      const details = result.error || result.details || 'OK';
      mdLines.push(`| ${result.deck} | ${result.country} | ${status} | ${details} |`);
    }

    // Template fidelity gate section
    const failures = validationResults.filter((r) => !r.pass);
    if (failures.length > 0) {
      mdLines.push('');
      mdLines.push('## Template Fidelity Gate VIOLATIONS');
      mdLines.push('');
      for (const f of failures) {
        mdLines.push(`- **${f.deck}** (${f.country}): ${f.error || f.details}`);
      }
    }

    mdLines.push('');
    fs.writeFileSync(mdPath, mdLines.join('\n'));

    console.log(`[Regression] Validation summary written to ${REPORTS_LATEST_DIR}/`);
  } catch (err) {
    console.error(`[Regression] Warning: failed to write validation summary: ${err.message}`);
  }
}

async function runRound(round, total) {
  console.log(`\n[Regression] Round ${round}/${total}`);
  console.log(
    `[Regression] Artifact mode: ${SHOULD_RESTORE_ARTIFACTS ? 'RESTORE (debug opt-in)' : 'PERSIST (default — fresh output kept)'}`
  );
  const artifactSnapshot = SHOULD_RESTORE_ARTIFACTS
    ? snapshotArtifactState(ROUND_ARTIFACT_PATHS)
    : null;

  const validationResults = [];

  try {
    runTemplateCloneUnitChecks();
    console.log('[Regression] Unit checks PASS (template-clone filter behavior)');
    runPptGateUnitChecks();
    console.log('[Regression] Unit checks PASS (pre-render PPT gate block shaping)');
    runCompetitiveGateUnitChecks();
    console.log('[Regression] Unit checks PASS (competitive optional-group gate override)');
    runTemplateRouteRecoveryUnitChecks();
    console.log('[Regression] Unit checks PASS (template route geometry recovery)');
    await runDynamicTimeoutUnitChecks();
    console.log('[Regression] Unit checks PASS (dynamic timeout partial-result handling)');
    runPreRenderStructureUnitChecks();
    console.log('[Regression] Unit checks PASS (pre-render structure gating)');
    runTransientKeySanitizerUnitChecks();
    console.log('[Regression] Unit checks PASS (transient key sanitizer canonical module)');
    runCrashSignatureRegressionChecks();
    console.log('[Regression] Unit checks PASS (crash signature type-mismatch guards)');
    runDividerAwareSparseUnitChecks();
    console.log('[Regression] Unit checks PASS (divider-aware sparse slide classification)');
    runStressLabDeterminismChecks();
    console.log('[Regression] Unit checks PASS (stress lab deterministic replay + seed diversity)');
    runFailureClusterAnalyzerChecks();
    console.log('[Regression] Unit checks PASS (failure cluster analyzer signature grouping)');
    runStressLabRuntimeModeChecks();
    console.log('[Regression] Unit checks PASS (stress lab runtime mode constants)');

    await runNodeScript(VIETNAM_SCRIPT);
    await runNodeScript(THAILAND_SCRIPT);

    if (!fs.existsSync(VIETNAM_PPT)) throw new Error(`Missing generated file: ${VIETNAM_PPT}`);
    if (!fs.existsSync(THAILAND_PPT)) throw new Error(`Missing generated file: ${THAILAND_PPT}`);

    // Validate decks and collect results
    for (const { pptxPath, country, industry, wrongCountry, deck } of [
      {
        pptxPath: VIETNAM_PPT,
        country: 'Vietnam',
        industry: 'Energy Services',
        wrongCountry: 'Thailand',
        deck: 'vietnam-output.pptx',
      },
      {
        pptxPath: THAILAND_PPT,
        country: 'Thailand',
        industry: 'Energy Services',
        wrongCountry: 'Vietnam',
        deck: 'test-output.pptx',
      },
    ]) {
      try {
        await validateDeck(pptxPath, country, industry);
        await ensureCountryIntegrity({ pptxPath, country, wrongCountry });
        await ensureSparseSlideDiscipline(pptxPath);
        await ensureNoRepairNeeded(pptxPath);
        validationResults.push({ deck, country, pass: true, details: 'All checks passed' });
      } catch (err) {
        validationResults.push({ deck, country, pass: false, error: err.message });
        // Template fidelity gate violation — fail loudly
        console.error(
          `\n[Regression] TEMPLATE FIDELITY GATE VIOLATION: ${deck} (${country})\n  ${err.message}\n`
        );
        throw err;
      }
    }

    console.log('[Regression] Country integrity PASS (cover + TOC country checks)');
    console.log('[Regression] Sparse-slide discipline PASS (non-divider sparse slides blocked)');
    console.log('[Regression] Package normalization PASS (no repair transforms needed)');
  } finally {
    // Write validation summary regardless of pass/fail
    writeValidationSummary(round, validationResults);

    if (SHOULD_RESTORE_ARTIFACTS && artifactSnapshot) {
      restoreArtifactState(artifactSnapshot);
      console.log('[Regression] Artifacts restored (RESTORE_OLD_ARTIFACTS=1 debug mode)');
    } else if (!SHOULD_RESTORE_ARTIFACTS) {
      console.log('[Regression] Fresh artifacts persisted on disk (default behavior)');
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const rounds = parseRounds(argv);
  const stress = parseStress(argv);
  const deep = parseDeep(argv);
  const stressSeeds = parseStressSeeds(argv);

  for (let i = 1; i <= rounds; i++) {
    await runRound(i, rounds);
  }
  console.log(`\n[Regression] PASS (${rounds} round(s))`);

  if (stress) {
    console.log(`\n[Regression] Running stress test harness (${stressSeeds} seeds)...`);
    const reportPath = path.join(ROOT, 'stress-report.md');
    const result = await runStressTest({ seeds: stressSeeds, reportPath });
    console.log(
      `[Regression] Stress: ${result.passed}/${result.total} passed, ${result.failed} failed (${result.runtimeCrashes} runtime crashes, ${result.dataGateRejections} data-gate rejections)`
    );
    const crashes = result.failures.filter((f) => f.errorClass === 'runtime-crash');
    if (crashes.length > 0) {
      console.log(`[Regression] Runtime crashes (bugs):`);
      for (const f of crashes.slice(0, 10)) {
        console.log(`  seed=${f.seed} [${f.category}]: ${f.error}`);
      }
    }
    console.log(`[Regression] Stress report: ${reportPath}`);
    if (result.runtimeCrashes > 0) {
      throw new Error(
        `Stress test found ${result.runtimeCrashes} runtime crash(es) out of ${result.total} seeds`
      );
    }
    console.log(
      `[Regression] Stress PASS (${stressSeeds} seeds, ${result.dataGateRejections} expected gate rejections)`
    );
  }

  if (deep) {
    const labSeeds = stressSeeds > DEFAULT_SEEDS ? stressSeeds : DEEP_SEEDS;
    console.log(`\n[Regression] Running stress lab deep mode (${labSeeds} seeds)...`);
    const labReportPath = path.join(ROOT, 'stress-lab-report.md');
    const labResult = await runStressLab({
      seeds: labSeeds,
      deep: true,
      reportPath: labReportPath,
    });
    const labStats = labResult.stats;
    console.log(
      `[Regression] Stress Lab: ${labStats.passed}/${labStats.total} passed, ${labStats.failed} failed (${labStats.runtimeCrashes} runtime crashes, ${labStats.dataGateRejections} data-gate rejections)`
    );
    if (labResult.topBlockers && labResult.topBlockers.length > 0) {
      console.log(`[Regression] Top crash signatures:`);
      for (const b of labResult.topBlockers.slice(0, 5)) {
        const cls = (b.errorClasses || []).includes('runtime-crash') ? 'BUG' : 'gate';
        console.log(
          `  #${b.rank} (${cls}, risk=${b.riskScore}, count=${b.count}): ${(b.signature || '').substring(0, 80)}`
        );
        console.log(`    Replay: ${b.replayCommand}`);
      }
    }
    if (labStats.scenarioCoverage) {
      console.log(
        `[Regression] Scenario coverage: ${labStats.scenarioCoverage.countries.length} countries, ${labStats.scenarioCoverage.industries.length} industries, ${labStats.scenarioCoverage.projectTypes.length} project types`
      );
    }
    console.log(`[Regression] Stress lab report: ${labReportPath}`);
    if (labStats.runtimeCrashes > 0) {
      throw new Error(
        `Stress lab found ${labStats.runtimeCrashes} runtime crash(es) out of ${labStats.total} seeds`
      );
    }
    console.log(
      `[Regression] Stress Lab PASS (${labSeeds} seeds, ${labStats.dataGateRejections} expected gate rejections, ${labStats.clusterCount || 0} failure clusters)`
    );
  }
}

// Export internals for testing
module.exports = {
  __test: {
    snapshotArtifactState,
    restoreArtifactState,
    writeValidationSummary,
    SHOULD_RESTORE_ARTIFACTS,
    RESTORE_OLD_ARTIFACTS,
    PRESERVE_GENERATED_PPTS,
    ROUND_ARTIFACT_PATHS,
    REPORTS_LATEST_DIR,
  },
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n[Regression] FAIL: ${err.message}`);
    process.exit(1);
  });
}
