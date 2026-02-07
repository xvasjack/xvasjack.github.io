const {
  callKimiChat,
  callKimiAnalysis,
  callKimiDeepResearch,
  callGemini,
} = require('./ai-clients');
const { generateResearchFramework } = require('./research-framework');
const {
  policyResearchAgent,
  marketResearchAgent,
  competitorResearchAgent,
  contextResearchAgent,
  depthResearchAgent,
  insightsResearchAgent,
  universalResearchAgent,
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

  const result = await callKimiChat(gapPrompt, '', 4096);

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
      overallScore: 40,
      criticalGaps: [],
      dataToVerify: [],
      confidenceAssessment: { overall: 'low', numericConfidence: 40, readyForClient: false },
    };
  }
}

// Step 2: Execute targeted research to fill gaps using Kimi
async function fillResearchGaps(gaps, country, industry) {
  console.log(`  [Filling research gaps for ${country} with Kimi...]`);
  const additionalData = { gapResearch: [], verificationResearch: [] };

  // Research critical gaps with Kimi
  const criticalGaps = gaps.criticalGaps || [];
  for (const gap of criticalGaps.slice(0, 4)) {
    // Limit to 4 most critical
    if (!gap.searchQuery) continue;
    console.log(`    Gap search: ${gap.gap.substring(0, 50)}...`);

    const result = await callKimiDeepResearch(gap.searchQuery, country, industry);
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

  // Verify questionable claims with Kimi
  const toVerify = gaps.dataToVerify || [];
  for (const item of toVerify.slice(0, 2)) {
    // Limit to 2 verifications
    if (!item.searchQuery) continue;
    console.log(`    Verify: ${item.claim.substring(0, 50)}...`);

    const result = await callKimiDeepResearch(item.searchQuery, country, industry);
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

  // Check for required chart data
  const sections = ['tpes', 'finalDemand', 'electricity', 'gasLng', 'pricing', 'escoMarket'];
  let chartCount = 0;

  for (const section of sections) {
    const chartData = result[section]?.chartData;
    if (chartData) {
      if (
        (chartData.series && Array.isArray(chartData.series) && chartData.series.length > 0) ||
        (chartData.values && Array.isArray(chartData.values) && chartData.values.length > 0)
      ) {
        chartCount++;
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

  // Check ESCO market specifics
  if (!result.escoMarket?.marketSize) {
    console.log(`  [Synthesis] Market warning: ESCO market size not available`);
    if (result.escoMarket) {
      result.escoMarket.marketSize = 'Data not available';
    }
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
 * Synthesize with fallback chain: Gemini → Kimi → Kimi retry → null
 */
async function synthesizeWithFallback(prompt, options = {}) {
  const { maxTokens = 8192, jsonMode = true } = options;

  // Try Gemini first
  try {
    const result = await callGemini(prompt, { maxTokens, jsonMode, temperature: 0.2 });
    const parsed = parseJsonResponse(result);
    if (parsed) return parsed;
  } catch (geminiErr) {
    console.warn(`  [Synthesis] Gemini failed: ${geminiErr?.message}, trying Kimi...`);
  }

  // Try Kimi
  try {
    const result = await callKimiChat(prompt, '', maxTokens);
    const parsed = parseJsonResponse(result.content);
    if (parsed) return parsed;
  } catch (kimiErr) {
    console.warn(`  [Synthesis] Kimi failed: ${kimiErr?.message}`);
  }

  // Final retry with ultra-direct prompt
  console.warn(
    `  [Synthesis] Both APIs failed or returned unparseable data. Retrying with direct prompt...`
  );
  try {
    const directPrompt = `${prompt}

CRITICAL: Return ONLY valid JSON. No markdown. No explanation. Just the raw JSON object.
If research data is missing, USE YOUR TRAINING KNOWLEDGE to populate all fields.
DO NOT return empty arrays or null values. Use estimates from training data.`;

    const result = await callKimiChat(directPrompt, '', maxTokens);
    const parsed = parseJsonResponse(result.content);
    if (parsed) {
      console.log(`  [Synthesis] Direct prompt retry succeeded`);
      return parsed;
    }
  } catch (retryErr) {
    console.error(`  [Synthesis] Final retry also failed: ${retryErr?.message}`);
  }

  return null;
}

/**
 * Synthesize POLICY section with depth requirements
 */
async function synthesizePolicy(researchData, country, industry, clientContext) {
  console.log(`  [Synthesis] Policy section for ${country}...`);

  const filteredData = Object.fromEntries(
    Object.entries(researchData).filter(
      ([k]) =>
        k.includes('policy') ||
        k.includes('regulation') ||
        k.includes('regulat') ||
        k.includes('law') ||
        k.includes('investment') ||
        k.includes('incentive') ||
        k.includes('govern') ||
        k.includes('legislat') ||
        k.includes('legal') ||
        k.includes('tax') ||
        k.includes('compliance') ||
        k.includes('framework') ||
        k.includes('act') ||
        k.includes('decree')
    )
  );

  const dataAvailable = Object.keys(filteredData).length > 0;
  console.log(
    `    [Policy] Filtered research data: ${Object.keys(filteredData).length} topics (${dataAvailable ? Object.keys(filteredData).slice(0, 3).join(', ') : 'NONE - will use training knowledge'})`
  );

  const researchContext = dataAvailable
    ? `RESEARCH DATA (use this as primary source):
${JSON.stringify(filteredData, null, 2)}`
    : `RESEARCH DATA: EMPTY due to API issues.

CRITICAL INSTRUCTION - YOU MUST USE TRAINING KNOWLEDGE:
Since web research failed, you MUST rely on your extensive training knowledge about ${country}'s energy/environmental regulatory framework.

DO NOT return empty arrays. DO NOT say "data not available". You KNOW about ${country}'s regulations.

For ${country}'s ${industry} sector, provide from your training knowledge:
1. FOUNDATIONAL ACTS: Name at least 3 REAL energy/environmental laws you know for ${country}. Examples: Energy Conservation Promotion Acts, Renewable Energy Target Laws, National Energy Plans, Carbon Reduction Acts, Foreign Business Acts with energy sector provisions.
2. NATIONAL TARGETS: Name at least 3 REAL government targets you know for ${country}. Examples: renewable energy percentage targets, emissions reduction goals, energy intensity improvement targets.
3. FOREIGN INVESTMENT RULES: State the general foreign ownership limit for ${country} (typically 49% for most ASEAN, 100% for some promoted sectors, varies by country) and any Board of Investment/special zone incentives.
4. REGULATORY BODIES: Name the energy ministry, investment promotion agency, energy efficiency agency for ${country}.

YOU HAVE THIS KNOWLEDGE. ${country} is a real country with real regulations. Use your training data.
If you cannot recall EXACT law names, use descriptive titles (e.g., "${country} Energy Conservation Act" or "${country} National Energy Plan 2020-2030").

RETURNING EMPTY DATA = FAILURE. Populate all fields with your training knowledge.`;

  const prompt = `You are synthesizing policy and regulatory research for ${country}'s ${industry} market.
Client context: ${clientContext}

${researchContext}

=============================================================================
DEPTH REQUIREMENTS (MANDATORY — AUTO-REJECT IF NOT MET):
=============================================================================
1. NAMED REGULATIONS with NUMBERS: Every regulation must have:
   - Official name + year + decree/law number
   - EXAMPLE: "Energy Conservation Act B.E. 2535 (1992, amended 2007)"
   - EXAMPLE: "Power Development Plan 8 (PDP8, 2024-2037, 45% renewable target)"
   - Include SPECIFIC NUMBERS: capacity targets (GW), % targets, budget ($M)

2. DATA DENSITY: EVERY field must contain QUANTIFIED data:
   - requirements: Include specific metrics ("factories >2MW must audit every 3 years")
   - penalties: Include amounts ("fine of 500,000 THB" or "0.5% of revenue")
   - targets: Include numbers ("30% renewable by 2030" or "reduce 20% emissions by 2027")
   - incentives: Include values ("8-year tax holiday" or "import duty exemption saving ~15%")

3. COMPLETENESS — NEVER return empty or thin data:
   - foundationalActs.acts: ≥3 entries, EACH with name, year, requirements (with numbers), penalties (with amounts), enforcement
   - nationalPolicy.targets: ≥3 entries, EACH with specific metric + target number + deadline year + current status
   - investmentRestrictions.incentives: ≥2 entries, EACH with program name + quantified benefit + eligibility criteria

4. ACTIONABLE LANGUAGE in EVERY keyMessage/policyDirection:
   - MUST use: "recommend", "opportunity to", "should consider", "strategic fit because"
   - MUST connect regulation to client action: "PDP8's 45% renewable target by 2037 creates $2.3B ESCO opportunity — recommend targeting industrial efficiency first"

5. SOURCE CITATIONS: Include at least ONE source per section:
   - Format: "According to Ministry of Energy 2024" or "Source: PDP8 policy document"

SCORING — Each regulation/target scores on this rubric (must score 8+/10):
✓ Has official name: +2
✓ Has year/date: +2
✓ Has specific numbers (%, $, GW, deadlines): +2
✓ Has enforcement reality or status: +2
✓ Connects to client opportunity: +2
=============================================================================

Return JSON:
{
  "foundationalActs": {
    "slideTitle": "${country} - ${industry} Foundational Acts",
    "subtitle": "Key insight in max 15 words",
    "acts": [
      {"name": "Official Act Name", "year": "YYYY", "requirements": "Specific requirements", "penalties": "Specific penalties", "enforcement": "Enforcement reality"}
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
  }
}

Return ONLY valid JSON.`;

  const result = await synthesizeWithFallback(prompt);
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
    Object.entries(researchData).filter(
      ([k]) =>
        k.includes('market') ||
        k.includes('energy') ||
        k.includes('demand') ||
        k.includes('supply') ||
        k.includes('price') ||
        k.includes('electric') ||
        k.includes('gas') ||
        k.includes('lng') ||
        k.includes('esco') ||
        k.includes('size') ||
        k.includes('capacity') ||
        k.includes('power') ||
        k.includes('renew') ||
        k.includes('fuel') ||
        k.includes('oil') ||
        k.includes('infrastructure') ||
        k.includes('generat') ||
        k.includes('consum') ||
        k.includes('growth') ||
        k.includes('forecast')
    )
  );

  const dataAvailable = Object.keys(filteredData).length > 0;
  console.log(
    `    [Market] Filtered research data: ${Object.keys(filteredData).length} topics (${dataAvailable ? Object.keys(filteredData).slice(0, 3).join(', ') : 'NONE - will use training knowledge'})`
  );

  const researchContext = dataAvailable
    ? `RESEARCH DATA (use this as primary source):
${JSON.stringify(filteredData, null, 2)}`
    : `RESEARCH DATA: EMPTY due to API issues.

CRITICAL INSTRUCTION - YOU MUST USE TRAINING KNOWLEDGE:
Since web research failed, you MUST rely on your extensive training knowledge about ${country}'s energy market.

DO NOT return empty chartData. DO NOT return empty arrays. You KNOW approximate data for ${country}.

For ${country}'s ${industry}/energy sector, provide from your training knowledge:
1. TPES: Total Primary Energy Supply composition (coal %, gas %, oil %, renewables %, nuclear %). You know ${country}'s approximate energy mix.
2. FINAL DEMAND: Energy consumption by sector (industry %, transport %, residential/commercial %). You know ${country}'s economic structure.
3. ELECTRICITY: Installed capacity (coal, gas, hydro, solar, wind). You know ${country} has power plants.
4. GAS/LNG: Does ${country} import LNG? Does it have pipelines? Approximate volumes in bcm.
5. PRICING: Typical electricity prices for ${country} (industrial vs residential). ASEAN average is 0.08-0.12 USD/kWh.
6. ESCO MARKET: Estimated market size for energy efficiency services. Use training knowledge about ${country}'s industrial base.

PROVIDE NUMERIC DATA: chartData.series with at least 3-5 data points each. Use your training knowledge to estimate realistic values for ${country}.
Example: If you know ${country} has significant coal power, chartData for electricity might be: coal 40%, gas 30%, hydro 15%, renewables 10%, other 5%.

YOU HAVE THIS KNOWLEDGE. ${country} is a real country with real energy infrastructure. Use your training data.
RETURNING EMPTY CHARTDATA = FAILURE. Populate all fields with training knowledge estimates.`;

  const prompt = `You are synthesizing market data research for ${country}'s ${industry} market.
Client context: ${clientContext}

${researchContext}

=============================================================================
DEPTH REQUIREMENTS (MANDATORY):
=============================================================================
1. DATA DENSITY: MINIMUM 15 quantified data points across all 6 sections
   - EVERY section needs numbers: market size ($M), capacity (GW/MW), growth (% CAGR), prices ($/unit)
   - EXAMPLES: "$320M market", "14% CAGR 2020-2024", "45 GW installed", "23% renewable share", "$0.08/kWh"

2. CHARTS: At least 4 of 6 sections MUST have chartData:
   - chartData.series: array of objects with name + values (NUMERIC array, NOT strings)
   - chartData.categories: array of years ["2020","2021","2022","2023","2024"] or categories
   - chartData.unit: unit of measurement ("Mtoe", "GW", "bcm", "%", "$B")
   - MINIMUM 5 data points per chart

3. ACTIONABLE LANGUAGE in EVERY keyInsight:
   - MUST use: "recommend", "opportunity to", "should consider", "growth potential", "strategic fit because"
   - MUST connect data to client action: "45 GW renewables by 2030 (up from 12 GW in 2024) creates $2.3B opportunity — recommend targeting solar+storage integration"

4. SOURCE CITATIONS: Cite data sources in keyInsight text
   - Format: "Source: IEA 2024", "According to Vietnam Electricity, 2024", "Ministry of Energy data"

5. MANDATORY FOR ALL 6 SECTIONS (tpes, finalDemand, electricity, gasLng, pricing, escoMarket):
   - keyInsight field with actionable recommendation (see #3)
   - Specific numbers with units (see #1)
   - Year/timeframe for all data points (e.g., "2024 data", "2020-2024", "projected to 2030")

6. ESCO MARKET SECTION — CRITICAL:
   - marketSize: "$XXM" (e.g., "$180M", "$450M")
   - growthRate: "XX% CAGR" with year range (e.g., "18% CAGR 2020-2024")
   - NEVER leave these fields empty or say "data not available"
=============================================================================

For chart data, provide NUMERIC arrays (not strings). Example:
"chartData": {"categories": ["2020","2021","2022","2023","2024"], "series": [{"name":"Coal", "values": [45,42,40,38,35]}], "unit": "Mtoe"}

Return JSON with these sections:
{
  "tpes": {
    "slideTitle": "${country} - Total Primary Energy Supply",
    "subtitle": "Key insight",
    "chartData": {"categories": [...years...], "series": [{"name":"Source", "values": [...numbers...]}], "unit": "Mtoe"},
    "keyInsight": "What this means for client",
    "dataType": "time_series_multi_insight"
  },
  "finalDemand": {
    "slideTitle": "${country} - Final Energy Demand",
    "subtitle": "Key insight",
    "chartData": {"categories": [...], "series": [...], "unit": "%"},
    "growthRate": "X% CAGR with years",
    "keyDrivers": ["Named driver with evidence"],
    "keyInsight": "Client implication",
    "dataType": "time_series_multi_insight"
  },
  "electricity": {
    "slideTitle": "${country} - Electricity & Power",
    "subtitle": "Key insight",
    "totalCapacity": "XX GW",
    "chartData": {"categories": [...sources...], "values": [...%...], "unit": "%"},
    "demandGrowth": "X% with year range",
    "keyTrend": "Trend with evidence",
    "keyInsight": "Client implication",
    "dataType": "composition_breakdown"
  },
  "gasLng": {
    "slideTitle": "${country} - Gas & LNG Market",
    "subtitle": "Key insight",
    "chartData": {"categories": [...years...], "series": [...], "unit": "bcm"},
    "lngTerminals": [{"name": "Named terminal", "capacity": "X mtpa", "utilization": "X%"}],
    "pipelineNetwork": "Description",
    "keyInsight": "Client implication",
    "dataType": "time_series_annotated"
  },
  "pricing": {
    "slideTitle": "${country} - Energy Pricing",
    "subtitle": "Key insight",
    "chartData": {"categories": [...years...], "series": [...], "unit": "USD/kWh"},
    "comparison": "vs regional peers with specific numbers",
    "outlook": "Projected trend with reasoning",
    "keyInsight": "Client implication",
    "dataType": "two_related_series"
  },
  "escoMarket": {
    "slideTitle": "${country} - ESCO/${industry} Market",
    "subtitle": "Key insight",
    "marketSize": "$XXX million with year",
    "growthRate": "X% CAGR with period",
    "segments": [{"name": "Named segment", "size": "$XXM", "share": "X%"}],
    "chartData": {"categories": [...], "values": [...], "unit": "%"},
    "keyDrivers": "Named drivers",
    "keyInsight": "Client implication",
    "dataType": "composition_breakdown"
  }
}

Return ONLY valid JSON.`;

  const result = await synthesizeWithFallback(prompt, { maxTokens: 12288 });
  if (!result) {
    console.error('  [synthesizeMarket] Synthesis completely failed — no data returned');
    return { _synthesisError: true, section: 'market', message: 'All synthesis attempts failed' };
  }
  const validated = validateMarketSynthesis(result);
  return validated;
}

/**
 * Synthesize COMPETITORS section with depth requirements
 */
async function synthesizeCompetitors(researchData, country, industry, clientContext) {
  console.log(`  [Synthesis] Competitors section for ${country}...`);

  const filteredData = Object.fromEntries(
    Object.entries(researchData).filter(
      ([k]) =>
        k.includes('compet') ||
        k.includes('player') ||
        k.includes('company') ||
        k.includes('japanese') ||
        k.includes('foreign') ||
        k.includes('local') ||
        k.includes('case') ||
        k.includes('m&a') ||
        k.includes('merger') ||
        k.includes('acqui') ||
        k.includes('partner') ||
        k.includes('landscape') ||
        k.includes('rival') ||
        k.includes('incumbent') ||
        k.includes('operator') ||
        k.includes('provider') ||
        k.includes('firm') ||
        k.includes('enterprise')
    )
  );

  const dataAvailable = Object.keys(filteredData).length > 0;
  console.log(
    `    [Competitors] Filtered research data: ${Object.keys(filteredData).length} topics (${dataAvailable ? Object.keys(filteredData).slice(0, 3).join(', ') : 'NONE - will use training knowledge'})`
  );

  const researchContext = dataAvailable
    ? `RESEARCH DATA (use this as primary source):
${JSON.stringify(filteredData, null, 2)}`
    : `RESEARCH DATA: EMPTY due to API issues.

CRITICAL INSTRUCTION - YOU MUST USE TRAINING KNOWLEDGE:
Since web research failed, you MUST rely on your training knowledge about ${country}'s energy sector players.

DO NOT return empty player arrays. You KNOW companies operating in ${country}.

For ${country}'s ${industry}/energy sector, provide from your training knowledge:
1. JAPANESE PLAYERS: Name at least 2 REAL Japanese companies you know operate in ${country}. Examples: JERA, Marubeni, Mitsubishi Corporation, Sumitomo, Tokyo Gas, Osaka Gas. These companies HAVE presence in ASEAN energy markets. Include their actual websites (https://www.jera.co.jp, https://www.marubeni.com, etc.).
2. LOCAL MAJOR PLAYERS: Name at least 3 REAL local energy companies you know for ${country}. Examples: Vietnam has EVN, PetroVietnam; Thailand has PTT, EGAT, BGRIM; Malaysia has Petronas, TNB. You KNOW the dominant state utilities for ${country}. Include estimated revenues (state utilities in ASEAN typically $1B-$50B+ depending on country size).
3. FOREIGN PLAYERS: Name at least 2 REAL foreign energy companies you know operate in ${country}. Examples: Schneider Electric, Siemens Energy, ENGIE, Veolia, GE, Honeywell. These multinationals operate across ASEAN. Include their corporate websites.

EVERY COMPANY MUST HAVE:
- name: Real company name from your training knowledge
- website: Actual corporate website (use https://www.[company].com format)
- description: 45-55 words with estimated market position, entry year (approximate), and strategic context

YOU HAVE THIS KNOWLEDGE. ${country} has a real energy sector with real companies. Use your training data.
RETURNING EMPTY PLAYERS ARRAYS = FAILURE. Populate with real company names from training knowledge.`;

  const prompt = `You are synthesizing competitive intelligence for ${country}'s ${industry} market.
Client context: ${clientContext}

${researchContext}

CRITICAL REQUIREMENTS — OUTPUT REJECTED IF ANY ARE VIOLATED:
=============================================================================
1. DESCRIPTION LENGTH: Every company description MUST be 45-55 words (count them)
   - <45 words = REJECTED (too thin)
   - >55 words = REJECTED (causes overflow)
   - >65 words = REJECTED (will overflow on slides)
   - Target: 55-60 words

2. REQUIRED COMPONENTS IN EVERY DESCRIPTION (all 4 mandatory):
   a) FINANCIAL: revenue/market share/valuation + year (e.g., "$45M revenue, 2024")
   b) SCALE: specific number (e.g., "180 contracts", "7 provinces", "12% growth since 2019")
   c) ASSESSMENT: strength + weakness (both required, e.g., "Strong: govt relationships. Weak: limited tech")
   d) ACTION: specific recommendation with verb (e.g., "Recommend 60/40 JV structure")

3. DATA DENSITY: Every description MUST contain at least 3 numbers/percentages

EXAMPLE (58 words, all 4 components):
"ABC Energy ($45M revenue, 2024) operates 180+ efficiency contracts across 7 provinces with 12% annual growth since 2019. Strong government relationships and 23-year track record in food/beverage. Weakness: limited tech capabilities. Strategic fit: established customer base needs foreign technology partner. Recommend 60/40 JV structure for complementary strengths."
✓ Financial: $45M, 2024 ✓ Scale: 180 contracts, 7 provinces, 12% growth ✓ Assessment: Strong (govt), Weak (tech) ✓ Action: Recommend 60/40 JV
=============================================================================

ADDITIONAL DEPTH REQUIREMENTS:
- At least 3 named companies per category with: investment year, structure (JV/acquisition/greenfield), stake %, partner name, revenue
- At least 1 detailed case study per major competitor: customer name, what they did, outcome (CO2 tons, MW, revenue)
- SOURCE CITATIONS REQUIRED: Include at least one source attribution per section (e.g., "Source: Bloomberg 2024", "According to Vietnam Energy Association"). Competitive intelligence needs source context.
- Website URLs for ALL companies — use the company's actual corporate website (e.g., "https://www.engie.com"). NEVER omit this field. Every player object MUST have a "website" field starting with "https://".
- For each data point: "so what" — what it means for the client
- ACTIONABLE INSIGHT per category: end each players section with "marketInsight" or "competitiveInsight" using language like "recommend approaching", "opportunity to partner", "strategic fit because", "should consider acquiring"
- SOURCE CITATIONS: Every section must cite at least ONE source. Use format "According to [source name], [year]" or "Source: [company name] annual report, [year]" within the marketInsight/competitiveInsight text.
- If you cannot find exact revenue/market share, provide estimates with "estimated" qualifier — never leave description fields empty or under 45 words
- MANDATORY: japanesePlayers.players must have at least 2 entries, localMajor.players at least 3 entries, foreignPlayers.players at least 2 entries
- MANDATORY: caseStudy must have company, entryYear, entryMode, investment, and outcome all populated with specific data
- CRITICAL: Research data may be empty due to API issues. In this case, you MUST use your training knowledge to name REAL companies operating in ${country}'s ${industry} sector. For Vietnamese energy services: include state-owned utilities (EVN), major local ESCOs, Japanese trading companies with presence (Marubeni, JERA), and international firms (Schneider, Siemens). Include their actual corporate website URLs. NEVER return empty player arrays — use training knowledge to populate with real company names, estimated market positions, and strategic context.

=============================================================================
CRITICAL — TEXT LENGTH RULES TO PREVENT SLIDE OVERFLOW (AUTO-REJECT IF VIOLATED):
=============================================================================
1. EVERY company description MUST be 45-55 words (NOT 60+, NOT 70+)
2. TARGET: 48-52 words per description (sweet spot for fitting on slide)
3. MAXIMUM: 55 words absolute limit
4. MINIMUM: 45 words (ensures depth)
5. If ANY description <45 words OR >55 words → OUTPUT REJECTED
=============================================================================

MANDATORY 4-PART STRUCTURE (ALL DESCRIPTIONS):
1. FINANCIAL + SCALE: "Company Name (revenue $XM, year) operates X locations/contracts..."
2. COMPETITIVE POSITION: "Strengths: [specific]. Weakness: [specific]."
3. STRATEGIC FIT: "Strategic fit for client: [why relevant]."
4. ACTION: "Recommend [verb] for [reason]." (Use: recommend/consider/approach/target)

VALID EXAMPLE (51 words — within 45-55 word limit):
"ABC Energy (revenue $45M, 2024) operates 180+ contracts across 7 provinces, 12% annual growth. Strengths: government relationships, 23-year track record. Weakness: limited tech. Strategic fit: established base needs foreign tech partner. Recommend approaching for 60/40 JV given complementary strengths."

REJECTED EXAMPLE (too generic, no numbers):
"XYZ Company is a leading energy services provider in the region with a strong track record and good relationships. They offer a wide range of services and have been operating for many years."
✗ No revenue ✗ No specific numbers ✗ No year ✗ Generic phrases ("leading", "strong") ✗ No strategic recommendation

DEPTH REQUIREMENTS (MANDATORY — FAILURE TO MEET = REJECTED OUTPUT):
- EVERY description must contain: (1) Revenue/market share + year, (2) Scale metric (# of contracts/locations/employees), (3) Growth % OR competitive position, (4) Strategic recommendation with action verb
- DATA DENSITY: Every description needs at least 3 numbers (revenue, year, scale metric, growth %, market share, etc.)
- Website URLs for ALL companies (format: "https://www.company.com") — NEVER omit
- ACTIONABLE LANGUAGE: Every marketInsight/competitiveInsight must use: "recommend", "opportunity to", "should consider", "strategic fit because"
- SOURCE CITATIONS: Include at least one attribution per section (e.g., "Source: Bloomberg 2024", "According to [industry body]")
- MANDATORY MINIMUMS: japanesePlayers ≥2 entries, localMajor ≥3 entries, foreignPlayers ≥2 entries
- CASE STUDY: Must have company, entryYear, entryMode, investment ($XM), outcome (specific metrics: MW/revenue/market share)

Return JSON:
{
  "japanesePlayers": {
    "slideTitle": "${country} - Japanese ${industry} Companies",
    "subtitle": "Key insight",
    "players": [
      {
        "name": "Company Name", "website": "https://...",
        "presence": "JV/Direct/etc", "projects": "Named projects",
        "revenue": "$X million", "assessment": "Strong/Weak",
        "description": "45-55 words with specific metrics, entry strategy, project details, market position"
      }
    ],
    "marketInsight": "Overall assessment of Japanese presence",
    "dataType": "company_comparison"
  },
  "localMajor": {
    "slideTitle": "${country} - Major Local Players",
    "subtitle": "Key insight",
    "players": [
      {
        "name": "Company", "website": "https://...", "type": "State-owned/Private",
        "revenue": "$X million", "marketShare": "X%",
        "strengths": "Specific", "weaknesses": "Specific",
        "description": "45-55 words with specific metrics"
      }
    ],
    "concentration": "Market concentration with evidence",
    "dataType": "company_comparison"
  },
  "foreignPlayers": {
    "slideTitle": "${country} - Foreign ${industry} Companies",
    "subtitle": "Key insight",
    "players": [
      {
        "name": "Company", "website": "https://...", "origin": "Country",
        "entryYear": "YYYY", "mode": "JV/Direct",
        "projects": "Named projects", "success": "High/Medium/Low",
        "description": "45-55 words with specific metrics"
      }
    ],
    "competitiveInsight": "How foreign players compete",
    "dataType": "company_comparison"
  },
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
}

Return ONLY valid JSON.`;

  const result = await synthesizeWithFallback(prompt, { maxTokens: 12288 });
  if (!result) {
    console.error('  [synthesizeCompetitors] Synthesis completely failed — no data returned');
    return {
      _synthesisError: true,
      section: 'competitors',
      message: 'All synthesis attempts failed',
    };
  }
  const validated = validateCompetitorsSynthesis(result);
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
  return JSON.stringify(brief).slice(0, maxChars);
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

=============================================================================
CRITICAL — INSIGHT CHAIN REQUIREMENT (AUTO-REJECT IF NOT MET):
=============================================================================
EVERY insight in summary.keyInsights MUST have ALL 4 PARTS:
1. DATA: Specific number/percentage + year (e.g., "4,200 factories", "23 auditors", "2024")
2. SO WHAT: Causal explanation (e.g., "creates 18-month window because...")
3. NOW WHAT: Action verb (recommend/target/approach/consider) + specific target
4. BY WHEN: Timing window (Q1 2025/before 2026/18-month window)

VALID EXAMPLE (has ALL 4 parts):
{
  "title": "Enforcement backlog creates 18-month entry window",
  "data": "Energy audits mandatory for 4,200 factories >2MW but only 23 DEDE auditors exist (2024 data)",
  "pattern": "Enforcement backlog creates 18-month compliance window before DEDE hires 40 new auditors in 2026",
  "implication": "Recommend targeting non-compliant factories in Q1 2025 before regulatory crackdown accelerates in late 2026"
}
✓ Numbers: 4,200, 23 ✓ Years: 2024, 2026 ✓ Causal: "creates...because" ✓ Action+timing: "target Q1 2025 before..."

REJECTED EXAMPLE (missing parts):
{
  "title": "Market is growing",
  "data": "The market is expanding",
  "pattern": "Growth creates opportunities",
  "implication": "Companies should consider entering"
}
✗ No numbers ✗ No dates ✗ No causal chain ✗ No timing

MINIMUM: 3 insights, each scoring 8+/10 on this rubric:
- Specific number/percentage: +2
- Year/date/timeframe: +2
- Causal explanation (because/which creates): +2
- Action verb (recommend/should/target): +2
- Timing window (by when/before/Q1 2025): +2
=============================================================================

SYNTHESIZED SECTIONS (already processed):
Policy: ${summarizeForSummary(policy, 'policy', 800)}
Market: ${summarizeForSummary(market, 'market', 1200)}
Competitors: ${summarizeForSummary(competitors, 'competitors', 800)}

ADDITIONAL RESEARCH DATA:
${JSON.stringify(
  Object.fromEntries(
    Object.entries(researchData).filter(
      ([k]) =>
        k.includes('insight') ||
        k.includes('summary') ||
        k.includes('strateg') ||
        k.includes('timing') ||
        k.includes('lesson') ||
        k.includes('opportunity') ||
        k.includes('risk') ||
        k.includes('entry') ||
        k.includes('partner') ||
        k.includes('segment') ||
        k.includes('implement') ||
        k.includes('econ') ||
        k.includes('outlook') ||
        k.includes('assess') ||
        k.includes('recommend') ||
        k.includes('target') ||
        k.includes('deal') ||
        k.includes('valuat') ||
        k.includes('financ')
    )
  ),
  null,
  2
).slice(0, 3000)}

=============================================================================
DEPTH REQUIREMENTS (MANDATORY — FAILURE TO MEET = REJECTED OUTPUT):
=============================================================================

INSIGHT SCORING RUBRIC — EVERY insight must score 8+/10:
✓ Specific number/percentage: +2 points
✓ Year/date/timeframe: +2 points
✓ Causal explanation (because/which creates): +2 points
✓ Action verb (recommend/should/target): +2 points
✓ Timing window (by when/before/Q1/month): +2 points

EVERY summary.keyInsights entry MUST have ALL 4 PARTS:
1. DATA: Specific number + year (e.g., "4,200 factories, 23 auditors, 2024")
2. SO WHAT: Causal mechanism (e.g., "creates 18-month window because DEDE hiring frozen until 2026")
3. NOW WHAT: Action with verb (e.g., "Recommend targeting non-compliant factories")
4. BY WHEN: Timing trigger (e.g., "in Q1 2025 before late 2026 crackdown")

EXAMPLE INSIGHT (10/10 score):
{
  "title": "Enforcement backlog creates 18-month entry window",
  "data": "4,200 factories >2MW require audits but only 23 DEDE auditors exist (2024)",
  "pattern": "Enforcement backlog creates 18-month compliance window before DEDE hires 40 new auditors in 2026",
  "implication": "Recommend targeting non-compliant factories in Q1 2025 before regulatory crackdown accelerates in late 2026"
}
✓ Numbers: 4,200, 23, 40 [2] ✓ Years: 2024, 2026, Q1 2025 [2] ✓ Causal: "creates...before" [2] ✓ Action: "Recommend targeting" [2] ✓ Timing: "Q1 2025 before late 2026" [2] = 10/10

REJECTED INSIGHT (2/10 score — DO NOT GENERATE LIKE THIS):
{"title": "Market is growing", "data": "The market is expanding", "pattern": "Growth creates opportunities", "implication": "Companies should consider entering"}
✗ No numbers [0] ✗ No dates [0] ✓ Weak causal [2] ✗ Vague action [0] ✗ No timing [0] = 2/10 REJECTED

MANDATORY REQUIREMENTS FOR EACH SECTION:

1. DATA DENSITY:
   - EVERY opportunity: dollar size + % growth + timing window
   - EVERY obstacle: severity rating + mitigation cost/time + next steps
   - EVERY phase: investment amount + duration + milestones with dates

2. ACTIONABLE LANGUAGE — Use in EVERY section:
   - "recommend", "should consider", "opportunity to", "strategic fit because", "next steps", "outlook suggests"

3. SOURCE CITATIONS:
   - opportunities section: cite at least 1 source
   - entryStrategy section: cite at least 1 source
   - implementation section: cite at least 1 source
   - Format: "According to [source], [year]" or "Source: [name], [year]"

4. PARTNER DESCRIPTIONS — WORD COUNT LIMIT TO PREVENT OVERFLOW:
   - partnerAssessment.partners: ≥3 entries
   - EACH partner description: 45-55 words (NOT 60+, NOT 70+)
   - Must include: revenue estimate, market position, specific strengths/weaknesses, strategic fit rationale

5. COMPLETENESS:
   - entryStrategy.options: exactly 3 (JV, Acquisition, Greenfield), ALL fields populated with numbers
   - implementation.phases: exactly 3, with specific activities + dated milestones + investment ($M)
   - summary.opportunities: ≥3 entries with size ($M) + timing (year/quarter)
   - summary.obstacles: ≥2 entries with severity (High/Med/Low) + mitigation plan
   - summary.keyInsights: ≥3 entries, EACH scoring 8+/10 on rubric above

6. TIMING PRECISION:
   - Use specific dates: "Q1 2025", "before December 2026", "18-month window"
   - NEVER use: "soon", "in the future", "eventually"
=============================================================================

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
        {"name": "Company", "website": "https://...", "type": "Type", "revenue": "$XM", "partnershipFit": 4, "acquisitionFit": 3, "estimatedValuation": "$X-YM", "description": "45-55 words"}
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

  // Market check: ≥3 data series with ≥5 points
  const market = synthesis.market || {};
  let seriesCount = 0;
  for (const section of ['tpes', 'finalDemand', 'electricity', 'gasLng', 'pricing', 'escoMarket']) {
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
  if (market.escoMarket?.marketSize) scores.market += 30;

  // Competitors check: ≥3 companies with details
  const competitors = synthesis.competitors || {};
  let totalCompanies = 0;
  for (const section of ['japanesePlayers', 'localMajor', 'foreignPlayers']) {
    const players = competitors[section]?.players || [];
    totalCompanies += players.filter((p) => p.name && (p.revenue || p.description)).length;
  }
  if (totalCompanies >= 5) scores.competitors = 100;
  else if (totalCompanies >= 3) scores.competitors = 70;
  else if (totalCompanies >= 1) scores.competitors = 40;
  else failures.push(`Competitors: only ${totalCompanies} detailed companies (need ≥3)`);

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
async function reSynthesize(originalSynthesis, additionalData, country, _industry, _clientContext) {
  console.log(`  [Re-synthesizing ${country} with additional data...]`);

  const prompt = `You are improving a market analysis with NEW DATA that fills previous gaps.

ORIGINAL ANALYSIS:
${JSON.stringify(originalSynthesis, null, 2)}

NEW DATA TO INCORPORATE:

GAP RESEARCH (fills missing information):
${JSON.stringify(additionalData.gapResearch, null, 2)}

VERIFICATION RESEARCH (confirms or corrects claims):
${JSON.stringify(additionalData.verificationResearch, null, 2)}

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
- Mark anything still uncertain as "estimated" or "industry sources suggest"

Return ONLY valid JSON with the SAME STRUCTURE as the original.`;

  const result = await callKimiAnalysis(prompt, '', 8192);

  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    const newSynthesis = JSON.parse(jsonStr);

    // Validate structure preservation - check for key fields
    const hasPolicy = newSynthesis.policy && typeof newSynthesis.policy === 'object';
    const hasMarket = newSynthesis.market && typeof newSynthesis.market === 'object';
    const hasCompetitors = newSynthesis.competitors && typeof newSynthesis.competitors === 'object';

    if (!hasPolicy || !hasMarket || !hasCompetitors) {
      console.warn('  [reSynthesize] Structure mismatch detected - falling back to original');
      console.warn(
        `    Missing: ${!hasPolicy ? 'policy ' : ''}${!hasMarket ? 'market ' : ''}${!hasCompetitors ? 'competitors' : ''}`
      );
      // Preserve country field from original
      originalSynthesis.country = country;
      return originalSynthesis;
    }

    // Preserve country field
    newSynthesis.country = country;
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
        scope.projectType
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
        policyResearchAgent(country, industry, clientContext),
        marketResearchAgent(country, industry, clientContext),
        competitorResearchAgent(country, industry, clientContext),
        contextResearchAgent(country, industry, clientContext),
        depthResearchAgent(country, industry, clientContext),
        insightsResearchAgent(country, industry, clientContext),
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
                .map((g) => [`gap_${g.gap}`, g.findings])
            ),
          },
          country,
          industry,
          clientContext
        );
        if (
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
                .map((g) => [`gap_${g.gap}`, g.findings])
            ),
          },
          country,
          industry,
          clientContext
        );
        countryAnalysis.market = { ...countryAnalysis.market, ...newMarket };
      }
      if (validation.scores.competitors < 50) {
        const newComp = await synthesizeCompetitors(
          {
            ...researchData,
            ...Object.fromEntries(
              additionalData.gapResearch
                .filter((g) => g.area === 'competitors')
                .map((g) => [`gap_${g.gap}`, g.findings])
            ),
          },
          country,
          industry,
          clientContext
        );
        countryAnalysis.competitors = { ...countryAnalysis.competitors, ...newComp };
      }

      // Re-validate
      const revalidation = validateContentDepth(countryAnalysis);
      countryAnalysis.contentValidation = revalidation;

      if (revalidation.scores.overall < 25) {
        console.error(
          `  [ABORT] Content still too thin after retry (${revalidation.scores.overall}/100). Will not generate hollow PPT.`
        );
        countryAnalysis.aborted = true;
        countryAnalysis.abortReason = `Content depth ${revalidation.scores.overall}/100 after retry. Failures: ${revalidation.failures.join('; ')}`;
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
    if (readyForClient || confidenceScore >= MIN_CONFIDENCE_SCORE) {
      console.log(`    ✓ Quality threshold met (${confidenceScore}/100) - analysis ready`);
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
        clientContext
      );
      countryAnalysis.country = country; // Ensure country is set
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

// ============ REVIEWER AI SYSTEM ============

// Reviewer AI: Critiques the analysis like a demanding McKinsey partner
async function reviewAnalysis(synthesis, countryAnalysis, scope) {
  console.log(`  [REVIEWER] Evaluating analysis quality...`);

  const reviewPrompt = `You are a DEMANDING McKinsey Senior Partner reviewing a market entry analysis before it goes to a Fortune 500 CEO. You've seen hundreds of these. You know what separates good from great.

CLIENT CONTEXT: ${scope.clientContext}
INDUSTRY: ${scope.industry}
COUNTRY: ${countryAnalysis.country}

ANALYSIS TO REVIEW:
${JSON.stringify(synthesis, null, 2)}

RAW DATA AVAILABLE (for fact-checking):
${JSON.stringify(countryAnalysis, null, 2)}

REVIEW THIS ANALYSIS RUTHLESSLY. Check for:

1. VAGUE CLAIMS: Anything without specific numbers, dates, or names
   - "The market is growing" = FAIL
   - "The market grew 14% in 2024 to $320M" = PASS

2. SURFACE-LEVEL INSIGHTS: Things anyone could Google in 5 minutes
   - "Thailand has a large manufacturing sector" = FAIL
   - "Thailand's 4,200 factories >2MW face mandatory audits but only 23 DEDE auditors exist" = PASS

3. MISSING CAUSAL CHAINS: Facts without explanation of WHY
   - "Energy prices are high" = FAIL
   - "Energy prices are high because Erawan field output dropped 30%" = PASS

4. WEAK COMPETITIVE INTEL: Generic descriptions instead of actionable intelligence
   - "Several foreign companies operate here" = FAIL
   - "ENGIE entered via B.Grimm JV in 2018, won 12 contracts, struggles outside Bangkok" = PASS

5. HOLLOW RECOMMENDATIONS: Advice without specific next steps
   - "Consider partnerships" = FAIL
   - "Approach Absolute Energy (revenue $45M, 180 clients) before Mitsubishi's rumored bid" = PASS

6. STORY FLOW: Does each section logically lead to the next?

7. EXECUTIVE SUMMARY: Does it tell a compelling story in 5 bullets?

Return JSON:
{
  "overallScore": 1-10,
  "confidence": "low/medium/high",
  "verdict": "APPROVE" or "REVISE",
  "criticalIssues": [
    {
      "section": "which section has the problem",
      "issue": "what's wrong specifically",
      "currentText": "quote the problematic text",
      "suggestion": "how to fix it with SPECIFIC content"
    }
  ],
  "strengths": ["what's working well - be specific"],
  "missingElements": ["critical things not covered that should be"],
  "summaryFeedback": "2-3 sentences of direct feedback to the analyst"
}

BE HARSH. A 7/10 means it's good. 8+ means it's exceptional. Most first drafts are 4-6.
Only "APPROVE" if score is 7+ and no critical issues remain.
Return ONLY valid JSON.`;

  const result = await callKimiChat(reviewPrompt, '', 4096);

  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    const review = JSON.parse(jsonStr);
    console.log(
      `    Score: ${review.overallScore}/10 | Confidence: ${review.confidence} | Verdict: ${review.verdict}`
    );
    console.log(
      `    Issues: ${review.criticalIssues?.length || 0} critical | Strengths: ${review.strengths?.length || 0}`
    );
    return review;
  } catch (error) {
    console.error('  Reviewer failed to parse:', error?.message);
    // Don't auto-approve on error - return low score requiring revision
    return {
      overallScore: 4,
      confidence: 'low',
      verdict: 'REVISE', // Force revision instead of approving low-quality output
      criticalIssues: ['Reviewer parsing failed - manual review recommended'],
      reviewerError: true,
    };
  }
}

// Revise analysis based on reviewer feedback
async function reviseAnalysis(synthesis, review, countryAnalysis, scope, systemPrompt) {
  console.log(`  [REVISING] Addressing ${review.criticalIssues?.length || 0} issues...`);

  const revisePrompt = `You are revising a market analysis based on SPECIFIC FEEDBACK from a senior reviewer.

ORIGINAL ANALYSIS:
${JSON.stringify(synthesis, null, 2)}

REVIEWER FEEDBACK:
Score: ${review.overallScore}/10
Summary: ${review.summaryFeedback}

CRITICAL ISSUES TO FIX:
${JSON.stringify(review.criticalIssues, null, 2)}

MISSING ELEMENTS TO ADD:
${JSON.stringify(review.missingElements, null, 2)}

RAW DATA (use this to add specifics):
${JSON.stringify(countryAnalysis, null, 2)}

YOUR TASK:
1. FIX every critical issue listed above
2. ADD the missing elements
3. KEEP what the reviewer said was working well
4. Make every claim SPECIFIC with numbers, names, dates

Return the COMPLETE revised analysis in the same JSON structure.
DO NOT just acknowledge the feedback - actually REWRITE the weak sections.

For example, if reviewer says "executive summary is vague", rewrite ALL 5 bullets with specific data.

Return ONLY valid JSON with the full analysis structure.`;

  const result = await callKimiAnalysis(revisePrompt, systemPrompt, 12000);

  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    const revised = JSON.parse(jsonStr);
    revised.isSingleCountry = true;
    revised.country = countryAnalysis.country;
    return revised;
  } catch (error) {
    console.error('  Revision failed:', error?.message);
    return synthesis; // Return original if revision fails
  }
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

If you don't have specific data, say "estimated" or "industry sources suggest" - don't invent precision.`;

  const prompt = `Client: ${scope.clientContext}
Industry: ${scope.industry}
Target: ${countryAnalysis.country}

DATA GATHERED:
${JSON.stringify(countryAnalysis, null, 2)}

Synthesize this research into a CEO-ready briefing. Professional tone, specific data, actionable insights.

Return JSON with:

{
  "executiveSummary": [
    "5 bullets that form a logical argument. Each leads to the next. Max 30 words, Economist-style prose.",
    "Bullet 1: THE OPPORTUNITY - Quantify the prize with specifics (e.g., 'Thailand's $320M ESCO market grew 14% in 2024, yet foreign players hold only 8% share - a gap driven by regulatory complexity, not demand.')",
    "Bullet 2: THE TIMING - Why this window matters (e.g., 'BOI incentives offering 8-year tax holidays expire December 2027. The carbon tax effective 2026 will accelerate demand 20-30%.')",
    "Bullet 3: THE BARRIER - The real constraint, explained (e.g., 'The 49% foreign ownership cap applies to non-promoted activities. BOI-promoted energy efficiency projects qualify for majority foreign ownership.')",
    "Bullet 4: THE PATH - Specific strategy based on evidence (e.g., 'Three Thai ESCOs are seeking technology partners: Absolute Energy, TPSC, and Banpu Power. Absolute has the widest industrial client base.')",
    "Bullet 5: THE FIRST MOVE - Concrete next step with rationale (e.g., 'Initiate discussions with Absolute Energy (revenue $45M, 180+ industrial clients) before Mitsubishi's rumored approach concludes.')"
  ],

  "marketOpportunityAssessment": {
    "totalAddressableMarket": "$ value with calculation logic (e.g., '1,200 factories × avg $500K energy spend × 15% savings potential = $90M TAM')",
    "serviceableMarket": "$ value with realistic penetration assumptions and WHY those assumptions",
    "growthTrajectory": "CAGR with SPECIFIC drivers - not 'growing demand' but 'mandatory ISO 50001 compliance by 2026 for exporters (40% of manufacturing)'",
    "timingConsiderations": "Why NOW is the right time - regulatory triggers, competitive gaps, market readiness signals"
  },

  "competitivePositioning": {
    "keyPlayers": [
      {"name": "actual company", "website": "https://company.com", "strengths": "specific", "weaknesses": "specific", "threat": "how they could block you", "description": "REQUIRED 45-55 words with revenue, market share, growth rate, key services, strategic significance with revenue, market share, entry year, key projects, geographic coverage, strategic positioning, and why this player matters for competitive analysis"}
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

  "entryStrategyOptions": {
    "optionA": {
      "name": "short descriptive name",
      "description": "2-3 sentences on the approach",
      "pros": "3 specific advantages with evidence",
      "cons": "3 specific disadvantages with severity",
      "investmentRequired": "$ estimate with breakdown",
      "timeToRevenue": "months with assumptions"
    },
    "optionB": {
      "name": "genuinely different approach",
      "description": "...",
      "pros": "...",
      "cons": "...",
      "investmentRequired": "...",
      "timeToRevenue": "..."
    },
    "optionC": {
      "name": "third distinct approach",
      "description": "...",
      "pros": "...",
      "cons": "...",
      "investmentRequired": "...",
      "timeToRevenue": "..."
    },
    "recommendedOption": "which option and WHY - tie back to client's specific situation, risk tolerance, timeline, capabilities"
  },

  "keyInsights": [
    {
      "title": "Max 10 words. The non-obvious conclusion. Example: 'Labor cost pressure makes energy savings an HR priority'",
      "data": "The specific evidence. Example: 'Manufacturing wages rose 8% annually 2021-2024 while productivity gained only 2%. Average factory worker age is 45, up from 38 in 2014.'",
      "pattern": "The causal mechanism. Example: 'Aging workforce drives wage inflation without productivity gains. Factories facing 5-6% annual cost increases have exhausted labor optimization - energy is the next lever.'",
      "implication": "The strategic response. Example: 'Position energy efficiency as cost management, not sustainability. Target CFOs with ROI messaging. The urgency is financial, not environmental.'"
    },
    "Provide 3 insights. Each must reveal something that requires connecting multiple data points.",
    "TEST: If someone could find this insight on the first page of Google results, it's too obvious.",
    "GOOD: 'Southern Thailand's grid congestion (transmission capacity 85% utilized) blocks new solar projects, creating captive demand for on-site efficiency solutions in the $2.1B EEC industrial corridor.'"
  ],

  "implementationRoadmap": {
    "phase1": ["3-5 specific actions for months 0-6 - just the action, no month prefix"],
    "phase2": ["3-5 specific actions for months 6-12 that BUILD on phase 1"],
    "phase3": ["3-5 specific actions for months 12-24 with revenue milestones"]
  },

  "riskAssessment": {
    "criticalRisks": [
      {"risk": "specific risk", "likelihood": "high/medium/low", "impact": "description", "mitigation": "specific countermeasure"}
    ],
    "goNoGoCriteria": ["specific, measurable criteria that must be true to proceed - not vague conditions"]
  },

  "nextSteps": ["5 specific actions to take THIS WEEK with owner and deliverable"],

  "slideHeadlines": {
    "summary": "THE HOOK. Max 8 words. What's the opportunity? Example: '$160M market, no foreign winner yet'",
    "marketData": "THE SIZE. Max 8 words. How big? Example: '1,200 factories spending $500K each on electricity'",
    "competition": "THE GAP. Max 8 words. Where's the opening? Example: 'Local giants need foreign technology partners'",
    "regulation": "THE RULES. Max 8 words. What's required? Example: 'Need Thai partner, but tax breaks available'",
    "risks": "THE WATCH-OUTS. Max 8 words. What could kill this? Example: 'Wrong partner choice is the biggest risk'"
  }
}

CRITICAL QUALITY STANDARDS:
1. DEPTH OVER BREADTH. One well-supported insight beats five superficial observations. Every claim needs evidence.
2. CAUSAL REASONING. Don't just describe - explain WHY. "X happened because Y, which means Z for the client."
3. SPECIFICITY. Every number needs a year. Every company needs context. Every regulation needs an enforcement reality check.
4. COMPETITIVE EDGE. The reader should learn something they couldn't find in an hour of desk research.
5. ACTIONABLE CONCLUSIONS. End each section with what the reader should DO with this information.
6. PROFESSIONAL PROSE. Write like The Economist - clear, precise, analytical. Use technical terms where they add precision, but always explain significance.
7. COMPANY DESCRIPTIONS: Every company in keyPlayers and potentialPartners MUST have a "description" field with 45-55 words. Include revenue, growth rate, market share, key services, geographic coverage, and competitive advantages. NEVER write generic one-liners like "X is a company that provides Y" — include specific metrics and strategic context.
8. WEBSITE URLs: Every company MUST have a "website" field with the company's actual corporate website URL.`;

  const result = await callKimiAnalysis(prompt, systemPrompt, 12000);

  let synthesis;
  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    synthesis = JSON.parse(jsonStr);
    synthesis.isSingleCountry = true;
    synthesis.country = countryAnalysis.country;
  } catch (error) {
    console.error('Failed to parse single country synthesis:', error?.message);
    return {
      isSingleCountry: true,
      country: countryAnalysis.country,
      executiveSummary: ['Deep analysis parsing failed - raw content available'],
      rawContent: result.content,
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

  const result = await callKimiAnalysis(prompt, systemPrompt, 12000);

  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error('Failed to parse synthesis:', error?.message);
    return {
      executiveSummary: ['Synthesis parsing failed - raw content available'],
      rawContent: result.content,
    };
  }
}

module.exports = {
  identifyResearchGaps,
  fillResearchGaps,
  reSynthesize,
  researchCountry,
  reviewAnalysis,
  reviseAnalysis,
  synthesizeSingleCountry,
  synthesizeFindings,
  validateContentDepth,
  synthesizePolicy,
  synthesizeMarket,
  synthesizeCompetitors,
  synthesizeSummary,
};
