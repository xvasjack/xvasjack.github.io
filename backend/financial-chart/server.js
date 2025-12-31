require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const pptxgen = require('pptxgenjs');
const XLSX = require('xlsx');
const multer = require('multer');
const { createClient } = require('@deepgram/sdk');
const { S3Client } = require('@aws-sdk/client-s3');
const Anthropic = require('@anthropic-ai/sdk');
const JSZip = require('jszip');
const { securityHeaders, rateLimiter, escapeHtml } = require('../shared/security');
const { requestLogger, healthCheck } = require('../shared/middleware');

// ============ GLOBAL ERROR HANDLERS - PREVENT CRASHES ============
// Memory logging helper for debugging Railway OOM issues
function logMemoryUsage(label = '') {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  console.log(
    `  [Memory${label ? ': ' + label : ''}] Heap: ${heapUsedMB}/${heapTotalMB}MB, RSS: ${rssMB}MB`
  );
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
function _ensureString(value, defaultValue = '') {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return defaultValue;
  // Handle arrays - join with comma
  if (Array.isArray(value)) return value.map((v) => _ensureString(v)).join(', ');
  // Handle objects - try to extract meaningful string
  if (typeof value === 'object') {
    // Common patterns from AI responses
    if (value.city && value.country) return `${value.city}, ${value.country}`;
    if (value.text) return _ensureString(value.text);
    if (value.value) return _ensureString(value.value);
    if (value.name) return _ensureString(value.name);
    // Fallback: stringify
    try {
      return JSON.stringify(value);
    } catch {
      return defaultValue;
    }
  }
  // Convert other types to string
  return String(value);
}

const app = express();
app.use(securityHeaders);
app.use(rateLimiter);
app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Multer configuration for file uploads (memory storage)
// Add 50MB limit to prevent OOM on Railway containers
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

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

// Initialize Anthropic (Claude)
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Initialize Deepgram
const _deepgram = process.env.DEEPGRAM_API_KEY ? createClient(process.env.DEEPGRAM_API_KEY) : null;

// Initialize Cloudflare R2 (S3-compatible)
const r2Client =
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
    ? new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

const _R2_BUCKET = process.env.R2_BUCKET_NAME || 'dd-recordings';

if (!r2Client) {
  console.warn(
    'R2 not configured - recordings will only be stored in memory. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME'
  );
}

// Extract text from .docx files (Word documents)
async function _extractDocxText(base64Content) {
  try {
    const buffer = Buffer.from(base64Content, 'base64');
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    if (!documentXml) {
      return '[Could not extract text from Word document]';
    }

    // Extract text from XML, removing tags
    const text = documentXml
      .replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, '$1') // Extract text content
      .replace(/<w:p[^>]*>/g, '\n') // Paragraph breaks
      .replace(/<[^>]+>/g, '') // Remove remaining tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n\s*\n/g, '\n\n') // Clean up multiple newlines
      .trim();

    console.log(`[DD] Extracted ${text.length} chars from DOCX`);
    return text || '[Empty Word document]';
  } catch (error) {
    console.error('[DD] DOCX extraction error:', error.message);
    return `[Error extracting Word document: ${error.message}]`;
  }
}

// Extract text from .pptx files (PowerPoint)
async function _extractPptxText(base64Content) {
  try {
    const buffer = Buffer.from(base64Content, 'base64');
    const zip = await JSZip.loadAsync(buffer);

    const allText = [];
    let slideNum = 1;

    // Iterate through slide files
    for (const filename of Object.keys(zip.files)) {
      if (filename.match(/ppt\/slides\/slide\d+\.xml$/)) {
        const slideXml = await zip.file(filename)?.async('string');
        if (slideXml) {
          // Extract text from slide
          const slideText = slideXml
            .replace(/<a:t>([^<]*)<\/a:t>/g, '$1 ') // Extract text
            .replace(/<a:p[^>]*>/g, '\n') // Paragraph breaks
            .replace(/<[^>]+>/g, '') // Remove tags
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();

          if (slideText) {
            allText.push(`[Slide ${slideNum}]\n${slideText}`);
          }
          slideNum++;
        }
      }
    }

    const result = allText.join('\n\n') || '[Empty PowerPoint]';
    console.log(`[DD] Extracted ${result.length} chars from PPTX (${slideNum - 1} slides)`);
    return result;
  } catch (error) {
    console.error('[DD] PPTX extraction error:', error.message);
    return `[Error extracting PowerPoint: ${error.message}]`;
  }
}

