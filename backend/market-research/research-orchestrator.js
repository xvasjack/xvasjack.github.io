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

// ============ ITERATIVE RESEARCH SYSTEM WITH CONFIDENCE SCORING ============

// Step 1: Identify gaps in research after first synthesis with detailed scoring
async function identifyResearchGaps(synthesis, country, _industry) {
  console.log(`  [Analyzing research quality for ${country}...]`);

  const gapPrompt = `You are a research quality auditor reviewing a market analysis. Score each section and identify critical gaps.

CURRENT ANALYSIS:
${JSON.stringify(synthesis, null, 2)}

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
    "summary": {"score": 0-100, "reasoning": "why this score", "missingData": ["list"]}
  },
  "overallScore": 0-100,
  "criticalGaps": [
    {
      "area": "which section (policy/market/competitors)",
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
- Limit criticalGaps to 6 most impactful items
- Only flag dataToVerify for claims that seem suspicious or unsourced

Return ONLY valid JSON.`;

  let result;
  try {
    const geminiResult = await callGemini(gapPrompt, {
      temperature: 0.1,
      maxTokens: 4096,
      jsonMode: true,
    });
    result = {
      content: typeof geminiResult === 'string' ? geminiResult : geminiResult.content || '',
    };
  } catch (e) {
    console.warn('Gemini failed for gap identification, retrying:', e.message);
    const retryResult = await callGemini(gapPrompt, {
      maxTokens: 4096,
      jsonMode: true,
      temperature: 0.1,
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
        const searchQuery =
          String(gap.searchQuery || '').trim() ||
          `${country} ${_industry || 'industry'} ${area} latest official data and specific numbers`;
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
        searchQuery: `${country} ${_industry || 'industry'} official statistics regulations competitors market size latest`,
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
        const searchQuery =
          String(item.searchQuery || '').trim() ||
          `${country} ${claim} official source verification`;
        return {
          claim,
          searchQuery,
          currentConfidence: item.currentConfidence || 'low',
          _normalized: true,
        };
      })
      .filter(Boolean);

    // Normalize section scores so downstream logic never sees unknown placeholders.
    const sectionKeys = ['policy', 'market', 'competitors', 'summary'];
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

    // Log detailed scoring
    const scores = gaps.sectionScores || {};
    const policyScore = Number.isFinite(scores.policy?.score) ? scores.policy.score : 0;
    const marketScore = Number.isFinite(scores.market?.score) ? scores.market.score : 0;
    const competitorScore = Number.isFinite(scores.competitors?.score)
      ? scores.competitors.score
      : 0;
    console.log(
      `    Section Scores: Policy=${policyScore}, Market=${marketScore}, Competitors=${competitorScore}`
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
          searchQuery: `${country} ${_industry || 'industry'} official market size regulations competitors latest`,
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
  const MIN_GAP_FINDING_CHARS = 1200;
  const MIN_VERIFY_FINDING_CHARS = 600;
  const MIN_FINDING_CITATIONS = 2;

  // Research critical gaps with Gemini
  const criticalGaps = gaps.criticalGaps || [];
  for (const gap of criticalGaps.slice(0, 4)) {
    // Limit to 4 most critical
    if (!gap.searchQuery) continue;
    console.log(`    Gap search: ${gap.gap.substring(0, 50)}...`);

    const result = await callGeminiResearch(gap.searchQuery, country, industry);
    const contentLength = (result.content || '').length;
    const citationsCount = Array.isArray(result.citations) ? result.citations.length : 0;
    const usableGapFinding =
      contentLength >= MIN_GAP_FINDING_CHARS || citationsCount >= MIN_FINDING_CITATIONS;
    if (result.content && usableGapFinding) {
      additionalData.gapResearch.push({
        area: gap.area,
        gap: gap.gap,
        query: gap.searchQuery,
        findings: result.content,
        citations: result.citations || [],
      });
    } else if (result.content) {
      console.warn(
        `    Gap search returned thin content (${contentLength} chars, ${citationsCount} citations) — skipping low-signal result`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Verify questionable claims with Gemini
  const toVerify = gaps.dataToVerify || [];
  for (const item of toVerify.slice(0, 2)) {
    // Limit to 2 verifications
    if (!item.searchQuery) continue;
    console.log(`    Verify: ${item.claim.substring(0, 50)}...`);

    const result = await callGeminiResearch(item.searchQuery, country, industry);
    const contentLength = (result.content || '').length;
    const citationsCount = Array.isArray(result.citations) ? result.citations.length : 0;
    const usableVerification =
      contentLength >= MIN_VERIFY_FINDING_CHARS || citationsCount >= MIN_FINDING_CITATIONS;
    if (result.content && usableVerification) {
      additionalData.verificationResearch.push({
        claim: item.claim,
        query: item.searchQuery,
        findings: result.content,
        citations: result.citations || [],
      });
    } else if (result.content) {
      console.warn(
        `    Verification returned thin content (${contentLength} chars, ${citationsCount} citations) — skipping low-signal result`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
  if (company && (!company.description || company.description.length < 30)) {
    company.description = company.description
      ? company.description + ' Details pending further research.'
      : 'Details pending further research.';
  }
  return company;
}

/**
 * Validate and apply honest fallbacks to competitors synthesis
 * Returns the result with fallbacks applied, logs warnings for missing data
 */
function validateCompetitorsSynthesis(result) {
  if (!result) return result;

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

  const sections = ['japanesePlayers', 'localMajor', 'foreignPlayers'];
  const warnings = [];

  for (const section of sections) {
    const players = result[section]?.players || [];
    if (players.length === 0) {
      warnings.push(`${section}: no players found`);
    }
    // Apply honest fallbacks to each player
    players.forEach((player) => {
      ensureHonestWebsite(player);
      ensureHonestDescription(player);
    });
  }

  if (warnings.length > 0) {
    console.log(`  [Synthesis] Competitor warnings: ${warnings.join('; ')}`);
  }

  return result;
}

/**
 * Validate and apply honest fallbacks to market synthesis
 * Returns the result with fallbacks applied
 */
function validateMarketSynthesis(result) {
  if (!result) return result;

  // A3: If AI returned an array instead of object, convert to keyed sections
  if (Array.isArray(result)) {
    console.log(
      `  [Synthesis] Market result was array (len=${result.length}), converting to object`
    );
    const obj = {};
    result.forEach((item, i) => {
      if (item && typeof item === 'object') {
        obj[`section_${i}`] = item;
      }
    });
    result = obj;
  }

  // Dynamically discover sections (supports both legacy energy keys and dynamic section_N keys)
  const sections = Object.keys(result).filter(
    (k) => !k.startsWith('_') && typeof result[k] === 'object' && result[k] !== null
  );
  let chartCount = 0;

  for (const section of sections) {
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
        result[section].keyInsight = 'Analysis pending additional research.';
      }
    }
  }

  if (chartCount < 2) {
    console.log(`  [Synthesis] Market warning: only ${chartCount} sections have valid chart data`);
  }

  return result;
}

/**
 * Validate and apply honest fallbacks to policy synthesis
 */
function validatePolicySynthesis(result) {
  if (!result) return result;

  const acts = result.foundationalActs?.acts || [];
  if (acts.length < 2) {
    console.log(`  [Synthesis] Policy warning: only ${acts.length} regulations found`);
  }

  // Ensure each act has required fields with honest fallbacks
  acts.forEach((act) => {
    if (!act.enforcement) {
      act.enforcement = 'Enforcement status pending verification.';
    }
  });

  return result;
}

/**
 * Repair policy payloads when the model returns array-wrapped sections.
 * Converts {section_0: {...}, _wasArray:true} into expected policy keys when possible.
 */
function normalizePolicySynthesisResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;

  const normalized = { ...result };
  const sectionEntries = Object.entries(normalized).filter(
    ([key, value]) =>
      /^section_\d+$/.test(key) && value && typeof value === 'object' && !Array.isArray(value)
  );

  for (const [, section] of sectionEntries) {
    if (!section || typeof section !== 'object') continue;

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
  }

  return normalized;
}

/**
 * Synthesize with 5-tier fallback chain:
 * 1. Gemini jsonMode → 2. Truncation repair → 3. Gemini no-jsonMode + boosted tokens
 * → 4. GeminiPro jsonMode → 5. GeminiPro no-jsonMode
 */
async function synthesizeWithFallback(prompt, options = {}) {
  const { maxTokens = 8192, jsonMode = true } = options;
  const strictSuffix =
    '\n\nCRITICAL: Return ONLY valid JSON. No markdown. No explanation. No trailing text. Just the raw JSON object. Use null for missing fields.';

  // Helper: convert array responses to object with _wasArray flag
  function ensureObject(val) {
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

  // Tier 1: callGemini jsonMode (fast path)
  try {
    const result = await callGemini(prompt, { maxTokens, jsonMode, temperature: 0.2 });
    const text = typeof result === 'string' ? result : result?.content || '';
    try {
      const parsed = parseJsonResponse(text);
      if (parsed) {
        console.log('  [Synthesis] Tier 1 (Gemini jsonMode) succeeded');
        return ensureObject(parsed);
      }
    } catch (parseErr) {
      // Tier 2: Truncation repair on raw text
      console.warn(`  [Synthesis] Tier 1 parse failed: ${parseErr?.message}`);
      if (text && isJsonTruncated(text)) {
        console.log('  [Synthesis] Tier 2: Detected truncation, attempting repair...');
        try {
          const repaired = repairTruncatedJson(text);
          const extractResult = extractJsonFromContent(repaired);
          if (extractResult.status === 'success' && extractResult.data) {
            console.log('  [Synthesis] Tier 2 (truncation repair) succeeded');
            return ensureObject(extractResult.data);
          }
        } catch (repairErr) {
          console.warn(`  [Synthesis] Tier 2 repair failed: ${repairErr?.message}`);
        }
      }
      // Also try multi-strategy extraction on raw text
      const extractResult = extractJsonFromContent(text);
      if (extractResult.status === 'success' && extractResult.data) {
        console.log('  [Synthesis] Tier 2 (extract from raw) succeeded');
        return ensureObject(extractResult.data);
      }
    }
  } catch (geminiErr) {
    console.warn(`  [Synthesis] Tier 1 Gemini call failed: ${geminiErr?.message}`);
  }

  // Tier 3: callGemini NO jsonMode + boosted tokens (let model finish naturally)
  try {
    const boostedTokens = Math.min(Math.round(maxTokens * 1.5), 32768);
    const result = await callGemini(prompt + strictSuffix, {
      maxTokens: boostedTokens,
      jsonMode: false,
      temperature: 0.1,
    });
    const text = typeof result === 'string' ? result : result?.content || '';
    const extractResult = extractJsonFromContent(text);
    if (extractResult.status === 'success' && extractResult.data) {
      console.log('  [Synthesis] Tier 3 (Gemini no-jsonMode, boosted tokens) succeeded');
      return ensureObject(extractResult.data);
    }
    if (text && isJsonTruncated(text)) {
      const repaired = repairTruncatedJson(text);
      const repairResult = extractJsonFromContent(repaired);
      if (repairResult.status === 'success' && repairResult.data) {
        console.log('  [Synthesis] Tier 3 (repaired) succeeded');
        return ensureObject(repairResult.data);
      }
    }
  } catch (err3) {
    console.warn(`  [Synthesis] Tier 3 failed: ${err3?.message}`);
  }

  // Tier 4: callGeminiPro jsonMode (stronger model)
  try {
    const result = await callGeminiPro(prompt, { maxTokens, jsonMode, temperature: 0.2 });
    const text = typeof result === 'string' ? result : result?.content || '';
    try {
      const parsed = parseJsonResponse(text);
      if (parsed) {
        console.log('  [Synthesis] Tier 4 (GeminiPro jsonMode) succeeded');
        return ensureObject(parsed);
      }
    } catch (parseErr4) {
      console.warn(`  [Synthesis] Tier 4 parse failed: ${parseErr4?.message}`);
      const extractResult = extractJsonFromContent(text);
      if (extractResult.status === 'success' && extractResult.data) {
        console.log('  [Synthesis] Tier 4 (extract) succeeded');
        return ensureObject(extractResult.data);
      }
    }
  } catch (err4) {
    console.warn(`  [Synthesis] Tier 4 failed: ${err4?.message}`);
  }

  // Tier 5: callGeminiPro NO jsonMode (last resort, highest capability)
  try {
    const boostedTokens = Math.min(Math.round(maxTokens * 1.5), 32768);
    const result = await callGeminiPro(prompt + strictSuffix, {
      maxTokens: boostedTokens,
      jsonMode: false,
      temperature: 0.1,
    });
    const text = typeof result === 'string' ? result : result?.content || '';
    const extractResult = extractJsonFromContent(text);
    if (extractResult.status === 'success' && extractResult.data) {
      console.log('  [Synthesis] Tier 5 (GeminiPro no-jsonMode) succeeded');
      return ensureObject(extractResult.data);
    }
    if (text && isJsonTruncated(text)) {
      const repaired = repairTruncatedJson(text);
      const repairResult = extractJsonFromContent(repaired);
      if (repairResult.status === 'success' && repairResult.data) {
        console.log('  [Synthesis] Tier 5 (GeminiPro repaired) succeeded');
        return ensureObject(repairResult.data);
      }
    }
  } catch (err5) {
    console.error(`  [Synthesis] Tier 5 (final) failed: ${err5?.message}`);
  }

  return null;
}

/**
 * Mark low-confidence research data with quality labels in the prompt context.
 * Topics with dataQuality "low" or "incomplete" get prefixed so the AI model hedges appropriately.
 */
function markDataQuality(filteredData) {
  const marked = {};
  for (const [key, value] of Object.entries(filteredData)) {
    const quality = value?.dataQuality;
    if (quality === 'low' || quality === 'estimated') {
      marked[`[ESTIMATED] ${key}`] = value;
    } else if (quality === 'incomplete') {
      marked[`[UNVERIFIED] ${key}`] = value;
    } else {
      marked[key] = value;
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

  const filteredData = Object.fromEntries(
    Object.entries(researchData).filter(
      ([k]) =>
        k.startsWith('policy_') ||
        k.includes('regulation') ||
        k.includes('law') ||
        k.includes('investment')
    )
  );

  const dataAvailable = Object.keys(filteredData).length > 0;
  console.log(
    `    [Policy] Filtered research data: ${Object.keys(filteredData).length} topics (${dataAvailable ? Object.keys(filteredData).slice(0, 3).join(', ') : 'NONE'})`
  );

  const labeledData = markDataQuality(filteredData);
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
- For strings: "Insufficient research data for this field"
- For numbers: null
DO NOT fabricate data. DO NOT estimate from training knowledge.
The quality gate will handle missing data appropriately.

ANTI-PADDING RULE:
- Do NOT substitute general/macro economic data (GDP, population, inflation, general trade statistics) when industry-specific data is unavailable
- If you cannot find ${industry}-specific data for a field, use the null/empty value — do NOT fill it with country-level macro data
- Example: If asked for "${industry} market size" and you only know "Thailand GDP is $500B" — return null, not the GDP figure
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
  const MAX_POLICY_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_POLICY_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`  [synthesizePolicy] Retry ${attempt}: enforcing object schema`);
    }

    const currentPrompt = attempt === 0 ? prompt : prompt + antiArraySuffix;
    let currentResult = await synthesizeWithFallback(currentPrompt, { maxTokens: 10240 });

    if (!currentResult) {
      console.warn(`  [synthesizePolicy] Attempt ${attempt} returned null`);
      continue;
    }

    currentResult = normalizePolicySynthesisResult(currentResult);

    if (currentResult._wasArray) {
      console.warn(
        `  [synthesizePolicy] Attempt ${attempt} returned array (tagged _wasArray), retrying...`
      );
      if (attempt === MAX_POLICY_RETRIES) {
        console.warn('  [synthesizePolicy] All retries exhausted, accepting array conversion');
        delete currentResult._wasArray;
        policyResult = currentResult;
        break;
      }
      continue;
    }

    const sectionCount = ['foundationalActs', 'nationalPolicy', 'investmentRestrictions'].filter(
      (key) => currentResult[key] && typeof currentResult[key] === 'object'
    ).length;

    if (sectionCount < 2) {
      console.warn(
        `  [synthesizePolicy] Attempt ${attempt}: only ${sectionCount} expected section(s), retrying...`
      );
      if (attempt === MAX_POLICY_RETRIES) {
        console.warn('  [synthesizePolicy] All retries exhausted, accepting partial result');
        policyResult = currentResult;
        break;
      }
      continue;
    }

    policyResult = currentResult;
    if (attempt > 0) {
      console.log(`  [synthesizePolicy] Succeeded on retry ${attempt}`);
    }
    break;
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

  const filteredData = Object.fromEntries(
    Object.entries(researchData).filter(([k]) => k.startsWith('market_'))
  );

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

  // Build dynamic schema from research topic names
  // Generate camelCase keys from topic names for better downstream mapping
  // e.g. "Market Size & Growth" → "marketSizeGrowth"
  function topicToKey(topic) {
    return topic
      .replace(/&/g, 'And')
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .map((word, idx) =>
        idx === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      )
      .join('');
  }

  const sectionSchemas = uniqueTopics.map((topic, i) => {
    const key = topicToKey(topic) || `section_${i}`;
    return `  "${key}": {
    "slideTitle": "${country} - ${topic}",
    "subtitle": "THESIS STATEMENT (100-180 chars): the key strategic takeaway for the client. NOT a description — a conclusion. Example: 'Rapid industrialization is driving 12% annual demand growth, creating a $2.1B addressable market for efficiency services'",
    "overview": "2-3 sentence strategic overview of this topic. Frame in terms of client implications, not just facts.",
    "keyMetrics": [{"metric": "Named metric", "value": "Specific value from data", "context": "Why this matters"}],
    "chartData": null,
    "keyInsight": "What this means for client",
    "dataType": "time_series_multi_insight",
    "sources": [{"url": "https://example.com/source", "title": "Source Name"}]
  }`;
  });

  const labeledData = markDataQuality(filteredData);
  const researchContext = dataAvailable
    ? `RESEARCH DATA (use this as primary source — items prefixed [ESTIMATED] or [UNVERIFIED] are uncertain, hedge accordingly):
${JSON.stringify(labeledData, null, 2)}`
    : `RESEARCH DATA: EMPTY due to API issues.`;

  const storyInstructions = getStoryInstructions(storyPlan, 'market');
  const prompt = `You are synthesizing market data research for ${country}'s ${industry} market.
Client context: ${clientContext}
${SYNTHESIS_STYLE_GUIDE}${storyInstructions}
${researchContext}

If research data is insufficient for a field, set the value to:
- For arrays: empty array []
- For strings: "Insufficient research data for this field"
- For numbers: null
DO NOT fabricate data. DO NOT estimate from training knowledge.
The quality gate will handle missing data appropriately.

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
    '\n\nCRITICAL: Your response MUST be a JSON OBJECT with curly braces {}, NOT a JSON array []. The top-level structure must be { "section_0": {...}, "section_1": {...}, ... }. Arrays will be rejected.';

  let marketResult = null;
  const MAX_MARKET_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_MARKET_RETRIES; attempt++) {
    let currentResult;

    if (attempt === 0) {
      // Normal synthesis (Flash)
      currentResult = await synthesizeWithFallback(prompt, { maxTokens: 16384 });
    } else if (attempt === 1) {
      // Flash with anti-array prompt
      console.log(`  [synthesizeMarket] Retry ${attempt}: Flash with anti-array prompt`);
      currentResult = await synthesizeWithFallback(prompt + antiArraySuffix, { maxTokens: 16384 });
    } else if (attempt === 2) {
      // Pro with anti-array prompt
      console.log(`  [synthesizeMarket] Retry ${attempt}: Pro model with anti-array prompt`);
      const proResult = await callGeminiPro(prompt + antiArraySuffix, {
        maxTokens: 16384,
        jsonMode: true,
        temperature: 0.1,
      });
      const proText = typeof proResult === 'string' ? proResult : proResult?.content || '';
      try {
        currentResult = parseJsonResponse(proText);
      } catch {
        const extracted = extractJsonFromContent(proText);
        currentResult = extracted.status === 'success' ? extracted.data : null;
      }
    } else {
      // Pro jsonMode, minimal prompt, near-zero temp
      console.log(`  [synthesizeMarket] Retry ${attempt}: Pro model minimal prompt, temp 0.05`);
      const minimalPrompt = `Return a JSON object (NOT array) with keys section_0, section_1, etc. Each section has: slideTitle, subtitle, overview, keyMetrics, chartData, keyInsight, dataType.\n\nData:\n${JSON.stringify(labeledData, null, 2)}\n\n${antiArraySuffix}`;
      const proResult = await callGeminiPro(minimalPrompt, {
        maxTokens: 16384,
        jsonMode: true,
        temperature: 0.05,
      });
      const proText = typeof proResult === 'string' ? proResult : proResult?.content || '';
      try {
        currentResult = parseJsonResponse(proText);
      } catch {
        const extracted = extractJsonFromContent(proText);
        currentResult = extracted.status === 'success' ? extracted.data : null;
      }
    }

    if (!currentResult) {
      console.warn(`  [synthesizeMarket] Attempt ${attempt} returned null`);
      continue;
    }

    // Check if it was tagged as array by ensureObject
    if (currentResult._wasArray) {
      console.warn(
        `  [synthesizeMarket] Attempt ${attempt} returned array (tagged _wasArray), retrying...`
      );
      if (attempt === MAX_MARKET_RETRIES) {
        // Last attempt — accept the array conversion
        console.warn('  [synthesizeMarket] All retries exhausted, accepting array conversion');
        delete currentResult._wasArray;
        marketResult = currentResult;
        break;
      }
      continue;
    }

    // Check sub-section count >= 2
    const sectionKeys = Object.keys(currentResult).filter(
      (k) => !k.startsWith('_') && typeof currentResult[k] === 'object' && currentResult[k] !== null
    );
    if (sectionKeys.length < 2) {
      console.warn(
        `  [synthesizeMarket] Attempt ${attempt}: only ${sectionKeys.length} sub-sections (need >= 2), retrying...`
      );
      if (attempt === MAX_MARKET_RETRIES) {
        console.warn('  [synthesizeMarket] All retries exhausted, accepting thin result');
        marketResult = currentResult;
        break;
      }
      continue;
    }

    // Good result
    marketResult = currentResult;
    if (attempt > 0) {
      console.log(`  [synthesizeMarket] Succeeded on retry ${attempt}`);
    }
    break;
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

  const filteredData = Object.fromEntries(
    Object.entries(researchData).filter(([k]) => k.startsWith('competitors_'))
  );

  const dataAvailable = Object.keys(filteredData).length > 0;
  console.log(
    `    [Competitors] Filtered research data: ${Object.keys(filteredData).length} topics (${dataAvailable ? Object.keys(filteredData).slice(0, 3).join(', ') : 'NONE'})`
  );

  const labeledData = markDataQuality(filteredData);
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
- For strings: "Insufficient research data for this field"
- For numbers: null
DO NOT fabricate data. DO NOT estimate from training knowledge.
The quality gate will handle missing data appropriately.

ANTI-PADDING RULE:
- Do NOT substitute general/macro economic data (GDP, population, inflation, general trade statistics) when industry-specific data is unavailable
- If you cannot find ${industry}-specific data for a field, use the null/empty value — do NOT fill it with country-level macro data
- Example: If asked for "${industry} market size" and you only know "Thailand GDP is $500B" — return null, not the GDP figure
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

  console.log('    [Competitors] Running 4 parallel synthesis calls...');
  const [r1, r2, r3, r4] = await Promise.all([
    synthesizeWithFallback(prompt1, { maxTokens: 8192 }),
    synthesizeWithFallback(prompt2, { maxTokens: 8192 }),
    synthesizeWithFallback(prompt3, { maxTokens: 8192 }),
    synthesizeWithFallback(prompt4, { maxTokens: 8192 }),
  ]);

  const merged = {};
  for (let r of [r1, r2, r3, r4]) {
    if (!r) continue;
    // B1: Unwrap arrays — AI sometimes returns [{...}] instead of {...}
    if (Array.isArray(r)) {
      r = r.length === 1 ? r[0] : Object.assign({}, ...r);
    }
    if (r && typeof r === 'object') Object.assign(merged, r);
  }

  if (Object.keys(merged).length === 0) {
    console.error('  [synthesizeCompetitors] All parallel synthesis calls failed');
    return {
      _synthesisError: true,
      section: 'competitors',
      message: 'All synthesis attempts failed',
    };
  }

  console.log(
    `    [Competitors] Merged ${Object.keys(merged).length} sections: ${Object.keys(merged).join(', ')}`
  );
  const validated = validateCompetitorsSynthesis(merged);
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
  clientContext
) {
  console.log(`  [Synthesis] Summary & recommendations for ${country}...`);

  const prompt = `You are creating the strategic summary and recommendations for ${country}'s ${industry} market.
Client context: ${clientContext}

SYNTHESIZED SECTIONS (already processed):
Policy: ${summarizeForSummary(policy, 'policy', 6000)}
Market: ${summarizeForSummary(market, 'market', 8000)}
Competitors: ${summarizeForSummary(competitors, 'competitors', 6000)}

Additional research context:
${Object.entries(researchData)
  .filter(
    ([k]) =>
      k.startsWith('opportunities_') ||
      k.startsWith('risks_') ||
      k.startsWith('depth_') ||
      k.startsWith('insight_')
  )
  .map(([k, v]) => `${k}: ${(v?.content || '').substring(0, 2000)}`)
  .join('\n')}

If research data is insufficient for a field, set the value to:
- For arrays: empty array []
- For strings: "Insufficient research data for this field"
- For numbers: null
DO NOT fabricate data. DO NOT estimate from training knowledge.
The quality gate will handle missing data appropriately.

ANTI-PADDING RULE:
- Do NOT substitute general/macro economic data (GDP, population, inflation, general trade statistics) when industry-specific data is unavailable
- If you cannot find ${industry}-specific data for a field, use the null/empty value — do NOT fill it with country-level macro data
- Example: If asked for "${industry} market size" and you only know "Thailand GDP is $500B" — return null, not the GDP figure
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

  const result = await synthesizeWithFallback(prompt, { maxTokens: 16384 });
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
  return result;
}

/**
 * Validate content depth before allowing PPT generation
 * Returns { valid: boolean, failures: string[], scores: {} }
 */
function validateContentDepth(synthesis) {
  const failures = [];
  const scores = { policy: 0, market: 0, competitors: 0, overall: 0 };

  // Policy check: ≥3 named regulations with years
  const policy = synthesis.policy || {};
  const acts = (policy.foundationalActs?.acts || []).filter((a) => a.name && a.year);
  const targets = policy.nationalPolicy?.targets || [];
  if (acts.length >= 3) scores.policy += 40;
  else if (acts.length >= 1) scores.policy += 20;
  else failures.push(`Policy: only ${acts.length} named regulations (need ≥3)`);
  if (targets.length >= 2) scores.policy += 30;
  if (policy.investmentRestrictions?.incentives?.length >= 1) scores.policy += 30;

  // Market check: ≥3 data series with ≥3 points (dynamic section discovery)
  const market = synthesis.market || {};
  const marketSections = Object.keys(market).filter(
    (k) => !k.startsWith('_') && typeof market[k] === 'object' && market[k] !== null
  );
  let seriesCount = 0;
  for (const section of marketSections) {
    const chartData = market[section]?.chartData;
    if (chartData) {
      if (chartData.series && Array.isArray(chartData.series)) {
        const validSeries = chartData.series.filter(
          (s) => Array.isArray(s.values) && s.values.length >= 3
        );
        seriesCount += validSeries.length;
      } else if (
        chartData.values &&
        Array.isArray(chartData.values) &&
        chartData.values.length >= 3
      ) {
        seriesCount++;
      }
    }
  }
  if (seriesCount >= 3) scores.market = 70;
  else if (seriesCount >= 1) scores.market = 40;
  else failures.push(`Market: only ${seriesCount} valid data series (need ≥3)`);
  // Bonus points if any section has market size data
  const hasMarketSize = marketSections.some((s) => market[s]?.marketSize);
  if (hasMarketSize) scores.market += 30;

  // Competitors check: ≥3 companies with details AND word count validation (45-60 words)
  const competitors = synthesis.competitors || {};
  let totalCompanies = 0;
  let thinDescriptions = 0;
  let longDescriptions = 0;
  for (const section of ['japanesePlayers', 'localMajor', 'foreignPlayers']) {
    const players = competitors[section]?.players || [];
    totalCompanies += players.filter((p) => p.name && (p.revenue || p.description)).length;
    // Validate description word count (45-60 words per prompt)
    for (const player of players) {
      if (player.description) {
        const wordCount = player.description.trim().split(/\s+/).length;
        if (wordCount < 45) thinDescriptions++;
        if (wordCount > 60) longDescriptions++; // >60 words causes overflow
      }
    }
  }
  if (totalCompanies >= 5) scores.competitors = 100;
  else if (totalCompanies >= 3) scores.competitors = 70;
  else if (totalCompanies >= 1) scores.competitors = 40;
  else failures.push(`Competitors: only ${totalCompanies} detailed companies (need ≥3)`);

  // CRITICAL: Reject if >50% of descriptions are thin or too long
  if (totalCompanies > 0 && thinDescriptions / totalCompanies > 0.5) {
    failures.push(
      `Competitors: ${thinDescriptions}/${totalCompanies} descriptions <45 words (need 45-60)`
    );
    scores.competitors = Math.min(scores.competitors, 40); // Cap score if descriptions thin
  }
  if (totalCompanies > 0 && longDescriptions > 0) {
    failures.push(
      `Competitors: ${longDescriptions}/${totalCompanies} descriptions >60 words (causes overflow, max 60)`
    );
    scores.competitors = Math.min(scores.competitors, 40);
  }

  // Strategic insights validation: check structured fields (data, implication, timing)
  const summary = synthesis.summary || {};
  const insights = summary.keyInsights || [];
  let completeInsights = 0;
  for (const insight of insights) {
    // Check structured fields: data (contains number), implication (action verb), timing (exists)
    const hasData =
      insight.data && /\$[\d,.]+[BMKbmk]?|\d+(\.\d+)?%|\d{4}|\d+(\.\d+)?x/.test(insight.data);
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

  // Partner descriptions validation (from depth.partnerAssessment)
  const depth = synthesis.summary?.depth || synthesis.depth || {};
  const partners = depth.partnerAssessment?.partners || [];
  let thinPartners = 0;
  let longPartners = 0;
  for (const partner of partners) {
    if (partner.description) {
      const wordCount = partner.description.trim().split(/\s+/).length;
      if (wordCount < 45) thinPartners++;
      if (wordCount > 60) longPartners++; // Causes overflow
    }
  }
  if (partners.length > 0 && thinPartners / partners.length > 0.5) {
    failures.push(
      `Partners: ${thinPartners}/${partners.length} descriptions <45 words (need 45-60)`
    );
  }
  if (partners.length > 0 && longPartners > 0) {
    failures.push(
      `Partners: ${longPartners}/${partners.length} descriptions >60 words (causes overflow, max 60)`
    );
  }

  scores.overall = Math.round((scores.policy + scores.market + scores.competitors) / 3);

  const valid = failures.length === 0;

  console.log(
    `  [Validation] Policy: ${scores.policy}/100 | Market: ${scores.market}/100 | Competitors: ${scores.competitors}/100 | Overall: ${scores.overall}/100`
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
${JSON.stringify(originalSynthesis, null, 2)}

NEW DATA TO INCORPORATE:

GAP RESEARCH (fills missing information):
${JSON.stringify(additionalData.gapResearch, null, 2)}

VERIFICATION RESEARCH (confirms or corrects claims):
${JSON.stringify(additionalData.verificationResearch, null, 2)}

DO NOT fabricate data. DO NOT estimate from training knowledge. Use null or empty arrays for missing data.

YOUR TASK:
1. UPDATE the original analysis with the new data
2. CORRECT any claims that verification proved wrong
3. ADD DEPTH where gaps have been filled
4. FLAG remaining uncertainties with "estimated" or "unverified"

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

  let result;
  try {
    result = await callGemini(prompt, { maxTokens: 16384, temperature: 0.3 });
  } catch (e) {
    console.warn('Gemini failed for reSynthesize, retrying with GeminiPro:', e.message);
    result = await callGeminiPro(prompt, { maxTokens: 16384, temperature: 0.3 });
  }

  try {
    // Handle both string and object returns
    const rawText = typeof result === 'string' ? result : result.content || '';
    let jsonStr = rawText.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    let newSynthesis;
    try {
      newSynthesis = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Attempt truncation repair before giving up
      console.warn(
        `  [reSynthesize] JSON parse failed, attempting truncation repair: ${parseErr?.message}`
      );
      const repaired = repairTruncatedJson(jsonStr);
      newSynthesis = JSON.parse(repaired);
      console.log('  [reSynthesize] Truncation repair succeeded');
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
      if (hasPolicy) originalSynthesis.policy = newSynthesis.policy;
      if (hasMarket) originalSynthesis.market = validateMarketSynthesis(newSynthesis.market);
      if (hasCompetitors) originalSynthesis.competitors = newSynthesis.competitors;
      if (newSynthesis.depth && typeof newSynthesis.depth === 'object')
        originalSynthesis.depth = newSynthesis.depth;
      if (newSynthesis.summary && typeof newSynthesis.summary === 'object')
        originalSynthesis.summary = newSynthesis.summary;
      originalSynthesis.country = country;
      return originalSynthesis;
    }

    // Ensure depth and summary sections are preserved — if AI dropped them, recover from original
    if (
      originalSynthesis.depth &&
      typeof originalSynthesis.depth === 'object' &&
      !newSynthesis.depth
    ) {
      console.warn(
        '  [reSynthesize] depth section missing from re-synthesis — recovering from original'
      );
      newSynthesis.depth = originalSynthesis.depth;
    }
    if (
      originalSynthesis.summary &&
      typeof originalSynthesis.summary === 'object' &&
      !newSynthesis.summary
    ) {
      console.warn(
        '  [reSynthesize] summary section missing from re-synthesis — recovering from original'
      );
      newSynthesis.summary = originalSynthesis.summary;
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
    // Validate market data before returning (defense against array responses in re-synthesis)
    if (newSynthesis.market) {
      newSynthesis.market = validateMarketSynthesis(newSynthesis.market);
    }
    return newSynthesis;
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

  // Build condensed summary per topic for reviewer
  const topicSummaries = {};
  for (const [key, value] of Object.entries(researchData)) {
    topicSummaries[key] = {
      name: value.name || key,
      dataQuality: value.dataQuality || 'unknown',
      extractionStatus: value.extractionStatus || 'unknown',
      citationCount: (value.citations || []).length,
      structuredData: value.structuredData || null,
      contentPreview: value.structuredData ? null : (value.content || '').substring(0, 4000),
      hasChartData: !!value.structuredData?.chartData,
    };
  }

  const reviewPrompt = `You are a research quality reviewer for a ${scope.projectType} project on ${scope.industry} in ${country}.
Client context: ${scope.clientContext || 'Not specified'}

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
- Focus on what makes the BIGGEST difference to report quality
- type field helps the deepen stage understand what KIND of research to do

Return ONLY valid JSON.`;

  try {
    const result = await callGeminiPro(reviewPrompt, {
      temperature: 0.1,
      maxTokens: 8192,
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

async function deepenResearch(gapReport, country, industry, pipelineSignal, maxQueries = 20) {
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
      searchQuery: gap.searchQuery,
      gapType: gap.type,
    })),
    ...verifications.map((v) => ({
      id: v.id,
      type: 'verification',
      category: 'verification',
      topic: v.source_topic,
      description: v.claim,
      searchQuery: v.searchQuery,
      gapType: 'verification',
    })),
  ];

  // Run all in parallel with per-query timeout
  const results = await Promise.all(
    allQueries.map(async (query) => {
      try {
        const result = await Promise.race([
          callGeminiResearch(query.searchQuery, country, industry, pipelineSignal),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Deepen query "${query.id}" timed out`)), 120000)
          ),
        ]);

        console.log(`    [DEEPEN] ${query.id}: ${(result.content || '').length} chars`);

        return {
          ...query,
          content: result.content || '',
          citations: result.citations || [],
          researchQuality: result.researchQuality || 'unknown',
          success: !!(result.content && result.content.length > 200),
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
    })
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
  const policyPreview = summarizeForSummary(countryAnalysis.policy, 'policy', 6000);
  const marketPreview = summarizeForSummary(countryAnalysis.market, 'market', 6000);
  const competitorsPreview = summarizeForSummary(countryAnalysis.competitors, 'competitors', 6000);
  const summaryPreview = summarizeForSummary(countryAnalysis.summary, 'summary', 4000);
  const depthPreview = summarizeForSummary(countryAnalysis.depth, 'depth', 4000);

  const reviewPrompt = `You are a senior partner at McKinsey doing a FINAL quality review of a market entry report for ${industry} in ${country} before it goes to the client CEO.

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
    "summary": "specific instruction to improve summary section, or null if good"
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
- "escalation" tells the system what kind of fix is needed:
  - "research": data is MISSING — need to go back and search the web for it
  - "synthesis": data EXISTS in research but synthesis didn't use it — re-synthesize
  - "none": minor wording issue — no re-work needed
- "researchGaps": data the report NEEDS but DOESN'T HAVE — max 10, each with a concrete searchQuery including "${country}"
- Return ONLY valid JSON.`;

  try {
    const result = await callGeminiPro(reviewPrompt, {
      temperature: 0.1,
      maxTokens: 8192,
      jsonMode: true,
    });

    const text = typeof result === 'string' ? result : result.content || '';
    const extracted = extractJsonFromContent(text);

    if (extracted.status !== 'success' || !extracted.data) {
      console.warn('  [FINAL REVIEW] Failed to parse review output');
      return null;
    }

    const review = extracted.data;
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

  // Re-synthesize flagged sections in parallel
  const fixPromises = sectionsToFix.map(async ([section, instruction]) => {
    try {
      const fixContext = `${clientContext || ''}\n\nFINAL REVIEW FEEDBACK — MUST ADDRESS:\n${instruction}`;

      if (section === 'policy') {
        return {
          section,
          result: await synthesizePolicy(researchData, country, industry, fixContext, storyPlan),
        };
      } else if (section === 'market') {
        return {
          section,
          result: await synthesizeMarket(researchData, country, industry, fixContext, storyPlan),
        };
      } else if (section === 'competitors') {
        return {
          section,
          result: await synthesizeCompetitors(
            researchData,
            country,
            industry,
            fixContext,
            storyPlan
          ),
        };
      } else if (section === 'summary') {
        // Summary depends on other sections, re-synthesize with updated data
        const summaryResult = await synthesizeSummary(
          researchData,
          countryAnalysis.policy,
          countryAnalysis.market,
          countryAnalysis.competitors,
          country,
          industry,
          fixContext
        );
        return {
          section: 'summary',
          result: summaryResult.summary || summaryResult,
          depth: summaryResult.depth || null,
        };
      }
      return null;
    } catch (err) {
      console.warn(`  [FINAL REVIEW] Failed to fix ${section}: ${err.message}`);
      return null;
    }
  });

  const results = await Promise.all(fixPromises);

  for (const fix of results) {
    if (fix && fix.result && !fix.result._synthesisError) {
      countryAnalysis[fix.section] = fix.result;
      // synthesizeSummary returns { depth, summary } — update depth too if present
      if (fix.section === 'summary' && fix.depth) {
        countryAnalysis.depth = fix.depth;
      }
      console.log(`  [FINAL REVIEW] Fixed: ${fix.section}`);
    }
  }

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
      `  [DYNAMIC FRAMEWORK] Launching ${categoryCount} research agents with ${totalTopics} topics for ${scope.industry}...`
    );

    // Run all categories in parallel
    const categoryPromises = Object.entries(dynamicFramework).map(([category, data]) =>
      universalResearchAgent(
        category,
        data.topics || [],
        country,
        industry,
        clientContext,
        scope.projectType,
        pipelineSignal
      )
    );

    // Timeout wrapper: abort if research takes >5 minutes total
    let categoryResults;
    try {
      categoryResults = await Promise.race([
        Promise.all(categoryPromises),
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

    const [policyData, marketData, competitorData, contextData, depthData, insightsData] =
      await Promise.all([
        policyResearchAgent(country, industry, clientContext, pipelineSignal),
        marketResearchAgent(country, industry, clientContext, pipelineSignal),
        competitorResearchAgent(country, industry, clientContext, pipelineSignal),
        contextResearchAgent(country, industry, clientContext, pipelineSignal),
        depthResearchAgent(country, industry, clientContext, pipelineSignal),
        insightsResearchAgent(country, industry, clientContext, pipelineSignal),
      ]);

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
      `\n  [AGENTS COMPLETE] ${totalTopics} topics researched in ${researchTime}s (parallel execution)`
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
  const REVIEW_DEEPEN_MAX_ITERATIONS = 3;
  const REVIEW_DEEPEN_TARGET_SCORE = 80;
  let reviewDeepenIteration = 0;
  let lastCoverageScore = 0;

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

      lastCoverageScore = gapReport?.coverageScore || 0;

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
        20
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

  // Run policy, market, and competitor synthesis in parallel
  const [policySynthesis, marketSynthesis, competitorsSynthesis] = await Promise.all([
    synthesizePolicy(researchData, country, industry, clientContext, storyPlan),
    synthesizeMarket(researchData, country, industry, clientContext, storyPlan),
    synthesizeCompetitors(researchData, country, industry, clientContext, storyPlan),
  ]);

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

  const MAX_ITERATIONS = 5; // Up to 5 refinement passes for higher quality
  const MIN_CONFIDENCE_SCORE = 80; // Minimum score to stop refinement
  let iteration = 0;
  let confidenceScore = 0;
  let readyForClient = false;
  let lastCodeGateScore = 0;
  let lastEffectiveScore = 0;

  while (iteration < MAX_ITERATIONS && !readyForClient) {
    if (countryAnalysis.aborted) break;
    iteration++;
    console.log(`\n  [REFINEMENT ${iteration}/${MAX_ITERATIONS}] Analyzing quality...`);

    // Step 1: Score and identify gaps in current analysis
    const gaps = await identifyResearchGaps(countryAnalysis, country, industry);
    confidenceScore = gaps.overallScore || gaps.confidenceAssessment?.numericConfidence || 50;
    readyForClient = gaps.confidenceAssessment?.readyForClient || false;

    // Store scores in analysis for tracking
    countryAnalysis.qualityScores = gaps.sectionScores;
    countryAnalysis.confidenceScore = confidenceScore;

    // If ready for client or high confidence score, we're done
    const codeGateResult = validateContentDepth({ ...countryAnalysis, country });
    const codeGateScore = codeGateResult.scores?.overall || 0;
    const codeGateFailures = codeGateResult.failures || [];
    const effectiveScore = Math.min(confidenceScore, codeGateScore);
    lastCodeGateScore = codeGateScore;
    lastEffectiveScore = effectiveScore;
    if (effectiveScore >= MIN_CONFIDENCE_SCORE) {
      console.log(
        `    ✓ Quality threshold met (AI: ${confidenceScore}, Gate: ${codeGateScore}, Effective: ${effectiveScore}/100) - analysis ready`
      );
      break;
    }

    const criticalGapCount = (gaps.criticalGaps || []).filter((g) => g.priority === 'high').length;
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
  const FINAL_REVIEW_MAX_ITERATIONS = 5;
  const FINAL_REVIEW_TARGET_SCORE = 80;

  if (!countryAnalysis.aborted) {
    let finalReviewIteration = 0;
    let lastCoherenceScore = 0;

    try {
      while (finalReviewIteration < FINAL_REVIEW_MAX_ITERATIONS) {
        finalReviewIteration++;
        console.log(
          `\n  [FINAL REVIEW ${finalReviewIteration}/${FINAL_REVIEW_MAX_ITERATIONS}] Reviewing complete output...`
        );

        const finalReview = await finalReviewSynthesis(countryAnalysis, country, industry);
        countryAnalysis.finalReview = finalReview;
        lastCoherenceScore = finalReview?.coherenceScore || 0;

        // Exit: coherence score meets target
        if (lastCoherenceScore >= FINAL_REVIEW_TARGET_SCORE) {
          console.log(
            `  [FINAL REVIEW] Coherence ${lastCoherenceScore}/100 >= ${FINAL_REVIEW_TARGET_SCORE}. Done.`
          );
          break;
        }

        if (!finalReview) {
          console.log('  [FINAL REVIEW] Review returned null, proceeding.');
          break;
        }

        const criticalOrMajor = (finalReview.issues || []).filter(
          (i) => i.severity === 'critical' || i.severity === 'major'
        );

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
        let researchDataDeepened = false;
        const deepenedTargetSections = new Set();
        if (finalReview.researchGaps && finalReview.researchGaps.length > 0) {
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
              searchQuery: g.searchQuery,
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
            10
          );

          if (deepenedResults.length > 0) {
            researchData = mergeDeepened(researchData, deepenedResults);
            researchDataDeepened = true;
            console.log(
              `  [FINAL REVIEW → RESEARCH] +${deepenedResults.length} topics added to research data`
            );
          }
        }

        // ESCALATION 2: Synthesis fixes → re-synthesize flagged sections (Reviewer 2 power)
        // Also trigger if research data was deepened — new data needs re-synthesis even without sectionFixes
        const needsSynthesisFix = criticalOrMajor.length > 0 && finalReview.sectionFixes;
        const needsResearchResynth = researchDataDeepened && deepenedTargetSections.size > 0;

        if (needsSynthesisFix || needsResearchResynth) {
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
        }
      }

      console.log(
        `  [FINAL REVIEW] Completed after ${finalReviewIteration} pass(es). Final coherence: ${lastCoherenceScore}/100`
      );
    } catch (finalErr) {
      console.warn(`  [FINAL REVIEW] Loop failed, proceeding: ${finalErr.message}`);
    }
  }

  // Final readiness is the intersection of depth confidence and final-review coherence.
  const finalReview = countryAnalysis.finalReview;
  const finalCoherence = Number(finalReview?.coherenceScore) || 0;
  const finalCritical = (finalReview?.issues || []).filter(
    (i) => i?.severity === 'critical'
  ).length;
  const finalMajor = (finalReview?.issues || []).filter((i) => i?.severity === 'major').length;
  const confidenceReady = (countryAnalysis.finalConfidenceScore || 0) >= MIN_CONFIDENCE_SCORE;
  const codeGateReady = (lastCodeGateScore || 0) >= MIN_CONFIDENCE_SCORE;
  const reviewReady =
    !finalReview || (finalCoherence >= 80 && finalCritical === 0 && finalMajor <= 1);

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
        `Final review coherence ${finalCoherence}/100 with critical=${finalCritical}, major=${finalMajor}`
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

  const systemPrompt = `You are a senior analyst at The Economist writing a market entry briefing. Your reader is a CEO - intelligent, time-poor, and needs to make a $10M+ decision based on your analysis.

=== WRITING STYLE ===
Write like The Economist: professional, direct, analytical. No consultant jargon, but also not dumbed down.

GOOD: "The 49% foreign ownership cap forces joint ventures, but BOI-promoted projects can sidestep this entirely."
BAD (too simple): "You can only own 49% so you need a partner."
BAD (too jargon): "Foreign ownership limitations necessitate strategic partnership architectures to optimize market penetration."

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
   - STRONG: "Three factors converge in 2025: (1) BOI's new incentives expire Dec 2027, (2) three large ESCOs are seeking acquisition, (3) Thailand's carbon tax starts 2026. First movers get 3 years of tax-free operation before competitors react."

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
- Example: If asked for "${scope.industry} market size" and you only know "Thailand GDP is $500B" — return null, not the GDP figure
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
    "Paragraph 1: MARKET OPPORTUNITY OVERVIEW — Quantify the prize with specific numbers: market size, growth rate, foreign player share, TAM calculation. End with '(Refer: Chapter 2)'. Example: 'Thailand's energy services market reached $320M in 2024, growing at 14% CAGR since 2020. (Refer: Chapter 2)'",
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
      "timing": "REQUIRED. When to act and why. Example: 'Move by Q2 2026 — carbon tax starts Jan 2027, BOI incentives expire Dec 2027. 18-month window for tax-free setup.'"
    },
    "Provide 3-5 insights. Each must reveal something that requires connecting multiple data points.",
    "COMPLETE CHAIN REQUIRED: data (with number + year) → pattern (causal link) → implication (action verb: 'should prioritize', 'recommend', 'target') → timing (specific deadline or window)",
    "TEST: If someone could find this insight on the first page of Google results, it's too obvious.",
    "GOOD: 'Southern Thailand's grid congestion (transmission capacity 85% utilized) blocks new solar projects, creating captive demand for on-site efficiency solutions in the $2.1B EEC industrial corridor. Recommend targeting EEC zone manufacturers in Q1 2026 before Phase 4 expansion (Dec 2026) when grid upgrades reduce urgency.'"
  ],

  "nextSteps": ["5 specific actions to take THIS WEEK with owner and deliverable"]
}

CRITICAL QUALITY STANDARDS:
1. DEPTH OVER BREADTH. One well-supported insight beats five superficial observations. Every claim needs evidence.
2. CAUSAL REASONING. Don't just describe - explain WHY. "X happened because Y, which means Z for the client."
3. SPECIFICITY. Every number needs a year. Every company needs context. Every regulation needs an enforcement reality check.
4. COMPETITIVE EDGE. The reader should learn something they couldn't find in an hour of desk research.
5. ACTIONABLE CONCLUSIONS. End each section with what the reader should DO with this information.
6. PROFESSIONAL PROSE. Write like The Economist - clear, precise, analytical. Use technical terms where they add precision, but always explain significance.
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

  let result;
  try {
    result = await callGemini(prompt, { maxTokens: 16384, temperature: 0.3, systemPrompt });
  } catch (e) {
    console.warn('Gemini failed for synthesizeSingleCountry, retrying with GeminiPro:', e.message);
    result = await callGeminiPro(prompt, { maxTokens: 16384, temperature: 0.3, systemPrompt });
  }

  let synthesis;
  try {
    const rawText = typeof result === 'string' ? result : result.content || '';
    let jsonStr = rawText.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    try {
      synthesis = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Attempt truncation repair before giving up
      console.warn(
        `  [synthesizeSingleCountry] JSON parse failed, attempting truncation repair: ${parseErr?.message}`
      );
      const repaired = repairTruncatedJson(jsonStr);
      synthesis = JSON.parse(repaired);
      console.log('  [synthesizeSingleCountry] Truncation repair succeeded');
    }
    synthesis.isSingleCountry = true;
    synthesis.country = countryAnalysis.country;
  } catch (error) {
    console.error('Failed to parse single country synthesis:', error?.message);
    const rawText = typeof result === 'string' ? result : result.content || '';
    return {
      isSingleCountry: true,
      country: countryAnalysis.country,
      executiveSummary: ['Deep analysis parsing failed - raw content available'],
      rawContent: rawText,
    };
  }

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
