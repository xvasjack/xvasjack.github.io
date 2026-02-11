const { callGemini } = require('./ai-clients');

const RESEARCH_FRAMEWORK = {
  // === SECTION 1: POLICY & REGULATIONS (3 slides) ===
  policy_foundationalActs: {
    name: 'Foundational Laws & Acts',
    slideTitle: '{country} - {industry} Foundational Laws',
    queries: [
      '{country} {industry} primary legislation laws requirements penalties',
      '{country} {industry} mandatory compliance regulations standards',
      '{country} {industry} licensing regulations foreign companies',
      '{country} {industry} government development plan official targets',
      '{country} {industry} sector-specific regulations recent amendments',
    ],
  },
  policy_nationalPolicy: {
    name: 'National Policy & Strategy',
    slideTitle: '{country} - {industry} National Policy',
    queries: [
      '{country} {industry} national strategy plan 2024 2030 targets official',
      '{country} {industry} government policy direction priorities 2024',
      '{country} {industry} sector development roadmap goals timeline',
      '{country} {industry} ministry policy statements budget allocation',
      '{country} {industry} reform initiatives modernization plans',
    ],
  },
  policy_investmentRestrictions: {
    name: 'Investment Restrictions',
    slideTitle: '{country} - Foreign Investment Restrictions',
    queries: [
      '{country} foreign business act restricted industries {industry} sector',
      '{country} foreign ownership limit percentage {industry}',
      '{country} investment promotion {industry} projects incentives',
      '{country} joint venture requirements foreign {industry} companies',
      '{country} special economic zones {industry} investment privileges',
    ],
  },

  // === SECTION 2: MARKET (6 slides with charts) ===
  market_size: {
    name: 'Market Size & Value',
    slideTitle: '{country} - {industry} Market Size',
    chartType: 'stackedBar',
    queries: [
      '{country} {industry} market size value USD 2020 2021 2022 2023 2024',
      '{country} {industry} market segments breakdown by category',
      '{country} {industry} imports exports trade balance statistics',
      '{country} {industry} domestic production output statistics',
      '{country} {industry} market research report size forecast',
    ],
  },
  market_demand: {
    name: 'Demand by Sector',
    slideTitle: '{country} - {industry} Demand Analysis',
    chartType: 'stackedBar',
    queries: [
      '{country} {industry} demand by sector industrial commercial residential',
      '{country} {industry} consumption patterns customer segments statistics',
      '{country} {industry} demand growth rate by segment 2020-2024',
      '{country} {industry} demand forecast 2025 2030 projections',
      '{country} {industry} end-user market analysis trends',
    ],
  },
  market_supplyChain: {
    name: 'Supply Chain & Infrastructure',
    slideTitle: '{country} - {industry} Supply Chain',
    chartType: 'stackedBar',
    queries: [
      '{country} {industry} supply chain structure key players',
      '{country} {industry} infrastructure capacity facilities 2024',
      '{country} {industry} distribution channels logistics network',
      '{country} {industry} capacity utilization production output',
      '{country} {industry} import dependency domestic capability',
    ],
  },
  market_adjacentServices: {
    name: 'Adjacent Services & Ecosystem',
    slideTitle: '{country} - {industry} Service Ecosystem',
    chartType: 'line',
    queries: [
      '{country} {industry} professional services market consulting engineering',
      '{country} {industry} technology solutions providers market',
      '{country} {industry} outsourcing managed services market size',
      '{country} {industry} support services maintenance aftermarket',
      '{country} {industry} digital transformation technology adoption',
    ],
  },
  market_pricing: {
    name: 'Pricing & Cost Analysis',
    slideTitle: '{country} - {industry} Pricing Trends',
    chartType: 'line',
    queries: [
      '{country} {industry} pricing trends cost benchmarks 2020-2024',
      '{country} {industry} price comparison regional competitors',
      '{country} {industry} cost structure breakdown margins',
      '{country} {industry} subsidy policy government support pricing',
      '{country} {industry} pricing forecast 2025 reform plans',
    ],
  },
  market_services: {
    name: 'Specialized Services Market',
    slideTitle: '{country} - {industry} Services Overview',
    chartType: 'bar',
    queries: [
      '{country} {industry} services market size value USD 2024 growth rate',
      '{country} {industry} service providers list registered companies',
      '{country} {industry} performance contracting outsourcing market',
      '{country} {industry} consulting advisory market demand',
      '{country} {industry} certification standards adoption rate',
    ],
  },

  // === SECTION 3: COMPETITOR OVERVIEW (5 slides) ===
  competitors_japanese: {
    name: 'Japanese Players in Market',
    slideTitle: '{country} - Japanese {industry} Companies',
    queries: [
      'Japanese companies {country} {industry} investment projects subsidiary',
      'Japanese trading companies {country} {industry} market presence',
      'Japan {country} {industry} joint venture partnership deals',
      'Mitsubishi Mitsui Sumitomo {country} {industry} projects',
      'Japanese {industry} companies expanding {country} market entry',
      'Japanese companies {country} {industry} sector presence strategy',
    ],
  },
  competitors_localMajor: {
    name: 'Major Local Players',
    slideTitle: '{country} - Major Local {industry} Companies',
    queries: [
      '{country} largest {industry} companies revenue market share ranking',
      '{country} state owned {industry} company overview',
      '{country} major conglomerates {industry} subsidiaries',
      '{country} top 10 {industry} companies market leaders',
      '{country} {industry} leading firms contractors providers',
    ],
  },
  competitors_foreignPlayers: {
    name: 'Other Foreign Competitors',
    slideTitle: '{country} - Foreign {industry} Companies',
    queries: [
      'European companies {country} {industry} services presence projects',
      'American companies {country} {industry} market operations',
      'Chinese Korean companies {country} {industry} investments',
      'multinational corporations {country} {industry} market presence',
      'foreign {industry} companies {country} market share strategy',
    ],
  },
  competitors_caseStudy: {
    name: 'Successful Entry Case Studies',
    slideTitle: '{country} - Market Entry Case Studies',
    queries: [
      'successful foreign {industry} company entry {country} case study',
      '{country} {industry} joint venture success stories',
      '{country} {industry} sector acquisition deals 2020-2024',
      'lessons learned {industry} market entry {country}',
      '{country} promoted {industry} projects foreign investors',
    ],
  },
  competitors_maActivity: {
    name: 'M&A and Partnership Activity',
    slideTitle: '{country} - Recent M&A Activity',
    queries: [
      '{country} {industry} sector mergers acquisitions 2023 2024',
      '{country} {industry} companies for sale acquisition targets',
      '{country} {industry} joint venture announcements partnerships',
      '{country} {industry} strategic investments 2024',
      '{country} {industry} company valuation multiples deal terms',
    ],
  },

  // === ADDITIONAL CONTEXT ===
  macro_economicContext: {
    name: 'Economic Context',
    slideTitle: '{country} - Economic Overview',
    queries: [
      '{country} GDP 2024 2025 economic growth forecast IMF',
      '{country} manufacturing sector contribution GDP industrial output',
      '{country} foreign direct investment inflows {industry} sector',
      '{country} economic development plan industrial corridor',
      '{country} labor cost wage trends relevant sectors',
    ],
  },
  opportunities_whitespace: {
    name: 'Market Entry Opportunities',
    slideTitle: '{country} - Entry Opportunities',
    queries: [
      '{country} {industry} market gap underserved segments opportunity',
      '{country} {industry} growth potential unmet demand',
      '{country} government {industry} tender upcoming projects',
      '{country} industrial parks zones seeking {industry} solutions',
      '{country} conglomerates seeking {industry} partners technology',
    ],
  },
  risks_assessment: {
    name: 'Risk Assessment',
    slideTitle: '{country} - Risk Assessment',
    queries: [
      '{country} {industry} sector regulatory risk policy uncertainty',
      '{country} foreign investment risks political stability',
      '{country} currency exchange rate risk business contracts',
      '{country} {industry} policy reversal examples precedents',
      '{country} local content requirements {industry} sector',
    ],
  },

  // === DEPTH TOPICS: DEAL ECONOMICS & STRUCTURE ===
  depth_dealEconomics: {
    name: 'Deal Economics & Contract Structure',
    slideTitle: '{country} - {industry} Deal Economics',
    queries: [
      '{country} {industry} contract structure deal terms',
      '{country} {industry} typical deal size value market',
      '{country} {industry} project payback period ROI internal rate return',
      '{country} {industry} project financing options funding',
      '{country} {industry} contract duration terms typical',
    ],
  },
  depth_partnerAssessment: {
    name: 'Potential Partners Deep Dive',
    slideTitle: '{country} - Partner Assessment',
    queries: [
      '{country} top {industry} companies contractors revenue capabilities',
      '{country} industrial conglomerates seeking foreign technology partners',
      '{country} local {industry} companies acquisition targets valuation',
      '{country} {industry} consulting firms technical capabilities staff',
      '{country} companies with Japanese partnership experience {industry}',
    ],
  },
  depth_entryStrategy: {
    name: 'Entry Strategy Analysis',
    slideTitle: '{country} - Entry Strategy Options',
    queries: [
      '{country} foreign {industry} company market entry modes JV acquisition',
      '{country} joint venture requirements foreign companies {industry}',
      '{country} successful greenfield {industry} company examples',
      '{country} acquisition targets {industry} services companies',
      '{country} investment promotion benefits foreign {industry} investment timeline',
    ],
  },
  depth_implementation: {
    name: 'Implementation Considerations',
    slideTitle: '{country} - Implementation Roadmap',
    queries: [
      '{country} company registration process foreign {industry} business timeline',
      '{country} investment promotion application approval process duration',
      '{country} hiring {industry} professionals technical staff availability salary',
      '{country} office facility costs major cities provinces',
      '{country} business license permits {industry} company requirements',
    ],
  },
  depth_targetSegments: {
    name: 'Target Customer Segments',
    slideTitle: '{country} - Target Segments',
    queries: [
      '{country} largest {industry} consumers companies facilities list',
      '{country} industrial estates zones highest {industry} demand',
      '{country} sectors highest {industry} spending consumption',
      '{country} companies required {industry} compliance audits status',
      '{country} Japanese companies presence operations list',
    ],
  },

  // === INSIGHT & INTELLIGENCE QUERIES (for non-obvious insights) ===
  insight_failures: {
    name: 'Failures & Lessons Learned',
    slideTitle: '{country} - Market Lessons',
    queries: [
      '{country} {industry} contract failures cancelled terminated projects reasons',
      '{country} foreign {industry} company exit withdrew market why reasons',
      '{country} {industry} project disputes legal cases arbitration',
      '{country} {industry} joint venture breakup dissolution reasons lessons',
      '{country} failed {industry} investments losses write-offs foreign companies',
    ],
  },
  insight_timing: {
    name: 'Timing & Triggers',
    slideTitle: '{country} - Market Timing',
    queries: [
      '{country} investment incentives expiration deadline upcoming',
      '{country} {industry} regulatory changes implementation timeline 2025 2026',
      '{country} {industry} regulation changes upcoming 2025 2026 new requirements',
      '{country} {industry} targets deadline compliance 2030',
      '{country} {industry} mandate enforcement upcoming 2024 2025',
    ],
  },
  insight_competitive: {
    name: 'Competitive Intelligence',
    slideTitle: '{country} - Competitive Dynamics',
    queries: [
      '{country} {industry} companies seeking acquisition buyers sale',
      '{country} {industry} companies looking for foreign technology partners',
      '{country} {industry} competitor weaknesses complaints dissatisfaction',
      '{country} underserved regions provinces {industry} services gap',
      '{country} {industry} pricing pressure margins profitability',
    ],
  },
  insight_regulatory: {
    name: 'Regulatory Reality',
    slideTitle: '{country} - Regulatory Enforcement',
    queries: [
      '{country} {industry} enforcement rate actual compliance statistics',
      '{country} {industry} regulation violations penalties fines cases',
      '{country} {industry} regulatory capacity inspectors auditors',
      '{country} {industry} policy enforcement selective industries targeted',
      '{country} regulatory relationships government connections importance {industry}',
    ],
  },
};

