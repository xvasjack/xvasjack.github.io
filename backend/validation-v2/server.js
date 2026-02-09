require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const XLSX = require('xlsx');
const pptxgen = require('pptxgenjs');
const { securityHeaders, rateLimiter } = require('./shared/security');
const { requestLogger, healthCheck } = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { sendEmailLegacy: sendEmail } = require('./shared/email');
const { createTracker, trackingContext, recordTokens } = require('./shared/tracking');
const { withRetry } = require('./shared/ai-models');

setupGlobalErrorHandlers();

const app = express();
app.use(securityHeaders);
app.use(rateLimiter);
app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const requiredEnvVars = ['GEMINI_API_KEY', 'SERPAPI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}

// ============ URL CACHE ============

const urlCache = new Map(); // key: normalized company name, value: { url, timestamp }
const URL_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function normalizeForCache(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getCachedUrl(companyName) {
  const key = normalizeForCache(companyName);
  const entry = urlCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > URL_CACHE_TTL) {
    urlCache.delete(key);
    return null;
  }
  return entry.url;
}

function setCachedUrl(companyName, url) {
  const key = normalizeForCache(companyName);
  urlCache.set(key, { url, timestamp: Date.now() });
}

// ============ AI TOOLS ============

// Gemini 2.5 Flash with Google Search grounding — URL discovery + WAF fallback
async function callGeminiWithGrounding(prompt) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
        }),
        timeout: 60000,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `Gemini 2.5 Flash grounding HTTP error ${response.status}:`,
        errorText.substring(0, 200)
      );
      return { text: '', groundingChunks: [] };
    }

    const data = await response.json();

    const usage = data.usageMetadata;
    if (usage) {
      recordTokens(
        'gemini-2.5-flash',
        usage.promptTokenCount || 0,
        usage.candidatesTokenCount || 0
      );
    }

    if (data.error) {
      console.error('Gemini 2.5 Flash grounding API error:', data.error.message);
      return { text: '', groundingChunks: [] };
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const groundingMeta = data.candidates?.[0]?.groundingMetadata;
    const groundingChunks = groundingMeta?.groundingChunks || [];

    return { text, groundingChunks };
  } catch (error) {
    console.error('Gemini 2.5 Flash grounding error:', error.message);
    return { text: '', groundingChunks: [] };
  }
}

