const { callGeminiResearch, callGemini } = require('./ai-clients');
const { RESEARCH_FRAMEWORK, RESEARCH_TOPIC_GROUPS } = require('./research-framework');

/**
 * Find the outermost balanced JSON boundary starting from the first openChar.
 * Uses bracket counting instead of non-greedy regex to handle nested structures.
 */
function findJsonBoundary(text, openChar) {
  const closeChar = openChar === '{' ? '}' : ']';
  const start = text.indexOf(openChar);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === openChar) depth++;
    if (text[i] === closeChar) depth--;
    if (depth === 0) return text.substring(start, i + 1);
  }
  return null;
}

/**
 * Try multiple JSON extraction strategies
 * Returns { data, status } where status is 'success', 'parse_error', or 'no_json_found'
 */
function extractJsonFromContent(content) {
  if (!content) return { data: null, status: 'no_content' };

  // Strategy 1: Match ```json ... ``` blocks
  const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return { data: JSON.parse(jsonMatch[1]), status: 'success' };
    } catch (e) {
      console.log(`      [JSON] Strategy 1 (json block) parse error: ${e.message}`);
    }
  }

  // Strategy 2: Match ``` ... ``` blocks (no json label)
  const codeMatch = content.match(/```\s*([\s\S]*?)\s*```/);
  if (codeMatch) {
    try {
      return { data: JSON.parse(codeMatch[1]), status: 'success' };
    } catch (e) {
      console.log(`      [JSON] Strategy 2 (code block) parse error: ${e.message}`);
    }
  }

  // Strategy 2.5: Bracket-counting for [...] array
  const arrayStr = findJsonBoundary(content, '[');
  if (arrayStr) {
    try {
      return { data: JSON.parse(arrayStr), status: 'success' };
    } catch (e) {
      console.log(`      [JSON] Strategy 2.5 (array bracket-count) parse error: ${e.message}`);
    }
  }

  // Strategy 3: Parse entire content as JSON
  try {
    return { data: JSON.parse(content), status: 'success' };
  } catch (e) {
    // Not valid JSON
  }

  // Strategy 4: Bracket-counting for {...} object
  const objectStr = findJsonBoundary(content, '{');
  if (objectStr) {
    try {
      return { data: JSON.parse(objectStr), status: 'success' };
    } catch (e) {
      console.log(`      [JSON] Strategy 4 (object bracket-count) parse error: ${e.message}`);
    }
  }

  return { data: null, status: 'no_json_found' };
}

/**
 * Validate extracted JSON structure per agent type.
 * Returns true if valid, false if incomplete. Sets dataQuality to 'incomplete' on failure.
 */
function validatePolicyData(data) {
  if (!data) return false;
  const acts = data.foundationalActs || data.acts;
  if (!Array.isArray(acts) || acts.length === 0) return false;
  return acts.every((act) => act.name && act.year);
}

function validateMarketData(data) {
  if (!data) return false;
  const chartData = data.chartData;
  if (!chartData) return false;
  // Check for series array with numeric values in either historical or projected or top-level
  const series = chartData.series || chartData.historical?.series || chartData.projected?.series;
  if (!Array.isArray(series) || series.length === 0) return false;
  return series.every(
    (s) => Array.isArray(s.values) && s.values.every((v) => typeof v === 'number')
  );
}

function validateCompetitorData(data) {
  if (!data) return false;
  if (!Array.isArray(data.players) || data.players.length === 0) return false;
  return data.players.every(
    (p) =>
      p.name &&
      p.description &&
      typeof p.description === 'string' &&
      p.description.split(/\s+/).length >= 45 &&
      p.website
  );
}

