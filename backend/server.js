require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// Check required environment variables
const requiredEnvVars = ['PERPLEXITY_API_KEY', 'GEMINI_API_KEY', 'BREVO_API_KEY'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}

// Send email using Brevo API
async function sendEmail(to, subject, html) {
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'xvasjack@gmail.com';
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Find Target', email: senderEmail },
      to: [{ email: to }],
      subject: subject,
      htmlContent: html
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Email failed: ${error}`);
  }

  return await response.json();
}

// ============ AI TOOLS ============

// Gemini - for extraction (fast, good at structured output)
async function callGemini(prompt) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      timeout: 60000
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (error) {
    console.error('Gemini error:', error.message);
    return '';
  }
}

// Perplexity - for SEARCH (has real web access, won't hallucinate)
async function callPerplexity(prompt) {
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{ role: 'user', content: prompt }]
      }),
      timeout: 90000
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('Perplexity error:', error.message);
    return '';
  }
}

// ============ SEARCH QUERIES (Perplexity only - real web search) ============

function generateSearchQueries(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  const outputFormat = `For each company provide: company_name, website URL (must start with http), headquarters location (City, Country format). List all companies you can find.`;

  // Core searches
  queries.push(
    `List all ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} suppliers and distributors based in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies in ${country} business directories. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors from ${country} at trade shows. Not ${exclusion}. ${outputFormat}`,
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Small and medium ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} vendors and dealers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} trading companies in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // Country-specific searches
  for (const c of countries) {
    queries.push(
      `${business} companies headquartered in ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `Local ${business} firms in ${c}. Not ${exclusion}. ${outputFormat}`,
      `${business} companies in major cities of ${c}. Exclude ${exclusion}. ${outputFormat}`
    );
  }

  // Industry association and directory searches
  queries.push(
    `${business} companies registered in trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies in Yellow Pages or Kompass for ${country}. Not ${exclusion}. ${outputFormat}`
  );

  return queries;
}

// ============ EXTRACTION WITH GEMINI ============

async function extractCompanies(text, country) {
  if (!text || text.length < 50) return [];

  try {
    const prompt = `Extract company information from this text. Return ONLY valid JSON:
{"companies": [{"company_name": "...", "website": "...", "hq": "..."}]}

Rules:
- website MUST start with http:// or https:// - skip companies without valid URLs
- hq must be "City, Country" format
- Only include companies headquartered in: ${country}
- Skip any company without a valid website URL
- Return {"companies": []} if none found

Text to extract from:
${text}`;

    const response = await callGemini(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed.companies) ? parsed.companies : [];
  } catch (e) {
    console.error('Extraction error:', e.message);
    return [];
  }
}

// ============ DEDUPLICATION ============

function normalizeCompanyName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\s+(sdn\.?\s*bhd\.?|bhd\.?|pte\.?\s*ltd\.?|ltd\.?|inc\.?|corp\.?|corporation|co\.?\s*ltd\.?|llc|gmbh|s\.?a\.?|pt\.?|private\s*limited|limited)$/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWebsite(url) {
  if (!url) return '';
  return url.toLowerCase()
    .replace(/\/$/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');
}

function dedupeCompanies(allCompanies) {
  const seenWebsites = new Map();
  const seenNames = new Map();
  const results = [];

  for (const c of allCompanies) {
    if (!c || !c.website || !c.company_name) continue;
    if (!c.website.startsWith('http')) continue;

    const websiteKey = normalizeWebsite(c.website);
    const nameKey = normalizeCompanyName(c.company_name);

    // Skip if website or name already seen
    if (seenWebsites.has(websiteKey) || seenNames.has(nameKey)) continue;

    seenWebsites.set(websiteKey, true);
    seenNames.set(nameKey, true);
    results.push(c);
  }

  return results;
}

// ============ WEBSITE VALIDATION (Real HTTP check) ============

async function checkWebsiteExists(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller.signal,
      redirect: 'follow'
    });

    clearTimeout(timeout);
    return response.ok || response.status === 403 || response.status === 405;
  } catch (e) {
    // Try GET if HEAD fails
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        signal: controller.signal,
        redirect: 'follow'
      });

      clearTimeout(timeout);
      return response.ok;
    } catch (e2) {
      return false;
    }
  }
}

async function fetchWebsiteContent(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller.signal,
      redirect: 'follow'
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();
    const cleanText = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 8000);

    return cleanText.length > 100 ? cleanText : null;
  } catch (e) {
    return null;
  }
}

// ============ VALIDATION WITH GEMINI ============

