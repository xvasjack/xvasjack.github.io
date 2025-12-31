require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const pptxgen = require('pptxgenjs');
const XLSX = require('xlsx');
const multer = require('multer');
const { createClient } = require('@deepgram/sdk');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } = require('docx');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const Anthropic = require('@anthropic-ai/sdk');
const JSZip = require('jszip');
const { securityHeaders, rateLimiter, escapeHtml } = require('../shared/security');

// ============ GLOBAL ERROR HANDLERS - PREVENT CRASHES ============
// Memory logging helper for debugging Railway OOM issues
function logMemoryUsage(label = '') {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  console.log(`  [Memory${label ? ': ' + label : ''}] Heap: ${heapUsedMB}/${heapTotalMB}MB, RSS: ${rssMB}MB`);
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('=== UNHANDLED PROMISE REJECTION ===');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  console.error('Stack:', reason?.stack || 'No stack trace');
  logMemoryUsage('at rejection');
  // Don't exit - keep the server running
});

process.on('uncaughtException', (error) => {
  console.error('=== UNCAUGHT EXCEPTION ===');
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
  logMemoryUsage('at exception');
  // Don't exit - keep the server running
});

// ============ TYPE SAFETY HELPERS ============
// Ensure a value is a string (AI models may return objects/arrays instead of strings)
function ensureString(value, defaultValue = '') {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return defaultValue;
  // Handle arrays - join with comma
  if (Array.isArray(value)) return value.map(v => ensureString(v)).join(', ');
  // Handle objects - try to extract meaningful string
  if (typeof value === 'object') {
    // Common patterns from AI responses
    if (value.city && value.country) return `${value.city}, ${value.country}`;
    if (value.text) return ensureString(value.text);
    if (value.value) return ensureString(value.value);
    if (value.name) return ensureString(value.name);
    // Fallback: stringify
    try { return JSON.stringify(value); } catch { return defaultValue; }
  }
  // Convert other types to string
  return String(value);
}

const app = express();
app.use(securityHeaders);
app.use(rateLimiter);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Multer configuration for file uploads (memory storage)
// Add 50MB limit to prevent OOM on Railway containers
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }  // 50MB max
});

// Check required environment variables
const requiredEnvVars = ['OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'GEMINI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
const optionalEnvVars = ['SERPAPI_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY']; // Optional but recommended
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
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
  apiKey: process.env.OPENAI_API_KEY || 'missing'
});

// Initialize Anthropic (Claude)
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Initialize Deepgram
const deepgram = process.env.DEEPGRAM_API_KEY ? createClient(process.env.DEEPGRAM_API_KEY) : null;

// Initialize Cloudflare R2 (S3-compatible)
const r2Client = (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    })
  : null;

const R2_BUCKET = process.env.R2_BUCKET_NAME || 'dd-recordings';

if (!r2Client) {
  console.warn('R2 not configured - recordings will only be stored in memory. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME');
}

// Send email using SendGrid API
async function sendEmail(to, subject, html, attachments = null, maxRetries = 3) {
  const senderEmail = process.env.SENDER_EMAIL;
  const emailData = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: senderEmail, name: 'Find Target' },
    subject: subject,
    content: [{ type: 'text/html', value: html }]
  };

  if (attachments) {
    const attachmentList = Array.isArray(attachments) ? attachments : [attachments];
    emailData.attachments = attachmentList.map(a => ({
      filename: a.filename || a.name,  // Support both 'filename' and 'name' properties
      content: a.content,
      type: 'application/octet-stream',
      disposition: 'attachment'
    }));
  }

  // Retry logic with exponential backoff
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailData)
      });

      if (response.ok) {
        if (attempt > 1) {
          console.log(`  Email sent successfully on attempt ${attempt}`);
        }
        return { success: true };
      }

      const error = await response.text();
      lastError = new Error(`Email failed (attempt ${attempt}/${maxRetries}): ${error}`);
      console.error(lastError.message);

      // Don't retry on 4xx client errors (except 429 rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw lastError;
      }
    } catch (fetchError) {
      lastError = fetchError;
      console.error(`  Email attempt ${attempt}/${maxRetries} failed:`, fetchError.message);
    }

    // Exponential backoff: 2s, 4s, 8s
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`  Retrying email in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Email failed after all retries');
}

// ============ AI TOOLS ============

// Gemini 2.5 Flash-Lite - cost-effective for general tasks ($0.10/$0.40 per 1M tokens)
async function callGemini(prompt) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      timeout: 90000
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini 2.5 Flash-Lite HTTP error ${response.status}:`, errorText.substring(0, 200));
      return '';
    }

    const data = await response.json();

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

