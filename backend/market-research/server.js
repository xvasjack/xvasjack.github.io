// Redeploy trigger: 2026-02-05
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { securityHeaders, rateLimiter, escapeHtml } = require('./shared/security');
const { requestLogger, healthCheck } = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { createTracker, trackingContext } = require('./shared/tracking');

// Extracted modules
const {
  costTracker,
  callGemini,
  callGeminiResearch,
  callGeminiPro,
  resetBudget,
} = require('./ai-clients');
const { readRequestType } = require('./research-framework');
const { researchCountry, synthesizeFindings } = require('./research-engine');
const { generatePPT } = require('./deck-builder');
const {
  validateResearchQuality,
  validateSynthesisQuality,
  validatePptData,
} = require('./content-gates');
const { checkContentReadiness } = require('./content-quality-check');
const { checkStoryFlow } = require('./story-flow-check');
const {
  validatePPTX,
  readPPTX,
  extractAllText,
  scanRelationshipTargets,
  scanPackageConsistency,
  normalizeAbsoluteRelationshipTargets,
  normalizeSlideNonVisualIds,
  reconcileContentTypesAndPackage,
} = require('./deck-file-check');
const { runContentSizeCheck } = require('./content-size-check');
const { SYSTEM_MAP } = require('./system-map');
const {
  isTransientKey,
  sanitizeTransientKeys,
  createSanitizationContext,
  logSanitizationResult,
} = require('./cleanup-temp-fields');

// Setup global error handlers to prevent crashes
setupGlobalErrorHandlers({
  logMemory: false,
  // Fail fast on uncaught exceptions so Railway does not keep an unhealthy idle process.
  exitOnUncaughtException: true,
});

// ============ EXPRESS SETUP ============
const app = express();
const BUILD_COMMIT =
  process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT || process.env.GITHUB_SHA;

// Health check must stay middleware-light so platform probes never depend on
// rate limits, auth headers, or request-body parsing.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'market-research',
    timestamp: new Date().toISOString(),
    costToday: costTracker.totalCost,
    commit: BUILD_COMMIT || null,
  });
});

app.set('trust proxy', 1); // Trust Railway's reverse proxy for rate limiting
app.use(securityHeaders);
app.use(rateLimiter);
app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));

// Check required environment variables
const requiredEnvVars = ['GEMINI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}

// ============ EMAIL DELIVERY ============
// Fix 4: Use shared sendEmail with 3 retries + exponential backoff (was inline with zero retries)
const { sendEmail } = require('./shared/email.js');

// Pipeline runInfo — stored after each run, exposed via /api/runInfo
let lastRunRunInfo = null;
// Latest generated PPT artifact for operational QA download.
let lastGeneratedPpt = null;

const BOOLEAN_TRUE_LITERALS = new Set(['1', 'true', 'yes', 'y', 'on']);
const BOOLEAN_FALSE_LITERALS = new Set(['0', 'false', 'no', 'n', 'off']);

function parseBooleanOption(value, fallback = null) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return fallback;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return fallback;
    if (BOOLEAN_TRUE_LITERALS.has(normalized)) return true;
    if (BOOLEAN_FALSE_LITERALS.has(normalized)) return false;
  }
  return fallback;
}

function parseNonNegativeIntEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

const ALLOW_DRAFT_PPT_MODE = parseBooleanOption(process.env.ALLOW_DRAFT_PPT_MODE, false) === true;
// Content-first mode keeps full narrative depth by default.
// Set CONTENT_FIRST_MODE=false if you want legacy hard blocking/compaction behavior.
const CONTENT_FIRST_MODE = parseBooleanOption(process.env.CONTENT_FIRST_MODE, true) !== false;
const DISABLE_PIPELINE_TIMEOUT =
  parseBooleanOption(process.env.DISABLE_PIPELINE_TIMEOUT, true) !== false;
// Timeout is disabled by default to avoid auto-closing long market-research runs.
// Re-enable by setting DISABLE_PIPELINE_TIMEOUT=false and PIPELINE_TIMEOUT_SECONDS>0.
const PIPELINE_TIMEOUT_MS = DISABLE_PIPELINE_TIMEOUT
  ? 0
  : parseNonNegativeIntEnv('PIPELINE_TIMEOUT_SECONDS', 45 * 60) * 1000;
// Transient key detection delegated to ./cleanup-temp-fields.js (canonical module).

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripCodeFence(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('```')) return raw;
  return raw
    .replace(/```json?\n?/gi, '')
    .replace(/```/g, '')
    .trim();
}

function parseJsonObjectFromModelText(text) {
  const cleaned = stripCodeFence(text);
  try {
    const parsed = JSON.parse(cleaned);
    return isPlainObject(parsed) ? parsed : null;
  } catch (_) {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
        return isPlainObject(parsed) ? parsed : null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

async function improveSynthesisWithGeminiPro({
  synthesis,
  scope,
  contentReadiness,
  attempt,
  maxRetries,
}) {
  const country = Array.isArray(scope?.targetMarkets) ? scope.targetMarkets[0] : 'target country';
  const failedSections = Array.isArray(contentReadiness?.sectionScorecard)
    ? contentReadiness.sectionScorecard
        .filter((s) => !s.pass)
        .map((s) => `${s.section}(${s.score})`)
        .slice(0, 8)
    : [];
  const improvementActions = Array.isArray(contentReadiness?.improvementActions)
    ? contentReadiness.improvementActions.slice(0, 10)
    : [];

  const systemPrompt = `You are a senior strategy reviewer improving one-country market research synthesis.
Return ONLY valid JSON object.
Keep the same top-level structure and field names as the input.
Do not return markdown.`;

  const prompt = `Country: ${country}
Industry: ${scope?.industry || 'unknown'}
Attempt: ${attempt}/${maxRetries}

Current score: ${contentReadiness?.overallScore || 0}/${contentReadiness?.threshold || 80}
Failed sections: ${failedSections.join(', ') || 'unknown'}
Must fix:
${improvementActions.join('\n') || '- Improve depth, evidence, actionability, and story flow'}

Rules:
1) Keep all existing factual content unless it is clearly contradictory.
2) Add missing evidence, numbers, specific company names, causal logic, and actions.
3) Strengthen recommendation quality with clear go/no-go reasoning.
4) Output one JSON object only.

Current synthesis JSON:
${JSON.stringify(synthesis, null, 2)}`;

  const responseText = await callGeminiPro(prompt, {
    systemPrompt,
    temperature: 0.1,
    maxTokens: 12000,
    timeout: 120000,
    maxRetries: 2,
  });

  return parseJsonObjectFromModelText(responseText);
}

const CORE_COUNTRY_SECTIONS = ['policy', 'market', 'competitors', 'depth', 'summary', 'insights'];

function mergeCountryAnalysis(base, patch) {
  const merged = { ...(isPlainObject(base) ? base : {}) };
  if (!isPlainObject(patch)) return merged;
  for (const section of CORE_COUNTRY_SECTIONS) {
    const candidate = patch[section];
    if (
      candidate &&
      (isPlainObject(candidate) || Array.isArray(candidate) || typeof candidate === 'string')
    ) {
      merged[section] = candidate;
    }
  }
  if (typeof patch.readyForClient === 'boolean') merged.readyForClient = patch.readyForClient;
  if (isPlainObject(patch.readiness)) merged.readiness = patch.readiness;
  if (Number.isFinite(Number(patch.finalConfidenceScore))) {
    merged.finalConfidenceScore = Number(patch.finalConfidenceScore);
  }
  if (typeof merged.country !== 'string' || !merged.country.trim()) {
    merged.country = String(base?.country || patch.country || 'Unknown');
  }
  if (base && base.rawData && !merged.rawData) merged.rawData = base.rawData;
  return merged;
}

function countryNeedsReview(countryAnalysis) {
  if (!isPlainObject(countryAnalysis)) return true;
  if (countryAnalysis.readyForClient === false) return true;
  for (const key of ['policy', 'market', 'competitors', 'depth', 'summary']) {
    if (!isPlainObject(countryAnalysis[key])) return true;
  }
  return false;
}

async function reviewCountryAnalysisWithGeminiPro({
  countryAnalysis,
  scope,
  issues,
  attempt,
  maxRetries,
}) {
  const systemPrompt = `You are a senior reviewer improving one-country market analysis JSON.
Return ONLY valid JSON object.
Keep structure stable with sections: policy, market, competitors, depth, summary, insights.`;

  const prompt = `Attempt: ${attempt}/${maxRetries}
Country: ${countryAnalysis?.country || (scope?.targetMarkets || [])[0] || 'unknown'}
Industry: ${scope?.industry || 'unknown'}
Problems to fix:
${Array.isArray(issues) && issues.length > 0 ? issues.join('\n') : '- improve depth and structure'}

Rules:
1) Keep existing valid facts.
2) Fill missing sections with concrete, useful content.
3) Strengthen recommendation clarity and actionability.
4) Keep strategic depth: preserve key numbers, years, company names, and causal logic.
5) If any issue mentions readability/length, tighten wording by removing filler, not facts.
6) Do not add placeholder text (for example: "data unavailable", "pending", "TBD").
7) Output one JSON object only.

Current country analysis JSON:
${JSON.stringify(countryAnalysis, null, 2)}`;

  const responseText = await callGeminiPro(prompt, {
    systemPrompt,
    temperature: 0.1,
    maxTokens: 12000,
    timeout: 120000,
    maxRetries: 2,
  });
  return parseJsonObjectFromModelText(responseText);
}

async function improveSynthesisQualityWithGeminiPro({
  synthesis,
  scope,
  synthesisGate,
  attempt,
  maxRetries,
}) {
  const systemPrompt = `You are a senior reviewer improving one-country synthesis quality.
Return ONLY valid JSON object.
Keep the same top-level structure as input.`;

  const failures = Array.isArray(synthesisGate?.failures)
    ? synthesisGate.failures.slice(0, 12)
    : [];
  const prompt = `Attempt: ${attempt}/${maxRetries}
Industry: ${scope?.industry || 'unknown'}
Country: ${(scope?.targetMarkets || [])[0] || 'unknown'}
Current synthesis quality score: ${Number(synthesisGate?.overall || 0)}/100
Problems to fix:
${failures.length > 0 ? failures.join('\n') : '- improve evidence and structure quality'}

Rules:
1) Keep existing valid facts unless contradictory.
2) Add concrete evidence and specifics where weak.
3) Ensure all expected sections are usable for slides.
4) Output one JSON object only.

Current synthesis JSON:
${JSON.stringify(synthesis, null, 2)}`;

  const responseText = await callGeminiPro(prompt, {
    systemPrompt,
    temperature: 0.1,
    maxTokens: 12000,
    timeout: 120000,
    maxRetries: 2,
  });
  return parseJsonObjectFromModelText(responseText);
}

function buildPptCheckExpectations(scope) {
  const expectations = {
    minFileSize: 120 * 1024,
    minSlides: 12,
    minCharts: 1,
    minTables: 3,
    requireInsights: true,
    noEmptySlides: true,
    maxSuspiciousEllipsis: 0,
    maxTotalEllipsis: 30,
    forbiddenText: [
      '[truncated]',
      'insufficient research data',
      'analysis pending additional research',
      'synthesis failed',
    ],
  };
  if (Array.isArray(scope?.targetMarkets) && scope.targetMarkets.length === 1) {
    // Single-country runs should visibly mention the target country in the deck.
    expectations.requiredText = [scope.targetMarkets[0]];
  }
  return expectations;
}

function buildPptStructureSummary(pptStructureCheck) {
  if (!pptStructureCheck || typeof pptStructureCheck !== 'object') return null;
  return {
    valid: pptStructureCheck.valid,
    passed: pptStructureCheck.summary?.passed || 0,
    failed: pptStructureCheck.summary?.failed || 0,
    warnings: pptStructureCheck.summary?.warnings || 0,
    failedChecks: (pptStructureCheck.failed || []).slice(0, 10),
    warningChecks: (pptStructureCheck.warnings || []).slice(0, 10),
  };
}

const OWNER_STAGE_ORDER = ['2', '2a', '3a', '5a', '6', '8', '9'];

function defaultOwnerStage(sourceStage = '') {
  const stage = String(sourceStage || '');
  if (stage.startsWith('2')) return '2a';
  if (stage.startsWith('3')) return '3a';
  if (stage.startsWith('5')) return '5a';
  if (stage.startsWith('6')) return '6';
  if (stage.startsWith('7')) return '5a';
  if (stage.startsWith('8')) return '8';
  if (stage.startsWith('9')) return '9';
  return '5a';
}

function inferOwnerStageFromText(text, sourceStage = '') {
  const t = String(text || '').toLowerCase();
  if (
    t.includes('missing section') ||
    t.includes('missing/invalid section') ||
    t.includes('no data') ||
    t.includes('need >=') ||
    t.includes('only ') ||
    t.includes('missing requirements detail') ||
    t.includes('add content')
  ) {
    return '2a';
  }
  if (
    t.includes('contradiction') ||
    t.includes('coherence') ||
    t.includes('storyline') ||
    t.includes('timeline') ||
    t.includes('inconsistent') ||
    t.includes('logic')
  ) {
    return '3a';
  }
  if (
    t.includes('insight') ||
    t.includes('actionability') ||
    t.includes('recommend') ||
    t.includes('shallow') ||
    t.includes('evidence') ||
    t.includes('readiness') ||
    t.includes('quality') ||
    t.includes('confidence')
  ) {
    return '5a';
  }
  if (
    t.includes('shape') ||
    t.includes('must be an object') ||
    t.includes('not-buildable') ||
    t.includes('empty blocks') ||
    t.includes('chart issues') ||
    t.includes('groups=')
  ) {
    return '6';
  }
  if (
    t.includes('build attempt') ||
    t.includes('ppt build failed') ||
    t.includes('slide building') ||
    t.includes('generate ppt')
  ) {
    return '8';
  }
  if (
    t.includes('file safety') ||
    t.includes('package consistency') ||
    t.includes('content-type') ||
    t.includes('relationship') ||
    t.includes('formatting') ||
    t.includes('style match') ||
    t.includes('structural check')
  ) {
    return '9';
  }
  return defaultOwnerStage(sourceStage);
}

function makeStageIssue({
  type = 'general',
  severity = 'medium',
  message = '',
  ownerStage = '5a',
  sourceStage = 'unknown',
}) {
  return {
    type: String(type || 'general'),
    severity: String(severity || 'medium'),
    message: String(message || ''),
    ownerStage: String(ownerStage || '5a'),
    sourceStage: String(sourceStage || 'unknown'),
  };
}

function buildStageIssuesFromMessages(
  messages,
  { sourceStage = 'unknown', type = 'general', severity = 'medium' } = {}
) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const raw of messages) {
    const msg = String(raw || '').trim();
    if (!msg) continue;
    out.push(
      makeStageIssue({
        type,
        severity,
        message: msg,
        ownerStage: inferOwnerStageFromText(msg, sourceStage),
        sourceStage,
      })
    );
  }
  return out;
}

function pickOwnerStage(stageIssues, fallbackStage = '5a') {
  if (!Array.isArray(stageIssues) || stageIssues.length === 0) {
    return defaultOwnerStage(fallbackStage);
  }
  let best = defaultOwnerStage(fallbackStage);
  let bestRank = OWNER_STAGE_ORDER.indexOf(best);
  for (const issue of stageIssues) {
    const owner = String(issue?.ownerStage || '').trim() || defaultOwnerStage(fallbackStage);
    const rank = OWNER_STAGE_ORDER.indexOf(owner);
    if (rank >= 0 && (bestRank < 0 || rank < bestRank)) {
      best = owner;
      bestRank = rank;
    }
  }
  return best;
}

