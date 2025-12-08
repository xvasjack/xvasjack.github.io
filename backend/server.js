require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// Check required environment variables
const requiredEnvVars = ['OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'GEMINI_API_KEY', 'BREVO_API_KEY'];
const optionalEnvVars = ['SERPAPI_API_KEY']; // Optional but recommended
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}
if (!process.env.SERPAPI_API_KEY) {
  console.warn('SERPAPI_API_KEY not set - Google search will be skipped');
}

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'missing'
});

// Send email using Brevo API
async function sendEmail(to, subject, html) {
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'xvasjack@gmail.com';
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Find Target', email: senderEmail },
      to: [{ email: to }],
      subject: subject,
      htmlContent: html
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Email failed: ${error}`);
  }

  return await response.json();
}

// ============ AI TOOLS ============

async function callGemini(prompt) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      timeout: 90000
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (error) {
    console.error('Gemini error:', error.message);
    return '';
  }
}

async function callPerplexity(prompt) {
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{ role: 'user', content: prompt }]
      }),
      timeout: 90000
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('Perplexity error:', error.message);
    return '';
  }
}

async function callChatGPT(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    });
    return response.choices[0].message.content || '';
  } catch (error) {
    console.error('ChatGPT error:', error.message);
    return '';
  }
}

// OpenAI Search model - has real-time web search capability
// Note: gpt-4o-search-preview does NOT support temperature parameter
async function callOpenAISearch(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-search-preview',
      messages: [{ role: 'user', content: prompt }]
    });
    return response.choices[0].message.content || '';
  } catch (error) {
    console.error('OpenAI Search error:', error.message);
    // Fallback to regular gpt-4o if search model not available
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
      num: 100 // Get more results
    });
    const response = await fetch(`https://serpapi.com/search?${params}`, {
      timeout: 30000
    });
    const data = await response.json();

    // Extract organic results
    const results = [];
    if (data.organic_results) {
      for (const result of data.organic_results) {
        results.push({
          title: result.title || '',
          link: result.link || '',
          snippet: result.snippet || ''
        });
      }
    }
    return JSON.stringify(results);
  } catch (error) {
    console.error('SerpAPI error:', error.message);
    return '';
  }
}

// ============ SEARCH CONFIGURATION ============

const CITY_MAP = {
  'malaysia': ['Kuala Lumpur', 'Penang', 'Johor Bahru', 'Shah Alam', 'Petaling Jaya', 'Selangor', 'Ipoh', 'Klang', 'Subang', 'Melaka', 'Kuching', 'Kota Kinabalu'],
  'singapore': ['Singapore', 'Jurong', 'Tuas', 'Woodlands'],
  'thailand': ['Bangkok', 'Chonburi', 'Rayong', 'Samut Prakan', 'Ayutthaya', 'Chiang Mai', 'Pathum Thani', 'Nonthaburi', 'Samut Sakhon'],
  'indonesia': ['Jakarta', 'Surabaya', 'Bandung', 'Medan', 'Bekasi', 'Tangerang', 'Semarang', 'Sidoarjo', 'Cikarang', 'Karawang', 'Bogor'],
  'vietnam': ['Ho Chi Minh City', 'Hanoi', 'Da Nang', 'Hai Phong', 'Binh Duong', 'Dong Nai', 'Long An', 'Ba Ria', 'Can Tho'],
  'philippines': ['Manila', 'Cebu', 'Davao', 'Quezon City', 'Makati', 'Laguna', 'Cavite', 'Batangas', 'Bulacan'],
  'southeast asia': ['Kuala Lumpur', 'Singapore', 'Bangkok', 'Jakarta', 'Ho Chi Minh City', 'Manila', 'Penang', 'Johor Bahru', 'Surabaya', 'Hanoi']
};

