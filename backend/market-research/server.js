require('dotenv').config({ path: '../.env' });
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const pptxgen = require('pptxgenjs');

// ============ GLOBAL ERROR HANDLERS ============
process.on('unhandledRejection', (reason, promise) => {
  console.error('=== UNHANDLED PROMISE REJECTION ===');
  console.error('Reason:', reason);
  console.error('Stack:', reason?.stack || 'No stack trace');
});

process.on('uncaughtException', (error) => {
  console.error('=== UNCAUGHT EXCEPTION ===');
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
});

// ============ EXPRESS SETUP ============
const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Check required environment variables
const requiredEnvVars = ['DEEPSEEK_API_KEY', 'KIMI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}

// ============ COST TRACKING ============
const costTracker = {
  date: new Date().toISOString().split('T')[0],
  totalCost: 0,
  calls: []
};

// Pricing per 1M tokens (from DeepSeek docs - Dec 2024)
// Both deepseek-chat and deepseek-reasoner use same pricing
// deepseek-chat = V3.2 Non-thinking Mode (max 8K output)
// deepseek-reasoner = V3.2 Thinking Mode (max 64K output)
const PRICING = {
  'deepseek-chat': { input: 0.28, output: 0.42 },      // Cache miss pricing
  'deepseek-reasoner': { input: 0.28, output: 0.42 }, // Same pricing, but thinking mode
  'kimi-128k': { input: 0.84, output: 0.84 },          // Moonshot v1 128k context
  'kimi-32k': { input: 0.35, output: 0.35 }            // Moonshot v1 32k context
};

function trackCost(model, inputTokens, outputTokens, searchCount = 0) {
  let cost = 0;
  const pricing = PRICING[model];

  if (pricing) {
    if (pricing.perSearch) {
      cost = searchCount * pricing.perSearch;
    } else {
      cost = (inputTokens / 1000000) * pricing.input + (outputTokens / 1000000) * pricing.output;
    }
  }

  costTracker.totalCost += cost;
  costTracker.calls.push({ model, inputTokens, outputTokens, searchCount, cost, time: new Date().toISOString() });
  console.log(`  [Cost] ${model}: $${cost.toFixed(4)} (Total: $${costTracker.totalCost.toFixed(4)})`);
  return cost;
}

// ============ AI TOOLS ============

// DeepSeek Chat - for lighter tasks (scope parsing)
async function callDeepSeekChat(prompt, systemPrompt = '', maxTokens = 4096) {
  try {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        max_tokens: maxTokens,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`DeepSeek Chat HTTP error ${response.status}:`, errorText.substring(0, 200));
      return { content: '', usage: { input: 0, output: 0 } };
    }

    const data = await response.json();
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    trackCost('deepseek-chat', inputTokens, outputTokens);

    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: { input: inputTokens, output: outputTokens }
    };
  } catch (error) {
    console.error('DeepSeek Chat API error:', error.message);
    return { content: '', usage: { input: 0, output: 0 } };
  }
}

// DeepSeek V3.2 Thinking Mode - for deep analysis with chain-of-thought
async function callDeepSeek(prompt, systemPrompt = '', maxTokens = 16384) {
  try {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages,
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`DeepSeek Reasoner HTTP error ${response.status}:`, errorText.substring(0, 200));
      // Fallback to chat model
      console.log('Falling back to deepseek-chat...');
      return callDeepSeekChat(prompt, systemPrompt, maxTokens);
    }

    const data = await response.json();
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    trackCost('deepseek-reasoner', inputTokens, outputTokens);

    // R1 returns reasoning_content + content
    const content = data.choices?.[0]?.message?.content || '';
    const reasoning = data.choices?.[0]?.message?.reasoning_content || '';

    console.log(`  [DeepSeek V3.2 Thinking] Reasoning: ${reasoning.length} chars, Output: ${content.length} chars`);

    return {
      content,
      reasoning,
      usage: { input: inputTokens, output: outputTokens }
    };
  } catch (error) {
    console.error('DeepSeek Reasoner API error:', error.message);
    return { content: '', usage: { input: 0, output: 0 } };
  }
}

// Kimi (Moonshot) API - for deep research with web browsing
// Uses 128k context for thorough analysis
async function callKimi(query, systemPrompt = '', useWebSearch = true) {
  try {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: query });

    const requestBody = {
      model: 'moonshot-v1-128k',
      messages,
      max_tokens: 8192,
      temperature: 0.3
    };

    // Enable web search tool if requested
    if (useWebSearch) {
      requestBody.tools = [{
        type: 'builtin_function',
        function: { name: '$web_search' }
      }];
    }

    const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.KIMI_API_KEY}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Kimi HTTP error ${response.status}:`, errorText.substring(0, 200));
      return { content: '', citations: [] };
    }

    const data = await response.json();
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    trackCost('kimi-128k', inputTokens, outputTokens);

    return {
      content: data.choices?.[0]?.message?.content || '',
      citations: [],
      usage: { input: inputTokens, output: outputTokens }
    };
  } catch (error) {
    console.error('Kimi API error:', error.message);
    return { content: '', citations: [] };
  }
}

// Kimi deep research - comprehensive research on a topic
// Lets Kimi browse and think deeply about the research question
async function callKimiDeepResearch(topic, country, industry) {
  console.log(`  [Kimi Deep Research] ${topic} for ${country}...`);

  const systemPrompt = `You are a senior market research analyst at McKinsey. You have access to web search.

Your job is to conduct DEEP research on the given topic. Not surface-level - actually dig into:
- Primary sources (government websites, official statistics, company filings)
- Recent news and developments (2024-2025)
- Specific numbers with sources
- Company-specific intelligence
- Regulatory details with enforcement reality

For every claim, you MUST provide:
- Specific numbers (market size in $, growth %, dates)
- Source type (government data, company filing, industry report)
- Context (why this matters, how it compares)

DO NOT give generic statements like "the market is growing". Give specifics like "The ESCO market reached $2.3B in 2024, up 14% YoY, driven by mandatory energy audits under the 2023 Energy Act."`;

  const query = `Research this topic thoroughly for ${country}'s ${industry} market:

${topic}

Search the web for recent data (2024-2025). Find:
1. Specific statistics and numbers
2. Key regulations and their enforcement status
3. Major companies and their market positions
4. Recent deals, partnerships, or market developments
5. Government initiatives and deadlines

