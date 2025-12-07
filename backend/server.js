require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// Check required environment variables
const requiredEnvVars = ['OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'GEMINI_API_KEY', 'BREVO_API_KEY', 'DEEPSEEK_API_KEY'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'missing'
});

// Initialize DeepSeek (OpenAI-compatible API) - CHEAPEST, use for heavy workload
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'missing',
  baseURL: 'https://api.deepseek.com'
});

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
      timeout: 60000
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('Perplexity error:', error.message);
    return '';
  }
}

async function callDeepSeek(prompt) {
  try {
    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3
    });
    return response.choices[0].message.content || '';
  } catch (error) {
    console.error('DeepSeek error:', error.message);
    return '';
  }
}

// ============ EXHAUSTIVE QUERY GENERATION ============

function generateAllQueries(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());

  const queries = {
    perplexity: [],  // Web search - use for real-time data
    gemini: [],      // Use sparingly
    deepseek: []     // CHEAPEST - use heavily
  };

  const outputFormat = `For each company provide: company_name, website (must start with http), hq (format: "City, Country" only). List as many companies as possible, at least 20-30 if available.`;

  // ===== PERPLEXITY - WEB SEARCH (real-time data) =====
  queries.perplexity.push(
    `Find all ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} suppliers and distributors in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies listed in business directories for ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors from ${country} at recent trade shows and expos. Not ${exclusion}. ${outputFormat}`,
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Recent news about ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies registered with government agencies in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // City-specific Perplexity searches
  for (const c of countries) {
    queries.perplexity.push(
      `All ${business} companies in major cities of ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `${business} firms in industrial zones and business parks of ${c}. Not ${exclusion}. ${outputFormat}`
    );
  }

  // ===== GEMINI - Use for structured lists =====
  queries.gemini.push(
    `Complete list of top ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Leading ${business} firms and market players in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies that exhibited at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== DEEPSEEK - HEAVY WORKLOAD (cheapest) =====

  // Broad searches
  queries.deepseek.push(
    `Comprehensive list of all ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} vendors and dealers based in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} solution providers and service companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `All ${business} trading companies and wholesalers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} authorized dealers and resellers in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // Lists and rankings
  queries.deepseek.push(
    `Top 50 ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Best ${business} suppliers in ${country} ranked by reputation. Not ${exclusion}. ${outputFormat}`,
    `Most established ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Largest ${business} firms by revenue in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // Industry associations and directories
  queries.deepseek.push(
    `${business} companies that are members of trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} firms listed in Kompass directory for ${country}. Not ${exclusion}. ${outputFormat}`,
    `Chamber of commerce member companies in ${business} sector in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} industry association member list in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies in Yellow Pages and business listings for ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // Trade shows and exhibitions
  queries.deepseek.push(
    `${business} companies that exhibited at international trade shows from ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors at industry expos and conferences in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} firms that participated in trade fairs in Asia. Exclude ${exclusion}. ${outputFormat}`
  );

  // Import/Export and B2B
  queries.deepseek.push(
    `${business} suppliers from ${country} on Alibaba and B2B platforms. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies in global supplier databases for ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} OEM and ODM manufacturers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} contract manufacturers in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // SME and lesser-known
  queries.deepseek.push(
    `Lesser-known ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Small and medium ${business} enterprises in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Family-owned ${business} businesses in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `New and emerging ${business} startups in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Regional ${business} players in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Privately held ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Boutique ${business} firms in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // Niche and specialized
  queries.deepseek.push(
    `Niche ${business} specialists in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies focusing on specific sub-segments in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Specialized ${business} service providers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies serving specific industries in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // Supply chain
  queries.deepseek.push(
    `Upstream ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Downstream ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies that are partners of major brands in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} value-added resellers in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // Technology and innovation
  queries.deepseek.push(
    `Innovative ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies with R&D facilities in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Tech-forward ${business} firms in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies with proprietary technology in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // Certifications and awards
  queries.deepseek.push(
    `ISO certified ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Award-winning ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies with industry certifications in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // Established and long-standing
  queries.deepseek.push(
    `${business} companies established for over 10 years in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Heritage ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Well-established ${business} firms in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // Country-specific exhaustive searches
  for (const c of countries) {
    queries.deepseek.push(
      `Complete directory of all ${business} companies in ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `Every ${business} supplier operating in ${c}. Not ${exclusion}. ${outputFormat}`,
      `Full list of ${business} distributors in ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `All local ${business} companies headquartered in ${c}. Not ${exclusion}. ${outputFormat}`,
      `${business} companies in capital city and major cities of ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `${business} companies in industrial estates of ${c}. Not ${exclusion}. ${outputFormat}`,
      `${business} companies in free trade zones of ${c}. Exclude ${exclusion}. ${outputFormat}`
    );
  }

  // Alternative terms and related
  queries.deepseek.push(
    `Companies related to ${business} in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} and related product companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Companies in ${business} supply chain in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} ecosystem companies in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  return queries;
}

// ============ EXTRACTION WITH DEEPSEEK (cheaper) ============

async function extractCompanies(text, country) {
  if (!text) return [];
  try {
    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `Extract company information from the text. Return JSON ONLY: {"companies": [{"company_name": "...", "website": "...", "hq": "..."}]}
Rules:
- website must start with http:// or https://
- hq must be "City, Country" format ONLY
- Only include companies headquartered in: ${country}
- Extract ALL companies mentioned
- Return {"companies": []} if none found`
        },
        { role: 'user', content: text }
      ],
      temperature: 0
    });
    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed.companies) ? parsed.companies : [];
  } catch (e) {
    console.error('Extraction error:', e.message);
    return [];
  }
}

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

    const websiteKey = normalizeWebsite(c.website);
    const nameKey = normalizeCompanyName(c.company_name);

    if (seenWebsites.has(websiteKey) || seenNames.has(nameKey)) continue;

    seenWebsites.set(websiteKey, true);
    seenNames.set(nameKey, true);
    results.push(c);
  }

  return results;
}

