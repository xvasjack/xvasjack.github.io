require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const pptxgen = require('pptxgenjs');
const { S3Client } = require('@aws-sdk/client-s3');
// Try local copy first (Railway), fall back to parent (local dev)
const sharedPath = require('fs').existsSync('./shared') ? './shared' : '../shared';
const { securityHeaders, rateLimiter } = require(`${sharedPath}/security`);
const { requestLogger, healthCheck } = require(`${sharedPath}/middleware`);
const { setupGlobalErrorHandlers } = require(`${sharedPath}/logging`);
const { sendEmailLegacy: sendEmail } = require(`${sharedPath}/email`);
const { createTracker, trackingContext, recordTokens } = require(`${sharedPath}/tracking`);

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
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });
    if (response.usage) {
      recordTokens(
        'gpt-5.1',
        response.usage.prompt_tokens || 0,
        response.usage.completion_tokens || 0
      );
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

async function callChatGPTJSON(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
    if (response.usage) {
      recordTokens(
        'gpt-5.1',
        response.usage.prompt_tokens || 0,
        response.usage.completion_tokens || 0
      );
    }
    const result = response.choices[0].message.content || '';
    if (!result) {
      console.warn('ChatGPTJSON returned empty response for prompt:', prompt.substring(0, 100));
    }
    return result;
  } catch (error) {
    console.error('ChatGPTJSON error:', error.message);
    return '';
  }
}

async function validateSynthesisOutput(sectionName, jsonOutput) {
  const bannedWords = ['synergy', 'leverage', 'optimize', 'strategic value'];
  const issues = [];

  // Local check for banned words
  const lower = JSON.stringify(jsonOutput).toLowerCase();
  for (const word of bannedWords) {
    if (lower.includes(word)) {
      issues.push(`Banned word "${word}" found in ${sectionName}`);
    }
  }

  // GPT-4o-mini validation for substance
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `You are a quality checker for M&A research output. Check this JSON section "${sectionName}" for quality issues.

JSON:
${JSON.stringify(jsonOutput, null, 2)}

Check for:
1. Any vague claims without specific numbers or sources (e.g., "growing market" without a growth rate)
2. Any of these banned buzzwords: synergy, leverage, optimize, strategic value
3. Any fields that are empty or contain only generic filler text
4. Missing data sources for quantitative claims

Return JSON: { "valid": true/false, "issues": ["issue1", "issue2"] }
If no issues found, return { "valid": true, "issues": [] }`,
        },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    if (response.usage) {
      recordTokens(
        'gpt-4o-mini',
        response.usage.prompt_tokens || 0,
        response.usage.completion_tokens || 0
      );
    }
    const result = JSON.parse(response.choices[0].message.content || '{}');
    if (result.issues && result.issues.length > 0) {
      issues.push(...result.issues);
    }
  } catch (error) {
    console.warn(`[Validation] Failed for ${sectionName}:`, error.message);
  }

  return { valid: issues.length === 0, issues };
}