async function callPerplexity(prompt) {
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-pro',  // Upgraded from 'sonar' for better search results
        messages: [{ role: 'user', content: prompt }]
      }),
      timeout: 90000
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
      temperature: 0.2
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
      messages: [{ role: 'user', content: prompt }]
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

// Detect domain/context from text for domain-aware translation
function detectMeetingDomain(text) {
  const domains = {
    financial: /\b(revenue|EBITDA|valuation|M&A|merger|acquisition|IPO|equity|debt|ROI|P&L|balance sheet|cash flow|投資|収益|利益|財務)\b/i,
    legal: /\b(contract|agreement|liability|compliance|litigation|IP|intellectual property|NDA|terms|clause|legal|lawyer|attorney|契約|法的|弁護士)\b/i,
    medical: /\b(clinical|trial|FDA|patient|therapeutic|drug|pharmaceutical|biotech|efficacy|dosage|治療|患者|医療|臨床)\b/i,
    technical: /\b(API|architecture|infrastructure|database|server|cloud|deployment|code|software|engineering|システム|開発|技術)\b/i,
    hr: /\b(employee|hiring|compensation|benefits|performance|talent|HR|recruitment|人事|採用|給与)\b/i
  };

  for (const [domain, pattern] of Object.entries(domains)) {
    if (pattern.test(text)) {
      return domain;
    }
  }
  return 'general';
}

