require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const { securityHeaders, rateLimiter, escapeHtml } = require('./shared/security');
const { requestLogger, healthCheck } = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { sendEmailLegacy: sendEmail } = require('./shared/email');
const { createTracker, trackingContext, recordTokens } = require('./shared/tracking');

// Setup global error handlers to prevent crashes
setupGlobalErrorHandlers();

const app = express();
app.use(securityHeaders);
app.use(rateLimiter);
app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Check required environment variables
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'PERPLEXITY_API_KEY',
  'GEMINI_API_KEY',
  'SENDGRID_API_KEY',
  'SENDER_EMAIL',
];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}
if (!process.env.SERPAPI_API_KEY) {
  console.warn('SERPAPI_API_KEY not set - Google search will be skipped');
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.warn('DEEPSEEK_API_KEY not set - Due Diligence reports will use GPT-4.1 fallback');
}
if (!process.env.DEEPGRAM_API_KEY) {
  console.warn('DEEPGRAM_API_KEY not set - Real-time transcription will not work');
}
// Note: ANTHROPIC_API_KEY is optional - V5 uses Gemini + ChatGPT for search/validation

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'missing',
});

// ============ AI TOOLS ============

// Gemini 2.5 Flash-Lite - cost-effective for general tasks ($0.10/$0.40 per 1M tokens)
async function callGemini(prompt) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        timeout: 90000,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `Gemini 2.5 Flash-Lite HTTP error ${response.status}:`,
        errorText.substring(0, 200)
      );
      return '';
    }

    const data = await response.json();

    const usage = data.usageMetadata;
    if (usage) {
      recordTokens('gemini-2.5-flash-lite', usage.promptTokenCount || 0, usage.candidatesTokenCount || 0);
    }

    if (data.error) {
      console.error('Gemini 2.5 Flash-Lite API error:', data.error.message);
      return '';
    }

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!result) {
      console.warn('Gemini 2.5 Flash-Lite returned empty response');
    }
    return result;
  } catch (error) {
    console.error('Gemini 2.5 Flash-Lite error:', error.message);
    return '';
  }
}

// GPT-4.1 fallback function for when Gemini fails
// Gemini 2.5 Pro - Most capable model for critical validation tasks
// Use this for final data accuracy verification where errors are unacceptable
// Claude (Anthropic) - excellent reasoning and analysis
async function callPerplexity(prompt) {
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro', // Upgraded from 'sonar' for better search results
        messages: [{ role: 'user', content: prompt }],
      }),
      timeout: 90000,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Perplexity HTTP error ${response.status}:`, errorText.substring(0, 200));
      return '';
    }

    const data = await response.json();

    if (data.usage) {
      recordTokens('sonar-pro', data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0);
    }

    if (data.error) {
      console.error('Perplexity API error:', data.error.message || data.error);
      return '';
    }

    const result = data.choices?.[0]?.message?.content || '';
    if (!result) {
      console.warn('Perplexity returned empty response for prompt:', prompt.substring(0, 100));
    }
    return result;
  } catch (error) {
    console.error('Perplexity error:', error.message);
    return '';
  }
}

async function callChatGPT(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });
    if (response.usage) {
      recordTokens('gpt-4.1', response.usage.prompt_tokens || 0, response.usage.completion_tokens || 0);
    }
    const result = response.choices[0].message.content || '';
    if (!result) {
      console.warn('ChatGPT returned empty response for prompt:', prompt.substring(0, 100));
    }
    return result;
  } catch (error) {
    console.error('ChatGPT error:', error.message);
    return '';
  }
}

// OpenAI Search model - has real-time web search capability
// Updated to use gpt-5-search-api (more stable than mini version)
async function callOpenAISearch(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5-search-api',
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.usage) {
      recordTokens('gpt-5-search-api', response.usage.prompt_tokens || 0, response.usage.completion_tokens || 0);
    }
    const result = response.choices[0].message.content || '';
    if (!result) {
      console.warn('OpenAI Search returned empty response, falling back to ChatGPT');
      return callChatGPT(prompt);
    }
    return result;
  } catch (error) {
    console.error('OpenAI Search error:', error.message, '- falling back to ChatGPT');
    // Fallback to regular gpt-4.1 if search model not available
    return callChatGPT(prompt);
  }
}

// SerpAPI - Google Search integration
async function callSerpAPI(query) {
  if (!process.env.SERPAPI_API_KEY) {
    return '';
  }
  try {
    const params = new URLSearchParams({
      q: query,
      api_key: process.env.SERPAPI_API_KEY,
      engine: 'google',
      num: 100, // Get more results
    });
    const response = await fetch(`https://serpapi.com/search?${params}`, {
      timeout: 30000,
    });
    const data = await response.json();

    // Extract organic results
    const results = [];
    if (data.organic_results) {
      for (const result of data.organic_results) {
        results.push({
          title: result.title || '',
          link: result.link || '',
          snippet: result.snippet || '',
        });
      }
    }
    return JSON.stringify(results);
  } catch (error) {
    console.error('SerpAPI error:', error.message);
    return '';
  }
}

// DeepSeek V3.2 - Cost-effective alternative to GPT-4.1
// Detect domain/context from text for domain-aware translation
// Get domain-specific translation instructions
// ============ SEARCH CONFIGURATION ============

const CITY_MAP = {
  malaysia: [
    'Kuala Lumpur',
    'Penang',
    'Johor Bahru',
    'Shah Alam',
    'Petaling Jaya',
    'Selangor',
    'Ipoh',
    'Klang',
    'Subang',
    'Melaka',
    'Kuching',
    'Kota Kinabalu',
  ],
  singapore: ['Singapore', 'Jurong', 'Tuas', 'Woodlands'],
  thailand: [
    'Bangkok',
    'Chonburi',
    'Rayong',
    'Samut Prakan',
    'Ayutthaya',
    'Chiang Mai',
    'Pathum Thani',
    'Nonthaburi',
    'Samut Sakhon',
  ],
  indonesia: [
    'Jakarta',
    'Surabaya',
    'Bandung',
    'Medan',
    'Bekasi',
    'Tangerang',
    'Semarang',
    'Sidoarjo',
    'Cikarang',
    'Karawang',
    'Bogor',
  ],
  vietnam: [
    'Ho Chi Minh City',
    'Hanoi',
    'Da Nang',
    'Hai Phong',
    'Binh Duong',
    'Dong Nai',
    'Long An',
    'Ba Ria',
    'Can Tho',
  ],
  philippines: [
    'Manila',
    'Cebu',
    'Davao',
    'Quezon City',
    'Makati',
    'Laguna',
    'Cavite',
    'Batangas',
    'Bulacan',
  ],
  'southeast asia': [
    'Kuala Lumpur',
    'Singapore',
    'Bangkok',
    'Jakarta',
    'Ho Chi Minh City',
    'Manila',
    'Penang',
    'Johor Bahru',
    'Surabaya',
    'Hanoi',
  ],
};

const LOCAL_SUFFIXES = {
  malaysia: ['Sdn Bhd', 'Berhad'],
  singapore: ['Pte Ltd', 'Private Limited'],
  thailand: ['Co Ltd', 'Co., Ltd.'],
  indonesia: ['PT', 'CV'],
  vietnam: ['Co Ltd', 'JSC', 'Công ty'],
  philippines: ['Inc', 'Corporation'],
};

const DOMAIN_MAP = {
  malaysia: '.my',
  singapore: '.sg',
  thailand: '.th',
  indonesia: '.co.id',
  vietnam: '.vn',
  philippines: '.ph',
};

const LOCAL_LANGUAGE_MAP = {
  thailand: { lang: 'Thai', examples: ['หมึก', 'สี', 'เคมี'] },
  vietnam: { lang: 'Vietnamese', examples: ['mực in', 'sơn', 'hóa chất'] },
  indonesia: { lang: 'Bahasa Indonesia', examples: ['tinta', 'cat', 'kimia'] },
  philippines: { lang: 'Tagalog', examples: ['tinta', 'pintura'] },
  malaysia: { lang: 'Bahasa Malaysia', examples: ['dakwat', 'cat'] },
};