Be specific. Cite sources. No fluff.`;

  return callKimi(query, systemPrompt, true);
}

// ============ RESEARCH FRAMEWORK ============
// Expanded queries for thorough research (~30-40 searches per country)

const RESEARCH_FRAMEWORK = {
  macroContext: {
    name: 'Macro Context',
    queries: [
      '{country} GDP 2024 2025 economic growth forecast',
      '{country} population demographics urban rural industrial workforce',
      '{country} industrial sector manufacturing contribution GDP 2024',
      '{country} energy consumption by sector industrial commercial residential',
      '{country} energy intensity trends comparison regional',
      '{country} economic development plan industrial policy 2024 2030'
    ]
  },
  policyRegulatory: {
    name: 'Policy & Regulatory Environment',
    queries: [
      '{country} national energy policy 2024 2025 targets',
      '{country} renewable energy targets carbon neutrality net zero timeline',
      '{country} foreign direct investment rules energy sector restrictions',
      '{country} foreign ownership limits power energy companies percentage',
      '{country} ESCO energy service companies government support incentives',
      '{country} energy efficiency regulations mandatory standards industrial',
      '{country} investment promotion board energy incentives tax breaks',
      '{country} power purchase agreement PPA regulations private sector'
    ]
  },
  marketDynamics: {
    name: 'Market Dynamics',
    queries: [
      '{country} energy services market size value 2024 2025 forecast',
      '{country} ESCO market size energy performance contracting',
      '{country} electricity tariff industrial commercial rates 2024',
      '{country} natural gas price industrial LNG spot 2024',
      '{country} energy demand growth industrial sector manufacturing',
      '{country} power generation capacity mix coal gas renewable',
      '{country} district cooling heating market size',
      '{country} industrial energy audit market demand'
    ]
  },
  competitiveLandscape: {
    name: 'Competitive Landscape',
    queries: [
      '{country} energy service companies ESCO major players list',
      '{country} ESCO association members registered companies',
      'Japanese companies {country} energy investment Tokyo Gas Osaka Gas JERA',
      '{country} foreign energy companies European American presence',
      '{country} state owned energy utility company market dominance',
      '{country} energy market entry barriers foreign companies challenges',
      '{country} energy sector M&A acquisitions partnerships 2023 2024',
      '{country} energy consulting engineering firms major players'
    ]
  },
  infrastructure: {
    name: 'Infrastructure & Ecosystem',
    queries: [
      '{country} LNG import terminal regasification capacity utilization',
      '{country} natural gas pipeline network infrastructure coverage',
      '{country} industrial zones estates economic corridors list',
      '{country} smart grid pilot projects energy management systems',
      '{country} power grid reliability transmission distribution quality',
      '{country} renewable energy infrastructure solar wind capacity'
    ]
  },
  partnershipOpportunities: {
    name: 'Partnership & Entry Opportunities',
    queries: [
      '{country} energy sector joint venture opportunities local partners',
      '{country} industrial companies seeking energy efficiency solutions',
      '{country} conglomerates energy subsidiary diversification',
      '{country} energy sector privatization opportunities upcoming',
      '{country} government energy projects tender bidding opportunities'
    ]
  }
};

// ============ SCOPE PARSER ============

async function parseScope(userPrompt) {
  console.log('\n=== STAGE 1: SCOPE PARSING ===');
  console.log('User prompt:', userPrompt);

  const systemPrompt = `You are a scope parser for market research requests. Extract structured parameters from the user's prompt.

Return a JSON object with these fields:
- projectType: "market_entry" | "competitive_analysis" | "market_sizing" | "other"
- industry: string (the industry/sector being researched)
- targetMarkets: string[] (list of countries/regions to analyze)
- clientContext: string (any context about the client making the request)
- focusAreas: string[] (specific aspects to emphasize)

If countries are vague like "Southeast Asia" or "SEA", expand to: ["Thailand", "Vietnam", "Indonesia", "Malaysia", "Philippines"]
If countries are vague like "ASEAN", expand to: ["Thailand", "Vietnam", "Indonesia", "Malaysia", "Philippines", "Singapore"]

Return ONLY valid JSON, no markdown or explanation.`;

  // Use lighter chat model for simple parsing task
  const result = await callDeepSeekChat(userPrompt, systemPrompt, 1024);

  try {
    // Clean up response - remove markdown code blocks if present
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    const scope = JSON.parse(jsonStr);
    console.log('Parsed scope:', JSON.stringify(scope, null, 2));
    return scope;
  } catch (error) {
    console.error('Failed to parse scope:', error.message);
    // Default fallback
    return {
      projectType: 'market_entry',
      industry: 'energy services',
      targetMarkets: ['Thailand', 'Vietnam', 'Malaysia', 'Philippines', 'Indonesia'],
      clientContext: 'Japanese company',
      focusAreas: ['market size', 'competition', 'regulations']
    };
  }
}

// ============ ITERATIVE RESEARCH SYSTEM ============

// Step 1: Identify gaps in research after first synthesis
async function identifyResearchGaps(synthesis, country, industry) {
  console.log(`  [Identifying research gaps for ${country}...]`);

  const gapPrompt = `You are a research director reviewing a first-pass market analysis. Your job is to identify CRITICAL GAPS that would make a CEO distrust this analysis.

CURRENT ANALYSIS:
${JSON.stringify(synthesis, null, 2)}

Review this analysis and identify what's MISSING or WEAK. Focus on:

1. UNVERIFIED CLAIMS: Numbers without sources, vague statements like "growing market"
2. MISSING COMPARISONS: No regional benchmarks, no competitor specifics
3. SHALLOW SECTIONS: Areas with generic content instead of specifics
4. TIMING GAPS: Missing "why now" evidence, no regulatory deadlines mentioned
5. COMPETITIVE BLIND SPOTS: Missing key players, no partnership intel
6. DATA CONFLICTS: Contradictory numbers that need verification

Return a JSON object with EXACTLY this structure:
{
  "criticalGaps": [
    {
      "area": "which section is weak (e.g., 'marketDynamics', 'competitiveLandscape')",
      "gap": "what specific information is missing",
      "searchQuery": "the EXACT search query to find this information for ${country}",
      "priority": "high/medium (high = deal-breaker if missing)"
    }
  ],
  "dataToVerify": [
    {
      "claim": "the specific claim that needs verification",
      "searchQuery": "search query to verify this for ${country}"
    }
  ],
  "confidenceAssessment": {
    "overall": "low/medium/high",
    "weakestSection": "which section needs most work",
    "reasoning": "why this confidence level"
  }
}

