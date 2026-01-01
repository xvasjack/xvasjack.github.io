require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const pptxgen = require('pptxgenjs');
const { S3Client } = require('@aws-sdk/client-s3');
const { securityHeaders, rateLimiter } = require('../shared/security');
const { requestLogger, healthCheck } = require('../shared/middleware');
const { setupGlobalErrorHandlers } = require('../shared/logging');
const { sendEmailLegacy: sendEmail } = require('../shared/email');

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

if (!r2Client) {
  console.warn(
    'R2 not configured - recordings will only be stored in memory. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME'
  );
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

// ============ UTB (UNDERSTANDING THE BUSINESS) - COMPREHENSIVE M&A INTELLIGENCE ============

// Language detection from domain
function detectLanguage(website) {
  const domainMatch = website.match(/\.([a-z]{2,3})(?:\/|$)/i);
  const tld = domainMatch ? domainMatch[1].toLowerCase() : '';
  const languageMap = {
    jp: { lang: 'Japanese', native: '日本語', searchPrefix: '日本語で' },
    cn: { lang: 'Chinese', native: '中文', searchPrefix: '用中文' },
    kr: { lang: 'Korean', native: '한국어', searchPrefix: '한국어로' },
    de: { lang: 'German', native: 'Deutsch', searchPrefix: 'Auf Deutsch:' },
    fr: { lang: 'French', native: 'Français', searchPrefix: 'En français:' },
    th: { lang: 'Thai', native: 'ไทย', searchPrefix: 'ภาษาไทย:' },
    vn: { lang: 'Vietnamese', native: 'Tiếng Việt', searchPrefix: 'Bằng tiếng Việt:' },
    id: { lang: 'Indonesian', native: 'Indonesia', searchPrefix: 'Dalam Bahasa Indonesia:' },
    tw: { lang: 'Chinese (Traditional)', native: '繁體中文', searchPrefix: '用繁體中文' },
  };
  return languageMap[tld] || null;
}

// UTB Phase 1: Deep Fact-Finding with 6 parallel specialized queries
// ============ UTB PHASE 0: DOCUMENT FETCHING ============
// Actually fetch and read company documents (annual reports, mid-term plans, etc.)

async function utbPhase0FetchDocuments(companyName, website, context) {
  console.log(`[UTB Phase 0] Fetching company documents for: ${companyName}`);

  const documents = {
    irPage: '',
    annualReport: '',
    midtermPlan: '',
    mergerInfo: '',
    recentDisclosures: '',
  };

  try {
    // 1. Find and fetch IR page
    const baseUrl = website.replace(/\/$/, '');
    const irUrls = [
      `${baseUrl}/ir/`,
      `${baseUrl}/investor/`,
      `${baseUrl}/investors/`,
      `${baseUrl}/ir`,
      `${baseUrl}/investor-relations/`,
      `${baseUrl}/en/ir/`,
      `${baseUrl}/english/ir/`,
    ];

    for (const irUrl of irUrls) {
      const irContent = await fetchWebsite(irUrl);
      if (irContent && irContent.length > 200) {
        documents.irPage = irContent;
        console.log(`[UTB Phase 0] Found IR page at: ${irUrl}`);
        break;
      }
    }

    // 2. Use Perplexity to find specific document content
    const docSearchPromises = [
      // Search for annual report data
      callPerplexity(`Find the OFFICIAL ANNUAL REPORT data for ${companyName} (${website}).

Search for their latest:
- 有価証券報告書 (Securities Report) if Japanese company
- Annual Report / 10-K / 20-F if listed
- Official financial statements

EXTRACT and return the EXACT data:
1. Revenue breakdown by segment (exact percentages from the report)
2. Revenue breakdown by geography (exact percentages)
3. Employee count
4. Key financial metrics

For EACH number, cite: "X% (Source: [Document Name] FY20XX, page Y)"

If you cannot find the official document, state "Official document not accessible".`).catch(
        (_e) => ''
      ),

      // Search for mid-term plan
      callPerplexity(`Find the OFFICIAL MID-TERM MANAGEMENT PLAN (中期経営計画) for ${companyName} (${website}).

Search for their:
- Medium-term management plan
- 中期経営計画 / 中計
- Strategic plan / business plan

EXTRACT and return:
1. Plan period (e.g., FY2024-2026)
2. Key numerical targets (revenue, profit, ROIC, etc.)
3. Strategic priorities and focus areas
4. Investment priorities
5. M&A strategy if mentioned

Cite the source document name and date for each piece of data.`).catch((_e) => ''),

      // Search for M&A/merger announcements
      callPerplexity(`Find any MERGER, ACQUISITION, or CORPORATE ACTION announcements for ${companyName} (${website}).

Search for:
- Recent M&A announcements
- Merger agreements (合併契約)
- Business integration news
- Corporate restructuring
${context && context.toLowerCase().includes('nissei') ? `- Specifically look for merger with Nissei` : ''}
${context && context.toLowerCase().includes('merg') ? `- Focus on: ${context}` : ''}

Return:
1. Target/partner company name
2. Transaction type and terms
3. Timeline and status
4. Strategic rationale
5. Source document (press release date, disclosure number)`).catch((_e) => ''),

      // Search for recent disclosures
      callPerplexity(`Find the most recent OFFICIAL DISCLOSURES and IR materials for ${companyName} (${website}).

Look for:
- Latest earnings release (決算短信)
- Recent investor presentations
- Timely disclosures (適時開示)
- Press releases from last 6 months

Return key announcements with:
1. Date
2. Type of disclosure
3. Key content
4. Source URL if available`).catch((_e) => ''),
    ];

    const [annualReport, midtermPlan, mergerInfo, recentDisclosures] =
      await Promise.all(docSearchPromises);

    documents.annualReport = annualReport || '';
    documents.midtermPlan = midtermPlan || '';
    documents.mergerInfo = mergerInfo || '';
    documents.recentDisclosures = recentDisclosures || '';

    console.log(
      `[UTB Phase 0] Documents fetched - IR: ${documents.irPage.length}chars, Annual: ${documents.annualReport.length}chars, Midterm: ${documents.midtermPlan.length}chars, Merger: ${documents.mergerInfo.length}chars`
    );
  } catch (error) {
    console.error(`[UTB Phase 0] Error fetching documents:`, error.message);
  }

  return documents;
}

async function utbPhase1Research(companyName, website, context, officialDocs = {}) {
  console.log(`[UTB Phase 1] Starting deep fact-finding for: ${companyName}`);
  const localLang = detectLanguage(website);

  // Build document context string from Phase 0
  const docContext = [];
  if (officialDocs.annualReport)
    docContext.push(`ANNUAL REPORT DATA:\n${officialDocs.annualReport}`);
  if (officialDocs.midtermPlan) docContext.push(`MID-TERM PLAN DATA:\n${officialDocs.midtermPlan}`);
  if (officialDocs.mergerInfo) docContext.push(`MERGER/M&A INFO:\n${officialDocs.mergerInfo}`);
  if (officialDocs.recentDisclosures)
    docContext.push(`RECENT DISCLOSURES:\n${officialDocs.recentDisclosures}`);
  const documentContext =
    docContext.length > 0
      ? `\n\nOFFICIAL DOCUMENT DATA (use this as primary source):\n${docContext.join('\n\n')}`
      : '';

  const queries = [
    // Query 1: Company Deep Dive - Products & Services
    callPerplexity(`Research ${companyName} (${website}) - PRODUCTS & SERVICES DEEP DIVE:

CRITICAL: I need SPECIFIC details, not general descriptions.

1. PRODUCT LINES: List ALL major product lines with:
   - Specific product/model names (e.g., "Model X-7", "Series 5000", brand names)
   - Key specifications or features
   - Target applications/industries served

2. SERVICE OFFERINGS: List specific services with names
   - Consulting services, support packages, etc.

3. TECHNOLOGY/IP: Proprietary technologies, patents, unique capabilities
   - Specific technology names or trademarked processes

4. VALUE CHAIN POSITION: Where they sit (R&D, manufacturing, distribution, etc.)

BE SPECIFIC with names and numbers. Generic descriptions are NOT useful.
${context ? `CONTEXT: ${context}` : ''}`).catch((e) => ({
      type: 'products',
      data: '',
      error: e.message,
    })),

    // Query 2: Financial Analysis FROM OFFICIAL DOCUMENTS
    callPerplexity(`Research ${companyName} financial data - DATA MUST COME FROM OFFICIAL COMPANY DOCUMENTS:
${documentContext}

CRITICAL: Only provide data you can source from:
- Annual reports (有価証券報告書 for Japanese companies)
- Investor presentations
- Mid-term management plans (中期経営計画)
- Earnings releases
- Official company filings (10-K, 20-F, etc.)

For EVERY number, specify the source document and date.

1. REVENUE BREAKDOWN FROM ANNUAL REPORT:
   - Total annual revenue (fiscal year, currency, source document)
   - Revenue by business segment - EXACT percentages from segment reporting
   - Revenue by geography - EXACT percentages from geographic reporting

2. FROM MID-TERM PLAN (if available):
   - Strategic targets and KPIs
   - Growth projections
   - Investment priorities

3. FROM LATEST EARNINGS:
   - Most recent quarterly results
   - Management commentary

DO NOT estimate or approximate. If exact data is not available in official documents, state "Not disclosed in official filings".

Format each data point as: "[Number] (Source: [Document Name], [Date])"

For Japanese companies specifically search for: 有価証券報告書, 決算短信, 中期経営計画, IR資料`).catch(
      (e) => ({ type: 'financials', data: '', error: e.message })
    ),

    // Query 3: Manufacturing & Operations
    callPerplexity(`Research ${companyName} manufacturing and operations footprint:

1. MANUFACTURING LOCATIONS:
   - List ALL manufacturing facilities by country/city
   - What is produced at each location
   - Capacity information if available (units, square meters, etc.)

2. R&D CENTERS:
   - Research facility locations
   - Key areas of R&D focus

3. SUPPLY CHAIN:
   - Key suppliers or supply chain dependencies
   - Vertical integration level

4. OPERATIONAL FOOTPRINT:
   - Number of locations globally
   - Sales/distribution offices by region

Provide SPECIFIC locations (city, country) not just "facilities in Asia".`).catch((e) => ({
      type: 'operations',
      data: '',
      error: e.message,
    })),

    // Query 4: Competitive Landscape - COMPREHENSIVE
    callPerplexity(`Research ${companyName} competitive landscape - COMPREHENSIVE GLOBAL ANALYSIS:

CRITICAL: This is a large global industry. Provide a COMPREHENSIVE list of competitors.

1. GLOBAL COMPETITORS (list AT LEAST 10-12 companies):
   For EACH competitor provide:
   - Company name
   - HQ country
   - Revenue (with source)
   - Estimated market share (with source if available)
   - Main products/segments they compete in
   - Geographic focus
   - How they position vs ${companyName}

2. ${companyName} COMPETITIVE POSITION:
   - Their market rank with specific market share %
   - What specifically makes customers choose them (with evidence)
   - Specific competitive vulnerabilities

Include all major global players, regional champions, and emerging competitors.
This should be an exhaustive view of the competitive landscape, not a shortlist.

Provide SPECIFIC data with sources. No generic statements.`).catch((e) => ({
      type: 'competitors',
      data: '',
      error: e.message,
    })),

    // Query 5: M&A History & Strategy
    callPerplexity(`Research ${companyName} M&A activity and corporate development - COMPREHENSIVE:

1. PAST ACQUISITIONS (last 10 years):
   - Target company name
   - Year of acquisition
   - Deal value (if disclosed)
   - Strategic rationale
   - Integration outcome

2. PAST DIVESTITURES:
   - Any businesses sold off

3. STRATEGIC PARTNERSHIPS & JVs:
   - Partner name
   - Nature of partnership
   - Year established

4. INVESTMENTS:
   - Minority investments made
   - VC/CVC activity

5. M&A STRATEGY SIGNALS:
   - Management statements about M&A
   - Investor presentation mentions of inorganic growth
   - Recent news about M&A intentions

Provide SPECIFIC deal names, dates, and values.`).catch((e) => ({
      type: 'ma_history',
      data: '',
      error: e.message,
    })),

    // Query 6: Leadership & Strategy
    callPerplexity(`Research ${companyName} leadership and strategic direction:

1. LEADERSHIP TEAM:
   - CEO name and background (tenure, previous roles)
   - Key executives (CFO, COO, CTO, etc.)
   - Board composition (notable members)

2. STRATEGIC PRIORITIES:
   - Stated strategic initiatives
   - Medium-term plan (if disclosed)
   - Key focus areas for growth

3. RECENT NEWS:
   - Major announcements in last 12 months
   - New product launches
   - Market expansion news

4. INVESTOR MESSAGING:
   - Key themes from investor presentations
   - Guidance or targets shared

Provide SPECIFIC names and quotes where available.`).catch((e) => ({
      type: 'leadership',
      data: '',
      error: e.message,
    })),
  ];

  // Add local language query if applicable
  if (localLang) {
    queries.push(
      callPerplexity(`${localLang.searchPrefix} ${companyName}について詳しく調べてください:

Search for ${companyName} in ${localLang.lang}:
- Recent press releases and news
- Management interviews and statements
- Industry awards and recognition
- Local market reputation and positioning
- Detailed product/service information not available in English
- Employee reviews or company culture insights

Provide findings in English with specific details.`).catch((e) => ({
        type: 'local',
        data: '',
        error: e.message,
      }))
    );
  }

  // Execute all queries in parallel
  const results = await Promise.all(queries);

  // Organize results
  const research = {
    products: typeof results[0] === 'string' ? results[0] : '',
    financials: typeof results[1] === 'string' ? results[1] : '',
    operations: typeof results[2] === 'string' ? results[2] : '',
    competitors: typeof results[3] === 'string' ? results[3] : '',
    maHistory: typeof results[4] === 'string' ? results[4] : '',
    leadership: typeof results[5] === 'string' ? results[5] : '',
    localInsights: localLang && results[6] && typeof results[6] === 'string' ? results[6] : '',
  };

  console.log(
    `[UTB Phase 1] Complete. Research lengths: products=${research.products.length}, financials=${research.financials.length}, operations=${research.operations.length}, competitors=${research.competitors.length}, maHistory=${research.maHistory.length}, leadership=${research.leadership.length}`
  );

  return research;
}

// UTB Phase 2: Section-by-Section Synthesis
async function utbPhase2Synthesis(companyName, website, research, context, officialDocs = {}) {
  console.log(`[UTB Phase 2] Synthesizing intelligence for: ${companyName}`);

  // Build document context for synthesis
  const docContext = [];
  if (officialDocs.annualReport) docContext.push(`ANNUAL REPORT:\n${officialDocs.annualReport}`);
  if (officialDocs.midtermPlan) docContext.push(`MID-TERM PLAN:\n${officialDocs.midtermPlan}`);
  if (officialDocs.mergerInfo) docContext.push(`MERGER INFO:\n${officialDocs.mergerInfo}`);
  const officialDocContext =
    docContext.length > 0
      ? `\n\nOFFICIAL DOCUMENTS (PRIMARY SOURCE - use this data):\n${docContext.join('\n\n')}`
      : '';

  const synthesisPrompts = [
    // Synthesis 1: Revenue Breakdown Only
    callChatGPT(`You are extracting VERIFIED revenue data for M&A advisors.

COMPANY: ${companyName}
WEBSITE: ${website}
${context ? `CLIENT CONTEXT: ${context}` : ''}
${officialDocContext}

RESEARCH ON FINANCIALS:
${research.financials}

---

CRITICAL REQUIREMENTS:
- Only include data you can verify from the research. NO approximations, NO ranges, NO guesses.
- Every percentage must be EXACT (e.g., "47%" not "approximately 45-50%")
- Every data point must have a source (company filings, annual report, investor presentation, etc.)
- If you cannot find an exact verified number, write "Not disclosed" - do NOT estimate
- Do NOT include generic notes like "largest geography" - only include specific sourced information

Respond in this EXACT JSON format:
{
  "financials": {
    "total_revenue": "Exact amount with currency and fiscal year, with source (e.g., 'USD 2.3B (FY2023 Annual Report)')",
    "total_revenue_url": "Direct URL to the source document (e.g., 'https://company.com/ir/annual-report-2023.pdf')",
    "revenue_by_segment": [
      {"segment": "Segment name", "percentage": "Exact % (e.g., '47%')", "source": "Document name", "source_url": "Direct URL to source"}
    ],
    "revenue_by_geography": [
      {"region": "Region name", "percentage": "Exact % (e.g., '32%')", "source": "Document name", "source_url": "Direct URL to source"}
    ],
    "revenue_history": [
      {"year": "FY2020", "revenue": 123.4},
      {"year": "FY2021", "revenue": 145.2},
      {"year": "FY2022", "revenue": 167.8},
      {"year": "FY2023", "revenue": 189.5}
    ],
    "revenue_unit": "JPY 100M"
  }
}

IMPORTANT:
- If you cannot find EXACT percentages with sources, return empty arrays. No approximations allowed.
- Always include source_url when available. Use the most direct link to the source document.
- For revenue_history: Extract 3-5 years of annual revenue. Convert to 100M JPY units (億円). If company reports in USD/EUR, convert using approximate rates.
- For revenue_unit: Use "JPY 100M" for Japanese companies, "USD M" for US companies, etc.`).catch(
      (e) => ({ section: 'profile', error: e.message })
    ),

    // Synthesis 2: Products, Services & Operations
    callChatGPT(`You are writing for M&A ADVISORS who need to understand a company's business quickly. NOT engineers.

COMPANY: ${companyName}

RESEARCH ON PRODUCTS & SERVICES:
${research.products}

RESEARCH ON OPERATIONS:
${research.operations}

---

CRITICAL INSTRUCTIONS:
- Be concise, direct, and professional. No jargon. No generic AI fluff.
- Do NOT list technical model numbers or product codes
- Every statement must be backed by concrete facts from the research
- If you don't have specific data, don't write generic filler - leave it out

For STRATEGIC CAPABILITIES - provide CONCRETE EXAMPLES with numbers:
- BAD: "Strong patent portfolio providing defensible moat"
- GOOD: "1,200+ active patents in polymer chemistry (per 2023 annual report)"
- BAD: "Vertically integrated across the value chain"
- GOOD: "Owns raw material sourcing (2 mines in Chile), manufacturing (4 plants), and distribution (direct sales to 80% of customers)"

Respond in this EXACT JSON format:
{
  "products_and_services": {
    "overview": "1-2 sentences. What do they sell, to whom?",
    "product_lines": [
      {
        "name": "Business segment name",
        "what_it_does": "One sentence - customer value",
        "revenue_significance": "High/Medium/Low",
        "source_url": "URL to source"
      }
    ],
    "strategic_capabilities": [
      {
        "category": "Technology|Scale|Relationships|Cost|Brand",
        "capability": "Specific capability with number (e.g., '1,200+ patents in polymer chemistry')",
        "source": "Source document name",
        "source_url": "URL to source"
      }
    ]
  },
  "operations": {
    "manufacturing_footprint": [
      {"location": "City, Country", "type": "Manufacturing|R&D|HQ|Distribution", "details": "Capacity/employees/products", "source_url": "URL"}
    ]
  }
}

BE CONCISE. Each field should be brief and scannable. Include source_url for every data point.`).catch(
      (e) => ({ section: 'products', error: e.message })
    ),

    // Synthesis 3: Competitive Landscape
    callChatGPT(`You are writing a COMPREHENSIVE competitive analysis for M&A ADVISORS.

COMPANY: ${companyName}

RESEARCH ON COMPETITORS:
${research.competitors}

RESEARCH ON PRODUCTS (for context):
${research.products}

---

CRITICAL INSTRUCTIONS:
- Be concise. No verbose explanations.
- For competitors - list 10-12 global competitors with key metrics.
- Include source URLs for all data points.

Respond in this EXACT JSON format:
{
  "competitive_landscape": {
    "company_position": {
      "market_rank": "#1, #2, Top 5, etc.",
      "market_share": "X%",
      "source_url": "URL to market share source",
      "why_they_win": [
        {
          "advantage_type": "Technology|Scale|Cost|Relationships|Brand|Geography",
          "description": "One sentence with specific evidence",
          "source_url": "URL"
        }
      ],
      "key_vulnerability": "One sentence",
      "vulnerability_source_url": "URL"
    },
    "key_competitors": [
      {
        "name": "Competitor name",
        "hq_country": "Country",
        "revenue": "$XB",
        "market_share": "X%",
        "positioning": "Premium|Mid-tier|Value",
        "key_strength": "One sentence",
        "threat_level": "High|Medium|Low",
        "source_url": "URL"
      }
    ]
  }
}

IMPORTANT: List 10 competitors. Keep each field brief and scannable.`).catch((e) => ({
      section: 'competitors',
      error: e.message,
    })),

    // Synthesis 4: M&A Deep Dive - Structured Analysis
    callChatGPT(`Extract M&A intelligence for ${companyName}. BE CONCISE - one sentence per field max.

RESEARCH ON M&A HISTORY:
${research.maHistory}

RESEARCH ON LEADERSHIP & STRATEGY:
${research.leadership}

RESEARCH ON FINANCIALS:
${research.financials}

---

Respond in this EXACT JSON format:
{
  "ma_deep_dive": {
    "deal_history": [
      {
        "target": "Company name",
        "year": "YYYY",
        "deal_value": "$XM or undisclosed",
        "deal_type": "Acquisition|Merger|JV|Minority",
        "strategic_rationale": "Technology|Market Access|Capacity|Talent|Vertical Integration",
        "outcome": "Integrated|Standalone|Divested",
        "source_url": "URL to announcement"
      }
    ],
    "ma_profile": {
      "acquirer_type": "Serial Acquirer|Opportunistic|Transformational|Bolt-on Only",
      "primary_focus": "Technology|Geography|Capacity|Vertical Integration",
      "typical_deal_size": "$X-YM range",
      "integration_style": "Full Absorption|Standalone|Hybrid",
      "valuation_discipline": "Premium Payer|Disciplined|Value Buyer"
    },
    "deal_capacity": {
      "dry_powder": "$XM (cash + debt capacity)",
      "appetite_level": "High|Medium|Low",
      "decision_speed": "Fast (<6mo)|Normal (6-12mo)|Slow (>12mo)",
      "source_url": "URL to financials"
    }
  }
}

Keep all fields brief. Include source_url for verifiable claims.`).catch((e) => ({
      section: 'ma_analysis',
      error: e.message,
    })),

    // Synthesis 5: Ideal Target Profile - SEA/Asia Target List with Products
    callChatGPT(`Identify 10 REAL acquisition targets for ${companyName} in SOUTHEAST ASIA or ASIA. BE CONCISE.

RESEARCH:
${research.products}
${research.maHistory}
${research.leadership}
${research.financials}

${context ? `CLIENT CONTEXT: ${context}` : ''}

---

GEOGRAPHIC FOCUS: Prioritize targets in:
1. Southeast Asia (Singapore, Thailand, Vietnam, Indonesia, Malaysia, Philippines)
2. If not enough in SEA, expand to broader Asia (Japan, Korea, China, Taiwan, India)
Do NOT include targets from Americas, Europe, or other regions.

Respond in this EXACT JSON format:
{
  "ideal_target": {
    "segments": ["Segment 1", "Segment 2", "Segment 3", "Segment 4"],
    "target_list": [
      {
        "company_name": "Actual company name",
        "hq_country": "Country",
        "hq_city": "City",
        "revenue": "$XM",
        "ownership": "Public|Private|PE-backed",
        "products_offered": [true, false, true, false],
        "website": "company URL"
      }
    ]
  }
}

IMPORTANT:
- "segments" should list the 4-6 main product/service categories based on the buyer's business
- "products_offered" is a boolean array matching the segments array (true = company offers this product/service)
- Real SEA/Asia companies only
- Include company website URL`).catch((e) => ({ section: 'ideal_target', error: e.message })),
  ];

  // Add local insights synthesis if available
  if (research.localInsights) {
    synthesisPrompts.push(
      callChatGPT(`Synthesize these local language insights about ${companyName}:

LOCAL INSIGHTS:
${research.localInsights}

Respond in JSON:
{
  "local_insights": {
    "key_findings": ["Important findings not available in English sources"],
    "reputation": "How they're perceived locally",
    "recent_developments": "Recent news or announcements",
    "cultural_considerations": "Any cultural factors relevant for engagement"
  }
}`).catch((e) => ({ section: 'local', error: e.message }))
    );
  }

  // Execute all synthesis in parallel
  const synthesisResults = await Promise.all(synthesisPrompts);

  // Parse and combine results
  const sections = {};
  for (const result of synthesisResults) {
    if (typeof result === 'string') {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          Object.assign(sections, parsed);
        }
      } catch (e) {
        console.error('Failed to parse synthesis result:', e.message);
      }
    } else if (result.error) {
      console.error(`Synthesis error for ${result.section}:`, result.error);
    }
  }

  console.log(`[UTB Phase 2] Complete. Sections generated: ${Object.keys(sections).join(', ')}`);

  return sections;
}