// ============ 14 SPECIALIZED SEARCH STRATEGIES (inspired by n8n workflow) ============

function buildOutputFormat() {
  return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
}

// Strategy 1: Broad Google Search (SerpAPI)
function strategy1_BroadSerpAPI(business, country, _exclusion) {
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  // Generate synonyms and variations
  const terms = business
    .split(/\s+or\s+|\s+and\s+|,/)
    .map((t) => t.trim())
    .filter((t) => t);

  for (const c of countries) {
    queries.push(
      `${business} companies ${c}`,
      `${business} manufacturers ${c}`,
      `${business} suppliers ${c}`,
      `list of ${business} companies in ${c}`,
      `${business} industry ${c}`
    );
    for (const term of terms) {
      queries.push(`${term} ${c}`);
    }
  }

  return queries;
}

// Strategy 2: Broad Perplexity Search (EXPANDED)
function strategy2_BroadPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  // General queries
  queries.push(
    `Find ALL ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Complete list of ${business} manufacturers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} producers and makers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `All local ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `SME and family-owned ${business} businesses in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Independent ${business} companies in ${country} not owned by multinationals. ${outputFormat}`
  );

  // Per-country queries for more specificity
  for (const c of countries) {
    queries.push(
      `List all ${business} companies based in ${c}. ${outputFormat}`,
      `${business} factories and plants in ${c}. ${outputFormat}`,
      `Local ${business} manufacturers in ${c}. ${outputFormat}`
    );
  }

  return queries;
}

// Strategy 3: Lists, Rankings, Top Companies (SerpAPI)
function strategy3_ListsSerpAPI(business, country, _exclusion) {
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  for (const c of countries) {
    queries.push(
      `top ${business} companies ${c}`,
      `biggest ${business} ${c}`,
      `leading ${business} manufacturers ${c}`,
      `list of ${business} ${c}`,
      `best ${business} suppliers ${c}`,
      `${business} industry ${c} overview`,
      `major ${business} players ${c}`
    );
  }

  return queries;
}

// Strategy 4: City-Specific Search (Perplexity) - EXPANDED to ALL cities
function strategy4_CitiesPerplexity(business, country, exclusion) {
  const countries = country.split(',').map((c) => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  for (const c of countries) {
    const cities = CITY_MAP[c.toLowerCase()] || [c];
    // Use ALL cities, not just top 5
    for (const city of cities) {
      queries.push(
        `${business} companies in ${city}, ${c}. Exclude ${exclusion}. ${outputFormat}`,
        `${business} manufacturers near ${city}. ${outputFormat}`
      );
    }
  }

  return queries;
}

// Strategy 5: Industrial Zones + Local Naming (SerpAPI)
function strategy5_IndustrialSerpAPI(business, country, _exclusion) {
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  for (const c of countries) {
    const suffixes = LOCAL_SUFFIXES[c.toLowerCase()] || [];

    // Local naming conventions
    for (const suffix of suffixes) {
      queries.push(`${business} ${suffix} ${c}`);
    }

    // Industrial zones
    queries.push(
      `${business} industrial estate ${c}`,
      `${business} manufacturing zone ${c}`,
      `${business} factory ${c}`
    );
  }

  return queries;
}

// Strategy 6: Associations & Directories (Perplexity)
function strategy6_DirectoriesPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} companies in trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} firms in Kompass directory for ${country}. Not ${exclusion}. ${outputFormat}`,
    `Chamber of commerce ${business} members in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${country} ${business} industry association member list. No ${exclusion}. ${outputFormat}`,
    `${business} companies on Yellow Pages ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} business directory ${country}. Exclude ${exclusion}. ${outputFormat}`,
  ];
}

// Strategy 7: Trade Shows & Exhibitions (Perplexity)
function strategy7_ExhibitionsPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} exhibitors at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies at industry exhibitions in ${country} region. Not ${exclusion}. ${outputFormat}`,
    `${business} participants at expos and conferences in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors at international fairs from ${country}. Not ${exclusion}. ${outputFormat}`,
  ];
}

// Strategy 8: Import/Export & Supplier Databases (Perplexity)
function strategy8_TradePerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} suppliers on Alibaba from ${country}. Not ${exclusion}. ${outputFormat}`,
    `${country} ${business} companies on Global Sources. Exclude ${exclusion}. ${outputFormat}`,
    `${business} OEM suppliers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} contract manufacturers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} approved vendors in ${country}. Exclude ${exclusion}. ${outputFormat}`,
  ];
}

// Strategy 9: Local Domains + News (Perplexity)
function strategy9_DomainsPerplexity(business, country, exclusion) {
  const countries = country.split(',').map((c) => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  for (const c of countries) {
    const domain = DOMAIN_MAP[c.toLowerCase()];
    if (domain) {
      queries.push(
        `${business} companies with ${domain} websites. Exclude ${exclusion}. ${outputFormat}`
      );
    }
  }

  queries.push(
    `Recent news about ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} company announcements and press releases ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  return queries;
}

// Strategy 10: Government Registries (SerpAPI)
function strategy10_RegistriesSerpAPI(business, country, _exclusion) {
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  for (const c of countries) {
    queries.push(
      `${business} company registration ${c}`,
      `${business} registered companies ${c}`,
      `${business} business registry ${c}`
    );
  }

  return queries;
}

// Strategy 11: City + Industrial Areas (SerpAPI) - EXPANDED
function strategy11_CityIndustrialSerpAPI(business, country, _exclusion) {
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  for (const c of countries) {
    const cities = CITY_MAP[c.toLowerCase()] || [c];
    // Use ALL cities
    for (const city of cities) {
      queries.push(
        `${business} ${city}`,
        `${business} companies ${city}`,
        `${business} factory ${city}`,
        `${business} manufacturer ${city}`
      );
    }
  }

  return queries;
}

// Strategy 12: Deep Web Search (OpenAI Search) - EXPANDED with real-time search
function strategy12_DeepOpenAISearch(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  // General deep searches
  queries.push(
    `Search the web for ${business} companies in ${country}. Find company websites, LinkedIn profiles, industry directories. Exclude ${exclusion}. ${outputFormat}`,
    `Find lesser-known ${business} companies in ${country} that may not appear in top search results. ${outputFormat}`,
    `Search for small and medium ${business} enterprises (SMEs) in ${country}. ${outputFormat}`,
    `Find independent local ${business} companies in ${country}, not subsidiaries of multinationals. ${outputFormat}`,
    `Search industry news and press releases for ${business} companies in ${country}. ${outputFormat}`,
    `Find ${business} startups and new companies in ${country}. ${outputFormat}`
  );

  // Per-country deep searches
  for (const c of countries) {
    queries.push(
      `Search for all ${business} manufacturers in ${c}. Include company name, website, and location. ${outputFormat}`,
      `Find ${business} producers in ${c} with their official websites. ${outputFormat}`
    );
  }

  return queries;
}

// Strategy 13: Industry Publications (Perplexity)
function strategy13_PublicationsPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} companies mentioned in industry magazines and trade publications for ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} market report ${country} - list all companies mentioned. Not ${exclusion}. ${outputFormat}`,
    `${business} industry analysis ${country} - companies covered. Exclude ${exclusion}. ${outputFormat}`,
    `${business} ${country} magazine articles listing companies. Not ${exclusion}. ${outputFormat}`,
  ];
}

// Strategy 14: Final Sweep - Local Language + Comprehensive (OpenAI Search)
function strategy14_LocalLanguageOpenAISearch(business, country, _exclusion) {
  const countries = country.split(',').map((c) => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  // Local language searches
  queries.push(
    `Search for ${business} companies in ${country} using local language terms. Translate "${business}" to Thai, Vietnamese, Bahasa Indonesia, Tagalog, Malay as appropriate. ${outputFormat}`
  );

  for (const c of countries) {
    const langInfo = LOCAL_LANGUAGE_MAP[c.toLowerCase()];
    if (langInfo) {
      queries.push(
        `Search in ${langInfo.lang} for ${business} companies in ${c}. ${outputFormat}`,
        `Find ${business} manufacturers in ${c} using local language search terms. ${outputFormat}`
      );
    }
  }

  // Supply chain and related industry searches
  queries.push(
    `Find companies in the ${business} supply chain in ${country}. Include raw material suppliers and equipment makers. ${outputFormat}`,
    `Search for ${business} related companies in ${country}: formulators, blenders, repackagers. ${outputFormat}`,
    `Find niche and specialty ${business} companies in ${country}. ${outputFormat}`
  );

  // Final comprehensive sweep
  queries.push(
    `Comprehensive search: Find ALL ${business} companies in ${country} that have not been mentioned yet. Search obscure directories, local business listings, industry forums. ${outputFormat}`
  );

  return queries;
}

// ============ EXTRACTION WITH GPT-4.1-nano ============

async function extractCompanies(text, country) {
  if (!text || text.length < 50) return [];
  try {
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4.1-nano',
      messages: [
        {
          role: 'system',
          content: `Extract company information from the text. Return JSON: {"companies": [{"company_name": "...", "website": "...", "hq": "..."}]}

