'use strict';

const fetch = require('node-fetch');
const { recordTokens } = require('./shared/tracking');

/**
 * Annual Report Discovery Module
 * Finds annual report/investor presentation PDFs for companies via Perplexity search.
 * Fallback chain: annual report PDF → investor presentation PDF → web description → no data.
 */

const BATCH_SIZE = 5; // Companies per Perplexity query
const PERPLEXITY_TIMEOUT = 90000;

/**
 * Call Perplexity sonar-pro API
 */
async function callPerplexity(prompt) {
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
      timeout: PERPLEXITY_TIMEOUT,
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
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('Perplexity error:', error.message);
    return '';
  }
}

/**
 * Search for annual report PDF URLs for a batch of companies.
 * Returns array of { companyName, pdfUrl, source } objects.
 */
async function searchAnnualReportBatch(companies) {
  const companyList = companies
    .map((c, i) => `${i + 1}. "${c.name}" (${c.country || 'Unknown'})`)
    .join('\n');

  const prompt = `Find the most recent annual report PDF or investor presentation PDF URL for each company below.
Return ONLY a JSON array with one object per company. Each object must have:
- "companyName": the company name exactly as given
- "pdfUrl": direct URL to PDF file (must end in .pdf or be a direct PDF link), or null if not found
- "source": "annual_report" or "investor_presentation" or "not_found"

Companies:
${companyList}

IMPORTANT: Only return direct PDF download URLs. Do not return HTML pages. If you cannot find a direct PDF URL, set pdfUrl to null.
Return ONLY valid JSON array, no other text.`;

  const result = await callPerplexity(prompt);
  if (!result)
    return companies.map((c) => ({ companyName: c.name, pdfUrl: null, source: 'not_found' }));

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map((item, idx) => ({
        companyName: item.companyName || companies[idx]?.name || 'Unknown',
        pdfUrl: item.pdfUrl || null,
        source: item.source || (item.pdfUrl ? 'annual_report' : 'not_found'),
      }));
    }
  } catch (error) {
    console.error('Failed to parse annual report search results:', error.message);
  }

  return companies.map((c) => ({ companyName: c.name, pdfUrl: null, source: 'not_found' }));
}

/**
 * Fallback: Search for investor presentation PDF for companies that had no annual report.
 */
async function searchInvestorPresentationBatch(companies) {
  const companyList = companies
    .map((c, i) => `${i + 1}. "${c.name}" (${c.country || 'Unknown'})`)
    .join('\n');

  const prompt = `Find the most recent investor presentation or corporate overview PDF URL for each company below.
Return ONLY a JSON array with one object per company:
- "companyName": company name exactly as given
- "pdfUrl": direct PDF URL or null
- "source": "investor_presentation" or "not_found"

Companies:
${companyList}

Return ONLY valid JSON array, no other text.`;

  const result = await callPerplexity(prompt);
  if (!result)
    return companies.map((c) => ({ companyName: c.name, pdfUrl: null, source: 'not_found' }));

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map((item, idx) => ({
        companyName: item.companyName || companies[idx]?.name || 'Unknown',
        pdfUrl: item.pdfUrl || null,
        source: item.source || (item.pdfUrl ? 'investor_presentation' : 'not_found'),
      }));
    }
  } catch (error) {
    console.error('Failed to parse investor presentation search results:', error.message);
  }

  return companies.map((c) => ({ companyName: c.name, pdfUrl: null, source: 'not_found' }));
}

/**
 * Fallback: Get web-based business description for companies with no PDF.
 */
