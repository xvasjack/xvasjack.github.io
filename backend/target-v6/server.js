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
  console.warn('DEEPSEEK_API_KEY not set - Due Diligence reports will use GPT-4o fallback');
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

// Gemini 2.5 Flash - stable model for validation tasks (upgraded from gemini-3-flash-preview which was unstable)
// With GPT-4o fallback when Gemini fails or times out
async function callGemini3Flash(prompt, jsonMode = false) {
  try {
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1, // Low temperature for consistent validation
      },
    };

    // Add JSON mode if requested
    if (jsonMode) {
      requestBody.generationConfig.responseMimeType = 'application/json';
    }

    // Using stable gemini-2.5-flash (gemini-3-flash-preview was unreliable)
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        timeout: 30000, // Reduced from 120s to 30s - fail fast and use GPT-4o fallback
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini 3 Flash HTTP error ${response.status}:`, errorText.substring(0, 200));
      // Fallback to GPT-4o on HTTP errors
      return await callGPT4oFallback(prompt, jsonMode, `Gemini HTTP ${response.status}`);
    }

    const data = await response.json();

    const usage = data.usageMetadata;
    if (usage) {
      recordTokens('gemini-2.5-flash', usage.promptTokenCount || 0, usage.candidatesTokenCount || 0);
    }

    if (data.error) {
      console.error('Gemini 3 Flash API error:', data.error.message);
      // Fallback to GPT-4o
      return await callGPT4oFallback(prompt, jsonMode, 'Gemini 3 Flash API error');
    }

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!result) {
      // Empty response, try fallback
      return await callGPT4oFallback(prompt, jsonMode, 'Gemini 3 Flash empty response');
    }
    return result;
  } catch (error) {
    console.error('Gemini 3 Flash error:', error.message);
    // Fallback to GPT-4o on network timeout or other errors
    return await callGPT4oFallback(prompt, jsonMode, `Gemini error: ${error.message}`);
  }
}

// GPT-4o fallback function for when Gemini fails
async function callGPT4oFallback(prompt, jsonMode = false, reason = '') {
  try {
    console.log(`  Falling back to GPT-4o (reason: ${reason})...`);

    const requestOptions = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    };

    // Add JSON mode if requested
    if (jsonMode) {
      requestOptions.response_format = { type: 'json_object' };
    }

    const response = await openai.chat.completions.create(requestOptions);
    if (response.usage) {
      recordTokens('gpt-4o', response.usage.prompt_tokens || 0, response.usage.completion_tokens || 0);
    }
    const result = response.choices?.[0]?.message?.content || '';

    if (result) {
      console.log('  GPT-4o fallback successful');
    }
    return result;
  } catch (fallbackError) {
    console.error('GPT-4o fallback error:', fallbackError.message);
    return ''; // Return empty if both fail
  }
}

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
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });
    if (response.usage) {
      recordTokens('gpt-4o', response.usage.prompt_tokens || 0, response.usage.completion_tokens || 0);
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
// Updated to use gpt-4o-search-preview (more stable than mini version)
async function callOpenAISearch(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-search-preview',
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.usage) {
      recordTokens('gpt-4o-search-preview', response.usage.prompt_tokens || 0, response.usage.completion_tokens || 0);
    }
    const result = response.choices[0].message.content || '';
    if (!result) {
      console.warn('OpenAI Search returned empty response, falling back to ChatGPT');
      return callChatGPT(prompt);
    }
    return result;
  } catch (error) {
    console.error('OpenAI Search error:', error.message, '- falling back to ChatGPT');
    // Fallback to regular gpt-4o if search model not available
    return callChatGPT(prompt);
  }
}

// ============ SEARCH CONFIGURATION ============

const _CITY_MAP = {
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

const _LOCAL_SUFFIXES = {
  malaysia: ['Sdn Bhd', 'Berhad'],
  singapore: ['Pte Ltd', 'Private Limited'],
  thailand: ['Co Ltd', 'Co., Ltd.'],
  indonesia: ['PT', 'CV'],
  vietnam: ['Co Ltd', 'JSC', 'Công ty'],
  philippines: ['Inc', 'Corporation'],
};

const _DOMAIN_MAP = {
  malaysia: '.my',
  singapore: '.sg',
  thailand: '.th',
  indonesia: '.co.id',
  vietnam: '.vn',
  philippines: '.ph',
};

const _LOCAL_LANGUAGE_MAP = {
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
- Be thorough - extract every company that might match`,
        },
        { role: 'user', content: text.substring(0, 15000) },
      ],
      response_format: { type: 'json_object' },
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
async function _processSerpResults(serpResults, business, country, exclusion) {
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

// ============ WEBSITE VERIFICATION ============

async function _verifyWebsite(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal,
      redirect: 'follow',
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
      "this site can't be reached",
      'page not found',
      '404 not found',
      'website not found',
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

// ============ VALIDATION (v24 - GPT-4o with LENIENT filtering) ============

async function validateCompanyStrict(company, business, country, exclusion, pageText) {
  // If we couldn't fetch the website, validate by name only (give benefit of doubt)
  const contentToValidate =
    typeof pageText === 'string' && pageText
      ? pageText
      : `Company name: ${company.company_name}. Validate based on name only.`;

  const exclusionRules = buildExclusionRules(exclusion, business);

  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o', // Use smarter model for better validation
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

async function _parallelValidationStrict(companies, business, country, exclusion) {
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

OUTPUT: Return JSON: {"valid": true/false, "reason": "brief", "corrected_hq": "City, Country or null"}`,
        },
        {
          role: 'user',
          content: `COMPANY: ${company.company_name}
WEBSITE: ${company.website}
HQ: ${company.hq}

PAGE CONTENT:
${typeof pageText === 'string' && pageText ? pageText.substring(0, 8000) : 'Could not fetch - validate by name only'}`,
        },
      ],
      response_format: { type: 'json_object' },
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

async function _parallelValidation(companies, business, country, exclusion) {
  console.log(`\nValidating ${companies.length} companies (strict large company filter)...`);
  const startTime = Date.now();
  const batchSize = 8; // Smaller batch for more thorough validation
  const validated = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    try {
      const batch = companies.slice(i, i + batchSize);
      if (!batch || batch.length === 0) continue;

      const pageTexts = await Promise.all(
        batch.map((c) => fetchWebsite(c?.website).catch(() => null))
      );
      const validations = await Promise.all(
        batch.map((company, idx) =>
          validateCompany(company, business, country, exclusion, pageTexts[idx]).catch((e) => {
            console.error(`  Validation error for ${company?.company_name}: ${e.message}`);
            return { valid: true, corrected_hq: company?.hq };
          })
        )
      );

      batch.forEach((company, idx) => {
        try {
          if (validations[idx]?.valid && company) {
            validated.push({
              ...company,
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
    }
  }

  console.log(
    `Validation done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Valid: ${validated.length}`
  );
  return validated;
}

// ============ EMAIL ============

function _buildEmailHTML(companies, business, country, exclusion) {
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

// ============ V5 AGENTIC SEARCH ============

// Gemini 2.0 Flash with Google Search grounding - for deep agentic search
// The model can execute multiple searches per request and iterate until exhaustive
async function callGemini2FlashWithSearch(prompt, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Use gemini-2.5-flash which supports Google Search grounding (gemini-3-flash-preview doesn't support search grounding yet)
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 8192,
            },
          }),
          timeout: 180000, // 3 minutes for deep search
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `Gemini 2.5 Flash Search HTTP error ${response.status} (attempt ${attempt + 1}):`,
          errorText.substring(0, 200)
        );
        if (attempt === maxRetries) return { text: '', groundingMetadata: null };
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }

      const data = await response.json();

      const usage = data.usageMetadata;
      if (usage) {
        recordTokens('gemini-2.5-flash', usage.promptTokenCount || 0, usage.candidatesTokenCount || 0);
      }

      if (data.error) {
        console.error(
          `Gemini 2.5 Flash Search API error (attempt ${attempt + 1}):`,
          data.error.message
        );
        if (attempt === maxRetries) return { text: '', groundingMetadata: null };
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const groundingMetadata = data.candidates?.[0]?.groundingMetadata || null;

      // Log grounding info for debugging
      if (groundingMetadata) {
        console.log(
          `    Grounding: ${groundingMetadata.webSearchQueries?.length || 0} queries, ${groundingMetadata.groundingChunks?.length || 0} chunks`
        );
      } else {
        console.warn('    No grounding metadata returned - search may not have executed');
      }

      if (!text) {
        console.warn('    Gemini 2.5 Flash Search returned empty text');
      }

      return { text, groundingMetadata };
    } catch (error) {
      console.error(`Gemini 2.5 Flash Search error (attempt ${attempt + 1}):`, error.message);
      if (attempt === maxRetries) return { text: '', groundingMetadata: null };
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return { text: '', groundingMetadata: null };
}

// Extract companies from Gemini search response using Gemini 3 Flash for quality
async function extractCompaniesV5(text, country) {
  if (!text || text.length < 50) return [];
  try {
    const extraction = await callGemini3Flash(
      `Extract company information from the text. Return JSON: {"companies": [{"company_name": "...", "website": "...", "hq": "..."}]}

RULES:
- Extract ALL companies mentioned that could be in: ${country}
- website must start with http:// or https://
- If website not mentioned, use "unknown" (we'll find it later)
- hq must be "City, Country" format
- Include companies even if some info is incomplete
- Be THOROUGH - extract EVERY company mentioned, even briefly

TEXT:
${text.substring(0, 40000)}`,
      true
    );

    // Parse JSON from response
    try {
      const jsonMatch = extraction.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return Array.isArray(parsed.companies) ? parsed.companies : [];
      }
    } catch (e) {
      console.error('V5 JSON parse error:', e.message);
    }
    return [];
  } catch (e) {
    console.error('V5 Extraction error:', e.message);
    return [];
  }
}

// Run a single deep agentic search task
// This gives the AI full agency to search multiple times until exhaustive
async function runAgenticSearchTask(taskPrompt, country, searchLog) {
  const startTime = Date.now();

  console.log(`  Executing agentic search task...`);
  const result = await callGemini2FlashWithSearch(taskPrompt);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Extract grounding info for logging
  const searchQueries = result.groundingMetadata?.webSearchQueries || [];
  const sources =
    result.groundingMetadata?.groundingChunks?.map((c) => c.web?.uri).filter(Boolean) || [];

  console.log(
    `    Completed in ${duration}s. Searches: ${searchQueries.length}. Sources: ${sources.length}`
  );

  // Log this search
  searchLog.push({
    task: taskPrompt.substring(0, 100) + '...',
    duration: parseFloat(duration),
    searchQueries,
    sourceCount: sources.length,
    responseLength: result.text.length,
  });

  // Extract companies from result
  const companies = await extractCompaniesV5(result.text, country);
  console.log(`    Extracted ${companies.length} companies`);

  return companies;
}

// Run a ChatGPT-powered search task (GPT-4o Search with web grounding)
async function runChatGPTSearchTask(searchQuery, reasoningTask, country, searchLog) {
  const startTime = Date.now();
  console.log(`  Executing ChatGPT Search task...`);

  // ChatGPT Search - it has built-in web search and will return comprehensive results
  const searchPrompt = `You are an M&A research analyst. Search the web and find ALL relevant companies.

SEARCH QUERY: ${searchQuery}

TASK: ${reasoningTask}

INSTRUCTIONS:
1. Search the web comprehensively for companies matching this query
2. Look at multiple sources - company directories, industry associations, trade publications
3. Don't stop at the first few results - dig deeper

For EACH company found, provide:
- Company name (official name)
- Website (must be real company website, not directory)
- Headquarters location (City, Country)

Be thorough - find EVERY company you can. Return as a structured list.`;

  const searchResult = await callOpenAISearch(searchPrompt);

  if (!searchResult) {
    console.log(`    ChatGPT returned no results`);
    searchLog.push({
      task: `[ChatGPT] ${searchQuery.substring(0, 80)}...`,
      duration: (Date.now() - startTime) / 1000,
      searchQueries: [searchQuery],
      sourceCount: 0,
      responseLength: 0,
      model: 'chatgpt-search',
    });
    return [];
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`    Completed in ${duration}s`);

  searchLog.push({
    task: `[ChatGPT] ${searchQuery.substring(0, 80)}...`,
    duration: parseFloat(duration),
    searchQueries: [searchQuery],
    sourceCount: 1,
    responseLength: searchResult.length,
    model: 'chatgpt-search',
  });

  // Extract companies from ChatGPT's response
  const companies = await extractCompaniesV5(searchResult, country);
  console.log(`    Extracted ${companies.length} companies`);

  return companies;
}

// Expand regional inputs to individual countries using AI
async function expandRegionToCountries(regionInput) {
  const inputLower = regionInput.toLowerCase();

  // If comma-separated, user already specified countries - return as array
  if (inputLower.includes(',')) {
    return regionInput.split(',').map((c) => c.trim());
  }

  // Hardcoded region mappings (main business markets only)
  const regionMappings = {
    // Southeast Asia - 6 main markets (exclude Cambodia, Laos, Myanmar unless explicit)
    'southeast asia': ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'],
    'south east asia': ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'],
    sea: ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'],
    asean: ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'],

    // Other common regions
    'east asia': ['Japan', 'South Korea', 'Taiwan', 'China', 'Hong Kong'],
    'north asia': ['Japan', 'South Korea', 'Taiwan', 'China'],
    'south asia': ['India', 'Pakistan', 'Bangladesh', 'Sri Lanka'],
    'middle east': ['UAE', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman'],
    gcc: ['UAE', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman'],
    europe: ['Germany', 'France', 'UK', 'Italy', 'Spain', 'Netherlands', 'Poland'],
    'western europe': ['Germany', 'France', 'UK', 'Italy', 'Spain', 'Netherlands', 'Belgium'],
    'eastern europe': ['Poland', 'Czech Republic', 'Romania', 'Hungary', 'Slovakia'],
    apac: [
      'Malaysia',
      'Indonesia',
      'Singapore',
      'Thailand',
      'Vietnam',
      'Philippines',
      'Japan',
      'South Korea',
      'Taiwan',
      'China',
      'India',
      'Australia',
    ],
    'asia pacific': [
      'Malaysia',
      'Indonesia',
      'Singapore',
      'Thailand',
      'Vietnam',
      'Philippines',
      'Japan',
      'South Korea',
      'Taiwan',
      'China',
      'India',
      'Australia',
    ],
    latam: ['Brazil', 'Mexico', 'Argentina', 'Chile', 'Colombia', 'Peru'],
    'latin america': ['Brazil', 'Mexico', 'Argentina', 'Chile', 'Colombia', 'Peru'],
  };

  // Check for matching region
  for (const [region, countries] of Object.entries(regionMappings)) {
    if (inputLower.includes(region)) {
      console.log(`  Expanding region "${regionInput}" → "${countries.join(', ')}"`);
      return countries;
    }
  }

  // Check for generic "asia" (default to Southeast Asia main markets)
  if (inputLower === 'asia') {
    const countries = ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'];
    console.log(`  Expanding region "${regionInput}" → "${countries.join(', ')}"`);
    return countries;
  }

  // Return as-is if not a recognized region (single country as array)
  return [regionInput];
}

// Generate business term variations using AI (synonyms, industry terminology)
async function _generateBusinessTermVariations(business) {
  console.log(`  Generating search term variations for "${business}"...`);

  const prompt = `For M&A target search, generate alternative search terms for: "${business}"

RULES:
- Generate 3-5 alternative phrasings/synonyms that mean the SAME specific thing
- Include common industry terminology variations
- Include abbreviations if applicable
- Do NOT broaden the scope (e.g., don't suggest "printing ink" for "gravure ink" - stay specific)
- Focus on how different people might describe this EXACT business

Examples:
- "gravure ink manufacturer" → "rotogravure ink producer", "gravure printing ink maker", "intaglio ink manufacturer"
- "flexure ink" → "flexographic ink", "flexo ink", "flexible packaging ink"
- "CNC machining" → "computer numerical control machining", "precision CNC", "CNC manufacturing"

Return ONLY a JSON array of strings, nothing else.
Example: ["term1", "term2", "term3"]

Variations for "${business}":`;

  try {
    const result = await callGemini3Flash(prompt, true);
    if (result) {
      const jsonMatch = result.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        const variations = JSON.parse(jsonMatch[0]);
        if (Array.isArray(variations) && variations.length > 0) {
          console.log(`  Generated variations: ${variations.join(', ')}`);
          return variations;
        }
      }
    }
  } catch (e) {
    console.error(`  Term variation generation failed: ${e.message}`);
  }

  return []; // Return empty array if generation fails
}

// V6 Smart Planning with GPT-4o - generates comprehensive search strategy
async function generateSmartSearchPlanV6(business, countries, exclusion) {
  console.log(`  GPT-4o generating smart search plan...`);

  const prompt = `You are an expert M&A researcher. Generate a comprehensive search plan to find ALL companies matching this criteria:

BUSINESS TYPE: ${business}
COUNTRIES: ${countries.join(', ')}
EXCLUDE: ${exclusion}

Generate a search plan with:

1. "english_variations": Array of 5-8 alternative English terms/phrases for this business type. Think about:
   - Industry-specific terminology (e.g., "flexure" = "flexographic", "flexo")
   - Technical vs common terms
   - Full names vs abbreviations
   - How manufacturers vs buyers might describe it

2. "local_language_terms": Object with country as key, array of local language search terms as value. For each country, provide 2-4 terms in the LOCAL LANGUAGE that locals would use to search for this business type.

3. "key_industrial_areas": Object with country as key, array of major industrial cities/regions for this industry as value. These are areas where this type of business is likely concentrated.

4. "search_angles": Array of 5 different search approaches to find companies (e.g., "industry associations", "trade directories", "supplier lists", etc.)

Return ONLY valid JSON, no explanation:
{
  "english_variations": ["term1", "term2", ...],
  "local_language_terms": {"Indonesia": ["term1", "term2"], "Thailand": ["term1", "term2"], ...},
  "key_industrial_areas": {"Indonesia": ["city1", "city2"], "Thailand": ["city1", "city2"], ...},
  "search_angles": ["angle1", "angle2", ...]
}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const result = response.choices[0].message.content;
    const plan = JSON.parse(result);

    console.log(`  English variations: ${plan.english_variations?.join(', ') || 'none'}`);
    console.log(`  Local terms: ${Object.keys(plan.local_language_terms || {}).length} countries`);
    console.log(
      `  Industrial areas: ${Object.keys(plan.key_industrial_areas || {}).length} countries`
    );
    console.log(`  Search angles: ${plan.search_angles?.length || 0}`);

    return plan;
  } catch (e) {
    console.error(`  GPT-4o planning failed: ${e.message}`);
    return {
      english_variations: [],
      local_language_terms: {},
      key_industrial_areas: {},
      search_angles: [],
    };
  }
}

// ============ V5 PARALLEL ARCHITECTURE ============

// Run a single Perplexity search task
async function runPerplexitySearchTask(searchPrompt, country, searchLog) {
  const startTime = Date.now();

  console.log(`  Executing Perplexity search...`);
  const result = await callPerplexity(searchPrompt);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`    Completed in ${duration}s`);

  // Log this search
  searchLog.push({
    task: `[Perplexity] ${searchPrompt.substring(0, 80)}...`,
    duration: parseFloat(duration),
    searchQueries: [searchPrompt.substring(0, 100)],
    sourceCount: 1,
    responseLength: result.length,
    model: 'perplexity-sonar-pro',
  });

  // Extract companies from result
  const companies = await extractCompaniesV5(result, country);
  console.log(`    Extracted ${companies.length} companies`);

  return companies;
}

// V6 VALIDATION: GPT-4o parallel validation (best reasoning for judgment tasks)
async function validateCompaniesV6(companies, business, country, exclusion) {
  console.log(`\nV6 GPT-4o Validation: ${companies.length} companies...`);
  const startTime = Date.now();

  const validated = []; // GPT-4o says valid
  const flagged = []; // Security blocked - needs human review
  const rejected = []; // GPT-4o says invalid

  const batchSize = 10; // Parallel validation

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);

    const validations = await Promise.all(
      batch.map(async (company) => {
        try {
          // Fetch website content for validation
          let pageContent = '';
          let fetchResult = { status: 'error', reason: 'No website' };

          if (company.website && company.website.startsWith('http')) {
            try {
              fetchResult = await fetchWebsite(company.website);
            } catch (e) {
              fetchResult = { status: 'error', reason: e.message };
            }
          }

          // Handle different fetch results
          if (fetchResult.status === 'security_blocked') {
            console.log(
              `    ? SECURITY: ${company.company_name} (${fetchResult.reason}) - flagging for human review`
            );
            return {
              company,
              status: 'flagged',
              valid: false,
              reason: `Security blocked: ${fetchResult.reason}`,
              securityBlocked: true,
            };
          }

          if (fetchResult.status !== 'ok') {
            console.log(`    ✗ REMOVED: ${company.company_name} (${fetchResult.reason})`);
            return { company, status: 'skipped' };
          }

          pageContent = fetchResult.content;

          // GPT-4o validation
          const validationPrompt = `Validate if this company matches the search criteria.

COMPANY: ${company.company_name}
WEBSITE: ${company.website}
CLAIMED HQ: ${company.hq}

WEBSITE CONTENT:
${pageContent ? pageContent.substring(0, 8000) : 'Could not fetch website'}

CRITERIA:
- Business type: ${business}
- Target countries: ${country}
- Exclusions: ${exclusion}

VALIDATION RULES:
1. Is this a real company (not a directory, marketplace, or article)?
2. Does their business relate to "${business}"?
3. Is their HQ in one of the target countries (${country})?
4. Do they violate any exclusion criteria (${exclusion})?

Return JSON only: {"valid": true/false, "reason": "one sentence explanation", "corrected_hq": "City, Country or null if unknown"}`;

          const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: validationPrompt }],
            response_format: { type: 'json_object' },
            temperature: 0.1,
          });

          const result = JSON.parse(response.choices[0].message.content);
          return {
            company,
            status: result.valid === true ? 'valid' : 'rejected',
            valid: result.valid === true,
            reason: result.reason || '',
            corrected_hq: result.corrected_hq,
          };
        } catch (e) {
          console.error(`  Validation error for ${company.company_name}: ${e.message}`);
          return { company, status: 'rejected', valid: false, reason: 'Error' };
        }
      })
    );

    for (const v of validations) {
      if (v.status === 'skipped') continue;

      const companyData = {
        company_name: v.company.company_name,
        website: v.company.website,
        hq: v.corrected_hq || v.company.hq,
        reason: v.reason,
        securityBlocked: v.securityBlocked || false,
      };

      if (v.status === 'valid') {
        validated.push(companyData);
        console.log(`    ✓ VALID: ${v.company.company_name}`);
      } else if (v.status === 'flagged') {
        flagged.push(companyData);
        console.log(`    ? FLAGGED: ${v.company.company_name} (Security blocked)`);
      } else {
        rejected.push(companyData);
        console.log(`    ✗ REJECTED: ${v.company.company_name} - ${v.reason}`);
      }
    }

    console.log(
      `  Progress: ${Math.min(i + batchSize, companies.length)}/${companies.length} | Valid: ${validated.length} | Flagged: ${flagged.length} | Rejected: ${rejected.length}`
    );
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nV6 GPT-4o Validation done in ${duration}s`);
  console.log(`  Valid: ${validated.length}`);
  console.log(`  Flagged (security): ${flagged.length}`);
  console.log(`  Rejected: ${rejected.length}`);

  return { validated, flagged, rejected };
}

// Build email with search log summary and three-tier validation results
function _buildV5EmailHTML(validationResults, business, country, exclusion, searchLog) {
  const { validated, flagged, rejected: _rejected } = validationResults;

  // Note: Companies with inaccessible websites are removed entirely during validation (not shown)
  // Flagged = companies where one model agrees but the other doesn't
  const allFlagged = [...flagged];

  // Separate Gemini and ChatGPT tasks
  const geminiTasks = searchLog.filter((s) => !s.model || s.model !== 'chatgpt-search');
  const chatgptTasks = searchLog.filter((s) => s.model === 'chatgpt-search');

  const geminiSummary = geminiTasks
    .map(
      (s, i) =>
        `<li><strong>[Gemini]</strong> Task ${i + 1}: ${s.searchQueries.length} searches, ${s.sourceCount} sources, ${s.duration}s</li>`
    )
    .join('');

  const chatgptSummary = chatgptTasks
    .map((s, i) => `<li><strong>[ChatGPT]</strong> Task ${i + 1}: ${s.duration}s</li>`)
    .join('');

  const totalSearches = searchLog.reduce((sum, s) => sum + s.searchQueries.length, 0);
  const totalSources = searchLog.reduce((sum, s) => sum + s.sourceCount, 0);
  const totalDuration = searchLog.reduce((sum, s) => sum + s.duration, 0);

  let html = `
    <h2>V5 Agentic Search Results</h2>
    <p><strong>Business:</strong> ${business}</p>
    <p><strong>Country:</strong> ${country}</p>
    <p><strong>Exclusions:</strong> ${exclusion}</p>

    <h3>Validation Summary (Dual-Model Consensus)</h3>
    <p>Each company was validated by <strong>both Gemini AND ChatGPT</strong>:</p>
    <ul>
      <li><span style="color: #22c55e; font-weight: bold;">VALIDATED (${validated.length})</span> - Both models agree this is a match</li>
      <li><span style="color: #f59e0b; font-weight: bold;">FLAGGED FOR REVIEW (${allFlagged.length})</span> - Needs human review (one model disagree or insufficient website info)</li>
    </ul>
    <p style="font-size: 12px; color: #666;">Note: Companies clearly outside target region or business scope are automatically excluded.</p>

    <h3>Search Summary</h3>
    <p><strong>Models Used:</strong> Gemini 3 Flash (${geminiTasks.length} tasks) + ChatGPT Search (${chatgptTasks.length} tasks)</p>
    <p>Total internal searches: ${totalSearches} | Sources consulted: ${totalSources} | Search time: ${totalDuration.toFixed(1)}s</p>

    <h4>Gemini Search Tasks</h4>
    <ul>${geminiSummary || '<li>None</li>'}</ul>

    <h4>ChatGPT Search Tasks</h4>
    <ul>${chatgptSummary || '<li>None</li>'}</ul>
  `;

  // Section 1: Validated Companies (Both agree)
  html += `
    <h3 style="color: #22c55e; border-bottom: 2px solid #22c55e; padding-bottom: 8px;">
      ✓ VALIDATED COMPANIES (${validated.length})
    </h3>
    <p style="color: #666; font-size: 12px;">Both Gemini and ChatGPT confirmed these match your criteria</p>
  `;

  if (validated.length > 0) {
    html += `
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; margin-bottom: 30px;">
      <tr style="background-color: #dcfce7;">
        <th>#</th>
        <th>Company</th>
        <th>Website</th>
        <th>Headquarters</th>
        <th>Gemini</th>
        <th>ChatGPT</th>
      </tr>
    `;
    validated.forEach((c, i) => {
      html += `
      <tr>
        <td>${i + 1}</td>
        <td>${c.company_name}</td>
        <td><a href="${c.website}">${c.website}</a></td>
        <td>${c.hq}</td>
        <td style="color: #22c55e;">✓ YES</td>
        <td style="color: #22c55e;">✓ YES</td>
      </tr>
      `;
    });
    html += '</table>';
  } else {
    html += '<p><em>No companies were validated by both models.</em></p>';
  }

  // Section 2: Flagged for Human Review (model disagreements only - inaccessible websites are removed)
  html += `
    <h3 style="color: #f59e0b; border-bottom: 2px solid #f59e0b; padding-bottom: 8px;">
      ? FLAGGED FOR HUMAN REVIEW (${allFlagged.length})
    </h3>
    <p style="color: #666; font-size: 12px;">These need manual verification - models disagreed on whether they match criteria</p>
  `;

  if (allFlagged.length > 0) {
    html += `
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; margin-bottom: 30px;">
      <tr style="background-color: #fef3c7;">
        <th>#</th>
        <th>Company</th>
        <th>Website</th>
        <th>Headquarters</th>
        <th>Reason</th>
      </tr>
    `;
    allFlagged.forEach((c, i) => {
      // Determine reason to display
      let displayReason = '';
      let reasonStyle = 'font-size: 11px; color: #666;';

      if (c.securityBlocked) {
        displayReason = '🔒 Security/WAF blocked - verify manually';
        reasonStyle = 'font-size: 11px; color: #dc2626; font-weight: bold;';
      } else if (c.geminiVote === 'YES' && c.chatgptVote === 'NO') {
        displayReason = 'Gemini: Yes, ChatGPT: No';
      } else if (c.geminiVote === 'NO' && c.chatgptVote === 'YES') {
        displayReason = 'Gemini: No, ChatGPT: Yes';
      } else {
        displayReason = c.reason || 'Needs verification';
      }

      html += `
      <tr>
        <td>${i + 1}</td>
        <td>${c.company_name}</td>
        <td><a href="${c.website}">${c.website}</a></td>
        <td>${c.hq}</td>
        <td style="${reasonStyle}">${displayReason}</td>
      </tr>
      `;
    });
    html += '</table>';
  } else {
    html += '<p><em>No companies need human review.</em></p>';
  }

  // Note: Companies rejected for wrong region/large company/wrong business are not shown

  return html;
}

// V6 Email HTML builder - clean and simple
function buildV6EmailHTML(validationResults, business, country, exclusion) {
  const { validated, flagged } = validationResults;

  let html = `
    <h2>${business} in ${country}</h2>
    <p style="color: #666; margin-bottom: 20px;">Exclusions: ${exclusion}</p>
  `;

  // Validated Companies
  if (validated.length > 0) {
    html += `
    <h3 style="color: #22c55e; margin-bottom: 10px;">Validated (${validated.length})</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; margin-bottom: 30px;">
      <tr style="background-color: #dcfce7;">
        <th style="text-align: left;">#</th>
        <th style="text-align: left;">Company</th>
        <th style="text-align: left;">Website</th>
        <th style="text-align: left;">HQ</th>
      </tr>
    `;
    validated.forEach((c, i) => {
      html += `
      <tr>
        <td>${i + 1}</td>
        <td>${c.company_name}</td>
        <td><a href="${c.website}">${c.website}</a></td>
        <td>${c.hq}</td>
      </tr>
      `;
    });
    html += '</table>';
  }

  // Flagged Companies (security blocked)
  if (flagged.length > 0) {
    html += `
      <h3 style="color: #f59e0b; margin-bottom: 10px;">Flagged - Check Manually (${flagged.length})</h3>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; margin-bottom: 30px;">
        <tr style="background-color: #fef3c7;">
          <th style="text-align: left;">#</th>
          <th style="text-align: left;">Company</th>
          <th style="text-align: left;">Website</th>
          <th style="text-align: left;">HQ</th>
        </tr>
    `;
    flagged.forEach((c, i) => {
      html += `
      <tr>
        <td>${i + 1}</td>
        <td>${c.company_name}</td>
        <td><a href="${c.website}">${c.website}</a></td>
        <td>${c.hq || '-'}</td>
      </tr>
      `;
    });
    html += '</table>';
  }

  if (validated.length === 0 && flagged.length === 0) {
    html += '<p>No companies found matching your criteria.</p>';
  }

  return html;
}

// V6 ENDPOINT - Iterative Parallel Search Architecture
app.post('/api/find-target-v6', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`V6 ITERATIVE PARALLEL SEARCH: ${new Date().toISOString()}`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(70));

  // Return immediately - process in background
  res.json({
    success: true,
    message: 'Request received. Results will be emailed in ~12-15 minutes.',
  });

  // Initialize tracker for cost tracking
  const tracker = createTracker('target-v6', Email, { Business, Country, Exclusion });

  trackingContext.run(tracker, async () => {
  try {
    const totalStart = Date.now();
    const searchLog = [];

    // ========== STEP 1: Smart Planning with GPT-4o ==========
    console.log('\n' + '='.repeat(50));
    console.log('STEP 1: GPT-4o SMART PLANNING');
    console.log('='.repeat(50));

    // Expand region to countries first
    const countries = await expandRegionToCountries(Country);
    const expandedCountry = countries.join(', ');
    console.log(`  Country input: "${Country}" → "${expandedCountry}"`);

    // Generate smart search plan with GPT-4o
    const smartPlan = await generateSmartSearchPlanV6(Business, countries, Exclusion);

    // Build comprehensive search terms from the plan
    const _allSearchTerms = [Business, ...smartPlan.english_variations];
    const localTermsFlat = Object.values(smartPlan.local_language_terms || {}).flat();
    const industrialAreasFlat = Object.values(smartPlan.key_industrial_areas || {}).flat();

    console.log(`\n  SEARCH PLAN SUMMARY:`);
    console.log(`  - Primary term: ${Business}`);
    console.log(`  - English variations: ${smartPlan.english_variations?.join(', ') || 'none'}`);
    console.log(`  - Local language terms: ${localTermsFlat.join(', ') || 'none'}`);
    console.log(`  - Key industrial areas: ${industrialAreasFlat.join(', ') || 'none'}`);
    console.log(`  - Search angles: ${smartPlan.search_angles?.join(', ') || 'none'}`);

    // ========== STEP 2: Iterative Parallel Search (10 rounds) ==========
    console.log('\n' + '='.repeat(50));
    console.log('STEP 2: ITERATIVE PARALLEL SEARCH (7 rounds)');
    console.log('='.repeat(50));

    const NUM_ROUNDS = 7; // Reduced from 10 - rounds 8-10 had diminishing returns
    const allCompanies = [];
    const seenWebsites = new Set();

    // Smart search prompts that USE the GPT-4o generated plan
    const getSearchPrompt = (round, business, country, exclusion, alreadyFoundList, plan) => {
      const findMoreClause = alreadyFoundList
        ? `\nALREADY FOUND (do NOT repeat these): ${alreadyFoundList}\nFind MORE companies not in this list.`
        : '';

      // Build terminology hint from plan
      const termHint =
        plan.english_variations?.length > 0
          ? `\nALTERNATIVE TERMS TO SEARCH: ${plan.english_variations.join(', ')}`
          : '';

      // Build local language hint
      const localTerms = Object.entries(plan.local_language_terms || {})
        .map(([c, terms]) => `${c}: ${terms.join(', ')}`)
        .join('; ');
      const localHint = localTerms ? `\nLOCAL LANGUAGE TERMS: ${localTerms}` : '';

      // Build industrial areas hint
      const areasHint = Object.entries(plan.key_industrial_areas || {})
        .map(([c, areas]) => `${c}: ${areas.join(', ')}`)
        .join('; ');
      const citiesHint = areasHint ? `\nKEY INDUSTRIAL AREAS: ${areasHint}` : '';

      const prompts = [
        // Round 1: Comprehensive with all variations
        `Find ALL ${business} companies in ${country}. Be exhaustive - include large, medium, and small companies.${termHint}${findMoreClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 2: Local language search
        `Find ${business} companies in ${country}. Search using LOCAL LANGUAGE terms that businesses in these countries would use.${localHint}${findMoreClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 3: Industrial areas focus
        `Find ${business} companies in ${country}. Focus on major industrial cities and manufacturing hubs.${citiesHint}${findMoreClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 4: SME and private companies
        `Find small, medium, private, and family-owned ${business} companies in ${country}. These are often not well-known but important players.${termHint}${findMoreClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 5: Industry associations and directories
        `Find ${business} companies in ${country} through industry associations, trade directories, supplier lists, and member registries.${findMoreClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 6: Alternative terminology deep dive
        `Find ${business} companies in ${country}. Use ALL alternative industry terms.${termHint}${localHint}${findMoreClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 7: Regional players by city
        `Find regional and local ${business} companies in ${country}. Search by specific cities and provinces.${citiesHint}${findMoreClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,
      ];

      return prompts[round % prompts.length];
    };

    const roundDescriptions = [
      'comprehensive',
      'local language',
      'industrial areas',
      'SME/private',
      'associations',
      'alt terminology',
      'regional/city',
    ];

    for (let round = 0; round < NUM_ROUNDS; round++) {
      const roundStart = Date.now();

      // Build "already found" list (company names only to save tokens)
      const alreadyFoundLimit = 100;
      const alreadyFound = allCompanies
        .slice(0, alreadyFoundLimit)
        .map((c) => c.company_name)
        .join(', ');

      console.log(`\n  --- ROUND ${round + 1}/${NUM_ROUNDS} (${roundDescriptions[round]}) ---`);

      // Generate prompt for this round (using GPT-4o smart plan)
      const prompt = getSearchPrompt(
        round,
        Business,
        expandedCountry,
        Exclusion,
        alreadyFound,
        smartPlan
      );

      // Run all 3 models in parallel
      const [perplexityResults, geminiResults, chatgptResults] = await Promise.all([
        runPerplexitySearchTask(prompt, expandedCountry, searchLog).catch((e) => {
          console.error(`    Perplexity failed: ${e.message}`);
          return [];
        }),
        runAgenticSearchTask(prompt, expandedCountry, searchLog).catch((e) => {
          console.error(`    Gemini failed: ${e.message}`);
          return [];
        }),
        runChatGPTSearchTask(
          `${Business} companies ${expandedCountry}`,
          prompt,
          expandedCountry,
          searchLog
        ).catch((e) => {
          console.error(`    ChatGPT failed: ${e.message}`);
          return [];
        }),
      ]);

      // Combine results from this round
      const roundCompanies = [...perplexityResults, ...geminiResults, ...chatgptResults];
      console.log(
        `    Found: Perplexity ${perplexityResults.length}, Gemini ${geminiResults.length}, ChatGPT ${chatgptResults.length}`
      );

      // Dedupe within round
      const uniqueRound = dedupeCompanies(roundCompanies);

      // Filter out already-seen companies
      const newCompanies = uniqueRound.filter((c) => {
        const website = c.website?.toLowerCase();
        if (!website || seenWebsites.has(website)) return false;
        seenWebsites.add(website);
        return true;
      });

      // Pre-filter (free - no API calls)
      const preFiltered = preFilterCompanies(newCompanies);

      // Add to master list
      allCompanies.push(...preFiltered);

      const roundDuration = ((Date.now() - roundStart) / 1000).toFixed(1);
      console.log(
        `    New companies: ${preFiltered.length} | Total: ${allCompanies.length} | Time: ${roundDuration}s`
      );

      // Early termination: if <3 new companies found after round 3, stop searching
      if (round >= 3 && preFiltered.length < 3) {
        console.log(`    Early termination: diminishing returns (<3 new companies)`);
        break;
      }
    }

    console.log(`\n  Search complete. Total unique companies: ${allCompanies.length}`);

    // ========== STEP 3: GPT-4o Validation ==========
    console.log('\n' + '='.repeat(50));
    console.log('STEP 3: GPT-4o VALIDATION');
    console.log('='.repeat(50));

    const validationResults = await validateCompaniesV6(
      allCompanies,
      Business,
      expandedCountry,
      Exclusion
    );
    const { validated, flagged, rejected } = validationResults;

    // ========== STEP 4: Results ==========
    console.log('\n' + '='.repeat(50));
    console.log('STEP 4: FINAL RESULTS');
    console.log('='.repeat(50));

    console.log(`V6 FINAL RESULTS:`);
    console.log(`  ✓ VALIDATED: ${validated.length}`);
    console.log(`  ? FLAGGED (security blocked): ${flagged.length}`);
    console.log(`  ✗ REJECTED: ${rejected.length}`);

    // Stats
    const perplexityCount = searchLog.filter((s) => s.model === 'perplexity-sonar-pro').length;
    const geminiCount = searchLog.filter((s) => !s.model || s.model === 'gemini').length;
    const chatgptCount = searchLog.filter((s) => s.model === 'chatgpt-search').length;

    console.log(`\nSearch Statistics:`);
    console.log(`  Rounds: ${NUM_ROUNDS}`);
    console.log(`  Perplexity: ${perplexityCount} searches`);
    console.log(`  Gemini: ${geminiCount} searches`);
    console.log(`  ChatGPT: ${chatgptCount} searches`);
    console.log(`  Total: ${perplexityCount + geminiCount + chatgptCount} searches`);

    // ========== STEP 5: Send email with results ==========
    const finalResults = { validated, flagged, rejected };
    const htmlContent = buildV6EmailHTML(finalResults, Business, expandedCountry, Exclusion);

    await sendEmail(
      Email,
      `[V6] ${Business} in ${Country} (${validated.length} validated + ${flagged.length} flagged)`,
      htmlContent
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log('\n' + '='.repeat(70));
    console.log(`V6 ITERATIVE SEARCH COMPLETE!`);
    console.log(`Email sent to: ${Email}`);
    console.log(
      `Validated: ${validated.length} | Flagged: ${flagged.length} | Rejected: ${rejected.length}`
    );
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(70));

    // Finalize tracking (real token counts recorded via recordTokens in wrappers)
    await tracker.finish({
      searchRounds: searchLog.length,
      companiesFound: allCompanies.length,
      validated: validated.length,
      flagged: flagged.length,
      rejected: rejected.length,
    });
  } catch (error) {
    console.error('V6 Processing error:', error);
    await tracker.finish({ status: 'error', error: error.message }).catch(() => {});
    // Try to send error email
    sendEmail(Email, `Find Target V6 - Error`, `<p>Error: ${error.message}</p>`).catch((e) =>
      console.error('Failed to send error email:', e)
    );
  }
  }); // end trackingContext.run
});

// ============ HEALTH CHECK ============
app.get('/health', healthCheck('target-v6'));

// ============ HEALTHCHECK ============
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'target-v6' });
});

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Target V6 server running on port ${PORT}`);
});
