require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const pptxgen = require('pptxgenjs');
const XLSX = require('xlsx');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

// Multer configuration for file uploads (memory storage)
const upload = multer({ storage: multer.memoryStorage() });

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
async function sendEmail(to, subject, html, attachment = null) {
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'xvasjack@gmail.com';
  const emailData = {
    sender: { name: 'Find Target', email: senderEmail },
    to: [{ email: to }],
    subject: subject,
    htmlContent: html
  };

  if (attachment) {
    emailData.attachment = [{
      content: attachment.content,
      name: attachment.name
    }];
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailData)
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

// Check if URL is a valid company website (not social media, maps, directories)
function isValidCompanyWebsite(url) {
  if (!url) return false;
  const urlLower = url.toLowerCase();

  const invalidPatterns = [
    'google.com/maps',
    'google.com/search',
    'maps.google',
    'facebook.com',
    'linkedin.com',
    'twitter.com',
    'instagram.com',
    'youtube.com',
    'wikipedia.org',
    'bloomberg.com',
    'reuters.com',
    'alibaba.com',
    'made-in-china.com',
    'globalsources.com',
    'indiamart.com',
    'yellowpages',
    'yelp.com',
    'trustpilot.com',
    'glassdoor.com',
    'crunchbase.com',
    'zoominfo.com',
    'dnb.com',
    'opencorporates.com'
  ];

  for (const pattern of invalidPatterns) {
    if (urlLower.includes(pattern)) return false;
  }

  if (!url.startsWith('http')) return false;

  return true;
}

// Extract clean URL from text
function extractCleanURL(text) {
  if (!text) return null;

  const urlMatches = text.match(/https?:\/\/[^\s"'<>\])+,]+/gi);
  if (!urlMatches) return null;

  for (const url of urlMatches) {
    const cleanUrl = url.replace(/[.,;:!?)]+$/, '');
    if (isValidCompanyWebsite(cleanUrl)) {
      return cleanUrl;
    }
  }

  return null;
}

// Method 1: Use SerpAPI (Google Search) - Most reliable
async function findWebsiteViaSerpAPI(companyName, countries) {
  if (!process.env.SERPAPI_API_KEY) return null;

  const countryStr = countries.slice(0, 2).join(' ');
  const query = `"${companyName}" ${countryStr} official website`;

  try {
    const params = new URLSearchParams({
      q: query,
      api_key: process.env.SERPAPI_API_KEY,
      engine: 'google',
      num: 10
    });

    const response = await fetch(`https://serpapi.com/search?${params}`, { timeout: 15000 });
    const data = await response.json();

    if (data.organic_results) {
      for (const result of data.organic_results) {
        if (result.link && isValidCompanyWebsite(result.link)) {
          const titleLower = (result.title || '').toLowerCase();
          const snippetLower = (result.snippet || '').toLowerCase();
          const companyLower = companyName.toLowerCase();
          const companyWords = companyLower.split(/\s+/).filter(w => w.length > 2);

          const matchCount = companyWords.filter(w =>
            titleLower.includes(w) || snippetLower.includes(w)
          ).length;

          if (matchCount >= Math.min(2, companyWords.length)) {
            return result.link;
          }
        }
      }

      for (const result of data.organic_results) {
        if (result.link && isValidCompanyWebsite(result.link)) {
          return result.link;
        }
      }
    }

    return null;
  } catch (e) {
    console.error(`SerpAPI error for ${companyName}:`, e.message);
    return null;
  }
}

// Method 2: Use Perplexity
async function findWebsiteViaPerplexity(companyName, countries) {
  const countryStr = countries.join(', ');

  try {
    const result = await callPerplexity(
      `What is the official company website URL for "${companyName}" located in ${countryStr}?
       Return ONLY the direct website URL (like https://www.company.com).
       Do NOT return Google Maps, LinkedIn, Facebook, or any directory links.
       If you cannot find the official website, respond with "NOT_FOUND".`
    );

    return extractCleanURL(result);
  } catch (e) {
    console.error(`Perplexity error for ${companyName}:`, e.message);
    return null;
  }
}

// Method 3: Use OpenAI Search
async function findWebsiteViaOpenAISearch(companyName, countries) {
  const countryStr = countries.join(', ');

  try {
    const result = await callOpenAISearch(
      `Find the official company website for "${companyName}" in ${countryStr}.
       Return ONLY the direct URL to their official website (e.g., https://www.companyname.com).
       Do NOT return Google Maps links, LinkedIn, Facebook, or directory websites.
       If the official website cannot be found, say "NOT_FOUND".`
    );

    return extractCleanURL(result);
  } catch (e) {
    console.error(`OpenAI Search error for ${companyName}:`, e.message);
    return null;
  }
}

// Method 4: Use Gemini
async function findWebsiteViaGemini(companyName, countries) {
  const countryStr = countries.join(', ');

  try {
    const result = await callGemini(
      `What is the official website URL for the company "${companyName}" based in ${countryStr}?
       Return only the URL starting with https:// or http://
       Do not return Google Maps, social media, or directory links.
       If unknown, respond with NOT_FOUND.`
    );

    return extractCleanURL(result);
  } catch (e) {
    console.error(`Gemini error for ${companyName}:`, e.message);
    return null;
  }
}

// Combined website finder - tries multiple methods for accuracy
async function findCompanyWebsiteMulti(companyName, countries) {
  console.log(`  Finding website for: ${companyName}`);

  const [serpResult, perpResult, openaiResult, geminiResult] = await Promise.all([
    findWebsiteViaSerpAPI(companyName, countries),
    findWebsiteViaPerplexity(companyName, countries),
    findWebsiteViaOpenAISearch(companyName, countries),
    findWebsiteViaGemini(companyName, countries)
  ]);

  console.log(`    SerpAPI: ${serpResult || 'not found'}`);
  console.log(`    Perplexity: ${perpResult || 'not found'}`);
  console.log(`    OpenAI Search: ${openaiResult || 'not found'}`);
  console.log(`    Gemini: ${geminiResult || 'not found'}`);

  const candidates = [serpResult, perpResult, openaiResult, geminiResult].filter(url => url);

  if (candidates.length === 0) {
    console.log(`    No website found for ${companyName}`);
    return null;
  }

  const domainCounts = {};
  for (const url of candidates) {
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    } catch (e) {}
  }

  let bestDomain = null;
  let bestCount = 0;
  for (const [domain, count] of Object.entries(domainCounts)) {
    if (count > bestCount) {
      bestCount = count;
      bestDomain = domain;
    }
  }

  if (bestDomain) {
    for (const url of candidates) {
      try {
        const domain = new URL(url).hostname.replace(/^www\./, '');
        if (domain === bestDomain) {
          console.log(`    Selected: ${url} (${bestCount} sources agree)`);
          return url;
        }
      } catch (e) {}
    }
  }

  const finalResult = serpResult || perpResult || openaiResult || geminiResult;
  console.log(`    Selected: ${finalResult}`);
  return finalResult;
}

// Validate if company matches target business - STRICTLY based on website content
async function validateCompanyBusinessStrict(company, targetBusiness, pageText) {
  if (!pageText || pageText.length < 100) {
    return {
      in_scope: false,
      reason: 'Could not fetch sufficient website content',
      business_description: 'Unable to determine - website inaccessible or insufficient content'
    };
  }

  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a company validator. Determine if the company matches the target business criteria STRICTLY based on the website content provided.

TARGET BUSINESS: "${targetBusiness}"

RULES:
1. Your determination must be based ONLY on what the website content says
2. If the website clearly shows the company is in the target business → IN SCOPE
3. If the website shows a different business → OUT OF SCOPE
4. If the website content is unclear or doesn't describe business activities → OUT OF SCOPE with reason "Insufficient website content"
5. Be accurate - do not guess or assume

OUTPUT: Return JSON: {"in_scope": true/false, "reason": "brief explanation based on website content", "business_description": "what this company actually does based on website"}`
        },
        {
          role: 'user',
          content: `COMPANY: ${company.company_name}
WEBSITE: ${company.website}

WEBSITE CONTENT:
${pageText.substring(0, 10000)}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    return JSON.parse(validation.choices[0].message.content);
  } catch (e) {
    console.error(`Error validating ${company.company_name}:`, e.message);
    return { in_scope: false, reason: 'Validation error', business_description: 'Error during validation' };
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

// Build validation results as Excel file (returns base64 string)
function buildValidationExcel(companies, targetBusiness, countries, outputOption) {
  const inScopeCompanies = companies.filter(c => c.in_scope);

  // Prepare data based on output option
  let data;
  if (outputOption === 'all_companies') {
    data = companies.map((c, i) => ({
      '#': i + 1,
      'Company': c.company_name,
      'Website': c.website || 'Not found',
      'Status': c.in_scope ? 'IN SCOPE' : 'OUT OF SCOPE',
      'Business Description': c.business_description || c.reason || '-'
    }));
  } else {
    data = inScopeCompanies.map((c, i) => ({
      '#': i + 1,
      'Company': c.company_name,
      'Website': c.website || 'Not found',
      'Business Description': c.business_description || '-'
    }));
  }

  // Create workbook with summary sheet and results sheet
  const wb = XLSX.utils.book_new();

  // Summary sheet
  const summaryData = [
    ['Speeda List Validation Results'],
    [],
    ['Target Business:', targetBusiness],
    ['Countries:', countries.join(', ')],
    ['Total Companies:', companies.length],
    ['In-Scope:', inScopeCompanies.length],
    ['Out-of-Scope:', companies.length - inScopeCompanies.length]
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

  // Results sheet
  const resultsSheet = XLSX.utils.json_to_sheet(data);
  // Set column widths
  resultsSheet['!cols'] = [
    { wch: 5 },   // #
    { wch: 40 },  // Company
    { wch: 50 },  // Website
    { wch: 15 },  // Status (if all_companies)
    { wch: 60 }   // Business Description
  ];
  XLSX.utils.book_append_sheet(wb, resultsSheet, 'Results');

  // Write to buffer and convert to base64
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return buffer.toString('base64');
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

    const companyList = parseCompanyList(Companies);
    const countryList = parseCountries(Countries);
    const outputOption = OutputOption || 'in_scope_only';

    console.log(`Parsed ${companyList.length} companies and ${countryList.length} countries`);

    if (companyList.length === 0) {
      await sendEmail(Email, 'Speeda List Validation - No Companies', '<p>No valid company names were found in your input.</p>');
      return;
    }

    // Process 15 companies in parallel for much faster results
    const batchSize = 15;
    const results = [];

    for (let i = 0; i < companyList.length; i += batchSize) {
      const batch = companyList.slice(i, i + batchSize);
      console.log(`\nProcessing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(companyList.length / batchSize)} (${batch.length} companies)`);

      const batchResults = await Promise.all(batch.map(async (companyName) => {
        const website = await findCompanyWebsiteMulti(companyName, countryList);

        if (!website) {
          return {
            company_name: companyName,
            website: null,
            in_scope: false,
            reason: 'Official website not found',
            business_description: 'Could not locate official company website'
          };
        }

        const pageText = await fetchWebsite(website);

        if (!pageText || pageText.length < 100) {
          return {
            company_name: companyName,
            website,
            in_scope: false,
            reason: 'Website inaccessible or no content',
            business_description: 'Could not fetch website content for validation'
          };
        }

        const validation = await validateCompanyBusinessStrict(
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
      console.log(`Completed: ${results.length}/${companyList.length}`);
    }

    const inScopeCount = results.filter(r => r.in_scope).length;

    // Build Excel file
    const excelBase64 = buildValidationExcel(results, TargetBusiness, countryList, outputOption);

    // Simple email body
    const emailBody = `
      <h2>Speeda List Validation Complete</h2>
      <p><strong>Target Business:</strong> ${TargetBusiness}</p>
      <p><strong>Countries:</strong> ${countryList.join(', ')}</p>
      <p><strong>Results:</strong> ${inScopeCount} in-scope out of ${results.length} companies</p>
      <br>
      <p>Please see the attached Excel file for detailed results.</p>
    `;

    await sendEmail(
      Email,
      `Speeda List Validation: ${inScopeCount}/${results.length} in-scope for "${TargetBusiness}"`,
      emailBody,
      {
        content: excelBase64,
        name: `validation-results-${new Date().toISOString().split('T')[0]}.xlsx`
      }
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

// ============ TRADING COMPARABLE ============

// Helper function to calculate median
function calculateMedian(values) {
  const nums = values.filter(v => typeof v === 'number' && !isNaN(v) && isFinite(v) && v > 0);
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Format number for display
function formatNum(val, decimals = 1) {
  if (val === null || val === undefined || isNaN(val)) return '-';
  return Number(val).toFixed(decimals);
}

// Format as multiple (with x suffix)
function formatMultiple(val) {
  if (val === null || val === undefined || isNaN(val)) return '-';
  return Number(val).toFixed(1) + 'x';
}

// Format as percentage
function formatPercent(val) {
  if (val === null || val === undefined || isNaN(val)) return '-';
  return Number(val).toFixed(1) + '%';
}

// Build reasoning prompt for AI relevance check - no hardcoded examples
function buildReasoningPrompt(companyNames, filterCriteria) {
  return `You are filtering companies for a trading comparable analysis.

FILTER CRITERIA: "${filterCriteria}"

Companies to evaluate:
${companyNames.map((name, i) => `${i + 1}. ${name}`).join('\n')}

For EACH company, think step by step:
1. What is this company's PRIMARY business? (research if needed)
2. Does "${filterCriteria}" describe their main business activity?
3. Would an investment banker consider this company a direct peer/comparable?

Decision rules:
- relevant=true: Company's PRIMARY business matches the filter criteria
- relevant=false: Company operates in a different industry, or the criteria is only a minor part of their business

Output JSON: {"results": [{"index": 0, "name": "Company Name", "relevant": false, "business": "5-10 word description of actual business"}]}`;
}

// Helper: Check business relevance using OpenAI o1 (best reasoning model)
async function checkRelevanceWithOpenAI(companies, filterCriteria) {
  const companyNames = companies.map(c => c.name);
  const prompt = buildReasoningPrompt(companyNames, filterCriteria);

  try {
    // Try o1 first (best reasoning)
    const response = await openai.chat.completions.create({
      model: 'o1',
      messages: [{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }]
    });
    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { source: 'openai-o1', results: parsed.results || parsed.companies || parsed };
    }
    return null;
  } catch (error) {
    console.error('OpenAI o1 error:', error.message);
    // Fallback to o3-mini with high reasoning
    try {
      const response = await openai.chat.completions.create({
        model: 'o3-mini',
        messages: [{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }],
        reasoning_effort: 'high'
      });
      const content = response.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return { source: 'openai-o3-high', results: parsed.results || parsed.companies || parsed };
      }
      return null;
    } catch (e) {
      console.error('OpenAI o3-mini fallback error:', e.message);
      return null;
    }
  }
}

// Helper: Check business relevance using Gemini 2.0 Flash
async function checkRelevanceWithGemini(companies, filterCriteria) {
  const companyNames = companies.map(c => c.name);
  const prompt = buildReasoningPrompt(companyNames, filterCriteria);

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { source: 'gemini-2.0-flash', results: parsed.results || parsed.companies || parsed };
    }
    return null;
  } catch (error) {
    console.error('Gemini 2.0 Flash error:', error.message);
    return null;
  }
}

// Helper: Check business relevance using Perplexity sonar-pro (best with web search)
async function checkRelevanceWithPerplexity(companies, filterCriteria) {
  const companyNames = companies.map(c => c.name);
  const prompt = buildReasoningPrompt(companyNames, filterCriteria);

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }]
      })
    });
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { source: 'perplexity-pro', results: parsed.results || parsed.companies || parsed };
    }
    return null;
  } catch (error) {
    console.error('Perplexity sonar-pro error:', error.message);
    return null;
  }
}