// Gemini 2.5 Flash — multi-criteria classifier
async function callGeminiFlash(prompt) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        timeout: 60000,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini 2.5 Flash HTTP error ${response.status}:`, errorText.substring(0, 200));
      return '';
    }

    const data = await response.json();

    const usage = data.usageMetadata;
    if (usage) {
      recordTokens(
        'gemini-2.5-flash',
        usage.promptTokenCount || 0,
        usage.candidatesTokenCount || 0
      );
    }

    if (data.error) {
      console.error('Gemini 2.5 Flash API error:', data.error.message);
      return '';
    }

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!result) {
      console.warn('Gemini 2.5 Flash returned empty response');
    }
    return result;
  } catch (error) {
    console.error('Gemini 2.5 Flash error:', error.message);
    return '';
  }
}

// ============ WEBSITE VERIFICATION ============

function isCloudflareOrWAFChallenge(html) {
  const lowerHtml = html.toLowerCase();
  const wafSigns = [
    'checking your browser',
    'please wait while we verify',
    'cloudflare',
    'cf-browser-verification',
    'ddos protection',
    'just a moment',
    'enable javascript and cookies',
    'ray id',
    'performance & security by',
    'attention required',
    'access denied',
    'please complete the security check',
    'bot protection',
    'human verification',
  ];
  return wafSigns.some((sign) => lowerHtml.includes(sign));
}

async function verifyWebsite(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    const html = await response.text();

    if (isCloudflareOrWAFChallenge(html)) {
      console.log(`    [verifyWebsite] ${url} - Cloudflare/WAF detected, website exists`);
      return { valid: true, reason: 'WAF protected but exists', wafProtected: true };
    }

    if (!response.ok && response.status !== 403) {
      return { valid: false, reason: `HTTP ${response.status}` };
    }

    const lowerHtml = html.toLowerCase();
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
  async function tryFetch(targetUrl, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          Connection: 'keep-alive',
          'Cache-Control': 'no-cache',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timeout);
      return response;
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  function extractText(html) {
    const metaDesc =
      html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] || '';
    const metaKeywords =
      html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']+)["']/i)?.[1] || '';
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
    const ogDesc =
      html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
      '';

    const bodyText = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#[0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const combined = `${title}. ${metaDesc} ${ogDesc} ${metaKeywords}. ${bodyText}`.trim();
    return combined.substring(0, 20000);
  }

  function getUrlVariations(originalUrl) {
    const variations = [originalUrl];
    try {
      const parsed = new URL(originalUrl);
      if (parsed.pathname.includes('/en')) {
        const withoutEn = new URL(originalUrl);
        withoutEn.pathname = parsed.pathname.replace(/\/en\/?/, '/');
        variations.push(withoutEn.toString());
      }
      if (parsed.pathname !== '/' && parsed.pathname !== '') {
        const baseUrl = `${parsed.protocol}//${parsed.host}/`;
        if (!variations.includes(baseUrl)) variations.push(baseUrl);
      }
      if (parsed.host.startsWith('www.')) {
        const withoutWww = new URL(originalUrl);
        withoutWww.host = parsed.host.replace('www.', '');
        variations.push(withoutWww.toString());
      } else {
        const withWww = new URL(originalUrl);
        withWww.host = 'www.' + parsed.host;
        variations.push(withWww.toString());
      }
    } catch (e) {
      // URL parsing failed, just use original
    }
    return [...new Set(variations)];
  }

  const urlVariations = getUrlVariations(url);
  let sawWAF = false;

  let homepageText = null;
  try {
    homepageText = await Promise.any(
      urlVariations.map(async (targetUrl) => {
        try {
          console.log(`  [fetchWebsite] Trying ${targetUrl}`);
          const response = await tryFetch(targetUrl);
          const html = await response.text();

          if (isCloudflareOrWAFChallenge(html)) {
            console.log(`  [fetchWebsite] ${targetUrl} - Cloudflare/WAF detected`);
            sawWAF = true;
            throw new Error('WAF_PROTECTED');
          }

          if (response.ok || (response.status >= 200 && response.status < 400)) {
            console.log(`  [fetchWebsite] ${targetUrl} - got ${html.length} chars HTML`);
            const cleanText = extractText(html);
            console.log(`  [fetchWebsite] ${targetUrl} - cleaned to ${cleanText.length} chars`);
            if (cleanText.length > 50) return cleanText;
            throw new Error('Content too short after cleaning');
          }
          throw new Error(`HTTP ${response.status}`);
        } catch (e) {
          console.log(`  [fetchWebsite] ${targetUrl} - ${e.message}`);
          throw e;
        }
      })
    );
  } catch (e) {
    if (sawWAF) {
      console.log(`  [fetchWebsite] All variations WAF-blocked for ${url}`);
      return '__WAF_PROTECTED__';
    }
    console.log(`  [fetchWebsite] All variations failed for ${url}`);
    return null;
  }

  if (!homepageText) return null;

  // Fetch additional pages (/about, /about-us, /services) for richer content
  const MAX_TOTAL_CHARS = 15000;
  let combined = homepageText.substring(0, MAX_TOTAL_CHARS);

  try {
    const baseUrl = new URL(url);
    const subpages = ['/about', '/about-us', '/services'];
    const subpageResults = await Promise.allSettled(
      subpages.map(async (path) => {
        const subUrl = `${baseUrl.protocol}//${baseUrl.host}${path}`;
        try {
          const resp = await tryFetch(subUrl, 10000);
          if (!resp.ok) return null;
          const html = await resp.text();
          if (isCloudflareOrWAFChallenge(html)) return null;
          const text = extractText(html);
          return text.length > 100 ? text : null;
        } catch {
          return null;
        }
      })
    );

    for (const result of subpageResults) {
      if (result.status === 'fulfilled' && result.value && combined.length < MAX_TOTAL_CHARS) {
        const remaining = MAX_TOTAL_CHARS - combined.length;
        combined += '\n\n' + result.value.substring(0, remaining);
      }
    }
    console.log(`  [fetchWebsite] Total content after subpages: ${combined.length} chars`);
  } catch (e) {
    console.log(`  [fetchWebsite] Subpage fetch failed: ${e.message}`);
  }

  return combined;
}

// ============ URL HELPERS ============

function parseCompanyList(text) {
  if (!text) return [];
  return text
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length < 200);
}

function parseCountries(text) {
  if (!text) return [];
  return text
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isValidCompanyWebsite(url) {
  if (!url) return false;
  const urlLower = url.toLowerCase();

  if (urlLower.endsWith('.pdf') || urlLower.includes('.pdf?') || urlLower.includes('.pdf#'))
    return false;
  if (
    urlLower.endsWith('.doc') ||
    urlLower.endsWith('.docx') ||
    urlLower.endsWith('.xls') ||
    urlLower.endsWith('.xlsx')
  )
    return false;

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
    'opencorporates.com',
    'scribd.com',
    'listedcompany.com',
    'sec.gov',
    'annualreports.com',
    '/investor',
    '/annual-report',
    '/newsroom/',
    '/misc/',
    'pwc.com',
    'deloitte.com',
    'ey.com',
    'kpmg.com',
    'marketwatch.com',
    'yahoo.com/finance',
    'finance.yahoo',
  ];

  for (const pattern of invalidPatterns) {
    if (urlLower.includes(pattern)) return false;
  }

  if (!url.startsWith('http')) return false;
  return true;
}

