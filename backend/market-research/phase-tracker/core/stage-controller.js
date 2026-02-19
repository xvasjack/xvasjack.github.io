'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { STAGE_ORDER, STAGES } = require('../contracts/stages');
const { attemptDir } = require('../artifacts/pathing');

// ── Lazy-loaded pipeline modules ─────────────────────────────────────────────
// Deferred so this file can be required without booting the full pipeline.
let _mods = null;
function mods() {
  if (_mods) return _mods;
  const root = path.resolve(__dirname, '..', '..');
  const load = (f) => require(path.join(root, f));

  _mods = {
    researchCountry: load('research-engine').researchCountry,
    synthesizeFindings: load('research-engine').synthesizeFindings,
    validateResearchQuality: load('content-gates').validateResearchQuality,
    validateSynthesisQuality: load('content-gates').validateSynthesisQuality,
    validatePptData: load('content-gates').validatePptData,
    checkContentReadiness: load('content-quality-check').checkContentReadiness,
    checkStoryFlow: load('story-flow-check').checkStoryFlow,
    generatePPT: load('deck-builder').generatePPT,
    readPPTX: load('deck-file-check').readPPTX,
    scanRelationshipTargets: load('deck-file-check').scanRelationshipTargets,
    scanPackageConsistency: load('deck-file-check').scanPackageConsistency,
    normalizeAbsoluteRelationshipTargets:
      load('deck-file-check').normalizeAbsoluteRelationshipTargets,
    normalizeSlideNonVisualIds: load('deck-file-check').normalizeSlideNonVisualIds,
    reconcileContentTypesAndPackage: load('deck-file-check').reconcileContentTypesAndPackage,
    runContentSizeCheck: load('content-size-check').runContentSizeCheck,
    sanitizeTransientKeys: load('cleanup-temp-fields').sanitizeTransientKeys,
    createSanitizationContext: load('cleanup-temp-fields').createSanitizationContext,
    costTracker: load('ai-clients').costTracker,
    resetBudget: load('ai-clients').resetBudget,
  };

  // Review/improve helpers from server.__test
  try {
    const srv = load('server').__test || {};
    _mods.reviewCountryAnalysisWithGeminiPro = srv.reviewCountryAnalysisWithGeminiPro;
    _mods.improveSynthesisWithGeminiPro = srv.improveSynthesisWithGeminiPro;
    _mods.improveSynthesisQualityWithGeminiPro = srv.improveSynthesisQualityWithGeminiPro;
    _mods.mergeCountryAnalysis = srv.mergeCountryAnalysis;
    _mods.countryNeedsReview = srv.countryNeedsReview;
    _mods.buildPptGateBlocks = srv.buildPptGateBlocks;
    _mods.collectPreRenderStructureIssues = srv.collectPreRenderStructureIssues;
  } catch (e) {
    console.warn(`[stage-controller] Could not load server.__test helpers: ${e.message}`);
  }

  return _mods;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);
}

// ── Stage handler definitions ────────────────────────────────────────────────
// Each returns: { data, gateResults?, metrics?, binary?, pptInspection?, summary? }