// Helper: Check relevance with 3 AIs in parallel, use majority voting
async function checkBusinessRelevanceMultiAI(companies, filterCriteria) {
  console.log(`  Running 3-AI relevance check for: "${filterCriteria}"`);

  // Run all 3 AIs in parallel
  const [openaiResult, geminiResult, perplexityResult] = await Promise.all([
    checkRelevanceWithOpenAI(companies, filterCriteria),
    checkRelevanceWithGemini(companies, filterCriteria),
    checkRelevanceWithPerplexity(companies, filterCriteria)
  ]);

  const aiResults = [openaiResult, geminiResult, perplexityResult].filter(r => r !== null);
  console.log(`  Got responses from ${aiResults.length} AIs: ${aiResults.map(r => r.source).join(', ')}`);

  // Merge results using majority voting (2/3 must agree)
  const mergedResults = companies.map((c, i) => {
    const votes = [];
    const descriptions = [];

    for (const aiResult of aiResults) {
      if (!Array.isArray(aiResult.results)) continue;
      const result = aiResult.results.find(r => r.index === i || r.name === c.name);
      if (result) {
        votes.push(result.relevant === true);
        if (result.business) descriptions.push(result.business);
      }
    }

    // Majority voting: need majority to say relevant to KEEP
    // If 2+ AIs say NOT relevant, exclude the company
    const relevantVotes = votes.filter(v => v === true).length;
    const notRelevantVotes = votes.filter(v => v === false).length;
    const totalVotes = votes.length;

    let relevant;
    if (totalVotes >= 2) {
      // Majority voting - need more relevant than not-relevant to keep
      relevant = relevantVotes > notRelevantVotes;
    } else if (totalVotes === 1) {
      relevant = votes[0];
    } else {
      relevant = true; // No AI responded, keep by default
    }

    const business = descriptions[0] || 'Unknown business';

    return {
      index: i,
      name: c.name,
      relevant,
      business,
      votes: `${relevantVotes}/${totalVotes} voted relevant`
    };
  });

  const keptCount = mergedResults.filter(r => r.relevant).length;
  const removedCount = mergedResults.filter(r => !r.relevant).length;
  console.log(`  Majority voting result: ${keptCount} kept, ${removedCount} removed`);

  return mergedResults;
}