function extractCleanURL(text) {
  if (!text) return null;
  const urlMatches = text.match(/https?:\/\/[^\s"'<>\])+,]+/gi);
  if (!urlMatches) return null;

  for (const url of urlMatches) {
    const cleanUrl = url.replace(/[.,;:!?)]+$/, '');
    if (isValidCompanyWebsite(cleanUrl)) return cleanUrl;
  }
  return null;
}

// ============ STEP 1: URL DISCOVERY (2-source parallel) ============

// Source 1: SerpAPI (Google Search) — most reliable, deterministic
async function findWebsiteViaSerpAPI(companyName, countries) {
  if (!process.env.SERPAPI_API_KEY) return null;

  const countryStr = countries && countries.length > 0 ? countries.slice(0, 2).join(' ') : '';
  const query = countryStr
    ? `"${companyName}" ${countryStr} official website homepage`
    : `"${companyName}" official website homepage -pdf -investor -annual`;

  try {
    const params = new URLSearchParams({
      q: query,
      api_key: process.env.SERPAPI_API_KEY,
      engine: 'google',
      num: 15,
    });

    const response = await fetch(`https://serpapi.com/search?${params}`, { timeout: 15000 });
    const data = await response.json();

    if (data.organic_results) {
      for (const result of data.organic_results) {
        if (result.link && isValidCompanyWebsite(result.link)) {
          const titleLower = (result.title || '').toLowerCase();
          const snippetLower = (result.snippet || '').toLowerCase();
          const companyLower = companyName.toLowerCase();
          const companyWords = companyLower.split(/\s+/).filter((w) => w.length > 2);

          const matchCount = companyWords.filter(
            (w) => titleLower.includes(w) || snippetLower.includes(w)
          ).length;

          if (matchCount >= Math.min(2, companyWords.length)) return result.link;
        }
      }

      for (const result of data.organic_results) {
        if (result.link && isValidCompanyWebsite(result.link)) return result.link;
      }
    }

    return null;
  } catch (e) {
    console.error(`SerpAPI error for ${companyName}:`, e.message);
    return null;
  }
}

// Source 2: Gemini 2.5 Flash with Google Search grounding
async function findWebsiteViaGemini(companyName, countries) {
  const countryStr = countries && countries.length > 0 ? countries.join(', ') : '';
  const locationHint = countryStr ? ` located in ${countryStr}` : '';

  try {
    const { text, groundingChunks } = await callGeminiWithGrounding(
      `What is the official corporate website URL for "${companyName}"${locationHint}?
       I need the MAIN company homepage URL (like https://www.company.com or https://company.co.th).
       Do NOT return:
       - PDF documents or annual reports
       - Investor relations pages
       - Google Maps, LinkedIn, Facebook, or social media
       - News articles or directory listings
       - Document hosting sites like Scribd
       Return ONLY the direct homepage URL. If you cannot find it, respond with "NOT_FOUND".`
    );

    // Try grounding chunks first for URLs
    for (const chunk of groundingChunks) {
      const chunkUrl = chunk?.web?.uri;
      if (chunkUrl && isValidCompanyWebsite(chunkUrl)) {
        return chunkUrl;
      }
    }

    // Fallback: extract URL from text response
    return extractCleanURL(text);
  } catch (e) {
    console.error(`Gemini grounding error for ${companyName}:`, e.message);
    return null;
  }
}

// ============ STEP 2: 2-SOURCE URL CONSENSUS ============

async function findCompanyWebsite(companyName, countries) {
  console.log(`  Finding website for: ${companyName}`);

  // Check cache first
  const cached = getCachedUrl(companyName);
  if (cached) {
    console.log(`    Cache hit: ${cached}`);
    return cached;
  }

  const [serpResult, geminiResult] = await Promise.all([
    findWebsiteViaSerpAPI(companyName, countries),
    findWebsiteViaGemini(companyName, countries),
  ]);

  console.log(`    SerpAPI: ${serpResult || 'not found'}`);
  console.log(`    Gemini:  ${geminiResult || 'not found'}`);

  if (serpResult && geminiResult) {
    try {
      const serpDomain = new URL(serpResult).hostname.replace(/^www\./, '');
      const geminiDomain = new URL(geminiResult).hostname.replace(/^www\./, '');

      if (serpDomain === geminiDomain) {
        console.log(`    Consensus: both agree on ${serpDomain} — high confidence`);
        setCachedUrl(companyName, serpResult);
        return serpResult;
      } else {
        console.log(
          `    Disagreement: SerpAPI=${serpDomain}, Gemini=${geminiDomain} — using SerpAPI (more reliable)`
        );
        setCachedUrl(companyName, serpResult);
        return serpResult;
      }
    } catch (e) {
      const result = serpResult || geminiResult;
      if (result) setCachedUrl(companyName, result);
      return result;
    }
  }

  const singleResult = serpResult || geminiResult;
  if (singleResult) {
    const source = serpResult ? 'SerpAPI' : 'Gemini';
    console.log(`    Only ${source} found ${singleResult} — verifying...`);

    const verification = await verifyWebsite(singleResult);
    if (verification.valid) {
      console.log(`    Verified: ${singleResult} exists`);
      setCachedUrl(companyName, singleResult);
      return singleResult;
    } else {
      console.log(`    Rejected: ${singleResult} — ${verification.reason}`);
      return null;
    }
  }

  console.log(`    No website found for ${companyName}`);
  return null;
}

// ============ STEP 4: MULTI-CRITERIA CLASSIFICATION ============

async function classifyMultiCriteria(company, criteria, pageText) {
  const isAIResearch = pageText.startsWith('[AI Research');

  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');

  const prompt = `You are a company validator. For each criterion below, determine PASS or FAIL based ONLY on the provided content.

CRITERIA:
${criteriaList}

COMPANY: ${company.company_name}
WEBSITE: ${company.website}

${isAIResearch ? 'COMPANY INFORMATION (from AI research - website was protected):' : 'WEBSITE CONTENT (successfully fetched from the live website):'}
${pageText.substring(0, 10000)}

RULES:
1. Evaluate EACH criterion independently
2. Base determination ONLY on the content provided
3. If content is unclear or insufficient for a criterion → FAIL
4. Be accurate - do not guess or assume

IMPORTANT: The content below was successfully obtained. Never say the website is "inaccessible" or "cannot be accessed". If content is unclear, say "unclear" or "insufficient information" but NOT "inaccessible".

OUTPUT: Return valid JSON only:
{
  "criteria_results": [
    {"criterion": 1, "result": "PASS", "reason": "brief explanation"},
    {"criterion": 2, "result": "FAIL", "reason": "brief explanation"}
  ],
  "business_description": "what this company does"
}`;

  const retryResult = await withRetry(
    async () => {
      const result = await callGeminiFlash(prompt);
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.criteria_results || !Array.isArray(parsed.criteria_results)) {
        throw new Error('Missing criteria_results array');
      }
      return {
        criteria_results: parsed.criteria_results.map((r) => ({
          criterion: r.criterion,
          result: (r.result || 'FAIL').toUpperCase() === 'PASS' ? 'PASS' : 'FAIL',
          reason: r.reason || '',
        })),
        business_description: parsed.business_description || '',
      };
    },
    2,
    1000,
    `classify ${company.company_name}`
  );

  if (retryResult) return retryResult;

  // Fallback: all FAIL
  return {
    criteria_results: criteria.map((_, i) => ({
      criterion: i + 1,
      result: 'FAIL',
      reason: 'Classification failed',
    })),
    business_description: 'Error during classification',
  };
}