// Policy Research Agent - handles regulatory and policy topics
async function policyResearchAgent(country, industry, _clientContext, pipelineSignal = null) {
  console.log(`    [POLICY AGENT] Starting research for ${country}...`);
  const agentStart = Date.now();
  const topics = RESEARCH_TOPIC_GROUPS.policy;
  const results = {};

  // Run all policy topics in parallel with per-topic timeout
  const policyResults = await Promise.all(
    topics.map(async (topicKey) => {
      const framework = RESEARCH_FRAMEWORK[topicKey];
      if (!framework) return null;

      const queryContext = `DO NOT fabricate data. DO NOT invent numbers, company names, law names, or statistics. If data is unavailable, say so explicitly.

For every data point, include EXACT document name as source (e.g., 'PDP8', 'Petroleum Law No. 12/2022/QH15'). Return sources as document names, NOT URLs.

As a regulatory affairs specialist, research ${framework.name} for ${country}'s ${industry} market:

SPECIFIC QUESTIONS:
${(framework.queries || []).map((q) => '- ' + q.replace('{country}', country)).join('\n')}

FOCUS ON:
- Exact law names, years enacted, enforcement status
- Foreign ownership percentages and exceptions
- Tax incentives with specific values and durations
- Recent policy changes (2023-2025)
- Regulatory risks and enforcement gaps

CRITICAL - RETURN STRUCTURED DATA:
Your response MUST include a JSON block with policy data. Use this EXACT format:

\`\`\`json
{
  "narrative": "Your detailed research findings here (2-3 paragraphs with specific numbers, sources)",
  "foundationalActs": [
    { "name": "Act Name", "year": 2024, "enforcement": "enforced/voluntary/planned", "keyRequirements": ["req1", "req2"] }
  ],
  "foreignOwnership": {
    "general": "49%",
    "boiPromoted": "100%",
    "exceptions": "List specific exceptions for energy sector",
    "notes": "Additional context"
  },
  "incentives": [
    { "name": "Incentive Name", "benefit": "100% allowance on CAPEX for 5 years", "eligibility": "Who qualifies", "value": "specific % or amount" }
  ],
  "nationalTargets": [
    { "target": "30% renewable by 2030", "status": "on-track/behind/ahead", "baseline": "15% in 2020" }
  ],
  "escoRegulations": {
    "registrationRequired": true,
    "licensingBody": "Name of agency",
    "requirements": ["requirement 1", "requirement 2"],
    "penalties": "Description of non-compliance penalties"
  },
  "keyRisks": [
    { "risk": "Policy reversal risk", "severity": "high/medium/low", "mitigation": "How to address" }
  ],
  "dataQuality": "high/medium/low",
  "sources": ["Source 1", "Source 2"]
}
\`\`\`

REQUIREMENTS:
- Use REAL data from official sources - do NOT fabricate information
- Include specific percentages, years, and monetary values where available
- Mark dataQuality as "low" if information is estimated or uncertain`;

      let result;
      try {
        result = await Promise.race([
          callGeminiResearch(queryContext, country, industry, pipelineSignal),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Policy topic "${topicKey}" timed out after 180s`)),
              180000
            )
          ),
        ]);
      } catch (timeoutErr) {
        console.warn(`      [Policy] ${topicKey}: ${timeoutErr.message}`);
        result = { content: '', citations: [], researchQuality: 'failed' };
      }

      // Extract structured JSON using multi-strategy extraction
      let extractResult = extractJsonFromContent(result.content);
      let structuredData = extractResult.data;
      let extractionStatus = extractResult.status;

      // Retry once with simplified prompt if extraction failed
      if (extractionStatus !== 'success' && result.content) {
        console.log(
          `      [Policy] ${topicKey}: JSON extraction failed (${extractionStatus}), retrying...`
        );
        const retryQuery = `${queryContext}\n\nCRITICAL: Return ONLY valid JSON. No explanation, no markdown. Just the raw JSON object.`;
        result = await callGeminiResearch(retryQuery, country, industry, pipelineSignal);
        if (!result || !result.content) {
          result = { content: '', citations: [], researchQuality: 'failed' };
        }
        extractResult = extractJsonFromContent(result.content);
        structuredData = extractResult.data;
        extractionStatus = extractResult.status;
        if (extractionStatus === 'success') {
          console.log(`      [Policy] ${topicKey}: Retry successful`);
        }
      }

      // Validate policy-specific structure
      let dataQuality = structuredData?.dataQuality || 'unknown';
      if (structuredData && !validatePolicyData(structuredData)) {
        console.log(`      [Policy] ${topicKey}: validation failed — missing acts with name/year`);
        dataQuality = 'incomplete';
      }

      return {
        key: topicKey,
        content: result.content,
        structuredData: structuredData,
        extractionStatus: extractionStatus,
        citations: result.citations || [],
        slideTitle: framework.slideTitle?.replace('{country}', country) || '',
        dataQuality: dataQuality,
      };
    })
  );

  let droppedCount = 0;
  for (const r of policyResults) {
    if (r && r.content) {
      results[r.key] = r;
    } else if (r) {
      droppedCount++;
      console.log(`      [POLICY] Dropped empty result: ${r.key}`);
    }
  }

  const successCount = Object.keys(results).length;
  console.log(
    `    [POLICY AGENT] Completed in ${((Date.now() - agentStart) / 1000).toFixed(1)}s - ${successCount} topics${droppedCount > 0 ? ` (${droppedCount} dropped)` : ''}`
  );
  return results;
}

// Market Research Agent - handles market data and pricing topics
async function marketResearchAgent(country, industry, _clientContext, pipelineSignal = null) {
  console.log(`    [MARKET AGENT] Starting research for ${country}...`);
  const agentStart = Date.now();
  const topics = RESEARCH_TOPIC_GROUPS.market;
  const results = {};

  // Run market topics in batches of 3 (more topics)
  for (let i = 0; i < topics.length; i += 3) {
    const batch = topics.slice(i, i + 3);

    const batchResults = await Promise.all(
      batch.map(async (topicKey) => {
        const framework = RESEARCH_FRAMEWORK[topicKey];
        if (!framework) return null;

        // Determine chart structure based on chartType - extended to support 2000-2050 projections
        const chartStructure =
          framework.chartType === 'stackedBar'
            ? `"chartData": {
              "historical": {
                "categories": ["2000", "2005", "2010", "2015", "2020", "2023"],
                "series": [
                  {"name": "Category1", "values": [number, number, number, number, number, number]},
                  {"name": "Category2", "values": [number, number, number, number, number, number]}
                ]
              },
              "projected": {
                "categories": ["2025", "2030", "2040", "2050"],
                "series": [
                  {"name": "Category1", "values": [number, number, number, number]},
                  {"name": "Category2", "values": [number, number, number, number]}
                ]
              },
              "unit": "Mtoe or TWh or bcm",
              "projectionSource": "IEA/Government target/Industry estimate"
            }`
            : framework.chartType === 'pie'
              ? `"chartData": {
              "current": {
                "year": "2023",
                "categories": ["Segment1", "Segment2", "Segment3"],
                "values": [percentage, percentage, percentage]
              },
              "projected": {
                "year": "2030",
                "categories": ["Segment1", "Segment2", "Segment3"],
                "values": [percentage, percentage, percentage]
              },
              "unit": "%"
            }`
              : framework.chartType === 'line'
                ? `"chartData": {
              "historical": {
                "categories": ["2018", "2019", "2020", "2021", "2022", "2023", "2024"],
                "series": [
                  {"name": "Metric1", "values": [number, number, number, number, number, number, number]}
                ]
              },
              "projected": {
                "categories": ["2025", "2026", "2027", "2028", "2029", "2030"],
                "series": [
                  {"name": "Metric1", "values": [number, number, number, number, number, number]}
                ]
              },
              "unit": "USD/kWh or USD/mmbtu"
            }`
                : '';

        const queryContext = `DO NOT fabricate data. DO NOT invent numbers, company names, law names, or statistics. If data is unavailable, say so explicitly.

For every data point, include EXACT document name as source (e.g., 'PDP8', 'Petroleum Law No. 12/2022/QH15'). Return sources as document names, NOT URLs.

CRITICAL - NAMED PROJECT DATA:
For each energy source, list SPECIFIC named projects:
- Project name, location, capacity (GW/MW), status, developer, year, investment value
- Include percentage growth rates between periods

As a market research analyst, research ${framework.name} for ${country}'s ${industry} market:

SPECIFIC QUESTIONS:
${(framework.queries || []).map((q) => '- ' + q.replace('{country}', country)).join('\n')}

CRITICAL - RETURN STRUCTURED DATA:
Your response MUST include a JSON block with chart data. Use this EXACT format:

\`\`\`json
{
  "narrative": "Your detailed research findings here (2-3 paragraphs with specific numbers, sources, and insights)",
  ${chartStructure ? chartStructure + ',' : ''}
  "marketBreakdown": {
    "totalPrimaryEnergySupply": {
      "naturalGasPercent": "X%",
      "renewablePercent": "X%",
      "nonRenewablePercent": "X%"
    },
    "totalFinalConsumption": {
      "industryPercent": "X%",
      "transportPercent": "X%",
      "otherPercent": "X%"
    },
    "electricityGeneration": {
      "current": "X TWh",
      "projected2030": "X TWh"
    }
  },
  "infrastructureCapacity": {
    "lngImportCurrent": "X bcm/year",
    "lngImportPlanned": "X bcm/year by YEAR",
    "pipelineCapacity": "X bcm/year"
  },
  "priceComparison": {
    "generationCost": "X USD/kWh",
    "retailPrice": "X USD/kWh",
    "industrialRate": "X USD/kWh"
  },
  "keyInsight": "One sentence insight about the trend or implication",
  "dataQuality": "high/medium/low - indicate if data is from official sources or estimated",
  "sources": ["Source 1", "Source 2"]
}
\`\`\`

REQUIREMENTS:
- Use REAL numbers from your research - do NOT fabricate data
- Include historical data back to 2000 where available
- Include projections to 2030/2040/2050 based on government targets or industry forecasts
- If exact data unavailable, use "estimated" in dataQuality and provide reasonable estimates
- Include units (Mtoe, TWh, USD/kWh, bcm, %, etc.)
- Market sizes should be in USD millions or billions
- Cite projection sources (IEA, national plans, industry reports)`;

        let result;
        try {
          result = await Promise.race([
            callGeminiResearch(queryContext, country, industry, pipelineSignal),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`Market topic "${topicKey}" timed out after 180s`)),
                180000
              )
            ),
          ]);
        } catch (timeoutErr) {
          console.warn(`      [Market] ${topicKey}: ${timeoutErr.message}`);
          result = { content: '', citations: [], researchQuality: 'failed' };
        }

        // JSON extraction (multi-strategy with retry)
        let extractResult = extractJsonFromContent(result.content);
        let structuredData = extractResult.data;
        let extractionStatus = extractResult.status;

        // Bug 8 fix: track content/citations that may update on retry
        let finalContent = result.content;
        let finalCitations = result.citations || [];

        if (extractionStatus !== 'success' && result.content) {
          console.log(
            `      [Market] ${topicKey}: extraction failed (${extractionStatus}), retrying...`
          );
          const retryQuery = `${queryContext}\n\nCRITICAL: Return ONLY valid JSON. No explanation, no markdown. Just the raw JSON object.`;
          const retryResult = await callGeminiResearch(
            retryQuery,
            country,
            industry,
            pipelineSignal
          );
          if (retryResult && retryResult.content) {
            extractResult = extractJsonFromContent(retryResult.content);
            structuredData = extractResult.data;
            extractionStatus = extractResult.status;
            if (extractionStatus === 'success') {
              console.log(`      [Market] ${topicKey}: Retry successful`);
              finalContent = retryResult.content;
              finalCitations = retryResult.citations || [];
            }
          }
        }

        // Validate market-specific structure
        let dataQuality = structuredData?.dataQuality || 'unknown';
        if (structuredData && !validateMarketData(structuredData)) {
          console.log(
            `      [Market] ${topicKey}: validation failed — missing chartData.series with numeric values`
          );
          dataQuality = 'incomplete';
        }

        return {
          key: topicKey,
          content: finalContent,
          structuredData: structuredData,
          extractionStatus: extractionStatus,
          citations: finalCitations,
          chartType: framework.chartType || null,
          slideTitle: framework.slideTitle?.replace('{country}', country) || '',
          dataQuality: dataQuality,
        };
      })
    );

    for (const r of batchResults) {
      if (r && r.content) {
        results[r.key] = r;
      } else if (r) {
        console.log(`      [MARKET] Dropped empty result: ${r.key}`);
      }
    }

    // Brief pause between batches
    if (i + 3 < topics.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const successCount = Object.keys(results).length;
  const attemptedCount = topics.length;
  const droppedCount = attemptedCount - successCount;
  console.log(
    `    [MARKET AGENT] Completed in ${((Date.now() - agentStart) / 1000).toFixed(1)}s - ${successCount}/${attemptedCount} topics${droppedCount > 0 ? ` (${droppedCount} dropped)` : ''}`
  );
  return results;
}