RULES:
- Extract ALL companies mentioned that could be in: ${country}
- website must start with http:// or https://
- If website not in text, you may look it up if you know it's a real company
- hq must be "City, Country" format ONLY
- Include companies even if some info is incomplete - we'll verify later
- Be thorough - extract every company that might match`,
        },
        { role: 'user', content: text.substring(0, 15000) },
      ],
      response_format: { type: 'json_object' },
    });
    if (extraction.usage) {
      recordTokens('gpt-4.1-nano', extraction.usage.prompt_tokens || 0, extraction.usage.completion_tokens || 0);
    }
    const parsed = JSON.parse(extraction.choices[0].message.content);
    return Array.isArray(parsed.companies) ? parsed.companies : [];
  } catch (e) {
    console.error('Extraction error:', e.message);
    return [];
  }
}

// ============ DEDUPLICATION (Enhanced for v20) ============

function normalizeCompanyName(name) {
  if (!name) return '';
  return (
    name
      .toLowerCase()
      // Remove ALL common legal suffixes globally (expanded list)
      .replace(
        /\s*(sdn\.?\s*bhd\.?|bhd\.?|berhad|pte\.?\s*ltd\.?|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|co\.?,?\s*ltd\.?|llc|llp|gmbh|s\.?a\.?|pt\.?|cv\.?|tbk\.?|jsc|plc|public\s*limited|private\s*limited|joint\s*stock|company|\(.*?\))$/gi,
        ''
      )
      // Also remove these if they appear anywhere (for cases like "PT Company Name")
      .replace(/^(pt\.?|cv\.?)\s+/gi, '')
      .replace(/[^\w\s]/g, '') // Remove special characters
      .replace(/\s+/g, ' ') // Normalize spaces
      .trim()
  );
}

function normalizeWebsite(url) {
  if (!url) return '';
  return (
    url
      .toLowerCase()
      .replace(/^https?:\/\//, '') // Remove protocol
      .replace(/^www\./, '') // Remove www
      .replace(/\/+$/, '') // Remove trailing slashes
      // Remove common path suffixes that don't differentiate companies
      .replace(
        /\/(home|index|main|default|about|about-us|contact|products?|services?|en|th|id|vn|my|sg|ph|company)(\/.*)?$/i,
        ''
      )
      .replace(/\.(html?|php|aspx?|jsp)$/i, '')
  ); // Remove file extensions
}

// Extract domain root for additional deduplication
function extractDomainRoot(url) {
  const normalized = normalizeWebsite(url);
  // Get just the domain without any path
  return normalized.split('/')[0];
}

function dedupeCompanies(allCompanies) {
  const seenWebsites = new Map();
  const seenDomains = new Map();
  const seenNames = new Map();
  const results = [];

  for (const c of allCompanies) {
    if (!c || !c.website || !c.company_name) continue;
    if (!c.website.startsWith('http')) continue;

    const websiteKey = normalizeWebsite(c.website);
    const domainKey = extractDomainRoot(c.website);
    const nameKey = normalizeCompanyName(c.company_name);

    // Skip if we've seen this exact URL, domain, or normalized name
    if (seenWebsites.has(websiteKey)) continue;
    if (seenDomains.has(domainKey)) continue;
    if (nameKey && seenNames.has(nameKey)) continue;

    seenWebsites.set(websiteKey, true);
    seenDomains.set(domainKey, true);
    if (nameKey) seenNames.set(nameKey, true);
    results.push(c);
  }

  return results;
}

// ============ PRE-FILTER: Remove only obvious non-company URLs ============

function isSpamOrDirectoryURL(url) {
  if (!url) return true;
  const urlLower = url.toLowerCase();

  // Only filter out obvious non-company URLs (very conservative)
  const obviousSpam = [
    'wikipedia.org',
    'facebook.com',
    'twitter.com',
    'instagram.com',
    'youtube.com',
  ];

  for (const pattern of obviousSpam) {
    if (urlLower.includes(pattern)) return true;
  }

  return false;
}

function preFilterCompanies(companies) {
  return companies.filter((c) => {
    if (!c || !c.website) return false;
    if (isSpamOrDirectoryURL(c.website)) {
      console.log(`    Pre-filtered: ${c.company_name} - Social media/wiki`);
      return false;
    }
    return true;
  });
}

// ============ EXHAUSTIVE PARALLEL SEARCH WITH 14 STRATEGIES ============

// Process SerpAPI results and extract companies using GPT
async function processSerpResults(serpResults, business, country, exclusion) {
  if (!serpResults || serpResults.length === 0) return [];

  const outputFormat = buildOutputFormat();
  const prompt = `From these Google search results, extract companies that match:
- Business: ${business}
- Country: ${country}
- Exclude: ${exclusion}

Search Results:
${serpResults.join('\n\n')}

