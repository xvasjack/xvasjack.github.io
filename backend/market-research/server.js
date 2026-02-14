// Redeploy trigger: 2026-02-05
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { securityHeaders, rateLimiter, escapeHtml } = require('./shared/security');
const { requestLogger, healthCheck } = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { createTracker, trackingContext } = require('./shared/tracking');

// Extracted modules
const { costTracker, callGeminiResearch, resetBudget } = require('./ai-clients');
const { parseScope } = require('./research-framework');
const { researchCountry, synthesizeFindings } = require('./research-orchestrator');
const { generatePPT } = require('./ppt-multi-country');
const {
  validateResearchQuality,
  validateSynthesisQuality,
  validatePptData,
} = require('./quality-gates');
const {
  validatePPTX,
  readPPTX,
  scanRelationshipTargets,
  scanPackageConsistency,
  normalizeAbsoluteRelationshipTargets,
  normalizeSlideNonVisualIds,
  reconcileContentTypesAndPackage,
} = require('./pptx-validator');
const { runBudgetGate } = require('./budget-gate');

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

// Pipeline diagnostics — stored after each run, exposed via /api/diagnostics
let lastRunDiagnostics = null;
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

function parsePositiveIntEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeIntEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

const ALLOW_DRAFT_PPT_MODE = parseBooleanOption(process.env.ALLOW_DRAFT_PPT_MODE, false) === true;
const SOFT_READINESS_GATE = parseBooleanOption(process.env.SOFT_READINESS_GATE, true) !== false;
const DISABLE_PIPELINE_TIMEOUT =
  parseBooleanOption(process.env.DISABLE_PIPELINE_TIMEOUT, true) !== false;
const HARD_FAIL_MIN_EFFECTIVE_SCORE = parsePositiveIntEnv('HARD_FAIL_MIN_EFFECTIVE_SCORE', 70);
const HARD_FAIL_MIN_COHERENCE_SCORE = parsePositiveIntEnv('HARD_FAIL_MIN_COHERENCE_SCORE', 70);
const FINAL_REVIEW_MAX_CRITICAL_ISSUES = parseNonNegativeIntEnv(
  'FINAL_REVIEW_MAX_CRITICAL_ISSUES',
  1
);
const FINAL_REVIEW_MAX_MAJOR_ISSUES = parsePositiveIntEnv('FINAL_REVIEW_MAX_MAJOR_ISSUES', 3);
const FINAL_REVIEW_MAX_OPEN_GAPS = parsePositiveIntEnv('FINAL_REVIEW_MAX_OPEN_GAPS', 3);
// Timeout is disabled by default to avoid auto-closing long market-research runs.
// Re-enable by setting DISABLE_PIPELINE_TIMEOUT=false and PIPELINE_TIMEOUT_SECONDS>0.
const PIPELINE_TIMEOUT_MS = DISABLE_PIPELINE_TIMEOUT
  ? 0
  : parseNonNegativeIntEnv('PIPELINE_TIMEOUT_SECONDS', 45 * 60) * 1000;
const CANONICAL_MARKET_SECTION_KEYS = [
  'marketSizeAndGrowth',
  'supplyAndDemandDynamics',
  'pricingAndTariffStructures',
];
const CANONICAL_POLICY_SECTION_KEYS = [
  'foundationalActs',
  'nationalPolicy',
  'investmentRestrictions',
  'regulatorySummary',
  'keyIncentives',
  'sources',
];
const REQUIRED_POLICY_SECTION_KEYS = [
  'foundationalActs',
  'nationalPolicy',
  'investmentRestrictions',
];
const CANONICAL_COMPETITOR_SECTION_KEYS = [
  'japanesePlayers',
  'localMajor',
  'foreignPlayers',
  'caseStudy',
  'maActivity',
];
// Japanese competitor coverage is desirable but may be legitimately unavailable in some markets.
// Hard-gating on it causes expensive false negatives despite otherwise complete competitor analysis.
const REQUIRED_COMPETITOR_SECTION_KEYS = ['localMajor', 'foreignPlayers'];
const CANONICAL_SUMMARY_SECTION_KEYS = [
  'timingIntelligence',
  'lessonsLearned',
  'opportunities',
  'obstacles',
  'ratings',
  'keyInsights',
  'recommendation',
  'goNoGo',
];
const REQUIRED_SUMMARY_SECTION_KEYS = [
  'timingIntelligence',
  'lessonsLearned',
  'keyInsights',
  'recommendation',
  'goNoGo',
];
const CANONICAL_DEPTH_SECTION_KEYS = [
  'dealEconomics',
  'partnerAssessment',
  'entryStrategy',
  'implementation',
  'targetSegments',
];
const REQUIRED_DEPTH_SECTION_KEYS = [
  'dealEconomics',
  'partnerAssessment',
  'entryStrategy',
  'implementation',
  'targetSegments',
];
const TRANSIENT_SECTION_KEY_PATTERNS = [
  /^section[_-]?\d+$/i,
  /^gap[_-]?\d+$/i,
  /^verify[_-]?\d+$/i,
  /^final[_-]?review[_-]?gap[_-]?\d+$/i,
  /^deepen[_-]?/i,
  /deepen/i,
  /_wasarray/i,
];

