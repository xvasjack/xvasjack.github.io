const { callGemini, callGeminiPro, callGeminiResearch } = require('./ai-clients');
const { generateResearchFramework } = require('./research-framework');
const {
  policyResearchAgent,
  marketResearchAgent,
  competitorResearchAgent,
  contextResearchAgent,
  depthResearchAgent,
  insightsResearchAgent,
  universalResearchAgent,
  extractJsonFromContent,
} = require('./research-agents');
const { ensureString: _ensureString } = require('./shared/utils');

function ensureString(value, defaultValue = '') {
  return _ensureString(value, defaultValue);
}

function parsePositiveIntEnv(name, fallback) {
  const raw = ensureString(process.env[name], '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeIntEnv(name, fallback) {
  const raw = ensureString(process.env[name], '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseBoundedIntEnv(name, fallback, maxValue) {
  const parsed = parsePositiveIntEnv(name, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (!Number.isFinite(maxValue) || maxValue <= 0) return parsed;
  return Math.min(parsed, maxValue);
}

const CFG_REVIEW_DEEPEN_MAX_ITERATIONS = parseBoundedIntEnv('REVIEW_DEEPEN_MAX_ITERATIONS', 3, 3);
const CFG_REVIEW_DEEPEN_TARGET_SCORE = parsePositiveIntEnv('REVIEW_DEEPEN_TARGET_SCORE', 75);
const CFG_REFINEMENT_MAX_ITERATIONS = parseBoundedIntEnv('REFINEMENT_MAX_ITERATIONS', 3, 3);
const CFG_MIN_CONFIDENCE_SCORE = parsePositiveIntEnv('MIN_CONFIDENCE_SCORE', 80);
const CFG_FINAL_REVIEW_MAX_ITERATIONS = parseBoundedIntEnv('FINAL_REVIEW_MAX_ITERATIONS', 3, 3);
const CFG_DYNAMIC_AGENT_CONCURRENCY = parseBoundedIntEnv('DYNAMIC_AGENT_CONCURRENCY', 1, 2);
const CFG_DYNAMIC_AGENT_BATCH_DELAY_MS = parseBoundedIntEnv(
  'DYNAMIC_AGENT_BATCH_DELAY_MS',
  3000,
  15000
);
const CFG_DEEPEN_QUERY_CONCURRENCY = parseBoundedIntEnv('DEEPEN_QUERY_CONCURRENCY', 1, 2);
const CFG_DEEPEN_BATCH_DELAY_MS = parseBoundedIntEnv('DEEPEN_BATCH_DELAY_MS', 3000, 15000);
const CFG_REVIEW_DEEPEN_MAX_QUERIES = parseBoundedIntEnv('REVIEW_DEEPEN_MAX_QUERIES', 6, 10);
const CFG_FINAL_REVIEW_MAX_QUERIES = parseBoundedIntEnv('FINAL_REVIEW_MAX_QUERIES', 3, 8);
const CFG_FILL_GAPS_MAX_CRITICAL = parseBoundedIntEnv('FILL_GAPS_MAX_CRITICAL', 4, 6);
const CFG_FILL_GAPS_MAX_VERIFICATIONS = parseBoundedIntEnv('FILL_GAPS_MAX_VERIFICATIONS', 1, 3);
const CFG_SYNTHESIS_TOPIC_MAX_CHARS = parseBoundedIntEnv('SYNTHESIS_TOPIC_MAX_CHARS', 1600, 2400);
const CFG_SYNTHESIS_TIER_DELAY_MS = parseBoundedIntEnv('SYNTHESIS_TIER_DELAY_MS', 2000, 10000);
const CFG_FINAL_REVIEW_MAX_RESEARCH_ESCALATIONS = parseBoundedIntEnv(
  'FINAL_REVIEW_MAX_RESEARCH_ESCALATIONS',
  1,
  2
);
const CFG_FINAL_REVIEW_MAX_SYNTHESIS_ESCALATIONS = parseBoundedIntEnv(
  'FINAL_REVIEW_MAX_SYNTHESIS_ESCALATIONS',
  2,
  3
);
const CFG_SECTION_SYNTHESIS_DELAY_MS = parseBoundedIntEnv(
  'SECTION_SYNTHESIS_DELAY_MS',
  10000,
  20000
);
const CFG_COMPETITOR_SYNTHESIS_DELAY_MS = parseBoundedIntEnv(
  'COMPETITOR_SYNTHESIS_DELAY_MS',
  10000,
  20000
);
const CFG_FINAL_FIX_SECTION_DELAY_MS = parseBoundedIntEnv(
  'FINAL_FIX_SECTION_DELAY_MS',
  5000,
  10000
);
const CFG_GAP_QUERY_DELAY_MS = parseBoundedIntEnv('GAP_QUERY_DELAY_MS', 3000, 10000);

async function runInBatches(items, batchSize, handler, delayMs = 0) {
  const results = [];
  const size = Math.max(1, Number.isFinite(batchSize) ? batchSize : 1);
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const batchResults = await Promise.all(batch.map((item, idx) => handler(item, i + idx)));
    results.push(...batchResults);
    if (delayMs > 0 && i + size < items.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return results;
}

const PLACEHOLDER_PATTERNS = [
  /\binsufficient research data\b/i,
  /\binsufficient data\b/i,
  /\bnot enough data\b/i,
  /\bdata unavailable\b/i,
  /\bnot publicly available\b/i,
  /\bdetails pending further research\b/i,
  /\banalysis pending additional research\b/i,
];

function containsPlaceholderText(value) {
  if (typeof value !== 'string') return false;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

function countWords(text) {
  const cleaned = ensureString(text).trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).length;
}

const TRUNCATION_ARTIFACT_PATTERNS = [
  /\bunterminated string\b/i,
  /\bunexpected end of json\b/i,
  /\bexpected .*json\b/i,
  /(?:\.\.\.|…)\s*$/,
  /[{[]\s*$/,
];

const COMPETITOR_DESCRIPTION_SIGNAL_REGEX =
  /\b(contract|project|field|offshore|onshore|lng|drilling|epc|om|maintenance|pipeline|terminal|well|procurement|technology|service|revenue|market|partner|bid|tender|capex|opex)\b/i;

function hasTruncationArtifact(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  return TRUNCATION_ARTIFACT_PATTERNS.some((re) => re.test(text));
}

function hasSemanticArtifactPayload(value, depth = 0) {
  if (depth > 8 || value == null) return false;
  if (typeof value === 'string') {
    return containsPlaceholderText(value) || hasTruncationArtifact(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasSemanticArtifactPayload(item, depth + 1));
  }
  if (typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    if (String(key || '').startsWith('_')) return false;
    return hasSemanticArtifactPayload(child, depth + 1);
  });
}

const TRANSIENT_TOP_LEVEL_PATTERNS = [
  /^section[_-]?\d+$/i,
  /^gap[_-]?\d+$/i,
  /^verify[_-]?\d+$/i,
  /^final[_-]?review[_-]?gap[_-]?\d+$/i,
  /^deepen[_-]?/i,
  /^market[_-]?deepen[_-]?/i,
  /^competitors?[_-]?deepen[_-]?/i,
  /^policy[_-]?deepen[_-]?/i,
  /^context[_-]?deepen[_-]?/i,
  /^depth[_-]?deepen[_-]?/i,
  /^insights?[_-]?deepen[_-]?/i,
  /^marketdeepen/i,
  /^competitorsdeepen/i,
  /^policydeepen/i,
  /^contextdeepen/i,
  /^depthdeepen/i,
  /^insightsdeepen/i,
];

function hasTransientTopLevelKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some((key) =>
    TRANSIENT_TOP_LEVEL_PATTERNS.some((re) => re.test(ensureString(key).trim()))
  );
}

const STRICT_POLICY_TOP_LEVEL_KEYS = new Set([
  'foundationalActs',
  'nationalPolicy',
  'investmentRestrictions',
  'regulatorySummary',
  'keyIncentives',
  'sources',
]);

const STRICT_MARKET_TOP_LEVEL_KEYS = new Set([
  'marketSizeAndGrowth',
  'supplyAndDemandDynamics',
  'pricingAndTariffStructures',
  'sources',
]);
const STRICT_SUMMARY_TOP_LEVEL_KEYS = new Set([
  'timingIntelligence',
  'lessonsLearned',
  'opportunities',
  'obstacles',
  'ratings',
  'keyInsights',
  'recommendation',
  'goNoGo',
]);
const STRICT_DEPTH_TOP_LEVEL_KEYS = new Set([
  'dealEconomics',
  'partnerAssessment',
  'entryStrategy',
  'implementation',
  'targetSegments',
]);

function findDisallowedTopLevelKeys(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const allow = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys || []);
  return Object.keys(value).filter((key) => {
    const normalized = ensureString(key).trim();
    if (!normalized || normalized.startsWith('_')) return false;
    return !allow.has(normalized);
  });
}

function pickAllowedTopLevelKeys(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allow = allowedKeys instanceof Set ? [...allowedKeys] : [...new Set(allowedKeys || [])];
  const out = {};
  for (const key of allow) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    out[key] = value[key];
  }
  return out;
}

function isPlainSectionObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSemanticallyUsefulValue(value, depth = 0) {
  if (depth > 8 || value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return false;
    if (containsPlaceholderText(text)) return false;
    if (hasTruncationArtifact(text)) return false;
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => isSemanticallyUsefulValue(item, depth + 1));
  }
  if (!isPlainSectionObject(value)) return false;
  return Object.values(value).some((child) => isSemanticallyUsefulValue(child, depth + 1));
}

function mergeSectionValuesPreferRich(existingValue, incomingValue, depth = 0) {
  if (depth > 10) return incomingValue ?? existingValue;
  if (incomingValue === undefined) return existingValue;
  if (existingValue === undefined) return incomingValue;

  if (isPlainSectionObject(existingValue) && isPlainSectionObject(incomingValue)) {
    const merged = { ...existingValue };
    for (const [key, nextChild] of Object.entries(incomingValue)) {
      merged[key] = mergeSectionValuesPreferRich(existingValue[key], nextChild, depth + 1);
    }
    return merged;
  }

  if (Array.isArray(existingValue) && Array.isArray(incomingValue)) {
    const existingUseful = existingValue.filter((item) =>
      isSemanticallyUsefulValue(item, depth + 1)
    );
    const incomingUseful = incomingValue.filter((item) =>
      isSemanticallyUsefulValue(item, depth + 1)
    );
    return incomingUseful.length >= existingUseful.length ? incomingValue : existingValue;
  }

  if (isSemanticallyUsefulValue(incomingValue, depth + 1)) return incomingValue;
  if (isSemanticallyUsefulValue(existingValue, depth + 1)) return existingValue;
  return incomingValue ?? existingValue;
}

function mergeCanonicalSectionsPreferRich(existingSection, incomingSection, allowedKeys) {
  const base = pickAllowedTopLevelKeys(existingSection, allowedKeys);
  const next = pickAllowedTopLevelKeys(incomingSection, allowedKeys);
  const allow = allowedKeys instanceof Set ? [...allowedKeys] : [...new Set(allowedKeys || [])];
  const merged = { ...base };

  for (const key of allow) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) continue;
    merged[key] = mergeSectionValuesPreferRich(base[key], next[key]);
  }
  return merged;
}

function hasMeaningfulCompetitorDescription(value) {
  const text = ensureString(value).replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (containsPlaceholderText(text)) return false;
  if (hasTruncationArtifact(text)) return false;
  const words = countWords(text);
  if (words < 18) return false;
  return COMPETITOR_DESCRIPTION_SIGNAL_REGEX.test(text) || /\d/.test(text);
}

function isViableCompetitorPlayer(player) {
  if (!player || typeof player !== 'object') return false;
  const name = ensureString(player.name).trim();
  if (!name) return false;
  if (containsPlaceholderText(name) || hasTruncationArtifact(name)) return false;
  return hasMeaningfulCompetitorDescription(player.description || player.strategicAssessment || '');
}

const CURRENT_YEAR = new Date().getFullYear();

function normalizeNumericScore(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, value));
  }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return Math.max(0, Math.min(100, asNumber));
  }
  const extracted = String(value || '').match(/-?\d+(\.\d+)?/);
  if (extracted) {
    const parsed = Number(extracted[0]);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(100, parsed));
  }
  return Math.max(0, Math.min(100, Number(fallback) || 0));
}

function humanizeSectionKey(key) {
  return ensureString(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeLegalToken(text) {
  return ensureString(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function extractLegalTokens(text) {
  const source = ensureString(text).toLowerCase();
  if (!source) return [];

  const tokens = new Set();
  const patterns = [
    /\b(?:decree|decision|resolution|circular)\s*(?:no\.?\s*)?[a-z0-9./-]{2,}\b/g,
    /\blaw\s*(?:no\.?\s*)?[a-z0-9./-]{2,}\b/g,
    /\bpetroleum law(?:\s*no\.?\s*[a-z0-9./-]{2,})?\b/g,
  ];

  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const token = normalizeLegalToken(match[0]);
      if (token) tokens.add(token);
    }
  }
  return [...tokens];
}

function normalizeSectionArea(area) {
  const value = ensureString(area).toLowerCase();
  if (value.includes('policy') || value.includes('regulation') || value.includes('law'))
    return 'policy';
  if (value.includes('market') || value.includes('demand') || value.includes('pricing'))
    return 'market';
  if (value.includes('competitor') || value.includes('company') || value.includes('player'))
    return 'competitors';
  if (value.includes('depth') || value.includes('partner') || value.includes('economics'))
    return 'depth';
  if (value.includes('summary') || value.includes('strategic') || value.includes('insight'))
    return 'summary';
  if (value.includes('verify')) return 'verification';
  return 'general';
}

function getClientScopeGuard(industry, clientContext) {
  const combined = `${ensureString(industry)} ${ensureString(clientContext)}`.toLowerCase();
  const hydrocarbonFocused = /\boil\b|\bgas\b|petroleum|lng|upstream|downstream|oilfield/.test(
    combined
  );
  if (!hydrocarbonFocused) return '';
  return 'SCOPE GUARD: prioritize hydrocarbon energy services (oil, gas, LNG, upstream/downstream, O&M, EPC, maintenance). Do not pivot the storyline to renewable-only opportunities unless the provided evidence explicitly proves a direct hydrocarbon-services adjacency.';
}

const TRANSIENT_RESEARCH_KEY_PATTERNS = [
  /^_/,
  /^section_\d+$/,
  /^\d+$/,
  /_wasarray/,
  /_synthesiserror/,
  /(?:^|_)deepen(?:_|$)/,
  /deepen(?:_|-)?gap_?\d*$/,
  /deepenfinalreviewgap_?\d*$/,
  /final[_-]?review[_-]?gap/,
  /(?:^|_)gap_\d+$/,
  /(?:^|_)verify(?:_|$|\d)/,
];

function isTransientResearchKey(key) {
  const normalized = ensureString(key).toLowerCase().trim();
  if (!normalized) return true;
  return TRANSIENT_RESEARCH_KEY_PATTERNS.some((re) => re.test(normalized));
}

function selectResearchTopicsByPrefix(researchData, prefix) {
  const normalizedPrefix = ensureString(prefix).toLowerCase().trim();
  if (!normalizedPrefix) return {};
  const prefixToken = `${normalizedPrefix}_`;
  const entries = Object.entries(researchData || {}).filter(([rawKey]) => {
    const key = ensureString(rawKey).toLowerCase();
    return key.startsWith(prefixToken) && !isTransientResearchKey(key);
  });
  if (entries.length === 0) return {};

  const canonicalRegex = new RegExp(`^${normalizedPrefix}_\\d+_`);
  const canonicalEntries = entries.filter(([rawKey]) =>
    canonicalRegex.test(ensureString(rawKey).toLowerCase())
  );
  return Object.fromEntries(canonicalEntries.length > 0 ? canonicalEntries : entries);
}

function buildScopeQuery(area, country, industry) {
  const safeCountry = ensureString(country);
  const safeIndustry = ensureString(industry || 'industry');
  const base = `${safeCountry} ${safeIndustry}`.trim();
  const areaKey = normalizeSectionArea(area);

  switch (areaKey) {
    case 'policy':
      return `${base} petroleum law decree licensing foreign contractor local content official`;
    case 'market':
      return `${base} market size demand supply pricing drilling epc maintenance official statistics`;
    case 'competitors':
      return `${base} top service companies revenue market share contracts annual report`;
    case 'depth':
      return `${base} market entry strategy joint venture procurement tender project timeline`;
    case 'summary':
      return `${base} key market triggers policy catalysts project pipeline timeline`;
    case 'verification':
      return `${base} official source verification annual report regulator publication`;
    default:
      return `${base} official market statistics regulations competitors latest`;
  }
}

function sanitizeResearchQuery(rawQuery, country, industry, area = 'general') {
  const lowerIndustry = ensureString(industry).toLowerCase();
  const isOilGasScope = /\boil\b|\bgas\b|petroleum|upstream|downstream|lng|drilling|oilfield/.test(
    lowerIndustry
  );
  const allowsRenewables = /\brenewable\b|\bsolar\b|\bwind\b/.test(lowerIndustry);

  let query = ensureString(rawQuery).replace(/\s+/g, ' ').trim();
  if (!query) query = buildScopeQuery(area, country, industry);

  // Remove future years from auto-generated queries to avoid speculative drift.
  query = query.replace(/\b20\d{2}\b/g, (m) => (Number(m) <= CURRENT_YEAR ? m : ''));
  query = query.replace(/\s+/g, ' ').trim();

  const bannedForOilGas = [
    /\boffshore wind\b/i,
    /\bwind farm\b/i,
    /\bsolar\b/i,
    /\bphotovoltaic\b/i,
    /\bbattery\b/i,
    /\belectric vehicle\b/i,
    /\bev\b/i,
    /\bretail electricity market\b/i,
  ];
  const offScope =
    isOilGasScope &&
    !allowsRenewables &&
    bannedForOilGas.some((re) => re.test(query.toLowerCase()));
  if (offScope) {
    query = buildScopeQuery(area, country, industry);
  }

  const countryToken = ensureString(country).toLowerCase();
  if (countryToken && !query.toLowerCase().includes(countryToken)) {
    query = `${country} ${query}`.trim();
  }

  // Keep query grounded in scope keywords.
  if (isOilGasScope) {
    const hasScopeKeyword =
      /\boil\b|\bgas\b|petroleum|oilfield|drilling|lng|upstream|downstream/i.test(query);
    if (!hasScopeKeyword) {
      query = `${query} oil gas petroleum services`.replace(/\s+/g, ' ').trim();
    }
  }

  if (query.split(/\s+/).length < 5) {
    query = buildScopeQuery(area, country, industry);
  }

  return query.replace(/\s+/g, ' ').trim();
}

// ============ ITERATIVE RESEARCH SYSTEM WITH CONFIDENCE SCORING ============

// Step 1: Identify gaps in research after first synthesis with detailed scoring
async function identifyResearchGaps(synthesis, country, _industry, baselineCodeGate = null) {
  console.log(`  [Analyzing research quality for ${country}...]`);

  const compactSnapshot = {
    policy: summarizeForSummary(synthesis?.policy || {}, 'policy', 2200),
    market: summarizeForSummary(synthesis?.market || {}, 'market', 2200),
    competitors: summarizeForSummary(synthesis?.competitors || {}, 'competitors', 2200),
    depth: summarizeForSummary(synthesis?.depth || {}, 'depth', 1800),
    summary: summarizeForSummary(synthesis?.summary || {}, 'summary', 1800),
    existingValidationScores:
      baselineCodeGate?.scores || synthesis?.contentValidation?.scores || null,
  };
  const scopeGuard = getClientScopeGuard(_industry, synthesis?.clientContext || '');

  const gapPrompt = `You are a research quality auditor reviewing a market analysis. Score each section and identify critical gaps.

${scopeGuard ? `${scopeGuard}\n` : ''}CURRENT ANALYSIS SNAPSHOT:
${JSON.stringify(compactSnapshot, null, 2)}

SCORING CRITERIA (0-100 for each section):
- 90-100: Excellent - Specific numbers, named sources, actionable insights
- 70-89: Good - Most data points covered, some specifics missing
- 50-69: Adequate - General information, lacks depth or verification
- 30-49: Weak - Vague statements, missing key data
- 0-29: Poor - Generic or placeholder content

Return a JSON object with this structure:
{
  "sectionScores": {
    "policy": {"score": 0-100, "reasoning": "why this score", "missingData": ["list of missing items"]},
    "market": {"score": 0-100, "reasoning": "why this score", "missingData": ["list"]},
    "competitors": {"score": 0-100, "reasoning": "why this score", "missingData": ["list"]},
    "depth": {"score": 0-100, "reasoning": "why this score", "missingData": ["list"]},
    "summary": {"score": 0-100, "reasoning": "why this score", "missingData": ["list"]}
  },
  "overallScore": 0-100,
  "criticalGaps": [
    {
      "area": "which section (policy/market/competitors/depth/summary)",
      "gap": "what specific information is missing",
      "searchQuery": "the EXACT search query to find this for ${country}",
      "priority": "high/medium",
      "impactOnScore": "how many points this would add if filled"
    }
  ],
  "dataToVerify": [
    {
      "claim": "the specific claim that needs verification",
      "searchQuery": "search query to verify this for ${country}",
      "currentConfidence": "low/medium/high"
    }
  ],
  "confidenceAssessment": {
    "overall": "low/medium/high",
    "numericConfidence": 0-100,
    "weakestSection": "which section needs most work",
    "strongestSection": "which section is best",
    "reasoning": "why this confidence level",
    "readyForClient": true/false
  }
}

RULES:
- Score >= 75 overall = "high" confidence, ready for client
- Score 50-74 = "medium" confidence, needs refinement
- Score < 50 = "low" confidence, significant gaps
- Limit criticalGaps to 6 most impactful items; avoid low-signal or redundant gaps
- Only flag dataToVerify for claims that seem suspicious or unsourced
- Stay strictly within "${_industry || 'industry'}" scope; do not suggest adjacent-sector queries unless explicitly present in the snapshot
- Do not request future-dated facts beyond ${CURRENT_YEAR}

Return ONLY valid JSON.`;

  let result;
  try {
    const geminiResult = await callGemini(gapPrompt, {
      temperature: 0,
      maxTokens: 3072,
      jsonMode: true,
    });
    result = {
      content: typeof geminiResult === 'string' ? geminiResult : geminiResult.content || '',
    };
  } catch (e) {
    console.warn('Gemini failed for gap identification, retrying:', e.message);
    const retryResult = await callGemini(gapPrompt, {
      maxTokens: 3072,
      jsonMode: true,
      temperature: 0,
    });
    result = { content: typeof retryResult === 'string' ? retryResult : retryResult.content || '' };
  }

  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    const gaps = JSON.parse(jsonStr);

    // Normalize reviewer output so downstream refinement always has actionable work.
    const overallScoreRaw =
      typeof gaps.overallScore === 'number'
        ? gaps.overallScore
        : Number(gaps.confidenceAssessment?.numericConfidence) || 0;
    const normalizedOverallScore = Math.max(0, Math.min(100, overallScoreRaw || 0));
    const normalizedConfidence =
      normalizedOverallScore ||
      Math.max(0, Math.min(100, Number(gaps.confidenceAssessment?.numericConfidence) || 0));

    const rawCriticalGaps = Array.isArray(gaps.criticalGaps) ? gaps.criticalGaps : [];
    const normalizedCriticalGaps = rawCriticalGaps
      .map((gap, idx) => {
        if (!gap || typeof gap !== 'object') return null;
        const area = String(gap.area || gap.section || 'general').trim() || 'general';
        const gapText =
          String(gap.gap || gap.description || gap.missingData || '').trim() ||
          `Insufficient depth in ${area}`;
        const priorityRaw = String(gap.priority || gap.severity || '').toLowerCase();
        const priority =
          priorityRaw === 'high' || priorityRaw === 'critical'
            ? 'high'
            : normalizedOverallScore < 50
              ? 'high'
              : 'medium';
        const searchQuery = sanitizeResearchQuery(
          String(gap.searchQuery || '').trim() ||
            `${country} ${_industry || 'industry'} ${area} latest official data and specific numbers`,
          country,
          _industry,
          area
        );
        return {
          area,
          gap: gapText,
          searchQuery,
          priority,
          impactOnScore: gap.impactOnScore || null,
          _normalized: true,
          _index: idx,
        };
      })
      .filter(Boolean);

    // If quality is low but reviewer returned no actionable gaps, inject a fallback gap.
    if (normalizedCriticalGaps.length === 0 && normalizedOverallScore < 70) {
      normalizedCriticalGaps.push({
        area: 'general',
        gap: 'Reviewer returned no actionable gaps despite low confidence; collect fresh grounded facts',
        searchQuery: sanitizeResearchQuery(
          `${country} ${_industry || 'industry'} official statistics regulations competitors market size latest`,
          country,
          _industry,
          'general'
        ),
        priority: 'high',
        impactOnScore: 'high',
        _normalized: true,
        _fallback: true,
      });
    }

    const rawVerifications = Array.isArray(gaps.dataToVerify) ? gaps.dataToVerify : [];
    const normalizedVerifications = rawVerifications
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const claim = String(item.claim || item.statement || '').trim();
        if (!claim) return null;
        const searchQuery = sanitizeResearchQuery(
          String(item.searchQuery || '').trim() ||
            `${country} ${claim} official source verification`,
          country,
          _industry,
          'verification'
        );
        return {
          claim,
          searchQuery,
          currentConfidence: item.currentConfidence || 'low',
          _normalized: true,
        };
      })
      .filter(Boolean);

    // Normalize section scores so downstream logic never sees unknown placeholders.
    const sectionKeys = ['policy', 'market', 'competitors', 'depth', 'summary'];
    const normalizedSectionScores = {};
    for (const sectionKey of sectionKeys) {
      const rawSection = gaps.sectionScores?.[sectionKey];
      const rawScore =
        typeof rawSection?.score === 'number' ? rawSection.score : Number(rawSection?.score);
      const isValidScore = Number.isFinite(rawScore);
      const relatedGaps = normalizedCriticalGaps.filter((g) =>
        [sectionKey, 'general', 'cross-section'].includes(String(g.area || '').toLowerCase())
      );
      const fallbackScore = Math.max(20, normalizedOverallScore - relatedGaps.length * 10);
      const score = Math.max(0, Math.min(100, isValidScore ? rawScore : fallbackScore));
      const missingData = Array.isArray(rawSection?.missingData)
        ? rawSection.missingData.filter(Boolean).slice(0, 8)
        : relatedGaps.map((g) => g.gap).slice(0, 8);
      normalizedSectionScores[sectionKey] = {
        score,
        reasoning:
          typeof rawSection?.reasoning === 'string' && rawSection.reasoning.trim()
            ? rawSection.reasoning.trim()
            : isValidScore
              ? 'Score accepted from reviewer'
              : 'Score normalized from overall confidence due incomplete reviewer section output',
        missingData,
      };
    }

    // Calibrate reviewer outputs against deterministic code-gate scores.
    // This prevents hallucinated reviewer regressions (e.g., 95 -> 0 swings) from
    // triggering long expensive refine loops with low-signal queries.
    const baselineScores = baselineCodeGate?.scores || {};
    const baselineOverallRaw = Number(baselineScores.overall);
    const hasBaselineOverall = Number.isFinite(baselineOverallRaw);
    let blendedOverall = normalizedOverallScore;
    let severeReviewerCollapse = false;
    if (hasBaselineOverall) {
      const baselineOverall = Math.max(0, Math.min(100, baselineOverallRaw));
      const scoreDrift = Math.abs(normalizedOverallScore - baselineOverall);
      severeReviewerCollapse = normalizedOverallScore <= 30 && baselineOverall >= 70;

      for (const sectionKey of sectionKeys) {
        const baselineSectionRaw = Number(baselineScores[sectionKey]);
        if (!Number.isFinite(baselineSectionRaw)) continue;
        const baselineSection = Math.max(0, Math.min(100, baselineSectionRaw));
        const reviewerSection = Number(normalizedSectionScores[sectionKey]?.score || 0);
        if (reviewerSection + 25 < baselineSection) {
          severeReviewerCollapse = true;
          normalizedSectionScores[sectionKey].score = Math.round(
            reviewerSection * 0.3 + baselineSection * 0.7
          );
          if (
            !normalizedSectionScores[sectionKey].reasoning.includes(
              'Calibrated to deterministic code-gate score'
            )
          ) {
            normalizedSectionScores[sectionKey].reasoning =
              `${normalizedSectionScores[sectionKey].reasoning}; Calibrated to deterministic code-gate score to avoid reviewer drift`;
          }
        }
      }

      if (severeReviewerCollapse || scoreDrift >= 35) {
        blendedOverall = Math.round(normalizedOverallScore * 0.2 + baselineOverall * 0.8);
      } else if (scoreDrift >= 20) {
        blendedOverall = Math.round(normalizedOverallScore * 0.4 + baselineOverall * 0.6);
      } else {
        blendedOverall = Math.round(normalizedOverallScore * 0.7 + baselineOverall * 0.3);
      }

      if (severeReviewerCollapse) {
        console.warn(
          `  [Gap Audit] Reviewer score collapse detected (reviewer=${normalizedOverallScore}, codeGate=${baselineOverall}) — using calibrated blend`
        );
      }
    }

    gaps.overallScore = normalizedOverallScore;
    gaps.sectionScores = normalizedSectionScores;
    gaps.criticalGaps = normalizedCriticalGaps;
    gaps.dataToVerify = normalizedVerifications;
    gaps.confidenceAssessment = {
      ...(gaps.confidenceAssessment || {}),
      numericConfidence: normalizedConfidence,
      overall:
        gaps.confidenceAssessment?.overall ||
        (normalizedConfidence >= 75 ? 'high' : normalizedConfidence >= 50 ? 'medium' : 'low'),
      readyForClient:
        typeof gaps.confidenceAssessment?.readyForClient === 'boolean'
          ? gaps.confidenceAssessment.readyForClient
          : normalizedConfidence >= 75,
    };
    gaps.overallScore = Math.max(0, Math.min(100, blendedOverall));
    gaps.confidenceAssessment.numericConfidence = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          Number.isFinite(gaps.confidenceAssessment.numericConfidence)
            ? gaps.confidenceAssessment.numericConfidence
            : normalizedConfidence
        )
      )
    );
    if (hasBaselineOverall && gaps.confidenceAssessment.numericConfidence < gaps.overallScore) {
      gaps.confidenceAssessment.numericConfidence = gaps.overallScore;
    }
    gaps.confidenceAssessment.overall =
      gaps.confidenceAssessment.numericConfidence >= 75
        ? 'high'
        : gaps.confidenceAssessment.numericConfidence >= 50
          ? 'medium'
          : 'low';
    gaps.confidenceAssessment.readyForClient = gaps.confidenceAssessment.numericConfidence >= 75;

    if (
      gaps.criticalGaps.length === 0 &&
      Array.isArray(baselineCodeGate?.failures) &&
      baselineCodeGate.failures.length > 0 &&
      gaps.overallScore < CFG_MIN_CONFIDENCE_SCORE
    ) {
      const areaForFailure = (failure) => {
        const lower = String(failure || '').toLowerCase();
        if (lower.startsWith('policy')) return 'policy';
        if (lower.startsWith('market')) return 'market';
        if (lower.startsWith('competitors')) return 'competitors';
        if (lower.startsWith('depth')) return 'depth';
        return 'summary';
      };
      gaps.criticalGaps = baselineCodeGate.failures.slice(0, 3).map((failure) => {
        const area = areaForFailure(failure);
        return {
          area,
          gap: `Code-gate follow-up: ${failure}`,
          searchQuery: sanitizeResearchQuery(
            `${country} ${_industry || 'industry'} ${failure} official data`,
            country,
            _industry,
            area
          ),
          priority: 'high',
          impactOnScore: 'high',
          _normalized: true,
          _gateDriven: true,
        };
      });
    }

    // Log detailed scoring
    const scores = gaps.sectionScores || {};
    const policyScore = Number.isFinite(scores.policy?.score) ? scores.policy.score : 0;
    const marketScore = Number.isFinite(scores.market?.score) ? scores.market.score : 0;
    const competitorScore = Number.isFinite(scores.competitors?.score)
      ? scores.competitors.score
      : 0;
    const depthScore = Number.isFinite(scores.depth?.score) ? scores.depth.score : 0;
    console.log(
      `    Section Scores: Policy=${policyScore}, Market=${marketScore}, Competitors=${competitorScore}, Depth=${depthScore}`
    );
    console.log(
      `    Overall: ${gaps.overallScore}/100 | Confidence: ${gaps.confidenceAssessment?.overall || 'unknown'}`
    );
    console.log(
      `    Gaps: ${gaps.criticalGaps?.length || 0} critical | Verify: ${gaps.dataToVerify?.length || 0} claims`
    );
    console.log(
      `    Ready for client: ${gaps.confidenceAssessment?.readyForClient ? 'YES' : 'NO'}`
    );

    return gaps;
  } catch (error) {
    console.error('  Failed to parse gaps:', error?.message);
    return {
      sectionScores: {},
      overallScore: 30,
      criticalGaps: [
        {
          area: 'general',
          gap: 'Research quality could not be assessed due to malformed reviewer output',
          priority: 'high',
          searchQuery: sanitizeResearchQuery(
            `${country} ${_industry || 'industry'} official market size regulations competitors latest`,
            country,
            _industry,
            'general'
          ),
          impactOnScore: 'high',
        },
      ],
      dataToVerify: [],
      confidenceAssessment: { overall: 'low', numericConfidence: 30, readyForClient: false },
    };
  }
}