// Get domain-specific translation instructions
function getDomainInstructions(domain) {
  const instructions = {
    financial: 'This is a financial/investment due diligence meeting. Preserve financial terms like M&A, EBITDA, ROI, P&L accurately. Use standard financial terminology.',
    legal: 'This is a legal due diligence meeting. Preserve legal terms and contract language precisely. Maintain formal legal register.',
    medical: 'This is a medical/pharmaceutical due diligence meeting. Preserve medical terminology, drug names, and clinical terms accurately.',
    technical: 'This is a technical due diligence meeting. Preserve technical terms, acronyms, and engineering terminology accurately.',
    hr: 'This is an HR/talent due diligence meeting. Preserve HR terminology and employment-related terms accurately.',
    general: 'This is a business due diligence meeting. Preserve business terminology and professional tone.'
  };
  return instructions[domain] || instructions.general;
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

// ============ FETCH WEBSITE FOR VALIDATION ============
// Returns: string (cleaned website text) or null (on failure)

async function fetchWebsite(url) {
  // Helper to try a single fetch with given URL
  async function tryFetch(targetUrl, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache'
        },
        signal: controller.signal,
        redirect: 'follow'
      });
      clearTimeout(timeout);
      return response;
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  // Helper to extract text from HTML
  function extractText(html) {
    // First extract meta description and title which often contain business info
    const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] || '';
    const metaKeywords = html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']+)["']/i)?.[1] || '';
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
    const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1] || '';

    // Extract text from body
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

    // Combine meta info with body text for better context
    const combined = `${title}. ${metaDesc} ${ogDesc} ${metaKeywords}. ${bodyText}`.trim();
    return combined.substring(0, 20000);
  }

  // Generate URL variations to try
  function getUrlVariations(originalUrl) {
    const variations = [originalUrl];
    try {
      const parsed = new URL(originalUrl);

      // Try without /en/ path if present (some sites redirect)
      if (parsed.pathname.includes('/en')) {
        const withoutEn = new URL(originalUrl);
        withoutEn.pathname = parsed.pathname.replace(/\/en\/?/, '/');
        variations.push(withoutEn.toString());
      }

      // Try base domain without path
      if (parsed.pathname !== '/' && parsed.pathname !== '') {
        const baseUrl = `${parsed.protocol}//${parsed.host}/`;
        if (!variations.includes(baseUrl)) {
          variations.push(baseUrl);
        }
      }

      // Try with www if not present, or without www if present
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
    return [...new Set(variations)]; // Remove duplicates
  }

  const urlVariations = getUrlVariations(url);
  let lastError = null;

  // Try each URL variation with retry logic
  for (const targetUrl of urlVariations) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`  [fetchWebsite] Trying ${targetUrl} (attempt ${attempt})`);
        const response = await tryFetch(targetUrl);

        // Accept any 2xx or 3xx response (redirects are followed automatically)
        if (response.ok || (response.status >= 200 && response.status < 400)) {
          const html = await response.text();
          console.log(`  [fetchWebsite] ${targetUrl} - got ${html.length} chars HTML`);

          const cleanText = extractText(html);
          console.log(`  [fetchWebsite] ${targetUrl} - cleaned to ${cleanText.length} chars`);

          if (cleanText.length > 50) {
            return cleanText;
          } else {
            console.log(`  [fetchWebsite] ${targetUrl} - content too short after cleaning`);
          }
        } else {
          console.log(`  [fetchWebsite] ${targetUrl} - HTTP ${response.status}`);
        }
      } catch (e) {
        lastError = e;
        console.log(`  [fetchWebsite] ${targetUrl} - ERROR: ${e.message}`);
        // Wait before retry
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
  }

  console.log(`  [fetchWebsite] All variations failed for ${url}`);
  return null;
}

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

  // Block PDFs and document files
  if (urlLower.endsWith('.pdf') || urlLower.includes('.pdf?') || urlLower.includes('.pdf#')) return false;
  if (urlLower.endsWith('.doc') || urlLower.endsWith('.docx') || urlLower.endsWith('.xls') || urlLower.endsWith('.xlsx')) return false;

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
    // Document and investor relations sites
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
    'finance.yahoo'
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

  const countryStr = countries && countries.length > 0 ? countries.slice(0, 2).join(' ') : '';
  const query = countryStr
    ? `"${companyName}" ${countryStr} official website homepage`
    : `"${companyName}" official website homepage -pdf -investor -annual`;

  try {
    const params = new URLSearchParams({
      q: query,
      api_key: process.env.SERPAPI_API_KEY,
      engine: 'google',
      num: 15
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
  const countryStr = countries && countries.length > 0 ? countries.join(', ') : '';
  const locationHint = countryStr ? ` located in ${countryStr}` : '';

  try {
    const result = await callPerplexity(
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
    console.error(`Perplexity error for ${companyName}:`, e.message);
    return null;
  }
}

// Method 3: Use OpenAI Search
async function findWebsiteViaOpenAISearch(companyName, countries) {
  const countryStr = countries && countries.length > 0 ? countries.join(', ') : '';
  const locationHint = countryStr ? ` in ${countryStr}` : '';

  try {
    const result = await callOpenAISearch(
      `Find the official corporate homepage for "${companyName}"${locationHint}.
       Return ONLY the main website URL (e.g., https://www.companyname.com or https://company.co.th).
       Do NOT return:
       - PDF files or annual reports
       - Investor relations or /investor pages
       - Google Maps, LinkedIn, Facebook, social media
       - News articles, Scribd, or directory websites
       I need the actual company homepage, not documents about the company.
       If not found, say "NOT_FOUND".`
    );

    return extractCleanURL(result);
  } catch (e) {
    console.error(`OpenAI Search error for ${companyName}:`, e.message);
    return null;
  }
}

// Method 4: Use Gemini
async function findWebsiteViaGemini(companyName, countries) {
  const countryStr = countries && countries.length > 0 ? countries.join(', ') : '';
  const locationHint = countryStr ? ` based in ${countryStr}` : '';

  try {
    const result = await callGemini(
      `What is the official company website URL for "${companyName}"${locationHint}?
       Return ONLY the main homepage URL starting with https:// or http://
       Do NOT return:
       - PDF documents or annual reports
       - Investor relations pages
       - Google Maps, social media, or directory links
       - Document sites like Scribd
       I need the actual corporate homepage. If unknown, respond with NOT_FOUND.`
    );

    return extractCleanURL(result);
  } catch (e) {
    console.error(`Gemini error for ${companyName}:`, e.message);
    return null;
  }
}

// Combined website finder - tries multiple methods for accuracy
// GUARDRAIL: Requires either 2+ sources to agree OR single-source verification
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

  // Count how many sources agree on each domain
  const domainCounts = {};
  const domainToUrl = {};
  for (const url of candidates) {
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
      if (!domainToUrl[domain]) domainToUrl[domain] = url;
    } catch (e) {
      // Invalid URL, skip it
    }
  }

  // Find the domain with most votes
  let bestDomain = null;
  let bestCount = 0;
  for (const [domain, count] of Object.entries(domainCounts)) {
    if (count > bestCount) {
      bestCount = count;
      bestDomain = domain;
    }
  }

  // GUARDRAIL: If 2+ sources agree, accept the website (high confidence)
  if (bestCount >= 2 && bestDomain) {
    const url = domainToUrl[bestDomain];
    console.log(`    Selected: ${url} (${bestCount} sources agree - high confidence)`);
    return url;
  }

  // GUARDRAIL: If only 1 source found a website, verify it actually exists
  // This prevents hallucinated URLs from AI models
  if (bestCount === 1 && bestDomain) {
    const url = domainToUrl[bestDomain];
    console.log(`    Only 1 source found ${url} - verifying website exists...`);

    const verification = await verifyWebsite(url);
    if (verification.valid) {
      console.log(`    Verified: ${url} exists and has real content`);
      return url;
    } else {
      console.log(`    Rejected: ${url} - ${verification.reason} (possible hallucination)`);
      return null;
    }
  }

  console.log(`    No website found for ${companyName} (no consensus, no verified result)`);
  return null;
}

// Validate if company matches target business - STRICTLY based on website content
async function validateCompanyBusinessStrict(company, targetBusiness, pageText) {
  if (!pageText || typeof pageText !== 'string' || pageText.length < 100) {
    return {
      in_scope: false,
      reason: 'Could not fetch sufficient website content',
      business_description: 'Unable to determine - website inaccessible or insufficient content'
    };
  }

  const systemPrompt = (model) => `You are a company validator. Determine if the company matches the target business criteria STRICTLY based on the website content provided.

TARGET BUSINESS: "${targetBusiness}"

RULES:
1. Your determination must be based ONLY on what the website content says
2. If the website clearly shows the company is in the target business → IN SCOPE
3. If the website shows a different business → OUT OF SCOPE
4. If the website content is unclear or doesn't describe business activities → OUT OF SCOPE
5. Be accurate - do not guess or assume

OUTPUT: Return JSON: {"in_scope": true/false, "confidence": "high/medium/low", "reason": "brief explanation based on website content", "business_description": "what this company actually does based on website"}`;

  const userPrompt = `COMPANY: ${company.company_name}
WEBSITE: ${company.website}

WEBSITE CONTENT:
${(typeof pageText === 'string' && pageText) ? pageText.substring(0, 10000) : 'Could not fetch website - validate by company name only'}`;

  try {
    // First pass: gpt-4o-mini (fast and cheap)
    const firstPass = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt('gpt-4o-mini') },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(firstPass.choices[0].message.content);

    // Check if we need a second pass with gpt-4o
    const needsSecondPass =
      result.confidence === 'low' ||
      result.confidence === 'medium' ||
      result.reason?.toLowerCase().includes('unclear') ||
      result.reason?.toLowerCase().includes('insufficient') ||
      result.reason?.toLowerCase().includes('cannot determine') ||
      result.reason?.toLowerCase().includes('not clear');

    if (needsSecondPass) {
      console.log(`  → Re-validating ${company.company_name} with gpt-4o (confidence: ${result.confidence})`);

      // Second pass: gpt-4o (more accurate)
      const secondPass = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt('gpt-4o') },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' }
      });

      const finalResult = JSON.parse(secondPass.choices[0].message.content);
      return {
        in_scope: finalResult.in_scope,
        reason: finalResult.reason,
        business_description: finalResult.business_description
      };
    }

    return {
      in_scope: result.in_scope,
      reason: result.reason,
      business_description: result.business_description
    };
  } catch (e) {
    console.error(`Error validating ${company.company_name}:`, e.message);
    return { in_scope: false, reason: 'Validation error', business_description: 'Error during validation' };
  }
}