// Extract text from .xlsx files (Excel)
async function _extractXlsxText(base64Content) {
  try {
    const buffer = Buffer.from(base64Content, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });

    const allText = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) {
        allText.push(`[Sheet: ${sheetName}]\n${csv}`);
      }
    }

    const result = allText.join('\n\n') || '[Empty Excel file]';
    console.log(`[DD] Extracted ${result.length} chars from XLSX`);
    return result;
  } catch (error) {
    console.error('[DD] XLSX extraction error:', error.message);
    return `[Error extracting Excel: ${error.message}]`;
  }
}

// Send email using SendGrid API
async function sendEmail(to, subject, html, attachments = null, maxRetries = 3) {
  const senderEmail = process.env.SENDER_EMAIL;
  const emailData = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: senderEmail, name: 'Find Target' },
    subject: subject,
    content: [{ type: 'text/html', value: html }],
  };

  if (attachments) {
    const attachmentList = Array.isArray(attachments) ? attachments : [attachments];
    emailData.attachments = attachmentList.map((a) => ({
      filename: a.filename || a.name, // Support both 'filename' and 'name' properties
      content: a.content,
      type: 'application/octet-stream',
      disposition: 'attachment',
    }));
  }

  // Retry logic with exponential backoff
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(emailData),
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
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Email failed after all retries');
}

// ============ AI TOOLS ============

// Gemini 2.5 Flash-Lite - cost-effective for general tasks ($0.10/$0.40 per 1M tokens)
async function _callGemini(prompt) {
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

// GPT-4o fallback function for when Gemini fails
async function _callGPT4oFallback(prompt, jsonMode = false, reason = '') {
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

// Gemini 2.5 Pro - Most capable model for critical validation tasks
// Use this for final data accuracy verification where errors are unacceptable
async function _callGemini2Pro(prompt, jsonMode = false) {
  try {
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0, // Zero temperature for deterministic validation
      },
    };

    if (jsonMode) {
      requestBody.generationConfig.responseMimeType = 'application/json';
    }

    // Using stable gemini-2.5-pro (upgraded from deprecated gemini-2.5-pro-preview-06-05)
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        timeout: 180000, // Longer timeout for Pro model
      }
    );
    const data = await response.json();

    if (data.error) {
      console.error('Gemini 2.5 Pro API error:', data.error.message);
      return '';
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (error) {
    console.error('Gemini 2.5 Pro error:', error.message);
    return '';
  }
}

// Claude (Anthropic) - excellent reasoning and analysis
async function _callClaude(prompt, systemPrompt = null, _jsonMode = false) {
  if (!anthropic) {
    console.warn('Claude not available - ANTHROPIC_API_KEY not set');
    return '';
  }
  try {
    const messages = [{ role: 'user', content: prompt }];
    const requestParams = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages,
    };

    if (systemPrompt) {
      requestParams.system = systemPrompt;
    }

    const response = await anthropic.messages.create(requestParams);
    const text = response.content?.[0]?.text || '';

    return text;
  } catch (error) {
    console.error('Claude error:', error.message);
    return '';
  }
}