Be SPECIFIC with search queries. Include "${country}" and "${industry}" where relevant.
Limit to 8 most critical gaps (prioritize high-impact ones).
Return ONLY valid JSON.`;

  const result = await callDeepSeekChat(gapPrompt, '', 4096);

  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    const gaps = JSON.parse(jsonStr);
    console.log(`    Found ${gaps.criticalGaps?.length || 0} critical gaps, ${gaps.dataToVerify?.length || 0} claims to verify`);
    console.log(`    Confidence: ${gaps.confidenceAssessment?.overall || 'unknown'} (weakest: ${gaps.confidenceAssessment?.weakestSection || 'unknown'})`);
    return gaps;
  } catch (error) {
    console.error('  Failed to parse gaps:', error.message);
    return { criticalGaps: [], dataToVerify: [], confidenceAssessment: { overall: 'low' } };
  }
}

// Step 2: Execute targeted research to fill gaps using Kimi
async function fillResearchGaps(gaps, country, industry) {
  console.log(`  [Filling research gaps for ${country} with Kimi...]`);
  const additionalData = { gapResearch: [], verificationResearch: [] };

  // Research critical gaps with Kimi
  const criticalGaps = gaps.criticalGaps || [];
  for (const gap of criticalGaps.slice(0, 4)) { // Limit to 4 most critical
    if (!gap.searchQuery) continue;
    console.log(`    Gap search: ${gap.gap.substring(0, 50)}...`);

    const result = await callKimiDeepResearch(gap.searchQuery, country, industry);
    if (result.content) {
      additionalData.gapResearch.push({
        area: gap.area,
        gap: gap.gap,
        query: gap.searchQuery,
        findings: result.content,
        citations: result.citations || []
      });
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Verify questionable claims with Kimi
  const toVerify = gaps.dataToVerify || [];
  for (const item of toVerify.slice(0, 2)) { // Limit to 2 verifications
    if (!item.searchQuery) continue;
    console.log(`    Verify: ${item.claim.substring(0, 50)}...`);

    const result = await callKimiDeepResearch(item.searchQuery, country, industry);
    if (result.content) {
      additionalData.verificationResearch.push({
        claim: item.claim,
        query: item.searchQuery,
        findings: result.content,
        citations: result.citations || []
      });
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`    Collected ${additionalData.gapResearch.length} gap fills, ${additionalData.verificationResearch.length} verifications`);
  return additionalData;
}

// Step 3: Re-synthesize with additional data
async function reSynthesize(originalSynthesis, additionalData, country, industry, clientContext) {
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

Return the SAME JSON structure as before, but IMPROVED:
{
  "country": "${country}",
  "macroContext": { ... },
  "policyRegulatory": { ... },
  "marketDynamics": { ... },
  "competitiveLandscape": { ... },
  "infrastructure": { ... },
  "summaryAssessment": { ... }
}

CRITICAL:
- Every number should now have context (year, source type, comparison)
- Every company mentioned should have specifics (size, market position)
- Every regulation should have enforcement reality
- Mark anything still uncertain as "estimated" or "industry sources suggest"

Return ONLY valid JSON.`;

  const result = await callDeepSeek(prompt, '', 8192);

  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error('  Re-synthesis failed:', error.message);
    return originalSynthesis; // Fall back to original
  }
}

// ============ COUNTRY RESEARCH AGENT (KIMI + DEEPSEEK) ============