async function searchWebDescriptionBatch(companies) {
  const companyList = companies
    .map((c, i) => `${i + 1}. "${c.name}" (${c.country || 'Unknown'})`)
    .join('\n');

  const prompt = `For each company below, provide a detailed business description including:
- What they actually do (primary business)
- Revenue segments/divisions if known
- Geographic focus
- Business model (B2B/B2C, manufacturing/services/SaaS/etc)
- Key products or services

Return ONLY a JSON array with one object per company:
- "companyName": company name
- "businessDescription": 2-3 sentences of what they do
- "primaryIndustry": specific sub-industry
- "businessModel": e.g. "B2B manufacturing", "B2C retail", "SaaS"
- "geographicFocus": primary regions
- "source": "web_search"

Companies:
${companyList}

Return ONLY valid JSON array, no other text.`;

  const result = await callPerplexity(prompt);
  if (!result) return companies.map((c) => ({ companyName: c.name, source: 'no_data' }));

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map((item, idx) => ({
        companyName: item.companyName || companies[idx]?.name || 'Unknown',
        businessDescription: item.businessDescription || null,
        primaryIndustry: item.primaryIndustry || null,
        businessModel: item.businessModel || null,
        geographicFocus: item.geographicFocus || null,
        source: 'web_search',
      }));
    }
  } catch (error) {
    console.error('Failed to parse web description results:', error.message);
  }

  return companies.map((c) => ({ companyName: c.name, source: 'no_data' }));
}

/**
 * Main discovery function: Find annual reports for all companies.
 * Implements the full fallback chain:
 * 1. Annual report PDF search
 * 2. Investor presentation PDF search (for those without annual report)
 * 3. Web description search (for those without any PDF)
 *
 * @param {Array} companies - Array of company objects with at least { name, country }
 * @returns {Array} Array of discovery results with pdfUrl and/or web description
 */
async function discoverAnnualReports(companies) {
  console.log(`\n--- Annual Report Discovery: ${companies.length} companies ---`);

  const results = new Map(); // companyName -> discovery result

  // Step 1: Search for annual report PDFs in batches
  console.log('Step 1: Searching for annual report PDFs...');
  const batches = [];
  for (let i = 0; i < companies.length; i += BATCH_SIZE) {
    batches.push(companies.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`  Batch ${i + 1}/${batches.length}: ${batch.map((c) => c.name).join(', ')}`);
    const batchResults = await searchAnnualReportBatch(batch);
    batchResults.forEach((r) => results.set(r.companyName, r));
  }

  // Step 2: For companies without PDF, search investor presentations
  const noPdfCompanies = companies.filter((c) => {
    const r = results.get(c.name);
    return !r || !r.pdfUrl;
  });

  if (noPdfCompanies.length > 0) {
    console.log(
      `Step 2: Searching investor presentations for ${noPdfCompanies.length} companies...`
    );
    const ipBatches = [];
    for (let i = 0; i < noPdfCompanies.length; i += BATCH_SIZE) {
      ipBatches.push(noPdfCompanies.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < ipBatches.length; i++) {
      const batch = ipBatches[i];
      const batchResults = await searchInvestorPresentationBatch(batch);
      batchResults.forEach((r) => {
        if (r.pdfUrl) {
          results.set(r.companyName, r);
        }
      });
    }
  }

  // Step 3: For companies still without PDF, get web descriptions
  const stillNoPdfCompanies = companies.filter((c) => {
    const r = results.get(c.name);
    return !r || !r.pdfUrl;
  });

  if (stillNoPdfCompanies.length > 0) {
    console.log(`Step 3: Getting web descriptions for ${stillNoPdfCompanies.length} companies...`);
    const webBatches = [];
    for (let i = 0; i < stillNoPdfCompanies.length; i += BATCH_SIZE) {
      webBatches.push(stillNoPdfCompanies.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < webBatches.length; i++) {
      const batch = webBatches[i];
      const batchResults = await searchWebDescriptionBatch(batch);
      batchResults.forEach((r) => results.set(r.companyName, r));
    }
  }

  // Compile final results
  const pdfFound = [...results.values()].filter((r) => r.pdfUrl).length;
  const webFound = [...results.values()].filter((r) => r.source === 'web_search').length;
  const noData = companies.length - pdfFound - webFound;
  console.log(
    `Discovery complete: ${pdfFound} PDFs found, ${webFound} web descriptions, ${noData} no data`
  );

  return companies.map((c) => results.get(c.name) || { companyName: c.name, source: 'no_data' });
}

module.exports = {
  discoverAnnualReports,
  searchAnnualReportBatch,
  searchInvestorPresentationBatch,
  searchWebDescriptionBatch,
};