function isTransientSectionKey(key) {
  const normalized = String(key || '').trim();
  if (!normalized) return true;
  return TRANSIENT_SECTION_KEY_PATTERNS.some((re) => re.test(normalized));
}

function isTransientTopLevelKey(key) {
  const normalized = String(key || '').trim();
  if (!normalized) return false;
  const compact = normalized.replace(/\s+/g, '').toLowerCase();
  // `finalReview` is stable metadata emitted by review stages and must not trip transient-key guard.
  if (compact === 'finalreview') return false;
  if (compact === '_wasarray') return true;
  if (/^section[_-]?\d+$/i.test(normalized)) return true;
  if (/deepen/i.test(normalized)) return true;
  if (/^final[_-]?review(?:[_-]?(?:gap|issue))?\d+$/i.test(normalized)) return true;
  if (/^finalreview(?:gap|issue)\d+$/i.test(compact)) return true;
  return false;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function collectPreRenderStructureIssues(countryAnalyses) {
  const issues = [];
  const requiredSections = ['policy', 'market', 'competitors', 'depth', 'summary'];

  for (const ca of countryAnalyses || []) {
    const country = ca?.country || 'Unknown';
    const countryPrefix = `${country}:`;

    for (const section of requiredSections) {
      if (!isPlainObject(ca?.[section])) {
        issues.push(`${countryPrefix} section "${section}" must be a JSON object`);
      }
    }

    if (isPlainObject(ca)) {
      for (const key of Object.keys(ca)) {
        if (isTransientTopLevelKey(key)) {
          issues.push(`${countryPrefix} transient top-level key "${key}" is not allowed`);
        }
      }
    }

    if (isPlainObject(ca?.market)) {
      const marketKeys = Object.keys(ca.market).filter((k) => !String(k).startsWith('_'));
      const transientMarketKeys = marketKeys.filter((k) => isTransientSectionKey(k));
      if (transientMarketKeys.length > 0) {
        issues.push(
          `${countryPrefix} market has transient sections: ${transientMarketKeys.join(', ')}`
        );
      }
      const invalid = marketKeys.filter((k) => !CANONICAL_MARKET_SECTION_KEYS.includes(k));
      if (invalid.length > 0) {
        issues.push(`${countryPrefix} market has non-canonical sections: ${invalid.join(', ')}`);
      }

      const missing = CANONICAL_MARKET_SECTION_KEYS.filter((k) => !(k in ca.market));
      if (missing.length > 0) {
        issues.push(`${countryPrefix} market missing canonical sections: ${missing.join(', ')}`);
      }
    }

    if (isPlainObject(ca?.policy)) {
      const policyKeys = Object.keys(ca.policy).filter((k) => !String(k).startsWith('_'));
      const transientPolicyKeys = policyKeys.filter((k) => isTransientSectionKey(k));
      if (transientPolicyKeys.length > 0) {
        issues.push(
          `${countryPrefix} policy has transient sections: ${transientPolicyKeys.join(', ')}`
        );
      }
      const invalid = policyKeys.filter((k) => !CANONICAL_POLICY_SECTION_KEYS.includes(k));
      if (invalid.length > 0) {
        issues.push(`${countryPrefix} policy has non-canonical sections: ${invalid.join(', ')}`);
      }
      const missing = REQUIRED_POLICY_SECTION_KEYS.filter((k) => !(k in ca.policy));
      if (missing.length > 0) {
        issues.push(`${countryPrefix} policy missing required sections: ${missing.join(', ')}`);
      }
    }

    if (isPlainObject(ca?.competitors)) {
      const competitorKeys = Object.keys(ca.competitors).filter((k) => !String(k).startsWith('_'));
      const transientCompetitorKeys = competitorKeys.filter((k) => isTransientSectionKey(k));
      if (transientCompetitorKeys.length > 0) {
        issues.push(
          `${countryPrefix} competitors has transient sections: ${transientCompetitorKeys.join(', ')}`
        );
      }
      const invalid = competitorKeys.filter((k) => !CANONICAL_COMPETITOR_SECTION_KEYS.includes(k));
      if (invalid.length > 0) {
        issues.push(
          `${countryPrefix} competitors has non-canonical sections: ${invalid.join(', ')}`
        );
      }
      const missing = REQUIRED_COMPETITOR_SECTION_KEYS.filter((k) => !(k in ca.competitors));
      if (missing.length > 0) {
        issues.push(
          `${countryPrefix} competitors missing required sections: ${missing.join(', ')}`
        );
      }
    }

    if (isPlainObject(ca?.summary)) {
      const summaryKeys = Object.keys(ca.summary).filter((k) => !String(k).startsWith('_'));
      const transientSummaryKeys = summaryKeys.filter((k) => isTransientSectionKey(k));
      if (transientSummaryKeys.length > 0) {
        issues.push(
          `${countryPrefix} summary has transient sections: ${transientSummaryKeys.join(', ')}`
        );
      }
      const invalid = summaryKeys.filter((k) => !CANONICAL_SUMMARY_SECTION_KEYS.includes(k));
      if (invalid.length > 0) {
        issues.push(`${countryPrefix} summary has non-canonical sections: ${invalid.join(', ')}`);
      }
      const missing = REQUIRED_SUMMARY_SECTION_KEYS.filter((k) => !(k in ca.summary));
      if (missing.length > 0) {
        issues.push(`${countryPrefix} summary missing required sections: ${missing.join(', ')}`);
      }
    }

    if (isPlainObject(ca?.depth)) {
      const depthKeys = Object.keys(ca.depth).filter((k) => !String(k).startsWith('_'));
      const transientDepthKeys = depthKeys.filter((k) => isTransientSectionKey(k));
      if (transientDepthKeys.length > 0) {
        issues.push(
          `${countryPrefix} depth has transient sections: ${transientDepthKeys.join(', ')}`
        );
      }
      const invalid = depthKeys.filter((k) => !CANONICAL_DEPTH_SECTION_KEYS.includes(k));
      if (invalid.length > 0) {
        issues.push(`${countryPrefix} depth has non-canonical sections: ${invalid.join(', ')}`);
      }
      const missing = REQUIRED_DEPTH_SECTION_KEYS.filter((k) => !(k in ca.depth));
      if (missing.length > 0) {
        issues.push(`${countryPrefix} depth missing required sections: ${missing.join(', ')}`);
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

      // Stage 1: Parse scope
      throwIfAborted('scope parsing');
      const scope = await parseScope(userPrompt);
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

      // Stage 2: Research each country (in parallel with limit)
      console.log('\n=== STAGE 2: COUNTRY RESEARCH ===');
      console.log(`Researching ${scope.targetMarkets.length} countries...`);

      const countryAnalyses = [];
      const countryResearchFailures = [];

      // Process countries in batches of 2 to manage API rate limits
      for (let i = 0; i < scope.targetMarkets.length; i += 2) {
        const batch = scope.targetMarkets.slice(i, i + 2);
        throwIfAborted(`country research (${batch.join(', ')})`);
        const batchResults = await Promise.allSettled(
          batch.map((country) =>
            researchCountry(country, scope.industry, scope.clientContext, scope)
          )
        );
        const successResults = batchResults
          .filter((r) => r.status === 'fulfilled')
          .map((r) => r.value);
        const failedCountries = batchResults
          .filter((r) => r.status === 'rejected')
          .map((r, i) => ({ country: batch[i], error: r.reason.message }));
        if (failedCountries.length) console.error('Failed countries:', failedCountries);
        if (failedCountries.length) {
          countryResearchFailures.push(...failedCountries);
        }
        for (const result of successResults) {
          if (result?.error) {
            countryResearchFailures.push({
              country: result.country || '(unknown)',
              error: result.error,
              detail: result.message || null,
            });
          }
        }
        countryAnalyses.push(...successResults);
      }
      if (countryResearchFailures.length > 0) {
        const summary = countryResearchFailures
          .map((item) => `${item.country}: ${item.error}${item.detail ? ` (${item.detail})` : ''}`)
          .join(' | ');
        if (lastRunDiagnostics) {
          lastRunDiagnostics.stage = 'country_research_failed';
          lastRunDiagnostics.countryResearchFailures = countryResearchFailures.slice(0, 20);
          lastRunDiagnostics.error = `Country research failed: ${summary}`;
        }
        throw new Error(`Country research failed: ${summary}`);
      }

      // Quality Gate 1: Validate research quality per country and retry weak topics
      for (const ca of countryAnalyses) {
        if (!ca.rawData) continue;
        throwIfAborted(`research validation (${ca.country})`);
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

      // Collect pipeline diagnostics for each country
      lastRunDiagnostics = {
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
          synthesisScores: ca.contentValidation?.scores || null,
          synthesisFailures: ca.contentValidation?.failures || [],
          synthesisValid: ca.contentValidation?.valid ?? null,
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
      };

      // Depth/readiness gate: block clearly weak outputs before synthesis/PPT generation.
      const notReadyCountries = countryAnalyses.filter((ca) => ca && ca.readyForClient === false);
      if (notReadyCountries.length > 0) {
        const notReadyDiagnostics = notReadyCountries.map((ca) => ({
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
          synthesisFailures: Array.isArray(ca?.contentValidation?.failures)
            ? ca.contentValidation.failures
            : [],
        }));
        const list = notReadyCountries
          .map((ca) => {
            const score = Number(ca?.readiness?.effectiveScore || 0);
            const coherence = Number(ca?.readiness?.finalReviewCoherence || 0);
            const critical = Number(ca?.readiness?.finalReviewCritical || 0);
            const major = Number(ca?.readiness?.finalReviewMajor || 0);
            const openGaps = Number(ca?.readiness?.finalReviewOpenGaps || 0);
            return `${ca.country} (effective=${score}, coherence=${coherence}, critical=${critical}, major=${major}, openGaps=${openGaps})`;
          })
          .join(', ');
        const reasons = notReadyDiagnostics
          .map((d) => {
            const readinessReasons = Array.isArray(d.readinessReasons)
              ? d.readinessReasons.filter(Boolean)
              : [];
            return `${d.country}: ${readinessReasons.length > 0 ? readinessReasons.join('; ') : 'readiness flag is false'}`;
          })
          .join(' | ');
        const gateRule = `Readiness requires effective>=80, content-depth>=80, final coherence>=80, critical<=${FINAL_REVIEW_MAX_CRITICAL_ISSUES}, major<=${FINAL_REVIEW_MAX_MAJOR_ISSUES}, openGaps<=${FINAL_REVIEW_MAX_OPEN_GAPS}.`;
        const draftBypassEligible = notReadyDiagnostics.every(
          (d) =>
            Number(d.finalReviewCritical || 0) === 0 &&
            Number(d.finalReviewMajor || 0) === 0 &&
            Number(d.finalReviewOpenGaps || 0) === 0
        );
        const hardFailReadiness = notReadyDiagnostics.some((d) => {
          const critical = Number(d.finalReviewCritical || 0);
          const major = Number(d.finalReviewMajor || 0);
          const effective = Number(d.effectiveScore || 0);
          const coherence = Number(d.finalReviewCoherence || 0);
          if (critical > FINAL_REVIEW_MAX_CRITICAL_ISSUES) return true;
          // Hard-fail only when major issue count is materially beyond tolerance.
          if (major > FINAL_REVIEW_MAX_MAJOR_ISSUES + 1) return true;
          if (effective < HARD_FAIL_MIN_EFFECTIVE_SCORE) return true;
          if (coherence < HARD_FAIL_MIN_COHERENCE_SCORE) return true;
          return false;
        });
        if (draftPptMode && draftBypassEligible) {
          console.warn(
            `[Quality Gate] Draft PPT mode enabled — bypassing readiness block for: ${list}`
          );
          if (lastRunDiagnostics) {
            lastRunDiagnostics.stage = 'quality_gate_bypassed_draft';
            lastRunDiagnostics.notReadyCountries = notReadyDiagnostics;
            lastRunDiagnostics.qualityGateBypassedForDraft = true;
          }
        } else {
          if (draftPptMode && !draftBypassEligible) {
            console.warn(
              `[Quality Gate] Draft PPT mode cannot bypass readiness when critical/major/open gaps are present: ${list}`
            );
          }
          if (SOFT_READINESS_GATE && !hardFailReadiness) {
            console.warn(
              `[Quality Gate] Soft gate: countries not fully ready but continuing with warnings: ${list}`
            );
            if (lastRunDiagnostics) {
              lastRunDiagnostics.stage = 'quality_gate_soft_warning';
              lastRunDiagnostics.notReadyCountries = notReadyDiagnostics;
              lastRunDiagnostics.readinessWarning = `${gateRule} Reasons: ${reasons}`;
              lastRunDiagnostics.qualityGateSoftBypass = true;
            }
          } else {
            if (lastRunDiagnostics) {
              lastRunDiagnostics.stage = 'quality_gate_failed';
              lastRunDiagnostics.notReadyCountries = notReadyDiagnostics;
              lastRunDiagnostics.error = `Country analysis quality gate failed: ${list}. ${gateRule} Reasons: ${reasons}`;
              lastRunDiagnostics.hardFailReadiness = hardFailReadiness;
            }
            console.warn(`[Quality Gate] Countries not fully ready: ${list}`);
            throw new Error(
              `Country analysis quality gate failed: ${list}. ${gateRule} Reasons: ${reasons}`
            );
          }
        }
      }

      // NOTE: rawData is preserved here — PPT generation needs it for citations and fallback content.
      // It will be cleaned up AFTER PPT generation to free memory.

      // Stage 3: Synthesize findings
      throwIfAborted('synthesis');
      const synthesis = await synthesizeFindings(countryAnalyses, scope);

      // Quality Gate 2: Validate synthesis quality (Fix 14: pass industry for specificity scoring)
      let finalSynthesis = synthesis;
      const synthesisGate = validateSynthesisQuality(finalSynthesis, scope.industry);
      console.log(
        '[Quality Gate] Synthesis:',
        JSON.stringify({
          pass: synthesisGate.pass,
          overall: synthesisGate.overall,
          failures: synthesisGate.failures,
        })
      );
      if (!synthesisGate.pass) {
        if (synthesisGate.overall < 40 && !draftPptMode) {
          throw new Error(`Synthesis quality too low (${synthesisGate.overall}/100). Aborting.`);
        }
        if (synthesisGate.overall < 60 && !draftPptMode) {
          console.log(
            `[Quality Gate] Quality marginal (${synthesisGate.overall}/100), retrying synthesis with boosted tokens...`
          );
          // Retry synthesis once with boosted maxTokens
          const boostedScope = { ...scope, maxTokens: 24576 };
          finalSynthesis = await synthesizeFindings(countryAnalyses, boostedScope);
          const retryGate = validateSynthesisQuality(finalSynthesis, scope.industry);
          console.log(
            '[Quality Gate] Retry synthesis:',
            JSON.stringify({
              pass: retryGate.pass,
              overall: retryGate.overall,
              failures: retryGate.failures,
            })
          );
          if (!retryGate.pass && retryGate.overall < 40 && !draftPptMode) {
            throw new Error(
              `Synthesis quality still too low after retry (${retryGate.overall}/100). Aborting.`
            );
          }
        }
        if (draftPptMode) {
          console.warn(
            `[Quality Gate] Draft PPT mode enabled — proceeding despite synthesis gate failures (overall=${synthesisGate.overall})`
          );
          if (lastRunDiagnostics) {
            lastRunDiagnostics.synthesisGateBypassedForDraft = true;
            lastRunDiagnostics.synthesisGate = {
              pass: synthesisGate.pass,
              overall: synthesisGate.overall,
              failures: synthesisGate.failures,
            };
          }
        }
      }

      // Quality Gate 3: Validate PPT data completeness before rendering.
      // In production mode this is a hard gate to prevent shipping thin/truncated decks.
      const pptGateFailures = [];
      for (const ca of countryAnalyses) {
        const blocks = buildPptGateBlocks(ca);
        const pptGate = validatePptData(blocks);
        console.log(
          `[Quality Gate] PPT data for ${ca.country}:`,
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
          console.warn(
            `[Quality Gate] PPT data issues for ${ca.country}:`,
            JSON.stringify({
              emptyBlocks: pptGate.emptyBlocks,
              chartIssues: pptGate.chartIssues,
              nonRenderableGroups: pptGate.nonRenderableGroups || [],
              severeOverflowCount: pptGate.severeOverflowCount || 0,
            })
          );
          pptGateFailures.push({
            country: ca.country,
            nonRenderableGroups: pptGate.nonRenderableGroups || [],
            emptyBlocks: (pptGate.emptyBlocks || []).slice(0, 8),
            chartIssues: (pptGate.chartIssues || []).slice(0, 8),
            severeOverflowCount: Number(pptGate.severeOverflowCount || 0),
            semanticallyEmptyRatio: Number(pptGate.semanticallyEmptyRatio || 0),
          });
        }
      }
      if (pptGateFailures.length > 0 && !draftPptMode) {
        const summary = pptGateFailures
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
              failure.semanticallyEmptyRatio > 0
                ? `emptyRatio=${Math.round(failure.semanticallyEmptyRatio * 100)}%`
                : '';
            return `${failure.country}[${groups}${empties ? `, ${empties}` : ''}${charts ? `, ${charts}` : ''}${overflow ? `, ${overflow}` : ''}${sparse ? `, ${sparse}` : ''}]`;
          })
          .join(' | ');
        if (lastRunDiagnostics) {
          lastRunDiagnostics.stage = 'ppt_data_gate_failed';
          lastRunDiagnostics.pptDataGateFailures = pptGateFailures;
          lastRunDiagnostics.error = `PPT data gate failed: ${summary}`;
        }
        throw new Error(`PPT data gate failed: ${summary}`);
      }
      if (pptGateFailures.length > 0 && draftPptMode) {
        console.warn(
          `[Quality Gate] Draft PPT mode bypassed ${pptGateFailures.length} PPT data gate failure(s)`
        );
      }

      // Hard pre-render schema guard: block transient/malformed synthesis before PPT renderer sees it.
      const preRenderStructureIssues = collectPreRenderStructureIssues(countryAnalyses);
      if (preRenderStructureIssues.length > 0) {
        const issueSummary = preRenderStructureIssues.slice(0, 12).join(' | ');
        if (lastRunDiagnostics) {
          lastRunDiagnostics.stage = 'pre_render_structure_failed';
          lastRunDiagnostics.preRenderStructureIssues = preRenderStructureIssues.slice(0, 50);
          lastRunDiagnostics.error = `Pre-render structure gate failed: ${issueSummary}`;
        }
        throw new Error(`Pre-render structure gate failed: ${issueSummary}`);
      }

      // Budget Gate: Pre-render payload budget analysis & compaction.
      // Catches payloads that pass structural gates but would cause late render stress
      // (oversized fields, dense tables, thin charts).
      for (let i = 0; i < countryAnalyses.length; i++) {
        const ca = countryAnalyses[i];
        const budgetResult = runBudgetGate(ca, { dryRun: false });
        console.log(
          `[Budget Gate] ${ca.country}: risk=${budgetResult.report.risk}, issues=${budgetResult.report.issues.length}` +
            (budgetResult.compactionLog.length > 0
              ? `, compacted=${budgetResult.compactionLog.length} field(s)`
              : '')
        );
        if (budgetResult.compactionLog.length > 0) {
          for (const entry of budgetResult.compactionLog) {
            console.log(
              `[Budget Gate] Compacted ${ca.country}.${entry.section}.${entry.key}: ${entry.action} (${entry.before} → ${entry.after})`
            );
          }
          countryAnalyses[i] = budgetResult.payload;
        }
        if (lastRunDiagnostics) {
          if (!lastRunDiagnostics.budgetGate) lastRunDiagnostics.budgetGate = {};
          lastRunDiagnostics.budgetGate[ca.country] = {
            risk: budgetResult.report.risk,
            issues: budgetResult.report.issues.slice(0, 20),
            compacted: budgetResult.compactionLog.length,
          };
        }
      }

      // Stage 4: Generate PPT
      throwIfAborted('ppt generation');
      let pptBuffer = await generatePPT(finalSynthesis, countryAnalyses, scope);
      const pptMetrics = (pptBuffer && (pptBuffer.__pptMetrics || pptBuffer.pptMetrics)) || null;

      // Final server-side package hardening (defense-in-depth): normalize IDs and content-types
      // again before any validation/delivery so no generator path can bypass structural safety.
      const serverRelNormalize = await normalizeAbsoluteRelationshipTargets(pptBuffer);
      pptBuffer = serverRelNormalize.buffer;
      if (serverRelNormalize.changed) {
        console.log(
          `[Server PPT] Normalized absolute relationship targets (${serverRelNormalize.stats.normalizedTargets} target(s) in ${serverRelNormalize.stats.filesChanged} rels file(s))`
        );
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
        console.log(`[Server PPT] Reconciled content types (${touched} override adjustment(s))`);
      }
      // Preserve metrics attached by renderer after buffer replacement.
      if (pptMetrics && Buffer.isBuffer(pptBuffer)) {
        pptBuffer.__pptMetrics = pptMetrics;
      }
      const { zip: serverZip } = await readPPTX(pptBuffer);
      const serverRelIntegrity = await scanRelationshipTargets(serverZip);
      if (serverRelIntegrity.missingInternalTargets.length > 0) {
        const preview = serverRelIntegrity.missingInternalTargets
          .slice(0, 5)
          .map((m) => `${m.relFile} -> ${m.target} (${m.reason})`)
          .join(' | ');
        throw new Error(
          `Server PPT relationship integrity failed: ${serverRelIntegrity.missingInternalTargets.length} broken internal target(s); ${preview}`
        );
      }
      if (
        Array.isArray(serverRelIntegrity.invalidExternalTargets) &&
        serverRelIntegrity.invalidExternalTargets.length > 0
      ) {
        const preview = serverRelIntegrity.invalidExternalTargets
          .slice(0, 5)
          .map((m) => `${m.relFile} -> ${m.target || '(empty)'} (${m.reason})`)
          .join(' | ');
        throw new Error(
          `Server PPT external relationship integrity failed: ${serverRelIntegrity.invalidExternalTargets.length} invalid external target(s); ${preview}`
        );
      }
      const serverPackageConsistency = await scanPackageConsistency(serverZip);
      const serverPackageIssues = collectPptPackageIssues(serverPackageConsistency);
      if (serverPackageIssues.length > 0) {
        throw new Error(
          `Server PPT package consistency failed: ${serverPackageIssues.join(' | ')}`
        );
      }

      // Formatting fidelity policy:
      // Hard-fail on structural render loss and template-fidelity regressions.
      // Overflow remains warning-level to preserve content depth.
      if (pptMetrics) {
        const templateTotal = Number(pptMetrics.templateTotal || 0);
        const failureCount = Number(pptMetrics.slideRenderFailureCount || 0);
        const failureRate = templateTotal > 0 ? failureCount / templateTotal : 0;

        if (failureRate > 0.35 || failureCount >= 10) {
          throw new Error(
            `PPT rendering quality failed: failures=${failureCount}, totalBlocks=${templateTotal}, failureRate=${failureRate.toFixed(2)}`
          );
        }
        if (Number(pptMetrics.formattingAuditCriticalCount || 0) > 0) {
          throw new Error(
            `PPT formatting audit failed: critical=${pptMetrics.formattingAuditCriticalCount}`
          );
        }

        const formattingFailures = [];
        const formattingWarnings = [];
        if (Number(pptMetrics.templateCoverage || 0) < 95) {
          formattingFailures.push(`templateCoverage=${pptMetrics.templateCoverage}%`);
        }
        if (Number(pptMetrics.tableRecoveryCount || 0) > 0) {
          formattingFailures.push(`tableRecoveries=${pptMetrics.tableRecoveryCount}`);
        }
        if (Number(pptMetrics.nonTemplatePatternCount || 0) > 0) {
          formattingFailures.push(`nonTemplatePatterns=${pptMetrics.nonTemplatePatternCount}`);
        }
        if (Number(pptMetrics.fallbackTemplateMappingCount || 0) > 0) {
          formattingFailures.push(
            `fallbackTemplateMappings=${pptMetrics.fallbackTemplateMappingCount}`
          );
        }
        if (Number(pptMetrics.geometryIssueCount || 0) > 0) {
          formattingFailures.push(`geometryIssues=${pptMetrics.geometryIssueCount}`);
        }
        if (Number(pptMetrics.geometryMaxDelta || 0) > 0.1) {
          formattingFailures.push(`geometryMaxDelta=${pptMetrics.geometryMaxDelta}`);
        }
        // Overflow and other non-critical warnings remain warning-level by design.
        if (Number(pptMetrics.formattingAuditWarningCount || 0) > 0) {
          formattingWarnings.push(`formatAuditWarnings=${pptMetrics.formattingAuditWarningCount}`);
        }
        if (formattingFailures.length > 0) {
          throw new Error(`PPT formatting fidelity failed: ${formattingFailures.join(', ')}`);
        }
        if (formattingWarnings.length > 0) {
          console.warn(`[Quality Gate] Formatting warnings: ${formattingWarnings.join(', ')}`);
        }
        if (lastRunDiagnostics) {
          lastRunDiagnostics.formattingWarnings = formattingWarnings;
        }
      }

      // Quality Gate 4: Hard PPT structural validation before delivery.
      // This blocks malformed or clearly truncated decks from being emailed/downloaded.
      let pptStructureValidation = null;
      try {
        const pptValidationExpectations = {
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
          // Single-country runs should visibly mention the target country somewhere in the deck.
          pptValidationExpectations.requiredText = [scope.targetMarkets[0]];
        }
        pptStructureValidation = await validatePPTX(pptBuffer, pptValidationExpectations);
      } catch (validationErr) {
        throw new Error(`PPT structural validation crashed: ${validationErr.message}`);
      }

      const emptySlidesWarning = (pptStructureValidation.warnings || []).find(
        (w) => w.check === 'Empty slides'
      );
      const emptySlideMatches = emptySlidesWarning?.message?.match(/\d+/g) || [];
      const emptySlideCount = emptySlideMatches.length;
      const excessiveEmptySlides = emptySlideCount > 6;
      const structureFailures = (pptStructureValidation.failed || []).map(
        (f) => `${f.check}: expected ${f.expected}, got ${f.actual}`
      );

      if (!pptStructureValidation.valid || excessiveEmptySlides) {
        const reasons = [...structureFailures];
        if (excessiveEmptySlides) {
          reasons.push(`Empty slide threshold exceeded (${emptySlideCount} > 6)`);
        }
        throw new Error(`PPT structural validation failed: ${reasons.join(' | ')}`);
      }

      if (emptySlideCount > 0) {
        console.warn(
          `[Quality Gate] PPT structure warning: ${emptySlideCount} low-content slide(s) detected (<50 chars)`
        );
      }

      if (lastRunDiagnostics) {
        lastRunDiagnostics.ppt = pptMetrics || {
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
        if (pptStructureValidation) {
          lastRunDiagnostics.pptStructure = {
            valid: pptStructureValidation.valid,
            passed: pptStructureValidation.summary?.passed || 0,
            failed: pptStructureValidation.summary?.failed || 0,
            warnings: pptStructureValidation.summary?.warnings || 0,
            failedChecks: (pptStructureValidation.failed || []).slice(0, 10),
            warningChecks: (pptStructureValidation.warnings || []).slice(0, 10),
          };
        }
      }

      // Clean up rawData AFTER PPT generation to free memory (citations already used by PPT renderer)
      for (const ca of countryAnalyses) {
        if (ca.rawData) {
          delete ca.rawData;
        }
      }

      // Stage 5: Send email
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
      lastRunDiagnostics = {
        ...(lastRunDiagnostics || {}),
        timestamp: new Date().toISOString(),
        stage: 'error',
        error: error.message,
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

// Pipeline diagnostics endpoint
app.get('/api/diagnostics', (req, res) => {
  if (!lastRunDiagnostics) {
    return res.json({ available: false, message: 'No completed run yet' });
  }
  res.json({ available: true, ...lastRunDiagnostics });
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