async function validateCompany(company, business, country, exclusion, pageText) {
  try {
    const prompt = `Validate if this company matches the search criteria.

Company: ${company.company_name}
Website: ${company.website}
Claimed HQ: ${company.hq}

Search Criteria:
- Business type: ${business}
- Must be headquartered in: ${country}
- Exclusions: ${exclusion}

Website content (first 4000 chars):
${pageText ? pageText.substring(0, 4000) : 'WEBSITE COULD NOT BE ACCESSED'}

VALIDATION RULES:
1. WEBSITE: If website could not be accessed → REJECT (fake website)
2. LOCATION: HQ must be in one of: ${country}. If clearly elsewhere → REJECT
3. BUSINESS: Must be related to "${business}". Be reasonable but reject if completely unrelated.
4. EXCLUSIONS for "${exclusion}":
   - If "large" or "MNC": Reject Fortune 500, multinationals with global offices, listed companies
   - If "distributor": Reject if ONLY a distributor (not if they also manufacture/trade)
   - If "manufacturer": Reject if ONLY a manufacturer
5. SPAM: Reject business directories, marketplaces, aggregator sites

Return ONLY JSON: {"valid": true/false, "reason": "one sentence", "corrected_hq": "City, Country or null"}`;

    const response = await callGemini(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { valid: false, reason: 'Parse error' };

    const result = JSON.parse(jsonMatch[0]);
    return {
      valid: result.valid === true,
      reason: result.reason || '',
      corrected_hq: result.corrected_hq || company.hq
    };
  } catch (e) {
    console.error('Validation error:', e.message);
    return { valid: false, reason: 'Validation error' };
  }
}

// ============ MAIN SEARCH FUNCTION ============

async function comprehensiveSearch(business, country, exclusion) {
  console.log('Starting search with Perplexity (real web search)...');
  const startTime = Date.now();

  const queries = generateSearchQueries(business, country, exclusion);
  console.log(`  Running ${queries.length} Perplexity queries...`);

  // Run all Perplexity searches in parallel
  const searchResults = await Promise.all(queries.map(q => callPerplexity(q)));

  console.log(`  Searches completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Extract companies from all results
  console.log(`  Extracting companies from ${searchResults.length} responses...`);
  const extractionResults = await Promise.all(
    searchResults.map(text => extractCompanies(text, country))
  );

  // Flatten and dedupe
  const allCompanies = extractionResults.flat();
  const uniqueCompanies = dedupeCompanies(allCompanies);

  console.log(`  Raw: ${allCompanies.length}, Unique: ${uniqueCompanies.length}`);
  console.log(`Search completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return uniqueCompanies;
}

// ============ VALIDATION PIPELINE ============

async function validateCompanies(companies, business, country, exclusion) {
  console.log(`\nValidating ${companies.length} companies...`);
  const startTime = Date.now();
  const validated = [];
  const batchSize = 10;

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);

    // Step 1: Check if websites actually exist (parallel)
    console.log(`  Checking websites ${i + 1}-${Math.min(i + batchSize, companies.length)}...`);
    const websiteChecks = await Promise.all(batch.map(c => checkWebsiteExists(c.website)));

    // Filter to only companies with working websites
    const companiesWithWorkingWebsites = batch.filter((_, idx) => websiteChecks[idx]);
    const rejected = batch.length - companiesWithWorkingWebsites.length;
    if (rejected > 0) {
      console.log(`    Rejected ${rejected} with dead/fake websites`);
    }

    if (companiesWithWorkingWebsites.length === 0) continue;

    // Step 2: Fetch website content for validation
    const pageTexts = await Promise.all(
      companiesWithWorkingWebsites.map(c => fetchWebsiteContent(c.website))
    );

    // Step 3: Validate with Gemini
    const validations = await Promise.all(
      companiesWithWorkingWebsites.map((company, idx) =>
        validateCompany(company, business, country, exclusion, pageTexts[idx])
      )
    );

    // Collect valid companies
    companiesWithWorkingWebsites.forEach((company, idx) => {
      if (validations[idx].valid) {
        validated.push({
          ...company,
          hq: validations[idx].corrected_hq || company.hq
        });
      } else {
        console.log(`    Rejected: ${company.company_name} - ${validations[idx].reason}`);
      }
    });

    console.log(`  Progress: ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid so far: ${validated.length}`);
  }

  console.log(`Validation done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Total valid: ${validated.length}`);
  return validated;
}

// ============ EMAIL ============

function buildEmailHTML(companies, business, country, exclusion) {
  let html = `
    <h2>Find Target Results</h2>
    <p><strong>Business:</strong> ${business}</p>
    <p><strong>Country:</strong> ${country}</p>
    <p><strong>Exclusion:</strong> ${exclusion}</p>
    <p><strong>Companies Found:</strong> ${companies.length}</p>
    <br>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #f0f0f0;">
        <tr><th>#</th><th>Company</th><th>Website</th><th>Headquarters</th></tr>
      </thead>
      <tbody>
  `;
  companies.forEach((c, i) => {
    html += `<tr><td>${i + 1}</td><td>${c.company_name}</td><td><a href="${c.website}">${c.website}</a></td><td>${c.hq}</td></tr>`;
  });
  html += '</tbody></table>';
  return html;
}