const MCKINSEY_SLIDE_GUIDE = `
Use these slide-quality rules:
1) One clear message per slide.
2) Title should state the answer, not just topic.
3) Story should flow top-down: context -> finding -> implication -> action.
4) Every key claim should be backed by evidence (number, source, or concrete example).
5) Recommendations should be specific, practical, and decision-useful.
6) Avoid clutter; prioritize what matters for decision making.
`;

function canRunBinary(command, args = ['--version']) {
  try {
    const result = spawnSync(command, args, {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return !result.error;
  } catch (_) {
    return false;
  }
}

function runBinaryOrThrow(command, args, timeout = 240000) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${command} not available: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || `exit=${result.status}`).trim();
    throw new Error(`${command} failed: ${details.slice(0, 240)}`);
  }
}

function safeDeleteFolder(folder) {
  try {
    if (folder && fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  } catch (_) {
    // Ignore cleanup errors.
  }
}

function buildFinalReviewImages(pptBuffer, maxSlides = 6) {
  const fallback = {
    imageParts: [],
    inputMode: 'text_summary_only',
    notes: [],
  };

  if (!Buffer.isBuffer(pptBuffer) || pptBuffer.length === 0) {
    fallback.notes.push('deck file not available for screenshots');
    return fallback;
  }

  const officeBinary = canRunBinary('libreoffice')
    ? 'libreoffice'
    : canRunBinary('soffice')
      ? 'soffice'
      : null;
  const hasPdfToPng = canRunBinary('pdftoppm');
  if (!officeBinary || !hasPdfToPng) {
    fallback.notes.push('screenshot tools missing (need libreoffice/soffice and pdftoppm)');
    return fallback;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-final-review-'));
  try {
    const pptxPath = path.join(tempDir, 'deck.pptx');
    fs.writeFileSync(pptxPath, pptBuffer);

    runBinaryOrThrow(
      officeBinary,
      ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, pptxPath],
      300000
    );

    const pdfFiles = fs.readdirSync(tempDir).filter((name) => /\.pdf$/i.test(name));
    if (pdfFiles.length === 0) {
      throw new Error('no PDF was generated from deck file');
    }
    const pdfPath = path.join(tempDir, pdfFiles[0]);
    const outputPrefix = path.join(tempDir, 'slide');

    runBinaryOrThrow(
      'pdftoppm',
      ['-png', '-f', '1', '-l', String(Math.max(1, maxSlides)), pdfPath, outputPrefix],
      300000
    );

    const slidePngs = fs
      .readdirSync(tempDir)
      .filter((name) => /^slide-\d+\.png$/i.test(name))
      .sort((a, b) => {
        const aNum = Number(String(a).match(/(\d+)/)?.[1] || 0);
        const bNum = Number(String(b).match(/(\d+)/)?.[1] || 0);
        return aNum - bNum;
      });

    const imageParts = [];
    for (const fileName of slidePngs.slice(0, Math.max(1, maxSlides))) {
      const filePath = path.join(tempDir, fileName);
      const base64 = fs.readFileSync(filePath).toString('base64');
      if (!base64) continue;
      imageParts.push({
        mimeType: 'image/png',
        data: base64,
      });
    }

    if (imageParts.length === 0) {
      fallback.notes.push('no screenshot files found after conversion');
      return fallback;
    }

    return {
      imageParts,
      inputMode: 'slide_screenshots_plus_text',
      notes: [`attached ${imageParts.length} slide screenshot(s)`],
    };
  } catch (error) {
    fallback.notes.push(`screenshot fallback: ${error.message}`);
    return fallback;
  } finally {
    safeDeleteFolder(tempDir);
  }
}

async function buildFinalReviewTextFallback(pptBuffer, maxSlides = 6) {
  if (!Buffer.isBuffer(pptBuffer) || pptBuffer.length === 0) {
    return [];
  }

  try {
    const { zip } = await readPPTX(pptBuffer);
    const textData = await extractAllText(zip);
    const cap = Math.max(1, Math.min(Number(maxSlides) || 6, 10));
    const slides = Array.isArray(textData?.slides) ? textData.slides : [];
    return slides
      .slice(0, cap)
      .map((slide) => {
        const fullText = String(slide?.fullText || '')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          slide: Number(slide?.slideNum || 0),
          chars: Number(slide?.charCount || 0),
          text: fullText.slice(0, 500),
        };
      })
      .filter((x) => x.slide > 0 && x.text);
  } catch (error) {
    return [
      {
        slide: 0,
        chars: 0,
        text: `slide text fallback failed: ${error.message}`,
      },
    ];
  }
}

async function reviewDeckBeforeDeliveryWithGeminiFlash({
  scope,
  runInfo,
  synthesis,
  reviewHistory = [],
  attempt,
  maxRetries,
  imageParts = [],
  slideTextFallback = [],
  inputMode = 'text_summary_only',
  inputNotes = [],
}) {
  const country = (scope?.targetMarkets || [])[0] || 'unknown';
  const summary = {
    country,
    industry: scope?.industry || 'unknown',
    contentCheck: {
      pass: Boolean(runInfo?.contentReadiness?.pass),
      overallScore: Number(runInfo?.contentReadiness?.overallScore || 0),
      threshold: Number(runInfo?.contentReadiness?.threshold || 80),
      shallowSections: Array.isArray(runInfo?.contentReadiness?.shallowSections)
        ? runInfo.contentReadiness.shallowSections.slice(0, 8)
        : [],
      contradictions: Number(runInfo?.contentReadiness?.contradictions || 0),
    },
    contentSizeCheck: runInfo?.contentSizeCheck || null,
    ppt: runInfo?.ppt || null,
    pptStructure: runInfo?.pptStructure || null,
    stage9Attempts: Array.isArray(runInfo?.stage9Attempts) ? runInfo.stage9Attempts.slice(-3) : [],
    formattingWarnings: Array.isArray(runInfo?.formattingWarnings)
      ? runInfo.formattingWarnings.slice(0, 10)
      : [],
    priorRounds: Array.isArray(reviewHistory)
      ? reviewHistory.slice(-4).map((r) => ({
          round: r.round,
          ready: r.ready,
          issues: (r.issues || []).slice(0, 6),
          actions: (r.actions || []).slice(0, 6),
          lockedDecisions: (r.lockedDecisions || []).slice(0, 6),
        }))
      : [],
    finalReviewInput: {
      mode: inputMode,
      screenshots: Array.isArray(imageParts) ? imageParts.length : 0,
      slideTextFallback: Array.isArray(slideTextFallback)
        ? slideTextFallback.slice(0, 8).map((x) => ({
            slide: Number(x?.slide || 0),
            chars: Number(x?.chars || 0),
            text: String(x?.text || '').slice(0, 500),
          }))
        : [],
      notes: Array.isArray(inputNotes) ? inputNotes.slice(0, 6) : [],
    },
  };

  const systemPrompt = `You are a final deck reviewer for one-country market research.
Use McKinsey-style slide quality standards.
Decide if the deck is ready to send to a client team.
Return ONLY valid JSON.`;

  // Build locked-decisions history from prior rounds to reinforce anti-flip-flop.
  const priorLockedDecisions = [];
  if (Array.isArray(summary.priorRounds)) {
    for (const round of summary.priorRounds) {
      if (Array.isArray(round?.lockedDecisions)) {
        for (const d of round.lockedDecisions) {
          const t = String(d || '').trim();
          if (t) priorLockedDecisions.push(t);
        }
      }
    }
  }
  const lockedSection =
    priorLockedDecisions.length > 0
      ? `\nLocked decisions from prior rounds (DO NOT reverse these):\n${[
          ...new Set(priorLockedDecisions),
        ]
          .slice(0, 20)
          .map((d) => `- ${d}`)
          .join('\n')}\n`
      : '';

  // Adjust guidance based on whether screenshots are available.
  let inputGuidance = '';
  if (inputMode === 'slide_screenshots_plus_text') {
    inputGuidance =
      '6) Slide screenshots are attached. Use what you see in the screenshots as the main quality signal.';
  } else if (inputMode === 'content_review_only') {
    inputGuidance =
      '6) No slide screenshots or text fallback available. Review the SYNTHESIS CONTENT ONLY for completeness, clarity, evidence quality, and story flow. Do NOT flag visual/formatting issues since you cannot see the slides. Focus on: missing data, weak claims, logical gaps, actionability.';
  } else {
    inputGuidance =
      '6) Screenshots are not attached. Use "slideTextFallback" text extracts as the main quality signal. Do NOT flag visual formatting issues you cannot verify from text alone.';
  }

  const prompt = `Attempt: ${attempt}/${maxRetries}
Review this run summary and synthesis, then decide readiness.

Rules:
1) ready=true only if the deck is safe to deliver now. Be pragmatic: minor polish issues should NOT block delivery.
2) If there are blocking issues, set ready=false and list concrete issues and concrete edits.
3) Keep issues/actions short and practical. Maximum 5 issues and 5 actions.
4) CRITICAL: Do NOT flip-flop. Do NOT reverse prior accepted decisions or locked decisions. If a prior round fixed something and locked it, do NOT ask to change it back.
5) Output one JSON object only.
${inputGuidance}
7) If this is attempt 2+, focus ONLY on issues that were NOT already addressed in prior rounds. Do not re-raise issues that were already fixed.
8) Issues that have been raised and attempted multiple times should be accepted as-is. Perfectionism should not block delivery.
${lockedSection}
McKinsey-style guide:
${MCKINSEY_SLIDE_GUIDE}

Return JSON schema:
{
  "ready": boolean,
  "confidence": number,
  "issues": string[],
  "actions": string[],
  "lockedDecisions": string[]
}

Run summary JSON:
${JSON.stringify(summary, null, 2)}

Current synthesis JSON:
${JSON.stringify(synthesis, null, 2)}`;

  const responseText = await callGemini(prompt, {
    systemPrompt,
    temperature: 0.1,
    maxTokens: 4000,
    timeout: 120000,
    maxRetries: 2,
    imageParts: Array.isArray(imageParts) ? imageParts.slice(0, 8) : [],
  });
  const parsed = parseJsonObjectFromModelText(responseText);
  if (!isPlainObject(parsed)) return null;
  return {
    ready: parsed.ready === true,
    confidence: Number(parsed.confidence || 0),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map((x) => String(x)).slice(0, 12) : [],
    actions: Array.isArray(parsed.actions) ? parsed.actions.map((x) => String(x)).slice(0, 12) : [],
    lockedDecisions: Array.isArray(parsed.lockedDecisions)
      ? parsed.lockedDecisions.map((x) => String(x)).slice(0, 20)
      : [],
  };
}

async function applySlideReviewChangesWithGeminiFlash({
  synthesis,
  scope,
  review,
  reviewHistory = [],
  round,
  maxRounds,
}) {
  const lockedFromHistory = [];
  for (const item of reviewHistory.slice(-4)) {
    if (Array.isArray(item?.lockedDecisions)) {
      for (const decision of item.lockedDecisions) {
        const text = String(decision || '').trim();
        if (text) lockedFromHistory.push(text);
      }
    }
  }
  const lockedUnique = [...new Set(lockedFromHistory)].slice(0, 20);
  const currentLocks = Array.isArray(review?.lockedDecisions)
    ? review.lockedDecisions
        .map((x) => String(x))
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const allLocks = [...new Set([...lockedUnique, ...currentLocks])].slice(0, 25);

  const systemPrompt = `You improve one-country market research synthesis using reviewer comments.
Return ONLY valid JSON object.
Keep top-level structure stable.`;

  const prompt = `Round: ${round}/${maxRounds}
Country: ${(scope?.targetMarkets || [])[0] || 'unknown'}
Industry: ${scope?.industry || 'unknown'}

Reviewer issues:
${Array.isArray(review?.issues) && review.issues.length > 0 ? review.issues.join('\n') : '- none'}

Reviewer actions:
${Array.isArray(review?.actions) && review.actions.length > 0 ? review.actions.join('\n') : '- none'}

Locked decisions from earlier rounds (do not reverse unless clearly wrong):
${allLocks.length > 0 ? allLocks.join('\n') : '- none'}

Rules:
1) Improve clarity, evidence, story flow, and actionability.
2) Keep valid facts; do not invent unsupported facts.
3) Avoid flip-flop with prior accepted decisions.
4) Return JSON object:
{
  "synthesis": { ...updated synthesis... },
  "changeSummary": string[],
  "lockedDecisions": string[]
}

Current synthesis JSON:
${JSON.stringify(synthesis, null, 2)}`;

  const responseText = await callGemini(prompt, {
    systemPrompt,
    temperature: 0.1,
    maxTokens: 12000,
    timeout: 120000,
    maxRetries: 2,
  });
  const parsed = parseJsonObjectFromModelText(responseText);
  if (!isPlainObject(parsed)) return null;
  const nextSynthesis = isPlainObject(parsed.synthesis) ? parsed.synthesis : null;
  if (!nextSynthesis) return null;
  return {
    synthesis: nextSynthesis,
    changeSummary: Array.isArray(parsed.changeSummary)
      ? parsed.changeSummary.map((x) => String(x)).slice(0, 20)
      : [],
    lockedDecisions: Array.isArray(parsed.lockedDecisions)
      ? parsed.lockedDecisions.map((x) => String(x)).slice(0, 20)
      : [],
  };
}

function collectGateTextFragments(value, out = [], depth = 0) {
  if (out.length >= 40 || depth > 6 || value == null) return out;

  if (typeof value === 'string') {
    const s = value.trim();
    if (s) out.push(s);
    return out;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      collectGateTextFragments(item, out, depth + 1);
      if (out.length >= 40) break;
    }
    return out;
  }

  if (typeof value !== 'object') return out;

  const skipKeys = new Set([
    'chartData',
    'charts',
    'sources',
    'citations',
    '_synthesisError',
    '_wasArray',
    '_meta',
  ]);

  for (const [key, child] of Object.entries(value)) {
    if (out.length >= 40) break;
    if (skipKeys.has(key) || String(key).startsWith('_')) continue;
    collectGateTextFragments(child, out, depth + 1);
  }

  return out;
}