async function researchCountry(country, industry, clientContext) {
  console.log(`\n=== RESEARCHING: ${country} ===`);
  const startTime = Date.now();

  // Use Kimi for deep research on each major topic area
  // Kimi browses the web and provides comprehensive analysis per topic
  const researchTopics = [
    {
      key: 'macroContext',
      topic: `Economic context and energy landscape:
- GDP, population, industrial sector contribution
- Energy consumption by sector
- Energy intensity trends vs regional peers
- Key economic development plans affecting energy`
    },
    {
      key: 'policyRegulatory',
      topic: `Policy and regulatory environment for ${industry}:
- Government stance on energy efficiency/ESCOs
- Key legislation (names, years, requirements, penalties)
- Foreign ownership limits and exceptions
- Tax incentives and BOI promotion categories
- Regulatory enforcement reality (not just what's written)`
    },
    {
      key: 'marketDynamics',
      topic: `${industry} market dynamics:
- Market size in USD with year and growth rate
- Who is buying and why (demand drivers)
- Electricity and gas tariffs for industrial users
- Supply chain infrastructure
- Recent market developments (2024-2025)`
    },
    {
      key: 'competitiveLandscape',
      topic: `Competitive landscape for ${industry}:
- Major local players (name, revenue, market position)
- Foreign companies present (entry mode, success level)
- Recent M&A, partnerships, or market entries
- Market concentration and barriers to entry
- Companies seeking partners or up for acquisition`
    },
    {
      key: 'infrastructure',
      topic: `Infrastructure and ecosystem:
- Energy infrastructure (LNG terminals, pipelines, grid quality)
- Key industrial zones and economic corridors
- Smart grid and energy management pilot projects
- Logistics and supply chain bottlenecks`
    },
    {
      key: 'opportunities',
      topic: `Market entry opportunities for a ${clientContext}:
- White spaces in the market
- Potential local partners (who, why they'd partner)
- Upcoming government projects or tenders
- Timing factors (why enter now vs wait)`
    }
  ];

  console.log(`  [Kimi Deep Research - 6 comprehensive searches]`);
  const researchData = {};

  for (const { key, topic } of researchTopics) {
    console.log(`  [${key}] Researching...`);
    const result = await callKimiDeepResearch(topic, country, industry);

    if (result.content) {
      researchData[key] = [{
        topic,
        content: result.content,
        citations: result.citations || []
      }];
    }

    // Small delay between research calls
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Synthesize research into structured output using DeepSeek
  console.log(`  [Synthesizing ${country} data...]`);

  const synthesisPrompt = `You are a strategy consultant analyzing ${country} for a ${clientContext} considering entering the ${industry} market.

CRITICAL: Your analysis must have DEPTH and SPECIFICITY. Not surface-level observations.

For every claim, include:
- SPECIFIC NUMBERS (dollar amounts, percentages, growth rates, years)
- SPECIFIC NAMES (companies, laws, programs, people)
- SPECIFIC CONTEXT (why this number matters, how it compares)

BAD example: "The market is growing"
GOOD example: "The ESCO market reached $2.3B in 2024, growing 12% YoY, driven by mandatory energy audits for factories >2MW under the 2023 Energy Conservation Act"

RESEARCH DATA:
${JSON.stringify(researchData, null, 2)}

Return a JSON object with this structure:
{
  "country": "${country}",
  "macroContext": {
    "gdp": "exact value with year and growth rate (e.g., '$574B in 2024, +2.8% YoY')",
    "population": "exact number with urban/rural split if available",
    "industrialGdpShare": "percentage with trend",
    "energyIntensity": "specific metric with comparison to region",
    "keyObservation": "ONE non-obvious insight connecting these data points"
  },
  "policyRegulatory": {
    "governmentStance": "specific stance with EVIDENCE (cite actual policy, speech, budget allocation)",
    "keyLegislation": ["list SPECIFIC laws with year, what they mandate, and penalties"],
    "foreignOwnershipRules": "EXACT percentage limits, exceptions, which sectors, recent changes",
    "incentives": ["SPECIFIC incentive name, value (% tax cut, years), eligibility criteria"],
    "regulatoryRisk": "low/medium/high with SPECIFIC justification (recent policy reversals? enforcement gaps?)"
  },
  "marketDynamics": {
    "marketSize": "EXACT value, year, CAGR, and what's driving growth",
    "demand": "WHO is buying (which industries), WHY now (triggers), HOW MUCH (volume/value)",
    "pricing": "EXACT electricity/gas prices with unit, comparison to neighbors, trend",
    "supplyChain": "specific gaps or advantages in supply infrastructure"
  },
  "competitiveLandscape": {
    "localPlayers": [{"name": "actual company name", "description": "revenue/size, core business, market share if known, strengths, weaknesses"}],
    "foreignPlayers": [{"name": "actual company name", "description": "when entered, what they do, how successful, partnerships"}],
    "entryBarriers": ["SPECIFIC barriers with evidence - not generic like 'relationships matter'"],
    "competitiveIntensity": "low/medium/high with REASONING (market concentration, price wars, M&A activity)"
  },
  "infrastructure": {
    "energyInfrastructure": "specific capacity numbers, utilization rates, planned expansions",
    "industrialZones": ["name of zone, location, key tenants, incentives offered"],
    "logisticsQuality": "specific metrics or rankings, bottlenecks"
  },
  "summaryAssessment": {
    "opportunities": ["5 SPECIFIC opportunities with WHY NOW and estimated size/value"],
    "obstacles": ["5 SPECIFIC obstacles with severity and whether they're solvable"],
    "attractivenessRating": "1-10 with MULTI-FACTOR justification",
    "feasibilityRating": "1-10 with MULTI-FACTOR justification",
    "keyInsight": "2-3 sentences: DATA observed → PATTERN that emerges → WHY this pattern exists → WHAT IT MEANS for client"
  }
}

Return ONLY valid JSON, no markdown or explanation.`;

  const synthesis = await callDeepSeek(synthesisPrompt, '', 8192);

  let countryAnalysis;
  try {
    let jsonStr = synthesis.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    countryAnalysis = JSON.parse(jsonStr);
  } catch (error) {
    console.error(`Failed to parse first synthesis for ${country}:`, error.message);
    return {
      country,
      error: 'Synthesis failed',
      rawData: researchData,
      researchTimeMs: Date.now() - startTime
    };
  }

  // ============ ITERATIVE REFINEMENT LOOP ============
  // Like Deep Research: identify gaps → research → re-synthesize → repeat if needed

  const MAX_ITERATIONS = 2; // Up to 2 refinement passes
  let iteration = 0;
  let confidence = 'low';

  while (iteration < MAX_ITERATIONS && confidence !== 'high') {
    iteration++;
    console.log(`\n  [ITERATION ${iteration}/${MAX_ITERATIONS}] Refining analysis...`);

    // Step 1: Identify gaps in current analysis
    const gaps = await identifyResearchGaps(countryAnalysis, country, industry);
    confidence = gaps.confidenceAssessment?.overall || 'low';

    // If confidence is high or no critical gaps, we're done
    if (confidence === 'high') {
      console.log(`    ✓ Analysis confidence HIGH - stopping refinement`);
      break;
    }

    const criticalGapCount = (gaps.criticalGaps || []).filter(g => g.priority === 'high').length;
    if (criticalGapCount === 0 && (gaps.dataToVerify || []).length === 0) {
      console.log(`    ✓ No critical gaps found - stopping refinement`);
      break;
    }

    console.log(`    → ${criticalGapCount} high-priority gaps, ${(gaps.dataToVerify || []).length} claims to verify`);

    // Step 2: Execute targeted research to fill gaps
    const additionalData = await fillResearchGaps(gaps, country, industry);

    // Step 3: Re-synthesize with the new data
    if (additionalData.gapResearch.length > 0 || additionalData.verificationResearch.length > 0) {
      countryAnalysis = await reSynthesize(countryAnalysis, additionalData, country, industry, clientContext);
      countryAnalysis.country = country; // Ensure country is set
      countryAnalysis.iterationsCompleted = iteration;
    } else {
      console.log(`    → No additional data collected, stopping refinement`);
      break;
    }
  }

  countryAnalysis.researchTimeMs = Date.now() - startTime;
  countryAnalysis.totalIterations = iteration;
  console.log(`\n  ✓ Completed ${country} in ${(countryAnalysis.researchTimeMs / 1000).toFixed(1)}s (${iteration} refinement iterations)`);

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
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    const review = JSON.parse(jsonStr);
    console.log(`    Score: ${review.overallScore}/10 | Confidence: ${review.confidence} | Verdict: ${review.verdict}`);
    console.log(`    Issues: ${review.criticalIssues?.length || 0} critical | Strengths: ${review.strengths?.length || 0}`);
    return review;
  } catch (error) {
    console.error('  Reviewer failed to parse:', error.message);
    return { overallScore: 5, confidence: 'low', verdict: 'APPROVE', criticalIssues: [] }; // Default to approve on error
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
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
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
      {"name": "actual company", "strengths": "specific", "weaknesses": "specific", "threat": "how they could block you"}
    ],
    "whiteSpaces": ["specific gaps with EVIDENCE of demand and SIZE of opportunity"],
    "potentialPartners": [{"name": "actual company", "rationale": "why they'd partner, what they bring, what you bring"}]
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
6. PROFESSIONAL PROSE. Write like The Economist - clear, precise, analytical. Use technical terms where they add precision, but always explain significance.`;

  const result = await callDeepSeek(prompt, systemPrompt, 12000);

  let synthesis;
  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
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
      rawContent: result.content
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
      console.log(`  ✓ APPROVED after ${revisionCount} revision(s) | Final score: ${review.overallScore}/10`);
      approved = true;
      synthesis.qualityScore = review.overallScore;
      synthesis.reviewIterations = revisionCount;
      break;
    }

    revisionCount++;
    console.log(`\n  [REVISION ${revisionCount}/${MAX_REVISIONS}] Score: ${review.overallScore}/10 - Revising...`);

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
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error('Failed to parse synthesis:', error.message);
    return {
      executiveSummary: ['Synthesis parsing failed - raw content available'],
      rawContent: result.content
    };
  }
}

// ============ PPT GENERATION ============

// Helper: truncate text to fit slides - end at sentence or phrase boundary
// CRITICAL: Never cut mid-sentence. Better to be shorter than incomplete.
function truncate(text, maxLen = 150) {
  if (!text) return '';
  const str = String(text).trim();
  if (str.length <= maxLen) return str;

  // Find the last sentence boundary before maxLen
  const truncated = str.substring(0, maxLen);

  // Try to end at sentence boundary (. ! ?) - look for period followed by space or end
  const sentenceEnders = ['. ', '! ', '? '];
  let lastSentence = -1;
  for (const ender of sentenceEnders) {
    const pos = truncated.lastIndexOf(ender);
    if (pos > lastSentence) lastSentence = pos;
  }
  // Also check for sentence ending at the very end (no trailing space)
  if (truncated.endsWith('.') || truncated.endsWith('!') || truncated.endsWith('?')) {
    lastSentence = Math.max(lastSentence, truncated.length - 1);
  }

  if (lastSentence > maxLen * 0.4) {
    return truncated.substring(0, lastSentence + 1).trim();
  }

  // Try to end at strong phrase boundary (; or :)
  const strongPhrase = Math.max(
    truncated.lastIndexOf('; '),
    truncated.lastIndexOf(': ')
  );
  if (strongPhrase > maxLen * 0.4) {
    return truncated.substring(0, strongPhrase + 1).trim();
  }

  // Try to end at parenthetical close
  const lastParen = truncated.lastIndexOf(')');
  if (lastParen > maxLen * 0.5) {
    return truncated.substring(0, lastParen + 1).trim();
  }

  // Try to end at comma boundary (weaker)
  const lastComma = truncated.lastIndexOf(', ');
  if (lastComma > maxLen * 0.5) {
    return truncated.substring(0, lastComma).trim();
  }

  // Last resort: end at word boundary, but ensure we don't cut mid-word
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) {
    // Check if ending on a preposition/article - if so, cut earlier
    const words = truncated.substring(0, lastSpace).split(' ');
    const lastWord = words[words.length - 1].toLowerCase();
    const badEndings = ['for', 'to', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'by', 'with', 'and', 'or', 'but', 'are', 'is', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'largely', 'mostly', 'mainly'];
    if (badEndings.includes(lastWord) && words.length > 1) {
      // Remove the dangling preposition/article
      words.pop();
      return words.join(' ').trim();
    }
    return truncated.substring(0, lastSpace).trim();
  }

  return truncated.trim();
}

// Helper: truncate subtitle/message text - stricter limits per YCP spec (max ~20 words / 100 chars)
function truncateSubtitle(text, maxLen = 100) {
  if (!text) return '';
  const str = String(text).trim();
  if (str.length <= maxLen) return str;

  // For subtitles, prefer ending at sentence boundary
  const truncated = str.substring(0, maxLen);

  // Look for sentence end
  const lastPeriod = truncated.lastIndexOf('. ');
  if (lastPeriod > maxLen * 0.4) {
    return truncated.substring(0, lastPeriod + 1).trim();
  }

  // Look for other clean breaks
  const lastColon = truncated.lastIndexOf(': ');
  if (lastColon > maxLen * 0.4) {
    return truncated.substring(0, lastColon + 1).trim();
  }

  // Fall back to truncate function
  return truncate(str, maxLen);
}

// Helper: safely get array items
function safeArray(arr, max = 5) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, max);
}

// Single country deep-dive PPT - Matches YCP Escort/Shizuoka Gas format
// Structure: Title → Policy & Regulations → Market → Competitor Overview
async function generateSingleCountryPPT(synthesis, countryAnalysis, scope) {
  console.log(`Generating single-country PPT for ${synthesis.country}...`);

  const pptx = new pptxgen();
  pptx.author = 'YCP Market Research';
  pptx.title = `${synthesis.country} - ${scope.industry} Market Analysis`;
  pptx.subject = scope.projectType;

  // YCP Theme Colors (from profile-slides template)
  const COLORS = {
    headerLine: '293F55',    // Dark navy for header/footer lines
    accent3: '011AB7',       // Dark blue - table header background
    accent1: '007FFF',       // Bright blue - secondary/subtitle
    dk2: '1F497D',           // Section underline/title color
    white: 'FFFFFF',
    black: '000000',
    gray: 'BFBFBF',          // Border color
    footerText: '808080'     // Gray footer text
  };

  // Set default font to Segoe UI (YCP standard)
  pptx.theme = { headFontFace: 'Segoe UI', bodyFontFace: 'Segoe UI' };
  const FONT = 'Segoe UI';

  // Truncate title to max 70 chars
  function truncateTitle(text) {
    if (!text) return '';
    const str = String(text).trim();
    if (str.length <= 70) return str;
    const cut = str.substring(0, 70);
    const lastSpace = cut.lastIndexOf(' ');
    return lastSpace > 40 ? cut.substring(0, lastSpace) : cut;
  }

  // Standard slide layout with title, subtitle, and navy divider line
  function addSlide(title, subtitle = '') {
    const slide = pptx.addSlide();
    // Title - 24pt bold navy
    slide.addText(truncateTitle(title), {
      x: 0.35, y: 0.15, w: 9.3, h: 0.7,
      fontSize: 24, bold: true, color: COLORS.dk2, fontFace: FONT,
      valign: 'top', wrap: true
    });
    // Navy divider line under title
    slide.addShape('line', {
      x: 0.35, y: 0.9, w: 9.3, h: 0,
      line: { color: COLORS.dk2, width: 2.5 }
    });
    // Message/subtitle - 14pt blue (the "so what")
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.35, y: 0.95, w: 9.3, h: 0.3,
        fontSize: 14, color: COLORS.accent1, fontFace: FONT
      });
    }
    return slide;
  }

  const ca = countryAnalysis || {};
  const headlines = synthesis.slideHeadlines || {};
  const country = synthesis.country;

  // ============ SLIDE 1: TITLE ============
  const titleSlide = pptx.addSlide();
  titleSlide.addText(country.toUpperCase(), {
    x: 0.5, y: 2.2, w: 9, h: 0.8,
    fontSize: 42, bold: true, color: COLORS.dk2, fontFace: FONT
  });
  titleSlide.addText(`${scope.industry} Market Analysis`, {
    x: 0.5, y: 3.0, w: 9, h: 0.5,
    fontSize: 24, color: COLORS.accent1, fontFace: FONT
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5, y: 6.5, w: 9, h: 0.3,
    fontSize: 10, color: '666666', fontFace: FONT
  });

  // ============ SLIDE 2: POLICY & REGULATIONS ============
  const reg = ca.policyRegulatory || {};
  const regTitle = headlines.regulation || `${country} - Policy & Regulations`;
  const regSubtitle = reg.governmentStance ? truncateSubtitle(reg.governmentStance, 95) : '';
  const regSlide = addSlide(regTitle, regSubtitle);

  // Policy table - Area | Details format (matching Escort)
  const regRows = [
    [
      { text: 'Area', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } },
      { text: 'Details', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } }
    ]
  ];

  // Add key legislation as separate rows
  const laws = safeArray(reg.keyLegislation, 3);
  laws.forEach((law, idx) => {
    regRows.push([
      { text: `Key Law ${idx + 1}` },
      { text: truncate(law, 100) }
    ]);
  });

  // Add ownership rules
  if (reg.foreignOwnershipRules) {
    regRows.push([
      { text: 'Foreign Ownership' },
      { text: truncate(reg.foreignOwnershipRules, 100) }
    ]);
  }

  // Add incentives
  const incentives = safeArray(reg.incentives, 2);
  incentives.forEach((inc, idx) => {
    regRows.push([
      { text: idx === 0 ? 'Incentives' : '' },
      { text: truncate(inc, 100) }
    ]);
  });

  // Add risk level
  if (reg.regulatoryRisk) {
    regRows.push([
      { text: 'Risk Level' },
      { text: truncate(reg.regulatoryRisk, 100) }
    ]);
  }

  regSlide.addTable(regRows, {
    x: 0.35, y: 1.3, w: 9.3, h: 5.2,
    fontSize: 14, fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.0, 7.3],
    valign: 'top'
  });

  // ============ SLIDE 3: MARKET ============
  const market = ca.marketDynamics || {};
  const macro = ca.macroContext || {};
  const marketTitle = headlines.marketData || `${country} - Market`;
  // Use market size as subtitle - extract just the key figure, not the full detail
  const marketSubtitle = market.marketSize ? truncateSubtitle(market.marketSize, 95) : '';
  const marketSlide = addSlide(marketTitle, marketSubtitle);

  // Market data table - matching Escort format
  const marketRows = [
    [
      { text: 'Metric', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } },
      { text: 'Value', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } }
    ]
  ];

  // Focus on ESCO/industry-specific metrics, not generic macro data
  if (market.marketSize) {
    marketRows.push([{ text: 'Market Size' }, { text: truncate(market.marketSize, 100) }]);
  }
  if (market.demand) {
    marketRows.push([{ text: 'Demand Drivers' }, { text: truncate(market.demand, 100) }]);
  }
  if (market.pricing) {
    marketRows.push([{ text: 'Pricing/Tariffs' }, { text: truncate(market.pricing, 100) }]);
  }
  if (market.supplyChain) {
    marketRows.push([{ text: 'Supply Chain' }, { text: truncate(market.supplyChain, 100) }]);
  }
  // Add macro context only if relevant
  if (macro.energyIntensity) {
    marketRows.push([{ text: 'Energy Intensity' }, { text: truncate(macro.energyIntensity, 100) }]);
  }
  if (macro.keyObservation) {
    marketRows.push([{ text: 'Key Observation' }, { text: truncate(macro.keyObservation, 100) }]);
  }

  marketSlide.addTable(marketRows, {
    x: 0.35, y: 1.3, w: 9.3, h: 5.2,
    fontSize: 14, fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.0, 7.3],
    valign: 'top'
  });

  // ============ SLIDE 4: COMPETITOR OVERVIEW ============
  const comp = ca.competitiveLandscape || {};
  const compTitle = headlines.competition || `${country} - Competitor Overview`;
  // Extract just the intensity level (Low/Medium/High), not the full reasoning
  let compIntensityLevel = '';
  if (comp.competitiveIntensity) {
    const intensityStr = String(comp.competitiveIntensity);
    // Check if it starts with a level indicator
    const levelMatch = intensityStr.match(/^(low|medium|high|medium-high|medium-low)/i);
    if (levelMatch) {
      compIntensityLevel = `Competitive intensity: ${levelMatch[1]}`;
    } else {
      // Truncate to just the first part before any reasoning
      compIntensityLevel = truncateSubtitle(`Competitive intensity: ${intensityStr}`, 60);
    }
  }
  const compSlide = addSlide(compTitle, compIntensityLevel);

  // Competitor table - Company | Type | Description
  const compRows = [
    [
      { text: 'Company', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } },
      { text: 'Type', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } },
      { text: 'Notes', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } }
    ]
  ];

  // Add local players
  safeArray(comp.localPlayers, 3).forEach(p => {
    const name = typeof p === 'string' ? p : (p.name || 'Unknown');
    const desc = typeof p === 'string' ? '' : (p.description || '');
    compRows.push([
      { text: truncate(name, 30) },
      { text: 'Local' },
      { text: truncate(desc, 70) }
    ]);
  });

  // Add foreign players
  safeArray(comp.foreignPlayers, 3).forEach(p => {
    const name = typeof p === 'string' ? p : (p.name || 'Unknown');
    const desc = typeof p === 'string' ? '' : (p.description || '');
    compRows.push([
      { text: truncate(name, 30) },
      { text: 'Foreign' },
      { text: truncate(desc, 70) }
    ]);
  });

  compSlide.addTable(compRows, {
    x: 0.35, y: 1.3, w: 9.3, h: 3.5,
    fontSize: 14, fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.5, 1.0, 5.8],
    valign: 'top'
  });

  // Entry barriers section below table
  const barriers = safeArray(comp.entryBarriers, 4);
  if (barriers.length > 0) {
    compSlide.addShape('line', {
      x: 0.35, y: 4.9, w: 9.3, h: 0,
      line: { color: COLORS.dk2, width: 2.5 }
    });
    compSlide.addText('Barriers to Entry', {
      x: 0.35, y: 5.0, w: 9.3, h: 0.35,
      fontSize: 14, bold: true, color: COLORS.dk2, fontFace: FONT
    });
    compSlide.addText(barriers.map(b => ({ text: truncate(b, 90), options: { bullet: true } })), {
      x: 0.35, y: 5.4, w: 9.3, h: 1.3,
      fontSize: 14, fontFace: FONT, color: COLORS.black, valign: 'top'
    });
  }

  // Next Steps slide removed per user request

  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  console.log(`Single-country PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB`);
  return pptxBuffer;
}

// Multi-country comparison PPT - Matches YCP Escort format
// Structure: Title → Overview → For each country: Policy & Regulations → Market → Competitor Overview
async function generatePPT(synthesis, countryAnalyses, scope) {
  console.log('\n=== STAGE 4: PPT GENERATION ===');

  // Route to single-country PPT if applicable
  if (synthesis.isSingleCountry) {
    return generateSingleCountryPPT(synthesis, countryAnalyses[0], scope);
  }

  const pptx = new pptxgen();
  pptx.author = 'YCP Market Research';
  pptx.title = `${scope.industry} Market Analysis - ${scope.targetMarkets.join(', ')}`;
  pptx.subject = scope.projectType;

  // YCP Theme Colors (from profile-slides template)
  const COLORS = {
    headerLine: '293F55',    // Dark navy for header/footer lines
    accent3: '011AB7',       // Dark blue - table header background
    accent1: '007FFF',       // Bright blue - secondary/subtitle
    dk2: '1F497D',           // Section underline/title color
    white: 'FFFFFF',
    black: '000000',
    gray: 'BFBFBF',          // Border color
    footerText: '808080'     // Gray footer text
  };

  // Set default font to Segoe UI (YCP standard)
  pptx.theme = { headFontFace: 'Segoe UI', bodyFontFace: 'Segoe UI' };
  const FONT = 'Segoe UI';

  // Truncate title to max 70 chars
  function truncateTitle(text) {
    if (!text) return '';
    const str = String(text).trim();
    if (str.length <= 70) return str;
    const cut = str.substring(0, 70);
    const lastSpace = cut.lastIndexOf(' ');
    return lastSpace > 40 ? cut.substring(0, lastSpace) : cut;
  }

  // Standard slide layout with title, subtitle, and navy divider line
  function addSlide(title, subtitle = '') {
    const slide = pptx.addSlide();
    // Title - 24pt bold navy
    slide.addText(truncateTitle(title), {
      x: 0.35, y: 0.15, w: 9.3, h: 0.7,
      fontSize: 24, bold: true, color: COLORS.dk2, fontFace: FONT,
      valign: 'top', wrap: true
    });
    // Navy divider line under title
    slide.addShape('line', {
      x: 0.35, y: 0.9, w: 9.3, h: 0,
      line: { color: COLORS.dk2, width: 2.5 }
    });
    // Message/subtitle - 14pt blue (the "so what")
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.35, y: 0.95, w: 9.3, h: 0.3,
        fontSize: 14, color: COLORS.accent1, fontFace: FONT
      });
    }
    return slide;
  }

  // ============ SLIDE 1: TITLE ============
  const titleSlide = pptx.addSlide();
  titleSlide.addText(scope.industry.toUpperCase(), {
    x: 0.5, y: 2.2, w: 9, h: 0.8,
    fontSize: 36, bold: true, color: COLORS.dk2, fontFace: FONT
  });
  titleSlide.addText('Market Comparison', {
    x: 0.5, y: 3.0, w: 9, h: 0.5,
    fontSize: 24, color: COLORS.accent1, fontFace: FONT
  });
  titleSlide.addText(scope.targetMarkets.join(' | '), {
    x: 0.5, y: 3.6, w: 9, h: 0.4,
    fontSize: 14, color: COLORS.black, fontFace: FONT
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5, y: 6.5, w: 9, h: 0.3,
    fontSize: 10, color: '666666', fontFace: FONT
  });

  // ============ SLIDE 2: OVERVIEW (Comparison Table) ============
  const overviewSlide = addSlide('Overview', 'Market comparison across countries');

  const overviewRows = [
    [
      { text: 'Country', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } },
      { text: 'Market Size', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } },
      { text: 'Foreign Ownership', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } },
      { text: 'Risk Level', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } }
    ]
  ];

  countryAnalyses.forEach(c => {
    if (c.error) return;
    overviewRows.push([
      { text: c.country, options: { fontFace: FONT } },
      { text: truncate(c.marketDynamics?.marketSize || 'N/A', 60), options: { fontFace: FONT } },
      { text: truncate(c.policyRegulatory?.foreignOwnershipRules || 'N/A', 60), options: { fontFace: FONT } },
      { text: truncate(c.policyRegulatory?.regulatoryRisk || 'N/A', 40), options: { fontFace: FONT } }
    ]);
  });

  overviewSlide.addTable(overviewRows, {
    x: 0.35, y: 1.3, w: 9.3, h: 5.2,
    fontSize: 12,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.0, 2.5, 2.5, 2.3],
    valign: 'top'
  });

  // ============ COUNTRY SECTIONS ============
  // For each country: Policy & Regulations → Market → Competitor Overview
  for (const ca of countryAnalyses) {
    if (ca.error) continue;
    const countryName = ca.country;

    // ---------- SLIDE: {Country} - Policy & Regulations ----------
    const reg = ca.policyRegulatory || {};
    const regSubtitle = reg.governmentStance ? truncateSubtitle(reg.governmentStance, 95) : '';
    const regSlide = addSlide(`${countryName} - Policy & Regulations`, regSubtitle);

    const regRows = [
      [
        { text: 'Area', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } },
        { text: 'Details', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } }
      ]
    ];

    // Add key legislation
    const laws = safeArray(reg.keyLegislation, 3);
    laws.forEach((law, idx) => {
      regRows.push([
        { text: `Key Law ${idx + 1}` },
        { text: truncate(law, 100) }
      ]);
    });

    if (reg.foreignOwnershipRules) {
      regRows.push([{ text: 'Foreign Ownership' }, { text: truncate(reg.foreignOwnershipRules, 100) }]);
    }

    const incentives = safeArray(reg.incentives, 2);
    incentives.forEach((inc, idx) => {
      regRows.push([{ text: idx === 0 ? 'Incentives' : '' }, { text: truncate(inc, 100) }]);
    });

    if (reg.regulatoryRisk) {
      regRows.push([{ text: 'Risk Level' }, { text: truncate(reg.regulatoryRisk, 100) }]);
    }

    regSlide.addTable(regRows, {
      x: 0.35, y: 1.3, w: 9.3, h: 5.2,
      fontSize: 14, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.0, 7.3],
      valign: 'top'
    });

    // ---------- SLIDE: {Country} - Market ----------
    const market = ca.marketDynamics || {};
    const macro = ca.macroContext || {};
    const marketSubtitle = market.marketSize ? truncateSubtitle(market.marketSize, 95) : '';
    const marketSlide = addSlide(`${countryName} - Market`, marketSubtitle);

    const marketRows = [
      [
        { text: 'Metric', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } },
        { text: 'Value', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } }
      ]
    ];

    if (market.marketSize) {
      marketRows.push([{ text: 'Market Size' }, { text: truncate(market.marketSize, 100) }]);
    }
    if (market.demand) {
      marketRows.push([{ text: 'Demand Drivers' }, { text: truncate(market.demand, 100) }]);
    }
    if (market.pricing) {
      marketRows.push([{ text: 'Pricing/Tariffs' }, { text: truncate(market.pricing, 100) }]);
    }
    if (market.supplyChain) {
      marketRows.push([{ text: 'Supply Chain' }, { text: truncate(market.supplyChain, 100) }]);
    }
    if (macro.energyIntensity) {
      marketRows.push([{ text: 'Energy Intensity' }, { text: truncate(macro.energyIntensity, 100) }]);
    }
    if (macro.keyObservation) {
      marketRows.push([{ text: 'Key Observation' }, { text: truncate(macro.keyObservation, 100) }]);
    }

    marketSlide.addTable(marketRows, {
      x: 0.35, y: 1.3, w: 9.3, h: 5.2,
      fontSize: 14, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.0, 7.3],
      valign: 'top'
    });

    // ---------- SLIDE: {Country} - Competitor Overview ----------
    const comp = ca.competitiveLandscape || {};
    // Extract just the intensity level (Low/Medium/High), not the full reasoning
    let compIntensityLevel = '';
    if (comp.competitiveIntensity) {
      const intensityStr = String(comp.competitiveIntensity);
      const levelMatch = intensityStr.match(/^(low|medium|high|medium-high|medium-low)/i);
      if (levelMatch) {
        compIntensityLevel = `Competitive intensity: ${levelMatch[1]}`;
      } else {
        compIntensityLevel = truncateSubtitle(`Competitive intensity: ${intensityStr}`, 60);
      }
    }
    const compSlide = addSlide(`${countryName} - Competitor Overview`, compIntensityLevel);

    const compRows = [
      [
        { text: 'Company', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } },
        { text: 'Type', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } },
        { text: 'Notes', options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT } }
      ]
    ];

    safeArray(comp.localPlayers, 3).forEach(p => {
      const name = typeof p === 'string' ? p : (p.name || 'Unknown');
      const desc = typeof p === 'string' ? '' : (p.description || '');
      compRows.push([
        { text: truncate(name, 30) },
        { text: 'Local' },
        { text: truncate(desc, 70) }
      ]);
    });

    safeArray(comp.foreignPlayers, 3).forEach(p => {
      const name = typeof p === 'string' ? p : (p.name || 'Unknown');
      const desc = typeof p === 'string' ? '' : (p.description || '');
      compRows.push([
        { text: truncate(name, 30) },
        { text: 'Foreign' },
        { text: truncate(desc, 70) }
      ]);
    });

    compSlide.addTable(compRows, {
      x: 0.35, y: 1.3, w: 9.3, h: 3.5,
      fontSize: 14, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.5, 1.0, 5.8],
      valign: 'top'
    });

    // Entry barriers section
    const barriers = safeArray(comp.entryBarriers, 4);
    if (barriers.length > 0) {
      compSlide.addShape('line', {
        x: 0.35, y: 4.9, w: 9.3, h: 0,
        line: { color: COLORS.dk2, width: 2.5 }
      });
      compSlide.addText('Barriers to Entry', {
        x: 0.35, y: 5.0, w: 9.3, h: 0.35,
        fontSize: 14, bold: true, color: COLORS.dk2, fontFace: FONT
      });
      compSlide.addText(barriers.map(b => ({ text: truncate(b, 90), options: { bullet: true } })), {
        x: 0.35, y: 5.4, w: 9.3, h: 1.3,
        fontSize: 14, fontFace: FONT, color: COLORS.black, valign: 'top'
      });
    }
  }

  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  console.log(`PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB`);

  return pptxBuffer;
}

// ============ EMAIL DELIVERY ============

async function sendEmail(to, subject, html, attachment) {
  console.log('\n=== STAGE 5: EMAIL DELIVERY ===');
  console.log(`Sending to: ${to}`);

  const emailData = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: process.env.SENDER_EMAIL, name: 'Market Research AI' },
    subject: subject,
    content: [{ type: 'text/html', value: html }],
    attachments: [{
      filename: attachment.filename,
      content: attachment.content,
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      disposition: 'attachment'
    }]
  };

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailData)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Email failed: ${error}`);
  }

  console.log('Email sent successfully');
  return { success: true };
}

