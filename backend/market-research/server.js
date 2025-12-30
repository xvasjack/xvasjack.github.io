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

  const systemPrompt = `You are a smart friend explaining a business opportunity over coffee. The person you're talking to is intelligent but knows NOTHING about this industry.

=== BANNED WORDS (never use these) ===
leverage, synergy, ecosystem, stakeholder, facilitate, optimize, streamline, scalable, robust, holistic, paradigm, incentivize, utilize, implement, methodology, framework, bandwidth, actionable, alignment, best-in-class, value-add, deep-dive, move the needle, circle back, low-hanging fruit, boil the ocean, touch base

=== WRITING RULES ===
1. USE SIMPLE WORDS
   - BAD: "leverage existing infrastructure" → GOOD: "use what's already there"
   - BAD: "facilitate market entry" → GOOD: "help you get in"
   - BAD: "optimize energy consumption" → GOOD: "cut electricity bills"

2. EXPLAIN ACRONYMS ONCE, THEN DROP THEM
   - First use: "The Board of Investment (BOI) gives tax breaks"
   - After that: just say "the government" or "tax agency"

3. ONE IDEA PER SENTENCE. If you use "and" or "while" or "which", split it.

4. ALWAYS ANSWER "SO WHAT?"
   - BAD: "Thailand has 71 million people"
   - GOOD: "Thailand has 71 million people, so there's a large customer base"

=== STORY FLOW (THIS IS CRITICAL) ===
The slides must flow like a conversation:

Slide 1 (Summary): "Here's the opportunity and what you should do"
  ↓ Reader thinks: "Interesting, tell me more about the market"
Slide 2 (Market): "Here's how big it is and who's buying"
  ↓ Reader thinks: "Who else is trying to sell to them?"
Slide 3 (Competition): "Here's who you're up against"
  ↓ Reader thinks: "What rules do I need to follow?"
Slide 4 (Regulation): "Here's what the government requires"
  ↓ Reader thinks: "What are my options?"
Slide 5 (Opportunities vs Obstacles): "Here's what helps and hurts you"
  ↓ Reader thinks: "What's the real insight here?"
Slide 6 (Insights): "Here's what most people miss"
  ↓ Reader thinks: "So what should I actually do?"
Slide 7 (Options): "Here are 3 ways to enter"
  ↓ Reader thinks: "What could go wrong?"
Slide 8 (Risks): "Here's what to watch out for"
  ↓ Reader thinks: "Give me a timeline"
Slide 9 (Roadmap): "Here's the step-by-step plan"

Each slide must END with something that makes the reader WANT to see the next slide.

=== DEPTH REQUIREMENTS ===
1. DON'T state the obvious. "Thailand is in Southeast Asia" = useless.
2. CONNECT DOTS. "Thailand's aging population + mandatory efficiency laws = guaranteed demand for energy services for the next 10 years"
3. EXPLAIN THE WHY. Not just "electricity is expensive" but "electricity is expensive BECAUSE the government subsidizes gas for cars but not for factories"
4. BE SPECIFIC. Names, numbers, dates. "PTT controls 60% of gas supply" not "a major company dominates"
5. GIVE REAL INSIGHT. Something the reader couldn't find in 5 minutes of Googling.`;

  const prompt = `Client: ${scope.clientContext}
Industry: ${scope.industry}
Target: ${countryAnalysis.country}

DATA GATHERED:
${JSON.stringify(countryAnalysis, null, 2)}

Create analysis in PLAIN ENGLISH. No jargon. Short sentences.

Return JSON with:

{
  "executiveSummary": [
    "5 bullets that tell a STORY. Each bullet flows to the next. Max 25 words each. Simple words only.",
    "Bullet 1: THE HOOK - Why should I care? What's the prize? (e.g., '$160M market where no foreigner has won yet')",
    "Bullet 2: THE TIMING - Why now, not later? (e.g., 'Tax breaks expire in 2028, so first movers get 3 years advantage')",
    "Bullet 3: THE CATCH - What makes this hard? (e.g., 'Foreigners can only own 49%, so you need a Thai partner')",
    "Bullet 4: THE ANSWER - How do you solve the catch? (e.g., 'Partner with PTT who needs your technology')",
    "Bullet 5: THE FIRST STEP - What do you do Monday morning? (e.g., 'Call PTT's strategy head and propose a pilot')"
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
      "title": "Max 8 words. The 'aha!' moment. Example: 'Aging workforce forces factories to cut costs'",
      "data": "The specific fact. Example: 'Average factory worker age is 45, up from 38 ten years ago'",
      "pattern": "What this means when you connect the dots. Example: 'Older workers = higher wages + lower productivity = factories MUST find other ways to cut costs'",
      "implication": "What YOU should do about it. Example: 'Pitch energy savings as a way to offset rising labor costs - they'll listen'"
    },
    "Give 3 insights. Each must be something surprising - not obvious from the data alone.",
    "Bad insight: 'The market is large' - this is obvious",
    "Good insight: 'Grid congestion in the south means solar projects are stuck, so factories there will pay MORE for energy efficiency since they can't go solar'"
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

REMEMBER:
1. NO JARGON. If your grandmother wouldn't understand a word, don't use it.
2. FLOW. Each section should make the reader want to read the next.
3. DEPTH. Don't state the obvious. Connect dots. Explain WHY things happen.
4. SPECIFIC. Names, numbers, dates. Not "a major company" but "PTT (revenue $88B)".
5. ACTIONABLE. End with something the reader can DO, not just know.`;

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

