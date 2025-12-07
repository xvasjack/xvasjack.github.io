require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// Check required environment variables
const requiredEnvVars = ['OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'GEMINI_API_KEY', 'BREVO_API_KEY'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'missing'
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
      temperature: 0
    });
    return response.choices[0].message.content || '';
  } catch (error) {
    console.error('ChatGPT error:', error.message);
    return '';
  }
}

// ============ EXTRACTION WITH GPT-4o-mini (RELIABLE JSON) ============

async function extractCompanies(text, country) {
  if (!text || text.length < 50) return [];
  try {
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract company information. Return JSON: {"companies": [{"company_name": "...", "website": "...", "hq": "..."}]}
Rules:
- website must start with http:// or https://
- hq format: "City, Country"
- Only include companies headquartered in: ${country}
- Return {"companies": []} if none found`
        },
        { role: 'user', content: text.substring(0, 10000) }
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

    if (seenWebsites.has(websiteKey) || seenNames.has(nameKey)) continue;

    seenWebsites.set(websiteKey, true);
    seenNames.set(nameKey, true);
    results.push(c);
  }

  return results;
}

// ============ SEARCH QUERIES ============

function generateQueries(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());

  const outputFormat = `For each company provide: company_name, website URL (must start with http), headquarters (City, Country format). List all companies you can find.`;

  // Gemini queries - general knowledge
  const geminiQueries = [
    `List all ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Find ${business} suppliers and distributors in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} vendors based in ${country} excluding ${exclusion}. ${outputFormat}`,
    `Directory of ${business} firms in ${country}. No ${exclusion}. ${outputFormat}`,
    `Local ${business} dealers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} traders and wholesalers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Small and medium ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`
  ];

  // Add country-specific queries
  for (const c of countries) {
    geminiQueries.push(
      `${business} companies in major cities of ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `All ${business} firms headquartered in ${c}. Not ${exclusion}. ${outputFormat}`
    );
  }

  // Perplexity queries - web search (real-time)
  const perplexityQueries = [
    `Search for ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Find ${business} distributors in ${country}. No ${exclusion}. ${outputFormat}`,
    `${country} ${business} supplier directory. Exclude ${exclusion}. ${outputFormat}`,
    `List of ${business} vendors operating in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies that exhibited at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors from ${country} at industry events. No ${exclusion}. ${outputFormat}`,
    `${business} companies in business directories for ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Find ${business} importers in ${country}. Not ${exclusion}. ${outputFormat}`
  ];

  // ChatGPT queries - associations and lesser-known
  const chatgptQueries = [
    `List ${business} companies that are members of trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies from ${country} industry directories. No ${exclusion}. ${outputFormat}`,
    `Find ${business} firms registered with chambers of commerce in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `What are some lesser-known ${business} companies in ${country}? Exclude ${exclusion}. ${outputFormat}`,
    `Small and medium ${business} enterprises in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Family-owned ${business} businesses in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `New or emerging ${business} companies in ${country}. No ${exclusion}. ${outputFormat}`,
    `Regional ${business} players in ${country}. Not ${exclusion}. ${outputFormat}`
  ];

  return { geminiQueries, perplexityQueries, chatgptQueries };
}

// ============ PARALLEL SEARCH ============

