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
 * Synthesize with fallback chain: Gemini → Kimi → raw text
 */
async function synthesizeWithFallback(prompt, options = {}) {
  const { maxTokens = 8192, jsonMode = true } = options;

  try {
    const result = await callGemini(prompt, { maxTokens, jsonMode, temperature: 0.2 });
    return parseJsonResponse(result);
  } catch (geminiErr) {
    console.warn(`  [Synthesis] Gemini failed: ${geminiErr?.message}, trying Kimi...`);
    try {
      const result = await callKimiChat(prompt, '', maxTokens);
      return parseJsonResponse(result.content);
    } catch (kimiErr) {
      console.error(`  [Synthesis] Kimi also failed: ${kimiErr?.message}`);
      return null;
    }
  }
}

/**
 * Synthesize POLICY section with depth requirements
 */
async function synthesizePolicy(researchData, country, industry, clientContext) {
  console.log(`  [Synthesis] Policy section for ${country}...`);

  const prompt = `You are synthesizing policy and regulatory research for ${country}'s ${industry} market.
Client context: ${clientContext}

RESEARCH DATA:
${JSON.stringify(
  Object.fromEntries(
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
  ),
  null,
  2
)}

DEPTH REQUIREMENTS (MANDATORY — FAILURE TO MEET = REJECTED OUTPUT):
- List EVERY named regulation, law, decree with year and official name
- For each: what changed, what it means for ${industry} companies
- Pre-reform vs post-reform comparison where applicable
- Specific client implications for a ${clientContext}
- At minimum 3 named regulations with years and decree numbers (e.g., "Energy Conservation Act B.E. 2535 (1992)", "Power Development Plan 2024-2037", "Carbon Tax Act 2026")
- Include enforcement reality: is this enforced or ignored?
- ACTIONABLE INSIGHT per section: end each section with "Strategic recommendation: ..." or "Opportunity: ..." or "Client should consider: ..."
- If you cannot find specific regulation names, use the most relevant laws from the country's energy/environmental regulatory framework — never leave this empty
- MANDATORY: foundationalActs.acts array MUST have at least 3 entries with name, year, requirements, and enforcement fields all populated
- MANDATORY: nationalPolicy.targets array MUST have at least 3 entries
- MANDATORY: investmentRestrictions.incentives array MUST have at least 2 entries
- If exact names are unavailable, provide the closest known regulation with "estimated" qualifier — NEVER return empty arrays
- CRITICAL: If research data is sparse, use your training knowledge about ${country}'s energy/environmental laws. Name REAL regulations — do not leave arrays empty.

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
  const validated = validatePolicySynthesis(
    result || {
      foundationalActs: { acts: [] },
      nationalPolicy: { targets: [] },
      investmentRestrictions: {},
    }
  );
  return validated;
}

/**
 * Synthesize MARKET section with depth requirements
 */
async function synthesizeMarket(researchData, country, industry, clientContext) {
  console.log(`  [Synthesis] Market section for ${country}...`);

  const prompt = `You are synthesizing market data research for ${country}'s ${industry} market.
Client context: ${clientContext}

RESEARCH DATA:
${JSON.stringify(
  Object.fromEntries(
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
  ),
  null,
  2
)}

DEPTH REQUIREMENTS (MANDATORY — FAILURE TO MEET = REJECTED OUTPUT):
- At least 3 time-series datasets with 5+ data points each
- Forward projections to 2050 where available
- Sector breakdowns with percentages
- Prices in client's currency (JPY for Japanese clients, USD otherwise)
- Source citations for key data
- Each data point accompanied by "so what" insight explaining client implication
- MINIMUM 15 quantified data points across all sections (e.g., "$320M market size", "14% CAGR", "45 GW installed capacity", "23% renewable share")
- Every section MUST end with a "keyInsight" field containing an actionable recommendation using words like "recommend", "opportunity", "should consider", "growth potential", "strategic fit"
- If exact data unavailable, provide best estimates with "estimated" qualifier — never leave fields empty
- MANDATORY: Each of the 6 sections (tpes, finalDemand, electricity, gasLng, pricing, escoMarket) MUST have a populated keyInsight field with actionable language
- MANDATORY: chartData in at least 3 sections must have series/values arrays with 3+ numeric data points
- MANDATORY: escoMarket must have marketSize (e.g., "$XXM") and growthRate (e.g., "XX% CAGR") populated
- CRITICAL: If research data lacks specific numbers, use your training knowledge to provide REAL approximate data for ${country}'s energy sector. Include market sizes, installed capacities, consumption figures, growth rates. NEVER leave numeric fields empty.
- EVERY keyInsight MUST contain at least one of: "recommend", "opportunity", "should consider", "growth potential", "strategic fit", "next steps", "outlook"

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
  const validated = validateMarketSynthesis(
    result || {
      tpes: {},
      finalDemand: {},
      electricity: {},
      gasLng: {},
      pricing: {},
      escoMarket: {},
    }
  );
  return validated;
}

/**
 * Synthesize COMPETITORS section with depth requirements
 */
