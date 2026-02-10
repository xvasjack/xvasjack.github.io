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

    // Log detailed scoring
    const scores = gaps.sectionScores || {};
    console.log(
      `    Section Scores: Policy=${scores.policy?.score || '?'}, Market=${scores.market?.score || '?'}, Competitors=${scores.competitors?.score || '?'}`
    );
    console.log(
      `    Overall: ${gaps.overallScore || '?'}/100 | Confidence: ${gaps.confidenceAssessment?.overall || 'unknown'}`
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
          description: 'Research quality could not be assessed',
          severity: 'medium',
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

  // Research critical gaps with Gemini
  const criticalGaps = gaps.criticalGaps || [];
  for (const gap of criticalGaps.slice(0, 4)) {
    // Limit to 4 most critical
    if (!gap.searchQuery) continue;
    console.log(`    Gap search: ${gap.gap.substring(0, 50)}...`);

    const result = await callGeminiResearch(gap.searchQuery, country, industry);
    if (result.content) {
      additionalData.gapResearch.push({
        area: gap.area,
        gap: gap.gap,
        query: gap.searchQuery,
        findings: result.content,
        citations: result.citations || [],
      });
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
    if (result.content) {
      additionalData.verificationResearch.push({
        claim: item.claim,
        query: item.searchQuery,
        findings: result.content,
        citations: result.citations || [],
      });
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

/**
 * Synthesize POLICY section with depth requirements
 */
async function synthesizePolicy(researchData, country, industry, clientContext) {
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

  const prompt = `You are synthesizing policy and regulatory research for ${country}'s ${industry} market.
Client context: ${clientContext}

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
- Example: If asked for "ESCO market size" and you only know "Thailand GDP is $500B" — return null, not the GDP figure
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
    "subtitle": "1-2 sentences, 100-180 chars, with specific regulatory citations",
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

  const result = await synthesizeWithFallback(prompt, { maxTokens: 10240 });
  if (!result) {
    console.error('  [synthesizePolicy] Synthesis completely failed — no data returned');
    return { _synthesisError: true, section: 'policy', message: 'All synthesis attempts failed' };
  }
  const validated = validatePolicySynthesis(result);
  return validated;
}

/**
 * Synthesize MARKET section with depth requirements
 */
async function synthesizeMarket(researchData, country, industry, clientContext) {
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
  const sectionSchemas = uniqueTopics.map((topic, i) => {
    const key = `section_${i}`;
    return `  "${key}": {
    "slideTitle": "${country} - ${topic}",
    "subtitle": "Key insight from research data",
    "overview": "2-3 sentence overview of this topic based on research data",
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

  const prompt = `You are synthesizing market data research for ${country}'s ${industry} market.
Client context: ${clientContext}

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
async function synthesizeCompetitors(researchData, country, industry, clientContext) {
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

  const commonIntro = `You are synthesizing competitive intelligence for ${country}'s ${industry} market.
Client context: ${clientContext}

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
- Example: If asked for "ESCO market size" and you only know "Thailand GDP is $500B" — return null, not the GDP figure
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

Return JSON with ONLY the japanesePlayers section:
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

Return JSON with ONLY the localMajor section:
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

Return JSON with ONLY the foreignPlayers section:
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
- Example: If asked for "ESCO market size" and you only know "Thailand GDP is $500B" — return null, not the GDP figure
- Macro data is ONLY acceptable in contextual/background fields explicitly labeled as such

RULES:
- Only use data from the INPUT DATA above
- Use null for any missing fields
- Include source citations where available
- Company descriptions should be 45-60 words
- Insights must have structured fields: data (with specific numbers), pattern (causal mechanism), implication (action verb + timing)

Return JSON:
{
  "depth": {
    "escoEconomics": {
      "slideTitle": "${country} - Deal Economics",
      "subtitle": "Key insight",
      "typicalDealSize": {"min": "$XM", "max": "$YM", "average": "$ZM"},
      "contractTerms": {"duration": "X years", "savingsSplit": "Client X% / Provider Y%", "guaranteeStructure": "Type"},
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
      "segments": [{"name": "Segment", "size": "X units", "energyIntensity": "High/Med/Low", "decisionMaker": "Title", "priority": 5}],
      "topTargets": [{"company": "Name", "website": "https://...", "industry": "Sector", "energySpend": "$XM/yr", "location": "Region"}],
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
    "keyInsights": [{"title": "Non-obvious headline", "data": "Specific evidence", "pattern": "Causal mechanism", "implication": "Strategic response"}],
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

// ============ COUNTRY RESEARCH ORCHESTRATOR ============

async function researchCountry(country, industry, clientContext, scope = null) {
  console.log(`\n=== RESEARCHING: ${country} ===`);
  const startTime = Date.now();

  // AbortController for cancelling orphaned retries on pipeline error
  const pipelineController = new AbortController();
  const pipelineSignal = pipelineController.signal;

  // Use dynamic framework for universal industry support
  const useDynamicFramework = true; // Enable dynamic framework
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

  // ============ PER-SECTION GEMINI SYNTHESIS ============
  console.log(`  [Synthesizing ${country} data per-section with Gemini...]`);

  // Run policy, market, and competitor synthesis in parallel
  const [policySynthesis, marketSynthesis, competitorsSynthesis] = await Promise.all([
    synthesizePolicy(researchData, country, industry, clientContext),
    synthesizeMarket(researchData, country, industry, clientContext),
    synthesizeCompetitors(researchData, country, industry, clientContext),
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
          clientContext
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
          clientContext
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
          clientContext
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

  const MAX_ITERATIONS = 3; // Up to 3 refinement passes for higher quality
  const MIN_CONFIDENCE_SCORE = 70; // Minimum score to stop refinement
  let iteration = 0;
  let confidenceScore = 0;
  let readyForClient = false;

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
    if (effectiveScore >= MIN_CONFIDENCE_SCORE) {
      console.log(
        `    ✓ Quality threshold met (AI: ${confidenceScore}, Gate: ${codeGateScore}, Effective: ${effectiveScore}/100) - analysis ready`
      );
      break;
    }

    const criticalGapCount = (gaps.criticalGaps || []).filter((g) => g.priority === 'high').length;
    if (criticalGapCount === 0 && (gaps.dataToVerify || []).length === 0) {
      console.log(`    ✓ No actionable gaps found (score: ${confidenceScore}/100) - stopping`);
      break;
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
      console.log(`    → No additional data collected, stopping refinement`);
      break;
    }
  }

  countryAnalysis.researchTimeMs = Date.now() - startTime;
  countryAnalysis.totalIterations = iteration;
  countryAnalysis.finalConfidenceScore = confidenceScore;
  countryAnalysis.readyForClient = readyForClient || confidenceScore >= MIN_CONFIDENCE_SCORE;

  console.log(`\n  ✓ Completed ${country}:`);
  console.log(
    `    Time: ${(countryAnalysis.researchTimeMs / 1000).toFixed(1)}s | Iterations: ${iteration}`
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
- Example: If asked for "ESCO market size" and you only know "Thailand GDP is $500B" — return null, not the GDP figure
- Macro data is ONLY acceptable in contextual/background fields explicitly labeled as such

=== ANTI-PADDING VALIDATION ===
VALIDATION: Before returning, count how many times you used GDP, population, or inflation data. If more than 2 mentions in industry-specific sections (market, competitors, depth), you are padding. Remove those and replace with industry-specific data or null.`;

  // Strip rawData to save ~200K chars of prompt space
  const { rawData: _rawData, ...countryDataForPrompt } = countryAnalysis;

  const prompt = `Client: ${scope.clientContext}
Industry: ${scope.industry}
Target: ${countryAnalysis.country}

DATA GATHERED:
${JSON.stringify(countryDataForPrompt, null, 2)}

Synthesize this research into a CEO-ready briefing. Professional tone, specific data, actionable insights.

Return JSON with:

{
  "executiveSummary": [
    "4 analytical paragraphs, 3-4 sentences each (50-80 words per paragraph), Economist-style prose. NOT bullet points — full paragraphs.",
    "Paragraph 1: MARKET OPPORTUNITY OVERVIEW — Quantify the prize with specific numbers: market size, growth rate, foreign player share, TAM calculation. Example: 'Thailand's energy services market reached $320M in 2024, growing at 14% CAGR since 2020. Foreign players hold only 8% share despite controlling 45% of comparable ASEAN markets. The addressable segment for efficiency services — industrial facilities above 2MW — represents $90M annually.'",
    "Paragraph 2: REGULATORY LANDSCAPE & TRAJECTORY — Current regulatory state, key policy shifts, and where regulation is heading. Reference specific law names, enforcement realities, ownership rules, and incentive timelines. Connect regulatory trajectory to market opportunity.",
    "Paragraph 3: MARKET DEMAND & GROWTH PROJECTIONS — Demand drivers with evidence, growth projections with sources, sector-specific opportunities. Include energy price trends, infrastructure gaps, and industrial development that create demand.",
    "Paragraph 4: COMPETITIVE POSITIONING & RECOMMENDED ENTRY PATH — Competitive gaps, recommended entry mode, specific partner/target names, timeline, and first concrete action. End with a clear 'do this first' recommendation."
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
};