// ============ PARALLEL SEARCH ============

async function comprehensiveSearch(business, country, exclusion) {
  console.log('Starting EXHAUSTIVE PARALLEL search...');
  const startTime = Date.now();

  const queries = generateAllQueries(business, country, exclusion);

  console.log(`  Perplexity queries: ${queries.perplexity.length}`);
  console.log(`  Gemini queries: ${queries.gemini.length}`);
  console.log(`  DeepSeek queries: ${queries.deepseek.length} (heavy workload)`);
  const total = queries.perplexity.length + queries.gemini.length + queries.deepseek.length;
  console.log(`  Total queries: ${total}`);

  // Run all API calls in parallel
  const [perplexityResults, geminiResults, deepseekResults] = await Promise.all([
    Promise.all(queries.perplexity.map(q => callPerplexity(q))),
    Promise.all(queries.gemini.map(q => callGemini(q))),
    Promise.all(queries.deepseek.map(q => callDeepSeek(q)))
  ]);

  console.log(`  All API calls done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Extract companies from all results in parallel using DeepSeek (cheaper)
  const allTexts = [...perplexityResults, ...geminiResults, ...deepseekResults];
  console.log(`  Extracting companies from ${allTexts.length} responses...`);

  const extractionResults = await Promise.all(
    allTexts.map(text => extractCompanies(text, country))
  );

  // Flatten and dedupe
  const allCompanies = extractionResults.flat();
  const uniqueCompanies = dedupeCompanies(allCompanies);

  console.log(`  Extracted ${allCompanies.length} companies, ${uniqueCompanies.length} unique`);
  console.log(`Search completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return uniqueCompanies;
}

// ============ VALIDATION WITH DEEPSEEK ============

async function fetchWebsite(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompanyFinder/1.0)' },
      timeout: 10000
    });
    if (!response.ok) return null;
    const html = await response.text();
    const cleanText = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 12000);
    return cleanText.length > 50 ? cleanText : null;
  } catch (e) {
    return null;
  }
}

async function validateCompanyWithDeepSeek(company, business, country, exclusion, pageText) {
  try {
    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `You are a company validator. Validate if this company matches criteria.

RULES:
1. LOCATION: HQ must be in ${country}. If outside → REJECT
2. BUSINESS (BE LENIENT): Must relate to "${business}". Accept related products/services.
3. EXCLUSIONS (${exclusion}):
   - "large/MNC": Reject if global presence, Fortune 500, stock listed, >1000 employees
   - "distributor": Reject if ONLY distributes
   - "manufacturer": Reject if ONLY manufactures
4. SPAM: Reject directories, marketplaces, aggregators

Return JSON ONLY: {"valid": true/false, "reason": "brief", "corrected_hq": "City, Country"}`
        },
        {
          role: 'user',
          content: `Company: ${company.company_name}
Website: ${company.website}
HQ: ${company.hq}
Business: ${business}
Countries: ${country}
Exclusions: ${exclusion}

Website content:
${pageText ? pageText.substring(0, 4000) : 'Could not fetch'}`
        }
      ],
      temperature: 0
    });

    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { valid: true, corrected_hq: company.hq };

    const result = JSON.parse(jsonMatch[0]);
    if (result.valid === true) {
      return { valid: true, corrected_hq: result.corrected_hq || company.hq };
    }
    return { valid: false };
  } catch (e) {
    console.error('Validation error:', e.message);
    return { valid: true, corrected_hq: company.hq };
  }
}

async function parallelValidation(companies, business, country, exclusion) {
  console.log(`\nStarting PARALLEL validation of ${companies.length} companies with DeepSeek...`);
  const startTime = Date.now();
  const batchSize = 15; // Larger batch since DeepSeek is cheap
  const validated = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);

    const pageTexts = await Promise.all(batch.map(c => fetchWebsite(c.website)));

    const validations = await Promise.all(
      batch.map((company, idx) => validateCompanyWithDeepSeek(company, business, country, exclusion, pageTexts[idx]))
    );

    batch.forEach((company, idx) => {
      if (validations[idx].valid) {
        validated.push({
          ...company,
          hq: validations[idx].corrected_hq || company.hq
        });
      }
    });

    console.log(`  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`);
  }

  console.log(`Validation done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Valid: ${validated.length}`);
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
    message: 'Request received. Results will be emailed within 15 minutes.'
  });

  try {
    const totalStart = Date.now();

    const companies = await comprehensiveSearch(Business, Country, Exclusion);
    console.log(`\nFound ${companies.length} unique companies`);

    const validCompanies = await parallelValidation(companies, Business, Country, Exclusion);

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

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Find Target v8 - Exhaustive DeepSeek' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