async function synthesizeCompetitors(researchData, country, industry, clientContext) {
  console.log(`  [Synthesis] Competitors section for ${country}...`);

  const prompt = `You are synthesizing competitive intelligence for ${country}'s ${industry} market.
Client context: ${clientContext}

RESEARCH DATA:
${JSON.stringify(
  Object.fromEntries(
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
  ),
  null,
  2
)}

DEPTH REQUIREMENTS (MANDATORY — FAILURE TO MEET = REJECTED OUTPUT):
- At least 3 named companies per category with: investment year, structure (JV/acquisition/greenfield), stake %, partner name, revenue
- At least 1 detailed case study per major competitor: customer name, what they did, outcome (CO2 tons, MW, revenue)
- For each company: description of 50+ words with revenue, market share, growth rate, key services, geographic coverage, and strategic significance
- Website URLs for ALL companies — use the company's actual corporate website (e.g., "https://www.engie.com"). NEVER omit this field. Every player object MUST have a "website" field starting with "https://".
- For each data point: "so what" — what it means for the client
- ACTIONABLE INSIGHT per category: end each players section with "marketInsight" or "competitiveInsight" using language like "recommend approaching", "opportunity to partner", "strategic fit because", "should consider acquiring"
- If you cannot find exact revenue/market share, provide estimates with "estimated" qualifier — never leave description fields empty or under 50 words
- MANDATORY: japanesePlayers.players must have at least 2 entries, localMajor.players at least 3 entries, foreignPlayers.players at least 2 entries
- MANDATORY: Every player description must be 50+ words. If you lack specific data, describe the company's general capabilities, market positioning, estimated scale, and strategic relevance
- MANDATORY: caseStudy must have company, entryYear, entryMode, investment, and outcome all populated with specific data
- CRITICAL: If research data is sparse, use your training knowledge to name REAL companies operating in ${country}'s ${industry} sector. Include their actual corporate website URLs. NEVER return empty player arrays.
- EVERY description must include strategic context: why this company matters, what threat/opportunity it presents, and a recommendation (e.g., "recommend approaching for JV", "should consider as acquisition target", "strategic fit for technology licensing")

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
        "description": "50+ words with specific metrics, entry strategy, project details, market position"
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
        "description": "50+ words with specific metrics"
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
        "description": "50+ words with specific metrics"
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
  const validated = validateCompetitorsSynthesis(
    result || {
      japanesePlayers: { players: [] },
      localMajor: { players: [] },
      foreignPlayers: { players: [] },
      caseStudy: {},
      maActivity: {},
    }
  );
  return validated;
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
Policy: ${JSON.stringify(policy, null, 2)}
Market: ${JSON.stringify(market, null, 2)}
Competitors: ${JSON.stringify(competitors, null, 2)}

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
)}

DEPTH REQUIREMENTS (MANDATORY — FAILURE TO MEET = REJECTED OUTPUT):
- For each opportunity: size it in dollars, name the timing window, and state "recommend" or "should consider" action
- For each barrier: rate severity, provide specific mitigation with actionable next steps
- For each insight: connect data → implication → opportunity for the client, using "strategic fit", "growth potential", "recommend"
- Timing triggers with specific dates (not "soon") — e.g., "BOI incentives expire December 2027"
- Named companies for partnerships and case studies with website URLs
- Go/No-Go with evidence-based criteria and clear "next steps" recommendations
- EVERY section must contain actionable language: "recommend", "opportunity", "should consider", "growth potential", "strategic fit", "next steps", "outlook"
- Partners in partnerAssessment MUST have "website" field with actual URL (starting with "https://") and "description" of 50+ words
- MANDATORY: partnerAssessment.partners must have at least 3 entries each with website and 50+ word description
- MANDATORY: entryStrategy.options must have exactly 3 entries (JV, Acquisition, Greenfield) with all fields populated
- MANDATORY: implementation.phases must have exactly 3 entries with activities, milestones, and investment
- MANDATORY: summary.opportunities must have at least 3 entries, summary.obstacles at least 2 entries
- MANDATORY: summary.keyInsights must have at least 3 entries with title, data, pattern, and implication
- EVERY section and sub-section MUST contain actionable language: "recommend", "opportunity", "should consider", "growth potential", "strategic fit", "next steps", "outlook"
- CRITICAL: If research data is sparse, use training knowledge to provide realistic assessments. NEVER return empty arrays or placeholder text.

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
        {"name": "Company", "website": "https://...", "type": "Type", "revenue": "$XM", "partnershipFit": 4, "acquisitionFit": 3, "estimatedValuation": "$X-YM", "description": "50+ words"}
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
  return (
    result || {
      depth: {},
      summary: { opportunities: [], obstacles: [], ratings: {}, keyInsights: [] },
    }
  );
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

  const valid = failures.length === 0 || scores.overall >= 50;

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

    const categoryResults = await Promise.all(categoryPromises);

    // Merge all results
    for (const result of categoryResults) {
      Object.assign(researchData, result);
    }

    const researchTimeTemp = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `\n  [AGENTS COMPLETE] ${Object.keys(researchData).length} topics researched in ${researchTimeTemp}s (dynamic framework)`
    );
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
      {"name": "actual company", "website": "https://company.com", "strengths": "specific", "weaknesses": "specific", "threat": "how they could block you", "description": "REQUIRED 50+ words with revenue, market share, growth rate, key services, strategic significance with revenue, market share, entry year, key projects, geographic coverage, strategic positioning, and why this player matters for competitive analysis"}
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
7. COMPANY DESCRIPTIONS: Every company in keyPlayers and potentialPartners MUST have a "description" field with 50+ words. Include revenue, growth rate, market share, key services, geographic coverage, and competitive advantages. NEVER write generic one-liners like "X is a company that provides Y" — include specific metrics and strategic context.
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
