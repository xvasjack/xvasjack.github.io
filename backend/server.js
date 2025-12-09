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

// Helper function to calculate statistics
function calculateStats(values) {
  const nums = values.filter(v => typeof v === 'number' && !isNaN(v) && isFinite(v));
  if (nums.length === 0) return { mean: null, median: null, min: null, max: null, count: 0 };

  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / nums.length;
  const median = nums.length % 2 === 0
    ? (sorted[nums.length / 2 - 1] + sorted[nums.length / 2]) / 2
    : sorted[Math.floor(nums.length / 2)];

  return {
    mean: Math.round(mean * 10) / 10,
    median: Math.round(median * 10) / 10,
    min: Math.round(Math.min(...nums) * 10) / 10,
    max: Math.round(Math.max(...nums) * 10) / 10,
    count: nums.length
  };
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

  // Respond immediately
  res.json({
    success: true,
    message: 'Request received. Results will be emailed shortly.'
  });

  try {
    // Parse the Excel file
    const workbook = XLSX.read(excelFile.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Get data with headers
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const headers = rawData[0] || [];
    const dataRows = rawData.slice(1);

    console.log(`Headers found: ${headers.join(', ')}`);
    console.log(`Data rows: ${dataRows.length}`);

    if (dataRows.length === 0) {
      await sendEmail(Email, 'Trading Comparable - No Data Found',
        '<p>No data rows were found in your Excel file.</p>');
      return;
    }

    // Find column indices for common metrics (case-insensitive, partial match)
    const findColumn = (patterns) => {
      for (const pattern of patterns) {
        const idx = headers.findIndex(h =>
          h && h.toString().toLowerCase().includes(pattern.toLowerCase())
        );
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const companyCol = findColumn(['company', 'name', 'ticker', 'stock']);
    const peCol = findColumn(['p/e', 'pe', 'price/earnings', 'price to earnings']);
    const pbCol = findColumn(['p/b', 'pb', 'price/book', 'price to book']);
    const evEbitdaCol = findColumn(['ev/ebitda', 'evebitda', 'ev ebitda']);
    const evSalesCol = findColumn(['ev/sales', 'ev/revenue', 'evsales']);
    const marketCapCol = findColumn(['market cap', 'mcap', 'capitalization']);

    console.log(`Column indices - Company: ${companyCol}, P/E: ${peCol}, P/B: ${pbCol}, EV/EBITDA: ${evEbitdaCol}`);

    // Extract data
    const companies = [];
    const peValues = [];
    const pbValues = [];
    const evEbitdaValues = [];
    const evSalesValues = [];

    for (const row of dataRows) {
      if (!row || row.length === 0) continue;

      const company = companyCol >= 0 ? row[companyCol] : row[0];
      if (!company) continue;

      const pe = peCol >= 0 ? parseFloat(row[peCol]) : null;
      const pb = pbCol >= 0 ? parseFloat(row[pbCol]) : null;
      const evEbitda = evEbitdaCol >= 0 ? parseFloat(row[evEbitdaCol]) : null;
      const evSales = evSalesCol >= 0 ? parseFloat(row[evSalesCol]) : null;
      const marketCap = marketCapCol >= 0 ? row[marketCapCol] : null;

      companies.push({
        name: company,
        pe: isNaN(pe) ? null : pe,
        pb: isNaN(pb) ? null : pb,
        evEbitda: isNaN(evEbitda) ? null : evEbitda,
        evSales: isNaN(evSales) ? null : evSales,
        marketCap: marketCap
      });

      if (!isNaN(pe) && pe !== null) peValues.push(pe);
      if (!isNaN(pb) && pb !== null) pbValues.push(pb);
      if (!isNaN(evEbitda) && evEbitda !== null) evEbitdaValues.push(evEbitda);
      if (!isNaN(evSales) && evSales !== null) evSalesValues.push(evSales);
    }

    console.log(`Parsed ${companies.length} companies`);

    // Calculate statistics
    const isProfitable = IsProfitable === 'yes';
    const peStats = isProfitable ? calculateStats(peValues) : null;
    const pbStats = calculateStats(pbValues);
    const evEbitdaStats = calculateStats(evEbitdaValues);
    const evSalesStats = calculateStats(evSalesValues);

    // Build company table HTML
    let companyTableHTML = `
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #f0f0f0;">
        <tr>
          <th>#</th>
          <th>Company</th>
          ${isProfitable ? '<th>P/E</th>' : ''}
          <th>P/B</th>
          <th>EV/EBITDA</th>
          ${evSalesValues.length > 0 ? '<th>EV/Sales</th>' : ''}
        </tr>
      </thead>
      <tbody>
    `;

    companies.forEach((c, i) => {
      companyTableHTML += `
        <tr>
          <td>${i + 1}</td>
          <td>${c.name}</td>
          ${isProfitable ? `<td>${c.pe !== null ? c.pe.toFixed(1) : '-'}</td>` : ''}
          <td>${c.pb !== null ? c.pb.toFixed(1) : '-'}</td>
          <td>${c.evEbitda !== null ? c.evEbitda.toFixed(1) : '-'}</td>
          ${evSalesValues.length > 0 ? `<td>${c.evSales !== null ? c.evSales.toFixed(1) : '-'}</td>` : ''}
        </tr>
      `;
    });

    companyTableHTML += '</tbody></table>';

    // Build summary statistics table
    let summaryHTML = `
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #2563eb; color: white;">
        <tr>
          <th>Metric</th>
          <th>Mean</th>
          <th>Median</th>
          <th>Min</th>
          <th>Max</th>
          <th>Count</th>
        </tr>
      </thead>
      <tbody>
    `;

    if (isProfitable && peStats && peStats.count > 0) {
      summaryHTML += `
        <tr>
          <td><strong>P/E</strong></td>
          <td>${peStats.mean}x</td>
          <td>${peStats.median}x</td>
          <td>${peStats.min}x</td>
          <td>${peStats.max}x</td>
          <td>${peStats.count}</td>
        </tr>
      `;
    }

    if (pbStats && pbStats.count > 0) {
      summaryHTML += `
        <tr>
          <td><strong>P/B</strong></td>
          <td>${pbStats.mean}x</td>
          <td>${pbStats.median}x</td>
          <td>${pbStats.min}x</td>
          <td>${pbStats.max}x</td>
          <td>${pbStats.count}</td>
        </tr>
      `;
    }

    if (evEbitdaStats && evEbitdaStats.count > 0) {
      summaryHTML += `
        <tr>
          <td><strong>EV/EBITDA</strong></td>
          <td>${evEbitdaStats.mean}x</td>
          <td>${evEbitdaStats.median}x</td>
          <td>${evEbitdaStats.min}x</td>
          <td>${evEbitdaStats.max}x</td>
          <td>${evEbitdaStats.count}</td>
        </tr>
      `;
    }

    if (evSalesStats && evSalesStats.count > 0) {
      summaryHTML += `
        <tr>
          <td><strong>EV/Sales</strong></td>
          <td>${evSalesStats.mean}x</td>
          <td>${evSalesStats.median}x</td>
          <td>${evSalesStats.min}x</td>
          <td>${evSalesStats.max}x</td>
          <td>${evSalesStats.count}</td>
        </tr>
      `;
    }

    summaryHTML += '</tbody></table>';

    // Build final email
    const emailHTML = `
<h2>Trading Comparable Analysis</h2>
<p><strong>Target:</strong> ${TargetCompanyOrIndustry}</p>
<p><strong>Comparable Companies:</strong> ${companies.length}</p>
<p><strong>Profitability:</strong> ${isProfitable ? 'Yes - All metrics included' : 'No - P/E ratio excluded'}</p>
<br>

<h3>Summary Statistics</h3>
${summaryHTML}
<br>

<h3>Comparable Companies</h3>
${companyTableHTML}
<br>

<p><em>Analysis based on data from uploaded Excel file: ${excelFile.originalname}</em></p>
`;

    await sendEmail(
      Email,
      `Trading Comps: ${TargetCompanyOrIndustry} - Median P/B ${pbStats?.median || 'N/A'}x, EV/EBITDA ${evEbitdaStats?.median || 'N/A'}x`,
      emailHTML
    );

    console.log(`\n${'='.repeat(50)}`);
    console.log(`TRADING COMPARABLE COMPLETE! Email sent to ${Email}`);
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

// Generate PPTX using PptxGenJS - matching YCP template
async function generatePPTX(companies) {
  try {
    console.log('Generating PPTX with PptxGenJS...');

    const pptx = new pptxgen();
    pptx.author = 'YCP';
    pptx.title = 'Company Profile Slides';
    pptx.subject = 'Company Profiles';
    pptx.layout = 'LAYOUT_16x9';

    // YCP Theme Colors (from template)
    const COLORS = {
      accent3: '011AB7',      // Dark blue - label column background
      white: 'FFFFFF',
      black: '000000',
      gray: 'BFBFBF',         // Dashed border color
      dk2: '1F497D'           // Underline color
    };

    companies.forEach((company) => {
      const slide = pptx.addSlide();

      // Title (top)
      slide.addText(company.title || company.company_name || 'Company Profile', {
        x: 0.35, y: 0.06, w: 9.14, h: 0.55,
        fontSize: 28, bold: true, fontFace: 'Segoe UI',
        color: COLORS.black, valign: 'middle'
      });

      // Message (subtitle below title)
      if (company.message) {
        slide.addText(company.message, {
          x: 0.35, y: 0.55, w: 9.14, h: 0.3,
          fontSize: 16, fontFace: 'Segoe UI',
          color: COLORS.black, valign: 'top'
        });
      }

      // Left section header: "会社概要資料"
      slide.addText('会社概要資料', {
        x: 0.33, y: 1.25, w: 5.58, h: 0.3,
        fontSize: 14, fontFace: 'Segoe UI',
        color: COLORS.black, align: 'center'
      });
      // Left section underline
      slide.addShape(pptx.shapes.LINE, {
        x: 0.33, y: 1.58, w: 5.58, h: 0,
        line: { color: COLORS.dk2, width: 1.75 }
      });

      // Right section header: "Product Photos"
      slide.addText('Product Photos', {
        x: 6.28, y: 1.27, w: 5.58, h: 0.3,
        fontSize: 14, fontFace: 'Segoe UI',
        color: COLORS.black, align: 'center'
      });
      // Right section underline
      slide.addShape(pptx.shapes.LINE, {
        x: 6.28, y: 1.58, w: 5.58, h: 0,
        line: { color: COLORS.dk2, width: 1.75 }
      });

      // Build styled table rows
      const tableData = [
        ['Name', company.company_name || ''],
        ['Est. Year', company.established_year || ''],
        ['Location', company.location || ''],
        ['Business', company.business || ''],
        ['Key Metrics', company.metrics || '']
      ];

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

      // Add styled table
      slide.addTable(rows, {
        x: 0.33, y: 1.69,
        w: 5.58,
        colW: [1.26, 4.32],
        rowH: 0.43,
        fontFace: 'Segoe UI',
        fontSize: 14,
        valign: 'middle',
        border: { pt: 2.5, color: COLORS.white },
        margin: [0, 0.04, 0, 0.04]
      });

      // Footnote at bottom
      if (company.footnote) {
        slide.addText(company.footnote, {
          x: 0.35, y: 6.13, w: 9.01, h: 0.43,
          fontSize: 10, fontFace: 'Segoe UI',
          color: COLORS.black, valign: 'middle'
        });
      }
    });

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
          content: `You extract business information from website content.

INPUT:
- HTML content from company website
- Previously extracted: company name, year, location

OUTPUT JSON:
1. business: Brief description of what company does. Format like: "Manufacture products such as X, Y, Z. Distribute products such as A, B, C." Max 3 examples per point. Use point forms (\\n-) for different business lines.

2. message: One-liner introductory message about the company. Example: "Malaysia-based distributor specializing in electronic components and industrial automation products across Southeast Asia."

3. footnote: Two parts:
   - Notes (optional): If unusual shortforms used, write full-form like "SKU (Stock Keeping Unit)". Separate multiple with comma.
   - Currency: ${currencyExchange || 'Leave empty if no matching currency'}
   Separate notes and currency with semicolon. Always end with new line: "出典: 会社ウェブサイト、SPEEDA"

4. title: Company name WITHOUT suffix (remove Pte Ltd, Sdn Bhd, Co Ltd, JSC, PT, Inc, etc.)

RULES:
- All point forms use "\\n-"
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

// AI Agent 3: Extract key metrics
async function extractKeyMetrics(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You extract key business metrics from website content.

Example metrics to look for:
- Supplier names
- Customer names
- Supplier/Customer count
- Number of projects
- Brands distributed/owned
- Headcount/Employee count
- Countries exported to
- Countries with sales/project/product presence
- Revenue figures
- Years of experience
- Number of products
- Factory/warehouse size
- Certifications

OUTPUT JSON with ONE field:
- metrics: All key metrics found, formatted as readable text with line breaks (\\n). Include the metric name and value.

Only include metrics that are explicitly mentioned on the website.
Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: `Company: ${previousData.company_name}
Business: ${previousData.business}

Website Content:
${scrapedContent.substring(0, 12000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 3 error:', e.message);
    return { metrics: '' };
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

        // Combine all extracted data
        const companyData = {
          website: scraped.url,
          company_name: basicInfo.company_name || '',
          established_year: basicInfo.established_year || '',
          location: basicInfo.location || '',
          business: businessInfo.business || '',
          message: businessInfo.message || '',
          footnote: businessInfo.footnote || '',
          title: businessInfo.title || '',
          metrics: metricsInfo.metrics || ''
        };

        console.log(`  ✓ Completed: ${companyData.title || companyData.company_name}`);
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