// Helper: Generate filtering steps based on target description
async function generateFilteringSteps(targetDescription, companyCount) {
  const prompt = `You are creating a methodical filtering approach for trading comparable analysis.

Target: "${targetDescription}"
Number of companies to filter: ${companyCount}

Create 2-4 progressive filtering steps to narrow down from a broad industry to the specific target.
Each step should be more specific than the previous.

Example for "payroll outsourcing company in Asia":
Step 1: "Business process outsourcing (BPO) or HR services companies"
Step 2: "HR technology or payroll services companies"
Step 3: "Payroll processing or payroll outsourcing companies"
Step 4: "Payroll companies with Asia focus or operations"

Return JSON: {"steps": ["step 1 criteria", "step 2 criteria", "step 3 criteria"]}

Make each step progressively more selective. First step should be broad, last step should match the target closely.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    return parsed.steps || [`Companies related to ${targetDescription}`];
  } catch (error) {
    console.error('Error generating filtering steps:', error);
    return [`Companies related to ${targetDescription}`];
  }
}

// Helper: Apply iterative qualitative filtering with multiple AI checks
async function applyIterativeQualitativeFilter(companies, targetDescription, outputWorkbook, sheetHeaders, startSheetNumber) {
  let currentCompanies = [...companies];
  let sheetNumber = startSheetNumber;
  const filterLog = [];

  // Generate filtering steps
  console.log('Generating filtering steps...');
  const filteringSteps = await generateFilteringSteps(targetDescription, currentCompanies.length);
  console.log(`Generated ${filteringSteps.length} filtering steps:`, filteringSteps);

  // Apply each filtering step
  for (let stepIdx = 0; stepIdx < filteringSteps.length; stepIdx++) {
    const filterCriteria = filteringSteps[stepIdx];
    console.log(`\nApplying filter step ${stepIdx + 1}: "${filterCriteria}"`);

    if (currentCompanies.length <= 3) {
      console.log('  Skipping - already at minimum company count');
      break;
    }

    // Run multi-AI relevance check
    const relevanceResults = await checkBusinessRelevanceMultiAI(currentCompanies, filterCriteria);

    const removedCompanies = [];
    const keptCompanies = [];

    for (let i = 0; i < currentCompanies.length; i++) {
      const result = relevanceResults[i];
      const company = { ...currentCompanies[i] };

      if (result && !result.relevant) {
        company.filterReason = result.business;
        removedCompanies.push(company);
      } else {
        keptCompanies.push(company);
      }
    }

    // Only apply filter if it doesn't remove too many companies
    if (keptCompanies.length >= 3) {
      currentCompanies = keptCompanies;
      const logEntry = `Filter ${sheetNumber - 1} (${filterCriteria}): Removed ${removedCompanies.length} companies`;
      filterLog.push(logEntry);
      console.log(`  ${logEntry}`);

      // Create sheet for this filter step
      const sheetData = createSheetData(currentCompanies, sheetHeaders,
        `Step ${stepIdx + 1}: ${filterCriteria} - ${currentCompanies.length} companies (removed ${removedCompanies.length})`);

      // Add removed companies section
      if (removedCompanies.length > 0) {
        sheetData.push([]);
        sheetData.push(['REMOVED COMPANIES (with business description):']);
        for (const c of removedCompanies) {
          sheetData.push([c.name, '', '', '', '', '', '', '', '', '', '', c.filterReason]);
        }
      }

      const sheet = XLSX.utils.aoa_to_sheet(sheetData);
      const sheetName = `${sheetNumber}. Q${stepIdx + 1} ${filterCriteria.substring(0, 20)}`;
      XLSX.utils.book_append_sheet(outputWorkbook, sheet, sheetName.substring(0, 31));
      sheetNumber++;
    } else {
      console.log(`  Skipping filter - would leave only ${keptCompanies.length} companies`);
    }

    // Stop if we're in the target range
    if (currentCompanies.length >= 3 && currentCompanies.length <= 30) {
      console.log(`  Reached target range: ${currentCompanies.length} companies`);
      break;
    }
  }

  return { companies: currentCompanies, filterLog, sheetNumber };
}

// Helper: Create sheet data from companies
function createSheetData(companies, headers, title) {
  const data = [[title], [], headers];

  for (const c of companies) {
    const row = [
      c.name,
      c.country || '-',
      c.sales,
      c.marketCap,
      c.ev,
      c.ebitda,
      c.netMargin,
      c.evEbitda,
      c.peTTM,
      c.peFY,
      c.pb,
      c.filterReason || ''
    ];
    data.push(row);
  }

  // Add median row
  if (companies.length > 0) {
    const medianRow = [
      'MEDIAN',
      '',
      calculateMedian(companies.map(c => c.sales)),
      calculateMedian(companies.map(c => c.marketCap)),
      calculateMedian(companies.map(c => c.ev)),
      calculateMedian(companies.map(c => c.ebitda)),
      calculateMedian(companies.map(c => c.netMargin)),
      calculateMedian(companies.map(c => c.evEbitda)),
      calculateMedian(companies.map(c => c.peTTM)),
      calculateMedian(companies.map(c => c.peFY)),
      calculateMedian(companies.map(c => c.pb)),
      ''
    ];
    data.push([]);
    data.push(medianRow);
  }

  return data;
}

app.post('/api/trading-comparable', upload.single('ExcelFile'), async (req, res) => {
  const { TargetCompanyOrIndustry, Email, IsProfitable } = req.body;
  const excelFile = req.file;

  if (!excelFile || !TargetCompanyOrIndustry || !Email) {
    return res.status(400).json({ error: 'Excel file, target company/industry, and email are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW TRADING COMPARABLE REQUEST: ${new Date().toISOString()}`);
  console.log(`Target: ${TargetCompanyOrIndustry}`);
  console.log(`Email: ${Email}`);
  console.log(`Profitable: ${IsProfitable}`);
  console.log(`File: ${excelFile.originalname} (${excelFile.size} bytes)`);
  console.log('='.repeat(50));

  res.json({
    success: true,
    message: 'Request received. Results will be emailed shortly.'
  });

  try {
    const workbook = XLSX.read(excelFile.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    console.log(`Total rows in file: ${allRows.length}`);

    // Find the header row - look for row containing company-related headers
    let headerRowIndex = -1;
    let headers = [];

    for (let i = 0; i < Math.min(20, allRows.length); i++) {
      const row = allRows[i];
      if (!row) continue;
      const rowStr = row.join(' ').toLowerCase();
      if ((rowStr.includes('company') || rowStr.includes('name')) &&
          (rowStr.includes('sales') || rowStr.includes('market') || rowStr.includes('ebitda') || rowStr.includes('p/e') || rowStr.includes('ev/'))) {
        headerRowIndex = i;
        headers = row;
        break;
      }
    }

    if (headerRowIndex === -1) {
      headerRowIndex = 0;
      headers = allRows[0] || [];
    }

    console.log(`Header row index: ${headerRowIndex}`);
    console.log(`Headers: ${headers.slice(0, 15).join(', ')}...`);

    // Find column indices - enhanced to detect TTM vs FY columns
    const findCol = (patterns) => {
      for (const pattern of patterns) {
        const idx = headers.findIndex(h =>
          h && h.toString().toLowerCase().includes(pattern.toLowerCase())
        );
        if (idx !== -1) return idx;
      }
      return -1;
    };

    // Find all columns matching a pattern (for TTM/FY detection)
    const findAllCols = (patterns) => {
      const found = [];
      for (let idx = 0; idx < headers.length; idx++) {
        const h = headers[idx];
        if (!h) continue;
        const hLower = h.toString().toLowerCase();
        for (const pattern of patterns) {
          if (hLower.includes(pattern.toLowerCase())) {
            found.push({ idx, header: h });
            break;
          }
        }
      }
      return found;
    };

    // Find P/E columns - prefer TTM over FY
    const peCols = findAllCols(['p/e', 'pe ', 'per ', 'price/earnings', 'price-earnings']);
    let peTTMCol = -1;
    let peFYCol = -1;

    for (const col of peCols) {
      const hLower = col.header.toLowerCase();
      if (hLower.includes('ttm') || hLower.includes('trailing') || hLower.includes('ltm')) {
        peTTMCol = col.idx;
      } else if (hLower.includes('fy') || hLower.includes('annual') || hLower.includes('year')) {
        peFYCol = col.idx;
      }
    }
    // If no specific TTM/FY found, use first P/E column as FY
    if (peTTMCol === -1 && peFYCol === -1 && peCols.length > 0) {
      peFYCol = peCols[0].idx;
    }

    const cols = {
      company: findCol(['company name', 'company', 'name']),
      country: findCol(['country', 'region', 'location']),
      sales: findCol(['sales', 'revenue']),
      marketCap: findCol(['market cap', 'mcap', 'market capitalization']),
      ev: findCol(['enterprise value', ' ev ', 'ev/']),
      ebitda: findCol(['ebitda']),
      netMargin: findCol(['net margin', 'net income margin', 'profit margin', 'net profit margin']),
      opMargin: findCol(['operating margin', 'op margin', 'oper margin', 'opm']),
      evEbitda: findCol(['ev/ebitda', 'ev / ebitda']),
      peTTM: peTTMCol,
      peFY: peFYCol,
      pb: findCol(['p/b', 'pb ', 'p/bv', 'pbv', 'price/book'])
    };

    if (cols.company === -1) cols.company = 0;

    console.log(`Column mapping:`, cols);

    // Extract data rows
    const dataRows = allRows.slice(headerRowIndex + 1);
    const allCompanies = [];

    for (const row of dataRows) {
      if (!row || row.length === 0) continue;

      const companyName = cols.company >= 0 ? row[cols.company] : null;
      if (!companyName) continue;

      const nameStr = String(companyName).toLowerCase();
      if (nameStr.includes('total') || nameStr.includes('median') || nameStr.includes('average') ||
          nameStr.includes('note:') || nameStr.includes('source:') || nameStr.includes('unit') ||
          nameStr.startsWith('*') || nameStr.length < 2) continue;
      if (nameStr.startsWith('spd') && nameStr.length > 10) continue;

      const parseNum = (idx) => {
        if (idx < 0 || !row[idx]) return null;
        const val = parseFloat(String(row[idx]).replace(/[,%]/g, ''));
        return isNaN(val) ? null : val;
      };

      const company = {
        name: companyName,
        country: cols.country >= 0 ? row[cols.country] || '-' : '-',
        sales: parseNum(cols.sales),
        marketCap: parseNum(cols.marketCap),
        ev: parseNum(cols.ev),
        ebitda: parseNum(cols.ebitda),
        netMargin: parseNum(cols.netMargin),
        opMargin: parseNum(cols.opMargin),
        evEbitda: parseNum(cols.evEbitda),
        peTTM: parseNum(cols.peTTM),
        peFY: parseNum(cols.peFY),
        pb: parseNum(cols.pb),
        filterReason: ''
      };

      // Only include if it has at least some financial data
      const hasData = company.sales || company.marketCap || company.evEbitda || company.peTTM || company.peFY || company.pb;
      if (hasData) {
        allCompanies.push(company);
      }
    }

    console.log(`Extracted ${allCompanies.length} companies with data`);

    if (allCompanies.length === 0) {
      await sendEmail(Email, 'Trading Comparable - No Data Found',
        '<p>No valid company data was found in your Excel file. Please ensure the file has company names and financial metrics.</p>');
      return;
    }

    // Create output workbook
    const outputWorkbook = XLSX.utils.book_new();
    const sheetHeaders = ['Company', 'Country', 'Sales', 'Market Cap', 'EV', 'EBITDA', 'Net Margin %', 'EV/EBITDA', 'P/E (TTM)', 'P/E (FY)', 'P/BV', 'Filter Reason'];

    // Sheet 1: All Original Companies
    const sheet1Data = createSheetData(allCompanies, sheetHeaders, `Original Data - ${allCompanies.length} companies`);
    const sheet1 = XLSX.utils.aoa_to_sheet(sheet1Data);
    XLSX.utils.book_append_sheet(outputWorkbook, sheet1, '1. Original');

    const isProfitable = IsProfitable === 'yes';
    let currentCompanies = [...allCompanies];
    let sheetNumber = 2;
    const filterLog = [];

    if (isProfitable) {
      // FILTER 1: Remove companies without P/E (prefer TTM, fallback to FY)
      const beforePE = currentCompanies.length;
      const removedByPE = [];
      currentCompanies = currentCompanies.filter(c => {
        const hasPE = (c.peTTM !== null && c.peTTM > 0) || (c.peFY !== null && c.peFY > 0);
        if (!hasPE) {
          c.filterReason = 'No P/E ratio';
          removedByPE.push(c);
        }
        return hasPE;
      });

      filterLog.push(`Filter 1 (P/E): Removed ${removedByPE.length} companies without P/E ratio`);
      console.log(filterLog[filterLog.length - 1]);

      // Sheet: After P/E filter
      const sheetPEData = createSheetData(currentCompanies, sheetHeaders,
        `After P/E Filter - ${currentCompanies.length} companies (removed ${removedByPE.length})`);
      const sheetPE = XLSX.utils.aoa_to_sheet(sheetPEData);
      XLSX.utils.book_append_sheet(outputWorkbook, sheetPE, `${sheetNumber}. After PE Filter`);
      sheetNumber++;

      // FILTER 2: Remove companies without net margin (or operating margin)
      if (currentCompanies.length > 30) {
        const beforeMargin = currentCompanies.length;
        const removedByMargin = [];
        currentCompanies = currentCompanies.filter(c => {
          const hasMargin = (c.netMargin !== null) || (c.opMargin !== null);
          if (!hasMargin) {
            c.filterReason = 'No margin data';
            removedByMargin.push(c);
          }
          return hasMargin;
        });

        filterLog.push(`Filter 2 (Margin): Removed ${removedByMargin.length} companies without margin data`);
        console.log(filterLog[filterLog.length - 1]);

        // Sheet: After Margin filter
        const sheetMarginData = createSheetData(currentCompanies, sheetHeaders,
          `After Margin Filter - ${currentCompanies.length} companies (removed ${removedByMargin.length})`);
        const sheetMargin = XLSX.utils.aoa_to_sheet(sheetMarginData);
        XLSX.utils.book_append_sheet(outputWorkbook, sheetMargin, `${sheetNumber}. After Margin Filter`);
        sheetNumber++;
      }
    }

    // QUALITATIVE FILTER: Apply iterative multi-AI filtering
    // Uses multiple AIs in parallel, applies progressive filtering steps
    console.log(`\nStarting qualitative filtering with ${currentCompanies.length} companies...`);
    const qualResult = await applyIterativeQualitativeFilter(
      currentCompanies,
      TargetCompanyOrIndustry,
      outputWorkbook,
      sheetHeaders,
      sheetNumber
    );

    currentCompanies = qualResult.companies;
    filterLog.push(...qualResult.filterLog);
    sheetNumber = qualResult.sheetNumber;

    // FINAL SHEET: Summary with medians
    const finalCompanies = currentCompanies;
    const medians = {
      sales: calculateMedian(finalCompanies.map(c => c.sales)),
      marketCap: calculateMedian(finalCompanies.map(c => c.marketCap)),
      ev: calculateMedian(finalCompanies.map(c => c.ev)),
      ebitda: calculateMedian(finalCompanies.map(c => c.ebitda)),
      netMargin: calculateMedian(finalCompanies.map(c => c.netMargin)),
      evEbitda: calculateMedian(finalCompanies.map(c => c.evEbitda)),
      peTTM: calculateMedian(finalCompanies.map(c => c.peTTM)),
      peFY: calculateMedian(finalCompanies.map(c => c.peFY)),
      pb: calculateMedian(finalCompanies.map(c => c.pb))
    };

    // Create final summary sheet
    const summaryData = [
      [`Trading Comparable Analysis: ${TargetCompanyOrIndustry}`],
      [`Generated: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`],
      [],
      ['FILTER SUMMARY'],
      [`Started with ${allCompanies.length} companies`],
      ...filterLog.map(f => [f]),
      [`Final shortlist: ${finalCompanies.length} companies`],
      [],
      ['FINAL COMPARABLE COMPANIES'],
      sheetHeaders,
    ];

    for (const c of finalCompanies) {
      summaryData.push([
        c.name, c.country || '-', c.sales, c.marketCap, c.ev, c.ebitda, c.netMargin,
        c.evEbitda, c.peTTM, c.peFY, c.pb, ''
      ]);
    }

    summaryData.push([]);
    summaryData.push([
      'MEDIAN', '', medians.sales, medians.marketCap, medians.ev, medians.ebitda, medians.netMargin,
      medians.evEbitda, medians.peTTM, medians.peFY, medians.pb, ''
    ]);

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(outputWorkbook, summarySheet, 'Summary');

    // Generate Excel buffer
    const excelBuffer = XLSX.write(outputWorkbook, { type: 'base64', bookType: 'xlsx' });

    // Send email with Excel attachment
    const emailHTML = `
<h2 style="color: #1e3a5f;">Trading Comparable Analysis – ${TargetCompanyOrIndustry}</h2>
<p style="color: #374151;">Please find attached the Excel file with your trading comparable analysis.</p>

<h3 style="color: #1e3a5f;">Filter Summary</h3>
<ul style="color: #374151;">
  <li>Started with: ${allCompanies.length} companies</li>
  ${filterLog.map(f => `<li>${f}</li>`).join('\n')}
  <li><strong>Final shortlist: ${finalCompanies.length} companies</strong></li>
</ul>

<h3 style="color: #1e3a5f;">Median Multiples</h3>
<table border="1" cellpadding="8" style="border-collapse: collapse;">
  <tr style="background-color: #1e3a5f; color: white;">
    <th>EV/EBITDA</th>
    <th>P/E (TTM)</th>
    <th>P/E (FY)</th>
    <th>P/BV</th>
  </tr>
  <tr style="text-align: center;">
    <td>${formatMultiple(medians.evEbitda)}</td>
    <td>${formatMultiple(medians.peTTM)}</td>
    <td>${formatMultiple(medians.peFY)}</td>
    <td>${formatMultiple(medians.pb)}</td>
  </tr>
</table>

<p style="font-size: 12px; color: #6b7280; margin-top: 20px;">
The Excel file contains multiple sheets showing each filtering step.<br>
Data as of ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}<br>
Source: Speeda
</p>
`;

    await sendEmail(
      Email,
      `Trading Comps: ${TargetCompanyOrIndustry} - ${finalCompanies.length} peers`,
      emailHTML,
      {
        content: excelBuffer,
        name: `Trading_Comparable_${TargetCompanyOrIndustry.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`
      }
    );

    console.log(`\n${'='.repeat(50)}`);
    console.log(`TRADING COMPARABLE COMPLETE! Email sent to ${Email}`);
    console.log(`Original: ${allCompanies.length} → Final: ${finalCompanies.length} companies`);
    console.log(`Median EV/EBITDA: ${medians.evEbitda}, P/E TTM: ${medians.peTTM}, P/B: ${medians.pb}`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Trading comparable error:', error);
    try {
      await sendEmail(Email, 'Trading Comparable - Error', `<p>Error processing your request: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

// ============ WRITE LIKE ANIL ============

const ANIL_SYSTEM_PROMPT = `You are helping users write emails in Anil's professional style.

CONSTRAINTS:
- Tone: polite, formal, concise, tactfully assertive; client-first; no hype.
- Structure: greeting; 1-line context; purpose in line 1–2; facts (numbers/dates/acronyms); explicit ask; next step; polite close; sign-off "Best Regards," (NO name after - user will add their own).
- Diction: prefer "Well noted.", "Do let me know…", "Happy to…", "We will keep you informed…"
- BANNED words: "excited", "super", "thrilled", vague time ("soon", "ASAP", "at the earliest"), emotive over-apologies.
- IMPORTANT: Do NOT invent specific dates, times, or deadlines. Only include dates/times if they were provided in the user's input. If no date given, use phrases like "at your earliest convenience" or leave the timing open.
- Honorifics by region (e.g., "-san" for Japanese, "Dato" for Malaysian); short paragraphs with blank lines; numbered lists for terms.
- When dates ARE provided: use absolute format + TZ (e.g., 09 Jan 2026, 14:00 SGT). Currencies spaced (USD 12m). Multiples like "7x EBITDA". FY labels (FY25).

SUBJECT LINE PATTERNS:
- Intro: {A} ↔ {B} — {topic}
- {Deal/Company}: NDA + IM
- {Project}: NBO status
- Correction: aligned IM on {topic}
- {Company}: exclusivity terms
- Meeting: {topic}

EXAMPLE STYLE (note the structure and tone):

Dear Martin,

As discussed, we have received two NBOs for Nimbus:
1) NorthBridge: 0.9x FY25 Revenue; exclusivity 30 days; breakup fee USD 0.5m.
2) Helios: 1.0x FY25 Revenue; exclusivity 21 days; no breakup fee.

We suggest holding to at least 1.0x FY25 Revenue and requiring a modest breakup fee to avoid creep downwards.

Do let me know if you prefer to invite management interviews before revisions.

Thank you.

Best Regards,

OUTPUT FORMAT:
- First line: Subject: [subject line]
- Then blank line
- Then email body
- End with "Best Regards," (no name - user adds their own signature)`;

app.post('/api/write-like-anil', async (req, res) => {
  console.log('\n' + '='.repeat(50));
  console.log('WRITE LIKE ANIL REQUEST');
  console.log('='.repeat(50));

  const { mode, prompt, context, draft, notes } = req.body;

  let userMessage = '';

  if (mode === 'generate') {
    userMessage = `Generate a professional email for the following request:

REQUEST: ${prompt}

${context ? `ADDITIONAL CONTEXT: ${context}` : ''}

Write the email in Anil's style. Include a suggested subject line.`;
  } else if (mode === 'rewrite') {
    userMessage = `Rewrite the following email draft in Anil's style:

ORIGINAL DRAFT:
${draft}

${notes ? `REWRITE INSTRUCTIONS: ${notes}` : ''}

Maintain the core message but apply Anil's tone, structure, and conventions. Include a suggested subject line.`;
  } else {
    return res.status(400).json({ error: 'Invalid mode. Use "generate" or "rewrite".' });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: ANIL_SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3
    });

    const email = response.choices[0].message.content || '';
    console.log('Generated email:', email.substring(0, 200) + '...');

    res.json({ email });
  } catch (error) {
    console.error('Write Like Anil error:', error);
    res.status(500).json({ error: 'Failed to generate email' });
  }
});