function stripReasoning(obj) {
  if (obj && typeof obj === 'object') {
    delete obj._reasoning;
    Object.values(obj).forEach((v) => stripReasoning(v));
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
- Company website IR/financial pages

For EVERY number, specify the source document and date.

1. REVENUE HISTORY (MOST IMPORTANT - need 3-5 years):
   - Annual revenue for each of the last 3-5 fiscal years
   - Format: FY2021: XXX, FY2022: XXX, FY2023: XXX, FY2024: XXX
   - Include the currency and unit (e.g., JPY millions, USD millions)
   - This is CRITICAL for financial trend analysis

2. REVENUE BREAKDOWN FROM ANNUAL REPORT:
   - Total annual revenue (fiscal year, currency, source document)
   - Revenue by business segment - EXACT percentages from segment reporting
   - Revenue by geography - EXACT percentages from geographic reporting

3. FROM MID-TERM PLAN (if available):
   - Strategic targets and KPIs
   - Growth projections
   - Investment priorities

4. FROM LATEST EARNINGS:
   - Most recent quarterly results
   - Management commentary

If exact data is not available in official documents, check the company website for any disclosed financial information.

Format each data point as: "[Number] (Source: [Document Name], [Date])"

For Japanese companies specifically search for: 有価証券報告書, 決算短信, 中期経営計画, IR資料, 業績ハイライト`).catch(
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

1. PAST ACQUISITIONS (last 10-15 years) - FOR EACH DEAL PROVIDE ALL OF:
   - Year of acquisition
   - Target company name
   - Target company's country/headquarters
   - Deal type (Acquisition, Merger, JV, Minority stake)
   - Acquired stake percentage (100%, majority, minority, or undisclosed)
   - Target's business description (what the acquired company does)
   - Strategic rationale (why they acquired it)

2. PAST DIVESTITURES:
   - Any businesses sold off

3. STRATEGIC PARTNERSHIPS & JVs:
   - Partner name and country
   - Nature of partnership
   - Year established

4. INVESTMENTS:
   - Minority investments made
   - VC/CVC activity

5. M&A STRATEGY SIGNALS:
   - Management statements about M&A
   - Investor presentation mentions of inorganic growth
   - Recent news about M&A intentions

IMPORTANT: For each acquisition, provide ALL details: year, target name, target country, deal type, stake acquired, target business, and rationale.`).catch(
      (e) => ({
        type: 'ma_history',
        data: '',
        error: e.message,
      })
    ),

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

    // Query 7: Industry Deep Dive — analyze the INDUSTRY, not the company
    callPerplexity(`Analyze the INDUSTRY that ${companyName} (${website}) operates in. This is about the INDUSTRY, not the company itself.

IMPORTANT RULES:
- Every claim must cite a specific source (report name, publisher, year)
- If data is not available, write "DATA NOT AVAILABLE" — do NOT fabricate
- BANNED phrases without dollar/number impact: "digital transformation", "growing demand", "increasing adoption", "paradigm shift", "synergies"
- If you use any of those phrases, you MUST attach a specific dollar figure or percentage

1. INDUSTRY IDENTIFICATION:
   - What is the precise industry/sub-industry name? (e.g., "Industrial automation sensors" not just "manufacturing")
   - SIC/NAICS codes if available
   - Standard industry classification used by analysts

2. VALUE CHAIN MAP:
   - Full value chain from raw materials to end customer
   - Where does value concentrate? Which stages capture highest margins?
   - Who are the key players at each stage?

3. MARKET SIZE & SEGMENTATION:
   - Total addressable market size (global, with source and year)
   - Segmentation axes: by product type, by end-use industry, by geography
   - Size of each segment if available

4. GROWTH DRIVERS & HEADWINDS:
   - Top 3 growth drivers with quantified impact (dollar or % terms)
   - Top 3 headwinds or risks with quantified impact
   - Cyclicality: Is this industry cyclical? What drives cycles?

5. CONSOLIDATION STATUS:
   - Is the industry fragmented or consolidated? (CR5, CR10, HHI if available)
   - Recent consolidation trend: accelerating, stable, or fragmenting?
   - Notable recent M&A transactions in the industry (last 3 years)

6. REGULATORY & TECHNOLOGY DISRUPTION:
   - Key regulations affecting the industry
   - Technology shifts that could disrupt incumbent positions

Cite sources for every data point. Use "DATA NOT AVAILABLE" for anything you cannot verify.
${context ? `CONTEXT: ${context}` : ''}`).catch((e) => ({
      type: 'industry',
      data: '',
      error: e.message,
    })),

    // Query 8: Client Positioning & Expansion Signals
    callPerplexity(`Analyze ${companyName}'s (${website}) SPECIFIC POSITIONING within its industry and identify expansion signals.

IMPORTANT RULES:
- Every claim must cite a specific source (annual report, press release, interview, filing)
- If data is not available, write "DATA NOT AVAILABLE" — do NOT guess
- BANNED without evidence: "well-positioned", "market leader", "strong brand", "competitive advantage"

1. SUB-SEGMENT POSITIONING:
   - What specific sub-segment or niche does ${companyName} occupy?
   - What do they deliberately NOT do? (segments they avoid, products they don't offer)
   - How do they describe their own positioning in annual reports or investor presentations?

2. PRICING & CUSTOMER PROFILE:
   - Pricing tier: Premium / Mid-market / Value? (with evidence — ASP data, margin comparison to peers)
   - Customer type: Enterprise / SME / Consumer / Government?
   - Customer concentration: Top 5 customers as % of revenue if disclosed
   - Contract structure: Long-term contracts, recurring revenue, or transactional?

3. REVENUE CONCENTRATION RISK:
   - Geographic concentration (% from top market)
   - Product concentration (% from top product line)
   - Customer concentration (if disclosed in filings)

4. COMPETITOR EXPANSION INTO THEIR SPACE:
   - Which competitors are moving into ${companyName}'s sub-segment?
   - New entrants or adjacent players expanding into their territory?
   - Pricing pressure from above or below?

5. EXPANSION SIGNALS (from official company sources):
   - Statements from annual reports (有価証券報告書) about growth plans
   - 中期経営計画 (mid-term management plan) targets for new markets or products
   - Recent capex announcements, new facility plans, or hiring patterns
   - JV or partnership announcements indicating new directions
   - Patent filings in new technology areas

6. STRATEGIC GAPS:
   - What capabilities does ${companyName} lack vs. top competitors?
   - Geographic white spaces where they have no presence
   - Product/service gaps relative to customer needs

Cite specific sources (document name, date) for every claim.
${context ? `CONTEXT: ${context}` : ''}`).catch((e) => ({
      type: 'positioning',
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
    industryAnalysis: typeof results[6] === 'string' ? results[6] : '',
    positioningSignals: typeof results[7] === 'string' ? results[7] : '',
    localInsights: localLang && results[8] && typeof results[8] === 'string' ? results[8] : '',
  };

  console.log(
    `[UTB Phase 1] Complete. Research lengths: products=${research.products.length}, financials=${research.financials.length}, operations=${research.operations.length}, competitors=${research.competitors.length}, maHistory=${research.maHistory.length}, leadership=${research.leadership.length}, industryAnalysis=${research.industryAnalysis.length}, positioningSignals=${research.positioningSignals.length}`
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
    callChatGPT(`You are extracting revenue data for M&A advisors.

COMPANY: ${companyName}
WEBSITE: ${website}
${context ? `CLIENT CONTEXT: ${context}` : ''}
${officialDocContext}

RESEARCH ON FINANCIALS:
${research.financials}

---

REQUIREMENTS:
- Extract revenue data from the research. Include data from company websites, annual reports, press releases.
- For percentages, prefer exact numbers but include approximate if exact not available.
- Include source when available.

Respond in this EXACT JSON format:
{
  "financials": {
    "total_revenue": "Amount with currency and fiscal year (e.g., 'JPY 13.5B (FY2023)')",
    "total_revenue_url": "URL to source if available",
    "revenue_by_segment": [
      {"segment": "Segment name", "percentage": "% value", "source": "Document name", "source_url": "URL"}
    ],
    "revenue_by_geography": [
      {"region": "Region name", "percentage": "% value", "source": "Document name", "source_url": "URL"}
    ],
    "revenue_history": [
      {"year": "FY2021", "revenue": 115},
      {"year": "FY2022", "revenue": 123},
      {"year": "FY2023", "revenue": 135}
    ],
    "revenue_unit": "JPY 100M"
  }
}

CRITICAL FOR REVENUE_HISTORY:
- This is the MOST IMPORTANT field - we need this for the Financial Highlights chart
- Extract 2-5 years of annual revenue from the research
- Convert to appropriate units (100M JPY for Japanese companies, USD M for US companies)
- If only 2 years available, include those 2 years - do NOT leave empty
- Look for revenue trends, sales figures, or 売上高 in the research

CRITICAL FOR REVENUE_UNIT (Y-axis label):
- MUST provide revenue_unit - this shows on the chart Y-axis
- For Japanese companies: ALWAYS use "JPY 100M" (億円 = 100 million yen)
- For US companies: Use "USD M" (millions)
- For other currencies: Use appropriate format like "EUR M", "SGD M", etc.
- The revenue numbers in revenue_history should match this unit`).catch((e) => ({
      section: 'profile',
      error: e.message,
    })),

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

IMPORTANT: Include ALL acquisitions, mergers, JVs mentioned in the research. Even if some fields are unknown, still include the deal with "undisclosed" or "unknown" for missing fields. Do NOT skip deals just because some details are missing.

Respond in this EXACT JSON format:
{
  "ma_deep_dive": {
    "deal_history": [
      {
        "year": "YYYY or unknown",
        "target": "Company name",
        "target_country": "Country name or unknown",
        "deal_type": "Acquisition|Merger|JV|Minority",
        "acquired_stake": "100%|Majority|Minority|undisclosed",
        "target_business": "Brief description of target's business",
        "strategic_rationale": "Technology|Market Access|Capacity|Talent|Vertical Integration|Expansion",
        "outcome": "Integrated|Standalone|Divested|unknown",
        "source_url": "URL to announcement or empty string"
      }
    ],
    "ma_profile": {
      "acquirer_type": "Serial Acquirer|Opportunistic|Transformational|Bolt-on Only|No M&A history",
      "primary_focus": "Technology|Geography|Capacity|Vertical Integration",
      "typical_deal_size": "$X-YM range or unknown",
      "integration_style": "Full Absorption|Standalone|Hybrid",
      "valuation_discipline": "Premium Payer|Disciplined|Value Buyer"
    },
    "deal_capacity": {
      "dry_powder": "$XM (cash + debt capacity) or unknown",
      "appetite_level": "High|Medium|Low",
      "decision_speed": "Fast (<6mo)|Normal (6-12mo)|Slow (>12mo)",
      "source_url": "URL to financials or empty string"
    }
  }
}

Include ALL deals found in research. Use "unknown" or "undisclosed" for missing fields rather than omitting deals.`).catch(
      (e) => ({
        section: 'ma_analysis',
        error: e.message,
      })
    ),

    // Synthesis 6: Industry Intelligence
    callChatGPTJSON(`You are an industry analyst writing for M&A advisors. Analyze the industry that ${companyName} (${website}) operates in.

RESEARCH ON PRODUCTS & SERVICES:
${research.products}

RESEARCH ON COMPETITORS:
${research.competitors}

${research.industryAnalysis ? `INDUSTRY ANALYSIS DATA:\n${research.industryAnalysis}` : ''}

${context ? `CLIENT CONTEXT: ${context}` : ''}

---

Respond in this EXACT JSON format:
{
  "_reasoning": "Think step by step: What industry is this company in? What is the market size? How is the value chain structured? What are the real growth drivers with data?",
  "industry_analysis": {
    "industry_name": "Specific industry name (e.g., 'Industrial Automation Components' not just 'Manufacturing')",
    "market_size": "Global market size with year and source (e.g., '$45.2B in 2024, source: MarketsandMarkets')",
    "growth_rate": "CAGR with period and source (e.g., '6.8% CAGR 2024-2029, source: Grand View Research')",
    "value_chain": [
      {"stage": "Stage name", "description": "What happens here", "key_players": "1-2 example companies", "margin": "Typical margin % as number (e.g., 15)", "company_presence": "active|absent|target"}
    ],
    "segmentation": [
      {"segment": "Sub-segment name", "market_size": "Market size", "growth": "Growth rate", "fragmentation": "Fragmented|Moderate|Concentrated", "key_players": "Top 2-3 players", "client_position": "Active|Not Served|Target|High Priority"}
    ],
    "growth_drivers": "3-4 specific drivers with data points, not generic statements",
    "consolidation": "Is the industry consolidating? M&A activity level and recent notable deals",
    "key_trends": "3-4 specific trends with evidence"
  }
}

RULES:
- Every number must have a source
- No generic statements like "growing market" — include the actual growth rate
- Be specific about the industry, not the company`).catch((e) => ({
      section: 'industry_analysis',
      error: e.message,
    })),

    // Synthesis 7: Client Positioning
    callChatGPTJSON(`You are an M&A advisor analyzing how ${companyName} (${website}) is positioned within its industry.

RESEARCH ON PRODUCTS & SERVICES:
${research.products}

RESEARCH ON FINANCIALS:
${research.financials}

${research.industryAnalysis ? `INDUSTRY ANALYSIS DATA:\n${research.industryAnalysis}` : ''}
${research.positioningSignals ? `POSITIONING SIGNALS:\n${research.positioningSignals}` : ''}

${context ? `CLIENT CONTEXT: ${context}` : ''}

---

Respond in this EXACT JSON format:
{
  "_reasoning": "Think step by step: What sub-segment does this company focus on? What do they explicitly NOT do? Who are their customers? What is their pricing tier?",
  "client_positioning": {
    "sub_segment": "The specific niche within the broader industry (e.g., 'High-precision servo motors for semiconductor equipment' not just 'Motors')",
    "positioning_statement": "One sentence: What they do, for whom, and why customers choose them over alternatives",
    "what_they_dont_do": "Explicitly list 2-3 things competitors do that this company does NOT do",
    "pricing_tier": "Premium|Mid-tier|Value — with evidence (e.g., 'Premium — ASPs 20-30% above industry average per FY2024 IR presentation')",
    "primary_customer": "Who buys from them — specific industries or customer types with examples",
    "segments": [
      {"name": "Segment name", "client_revenue": "Revenue from this segment", "market_share": "Client share in segment", "position": "Leader|Challenger|Follower|Not Present", "coverage": "Full|Partial|None", "key_competitors": "Top 2-3 competitors in this segment", "notes": "Key insight about this segment"}
    ],
    "concentrations": {
      "revenue": {"detail": "One sentence about revenue concentration risk with data"},
      "geographic": {"detail": "One sentence about geographic/customer concentration with data"},
      "white_space": {"detail": "One sentence about biggest underserved segment opportunity"}
    }
  }
}

RULES:
- Be specific and evidence-based
- "what_they_dont_do" is critical — this tells advisors where adjacency opportunities exist
- Include data sources for claims about pricing or market position`).catch((e) => ({
      section: 'client_positioning',
      error: e.message,
    })),

    // Synthesis 8: Expansion Strategy
    callChatGPTJSON(`You are a senior M&A strategist. Based on ALL available research, identify the top 3 expansion segments for ${companyName} (${website}).

RESEARCH ON PRODUCTS & SERVICES:
${research.products}

RESEARCH ON FINANCIALS:
${research.financials}

RESEARCH ON COMPETITORS:
${research.competitors}

RESEARCH ON M&A HISTORY:
${research.maHistory}

RESEARCH ON LEADERSHIP & STRATEGY:
${research.leadership}

${research.industryAnalysis ? `INDUSTRY ANALYSIS DATA:\n${research.industryAnalysis}` : ''}
${research.positioningSignals ? `POSITIONING SIGNALS:\n${research.positioningSignals}` : ''}

${context ? `CLIENT CONTEXT: ${context}` : ''}

---

CRITICAL ANTI-BULLSHIT RULES:
- Every recommendation must include: named segment with market size, growth rate with source, specific capability bridge from the client, competitive proof point
- Do NOT recommend a segment without explaining exactly WHICH client capability transfers
- Include exclusion criteria: what should the client NOT target and why
- Ban these words: synergy, leverage, optimize, strategic alignment, value creation
- If you cannot find real data for a segment, do NOT include it — better to have 2 strong recommendations than 3 weak ones

Respond in this EXACT JSON format:
{
  "_reasoning": "Think step by step: Given the client's current capabilities, what adjacent segments are real opportunities? What specific capabilities transfer? What proof exists that they could compete?",
  "expansion_strategy": {
    "strategic_rationale": "2-3 sentences: Why should this company expand and what gives them the right to win in adjacent segments? Include specific evidence.",
    "top_3_segments": [
      {
        "rank": 1,
        "segment": "Specific named segment (e.g., 'Industrial IoT sensors for predictive maintenance' not 'IoT')",
        "type": "Adjacent|New Market|Vertical Integration|Geographic",
        "market_size": "Size with source (e.g., '$12.3B in 2024, Grand View Research')",
        "growth": "CAGR with source (e.g., '14.2% CAGR 2024-2029, MarketsandMarkets')",
        "fragmentation": "Fragmented|Moderately concentrated|Concentrated — with top 3 players and their shares",
        "capability_bridge": "EXACTLY which current capability of ${companyName} transfers to this segment and how (e.g., 'Their polymer extrusion expertise directly applies to medical tubing, which uses the same base processes')",
        "competitive_proof": "Evidence that the client could compete: existing patents, customer overlap, technology similarity, or competitor precedent",
        "target_profile": "What an ideal acquisition target in this segment looks like: size, geography, capabilities",
        "exclusion_criteria": "What types of companies in this segment should the client NOT pursue and why",
        "entry_mode": "Acquisition|JV|Organic|Licensing — with reasoning"
      }
    ],
    "segments_to_avoid": "2-3 segments that might seem attractive but should be avoided, with specific reasons why"
  }
}

RULES:
- Quality over quantity. Include only segments where you have real data
- Every field must contain specific, sourced information
- The capability_bridge must name a SPECIFIC capability of ${companyName}, not a generic "manufacturing expertise"
- If the research doesn't support 3 segments, include only the ones with real evidence`).catch(
      (e) => ({ section: 'expansion_strategy', error: e.message })
    ),
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
          // Strip _reasoning fields before merging into sections
          stripReasoning(parsed);
          Object.assign(sections, parsed);
        }
      } catch (e) {
        console.error('Failed to parse synthesis result:', e.message);
      }
    } else if (result.error) {
      console.error(`Synthesis error for ${result.section}:`, result.error);
    }
  }

  // Validation pass on key sections
  const sectionsToValidate = ['industry_analysis', 'client_positioning', 'expansion_strategy'];
  const validationPromises = sectionsToValidate
    .filter((name) => sections[name])
    .map((name) =>
      validateSynthesisOutput(name, sections[name]).then((result) => ({ name, ...result }))
    );

  if (validationPromises.length > 0) {
    const validationResults = await Promise.all(validationPromises);
    for (const vr of validationResults) {
      if (!vr.valid) {
        console.warn(`[UTB Phase 2] Validation issues in ${vr.name}:`, vr.issues);
      } else {
        console.log(`[UTB Phase 2] Validation passed for ${vr.name}`);
      }
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

  // ========== SLIDE 3: INDUSTRY LANDSCAPE ==========
  {
    const indData = synthesis.industry_analysis || {};
    const valueChain = indData.value_chain || [];
    const segmentation = indData.segmentation || [];

    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'Industry Landscape');

    // === TOP HALF: Value Chain (y=1.3 to y=3.1) ===
    const stages = valueChain.slice(0, 6);
    const stageCount = Math.max(stages.length, 1);
    const boxW = 2.15;
    const boxH = 0.9;
    const totalChainW = stageCount * boxW + (stageCount - 1) * 0.3;
    const chainStartX = (13.333 - totalChainW) / 2;
    const chainY = 1.3;

    stages.forEach((stage, i) => {
      const x = chainStartX + i * (boxW + 0.3);
      // Determine box color based on company_presence
      const presence = (stage.company_presence || '').toLowerCase();
      let fillColor = 'E8E8E8'; // gray = not active
      let borderOpts = { type: 'none' };
      let textColor = COLORS.black;
      if (presence === 'active' || presence === 'yes') {
        fillColor = '007FFF'; // blue = active
        textColor = COLORS.white;
      } else if (presence === 'target' || presence === 'potential') {
        fillColor = 'D6E4F0'; // light blue = potential target
        borderOpts = { color: '007FFF', width: 1.5, dashType: 'dash' };
      }

      // Stage box
      slide.addShape(pptx.shapes.RECTANGLE, {
        x,
        y: chainY,
        w: boxW,
        h: boxH,
        fill: { color: fillColor },
        line: borderOpts,
        rectRadius: 0.05,
      });

      // Stage name
      slide.addText(stage.stage || stage.name || `Stage ${i + 1}`, {
        x,
        y: chainY,
        w: boxW,
        h: boxH,
        fontSize: 12,
        fontFace: 'Segoe UI',
        bold: true,
        color: textColor,
        align: 'center',
        valign: 'middle',
      });

      // Margin bar below box
      const margin = parseFloat(stage.margin) || 0;
      const barColor = margin > 20 ? '00A651' : margin >= 10 ? 'FFD700' : 'FF4444';
      slide.addShape(pptx.shapes.RECTANGLE, {
        x: x + 0.1,
        y: chainY + boxH + 0.05,
        w: boxW - 0.2,
        h: 0.12,
        fill: { color: barColor },
        line: { type: 'none' },
      });
      slide.addText(`${margin}%`, {
        x,
        y: chainY + boxH + 0.18,
        w: boxW,
        h: 0.2,
        fontSize: 9,
        fontFace: 'Segoe UI',
        color: COLORS.black,
        align: 'center',
      });

      // Arrow to next stage
      if (i < stages.length - 1) {
        slide.addShape(pptx.shapes.LINE, {
          x: x + boxW,
          y: chainY + boxH / 2,
          w: 0.3,
          h: 0,
          line: { color: COLORS.headerLine, width: 1.5, endArrowType: 'arrow' },
        });
      }
    });

    // === DOTTED DIVIDER at y=3.15 ===
    slide.addShape(pptx.shapes.LINE, {
      x: 0.38,
      y: 3.15,
      w: 12.54,
      h: 0,
      line: { color: COLORS.gray, width: 0.75, dashType: 'dash' },
    });

    // === BOTTOM HALF: Segmentation Table (y=3.3 to y=6.5) ===
    const segHeaderOpts = {
      fill: { color: COLORS.headerBg },
      color: COLORS.white,
      bold: false,
      align: 'center',
      valign: 'middle',
      border: { pt: 2, color: COLORS.white },
    };
    const segRows = [
      [
        { text: 'Segment', options: segHeaderOpts },
        { text: 'Market Size', options: segHeaderOpts },
        { text: 'CAGR', options: segHeaderOpts },
        { text: 'Fragmentation', options: segHeaderOpts },
        { text: 'Key Players', options: segHeaderOpts },
        { text: 'Client Position', options: segHeaderOpts },
      ],
    ];

    const segs = segmentation.slice(0, 5);
    segs.forEach((seg, i) => {
      const isLastRow = i === segs.length - 1;
      const rowBorder = isLastRow
        ? { pt: 0, color: COLORS.white }
        : { pt: 0.5, color: COLORS.gray, dashType: 'dash' };
      const cellOpts = {
        fill: { color: COLORS.white },
        color: COLORS.black,
        bold: false,
        align: 'center',
        valign: 'middle',
        border: [
          { pt: 0, color: COLORS.white },
          { pt: 0, color: COLORS.white },
          rowBorder,
          { pt: 0, color: COLORS.white },
        ],
      };

      // Client Position color
      const pos = (seg.client_position || '').toLowerCase();
      let posFill = 'E8E8E8'; // gray = not served
      let posColor = COLORS.black;
      if (pos.includes('active') || pos.includes('present')) {
        posFill = '00A651';
        posColor = COLORS.white;
      } else if (pos.includes('target')) {
        posFill = '007FFF';
        posColor = COLORS.white;
      } else if (pos.includes('high') || pos.includes('priority')) {
        posFill = 'FF8C00';
        posColor = COLORS.white;
      }

      segRows.push([
        {
          text: seg.segment || seg.name || '',
          options: {
            ...cellOpts,
            fill: { color: COLORS.labelBg },
            color: COLORS.white,
            align: 'center',
            border: { pt: 2, color: COLORS.white },
          },
        },
        { text: seg.market_size || seg.size || '', options: cellOpts },
        { text: seg.growth || seg.cagr || '', options: cellOpts },
        { text: seg.fragmentation || '', options: cellOpts },
        { text: seg.key_players || '', options: { ...cellOpts, align: 'left' } },
        {
          text: seg.client_position || '',
          options: { ...cellOpts, fill: { color: posFill }, color: posColor },
        },
      ]);
    });

    slide.addTable(segRows, {
      x: 0.38,
      y: 3.3,
      w: 12.54,
      colW: [2.5, 1.8, 1.2, 1.8, 3.0, 2.3],
      rowH: 0.5,
      fontFace: 'Segoe UI',
      fontSize: 14,
      valign: 'middle',
    });

    addFootnote(slide, 'Source: Industry reports, company disclosures');
  }

  // ========== SLIDE 4: CLIENT POSITIONING ==========
  {
    const posData = synthesis.client_positioning || {};
    const posSegments = posData.segments || [];
    const concentrations = posData.concentrations || {};

    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'Client Positioning');

    // === MAIN TABLE (y=1.3 to y=5.1) ===
    const posHeaderOpts = {
      fill: { color: COLORS.headerBg },
      color: COLORS.white,
      bold: false,
      align: 'center',
      valign: 'middle',
      border: { pt: 2, color: COLORS.white },
    };
    const posRows = [
      [
        { text: 'Segment', options: posHeaderOpts },
        { text: 'Client Revenue', options: posHeaderOpts },
        { text: 'Market Share', options: posHeaderOpts },
        { text: 'Position', options: posHeaderOpts },
        { text: 'Coverage', options: posHeaderOpts },
        { text: 'Key Competitors', options: posHeaderOpts },
        { text: 'Notes', options: posHeaderOpts },
      ],
    ];

    const posSegs = posSegments.slice(0, 6);
    posSegs.forEach((seg, i) => {
      const isLastRow = i === posSegs.length - 1;
      const rowBorder = isLastRow
        ? { pt: 0, color: COLORS.white }
        : { pt: 0.5, color: COLORS.gray, dashType: 'dash' };
      const cellOpts = {
        fill: { color: COLORS.white },
        color: COLORS.black,
        bold: false,
        align: 'center',
        valign: 'middle',
        border: [
          { pt: 0, color: COLORS.white },
          { pt: 0, color: COLORS.white },
          rowBorder,
          { pt: 0, color: COLORS.white },
        ],
      };

      // Position color
      const position = (seg.position || '').toLowerCase();
      let posFill = 'E8E8E8';
      let posTextColor = COLORS.black;
      if (position.includes('leader')) {
        posFill = '00A651';
        posTextColor = COLORS.white;
      } else if (position.includes('challenger')) {
        posFill = 'FF8C00';
        posTextColor = COLORS.white;
      } else if (position.includes('not') || position.includes('absent')) {
        posFill = 'FF4444';
        posTextColor = COLORS.white;
      }

      // Coverage unicode circles
      const cov = (seg.coverage || '').toLowerCase();
      let covSymbol = '○'; // none
      if (cov.includes('full') || cov === 'high') covSymbol = '●';
      else if (cov.includes('partial') || cov === 'medium') covSymbol = '◐';

      posRows.push([
        {
          text: seg.name || '',
          options: {
            ...cellOpts,
            fill: { color: COLORS.labelBg },
            color: COLORS.white,
            border: { pt: 2, color: COLORS.white },
          },
        },
        { text: seg.client_revenue || '', options: cellOpts },
        { text: seg.market_share || '', options: cellOpts },
        {
          text: seg.position || '',
          options: { ...cellOpts, fill: { color: posFill }, color: posTextColor },
        },
        { text: covSymbol, options: { ...cellOpts, fontSize: 16 } },
        { text: seg.key_competitors || '', options: { ...cellOpts, align: 'left' } },
        { text: seg.notes || '', options: { ...cellOpts, align: 'left' } },
      ]);
    });

    slide.addTable(posRows, {
      x: 0.38,
      y: 1.3,
      w: 12.54,
      colW: [2.2, 1.5, 1.2, 1.6, 1.2, 2.5, 2.4],
      rowH: 0.5,
      fontFace: 'Segoe UI',
      fontSize: 14,
      valign: 'middle',
    });

    // === 3 CALLOUT BOXES (y=5.3 to y=6.5) ===
    const boxW = 3.9;
    const boxH = 1.2;
    const boxY = 5.3;
    const boxGap = 0.22;
    const boxStartX = 0.38;

    // Box 1: Revenue Concentration (orange)
    const revConc = concentrations.revenue || {};
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: boxStartX,
      y: boxY,
      w: boxW,
      h: boxH,
      fill: { color: 'FFF3CC' },
      line: { color: 'FF8C00', width: 1.5 },
      rectRadius: 0.05,
    });
    slide.addText('Revenue Concentration', {
      x: boxStartX + 0.1,
      y: boxY + 0.05,
      w: boxW - 0.2,
      h: 0.35,
      fontSize: 12,
      fontFace: 'Segoe UI',
      bold: true,
      color: 'FF8C00',
      valign: 'top',
    });
    slide.addText(revConc.detail || 'Top segments drive majority of revenue', {
      x: boxStartX + 0.1,
      y: boxY + 0.4,
      w: boxW - 0.2,
      h: 0.7,
      fontSize: 11,
      fontFace: 'Segoe UI',
      color: COLORS.black,
      valign: 'top',
    });

    // Box 2: Customer/Geographic Concentration (red)
    const geoConc = concentrations.geographic || {};
    const box2X = boxStartX + boxW + boxGap;
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: box2X,
      y: boxY,
      w: boxW,
      h: boxH,
      fill: { color: 'FFE0E0' },
      line: { color: 'FF4444', width: 1.5 },
      rectRadius: 0.05,
    });
    slide.addText('Customer/Geographic Concentration', {
      x: box2X + 0.1,
      y: boxY + 0.05,
      w: boxW - 0.2,
      h: 0.35,
      fontSize: 12,
      fontFace: 'Segoe UI',
      bold: true,
      color: 'FF4444',
      valign: 'top',
    });
    slide.addText(geoConc.detail || 'Geographic and customer base analysis', {
      x: box2X + 0.1,
      y: boxY + 0.4,
      w: boxW - 0.2,
      h: 0.7,
      fontSize: 11,
      fontFace: 'Segoe UI',
      color: COLORS.black,
      valign: 'top',
    });

    // Box 3: White Space Opportunity (blue)
    const whiteSpace = concentrations.white_space || {};
    const box3X = box2X + boxW + boxGap;
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: box3X,
      y: boxY,
      w: boxW,
      h: boxH,
      fill: { color: 'D6E4F0' },
      line: { color: '007FFF', width: 1.5 },
      rectRadius: 0.05,
    });
    slide.addText('White Space Opportunity', {
      x: box3X + 0.1,
      y: boxY + 0.05,
      w: boxW - 0.2,
      h: 0.35,
      fontSize: 12,
      fontFace: 'Segoe UI',
      bold: true,
      color: '007FFF',
      valign: 'top',
    });
    slide.addText(whiteSpace.detail || 'Underserved segments and expansion areas', {
      x: box3X + 0.1,
      y: boxY + 0.4,
      w: boxW - 0.2,
      h: 0.7,
      fontSize: 11,
      fontFace: 'Segoe UI',
      color: COLORS.black,
      valign: 'top',
    });

    addFootnote(slide, 'Source: Company disclosures, market analysis');
  }

  // ========== SLIDE 5: PAST M&A ==========
  const dealHistory = maDeepDive.deal_history || maDeepDive.deal_stories || [];
  if (dealHistory.length > 0) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'Past M&A');

    // Header options: all columns center aligned, not bold, font 14
    const maHeaderOpts = {
      fill: { color: COLORS.headerBg },
      color: COLORS.white,
      bold: false,
      align: 'center',
      valign: 'middle',
      border: { pt: 3, color: COLORS.white },
    };

    const rows = [
      [
        { text: 'Year', options: maHeaderOpts },
        { text: 'Target', options: maHeaderOpts },
        { text: 'Target Country', options: maHeaderOpts },
        { text: 'Deal Type', options: maHeaderOpts },
        { text: 'Acquired Stake', options: maHeaderOpts },
        { text: 'Target Business', options: maHeaderOpts },
        { text: 'Rationale', options: maHeaderOpts },
      ],
    ];

    const deals = dealHistory.slice(0, 8);
    deals.forEach((deal, i) => {
      const isLastRow = i === deals.length - 1;
      // Light grey dotted border for row separation
      const rowBorder = isLastRow
        ? { pt: 0, color: COLORS.white }
        : { pt: 0.5, color: COLORS.gray, dashType: 'dash' };
      const dataCellOpts = {
        fill: { color: COLORS.white },
        color: COLORS.black,
        bold: false,
        align: 'center',
        valign: 'middle',
        border: [
          { pt: 0, color: COLORS.white },
          { pt: 0, color: COLORS.white },
          rowBorder,
          { pt: 0, color: COLORS.white },
        ],
      };
      rows.push([
        { text: deal.year || '', options: dataCellOpts },
        {
          text: deal.target || deal.deal || '',
          options: {
            fill: { color: COLORS.companyBg },
            color: COLORS.white,
            bold: false,
            align: 'center',
            valign: 'middle',
            border: { pt: 3, color: COLORS.white },
          },
        },
        { text: deal.target_country || '', options: dataCellOpts },
        { text: deal.deal_type || '', options: dataCellOpts },
        { text: deal.acquired_stake || '', options: dataCellOpts },
        { text: deal.target_business || '', options: dataCellOpts },
        { text: deal.strategic_rationale || '', options: { ...dataCellOpts, align: 'left' } },
      ]);
    });

    slide.addTable(rows, {
      x: 0.38,
      y: 1.2,
      w: 12.54,
      colW: [0.8, 2.2, 1.3, 1.2, 1.2, 2.5, 3.34],
      rowH: 0.5,
      fontFace: 'Segoe UI',
      fontSize: 14,
      valign: 'middle',
    });

    addFootnote(slide);
  }

  // ========== SLIDE 6: EXPANSION STRATEGY ==========
  {
    const expData = synthesis.expansion_strategy || {};
    const priorities = expData.top_3_segments || [];
    const vectors = expData.top_3_segments || []; // Same data for both cards and table
    const exclusions =
      typeof expData.segments_to_avoid === 'string'
        ? expData.segments_to_avoid
        : Array.isArray(expData.segments_to_avoid)
          ? expData.segments_to_avoid
              .map((s) =>
                typeof s === 'string' ? s : `${s.segment || s.name}: ${s.why || s.reason || ''}`
              )
              .join(' | ')
          : '';

    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'Expansion Strategy');

    // === TOP: 3 Priority Cards (y=1.6 to y=3.4) ===
    const cardW = 4.0;
    const cardH = 1.8;
    const cardY = 1.6;
    const cardGap = 0.22;
    const cardStartX = (13.333 - 3 * cardW - 2 * cardGap) / 2;
    const priorityColors = ['1524A9', '011AB7', '007FFF'];

    const topPriorities = priorities.slice(0, 3);
    topPriorities.forEach((p, i) => {
      const x = cardStartX + i * (cardW + cardGap);
      const pColor = priorityColors[i] || '007FFF';

      // Card header (dark colored)
      const headerH = 0.45;
      slide.addShape(pptx.shapes.RECTANGLE, {
        x,
        y: cardY,
        w: cardW,
        h: headerH,
        fill: { color: pColor },
        line: { type: 'none' },
        rectRadius: 0.05,
      });

      // Priority label + segment name
      const pType = (p.type || p.direction || '').toUpperCase();
      const badge = pType.includes('VERTICAL')
        ? 'VERTICAL'
        : pType.includes('GEO')
          ? 'GEOGRAPHIC'
          : 'HORIZONTAL';
      slide.addText(`#${i + 1} ${p.segment || p.name || 'Priority'}`, {
        x: x + 0.1,
        y: cardY,
        w: cardW - 1.4,
        h: headerH,
        fontSize: 12,
        fontFace: 'Segoe UI',
        bold: true,
        color: COLORS.white,
        valign: 'middle',
      });
      // Badge
      slide.addShape(pptx.shapes.RECTANGLE, {
        x: x + cardW - 1.2,
        y: cardY + 0.08,
        w: 1.05,
        h: 0.28,
        fill: { color: COLORS.white },
        line: { type: 'none' },
        rectRadius: 0.03,
      });
      slide.addText(badge, {
        x: x + cardW - 1.2,
        y: cardY + 0.08,
        w: 1.05,
        h: 0.28,
        fontSize: 8,
        fontFace: 'Segoe UI',
        bold: true,
        color: pColor,
        align: 'center',
        valign: 'middle',
      });

      // Card body (light gray)
      const bodyH = cardH - headerH;
      slide.addShape(pptx.shapes.RECTANGLE, {
        x,
        y: cardY + headerH,
        w: cardW,
        h: bodyH,
        fill: { color: 'F5F5F5' },
        line: { color: 'E0E0E0', width: 0.5 },
      });

      // Card body content
      const bodyLines = [
        `Market Size: ${p.market_size || 'N/A'}`,
        `CAGR: ${p.growth || p.cagr || 'N/A'}`,
        `Rationale: ${p.capability_bridge || p.rationale || 'Strategic fit'}`,
        `Entry Mode: ${p.entry_mode || 'Acquisition'}`,
      ].join('\n');
      slide.addText(bodyLines, {
        x: x + 0.1,
        y: cardY + headerH + 0.05,
        w: cardW - 0.2,
        h: bodyH - 0.1,
        fontSize: 10,
        fontFace: 'Segoe UI',
        color: COLORS.black,
        valign: 'top',
        lineSpacing: 14,
      });
    });

    // === DIVIDER at y=3.5 ===
    slide.addShape(pptx.shapes.LINE, {
      x: 0.38,
      y: 3.5,
      w: 12.54,
      h: 0,
      line: { color: COLORS.gray, width: 0.75, dashType: 'dash' },
    });

    // === EXPANSION VECTOR TABLE (y=3.6 to y=5.7) ===
    const vecHeaderOpts = {
      fill: { color: COLORS.headerBg },
      color: COLORS.white,
      bold: false,
      align: 'center',
      valign: 'middle',
      border: { pt: 2, color: COLORS.white },
    };
    const vecRows = [
      [
        { text: 'Priority', options: vecHeaderOpts },
        { text: 'Direction', options: vecHeaderOpts },
        { text: 'Target Segment', options: vecHeaderOpts },
        { text: 'Market Size', options: vecHeaderOpts },
        { text: 'Growth', options: vecHeaderOpts },
        { text: 'Capability Fit', options: vecHeaderOpts },
        { text: 'Rationale', options: vecHeaderOpts },
        { text: 'Status', options: vecHeaderOpts },
      ],
    ];

    const vecData = vectors.slice(0, 5);
    vecData.forEach((v, i) => {
      const isLastRow = i === vecData.length - 1;
      const rowBorder = isLastRow
        ? { pt: 0, color: COLORS.white }
        : { pt: 0.5, color: COLORS.gray, dashType: 'dash' };
      const cellOpts = {
        fill: { color: COLORS.white },
        color: COLORS.black,
        bold: false,
        align: 'center',
        valign: 'middle',
        border: [
          { pt: 0, color: COLORS.white },
          { pt: 0, color: COLORS.white },
          rowBorder,
          { pt: 0, color: COLORS.white },
        ],
      };

      // Direction styling
      const dir = (v.type || v.direction || '').toLowerCase();
      const isVertical = dir.includes('vertical');
      const dirText = isVertical ? '\u2191 Vertical' : '\u2192 Horizontal';
      const dirFill = isVertical ? '6A0DAD' : '007FFF';

      // Entry mode / status color - top priorities default to "Pursue" (green)
      const entryMode = (v.entry_mode || v.status || '').toLowerCase();
      let statusFill = '00A651';
      let statusColor = COLORS.white; // Default green for pursue
      if (entryMode.includes('monitor') || entryMode.includes('watch')) {
        statusFill = 'FFD700';
        statusColor = COLORS.black;
      } else if (entryMode.includes('exclude') || entryMode.includes('avoid')) {
        statusFill = 'FF4444';
        statusColor = COLORS.white;
      }

      vecRows.push([
        { text: String(v.rank || v.priority || i + 1), options: { ...cellOpts, bold: true } },
        {
          text: dirText,
          options: { ...cellOpts, fill: { color: dirFill }, color: COLORS.white, fontSize: 11 },
        },
        { text: v.segment || v.target_segment || '', options: { ...cellOpts, align: 'left' } },
        { text: v.market_size || '', options: cellOpts },
        { text: v.growth || '', options: cellOpts },
        { text: v.fragmentation || v.capability_fit || '', options: cellOpts },
        { text: v.capability_bridge || v.rationale || '', options: { ...cellOpts, align: 'left' } },
        {
          text: v.entry_mode || v.status || 'Pursue',
          options: { ...cellOpts, fill: { color: statusFill }, color: statusColor },
        },
      ]);
    });

    slide.addTable(vecRows, {
      x: 0.38,
      y: 3.6,
      w: 12.54,
      colW: [0.8, 1.2, 2.5, 1.2, 0.8, 1.2, 3.0, 1.9],
      rowH: 0.38,
      fontFace: 'Segoe UI',
      fontSize: 14,
      valign: 'middle',
    });

    // === EXCLUSION CRITERIA BAR (y=5.9 to y=6.5) ===
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: 0.38,
      y: 5.9,
      w: 12.54,
      h: 0.6,
      fill: { color: 'F5F5F5' },
      line: { color: 'E0E0E0', width: 0.5 },
      rectRadius: 0.05,
    });
    slide.addText('Exclusion Criteria:', {
      x: 0.5,
      y: 5.9,
      w: 2.0,
      h: 0.6,
      fontSize: 11,
      fontFace: 'Segoe UI',
      bold: true,
      color: 'FF4444',
      valign: 'middle',
    });
    slide.addText(exclusions || 'Segments with low strategic fit or high regulatory barriers', {
      x: 2.5,
      y: 5.9,
      w: 10.3,
      h: 0.6,
      fontSize: 11,
      fontFace: 'Segoe UI',
      color: COLORS.black,
      valign: 'middle',
    });

    addFootnote(slide, 'Source: Market analysis, strategic assessment');
  }

  // ========== SLIDE 7: FINANCIAL BAR CHART (if revenue history available) ==========
  const fin = synthesis.financials || {};
  const revenueHistory = fin.revenue_history || [];

  if (revenueHistory.length >= 2) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'Financial Highlights');

    // Chart data
    const chartData = [
      {
        name: 'Revenue',
        labels: revenueHistory.map((r) => r.year),
        values: revenueHistory.map((r) => r.revenue),
      },
    ];

    // Add bar chart - font Segoe UI with font size 14, Y-axis includes unit
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
      dataLabelFontSize: 14,
      dataLabelFontFace: 'Segoe UI',
      dataLabelColor: COLORS.black,
      catAxisTitle: '',
      catAxisTitleFontSize: 14,
      catAxisLabelFontSize: 14,
      catAxisLabelFontFace: 'Segoe UI',
      valAxisTitle: fin.revenue_unit || 'JPY 100M',
      valAxisTitleFontSize: 14,
      valAxisLabelFontSize: 14,
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

  const tracker = createTracker('utb', email, { companyName, website });

  trackingContext.run(tracker, async () => {
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

      await tracker.finish({ status: 'success', companyName });
    } catch (error) {
      console.error('[UTB] Error:', error);
      await tracker.finish({ status: 'error', error: error.message }).catch(() => {});
      await sendEmail(email, `UTB Error - ${companyName}`, `<p>Error: ${error.message}</p>`).catch(
        () => {}
      );
    }
  }); // end trackingContext.run
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