// Step 2: Execute targeted research to fill gaps using Gemini
async function fillResearchGaps(gaps, country, industry) {
  console.log(`  [Filling research gaps for ${country}...]`);
  const additionalData = { gapResearch: [], verificationResearch: [] };
  const seenQueries = new Set();
  const MIN_GAP_FINDING_CHARS = 900;
  const MIN_VERIFY_FINDING_CHARS = 450;
  const MIN_FINDING_CITATIONS = 1;
  const numericSignalCount = (text) => {
    if (!text) return 0;
    const matches = String(text).match(
      /\$[\d,.]+[BMKbmk]?|\d+(\.\d+)?%|\d{4}|\d+(\.\d+)?x|\b\d{1,3}(?:,\d{3})+\b/g
    );
    return matches ? matches.length : 0;
  };

  // Research critical gaps with Gemini
  const criticalGaps = gaps.criticalGaps || [];
  for (const gap of criticalGaps.slice(0, CFG_FILL_GAPS_MAX_CRITICAL)) {
    // Keep gap fills tight to avoid repeated low-yield token burn.
    const scopedQuery = sanitizeResearchQuery(
      gap.searchQuery,
      country,
      industry,
      gap.area || 'general'
    );
    if (!scopedQuery) continue;
    const queryKey = scopedQuery.trim().toLowerCase();
    if (!queryKey || seenQueries.has(queryKey)) continue;
    seenQueries.add(queryKey);
    console.log(`    Gap search: ${gap.gap.substring(0, 50)}...`);

    const result = await callGeminiResearch(scopedQuery, country, industry);
    const contentLength = (result.content || '').length;
    const citationsCount = Array.isArray(result.citations) ? result.citations.length : 0;
    const numericSignals = numericSignalCount(result.content || '');
    const usableGapFinding =
      contentLength >= MIN_GAP_FINDING_CHARS ||
      citationsCount >= MIN_FINDING_CITATIONS ||
      (contentLength >= 700 && numericSignals >= 8);
    if (result.content && usableGapFinding) {
      additionalData.gapResearch.push({
        area: gap.area,
        gap: gap.gap,
        query: scopedQuery,
        findings: result.content,
        citations: result.citations || [],
      });
    } else if (result.content) {
      console.warn(
        `    Gap search returned thin content (${contentLength} chars, ${citationsCount} citations, ${numericSignals} numeric signals) — skipping low-signal result`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, CFG_GAP_QUERY_DELAY_MS));
  }

  // Verify questionable claims with Gemini
  const toVerify = gaps.dataToVerify || [];
  for (const item of toVerify.slice(0, CFG_FILL_GAPS_MAX_VERIFICATIONS)) {
    // Keep verifications narrow; they are often low-signal after first pass.
    const scopedQuery = sanitizeResearchQuery(item.searchQuery, country, industry, 'verification');
    if (!scopedQuery) continue;
    const queryKey = scopedQuery.trim().toLowerCase();
    if (!queryKey || seenQueries.has(queryKey)) continue;
    seenQueries.add(queryKey);
    console.log(`    Verify: ${item.claim.substring(0, 50)}...`);

    const result = await callGeminiResearch(scopedQuery, country, industry);
    const contentLength = (result.content || '').length;
    const citationsCount = Array.isArray(result.citations) ? result.citations.length : 0;
    const numericSignals = numericSignalCount(result.content || '');
    const usableVerification =
      contentLength >= MIN_VERIFY_FINDING_CHARS ||
      citationsCount >= MIN_FINDING_CITATIONS ||
      (contentLength >= 300 && numericSignals >= 2);
    if (result.content && usableVerification) {
      additionalData.verificationResearch.push({
        claim: item.claim,
        query: scopedQuery,
        findings: result.content,
        citations: result.citations || [],
      });
    } else if (result.content) {
      console.warn(
        `    Verification returned thin content (${contentLength} chars, ${citationsCount} citations, ${numericSignals} numeric signals) — skipping low-signal result`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, CFG_GAP_QUERY_DELAY_MS));
  }

  // Recovery path: if all gap findings were rejected as thin, do 1-2 official-source refreshes.
  if (additionalData.gapResearch.length === 0 && criticalGaps.length > 0) {
    console.warn('    No usable gap fills collected — running targeted recovery queries');
    for (const gap of criticalGaps.slice(0, 2)) {
      const scopedQuery = sanitizeResearchQuery(
        gap.searchQuery,
        country,
        industry,
        gap.area || 'general'
      );
      if (!scopedQuery) continue;
      const recoveryQuery = `${scopedQuery} official government report regulator annual report`;
      const queryKey = recoveryQuery.trim().toLowerCase();
      if (!queryKey || seenQueries.has(queryKey)) continue;
      seenQueries.add(queryKey);
      const result = await callGeminiResearch(recoveryQuery, country, industry);
      const contentLength = (result.content || '').length;
      const citationsCount = Array.isArray(result.citations) ? result.citations.length : 0;
      const numericSignals = numericSignalCount(result.content || '');
      const usableRecoveryFinding =
        contentLength >= MIN_GAP_FINDING_CHARS ||
        citationsCount >= MIN_FINDING_CITATIONS ||
        (contentLength >= 700 && numericSignals >= 8);
      if (result.content && usableRecoveryFinding) {
        additionalData.gapResearch.push({
          area: gap.area,
          gap: `${gap.gap} (recovery)`,
          query: recoveryQuery,
          findings: result.content,
          citations: result.citations || [],
        });
      } else if (result.content) {
        console.warn(
          `    Recovery query thin (${contentLength} chars, ${citationsCount} citations, ${numericSignals} numeric signals) — skipping`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, CFG_GAP_QUERY_DELAY_MS));
    }
  }

  console.log(
    `    Collected ${additionalData.gapResearch.length} gap fills, ${additionalData.verificationResearch.length} verifications`
  );
  return additionalData;
}

// ============ PER-SECTION GEMINI SYNTHESIS ============

/**
 * Parse JSON from AI response, stripping markdown fences
 */
function parseJsonResponse(text) {
  let jsonStr = text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr
      .replace(/```json?\n?/g, '')
      .replace(/```/g, '')
      .trim();
  }
  return JSON.parse(jsonStr);
}

function truncatePromptText(value, maxChars = 2400) {
  const cleaned = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0 || cleaned.length <= maxChars) return cleaned;
  const sliced = cleaned.slice(0, maxChars);
  return sliced.replace(/\s+\S*$/, '').trim();
}

function compactResearchEntryForPrompt(entry, options = {}) {
  const {
    maxContentChars = 2200,
    maxCitations = 8,
    maxStructuredChars = 1200,
    maxTitleChars = 220,
  } = options;

  if (!entry || typeof entry !== 'object') return entry;
  const compact = { ...entry };
  compact.content = truncatePromptText(compact.content, maxContentChars);
  compact.name = truncatePromptText(compact.name, maxTitleChars);
  compact.slideTitle = truncatePromptText(compact.slideTitle, maxTitleChars);
  compact.description = truncatePromptText(compact.description, maxTitleChars);

  if (Array.isArray(compact.citations)) {
    compact.citations = compact.citations.slice(0, Math.max(0, maxCitations));
  }
  if (compact.structuredData && typeof compact.structuredData === 'object') {
    const serialized = JSON.stringify(compact.structuredData);
    compact.structuredData = truncatePromptText(serialized, maxStructuredChars);
  }

  // Drop heavy/raw fields that do not help synthesis quality but increase token burn.
  delete compact.rawHtml;
  delete compact.rawResponse;
  delete compact.fullText;
  delete compact.sourceHtml;

  return compact;
}

/**
 * Detect if JSON text was truncated (unbalanced brackets, unterminated strings)
 */
function isJsonTruncated(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;

  let braces = 0,
    brackets = 0,
    inString = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && inString) {
      i++;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  // Truncated if: unbalanced, ends mid-string, or trailing comma/colon
  return inString || braces > 0 || brackets > 0 || /[,:\s]+$/.test(trimmed);
}

/**
 * Attempt to repair truncated JSON by closing open structures
 */
function repairTruncatedJson(text) {
  if (!text || typeof text !== 'string') return text;
  let repaired = text.trim();

  // Remove trailing comma
  repaired = repaired.replace(/,\s*$/, '');
  // Remove incomplete key-value (e.g. "key": or "key":  )
  repaired = repaired.replace(/,?\s*"[^"]*"\s*:\s*$/, '');
  // Close unterminated string
  let inStr = false;
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '\\' && inStr) {
      i++;
      continue;
    }
    if (repaired[i] === '"') inStr = !inStr;
  }
  if (inStr) repaired += '"';

  // Close open brackets/braces
  const stack = [];
  inStr = false;
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '\\' && inStr) {
      i++;
      continue;
    }
    if (repaired[i] === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (repaired[i] === '{') stack.push('}');
    else if (repaired[i] === '[') stack.push(']');
    else if (repaired[i] === '}' || repaired[i] === ']') stack.pop();
  }
  // Remove trailing comma before closing
  repaired = repaired.replace(/,\s*$/, '');
  while (stack.length > 0) repaired += stack.pop();
  return repaired;
}

/**
 * Honest fallback for missing company website - Google search link
 */
function ensureHonestWebsite(company) {
  if (company && company.name && !company.website) {
    const searchName = encodeURIComponent(String(company.name).trim());
    company.website = `https://www.google.com/search?q=${searchName}+official+website`;
  }
  return company;
}

/**
 * Honest fallback for missing company description
 */
function ensureHonestDescription(company) {
  if (!company || typeof company !== 'object') return company;

  const baseParts = [];
  const name = ensureString(company.name);
  const typeOrOrigin = ensureString(company.type || company.origin);
  const revenue = ensureString(company.revenue || company.revenueLocal || company.revenueGlobal);
  const share = ensureString(company.marketShare);
  const entryYear = ensureString(company.entryYear);
  const entryMode = ensureString(company.entryMode || company.mode);
  const growthRate = ensureString(
    company.growthRate ||
      company.financialHighlights?.growthRate ||
      company.financialHighlights?.profitMargin
  );
  const projectName = ensureString(company.projects?.[0]?.name || company.topProject || '');

  if (name && typeOrOrigin) {
    baseParts.push(`${name} is a ${typeOrOrigin.toLowerCase()} participant in the target market.`);
  } else if (name) {
    baseParts.push(`${name} is an active participant in the target market.`);
  }
  if (revenue || share) {
    baseParts.push(
      `Available disclosures indicate revenue ${revenue || 'not publicly itemized'} and market share ${share || 'not explicitly disclosed'}.`
    );
  }
  if (entryYear || entryMode) {
    baseParts.push(
      `Its market entry profile reflects ${entryMode || 'a staged entry approach'}${entryYear ? ` since ${entryYear}` : ''}.`
    );
  }
  if (projectName) {
    baseParts.push(`Representative project exposure includes ${projectName}.`);
  }
  if (growthRate) {
    baseParts.push(`Recent performance signals include ${growthRate} trajectory indicators.`);
  }

  if (baseParts.length === 0) {
    baseParts.push(
      `${name || 'This company'} remains strategically relevant due to local execution capability, partner access, and alignment with current procurement and compliance requirements.`
    );
  }

  let description = baseParts.join(' ').replace(/\s+/g, ' ').trim();
  let words = countWords(description);

  if (words < 45) {
    description +=
      ' It is most relevant where clients need bankable execution, measurable cost outcomes, and compliance-ready delivery under evolving policy and contracting standards.';
    words = countWords(description);
  }

  if (words > 60) {
    description =
      description
        .split(/\s+/)
        .slice(0, 60)
        .join(' ')
        .replace(/[,:;]+$/, '') + '.';
  }

  company.description = description;
  return company;
}

function sanitizePlaceholderStrings(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (!containsPlaceholderText(value)) return value;
    return null;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizePlaceholderStrings(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const next = sanitizePlaceholderStrings(v);
      if (next !== undefined) out[k] = next;
    }
    return out;
  }
  return value;
}

/**
 * Validate and apply honest fallbacks to competitors synthesis
 * Returns the result with fallbacks applied, logs warnings for missing data
 */
function validateCompetitorsSynthesis(result) {
  if (!result) return result;

  if (result._wasArray) delete result._wasArray;

  // Unwrap section_N wrappers that may contain expected sections.
  for (const [k, v] of Object.entries(result)) {
    if (!/^section_\d+$/.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (v.japanesePlayers || v.localMajor || v.foreignPlayers || v.caseStudy || v.maActivity) {
      Object.assign(result, v);
      delete result[k];
    }
  }

  // B3: Unwrap numeric keys from array-style responses (e.g. {"0": {...japanesePlayers...}, "1": {...}})
  const numericKeys = Object.keys(result).filter((k) => /^\d+$/.test(k));
  if (
    numericKeys.length > 0 &&
    !result.japanesePlayers &&
    !result.localMajor &&
    !result.foreignPlayers
  ) {
    console.log(
      `  [Synthesis] Competitor result had numeric keys [${numericKeys.join(',')}], unwrapping`
    );
    for (const k of numericKeys) {
      const inner = result[k];
      if (inner && typeof inner === 'object') {
        Object.assign(result, inner);
      }
      delete result[k];
    }
  }

  for (const key of Object.keys(result)) {
    if (isTransientResearchKey(key)) delete result[key];
  }

  const sections = ['japanesePlayers', 'localMajor', 'foreignPlayers'];
  const warnings = [];

  for (const section of sections) {
    const sectionData =
      result[section] && typeof result[section] === 'object' && !Array.isArray(result[section])
        ? result[section]
        : null;
    if (!sectionData) {
      warnings.push(`${section}: section missing`);
      continue;
    }
    if (!sectionData.slideTitle) {
      sectionData.slideTitle = `Competitors - ${humanizeSectionKey(section)}`;
    }
    const players = Array.isArray(sectionData.players) ? sectionData.players : [];
    if (players.length === 0) {
      warnings.push(`${section}: no players found`);
    }
    const seenNames = new Set();
    const cleanedPlayers = [];
    for (const rawPlayer of players) {
      if (!rawPlayer || typeof rawPlayer !== 'object') continue;
      const player = { ...rawPlayer };
      ensureHonestWebsite(player);
      ensureHonestDescription(player);
      if (
        containsPlaceholderText(player.description) ||
        hasTruncationArtifact(player.description)
      ) {
        ensureHonestDescription(player);
      }
      const normalized = sanitizePlaceholderStrings(player);
      if (!isViableCompetitorPlayer(normalized)) continue;
      const dedupeKey = ensureString(normalized.name).toLowerCase().trim();
      if (!dedupeKey || seenNames.has(dedupeKey)) continue;
      seenNames.add(dedupeKey);
      cleanedPlayers.push(normalized);
    }
    sectionData.players = cleanedPlayers;
    if (cleanedPlayers.length === 0) {
      warnings.push(`${section}: no viable players after semantic cleanup`);
    }
  }

  for (const key of ['caseStudy', 'maActivity']) {
    if (result[key] && containsPlaceholderText(ensureString(result[key].subtitle || ''))) {
      result[key].subtitle = null;
    }
  }

  const stableResult = {};
  for (const key of [
    'japanesePlayers',
    'localMajor',
    'foreignPlayers',
    'caseStudy',
    'maActivity',
  ]) {
    const value = result[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      stableResult[key] = value;
    }
  }

  // Remove known placeholder prose anywhere in competitors payload.
  const sanitizedResult = sanitizePlaceholderStrings(stableResult);

  if (warnings.length > 0) {
    console.log(`  [Synthesis] Competitor warnings: ${warnings.join('; ')}`);
  }

  return sanitizedResult;
}

function isMarketSectionLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Boolean(
    value.slideTitle ||
    value.subtitle ||
    value.overview ||
    value.keyInsight ||
    value.chartData ||
    Array.isArray(value.keyMetrics)
  );
}

const CANONICAL_MARKET_SECTION_KEYS = [
  'marketSizeAndGrowth',
  'supplyAndDemandDynamics',
  'pricingAndTariffStructures',
];

function getCanonicalMarketSlideTitle(sectionKey) {
  switch (sectionKey) {
    case 'marketSizeAndGrowth':
      return 'Market - Market Size & Growth';
    case 'supplyAndDemandDynamics':
      return 'Market - Supply & Demand Dynamics';
    case 'pricingAndTariffStructures':
      return 'Market - Pricing & Tariff Structures';
    default:
      return `Market - ${humanizeSectionKey(sectionKey)}`;
  }
}

function canonicalizeMarketSectionKey(rawKey, sectionValue) {
  if (isTransientResearchKey(rawKey)) return null;
  const keyToken = ensureString(rawKey).toLowerCase();
  const titleToken = ensureString(sectionValue?.slideTitle).toLowerCase();
  const subtitleToken = ensureString(sectionValue?.subtitle).toLowerCase();
  const overviewToken = ensureString(sectionValue?.overview).toLowerCase();
  const hint = `${keyToken} ${titleToken} ${subtitleToken} ${overviewToken}`.replace(
    /[^a-z0-9\s]/g,
    ' '
  );
  const compactHint = hint.replace(/\s+/g, '');
  const hasCompactAlias = (aliases) =>
    aliases.some((alias) => alias && compactHint.includes(alias));

  // Handle common camelCase/merged-key drift that fails word-boundary regex tests.
  if (
    hasCompactAlias([
      'marketsizeandgrowth',
      'marketsizegrowth',
      'marketsize',
      'growth',
      'segmentanalysis',
      'marketsegments',
      'tam',
      'sam',
    ])
  ) {
    return 'marketSizeAndGrowth';
  }

  if (
    hasCompactAlias([
      'supplyanddemanddynamics',
      'supplydemanddynamics',
      'supplyanddemand',
      'supplydemand',
      'infrastructuregrid',
      'gridinfrastructure',
      'infrastructure',
      'transmission',
      'distribution',
      'capacity',
    ])
  ) {
    return 'supplyAndDemandDynamics';
  }

  if (
    hasCompactAlias([
      'pricingandtariffstructures',
      'pricingandtariffs',
      'pricingtariffs',
      'priceandtariff',
      'pricing',
      'tariff',
      'dayrate',
      'benchmark',
      'economics',
      'cost',
    ])
  ) {
    return 'pricingAndTariffStructures';
  }

  if (
    /\bmarket\s*size\b|\bgrowth\b|\bcagr\b|\btam\b|\bmarket\s*value\b|\baddressable\b|\bsegment\b|\bserviceable\b|\bsam\b/.test(
      hint
    )
  ) {
    return 'marketSizeAndGrowth';
  }

  if (
    /\bsupply\b|\bdemand\b|\bconsumption\b|\bproduction\b|\bimport\b|\bexport\b|\bbalance\b|\binfrastructure\b|\bgrid\b|\bcapacity\b|\btransmission\b|\bdistribution\b/.test(
      hint
    )
  ) {
    return 'supplyAndDemandDynamics';
  }

  if (
    /\bpricing\b|\bprice\b|\btariff\b|\bcost\b|\bbenchmark\b|\beconomics\b|\bmmbtu\b|\brate\b|\bfee\b/.test(
      hint
    )
  ) {
    return 'pricingAndTariffStructures';
  }

  return null;
}

function scoreMarketSectionRichness(section) {
  if (!section || typeof section !== 'object') return 0;
  let score = 0;
  const keyMetrics = Array.isArray(section.keyMetrics) ? section.keyMetrics : [];
  score += Math.min(keyMetrics.length, 8);

  if (Array.isArray(section.chartData?.series) && section.chartData.series.length > 0) {
    score += 8;
  } else if (Array.isArray(section.chartData?.values) && section.chartData.values.length >= 3) {
    score += 6;
  }

  if (hasNumericSignal(section.subtitle)) score += 3;
  if (hasNumericSignal(section.overview)) score += 3;
  if (hasNumericSignal(section.keyInsight)) score += 3;
  if (ensureString(section.slideTitle)) score += 1;

  return score;
}

function pickRicherMarketSection(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  return scoreMarketSectionRichness(candidate) >= scoreMarketSectionRichness(current)
    ? candidate
    : current;
}

function normalizeMarketSynthesisResult(result) {
  if (!result) return result;

  let normalized = result;
  if (Array.isArray(normalized)) {
    const obj = {};
    normalized.forEach((item, i) => {
      if (item && typeof item === 'object') obj[`section_${i}`] = item;
    });
    normalized = obj;
  } else if (typeof normalized === 'object') {
    normalized = { ...normalized };
  } else {
    return result;
  }

  if (normalized._wasArray) delete normalized._wasArray;

  // Unwrap section_n containers that hold named section objects.
  for (const [key, value] of Object.entries({ ...normalized })) {
    if (!/^section_\d+$/.test(key) || !value || typeof value !== 'object') continue;

    if (Array.isArray(value)) {
      const firstObj = value.find((item) => item && typeof item === 'object');
      const metricLike =
        firstObj && ('metric' in firstObj || 'value' in firstObj || 'context' in firstObj);
      const seriesLike = firstObj && Array.isArray(firstObj.values);
      if (metricLike) {
        normalized[key] = {
          slideTitle: null,
          subtitle: null,
          overview: null,
          keyMetrics: value,
          chartData: null,
          keyInsight: null,
          dataType: 'time_series_multi_insight',
        };
      } else if (seriesLike) {
        normalized[key] = {
          slideTitle: null,
          subtitle: null,
          overview: null,
          keyMetrics: [],
          chartData: { series: value, categories: [] },
          keyInsight: null,
          dataType: 'time_series_multi_insight',
        };
      } else {
        normalized[key] = {
          slideTitle: null,
          subtitle: null,
          overview: null,
          keyMetrics: [],
          chartData: null,
          keyInsight: null,
          dataType: 'time_series_multi_insight',
        };
      }
      continue;
    }

    const nestedEntries = Object.entries(value).filter(
      ([, child]) => child && typeof child === 'object' && !Array.isArray(child)
    );
    const nestedSections = nestedEntries.filter(([, child]) => isMarketSectionLike(child));
    const directSection = isMarketSectionLike(value);

    if (!directSection && nestedSections.length > 0) {
      for (const [childKey, childValue] of nestedSections) {
        if (!normalized[childKey]) normalized[childKey] = childValue;
      }
      delete normalized[key];
    }
  }

  // Unwrap numeric-key containers from array-style JSON objects.
  const numericKeys = Object.keys(normalized).filter((k) => /^\d+$/.test(k));
  if (numericKeys.length > 0) {
    for (const key of numericKeys) {
      const value = normalized[key];
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          const firstObj = value.find((item) => item && typeof item === 'object');
          if (firstObj && ('metric' in firstObj || 'value' in firstObj || 'context' in firstObj)) {
            normalized[`section_${key}`] = {
              slideTitle: null,
              subtitle: null,
              overview: null,
              keyMetrics: value,
              chartData: null,
              keyInsight: null,
              dataType: 'time_series_multi_insight',
            };
          }
          delete normalized[key];
          continue;
        }
        if (isMarketSectionLike(value)) {
          normalized[`section_${key}`] = value;
        } else {
          for (const [childKey, childValue] of Object.entries(value)) {
            if (
              childValue &&
              typeof childValue === 'object' &&
              !Array.isArray(childValue) &&
              isMarketSectionLike(childValue) &&
              !normalized[childKey]
            ) {
              normalized[childKey] = childValue;
            }
          }
        }
      }
      delete normalized[key];
    }
  }

  return normalized;
}

/**
 * Validate and apply honest fallbacks to market synthesis
 * Returns the result with fallbacks applied
 */
function validateMarketSynthesis(result) {
  if (!result) return result;

  result = normalizeMarketSynthesisResult(result);

  // Canonicalize to stable market section keys and drop transient/extra sections.
  const discoveredSections = Object.entries(result).filter(
    ([k, v]) => !k.startsWith('_') && v && typeof v === 'object' && !Array.isArray(v)
  );
  const canonicalized = {};
  for (const [rawKey, rawSection] of discoveredSections) {
    const canonicalKey = canonicalizeMarketSectionKey(rawKey, rawSection);
    if (!canonicalKey) continue;
    canonicalized[canonicalKey] = pickRicherMarketSection(canonicalized[canonicalKey], rawSection);
  }

  result = canonicalized;
  const sections = CANONICAL_MARKET_SECTION_KEYS.filter(
    (k) => result[k] && typeof result[k] === 'object'
  );
  let chartCount = 0;

  for (const section of sections) {
    if (!result[section]?.slideTitle) {
      result[section] = result[section] || {};
      result[section].slideTitle = getCanonicalMarketSlideTitle(section);
    }
    if (containsPlaceholderText(result[section]?.slideTitle)) {
      result[section].slideTitle = getCanonicalMarketSlideTitle(section);
    }

    const chartData = result[section]?.chartData;
    if (chartData) {
      // Enforce series/categories format; convert historical/projected if needed
      if (Array.isArray(chartData.series) && chartData.series.length > 0) {
        // Validate that values are numbers
        for (const s of chartData.series) {
          if (Array.isArray(s.values)) {
            s.values = s.values.map((v) => (typeof v === 'number' ? v : Number(v) || 0));
          }
        }
        chartCount++;
      } else if (chartData.historical || chartData.projected) {
        // Convert historical/projected format to series/categories
        const series = [];
        const catSet = new Set();
        for (const [key, data] of Object.entries(chartData)) {
          if (key === 'series' || key === 'categories' || key === 'unit') continue;
          if (data && typeof data === 'object') {
            for (const [cat] of Object.entries(data)) {
              catSet.add(cat);
            }
            series.push({ name: key, values: Object.values(data).map(Number) });
          }
        }
        if (series.length > 0) {
          chartData.series = series;
          chartData.categories = [...catSet];
          chartCount++;
        }
      }
    }
    // Ensure keyInsight exists with honest fallback
    if (!result[section]?.keyInsight) {
      if (result[section]) {
        const subtitle = ensureString(result[section]?.subtitle || '');
        const overview = ensureString(result[section]?.overview || '');
        result[section].keyInsight =
          subtitle ||
          overview ||
          'Prioritize segments with quantified demand and explicit policy or cost triggers.';
      }
    }
    if (containsPlaceholderText(result[section]?.keyInsight)) {
      result[section].keyInsight =
        'Prioritize segments with quantified demand and explicit policy or cost triggers.';
    }
  }

  // Ensure stable output order and prevent transient keys from leaking downstream.
  result = Object.fromEntries(
    CANONICAL_MARKET_SECTION_KEYS.filter((k) => result[k]).map((k) => [k, result[k]])
  );

  if (chartCount < 2) {
    console.log(`  [Synthesis] Market warning: only ${chartCount} sections have valid chart data`);
  }

  return sanitizePlaceholderStrings(result);
}

/**
 * Validate and apply honest fallbacks to policy synthesis
 */
function validatePolicySynthesis(result) {
  if (!result) return result;

  if (result._wasArray) delete result._wasArray;
  if (!result.foundationalActs || typeof result.foundationalActs !== 'object') {
    result.foundationalActs = {};
  }
  if (!result.nationalPolicy || typeof result.nationalPolicy !== 'object') {
    result.nationalPolicy = {};
  }
  if (!result.investmentRestrictions || typeof result.investmentRestrictions !== 'object') {
    result.investmentRestrictions = {};
  }
  if (!result.foundationalActs.slideTitle) {
    result.foundationalActs.slideTitle = 'Policy - Foundational Acts';
  }
  if (!result.nationalPolicy.slideTitle) {
    result.nationalPolicy.slideTitle = 'Policy - National Policy';
  }
  if (!result.investmentRestrictions.slideTitle) {
    result.investmentRestrictions.slideTitle = 'Policy - Foreign Investment Rules';
  }

  const acts = result.foundationalActs?.acts || [];
  if (acts.length < 2) {
    console.log(`  [Synthesis] Policy warning: only ${acts.length} regulations found`);
  }

  // Ensure each act has required fields with honest fallbacks
  acts.forEach((act) => {
    if (!act.enforcement) {
      act.enforcement =
        'Enforcement varies by regulator capacity and audit intensity; include pre-bid compliance diligence and periodic legal checks.';
    }
    if (containsPlaceholderText(act.enforcement)) {
      act.enforcement =
        'Enforcement varies by regulator capacity and audit intensity; include pre-bid compliance diligence and periodic legal checks.';
    }
  });

  return sanitizePlaceholderStrings(result);
}

/**
 * Repair policy payloads when the model returns array-wrapped sections.
 * Converts {section_0: {...}, _wasArray:true} into expected policy keys when possible.
 */
function normalizePolicySynthesisResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;

  const normalized = { ...result };
  const sectionEntries = Object.entries(normalized).filter(
    ([key, value]) => /^section_\d+$/.test(key) && value && typeof value === 'object'
  );

  for (const [, section] of sectionEntries) {
    if (!section || typeof section !== 'object') continue;

    if (Array.isArray(section)) {
      const firstObj = section.find((item) => item && typeof item === 'object');
      if (!firstObj) continue;

      if (
        !normalized.foundationalActs &&
        (('name' in firstObj && ('year' in firstObj || 'requirements' in firstObj)) ||
          ('act' in firstObj && 'year' in firstObj))
      ) {
        normalized.foundationalActs = { acts: section };
      }
      if (
        !normalized.nationalPolicy &&
        ('metric' in firstObj || 'target' in firstObj || 'deadline' in firstObj)
      ) {
        normalized.nationalPolicy = { targets: section };
      }
      if (
        !normalized.regulatorySummary &&
        ('domain' in firstObj || 'currentState' in firstObj || 'futureState' in firstObj)
      ) {
        normalized.regulatorySummary = section;
      }
      if (
        !normalized.keyIncentives &&
        ('initiative' in firstObj ||
          'benefit' in firstObj ||
          'highlights' in firstObj ||
          'eligibility' in firstObj)
      ) {
        normalized.keyIncentives = section;
      }
      if (!normalized.sources && ('url' in firstObj || 'title' in firstObj)) {
        normalized.sources = section;
      }
      continue;
    }

    // Case 1: section contains nested expected keys
    if (!normalized.foundationalActs && section.foundationalActs) {
      normalized.foundationalActs = section.foundationalActs;
    }
    if (!normalized.nationalPolicy && section.nationalPolicy) {
      normalized.nationalPolicy = section.nationalPolicy;
    }
    if (!normalized.investmentRestrictions && section.investmentRestrictions) {
      normalized.investmentRestrictions = section.investmentRestrictions;
    }
    if (!normalized.keyIncentives && Array.isArray(section.keyIncentives)) {
      normalized.keyIncentives = section.keyIncentives;
    }
    if (!normalized.regulatorySummary && Array.isArray(section.regulatorySummary)) {
      normalized.regulatorySummary = section.regulatorySummary;
    }
    if (!normalized.sources && Array.isArray(section.sources)) {
      normalized.sources = section.sources;
    }

    // Case 2: section is itself a policy sub-block payload
    if (
      !normalized.foundationalActs &&
      (Array.isArray(section.acts) || section.keyMessage || section.enforcement)
    ) {
      normalized.foundationalActs = section;
    }
    if (
      !normalized.nationalPolicy &&
      (section.policyDirection ||
        Array.isArray(section.targets) ||
        Array.isArray(section.keyInitiatives))
    ) {
      normalized.nationalPolicy = section;
    }
    if (
      !normalized.investmentRestrictions &&
      (section.ownershipLimits ||
        Array.isArray(section.incentives) ||
        section.riskLevel ||
        section.riskJustification)
    ) {
      normalized.investmentRestrictions = section;
    }

    // Case 3: infer by slide title when section payload shape is ambiguous.
    const slideTitle = ensureString(section.slideTitle).toLowerCase();
    if (
      !normalized.foundationalActs &&
      /\b(foundational|act|acts|law|regulatory framework|licensing)\b/.test(slideTitle)
    ) {
      normalized.foundationalActs = section;
    }
    if (
      !normalized.nationalPolicy &&
      /\b(national policy|master plan|energy transition|pdp8|decarbonization|policy)\b/.test(
        slideTitle
      )
    ) {
      normalized.nationalPolicy = section;
    }
    if (
      !normalized.investmentRestrictions &&
      /\b(investment|ownership|foreign|incentive|trade)\b/.test(slideTitle)
    ) {
      normalized.investmentRestrictions = section;
    }
  }

  // Case 4: positional fallback for array-wrapped policy payloads.
  // Some models return policy blocks as [{...},{...},...] without keys.
  if (
    sectionEntries.length > 0 &&
    !normalized.foundationalActs &&
    !normalized.nationalPolicy &&
    !normalized.investmentRestrictions
  ) {
    const orderedSections = sectionEntries
      .slice()
      .sort(([a], [b]) => Number(a.replace('section_', '')) - Number(b.replace('section_', '')))
      .map(([, value]) => value)
      .filter((value) => value && typeof value === 'object');

    if (orderedSections[0]) {
      normalized.foundationalActs = Array.isArray(orderedSections[0])
        ? { acts: orderedSections[0] }
        : orderedSections[0];
    }
    if (orderedSections[1]) {
      normalized.nationalPolicy = Array.isArray(orderedSections[1])
        ? { targets: orderedSections[1] }
        : orderedSections[1];
    }
    if (orderedSections[2]) {
      normalized.investmentRestrictions = Array.isArray(orderedSections[2])
        ? { incentives: orderedSections[2] }
        : orderedSections[2];
    }
    if (!normalized.regulatorySummary && Array.isArray(orderedSections[3])) {
      normalized.regulatorySummary = orderedSections[3];
    }
    if (!normalized.keyIncentives && Array.isArray(orderedSections[4])) {
      normalized.keyIncentives = orderedSections[4];
    }
    if (!normalized.sources && Array.isArray(orderedSections[5])) {
      normalized.sources = orderedSections[5];
    }
  }

  for (const key of Object.keys(normalized)) {
    if (/^section_\d+$/.test(key)) delete normalized[key];
  }
  if (normalized._wasArray) delete normalized._wasArray;

  return normalized;
}

/**
 * Synthesize with fallback chain:
 * 1. Gemini jsonMode → 2. Truncation repair → 3. Gemini no-jsonMode + boosted tokens
 * → optional 4. GeminiPro jsonMode → optional 5. GeminiPro no-jsonMode
 */