// ============ PROFILE SLIDES ============

// Country to flag code mapping
const COUNTRY_FLAG_MAP = {
  'philippines': 'PH', 'ph': 'PH', 'manila': 'PH',
  'thailand': 'TH', 'th': 'TH', 'bangkok': 'TH',
  'malaysia': 'MY', 'my': 'MY', 'kuala lumpur': 'MY',
  'indonesia': 'ID', 'id': 'ID', 'jakarta': 'ID',
  'singapore': 'SG', 'sg': 'SG',
  'vietnam': 'VN', 'vn': 'VN', 'ho chi minh': 'VN', 'hanoi': 'VN',
  'japan': 'JP', 'jp': 'JP', 'tokyo': 'JP',
  'china': 'CN', 'cn': 'CN', 'beijing': 'CN', 'shanghai': 'CN',
  'korea': 'KR', 'kr': 'KR', 'seoul': 'KR',
  'taiwan': 'TW', 'tw': 'TW', 'taipei': 'TW',
  'usa': 'US', 'us': 'US', 'united states': 'US', 'america': 'US',
  'uk': 'GB', 'united kingdom': 'GB', 'england': 'GB', 'london': 'GB',
  'australia': 'AU', 'au': 'AU', 'sydney': 'AU',
  'india': 'IN', 'in': 'IN', 'mumbai': 'IN', 'delhi': 'IN',
  'hong kong': 'HK', 'hk': 'HK'
};