// Main UTB Research Function
async function conductUTBResearch(companyName, website, additionalContext) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[UTB] Starting comprehensive research for: ${companyName}`);
  console.log(`[UTB] Website: ${website}`);
  console.log('='.repeat(60));

  // Phase 0: Fetch official documents (annual reports, mid-term plans, merger info)
  const officialDocs = await utbPhase0FetchDocuments(companyName, website, additionalContext);

  // Phase 1: Deep fact-finding (with document context)
  const rawResearch = await utbPhase1Research(
    companyName,
    website,
    additionalContext,
    officialDocs
  );

  // Phase 2: Section-by-section synthesis (with document context)
  const synthesis = await utbPhase2Synthesis(
    companyName,
    website,
    rawResearch,
    additionalContext,
    officialDocs
  );

  console.log(`[UTB] Research complete for: ${companyName}`);

  return {
    synthesis,
    rawResearch,
    metadata: {
      company: companyName,
      website,
      generatedAt: new Date().toISOString(),
      localLanguage: detectLanguage(website)?.lang || null,
    },
  };
}

// Generate UTB Excel workbook with structured data

// Generate UTB PowerPoint slides with structured data (1 slide per segment)
async function generateUTBSlides(companyName, website, research, additionalContext) {
  const { synthesis, metadata: _metadata } = research;

  console.log('[UTB] Generating slides...');

  const pptx = new pptxgen();
  pptx.author = 'YCP Solidiance';
  pptx.title = `UTB: ${companyName}`;
  pptx.subject = 'M&A Buyer Intelligence Report';

  // Set exact slide size to match YCP template (13.333" x 7.5" = 16:9 widescreen)
  pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
  pptx.layout = 'YCP';

  // YCP Theme Colors (matching profile-slides template exactly)
  const COLORS = {
    headerLine: '293F55', // Dark navy for header/footer lines
    headerBg: '1524A9', // Dark blue for table header row
    labelBg: '011AB7', // Dark blue for label column (accent3)
    companyBg: '007FFF', // Bright blue for company column
    white: 'FFFFFF',
    black: '000000',
    gray: 'BFBFBF', // Gray for dotted borders between rows
    footerText: '808080', // Gray footer text
  };

  // Define master slide with fixed lines (matching YCP template)
  pptx.defineSlideMaster({
    title: 'YCP_MASTER',
    background: { color: 'FFFFFF' },
    objects: [
      // Thick header line (y: 1.02")
      { line: { x: 0, y: 1.02, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 4.5 } } },
      // Thin header line (y: 1.10")
      { line: { x: 0, y: 1.1, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } } },
      // Footer line (y: 7.24")
      { line: { x: 0, y: 7.24, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } } },
    ],
  });

  // Helper: Add slide title (YCP format - black text, left-aligned, valign bottom)
  const addSlideTitle = (slide, title) => {
    slide.addText(title, {
      x: 0.38,
      y: 0.07,
      w: 9.5,
      h: 0.9,
      fontSize: 24,
      fontFace: 'Segoe UI',
      color: COLORS.black,
      valign: 'bottom',
    });
  };

  // Helper: Add footnote
  const addFootnote = (slide, text = 'Source: Company disclosures, public filings') => {
    slide.addText(text, {
      x: 0.38,
      y: 6.85,
      w: 12.5,
      h: 0.3,
      fontSize: 10,
      fontFace: 'Segoe UI',
      color: COLORS.black,
      valign: 'top',
    });
  };

  // Helper: Get row border (dotted between rows, solid white on edges)
  const getRowBorder = (isLastRow) => {
    return isLastRow ? { pt: 3, color: COLORS.white } : { pt: 1, color: COLORS.gray, type: 'dash' };
  };

  const prod = synthesis.products_and_services || {};
  const maDeepDive = synthesis.ma_deep_dive || {};

  // ========== SLIDE 1: TITLE SLIDE ==========
  const titleSlide = pptx.addSlide({ masterName: 'YCP_MASTER' });

  // Company name - centered, black, large
  titleSlide.addText(companyName, {
    x: 0.38,
    y: 2.5,
    w: 12.54,
    h: 1.0,
    fontSize: 36,
    fontFace: 'Segoe UI',
    bold: true,
    color: COLORS.black,
    align: 'center',
  });

  // Client intention (from additionalContext)
  if (additionalContext) {
    titleSlide.addText(additionalContext, {
      x: 0.38,
      y: 3.6,
      w: 12.54,
      h: 0.8,
      fontSize: 16,
      fontFace: 'Segoe UI',
      color: COLORS.footerText,
      align: 'center',
    });
  }

  // Generated date at bottom
  titleSlide.addText(`Generated: ${new Date().toLocaleDateString()}`, {
    x: 0.38,
    y: 6.5,
    w: 12.54,
    h: 0.3,
    fontSize: 10,
    fontFace: 'Segoe UI',
    color: COLORS.footerText,
    align: 'center',
  });

  // ========== SLIDE 2: BUSINESS OVERVIEW ==========
  if (prod.product_lines && prod.product_lines.length > 0) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });

    // Title with smaller height for subtitle space
    slide.addText('Business Overview', {
      x: 0.38,
      y: 0.15,
      w: 9.5,
      h: 0.55,
      fontSize: 24,
      fontFace: 'Segoe UI',
      color: COLORS.black,
      valign: 'bottom',
    });

    // Subtitle: one-line business descriptor (between title and double lines)
    const overview = prod.overview || `${companyName} business segments and operations`;
    slide.addText(overview, {
      x: 0.38,
      y: 0.72,
      w: 12.54,
      h: 0.25,
      fontSize: 16,
      fontFace: 'Segoe UI',
      color: COLORS.black,
      align: 'left',
    });

    // Column widths: Segment (2.5") + Description (9.92")
    const segmentColW = 2.5;
    const descColW = 9.92;
    const tableStartX = 0.38;
    const tableStartY = 1.18; // After master slide double lines
    const headerHeight = 0.32;
    const lines = prod.product_lines.slice(0, 8); // Max 8 rows
    // Dynamic row height to fill available space (footer at 6.85)
    const availableHeight = 6.75 - tableStartY - headerHeight - 0.1;
    const rowHeight = Math.min(0.68, availableHeight / lines.length);

    // Column header: Business Segment (centered, not bold)
    slide.addText('Business Segment', {
      x: tableStartX,
      y: tableStartY,
      w: segmentColW,
      h: headerHeight,
      fontSize: 14,
      fontFace: 'Segoe UI',
      bold: false,
      color: COLORS.black,
      align: 'center',
      valign: 'bottom',
    });
    // Header underline for segment column (thin blue)
    slide.addShape(pptx.shapes.LINE, {
      x: tableStartX,
      y: tableStartY + headerHeight,
      w: segmentColW - 0.1,
      h: 0,
      line: { color: COLORS.headerLine, width: 1 },
    });

    // Column header: Description (centered, not bold)
    slide.addText('Description', {
      x: tableStartX + segmentColW + 0.12,
      y: tableStartY,
      w: descColW,
      h: headerHeight,
      fontSize: 14,
      fontFace: 'Segoe UI',
      bold: false,
      color: COLORS.black,
      align: 'center',
      valign: 'bottom',
    });
    // Header underline for description column (thin blue)
    slide.addShape(pptx.shapes.LINE, {
      x: tableStartX + segmentColW + 0.12,
      y: tableStartY + headerHeight,
      w: descColW,
      h: 0,
      line: { color: COLORS.headerLine, width: 1 },
    });

    // Data rows
    const dataStartY = tableStartY + headerHeight + 0.08;

    lines.forEach((line, i) => {
      const y = dataStartY + i * rowHeight;
      const isLastRow = i === lines.length - 1;

      // Blue segment block (fixed width, uniform height)
      slide.addShape(pptx.shapes.RECTANGLE, {
        x: tableStartX,
        y: y,
        w: segmentColW,
        h: rowHeight - 0.06,
        fill: { color: COLORS.labelBg },
        line: { type: 'none' },
      });

      // Segment name (white text, centered both ways, not bold)
      slide.addText(line.name || '', {
        x: tableStartX + 0.08,
        y: y,
        w: segmentColW - 0.16,
        h: rowHeight - 0.06,
        fontSize: 14,
        fontFace: 'Segoe UI',
        bold: false,
        color: COLORS.white,
        align: 'center',
        valign: 'middle',
      });

      // Description with solid square bullets
      const desc = line.what_it_does || line.description || '';
      const sentences = desc
        .replace(/\. /g, '.|')
        .split('|')
        .filter((s) => s.trim())
        .slice(0, 2);
      const bulletText = sentences.map((s) => '■  ' + s.trim()).join('\n');

      slide.addText(bulletText, {
        x: tableStartX + segmentColW + 0.12,
        y: y + 0.05,
        w: descColW,
        h: rowHeight - 0.1,
        fontSize: 14,
        fontFace: 'Segoe UI',
        color: COLORS.black,
        align: 'left',
        valign: 'middle',
        lineSpacing: 16,
      });

      // Dotted horizontal divider spanning full width (not on last row)
      if (!isLastRow) {
        slide.addShape(pptx.shapes.LINE, {
          x: tableStartX,
          y: y + rowHeight - 0.03,
          w: segmentColW + 0.12 + descColW,
          h: 0,
          line: { color: COLORS.gray, width: 0.5, dashType: 'dash' },
        });
      }
    });

    addFootnote(slide);
  }

  // ========== SLIDE 3: PAST M&A ==========
  const dealHistory = maDeepDive.deal_history || maDeepDive.deal_stories || [];
  if (dealHistory.length > 0) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'Past M&A');

    const rows = [
      [
        {
          text: 'Target',
          options: {
            fill: { color: COLORS.headerBg },
            color: COLORS.white,
            bold: false,
            align: 'left',
            valign: 'middle',
            border: { pt: 3, color: COLORS.white },
          },
        },
        {
          text: 'Year',
          options: {
            fill: { color: COLORS.headerBg },
            color: COLORS.white,
            bold: false,
            align: 'center',
            valign: 'middle',
            border: { pt: 3, color: COLORS.white },
          },
        },
        {
          text: 'Value',
          options: {
            fill: { color: COLORS.headerBg },
            color: COLORS.white,
            bold: false,
            align: 'center',
            valign: 'middle',
            border: { pt: 3, color: COLORS.white },
          },
        },
        {
          text: 'Type',
          options: {
            fill: { color: COLORS.headerBg },
            color: COLORS.white,
            bold: false,
            align: 'center',
            valign: 'middle',
            border: { pt: 3, color: COLORS.white },
          },
        },
        {
          text: 'Rationale',
          options: {
            fill: { color: COLORS.headerBg },
            color: COLORS.white,
            bold: false,
            align: 'left',
            valign: 'middle',
            border: { pt: 3, color: COLORS.white },
          },
        },
      ],
    ];

    const deals = dealHistory.slice(0, 8);
    deals.forEach((deal, i) => {
      const isLastRow = i === deals.length - 1;
      rows.push([
        {
          text: deal.target || deal.deal || '',
          options: {
            fill: { color: COLORS.companyBg },
            color: COLORS.white,
            bold: false,
            align: 'left',
            valign: 'middle',
            border: { pt: 3, color: COLORS.white },
          },
        },
        {
          text: deal.year || '',
          options: {
            fill: { color: COLORS.white },
            color: COLORS.black,
            align: 'center',
            valign: 'middle',
            border: [
              { pt: 3, color: COLORS.white },
              { pt: 3, color: COLORS.white },
              getRowBorder(isLastRow),
              { pt: 3, color: COLORS.white },
            ],
          },
        },
        {
          text: deal.deal_value || '',
          options: {
            fill: { color: COLORS.white },
            color: COLORS.black,
            align: 'center',
            valign: 'middle',
            border: [
              { pt: 3, color: COLORS.white },
              { pt: 3, color: COLORS.white },
              getRowBorder(isLastRow),
              { pt: 3, color: COLORS.white },
            ],
          },
        },
        {
          text: deal.deal_type || '',
          options: {
            fill: { color: COLORS.white },
            color: COLORS.black,
            align: 'center',
            valign: 'middle',
            border: [
              { pt: 3, color: COLORS.white },
              { pt: 3, color: COLORS.white },
              getRowBorder(isLastRow),
              { pt: 3, color: COLORS.white },
            ],
          },
        },
        {
          text: deal.strategic_rationale || '',
          options: {
            fill: { color: COLORS.white },
            color: COLORS.black,
            align: 'left',
            valign: 'middle',
            border: [
              { pt: 3, color: COLORS.white },
              { pt: 3, color: COLORS.white },
              getRowBorder(isLastRow),
              { pt: 3, color: COLORS.white },
            ],
          },
        },
      ]);
    });

    slide.addTable(rows, {
      x: 0.38,
      y: 1.2,
      w: 12.54,
      colW: [3.0, 1.0, 1.5, 1.8, 5.24],
      rowH: 0.5,
      fontFace: 'Segoe UI',
      fontSize: 10,
      valign: 'middle',
    });

    addFootnote(slide);
  }

  // ========== SLIDE 4: TARGET LIST with Products/Services Tick Marks ==========
  const idealTarget = synthesis.ideal_target || {};
  const targetList = idealTarget.target_list || [];
  const segments = idealTarget.segments || ['Product 1', 'Product 2', 'Product 3', 'Product 4'];

  if (targetList.length > 0) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });

    // Title: "Target List – SEA/Asia"
    const targetTitle = additionalContext
      ? `Target List – ${additionalContext.substring(0, 40)}`
      : 'Target List – SEA/Asia';
    addSlideTitle(slide, targetTitle);

    // Use max 4 segments, fully spelled out (no truncation)
    const displaySegments = segments.slice(0, 4);
    const numSegments = displaySegments.length;

    // Column widths: Company(2.6) + HQ(0.9) + Revenue(1.0) + segments(remaining, evenly split)
    const fixedColsW = 2.6 + 0.9 + 1.0;
    const segmentColW = (12.54 - fixedColsW) / numSegments;
    const colWidths = [2.6, 0.9, 1.0, ...Array(numSegments).fill(segmentColW)];

    // Build header row with tall uniform blocks (not bold per design requirements)
    const headerOpts = {
      fill: { color: COLORS.headerBg },
      color: COLORS.white,
      bold: false,
      align: 'center',
      valign: 'middle',
      border: { pt: 2, color: COLORS.white },
    };

    const headerRow = [
      { text: 'Company', options: { ...headerOpts, align: 'left' } },
      { text: 'HQ', options: headerOpts },
      { text: 'Revenue', options: headerOpts },
    ];

    // Add segment columns to header (full names, no truncation)
    displaySegments.forEach((seg) => {
      headerRow.push({
        text: seg,
        options: { ...headerOpts, fontSize: 9 },
      });
    });

    const rows = [headerRow];
    const targets = targetList.slice(0, 10);

    targets.forEach((t, i) => {
      const isLastRow = i === targets.length - 1;

      // Company column: lighter blue, with hyperlink to company website
      const companyOpts = {
        fill: { color: COLORS.companyBg },
        color: COLORS.white,
        bold: false,
        align: 'left',
        valign: 'middle',
        border: { pt: 2, color: COLORS.white },
      };
      // Add hyperlink if website is available
      if (t.website) {
        companyOpts.hyperlink = { url: t.website };
      }
      const row = [
        {
          text: `${i + 1}. ${t.company_name || ''}`,
          options: companyOpts,
        },
        {
          text: t.hq_country || '',
          options: {
            fill: { color: COLORS.white },
            color: COLORS.black,
            align: 'center',
            valign: 'middle',
            border: [
              { pt: 2, color: COLORS.white },
              { pt: 2, color: COLORS.white },
              getRowBorder(isLastRow),
              { pt: 2, color: COLORS.white },
            ],
          },
        },
        {
          text: t.revenue || t.estimated_revenue || '',
          options: {
            fill: { color: COLORS.white },
            color: COLORS.black,
            align: 'center',
            valign: 'middle',
            border: [
              { pt: 2, color: COLORS.white },
              { pt: 2, color: COLORS.white },
              getRowBorder(isLastRow),
              { pt: 2, color: COLORS.white },
            ],
          },
        },
      ];

      // Add tick marks for each segment (centered, consistent size)
      const productsOffered = t.products_offered || [];
      displaySegments.forEach((seg, si) => {
        const hasProduct = productsOffered[si] === true;
        row.push({
          text: hasProduct ? '✓' : '',
          options: {
            fill: { color: COLORS.white },
            color: '00A651', // Green tick
            fontSize: 12,
            bold: true,
            align: 'center',
            valign: 'middle',
            border: [
              { pt: 2, color: COLORS.white },
              { pt: 2, color: COLORS.white },
              getRowBorder(isLastRow),
              { pt: 2, color: COLORS.white },
            ],
          },
        });
      });

      rows.push(row);
    });

    slide.addTable(rows, {
      x: 0.38,
      y: 1.2,
      w: 12.54,
      colW: colWidths,
      rowH: [0.55, ...Array(targets.length).fill(0.5)], // Taller header row
      fontFace: 'Segoe UI',
      fontSize: 14,
      valign: 'middle',
    });

    // Bottom boundary line
    const tableBottom = 1.2 + 0.55 + targets.length * 0.5;
    slide.addShape(pptx.shapes.LINE, {
      x: 0.38,
      y: tableBottom,
      w: 12.54,
      h: 0,
      line: { color: COLORS.gray, width: 1 },
    });

    addFootnote(slide, 'Source: Company disclosures, industry databases');
  }

  // ========== SLIDE 5: M&A STRATEGY (Row-Based Geographic Framework) ==========
  if (targetList.length >= 2) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'Hypothetical M&A Strategies');

    // Define geographic strategy themes based on target locations
    const geoStrategies = [];

    // Group targets by region
    const seaCountries = [
      'Singapore',
      'Thailand',
      'Vietnam',
      'Indonesia',
      'Malaysia',
      'Philippines',
    ];
    const greaterChinaCountries = ['China', 'Taiwan', 'Hong Kong'];
    const neaCountries = ['Japan', 'Korea', 'South Korea'];

    const seaTargets = targetList.filter((t) =>
      seaCountries.some((c) => (t.hq_country || '').includes(c))
    );
    const gcTargets = targetList.filter((t) =>
      greaterChinaCountries.some((c) => (t.hq_country || '').includes(c))
    );
    const neaTargets = targetList.filter((t) =>
      neaCountries.some((c) => (t.hq_country || '').includes(c))
    );
    const otherTargets = targetList.filter(
      (t) =>
        !seaCountries.some((c) => (t.hq_country || '').includes(c)) &&
        !greaterChinaCountries.some((c) => (t.hq_country || '').includes(c)) &&
        !neaCountries.some((c) => (t.hq_country || '').includes(c))
    );

    // Build strategy rows based on available targets (without company names per design requirements)
    if (seaTargets.length > 0) {
      geoStrategies.push({
        region: 'Southeast Asia',
        strategy: `■  Acquire regional player to establish footprint\n■  Leverage local distribution networks and customer relationships`,
        rationale: `■  Access to high-growth ASEAN markets with favorable demographics\n■  Cost-effective manufacturing base and supply chain diversification`,
      });
    }

    if (gcTargets.length > 0) {
      geoStrategies.push({
        region: 'Greater China',
        strategy: `■  Target local manufacturer for technology and scale expansion\n■  Build presence in world's largest manufacturing ecosystem`,
        rationale: `■  Access to advanced manufacturing capabilities and R&D talent\n■  Strategic positioning in key supply chain hub`,
      });
    }

    if (neaTargets.length > 0) {
      geoStrategies.push({
        region: 'Northeast Asia',
        strategy: `■  Partner with or acquire regional company for premium segment\n■  Strengthen technical capabilities through talent acquisition`,
        rationale: `■  Access to high-value customer segments and premium pricing\n■  Technology transfer and quality improvement opportunities`,
      });
    }

    if (otherTargets.length > 0 && geoStrategies.length < 3) {
      geoStrategies.push({
        region: 'Other Asia',
        strategy: `■  Evaluate regional targets for niche market entry\n■  Diversify geographic exposure beyond core markets`,
        rationale: `■  Risk diversification across multiple markets\n■  Access to unique capabilities or customer segments`,
      });
    }

    // Ensure at least 3 rows
    while (geoStrategies.length < 3) {
      geoStrategies.push({
        region:
          geoStrategies.length === 0
            ? 'Southeast Asia'
            : geoStrategies.length === 1
              ? 'Greater China'
              : 'Northeast Asia',
        strategy: '■  Identify acquisition targets in region\n■  Build local market intelligence',
        rationale: '■  Expand geographic footprint\n■  Diversify revenue streams',
      });
    }

    // Column widths: Region(2.0) + Strategy(5.27) + Rationale(5.27)
    const colWidths = [2.0, 5.27, 5.27];
    const tableStartX = 0.38;
    const tableStartY = 1.2;
    const headerHeight = 0.5;
    const rowHeight = 1.2;

    // Header row (not bold per design requirements)
    const headerOpts = {
      fill: { color: COLORS.headerBg },
      color: COLORS.white,
      bold: false,
      align: 'center',
      valign: 'middle',
      border: { pt: 2, color: COLORS.white },
    };

    const rows = [
      [
        { text: 'Region', options: headerOpts },
        { text: 'Strategy', options: headerOpts },
        { text: 'Rationale', options: headerOpts },
      ],
    ];

    // Data rows (not bold per design requirements)
    geoStrategies.slice(0, 4).forEach((gs, i) => {
      const isLastRow = i === Math.min(geoStrategies.length, 4) - 1;

      rows.push([
        {
          text: gs.region,
          options: {
            fill: { color: COLORS.labelBg },
            color: COLORS.white,
            bold: false,
            fontSize: 14,
            align: 'center',
            valign: 'middle',
            border: { pt: 2, color: COLORS.white },
          },
        },
        {
          text: gs.strategy,
          options: {
            fill: { color: COLORS.white },
            color: COLORS.black,
            fontSize: 14,
            align: 'left',
            valign: 'top',
            border: [
              { pt: 2, color: COLORS.white },
              { pt: 2, color: COLORS.white },
              getRowBorder(isLastRow),
              { pt: 2, color: COLORS.white },
            ],
          },
        },
        {
          text: gs.rationale,
          options: {
            fill: { color: COLORS.white },
            color: COLORS.black,
            fontSize: 14,
            align: 'left',
            valign: 'top',
            border: [
              { pt: 2, color: COLORS.white },
              { pt: 2, color: COLORS.white },
              getRowBorder(isLastRow),
              { pt: 2, color: COLORS.white },
            ],
          },
        },
      ]);
    });

    slide.addTable(rows, {
      x: tableStartX,
      y: tableStartY,
      w: 12.54,
      colW: colWidths,
      rowH: [headerHeight, ...Array(rows.length - 1).fill(rowHeight)],
      fontFace: 'Segoe UI',
      fontSize: 14,
      valign: 'middle',
    });

    addFootnote(slide);
  }

  // ========== SLIDE 6: FINANCIAL BAR CHART (if revenue history available) ==========
  const fin = synthesis.financials || {};
  const revenueHistory = fin.revenue_history || [];

  if (revenueHistory.length >= 2) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'Revenue Trend');

    // Chart data
    const chartData = [
      {
        name: 'Revenue',
        labels: revenueHistory.map((r) => r.year),
        values: revenueHistory.map((r) => r.revenue),
      },
    ];

    // Add bar chart
    slide.addChart(pptx.charts.BAR, chartData, {
      x: 0.5,
      y: 1.3,
      w: 12,
      h: 5.0,
      barDir: 'col', // Vertical bars
      barGapWidthPct: 50,
      chartColors: [COLORS.companyBg], // Bright blue bars
      showValue: true,
      dataLabelPosition: 'outEnd',
      dataLabelFontSize: 10,
      dataLabelFontFace: 'Segoe UI',
      dataLabelColor: COLORS.black,
      catAxisTitle: 'Fiscal Year',
      catAxisTitleFontSize: 10,
      catAxisLabelFontSize: 10,
      catAxisLabelFontFace: 'Segoe UI',
      valAxisTitle: fin.revenue_unit || 'JPY 100M',
      valAxisTitleFontSize: 10,
      valAxisLabelFontSize: 9,
      valAxisLabelFontFace: 'Segoe UI',
      valAxisMinVal: 0,
      showLegend: false,
      showTitle: false,
    });

    addFootnote(slide, 'Source: Company disclosures, annual reports');
  }

  // Generate base64
  const base64Content = await pptx.write({ outputType: 'base64' });
  console.log('[UTB] Slides generated successfully');

  return base64Content;
}