async function synthesizeWithFallback(prompt, options = {}) {
  const {
    maxTokens = 8192,
    jsonMode = true,
    accept = null,
    label = 'Synthesis',
    allowArrayNormalization = false,
    allowTruncationRepair = false,
    allowRawExtractionFallback = true,
    allowProTiers = true,
    systemPrompt = null,
  } = options;
  const strictSuffix =
    '\n\nCRITICAL: Return ONLY valid JSON. No markdown. No explanation. No trailing text. Just the raw JSON object. Use null for missing fields.';

  // Helper: convert array responses to object with _wasArray flag when explicitly allowed.
  function ensureObject(val) {
    if (!allowArrayNormalization) return val;
    if (Array.isArray(val)) {
      console.warn(
        '  [Synthesis] WARNING: AI returned array instead of object, tagging with _wasArray'
      );
      const obj = {};
      val.forEach((item, i) => {
        obj[`section_${i}`] = item;
      });
      obj._wasArray = true;
      return obj;
    }
    return val;
  }

  function getRejectReason(acceptResult) {
    if (acceptResult === false || acceptResult == null) return 'semantic gate returned false';
    if (typeof acceptResult === 'string') return acceptResult;
    if (typeof acceptResult === 'object') {
      if (acceptResult.pass === false) {
        return (
          acceptResult.reason ||
          acceptResult.message ||
          acceptResult.details ||
          'semantic gate returned pass=false'
        );
      }
      if (acceptResult.pass === true) return '';
      return acceptResult.reason || acceptResult.message || acceptResult.details || '';
    }
    return '';
  }

  function applySemanticGate(candidate, tierName) {
    const objectCandidate = ensureObject(candidate);
    if (!accept || typeof accept !== 'function') return objectCandidate;
    try {
      const gateResult = accept(objectCandidate);
      const accepted =
        gateResult === true ||
        (typeof gateResult === 'object' && gateResult !== null && gateResult.pass !== false);
      if (accepted) return objectCandidate;
      const reason = getRejectReason(gateResult);
      console.warn(
        `  [${label}] ${tierName} rejected by semantic gate${reason ? `: ${reason}` : ''}`
      );
      return null;
    } catch (gateErr) {
      console.warn(`  [${label}] ${tierName} acceptance check failed: ${gateErr?.message}`);
      return null;
    }
  }

  function isRateLimitOrQuotaError(error) {
    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes('429') ||
      message.includes('resource_exhausted') ||
      message.includes('quota exceeded') ||
      message.includes('rate limit')
    );
  }

  let flashQuotaLimited = false;

  async function waitBeforeNextTier() {
    if (CFG_SYNTHESIS_TIER_DELAY_MS <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, CFG_SYNTHESIS_TIER_DELAY_MS));
  }

  // Tier 1: callGemini jsonMode (fast path)
  try {
    const result = await callGemini(prompt, {
      maxTokens,
      jsonMode,
      temperature: 0.2,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    const text = typeof result === 'string' ? result : result?.content || '';
    try {
      const parsed = parseJsonResponse(text);
      if (parsed) {
        const accepted = applySemanticGate(parsed, 'Tier 1 (Gemini jsonMode)');
        if (accepted) {
          console.log(`  [${label}] Tier 1 (Gemini jsonMode) succeeded`);
          return accepted;
        }
      }
    } catch (parseErr) {
      // Tier 2: Truncation repair on raw text
      console.warn(`  [${label}] Tier 1 parse failed: ${parseErr?.message}`);
      if (allowRawExtractionFallback && allowTruncationRepair && text && isJsonTruncated(text)) {
        console.log(`  [${label}] Tier 2: Detected truncation, attempting repair...`);
        try {
          const repaired = repairTruncatedJson(text);
          const extractResult = extractJsonFromContent(repaired);
          if (extractResult.status === 'success' && extractResult.data) {
            const accepted = applySemanticGate(extractResult.data, 'Tier 2 (truncation repair)');
            if (accepted) {
              console.log(`  [${label}] Tier 2 (truncation repair) succeeded`);
              return accepted;
            }
          }
        } catch (repairErr) {
          console.warn(`  [${label}] Tier 2 repair failed: ${repairErr?.message}`);
        }
      }
      if (allowRawExtractionFallback) {
        // Also try multi-strategy extraction on raw text
        const extractResult = extractJsonFromContent(text);
        if (extractResult.status === 'success' && extractResult.data) {
          const accepted = applySemanticGate(extractResult.data, 'Tier 2 (extract from raw)');
          if (accepted) {
            console.log(`  [${label}] Tier 2 (extract from raw) succeeded`);
            return accepted;
          }
        }
      }
    }
  } catch (geminiErr) {
    if (isRateLimitOrQuotaError(geminiErr)) {
      flashQuotaLimited = true;
    }
    console.warn(`  [${label}] Tier 1 Gemini call failed: ${geminiErr?.message}`);
  }

  if (!flashQuotaLimited) {
    await waitBeforeNextTier();

    // Tier 3: callGemini NO jsonMode + boosted tokens (let model finish naturally)
    try {
      const boostedTokens = Math.min(Math.round(maxTokens * 1.5), 32768);
      const result = await callGemini(prompt + strictSuffix, {
        maxTokens: boostedTokens,
        jsonMode: false,
        temperature: 0.1,
        ...(systemPrompt ? { systemPrompt } : {}),
      });
      const text = typeof result === 'string' ? result : result?.content || '';
      try {
        const parsed = parseJsonResponse(text);
        if (parsed) {
          const accepted = applySemanticGate(parsed, 'Tier 3 (Gemini no-jsonMode strict parse)');
          if (accepted) {
            console.log(`  [${label}] Tier 3 (Gemini no-jsonMode strict parse) succeeded`);
            return accepted;
          }
        }
      } catch (parseErr3) {
        console.warn(`  [${label}] Tier 3 strict parse failed: ${parseErr3?.message}`);
      }
      if (allowRawExtractionFallback) {
        const extractResult = extractJsonFromContent(text);
        if (extractResult.status === 'success' && extractResult.data) {
          const accepted = applySemanticGate(
            extractResult.data,
            'Tier 3 (Gemini no-jsonMode, boosted tokens)'
          );
          if (accepted) {
            console.log(`  [${label}] Tier 3 (Gemini no-jsonMode, boosted tokens) succeeded`);
            return accepted;
          }
        }
        if (allowTruncationRepair && text && isJsonTruncated(text)) {
          const repaired = repairTruncatedJson(text);
          const repairResult = extractJsonFromContent(repaired);
          if (repairResult.status === 'success' && repairResult.data) {
            const accepted = applySemanticGate(repairResult.data, 'Tier 3 (repaired)');
            if (accepted) {
              console.log(`  [${label}] Tier 3 (repaired) succeeded`);
              return accepted;
            }
          }
        }
      }
    } catch (err3) {
      if (isRateLimitOrQuotaError(err3)) {
        flashQuotaLimited = true;
      }
      console.warn(`  [${label}] Tier 3 failed: ${err3?.message}`);
    }
  } else {
    console.warn(`  [${label}] Skipping Tier 3 Flash retry due quota/rate-limit signal`);
  }

  if (allowProTiers) {
    if (flashQuotaLimited) {
      console.log(`  [${label}] Flash quota-limited — escalating directly to GeminiPro tiers`);
    }
    await waitBeforeNextTier();
    // Tier 4: callGeminiPro jsonMode (stronger model)
    try {
      const result = await callGeminiPro(prompt, {
        maxTokens,
        jsonMode,
        temperature: 0.2,
        ...(systemPrompt ? { systemPrompt } : {}),
      });
      const text = typeof result === 'string' ? result : result?.content || '';
      try {
        const parsed = parseJsonResponse(text);
        if (parsed) {
          const accepted = applySemanticGate(parsed, 'Tier 4 (GeminiPro jsonMode)');
          if (accepted) {
            console.log(`  [${label}] Tier 4 (GeminiPro jsonMode) succeeded`);
            return accepted;
          }
        }
      } catch (parseErr4) {
        console.warn(`  [${label}] Tier 4 parse failed: ${parseErr4?.message}`);
        if (allowRawExtractionFallback) {
          const extractResult = extractJsonFromContent(text);
          if (extractResult.status === 'success' && extractResult.data) {
            const accepted = applySemanticGate(extractResult.data, 'Tier 4 (extract)');
            if (accepted) {
              console.log(`  [${label}] Tier 4 (extract) succeeded`);
              return accepted;
            }
          }
        }
      }
    } catch (err4) {
      console.warn(`  [${label}] Tier 4 failed: ${err4?.message}`);
    }

    await waitBeforeNextTier();
    // Tier 5: callGeminiPro NO jsonMode (last resort, highest capability)
    try {
      const boostedTokens = Math.min(Math.round(maxTokens * 1.5), 32768);
      const result = await callGeminiPro(prompt + strictSuffix, {
        maxTokens: boostedTokens,
        jsonMode: false,
        temperature: 0.1,
        ...(systemPrompt ? { systemPrompt } : {}),
      });
      const text = typeof result === 'string' ? result : result?.content || '';
      try {
        const parsed = parseJsonResponse(text);
        if (parsed) {
          const accepted = applySemanticGate(parsed, 'Tier 5 (GeminiPro no-jsonMode strict parse)');
          if (accepted) {
            console.log(`  [${label}] Tier 5 (GeminiPro no-jsonMode strict parse) succeeded`);
            return accepted;
          }
        }
      } catch (parseErr5) {
        console.warn(`  [${label}] Tier 5 strict parse failed: ${parseErr5?.message}`);
      }
      if (allowRawExtractionFallback) {
        const extractResult = extractJsonFromContent(text);
        if (extractResult.status === 'success' && extractResult.data) {
          const accepted = applySemanticGate(extractResult.data, 'Tier 5 (GeminiPro no-jsonMode)');
          if (accepted) {
            console.log(`  [${label}] Tier 5 (GeminiPro no-jsonMode) succeeded`);
            return accepted;
          }
        }
        if (allowTruncationRepair && text && isJsonTruncated(text)) {
          const repaired = repairTruncatedJson(text);
          const repairResult = extractJsonFromContent(repaired);
          if (repairResult.status === 'success' && repairResult.data) {
            const accepted = applySemanticGate(repairResult.data, 'Tier 5 (GeminiPro repaired)');
            if (accepted) {
              console.log(`  [${label}] Tier 5 (GeminiPro repaired) succeeded`);
              return accepted;
            }
          }
        }
      }
    } catch (err5) {
      console.error(`  [${label}] Tier 5 (final) failed: ${err5?.message}`);
    }
  }

  return null;
}

/**
 * Mark low-confidence research data with quality labels in the prompt context.
 * Topics with dataQuality "low" or "incomplete" get prefixed so the AI model hedges appropriately.
 */
function markDataQuality(filteredData, options = {}) {
  const {
    maxTopics = Number.POSITIVE_INFINITY,
    maxContentChars = 2200,
    maxCitations = 8,
    maxStructuredChars = 1200,
  } = options;

  const marked = {};
  const entries = Object.entries(filteredData || {});
  const topicLimit = Number.isFinite(Number(maxTopics))
    ? Math.max(1, Number(maxTopics))
    : entries.length;
  for (const [key, value] of entries.slice(0, topicLimit)) {
    const compactValue = compactResearchEntryForPrompt(value, {
      maxContentChars,
      maxCitations,
      maxStructuredChars,
    });
    const quality = value?.dataQuality;
    if (quality === 'low' || quality === 'estimated') {
      marked[`[ESTIMATED] ${key}`] = compactValue;
    } else if (quality === 'incomplete') {
      marked[`[UNVERIFIED] ${key}`] = compactValue;
    } else {
      marked[key] = compactValue;
    }
  }
  return marked;
}

// ============ SYNTHESIS STYLE GUIDE ============
// Consistent tone/style matching the consulting deck template
const SYNTHESIS_STYLE_GUIDE = `
WRITING STYLE (MANDATORY — match this EXACTLY):
- Write like a senior management consultant presenting to a CEO. Strategic, analytical, forward-looking.
- Frame EVERY finding in terms of CLIENT IMPLICATIONS: "This enables foreign entrants to..." not "The law states..."
- Use CONDITIONAL language where appropriate: "may become more streamlined", "will depend on implementation", "remains to be seen"
- NEVER make absolute claims without evidence. Hedge uncertain points.
- Cite specific law names with numbers inline: "Petroleum Law No. 12/2022/QH15" not "the petroleum law"
- Every slide title subtitle should be a THESIS STATEMENT — the key takeaway, not a description. Example:
  GOOD: "Vietnam is selectively opening competition, with recent reforms prioritizing private-sector participation in demand-side efficiency"
  BAD: "Overview of Vietnam's regulatory environment"
- Use strategic vocabulary: "structurally attractive", "underpinned by", "selectively positioned", "scalable commercial models"
- Connect data points causally: "X happened because Y, which means Z for the client"
- NEVER write generic filler like "the market is growing" — always attach numbers, timelines, and implications
`;

// ============ TEMPLATE NARRATIVE PATTERN ============
// Extracted from the Escort template's actual slide structure — the PATTERN, not content.
// Used by buildStoryPlan() to guide narrative arc for ANY industry/country.

const TEMPLATE_NARRATIVE_PATTERN = {
  narrativeFlow:
    'regulatory landscape → market opportunity sizing → competitive dynamics → entry strategy → action plan',
  slidePatterns: {
    policy: {
      count: 3,
      flow: 'foundational laws (what exists) → national targets (where heading) → investment rules (how to enter)',
      eachSlide:
        'Thesis title stating client implication, NOT topic description. 3-5 specific laws/regulations with year+enforcement. Transition table: pre-reform → key change → resulting landscape.',
      example:
        '1.1 The Foundational Acts: Defining Control & Competition — Vietnam is selectively opening competition, with recent reforms prioritizing private-sector participation',
    },
    market: {
      count: 6,
      flow: 'total supply (macro context) → demand by sector (where the money is) → generation mix (infrastructure) → subsector deep-dive → pricing (unit economics) → services market (client actual market)',
      eachSlide:
        'Chart with historical + projected data. 2-3 bullet insights connecting data to client opportunity. Source citations with specific report names.',
      example:
        '2.3 Electricity & Power Generation — Rapid capacity expansion underpinned by coal-to-gas transition creates $4.2B services opportunity',
    },
    competitors: {
      count: 5,
      flow: 'Japanese/similar peers (what others like client did) → local majors (who to partner with) → foreign players (who to compete with) → case study (what worked) → M&A (what is available)',
      eachSlide:
        'Company profiles: name, website, revenue, market share, entry year, entry mode, local partner. Strategic assessment per company. 45-60 word descriptions.',
      example:
        '3.1 Japanese Energy Companies — JERA and Tokyo Gas have established footholds through JVs, creating both partnership templates and competitive pressure',
    },
    depth: {
      count: 5,
      flow: 'deal economics (profitable?) → partner assessment (who to work with?) → entry strategy (JV vs acquisition vs greenfield) → implementation roadmap → target segments',
      eachSlide:
        'Decision-enabling data: specific numbers for deal sizes, timelines, valuations. Harvey ball comparisons for entry options.',
    },
    summary: {
      flow: 'exec summary (4 paragraphs: opportunity → regulation → market → competition+entry) → key insights (3-5 with data+pattern+implication) → next steps (5 specific actions)',
      eachSlide:
        'Every sentence must reference specific data from earlier slides. No new information introduced here.',
    },
  },
  toneProgression:
    "Slides 1-3: 'Here is the landscape' (neutral) → Slides 4-9: 'Here is the opportunity' (optimistic-with-caveats) → Slides 10-14: 'Here is who you are up against' (analytical) → Slides 15-20: 'Here is how to win' (action-oriented)",
};

// ============ STORY ARCHITECT ============
// Plans narrative arc and per-slide thesis BEFORE synthesis

async function buildStoryPlan(researchData, country, industry, scope) {
  console.log(`\n  [STORY] Building narrative plan for ${country}...`);
  const storyStart = Date.now();
  const scopeGuard = getClientScopeGuard(scope?.industry || industry, scope?.clientContext || '');

  // Build detailed research summary — story architect needs to see the data to plan the story
  const researchSummary = {};
  for (const [key, value] of Object.entries(researchData)) {
    researchSummary[key] = {
      name: value.name || key,
      category: key.split('_')[0] || 'unknown',
      dataQuality: value.dataQuality || 'unknown',
      keyContent: value.structuredData
        ? JSON.stringify(value.structuredData).substring(0, 4000)
        : (value.content || '').substring(0, 4000),
      citationCount: (value.citations || []).length,
      deepened: value.deepened || false,
    };
  }

  const storyPrompt = `You are a SENIOR PARTNER at McKinsey planning the narrative strategy for a ${scope.industry} market entry presentation for ${country}.

This is the most important step. The story you plan HERE determines whether the final deck reads like a strategic advisory document or a Wikipedia dump. Think deeply.

Client: ${scope.clientContext || 'International company evaluating market entry'}
Project type: ${scope.projectType || 'market_entry'}
${scopeGuard ? `\n${scopeGuard}\n` : ''}

TEMPLATE NARRATIVE PATTERN (structural guide — follow this framework):
${JSON.stringify(TEMPLATE_NARRATIVE_PATTERN, null, 2)}

RESEARCH DATA AVAILABLE (${Object.keys(researchSummary).length} topics):
${JSON.stringify(researchSummary, null, 2)}

=== YOUR TASK ===

STEP 1: IDENTIFY 3 POSSIBLE STORYLINES
Before committing to a narrative, brainstorm 3 distinct storylines this data could support. Each storyline emphasizes different aspects of the research:

Example storylines:
- "Regulatory window" — story centers on a policy change creating a time-limited opportunity
- "Competitive vacuum" — story centers on weak local players leaving market share on the table
- "Infrastructure boom" — story centers on massive investment creating demand
- "Cost arbitrage" — story centers on pricing dynamics favoring new entrants
- "Partnership play" — story centers on available JV partners making entry easy

STEP 2: EVALUATE AND PICK THE BEST
For each of the 3 storylines, assess:
- How well does the research data support it? (do we have the numbers?)
- How compelling is it for a CEO making a $10M+ decision?
- Does it lead to a clear call-to-action?

Pick the STRONGEST storyline — the one with the best data support AND most compelling client implications.

STEP 3: PLAN PER-SLIDE NARRATIVE
Using the chosen storyline and the template narrative pattern, plan each slide's thesis.

Return JSON:
{
  "storylineCandidates": [
    {
      "name": "2-3 word name",
      "hook": "1 sentence — why would the CEO care?",
      "dataSupport": "strong|moderate|weak",
      "reasoning": "why this storyline works or doesn't"
    }
  ],
  "chosenStoryline": "name of the picked storyline",
  "whyChosen": "1-2 sentences on why this one wins",
  "narrativeArc": "2-3 sentence overall story for ${country} ${scope.industry} — must be specific, not generic",
  "slides": [
    {
      "section": "policy|market|competitors|depth|summary",
      "slideKey": "descriptive key like foundationalActs, marketSize, japanesePeers, etc.",
      "thesis": "Specific thesis grounded in research findings. Must state a CLAIM, not a topic. Bad: 'Overview of regulations'. Good: 'Three recent regulatory changes create a 24-month entry window' (100-180 chars)",
      "keyDataToFeature": ["Specific law/company/number from research", "Another specific finding"],
      "connectsTo": "How this slide's conclusion sets up the QUESTION the next slide answers",
      "tone": "neutral|opportunity|analytical|action-oriented"
    }
  ],
  "insightPriorities": ["Top 3-5 cross-cutting insights that connect dots across sections"],
  "clientImplication": "The single most important takeaway — must be a specific recommendation, not vague"
}

RULES:
- storylineCandidates must have EXACTLY 3 options — no more, no fewer
- Each thesis must be a CLAIM, not a topic label. "The market is growing" = bad. "Three converging factors create a $2B opportunity by 2027" = good.
- keyDataToFeature must reference ACTUAL data from the research — specific law names, company names, dollar amounts, percentages
- If research is weak for a section, the thesis should acknowledge it honestly
- connectsTo must explain the LOGICAL link, not just "leads to next section"
- Minimum 15 slides, maximum 22 slides
- clientImplication must be actionable — "enter now via JV" not "consider exploring"

Return ONLY valid JSON.`;

  try {
    const result = await callGeminiPro(storyPrompt, {
      temperature: 0.4,
      maxTokens: 12000,
      jsonMode: true,
    });

    const text = typeof result === 'string' ? result : result.content || '';
    const extracted = extractJsonFromContent(text);

    if (extracted.status !== 'success' || !extracted.data) {
      console.warn('  [STORY] Failed to parse story plan, synthesis will use style guide only');
      return null;
    }

    const storyPlan = extracted.data;
    const slideCount = (storyPlan.slides || []).length;
    const candidates = storyPlan.storylineCandidates || [];
    console.log(`  [STORY] Evaluated ${candidates.length} storylines:`);
    for (const c of candidates) {
      console.log(`    - "${c.name}" (${c.dataSupport}): ${c.hook}`);
    }
    console.log(`  [STORY] Chose: "${storyPlan.chosenStoryline}" — ${storyPlan.whyChosen || ''}`);
    console.log(
      `  [STORY] Planned ${slideCount} slides. Arc: "${(storyPlan.narrativeArc || '').substring(0, 120)}..."`
    );
    console.log(`  [STORY] Completed in ${((Date.now() - storyStart) / 1000).toFixed(1)}s`);

    return storyPlan;
  } catch (err) {
    console.error(`  [STORY] Failed: ${err.message}`);
    return null;
  }
}

// Helper: extract story plan instructions for a specific section
function getStoryInstructions(storyPlan, section) {
  if (!storyPlan || !storyPlan.slides) return '';

  const sectionSlides = storyPlan.slides.filter((s) => s.section === section);
  if (sectionSlides.length === 0) return '';

  let instructions = `\nNARRATIVE PLAN (follow this story arc):
- Overall narrative: "${storyPlan.narrativeArc}"
`;

  for (const slide of sectionSlides) {
    instructions += `\n- Slide "${slide.slideKey}":
  Thesis: "${slide.thesis}"
  Key data to feature: ${(slide.keyDataToFeature || []).join(', ')}
  Connects to next: "${slide.connectsTo}"
  Tone: ${slide.tone}`;
  }

  if (section === 'summary' && storyPlan.insightPriorities) {
    instructions += `\n\n- Priority insights for executive summary: ${storyPlan.insightPriorities.join('; ')}`;
    instructions += `\n- Client implication: "${storyPlan.clientImplication}"`;
  }

  return instructions;
}

/**
 * Synthesize POLICY section with depth requirements
 */
async function synthesizePolicy(researchData, country, industry, clientContext, storyPlan) {
  console.log(`  [Synthesis] Policy section for ${country}...`);

  const filteredData = selectResearchTopicsByPrefix(researchData, 'policy');

  const dataAvailable = Object.keys(filteredData).length > 0;
  console.log(
    `    [Policy] Filtered research data: ${Object.keys(filteredData).length} topics (${dataAvailable ? Object.keys(filteredData).slice(0, 3).join(', ') : 'NONE'})`
  );

  const labeledData = markDataQuality(filteredData, {
    maxTopics: 4,
    maxContentChars: CFG_SYNTHESIS_TOPIC_MAX_CHARS,
    maxCitations: 10,
  });
  const researchContext = dataAvailable
    ? `RESEARCH DATA (use this as primary source — items prefixed [ESTIMATED] or [UNVERIFIED] are uncertain, hedge accordingly):
${JSON.stringify(labeledData, null, 2)}`
    : `RESEARCH DATA: EMPTY due to API issues.`;

  const storyInstructions = getStoryInstructions(storyPlan, 'policy');
  const prompt = `You are synthesizing policy and regulatory research for ${country}'s ${industry} market.
Client context: ${clientContext}
${SYNTHESIS_STYLE_GUIDE}${storyInstructions}
${researchContext}

If research data is insufficient for a field, set the value to:
- For arrays: empty array []
- For strings: null
- For numbers: null
- For objects: null
NEVER output literal placeholders such as "Insufficient research data for this field".
DO NOT fabricate data. DO NOT estimate from training knowledge.

ANTI-PADDING RULE:
- Do NOT substitute general/macro economic data (GDP, population, inflation, general trade statistics) when industry-specific data is unavailable
- If you cannot find ${industry}-specific data for a field, use the null/empty value — do NOT fill it with country-level macro data
- Example: If asked for "${industry} market size" and you only know "country GDP is $500B" — return null, not the GDP figure
- Macro data is ONLY acceptable in contextual/background fields explicitly labeled as such

RULES:
- Only use data from the INPUT DATA above
- Use null for any missing fields
- Include source citations where available
- Insights should reference specific numbers from the data

Return JSON:
{
  "foundationalActs": {
    "slideTitle": "${country} - ${industry} Foundational Acts",
    "subtitle": "THESIS STATEMENT: 1-2 sentences (100-180 chars) explaining the KEY TAKEAWAY for the client. Example: '${country} is selectively opening competition, with recent reforms prioritizing private-sector participation in demand-side efficiency'",
    "acts": [
      {"name": "Official Act Name", "year": "YYYY", "requirements": "30-50 words per cell with specific regulatory citations and article numbers", "penalties": "30-50 words per cell with specific monetary values, imprisonment terms, or administrative actions", "enforcement": "30-50 words on enforcement reality: agency name, capacity, actual compliance rates"}
    ],
    "keyMessage": "One sentence insight connecting regulations to client opportunity"
  },
  "nationalPolicy": {
    "slideTitle": "${country} - National ${industry} Policy",
    "policyDirection": "Current government stance with evidence",
    "targets": [
      {"metric": "Named target", "target": "Specific number", "deadline": "Year", "status": "Current status"}
    ],
    "keyInitiatives": ["Named initiative with budget/timeline"]
  },
  "investmentRestrictions": {
    "slideTitle": "${country} - Foreign Investment Rules",
    "ownershipLimits": {"general": "X%", "promoted": "X%", "exceptions": "Specific exceptions"},
    "incentives": [
      {"name": "Named incentive program", "benefit": "Specific benefit with numbers", "eligibility": "Who qualifies"}
    ],
    "riskLevel": "low/medium/high",
    "riskJustification": "Specific reasoning with evidence"
  },
  "regulatorySummary": [
    {"domain": "Energy sector domain (e.g. Electricity, Gas, Renewables, ESCO)", "currentState": "Current regulatory status with key law/policy name", "transition": "What is changing and by when", "futureState": "Expected regulatory environment post-transition"}
  ],
  "keyIncentives": [
    {"initiative": "Named incentive program or policy initiative", "keyContent": "30-50 words describing the initiative scope and requirements", "highlights": "Key numbers: tax rates, durations, caps, eligibility thresholds", "implications": "What this means for foreign market entrants specifically"}
  ],
  "sources": [{"url": "https://example.com/source", "title": "Source Name"}]
}

IMPORTANT: For the "sources" field, extract any URLs you find in the research data. These will be displayed as clickable hyperlinks in the presentation.

Return ONLY valid JSON.`;

  const antiArraySuffix =
    '\n\nCRITICAL: Return a JSON OBJECT with policy keys (foundationalActs, nationalPolicy, investmentRestrictions). DO NOT return a top-level JSON array.';

  let policyResult = null;
  const MAX_POLICY_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_POLICY_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`  [synthesizePolicy] Retry ${attempt}: enforcing object schema`);
    }

    const currentPrompt = attempt === 0 ? prompt : prompt + antiArraySuffix;
    let currentResult = await synthesizeWithFallback(currentPrompt, {
      maxTokens: 10240,
      label: 'synthesizePolicy',
      allowArrayNormalization: false,
      allowTruncationRepair: true,
      allowRawExtractionFallback: true,
      accept: (candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          return { pass: false, reason: 'response is not a JSON object' };
        }
        if (candidate._wasArray) {
          return { pass: false, reason: 'top-level array payload is not acceptable for policy' };
        }
        if (hasTransientTopLevelKeys(candidate)) {
          return { pass: false, reason: 'top-level transient section keys detected' };
        }
        const disallowedTopLevel = findDisallowedTopLevelKeys(
          candidate,
          STRICT_POLICY_TOP_LEVEL_KEYS
        );
        if (disallowedTopLevel.length > 0) {
          return {
            pass: false,
            reason: `non-canonical top-level policy keys detected: ${disallowedTopLevel.join(', ')}`,
          };
        }
        const directShapeCount = [
          'foundationalActs',
          'nationalPolicy',
          'investmentRestrictions',
        ].filter(
          (key) =>
            candidate[key] && typeof candidate[key] === 'object' && !Array.isArray(candidate[key])
        ).length;
        if (directShapeCount === 0) {
          return { pass: false, reason: 'missing direct canonical policy section objects' };
        }
        const normalized = normalizePolicySynthesisResult(candidate);
        const hasShape =
          Boolean(normalized?.foundationalActs) ||
          Boolean(normalized?.nationalPolicy) ||
          Boolean(normalized?.investmentRestrictions);
        if (!hasShape) return { pass: false, reason: 'missing policy section structure' };
        if (hasSemanticArtifactPayload(normalized)) {
          return {
            pass: false,
            reason: 'placeholder/truncation artifact detected in policy payload',
          };
        }
        return { pass: true };
      },
    });

    if (!currentResult) {
      console.warn(`  [synthesizePolicy] Attempt ${attempt} returned null`);
      continue;
    }

    const wasArray = Boolean(currentResult && currentResult._wasArray);
    currentResult = normalizePolicySynthesisResult(currentResult);
    const candidate = validatePolicySynthesis(currentResult);
    const actsCount = Array.isArray(candidate?.foundationalActs?.acts)
      ? candidate.foundationalActs.acts.filter((a) => a?.name && a?.year).length
      : 0;
    const targetsCount = Array.isArray(candidate?.nationalPolicy?.targets)
      ? candidate.nationalPolicy.targets.filter((t) => t && (t.metric || t.target || t.deadline))
          .length
      : 0;
    const incentivesCount = Array.isArray(candidate?.investmentRestrictions?.incentives)
      ? candidate.investmentRestrictions.incentives.filter(
          (i) => i && (i.name || i.scheme || i.benefit || i.eligibility)
        ).length
      : 0;
    const evidenceSections = [actsCount > 0, targetsCount > 0, incentivesCount > 0].filter(
      Boolean
    ).length;

    if (wasArray) {
      console.warn(
        `  [synthesizePolicy] Attempt ${attempt} returned array (tagged _wasArray), retrying...`
      );
      if (attempt === MAX_POLICY_RETRIES) {
        console.error(
          '  [synthesizePolicy] Exhausted retries with array-shaped payload; rejecting synthesis result'
        );
      }
      continue;
    }

    // Accept only when policy content has evidence-backed structure, not just object shells.
    if (evidenceSections >= 3 || (evidenceSections >= 2 && actsCount >= 2)) {
      policyResult = candidate;
      if (attempt > 0) {
        console.log(
          `  [synthesizePolicy] Accepted strict payload on attempt ${attempt} (acts=${actsCount}, targets=${targetsCount}, incentives=${incentivesCount})`
        );
      }
      break;
    }

    console.warn(
      `  [synthesizePolicy] Attempt ${attempt}: insufficient policy evidence (acts=${actsCount}, targets=${targetsCount}, incentives=${incentivesCount}), retrying...`
    );
    if (attempt === MAX_POLICY_RETRIES) {
      console.error(
        '  [synthesizePolicy] All retries exhausted with insufficient policy evidence; rejecting synthesis result'
      );
    }
  }

  if (!policyResult) {
    console.error('  [synthesizePolicy] Synthesis completely failed — no data returned');
    return { _synthesisError: true, section: 'policy', message: 'All synthesis attempts failed' };
  }

  const validated = validatePolicySynthesis(policyResult);
  return validated;
}

/**
 * Synthesize MARKET section with depth requirements
 */