${outputFormat}`;

  const response = await callChatGPT(prompt);
  return extractCompanies(response, country);
}

async function exhaustiveSearch(business, country, exclusion) {
  console.log('Starting EXHAUSTIVE 14-STRATEGY PARALLEL search...');
  const startTime = Date.now();

  // Generate all queries for each strategy
  const serpQueries1 = strategy1_BroadSerpAPI(business, country, exclusion);
  const perpQueries2 = strategy2_BroadPerplexity(business, country, exclusion);
  const serpQueries3 = strategy3_ListsSerpAPI(business, country, exclusion);
  const perpQueries4 = strategy4_CitiesPerplexity(business, country, exclusion);
  const serpQueries5 = strategy5_IndustrialSerpAPI(business, country, exclusion);
  const perpQueries6 = strategy6_DirectoriesPerplexity(business, country, exclusion);
  const perpQueries7 = strategy7_ExhibitionsPerplexity(business, country, exclusion);
  const perpQueries8 = strategy8_TradePerplexity(business, country, exclusion);
  const perpQueries9 = strategy9_DomainsPerplexity(business, country, exclusion);
  const serpQueries10 = strategy10_RegistriesSerpAPI(business, country, exclusion);
  const serpQueries11 = strategy11_CityIndustrialSerpAPI(business, country, exclusion);
  const openaiQueries12 = strategy12_DeepOpenAISearch(business, country, exclusion);
  const perpQueries13 = strategy13_PublicationsPerplexity(business, country, exclusion);
  const openaiQueries14 = strategy14_LocalLanguageOpenAISearch(business, country, exclusion);

  const allSerpQueries = [
    ...serpQueries1,
    ...serpQueries3,
    ...serpQueries5,
    ...serpQueries10,
    ...serpQueries11,
  ];
  const allPerpQueries = [
    ...perpQueries2,
    ...perpQueries4,
    ...perpQueries6,
    ...perpQueries7,
    ...perpQueries8,
    ...perpQueries9,
    ...perpQueries13,
  ];
  const allOpenAISearchQueries = [...openaiQueries12, ...openaiQueries14];

  console.log(`  Strategy breakdown:`);
  console.log(`    SerpAPI (Google): ${allSerpQueries.length} queries`);
  console.log(`    Perplexity: ${allPerpQueries.length} queries`);
  console.log(`    OpenAI Search: ${allOpenAISearchQueries.length} queries`);
  console.log(
    `    Total: ${allSerpQueries.length + allPerpQueries.length + allOpenAISearchQueries.length}`
  );

  // Run all strategies in parallel (with error handling to prevent one failure from crashing all)
  const [serpResults, perpResults, openaiSearchResults, geminiResults] = await Promise.all([
    // SerpAPI queries
    process.env.SERPAPI_API_KEY
      ? Promise.all(
          allSerpQueries.map((q) =>
            callSerpAPI(q).catch((e) => {
              console.error(`SerpAPI error: ${e.message}`);
              return null;
            })
          )
        )
      : Promise.resolve([]),

    // Perplexity queries
    Promise.all(
      allPerpQueries.map((q) =>
        callPerplexity(q).catch((e) => {
          console.error(`Perplexity error: ${e.message}`);
          return null;
        })
      )
    ),

    // OpenAI Search queries
    Promise.all(
      allOpenAISearchQueries.map((q) =>
        callOpenAISearch(q).catch((e) => {
          console.error(`OpenAI Search error: ${e.message}`);
          return null;
        })
      )
    ),

    // Also run some Gemini queries for diversity
    Promise.all(
      [
        callGemini(
          `Find ALL ${business} companies in ${country}. Exclude ${exclusion}. ${buildOutputFormat()}`
        ),
        callGemini(
          `List ${business} factories and manufacturing plants in ${country}. Not ${exclusion}. ${buildOutputFormat()}`
        ),
        callGemini(
          `${business} SME and family businesses in ${country}. Exclude ${exclusion}. ${buildOutputFormat()}`
        ),
      ].map((p) =>
        p.catch((e) => {
          console.error(`Gemini error: ${e.message}`);
          return null;
        })
      )
    ),
  ]);

  console.log(`  All API calls done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Process SerpAPI results through GPT for extraction
  let serpCompanies = [];
  if (serpResults.length > 0) {
    console.log(`  Processing ${serpResults.filter((r) => r).length} SerpAPI results...`);
    serpCompanies = await processSerpResults(
      serpResults.filter((r) => r),
      business,
      country,
      exclusion
    );
    console.log(`    Extracted ${serpCompanies.length} companies from SerpAPI`);
  }

  // Extract from Perplexity results
  console.log(`  Extracting from ${perpResults.length} Perplexity results...`);
  const perpExtractions = await Promise.all(
    perpResults
      .filter((r) => r)
      .map((text) =>
        extractCompanies(text, country).catch((e) => {
          console.error(`Extraction error: ${e.message}`);
          return [];
        })
      )
  );
  const perpCompanies = perpExtractions.flat();
  console.log(`    Extracted ${perpCompanies.length} companies from Perplexity`);

  // Extract from OpenAI Search results
  console.log(`  Extracting from ${openaiSearchResults.length} OpenAI Search results...`);
  const openaiExtractions = await Promise.all(
    openaiSearchResults
      .filter((r) => r)
      .map((text) =>
        extractCompanies(text, country).catch((e) => {
          console.error(`Extraction error: ${e.message}`);
          return [];
        })
      )
  );
  const openaiCompanies = openaiExtractions.flat();
  console.log(`    Extracted ${openaiCompanies.length} companies from OpenAI Search`);

  // Extract from Gemini results
  console.log(`  Extracting from ${geminiResults.length} Gemini results...`);
  const geminiExtractions = await Promise.all(
    geminiResults
      .filter((r) => r)
      .map((text) =>
        extractCompanies(text, country).catch((e) => {
          console.error(`Extraction error: ${e.message}`);
          return [];
        })
      )
  );
  const geminiCompanies = geminiExtractions.flat();
  console.log(`    Extracted ${geminiCompanies.length} companies from Gemini`);

  // Combine and dedupe all
  const allCompanies = [...serpCompanies, ...perpCompanies, ...openaiCompanies, ...geminiCompanies];
  const uniqueCompanies = dedupeCompanies(allCompanies);

  console.log(`  Raw total: ${allCompanies.length}, Unique: ${uniqueCompanies.length}`);
  console.log(`Search completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return uniqueCompanies;
}

// ============ WEBSITE VERIFICATION ============

// ============ FETCH WEBSITE FOR VALIDATION ============

async function fetchWebsite(url) {
  // Security block patterns - these indicate WAF/Cloudflare/bot protection
  const securityBlockPatterns = [
    'checking your browser',
    'please wait',
    'just a moment',
    'ddos protection',
    'cloudflare',
    'security check',
    'access denied',
    'not acceptable',
    'mod_security',
    'forbidden',
    'blocked',
    'captcha',
    'verify you are human',
    'bot detection',
    'please enable javascript',
    'enable cookies',
  ];

  const tryFetch = async (targetUrl) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000); // Increased to 20 seconds
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          Connection: 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timeout);

      // Check for HTTP-level blocks
      if (response.status === 403 || response.status === 406) {
        return {
          status: 'security_blocked',
          reason: `HTTP ${response.status} - WAF/Security block`,
        };
      }
      if (!response.ok) return { status: 'error', reason: `HTTP ${response.status}` };

      const html = await response.text();
      const lowerHtml = html.toLowerCase();

      // Check for security block patterns in content
      for (const pattern of securityBlockPatterns) {
        if (lowerHtml.includes(pattern) && html.length < 5000) {
          // Only flag as security block if page is small (likely a challenge page)
          return {
            status: 'security_blocked',
            reason: `Security protection detected: "${pattern}"`,
          };
        }
      }

      const cleanText = html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 15000);

      if (cleanText.length > 100) {
        return { status: 'ok', content: cleanText };
      }
      return { status: 'insufficient', reason: 'Content too short' };
    } catch (e) {
      return { status: 'error', reason: e.message || 'Connection failed' };
    }
  };

  // Parse base URL
  let baseUrl = url;
  try {
    const parsed = new URL(url);
    baseUrl = `${parsed.protocol}//${parsed.host}`;
  } catch (e) {
    baseUrl = url.replace(/\/+$/, '');
  }

  // Try original URL first
  let result = await tryFetch(url);
  if (result.status === 'ok') return result;
  if (result.status === 'security_blocked') return result; // Return security block immediately

  // Try with/without www
  const hasWww = baseUrl.includes('://www.');
  const altBaseUrl = hasWww ? baseUrl.replace('://www.', '://') : baseUrl.replace('://', '://www.');

  // Try alternative paths on BOTH original and www/non-www variants
  const urlVariants = [baseUrl, altBaseUrl];
  const urlPaths = ['', '/en', '/home', '/about', '/index.html', '/index.php'];

  for (const variant of urlVariants) {
    for (const path of urlPaths) {
      const testUrl = variant + path;
      result = await tryFetch(testUrl);
      if (result.status === 'ok') return result;
      if (result.status === 'security_blocked') return result;
    }
  }

  // Try HTTPS if original was HTTP (on both variants)
  if (url.startsWith('http://')) {
    for (const variant of urlVariants) {
      const httpsVariant = variant.replace('http://', 'https://');
      result = await tryFetch(httpsVariant);
      if (result.status === 'ok') return result;
      if (result.status === 'security_blocked') return result;
    }
  }

  return { status: 'inaccessible', reason: 'Could not fetch content from any URL variation' };
}

// ============ DYNAMIC EXCLUSION RULES BUILDER (n8n-style PAGE SIGNAL detection) ============

