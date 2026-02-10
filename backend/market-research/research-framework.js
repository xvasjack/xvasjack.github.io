const { callGemini } = require('./ai-clients');

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
- clientName: string (the client company name if mentioned, e.g. "Shizuoka Gas Company")
- projectName: string (the project name if mentioned, e.g. "Project Escort")
- focusAreas: string[] (specific aspects to emphasize)

If countries are vague like "Southeast Asia" or "SEA", expand to: ["Thailand", "Vietnam", "Indonesia", "Malaysia", "Philippines"]
If countries are vague like "ASEAN", expand to: ["Thailand", "Vietnam", "Indonesia", "Malaysia", "Philippines", "Singapore"]

Return ONLY valid JSON, no markdown or explanation.`;

  let result;
  try {
    const geminiResult = await callGemini(userPrompt, {
      temperature: 0.0,
      maxTokens: 4096,
      jsonMode: true,
      systemPrompt,
    });
    result = {
      content: typeof geminiResult === 'string' ? geminiResult : geminiResult.content || '',
    };
  } catch (e) {
    console.warn('Gemini failed for scope parsing, retrying:', e.message);
    try {
      const geminiRetry = await callGemini(userPrompt, {
        systemPrompt,
        maxTokens: 4096,
        jsonMode: true,
      });
      result = {
        content: typeof geminiRetry === 'string' ? geminiRetry : geminiRetry.content || '',
      };
    } catch (retryErr) {
      console.warn('Gemini retry also failed:', retryErr.message);
      result = { content: '' };
    }
  }

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
    // Try to extract useful info from raw prompt before falling back to generic
    const promptLower = userPrompt.toLowerCase();

    // Extract country names from prompt
    const countryPatterns = [
      'Thailand',
      'Vietnam',
      'Indonesia',
      'Malaysia',
      'Philippines',
      'Singapore',
      'Myanmar',
      'Cambodia',
      'Laos',
      'India',
      'China',
      'Japan',
      'Korea',
      'Taiwan',
      'Bangladesh',
      'Pakistan',
      'Sri Lanka',
      'Australia',
      'New Zealand',
    ];
    const detectedCountries = countryPatterns.filter((c) => promptLower.includes(c.toLowerCase()));

    // Extract industry keywords from prompt
    const industryPatterns = [
      {
        keywords: ['energy', 'power', 'electricity', 'renewable', 'solar', 'wind'],
        industry: 'energy services',
      },
      { keywords: ['healthcare', 'medical', 'hospital', 'pharma'], industry: 'healthcare' },
      {
        keywords: ['fintech', 'banking', 'financial', 'insurance'],
        industry: 'financial services',
      },
      { keywords: ['logistics', 'supply chain', 'warehouse', 'shipping'], industry: 'logistics' },
      { keywords: ['manufacturing', 'factory', 'industrial'], industry: 'manufacturing' },
      { keywords: ['technology', 'software', 'IT', 'digital'], industry: 'technology' },
      { keywords: ['food', 'beverage', 'agriculture', 'agri'], industry: 'food & agriculture' },
      { keywords: ['real estate', 'property', 'construction'], industry: 'real estate' },
      { keywords: ['automotive', 'EV', 'vehicle'], industry: 'automotive' },
      { keywords: ['retail', 'e-commerce', 'consumer'], industry: 'retail & consumer' },
    ];
    let detectedIndustry = 'general business';
    for (const pattern of industryPatterns) {
      if (pattern.keywords.some((kw) => promptLower.includes(kw.toLowerCase()))) {
        detectedIndustry = pattern.industry;
        break;
      }
    }

    console.log(
      `  [Scope Fallback] Detected countries: ${detectedCountries.length ? detectedCountries.join(', ') : 'none'}, industry: ${detectedIndustry}`
    );

    return {
      projectType: 'market_entry',
      industry: detectedIndustry,
      targetMarkets:
        detectedCountries.length > 0
          ? detectedCountries
          : ['Thailand', 'Vietnam', 'Malaysia', 'Philippines', 'Indonesia'],
      clientContext: promptLower.includes('japanese')
        ? 'Japanese company'
        : 'international company',
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

CRITICAL ANTI-DRIFT RULE:
- If the industry is "energy services" or similar demand-side energy, DO NOT research upstream oil & gas production, refining, or exploration
- Instead focus on: ESCO (energy service companies), energy efficiency, energy audits, energy performance contracting, behind-the-meter solutions, industrial energy management, demand-side management
- Market topics should include: Total Primary Energy Supply (TPES), Final Energy Demand by sector, Electricity consumption vs capacity, Energy pricing, Natural gas/LNG supply
- Each topic should have at least 5 very specific search queries

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
  "context": {
    "topics": [
      {
        "name": "Macroeconomic Context",
        "queries": ["5 queries about GDP, economic growth, industrial output, FDI trends"]
      },
      {
        "name": "Market Opportunities & White Spaces",
        "queries": ["5 queries about underserved segments, gaps, upcoming tenders, unmet demand"]
      },
      {
        "name": "Key Risks & Market Barriers",
        "queries": ["5 queries about regulatory risk, political stability, currency risk, barriers to entry"]
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
6. Total: 6 categories (policy, market, competitors, context, depth, insights), 3-5 topics per category, 5 queries per topic (25 total topics minimum)
7. The "context" category must have 3 topics: macroeconomic context, market opportunities/white spaces, and key risks/barriers

Return ONLY valid JSON.`;

  const geminiText = await callGemini(frameworkPrompt, { maxTokens: 12288, jsonMode: true });

  try {
    let jsonStr = (typeof geminiText === 'string' ? geminiText : geminiText.content || '').trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/```json?\n?/g, '')
        .replace(/```/g, '')
        .trim();
    }
    let framework;
    try {
      framework = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Attempt to repair truncated JSON by closing open brackets/braces
      console.warn('JSON parse failed, attempting truncation repair...');
      let repaired = jsonStr;
      const openBraces = (repaired.match(/\{/g) || []).length;
      const closeBraces = (repaired.match(/\}/g) || []).length;
      const openBrackets = (repaired.match(/\[/g) || []).length;
      const closeBrackets = (repaired.match(/\]/g) || []).length;
      // Trim trailing comma or incomplete value
      repaired = repaired.replace(/,\s*$/, '');
      // Remove any trailing incomplete string
      repaired = repaired.replace(/"[^"]*$/, '""');
      for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';
      for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';
      framework = JSON.parse(repaired);
      console.log('Truncation repair succeeded');
    }

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

    if (topicCount < 15) {
      console.warn(
        `WARNING: Dynamic framework only has ${topicCount} topics (minimum 15). Falling back to hardcoded framework.`
      );
      return generateFallbackFramework(scope);
    }

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
        {
          name: 'Investment & Trade Policy',
          queries: [
            `{country} foreign investment rules ${industry} ownership limits`,
            `{country} trade agreements ${industry} sector bilateral`,
            `{country} investment incentives ${industry} tax breaks subsidies`,
            `{country} special economic zones ${industry} privileges`,
            `{country} BOI promotion ${industry} foreign investor benefits`,
          ],
        },
        {
          name: 'Investment Incentives & FDI Policy',
          queries: [
            `{country} FDI policy foreign direct investment incentives ${industry}`,
            `{country} tax holidays investment promotion ${industry} sector`,
            `{country} free trade zones ${industry} foreign company benefits`,
            `{country} government grants subsidies ${industry} projects`,
            `{country} bilateral investment treaties ${industry} protection`,
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
        {
          name: 'Industry Trends & Drivers',
          queries: [
            `{country} ${industry} demand drivers growth factors`,
            `{country} ${industry} technology adoption digital transformation`,
            `{country} ${industry} fastest growing segments 2024 2025`,
            `{country} ${industry} supply chain dynamics imports exports`,
            `{country} ${industry} investment inflows FDI trends`,
          ],
        },
        {
          name: 'Electricity Generation & Grid',
          queries: [
            `{country} electricity generation capacity installed MW GW 2024`,
            `{country} power grid infrastructure transmission distribution`,
            `{country} electricity generation mix coal gas renewable nuclear`,
            `{country} smart grid modernization investment plans`,
            `{country} electricity demand growth forecast 2025 2030`,
          ],
        },
        {
          name: 'Gas & LNG Infrastructure',
          queries: [
            `{country} natural gas consumption production statistics`,
            `{country} LNG import terminal capacity regasification`,
            `{country} gas pipeline network coverage industrial`,
            `{country} gas distribution companies market share`,
            `{country} LNG price trends contracts long term spot`,
          ],
        },
        {
          name: 'Pricing & Tariffs',
          queries: [
            `{country} industrial electricity tariff rate per kWh`,
            `{country} energy price comparison regional benchmarks`,
            `{country} natural gas price industrial commercial users`,
            `{country} energy subsidy policy reform plans`,
            `{country} tariff structure time-of-use peak off-peak`,
          ],
        },
        {
          name: 'ESCO & Energy Efficiency Market',
          queries: [
            `{country} ESCO market size growth energy service companies`,
            `{country} energy performance contracting EPC projects`,
            `{country} energy audit market demand mandatory compliance`,
            `{country} energy efficiency targets government mandates`,
            `{country} energy management systems adoption industrial`,
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
        {
          name: 'Market Entry & Partnerships',
          queries: [
            `{country} ${industry} joint venture examples foreign local`,
            `{country} ${industry} acquisition activity 2023 2024 deals`,
            `{country} ${industry} partnership models distribution licensing`,
            `{country} ${industry} new market entrants recent 2024`,
            `{country} ${industry} strategic alliances collaboration agreements`,
          ],
        },
        {
          name: 'Case Studies & Notable Projects',
          queries: [
            `{country} ${industry} successful foreign company entry case study`,
            `{country} ${industry} notable projects flagship developments`,
            `{country} ${industry} BOI promoted projects foreign investors`,
            `{country} ${industry} joint venture success stories lessons`,
            `{country} ${industry} award winning projects best practice`,
          ],
        },
        {
          name: 'M&A Activity & Joint Ventures',
          queries: [
            `{country} ${industry} mergers acquisitions 2023 2024 deals`,
            `{country} ${industry} companies for sale acquisition targets`,
            `{country} ${industry} joint venture announcements partnerships`,
            `{country} ${industry} strategic investments deal terms valuation`,
            `{country} ${industry} private equity venture capital investments`,
          ],
        },
      ],
    },
    context: {
      topics: [
        {
          name: 'Macroeconomic Context & GDP Outlook',
          queries: [
            `{country} GDP growth forecast 2025 2026 IMF World Bank`,
            `{country} manufacturing sector contribution GDP industrial output`,
            `{country} foreign direct investment inflows by sector`,
            `{country} economic development plan industrial strategy`,
            `{country} inflation interest rates monetary policy outlook`,
          ],
        },
        {
          name: 'Market Opportunities & White Spaces',
          queries: [
            `{country} ${industry} market gaps underserved segments opportunity`,
            `{country} ${industry} government tenders upcoming projects pipeline`,
            `{country} ${industry} unmet demand emerging needs`,
            `{country} industrial parks zones seeking ${industry} solutions`,
            `{country} ${industry} technology gaps foreign expertise needed`,
          ],
        },
        {
          name: 'Key Risks & Market Barriers',
          queries: [
            `{country} ${industry} regulatory risk policy uncertainty`,
            `{country} foreign investment risks political stability`,
            `{country} currency exchange rate risk business contracts`,
            `{country} ${industry} barriers to entry foreign companies`,
            `{country} local content requirements protectionism ${industry}`,
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
        {
          name: 'Contract Models & Procurement',
          queries: [
            `{country} ${industry} contract types EPC BOT PPP models`,
            `{country} ${industry} procurement process government tenders`,
            `{country} ${industry} contract duration terms typical`,
            `{country} ${industry} payment terms financing structures`,
            `{country} ${industry} performance guarantees penalty clauses`,
          ],
        },
        {
          name: 'Target Customer Segments',
          queries: [
            `{country} largest ${industry} consumers industrial facilities`,
            `{country} industrial estates zones highest ${industry} demand`,
            `{country} manufacturing sectors highest ${industry} consumption`,
            `{country} ${industry} mandatory compliance audit requirements`,
            `{country} Japanese manufacturing companies factories presence`,
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
        {
          name: 'Regulatory Outlook & Reform Trajectory',
          queries: [
            `{country} ${industry} regulation reform roadmap timeline`,
            `{country} ${industry} new laws pending legislation 2025 2026`,
            `{country} carbon pricing carbon tax implementation schedule`,
            `{country} ${industry} standards harmonization international`,
            `{country} ${industry} enforcement trends crackdown compliance`,
          ],
        },
      ],
    },
  };
}

/**
 * Get the appropriate research framework for a country.
 * Thailand uses the optimized hardcoded framework.
 * Other countries use dynamic generation with fallback.
 */
async function getResearchFramework(country, scope) {
  if (country && country.toLowerCase() === 'thailand') {
    console.log(`  [Framework] Using optimized hardcoded framework for Thailand`);
    return { framework: RESEARCH_FRAMEWORK, topicGroups: RESEARCH_TOPIC_GROUPS };
  }

  console.log(`  [Framework] Generating dynamic framework for ${country}...`);
  try {
    const dynamicFramework = await generateResearchFramework(scope);
    return { framework: dynamicFramework, topicGroups: null, isDynamic: true };
  } catch (err) {
    console.log(`  [Framework] Dynamic generation failed: ${err.message}, using fallback`);
    const fallback = generateFallbackFramework(scope);
    return { framework: fallback, topicGroups: null, isDynamic: true };
  }
}

module.exports = {
  RESEARCH_FRAMEWORK,
  RESEARCH_TOPIC_GROUPS,
  parseScope,
  generateResearchFramework,
  generateFallbackFramework,
  getResearchFramework,
};