// Common shortform definitions
const SHORTFORM_DEFINITIONS = {
  'HQ': 'Headquarters',
  'SEA': 'Southeast Asia',
  'THB': 'Thai Baht',
  'PHP': 'Philippine Peso',
  'MYR': 'Malaysian Ringgit',
  'IDR': 'Indonesian Rupiah',
  'SGD': 'Singapore Dollar',
  'VND': 'Vietnamese Dong',
  'USD': 'US Dollar',
  'JPY': 'Japanese Yen',
  'CNY': 'Chinese Yuan',
  'KRW': 'Korean Won',
  'TWD': 'Taiwan Dollar',
  'INR': 'Indian Rupee',
  'HKD': 'Hong Kong Dollar',
  'AUD': 'Australian Dollar',
  'GBP': 'British Pound',
  'EUR': 'Euro',
  'ISO': 'International Organization for Standardization',
  'B2B': 'Business to Business',
  'B2C': 'Business to Consumer',
  'R&D': 'Research and Development',
  'OEM': 'Original Equipment Manufacturer',
  'ODM': 'Original Design Manufacturer',
  'SME': 'Small and Medium Enterprise',
  'CAGR': 'Compound Annual Growth Rate',
  'YoY': 'Year over Year',
  'QoQ': 'Quarter over Quarter',
  'FY': 'Fiscal Year',
  'M': 'Million',
  'B': 'Billion',
  'K': 'Thousand',
  'DBD': 'Department of Business Development',
  'EBITDA': 'Earnings Before Interest, Taxes, Depreciation and Amortization',
  'ROE': 'Return on Equity',
  'ROI': 'Return on Investment',
  'GM': 'Gross Margin',
  'NM': 'Net Margin',
  'JV': 'Joint Venture',
  'M&A': 'Mergers and Acquisitions',
  'IPO': 'Initial Public Offering',
  'CEO': 'Chief Executive Officer',
  'CFO': 'Chief Financial Officer',
  'COO': 'Chief Operating Officer',
  'HoHo': 'Ho Chi Minh City',
  'KL': 'Kuala Lumpur',
  'BKK': 'Bangkok',
  'JKT': 'Jakarta',
  'MNL': 'Manila',
  'SG': 'Singapore'
};

// Exchange rate mapping by country (for footnote)
const EXCHANGE_RATE_MAP = {
  'PH': '為替レート: PHP 100M = 3億円',
  'TH': '為替レート: THB 100M = 4億円',
  'MY': '為替レート: MYR 10M = 3億円',
  'ID': '為替レート: IDR 100B = 10億円',
  'SG': '為替レート: SGD 1M = 1億円',
  'VN': '為替レート: VND 100B = 6億円',
  'JP': '',
  'CN': '為替レート: CNY 10M = 2億円',
  'KR': '為替レート: KRW 1B = 1億円',
  'TW': '為替レート: TWD 10M = 0.5億円',
  'US': '為替レート: USD 1M = 1.5億円',
  'GB': '為替レート: GBP 1M = 2億円',
  'AU': '為替レート: AUD 1M = 1億円',
  'IN': '為替レート: INR 100M = 2億円',
  'HK': '為替レート: HKD 10M = 2億円'
};

// Get country code from location string
function getCountryCode(location) {
  if (!location) return null;
  const loc = location.toLowerCase();
  for (const [key, code] of Object.entries(COUNTRY_FLAG_MAP)) {
    if (loc.includes(key)) return code;
  }
  return null;
}

// Detect shortforms in text and return formatted note
function detectShortforms(companyData) {
  // Collect all text including key_metrics array
  const textParts = [
    companyData.company_name,
    companyData.location,
    companyData.business,
    companyData.metrics,
    companyData.footnote
  ];

  // Also include key_metrics array values
  if (companyData.key_metrics && Array.isArray(companyData.key_metrics)) {
    companyData.key_metrics.forEach(metric => {
      if (metric.label) textParts.push(metric.label);
      if (metric.value) textParts.push(metric.value);
    });
  }

  const allText = textParts.filter(Boolean).join(' ');

  const foundShortforms = [];

  for (const [shortform, definition] of Object.entries(SHORTFORM_DEFINITIONS)) {
    // Match shortform as whole word (with word boundaries)
    const regex = new RegExp(`\\b${shortform}\\b`, 'i');
    if (regex.test(allText)) {
      foundShortforms.push(`${shortform} (${definition})`);
    }
  }

  if (foundShortforms.length > 0) {
    return 'Note: ' + foundShortforms.join(', ');
  }
  return null;
}

// Fetch image as base64
async function fetchImageAsBase64(url) {
  try {
    const response = await fetch(url, { timeout: 5000 });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  } catch (e) {
    console.log('Failed to fetch image:', url);
    return null;
  }
}