async function synthesizeMarket(researchData, country, industry, clientContext, storyPlan) {
  console.log(`  [Synthesis] Market section for ${country}...`);

  const filteredData = selectResearchTopicsByPrefix(researchData, 'market');

  const dataAvailable = Object.keys(filteredData).length > 0;
  console.log(
    `    [Market] Filtered research data: ${Object.keys(filteredData).length} topics (${dataAvailable ? Object.keys(filteredData).slice(0, 3).join(', ') : 'NONE'})`
  );

  // Extract dynamic sub-section names from research data keys
  // e.g. "market_0_market_size_&_growth" → "Market Size & Growth"
  const marketTopicNames = Object.keys(filteredData).map((k) => {
    const withoutPrefix = k.replace(/^market_\d+_/, '');
    return withoutPrefix
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/ & /g, ' & ');
  });
  const uniqueTopics = [...new Set(marketTopicNames)].slice(0, 6);
  console.log(`    [Market] Dynamic topics: ${uniqueTopics.join(', ')}`);

  // Canonical market contract only — prevents dynamic key drift (e.g. segmentAnalysis,
  // pricingAndTariffs, supplydemandDynamics) from causing repeated strict-gate retries.
  const sectionSchemas = [
    `  "marketSizeAndGrowth": {
    "slideTitle": "${country} - Market Size & Growth",
    "subtitle": "THESIS STATEMENT (100-180 chars): the key strategic takeaway for the client.",
    "overview": "2-3 sentence strategic overview focused on client implications.",
    "keyMetrics": [{"metric": "Named metric", "value": "Specific value from data", "context": "Why this matters"}],
    "chartData": null,
    "keyInsight": "What this means for client",
    "dataType": "time_series_multi_insight",
    "sources": [{"url": "https://example.com/source", "title": "Source Name"}]
  }`,
    `  "supplyAndDemandDynamics": {
    "slideTitle": "${country} - Supply & Demand Dynamics",
    "subtitle": "THESIS STATEMENT (100-180 chars): the key strategic takeaway for the client.",
    "overview": "2-3 sentence strategic overview focused on client implications.",
    "keyMetrics": [{"metric": "Named metric", "value": "Specific value from data", "context": "Why this matters"}],
    "chartData": null,
    "keyInsight": "What this means for client",
    "dataType": "time_series_multi_insight",
    "sources": [{"url": "https://example.com/source", "title": "Source Name"}]
  }`,
    `  "pricingAndTariffStructures": {
    "slideTitle": "${country} - Pricing & Tariff Structures",
    "subtitle": "THESIS STATEMENT (100-180 chars): the key strategic takeaway for the client.",
    "overview": "2-3 sentence strategic overview focused on client implications.",
    "keyMetrics": [{"metric": "Named metric", "value": "Specific value from data", "context": "Why this matters"}],
    "chartData": null,
    "keyInsight": "What this means for client",
    "dataType": "time_series_multi_insight",
    "sources": [{"url": "https://example.com/source", "title": "Source Name"}]
  }`,
  ];

  const labeledData = markDataQuality(filteredData, {
    maxTopics: 4,
    maxContentChars: CFG_SYNTHESIS_TOPIC_MAX_CHARS,
    maxCitations: 10,
  });
  const researchContext = dataAvailable
    ? `RESEARCH DATA (use this as primary source — items prefixed [ESTIMATED] or [UNVERIFIED] are uncertain, hedge accordingly):
${JSON.stringify(labeledData, null, 2)}`
    : `RESEARCH DATA: EMPTY due to API issues.`;

  const storyInstructions = getStoryInstructions(storyPlan, 'market');
  const prompt = `You are synthesizing market data research for ${country}'s ${industry} market.
Client context: ${clientContext}
${SYNTHESIS_STYLE_GUIDE}${storyInstructions}
${researchContext}
Market topics observed in research (for content coverage only, NOT as output keys): ${uniqueTopics.join(', ') || 'None'}

If research data is insufficient for a field, set the value to:
- For arrays: empty array []
- For strings: null
- For numbers: null
- For objects: null
NEVER output literal placeholders such as "Insufficient research data for this field".
DO NOT fabricate data. DO NOT estimate from training knowledge.

ANTI-PADDING RULE:
- Do NOT substitute general/macro economic data (GDP, population, inflation, general trade statistics) when industry-specific data is unavailable
- If you cannot find ${industry}-specific data for a field, use the null/empty value — do NOT fill it with country-level macro data
- Macro data is ONLY acceptable in contextual/background fields explicitly labeled as such

RULES:
- Only use data from the INPUT DATA above
- Use null for any missing fields
- Include source citations where available
- Insights should reference specific numbers from the data
- If specific yearly data is available in the research, provide chartData with series/categories format: {"series": [{"name": "Category", "values": [1, 2, 3]}], "categories": ["2020", "2021", "2022"]}. If not, set chartData to null. Do NOT fabricate time series from training knowledge.
- For "sources": extract any URLs from the research data that are relevant to this section. These become clickable hyperlinks in the presentation.

Return JSON:
{
${sectionSchemas.join(',\n')}
}

Return ONLY valid JSON.`;

  const antiArraySuffix =
    '\n\nCRITICAL: Your response MUST be a JSON OBJECT with canonical keys { "marketSizeAndGrowth": {...}, "supplyAndDemandDynamics": {...}, "pricingAndTariffStructures": {...} }. DO NOT return a top-level JSON array. DO NOT use section_0/section_1 keys.';

  const marketAccept = (candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { pass: false, reason: 'response is not a JSON object' };
    }
    if (candidate._wasArray) {
      return { pass: false, reason: 'top-level array payload is not acceptable for market' };
    }
    if (hasTransientTopLevelKeys(candidate)) {
      return { pass: false, reason: 'top-level transient section keys detected' };
    }
    // Normalize first, then enforce canonical contract.
    // This preserves strictness while allowing harmless key-shape drift
    // (e.g. supplydemandDynamics/pricingAndTariffs/segmentAnalysis).
    const normalized = validateMarketSynthesis(candidate);
    const canonicalCount = CANONICAL_MARKET_SECTION_KEYS.filter(
      (k) => normalized?.[k] && typeof normalized[k] === 'object' && !Array.isArray(normalized[k])
    ).length;
    if (canonicalCount < CANONICAL_MARKET_SECTION_KEYS.length) {
      const passthroughUnknown = findDisallowedTopLevelKeys(
        candidate,
        STRICT_MARKET_TOP_LEVEL_KEYS
      );
      return {
        pass: false,
        reason: `missing canonical market sections (${canonicalCount}/${CANONICAL_MARKET_SECTION_KEYS.length})${passthroughUnknown.length > 0 ? `; unknown keys seen: ${passthroughUnknown.join(', ')}` : ''}`,
      };
    }
    if (hasSemanticArtifactPayload(normalized)) {
      return {
        pass: false,
        reason: 'placeholder/truncation artifact detected in market payload',
      };
    }
    return { pass: true };
  };

  let marketResult = null;
  const MAX_MARKET_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_MARKET_RETRIES; attempt++) {
    let currentResult;

    if (attempt === 0) {
      // Normal synthesis (Flash)
      currentResult = await synthesizeWithFallback(prompt, {
        maxTokens: 12288,
        label: 'synthesizeMarket',
        allowArrayNormalization: false,
        allowTruncationRepair: true,
        allowRawExtractionFallback: true,
        allowProTiers: false,
        accept: marketAccept,
      });
    } else if (attempt === 1) {
      // Flash with anti-array prompt
      console.log(`  [synthesizeMarket] Retry ${attempt}: Flash with anti-array prompt`);
      currentResult = await synthesizeWithFallback(prompt + antiArraySuffix, {
        maxTokens: 12288,
        label: 'synthesizeMarket',
        allowArrayNormalization: false,
        allowTruncationRepair: true,
        allowRawExtractionFallback: true,
        allowProTiers: false,
        accept: marketAccept,
      });
    } else {
      // Retry 2: minimal strict prompt (flash-only to avoid pro-tier escalation churn)
      console.log(`  [synthesizeMarket] Retry ${attempt}: minimal strict prompt`);
      const minimalPrompt = `Return a JSON object (NOT array) with EXACT keys:
- "marketSizeAndGrowth"
- "supplyAndDemandDynamics"
- "pricingAndTariffStructures"

Each key maps to an object with:
slideTitle, subtitle, overview, keyMetrics, chartData, keyInsight, dataType, sources.

Data:
${JSON.stringify(labeledData, null, 2)}

${antiArraySuffix}`;
      currentResult = await synthesizeWithFallback(minimalPrompt, {
        maxTokens: 12288,
        label: 'synthesizeMarket',
        allowArrayNormalization: false,
        allowTruncationRepair: true,
        allowRawExtractionFallback: true,
        allowProTiers: false,
        accept: marketAccept,
        systemPrompt:
          'Return one valid JSON object only with exact canonical market keys. No markdown, no explanation.',
      });
    }

    if (!currentResult) {
      console.warn(`  [synthesizeMarket] Attempt ${attempt} returned null`);
      continue;
    }

    const wasArray =
      Array.isArray(currentResult) || Boolean(currentResult && currentResult._wasArray);
    const candidate = validateMarketSynthesis(currentResult);
    if (hasSemanticArtifactPayload(candidate)) {
      console.warn(
        `  [synthesizeMarket] Attempt ${attempt}: semantic artifact found after normalization, retrying...`
      );
      if (attempt === MAX_MARKET_RETRIES) {
        console.error(
          '  [synthesizeMarket] All retries exhausted with semantic artifacts in market payload'
        );
      }
      continue;
    }
    const sectionKeys = Object.keys(candidate || {}).filter(
      (k) => !k.startsWith('_') && typeof candidate[k] === 'object' && candidate[k] !== null
    );
    const quantifiedSections = sectionKeys.filter((k) => {
      const section = candidate?.[k] || {};
      const keyMetrics = Array.isArray(section.keyMetrics) ? section.keyMetrics : [];
      const hasChartSeries =
        Array.isArray(section.chartData?.series) && section.chartData.series.length > 0;
      const hasChartValues =
        Array.isArray(section.chartData?.values) && section.chartData.values.length >= 3;
      return (
        hasChartSeries ||
        hasChartValues ||
        keyMetrics.length > 0 ||
        hasNumericSignal(section.keyInsight) ||
        hasNumericSignal(section.subtitle) ||
        hasNumericSignal(section.overview)
      );
    }).length;

    if (wasArray) {
      console.warn(
        `  [synthesizeMarket] Attempt ${attempt} returned array (tagged _wasArray), retrying...`
      );
      if (attempt === MAX_MARKET_RETRIES) {
        console.error(
          '  [synthesizeMarket] Exhausted retries with array-shaped payload; rejecting synthesis result'
        );
      }
      continue;
    }

    // Accept only when market structure is substantial and multi-section quantification is present.
    const canonicalPresent = CANONICAL_MARKET_SECTION_KEYS.filter((k) => sectionKeys.includes(k));
    const canonicalQuantified = CANONICAL_MARKET_SECTION_KEYS.filter((k) => {
      const section = candidate?.[k] || {};
      const keyMetrics = Array.isArray(section.keyMetrics) ? section.keyMetrics : [];
      const hasChartSeries =
        Array.isArray(section.chartData?.series) && section.chartData.series.length > 0;
      const hasChartValues =
        Array.isArray(section.chartData?.values) && section.chartData.values.length >= 3;
      return (
        hasChartSeries ||
        hasChartValues ||
        keyMetrics.length > 0 ||
        hasNumericSignal(section.keyInsight) ||
        hasNumericSignal(section.subtitle) ||
        hasNumericSignal(section.overview)
      );
    }).length;

    if (
      canonicalPresent.length === CANONICAL_MARKET_SECTION_KEYS.length &&
      canonicalQuantified >= 2 &&
      quantifiedSections >= 2
    ) {
      marketResult = candidate;
      if (attempt > 0) {
        console.log(
          `  [synthesizeMarket] Accepted strict payload on attempt ${attempt} (${canonicalPresent.length}/${CANONICAL_MARKET_SECTION_KEYS.length} canonical, quantified=${quantifiedSections}, canonicalQuantified=${canonicalQuantified})`
        );
      }
      break;
    }

    console.warn(
      `  [synthesizeMarket] Attempt ${attempt}: insufficient canonical market structure (canonical=${canonicalPresent.length}/${CANONICAL_MARKET_SECTION_KEYS.length}, quantified=${quantifiedSections}, canonicalQuantified=${canonicalQuantified}), retrying...`
    );
    if (attempt === MAX_MARKET_RETRIES) {
      console.error(
        '  [synthesizeMarket] All retries exhausted with insufficient structured market sections; rejecting synthesis result'
      );
    }
  }

  if (!marketResult) {
    console.error(
      '  [synthesizeMarket] Synthesis completely failed — no data returned after retries'
    );
    return { _synthesisError: true, section: 'market', message: 'All synthesis attempts failed' };
  }
  const validated = validateMarketSynthesis(marketResult);
  return validated;
}

/**
 * Synthesize COMPETITORS section with depth requirements
 */
async function synthesizeCompetitors(researchData, country, industry, clientContext, storyPlan) {
  console.log(`  [Synthesis] Competitors section for ${country}...`);

  const filteredData = selectResearchTopicsByPrefix(researchData, 'competitors');

  const dataAvailable = Object.keys(filteredData).length > 0;
  console.log(
    `    [Competitors] Filtered research data: ${Object.keys(filteredData).length} topics (${dataAvailable ? Object.keys(filteredData).slice(0, 3).join(', ') : 'NONE'})`
  );

  const labeledData = markDataQuality(filteredData, {
    maxTopics: 3,
    maxContentChars: CFG_SYNTHESIS_TOPIC_MAX_CHARS,
    maxCitations: 10,
  });
  const researchContext = dataAvailable
    ? `RESEARCH DATA (use this as primary source — items prefixed [ESTIMATED] or [UNVERIFIED] are uncertain, hedge accordingly):
${JSON.stringify(labeledData, null, 2)}`
    : `RESEARCH DATA: EMPTY due to API issues.`;

  const storyInstructions = getStoryInstructions(storyPlan, 'competitors');
  const commonIntro = `You are synthesizing competitive intelligence for ${country}'s ${industry} market.
Client context: ${clientContext}
${SYNTHESIS_STYLE_GUIDE}${storyInstructions}
${researchContext}

If research data is insufficient for a field, set the value to:
- For arrays: empty array []
- For strings: null
- For numbers: null
- For objects: null
NEVER output literal placeholders such as "Insufficient research data for this field".
DO NOT fabricate data. DO NOT estimate from training knowledge.

ANTI-PADDING RULE:
- Do NOT substitute general/macro economic data (GDP, population, inflation, general trade statistics) when industry-specific data is unavailable
- If you cannot find ${industry}-specific data for a field, use the null/empty value — do NOT fill it with country-level macro data
- Example: If asked for "${industry} market size" and you only know "country GDP is $500B" — return null, not the GDP figure
- Macro data is ONLY acceptable in contextual/background fields explicitly labeled as such

RULES:
- Only use data from the INPUT DATA above
- Use null for any missing fields
- Include source citations where available
- Company descriptions should be 45-60 words
- Insights should reference specific numbers from the data
- Include a "sources" array with relevant URLs from the research data for each section: [{"url": "https://...", "title": "Source Name"}]

CRITICAL WORD COUNT RULE — DESCRIPTIONS WILL BE REJECTED IF WRONG:
Each "description" field MUST contain exactly 45-60 words. Count them.

EXAMPLE (52 words): "Baker Hughes entered Vietnam in 2015 through a JV with PTSC, generating $45M annual revenue by 2023. Operating 3 service bases in Vung Tau and Hanoi, the company holds 12% market share in drilling services. Growth of 8% CAGR driven by offshore deepwater contracts with PVEP and Murphy Oil exploration programs."

A description of 20-30 words WILL BE REJECTED. Include: revenue figures, entry year, market share, key projects, growth rate.

Return ONLY valid JSON.`;

  const prompt1 = `${commonIntro}

Return JSON with ONLY the japanesePlayers section.
IMPORTANT: Return AT LEAST 3-5 Japanese companies. Search thoroughly — include subsidiaries, JV partners, trading companies (sogo shosha), and any Japanese firm with energy/industrial operations in ${country}.

{
  "japanesePlayers": {
    "slideTitle": "${country} - Japanese ${industry} Companies",
    "subtitle": "Key insight",
    "players": [
      {
        "name": "Company Name", "website": "https://...",
        "profile": { "overview": "2-3 sentence company overview", "revenueGlobal": "$X billion global", "revenueLocal": "$X million in ${country}", "employees": "X employees", "entryYear": "YYYY", "entryMode": "JV/Direct/M&A" },
        "projects": [{ "name": "Project name", "value": "$X million", "year": "YYYY", "status": "Active/Completed/Planned", "details": "Brief description" }],
        "financialHighlights": { "investmentToDate": "$X million", "profitMargin": "X%", "growthRate": "X% CAGR" },
        "strategicAssessment": "2-3 sentences on competitive position, strengths, weaknesses, and outlook",
        "description": "45-60 words with specific metrics, entry strategy, project details, market position"
      }
    ],
    "marketInsight": "Overall assessment of Japanese presence",
    "dataType": "company_comparison"
  }
}`;

  const prompt2 = `${commonIntro}

Return JSON with ONLY the localMajor section.
IMPORTANT: Return AT LEAST 5 local/domestic companies. Include state-owned enterprises, large conglomerates, and private players active in ${industry} in ${country}.

{
  "localMajor": {
    "slideTitle": "${country} - Major Local Players",
    "subtitle": "Key insight",
    "players": [
      {
        "name": "Company", "website": "https://...", "type": "State-owned/Private",
        "profile": { "overview": "2-3 sentence company overview", "revenueGlobal": "$X billion", "revenueLocal": "$X million", "employees": "X employees", "entryYear": "YYYY", "entryMode": "Organic/M&A" },
        "projects": [{ "name": "Project name", "value": "$X million", "year": "YYYY", "status": "Active/Completed", "details": "Brief description" }],
        "financialHighlights": { "investmentToDate": "$X million", "profitMargin": "X%", "growthRate": "X% CAGR" },
        "strategicAssessment": "2-3 sentences on market position, government relationships, expansion plans",
        "revenue": "$X million", "marketShare": "X%",
        "strengths": "Specific", "weaknesses": "Specific",
        "description": "45-60 words with specific metrics"
      }
    ],
    "concentration": "Market concentration with evidence",
    "dataType": "company_comparison"
  }
}`;

  const prompt3 = `${commonIntro}

Return JSON with ONLY the foreignPlayers section.
IMPORTANT: Return AT LEAST 3-5 foreign (non-Japanese, non-local) companies. Include multinationals, regional players, and any foreign firm with ${industry} operations in ${country}.

{
  "foreignPlayers": {
    "slideTitle": "${country} - Foreign ${industry} Companies",
    "subtitle": "Key insight",
    "players": [
      {
        "name": "Company", "website": "https://...", "origin": "Country",
        "profile": { "overview": "2-3 sentence company overview", "revenueGlobal": "$X billion", "revenueLocal": "$X million in ${country}", "employees": "X employees", "entryYear": "YYYY", "entryMode": "JV/Direct/M&A" },
        "projects": [{ "name": "Project name", "value": "$X million", "year": "YYYY", "status": "Active/Completed", "details": "Brief description" }],
        "financialHighlights": { "investmentToDate": "$X million", "profitMargin": "X%", "growthRate": "X% CAGR" },
        "strategicAssessment": "2-3 sentences on competitive position and market outlook",
        "entryYear": "YYYY", "mode": "JV/Direct",
        "success": "High/Medium/Low",
        "description": "45-60 words with specific metrics"
      }
    ],
    "competitiveInsight": "How foreign players compete",
    "dataType": "company_comparison"
  }
}`;

  const prompt4 = `${commonIntro}

Return JSON with ONLY the caseStudy and maActivity sections:
{
  "caseStudy": {
    "slideTitle": "${country} - Market Entry Case Study",
    "subtitle": "Lessons from the best example",
    "company": "Named company",
    "entryYear": "YYYY", "entryMode": "Specific mode",
    "investment": "$X million", "outcome": "Specific results with numbers",
    "keyLessons": ["Specific lesson 1", "Lesson 2", "Lesson 3"],
    "applicability": "How this applies to client specifically",
    "dataType": "case_study"
  },
  "maActivity": {
    "slideTitle": "${country} - M&A Activity",
    "subtitle": "Key insight",
    "recentDeals": [{"year": "YYYY", "buyer": "Name", "target": "Name", "value": "$X million", "rationale": "Why"}],
    "potentialTargets": [{"name": "Name", "website": "https://...", "estimatedValue": "$X million", "rationale": "Why attractive", "timing": "Availability"}],
    "valuationMultiples": "Typical multiples with evidence",
    "dataType": "regulation_list"
  }
  }`;

  function coerceCompetitorChunk(raw, expectedKeys = []) {
    let r = raw;
    if (!r) return null;
    if (Array.isArray(r)) {
      r = r.length === 1 ? r[0] : Object.assign({}, ...r.filter((x) => x && typeof x === 'object'));
    }
    if (!r || typeof r !== 'object') return null;

    const out = { ...r };
    if (out._wasArray) delete out._wasArray;
    const normalized = {};

    const candidates = [out];
    for (const [k, v] of Object.entries(out)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      if (/^section_\d+$/.test(k) || /^\d+$/.test(k)) {
        candidates.push(v);
      }
    }

    for (const expected of expectedKeys) {
      for (const candidate of candidates) {
        const value = candidate?.[expected];
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        normalized[expected] = value;
        break;
      }
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  function buildCompetitorAccept(expectedKeys, sectionLabel) {
    return (candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return { pass: false, reason: `${sectionLabel}: response is not a JSON object` };
      }

      const normalized = coerceCompetitorChunk(candidate, expectedKeys);
      if (!normalized || typeof normalized !== 'object') {
        return { pass: false, reason: `${sectionLabel}: unable to normalize competitor payload` };
      }

      const sectionCount = expectedKeys.filter(
        (key) =>
          normalized[key] && typeof normalized[key] === 'object' && !Array.isArray(normalized[key])
      ).length;
      if (sectionCount === 0) {
        return {
          pass: false,
          reason: `${sectionLabel}: expected competitor sections missing after normalization`,
        };
      }

      if (hasSemanticArtifactPayload(normalized)) {
        return {
          pass: false,
          reason: `${sectionLabel}: placeholder/truncation artifact detected`,
        };
      }

      const presentKeys = expectedKeys.filter(
        (key) =>
          normalized[key] && typeof normalized[key] === 'object' && !Array.isArray(normalized[key])
      );
      if (presentKeys.length === 0) {
        return {
          pass: false,
          reason: `${sectionLabel}: normalized payload has no expected sections`,
        };
      }

      for (const key of presentKeys) {
        const section = normalized[key];
        if (!section || typeof section !== 'object' || Array.isArray(section)) {
          return { pass: false, reason: `${sectionLabel}:${key} must be an object` };
        }

        if (['japanesePlayers', 'localMajor', 'foreignPlayers'].includes(key)) {
          const players = Array.isArray(section.players) ? section.players : [];
          if (players.length === 0) {
            return { pass: false, reason: `${sectionLabel}:${key} has no players` };
          }

          const viablePlayers = players
            .map((player) => sanitizePlaceholderStrings(player))
            .filter((player) => isViableCompetitorPlayer(player)).length;
          if (viablePlayers === 0) {
            return { pass: false, reason: `${sectionLabel}:${key} has no viable players` };
          }

          const title = ensureString(section.slideTitle).trim();
          if (!title) {
            return { pass: false, reason: `${sectionLabel}:${key} missing slideTitle` };
          }

          const insight = ensureString(
            section.subtitle ||
              section.marketInsight ||
              section.concentration ||
              section.competitiveInsight ||
              ''
          ).trim();
          if (!insight) {
            return { pass: false, reason: `${sectionLabel}:${key} missing section insight` };
          }
        }

        if (key === 'caseStudy') {
          const hasCaseAnchor = Boolean(
            ensureString(section.company).trim() ||
            ensureString(section.entryMode).trim() ||
            ensureString(section.outcome).trim() ||
            (Array.isArray(section.keyLessons) && section.keyLessons.length > 0)
          );
          if (!hasCaseAnchor) {
            return { pass: false, reason: `${sectionLabel}:${key} missing case-study anchors` };
          }
        }

        if (key === 'maActivity') {
          const deals = Array.isArray(section.recentDeals) ? section.recentDeals : [];
          const targets = Array.isArray(section.potentialTargets) ? section.potentialTargets : [];
          if (deals.length === 0 && targets.length === 0) {
            return {
              pass: false,
              reason: `${sectionLabel}:${key} missing deals/targets`,
            };
          }
        }
      }

      return { pass: true };
    };
  }

  console.log('    [Competitors] Running 4 synthesis calls (throttled to reduce quota spikes)...');
  const competitorJobs = [
    {
      prompt: prompt1,
      options: {
        maxTokens: 6144,
        label: 'synthesizeCompetitors:japanesePlayers',
        allowArrayNormalization: false,
        allowTruncationRepair: true,
        allowRawExtractionFallback: true,
        accept: buildCompetitorAccept(['japanesePlayers'], 'japanesePlayers'),
      },
    },
    {
      prompt: prompt2,
      options: {
        maxTokens: 6144,
        label: 'synthesizeCompetitors:localMajor',
        allowArrayNormalization: false,
        allowTruncationRepair: true,
        allowRawExtractionFallback: true,
        accept: buildCompetitorAccept(['localMajor'], 'localMajor'),
      },
    },
    {
      prompt: prompt3,
      options: {
        maxTokens: 6144,
        label: 'synthesizeCompetitors:foreignPlayers',
        allowArrayNormalization: false,
        allowTruncationRepair: true,
        allowRawExtractionFallback: true,
        accept: buildCompetitorAccept(['foreignPlayers'], 'foreignPlayers'),
      },
    },
    {
      prompt: prompt4,
      options: {
        maxTokens: 6144,
        label: 'synthesizeCompetitors:caseStudy',
        allowArrayNormalization: false,
        allowTruncationRepair: true,
        allowRawExtractionFallback: true,
        accept: buildCompetitorAccept(['caseStudy', 'maActivity'], 'caseStudy/maActivity'),
      },
    },
  ];
  const competitorRawResults = [];
  for (const [index, job] of competitorJobs.entries()) {
    // Intentional throttle: competitor synthesis prompts are token-heavy and were hitting
    // provider per-minute quotas when fired fully in parallel.
    const jobResult = await synthesizeWithFallback(job.prompt, job.options);
    competitorRawResults.push(jobResult);
    if (index < competitorJobs.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, CFG_COMPETITOR_SYNTHESIS_DELAY_MS));
    }
  }
  const [r1, r2, r3, r4] = competitorRawResults;

  const merged = {};
  const chunks = [
    { raw: r1, expectedKeys: ['japanesePlayers'] },
    { raw: r2, expectedKeys: ['localMajor'] },
    { raw: r3, expectedKeys: ['foreignPlayers'] },
    { raw: r4, expectedKeys: ['caseStudy', 'maActivity'] },
  ];
  for (const chunk of chunks) {
    const r = coerceCompetitorChunk(chunk.raw, chunk.expectedKeys);
    if (!r) continue;

    Object.assign(merged, r);
  }

  const allowedCompetitorKeys = new Set([
    'japanesePlayers',
    'localMajor',
    'foreignPlayers',
    'caseStudy',
    'maActivity',
  ]);
  const canonicalMerged = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!allowedCompetitorKeys.has(key)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    canonicalMerged[key] = value;
  }

  if (Object.keys(canonicalMerged).length === 0) {
    console.error('  [synthesizeCompetitors] All synthesis calls failed');
    return {
      _synthesisError: true,
      section: 'competitors',
      message: 'All synthesis attempts failed',
    };
  }

  console.log(
    `    [Competitors] Merged ${Object.keys(canonicalMerged).length} sections: ${Object.keys(canonicalMerged).join(', ')}`
  );
  const validated = validateCompetitorsSynthesis(canonicalMerged);
  return validated;
}

/**
 * Compress synthesis output for inclusion in summary prompt.
 * Keeps key findings while staying under maxChars.
 */
function summarizeForSummary(synthesis, section, maxChars) {
  if (!synthesis) return `[${section}: no data available]`;
  if (synthesis._synthesisError) return `[${section}: synthesis failed — ${synthesis.message}]`;
  const json = JSON.stringify(synthesis);
  if (json.length <= maxChars) return json;
  const brief = {};
  for (const key of Object.keys(synthesis)) {
    const val = synthesis[key];
    if (typeof val === 'string') brief[key] = val.slice(0, 200);
    else if (Array.isArray(val)) brief[key] = val.slice(0, 3);
    else if (typeof val === 'object' && val) {
      brief[key] = {};
      for (const [k, v] of Object.entries(val).slice(0, 5)) {
        brief[key][k] = typeof v === 'string' ? v.slice(0, 150) : v;
      }
    } else brief[key] = val;
  }
  const sliced = JSON.stringify(brief).slice(0, maxChars);
  // Repair truncated JSON from slicing
  try {
    JSON.parse(sliced);
    return sliced;
  } catch (_e) {
    return repairTruncatedJson(sliced);
  }
}

function limitWords(text, maxWords) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const words = cleaned.split(' ');
  if (!Number.isFinite(maxWords) || words.length <= maxWords) return cleaned;
  return words.slice(0, maxWords).join(' ') + '...';
}

function collectSummaryEvidence(policy, market, competitors, researchData) {
  const evidence = [];
  const seen = new Set();

  const pushEvidence = (text, source) => {
    const cleaned = ensureString(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length < 16) return;
    if (!hasNumericSignal(cleaned)) return;
    const key = cleaned.toLowerCase().slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({ text: limitWords(cleaned, 45), source });
  };

  const acts = policy?.foundationalActs?.acts || [];
  for (const act of acts) {
    pushEvidence(`${act.name || ''} (${act.year || ''}) ${act.requirements || ''}`, 'policy');
  }
  const policyTargets = policy?.nationalPolicy?.targets || [];
  for (const t of policyTargets) {
    pushEvidence(`${t.metric || ''}: ${t.target || ''} by ${t.deadline || ''}`, 'policy');
  }

  if (market && typeof market === 'object') {
    for (const section of Object.values(market)) {
      if (!section || typeof section !== 'object') continue;
      pushEvidence(section.subtitle || section.overview || section.keyInsight || '', 'market');
      const keyMetrics = Array.isArray(section.keyMetrics) ? section.keyMetrics : [];
      for (const metric of keyMetrics) {
        if (!metric || typeof metric !== 'object') continue;
        pushEvidence(
          `${metric.metric || metric.name || ''}: ${metric.value || ''} ${metric.context || ''}`,
          'market'
        );
      }
    }
  }

  const competitorPools = [
    competitors?.japanesePlayers?.players || [],
    competitors?.localMajor?.players || [],
    competitors?.foreignPlayers?.players || [],
  ];
  for (const pool of competitorPools) {
    for (const player of pool) {
      if (!player || typeof player !== 'object') continue;
      pushEvidence(
        `${player.name || 'Player'} revenue ${player.revenue || ''} market share ${player.marketShare || ''} entered ${player.entryYear || ''}`,
        'competitors'
      );
    }
  }

  for (const [k, v] of Object.entries(researchData || {})) {
    if (
      !k ||
      (!k.startsWith('depth_') && !k.startsWith('insight_') && !k.startsWith('opportunities_'))
    )
      continue;
    const snippet = (v?.content || '').slice(0, 320);
    pushEvidence(snippet, 'research');
  }

  return evidence;
}

function buildFallbackInsight(country, evidence, idx) {
  const titlePool = [
    'Regulatory timing defines entry window',
    'Quantified demand supports phased entry',
    'Competitive gaps favor focused positioning',
    'Execution sequence drives risk-adjusted returns',
  ];
  const sourceTag = evidence?.source ? `${evidence.source}` : 'cross-section synthesis';
  const dataLine =
    evidence?.text ||
    `0 fully validated quantitative datapoints are available in the current ${country} snapshot; run a 30-90 day fact-pack sprint before committing capital.`;
  return {
    title: titlePool[idx % titlePool.length],
    data: limitWords(dataLine, 55),
    pattern: `Evidence quality is uneven; prioritize claims that are consistently supported across policy, market, and competitor sections (${sourceTag}).`,
    implication:
      'Recommend prioritizing the highest-evidence segment first, then scaling through staged partnerships and repeatable delivery modules.',
    timing:
      'Use a 3-month validation window, then launch first pilot in months 4-9 after partner and compliance gates are complete.',
  };
}

function normalizeInsight(country, insight, fallback, idx) {
  const base = insight && typeof insight === 'object' ? { ...insight } : {};
  const next = {
    title: ensureString(base.title || ''),
    data: ensureString(base.data || ''),
    pattern: ensureString(base.pattern || ''),
    implication: ensureString(base.implication || ''),
    timing: ensureString(base.timing || ''),
  };
  if (!next.title) next.title = buildFallbackInsight(country, fallback, idx).title;
  if (!next.data || !hasNumericSignal(next.data))
    next.data = buildFallbackInsight(country, fallback, idx).data;
  if (!next.pattern) next.pattern = buildFallbackInsight(country, fallback, idx).pattern;
  if (
    !next.implication ||
    !/should|recommend|target|prioritize|position|initiate/i.test(next.implication)
  ) {
    next.implication = buildFallbackInsight(country, fallback, idx).implication;
  }
  if (!next.timing) next.timing = buildFallbackInsight(country, fallback, idx).timing;
  next.data = limitWords(next.data, 60);
  next.pattern = limitWords(next.pattern, 50);
  next.implication = limitWords(next.implication, 50);
  return next;
}

function ensureImplementationRoadmap(depth, country) {
  const out = depth && typeof depth === 'object' ? { ...depth } : {};
  const impl =
    out.implementation && typeof out.implementation === 'object' ? { ...out.implementation } : {};
  const phases = Array.isArray(impl.phases)
    ? impl.phases.filter((p) => p && typeof p === 'object')
    : [];
  const defaults = [
    {
      name: 'Phase 1: Setup (Months 0-6)',
      activities: [
        'Finalize target segment and compliance scope',
        'Shortlist local partners and legal advisors',
        'Confirm pilot account pipeline with quantified ROI criteria',
      ],
      milestones: ['Entry blueprint approved'],
      investment: 'TBD',
    },
    {
      name: 'Phase 2: Launch (Months 6-12)',
      activities: [
        'Execute pilot contracts with measurable KPI baselines',
        'Stand up local operating governance and reporting cadence',
        'Deploy partner enablement and commercial playbook',
      ],
      milestones: ['First reference projects delivered'],
      investment: 'TBD',
    },
    {
      name: 'Phase 3: Scale (Months 12-24)',
      activities: [
        'Scale delivery across priority sectors and geographies',
        'Expand partner ecosystem and adjacent service bundles',
        'Institutionalize margin and risk controls at portfolio level',
      ],
      milestones: ['Repeatable growth engine established'],
      investment: 'TBD',
    },
  ];

  const merged = phases.slice(0, 3).map((p, i) => ({
    ...defaults[i],
    ...p,
    activities:
      Array.isArray(p.activities) && p.activities.length > 0
        ? p.activities.slice(0, 5)
        : defaults[i].activities,
    milestones:
      Array.isArray(p.milestones) && p.milestones.length > 0
        ? p.milestones.slice(0, 4)
        : defaults[i].milestones,
  }));
  while (merged.length < 3) merged.push(defaults[merged.length]);

  impl.slideTitle = ensureString(impl.slideTitle || `${country} - Implementation Roadmap`);
  impl.subtitle = ensureString(impl.subtitle || 'Phased execution with measurable milestones');
  impl.phases = merged;
  if (!impl.totalInvestment) impl.totalInvestment = 'TBD (stage-gated)';
  if (!impl.breakeven) impl.breakeven = 'To be validated after pilot economics';
  out.implementation = impl;
  return out;
}