// UTB API endpoint
app.post('/api/utb', async (req, res) => {
  const { companyName, website, context, email } = req.body;

  if (!companyName || !website || !email) {
    return res.status(400).json({ error: 'Company name, website, and email are required' });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[UTB] REQUEST: ${companyName}`);
  console.log(`[UTB] Website: ${website}`);
  console.log(`[UTB] Email: ${email}`);
  console.log(`[UTB] Context: ${context ? context.substring(0, 100) + '...' : 'None'}`);
  console.log('='.repeat(60));

  // Respond immediately
  res.json({
    success: true,
    message: `UTB report for ${companyName} will be emailed in 10-15 minutes.`,
  });

  try {
    // Conduct comprehensive research
    const research = await conductUTBResearch(companyName, website, context);

    // Generate PowerPoint slides with structured data (1 slide per segment)
    const slidesBase64 = await generateUTBSlides(companyName, website, research, context);

    // Send email with attachment
    await sendEmail(
      email,
      `UTB: ${companyName}`,
      `<div style="font-family:Arial,sans-serif;max-width:500px;">
        <h2 style="color:#1a365d;margin-bottom:5px;">${companyName}</h2>
        <p style="color:#64748b;margin-top:0;">${website}</p>
        <p>Your UTB buyer intelligence report is attached.</p>
        <p style="font-size:12px;color:#94a3b8;">Generated: ${new Date().toLocaleString()}</p>
      </div>`,
      {
        content: slidesBase64,
        name: `UTB_${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.pptx`,
      }
    );

    console.log(`[UTB] Slides report sent successfully to ${email}`);
  } catch (error) {
    console.error('[UTB] Error:', error);
    await sendEmail(email, `UTB Error - ${companyName}`, `<p>Error: ${error.message}</p>`).catch(
      () => {}
    );
  }
});

// ============ HEALTH CHECK ============
app.get('/health', healthCheck('utb'));

// ============ HEALTHCHECK ============
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'utb' });
});

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`UTB server running on port ${PORT}`);
});