// ============ MAIN ORCHESTRATOR ============

async function runMarketResearch(userPrompt, email) {
  const startTime = Date.now();
  console.log('\n========================================');
  console.log('MARKET RESEARCH - START');
  console.log('========================================');
  console.log('Time:', new Date().toISOString());
  console.log('Email:', email);

  // Reset cost tracker
  costTracker.totalCost = 0;
  costTracker.calls = [];

  try {
    // Stage 1: Parse scope
    const scope = await parseScope(userPrompt);

    // Stage 2: Research each country (in parallel with limit)
    console.log('\n=== STAGE 2: COUNTRY RESEARCH ===');
    console.log(`Researching ${scope.targetMarkets.length} countries...`);

    const countryAnalyses = [];

    // Process countries in batches of 2 to manage API rate limits
    for (let i = 0; i < scope.targetMarkets.length; i += 2) {
      const batch = scope.targetMarkets.slice(i, i + 2);
      const batchResults = await Promise.all(
        batch.map(country => researchCountry(country, scope.industry, scope.clientContext))
      );
      countryAnalyses.push(...batchResults);
    }

    // Stage 3: Synthesize findings
    const synthesis = await synthesizeFindings(countryAnalyses, scope);

    // Stage 4: Generate PPT
    const pptBuffer = await generatePPT(synthesis, countryAnalyses, scope);

    // Stage 5: Send email
    const filename = `Market_Research_${scope.industry.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.pptx`;

    const emailHtml = `
      <p>Your market research report is attached.</p>
      <p style="color: #666; font-size: 12px;">${scope.industry} - ${scope.targetMarkets.join(', ')}</p>
    `;

    await sendEmail(email, `Market Research: ${scope.industry} - ${scope.targetMarkets.join(', ')}`, emailHtml, {
      filename,
      content: pptBuffer.toString('base64')
    });

    const totalTime = (Date.now() - startTime) / 1000;
    console.log('\n========================================');
    console.log('MARKET RESEARCH - COMPLETE');
    console.log('========================================');
    console.log(`Total time: ${totalTime.toFixed(0)} seconds (${(totalTime / 60).toFixed(1)} minutes)`);
    console.log(`Total cost: $${costTracker.totalCost.toFixed(2)}`);
    console.log(`Countries analyzed: ${countryAnalyses.length}`);

    return {
      success: true,
      scope,
      countriesAnalyzed: countryAnalyses.length,
      totalCost: costTracker.totalCost,
      totalTimeSeconds: totalTime
    };

  } catch (error) {
    console.error('Market research failed:', error);

    // Try to send error email
    try {
      await sendEmail(email, 'Market Research Failed', `
        <h2>Market Research Error</h2>
        <p>Your market research request encountered an error:</p>
        <pre>${error.message}</pre>
        <p>Please try again or contact support.</p>
      `, { filename: 'error.txt', content: Buffer.from(error.stack || error.message).toString('base64') });
    } catch (emailError) {
      console.error('Failed to send error email:', emailError);
    }

    throw error;
  }
}