const LOCAL_SUFFIXES = {
  'malaysia': ['Sdn Bhd', 'Berhad'],
  'singapore': ['Pte Ltd', 'Private Limited'],
  'thailand': ['Co Ltd', 'Co., Ltd.'],
  'indonesia': ['PT', 'CV'],
  'vietnam': ['Co Ltd', 'JSC', 'Công ty'],
  'philippines': ['Inc', 'Corporation']
};

const DOMAIN_MAP = {
  'malaysia': '.my',
  'singapore': '.sg',
  'thailand': '.th',
  'indonesia': '.co.id',
  'vietnam': '.vn',
  'philippines': '.ph'
};

const LOCAL_LANGUAGE_MAP = {
  'thailand': { lang: 'Thai', examples: ['หมึก', 'สี', 'เคมี'] },
  'vietnam': { lang: 'Vietnamese', examples: ['mực in', 'sơn', 'hóa chất'] },
  'indonesia': { lang: 'Bahasa Indonesia', examples: ['tinta', 'cat', 'kimia'] },
  'philippines': { lang: 'Tagalog', examples: ['tinta', 'pintura'] },
  'malaysia': { lang: 'Bahasa Malaysia', examples: ['dakwat', 'cat'] }
};

// ============ 14 SPECIALIZED SEARCH STRATEGIES (inspired by n8n workflow) ============

function buildOutputFormat() {
  return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
}

// Strategy 1: Broad Google Search (SerpAPI)
function strategy1_BroadSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  // Generate synonyms and variations
  const terms = business.split(/\s+or\s+|\s+and\s+|,/).map(t => t.trim()).filter(t => t);

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
  const countries = country.split(',').map(c => c.trim());
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
function strategy3_ListsSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
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
  const countries = country.split(',').map(c => c.trim());
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
function strategy5_IndustrialSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
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
    `${business} business directory ${country}. Exclude ${exclusion}. ${outputFormat}`
  ];
}

// Strategy 7: Trade Shows & Exhibitions (Perplexity)
function strategy7_ExhibitionsPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} exhibitors at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies at industry exhibitions in ${country} region. Not ${exclusion}. ${outputFormat}`,
    `${business} participants at expos and conferences in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors at international fairs from ${country}. Not ${exclusion}. ${outputFormat}`
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
    `${business} approved vendors in ${country}. Exclude ${exclusion}. ${outputFormat}`
  ];
}

// Strategy 9: Local Domains + News (Perplexity)
function strategy9_DomainsPerplexity(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
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
function strategy10_RegistriesSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
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
function strategy11_CityIndustrialSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
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
  const countries = country.split(',').map(c => c.trim());
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
    `${business} ${country} magazine articles listing companies. Not ${exclusion}. ${outputFormat}`
  ];
}

// Strategy 14: Final Sweep - Local Language + Comprehensive (OpenAI Search)
function strategy14_LocalLanguageOpenAISearch(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
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

// ============ EXTRACTION WITH GPT-4o-mini ============

async function extractCompanies(text, country) {
  if (!text || text.length < 50) return [];
  try {
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
- Be thorough - extract every company that might match`
        },
        { role: 'user', content: text.substring(0, 15000) }
      ],
      response_format: { type: 'json_object' }
    });
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
  return name.toLowerCase()
    // Remove ALL common legal suffixes globally (expanded list)
    .replace(/\s*(sdn\.?\s*bhd\.?|bhd\.?|berhad|pte\.?\s*ltd\.?|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|co\.?,?\s*ltd\.?|llc|llp|gmbh|s\.?a\.?|pt\.?|cv\.?|tbk\.?|jsc|plc|public\s*limited|private\s*limited|joint\s*stock|company|\(.*?\))$/gi, '')
    // Also remove these if they appear anywhere (for cases like "PT Company Name")
    .replace(/^(pt\.?|cv\.?)\s+/gi, '')
    .replace(/[^\w\s]/g, '')  // Remove special characters
    .replace(/\s+/g, ' ')      // Normalize spaces
    .trim();
}

