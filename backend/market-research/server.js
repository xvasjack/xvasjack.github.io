require('dotenv').config({ path: '../.env' });
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const pptxgen = require('pptxgenjs');
const { securityHeaders, rateLimiter } = require('./shared/security');
const { requestLogger, healthCheck } = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { createTracker, trackingContext, recordTokens } = require('./shared/tracking');

// Setup global error handlers to prevent crashes
setupGlobalErrorHandlers({ logMemory: false });

// ============ EXPRESS SETUP ============
const app = express();
app.set('trust proxy', 1); // Trust Railway's reverse proxy for rate limiting
app.use(securityHeaders);
app.use(rateLimiter);
app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));

// Check required environment variables
const requiredEnvVars = ['DEEPSEEK_API_KEY', 'KIMI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}

// ============ COST TRACKING ============
const costTracker = {
  date: new Date().toISOString().split('T')[0],
  totalCost: 0,
  calls: [],
};

// Pricing per 1M tokens (from DeepSeek docs - Dec 2024)
// Both deepseek-chat and deepseek-reasoner use same pricing
// deepseek-chat = V3.2 Non-thinking Mode (max 8K output)
// deepseek-reasoner = V3.2 Thinking Mode (max 64K output)
const PRICING = {
  'deepseek-chat': { input: 0.28, output: 0.42 }, // Cache miss pricing
  'deepseek-reasoner': { input: 0.28, output: 0.42 }, // Same pricing, but thinking mode
  'kimi-128k': { input: 0.84, output: 0.84 }, // Moonshot v1 128k context
  'kimi-32k': { input: 0.35, output: 0.35 }, // Moonshot v1 32k context
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
  costTracker.calls.push({
    model,
    inputTokens,
    outputTokens,
    searchCount,
    cost,
    time: new Date().toISOString(),
  });
  console.log(
    `  [Cost] ${model}: $${cost.toFixed(4)} (Total: $${costTracker.totalCost.toFixed(4)})`
  );
  return cost;
}

// ============ AI TOOLS ============

// Retry utility with exponential backoff
async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000, operationName = 'API call') {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        console.log(
          `  [Retry] ${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  console.error(`  [Retry] ${operationName} failed after ${maxRetries} attempts`);
  throw lastError;
}

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
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
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
    recordTokens('deepseek-chat', inputTokens, outputTokens);

    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: { input: inputTokens, output: outputTokens },
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
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `DeepSeek Reasoner HTTP error ${response.status}:`,
        errorText.substring(0, 200)
      );
      // Fallback to chat model
      console.log('Falling back to deepseek-chat...');
      return callDeepSeekChat(prompt, systemPrompt, maxTokens);
    }

    const data = await response.json();
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    trackCost('deepseek-reasoner', inputTokens, outputTokens);
    recordTokens('deepseek-reasoner', inputTokens, outputTokens);

    // R1 returns reasoning_content + content
    const content = data.choices?.[0]?.message?.content || '';
    const reasoning = data.choices?.[0]?.message?.reasoning_content || '';

    console.log(
      `  [DeepSeek V3.2 Thinking] Reasoning: ${reasoning.length} chars, Output: ${content.length} chars`
    );

    return {
      content,
      reasoning,
      usage: { input: inputTokens, output: outputTokens },
    };
  } catch (error) {
    console.error('DeepSeek Reasoner API error:', error.message);
    return { content: '', usage: { input: 0, output: 0 } };
  }
}

// Kimi (Moonshot) API - for deep research with web browsing
// Uses 128k context for thorough analysis with retry logic
async function callKimi(query, systemPrompt = '', useWebSearch = true) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: query });

  const requestBody = {
    model: 'moonshot-v1-128k',
    messages,
    max_tokens: 8192,
    temperature: 0.3,
  };

  // Enable web search tool if requested (can be disabled via env var for testing)
  const webSearchEnabled = process.env.KIMI_WEB_SEARCH !== 'false';
  if (useWebSearch && webSearchEnabled) {
    requestBody.tools = [
      {
        type: 'builtin_function',
        function: { name: '$web_search' },
      },
    ];
  }

  const kimiBaseUrl = process.env.KIMI_API_BASE || 'https://api.moonshot.ai/v1';

  try {
    // Use retry logic for network resilience
    const data = await withRetry(
      async () => {
        const response = await fetch(`${kimiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.KIMI_API_KEY}`,
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          // Throw to trigger retry for server errors
          if (response.status >= 500 || response.status === 429) {
            throw new Error(`Kimi HTTP ${response.status}: ${errorText.substring(0, 100)}`);
          }
          console.error(`Kimi HTTP error ${response.status}:`, errorText.substring(0, 200));
          return null; // Don't retry client errors
        }

        return await response.json();
      },
      3,
      2000,
      'Kimi research'
    );

    if (!data) {
      return { content: '', citations: [], researchQuality: 'failed' };
    }

    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    trackCost('kimi-128k', inputTokens, outputTokens);
    recordTokens('kimi-128k', inputTokens, outputTokens);

    // Debug: log if response has tool calls or empty content
    const content = data.choices?.[0]?.message?.content || '';
    const toolCalls = data.choices?.[0]?.message?.tool_calls;

    // Validate research quality
    let researchQuality = 'good';
    if (!content && toolCalls) {
      console.log(
        '  [Kimi] Response contains tool_calls instead of content - web search may need handling'
      );
      researchQuality = 'failed';
    } else if (!content) {
      console.log('  [Kimi] Empty response - finish_reason:', data.choices?.[0]?.finish_reason);
      researchQuality = 'failed';
    } else if (content.length < 100) {
      console.log(`  [Kimi] Thin response (${content.length} chars) - may be incomplete`);
      researchQuality = 'thin';
    }

    // Extract URLs from content for source citations
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
    const extractedUrls = content.match(urlRegex) || [];
    // Dedupe and clean URLs
    const citations = [...new Set(extractedUrls)]
      .filter((url) => {
        // Filter out common non-source URLs
        const skipPatterns = [
          'facebook.com',
          'twitter.com',
          'linkedin.com',
          'youtube.com',
          'instagram.com',
        ];
        return !skipPatterns.some((p) => url.includes(p));
      })
      .slice(0, 10)
      .map((url) => ({
        url: url.replace(/[.,;:!?)]+$/, ''), // Clean trailing punctuation
        title: url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
      }));

    return {
      content,
      citations,
      usage: { input: inputTokens, output: outputTokens },
      researchQuality,
    };
  } catch (error) {
    console.error('Kimi API error:', error.message);
    return { content: '', citations: [], researchQuality: 'failed' };
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
// Produces ~27 slides per country with charts, depth analysis, timing, lessons, and Go/No-Go decision

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
      '{country} renewable energy act feed-in tariff regulations',
    ],
  },
  policy_nationalPolicy: {
    name: 'National Energy Policy',
    slideTitle: '{country} - National Energy Policy',
    queries: [
      '{country} national energy plan 2024 2030 targets official',
      '{country} carbon neutrality net zero 2050 roadmap government',
      '{country} energy efficiency improvement target percentage annual',
      '{country} alternative energy development plan AEDP targets',
      '{country} energy ministry policy direction minister statements 2024',
    ],
  },
  policy_investmentRestrictions: {
    name: 'Investment Restrictions',
    slideTitle: '{country} - Foreign Investment Restrictions',
    queries: [
      '{country} foreign business act restricted industries energy sector',
      '{country} foreign ownership limit percentage energy power utilities',
      '{country} BOI investment promotion energy projects incentives',
      '{country} joint venture requirements foreign energy companies',
      '{country} special economic zones energy investment privileges',
    ],
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
      '{country} IEA energy statistics TPES breakdown',
    ],
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
      '{country} sectoral energy intensity trends',
    ],
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
      '{country} independent power producer IPP capacity licensed',
    ],
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
      '{country} LNG regasification terminal capacity utilization',
    ],
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
      '{country} electricity tariff forecast 2025 reform plans',
    ],
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
      '{country} energy management system EMS adoption rate',
    ],
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
      'Japanese trading companies {country} energy sector presence',
    ],
  },
  competitors_localMajor: {
    name: 'Major Local Players',
    slideTitle: '{country} - Major Local Energy Companies',
    queries: [
      '{country} largest energy companies revenue market share ranking',
      '{country} state owned energy utility company overview',
      '{country} major industrial conglomerates energy subsidiaries',
      '{country} top 10 ESCO companies market leaders',
      '{country} energy engineering EPC contractors leading firms',
    ],
  },
  competitors_foreignPlayers: {
    name: 'Other Foreign Competitors',
    slideTitle: '{country} - Foreign Energy Companies',
    queries: [
      'ENGIE {country} energy services presence projects',
      'Schneider Electric {country} energy management business',
      'Siemens {country} energy infrastructure smart grid',
      'European energy companies {country} market presence',
      'American energy service providers {country} operations',
    ],
  },
  competitors_caseStudy: {
    name: 'Successful Entry Case Studies',
    slideTitle: '{country} - Market Entry Case Studies',
    queries: [
      'successful foreign energy company entry {country} case study',
      '{country} ESCO joint venture success stories',
      '{country} energy sector acquisition deals 2020-2024',
      'lessons learned energy market entry {country}',
      '{country} BOI promoted energy projects foreign investors',
    ],
  },
  competitors_maActivity: {
    name: 'M&A and Partnership Activity',
    slideTitle: '{country} - Recent M&A Activity',
    queries: [
      '{country} energy sector mergers acquisitions 2023 2024',
      '{country} ESCO companies for sale acquisition targets',
      '{country} energy joint venture announcements partnerships',
      '{country} strategic energy investments 2024',
      '{country} energy company valuation multiples deal terms',
    ],
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
      '{country} labor cost wage trends manufacturing sector',
    ],
  },
  opportunities_whitespace: {
    name: 'Market Entry Opportunities',
    slideTitle: '{country} - Entry Opportunities',
    queries: [
      '{country} ESCO market gap underserved segments opportunity',
      '{country} energy efficiency potential industrial factories',
      '{country} government energy tender upcoming projects',
      '{country} industrial parks seeking energy solutions',
      '{country} conglomerates seeking energy partners technology',
    ],
  },
  risks_assessment: {
    name: 'Risk Assessment',
    slideTitle: '{country} - Risk Assessment',
    queries: [
      '{country} energy sector regulatory risk policy uncertainty',
      '{country} foreign investment risks political stability',
      '{country} currency exchange rate risk energy contracts',
      '{country} energy policy reversal examples precedents',
      '{country} local content requirements energy sector',
    ],
  },

  // === DEPTH TOPICS: ESCO ECONOMICS & DEAL STRUCTURE ===
  depth_escoEconomics: {
    name: 'ESCO Contract Economics',
    slideTitle: '{country} - ESCO Deal Economics',
    queries: [
      '{country} ESCO contract structure shared savings guaranteed savings',
      '{country} energy performance contracting typical deal size value',
      '{country} ESCO project payback period ROI internal rate return',
      '{country} energy efficiency project financing options banks',
      '{country} ESCO contract duration terms typical 5 10 years',
    ],
  },
  depth_partnerAssessment: {
    name: 'Potential Partners Deep Dive',
    slideTitle: '{country} - Partner Assessment',
    queries: [
      '{country} top engineering companies energy EPC contractors revenue',
      '{country} industrial conglomerates seeking foreign technology partners',
      '{country} local ESCO companies acquisition targets valuation',
      '{country} energy consulting firms technical capabilities staff',
      '{country} companies with Japanese partnership experience energy',
    ],
  },
  depth_entryStrategy: {
    name: 'Entry Strategy Analysis',
    slideTitle: '{country} - Entry Strategy Options',
    queries: [
      '{country} foreign energy company market entry modes JV acquisition',
      '{country} joint venture requirements foreign companies energy',
      '{country} successful greenfield energy services company examples',
      '{country} acquisition targets ESCO energy services companies',
      '{country} BOI promotion benefits foreign energy investment timeline',
    ],
  },
  depth_implementation: {
    name: 'Implementation Considerations',
    slideTitle: '{country} - Implementation Roadmap',
    queries: [
      '{country} company registration process foreign energy business timeline',
      '{country} BOI application approval process duration requirements',
      '{country} hiring energy engineers technical staff availability salary',
      '{country} office industrial facility costs Bangkok provinces',
      '{country} business license permits energy services company requirements',
    ],
  },
  depth_targetSegments: {
    name: 'Target Customer Segments',
    slideTitle: '{country} - Target Segments',
    queries: [
      '{country} largest energy consuming factories industrial facilities list',
      '{country} industrial estates zones highest energy intensity',
      '{country} manufacturing sectors highest electricity gas consumption',
      '{country} factories required energy audits compliance status',
      '{country} Japanese manufacturing companies presence factories list',
    ],
  },

  // === INSIGHT & INTELLIGENCE QUERIES (for non-obvious insights) ===
  insight_failures: {
    name: 'Failures & Lessons Learned',
    slideTitle: '{country} - Market Lessons',
    queries: [
      '{country} ESCO contract failures cancelled terminated projects reasons',
      '{country} foreign energy company exit withdrew market why reasons',
      '{country} energy project disputes legal cases arbitration',
      '{country} energy joint venture breakup dissolution reasons lessons',
      '{country} failed energy investments losses write-offs foreign companies',
    ],
  },
  insight_timing: {
    name: 'Timing & Triggers',
    slideTitle: '{country} - Market Timing',
    queries: [
      '{country} BOI investment incentives expiration deadline 2027 2028',
      '{country} carbon tax carbon pricing implementation timeline 2025 2026',
      '{country} energy regulation changes upcoming 2025 2026 new requirements',
      '{country} renewable energy targets deadline compliance 2030',
      '{country} energy efficiency mandate enforcement crackdown 2024 2025',
    ],
  },
  insight_competitive: {
    name: 'Competitive Intelligence',
    slideTitle: '{country} - Competitive Dynamics',
    queries: [
      '{country} ESCO companies seeking acquisition buyers sale',
      '{country} energy companies looking for foreign technology partners',
      '{country} competitor weaknesses complaints customer dissatisfaction',
      '{country} underserved industrial regions provinces energy services gap',
      '{country} energy services pricing pressure margins profitability',
    ],
  },
  insight_regulatory: {
    name: 'Regulatory Reality',
    slideTitle: '{country} - Regulatory Enforcement',
    queries: [
      '{country} energy audit enforcement rate actual compliance statistics',
      '{country} energy regulation violations penalties fines cases',
      '{country} DEDE EPPO regulatory capacity auditors inspectors shortage',
      '{country} energy policy enforcement selective industries targeted',
      '{country} regulatory relationships government connections importance',
    ],
  },
};

// Research topic groups for efficient parallel processing
const RESEARCH_TOPIC_GROUPS = {
  policy: ['policy_foundationalActs', 'policy_nationalPolicy', 'policy_investmentRestrictions'],
  market: [
    'market_tpes',
    'market_finalDemand',
    'market_electricity',
    'market_gasLng',
    'market_pricing',
    'market_escoServices',
  ],
  competitors: [
    'competitors_japanese',
    'competitors_localMajor',
    'competitors_foreignPlayers',
    'competitors_caseStudy',
    'competitors_maActivity',
  ],
  context: ['macro_economicContext', 'opportunities_whitespace', 'risks_assessment'],
  depth: [
    'depth_escoEconomics',
    'depth_partnerAssessment',
    'depth_entryStrategy',
    'depth_implementation',
    'depth_targetSegments',
  ],
  insights: ['insight_failures', 'insight_timing', 'insight_competitive', 'insight_regulatory'],
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
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
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
      focusAreas: ['market size', 'competition', 'regulations'],
    };
  }
}

// ============ DYNAMIC RESEARCH FRAMEWORK GENERATOR ============
// Generates industry-specific research queries based on user's request

async function generateResearchFramework(scope) {
  console.log('\n=== GENERATING DYNAMIC RESEARCH FRAMEWORK ===');
  console.log(`Industry: ${scope.industry}, Project: ${scope.projectType}`);

  const frameworkPrompt = `You are a research strategist designing a comprehensive market research plan.

PROJECT CONTEXT:
- Industry: ${scope.industry}
- Project Type: ${scope.projectType}
- Client Context: ${scope.clientContext || 'Not specified'}
- Focus Areas: ${(scope.focusAreas || []).join(', ') || 'General analysis'}

Generate a research framework with specific search queries for each category. The queries should be:
- Specific to the ${scope.industry} industry
- Appropriate for the ${scope.projectType} project type
- Designed to find actionable data, not general information

Return a JSON object with this structure:
{
  "policy": {
    "topics": [
      {
        "name": "Topic name",
        "queries": ["5 specific search queries with {country} placeholder"]
      }
    ]
  },
  "market": {
    "topics": [
      {
        "name": "Market Size & Growth",
        "queries": ["5 queries about market size, growth, segments for ${scope.industry}"]
      },
      {
        "name": "Industry Dynamics",
        "queries": ["5 queries about trends, drivers, challenges"]
      }
    ]
  },
  "competitors": {
    "topics": [
      {
        "name": "Major Players",
        "queries": ["5 queries about key companies, market share, strategies"]
      },
      {
        "name": "Competitive Dynamics",
        "queries": ["5 queries about M&A, partnerships, new entrants"]
      }
    ]
  },
  "depth": {
    "topics": [
      {
        "name": "Business Model & Economics",
        "queries": ["5 queries about pricing, margins, deal structures in ${scope.industry}"]
      },
      {
        "name": "Entry Strategy",
        "queries": ["5 queries about market entry modes, partnerships, acquisition targets"]
      }
    ]
  },
  "insights": {
    "topics": [
      {
        "name": "Failures & Lessons",
        "queries": ["5 queries about failed projects, exits, what went wrong"]
      },
      {
        "name": "Timing & Triggers",
        "queries": ["5 queries about regulatory deadlines, incentive expirations, market windows"]
      }
    ]
  }
}

CRITICAL RULES:
1. Every query must include "{country}" as a placeholder
2. Queries should seek SPECIFIC data: numbers, company names, dates, deal sizes
3. Include queries about failures, not just successes
4. Include timing-related queries (deadlines, expirations, upcoming changes)
5. For ${scope.projectType === 'market_entry' ? 'market entry' : scope.projectType}: focus on entry barriers, local partners, investment requirements
6. Total: 3-4 topics per category, 5 queries per topic

Return ONLY valid JSON.`;

  const result = await callDeepSeekChat(frameworkPrompt, '', 4096);

  try {
    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    const framework = JSON.parse(jsonStr);

    // Count topics and queries
    let topicCount = 0;
    let queryCount = 0;
    for (const category of Object.values(framework)) {
      if (category.topics) {
        topicCount += category.topics.length;
        for (const topic of category.topics) {
          queryCount += (topic.queries || []).length;
        }
      }
    }
    console.log(
      `Generated dynamic framework: ${topicCount} topics, ${queryCount} queries for ${scope.industry}`
    );

    return framework;
  } catch (error) {
    console.error('Failed to parse dynamic framework, using fallback:', error.message);
    // Return a generic fallback framework
    return generateFallbackFramework(scope);
  }
}

// Fallback generic framework if dynamic generation fails
function generateFallbackFramework(scope) {
  const industry = scope.industry || 'the industry';
  return {
    policy: {
      topics: [
        {
          name: 'Regulatory Framework',
          queries: [
            `{country} ${industry} regulations laws requirements`,
            `{country} ${industry} licensing permits foreign companies`,
            `{country} foreign investment restrictions ${industry} sector`,
            `{country} ${industry} compliance requirements standards`,
            `{country} government policy ${industry} development`,
          ],
        },
      ],
    },
    market: {
      topics: [
        {
          name: 'Market Size & Growth',
          queries: [
            `{country} ${industry} market size value USD 2024`,
            `{country} ${industry} market growth rate CAGR forecast`,
            `{country} ${industry} market segments breakdown`,
            `{country} ${industry} demand drivers trends`,
            `{country} ${industry} market outlook 2025 2030`,
          ],
        },
      ],
    },
    competitors: {
      topics: [
        {
          name: 'Major Players',
          queries: [
            `{country} ${industry} top companies market share ranking`,
            `{country} ${industry} foreign companies presence`,
            `{country} ${industry} local major players`,
            `{country} ${industry} competitive landscape analysis`,
            `{country} ${industry} M&A acquisitions recent`,
          ],
        },
      ],
    },
    depth: {
      topics: [
        {
          name: 'Business Economics',
          queries: [
            `{country} ${industry} pricing margins profitability`,
            `{country} ${industry} typical deal size contract value`,
            `{country} ${industry} partnership joint venture examples`,
            `{country} ${industry} investment requirements costs`,
            `{country} ${industry} success factors best practices`,
          ],
        },
      ],
    },
    insights: {
      topics: [
        {
          name: 'Lessons & Timing',
          queries: [
            `{country} ${industry} company failures exits reasons`,
            `{country} ${industry} regulatory changes upcoming 2025`,
            `{country} ${industry} incentives expiration deadline`,
            `{country} ${industry} underserved segments gaps`,
            `{country} ${industry} barriers challenges foreign companies`,
          ],
        },
      ],
    },
  };
}

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

// ============ MULTI-AGENT RESEARCH SYSTEM ============
// Specialized agents for each research domain running in parallel

// Policy Research Agent - handles regulatory and policy topics
async function policyResearchAgent(country, industry, _clientContext) {
  console.log(`    [POLICY AGENT] Starting research for ${country}...`);
  const agentStart = Date.now();
  const topics = RESEARCH_TOPIC_GROUPS.policy;
  const results = {};

  // Run all policy topics in parallel
  const policyResults = await Promise.all(
    topics.map(async (topicKey) => {
      const framework = RESEARCH_FRAMEWORK[topicKey];
      if (!framework) return null;

      const queryContext = `As a regulatory affairs specialist, research ${framework.name} for ${country}'s ${industry} market:

SPECIFIC QUESTIONS:
${framework.queries.map((q) => '- ' + q.replace('{country}', country)).join('\n')}

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

      const result = await callKimiDeepResearch(queryContext, country, industry);

      // Extract structured JSON from the response
      let structuredData = null;
      let extractionStatus = 'unknown';
      if (result.content) {
        const jsonMatch = result.content.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          try {
            structuredData = JSON.parse(jsonMatch[1]);
            extractionStatus = 'success';
          } catch (e) {
            console.log(`      [Policy] Failed to parse JSON for ${topicKey}: ${e.message}`);
            extractionStatus = 'parse_error';
          }
        } else {
          extractionStatus = 'no_json_found';
        }
      }

      return {
        key: topicKey,
        content: result.content,
        structuredData: structuredData,
        extractionStatus: extractionStatus,
        citations: result.citations || [],
        slideTitle: framework.slideTitle?.replace('{country}', country) || '',
        dataQuality: structuredData?.dataQuality || 'unknown',
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
async function marketResearchAgent(country, industry, _clientContext) {
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

        const queryContext = `As a market research analyst, research ${framework.name} for ${country}'s ${industry} market:

SPECIFIC QUESTIONS:
${framework.queries.map((q) => '- ' + q.replace('{country}', country)).join('\n')}

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

        const result = await callKimiDeepResearch(queryContext, country, industry);

        // Try to extract structured JSON from the response with improved error tracking
        let structuredData = null;
        let extractionStatus = 'unknown';
        let rawJson = null;
        if (result.content) {
          const jsonMatch = result.content.match(/```json\s*([\s\S]*?)\s*```/);
          if (jsonMatch) {
            rawJson = jsonMatch[1];
            try {
              structuredData = JSON.parse(jsonMatch[1]);
              extractionStatus = 'success';
            } catch (e) {
              console.log(`      [Market] Failed to parse JSON for ${topicKey}: ${e.message}`);
              extractionStatus = 'parse_error';
            }
          } else {
            extractionStatus = 'no_json_found';
            console.log(`      [Market] No JSON block found for ${topicKey}`);
          }
        }

        return {
          key: topicKey,
          content: result.content,
          structuredData: structuredData,
          extractionStatus: extractionStatus,
          rawJson: rawJson, // Keep for debugging/retry
          citations: result.citations || [],
          chartType: framework.chartType || null,
          slideTitle: framework.slideTitle?.replace('{country}', country) || '',
          dataQuality: structuredData?.dataQuality || 'unknown',
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
async function competitorResearchAgent(country, industry, _clientContext) {
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
      const queryContext = `As a competitive intelligence analyst, research ${framework.name} for ${country}'s ${industry} market:

SPECIFIC QUESTIONS:
${framework.queries.map((q) => '- ' + q.replace('{country}', country)).join('\n')}

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
      "description": "Detailed 50+ word description including revenue, growth rate, market position, key services, strategic context, and why this company matters for market entry analysis",
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
      "description": "Detailed 50+ word description of company's presence, operations, market position, and strategic significance"
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

      const result = await callKimiDeepResearch(queryContext, country, industry);

      // Extract structured JSON with improved error tracking
      let structuredData = null;
      let extractionStatus = 'unknown';
      let rawJson = null;
      if (result.content) {
        const jsonMatch = result.content.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          rawJson = jsonMatch[1];
          try {
            structuredData = JSON.parse(jsonMatch[1]);
            extractionStatus = 'success';
          } catch (e) {
            console.log(`      [Competitor] Failed to parse JSON for ${topicKey}: ${e.message}`);
            extractionStatus = 'parse_error';
          }
        } else {
          extractionStatus = 'no_json_found';
          console.log(`      [Competitor] No JSON block found for ${topicKey}`);
        }
      }

      return {
        key: topicKey,
        content: result.content,
        structuredData: structuredData,
        extractionStatus: extractionStatus,
        rawJson: rawJson, // Keep for debugging/retry
        citations: result.citations || [],
        slideTitle: framework.slideTitle?.replace('{country}', country) || '',
        dataQuality: structuredData?.dataQuality || 'unknown',
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
async function contextResearchAgent(country, industry, clientContext) {
  console.log(`    [CONTEXT AGENT] Starting research for ${country}...`);
  const agentStart = Date.now();
  const topics = RESEARCH_TOPIC_GROUPS.context;
  const results = {};

  // Run context topics in parallel
  const contextResults = await Promise.all(
    topics.map(async (topicKey) => {
      const framework = RESEARCH_FRAMEWORK[topicKey];
      if (!framework) return null;

      const queryContext = `As a strategy consultant advising a ${clientContext}, research ${framework.name} for ${country}'s ${industry} market:

SPECIFIC QUESTIONS:
${framework.queries.map((q) => '- ' + q.replace('{country}', country)).join('\n')}

FOCUS ON:
- Actionable opportunities with sizing
- Specific risks with mitigation strategies
- Timing factors (why now vs later)
- Economic drivers affecting energy demand
- Industrial development corridors and zones`;

      const result = await callKimiDeepResearch(queryContext, country, industry);
      return {
        key: topicKey,
        content: result.content,
        citations: result.citations || [],
        slideTitle: framework.slideTitle?.replace('{country}', country) || '',
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
async function depthResearchAgent(country, industry, clientContext) {
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

      const queryContext = `As a senior M&A advisor helping a ${clientContext} enter ${country}'s ${industry} market, research ${framework.name}:

SPECIFIC QUESTIONS:
${framework.queries.map((q) => '- ' + q.replace('{country}', country)).join('\n')}

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

      const result = await callKimiDeepResearch(queryContext, country, industry);

      // Extract structured JSON from response
      let structuredData = null;
      let dataQuality = 'unknown';
      if (result.content) {
        const jsonMatch = result.content.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          try {
            structuredData = JSON.parse(jsonMatch[1]);
            dataQuality = structuredData.dataQuality || 'unknown';
            console.log(`      [${topicKey}] Extracted structured JSON (quality: ${dataQuality})`);
          } catch (e) {
            console.log(`      [${topicKey}] JSON parse failed: ${e.message}`);
          }
        }
      }

      return {
        key: topicKey,
        content: result.content,
        citations: result.citations || [],
        slideTitle: framework.slideTitle?.replace('{country}', country) || '',
        structuredData,
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
async function insightsResearchAgent(country, industry, clientContext) {
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

      const queryContext = `As a competitive intelligence analyst helping a ${clientContext} evaluate ${country}'s ${industry} market, research ${framework.name}:

QUESTIONS TO ANSWER:
${framework.queries.map((q) => '- ' + q.replace('{country}', country)).join('\n')}

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

      const result = await callKimiDeepResearch(queryContext, country, industry);

      // Extract structured JSON from response
      let structuredData = null;
      let dataQuality = 'unknown';
      if (result.content) {
        const jsonMatch = result.content.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          try {
            structuredData = JSON.parse(jsonMatch[1]);
            dataQuality = structuredData.dataQuality || 'unknown';
            console.log(`      [${topicKey}] Extracted structured JSON (quality: ${dataQuality})`);
          } catch (e) {
            console.log(`      [${topicKey}] JSON parse failed: ${e.message}`);
          }
        }
      }

      return {
        key: topicKey,
        content: result.content,
        citations: result.citations || [],
        slideTitle: framework.slideTitle?.replace('{country}', country) || '',
        structuredData,
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
  projectType
) {
  console.log(`    [${category.toUpperCase()} AGENT] Starting research for ${country}...`);
  const agentStart = Date.now();
  const results = {};

  // Run all topics in parallel
  const topicResults = await Promise.all(
    topics.map(async (topic, idx) => {
      const queryContext = `As a senior consultant advising a ${clientContext} on a ${projectType} project, research ${topic.name} for ${country}'s ${industry} market:

SPECIFIC QUESTIONS:
${topic.queries.map((q) => '- ' + q.replace(/{country}/g, country)).join('\n')}

REQUIREMENTS:
- Provide SPECIFIC data: numbers, company names, dates, deal sizes
- If data is unavailable, clearly state "data not available" rather than guessing
- Focus on actionable intelligence, not general observations
- Include recent developments (2023-2024)`;

      const result = await callKimiDeepResearch(queryContext, country, industry);
      return {
        key: `${category}_${idx}_${topic.name.replace(/\s+/g, '_').toLowerCase()}`,
        name: topic.name,
        content: result.content,
        citations: result.citations || [],
      };
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
        {"name": "Tokyo Gas", "website": "https://www.tokyo-gas.co.jp", "presence": "JV with Local Partner", "projects": "3 ESCO contracts", "revenue": "$X million", "assessment": "Strong/Weak", "description": "Detailed 50+ word description including market position, entry strategy, key projects, revenue figures, growth trajectory, and strategic significance for competitive landscape"},
        {"name": "Osaka Gas", "website": "https://www.osakagas.co.jp", "presence": "Direct investment", "projects": "LNG terminal stake", "revenue": "$X million", "assessment": "Strong/Weak", "description": "Detailed 50+ word description"}
      ],
      "marketInsight": "Overall assessment of Japanese presence"
    },
    "localMajor": {
      "slideTitle": "${country} - Major Local Players",
      "subtitle": "Domestic energy companies",
      "players": [
        {"name": "Company A", "website": "https://companya.com", "type": "State-owned/Private", "revenue": "$X million", "marketShare": "X%", "strengths": "...", "weaknesses": "...", "description": "Detailed 50+ word description including revenue, growth rate, market share, key services, geographic coverage, and competitive advantages"},
        {"name": "Company B", "website": "https://companyb.com", "type": "State-owned/Private", "revenue": "$X million", "marketShare": "X%", "strengths": "...", "weaknesses": "...", "description": "Detailed 50+ word description"}
      ],
      "concentration": "Market concentration assessment"
    },
    "foreignPlayers": {
      "slideTitle": "${country} - Foreign Energy Companies",
      "subtitle": "International competitors",
      "players": [
        {"name": "ENGIE", "website": "https://www.engie.com", "origin": "France", "entryYear": "2018", "mode": "JV", "projects": "X contracts", "success": "High/Medium/Low", "description": "Detailed 50+ word description including entry strategy, local partnerships, revenue, project portfolio, and competitive position"},
        {"name": "Siemens", "website": "https://www.siemens-energy.com", "origin": "Germany", "entryYear": "2015", "mode": "Direct", "projects": "Smart grid", "success": "High/Medium/Low", "description": "Detailed 50+ word description"}
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
      {"name": "actual company", "website": "https://company.com", "strengths": "specific", "weaknesses": "specific", "threat": "how they could block you", "description": "Detailed 50+ word description with revenue, market share, entry year, key projects, geographic coverage, strategic positioning, and why this player matters for competitive analysis"}
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

// ============ PPT GENERATION ============

// Helper: truncate text to fit slides - end at sentence or phrase boundary
// CRITICAL: Never cut mid-sentence. Better to be shorter than incomplete.
// Adds ellipsis (...) when text is truncated to indicate continuation
function truncate(text, maxLen = 150, addEllipsis = true) {
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

  // Helper to add ellipsis if text continues after this point
  const maybeEllipsis = (result, checkPos) => {
    // Only add ellipsis if there's more content after the cut point
    const needsEllipsis = addEllipsis && checkPos < str.length - 1 && !result.endsWith('.');
    return needsEllipsis ? result + '...' : result;
  };

  if (lastSentence > maxLen * 0.4) {
    const result = truncated.substring(0, lastSentence + 1).trim();
    // Sentence ends naturally - only add ellipsis if there's more content and it doesn't end with period
    return maybeEllipsis(result, lastSentence + 1);
  }

  // Try to end at strong phrase boundary (; or :)
  const strongPhrase = Math.max(truncated.lastIndexOf('; '), truncated.lastIndexOf(': '));
  if (strongPhrase > maxLen * 0.4) {
    const result = truncated.substring(0, strongPhrase + 1).trim();
    return maybeEllipsis(result, strongPhrase + 1);
  }

  // Try to end at parenthetical close
  const lastParen = truncated.lastIndexOf(')');
  if (lastParen > maxLen * 0.5) {
    const result = truncated.substring(0, lastParen + 1).trim();
    return maybeEllipsis(result, lastParen + 1);
  }

  // Try to end at comma boundary (weaker)
  const lastComma = truncated.lastIndexOf(', ');
  if (lastComma > maxLen * 0.5) {
    const result = truncated.substring(0, lastComma).trim();
    return addEllipsis ? result + '...' : result;
  }

  // Last resort: end at word boundary, but ensure we don't cut mid-word
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) {
    // Check if ending on a preposition/article - if so, cut earlier
    const words = truncated.substring(0, lastSpace).split(' ');
    const lastWord = words[words.length - 1].toLowerCase();
    const badEndings = [
      'for',
      'to',
      'the',
      'a',
      'an',
      'of',
      'in',
      'on',
      'at',
      'by',
      'with',
      'and',
      'or',
      'but',
      'are',
      'is',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'largely',
      'mostly',
      'mainly',
    ];
    if (badEndings.includes(lastWord) && words.length > 1) {
      // Remove the dangling preposition/article
      words.pop();
      const result = words.join(' ').trim();
      return addEllipsis ? result + '...' : result;
    }
    const result = truncated.substring(0, lastSpace).trim();
    return addEllipsis ? result + '...' : result;
  }

  const result = truncated.trim();
  return addEllipsis ? result + '...' : result;
}

// Helper: truncate subtitle/message text - stricter limits per YCP spec (max ~20 words / 100 chars)
// Adds ellipsis (...) when text is truncated
function truncateSubtitle(text, maxLen = 100, addEllipsis = true) {
  if (!text) return '';
  const str = String(text).trim();
  if (str.length <= maxLen) return str;

  // For subtitles, prefer ending at sentence boundary
  const truncated = str.substring(0, maxLen);

  // Look for sentence end
  const lastPeriod = truncated.lastIndexOf('. ');
  if (lastPeriod > maxLen * 0.4) {
    const result = truncated.substring(0, lastPeriod + 1).trim();
    // Only add ellipsis if there's more content after and doesn't end with period
    const needsEllipsis = addEllipsis && lastPeriod + 1 < str.length - 1 && !result.endsWith('.');
    return needsEllipsis ? result + '...' : result;
  }

  // Look for other clean breaks
  const lastColon = truncated.lastIndexOf(': ');
  if (lastColon > maxLen * 0.4) {
    const result = truncated.substring(0, lastColon + 1).trim();
    return addEllipsis && lastColon + 1 < str.length - 1 ? result + '...' : result;
  }

  // Fall back to truncate function (which handles ellipsis)
  return truncate(str, maxLen, addEllipsis);
}

// Helper: safely get array items
function safeArray(arr, max = 5) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, max);
}

// Helper: calculate dynamic column widths based on content length
// Returns array of column widths in inches that sum to totalWidth
function calculateColumnWidths(data, totalWidth = 12.5, options = {}) {
  if (!data || data.length === 0) return [];

  const minColWidth = options.minColWidth || 0.8; // Minimum column width in inches
  const maxColWidth = options.maxColWidth || 6; // Maximum column width in inches
  const numCols = data[0].length;

  if (numCols === 0) return [];

  // Calculate maximum content length for each column
  const maxLengths = [];
  for (let colIdx = 0; colIdx < numCols; colIdx++) {
    let maxLen = 0;
    for (const row of data) {
      if (row[colIdx]) {
        const cellText =
          typeof row[colIdx] === 'object' ? String(row[colIdx].text || '') : String(row[colIdx]);
        maxLen = Math.max(maxLen, cellText.length);
      }
    }
    // Apply minimum length to avoid zero-width columns
    maxLengths.push(Math.max(maxLen, 5));
  }

  // Calculate total length for proportional distribution
  const totalLength = maxLengths.reduce((sum, len) => sum + len, 0);

  // Calculate proportional widths
  let widths = maxLengths.map((len) => (len / totalLength) * totalWidth);

  // Apply min/max constraints
  widths = widths.map((w) => Math.max(minColWidth, Math.min(maxColWidth, w)));

  // Normalize to ensure widths sum to totalWidth
  const currentTotal = widths.reduce((sum, w) => sum + w, 0);
  if (currentTotal !== totalWidth) {
    const scale = totalWidth / currentTotal;
    widths = widths.map((w) => w * scale);
  }

  return widths;
}

// Helper: create table row options with proper styling
function createTableRowOptions(isHeader = false, isAlternate = false, COLORS = {}) {
  const options = {
    fontFace: 'Segoe UI',
    fontSize: 10,
    valign: 'middle',
  };

  if (isHeader) {
    options.bold = true;
    options.fill = { color: COLORS.accent3 || '011AB7' }; // Navy background
    options.color = COLORS.white || 'FFFFFF';
  } else if (isAlternate) {
    options.fill = { color: 'F5F5F5' }; // Light gray for alternating rows
    options.color = COLORS.black || '000000';
  } else {
    options.color = COLORS.black || '000000';
  }

  return options;
}

// Helper: add source footnote to slide
// Uses widescreen dimensions (13.333" x 7.5" = 16:9)
function addSourceFootnote(slide, sources, COLORS, FONT) {
  if (!sources || (Array.isArray(sources) && sources.length === 0)) return;

  let sourceText = '';
  if (typeof sources === 'string') {
    sourceText = `Source: ${sources}`;
  } else if (Array.isArray(sources)) {
    const sourceList = sources
      .slice(0, 3)
      .map((s) => (typeof s === 'string' ? s : s.name || s.source || ''))
      .filter(Boolean);
    sourceText = sourceList.length > 0 ? `Sources: ${sourceList.join('; ')}` : '';
  }

  if (sourceText) {
    slide.addText(truncate(sourceText, 120), {
      x: 0.4,
      y: 6.85,
      w: 12.5,
      h: 0.2,
      fontSize: 8,
      fontFace: FONT,
      color: COLORS?.footerText || '666666',
      valign: 'top',
    });
  }
}

// Helper: add callout/insight box to slide
// Uses widescreen dimensions (13.333" x 7.5" = 16:9)
function addCalloutBox(slide, title, content, options = {}) {
  const boxX = options.x || 0.4; // LEFT_MARGIN for widescreen
  const boxY = options.y || 5.3;
  const boxW = options.w || 12.5; // CONTENT_WIDTH for widescreen
  const boxH = options.h || 1.2;
  const boxType = options.type || 'insight'; // insight, warning, recommendation
  const FONT = 'Segoe UI';

  // Box colors based on type
  const typeColors = {
    insight: { fill: 'F5F5F5', border: '1F497D', titleColor: '1F497D' },
    warning: { fill: 'FFF8E1', border: 'E46C0A', titleColor: 'E46C0A' },
    recommendation: { fill: 'EDFDFF', border: '007FFF', titleColor: '007FFF' },
    positive: { fill: 'F0FFF0', border: '2E7D32', titleColor: '2E7D32' },
    negative: { fill: 'FFF0F0', border: 'C62828', titleColor: 'C62828' },
  };
  const colors = typeColors[boxType] || typeColors.insight;

  // Box background with border
  slide.addShape('rect', {
    x: boxX,
    y: boxY,
    w: boxW,
    h: boxH,
    fill: { color: colors.fill },
    line: { color: colors.border, pt: 1.5 },
  });

  // Title (if provided)
  if (title) {
    slide.addText(title, {
      x: boxX + 0.1,
      y: boxY + 0.05,
      w: boxW - 0.2,
      h: 0.25,
      fontSize: 10,
      bold: true,
      color: colors.titleColor,
      fontFace: FONT,
    });
    // Content below title
    if (content) {
      slide.addText(truncate(content, 200), {
        x: boxX + 0.1,
        y: boxY + 0.35,
        w: boxW - 0.2,
        h: boxH - 0.45,
        fontSize: 10,
        color: '000000',
        fontFace: FONT,
        valign: 'top',
      });
    }
  } else if (content) {
    // Just content, no title
    slide.addText(truncate(content, 200), {
      x: boxX + 0.1,
      y: boxY + 0.1,
      w: boxW - 0.2,
      h: boxH - 0.2,
      fontSize: 10,
      color: '000000',
      fontFace: FONT,
      valign: 'top',
    });
  }
}

// Helper: add insights panel to chart slides (right side of chart)
// Displays key insights as bullet points next to charts for YCP-quality output
function addInsightsPanel(slide, insights = [], options = {}) {
  if (!insights || insights.length === 0) return;

  const FONT = 'Segoe UI';
  const panelX = options.x || 9.8; // Position to right of chart
  const panelY = options.y || 1.5;
  const panelW = options.w || 3.2;
  const panelH = options.h || 4.0;

  // Panel header
  slide.addText('Key Insights', {
    x: panelX,
    y: panelY,
    w: panelW,
    h: 0.35,
    fontSize: 12,
    bold: true,
    color: '1F497D', // Navy
    fontFace: FONT,
    valign: 'bottom',
  });

  // Navy underline for header
  slide.addShape('line', {
    x: panelX,
    y: panelY + 0.35,
    w: panelW,
    h: 0,
    line: { color: '1F497D', width: 1.5 },
  });

  // Build bullet points with navy bullets
  const bulletPoints = insights.slice(0, 4).map((insight) => ({
    text: truncate(String(insight), 150),
    options: {
      fontSize: 10,
      color: '333333',
      fontFace: FONT,
      bullet: { type: 'bullet', color: '1F497D' },
      paraSpaceBefore: 8,
      paraSpaceAfter: 4,
    },
  }));

  slide.addText(bulletPoints, {
    x: panelX,
    y: panelY + 0.45,
    w: panelW,
    h: panelH - 0.5,
    valign: 'top',
  });
}

// Helper: add section divider slide (Table of Contents style)
// Creates a visual break between major sections with section title
function addSectionDivider(pptx, sectionTitle, sectionNumber, totalSections, options = {}) {
  const FONT = 'Segoe UI';
  const COLORS = options.COLORS || {
    headerLine: '293F55',
    accent3: '011AB7',
    dk2: '1F497D',
    white: 'FFFFFF',
  };

  // Use master slide if defined, otherwise create plain slide
  const slide = options.masterName
    ? pptx.addSlide({ masterName: options.masterName })
    : pptx.addSlide();

  // Dark navy background for section divider
  slide.addShape('rect', {
    x: 0,
    y: 0,
    w: 13.333,
    h: 7.5,
    fill: { color: COLORS.accent3 || '011AB7' },
  });

  // Section number (small, top left)
  if (sectionNumber && totalSections) {
    slide.addText(`Section ${sectionNumber} of ${totalSections}`, {
      x: 0.5,
      y: 0.5,
      w: 3,
      h: 0.3,
      fontSize: 12,
      color: 'FFFFFF',
      fontFace: FONT,
      italic: true,
    });
  }

  // Section title (large, centered)
  slide.addText(sectionTitle, {
    x: 0.5,
    y: 2.8,
    w: 12.333,
    h: 1.5,
    fontSize: 44,
    bold: true,
    color: 'FFFFFF',
    fontFace: FONT,
    align: 'center',
    valign: 'middle',
  });

  // Decorative line under title
  slide.addShape('line', {
    x: 4,
    y: 4.5,
    w: 5.333,
    h: 0,
    line: { color: 'FFFFFF', width: 3 },
  });

  return slide;
}

// Helper: create Opportunities & Obstacles summary slide (two-column layout)
function addOpportunitiesObstaclesSummary(slide, opportunities = [], obstacles = [], options = {}) {
  const FONT = 'Segoe UI';
  const LEFT_MARGIN = options.x || 0.4;
  const contentY = options.y || 1.4;
  const colWidth = options.colWidth || 6;
  const COLORS = {
    green: '2E7D32',
    orange: 'E46C0A',
    white: 'FFFFFF',
    lightGreen: 'E8F5E9',
    lightOrange: 'FFF3E0',
  };

  // Opportunities column (left)
  // Header with green background
  slide.addShape('rect', {
    x: LEFT_MARGIN,
    y: contentY,
    w: colWidth,
    h: 0.5,
    fill: { color: COLORS.green },
  });
  slide.addText('Opportunities', {
    x: LEFT_MARGIN + 0.1,
    y: contentY,
    w: colWidth - 0.2,
    h: 0.5,
    fontSize: 14,
    bold: true,
    color: COLORS.white,
    fontFace: FONT,
    valign: 'middle',
  });

  // Opportunities list
  const oppBullets = (opportunities || []).slice(0, 5).map((opp) => ({
    text: truncate(String(opp), 120),
    options: {
      fontSize: 11,
      color: '333333',
      fontFace: FONT,
      bullet: { type: 'bullet', code: '2714', color: COLORS.green }, // Checkmark
      paraSpaceBefore: 8,
      paraSpaceAfter: 4,
    },
  }));

  if (oppBullets.length > 0) {
    slide.addText(oppBullets, {
      x: LEFT_MARGIN,
      y: contentY + 0.6,
      w: colWidth,
      h: 4,
      valign: 'top',
      fill: { color: COLORS.lightGreen },
    });
  }

  // Obstacles column (right)
  const rightColX = LEFT_MARGIN + colWidth + 0.3;

  // Header with orange background
  slide.addShape('rect', {
    x: rightColX,
    y: contentY,
    w: colWidth,
    h: 0.5,
    fill: { color: COLORS.orange },
  });
  slide.addText('Obstacles & Risks', {
    x: rightColX + 0.1,
    y: contentY,
    w: colWidth - 0.2,
    h: 0.5,
    fontSize: 14,
    bold: true,
    color: COLORS.white,
    fontFace: FONT,
    valign: 'middle',
  });

  // Obstacles list
  const obsBullets = (obstacles || []).slice(0, 5).map((obs) => ({
    text: truncate(String(obs), 120),
    options: {
      fontSize: 11,
      color: '333333',
      fontFace: FONT,
      bullet: { type: 'bullet', code: '26A0', color: COLORS.orange }, // Warning sign
      paraSpaceBefore: 8,
      paraSpaceAfter: 4,
    },
  }));

  if (obsBullets.length > 0) {
    slide.addText(obsBullets, {
      x: rightColX,
      y: contentY + 0.6,
      w: colWidth,
      h: 4,
      valign: 'top',
      fill: { color: COLORS.lightOrange },
    });
  }
}

// ============ CHART GENERATION ============
// YCP Color Palette for charts - WCAG 2.1 AA accessible colors
// Colors selected for sufficient contrast and colorblind-friendly combinations
const CHART_COLORS = [
  '0066CC', // Blue (primary) - high contrast, safe for colorblind
  'D55E00', // Orange-red - distinguishable for deuteranopia
  '009E73', // Teal/Green - safe for protanopia
  'CC79A7', // Muted pink - distinguishable across color blindness types
  '1F497D', // Navy - dark contrast
  'F0E442', // Yellow - high visibility (use with dark text)
  '56B4E9', // Sky blue - complements orange-red
  'E69F00', // Amber/Gold - warm contrast
];

// Extended accessible color palette for more than 8 categories
const CHART_COLORS_EXTENDED = [
  ...CHART_COLORS,
  '8B4513', // Saddle brown
  '4B0082', // Indigo
  '2F4F4F', // Dark slate gray
  'B22222', // Firebrick
];

// Semantic colors for specific meanings (opportunities, risks, etc.)
const SEMANTIC_COLORS = {
  positive: '2E7D32', // Green - opportunities, success
  negative: 'C62828', // Red - risks, failures
  warning: 'E46C0A', // Orange - warnings, caution
  neutral: '666666', // Gray - neutral information
  primary: '0066CC', // Blue - primary actions
  accent: '1F497D', // Navy - headers, emphasis
};

// Helper to merge historical and projected data into unified chart format
// Input: { historical: { 2020: { coal: 40, gas: 30 }, 2021: { coal: 38, gas: 32 } },
//          projected: { 2030: { coal: 20, gas: 40 }, 2040: { coal: 10, gas: 50 } } }
// Output: { categories: ['2020', '2021', '2030', '2040'], series: [...], projectedStartIndex: 2 }
function mergeHistoricalProjected(data, options = {}) {
  if (!data) return null;

  // If data is already in unified format, return it
  if (data.categories && data.series) {
    return data;
  }

  // Handle historical/projected format
  const historical = data.historical || {};
  const projected = data.projected || {};
  const allYears = [...Object.keys(historical), ...Object.keys(projected)].sort();

  if (allYears.length === 0) return null;

  // Identify all data series (e.g., coal, gas, renewable)
  const seriesNames = new Set();
  Object.values(historical).forEach((yearData) => {
    if (typeof yearData === 'object') {
      Object.keys(yearData).forEach((k) => seriesNames.add(k));
    }
  });
  Object.values(projected).forEach((yearData) => {
    if (typeof yearData === 'object') {
      Object.keys(yearData).forEach((k) => seriesNames.add(k));
    }
  });

  if (seriesNames.size === 0) return null;

  // Build series data
  const series = [];
  seriesNames.forEach((seriesName) => {
    const values = allYears.map((year) => {
      const yearData = historical[year] || projected[year] || {};
      return typeof yearData === 'object' ? yearData[seriesName] || 0 : 0;
    });
    series.push({ name: seriesName, values });
  });

  // Find where projections start
  const projectedStartIndex = Object.keys(historical).length;

  return {
    categories: allYears,
    series,
    projectedStartIndex, // For visual differentiation
    unit: data.unit || options.unit || '',
  };
}

// Add a stacked bar chart to a slide
// data format: { categories: ['2020', '2021', '2022'], series: [{ name: 'Coal', values: [40, 38, 35] }, { name: 'Gas', values: [30, 32, 35] }] }
// Also supports: { historical: {...}, projected: {...} } format which gets auto-converted
function addStackedBarChart(slide, title, data, options = {}) {
  // Try to convert historical/projected format
  let chartData = data;
  if (data && (data.historical || data.projected) && !data.categories) {
    chartData = mergeHistoricalProjected(data);
  }

  if (!chartData || !chartData.categories || !chartData.series || chartData.series.length === 0) {
    return; // Skip if no valid data
  }

  // Add visual indicator for projected data in title if applicable
  const hasProjections =
    chartData.projectedStartIndex && chartData.projectedStartIndex < chartData.categories.length;
  const chartTitle =
    hasProjections && !title.includes('Projected') ? `${title} (includes projections)` : title;

  const pptxChartData = chartData.series.map((s, idx) => ({
    name: s.name,
    labels: chartData.categories,
    values: s.values,
    color: CHART_COLORS[idx % CHART_COLORS.length],
  }));

  slide.addChart('bar', pptxChartData, {
    x: options.x || 0.5,
    y: options.y || 1.5,
    w: options.w || 9,
    h: options.h || 4.5,
    barDir: 'bar',
    barGrouping: 'stacked',
    showLegend: true,
    legendPos: 'b',
    showTitle: !!chartTitle,
    title: chartTitle,
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    catAxisLabelFontFace: 'Segoe UI',
    catAxisLabelFontSize: 10,
    valAxisLabelFontFace: 'Segoe UI',
    valAxisLabelFontSize: 10,
    // Data labels enabled by default for YCP-quality output
    showValue: options.showValues !== false, // Default to true
    dataLabelFontFace: 'Segoe UI',
    dataLabelFontSize: 9,
    dataLabelColor: 'FFFFFF', // White text on colored bars
    dataLabelPosition: 'ctr', // Center position
  });
}

// Add a line chart to a slide
// data format: { categories: ['2020', '2021', '2022'], series: [{ name: 'Price', values: [10, 12, 14] }] }
// Also supports: { historical: {...}, projected: {...} } format which gets auto-converted
function addLineChart(slide, title, data, options = {}) {
  // Try to convert historical/projected format
  let chartData = data;
  if (data && (data.historical || data.projected) && !data.categories) {
    chartData = mergeHistoricalProjected(data);
  }

  if (!chartData || !chartData.categories || !chartData.series || chartData.series.length === 0) {
    return; // Skip if no valid data
  }

  // Add visual indicator for projected data in title if applicable
  const hasProjections =
    chartData.projectedStartIndex && chartData.projectedStartIndex < chartData.categories.length;
  const chartTitle =
    hasProjections && !title.includes('Projected') ? `${title} (includes projections)` : title;

  const pptxChartData = chartData.series.map((s, idx) => ({
    name: s.name,
    labels: chartData.categories,
    values: s.values,
    color: CHART_COLORS[idx % CHART_COLORS.length],
  }));

  slide.addChart('line', pptxChartData, {
    x: options.x || 0.5,
    y: options.y || 1.5,
    w: options.w || 9,
    h: options.h || 4.5,
    showLegend: chartData.series.length > 1,
    legendPos: 'b',
    showTitle: !!chartTitle,
    title: chartTitle,
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    catAxisLabelFontFace: 'Segoe UI',
    catAxisLabelFontSize: 10,
    valAxisLabelFontFace: 'Segoe UI',
    valAxisLabelFontSize: 10,
    lineDataSymbol: 'circle',
    lineDataSymbolSize: 6,
    // Data labels for line charts
    showValue: options.showValues !== false, // Default to true
    dataLabelFontFace: 'Segoe UI',
    dataLabelFontSize: 9,
    dataLabelPosition: 't', // Position above the line points
  });
}

// Add a bar chart (horizontal or vertical) to a slide
function addBarChart(slide, title, data, options = {}) {
  if (!data || !data.categories || !data.values || data.values.length === 0) {
    return; // Skip if no valid data
  }

  const chartData = [
    {
      name: data.name || 'Value',
      labels: data.categories,
      values: data.values,
      color: CHART_COLORS[0],
    },
  ];

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
    dataLabelFontSize: 9,
  });
}

// Add a pie/doughnut chart to a slide
function addPieChart(slide, title, data, options = {}) {
  if (!data || !data.categories || !data.values || data.values.length === 0) {
    return; // Skip if no valid data
  }

  const chartData = [
    {
      name: data.name || 'Share',
      labels: data.categories,
      values: data.values,
    },
  ];

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
    chartColors: CHART_COLORS.slice(0, data.categories.length),
  });
}

// ============ STORY ARCHITECT ============
// Transforms raw research data into a narrative with key insights
// Returns a universal slide structure based on the story, not hardcoded slides
async function buildStoryNarrative(countryAnalysis, scope) {
  console.log('\n  [STORY ARCHITECT] Building narrative from research...');

  const systemPrompt = `You are a senior partner at McKinsey preparing a board presentation. Your job is to transform raw research into a compelling narrative that drives a decision.

=== STORYTELLING PRINCIPLES ===
1. LEAD WITH THE VERDICT: Executives want the answer first, then the reasoning.
2. EVERY SLIDE = ONE INSIGHT: Not "here's information about X" but "here's what X means for you"
3. CONNECT THE DOTS: Each slide should logically lead to the next
4. CUT RUTHLESSLY: If a fact doesn't support the decision, delete it. 8 great slides beat 25 mediocre ones.
5. QUANTIFY EVERYTHING: "Big market" → "$1.5B market growing 12% annually"

=== ASSERTIVE SLIDE TITLES (CRITICAL) ===
Generate conclusion-driven titles that tell the story, NOT descriptive labels.
BAD (descriptive): "Thailand - Market Size", "Vietnam - Energy Policy"
GOOD (assertive): "$50 billion total market, $5 billion addressable for client", "Electricity liberalization creates 18-month JV window"
Each title should be a conclusion the reader can act on, not a topic they need to read about.

=== INSIGHT QUALITY ===
BAD (information): "Thailand requires 50% local content for energy services"
GOOD (insight): "The 50% local content rule means you can't compete on cost alone—local partnerships aren't optional, they're your competitive moat"

BAD (list): "Key players include Schlumberger, Halliburton, Baker Hughes"
GOOD (insight): "The Big 3 dominate offshore, but none have cracked the industrial efficiency market—a $200M segment growing 15% annually"

=== SLIDE TYPES TO USE ===
1. VERDICT: Go/No-Go with conditions (always first after title)
2. OPPORTUNITY: Market size, growth, timing window
3. BARRIER: What makes this hard (regulatory, competitive, operational)
4. COMPETITIVE_LANDSCAPE: Who's winning, who's losing, white spaces
5. ENTRY_PATH: How to get in (JV, acquisition, greenfield)
6. ECONOMICS: Deal sizes, margins, investment required
7. RISKS: Top 3-5 risks with mitigations
8. ACTION: Specific next steps with timeline

Return 8-12 slides maximum. Quality over quantity.`;

  const prompt = `RESEARCH DATA:
${JSON.stringify(countryAnalysis, null, 2)}

CLIENT CONTEXT:
- Industry: ${scope.industry}
- Project Type: ${scope.projectType}
- Client: ${scope.clientContext || 'Not specified'}
- Target Market: ${scope.targetMarkets?.join(', ') || countryAnalysis.country}

Transform this research into a narrative. Return JSON:

{
  "storyHook": "One sentence that frames the entire presentation (e.g., 'The 2025 deadline changes everything')",

  "verdict": {
    "decision": "GO" | "CONDITIONAL_GO" | "NO_GO",
    "confidence": "HIGH" | "MEDIUM" | "LOW",
    "conditions": ["condition 1", "condition 2"],
    "oneLiner": "One sentence summary of recommendation"
  },

  "slides": [
    {
      "type": "VERDICT" | "OPPORTUNITY" | "BARRIER" | "COMPETITIVE_LANDSCAPE" | "ENTRY_PATH" | "ECONOMICS" | "RISKS" | "ACTION",
      "title": "ASSERTIVE title that states a conclusion (e.g. '$50B market, $5B addressable' NOT 'Market Size')",
      "insight": "The 'so what' - one sentence that makes this slide matter",
      "content": {
        // Type-specific content structure
        // For VERDICT: { decision, conditions, ratings: {attractiveness, feasibility} }
        // For OPPORTUNITY: { marketSize, growth, timingWindow, keyDrivers }
        // For BARRIER: { barriers: [{name, severity, mitigation}] }
        // For COMPETITIVE_LANDSCAPE: { leaders: [{name, strength, weakness}], whiteSpaces }
        // For ENTRY_PATH: { options: [{name, timeline, investment, pros, cons}], recommended }
        // For ECONOMICS: { dealSize, margins, investment, breakeven }
        // For RISKS: { risks: [{name, severity, likelihood, mitigation}] }
        // For ACTION: { steps: [{action, owner, timeline}] }
      },
      "sources": ["source URLs or names relevant to this slide"]
    }
  ],

  "aggregatedSources": [
    {"url": "actual URL", "title": "source name"}
  ]
}`;

  try {
    const response = await callDeepSeek(prompt, systemPrompt, 8192);

    // Parse response
    let story;
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        story = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('  [STORY ARCHITECT] Failed to parse response:', parseError.message);
      // Return minimal default structure
      return {
        storyHook: `${countryAnalysis.country} Market Entry Analysis`,
        verdict: {
          decision: 'CONDITIONAL_GO',
          confidence: 'MEDIUM',
          conditions: ['Further analysis required'],
          oneLiner: 'Proceed with caution',
        },
        slides: [],
        aggregatedSources: [],
      };
    }

    console.log(`  [STORY ARCHITECT] Generated ${story.slides?.length || 0} slides with narrative`);
    return story;
  } catch (error) {
    console.error('  [STORY ARCHITECT] Error:', error.message);
    return {
      storyHook: `${countryAnalysis.country} Market Entry Analysis`,
      verdict: { decision: 'CONDITIONAL_GO', confidence: 'LOW', conditions: [], oneLiner: '' },
      slides: [],
      aggregatedSources: [],
    };
  }
}

// ============ UNIVERSAL SLIDE GENERATOR ============
// Generates slides dynamically based on story narrative, not hardcoded structure
async function generateSingleCountryPPT(synthesis, countryAnalysis, scope) {
  console.log(`Generating expanded single-country PPT for ${synthesis.country}...`);

  const pptx = new pptxgen();

  // Set exact slide size to match YCP template (13.333" x 7.5" = 16:9 widescreen)
  pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
  pptx.layout = 'YCP';

  // YCP Theme Colors (from profile-slides template)
  const COLORS = {
    headerLine: '293F55', // Dark navy for header/footer lines
    accent3: '011AB7', // Dark blue - table header background
    accent1: '007FFF', // Bright blue - secondary/subtitle
    dk2: '1F497D', // Section underline/title color
    white: 'FFFFFF',
    black: '000000',
    gray: 'BFBFBF', // Border color
    footerText: '808080', // Gray footer text
    green: '2E7D32', // Positive/Opportunity
    orange: 'E46C0A', // Warning/Obstacle
    red: 'C62828', // Negative/Risk
  };

  // ===== DEFINE MASTER SLIDE WITH FIXED LINES (matching profile-slides) =====
  pptx.defineSlideMaster({
    title: 'YCP_MASTER',
    background: { color: 'FFFFFF' },
    objects: [
      // Thick header line (y: 1.02")
      { line: { x: 0, y: 1.02, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 4.5 } } },
      // Thin header line (y: 1.10")
      { line: { x: 0, y: 1.1, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } } },
      // Footer line (y: 7.24")
      { line: { x: 0, y: 7.24, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } } },
    ],
  });

  pptx.author = 'YCP Market Research';
  pptx.title = `${synthesis.country} - ${scope.industry} Market Analysis`;
  pptx.subject = scope.projectType;

  // Set default font to Segoe UI (YCP standard)
  pptx.theme = { headFontFace: 'Segoe UI', bodyFontFace: 'Segoe UI' };
  const FONT = 'Segoe UI';

  // Use countryAnalysis for detailed data (policy, market, competitors, etc.)
  // synthesis contains metadata like isSingleCountry, confidenceScore, etc.
  const policy = countryAnalysis.policy || {};
  const market = countryAnalysis.market || {};
  const competitors = countryAnalysis.competitors || {};
  const depth = countryAnalysis.depth || {};
  // Provide safe defaults for summary to prevent empty slides
  const rawSummary = countryAnalysis.summary || countryAnalysis.summaryAssessment || {};
  const summary = {
    timingIntelligence: rawSummary.timingIntelligence || {},
    lessonsLearned: rawSummary.lessonsLearned || {},
    opportunities: rawSummary.opportunities || [],
    obstacles: rawSummary.obstacles || [],
    ratings: rawSummary.ratings || { attractiveness: 0, feasibility: 0 },
    keyInsights: rawSummary.keyInsights || [],
    goNoGo: rawSummary.goNoGo || {},
    recommendation: rawSummary.recommendation || '',
  };
  const country = countryAnalysis.country || synthesis.country;

  // Debug: confirm data source
  console.log(`  [PPT] Using countryAnalysis data for ${country}`);
  console.log(`  [PPT] policy keys: ${Object.keys(policy).join(', ') || 'EMPTY'}`);
  console.log(`  [PPT] market keys: ${Object.keys(market).join(', ') || 'EMPTY'}`);
  console.log(`  [PPT] depth keys: ${Object.keys(depth).join(', ') || 'EMPTY'}`);
  console.log(`  [PPT] summary.goNoGo: ${summary.goNoGo ? 'present' : 'EMPTY'}`);

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
  // Uses widescreen dimensions (13.333" x 7.5" = 16:9)
  const CONTENT_WIDTH = 12.5; // Full content width for 16:9 widescreen
  const LEFT_MARGIN = 0.4; // Left margin matching YCP template

  // Options: { sources: [{url, title}], dataQuality: 'high'|'medium'|'low'|'estimated' }
  function addSlideWithTitle(title, subtitle = '', options = {}) {
    // Use master slide with fixed header/footer lines
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });

    // Title - 24pt Segoe UI, dark blue
    slide.addText(truncateTitle(title), {
      x: LEFT_MARGIN,
      y: 0.15,
      w: CONTENT_WIDTH,
      h: 0.7,
      fontSize: 24,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
      valign: 'top',
      wrap: true,
    });
    // Navy divider line under title
    slide.addShape('line', {
      x: LEFT_MARGIN,
      y: 0.9,
      w: CONTENT_WIDTH,
      h: 0,
      line: { color: COLORS.dk2, width: 2.5 },
    });
    // Message/subtitle - 14pt blue (the "so what" insight)
    if (subtitle) {
      const dataQualityIndicator =
        options.dataQuality === 'estimated' ? ' *' : options.dataQuality === 'low' ? ' †' : '';
      slide.addText(subtitle + dataQualityIndicator, {
        x: LEFT_MARGIN,
        y: 0.95,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 14,
        color: COLORS.accent1,
        fontFace: FONT,
      });
    }

    // Add data quality indicator if applicable
    if (options.dataQuality === 'estimated' || options.dataQuality === 'low') {
      const legend =
        options.dataQuality === 'estimated'
          ? '* Estimated data - verify independently'
          : '† Limited data availability';
      slide.addText(legend, {
        x: LEFT_MARGIN,
        y: 6.9,
        w: 4,
        h: 0.2,
        fontSize: 8,
        italic: true,
        color: 'E46C0A',
        fontFace: FONT,
      });
    }

    // Add clickable source citations in footer (supports both sources and citations)
    const sourcesToRender = options.sources || options.citations;
    if (sourcesToRender && sourcesToRender.length > 0) {
      const sourceElements = [];
      sourceElements.push({
        text: 'Sources: ',
        options: { fontSize: 8, fontFace: FONT, color: '666666' },
      });

      sourcesToRender.slice(0, 3).forEach((source, idx) => {
        if (idx > 0)
          sourceElements.push({
            text: ', ',
            options: { fontSize: 8, fontFace: FONT, color: '666666' },
          });

        // Handle both object format {url, title} and plain string URLs
        const sourceUrl = typeof source === 'object' ? source.url : source;
        const sourceTitle = typeof source === 'object' ? source.title : null;

        if (sourceUrl && sourceUrl.startsWith('http')) {
          // Extract domain for display
          let displayText;
          try {
            const url = new URL(sourceUrl);
            displayText = sourceTitle || url.hostname.replace('www.', '');
          } catch (e) {
            displayText = sourceTitle || truncate(sourceUrl, 30);
          }
          // Clickable hyperlink
          sourceElements.push({
            text: displayText,
            options: {
              fontSize: 8,
              fontFace: FONT,
              color: '0066CC',
              hyperlink: { url: sourceUrl },
            },
          });
        } else {
          // Plain text source
          sourceElements.push({
            text: sourceTitle || String(source),
            options: { fontSize: 8, fontFace: FONT, color: '666666' },
          });
        }
      });

      slide.addText(sourceElements, {
        x: LEFT_MARGIN + 4.5,
        y: 6.9,
        w: CONTENT_WIDTH - 4.5,
        h: 0.2,
        valign: 'top',
        align: 'right',
      });
    }

    return slide;
  }

  // Helper for table header row
  function tableHeader(cols) {
    return cols.map((text) => ({
      text,
      options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT },
    }));
  }

  // Helper to show "Data unavailable" message on slides with missing data
  function addDataUnavailableMessage(slide, message = 'Data not available for this section') {
    slide.addShape('rect', {
      x: LEFT_MARGIN,
      y: 2.5,
      w: CONTENT_WIDTH,
      h: 1.5,
      fill: { color: 'FFF8E1' }, // Light yellow warning background
      line: { color: 'E46C0A', pt: 1 },
    });
    slide.addText('⚠ ' + message, {
      x: LEFT_MARGIN + 0.2,
      y: 2.7,
      w: CONTENT_WIDTH - 0.4,
      h: 0.4,
      fontSize: 14,
      bold: true,
      color: 'E46C0A',
      fontFace: FONT,
    });
    slide.addText(
      'This data could not be verified through research. Please validate independently before making decisions.',
      {
        x: LEFT_MARGIN + 0.2,
        y: 3.2,
        w: CONTENT_WIDTH - 0.4,
        h: 0.6,
        fontSize: 11,
        color: '666666',
        fontFace: FONT,
      }
    );
  }

  // Helper to extract citations from raw research data for a specific topic category
  function getCitationsForCategory(category) {
    if (!countryAnalysis.rawData) return [];
    const citations = [];
    for (const [key, data] of Object.entries(countryAnalysis.rawData)) {
      if (key.startsWith(category) && data.citations && Array.isArray(data.citations)) {
        citations.push(...data.citations);
      }
    }
    // Deduplicate and limit to 5
    return [...new Set(citations)].slice(0, 5);
  }

  // Helper to get data quality for a category (returns lowest quality among topics)
  function getDataQualityForCategory(category) {
    if (!countryAnalysis.rawData) return 'unknown';
    const qualities = [];
    for (const [key, data] of Object.entries(countryAnalysis.rawData)) {
      if (key.startsWith(category) && data.dataQuality) {
        qualities.push(data.dataQuality);
      }
    }
    // Return worst quality level
    if (qualities.includes('estimated')) return 'estimated';
    if (qualities.includes('low')) return 'low';
    if (qualities.includes('medium')) return 'medium';
    if (qualities.includes('high')) return 'high';
    return 'unknown';
  }

  // ============ STORY ARCHITECT: BUILD NARRATIVE ============
  const story = await buildStoryNarrative(countryAnalysis, scope);

  // If Story Architect generated slides, use dynamic generation
  if (story.slides && story.slides.length > 0) {
    console.log(`  [PPT] Using Story Architect narrative (${story.slides.length} slides)`);

    // TITLE SLIDE
    const titleSlide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    titleSlide.addText(country.toUpperCase(), {
      x: 0.5,
      y: 2.2,
      w: 12,
      h: 0.8,
      fontSize: 42,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
    });
    titleSlide.addText(`${scope.industry} Market Analysis`, {
      x: 0.5,
      y: 3.0,
      w: 12,
      h: 0.5,
      fontSize: 24,
      color: COLORS.accent1,
      fontFace: FONT,
    });
    // Story hook as subtitle
    if (story.storyHook) {
      titleSlide.addText(story.storyHook, {
        x: 0.5,
        y: 3.6,
        w: 12,
        h: 0.5,
        fontSize: 16,
        italic: true,
        color: COLORS.black,
        fontFace: FONT,
      });
    }
    titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
      x: 0.5,
      y: 6.5,
      w: 9,
      h: 0.3,
      fontSize: 10,
      color: '666666',
      fontFace: FONT,
    });

    // DYNAMIC SLIDES FROM STORY
    for (const slideData of story.slides) {
      const slide = addSlideWithTitle(slideData.title || 'Analysis', slideData.insight || '', {
        sources: slideData.sources?.map((s) => (typeof s === 'string' ? { title: s } : s)) || [],
      });

      const content = slideData.content || {};
      const contentY = slideData.insight ? 1.55 : 1.2;

      switch (slideData.type) {
        case 'VERDICT': {
          // Verdict box
          const verdictColor =
            content.decision === 'GO'
              ? COLORS.green
              : content.decision === 'NO_GO'
                ? COLORS.red
                : COLORS.orange;
          slide.addShape('rect', {
            x: LEFT_MARGIN,
            y: contentY,
            w: CONTENT_WIDTH,
            h: 1.2,
            fill: { color: verdictColor },
            line: { color: verdictColor, pt: 0 },
          });
          slide.addText(`VERDICT: ${content.decision?.replace('_', ' ') || 'CONDITIONAL GO'}`, {
            x: LEFT_MARGIN + 0.2,
            y: contentY + 0.1,
            w: CONTENT_WIDTH - 0.4,
            h: 0.5,
            fontSize: 24,
            bold: true,
            color: COLORS.white,
            fontFace: FONT,
          });
          slide.addText(content.oneLiner || '', {
            x: LEFT_MARGIN + 0.2,
            y: contentY + 0.6,
            w: CONTENT_WIDTH - 0.4,
            h: 0.5,
            fontSize: 14,
            color: COLORS.white,
            fontFace: FONT,
          });

          // Conditions
          if (content.conditions && content.conditions.length > 0) {
            slide.addText('Conditions:', {
              x: LEFT_MARGIN,
              y: contentY + 1.4,
              w: CONTENT_WIDTH,
              h: 0.3,
              fontSize: 14,
              bold: true,
              color: COLORS.dk2,
              fontFace: FONT,
            });
            const conditionText = content.conditions.map((c, i) => `${i + 1}. ${c}`).join('\n');
            slide.addText(conditionText, {
              x: LEFT_MARGIN,
              y: contentY + 1.8,
              w: CONTENT_WIDTH,
              h: 2,
              fontSize: 12,
              color: COLORS.black,
              fontFace: FONT,
              valign: 'top',
            });
          }

          // Ratings
          if (content.ratings) {
            slide.addText(
              `Attractiveness: ${content.ratings.attractiveness || '?'}/10  |  Feasibility: ${content.ratings.feasibility || '?'}/10`,
              {
                x: LEFT_MARGIN,
                y: 5.5,
                w: CONTENT_WIDTH,
                h: 0.4,
                fontSize: 14,
                color: COLORS.accent1,
                fontFace: FONT,
              }
            );
          }
          break;
        }

        case 'OPPORTUNITY': {
          // Market metrics
          const metrics = [
            { label: 'Market Size', value: content.marketSize || 'N/A' },
            { label: 'Growth', value: content.growth || 'N/A' },
            { label: 'Timing Window', value: content.timingWindow || 'N/A' },
          ];
          metrics.forEach((m, i) => {
            slide.addText(m.label, {
              x: LEFT_MARGIN + i * 4.2,
              y: contentY,
              w: 4,
              h: 0.3,
              fontSize: 12,
              color: COLORS.footerText,
              fontFace: FONT,
            });
            slide.addText(m.value, {
              x: LEFT_MARGIN + i * 4.2,
              y: contentY + 0.35,
              w: 4,
              h: 0.6,
              fontSize: 18,
              bold: true,
              color: COLORS.dk2,
              fontFace: FONT,
            });
          });

          // Key drivers
          if (content.keyDrivers && content.keyDrivers.length > 0) {
            slide.addText('Key Drivers:', {
              x: LEFT_MARGIN,
              y: contentY + 1.5,
              w: CONTENT_WIDTH,
              h: 0.3,
              fontSize: 14,
              bold: true,
              color: COLORS.dk2,
              fontFace: FONT,
            });
            const driverText = content.keyDrivers.map((d) => `• ${d}`).join('\n');
            slide.addText(driverText, {
              x: LEFT_MARGIN,
              y: contentY + 1.9,
              w: CONTENT_WIDTH,
              h: 3,
              fontSize: 12,
              color: COLORS.black,
              fontFace: FONT,
              valign: 'top',
            });
          }
          break;
        }

        case 'BARRIER': {
          // Barriers table
          if (content.barriers && content.barriers.length > 0) {
            const rows = [tableHeader(['Barrier', 'Severity', 'Mitigation'])];
            content.barriers.forEach((b) => {
              rows.push([
                {
                  text: b.name || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: b.severity || '',
                  options: {
                    fontFace: FONT,
                    fontSize: 11,
                    color: b.severity === 'High' ? COLORS.red : COLORS.orange,
                  },
                },
                {
                  text: b.mitigation || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
              ]);
            });
            slide.addTable(rows, {
              x: LEFT_MARGIN,
              y: contentY,
              w: CONTENT_WIDTH,
              h: 4,
              fontFace: FONT,
              fontSize: 11,
              valign: 'middle',
              border: { pt: 0.5, color: COLORS.gray },
            });
          }
          break;
        }

        case 'COMPETITIVE_LANDSCAPE': {
          // Leaders table
          if (content.leaders && content.leaders.length > 0) {
            const rows = [tableHeader(['Company', 'Strength', 'Weakness'])];
            content.leaders.forEach((l) => {
              rows.push([
                {
                  text: l.name || '',
                  options: { fontFace: FONT, fontSize: 11, bold: true, color: COLORS.black },
                },
                {
                  text: l.strength || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.green },
                },
                {
                  text: l.weakness || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.red },
                },
              ]);
            });
            slide.addTable(rows, {
              x: LEFT_MARGIN,
              y: contentY,
              w: CONTENT_WIDTH,
              h: 3,
              fontFace: FONT,
              fontSize: 11,
              valign: 'middle',
              border: { pt: 0.5, color: COLORS.gray },
            });
          }

          // White spaces
          if (content.whiteSpaces && content.whiteSpaces.length > 0) {
            slide.addText('Market White Spaces:', {
              x: LEFT_MARGIN,
              y: contentY + 3.3,
              w: CONTENT_WIDTH,
              h: 0.3,
              fontSize: 14,
              bold: true,
              color: COLORS.green,
              fontFace: FONT,
            });
            const wsText = content.whiteSpaces.map((w) => `• ${w}`).join('\n');
            slide.addText(wsText, {
              x: LEFT_MARGIN,
              y: contentY + 3.7,
              w: CONTENT_WIDTH,
              h: 1.5,
              fontSize: 12,
              color: COLORS.black,
              fontFace: FONT,
              valign: 'top',
            });
          }
          break;
        }

        case 'ENTRY_PATH': {
          // Entry options comparison
          if (content.options && content.options.length > 0) {
            const rows = [tableHeader(['Option', 'Timeline', 'Investment', 'Key Considerations'])];
            content.options.forEach((o) => {
              const isRecommended = o.name === content.recommended;
              rows.push([
                {
                  text: (isRecommended ? '★ ' : '') + (o.name || ''),
                  options: {
                    fontFace: FONT,
                    fontSize: 11,
                    bold: isRecommended,
                    color: isRecommended ? COLORS.accent1 : COLORS.black,
                  },
                },
                {
                  text: o.timeline || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: o.investment || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: (o.pros || []).slice(0, 2).join('; '),
                  options: { fontFace: FONT, fontSize: 10, color: COLORS.black },
                },
              ]);
            });
            slide.addTable(rows, {
              x: LEFT_MARGIN,
              y: contentY,
              w: CONTENT_WIDTH,
              h: 4,
              fontFace: FONT,
              fontSize: 11,
              valign: 'middle',
              border: { pt: 0.5, color: COLORS.gray },
            });
          }

          if (content.recommended) {
            slide.addText(`Recommended: ${content.recommended}`, {
              x: LEFT_MARGIN,
              y: 5.5,
              w: CONTENT_WIDTH,
              h: 0.4,
              fontSize: 14,
              bold: true,
              color: COLORS.accent1,
              fontFace: FONT,
            });
          }
          break;
        }

        case 'ECONOMICS': {
          // Economics metrics
          const ecoMetrics = [
            { label: 'Typical Deal Size', value: content.dealSize || 'N/A' },
            { label: 'Investment Required', value: content.investment || 'N/A' },
            { label: 'Breakeven', value: content.breakeven || 'N/A' },
          ];
          ecoMetrics.forEach((m, i) => {
            slide.addText(m.label, {
              x: LEFT_MARGIN + i * 4.2,
              y: contentY,
              w: 4,
              h: 0.3,
              fontSize: 12,
              color: COLORS.footerText,
              fontFace: FONT,
            });
            slide.addText(m.value, {
              x: LEFT_MARGIN + i * 4.2,
              y: contentY + 0.35,
              w: 4,
              h: 0.6,
              fontSize: 16,
              bold: true,
              color: COLORS.dk2,
              fontFace: FONT,
            });
          });

          if (content.margins) {
            slide.addText(`Expected Margins: ${content.margins}`, {
              x: LEFT_MARGIN,
              y: contentY + 1.5,
              w: CONTENT_WIDTH,
              h: 0.4,
              fontSize: 14,
              color: COLORS.black,
              fontFace: FONT,
            });
          }
          break;
        }

        case 'RISKS': {
          // Risks table
          if (content.risks && content.risks.length > 0) {
            const rows = [tableHeader(['Risk', 'Severity', 'Likelihood', 'Mitigation'])];
            content.risks.forEach((r) => {
              const sevColor =
                r.severity === 'High'
                  ? COLORS.red
                  : r.severity === 'Medium'
                    ? COLORS.orange
                    : COLORS.green;
              rows.push([
                {
                  text: r.name || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: r.severity || '',
                  options: { fontFace: FONT, fontSize: 11, color: sevColor },
                },
                {
                  text: r.likelihood || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: r.mitigation || '',
                  options: { fontFace: FONT, fontSize: 10, color: COLORS.black },
                },
              ]);
            });
            slide.addTable(rows, {
              x: LEFT_MARGIN,
              y: contentY,
              w: CONTENT_WIDTH,
              h: 4.5,
              fontFace: FONT,
              fontSize: 11,
              valign: 'middle',
              border: { pt: 0.5, color: COLORS.gray },
            });
          }
          break;
        }

        case 'ACTION': {
          // Action steps
          if (content.steps && content.steps.length > 0) {
            const rows = [tableHeader(['Action', 'Owner', 'Timeline'])];
            content.steps.forEach((s, i) => {
              rows.push([
                {
                  text: `${i + 1}. ${s.action || ''}`,
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: s.owner || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: s.timeline || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.accent1 },
                },
              ]);
            });
            slide.addTable(rows, {
              x: LEFT_MARGIN,
              y: contentY,
              w: CONTENT_WIDTH,
              h: 4,
              fontFace: FONT,
              fontSize: 11,
              valign: 'middle',
              border: { pt: 0.5, color: COLORS.gray },
            });
          }
          break;
        }

        default: {
          // Generic content slide - render as bullet points
          const textContent =
            typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content.map((c) => `• ${c}`).join('\n')
                : JSON.stringify(content, null, 2);
          slide.addText(textContent, {
            x: LEFT_MARGIN,
            y: contentY,
            w: CONTENT_WIDTH,
            h: 5,
            fontSize: 12,
            color: COLORS.black,
            fontFace: FONT,
            valign: 'top',
          });
        }
      }
    }

    // Sources slide
    if (story.aggregatedSources && story.aggregatedSources.length > 0) {
      const sourcesSlide = addSlideWithTitle('Sources', 'Research citations and references');
      const sourceText = story.aggregatedSources
        .map((s, i) => `${i + 1}. ${s.title || s.url}`)
        .join('\n');
      sourcesSlide.addText(sourceText, {
        x: LEFT_MARGIN,
        y: 1.55,
        w: CONTENT_WIDTH,
        h: 5,
        fontSize: 10,
        color: COLORS.black,
        fontFace: FONT,
        valign: 'top',
      });
    }

    const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
    console.log(
      `Narrative PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB, ${story.slides.length + 2} slides`
    );
    return pptxBuffer;
  }

  // ============ FALLBACK: HARDCODED SLIDES (when Story Architect fails) ============
  console.log('  [PPT] Using fallback hardcoded slide structure');

  // ============ SLIDE 1: TITLE ============
  const titleSlide = pptx.addSlide({ masterName: 'YCP_MASTER' });
  titleSlide.addText(country.toUpperCase(), {
    x: 0.5,
    y: 2.2,
    w: 9,
    h: 0.8,
    fontSize: 42,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  titleSlide.addText(`${scope.industry} Market Analysis`, {
    x: 0.5,
    y: 3.0,
    w: 9,
    h: 0.5,
    fontSize: 24,
    color: COLORS.accent1,
    fontFace: FONT,
  });
  titleSlide.addText(`Deep Research Report`, {
    x: 0.5,
    y: 3.6,
    w: 9,
    h: 0.4,
    fontSize: 14,
    color: COLORS.black,
    fontFace: FONT,
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5,
    y: 6.5,
    w: 9,
    h: 0.3,
    fontSize: 10,
    color: '666666',
    fontFace: FONT,
  });

  // ============ SLIDE 2: TABLE OF CONTENTS ============
  const tocSlide = pptx.addSlide({ masterName: 'YCP_MASTER' });
  tocSlide.addText('Table of Contents', {
    x: LEFT_MARGIN,
    y: 0.15,
    w: CONTENT_WIDTH,
    h: 0.7,
    fontSize: 24,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  tocSlide.addShape('line', {
    x: LEFT_MARGIN,
    y: 0.9,
    w: CONTENT_WIDTH,
    h: 0,
    line: { color: COLORS.dk2, width: 2.5 },
  });

  // TOC sections with slide numbers
  const tocSections = [
    {
      section: '1. Policy & Regulations',
      slides: 'Foundational Acts, National Policy, Investment Restrictions',
      start: 4,
    },
    {
      section: '2. Market Overview',
      slides: 'Energy Supply, Demand, Electricity, Gas & LNG, Pricing, ESCO Market',
      start: 8,
    },
    {
      section: '3. Competitive Landscape',
      slides: 'Japanese Players, Local Players, Foreign Players, Case Studies',
      start: 15,
    },
    {
      section: '4. Strategic Analysis',
      slides: 'M&A Activity, Economics, Partner Assessment, Entry Strategy',
      start: 20,
    },
    {
      section: '5. Recommendations',
      slides: 'Implementation, Timing, Go/No-Go, Opportunities & Obstacles',
      start: 25,
    },
  ];

  tocSections.forEach((item, idx) => {
    const yPos = 1.4 + idx * 1.0;
    // Section title
    tocSlide.addText(item.section, {
      x: LEFT_MARGIN,
      y: yPos,
      w: 8,
      h: 0.4,
      fontSize: 16,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
    });
    // Section description
    tocSlide.addText(item.slides, {
      x: LEFT_MARGIN + 0.3,
      y: yPos + 0.4,
      w: 10,
      h: 0.35,
      fontSize: 11,
      color: '666666',
      fontFace: FONT,
    });
    // Slide number indicator
    tocSlide.addText(`Slide ${item.start}`, {
      x: 11,
      y: yPos,
      w: 1.9,
      h: 0.4,
      fontSize: 12,
      color: COLORS.accent1,
      fontFace: FONT,
      align: 'right',
    });
  });

  // ============ SECTION DIVIDER: POLICY & REGULATIONS ============
  addSectionDivider(pptx, 'Policy & Regulations', 1, 5, { COLORS });

  // ============ SECTION 1: POLICY & REGULATIONS (3 slides) ============

  // SLIDE 4: Foundational Acts
  const foundationalActs = policy.foundationalActs || {};
  console.log(
    `  [PPT Debug] foundationalActs keys: ${Object.keys(foundationalActs).join(', ') || 'EMPTY'}`
  );
  const actsSlide = addSlideWithTitle(
    foundationalActs.slideTitle || `${country} - Energy Foundational Acts`,
    truncateSubtitle(foundationalActs.subtitle || foundationalActs.keyMessage || '', 95),
    {
      citations: getCitationsForCategory('policy_'),
      dataQuality: getDataQualityForCategory('policy_'),
    }
  );
  const acts = safeArray(foundationalActs.acts, 5);
  console.log(`  [PPT Debug] acts array length: ${acts.length}`);
  if (acts.length > 0) {
    const actsRows = [tableHeader(['Act Name', 'Year', 'Requirements', 'Enforcement'])];
    acts.forEach((act) => {
      actsRows.push([
        { text: truncate(act.name || '', 25) },
        { text: act.year || '' },
        { text: truncate(act.requirements || '', 50) },
        { text: truncate(act.enforcement || '', 40) },
      ]);
    });
    actsSlide.addTable(actsRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: CONTENT_WIDTH,
      h: 4.0,
      fontSize: 12,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.2, 0.8, 3.3, 3.0],
      valign: 'top',
    });
    // Add client-specific insight callout
    addCalloutBox(
      actsSlide,
      `For ${scope.clientContext || 'Your Company'}:`,
      `Regulatory framework creates recurring ESCO demand in ${country}. Energy efficiency mandates drive industrial compliance spending.`,
      { x: LEFT_MARGIN, y: 5.5, w: CONTENT_WIDTH, h: 1.0, type: 'recommendation' }
    );
  } else {
    addDataUnavailableMessage(actsSlide, 'Energy legislation data not available');
  }

  // SLIDE 3: National Policy
  const nationalPolicy = policy.nationalPolicy || {};
  const policySlide = addSlideWithTitle(
    nationalPolicy.slideTitle || `${country} - National Energy Policy`,
    truncateSubtitle(nationalPolicy.policyDirection || '', 95),
    {
      citations: getCitationsForCategory('policy_'),
      dataQuality: getDataQualityForCategory('policy_'),
    }
  );
  const targets = safeArray(nationalPolicy.targets, 4);
  if (targets.length === 0 && safeArray(nationalPolicy.keyInitiatives, 4).length === 0) {
    addDataUnavailableMessage(policySlide, 'National policy data not available');
  }
  if (targets.length > 0) {
    const targetRows = [tableHeader(['Metric', 'Target', 'Deadline', 'Status'])];
    targets.forEach((t) => {
      targetRows.push([
        { text: t.metric || '' },
        { text: t.target || '' },
        { text: t.deadline || '' },
        { text: t.status || '' },
      ]);
    });
    policySlide.addTable(targetRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: CONTENT_WIDTH,
      h: 2.5,
      fontSize: 12,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [3.0, 2.3, 2.0, 2.0],
      valign: 'top',
    });
  }
  // Key initiatives as bullets
  const initiatives = safeArray(nationalPolicy.keyInitiatives, 4);
  if (initiatives.length > 0) {
    policySlide.addText('Key Initiatives', {
      x: LEFT_MARGIN,
      y: 4.0,
      w: CONTENT_WIDTH,
      h: 0.3,
      fontSize: 14,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
    });
    policySlide.addText(
      initiatives.map((i) => ({ text: truncate(i, 100), options: { bullet: true } })),
      {
        x: LEFT_MARGIN,
        y: 4.4,
        w: CONTENT_WIDTH,
        h: 1.5,
        fontSize: 12,
        fontFace: FONT,
        color: COLORS.black,
        valign: 'top',
      }
    );
    // Add strategic callout for policy slide
    addCalloutBox(
      policySlide,
      'Strategic Implication',
      `National policy direction creates investment window. Align entry timing with government incentive programs.`,
      { x: LEFT_MARGIN, y: 6.0, w: CONTENT_WIDTH, h: 0.9, type: 'insight' }
    );
  }

  // SLIDE 4: Investment Restrictions
  const investRestrict = policy.investmentRestrictions || {};
  const investSlide = addSlideWithTitle(
    investRestrict.slideTitle || `${country} - Foreign Investment Rules`,
    truncateSubtitle(investRestrict.riskJustification || '', 95),
    {
      citations: getCitationsForCategory('policy_'),
      dataQuality: getDataQualityForCategory('policy_'),
    }
  );
  // Ownership limits
  const ownership = investRestrict.ownershipLimits || {};
  const ownershipRows = [tableHeader(['Category', 'Limit', 'Details'])];
  if (ownership.general)
    ownershipRows.push([
      { text: 'General Sectors' },
      { text: ownership.general },
      { text: truncate(ownership.exceptions || '', 60) },
    ]);
  if (ownership.promoted)
    ownershipRows.push([
      { text: 'BOI Promoted' },
      { text: ownership.promoted },
      { text: 'Tax incentives apply' },
    ]);
  if (ownershipRows.length > 1) {
    investSlide.addTable(ownershipRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: CONTENT_WIDTH,
      h: 1.5,
      fontSize: 12,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.5, 1.5, 5.3],
      valign: 'top',
    });
  }
  // Incentives
  const incentivesList = safeArray(investRestrict.incentives, 3);
  if (incentivesList.length > 0) {
    const incRows = [tableHeader(['Incentive', 'Benefit', 'Eligibility'])];
    incentivesList.forEach((inc) => {
      incRows.push([
        { text: inc.name || '' },
        { text: inc.benefit || '' },
        { text: truncate(inc.eligibility || '', 50) },
      ]);
    });
    investSlide.addTable(incRows, {
      x: LEFT_MARGIN,
      y: 3.0,
      w: CONTENT_WIDTH,
      h: 2.0,
      fontSize: 12,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.5, 2.5, 4.3],
      valign: 'top',
    });
  }
  // Risk level indicator
  if (investRestrict.riskLevel) {
    const riskColor = investRestrict.riskLevel.toLowerCase().includes('high')
      ? COLORS.red
      : investRestrict.riskLevel.toLowerCase().includes('low')
        ? COLORS.green
        : COLORS.orange;
    investSlide.addText(`Regulatory Risk: ${investRestrict.riskLevel.toUpperCase()}`, {
      x: LEFT_MARGIN,
      y: 5.5,
      w: CONTENT_WIDTH,
      h: 0.4,
      fontSize: 14,
      bold: true,
      color: riskColor,
      fontFace: FONT,
    });
  }

  // ============ SECTION DIVIDER: MARKET OVERVIEW ============
  addSectionDivider(pptx, 'Market Overview', 2, 5, { COLORS });

  // ============ SECTION 2: MARKET DATA (6 slides with charts) ============
  const marketCitations = getCitationsForCategory('market_');
  const marketDataQuality = getDataQualityForCategory('market_');

  // SLIDE 8: TPES
  const tpes = market.tpes || {};
  const tpesSlide = addSlideWithTitle(
    tpes.slideTitle || `${country} - Total Primary Energy Supply`,
    truncateSubtitle(tpes.keyInsight || tpes.subtitle || '', 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );
  if (tpes.chartData && tpes.chartData.series) {
    // Resize chart to make room for insights panel
    addStackedBarChart(
      tpesSlide,
      `TPES by Source (${tpes.chartData.unit || 'Mtoe'})`,
      tpes.chartData,
      { x: LEFT_MARGIN, y: 1.3, w: 8.8, h: 4.0 }
    );
    // Add insights panel with key data points
    const tpesInsights = [];
    if (tpes.structuredData?.marketBreakdown?.totalPrimaryEnergySupply) {
      const breakdown = tpes.structuredData.marketBreakdown.totalPrimaryEnergySupply;
      if (breakdown.naturalGasPercent)
        tpesInsights.push(`Natural Gas: ${breakdown.naturalGasPercent}`);
      if (breakdown.renewablePercent) tpesInsights.push(`Renewable: ${breakdown.renewablePercent}`);
    }
    if (tpes.keyInsight) tpesInsights.push(tpes.keyInsight);
    if (tpes.narrative) tpesInsights.push(truncate(tpes.narrative, 100));
    addInsightsPanel(tpesSlide, tpesInsights.slice(0, 4), { x: 9.5, y: 1.3, w: 3.4, h: 4.0 });
    // Add energy transition opportunity callout
    addCalloutBox(
      tpesSlide,
      'Energy Transition Opportunity',
      `${country} energy mix shifting from coal to gas/renewables. First-mover advantage in industrial efficiency consulting.`,
      { x: LEFT_MARGIN, y: 5.5, w: 8.8, h: 1.0, type: 'insight' }
    );
  } else {
    addDataUnavailableMessage(tpesSlide, 'Energy supply data not available');
  }

  // SLIDE 9: Final Energy Demand
  const finalDemand = market.finalDemand || {};
  const demandSlide = addSlideWithTitle(
    finalDemand.slideTitle || `${country} - Final Energy Demand`,
    truncateSubtitle(finalDemand.growthRate || finalDemand.subtitle || '', 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );
  if (finalDemand.chartData && finalDemand.chartData.series) {
    // Resize chart to make room for insights panel
    addStackedBarChart(
      demandSlide,
      `Demand by Sector (${finalDemand.chartData.unit || '%'})`,
      finalDemand.chartData,
      { x: LEFT_MARGIN, y: 1.3, w: 8.8, h: 4.0 }
    );
    // Add insights panel
    const demandInsights = [];
    if (finalDemand.structuredData?.marketBreakdown?.totalFinalConsumption) {
      const consumption = finalDemand.structuredData.marketBreakdown.totalFinalConsumption;
      if (consumption.industryPercent)
        demandInsights.push(`Industry: ${consumption.industryPercent}`);
      if (consumption.transportPercent)
        demandInsights.push(`Transport: ${consumption.transportPercent}`);
    }
    if (finalDemand.keyInsight) demandInsights.push(finalDemand.keyInsight);
    // Add key drivers as insights
    safeArray(finalDemand.keyDrivers, 2).forEach((d) => demandInsights.push(truncate(d, 80)));
    addInsightsPanel(demandSlide, demandInsights.slice(0, 4), { x: 9.5, y: 1.3, w: 3.4, h: 4.0 });
    // Add supply gap quantification callout
    addCalloutBox(
      demandSlide,
      `For ${scope.clientContext || 'Your Company'}:`,
      `Industrial demand growth creates unfulfilled capacity needs. Every MW deployed serves real demand.`,
      { x: LEFT_MARGIN, y: 5.5, w: 8.8, h: 1.0, type: 'recommendation' }
    );
  } else if (safeArray(finalDemand.keyDrivers, 3).length === 0) {
    addDataUnavailableMessage(demandSlide, 'Energy demand data not available');
  } else {
    // Key drivers as bullets when no chart data
    const drivers = safeArray(finalDemand.keyDrivers, 4);
    if (drivers.length > 0) {
      demandSlide.addText(
        drivers.map((d) => ({ text: truncate(d, 100), options: { bullet: true } })),
        {
          x: LEFT_MARGIN,
          y: 1.5,
          w: CONTENT_WIDTH,
          h: 4.5,
          fontSize: 12,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
    }
  }

  // SLIDE 10: Electricity & Power
  const electricity = market.electricity || {};
  const elecSlide = addSlideWithTitle(
    electricity.slideTitle || `${country} - Electricity & Power`,
    truncateSubtitle(electricity.totalCapacity || electricity.subtitle || '', 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );
  if (electricity.chartData && electricity.chartData.values) {
    addPieChart(
      elecSlide,
      `Power Generation Mix (${electricity.chartData.unit || '%'})`,
      electricity.chartData,
      { x: LEFT_MARGIN, y: 1.3, w: 5.5, h: 4.5 }
    );
    // Build dynamic insights from available data
    const elecInsights = [];
    if (electricity.demandGrowth) elecInsights.push(`Demand Growth: ${electricity.demandGrowth}`);
    if (electricity.totalCapacity) elecInsights.push(`Capacity: ${electricity.totalCapacity}`);
    if (electricity.keyTrend) elecInsights.push(truncate(electricity.keyTrend, 100));
    if (electricity.structuredData?.marketBreakdown?.electricityGeneration) {
      const gen = electricity.structuredData.marketBreakdown.electricityGeneration;
      if (gen.current) elecInsights.push(`Current: ${gen.current}`);
      if (gen.projected2030) elecInsights.push(`2030 Target: ${gen.projected2030}`);
    }
    if (electricity.keyInsight) elecInsights.push(electricity.keyInsight);
    addInsightsPanel(elecSlide, elecInsights.slice(0, 4), { x: 6.2, y: 1.3, w: 6.5, h: 4.5 });
    // Add private sector opportunity callout
    addCalloutBox(
      elecSlide,
      'Private Sector Needed',
      `State utility cannot meet demand alone. IPP and captive power opportunities exist for foreign entrants.`,
      { x: LEFT_MARGIN, y: 6.0, w: 5.5, h: 0.9, type: 'insight' }
    );
  } else if (!electricity.demandGrowth && !electricity.keyTrend) {
    addDataUnavailableMessage(elecSlide, 'Electricity market data not available');
  } else {
    // Fallback: show available text data as bullets
    const elecBullets = [];
    if (electricity.demandGrowth) elecBullets.push(`Demand Growth: ${electricity.demandGrowth}`);
    if (electricity.keyTrend) elecBullets.push(`Key Trend: ${truncate(electricity.keyTrend, 100)}`);
    if (elecBullets.length > 0) {
      elecSlide.addText(
        elecBullets.map((b) => ({ text: b, options: { bullet: true } })),
        {
          x: LEFT_MARGIN,
          y: 1.5,
          w: CONTENT_WIDTH,
          h: 4,
          fontSize: 12,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
    }
  }

  // SLIDE 11: Gas & LNG
  const gasLng = market.gasLng || {};
  const gasSlide = addSlideWithTitle(
    gasLng.slideTitle || `${country} - Gas & LNG Market`,
    truncateSubtitle(gasLng.pipelineNetwork || gasLng.subtitle || '', 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );

  // Build dynamic insights for gas/LNG
  const gasInsights = [];
  if (gasLng.structuredData?.infrastructureCapacity) {
    const infra = gasLng.structuredData.infrastructureCapacity;
    if (infra.lngImportCurrent) gasInsights.push(`LNG Import: ${infra.lngImportCurrent}`);
    if (infra.lngImportPlanned) gasInsights.push(`Planned: ${infra.lngImportPlanned}`);
    if (infra.pipelineCapacity) gasInsights.push(`Pipeline: ${infra.pipelineCapacity}`);
  }
  if (gasLng.pipelineNetwork) gasInsights.push(truncate(gasLng.pipelineNetwork, 80));
  if (gasLng.keyInsight) gasInsights.push(gasLng.keyInsight);

  if (gasLng.chartData && gasLng.chartData.series) {
    addLineChart(
      gasSlide,
      `Gas Supply Trend (${gasLng.chartData.unit || 'bcm'})`,
      gasLng.chartData,
      { x: LEFT_MARGIN, y: 1.3, w: 8.8, h: 3.2 }
    );
    addInsightsPanel(gasSlide, gasInsights.slice(0, 4), { x: 9.5, y: 1.3, w: 3.4, h: 3.2 });
    // Add LNG opportunity callout
    addCalloutBox(
      gasSlide,
      `LNG Opportunity for ${scope.clientContext || 'Your Company'}:`,
      `LNG import gap and infrastructure expansion create supply partnership opportunities.`,
      { x: LEFT_MARGIN, y: 4.7, w: 8.8, h: 0.8, type: 'recommendation' }
    );
  } else if (safeArray(gasLng.lngTerminals, 3).length === 0 && gasInsights.length === 0) {
    addDataUnavailableMessage(gasSlide, 'Gas/LNG market data not available');
  }

  // LNG terminals table
  const terminals = safeArray(gasLng.lngTerminals, 4);
  if (terminals.length > 0) {
    const termRows = [tableHeader(['Terminal', 'Capacity', 'Utilization'])];
    terminals.forEach((t) => {
      termRows.push([
        { text: truncate(t.name || '', 30) },
        { text: t.capacity || '' },
        { text: t.utilization || '' },
      ]);
    });
    // Use dynamic column widths
    const termColWidths = calculateColumnWidths(termRows, CONTENT_WIDTH);
    gasSlide.addTable(termRows, {
      x: LEFT_MARGIN,
      y: 5.7,
      w: CONTENT_WIDTH,
      h: 1.2,
      fontSize: 11,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: termColWidths.length > 0 ? termColWidths : [4.0, 4.25, 4.25],
      valign: 'top',
    });
  }

  // SLIDE 12: Energy Pricing
  const pricing = market.pricing || {};
  const priceSlide = addSlideWithTitle(
    pricing.slideTitle || `${country} - Energy Pricing`,
    truncateSubtitle(pricing.outlook || pricing.subtitle || '', 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );

  // Build dynamic insights for pricing
  const priceInsights = [];
  if (pricing.structuredData?.priceComparison) {
    const prices = pricing.structuredData.priceComparison;
    if (prices.generationCost) priceInsights.push(`Generation: ${prices.generationCost}`);
    if (prices.retailPrice) priceInsights.push(`Retail: ${prices.retailPrice}`);
    if (prices.industrialRate) priceInsights.push(`Industrial: ${prices.industrialRate}`);
  }
  if (pricing.outlook) priceInsights.push(truncate(pricing.outlook, 80));
  if (pricing.comparison) priceInsights.push(truncate(`Regional: ${pricing.comparison}`, 80));
  if (pricing.keyInsight) priceInsights.push(pricing.keyInsight);

  if (pricing.chartData && pricing.chartData.series) {
    addLineChart(priceSlide, 'Energy Price Trends', pricing.chartData, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: 8.8,
      h: 4.5,
    });
    addInsightsPanel(priceSlide, priceInsights.slice(0, 4), { x: 9.5, y: 1.3, w: 3.4, h: 4.5 });
    // Add ESCO payback calculation callout
    addCalloutBox(
      priceSlide,
      'ESCO Payback Calculation',
      `Peak-shaving opportunity: Price spread between peak/off-peak enables demand response projects with 3-5 year payback.`,
      { x: LEFT_MARGIN, y: 6.0, w: 8.8, h: 0.9, type: 'insight' }
    );
  } else if (!pricing.comparison && priceInsights.length === 0) {
    addDataUnavailableMessage(priceSlide, 'Energy pricing data not available');
  } else {
    // Fallback: show insights as callout box when no chart
    if (priceInsights.length > 0) {
      addCalloutBox(priceSlide, 'Price Analysis', priceInsights.slice(0, 3).join(' | '), {
        x: LEFT_MARGIN,
        y: 1.5,
        w: CONTENT_WIDTH,
        h: 2,
        type: 'insight',
      });
    }
  }

  // SLIDE 13: ESCO Market
  const escoMarket = market.escoMarket || {};
  const escoSlide = addSlideWithTitle(
    escoMarket.slideTitle || `${country} - ESCO Market`,
    truncateSubtitle(`${escoMarket.marketSize || ''} | ${escoMarket.growthRate || ''}`, 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );

  // Build dynamic insights for ESCO market
  const escoInsights = [];
  if (escoMarket.marketSize) escoInsights.push(`Market Size: ${escoMarket.marketSize}`);
  if (escoMarket.growthRate) escoInsights.push(`Growth: ${escoMarket.growthRate}`);
  if (escoMarket.structuredData?.escoMarketState) {
    const state = escoMarket.structuredData.escoMarketState;
    if (state.registeredESCOs) escoInsights.push(`Registered ESCOs: ${state.registeredESCOs}`);
    if (state.totalProjects) escoInsights.push(`Total Projects: ${state.totalProjects}`);
  }
  if (escoMarket.keyDrivers) escoInsights.push(truncate(escoMarket.keyDrivers, 80));
  if (escoMarket.keyInsight) escoInsights.push(escoMarket.keyInsight);

  if (escoMarket.chartData && escoMarket.chartData.values) {
    addBarChart(
      escoSlide,
      `Market Segments (${escoMarket.chartData.unit || '%'})`,
      escoMarket.chartData,
      { x: LEFT_MARGIN, y: 1.3, w: 8.5, h: 3.3 }
    );
    addInsightsPanel(escoSlide, escoInsights.slice(0, 4), { x: 9.3, y: 1.3, w: 3.6, h: 3.3 });
  } else if (safeArray(escoMarket.segments, 4).length === 0 && escoInsights.length === 0) {
    addDataUnavailableMessage(escoSlide, 'ESCO market data not available');
  } else if (escoInsights.length > 0) {
    // Show insights as callout when no chart
    addCalloutBox(escoSlide, 'Market Overview', escoInsights.slice(0, 3).join(' • '), {
      x: LEFT_MARGIN,
      y: 1.5,
      w: CONTENT_WIDTH,
      h: 1.5,
      type: 'insight',
    });
  }

  // Segments table with dynamic column widths
  const segments = safeArray(escoMarket.segments, 4);
  if (segments.length > 0) {
    const segRows = [tableHeader(['Segment', 'Size', 'Share'])];
    segments.forEach((s) => {
      segRows.push([{ text: s.name || '' }, { text: s.size || '' }, { text: s.share || '' }]);
    });
    const segColWidths = calculateColumnWidths(segRows, CONTENT_WIDTH);
    escoSlide.addTable(segRows, {
      x: LEFT_MARGIN,
      y: escoMarket.chartData ? 4.8 : 3.2,
      w: CONTENT_WIDTH,
      h: 1.8,
      fontSize: 11,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: segColWidths.length > 0 ? segColWidths : [4.0, 2.65, 2.65],
      valign: 'top',
    });
  }

  // ============ SECTION DIVIDER: COMPETITIVE LANDSCAPE ============
  addSectionDivider(pptx, 'Competitive Landscape', 3, 5, { COLORS });

  // ============ SECTION 3: COMPETITOR OVERVIEW (5 slides) ============
  const competitorCitations = getCitationsForCategory('competitors_');
  const competitorDataQuality = getDataQualityForCategory('competitors_');

  // SLIDE 15: Japanese Players
  const japanesePlayers = competitors.japanesePlayers || {};
  const jpSlide = addSlideWithTitle(
    japanesePlayers.slideTitle || `${country} - Japanese Energy Companies`,
    truncateSubtitle(japanesePlayers.marketInsight || japanesePlayers.subtitle || '', 95),
    { citations: competitorCitations, dataQuality: competitorDataQuality }
  );
  const jpPlayers = safeArray(japanesePlayers.players, 5);

  // Build dynamic insights for Japanese players
  const jpInsights = [];
  if (japanesePlayers.structuredData?.japanesePlayers?.competitiveLandscape) {
    jpInsights.push(
      truncate(japanesePlayers.structuredData.japanesePlayers.competitiveLandscape, 100)
    );
  }
  if (japanesePlayers.marketInsight) jpInsights.push(truncate(japanesePlayers.marketInsight, 80));
  if (jpPlayers.length > 0) {
    jpInsights.push(`${jpPlayers.length} Japanese players identified`);
    // Add assessments as insights
    jpPlayers.slice(0, 2).forEach((p) => {
      if (p.assessment) jpInsights.push(`${p.name}: ${p.assessment}`);
    });
  }

  if (jpPlayers.length === 0) {
    addDataUnavailableMessage(jpSlide, 'Japanese competitor data not available');
  } else {
    const jpRows = [tableHeader(['Company', 'Presence', 'Description'])];
    jpPlayers.forEach((p) => {
      const nameCell = p.website
        ? { text: p.name || '', options: { hyperlink: { url: p.website }, color: '0066CC' } }
        : { text: p.name || '' };
      const desc = p.description || p.projects || p.assessment || '';
      jpRows.push([
        nameCell,
        { text: truncate(p.presence || '', 30) },
        { text: truncate(desc, 80) },
      ]);
    });
    // Use dynamic column widths
    const jpColWidths = calculateColumnWidths(jpRows, jpInsights.length > 0 ? 9.0 : CONTENT_WIDTH);
    jpSlide.addTable(jpRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: jpInsights.length > 0 ? 9.0 : CONTENT_WIDTH,
      h: 4.7,
      fontSize: 11,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: jpColWidths.length > 0 ? jpColWidths : [2.0, 2.0, 5.0],
      valign: 'top',
    });
    // Add insights panel if we have insights
    if (jpInsights.length > 0) {
      addInsightsPanel(jpSlide, jpInsights.slice(0, 4), { x: 9.5, y: 1.3, w: 3.4 });
    }
    // Add competitive gap callout
    addCalloutBox(
      jpSlide,
      `Your Gap: Where ${scope.clientContext || 'Your Company'} Can Win`,
      `Industrial steam/efficiency segment has 0% Japanese share. Technical expertise match creates first-mover opportunity.`,
      { x: LEFT_MARGIN, y: 6.2, w: CONTENT_WIDTH, h: 0.8, type: 'recommendation' }
    );
  }

  // SLIDE 16: Local Major Players
  const localMajor = competitors.localMajor || {};
  const localSlide = addSlideWithTitle(
    localMajor.slideTitle || `${country} - Major Local Players`,
    truncateSubtitle(localMajor.concentration || localMajor.subtitle || '', 95),
    { citations: competitorCitations, dataQuality: competitorDataQuality }
  );
  const localPlayers = safeArray(localMajor.players, 5);

  // Build dynamic insights for local players
  const localInsights = [];
  if (localMajor.concentration) localInsights.push(truncate(localMajor.concentration, 80));
  if (localMajor.structuredData?.localPlayers?.marketConcentration) {
    localInsights.push(
      `Concentration: ${localMajor.structuredData.localPlayers.marketConcentration}`
    );
  }
  if (localPlayers.length > 0) {
    localInsights.push(`${localPlayers.length} major local players`);
    // Highlight top player
    const topPlayer = localPlayers[0];
    if (topPlayer.marketShare)
      localInsights.push(`Leader: ${topPlayer.name} (${topPlayer.marketShare})`);
  }

  if (localPlayers.length === 0) {
    addDataUnavailableMessage(localSlide, 'Local competitor data not available');
  } else {
    const localRows = [tableHeader(['Company', 'Type', 'Revenue', 'Description'])];
    localPlayers.forEach((p) => {
      const nameCell = p.website
        ? { text: p.name || '', options: { hyperlink: { url: p.website }, color: '0066CC' } }
        : { text: p.name || '' };
      const desc = p.description || `${p.strengths || ''} ${p.weaknesses || ''}`.trim() || '';
      localRows.push([
        nameCell,
        { text: p.type || '' },
        { text: p.revenue || '' },
        { text: truncate(desc, 80) },
      ]);
    });
    // Use dynamic column widths
    const localColWidths = calculateColumnWidths(
      localRows,
      localInsights.length > 0 ? 9.0 : CONTENT_WIDTH
    );
    localSlide.addTable(localRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: localInsights.length > 0 ? 9.0 : CONTENT_WIDTH,
      h: 4.7,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: localColWidths.length > 0 ? localColWidths : [2.0, 1.5, 1.5, 4.3],
      valign: 'top',
    });
    // Add insights panel if we have insights
    if (localInsights.length > 0) {
      addInsightsPanel(localSlide, localInsights.slice(0, 4), { x: 9.5, y: 1.3, w: 3.4 });
    }
  }

  // SLIDE 17: Foreign Players
  const foreignPlayers = competitors.foreignPlayers || {};
  const foreignSlide = addSlideWithTitle(
    foreignPlayers.slideTitle || `${country} - Foreign Energy Companies`,
    truncateSubtitle(foreignPlayers.competitiveInsight || foreignPlayers.subtitle || '', 95),
    { citations: competitorCitations, dataQuality: competitorDataQuality }
  );
  const foreignList = safeArray(foreignPlayers.players, 5);

  // Build dynamic insights for foreign players
  const foreignInsights = [];
  if (foreignPlayers.competitiveInsight)
    foreignInsights.push(truncate(foreignPlayers.competitiveInsight, 80));
  if (foreignPlayers.structuredData?.foreignPlayers?.entryPatterns) {
    foreignInsights.push(truncate(foreignPlayers.structuredData.foreignPlayers.entryPatterns, 80));
  }
  if (foreignList.length > 0) {
    foreignInsights.push(`${foreignList.length} foreign players identified`);
    // Group by origin country
    const origins = [...new Set(foreignList.map((p) => p.origin).filter(Boolean))];
    if (origins.length > 0) foreignInsights.push(`Origins: ${origins.slice(0, 3).join(', ')}`);
  }

  if (foreignList.length === 0) {
    addDataUnavailableMessage(foreignSlide, 'Foreign competitor data not available');
  } else {
    const foreignRows = [tableHeader(['Company', 'Origin', 'Mode', 'Description'])];
    foreignList.forEach((p) => {
      const nameCell = p.website
        ? { text: p.name || '', options: { hyperlink: { url: p.website }, color: '0066CC' } }
        : { text: p.name || '' };
      const desc =
        p.description ||
        `${p.entryYear ? `Entered ${p.entryYear}. ` : ''}${p.success || ''} ${p.projects || ''}`.trim() ||
        '';
      foreignRows.push([
        nameCell,
        { text: p.origin || '' },
        { text: p.mode || '' },
        { text: truncate(desc, 80) },
      ]);
    });
    // Use dynamic column widths
    const foreignColWidths = calculateColumnWidths(
      foreignRows,
      foreignInsights.length > 0 ? 9.0 : CONTENT_WIDTH
    );
    foreignSlide.addTable(foreignRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: foreignInsights.length > 0 ? 9.0 : CONTENT_WIDTH,
      h: 4.7,
      fontSize: 11,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: foreignColWidths.length > 0 ? foreignColWidths : [2.0, 1.5, 1.5, 4.3],
      valign: 'top',
    });
    // Add insights panel if we have insights
    if (foreignInsights.length > 0) {
      addInsightsPanel(foreignSlide, foreignInsights.slice(0, 4), { x: 9.5, y: 1.3, w: 3.4 });
    }
  }

  // SLIDE 18: Case Study
  const caseStudy = competitors.caseStudy || {};
  const caseSlide = addSlideWithTitle(
    caseStudy.slideTitle || `${country} - Market Entry Case Study`,
    truncateSubtitle(caseStudy.applicability || caseStudy.subtitle || '', 95),
    { citations: competitorCitations, dataQuality: competitorDataQuality }
  );
  if (!caseStudy.company && safeArray(caseStudy.keyLessons, 4).length === 0) {
    addDataUnavailableMessage(caseSlide, 'Case study data not available');
  }

  // Case study details as structured table (left side)
  const caseRows = [
    [
      {
        text: 'Company',
        options: { bold: true, fill: { color: COLORS.dk2 || '1F497D' }, color: 'FFFFFF' },
      },
      { text: caseStudy.company || 'N/A' },
    ],
    [
      {
        text: 'Entry Year',
        options: { bold: true, fill: { color: COLORS.dk2 || '1F497D' }, color: 'FFFFFF' },
      },
      { text: caseStudy.entryYear || 'N/A' },
    ],
    [
      {
        text: 'Entry Mode',
        options: { bold: true, fill: { color: COLORS.dk2 || '1F497D' }, color: 'FFFFFF' },
      },
      { text: caseStudy.entryMode || 'N/A' },
    ],
    [
      {
        text: 'Investment',
        options: { bold: true, fill: { color: COLORS.dk2 || '1F497D' }, color: 'FFFFFF' },
      },
      { text: caseStudy.investment || 'N/A' },
    ],
    [
      {
        text: 'Outcome',
        options: { bold: true, fill: { color: COLORS.dk2 || '1F497D' }, color: 'FFFFFF' },
      },
      { text: truncate(caseStudy.outcome || 'N/A', 60) },
    ],
  ];
  caseSlide.addTable(caseRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 6.0,
    h: 3.0,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [1.8, 4.2],
    valign: 'middle',
  });

  // Key lessons as callout box (right side)
  const lessons = safeArray(caseStudy.keyLessons, 4);
  if (lessons.length > 0) {
    addCalloutBox(caseSlide, 'Key Lessons', lessons.map((l) => `• ${truncate(l, 70)}`).join('\n'), {
      x: 6.5,
      y: 1.3,
      w: 6.3,
      h: 4.5,
      type: 'recommendation',
    });
  }

  // Applicability note at bottom
  if (caseStudy.applicability) {
    caseSlide.addText(`Applicability: ${truncate(caseStudy.applicability, 150)}`, {
      x: LEFT_MARGIN,
      y: 5.8,
      w: CONTENT_WIDTH,
      h: 0.5,
      fontSize: 11,
      italic: true,
      fontFace: FONT,
      color: COLORS.gray || '666666',
    });
  }

  // ============ SECTION DIVIDER: STRATEGIC ANALYSIS ============
  addSectionDivider(pptx, 'Strategic Analysis', 4, 5, { COLORS });

  // SLIDE 19: M&A Activity
  const maActivity = competitors.maActivity || {};
  const maSlide = addSlideWithTitle(
    maActivity.slideTitle || `${country} - M&A Activity`,
    truncateSubtitle(maActivity.valuationMultiples || maActivity.subtitle || '', 95)
  );

  // Build dynamic insights for M&A activity
  const maInsights = [];
  if (maActivity.valuationMultiples) maInsights.push(`Multiples: ${maActivity.valuationMultiples}`);
  if (maActivity.structuredData?.maActivity?.dealVolume) {
    maInsights.push(`Deal Volume: ${maActivity.structuredData.maActivity.dealVolume}`);
  }
  const deals = safeArray(maActivity.recentDeals, 3);
  const potentialTargets = safeArray(maActivity.potentialTargets, 3);
  if (deals.length > 0) maInsights.push(`${deals.length} recent deals identified`);
  if (potentialTargets.length > 0) maInsights.push(`${potentialTargets.length} potential targets`);

  // Check if we have any data
  if (deals.length === 0 && potentialTargets.length === 0) {
    addDataUnavailableMessage(maSlide, 'M&A activity data not available');
  }

  // Recent deals table
  if (deals.length > 0) {
    maSlide.addText('Recent Transactions', {
      x: LEFT_MARGIN,
      y: 1.3,
      w: 8.5,
      h: 0.3,
      fontSize: 12,
      bold: true,
      color: COLORS.dk2 || '1F497D',
      fontFace: FONT,
    });
    const dealRows = [tableHeader(['Year', 'Buyer', 'Target', 'Value', 'Rationale'])];
    deals.forEach((d) => {
      dealRows.push([
        { text: d.year || '' },
        { text: d.buyer || '' },
        { text: d.target || '' },
        { text: d.value || '' },
        { text: truncate(d.rationale || '', 30) },
      ]);
    });
    // Use dynamic column widths
    const dealColWidths = calculateColumnWidths(
      dealRows,
      maInsights.length > 0 ? 8.5 : CONTENT_WIDTH
    );
    maSlide.addTable(dealRows, {
      x: LEFT_MARGIN,
      y: 1.65,
      w: maInsights.length > 0 ? 8.5 : CONTENT_WIDTH,
      h: 1.8,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: dealColWidths.length > 0 ? dealColWidths : [0.8, 1.8, 1.8, 1.5, 3.4],
      valign: 'top',
    });
  }

  // Potential targets table
  if (potentialTargets.length > 0) {
    const targetYPos = deals.length > 0 ? 3.7 : 1.3;
    maSlide.addText('Potential Acquisition Targets', {
      x: LEFT_MARGIN,
      y: targetYPos,
      w: 8.5,
      h: 0.3,
      fontSize: 12,
      bold: true,
      color: COLORS.dk2 || '1F497D',
      fontFace: FONT,
    });
    const targetRows = [tableHeader(['Company', 'Est. Value', 'Rationale', 'Timing'])];
    potentialTargets.forEach((t) => {
      targetRows.push([
        { text: t.name || '' },
        { text: t.estimatedValue || '' },
        { text: truncate(t.rationale || '', 40) },
        { text: t.timing || '' },
      ]);
    });
    // Use dynamic column widths
    const targetColWidths = calculateColumnWidths(
      targetRows,
      maInsights.length > 0 ? 8.5 : CONTENT_WIDTH
    );
    maSlide.addTable(targetRows, {
      x: LEFT_MARGIN,
      y: targetYPos + 0.35,
      w: maInsights.length > 0 ? 8.5 : CONTENT_WIDTH,
      h: 1.8,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: targetColWidths.length > 0 ? targetColWidths : [2.0, 1.5, 4.0, 1.8],
      valign: 'top',
    });
  }

  // Add insights panel if we have insights
  if (maInsights.length > 0) {
    addInsightsPanel(maSlide, maInsights.slice(0, 4), { x: 9.0, y: 1.3, w: 3.8 });
  }

  // ============ SECTION 4: DEPTH ANALYSIS (5 slides) ============
  const depthCitations = getCitationsForCategory('depth_');
  const depthDataQuality = getDataQualityForCategory('depth_');

  // SLIDE 20: ESCO Deal Economics
  const escoEcon = depth.escoEconomics || {};
  const econSlide = addSlideWithTitle(
    escoEcon.slideTitle || `${country} - ESCO Deal Economics`,
    truncateSubtitle(escoEcon.keyInsight || escoEcon.subtitle || '', 95),
    { citations: depthCitations, dataQuality: depthDataQuality }
  );

  // Build dynamic insights for ESCO economics
  const econInsights = [];
  const dealSize = escoEcon.typicalDealSize || {};
  const terms = escoEcon.contractTerms || {};
  const financials = escoEcon.financials || {};
  if (dealSize.average) econInsights.push(`Avg Deal: ${dealSize.average}`);
  if (financials.irr) econInsights.push(`Expected IRR: ${financials.irr}`);
  if (financials.paybackPeriod) econInsights.push(`Payback: ${financials.paybackPeriod}`);
  if (terms.duration) econInsights.push(`Contract: ${terms.duration}`);
  if (escoEcon.keyInsight) econInsights.push(truncate(escoEcon.keyInsight, 80));

  // Build table
  const econRows = [tableHeader(['Metric', 'Value', 'Notes'])];
  if (dealSize.average)
    econRows.push([
      { text: 'Typical Deal Size' },
      { text: `${dealSize.min || ''} - ${dealSize.max || ''}` },
      { text: `Avg: ${dealSize.average}` },
    ]);
  if (terms.duration)
    econRows.push([{ text: 'Contract Duration' }, { text: terms.duration }, { text: '' }]);
  if (terms.savingsSplit)
    econRows.push([
      { text: 'Savings Split' },
      { text: terms.savingsSplit },
      { text: terms.guaranteeStructure || '' },
    ]);
  if (financials.paybackPeriod)
    econRows.push([{ text: 'Payback Period' }, { text: financials.paybackPeriod }, { text: '' }]);
  if (financials.irr)
    econRows.push([{ text: 'Expected IRR' }, { text: financials.irr }, { text: '' }]);
  if (financials.marginProfile)
    econRows.push([{ text: 'Gross Margin' }, { text: financials.marginProfile }, { text: '' }]);

  const financing = safeArray(escoEcon.financingOptions, 3);
  if (econRows.length === 1 && financing.length === 0) {
    addDataUnavailableMessage(econSlide, 'ESCO economics data not available');
  }
  if (econRows.length > 1) {
    // Use dynamic column widths
    const econColWidths = calculateColumnWidths(
      econRows,
      econInsights.length > 0 ? 8.5 : CONTENT_WIDTH
    );
    econSlide.addTable(econRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: econInsights.length > 0 ? 8.5 : CONTENT_WIDTH,
      h: financing.length > 0 ? 3.5 : 4.5,
      fontSize: 12,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: econColWidths.length > 0 ? econColWidths : [2.5, 3.0, 3.8],
      valign: 'top',
    });
    // Add insights panel
    if (econInsights.length > 0) {
      addInsightsPanel(econSlide, econInsights.slice(0, 4), { x: 9.0, y: 1.3, w: 3.8, h: 3.5 });
    }
  }

  // Financing options as callout box
  if (financing.length > 0) {
    addCalloutBox(
      econSlide,
      'Financing Options',
      financing.map((f) => `• ${truncate(f, 60)}`).join('\n'),
      {
        x: LEFT_MARGIN,
        y: 5.0,
        w: econInsights.length > 0 ? 8.5 : CONTENT_WIDTH,
        h: 1.5,
        type: 'insight',
      }
    );
  }

  // SLIDE 21: Partner Assessment
  const partnerAssess = depth.partnerAssessment || {};
  const partnerSlide = addSlideWithTitle(
    partnerAssess.slideTitle || `${country} - Partner Assessment`,
    truncateSubtitle(partnerAssess.recommendedPartner || partnerAssess.subtitle || '', 95),
    { citations: depthCitations, dataQuality: depthDataQuality }
  );
  const partners = safeArray(partnerAssess.partners, 5);

  // Build dynamic insights for partner assessment
  const partnerInsights = [];
  if (partnerAssess.recommendedPartner)
    partnerInsights.push(`Top Pick: ${partnerAssess.recommendedPartner}`);
  if (partners.length > 0) {
    partnerInsights.push(`${partners.length} potential partners`);
    // Find best partnership and acquisition fits
    const bestPartnership = partners.reduce(
      (best, p) => (!best || (p.partnershipFit || 0) > (best.partnershipFit || 0) ? p : best),
      null
    );
    const bestAcquisition = partners.reduce(
      (best, p) => (!best || (p.acquisitionFit || 0) > (best.acquisitionFit || 0) ? p : best),
      null
    );
    if (bestPartnership?.name && bestPartnership?.partnershipFit) {
      partnerInsights.push(
        `Best JV Fit: ${bestPartnership.name} (${bestPartnership.partnershipFit}/5)`
      );
    }
    if (bestAcquisition?.name && bestAcquisition?.acquisitionFit) {
      partnerInsights.push(
        `Best M&A Fit: ${bestAcquisition.name} (${bestAcquisition.acquisitionFit}/5)`
      );
    }
  }

  if (partners.length === 0) {
    addDataUnavailableMessage(partnerSlide, 'Partner assessment data not available');
  } else {
    const partnerRows = [
      tableHeader([
        'Company',
        'Type',
        'Revenue',
        'Partnership Fit',
        'Acquisition Fit',
        'Est. Value',
      ]),
    ];
    partners.forEach((p) => {
      const nameCell = p.website
        ? {
            text: truncate(p.name || '', 20),
            options: { hyperlink: { url: p.website }, color: '0066CC' },
          }
        : { text: truncate(p.name || '', 20) };
      partnerRows.push([
        nameCell,
        { text: truncate(p.type || '', 15) },
        { text: p.revenue || '' },
        { text: p.partnershipFit ? `${p.partnershipFit}/5` : '' },
        { text: p.acquisitionFit ? `${p.acquisitionFit}/5` : '' },
        { text: p.estimatedValuation || '' },
      ]);
    });
    // Use dynamic column widths
    const partnerColWidths = calculateColumnWidths(
      partnerRows,
      partnerInsights.length > 0 ? 9.0 : CONTENT_WIDTH
    );
    partnerSlide.addTable(partnerRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: partnerInsights.length > 0 ? 9.0 : CONTENT_WIDTH,
      h: 4.7,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: partnerColWidths.length > 0 ? partnerColWidths : [1.8, 1.5, 1.3, 1.3, 1.3, 2.1],
      valign: 'top',
    });
    // Add insights panel
    if (partnerInsights.length > 0) {
      addInsightsPanel(partnerSlide, partnerInsights.slice(0, 4), { x: 9.5, y: 1.3, w: 3.3 });
    }
  }

  // SLIDE 22: Entry Strategy Options with Harvey Balls
  const entryStrat = depth.entryStrategy || {};
  const entrySlide = addSlideWithTitle(
    entryStrat.slideTitle || `${country} - Entry Strategy Options`,
    truncateSubtitle(entryStrat.recommendation || entryStrat.subtitle || '', 95),
    { citations: depthCitations, dataQuality: depthDataQuality }
  );
  const options = safeArray(entryStrat.options, 3);

  // Build dynamic insights for entry strategy
  const stratInsights = [];
  if (entryStrat.recommendation)
    stratInsights.push(`Recommended: ${truncate(entryStrat.recommendation, 60)}`);
  if (options.length > 0) {
    stratInsights.push(`${options.length} entry options analyzed`);
    // Highlight lowest risk and fastest options
    const lowestRisk = options.find((o) => o.riskLevel?.toLowerCase().includes('low'));
    const fastest = options.find((o) => o.timeline?.includes('12') || o.timeline?.includes('6'));
    if (lowestRisk) stratInsights.push(`Low Risk: ${lowestRisk.mode}`);
    if (fastest) stratInsights.push(`Fastest: ${fastest.mode} (${fastest.timeline})`);
  }

  if (options.length === 0) {
    addDataUnavailableMessage(entrySlide, 'Entry strategy analysis not available');
  } else {
    const optRows = [
      tableHeader(['Option', 'Timeline', 'Investment', 'Control', 'Risk', 'Key Pros']),
    ];
    options.forEach((opt) => {
      optRows.push([
        { text: opt.mode || '' },
        { text: opt.timeline || '' },
        { text: opt.investment || '' },
        { text: opt.controlLevel || '' },
        { text: opt.riskLevel || '' },
        { text: truncate((opt.pros || []).join('; '), 40) },
      ]);
    });
    // Use dynamic column widths
    const optColWidths = calculateColumnWidths(
      optRows,
      stratInsights.length > 0 ? 9.0 : CONTENT_WIDTH
    );
    entrySlide.addTable(optRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: stratInsights.length > 0 ? 9.0 : CONTENT_WIDTH,
      h: 2.5,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: optColWidths.length > 0 ? optColWidths : [1.3, 1.2, 1.3, 1.3, 1.0, 3.2],
      valign: 'top',
    });
    // Add insights panel
    if (stratInsights.length > 0) {
      addInsightsPanel(entrySlide, stratInsights.slice(0, 4), { x: 9.5, y: 1.3, w: 3.3, h: 2.5 });
    }
    // Add specific recommendation callout
    addCalloutBox(
      entrySlide,
      'Specific Recommendation',
      `JV with local ESCO targeting industrial customers. Timeline: 6-12 months to first project. Investment: $10-30M.`,
      { x: LEFT_MARGIN, y: 3.9, w: 9.0, h: 0.8, type: 'recommendation' }
    );
  }

  // Harvey Balls comparison (if available)
  const harvey = entryStrat.harveyBalls || {};
  if (harvey.criteria && Array.isArray(harvey.criteria) && harvey.criteria.length > 0) {
    entrySlide.addText('Comparison Matrix (1-5 scale)', {
      x: LEFT_MARGIN,
      y: 4.9,
      w: CONTENT_WIDTH,
      h: 0.3,
      fontSize: 12,
      bold: true,
      color: COLORS.dk2 || '1F497D',
      fontFace: FONT,
    });
    // Safe Harvey Ball renderer - handles missing/invalid values
    const renderHarvey = (arr, idx) => {
      if (!Array.isArray(arr) || idx >= arr.length) return '';
      const val = Math.max(0, Math.min(5, parseInt(arr[idx]) || 0));
      return '●'.repeat(val) + '○'.repeat(5 - val);
    };
    const harveyRows = [tableHeader(['Criteria', 'Joint Venture', 'Acquisition', 'Greenfield'])];
    harvey.criteria.forEach((crit, idx) => {
      harveyRows.push([
        { text: String(crit || '') },
        { text: renderHarvey(harvey.jv, idx) },
        { text: renderHarvey(harvey.acquisition, idx) },
        { text: renderHarvey(harvey.greenfield, idx) },
      ]);
    });
    // Use dynamic column widths
    const harveyColWidths = calculateColumnWidths(harveyRows, CONTENT_WIDTH);
    entrySlide.addTable(harveyRows, {
      x: LEFT_MARGIN,
      y: 5.3,
      w: CONTENT_WIDTH,
      h: 1.6,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: harveyColWidths.length > 0 ? harveyColWidths : [2.5, 2.3, 2.25, 2.25],
      valign: 'middle',
    });
  }

  // SLIDE 19: Implementation Roadmap
  const impl = depth.implementation || {};
  const implSlide = addSlideWithTitle(
    impl.slideTitle || `${country} - Implementation Roadmap`,
    truncateSubtitle(
      `Total: ${impl.totalInvestment || 'TBD'} | Breakeven: ${impl.breakeven || 'TBD'}`,
      95
    )
  );
  const phases = safeArray(impl.phases, 3);
  let phaseX = 0.35;
  const phaseWidth = 3.0;
  phases.forEach((phase, idx) => {
    // Phase header box
    const phaseColor = idx === 0 ? COLORS.accent1 : idx === 1 ? COLORS.green : COLORS.orange;
    implSlide.addText(phase.name || `Phase ${idx + 1}`, {
      x: phaseX,
      y: 1.3,
      w: phaseWidth,
      h: 0.4,
      fontSize: 11,
      bold: true,
      color: COLORS.white,
      fill: { color: phaseColor },
      fontFace: FONT,
      align: 'center',
      valign: 'middle',
    });
    // Activities
    const activities = safeArray(phase.activities, 4);
    if (activities.length > 0) {
      implSlide.addText(
        activities.map((a) => ({ text: truncate(a, 35), options: { bullet: true } })),
        {
          x: phaseX,
          y: 1.8,
          w: phaseWidth,
          h: 2.5,
          fontSize: 9,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
    }
    // Milestones
    const milestones = safeArray(phase.milestones, 2);
    if (milestones.length > 0) {
      implSlide.addText(`Milestones: ${milestones.map((m) => truncate(m, 25)).join(', ')}`, {
        x: phaseX,
        y: 4.4,
        w: phaseWidth,
        h: 0.5,
        fontSize: 8,
        fontFace: FONT,
        color: COLORS.footerText,
        valign: 'top',
      });
    }
    // Investment
    if (phase.investment) {
      implSlide.addText(`Investment: ${phase.investment}`, {
        x: phaseX,
        y: 4.9,
        w: phaseWidth,
        h: 0.3,
        fontSize: 9,
        bold: true,
        fontFace: FONT,
        color: COLORS.dk2,
        valign: 'top',
      });
    }
    phaseX += phaseWidth + 0.15;
  });

  // SLIDE 24: Target Customer Segments
  const targetSeg = depth.targetSegments || {};
  const targetSlide = addSlideWithTitle(
    targetSeg.slideTitle || `${country} - Target Customer Segments`,
    truncateSubtitle(targetSeg.goToMarketApproach || targetSeg.subtitle || '', 95)
  );
  const segmentsList = safeArray(targetSeg.segments, 4);

  // Build dynamic insights for target segments
  const segInsights = [];
  if (targetSeg.goToMarketApproach) segInsights.push(truncate(targetSeg.goToMarketApproach, 80));
  if (segmentsList.length > 0) {
    segInsights.push(`${segmentsList.length} target segments identified`);
    // Find highest priority segment
    const highPriority = segmentsList.find((s) => s.priority >= 4);
    if (highPriority) segInsights.push(`Top Priority: ${highPriority.name}`);
  }

  if (segmentsList.length > 0) {
    const segmentRows = [
      tableHeader(['Segment', 'Size', 'Energy Intensity', 'Decision Maker', 'Priority']),
    ];
    segmentsList.forEach((s) => {
      segmentRows.push([
        { text: s.name || '' },
        { text: truncate(s.size || '', 25) },
        { text: s.energyIntensity || '' },
        { text: truncate(s.decisionMaker || '', 20) },
        { text: s.priority ? `${s.priority}/5` : '' },
      ]);
    });
    // Use dynamic column widths
    const segColWidths = calculateColumnWidths(
      segmentRows,
      segInsights.length > 0 ? 9.0 : CONTENT_WIDTH
    );
    targetSlide.addTable(segmentRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: segInsights.length > 0 ? 9.0 : CONTENT_WIDTH,
      h: 2.5,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: segColWidths.length > 0 ? segColWidths : [2.0, 2.3, 1.5, 2.0, 1.5],
      valign: 'top',
    });
    // Add insights panel
    if (segInsights.length > 0) {
      addInsightsPanel(targetSlide, segInsights.slice(0, 4), { x: 9.5, y: 1.3, w: 3.3, h: 2.5 });
    }
  }

  // Top targets
  const topTargets = safeArray(targetSeg.topTargets, 3);
  if (topTargets.length > 0) {
    targetSlide.addText('Priority Target Companies', {
      x: LEFT_MARGIN,
      y: 4.0,
      w: segInsights.length > 0 ? 9.0 : CONTENT_WIDTH,
      h: 0.3,
      fontSize: 12,
      bold: true,
      color: COLORS.dk2 || '1F497D',
      fontFace: FONT,
    });
    const targetCompRows = [tableHeader(['Company', 'Industry', 'Energy Spend', 'Location'])];
    topTargets.forEach((t) => {
      const nameCell = t.website
        ? { text: t.company || '', options: { hyperlink: { url: t.website }, color: '0066CC' } }
        : { text: t.company || '' };
      targetCompRows.push([
        nameCell,
        { text: t.industry || '' },
        { text: t.energySpend || '' },
        { text: t.location || '' },
      ]);
    });
    // Use dynamic column widths
    const targetColWidths = calculateColumnWidths(
      targetCompRows,
      segInsights.length > 0 ? 9.0 : CONTENT_WIDTH
    );
    targetSlide.addTable(targetCompRows, {
      x: LEFT_MARGIN,
      y: 4.4,
      w: segInsights.length > 0 ? 9.0 : CONTENT_WIDTH,
      h: 1.8,
      fontSize: 9,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: targetColWidths.length > 0 ? targetColWidths : [2.5, 2.3, 2.25, 2.25],
      valign: 'top',
    });
  }

  // ============ SECTION 5: TIMING & LESSONS (2 slides) ============

  // SLIDE 25: Why Now? - Timing Intelligence
  const timing = summary.timingIntelligence || {};
  const timingSlide = addSlideWithTitle(
    timing.slideTitle || `${country} - Why Now?`,
    truncateSubtitle(timing.windowOfOpportunity || 'Time-sensitive factors driving urgency', 95)
  );
  const triggers = safeArray(timing.triggers, 4);

  // Build dynamic insights for timing
  const timingInsights = [];
  if (triggers.length > 0) timingInsights.push(`${triggers.length} market triggers identified`);
  if (timing.urgency) timingInsights.push(`Urgency: ${timing.urgency}`);
  if (timing.windowOfOpportunity) timingInsights.push(truncate(timing.windowOfOpportunity, 80));

  if (triggers.length > 0) {
    const triggerRows = [tableHeader(['Trigger', 'Impact', 'Action Required'])];
    triggers.forEach((t) => {
      triggerRows.push([
        { text: truncate(t.trigger || '', 35) },
        { text: truncate(t.impact || '', 30) },
        { text: truncate(t.action || '', 30) },
      ]);
    });
    // Use dynamic column widths
    const triggerColWidths = calculateColumnWidths(
      triggerRows,
      timingInsights.length > 0 ? 9.0 : CONTENT_WIDTH
    );
    timingSlide.addTable(triggerRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: timingInsights.length > 0 ? 9.0 : CONTENT_WIDTH,
      h: 3.0,
      fontSize: 11,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: triggerColWidths.length > 0 ? triggerColWidths : [3.5, 2.9, 2.9],
      valign: 'top',
    });
    // Add insights panel
    if (timingInsights.length > 0) {
      addInsightsPanel(timingSlide, timingInsights.slice(0, 4), { x: 9.5, y: 1.3, w: 3.3, h: 3.0 });
    }
  }
  // Window callout
  if (timing.windowOfOpportunity) {
    addCalloutBox(timingSlide, 'WINDOW OF OPPORTUNITY', timing.windowOfOpportunity, {
      x: LEFT_MARGIN,
      y: triggers.length > 0 ? 4.5 : 1.5,
      w: CONTENT_WIDTH,
      h: 1.2,
      type: 'recommendation',
    });
  }

  // SLIDE 22: Lessons from Market
  const lessonsData = summary.lessonsLearned || {};
  const lessonsSlide = addSlideWithTitle(
    lessonsData.slideTitle || `${country} - Lessons from Market`,
    truncateSubtitle(lessonsData.subtitle || 'What previous entrants learned', 95)
  );
  const failures = safeArray(lessonsData.failures, 3);
  if (failures.length > 0) {
    lessonsSlide.addText('FAILURES TO AVOID', {
      x: LEFT_MARGIN,
      y: 1.3,
      w: 4.5,
      h: 0.3,
      fontSize: 12,
      bold: true,
      color: COLORS.red,
      fontFace: FONT,
    });
    const failureRows = [tableHeader(['Company', 'Reason', 'Lesson'])];
    failures.forEach((f) => {
      failureRows.push([
        { text: `${f.company || ''} (${f.year || ''})` },
        { text: truncate(f.reason || '', 35) },
        { text: truncate(f.lesson || '', 35) },
      ]);
    });
    lessonsSlide.addTable(failureRows, {
      x: LEFT_MARGIN,
      y: 1.7,
      w: CONTENT_WIDTH,
      h: 2.0,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.2, 3.5, 3.6],
      valign: 'top',
    });
  }
  // Success factors
  const successFactors = safeArray(lessonsData.successFactors, 3);
  if (successFactors.length > 0) {
    lessonsSlide.addText('SUCCESS FACTORS', {
      x: LEFT_MARGIN,
      y: 4.0,
      w: 4.5,
      h: 0.3,
      fontSize: 12,
      bold: true,
      color: COLORS.green,
      fontFace: FONT,
    });
    lessonsSlide.addText(
      successFactors.map((s) => ({ text: truncate(s, 60), options: { bullet: true } })),
      {
        x: LEFT_MARGIN,
        y: 4.4,
        w: 4.5,
        h: 1.5,
        fontSize: 10,
        fontFace: FONT,
        color: COLORS.black,
        valign: 'top',
      }
    );
  }
  // Warning signs
  const warningsData = safeArray(lessonsData.warningSignsToWatch, 3);
  if (warningsData.length > 0) {
    lessonsSlide.addText('WARNING SIGNS', {
      x: 5.0,
      y: 4.0,
      w: 4.5,
      h: 0.3,
      fontSize: 12,
      bold: true,
      color: COLORS.orange,
      fontFace: FONT,
    });
    lessonsSlide.addText(
      warningsData.map((w) => ({ text: truncate(w, 50), options: { bullet: true } })),
      {
        x: 5.0,
        y: 4.4,
        w: 4.65,
        h: 1.5,
        fontSize: 10,
        fontFace: FONT,
        color: COLORS.black,
        valign: 'top',
      }
    );
  }

  // ============ SECTION DIVIDER: RECOMMENDATIONS ============
  addSectionDivider(pptx, 'Recommendations', 5, 5, { COLORS });

  // ============ SECTION 6: SUMMARY (5 slides) ============

  // SLIDE 25: Go/No-Go Decision
  const goNoGo = summary.goNoGo || {};
  const goNoGoSlide = addSlideWithTitle(
    `${country} - Go/No-Go Assessment`,
    truncateSubtitle(goNoGo.overallVerdict || 'Investment Decision Framework', 95)
  );
  const goNoGoCriteria = safeArray(goNoGo.criteria, 6);
  if (goNoGoCriteria.length > 0) {
    const goNoGoRows = [tableHeader(['Criterion', 'Status', 'Evidence'])];
    goNoGoCriteria.forEach((c) => {
      const statusIcon = c.met === true ? '✓' : c.met === false ? '✗' : '?';
      const statusColor =
        c.met === true ? COLORS.green : c.met === false ? COLORS.red : COLORS.orange;
      goNoGoRows.push([
        { text: truncate(c.criterion || '', 40) },
        { text: statusIcon, options: { color: statusColor, bold: true, align: 'center' } },
        { text: truncate(c.evidence || '', 50) },
      ]);
    });
    goNoGoSlide.addTable(goNoGoRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: CONTENT_WIDTH,
      h: 3.5,
      fontSize: 11,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [3.0, 0.8, 5.5],
      valign: 'top',
    });
  }
  // Verdict box
  const verdictColor =
    goNoGo.overallVerdict?.includes('GO') && !goNoGo.overallVerdict?.includes('NO')
      ? COLORS.green
      : goNoGo.overallVerdict?.includes('NO')
        ? COLORS.red
        : COLORS.orange;
  goNoGoSlide.addText(`VERDICT: ${goNoGo.overallVerdict || 'CONDITIONAL'}`, {
    x: LEFT_MARGIN,
    y: 5.0,
    w: 4.0,
    h: 0.5,
    fontSize: 16,
    bold: true,
    color: COLORS.white,
    fill: { color: verdictColor },
    fontFace: FONT,
    align: 'center',
    valign: 'middle',
  });
  // Conditions (if any)
  const conditions = safeArray(goNoGo.conditions, 3);
  if (conditions.length > 0) {
    goNoGoSlide.addText('Conditions to proceed:', {
      x: 4.5,
      y: 5.0,
      w: 5.15,
      h: 0.3,
      fontSize: 11,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
    });
    goNoGoSlide.addText(
      conditions.map((c) => ({ text: truncate(c, 60), options: { bullet: true } })),
      {
        x: 4.5,
        y: 5.35,
        w: 5.15,
        h: 0.6,
        fontSize: 10,
        fontFace: FONT,
        color: COLORS.black,
        valign: 'top',
      }
    );
  }
  // Add decision callout
  addCalloutBox(
    goNoGoSlide,
    `Decision Required for ${scope.clientContext || 'Your Company'}`,
    `Approve ${country} entry by end of quarter. Key success factors: Speed to market, right partner structure.`,
    { x: LEFT_MARGIN, y: 6.0, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
  );

  // SLIDE 26: Opportunities & Obstacles (using enhanced helper)
  const ooSlide = addSlideWithTitle(
    `${country} - Opportunities & Obstacles`,
    truncateSubtitle(summary.recommendation || '', 95)
  );

  // Prepare opportunities data (handle both string and object formats)
  const opportunitiesRaw = safeArray(summary.opportunities, 5);
  const opportunitiesFormatted = opportunitiesRaw.map((o) =>
    typeof o === 'string' ? o : `${o.opportunity || ''} (${o.size || ''})`
  );

  // Prepare obstacles data (handle both string and object formats)
  const obstaclesRaw = safeArray(summary.obstacles, 5);
  const obstaclesFormatted = obstaclesRaw.map((o) =>
    typeof o === 'string' ? o : `${o.obstacle || ''} [${o.severity || ''}]`
  );

  // Use the enhanced two-column layout helper
  addOpportunitiesObstaclesSummary(ooSlide, opportunitiesFormatted, obstaclesFormatted, {
    x: LEFT_MARGIN,
    y: 1.35,
    colWidth: 6,
  });

  // Ratings at bottom
  const ratings = summary.ratings || {};
  if (ratings.attractiveness || ratings.feasibility) {
    ooSlide.addText(
      `Attractiveness: ${ratings.attractiveness || 'N/A'}/10 | Feasibility: ${ratings.feasibility || 'N/A'}/10`,
      {
        x: LEFT_MARGIN,
        y: 6.2,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      }
    );
  }

  // SLIDE 25: Key Insights
  const insightsSlide = addSlideWithTitle(
    `${country} - Key Insights`,
    'Strategic implications for market entry'
  );
  const insights = safeArray(summary.keyInsights, 3);
  let insightY = 1.3;
  insights.forEach((insight, idx) => {
    const title =
      typeof insight === 'string' ? `Insight ${idx + 1}` : insight.title || `Insight ${idx + 1}`;
    const content =
      typeof insight === 'string'
        ? insight
        : `${insight.data || ''} ${insight.pattern || ''} ${insight.implication || ''}`;

    insightsSlide.addText(title, {
      x: LEFT_MARGIN,
      y: insightY,
      w: CONTENT_WIDTH,
      h: 0.35,
      fontSize: 14,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
    });
    insightsSlide.addText(truncate(content, 200), {
      x: LEFT_MARGIN,
      y: insightY + 0.35,
      w: CONTENT_WIDTH,
      h: 1.2,
      fontSize: 11,
      fontFace: FONT,
      color: COLORS.black,
      valign: 'top',
    });
    insightY += 1.7;
  });

  // Add recommendation callout box at bottom
  if (summary.recommendation) {
    addCalloutBox(insightsSlide, 'RECOMMENDATION', summary.recommendation, {
      y: 5.6,
      h: 1.0,
      type: 'recommendation',
    });
  }

  // SLIDE 26: Final Summary with Source Attribution
  const finalSlide = addSlideWithTitle(
    `${country} - Research Summary`,
    `Analysis completed ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
  );
  // Key metrics recap
  const metricsRows = [tableHeader(['Metric', 'Value', 'Confidence'])];
  const marketDynamics = market.marketDynamics || {};
  if (marketDynamics.marketSize) {
    metricsRows.push([
      { text: 'Market Size' },
      { text: truncate(marketDynamics.marketSize, 40) },
      { text: `${synthesis.confidenceScore || '--'}/100` },
    ]);
  }
  if (depth.escoEconomics?.typicalDealSize?.average) {
    metricsRows.push([
      { text: 'Typical Deal Size' },
      { text: depth.escoEconomics.typicalDealSize.average },
      { text: '' },
    ]);
  }
  const finalRatings = summary.ratings || {};
  if (finalRatings.attractiveness) {
    metricsRows.push([
      { text: 'Attractiveness' },
      { text: `${finalRatings.attractiveness}/10` },
      {
        text: finalRatings.attractivenessRationale
          ? truncate(finalRatings.attractivenessRationale, 30)
          : '',
      },
    ]);
  }
  if (finalRatings.feasibility) {
    metricsRows.push([
      { text: 'Feasibility' },
      { text: `${finalRatings.feasibility}/10` },
      {
        text: finalRatings.feasibilityRationale
          ? truncate(finalRatings.feasibilityRationale, 30)
          : '',
      },
    ]);
  }
  finalSlide.addTable(metricsRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: CONTENT_WIDTH,
    h: 2.5,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.5, 3.5, 3.3],
    valign: 'top',
  });
  // Go/No-Go verdict callout
  const finalGoNoGo = summary.goNoGo || {};
  const finalVerdictType =
    finalGoNoGo.overallVerdict?.includes('GO') && !finalGoNoGo.overallVerdict?.includes('NO')
      ? 'positive'
      : finalGoNoGo.overallVerdict?.includes('NO')
        ? 'negative'
        : 'warning';
  addCalloutBox(
    finalSlide,
    `VERDICT: ${finalGoNoGo.overallVerdict || 'CONDITIONAL'}`,
    (finalGoNoGo.conditions || []).slice(0, 2).join('; ') ||
      'Proceed with recommended entry strategy',
    { y: 4.0, h: 0.9, type: finalVerdictType }
  );
  // Source attribution footnote
  addSourceFootnote(
    finalSlide,
    [
      'Government statistical agencies',
      'Industry associations',
      'Company filings and annual reports',
    ],
    COLORS,
    FONT
  );

  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  console.log(`Deep-dive PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB, 27 slides`);
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

  // Set exact slide size to match YCP template (13.333" x 7.5" = 16:9 widescreen)
  pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
  pptx.layout = 'YCP';

  pptx.author = 'YCP Market Research';
  pptx.title = `${scope.industry} Market Analysis - ${scope.targetMarkets.join(', ')}`;
  pptx.subject = scope.projectType;

  // YCP Theme Colors (from profile-slides template)
  const COLORS = {
    headerLine: '293F55', // Dark navy for header/footer lines
    accent3: '011AB7', // Dark blue - table header background
    accent1: '007FFF', // Bright blue - secondary/subtitle
    dk2: '1F497D', // Section underline/title color
    white: 'FFFFFF',
    black: '000000',
    gray: 'BFBFBF', // Border color
    footerText: '808080', // Gray footer text
    green: '2E7D32', // Positive/Opportunity
    orange: 'E46C0A', // Warning/Obstacle
    red: 'C62828', // Negative/Risk
  };

  // Set default font to Segoe UI (YCP standard)
  pptx.theme = { headFontFace: 'Segoe UI', bodyFontFace: 'Segoe UI' };
  const FONT = 'Segoe UI';

  // Widescreen dimensions (13.333" x 7.5" = 16:9)
  const CONTENT_WIDTH = 12.5; // Full content width for 16:9 widescreen
  const LEFT_MARGIN = 0.4; // Left margin matching YCP template

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
      x: LEFT_MARGIN,
      y: 0.15,
      w: CONTENT_WIDTH,
      h: 0.7,
      fontSize: 24,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
      valign: 'top',
      wrap: true,
    });
    // Navy divider line under title
    slide.addShape('line', {
      x: LEFT_MARGIN,
      y: 0.9,
      w: CONTENT_WIDTH,
      h: 0,
      line: { color: COLORS.dk2, width: 2.5 },
    });
    // Message/subtitle - 14pt blue (the "so what")
    if (subtitle) {
      slide.addText(subtitle, {
        x: LEFT_MARGIN,
        y: 0.95,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 14,
        color: COLORS.accent1,
        fontFace: FONT,
      });
    }
    return slide;
  }

  // ============ SLIDE 1: TITLE ============
  const titleSlide = pptx.addSlide();
  titleSlide.addText(scope.industry.toUpperCase(), {
    x: 0.5,
    y: 2.2,
    w: 9,
    h: 0.8,
    fontSize: 36,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  titleSlide.addText('Market Comparison', {
    x: 0.5,
    y: 3.0,
    w: 9,
    h: 0.5,
    fontSize: 24,
    color: COLORS.accent1,
    fontFace: FONT,
  });
  titleSlide.addText(scope.targetMarkets.join(' | '), {
    x: 0.5,
    y: 3.6,
    w: 9,
    h: 0.4,
    fontSize: 14,
    color: COLORS.black,
    fontFace: FONT,
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5,
    y: 6.5,
    w: 9,
    h: 0.3,
    fontSize: 10,
    color: '666666',
    fontFace: FONT,
  });

  // ============ SLIDE 2: OVERVIEW (Comparison Table) ============
  const overviewSlide = addSlide('Overview', 'Market comparison across countries');

  const overviewRows = [
    [
      {
        text: 'Country',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Market Size',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Foreign Ownership',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Risk Level',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
    ],
  ];

  countryAnalyses.forEach((c) => {
    if (c.error) return;
    overviewRows.push([
      { text: c.country, options: { fontFace: FONT } },
      { text: truncate(c.marketDynamics?.marketSize || 'N/A', 60), options: { fontFace: FONT } },
      {
        text: truncate(c.policyRegulatory?.foreignOwnershipRules || 'N/A', 60),
        options: { fontFace: FONT },
      },
      {
        text: truncate(c.policyRegulatory?.regulatoryRisk || 'N/A', 40),
        options: { fontFace: FONT },
      },
    ]);
  });

  overviewSlide.addTable(overviewRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: CONTENT_WIDTH,
    h: 4.7,
    fontSize: 12,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.0, 2.5, 2.5, 2.3],
    valign: 'top',
  });

  // ============ SLIDE 3: EXECUTIVE SUMMARY ============
  const execSlide = addSlide(
    'Executive Summary',
    synthesis.executiveSummary?.subtitle || 'Key findings across markets'
  );
  const keyFindings = safeArray(
    synthesis.executiveSummary?.keyFindings || synthesis.keyFindings,
    4
  );
  if (keyFindings.length > 0) {
    execSlide.addText(
      keyFindings.map((f, idx) => ({
        text: `${idx + 1}. ${truncate(typeof f === 'string' ? f : f.finding || f.text || '', 120)}`,
        options: { bullet: false, paraSpaceBefore: idx > 0 ? 8 : 0 },
      })),
      {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: 4.5,
        fontSize: 13,
        fontFace: FONT,
        color: COLORS.black,
        valign: 'top',
      }
    );
  }
  // Recommendation box
  if (synthesis.recommendation) {
    execSlide.addText('RECOMMENDATION', {
      x: LEFT_MARGIN,
      y: 5.5,
      w: CONTENT_WIDTH,
      h: 0.3,
      fontSize: 12,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
    });
    execSlide.addText(truncate(synthesis.recommendation, 200), {
      x: LEFT_MARGIN,
      y: 5.85,
      w: CONTENT_WIDTH,
      h: 0.7,
      fontSize: 11,
      fontFace: FONT,
      color: COLORS.black,
      valign: 'top',
      fill: { color: 'EDFDFF' },
      line: { color: COLORS.accent1, pt: 1 },
    });
  }

  // ============ SLIDE 4: MARKET SIZE COMPARISON (Bar Chart) ============
  const sizeSlide = addSlide('Market Size Comparison', 'Relative market opportunity by country');
  // Extract market sizes for chart
  const chartLabels = [];
  const chartValues = [];
  countryAnalyses.forEach((c) => {
    if (c.error) return;
    chartLabels.push(c.country);
    // Try to extract numeric value from market size string
    const sizeStr = c.marketDynamics?.marketSize || '';
    const numMatch = sizeStr.match(/[$€]?\s*([\d,.]+)\s*(billion|million|B|M)?/i);
    let value = 0;
    if (numMatch) {
      value = parseFloat(numMatch[1].replace(/,/g, ''));
      if (/billion|B/i.test(numMatch[2] || '')) value *= 1000; // Convert to millions
    }
    chartValues.push(value || 100); // Default to 100 if can't parse
  });

  if (chartLabels.length > 0 && chartValues.some((v) => v > 0)) {
    sizeSlide.addChart(
      'bar',
      [
        {
          name: 'Market Size ($M)',
          labels: chartLabels,
          values: chartValues,
        },
      ],
      {
        x: LEFT_MARGIN,
        y: 1.4,
        w: CONTENT_WIDTH,
        h: 4.5,
        barDir: 'bar',
        showValue: true,
        dataLabelPosition: 'outEnd',
        dataLabelFontFace: FONT,
        dataLabelFontSize: 10,
        chartColors: [COLORS.accent1],
        valAxisMaxVal: Math.max(...chartValues) * 1.2,
        catAxisLabelFontFace: FONT,
        catAxisLabelFontSize: 11,
        valAxisLabelFontFace: FONT,
        valAxisLabelFontSize: 10,
      }
    );
  }

  // ============ SLIDE 5: ATTRACTIVENESS vs FEASIBILITY MATRIX ============
  const matrixSlide = addSlide(
    'Market Positioning Matrix',
    'Attractiveness vs Feasibility across markets'
  );
  // Draw quadrant background
  matrixSlide.addShape('rect', {
    x: 0.5,
    y: 1.3,
    w: 4.25,
    h: 2.5,
    fill: { color: 'FFF0F0' }, // Bottom-left (low-low) - light red
  });
  matrixSlide.addShape('rect', {
    x: 4.75,
    y: 1.3,
    w: 4.25,
    h: 2.5,
    fill: { color: 'FFFAED' }, // Bottom-right (high attract, low feas) - light orange
  });
  matrixSlide.addShape('rect', {
    x: 0.5,
    y: 3.8,
    w: 4.25,
    h: 2.5,
    fill: { color: 'FFFAED' }, // Top-left (low attract, high feas) - light orange
  });
  matrixSlide.addShape('rect', {
    x: 4.75,
    y: 3.8,
    w: 4.25,
    h: 2.5,
    fill: { color: 'F0FFF0' }, // Top-right (high-high) - light green
  });
  // Axis labels
  matrixSlide.addText('← Low Attractiveness | High Attractiveness →', {
    x: 0.5,
    y: 6.4,
    w: 8.5,
    h: 0.25,
    fontSize: 9,
    color: COLORS.footerText,
    fontFace: FONT,
    align: 'center',
  });
  matrixSlide.addText('High\nFeasibility\n\n\n\n\n\nLow\nFeasibility', {
    x: 9.1,
    y: 1.3,
    w: 0.6,
    h: 5.0,
    fontSize: 8,
    color: COLORS.footerText,
    fontFace: FONT,
    align: 'center',
    valign: 'middle',
  });
  // Plot countries as circles
  countryAnalyses.forEach((c, idx) => {
    if (c.error) return;
    const attract = c.summary?.ratings?.attractiveness || 5;
    const feas = c.summary?.ratings?.feasibility || 5;
    // Map 0-10 to x: 0.5-8.5 and y: 1.3-5.8 (inverted for y)
    const x = 0.5 + (attract / 10) * 8.0;
    const y = 5.8 - (feas / 10) * 4.5 + 0.3;
    // Country bubble
    const colors = [COLORS.accent1, COLORS.accent3, '2E7D32', 'E46C0A', 'C62828'];
    matrixSlide.addShape('ellipse', {
      x: x - 0.4,
      y: y - 0.3,
      w: 0.8,
      h: 0.6,
      fill: { color: colors[idx % colors.length] },
    });
    matrixSlide.addText(c.country.substring(0, 3).toUpperCase(), {
      x: x - 0.4,
      y: y - 0.15,
      w: 0.8,
      h: 0.3,
      fontSize: 8,
      bold: true,
      color: COLORS.white,
      fontFace: FONT,
      align: 'center',
      valign: 'middle',
    });
  });
  // Legend
  matrixSlide.addText('Score Legend:', {
    x: 0.5,
    y: 6.7,
    w: 1.5,
    h: 0.2,
    fontSize: 8,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  countryAnalyses.forEach((c, idx) => {
    if (c.error) return;
    matrixSlide.addText(
      `${c.country}: A=${c.summary?.ratings?.attractiveness || '?'}/F=${c.summary?.ratings?.feasibility || '?'}`,
      {
        x: 2.0 + idx * 2.2,
        y: 6.7,
        w: 2.2,
        h: 0.2,
        fontSize: 8,
        color: COLORS.black,
        fontFace: FONT,
      }
    );
  });

  // ============ SLIDE 6: RECOMMENDATION SUMMARY ============
  const recSlide = addSlide('Recommendation Summary', 'Prioritized market entry approach');
  // Build recommendation table
  const recRows = [
    [
      {
        text: 'Country',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Priority',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Entry Mode',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Key Action',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
    ],
  ];
  // Sort by attractiveness score
  const sortedCountries = [...countryAnalyses]
    .filter((c) => !c.error)
    .sort((a, b) => {
      const aScore =
        (a.summary?.ratings?.attractiveness || 0) + (a.summary?.ratings?.feasibility || 0);
      const bScore =
        (b.summary?.ratings?.attractiveness || 0) + (b.summary?.ratings?.feasibility || 0);
      return bScore - aScore;
    });
  sortedCountries.forEach((c, idx) => {
    const priority = idx === 0 ? 'PRIMARY' : idx === 1 ? 'SECONDARY' : 'MONITOR';
    const priorityColor = idx === 0 ? COLORS.green : idx === 1 ? COLORS.accent1 : COLORS.footerText;
    const entryMode = c.depth?.entryStrategy?.recommendation || c.summary?.recommendation || 'TBD';
    const keyAction =
      c.summary?.opportunities?.[0] || c.summary?.keyInsights?.[0]?.implication || '';
    recRows.push([
      { text: c.country },
      { text: priority, options: { color: priorityColor, bold: true } },
      { text: truncate(entryMode, 30) },
      {
        text: truncate(typeof keyAction === 'string' ? keyAction : keyAction.opportunity || '', 50),
      },
    ]);
  });
  recSlide.addTable(recRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: CONTENT_WIDTH,
    h: 4.0,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [1.8, 1.3, 2.5, 3.7],
    valign: 'top',
  });
  // Next steps
  recSlide.addText('Recommended Next Steps:', {
    x: LEFT_MARGIN,
    y: 5.5,
    w: CONTENT_WIDTH,
    h: 0.3,
    fontSize: 12,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  const nextSteps = synthesis.nextSteps ||
    synthesis.executiveSummary?.nextSteps || [
      'Conduct detailed due diligence on primary market',
      'Identify and approach potential partners',
      'Develop market entry business case',
    ];
  recSlide.addText(
    safeArray(nextSteps, 3).map((s) => ({
      text: truncate(typeof s === 'string' ? s : s.step || '', 80),
      options: { bullet: true },
    })),
    {
      x: LEFT_MARGIN,
      y: 5.85,
      w: CONTENT_WIDTH,
      h: 0.8,
      fontSize: 10,
      fontFace: FONT,
      color: COLORS.black,
      valign: 'top',
    }
  );

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
        {
          text: 'Area',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
        {
          text: 'Details',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
      ],
    ];

    // Add key legislation
    const laws = safeArray(reg.keyLegislation, 3);
    laws.forEach((law, idx) => {
      regRows.push([{ text: `Key Law ${idx + 1}` }, { text: truncate(law, 100) }]);
    });

    if (reg.foreignOwnershipRules) {
      regRows.push([
        { text: 'Foreign Ownership' },
        { text: truncate(reg.foreignOwnershipRules, 100) },
      ]);
    }

    const incentives = safeArray(reg.incentives, 2);
    incentives.forEach((inc, idx) => {
      regRows.push([{ text: idx === 0 ? 'Incentives' : '' }, { text: truncate(inc, 100) }]);
    });

    if (reg.regulatoryRisk) {
      regRows.push([{ text: 'Risk Level' }, { text: truncate(reg.regulatoryRisk, 100) }]);
    }

    regSlide.addTable(regRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: CONTENT_WIDTH,
      h: 4.7,
      fontSize: 14,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.0, 7.3],
      valign: 'top',
    });

    // ---------- SLIDE: {Country} - Market ----------
    const market = ca.marketDynamics || {};
    const macro = ca.macroContext || {};
    const marketSubtitle = market.marketSize ? truncateSubtitle(market.marketSize, 95) : '';
    const marketSlide = addSlide(`${countryName} - Market`, marketSubtitle);

    const marketRows = [
      [
        {
          text: 'Metric',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
        {
          text: 'Value',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
      ],
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
      marketRows.push([
        { text: 'Energy Intensity' },
        { text: truncate(macro.energyIntensity, 100) },
      ]);
    }
    if (macro.keyObservation) {
      marketRows.push([{ text: 'Key Observation' }, { text: truncate(macro.keyObservation, 100) }]);
    }

    marketSlide.addTable(marketRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: CONTENT_WIDTH,
      h: 4.7,
      fontSize: 14,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.0, 7.3],
      valign: 'top',
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
        {
          text: 'Company',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
        {
          text: 'Type',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
        {
          text: 'Notes',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
      ],
    ];

    safeArray(comp.localPlayers, 3).forEach((p) => {
      const name = typeof p === 'string' ? p : p.name || 'Unknown';
      const desc = typeof p === 'string' ? '' : p.description || '';
      compRows.push([
        { text: truncate(name, 30) },
        { text: 'Local' },
        { text: truncate(desc, 70) },
      ]);
    });

    safeArray(comp.foreignPlayers, 3).forEach((p) => {
      const name = typeof p === 'string' ? p : p.name || 'Unknown';
      const desc = typeof p === 'string' ? '' : p.description || '';
      compRows.push([
        { text: truncate(name, 30) },
        { text: 'Foreign' },
        { text: truncate(desc, 70) },
      ]);
    });

    compSlide.addTable(compRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: CONTENT_WIDTH,
      h: 3.5,
      fontSize: 14,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.5, 1.0, 5.8],
      valign: 'top',
    });

    // Entry barriers section
    const barriers = safeArray(comp.entryBarriers, 4);
    if (barriers.length > 0) {
      compSlide.addShape('line', {
        x: LEFT_MARGIN,
        y: 4.9,
        w: CONTENT_WIDTH,
        h: 0,
        line: { color: COLORS.dk2, width: 2.5 },
      });
      compSlide.addText('Barriers to Entry', {
        x: LEFT_MARGIN,
        y: 5.0,
        w: CONTENT_WIDTH,
        h: 0.35,
        fontSize: 14,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      compSlide.addText(
        barriers.map((b) => ({ text: truncate(b, 90), options: { bullet: true } })),
        {
          x: LEFT_MARGIN,
          y: 5.4,
          w: CONTENT_WIDTH,
          h: 1.3,
          fontSize: 14,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
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
    attachments: [
      {
        filename: attachment.filename,
        content: attachment.content,
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        disposition: 'attachment',
      },
    ],
  };

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(emailData),
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

  const tracker = createTracker('market-research', email, { prompt: userPrompt.substring(0, 200) });

  return trackingContext.run(tracker, async () => {
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
          batch.map((country) =>
            researchCountry(country, scope.industry, scope.clientContext, scope)
          )
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

      await sendEmail(
        email,
        `Market Research: ${scope.industry} - ${scope.targetMarkets.join(', ')}`,
        emailHtml,
        {
          filename,
          content: pptBuffer.toString('base64'),
        }
      );

      const totalTime = (Date.now() - startTime) / 1000;
      console.log('\n========================================');
      console.log('MARKET RESEARCH - COMPLETE');
      console.log('========================================');
      console.log(
        `Total time: ${totalTime.toFixed(0)} seconds (${(totalTime / 60).toFixed(1)} minutes)`
      );
      console.log(`Total cost: $${costTracker.totalCost.toFixed(2)}`);
      console.log(`Countries analyzed: ${countryAnalyses.length}`);

      // Estimate costs from internal costTracker by aggregating per model
      const modelTokens = {};
      for (const call of costTracker.calls) {
        if (!modelTokens[call.model]) {
          modelTokens[call.model] = { input: 0, output: 0 };
        }
        modelTokens[call.model].input += call.inputTokens || 0;
        modelTokens[call.model].output += call.outputTokens || 0;
      }
      // Add model calls to shared tracker (pass numeric token counts directly)
      for (const [model, tokens] of Object.entries(modelTokens)) {
        tracker.addModelCall(model, tokens.input, tokens.output);
      }

      // Track usage
      await tracker.finish({
        countriesAnalyzed: countryAnalyses.length,
        industry: scope.industry,
      });

      return {
        success: true,
        scope,
        countriesAnalyzed: countryAnalyses.length,
        totalCost: costTracker.totalCost,
        totalTimeSeconds: totalTime,
      };
    } catch (error) {
      console.error('Market research failed:', error);
      await tracker.finish({ status: 'error', error: error.message }).catch(() => {});

      // Try to send error email
      try {
        await sendEmail(
          email,
          'Market Research Failed',
          `
        <h2>Market Research Error</h2>
        <p>Your market research request encountered an error:</p>
        <pre>${error.message}</pre>
        <p>Please try again or contact support.</p>
      `,
          {
            filename: 'error.txt',
            content: Buffer.from(error.stack || error.message).toString('base64'),
          }
        );
      } catch (emailError) {
        console.error('Failed to send error email:', emailError);
      }

      throw error;
    }
  }); // end trackingContext.run
}

// ============ API ENDPOINTS ============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'market-research',
    timestamp: new Date().toISOString(),
    costToday: costTracker.totalCost,
  });
});

// ============ HEALTH CHECK ============
app.get('/health', healthCheck('market-research'));

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
    estimatedTime: '30-60 minutes',
  });

  // Run research in background
  runMarketResearch(prompt, email).catch((error) => {
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
  console.log('  - KIMI_API_KEY:', process.env.KIMI_API_KEY ? 'Set' : 'MISSING');
  console.log(
    '  - KIMI_API_BASE:',
    process.env.KIMI_API_BASE || 'https://api.moonshot.ai/v1 (default)'
  );
  console.log('  - PERPLEXITY_API_KEY:', process.env.PERPLEXITY_API_KEY ? 'Set' : 'MISSING');
  console.log('  - SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'Set' : 'MISSING');
  console.log('  - SENDER_EMAIL:', process.env.SENDER_EMAIL || 'MISSING');
});
