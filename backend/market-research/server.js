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
// Deep Research: 50+ queries per country organized by Escort template sections
// Produces ~15-17 slides per country with charts and detailed analysis

const RESEARCH_FRAMEWORK = {
  // === SECTION 1: POLICY & REGULATIONS (3 slides) ===
  policy_foundationalActs: {
    name: 'Foundational Energy Acts',
    slideTitle: '{country} - Energy Foundational Acts',
    queries: [
      '{country} energy conservation act law text requirements penalties',
      '{country} energy efficiency act mandatory audits industrial factories',
      '{country} ESCO law energy service company regulations licensing',
      '{country} power development plan PDP official targets capacity',
      '{country} renewable energy act feed-in tariff regulations'
    ]
  },
  policy_nationalPolicy: {
    name: 'National Energy Policy',
    slideTitle: '{country} - National Energy Policy',
    queries: [
      '{country} national energy plan 2024 2030 targets official',
      '{country} carbon neutrality net zero 2050 roadmap government',
      '{country} energy efficiency improvement target percentage annual',
      '{country} alternative energy development plan AEDP targets',
      '{country} energy ministry policy direction minister statements 2024'
    ]
  },
  policy_investmentRestrictions: {
    name: 'Investment Restrictions',
    slideTitle: '{country} - Foreign Investment Restrictions',
    queries: [
      '{country} foreign business act restricted industries energy sector',
      '{country} foreign ownership limit percentage energy power utilities',
      '{country} BOI investment promotion energy projects incentives',
      '{country} joint venture requirements foreign energy companies',
      '{country} special economic zones energy investment privileges'
    ]
  },

  // === SECTION 2: MARKET (6 slides with charts) ===
  market_tpes: {
    name: 'Total Primary Energy Supply',
    slideTitle: '{country} - Total Primary Energy Supply (TPES)',
    chartType: 'stackedBar',
    queries: [
      '{country} total primary energy supply TPES 2020 2021 2022 2023 2024 ktoe',
      '{country} energy supply by source oil gas coal nuclear renewable percentage',
      '{country} energy imports dependency ratio petroleum natural gas',
      '{country} domestic energy production oil gas coal statistics',
      '{country} IEA energy statistics TPES breakdown'
    ]
  },
  market_finalDemand: {
    name: 'Final Energy Demand by Sector',
    slideTitle: '{country} - Final Energy Demand',
    chartType: 'stackedBar',
    queries: [
      '{country} final energy consumption by sector industrial transport residential commercial',
      '{country} industrial energy demand manufacturing factories statistics',
      '{country} energy consumption growth rate by sector 2020-2024',
      '{country} energy demand forecast 2025 2030 projections',
      '{country} sectoral energy intensity trends'
    ]
  },
  market_electricity: {
    name: 'Electricity & Power Generation',
    slideTitle: '{country} - Electricity & Power Generation',
    chartType: 'stackedBar',
    queries: [
      '{country} electricity generation capacity MW installed 2024',
      '{country} power generation mix coal gas renewable nuclear hydro percentage',
      '{country} electricity consumption industrial commercial residential TWh',
      '{country} power demand peak load forecast 2025 2030',
      '{country} independent power producer IPP capacity licensed'
    ]
  },
  market_gasLng: {
    name: 'Gas & LNG Market',
    slideTitle: '{country} - Gas & LNG Market',
    chartType: 'line',
    queries: [
      '{country} natural gas consumption demand statistics 2020-2024',
      '{country} LNG imports volume million tons price trends',
      '{country} natural gas pipeline network coverage industrial zones',
      '{country} gas distribution companies market players share',
      '{country} LNG regasification terminal capacity utilization'
    ]
  },
  market_pricing: {
    name: 'Energy Pricing Analysis',
    slideTitle: '{country} - Energy Pricing Trends',
    chartType: 'line',
    queries: [
      '{country} industrial electricity tariff rate per kWh 2020-2024',
      '{country} commercial electricity price comparison regional',
      '{country} natural gas price industrial users USD per mmbtu',
      '{country} energy price subsidy policy government support',
      '{country} electricity tariff forecast 2025 reform plans'
    ]
  },
  market_escoServices: {
    name: 'ESCO & Energy Services Market',
    slideTitle: '{country} - ESCO Market Overview',
    chartType: 'bar',
    queries: [
      '{country} ESCO market size value USD 2024 growth rate',
      '{country} energy service company list registered members',
      '{country} energy performance contracting EPC market projects',
      '{country} energy audit market demand factories industrial',
      '{country} energy management system EMS adoption rate'
    ]
  },

  // === SECTION 3: COMPETITOR OVERVIEW (5 slides) ===
  competitors_japanese: {
    name: 'Japanese Players in Market',
    slideTitle: '{country} - Japanese Energy Companies',
    queries: [
      'Tokyo Gas {country} investment projects subsidiary partnership',
      'Osaka Gas {country} energy business market entry presence',
      'JERA {country} power generation investment projects',
      'Mitsubishi Corporation {country} energy infrastructure projects',
      'Mitsui {country} LNG gas energy investments',
      'Japanese trading companies {country} energy sector presence'
    ]
  },
  competitors_localMajor: {
    name: 'Major Local Players',
    slideTitle: '{country} - Major Local Energy Companies',
    queries: [
      '{country} largest energy companies revenue market share ranking',
      '{country} state owned energy utility company overview',
      '{country} major industrial conglomerates energy subsidiaries',
      '{country} top 10 ESCO companies market leaders',
      '{country} energy engineering EPC contractors leading firms'
    ]
  },
  competitors_foreignPlayers: {
    name: 'Other Foreign Competitors',
    slideTitle: '{country} - Foreign Energy Companies',
    queries: [
      'ENGIE {country} energy services presence projects',
      'Schneider Electric {country} energy management business',
      'Siemens {country} energy infrastructure smart grid',
      'European energy companies {country} market presence',
      'American energy service providers {country} operations'
    ]
  },
  competitors_caseStudy: {
    name: 'Successful Entry Case Studies',
    slideTitle: '{country} - Market Entry Case Studies',
    queries: [
      'successful foreign energy company entry {country} case study',
      '{country} ESCO joint venture success stories',
      '{country} energy sector acquisition deals 2020-2024',
      'lessons learned energy market entry {country}',
      '{country} BOI promoted energy projects foreign investors'
    ]
  },
  competitors_maActivity: {
    name: 'M&A and Partnership Activity',
    slideTitle: '{country} - Recent M&A Activity',
    queries: [
      '{country} energy sector mergers acquisitions 2023 2024',
      '{country} ESCO companies for sale acquisition targets',
      '{country} energy joint venture announcements partnerships',
      '{country} strategic energy investments 2024',
      '{country} energy company valuation multiples deal terms'
    ]
  },

  // === ADDITIONAL CONTEXT ===
  macro_economicContext: {
    name: 'Economic Context',
    slideTitle: '{country} - Economic Overview',
    queries: [
      '{country} GDP 2024 2025 economic growth forecast IMF',
      '{country} manufacturing sector contribution GDP industrial output',
      '{country} foreign direct investment inflows energy sector',
      '{country} economic development plan industrial corridor',
      '{country} labor cost wage trends manufacturing sector'
    ]
  },
  opportunities_whitespace: {
    name: 'Market Entry Opportunities',
    slideTitle: '{country} - Entry Opportunities',
    queries: [
      '{country} ESCO market gap underserved segments opportunity',
      '{country} energy efficiency potential industrial factories',
      '{country} government energy tender upcoming projects',
      '{country} industrial parks seeking energy solutions',
      '{country} conglomerates seeking energy partners technology'
    ]
  },
  risks_assessment: {
    name: 'Risk Assessment',
    slideTitle: '{country} - Risk Assessment',
    queries: [
      '{country} energy sector regulatory risk policy uncertainty',
      '{country} foreign investment risks political stability',
      '{country} currency exchange rate risk energy contracts',
      '{country} energy policy reversal examples precedents',
      '{country} local content requirements energy sector'
    ]
  }
};