async function parallelSearch(business, country, exclusion) {
  console.log('Starting PARALLEL search with Gemini + Perplexity + ChatGPT...');
  const startTime = Date.now();

  const { geminiQueries, perplexityQueries, chatgptQueries } = generateQueries(business, country, exclusion);

  console.log(`  Gemini queries: ${geminiQueries.length}`);
  console.log(`  Perplexity queries: ${perplexityQueries.length}`);
  console.log(`  ChatGPT queries: ${chatgptQueries.length}`);
  console.log(`  Total queries: ${geminiQueries.length + perplexityQueries.length + chatgptQueries.length}`);

  // Run all API calls in parallel
  const [geminiResults, perplexityResults, chatgptResults] = await Promise.all([
    Promise.all(geminiQueries.map(q => callGemini(q))),
    Promise.all(perplexityQueries.map(q => callPerplexity(q))),
    Promise.all(chatgptQueries.map(q => callChatGPT(q)))
  ]);

  console.log(`  All API calls done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Extract companies from all results using GPT-4o-mini (reliable JSON)
  const allTexts = [...geminiResults, ...perplexityResults, ...chatgptResults];
  console.log(`  Extracting companies from ${allTexts.length} responses with GPT-4o-mini...`);

  const extractionResults = await Promise.all(
    allTexts.map(text => extractCompanies(text, country))
  );

  // Flatten and dedupe
  const allCompanies = extractionResults.flat();
  const uniqueCompanies = dedupeCompanies(allCompanies);

  console.log(`  Raw: ${allCompanies.length}, Unique: ${uniqueCompanies.length}`);
  console.log(`Search completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return uniqueCompanies;
}

// ============ VALIDATION WITH GPT-4o-mini ============

async function fetchWebsite(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
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

async function validateCompany(company, business, country, exclusion, pageText) {
  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Validate if company matches criteria. Return JSON: {"valid": true/false, "reason": "brief explanation", "corrected_hq": "City, Country or null"}

VALIDATION RULES:
1. LOCATION: HQ must be in ${country}. If clearly elsewhere → REJECT
2. BUSINESS: Must be related to "${business}". Be reasonable but reject if completely unrelated.
3. EXCLUSIONS (${exclusion}):
   - If "large" or "MNC": Reject Fortune 500, multinationals, listed companies
   - If "distributor": Reject if ONLY a distributor
   - If "manufacturer": Reject if ONLY a manufacturer
4. SPAM: Reject directories, marketplaces, aggregator sites
5. WEBSITE: If website content doesn't match a real company → REJECT`
        },
        {
          role: 'user',
          content: `Company: ${company.company_name}
Website: ${company.website}
HQ: ${company.hq}
Business type needed: ${business}
Countries: ${country}
Exclusions: ${exclusion}

Website content preview:
${pageText ? pageText.substring(0, 4000) : 'Could not fetch website'}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(validation.choices[0].message.content);
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

async function parallelValidation(companies, business, country, exclusion) {
  console.log(`\nValidating ${companies.length} companies with GPT-4o-mini...`);
  const startTime = Date.now();
  const batchSize = 10;
  const validated = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);

    // Fetch all websites in parallel
    const pageTexts = await Promise.all(batch.map(c => fetchWebsite(c.website)));

    // Validate all in parallel
    const validations = await Promise.all(
      batch.map((company, idx) => validateCompany(company, business, country, exclusion, pageTexts[idx]))
    );

    // Collect valid ones
    batch.forEach((company, idx) => {
      if (validations[idx].valid) {
        validated.push({
          ...company,
          hq: validations[idx].corrected_hq || company.hq
        });
      } else {
        console.log(`    Rejected: ${company.company_name} - ${validations[idx].reason}`);
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

// ============ FAST ENDPOINT ============

app.post('/api/find-target', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW FAST REQUEST: ${new Date().toISOString()}`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(50));

  res.json({
    success: true,
    message: 'Request received. Results will be emailed within 5-10 minutes.'
  });

  try {
    const totalStart = Date.now();

    const companies = await parallelSearch(Business, Country, Exclusion);
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
    console.log(`FAST COMPLETE! Email sent to ${Email}`);
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

// ============ SLOW ENDPOINT - MORE EXHAUSTIVE ============

function generateSlowQueries(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const outputFormat = `For each company provide: company_name, website URL (must start with http), headquarters (City, Country format). List all companies you can find.`;

  // Extended Gemini queries
  const geminiQueries = [
    `List all ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Find ${business} suppliers and distributors in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} vendors based in ${country} excluding ${exclusion}. ${outputFormat}`,
    `Directory of ${business} firms in ${country}. No ${exclusion}. ${outputFormat}`,
    `Local ${business} dealers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} traders and wholesalers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Small and medium ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} OEM suppliers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} contract manufacturers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `ISO certified ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies in industrial zones of ${country}. Exclude ${exclusion}. ${outputFormat}`
  ];

  for (const c of countries) {
    geminiQueries.push(
      `${business} companies in major cities of ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `All ${business} firms headquartered in ${c}. Not ${exclusion}. ${outputFormat}`,
      `${business} companies in industrial parks of ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `Complete list of ${business} suppliers in ${c}. Not ${exclusion}. ${outputFormat}`
    );
  }

  // Extended Perplexity queries
  const perplexityQueries = [
    `Search for ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Find ${business} distributors in ${country}. No ${exclusion}. ${outputFormat}`,
    `${country} ${business} supplier directory. Exclude ${exclusion}. ${outputFormat}`,
    `List of ${business} vendors operating in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies that exhibited at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors from ${country} at industry events. No ${exclusion}. ${outputFormat}`,
    `${business} companies in business directories for ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Find ${business} importers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies in Yellow Pages for ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies in Kompass directory for ${country}. Not ${exclusion}. ${outputFormat}`,
    `Recent news about ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies with government contracts in ${country}. Not ${exclusion}. ${outputFormat}`
  ];

  for (const c of countries) {
    perplexityQueries.push(
      `${business} companies headquartered in ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `All ${business} suppliers in ${c}. Not ${exclusion}. ${outputFormat}`
    );
  }

  // Extended ChatGPT queries
  const chatgptQueries = [
    `List ${business} companies that are members of trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies from ${country} industry directories. No ${exclusion}. ${outputFormat}`,
    `Find ${business} firms registered with chambers of commerce in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `What are some lesser-known ${business} companies in ${country}? Exclude ${exclusion}. ${outputFormat}`,
    `Small and medium ${business} enterprises in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Family-owned ${business} businesses in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `New or emerging ${business} companies in ${country}. No ${exclusion}. ${outputFormat}`,
    `Regional ${business} players in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies that are subsidiaries of regional groups in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Well-established ${business} firms in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies with strong reputation in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Niche ${business} specialists in ${country}. Not ${exclusion}. ${outputFormat}`
  ];

  for (const c of countries) {
    chatgptQueries.push(
      `All ${business} companies based in ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `${business} industry players in ${c}. Not ${exclusion}. ${outputFormat}`
    );
  }

  return { geminiQueries, perplexityQueries, chatgptQueries };
}

async function exhaustiveSearch(business, country, exclusion) {
  console.log('Starting EXHAUSTIVE search with Gemini + Perplexity + ChatGPT...');
  const startTime = Date.now();

  const { geminiQueries, perplexityQueries, chatgptQueries } = generateSlowQueries(business, country, exclusion);

  console.log(`  Gemini queries: ${geminiQueries.length}`);
  console.log(`  Perplexity queries: ${perplexityQueries.length}`);
  console.log(`  ChatGPT queries: ${chatgptQueries.length}`);
  console.log(`  Total queries: ${geminiQueries.length + perplexityQueries.length + chatgptQueries.length}`);

  const [geminiResults, perplexityResults, chatgptResults] = await Promise.all([
    Promise.all(geminiQueries.map(q => callGemini(q))),
    Promise.all(perplexityQueries.map(q => callPerplexity(q))),
    Promise.all(chatgptQueries.map(q => callChatGPT(q)))
  ]);

  console.log(`  All API calls done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  const allTexts = [...geminiResults, ...perplexityResults, ...chatgptResults];
  console.log(`  Extracting companies from ${allTexts.length} responses with GPT-4o-mini...`);

  const extractionResults = await Promise.all(
    allTexts.map(text => extractCompanies(text, country))
  );

  const allCompanies = extractionResults.flat();
  const uniqueCompanies = dedupeCompanies(allCompanies);

  console.log(`  Raw: ${allCompanies.length}, Unique: ${uniqueCompanies.length}`);
  console.log(`Exhaustive search completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return uniqueCompanies;
}

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

    const companies = await exhaustiveSearch(Business, Country, Exclusion);
    console.log(`\nFound ${companies.length} unique companies from exhaustive search`);

    const validCompanies = await parallelValidation(companies, Business, Country, Exclusion);

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
  res.json({ status: 'ok', service: 'Find Target v10 - Multi-AI Search + GPT-4o-mini Extraction' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