// Competitor Research Agent - handles competitive intelligence
async function competitorResearchAgent(country, industry, _clientContext, pipelineSignal = null) {
  console.log(`    [COMPETITOR AGENT] Starting research for ${country}...`);
  const agentStart = Date.now();
  const topics = RESEARCH_TOPIC_GROUPS.competitors;
  const results = {};

  // Run competitor topics in parallel
  const compResults = await Promise.all(
    topics.map(async (topicKey) => {
      const framework = RESEARCH_FRAMEWORK[topicKey];
      if (!framework) return null;

      const isJapanese = topicKey === 'competitors_japanese';
      const queryContext = `DO NOT fabricate data. DO NOT invent numbers, company names, law names, or statistics. If data is unavailable, say so explicitly.

For every data point, include EXACT document name as source (e.g., 'PDP8', 'Petroleum Law No. 12/2022/QH15'). Return sources as document names, NOT URLs.

As a competitive intelligence analyst, research ${framework.name} for ${country}'s ${industry} market:

SPECIFIC QUESTIONS:
${(framework.queries || []).map((q) => '- ' + q.replace('{country}', country)).join('\n')}

${
  isJapanese
    ? `SPECIAL FOCUS - JAPANESE COMPANIES:
- Tokyo Gas, Osaka Gas, JERA, Mitsubishi, Mitsui, Marubeni, Sumitomo, Itochu presence
- Entry mode (JV, subsidiary, partnership, M&A)
- Specific projects with contract values in USD
- Year of entry and current status (active/exited/expanding)
- Local partner names and ownership structures
- Success factors or reasons for failure
- Financial highlights if available (revenue, profit margin)`
    : ''
}

CRITICAL - RETURN STRUCTURED DATA:
Your response MUST include a JSON block. Use this format:

\`\`\`json
{
  "narrative": "Your detailed research findings (2-3 paragraphs)",
  "players": [
    {
      "name": "Company Name",
      "website": "https://company.com",
      "origin": "Country",
      "entryYear": "2020",
      "entryMode": "JV/Subsidiary/Direct/M&A",
      "localPartner": "Partner name or N/A",
      "ownershipPercent": "X%",
      "revenue": "$X million",
      "marketShare": "X%",
      "projects": "Key projects description",
      "contractValue": "$X million (if known)",
      "strengths": "Specific strengths",
      "weaknesses": "Specific weaknesses",
      "description": "REQUIRED 50+ words with revenue, market share, growth rate, key services, strategic significance including revenue, growth rate, market position, key services, strategic context, and why this company matters for market entry analysis",
      "status": "active/expanding/restructuring/exited",
      "partnershipInterest": "high/medium/low"
    }
  ],
  "japanesePlayers": [
    {
      "company": "Tokyo Gas/Osaka Gas/JERA/etc",
      "website": "https://company.co.jp",
      "entryMode": "JV/Subsidiary/Partnership",
      "year": "2020",
      "outcome": "Successful - $X revenue/Failed - exited in YEAR/Ongoing",
      "keyProject": "Project name and description",
      "localPartner": "Partner company name",
      "description": "REQUIRED 50+ words with revenue, market share, growth rate, key services, strategic significance of company's presence, operations, market position, and strategic significance"
    }
  ],
  "caseStudies": [
    {
      "company": "Company Name",
      "entryYear": "2018",
      "entryMode": "JV with Local Partner",
      "initialInvestment": "$X million",
      "outcome": "Success/Failure/Mixed",
      "keyLearnings": "What worked or didn't work",
      "currentStatus": "Operating/Exited/Expanded",
      "relevanceForClient": "Why this case matters for client's entry"
    }
  ],
  "escoMarketState": {
    "registeredESCOs": "Number of registered ESCO companies",
    "activeProjects": "Number of active ESCO projects",
    "marketSize": "$X million",
    "growthRate": "X% CAGR",
    "dominantSegments": ["Industrial", "Commercial", "Residential"],
    "averageProjectSize": "$X million",
    "typicalContractDuration": "X years",
    "savingsGuaranteeRange": "X-Y%"
  },
  "marketInsight": "Key competitive insight",
  "whiteSpaces": ["Underserved segment 1", "Opportunity area 2"],
  "entryBarriers": ["Barrier 1", "Barrier 2"],
  "dataQuality": "high/medium/low",
  "sources": ["Source 1", "Source 2"]
}
\`\`\`

REQUIREMENTS:
- Use REAL data from research. Mark dataQuality as "low" if information is estimated.
- For Japanese companies, be specific about project names, values, and outcomes
- Include at least one case study with detailed entry/exit analysis
- For ESCO market state, provide actual numbers where available
- EVERY company in "players" and "japanesePlayers" MUST have a "website" field with the company's actual corporate URL
- EVERY company MUST have a "description" field with 50+ words covering: revenue, growth rate, market share, key services/projects, geographic coverage, entry strategy details, and competitive significance. NO generic one-liners.`;

      let result;
      try {
        result = await Promise.race([
          callGeminiResearch(queryContext, country, industry, pipelineSignal),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Competitor topic "${topicKey}" timed out after 180s`)),
              180000
            )
          ),
        ]);
      } catch (timeoutErr) {
        console.warn(`      [Competitor] ${topicKey}: ${timeoutErr.message}`);
        result = { content: '', citations: [], researchQuality: 'failed' };
      }

      // Bug 8 fix: track content/citations that may update on retry
      let finalContent = result.content;
      let finalCitations = result.citations || [];

      // JSON extraction (multi-strategy with retry)
      let extractResult = extractJsonFromContent(result.content);
      let structuredData = extractResult.data;
      let extractionStatus = extractResult.status;

      if (extractionStatus !== 'success' && result.content) {
        console.log(
          `      [Competitor] ${topicKey}: extraction failed (${extractionStatus}), retrying...`
        );
        const retryQuery = `${queryContext}\n\nCRITICAL: Return ONLY valid JSON. No explanation, no markdown. Just the raw JSON object.`;
        const retryResult = await callGeminiResearch(retryQuery, country, industry, pipelineSignal);
        if (retryResult && retryResult.content) {
          extractResult = extractJsonFromContent(retryResult.content);
          structuredData = extractResult.data;
          extractionStatus = extractResult.status;
          if (extractionStatus === 'success') {
            console.log(`      [Competitor] ${topicKey}: Retry successful`);
            finalContent = retryResult.content;
            finalCitations = retryResult.citations || [];
          }
        }
      }

      // Validate competitor-specific structure
      let dataQuality = structuredData?.dataQuality || 'unknown';
      if (structuredData && !validateCompetitorData(structuredData)) {
        console.log(
          `      [Competitor] ${topicKey}: validation failed — missing players with name/description(45+words)/website`
        );
        dataQuality = 'incomplete';
      }

      return {
        key: topicKey,
        content: finalContent,
        structuredData: structuredData,
        extractionStatus: extractionStatus,
        citations: finalCitations,
        slideTitle: framework.slideTitle?.replace('{country}', country) || '',
        dataQuality: dataQuality,
      };
    })
  );

  for (const r of compResults) {
    if (r && r.content) results[r.key] = r;
  }

  console.log(
    `    [COMPETITOR AGENT] Completed in ${((Date.now() - agentStart) / 1000).toFixed(1)}s - ${Object.keys(results).length} topics`
  );
  return results;
}

// Context Research Agent - handles economic context and opportunities
async function contextResearchAgent(country, industry, clientContext, pipelineSignal = null) {
  console.log(`    [CONTEXT AGENT] Starting research for ${country}...`);
  const agentStart = Date.now();
  const topics = RESEARCH_TOPIC_GROUPS.context;
  const results = {};

  // Run context topics in parallel
  const contextResults = await Promise.all(
    topics.map(async (topicKey) => {
      const framework = RESEARCH_FRAMEWORK[topicKey];
      if (!framework) return null;

      const queryContext = `DO NOT fabricate data. DO NOT invent numbers, company names, law names, or statistics. If data is unavailable, say so explicitly.

For every data point, include EXACT document name as source (e.g., 'PDP8', 'Petroleum Law No. 12/2022/QH15'). Return sources as document names, NOT URLs.

As a strategy consultant advising a ${clientContext}, research ${framework.name} for ${country}'s ${industry} market:

SPECIFIC QUESTIONS:
${(framework.queries || []).map((q) => '- ' + q.replace('{country}', country)).join('\n')}

FOCUS ON:
- Actionable opportunities with sizing
- Specific risks with mitigation strategies
- Timing factors (why now vs later)
- Economic drivers affecting energy demand
- Industrial development corridors and zones

CRITICAL - RETURN STRUCTURED DATA:
Your response MUST include a JSON block. Use this format:

\`\`\`json
{
  "economicOverview": { "gdp": "$XXB", "growth": "X%", "fdiInflows": "$XB" },
  "opportunities": [{ "name": "...", "sizingEstimate": "$XM", "timing": "..." }],
  "risks": [{ "category": "...", "severity": "High/Med/Low", "mitigation": "..." }],
  "dataQuality": "high/medium/low"
}
\`\`\``;

      let result;
      try {
        result = await Promise.race([
          callGeminiResearch(queryContext, country, industry, pipelineSignal),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Context topic "${topicKey}" timed out after 180s`)),
              180000
            )
          ),
        ]);
      } catch (timeoutErr) {
        console.warn(`      [Context] ${topicKey}: ${timeoutErr.message}`);
        result = { content: '', citations: [], researchQuality: 'failed' };
      }

      // Bug 8 fix: track content/citations that may update on retry
      let finalContent = result.content;
      let finalCitations = result.citations || [];

      // Extract structured JSON
      let extractResult = extractJsonFromContent(result.content);
      let structuredData = extractResult.data;
      let extractionStatus = extractResult.status;

      if (extractionStatus !== 'success' && result.content) {
        console.log(
          `      [Context] ${topicKey}: JSON extraction failed (${extractionStatus}), retrying...`
        );
        const retryQuery = `${queryContext}\n\nCRITICAL: Return ONLY valid JSON. No explanation, no markdown. Just the raw JSON object.`;
        const retryResult = await callGeminiResearch(retryQuery, country, industry, pipelineSignal);
        if (retryResult && retryResult.content) {
          extractResult = extractJsonFromContent(retryResult.content);
          structuredData = extractResult.data;
          extractionStatus = extractResult.status;
          if (extractionStatus === 'success') {
            console.log(`      [Context] ${topicKey}: Retry successful`);
            finalContent = retryResult.content;
            finalCitations = retryResult.citations || [];
          }
        }
      }

      return {
        key: topicKey,
        content: finalContent,
        structuredData: structuredData,
        extractionStatus: extractionStatus,
        citations: finalCitations,
        slideTitle: framework.slideTitle?.replace('{country}', country) || '',
        dataQuality: structuredData?.dataQuality || 'unknown',
      };
    })
  );

  for (const r of contextResults) {
    if (r && r.content) results[r.key] = r;
  }

  console.log(
    `    [CONTEXT AGENT] Completed in ${((Date.now() - agentStart) / 1000).toFixed(1)}s - ${Object.keys(results).length} topics`
  );
  return results;
}

// Depth Research Agent - handles ESCO economics, partner assessment, entry strategy, implementation
async function depthResearchAgent(country, industry, clientContext, pipelineSignal = null) {
  console.log(`    [DEPTH AGENT] Starting deep-dive research for ${country}...`);
  const agentStart = Date.now();
  const topics = RESEARCH_TOPIC_GROUPS.depth;
  const results = {};

  // Run depth topics in parallel - these are critical for actionable recommendations
  const depthResults = await Promise.all(
    topics.map(async (topicKey) => {
      const framework = RESEARCH_FRAMEWORK[topicKey];
      if (!framework) return null;

      const isEconomics = topicKey === 'depth_escoEconomics';
      const isPartner = topicKey === 'depth_partnerAssessment';
      const isEntry = topicKey === 'depth_entryStrategy';

      // Determine JSON structure based on topic type
      let jsonStructure = '';
      if (isEconomics) {
        jsonStructure = `

AFTER your analysis, provide a JSON block with structured data:
\`\`\`json
{
  "contractModels": [
    { "type": "shared_savings|guaranteed_savings|hybrid", "typicalSplit": "60/40", "prevalence": "high|medium|low" }
  ],
  "dealMetrics": {
    "typicalSizeUsd": { "min": 0, "max": 0, "unit": "USD" },
    "durationYears": { "min": 0, "max": 0 },
    "paybackYears": { "min": 0, "max": 0 },
    "irrPercent": { "min": 0, "max": 0 }
  },
  "financingOptions": ["bank loan", "lease", "internal funding"],
  "dataQuality": "high|medium|low|estimated"
}
\`\`\``;
      } else if (isPartner) {
        jsonStructure = `

AFTER your analysis, provide a JSON block with structured data:
\`\`\`json
{
  "partners": [
    {
      "name": "Company Name",
      "ownership": "public|private|state-owned",
      "revenueUsd": 0,
      "employees": 0,
      "capabilities": ["capability1", "capability2"],
      "existingPartnerships": ["partner1"],
      "acquisitionLikelihood": 1-5,
      "valuationRangeUsd": { "min": 0, "max": 0 },
      "strengths": ["strength1"],
      "concerns": ["concern1"]
    }
  ],
  "dataQuality": "high|medium|low|estimated"
}
\`\`\``;
      } else if (isEntry) {
        jsonStructure = `

AFTER your analysis, provide a JSON block with structured data:
\`\`\`json
{
  "entryOptions": [
    {
      "mode": "joint_venture|acquisition|greenfield|partnership",
      "timelineMonths": { "min": 0, "max": 0 },
      "investmentUsd": { "min": 0, "max": 0 },
      "controlLevel": "high|medium|low",
      "pros": ["pro1", "pro2"],
      "cons": ["con1", "con2"],
      "risks": ["risk1"]
    }
  ],
  "recommendedOption": "joint_venture|acquisition|greenfield|partnership",
  "recommendationRationale": "Why this option is best",
  "dataQuality": "high|medium|low|estimated"
}
\`\`\``;
      }

      const queryContext = `DO NOT fabricate data. DO NOT invent numbers, company names, law names, or statistics. If data is unavailable, say so explicitly.

For every data point, include EXACT document name as source (e.g., 'PDP8', 'Petroleum Law No. 12/2022/QH15'). Return sources as document names, NOT URLs.

As a senior M&A advisor helping a ${clientContext} enter ${country}'s ${industry} market, research ${framework.name}:

SPECIFIC QUESTIONS:
${(framework.queries || []).map((q) => '- ' + q.replace('{country}', country)).join('\n')}

${
  isEconomics
    ? `CRITICAL - PROVIDE SPECIFIC NUMBERS:
- Typical ESCO contract size (USD range)
- Contract duration (years)
- Shared savings split (% client vs ESCO)
- Payback period (years)
- IRR expectations (%)
- Common financing structures`
    : ''
}

${
  isPartner
    ? `CRITICAL - FOR EACH POTENTIAL PARTNER:
- Company name and ownership
- Annual revenue (USD)
- Number of employees
- Technical capabilities
- Current partnerships
- Acquisition likelihood (1-5 scale)
- Estimated valuation range`
    : ''
}

${
  isEntry
    ? `CRITICAL - COMPARE OPTIONS:
- Joint Venture: requirements, timeline, control level
- Acquisition: targets, valuations, integration challenges
- Greenfield: timeline, costs, risks
- Recommend best option with reasoning`
    : ''
}

DEPTH IS CRITICAL - We need specifics for executive decision-making, not general observations.${jsonStructure}`;

      let result;
      try {
        result = await Promise.race([
          callGeminiResearch(queryContext, country, industry, pipelineSignal),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Depth topic "${topicKey}" timed out after 180s`)),
              180000
            )
          ),
        ]);
      } catch (timeoutErr) {
        console.warn(`      [Depth] ${topicKey}: ${timeoutErr.message}`);
        result = { content: '', citations: [], researchQuality: 'failed' };
      }

      // Bug 8 fix: track content/citations that may update on retry
      let finalContent = result.content;
      let finalCitations = result.citations || [];

      // JSON extraction (multi-strategy with retry)
      let extractResult = extractJsonFromContent(result.content);
      let structuredData = extractResult.data;
      let extractionStatus = extractResult.status;

      if (extractionStatus !== 'success' && result.content) {
        console.log(
          `      [Depth] ${topicKey}: extraction failed (${extractionStatus}), retrying...`
        );
        const retryQuery = `${queryContext}\n\nCRITICAL: Return ONLY valid JSON. No explanation, no markdown. Just the raw JSON object.`;
        const retryResult = await callGeminiResearch(retryQuery, country, industry, pipelineSignal);
        if (retryResult && retryResult.content) {
          extractResult = extractJsonFromContent(retryResult.content);
          structuredData = extractResult.data;
          extractionStatus = extractResult.status;
          if (extractionStatus === 'success') {
            console.log(`      [Depth] ${topicKey}: Retry successful`);
            finalContent = retryResult.content;
            finalCitations = retryResult.citations || [];
          }
        }
      }
      const dataQuality = structuredData?.dataQuality || 'unknown';

      return {
        key: topicKey,
        content: finalContent,
        citations: finalCitations,
        slideTitle: framework.slideTitle?.replace('{country}', country) || '',
        structuredData,
        extractionStatus,
        dataQuality,
        researchQuality: result.researchQuality || 'unknown',
      };
    })
  );

  for (const r of depthResults) {
    if (r && r.content) results[r.key] = r;
  }

  console.log(
    `    [DEPTH AGENT] Completed in ${((Date.now() - agentStart) / 1000).toFixed(1)}s - ${Object.keys(results).length} topics`
  );
  return results;
}

// Insights Research Agent - handles non-obvious intelligence: failures, timing, competitive dynamics
async function insightsResearchAgent(country, industry, clientContext, pipelineSignal = null) {
  console.log(`    [INSIGHTS AGENT] Starting intelligence gathering for ${country}...`);
  const agentStart = Date.now();
  const topics = RESEARCH_TOPIC_GROUPS.insights;
  const results = {};

  // Run insight queries in parallel - these uncover non-obvious intelligence
  const insightResults = await Promise.all(
    topics.map(async (topicKey) => {
      const framework = RESEARCH_FRAMEWORK[topicKey];
      if (!framework) return null;

      const isFailures = topicKey === 'insight_failures';
      const isTiming = topicKey === 'insight_timing';
      const isCompetitive = topicKey === 'insight_competitive';
      const isRegulatory = topicKey === 'insight_regulatory';

      // Determine JSON structure based on insight type
      let jsonStructure = '';
      if (isFailures) {
        jsonStructure = `

AFTER your analysis, provide a JSON block with structured data:
\`\`\`json
{
  "failureCases": [
    {
      "company": "Company Name",
      "year": 2020,
      "outcome": "exited|failed|withdrew",
      "reasons": ["reason1", "reason2"],
      "lessonsLearned": ["lesson1", "lesson2"]
    }
  ],
  "warningSignsToWatch": ["sign1", "sign2"],
  "riskFactors": ["risk1", "risk2"],
  "dataQuality": "high|medium|low|estimated"
}
\`\`\``;
      } else if (isTiming) {
        jsonStructure = `

AFTER your analysis, provide a JSON block with structured data:
\`\`\`json
{
  "deadlines": [
    {
      "event": "Event description",
      "date": "YYYY-MM or YYYY",
      "type": "incentive_expiry|compliance_deadline|policy_change|opportunity_window",
      "impact": "high|medium|low",
      "actionRequired": "What to do before deadline"
    }
  ],
  "optimalEntryWindow": {
    "start": "YYYY-MM",
    "end": "YYYY-MM",
    "rationale": "Why this window"
  },
  "dataQuality": "high|medium|low|estimated"
}
\`\`\``;
      } else if (isCompetitive) {
        jsonStructure = `

AFTER your analysis, provide a JSON block with structured data:
\`\`\`json
{
  "acquisitionTargets": [
    { "company": "Name", "reason": "Why seeking buyer/partner", "estimatedValue": "USD range" }
  ],
  "competitorWeaknesses": [
    { "competitor": "Name", "weakness": "Description", "exploitability": "high|medium|low" }
  ],
  "underservedSegments": [
    { "segment": "Description", "size": "USD or units", "opportunity": "How to capture" }
  ],
  "pricingPressures": ["pressure1", "pressure2"],
  "dataQuality": "high|medium|low|estimated"
}
\`\`\``;
      } else if (isRegulatory) {
        jsonStructure = `

AFTER your analysis, provide a JSON block with structured data:
\`\`\`json
{
  "enforcementReality": {
    "officialPolicy": "What regulations say",
    "actualEnforcement": "What really happens",
    "enforcementRate": "percentage if known"
  },
  "agencyCapacity": {
    "agency": "Name",
    "staffLevel": "adequate|understaffed|severely_understaffed",
    "constraints": ["constraint1", "constraint2"]
  },
  "navigationTips": ["tip1", "tip2"],
  "redFlags": ["flag1", "flag2"],
  "dataQuality": "high|medium|low|estimated"
}
\`\`\``;
      }

      const queryContext = `DO NOT fabricate data. DO NOT invent numbers, company names, law names, or statistics. If data is unavailable, say so explicitly.

For every data point, include EXACT document name as source (e.g., 'PDP8', 'Petroleum Law No. 12/2022/QH15'). Return sources as document names, NOT URLs.

As a competitive intelligence analyst helping a ${clientContext} evaluate ${country}'s ${industry} market, research ${framework.name}:

QUESTIONS TO ANSWER:
${(framework.queries || []).map((q) => '- ' + q.replace('{country}', country)).join('\n')}

${
  isFailures
    ? `CRITICAL - FIND SPECIFIC EXAMPLES:
- Name companies that failed or exited
- Identify specific reasons for failure
- Extract lessons learned
- Note warning signs to watch for`
    : ''
}

${
  isTiming
    ? `CRITICAL - IDENTIFY SPECIFIC DEADLINES:
- Incentive expiration dates (month/year)
- Regulatory compliance deadlines
- Policy implementation timelines
- Windows of opportunity closing`
    : ''
}

${
  isCompetitive
    ? `CRITICAL - FIND ACTIONABLE INTELLIGENCE:
- Companies actively seeking partners/buyers
- Competitors' known weaknesses
- Underserved regions or segments
- Pricing and margin pressures`
    : ''
}

${
  isRegulatory
    ? `CRITICAL - DISTINGUISH RHETORIC FROM REALITY:
- Actual enforcement statistics
- Agencies' real capacity constraints
- Which regulations are enforced vs ignored
- How companies navigate the system`
    : ''
}

This intelligence is for CEO-level decision making. We need SPECIFIC names, dates, numbers - not generic observations.${jsonStructure}`;

      let result;
      try {
        result = await Promise.race([
          callGeminiResearch(queryContext, country, industry, pipelineSignal),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Insights topic "${topicKey}" timed out after 180s`)),
              180000
            )
          ),
        ]);
      } catch (timeoutErr) {
        console.warn(`      [Insights] ${topicKey}: ${timeoutErr.message}`);
        result = { content: '', citations: [], researchQuality: 'failed' };
      }

      // Bug 8 fix: track content/citations that may update on retry
      let finalContent = result.content;
      let finalCitations = result.citations || [];

      // JSON extraction (multi-strategy with retry)
      let extractResult = extractJsonFromContent(result.content);
      let structuredData = extractResult.data;
      let extractionStatus = extractResult.status;

      if (extractionStatus !== 'success' && result.content) {
        console.log(
          `      [Insights] ${topicKey}: extraction failed (${extractionStatus}), retrying...`
        );
        const retryQuery = `${queryContext}\n\nCRITICAL: Return ONLY valid JSON. No explanation, no markdown. Just the raw JSON object.`;
        const retryResult = await callGeminiResearch(retryQuery, country, industry, pipelineSignal);
        if (retryResult && retryResult.content) {
          extractResult = extractJsonFromContent(retryResult.content);
          structuredData = extractResult.data;
          extractionStatus = extractResult.status;
          if (extractionStatus === 'success') {
            console.log(`      [Insights] ${topicKey}: Retry successful`);
            finalContent = retryResult.content;
            finalCitations = retryResult.citations || [];
          }
        }
      }
      const dataQuality = structuredData?.dataQuality || 'unknown';

      return {
        key: topicKey,
        content: finalContent,
        citations: finalCitations,
        slideTitle: framework.slideTitle?.replace('{country}', country) || '',
        structuredData,
        extractionStatus,
        dataQuality,
        researchQuality: result.researchQuality || 'unknown',
      };
    })
  );

  for (const r of insightResults) {
    if (r && r.content) results[r.key] = r;
  }

  console.log(
    `    [INSIGHTS AGENT] Completed in ${((Date.now() - agentStart) / 1000).toFixed(1)}s - ${Object.keys(results).length} topics`
  );
  return results;
}

// ============ UNIVERSAL RESEARCH AGENT ============
// Uses dynamic framework to research any industry/country

async function universalResearchAgent(
  category,
  topics,
  country,
  industry,
  clientContext,
  projectType,
  pipelineSignal = null
) {
  console.log(`    [${category.toUpperCase()} AGENT] Starting research for ${country}...`);
  const agentStart = Date.now();
  const results = {};

  // Run all topics in parallel with per-topic timeout
  const topicResults = await Promise.all(
    topics.map(async (topic, idx) => {
      const queryContext = `DO NOT fabricate data. DO NOT invent numbers, company names, law names, or statistics. If data is unavailable, say so explicitly.

For every data point, include EXACT document name as source (e.g., 'PDP8', 'Petroleum Law No. 12/2022/QH15'). Return sources as document names, NOT URLs.

As a senior consultant advising a ${clientContext} on a ${projectType} project, research ${topic.name} for ${country}'s ${industry} market:

SPECIFIC QUESTIONS:
${(topic.queries || []).map((q) => '- ' + q.replace(/{country}/g, country)).join('\n')}

REQUIREMENTS:
- Provide SPECIFIC data: numbers, company names, dates, deal sizes
- If data is unavailable, clearly state "data not available" rather than guessing
- Focus on actionable intelligence, not general observations
- Include recent developments (2023-2024)`;

      try {
        // Per-topic timeout: 180s.
        const result = await Promise.race([
          callGeminiResearch(queryContext, country, industry, pipelineSignal),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Topic "${topic.name}" timed out after 180s`)),
              180000
            )
          ),
        ]);
        console.log(
          `    [${category}] Topic "${topic.name}": ${result.content?.length || 0} chars`
        );
        return {
          key: `${category}_${idx}_${topic.name.replace(/\s+/g, '_').toLowerCase()}`,
          name: topic.name,
          content: result.content,
          citations: result.citations || [],
        };
      } catch (err) {
        console.warn(`    [${category}] Topic "${topic.name}" failed: ${err.message}`);
        return { key: `${category}_${idx}_failed`, name: topic.name, content: '', citations: [] };
      }
    })
  );

  for (const r of topicResults) {
    if (r && r.content) results[r.key] = r;
  }

  console.log(
    `    [${category.toUpperCase()} AGENT] Completed in ${((Date.now() - agentStart) / 1000).toFixed(1)}s - ${Object.keys(results).length} topics`
  );
  return results;
}

module.exports = {
  policyResearchAgent,
  marketResearchAgent,
  competitorResearchAgent,
  contextResearchAgent,
  depthResearchAgent,
  insightsResearchAgent,
  universalResearchAgent,
  extractJsonFromContent,
};