async function _callPerplexity(prompt) {
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
async function _callOpenAISearch(prompt) {
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

// SerpAPI - Google Search integration
async function _callSerpAPI(query) {
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

// DeepSeek V3.2 - Cost-effective alternative to GPT-4o
async function _callDeepSeek(prompt, maxTokens = 4000) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('DeepSeek API key not set, falling back to GPT-4o');
    return null; // Caller should handle fallback
  }
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      timeout: 120000,
    });
    const data = await response.json();
    if (data.error) {
      console.error('DeepSeek API error:', data.error);
      return null;
    }
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('DeepSeek error:', error.message);
    return null;
  }
}
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
function _strategy1_BroadSerpAPI(business, country, _exclusion) {
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
function _strategy2_BroadPerplexity(business, country, exclusion) {
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
function _strategy3_ListsSerpAPI(business, country, _exclusion) {
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
function _strategy4_CitiesPerplexity(business, country, exclusion) {
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
function _strategy5_IndustrialSerpAPI(business, country, _exclusion) {
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
function _strategy6_DirectoriesPerplexity(business, country, exclusion) {
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
function _strategy7_ExhibitionsPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} exhibitors at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies at industry exhibitions in ${country} region. Not ${exclusion}. ${outputFormat}`,
    `${business} participants at expos and conferences in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors at international fairs from ${country}. Not ${exclusion}. ${outputFormat}`,
  ];
}

// Strategy 8: Import/Export & Supplier Databases (Perplexity)
function _strategy8_TradePerplexity(business, country, exclusion) {
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
function _strategy9_DomainsPerplexity(business, country, exclusion) {
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
function _strategy10_RegistriesSerpAPI(business, country, _exclusion) {
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
function _strategy11_CityIndustrialSerpAPI(business, country, _exclusion) {
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
function _strategy12_DeepOpenAISearch(business, country, exclusion) {
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
function _strategy13_PublicationsPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} companies mentioned in industry magazines and trade publications for ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} market report ${country} - list all companies mentioned. Not ${exclusion}. ${outputFormat}`,
    `${business} industry analysis ${country} - companies covered. Exclude ${exclusion}. ${outputFormat}`,
    `${business} ${country} magazine articles listing companies. Not ${exclusion}. ${outputFormat}`,
  ];
}

// Strategy 14: Final Sweep - Local Language + Comprehensive (OpenAI Search)
function _strategy14_LocalLanguageOpenAISearch(business, country, _exclusion) {
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

function _dedupeCompanies(allCompanies) {
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

function _isSpamOrDirectoryURL(url) {
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

// ============ FINANCIAL CHART MAKER ============

// Country to currency mapping for LC/local currency detection
const _COUNTRY_CURRENCY_MAP = {
  japan: { code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
  'united states': { code: 'USD', symbol: '$', name: 'US Dollar' },
  usa: { code: 'USD', symbol: '$', name: 'US Dollar' },
  china: { code: 'CNY', symbol: '¥', name: 'Chinese Yuan' },
  korea: { code: 'KRW', symbol: '₩', name: 'Korean Won' },
  'south korea': { code: 'KRW', symbol: '₩', name: 'Korean Won' },
  thailand: { code: 'THB', symbol: '฿', name: 'Thai Baht' },
  malaysia: { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit' },
  singapore: { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' },
  indonesia: { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah' },
  vietnam: { code: 'VND', symbol: '₫', name: 'Vietnamese Dong' },
  philippines: { code: 'PHP', symbol: '₱', name: 'Philippine Peso' },
  india: { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
  australia: { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  uk: { code: 'GBP', symbol: '£', name: 'British Pound' },
  'united kingdom': { code: 'GBP', symbol: '£', name: 'British Pound' },
  europe: { code: 'EUR', symbol: '€', name: 'Euro' },
  germany: { code: 'EUR', symbol: '€', name: 'Euro' },
  france: { code: 'EUR', symbol: '€', name: 'Euro' },
  taiwan: { code: 'TWD', symbol: 'NT$', name: 'Taiwan Dollar' },
  'hong kong': { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar' },
  brazil: { code: 'BRL', symbol: 'R$', name: 'Brazilian Real' },
  mexico: { code: 'MXN', symbol: 'MX$', name: 'Mexican Peso' },
  canada: { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
};

// AI agent to analyze Excel financial data
async function analyzeFinancialExcel(excelContent) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a financial data extraction expert. Analyze the Excel data and extract key financial information.

OUTPUT JSON with these fields:
- company_name: The company name found in the file (look for headers, titles, or file metadata)
- currency: The currency used (e.g., "USD", "JPY", "EUR"). If it says "LC" or "local currency", look for country mentions to determine actual currency. If currency symbol found (¥, $, €, etc.), identify it.
- country: Country of the company if mentioned
- revenue_data: Array of objects with { period: "FY2023" or "2023", value: number } - extract revenue/sales figures for multiple years. Value should be raw numbers (e.g., 1000000 not "1M").
- revenue_unit: The unit for revenue (e.g., "millions", "billions", "thousands", or "units" for raw numbers)
- margin_data: Array of objects with { period: "FY2023", margin_type: "operating" | "ebitda" | "pretax" | "net" | "gross", value: number (as percentage, e.g., 15.5 for 15.5%) }
  Priority order for margins: operating margin > EBITDA margin > pre-tax margin > net margin > gross margin
  Include the highest priority margin type available. If multiple margin types exist, include them all sorted by priority.
- fiscal_year_end: Month of fiscal year end if mentioned (e.g., "March", "December")

RULES:
- Extract ALL years/periods available (not just most recent)
- Revenue values should be numeric (convert "1,234" to 1234, "1.5M" to 1500000)
- Margin values as percentages (e.g., 12.5 for 12.5%)
- If LC/local currency mentioned, determine from country context
- Return ONLY valid JSON`,
        },
        {
          role: 'user',
          content: `Analyze this financial data:\n\n${excelContent}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Financial analysis error:', e.message);
    return null;
  }
}

// Initialize xlsx-chart for Excel chart generation
const XLSXChart = require('xlsx-chart');

// Generate financial chart Excel workbook with COMBO chart (column + line)
// Uses xlsx-chart library which properly supports combo charts
async function _generateFinancialChartExcel(financialDataArray) {
  return new Promise((resolve) => {
    try {
      const dataArray = Array.isArray(financialDataArray)
        ? financialDataArray
        : [financialDataArray];
      console.log('Generating Financial Chart Excel with xlsx-chart...');
      console.log(`Processing ${dataArray.length} company/companies`);

      // For now, we'll generate one file for the first company
      // xlsx-chart doesn't support multiple sheets easily, so we use the first company
      const financialData = dataArray[0];
      if (!financialData) {
        return resolve({ success: false, error: 'No financial data provided' });
      }

      const currency = financialData.currency || 'USD';
      const currencyUnit = financialData.revenue_unit || 'millions';
      const revenueData = financialData.revenue_data || [];
      const marginData = financialData.margin_data || [];

      if (revenueData.length === 0) {
        return resolve({ success: false, error: 'No revenue data found' });
      }

      // Sort revenue by period
      revenueData.sort((a, b) => {
        const yearA = parseInt(String(a.period).replace(/\D/g, ''));
        const yearB = parseInt(String(b.period).replace(/\D/g, ''));
        return yearA - yearB;
      });

      const chartLabels = revenueData.map((d) => String(d.period));
      const revenueValues = revenueData.map((d) => d.value || 0);

      // Get highest priority margin
      const marginPriority = ['operating', 'ebitda', 'pretax', 'net', 'gross'];
      const marginLabelMap = {
        operating: '営業利益率 (%)',
        ebitda: 'EBITDA利益率 (%)',
        pretax: '税前利益率 (%)',
        net: '純利益率 (%)',
        gross: '粗利益率 (%)',
      };

      let selectedMarginType = null;
      let marginValues = [];

      for (const marginType of marginPriority) {
        const typeData = marginData.filter((m) => m.margin_type === marginType);
        if (typeData.length > 0) {
          selectedMarginType = marginType;
          marginValues = chartLabels.map((period) => {
            const found = typeData.find((m) => String(m.period) === period);
            return found ? found.value : 0;
          });
          break;
        }
      }

      const unitDisplay =
        currencyUnit === 'millions' ? '百万' : currencyUnit === 'billions' ? '十億' : '';
      const revenueLabel = `売上高 (${currency}${unitDisplay})`;
      const marginLabel = selectedMarginType ? marginLabelMap[selectedMarginType] : '利益率 (%)';
      const companyName = financialData.company_name || 'Financial Performance';

      // Build xlsx-chart options
      const titles = [revenueLabel];
      if (selectedMarginType && marginValues.some((v) => v !== 0)) {
        titles.push(marginLabel);
      }

      // Build data object for xlsx-chart
      const data = {};

      // Revenue series (column chart)
      data[revenueLabel] = { chart: 'column' };
      chartLabels.forEach((label, i) => {
        data[revenueLabel][label] = revenueValues[i];
      });

      // Margin series (line chart) if available
      if (selectedMarginType && marginValues.some((v) => v !== 0)) {
        data[marginLabel] = { chart: 'line' };
        chartLabels.forEach((label, i) => {
          data[marginLabel][label] = marginValues[i];
        });
      }

      const opts = {
        titles: titles,
        fields: chartLabels,
        data: data,
        chartTitle: companyName + ' - 財務実績',
      };

      const xlsxChart = new XLSXChart();
      xlsxChart.generate(opts, (err, buffer) => {
        if (err) {
          console.error('xlsx-chart error:', err);
          return resolve({ success: false, error: err.message || 'Chart generation failed' });
        }

        const base64Content = buffer.toString('base64');
        console.log('Financial Chart Excel generated successfully');
        resolve({
          success: true,
          content: base64Content,
        });
      });
    } catch (error) {
      console.error('Financial Chart Excel error:', error);
      resolve({
        success: false,
        error: error.message,
      });
    }
  });
}

// Generate financial chart PowerPoint with data table (no charts - they corrupt files)
// Both pptxgenjs charts and manual OOXML embedding cause file corruption
async function generateFinancialChartPPTX(financialDataArray) {
  try {
    const dataArray = Array.isArray(financialDataArray) ? financialDataArray : [financialDataArray];

    console.log('Generating Financial Chart PPTX (table-based)...');
    console.log(`Processing ${dataArray.length} company/companies`);

    const pptx = new pptxgen();
    pptx.author = 'YCP';
    pptx.title = 'Financial Charts';
    pptx.subject = 'Financial Performance';

    pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
    pptx.layout = 'YCP';

    const COLORS = {
      headerLine: '293F55',
      white: 'FFFFFF',
      black: '000000',
      dk2: '1F497D',
      footerText: '808080',
      chartBlue: '5B9BD5',
      chartOrange: 'ED7D31',
    };

    // ===== DEFINE MASTER SLIDE WITH FIXED LINES (CANNOT BE MOVED) =====
    pptx.defineSlideMaster({
      title: 'YCP_FINANCIAL_MASTER',
      background: { color: 'FFFFFF' },
      objects: [
        {
          line: { x: 0, y: 1.02, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 4.5 } },
        },
        {
          line: { x: 0, y: 1.1, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } },
        },
        {
          line: { x: 0, y: 7.24, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } },
        },
      ],
    });

    for (const financialData of dataArray) {
      if (!financialData) continue;

      // Use master slide - lines are fixed in background and cannot be moved
      const slide = pptx.addSlide({ masterName: 'YCP_FINANCIAL_MASTER' });

      slide.addText('(C) YCP 2025 all rights reserved', {
        x: 4.1,
        y: 7.26,
        w: 5.1,
        h: 0.2,
        fontSize: 8,
        fontFace: 'Segoe UI',
        color: COLORS.footerText,
        align: 'center',
      });

      // Title
      const companyName = financialData.company_name || 'Financial Performance';
      const currency = financialData.currency || 'USD';
      const currencyUnit = financialData.revenue_unit || 'millions';

      slide.addText(companyName, {
        x: 0.38,
        y: 0.05,
        w: 9.5,
        h: 0.6,
        fontSize: 24,
        fontFace: 'Segoe UI',
        color: COLORS.black,
        valign: 'bottom',
      });
      slide.addText(`Financial Overview (${currency}, ${currencyUnit})`, {
        x: 0.38,
        y: 0.65,
        w: 9.5,
        h: 0.3,
        fontSize: 14,
        fontFace: 'Segoe UI',
        color: COLORS.footerText,
      });

      // Section header
      slide.addText('財務実績', {
        x: 6.86,
        y: 4.35,
        w: 6.1,
        h: 0.3,
        fontSize: 14,
        fontFace: 'Segoe UI',
        color: COLORS.black,
        align: 'center',
      });
      slide.addShape(pptx.shapes.LINE, {
        x: 6.86,
        y: 4.65,
        w: 6.1,
        h: 0,
        line: { color: COLORS.dk2, width: 1.75 },
      });

      // Financial data table
      const revenueData = financialData.revenue_data || [];
      const marginData = financialData.margin_data || [];

      if (revenueData.length > 0) {
        revenueData.sort(
          (a, b) =>
            parseInt(String(a.period).replace(/\D/g, '')) -
            parseInt(String(b.period).replace(/\D/g, ''))
        );

        const periods = revenueData.map((d) => String(d.period));
        const revenues = revenueData.map((d) => d.value || 0);

        // Find margin data
        const marginPriority = ['operating', 'ebitda', 'pretax', 'net', 'gross'];
        const marginLabelMap = {
          operating: '営業利益率',
          ebitda: 'EBITDA利益率',
          pretax: '税前利益率',
          net: '純利益率',
          gross: '粗利益率',
        };

        let marginType = null,
          margins = [];
        for (const mt of marginPriority) {
          const data = marginData.filter((m) => m.margin_type === mt);
          if (data.length > 0) {
            marginType = mt;
            margins = periods.map((p) => {
              const f = data.find((m) => String(m.period) === p);
              return f ? f.value : 0;
            });
            break;
          }
        }

        const unitDisplay =
          currencyUnit === 'millions' ? '百万' : currencyUnit === 'billions' ? '十億' : '';
        const revLabel = `売上高 (${currency}${unitDisplay})`;

        // Build table
        const tableRows = [];
        tableRows.push([
          { text: '', options: { fill: COLORS.dk2 } },
          ...periods.map((p) => ({
            text: p,
            options: { fill: COLORS.dk2, color: COLORS.white, bold: true, align: 'center' },
          })),
        ]);
        tableRows.push([
          { text: revLabel, options: { fill: COLORS.chartBlue, color: COLORS.white, bold: true } },
          ...revenues.map((v) => ({ text: v.toLocaleString(), options: { align: 'right' } })),
        ]);

        if (marginType && margins.some((v) => v !== 0)) {
          tableRows.push([
            {
              text: marginLabelMap[marginType] + ' (%)',
              options: { fill: COLORS.chartOrange, color: COLORS.white, bold: true },
            },
            ...margins.map((v) => ({
              text: v.toFixed(1) + '%',
              options: { align: 'right', color: COLORS.chartOrange },
            })),
          ]);
        }

        const colW = [1.8, ...periods.map(() => (6.0 - 1.8) / periods.length)];
        slide.addTable(tableRows, {
          x: 6.86,
          y: 4.75,
          w: 6.0,
          colW,
          fontFace: 'Segoe UI',
          fontSize: 10,
          border: { type: 'solid', pt: 0.5, color: 'CCCCCC' },
          valign: 'middle',
        });
      }

      slide.addText('Source: Company financial data', {
        x: 0.38,
        y: 6.9,
        w: 12.5,
        h: 0.18,
        fontSize: 10,
        fontFace: 'Segoe UI',
        color: COLORS.black,
      });
    }

    const base64Content = await pptx.write({ outputType: 'base64' });
    console.log('Financial Chart PPTX generated successfully');

    return { success: true, content: base64Content };
  } catch (error) {
    console.error('Financial Chart PPTX error:', error);
    return { success: false, error: error.message };
  }
}

// Financial Chart API endpoint - supports multiple files (up to 20)
app.post('/api/financial-chart', upload.array('excelFiles', 20), async (req, res) => {
  const { email } = req.body;
  const excelFiles = req.files;

  if (!excelFiles || excelFiles.length === 0 || !email) {
    return res.status(400).json({ error: 'Excel file(s) and email are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW FINANCIAL CHART REQUEST: ${new Date().toISOString()}`);
  console.log(`Email: ${email}`);
  console.log(`Files: ${excelFiles.length}`);
  excelFiles.forEach((f, i) => console.log(`  ${i + 1}. ${f.originalname} (${f.size} bytes)`));
  console.log('='.repeat(50));

  // Respond immediately
  res.json({
    success: true,
    message: `Request received. Processing ${excelFiles.length} file(s).`,
    fileCount: excelFiles.length,
  });

  try {
    const allFinancialData = [];
    const errors = [];

    // Process each Excel file
    for (let i = 0; i < excelFiles.length; i++) {
      const excelFile = excelFiles[i];
      console.log(`\nProcessing file ${i + 1}/${excelFiles.length}: ${excelFile.originalname}`);

      try {
        // Parse Excel file
        const workbook = XLSX.read(excelFile.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        // Get CSV format for AI analysis
        const csvContent = XLSX.utils.sheet_to_csv(sheet);

        // Use AI to analyze financial data
        console.log('  Analyzing with AI...');
        const financialData = await analyzeFinancialExcel(
          `File name: ${excelFile.originalname}\n\nContent:\n${csvContent.substring(0, 15000)}`
        );

        if (financialData) {
          financialData._fileName = excelFile.originalname;
          allFinancialData.push(financialData);
          console.log(`  ✓ Extracted: ${financialData.company_name || 'Unknown'}`);
        } else {
          errors.push({ file: excelFile.originalname, error: 'Failed to analyze' });
          console.log(`  ✗ Failed to analyze`);
        }
      } catch (fileError) {
        errors.push({ file: excelFile.originalname, error: fileError.message });
        console.log(`  ✗ Error: ${fileError.message}`);
      }
    }

    if (allFinancialData.length === 0) {
      throw new Error('No financial data could be extracted from any file');
    }

    console.log(`\nSuccessfully processed ${allFinancialData.length}/${excelFiles.length} files`);

    // Generate PowerPoint with embedded Excel charts (one slide per company)
    // Uses OOXML chart embedding for reliable chart rendering
    const pptxResult = await generateFinancialChartPPTX(allFinancialData);

    if (!pptxResult.success) {
      throw new Error(pptxResult.error || 'Failed to generate PowerPoint');
    }

    // Build email content with summary of all companies
    const companyNames = allFinancialData.map((d) => d.company_name || 'Unknown').join(', ');
    const summaryRows = allFinancialData
      .map(
        (d) => `
      <tr>
        <td style="padding: 8px; border: 1px solid #e2e8f0;">${d.company_name || 'Unknown'}</td>
        <td style="padding: 8px; border: 1px solid #e2e8f0;">${d.currency || '-'}</td>
        <td style="padding: 8px; border: 1px solid #e2e8f0;">${d.revenue_data ? d.revenue_data.length + ' periods' : '-'}</td>
        <td style="padding: 8px; border: 1px solid #e2e8f0;">${d.margin_data ? [...new Set(d.margin_data.map((m) => m.margin_type))].join(', ') : '-'}</td>
      </tr>
    `
      )
      .join('');

    const errorSection =
      errors.length > 0
        ? `
      <h3 style="color: #dc2626; margin-top: 20px;">Failed Files (${errors.length})</h3>
      <ul style="color: #666;">
        ${errors.map((e) => `<li>${e.file}: ${e.error}</li>`).join('')}
      </ul>
    `
        : '';

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a365d;">Financial Charts - ${allFinancialData.length} Companies</h2>
        <p>Your financial chart PowerPoint has been generated with ${allFinancialData.length} slide${allFinancialData.length > 1 ? 's' : ''}.</p>

        <h3 style="color: #2563eb; margin-top: 20px;">Companies Processed</h3>
        <table style="border-collapse: collapse; width: 100%; margin-top: 10px;">
          <tr style="background: #f8fafc;">
            <th style="padding: 8px; border: 1px solid #e2e8f0; text-align: left;">Company</th>
            <th style="padding: 8px; border: 1px solid #e2e8f0; text-align: left;">Currency</th>
            <th style="padding: 8px; border: 1px solid #e2e8f0; text-align: left;">Revenue</th>
            <th style="padding: 8px; border: 1px solid #e2e8f0; text-align: left;">Margins</th>
          </tr>
          ${summaryRows}
        </table>

        ${errorSection}

        <p style="margin-top: 20px; color: #64748b; font-size: 12px;">
          Generated by Financial Chart Maker<br>
          ${new Date().toISOString()}
        </p>
      </div>
    `;

    // Send email with PPTX attachment
    await sendEmail(
      email,
      `Financial Charts: ${allFinancialData.length} companies${allFinancialData.length <= 3 ? ' (' + companyNames + ')' : ''}`,
      htmlContent,
      {
        content: pptxResult.content,
        name: `Financial_Charts_${allFinancialData.length}_companies_${new Date().toISOString().split('T')[0]}.pptx`,
      }
    );

    console.log(`Financial chart PPTX sent to ${email}`);
    console.log('='.repeat(50));
  } catch (error) {
    console.error('Financial chart error:', error);
    try {
      await sendEmail(
        email,
        'Financial Chart - Error',
        `<p>Error processing your financial data: ${error.message}</p><p>Please ensure your Excel files contain financial data with revenue and margin information.</p>`
      );
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

// ============ HEALTH CHECK ============
app.get('/health', healthCheck('financial-chart'));

// ============ HEALTHCHECK ============
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'financial-chart' });
});

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Financial Chart server running on port ${PORT}`);
});