const HANDLERS = {
  2: async function stageResearch(ctx) {
    const m = mods();
    m.resetBudget();
    const result = await m.researchCountry(
      ctx.scope.targetMarkets[0],
      ctx.scope.industry,
      ctx.scope.clientContext,
      ctx.scope
    );
    if (result?.error) throw new Error(`Research error: ${result.error}`);
    ctx.countryAnalyses = [result];
    const gate = m.validateResearchQuality(result.rawData || {});
    return {
      data: result,
      gateResults: { pass: gate.pass, score: gate.score, issues: gate.issues },
      metrics: { topicCount: result.rawData ? Object.keys(result.rawData).length : 0 },
    };
  },

  '2a': async function stageResearchReview(ctx) {
    const m = mods();
    const ca = ctx.countryAnalyses[0];
    if (!m.countryNeedsReview || !m.countryNeedsReview(ca)) {
      return { data: ca, gateResults: { pass: true, skipped: true, reason: 'No review needed' } };
    }
    const issues = [];
    if (ca?.readyForClient === false) issues.push('readyForClient flag is false');
    for (const key of ['policy', 'market', 'competitors', 'depth', 'summary']) {
      if (!ca?.[key] || typeof ca[key] !== 'object') issues.push(`missing/invalid section: ${key}`);
    }
    const reviewed = await m.reviewCountryAnalysisWithGeminiPro({
      countryAnalysis: ca,
      scope: ctx.scope,
      issues,
      attempt: 1,
      maxRetries: 1,
    });
    if (isPlainObject(reviewed)) {
      ctx.countryAnalyses[0] = m.mergeCountryAnalysis(ca, reviewed);
    }
    const stillNeeds = m.countryNeedsReview(ctx.countryAnalyses[0]);
    return {
      data: ctx.countryAnalyses[0],
      gateResults: { pass: !stillNeeds, applied: true, stillNeedsReview: stillNeeds },
    };
  },

  3: async function stageSynthesize(ctx) {
    const m = mods();
    const synthesis = await m.synthesizeFindings(ctx.countryAnalyses, ctx.scope);
    if (!isPlainObject(synthesis)) throw new Error('Synthesis returned invalid object');
    ctx.synthesis = synthesis;
    return { data: synthesis };
  },

  '3a': async function stageSynthesisGate(ctx) {
    const m = mods();
    let gate = m.validateSynthesisQuality(ctx.synthesis, ctx.scope.industry);
    if (!gate.pass && m.improveSynthesisQualityWithGeminiPro) {
      const improved = await m.improveSynthesisQualityWithGeminiPro({
        synthesis: ctx.synthesis,
        scope: ctx.scope,
        synthesisGate: gate,
        attempt: 1,
        maxRetries: 1,
      });
      if (isPlainObject(improved)) {
        ctx.synthesis = improved;
        gate = m.validateSynthesisQuality(ctx.synthesis, ctx.scope.industry);
      }
    }
    return {
      data: ctx.synthesis,
      gateResults: { pass: gate.pass, overall: gate.overall, failures: gate.failures },
    };
  },

  4: async function stageContentCheck(ctx) {
    const m = mods();
    const readiness = m.checkContentReadiness(ctx.synthesis, {
      threshold: 80,
      industry: ctx.scope.industry,
      coherenceChecker: m.checkStoryFlow,
    });
    ctx.contentReadiness = readiness;
    return {
      data: {
        pass: readiness.pass,
        overallScore: readiness.overallScore,
        threshold: readiness.threshold,
        shallowSections: readiness.shallowSections,
        contradictions: Array.isArray(readiness.contradictions)
          ? readiness.contradictions.length
          : 0,
        sectionScorecard: readiness.sectionScorecard,
        improvementActions: readiness.improvementActions,
      },
      gateResults: {
        pass: readiness.pass,
        score: readiness.overallScore,
        threshold: readiness.threshold,
      },
    };
  },

  '4a': async function stageContentImprove(ctx) {
    const m = mods();
    if (ctx.contentReadiness?.pass) {
      return {
        data: ctx.synthesis,
        gateResults: { pass: true, skipped: true, reason: 'Content readiness already passing' },
      };
    }
    if (!m.improveSynthesisWithGeminiPro) {
      return {
        data: ctx.synthesis,
        gateResults: { pass: false, skipped: true, reason: 'improve function unavailable' },
      };
    }
    const improved = await m.improveSynthesisWithGeminiPro({
      synthesis: ctx.synthesis,
      scope: ctx.scope,
      contentReadiness: ctx.contentReadiness,
      attempt: 1,
      maxRetries: 1,
    });
    if (isPlainObject(improved)) {
      ctx.synthesis = improved;
      ctx.contentReadiness = m.checkContentReadiness(ctx.synthesis, {
        threshold: 80,
        industry: ctx.scope.industry,
        coherenceChecker: m.checkStoryFlow,
      });
    }
    return {
      data: ctx.synthesis,
      gateResults: {
        pass: ctx.contentReadiness?.pass ?? false,
        score: ctx.contentReadiness?.overallScore ?? 0,
        applied: true,
      },
    };
  },

  5: async function stagePreBuild(ctx) {
    const m = mods();
    const sanitizationCtx = m.createSanitizationContext();
    for (let i = 0; i < ctx.countryAnalyses.length; i++) {
      ctx.countryAnalyses[i] = m.sanitizeTransientKeys(ctx.countryAnalyses[i], sanitizationCtx);
    }
    const failures = [];
    for (const ca of ctx.countryAnalyses) {
      const blocks = m.buildPptGateBlocks(ca);
      const pptGate = m.validatePptData(blocks);
      if (!pptGate.pass) {
        failures.push({
          country: ca.country,
          emptyBlocks: (pptGate.emptyBlocks || []).slice(0, 8),
          chartIssues: (pptGate.chartIssues || []).slice(0, 8),
          nonRenderableGroups: pptGate.nonRenderableGroups || [],
        });
      }
    }
    const structureIssues = m.collectPreRenderStructureIssues(ctx.countryAnalyses);
    const pass = failures.length === 0 && structureIssues.length === 0;
    return {
      data: {
        failures,
        structureIssues,
        sanitization: { droppedKeys: sanitizationCtx.droppedTransientKeyCount || 0 },
      },
      gateResults: {
        pass,
        failureCount: failures.length,
        structureIssueCount: structureIssues.length,
      },
    };
  },

  6: async function stageContentSize(ctx) {
    const m = mods();
    const reports = {};
    for (const ca of ctx.countryAnalyses) {
      const result = m.runContentSizeCheck(ca, { dryRun: true });
      reports[ca.country] = result.report;
    }
    const highRisk = Object.values(reports).some((r) => r.risk === 'high');
    return {
      data: reports,
      gateResults: { pass: !highRisk },
    };
  },

  '6a': async function stageReadabilityRewrite(ctx) {
    const m = mods();
    let anyHighRisk = false;
    for (const ca of ctx.countryAnalyses) {
      const result = m.runContentSizeCheck(ca, { dryRun: true });
      if (result.report.risk === 'high') anyHighRisk = true;
    }
    if (!anyHighRisk) {
      return {
        data: { skipped: true, reason: 'No high-risk content size' },
        gateResults: { pass: true, skipped: true },
      };
    }
    let rewrittenCount = 0;
    for (let i = 0; i < ctx.countryAnalyses.length; i++) {
      const ca = ctx.countryAnalyses[i];
      const sizeResult = m.runContentSizeCheck(ca, { dryRun: true });
      if (sizeResult.report.risk !== 'high') continue;
      const issueLines = [
        ...(sizeResult.report.issues || []).slice(0, 10),
        'Rewrite for slide readability: use shorter clear sentences, keep full meaning.',
      ];
      try {
        const reviewed = await m.reviewCountryAnalysisWithGeminiPro({
          countryAnalysis: ca,
          scope: ctx.scope,
          issues: issueLines,
          attempt: 1,
          maxRetries: 1,
        });
        if (isPlainObject(reviewed)) {
          ctx.countryAnalyses[i] = m.mergeCountryAnalysis(ca, reviewed);
          rewrittenCount++;
        }
      } catch (err) {
        console.warn(`[Stage 6a] Rewrite failed for ${ca.country}: ${err.message}`);
      }
    }
    if (rewrittenCount > 0) {
      const candidate = await m.synthesizeFindings(ctx.countryAnalyses, ctx.scope);
      if (isPlainObject(candidate)) ctx.synthesis = candidate;
    }
    return {
      data: { rewrittenCount },
      gateResults: { pass: true, rewrittenCount },
    };
  },

  7: async function stageBuildPpt(ctx) {
    const m = mods();
    const pptBuffer = await m.generatePPT(ctx.synthesis, ctx.countryAnalyses, ctx.scope);
    if (!Buffer.isBuffer(pptBuffer)) throw new Error('PPT generation returned non-buffer');
    ctx.pptBuffer = pptBuffer;
    ctx.pptMetrics = pptBuffer.__pptMetrics || pptBuffer.pptMetrics || null;
    return {
      data: { sizeBytes: pptBuffer.length, metrics: ctx.pptMetrics },
      binary: { 'deck.pptx': pptBuffer },
      metrics: ctx.pptMetrics,
      // pptInspection used by template-strict-gate (runner checks this)
      pptInspection: ctx.pptMetrics,
    };
  },

  8: async function stageFileSafety(ctx) {
    const m = mods();
    if (!Buffer.isBuffer(ctx.pptBuffer)) throw new Error('No PPT buffer available');
    // Normalize before checking
    const relNorm = await m.normalizeAbsoluteRelationshipTargets(ctx.pptBuffer);
    ctx.pptBuffer = relNorm.buffer;
    const idNorm = await m.normalizeSlideNonVisualIds(ctx.pptBuffer);
    ctx.pptBuffer = idNorm.buffer;
    const ctReconcile = await m.reconcileContentTypesAndPackage(ctx.pptBuffer);
    ctx.pptBuffer = ctReconcile.buffer;
    // Validate
    const { zip } = await m.readPPTX(ctx.pptBuffer);
    const relSafety = await m.scanRelationshipTargets(zip);
    const pkgSafety = await m.scanPackageConsistency(zip);
    const missingTargets = relSafety.missingInternalTargets || [];
    const invalidExternal = relSafety.invalidExternalTargets || [];
    const pass = missingTargets.length === 0 && invalidExternal.length === 0;
    if (!pass) {
      const preview = missingTargets
        .slice(0, 5)
        .map((mt) => `${mt.relFile} -> ${mt.target} (${mt.reason})`)
        .join(' | ');
      throw new Error(`File safety failed: ${missingTargets.length} broken target(s); ${preview}`);
    }
    return {
      data: {
        pass,
        missingTargets: missingTargets.length,
        invalidExternal: invalidExternal.length,
        relNormChanged: relNorm.changed,
        idNormChanged: idNorm.changed,
        ctReconcileChanged: ctReconcile.changed,
      },
      binary: { 'deck.pptx': ctx.pptBuffer },
      gateResults: { pass, missingTargets: missingTargets.length },
    };
  },

  '8a': async function stageFinalReview(ctx) {
    // In fail-fast mode, if stage 8 passes then 8a is a pass-through.
    return {
      data: { note: 'Stage 8 normalized successfully; no additional repair needed' },
      binary: Buffer.isBuffer(ctx.pptBuffer) ? { 'deck.pptx': ctx.pptBuffer } : undefined,
      gateResults: { pass: true, skipped: !Buffer.isBuffer(ctx.pptBuffer) },
    };
  },

  9: async function stageFinal(ctx) {
    const m = mods();
    const country = ctx.scope.targetMarkets[0];
    const industry = ctx.scope.industry;
    const summary = {
      country,
      industry,
      timestamp: new Date().toISOString(),
      totalCost: m.costTracker?.totalCost || 0,
      apiCalls: m.costTracker?.calls?.length || 0,
      pptSizeBytes: ctx.pptBuffer ? ctx.pptBuffer.length : 0,
      contentReadiness: ctx.contentReadiness
        ? { pass: ctx.contentReadiness.pass, score: ctx.contentReadiness.overallScore }
        : null,
    };
    return {
      data: summary,
      binary: Buffer.isBuffer(ctx.pptBuffer) ? { 'final.pptx': ctx.pptBuffer } : undefined,
    };
  },
};

