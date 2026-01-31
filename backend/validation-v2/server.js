require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { securityHeaders, rateLimiter } = require('./shared/security');
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
  'SERPAPI_API_KEY',
  'SENDGRID_API_KEY',
  'SENDER_EMAIL',
];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'missing',
});

// ============ AI TOOLS ============

// Gemini 3 Flash — frontier classifier ($0.50/$3.00 per 1M tokens)
async function callGeminiFlash(prompt) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        timeout: 30000,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini 3 Flash HTTP error ${response.status}:`, errorText.substring(0, 200));
      return '';
    }

    const data = await response.json();

    const usage = data.usageMetadata;
    if (usage) {
      recordTokens('gemini-3-flash', usage.promptTokenCount || 0, usage.candidatesTokenCount || 0);
    }

    if (data.error) {
      console.error('Gemini 3 Flash API error:', data.error.message);
      return '';
    }

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!result) {
      console.warn('Gemini 3 Flash returned empty response');
    }
    return result;
  } catch (error) {
    console.error('Gemini 3 Flash error:', error.message);
    return '';
  }
}

// Perplexity sonar — web search + AI synthesis ($5/1K requests)
async function callPerplexitySonar(prompt) {
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: prompt }],
      }),
      timeout: 30000,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Perplexity sonar HTTP error ${response.status}:`, errorText.substring(0, 200));
      return '';
    }

    const data = await response.json();

    if (data.usage) {
      recordTokens('sonar', data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0);
    }

    if (data.error) {
      console.error('Perplexity sonar API error:', data.error.message || data.error);
      return '';
    }

    const result = data.choices?.[0]?.message?.content || '';
    if (!result) {
      console.warn('Perplexity sonar returned empty response');
    }
    return result;
  } catch (error) {
    console.error('Perplexity sonar error:', error.message);
    return '';
  }
}

// Perplexity sonar-pro — WAF fallback research ($6/1K requests)
async function callPerplexitySonarPro(prompt) {
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{ role: 'user', content: prompt }],
      }),
      timeout: 45000,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `Perplexity sonar-pro HTTP error ${response.status}:`,
        errorText.substring(0, 200)
      );
      return '';
    }

    const data = await response.json();

    if (data.usage) {
      recordTokens('sonar-pro', data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0);
    }

    const result = data.choices?.[0]?.message?.content || '';
    return result;
  } catch (error) {
    console.error('Perplexity sonar-pro error:', error.message);
    return '';
  }
}