// Research topic groups for efficient parallel processing
const RESEARCH_TOPIC_GROUPS = {
  policy: ['policy_foundationalActs', 'policy_nationalPolicy', 'policy_investmentRestrictions'],
  market: ['market_tpes', 'market_finalDemand', 'market_electricity', 'market_gasLng', 'market_pricing', 'market_escoServices'],
  competitors: ['competitors_japanese', 'competitors_localMajor', 'competitors_foreignPlayers', 'competitors_caseStudy', 'competitors_maActivity'],
  context: ['macro_economicContext', 'opportunities_whitespace', 'risks_assessment']
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

  // Deep Research: Use expanded RESEARCH_FRAMEWORK for comprehensive coverage
  // 17 topic areas organized into sections matching Escort template
  const researchData = {};
  const topicKeys = Object.keys(RESEARCH_FRAMEWORK);
  console.log(`  [Deep Research - ${topicKeys.length} topic areas across 4 sections]`);

  // Process research topics by group for efficiency (2-3 parallel per group)
  for (const [groupName, topicList] of Object.entries(RESEARCH_TOPIC_GROUPS)) {
    console.log(`\n  [${groupName.toUpperCase()}] Researching ${topicList.length} topics...`);

    // Process 2 topics in parallel within each group
    for (let i = 0; i < topicList.length; i += 2) {
      const batch = topicList.slice(i, i + 2);

      const batchResults = await Promise.all(
        batch.map(async (topicKey) => {
          const framework = RESEARCH_FRAMEWORK[topicKey];
          if (!framework) return null;

          // Build comprehensive research query from framework
          const queryContext = `Research ${framework.name} for ${country}'s ${industry} market:

SPECIFIC QUESTIONS TO ANSWER:
${framework.queries.map(q => '- ' + q.replace('{country}', country)).join('\n')}

Requirements:
- Find 2024-2025 data where possible
- Include specific numbers, percentages, company names
- Note sources (government, company filings, industry reports)
- Focus on actionable intelligence, not generic descriptions`;

          console.log(`    [${topicKey}] Researching...`);
          const result = await callKimiDeepResearch(queryContext, country, industry);

          return {
            key: topicKey,
            content: result.content,
            citations: result.citations || [],
            chartType: framework.chartType || null,
            slideTitle: framework.slideTitle?.replace('{country}', country) || ''
          };
        })
      );

      // Store results
      for (const result of batchResults) {
        if (result && result.content) {
          researchData[result.key] = {
            content: result.content,
            citations: result.citations,
            chartType: result.chartType,
            slideTitle: result.slideTitle
          };
        }
      }

      // Rate limit between batches
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  console.log(`\n  [Research Complete] Collected data for ${Object.keys(researchData).length} topics`)

  // Synthesize research into structured output using DeepSeek
  // Expanded structure for 15+ slides matching Escort template
  console.log(`  [Synthesizing ${country} data for deep-dive report...]`);

  const synthesisPrompt = `You are a senior strategy consultant at YCP creating a comprehensive market analysis for ${country}'s ${industry} market. Your client is a ${clientContext}.

CRITICAL REQUIREMENTS:
1. DEPTH over breadth - specific numbers, names, dates for every claim
2. CHART DATA - provide structured data for charts where indicated
3. SLIDE-READY - each section maps to a specific slide

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
        {"name": "Tokyo Gas", "presence": "JV with Local Partner", "projects": "3 ESCO contracts", "revenue": "$X million", "assessment": "Strong/Weak"},
        {"name": "Osaka Gas", "presence": "Direct investment", "projects": "LNG terminal stake", "revenue": "$X million", "assessment": "Strong/Weak"}
      ],
      "marketInsight": "Overall assessment of Japanese presence"
    },
    "localMajor": {
      "slideTitle": "${country} - Major Local Players",
      "subtitle": "Domestic energy companies",
      "players": [
        {"name": "Company A", "type": "State-owned/Private", "revenue": "$X million", "marketShare": "X%", "strengths": "...", "weaknesses": "..."},
        {"name": "Company B", "type": "State-owned/Private", "revenue": "$X million", "marketShare": "X%", "strengths": "...", "weaknesses": "..."}
      ],
      "concentration": "Market concentration assessment"
    },
    "foreignPlayers": {
      "slideTitle": "${country} - Foreign Energy Companies",
      "subtitle": "International competitors",
      "players": [
        {"name": "ENGIE", "origin": "France", "entryYear": "2018", "mode": "JV", "projects": "X contracts", "success": "High/Medium/Low"},
        {"name": "Siemens", "origin": "Germany", "entryYear": "2015", "mode": "Direct", "projects": "Smart grid", "success": "High/Medium/Low"}
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

  // === SECTION 4: SUMMARY & RECOMMENDATIONS ===
  "summary": {
    "opportunities": [
      {"opportunity": "Specific opportunity", "size": "$X million", "timing": "Why now", "action": "What to do"}
    ],
    "obstacles": [
      {"obstacle": "Specific barrier", "severity": "High/Medium/Low", "mitigation": "How to address"}
    ],
    "ratings": {
      "attractiveness": 7,
      "attractivenessRationale": "Multi-factor justification",
      "feasibility": 6,
      "feasibilityRationale": "Multi-factor justification"
    },
    "keyInsights": [
      {
        "title": "Max 10 word headline",
        "data": "The specific evidence",
        "pattern": "What it means",
        "implication": "What to do"
      }
    ],
    "recommendation": "Clear recommendation for entry or not"
  }
}

CRITICAL:
- Every number needs year, source context
- Chart data must have numeric arrays (not placeholders)
- If data unavailable, use reasonable estimates and mark as "estimated"
- Aim for actionable specificity, not generic descriptions

Return ONLY valid JSON.`;

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

// ============ CHART GENERATION ============
// YCP Color Palette for charts
const CHART_COLORS = [
  '007FFF',  // Blue (primary)
  '011AB7',  // Dark blue
  'E46C0A',  // Orange
  '2E7D32',  // Green
  '1F497D',  // Navy
  'C62828',  // Red
  '9C27B0',  // Purple
  'FF9800'   // Amber
];

// Add a stacked bar chart to a slide
// data format: { categories: ['2020', '2021', '2022'], series: [{ name: 'Coal', values: [40, 38, 35] }, { name: 'Gas', values: [30, 32, 35] }] }
function addStackedBarChart(slide, title, data, options = {}) {
  if (!data || !data.categories || !data.series || data.series.length === 0) {
    return; // Skip if no valid data
  }

  const chartData = data.series.map((s, idx) => ({
    name: s.name,
    labels: data.categories,
    values: s.values,
    color: CHART_COLORS[idx % CHART_COLORS.length]
  }));

  slide.addChart('bar', chartData, {
    x: options.x || 0.5,
    y: options.y || 1.5,
    w: options.w || 9,
    h: options.h || 4.5,
    barDir: 'bar',
    barGrouping: 'stacked',
    showLegend: true,
    legendPos: 'b',
    showTitle: !!title,
    title: title,
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    catAxisLabelFontFace: 'Segoe UI',
    catAxisLabelFontSize: 10,
    valAxisLabelFontFace: 'Segoe UI',
    valAxisLabelFontSize: 10,
    dataLabelFontFace: 'Segoe UI',
    showValue: options.showValues || false
  });
}

// Add a line chart to a slide
// data format: { categories: ['2020', '2021', '2022'], series: [{ name: 'Price', values: [10, 12, 14] }] }
function addLineChart(slide, title, data, options = {}) {
  if (!data || !data.categories || !data.series || data.series.length === 0) {
    return; // Skip if no valid data
  }

  const chartData = data.series.map((s, idx) => ({
    name: s.name,
    labels: data.categories,
    values: s.values,
    color: CHART_COLORS[idx % CHART_COLORS.length]
  }));

  slide.addChart('line', chartData, {
    x: options.x || 0.5,
    y: options.y || 1.5,
    w: options.w || 9,
    h: options.h || 4.5,
    showLegend: data.series.length > 1,
    legendPos: 'b',
    showTitle: !!title,
    title: title,
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    catAxisLabelFontFace: 'Segoe UI',
    catAxisLabelFontSize: 10,
    valAxisLabelFontFace: 'Segoe UI',
    valAxisLabelFontSize: 10,
    lineDataSymbol: 'circle',
    lineDataSymbolSize: 6
  });
}

// Add a bar chart (horizontal or vertical) to a slide
function addBarChart(slide, title, data, options = {}) {
  if (!data || !data.categories || !data.values || data.values.length === 0) {
    return; // Skip if no valid data
  }

  const chartData = [{
    name: data.name || 'Value',
    labels: data.categories,
    values: data.values,
    color: CHART_COLORS[0]
  }];

  slide.addChart('bar', chartData, {
    x: options.x || 0.5,
    y: options.y || 1.5,
    w: options.w || 9,
    h: options.h || 4.5,
    barDir: options.horizontal ? 'bar' : 'col',
    showLegend: false,
    showTitle: !!title,
    title: title,
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    catAxisLabelFontFace: 'Segoe UI',
    catAxisLabelFontSize: 10,
    valAxisLabelFontFace: 'Segoe UI',
    valAxisLabelFontSize: 10,
    showValue: true,
    dataLabelFontFace: 'Segoe UI',
    dataLabelFontSize: 9
  });
}

// Add a pie/doughnut chart to a slide
function addPieChart(slide, title, data, options = {}) {
  if (!data || !data.categories || !data.values || data.values.length === 0) {
    return; // Skip if no valid data
  }

  const chartData = [{
    name: data.name || 'Share',
    labels: data.categories,
    values: data.values
  }];

  slide.addChart(options.doughnut ? 'doughnut' : 'pie', chartData, {
    x: options.x || 2,
    y: options.y || 1.5,
    w: options.w || 6,
    h: options.h || 4.5,
    showLegend: true,
    legendPos: 'r',
    showTitle: !!title,
    title: title,
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    showPercent: true,
    chartColors: CHART_COLORS.slice(0, data.categories.length)
  });
}

// Parse numeric data from research text for charting
function extractChartData(researchText, chartType) {
  // This function attempts to extract structured data from research text
  // In practice, the AI synthesis should provide structured data
  // This is a fallback pattern matcher

  const data = {
    categories: [],
    series: [],
    values: []
  };

  // Try to find year-based data patterns like "2020: 45, 2021: 48, 2022: 52"
  const yearPattern = /(\d{4})[:\s]+(\d+(?:\.\d+)?)/g;
  const yearMatches = [...(researchText || '').matchAll(yearPattern)];

  if (yearMatches.length >= 2) {
    data.categories = yearMatches.map(m => m[1]);
    data.values = yearMatches.map(m => parseFloat(m[2]));
    data.series = [{ name: 'Value', values: data.values }];
  }

  return data;
}

// Single country deep-dive PPT - Matches YCP Escort/Shizuoka Gas format
// Structure: Title → Policy (3) → Market (6 with charts) → Competitors (5) → Summary (2) = 17 slides
async function generateSingleCountryPPT(synthesis, countryAnalysis, scope) {
  console.log(`Generating expanded single-country PPT for ${synthesis.country}...`);

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
    footerText: '808080',    // Gray footer text
    green: '2E7D32',         // Positive/Opportunity
    orange: 'E46C0A',        // Warning/Obstacle
    red: 'C62828'            // Negative/Risk
  };

  // Set default font to Segoe UI (YCP standard)
  pptx.theme = { headFontFace: 'Segoe UI', bodyFontFace: 'Segoe UI' };
  const FONT = 'Segoe UI';

  // Get data from new structure or fall back to legacy structure
  const policy = synthesis.policy || {};
  const market = synthesis.market || {};
  const competitors = synthesis.competitors || {};
  const summary = synthesis.summary || synthesis.summaryAssessment || {};
  const country = synthesis.country;

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
  function addSlideWithTitle(title, subtitle = '') {
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

  // Helper for table header row
  function tableHeader(cols) {
    return cols.map(text => ({
      text,
      options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT }
    }));
  }

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
  titleSlide.addText(`Deep Research Report`, {
    x: 0.5, y: 3.6, w: 9, h: 0.4,
    fontSize: 14, color: COLORS.black, fontFace: FONT
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5, y: 6.5, w: 9, h: 0.3,
    fontSize: 10, color: '666666', fontFace: FONT
  });

  // ============ SECTION 1: POLICY & REGULATIONS (3 slides) ============

  // SLIDE 2: Foundational Acts
  const foundationalActs = policy.foundationalActs || {};
  const actsSlide = addSlideWithTitle(
    foundationalActs.slideTitle || `${country} - Energy Foundational Acts`,
    truncateSubtitle(foundationalActs.subtitle || foundationalActs.keyMessage || '', 95)
  );
  const acts = safeArray(foundationalActs.acts, 5);
  if (acts.length > 0) {
    const actsRows = [tableHeader(['Act Name', 'Year', 'Requirements', 'Enforcement'])];
    acts.forEach(act => {
      actsRows.push([
        { text: truncate(act.name || '', 25) },
        { text: act.year || '' },
        { text: truncate(act.requirements || '', 50) },
        { text: truncate(act.enforcement || '', 40) }
      ]);
    });
    actsSlide.addTable(actsRows, {
      x: 0.35, y: 1.3, w: 9.3, h: 5.2,
      fontSize: 12, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.2, 0.8, 3.3, 3.0],
      valign: 'top'
    });
  }

  // SLIDE 3: National Policy
  const nationalPolicy = policy.nationalPolicy || {};
  const policySlide = addSlideWithTitle(
    nationalPolicy.slideTitle || `${country} - National Energy Policy`,
    truncateSubtitle(nationalPolicy.policyDirection || '', 95)
  );
  const targets = safeArray(nationalPolicy.targets, 4);
  if (targets.length > 0) {
    const targetRows = [tableHeader(['Metric', 'Target', 'Deadline', 'Status'])];
    targets.forEach(t => {
      targetRows.push([
        { text: t.metric || '' },
        { text: t.target || '' },
        { text: t.deadline || '' },
        { text: t.status || '' }
      ]);
    });
    policySlide.addTable(targetRows, {
      x: 0.35, y: 1.3, w: 9.3, h: 2.5,
      fontSize: 12, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [3.0, 2.3, 2.0, 2.0],
      valign: 'top'
    });
  }
  // Key initiatives as bullets
  const initiatives = safeArray(nationalPolicy.keyInitiatives, 4);
  if (initiatives.length > 0) {
    policySlide.addText('Key Initiatives', {
      x: 0.35, y: 4.0, w: 9.3, h: 0.3,
      fontSize: 14, bold: true, color: COLORS.dk2, fontFace: FONT
    });
    policySlide.addText(initiatives.map(i => ({ text: truncate(i, 100), options: { bullet: true } })), {
      x: 0.35, y: 4.4, w: 9.3, h: 2.0,
      fontSize: 12, fontFace: FONT, color: COLORS.black, valign: 'top'
    });
  }

  // SLIDE 4: Investment Restrictions
  const investRestrict = policy.investmentRestrictions || {};
  const investSlide = addSlideWithTitle(
    investRestrict.slideTitle || `${country} - Foreign Investment Rules`,
    truncateSubtitle(investRestrict.riskJustification || '', 95)
  );
  // Ownership limits
  const ownership = investRestrict.ownershipLimits || {};
  const ownershipRows = [tableHeader(['Category', 'Limit', 'Details'])];
  if (ownership.general) ownershipRows.push([{ text: 'General Sectors' }, { text: ownership.general }, { text: truncate(ownership.exceptions || '', 60) }]);
  if (ownership.promoted) ownershipRows.push([{ text: 'BOI Promoted' }, { text: ownership.promoted }, { text: 'Tax incentives apply' }]);
  if (ownershipRows.length > 1) {
    investSlide.addTable(ownershipRows, {
      x: 0.35, y: 1.3, w: 9.3, h: 1.5,
      fontSize: 12, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.5, 1.5, 5.3],
      valign: 'top'
    });
  }
  // Incentives
  const incentivesList = safeArray(investRestrict.incentives, 3);
  if (incentivesList.length > 0) {
    const incRows = [tableHeader(['Incentive', 'Benefit', 'Eligibility'])];
    incentivesList.forEach(inc => {
      incRows.push([
        { text: inc.name || '' },
        { text: inc.benefit || '' },
        { text: truncate(inc.eligibility || '', 50) }
      ]);
    });
    investSlide.addTable(incRows, {
      x: 0.35, y: 3.0, w: 9.3, h: 2.0,
      fontSize: 12, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.5, 2.5, 4.3],
      valign: 'top'
    });
  }
  // Risk level indicator
  if (investRestrict.riskLevel) {
    const riskColor = investRestrict.riskLevel.toLowerCase().includes('high') ? COLORS.red :
                      investRestrict.riskLevel.toLowerCase().includes('low') ? COLORS.green : COLORS.orange;
    investSlide.addText(`Regulatory Risk: ${investRestrict.riskLevel.toUpperCase()}`, {
      x: 0.35, y: 5.5, w: 9.3, h: 0.4,
      fontSize: 14, bold: true, color: riskColor, fontFace: FONT
    });
  }

  // ============ SECTION 2: MARKET DATA (6 slides with charts) ============

  // SLIDE 5: TPES
  const tpes = market.tpes || {};
  const tpesSlide = addSlideWithTitle(
    tpes.slideTitle || `${country} - Total Primary Energy Supply`,
    truncateSubtitle(tpes.keyInsight || tpes.subtitle || '', 95)
  );
  if (tpes.chartData && tpes.chartData.series) {
    addStackedBarChart(tpesSlide, `TPES by Source (${tpes.chartData.unit || 'Mtoe'})`, tpes.chartData, { y: 1.3, h: 5.0 });
  } else {
    tpesSlide.addText('Chart data not available - refer to synthesis data', {
      x: 0.5, y: 3, w: 9, h: 1, fontSize: 14, fontFace: FONT, color: COLORS.footerText
    });
  }

  // SLIDE 6: Final Energy Demand
  const finalDemand = market.finalDemand || {};
  const demandSlide = addSlideWithTitle(
    finalDemand.slideTitle || `${country} - Final Energy Demand`,
    truncateSubtitle(finalDemand.growthRate || finalDemand.subtitle || '', 95)
  );
  if (finalDemand.chartData && finalDemand.chartData.series) {
    addStackedBarChart(demandSlide, `Demand by Sector (${finalDemand.chartData.unit || '%'})`, finalDemand.chartData, { y: 1.3, h: 4.0 });
  }
  // Key drivers as bullets
  const drivers = safeArray(finalDemand.keyDrivers, 3);
  if (drivers.length > 0) {
    demandSlide.addText(drivers.map(d => ({ text: truncate(d, 100), options: { bullet: true } })), {
      x: 0.35, y: 5.5, w: 9.3, h: 1.2,
      fontSize: 12, fontFace: FONT, color: COLORS.black, valign: 'top'
    });
  }

  // SLIDE 7: Electricity & Power
  const electricity = market.electricity || {};
  const elecSlide = addSlideWithTitle(
    electricity.slideTitle || `${country} - Electricity & Power`,
    truncateSubtitle(electricity.totalCapacity || electricity.subtitle || '', 95)
  );
  if (electricity.chartData && electricity.chartData.values) {
    addPieChart(elecSlide, `Power Generation Mix (${electricity.chartData.unit || '%'})`, electricity.chartData, { x: 0.5, y: 1.3, w: 5, h: 4 });
  }
  // Add key stats on the right
  elecSlide.addText([
    { text: `Demand Growth: ${electricity.demandGrowth || 'N/A'}`, options: { bullet: true } },
    { text: `Key Trend: ${truncate(electricity.keyTrend || 'N/A', 80)}`, options: { bullet: true } }
  ], {
    x: 5.5, y: 2, w: 4.3, h: 3,
    fontSize: 12, fontFace: FONT, color: COLORS.black, valign: 'top'
  });

  // SLIDE 8: Gas & LNG
  const gasLng = market.gasLng || {};
  const gasSlide = addSlideWithTitle(
    gasLng.slideTitle || `${country} - Gas & LNG Market`,
    truncateSubtitle(gasLng.pipelineNetwork || gasLng.subtitle || '', 95)
  );
  if (gasLng.chartData && gasLng.chartData.series) {
    addLineChart(gasSlide, `Gas Supply Trend (${gasLng.chartData.unit || 'bcm'})`, gasLng.chartData, { y: 1.3, h: 3.5 });
  }
  // LNG terminals
  const terminals = safeArray(gasLng.lngTerminals, 3);
  if (terminals.length > 0) {
    const termRows = [tableHeader(['Terminal', 'Capacity', 'Utilization'])];
    terminals.forEach(t => {
      termRows.push([
        { text: t.name || '' },
        { text: t.capacity || '' },
        { text: t.utilization || '' }
      ]);
    });
    gasSlide.addTable(termRows, {
      x: 0.35, y: 5.0, w: 9.3, h: 1.5,
      fontSize: 11, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [4.0, 2.65, 2.65],
      valign: 'top'
    });
  }

  // SLIDE 9: Energy Pricing
  const pricing = market.pricing || {};
  const priceSlide = addSlideWithTitle(
    pricing.slideTitle || `${country} - Energy Pricing`,
    truncateSubtitle(pricing.outlook || pricing.subtitle || '', 95)
  );
  if (pricing.chartData && pricing.chartData.series) {
    addLineChart(priceSlide, 'Energy Price Trends', pricing.chartData, { y: 1.3, h: 4.0 });
  }
  if (pricing.comparison) {
    priceSlide.addText(`Regional Comparison: ${truncate(pricing.comparison, 100)}`, {
      x: 0.35, y: 5.5, w: 9.3, h: 0.5,
      fontSize: 12, fontFace: FONT, color: COLORS.black
    });
  }

  // SLIDE 10: ESCO Market
  const escoMarket = market.escoMarket || {};
  const escoSlide = addSlideWithTitle(
    escoMarket.slideTitle || `${country} - ESCO Market`,
    truncateSubtitle(`${escoMarket.marketSize || ''} | ${escoMarket.growthRate || ''}`, 95)
  );
  if (escoMarket.chartData && escoMarket.chartData.values) {
    addBarChart(escoSlide, `Market Segments (${escoMarket.chartData.unit || '%'})`, escoMarket.chartData, { y: 1.3, h: 3.5 });
  }
  // Segments table
  const segments = safeArray(escoMarket.segments, 4);
  if (segments.length > 0) {
    const segRows = [tableHeader(['Segment', 'Size', 'Share'])];
    segments.forEach(s => {
      segRows.push([
        { text: s.name || '' },
        { text: s.size || '' },
        { text: s.share || '' }
      ]);
    });
    escoSlide.addTable(segRows, {
      x: 0.35, y: 5.0, w: 9.3, h: 1.5,
      fontSize: 11, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [4.0, 2.65, 2.65],
      valign: 'top'
    });
  }

  // ============ SECTION 3: COMPETITOR OVERVIEW (5 slides) ============

  // SLIDE 11: Japanese Players
  const japanesePlayers = competitors.japanesePlayers || {};
  const jpSlide = addSlideWithTitle(
    japanesePlayers.slideTitle || `${country} - Japanese Energy Companies`,
    truncateSubtitle(japanesePlayers.marketInsight || japanesePlayers.subtitle || '', 95)
  );
  const jpPlayers = safeArray(japanesePlayers.players, 5);
  if (jpPlayers.length > 0) {
    const jpRows = [tableHeader(['Company', 'Presence', 'Projects', 'Assessment'])];
    jpPlayers.forEach(p => {
      jpRows.push([
        { text: p.name || '' },
        { text: truncate(p.presence || '', 30) },
        { text: truncate(p.projects || '', 35) },
        { text: p.assessment || '' }
      ]);
    });
    jpSlide.addTable(jpRows, {
      x: 0.35, y: 1.3, w: 9.3, h: 5.2,
      fontSize: 11, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.0, 2.5, 3.0, 1.8],
      valign: 'top'
    });
  }

  // SLIDE 12: Local Major Players
  const localMajor = competitors.localMajor || {};
  const localSlide = addSlideWithTitle(
    localMajor.slideTitle || `${country} - Major Local Players`,
    truncateSubtitle(localMajor.concentration || localMajor.subtitle || '', 95)
  );
  const localPlayers = safeArray(localMajor.players, 5);
  if (localPlayers.length > 0) {
    const localRows = [tableHeader(['Company', 'Type', 'Revenue', 'Market Share', 'Strengths'])];
    localPlayers.forEach(p => {
      localRows.push([
        { text: p.name || '' },
        { text: p.type || '' },
        { text: p.revenue || '' },
        { text: p.marketShare || '' },
        { text: truncate(p.strengths || '', 35) }
      ]);
    });
    localSlide.addTable(localRows, {
      x: 0.35, y: 1.3, w: 9.3, h: 5.2,
      fontSize: 10, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.0, 1.3, 1.5, 1.3, 3.2],
      valign: 'top'
    });
  }

  // SLIDE 13: Foreign Players
  const foreignPlayers = competitors.foreignPlayers || {};
  const foreignSlide = addSlideWithTitle(
    foreignPlayers.slideTitle || `${country} - Foreign Energy Companies`,
    truncateSubtitle(foreignPlayers.competitiveInsight || foreignPlayers.subtitle || '', 95)
  );
  const foreignList = safeArray(foreignPlayers.players, 5);
  if (foreignList.length > 0) {
    const foreignRows = [tableHeader(['Company', 'Origin', 'Entry Year', 'Mode', 'Success'])];
    foreignList.forEach(p => {
      foreignRows.push([
        { text: p.name || '' },
        { text: p.origin || '' },
        { text: p.entryYear || '' },
        { text: p.mode || '' },
        { text: p.success || '' }
      ]);
    });
    foreignSlide.addTable(foreignRows, {
      x: 0.35, y: 1.3, w: 9.3, h: 5.2,
      fontSize: 11, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.5, 1.5, 1.3, 2.0, 2.0],
      valign: 'top'
    });
  }

  // SLIDE 14: Case Study
  const caseStudy = competitors.caseStudy || {};
  const caseSlide = addSlideWithTitle(
    caseStudy.slideTitle || `${country} - Market Entry Case Study`,
    truncateSubtitle(caseStudy.applicability || caseStudy.subtitle || '', 95)
  );
  // Case study details
  const caseDetails = [
    `Company: ${caseStudy.company || 'N/A'}`,
    `Entry Year: ${caseStudy.entryYear || 'N/A'}`,
    `Entry Mode: ${caseStudy.entryMode || 'N/A'}`,
    `Investment: ${caseStudy.investment || 'N/A'}`,
    `Outcome: ${truncate(caseStudy.outcome || 'N/A', 80)}`
  ];
  caseSlide.addText(caseDetails.map(d => ({ text: d, options: { bullet: true } })), {
    x: 0.35, y: 1.3, w: 9.3, h: 2.5,
    fontSize: 12, fontFace: FONT, color: COLORS.black, valign: 'top'
  });
  // Key lessons
  const lessons = safeArray(caseStudy.keyLessons, 4);
  if (lessons.length > 0) {
    caseSlide.addText('Key Lessons', {
      x: 0.35, y: 4.0, w: 9.3, h: 0.3,
      fontSize: 14, bold: true, color: COLORS.dk2, fontFace: FONT
    });
    caseSlide.addText(lessons.map(l => ({ text: truncate(l, 100), options: { bullet: true } })), {
      x: 0.35, y: 4.4, w: 9.3, h: 2.0,
      fontSize: 12, fontFace: FONT, color: COLORS.black, valign: 'top'
    });
  }

  // SLIDE 15: M&A Activity
  const maActivity = competitors.maActivity || {};
  const maSlide = addSlideWithTitle(
    maActivity.slideTitle || `${country} - M&A Activity`,
    truncateSubtitle(maActivity.valuationMultiples || maActivity.subtitle || '', 95)
  );
  // Recent deals
  const deals = safeArray(maActivity.recentDeals, 3);
  if (deals.length > 0) {
    const dealRows = [tableHeader(['Year', 'Buyer', 'Target', 'Value', 'Rationale'])];
    deals.forEach(d => {
      dealRows.push([
        { text: d.year || '' },
        { text: d.buyer || '' },
        { text: d.target || '' },
        { text: d.value || '' },
        { text: truncate(d.rationale || '', 30) }
      ]);
    });
    maSlide.addTable(dealRows, {
      x: 0.35, y: 1.3, w: 9.3, h: 2.0,
      fontSize: 10, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [0.8, 1.8, 1.8, 1.5, 3.4],
      valign: 'top'
    });
  }
  // Potential targets
  const potentialTargets = safeArray(maActivity.potentialTargets, 3);
  if (potentialTargets.length > 0) {
    maSlide.addText('Potential Acquisition Targets', {
      x: 0.35, y: 3.5, w: 9.3, h: 0.3,
      fontSize: 14, bold: true, color: COLORS.dk2, fontFace: FONT
    });
    const targetRows = [tableHeader(['Company', 'Est. Value', 'Rationale', 'Timing'])];
    potentialTargets.forEach(t => {
      targetRows.push([
        { text: t.name || '' },
        { text: t.estimatedValue || '' },
        { text: truncate(t.rationale || '', 40) },
        { text: t.timing || '' }
      ]);
    });
    maSlide.addTable(targetRows, {
      x: 0.35, y: 3.9, w: 9.3, h: 2.0,
      fontSize: 10, fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.0, 1.5, 4.0, 1.8],
      valign: 'top'
    });
  }

  // ============ SECTION 4: SUMMARY (2 slides) ============

  // SLIDE 16: Opportunities & Obstacles
  const ooSlide = addSlideWithTitle(
    `${country} - Opportunities & Obstacles`,
    truncateSubtitle(summary.recommendation || '', 95)
  );
  // Two-column layout
  const opportunities = safeArray(summary.opportunities, 4);
  const obstacles = safeArray(summary.obstacles, 4);

  // Opportunities column (left)
  ooSlide.addText('OPPORTUNITIES', {
    x: 0.35, y: 1.3, w: 4.5, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.green, fontFace: FONT
  });
  if (opportunities.length > 0) {
    ooSlide.addText(opportunities.map(o => ({
      text: typeof o === 'string' ? truncate(o, 70) : truncate(`${o.opportunity || ''} (${o.size || ''})`, 70),
      options: { bullet: true }
    })), {
      x: 0.35, y: 1.7, w: 4.5, h: 4.5,
      fontSize: 11, fontFace: FONT, color: COLORS.black, valign: 'top'
    });
  }

  // Obstacles column (right)
  ooSlide.addText('OBSTACLES', {
    x: 5.0, y: 1.3, w: 4.5, h: 0.3,
    fontSize: 14, bold: true, color: COLORS.orange, fontFace: FONT
  });
  if (obstacles.length > 0) {
    ooSlide.addText(obstacles.map(o => ({
      text: typeof o === 'string' ? truncate(o, 70) : truncate(`${o.obstacle || ''} [${o.severity || ''}]`, 70),
      options: { bullet: true }
    })), {
      x: 5.0, y: 1.7, w: 4.5, h: 4.5,
      fontSize: 11, fontFace: FONT, color: COLORS.black, valign: 'top'
    });
  }

  // Ratings at bottom
  const ratings = summary.ratings || {};
  if (ratings.attractiveness || ratings.feasibility) {
    ooSlide.addText(`Attractiveness: ${ratings.attractiveness || 'N/A'}/10 | Feasibility: ${ratings.feasibility || 'N/A'}/10`, {
      x: 0.35, y: 6.2, w: 9.3, h: 0.3,
      fontSize: 12, bold: true, color: COLORS.dk2, fontFace: FONT
    });
  }

  // SLIDE 17: Key Insights
  const insightsSlide = addSlideWithTitle(
    `${country} - Key Insights`,
    'Strategic implications for market entry'
  );
  const insights = safeArray(summary.keyInsights, 3);
  let insightY = 1.3;
  insights.forEach((insight, idx) => {
    const title = typeof insight === 'string' ? `Insight ${idx + 1}` : (insight.title || `Insight ${idx + 1}`);
    const content = typeof insight === 'string' ? insight :
      `${insight.data || ''} ${insight.pattern || ''} ${insight.implication || ''}`;

    insightsSlide.addText(title, {
      x: 0.35, y: insightY, w: 9.3, h: 0.35,
      fontSize: 14, bold: true, color: COLORS.dk2, fontFace: FONT
    });
    insightsSlide.addText(truncate(content, 200), {
      x: 0.35, y: insightY + 0.35, w: 9.3, h: 1.2,
      fontSize: 11, fontFace: FONT, color: COLORS.black, valign: 'top'
    });
    insightY += 1.7;
  });

  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  console.log(`Deep-dive PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB, 17 slides`);
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
