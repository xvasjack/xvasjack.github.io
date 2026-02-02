const { callDeepSeekChat, callDeepSeek, callKimiDeepResearch } = require('./ai-clients');
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

  const result = await callDeepSeekChat(gapPrompt, '', 4096);

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
    console.error('  Failed to parse gaps:', error.message);
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

  const result = await callDeepSeek(prompt, '', 8192);

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
    console.error('  Re-synthesis failed:', error.message);
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

  // Synthesize research into structured output using DeepSeek
  // Expanded structure for 15+ slides matching Escort template
  console.log(`  [Synthesizing ${country} data for deep-dive report...]`);

  const synthesisPrompt = `You are a senior strategy consultant at YCP creating a comprehensive market analysis for ${country}'s ${industry} market. Your client is a ${clientContext}.

CRITICAL REQUIREMENTS:
1. DEPTH over breadth - specific numbers, names, dates for every claim
2. CHART DATA - USE the structuredData.chartData from research when available. Do NOT fabricate chart numbers.
3. SLIDE-READY - each section maps to a specific slide
4. STORY FLOW - each slide must answer the reader's question and set up the next
5. DATA QUALITY - if research has dataQuality:"estimated", note this in the insight. Never present estimates as verified facts.

=== NARRATIVE STRUCTURE ===
Your presentation tells a story. Each section answers a question and raises the next:

POLICY SECTION → "What rules govern this market?" → Leads reader to ask "How big is the opportunity?"
MARKET SECTION → "How big is the opportunity?" → Leads to "Who's already chasing it?"
COMPETITOR SECTION → "Who competes here?" → Leads to "Can I win? What's my opening?"
DEPTH SECTION → "What's the economics/path?" → Leads to "Should I proceed?"
SUMMARY SECTION → "GO or NO-GO?" → Clear recommendation

Each slide's "subtitle" field should be the INSIGHT, not a description. Answer "So what?" in max 15 words.

=== INSIGHTS INTELLIGENCE ===
Use the failure cases, timing triggers, and competitive intelligence to:
- Identify non-obvious opportunities (underserved segments, distressed competitors)
- Provide timing urgency (incentive expirations, regulatory deadlines)
- Warn about real risks (what killed previous entrants)
- Distinguish enforced vs ignored regulations

RESEARCH DATA:
${JSON.stringify(researchData, null, 2)}

Return a JSON object with this EXPANDED structure for 15+ slides:

{
  "country": "${country}",

  // === SECTION 1: POLICY & REGULATIONS (3 slides) ===
  "policy": {
    "foundationalActs": {
      "slideTitle": "${country} - Energy Foundational Acts",
      "subtitle": "Key legislation governing energy sector",
      "acts": [
        {"name": "Energy Conservation Act", "year": "2022", "requirements": "Mandatory audits for >2MW facilities", "penalties": "Fine up to $50K", "enforcement": "23 auditors for 4,200 facilities"}
      ],
      "keyMessage": "One sentence insight"
    },
    "nationalPolicy": {
      "slideTitle": "${country} - National Energy Policy",
      "subtitle": "Government targets and roadmap",
      "targets": [
        {"metric": "Carbon Neutrality", "target": "2050", "status": "Legislated"},
        {"metric": "Renewable Share", "target": "30%", "deadline": "2030"}
      ],
      "keyInitiatives": ["Initiative 1 with budget/timeline", "Initiative 2"],
      "policyDirection": "Current government stance with evidence"
    },
    "investmentRestrictions": {
      "slideTitle": "${country} - Foreign Investment Rules",
      "subtitle": "Ownership limits and incentives",
      "ownershipLimits": {"general": "49%", "promoted": "100% allowed", "exceptions": "BOI promoted projects"},
      "incentives": [
        {"name": "BOI Scheme", "benefit": "8-year tax holiday", "eligibility": "Energy efficiency projects >$1M"}
      ],
      "riskLevel": "low/medium/high",
      "riskJustification": "Specific reasoning"
    }
  },

  // === SECTION 2: MARKET DATA (6 slides with charts) ===
  "market": {
    "tpes": {
      "slideTitle": "${country} - Total Primary Energy Supply",
      "subtitle": "Energy supply mix by source",
      "chartData": {
        "categories": ["2020", "2021", "2022", "2023", "2024"],
        "series": [
          {"name": "Oil", "values": [45, 44, 43, 42, 41]},
          {"name": "Natural Gas", "values": [25, 26, 27, 28, 30]},
          {"name": "Coal", "values": [20, 19, 18, 17, 15]},
          {"name": "Renewables", "values": [10, 11, 12, 13, 14]}
        ],
        "unit": "Mtoe"
      },
      "keyInsight": "One insight about TPES trend"
    },
    "finalDemand": {
      "slideTitle": "${country} - Final Energy Demand",
      "subtitle": "Consumption by sector",
      "chartData": {
        "categories": ["Industrial", "Transport", "Residential", "Commercial"],
        "series": [
          {"name": "2020", "values": [40, 30, 20, 10]},
          {"name": "2024", "values": [42, 32, 18, 8]}
        ],
        "unit": "%"
      },
      "growthRate": "X% CAGR 2020-2024",
      "keyDrivers": ["Driver 1", "Driver 2"]
    },
    "electricity": {
      "slideTitle": "${country} - Electricity & Power",
      "subtitle": "Generation capacity and mix",
      "totalCapacity": "XX GW installed",
      "chartData": {
        "categories": ["Coal", "Gas", "Hydro", "Solar", "Wind", "Nuclear"],
        "values": [40, 30, 15, 10, 3, 2],
        "unit": "%"
      },
      "demandGrowth": "X% annually",
      "keyTrend": "Insight about power sector"
    },
    "gasLng": {
      "slideTitle": "${country} - Gas & LNG Market",
      "subtitle": "Natural gas supply and infrastructure",
      "chartData": {
        "categories": ["2020", "2021", "2022", "2023", "2024"],
        "series": [
          {"name": "Domestic Production", "values": [30, 28, 26, 24, 22]},
          {"name": "LNG Imports", "values": [20, 22, 24, 26, 28]}
        ],
        "unit": "bcm"
      },
      "lngTerminals": [{"name": "Terminal 1", "capacity": "X mtpa", "utilization": "Y%"}],
      "pipelineNetwork": "Description of coverage"
    },
    "pricing": {
      "slideTitle": "${country} - Energy Pricing",
      "subtitle": "Tariff trends and outlook",
      "chartData": {
        "categories": ["2020", "2021", "2022", "2023", "2024"],
        "series": [
          {"name": "Industrial Electricity", "values": [0.08, 0.09, 0.10, 0.11, 0.12]},
          {"name": "Natural Gas", "values": [8, 9, 10, 11, 12]}
        ],
        "units": ["USD/kWh", "USD/mmbtu"]
      },
      "comparison": "vs regional peers",
      "outlook": "Expected trend"
    },
    "escoMarket": {
      "slideTitle": "${country} - ESCO Market",
      "subtitle": "Energy services market overview",
      "marketSize": "$XXX million in 2024",
      "growthRate": "X% CAGR",
      "segments": [
        {"name": "Industrial", "size": "$XXM", "share": "X%"},
        {"name": "Commercial", "size": "$XXM", "share": "X%"}
      ],
      "keyDrivers": ["Driver 1", "Driver 2"],
      "chartData": {
        "categories": ["Industrial", "Commercial", "Government"],
        "values": [60, 30, 10],
        "unit": "% of market"
      }
    }
  },

  // === SECTION 3: COMPETITOR OVERVIEW (5 slides) ===
  "competitors": {
    "japanesePlayers": {
      "slideTitle": "${country} - Japanese Energy Companies",
      "subtitle": "Current presence and activities",
      "players": [
        {"name": "Tokyo Gas", "website": "https://www.tokyo-gas.co.jp", "presence": "JV with Local Partner", "projects": "3 ESCO contracts", "revenue": "$X million", "assessment": "Strong/Weak", "description": "REQUIRED 50+ words with revenue, market share, growth rate, key services, strategic significance including market position, entry strategy, key projects, revenue figures, growth trajectory, and strategic significance for competitive landscape"},
        {"name": "Osaka Gas", "website": "https://www.osakagas.co.jp", "presence": "Direct investment", "projects": "LNG terminal stake", "revenue": "$X million", "assessment": "Strong/Weak", "description": "REQUIRED 50+ words with revenue, market share, growth rate, key services, strategic significance"}
      ],
      "marketInsight": "Overall assessment of Japanese presence"
    },
    "localMajor": {
      "slideTitle": "${country} - Major Local Players",
      "subtitle": "Domestic energy companies",
      "players": [
        {"name": "Company A", "website": "https://companya.com", "type": "State-owned/Private", "revenue": "$X million", "marketShare": "X%", "strengths": "...", "weaknesses": "...", "description": "REQUIRED 50+ words with revenue, market share, growth rate, key services, strategic significance including revenue, growth rate, market share, key services, geographic coverage, and competitive advantages"},
        {"name": "Company B", "website": "https://companyb.com", "type": "State-owned/Private", "revenue": "$X million", "marketShare": "X%", "strengths": "...", "weaknesses": "...", "description": "REQUIRED 50+ words with revenue, market share, growth rate, key services, strategic significance"}
      ],
      "concentration": "Market concentration assessment"
    },
    "foreignPlayers": {
      "slideTitle": "${country} - Foreign Energy Companies",
      "subtitle": "International competitors",
      "players": [
        {"name": "ENGIE", "website": "https://www.engie.com", "origin": "France", "entryYear": "2018", "mode": "JV", "projects": "X contracts", "success": "High/Medium/Low", "description": "REQUIRED 50+ words with revenue, market share, growth rate, key services, strategic significance including entry strategy, local partnerships, revenue, project portfolio, and competitive position"},
        {"name": "Siemens", "website": "https://www.siemens-energy.com", "origin": "Germany", "entryYear": "2015", "mode": "Direct", "projects": "Smart grid", "success": "High/Medium/Low", "description": "REQUIRED 50+ words with revenue, market share, growth rate, key services, strategic significance"}
      ],
      "competitiveInsight": "How foreign players compete"
    },
    "caseStudy": {
      "slideTitle": "${country} - Market Entry Case Study",
      "subtitle": "Lessons from successful entries",
      "company": "Company Name",
      "entryYear": "2018",
      "entryMode": "JV with Local Partner",
      "investment": "$X million",
      "outcome": "Current status and results",
      "keyLessons": ["Lesson 1", "Lesson 2", "Lesson 3"],
      "applicability": "How this applies to client"
    },
    "maActivity": {
      "slideTitle": "${country} - M&A Activity",
      "subtitle": "Recent deals and targets",
      "recentDeals": [
        {"year": "2024", "buyer": "Company A", "target": "Company B", "value": "$X million", "rationale": "..."}
      ],
      "potentialTargets": [
        {"name": "Company X", "estimatedValue": "$X million", "rationale": "Why attractive", "timing": "Available now/Soon"}
      ],
      "valuationMultiples": "Typical deal terms in market"
    }
  },

  // === SECTION 4: DEPTH ANALYSIS (5 slides) ===
  "depth": {
    "escoEconomics": {
      "slideTitle": "${country} - ESCO Deal Economics",
      "subtitle": "Contract structures and returns",
      "typicalDealSize": {"min": "$X million", "max": "$Y million", "average": "$Z million"},
      "contractTerms": {
        "duration": "5-10 years typical",
        "savingsSplit": "Client 70% / ESCO 30% typical",
        "guaranteeStructure": "Shared savings or guaranteed savings"
      },
      "financials": {
        "paybackPeriod": "X years",
        "irr": "X-Y%",
        "marginProfile": "X% gross margin typical"
      },
      "financingOptions": ["Option 1", "Option 2"],
      "keyInsight": "Investment thesis for ESCO business"
    },
    "partnerAssessment": {
      "slideTitle": "${country} - Partner Assessment",
      "subtitle": "Potential partners ranked by fit",
      "partners": [
        {
          "name": "Company Name",
          "website": "https://company.com",
          "type": "Local ESCO / Engineering / Conglomerate",
          "revenue": "$X million",
          "employees": "X",
          "capabilities": ["Capability 1", "Capability 2"],
          "partnershipFit": "1-5 score",
          "acquisitionFit": "1-5 score",
          "estimatedValuation": "$X-Y million",
          "keyContact": "How to approach"
        }
      ],
      "recommendedPartner": "Top recommendation with reasoning"
    },
    "entryStrategy": {
      "slideTitle": "${country} - Entry Strategy Options",
      "subtitle": "Comparison of market entry modes",
      "options": [
        {
          "mode": "Joint Venture",
          "timeline": "X months",
          "investment": "$X million",
          "controlLevel": "Minority/50-50/Majority",
          "pros": ["Pro 1", "Pro 2"],
          "cons": ["Con 1", "Con 2"],
          "riskLevel": "Low/Medium/High"
        },
        {
          "mode": "Acquisition",
          "timeline": "X months",
          "investment": "$X million",
          "controlLevel": "Full",
          "pros": ["Pro 1", "Pro 2"],
          "cons": ["Con 1", "Con 2"],
          "riskLevel": "Low/Medium/High"
        },
        {
          "mode": "Greenfield",
          "timeline": "X months",
          "investment": "$X million",
          "controlLevel": "Full",
          "pros": ["Pro 1", "Pro 2"],
          "cons": ["Con 1", "Con 2"],
          "riskLevel": "Low/Medium/High"
        }
      ],
      "recommendation": "Recommended option with detailed reasoning",
      "harveyBalls": {
        "criteria": ["Speed to Market", "Investment Required", "Risk Level", "Control", "Local Knowledge"],
        "jv": [3, 4, 3, 2, 5],
        "acquisition": [4, 2, 3, 5, 4],
        "greenfield": [1, 3, 4, 5, 1]
      }
    },
    "implementation": {
      "slideTitle": "${country} - Implementation Roadmap",
      "subtitle": "Phased approach to market entry",
      "phases": [
        {
          "name": "Phase 1: Setup (Months 0-6)",
          "activities": ["Activity 1", "Activity 2", "Activity 3"],
          "milestones": ["Milestone 1", "Milestone 2"],
          "investment": "$X"
        },
        {
          "name": "Phase 2: Launch (Months 6-12)",
          "activities": ["Activity 1", "Activity 2"],
          "milestones": ["Milestone 1", "Milestone 2"],
          "investment": "$X"
        },
        {
          "name": "Phase 3: Scale (Months 12-24)",
          "activities": ["Activity 1", "Activity 2"],
          "milestones": ["Milestone 1", "Milestone 2"],
          "investment": "$X"
        }
      ],
      "totalInvestment": "$X million over 24 months",
      "breakeven": "Expected in month X"
    },
    "targetSegments": {
      "slideTitle": "${country} - Target Customer Segments",
      "subtitle": "Priority segments for initial focus",
      "segments": [
        {
          "name": "Segment name",
          "size": "X factories / $X million potential",
          "energyIntensity": "High/Medium/Low",
          "decisionMaker": "Who to target",
          "salesCycle": "X months typical",
          "priority": "1-5"
        }
      ],
      "topTargets": [
        {"company": "Company Name", "website": "https://company.com", "industry": "Sector", "energySpend": "$X million/year", "location": "Zone/Province"}
      ],
      "goToMarketApproach": "How to reach these customers"
    }
  },

  // === SECTION 5: SUMMARY & RECOMMENDATIONS ===
  "summary": {
    "timingIntelligence": {
      "slideTitle": "${country} - Why Now?",
      "subtitle": "Time-sensitive factors driving urgency",
      "triggers": [
        {"trigger": "BOI incentives expire Dec 2027", "impact": "Miss tax holiday window", "action": "Apply before Q2 2026"},
        {"trigger": "Carbon tax effective 2026", "impact": "20-30% demand acceleration", "action": "Position before enforcement"},
        {"trigger": "3 ESCOs seeking buyers", "impact": "Acquisition window closing", "action": "Approach Absolute Energy Q1"}
      ],
      "windowOfOpportunity": "Clear statement of why 2025-2026 is optimal entry timing"
    },
    "lessonsLearned": {
      "slideTitle": "${country} - Lessons from Market",
      "subtitle": "What killed previous entrants and how to avoid",
      "failures": [
        {"company": "Company that failed", "year": "20XX", "reason": "Specific reason", "lesson": "What to do differently"}
      ],
      "successFactors": ["What successful entrants did right"],
      "warningSignsToWatch": ["Red flags that indicate trouble"]
    },
    "opportunities": [
      {"opportunity": "Specific opportunity", "size": "$X million", "timing": "Why now", "action": "What to do"}
    ],
    "obstacles": [
      {"obstacle": "Specific barrier", "severity": "High/Medium/Low", "mitigation": "How to address"}
    ],
    "ratings": {
      "attractiveness": 7,
      "attractivenessRationale": "Multi-factor justification with specific evidence",
      "feasibility": 6,
      "feasibilityRationale": "Multi-factor justification with specific evidence"
    },
    "keyInsights": [
      {
        "title": "Max 10 word headline - must be NON-OBVIOUS",
        "data": "The specific evidence - numbers, names, dates",
        "pattern": "The causal mechanism others miss",
        "implication": "The strategic response - specific action"
      }
    ],
    "recommendation": "Clear recommendation for entry or not - with specific first step",
    "goNoGo": {
      "criteria": [
        {"criterion": "Market size >$100M", "met": true, "evidence": "Market is $X million"},
        {"criterion": "Regulatory clarity", "met": true, "evidence": "Clear ESCO framework exists"},
        {"criterion": "Viable partners available", "met": true, "evidence": "3 partners identified"},
        {"criterion": "Acceptable risk level", "met": true, "evidence": "Risk score X/10"},
        {"criterion": "Timing window open", "met": true, "evidence": "BOI incentives available until Dec 2027"}
      ],
      "overallVerdict": "GO / NO-GO / CONDITIONAL GO",
      "conditions": ["Specific condition 1 if conditional", "Specific condition 2"]
    }
  }
}

CRITICAL:
- Every number needs year, source context
- Chart data must have numeric arrays (not placeholders)
- If data unavailable, use reasonable estimates and mark as "estimated"
- Aim for actionable specificity, not generic descriptions
- DEPTH IS KEY: Executive-level decision-making requires specific numbers, names, timelines
- WEBSITE URLs: Every company in players, partners, and topTargets MUST have a "website" field with the company's actual URL. Search for and include the real corporate website URL. If unknown, use the most likely URL based on company name.
- COMPANY DESCRIPTIONS: Every company in players arrays MUST have a "description" field with 50+ words. Include specific metrics (revenue, growth rate, market share), strategic context, key services, geographic coverage, and why the company matters for competitive analysis. Do NOT write generic Wikipedia-style descriptions.

Return ONLY valid JSON.`;

  const synthesis = await callDeepSeek(synthesisPrompt, '', 16384);

  let countryAnalysis;
  try {
    // Validate synthesis response before parsing
    if (!synthesis.content || synthesis.content.length < 100) {
      console.error(
        `  [ERROR] Synthesis returned empty or insufficient content (${synthesis.content?.length || 0} chars)`
      );
      return {
        country,
        error: 'Synthesis returned empty response',
        message: 'DeepSeek API may be experiencing issues. Please retry.',
        rawData: researchData,
        researchTimeMs: Date.now() - startTime,
      };
    }

    let jsonStr = synthesis.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    countryAnalysis = JSON.parse(jsonStr);
    // Preserve raw research data with citations for PPT footer
    countryAnalysis.rawData = researchData;
    // Debug: log synthesis structure
    const policyKeys = countryAnalysis.policy ? Object.keys(countryAnalysis.policy) : [];
    const marketKeys = countryAnalysis.market ? Object.keys(countryAnalysis.market) : [];
    const compKeys = countryAnalysis.competitors ? Object.keys(countryAnalysis.competitors) : [];
    console.log(`  [Synthesis] Policy sections: ${policyKeys.length} (${policyKeys.join(', ')})`);
    console.log(`  [Synthesis] Market sections: ${marketKeys.length} (${marketKeys.join(', ')})`);
    console.log(`  [Synthesis] Competitor sections: ${compKeys.length} (${compKeys.join(', ')})`);
  } catch (error) {
    console.error(`Failed to parse first synthesis for ${country}:`, error.message);
    return {
      country,
      error: 'Synthesis failed',
      rawData: researchData,
      researchTimeMs: Date.now() - startTime,
    };
  }

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

  const result = await callDeepSeekChat(reviewPrompt, '', 4096);

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
    console.error('  Reviewer failed to parse:', error.message);
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

  const result = await callDeepSeek(revisePrompt, systemPrompt, 12000);

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
    console.error('  Revision failed:', error.message);
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

  const result = await callDeepSeek(prompt, systemPrompt, 12000);

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
    console.error('Failed to parse single country synthesis:', error.message);
    return {
      isSingleCountry: true,
      country: countryAnalysis.country,
      executiveSummary: ['Deep analysis parsing failed - raw content available'],
      rawContent: result.content,
    };
  }

  // ============ REVIEWER LOOP ============
  // Reviewer AI critiques → Working AI revises → Repeat until approved

  const MAX_REVISIONS = 3;
  let revisionCount = 0;
  let approved = false;

  console.log(`\n  [REVIEW CYCLE] Starting quality review...`);

  while (!approved && revisionCount < MAX_REVISIONS) {
    // Reviewer evaluates current analysis
    const review = await reviewAnalysis(synthesis, countryAnalysis, scope);

    if (review.verdict === 'APPROVE' || review.overallScore >= 7) {
      console.log(
        `  ✓ APPROVED after ${revisionCount} revision(s) | Final score: ${review.overallScore}/10`
      );
      approved = true;
      synthesis.qualityScore = review.overallScore;
      synthesis.reviewIterations = revisionCount;
      break;
    }

    revisionCount++;
    console.log(
      `\n  [REVISION ${revisionCount}/${MAX_REVISIONS}] Score: ${review.overallScore}/10 - Revising...`
    );

    // Working AI revises based on feedback
    synthesis = await reviseAnalysis(synthesis, review, countryAnalysis, scope, systemPrompt);
  }

  // Final review if we hit max revisions
  if (!approved) {
    const finalReview = await reviewAnalysis(synthesis, countryAnalysis, scope);
    synthesis.qualityScore = finalReview.overallScore;
    synthesis.reviewIterations = revisionCount;
    console.log(`  → Max revisions reached | Final score: ${finalReview.overallScore}/10`);
  }

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

  const result = await callDeepSeek(prompt, systemPrompt, 12000);

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
    console.error('Failed to parse synthesis:', error.message);
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
};
