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

// Initialize DeepSeek (OpenAI-compatible API)
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

async function callChatGPT(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3
    });
    return response.choices[0].message.content || '';
  } catch (error) {
    console.error('ChatGPT error:', error.message);
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

// ============ COMPREHENSIVE QUERY GENERATION ============

function generateAllQueries(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());

  const queries = {
    perplexity: [],
    gemini: [],
    chatgpt: [],
    deepseek: []
  };

  const outputFormat = `For each company provide: company_name, website (must start with http), hq (format: "City, Country" only). List as many companies as possible.`;

  // ===== STRATEGY 1: BROAD SEARCHES (Perplexity - web search) =====
  queries.perplexity.push(
    `Find all ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Search for ${business} suppliers and distributors in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} vendors and dealers based in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Comprehensive list of ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} solution providers in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 2: LISTS AND RANKINGS (Gemini) =====
  queries.gemini.push(
    `List of top ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Leading ${business} firms in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Major ${business} players in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Best ${business} companies in ${country}. No ${exclusion}. ${outputFormat}`,
    `Most reputable ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 3: CITY-SPECIFIC (Perplexity) =====
  for (const c of countries) {
    queries.perplexity.push(
      `${business} companies in all major cities of ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `Find ${business} firms in industrial areas and business districts of ${c}. Not ${exclusion}. ${outputFormat}`,
      `${business} companies in the capital city and secondary cities of ${c}. Exclude ${exclusion}. ${outputFormat}`
    );
  }

  // ===== STRATEGY 4: LOCAL COMPANY NAMING + INDUSTRIAL ZONES (Gemini) =====
  for (const c of countries) {
    queries.gemini.push(
      `Find ${business} companies in ${c} with local company suffixes. Exclude ${exclusion}. ${outputFormat}`,
      `${business} companies in industrial estates and manufacturing zones in ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `${business} companies in free trade zones and special economic zones of ${c}. Not ${exclusion}. ${outputFormat}`
    );
  }

  // ===== STRATEGY 5: ASSOCIATIONS + DIRECTORIES (Perplexity) =====
  queries.perplexity.push(
    `${business} companies that are members of trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} firms listed in Kompass, Yellow Pages, and business directories for ${country}. Not ${exclusion}. ${outputFormat}`,
    `Chamber of commerce member companies in ${business} sector in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} industry association member list in ${country}. No ${exclusion}. ${outputFormat}`,
    `${business} companies in industry federation member directories of ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 6: EXHIBITIONS + TRADE SHOWS (Gemini) =====
  queries.gemini.push(
    `${business} companies that exhibited at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors from ${country} at international industry expos. No ${exclusion}. ${outputFormat}`,
    `${business} companies at conferences and exhibitions in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} firms that participated in trade fairs related to their industry. Not ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 7: IMPORT/EXPORT + SUPPLIER DATABASES (Perplexity) =====
  queries.perplexity.push(
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} suppliers from ${country} listed on B2B platforms. Not ${exclusion}. ${outputFormat}`,
    `${business} companies in supplier databases for ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} trading companies and wholesalers in ${country}. No ${exclusion}. ${outputFormat}`,
    `${business} authorized dealers and resellers in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 8: LOCAL DOMAINS + NEWS (Perplexity) =====
  queries.perplexity.push(
    `${business} companies in ${country} mentioned in recent industry news. Exclude ${exclusion}. ${outputFormat}`,
    `Press releases from ${business} companies headquartered in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies that won awards or recognition in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 9: GOVERNMENT REGISTRIES + CERTIFICATIONS (Perplexity) =====
  queries.perplexity.push(
    `${business} companies registered with government agencies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Certified ${business} firms in ${country} with ISO or industry certifications. Not ${exclusion}. ${outputFormat}`,
    `Licensed ${business} companies operating in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 10: DEEP SEARCH - SME + EMERGING (ChatGPT) =====
  queries.chatgpt.push(
    `Find lesser-known ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Small and medium ${business} enterprises in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Family-owned ${business} businesses in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `New or emerging ${business} companies in ${country}. No ${exclusion}. ${outputFormat}`,
    `Regional ${business} players in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Privately held ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 11: NICHE + SPECIALIZED (DeepSeek) =====
  queries.deepseek.push(
    `Find niche ${business} specialists in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Alternative ${business} suppliers in ${country} that are not commonly known. Not ${exclusion}. ${outputFormat}`,
    `${business} service providers and solution companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Boutique ${business} firms in ${country}. No ${exclusion}. ${outputFormat}`,
    `${business} companies focusing on specific sub-segments in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 12: SUPPLY CHAIN + PARTNERS (DeepSeek) =====
  queries.deepseek.push(
    `Upstream and downstream ${business} companies in ${country}. No ${exclusion}. ${outputFormat}`,
    `${business} companies that are partners of major brands in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} OEM and ODM companies in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 13: LINKEDIN + PROFESSIONAL (ChatGPT) =====
  queries.chatgpt.push(
    `${business} companies in ${country} with active business presence. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies mentioned in industry reports about ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies that have been in business for over 10 years in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 14: TECHNOLOGY + INNOVATION (Gemini) =====
  queries.gemini.push(
    `Innovative ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies with R&D facilities in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Tech-forward ${business} firms in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 15: REGIONAL FOCUS (Perplexity) =====
  for (const c of countries) {
    queries.perplexity.push(
      `Complete list of all ${business} companies operating in ${c}. Exclude ${exclusion}. ${outputFormat}`
    );
  }

  return queries;
}

// ============ EXTRACTION & DEDUPLICATION ============

async function extractCompanies(text, country) {
  if (!text) return [];
  try {
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract company information from the text. Return JSON: {"companies": [{"company_name": "...", "website": "...", "hq": "..."}]}
Rules:
- website must start with http:// or https://
- hq must be formatted as "City, Country" ONLY (e.g., "Kuala Lumpur, Malaysia")
- Only include companies headquartered in: ${country}
- Extract ALL companies mentioned, do not skip any
- Return {"companies": []} if no valid companies found.`
        },
        { role: 'user', content: text }
      ],
      response_format: { type: 'json_object' }
    });
    const parsed = JSON.parse(extraction.choices[0].message.content);
    return Array.isArray(parsed.companies) ? parsed.companies : [];
  } catch (e) {
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

    // Skip if we've seen this website OR this company name
    if (seenWebsites.has(websiteKey) || seenNames.has(nameKey)) continue;

    seenWebsites.set(websiteKey, true);
    seenNames.set(nameKey, true);
    results.push(c);
  }

  return results;
}

// ============ PARALLEL SEARCH WITH ALL STRATEGIES ============

async function comprehensiveSearch(business, country, exclusion) {
  console.log('Starting COMPREHENSIVE PARALLEL search...');
  const startTime = Date.now();

  const queries = generateAllQueries(business, country, exclusion);

  console.log(`  Perplexity queries: ${queries.perplexity.length}`);
  console.log(`  Gemini queries: ${queries.gemini.length}`);
  console.log(`  ChatGPT queries: ${queries.chatgpt.length}`);
  console.log(`  DeepSeek queries: ${queries.deepseek.length}`);
  const total = queries.perplexity.length + queries.gemini.length + queries.chatgpt.length + queries.deepseek.length;
  console.log(`  Total queries: ${total}`);

  // Run all API calls in parallel
  const [perplexityResults, geminiResults, chatgptResults, deepseekResults] = await Promise.all([
    Promise.all(queries.perplexity.map(q => callPerplexity(q))),
    Promise.all(queries.gemini.map(q => callGemini(q))),
    Promise.all(queries.chatgpt.map(q => callChatGPT(q))),
    Promise.all(queries.deepseek.map(q => callDeepSeek(q)))
  ]);

  console.log(`  All API calls done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Extract companies from all results in parallel
  const allTexts = [...perplexityResults, ...geminiResults, ...chatgptResults, ...deepseekResults];
  const extractionResults = await Promise.all(
    allTexts.map(text => extractCompanies(text, country))
  );

  // Flatten and dedupe by BOTH website AND name
  const allCompanies = extractionResults.flat();
  const uniqueCompanies = dedupeCompanies(allCompanies);

  console.log(`  Extracted ${allCompanies.length} companies, ${uniqueCompanies.length} unique (after name + website dedupe)`);
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
          content: `You are a company validator. Validate if this company matches the search criteria.

VALIDATION RULES:

1. LOCATION CHECK:
   - Is HQ actually in one of the target countries (${country})?
   - If HQ is outside these countries → REJECT

2. BUSINESS MATCH (BE LENIENT):
   - Does the company's business relate to "${business}"?
   - Accept related products, services, or sub-categories
   - Only reject if completely unrelated

3. EXCLUSION CHECK (${exclusion}) - DETECT VIA PAGE SIGNALS:
   - If "large companies" in exclusions: Look for "global presence", "worldwide", "Fortune 500", stock tickers, "multinational", 10+ countries, revenue >$100M, employees >1000
   - If "distributor" in exclusions: Reject if company ONLY distributes
   - If "manufacturer" in exclusions: Reject if company ONLY manufactures
   - If "MNC" in exclusions: Reject if parent company is foreign
   - If "listed companies" in exclusions: Reject if publicly traded

4. SPAM CHECK:
   - Directory, marketplace, domain-for-sale, aggregator site? → REJECT

Return JSON ONLY: {"valid": true/false, "reason": "brief reason", "corrected_hq": "City, Country"}`
        },
        {
          role: 'user',
          content: `Company: ${company.company_name}
Website: ${company.website}
Claimed HQ: ${company.hq}
Business sought: ${business}
Target countries: ${country}
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
      return {
        valid: true,
        corrected_hq: result.corrected_hq || company.hq
      };
    }
    return { valid: false };
  } catch (e) {
    console.error('DeepSeek validation error:', e.message);
    return { valid: true, corrected_hq: company.hq };
  }
}

async function parallelValidation(companies, business, country, exclusion) {
  console.log(`\nStarting PARALLEL validation of ${companies.length} companies...`);
  const startTime = Date.now();
  const batchSize = 10;
  const validated = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);

    // Fetch all websites in parallel
    const pageTexts = await Promise.all(batch.map(c => fetchWebsite(c.website)));

    // Validate all in parallel using DeepSeek
    const validations = await Promise.all(
      batch.map((company, idx) => validateCompanyWithDeepSeek(company, business, country, exclusion, pageTexts[idx]))
    );

    // Collect valid ones with corrected HQ
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

  console.log(`Validation completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Valid: ${validated.length}`);
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

    // COMPREHENSIVE PARALLEL SEARCH
    const companies = await comprehensiveSearch(Business, Country, Exclusion);
    console.log(`\nFound ${companies.length} unique companies`);

    // PARALLEL VALIDATION WITH DEEPSEEK
    const validCompanies = await parallelValidation(companies, Business, Country, Exclusion);

    // SEND EMAIL
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
      await sendEmail(
        Email,
        `Find Target - Error`,
        `<p>Error processing "${Business}" in "${Country}": ${error.message}</p>`
      );
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Find Target Backend v7 - Enhanced Search + DeepSeek' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