// ============ MAIN ENDPOINT ============

app.post('/api/find-target', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW REQUEST: ${new Date().toISOString()}`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(50));

  res.json({
    success: true,
    message: 'Request received. Results will be emailed within 5 minutes.'
  });

  try {
    const totalStart = Date.now();

    // Step 1: Search with Perplexity (real web search)
    const companies = await comprehensiveSearch(Business, Country, Exclusion);
    console.log(`\nFound ${companies.length} unique companies from search`);

    // Step 2: Validate (website check + Gemini validation)
    const validCompanies = await validateCompanies(companies, Business, Country, Exclusion);

    // Step 3: Send email
    const htmlContent = buildEmailHTML(validCompanies, Business, Country, Exclusion);
    await sendEmail(
      Email,
      `${Business} in ${Country} exclude ${Exclusion} (${validCompanies.length} companies)`,
      htmlContent
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log(`\n${'='.repeat(50)}`);
    console.log(`COMPLETE! Email sent to ${Email}`);
    console.log(`Total companies: ${validCompanies.length}`);
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Processing error:', error);
    try {
      await sendEmail(Email, `Find Target - Error`, `<p>Error: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

// ============ SLOW VERSION - MORE EXHAUSTIVE ============

function generateSlowSearchQueries(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  const outputFormat = `For each company provide: company_name, website URL (must start with http), headquarters location (City, Country format). List all companies you can find.`;

  // All fast queries
  queries.push(
    `List all ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} suppliers and distributors based in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies in ${country} business directories. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors from ${country} at trade shows. Not ${exclusion}. ${outputFormat}`,
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Small and medium ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} vendors and dealers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} trading companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies registered in trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies in Yellow Pages or Kompass for ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // Additional exhaustive queries
  queries.push(
    `Complete list of ${business} manufacturers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} OEM suppliers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} wholesalers and stockists in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Family-owned ${business} businesses in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies that export from ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Recently established ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies in industrial parks in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies with ISO certification in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} contract manufacturers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Regional ${business} players in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // Country-specific exhaustive searches
  for (const c of countries) {
    queries.push(
      `${business} companies headquartered in ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `Local ${business} firms in ${c}. Not ${exclusion}. ${outputFormat}`,
      `${business} companies in major cities of ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `All ${business} suppliers operating in ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `${business} industry players in ${c}. Not ${exclusion}. ${outputFormat}`,
      `Chamber of commerce ${business} members in ${c}. Exclude ${exclusion}. ${outputFormat}`
    );
  }

  return queries;
}

async function exhaustiveSearch(business, country, exclusion) {
  console.log('Starting EXHAUSTIVE search with Perplexity...');
  const startTime = Date.now();

  const queries = generateSlowSearchQueries(business, country, exclusion);
  console.log(`  Running ${queries.length} Perplexity queries (slow mode)...`);

  // Run all Perplexity searches in parallel
  const searchResults = await Promise.all(queries.map(q => callPerplexity(q)));

  console.log(`  Searches completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Extract companies from all results
  console.log(`  Extracting companies from ${searchResults.length} responses...`);
  const extractionResults = await Promise.all(
    searchResults.map(text => extractCompanies(text, country))
  );

  // Flatten and dedupe
  const allCompanies = extractionResults.flat();
  const uniqueCompanies = dedupeCompanies(allCompanies);

  console.log(`  Raw: ${allCompanies.length}, Unique: ${uniqueCompanies.length}`);
  console.log(`Exhaustive search completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return uniqueCompanies;
}

// SLOW ENDPOINT - More thorough search
app.post('/api/find-target-slow', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW SLOW REQUEST: ${new Date().toISOString()}`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(50));

  res.json({
    success: true,
    message: 'Request received. Results will be emailed within 15-45 minutes.'
  });

  try {
    const totalStart = Date.now();

    // Step 1: Exhaustive search with Perplexity
    const companies = await exhaustiveSearch(Business, Country, Exclusion);
    console.log(`\nFound ${companies.length} unique companies from exhaustive search`);

    // Step 2: Validate (website check + Gemini validation)
    const validCompanies = await validateCompanies(companies, Business, Country, Exclusion);

    // Step 3: Send email
    const htmlContent = buildEmailHTML(validCompanies, Business, Country, Exclusion);
    await sendEmail(
      Email,
      `[SLOW] ${Business} in ${Country} exclude ${Exclusion} (${validCompanies.length} companies)`,
      htmlContent
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log(`\n${'='.repeat(50)}`);
    console.log(`SLOW COMPLETE! Email sent to ${Email}`);
    console.log(`Total companies: ${validCompanies.length}`);
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Processing error:', error);
    try {
      await sendEmail(Email, `Find Target Slow - Error`, `<p>Error: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Find Target v9 - Fast & Slow modes' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