function ensurePartnerDescription(rawDescription, name, partnerType) {
  let description = ensureString(rawDescription || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (countWords(description) < 30) {
    description = `${name} is a ${partnerType.toLowerCase()} candidate with relevant execution capability, local stakeholder access, and practical delivery experience in energy services contracts. It is best suited for staged market entry where compliance quality, partner governance, and repeatable project performance matter more than speed-only expansion.`;
  }
  let words = description.split(/\s+/).filter(Boolean);
  if (words.length < 30) {
    description +=
      ' The partnership case is strongest when tied to measurable KPIs, transparent contract terms, and clear escalation paths for permitting, procurement, and operating risks.';
    words = description.split(/\s+/).filter(Boolean);
  }
  if (words.length > 60) {
    description =
      words
        .slice(0, 60)
        .join(' ')
        .replace(/[,:;]+$/, '') + '.';
  }
  return description;
}

function ensurePartnerAssessment(depth, country, competitors) {
  const out = depth && typeof depth === 'object' ? { ...depth } : {};
  const partnerAssessment =
    out.partnerAssessment && typeof out.partnerAssessment === 'object'
      ? { ...out.partnerAssessment }
      : {};

  const existingPartners = Array.isArray(partnerAssessment.partners)
    ? partnerAssessment.partners.filter((p) => p && typeof p === 'object')
    : [];

  const sourcePools = [
    {
      type: 'Japanese strategic partner',
      partnershipFit: 4,
      acquisitionFit: 2,
      players: competitors?.japanesePlayers?.players || [],
    },
    {
      type: 'Local incumbent',
      partnershipFit: 5,
      acquisitionFit: 4,
      players: competitors?.localMajor?.players || [],
    },
    {
      type: 'Foreign specialist',
      partnershipFit: 3,
      acquisitionFit: 3,
      players: competitors?.foreignPlayers?.players || [],
    },
  ];

  const candidatePartners = [];
  for (const pool of sourcePools) {
    for (const player of pool.players) {
      if (!player || typeof player !== 'object') continue;
      const name = ensureString(player.name || '').trim();
      if (!name) continue;
      const website = ensureString(player.website || '').trim();
      const revenue =
        ensureString(player.revenue || '').trim() ||
        ensureString(player.profile?.revenueLocal || '').trim() ||
        ensureString(player.profile?.revenueGlobal || '').trim() ||
        null;
      const estimatedValuation =
        ensureString(player.estimatedValuation || '').trim() ||
        ensureString(player.financialHighlights?.investmentToDate || '').trim() ||
        null;
      const description = ensurePartnerDescription(player.description, name, pool.type);
      candidatePartners.push({
        name,
        website:
          website || `https://www.google.com/search?q=${encodeURIComponent(name)}+official+website`,
        type: pool.type,
        revenue,
        partnershipFit: pool.partnershipFit,
        acquisitionFit: pool.acquisitionFit,
        estimatedValuation,
        description,
      });
    }
  }

  const seen = new Set();
  const mergedPartners = [];
  for (const rawPartner of [...existingPartners, ...candidatePartners]) {
    if (!rawPartner || typeof rawPartner !== 'object') continue;
    const name = ensureString(rawPartner.name || '').trim();
    if (!name) continue;
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const type = ensureString(rawPartner.type || 'Strategic partner').trim();
    const description = ensurePartnerDescription(rawPartner.description, name, type);
    mergedPartners.push({
      name,
      website:
        ensureString(rawPartner.website || '').trim() ||
        `https://www.google.com/search?q=${encodeURIComponent(name)}+official+website`,
      type,
      revenue: ensureString(rawPartner.revenue || '').trim() || null,
      partnershipFit: Number.isFinite(Number(rawPartner.partnershipFit))
        ? Math.max(1, Math.min(5, Number(rawPartner.partnershipFit)))
        : 3,
      acquisitionFit: Number.isFinite(Number(rawPartner.acquisitionFit))
        ? Math.max(1, Math.min(5, Number(rawPartner.acquisitionFit)))
        : 3,
      estimatedValuation: ensureString(rawPartner.estimatedValuation || '').trim() || null,
      description,
    });
  }

  partnerAssessment.slideTitle = ensureString(
    partnerAssessment.slideTitle || `${country} - Partner Assessment`
  );
  partnerAssessment.subtitle = ensureString(
    partnerAssessment.subtitle || 'Partnering with execution-ready incumbents de-risks entry'
  );
  partnerAssessment.partners = mergedPartners.slice(0, 5);
  if (!partnerAssessment.recommendedPartner && partnerAssessment.partners.length > 0) {
    const recommended = [...partnerAssessment.partners].sort(
      (a, b) => (b.partnershipFit || 0) - (a.partnershipFit || 0)
    )[0];
    partnerAssessment.recommendedPartner = `${recommended.name} — highest partnership-fit for staged entry and local execution`;
  } else if (!partnerAssessment.recommendedPartner) {
    partnerAssessment.recommendedPartner = null;
  }

  out.partnerAssessment = partnerAssessment;
  return out;
}

function ensureDepthStrategyAndSegments(depth, country) {
  const out = depth && typeof depth === 'object' ? { ...depth } : {};

  const entryStrategy =
    out.entryStrategy && typeof out.entryStrategy === 'object' ? { ...out.entryStrategy } : {};
  const defaultOptions = [
    {
      mode: 'Joint Venture',
      timeline: '6-12 months',
      investment: 'Stage-gated pilot budget',
      controlLevel: 'Shared control',
      pros: ['Fast market access via local relationships', 'Lower upfront capex risk'],
      cons: ['Shared decision rights can slow execution', 'Requires partner governance discipline'],
      riskLevel: 'Medium',
    },
    {
      mode: 'Acquisition',
      timeline: '9-18 months',
      investment: 'Valuation-led, target dependent',
      controlLevel: 'High control',
      pros: [
        'Immediate installed base and operating team',
        'Direct access to contracts and permits',
      ],
      cons: ['Integration risk and legacy liabilities', 'Higher one-time capital requirement'],
      riskLevel: 'Medium',
    },
    {
      mode: 'Greenfield',
      timeline: '12-24 months',
      investment: 'Full build-out capex',
      controlLevel: 'Full control',
      pros: [
        'Maximum process control and brand consistency',
        'Can optimize org design from day one',
      ],
      cons: ['Slowest time-to-revenue', 'Highest execution and permitting exposure'],
      riskLevel: 'High',
    },
  ];
  const existingOptions = Array.isArray(entryStrategy.options)
    ? entryStrategy.options.filter((o) => o && typeof o === 'object')
    : [];
  const seenModes = new Set();
  const mergedOptions = [];
  for (const option of [...existingOptions, ...defaultOptions]) {
    const mode = ensureString(option?.mode || '').trim();
    const dedupeKey = mode.toLowerCase();
    if (!dedupeKey || seenModes.has(dedupeKey)) continue;
    seenModes.add(dedupeKey);
    mergedOptions.push(option);
    if (mergedOptions.length >= 3) break;
  }
  while (mergedOptions.length < 2) mergedOptions.push(defaultOptions[mergedOptions.length]);
  entryStrategy.slideTitle = ensureString(
    entryStrategy.slideTitle || `${country} - Entry Strategy Options`
  );
  entryStrategy.subtitle = ensureString(
    entryStrategy.subtitle || 'Choose control level by phase, not all at once'
  );
  entryStrategy.options = mergedOptions;
  if (!entryStrategy.recommendation) {
    const preferred = ensureString(entryStrategy.options?.[0]?.mode || 'Joint Venture');
    entryStrategy.recommendation = `${preferred} first, then escalate control after pilot performance and compliance proof points.`;
  }
  const defaultHarveyBalls = {
    criteria: ['Speed', 'Investment', 'Risk', 'Control', 'Local Knowledge'],
    jv: [4, 4, 3, 2, 5],
    acquisition: [3, 2, 3, 5, 4],
    greenfield: [1, 3, 4, 5, 1],
  };
  if (!entryStrategy.harveyBalls || typeof entryStrategy.harveyBalls !== 'object') {
    entryStrategy.harveyBalls = defaultHarveyBalls;
  } else {
    const hb = { ...entryStrategy.harveyBalls };
    hb.criteria =
      Array.isArray(hb.criteria) && hb.criteria.length >= 3
        ? hb.criteria
        : defaultHarveyBalls.criteria;
    hb.jv = Array.isArray(hb.jv) && hb.jv.length >= 3 ? hb.jv : defaultHarveyBalls.jv;
    hb.acquisition =
      Array.isArray(hb.acquisition) && hb.acquisition.length >= 3
        ? hb.acquisition
        : defaultHarveyBalls.acquisition;
    hb.greenfield =
      Array.isArray(hb.greenfield) && hb.greenfield.length >= 3
        ? hb.greenfield
        : defaultHarveyBalls.greenfield;
    entryStrategy.harveyBalls = hb;
  }
  out.entryStrategy = entryStrategy;

  const targetSegments =
    out.targetSegments && typeof out.targetSegments === 'object' ? { ...out.targetSegments } : {};
  const existingSegments = Array.isArray(targetSegments.segments)
    ? targetSegments.segments.filter((s) => s && typeof s === 'object')
    : [];
  const defaultSegments = [
    {
      name: 'Power and gas operators',
      size: 'To be validated',
      marketIntensity: 'High',
      decisionMaker: 'Operations and asset leadership',
      priority: 5,
    },
    {
      name: 'Industrial energy-intensive users',
      size: 'To be validated',
      marketIntensity: 'Medium',
      decisionMaker: 'CFO / COO',
      priority: 4,
    },
    {
      name: 'Grid and infrastructure service buyers',
      size: 'To be validated',
      marketIntensity: 'Medium',
      decisionMaker: 'Engineering and procurement teams',
      priority: 3,
    },
  ];
  const mergedSegments = [];
  const seenSegments = new Set();
  for (const segment of [...existingSegments, ...defaultSegments]) {
    const name = ensureString(segment?.name || '').trim();
    const dedupeKey = name.toLowerCase();
    if (!dedupeKey || seenSegments.has(dedupeKey)) continue;
    seenSegments.add(dedupeKey);
    mergedSegments.push(segment);
    if (mergedSegments.length >= 4) break;
  }
  if (mergedSegments.length === 0) mergedSegments.push(defaultSegments[0]);
  targetSegments.slideTitle = ensureString(
    targetSegments.slideTitle || `${country} - Target Customer Segments`
  );
  targetSegments.subtitle = ensureString(
    targetSegments.subtitle || 'Prioritize buyers with immediate compliance and cost pressure'
  );
  targetSegments.segments = mergedSegments;
  if (!Array.isArray(targetSegments.topTargets)) {
    const partners = Array.isArray(out.partnerAssessment?.partners)
      ? out.partnerAssessment.partners
      : [];
    targetSegments.topTargets = partners.slice(0, 3).map((partner) => ({
      company: ensureString(partner?.name || ''),
      website:
        ensureString(partner?.website || '').trim() ||
        `https://www.google.com/search?q=${encodeURIComponent(ensureString(partner?.name || 'target company'))}+official+website`,
      industry: ensureString(partner?.type || 'Energy services'),
      annualSpend: null,
      location: null,
    }));
  }
  if (!targetSegments.goToMarketApproach) {
    targetSegments.goToMarketApproach =
      'Sequence by account readiness: prove value in 2-3 lighthouse accounts, then scale through partner-led replication in similar buyer clusters.';
  }
  out.targetSegments = targetSegments;

  return out;
}

function ensureSummaryCompleteness(summaryResult, context) {
  const { country, policy, market, competitors, researchData, existingDepth, existingSummary } =
    context;
  const result = summaryResult && typeof summaryResult === 'object' ? { ...summaryResult } : {};
  const canonicalDepth = mergeCanonicalSectionsPreferRich(
    existingDepth,
    result.depth,
    STRICT_DEPTH_TOP_LEVEL_KEYS
  );
  const canonicalSummary = mergeCanonicalSectionsPreferRich(
    existingSummary,
    result.summary,
    STRICT_SUMMARY_TOP_LEVEL_KEYS
  );
  result.depth = ensureImplementationRoadmap(canonicalDepth, country);
  result.depth = ensurePartnerAssessment(result.depth, country, competitors);
  result.depth = ensureDepthStrategyAndSegments(result.depth, country);
  const summary = canonicalSummary;
  const evidence = collectSummaryEvidence(policy, market, competitors, researchData);
  const existingInsights = Array.isArray(summary.keyInsights) ? summary.keyInsights : [];
  const normalizedInsights = existingInsights
    .map((insight, idx) => normalizeInsight(country, insight, evidence[idx] || evidence[0], idx))
    .filter((insight) => insight && insight.title && insight.data);

  let cursor = normalizedInsights.length;
  while (normalizedInsights.length < 3) {
    const ev = evidence[cursor % Math.max(evidence.length, 1)] || null;
    normalizedInsights.push(normalizeInsight(country, null, ev, cursor));
    cursor++;
    if (cursor > 8) break;
  }

  summary.keyInsights = normalizedInsights.slice(0, 5);
  result.summary = pickAllowedTopLevelKeys(
    mergeCanonicalSectionsPreferRich(existingSummary, summary, STRICT_SUMMARY_TOP_LEVEL_KEYS),
    STRICT_SUMMARY_TOP_LEVEL_KEYS
  );
  result.depth = pickAllowedTopLevelKeys(
    mergeCanonicalSectionsPreferRich(existingDepth, result.depth, STRICT_DEPTH_TOP_LEVEL_KEYS),
    STRICT_DEPTH_TOP_LEVEL_KEYS
  );
  return result;
}

function sanitizeCountryAnalysis(countryAnalysis, context = {}) {
  if (!countryAnalysis || typeof countryAnalysis !== 'object') return countryAnalysis;

  if (countryAnalysis.policy && typeof countryAnalysis.policy === 'object') {
    countryAnalysis.policy = normalizePolicySynthesisResult(countryAnalysis.policy);
    countryAnalysis.policy = validatePolicySynthesis(countryAnalysis.policy);
  }
  if (countryAnalysis.market && typeof countryAnalysis.market === 'object') {
    countryAnalysis.market = validateMarketSynthesis(countryAnalysis.market);
  }
  if (countryAnalysis.competitors && typeof countryAnalysis.competitors === 'object') {
    countryAnalysis.competitors = validateCompetitorsSynthesis(countryAnalysis.competitors);
  }

  const summaryPack = ensureSummaryCompleteness(
    {
      depth: countryAnalysis.depth || {},
      summary: countryAnalysis.summary || {},
    },
    {
      country: context.country || countryAnalysis.country || '',
      policy: countryAnalysis.policy || {},
      market: countryAnalysis.market || {},
      competitors: countryAnalysis.competitors || {},
      researchData: context.researchData || countryAnalysis.rawData || {},
      existingDepth: countryAnalysis.depth || {},
      existingSummary: countryAnalysis.summary || {},
    }
  );
  countryAnalysis.depth = summaryPack.depth || countryAnalysis.depth || {};
  countryAnalysis.summary = summaryPack.summary || countryAnalysis.summary || {};

  countryAnalysis.policy = sanitizePlaceholderStrings(countryAnalysis.policy);
  countryAnalysis.market = sanitizePlaceholderStrings(countryAnalysis.market);
  countryAnalysis.competitors = sanitizePlaceholderStrings(countryAnalysis.competitors);
  countryAnalysis.summary = sanitizePlaceholderStrings(countryAnalysis.summary);
  countryAnalysis.depth = sanitizePlaceholderStrings(countryAnalysis.depth);

  return countryAnalysis;
}

/**
 * Synthesize SUMMARY section with depth requirements
 */
async function synthesizeSummary(
  researchData,
  policy,
  market,
  competitors,
  country,
  industry,
  clientContext,
  options = {}
) {
  console.log(`  [Synthesis] Summary & recommendations for ${country}...`);
  const scopeGuard = getClientScopeGuard(industry, clientContext);

  const prompt = `You are creating the strategic summary and recommendations for ${country}'s ${industry} market.
Client context: ${clientContext}
${scopeGuard ? `\n${scopeGuard}\n` : ''}

SYNTHESIZED SECTIONS (already processed):
Policy: ${summarizeForSummary(policy, 'policy', 2500)}
Market: ${summarizeForSummary(market, 'market', 3000)}
Competitors: ${summarizeForSummary(competitors, 'competitors', 2500)}

Additional research context:
${Object.entries(researchData)
  .filter(
    ([k]) =>
      k.startsWith('opportunities_') ||
      k.startsWith('risks_') ||
      k.startsWith('depth_') ||
      k.startsWith('insight_')
  )
  .slice(0, 4)
  .map(([k, v]) => `${k}: ${(v?.content || '').substring(0, 900)}`)
  .join('\n')}

If research data is insufficient for a field, set the value to:
- For arrays: empty array []
- For strings: null
- For numbers: null
- For objects: null
NEVER output literal placeholders such as "Insufficient research data for this field".
DO NOT fabricate data. DO NOT estimate from training knowledge.

ANTI-PADDING RULE:
- Do NOT substitute general/macro economic data (GDP, population, inflation, general trade statistics) when industry-specific data is unavailable
- If you cannot find ${industry}-specific data for a field, use the null/empty value — do NOT fill it with country-level macro data
- Example: If asked for "${industry} market size" and you only know "country GDP is $500B" — return null, not the GDP figure
- Macro data is ONLY acceptable in contextual/background fields explicitly labeled as such

RULES:
- Only use data from the INPUT DATA above
- Use null for any missing fields
- Include source citations where available
- Company descriptions should be 45-60 words
- Insights must have structured fields: data (with specific numbers), pattern (causal mechanism), implication (action verb + timing)

IMPORTANT: Use EXACTLY the JSON keys specified below (dealEconomics, partnerAssessment, entryStrategy, implementation, targetSegments). Adapt the CONTENT to ${industry} but keep the KEY NAMES exactly as shown.

Return JSON:
{
  "depth": {
    "dealEconomics": {
      "slideTitle": "${country} - ${industry} Deal Economics",
      "subtitle": "Key insight",
      "typicalDealSize": {"min": "$XM", "max": "$YM", "average": "$ZM"},
      "contractTerms": {"duration": "X years", "revenueSplit": "Client X% / Provider Y%", "guaranteeStructure": "Type"},
      "financials": {"paybackPeriod": "X years", "irr": "X-Y%", "marginProfile": "X% gross margin"},
      "financingOptions": ["Named option 1", "Named option 2"],
      "keyInsight": "Investment thesis"
    },
    "partnerAssessment": {
      "slideTitle": "${country} - Partner Assessment",
      "subtitle": "Key insight",
      "partners": [
        {"name": "Company", "website": "https://...", "type": "Type", "revenue": "$XM", "partnershipFit": 4, "acquisitionFit": 3, "estimatedValuation": "$X-YM", "description": "45-60 words"}
      ],
      "recommendedPartner": "Top pick with reasoning"
    },
    "entryStrategy": {
      "slideTitle": "${country} - Entry Strategy Options",
      "subtitle": "Key insight",
      "options": [
        {"mode": "Joint Venture", "timeline": "X months", "investment": "$XM", "controlLevel": "X%", "pros": ["Pro 1"], "cons": ["Con 1"], "riskLevel": "Low/Medium/High"},
        {"mode": "Acquisition", "timeline": "X months", "investment": "$XM", "controlLevel": "Full", "pros": ["Pro 1"], "cons": ["Con 1"], "riskLevel": "Medium"},
        {"mode": "Greenfield", "timeline": "X months", "investment": "$XM", "controlLevel": "Full", "pros": ["Pro 1"], "cons": ["Con 1"], "riskLevel": "High"}
      ],
      "recommendation": "Recommended with specific reasoning",
      "harveyBalls": {"criteria": ["Speed", "Investment", "Risk", "Control", "Local Knowledge"], "jv": [3,4,3,2,5], "acquisition": [4,2,3,5,4], "greenfield": [1,3,4,5,1]}
    },
    "implementation": {
      "slideTitle": "${country} - Implementation Roadmap",
      "subtitle": "Phased approach",
      "phases": [
        {"name": "Phase 1: Setup (Months 0-6)", "activities": ["Activity 1","Activity 2","Activity 3"], "milestones": ["Milestone 1"], "investment": "$XM"},
        {"name": "Phase 2: Launch (Months 6-12)", "activities": ["Activity 1","Activity 2"], "milestones": ["Milestone 1"], "investment": "$XM"},
        {"name": "Phase 3: Scale (Months 12-24)", "activities": ["Activity 1","Activity 2"], "milestones": ["Milestone 1"], "investment": "$XM"}
      ],
      "totalInvestment": "$XM over 24 months",
      "breakeven": "Month X"
    },
    "targetSegments": {
      "slideTitle": "${country} - Target Customer Segments",
      "subtitle": "Key insight",
      "segments": [{"name": "Segment", "size": "X units", "marketIntensity": "High/Med/Low", "decisionMaker": "Title", "priority": 5}],
      "topTargets": [{"company": "Name", "website": "https://...", "industry": "Sector", "annualSpend": "$XM/yr", "location": "Region"}],
      "goToMarketApproach": "Specific approach"
    }
  },
  "summary": {
    "timingIntelligence": {
      "slideTitle": "${country} - Why Now?",
      "subtitle": "Time-sensitive factors",
      "triggers": [{"trigger": "Named trigger with date", "impact": "Specific impact", "action": "Specific action with deadline"}],
      "windowOfOpportunity": "Why 2025-2026 is optimal, specifically"
    },
    "lessonsLearned": {
      "slideTitle": "${country} - Lessons from Market",
      "subtitle": "What killed previous entrants",
      "failures": [{"company": "Named company", "year": "YYYY", "reason": "Specific reason", "lesson": "What to do differently"}],
      "successFactors": ["What successful entrants did right - specific"],
      "warningSignsToWatch": ["Named warning sign"]
    },
    "opportunities": [{"opportunity": "Named opportunity", "size": "$XM", "timing": "Why now", "action": "What to do"}],
    "obstacles": [{"obstacle": "Named barrier", "severity": "High/Med/Low", "mitigation": "How to address"}],
    "ratings": {"attractiveness": 7, "attractivenessRationale": "Multi-factor with evidence", "feasibility": 6, "feasibilityRationale": "Multi-factor with evidence"},
    "keyInsights": [{"title": "Non-obvious headline", "data": "Specific evidence", "pattern": "Causal mechanism", "implication": "Strategic response", "timing": "When to act"}],
    "recommendation": "Clear recommendation with first step",
    "goNoGo": {
      "criteria": [{"criterion": "Named criterion", "met": true, "evidence": "Specific evidence"}],
      "overallVerdict": "GO/NO-GO/CONDITIONAL GO",
      "conditions": ["Specific condition if conditional"]
    }
  }
}

Return ONLY valid JSON.`;

  const result = await synthesizeWithFallback(prompt, {
    maxTokens: 12288,
    label: 'synthesizeSummary',
    allowArrayNormalization: false,
    allowTruncationRepair: true,
    allowRawExtractionFallback: true,
    accept: (candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return { pass: false, reason: 'summary response is not a JSON object' };
      }
      if (candidate._wasArray) {
        return { pass: false, reason: 'summary payload originated from top-level array' };
      }
      if (hasSemanticArtifactPayload(candidate)) {
        return {
          pass: false,
          reason: 'placeholder/truncation artifact detected in summary/depth payload',
        };
      }

      const hasSummary =
        candidate.summary &&
        typeof candidate.summary === 'object' &&
        !Array.isArray(candidate.summary) &&
        Object.keys(candidate.summary).length > 0;
      const hasDepth =
        candidate.depth &&
        typeof candidate.depth === 'object' &&
        !Array.isArray(candidate.depth) &&
        Object.keys(candidate.depth).length > 0;

      if (!hasSummary && !hasDepth) {
        return { pass: false, reason: 'summary payload missing summary and depth sections' };
      }
      if (hasSummary && hasTransientTopLevelKeys(candidate.summary)) {
        return { pass: false, reason: 'summary contains transient top-level keys' };
      }
      if (hasDepth && hasTransientTopLevelKeys(candidate.depth)) {
        return { pass: false, reason: 'depth contains transient top-level keys' };
      }
      if (hasSummary) {
        const disallowedSummaryKeys = findDisallowedTopLevelKeys(
          candidate.summary,
          STRICT_SUMMARY_TOP_LEVEL_KEYS
        );
        if (disallowedSummaryKeys.length > 0) {
          return {
            pass: false,
            reason: `summary contains non-canonical keys: ${disallowedSummaryKeys.join(', ')}`,
          };
        }
      }
      if (hasDepth) {
        const disallowedDepthKeys = findDisallowedTopLevelKeys(
          candidate.depth,
          STRICT_DEPTH_TOP_LEVEL_KEYS
        );
        if (disallowedDepthKeys.length > 0) {
          return {
            pass: false,
            reason: `depth contains non-canonical keys: ${disallowedDepthKeys.join(', ')}`,
          };
        }
      }
      return { pass: true };
    },
  });
  if (!result) {
    console.error('  [synthesizeSummary] Synthesis completely failed — no data returned');
    return {
      depth: {},
      summary: { opportunities: [], obstacles: [], ratings: {}, keyInsights: [] },
      _synthesisError: true,
      section: 'summary',
      message: 'All synthesis attempts failed',
    };
  }
  return ensureSummaryCompleteness(result, {
    country,
    policy,
    market,
    competitors,
    researchData,
    existingDepth: options?.existingDepth || {},
    existingSummary: options?.existingSummary || {},
  });
}

/**
 * Validate content depth before allowing PPT generation
 * Returns { valid: boolean, failures: string[], scores: {} }
 */
const NUMERIC_SIGNAL_REGEX =
  /\$[\d,.]+[BMKbmk]?|\d+(\.\d+)?%|\d{4}|\d+(\.\d+)?x|\b\d{1,3}(?:,\d{3})+\b/;

function hasNumericSignal(value) {
  if (value == null) return false;
  return NUMERIC_SIGNAL_REGEX.test(String(value));
}

function validateContentDepth(synthesis) {
  const failures = [];
  const scores = { policy: 0, market: 0, competitors: 0, summary: 0, depth: 0, overall: 0 };

  // Policy check: ≥3 named regulations with years
  const policy = synthesis.policy || {};
  const acts = (policy.foundationalActs?.acts || []).filter((a) => a.name && a.year);
  const targets = policy.nationalPolicy?.targets || [];
  if (acts.length >= 3) scores.policy += 40;
  else if (acts.length >= 1) scores.policy += 20;
  else failures.push(`Policy: only ${acts.length} named regulations (need ≥3)`);
  if (targets.length >= 2) scores.policy += 30;
  if (policy.investmentRestrictions?.incentives?.length >= 1) scores.policy += 30;

  // Market check: score both chart rigor and quantitative evidence in key metrics.
  // Some high-quality market sections are table/metric driven (not only chart driven),
  // so we evaluate both to avoid false low scores.
  const market = synthesis.market || {};
  const marketSections = Object.keys(market).filter(
    (k) => !k.startsWith('_') && typeof market[k] === 'object' && market[k] !== null
  );
  let seriesCount = 0;
  let sectionsWithCharts = 0;
  let numericMetricsCount = 0;
  let sectionsWithQuantSignals = 0;
  for (const section of marketSections) {
    const sectionData = market[section] || {};
    const chartData = market[section]?.chartData;
    let sectionHasChart = false;
    let sectionHasNumbers = false;
    if (chartData) {
      if (chartData.series && Array.isArray(chartData.series)) {
        const validSeries = chartData.series.filter(
          (s) => Array.isArray(s.values) && s.values.length >= 3
        );
        seriesCount += validSeries.length;
        if (validSeries.length > 0) sectionHasChart = true;
      } else if (
        chartData.values &&
        Array.isArray(chartData.values) &&
        chartData.values.length >= 3
      ) {
        seriesCount++;
        sectionHasChart = true;
      }
    }
    if (sectionHasChart) sectionsWithCharts++;

    const keyMetrics = Array.isArray(sectionData.keyMetrics) ? sectionData.keyMetrics : [];
    for (const metric of keyMetrics) {
      if (!metric || typeof metric !== 'object') continue;
      if (
        hasNumericSignal(metric.value) ||
        hasNumericSignal(metric.metric) ||
        hasNumericSignal(metric.context)
      ) {
        numericMetricsCount++;
        sectionHasNumbers = true;
      }
    }

    if (
      hasNumericSignal(sectionData.overview) ||
      hasNumericSignal(sectionData.keyInsight) ||
      hasNumericSignal(sectionData.subtitle)
    ) {
      sectionHasNumbers = true;
    }
    if (sectionHasChart || sectionHasNumbers) sectionsWithQuantSignals++;
  }

  if (marketSections.length >= 3) scores.market += 20;
  else if (marketSections.length >= 2) scores.market += 10;
  else failures.push(`Market: only ${marketSections.length} section(s) synthesized (need ≥3)`);

  if (seriesCount >= 4) scores.market += 40;
  else if (seriesCount >= 2) scores.market += 30;
  else if (seriesCount >= 1) scores.market += 20;

  if (numericMetricsCount >= 8) scores.market += 30;
  else if (numericMetricsCount >= 5) scores.market += 25;
  else if (numericMetricsCount >= 3) scores.market += 15;
  else if (numericMetricsCount >= 1) scores.market += 8;

  if (sectionsWithQuantSignals >= 3) scores.market += 10;
  else if (sectionsWithQuantSignals >= 2) scores.market += 5;

  scores.market = Math.min(100, scores.market);
  if (scores.market < 60) {
    failures.push(
      `Market: low quantitative depth (score=${scores.market}, sections=${marketSections.length}, series=${seriesCount}, metricSignals=${numericMetricsCount})`
    );
  }

  // Competitors check: ≥3 companies with details.
  // User priority is content depth over strict overflow policing, so we enforce only minimum
  // descriptive depth and treat upper-bound overflow as a soft warning.
  const competitors = synthesis.competitors || {};
  let totalCompanies = 0;
  let thinDescriptions = 0;
  let longDescriptions = 0;
  const MIN_DESC_WORDS = 30;
  for (const section of ['japanesePlayers', 'localMajor', 'foreignPlayers']) {
    const players = competitors[section]?.players || [];
    totalCompanies += players.filter((p) => p.name && (p.revenue || p.description)).length;
    // Validate minimum descriptive depth; do not hard-fail longer content.
    for (const player of players) {
      if (player.description) {
        const wordCount = player.description.trim().split(/\s+/).length;
        if (wordCount < MIN_DESC_WORDS) thinDescriptions++;
        if (wordCount > 60) longDescriptions++;
      }
    }
  }
  if (totalCompanies >= 5) scores.competitors = 100;
  else if (totalCompanies >= 3) scores.competitors = 70;
  else if (totalCompanies >= 1) scores.competitors = 40;
  else failures.push(`Competitors: only ${totalCompanies} detailed companies (need ≥3)`);

  // Reject only when a clear majority are too thin.
  if (totalCompanies > 0 && thinDescriptions / totalCompanies > 0.6) {
    failures.push(
      `Competitors: ${thinDescriptions}/${totalCompanies} descriptions <${MIN_DESC_WORDS} words (need stronger depth)`
    );
    scores.competitors = Math.min(scores.competitors, 40); // Cap score if descriptions thin
  }
  if (totalCompanies > 0 && longDescriptions > 0) {
    console.log(
      `  [Validation] Competitors warning: ${longDescriptions}/${totalCompanies} descriptions >60 words (overflow tolerated, consider trimming)`
    );
  }

  // Strategic insights validation: check structured fields (data, implication, timing)
  const summary = synthesis.summary || {};
  const insights = summary.keyInsights || [];
  if (insights.length < 3) {
    failures.push(`Strategic: only ${insights.length} key insights (need ≥3)`);
  }
  let completeInsights = 0;
  for (const insight of insights) {
    // Check structured fields: data (contains number), implication (action verb), timing (exists)
    const hasData = insight.data && hasNumericSignal(insight.data);
    const hasAction =
      insight.implication &&
      /should|recommend|target|prioritize|position|initiate/i.test(insight.implication);
    const hasTiming =
      (insight.timing && insight.timing.length > 0) ||
      (insight.title && /(Q[1-4]|202\d|month|window|before|by)/i.test(insight.title));

    if (hasData && hasAction && hasTiming) {
      completeInsights++;
    }
  }

  // Require ≥60% of insights to have complete chains (data+implication+action+timing)
  if (insights.length >= 3 && completeInsights / insights.length < 0.6) {
    failures.push(
      `Strategic: only ${completeInsights}/${insights.length} insights complete (need ≥60% with data+action+timing)`
    );
  }
  if (insights.length >= 5) scores.summary += 40;
  else if (insights.length >= 3) scores.summary += 30;
  else if (insights.length >= 2) scores.summary += 15;
  const completeInsightRatio = insights.length > 0 ? completeInsights / insights.length : 0;
  if (completeInsightRatio >= 0.8) scores.summary += 40;
  else if (completeInsightRatio >= 0.6) scores.summary += 30;
  else if (completeInsightRatio >= 0.4) scores.summary += 15;
  const insightWithTiming = insights.filter(
    (insight) =>
      insight?.timing &&
      /(Q[1-4]|20\d{2}|month|week|window|before|by|after)/i.test(String(insight.timing))
  ).length;
  if (insightWithTiming >= 3) scores.summary += 20;
  else if (insightWithTiming >= 2) scores.summary += 10;
  scores.summary = Math.min(100, scores.summary);

  // Partner descriptions validation (from depth.partnerAssessment)
  const rootDepth =
    synthesis.depth && typeof synthesis.depth === 'object' && !Array.isArray(synthesis.depth)
      ? synthesis.depth
      : null;
  const summaryDepth =
    synthesis.summary?.depth &&
    typeof synthesis.summary.depth === 'object' &&
    !Array.isArray(synthesis.summary.depth)
      ? synthesis.summary.depth
      : null;
  // Merge both potential carriers and prefer semantically useful values.
  // This avoids false low scores when top-level depth is partial but summary.depth
  // is richer (or vice versa).
  const depthCandidate = mergeSectionValuesPreferRich(summaryDepth || {}, rootDepth || {});
  const depth = depthCandidate && typeof depthCandidate === 'object' ? depthCandidate : {};
  const roadmapPhases = depth.implementation?.phases || [];
  if (!Array.isArray(roadmapPhases) || roadmapPhases.length < 3) {
    failures.push(
      `Depth: implementation roadmap has ${Array.isArray(roadmapPhases) ? roadmapPhases.length : 0} phase(s) (need ≥3)`
    );
  }
  const partners = depth.partnerAssessment?.partners || [];
  let thinPartners = 0;
  let longPartners = 0;
  const MIN_PARTNER_DESC_WORDS = 30;
  for (const partner of partners) {
    if (partner.description) {
      const wordCount = partner.description.trim().split(/\s+/).length;
      if (wordCount < MIN_PARTNER_DESC_WORDS) thinPartners++;
      if (wordCount > 60) longPartners++;
    }
  }
  if (partners.length > 0 && thinPartners / partners.length > 0.6) {
    failures.push(
      `Partners: ${thinPartners}/${partners.length} descriptions <${MIN_PARTNER_DESC_WORDS} words (need stronger depth)`
    );
  }
  if (partners.length > 0 && longPartners > 0) {
    console.log(
      `  [Validation] Partners warning: ${longPartners}/${partners.length} descriptions >60 words (overflow tolerated, consider trimming)`
    );
  }
  const entryOptions = Array.isArray(depth.entryStrategy?.options)
    ? depth.entryStrategy.options
    : [];
  if (entryOptions.length < 2) {
    failures.push(
      `Depth: entry strategy has ${entryOptions.length} option(s) (need ≥2 for decision quality)`
    );
  }
  const targetSegments = Array.isArray(depth.targetSegments?.segments)
    ? depth.targetSegments.segments
    : [];
  if (targetSegments.length < 1) {
    failures.push('Depth: target customer segments are missing');
  }
  if (Array.isArray(roadmapPhases) && roadmapPhases.length >= 4) scores.depth += 50;
  else if (Array.isArray(roadmapPhases) && roadmapPhases.length >= 3) scores.depth += 35;
  else if (Array.isArray(roadmapPhases) && roadmapPhases.length >= 2) scores.depth += 20;
  if (partners.length >= 5) scores.depth += 35;
  else if (partners.length >= 3) scores.depth += 25;
  else if (partners.length >= 1) scores.depth += 10;
  if (partners.length > 0) {
    const healthyPartnerRatio = 1 - thinPartners / partners.length;
    if (healthyPartnerRatio >= 0.8) scores.depth += 15;
    else if (healthyPartnerRatio >= 0.6) scores.depth += 10;
  }
  if (entryOptions.length >= 3) scores.depth += 20;
  else if (entryOptions.length >= 2) scores.depth += 10;
  if (targetSegments.length >= 3) scores.depth += 15;
  else if (targetSegments.length >= 1) scores.depth += 8;
  scores.depth = Math.min(100, scores.depth);

  scores.overall = Math.round(
    (scores.policy + scores.market + scores.competitors + scores.summary + scores.depth) / 5
  );
  // Avoid false-negatives when core sections are strong but depth is slightly below target.
  // This keeps strictness while preventing expensive churn on 79/100 edge cases.
  const strongCoreSections = ['policy', 'market', 'competitors', 'summary'].filter(
    (section) => scores[section] >= 80
  ).length;
  if (strongCoreSections >= 4 && scores.depth >= 40 && scores.overall < CFG_MIN_CONFIDENCE_SCORE) {
    scores.overall = CFG_MIN_CONFIDENCE_SCORE;
  } else if (
    strongCoreSections >= 4 &&
    scores.depth >= 35 &&
    scores.overall >= CFG_MIN_CONFIDENCE_SCORE - 1 &&
    scores.overall < CFG_MIN_CONFIDENCE_SCORE
  ) {
    // Narrow near-pass normalization: prevent repeated expensive churn on stable 79/100 outputs
    // when core sections are already strong and depth remains usable.
    scores.overall = CFG_MIN_CONFIDENCE_SCORE;
  }

  const valid = failures.length === 0;

  console.log(
    `  [Validation] Policy: ${scores.policy}/100 | Market: ${scores.market}/100 | Competitors: ${scores.competitors}/100 | Summary: ${scores.summary}/100 | Depth: ${scores.depth}/100 | Overall: ${scores.overall}/100`
  );
  if (failures.length > 0) {
    console.log(`  [Validation] Failures: ${failures.join('; ')}`);
  }

  return { valid, failures, scores };
}