// ============ BATCH MULTI-CRITERIA CLASSIFICATION ============

async function classifyMultiCriteriaBatch(companies, criteria) {
  const CLASSIFY_BATCH_SIZE = 3;
  const allResults = new Map();

  for (let i = 0; i < companies.length; i += CLASSIFY_BATCH_SIZE) {
    const chunk = companies.slice(i, i + CLASSIFY_BATCH_SIZE);

    const criteriaList = criteria.map((c, idx) => `${idx + 1}. ${c}`).join('\n');

    const companySections = chunk
      .map((c, idx) => {
        const isAIResearch = c.pageText.startsWith('[AI Research');
        const trimmedContent = c.pageText.substring(0, 3000);
        return `=== COMPANY ${idx + 1}: ${c.company_name} (${c.website}) ===
${isAIResearch ? 'COMPANY INFORMATION (from AI research):' : 'WEBSITE CONTENT:'}
${trimmedContent}`;
      })
      .join('\n\n');

    const prompt = `You are a company validator. For each company below, evaluate ALL criteria and determine PASS or FAIL based ONLY on the provided content.

CRITERIA:
${criteriaList}

${companySections}

RULES:
1. Evaluate EACH criterion independently for EACH company
2. Base determination ONLY on the content provided
3. If content is unclear or insufficient for a criterion → FAIL
4. Be accurate - do not guess or assume

OUTPUT: Return valid JSON only, an array with one entry per company:
[
  {
    "company_index": 1,
    "criteria_results": [
      {"criterion": 1, "result": "PASS", "reason": "brief explanation"},
      {"criterion": 2, "result": "FAIL", "reason": "brief explanation"}
    ],
    "business_description": "what this company does"
  }
]`;

    const batchResult = await withRetry(
      async () => {
        const result = await callGeminiFlash(prompt);
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array in batch response');
        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed)) throw new Error('Response is not an array');
        return parsed;
      },
      2,
      1000,
      `batch classify ${chunk.length} companies`
    );

    for (let j = 0; j < chunk.length; j++) {
      const companyEntry = batchResult?.find((r) => r.company_index === j + 1);
      if (companyEntry && companyEntry.criteria_results) {
        allResults.set(chunk[j].company_name, {
          criteria_results: companyEntry.criteria_results.map((r) => ({
            criterion: r.criterion,
            result: (r.result || 'FAIL').toUpperCase() === 'PASS' ? 'PASS' : 'FAIL',
            reason: r.reason || '',
          })),
          business_description: companyEntry.business_description || '',
        });
      } else {
        // Fallback: classify individually
        console.log(`  Batch miss for ${chunk[j].company_name}, classifying individually...`);
        const individual = await classifyMultiCriteria(
          { company_name: chunk[j].company_name, website: chunk[j].website },
          criteria,
          chunk[j].pageText
        );
        allResults.set(chunk[j].company_name, individual);
      }
    }
  }

  return allResults;
}

