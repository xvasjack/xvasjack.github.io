require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const XLSX = require('xlsx');
const multer = require('multer');
const { createClient } = require('@deepgram/sdk');
const { S3Client } = require('@aws-sdk/client-s3');
const Anthropic = require('@anthropic-ai/sdk');
const JSZip = require('jszip');
const { generateDocx, htmlToStructuredJson } = require('./docx-generator');
const { securityHeaders, rateLimiter, escapeHtml } = require('./shared/security');
const { requestLogger, healthCheck } = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { sendEmail } = require('./shared/email');

// Setup global error handlers to prevent crashes
setupGlobalErrorHandlers();

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
const _upload = multer({
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
if (!process.env.KIMI_API_KEY) {
  console.warn('KIMI_API_KEY not set - DD deep analysis will use Gemini 2.5 Pro instead');
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

// ============ REPORT STORAGE (for automated testing) ============
// In-memory store with 20-report limit to manage Railway's 450MB memory
const reportStore = new Map();
const REPORT_STORE_LIMIT = 20;

function cleanupOldReports() {
  if (reportStore.size > REPORT_STORE_LIMIT) {
    // Get entries sorted by createdAt (oldest first)
    const entries = Array.from(reportStore.entries()).sort(
      (a, b) => new Date(a[1].createdAt) - new Date(b[1].createdAt)
    );

    // Remove oldest entries until we're under the limit
    const toRemove = entries.slice(0, reportStore.size - REPORT_STORE_LIMIT);
    for (const [id] of toRemove) {
      reportStore.delete(id);
      console.log(`[DD] Cleaned up old report: ${id}`);
    }
  }
}

if (!r2Client) {
  console.warn(
    'R2 not configured - recordings will only be stored in memory. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME'
  );
}

// ============ DD REPORT V4 COMPONENTS ============
// Report component configurations matching DD Report v4 template structure
const _DD_COMPONENTS = {
  overview: {
    title: '1.0 Overview',
    analysisPrompt: `Extract comprehensive company information:
1.1 Company Background:
- Company name, headquarters location, founding year
- Brief history and key milestones
- Ownership structure (private/public, key shareholders)
- Current leadership team

1.2 Company Capabilities:
- Core service offerings (list all with descriptions)
- Industry certifications and accreditations
- Customer base size and satisfaction metrics
- Geographic coverage and operational locations
- Technology platforms and partnerships
- Key differentiators and unique capabilities

Include specific numbers, percentages, and facts from the source materials.`,
  },
  market_competition: {
    title: '2.0 Market & Competition',
    analysisPrompt: `Extract market and competitive information:
2.1 Competition Landscape:
Create a competition matrix table with these columns:
- Service Segment (e.g., Managed Security, Cloud Infrastructure)
- Market Growth (CAGR %)
- Demand Drivers (key factors driving growth)
- Market Competition (competitive intensity: High/Medium/Low)
- Company's Position (Strong/Growing/Emerging)

2.2 Competitive Advantages:
- List 3-5 key competitive advantages
- Include specific evidence for each (certifications, partnerships, metrics)

2.3 Vulnerabilities:
- Identify weaknesses and areas of exposure
- Market risks and competitive threats
- Dependencies and concentration risks

Include market growth rates, specific competitor names, and positioning data.`,
  },
  financials: {
    title: '4.0 Key Financials',
    analysisPrompt: `Extract ALL financial data and format as structured tables:

4.1 Income Statement:
Table with columns: Item | Year 1 | Year 2 | Year 3
Rows: Revenue, Cost of Sales, Gross Profit, Operating Expenses, EBITDA, Net Profit
Include gross margin % and EBITDA margin %

4.2 Revenue Breakdown by Country:
Table with columns: Country | Revenue (currency) | % of Total
List all countries/regions mentioned

4.3 Revenue Breakdown by Product/Service:
Table with columns: Product/Service Type | Revenue | % of Total
Categories may include: Managed Services, Professional Services, Hardware/Software Resale, Subscriptions, etc.

4.4 Revenue for Key Service Lines:
Break down major service categories further if data available
E.g., Managed Services split by: Security, Infrastructure, Helpdesk, etc.

4.5 Top Customers:
Table with columns: Customer (name or anonymized) | Revenue | % of Total
Include customer concentration analysis

4.8 Balance Sheet:
Table with columns: Item | Current Year | Prior Year
Rows: Total Assets, Total Liabilities, Shareholders' Equity, Cash, Receivables, Payables

Include specific currency figures (SGD/USD/etc.), percentages, and year labels. Extract all available financial metrics.`,
  },
  future_plans: {
    title: '8.0 Future Plans',
    analysisPrompt: `Extract strategic plans and projections:

Strategic Initiatives:
- Expansion plans (geographic, product, market)
- Technology investments and roadmap
- Partnership and M&A strategy
- Operational improvements planned

5-Year Growth Projection Table:
Table with columns: Metric | Year 1 | Year 2 | Year 3 | Year 4 | Year 5
Rows: Revenue, Revenue Growth %, Gross Profit, Gross Margin %, EBITDA, EBITDA Margin %, Headcount

Include specific targets, timelines, and financial projections. Note any assumptions or dependencies.`,
  },
  workplan: {
    title: '4.9 Pre-DD Workplan',
    analysisPrompt: `Extract items requiring validation in due diligence:

Create a Pre-DD Workplan table with two columns:
- Key Consideration: Area to investigate
- Evidence to Validate: Specific documents/data to request

Key areas to cover:
1. Customer Analysis - Validate top customer contracts, terms, renewal rates
2. Pipeline Analysis - Assess sales pipeline quality and conversion rates
3. Pricing Analysis - Review pricing models, competitiveness, margin protection
4. Unit Economics - Understand cost structure, contribution margins by service
5. Billing & Collections - Review AR aging, collection history, bad debt
6. Forecast Assumptions - Test revenue projection methodology and accuracy
7. Partner Ecosystem - Evaluate vendor relationships and dependencies
8. Employee Analysis - Review retention, compensation, key person risk
9. Technology & IP - Assess proprietary technology, security posture
10. Legal & Compliance - Review contracts, litigation, regulatory status

Format as actionable checklist for due diligence team.`,
  },
};

// Content limit for chunking large files
const DD_CONTENT_LIMIT = 400000;

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
async function callGemini2Pro(prompt, jsonMode = false) {
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

// Kimi 128k (Moonshot) - Best for large context DD analysis
async function callKimi128k(prompt, maxTokens = 16000) {
  if (!process.env.KIMI_API_KEY) {
    console.log('[DD] KIMI_API_KEY not set, skipping Kimi');
    return '';
  }
  try {
    const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.KIMI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'moonshot-v1-128k',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.1,
      }),
      timeout: 300000, // 5 min timeout for large context
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[DD] Kimi HTTP error ${response.status}:`, errorText.substring(0, 200));
      return '';
    }

    const data = await response.json();
    if (data.error) {
      console.error('[DD] Kimi API error:', data.error.message || data.error);
      return '';
    }

    const result = data.choices?.[0]?.message?.content || '';
    console.log(`[DD] Kimi 128k returned ${result.length} chars`);
    return result;
  } catch (error) {
    console.error('[DD] Kimi error:', error.message);
    return '';
  }
}

// Summarize file content if too large (for chunking)
async function summarizeFileContent(fileName, content, targetLength) {
  if (content.length <= targetLength) {
    return content;
  }

  console.log(`[DD] Summarizing ${fileName} from ${content.length} to ~${targetLength} chars`);

  const prompt = `Summarize this document content, preserving ALL key facts, numbers, names, and data points.
Keep financial figures, dates, percentages, company names, and specific details.
Target length: ~${targetLength} characters.

DOCUMENT: ${fileName}
CONTENT:
${content.substring(0, 100000)}

Provide a comprehensive summary preserving all important data:`;

  try {
    const summary = await callGemini2Pro(prompt);
    if (summary && summary.length > 100) {
      console.log(`[DD] Summarized ${fileName}: ${content.length} -> ${summary.length} chars`);
      return summary;
    }
  } catch (e) {
    console.error(`[DD] Summary failed for ${fileName}:`, e.message);
  }

  // Fallback: truncate with notice
  return `[TRUNCATED - original was ${content.length} chars]\n${content.substring(0, targetLength)}`;
}

// Detect domain/context from text for domain-aware translation
function _detectMeetingDomain(text) {
  const domains = {
    financial:
      /\b(revenue|EBITDA|valuation|M&A|merger|acquisition|IPO|equity|debt|ROI|P&L|balance sheet|cash flow|投資|収益|利益|財務)\b/i,
    legal:
      /\b(contract|agreement|liability|compliance|litigation|IP|intellectual property|NDA|terms|clause|legal|lawyer|attorney|契約|法的|弁護士)\b/i,
    medical:
      /\b(clinical|trial|FDA|patient|therapeutic|drug|pharmaceutical|biotech|efficacy|dosage|治療|患者|医療|臨床)\b/i,
    technical:
      /\b(API|architecture|infrastructure|database|server|cloud|deployment|code|software|engineering|システム|開発|技術)\b/i,
    hr: /\b(employee|hiring|compensation|benefits|performance|talent|HR|recruitment|人事|採用|給与)\b/i,
  };

  for (const [domain, pattern] of Object.entries(domains)) {
    if (pattern.test(text)) {
      return domain;
    }
  }
  return 'general';
}

// Get domain-specific translation instructions
function _getDomainInstructions(domain) {
  const instructions = {
    financial:
      'This is a financial/investment due diligence meeting. Preserve financial terms like M&A, EBITDA, ROI, P&L accurately. Use standard financial terminology.',
    legal:
      'This is a legal due diligence meeting. Preserve legal terms and contract language precisely. Maintain formal legal register.',
    medical:
      'This is a medical/pharmaceutical due diligence meeting. Preserve medical terminology, drug names, and clinical terms accurately.',
    technical:
      'This is a technical due diligence meeting. Preserve technical terms, acronyms, and engineering terminology accurately.',
    hr: 'This is an HR/talent due diligence meeting. Preserve HR terminology and employment-related terms accurately.',
    general:
      'This is a business due diligence meeting. Preserve business terminology and professional tone.',
  };
  return instructions[domain] || instructions.general;
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
            // eslint-disable-next-line no-unused-vars
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

// ============ DD V5: INTELLIGENT MULTI-PHASE PIPELINE ============

// Phase 2: Analyze documents to identify company and data categories
async function analyzeDocumentStructure(combinedContent, filesSummary) {
  console.log('[DD] Phase 2: Analyzing document structure...');

  const analysisPrompt = `You are an M&A analyst. Analyze these source documents and identify:

1. TARGET COMPANY: What company is this DD about? Extract:
   - Company name
   - Country/HQ location
   - Industry/sector
   - Is it publicly listed? (stock exchange, ticker if known)

2. DATA CATEGORIES FOUND: List ALL data categories present in the documents:
   - Company background/history
   - Products/services offered
   - Market overview
   - Competition analysis
   - Revenue data (and any breakdowns: by country, product, customer, etc.)
   - Financial statements (P&L, balance sheet, cash flow)
   - Customer information (top customers, concentration)
   - Employee/headcount data
   - Management/leadership info
   - Growth projections/forecasts
   - Risks and challenges
   - Any other significant data categories

3. TABLES IDENTIFIED: List any tables or structured data found

SOURCE DOCUMENTS:
${filesSummary.join('\n')}

CONTENT:
${combinedContent.substring(0, 100000)}

Return JSON format:
{
  "company": {
    "name": "...",
    "hq": "City, Country",
    "industry": "...",
    "isListed": true/false,
    "stockExchange": "SGX/NYSE/etc or null",
    "ticker": "ABC or null"
  },
  "dataCategories": [
    {"category": "company_background", "found": true, "details": "Founding year, history available"},
    {"category": "revenue_by_country", "found": true, "details": "SG, MY, PH breakdown available"},
    {"category": "top_customers", "found": true, "details": "Top 5 customers with revenue %"},
    ...
  ],
  "tablesFound": [
    {"name": "Income Statement", "years": ["2022", "2023", "2024"]},
    {"name": "Revenue by Country", "columns": ["Country", "Revenue", "%"]}
  ]
}`;

  let result = null;

  // Try Gemini 2.5 Pro for analysis (good at structured extraction)
  const response = await callGemini2Pro(analysisPrompt, true);
  if (response) {
    try {
      result = JSON.parse(response);
    } catch (e) {
      console.error('[DD] Failed to parse structure analysis:', e.message);
    }
  }

  // Fallback to GPT-4o
  if (!result) {
    try {
      const gptResponse = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: analysisPrompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      });
      result = JSON.parse(gptResponse.choices?.[0]?.message?.content || '{}');
    } catch (e) {
      console.error('[DD] GPT-4o structure analysis failed:', e.message);
    }
  }

  if (result?.company?.name) {
    console.log(`[DD] Company identified: ${result.company.name}`);
    console.log(
      `[DD] Data categories found: ${result.dataCategories?.filter((d) => d.found).length || 0}`
    );
    console.log(`[DD] Tables found: ${result.tablesFound?.length || 0}`);
  }

  return result || { company: {}, dataCategories: [], tablesFound: [] };
}

// Phase 3: Online research for company (official sources only)
async function searchCompanyOnline(companyInfo) {
  console.log('[DD] Phase 3: Online research...');

  if (!companyInfo?.name) {
    console.log('[DD] No company name, skipping online research');
    return { verified: [], unverified: [] };
  }

  const companyName = companyInfo.name;
  const isListed = companyInfo.isListed;
  const stockExchange = companyInfo.stockExchange;

  console.log(
    `[DD] Searching for: ${companyName} (Listed: ${isListed ? 'Yes - ' + stockExchange : 'No'})`
  );

  const searchResults = [];

  // Search 1: Company official info
  const searchPrompt1 = `Search for official information about "${companyName}" company:
- Official company website
- Company registration details
- Official annual reports
- Official press releases
${isListed ? `- Stock exchange filings (${stockExchange})` : ''}

Find ONLY from official sources:
- Company's own website
- Government registries (ACRA, SEC, etc.)
- Stock exchange official filings
- Official press releases from company

Return JSON:
{
  "officialWebsite": "https://...",
  "sources": [
    {"type": "annual_report", "url": "...", "year": "2024", "isOfficial": true},
    {"type": "company_website", "url": "...", "content": "About page content...", "isOfficial": true}
  ]
}`;

  // Use Perplexity for web search (has real-time search)
  try {
    const searchResponse = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{ role: 'user', content: searchPrompt1 }],
      }),
      timeout: 60000,
    });

    if (searchResponse.ok) {
      const data = await searchResponse.json();
      const content = data.choices?.[0]?.message?.content || '';
      searchResults.push({ query: 'official_info', result: content });
      console.log(`[DD] Official info search completed`);
    }
  } catch (e) {
    console.error('[DD] Perplexity search error:', e.message);
  }

  // Search 2: For listed companies - get financial filings
  if (isListed && stockExchange) {
    const filingPrompt = `Find the latest official financial filings for "${companyName}" listed on ${stockExchange}:
- Latest annual report (audited)
- Latest quarterly results
- Any recent announcements

ONLY include information from:
- Official stock exchange filings
- Company's investor relations page
- Audited financial statements

Return key financial data found (revenue, profit, assets) with the SOURCE URL for each.`;

    try {
      const filingResponse = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [{ role: 'user', content: filingPrompt }],
        }),
        timeout: 60000,
      });

      if (filingResponse.ok) {
        const data = await filingResponse.json();
        const content = data.choices?.[0]?.message?.content || '';
        searchResults.push({ query: 'financial_filings', result: content });
        console.log(`[DD] Financial filings search completed`);
      }
    } catch (e) {
      console.error('[DD] Financial filings search error:', e.message);
    }
  }

  // Search 3: Management and leadership
  const mgmtPrompt = `Find official management/leadership information for "${companyName}":
- CEO, CFO, key executives
- Board of directors
- Management backgrounds

ONLY from official sources:
- Company's official website (About/Team page)
- Official annual reports
- LinkedIn official company page
- Stock exchange filings (for listed companies)

Return names and titles found, with source URL.`;

  try {
    const mgmtResponse = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{ role: 'user', content: mgmtPrompt }],
      }),
      timeout: 60000,
    });

    if (mgmtResponse.ok) {
      const data = await mgmtResponse.json();
      const content = data.choices?.[0]?.message?.content || '';
      searchResults.push({ query: 'management', result: content });
      console.log(`[DD] Management search completed`);
    }
  } catch (e) {
    console.error('[DD] Management search error:', e.message);
  }

  console.log(`[DD] Phase 3 Complete: ${searchResults.length} search queries executed`);

  return { searchResults, companyName };
}

// Phase 3.5: Verify online information against official sources
async function verifyOnlineInfo(searchResults, combinedContent) {
  console.log('[DD] Phase 3.5: Verifying online information...');

  if (!searchResults?.searchResults?.length) {
    console.log('[DD] No online results to verify');
    return { verifiedInfo: '', verificationNotes: [] };
  }

  const allSearchContent = searchResults.searchResults.map((s) => s.result).join('\n\n');

  const verifyPrompt = `You are a fact-checker for M&A due diligence. Your job is to verify online information.

ONLINE SEARCH RESULTS:
${allSearchContent}

SOURCE DOCUMENTS (user-provided, considered authoritative):
${combinedContent.substring(0, 50000)}

VERIFICATION RULES:
1. ONLY include information that meets ONE of these criteria:
   - Comes from company's official website
   - Comes from official stock exchange filings (SGX, SEC, etc.)
   - Comes from audited annual reports
   - Matches data in the source documents (cross-verified)
   - Comes from government registries (ACRA, SEC, etc.)

2. REJECT information from:
   - News articles (unless quoting official sources)
   - Wikipedia
   - Third-party databases
   - Social media
   - Unverified sources

3. For each piece of information, note the official source

OUTPUT FORMAT:
Return ONLY verified information as structured text:

VERIFIED COMPANY INFORMATION:
[Only include facts that pass verification]

VERIFICATION NOTES:
- [List what was verified and from which official source]
- [List what was rejected and why]`;

  let verifiedInfo = '';
  let verificationNotes = [];

  try {
    const verifyResponse = await callGemini2Pro(verifyPrompt);
    if (verifyResponse) {
      verifiedInfo = verifyResponse;

      // Extract verification notes
      const notesMatch = verifyResponse.match(/VERIFICATION NOTES:([\s\S]*?)$/i);
      if (notesMatch) {
        verificationNotes = notesMatch[1]
          .split('\n')
          .filter((l) => l.trim().startsWith('-'))
          .map((l) => l.trim());
      }

      console.log(`[DD] Verification complete: ${verificationNotes.length} notes`);
    }
  } catch (e) {
    console.error('[DD] Verification error:', e.message);
  }

  return { verifiedInfo, verificationNotes };
}

// ============ DUE DILIGENCE REPORT GENERATOR (DD Report v5 - 5-Phase Pipeline) ============

async function generateDueDiligenceReport(
  files,
  instructions,
  reportLength,
  _components = ['overview', 'market_competition', 'financials', 'future_plans', 'workplan']
) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[DD] INTELLIGENT DD REPORT GENERATION (v5)`);
  console.log(`[DD] Processing ${files.length} source files...`);
  console.log('='.repeat(60));

  // ========== PHASE 1: EXTRACT ALL CONTENT ==========
  console.log('\n[DD] === PHASE 1: CONTENT EXTRACTION ===');

  const filesSummary = [];
  const extractedFiles = [];

  for (const file of files) {
    console.log(
      `[DD] Extracting: ${file.name} (${file.type}) - ${file.content?.length || 0} chars raw`
    );
    filesSummary.push(`- ${file.name} (${file.type.toUpperCase()})`);

    let extractedContent = '';

    // Handle base64 encoded files (binary formats)
    if (file.content && file.content.startsWith('[BASE64:')) {
      const base64Match = file.content.match(/\[BASE64:(\w+)\](.+)/s);
      if (base64Match) {
        const ext = base64Match[1].toLowerCase();
        const base64Data = base64Match[2];

        try {
          if (ext === 'docx' || ext === 'doc') {
            extractedContent = await extractDocxText(base64Data);
          } else if (ext === 'pptx' || ext === 'ppt') {
            extractedContent = await extractPptxText(base64Data);
          } else if (ext === 'xlsx' || ext === 'xls') {
            extractedContent = await extractXlsxText(base64Data);
          } else {
            extractedContent = `[Binary file type .${ext} - cannot extract text]`;
          }
          console.log(`[DD]   -> Extracted ${extractedContent.length} chars from ${file.name}`);
        } catch (extractError) {
          console.error(`[DD]   -> Extraction error for ${file.name}:`, extractError.message);
          extractedContent = `[Error extracting ${file.name}: ${extractError.message}]`;
        }
      }
    } else if (file.content) {
      extractedContent = file.content;
    }

    if (extractedContent && extractedContent.length > 0) {
      extractedFiles.push({ name: file.name, content: extractedContent });
    }
  }

  // Calculate total content size
  const totalChars = extractedFiles.reduce((sum, f) => sum + f.content.length, 0);
  console.log(`[DD] Phase 1 Raw: ${extractedFiles.length} files, ${totalChars} total chars`);

  // ========== PHASE 1.5: CHUNKING (if content too large) ==========
  let combinedContent = '';

  if (totalChars > DD_CONTENT_LIMIT) {
    console.log(`\n[DD] === PHASE 1.5: CHUNKING (content exceeds ${DD_CONTENT_LIMIT} chars) ===`);

    // Summarize each file to fit within limits
    const targetPerFile = Math.floor(DD_CONTENT_LIMIT / extractedFiles.length);

    for (const file of extractedFiles) {
      const processedContent = await summarizeFileContent(file.name, file.content, targetPerFile);
      combinedContent += `\n\n${'='.repeat(50)}\nSOURCE FILE: ${file.name}\n${'='.repeat(50)}\n${processedContent}\n`;
    }

    console.log(`[DD] After chunking: ${combinedContent.length} chars (was ${totalChars})`);
  } else {
    // No chunking needed - use full content
    for (const file of extractedFiles) {
      combinedContent += `\n\n${'='.repeat(50)}\nSOURCE FILE: ${file.name}\n${'='.repeat(50)}\n${file.content}\n`;
    }
  }

  console.log(
    `[DD] Phase 1 Complete: ${extractedFiles.length} files, ${combinedContent.length} chars for analysis`
  );

  // ========== PHASE 2: DOCUMENT STRUCTURE ANALYSIS ==========
  const docStructure = await analyzeDocumentStructure(combinedContent, filesSummary);
  const companyInfo = docStructure.company || {};
  const dataCategories = docStructure.dataCategories || [];
  const foundCategories = dataCategories.filter((d) => d.found);

  console.log(`[DD] Phase 2 Complete: ${foundCategories.length} data categories identified`);

  // ========== PHASE 3: ONLINE RESEARCH ==========
  const onlineResults = await searchCompanyOnline(companyInfo);

  // ========== PHASE 3.5: VERIFY ONLINE INFORMATION ==========
  const { verifiedInfo } = await verifyOnlineInfo(onlineResults, combinedContent);

  // ========== PHASE 4: DEEP ANALYSIS WITH COMBINED DATA ==========
  console.log('\n[DD] === PHASE 4: DEEP ANALYSIS ===');

  // Build dynamic section list based on found data categories
  const sectionMapping = {
    company_background: '1.1 Company Background',
    company_capabilities: '1.2 Company Capabilities',
    products_services: '1.3 Products & Services',
    market_overview: '2.1 Market Overview',
    competition_analysis: '2.2 Competition Analysis',
    competitive_advantages: '2.3 Competitive Advantages',
    vulnerabilities: '2.4 Vulnerabilities',
    key_metrics: '3.0 Key Metrics',
    income_statement: '4.1 Income Statement',
    revenue_by_country: '4.2 Revenue Breakdown by Country',
    revenue_by_product: '4.3 Revenue Breakdown by Product/Service',
    revenue_by_service: '4.4 Revenue Breakdown by Service Line',
    top_customers: '4.5 Top Customers',
    balance_sheet: '4.6 Balance Sheet',
    cash_flow: '4.7 Cash Flow',
    employee_data: '5.0 Employee & Organization',
    management_info: '5.1 Management Team',
    growth_projections: '6.0 Growth Projections',
    future_plans: '7.0 Future Plans & Strategy',
    risks_challenges: '8.0 Risks & Challenges',
    workplan: '9.0 Pre-DD Workplan',
  };

  // Determine which sections to generate based on found data
  const sectionsToGenerate = foundCategories
    .map((c) => sectionMapping[c.category] || c.category)
    .filter((s) => s);

  // Add standard sections that should always appear if relevant data exists
  const _standardFlow = [
    'Company Overview',
    'Market',
    'Competition',
    'Key Metrics',
    'Key Financials',
    'Pre-DD Workplan',
  ];

  console.log(`[DD] Sections to generate: ${sectionsToGenerate.length}`);

  const analysisPrompt = `You are an M&A analyst conducting due diligence on ${companyInfo.name || 'a target company'}.

COMPANY IDENTIFIED: ${companyInfo.name || 'Unknown'}
HQ: ${companyInfo.hq || 'Unknown'}
INDUSTRY: ${companyInfo.industry || 'Unknown'}
LISTED: ${companyInfo.isListed ? `Yes (${companyInfo.stockExchange})` : 'No/Unknown'}

DATA CATEGORIES FOUND IN SOURCE DOCUMENTS:
${foundCategories.map((c) => `- ${c.category}: ${c.details}`).join('\n')}

SOURCE DOCUMENTS (${extractedFiles.length} files):
${filesSummary.join('\n')}

${verifiedInfo ? `\nVERIFIED ONLINE INFORMATION:\n${verifiedInfo}\n` : ''}

${instructions ? `USER'S ADDITIONAL CONTEXT:\n${instructions}\n` : ''}

=== SOURCE CONTENT ===
${combinedContent}
=== END SOURCE CONTENT ===

EXTRACTION INSTRUCTIONS:
1. Extract ALL information for each data category found above
2. For each category, extract:
   - Specific numbers, percentages, dates
   - Names of people, companies, products
   - Tables and structured data
3. If online verified info adds to source docs, include it (mark as [Verified Online])
4. Do NOT include information for categories not found in source documents
5. Preserve exact figures - do not round or estimate

OUTPUT: Structured extraction organized by data category.`;

  let deepAnalysis = '';

  // Try Kimi 128k first (best context window for large content)
  if (process.env.KIMI_API_KEY) {
    console.log('[DD] Using Kimi 128k for deep analysis...');
    deepAnalysis = await callKimi128k(analysisPrompt, 16000);
  }

  // Fallback to Gemini 2.5 Pro if Kimi unavailable
  if (!deepAnalysis) {
    console.log('[DD] Using Gemini 2.5 Pro for analysis...');
    deepAnalysis = await callGemini2Pro(analysisPrompt);
  }

  // Final fallback to GPT-4o
  if (!deepAnalysis) {
    console.log('[DD] Using GPT-4o for analysis...');
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: analysisPrompt }],
      temperature: 0.1,
      max_tokens: 16000,
    });
    deepAnalysis = response.choices?.[0]?.message?.content || '';
  }

  console.log(`[DD] Phase 4 Complete: Analysis ${deepAnalysis.length} chars`);

  // ========== PHASE 5: DYNAMIC REPORT GENERATION ==========
  console.log('\n[DD] === PHASE 5: REPORT GENERATION ===');

  const reportLengthGuide = {
    short: `Keep it concise: 1-2 pages, focus on key points only`,
    medium: `Standard length: 3-5 pages with proper sections`,
    long: `Comprehensive: detailed coverage of all topics with subsections`,
  };

  const reportPrompt = `You are a professional M&A report writer creating a Due Diligence Report for ${companyInfo.name || 'the target company'}.

=== ANALYSIS DATA ===
${deepAnalysis}
=== END ANALYSIS ===

DATA CATEGORIES AVAILABLE:
${foundCategories.map((c) => `- ${c.category}`).join('\n')}

${instructions ? `USER'S REQUIREMENTS:\n${instructions}\n` : ''}

REPORT STRUCTURE GUIDELINES:
Follow this general flow (but ONLY include sections where data exists):
1. Company Overview (background, capabilities, services)
2. Market Analysis (market size, trends, drivers)
3. Competition (landscape, advantages, vulnerabilities)
4. Key Metrics (operational KPIs)
5. Key Financials (P&L, balance sheet, revenue breakdowns, customers)
6. Future Plans & Strategy
7. Risks & Challenges (if data available)
8. Pre-DD Workplan (next steps for due diligence)

CRITICAL RULES:
1. ONLY generate sections for data categories that exist in the analysis
2. If no data exists for a section, DO NOT include that section (skip it entirely)
3. For each data breakdown found (by country, by product, by customer), create a subsection
4. Use appropriate numbered headers (1.0, 1.1, 2.0, etc.)
5. Every financial breakdown MUST have a table
6. No hallucination - only facts from the analysis

LENGTH: ${reportLengthGuide[reportLength] || reportLengthGuide.medium}

OUTPUT FORMAT - STRUCTURED JSON:
You MUST output valid JSON in this exact format:
{
  "sections": [
    { "type": "title", "text": "Due Diligence Report: ${companyInfo.name || '[Company Name]'}" },
    { "type": "date", "text": "Prepared: ${new Date().toLocaleDateString()}" },
    { "type": "heading1", "text": "1.0 Section Title" },
    { "type": "heading2", "text": "1.1 Subsection Title" },
    { "type": "paragraph", "text": "Body text content..." },
    { "type": "bullet_list", "items": ["Item 1", "Item 2", "Item 3"] },
    { "type": "table", "data": { "headers": ["Column 1", "Column 2"], "rows": [["A", "B"], ["C", "D"]] } }
  ]
}

SECTION TYPES:
- title: Main report title
- date: Report date
- heading1: Major section (1.0, 2.0, etc.)
- heading2: Subsection (1.1, 1.2, etc.)
- heading3: Sub-subsection
- paragraph: Body text
- bullet_list: Array of bullet points
- table: Structured table with headers and rows arrays

TABLE FORMAT: For every multi-column data (financials, comparisons, breakdowns), use table type:
{ "type": "table", "data": { "headers": ["Year", "Revenue", "Growth"], "rows": [["2023", "10M", "15%"], ["2024", "12M", "20%"]] } }

CRITICAL: Output ONLY valid JSON. No markdown, no code blocks, no explanations. Professional M&A tone.`;

  // Add JSON mode instruction
  const fullReportPrompt =
    reportPrompt + '\n\nRespond with ONLY the JSON object, starting with { and ending with }.';

  let rawResponse = '';

  // Use Gemini 2.5 Pro for final report writing (with JSON mode)
  console.log('[DD] Generating structured JSON report with Gemini 2.5 Pro...');
  rawResponse = await callGemini2Pro(fullReportPrompt, true); // JSON mode

  if (!rawResponse) {
    console.log('[DD] Gemini failed, using GPT-4o for report...');
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: fullReportPrompt }],
      temperature: 0.2,
      max_tokens: 16000,
      response_format: { type: 'json_object' },
    });
    rawResponse = response.choices?.[0]?.message?.content || '';
  }

  // Clean up and parse JSON
  rawResponse = rawResponse
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  let reportJson;
  try {
    // Try to parse as JSON
    reportJson = JSON.parse(rawResponse);
    console.log(`[DD] Parsed JSON report with ${reportJson.sections?.length || 0} sections`);
  } catch (parseError) {
    console.warn('[DD] Failed to parse JSON, converting HTML to structured format...');
    // Fallback: treat as HTML and convert
    reportJson = htmlToStructuredJson(rawResponse, companyInfo.name || 'Company');
  }

  // Validate structure
  if (!reportJson.sections || !Array.isArray(reportJson.sections)) {
    reportJson = { sections: [] };
  }

  console.log(`[DD] Phase 5 Complete: Report has ${reportJson.sections.length} sections`);
  console.log(`[DD] === MULTI-AGENT DD REPORT COMPLETE ===\n`);

  return reportJson;
}

// ============ DUE DILIGENCE API ENDPOINT ============
app.post('/api/due-diligence', async (req, res) => {
  const {
    files = [],
    email,
    instructions = '',
    reportLength = 'medium',
    components = ['overview', 'market_competition', 'financials', 'future_plans', 'workplan'],
  } = req.body;

  // Generate unique report ID for tracking
  const reportId = `dd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  console.log(`\n[DD] === NEW DD REQUEST ===`);
  console.log(`[DD] Report ID: ${reportId}`);
  console.log(`[DD] Email: ${email}`);
  console.log(`[DD] Files: ${files.length}`);
  console.log(`[DD] Components: ${components.join(', ')}`);
  console.log(`[DD] Length: ${reportLength}`);

  // Validate input
  if (!email) {
    return res.status(400).json({ success: false, error: 'Email is required' });
  }

  if (files.length === 0) {
    return res.status(400).json({ success: false, error: 'At least one file is required' });
  }

  // Initialize report in store (status: processing)
  reportStore.set(reportId, {
    status: 'processing',
    files: files.map((f) => f.name),
    components: components,
    email: email,
    createdAt: new Date().toISOString(),
  });
  cleanupOldReports();

  // Respond immediately with reportId - process async
  res.json({
    success: true,
    reportId: reportId,
    message: `Processing ${files.length} files. DD report will be emailed to ${email}`,
  });

  // Process in background
  try {
    const reportJson = await generateDueDiligenceReport(
      files,
      instructions,
      reportLength,
      components
    );

    // Generate DOCX from structured JSON
    console.log(`[DD] Generating DOCX for report ${reportId}...`);
    const docxBuffer = await generateDocx(reportJson);
    console.log(`[DD] DOCX generated: ${docxBuffer.length} bytes`);

    // Extract company name from report for filename
    const titleSection = reportJson.sections?.find((s) => s.type === 'title');
    const companyName = titleSection?.text?.replace('Due Diligence Report: ', '') || 'Company';
    const safeCompanyName = companyName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
    const filename = `DD_Report_${safeCompanyName}_${Date.now()}.docx`;

    // Build email HTML (simple notification)
    const emailHtml = `
      <div style="font-family: Calibri, Arial, sans-serif; max-width: 800px; margin: 0 auto;">
        <h2 style="color: #365F91; border-bottom: 2px solid #4F81BD; padding-bottom: 10px;">Due Diligence Report</h2>
        <p style="color: #666;">Generated: ${new Date().toLocaleString()}</p>
        <p style="color: #666;">Files analyzed: ${files.map((f) => f.name).join(', ')}</p>
        <p style="color: #666;">Components: ${components.join(', ')}</p>
        <hr style="border: 1px solid #eee; margin: 20px 0;">
        <p style="font-size: 14px;"><strong>Your DD Report is attached as a Word document (DOCX).</strong></p>
        <p style="color: #666;">Open the attached file in Microsoft Word or Google Docs to view the full report.</p>
        <hr style="border: 1px solid #eee; margin: 20px 0;">
        <p style="color: #999; font-size: 12px;">Generated by YCP Due Diligence Tool</p>
      </div>
    `;

    // Update report store with completed report (store both JSON and DOCX buffer)
    reportStore.set(reportId, {
      status: 'completed',
      reportJson: reportJson,
      docxBuffer: docxBuffer,
      filename: filename,
      files: files.map((f) => f.name),
      components: components,
      email: email,
      createdAt: reportStore.get(reportId)?.createdAt || new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    console.log(
      `[DD] Report ${reportId} saved to store (${reportJson.sections?.length} sections, ${docxBuffer.length} bytes DOCX)`
    );

    // Send email with DOCX attachment
    await sendEmail({
      to: email,
      subject: `DD Report: ${files[0]?.name || 'Due Diligence Analysis'}`,
      html: emailHtml,
      attachments: [
        {
          filename: filename,
          content: docxBuffer.toString('base64'),
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ],
      fromName: 'YCP Due Diligence',
    });

    console.log(`[DD] Email sent successfully to ${email}`);
  } catch (error) {
    console.error('[DD] Error processing DD request:', error.message);
    console.error('[DD] Stack:', error.stack);

    // Update report store with error status
    reportStore.set(reportId, {
      status: 'error',
      error: error.message,
      files: files.map((f) => f.name),
      components: components,
      email: email,
      createdAt: reportStore.get(reportId)?.createdAt || new Date().toISOString(),
      errorAt: new Date().toISOString(),
    });

    // Send error notification
    try {
      await sendEmail({
        to: email,
        subject: 'DD Report Error',
        html: `
          <h2>Due Diligence Report Generation Failed</h2>
          <p>We encountered an error while processing your files:</p>
          <pre style="background: #f5f5f5; padding: 15px; border-radius: 5px;">${escapeHtml(error.message)}</pre>
          <p>Please try again or contact support if the issue persists.</p>
        `,
        fromName: 'YCP Due Diligence',
      });
    } catch (emailError) {
      console.error('[DD] Failed to send error email:', emailError.message);
    }
  }
});

// ============ REPORT FETCH ENDPOINTS (for automated testing) ============

// GET /api/reports/:id - Fetch a specific report by ID
app.get('/api/reports/:id', (req, res) => {
  const reportId = req.params.id;
  const report = reportStore.get(reportId);

  if (!report) {
    return res.status(404).json({
      success: false,
      error: 'Report not found',
      message: 'Report may have expired or never existed',
    });
  }

  // Return report with status (exclude large binary data)
  const { docxBuffer, ...reportData } = report;
  res.json({
    success: true,
    reportId: reportId,
    hasDocx: !!docxBuffer,
    docxSize: docxBuffer?.length || 0,
    ...reportData,
  });
});

// GET /api/reports/:id/download - Download DOCX file
app.get('/api/reports/:id/download', (req, res) => {
  const reportId = req.params.id;
  const report = reportStore.get(reportId);

  if (!report) {
    return res.status(404).json({
      success: false,
      error: 'Report not found',
      message: 'Report may have expired or never existed',
    });
  }

  if (!report.docxBuffer) {
    return res.status(404).json({
      success: false,
      error: 'DOCX not available',
      message:
        report.status === 'processing' ? 'Report is still processing' : 'No DOCX file generated',
    });
  }

  // Set headers for DOCX download
  const filename = report.filename || `DD_Report_${reportId}.docx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', report.docxBuffer.length);

  // Send the buffer
  res.send(report.docxBuffer);
});

// GET /api/reports - List all recent reports
app.get('/api/reports', (req, res) => {
  const reports = Array.from(reportStore.entries()).map(([id, r]) => ({
    reportId: id,
    status: r.status,
    files: r.files,
    components: r.components,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    errorAt: r.errorAt,
    // Don't include full HTML in list view
  }));

  // Sort by createdAt descending (newest first)
  reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({
    success: true,
    count: reports.length,
    reports: reports,
  });
});

// ============ HEALTH CHECK ============
app.get('/health', healthCheck('due-diligence'));

// ============ HEALTHCHECK ============
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'due-diligence' });
});

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Due Diligence server running on port ${PORT}`);
});