// GPT-4o — edge case escalation ($2.50/$10 per 1M tokens)
async function callGPT4o(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });
    if (response.usage) {
      recordTokens(
        'gpt-4o',
        response.usage.prompt_tokens || 0,
        response.usage.completion_tokens || 0
      );
    }
    return response.choices[0].message.content || '';
  } catch (error) {
    console.error('GPT-4o error:', error.message);
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

  try {
    const result = await Promise.any(
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
    return result;
  } catch (e) {
    // Promise.any rejects with AggregateError when all promises reject
    if (sawWAF) {
      console.log(`  [fetchWebsite] All variations WAF-blocked for ${url}`);
      return '__WAF_PROTECTED__';
    }
    console.log(`  [fetchWebsite] All variations failed for ${url}`);
    return null;
  }
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

// Source 2: Perplexity sonar — web search + AI synthesis
async function findWebsiteViaSonar(companyName, countries) {
  const countryStr = countries && countries.length > 0 ? countries.join(', ') : '';
  const locationHint = countryStr ? ` located in ${countryStr}` : '';

  try {
    const result = await callPerplexitySonar(
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

    return extractCleanURL(result);
  } catch (e) {
    console.error(`Perplexity sonar error for ${companyName}:`, e.message);
    return null;
  }
}

// ============ STEP 2: 2-SOURCE URL CONSENSUS ============

async function findCompanyWebsite(companyName, countries) {
  console.log(`  Finding website for: ${companyName}`);

  // Parallel: SerpAPI + Perplexity sonar
  const [serpResult, sonarResult] = await Promise.all([
    findWebsiteViaSerpAPI(companyName, countries),
    findWebsiteViaSonar(companyName, countries),
  ]);

  console.log(`    SerpAPI: ${serpResult || 'not found'}`);
  console.log(`    Sonar:   ${sonarResult || 'not found'}`);

  // Both found URLs — check domain consensus
  if (serpResult && sonarResult) {
    try {
      const serpDomain = new URL(serpResult).hostname.replace(/^www\./, '');
      const sonarDomain = new URL(sonarResult).hostname.replace(/^www\./, '');

      if (serpDomain === sonarDomain) {
        console.log(`    Consensus: both agree on ${serpDomain} — high confidence`);
        return serpResult; // prefer SerpAPI URL format
      } else {
        console.log(
          `    Disagreement: SerpAPI=${serpDomain}, Sonar=${sonarDomain} — using SerpAPI (more reliable)`
        );
        return serpResult; // SerpAPI is deterministic Google results
      }
    } catch (e) {
      return serpResult || sonarResult;
    }
  }

  // Only one found — verify it exists
  const singleResult = serpResult || sonarResult;
  if (singleResult) {
    const source = serpResult ? 'SerpAPI' : 'Sonar';
    console.log(`    Only ${source} found ${singleResult} — verifying...`);

    const verification = await verifyWebsite(singleResult);
    if (verification.valid) {
      console.log(`    Verified: ${singleResult} exists`);
      return singleResult;
    } else {
      console.log(`    Rejected: ${singleResult} — ${verification.reason}`);
      return null;
    }
  }

  console.log(`    No website found for ${companyName}`);
  return null;
}

// ============ STEP 4: GEMINI 3 FLASH CLASSIFICATION ============

async function classifyWithGemini(company, targetBusiness, pageText) {
  const isAIResearch = pageText.startsWith('[AI Research');

  const prompt = `You are a company validator. Determine if the company matches the target business criteria STRICTLY based on the content provided.

TARGET BUSINESS: "${targetBusiness}"

RULES:
1. Your determination must be based ONLY on the content provided (website content or AI research)
2. If the content clearly shows the company is in the target business → IN SCOPE
3. If the content shows a different business → OUT OF SCOPE
4. If the content is unclear or doesn't describe business activities → OUT OF SCOPE
5. Be accurate - do not guess or assume

IMPORTANT: The content below was successfully obtained. Never say the website is "inaccessible" or "cannot be accessed". If content is unclear, say "unclear" or "insufficient information" but NOT "inaccessible".

COMPANY: ${company.company_name}
WEBSITE: ${company.website}

${isAIResearch ? 'COMPANY INFORMATION (from AI research - website was protected):' : 'WEBSITE CONTENT (successfully fetched from the live website):'}
${pageText.substring(0, 10000)}

OUTPUT: Return valid JSON only: {"in_scope": true/false, "confidence": "high/medium/low", "reason": "brief explanation based on content", "business_description": "what this company actually does"}`;

  try {
    const result = await callGeminiFlash(prompt);
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        in_scope: parsed.in_scope === true,
        confidence: parsed.confidence || 'medium',
        reason: parsed.reason || 'Classified by Gemini 3 Flash',
        business_description: parsed.business_description || '',
      };
    }
  } catch (e) {
    console.error(`Gemini classification error for ${company.company_name}:`, e.message);
  }

  return {
    in_scope: false,
    confidence: 'low',
    reason: 'Classification failed',
    business_description: 'Error during classification',
  };
}

// ============ STEP 5: GPT-4o ESCALATION FOR EDGE CASES ============

async function escalateWithGPT4o(company, targetBusiness, pageText) {
  const isAIResearch = pageText.startsWith('[AI Research');

  const systemPrompt = `You are a company validator. Determine if the company matches the target business criteria STRICTLY based on the content provided.

TARGET BUSINESS: "${targetBusiness}"

RULES:
1. Your determination must be based ONLY on the content provided (website content or AI research)
2. If the content clearly shows the company is in the target business → IN SCOPE
3. If the content shows a different business → OUT OF SCOPE
4. If the content is unclear or doesn't describe business activities → OUT OF SCOPE
5. Be accurate - do not guess or assume

IMPORTANT: The content below was successfully obtained. Never say the website is "inaccessible" or "cannot be accessed". If content is unclear, say "unclear" or "insufficient information" but NOT "inaccessible".

OUTPUT: Return JSON: {"in_scope": true/false, "confidence": "high/medium/low", "reason": "brief explanation based on content", "business_description": "what this company actually does"}`;

  const userPrompt = `COMPANY: ${company.company_name}
WEBSITE: ${company.website}

${isAIResearch ? 'COMPANY INFORMATION (from AI research - website was protected):' : 'WEBSITE CONTENT (successfully fetched from the live website):'}
${pageText.substring(0, 10000)}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });

    if (response.usage) {
      recordTokens(
        'gpt-4o',
        response.usage.prompt_tokens || 0,
        response.usage.completion_tokens || 0
      );
    }

    const result = JSON.parse(response.choices[0].message.content);
    return {
      in_scope: result.in_scope === true,
      confidence: result.confidence || 'high',
      reason: result.reason || 'Validated by GPT-4o',
      business_description: result.business_description || '',
    };
  } catch (e) {
    console.error(`GPT-4o escalation error for ${company.company_name}:`, e.message);
    return null; // caller will use Gemini result as fallback
  }
}

// ============ EXCEL BUILDER ============

function buildValidationExcel(companies) {
  const inScopeCompanies = companies.filter((c) => c.in_scope);

  const wb = XLSX.utils.book_new();

  // Sheet 1: In-Scope Only
  const inScopeData = inScopeCompanies.map((c, i) => ({
    '#': i + 1,
    Company: c.company_name,
    Website: c.website || 'Not found',
    'Business Description': c.business_description || '-',
  }));
  const inScopeSheet = XLSX.utils.json_to_sheet(inScopeData);
  inScopeSheet['!cols'] = [{ wch: 5 }, { wch: 40 }, { wch: 50 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, inScopeSheet, 'In-Scope Only');

  // Sheet 2: All Companies
  const allData = companies.map((c, i) => ({
    '#': i + 1,
    Company: c.company_name,
    Website: c.website || 'Not found',
    Status: c.in_scope ? 'IN SCOPE' : 'OUT OF SCOPE',
    'Business Description': c.business_description || c.reason || '-',
  }));
  const allSheet = XLSX.utils.json_to_sheet(allData);
  allSheet['!cols'] = [{ wch: 5 }, { wch: 40 }, { wch: 50 }, { wch: 15 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, allSheet, 'All Companies');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return buffer.toString('base64');
}

// ============ ORCHESTRATOR ============

async function orchestrate(companyList, countryList, targetBusiness) {
  const batchSize = 25;
  const results = [];

  for (let i = 0; i < companyList.length; i += batchSize) {
    const batch = companyList.slice(i, i + batchSize);
    console.log(
      `\nBatch ${Math.floor(i / batchSize) + 1}/${Math.ceil(companyList.length / batchSize)} (${batch.length} companies)`
    );

    const batchResults = await Promise.all(
      batch.map(async (companyName) => {
        // STEP 1: Find website (2-source parallel)
        const website = await findCompanyWebsite(companyName, countryList);

        if (!website) {
          return {
            company_name: companyName,
            website: null,
            in_scope: false,
            reason: 'Official website not found',
            business_description: 'Could not locate official company website',
          };
        }

        // STEP 3: Fetch website HTML
        let pageText = await fetchWebsite(website);

        console.log(
          `  Fetched pageText for ${companyName}: type=${typeof pageText}, length=${pageText?.length || 0}`
        );

        // WAF fallback: use sonar-pro to research
        if (pageText === '__WAF_PROTECTED__' || !pageText || pageText.length < 100) {
          console.log(
            `  ${companyName}: Website blocked/inaccessible, using sonar-pro to research...`
          );
          try {
            const aiResearch = await callPerplexitySonarPro(
              `Research "${companyName}" (website: ${website}).
               What does this company do? What industry are they in? What products or services do they offer?
               Provide a detailed description of their business activities.
               If you cannot find information, say "UNABLE_TO_RESEARCH".`
            );

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
                in_scope: false,
                reason: 'Website protected by WAF/Cloudflare, could not research',
                business_description: 'Website blocked by security measures, unable to validate',
              };
            }
          } catch (e) {
            console.error(`  ${companyName}: AI research failed:`, e.message);
            return {
              company_name: companyName,
              website,
              in_scope: false,
              reason: 'Website protected, research failed',
              business_description: 'Website blocked by security measures, unable to validate',
            };
          }
        }

        // STEP 4: Gemini 3 Flash classification
        const geminiResult = await classifyWithGemini(
          { company_name: companyName, website },
          targetBusiness,
          pageText
        );

        console.log(
          `  ${companyName}: Gemini → in_scope=${geminiResult.in_scope}, confidence=${geminiResult.confidence}`
        );

        // STEP 5: GPT-4o escalation for low/medium confidence
        const needsEscalation =
          geminiResult.confidence === 'low' ||
          geminiResult.confidence === 'medium' ||
          geminiResult.reason?.toLowerCase().includes('unclear') ||
          geminiResult.reason?.toLowerCase().includes('insufficient') ||
          geminiResult.reason?.toLowerCase().includes('cannot determine') ||
          geminiResult.reason?.toLowerCase().includes('not clear');

        if (needsEscalation) {
          console.log(
            `  → Escalating ${companyName} to GPT-4o (confidence: ${geminiResult.confidence})`
          );

          const gptResult = await escalateWithGPT4o(
            { company_name: companyName, website },
            targetBusiness,
            pageText
          );

          if (gptResult) {
            return {
              company_name: companyName,
              website,
              in_scope: gptResult.in_scope,
              reason: gptResult.reason,
              business_description: gptResult.business_description,
            };
          }
          // If GPT-4o failed, fall through to Gemini result
        }

        return {
          company_name: companyName,
          website,
          in_scope: geminiResult.in_scope,
          reason: geminiResult.reason,
          business_description: geminiResult.business_description,
        };
      })
    );

    results.push(...batchResults);
    console.log(`Completed: ${results.length}/${companyList.length}`);
  }

  return results;
}

// ============ VALIDATION ENDPOINT ============

app.post('/api/validation', async (req, res) => {
  const { Companies, Countries, TargetBusiness, OutputOption, Email } = req.body;

  if (!Companies || !TargetBusiness || !Email) {
    return res.status(400).json({ error: 'Companies, TargetBusiness, and Email are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW VALIDATION V2 REQUEST: ${new Date().toISOString()}`);
  console.log(`Target Business: ${TargetBusiness}`);
  console.log(`Countries: ${Countries}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(50));

  res.json({
    success: true,
    message: 'Validation V2 request received. Results will be emailed within 3 minutes.',
  });

  const tracker = createTracker('validation-v2', Email, {
    TargetBusiness,
    Countries,
    OutputOption,
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
      const results = await orchestrate(companyList, countryList, TargetBusiness);

      const inScopeCount = results.filter((r) => r.in_scope).length;

      // Build Excel
      const excelBase64 = buildValidationExcel(results);

      // Send email
      const emailBody = `
        <h2>Validation V2 Complete</h2>
        <p><strong>Target Business:</strong> ${TargetBusiness}</p>
        <p><strong>Countries:</strong> ${countryList.join(', ')}</p>
        <p><strong>Results:</strong> ${inScopeCount} in-scope out of ${results.length} companies</p>
        <br>
        <p>Please see the attached Excel file for detailed results.</p>
      `;

      await sendEmail(
        Email,
        `Validation V2: ${inScopeCount}/${results.length} in-scope for "${TargetBusiness}"`,
        emailBody,
        {
          content: excelBase64,
          name: `validation-v2-results-${new Date().toISOString().split('T')[0]}.xlsx`,
        }
      );

      const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
      console.log(`\n${'='.repeat(50)}`);
      console.log(`VALIDATION V2 COMPLETE! Email sent to ${Email}`);
      console.log(`Total companies: ${results.length}, In-scope: ${inScopeCount}`);
      console.log(`Total time: ${totalTime} minutes`);
      console.log('='.repeat(50));

      await tracker.finish({
        companiesProcessed: results.length,
        inScope: inScopeCount,
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