// Build validation results as Excel file (returns base64 string)
function buildValidationExcel(companies, targetBusiness, countries, outputOption) {
  const inScopeCompanies = companies.filter(c => c.in_scope);

  // Create workbook
  const wb = XLSX.utils.book_new();

  // Always create 2 sheets: In-Scope Only and All Companies (for both_sheets or as default)
  // Sheet 1: In-Scope Only
  const inScopeData = inScopeCompanies.map((c, i) => ({
    '#': i + 1,
    'Company': c.company_name,
    'Website': c.website || 'Not found',
    'Business Description': c.business_description || '-'
  }));
  const inScopeSheet = XLSX.utils.json_to_sheet(inScopeData);
  inScopeSheet['!cols'] = [
    { wch: 5 },   // #
    { wch: 40 },  // Company
    { wch: 50 },  // Website
    { wch: 60 }   // Business Description
  ];
  XLSX.utils.book_append_sheet(wb, inScopeSheet, 'In-Scope Only');

  // Sheet 2: All Companies with status
  const allData = companies.map((c, i) => ({
    '#': i + 1,
    'Company': c.company_name,
    'Website': c.website || 'Not found',
    'Status': c.in_scope ? 'IN SCOPE' : 'OUT OF SCOPE',
    'Business Description': c.business_description || c.reason || '-'
  }));
  const allSheet = XLSX.utils.json_to_sheet(allData);
  allSheet['!cols'] = [
    { wch: 5 },   // #
    { wch: 40 },  // Company
    { wch: 50 },  // Website
    { wch: 15 },  // Status
    { wch: 60 }   // Business Description
  ];
  XLSX.utils.book_append_sheet(wb, allSheet, 'All Companies');

  // Write to buffer and convert to base64
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return buffer.toString('base64');
}

app.post('/api/validation', async (req, res) => {
  const { Companies, Countries, TargetBusiness, OutputOption, Email } = req.body;

  if (!Companies || !TargetBusiness || !Email) {
    return res.status(400).json({ error: 'Companies, TargetBusiness, and Email are required' });
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

        console.log(`  Fetched pageText for ${companyName}: type=${typeof pageText}, length=${pageText?.length || 0}`);

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



// ============ HEALTHCHECK ============
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'validation' });
});

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Validation server running on port ${PORT}`);
});