// ============ API ENDPOINTS ============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'market-research',
    timestamp: new Date().toISOString(),
    costToday: costTracker.totalCost
  });
});

// Main research endpoint
app.post('/api/market-research', async (req, res) => {
  const { prompt, email } = req.body;

  if (!prompt || !email) {
    return res.status(400).json({ error: 'Missing required fields: prompt, email' });
  }

  // Respond immediately - research runs in background
  res.json({
    success: true,
    message: 'Market research started. Results will be emailed when complete.',
    estimatedTime: '30-60 minutes'
  });

  // Run research in background
  runMarketResearch(prompt, email).catch(error => {
    console.error('Background research failed:', error);
  });
});

// Cost tracking endpoint
app.get('/api/costs', (req, res) => {
  res.json(costTracker);
});

// ============ START SERVER ============

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`Market Research server running on port ${PORT}`);
  console.log('Environment check:');
  console.log('  - DEEPSEEK_API_KEY:', process.env.DEEPSEEK_API_KEY ? 'Set' : 'MISSING');
  console.log('  - PERPLEXITY_API_KEY:', process.env.PERPLEXITY_API_KEY ? 'Set' : 'MISSING');
  console.log('  - SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'Set' : 'MISSING');
  console.log('  - SENDER_EMAIL:', process.env.SENDER_EMAIL || 'MISSING');
});