function buildExclusionRules(exclusion, _business) {
  const exclusionLower = exclusion.toLowerCase();
  let rules = '';

  // Detect if user wants to exclude LARGE companies - use PAGE SIGNALS like n8n
  if (
    exclusionLower.includes('large') ||
    exclusionLower.includes('big') ||
    exclusionLower.includes('mnc') ||
    exclusionLower.includes('multinational') ||
    exclusionLower.includes('major') ||
    exclusionLower.includes('giant')
  ) {
    rules += `
LARGE COMPANY DETECTION - Look for these PAGE SIGNALS to REJECT:
- "global presence", "worldwide operations", "global leader", "world's largest"
- Stock ticker symbols or mentions of: NYSE, NASDAQ, SGX, SET, IDX, listed, IPO
- "multinational", "global network", offices/operations in 10+ countries
- Revenue figures >$100M, employee count >1000
- "Fortune 500", "Forbes Global"
- Company name contains known MNC: Toyo Ink, Sakata, Flint, Siegwerk, Sun Chemical, DIC
- Website says "subsidiary of", "part of [X] Group", "member of [X] Group"
- Company name ends with "Tbk" (Indonesian listed)

If NONE of these signals are found → ACCEPT (assume local company)
`;
  }

  // Detect if user wants to exclude LISTED/PUBLIC companies
  if (exclusionLower.includes('listed') || exclusionLower.includes('public')) {
    rules += `
LISTED COMPANY DETECTION - REJECT if page shows:
- Stock ticker, NYSE, NASDAQ, SGX, SET, IDX, or any stock exchange
- "publicly traded", "listed company", "IPO"
- Company name contains "Tbk"
`;
  }

  // Detect if user wants to exclude DISTRIBUTORS
  if (exclusionLower.includes('distributor')) {
    rules += `
DISTRIBUTOR DETECTION - REJECT only if:
- Company ONLY distributes/resells with NO manufacturing
- No mention of factory, plant, production facility, "we manufacture"

ACCEPT if they manufacture (even if also distribute) - most manufacturers also sell their products
`;
  }

  return rules;
}

// ============ VALIDATION (v24 - GPT-4.1 with LENIENT filtering) ============

