'use strict';

const fetch = require('node-fetch');
const { recordTokens } = require('./shared/tracking');

/**
 * PDF Extractor Module
 * Downloads annual report PDFs and extracts structured business profiles via Gemini 2.5 Flash.
 * Memory-safe: processes max 3 PDFs concurrently, frees buffers immediately.
 */

const MAX_CONCURRENT_PDFS = 3;
const PDF_DOWNLOAD_TIMEOUT = 30000; // 30 seconds
const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20MB max per PDF
const GEMINI_TIMEOUT = 120000; // 2 minutes for extraction

/**
 * Download a PDF from URL into a Buffer.
 * Returns null if download fails or file is too large.
 */
async function downloadPdf(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PDF_DOWNLOAD_TIMEOUT);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/pdf,*/*',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`PDF download failed for ${url}: HTTP ${response.status}`);
      return null;
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_PDF_SIZE) {
      console.warn(`PDF too large (${(contentLength / 1024 / 1024).toFixed(1)}MB): ${url}`);
      return null;
    }

    const buffer = await response.buffer();
    if (buffer.length > MAX_PDF_SIZE) {
      console.warn(
        `PDF too large after download (${(buffer.length / 1024 / 1024).toFixed(1)}MB): ${url}`
      );
      return null;
    }

    return buffer;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`PDF download timeout for ${url}`);
    } else {
      console.error(`PDF download error for ${url}: ${error.message}`);
    }
    return null;
  }
}

/**
 * Extract structured business profile from a PDF using Gemini 2.5 Flash.
 * Sends PDF as base64 inline data to Gemini's multimodal API.
 */
async function extractProfileFromPdf(pdfBuffer, companyName) {
  try {
    const base64Pdf = pdfBuffer.toString('base64');

    const requestBody = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: base64Pdf,
              },
            },
            {
              text: `You are extracting a structured business profile from this annual report or investor presentation for "${companyName}".

Extract the following information and return ONLY valid JSON (no markdown, no code blocks):

{
  "companyName": "official registered name as stated in document",
  "businessDescription": "2-3 sentences of what they actually do - be specific about products/services",
  "primaryIndustry": "specific sub-industry (e.g. 'payroll outsourcing' not just 'IT services')",
  "revenueSegments": [
    {"segment": "name", "revenueShare": "XX%", "description": "what this segment does"}
  ],
  "geographicBreakdown": [
    {"region": "name", "revenueShare": "XX%"}
  ],
  "businessModel": "B2B manufacturing / B2C retail / SaaS / distribution / etc - be specific",
  "keyProducts": ["product1", "product2"],
  "keyCustomers": ["if mentioned in the report"],
  "competitorsNamedInReport": ["if mentioned"],
  "revenueRecurringVsOneTime": "recurring / project-based / mixed",
  "verticalFocus": "specific vertical if any (e.g. 'healthcare', 'automotive')",
  "fiscalYear": "the fiscal year this report covers"
}

IMPORTANT:
- Extract from the ACTUAL document content, not your prior knowledge
- If a field is not mentioned in the document, use null
- Revenue shares should add up to approximately 100%
- Be specific and precise - this data will be used for peer comparison
- Output language must be English regardless of document language`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.0,
        responseMimeType: 'application/json',
      },
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        timeout: GEMINI_TIMEOUT,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `Gemini Flash PDF extraction HTTP error ${response.status}:`,
        errorText.substring(0, 200)
      );
      return null;
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
      console.error(`Gemini Flash extraction error for ${companyName}:`, data.error.message);
      return null;
    }

    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!resultText) {
      console.warn(`Gemini Flash returned empty extraction for ${companyName}`);
      return null;
    }

    try {
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      console.error(`Failed to parse Gemini extraction for ${companyName}:`, parseError.message);
    }

    return null;
  } catch (error) {
    console.error(`PDF extraction error for ${companyName}:`, error.message);
    return null;
  }
}

/**
 * Process a single company: download PDF → extract profile.
 * Returns the business profile or null.
 */
async function processCompanyPdf(discoveryResult) {
  const { companyName, pdfUrl } = discoveryResult;

  if (!pdfUrl) return null;

  console.log(`  Downloading PDF for ${companyName}: ${pdfUrl.substring(0, 80)}...`);
  let pdfBuffer = await downloadPdf(pdfUrl);

  if (!pdfBuffer) {
    console.warn(`  Failed to download PDF for ${companyName}`);
    return null;
  }

  console.log(
    `  Extracting profile from PDF (${(pdfBuffer.length / 1024).toFixed(0)}KB) for ${companyName}...`
  );
  const profile = await extractProfileFromPdf(pdfBuffer, companyName);

  // Free buffer immediately after extraction
  pdfBuffer = null;

  if (profile) {
    profile.dataSource = discoveryResult.source || 'annual_report';
    console.log(
      `  ✓ Extracted profile for ${companyName}: ${profile.primaryIndustry || 'unknown industry'}`
    );
  } else {
    console.warn(`  ✗ Failed to extract profile for ${companyName}`);
  }

  return profile;
}