// ============ WAF FALLBACK: GEMINI RESEARCH ============

async function callGeminiResearch(companyName, website) {
  const { text } = await callGeminiWithGrounding(
    `Research "${companyName}" (website: ${website}).
     What does this company do? What industry are they in? What products or services do they offer?
     What is their location, size, and any notable details about their operations?
     Provide a detailed description of their business activities.
     If you cannot find information, say "UNABLE_TO_RESEARCH".`
  );
  return text;
}

// ============ EXCEL BUILDER ============

function buildMultiCriteriaExcel(companies, criteria) {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Results — one column per criterion
  const headers = ['#', 'Company', 'Website'];
  criteria.forEach((c, i) => {
    const truncated = c.length > 30 ? c.substring(0, 30) + '...' : c;
    headers.push(`Criterion ${i + 1}: ${truncated}`);
  });
  headers.push('Business Description');

  const rows = companies.map((c, idx) => {
    const row = [idx + 1, c.company_name, c.website || 'Not found'];
    criteria.forEach((_, i) => {
      const cr = c.criteria_results?.find((r) => r.criterion === i + 1);
      row.push(cr ? cr.result : 'N/A');
    });
    row.push(c.business_description || '-');
    return row;
  });

  const sheetData = [headers, ...rows];
  const resultsSheet = XLSX.utils.aoa_to_sheet(sheetData);

  // Column widths
  const colWidths = [
    { wch: 5 }, // #
    { wch: 40 }, // Company
    { wch: 50 }, // Website
  ];
  criteria.forEach(() => colWidths.push({ wch: 20 }));
  colWidths.push({ wch: 60 }); // Business Description
  resultsSheet['!cols'] = colWidths;

  XLSX.utils.book_append_sheet(wb, resultsSheet, 'Results');

  // Sheet 2: Criteria Reference
  const refData = [['#', 'Full Criterion']];
  criteria.forEach((c, i) => refData.push([i + 1, c]));
  const refSheet = XLSX.utils.aoa_to_sheet(refData);
  refSheet['!cols'] = [{ wch: 5 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, refSheet, 'Criteria Reference');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return buffer.toString('base64');
}

// ============ WATERFALL PPT ============

function computeWaterfallData(results, criteria) {
  const total = results.length;
  const counts = [total];
  const labels = ['Total Companies'];

  for (let i = 0; i < criteria.length; i++) {
    const count = results.filter((r) => {
      if (!r.criteria_results) return false;
      for (let j = 0; j <= i; j++) {
        const cr = r.criteria_results.find((c) => c.criterion === j + 1);
        if (!cr || cr.result !== 'PASS') return false;
      }
      return true;
    }).length;
    counts.push(count);
    labels.push(criteria[i]);
  }

  return { counts, labels };
}

async function generateWaterfallContent(criteria, counts, countries) {
  const countryStr = countries && countries.length > 0 ? countries.join(', ') : 'various countries';
  const criteriaDesc = criteria
    .map((c, i) => `${i + 1}. ${c} (${counts[i + 1]} passed)`)
    .join('\n');

  const prompt = `Generate JSON for a waterfall chart slide about screening companies.

Context:
- ${counts[0]} companies were screened in ${countryStr}
- Criteria applied sequentially:
${criteriaDesc}
- ${counts[counts.length - 1]} companies passed all criteria

Return ONLY valid JSON:
{
  "title": "short title under 15 words describing this screening",
  "subtitle": "summary sentence under 30 words",
  "chartHeader": "short chart label under 10 words",
  "callouts": ["for each criterion, explain why companies were removed (inverse of criterion)"]
}

The callouts array must have exactly ${criteria.length} entries, one per criterion.`;

  const result = await withRetry(
    async () => {
      const text = await callGeminiFlash(prompt);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in waterfall content response');
      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.title || !parsed.callouts || !Array.isArray(parsed.callouts)) {
        throw new Error('Missing required fields');
      }
      return parsed;
    },
    2,
    1000,
    'generate waterfall content'
  );

  if (result) return result;

  // Hardcoded fallback
  return {
    title: 'Target Candidate Screening',
    subtitle: `${counts[0]} companies screened against ${criteria.length} criteria`,
    chartHeader: 'Screening Results',
    callouts: criteria.map((c) => `Did not meet: ${c}`),
  };
}