// Helper: truncate text to fit slides - end at sentence or phrase boundary
function truncate(text, maxLen = 150) {
  if (!text) return '';
  const str = String(text).trim();
  if (str.length <= maxLen) return str;

  // Find the last sentence boundary before maxLen
  const truncated = str.substring(0, maxLen);

  // Try to end at sentence boundary (. ! ?)
  const lastSentence = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? ')
  );
  if (lastSentence > maxLen * 0.5) {
    return truncated.substring(0, lastSentence + 1).trim();
  }

  // Try to end at phrase boundary (; , -)
  const lastPhrase = Math.max(
    truncated.lastIndexOf('; '),
    truncated.lastIndexOf(', '),
    truncated.lastIndexOf(' - ')
  );
  if (lastPhrase > maxLen * 0.5) {
    return truncated.substring(0, lastPhrase).trim();
  }

  // Last resort: end at word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.6) {
    return truncated.substring(0, lastSpace).trim();
  }

  return truncated.trim();
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

  // YCP Template Colors
  const COLORS = {
    primary: '1F497D',    // YCP dark blue
    secondary: '007FFF',  // YCP bright blue
    accent: 'E46C0A',     // YCP orange
    text: '000000',       // Black
    lightBg: 'EDFDFF',    // YCP light cyan
    white: 'FFFFFF',
    green: '38a169',
    red: 'C00000',        // YCP red
    navy: '001C44'        // YCP navy
  };

  // Set default font to Segoe UI (YCP standard)
  pptx.theme = { headFontFace: 'Segoe UI', bodyFontFace: 'Segoe UI' };

  // Standard font for all text
  const FONT = 'Segoe UI';

  // Truncate title to max 70 chars (about 10 words)
  function truncateTitle(text) {
    if (!text) return '';
    const str = String(text).trim();
    if (str.length <= 70) return str;
    const cut = str.substring(0, 70);
    const lastSpace = cut.lastIndexOf(' ');
    return lastSpace > 40 ? cut.substring(0, lastSpace) : cut;
  }

  function addSlide(title, subtitle = '') {
    const slide = pptx.addSlide();
    // Title - 24pt bold navy, max 2 lines (truncated)
    slide.addText(truncateTitle(title), {
      x: 0.35, y: 0.15, w: 9.3, h: 0.7,
      fontSize: 24, bold: true, color: COLORS.primary, fontFace: FONT,
      valign: 'top', wrap: true
    });
    // Navy divider line under title
    slide.addShape('line', {
      x: 0.35, y: 0.9,
      w: 9.3, h: 0,
      line: { color: COLORS.primary, width: 2.5 }
    });
    // Message/subtitle - 16pt blue (below divider)
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.35, y: 0.95, w: 9.3, h: 0.25,
        fontSize: 14, color: COLORS.secondary, fontFace: FONT
      });
    }
    return slide;
  }

  // SLIDE 1: Title
  const titleSlide = pptx.addSlide();
  titleSlide.addText(synthesis.country.toUpperCase(), {
    x: 0.5, y: 2.2, w: 9, h: 0.8,
    fontSize: 42, bold: true, color: COLORS.primary, fontFace: FONT
  });
  titleSlide.addText(`${scope.industry} Market Analysis`, {
    x: 0.5, y: 3.0, w: 9, h: 0.5,
    fontSize: 24, color: COLORS.secondary, fontFace: FONT
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5, y: 6.5, w: 9, h: 0.3,
    fontSize: 10, color: '666666', fontFace: FONT
  });

  // Get insight-driven headlines if available
  const headlines = synthesis.slideHeadlines || {};

  // SLIDE 2: Summary (1 slide, key points only)
  const summaryTitle = headlines.summary || 'Executive Summary';
  const execSlide = addSlide(summaryTitle, 'Key Findings');
  const execBullets = safeArray(synthesis.executiveSummary, 4);
  execSlide.addText(execBullets.map(b => ({
    text: truncate(b, 180),
    options: { bullet: true }
  })), {
    x: 0.35, y: 1.3, w: 9.3, h: 5.2,
    fontSize: 14, color: COLORS.text, fontFace: FONT, valign: 'top', lineSpacing: 26
  });

  // SLIDE 3: Market Size Data (ACTUAL NUMBERS)
  const marketTitle = headlines.marketData || 'Market Data';
  const marketSlide = addSlide(marketTitle, '');
  const ca = countryAnalysis || {};
  const macro = ca.macroContext || {};
  const market = ca.marketDynamics || {};

  // Create data table with dark blue header (accent3 = #011AB7)
  const TABLE_HEADER_COLOR = '011AB7';
  const marketRows = [
    [
      { text: 'Metric', options: { bold: true, fill: { color: TABLE_HEADER_COLOR }, color: COLORS.white, fontFace: FONT } },
      { text: 'Value', options: { bold: true, fill: { color: TABLE_HEADER_COLOR }, color: COLORS.white, fontFace: FONT } }
    ],
    [{ text: 'GDP' }, { text: truncate(macro.gdp || 'N/A', 120) }],
    [{ text: 'Population' }, { text: truncate(macro.population || 'N/A', 120) }],
    [{ text: 'Industry Share of GDP' }, { text: truncate(macro.industrialGdpShare || 'N/A', 120) }],
    [{ text: 'Market Size' }, { text: truncate(market.marketSize || 'N/A', 120) }],
    [{ text: 'Energy Prices' }, { text: truncate(market.pricing || 'N/A', 120) }],
    [{ text: 'Demand Drivers' }, { text: truncate(market.demand || 'N/A', 120) }]
  ];

  marketSlide.addTable(marketRows, {
    x: 0.35, y: 1.2, w: 9.3, h: 5,
    fontSize: 14,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.3, 7]
  });

  // SLIDE 4: Competitor Data (TABLE FORMAT)
  const compTitle = headlines.competition || 'Competitive Landscape';
  const compSlide = addSlide(compTitle, '');
  const comp = ca.competitiveLandscape || {};

  const compRows = [
    [
      { text: 'Company', options: { bold: true, fill: { color: TABLE_HEADER_COLOR }, color: COLORS.white, fontFace: FONT } },
      { text: 'Type', options: { bold: true, fill: { color: TABLE_HEADER_COLOR }, color: COLORS.white, fontFace: FONT } },
      { text: 'Notes', options: { bold: true, fill: { color: TABLE_HEADER_COLOR }, color: COLORS.white, fontFace: FONT } }
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
    x: 0.35, y: 1.2, w: 9.3, h: 3.2,
    fontSize: 14,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.8, 0.8, 5.7]
  });

  // Entry barriers below - with divider line
  compSlide.addShape('line', {
    x: 0.35, y: 4.5, w: 9.3, h: 0,
    line: { color: COLORS.primary, width: 2.5 }
  });
  compSlide.addText('Barriers to Entry:', {
    x: 0.35, y: 4.6, w: 9.3, h: 0.35,
    fontSize: 14, bold: true, color: COLORS.secondary, fontFace: FONT
  });
  const barriers = safeArray(comp.entryBarriers, 3);
  compSlide.addText(barriers.map(b => ({ text: truncate(b, 120), options: { bullet: true } })), {
    x: 0.35, y: 5.0, w: 9.3, h: 1.5,
    fontSize: 14, fontFace: FONT, color: COLORS.text, valign: 'top'
  });

  // SLIDE 5: Regulatory Data
  const regTitle = headlines.regulation || 'Regulatory Environment';
  const regSlide = addSlide(regTitle, '');
  const reg = ca.policyRegulatory || {};

  const regRows = [
    [
      { text: 'Area', options: { bold: true, fill: { color: TABLE_HEADER_COLOR }, color: COLORS.white, fontFace: FONT } },
      { text: 'Details', options: { bold: true, fill: { color: TABLE_HEADER_COLOR }, color: COLORS.white, fontFace: FONT } }
    ],
    [{ text: 'Government Stance' }, { text: truncate(reg.governmentStance || 'N/A', 100) }],
    [{ text: 'Foreign Ownership Rules' }, { text: truncate(reg.foreignOwnershipRules || 'N/A', 100) }],
    [{ text: 'Risk Level' }, { text: truncate(reg.regulatoryRisk || 'N/A', 100) }]
  ];

  regSlide.addTable(regRows, {
    x: 0.35, y: 1.2, w: 9.3, h: 2,
    fontSize: 14, fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.3, 7]
  });

  // Key laws - with divider line
  regSlide.addShape('line', {
    x: 0.35, y: 3.3, w: 9.3, h: 0,
    line: { color: COLORS.primary, width: 2.5 }
  });
  regSlide.addText('Key Laws & Policies:', {
    x: 0.35, y: 3.4, w: 9.3, h: 0.35,
    fontSize: 14, bold: true, color: COLORS.secondary, fontFace: FONT
  });
  const laws = safeArray(reg.keyLegislation, 4);
  regSlide.addText(laws.map(l => ({ text: truncate(l, 100), options: { bullet: true } })), {
    x: 0.35, y: 3.8, w: 9.3, h: 1.4,
    fontSize: 14, fontFace: FONT, color: COLORS.text, valign: 'top'
  });

  // Incentives - with divider line
  regSlide.addShape('line', {
    x: 0.35, y: 5.3, w: 9.3, h: 0,
    line: { color: COLORS.primary, width: 2.5 }
  });
  regSlide.addText('Available Incentives:', {
    x: 0.35, y: 5.4, w: 9.3, h: 0.35,
    fontSize: 14, bold: true, color: COLORS.green, fontFace: FONT
  });
  const incentives = safeArray(reg.incentives, 2);
  regSlide.addText(incentives.map(i => ({ text: truncate(i, 100), options: { bullet: true } })), {
    x: 0.35, y: 5.8, w: 9.3, h: 0.9,
    fontSize: 14, fontFace: FONT, color: COLORS.text, valign: 'top'
  });

  // SLIDE 6: What We Found (Analysis based on data)
  const analysisSlide = addSlide('What We Found', '');
  const summary = ca.summaryAssessment || {};

  // Opportunities - left column with divider
  analysisSlide.addShape('line', {
    x: 0.35, y: 1.2, w: 4.3, h: 0,
    line: { color: COLORS.green, width: 2.5 }
  });
  analysisSlide.addText('Opportunities', {
    x: 0.35, y: 1.3, w: 4.3, h: 0.35,
    fontSize: 14, bold: true, color: COLORS.green, fontFace: FONT
  });
  const opps = safeArray(summary.opportunities, 4);
  analysisSlide.addText(opps.map(o => ({ text: truncate(o, 80), options: { bullet: true } })), {
    x: 0.35, y: 1.7, w: 4.3, h: 2.5,
    fontSize: 14, fontFace: FONT, color: COLORS.text, valign: 'top'
  });

  // Obstacles - right column with divider
  analysisSlide.addShape('line', {
    x: 5, y: 1.2, w: 4.65, h: 0,
    line: { color: COLORS.accent, width: 2.5 }
  });
  analysisSlide.addText('Obstacles', {
    x: 5, y: 1.3, w: 4.65, h: 0.35,
    fontSize: 14, bold: true, color: COLORS.accent, fontFace: FONT
  });
  const obs = safeArray(summary.obstacles, 4);
  analysisSlide.addText(obs.map(o => ({ text: truncate(o, 80), options: { bullet: true } })), {
    x: 5, y: 1.7, w: 4.65, h: 2.5,
    fontSize: 14, fontFace: FONT, color: COLORS.text, valign: 'top'
  });

  // Key insight - with divider
  analysisSlide.addShape('line', {
    x: 0.35, y: 4.3, w: 9.3, h: 0,
    line: { color: COLORS.accent, width: 2.5 }
  });
  analysisSlide.addText('Key Insight:', {
    x: 0.35, y: 4.4, w: 9.3, h: 0.35,
    fontSize: 14, bold: true, color: COLORS.accent, fontFace: FONT
  });
  analysisSlide.addText(truncate(summary.keyInsight || 'See detailed analysis', 200), {
    x: 0.35, y: 4.8, w: 9.3, h: 1.5,
    fontSize: 14, fontFace: FONT, color: COLORS.text, valign: 'top'
  });

  // Ratings
  analysisSlide.addText(
    `Market Attractiveness: ${summary.attractivenessRating || 'N/A'}/10    Feasibility: ${summary.feasibilityRating || 'N/A'}/10`,
    {
      x: 0.35, y: 6.4, w: 9.3, h: 0.3,
      fontSize: 14, bold: true, color: COLORS.primary, fontFace: FONT
    }
  );

  // SLIDE 7: Key Insights (THE STORY)
  const keyInsights = safeArray(synthesis.keyInsights, 3);
  if (keyInsights.length > 0) {
    const insightSlide = addSlide('Key Insights', '');
    let insightY = 1.2;

    keyInsights.forEach((insight, idx) => {
      const title = typeof insight === 'string' ? `Insight ${idx + 1}` : (insight.title || `Insight ${idx + 1}`);
      const body = typeof insight === 'string' ? insight :
        `${insight.data || ''} → ${insight.pattern || ''} → ${insight.implication || ''}`;

      // Divider line for each insight
      insightSlide.addShape('line', {
        x: 0.35, y: insightY - 0.1, w: 9.3, h: 0,
        line: { color: COLORS.accent, width: 2.5 }
      });

      insightSlide.addText(`${idx + 1}. ${title}`, {
        x: 0.35, y: insightY, w: 9.3, h: 0.4,
        fontSize: 14, bold: true, color: COLORS.accent, fontFace: FONT, wrap: true
      });

      insightSlide.addText(truncate(body, 180), {
        x: 0.35, y: insightY + 0.45, w: 9.3, h: 1.3,
        fontSize: 14, fontFace: FONT, color: COLORS.text, valign: 'top'
      });

      insightY += 1.85;
    });
  }

  // SLIDE 8: Entry Options (COMPARISON TABLE)
  const stratSlide = addSlide('Entry Options', '');
  const entryOpts = synthesis.entryStrategyOptions || synthesis.entryOptions || {};

  const optRows = [
    [
      { text: '', options: { fill: { color: TABLE_HEADER_COLOR }, color: COLORS.white, fontFace: FONT } },
      { text: 'Option A', options: { bold: true, fill: { color: TABLE_HEADER_COLOR }, color: COLORS.white, fontFace: FONT } },
      { text: 'Option B', options: { bold: true, fill: { color: TABLE_HEADER_COLOR }, color: COLORS.white, fontFace: FONT } },
      { text: 'Option C', options: { bold: true, fill: { color: TABLE_HEADER_COLOR }, color: COLORS.white, fontFace: FONT } }
    ]
  ];

  const optA = entryOpts.optionA || entryOpts.A || {};
  const optB = entryOpts.optionB || entryOpts.B || {};
  const optC = entryOpts.optionC || entryOpts.C || {};

  const getOptField = (opt, field) => {
    if (typeof opt === 'string') return truncate(opt, 60);
    return truncate(opt[field] || opt.description || 'N/A', 60);
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
    x: 0.35, y: 1.2, w: 9.3, h: 3.2,
    fontSize: 14, fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [1.2, 2.7, 2.7, 2.7]
  });

  // Recommendation - with divider
  const recommended = entryOpts.recommendedOption || entryOpts.recommendation;
  if (recommended) {
    stratSlide.addShape('line', {
      x: 0.35, y: 4.5, w: 9.3, h: 0,
      line: { color: COLORS.accent, width: 2.5 }
    });
    stratSlide.addText('Recommended:', {
      x: 0.35, y: 4.6, w: 9.3, h: 0.35,
      fontSize: 14, bold: true, color: COLORS.accent, fontFace: FONT
    });
    const recText = typeof recommended === 'string' ? recommended : (recommended.option || recommended.rationale || JSON.stringify(recommended));
    stratSlide.addText(truncate(recText, 180), {
      x: 0.35, y: 5.0, w: 9.3, h: 1.5,
      fontSize: 14, fontFace: FONT, color: COLORS.text, valign: 'top'
    });
  }

  // SLIDE 9: Risks (PROPERLY FORMATTED)
  const riskTitle = headlines.risks || 'Risk Assessment';
  const riskSlide = addSlide(riskTitle, '');
  const riskAssess = synthesis.riskAssessment || synthesis.risks || {};
  const criticalRisks = safeArray(riskAssess.criticalRisks || riskAssess.risks, 3);

  // Risk table - use accent color (orange) for header
  const riskRows = [
    [
      { text: 'Risk', options: { bold: true, fill: { color: COLORS.accent }, color: COLORS.white, fontFace: FONT } },
      { text: 'How to Handle', options: { bold: true, fill: { color: COLORS.accent }, color: COLORS.white, fontFace: FONT } }
    ]
  ];

  criticalRisks.forEach(r => {
    const riskName = typeof r === 'string' ? r : (r.risk || r.name || 'Risk');
    const mitigation = typeof r === 'string' ? '' : (r.mitigation || '');
    riskRows.push([
      { text: truncate(riskName, 80) },
      { text: truncate(mitigation, 100) }
    ]);
  });

  riskSlide.addTable(riskRows, {
    x: 0.35, y: 1.2, w: 9.3, h: 2.8,
    fontSize: 14, fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [4.3, 5]
  });

  // Go/No-Go criteria - with divider
  const goNoGo = safeArray(riskAssess.goNoGoCriteria || riskAssess.goNoGo, 4);
  if (goNoGo.length > 0) {
    riskSlide.addShape('line', {
      x: 0.35, y: 4.1, w: 9.3, h: 0,
      line: { color: COLORS.secondary, width: 2.5 }
    });
    riskSlide.addText('Go/No-Go Checklist:', {
      x: 0.35, y: 4.2, w: 9.3, h: 0.35,
      fontSize: 14, bold: true, color: COLORS.secondary, fontFace: FONT
    });
    riskSlide.addText(goNoGo.map(g => ({
      text: truncate(typeof g === 'string' ? g : (g.criteria || g.description), 80),
      options: { bullet: true }
    })), {
      x: 0.35, y: 4.6, w: 9.3, h: 2,
      fontSize: 14, fontFace: FONT, color: COLORS.text, valign: 'top'
    });
  }

  // SLIDE 10: Roadmap (Based on analysis)
  const roadmapSlide = addSlide('Roadmap', '');
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

  let phaseY = 1.2;
  phases.forEach(phase => {
    const actions = roadmap[phase.key] || roadmap[phase.label] || [];

    // Divider line for each phase
    roadmapSlide.addShape('line', {
      x: 0.35, y: phaseY - 0.1, w: 9.3, h: 0,
      line: { color: phase.color, width: 2.5 }
    });

    roadmapSlide.addText(phase.label, {
      x: 0.35, y: phaseY, w: 9.3, h: 0.35,
      fontSize: 14, bold: true, color: phase.color, fontFace: FONT
    });

    const actionList = Array.isArray(actions) ? actions : [actions];
    roadmapSlide.addText(safeArray(actionList, 4).map(a => ({
      text: truncate(stripMonthPrefix(a), 100),
      options: { bullet: true }
    })), {
      x: 0.35, y: phaseY + 0.35, w: 9.3, h: 1.4,
      fontSize: 14, fontFace: FONT, color: COLORS.text, valign: 'top'
    });
    phaseY += 1.85;
  });

  // Next Steps slide removed per user request

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

  // YCP Template Colors
  const COLORS = {
    primary: '1F497D',    // YCP dark blue
    secondary: '007FFF',  // YCP bright blue
    accent: 'E46C0A',     // YCP orange
    text: '000000',       // Black
    lightBg: 'EDFDFF',    // YCP light cyan
    white: 'FFFFFF',
    green: '38a169',
    red: 'C00000',        // YCP red
    navy: '001C44'        // YCP navy
  };

  // Set default font to Segoe UI (YCP standard)
  pptx.theme = { headFontFace: 'Segoe UI', bodyFontFace: 'Segoe UI' };

  // Standard font for all text
  const FONT = 'Segoe UI';
  const TABLE_HEADER_COLOR = '011AB7';

  // Truncate title to max 70 chars (about 10 words)
  function truncateTitle(text) {
    if (!text) return '';
    const str = String(text).trim();
    if (str.length <= 70) return str;
    const cut = str.substring(0, 70);
    const lastSpace = cut.lastIndexOf(' ');
    return lastSpace > 40 ? cut.substring(0, lastSpace) : cut;
  }

  function addSlide(title, subtitle = '') {
    const slide = pptx.addSlide();
    // Title - 24pt bold navy, max 2 lines (truncated)
    slide.addText(truncateTitle(title), {
      x: 0.35, y: 0.15, w: 9.3, h: 0.7,
      fontSize: 24, bold: true, color: COLORS.primary, fontFace: FONT,
      valign: 'top', wrap: true
    });
    // Navy divider line under title
    slide.addShape('line', {
      x: 0.35, y: 0.9,
      w: 9.3, h: 0,
      line: { color: COLORS.primary, width: 2.5 }
    });
    // Message/subtitle - 14pt blue (below divider)
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.35, y: 0.95, w: 9.3, h: 0.25,
        fontSize: 14, color: COLORS.secondary, fontFace: FONT
      });
    }
    return slide;
  }

  // SLIDE 1: Title
  const titleSlide = pptx.addSlide();
  titleSlide.addText(scope.industry.toUpperCase(), {
    x: 0.5, y: 2.2, w: 9, h: 0.8,
    fontSize: 36, bold: true, color: COLORS.primary, fontFace: FONT
  });
  titleSlide.addText('Market Comparison', {
    x: 0.5, y: 3.0, w: 9, h: 0.5,
    fontSize: 24, color: COLORS.secondary, fontFace: FONT
  });
  titleSlide.addText(scope.targetMarkets.join(' | '), {
    x: 0.5, y: 3.6, w: 9, h: 0.4,
    fontSize: 14, color: COLORS.text, fontFace: FONT
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5, y: 6.5, w: 9, h: 0.3,
    fontSize: 10, color: '666666', fontFace: FONT
  });

  // Get insight-driven headlines if available
  const headlines = synthesis.slideHeadlines || {};

  // SLIDE 2: Summary
  const summaryTitle = headlines.summary || 'Executive Summary';
  const execSlide = addSlide(summaryTitle, 'Key Recommendations');
  const execBullets = safeArray(synthesis.executiveSummary, 5);
  execSlide.addText(execBullets.map(b => ({
    text: truncate(b, 350),
    options: { bullet: true }
  })), {
    x: 0.5, y: 1.2, w: 9, h: 5.4,
    fontSize: 11, fontFace: FONT, color: COLORS.text, valign: 'top', lineSpacing: 22
  });

  // SLIDE 3: Market Size Comparison (DATA TABLE)
  const marketCompTitle = headlines.marketComparison || 'Market Data Comparison';
  const marketCompSlide = addSlide(marketCompTitle, '');

  const marketCompRows = [
    [
      { text: 'Country', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } },
      { text: 'GDP', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } },
      { text: 'Market Size', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } },
      { text: 'Growth', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } }
    ]
  ];

  countryAnalyses.forEach(c => {
    if (c.error) return;
    marketCompRows.push([
      { text: c.country, options: { fontFace: FONT } },
      { text: truncate(c.macroContext?.gdp || 'N/A', 50), options: { fontFace: FONT } },
      { text: truncate(c.marketDynamics?.marketSize || 'N/A', 50), options: { fontFace: FONT } },
      { text: truncate(c.marketDynamics?.demand || 'N/A', 50), options: { fontFace: FONT } }
    ]);
  });

  marketCompSlide.addTable(marketCompRows, {
    x: 0.5, y: 1.1, w: 9, h: 4,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2, 2.3, 2.3, 2.4]
  });

  // SLIDE 4: Regulatory Comparison
  const regCompSlide = addSlide('Regulatory Comparison', 'Rules in each country');

  const regCompRows = [
    [
      { text: 'Country', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } },
      { text: 'Foreign Ownership', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } },
      { text: 'Risk Level', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } },
      { text: 'Key Incentive', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } }
    ]
  ];

  countryAnalyses.forEach(c => {
    if (c.error) return;
    const incentives = c.policyRegulatory?.incentives || [];
    regCompRows.push([
      { text: c.country, options: { fontFace: FONT } },
      { text: truncate(c.policyRegulatory?.foreignOwnershipRules || 'N/A', 50), options: { fontFace: FONT } },
      { text: truncate(c.policyRegulatory?.regulatoryRisk || 'N/A', 40), options: { fontFace: FONT } },
      { text: truncate(incentives[0] || 'N/A', 50), options: { fontFace: FONT } }
    ]);
  });

  regCompSlide.addTable(regCompRows, {
    x: 0.5, y: 1.1, w: 9, h: 4,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2, 2.5, 2, 2.5]
  });

  // SLIDE 5: Country Rankings (COMPARISON MATRIX)
  const rankingsTitle = headlines.rankings || 'Country Rankings';
  const rankSlide = addSlide(rankingsTitle, 'Which market looks best');

  const rankRows = [
    [
      { text: 'Country', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } },
      { text: 'Attractiveness', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } },
      { text: 'Feasibility', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } },
      { text: 'Competition', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } }
    ]
  ];

  countryAnalyses.forEach(c => {
    if (c.error) return;
    rankRows.push([
      { text: c.country, options: { fontFace: FONT } },
      { text: `${c.summaryAssessment?.attractivenessRating || 'N/A'}/10`, options: { fontFace: FONT } },
      { text: `${c.summaryAssessment?.feasibilityRating || 'N/A'}/10`, options: { fontFace: FONT } },
      { text: truncate(c.competitiveLandscape?.competitiveIntensity || 'N/A', 50), options: { fontFace: FONT } }
    ]);
  });

  rankSlide.addTable(rankRows, {
    x: 0.5, y: 1.1, w: 9, h: 3.5,
    fontSize: 11,
    fontFace: FONT,
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
      fontSize: 12, bold: true, color: COLORS.green, fontFace: FONT
    });
    if (sortedByAttract.length > 1) {
      rankSlide.addText(`Least attractive: ${sortedByAttract[sortedByAttract.length - 1]?.country || 'N/A'}`, {
        x: 0.5, y: 5.5, w: 9, h: 0.4,
        fontSize: 12, color: COLORS.red, fontFace: FONT
      });
    }
  }

  // SLIDES: Individual Country Details (1 slide each)
  for (const country of countryAnalyses) {
    if (country.error) continue;

    const cSlide = addSlide(country.country, 'Key findings');

    // Left: Metrics table
    const metricsRows = [
      [{ text: 'Metric', options: { bold: true, fontFace: FONT } }, { text: 'Value', options: { bold: true, fontFace: FONT } }],
      [{ text: 'GDP', options: { fontFace: FONT } }, { text: truncate(country.macroContext?.gdp || 'N/A', 80), options: { fontFace: FONT } }],
      [{ text: 'Market Size', options: { fontFace: FONT } }, { text: truncate(country.marketDynamics?.marketSize || 'N/A', 80), options: { fontFace: FONT } }],
      [{ text: 'Reg Risk', options: { fontFace: FONT } }, { text: truncate(country.policyRegulatory?.regulatoryRisk || 'N/A', 80), options: { fontFace: FONT } }]
    ];

    cSlide.addTable(metricsRows, {
      x: 0.5, y: 1.1, w: 4.2, h: 2,
      fontSize: 9,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [1.5, 2.7]
    });

    // Right: Opportunities & Obstacles
    cSlide.addText('Opportunities', {
      x: 5, y: 1.1, w: 4.5, h: 0.25,
      fontSize: 11, bold: true, color: COLORS.green, fontFace: FONT
    });
    const opps = safeArray(country.summaryAssessment?.opportunities, 3);
    cSlide.addText(opps.map(o => ({ text: truncate(o, 100), options: { bullet: true } })), {
      x: 5, y: 1.4, w: 4.5, h: 1.3,
      fontSize: 9, color: COLORS.text, fontFace: FONT, valign: 'top'
    });

    cSlide.addText('Obstacles', {
      x: 5, y: 2.8, w: 4.5, h: 0.25,
      fontSize: 11, bold: true, color: COLORS.red, fontFace: FONT
    });
    const obs = safeArray(country.summaryAssessment?.obstacles, 3);
    cSlide.addText(obs.map(o => ({ text: truncate(o, 100), options: { bullet: true } })), {
      x: 5, y: 3.1, w: 4.5, h: 1.3,
      fontSize: 9, color: COLORS.text, fontFace: FONT, valign: 'top'
    });

    // Bottom: Key competitors
    cSlide.addText('Key Competitors:', {
      x: 0.5, y: 4.6, w: 9, h: 0.25,
      fontSize: 11, bold: true, color: COLORS.secondary, fontFace: FONT
    });
    const localPlayers = safeArray(country.competitiveLandscape?.localPlayers, 3);
    const competitorText = localPlayers.map(p => typeof p === 'string' ? p : p.name).join(', ') || 'See detailed analysis';
    cSlide.addText(truncate(competitorText, 200), {
      x: 0.5, y: 4.9, w: 9, h: 0.5,
      fontSize: 10, color: COLORS.text, fontFace: FONT
    });

    // Key Insight
    cSlide.addText('Key Insight:', {
      x: 0.5, y: 5.5, w: 9, h: 0.25,
      fontSize: 11, bold: true, color: COLORS.accent, fontFace: FONT
    });
    cSlide.addText(truncate(country.summaryAssessment?.keyInsight || 'See analysis', 250), {
      x: 0.5, y: 5.8, w: 9, h: 0.9,
      fontSize: 10, color: COLORS.text, fontFace: FONT, valign: 'top'
    });

    // Ratings
    cSlide.addText(
      `Attractiveness: ${country.summaryAssessment?.attractivenessRating || 'N/A'}/10    Feasibility: ${country.summaryAssessment?.feasibilityRating || 'N/A'}/10`,
      {
        x: 0.5, y: 6.8, w: 9, h: 0.25,
        fontSize: 10, bold: true, color: COLORS.primary, fontFace: FONT
      }
    );
  }

  // SLIDE: Recommendations
  const recoSlide = addSlide('Recommendations', 'What we suggest');
  const recommendations = synthesis.strategicRecommendations || synthesis.recommendations || {};

  // Entry sequence
  recoSlide.addText('Recommended entry order:', {
    x: 0.5, y: 1.1, w: 9, h: 0.3,
    fontSize: 12, bold: true, color: COLORS.secondary, fontFace: FONT
  });
  const entrySeq = recommendations.entrySequence || recommendations.recommendedEntrySequence ||
    countryAnalyses.filter(c => !c.error).map(c => c.country).join(' → ');
  recoSlide.addText(truncate(typeof entrySeq === 'string' ? entrySeq : entrySeq.join(' → '), 150), {
    x: 0.5, y: 1.5, w: 9, h: 0.4,
    fontSize: 11, color: COLORS.text, fontFace: FONT
  });

  // Entry modes table
  const entryModes = recommendations.entryModeRecommendations || recommendations.entryModes || [];
  if (Array.isArray(entryModes) && entryModes.length > 0) {
    recoSlide.addText('How to enter each market:', {
      x: 0.5, y: 2.1, w: 9, h: 0.3,
      fontSize: 12, bold: true, color: COLORS.secondary, fontFace: FONT
    });

    const modeRows = [
      [
        { text: 'Country', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } },
        { text: 'Entry Mode', options: { bold: true, fill: { color: COLORS.primary }, color: COLORS.white, fontFace: FONT } }
      ]
    ];
    entryModes.slice(0, 5).forEach(m => {
      const country = typeof m === 'string' ? m.split(':')[0] : m.country;
      const mode = typeof m === 'string' ? m.split(':')[1] : (m.mode || m.recommendation);
      modeRows.push([
        { text: truncate(country, 30), options: { fontFace: FONT } },
        { text: truncate(mode, 100), options: { fontFace: FONT } }
      ]);
    });

    recoSlide.addTable(modeRows, {
      x: 0.5, y: 2.5, w: 9, h: 2.5,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.5, 6.5]
    });
  }

  // Risk mitigation
  const risks = safeArray(recommendations.riskMitigation || recommendations.riskMitigationStrategies, 3);
  if (risks.length > 0) {
    recoSlide.addText('Key risks to watch:', {
      x: 0.5, y: 5.3, w: 9, h: 0.3,
      fontSize: 12, bold: true, color: COLORS.accent, fontFace: FONT
    });
    recoSlide.addText(risks.map(r => ({
      text: truncate(typeof r === 'string' ? r : (r.strategy || r.description), 150),
      options: { bullet: true }
    })), {
      x: 0.5, y: 5.7, w: 9, h: 1.2,
      fontSize: 10, color: COLORS.text, fontFace: FONT, valign: 'top'
    });
  }

  // Next Steps slide removed per user request

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