function normalizeWebsite(url) {
  if (!url) return '';
  return url.toLowerCase()
    .replace(/^https?:\/\//, '')           // Remove protocol
    .replace(/^www\./, '')                  // Remove www
    .replace(/\/+$/, '')                    // Remove trailing slashes
    // Remove common path suffixes that don't differentiate companies
    .replace(/\/(home|index|main|default|about|about-us|contact|products?|services?|en|th|id|vn|my|sg|ph|company)(\/.*)?$/i, '')
    .replace(/\.(html?|php|aspx?|jsp)$/i, ''); // Remove file extensions
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
    'youtube.com'
  ];

  for (const pattern of obviousSpam) {
    if (urlLower.includes(pattern)) return true;
  }

  return false;
}

function preFilterCompanies(companies) {
  return companies.filter(c => {
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

  const allSerpQueries = [...serpQueries1, ...serpQueries3, ...serpQueries5, ...serpQueries10, ...serpQueries11];
  const allPerpQueries = [...perpQueries2, ...perpQueries4, ...perpQueries6, ...perpQueries7, ...perpQueries8, ...perpQueries9, ...perpQueries13];
  const allOpenAISearchQueries = [...openaiQueries12, ...openaiQueries14];

  console.log(`  Strategy breakdown:`);
  console.log(`    SerpAPI (Google): ${allSerpQueries.length} queries`);
  console.log(`    Perplexity: ${allPerpQueries.length} queries`);
  console.log(`    OpenAI Search: ${allOpenAISearchQueries.length} queries`);
  console.log(`    Total: ${allSerpQueries.length + allPerpQueries.length + allOpenAISearchQueries.length}`);

  // Run all strategies in parallel
  const [serpResults, perpResults, openaiSearchResults, geminiResults] = await Promise.all([
    // SerpAPI queries
    process.env.SERPAPI_API_KEY
      ? Promise.all(allSerpQueries.map(q => callSerpAPI(q)))
      : Promise.resolve([]),

    // Perplexity queries
    Promise.all(allPerpQueries.map(q => callPerplexity(q))),

    // OpenAI Search queries
    Promise.all(allOpenAISearchQueries.map(q => callOpenAISearch(q))),

    // Also run some Gemini queries for diversity
    Promise.all([
      callGemini(`Find ALL ${business} companies in ${country}. Exclude ${exclusion}. ${buildOutputFormat()}`),
      callGemini(`List ${business} factories and manufacturing plants in ${country}. Not ${exclusion}. ${buildOutputFormat()}`),
      callGemini(`${business} SME and family businesses in ${country}. Exclude ${exclusion}. ${buildOutputFormat()}`)
    ])
  ]);

  console.log(`  All API calls done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Process SerpAPI results through GPT for extraction
  let serpCompanies = [];
  if (serpResults.length > 0) {
    console.log(`  Processing ${serpResults.filter(r => r).length} SerpAPI results...`);
    serpCompanies = await processSerpResults(serpResults.filter(r => r), business, country, exclusion);
    console.log(`    Extracted ${serpCompanies.length} companies from SerpAPI`);
  }

  // Extract from Perplexity results
  console.log(`  Extracting from ${perpResults.length} Perplexity results...`);
  const perpExtractions = await Promise.all(
    perpResults.map(text => extractCompanies(text, country))
  );
  const perpCompanies = perpExtractions.flat();
  console.log(`    Extracted ${perpCompanies.length} companies from Perplexity`);

  // Extract from OpenAI Search results
  console.log(`  Extracting from ${openaiSearchResults.length} OpenAI Search results...`);
  const openaiExtractions = await Promise.all(
    openaiSearchResults.map(text => extractCompanies(text, country))
  );
  const openaiCompanies = openaiExtractions.flat();
  console.log(`    Extracted ${openaiCompanies.length} companies from OpenAI Search`);

  // Extract from Gemini results
  console.log(`  Extracting from ${geminiResults.length} Gemini results...`);
  const geminiExtractions = await Promise.all(
    geminiResults.map(text => extractCompanies(text, country))
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

async function verifyWebsite(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);

    if (!response.ok) return { valid: false, reason: `HTTP ${response.status}` };

    const html = await response.text();
    const lowerHtml = html.toLowerCase();

    // Check for parked domain / placeholder signs
    const parkedSigns = [
      'domain is for sale',
      'buy this domain',
      'this domain is parked',
      'parked by',
      'domain parking',
      'this page is under construction',
      'coming soon',
      'website coming soon',
      'under maintenance',
      'godaddy',
      'namecheap parking',
      'sedoparking',
      'hugedomains',
      'afternic',
      'domain expired',
      'this site can\'t be reached',
      'page not found',
      '404 not found',
      'website not found'
    ];

    for (const sign of parkedSigns) {
      if (lowerHtml.includes(sign)) {
        return { valid: false, reason: `Parked/placeholder: "${sign}"` };
      }
    }

    // Check for minimal content (likely placeholder)
    const textContent = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (textContent.length < 200) {
      return { valid: false, reason: 'Too little content (likely placeholder)' };
    }

    return { valid: true, content: textContent.substring(0, 15000) };
  } catch (e) {
    return { valid: false, reason: e.message || 'Connection failed' };
  }
}

async function filterVerifiedWebsites(companies) {
  console.log(`\nVerifying ${companies.length} websites...`);
  const startTime = Date.now();
  const batchSize = 15; // Increased for better parallelization
  const verified = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(c => verifyWebsite(c.website)));

    batch.forEach((company, idx) => {
      if (results[idx].valid) {
        verified.push({
          ...company,
          _pageContent: results[idx].content // Cache the content for validation
        });
      } else {
        console.log(`    Removed: ${company.company_name} - ${results[idx].reason}`);
      }
    });

    console.log(`  Verified ${Math.min(i + batchSize, companies.length)}/${companies.length}. Working: ${verified.length}`);
  }

  console.log(`Website verification done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Working: ${verified.length}/${companies.length}`);
  return verified;
}

// ============ FETCH WEBSITE FOR VALIDATION ============

async function fetchWebsite(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const html = await response.text();
    const cleanText = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 15000);
    return cleanText.length > 50 ? cleanText : null;
  } catch (e) {
    return null;
  }
}

// ============ DYNAMIC EXCLUSION RULES BUILDER (n8n-style PAGE SIGNAL detection) ============

function buildExclusionRules(exclusion, business) {
  const exclusionLower = exclusion.toLowerCase();
  let rules = '';

  // Detect if user wants to exclude LARGE companies - use PAGE SIGNALS like n8n
  if (exclusionLower.includes('large') || exclusionLower.includes('big') ||
      exclusionLower.includes('mnc') || exclusionLower.includes('multinational') ||
      exclusionLower.includes('major') || exclusionLower.includes('giant')) {
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

// ============ VALIDATION (v23 - n8n-style PAGE SIGNAL detection) ============

async function validateCompanyStrict(company, business, country, exclusion, pageText) {
  // If we couldn't fetch the website, skip (can't verify)
  if (!pageText) {
    console.log(`    Skipped: ${company.company_name} - Website unreachable`);
    return { valid: false };
  }

  const exclusionRules = buildExclusionRules(exclusion, business);

  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a company validator. Be LENIENT on business match. Be STRICT on exclusions by detecting signals in page content.

VALIDATION TASK:
- Business sought: "${business}"
- Target countries: ${country}
- Exclusions: ${exclusion}

VALIDATION RULES:

1. LOCATION CHECK:
- Is HQ actually in one of the target countries (${country})?
- If HQ is outside these countries → REJECT

2. BUSINESS MATCH (BE LENIENT):
- Does the company's business relate to "${business}"?
- Accept related products, services, or sub-categories
- Only reject if completely unrelated

3. EXCLUSION CHECK - DETECT VIA PAGE SIGNALS:
${exclusionRules}

4. SPAM CHECK:
- Is this a directory, marketplace, domain-for-sale, or aggregator site? → REJECT

OUTPUT: Return JSON only: {"valid": true/false, "reason": "one sentence"}`
        },
        {
          role: 'user',
          content: `COMPANY: ${company.company_name}
WEBSITE: ${company.website}
HQ: ${company.hq}

PAGE CONTENT:
${pageText.substring(0, 10000)}`
        }
      ],
      response_format: { type: 'json_object' }
    });

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
    const batch = companies.slice(i, i + batchSize);
    // Use cached _pageContent from verification step, or fetch if not available
    const pageTexts = await Promise.all(
      batch.map(c => c._pageContent ? Promise.resolve(c._pageContent) : fetchWebsite(c.website))
    );
    const validations = await Promise.all(
      batch.map((company, idx) => validateCompanyStrict(company, business, country, exclusion, pageTexts[idx]))
    );

    batch.forEach((company, idx) => {
      if (validations[idx].valid) {
        // Remove internal _pageContent before adding to results
        const { _pageContent, ...cleanCompany } = company;
        validated.push({
          ...cleanCompany,
          hq: validations[idx].corrected_hq || company.hq
        });
      }
    });

    console.log(`  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`);
  }

  console.log(`STRICT Validation done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Valid: ${validated.length}`);
  return validated;
}