// ── Execute a single stage ───────────────────────────────────────────────────
async function executeStage(stageName, context, _opts) {
  const handler = HANDLERS[stageName];
  if (!handler) throw new Error(`Unknown stage: ${stageName}`);
  const def = STAGES[stageName];
  console.log(`[stage-controller] Executing: ${def?.label || stageName} (stage ${stageName})`);
  return handler(context, _opts);
}

// ── Load accumulated context from completed stage artifacts ──────────────────
async function loadStageContext(runId, dbPath, { country, industry, clientContext }) {
  const context = {
    scope: {
      targetMarkets: [country],
      industry,
      clientContext: clientContext || '',
    },
    countryAnalyses: null,
    synthesis: null,
    contentReadiness: null,
    pptBuffer: null,
    pptMetrics: null,
  };

  const { openDb } = require('../storage/db');
  const db = openDb(dbPath);
  const completedRows = db
    .prepare(
      `SELECT DISTINCT stage FROM stage_attempts WHERE run_id = ? AND status = 'completed' ORDER BY id`
    )
    .all(runId);
  const completed = completedRows.map((r) => r.stage);

  for (const stage of completed) {
    // Find the latest successful attempt
    const latest = db
      .prepare(
        `SELECT attempt FROM stage_attempts WHERE run_id = ? AND stage = ? AND status = 'completed' ORDER BY attempt DESC LIMIT 1`
      )
      .get(runId, stage);
    if (!latest) continue;

    const dir = attemptDir(runId, stage, latest.attempt);
    const outputPath = path.join(dir, 'output.json');
    if (!fs.existsSync(outputPath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      switch (stage) {
        case '2':
        case '2a':
          if (raw && !raw._binary) context.countryAnalyses = [raw];
          break;
        case '3':
        case '3a':
        case '4a':
        case '6a':
          if (isPlainObject(raw) && !raw.skipped) context.synthesis = raw;
          break;
        case '4':
          context.contentReadiness = raw;
          break;
        case '7':
        case '8':
        case '8a': {
          // Check for binary PPT
          const pptPath = path.join(dir, 'deck.pptx');
          if (fs.existsSync(pptPath)) context.pptBuffer = fs.readFileSync(pptPath);
          break;
        }
      }
    } catch (_err) {
      // Ignore corrupt artifacts
    }
  }

  return context;
}

module.exports = {
  STAGE_ORDER,
  HANDLERS,
  executeStage,
  loadStageContext,
};