async function buildWaterfallPPT(waterfallData, slideContent) {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE'; // 13.333" x 7.5"

  const slide = pptx.addSlide();

  const { counts, labels } = waterfallData;
  const { title, subtitle, chartHeader, callouts } = slideContent;

  // Title
  slide.addText(title, {
    x: 0.5,
    y: 0.2,
    w: 12,
    h: 0.5,
    fontSize: 20,
    fontFace: 'Segoe UI',
    bold: true,
    color: '333333',
  });

  // Subtitle
  slide.addText(subtitle, {
    x: 0.5,
    y: 0.7,
    w: 12,
    h: 0.4,
    fontSize: 14,
    fontFace: 'Segoe UI',
    color: '666666',
  });

  // Chart header (centered, underlined)
  slide.addText(chartHeader, {
    x: 1.0,
    y: 1.2,
    w: 8.5,
    h: 0.4,
    fontSize: 14,
    fontFace: 'Segoe UI',
    bold: true,
    color: '333333',
    align: 'center',
    underline: true,
  });

  // Bar rendering
  const barAreaX = 1.0,
    barAreaY = 1.8,
    barAreaW = 8.5,
    barAreaH = 4.0;
  const maxVal = counts[0] || 1;
  const numBars = counts.length;
  const totalBarSlot = barAreaW / numBars;
  const barWidth = totalBarSlot * 0.65;
  const barGap = totalBarSlot * 0.35;

  counts.forEach((count, i) => {
    const barHeight = Math.max((count / maxVal) * barAreaH, 0.05);
    const barX = barAreaX + i * totalBarSlot + barGap / 2;
    const barY = barAreaY + barAreaH - barHeight;
    const color = i === numBars - 1 ? 'E46C0A' : '99CCFF';

    // Bar rectangle
    slide.addShape(pptx.ShapeType.rect, {
      x: barX,
      y: barY,
      w: barWidth,
      h: barHeight,
      fill: { color },
      line: { color: 'FFFFFF', width: 1 },
    });

    // Data label (above bar)
    slide.addText(String(count), {
      x: barX,
      y: barY - 0.35,
      w: barWidth,
      h: 0.3,
      fontSize: 14,
      fontFace: 'Segoe UI',
      bold: true,
      color: '333333',
      align: 'center',
    });

    // Category label (below axis)
    const label = labels[i].length > 30 ? labels[i].substring(0, 27) + '...' : labels[i];
    slide.addText(label, {
      x: barX - 0.1,
      y: barAreaY + barAreaH + 0.15,
      w: barWidth + 0.2,
      h: 0.8,
      fontSize: 10,
      fontFace: 'Segoe UI',
      color: '333333',
      align: 'center',
      valign: 'top',
      wrap: true,
    });
  });

  // Horizontal axis line
  slide.addShape(pptx.ShapeType.line, {
    x: barAreaX,
    y: barAreaY + barAreaH,
    w: barAreaW,
    h: 0,
    line: { color: '333333', width: 1.5 },
  });

  // Callout rendering (right side)
  const calloutX = 10.0,
    calloutW = 2.8;
  const calloutAreaY = 1.8,
    calloutAreaH = 4.0;
  const spacing = Math.min(1.2, calloutAreaH / callouts.length);

  callouts.forEach((text, i) => {
    const cy = calloutAreaY + i * spacing;
    slide.addText(text, {
      shape: pptx.ShapeType.wedgeRectCallout,
      x: calloutX,
      y: cy,
      w: calloutW,
      h: spacing - 0.1,
      fill: { color: 'FFFFFF' },
      line: { color: 'BFBFBF', width: 0.75 },
      fontSize: 10,
      fontFace: 'Segoe UI',
      color: '333333',
      align: 'center',
      valign: 'middle',
      wrap: true,
    });
  });

  const base64 = await pptx.write({ outputType: 'base64' });
  return base64;
}

