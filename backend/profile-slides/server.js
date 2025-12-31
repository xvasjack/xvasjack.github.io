require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const pptxgen = require('pptxgenjs');
const XLSX = require('xlsx');
const multer = require('multer');
const { createClient } = require('@deepgram/sdk');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const { S3Client } = require('@aws-sdk/client-s3');
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

// Extract a company name from URL for inaccessible websites
function extractCompanyNameFromUrl(url) {
  try {
    const urlObj = new URL(url);
    let domain = urlObj.hostname.replace(/^www\./, '');
    // Remove common TLDs and country codes
    domain = domain.replace(/\.(com|co|org|net|io|ai|jp|cn|kr|sg|my|th|vn|id|ph|tw|hk|in|de|uk|fr|it|es|au|nz|ca|us|br|mx|ru|nl|be|ch|at|se|no|dk|fi|pl|cz|hu|ro|bg|gr|tr|ae|sa|il|za|ng|eg|ke)(\.[a-z]{2,3})?$/i, '');
    // Convert to title case
    const name = domain.split(/[-_.]/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
    return name || domain;
  } catch (e) {
    return url;
  }
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


// Extract text from .docx files (Word documents)
async function extractDocxText(base64Content) {
  try {
    const buffer = Buffer.from(base64Content, 'base64');
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    if (!documentXml) {
      return '[Could not extract text from Word document]';
    }

    // Extract text from XML, removing tags
    const text = documentXml
      .replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, '$1')  // Extract text content
      .replace(/<w:p[^>]*>/g, '\n')  // Paragraph breaks
      .replace(/<[^>]+>/g, '')  // Remove remaining tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n\s*\n/g, '\n\n')  // Clean up multiple newlines
      .trim();

    console.log(`[DD] Extracted ${text.length} chars from DOCX`);
    return text || '[Empty Word document]';
  } catch (error) {
    console.error('[DD] DOCX extraction error:', error.message);
    return `[Error extracting Word document: ${error.message}]`;
  }
}

// Extract text from .pptx files (PowerPoint)
async function extractPptxText(base64Content) {
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
            .replace(/<a:t>([^<]*)<\/a:t>/g, '$1 ')  // Extract text
            .replace(/<a:p[^>]*>/g, '\n')  // Paragraph breaks
            .replace(/<[^>]+>/g, '')  // Remove tags
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
async function extractXlsxText(base64Content) {
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

// Gemini 2.5 Flash - stable model for validation tasks (upgraded from gemini-3-flash-preview which was unstable)
// With GPT-4o fallback when Gemini fails or times out
async function callGemini3Flash(prompt, jsonMode = false) {
  try {
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1  // Low temperature for consistent validation
      }
    };

    // Add JSON mode if requested
    if (jsonMode) {
      requestBody.generationConfig.responseMimeType = 'application/json';
    }

    // Using stable gemini-2.5-flash (gemini-3-flash-preview was unreliable)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeout: 30000  // Reduced from 120s to 30s - fail fast and use GPT-4o fallback
    });

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
      temperature: 0.1
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
async function callGemini2Pro(prompt, jsonMode = false) {
  try {
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0  // Zero temperature for deterministic validation
      }
    };

    if (jsonMode) {
      requestBody.generationConfig.responseMimeType = 'application/json';
    }

    // Using stable gemini-2.5-pro (upgraded from deprecated gemini-2.5-pro-preview-06-05)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeout: 180000  // Longer timeout for Pro model
    });
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
async function callClaude(prompt, systemPrompt = null, jsonMode = false) {
  if (!anthropic) {
    console.warn('Claude not available - ANTHROPIC_API_KEY not set');
    return '';
  }
  try {
    const messages = [{ role: 'user', content: prompt }];
    const requestParams = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages
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

// DeepSeek V3.2 - Cost-effective alternative to GPT-4o
async function callDeepSeek(prompt, maxTokens = 4000) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('DeepSeek API key not set, falling back to GPT-4o');
    return null; // Caller should handle fallback
  }
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3
      }),
      timeout: 120000
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
    'enable cookies'
  ];

  const tryFetch = async (targetUrl) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000); // Increased to 20 seconds
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        },
        signal: controller.signal,
        redirect: 'follow'
      });
      clearTimeout(timeout);

      // Check for HTTP-level blocks
      if (response.status === 403 || response.status === 406) {
        return { status: 'security_blocked', reason: `HTTP ${response.status} - WAF/Security block` };
      }
      if (!response.ok) return { status: 'error', reason: `HTTP ${response.status}` };

      const html = await response.text();
      const lowerHtml = html.toLowerCase();

      // Check for security block patterns in content
      for (const pattern of securityBlockPatterns) {
        if (lowerHtml.includes(pattern) && html.length < 5000) {
          // Only flag as security block if page is small (likely a challenge page)
          return { status: 'security_blocked', reason: `Security protection detected: "${pattern}"` };
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

// ============ VALIDATION (v24 - GPT-4o with LENIENT filtering) ============

async function validateCompanyStrict(company, business, country, exclusion, pageText) {
  // If we couldn't fetch the website, validate by name only (give benefit of doubt)
  const contentToValidate = (typeof pageText === 'string' && pageText) ? pageText : `Company name: ${company.company_name}. Validate based on name only.`;

  const exclusionRules = buildExclusionRules(exclusion, business);

  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o',  // Use smarter model for better validation
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

OUTPUT: Return JSON only: {"valid": true/false, "reason": "one sentence"}`
        },
        {
          role: 'user',
          content: `COMPANY: ${company.company_name}
WEBSITE: ${company.website}
HQ: ${company.hq}

PAGE CONTENT:
${contentToValidate.substring(0, 10000)}`
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
    try {
      const batch = companies.slice(i, i + batchSize);
      if (!batch || batch.length === 0) continue;

      // Use cached _pageContent from verification step, or fetch if not available
      // Add .catch() to prevent any single failure from crashing the batch
      const pageTexts = await Promise.all(
        batch.map(c => {
          try {
            return c?._pageContent ? Promise.resolve(c._pageContent) : fetchWebsite(c?.website).catch(() => null);
          } catch (e) {
            return Promise.resolve(null);
          }
        })
      );

      // Add .catch() to each validation to prevent single failures from crashing batch
      const validations = await Promise.all(
        batch.map((company, idx) => {
          try {
            return validateCompanyStrict(company, business, country, exclusion, pageTexts[idx])
              .catch(e => {
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
              hq: validations[idx].corrected_hq || company.hq
            });
          }
        } catch (e) {
          console.error(`  Error processing company ${company?.company_name}: ${e.message}`);
        }
      });

      console.log(`  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`);
    } catch (batchError) {
      console.error(`  Batch error at ${i}-${i + batchSize}: ${batchError.message}`);
      // Continue to next batch instead of crashing
    }
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
${(typeof pageText === 'string' && pageText) ? pageText.substring(0, 8000) : 'Could not fetch - validate by name only'}`
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
    try {
      const batch = companies.slice(i, i + batchSize);
      if (!batch || batch.length === 0) continue;

      const pageTexts = await Promise.all(
        batch.map(c => fetchWebsite(c?.website).catch(() => null))
      );
      const validations = await Promise.all(
        batch.map((company, idx) =>
          validateCompany(company, business, country, exclusion, pageTexts[idx])
            .catch(e => {
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
              hq: validations[idx].corrected_hq || company.hq
            });
          }
        } catch (e) {
          console.error(`  Error processing company ${company?.company_name}: ${e.message}`);
        }
      });

      console.log(`  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`);
    } catch (batchError) {
      console.error(`  Batch error at ${i}-${i + batchSize}: ${batchError.message}`);
    }
  }

  console.log(`Validation done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Valid: ${validated.length}`);
  return validated;
}

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
  'SG': 'Singapore',
  'ISP': 'Internet Service Provider',
  'IBC': 'International Broadcasting',
  'IT': 'Information Technology',
  'AI': 'Artificial Intelligence',
  'IoT': 'Internet of Things',
  'ERP': 'Enterprise Resource Planning',
  'CRM': 'Customer Relationship Management',
  'SaaS': 'Software as a Service',
  'API': 'Application Programming Interface',
  'IP-KVM': 'Internet Protocol Keyboard Video Mouse',
  'KVM': 'Keyboard Video Mouse',
  'CCTV': 'Closed-Circuit Television',
  'UPS': 'Uninterruptible Power Supply',
  'NEC': 'Nippon Electric Company',
  'HACCP': 'Hazard Analysis Critical Control Point',
  'GMP': 'Good Manufacturing Practice',
  'CE': 'Conformité Européenne',
  'FDA': 'Food and Drug Administration',
  'SKU': 'Stock Keeping Unit',
  'POE': 'Power over Ethernet',
  'LAN': 'Local Area Network',
  'WAN': 'Wide Area Network',
  'VPN': 'Virtual Private Network'
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

// Get country code from location string - MUST match HQ country only
function getCountryCode(location) {
  if (!location) return null;
  const loc = location.toLowerCase();

  // HARD RULE: Extract HQ country FIRST - flag must match HQ, not other locations
  // Check for "HQ:" prefix and extract only HQ location
  const hqMatch = loc.match(/hq:\s*([^\n]+)/i);
  if (hqMatch) {
    const hqLocation = hqMatch[1].trim();
    // Get country from the end of HQ line (last comma-separated part)
    const parts = hqLocation.split(',').map(p => p.trim());
    const country = parts[parts.length - 1];
    for (const [key, code] of Object.entries(COUNTRY_FLAG_MAP)) {
      if (country.includes(key)) return code;
    }
  }

  // If no HQ prefix, check if it's a simple location (City, Country format)
  // Use the LAST part which should be the country
  const parts = loc.split(',').map(p => p.trim());
  if (parts.length >= 1) {
    const lastPart = parts[parts.length - 1];
    for (const [key, code] of Object.entries(COUNTRY_FLAG_MAP)) {
      if (lastPart.includes(key)) return code;
    }
  }

  // Fallback: search entire string (but this shouldn't happen with proper location format)
  for (const [key, code] of Object.entries(COUNTRY_FLAG_MAP)) {
    if (loc.includes(key)) return code;
  }
  return null;
}