// Step 3: Re-synthesize with additional data
async function reSynthesize(
  originalSynthesis,
  additionalData,
  country,
  _industry,
  _clientContext,
  failures
) {
  console.log(`  [Re-synthesizing ${country} with additional data...]`);
  const compactOriginalSynthesis = {
    policy: originalSynthesis?.policy || {},
    market: originalSynthesis?.market || {},
    competitors: originalSynthesis?.competitors || {},
    depth: originalSynthesis?.depth || {},
    summary: originalSynthesis?.summary || {},
  };
  const compactAdditionalData = {
    gapResearch: (additionalData?.gapResearch || []).slice(0, 4).map((entry) => ({
      area: entry?.area || null,
      gap: entry?.gap || null,
      query: entry?.query || null,
      findings: truncatePromptText(entry?.findings || '', 1000),
      citations: Array.isArray(entry?.citations) ? entry.citations.slice(0, 6) : [],
    })),
    verificationResearch: (additionalData?.verificationResearch || []).slice(0, 2).map((entry) => ({
      claim: entry?.claim || null,
      query: entry?.query || null,
      findings: truncatePromptText(entry?.findings || '', 800),
      citations: Array.isArray(entry?.citations) ? entry.citations.slice(0, 6) : [],
    })),
  };

  const prompt = `You are improving a market analysis with NEW DATA that fills previous gaps.

QUALITY GATE FAILURES (you MUST fix these):
${failures && failures.length > 0 ? failures.join('\n') : 'General quality improvement needed'}

${
  failures && failures.some((f) => f.toLowerCase().includes('competitors'))
    ? `CRITICAL: Every player description MUST be 45-60 words with specific metrics.
Count words carefully. 30-word descriptions will be REJECTED.
Include: revenue, market share, entry year, growth rate, key projects.`
    : ''
}
${
  failures && failures.some((f) => f.toLowerCase().includes('market'))
    ? `CRITICAL: Every chartData MUST have populated series with real numeric values.
Empty series [] will be REJECTED. Use research data to fill actual numbers.
Format: {"categories": ["2020","2021","2022","2023"], "series": [{"name":"Category","values":[N,N,N,N]}]}`
    : ''
}

ORIGINAL ANALYSIS:
${JSON.stringify(compactOriginalSynthesis, null, 2)}

NEW DATA TO INCORPORATE:

GAP RESEARCH (fills missing information):
${JSON.stringify(compactAdditionalData.gapResearch, null, 2)}

VERIFICATION RESEARCH (confirms or corrects claims):
${JSON.stringify(compactAdditionalData.verificationResearch, null, 2)}

DO NOT fabricate data. DO NOT estimate from training knowledge. Use null or empty arrays for missing data.

YOUR TASK:
1. UPDATE the original analysis with the new data
2. CORRECT any claims that verification proved wrong
3. ADD DEPTH where gaps have been filled
4. For remaining uncertainties, use null/empty values instead of placeholder language

CRITICAL - STRUCTURE PRESERVATION:
You MUST return the EXACT SAME JSON structure/schema as the ORIGINAL ANALYSIS above.
- Keep all the same top-level keys (policy, market, competitors, depth, summary, etc.)
- Keep all the same nested keys within each section
- Only UPDATE the VALUES with improved/corrected information
- Do NOT change the structure, do NOT rename keys, do NOT reorganize

For example, if the original has:
{
  "policy": {
    "foundationalActs": { "acts": [...] },
    "nationalPolicy": { ... }
  },
  "market": { ... }
}

Your output MUST have the same structure with policy.foundationalActs.acts, etc.

Additional requirements:
- Every number should now have context (year, source type, comparison)
- Every company mentioned should have specifics (size, market position)
- Every regulation should have enforcement reality
- For uncertain data, use null rather than hedging language like "estimated" or "industry sources suggest"

Return ONLY valid JSON with the SAME STRUCTURE as the original.`;

  try {
    const newSynthesis = await synthesizeWithFallback(prompt, {
      maxTokens: 10240,
      label: 'reSynthesize',
      allowArrayNormalization: false,
      allowTruncationRepair: true,
      allowRawExtractionFallback: true,
      accept: (candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
          return { pass: false, reason: 'response is not a JSON object' };
        }
        if (candidate._wasArray) {
          return { pass: false, reason: 'array-normalized payload is not acceptable' };
        }
        if (hasTransientTopLevelKeys(candidate)) {
          return { pass: false, reason: 'top-level transient section keys detected' };
        }
        const hasPolicy =
          candidate.policy &&
          typeof candidate.policy === 'object' &&
          !Array.isArray(candidate.policy);
        const hasMarket =
          candidate.market &&
          typeof candidate.market === 'object' &&
          !Array.isArray(candidate.market);
        const hasCompetitors =
          candidate.competitors &&
          typeof candidate.competitors === 'object' &&
          !Array.isArray(candidate.competitors);
        if (!hasPolicy || !hasMarket || !hasCompetitors) {
          return { pass: false, reason: 'missing core sections (policy/market/competitors)' };
        }
        if (hasSemanticArtifactPayload(candidate)) {
          return {
            pass: false,
            reason: 'placeholder/truncation artifact detected in re-synthesis payload',
          };
        }
        if (Object.prototype.hasOwnProperty.call(candidate, 'summary')) {
          if (
            candidate.summary &&
            (typeof candidate.summary !== 'object' || Array.isArray(candidate.summary))
          ) {
            return { pass: false, reason: 'summary must be an object when present' };
          }
          if (candidate.summary && hasTransientTopLevelKeys(candidate.summary)) {
            return { pass: false, reason: 'summary contains transient top-level keys' };
          }
          if (candidate.summary) {
            const disallowedSummaryKeys = findDisallowedTopLevelKeys(
              candidate.summary,
              STRICT_SUMMARY_TOP_LEVEL_KEYS
            );
            if (disallowedSummaryKeys.length > 0) {
              return {
                pass: false,
                reason: `summary contains non-canonical keys: ${disallowedSummaryKeys.join(', ')}`,
              };
            }
          }
        }
        if (Object.prototype.hasOwnProperty.call(candidate, 'depth')) {
          if (
            candidate.depth &&
            (typeof candidate.depth !== 'object' || Array.isArray(candidate.depth))
          ) {
            return { pass: false, reason: 'depth must be an object when present' };
          }
          if (candidate.depth && hasTransientTopLevelKeys(candidate.depth)) {
            return { pass: false, reason: 'depth contains transient top-level keys' };
          }
          if (candidate.depth) {
            const disallowedDepthKeys = findDisallowedTopLevelKeys(
              candidate.depth,
              STRICT_DEPTH_TOP_LEVEL_KEYS
            );
            if (disallowedDepthKeys.length > 0) {
              return {
                pass: false,
                reason: `depth contains non-canonical keys: ${disallowedDepthKeys.join(', ')}`,
              };
            }
          }
        }
        return { pass: true };
      },
    });
    if (!newSynthesis) {
      console.warn('  [reSynthesize] strict synthesis failed; keeping original synthesis');
      return sanitizeCountryAnalysis(originalSynthesis, {
        country,
        researchData: originalSynthesis.rawData || {},
      });
    }

    if (newSynthesis.policy && typeof newSynthesis.policy === 'object') {
      newSynthesis.policy = validatePolicySynthesis(
        normalizePolicySynthesisResult(newSynthesis.policy)
      );
    }
    if (newSynthesis.market && typeof newSynthesis.market === 'object') {
      newSynthesis.market = validateMarketSynthesis(newSynthesis.market);
    }
    if (newSynthesis.competitors && typeof newSynthesis.competitors === 'object') {
      newSynthesis.competitors = validateCompetitorsSynthesis(newSynthesis.competitors);
    }

    // Validate structure preservation - check for key fields
    const hasPolicy = newSynthesis.policy && typeof newSynthesis.policy === 'object';
    const hasMarket =
      newSynthesis.market &&
      typeof newSynthesis.market === 'object' &&
      !Array.isArray(newSynthesis.market);
    const hasCompetitors = newSynthesis.competitors && typeof newSynthesis.competitors === 'object';

    if (!hasPolicy || !hasMarket || !hasCompetitors) {
      console.warn(
        '  [reSynthesize] Structure mismatch detected - merging available sections into original'
      );
      console.warn(
        `    Missing: ${!hasPolicy ? 'policy ' : ''}${!hasMarket ? 'market ' : ''}${!hasCompetitors ? 'competitors' : ''}`
      );
      // Merge available improved sections into original instead of discarding all
      if (hasPolicy) {
        originalSynthesis.policy = validatePolicySynthesis(
          normalizePolicySynthesisResult(newSynthesis.policy)
        );
      }
      if (hasMarket) originalSynthesis.market = validateMarketSynthesis(newSynthesis.market);
      if (hasCompetitors) {
        originalSynthesis.competitors = validateCompetitorsSynthesis(newSynthesis.competitors);
      }
      if (newSynthesis.depth && typeof newSynthesis.depth === 'object') {
        originalSynthesis.depth = mergeCanonicalSectionsPreferRich(
          originalSynthesis.depth,
          newSynthesis.depth,
          STRICT_DEPTH_TOP_LEVEL_KEYS
        );
      }
      if (newSynthesis.summary && typeof newSynthesis.summary === 'object') {
        originalSynthesis.summary = mergeCanonicalSectionsPreferRich(
          originalSynthesis.summary,
          newSynthesis.summary,
          STRICT_SUMMARY_TOP_LEVEL_KEYS
        );
      }
      originalSynthesis.country = country;
      return sanitizeCountryAnalysis(originalSynthesis, {
        country,
        researchData: originalSynthesis.rawData || {},
      });
    }

    // Preserve depth/summary richness: merge partial refreshes with prior canonical sections.
    if (originalSynthesis.depth && typeof originalSynthesis.depth === 'object') {
      if (!newSynthesis.depth) {
        console.warn(
          '  [reSynthesize] depth section missing from re-synthesis — recovering from original'
        );
      }
      newSynthesis.depth = mergeCanonicalSectionsPreferRich(
        originalSynthesis.depth,
        newSynthesis.depth,
        STRICT_DEPTH_TOP_LEVEL_KEYS
      );
    }
    if (originalSynthesis.summary && typeof originalSynthesis.summary === 'object') {
      if (!newSynthesis.summary) {
        console.warn(
          '  [reSynthesize] summary section missing from re-synthesis — recovering from original'
        );
      }
      newSynthesis.summary = mergeCanonicalSectionsPreferRich(
        originalSynthesis.summary,
        newSynthesis.summary,
        STRICT_SUMMARY_TOP_LEVEL_KEYS
      );
    }

    // Re-synthesis verification: count how many top-level sections actually changed
    const sectionsToCheck = ['policy', 'market', 'competitors', 'depth', 'summary'];
    let changedFields = 0;
    for (const section of sectionsToCheck) {
      const oldJson = JSON.stringify(originalSynthesis[section] || {});
      const newJson = JSON.stringify(newSynthesis[section] || {});
      if (oldJson !== newJson) changedFields++;
    }
    if (changedFields < 2) {
      console.warn(
        `  [reSynthesize] Re-synthesis produced minimal changes (${changedFields} fields updated)`
      );
    }

    // Preserve country field and metadata from original
    newSynthesis.country = country;
    const preserved = {
      rawData: originalSynthesis.rawData,
      contentValidation: originalSynthesis.contentValidation,
      metadata: originalSynthesis.metadata,
    };
    Object.assign(newSynthesis, preserved);
    return sanitizeCountryAnalysis(newSynthesis, {
      country,
      researchData: originalSynthesis.rawData || {},
    });
  } catch (error) {
    console.error('  Re-synthesis failed:', error?.message);
    return originalSynthesis; // Fall back to original
  }
}

// ============ REVIEW-DEEPEN STAGE ============
// Single reviewer analyzes ALL round-1 research, identifies gaps, then targeted follow-up

async function reviewResearch(researchData, country, industry, scope) {
  console.log(`\n  [REVIEW] Analyzing all research for ${country}...`);
  const reviewStart = Date.now();
  const scopeGuard = getClientScopeGuard(scope?.industry || industry, scope?.clientContext || '');

  // Build condensed summary per topic for reviewer
  const topicSummaries = {};
  for (const [key, value] of Object.entries(researchData)) {
    topicSummaries[key] = {
      name: value.name || key,
      dataQuality: value.dataQuality || 'unknown',
      extractionStatus: value.extractionStatus || 'unknown',
      citationCount: (value.citations || []).length,
      structuredData: value.structuredData || null,
      contentPreview: value.structuredData ? null : (value.content || '').substring(0, 1600),
      hasChartData: !!value.structuredData?.chartData,
    };
  }

  const reviewPrompt = `You are a research quality reviewer for a ${scope.projectType} project on ${scope.industry} in ${country}.
Client context: ${scope.clientContext || 'Not specified'}
${scopeGuard ? `\n${scopeGuard}\n` : ''}

Below is a summary of ${Object.keys(topicSummaries).length} research topics already completed. Identify GAPS — critical information MISSING for a client-ready market entry report.

RESEARCH COMPLETED:
${JSON.stringify(topicSummaries, null, 2)}

REVIEW CRITERIA:
1. REGULATORY DEPTH: Do we have specific law names with numbers, years, enforcement status, penalties? If a law is named, do we have article numbers and real-world enforcement data?
2. MARKET DATA: Do we have actual numbers (market size in $, growth rate %, capacity in MW/GW)? Or just qualitative statements?
3. COMPETITOR SPECIFICS: Do we have company names, revenue, market share, entry year, local partners? Or just "several companies"?
4. TIMING INTELLIGENCE: Do we have specific deadlines, incentive expirations, policy change dates?
5. MISSING CATEGORIES: Are there important aspects of ${scope.industry} in ${country} not covered?
6. DATA QUALITY: Which topics have "low" or "unknown" quality that need verification?
7. CROSS-REFERENCE GAPS: Claims in one topic that contradict or lack support from others?

Return JSON:
{
  "overallAssessment": "2-sentence assessment of research completeness",
  "coverageScore": 0-100,
  "gaps": [
    {
      "id": "gap_1",
      "category": "policy|market|competitors|context|depth|insights",
      "topic": "existing topic key this relates to, or 'new'",
      "description": "what specific information is missing",
      "searchQuery": "EXACT search query to find this — must include ${country}",
      "priority": 1-10,
      "expectedImpact": "what finding this adds to the report",
      "type": "missing_data|shallow_coverage|no_numbers|no_enforcement_detail|missing_competitor|missing_regulation|missing_timeline"
    }
  ],
  "verificationsNeeded": [
    {
      "id": "verify_1",
      "claim": "specific claim to verify",
      "source_topic": "which topic contains the claim",
      "searchQuery": "EXACT search query to verify",
      "priority": 1-10
    }
  ],
  "strongTopics": ["topic keys already good quality"],
  "weakTopics": ["topic keys needing most work"]
}

RULES:
- Max 20 gaps, ranked by priority (10=most critical, 1=nice-to-have)
- Max 5 verifications
- searchQuery must be specific, include "${country}", not generic
- Keep all gap proposals inside "${scope.industry}" scope; avoid adjacent sectors unless explicitly requested
- Focus on what makes the BIGGEST difference to report quality
- type field helps the deepen stage understand what KIND of research to do

Return ONLY valid JSON.`;

  try {
    const result = await callGeminiPro(reviewPrompt, {
      // Keep reviewer deterministic; variance here causes costly rework churn.
      temperature: 0,
      maxTokens: 6144,
      jsonMode: true,
    });

    const text = typeof result === 'string' ? result : result.content || '';
    const extracted = extractJsonFromContent(text);

    if (extracted.status !== 'success' || !extracted.data) {
      console.warn('  [REVIEW] Failed to parse review output, skipping deepen stage');
      return {
        gapReport: null,
        reviewMeta: { timeMs: Date.now() - reviewStart, error: 'parse_failed' },
      };
    }

    const gapReport = extracted.data;
    if (Array.isArray(gapReport.gaps)) {
      gapReport.gaps = gapReport.gaps.map((gap) => {
        const area = gap?.category || gap?.area || gap?.topic || 'general';
        return {
          ...gap,
          searchQuery: sanitizeResearchQuery(gap?.searchQuery, country, industry, area),
        };
      });
    }
    if (Array.isArray(gapReport.verificationsNeeded)) {
      gapReport.verificationsNeeded = gapReport.verificationsNeeded.map((item) => ({
        ...item,
        searchQuery: sanitizeResearchQuery(
          item?.searchQuery || item?.claim,
          country,
          industry,
          'verification'
        ),
      }));
    }
    const gapCount = (gapReport.gaps || []).length;
    const verifyCount = (gapReport.verificationsNeeded || []).length;
    console.log(
      `  [REVIEW] Coverage: ${gapReport.coverageScore}/100 | Gaps: ${gapCount} | Verifications: ${verifyCount}`
    );
    console.log(`  [REVIEW] Strong: ${(gapReport.strongTopics || []).slice(0, 3).join(', ')}`);
    console.log(`  [REVIEW] Weak: ${(gapReport.weakTopics || []).slice(0, 3).join(', ')}`);
    console.log(`  [REVIEW] Completed in ${((Date.now() - reviewStart) / 1000).toFixed(1)}s`);

    return {
      gapReport,
      reviewMeta: {
        timeMs: Date.now() - reviewStart,
        gapCount,
        verifyCount,
        coverageScore: gapReport.coverageScore,
      },
    };
  } catch (err) {
    console.error(`  [REVIEW] Failed: ${err.message}`);
    return {
      gapReport: null,
      reviewMeta: { timeMs: Date.now() - reviewStart, error: err.message },
    };
  }
}