/**
 * Extract business profiles from PDFs for all companies with discovered PDF URLs.
 * Processes max MAX_CONCURRENT_PDFS at a time for memory safety.
 *
 * @param {Array} discoveryResults - Output from annualReportDiscovery.discoverAnnualReports()
 * @returns {Map} companyName → business profile object
 */
async function extractBusinessProfiles(discoveryResults) {
  console.log(`\n--- PDF Extraction: Processing ${discoveryResults.length} companies ---`);

  const profiles = new Map();
  const companiesWithPdf = discoveryResults.filter((r) => r.pdfUrl);
  const companiesWithWebData = discoveryResults.filter(
    (r) => r.source === 'web_search' && !r.pdfUrl
  );

  console.log(`  ${companiesWithPdf.length} companies have PDFs to process`);
  console.log(`  ${companiesWithWebData.length} companies have web descriptions only`);

  // Process PDFs in batches of MAX_CONCURRENT_PDFS
  for (let i = 0; i < companiesWithPdf.length; i += MAX_CONCURRENT_PDFS) {
    const batch = companiesWithPdf.slice(i, i + MAX_CONCURRENT_PDFS);
    console.log(
      `\n  PDF batch ${Math.floor(i / MAX_CONCURRENT_PDFS) + 1}/${Math.ceil(companiesWithPdf.length / MAX_CONCURRENT_PDFS)}: ${batch.map((r) => r.companyName).join(', ')}`
    );

    const batchResults = await Promise.all(batch.map((r) => processCompanyPdf(r)));

    batchResults.forEach((profile, idx) => {
      if (profile) {
        profiles.set(batch[idx].companyName, profile);
      }
    });

    // Explicit GC between batches if available
    if (global.gc) {
      global.gc();
    }
  }

  // Add web description data as profiles (already structured from discovery)
  companiesWithWebData.forEach((r) => {
    profiles.set(r.companyName, {
      companyName: r.companyName,
      businessDescription: r.businessDescription || null,
      primaryIndustry: r.primaryIndustry || null,
      businessModel: r.businessModel || null,
      geographicBreakdown: r.geographicFocus
        ? [{ region: r.geographicFocus, revenueShare: 'N/A' }]
        : [],
      revenueSegments: [],
      keyProducts: [],
      keyCustomers: [],
      competitorsNamedInReport: [],
      revenueRecurringVsOneTime: null,
      verticalFocus: null,
      dataSource: 'web_search',
    });
  });

  const pdfExtracted = [...profiles.values()].filter(
    (p) => p.dataSource === 'annual_report' || p.dataSource === 'investor_presentation'
  ).length;
  const webFallback = [...profiles.values()].filter((p) => p.dataSource === 'web_search').length;
  console.log(
    `\nExtraction complete: ${pdfExtracted} from PDFs, ${webFallback} from web, ${discoveryResults.length - profiles.size} no data`
  );

  return profiles;
}

/**
 * Format a business profile into a concise text summary for AI evaluation prompts.
 */
function formatProfileForPrompt(profile) {
  if (!profile) return '';

  const parts = [];

  if (profile.businessDescription) {
    parts.push(`Business: ${profile.businessDescription}`);
  }

  if (profile.revenueSegments && profile.revenueSegments.length > 0) {
    const segments = profile.revenueSegments
      .map((s) => `${s.segment} (${s.revenueShare || 'N/A'})`)
      .join(', ');
    parts.push(`Revenue Segments: ${segments}`);
  }

  if (profile.geographicBreakdown && profile.geographicBreakdown.length > 0) {
    const geo = profile.geographicBreakdown
      .map((g) => `${g.region} (${g.revenueShare || 'N/A'})`)
      .join(', ');
    parts.push(`Geography: ${geo}`);
  }

  if (profile.businessModel) {
    parts.push(`Business Model: ${profile.businessModel}`);
  }

  if (profile.primaryIndustry) {
    parts.push(`Industry: ${profile.primaryIndustry}`);
  }

  if (profile.verticalFocus) {
    parts.push(`Vertical: ${profile.verticalFocus}`);
  }

  if (profile.dataSource) {
    const sourceLabel =
      profile.dataSource === 'web_search'
        ? 'Web Search'
        : `${profile.fiscalYear || ''} Annual Report`.trim();
    parts.push(`Source: ${sourceLabel}`);
  }

  return parts.join('\n         ');
}

module.exports = {
  extractBusinessProfiles,
  processCompanyPdf,
  downloadPdf,
  extractProfileFromPdf,
  formatProfileForPrompt,
};