function findGateChartData(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findGateChartData(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (value.chartData && typeof value.chartData === 'object') return value.chartData;
  for (const child of Object.values(value)) {
    const hit = findGateChartData(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function flattenGateSeriesValues(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out;
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenGateSeriesValues(item, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;
  if (typeof value.value === 'number' && Number.isFinite(value.value)) out.push(value.value);
  if (typeof value.y === 'number' && Number.isFinite(value.y)) out.push(value.y);
  if (Array.isArray(value.data)) flattenGateSeriesValues(value.data, out, depth + 1);
  if (Array.isArray(value.values)) flattenGateSeriesValues(value.values, out, depth + 1);
  if (Array.isArray(value.series)) flattenGateSeriesValues(value.series, out, depth + 1);
  return out;
}

function normalizeGateChartData(section) {
  const chartData = findGateChartData(section);
  if (!chartData || typeof chartData !== 'object' || !Array.isArray(chartData.series)) {
    return null;
  }
  const numericValues = flattenGateSeriesValues(chartData.series, []).filter(
    (v) => typeof v === 'number' && Number.isFinite(v)
  );
  // Section-level pre-gate should only enforce charts when enough points exist to validate.
  if (numericValues.length < 4) return null;
  return chartData;
}

function buildGateContent(fragments) {
  if (!Array.isArray(fragments) || fragments.length === 0) return '';
  const MAX_TOTAL_CHARS = 560;
  const MAX_FRAGMENT_CHARS = 160;
  const picked = [];
  let total = 0;

  for (const raw of fragments) {
    let text = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    if (text.length > MAX_FRAGMENT_CHARS) {
      text = `${text.slice(0, MAX_FRAGMENT_CHARS - 3).trimEnd()}...`;
    }
    const separator = picked.length > 0 ? 1 : 0;
    const remaining = MAX_TOTAL_CHARS - total - separator;
    if (remaining <= 0) break;
    if (text.length > remaining) {
      if (remaining > 24) picked.push(`${text.slice(0, remaining - 3).trimEnd()}...`);
      break;
    }
    picked.push(text);
    total += text.length + separator;
  }

  return picked.join(' ');
}

function buildPptGateBlocks(countryAnalysis) {
  const sections = ['policy', 'market', 'competitors', 'depth', 'insights', 'summary'];
  const blocks = [];

  for (const key of sections) {
    const section = countryAnalysis?.[key];
    if (!section) continue;

    const fragments = collectGateTextFragments(section, []);
    const uniqueFragments = [];
    const seen = new Set();
    for (const fragment of fragments) {
      const normalized = String(fragment).toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      uniqueFragments.push(fragment);
      if (uniqueFragments.length >= 18) break;
    }

    blocks.push({
      key,
      type: typeof section === 'object' ? 'section' : 'value',
      title: key,
      content: buildGateContent(uniqueFragments),
      chartData: normalizeGateChartData(section),
    });
  }

  return blocks;
}

// Sanitization happens BEFORE this function via sanitizeTransientKeys().
// Keep this check intentionally minimal: only block clearly broken shapes that
// would cause build or runtime issues.
function collectPreRenderStructureIssues(countryAnalyses) {
  const issues = [];
  const requiredObjectSections = ['policy', 'market', 'competitors', 'depth', 'summary'];
  for (const ca of countryAnalyses || []) {
    const country = String(ca?.country || '').trim() || 'Unknown';
    const countryPrefix = `${country}:`;
    if (!country || country === 'Unknown') {
      issues.push(`${countryPrefix} missing country name`);
    }
    for (const section of requiredObjectSections) {
      if (!isPlainObject(ca?.[section])) {
        issues.push(`${countryPrefix} section "${section}" must be an object`);
      }
    }
  }
  return issues;
}

function collectPptPackageIssues(packageConsistency) {
  const issues = [];
  if (
    Array.isArray(packageConsistency?.missingCriticalParts) &&
    packageConsistency.missingCriticalParts.length > 0
  ) {
    issues.push(`missing critical parts: ${packageConsistency.missingCriticalParts.join(', ')}`);
  }
  if (
    Array.isArray(packageConsistency?.duplicateRelationshipIds) &&
    packageConsistency.duplicateRelationshipIds.length > 0
  ) {
    const preview = packageConsistency.duplicateRelationshipIds
      .slice(0, 5)
      .map((x) => `${x.relFile}:${x.relId}`)
      .join(', ');
    issues.push(`duplicate relationship ids: ${preview}`);
  }
  if (
    Array.isArray(packageConsistency?.duplicateSlideIds) &&
    packageConsistency.duplicateSlideIds.length > 0
  ) {
    issues.push(
      `duplicate slide ids: ${packageConsistency.duplicateSlideIds.slice(0, 5).join(', ')}`
    );
  }
  if (
    Array.isArray(packageConsistency?.duplicateSlideRelIds) &&
    packageConsistency.duplicateSlideRelIds.length > 0
  ) {
    issues.push(
      `duplicate slide rel ids: ${packageConsistency.duplicateSlideRelIds.slice(0, 5).join(', ')}`
    );
  }
  if (
    Array.isArray(packageConsistency?.missingRelationshipReferences) &&
    packageConsistency.missingRelationshipReferences.length > 0
  ) {
    const preview = packageConsistency.missingRelationshipReferences
      .slice(0, 5)
      .map((x) => `${x.ownerPart}:${x.relId}`)
      .join(', ');
    issues.push(`dangling xml relationship refs: ${preview}`);
  }
  if (
    Array.isArray(packageConsistency?.duplicateNonVisualShapeIds) &&
    packageConsistency.duplicateNonVisualShapeIds.length > 0
  ) {
    const preview = packageConsistency.duplicateNonVisualShapeIds
      .slice(0, 5)
      .map((x) => `${x.slide}:id=${x.id}(x${x.count})`)
      .join(', ');
    issues.push(`duplicate non-visual shape ids: ${preview}`);
  }
  if (
    Array.isArray(packageConsistency?.danglingOverrides) &&
    packageConsistency.danglingOverrides.length > 0
  ) {
    issues.push(
      `dangling content-type overrides: ${packageConsistency.danglingOverrides.slice(0, 5).join(', ')}`
    );
  }
  if (
    Array.isArray(packageConsistency?.missingExpectedOverrides) &&
    packageConsistency.missingExpectedOverrides.length > 0
  ) {
    const preview = packageConsistency.missingExpectedOverrides
      .slice(0, 5)
      .map((x) =>
        x && typeof x === 'object'
          ? `${x.part || '(unknown)'}${x.expectedContentType ? `->${x.expectedContentType}` : ''}`
          : String(x)
      )
      .join(', ');
    issues.push(`missing expected content-type overrides: ${preview}`);
  }
  if (
    Array.isArray(packageConsistency?.contentTypeMismatches) &&
    packageConsistency.contentTypeMismatches.length > 0
  ) {
    const preview = packageConsistency.contentTypeMismatches
      .slice(0, 5)
      .map(
        (x) => `${x.part}:${x.contentType || '(empty)'}=>${x.expectedContentType || '(unknown)'}`
      )
      .join(', ');
    issues.push(`content-type mismatches: ${preview}`);
  }
  return issues;
}

// ============ MAIN ORCHESTRATOR ============

async function runMarketResearch(userPrompt, email, options = {}) {
  const startTime = Date.now();
  console.log('\n========================================');
  console.log('MARKET RESEARCH - START');
  console.log('========================================');
  console.log('Time:', new Date().toISOString());
  console.log('Email:', email);

  // Reset cost tracker
  // NOTE: Global costTracker has race condition with concurrent requests — acceptable for single-instance deployment
  costTracker.totalCost = 0;
  costTracker.calls = [];
  resetBudget();

  const tracker = createTracker('market-research', email, { prompt: userPrompt.substring(0, 200) });

  return trackingContext.run(tracker, async () => {
    try {
      const runOptions = options && typeof options === 'object' ? options : {};
      const abortSignal = runOptions.abortSignal || null;
      const throwIfAborted = (stage) => {
        if (!abortSignal || !abortSignal.aborted) return;
        const reason = abortSignal.reason;
        const reasonText =
          typeof reason === 'string'
            ? reason
            : reason && typeof reason.message === 'string'
              ? reason.message
              : 'Pipeline aborted';
        throw new Error(`Pipeline aborted${stage ? ` during ${stage}` : ''}: ${reasonText}`);
      };

      const issueLog = [];
      const fixAttempts = [];
      const ownerStageCounts = {};
      let finalOwnerThatSolved = null;

      const syncRoutingLogsToRunInfo = () => {
        if (!lastRunRunInfo || typeof lastRunRunInfo !== 'object') return;
        lastRunRunInfo.issueLog = issueLog.slice(-300);
        lastRunRunInfo.fixAttempts = fixAttempts.slice(-300);
        lastRunRunInfo.ownerStageCounts = { ...ownerStageCounts };
        lastRunRunInfo.finalOwnerThatSolved = finalOwnerThatSolved;
      };

      const recordIssues = (issues) => {
        if (!Array.isArray(issues) || issues.length === 0) return;
        const stamp = new Date().toISOString();
        for (const issue of issues) {
          const normalized = makeStageIssue(issue || {});
          issueLog.push({ ...normalized, timestamp: stamp });
          const owner = normalized.ownerStage || 'unknown';
          ownerStageCounts[owner] = Number(ownerStageCounts[owner] || 0) + 1;
        }
        if (issueLog.length > 600) issueLog.splice(0, issueLog.length - 600);
        syncRoutingLogsToRunInfo();
      };

      const recordFixAttempt = ({
        sourceStage = 'unknown',
        ownerStage = 'unknown',
        attempt = 0,
        success = false,
        note = '',
      }) => {
        fixAttempts.push({
          timestamp: new Date().toISOString(),
          sourceStage: String(sourceStage || 'unknown'),
          ownerStage: String(ownerStage || 'unknown'),
          attempt: Number(attempt || 0),
          success: success === true,
          note: String(note || ''),
        });
        if (fixAttempts.length > 600) fixAttempts.splice(0, fixAttempts.length - 600);
        if (success === true)
          finalOwnerThatSolved = String(ownerStage || finalOwnerThatSolved || '');
        syncRoutingLogsToRunInfo();
      };

      // Stage 1: Read request (retry up to 3 times)
      throwIfAborted('request reading');
      let scope = null;
      let selectedCountry = null;
      const requestReadErrors = [];
      const MAX_REQUEST_READ_RETRIES = 3;
      for (let attempt = 1; attempt <= MAX_REQUEST_READ_RETRIES; attempt++) {
        try {
          const requestType = await readRequestType(userPrompt);
          if (!requestType || typeof requestType !== 'object') {
            throw new Error('Request reader returned invalid object');
          }
          const parsedMarkets = Array.isArray(requestType.targetMarkets)
            ? requestType.targetMarkets.map((m) => String(m || '').trim()).filter(Boolean)
            : [];
          if (parsedMarkets.length === 0) {
            throw new Error('No target country found in request');
          }
          scope = requestType;
          selectedCountry = parsedMarkets[0];
          break;
        } catch (err) {
          requestReadErrors.push(err.message);
          console.warn(
            `[Stage 1] Request reading attempt ${attempt}/${MAX_REQUEST_READ_RETRIES} failed: ${err.message}`
          );
        }
      }
      if (!scope || !selectedCountry) {
        throw new Error(
          `Request reading failed after ${MAX_REQUEST_READ_RETRIES} attempts: ${requestReadErrors.join(' | ')}`
        );
      }
      const requestedDraftPptMode = parseBooleanOption(runOptions?.draftPptMode, false) === true;
      const draftPptMode = Boolean(ALLOW_DRAFT_PPT_MODE && requestedDraftPptMode);
      if (requestedDraftPptMode && !ALLOW_DRAFT_PPT_MODE) {
        console.warn(
          '[Quality Gate] Draft PPT mode request ignored because ALLOW_DRAFT_PPT_MODE is not enabled'
        );
      }
      if (runOptions && typeof runOptions === 'object') {
        if (
          runOptions.templateSlideSelections &&
          typeof runOptions.templateSlideSelections === 'object'
        ) {
          scope.templateSlideSelections = runOptions.templateSlideSelections;
        }
        if (typeof runOptions.templateStrictMode === 'boolean') {
          scope.templateStrictMode = runOptions.templateStrictMode;
        }
        if (draftPptMode) {
          scope.draftPptMode = true;
        }
      }

      // Stage 2: Research single country
      console.log('\n=== STAGE 2: COUNTRY RESEARCH ===');
      console.log(`Researching country: ${selectedCountry}`);

      const countryAnalyses = [];
      const countryResearchFailures = [];
      const MAX_STAGE2_RETRIES = 3;
      let stage2CountryResult = null;
      for (let attempt = 1; attempt <= MAX_STAGE2_RETRIES; attempt++) {
        throwIfAborted(`country research (${selectedCountry})`);
        try {
          const candidate = await researchCountry(
            selectedCountry,
            scope.industry,
            scope.clientContext,
            scope
          );
          if (candidate?.error) {
            countryResearchFailures.push({
              country: candidate.country || selectedCountry,
              error: candidate.error,
              detail: candidate.message || null,
            });
            console.warn(
              `[Stage 2] Research attempt ${attempt}/${MAX_STAGE2_RETRIES} returned error payload: ${candidate.error}`
            );
          } else {
            stage2CountryResult = candidate;
            break;
          }
        } catch (err) {
          countryResearchFailures.push({
            country: selectedCountry,
            error: err.message,
          });
          console.warn(
            `[Stage 2] Research attempt ${attempt}/${MAX_STAGE2_RETRIES} failed: ${err.message}`
          );
        }
      }
      if (stage2CountryResult) {
        countryAnalyses.push(stage2CountryResult);
        countryResearchFailures.length = 0;
      }
      if (countryResearchFailures.length > 0) {
        const summary = countryResearchFailures
          .map((item) => `${item.country}: ${item.error}${item.detail ? ` (${item.detail})` : ''}`)
          .join(' | ');
        if (lastRunRunInfo) {
          lastRunRunInfo.stage = 'country_research_failed';
          lastRunRunInfo.countryResearchFailures = countryResearchFailures.slice(0, 20);
          lastRunRunInfo.error = `Country research failed: ${summary}`;
        }
        throw new Error(`Country research failed: ${summary}`);
      }

      // Quality Gate 1: Validate research quality per country and retry weak topics
      for (const ca of countryAnalyses) {
        if (!ca.rawData) continue;
        throwIfAborted(`research check (${ca.country})`);
        const researchGate = validateResearchQuality(ca.rawData);
        console.log(
          '[Quality Gate] Research for',
          ca.country + ':',
          JSON.stringify({
            pass: researchGate.pass,
            score: researchGate.score,
            issues: researchGate.issues,
          })
        );
        if (!researchGate.pass && researchGate.retryTopics.length > 0) {
          console.log(
            '[Quality Gate] Retrying',
            researchGate.retryTopics.length,
            'weak topics for',
            ca.country + '...'
          );
          // Fix 22: Cap retry loop at 2 minutes
          const RETRY_TIMEOUT = 2 * 60 * 1000;
          const retryLoop = async () => {
            for (const topic of researchGate.retryTopics.slice(0, 5)) {
              throwIfAborted(`research retry (${ca.country})`);
              try {
                const ind = scope.industry || 'the industry';
                const queryMap = {
                  market_size: `${ca.country} ${ind} market size value statistics and trends`,
                  market_demand: `${ca.country} ${ind} demand by sector analysis`,
                  market_supplyChain: `${ca.country} ${ind} supply chain infrastructure`,
                  market_adjacentServices: `${ca.country} ${ind} services ecosystem providers`,
                  market_pricing: `${ca.country} ${ind} pricing and cost structure`,
                  market_services: `${ca.country} ${ind} specialized services market`,
                  policy_regulatory: `${ca.country} ${ind} regulatory framework laws`,
                  policy_incentives: `${ca.country} ${ind} incentives and subsidies`,
                  competitors_players: `${ca.country} major ${ind} companies and players`,
                };
                const retryQuery =
                  queryMap[topic] || `${ca.country} ${scope.industry} ${topic.replace(/_/g, ' ')}`;
                const retry = await callGeminiResearch(
                  retryQuery + ' provide specific statistics and company names',
                  ca.country,
                  scope.industry
                );
                if (retry && retry.content && retry.content.length > 200) {
                  ca.rawData[topic] = {
                    ...ca.rawData[topic],
                    content: retry.content,
                    citations: retry.citations || ca.rawData[topic].citations,
                    researchQuality: retry.researchQuality || 'retried',
                  };
                }
              } catch (e) {
                console.warn('[Quality Gate] Retry failed for topic:', topic, e.message);
              }
            }
            return { timedOut: false };
          };
          const retryResult = await Promise.race([
            retryLoop(),
            new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), RETRY_TIMEOUT)),
          ]);
          if (retryResult.timedOut) {
            console.warn(`[Quality Gate] Retry loop timed out after 2 minutes for ${ca.country}`);
          }
        }
      }

      // Stage 2a: Gemini 3 Pro review loop for country analysis (max 3 retries).
      const stage2ReviewLoop = [];
      const MAX_STAGE2_REVIEW_RETRIES = 3;
      for (let i = 0; i < countryAnalyses.length; i++) {
        let countryAnalysis = countryAnalyses[i];
        for (let attempt = 1; attempt <= MAX_STAGE2_REVIEW_RETRIES; attempt++) {
          const needsReview = countryNeedsReview(countryAnalysis);
          if (!needsReview) break;
          const reviewIssues = [];
          if (countryAnalysis?.readyForClient === false) {
            reviewIssues.push('readyForClient flag is false');
          }
          for (const key of ['policy', 'market', 'competitors', 'depth', 'summary']) {
            if (!isPlainObject(countryAnalysis?.[key])) {
              reviewIssues.push(`missing/invalid section: ${key}`);
            }
          }
          const stage2Issues = buildStageIssuesFromMessages(reviewIssues, {
            sourceStage: '2a',
            type: 'country_shape',
            severity: 'high',
          });
          if (stage2Issues.length === 0) {
            stage2Issues.push(
              makeStageIssue({
                type: 'country_shape',
                severity: 'high',
                message: `${countryAnalysis?.country || selectedCountry}: country analysis needs review`,
                ownerStage: '2a',
                sourceStage: '2a',
              })
            );
          }
          recordIssues(stage2Issues);
          const routedOwner = pickOwnerStage(stage2Issues, '2a');
          console.log(
            `[Stage 2a] Gemini 3 Pro review attempt ${attempt}/${MAX_STAGE2_REVIEW_RETRIES} for ${countryAnalysis?.country || selectedCountry} (owner=${routedOwner})`
          );
          let reviewed = null;
          try {
            reviewed = await reviewCountryAnalysisWithGeminiPro({
              countryAnalysis,
              scope,
              issues: reviewIssues,
              attempt,
              maxRetries: MAX_STAGE2_REVIEW_RETRIES,
            });
          } catch (reviewErr) {
            console.warn(`[Stage 2a] Gemini 3 Pro review failed: ${reviewErr.message}`);
            recordFixAttempt({
              sourceStage: '2a',
              ownerStage: routedOwner,
              attempt,
              success: false,
              note: `review call failed: ${reviewErr.message}`,
            });
          }
          if (!isPlainObject(reviewed)) {
            stage2ReviewLoop.push({
              country: countryAnalysis?.country || selectedCountry,
              attempt,
              applied: false,
              note: 'model output was not valid JSON',
            });
            recordFixAttempt({
              sourceStage: '2a',
              ownerStage: routedOwner,
              attempt,
              success: false,
              note: 'model output was not valid JSON',
            });
            continue;
          }
          countryAnalysis = mergeCountryAnalysis(countryAnalysis, reviewed);
          stage2ReviewLoop.push({
            country: countryAnalysis?.country || selectedCountry,
            attempt,
            applied: true,
            stillNeedsReview: countryNeedsReview(countryAnalysis),
          });
          recordFixAttempt({
            sourceStage: '2a',
            ownerStage: routedOwner,
            attempt,
            success: true,
            note: countryNeedsReview(countryAnalysis)
              ? 'applied, still needs review'
              : 'applied and resolved',
          });
          if (!countryNeedsReview(countryAnalysis)) break;
        }
        countryAnalyses[i] = countryAnalysis;
      }

      // Collect pipeline runInfo for the selected country
      lastRunRunInfo = {
        timestamp: new Date().toISOString(),
        industry: scope.industry,
        countries: countryAnalyses.map((ca) => ({
          country: ca.country,
          error: ca.error || null,
          researchTopicCount: ca.rawData ? Object.keys(ca.rawData).length : 0,
          researchTopicChars: ca.rawData
            ? Object.fromEntries(
                Object.entries(ca.rawData).map(([k, v]) => [k, v?.content?.length || 0])
              )
            : {},
          synthesisScores: ca.contentCheck?.scores || null,
          synthesisFailures: ca.contentCheck?.failures || [],
          synthesisValid: ca.contentCheck?.valid ?? null,
          failedSections: ['policy', 'market', 'competitors'].filter((s) => ca[s]?._synthesisError),
          finalConfidenceScore: ca.finalConfidenceScore ?? null,
          readyForClient: ca.readyForClient ?? null,
          readiness: ca.readiness || null,
          finalReview: ca.finalReview
            ? {
                grade: ca.finalReview.overallGrade || null,
                coherenceScore: ca.finalReview.coherenceScore ?? null,
                criticalIssues: (ca.finalReview.issues || []).filter(
                  (i) => i.severity === 'critical'
                ).length,
                majorIssues: (ca.finalReview.issues || []).filter((i) => i.severity === 'major')
                  .length,
              }
            : null,
        })),
        totalCost: costTracker.totalCost,
        apiCalls: costTracker.calls.length,
        stage: 'complete',
        draftPptMode,
        stage2ReviewLoop,
        issueLog: issueLog.slice(-200),
        fixAttempts: fixAttempts.slice(-200),
        ownerStageCounts: { ...ownerStageCounts },
        finalOwnerThatSolved,
      };
      syncRoutingLogsToRunInfo();

      // Readiness check (warning-only): do not block here.
      const notReadyCountries = countryAnalyses.filter((ca) => ca && ca.readyForClient === false);
      if (notReadyCountries.length > 0) {
        const notReadyRunInfo = notReadyCountries.map((ca) => ({
          country: ca.country,
          effectiveScore: Number(ca?.readiness?.effectiveScore || 0),
          confidenceScore: Number(ca?.readiness?.confidenceScore || 0),
          finalConfidenceScore: Number(ca?.readiness?.finalConfidenceScore || 0),
          codeGateScore: Number(ca?.readiness?.codeGateScore || 0),
          finalReviewCoherence: Number(ca?.readiness?.finalReviewCoherence || 0),
          finalReviewCritical: Number(ca?.readiness?.finalReviewCritical || 0),
          finalReviewMajor: Number(ca?.readiness?.finalReviewMajor || 0),
          finalReviewOpenGaps: Number(ca?.readiness?.finalReviewOpenGaps || 0),
          readinessReasons: Array.isArray(ca?.readiness?.reasons) ? ca.readiness.reasons : [],
          synthesisFailures: Array.isArray(ca?.contentCheck?.failures)
            ? ca.contentCheck.failures
            : [],
        }));
        const list = notReadyCountries.map((ca) => ca.country).join(', ');
        console.warn(`[Quality Check] Country readiness warning: ${list}`);
        if (lastRunRunInfo) {
          lastRunRunInfo.stage = 'quality_readiness_warning';
          lastRunRunInfo.notReadyCountries = notReadyRunInfo;
        }
      }

      // NOTE: rawData is preserved here — PPT generation needs it for citations and fallback content.
      // It will be cleaned up AFTER PPT generation to free memory.

      // Stage 3: Synthesize findings
      throwIfAborted('synthesis');
      const MAX_STAGE3_RETRIES = 3;
      let synthesis = null;
      const stage3Errors = [];
      for (let attempt = 1; attempt <= MAX_STAGE3_RETRIES; attempt++) {
        try {
          const candidate = await synthesizeFindings(countryAnalyses, scope);
          if (!isPlainObject(candidate)) {
            throw new Error('synthesis result is not a JSON object');
          }
          synthesis = candidate;
          break;
        } catch (sErr) {
          stage3Errors.push(sErr.message);
          console.warn(
            `[Stage 3] Synthesis attempt ${attempt}/${MAX_STAGE3_RETRIES} failed: ${sErr.message}`
          );
        }
      }
      if (!isPlainObject(synthesis)) {
        throw new Error(
          `Synthesis failed after ${MAX_STAGE3_RETRIES} attempts: ${stage3Errors.join(' | ')}`
        );
      }

      // Stage 3a (merged): synthesis score + Gemini review loop.
      // This score is informative here; hard blocking is in stage 5.
      let finalSynthesis = synthesis;
      let synthesisGate = validateSynthesisQuality(finalSynthesis, scope.industry);
      console.log(
        '[Quality Gate] Synthesis:',
        JSON.stringify({
          pass: synthesisGate.pass,
          overall: synthesisGate.overall,
          failures: synthesisGate.failures,
        })
      );
      const synthesisReviewLoop = [];
      const MAX_STAGE3_REVIEW_RETRIES = 3;
      if (!synthesisGate.pass) {
        for (let attempt = 1; attempt <= MAX_STAGE3_REVIEW_RETRIES; attempt++) {
          const stage3Issues = buildStageIssuesFromMessages(synthesisGate.failures || [], {
            sourceStage: '3a',
            type: 'synthesis_gap',
            severity: 'high',
          });
          if (stage3Issues.length === 0) {
            stage3Issues.push(
              makeStageIssue({
                type: 'synthesis_gap',
                severity: 'high',
                message: `synthesis score ${synthesisGate.overall}/100 below pass line`,
                ownerStage: '3a',
                sourceStage: '3a',
              })
            );
          }
          recordIssues(stage3Issues);
          const routedOwner = pickOwnerStage(stage3Issues, '3a');
          console.log(
            `[Stage 3a] Gemini 3 Pro review attempt ${attempt}/${MAX_STAGE3_REVIEW_RETRIES} (score=${synthesisGate.overall}/100, owner=${routedOwner})`
          );
          let improved = null;
          try {
            if (routedOwner === '2' || routedOwner === '2a') {
              const repairLines =
                Array.isArray(synthesisGate.failures) && synthesisGate.failures.length > 0
                  ? synthesisGate.failures.slice(0, 10)
                  : ['Fill missing sections and concrete evidence'];
              for (let i = 0; i < countryAnalyses.length; i++) {
                const ca = countryAnalyses[i];
                const reviewed = await reviewCountryAnalysisWithGeminiPro({
                  countryAnalysis: ca,
                  scope,
                  issues: repairLines,
                  attempt,
                  maxRetries: MAX_STAGE3_REVIEW_RETRIES,
                });
                if (isPlainObject(reviewed)) {
                  countryAnalyses[i] = mergeCountryAnalysis(ca, reviewed);
                }
              }
              const candidate = await synthesizeFindings(countryAnalyses, scope);
              if (isPlainObject(candidate)) improved = candidate;
            } else if (routedOwner === '5a') {
              const quickReadiness = checkContentReadiness(finalSynthesis, {
                threshold: 80,
                industry: scope.industry,
                coherenceChecker: checkStoryFlow,
              });
              improved = await improveSynthesisWithGeminiPro({
                synthesis: finalSynthesis,
                scope,
                contentReadiness: quickReadiness,
                attempt,
                maxRetries: MAX_STAGE3_REVIEW_RETRIES,
              });
            } else {
              improved = await improveSynthesisQualityWithGeminiPro({
                synthesis: finalSynthesis,
                scope,
                synthesisGate,
                attempt,
                maxRetries: MAX_STAGE3_REVIEW_RETRIES,
              });
            }
          } catch (reviewErr) {
            console.warn(`[Stage 3a] Gemini 3 Pro review failed: ${reviewErr.message}`);
            recordFixAttempt({
              sourceStage: '3a',
              ownerStage: routedOwner,
              attempt,
              success: false,
              note: `review call failed: ${reviewErr.message}`,
            });
          }
          if (!isPlainObject(improved)) {
            synthesisReviewLoop.push({
              attempt,
              applied: false,
              score: synthesisGate.overall,
              note: 'model output was not valid JSON',
              ownerStage: routedOwner,
            });
            recordFixAttempt({
              sourceStage: '3a',
              ownerStage: routedOwner,
              attempt,
              success: false,
              note: 'no valid JSON returned',
            });
            continue;
          }
          finalSynthesis = improved;
          synthesisGate = validateSynthesisQuality(finalSynthesis, scope.industry);
          synthesisReviewLoop.push({
            attempt,
            applied: true,
            score: synthesisGate.overall,
            pass: synthesisGate.pass,
            ownerStage: routedOwner,
          });
          recordFixAttempt({
            sourceStage: '3a',
            ownerStage: routedOwner,
            attempt,
            success: true,
            note: `updated synthesis score to ${synthesisGate.overall}`,
          });
          if (synthesisGate.pass) break;
        }
      }
      if (!synthesisGate.pass) {
        console.warn(
          `[Quality Check] Synthesis quality warning: score=${synthesisGate.overall}/100`
        );
      }
      if (lastRunRunInfo) {
        lastRunRunInfo.synthesisGate = {
          pass: synthesisGate.pass,
          overall: synthesisGate.overall,
          failures: synthesisGate.failures,
        };
        lastRunRunInfo.synthesisReviewLoop = {
          retries: MAX_STAGE3_REVIEW_RETRIES,
          attempts: synthesisReviewLoop,
        };
      }

      // Main content gate: hard fail if below threshold.
      let contentReadiness = checkContentReadiness(finalSynthesis, {
        threshold: 80,
        industry: scope.industry,
        coherenceChecker: checkStoryFlow,
      });
      console.log(
        '[Content Check] Readiness score:',
        JSON.stringify({
          pass: contentReadiness.pass,
          overallScore: contentReadiness.overallScore,
          threshold: contentReadiness.threshold,
          shallowSections: contentReadiness.shallowSections,
          contradictions: contentReadiness.contradictions.length,
          failedSections: contentReadiness.sectionScorecard
            .filter((s) => !s.pass)
            .map((s) => `${s.section}(${s.score})`),
        })
      );
      const MAX_CONTENT_REVIEW_RETRIES = 3;
      const contentReviewLoop = [];
      if (!contentReadiness.pass) {
        for (let attempt = 1; attempt <= MAX_CONTENT_REVIEW_RETRIES; attempt++) {
          const stage5IssueMessages = [
            ...(Array.isArray(contentReadiness.improvementActions)
              ? contentReadiness.improvementActions.slice(0, 20)
              : []),
            ...(Array.isArray(contentReadiness.sectionScorecard)
              ? contentReadiness.sectionScorecard
                  .filter((s) => !s.pass)
                  .map(
                    (s) => `${s.section}: ${Array.isArray(s.reasons) ? s.reasons.join('; ') : ''}`
                  )
              : []),
          ];
          const stage5Issues = buildStageIssuesFromMessages(stage5IssueMessages, {
            sourceStage: '5a',
            type: 'content_gap',
            severity: 'high',
          });
          if (stage5Issues.length === 0) {
            stage5Issues.push(
              makeStageIssue({
                type: 'content_gap',
                severity: 'high',
                message: `content score ${contentReadiness.overallScore}/${contentReadiness.threshold} below pass line`,
                ownerStage: '5a',
                sourceStage: '5a',
              })
            );
          }
          recordIssues(stage5Issues);
          const routedOwner = pickOwnerStage(stage5Issues, '5a');
          console.log(
            `[Content Review] Gemini 3 Pro improve attempt ${attempt}/${MAX_CONTENT_REVIEW_RETRIES} (score=${contentReadiness.overallScore}/${contentReadiness.threshold}, owner=${routedOwner})`
          );
          let improvedSynthesis = null;
          try {
            if (routedOwner === '2' || routedOwner === '2a') {
              const issueLines =
                Array.isArray(contentReadiness.improvementActions) &&
                contentReadiness.improvementActions.length > 0
                  ? contentReadiness.improvementActions.slice(0, 12)
                  : ['Add concrete data and complete missing sections'];
              for (let i = 0; i < countryAnalyses.length; i++) {
                const ca = countryAnalyses[i];
                const reviewed = await reviewCountryAnalysisWithGeminiPro({
                  countryAnalysis: ca,
                  scope,
                  issues: issueLines,
                  attempt,
                  maxRetries: MAX_CONTENT_REVIEW_RETRIES,
                });
                if (isPlainObject(reviewed)) {
                  countryAnalyses[i] = mergeCountryAnalysis(ca, reviewed);
                }
              }
              const candidate = await synthesizeFindings(countryAnalyses, scope);
              if (isPlainObject(candidate)) improvedSynthesis = candidate;
            } else if (routedOwner === '3a') {
              const stage3Gate = validateSynthesisQuality(finalSynthesis, scope.industry);
              improvedSynthesis = await improveSynthesisQualityWithGeminiPro({
                synthesis: finalSynthesis,
                scope,
                synthesisGate: stage3Gate,
                attempt,
                maxRetries: MAX_CONTENT_REVIEW_RETRIES,
              });
            } else {
              improvedSynthesis = await improveSynthesisWithGeminiPro({
                synthesis: finalSynthesis,
                scope,
                contentReadiness,
                attempt,
                maxRetries: MAX_CONTENT_REVIEW_RETRIES,
              });
            }
          } catch (reviewErr) {
            console.warn(`[Content Review] Gemini 3 Pro call failed: ${reviewErr.message}`);
            recordFixAttempt({
              sourceStage: '5a',
              ownerStage: routedOwner,
              attempt,
              success: false,
              note: `review call failed: ${reviewErr.message}`,
            });
          }
          if (!isPlainObject(improvedSynthesis)) {
            contentReviewLoop.push({
              attempt,
              applied: false,
              score: contentReadiness.overallScore,
              note: 'model output was not a valid JSON object',
              ownerStage: routedOwner,
            });
            recordFixAttempt({
              sourceStage: '5a',
              ownerStage: routedOwner,
              attempt,
              success: false,
              note: 'no valid JSON returned',
            });
            continue;
          }
          finalSynthesis = improvedSynthesis;
          contentReadiness = checkContentReadiness(finalSynthesis, {
            threshold: 80,
            industry: scope.industry,
            coherenceChecker: checkStoryFlow,
          });
          contentReviewLoop.push({
            attempt,
            applied: true,
            score: contentReadiness.overallScore,
            pass: contentReadiness.pass,
            ownerStage: routedOwner,
          });
          recordFixAttempt({
            sourceStage: '5a',
            ownerStage: routedOwner,
            attempt,
            success: true,
            note: `updated content score to ${contentReadiness.overallScore}`,
          });
          console.log(
            `[Content Review] Attempt ${attempt} result: score=${contentReadiness.overallScore}/${contentReadiness.threshold}, pass=${contentReadiness.pass}`
          );
          if (contentReadiness.pass) break;
        }
      }
      const contradictionCount = Array.isArray(contentReadiness?.contradictions)
        ? contentReadiness.contradictions.length
        : Number(contentReadiness?.contradictions || 0);
      const shallowCount = Array.isArray(contentReadiness?.shallowSections)
        ? contentReadiness.shallowSections.length
        : 0;
      const contentSoftBypass =
        CONTENT_FIRST_MODE &&
        !contentReadiness.pass &&
        Number(contentReadiness.overallScore || 0) >= 72 &&
        contradictionCount <= 1 &&
        shallowCount <= 2;

      if (!contentReadiness.pass && !contentSoftBypass) {
        const failedSections = contentReadiness.sectionScorecard
          .filter((s) => !s.pass)
          .map((s) => `${s.section}=${s.score}: ${s.reasons.slice(0, 2).join('; ')}`)
          .slice(0, 5)
          .join(' | ');
        const actions = contentReadiness.improvementActions.slice(0, 5).join(' | ');
        if (lastRunRunInfo) {
          lastRunRunInfo.stage = 'content_quality_failed';
          lastRunRunInfo.contentReadiness = {
            overallScore: contentReadiness.overallScore,
            threshold: contentReadiness.threshold,
            sectionScorecard: contentReadiness.sectionScorecard,
            shallowSections: contentReadiness.shallowSections,
            contradictions: contentReadiness.contradictions.length,
            improvementActions: contentReadiness.improvementActions,
          };
          lastRunRunInfo.contentReviewLoop = {
            retries: MAX_CONTENT_REVIEW_RETRIES,
            attempts: contentReviewLoop,
          };
          lastRunRunInfo.error = `Content quality below target (${contentReadiness.overallScore}/${contentReadiness.threshold}): ${failedSections}`;
        }
        throw new Error(
          `Content quality check failed (${contentReadiness.overallScore}/${contentReadiness.threshold}). Failed sections: ${failedSections}. Improve: ${actions}`
        );
      }
      if (contentSoftBypass) {
        console.warn(
          `[Content Review] Soft bypass enabled (score=${contentReadiness.overallScore}/${contentReadiness.threshold}, contradictions=${contradictionCount}, shallowSections=${shallowCount})`
        );
      }
      if (lastRunRunInfo) {
        lastRunRunInfo.contentReadiness = {
          pass: contentReadiness.pass,
          overallScore: contentReadiness.overallScore,
          threshold: contentReadiness.threshold,
          sectionScorecard: contentReadiness.sectionScorecard,
          shallowSections: contentReadiness.shallowSections,
          contradictions: contradictionCount,
          softBypass: contentSoftBypass,
        };
        lastRunRunInfo.contentReviewLoop = {
          retries: MAX_CONTENT_REVIEW_RETRIES,
          attempts: contentReviewLoop,
        };
      }

      // Stage 6: Pre-build check (merged stage):
      // cleanup temp keys + build-readiness checks + basic shape checks.
      const MAX_PRE_RENDER_RETRIES = 3;
      const preRenderAttempts = [];
      let finalPptGateFailures = [];
      let finalPreRenderStructureIssues = [];
      let finalPreRenderSanitization = null;
      for (let attempt = 1; attempt <= MAX_PRE_RENDER_RETRIES; attempt++) {
        const preRenderSanitizationCtx = createSanitizationContext();
        for (let i = 0; i < countryAnalyses.length; i++) {
          countryAnalyses[i] = sanitizeTransientKeys(countryAnalyses[i], preRenderSanitizationCtx);
        }
        logSanitizationResult(`pre-build#${attempt}`, preRenderSanitizationCtx);

        const pptGateFailures = [];
        for (const ca of countryAnalyses) {
          const blocks = buildPptGateBlocks(ca);
          const pptGate = validatePptData(blocks);
          console.log(
            `[Pre-build] Data check for ${ca.country} (attempt ${attempt}/${MAX_PRE_RENDER_RETRIES}):`,
            JSON.stringify({
              pass: pptGate.pass,
              emptyBlocks: pptGate.emptyBlocks.length,
              chartIssues: pptGate.chartIssues.length,
              overflowRisks: pptGate.overflowRisks.length,
              nonRenderableGroups: pptGate.nonRenderableGroups || [],
              severeOverflowCount: pptGate.severeOverflowCount || 0,
            })
          );
          if (!pptGate.pass) {
            pptGateFailures.push({
              country: ca.country,
              nonRenderableGroups: pptGate.nonRenderableGroups || [],
              emptyBlocks: (pptGate.emptyBlocks || []).slice(0, 8),
              chartIssues: (pptGate.chartIssues || []).slice(0, 8),
              severeOverflowCount: Number(pptGate.severeOverflowCount || 0),
              thinContentRatio: Number(pptGate.thinContentRatio ?? pptGate.thinContentRatio ?? 0),
            });
          }
        }

        const preRenderStructureIssues = collectPreRenderStructureIssues(countryAnalyses);
        const hasBlockingPptGateIssues = pptGateFailures.length > 0 && !draftPptMode;
        const hasBlockingStructureIssues = preRenderStructureIssues.length > 0;
        const stage6IssueMessages = [];
        for (const failure of pptGateFailures) {
          if (failure.nonRenderableGroups.length > 0) {
            stage6IssueMessages.push(
              `${failure.country}: not-buildable groups ${failure.nonRenderableGroups.join(', ')}`
            );
          }
          if (failure.emptyBlocks.length > 0) {
            stage6IssueMessages.push(
              `${failure.country}: empty blocks ${failure.emptyBlocks.join(' ; ')}`
            );
          }
          if (failure.chartIssues.length > 0) {
            stage6IssueMessages.push(
              `${failure.country}: chart issues ${failure.chartIssues.join(' ; ')}`
            );
          }
        }
        for (const shapeIssue of preRenderStructureIssues) {
          stage6IssueMessages.push(shapeIssue);
        }
        const stage6Issues = buildStageIssuesFromMessages(stage6IssueMessages, {
          sourceStage: '6',
          type: 'pre_build_issue',
          severity: 'high',
        });
        if (stage6Issues.length > 0) {
          recordIssues(stage6Issues);
        }
        const routedOwner = pickOwnerStage(stage6Issues, '6');
        finalPptGateFailures = pptGateFailures;
        finalPreRenderStructureIssues = preRenderStructureIssues;
        finalPreRenderSanitization = preRenderSanitizationCtx;

        preRenderAttempts.push({
          attempt,
          pass: !(hasBlockingPptGateIssues || hasBlockingStructureIssues),
          dataFailures: pptGateFailures.length,
          structureIssues: preRenderStructureIssues.length,
        });

        if (!(hasBlockingPptGateIssues || hasBlockingStructureIssues)) {
          break;
        }

        if (attempt >= MAX_PRE_RENDER_RETRIES) {
          break;
        }

        // Retry path: ask Gemini 3 Pro to repair country analysis shape/data.
        const repairOwner = ['2', '2a', '6'].includes(routedOwner) ? routedOwner : '2a';
        let repairedCount = 0;
        for (let i = 0; i < countryAnalyses.length; i++) {
          const ca = countryAnalyses[i];
          const issueLines = [];
          const match = pptGateFailures.find((f) => f.country === ca.country);
          if (match) {
            if (match.nonRenderableGroups.length > 0) {
              issueLines.push(`not-buildable groups: ${match.nonRenderableGroups.join(', ')}`);
            }
            if (match.emptyBlocks.length > 0) {
              issueLines.push(`empty blocks: ${match.emptyBlocks.join(' ; ')}`);
            }
            if (match.chartIssues.length > 0) {
              issueLines.push(`chart issues: ${match.chartIssues.join(' ; ')}`);
            }
          }
          for (const shapeIssue of preRenderStructureIssues.slice(0, 8)) {
            if (shapeIssue.startsWith(`${ca.country}:`)) issueLines.push(shapeIssue);
          }
          if (issueLines.length === 0) continue;
          let reviewed = null;
          try {
            reviewed = await reviewCountryAnalysisWithGeminiPro({
              countryAnalysis: ca,
              scope,
              issues: issueLines,
              attempt,
              maxRetries: MAX_PRE_RENDER_RETRIES,
            });
          } catch (reviewErr) {
            console.warn(
              `[Pre-build] Gemini 3 Pro repair failed for ${ca.country}: ${reviewErr.message}`
            );
          }
          if (isPlainObject(reviewed)) {
            countryAnalyses[i] = mergeCountryAnalysis(ca, reviewed);
            repairedCount += 1;
          }
        }
        recordFixAttempt({
          sourceStage: '6',
          ownerStage: repairOwner,
          attempt,
          success: repairedCount > 0,
          note:
            repairedCount > 0
              ? `repaired ${repairedCount} country analysis object(s)`
              : 'no country repairs were applied',
        });
      }

      const hasFinalBlockingPptGateIssues = finalPptGateFailures.length > 0 && !draftPptMode;
      const hasFinalBlockingStructureIssues = finalPreRenderStructureIssues.length > 0;
      if (hasFinalBlockingPptGateIssues || hasFinalBlockingStructureIssues) {
        const parts = [];
        if (hasFinalBlockingPptGateIssues) {
          const pptSummary = finalPptGateFailures
            .map((failure) => {
              const groups = failure.nonRenderableGroups.length
                ? `groups=${failure.nonRenderableGroups.join('|')}`
                : 'groups=n/a';
              const empties = failure.emptyBlocks.length
                ? `empty=${failure.emptyBlocks.join(' ; ')}`
                : '';
              const charts = failure.chartIssues.length
                ? `charts=${failure.chartIssues.join(' ; ')}`
                : '';
              const overflow =
                failure.severeOverflowCount > 0
                  ? `severeOverflow=${failure.severeOverflowCount}`
                  : '';
              const sparse =
                failure.thinContentRatio > 0
                  ? `emptyRatio=${Math.round(failure.thinContentRatio * 100)}%`
                  : '';
              return `${failure.country}[${groups}${empties ? `, ${empties}` : ''}${charts ? `, ${charts}` : ''}${overflow ? `, ${overflow}` : ''}${sparse ? `, ${sparse}` : ''}]`;
            })
            .join(' | ');
          parts.push(`data check: ${pptSummary}`);
        }
        if (hasFinalBlockingStructureIssues) {
          parts.push(`shape check: ${finalPreRenderStructureIssues.slice(0, 12).join(' | ')}`);
        }
        const issueSummary = parts.join(' || ');
        if (lastRunRunInfo) {
          lastRunRunInfo.stage = 'pre_render_check_failed';
          lastRunRunInfo.pptDataGateFailures = finalPptGateFailures;
          lastRunRunInfo.preRenderStructureIssues = finalPreRenderStructureIssues.slice(0, 50);
          lastRunRunInfo.preRenderCheckAttempts = preRenderAttempts;
          lastRunRunInfo.error = `Pre-build check failed: ${issueSummary}`;
        }
        throw new Error(`Pre-build check failed: ${issueSummary}`);
      }
      if (finalPptGateFailures.length > 0 && draftPptMode) {
        console.warn(
          `[Pre-build] Draft mode bypassed ${finalPptGateFailures.length} data check failure(s)`
        );
      }
      if (lastRunRunInfo) {
        if (finalPreRenderSanitization) {
          lastRunRunInfo.preRenderSanitization = {
            droppedTransientKeyCount: finalPreRenderSanitization.droppedTransientKeyCount,
            droppedTransientKeySamples: finalPreRenderSanitization.droppedTransientKeySamples.slice(
              0,
              15
            ),
          };
        }
        lastRunRunInfo.preRenderCheckAttempts = preRenderAttempts;
        lastRunRunInfo.preRenderCheck = {
          draftBypass: draftPptMode && finalPptGateFailures.length > 0,
          pptDataFailures: finalPptGateFailures,
          structureIssues: finalPreRenderStructureIssues.slice(0, 50),
        };
      }

      // Content size check:
      // In content-first mode, this is analysis-only (no truncation, no row-cutting).
      const runCompaction = !CONTENT_FIRST_MODE;
      const sizeReportByCountry = {};
      for (let i = 0; i < countryAnalyses.length; i++) {
        const ca = countryAnalyses[i];
        const sizeCheckResult = runContentSizeCheck(ca, { dryRun: !runCompaction });
        sizeReportByCountry[ca.country] = sizeCheckResult.report;
        console.log(
          `[Content Size Check] ${ca.country}: risk=${sizeCheckResult.report.risk}, issues=${sizeCheckResult.report.issues.length}` +
            (sizeCheckResult.compactionLog.length > 0 && runCompaction
              ? `, compacted=${sizeCheckResult.compactionLog.length} item(s)`
              : '')
        );
        if (sizeCheckResult.report.risk === 'high') {
          const sizeIssues = buildStageIssuesFromMessages(sizeCheckResult.report.issues || [], {
            sourceStage: '7',
            type: 'size_risk',
            severity: 'medium',
          });
          if (sizeIssues.length === 0) {
            sizeIssues.push(
              makeStageIssue({
                type: 'size_risk',
                severity: 'medium',
                message: `${ca.country}: high content-size risk`,
                ownerStage: '5a',
                sourceStage: '7',
              })
            );
          }
          recordIssues(sizeIssues);
        }
        if (sizeCheckResult.compactionLog.length > 0 && runCompaction) {
          for (const entry of sizeCheckResult.compactionLog) {
            console.log(
              `[Content Size Check] Compacted ${ca.country}.${entry.section}.${entry.key}: ${entry.action} (${entry.before} → ${entry.after})`
            );
          }
          countryAnalyses[i] = sizeCheckResult.payload;
        }
        if (lastRunRunInfo) {
          if (!lastRunRunInfo.contentSizeCheck) lastRunRunInfo.contentSizeCheck = {};
          lastRunRunInfo.contentSizeCheck[ca.country] = {
            risk: sizeCheckResult.report.risk,
            issues: sizeCheckResult.report.issues.slice(0, 20),
            compacted: sizeCheckResult.compactionLog.length,
            compactionEnabled: runCompaction,
          };
          // Backward-compatible mirror for existing dashboards.
          // (self-assignment removed — was a no-op)
        }
      }

      // Stage 7a: readability rewrite loop (no hard cutting).
      // If text density is still high in content-first mode, ask Gemini to rewrite for slide readability
      // while preserving key facts and recommendations.
      const MAX_SIZE_REVIEW_RETRIES = 3;
      const sizeReviewAttempts = [];
      if (!runCompaction) {
        for (let attempt = 1; attempt <= MAX_SIZE_REVIEW_RETRIES; attempt++) {
          const highRiskItems = [];
          for (let i = 0; i < countryAnalyses.length; i++) {
            const ca = countryAnalyses[i];
            const report =
              sizeReportByCountry[ca.country] || runContentSizeCheck(ca, { dryRun: true }).report;
            sizeReportByCountry[ca.country] = report;
            if (report.risk === 'high') {
              highRiskItems.push({ index: i, country: ca.country, report });
            }
          }

          if (highRiskItems.length === 0) {
            break;
          }

          console.log(
            `[Stage 7a] Readability rewrite attempt ${attempt}/${MAX_SIZE_REVIEW_RETRIES}: ${highRiskItems.length} high-risk country payload(s)`
          );

          let repairedCount = 0;
          for (const item of highRiskItems) {
            const issueLines = [
              ...(Array.isArray(item.report.issues) ? item.report.issues.slice(0, 10) : []),
              'Rewrite for slide readability: use shorter clear sentences, keep full meaning.',
              'Preserve key numbers, years, company names, and strategic recommendation logic.',
              'Do not drop sections and do not use placeholders.',
            ];
            try {
              const reviewed = await reviewCountryAnalysisWithGeminiPro({
                countryAnalysis: countryAnalyses[item.index],
                scope,
                issues: issueLines,
                attempt,
                maxRetries: MAX_SIZE_REVIEW_RETRIES,
              });
              if (isPlainObject(reviewed)) {
                countryAnalyses[item.index] = mergeCountryAnalysis(
                  countryAnalyses[item.index],
                  reviewed
                );
                repairedCount += 1;
              }
            } catch (reviewErr) {
              console.warn(
                `[Stage 7a] Gemini 3 Pro rewrite failed for ${item.country}: ${reviewErr.message}`
              );
            }
          }

          if (repairedCount > 0) {
            const candidate = await synthesizeFindings(countryAnalyses, scope);
            if (isPlainObject(candidate)) {
              finalSynthesis = candidate;
              const refreshedReadiness = checkContentReadiness(finalSynthesis, {
                threshold: 80,
                industry: scope.industry,
                coherenceChecker: checkStoryFlow,
              });
              contentReadiness = refreshedReadiness;
              if (!refreshedReadiness.pass) {
                try {
                  const repairedSynthesis = await improveSynthesisWithGeminiPro({
                    synthesis: finalSynthesis,
                    scope,
                    contentReadiness: refreshedReadiness,
                    attempt,
                    maxRetries: MAX_SIZE_REVIEW_RETRIES,
                  });
                  if (isPlainObject(repairedSynthesis)) {
                    finalSynthesis = repairedSynthesis;
                    contentReadiness = checkContentReadiness(finalSynthesis, {
                      threshold: 80,
                      industry: scope.industry,
                      coherenceChecker: checkStoryFlow,
                    });
                  }
                } catch (sizeReviewContentErr) {
                  console.warn(
                    `[Stage 7a] Content-depth safeguard rewrite failed: ${sizeReviewContentErr.message}`
                  );
                }
              }
            }
          }

          // Re-check risks after rewrite.
          let remainingHighRisk = 0;
          for (let i = 0; i < countryAnalyses.length; i++) {
            const ca = countryAnalyses[i];
            const refreshed = runContentSizeCheck(ca, { dryRun: true }).report;
            sizeReportByCountry[ca.country] = refreshed;
            if (refreshed.risk === 'high') {
              remainingHighRisk += 1;
            }
            if (lastRunRunInfo) {
              if (!lastRunRunInfo.contentSizeCheck) lastRunRunInfo.contentSizeCheck = {};
              lastRunRunInfo.contentSizeCheck[ca.country] = {
                risk: refreshed.risk,
                issues: Array.isArray(refreshed.issues) ? refreshed.issues.slice(0, 20) : [],
                compacted: 0,
                compactionEnabled: runCompaction,
              };
            }
          }

          const attemptSummary = {
            attempt,
            highRiskCountries: highRiskItems.map((x) => x.country),
            repairedCount,
            remainingHighRisk,
          };
          sizeReviewAttempts.push(attemptSummary);
          recordFixAttempt({
            sourceStage: '7',
            ownerStage: '5a',
            attempt,
            success: repairedCount > 0,
            note: `size-risk rewrite repaired=${repairedCount}, remainingHighRisk=${remainingHighRisk}`,
          });

          if (remainingHighRisk === 0 || repairedCount === 0) {
            break;
          }
        }
      }
      if (lastRunRunInfo) {
        lastRunRunInfo.contentSizeReviewLoop = {
          retries: MAX_SIZE_REVIEW_RETRIES,
          attempts: sizeReviewAttempts,
        };
      }

      const applyOwnerFix = async ({
        ownerStage,
        sourceStage,
        attempt,
        issueMessages,
        maxRetries,
        rebuildPpt,
      }) => {
        const owner = String(ownerStage || defaultOwnerStage(sourceStage));
        const repairLines = Array.isArray(issueMessages) ? issueMessages.slice(0, 12) : [];
        const fixResult = {
          ownerStage: owner,
          success: false,
          note: '',
        };
        try {
          if (owner === '2' || owner === '2a' || owner === '6') {
            let repairedCount = 0;
            for (let i = 0; i < countryAnalyses.length; i++) {
              const ca = countryAnalyses[i];
              const reviewed = await reviewCountryAnalysisWithGeminiPro({
                countryAnalysis: ca,
                scope,
                issues:
                  repairLines.length > 0
                    ? repairLines
                    : ['Fill missing sections, evidence, and structured fields'],
                attempt,
                maxRetries,
              });
              if (isPlainObject(reviewed)) {
                countryAnalyses[i] = mergeCountryAnalysis(ca, reviewed);
                repairedCount += 1;
              }
            }
            if (repairedCount > 0) {
              const candidate = await synthesizeFindings(countryAnalyses, scope);
              if (isPlainObject(candidate)) {
                finalSynthesis = candidate;
              }
            }
            fixResult.success = repairedCount > 0;
            fixResult.note = `country repair count=${repairedCount}`;
          } else if (owner === '3a') {
            const stage3Gate = validateSynthesisQuality(finalSynthesis, scope.industry);
            const improved = await improveSynthesisQualityWithGeminiPro({
              synthesis: finalSynthesis,
              scope,
              synthesisGate: stage3Gate,
              attempt,
              maxRetries,
            });
            if (isPlainObject(improved)) {
              finalSynthesis = improved;
              fixResult.success = true;
              fixResult.note = 'synthesis quality repair applied';
            } else {
              fixResult.note = 'no valid synthesis from stage 3a repair';
            }
          } else if (owner === '5a') {
            const refreshedReadiness = checkContentReadiness(finalSynthesis, {
              threshold: 80,
              industry: scope.industry,
              coherenceChecker: checkStoryFlow,
            });
            const improved = await improveSynthesisWithGeminiPro({
              synthesis: finalSynthesis,
              scope,
              contentReadiness: refreshedReadiness,
              attempt,
              maxRetries,
            });
            if (isPlainObject(improved)) {
              finalSynthesis = improved;
              fixResult.success = true;
              fixResult.note = 'content rewrite applied';
            } else {
              fixResult.note = 'no valid synthesis from stage 5a rewrite';
            }
          } else if (owner === '9') {
            if (
              typeof normalizeAbsoluteRelationshipTargets === 'function' &&
              Buffer.isBuffer(pptBuffer)
            ) {
              const retryRelNormalize = await normalizeAbsoluteRelationshipTargets(pptBuffer);
              pptBuffer = retryRelNormalize.buffer;
            }
            if (Buffer.isBuffer(pptBuffer)) {
              const retryIdNormalize = await normalizeSlideNonVisualIds(pptBuffer);
              pptBuffer = retryIdNormalize.buffer;
              const retryCtReconcile = await reconcileContentTypesAndPackage(pptBuffer);
              pptBuffer = retryCtReconcile.buffer;
              fixResult.success = true;
              fixResult.note = 'file cleanup applied';
            } else {
              fixResult.note = 'no ppt buffer available for file cleanup';
            }
          } else {
            fixResult.note = `no upstream repair needed for owner ${owner}`;
          }

          if (rebuildPpt === true && Buffer.isBuffer(pptBuffer)) {
            pptBuffer = await generatePPT(finalSynthesis, countryAnalyses, scope);
            pptMetrics = (pptBuffer && (pptBuffer.__pptMetrics || pptBuffer.pptMetrics)) || null;
            if (fixResult.success) {
              fixResult.note = `${fixResult.note}; rebuilt ppt`;
            } else {
              fixResult.success = true;
              fixResult.note = 'rebuilt ppt after routing';
            }
          } else if (rebuildPpt === true && !Buffer.isBuffer(pptBuffer)) {
            pptBuffer = await generatePPT(finalSynthesis, countryAnalyses, scope);
            pptMetrics = (pptBuffer && (pptBuffer.__pptMetrics || pptBuffer.pptMetrics)) || null;
            fixResult.success = true;
            fixResult.note = fixResult.note || 'rebuilt ppt';
          }
        } catch (fixErr) {
          fixResult.success = false;
          fixResult.note = `repair failed: ${fixErr.message}`;
        }
        recordFixAttempt({
          sourceStage,
          ownerStage: owner,
          attempt,
          success: fixResult.success,
          note: fixResult.note,
        });
        return fixResult;
      };

      // Stage 8: Generate PPT
      throwIfAborted('ppt generation');
      const MAX_PPT_BUILD_RETRIES = 3;
      let pptBuffer = null;
      let lastPptBuildError = null;
      for (let attempt = 1; attempt <= MAX_PPT_BUILD_RETRIES; attempt++) {
        try {
          pptBuffer = await generatePPT(finalSynthesis, countryAnalyses, scope);
          break;
        } catch (pptErr) {
          lastPptBuildError = pptErr;
          console.warn(
            `[Stage 8] PPT build attempt ${attempt}/${MAX_PPT_BUILD_RETRIES} failed: ${pptErr.message}`
          );
          const stage8Issues = buildStageIssuesFromMessages([pptErr.message], {
            sourceStage: '8',
            type: 'ppt_build_error',
            severity: 'high',
          });
          recordIssues(stage8Issues);
          const routedOwner = pickOwnerStage(stage8Issues, '8');
          if (attempt < MAX_PPT_BUILD_RETRIES) {
            const fix = await applyOwnerFix({
              ownerStage: routedOwner,
              sourceStage: '8',
              attempt,
              issueMessages: stage8Issues.map((x) => x.message),
              maxRetries: MAX_PPT_BUILD_RETRIES,
              rebuildPpt: false,
            });
            if (!fix.success) {
              console.warn(
                `[Stage 8] Routed repair (owner=${routedOwner}) did not apply: ${fix.note}`
              );
            }
          }
        }
      }
      if (!Buffer.isBuffer(pptBuffer)) {
        throw new Error(
          `PPT build failed after ${MAX_PPT_BUILD_RETRIES} attempts: ${lastPptBuildError ? lastPptBuildError.message : 'unknown error'}`
        );
      }
      let pptMetrics = (pptBuffer && (pptBuffer.__pptMetrics || pptBuffer.pptMetrics)) || null;
      const pptCheckExpectations = buildPptCheckExpectations(scope);
      let latestPptStructureCheck = null;

      const MAX_STAGE9_RETRIES = 3;
      let stage9Completed = false;
      let stage9LastError = null;
      for (let stage9Attempt = 1; stage9Attempt <= MAX_STAGE9_RETRIES; stage9Attempt++) {
        try {
          // Final server-side package hardening (defense-in-depth): normalize IDs and content-types
          // again before any check/delivery so no generator path can bypass structural safety.
          if (typeof normalizeAbsoluteRelationshipTargets === 'function') {
            const serverRelNormalize = await normalizeAbsoluteRelationshipTargets(pptBuffer);
            pptBuffer = serverRelNormalize.buffer;
            if (serverRelNormalize.changed) {
              console.log(
                `[Server PPT] Normalized absolute relationship targets (${serverRelNormalize.stats.normalizedTargets} target(s) in ${serverRelNormalize.stats.relFilesAdjusted} rels file(s))`
              );
            }
          }
          const serverIdNormalize = await normalizeSlideNonVisualIds(pptBuffer);
          pptBuffer = serverIdNormalize.buffer;
          if (serverIdNormalize.changed) {
            console.log(
              `[Server PPT] Normalized duplicate slide shape ids (${serverIdNormalize.stats.reassignedIds} id reassignment(s) across ${serverIdNormalize.stats.slidesAdjusted} slide(s))`
            );
          }
          const serverCtReconcile = await reconcileContentTypesAndPackage(pptBuffer);
          pptBuffer = serverCtReconcile.buffer;
          if (serverCtReconcile.changed) {
            const touched = [
              ...(serverCtReconcile.stats.addedOverrides || []),
              ...(serverCtReconcile.stats.correctedOverrides || []),
              ...(serverCtReconcile.stats.removedDangling || []),
            ].length;
            console.log(
              `[Server PPT] Reconciled content types (${touched} override adjustment(s))`
            );
          }
          // Preserve metrics attached by builder after buffer replacement.
          if (pptMetrics && Buffer.isBuffer(pptBuffer)) {
            pptBuffer.__pptMetrics = pptMetrics;
          }
          const { zip: serverZip } = await readPPTX(pptBuffer);
          const serverRelFileSafety = await scanRelationshipTargets(serverZip);
          if (serverRelFileSafety.missingInternalTargets.length > 0) {
            const preview = serverRelFileSafety.missingInternalTargets
              .slice(0, 5)
              .map((m) => `${m.relFile} -> ${m.target} (${m.reason})`)
              .join(' | ');
            throw new Error(
              `Server PPT file safety check failed: ${serverRelFileSafety.missingInternalTargets.length} broken internal target(s); ${preview}`
            );
          }
          if (
            Array.isArray(serverRelFileSafety.invalidExternalTargets) &&
            serverRelFileSafety.invalidExternalTargets.length > 0
          ) {
            const preview = serverRelFileSafety.invalidExternalTargets
              .slice(0, 5)
              .map((m) => `${m.relFile} -> ${m.target || '(empty)'} (${m.reason})`)
              .join(' | ');
            throw new Error(
              `Server PPT external file safety check failed: ${serverRelFileSafety.invalidExternalTargets.length} invalid external target(s); ${preview}`
            );
          }
          const serverPackageConsistency = await scanPackageConsistency(serverZip);
          const serverPackageIssues = collectPptPackageIssues(serverPackageConsistency);
          if (serverPackageIssues.length > 0) {
            throw new Error(
              `Server PPT package consistency failed: ${serverPackageIssues.join(' | ')}`
            );
          }

          // Style match policy:
          // Hard-fail on structural build loss and template style regressions.
          // Overflow remains warning-level to preserve content depth.
          if (pptMetrics) {
            const templateTotal = Number(pptMetrics.templateTotal || 0);
            const failureCount = Number(pptMetrics.slideRenderFailureCount || 0);
            const failureRate = templateTotal > 0 ? failureCount / templateTotal : 0;

            if (failureRate > 0.35 || failureCount >= 10) {
              throw new Error(
                `PPT building quality failed: failures=${failureCount}, totalBlocks=${templateTotal}, failureRate=${failureRate.toFixed(2)}`
              );
            }

            const formattingReferenceNotes = [];
            const formattingWarnings = [];
            if (Number(pptMetrics.formattingAuditCriticalCount || 0) > 0) {
              formattingWarnings.push(
                `formatAuditCritical=${Number(pptMetrics.formattingAuditCriticalCount || 0)}`
              );
            }
            if (Number(pptMetrics.templateCoverage || 0) < 95) {
              formattingReferenceNotes.push(`templateCoverage=${pptMetrics.templateCoverage}%`);
            }
            if (Number(pptMetrics.tableRecoveryCount || 0) > 0) {
              formattingReferenceNotes.push(`tableRecoveries=${pptMetrics.tableRecoveryCount}`);
            }
            if (Number(pptMetrics.nonTemplatePatternCount || 0) > 0) {
              formattingReferenceNotes.push(
                `nonTemplatePatterns=${pptMetrics.nonTemplatePatternCount}`
              );
            }
            if (Number(pptMetrics.fallbackTemplateMappingCount || 0) > 0) {
              formattingReferenceNotes.push(
                `fallbackTemplateMappings=${pptMetrics.fallbackTemplateMappingCount}`
              );
            }
            if (Number(pptMetrics.geometryIssueCount || 0) > 0) {
              formattingReferenceNotes.push(`geometryIssues=${pptMetrics.geometryIssueCount}`);
            }
            if (Number(pptMetrics.geometryMaxDelta || 0) > 0.1) {
              formattingReferenceNotes.push(`geometryMaxDelta=${pptMetrics.geometryMaxDelta}`);
            }
            // Template/style are reference signals now. They no longer hard-block delivery.
            if (formattingReferenceNotes.length > 0) {
              formattingWarnings.push(...formattingReferenceNotes.map((x) => `reference:${x}`));
            }
            // Overflow and other non-critical warnings remain warning-level.
            if (Number(pptMetrics.formattingAuditWarningCount || 0) > 0) {
              formattingWarnings.push(
                `formatAuditWarnings=${pptMetrics.formattingAuditWarningCount}`
              );
            }
            if (formattingWarnings.length > 0) {
              console.warn(
                `[Quality Gate] Template/style reference warnings: ${formattingWarnings.join(', ')}`
              );
            }
            if (lastRunRunInfo) {
              lastRunRunInfo.formattingWarnings = formattingWarnings;
            }
          }

          // Stage 9: hard PPT structure check before delivery.
          // This blocks malformed or clearly truncated decks from being emailed/downloaded.
          let pptStructureCheck = null;
          try {
            pptStructureCheck = await validatePPTX(pptBuffer, pptCheckExpectations);
            latestPptStructureCheck = pptStructureCheck;
          } catch (checkErr) {
            throw new Error(`PPT structural check crashed: ${checkErr.message}`);
          }

          const emptySlidesWarning = (pptStructureCheck.warnings || []).find(
            (w) => w.check === 'Empty slides'
          );
          const emptySlideMatches = emptySlidesWarning?.message?.match(/\d+/g) || [];
          const emptySlideCount = emptySlideMatches.length;
          const excessiveEmptySlides = emptySlideCount > 6;
          const structureFailures = (pptStructureCheck.failed || []).map(
            (f) => `${f.check}: expected ${f.expected}, got ${f.actual}`
          );

          if (!pptStructureCheck.valid || excessiveEmptySlides) {
            const reasons = [...structureFailures];
            if (excessiveEmptySlides) {
              reasons.push(`Empty slide threshold exceeded (${emptySlideCount} > 6)`);
            }
            throw new Error(`PPT structural check failed: ${reasons.join(' | ')}`);
          }

          if (emptySlideCount > 0) {
            console.warn(
              `[Quality Gate] PPT structure warning: ${emptySlideCount} low-content slide(s) detected (<50 chars)`
            );
          }

          // Aggregate content-size check metrics across all countries for runInfo.
          let contentSizeRisk = 'low';
          let contentSizeCompactedFields = 0;
          const contentSizeByCountry = lastRunRunInfo?.contentSizeCheck || null;
          if (contentSizeByCountry) {
            const riskOrder = { low: 0, medium: 1, high: 2 };
            for (const bg of Object.values(contentSizeByCountry)) {
              if ((riskOrder[bg.risk] || 0) > (riskOrder[contentSizeRisk] || 0)) {
                contentSizeRisk = bg.risk;
              }
              contentSizeCompactedFields += bg.compacted || 0;
            }
          }

          if (lastRunRunInfo) {
            lastRunRunInfo.ppt = pptMetrics || {
              templateCoverage: null,
              templateBackedCount: null,
              templateTotal: null,
              nonTemplatePatternCount: null,
              slideRenderFailureCount: null,
              tableRecoveryCount: null,
              geometryCheckCount: null,
              geometryAlignedCount: null,
              geometryMaxDelta: null,
              geometryIssueCount: null,
            };
            lastRunRunInfo.ppt.contentSizeRisk = contentSizeRisk;
            lastRunRunInfo.ppt.contentSizeCompactedFields = contentSizeCompactedFields;
            // Backward-compatible mirror keys.
            lastRunRunInfo.ppt.contentSizeCheckRisk = contentSizeRisk;
            lastRunRunInfo.ppt.contentSizeCheckCompactedFields = contentSizeCompactedFields;
            if (pptStructureCheck) {
              lastRunRunInfo.pptStructure = buildPptStructureSummary(pptStructureCheck);
            }
          }
          stage9Completed = true;
          if (lastRunRunInfo) {
            if (!Array.isArray(lastRunRunInfo.stage9Attempts)) {
              lastRunRunInfo.stage9Attempts = [];
            }
            lastRunRunInfo.stage9Attempts.push({
              attempt: stage9Attempt,
              pass: true,
            });
          }
          break;
        } catch (stage9Err) {
          stage9LastError = stage9Err;
          console.warn(
            `[Stage 9] Attempt ${stage9Attempt}/${MAX_STAGE9_RETRIES} failed: ${stage9Err.message}`
          );
          if (lastRunRunInfo) {
            if (!Array.isArray(lastRunRunInfo.stage9Attempts)) {
              lastRunRunInfo.stage9Attempts = [];
            }
            lastRunRunInfo.stage9Attempts.push({
              attempt: stage9Attempt,
              pass: false,
              error: stage9Err.message,
            });
          }
          if (stage9Attempt < MAX_STAGE9_RETRIES) {
            const stage9Issues = buildStageIssuesFromMessages([stage9Err.message], {
              sourceStage: '9',
              type: 'file_or_style_error',
              severity: 'high',
            });
            recordIssues(stage9Issues);
            const routedOwner = pickOwnerStage(stage9Issues, '9');
            const fix = await applyOwnerFix({
              ownerStage: routedOwner,
              sourceStage: '9',
              attempt: stage9Attempt,
              issueMessages: stage9Issues.map((x) => x.message),
              maxRetries: MAX_STAGE9_RETRIES,
              rebuildPpt: routedOwner !== '9',
            });
            if (!fix.success) {
              console.warn(
                `[Stage 9] Routed repair (owner=${routedOwner}) did not apply: ${fix.note}`
              );
            }
          }
        }
      }
      if (!stage9Completed) {
        throw new Error(
          `Stage 9 failed after ${MAX_STAGE9_RETRIES} attempts: ${stage9LastError ? stage9LastError.message : 'unknown error'}`
        );
      }

      // Stage 9a: McKinsey-style final deck review loop (max 3 rounds).
      // Reviewer gives comments, synthesis is revised, deck is rebuilt, then reviewed again.
      // Stabilized: convergence tracking, flip-flop detection, screenshot-missing fallback.
      const MAX_FINAL_DECK_REVIEW_RETRIES = 3;
      const finalDeckReviewRounds = [];
      let finalDeckReady = false;

      // Convergence tracking: count how many times each issue (normalized) has appeared.
      // If an issue appears in 2+ rounds, accept it (stop trying to fix it).
      const issueOccurrenceCount = {};
      const ISSUE_ACCEPT_THRESHOLD = 2; // Accept an issue after it appears this many times.

      // Helper: normalize issue text for dedup/convergence (lowercase, collapse whitespace, trim).
      const normalizeIssueText = (text) =>
        String(text || '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .replace(/[^a-z0-9 ]/g, '')
          .trim();

      // Helper: check if an issue has been seen enough times to accept (stop fixing).
      const isAcceptedIssue = (text) => {
        const key = normalizeIssueText(text);
        return key && (issueOccurrenceCount[key] || 0) >= ISSUE_ACCEPT_THRESHOLD;
      };

      // Helper: detect contradictions between current and prior round issues.
      // Returns the set of current issues that contradict a prior-round locked decision.
      const filterContradictoryIssues = (currentIssues, priorRounds) => {
        if (!Array.isArray(priorRounds) || priorRounds.length === 0) return currentIssues;
        const allPriorLocked = [];
        for (const round of priorRounds) {
          if (Array.isArray(round?.lockedDecisions)) {
            for (const d of round.lockedDecisions) {
              const norm = normalizeIssueText(d);
              if (norm) allPriorLocked.push(norm);
            }
          }
        }
        if (allPriorLocked.length === 0) return currentIssues;

        // An issue is contradictory if its normalized text shares >60% tokens with a locked decision.
        // This is a simple heuristic to catch "add more detail" vs "remove clutter" type flip-flops.
        const filtered = [];
        for (const issue of currentIssues) {
          const normIssue = normalizeIssueText(issue);
          const issueTokens = new Set(normIssue.split(' ').filter(Boolean));
          let isContradiction = false;
          for (const locked of allPriorLocked) {
            const lockedTokens = new Set(locked.split(' ').filter(Boolean));
            const overlap = [...issueTokens].filter((t) => lockedTokens.has(t)).length;
            const similarity =
              Math.min(issueTokens.size, lockedTokens.size) > 0
                ? overlap / Math.min(issueTokens.size, lockedTokens.size)
                : 0;
            if (similarity > 0.6) {
              isContradiction = true;
              break;
            }
          }
          if (!isContradiction) {
            filtered.push(issue);
          }
        }
        return filtered;
      };

      for (let attempt = 1; attempt <= MAX_FINAL_DECK_REVIEW_RETRIES; attempt++) {
        throwIfAborted('final deck review');
        console.log(
          `[Stage 9a] Final deck review attempt ${attempt}/${MAX_FINAL_DECK_REVIEW_RETRIES}`
        );
        const priorRounds = finalDeckReviewRounds.slice(-4);
        const reviewInput = buildFinalReviewImages(pptBuffer, 6);
        const hasScreenshots = reviewInput.imageParts.length > 0;
        const slideTextFallback = hasScreenshots
          ? []
          : await buildFinalReviewTextFallback(pptBuffer, 8);

        // Determine effective input mode for the reviewer.
        // When screenshots are missing AND text fallback is empty/minimal, mark as content-only
        // so the reviewer prompt is adjusted to do content-based review (not skip).
        let effectiveInputMode = reviewInput.inputMode;
        if (!hasScreenshots && slideTextFallback.length === 0) {
          effectiveInputMode = 'content_review_only';
        }

        if (lastRunRunInfo) {
          lastRunRunInfo.finalReviewInput = {
            mode: effectiveInputMode,
            screenshots: reviewInput.imageParts.length,
            slideTextFallbackSlides: slideTextFallback.length,
            notes: reviewInput.notes.slice(0, 6),
            updatedAt: new Date().toISOString(),
          };
        }
        let finalDeckReview = null;
        try {
          finalDeckReview = await reviewDeckBeforeDeliveryWithGeminiFlash({
            scope,
            runInfo: lastRunRunInfo,
            synthesis: finalSynthesis,
            reviewHistory: priorRounds,
            attempt,
            maxRetries: MAX_FINAL_DECK_REVIEW_RETRIES,
            imageParts: reviewInput.imageParts,
            slideTextFallback,
            inputMode: effectiveInputMode,
            inputNotes: reviewInput.notes,
          });
        } catch (reviewErr) {
          console.warn(`[Stage 9a] Gemini 3 Flash review failed: ${reviewErr.message}`);
        }

        // If the review call failed entirely (returned null), treat as a pass on last attempt
        // or skip this round (don't create phantom issues from a failed API call).
        if (!isPlainObject(finalDeckReview)) {
          console.warn(
            `[Stage 9a] Review returned null on attempt ${attempt}/${MAX_FINAL_DECK_REVIEW_RETRIES} — ` +
              (attempt >= MAX_FINAL_DECK_REVIEW_RETRIES
                ? 'accepting deck as-is (review unavailable)'
                : 'skipping round')
          );
          const skipEntry = {
            round: attempt,
            ready: attempt >= MAX_FINAL_DECK_REVIEW_RETRIES,
            confidence: 0,
            issues: [],
            actions: [],
            lockedDecisions: [],
            reviewInputMode: effectiveInputMode,
            screenshotCount: reviewInput.imageParts.length,
            slideTextFallbackSlides: slideTextFallback.length,
            reviewInputNotes: reviewInput.notes.slice(0, 6),
            ownerStage: '5a',
            appliedBy: 'skipped-null-review',
            changeSummary: ['review call failed; round skipped'],
          };
          finalDeckReviewRounds.push(skipEntry);
          if (attempt >= MAX_FINAL_DECK_REVIEW_RETRIES) {
            // On final attempt with no review available, accept the deck.
            finalDeckReady = true;
            recordFixAttempt({
              sourceStage: '9a',
              ownerStage: '5a',
              attempt,
              success: true,
              note: 'accepted deck after review unavailable on final attempt',
            });
          }
          continue;
        }

        const ready = finalDeckReview.ready === true;

        // Gather raw issues and actions from the review.
        const rawIssueMessages = [
          ...(Array.isArray(finalDeckReview.issues) ? finalDeckReview.issues : []),
          ...(Array.isArray(finalDeckReview.actions) ? finalDeckReview.actions : []),
        ];

        // Track occurrences of each issue for convergence.
        for (const msg of rawIssueMessages) {
          const key = normalizeIssueText(msg);
          if (key) {
            issueOccurrenceCount[key] = (issueOccurrenceCount[key] || 0) + 1;
          }
        }

        // Filter out issues that have been seen too many times (accepted after repeated attempts).
        const acceptedIssues = rawIssueMessages.filter((msg) => isAcceptedIssue(msg));
        const activeIssueMessages = rawIssueMessages.filter((msg) => !isAcceptedIssue(msg));

        // Filter out contradictory issues (ones that conflict with prior locked decisions).
        const nonContradictoryMessages = filterContradictoryIssues(
          activeIssueMessages,
          priorRounds
        );
        const contradictoryCount = activeIssueMessages.length - nonContradictoryMessages.length;

        if (acceptedIssues.length > 0) {
          console.log(
            `[Stage 9a] Accepted ${acceptedIssues.length} recurring issue(s) (seen ${ISSUE_ACCEPT_THRESHOLD}+ times)`
          );
        }
        if (contradictoryCount > 0) {
          console.log(
            `[Stage 9a] Filtered ${contradictoryCount} contradictory issue(s) (conflict with prior locked decisions)`
          );
        }

        // If all issues were either accepted or contradictory, treat as ready.
        const effectiveReady = ready || nonContradictoryMessages.length === 0;

        const stage9aIssues = buildStageIssuesFromMessages(nonContradictoryMessages, {
          sourceStage: '9a',
          type: 'final_deck_issue',
          severity: 'high',
        });
        if (!effectiveReady && stage9aIssues.length === 0) {
          stage9aIssues.push(
            makeStageIssue({
              type: 'final_deck_issue',
              severity: 'high',
              message: 'final deck reviewer marked not ready',
              ownerStage: '5a',
              sourceStage: '9a',
            })
          );
        }
        if (stage9aIssues.length > 0) {
          recordIssues(stage9aIssues);
        }
        const routedOwner = pickOwnerStage(stage9aIssues, '5a');

        const roundEntry = {
          round: attempt,
          ready: effectiveReady,
          confidence: Number(finalDeckReview.confidence || 0),
          issues: Array.isArray(finalDeckReview.issues) ? finalDeckReview.issues.slice(0, 10) : [],
          actions: Array.isArray(finalDeckReview.actions)
            ? finalDeckReview.actions.slice(0, 10)
            : [],
          lockedDecisions: Array.isArray(finalDeckReview.lockedDecisions)
            ? finalDeckReview.lockedDecisions.slice(0, 20)
            : [],
          reviewInputMode: effectiveInputMode,
          screenshotCount: reviewInput.imageParts.length,
          slideTextFallbackSlides: slideTextFallback.length,
          reviewInputNotes: reviewInput.notes.slice(0, 6),
          ownerStage: routedOwner,
          appliedBy: null,
          changeSummary: [],
          acceptedRecurringIssues: acceptedIssues.length,
          filteredContradictions: contradictoryCount,
        };
        finalDeckReviewRounds.push(roundEntry);

        if (effectiveReady) {
          recordFixAttempt({
            sourceStage: '9a',
            ownerStage: routedOwner,
            attempt,
            success: true,
            note: ready
              ? 'final deck reviewer marked ready'
              : `accepted after filtering: ${acceptedIssues.length} recurring, ${contradictoryCount} contradictory`,
          });
          finalDeckReady = true;
          break;
        }

        // Primary path: apply reviewer comments directly to synthesis with memory of prior rounds.
        let applied = false;
        try {
          const revision = await applySlideReviewChangesWithGeminiFlash({
            synthesis: finalSynthesis,
            scope,
            review: {
              ...finalDeckReview,
              // Only pass non-contradictory, non-accepted issues to the fixer.
              issues: nonContradictoryMessages.filter((m) =>
                (finalDeckReview.issues || []).includes(m)
              ),
              actions: nonContradictoryMessages.filter((m) =>
                (finalDeckReview.actions || []).includes(m)
              ),
            },
            reviewHistory: finalDeckReviewRounds.slice(0, -1),
            round: attempt,
            maxRounds: MAX_FINAL_DECK_REVIEW_RETRIES,
          });
          if (isPlainObject(revision?.synthesis)) {
            finalSynthesis = revision.synthesis;
            roundEntry.changeSummary = Array.isArray(revision.changeSummary)
              ? revision.changeSummary.slice(0, 20)
              : [];
            if (Array.isArray(revision.lockedDecisions) && revision.lockedDecisions.length > 0) {
              roundEntry.lockedDecisions = [
                ...new Set([...(roundEntry.lockedDecisions || []), ...revision.lockedDecisions]),
              ].slice(0, 25);
            }
            roundEntry.appliedBy = 'mckinsey-review-edit';
            applied = true;
            recordFixAttempt({
              sourceStage: '9a',
              ownerStage: '5a',
              attempt,
              success: true,
              note: 'applied mckinsey reviewer comments to synthesis',
            });
          }
        } catch (applyErr) {
          console.warn(`[Stage 9a] Reviewer-comment apply failed: ${applyErr.message}`);
        }

        // Fallback path: owner-stage router fix.
        if (!applied) {
          const fix = await applyOwnerFix({
            ownerStage: routedOwner,
            sourceStage: '9a',
            attempt,
            issueMessages: stage9aIssues.map((x) => x.message),
            maxRetries: MAX_FINAL_DECK_REVIEW_RETRIES,
            rebuildPpt: false,
          });
          roundEntry.appliedBy = `owner-router:${routedOwner}`;
          roundEntry.changeSummary = [fix.note];
          if (!fix.success) {
            console.warn(
              `[Stage 9a] Routed repair (owner=${routedOwner}) did not apply: ${fix.note}`
            );
          }
        }

        // Rebuild deck after each non-ready review round.
        try {
          pptBuffer = await generatePPT(finalSynthesis, countryAnalyses, scope);
          pptMetrics = (pptBuffer && (pptBuffer.__pptMetrics || pptBuffer.pptMetrics)) || null;
          if (typeof normalizeAbsoluteRelationshipTargets === 'function') {
            const retryRelNormalize = await normalizeAbsoluteRelationshipTargets(pptBuffer);
            pptBuffer = retryRelNormalize.buffer;
          }
          const retryIdNormalize = await normalizeSlideNonVisualIds(pptBuffer);
          pptBuffer = retryIdNormalize.buffer;
          const retryCtReconcile = await reconcileContentTypesAndPackage(pptBuffer);
          pptBuffer = retryCtReconcile.buffer;
          if (pptMetrics && Buffer.isBuffer(pptBuffer)) {
            pptBuffer.__pptMetrics = pptMetrics;
          }
          latestPptStructureCheck = await validatePPTX(pptBuffer, pptCheckExpectations);
          if (lastRunRunInfo) {
            lastRunRunInfo.ppt = pptMetrics || lastRunRunInfo.ppt || null;
            lastRunRunInfo.pptStructure = buildPptStructureSummary(latestPptStructureCheck);
          }
        } catch (rebuildErr) {
          roundEntry.changeSummary.push(`rebuild/check failed: ${rebuildErr.message}`);
          console.warn(`[Stage 9a] Rebuild/check after review round failed: ${rebuildErr.message}`);
        }
      }
      if (lastRunRunInfo) {
        lastRunRunInfo.finalDeckReviewLoop = {
          retries: MAX_FINAL_DECK_REVIEW_RETRIES,
          attempts: finalDeckReviewRounds,
          latestPptStructureCheck: buildPptStructureSummary(latestPptStructureCheck),
          reviewMode: 'mckinsey-style',
          convergenceTracking: {
            issueOccurrences: Object.keys(issueOccurrenceCount).length,
            acceptedAfterThreshold: Object.values(issueOccurrenceCount).filter(
              (c) => c >= ISSUE_ACCEPT_THRESHOLD
            ).length,
          },
        };
      }
      if (!finalDeckReady) {
        // On exhaustion, accept the deck with warnings instead of hard-failing.
        // The prior stages (9, 5a, 3a) already validated content and structure;
        // the final review is a polish pass, not a correctness gate.
        console.warn(
          `[Stage 9a] Final deck review did not converge after ${MAX_FINAL_DECK_REVIEW_RETRIES} rounds — accepting deck with warnings`
        );
        const previewIssues = finalDeckReviewRounds
          .slice(-1)
          .flatMap((x) => x.issues || [])
          .slice(0, 6)
          .join(' | ');
        if (lastRunRunInfo) {
          lastRunRunInfo.finalDeckReviewLoop.acceptedWithWarnings = true;
          lastRunRunInfo.finalDeckReviewLoop.remainingIssues = previewIssues || 'none';
        }
        // Do NOT throw — accept the deck. Prior quality gates already passed.
        finalDeckReady = true;
      }

      // Clean up rawData AFTER PPT generation to free memory (citations already used by PPT builder)
      for (const ca of countryAnalyses) {
        if (ca.rawData) {
          delete ca.rawData;
        }
      }

      // Stage 10: Send email
      throwIfAborted('delivery');
      const filename = `Market_Research_${scope.industry.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pptx`;
      const finalFilename = draftPptMode ? filename.replace(/\.pptx$/i, '_DRAFT.pptx') : filename;
      lastGeneratedPpt = {
        filename: finalFilename,
        generatedAt: new Date().toISOString(),
        draftPptMode: Boolean(draftPptMode),
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        buffer: Buffer.from(pptBuffer),
      };

      const emailHtml = `
      <p>Your market research report is attached.</p>
      ${draftPptMode ? '<p><strong>Mode:</strong> Draft PPT (quality gates bypassed for formatting QA)</p>' : ''}
      <p style="color: #666; font-size: 12px;">${escapeHtml(scope.industry)} - ${escapeHtml(scope.targetMarkets.join(', '))}</p>
    `;

      await sendEmail({
        to: email,
        subject: `Market Research: ${scope.industry} - ${scope.targetMarkets.join(', ')}`,
        html: emailHtml,
        attachments: {
          filename: finalFilename,
          content: pptBuffer.toString('base64'),
        },
        fromName: 'Market Research AI',
      });

      const totalTime = (Date.now() - startTime) / 1000;
      console.log('\n========================================');
      console.log('MARKET RESEARCH - COMPLETE');
      console.log('========================================');
      console.log(
        `Total time: ${totalTime.toFixed(0)} seconds (${(totalTime / 60).toFixed(1)} minutes)`
      );
      console.log(`Total cost: $${costTracker.totalCost.toFixed(2)}`);
      console.log(`Countries analyzed: ${countryAnalyses.length}`);

      // Estimate costs from internal costTracker by aggregating per model
      const modelTokens = {};
      for (const call of costTracker.calls) {
        if (!modelTokens[call.model]) {
          modelTokens[call.model] = { input: 0, output: 0 };
        }
        modelTokens[call.model].input += call.inputTokens || 0;
        modelTokens[call.model].output += call.outputTokens || 0;
      }
      // Add model calls to shared tracker (pass numeric token counts directly)
      for (const [model, tokens] of Object.entries(modelTokens)) {
        tracker.addModelCall(model, tokens.input, tokens.output);
      }

      // Track usage
      await tracker.finish({
        countriesAnalyzed: countryAnalyses.length,
        industry: scope.industry,
      });

      return {
        success: true,
        scope,
        countriesAnalyzed: countryAnalyses.length,
        totalCost: costTracker.totalCost,
        totalTimeSeconds: totalTime,
      };
    } catch (error) {
      console.error('Market research failed:', error);
      lastRunRunInfo = {
        ...(lastRunRunInfo || {}),
        timestamp: new Date().toISOString(),
        stage: 'error',
        error: error.message,
        issueLog: [],
        fixAttempts: [],
        ownerStageCounts: {},
        finalOwnerThatSolved: null,
      };
      await tracker.finish({ status: 'error', error: error.message }).catch(() => {});

      // Try to send error email
      try {
        await sendEmail({
          to: email,
          subject: 'Market Research Failed',
          html: `
        <h2>Market Research Error</h2>
        <p>Your market research request encountered an error:</p>
        <pre>${escapeHtml(error.message)}</pre>
        <p>Please try again or contact support.</p>
      `,
          attachments: {
            filename: 'error.txt',
            content: Buffer.from(error.message).toString('base64'),
          },
          fromName: 'Market Research AI',
        });
      } catch (emailError) {
        console.error('Failed to send error email:', emailError);
      }

      // Mark that error email was already sent to prevent double-send from outer catch
      error._errorEmailSent = true;
      throw error;
    }
  }); // end trackingContext.run
}

// ============ API ENDPOINTS ============

// Main research endpoint
app.post('/api/market-research', async (req, res) => {
  const { prompt, email, options, templateSlideSelections, templateStrictMode, draftPptMode } =
    req.body;

  if (!prompt || !email) {
    return res.status(400).json({ error: 'Missing required fields: prompt, email' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  // Respond immediately - research runs in background
  res.json({
    success: true,
    message: 'Market research started. Results will be emailed when complete.',
    estimatedTime: '30-60 minutes',
  });

  // Run research in background with a global pipeline timeout + abort signal
  const controller = new AbortController();
  const timeoutMinutes = Math.max(1, Math.round(PIPELINE_TIMEOUT_MS / 60000));
  let timeoutId = null;
  if (PIPELINE_TIMEOUT_MS > 0) {
    timeoutId = setTimeout(() => {
      controller.abort(new Error(`Pipeline timeout after ${timeoutMinutes} minutes`));
    }, PIPELINE_TIMEOUT_MS);
  } else {
    console.log('[API] Pipeline timeout disabled (PIPELINE_TIMEOUT_SECONDS=0)');
  }
  const mergedOptions = { ...(options || {}) };
  if (templateSlideSelections && typeof templateSlideSelections === 'object') {
    mergedOptions.templateSlideSelections = templateSlideSelections;
  }
  if (typeof templateStrictMode === 'boolean') {
    mergedOptions.templateStrictMode = templateStrictMode;
  }
  const parsedDraftPptMode = parseBooleanOption(draftPptMode, null);
  if (parsedDraftPptMode !== null) {
    mergedOptions.draftPptMode = ALLOW_DRAFT_PPT_MODE ? parsedDraftPptMode : false;
    if (parsedDraftPptMode && !ALLOW_DRAFT_PPT_MODE) {
      console.warn('[API] Ignoring draftPptMode=true because ALLOW_DRAFT_PPT_MODE is disabled');
    }
  }
  // Legacy aliases intentionally ignored to prevent accidental readiness bypass.
  // Draft mode now requires explicit `draftPptMode=true`.
  mergedOptions.abortSignal = controller.signal;
  runMarketResearch(prompt, email, mergedOptions)
    .then(() => {
      if (timeoutId) clearTimeout(timeoutId);
    })
    .catch(async (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      console.error('Background research failed:', error);
      // Only send error email if runMarketResearch didn't already send one
      if (!error._errorEmailSent) {
        try {
          await sendEmail({
            to: email,
            subject: 'Market Research Failed',
            html: `<h2>Market Research Error</h2><p>Your request failed: ${escapeHtml(error.message)}</p><p>Please try again.</p>`,
            fromName: 'Market Research AI',
          });
        } catch (emailErr) {
          console.error('Failed to send error email:', emailErr);
        }
      }
    });
});

// Cost tracking endpoint
app.get('/api/costs', (req, res) => {
  res.json(costTracker);
});

// Pipeline runInfo endpoint
app.get('/api/runInfo', (req, res) => {
  if (!lastRunRunInfo) {
    return res.json({ available: false, message: 'No completed run yet' });
  }
  res.json({ available: true, ...lastRunRunInfo });
});

// Plain-English system map endpoint for operators.
app.get('/api/system-map', (req, res) => {
  res.json({
    available: true,
    generatedAt: new Date().toISOString(),
    ...SYSTEM_MAP,
  });
});

// Latest generated PPT artifact download endpoint (for QA and local review).
app.get('/api/latest-ppt', (req, res) => {
  if (!lastGeneratedPpt || !Buffer.isBuffer(lastGeneratedPpt.buffer)) {
    return res.status(404).json({ available: false, message: 'No generated PPT available yet' });
  }
  const safeName = String(lastGeneratedPpt.filename || 'market_research.pptx').replace(
    /[\r\n"]/g,
    '_'
  );
  res.setHeader(
    'Content-Type',
    lastGeneratedPpt.contentType ||
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('X-PPT-Generated-At', String(lastGeneratedPpt.generatedAt || ''));
  res.setHeader('X-PPT-Draft-Mode', String(Boolean(lastGeneratedPpt.draftPptMode)));
  return res.send(lastGeneratedPpt.buffer);
});

// ============ START SERVER ============

function startServer() {
  const PORT = process.env.PORT || 3010;
  const server = app.listen(PORT, () => {
    console.log(`Market Research server running on port ${PORT}`);
    console.log('Environment check:');
    console.log('  - GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'Set' : 'MISSING');
    console.log('  - SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'Set' : 'MISSING');
    console.log('  - SENDER_EMAIL:', process.env.SENDER_EMAIL || 'MISSING');
    console.log('  - CONTENT_FIRST_MODE:', CONTENT_FIRST_MODE ? 'ON (default)' : 'OFF');
  });
  server.on('error', (error) => {
    console.error('[Startup] HTTP listen failed:', error?.message || error);
    // Exit so Railway marks the deploy unhealthy immediately with a clear reason.
    process.exit(1);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  __test: {
    buildPptGateBlocks,
    normalizeGateChartData,
    buildGateContent,
    collectPreRenderStructureIssues,
  },
};