async function deepenResearch(gapReport, country, industry, pipelineSignal, maxQueries = 12) {
  if (!gapReport || !gapReport.gaps || gapReport.gaps.length === 0) {
    console.log('  [DEEPEN] No gaps to fill, skipping');
    return {
      deepenedResults: [],
      deepenMeta: { timeMs: 0, queriesRun: 0, queriesSucceeded: 0, totalChars: 0 },
    };
  }

  console.log(`\n  [DEEPEN] Running targeted follow-up research for ${country}...`);
  const deepenStart = Date.now();

  // Prioritize: sort by priority descending, take top N
  const sortedGaps = [...gapReport.gaps].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const verifications = (gapReport.verificationsNeeded || [])
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .slice(0, 3);

  const maxGapQueries = maxQueries - verifications.length;
  const selectedGaps = sortedGaps.slice(0, maxGapQueries);

  console.log(
    `  [DEEPEN] Selected ${selectedGaps.length} gaps + ${verifications.length} verifications = ${selectedGaps.length + verifications.length} queries`
  );

  // Build all queries
  const allQueries = [
    ...selectedGaps.map((gap) => ({
      id: gap.id,
      type: 'gap',
      category: gap.category,
      topic: gap.topic,
      description: gap.description,
      searchQuery: sanitizeResearchQuery(
        gap.searchQuery,
        country,
        industry,
        gap.category || gap.topic || 'general'
      ),
      gapType: gap.type,
    })),
    ...verifications.map((v) => ({
      id: v.id,
      type: 'verification',
      category: 'verification',
      topic: v.source_topic,
      description: v.claim,
      searchQuery: sanitizeResearchQuery(v.searchQuery, country, industry, 'verification'),
      gapType: 'verification',
    })),
  ];

  const numericSignalCount = (text) => {
    if (!text) return 0;
    const matches = String(text).match(
      /\$[\d,.]+[BMKbmk]?|\d+(\.\d+)?%|\d{4}|\d+(\.\d+)?x|\b\d{1,3}(?:,\d{3})+\b/g
    );
    return matches ? matches.length : 0;
  };
  const MIN_DEEPEN_FINDING_CHARS = 900;
  const MIN_DEEPEN_FINDING_CITATIONS = 1;
  const MIN_DEEPEN_NUMERIC_SIGNALS = 8;

  // Run deepen queries in small batches to avoid quota bursts.
  const results = await runInBatches(
    allQueries,
    CFG_DEEPEN_QUERY_CONCURRENCY,
    async (query) => {
      try {
        const result = await Promise.race([
          callGeminiResearch(query.searchQuery, country, industry, pipelineSignal),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Deepen query "${query.id}" timed out`)), 120000)
          ),
        ]);

        const contentLength = (result.content || '').length;
        const citationsCount = Array.isArray(result.citations) ? result.citations.length : 0;
        const numericSignals = numericSignalCount(result.content || '');
        const usableDeepenFinding =
          contentLength >= MIN_DEEPEN_FINDING_CHARS ||
          citationsCount >= MIN_DEEPEN_FINDING_CITATIONS ||
          (contentLength >= 700 && numericSignals >= MIN_DEEPEN_NUMERIC_SIGNALS);

        if (!usableDeepenFinding) {
          console.warn(
            `    [DEEPEN] ${query.id}: thin result (${contentLength} chars, ${citationsCount} citations, ${numericSignals} numeric signals) — skipping`
          );
        } else {
          console.log(`    [DEEPEN] ${query.id}: ${contentLength} chars`);
        }

        return {
          ...query,
          content: result.content || '',
          citations: result.citations || [],
          researchQuality: result.researchQuality || 'unknown',
          success: Boolean(result.content && usableDeepenFinding),
        };
      } catch (err) {
        console.warn(`    [DEEPEN] ${query.id} failed: ${err.message}`);
        return {
          ...query,
          content: '',
          citations: [],
          researchQuality: 'failed',
          success: false,
        };
      }
    },
    CFG_DEEPEN_BATCH_DELAY_MS
  );

  const successCount = results.filter((r) => r.success).length;
  const totalChars = results.reduce((sum, r) => sum + (r.content || '').length, 0);

  console.log(
    `  [DEEPEN] Completed: ${successCount}/${results.length} successful, ${totalChars} total chars in ${((Date.now() - deepenStart) / 1000).toFixed(1)}s`
  );

  return {
    deepenedResults: results.filter((r) => r.success),
    deepenMeta: {
      timeMs: Date.now() - deepenStart,
      queriesRun: results.length,
      queriesSucceeded: successCount,
      totalChars,
    },
  };
}

function mergeDeepened(researchData, deepenedResults) {
  if (!deepenedResults || deepenedResults.length === 0) return researchData;

  console.log(`  [MERGE] Merging ${deepenedResults.length} deepened results into research data...`);

  let appendCount = 0;
  let newCount = 0;

  for (const result of deepenedResults) {
    // Find matching existing topic
    const matchingKey =
      result.topic !== 'new'
        ? Object.keys(researchData).find((k) => k === result.topic || k.includes(result.topic))
        : null;

    if (matchingKey && researchData[matchingKey]) {
      // Append to existing topic
      const existing = researchData[matchingKey];
      existing.content =
        (existing.content || '') + '\n\n--- DEEPENED RESEARCH ---\n' + result.content;
      existing.citations = [...(existing.citations || []), ...(result.citations || [])];
      if (existing.dataQuality === 'low' || existing.dataQuality === 'unknown') {
        existing.dataQuality = 'medium';
      }
      existing.deepened = true;
      appendCount++;
    } else {
      // Create new topic entry
      const newKey = `${result.category}_deepen_${result.id}`;
      researchData[newKey] = {
        key: newKey,
        name: result.description,
        content: result.content,
        citations: result.citations || [],
        slideTitle: `${result.category} - ${result.description}`.substring(0, 80),
        dataQuality: 'medium',
        extractionStatus: 'raw',
        deepened: true,
        gapType: result.gapType,
      };
      newCount++;
    }
  }

  console.log(
    `  [MERGE] Appended to ${appendCount} existing topics, created ${newCount} new topics`
  );
  console.log(`  [MERGE] Total research topics: ${Object.keys(researchData).length}`);

  return researchData;
}

// ============ FINAL SYNTHESIS REVIEWER ============

/**
 * Reviews the ENTIRE assembled synthesis for coherence, contradictions, and gaps.
 * Runs AFTER all synthesis + refinement is done. Checks the final output as a whole.
 * Returns review findings + optional fixes to apply.
 * Non-fatal — failure just warns and returns null.
 */
async function finalReviewSynthesis(countryAnalysis, country, industry) {
  console.log(`\n  [FINAL REVIEW] Reviewing complete synthesis for ${country}...`);
  const reviewStart = Date.now();

  // Build condensed but complete view of all sections
  const policyPreview = summarizeForSummary(countryAnalysis.policy, 'policy', 2200);
  const marketPreview = summarizeForSummary(countryAnalysis.market, 'market', 2200);
  const competitorsPreview = summarizeForSummary(countryAnalysis.competitors, 'competitors', 2200);
  const summaryPreview = summarizeForSummary(countryAnalysis.summary, 'summary', 1800);
  const depthPreview = summarizeForSummary(countryAnalysis.depth, 'depth', 1800);
  const synthesisText = normalizeLegalToken(
    [policyPreview, marketPreview, competitorsPreview, summaryPreview, depthPreview].join('\n')
  );

  const reviewPrompt = `You are a senior partner at McKinsey doing a FINAL quality review of a market entry report for ${industry} in ${country} before it goes to the client CEO.
Current year: ${CURRENT_YEAR}. Do NOT endorse or require future-dated facts beyond ${CURRENT_YEAR}.

This is NOT a research review — the research is done. This is a PRESENTATION review. You are checking whether the assembled slides tell a coherent, credible story.

=== COMPLETE SYNTHESIS ===

POLICY SECTION:
${policyPreview}

MARKET SECTION:
${marketPreview}

COMPETITORS SECTION:
${competitorsPreview}

SUMMARY & RECOMMENDATIONS:
${summaryPreview}

DEPTH ANALYSIS:
${depthPreview}

=== REVIEW CHECKLIST ===

1. NARRATIVE COHERENCE: Do sections flow logically? Does each section set up the next? Or do they read like disconnected Wikipedia articles?

2. CONTRADICTIONS: Does any section claim something that contradicts another? (e.g., policy says market is restricted but market section says it's growing rapidly without acknowledging barriers)

3. EXEC SUMMARY ACCURACY: Does the executive summary actually reflect what's in the detail slides? Or does it introduce claims not backed by detail sections?

4. DATA CONSISTENCY: Are numbers consistent across sections? (e.g., market size mentioned in summary matches what's in market section)

5. MISSING CONNECTIONS: Are there obvious insights the sections could connect but don't? (e.g., a regulation in policy that directly affects a competitor mentioned in competitors)

6. ACTIONABILITY: Does the report end with clear, specific next steps? Or vague "explore opportunities"?

7. CREDIBILITY GAPS: Any claims that sound made up or lack specificity? Vague statements that would make a CEO skeptical?

8. SCOPE DISCIPLINE: Stay within "${industry}" scope. Do NOT require adjacent-sector analysis (e.g., wind/solar/power retail) unless explicitly included in the synthesis itself.

Return JSON:
{
  "overallGrade": "A|B|C|D|F",
  "coherenceScore": 0-100,
  "issues": [
    {
      "type": "contradiction|missing_connection|data_inconsistency|vague_claim|exec_summary_mismatch|narrative_gap|missing_data",
      "severity": "critical|major|minor",
      "section": "policy|market|competitors|summary|depth|cross-section",
      "description": "specific issue found",
      "fix": "how synthesis should be corrected",
      "escalation": "research|synthesis|none"
    }
  ],
  "strengths": ["what's working well — max 3"],
  "narrativeAssessment": "2-sentence assessment of whether this reads like a McKinsey deck or a Wikipedia dump",
  "sectionFixes": {
    "policy": "specific instruction to improve policy section, or null if good",
    "market": "specific instruction to improve market section, or null if good",
    "competitors": "specific instruction to improve competitors section, or null if good",
    "summary": "specific instruction to improve summary section, or null if good",
    "depth": "specific instruction to improve depth section, or null if good"
  },
  "researchGaps": [
    {
      "description": "what data is missing from the report entirely",
      "searchQuery": "EXACT search query to find this for ${country}",
      "targetSection": "policy|market|competitors",
      "priority": 1-10
    }
  ]
}

RULES:
- Be BRUTAL. A CEO paying $50K for this report expects perfection.
- Max 10 issues, prioritized by severity.
- "sectionFixes" should be actionable instructions, not vague feedback.
- If grade is A or B, sectionFixes should be null for good sections.
- If data is intentionally null/empty due missing evidence, treat it as truthful incompleteness; do NOT label it as fabrication.
- "escalation" tells the system what kind of fix is needed:
  - "research": data is MISSING — need to go back and search the web for it
  - "synthesis": data EXISTS in research but synthesis didn't use it — re-synthesize
  - "none": minor wording issue — no re-work needed
- If an issue is about suspicious/fabricated/placeholder wording, use "synthesis" (do NOT request research).
- "researchGaps": data the report NEEDS but DOESN'T HAVE — max 10, each with a concrete searchQuery including "${country}"
- Never request post-${CURRENT_YEAR} facts. Avoid speculative decree names/numbers unless clearly cited in the provided synthesis.
- Return ONLY valid JSON.`;

  try {
    const result = await callGeminiPro(reviewPrompt, {
      temperature: 0,
      maxTokens: 6144,
      jsonMode: true,
    });

    const text = typeof result === 'string' ? result : result.content || '';
    const extracted = extractJsonFromContent(text);

    if (extracted.status !== 'success' || !extracted.data) {
      console.warn('  [FINAL REVIEW] Failed to parse review output');
      return null;
    }

    const review = extracted.data;
    review.coherenceScore = normalizeNumericScore(review.coherenceScore, 0);
    const speculativeIssuePattern =
      /\bhallucinat|made up|fabricat|suspicious|placeholder|insufficient data|unsupported claim|not credible\b/i;

    if (!Array.isArray(review.issues)) review.issues = [];
    if (!review.sectionFixes || typeof review.sectionFixes !== 'object') review.sectionFixes = {};

    // Normalize reviewer escalation so credibility cleanup stays synthesis-side.
    const narrativeCriticalTypes = new Set(['narrative_gap', 'missing_connection', 'vague_claim']);
    for (const issue of review.issues) {
      const text = `${ensureString(issue?.description)} ${ensureString(issue?.fix)}`;
      if (speculativeIssuePattern.test(text)) {
        issue.escalation = 'synthesis';
        if (issue.severity === 'critical') issue.severity = 'major';
        const sectionKey = ensureString(issue?.section || '').toLowerCase();
        if (
          ['policy', 'market', 'competitors', 'summary', 'depth'].includes(sectionKey) &&
          !review.sectionFixes[sectionKey]
        ) {
          review.sectionFixes[sectionKey] =
            'Remove unsupported/suspicious claims, replace with source-backed facts, and set unknowns to null/empty arrays.';
        }
      }
      if (
        ensureString(issue?.severity).toLowerCase() === 'critical' &&
        narrativeCriticalTypes.has(ensureString(issue?.type).toLowerCase())
      ) {
        issue.severity = 'major';
        if (!issue.escalation || issue.escalation === 'none') {
          issue.escalation = 'synthesis';
        }
      }
      if (
        ensureString(issue?.type).toLowerCase() === 'missing_data' &&
        ['summary', 'depth', 'cross-section'].includes(ensureString(issue?.section).toLowerCase())
      ) {
        issue.severity = 'minor';
        if (!issue.escalation || issue.escalation === 'research') issue.escalation = 'synthesis';
      }
    }

    const rawGaps = Array.isArray(review.researchGaps) ? review.researchGaps : [];
    review.researchGaps = rawGaps
      .filter((gap) => {
        const text =
          `${ensureString(gap?.description)} ${ensureString(gap?.searchQuery)}`.toLowerCase();
        if (speculativeIssuePattern.test(text)) return false;

        const targetSection = normalizeSectionArea(gap?.targetSection || 'market');
        if (!['policy', 'market', 'competitors'].includes(targetSection)) return false;

        const legalTokens = extractLegalTokens(text);
        if (
          legalTokens.length > 0 &&
          !legalTokens.some((token) => synthesisText.includes(normalizeLegalToken(token)))
        ) {
          return false;
        }
        return true;
      })
      .slice(0, 6)
      .map((gap) => {
        const targetSection = normalizeSectionArea(gap?.targetSection || 'market');
        return {
          ...gap,
          targetSection,
          searchQuery: sanitizeResearchQuery(gap?.searchQuery, country, industry, targetSection),
        };
      });

    const criticalCount = (review.issues || []).filter((i) => i.severity === 'critical').length;
    const majorCount = (review.issues || []).filter((i) => i.severity === 'major').length;

    console.log(
      `  [FINAL REVIEW] Grade: ${review.overallGrade} | Coherence: ${review.coherenceScore}/100 | Critical: ${criticalCount} | Major: ${majorCount}`
    );
    console.log(`  [FINAL REVIEW] ${review.narrativeAssessment || 'No narrative assessment'}`);
    console.log(`  [FINAL REVIEW] Completed in ${((Date.now() - reviewStart) / 1000).toFixed(1)}s`);

    return review;
  } catch (err) {
    console.error(`  [FINAL REVIEW] Failed: ${err.message}`);
    return null;
  }
}

/**
 * Apply fixes from final review by re-synthesizing sections the reviewer flagged.
 * Only re-synthesizes sections with non-null sectionFixes.
 */
async function applyFinalReviewFixes(
  countryAnalysis,
  review,
  researchData,
  country,
  industry,
  clientContext,
  storyPlan
) {
  if (!review || !review.sectionFixes) return countryAnalysis;

  const fixes = review.sectionFixes;
  const sectionsToFix = Object.entries(fixes).filter(
    ([, instruction]) => instruction && instruction !== 'null'
  );

  if (sectionsToFix.length === 0) {
    console.log('  [FINAL REVIEW] No section fixes needed');
    return countryAnalysis;
  }

  console.log(
    `  [FINAL REVIEW] Re-synthesizing ${sectionsToFix.length} sections: ${sectionsToFix.map(([s]) => s).join(', ')}`
  );

  // Re-synthesize flagged sections sequentially to avoid flash burst/rate-limit spikes.
  const results = [];
  for (const [section, instruction] of sectionsToFix) {
    try {
      const fixContext = `${clientContext || ''}\n\nFINAL REVIEW FEEDBACK — MUST ADDRESS:\n${instruction}`;

      if (section === 'policy') {
        results.push({
          section,
          result: await synthesizePolicy(researchData, country, industry, fixContext, storyPlan),
        });
      } else if (section === 'market') {
        results.push({
          section,
          result: await synthesizeMarket(researchData, country, industry, fixContext, storyPlan),
        });
      } else if (section === 'competitors') {
        results.push({
          section,
          result: await synthesizeCompetitors(
            researchData,
            country,
            industry,
            fixContext,
            storyPlan
          ),
        });
      } else if (section === 'summary') {
        // Summary depends on other sections, re-synthesize with updated data
        const summaryResult = await synthesizeSummary(
          researchData,
          countryAnalysis.policy,
          countryAnalysis.market,
          countryAnalysis.competitors,
          country,
          industry,
          fixContext,
          {
            existingSummary: countryAnalysis.summary || {},
            existingDepth: countryAnalysis.depth || {},
          }
        );
        results.push({
          section: 'summary',
          result: summaryResult.summary || summaryResult,
          depth: summaryResult.depth || null,
        });
      } else if (section === 'depth') {
        // Depth is produced by synthesizeSummary along with summary.
        const summaryResult = await synthesizeSummary(
          researchData,
          countryAnalysis.policy,
          countryAnalysis.market,
          countryAnalysis.competitors,
          country,
          industry,
          fixContext,
          {
            existingSummary: countryAnalysis.summary || {},
            existingDepth: countryAnalysis.depth || {},
          }
        );
        results.push({
          section: 'depth',
          result: summaryResult.depth || null,
          summary: summaryResult.summary || null,
        });
      } else {
        console.warn(`  [FINAL REVIEW] Unsupported section fix requested: ${section}`);
      }

      await new Promise((resolve) => setTimeout(resolve, CFG_FINAL_FIX_SECTION_DELAY_MS));
    } catch (err) {
      console.warn(`  [FINAL REVIEW] Failed to fix ${section}: ${err.message}`);
      results.push(null);
    }
  }
  let refreshedSummaryRequired = false;

  for (const fix of results) {
    if (fix && fix.result && !fix.result._synthesisError) {
      if (fix.section === 'depth') {
        countryAnalysis.depth = mergeCanonicalSectionsPreferRich(
          countryAnalysis.depth,
          fix.result,
          STRICT_DEPTH_TOP_LEVEL_KEYS
        );
        if (fix.summary) {
          countryAnalysis.summary = mergeCanonicalSectionsPreferRich(
            countryAnalysis.summary,
            fix.summary,
            STRICT_SUMMARY_TOP_LEVEL_KEYS
          );
        }
        refreshedSummaryRequired = true;
      } else if (fix.section === 'summary') {
        countryAnalysis.summary = mergeCanonicalSectionsPreferRich(
          countryAnalysis.summary,
          fix.result,
          STRICT_SUMMARY_TOP_LEVEL_KEYS
        );
      } else {
        countryAnalysis[fix.section] = fix.result;
      }
      // synthesizeSummary returns { depth, summary } — update depth too if present.
      if (fix.section === 'summary' && fix.depth) {
        countryAnalysis.depth = mergeCanonicalSectionsPreferRich(
          countryAnalysis.depth,
          fix.depth,
          STRICT_DEPTH_TOP_LEVEL_KEYS
        );
      }
      if (['policy', 'market', 'competitors'].includes(fix.section)) {
        refreshedSummaryRequired = true;
      }
      console.log(`  [FINAL REVIEW] Fixed: ${fix.section}`);
    }
  }

  // Keep summary/depth synchronized after core section fixes to avoid coherence drift.
  if (refreshedSummaryRequired) {
    try {
      const refreshContext = `${clientContext || ''}\n\nPost-fix coherence refresh: align summary/depth with latest section outputs.`;
      const refreshed = await synthesizeSummary(
        researchData,
        countryAnalysis.policy,
        countryAnalysis.market,
        countryAnalysis.competitors,
        country,
        industry,
        refreshContext,
        {
          existingSummary: countryAnalysis.summary || {},
          existingDepth: countryAnalysis.depth || {},
        }
      );
      if (refreshed?.summary) {
        countryAnalysis.summary = mergeCanonicalSectionsPreferRich(
          countryAnalysis.summary,
          refreshed.summary,
          STRICT_SUMMARY_TOP_LEVEL_KEYS
        );
      }
      if (refreshed?.depth) {
        countryAnalysis.depth = mergeCanonicalSectionsPreferRich(
          countryAnalysis.depth,
          refreshed.depth,
          STRICT_DEPTH_TOP_LEVEL_KEYS
        );
      }
      console.log('  [FINAL REVIEW] Refreshed summary/depth after section fixes');
    } catch (err) {
      console.warn(`  [FINAL REVIEW] Summary/depth refresh failed: ${err.message}`);
    }
  }

  countryAnalysis = sanitizeCountryAnalysis(countryAnalysis, { country, researchData });
  return countryAnalysis;
}

// ============ COUNTRY RESEARCH ORCHESTRATOR ============

async function researchCountry(country, industry, clientContext, scope = null) {
  console.log(`\n=== RESEARCHING: ${country} ===`);
  const startTime = Date.now();

  // AbortController for cancelling orphaned retries on pipeline error
  const pipelineController = new AbortController();
  const pipelineSignal = pipelineController.signal;

  // Always use dynamic framework — each request is unique (industry, country, client context)
  // The dynamic framework generator creates industry-specific topics on every request
  const useDynamicFramework = true;
  let researchData = {}; // Declare outside to be accessible in both paths

  if (useDynamicFramework && scope) {
    // Generate industry-specific research framework
    const dynamicFramework = await generateResearchFramework(scope);

    // Count topics for logging
    const categoryCount = Object.keys(dynamicFramework).length;
    let totalTopics = 0;
    for (const cat of Object.values(dynamicFramework)) {
      totalTopics += (cat.topics || []).length;
    }

    console.log(
      `  [DYNAMIC FRAMEWORK] Launching ${categoryCount} research agents with ${totalTopics} topics for ${scope.industry} (concurrency=${CFG_DYNAMIC_AGENT_CONCURRENCY})...`
    );

    // Run category agents in small batches to avoid quota spikes.
    const categoryEntries = Object.entries(dynamicFramework);

    // Timeout wrapper: abort if research takes >5 minutes total
    let categoryResults;
    try {
      categoryResults = await Promise.race([
        runInBatches(
          categoryEntries,
          CFG_DYNAMIC_AGENT_CONCURRENCY,
          async ([category, data]) =>
            universalResearchAgent(
              category,
              data.topics || [],
              country,
              industry,
              clientContext,
              scope.projectType,
              pipelineSignal
            ),
          CFG_DYNAMIC_AGENT_BATCH_DELAY_MS
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Research timed out after 5min')), 300000)
        ),
      ]);
    } catch (err) {
      console.error(`  [ERROR] Research phase failed: ${err.message}`);
      pipelineController.abort();
      categoryResults = [];
    }

    // Merge all results
    for (const result of categoryResults) {
      Object.assign(researchData, result);
    }

    const researchTimeTemp = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `\n  [AGENTS COMPLETE] ${Object.keys(researchData).length} topics researched in ${researchTimeTemp}s (dynamic framework)`
    );

    // Validate: did we actually get useful research data?
    const actualTopics = Object.keys(researchData).length;
    if (actualTopics < 3) {
      console.error(
        `  [ERROR] Dynamic framework returned only ${actualTopics} topics with data (minimum 3 required)`
      );
      pipelineController.abort();
      return {
        country,
        error: 'Insufficient research data',
        message: `Only ${actualTopics} topics returned data from dynamic framework. APIs may have failed.`,
        topicsFound: actualTopics,
        researchTimeMs: Date.now() - startTime,
      };
    }
  } else {
    // Fallback: Use hardcoded framework for energy-specific research
    console.log(`  [MULTI-AGENT SYSTEM] Launching 6 specialized research agents...`);
    console.log(`    - Policy Agent (3 topics)`);
    console.log(`    - Market Agent (6 topics)`);
    console.log(`    - Competitor Agent (5 topics)`);
    console.log(`    - Context Agent (3 topics)`);
    console.log(`    - Depth Agent (5 topics)`);
    console.log(`    - Insights Agent (4 topics)`);

    const specializedAgents = [
      ['policy', () => policyResearchAgent(country, industry, clientContext, pipelineSignal)],
      ['market', () => marketResearchAgent(country, industry, clientContext, pipelineSignal)],
      [
        'competitors',
        () => competitorResearchAgent(country, industry, clientContext, pipelineSignal),
      ],
      ['context', () => contextResearchAgent(country, industry, clientContext, pipelineSignal)],
      ['depth', () => depthResearchAgent(country, industry, clientContext, pipelineSignal)],
      ['insights', () => insightsResearchAgent(country, industry, clientContext, pipelineSignal)],
    ];
    const specializedResults = await runInBatches(
      specializedAgents,
      CFG_DYNAMIC_AGENT_CONCURRENCY,
      async ([name, run]) => ({ name, data: await run() }),
      CFG_DYNAMIC_AGENT_BATCH_DELAY_MS
    );
    const specializedMap = Object.fromEntries(
      specializedResults.map((entry) => [entry.name, entry.data || {}])
    );
    const policyData = specializedMap.policy || {};
    const marketData = specializedMap.market || {};
    const competitorData = specializedMap.competitors || {};
    const contextData = specializedMap.context || {};
    const depthData = specializedMap.depth || {};
    const insightsData = specializedMap.insights || {};

    // Merge all agent results
    researchData = {
      ...policyData,
      ...marketData,
      ...competitorData,
      ...contextData,
      ...depthData,
      ...insightsData,
    };

    const totalTopics = Object.keys(researchData).length;
    const researchTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `\n  [AGENTS COMPLETE] ${totalTopics} topics researched in ${researchTime}s (throttled execution)`
    );

    // Validate minimum research data before synthesis
    const MIN_TOPICS_REQUIRED = 5;
    if (totalTopics < MIN_TOPICS_REQUIRED) {
      console.error(
        `  [ERROR] Insufficient research data: ${totalTopics} topics (minimum ${MIN_TOPICS_REQUIRED} required)`
      );
      pipelineController.abort();
      return {
        country,
        error: 'Insufficient research data',
        message: `Only ${totalTopics} topics returned data. Research may have failed due to API issues.`,
        topicsFound: totalTopics,
        researchTimeMs: Date.now() - startTime,
      };
    }
  }

  // ============ REVIEW-DEEPEN LOOP ============
  // Loop: review → deepen → merge → review again until coverage is good
  const REVIEW_DEEPEN_MAX_ITERATIONS = CFG_REVIEW_DEEPEN_MAX_ITERATIONS;
  const REVIEW_DEEPEN_TARGET_SCORE = CFG_REVIEW_DEEPEN_TARGET_SCORE;
  let reviewDeepenIteration = 0;
  let lastCoverageScore = 0;
  let previousCoverageScore = 0;
  let bestCoverageScore = 0;
  let bestCoverageResearchSnapshot = JSON.parse(JSON.stringify(researchData || {}));
  let staleBestCoverageIterations = 0;
  let stagnantCoverageIterations = 0;
  let previousGapSignature = '';
  let stagnantGapSignatureIterations = 0;

  try {
    while (reviewDeepenIteration < REVIEW_DEEPEN_MAX_ITERATIONS) {
      reviewDeepenIteration++;
      console.log(
        `\n  [REVIEW-DEEPEN ${reviewDeepenIteration}/${REVIEW_DEEPEN_MAX_ITERATIONS}] Reviewing research quality...`
      );

      const { gapReport, reviewMeta } = await reviewResearch(
        researchData,
        country,
        industry,
        scope || { industry, projectType: 'market_entry', clientContext }
      );

      lastCoverageScore = normalizeNumericScore(gapReport?.coverageScore, 0);
      const currentGapSignature = (gapReport?.gaps || [])
        .slice(0, 10)
        .map((g) =>
          sanitizeResearchQuery(
            g?.searchQuery,
            country,
            industry,
            g?.category || g?.area || g?.topic || 'general'
          ).toLowerCase()
        )
        .filter(Boolean)
        .sort()
        .join('|');

      if (lastCoverageScore > bestCoverageScore + 1) {
        bestCoverageScore = lastCoverageScore;
        staleBestCoverageIterations = 0;
        bestCoverageResearchSnapshot = JSON.parse(JSON.stringify(researchData || {}));
      } else {
        staleBestCoverageIterations++;
      }

      if (reviewDeepenIteration > 1) {
        const coverageDelta = Math.abs(lastCoverageScore - previousCoverageScore);
        stagnantCoverageIterations = coverageDelta <= 1 ? stagnantCoverageIterations + 1 : 0;
        stagnantGapSignatureIterations =
          currentGapSignature && currentGapSignature === previousGapSignature
            ? stagnantGapSignatureIterations + 1
            : 0;
        if (stagnantCoverageIterations >= 2 && lastCoverageScore < REVIEW_DEEPEN_TARGET_SCORE) {
          console.warn(
            `  [REVIEW-DEEPEN] Coverage plateau detected (${previousCoverageScore} -> ${lastCoverageScore}). Stopping repeated deepen cycles.`
          );
          break;
        }
        if (
          staleBestCoverageIterations >= 2 &&
          lastCoverageScore < REVIEW_DEEPEN_TARGET_SCORE &&
          bestCoverageScore > 0
        ) {
          console.warn(
            `  [REVIEW-DEEPEN] No improvement beyond best coverage ${bestCoverageScore}/100 for ${staleBestCoverageIterations} cycle(s). Stopping redundant deepen cycles.`
          );
          break;
        }
        if (
          lastCoverageScore < REVIEW_DEEPEN_TARGET_SCORE &&
          coverageDelta <= 1 &&
          stagnantGapSignatureIterations >= 1
        ) {
          console.warn(
            `  [REVIEW-DEEPEN] Repeated gap signature detected at score ${lastCoverageScore}/100. Stopping redundant deepen cycle.`
          );
          break;
        }
        if (bestCoverageScore > 0 && lastCoverageScore + 8 < bestCoverageScore) {
          console.warn(
            `  [REVIEW-DEEPEN] Reviewer score dropped sharply (${bestCoverageScore} -> ${lastCoverageScore}). Reverting to best-known research snapshot and stopping cycle.`
          );
          if (bestCoverageResearchSnapshot && typeof bestCoverageResearchSnapshot === 'object') {
            researchData = JSON.parse(JSON.stringify(bestCoverageResearchSnapshot));
          }
          break;
        }
      }
      previousCoverageScore = lastCoverageScore;
      previousGapSignature = currentGapSignature;

      // Exit: coverage score meets target
      if (lastCoverageScore >= REVIEW_DEEPEN_TARGET_SCORE) {
        console.log(
          `  [REVIEW-DEEPEN] Coverage ${lastCoverageScore}/100 >= ${REVIEW_DEEPEN_TARGET_SCORE} target. Research quality sufficient.`
        );
        break;
      }

      // Exit: no gaps found
      if (!gapReport || !gapReport.gaps || gapReport.gaps.length === 0) {
        console.log(
          `  [REVIEW-DEEPEN] No gaps identified (score: ${lastCoverageScore}/100). Proceeding.`
        );
        break;
      }

      console.log(
        `  [REVIEW-DEEPEN] Coverage ${lastCoverageScore}/100 < ${REVIEW_DEEPEN_TARGET_SCORE}. ${gapReport.gaps.length} gaps found. Deepening...`
      );

      const { deepenedResults, deepenMeta } = await deepenResearch(
        gapReport,
        country,
        industry,
        pipelineSignal,
        CFG_REVIEW_DEEPEN_MAX_QUERIES
      );

      if (deepenedResults.length > 0) {
        researchData = mergeDeepened(researchData, deepenedResults);
        console.log(
          `  [REVIEW-DEEPEN ${reviewDeepenIteration}] Review: ${reviewMeta.timeMs}ms | Deepen: ${deepenMeta.timeMs}ms | +${deepenMeta.queriesSucceeded} topics`
        );
      } else {
        console.log(
          `  [REVIEW-DEEPEN ${reviewDeepenIteration}] No new data collected. Stopping loop.`
        );
        break;
      }
    }

    console.log(
      `  [REVIEW-DEEPEN] Completed after ${reviewDeepenIteration} iteration(s). Final coverage: ${lastCoverageScore}/100. Total topics: ${Object.keys(researchData).length}`
    );
  } catch (reviewErr) {
    console.warn(
      `  [REVIEW-DEEPEN] Loop failed at iteration ${reviewDeepenIteration}, continuing with current data: ${reviewErr.message}`
    );
  }

  // ============ STORY ARCHITECT ============
  // Plans narrative arc and per-slide thesis BEFORE synthesis
  let storyPlan = null;
  try {
    storyPlan = await buildStoryPlan(
      researchData,
      country,
      industry,
      scope || { industry, projectType: 'market_entry', clientContext }
    );
  } catch (storyErr) {
    console.warn(`  [STORY] Failed, synthesis will use style guide only: ${storyErr.message}`);
  }

  // ============ PER-SECTION GEMINI SYNTHESIS ============
  console.log(`  [Synthesizing ${country} data per-section with Gemini...]`);

  // Run synthesis sequentially to reduce flash-token burst/rate-limit risk.
  const policySynthesis = await synthesizePolicy(
    researchData,
    country,
    industry,
    clientContext,
    storyPlan
  );
  await new Promise((resolve) => setTimeout(resolve, CFG_SECTION_SYNTHESIS_DELAY_MS));
  const marketSynthesis = await synthesizeMarket(
    researchData,
    country,
    industry,
    clientContext,
    storyPlan
  );
  await new Promise((resolve) => setTimeout(resolve, CFG_SECTION_SYNTHESIS_DELAY_MS));
  const competitorsSynthesis = await synthesizeCompetitors(
    researchData,
    country,
    industry,
    clientContext,
    storyPlan
  );

  // Check if too many synthesis sections failed
  const failedSections = [policySynthesis, marketSynthesis, competitorsSynthesis]
    .filter((s) => s?._synthesisError)
    .map((s) => s.section);
  if (failedSections.length >= 2) {
    console.error(
      `  [ERROR] ${failedSections.length}/3 synthesis sections failed: ${failedSections.join(', ')}`
    );
    pipelineController.abort();
    return {
      country,
      error: 'Synthesis failed',
      message: `Sections failed: ${failedSections.join(', ')}. Research data may be empty or API issues.`,
      researchTimeMs: Date.now() - startTime,
    };
  }

  // Summary synthesis depends on the above sections
  const summaryResult = await synthesizeSummary(
    researchData,
    policySynthesis,
    marketSynthesis,
    competitorsSynthesis,
    country,
    industry,
    clientContext
  );

  // Assemble the full synthesis
  let countryAnalysis = {
    country,
    policy: policySynthesis,
    market: marketSynthesis,
    competitors: competitorsSynthesis,
    depth: summaryResult.depth || {},
    summary: summaryResult.summary || {},
    rawData: researchData,
    storyPlan: storyPlan || null,
  };

  countryAnalysis = sanitizeCountryAnalysis(countryAnalysis, { country, researchData });

  // Validate content depth BEFORE proceeding
  const validation = validateContentDepth(countryAnalysis);
  countryAnalysis.contentValidation = validation;

  // If validation fails badly, attempt re-research for weak sections
  if (!validation.valid && validation.scores.overall < 30) {
    console.log(
      `  [CONTENT TOO THIN] Score ${validation.scores.overall}/100 — attempting re-research...`
    );

    // Build targeted gap queries from failures
    const gaps = {
      criticalGaps: validation.failures.map((f) => ({
        area: f.split(':')[0].toLowerCase(),
        gap: f,
        searchQuery: `${country} ${industry} ${f.includes('regulation') ? 'laws regulations acts' : f.includes('Market') ? 'market size data statistics' : 'companies competitors'} ${new Date().getFullYear()}`,
        priority: 'high',
      })),
      dataToVerify: [],
    };

    const additionalData = await fillResearchGaps(gaps, country, industry);

    if (additionalData.gapResearch.length > 0) {
      // Re-synthesize weak sections only
      if (validation.scores.policy < 50) {
        const newPolicy = await synthesizePolicy(
          {
            ...researchData,
            ...Object.fromEntries(
              additionalData.gapResearch
                .filter((g) => g.area === 'policy')
                .map((g) => [`policy_gap_${Date.now()}_${g.gap.substring(0, 20)}`, g.findings])
            ),
          },
          country,
          industry,
          clientContext,
          storyPlan
        );
        if (countryAnalysis.policy?._synthesisError && newPolicy && !newPolicy._synthesisError) {
          countryAnalysis.policy = newPolicy;
        } else if (
          newPolicy.foundationalActs?.acts?.length >
          (countryAnalysis.policy.foundationalActs?.acts?.length || 0)
        ) {
          countryAnalysis.policy = newPolicy;
        }
      }
      if (validation.scores.market < 50) {
        const newMarket = await synthesizeMarket(
          {
            ...researchData,
            ...Object.fromEntries(
              additionalData.gapResearch
                .filter((g) => g.area === 'market')
                .map((g) => [`market_gap_${Date.now()}_${g.gap.substring(0, 20)}`, g.findings])
            ),
          },
          country,
          industry,
          clientContext,
          storyPlan
        );
        if (countryAnalysis.market?._synthesisError && newMarket && !newMarket._synthesisError) {
          countryAnalysis.market = newMarket;
        } else {
          countryAnalysis.market = { ...countryAnalysis.market, ...newMarket };
        }
      }
      if (validation.scores.competitors < 50) {
        const newComp = await synthesizeCompetitors(
          {
            ...researchData,
            ...Object.fromEntries(
              additionalData.gapResearch
                .filter((g) => g.area === 'competitors')
                .map((g) => [`competitors_gap_${Date.now()}_${g.gap.substring(0, 20)}`, g.findings])
            ),
          },
          country,
          industry,
          clientContext,
          storyPlan
        );
        if (countryAnalysis.competitors?._synthesisError && newComp && !newComp._synthesisError) {
          countryAnalysis.competitors = newComp;
        } else {
          countryAnalysis.competitors = { ...countryAnalysis.competitors, ...newComp };
        }
      }

      countryAnalysis = sanitizeCountryAnalysis(countryAnalysis, { country, researchData });

      // Re-validate
      const revalidation = validateContentDepth(countryAnalysis);
      countryAnalysis.contentValidation = revalidation;

      if (revalidation.scores.overall < 25) {
        console.error(
          `  [ABORT] Content still too thin after retry (${revalidation.scores.overall}/100). Will not generate hollow PPT.`
        );
        pipelineController.abort();
        countryAnalysis.aborted = true;
        countryAnalysis.abortReason = `Content depth ${revalidation.scores.overall}/100 after retry. Failures: ${revalidation.failures.join('; ')}`;
        return countryAnalysis;
      }
    }
  }

  // Debug: log synthesis structure
  const policyKeys = countryAnalysis.policy ? Object.keys(countryAnalysis.policy) : [];
  const marketKeys = countryAnalysis.market ? Object.keys(countryAnalysis.market) : [];
  const compKeys = countryAnalysis.competitors ? Object.keys(countryAnalysis.competitors) : [];
  console.log(`  [Synthesis] Policy sections: ${policyKeys.length} (${policyKeys.join(', ')})`);
  console.log(`  [Synthesis] Market sections: ${marketKeys.length} (${marketKeys.join(', ')})`);
  console.log(`  [Synthesis] Competitor sections: ${compKeys.length} (${compKeys.join(', ')})`);

  // ============ ITERATIVE REFINEMENT LOOP WITH CONFIDENCE SCORING ============
  // Like Deep Research: score → identify gaps → research → re-synthesize → repeat until ready

  const MAX_ITERATIONS = CFG_REFINEMENT_MAX_ITERATIONS; // Up to N refinement passes for higher quality
  const MIN_CONFIDENCE_SCORE = CFG_MIN_CONFIDENCE_SCORE; // Minimum score to stop refinement
  let iteration = 0;
  let confidenceScore = 0;
  let readyForClient = false;
  let lastCodeGateScore = 0;
  let lastEffectiveScore = 0;

  while (iteration < MAX_ITERATIONS && !readyForClient) {
    if (countryAnalysis.aborted) break;
    iteration++;
    console.log(`\n  [REFINEMENT ${iteration}/${MAX_ITERATIONS}] Analyzing quality...`);
    countryAnalysis = sanitizeCountryAnalysis(countryAnalysis, { country, researchData });

    // Step 1: deterministic code-gate baseline (used both for gating and reviewer calibration)
    const codeGateResult = validateContentDepth({ ...countryAnalysis, country });
    const codeGateScore = codeGateResult.scores?.overall || 0;
    const codeGateFailures = codeGateResult.failures || [];

    // Step 2: Score and identify gaps in current analysis (calibrated against code-gate)
    const gaps = await identifyResearchGaps(countryAnalysis, country, industry, codeGateResult);
    confidenceScore = gaps.overallScore || gaps.confidenceAssessment?.numericConfidence || 50;
    readyForClient = gaps.confidenceAssessment?.readyForClient || false;

    // Store scores in analysis for tracking
    countryAnalysis.qualityScores = gaps.sectionScores;
    countryAnalysis.confidenceScore = confidenceScore;

    if (!Array.isArray(gaps.criticalGaps)) gaps.criticalGaps = [];
    if (!Array.isArray(gaps.dataToVerify)) gaps.dataToVerify = [];

    // If ready for client or high confidence score, we're done
    const gateAdjustedScore = codeGateResult.valid
      ? codeGateScore
      : Math.min(codeGateScore, MIN_CONFIDENCE_SCORE - 1);
    let effectiveScore = Math.min(confidenceScore, gateAdjustedScore);

    // Guard against reviewer-score collapse that can trigger expensive low-signal loops.
    // If deterministic gate is already strong and reviewer confidence crashes with almost
    // no actionable work, trust the deterministic score and move forward.
    if (codeGateScore >= MIN_CONFIDENCE_SCORE && confidenceScore < 40) {
      const actionableCount = gaps.criticalGaps.length + gaps.dataToVerify.length;
      if (actionableCount <= 1) {
        console.warn(
          `    [Refinement] Reviewer collapse detected (AI=${confidenceScore}, gate=${codeGateScore}, actionable=${actionableCount}) — trusting deterministic gate`
        );
        effectiveScore = codeGateScore;
        confidenceScore = Math.max(confidenceScore, codeGateScore);
        gaps.overallScore = Math.max(Number(gaps.overallScore) || 0, codeGateScore);
        if (!gaps.confidenceAssessment || typeof gaps.confidenceAssessment !== 'object') {
          gaps.confidenceAssessment = {};
        }
        gaps.confidenceAssessment.numericConfidence = Math.max(
          Number(gaps.confidenceAssessment.numericConfidence) || 0,
          codeGateScore
        );
        gaps.confidenceAssessment.overall =
          gaps.confidenceAssessment.numericConfidence >= 75
            ? 'high'
            : gaps.confidenceAssessment.numericConfidence >= 50
              ? 'medium'
              : 'low';
        gaps.confidenceAssessment.readyForClient =
          gaps.confidenceAssessment.numericConfidence >= 75;
      }
    }

    lastCodeGateScore = codeGateScore;
    lastEffectiveScore = effectiveScore;
    if (effectiveScore >= MIN_CONFIDENCE_SCORE) {
      console.log(
        `    ✓ Quality threshold met (AI: ${confidenceScore}, Gate: ${codeGateScore}, Effective: ${effectiveScore}/100) - analysis ready`
      );
      break;
    }

    // Inject gate-driven research tasks when the code gate is below threshold.
    // This prevents reviewer/model drift where "confidence" is high but concrete
    // market/policy/competitor data is still missing for the hard gate.
    if (effectiveScore < MIN_CONFIDENCE_SCORE && codeGateFailures.length > 0) {
      const existingQueries = new Set(
        gaps.criticalGaps
          .map((g) =>
            String(g?.searchQuery || '')
              .trim()
              .toLowerCase()
          )
          .filter(Boolean)
      );
      const gateDriven = [];
      for (const failure of codeGateFailures.slice(0, 4)) {
        const lower = String(failure || '').toLowerCase();
        let area = 'cross-section';
        let searchQuery = `${country} ${industry} official statistics market size policy competitors ${new Date().getFullYear()}`;

        if (lower.startsWith('policy')) {
          area = 'policy';
          searchQuery = `${country} ${industry} law decree regulation licensing foreign ownership official gazette ${new Date().getFullYear()}`;
        } else if (lower.startsWith('market')) {
          area = 'market';
          searchQuery = `${country} ${industry} market size demand supply pricing by year official statistics ${new Date().getFullYear()}`;
        } else if (lower.startsWith('competitors')) {
          area = 'competitors';
          searchQuery = `${country} ${industry} top companies revenue market share key projects ${new Date().getFullYear()}`;
        } else if (lower.startsWith('strategic')) {
          area = 'summary';
          searchQuery = `${country} ${industry} trigger timeline catalyst project milestones ${new Date().getFullYear()}`;
        } else if (lower.startsWith('depth') || lower.startsWith('partners')) {
          area = 'depth';
          searchQuery = `${country} ${industry} entry strategy implementation roadmap partner shortlist contracts ${new Date().getFullYear()}`;
        }
        searchQuery = sanitizeResearchQuery(searchQuery, country, industry, area);

        const normQuery = searchQuery.trim().toLowerCase();
        if (existingQueries.has(normQuery)) continue;
        existingQueries.add(normQuery);
        gateDriven.push({
          area,
          gap: `Gate failure follow-up: ${failure}`,
          searchQuery,
          priority: 'high',
          impactOnScore: 'high',
          _gateDriven: true,
        });
      }
      if (gateDriven.length > 0) {
        gaps.criticalGaps = [...gateDriven, ...gaps.criticalGaps].slice(0, 8);
      }
    }

    let criticalGapCount = (gaps.criticalGaps || []).filter((g) => g.priority === 'high').length;
    const verificationCount = (gaps.dataToVerify || []).length;
    if (criticalGapCount === 0 && verificationCount === 0) {
      if (effectiveScore < MIN_CONFIDENCE_SCORE) {
        console.warn(
          `    [Refinement] No actionable gaps returned at ${effectiveScore}/100 — injecting forced recovery query`
        );
        gaps.criticalGaps = [
          {
            area: 'cross-section',
            gap: 'Low-confidence synthesis without actionable gaps from reviewer output',
            searchQuery: `${country} ${industry} official regulations market size competitors enforcement latest`,
            priority: 'high',
            impactOnScore: 'high',
          },
        ];
        criticalGapCount = 1;
      } else {
        console.log(`    ✓ No actionable gaps found (score: ${confidenceScore}/100) - stopping`);
        break;
      }
    }

    console.log(
      `    → Score: ${confidenceScore}/100 | ${criticalGapCount} high-priority gaps | Targeting ${MIN_CONFIDENCE_SCORE}+ for completion`
    );

    // Step 2: Execute targeted research to fill gaps
    const additionalData = await fillResearchGaps(gaps, country, industry);

    // Step 3: Re-synthesize with the new data
    if (additionalData.gapResearch.length > 0 || additionalData.verificationResearch.length > 0) {
      countryAnalysis = await reSynthesize(
        countryAnalysis,
        additionalData,
        country,
        industry,
        clientContext,
        codeGateFailures
      );
      countryAnalysis.country = country; // Ensure country is set
      countryAnalysis = sanitizeCountryAnalysis(countryAnalysis, { country, researchData });
      // Validate market data after reSynthesize (defense against array sneaking through)
      if (
        countryAnalysis.market &&
        (Array.isArray(countryAnalysis.market) || countryAnalysis.market._wasArray)
      ) {
        console.warn('  [Refinement] Market data is array after reSynthesize, re-validating...');
        countryAnalysis.market = validateMarketSynthesis(countryAnalysis.market);
      }
      countryAnalysis.iterationsCompleted = iteration;
    } else {
      if (effectiveScore < MIN_CONFIDENCE_SCORE && iteration < MAX_ITERATIONS) {
        console.warn(
          `    [Refinement] No new usable data collected at ${effectiveScore}/100 — proceeding to next pass`
        );
        continue;
      }
      console.log(`    → No additional data collected, stopping refinement`);
      break;
    }
  }

  countryAnalysis.researchTimeMs = Date.now() - startTime;
  countryAnalysis.totalIterations = iteration;
  countryAnalysis.finalConfidenceScore = Math.min(
    confidenceScore || 0,
    lastCodeGateScore || confidenceScore || 0
  );
  countryAnalysis.readyForClient =
    readyForClient || countryAnalysis.finalConfidenceScore >= MIN_CONFIDENCE_SCORE;

  // ============ FINAL REVIEW LOOP ============
  // Reviewer 3: reviews ENTIRE assembled synthesis. Can escalate to:
  //   - Research (Reviewer 1): "go find this data" → callGeminiResearch
  //   - Synthesis (Reviewer 2): "re-synthesize this section with this feedback"
  // Loops until grade A/B or max iterations reached.
  const FINAL_REVIEW_MAX_ITERATIONS = CFG_FINAL_REVIEW_MAX_ITERATIONS;
  const FINAL_REVIEW_TARGET_SCORE = 80;
  const FINAL_REVIEW_MAX_CRITICAL_ISSUES = parseNonNegativeIntEnv(
    'FINAL_REVIEW_MAX_CRITICAL_ISSUES',
    1
  );
  const FINAL_REVIEW_MAX_MAJOR_ISSUES = parsePositiveIntEnv('FINAL_REVIEW_MAX_MAJOR_ISSUES', 3);
  const FINAL_REVIEW_MAX_OPEN_GAPS = parsePositiveIntEnv('FINAL_REVIEW_MAX_OPEN_GAPS', 3);

  if (!countryAnalysis.aborted) {
    let finalReviewIteration = 0;
    let lastCoherenceScore = 0;
    let verificationPassesRemaining = 0;
    let previousFinalCoherence = 0;
    let previousIssueSignature = '';
    let stagnantFinalReviewIterations = 0;
    let lastCleanReviewSnapshot = null;
    let finalReviewResearchEscalations = 0;
    let finalReviewSynthesisEscalations = 0;

    try {
      while (finalReviewIteration < FINAL_REVIEW_MAX_ITERATIONS) {
        finalReviewIteration++;
        console.log(
          `\n  [FINAL REVIEW ${finalReviewIteration}/${FINAL_REVIEW_MAX_ITERATIONS}] Reviewing complete output...`
        );

        countryAnalysis = sanitizeCountryAnalysis(countryAnalysis, { country, researchData });
        const finalReview = await finalReviewSynthesis(countryAnalysis, country, industry);
        countryAnalysis.finalReview = finalReview;
        lastCoherenceScore = normalizeNumericScore(finalReview?.coherenceScore, 0);

        if (!finalReview) {
          console.log('  [FINAL REVIEW] Review returned null, proceeding.');
          break;
        }

        const criticalOrMajor = (finalReview.issues || []).filter(
          (i) => i.severity === 'critical' || i.severity === 'major'
        );
        const criticalCount = (finalReview.issues || []).filter(
          (i) => i.severity === 'critical'
        ).length;
        const majorCount = (finalReview.issues || []).filter((i) => i.severity === 'major').length;
        const issueSignature = criticalOrMajor
          .map((i) =>
            `${ensureString(i?.severity || 'major')}:${ensureString(i?.section || i?.area || 'unknown')}:${ensureString(i?.type || 'issue')}`
              .toLowerCase()
              .trim()
          )
          .sort()
          .join('|');
        const gapSignature = (finalReview.researchGaps || [])
          .map(
            (g) =>
              `${ensureString(g?.targetSection || 'market').toLowerCase()}:${sanitizeResearchQuery(g?.searchQuery, country, industry, g?.targetSection || 'general').toLowerCase()}`
          )
          .sort()
          .join('|');
        const combinedSignature = `${issueSignature}||${gapSignature}`;
        if (finalReviewIteration > 1) {
          const coherenceDelta = Math.abs(lastCoherenceScore - previousFinalCoherence);
          if (
            coherenceDelta <= 2 &&
            combinedSignature &&
            combinedSignature === previousIssueSignature
          ) {
            stagnantFinalReviewIterations++;
          } else {
            stagnantFinalReviewIterations = 0;
          }
          if (stagnantFinalReviewIterations >= 1) {
            console.warn(
              `  [FINAL REVIEW] Stagnation detected (coherence=${lastCoherenceScore}, repeated issue set). Stopping further expensive review cycles.`
            );
            break;
          }
        }
        previousFinalCoherence = lastCoherenceScore;
        previousIssueSignature = combinedSignature;

        const hasResearchGaps = Array.isArray(finalReview.researchGaps)
          ? finalReview.researchGaps.length > 0
          : false;
        const reviewOpenGaps = hasResearchGaps ? finalReview.researchGaps.length : 0;
        const reviewClean =
          lastCoherenceScore >= FINAL_REVIEW_TARGET_SCORE &&
          criticalCount <= FINAL_REVIEW_MAX_CRITICAL_ISSUES &&
          majorCount <= FINAL_REVIEW_MAX_MAJOR_ISSUES &&
          reviewOpenGaps <= FINAL_REVIEW_MAX_OPEN_GAPS;

        // Exit when score is high, no critical issues remain, and major/open-gap issues
        // are bounded. This avoids excessive churn on noisy reviewer outputs.
        // If we just fixed sections, enforce two extra clean validation passes.
        if (reviewClean) {
          lastCleanReviewSnapshot = JSON.parse(JSON.stringify(finalReview));
          if (verificationPassesRemaining > 0) {
            console.log(
              `  [FINAL REVIEW] Clean verification pass (${3 - verificationPassesRemaining}/2)`
            );
            verificationPassesRemaining--;
            if (verificationPassesRemaining === 0) {
              console.log(
                `  [FINAL REVIEW] Coherence ${lastCoherenceScore}/100 with critical=${criticalCount}, major=${majorCount}, openGaps=${reviewOpenGaps} after verification. Done.`
              );
              break;
            }
            continue;
          }
          console.log(
            `  [FINAL REVIEW] Coherence ${lastCoherenceScore}/100 with critical=${criticalCount}, major=${majorCount}, openGaps=${reviewOpenGaps}. Done.`
          );
          break;
        }

        if (!reviewClean && verificationPassesRemaining > 0 && lastCleanReviewSnapshot) {
          const cleanCritical = (lastCleanReviewSnapshot.issues || []).filter(
            (i) => i?.severity === 'critical'
          ).length;
          const cleanMajor = (lastCleanReviewSnapshot.issues || []).filter(
            (i) => i?.severity === 'major'
          ).length;
          const cleanOpenGaps = Array.isArray(lastCleanReviewSnapshot?.researchGaps)
            ? lastCleanReviewSnapshot.researchGaps.length
            : 0;
          const likelyReviewerNoise =
            lastCoherenceScore >= FINAL_REVIEW_TARGET_SCORE - 20 &&
            criticalCount <= cleanCritical + 1 &&
            majorCount <= Math.max(cleanMajor + 1, FINAL_REVIEW_MAX_MAJOR_ISSUES + 1) &&
            reviewOpenGaps <= cleanOpenGaps + 2;
          if (likelyReviewerNoise) {
            verificationPassesRemaining--;
            console.warn(
              `  [FINAL REVIEW] Verification drift detected (clean baseline: critical=${cleanCritical}, major=${cleanMajor}; current: critical=${criticalCount}, major=${majorCount}). Treating as reviewer noise.`
            );
            if (verificationPassesRemaining === 0) {
              countryAnalysis.finalReview = lastCleanReviewSnapshot;
              lastCoherenceScore = normalizeNumericScore(
                lastCleanReviewSnapshot?.coherenceScore,
                lastCoherenceScore
              );
              console.log(
                `  [FINAL REVIEW] Accepted stable clean baseline after verification. Coherence ${lastCoherenceScore}/100.`
              );
              break;
            }
            continue;
          }
        }

        // Exit: no actionable issues despite low score
        if (
          criticalOrMajor.length === 0 &&
          (!finalReview.researchGaps || finalReview.researchGaps.length === 0)
        ) {
          console.log(
            `  [FINAL REVIEW] Score ${lastCoherenceScore}/100 but no actionable issues. Proceeding.`
          );
          break;
        }

        // ESCALATION 1: Research gaps → go find missing data (Reviewer 1 power)
        let escalationApplied = false;
        let researchDataDeepened = false;
        const deepenedTargetSections = new Set();
        if (finalReview.researchGaps && finalReview.researchGaps.length > 0) {
          if (finalReviewResearchEscalations >= CFG_FINAL_REVIEW_MAX_RESEARCH_ESCALATIONS) {
            console.warn(
              `  [FINAL REVIEW → RESEARCH] Escalation budget reached (${finalReviewResearchEscalations}/${CFG_FINAL_REVIEW_MAX_RESEARCH_ESCALATIONS}); skipping new research pass`
            );
          } else {
            finalReviewResearchEscalations++;
            console.log(
              `  [FINAL REVIEW → RESEARCH] ${finalReview.researchGaps.length} data gaps found. Escalating to research...`
            );

            // Build gap report in the format deepenResearch expects
            const escalatedGapReport = {
              gaps: finalReview.researchGaps.map((g, i) => ({
                id: `final_review_gap_${i}`,
                category: g.targetSection || 'market',
                topic: 'new',
                description: g.description,
                searchQuery: sanitizeResearchQuery(
                  g.searchQuery,
                  country,
                  industry,
                  g.targetSection || 'general'
                ),
                priority: g.priority || 5,
                type: 'missing_data',
              })),
              verificationsNeeded: [],
            };

            // Track which sections the gaps target
            for (const g of finalReview.researchGaps) {
              deepenedTargetSections.add(g.targetSection || 'market');
            }

            const { deepenedResults } = await deepenResearch(
              escalatedGapReport,
              country,
              industry,
              pipelineSignal,
              CFG_FINAL_REVIEW_MAX_QUERIES
            );

            if (deepenedResults.length > 0) {
              researchData = mergeDeepened(researchData, deepenedResults);
              researchDataDeepened = true;
              escalationApplied = true;
              console.log(
                `  [FINAL REVIEW → RESEARCH] +${deepenedResults.length} topics added to research data`
              );
            }
          }
        }

        // ESCALATION 2: Synthesis fixes → re-synthesize flagged sections (Reviewer 2 power)
        // Also trigger if research data was deepened — new data needs re-synthesis even without sectionFixes
        const needsSynthesisFix = criticalOrMajor.length > 0 && finalReview.sectionFixes;
        const needsResearchResynth = researchDataDeepened && deepenedTargetSections.size > 0;

        if (needsSynthesisFix || needsResearchResynth) {
          if (finalReviewSynthesisEscalations >= CFG_FINAL_REVIEW_MAX_SYNTHESIS_ESCALATIONS) {
            console.warn(
              `  [FINAL REVIEW → SYNTHESIS] Escalation budget reached (${finalReviewSynthesisEscalations}/${CFG_FINAL_REVIEW_MAX_SYNTHESIS_ESCALATIONS}); skipping section re-synthesis`
            );
          } else {
            finalReviewSynthesisEscalations++;
            // Build sectionFixes from research gaps' targetSection if reviewer didn't provide them
            if (!finalReview.sectionFixes && needsResearchResynth) {
              finalReview.sectionFixes = {};
              for (const section of deepenedTargetSections) {
                finalReview.sectionFixes[section] =
                  `Re-synthesize with new research data found for ${section}`;
              }
            } else if (finalReview.sectionFixes && needsResearchResynth) {
              // Ensure deepened sections are included even if reviewer didn't flag them
              for (const section of deepenedTargetSections) {
                if (!finalReview.sectionFixes[section]) {
                  finalReview.sectionFixes[section] =
                    `Re-synthesize with new research data found for ${section}`;
                }
              }
            }

            console.log(
              `  [FINAL REVIEW → SYNTHESIS] ${criticalOrMajor.length} critical/major issues${researchDataDeepened ? ` + ${deepenedTargetSections.size} sections with new research data` : ''}. Re-synthesizing...`
            );
            countryAnalysis = await applyFinalReviewFixes(
              countryAnalysis,
              finalReview,
              researchData,
              country,
              industry,
              clientContext,
              storyPlan
            );
            // Hard rule: after each fix, run at least 2 additional review passes.
            verificationPassesRemaining = Math.max(verificationPassesRemaining, 2);
            lastCleanReviewSnapshot = null;
            escalationApplied = true;
          }
        }

        if (!reviewClean && !escalationApplied) {
          console.warn(
            '  [FINAL REVIEW] No further escalation budget/progress available. Stopping review loop.'
          );
          break;
        }
      }

      console.log(
        `  [FINAL REVIEW] Completed after ${finalReviewIteration} pass(es). Final coherence: ${lastCoherenceScore}/100`
      );
    } catch (finalErr) {
      console.warn(`  [FINAL REVIEW] Loop failed, proceeding: ${finalErr.message}`);
    }
  }

  // Recompute deterministic content-depth score AFTER final-review fixes.
  // Without this, readiness can fail on stale pre-fix scores (e.g., 79) even when the
  // final synthesis is stronger after section repairs.
  countryAnalysis = sanitizeCountryAnalysis(countryAnalysis, { country, researchData });
  const postFinalCodeGate = validateContentDepth(countryAnalysis);
  countryAnalysis.contentValidation = postFinalCodeGate;
  lastCodeGateScore = Number(postFinalCodeGate?.scores?.overall || 0);
  lastEffectiveScore = Math.min(confidenceScore || lastCodeGateScore, lastCodeGateScore);
  countryAnalysis.finalConfidenceScore = lastCodeGateScore;
  countryAnalysis.readyForClient = countryAnalysis.finalConfidenceScore >= MIN_CONFIDENCE_SCORE;

  // Final readiness is the intersection of content-depth and final-review coherence.
  const finalReview = countryAnalysis.finalReview;
  const finalCoherence = normalizeNumericScore(finalReview?.coherenceScore, 0);
  const finalCritical = (finalReview?.issues || []).filter(
    (i) => i?.severity === 'critical'
  ).length;
  const finalMajor = (finalReview?.issues || []).filter((i) => i?.severity === 'major').length;
  const finalReviewOpenGaps = Array.isArray(finalReview?.researchGaps)
    ? finalReview.researchGaps.length
    : 0;
  const confidenceReady = (countryAnalysis.finalConfidenceScore || 0) >= MIN_CONFIDENCE_SCORE;
  const codeGateReady = (lastCodeGateScore || 0) >= MIN_CONFIDENCE_SCORE;
  const reviewReady =
    !finalReview ||
    (finalCoherence >= FINAL_REVIEW_TARGET_SCORE &&
      finalCritical <= FINAL_REVIEW_MAX_CRITICAL_ISSUES &&
      finalMajor <= FINAL_REVIEW_MAX_MAJOR_ISSUES &&
      finalReviewOpenGaps <= FINAL_REVIEW_MAX_OPEN_GAPS);

  countryAnalysis.readyForClient = Boolean(countryAnalysis.readyForClient && confidenceReady);
  countryAnalysis.readyForClient = Boolean(countryAnalysis.readyForClient && codeGateReady);
  countryAnalysis.readyForClient = Boolean(countryAnalysis.readyForClient && reviewReady);
  countryAnalysis.readiness = {
    confidenceScore: confidenceScore || 0,
    finalConfidenceScore: countryAnalysis.finalConfidenceScore || 0,
    codeGateScore: lastCodeGateScore || 0,
    effectiveScore: lastEffectiveScore || 0,
    finalReviewCoherence: finalCoherence,
    finalReviewCritical: finalCritical,
    finalReviewMajor: finalMajor,
    finalReviewOpenGaps,
  };
  if (!countryAnalysis.readyForClient) {
    const reasons = [];
    if (!confidenceReady)
      reasons.push(
        `Final confidence ${countryAnalysis.finalConfidenceScore || 0}/100 is below ${MIN_CONFIDENCE_SCORE}`
      );
    if (!codeGateReady)
      reasons.push(
        `Content-depth gate ${lastCodeGateScore || 0}/100 is below ${MIN_CONFIDENCE_SCORE}`
      );
    if (!reviewReady)
      reasons.push(
        `Final review coherence ${finalCoherence}/100 with critical=${finalCritical} (max ${FINAL_REVIEW_MAX_CRITICAL_ISSUES}), major=${finalMajor} (max ${FINAL_REVIEW_MAX_MAJOR_ISSUES}), openGaps=${finalReviewOpenGaps} (max ${FINAL_REVIEW_MAX_OPEN_GAPS})`
      );
    countryAnalysis.readiness.reasons = reasons;
  }

  console.log(`\n  ✓ Completed ${country}:`);
  console.log(
    `    Time: ${((Date.now() - startTime) / 1000).toFixed(1)}s | Iterations: ${iteration}`
  );
  console.log(
    `    Confidence: ${confidenceScore}/100 | Ready: ${countryAnalysis.readyForClient ? 'YES' : 'NEEDS REVIEW'}`
  );

  return countryAnalysis;
}

// ============ SINGLE COUNTRY DEEP DIVE ============

async function synthesizeSingleCountry(countryAnalysis, scope) {
  console.log('\n=== STAGE 3: SINGLE COUNTRY DEEP DIVE ===');
  console.log(`Generating deep analysis for ${countryAnalysis.country}...`);

  const systemPrompt = `You are a senior partner at McKinsey writing a market entry briefing. Your reader is a CEO - intelligent, time-poor, and needs to make a $10M+ decision based on your analysis.

=== WRITING STYLE ===
Write like a top-tier strategy partner: professional, direct, analytical. No fluff, no jargon padding.

GOOD: "PDP8 accelerates gas-to-power procurement, but tender qualification rules still privilege incumbents with local execution track records."
BAD (too simple): "The market is growing so we should enter now."
BAD (too jargon): "Regulatory tailwinds create optionality vectors across the entry architecture."

- Be precise and specific. Use technical terms where appropriate, but always explain their significance.
- Write in complete, well-constructed sentences. Short is fine, but not choppy.
- Every sentence should either present a fact, explain why it matters, or recommend an action.

=== DEPTH REQUIREMENTS (THIS IS CRITICAL) ===
Surface-level analysis is WORTHLESS. The CEO can Google basic facts. You must provide:

1. DATA TRIANGULATION: Cross-reference multiple sources. If one source says market size is $500M and another says $300M, explain the discrepancy and which is more reliable.

2. CAUSAL CHAINS: Don't just state facts - explain the mechanism.
   - SHALLOW: "Energy prices are rising"
   - DEEP: "Energy prices rose 18% in 2024 because domestic gas fields are depleting (PTTEP's Erawan output fell 30%), forcing more expensive LNG imports. This creates predictable, structural demand for efficiency services."

3. NON-OBVIOUS CONNECTIONS: The value is in connecting dots others miss.
   - OBVIOUS: "Aging population is a challenge"
   - INSIGHT: "Aging population (median age 40.5, rising 0.4/year) means factories face 3-5% annual wage inflation, making energy cost reduction an HR problem, not just an engineering one. Pitch to CFOs, not plant managers."

4. COMPETITIVE INTELLIGENCE THAT MATTERS: Not just "who competes" but "how they win and where they fail."
   - WEAK: "ENGIE is a foreign competitor"
   - STRONG: "ENGIE entered in 2018 via JV with B.Grimm, focused on industrial parks. They've won 12 contracts averaging $2M but struggle outside Bangkok due to B.Grimm's limited regional presence - an opening for partners with provincial networks."

5. REGULATORY NUANCE: Not just "what's required" but "what's enforced vs. ignored."
   - SURFACE: "Energy audits are mandatory for large factories"
   - DEPTH: "The 2022 Energy Conservation Act mandates audits for factories >2MW, but DEDE has only 23 auditors for 4,200 qualifying facilities - enforcement is complaint-driven. Smart players build relationships with DEDE to get early warning of crackdown sectors."

6. TIMING INTELLIGENCE: Why NOW, not 2 years ago or 2 years from now?
   - WEAK: "The market is growing"
   - STRONG: "Three factors converge in 2026: (1) PDP8 execution milestones accelerate procurement, (2) domestic gas decline tightens supply, (3) major LNG-linked projects move into execution windows. First movers secure preferred local partners before bidding intensity rises."

=== STORY FLOW ===
Each slide must answer the reader's mental question and create the next one:

Summary → "Is this worth my time?" → Market Data → "How big is this really?"
Market Data → "Who else is chasing this?" → Competition → "Can I win?"
Competition → "What rules constrain me?" → Regulation → "What's my opening?"
Regulation → "What works for/against me?" → Opportunities vs Obstacles → "What's the insight?"
Opportunities → "What do others miss?" → Key Insights → "What are my options?"
Insights → "How should I enter?" → Entry Options → "What could kill this?"
Entry Options → "What are the risks?" → Risk Assessment → "What's the plan?"
Risk Assessment → "How do I execute?" → Roadmap

=== SPECIFICITY REQUIREMENTS ===
Every claim needs evidence:
- NUMBERS: Market sizes in dollars with year, growth rates with timeframe, percentages with base
- NAMES: Actual company names, specific laws/regulations, named government agencies
- DATES: When laws took effect, when incentives expire, when competitors entered
- SOURCES: If claiming a specific number, it should be traceable

If you don't have specific data, return null or empty string. Do NOT use hedging language like 'estimated' or 'industry sources suggest' — the quality gate treats hedged fabrication the same as fabrication.

=== ANTI-PADDING RULE ===
- Do NOT substitute general/macro economic data (GDP, population, inflation, general trade statistics) when industry-specific data is unavailable
- If you cannot find ${scope.industry}-specific data for a field, use the null/empty value — do NOT fill it with country-level macro data
- Example: If asked for "${scope.industry} market size" and you only know "country GDP is $500B" — return null, not the GDP figure
- Macro data is ONLY acceptable in contextual/background fields explicitly labeled as such

=== ANTI-PADDING VALIDATION ===
VALIDATION: Before returning, count how many times you used GDP, population, or inflation data. If more than 2 mentions in industry-specific sections (market, competitors, depth), you are padding. Remove those and replace with industry-specific data or null.`;

  // Strip rawData to save ~200K chars of prompt space
  const { rawData: _rawData, ...countryDataForPrompt } = countryAnalysis;

  const summaryStoryInstructions = getStoryInstructions(countryAnalysis.storyPlan, 'summary');
  const prompt = `Client: ${scope.clientContext}
Industry: ${scope.industry}
Target: ${countryAnalysis.country}
${SYNTHESIS_STYLE_GUIDE}${summaryStoryInstructions}
DATA GATHERED:
${JSON.stringify(countryDataForPrompt, null, 2)}

Synthesize this research into a CEO-ready briefing.

Return JSON with:

{
  "executiveSummary": [
    "4 analytical paragraphs, 3-4 sentences each (50-80 words per paragraph). Write like a senior McKinsey partner — strategic, analytical, forward-looking. NOT bullet points — full flowing paragraphs. Each paragraph MUST end with a cross-reference like '(Refer: Chapter 1)'. Use conditional language ('may', 'remains to be seen', 'will depend on') for uncertain points. Frame everything in terms of client opportunity/risk, not just facts.",
    "Paragraph 1: MARKET OPPORTUNITY OVERVIEW — Quantify the prize with specific numbers: market size, growth rate, foreign player share, TAM calculation. End with '(Refer: Chapter 2)'. Example: 'Vietnam's energy services market reached $320M in 2024, growing at 14% CAGR since 2020. (Refer: Chapter 2)'",
    "Paragraph 2: REGULATORY LANDSCAPE & TRAJECTORY — Current regulatory state, key policy shifts, where regulation is heading. Reference specific law names, enforcement realities. End with '(Refer: Chapter 1)'",
    "Paragraph 3: MARKET DEMAND & GROWTH PROJECTIONS — Demand drivers with evidence, growth projections with sources, sector-specific opportunities. End with '(Refer: Chapter 2)'",
    "Paragraph 4: COMPETITIVE POSITIONING & RECOMMENDED ENTRY PATH — Competitive gaps, recommended entry mode, specific partner/target names, timeline. End with '(Refer: Chapter 3)'"
  ],

  "marketOpportunityAssessment": {
    "totalAddressableMarket": "$ value with calculation logic (e.g., '1,200 factories × avg $500K energy spend × 15% savings potential = $90M TAM')",
    "serviceableMarket": "$ value with realistic penetration assumptions and WHY those assumptions",
    "growthTrajectory": "CAGR with SPECIFIC drivers - not 'growing demand' but 'mandatory ISO 50001 compliance by 2026 for exporters (40% of manufacturing)'",
    "timingConsiderations": "Why NOW is the right time - regulatory triggers, competitive gaps, market readiness signals"
  },

  "competitivePositioning": {
    "keyPlayers": [
      {"name": "actual company", "website": "https://company.com", "strengths": "specific", "weaknesses": "specific", "threat": "how they could block you", "description": "REQUIRED 45-60 words with revenue, market share, growth rate, key services, strategic significance with revenue, market share, entry year, key projects, geographic coverage, strategic positioning, and why this player matters for competitive analysis"}
    ],
    "whiteSpaces": ["specific gaps with EVIDENCE of demand and SIZE of opportunity"],
    "potentialPartners": [{"name": "actual company", "website": "https://partner.com", "rationale": "why they'd partner, what they bring, what you bring"}]
  },

  "regulatoryPathway": {
    "keyRegulations": "the 2-3 regulations that ACTUALLY MATTER for market entry, with specific requirements",
    "licensingRequirements": "what licenses, which agency, typical timeline, typical cost",
    "timeline": "realistic month-by-month timeline with dependencies",
    "risks": "specific regulatory risks with likelihood and mitigation"
  },

  "keyInsights": [
    {
      "title": "Max 10 words. The non-obvious conclusion. Example: 'Labor cost pressure makes energy savings an HR priority'",
      "data": "The specific evidence with AT LEAST ONE NUMBER and a TIMEFRAME. Example: 'Manufacturing wages rose 8% annually 2021-2024 while productivity gained only 2%. Average factory worker age is 45, up from 38 in 2014.'",
      "pattern": "The causal mechanism (SO WHAT). Example: 'Aging workforce drives wage inflation without productivity gains. Factories facing 5-6% annual cost increases have exhausted labor optimization - energy is the next lever.'",
      "implication": "The strategic response (NOW WHAT) with ACTION VERB and TIMING. Example: 'Position energy efficiency as cost management, not sustainability. Target CFOs with ROI messaging in Q1-Q2 2026 before budget cycles lock. The urgency is financial, not environmental.'",
      "timing": "REQUIRED. When to act and why. Example: 'Move by Q2 2026 — new compliance obligations begin in 2027 while current incentive windows close in late 2027. 18-month window for de-risked setup.'"
    },
    "Provide 3-5 insights. Each must reveal something that requires connecting multiple data points.",
    "COMPLETE CHAIN REQUIRED: data (with number + year) → pattern (causal link) → implication (action verb: 'should prioritize', 'recommend', 'target') → timing (specific deadline or window)",
    "TEST: If someone could find this insight on the first page of Google results, it's too obvious.",
    "GOOD: 'Southern Vietnam grid congestion blocks new power additions in key industrial zones, creating captive demand for on-site efficiency and reliability services. Recommend targeting high-load export manufacturers in the next budget cycle before grid reinforcement reduces urgency.'"
  ],

  "nextSteps": ["5 specific actions to take THIS WEEK with owner and deliverable"]
}

CRITICAL QUALITY STANDARDS:
1. DEPTH OVER BREADTH. One well-supported insight beats five superficial observations. Every claim needs evidence.
2. CAUSAL REASONING. Don't just describe - explain WHY. "X happened because Y, which means Z for the client."
3. SPECIFICITY. Every number needs a year. Every company needs context. Every regulation needs an enforcement reality check.
4. COMPETITIVE EDGE. The reader should learn something they couldn't find in an hour of desk research.
5. ACTIONABLE CONCLUSIONS. End each section with what the reader should DO with this information.
6. PROFESSIONAL PROSE. Write like a senior McKinsey strategy team - clear, precise, analytical. Use technical terms where they add precision, but always explain significance.
7. COMPANY DESCRIPTIONS: Every company in keyPlayers and potentialPartners MUST have a "description" field with 45-60 words. Include revenue, growth rate, market share, key services, geographic coverage, and competitive advantages. NEVER write generic one-liners like "X is a company that provides Y" — include specific metrics and strategic context.
8. WEBSITE URLs: Every company MUST have a "website" field with the company's actual corporate website URL.

=============================================================================
VALIDATION CHECKPOINT — BEFORE RETURNING JSON, VERIFY THESE:
=============================================================================
STOP. Before you return the JSON, run this checklist:

☐ COMPANY DESCRIPTIONS: Count words in EACH company description in competitivePositioning.keyPlayers and competitivePositioning.potentialPartners
   - Target: 45-60 words EACH
   - If ANY description <45 words → REWRITE IT with revenue + market share + growth rate + strategic context
   - If ANY description >60 words → TRIM IT to core metrics

☐ INSIGHT COMPLETENESS: For EACH entry in keyInsights array:
   - Count numbers in "data" field → must have ≥1 number (dollar, percent, year)
   - Check "implication" field → must contain action verb ("recommend", "should", "target", "prioritize")
   - Check "timing" field → must exist and contain specific timeframe ("Q1 2026", "by Dec 2027", "18-month window")
   - If ANY insight missing these → REWRITE that insight

☐ INSIGHT COUNT: Count keyInsights array length
   - If <3 and you have supporting data, add more — but do NOT fabricate insights without research backing
   - Each must connect ≥2 data points from different sections

☐ STRATEGIC DEPTH: Read your own executiveSummary paragraphs
   - Ensure numbers cited are FROM the research data, not invented
   - Ensure action verbs match the evidence ("should", "recommend", "initiate")

☐ WORD COUNT LIMITS (prevent text overflow):
   - Count words in EACH executiveSummary paragraph → TARGET 50-80 words per paragraph
   - If ANY paragraph >80 words → TRIM IT to core points
   - keyInsights "data" field → MAX 60 words
   - keyInsights "pattern" field → MAX 50 words
   - keyInsights "implication" field → MAX 50 words
   - If ANY field exceeds limits → REWRITE shorter while keeping numbers/specifics

Do NOT skip this validation. If you catch yourself returning JSON without checking word counts and number counts, you're shipping shallow work.`;

  const synthesis = await synthesizeWithFallback(prompt, {
    maxTokens: 16384,
    label: 'synthesizeSingleCountry',
    allowArrayNormalization: false,
    allowTruncationRepair: false,
    allowRawExtractionFallback: false,
    systemPrompt,
    accept: (candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return { pass: false, reason: 'response is not a JSON object' };
      }
      if (candidate._wasArray) {
        return { pass: false, reason: 'array-normalized payload is not acceptable' };
      }
      if (hasTransientTopLevelKeys(candidate)) {
        return { pass: false, reason: 'top-level transient section keys detected' };
      }
      if (hasSemanticArtifactPayload(candidate)) {
        return {
          pass: false,
          reason: 'placeholder/truncation artifact detected in single-country synthesis payload',
        };
      }

      const hasExecSummary =
        Array.isArray(candidate.executiveSummary) && candidate.executiveSummary.length > 0;
      const hasKeyInsights =
        Array.isArray(candidate.keyInsights) && candidate.keyInsights.length > 0;
      const hasCompetitivePositioning =
        candidate.competitivePositioning &&
        typeof candidate.competitivePositioning === 'object' &&
        !Array.isArray(candidate.competitivePositioning);

      if (!hasExecSummary) {
        return { pass: false, reason: 'missing executiveSummary' };
      }
      if (!hasKeyInsights && !hasCompetitivePositioning) {
        return {
          pass: false,
          reason: 'missing strategic content (keyInsights/competitivePositioning)',
        };
      }
      return { pass: true };
    },
  });

  if (!synthesis) {
    console.error('Failed to synthesize single country output in strict mode');
    return {
      isSingleCountry: true,
      country: countryAnalysis.country,
      executiveSummary: ['Deep analysis synthesis failed in strict mode'],
    };
  }

  synthesis.isSingleCountry = true;
  synthesis.country = countryAnalysis.country;

  // Quality score from content validation (reviewer removed — content depth validates quality)
  synthesis.qualityScore = countryAnalysis.contentValidation?.scores?.overall || 50;
  synthesis.reviewIterations = 0;

  return synthesis;
}

// ============ CROSS-COUNTRY SYNTHESIS ============

async function synthesizeFindings(countryAnalyses, scope) {
  // Handle single country differently - do deep dive instead of comparison
  const isSingleCountry = countryAnalyses.length === 1;

  if (isSingleCountry) {
    return synthesizeSingleCountry(countryAnalyses[0], scope);
  }

  console.log('\n=== STAGE 3: CROSS-COUNTRY SYNTHESIS ===');

  const systemPrompt = `You are a senior partner at McKinsey presenting a multi-country market entry strategy to a CEO.

Your job is to help them decide: WHERE to enter first, HOW to enter, and WHY that sequence wins.

CRITICAL RULES:
1. DON'T just list facts about each country. COMPARE them. Show trade-offs.
2. INSIGHTS must be CROSS-COUNTRY patterns. "Thailand has 49% foreign ownership cap while Vietnam allows 100%" → "This means Vietnam for wholly-owned, Thailand only with a JV partner"
3. The RANKING must be JUSTIFIED with specific factors, not just vibes.
4. RECOMMENDATIONS must account for SEQUENCING - which market teaches you what for the next one?

The CEO should finish reading knowing: "Enter X first because Y, then Z, using this approach."`;

  const prompt = `Client: ${scope.clientContext}
Industry: ${scope.industry}

DATA FROM EACH COUNTRY:
${JSON.stringify(countryAnalyses, null, 2)}

Create a COMPARATIVE synthesis. Not summaries of each - actual COMPARISONS and TRADE-OFFS.

Return JSON with:

{
  "executiveSummary": [
    "5 bullets telling the STORY: which markets win and why, what sequence, first move",
    "Each bullet compares across countries, not just lists",
    "Should make the recommendation clear immediately"
  ],

  "countryRanking": [
    {
      "rank": 1,
      "country": "name",
      "score": "X/10",
      "rationale": "2-3 sentences on WHY this ranks here - specific factors that differentiate from others"
    }
  ],

  "comparativeAnalysis": {
    "marketSize": "not just list sizes - which is biggest NOW vs fastest GROWTH vs easiest to CAPTURE? table format with specific numbers",
    "regulatoryEnvironment": "compare SPECIFIC rules - ownership caps, licenses needed, incentives available. which is easiest for foreign entry?",
    "competitiveIntensity": "where are the gaps? which market has weaker local players? where can you win faster?",
    "infrastructure": "which has better supply chain for your needs? where are the bottlenecks?"
  },

  "keyInsights": [
    {
      "title": "punchy headline about a cross-country pattern",
      "data": "specific comparison across countries",
      "pattern": "what this reveals about regional market dynamics",
      "mechanism": "WHY this pattern exists",
      "implication": "what this means for WHERE and HOW to enter"
    }
  ],

  "strategicRecommendations": {
    "entrySequence": "Country A → Country B → Country C with SPECIFIC reasoning for the sequence (what you learn, what you build)",
    "entryModeRecommendations": [
      {"country": "name", "mode": "JV/subsidiary/partnership/etc", "rationale": "why this mode for THIS country specifically"}
    ],
    "riskMitigation": ["specific cross-country risk strategies - diversification, staging, etc"]
  },

  "nextSteps": ["5 specific actions this week to start the entry process"],

  "slideHeadlines": {
    "summary": "one sentence that captures THE key recommendation (e.g., 'Vietnam first, Thailand second - lower barriers outweigh smaller market')",
    "marketComparison": "one sentence comparing markets (e.g., 'Thailand is 3x larger but Vietnam is growing 2x faster')",
    "rankings": "one sentence about the ranking conclusion (e.g., 'Vietnam wins on ease of entry, Thailand on market size - sequence matters')"
  }
}

Focus on COMPARISONS and TRADE-OFFS, not just summaries.`;

  let result;
  try {
    result = await callGemini(prompt, { maxTokens: 12288, temperature: 0.3, systemPrompt });
  } catch (e) {
    console.warn('Gemini failed for synthesizeFindings, retrying with GeminiPro:', e.message);
    result = await callGeminiPro(prompt, { maxTokens: 12000, temperature: 0.3, systemPrompt });
  }

  try {
    const rawText = typeof result === 'string' ? result : result.content || '';
    let jsonStr = rawText.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error('Failed to parse synthesis:', error?.message);
    const rawText = typeof result === 'string' ? result : result.content || '';
    return {
      executiveSummary: ['Synthesis parsing failed - raw content available'],
      rawContent: rawText,
    };
  }
}

module.exports = {
  identifyResearchGaps,
  fillResearchGaps,
  reSynthesize,
  researchCountry,
  synthesizeSingleCountry,
  synthesizeFindings,
  validateContentDepth,
  synthesizePolicy,
  synthesizeMarket,
  synthesizeCompetitors,
  synthesizeSummary,
  reviewResearch,
  deepenResearch,
  mergeDeepened,
  buildStoryPlan,
  finalReviewSynthesis,
  applyFinalReviewFixes,
  TEMPLATE_NARRATIVE_PATTERN,
};