// ============ ORCHESTRATOR ============

async function orchestrate(companyList, countryList, criteria, websiteMap = {}) {
  const batchSize = 15;
  const results = [];

  for (let i = 0; i < companyList.length; i += batchSize) {
    const batch = companyList.slice(i, i + batchSize);
    console.log(
      `\nBatch ${Math.floor(i / batchSize) + 1}/${Math.ceil(companyList.length / batchSize)} (${batch.length} companies)`
    );

    // STEP 1-3: Find websites and fetch content in parallel
    const fetchedCompanies = await Promise.all(
      batch.map(async (companyName) => {
        const providedUrl = websiteMap[companyName];
        const website = providedUrl || (await findCompanyWebsite(companyName, countryList));
        if (providedUrl) console.log(`  Using provided website for ${companyName}: ${providedUrl}`);

        if (!website) {
          return {
            company_name: companyName,
            website: null,
            pageText: null,
            earlyResult: {
              company_name: companyName,
              website: null,
              criteria_results: criteria.map((_, idx) => ({
                criterion: idx + 1,
                result: 'FAIL',
                reason: 'Official website not found',
              })),
              business_description: 'Could not locate official company website',
            },
          };
        }

        let pageText = await fetchWebsite(website);
        console.log(
          `  Fetched pageText for ${companyName}: type=${typeof pageText}, length=${pageText?.length || 0}`
        );

        // WAF fallback
        if (pageText === '__WAF_PROTECTED__' || !pageText || pageText.length < 100) {
          console.log(`  ${companyName}: Website blocked/inaccessible, using Gemini research...`);
          try {
            const aiResearch = await callGeminiResearch(companyName, website);
            if (
              aiResearch &&
              !aiResearch.includes('UNABLE_TO_RESEARCH') &&
              aiResearch.length > 50
            ) {
              console.log(`  ${companyName}: Got AI research (${aiResearch.length} chars)`);
              pageText = `[AI Research for ${companyName}]\n${aiResearch}`;
            } else {
              return {
                company_name: companyName,
                website,
                pageText: null,
                earlyResult: {
                  company_name: companyName,
                  website,
                  criteria_results: criteria.map((_, idx) => ({
                    criterion: idx + 1,
                    result: 'FAIL',
                    reason: 'Website protected by WAF/Cloudflare, could not research',
                  })),
                  business_description: 'Website blocked by security measures, unable to validate',
                },
              };
            }
          } catch (e) {
            console.error(`  ${companyName}: AI research failed:`, e.message);
            return {
              company_name: companyName,
              website,
              pageText: null,
              earlyResult: {
                company_name: companyName,
                website,
                criteria_results: criteria.map((_, idx) => ({
                  criterion: idx + 1,
                  result: 'FAIL',
                  reason: 'Website protected, research failed',
                })),
                business_description: 'Website blocked by security measures, unable to validate',
              },
            };
          }
        }

        return { company_name: companyName, website, pageText, earlyResult: null };
      })
    );

    // Separate early results (failures) from companies needing classification
    const earlyResults = fetchedCompanies.filter((c) => c.earlyResult).map((c) => c.earlyResult);
    const toClassify = fetchedCompanies.filter((c) => !c.earlyResult && c.pageText);

    // STEP 5: Batch classification
    let classifiedMap = new Map();
    if (toClassify.length > 0) {
      console.log(`  Batch classifying ${toClassify.length} companies...`);
      classifiedMap = await classifyMultiCriteriaBatch(toClassify, criteria);
    }

    const batchResults = [
      ...earlyResults,
      ...toClassify.map((c) => {
        const classification = classifiedMap.get(c.company_name) || {
          criteria_results: criteria.map((_, idx) => ({
            criterion: idx + 1,
            result: 'FAIL',
            reason: 'Classification failed',
          })),
          business_description: 'Error during classification',
        };
        console.log(
          `  ${c.company_name}: Classified ${classification.criteria_results.length} criteria`
        );
        return {
          company_name: c.company_name,
          website: c.website,
          criteria_results: classification.criteria_results,
          business_description: classification.business_description,
        };
      }),
    ];

    results.push(...batchResults);
    console.log(`Completed: ${results.length}/${companyList.length}`);

    // 1s delay between batches
    if (i + batchSize < companyList.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return results;
}

// ============ VALIDATION ENDPOINT ============

app.post('/api/validation', async (req, res) => {
  const { Companies, Countries, Criteria, Email, Websites, IncludeWaterfall } = req.body;

  if (!Companies || !Criteria || !Array.isArray(Criteria) || Criteria.length === 0 || !Email) {
    return res.status(400).json({ error: 'Companies, Criteria (array), and Email are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW VALIDATION V2 REQUEST: ${new Date().toISOString()}`);
  console.log(`Criteria: ${Criteria.length} items`);
  Criteria.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  console.log(`Countries: ${Countries}`);
  const websiteMap = Websites && typeof Websites === 'object' ? Websites : {};
  console.log(`Provided websites: ${Object.keys(websiteMap).length}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(50));

  res.json({
    success: true,
    message: 'Validation request received. Results will be emailed within 3 minutes.',
  });

  const tracker = createTracker('validation-v2', Email, {
    Criteria,
    Countries,
  });

  trackingContext.run(tracker, async () => {
    try {
      const totalStart = Date.now();

      const companyList = parseCompanyList(Companies);
      const countryList = parseCountries(Countries);

      console.log(`Parsed ${companyList.length} companies and ${countryList.length} countries`);

      if (companyList.length === 0) {
        await sendEmail(
          Email,
          'Validation V2 - No Companies',
          '<p>No valid company names were found in your input.</p>'
        );
        return;
      }

      // Run the pipeline
      const results = await orchestrate(companyList, countryList, Criteria, websiteMap);

      // Build Excel
      const excelBase64 = buildMultiCriteriaExcel(results, Criteria);

      // Build Waterfall PPT (if requested)
      let pptBase64 = null;
      if (IncludeWaterfall) {
        try {
          const waterfallData = computeWaterfallData(results, Criteria);
          const slideContent = await generateWaterfallContent(
            Criteria,
            waterfallData.counts,
            countryList
          );
          pptBase64 = await buildWaterfallPPT(waterfallData, slideContent);
          console.log('Waterfall PPT generated');
        } catch (err) {
          console.error('Waterfall PPT failed:', err.message);
          // Non-fatal: still send Excel
        }
      }

      // Summary: count passes per criterion
      const criteriaSummary = Criteria.map((c, i) => {
        const passCount = results.filter((r) =>
          r.criteria_results?.find((cr) => cr.criterion === i + 1 && cr.result === 'PASS')
        ).length;
        return `Criterion ${i + 1}: ${passCount}/${results.length} passed`;
      }).join('<br>');

      const emailBody = `
        <h2>Validation V2 Complete</h2>
        <p><strong>Criteria:</strong></p>
        <ol>${Criteria.map((c) => `<li>${c}</li>`).join('')}</ol>
        <p><strong>Countries:</strong> ${countryList.join(', ') || 'None specified'}</p>
        <p><strong>Summary:</strong></p>
        <p>${criteriaSummary}</p>
        <br>
        <p>Please see the attached Excel file for detailed results.</p>
      `;

      const attachments = [
        {
          content: excelBase64,
          name: `validation-v2-${new Date().toISOString().split('T')[0]}.xlsx`,
        },
      ];
      if (pptBase64) {
        attachments.push({
          content: pptBase64,
          name: `waterfall-${new Date().toISOString().split('T')[0]}.pptx`,
        });
      }

      await sendEmail(
        Email,
        `Validation V2: ${results.length} companies evaluated against ${Criteria.length} criteria`,
        emailBody,
        attachments
      );

      const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
      console.log(`\n${'='.repeat(50)}`);
      console.log(`VALIDATION V2 COMPLETE! Email sent to ${Email}`);
      console.log(`Total companies: ${results.length}`);
      console.log(`Total time: ${totalTime} minutes`);
      console.log('='.repeat(50));

      await tracker.finish({
        companiesProcessed: results.length,
        criteriaCount: Criteria.length,
      });
    } catch (error) {
      console.error('Validation V2 error:', error);
      await tracker.finish({ status: 'error', error: error.message }).catch(() => {});
      try {
        await sendEmail(Email, 'Validation V2 - Error', `<p>Error: ${error.message}</p>`);
      } catch (e) {
        console.error('Failed to send error email:', e);
      }
    }
  });
});

// ============ HEALTH CHECK ============
app.get('/health', healthCheck('validation-v2'));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'validation-v2' });
});

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Validation V2 server running on port ${PORT}`);
});