// HARD RULE: Filter out empty/meaningless Key Metrics
// Remove metrics that say "No specific X stated", "Not specified", etc.
function filterEmptyMetrics(keyMetrics) {
  if (!keyMetrics || !Array.isArray(keyMetrics)) return [];

  // Patterns that indicate empty/meaningless metric VALUES
  const emptyValuePatterns = [
    /no specific/i,
    /not specified/i,
    /not stated/i,
    /not available/i,
    /not found/i,
    /not provided/i,
    /not mentioned/i,
    /not disclosed/i,
    /unknown/i,
    /n\/a/i,
    /none listed/i,
    /none specified/i,
    /none stated/i,
    /no information/i,
    /no data/i,
    /^\s*-?\s*$/,  // Empty or just dashes
    // Placeholder text patterns
    /client\s*\d+/i,          // "Client 1", "Client 2", etc.
    /client\s*[a-e]/i,        // "Client A", "Client B", etc.
    /customer\s*\d+/i,        // "Customer 1", "Customer 2", etc.
    /customer\s*[a-e]/i,      // "Customer A", "Customer B", etc.
    /supplier\s*\d+/i,        // "Supplier 1", "Supplier 2", etc.
    /partner\s*\d+/i,         // "Partner 1", "Partner 2", etc.
    /company\s*\d+/i,         // "Company 1", "Company 2", etc.
    // Generic industry descriptions without specifics
    /various\s+(printers|companies|manufacturers|customers|suppliers|partners)/i,
    /multiple\s+(printers|companies|manufacturers|customers|suppliers|partners)/i,
    /local\s+printers\s+and\s+multinational/i,  // Too vague
    // Values without actual data (just descriptions)
    /^-?\s*production capacity of(?!\s*\d)/i,  // "Production capacity of" without numbers
    /^-?\s*factory area of(?!\s*\d)/i,         // "Factory area of" without numbers
    /^-?\s*number of(?!\s*\d)/i,               // "Number of" without numbers
    /intensive r&d/i,         // Generic R&D statements
    /product improvement and innovation/i,
    /focus(ing|ed)?\s+on\s+(quality|innovation|customer)/i,  // Generic focus statements
    /commitment to/i,         // Generic commitment statements
    /world of color/i,        // Corporate slogans
    /value creation/i,        // Generic value statements
    /environmental impact/i,  // Generic sustainability
    /high standards in/i,     // "High standards in customer service"
    /constant.*innovation/i,  // "Constant technical innovation"
    /continuous improvement/i,
    /excellence in/i,         // "Excellence in service"
    /dedicated to/i,          // "Dedicated to quality"
    // Factory locations masquerading as factory size
    /facilities?\s+located\s+in/i,
    /located\s+in\s+.*city/i,
  ];

  // Labels that should be filtered out entirely (inappropriate for M&A slides)
  const badLabels = [
    /corporate vision/i,
    /vision statement/i,
    /mission statement/i,
    /company values/i,
    /core values/i,
    /our philosophy/i,
    /company motto/i,
    /slogan/i,
    /tagline/i,
    /years of experience/i,
    /awards/i,
    /achievements/i,
    /recognitions/i,
    // Garbage metrics - meaningless fluff
    /quality standards/i,
    /quality assurance/i,
    /quality control/i,
    /quality focus/i,
    /innovation focus/i,
    /r&d focus/i,
    /research focus/i,
    /customer service/i,
    /service excellence/i,
    /technical support/i,
    /customer satisfaction/i,
    /commitment/i,
    /dedication/i,
  ];

  return keyMetrics.filter(metric => {
    if (!metric || !metric.value) return false;
    const value = String(metric.value).trim();
    const label = String(metric.label || '').trim();
    if (!value) return false;

    // Check if label is inappropriate
    for (const pattern of badLabels) {
      if (pattern.test(label)) {
        console.log(`    Removing inappropriate metric: "${label}" = "${value}"`);
        return false;
      }
    }

    // Check if value matches any empty/meaningless pattern
    for (const pattern of emptyValuePatterns) {
      if (pattern.test(value)) {
        console.log(`    Removing empty/generic metric: "${label}" = "${value}"`);
        return false;
      }
    }

    // Clean up the value for certain labels
    const lowerLabel = label.toLowerCase();
    if (lowerLabel.includes('factory size') || lowerLabel.includes('factory area')) {
      // Remove "Factory occupies", "+/-", "approximately" etc.
      metric.value = value
        .replace(/factory\s+occupies\s*/i, '')
        .replace(/approximately\s*/i, '')
        .replace(/\+\/-\s*/g, '')
        .replace(/~\s*/g, '')
        .trim();
    }

    return true;
  });
}

// Common shortforms that don't need explanation
const COMMON_SHORTFORMS = [
  'M', 'B', 'K',           // Million, Billion, Thousand
  'HQ',                    // Headquarters
  'CEO', 'CFO', 'COO',     // C-suite titles
  // All currency codes - well known
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'KRW', 'TWD',
  'IDR', 'SGD', 'MYR', 'THB', 'PHP', 'VND', 'INR', 'HKD', 'AUD',
  'ISO',                   // Well-known standard
  'FY',                    // Fiscal Year
  'YoY', 'QoQ',            // Year over Year, Quarter over Quarter
  'B2B', 'B2C',            // Business models
  'AI', 'IT', 'IoT'        // Tech terms - widely known
];