// ============ VALIDATION FOR SLOW MODE (v23 - n8n style) ============

async function validateCompany(company, business, country, exclusion, pageText) {
  const exclusionRules = buildExclusionRules(exclusion, business);

  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a company validator. Be LENIENT on business match. Be STRICT on exclusions by detecting signals in page content.

VALIDATION TASK:
- Business sought: "${business}"
- Target countries: ${country}
- Exclusions: ${exclusion}

VALIDATION RULES:

1. LOCATION CHECK:
- Is HQ actually in one of the target countries (${country})?
- If HQ is outside these countries → REJECT

2. BUSINESS MATCH (BE LENIENT):
- Does the company's business relate to "${business}"?
- Accept related products, services, or sub-categories
- Only reject if completely unrelated

3. EXCLUSION CHECK - DETECT VIA PAGE SIGNALS:
${exclusionRules}

4. SPAM CHECK:
- Is this a directory, marketplace, domain-for-sale, or aggregator site? → REJECT

OUTPUT: Return JSON: {"valid": true/false, "reason": "brief", "corrected_hq": "City, Country or null"}`
        },
        {
          role: 'user',
          content: `COMPANY: ${company.company_name}
WEBSITE: ${company.website}
HQ: ${company.hq}

PAGE CONTENT:
${pageText ? pageText.substring(0, 8000) : 'Could not fetch - validate by name only'}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(validation.choices[0].message.content);
    if (result.valid === true) {
      return { valid: true, corrected_hq: result.corrected_hq || company.hq };
    }
    console.log(`    Rejected: ${company.company_name} - ${result.reason}`);
    return { valid: false };
  } catch (e) {
    // On error, accept (benefit of doubt)
    console.log(`    Error validating ${company.company_name}, accepting`);
    return { valid: true, corrected_hq: company.hq };
  }
}