// Generate PPTX using PptxGenJS - matching YCP template
async function generatePPTX(companies) {
  try {
    console.log('Generating PPTX with PptxGenJS...');

    const pptx = new pptxgen();
    pptx.author = 'YCP';
    pptx.title = 'Company Profile Slides';
    pptx.subject = 'Company Profiles';

    // Set exact slide size to match template (13.333" x 7.5" = 16:9 widescreen)
    pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
    pptx.layout = 'YCP';

    // YCP Theme Colors (from template)
    const COLORS = {
      headerLine: '293F55',    // Dark navy for header/footer lines
      accent3: '011AB7',       // Dark blue - label column background
      white: 'FFFFFF',
      black: '000000',
      gray: 'BFBFBF',          // Dashed border color
      dk2: '1F497D',           // Section underline color
      footerText: '808080'     // Gray footer text
    };

    for (const company of companies) {
      const slide = pptx.addSlide();

      // ===== HEADER LINES (from template) =====
      // Thick line under title area
      slide.addShape(pptx.shapes.LINE, {
        x: 0, y: 1.02, w: 13.333, h: 0,
        line: { color: COLORS.headerLine, width: 4.5 }
      });
      // Thin line below
      slide.addShape(pptx.shapes.LINE, {
        x: 0, y: 1.10, w: 13.333, h: 0,
        line: { color: COLORS.headerLine, width: 2.25 }
      });

      // ===== FOOTER LINE =====
      slide.addShape(pptx.shapes.LINE, {
        x: 0, y: 7.24, w: 13.333, h: 0,
        line: { color: COLORS.headerLine, width: 2.25 }
      });

      // Footer copyright text
      slide.addText('(C) YCP 2025 all rights reserved', {
        x: 4.1, y: 7.26, w: 5.1, h: 0.2,
        fontSize: 8, fontFace: 'Segoe UI',
        color: COLORS.footerText, align: 'center'
      });

      // ===== TITLE (top left) =====
      slide.addText(company.title || company.company_name || 'Company Profile', {
        x: 0.38, y: 0.05, w: 9.5, h: 0.6,
        fontSize: 24, bold: false, fontFace: 'Segoe UI',
        color: COLORS.black, valign: 'bottom'
      });

      // Message (subtitle below title)
      if (company.message) {
        slide.addText(company.message, {
          x: 0.38, y: 0.65, w: 9.5, h: 0.3,
          fontSize: 16, fontFace: 'Segoe UI',
          color: COLORS.black
        });
      }

      // ===== FLAG (top right) =====
      const countryCode = getCountryCode(company.location);
      if (countryCode) {
        try {
          const flagUrl = `https://flagcdn.com/w80/${countryCode.toLowerCase()}.png`;
          const flagBase64 = await fetchImageAsBase64(flagUrl);
          if (flagBase64) {
            slide.addImage({
              data: `data:image/png;base64,${flagBase64}`,
              x: 10.64, y: 0.22, w: 0.83, h: 0.55
            });
          }
        } catch (e) {
          console.log('Flag fetch failed for', countryCode);
        }
      }

      // ===== LOGO (top right of slide) =====
      if (company.website) {
        try {
          const domain = company.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

          // Try multiple logo sources
          const logoSources = [
            `https://logo.clearbit.com/${domain}`,
            `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
            `https://icon.horse/icon/${domain}`
          ];

          let logoBase64 = null;
          for (const logoUrl of logoSources) {
            console.log(`  Trying logo from: ${logoUrl}`);
            logoBase64 = await fetchImageAsBase64(logoUrl);
            if (logoBase64) {
              console.log(`  Logo fetched successfully from ${logoUrl}`);
              break;
            }
          }

          if (logoBase64) {
            slide.addImage({
              data: `data:image/png;base64,${logoBase64}`,
              x: 12.0, y: 0.15, w: 1.0, h: 0.50
            });
          } else {
            console.log(`  Logo not available for ${domain} from any source`);
          }
        } catch (e) {
          console.log('Logo fetch failed for', company.website, e.message);
        }
      }

      // ===== SECTION HEADERS =====
      // Left: "会社概要資料" - positioned per ref v4
      slide.addText('会社概要資料', {
        x: 0.37, y: 1.37, w: 6.1, h: 0.35,
        fontSize: 14, fontFace: 'Segoe UI',
        color: COLORS.black, align: 'center'
      });
      slide.addShape(pptx.shapes.LINE, {
        x: 0.37, y: 1.79, w: 6.1, h: 0,
        line: { color: COLORS.dk2, width: 1.75 }
      });

      // Right: "Product Photos" - positioned per ref v4
      slide.addText('Products and Applications', {
        x: 6.87, y: 1.37, w: 6.1, h: 0.35,
        fontSize: 14, fontFace: 'Segoe UI',
        color: COLORS.black, align: 'center'
      });
      slide.addShape(pptx.shapes.LINE, {
        x: 6.87, y: 1.79, w: 6.1, h: 0,
        line: { color: COLORS.dk2, width: 1.75 }
      });

      // ===== LEFT TABLE (会社概要資料) =====
      // Base company info rows
      const tableData = [
        ['Name', company.company_name || ''],
        ['Est. Year', company.established_year || ''],
        ['Location', company.location || ''],
        ['Business', company.business || '']
      ];

      // Add key metrics as separate rows if available
      if (company.key_metrics && Array.isArray(company.key_metrics)) {
        company.key_metrics.forEach(metric => {
          if (metric.label && metric.value) {
            tableData.push([metric.label, metric.value]);
          }
        });
      } else if (company.metrics) {
        // Fallback for old format (single string)
        tableData.push(['Key Metrics', company.metrics]);
      }

      const rows = tableData.map((row) => [
        {
          text: row[0],
          options: {
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            align: 'center',
            bold: false
          }
        },
        {
          text: row[1],
          options: {
            fill: { color: COLORS.white },
            color: COLORS.black,
            align: 'left',
            border: [
              { pt: 1, color: COLORS.gray, type: 'dash' },
              { pt: 0 },
              { pt: 1, color: COLORS.gray, type: 'dash' },
              { pt: 0 }
            ]
          }
        }
      ]);

      const tableStartY = 1.85;
      const rowHeight = 0.35;

      slide.addTable(rows, {
        x: 0.37, y: tableStartY,
        w: 6.1,
        colW: [1.4, 4.7],
        rowH: rowHeight,
        fontFace: 'Segoe UI',
        fontSize: 14,
        valign: 'middle',
        border: { pt: 2.5, color: COLORS.white },
        margin: [0, 0.04, 0, 0.04]
      });

      // ===== RIGHT TABLE (Product Photos placeholder) =====
      // 3 empty rows for product photos
      const rightTableData = [
        ['', ''],
        ['', ''],
        ['', '']
      ];

      const rightRows = rightTableData.map((row) => [
        {
          text: row[0],
          options: {
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            align: 'center',
            bold: false
          }
        },
        {
          text: row[1],
          options: {
            fill: { color: COLORS.white },
            color: COLORS.black,
            align: 'left',
            border: [
              { pt: 1, color: COLORS.gray, type: 'dash' },
              { pt: 0 },
              { pt: 1, color: COLORS.gray, type: 'dash' },
              { pt: 0 }
            ]
          }
        }
      ]);

      slide.addTable(rightRows, {
        x: 6.87, y: tableStartY,
        w: 6.1,
        colW: [1.4, 4.7],
        rowH: rowHeight,
        fontFace: 'Segoe UI',
        fontSize: 14,
        valign: 'middle',
        border: { pt: 2.5, color: COLORS.white },
        margin: [0, 0.04, 0, 0.04]
      });

      // ===== 財務実績 SECTION (Financial Performance) - RIGHT SIDE =====
      // Section header: "財務実績" at fixed position (6.87, 4.29)
      slide.addText('財務実績', {
        x: 6.87, y: 4.29, w: 6.1, h: 0.35,
        fontSize: 14, fontFace: 'Segoe UI',
        color: COLORS.black, align: 'center'
      });
      slide.addShape(pptx.shapes.LINE, {
        x: 6.87, y: 4.71, w: 6.1, h: 0,
        line: { color: COLORS.dk2, width: 1.75 }
      });

      // Financial data table (if financial metrics available)
      if (company.financial_metrics && Array.isArray(company.financial_metrics) && company.financial_metrics.length > 0) {
        const financialRows = company.financial_metrics.map((metric) => [
          {
            text: metric.label || '',
            options: {
              fill: { color: COLORS.accent3 },
              color: COLORS.white,
              align: 'center',
              bold: false
            }
          },
          {
            text: metric.value || '',
            options: {
              fill: { color: COLORS.white },
              color: COLORS.black,
              align: 'left',
              border: [
                { pt: 1, color: COLORS.gray, type: 'dash' },
                { pt: 0 },
                { pt: 1, color: COLORS.gray, type: 'dash' },
                { pt: 0 }
              ]
            }
          }
        ]);

        slide.addTable(financialRows, {
          x: 6.87, y: 4.77,
          w: 6.1,
          colW: [1.4, 4.7],
          rowH: rowHeight,
          fontFace: 'Segoe UI',
          fontSize: 14,
          valign: 'middle',
          border: { pt: 2.5, color: COLORS.white },
          margin: [0, 0.04, 0, 0.04]
        });
      }

      // ===== FOOTNOTE (fixed position per ref v4) =====
      const footnoteY = 6.85;  // Fixed position per ref v4
      const footnoteLineHeight = 0.18;
      let currentFootnoteY = footnoteY;

      // Line 1: Note with shortform explanations
      const shortformNote = detectShortforms(company);
      if (shortformNote) {
        slide.addText(shortformNote, {
          x: 0.38, y: currentFootnoteY, w: 12.5, h: footnoteLineHeight,
          fontSize: 10, fontFace: 'Segoe UI',
          color: COLORS.black
        });
        currentFootnoteY += footnoteLineHeight;
      }

      // Line 2: Exchange rate (reuse countryCode from flag section)
      const exchangeRate = countryCode ? EXCHANGE_RATE_MAP[countryCode] : null;
      if (exchangeRate) {
        slide.addText(exchangeRate, {
          x: 0.38, y: currentFootnoteY, w: 12.5, h: footnoteLineHeight,
          fontSize: 10, fontFace: 'Segoe UI',
          color: COLORS.black
        });
        currentFootnoteY += footnoteLineHeight;
      }

      // Line 3: Source
      slide.addText('Source: Company website', {
        x: 0.38, y: currentFootnoteY, w: 12.5, h: footnoteLineHeight,
        fontSize: 10, fontFace: 'Segoe UI',
        color: COLORS.black
      });
    }

    // Generate base64
    const base64Content = await pptx.write({ outputType: 'base64' });

    console.log('PPTX generated successfully');

    return {
      success: true,
      content: base64Content
    };
  } catch (error) {
    console.error('PptxGenJS error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Currency exchange mapping by country
const CURRENCY_EXCHANGE = {
  'philippines': '為替レート: PHP 100M = 3億円',
  'thailand': '為替レート: THB 100M = 4億円',
  'malaysia': '為替レート: MYR 10M = 3億円',
  'indonesia': '為替レート: IDR 10B = 1億円',
  'singapore': '為替レート: SGD 1M = 1億円',
  'vietnam': '為替レート: VND 100B = 6億円'
};

// Scrape website and convert to clean text (similar to fetchWebsite but returns more content)
async function scrapeWebsite(url) {
  try {
    // Normalize URL
    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const html = await response.text();

    // Clean HTML to readable text (similar to n8n's markdownify)
    const cleanText = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanText.length < 100) {
      return { success: false, error: 'Insufficient content' };
    }

    return { success: true, content: cleanText.substring(0, 25000), url };
  } catch (e) {
    return { success: false, error: e.message || 'Connection failed' };
  }
}

// AI Agent 1: Extract company name, established year, location
async function extractBasicInfo(scrapedContent, websiteUrl) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You extract company information from website content.

OUTPUT JSON with these fields:
- company_name: Company name with first letter of each word capitalized
- established_year: Clean numbers only (e.g., "1995"), leave empty if not found
- location: Format as "type: city, state, country" for each location. Types: HQ, warehouse, factory, branch, etc. Multiple locations in point form. If Singapore, include which area. No postcodes or full addresses.

RULES:
- Write proper English (e.g., "Việt Nam" → "Vietnam")
- Leave fields empty if information not found
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Website: ${websiteUrl}
Content: ${scrapedContent.substring(0, 12000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 1 error:', e.message);
    return { company_name: '', established_year: '', location: '' };
  }
}

// AI Agent 2: Extract business, message, footnote, title
async function extractBusinessInfo(scrapedContent, basicInfo) {
  const locationText = basicInfo.location || '';
  const hqMatch = locationText.match(/HQ:\s*([^,\n]+),\s*([^\n]+)/i);
  const hqCountry = hqMatch ? hqMatch[2].trim().toLowerCase() : '';
  const currencyExchange = CURRENCY_EXCHANGE[hqCountry] || '';

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You extract business information from website content for M&A discussion slides.

INPUT:
- HTML content from company website
- Previously extracted: company name, year, location

OUTPUT JSON:
1. business: Detailed description of what company does. Format each business line on separate line starting with "■ " (black square bullet).
   Example:
   "■ Manufacture high-quality printing inks\\n■ Provide services related to printing technology\\n■ Distribute industrial chemicals across Southeast Asia"
   Be comprehensive - include manufacturing, distribution, services, R&D activities.

2. message: One-liner introductory message about the company. Example: "Malaysia-based distributor specializing in electronic components and industrial automation products across Southeast Asia."

3. footnote: Two parts:
   - Notes (optional): If unusual shortforms used, write full-form like "SKU (Stock Keeping Unit)". Separate multiple with comma.
   - Currency: ${currencyExchange || 'Leave empty if no matching currency'}
   Separate notes and currency with semicolon. Always end with new line: "出典: 会社ウェブサイト、SPEEDA"

4. title: Company name WITHOUT suffix (remove Pte Ltd, Sdn Bhd, Co Ltd, JSC, PT, Inc, etc.)

RULES:
- All bullet points must use "■ " (black square followed by space)
- Each bullet point on new line using "\\n"
- Be thorough and extract ALL business activities mentioned
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Company: ${basicInfo.company_name}
Established: ${basicInfo.established_year}
Location: ${basicInfo.location}

Website Content:
${scrapedContent.substring(0, 12000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 2 error:', e.message);
    return { business: '', message: '', footnote: '', title: basicInfo.company_name || '' };
  }
}

// AI Agent 3: Extract key metrics for M&A evaluation
async function extractKeyMetrics(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst extracting COMPREHENSIVE key business metrics for potential buyers evaluating this company.

EXTRACT AS MANY OF THESE METRICS AS POSSIBLE (aim for 8-15 metrics):

CUSTOMERS & MARKET:
- Number of customers (total active customers)
- Key customer names (notable clients)
- Customer segments served
- Market share or market position

SUPPLIERS & PARTNERSHIPS:
- Number of suppliers
- Key supplier/partner names
- Notable partnerships, JVs, technology transfers
- Exclusive distribution agreements

OPERATIONS & SCALE:
- Production capacity (units/month, tons/month)
- Factory/warehouse size (m², sq ft)
- Number of machines/equipment
- Number of employees/headcount
- Number of SKUs/products

GEOGRAPHIC REACH:
- Export countries (list regions/countries)
- Distribution network (number of distributors/partners)
- Number of branches/offices/locations
- Markets served

QUALITY & COMPLIANCE:
- Certifications (ISO, HACCP, GMP, FDA, CE, halal, etc.)
- Awards and recognitions
- Patents or proprietary technology

OUTPUT JSON:
{
  "key_metrics": [
    {"label": "Shareholding", "value": "Family owned (100%)"},
    {"label": "Key Metrics", "value": "■ Production capacity of 800+ tons per month\\n■ 250+ machines\\n■ 300+ employees"},
    {"label": "Export Countries", "value": "SEA, South Asia, North Africa"},
    {"label": "Distribution Network", "value": "700 domestic distribution partners"},
    {"label": "Certification", "value": "ISO 9001, ISO 14001"},
    {"label": "Notable Partnerships", "value": "Launch partnership with Dainichiseika Color & Chemicals (Japanese) in 2009 technology transfer, joint product development and marketing"}
  ]
}

RULES:
- Extract as many metrics as found (8-15 ideally)
- For metrics with multiple items, use "■ " bullet points separated by "\\n"
- Labels should be 1-3 words
- Be specific with numbers when available
- Include shareholding structure if mentioned
- NEVER make up data - only include what's explicitly stated
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Company: ${previousData.company_name}
Industry/Business: ${previousData.business}

Website Content (extract ALL M&A-relevant metrics):
${scrapedContent.substring(0, 18000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 3 error:', e.message);
    return { key_metrics: [] };
  }
}

// AI Agent 3b: Extract financial metrics for 財務実績 section
async function extractFinancialMetrics(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst extracting financial performance metrics from website content.

Focus on financial metrics important for M&A evaluation:

PRIORITY FINANCIAL METRICS:
1. Revenue: Annual revenue, sales figures, turnover
2. Profit: Net profit, operating profit, EBITDA
3. Growth: Revenue growth rate, YoY growth
4. Employees: Number of employees, workforce size
5. Assets: Total assets, net assets
6. Capital: Registered capital, paid-up capital

OUTPUT JSON with this structure:
{
  "financial_metrics": [
    {"label": "Revenue", "value": "USD 50M (2023)"},
    {"label": "Net Profit", "value": "USD 5M"},
    {"label": "Growth Rate", "value": "15% YoY"},
    {"label": "Employees", "value": "500+"}
  ]
}

IMPORTANT RULES:
- Only extract financial data that is EXPLICITLY mentioned on the website
- Include currency and year if available
- If no financial data found, return empty array
- Maximum 4 financial metrics
- Do NOT make up financial figures

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: `Company: ${previousData.company_name}
Industry/Business: ${previousData.business}

Website Content (extract financial metrics):
${scrapedContent.substring(0, 15000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 3b error:', e.message);
    return { financial_metrics: [] };
  }
}

// AI Agent 4: Search for missing company information (est year, location, HQ)
async function searchMissingInfo(companyName, website, missingFields) {
  if (!companyName || missingFields.length === 0) {
    return {};
  }

  try {
    console.log(`  Searching for missing info: ${missingFields.join(', ')}`);

    // Use OpenAI Search model which has web search capability
    const searchQuery = `${companyName} company ${missingFields.includes('established_year') ? 'founded year established' : ''} ${missingFields.includes('location') ? 'headquarters location country' : ''}`.trim();

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-search-preview',
      messages: [
        {
          role: 'user',
          content: `Search for information about "${companyName}" (website: ${website}).

I need to find:
${missingFields.includes('established_year') ? '- When was this company founded/established? (year only)' : ''}
${missingFields.includes('location') ? '- Where is this company headquartered? (city, country)' : ''}

Return ONLY a JSON object with these fields (include only fields you can find with confidence):
{
  ${missingFields.includes('established_year') ? '"established_year": "YYYY",' : ''}
  ${missingFields.includes('location') ? '"location": "City, Country"' : ''}
}

If you cannot find reliable information for a field, omit it from the response.
Return ONLY valid JSON, no explanations.`
        }
      ]
    });

    const content = response.choices[0].message.content || '';

    // Try to parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      console.log(`  Found missing info:`, result);
      return result;
    }

    return {};
  } catch (e) {
    console.error('Agent 4 (search) error:', e.message);

    // Fallback to Perplexity if OpenAI search fails
    try {
      const perplexityPrompt = `What is the founding year and headquarters location of ${companyName} (${website})? Reply ONLY with JSON: {"established_year": "YYYY", "location": "City, Country"}`;
      const perplexityResponse = await callPerplexity(perplexityPrompt);

      const jsonMatch = perplexityResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        console.log(`  Found via Perplexity:`, result);
        return result;
      }
    } catch (pe) {
      console.error('Perplexity fallback error:', pe.message);
    }

    return {};
  }
}

// AI Agent 5: Search web for additional company metrics
async function searchAdditionalMetrics(companyName, website, existingMetrics) {
  if (!companyName) {
    return { additional_metrics: [] };
  }

  try {
    console.log(`  Step 6: Searching web for additional metrics...`);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-search-preview',
      messages: [
        {
          role: 'user',
          content: `Search for detailed business information about "${companyName}" (website: ${website}).

I need M&A-relevant metrics for an acquisition discussion. Find:

1. COMPANY SCALE:
   - Number of employees/headcount
   - Revenue figures (annual revenue)
   - Number of retail stores, offices, branches
   - Market capitalization (if public)

2. OPERATIONS:
   - Number of products/SKUs
   - Production capacity
   - Factory/warehouse locations and sizes
   - Number of suppliers

3. CUSTOMERS & MARKET:
   - Number of customers
   - Key customer names or segments
   - Market share
   - Geographic markets served

4. CERTIFICATIONS & QUALITY:
   - ISO certifications
   - Industry-specific certifications
   - Awards

5. PARTNERSHIPS:
   - Key partnerships
   - Joint ventures
   - Major suppliers

Already have: ${existingMetrics.map(m => m.label).join(', ')}

Return ONLY a JSON object:
{
  "additional_metrics": [
    {"label": "Employees", "value": "164,000+ worldwide"},
    {"label": "Retail Stores", "value": "500+ stores globally"},
    {"label": "Revenue", "value": "USD 383B (2023)"}
  ]
}

Only include metrics you can verify. Do not repeat metrics already provided.
Return ONLY valid JSON.`
        }
      ]
    });

    const content = response.choices[0].message.content || '';

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      console.log(`  Found ${result.additional_metrics?.length || 0} additional metrics via web search`);
      return result;
    }

    return { additional_metrics: [] };
  } catch (e) {
    console.error('Agent 5 (additional metrics search) error:', e.message);
    return { additional_metrics: [] };
  }
}

// Build profile slides email HTML (simple version with PPTX attached)
function buildProfileSlidesEmailHTML(companies, errors, hasPPTX) {
  const companyNames = companies.map(c => c.title || c.company_name).join(', ');

  let html = `
    <h2>Profile Slides</h2>
    <p>Your profile slides have been generated.</p>
    <br>
    <p><strong>Companies Extracted:</strong> ${companies.length}</p>
    <p><strong>Companies:</strong> ${companyNames || 'N/A'}</p>
  `;

  if (hasPPTX) {
    html += `<br><p style="color: #16a34a;"><strong>✓ PowerPoint file attached.</strong></p>`;
  } else {
    html += `<br><p style="color: #dc2626;"><strong>⚠ PPTX generation failed. Data included below.</strong></p>`;

    // Include extracted data as fallback
    companies.forEach((c, i) => {
      html += `
        <div style="margin: 16px 0; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h4 style="margin: 0 0 8px 0;">${i + 1}. ${c.title || c.company_name || 'Unknown'}</h4>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Website:</strong> ${c.website}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Established:</strong> ${c.established_year || '-'}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Location:</strong> ${c.location || '-'}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Business:</strong> ${c.business || '-'}</p>
        </div>
      `;
    });
  }

  // Errors section
  if (errors.length > 0) {
    html += `<br><h3 style="color: #dc2626;">Failed Extractions</h3>`;
    html += `<ul>`;
    errors.forEach(e => {
      html += `<li><strong>${e.website}</strong>: ${e.error}</li>`;
    });
    html += `</ul>`;
  }

  return html;
}

// Main profile slides endpoint
app.post('/api/profile-slides', async (req, res) => {
  const { websites, email } = req.body;

  if (!websites || !Array.isArray(websites) || websites.length === 0) {
    return res.status(400).json({ error: 'Please provide an array of website URLs' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Please provide an email address' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`PROFILE SLIDES REQUEST: ${new Date().toISOString()}`);
  console.log(`Processing ${websites.length} website(s)`);
  console.log(`Email: ${email}`);
  console.log('='.repeat(50));

  // Return immediately - process in background
  res.json({
    success: true,
    message: 'Request received. Results will be emailed within 5-10 minutes.',
    companies: [],
    errors: [],
    total: websites.length
  });

  // Process in background
  try {
    const results = [];

    for (let i = 0; i < websites.length; i++) {
      const website = websites[i].trim();
      if (!website) continue;

      console.log(`\n[${i + 1}/${websites.length}] Processing: ${website}`);

      try {
        // Step 1: Scrape website
        console.log('  Step 1: Scraping website...');
        const scraped = await scrapeWebsite(website);

        if (!scraped.success) {
          console.log(`  Failed to scrape: ${scraped.error}`);
          results.push({
            website,
            error: `Failed to scrape: ${scraped.error}`,
            step: 1
          });
          continue;
        }
        console.log(`  Scraped ${scraped.content.length} characters`);

        // Step 2: Extract basic info (company name, year, location)
        console.log('  Step 2: Extracting company name, year, location...');
        const basicInfo = await extractBasicInfo(scraped.content, website);
        console.log(`  Company: ${basicInfo.company_name || 'Not found'}`);

        // Step 3: Extract business details
        console.log('  Step 3: Extracting business, message, footnote, title...');
        const businessInfo = await extractBusinessInfo(scraped.content, basicInfo);

        // Step 4: Extract key metrics
        console.log('  Step 4: Extracting key metrics...');
        const metricsInfo = await extractKeyMetrics(scraped.content, {
          company_name: basicInfo.company_name,
          business: businessInfo.business
        });

        // Step 4b: Extract financial metrics for 財務実績 section
        console.log('  Step 4b: Extracting financial metrics...');
        const financialInfo = await extractFinancialMetrics(scraped.content, {
          company_name: basicInfo.company_name,
          business: businessInfo.business
        });

        // Step 5: Search for missing info (est year, location) if not found on website
        let searchedInfo = {};
        const missingFields = [];
        if (!basicInfo.established_year) missingFields.push('established_year');
        if (!basicInfo.location) missingFields.push('location');

        if (missingFields.length > 0 && basicInfo.company_name) {
          console.log('  Step 5: Searching for missing info...');
          searchedInfo = await searchMissingInfo(basicInfo.company_name, website, missingFields);
        }

        // Step 6: Search web for additional metrics (especially for large companies)
        let additionalMetrics = [];
        if (basicInfo.company_name) {
          const additionalInfo = await searchAdditionalMetrics(
            basicInfo.company_name,
            website,
            metricsInfo.key_metrics || []
          );
          additionalMetrics = additionalInfo.additional_metrics || [];
        }

        // Combine all key metrics (website + web search)
        const allKeyMetrics = [
          ...(metricsInfo.key_metrics || []),
          ...additionalMetrics
        ];

        // Combine all extracted data (use searched info as fallback)
        const companyData = {
          website: scraped.url,
          company_name: basicInfo.company_name || '',
          established_year: basicInfo.established_year || searchedInfo.established_year || '',
          location: basicInfo.location || searchedInfo.location || '',
          business: businessInfo.business || '',
          message: businessInfo.message || '',
          footnote: businessInfo.footnote || '',
          title: businessInfo.title || '',
          key_metrics: allKeyMetrics,  // Combined metrics from website + web search
          financial_metrics: financialInfo.financial_metrics || [],  // For 財務実績 section
          metrics: metricsInfo.metrics || ''  // Fallback for old format
        };

        console.log(`  ✓ Completed: ${companyData.title || companyData.company_name} (${allKeyMetrics.length} metrics)`);
        results.push(companyData);

      } catch (error) {
        console.error(`  Error processing ${website}:`, error.message);
        results.push({
          website,
          error: error.message,
          step: 0
        });
      }
    }

    const companies = results.filter(r => !r.error);
    const errors = results.filter(r => r.error);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`PROFILE SLIDES EXTRACTION COMPLETE`);
    console.log(`Extracted: ${companies.length}/${websites.length} successful`);
    console.log('='.repeat(50));

    // Generate PPTX using PptxGenJS
    let pptxResult = null;
    if (companies.length > 0) {
      pptxResult = await generatePPTX(companies);
    }

    // Build email content
    const companyNames = companies.slice(0, 3).map(c => c.title || c.company_name).join(', ');
    const subject = `Profile Slides: ${companies.length} companies${companyNames ? ` (${companyNames}${companies.length > 3 ? '...' : ''})` : ''}`;
    const htmlContent = buildProfileSlidesEmailHTML(companies, errors, pptxResult?.success);

    // Send email with PPTX attachment
    const attachment = pptxResult?.success ? {
      content: pptxResult.content,
      name: `Profile_Slides_${new Date().toISOString().split('T')[0]}.pptx`
    } : null;

    await sendEmail(email, subject, htmlContent, attachment);

    console.log(`Email sent to ${email}${attachment ? ' with PPTX attachment' : ''}`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Profile slides error:', error);
    try {
      await sendEmail(email, 'Profile Slides - Error', `<p>Error processing your request: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Find Target v30 - Profile Slides' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