async function validateCompanyStrict(company, business, country, exclusion, pageText) {
  // If we couldn't fetch the website, validate by name only (give benefit of doubt)
  const contentToValidate =
    typeof pageText === 'string' && pageText
      ? pageText
      : `Company name: ${company.company_name}. Validate based on name only.`;

  const exclusionRules = buildExclusionRules(exclusion, business);

  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4.1', // Use smarter model for better validation
      messages: [
        {
          role: 'system',
          content: `You are a company validator for M&A research. Be LENIENT - when in doubt, ACCEPT.

VALIDATION TASK:
- Business sought: "${business}"
- Target countries: ${country}
- Exclusions: ${exclusion}

VALIDATION RULES:

1. LOCATION CHECK:
- Is HQ in one of the target countries (${country})?
- IMPORTANT: If country is a REGION like "Southeast Asia", accept companies in ANY Southeast Asian country (Malaysia, Thailand, Vietnam, Indonesia, Philippines, Singapore, etc.)
- If HQ is clearly outside the target region → REJECT

2. BUSINESS MATCH (BE LENIENT):
- Does the company's business relate to "${business}"?
- Accept related products, services, manufacturers, suppliers
- Only reject if COMPLETELY unrelated

3. EXCLUSION CHECK:
${exclusionRules}
- For "large companies" exclusion: REJECT both large multinationals AND their subsidiaries
- Example: "DIC Indonesia", "Toyo Ink Philippines", "Sun Chemical" → REJECT (subsidiaries of large corporations)
- Only accept truly independent SMEs and local companies

4. SPAM CHECK:
- Only reject obvious directories, marketplaces, domain-for-sale sites

OUTPUT: Return JSON only: {"valid": true/false, "reason": "one sentence"}`,
        },
        {
          role: 'user',
          content: `COMPANY: ${company.company_name}
WEBSITE: ${company.website}
HQ: ${company.hq}

PAGE CONTENT:
${contentToValidate.substring(0, 10000)}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    if (validation.usage) {
      recordTokens('gpt-4.1', validation.usage.prompt_tokens || 0, validation.usage.completion_tokens || 0);
    }
    const result = JSON.parse(validation.choices[0].message.content);
    if (result.valid === true) {
      return { valid: true, corrected_hq: company.hq };
    }
    console.log(`    Rejected: ${company.company_name} - ${result.reason}`);
    return { valid: false };
  } catch (e) {
    // On error, accept (benefit of doubt)
    console.log(`    Error validating ${company.company_name}, accepting`);
    return { valid: true, corrected_hq: company.hq };
  }
}

async function parallelValidationStrict(companies, business, country, exclusion) {
  console.log(`\nSTRICT Validating ${companies.length} verified companies...`);
  const startTime = Date.now();
  const batchSize = 10; // Increased for better parallelization
  const validated = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    try {
      const batch = companies.slice(i, i + batchSize);
      if (!batch || batch.length === 0) continue;

      // Use cached _pageContent from verification step, or fetch if not available
      // Add .catch() to prevent any single failure from crashing the batch
      const pageTexts = await Promise.all(
        batch.map((c) => {
          try {
            return c?._pageContent
              ? Promise.resolve(c._pageContent)
              : fetchWebsite(c?.website).catch(() => null);
          } catch (e) {
            return Promise.resolve(null);
          }
        })
      );

      // Add .catch() to each validation to prevent single failures from crashing batch
      const validations = await Promise.all(
        batch.map((company, idx) => {
          try {
            return validateCompanyStrict(
              company,
              business,
              country,
              exclusion,
              pageTexts[idx]
            ).catch((e) => {
              console.error(`  Validation error for ${company?.company_name}: ${e.message}`);
              return { valid: true, corrected_hq: company?.hq }; // Accept on error
            });
          } catch (e) {
            return Promise.resolve({ valid: true, corrected_hq: company?.hq });
          }
        })
      );

      batch.forEach((company, idx) => {
        try {
          if (validations[idx]?.valid && company) {
            // Remove internal _pageContent before adding to results
            // eslint-disable-next-line no-unused-vars
            const { _pageContent, ...cleanCompany } = company;
            validated.push({
              ...cleanCompany,
              hq: validations[idx].corrected_hq || company.hq,
            });
          }
        } catch (e) {
          console.error(`  Error processing company ${company?.company_name}: ${e.message}`);
        }
      });

      console.log(
        `  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`
      );
    } catch (batchError) {
      console.error(`  Batch error at ${i}-${i + batchSize}: ${batchError.message}`);
      // Continue to next batch instead of crashing
    }
  }

  console.log(
    `STRICT Validation done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Valid: ${validated.length}`
  );
  return validated;
}

// ============ VALIDATION FOR SLOW MODE (v23 - n8n style) ============

// ============ EMAIL ============

function buildEmailHTML(companies, business, country, exclusion) {
  let html = `
    <h2>Find Target Results</h2>
    <p><strong>Business:</strong> ${escapeHtml(business)}</p>
    <p><strong>Country:</strong> ${escapeHtml(country)}</p>
    <p><strong>Exclusion:</strong> ${escapeHtml(exclusion)}</p>
    <p><strong>Companies Found:</strong> ${companies.length}</p>
    <br>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #f0f0f0;">
        <tr><th>#</th><th>Company</th><th>Website</th><th>Headquarters</th></tr>
      </thead>
      <tbody>
  `;
  companies.forEach((c, i) => {
    html += `<tr><td>${i + 1}</td><td>${escapeHtml(c.company_name)}</td><td><a href="${escapeHtml(c.website)}">${escapeHtml(c.website)}</a></td><td>${escapeHtml(c.hq)}</td></tr>`;
  });
  html += '</tbody></table>';
  return html;
}

// ============ FAST ENDPOINT ============

// ============ V4 ULTRA-EXHAUSTIVE ENDPOINT ============

// Ask AI to expand a region into individual countries (no hardcoding)
async function expandRegionToCountries(region) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-nano',
      messages: [
        {
          role: 'system',
          content: `You help identify countries in geographic regions. Return a JSON array of country names only.`,
        },
        {
          role: 'user',
          content: `If "${region}" is a geographic region (like "Southeast Asia", "Europe", "Middle East"), list only the MAJOR MARKETS in it.
For Southeast Asia: Malaysia, Thailand, Indonesia, Vietnam, Philippines, Singapore (exclude Cambodia, Laos, Myanmar, Brunei unless explicitly mentioned).
For other regions: focus on the main industrial/commercial markets, not every small country.
If "${region}" is already a single country, just return that country.
Return ONLY a JSON array of country names, nothing else.
Example: ["Malaysia", "Thailand", "Indonesia"]`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    if (response.usage) {
      recordTokens('gpt-4.1-nano', response.usage.prompt_tokens || 0, response.usage.completion_tokens || 0);
    }
    const result = JSON.parse(response.choices[0].message.content);
    const countries = result.countries || result;

    if (Array.isArray(countries) && countries.length > 0) {
      console.log(`  Region "${region}" expanded to: ${countries.join(', ')}`);
      return countries;
    }
    return [region]; // Return original if not a region
  } catch (e) {
    console.log(`  Could not expand region, using as-is: ${region}`);
    return [region];
  }
}

// ============ PHASE 0.5: INDUSTRY TERMINOLOGY DISCOVERY ============

// Dynamically discover all terminology and sub-segments for any industry
async function discoverIndustryTerminology(business, countries) {
  console.log('\n' + '='.repeat(50));
  console.log('PHASE 0.5: INDUSTRY TERMINOLOGY DISCOVERY');
  console.log('='.repeat(50));

  const countryList = countries.join(', ');

  const discoveryPrompt = `You are an industry research expert preparing for an EXHAUSTIVE company search.

TASK: Before searching for "${business}" companies, I need to understand ALL terminology and sub-segments used in this industry globally and specifically in ${countryList}.

Think deeply about this industry. Consider:
- How do companies in this industry describe themselves?
- What are all the technical terms, trade names, and jargon used?
- What sub-categories and niches exist?
- How might smaller local companies describe themselves differently than large corporations?

Provide a comprehensive list:

1. ALTERNATIVE TERMINOLOGY (at least 10-15 terms)
   - Synonyms and variations of "${business}"
   - Technical/trade terms that mean the same thing
   - How different companies might describe this business differently
   - Older/traditional terms vs modern terms

2. SUB-SEGMENTS (at least 8-10 segments)
   - All sub-categories within "${business}"
   - Specialized niches
   - Product-type or application-based variations
   - Process-based variations

3. RELATED/ADJACENT CATEGORIES (at least 5-8 categories)
   - Closely related businesses that might also qualify
   - Companies that do "${business}" as part of their broader offering

4. LOCAL LANGUAGE TERMS FOR ${countryList}
   - Translations of "${business}" and key terms into local languages
   - Local business terminology used in each country
   - How local companies might name themselves

Return as JSON:
{
  "primary_term": "${business}",
  "alternative_terms": ["term1", "term2", ...],
  "sub_segments": ["segment1", "segment2", ...],
  "related_categories": ["category1", "category2", ...],
  "local_terms": {
    "Country1": ["term1", "term2"],
    "Country2": ["term1", "term2"]
  }
}

Be EXHAUSTIVE. The goal is to ensure we don't miss any company due to terminology differences.`;

  try {
    // Query multiple AI models for comprehensive coverage
    console.log('  Querying GPT-4.1, Gemini, and Perplexity for terminology discovery...');
    const [gptResult, geminiResult, perplexityResult] = await Promise.all([
      callOpenAISearch(discoveryPrompt).catch((e) => {
        console.error('  GPT error:', e.message);
        return '';
      }),
      callGemini(discoveryPrompt).catch((e) => {
        console.error('  Gemini error:', e.message);
        return '';
      }),
      callPerplexity(discoveryPrompt).catch((e) => {
        console.error('  Perplexity error:', e.message);
        return '';
      }),
    ]);

    // Extract JSON from each result (with null safety)
    const extractJSON = (text) => {
      if (!text || typeof text !== 'string') return null;
      try {
        // Try to find JSON in the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.error('  JSON extraction error:', e.message);
      }
      return null;
    };

    const gptTerms = extractJSON(gptResult);
    const geminiTerms = extractJSON(geminiResult);
    const perplexityTerms = extractJSON(perplexityResult);

    // Merge all discovered terms
    const allTerms = new Set([business]); // Always include the original term
    const allSubSegments = new Set();
    const allRelated = new Set();
    const allLocalTerms = new Set();

    for (const result of [gptTerms, geminiTerms, perplexityTerms]) {
      if (!result) continue;

      if (Array.isArray(result.alternative_terms)) {
        result.alternative_terms.forEach((t) => allTerms.add(t));
      }
      if (Array.isArray(result.sub_segments)) {
        result.sub_segments.forEach((t) => allSubSegments.add(t));
      }
      if (Array.isArray(result.related_categories)) {
        result.related_categories.forEach((t) => allRelated.add(t));
      }
      if (result.local_terms) {
        if (Array.isArray(result.local_terms)) {
          result.local_terms.forEach((t) => allLocalTerms.add(t));
        } else if (typeof result.local_terms === 'object') {
          Object.values(result.local_terms).forEach((terms) => {
            if (Array.isArray(terms)) {
              terms.forEach((t) => allLocalTerms.add(t));
            }
          });
        }
      }
    }

    const terminology = {
      primary_term: business,
      alternative_terms: [...allTerms],
      sub_segments: [...allSubSegments],
      related_categories: [...allRelated],
      local_terms: [...allLocalTerms],
      all_search_terms: [...allTerms, ...allSubSegments, ...allRelated, ...allLocalTerms],
    };

    console.log(`  Discovered terminology:`);
    console.log(`    Alternative terms: ${terminology.alternative_terms.length}`);
    console.log(`    Sub-segments: ${terminology.sub_segments.length}`);
    console.log(`    Related categories: ${terminology.related_categories.length}`);
    console.log(`    Local language terms: ${terminology.local_terms.length}`);
    console.log(`    Total unique search terms: ${terminology.all_search_terms.length}`);

    // Log some examples
    if (terminology.alternative_terms.length > 0) {
      console.log(`    Examples: ${terminology.alternative_terms.slice(0, 5).join(', ')}...`);
    }

    return terminology;
  } catch (error) {
    console.error('  Error in terminology discovery:', error.message);
    // Return minimal terminology with just the original term
    return {
      primary_term: business,
      alternative_terms: [business],
      sub_segments: [],
      related_categories: [],
      local_terms: [],
      all_search_terms: [business],
    };
  }
}

// Simple Levenshtein similarity for fuzzy matching
function levenshteinSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  const longer = s1.length > s2.length ? s1 : s2;
  if (longer.length === 0) return 1.0;

  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return (longer.length - costs[s2.length]) / longer.length;
}

// Get cities for a country (dynamic)
function getCitiesForCountry(country) {
  const countryLower = country.toLowerCase();
  for (const [key, cities] of Object.entries(CITY_MAP)) {
    if (countryLower.includes(key)) return cities;
  }
  // Default: ask AI to determine cities
  return null;
}

// Get domain for a country (dynamic)
function getDomainForCountry(country) {
  const countryLower = country.toLowerCase();
  for (const [key, domain] of Object.entries(DOMAIN_MAP)) {
    if (countryLower.includes(key)) return domain;
  }
  return null;
}

// Generate dynamic expansion prompts based on round number
// terminology parameter contains dynamically discovered terms from Phase 0.5
function generateExpansionPrompt(
  round,
  business,
  country,
  existingList,
  shortlistSample,
  terminology = null
) {
  const baseInstruction = `You are a thorough M&A researcher finding ALL ${business} companies in ${country}.
Return results as: Company Name | Website (must start with http)
Find at least 20 NEW companies not in our existing list.
DO NOT include companies from this list: ${existingList}`;

  const cities = getCitiesForCountry(country);
  const domain = getDomainForCountry(country);

  // Use dynamically discovered terminology if available
  const altTerms = terminology?.alternative_terms?.slice(0, 10).join(', ') || '';
  const subSegments = terminology?.sub_segments?.slice(0, 8).join(', ') || '';
  const localTerms = terminology?.local_terms?.slice(0, 10).join(', ') || '';
  const relatedCats = terminology?.related_categories?.slice(0, 5).join(', ') || '';

  const prompts = {
    1: `${baseInstruction}

ROUND 1 - RELATED TERMINOLOGY SEARCH:
The user searched for "${business}" but companies may use different terms.
${altTerms ? `We have discovered these alternative terms used in the industry: ${altTerms}` : ''}
${subSegments ? `Industry sub-segments to search: ${subSegments}` : ''}
${relatedCats ? `Related categories: ${relatedCats}` : ''}

Search using ALL these terminology variations to find companies we might otherwise miss.
Think about what OTHER words or phrases companies in this industry might use to describe themselves.`,

    2: `${baseInstruction}

ROUND 2 - DOMESTIC & LOCAL COMPANIES:
Focus ONLY on locally-owned, independent companies in ${country}.
Ignore subsidiaries of multinational corporations.
Look for:
- Family-owned businesses
- Local SMEs
- Domestic manufacturers
- Companies founded locally (not foreign subsidiaries)
${altTerms ? `Search using these terms: ${business}, ${altTerms}` : ''}
These are often harder to find but are the real targets.`,

    3: `${baseInstruction}

ROUND 3 - CITY-BY-CITY DEEP DIVE:
Search for ${business} companies in each of these cities/regions:
${cities ? cities.join(', ') : `Major cities and industrial areas in ${country}`}
Include companies in industrial estates, free trade zones, and business parks.
${subSegments ? `Also search for these sub-segments: ${subSegments}` : ''}`,

    4: `${baseInstruction}

ROUND 4 - TRADE ASSOCIATIONS & MEMBER DIRECTORIES:
Find ${business} companies that are members of:
- Industry associations relevant to ${business}
- Trade organizations
- Chamber of commerce
- Business federations
in ${country}. Look for member directories and lists.
${altTerms ? `Search for associations related to: ${altTerms}` : ''}`,

    5: `${baseInstruction}

ROUND 5 - LOCAL LANGUAGE SEARCH:
Search for ${business} companies in ${country} using LOCAL LANGUAGE terms.

${localTerms ? `Use these discovered local language terms: ${localTerms}` : `First, translate "${business}" into the local language(s) of ${country}.`}

IMPORTANT:
- Search using the local language translations
- Look for companies with local language names (not English names)
- Focus on companies that may only have local language websites
- Search local business directories using local language
- Think about how local entrepreneurs would name their company in their native language`,

    6: `${baseInstruction}

ROUND 6 - SUPPLY CHAIN SEARCH:
For companies like: ${shortlistSample}
Find their:
- Suppliers (who supplies to them)
- Customers (who buys from them)
- Raw material suppliers
that are also ${business} companies in ${country}.
${relatedCats ? `Also look for companies in related categories: ${relatedCats}` : ''}`,

    7: `${baseInstruction}

ROUND 7 - INDUSTRY PUBLICATIONS & ARTICLES:
Search for ${business} companies mentioned in:
- Industry magazines and trade publications for ${business}
- News articles about the ${business} industry in ${country}
- Trade publication interviews
- Company profiles in business journals
${subSegments ? `Also search for coverage of: ${subSegments}` : ''}`,

    8: `${baseInstruction}

ROUND 8 - TRADE SHOWS & EXHIBITIONS:
Find ${business} companies that exhibited at:
- Industry trade shows relevant to ${business} (past 3 years)
- B2B exhibitions
- Industry-specific fairs
in ${country} or international shows with ${country} exhibitors.
${altTerms ? `Search for exhibitors in: ${altTerms}` : ''}`,

    9: `${baseInstruction}

ROUND 9 - WHAT AM I MISSING?
I already found these companies: ${shortlistSample}
${altTerms ? `We searched for: ${business}, ${altTerms}` : ''}
${localTerms ? `Local terms used: ${localTerms}` : ''}

Think step by step: What ${business} companies in ${country} might I have MISSED?
- Companies with unusual names (especially local language names)
- Companies that don't advertise much
- Companies in smaller cities
- Companies that use completely different terminology to describe themselves
- Older established companies
- Newer startups
Find companies that wouldn't appear in a typical Google search.`,

    10: `${baseInstruction}

ROUND 10 - FINAL DISCOVERY:
This is the last round. Search EXHAUSTIVELY for any ${business} company in ${country} not yet found.
- Search in local business directories
- Look for companies in industrial zones
- Check import/export records
- Find any company we might have missed
${altTerms ? `Search using ALL these terms: ${business}, ${altTerms}` : ''}
${localTerms ? `Don't forget local language searches: ${localTerms}` : ''}
${domain ? `Also search for companies with ${domain} domains.` : ''}
The goal is to find EVERY company, no matter how small or obscure.`,
  };

  return prompts[round] || prompts[1];
}

// Run a single expansion round with all 3 search-enabled models
// terminology parameter contains dynamically discovered terms from Phase 0.5
async function runExpansionRound(round, business, country, existingCompanies, terminology = null) {
  console.log(`\n--- Expansion Round ${round}/10 ---`);

  try {
    const existingNames = (existingCompanies || [])
      .filter((c) => c && c.company_name)
      .map((c) => c.company_name.toLowerCase());

    const existingList = (existingCompanies || [])
      .filter((c) => c && c.company_name)
      .slice(0, 30)
      .map((c) => c.company_name)
      .join(', ');

    const shortlistSample = (existingCompanies || [])
      .filter((c) => c && c.company_name)
      .slice(0, 10)
      .map((c) => c.company_name)
      .join(', ');

    // Pass terminology to the prompt generator for dynamic term usage
    const prompt = generateExpansionPrompt(
      round,
      business,
      country,
      existingList,
      shortlistSample,
      terminology
    );

    // Run all 3 search-enabled models in parallel with error handling
    console.log(`  Querying GPT-4.1-nano Search, Gemini 2.0 Flash, Perplexity Sonar...`);
    const [gptResult, geminiResult, perplexityResult] = await Promise.all([
      callOpenAISearch(prompt).catch((e) => {
        console.error(`  GPT error: ${e.message}`);
        return '';
      }),
      callGemini(prompt).catch((e) => {
        console.error(`  Gemini error: ${e.message}`);
        return '';
      }),
      callPerplexity(prompt).catch((e) => {
        console.error(`  Perplexity error: ${e.message}`);
        return '';
      }),
    ]);

    // Extract companies from each result with error handling
    const [gptCompanies, geminiCompanies, perplexityCompanies] = await Promise.all([
      extractCompanies(gptResult, country).catch(() => []),
      extractCompanies(geminiResult, country).catch(() => []),
      extractCompanies(perplexityResult, country).catch(() => []),
    ]);

    console.log(
      `  GPT-4.1-nano: ${gptCompanies.length} | Gemini: ${geminiCompanies.length} | Perplexity: ${perplexityCompanies.length}`
    );

    // Combine and filter out duplicates
    const allNewCompanies = [...gptCompanies, ...geminiCompanies, ...perplexityCompanies];
    const trulyNew = allNewCompanies.filter((c) => {
      if (!c || !c.company_name) return false;
      const nameLower = c.company_name.toLowerCase();
      return !existingNames.some(
        (existing) =>
          existing.includes(nameLower) ||
          nameLower.includes(existing) ||
          levenshteinSimilarity(existing, nameLower) > 0.8
      );
    });

    const uniqueNew = dedupeCompanies(trulyNew);
    console.log(`  New unique companies: ${uniqueNew.length}`);

    return uniqueNew;
  } catch (error) {
    console.error(`  Expansion round ${round} error: ${error.message}`);
    return []; // Return empty array on error instead of crashing
  }
}

app.post('/api/find-target-v4', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`V4 EXHAUSTIVE SEARCH: ${new Date().toISOString()}`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(70));

  res.json({
    success: true,
    message:
      'Request received. Exhaustive search running. Results will be emailed in ~30-45 minutes.',
  });

  const tracker = createTracker('target-v4', Email, { Business, Country, Exclusion });

  trackingContext.run(tracker, async () => {
  try {
    const totalStart = Date.now();

    // ========== PHASE 0: Expand Region to Countries ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 0: REGION EXPANSION');
    console.log('='.repeat(50));

    const countries = await expandRegionToCountries(Country);
    console.log(`Will search ${countries.length} countries: ${countries.join(', ')}`);

    // ========== PHASE 0.5: Industry Terminology Discovery ==========
    let terminology;
    try {
      terminology = await discoverIndustryTerminology(Business, countries);
    } catch (termError) {
      console.error('Terminology discovery failed, using defaults:', termError.message);
      terminology = {
        primary_term: Business,
        alternative_terms: [Business],
        sub_segments: [],
        related_categories: [],
        local_terms: [],
        all_search_terms: [Business],
      };
    }

    // Build expanded search terms string for prompts (with null safety)
    const expandedTerms = (terminology.all_search_terms || [Business]).slice(0, 20).join(', ');
    const localTermsStr = (terminology.local_terms || []).slice(0, 10).join(', ');

    // ========== PHASE 1: Country-by-Country Direct Search ==========
    console.log('\n' + '='.repeat(50));
    console.log(`PHASE 1: COUNTRY-BY-COUNTRY SEARCH (${countries.length} countries)`);
    console.log('='.repeat(50));

    let allPhase1Companies = [];

    // For each country, do a direct AI search using discovered terminology
    for (const targetCountry of countries) {
      try {
        console.log(`\n--- Searching: ${targetCountry} ---`);

        // Enhanced prompt using discovered terminology
        const directPrompt = `List ALL companies in ${targetCountry} that are in ANY of these categories:
- ${Business}
- Alternative terms: ${expandedTerms}
${localTermsStr ? `- Local language terms: ${localTermsStr}` : ''}

Include:
- Large and small companies
- Local/domestic companies
- Lesser-known companies
- Companies that may describe themselves differently but do the same business
Exclude: ${Exclusion}
Return as: Company Name | Website (must start with http)
Find as many as possible - be exhaustive. Search using ALL the terminology variations above.`;

        // Ask all 3 AI models the same direct question with error handling
        const [gptResult, geminiResult, perplexityResult] = await Promise.all([
          callOpenAISearch(directPrompt).catch((e) => {
            console.error(`  GPT error: ${e.message}`);
            return '';
          }),
          callGemini(directPrompt).catch((e) => {
            console.error(`  Gemini error: ${e.message}`);
            return '';
          }),
          callPerplexity(directPrompt).catch((e) => {
            console.error(`  Perplexity error: ${e.message}`);
            return '';
          }),
        ]);

        // Extract companies with error handling
        const [gptCompanies, geminiCompanies, perplexityCompanies] = await Promise.all([
          extractCompanies(gptResult, targetCountry).catch(() => []),
          extractCompanies(geminiResult, targetCountry).catch(() => []),
          extractCompanies(perplexityResult, targetCountry).catch(() => []),
        ]);

        console.log(
          `  GPT: ${gptCompanies.length} | Gemini: ${geminiCompanies.length} | Perplexity: ${perplexityCompanies.length}`
        );
        allPhase1Companies = [
          ...allPhase1Companies,
          ...gptCompanies,
          ...geminiCompanies,
          ...perplexityCompanies,
        ];
      } catch (countryError) {
        console.error(`  Error searching ${targetCountry}: ${countryError.message}`);
        // Continue to next country instead of crashing
      }
    }

    // Also run terminology-enhanced exhaustive search for the full region
    console.log(`\n--- Full Region Search with Expanded Terminology: ${Country} ---`);

    // Run primary search first with error handling
    let regionCompanies = [];
    console.log(`  Searching with primary term: ${Business}`);
    try {
      const primaryResults = await exhaustiveSearch(Business, Country, Exclusion);
      regionCompanies = [...primaryResults];
      console.log(`  Primary term found: ${primaryResults.length} companies`);
    } catch (e) {
      console.error(`  Primary search error: ${e.message}`);
    }

    // Then run ONE additional search with the best alternative term (sequential to avoid overwhelming APIs)
    const altTerms = terminology.alternative_terms || [];
    const topAlternative = altTerms.find((t) => t !== Business && t.length > 3);
    if (topAlternative) {
      console.log(`  Searching with alternative term: ${topAlternative}`);
      try {
        const altResults = await exhaustiveSearch(topAlternative, Country, Exclusion);
        regionCompanies = [...regionCompanies, ...altResults];
        console.log(`  Alternative term found: ${altResults.length} companies`);
      } catch (e) {
        console.error(`  Alternative search error: ${e.message}`);
      }
    }

    console.log(`Region search total: ${regionCompanies.length} companies`);
    allPhase1Companies = [...allPhase1Companies, ...regionCompanies];

    const phase1Raw = dedupeCompanies(allPhase1Companies);
    console.log(`\nPhase 1 total: ${phase1Raw.length} unique companies`);

    // ========== PHASE 1.5: Initial Validation ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 1.5: INITIAL VALIDATION → SHORTLIST');
    console.log('='.repeat(50));

    const preFiltered1 = preFilterCompanies(phase1Raw);
    console.log(`After pre-filter: ${preFiltered1.length}`);

    const shortlistA = await parallelValidationStrict(preFiltered1, Business, Country, Exclusion);
    console.log(`Shortlist A (validated): ${shortlistA.length} companies`);

    // ========== PHASE 2: EXPANSION ROUNDS ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 2: 10 EXPANSION ROUNDS (3 AI models × 10 strategies)');
    console.log('='.repeat(50));

    let allCompanies = [...shortlistA];
    let totalNewFound = 0;

    for (let round = 1; round <= 10; round++) {
      try {
        const roundStart = Date.now();

        // Cycle through countries for each round
        const targetCountry = countries[round % countries.length];
        // Pass terminology to enable dynamic term usage in expansion rounds
        const newCompanies = await runExpansionRound(
          round,
          Business,
          targetCountry,
          allCompanies,
          terminology
        );

        if (newCompanies && newCompanies.length > 0) {
          allCompanies = dedupeCompanies([...allCompanies, ...newCompanies]);
          totalNewFound += newCompanies.length;
        }

        const roundTime = ((Date.now() - roundStart) / 1000).toFixed(1);
        console.log(
          `  Round ${round}/10 [${targetCountry}]: +${(newCompanies || []).length} new (${roundTime}s). Total: ${allCompanies.length}`
        );
      } catch (roundError) {
        console.error(`  Round ${round} error: ${roundError.message}`);
        // Continue to next round instead of crashing
      }
    }

    console.log(`\nPhase 2 complete. Found ${totalNewFound} additional companies.`);

    // ========== PHASE 3: Final Validation ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 3: FINAL VALIDATION');
    console.log('='.repeat(50));

    let finalCompanies = [...shortlistA]; // Start with already validated companies

    try {
      console.log(`Total candidates: ${allCompanies.length}`);

      const phase2New = allCompanies.filter(
        (c) => !shortlistA.some((s) => s.company_name === c.company_name)
      );
      console.log(`New from Phase 2 (need validation): ${phase2New.length}`);

      if (phase2New.length > 0) {
        const preFiltered2 = preFilterCompanies(phase2New);
        const validated2 = await parallelValidationStrict(
          preFiltered2,
          Business,
          Country,
          Exclusion
        );
        console.log(`Phase 2 validated: ${validated2.length}`);
        finalCompanies = dedupeCompanies([...shortlistA, ...validated2]);
      }
    } catch (phase3Error) {
      console.error(`Phase 3 validation error: ${phase3Error.message}`);
      // Continue with what we have from shortlistA
    }

    console.log(`FINAL TOTAL: ${finalCompanies.length} validated companies`);

    // ========== Send Results ==========
    const htmlContent = buildEmailHTML(finalCompanies, Business, Country, Exclusion);
    await sendEmail(
      Email,
      `[V4 EXHAUSTIVE] ${Business} in ${Country} (${finalCompanies.length} companies)`,
      htmlContent
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log('\n' + '='.repeat(70));
    console.log(`V4 EXHAUSTIVE COMPLETE!`);
    console.log(`Email sent to: ${Email}`);
    console.log(`Final companies: ${finalCompanies.length}`);
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(70));

    await tracker.finish({
      status: 'success',
      companiesFound: finalCompanies.length,
    });
  } catch (error) {
    console.error('V4 Processing error:', error);
    await tracker.finish({ status: 'error', error: error.message }).catch(() => {});
    try {
      await sendEmail(Email, `Find Target V4 - Error`, `<p>Error: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
  }); // end trackingContext.run
});

// ============ HEALTH CHECK ============
app.get('/health', healthCheck('target-v4'));

// ============ HEALTHCHECK ============
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'target-v4' });
});

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Target V4 server running on port ${PORT}`);
});