async function parallelValidation(companies, business, country, exclusion) {
  console.log(`\nValidating ${companies.length} companies (strict large company filter)...`);
  const startTime = Date.now();
  const batchSize = 8; // Smaller batch for more thorough validation
  const validated = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);
    const pageTexts = await Promise.all(batch.map(c => fetchWebsite(c.website)));
    const validations = await Promise.all(
      batch.map((company, idx) => validateCompany(company, business, country, exclusion, pageTexts[idx]))
    );

    batch.forEach((company, idx) => {
      if (validations[idx].valid) {
        validated.push({
          ...company,
          hq: validations[idx].corrected_hq || company.hq
        });
      }
    });

    console.log(`  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`);
  }

  console.log(`Validation done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Valid: ${validated.length}`);
  return validated;
}

// ============ EMAIL ============

function buildEmailHTML(companies, business, country, exclusion) {
  let html = `
    <h2>Find Target Results</h2>
    <p><strong>Business:</strong> ${business}</p>
    <p><strong>Country:</strong> ${country}</p>
    <p><strong>Exclusion:</strong> ${exclusion}</p>
    <p><strong>Companies Found:</strong> ${companies.length}</p>
    <br>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #f0f0f0;">
        <tr><th>#</th><th>Company</th><th>Website</th><th>Headquarters</th></tr>
      </thead>
      <tbody>
  `;
  companies.forEach((c, i) => {
    html += `<tr><td>${i + 1}</td><td>${c.company_name}</td><td><a href="${c.website}">${c.website}</a></td><td>${c.hq}</td></tr>`;
  });
  html += '</tbody></table>';
  return html;
}

