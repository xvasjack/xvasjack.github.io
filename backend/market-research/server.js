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
const requiredEnvVars = ['DEEPSEEK_API_KEY', 'PERPLEXITY_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
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
  'perplexity': { perSearch: 0.005 },                  // Sonar basic
  'perplexity-pro': { perSearch: 0.015 }               // Sonar Pro
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

// Perplexity API for web search - using sonar-pro for deeper research
async function callPerplexity(query) {
  try {
    // Use sonar-pro for more thorough search results
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{
          role: 'system',
          content: 'You are a market research analyst. Provide detailed, factual information with specific numbers, dates, and sources. Focus on recent data (2023-2025).'
        }, {
          role: 'user',
          content: query
        }],
        max_tokens: 4096,
        temperature: 0.1,
        search_recency_filter: 'year',
        return_citations: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Perplexity HTTP error ${response.status}:`, errorText.substring(0, 200));
      // Fallback to basic sonar model
      return callPerplexityBasic(query);
    }

    const data = await response.json();
    trackCost('perplexity-pro', 0, 0, 1);

    return {
      content: data.choices?.[0]?.message?.content || '',
      citations: data.citations || []
    };
  } catch (error) {
    console.error('Perplexity API error:', error.message);
    return { content: '', citations: [] };
  }
}

// Fallback to basic sonar model
async function callPerplexityBasic(query) {
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: query }],
        max_tokens: 2048,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      return { content: '', citations: [] };
    }

    const data = await response.json();
    trackCost('perplexity', 0, 0, 1);

    return {
      content: data.choices?.[0]?.message?.content || '',
      citations: data.citations || []
    };
  } catch (error) {
    return { content: '', citations: [] };
  }
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

// ============ COUNTRY RESEARCH AGENT ============

async function researchCountry(country, industry, clientContext) {
  console.log(`\n=== RESEARCHING: ${country} ===`);
  const startTime = Date.now();

  const researchData = {};

  // Run all research queries
  for (const [sectionKey, section] of Object.entries(RESEARCH_FRAMEWORK)) {
    console.log(`  [${section.name}]`);
    const sectionData = [];

    for (const queryTemplate of section.queries) {
      const query = queryTemplate.replace(/{country}/g, country).replace(/{industry}/g, industry);
      console.log(`    Searching: ${query.substring(0, 60)}...`);

      const result = await callPerplexity(query);
      if (result.content) {
        sectionData.push({
          query,
          content: result.content,
          citations: result.citations
        });
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    researchData[sectionKey] = sectionData;
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

  try {
    let jsonStr = synthesis.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    const countryAnalysis = JSON.parse(jsonStr);
    countryAnalysis.researchTimeMs = Date.now() - startTime;
    console.log(`  Completed ${country} in ${countryAnalysis.researchTimeMs}ms`);
    return countryAnalysis;
  } catch (error) {
    console.error(`Failed to synthesize ${country}:`, error.message);
    return {
      country,
      error: 'Synthesis failed',
      rawData: researchData,
      researchTimeMs: Date.now() - startTime
    };
  }
}

// ============ SINGLE COUNTRY DEEP DIVE ============

async function synthesizeSingleCountry(countryAnalysis, scope) {
  console.log('\n=== STAGE 3: SINGLE COUNTRY DEEP DIVE ===');
  console.log(`Generating deep analysis for ${countryAnalysis.country}...`);

  const systemPrompt = `You are a senior partner at McKinsey presenting to a CEO. Your analysis must tell a STORY that builds to a clear recommendation.

CRITICAL RULES:
1. NO GENERIC STATEMENTS. Everything must be specific to this country and industry.
2. EVERY CLAIM needs a number, name, or specific evidence behind it.
3. BUILD A NARRATIVE: Start with what makes this market interesting → what challenges exist → how to overcome them → why this path wins.
4. INSIGHTS must be NON-OBVIOUS. Not "the market is large" but "the gap between industrial electricity prices ($0.12/kWh) and ESCO contract rates (15% savings) creates a $340M addressable market among manufacturers spending >$1M/year on energy."
5. ENTRY OPTIONS must be genuinely different strategies, not variations of the same thing.

The CEO should finish reading and think: "I understand exactly why we should/shouldn't enter, and exactly what to do first."`;

  const prompt = `Client: ${scope.clientContext}
Industry: ${scope.industry}
Target: ${countryAnalysis.country}

DATA GATHERED:
${JSON.stringify(countryAnalysis, null, 2)}

Create a DEEP strategic analysis. Tell a story. Build to a recommendation.

Return JSON with:

{
  "executiveSummary": [
    "5 bullets that tell the STORY: what's the opportunity, why now, what's hard, what's the path, what's the first move",
    "Each bullet should have a SPECIFIC number or fact",
    "These should make someone want to read the rest"
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
      "title": "short punchy headline",
      "data": "specific observation from research",
      "pattern": "what this reveals when combined with other data",
      "mechanism": "WHY this pattern exists (causal explanation)",
      "implication": "what this means for the entry decision - specific and actionable"
    }
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
    "summary": "one sentence that captures THE key message (e.g., 'Thailand offers $90M opportunity but requires local partner')",
    "marketData": "one sentence insight about the market numbers (e.g., 'Industrial electricity prices 40% above regional average create savings urgency')",
    "competition": "one sentence about competitive landscape (e.g., 'No foreign player has cracked industrial segment - first mover advantage available')",
    "regulation": "one sentence about regulatory situation (e.g., 'BOI incentives make 2025 ideal entry window before policy review')",
    "risks": "one sentence about risk posture (e.g., 'Currency volatility is real but hedgeable - execution risk is the bigger concern')"
  }
}

Make it DEEP. Make it SPECIFIC. Make it tell a STORY.`;

  const result = await callDeepSeek(prompt, systemPrompt, 12000);

  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    const synthesis = JSON.parse(jsonStr);
    synthesis.isSingleCountry = true;
    synthesis.country = countryAnalysis.country;
    return synthesis;
  } catch (error) {
    console.error('Failed to parse single country synthesis:', error.message);
    return {
      isSingleCountry: true,
      country: countryAnalysis.country,
      executiveSummary: ['Deep analysis parsing failed - raw content available'],
      rawContent: result.content
    };
  }
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

// Helper: truncate text to fit slides - INCREASED LIMITS
function truncate(text, maxLen = 200) {
  if (!text) return '';
  const str = String(text);
  return str.length > maxLen ? str.substring(0, maxLen - 3) + '...' : str;
}

// Helper: safely get array items
function safeArray(arr, max = 5) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, max);
}

// Single country deep-dive PPT - RESTRUCTURED for actual analysis
async function generateSingleCountryPPT(synthesis, countryAnalysis, scope) {
  console.log(`Generating single-country PPT for ${synthesis.country}...`);

  const pptx = new pptxgen();
  pptx.author = 'Market Research AI';
  pptx.title = `${scope.industry} Market Entry - ${synthesis.country}`;
  pptx.subject = scope.projectType;

  const COLORS = {
    primary: '1a365d',
    secondary: '2c5282',
    accent: 'ed8936',
    text: '2d3748',
    lightBg: 'f7fafc',
    white: 'ffffff',
    green: '38a169',
    red: 'c53030'
  };

  function addSlide(title, subtitle = '') {
    const slide = pptx.addSlide();
    slide.addText(title, {
      x: 0.5, y: 0.3, w: 9, h: 0.5,
      fontSize: 24, bold: true, color: COLORS.primary
    });
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.5, y: 0.75, w: 9, h: 0.25,
        fontSize: 11, color: COLORS.secondary
      });
    }
    return slide;
  }

  // SLIDE 1: Title
  const titleSlide = pptx.addSlide();
  titleSlide.addText(synthesis.country.toUpperCase(), {
    x: 0.5, y: 2.2, w: 9, h: 0.8,
    fontSize: 42, bold: true, color: COLORS.primary
  });
  titleSlide.addText(`${scope.industry} Market Analysis`, {
    x: 0.5, y: 3.0, w: 9, h: 0.5,
    fontSize: 24, color: COLORS.secondary
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5, y: 6.5, w: 9, h: 0.3,
    fontSize: 12, color: COLORS.text
  });

  // Get insight-driven headlines if available
  const headlines = synthesis.slideHeadlines || {};

  // SLIDE 2: Summary (1 slide, key points only)
  const summaryTitle = headlines.summary || 'Executive Summary';
  const execSlide = addSlide(truncate(summaryTitle, 80), 'Key Findings');
  const execBullets = safeArray(synthesis.executiveSummary, 5);
  execSlide.addText(execBullets.map(b => ({
    text: truncate(b, 300),
    options: { bullet: true }
  })), {
    x: 0.5, y: 1.1, w: 9, h: 5.5,
    fontSize: 12, color: COLORS.text, valign: 'top', lineSpacing: 20
  });

  // SLIDE 3: Market Size Data (ACTUAL NUMBERS)
  const marketTitle = headlines.marketData || 'Market Data';
  const marketSlide = addSlide(truncate(marketTitle, 80), 'What the numbers show');
  const ca = countryAnalysis || {};
  const macro = ca.macroContext || {};
  const market = ca.marketDynamics || {};

  // Create data table
  const marketRows = [
    [
      { text: 'Metric', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Value', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } }
    ],
    [{ text: 'GDP' }, { text: truncate(macro.gdp || 'N/A', 150) }],
    [{ text: 'Population' }, { text: truncate(macro.population || 'N/A', 150) }],
    [{ text: 'Industry Share of GDP' }, { text: truncate(macro.industrialGdpShare || 'N/A', 150) }],
    [{ text: 'Market Size' }, { text: truncate(market.marketSize || 'N/A', 150) }],
    [{ text: 'Energy Prices' }, { text: truncate(market.pricing || 'N/A', 150) }],
    [{ text: 'Demand Drivers' }, { text: truncate(market.demand || 'N/A', 150) }]
  ];

  marketSlide.addTable(marketRows, {
    x: 0.5, y: 1.1, w: 9, h: 4.5,
    fontSize: 11,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [3, 6]
  });

  // SLIDE 4: Competitor Data (TABLE FORMAT)
  const compTitle = headlines.competition || 'Competitive Landscape';
  const compSlide = addSlide(truncate(compTitle, 80), 'Who is already in this market');
  const comp = ca.competitiveLandscape || {};

  const compRows = [
    [
      { text: 'Company', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Type', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Notes', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } }
    ]
  ];

  // Add local players
  safeArray(comp.localPlayers, 3).forEach(p => {
    const name = typeof p === 'string' ? p : (p.name || 'Unknown');
    const desc = typeof p === 'string' ? '' : (p.description || '');
    compRows.push([
      { text: truncate(name, 40) },
      { text: 'Local' },
      { text: truncate(desc, 100) }
    ]);
  });

  // Add foreign players
  safeArray(comp.foreignPlayers, 3).forEach(p => {
    const name = typeof p === 'string' ? p : (p.name || 'Unknown');
    const desc = typeof p === 'string' ? '' : (p.description || '');
    compRows.push([
      { text: truncate(name, 40) },
      { text: 'Foreign' },
      { text: truncate(desc, 100) }
    ]);
  });

  compSlide.addTable(compRows, {
    x: 0.5, y: 1.1, w: 9, h: 3.5,
    fontSize: 10,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.5, 1.5, 5]
  });

  // Entry barriers below
  compSlide.addText('Barriers to Entry:', {
    x: 0.5, y: 4.8, w: 9, h: 0.3,
    fontSize: 12, bold: true, color: COLORS.secondary
  });
  const barriers = safeArray(comp.entryBarriers, 4);
  compSlide.addText(barriers.map(b => ({ text: truncate(b, 150), options: { bullet: true } })), {
    x: 0.5, y: 5.2, w: 9, h: 1.8,
    fontSize: 10, color: COLORS.text, valign: 'top'
  });

  // SLIDE 5: Regulatory Data
  const regTitle = headlines.regulation || 'Regulatory Environment';
  const regSlide = addSlide(truncate(regTitle, 80), 'Rules you need to follow');
  const reg = ca.policyRegulatory || {};

  const regRows = [
    [
      { text: 'Area', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Details', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } }
    ],
    [{ text: 'Government Stance' }, { text: truncate(reg.governmentStance || 'N/A', 150) }],
    [{ text: 'Foreign Ownership Rules' }, { text: truncate(reg.foreignOwnershipRules || 'N/A', 150) }],
    [{ text: 'Risk Level' }, { text: truncate(reg.regulatoryRisk || 'N/A', 150) }]
  ];

  regSlide.addTable(regRows, {
    x: 0.5, y: 1.1, w: 9, h: 2,
    fontSize: 11,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [3, 6]
  });

  // Key laws
  regSlide.addText('Key Laws & Policies:', {
    x: 0.5, y: 3.3, w: 9, h: 0.3,
    fontSize: 12, bold: true, color: COLORS.secondary
  });
  const laws = safeArray(reg.keyLegislation, 4);
  regSlide.addText(laws.map(l => ({ text: truncate(l, 180), options: { bullet: true } })), {
    x: 0.5, y: 3.7, w: 9, h: 1.5,
    fontSize: 10, color: COLORS.text, valign: 'top'
  });

  // Incentives
  regSlide.addText('Available Incentives:', {
    x: 0.5, y: 5.3, w: 9, h: 0.3,
    fontSize: 12, bold: true, color: COLORS.green
  });
  const incentives = safeArray(reg.incentives, 3);
  regSlide.addText(incentives.map(i => ({ text: truncate(i, 180), options: { bullet: true } })), {
    x: 0.5, y: 5.7, w: 9, h: 1.2,
    fontSize: 10, color: COLORS.text, valign: 'top'
  });

  // SLIDE 6: What We Found (Analysis based on data)
  const analysisSlide = addSlide('What We Found', 'Patterns from the research');
  const summary = ca.summaryAssessment || {};

  // Opportunities
  analysisSlide.addText('Opportunities', {
    x: 0.5, y: 1.1, w: 4.2, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.green
  });
  const opps = safeArray(summary.opportunities, 4);
  analysisSlide.addText(opps.map(o => ({ text: truncate(o, 120), options: { bullet: true } })), {
    x: 0.5, y: 1.5, w: 4.2, h: 2.5,
    fontSize: 10, color: COLORS.text, valign: 'top'
  });

  // Obstacles
  analysisSlide.addText('Obstacles', {
    x: 5, y: 1.1, w: 4.5, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.red
  });
  const obs = safeArray(summary.obstacles, 4);
  analysisSlide.addText(obs.map(o => ({ text: truncate(o, 120), options: { bullet: true } })), {
    x: 5, y: 1.5, w: 4.5, h: 2.5,
    fontSize: 10, color: COLORS.text, valign: 'top'
  });

  // Key insight
  analysisSlide.addText('Key Insight:', {
    x: 0.5, y: 4.2, w: 9, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.accent
  });
  analysisSlide.addText(truncate(summary.keyInsight || 'See detailed analysis', 300), {
    x: 0.5, y: 4.6, w: 9, h: 1.8,
    fontSize: 11, color: COLORS.text, valign: 'top'
  });

  // Ratings
  analysisSlide.addText(
    `Market Attractiveness: ${summary.attractivenessRating || 'N/A'}/10    Feasibility: ${summary.feasibilityRating || 'N/A'}/10`,
    {
      x: 0.5, y: 6.6, w: 9, h: 0.3,
      fontSize: 11, bold: true, color: COLORS.primary
    }
  );

  // SLIDE 7: Key Insights (THE STORY)
  const keyInsights = safeArray(synthesis.keyInsights, 3);
  if (keyInsights.length > 0) {
    const insightSlide = addSlide('Key Insights', 'What the data tells us');
    let insightY = 1.1;

    keyInsights.forEach((insight, idx) => {
      const title = typeof insight === 'string' ? `Insight ${idx + 1}` : (insight.title || `Insight ${idx + 1}`);
      const body = typeof insight === 'string' ? insight :
        `${insight.data || ''} → ${insight.pattern || ''} → ${insight.implication || ''}`;

      insightSlide.addText(`${idx + 1}. ${truncate(title, 100)}`, {
        x: 0.5, y: insightY, w: 9, h: 0.35,
        fontSize: 12, bold: true, color: COLORS.accent
      });

      insightSlide.addText(truncate(body, 400), {
        x: 0.5, y: insightY + 0.4, w: 9, h: 1.3,
        fontSize: 10, color: COLORS.text, valign: 'top'
      });

      insightY += 1.85;
    });
  }

  // SLIDE 8: Entry Options (COMPARISON TABLE)
  const stratSlide = addSlide('Entry Options', 'Three ways to enter this market');
  const entryOpts = synthesis.entryStrategyOptions || synthesis.entryOptions || {};

  const optRows = [
    [
      { text: '', options: { fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Option A', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Option B', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Option C', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } }
    ]
  ];

  const optA = entryOpts.optionA || entryOpts.A || {};
  const optB = entryOpts.optionB || entryOpts.B || {};
  const optC = entryOpts.optionC || entryOpts.C || {};

  const getOptField = (opt, field) => {
    if (typeof opt === 'string') return truncate(opt, 80);
    return truncate(opt[field] || opt.description || 'N/A', 80);
  };

  optRows.push([
    { text: 'Approach', options: { bold: true } },
    { text: getOptField(optA, 'name') },
    { text: getOptField(optB, 'name') },
    { text: getOptField(optC, 'name') }
  ]);

  optRows.push([
    { text: 'Pros', options: { bold: true } },
    { text: getOptField(optA, 'pros') },
    { text: getOptField(optB, 'pros') },
    { text: getOptField(optC, 'pros') }
  ]);

  optRows.push([
    { text: 'Cons', options: { bold: true } },
    { text: getOptField(optA, 'cons') },
    { text: getOptField(optB, 'cons') },
    { text: getOptField(optC, 'cons') }
  ]);

  stratSlide.addTable(optRows, {
    x: 0.5, y: 1.1, w: 9, h: 3.5,
    fontSize: 9,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [1.5, 2.5, 2.5, 2.5]
  });

  // Recommendation
  const recommended = entryOpts.recommendedOption || entryOpts.recommendation;
  if (recommended) {
    stratSlide.addText('Recommended:', {
      x: 0.5, y: 4.8, w: 9, h: 0.3,
      fontSize: 12, bold: true, color: COLORS.accent
    });
    const recText = typeof recommended === 'string' ? recommended : (recommended.option || recommended.rationale || JSON.stringify(recommended));
    stratSlide.addText(truncate(recText, 250), {
      x: 0.5, y: 5.2, w: 9, h: 1.5,
      fontSize: 11, color: COLORS.text, valign: 'top'
    });
  }

  // SLIDE 8: Risks (PROPERLY FORMATTED)
  const riskTitle = headlines.risks || 'Risk Assessment';
  const riskSlide = addSlide(truncate(riskTitle, 80), 'What could go wrong and how to handle it');
  const riskAssess = synthesis.riskAssessment || synthesis.risks || {};
  const criticalRisks = safeArray(riskAssess.criticalRisks || riskAssess.risks, 4);

  // Risk table
  const riskRows = [
    [
      { text: 'Risk', options: { bold: true, fill: { color: COLORS.red }, color: COLORS.white } },
      { text: 'How to Handle', options: { bold: true, fill: { color: COLORS.red }, color: COLORS.white } }
    ]
  ];

  criticalRisks.forEach(r => {
    const riskName = typeof r === 'string' ? r : (r.risk || r.name || 'Risk');
    const mitigation = typeof r === 'string' ? '' : (r.mitigation || '');
    riskRows.push([
      { text: truncate(riskName, 100) },
      { text: truncate(mitigation, 150) }
    ]);
  });

  riskSlide.addTable(riskRows, {
    x: 0.5, y: 1.1, w: 9, h: 2.8,
    fontSize: 10,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [4, 5]
  });

  // Go/No-Go criteria
  const goNoGo = safeArray(riskAssess.goNoGoCriteria || riskAssess.goNoGo, 4);
  if (goNoGo.length > 0) {
    riskSlide.addText('Go/No-Go Checklist:', {
      x: 0.5, y: 4.1, w: 9, h: 0.3,
      fontSize: 12, bold: true, color: COLORS.secondary
    });
    riskSlide.addText(goNoGo.map(g => ({
      text: truncate(typeof g === 'string' ? g : (g.criteria || g.description), 150),
      options: { bullet: true }
    })), {
      x: 0.5, y: 4.5, w: 9, h: 2,
      fontSize: 10, color: COLORS.text, valign: 'top'
    });
  }

  // SLIDE 9: Roadmap (Based on analysis)
  const roadmapSlide = addSlide('Roadmap', 'Steps based on what we found');
  const roadmap = synthesis.implementationRoadmap || synthesis.roadmap || {};

  const phases = [
    { key: 'phase1', label: 'Months 0-6', color: COLORS.secondary },
    { key: 'phase2', label: 'Months 6-12', color: COLORS.accent },
    { key: 'phase3', label: 'Months 12-24', color: COLORS.green }
  ];

  // Helper to strip month prefixes like "Months 0-6:" from content
  const stripMonthPrefix = (text) => {
    if (!text) return '';
    return String(text).replace(/^(months?\s*\d+[-–]\d+\s*:?\s*)/i, '').trim();
  };

  let phaseY = 1.1;
  phases.forEach(phase => {
    const actions = roadmap[phase.key] || roadmap[phase.label] || [];
    roadmapSlide.addText(phase.label, {
      x: 0.5, y: phaseY, w: 9, h: 0.35,
      fontSize: 13, bold: true, color: phase.color
    });

    const actionList = Array.isArray(actions) ? actions : [actions];
    roadmapSlide.addText(safeArray(actionList, 3).map(a => ({
      text: truncate(stripMonthPrefix(a), 180),
      options: { bullet: true }
    })), {
      x: 0.5, y: phaseY + 0.4, w: 9, h: 1.3,
      fontSize: 10, color: COLORS.text, valign: 'top'
    });
    phaseY += 1.9;
  });

  // SLIDE 10: Next Steps
  const nextSlide = addSlide('Next Steps', 'What to do now');
  const nextSteps = safeArray(synthesis.nextSteps || [
    'Talk to local experts to validate findings',
    'Identify potential partners',
    'Build financial model',
    'Visit the market'
  ], 5);

  nextSlide.addText(nextSteps.map((step, idx) => ({
    text: `${idx + 1}. ${truncate(typeof step === 'string' ? step : (step.action || step.description), 200)}`,
    options: { bullet: false, breakLine: true }
  })), {
    x: 0.5, y: 1.1, w: 9, h: 5,
    fontSize: 13, color: COLORS.text, valign: 'top', lineSpacing: 28
  });

  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  console.log(`Single-country PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB`);
  return pptxBuffer;
}

// Multi-country comparison PPT - RESTRUCTURED with actual data
async function generatePPT(synthesis, countryAnalyses, scope) {
  console.log('\n=== STAGE 4: PPT GENERATION ===');

  // Route to single-country PPT if applicable
  if (synthesis.isSingleCountry) {
    return generateSingleCountryPPT(synthesis, countryAnalyses[0], scope);
  }

  const pptx = new pptxgen();
  pptx.author = 'Market Research AI';
  pptx.title = `${scope.industry} Market Analysis - ${scope.targetMarkets.join(', ')}`;
  pptx.subject = scope.projectType;

  const COLORS = {
    primary: '1a365d',
    secondary: '2c5282',
    accent: 'ed8936',
    text: '2d3748',
    lightBg: 'f7fafc',
    white: 'ffffff',
    green: '38a169',
    red: 'c53030'
  };

  function addSlide(title, subtitle = '') {
    const slide = pptx.addSlide();
    slide.addText(title, {
      x: 0.5, y: 0.3, w: 9, h: 0.5,
      fontSize: 24, bold: true, color: COLORS.primary
    });
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.5, y: 0.75, w: 9, h: 0.25,
        fontSize: 11, color: COLORS.secondary
      });
    }
    return slide;
  }

  // SLIDE 1: Title
  const titleSlide = pptx.addSlide();
  titleSlide.addText(scope.industry.toUpperCase(), {
    x: 0.5, y: 2.2, w: 9, h: 0.8,
    fontSize: 36, bold: true, color: COLORS.primary
  });
  titleSlide.addText('Market Comparison', {
    x: 0.5, y: 3.0, w: 9, h: 0.5,
    fontSize: 24, color: COLORS.secondary
  });
  titleSlide.addText(scope.targetMarkets.join(' | '), {
    x: 0.5, y: 3.6, w: 9, h: 0.4,
    fontSize: 14, color: COLORS.text
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5, y: 6.5, w: 9, h: 0.3,
    fontSize: 12, color: COLORS.text
  });

  // Get insight-driven headlines if available
  const headlines = synthesis.slideHeadlines || {};

  // SLIDE 2: Summary
  const summaryTitle = headlines.summary || 'Executive Summary';
  const execSlide = addSlide(truncate(summaryTitle, 80), 'Key Recommendations');
  const execBullets = safeArray(synthesis.executiveSummary, 5);
  execSlide.addText(execBullets.map(b => ({
    text: truncate(b, 150),
    options: { bullet: true }
  })), {
    x: 0.5, y: 1.1, w: 9, h: 5.5,
    fontSize: 13, color: COLORS.text, valign: 'top', lineSpacing: 22
  });

  // SLIDE 3: Market Size Comparison (DATA TABLE)
  const marketCompTitle = headlines.marketComparison || 'Market Data Comparison';
  const marketCompSlide = addSlide(truncate(marketCompTitle, 80), 'Numbers across countries');

  const marketCompRows = [
    [
      { text: 'Country', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'GDP', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Market Size', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Growth', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } }
    ]
  ];

  countryAnalyses.forEach(c => {
    if (c.error) return;
    marketCompRows.push([
      { text: c.country },
      { text: truncate(c.macroContext?.gdp || 'N/A', 25) },
      { text: truncate(c.marketDynamics?.marketSize || 'N/A', 25) },
      { text: truncate(c.marketDynamics?.demand || 'N/A', 25) }
    ]);
  });

  marketCompSlide.addTable(marketCompRows, {
    x: 0.5, y: 1.1, w: 9, h: 4,
    fontSize: 10,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2, 2.3, 2.3, 2.4]
  });

  // SLIDE 4: Regulatory Comparison
  const regCompSlide = addSlide('Regulatory Comparison', 'Rules in each country');

  const regCompRows = [
    [
      { text: 'Country', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Foreign Ownership', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Risk Level', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Key Incentive', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } }
    ]
  ];

  countryAnalyses.forEach(c => {
    if (c.error) return;
    const incentives = c.policyRegulatory?.incentives || [];
    regCompRows.push([
      { text: c.country },
      { text: truncate(c.policyRegulatory?.foreignOwnershipRules || 'N/A', 25) },
      { text: truncate(c.policyRegulatory?.regulatoryRisk || 'N/A', 20) },
      { text: truncate(incentives[0] || 'N/A', 25) }
    ]);
  });

  regCompSlide.addTable(regCompRows, {
    x: 0.5, y: 1.1, w: 9, h: 4,
    fontSize: 10,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2, 2.5, 2, 2.5]
  });

  // SLIDE 5: Country Rankings (COMPARISON MATRIX)
  const rankingsTitle = headlines.rankings || 'Country Rankings';
  const rankSlide = addSlide(truncate(rankingsTitle, 80), 'Which market looks best');

  const rankRows = [
    [
      { text: 'Country', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Attractiveness', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Feasibility', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
      { text: 'Competition', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } }
    ]
  ];

  countryAnalyses.forEach(c => {
    if (c.error) return;
    rankRows.push([
      { text: c.country },
      { text: `${c.summaryAssessment?.attractivenessRating || 'N/A'}/10` },
      { text: `${c.summaryAssessment?.feasibilityRating || 'N/A'}/10` },
      { text: truncate(c.competitiveLandscape?.competitiveIntensity || 'N/A', 20) }
    ]);
  });

  rankSlide.addTable(rankRows, {
    x: 0.5, y: 1.1, w: 9, h: 3.5,
    fontSize: 11,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.5, 2, 2, 2.5]
  });

  // Best/worst summary below
  const sortedByAttract = [...countryAnalyses].filter(c => !c.error).sort((a, b) =>
    (b.summaryAssessment?.attractivenessRating || 0) - (a.summaryAssessment?.attractivenessRating || 0)
  );
  if (sortedByAttract.length > 0) {
    rankSlide.addText(`Most attractive: ${sortedByAttract[0]?.country || 'N/A'}`, {
      x: 0.5, y: 5, w: 9, h: 0.4,
      fontSize: 12, bold: true, color: COLORS.green
    });
    if (sortedByAttract.length > 1) {
      rankSlide.addText(`Least attractive: ${sortedByAttract[sortedByAttract.length - 1]?.country || 'N/A'}`, {
        x: 0.5, y: 5.5, w: 9, h: 0.4,
        fontSize: 12, color: COLORS.red
      });
    }
  }

  // SLIDES: Individual Country Details (1 slide each)
  for (const country of countryAnalyses) {
    if (country.error) continue;

    const cSlide = addSlide(country.country, 'Key findings');

    // Left: Metrics table
    const metricsRows = [
      [{ text: 'Metric', options: { bold: true } }, { text: 'Value', options: { bold: true } }],
      [{ text: 'GDP' }, { text: truncate(country.macroContext?.gdp || 'N/A', 35) }],
      [{ text: 'Market Size' }, { text: truncate(country.marketDynamics?.marketSize || 'N/A', 35) }],
      [{ text: 'Reg Risk' }, { text: truncate(country.policyRegulatory?.regulatoryRisk || 'N/A', 35) }]
    ];

    cSlide.addTable(metricsRows, {
      x: 0.5, y: 1.1, w: 4.2, h: 2,
      fontSize: 9,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [1.5, 2.7]
    });

    // Right: Opportunities & Obstacles
    cSlide.addText('Opportunities', {
      x: 5, y: 1.1, w: 4.5, h: 0.25,
      fontSize: 11, bold: true, color: COLORS.green
    });
    const opps = safeArray(country.summaryAssessment?.opportunities, 3);
    cSlide.addText(opps.map(o => ({ text: truncate(o, 50), options: { bullet: true } })), {
      x: 5, y: 1.4, w: 4.5, h: 1.3,
      fontSize: 9, color: COLORS.text, valign: 'top'
    });

    cSlide.addText('Obstacles', {
      x: 5, y: 2.8, w: 4.5, h: 0.25,
      fontSize: 11, bold: true, color: COLORS.red
    });
    const obs = safeArray(country.summaryAssessment?.obstacles, 3);
    cSlide.addText(obs.map(o => ({ text: truncate(o, 50), options: { bullet: true } })), {
      x: 5, y: 3.1, w: 4.5, h: 1.3,
      fontSize: 9, color: COLORS.text, valign: 'top'
    });

    // Bottom: Key competitors
    cSlide.addText('Key Competitors:', {
      x: 0.5, y: 4.6, w: 9, h: 0.25,
      fontSize: 11, bold: true, color: COLORS.secondary
    });
    const localPlayers = safeArray(country.competitiveLandscape?.localPlayers, 3);
    const competitorText = localPlayers.map(p => typeof p === 'string' ? p : p.name).join(', ') || 'See detailed analysis';
    cSlide.addText(truncate(competitorText, 120), {
      x: 0.5, y: 4.9, w: 9, h: 0.5,
      fontSize: 10, color: COLORS.text
    });

    // Key Insight
    cSlide.addText('Key Insight:', {
      x: 0.5, y: 5.5, w: 9, h: 0.25,
      fontSize: 11, bold: true, color: COLORS.accent
    });
    cSlide.addText(truncate(country.summaryAssessment?.keyInsight || 'See analysis', 180), {
      x: 0.5, y: 5.8, w: 9, h: 0.9,
      fontSize: 10, color: COLORS.text, valign: 'top'
    });

    // Ratings
    cSlide.addText(
      `Attractiveness: ${country.summaryAssessment?.attractivenessRating || 'N/A'}/10    Feasibility: ${country.summaryAssessment?.feasibilityRating || 'N/A'}/10`,
      {
        x: 0.5, y: 6.8, w: 9, h: 0.25,
        fontSize: 10, bold: true, color: COLORS.primary
      }
    );
  }

  // SLIDE: Recommendations
  const recoSlide = addSlide('Recommendations', 'What we suggest');
  const recommendations = synthesis.strategicRecommendations || synthesis.recommendations || {};

  // Entry sequence
  recoSlide.addText('Recommended entry order:', {
    x: 0.5, y: 1.1, w: 9, h: 0.3,
    fontSize: 12, bold: true, color: COLORS.secondary
  });
  const entrySeq = recommendations.entrySequence || recommendations.recommendedEntrySequence ||
    countryAnalyses.filter(c => !c.error).map(c => c.country).join(' → ');
  recoSlide.addText(truncate(typeof entrySeq === 'string' ? entrySeq : entrySeq.join(' → '), 100), {
    x: 0.5, y: 1.5, w: 9, h: 0.4,
    fontSize: 11, color: COLORS.text
  });

  // Entry modes table
  const entryModes = recommendations.entryModeRecommendations || recommendations.entryModes || [];
  if (Array.isArray(entryModes) && entryModes.length > 0) {
    recoSlide.addText('How to enter each market:', {
      x: 0.5, y: 2.1, w: 9, h: 0.3,
      fontSize: 12, bold: true, color: COLORS.secondary
    });

    const modeRows = [
      [
        { text: 'Country', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } },
        { text: 'Entry Mode', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white } }
      ]
    ];
    entryModes.slice(0, 5).forEach(m => {
      const country = typeof m === 'string' ? m.split(':')[0] : m.country;
      const mode = typeof m === 'string' ? m.split(':')[1] : (m.mode || m.recommendation);
      modeRows.push([
        { text: truncate(country, 20) },
        { text: truncate(mode, 50) }
      ]);
    });

    recoSlide.addTable(modeRows, {
      x: 0.5, y: 2.5, w: 9, h: 2.5,
      fontSize: 10,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.5, 6.5]
    });
  }

  // Risk mitigation
  const risks = safeArray(recommendations.riskMitigation || recommendations.riskMitigationStrategies, 3);
  if (risks.length > 0) {
    recoSlide.addText('Key risks to watch:', {
      x: 0.5, y: 5.3, w: 9, h: 0.3,
      fontSize: 12, bold: true, color: COLORS.red
    });
    recoSlide.addText(risks.map(r => ({
      text: truncate(typeof r === 'string' ? r : (r.strategy || r.description), 80),
      options: { bullet: true }
    })), {
      x: 0.5, y: 5.7, w: 9, h: 1.2,
      fontSize: 10, color: COLORS.text, valign: 'top'
    });
  }

  // SLIDE: Next Steps
  const nextSlide = addSlide('Next Steps', 'What to do now');
  const nextSteps = safeArray(synthesis.nextSteps || [
    'Talk to local experts to validate findings',
    'Identify potential partners in top market',
    'Build financial model',
    'Visit priority market'
  ], 5);

  nextSlide.addText(nextSteps.map((step, idx) => ({
    text: `${idx + 1}. ${truncate(typeof step === 'string' ? step : (step.action || step.description), 200)}`,
    options: { bullet: false, breakLine: true }
  })), {
    x: 0.5, y: 1.1, w: 9, h: 5,
    fontSize: 13, color: COLORS.text, valign: 'top', lineSpacing: 28
  });

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
