require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const { securityHeaders, rateLimiter } = require('./shared/security');
const { requestLogger, healthCheck } = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { sendEmailLegacy: sendEmail } = require('./shared/email');

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

async function _validateCompanyStrict(company, business, country, exclusion, pageText) {
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

// ============ VALIDATION FOR SLOW MODE (v23 - n8n style) ============

async function _validateCompany(company, business, country, exclusion, pageText) {
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
async function generateBusinessTermVariations(business) {
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

// ============ V5 PARALLEL ARCHITECTURE ============

// Phase 0: Plan search strategy - determine languages, generate comprehensive search plan
async function planSearchStrategyV5(business, country, _exclusion) {
  console.log('\n' + '='.repeat(50));
  console.log('PHASE 0: PLANNING SEARCH STRATEGY');
  console.log('='.repeat(50));

  const startTime = Date.now();

  // Expand regional inputs to specific countries (returns array)
  const countries = await expandRegionToCountries(country);
  const expandedCountry = countries.join(', '); // String for prompts
  console.log(`  Country input: "${country}" → "${expandedCountry}"`);

  // Generate business term variations
  const businessVariations = await generateBusinessTermVariations(business);
  console.log(
    `  Term variations: ${businessVariations.length > 0 ? businessVariations.join(', ') : 'none generated'}`
  );

  // Determine languages for each country
  const countryLanguages = {};
  for (const c of countries) {
    const cLower = c.toLowerCase();
    if (cLower.includes('thailand')) countryLanguages[c] = 'Thai';
    else if (cLower.includes('vietnam')) countryLanguages[c] = 'Vietnamese';
    else if (cLower.includes('indonesia')) countryLanguages[c] = 'Indonesian/Bahasa';
    else if (cLower.includes('malaysia')) countryLanguages[c] = 'Malay/Chinese';
    else if (cLower.includes('philippines')) countryLanguages[c] = 'Filipino/English';
    else if (cLower.includes('japan')) countryLanguages[c] = 'Japanese';
    else if (cLower.includes('korea')) countryLanguages[c] = 'Korean';
    else if (cLower.includes('china')) countryLanguages[c] = 'Chinese';
    else if (cLower.includes('taiwan')) countryLanguages[c] = 'Chinese';
    else countryLanguages[c] = 'English/Local';
  }

  console.log(
    `  Languages: ${Object.entries(countryLanguages)
      .map(([c, l]) => `${c}=${l}`)
      .join(', ')}`
  );
  console.log(`  Planning completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return {
    expandedCountry,
    countries,
    businessVariations,
    countryLanguages,
  };
}

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

// Phase 1: Perplexity main search with batched validation
// Key: Run searches in 4 batches to avoid rate limits, validate each batch before next
async function runPerplexityMainSearchWithValidation(plan, business, exclusion, searchLog) {
  console.log('\n' + '='.repeat(50));
  console.log('PHASE 1: PERPLEXITY MAIN SEARCH (BATCHED) + VALIDATION');
  console.log('='.repeat(50));

  const { expandedCountry, countries, businessVariations } = plan;
  const startTime = Date.now();

  // Generate Perplexity search queries - comprehensive but focused
  const perplexityQueries = [
    // Main comprehensive search
    `List ALL ${business} companies, manufacturers, and producers in ${expandedCountry}.
     Include: company names, official websites (not directories), headquarters locations.
     Be EXHAUSTIVE - find every company you can. Include large, medium, and small companies.
     EXCLUSIONS: ${exclusion}`,

    // SME and local focus
    `Find small and medium-sized ${business} companies in ${expandedCountry}.
     Focus on: family businesses, local manufacturers, independent producers.
     These are often acquisition targets. Include websites and HQ locations.
     Exclude large multinationals and ${exclusion}`,

    // Industry associations and directories
    `Find ${business} companies through industry associations and trade directories in ${expandedCountry}.
     Search: association member lists, trade show exhibitors, certification bodies.
     Return company names, websites, and locations.`,

    // Contract manufacturing and suppliers
    `Find ${business} OEM, ODM, and contract manufacturers in ${expandedCountry}.
     Include: toll manufacturers, private label producers, subcontractors.
     Return company names, websites, and HQ locations.`,

    // Supply chain exploration
    `Who are the ${business} suppliers and manufacturers in ${expandedCountry}?
     Look at: raw material suppliers, equipment manufacturers, finished goods producers.
     Return company names, official websites, and headquarters.`,
  ];

  // Add country-specific searches
  for (const c of countries.slice(0, 4)) {
    perplexityQueries.push(
      `Complete list of ${business} companies in ${c}.
       Include all manufacturers, industrial estates, and local producers.
       Return company name, website, and city location.`
    );
  }

  // Add term variation searches
  for (const variation of businessVariations.slice(0, 3)) {
    perplexityQueries.push(
      `Find ${variation} companies and manufacturers in ${expandedCountry}.
       Return company names, websites, and headquarters locations.`
    );
  }

  console.log(`  Generated ${perplexityQueries.length} Perplexity search queries`);

  // Split queries into 4 batches to avoid rate limits
  const batchSize = Math.ceil(perplexityQueries.length / 4);
  const batches = [];
  for (let i = 0; i < perplexityQueries.length; i += batchSize) {
    batches.push(perplexityQueries.slice(i, i + batchSize));
  }

  console.log(
    `  Split into ${batches.length} batches (${batches.map((b) => b.length).join(', ')} queries each)`
  );

  // Accumulate results across batches
  const allValidated = [];
  const allFlagged = [];
  const allRejected = [];
  const seenWebsites = new Set(); // Track already validated websites

  // Process each batch: search → dedupe → validate → next batch
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    console.log(`\n  --- BATCH ${batchIdx + 1}/${batches.length} (${batch.length} queries) ---`);

    // Run this batch of Perplexity searches in parallel
    const searchPromises = batch.map((query, idx) =>
      runPerplexitySearchTask(query, expandedCountry, searchLog).catch((e) => {
        console.error(`    Perplexity batch ${batchIdx + 1} query ${idx + 1} failed: ${e.message}`);
        return [];
      })
    );

    const searchResults = await Promise.all(searchPromises);
    const batchCompanies = searchResults.flat();
    console.log(`    Found ${batchCompanies.length} companies (before dedup)`);

    // Dedupe within batch
    const uniqueBatch = dedupeCompanies(batchCompanies);
    console.log(`    After dedup: ${uniqueBatch.length} unique companies`);

    // Remove companies already validated in previous batches
    const newCompanies = uniqueBatch.filter((c) => {
      const website = c.website?.toLowerCase();
      if (!website || seenWebsites.has(website)) return false;
      return true;
    });
    console.log(`    New companies (not in previous batches): ${newCompanies.length}`);

    if (newCompanies.length === 0) {
      console.log(`    Skipping validation - no new companies`);
      continue;
    }

    // Pre-filter
    const preFiltered = preFilterCompanies(newCompanies);
    console.log(`    After pre-filter: ${preFiltered.length} companies`);

    if (preFiltered.length === 0) {
      console.log(`    Skipping validation - no companies after pre-filter`);
      continue;
    }

    // Validate this batch
    console.log(`    Validating ${preFiltered.length} companies...`);
    const batchResults = await validateCompaniesV5(
      preFiltered,
      business,
      expandedCountry,
      exclusion
    );

    // Add to accumulated results
    allValidated.push(...batchResults.validated);
    allFlagged.push(...batchResults.flagged);
    allRejected.push(...batchResults.rejected);

    // Track validated websites to avoid re-validating
    for (const c of [
      ...batchResults.validated,
      ...batchResults.flagged,
      ...batchResults.rejected,
    ]) {
      if (c.website) seenWebsites.add(c.website.toLowerCase());
    }

    console.log(
      `    Batch ${batchIdx + 1} results: ${batchResults.validated.length} valid, ${batchResults.flagged.length} flagged, ${batchResults.rejected.length} rejected`
    );
    console.log(
      `    Running totals: ${allValidated.length} valid, ${allFlagged.length} flagged, ${allRejected.length} rejected`
    );
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n  Phase 1 completed in ${duration} minutes`);
  console.log(`    Validated: ${allValidated.length}`);
  console.log(`    Flagged: ${allFlagged.length}`);
  console.log(`    Rejected: ${allRejected.length}`);

  return { validated: allValidated, flagged: allFlagged, rejected: allRejected };
}

// Phase 2: Iterative Gemini + ChatGPT searches with "find more" pressure
// Key: Each round builds on validated companies, forcing models to find NEW ones
async function runIterativeSecondarySearches(
  plan,
  business,
  exclusion,
  searchLog,
  existingValidated = []
) {
  console.log('\n' + '='.repeat(50));
  console.log('PHASE 2: ITERATIVE GEMINI + CHATGPT SEARCHES');
  console.log('='.repeat(50));

  const { expandedCountry } = plan;
  const startTime = Date.now();
  const NUM_ROUNDS = 12;

  // Track all validated and flagged companies across rounds
  const allValidated = [...existingValidated];
  const allFlagged = [];
  const allRejected = [];
  const seenWebsites = new Set(
    existingValidated.map((c) => c.website?.toLowerCase()).filter(Boolean)
  );

  // Simple brute force prompts - just keep asking for more
  const geminiAngles = [
    (found) => `Find ALL ${business} companies in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find ${business} manufacturers in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find ${business} producers in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find ${business} suppliers in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find small ${business} companies in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find local ${business} companies in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `List of ${business} companies in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find more ${business} companies in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (${found.length} companies): ${found.join(', ')}\nFind ANY additional companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,
  ];

  const chatgptAngles = [
    (found) => ({
      query: `${business} companies in ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.',
    }),

    (found) => ({
      query: `${business} manufacturers ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.',
    }),

    (found) => ({
      query: `${business} producers ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.',
    }),

    (found) => ({
      query: `${business} suppliers ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.',
    }),

    (found) => ({
      query: `small ${business} companies ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.',
    }),

    (found) => ({
      query: `local ${business} companies ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.',
    }),

    (found) => ({
      query: `list of ${business} companies ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.',
    }),

    (found) => ({
      query: `all ${business} companies ${expandedCountry}`,
      context:
        found.length > 0
          ? `Found ${found.length}: ${found.join(', ')}. Find ANY more.`
          : 'Find all.',
    }),
  ];

  // Run 8 rounds of search → validate
  for (let round = 0; round < NUM_ROUNDS; round++) {
    console.log(`\n  --- ROUND ${round + 1}/${NUM_ROUNDS} ---`);

    // Get list of already-found company names for the prompt
    const foundCompanyNames = allValidated.map((c) => c.company_name).slice(0, 50); // Limit to avoid prompt overflow

    // Generate prompts for this round (cycle through available prompts)
    const geminiPrompt = geminiAngles[round % geminiAngles.length](foundCompanyNames);
    const chatgptConfig = chatgptAngles[round % chatgptAngles.length](foundCompanyNames);

    // Run Gemini and ChatGPT searches IN PARALLEL
    console.log(`    Running Gemini + ChatGPT searches in parallel...`);
    const [geminiCompanies, chatgptCompanies] = await Promise.all([
      runAgenticSearchTask(geminiPrompt, expandedCountry, searchLog).catch((e) => {
        console.error(`    Gemini round ${round + 1} failed: ${e.message}`);
        return [];
      }),
      runChatGPTSearchTask(
        chatgptConfig.query,
        chatgptConfig.context,
        expandedCountry,
        searchLog
      ).catch((e) => {
        console.error(`    ChatGPT round ${round + 1} failed: ${e.message}`);
        return [];
      }),
    ]);

    console.log(
      `    Gemini found: ${geminiCompanies.length}, ChatGPT found: ${chatgptCompanies.length}`
    );

    // Combine and dedupe
    const roundCompanies = [...geminiCompanies, ...chatgptCompanies];
    const uniqueRound = dedupeCompanies(roundCompanies);

    // Filter out already-validated companies
    const newCompanies = uniqueRound.filter((c) => {
      const website = c.website?.toLowerCase();
      if (!website || seenWebsites.has(website)) return false;
      return true;
    });

    console.log(`    New companies (not previously found): ${newCompanies.length}`);

    if (newCompanies.length === 0) {
      console.log(`    No new companies found in round ${round + 1}, continuing...`);
      continue;
    }

    // Pre-filter
    const preFiltered = preFilterCompanies(newCompanies);
    console.log(`    After pre-filter: ${preFiltered.length}`);

    if (preFiltered.length === 0) {
      continue;
    }

    // Validate this round's companies
    console.log(`    Validating ${preFiltered.length} companies...`);
    const roundResults = await validateCompaniesV5(
      preFiltered,
      business,
      expandedCountry,
      exclusion
    );

    // Add to cumulative results
    allValidated.push(...roundResults.validated);
    allFlagged.push(...roundResults.flagged);
    allRejected.push(...roundResults.rejected);

    // Track seen websites
    for (const c of [
      ...roundResults.validated,
      ...roundResults.flagged,
      ...roundResults.rejected,
    ]) {
      if (c.website) seenWebsites.add(c.website.toLowerCase());
    }

    console.log(
      `    Round ${round + 1} results: ${roundResults.validated.length} valid, ${roundResults.flagged.length} flagged`
    );
    console.log(`    Cumulative: ${allValidated.length} valid, ${allFlagged.length} flagged`);
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n  Phase 2 completed in ${duration} minutes`);
  console.log(`    Total validated: ${allValidated.length}`);
  console.log(`    Total flagged: ${allFlagged.length}`);

  return { validated: allValidated, flagged: allFlagged, rejected: allRejected };
}

// Generate diverse search tasks for a business/country
// Key insight: Exhaustiveness comes from DIFFERENT SEARCH ANGLES, not more search tools
// Validate a single company with one model
async function validateSingleCompany(company, business, country, exclusion, pageContent, model) {
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

  try {
    let result;
    if (model === 'gemini') {
      result = await callGemini3Flash(validationPrompt, true);
    } else {
      // ChatGPT validation
      result = await callChatGPT(validationPrompt);
    }

    const jsonMatch = result.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        valid: parsed.valid === true,
        reason: parsed.reason || '',
        corrected_hq: parsed.corrected_hq,
      };
    }
    return { valid: false, reason: 'Parse error' };
  } catch (e) {
    return { valid: false, reason: `Error: ${e.message}` };
  }
}

// Validate companies using dual-model consensus (Gemini + ChatGPT)
// Both say yes → Valid | One says yes → Flagged | None say yes → Rejected
async function validateCompaniesV5(companies, business, country, exclusion) {
  console.log(
    `\nV5 Dual-Model Validation: ${companies.length} companies with Gemini + ChatGPT consensus...`
  );
  const startTime = Date.now();

  const validated = []; // Both models agree = Valid
  const flagged = []; // Only one model agrees = Flagged for review
  const rejected = []; // Neither model agrees = Rejected

  const batchSize = 3; // Reduced from 5 to prevent OOM with 2 AI models per company

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);

    const validations = await Promise.all(
      batch.map(async (company) => {
        try {
          // Fetch website content for validation (shared between both models)
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
            // Website has security/Cloudflare protection - FLAG for human review, don't remove
            console.log(
              `    ? SECURITY: ${company.company_name} (${fetchResult.reason}) - flagging for human review`
            );
            return {
              company,
              status: 'flagged',
              geminiValid: false,
              chatgptValid: false,
              geminiReason: `Security blocked: ${fetchResult.reason}`,
              chatgptReason: `Security blocked: ${fetchResult.reason}`,
              securityBlocked: true,
            };
          }

          if (fetchResult.status !== 'ok') {
            // Website truly inaccessible - remove
            console.log(`    ✗ REMOVED: ${company.company_name} (${fetchResult.reason})`);
            return { company, status: 'skipped' };
          }

          pageContent = fetchResult.content;

          // Run both validations in parallel
          const [geminiResult, chatgptResult] = await Promise.all([
            validateSingleCompany(company, business, country, exclusion, pageContent, 'gemini'),
            validateSingleCompany(company, business, country, exclusion, pageContent, 'chatgpt'),
          ]);

          // Determine consensus status
          const geminiValid = geminiResult.valid === true;
          const chatgptValid = chatgptResult.valid === true;

          let status;
          if (geminiValid && chatgptValid) {
            status = 'valid';
          } else if (geminiValid || chatgptValid) {
            status = 'flagged';
          } else {
            status = 'rejected';
          }

          return {
            company,
            status,
            geminiValid,
            chatgptValid,
            geminiReason: geminiResult.reason,
            chatgptReason: chatgptResult.reason,
            corrected_hq: geminiResult.corrected_hq || chatgptResult.corrected_hq,
          };
        } catch (e) {
          console.error(`  Validation error for ${company.company_name}: ${e.message}`);
          return {
            company,
            status: 'rejected',
            geminiValid: false,
            chatgptValid: false,
            geminiReason: 'Error',
            chatgptReason: 'Error',
          };
        }
      })
    );

    for (const v of validations) {
      // Skip companies with inaccessible websites (already logged above)
      if (v.status === 'skipped') continue;

      const companyData = {
        company_name: v.company.company_name,
        website: v.company.website,
        hq: v.corrected_hq || v.company.hq,
        geminiVote: v.geminiValid ? 'YES' : 'NO',
        chatgptVote: v.chatgptValid ? 'YES' : 'NO',
        reason: v.geminiValid ? v.geminiReason : v.chatgptReason,
        securityBlocked: v.securityBlocked || false,
      };

      if (v.status === 'valid') {
        validated.push(companyData);
        console.log(`    ✓ VALID: ${v.company.company_name} (Gemini: YES, ChatGPT: YES)`);
      } else if (v.status === 'flagged') {
        flagged.push(companyData);
        if (v.securityBlocked) {
          console.log(
            `    ? FLAGGED: ${v.company.company_name} (Security/WAF blocked - needs human review)`
          );
        } else {
          console.log(
            `    ? FLAGGED: ${v.company.company_name} (Gemini: ${v.geminiValid ? 'YES' : 'NO'}, ChatGPT: ${v.chatgptValid ? 'YES' : 'NO'})`
          );
        }
      } else {
        rejected.push(companyData);
        console.log(`    ✗ REJECTED: ${v.company.company_name} (Gemini: NO, ChatGPT: NO)`);
      }
    }

    console.log(
      `  Progress: ${Math.min(i + batchSize, companies.length)}/${companies.length} | Valid: ${validated.length} | Flagged: ${flagged.length} | Rejected: ${rejected.length}`
    );

    // Force garbage collection between batches to prevent OOM on Railway (450MB limit)
    if (global.gc) {
      global.gc();
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nV5 Dual-Model Validation done in ${duration}s`);
  console.log(`  Valid (both agree): ${validated.length}`);
  console.log(`  Flagged (one agrees): ${flagged.length}`);
  console.log(`  Rejected (none agree): ${rejected.length}`);

  return { validated, flagged, rejected };
}

// Build email with search log summary and three-tier validation results
function buildV5EmailHTML(validationResults, business, country, exclusion, searchLog) {
  const { validated, flagged } = validationResults;

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

// V5 ENDPOINT - Parallel Architecture with Perplexity as Main Search
app.post('/api/find-target-v5', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`V5 PARALLEL SEARCH: ${new Date().toISOString()}`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(70));

  res.json({
    success: true,
    message:
      'Request received. Parallel search running. Results will be emailed in ~10-15 minutes.',
  });

  // Start keep-alive to prevent Railway from stopping container during long search
  startKeepAlive();

  try {
    const totalStart = Date.now();
    const searchLog = [];

    // ========== PHASE 0: Plan Search Strategy ==========
    const plan = await planSearchStrategyV5(Business, Country, Exclusion);

    // ========== PHASE 1: Perplexity Main Search + Parallel Validation ==========
    // This is the PRIMARY search - runs Perplexity searches in batches, then validates
    const phase1Results = await runPerplexityMainSearchWithValidation(
      plan,
      Business,
      Exclusion,
      searchLog
    );

    // ========== PHASE 2: Iterative Gemini + ChatGPT with "Find More" Pressure ==========
    // Runs 4 rounds of search → validate, each round building on validated companies
    // This forces models to find NEW companies instead of repeating the same ones
    const phase2Results = await runIterativeSecondarySearches(
      plan,
      Business,
      Exclusion,
      searchLog,
      phase1Results.validated // Pass Phase 1 validated companies so Phase 2 knows what's already found
    );

    // ========== PHASE 3: Final Results ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 3: FINAL RESULTS');
    console.log('='.repeat(50));

    // Phase 2 already includes Phase 1 validated companies in its results
    // Just need to merge flagged and rejected
    const allValidated = phase2Results.validated;
    const allFlagged = [...phase1Results.flagged, ...phase2Results.flagged];
    const allRejected = [...phase1Results.rejected, ...phase2Results.rejected];

    // Final dedup
    const finalValidated = dedupeCompanies(allValidated);
    const finalFlagged = dedupeCompanies(allFlagged);
    const finalRejected = dedupeCompanies(allRejected);

    console.log(`FINAL RESULTS:`);
    console.log(`  ✓ VALIDATED (both models agree): ${finalValidated.length}`);
    console.log(`    - From Perplexity (Phase 1): ${phase1Results.validated.length}`);
    console.log(
      `    - Added by Gemini/ChatGPT (Phase 2): ${phase2Results.validated.length - phase1Results.validated.length}`
    );
    console.log(`  ? FLAGGED (needs review): ${finalFlagged.length}`);
    console.log(`  ✗ REJECTED (neither agrees): ${finalRejected.length}`);

    // Calculate stats
    const perplexityTasks = searchLog.filter((s) => s.model === 'perplexity-sonar-pro').length;
    const geminiTasks = searchLog.filter((s) => !s.model || s.model === 'gemini').length;
    const chatgptTasks = searchLog.filter((s) => s.model === 'chatgpt-search').length;
    const totalSearches = searchLog.reduce((sum, s) => sum + s.searchQueries.length, 0);
    const totalSources = searchLog.reduce((sum, s) => sum + s.sourceCount, 0);

    console.log(`\nSearch Statistics:`);
    console.log(`  Perplexity searches: ${perplexityTasks} (Phase 1 - batched)`);
    console.log(`  Gemini searches: ${geminiTasks} (Phase 2 - 8 rounds)`);
    console.log(`  ChatGPT searches: ${chatgptTasks} (Phase 2 - 8 rounds)`);
    console.log(`  Total internal searches: ${totalSearches}`);
    console.log(`  Total sources consulted: ${totalSources}`);

    // Send email with three-tier results
    const finalResults = {
      validated: finalValidated,
      flagged: finalFlagged,
      rejected: finalRejected,
    };
    const htmlContent = buildV5EmailHTML(
      finalResults,
      Business,
      plan.expandedCountry,
      Exclusion,
      searchLog
    );

    await sendEmail(
      Email,
      `[V5 ITERATIVE] ${Business} in ${Country} (${finalValidated.length} validated + ${finalFlagged.length} flagged)`,
      htmlContent
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log('\n' + '='.repeat(70));
    console.log(`V5 ITERATIVE SEARCH COMPLETE!`);
    console.log(`Email sent to: ${Email}`);
    console.log(
      `Validated: ${finalValidated.length} | Flagged: ${finalFlagged.length} | Rejected: ${finalRejected.length}`
    );
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(70));
  } catch (error) {
    console.error('V5 Processing error:', error);
    try {
      await sendEmail(Email, `Find Target V5 - Error`, `<p>Error: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  } finally {
    // Stop keep-alive when search completes (success or error)
    stopKeepAlive();
  }
});

// ============ HEALTH CHECK ============
app.get('/health', healthCheck('target-v5'));

// ============ HEALTHCHECK ============
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'target-v5' });
});

// ============ KEEP-ALIVE MECHANISM ============
// Prevents Railway from stopping the container during long-running searches
let activeSearchCount = 0;
let keepAliveInterval = null;

function startKeepAlive() {
  activeSearchCount++;
  if (keepAliveInterval) return; // Already running

  console.log('  [Keep-Alive] Starting keep-alive pings to prevent container shutdown');
  keepAliveInterval = setInterval(async () => {
    if (activeSearchCount <= 0) {
      stopKeepAlive();
      return;
    }
    try {
      // Self-ping to keep container active
      await fetch(`http://localhost:${PORT}/health`);
      console.log(`  [Keep-Alive] Ping sent (${activeSearchCount} active search(es))`);
    } catch (e) {
      // Ignore errors - container is still alive if this code runs
    }
  }, 30000); // Ping every 30 seconds
}

function stopKeepAlive() {
  activeSearchCount = Math.max(0, activeSearchCount - 1);
  if (activeSearchCount === 0 && keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    console.log('  [Keep-Alive] Stopped - no active searches');
  }
}

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Target V5 server running on port ${PORT}`);
});