// ============ FAST ENDPOINT ============

app.post('/api/find-target', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW FAST REQUEST: ${new Date().toISOString()}`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(50));

  res.json({
    success: true,
    message: 'Request received. Results will be emailed within 5-10 minutes.'
  });

  try {
    const totalStart = Date.now();

    const companies = await exhaustiveSearch(Business, Country, Exclusion);
    console.log(`\nFound ${companies.length} unique companies`);

    // Pre-filter obvious spam/directories before expensive verification
    const preFiltered = preFilterCompanies(companies);
    console.log(`After pre-filter: ${preFiltered.length} companies`);

    // Filter out fake/dead websites before expensive validation
    const verifiedCompanies = await filterVerifiedWebsites(preFiltered);
    console.log(`\nCompanies with working websites: ${verifiedCompanies.length}`);

    const validCompanies = await parallelValidationStrict(verifiedCompanies, Business, Country, Exclusion);

    const htmlContent = buildEmailHTML(validCompanies, Business, Country, Exclusion);
    await sendEmail(
      Email,
      `${Business} in ${Country} exclude ${Exclusion} (${validCompanies.length} companies)`,
      htmlContent
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log(`\n${'='.repeat(50)}`);
    console.log(`FAST COMPLETE! Email sent to ${Email}`);
    console.log(`Total companies: ${validCompanies.length}`);
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Processing error:', error);
    try {
      await sendEmail(Email, `Find Target - Error`, `<p>Error: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

// ============ SLOW ENDPOINT (3x search) ============

app.post('/api/find-target-slow', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW SLOW REQUEST: ${new Date().toISOString()}`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(50));

  res.json({
    success: true,
    message: 'Request received. Results will be emailed within 15-45 minutes.'
  });

  try {
    const totalStart = Date.now();

    // Run 3 searches with different phrasings
    console.log('\n--- Search 1: Primary ---');
    const companies1 = await exhaustiveSearch(Business, Country, Exclusion);

    console.log('\n--- Search 2: Supplier/Vendor variation ---');
    const companies2 = await exhaustiveSearch(`${Business} supplier vendor`, Country, Exclusion);

    console.log('\n--- Search 3: Manufacturer/Producer variation ---');
    const companies3 = await exhaustiveSearch(`${Business} manufacturer producer`, Country, Exclusion);

    const allCompanies = [...companies1, ...companies2, ...companies3];
    const uniqueCompanies = dedupeCompanies(allCompanies);
    console.log(`\nTotal unique from 3 searches: ${uniqueCompanies.length}`);

    // Pre-filter obvious spam/directories
    const preFiltered = preFilterCompanies(uniqueCompanies);
    console.log(`After pre-filter: ${preFiltered.length} companies`);

    const validCompanies = await parallelValidation(preFiltered, Business, Country, Exclusion);

    const htmlContent = buildEmailHTML(validCompanies, Business, Country, Exclusion);
    await sendEmail(
      Email,
      `[SLOW] ${Business} in ${Country} exclude ${Exclusion} (${validCompanies.length} companies)`,
      htmlContent
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log(`\n${'='.repeat(50)}`);
    console.log(`SLOW COMPLETE! Email sent to ${Email}`);
    console.log(`Total companies: ${validCompanies.length}`);
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Processing error:', error);
    try {
      await sendEmail(Email, `Find Target Slow - Error`, `<p>Error: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

// ============ VALIDATION ENDPOINT ============

// Parse company names from text (one per line)
function parseCompanyList(text) {
  if (!text) return [];
  return text
    .split(/[\n\r]+/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && line.length < 200);
}

// Parse countries from text
function parseCountries(text) {
  if (!text) return [];
  return text
    .split(/[\n\r]+/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

// Find company website using AI search
async function findCompanyWebsite(companyName, countries) {
  const countryList = countries.join(', ');

  try {
    // Try OpenAI Search first (has real-time web access)
    const searchResult = await callOpenAISearch(
      `Find the official website for "${companyName}" company in ${countryList}. Return ONLY the website URL starting with http. If not found, return "NOT_FOUND".`
    );

    // Extract URL from response
    const urlMatch = searchResult.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch) {
      return urlMatch[0].replace(/[.,;:!?)]+$/, ''); // Clean trailing punctuation
    }

    // Fallback to Perplexity
    const perpResult = await callPerplexity(
      `What is the official website URL for "${companyName}" company located in ${countryList}? Return only the URL.`
    );

    const perpUrlMatch = perpResult.match(/https?:\/\/[^\s"'<>]+/i);
    if (perpUrlMatch) {
      return perpUrlMatch[0].replace(/[.,;:!?)]+$/, '');
    }

    return null;
  } catch (e) {
    console.error(`Error finding website for ${companyName}:`, e.message);
    return null;
  }
}

// Validate if company matches target business
async function validateCompanyBusiness(company, targetBusiness, pageText) {
  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a company validator. Determine if the company matches the target business criteria.

TARGET BUSINESS: "${targetBusiness}"

RULES:
- Be LENIENT - accept companies that are related to the target business
- Accept if they manufacture, distribute, or provide services related to "${targetBusiness}"
- Only reject if completely unrelated

OUTPUT: Return JSON: {"in_scope": true/false, "reason": "brief explanation", "business_description": "what this company actually does"}`
        },
        {
          role: 'user',
          content: `COMPANY: ${company.company_name}
WEBSITE: ${company.website}

PAGE CONTENT:
${pageText ? pageText.substring(0, 8000) : 'Could not fetch website content'}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    return JSON.parse(validation.choices[0].message.content);
  } catch (e) {
    console.error(`Error validating ${company.company_name}:`, e.message);
    return { in_scope: false, reason: 'Validation error', business_description: 'Unknown' };
  }
}

// Build validation results email
function buildValidationEmailHTML(companies, targetBusiness, countries, outputOption) {
  const inScopeCompanies = companies.filter(c => c.in_scope);
  const outOfScopeCompanies = companies.filter(c => !c.in_scope);

  let html = `
    <h2>Speeda List Validation Results</h2>
    <p><strong>Target Business:</strong> ${targetBusiness}</p>
    <p><strong>Countries:</strong> ${countries.join(', ')}</p>
    <p><strong>Total Companies Processed:</strong> ${companies.length}</p>
    <p><strong>In-Scope:</strong> ${inScopeCompanies.length}</p>
    <p><strong>Out-of-Scope:</strong> ${outOfScopeCompanies.length}</p>
    <br>
  `;

  if (outputOption === 'all_companies') {
    // Show all companies with status
    html += `
    <h3>All Companies</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #f0f0f0;">
        <tr><th>#</th><th>Company</th><th>Website</th><th>Status</th><th>Business Description</th></tr>
      </thead>
      <tbody>
    `;
    companies.forEach((c, i) => {
      const statusColor = c.in_scope ? '#10b981' : '#ef4444';
      const statusText = c.in_scope ? 'IN SCOPE' : 'OUT OF SCOPE';
      html += `<tr>
        <td>${i + 1}</td>
        <td>${c.company_name}</td>
        <td>${c.website ? `<a href="${c.website}">${c.website}</a>` : 'Not found'}</td>
        <td style="color: ${statusColor}; font-weight: bold;">${statusText}</td>
        <td>${c.business_description || c.reason || '-'}</td>
      </tr>`;
    });
    html += '</tbody></table>';
  } else {
    // Show only in-scope companies
    html += `
    <h3>In-Scope Companies</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #f0f0f0;">
        <tr><th>#</th><th>Company</th><th>Website</th><th>Business Description</th></tr>
      </thead>
      <tbody>
    `;
    if (inScopeCompanies.length === 0) {
      html += '<tr><td colspan="4" style="text-align: center;">No in-scope companies found</td></tr>';
    } else {
      inScopeCompanies.forEach((c, i) => {
        html += `<tr>
          <td>${i + 1}</td>
          <td>${c.company_name}</td>
          <td>${c.website ? `<a href="${c.website}">${c.website}</a>` : 'Not found'}</td>
          <td>${c.business_description || '-'}</td>
        </tr>`;
      });
    }
    html += '</tbody></table>';
  }

  return html;
}

app.post('/api/validation', async (req, res) => {
  const { Companies, Countries, TargetBusiness, OutputOption, Email } = req.body;

  if (!Companies || !Countries || !TargetBusiness || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW VALIDATION REQUEST: ${new Date().toISOString()}`);
  console.log(`Target Business: ${TargetBusiness}`);
  console.log(`Countries: ${Countries}`);
  console.log(`Output Option: ${OutputOption || 'in_scope_only'}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(50));

  res.json({
    success: true,
    message: 'Validation request received. Results will be emailed within 10 minutes.'
  });

  try {
    const totalStart = Date.now();

    // Parse inputs
    const companyList = parseCompanyList(Companies);
    const countryList = parseCountries(Countries);
    const outputOption = OutputOption || 'in_scope_only';

    console.log(`Parsed ${companyList.length} companies and ${countryList.length} countries`);

    if (companyList.length === 0) {
      await sendEmail(Email, 'Speeda List Validation - No Companies', '<p>No valid company names were found in your input.</p>');
      return;
    }

    // Process companies in batches
    const batchSize = 5;
    const results = [];

    for (let i = 0; i < companyList.length; i += batchSize) {
      const batch = companyList.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(companyList.length / batchSize)}`);

      const batchResults = await Promise.all(batch.map(async (companyName) => {
        // Find website
        const website = await findCompanyWebsite(companyName, countryList);

        if (!website) {
          console.log(`  ${companyName}: Website not found`);
          return {
            company_name: companyName,
            website: null,
            in_scope: false,
            reason: 'Website not found',
            business_description: 'Could not verify'
          };
        }

        console.log(`  ${companyName}: Found ${website}`);

        // Fetch website content
        const pageText = await fetchWebsite(website);

        // Validate against target business
        const validation = await validateCompanyBusiness(
          { company_name: companyName, website },
          TargetBusiness,
          pageText
        );

        return {
          company_name: companyName,
          website,
          in_scope: validation.in_scope,
          reason: validation.reason,
          business_description: validation.business_description
        };
      }));

      results.push(...batchResults);
      console.log(`  Completed: ${results.length}/${companyList.length}`);
    }

    // Build and send email
    const htmlContent = buildValidationEmailHTML(results, TargetBusiness, countryList, outputOption);
    const inScopeCount = results.filter(r => r.in_scope).length;

    await sendEmail(
      Email,
      `Speeda List Validation: ${inScopeCount}/${results.length} in-scope for "${TargetBusiness}"`,
      htmlContent
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log(`\n${'='.repeat(50)}`);
    console.log(`VALIDATION COMPLETE! Email sent to ${Email}`);
    console.log(`Total companies: ${results.length}, In-scope: ${inScopeCount}`);
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Validation error:', error);
    try {
      await sendEmail(Email, `Speeda List Validation - Error`, `<p>Error: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Find Target v27 - Added Speeda List Validation' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