// Detect shortforms in text and return formatted note (only uncommon ones)
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
      if (metric?.label) textParts.push(ensureString(metric.label));
      if (metric?.value) textParts.push(ensureString(metric.value));
    });
  }

  // Also include breakdown_items
  if (companyData.breakdown_items && Array.isArray(companyData.breakdown_items)) {
    companyData.breakdown_items.forEach(item => {
      if (item?.label) textParts.push(ensureString(item.label));
      if (item?.value) textParts.push(ensureString(item.value));
    });
  }

  const allText = textParts.filter(Boolean).join(' ');

  const foundShortforms = [];

  for (const [shortform, definition] of Object.entries(SHORTFORM_DEFINITIONS)) {
    // Skip common shortforms that don't need explanation
    if (COMMON_SHORTFORMS.includes(shortform)) continue;

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
// inaccessibleWebsites: websites that couldn't be scraped (appear on summary slide only, no individual profiles)
async function generatePPTX(companies, targetDescription = '', inaccessibleWebsites = []) {
  try {
    console.log('Generating PPTX with PptxGenJS...');
    if (inaccessibleWebsites.length > 0) {
      console.log(`  Including ${inaccessibleWebsites.length} inaccessible website(s) on summary slide only`);
    }

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

    // ===== DEFINE MASTER SLIDE WITH FIXED LINES (CANNOT BE MOVED) =====
    // Lines are part of the master template background, not individual shapes
    pptx.defineSlideMaster({
      title: 'YCP_MASTER',
      background: { color: 'FFFFFF' },
      objects: [
        // Thick header line (y: 1.02")
        { line: { x: 0, y: 1.02, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 4.5 } } },
        // Thin header line (y: 1.10")
        { line: { x: 0, y: 1.10, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } } },
        // Footer line (y: 7.24")
        { line: { x: 0, y: 7.24, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } } }
      ]
    });

    // ===== TARGET LIST SLIDE (FIRST SLIDE) =====
    // Include both accessible companies and inaccessible websites on the summary slide
    const allCompaniesForSummary = [...companies, ...inaccessibleWebsites];
    if (targetDescription && allCompaniesForSummary.length > 0) {
      try {
      console.log('Generating Target List slide...');
      const meceData = await generateMECESegments(targetDescription, allCompaniesForSummary);

      // Use master slide - lines are fixed in background
      const targetSlide = pptx.addSlide({ masterName: 'YCP_MASTER' });

      // Title Case helper function
      const toTitleCase = (str) => {
        return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
      };

      // Simplify country lists to regions
      const simplifyRegion = (desc) => {
        const seaCountries = ['malaysia', 'indonesia', 'singapore', 'thailand', 'vietnam', 'philippines', 'myanmar', 'cambodia', 'laos', 'brunei'];
        const lowerDesc = desc.toLowerCase();

        // Count how many SE Asian countries are mentioned
        const mentionedSEA = seaCountries.filter(c => lowerDesc.includes(c));

        // If 3+ SE Asian countries are listed, replace with "Southeast Asia"
        if (mentionedSEA.length >= 3) {
          // Build regex to match the country list (including "and", commas)
          const countryListPattern = new RegExp(
            `\\b(in|from)?\\s*(${seaCountries.join('|')})(\\s*,\\s*(${seaCountries.join('|')}))*\\s*(,?\\s*(and)?\\s*(${seaCountries.join('|')}))?`,
            'gi'
          );
          return desc.replace(countryListPattern, (match) => {
            // Check if it started with "in" or "from"
            const startsWithIn = /^\s*in\s/i.test(match);
            const startsWithFrom = /^\s*from\s/i.test(match);
            if (startsWithIn) return 'in Southeast Asia';
            if (startsWithFrom) return 'from Southeast Asia';
            return 'Southeast Asia';
          });
        }
        return desc;
      };

      // Title: "Target List – {Target Description}" in Title Case
      // Simplify multi-country lists to region names
      const simplifiedDesc = simplifyRegion(targetDescription);
      const formattedTitle = `Target List – ${toTitleCase(simplifiedDesc)}`;
      targetSlide.addText(formattedTitle, {
        x: 0.38, y: 0.07, w: 12.5, h: 0.9,
        fontSize: 24, fontFace: 'Segoe UI',
        color: '000000', valign: 'bottom'
      });

      // Helper function to parse location (handles JSON format like {"HQ":"Singapore"})
      // Also cleans up "HQ:", "- HQ:" prefixes from location values
      const parseLocation = (location) => {
        if (!location) return { country: 'Other', hqCity: '' };
        let loc = ensureString(location);

        // Clean up "- HQ:" or "HQ:" prefix from the start
        loc = loc.replace(/^-?\s*HQ:\s*/i, '').trim();

        // Check if location is JSON format (e.g., {"HQ":"Chatuchak, Bangkok, Thailand"})
        if (loc.includes('{') && loc.includes('}')) {
          try {
            // Try to extract the value from JSON-like string
            const match = loc.match(/"HQ"\s*:\s*"([^"]+)"/i) || loc.match(/"([^"]+)"\s*:\s*"([^"]+)"/);
            if (match) {
              let hqValue = match[1] || match[2] || '';
              // Clean up any remaining "HQ:" prefix
              hqValue = hqValue.replace(/^-?\s*HQ:\s*/i, '').trim();
              const parts = hqValue.split(',').map(p => p.trim());
              // Country is always last part
              const country = parts[parts.length - 1] || 'Other';
              // HQ city is first part only (just the district/area, not including state)
              const hqCity = parts[0] || '';
              return { country, hqCity };
            }
          } catch (e) {
            // Fall through to normal parsing
          }
        }

        // Normal parsing - extract country from location (last part after comma)
        const parts = loc.split(',').map(p => p.trim());
        const country = parts[parts.length - 1] || 'Other';
        // HQ city is first part only (just the district/area)
        const hqCity = parts[0] || '';
        return { country, hqCity };
      };

      // Group companies by country
      const companyByCountry = {};
      companies.forEach((c) => {
        const { country, hqCity } = parseLocation(c.location);
        if (!companyByCountry[country]) companyByCountry[country] = [];
        companyByCountry[country].push({ ...c, hqCity });
      });

      // Assign sequential numbers AFTER grouping (so numbers are in order by country)
      let sequentialIndex = 1;
      Object.keys(companyByCountry).forEach(country => {
        companyByCountry[country].forEach(comp => {
          comp.index = sequentialIndex++;
        });
      });

      // Determine if single country or multi-country
      const countries = Object.keys(companyByCountry);
      const isMultiCountry = countries.length > 1;

      // Build table data
      const segments = meceData.segments || [];
      const companySegments = meceData.companySegments || {};

      // Template colors (from analysis of YCP Target List Slide Template)
      const TL_COLORS = {
        headerBg: '1524A9',      // Dark blue for header row
        countryBg: '011AB7',     // Dark blue for country column (accent3)
        companyBg: '007FFF',     // Bright blue for company column (accent1)
        white: 'FFFFFF',
        black: '000000',
        gray: 'BFBFBF',          // Gray for dotted borders between rows
        checkMark: '00B050'      // Green for check marks
      };

      // Build table rows
      const tableRows = [];

      // Row 1: Merged header for products (spans all segment columns)
      const productHeaderRow = [];

      if (isMultiCountry) {
        // Empty cell for country column header (white background)
        productHeaderRow.push({
          text: '',
          options: {
            fill: TL_COLORS.white,
            valign: 'middle',
            align: 'center',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      }

      // Empty cell for company column header
      productHeaderRow.push({
        text: '',
        options: {
          fill: TL_COLORS.white,
          valign: 'middle',
          align: 'center',
          border: { pt: 3, color: TL_COLORS.white }
        }
      });

      // HQ column header with rowspan: 2 (spans both header rows)
      productHeaderRow.push({
        text: 'HQ',
        options: {
          rowspan: 2,
          fill: TL_COLORS.headerBg,
          color: TL_COLORS.white,
          bold: false,
          valign: 'middle',
          align: 'center',
          border: { pt: 3, color: TL_COLORS.white }
        }
      });

      // Merged header for all product columns (spans all segment columns)
      if (segments.length > 0) {
        productHeaderRow.push({
          text: 'Products / Services',
          options: {
            colspan: segments.length,
            fill: TL_COLORS.headerBg,
            color: TL_COLORS.white,
            bold: false,
            align: 'center',
            valign: 'middle',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      }

      tableRows.push(productHeaderRow);

      // Row 2: Segment names (sub-headers for products)
      const headerRow = [];

      if (isMultiCountry) {
        // Empty cell for country column header (white background)
        headerRow.push({
          text: '',
          options: {
            fill: TL_COLORS.white,
            valign: 'middle',
            align: 'center',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      }

      // Empty cell for company column header
      headerRow.push({
        text: '',
        options: {
          fill: TL_COLORS.white,
          valign: 'middle',
          align: 'center',
          border: { pt: 3, color: TL_COLORS.white }
        }
      });

      // HQ column is merged from row above (rowspan: 2), so no cell here

      // Segment headers (bright blue background like company names, white text)
      segments.forEach(seg => {
        headerRow.push({
          text: seg,
          options: {
            fill: TL_COLORS.companyBg,
            color: TL_COLORS.white,
            bold: false,
            align: 'center',
            valign: 'middle',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      });

      tableRows.push(headerRow);

      // Data rows grouped by country
      const countryKeys = Object.keys(companyByCountry);
      countryKeys.forEach((country) => {
        const countryCompanies = companyByCountry[country];
        countryCompanies.forEach((comp, idx) => {
          const row = [];
          const isFirstInCountry = idx === 0;
          const isLastInCountry = idx === countryCompanies.length - 1;

          // Determine if this is the last company in the last country (for bottom border)
          const isLastCountry = countryKeys.indexOf(country) === countryKeys.length - 1;
          const isVeryLastRow = isLastCountry && isLastInCountry;

          // Border style: dotted gray between ALL rows including last row
          const rowBottomBorder = { pt: 1, color: TL_COLORS.gray, type: 'dash' };

          if (isMultiCountry) {
            // Country column (only show text for first company in group, use rowspan)
            if (isFirstInCountry) {
              row.push({
                text: country,
                options: {
                  rowspan: countryCompanies.length,
                  fill: TL_COLORS.countryBg,
                  color: TL_COLORS.white,
                  bold: false,
                  align: 'center',
                  valign: 'middle',
                  border: { pt: 3, color: TL_COLORS.white }
                }
              });
            }
          }

          // Company name with numbering (bright blue background, WHITE text, left-aligned)
          // Keep 3pt white borders on ALL sides for company name cells
          const companyName = comp.title || comp.company_name || 'Unknown';
          row.push({
            text: `${comp.index}. ${companyName}`,
            options: {
              fill: TL_COLORS.companyBg,
              color: TL_COLORS.white,
              bold: false,
              align: 'left',
              valign: 'middle',
              border: { pt: 3, color: TL_COLORS.white },
              hyperlink: { url: comp.website || '' }
            }
          });

          // HQ column (white background, black text)
          const hqCity = comp.hqCity || '';
          row.push({
            text: hqCity,
            options: {
              fill: TL_COLORS.white,
              color: TL_COLORS.black,
              bold: false,
              align: 'left',
              valign: 'middle',
              border: [
                { pt: 3, color: TL_COLORS.white },    // top
                { pt: 3, color: TL_COLORS.white },    // right
                rowBottomBorder,                       // bottom (dotted between rows)
                { pt: 3, color: TL_COLORS.white }     // left
              ]
            }
          });

          // Segment tick marks (white background, green check marks)
          const compSegments = companySegments[String(comp.index)] || [];
          segments.forEach((seg, segIdx) => {
            const hasTick = compSegments[segIdx] === true;
            row.push({
              text: hasTick ? '✓' : '',
              options: {
                fill: TL_COLORS.white,
                color: TL_COLORS.checkMark,
                align: 'center',
                valign: 'middle',
                border: [
                  { pt: 3, color: TL_COLORS.white },    // top
                  { pt: 3, color: TL_COLORS.white },    // right
                  rowBottomBorder,                       // bottom (dotted between rows)
                  { pt: 3, color: TL_COLORS.white }     // left
                ]
              }
            });
          });

          tableRows.push(row);
        });
      });

      // Calculate column widths (from template: Country=1.12", Company=2.14", HQ=1.5", Segments=~1.17" each)
      const tableWidth = 12.6;
      let colWidths = [];

      if (isMultiCountry) {
        const countryColWidth = 1.12;
        const companyColWidth = 2.14;
        const hqColWidth = 1.5;
        const remainingWidth = tableWidth - countryColWidth - companyColWidth - hqColWidth;
        const segmentColWidth = segments.length > 0 ? remainingWidth / segments.length : 1.17;
        colWidths = [countryColWidth, companyColWidth, hqColWidth];
        segments.forEach(() => colWidths.push(segmentColWidth));
      } else {
        // Single country - no country column, company column takes more space
        const companyColWidth = 2.5;
        const hqColWidth = 1.5;
        const remainingWidth = tableWidth - companyColWidth - hqColWidth;
        const segmentColWidth = segments.length > 0 ? remainingWidth / segments.length : 1.17;
        colWidths = [companyColWidth, hqColWidth];
        segments.forEach(() => colWidths.push(segmentColWidth));
      }

      // Add target list table (position from template: x=0.3663", y=1.467")
      // Cell margins: 0.04 inch (0.1cm) left/right, 0 inch top/bottom
      // Font size 12 to fit more items
      targetSlide.addTable(tableRows, {
        x: 0.37, y: 1.47, w: tableWidth,
        colW: colWidths,
        fontFace: 'Segoe UI',
        fontSize: 12,
        valign: 'middle',
        rowH: 0.28,
        margin: [0, 0.04, 0, 0.04]  // [top, right, bottom, left] in inches
      });

      // Footnote (from template: x=0.3754", y=6.6723", font 10pt)
      targetSlide.addText('出典: Company websites', {
        x: 0.38, y: 6.67, w: 12.54, h: 0.42,
        fontSize: 10, fontFace: 'Segoe UI',
        color: '000000', valign: 'top'
      });

      console.log('Target List slide generated');
      } catch (targetListError) {
        console.error('ERROR generating Target List slide:', targetListError.message);
        console.error('Target List error stack:', targetListError.stack);
        // Continue without target list slide
      }
    }

    // ===== INDIVIDUAL COMPANY PROFILE SLIDES =====
    for (const company of companies) {
      try {
      // Skip companies with no meaningful info (only has website, no business/location/metrics)
      // Helper to check if value is a placeholder (e.g., "Not found", "N/A", etc.)
      const isPlaceholder = (val) => {
        if (!val) return true;
        const lower = String(val).toLowerCase().trim();
        const placeholders = ['not found', 'not specified', 'n/a', 'unknown', 'not available', 'none', 'not provided', 'not disclosed'];
        return placeholders.includes(lower) || lower.length === 0;
      };

      const hasBusinessInfo = company.business && !isPlaceholder(company.business);
      const hasLocation = company.location && !isPlaceholder(company.location);
      const hasCompanyName = company.company_name && !isPlaceholder(company.company_name);
      const hasMetrics = company.key_metrics && company.key_metrics.length > 0;
      const hasBreakdown = company.breakdown_items && company.breakdown_items.length > 0;

      // If company has NO meaningful data at all, skip it entirely
      if (!hasCompanyName && !hasBusinessInfo && !hasLocation && !hasMetrics && !hasBreakdown) {
        console.log(`  Skipping slide for ${company.website} - no meaningful info extracted (all fields are empty/placeholder)`);
        continue;
      }

      console.log(`  Generating slide for: ${company.company_name || company.website}`);
      // Use master slide - lines are fixed in background and cannot be moved
      const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });

      // ===== TITLE + MESSAGE (combined in one text box) =====
      const titleText = company.title || company.company_name || 'Company Profile';
      const messageText = company.message || '';

      // Create combined text with title (font 24) and message (font 16)
      const titleContent = messageText ? [
        { text: titleText, options: { fontSize: 24, fontFace: 'Segoe UI', color: COLORS.black, breakLine: true } },
        { text: messageText, options: { fontSize: 16, fontFace: 'Segoe UI', color: COLORS.black } }
      ] : titleText;

      slide.addText(titleContent, {
        x: 0.38, y: 0.07, w: 9.5, h: 0.9,
        fontSize: 24, fontFace: 'Segoe UI',
        color: COLORS.black, valign: 'bottom',
        margin: [0, 0, 0, 0]  // No left/right margin
      });

      // ===== FLAG (top right) =====
      const countryCode = getCountryCode(company.location);
      if (countryCode) {
        try {
          const flagUrl = `https://flagcdn.com/w80/${countryCode.toLowerCase()}.png`;
          const flagBase64 = await fetchImageAsBase64(flagUrl);
          if (flagBase64) {
            const flagX = 10.64, flagY = 0.22, flagW = 0.83, flagH = 0.55;
            // Add flag image
            slide.addImage({
              data: `data:image/png;base64,${flagBase64}`,
              x: flagX, y: flagY, w: flagW, h: flagH
            });
            // Add 1pt black outline around flag
            slide.addShape(pptx.shapes.RECTANGLE, {
              x: flagX, y: flagY, w: flagW, h: flagH,
              fill: { type: 'none' },
              line: { color: '000000', width: 1 }
            });
          }
        } catch (e) {
          console.log('Flag fetch failed for', countryCode);
        }
      }

      // ===== LOGO (top right of slide) =====
      if (company.website && typeof company.website === 'string') {
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
            // Use square container to prevent stretching (logos are typically square)
            slide.addImage({
              data: `data:image/png;base64,${logoBase64}`,
              x: 12.1, y: 0.12, w: 0.7, h: 0.7,
              sizing: { type: 'contain', w: 0.7, h: 0.7 }
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

      // Right: Dynamic title based on breakdown_title - positioned at 6.86" x 1.37"
      const rightSectionTitle = company.breakdown_title || 'Products and Applications';
      slide.addText(rightSectionTitle, {
        x: 6.86, y: 1.37, w: 6.1, h: 0.35,
        fontSize: 14, fontFace: 'Segoe UI',
        color: COLORS.black, align: 'center'
      });
      slide.addShape(pptx.shapes.LINE, {
        x: 6.86, y: 1.79, w: 6.1, h: 0,
        line: { color: COLORS.dk2, width: 1.75 }
      });

      // ===== LEFT TABLE (会社概要資料) =====
      // Determine if single location (for HQ label)
      const locationText = ensureString(company.location);
      const locationLines = locationText.split('\n').filter(line => line.trim());
      const isSingleLocation = locationLines.length <= 1 && !locationText.toLowerCase().includes('branch') && !locationText.toLowerCase().includes('factory') && !locationText.toLowerCase().includes('warehouse');
      const locationLabel = isSingleLocation ? 'HQ' : 'Location';

      // Helper function to check if value is empty or placeholder text
      const isEmptyValue = (val) => {
        if (!val) return true;
        const strVal = ensureString(val);
        const lower = strVal.toLowerCase().trim();
        const emptyPhrases = [
          '', 'not specified', 'n/a', 'unknown', 'not available', 'not found',
          'not explicitly mentioned', 'not mentioned', 'none', 'none specified',
          'not disclosed', 'not provided', 'no information', 'no data',
          'none explicitly mentioned'
        ];
        // Check exact match or if value contains placeholder phrases
        if (emptyPhrases.includes(lower)) return true;
        // Check if value contains placeholder phrases (e.g., "Number of Employees: Not specified")
        const containsPhrases = ['not specified', 'not available', 'not found', 'not disclosed',
                                  'not provided', 'not mentioned', 'not explicitly', 'none explicitly',
                                  'no information', 'no data', 'n/a', 'unknown'];
        for (const phrase of containsPhrases) {
          if (lower.includes(phrase)) return true;
        }
        // CRITICAL: Detect alphabetical/numbered placeholder patterns like "Distributor A, B, C" or "Partner X, Y, Z"
        // Pattern: word followed by single letter (A, B, C...) or number (1, 2, 3...)
        const placeholderPatterns = [
          /\b(distributor|partner|supplier|customer|client|vendor)\s+[a-c]\b/gi,
          /\b(distributor|partner|supplier|customer|client|vendor)\s+[x-z]\b/gi,
          /\b(distributor|partner|supplier|customer|client|vendor)\s+[1-3]\b/gi,
          /\b[a-z]+\s+[a-c],\s*[a-z]+\s+[a-c]/gi,  // "Something A, Something B"
          /\b[a-z]+\s+[x-z],\s*[a-z]+\s+[x-z]/gi,  // "Something X, Something Y"
        ];
        for (const pattern of placeholderPatterns) {
          if (pattern.test(strVal)) return true;
        }
        return false;
      };

      // Helper function to remove company suffixes and prefixes
      const removeCompanySuffix = (name) => {
        if (!name) return name;
        return name
          // Remove PT., CV. prefix from Indonesian companies
          .replace(/^(PT\.?|CV\.?)\s+/gi, '')
          // Remove suffixes
          .replace(/\s*(Company\s+Limited|Co\.,?\s*Ltd\.?|Ltd\.?|Limited|Sdn\.?\s*Bhd\.?|Pte\.?\s*Ltd\.?|Inc\.?|Corp\.?|Corporation|LLC|GmbH|JSC|PT\.?|Tbk\.?|S\.?A\.?|PLC|Company)\s*$/gi, '')
          .trim();
      };

      // Helper function to clean location value (remove JSON format and "HQ:" prefix)
      // ALSO enforces Singapore 2-level rule at display time
      const cleanLocationValue = (location, label) => {
        if (!location) return location;
        let cleaned = location;

        // Handle JSON format like {"HQ":"Chatuchak, Bangkok, Thailand"} or {"HQ":"CBD, Singapore"}
        if (cleaned.includes('{') && cleaned.includes('}')) {
          try {
            // Try to extract the value from JSON-like string
            // First regex: /"HQ":"value"/ - match[1] is the value
            // Second regex: /"key":"value"/ - match[1] is key, match[2] is value
            const match = cleaned.match(/"HQ"\s*:\s*"([^"]+)"/i) || cleaned.match(/"([^"]+)"\s*:\s*"([^"]+)"/);
            if (match) {
              // Prefer match[2] (value from second regex) over match[1] (could be key from second regex)
              cleaned = match[2] || match[1] || cleaned;
            }
          } catch (e) {
            // Fall through to normal cleaning
          }
        }

        // If label is HQ, remove "- HQ:" or "HQ:" prefix from value
        if (label === 'HQ') {
          cleaned = cleaned.replace(/^-?\s*HQ:\s*/i, '').trim();
        }

        // FINAL SINGAPORE FIX: If location is just "Singapore", try to extract area from address
        // or leave as-is (can't make up areas)
        const parts = cleaned.split(',').map(p => p.trim()).filter(p => p);
        const isSingapore = parts[parts.length - 1]?.toLowerCase() === 'singapore' ||
                           cleaned.toLowerCase() === 'singapore';

        if (isSingapore && parts.length > 2) {
          // Too many levels for Singapore - keep only first part + Singapore
          cleaned = `${parts[0]}, Singapore`;
        }

        return cleaned;
      };

      // Base company info rows - only add if value exists
      const tableData = [];

      // Always add Name with hyperlink (remove company suffix)
      // Use title as fallback if company_name is empty
      const companyName = company.company_name || company.title || '';
      if (!isEmptyValue(companyName)) {
        const cleanName = removeCompanySuffix(companyName);
        tableData.push(['Name', cleanName, company.website || null]);
      }

      // Add Est. Year if available
      if (!isEmptyValue(company.established_year)) {
        tableData.push(['Est. Year', company.established_year, null]);
      }

      // Add Location if available (clean up HQ: prefix if needed)
      if (!isEmptyValue(company.location)) {
        const cleanLocation = cleanLocationValue(company.location, locationLabel);
        tableData.push([locationLabel, cleanLocation, null]);
      }

      // Add Business if available
      if (!isEmptyValue(company.business)) {
        tableData.push(['Business', company.business, null]);
      }

      // Track existing labels to prevent duplicates
      const existingLabels = new Set(tableData.map(row => row[0].toLowerCase()));

      // Metrics to exclude (worthless or duplicate)
      const EXCLUDED_METRICS = [
        'market position', 'market share', 'market leader',
        'number of branches', 'branches', 'number of locations', 'locations',
        'operating hours', 'business hours', 'office hours',
        'years of experience', 'experience', 'years in business',
        'awards', 'recognitions', 'achievements',
        'certification', 'certifications', 'iso', 'accreditation', 'accreditations',
        // Garbage metrics - meaningless fluff
        'quality standards', 'quality assurance', 'quality control', 'quality focus',
        'innovation focus', 'innovation', 'r&d focus', 'research focus',
        'customer service', 'service excellence', 'technical support',
        'customer satisfaction', 'commitment', 'dedication', 'focus on'
      ];

      // Get the right table category to exclude from left table (prevent duplication)
      const rightTableCategory = ensureString(company.breakdown_title).toLowerCase();
      // Map breakdown titles to keywords to exclude
      const categoryKeywords = {
        'customers': ['customer', 'client', 'buyer'],
        'services': ['service'],
        'products and applications': ['product', 'application'],
        'key suppliers': ['supplier', 'vendor', 'partner'],
        'key partnerships': ['partner', 'partnership']
      };
      const excludeKeywords = categoryKeywords[rightTableCategory] || [];

      // Add key metrics as separate rows if available (skip duplicates and empty values)
      if (company.key_metrics && Array.isArray(company.key_metrics)) {
        company.key_metrics.forEach(metric => {
          // Ensure label and value are strings (AI may return objects/arrays)
          const metricLabel = ensureString(metric?.label);
          const metricValue = ensureString(metric?.value);

          if (metricLabel && metricValue && !isEmptyValue(metricValue)) {
            const labelLower = metricLabel.toLowerCase();

            // Skip excluded metrics
            const isExcluded = EXCLUDED_METRICS.some(ex => labelLower.includes(ex));

            // Skip if this category is already shown on the right table
            const isInRightTable = excludeKeywords.some(kw => labelLower.includes(kw));

            // Skip if this label already exists or is duplicate of business/location
            if (!isExcluded &&
                !isInRightTable &&
                !existingLabels.has(labelLower) &&
                !labelLower.includes('business') &&
                !labelLower.includes('location')) {
              tableData.push([metricLabel, metricValue, null]);
              existingLabels.add(labelLower);
            }
          }
        });
      } else if (company.metrics && !isEmptyValue(company.metrics)) {
        // Fallback for old format (single string)
        tableData.push(['Key Metrics', company.metrics, null]);
      }

      // Helper function to format cell text with bullet points
      // Uses regular bullet • (U+2022) directly in text
      const formatCellText = (text) => {
        if (!text || typeof text !== 'string') return text;

        // Check if text has multiple lines or bullet markers
        const hasMultipleLines = text.includes('\n');
        const hasBulletMarkers = text.includes('■') || text.includes('•') || text.includes('\n-') || text.startsWith('-');

        if (hasMultipleLines || hasBulletMarkers) {
          // Split by newline and filter out empty lines
          const lines = text.split('\n').filter(line => line.trim());

          // Format ALL lines with bullets (even single line if it starts with -)
          const formattedLines = lines.map(line => {
            const cleanLine = line.replace(/^[■\-•]\s*/, '').trim();
            return '• ' + cleanLine;
          });
          return formattedLines.join('\n');
        }
        return text;
      };

      const rows = tableData.map((row) => {
        const valueCell = {
          text: formatCellText(row[1]),
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
        };

        // Add hyperlink if URL is provided (third element in row array)
        if (row[2]) {
          valueCell.options.hyperlink = { url: row[2], tooltip: 'Visit company website' };
          valueCell.options.color = '0563C1'; // Blue hyperlink color
        }

        return [
          {
            text: row[0],
            options: {
              fill: { color: COLORS.accent3 },
              color: COLORS.white,
              align: 'center',
              bold: false
            }
          },
          valueCell
        ];
      });

      const tableStartY = 1.85;
      const rowHeight = 0.35;

      // Skip table if no data (prevents PptxGenJS error "Array expected")
      if (rows.length === 0) {
        console.log(`  Skipping table for ${company.company_name || company.website} - no table data`);
      } else {
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
      }

      // ===== RIGHT SECTION (varies by business type) =====
      const businessType = company.business_type || 'industrial';

      if (businessType === 'project' && company.projects && company.projects.length > 0) {
        // PROJECT-BASED: Show project images in 2x2 grid like LCP example
        const projects = company.projects.slice(0, 4);

        // 2x2 grid layout
        const gridStartX = 6.86;
        const gridStartY = 1.91;
        const colWidth = 3.0;  // Each column width
        const rowHeight = 2.4; // Each row height
        const imageW = 1.4;    // Image width
        const imageH = 1.1;    // Image height
        const textOffsetX = 1.5; // Text starts after image
        const textWidth = 1.4;   // Text width

        for (let i = 0; i < projects.length; i++) {
          const project = projects[i];
          const col = i % 2;  // 0 or 1
          const row = Math.floor(i / 2);  // 0 or 1

          const cellX = gridStartX + (col * colWidth);
          const cellY = gridStartY + (row * rowHeight);

          // Try to fetch and add project image
          if (project.image_url) {
            try {
              const imgBase64 = await fetchImageAsBase64(project.image_url);
              if (imgBase64) {
                slide.addImage({
                  data: `data:image/jpeg;base64,${imgBase64}`,
                  x: cellX, y: cellY, w: imageW, h: imageH,
                  sizing: { type: 'cover', w: imageW, h: imageH }
                });
              }
            } catch (imgErr) {
              console.log(`  Failed to fetch project image: ${project.image_url}`);
            }
          }

          // Project name (bold) - positioned to right of image
          slide.addText(project.name || '', {
            x: cellX + textOffsetX, y: cellY, w: textWidth, h: 0.5,
            fontSize: 11, fontFace: 'Segoe UI', bold: true,
            color: COLORS.black, valign: 'top'
          });

          // Project metrics - below name
          const metricsText = (project.metrics || []).join('\n');
          if (metricsText) {
            slide.addText(metricsText, {
              x: cellX + textOffsetX, y: cellY + 0.5, w: textWidth, h: 0.8,
              fontSize: 9, fontFace: 'Segoe UI',
              color: COLORS.black, valign: 'top'
            });
          }
        }
      } else if (businessType === 'consumer' && company.products && company.products.length > 0) {
        // CONSUMER-FACING: Show product images with labels
        const products = company.products.slice(0, 4);
        const productWidth = 1.4;
        const productStartX = 6.86;
        const productY = 1.91;

        for (let i = 0; i < products.length; i++) {
          const product = products[i];
          const xPos = productStartX + (i * (productWidth + 0.15));

          // Try to fetch and add product image
          if (product.image_url) {
            try {
              const imgBase64 = await fetchImageAsBase64(product.image_url);
              if (imgBase64) {
                slide.addImage({
                  data: `data:image/jpeg;base64,${imgBase64}`,
                  x: xPos, y: productY, w: productWidth, h: 1.2,
                  sizing: { type: 'contain', w: productWidth, h: 1.2 }
                });
              }
            } catch (imgErr) {
              console.log(`  Failed to fetch product image: ${product.image_url}`);
            }
          }

          // Product name
          slide.addText(product.name || '', {
            x: xPos, y: productY + 1.25, w: productWidth, h: 0.35,
            fontSize: 10, fontFace: 'Segoe UI', bold: true,
            color: COLORS.black, align: 'center', valign: 'top'
          });
        }
      } else {
        // INDUSTRIAL B2B: Show table format
        let validBreakdownItems = (company.breakdown_items || [])
          .map(item => ({
            label: ensureString(item?.label),
            value: ensureString(item?.value)
          }))
          .filter(item => item.label && item.value && !isEmptyValue(item.label) && !isEmptyValue(item.value));

        // Limit to 8 rows maximum (to fit like Premink example with 9 product lines)
        if (validBreakdownItems.length > 8) {
          validBreakdownItems = validBreakdownItems.slice(0, 8);
        }

        // Truncate values to max 3 lines
        validBreakdownItems = validBreakdownItems.map(item => {
          let value = item.value;
          const lines = value.split('\n');
          if (lines.length > 3) {
            value = lines.slice(0, 3).join('\n');
          }
          return { label: item.label, value };
        });

        if (validBreakdownItems.length >= 1) {
          const rightTableData = validBreakdownItems.map(item => [String(item.label || ''), String(item.value || '')]);

          const rightRows = rightTableData.map((row) => [
            {
              text: String(row[0] || ''),
              options: {
                fill: { color: COLORS.accent3 },
                color: COLORS.white,
                align: 'center',
                bold: false
              }
            },
            {
              text: String(row[1] || ''),
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
            x: 6.86, y: 1.91,
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
      }

      // ===== FOOTNOTE (single text box with stacked content) =====
      const footnoteLines = [];

      // Line 1: Note with shortform explanations (only uncommon ones)
      const shortformNote = detectShortforms(company);
      if (shortformNote) {
        footnoteLines.push(shortformNote);
      }

      // Line 2: Exchange rate - always add for countries with pre-set rates (especially SEA)
      const exchangeRate = countryCode ? EXCHANGE_RATE_MAP[countryCode] : null;
      if (exchangeRate) {
        footnoteLines.push(exchangeRate);
      }

      // Line 3: Source
      footnoteLines.push('Source: Company website');

      // Create single text box with all footnote content stacked
      const footnoteContent = footnoteLines.join('\n');
      const footnoteHeight = 0.18 * footnoteLines.length;

      slide.addText(footnoteContent, {
        x: 0.38, y: 6.85, w: 12.5, h: footnoteHeight,
        fontSize: 10, fontFace: 'Segoe UI',
        color: COLORS.black, valign: 'top',
        margin: [0, 0, 0, 0]  // No left/right margin
      });
      } catch (slideError) {
        console.error(`  ERROR generating slide for ${company.company_name || company.website}:`, slideError.message);
        console.error('  Slide error stack:', slideError.stack);
        // Continue with next company instead of failing entire PPTX
      }
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
    console.error('PptxGenJS error stack:', error.stack);
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
// Using GPT-4o for accurate extraction esp. non-English content
async function extractBasicInfo(scrapedContent, websiteUrl) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You extract company information from website content.

OUTPUT JSON with these fields:
- company_name: Company name with first letter of each word capitalized. Remove suffixes like Limited, Ltd, Sdn Bhd, Pte Ltd, PT, Inc, Corp, Company.
- established_year: Clean numbers only (e.g., "1995"), leave empty if not found
- location: HEADQUARTERS ONLY - extract ONLY the main HQ location, NEVER include branches/factories/warehouses/offices.

  CRITICAL: EXACTLY 3 LEVELS for non-Singapore countries: "City/District, State/Province, Country"
  CRITICAL: EXACTLY 2 LEVELS for Singapore: "Area, Singapore"

  WRONG (too few levels):
  - "Selangor, Malaysia" ← WRONG! Missing city
  - "Bangkok, Thailand" ← WRONG! Missing district
  - "Jakarta, Indonesia" ← WRONG! Missing area

  WRONG (too many levels):
  - "Seksyen 27, Shah Alam, Selangor, Malaysia" ← WRONG! 4 levels, use only 3
  - "Jalan ABC, Puchong, Selangor, Malaysia" ← WRONG! No street names

  WRONG (includes non-HQ):
  - "HQ: Singapore; Branches: Shenzhen" ← WRONG! Only HQ, no branches
  - "Headquarters: Bangkok; Factory: Rayong" ← WRONG! Only HQ

  CORRECT examples by country:

  Malaysia (City, State, Country):
  - "Shah Alam, Selangor, Malaysia"
  - "Puchong, Selangor, Malaysia"
  - "Penang, Penang, Malaysia"
  - "Johor Bahru, Johor, Malaysia"

  Thailand (District, Province, Country):
  - "Bangna, Bangkok, Thailand"
  - "Bang Phli, Samut Prakan, Thailand"
  - "Chatuchak, Bangkok, Thailand"

  Indonesia (City/Area, Province, Country):
  - "Tangerang, Banten, Indonesia"
  - "Cikarang, West Java, Indonesia"
  - "Bekasi, West Java, Indonesia"

  Vietnam (District, City, Country):
  - "Thu Duc, Ho Chi Minh City, Vietnam"
  - "Binh Duong, Binh Duong Province, Vietnam"

  Philippines (City, Region, Country):
  - "Makati, Metro Manila, Philippines"
  - "Caloocan, Metro Manila, Philippines"

  Singapore (Area, Singapore) - ONLY 2 LEVELS:
  - "Jurong West, Singapore"
  - "Jurong East, Singapore"
  - "Tuas, Singapore"
  - "Ubi, Singapore"
  - "Woodlands, Singapore"

  CRITICAL SINGAPORE RULE: NEVER output just "Singapore" alone!
  - WRONG: "Singapore" ← UNACCEPTABLE! Must have area!
  - WRONG: "Singapore, Singapore" ← WRONG! Find the actual area!
  - CORRECT: "Jurong West, Singapore" or "Tuas, Singapore"
  - Look at the address on website to find the area/district name

CRITICAL - EXTRACT FROM ACTUAL ADDRESS:
- Find the ACTUAL address text on the website (e.g., "123 Moo 5, Mueang Samut Sakhon District, Samut Sakhon 74000")
- Extract the district/city and province FROM THE ADDRESS - do NOT guess or assume
- If address says "Samut Sakhon", output "Mueang Samut Sakhon, Samut Sakhon, Thailand" NOT "Bangkok, Thailand"
- NEVER default to capital city (Bangkok, Jakarta, etc.) unless address explicitly mentions it
- If you cannot find an address, leave location empty rather than guessing

RULES:
- ONLY extract HQ location - ignore all branches, factories, warehouses, offices
- Write ALL text using regular English alphabet only (A-Z, no diacritics/accents)
- Convert ALL Vietnamese: "Phú" → "Phu", "Đông" → "Dong", "Nguyễn" → "Nguyen"
- Convert ALL foreign characters: "São" → "Sao", "北京" → "Beijing"
- Leave fields empty if information not found
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Website: ${websiteUrl}
Content: ${scrapedContent.substring(0, 25000)}`
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

// Post-process and validate HQ location format
// Singapore: MUST be 2 levels (Area, Singapore) - NEVER just "Singapore"
// Non-Singapore: MUST be 3 levels (City, State, Country) - NEVER just 2 levels
function validateAndFixHQFormat(location, websiteUrl) {
  if (!location || typeof location !== 'string') return location;

  let loc = location.trim();

  // Remove any "HQ:" prefix
  loc = loc.replace(/^-?\s*HQ:\s*/i, '').trim();

  const parts = loc.split(',').map(p => p.trim()).filter(p => p);
  const lastPart = parts[parts.length - 1]?.toLowerCase() || '';

  // Check if Singapore
  const isSingapore = lastPart === 'singapore' || loc.toLowerCase() === 'singapore';

  if (isSingapore) {
    // Singapore: must be exactly 2 levels
    if (parts.length === 1 || loc.toLowerCase() === 'singapore') {
      // Only "Singapore" - extract area from website URL or use default
      const domain = websiteUrl?.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || '';

      // Try to guess area from common Singapore industrial areas in domain
      const areaHints = {
        'jurong': 'Jurong',
        'tuas': 'Tuas',
        'woodlands': 'Woodlands',
        'ubi': 'Ubi',
        'changi': 'Changi',
        'bedok': 'Bedok',
        'tampines': 'Tampines',
        'ang mo kio': 'Ang Mo Kio',
        'amk': 'Ang Mo Kio',
        'paya lebar': 'Paya Lebar',
        'kallang': 'Kallang',
        'geylang': 'Geylang'
      };

      let area = null;
      for (const [hint, areaName] of Object.entries(areaHints)) {
        if (domain.toLowerCase().includes(hint)) {
          area = areaName;
          break;
        }
      }

      // If no area found, don't just use "Singapore" alone - better to leave it for manual fix
      // But log it so we know
      if (!area) {
        console.log(`  [HQ Fix] Singapore missing area, couldn't determine from URL: ${websiteUrl}`);
        // Return just Singapore for now - better than making up an area
        return 'Singapore';
      }

      console.log(`  [HQ Fix] Fixed Singapore HQ: "${loc}" → "${area}, Singapore"`);
      return `${area}, Singapore`;
    }
    if (parts.length > 2) {
      // Too many levels, keep first and last
      const fixed = `${parts[0]}, Singapore`;
      console.log(`  [HQ Fix] Fixed Singapore HQ (too many levels): "${loc}" → "${fixed}"`);
      return fixed;
    }
    return loc; // Already 2 levels
  } else {
    // Non-Singapore: must be exactly 3 levels
    if (parts.length > 3) {
      // Too many levels, keep last 3
      const fixed = parts.slice(-3).join(', ');
      console.log(`  [HQ Fix] Fixed non-Singapore HQ (too many levels): "${loc}" → "${fixed}"`);
      return fixed;
    }
    return loc; // Already 3 levels or less (can't add missing levels without more info)
  }
}

// AI Agent 2: Extract business, message, footnote, title
// Using GPT-4o for accurate extraction esp. non-English content
async function extractBusinessInfo(scrapedContent, basicInfo) {
  // Ensure locationText is always a string (AI might return object/array)
  const locationText = typeof basicInfo.location === 'string' ? basicInfo.location : '';
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
1. business: Description of what company does. Use 1-3 bullet points - ONLY as many as needed, NOT always 3. Format each line starting with "- ".

   FORMAT REQUIREMENT: Use this structure (vary the connector words naturally):
   - "Manufacture [category] including [top 3 products]"
   - "Distribute [category] for [applications]"
   - "Provide [service type] for [use cases]"

   Connector options: "such as", "including", "for", "like", "covering" - vary them naturally, don't always use "such as".

   Examples:
   "- Manufacture printing inks including gravure inks, flexographic inks, and UV inks\\n- Provide technical services for printing process optimization"

   RULES FOR BUSINESS POINTS:
   - Use ONLY 1-3 points depending on what the company actually does
   - If company only manufactures, use 1 point. Don't add filler.
   - NEVER include generic statements like "Conduct R&D", "Provide quality products", "Focus on innovation"
   - NEVER include vague services like "customized solutions", "quality assurance" unless those are their PRIMARY business
   - Only include points with SPECIFIC, CONCRETE content

2. message: One-liner introductory message about the company. Example: "Malaysia-based distributor specializing in electronic components and industrial automation products across Southeast Asia."

3. footnote: Two parts:
   - Notes (optional): If unusual shortforms used, write full-form like "SKU (Stock Keeping Unit)". Separate multiple with comma.
   - Currency: ${currencyExchange || 'Leave empty if no matching currency'}
   Separate notes and currency with semicolon. Always end with new line: "出典: 会社ウェブサイト、SPEEDA"

4. title: Company name WITHOUT suffix (remove Pte Ltd, Sdn Bhd, Co Ltd, JSC, PT, Inc, etc.)

RULES:
- Write ALL text using regular English alphabet only (A-Z, no diacritics/accents)
- Convert ALL Vietnamese: "Phú" → "Phu", "Đông" → "Dong", "Nguyễn" → "Nguyen", "Bình" → "Binh", "Thạnh" → "Thanh", "Cương" → "Cuong"
- Convert ALL foreign characters: "São" → "Sao", "北京" → "Beijing", "東京" → "Tokyo"
- All bullet points must use "- " (dash followed by space)
- Each bullet point on new line using "\\n"
- Keep it to the MOST KEY items only (3 bullet points max)
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Company: ${basicInfo.company_name}
Established: ${basicInfo.established_year}
Location: ${basicInfo.location}

Website Content:
${scrapedContent.substring(0, 25000)}`
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
// Using GPT-4o for accurate extraction esp. non-English content and visible statistics
async function extractKeyMetrics(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst extracting COMPREHENSIVE key business metrics for potential buyers evaluating this company.

CRITICAL - VISIBLE STATISTICS FIRST:
Before anything else, scan the ENTIRE page for ANY prominently displayed numbers/statistics:
- Look for large numbers displayed on the homepage (e.g., "880", "300+", "60", "12")
- These are often shown in counter/stat sections with labels below them
- Common patterns: "60 Customers", "880 Colour Matching", "300+ Employees", "12 New Projects"
- TRANSLATE any non-English labels to English (e.g., "Kota Distribusi" = "Distribution Cities", "Project Baru" = "New Projects")
- Include ALL visible statistics with their labels in the "Key Metrics" field

EXTRACT AS MANY OF THESE METRICS AS POSSIBLE (aim for 8-15 metrics):

CUSTOMERS & MARKET (CRITICAL - LOOK EVERYWHERE FOR CLIENTS):
- Key customer names (look for: "Clients", "Customers", "Our Clients", logo sections, testimonials)
- IMPORTANT: If website shows CLIENT LOGOS, extract those company names (e.g., Sinarmas, Dole, SCG logos = customer names)
- Number of customers (total active customers)
- Customer segments served

SUPPLIERS & PARTNERSHIPS (CRITICAL FOR DISTRIBUTORS):
- Principal brands/suppliers (for distributors: look for "Our Brands", "Principals", "Partners" with LOGOS)
- IMPORTANT: If website shows SUPPLIER/BRAND LOGOS, extract those company names!
- Key supplier/partner names
- Notable partnerships, JVs, technology transfers
- Exclusive distribution agreements
- For distributors: the brands they distribute are CRITICAL info - capture ALL of them!

OPERATIONS & SCALE:
- Production capacity (units/month, tons/month)
- Factory/warehouse size (m², sq ft)
- Number of machines/equipment
- Number of employees/headcount
- Number of SKUs/products

GEOGRAPHIC REACH (CRITICAL - CAPTURE ALL DISTRIBUTION INFO):
- Export countries (list ALL countries mentioned: Thailand, Sri Lanka, Pakistan, Bangladesh, UAE, etc.)
- Distribution network (distributors, agents, dealers - include country names)
- Markets served (if domestic only, write "Nationwide" instead of listing regions)
- IMPORTANT: If website mentions "distributors across Thailand, Sri Lanka, Pakistan..." - CAPTURE THIS!

INDUSTRIES SERVED:
- List the industries/applications the company serves (e.g., "Gravure Printing, Screen Printing, Footwear, Leather, Rubber")
- Look for "Industries We Serve", "Applications", "Markets" sections

QUALITY & COMPLIANCE:
- Certifications (ISO, HACCP, GMP, FDA, CE, halal, etc.)
- Patents or proprietary technology

OUTPUT JSON:
{
  "key_metrics": [
    {"label": "Key Metrics", "value": "- Production capacity of 800+ tons per month\\n- 250+ machines\\n- 300+ employees"},
    {"label": "Key Suppliers", "value": "6 suppliers including Hikvision, Dahua, Paradox, ZKTeco, Ruijie"},
    {"label": "Export Countries", "value": "SEA, South Asia, North Africa"},
    {"label": "Distribution Network", "value": "700 domestic distribution partners"},
    {"label": "Certification", "value": "ISO 9001, ISO 14001"},
    {"label": "Notable Partnerships", "value": "Launch partnership with Dainichiseika Color & Chemicals (Japanese) in 2009 technology transfer, joint product development and marketing"}
  ]
}

MERGE DUPLICATIVE INFORMATION:
When you find BOTH a count AND specific names for the same category, MERGE them into ONE coherent entry:
- BAD: {"label": "Number of Suppliers", "value": "6"} AND {"label": "Key Suppliers", "value": "Hikvision, Dahua, Paradox"}
- GOOD: {"label": "Key Suppliers", "value": "6 suppliers including Hikvision, Dahua, Paradox, ZKTeco, Ruijie"}

- BAD: {"label": "Number of Customers", "value": "250,000"} AND {"label": "Key Customers", "value": "Installers, Dealers, Integrators"}
- GOOD: {"label": "Key Customers", "value": "Over 250,000 installations including Installers, Dealers, System Integrators"}

- BAD: {"label": "Number of Employees", "value": "100+"} in metrics array
- GOOD: Include employee count in "Key Metrics" bullet point

SEGMENTATION REQUIREMENT:
For metrics with MANY items (e.g., Customers, Suppliers), segment them by category using POINT FORM:
Example for Customers:
{"label": "Customers", "value": "- Residential: Customer1, Customer2, Customer3\\n- Commercial: Customer4, Customer5\\n- Industrial: Customer6, Customer7"}

Example for Suppliers:
{"label": "Suppliers", "value": "- Raw Materials: Supplier1, Supplier2\\n- Packaging: Supplier3, Supplier4\\n- Equipment: Supplier5"}

IMPORTANT: Always use "- " prefix for each segment line to create point form for easier reading.

RULES:
- HARD RULE - TRANSLATE ALL NON-ENGLISH TEXT TO ENGLISH:
  - ALL product names, company names, and any other text in ANY non-English language MUST be translated to English
  - This applies to ALL languages: Vietnamese, Chinese, Thai, Malay, Indonesian, Hindi, Korean, Japanese, Arabic, Spanish, etc.
  - The user CANNOT translate - you MUST translate everything to English
- Write ALL text using regular English alphabet only (A-Z, no diacritics, no foreign characters)
- Remove company suffixes from ALL names: Co., Ltd, JSC, Sdn Bhd, Pte Ltd, Inc, Corp, LLC, GmbH
- Extract as many metrics as found (8-15 ideally)
- For metrics with multiple items, use "- " bullet points separated by "\\n"
- For long lists of customers/suppliers, SEGMENT by category as shown above
- Labels should be 1-3 words
- Be specific with numbers when available
- For Shareholding: ONLY include if EXPLICITLY stated on website (e.g., "family-owned", "publicly traded", "PE-backed"). NEVER assume ownership structure.
- DO NOT include: years of experience, awards, recognitions, market position, operating hours, number of branches/locations (not useful for M&A)
- DO NOT include: corporate vision, mission statement, company values, slogans, taglines
- DO NOT include garbage metrics like: "Quality Standards", "Innovation Focus", "Customer Service", "Technical Support", "R&D Focus", "Quality Assurance", "Service Excellence" - these are meaningless fluff
- DO NOT include vague phrases like "High standards in customer service", "Constant innovation", "Focus on quality" - these have no concrete value
- DO NOT include metrics with NO MEANINGFUL VALUES - if you don't have specific data, don't include the metric at all
- CRITICAL - NEVER GENERATE FAKE/PLACEHOLDER DATA:
  - NEVER write alphabetical placeholders like "Distributor A, Distributor B", "Partner X, Partner Y", "Customer 1, Customer 2"
  - NEVER write "Client 1, Client 2", "Customer A, Customer B", "Supplier A, Supplier B"
  - NEVER write "Not specified", "Various", "Multiple", "Several"
  - If you don't have REAL names, DO NOT include the metric at all
- NEVER use generic industry descriptions like "Printing Industry: Various Printers" or "Packaging Industry: Various Companies" - either provide ACTUAL company names or don't include the metric
- NEVER include metrics without actual numbers. BAD: "Production capacity of solvent-based inks". GOOD: "Production capacity: 500 tons/month"
- NEVER include generic R&D statements like "Intensive R&D for product improvement"
- For Factory Size: ONLY include actual measurements (e.g., "7,500 m²"). Do NOT include factory locations - those go in the HQ/Location field.
- If you cannot find actual customer/supplier names, DO NOT include those metrics at all
- NEVER make up data - only include what's explicitly stated on the website
- SHORT LIST FORMATTING: If only 2-3 items, write comma-separated inline (e.g., "Singapore, Sri Lanka"), NOT point form
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Company: ${previousData.company_name}
Industry/Business: ${previousData.business}

Website Content (extract ALL M&A-relevant metrics):
${scrapedContent.substring(0, 35000)}`
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

// AI Agent 3b: Extract rich content for right-side table
// Using GPT-4o for accurate extraction esp. non-English content
async function extractProductsBreakdown(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst creating the RIGHT-SIDE content for a company profile slide.

FIRST: Determine the BUSINESS TYPE:
1. PROJECT-BASED: Construction, building materials, engineering, architecture, contractors
   - These companies showcase PROJECTS with photos on their website
   - Look for: "Projects", "Portfolio", "Case Studies", "Our Work", project galleries

2. CONSUMER-FACING: Consumer products, retail, F&B, cosmetics, fashion
   - These companies showcase PRODUCTS with photos
   - Look for: Product catalogs, product images, consumer goods

3. INDUSTRIAL B2B: Manufacturing, chemicals, inks, coatings, industrial supplies
   - These companies have product lines for different applications/industries
   - Focus on: Product categories by APPLICATION or INDUSTRY

OUTPUT FORMAT based on business type:

FOR PROJECT-BASED (construction, building, engineering):
{
  "business_type": "project",
  "breakdown_title": "Past Projects",
  "projects": [
    {
      "name": "Metrojet Hangar at Clark Philippines",
      "image_url": "https://example.com/project1.jpg",
      "metrics": ["Area: 7,400m²", "Material: Pre-painted Steel"]
    },
    {
      "name": "Al Rayyan Stadium Qatar",
      "image_url": "https://example.com/project2.jpg",
      "metrics": ["Area: 26,400m²", "Material: Aluminium PVDF"]
    }
  ]
}

FOR CONSUMER-FACING (consumer products):
{
  "business_type": "consumer",
  "breakdown_title": "Product Range",
  "products": [
    {
      "name": "Premium Ink Series",
      "image_url": "https://example.com/product1.jpg",
      "description": "High-quality printing inks"
    }
  ]
}

FOR INDUSTRIAL B2B (manufacturing, chemicals):
{
  "business_type": "industrial",
  "breakdown_title": "Products and Applications",
  "breakdown_items": [
    {"label": "Flexographic Inks", "value": "Water-based inks for paper packaging, corrugated boxes"},
    {"label": "Screen Printing", "value": "Inks for plastics, glass, metal substrates"},
    {"label": "Paper & Board", "value": "High gloss, matt inks for paper and cardboard"},
    {"label": "Specialty Coatings", "value": "Overprint varnishes, protective coatings"}
  ]
}

CRITICAL RULES FOR INDUSTRIAL B2B TABLE:
- Labels should be PRODUCT LINES or APPLICATION CATEGORIES (like "Flexographic Inks", "Screen Printing", "Paper & Board")
- NOT generic labels like "Products", "Applications", "Industries Served", "Services"
- Look at company's actual product naming/categorization
- 6-8 rows required (more rows = better coverage of product lines)
- Each value describes what the product is FOR (applications)

CRITICAL: For projects/products, extract ACTUAL image URLs from the website content!
Look for: <img src="...">, background-image: url(...), data-src="...", srcset="..."

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: `Company: ${previousData.company_name}
Industry/Business: ${previousData.business}

Website Content:
${scrapedContent.substring(0, 35000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    const result = JSON.parse(response.choices[0].message.content);

    // Validate based on business type
    if (result.business_type === 'project' && result.projects) {
      result.projects = result.projects
        .filter(p => p && typeof p === 'object' && p.name)
        .map(p => ({
          name: String(p.name || ''),
          image_url: String(p.image_url || ''),
          metrics: Array.isArray(p.metrics) ? p.metrics.map(m => String(m)) : []
        }))
        .slice(0, 4); // Max 4 projects
    } else if (result.business_type === 'consumer' && result.products) {
      result.products = result.products
        .filter(p => p && typeof p === 'object' && p.name)
        .map(p => ({
          name: String(p.name || ''),
          image_url: String(p.image_url || ''),
          description: String(p.description || '')
        }))
        .slice(0, 4); // Max 4 products
    } else {
      // Default to industrial/table format
      result.business_type = 'industrial';
      if (result.breakdown_items && Array.isArray(result.breakdown_items)) {
        result.breakdown_items = result.breakdown_items
          .filter(item => item && typeof item === 'object')
          .map(item => ({
            label: String(item.label || ''),
            value: String(item.value || '')
          }))
          .filter(item => item.label && item.value);
      } else {
        result.breakdown_items = [];
      }
    }

    return result;
  } catch (e) {
    console.error('Agent 3b (products) error:', e.message);
    return { business_type: 'industrial', breakdown_title: 'Products and Applications', breakdown_items: [] };
  }
}

// AI Agent 3c: Extract financial metrics for 財務実績 section
// Using GPT-4o-mini (60% cost savings for number extraction)
async function extractFinancialMetrics(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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

// AI Agent 6: Generate MECE segments for target list slide
async function generateMECESegments(targetDescription, companies) {
  if (!targetDescription || companies.length === 0) {
    return { segments: [], companySegments: {} };
  }

  try {
    console.log('Generating MECE segments for target list...');

    // Prepare company summaries for AI
    const companySummaries = companies.map((c, i) => ({
      id: i + 1,
      name: c.title || c.company_name || 'Unknown',
      business: c.business || '',
      location: c.location || ''
    }));

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst creating a target list slide. Given a target description and company information, create MECE (Mutually Exclusive, Collectively Exhaustive) segments to categorize these companies.

Create 4-6 segment columns that are:
1. Relevant to the target description (e.g., for "security product distributors" → segments could be product types like "CCTV", "Access Control", "Fire Safety", etc.)
2. Mutually exclusive (each segment is distinct)
3. Collectively exhaustive (covers all relevant categories for this industry)

For each company, mark which segments apply to them based on their business description.

OUTPUT JSON:
{
  "segments": ["Segment 1", "Segment 2", "Segment 3", "Segment 4", "Segment 5"],
  "companySegments": {
    "1": [true, false, true, false, true],
    "2": [false, true, true, true, false]
  }
}

Where:
- "segments" is an array of 4-6 segment names (short, 2-3 words each)
- "companySegments" maps company ID to an array of booleans indicating which segments apply

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: `Target Description: ${targetDescription}

Companies:
${companySummaries.map(c => `${c.id}. ${c.name}\n   Business: ${c.business}\n   Location: ${c.location}`).join('\n\n')}

Create MECE segments for these ${targetDescription} companies and mark which segments apply to each.`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    const result = JSON.parse(response.choices[0].message.content);
    console.log(`Generated ${result.segments?.length || 0} MECE segments`);
    return result;
  } catch (e) {
    console.error('MECE segmentation error:', e.message);
    return { segments: [], companySegments: {} };
  }
}

// AI Review Agent: Clean up and remove duplicative/unnecessary information
// Uses Gemini 3 Flash for frontier reasoning - with GPT-4o fallback if Gemini fails
async function reviewAndCleanData(companyData) {
  try {
    console.log('  Step 6: Running AI review agent (Gemini 3 Flash with GPT-4o fallback)...');

    const prompt = `You are a data quality reviewer for M&A company profiles. Review the extracted data and clean it up by:

1. REMOVE DUPLICATIVE ROWS:
   - If "Number of X" appears alongside "Key X names", merge them into one row
   - Example: "Number of Suppliers: 6" + "Key Suppliers: A, B, C" → "Key Suppliers: 6 suppliers including A, B, C"
   - Example: "Number of Customers" + "Key Customers" → merge into "Key Customers"

2. HARD RULE - REMOVE EMPTY/MEANINGLESS METRICS:
   - Remove ANY metric with values like: "No specific X stated", "Not specified", "Not available", "Unknown", "N/A", "None listed"
   - If a metric has NO meaningful data, DELETE IT ENTIRELY. Do not include metrics with placeholder text.
   - Example: {"label": "Key Metrics", "value": "- No specific production capacity stated\\n- No specific factory area stated"} → DELETE THIS ENTIRE METRIC

3. CRITICAL - REMOVE FAKE/PLACEHOLDER DATA:
   - REMOVE any metric containing alphabetical placeholders like "Distributor A", "Partner X", "Supplier B", "Customer 1"
   - Pattern to detect: "[Word] A, [Word] B, [Word] C" or "[Word] X, [Word] Y, [Word] Z" or "[Word] 1, [Word] 2"
   - These are AI hallucinations - DELETE THE ENTIRE ROW if it contains such patterns
   - Example: "Local Distributors: Distributor A, Distributor B, Distributor C" → DELETE ENTIRE ROW
   - Example: "OEM Partners: Partner X, Partner Y, Partner Z" → DELETE ENTIRE ROW

4. REMOVE UNNECESSARY/WORTHLESS ROWS:
   - Remove rows with vague values like "Various", "Multiple", "Several" without specifics
   - Remove rows about awards, achievements, recognitions (not useful for M&A)
   - Remove rows about years of experience (not useful for M&A)
   - Remove rows about operating hours, office hours
   - Remove rows labeled: "Start of Operations", "Market Growth", "Market Outlook", "Future Plans", "Vision", "Mission"

5. HARD RULE - TRANSLATE ALL NON-ENGLISH TEXT TO ENGLISH:
   - ALL product names, company names, and any text in ANY non-English language MUST be translated to English
   - This applies to ALL languages: Vietnamese, Chinese, Thai, Malay, Indonesian, Hindi, Korean, Japanese, Arabic, Spanish, etc.
   - The user CANNOT translate - you MUST translate everything to English
   - Write ALL text using regular English alphabet only (A-Z, no diacritics, no foreign characters)

6. MERGE SIMILAR INFORMATION:
   - "Customers" and "Customer Segments" → merge into one "Key Customers" row
   - "Products" and "Product Categories" → keep only the more detailed one
   - If breakdown_items and key_metrics have overlapping info, keep in key_metrics only

7. CLEAN UP HQ/LOCATION:
   - If location looks like JSON ({"HQ":"..."}), extract the actual location value
   - Format should be: "City, State/Province, Country" or "District, Singapore" for Singapore
   - Remove duplicate city names like "Kuala Lumpur, Kuala Lumpur, Malaysia" → "Kuala Lumpur, Malaysia"
   - Remove duplicate state names like "Bangkok, Bangkok, Thailand" → "Bangkok, Thailand"

8. FORMAT SHORT LISTS INLINE (NO POINT FORM):
   - If a metric has only 2-3 items, write them inline separated by commas, NOT as bullet points
   - Example: Export Countries with 2 items → "Singapore, Sri Lanka" (NOT "- Singapore\\n- Sri Lanka")
   - Example: Geographic Reach with 3 items → "Malaysia, Singapore, Sri Lanka" (NOT bullet points)
   - Only use bullet points (\\n- item) for lists with 4+ items or when items need categorization

Review and clean this company data:

${JSON.stringify(companyData, null, 2)}

OUTPUT JSON with the same structure but cleaned up:
{
  "company_name": "...",
  "established_year": "...",
  "location": "cleaned location",
  "business": "...",
  "message": "...",
  "title": "...",
  "key_metrics": [cleaned array],
  "breakdown_title": "...",
  "breakdown_items": [cleaned array]
}

Return ONLY valid JSON.`;

    // Use Gemini 3 Flash with JSON mode for frontier reasoning
    const result = await callGemini3Flash(prompt, true);

    if (!result) {
      console.log('  AI review agent (both Gemini 3 Flash and GPT-4o) returned empty, keeping original data');
      return companyData;
    }

    // Parse JSON from response
    let cleaned;
    try {
      cleaned = JSON.parse(result);
    } catch (parseError) {
      // Try to extract JSON from response if not pure JSON
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleaned = JSON.parse(jsonMatch[0]);
      } else {
        console.log('  Failed to parse Gemini response, keeping original data');
        return companyData;
      }
    }

    // Merge cleaned data with original (preserve fields not in prompt)
    return {
      ...companyData,
      location: cleaned.location || companyData.location,
      key_metrics: cleaned.key_metrics || companyData.key_metrics,
      breakdown_items: cleaned.breakdown_items || companyData.breakdown_items
    };
  } catch (e) {
    console.error('Review agent error:', e.message);
    return companyData; // Return original data if review fails
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
          <h4 style="margin: 0 0 8px 0;">${i + 1}. ${ensureString(c.title || c.company_name) || 'Unknown'}</h4>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Website:</strong> ${ensureString(c.website)}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Established:</strong> ${ensureString(c.established_year) || '-'}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Location:</strong> ${ensureString(c.location) || '-'}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Business:</strong> ${ensureString(c.business) || '-'}</p>
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
  const { websites, email, targetDescription } = req.body;

  if (!websites || !Array.isArray(websites) || websites.length === 0) {
    return res.status(400).json({ error: 'Please provide an array of website URLs' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Please provide an email address' });
  }

  if (!targetDescription) {
    return res.status(400).json({ error: 'Please provide a target description' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`PROFILE SLIDES REQUEST: ${new Date().toISOString()}`);
  console.log(`Target: ${targetDescription}`);
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
      logMemoryUsage(`start company ${i + 1}`);

      try {
        // Step 1: Scrape website
        console.log('  Step 1: Scraping website...');
        const scraped = await scrapeWebsite(website);

        if (!scraped.success) {
          console.log(`  Failed to scrape: ${scraped.error}`);
          // Mark as inaccessible - will appear on summary slide but not individual profile
          const companyName = extractCompanyNameFromUrl(website);
          results.push({
            website,
            company_name: companyName,
            title: companyName,
            location: '',
            _inaccessible: true,
            _error: `Failed to scrape: ${scraped.error}`
          });
          console.log(`  Marked as inaccessible: ${companyName}`);
          continue;
        }
        console.log(`  Scraped ${scraped.content.length} characters`);
        // Log content preview for debugging (first 500 chars, useful for seeing what was scraped)
        console.log(`  Content preview: ${scraped.content.substring(0, 500).replace(/\n/g, ' ').replace(/\s+/g, ' ')}...`);

        // Step 2: Extract basic info (company name, year, location)
        console.log('  Step 2: Extracting company name, year, location...');
        const basicInfo = await extractBasicInfo(scraped.content, website);
        console.log(`  Company: ${basicInfo.company_name || 'Not found'}`);
        if (basicInfo.location) console.log(`  Location extracted: ${basicInfo.location}`);

        // Step 3: Extract business details
        console.log('  Step 3: Extracting business, message, footnote, title...');
        const businessInfo = await extractBusinessInfo(scraped.content, basicInfo);

        // Step 4: Extract key metrics
        console.log('  Step 4: Extracting key metrics...');
        const metricsInfo = await extractKeyMetrics(scraped.content, {
          company_name: basicInfo.company_name,
          business: businessInfo.business
        });

        // Step 4b: Extract products/applications breakdown for right table
        console.log('  Step 4b: Extracting products/applications breakdown...');
        const productsBreakdown = await extractProductsBreakdown(scraped.content, {
          company_name: basicInfo.company_name,
          business: businessInfo.business
        });

        // Step 5: Search online for missing mandatory info (established_year, location)
        // These are mandatory fields - search online if not found on website
        const missingFields = [];
        if (!basicInfo.established_year) missingFields.push('established_year');
        if (!basicInfo.location) missingFields.push('location');

        let searchedInfo = {};
        if (missingFields.length > 0 && basicInfo.company_name) {
          console.log(`  Step 5: Searching online for missing mandatory info: ${missingFields.join(', ')}...`);
          searchedInfo = await searchMissingInfo(basicInfo.company_name, website, missingFields);
        }

        // Use only key metrics from scraped website (no web search for metrics to prevent hallucination)
        const allKeyMetrics = metricsInfo.key_metrics || [];

        // Combine all extracted data (mandatory fields supplemented by web search)
        // Use ensureString() for all AI-generated fields to prevent [object Object] issues
        let companyData = {
          website: scraped.url,
          company_name: ensureString(basicInfo.company_name),
          established_year: ensureString(basicInfo.established_year || searchedInfo.established_year),
          location: validateAndFixHQFormat(ensureString(basicInfo.location || searchedInfo.location), website),
          business: ensureString(businessInfo.business),
          message: ensureString(businessInfo.message),
          footnote: ensureString(businessInfo.footnote),
          title: ensureString(businessInfo.title),
          key_metrics: allKeyMetrics,  // Only from scraped website
          // Right-side content (varies by business type)
          business_type: productsBreakdown.business_type || 'industrial',
          breakdown_title: ensureString(productsBreakdown.breakdown_title) || 'Products and Applications',
          breakdown_items: productsBreakdown.breakdown_items || [],
          projects: productsBreakdown.projects || [],  // For project-based businesses
          products: productsBreakdown.products || [],  // For consumer-facing businesses
          metrics: ensureString(metricsInfo.metrics)  // Fallback for old format
        };

        // Log metrics count before review
        console.log(`  Metrics extracted before review: ${companyData.key_metrics?.length || 0}`);
        if (companyData.key_metrics?.length > 0) {
          console.log(`  Raw metrics: ${companyData.key_metrics.map(m => m.label).join(', ')}`);
        }

        // Step 6: Run AI review agent to clean up duplicative/unnecessary data
        companyData = await reviewAndCleanData(companyData);

        // Step 7: HARD RULE - Filter out empty/meaningless Key Metrics
        // Remove metrics that say "No specific X stated", "Not specified", etc.
        const metricsBefore = companyData.key_metrics?.length || 0;
        companyData.key_metrics = filterEmptyMetrics(companyData.key_metrics);
        const metricsAfter = companyData.key_metrics?.length || 0;
        if (metricsBefore !== metricsAfter) {
          console.log(`  Step 7: Filtered ${metricsBefore - metricsAfter} empty metrics (${metricsBefore} → ${metricsAfter})`);
        }

        console.log(`  ✓ Completed: ${companyData.title || companyData.company_name} (${companyData.key_metrics?.length || 0} metrics after review)`);
        results.push(companyData);

        // Memory cleanup: Release large objects to prevent OOM on Railway
        // scraped.content can be 1-5MB per website, must release before next iteration
        if (scraped) scraped.content = null;

      } catch (error) {
        console.error(`  Error processing ${website}:`, error.message);
        results.push({
          website,
          error: error.message,
          step: 0
        });
      }

      // Force garbage collection hint between companies (if available)
      // This helps Railway containers stay under memory limits
      if (global.gc) {
        global.gc();
      }
    }

    // Separate successful companies, inaccessible websites, and errors
    const companies = results.filter(r => !r.error && !r._inaccessible);
    const inaccessibleWebsites = results.filter(r => r._inaccessible);
    const errors = results.filter(r => r.error && !r._inaccessible);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`PROFILE SLIDES EXTRACTION COMPLETE`);
    console.log(`Extracted: ${companies.length}/${websites.length} successful`);
    if (inaccessibleWebsites.length > 0) {
      console.log(`Inaccessible (will appear on summary only): ${inaccessibleWebsites.length}`);
    }
    console.log('='.repeat(50));

    // Memory cleanup before PPTX generation (which is memory-intensive)
    // Clear the results array since we only need companies/errors now
    results.length = 0;
    if (global.gc) global.gc();
    logMemoryUsage('before PPTX generation');

    // Generate PPTX using PptxGenJS (with target list slide)
    // Pass inaccessible websites to include on summary slide
    let pptxResult = null;
    if (companies.length > 0 || inaccessibleWebsites.length > 0) {
      pptxResult = await generatePPTX(companies, targetDescription, inaccessibleWebsites);
      logMemoryUsage('after PPTX generation');
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

    // Memory cleanup after email sent
    if (pptxResult) pptxResult.content = null;
    pptxResult = null;

  } catch (error) {
    console.error('Profile slides error:', error);
    try {
      await sendEmail(email, 'Profile Slides - Error', `<p>Error processing your request: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});


// ============ GENERATE PPT ENDPOINT (returns content, no email) ============
// Used by v6 search to generate PPT and attach to its own email
app.post('/api/generate-ppt', async (req, res) => {
  const { websites, targetDescription } = req.body;

  if (!websites || !Array.isArray(websites) || websites.length === 0) {
    return res.status(400).json({ error: 'Please provide an array of website URLs' });
  }

  if (!targetDescription) {
    return res.status(400).json({ error: 'Please provide a target description' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`GENERATE PPT REQUEST: ${new Date().toISOString()}`);
  console.log(`Target: ${targetDescription}`);
  console.log(`Processing ${websites.length} website(s)`);
  console.log('='.repeat(50));

  try {
    const results = [];

    for (let i = 0; i < websites.length; i++) {
      const website = websites[i].trim();
      if (!website) continue;

      console.log(`\n[${i + 1}/${websites.length}] Processing: ${website}`);
      logMemoryUsage(`start company ${i + 1}`);

      try {
        // Step 1: Scrape website
        console.log('  Step 1: Scraping website...');
        const scraped = await scrapeWebsite(website);

        if (!scraped.success) {
          console.log(`  Failed to scrape: ${scraped.error}`);
          // Mark as inaccessible - will appear on summary slide but not individual profile
          const companyName = extractCompanyNameFromUrl(website);
          results.push({
            website,
            company_name: companyName,
            title: companyName,
            location: '',
            _inaccessible: true,
            _error: `Failed to scrape: ${scraped.error}`
          });
          console.log(`  Marked as inaccessible: ${companyName}`);
          continue;
        }
        console.log(`  Scraped ${scraped.content.length} characters`);
        // Log content preview for debugging (first 500 chars, useful for seeing what was scraped)
        console.log(`  Content preview: ${scraped.content.substring(0, 500).replace(/\n/g, ' ').replace(/\s+/g, ' ')}...`);

        // Step 2: Extract basic info
        console.log('  Step 2: Extracting company name, year, location...');
        const basicInfo = await extractBasicInfo(scraped.content, website);
        console.log(`  Company: ${basicInfo.company_name || 'Not found'}`);
        if (basicInfo.location) console.log(`  Location extracted: ${basicInfo.location}`);

        // Step 3: Extract business details
        console.log('  Step 3: Extracting business, message, footnote, title...');
        const businessInfo = await extractBusinessInfo(scraped.content, basicInfo);

        // Step 4: Extract key metrics
        console.log('  Step 4: Extracting key metrics...');
        const metricsInfo = await extractKeyMetrics(scraped.content, {
          company_name: basicInfo.company_name,
          business: businessInfo.business
        });

        // Step 4b: Extract products/applications breakdown
        console.log('  Step 4b: Extracting products/applications breakdown...');
        const productsBreakdown = await extractProductsBreakdown(scraped.content, {
          company_name: basicInfo.company_name,
          business: businessInfo.business
        });

        // Step 5: Search online for missing mandatory info
        const missingFields = [];
        if (!basicInfo.established_year) missingFields.push('established_year');
        if (!basicInfo.location) missingFields.push('location');

        let searchedInfo = {};
        if (missingFields.length > 0 && basicInfo.company_name) {
          console.log(`  Step 5: Searching online for missing info: ${missingFields.join(', ')}...`);
          searchedInfo = await searchMissingInfo(basicInfo.company_name, website, missingFields);
        }

        const allKeyMetrics = metricsInfo.key_metrics || [];

        let companyData = {
          website: scraped.url,
          company_name: ensureString(basicInfo.company_name),
          established_year: ensureString(basicInfo.established_year || searchedInfo.established_year),
          location: validateAndFixHQFormat(ensureString(basicInfo.location || searchedInfo.location), website),
          business: ensureString(businessInfo.business),
          message: ensureString(businessInfo.message),
          footnote: ensureString(businessInfo.footnote),
          title: ensureString(businessInfo.title),
          key_metrics: allKeyMetrics,
          // Right-side content (varies by business type)
          business_type: productsBreakdown.business_type || 'industrial',
          breakdown_title: ensureString(productsBreakdown.breakdown_title) || 'Products and Applications',
          breakdown_items: productsBreakdown.breakdown_items || [],
          projects: productsBreakdown.projects || [],  // For project-based businesses
          products: productsBreakdown.products || [],  // For consumer-facing businesses
          metrics: ensureString(metricsInfo.metrics)
        };

        // Step 6: Review and clean data
        companyData = await reviewAndCleanData(companyData);

        // Step 7: Filter empty metrics
        const metricsBefore = companyData.key_metrics?.length || 0;
        companyData.key_metrics = filterEmptyMetrics(companyData.key_metrics);
        const metricsAfter = companyData.key_metrics?.length || 0;
        if (metricsBefore !== metricsAfter) {
          console.log(`  Step 7: Filtered ${metricsBefore - metricsAfter} empty metrics`);
        }

        console.log(`  ✓ Completed: ${companyData.title || companyData.company_name}`);
        results.push(companyData);

        if (scraped) scraped.content = null;

      } catch (error) {
        console.error(`  Error processing ${website}:`, error.message);
        results.push({
          website,
          error: error.message,
          step: 0
        });
      }

      if (global.gc) global.gc();
    }

    // Separate successful companies, inaccessible websites, and errors
    const companies = results.filter(r => !r.error && !r._inaccessible);
    const inaccessibleWebsites = results.filter(r => r._inaccessible);
    const errors = results.filter(r => r.error && !r._inaccessible);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`EXTRACTION COMPLETE: ${companies.length}/${websites.length} successful`);
    if (inaccessibleWebsites.length > 0) {
      console.log(`Inaccessible (will appear on summary only): ${inaccessibleWebsites.length}`);
    }
    console.log('='.repeat(50));

    results.length = 0;
    if (global.gc) global.gc();

    // Generate PPTX - pass inaccessible websites to include on summary slide
    let pptxResult = null;
    if (companies.length > 0 || inaccessibleWebsites.length > 0) {
      pptxResult = await generatePPTX(companies, targetDescription, inaccessibleWebsites);
    }

    if (pptxResult?.success) {
      console.log('PPT generated successfully');
      return res.json({
        success: true,
        content: pptxResult.content,
        filename: `Profile_Slides_${new Date().toISOString().split('T')[0]}.pptx`,
        companiesProcessed: companies.length,
        errors: errors.length
      });
    } else {
      return res.json({
        success: false,
        error: 'Failed to generate PPT',
        companiesProcessed: companies.length,
        errors: errors.length
      });
    }

  } catch (error) {
    console.error('Generate PPT error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============ HEALTHCHECK ============
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'profile-slides' });
});

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Profile Slides server running on port ${PORT}`);
});