// Research topic groups for efficient parallel processing
const RESEARCH_TOPIC_GROUPS = {
  policy: ['policy_foundationalActs', 'policy_nationalPolicy', 'policy_investmentRestrictions'],
  market: [
    'market_size',
    'market_demand',
    'market_supplyChain',
    'market_adjacentServices',
    'market_pricing',
    'market_services',
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
    'depth_dealEconomics',
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

const CURRENT_YEAR = new Date().getFullYear();
const REQUIRED_FRAMEWORK_CATEGORIES = [
  'policy',
  'market',
  'competitors',
  'context',
  'depth',
  'insights',
];

function isOilGasScope(scope) {
  const industry = String(scope?.industry || '').toLowerCase();
  return /\boil\b|\bgas\b|petroleum|lng|oilfield|upstream|downstream/.test(industry);
}

function allowsRenewables(scope) {
  const industry = String(scope?.industry || '').toLowerCase();
  return /\brenewable\b|\bsolar\b|\bwind\b|\bclean energy\b/.test(industry);
}

function hasOffScopeAdjacentTerms(text) {
  const value = String(text || '').toLowerCase();
  return [
    /\boffshore wind\b/,
    /\bwind farm\b/,
    /\bsolar\b/,
    /\bphotovoltaic\b/,
    /\bbattery\b/,
    /\belectric vehicle\b/,
    /\bev\b/,
    /\bretail electricity market\b/,
    /\bhydrogen\b/,
  ].some((re) => re.test(value));
}

function stripFutureYears(query) {
  return String(query || '')
    .replace(/\b20\d{2}\b/g, (yearText) => {
      const year = Number(yearText);
      return Number.isFinite(year) && year <= CURRENT_YEAR ? yearText : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureCountryPlaceholder(query) {
  const text = String(query || '');
  return text.includes('{country}') ? text : `{country} ${text}`.trim();
}

function buildFallbackQuery(scope, category, topicName, variant = 0) {
  const industry = String(scope?.industry || 'industry').trim();
  const topic = String(topicName || category || 'market topic').trim();
  const suffixes = [
    'official statistics report',
    'government regulation licensing',
    'top companies market share',
    'pricing cost benchmark',
    'project pipeline investment',
  ];
  const suffix = suffixes[variant % suffixes.length];
  return `{country} ${industry} ${topic} ${suffix}`.replace(/\s+/g, ' ').trim();
}

function sanitizeQuery(scope, category, topicName, query, variant = 0) {
  const oilGas = isOilGasScope(scope);
  const renewableAllowed = allowsRenewables(scope);

  let cleaned = ensureCountryPlaceholder(query || '');
  cleaned = stripFutureYears(cleaned);
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned) cleaned = buildFallbackQuery(scope, category, topicName, variant);

  if (oilGas && !renewableAllowed && hasOffScopeAdjacentTerms(cleaned)) {
    cleaned = buildFallbackQuery(scope, category, topicName, variant);
  }

  // Keep query anchored to the declared industry.
  const industry = String(scope?.industry || '').trim();
  if (industry && !cleaned.toLowerCase().includes(industry.toLowerCase())) {
    cleaned = `${cleaned} ${industry}`.replace(/\s+/g, ' ').trim();
  }

  return cleaned;
}

function normalizeTopicName(scope, category, topicName) {
  const base = String(topicName || '').trim() || 'Research Topic';
  const oilGas = isOilGasScope(scope);
  const renewableAllowed = allowsRenewables(scope);
  if (oilGas && !renewableAllowed && hasOffScopeAdjacentTerms(base)) {
    if (category === 'market') return 'Core Oil & Gas Services Dynamics';
    if (category === 'depth') return 'Oil & Gas Entry Economics';
    return 'Oil & Gas Market Entry Priorities';
  }
  return base;
}

function sanitizeFrameworkOutput(scope, framework) {
  const out = {};

  for (const category of REQUIRED_FRAMEWORK_CATEGORIES) {
    const rawTopics = Array.isArray(framework?.[category]?.topics)
      ? framework[category].topics
      : [];
    const sanitizedTopics = rawTopics
      .map((topic, topicIdx) => {
        const topicName = normalizeTopicName(
          scope,
          category,
          topic?.name || `${category} topic ${topicIdx + 1}`
        );
        const rawQueries = Array.isArray(topic?.queries) ? topic.queries : [];
        const uniqueQueries = [];
        const seen = new Set();

        for (let i = 0; i < rawQueries.length; i++) {
          const q = sanitizeQuery(scope, category, topicName, rawQueries[i], i);
          const norm = q.toLowerCase();
          if (!q || seen.has(norm)) continue;
          seen.add(norm);
          uniqueQueries.push(q);
          if (uniqueQueries.length >= 5) break;
        }

        let variant = rawQueries.length;
        while (uniqueQueries.length < 5) {
          const q = sanitizeQuery(scope, category, topicName, '', variant++);
          const norm = q.toLowerCase();
          if (!seen.has(norm)) {
            seen.add(norm);
            uniqueQueries.push(q);
          }
          if (variant > 12) break;
        }

        if (uniqueQueries.length === 0) return null;
        return {
          name: topicName,
          queries: uniqueQueries.slice(0, 5),
        };
      })
      .filter(Boolean);

    if (sanitizedTopics.length === 0) {
      const fallbackTopic = normalizeTopicName(scope, category, `${category} core analysis`);
      sanitizedTopics.push({
        name: fallbackTopic,
        queries: Array.from({ length: 5 }, (_, i) =>
          sanitizeQuery(scope, category, fallbackTopic, '', i)
        ),
      });
    }

    out[category] = { topics: sanitizedTopics };
  }

  return out;
}

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

CRITICAL RULES:
- Stay focused on "${scope.industry}" specifically. Do NOT drift into adjacent industries or upstream/downstream sectors unless directly relevant
- Each topic should have at least 5 very specific search queries that seek NUMBERS, NAMES, and DATES — not general overviews
- Queries should target government reports, industry associations, IEA/World Bank data, company filings — authoritative sources
- For market topics, include: market size (USD), growth rates (CAGR), supply/demand data, pricing data, import/export volumes
- For competitor topics, include queries for specific company names, market share %, revenue, M&A activity, joint ventures

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
6. Total: EXACTLY 6 categories — policy, market, competitors, context, depth, insights. No more, no fewer. 3-5 topics per category, 5 queries per topic (25 total topics minimum)
7. The "context" category must have 3 topics: macroeconomic context, market opportunities/white spaces, and key risks/barriers
8. Categories MUST be exactly: policy, market, competitors, context, depth, insights — the synthesis pipeline depends on these exact 6 names

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

    framework = sanitizeFrameworkOutput(scope, framework);

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
  const fallback = {
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
            `{country} investment promotion board ${industry} foreign investor benefits`,
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
          name: 'Supply Chain & Infrastructure',
          queries: [
            `{country} ${industry} supply chain infrastructure overview`,
            `{country} ${industry} distribution logistics network coverage`,
            `{country} ${industry} capacity production facilities installed`,
            `{country} ${industry} infrastructure modernization investment plans`,
            `{country} ${industry} import export trade statistics`,
          ],
        },
        {
          name: 'Adjacent Services & Ecosystem',
          queries: [
            `{country} ${industry} professional services consulting market`,
            `{country} ${industry} technology solutions providers`,
            `{country} ${industry} outsourcing managed services market`,
            `{country} ${industry} support services maintenance aftermarket`,
            `{country} ${industry} digital transformation adoption trends`,
          ],
        },
        {
          name: 'Pricing & Cost Structure',
          queries: [
            `{country} ${industry} pricing benchmarks cost per unit`,
            `{country} ${industry} price comparison regional competitors`,
            `{country} ${industry} cost structure breakdown margins`,
            `{country} ${industry} subsidy policy government support reform`,
            `{country} ${industry} pricing forecast 2025 trends`,
          ],
        },
        {
          name: 'Specialized Services Market',
          queries: [
            `{country} ${industry} services market size growth providers`,
            `{country} ${industry} performance contracting outsourcing`,
            `{country} ${industry} audit compliance market demand`,
            `{country} ${industry} government mandates targets standards`,
            `{country} ${industry} certification standards adoption rate`,
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
            `{country} ${industry} government promoted projects foreign investors`,
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
            `{country} ${industry} new regulatory requirements implementation schedule`,
            `{country} ${industry} standards harmonization international`,
            `{country} ${industry} enforcement trends crackdown compliance`,
          ],
        },
      ],
    },
  };
  return sanitizeFrameworkOutput(scope, fallback);
}

/**
 * Get the appropriate research framework for a country.
 * Always uses dynamic generation with fallback to hardcoded framework.
 */
async function getResearchFramework(country, scope) {
  // Always dynamic — no country-specific or industry-specific routing
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
