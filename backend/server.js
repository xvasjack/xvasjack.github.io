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
      timeout: 90000
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
      timeout: 90000
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
      temperature: 0.2
    });
    return response.choices[0].message.content || '';
  } catch (error) {
    console.error('ChatGPT error:', error.message);
    return '';
  }
}

// ============ EXHAUSTIVE QUERY GENERATION ============

function generateExhaustiveQueries(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());

  // Comprehensive city mapping
  const cityMap = {
    'Malaysia': ['Kuala Lumpur', 'Penang', 'Johor Bahru', 'Shah Alam', 'Petaling Jaya', 'Selangor', 'Ipoh', 'Klang', 'Subang', 'Melaka', 'Kuching', 'Kota Kinabalu'],
    'Singapore': ['Singapore', 'Jurong', 'Tuas', 'Woodlands'],
    'Thailand': ['Bangkok', 'Chonburi', 'Rayong', 'Samut Prakan', 'Ayutthaya', 'Chiang Mai', 'Pathum Thani', 'Nonthaburi', 'Samut Sakhon'],
    'Indonesia': ['Jakarta', 'Surabaya', 'Bandung', 'Medan', 'Bekasi', 'Tangerang', 'Semarang', 'Sidoarjo', 'Cikarang', 'Karawang', 'Bogor'],
    'Vietnam': ['Ho Chi Minh City', 'Hanoi', 'Da Nang', 'Hai Phong', 'Binh Duong', 'Dong Nai', 'Long An', 'Ba Ria', 'Can Tho'],
    'Philippines': ['Manila', 'Cebu', 'Davao', 'Quezon City', 'Makati', 'Laguna', 'Cavite', 'Batangas', 'Bulacan'],
    'southeast asia': ['Kuala Lumpur', 'Singapore', 'Bangkok', 'Jakarta', 'Ho Chi Minh City', 'Manila', 'Penang', 'Johor Bahru', 'Surabaya', 'Hanoi']
  };

  // Local company suffixes
  const localSuffixes = {
    'Malaysia': ['Sdn Bhd', 'Berhad', 'Sdn. Bhd.'],
    'Singapore': ['Pte Ltd', 'Private Limited', 'Pte. Ltd.'],
    'Thailand': ['Co Ltd', 'Company Limited', 'Co., Ltd.'],
    'Indonesia': ['PT', 'CV', 'PT.'],
    'Vietnam': ['Co Ltd', 'JSC', 'LLC', 'Joint Stock'],
    'Philippines': ['Inc', 'Corporation', 'Inc.'],
    'southeast asia': ['Sdn Bhd', 'Pte Ltd', 'PT', 'Co Ltd']
  };

  // Domain suffixes
  const domainMap = {
    'Malaysia': '.my', 'Singapore': '.sg', 'Thailand': '.th', 'co.th': '.co.th',
    'Indonesia': '.id', '.co.id': '.co.id', 'Vietnam': '.vn', 'Philippines': '.ph',
    'southeast asia': ['.my', '.sg', '.th', '.id', '.vn', '.ph']
  };

  const queries = { perplexity: [], gemini: [], chatgpt: [] };
  const outputFormat = `For each company provide: company_name, website (must start with http), hq (format: "City, Country" only). List as many companies as possible, at least 20-30.`;

  // ===== BROAD SEARCHES =====
  queries.perplexity.push(
    `Find ALL ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Complete list of ${business} suppliers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} distributors and dealers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `All ${business} vendors in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${country} ${business} companies directory. Exclude ${exclusion}. ${outputFormat}`,
    `${business} trading companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `List every ${business} company in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== SPECIFIC PRODUCT TERMS =====
  const productTerms = business.split(/\s+or\s+|\s+and\s+|,/).map(t => t.trim()).filter(t => t);
  for (const term of productTerms) {
    queries.perplexity.push(
      `${term} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
      `${term} manufacturers and suppliers in ${country}. Not ${exclusion}. ${outputFormat}`
    );
  }

  // ===== CITY-SPECIFIC SEARCHES =====
  for (const c of countries) {
    const normalizedCountry = c.toLowerCase();
    const cities = cityMap[normalizedCountry] || cityMap[c] || [c];
    for (const city of cities) {
      queries.perplexity.push(
        `${business} companies in ${city}, ${c}. Exclude ${exclusion}. ${outputFormat}`
      );
      queries.gemini.push(
        `List ${business} firms located in ${city}. Not ${exclusion}. ${outputFormat}`
      );
    }
  }

  // ===== LOCAL NAMING CONVENTIONS =====
  for (const c of countries) {
    const normalizedCountry = c.toLowerCase();
    const suffixes = localSuffixes[normalizedCountry] || localSuffixes[c] || [];
    for (const suffix of suffixes) {
      queries.gemini.push(
        `${business} companies with "${suffix}" in ${c}. Exclude ${exclusion}. ${outputFormat}`
      );
    }
  }

  // ===== INDUSTRIAL ZONES =====
  queries.gemini.push(
    `${business} companies in industrial estates in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} factories in manufacturing zones in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} plants in free trade zones in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies in export processing zones in ${country}. Not ${exclusion}. ${outputFormat}`
  );
  for (const c of countries) {
    queries.gemini.push(
      `${business} companies in industrial parks of ${c}. Exclude ${exclusion}. ${outputFormat}`
    );
  }

  // ===== TRADE ASSOCIATIONS & DIRECTORIES =====
  queries.perplexity.push(
    `${business} companies in trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} firms in Kompass directory for ${country}. Not ${exclusion}. ${outputFormat}`,
    `Chamber of commerce ${business} members in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${country} ${business} industry association member list. No ${exclusion}. ${outputFormat}`,
    `${business} companies in Yellow Pages ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} suppliers listed on ThomasNet for ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies on Made-in-China from ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== TRADE SHOWS & EXHIBITIONS =====
  queries.gemini.push(
    `${business} exhibitors at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies at industry exhibitions in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} participants at expos in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors at international fairs from ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // ===== IMPORT/EXPORT & B2B =====
  queries.perplexity.push(
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} suppliers on Alibaba from ${country}. Not ${exclusion}. ${outputFormat}`,
    `${country} ${business} companies on Global Sources. Exclude ${exclusion}. ${outputFormat}`,
    `${business} wholesalers and stockists in ${country}. No ${exclusion}. ${outputFormat}`,
    `${business} OEM suppliers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} contract manufacturers in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // ===== LOCAL DOMAIN SEARCHES =====
  for (const c of countries) {
    const normalizedCountry = c.toLowerCase();
    const domains = domainMap[normalizedCountry] || domainMap[c];
    if (domains) {
      const domainList = Array.isArray(domains) ? domains : [domains];
      for (const domain of domainList) {
        queries.perplexity.push(
          `${business} companies with ${domain} websites. Exclude ${exclusion}. ${outputFormat}`
        );
      }
    }
  }

  // ===== SME & NICHE SEARCHES =====
  queries.chatgpt.push(
    `Lesser-known ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Small and medium ${business} enterprises in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Family-owned ${business} businesses in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Local ${business} companies in ${country}. No ${exclusion}. ${outputFormat}`,
    `Independent ${business} firms in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Regional ${business} players in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Niche ${business} specialists in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Boutique ${business} companies in ${country}. No ${exclusion}. ${outputFormat}`,
    `Emerging ${business} startups in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies not affiliated with multinationals in ${country}. ${outputFormat}`
  );

  // ===== FINAL SWEEP =====
  queries.chatgpt.push(
    `Any ${business} companies in ${country} not yet mentioned. Exclude ${exclusion}. ${outputFormat}`,
    `Alternative ${business} suppliers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Complete directory of ALL ${business} in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // Country-specific comprehensive sweeps
  for (const c of countries) {
    queries.chatgpt.push(
      `Every ${business} company headquartered in ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `All local ${business} firms in ${c}. Not ${exclusion}. ${outputFormat}`
    );
  }

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
          content: `Extract ALL company information. Return JSON: {"companies": [{"company_name": "...", "website": "...", "hq": "..."}]}
Rules:
- website must start with http:// or https://
- hq must be "City, Country" format ONLY
- Include ALL companies mentioned that might be in: ${country}
- Be exhaustive - extract every company mentioned
- Return {"companies": []} if none found`
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

// ============ DEDUPLICATION ============

function normalizeCompanyName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\s+(sdn\.?\s*bhd\.?|bhd\.?|pte\.?\s*ltd\.?|ltd\.?|inc\.?|corp\.?|corporation|co\.?\s*ltd\.?|llc|gmbh|s\.?a\.?|pt\.?|cv\.?|private\s*limited|limited)$/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWebsite(url) {
  if (!url) return '';
  return url.toLowerCase().replace(/\/$/, '').replace(/^https?:\/\//, '').replace(/^www\./, '');
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

// ============ EXHAUSTIVE PARALLEL SEARCH ============

async function exhaustiveSearch(business, country, exclusion) {
  console.log('Starting EXHAUSTIVE PARALLEL search...');
  const startTime = Date.now();

  const queries = generateExhaustiveQueries(business, country, exclusion);

  console.log(`  Perplexity queries: ${queries.perplexity.length}`);
  console.log(`  Gemini queries: ${queries.gemini.length}`);
  console.log(`  ChatGPT queries: ${queries.chatgpt.length}`);
  const total = queries.perplexity.length + queries.gemini.length + queries.chatgpt.length;
  console.log(`  Total queries: ${total}`);

  // Run all in parallel
  const [perplexityResults, geminiResults, chatgptResults] = await Promise.all([
    Promise.all(queries.perplexity.map(q => callPerplexity(q))),
    Promise.all(queries.gemini.map(q => callGemini(q))),
    Promise.all(queries.chatgpt.map(q => callChatGPT(q)))
  ]);

  console.log(`  All API calls done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Extract from all results
  const allTexts = [...perplexityResults, ...geminiResults, ...chatgptResults];
  console.log(`  Extracting companies from ${allTexts.length} responses...`);

  const extractionResults = await Promise.all(
    allTexts.map(text => extractCompanies(text, country))
  );

  const allCompanies = extractionResults.flat();
  const uniqueCompanies = dedupeCompanies(allCompanies);

  console.log(`  Raw: ${allCompanies.length}, Unique: ${uniqueCompanies.length}`);
  console.log(`Search completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return uniqueCompanies;
}

// ============ STRICT VALIDATION FOR LARGE COMPANIES ============

async function fetchWebsite(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
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
      .substring(0, 15000);
    return cleanText.length > 50 ? cleanText : null;
  } catch (e) {
    return null;
  }
}

// ============ STRICT VALIDATION FOR FAST MODE ============

async function validateCompanyStrict(company, business, country, exclusion, pageText) {
  // If we couldn't fetch the website, REJECT (can't verify)
  if (!pageText) {
    console.log(`    Rejected: ${company.company_name} - Could not verify (website unreachable)`);
    return { valid: false };
  }

  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a VERY STRICT company validator. When in doubt, REJECT.

USER'S SEARCH CRITERIA:
- Target Business: "${business}"
- Target Countries: ${country}
- User wants to EXCLUDE: ${exclusion}

VALIDATION RULES (ALL must pass):

1. LOCATION: Company HQ MUST be clearly in ${country}. REJECT if unclear or in other countries.

2. BUSINESS: "${business}" MUST be the company's PRIMARY business. REJECT if it's just a side product or if company is in a different industry.

3. EXCLUSIONS: Carefully analyze if this company matches what user wants to exclude: "${exclusion}". Use your judgment based on website content to determine if the company fits the exclusion criteria.

4. QUALITY: REJECT directories, marketplaces, B2B platforms, template websites, or companies with vague/generic information.

Return JSON: {"valid": true/false, "reason": "brief explanation"}`
        },
        {
          role: 'user',
          content: `Company: ${company.company_name}
Website: ${company.website}
Claimed HQ: ${company.hq}

Website content to analyze:
${pageText.substring(0, 8000)}`
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
    // On error, REJECT (strict mode)
    console.log(`    Rejected: ${company.company_name} - Validation error, rejecting in strict mode`);
    return { valid: false };
  }
}

async function parallelValidationStrict(companies, business, country, exclusion) {
  console.log(`\nSTRICT Validating ${companies.length} companies...`);
  const startTime = Date.now();
  const batchSize = 5; // Smaller batches for stricter validation
  const validated = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);
    const pageTexts = await Promise.all(batch.map(c => fetchWebsite(c.website)));
    const validations = await Promise.all(
      batch.map((company, idx) => validateCompanyStrict(company, business, country, exclusion, pageTexts[idx]))
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

  console.log(`STRICT Validation done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Valid: ${validated.length}`);
  return validated;
}

// ============ LENIENT VALIDATION FOR SLOW MODE ============

async function validateCompany(company, business, country, exclusion, pageText) {
  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a strict company validator. Validate if this company matches criteria.

VALIDATION RULES:

1. LOCATION CHECK:
   - Is HQ in one of: ${country}?
   - If clearly outside → REJECT
   - If unclear but might be in region → ACCEPT

2. BUSINESS MATCH (BE LENIENT):
   - Does company relate to "${business}"?
   - Accept related products, services, sub-categories
   - Only reject if COMPLETELY unrelated

3. LARGE COMPANY EXCLUSION (BE STRICT - user wants to exclude: ${exclusion}):
   REJECT if ANY of these signals are present:
   - Company is publicly listed/traded on any stock exchange
   - Company is part of a global group with operations in 5+ countries
   - Company is a subsidiary of a Fortune 500 or large multinational
   - Company has "global", "worldwide", "international operations" prominently
   - Company mentions revenue >$100M or employees >500
   - Company is a well-known industry giant or market leader
   - Company website mentions "group of companies" spanning multiple countries
   - Parent company is a large multinational corporation

   ACCEPT only if company appears to be:
   - Locally owned and operated
   - Single-country or regional focus (2-3 countries max)
   - Independent (not subsidiary of large group)
   - Small to medium enterprise

4. DISTRIBUTOR EXCLUSION (if "distributor" in exclusions):
   - Reject if company ONLY distributes products from others
   - Accept if company also manufactures, formulates, or produces

5. SPAM CHECK:
   - Reject directories, marketplaces, aggregators

Return JSON: {"valid": true/false, "reason": "brief explanation", "corrected_hq": "City, Country or null"}`
        },
        {
          role: 'user',
          content: `Company: ${company.company_name}
Website: ${company.website}
Claimed HQ: ${company.hq}
Business: ${business}
Countries: ${country}
Exclusions: ${exclusion}

Website content (analyze for large company signals):
${pageText ? pageText.substring(0, 6000) : 'Could not fetch website - use company name to assess if likely large/multinational'}`
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
    console.log(`    Validation error for ${company.company_name}, accepting by default`);
    return { valid: true, corrected_hq: company.hq };
  }
}

async function parallelValidation(companies, business, country, exclusion) {
  console.log(`\nValidating ${companies.length} companies (strict large company filter)...`);
  const startTime = Date.now();
  const batchSize = 8; // Smaller batch for more thorough validation
  const validated = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);
    const pageTexts = await Promise.all(batch.map(c => fetchWebsite(c.website)));
    const validations = await Promise.all(
      batch.map((company, idx) => validateCompany(company, business, country, exclusion, pageTexts[idx]))
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

    const companies = await exhaustiveSearch(Business, Country, Exclusion);
    console.log(`\nFound ${companies.length} unique companies`);

    const validCompanies = await parallelValidationStrict(companies, Business, Country, Exclusion);

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

// ============ SLOW ENDPOINT (3x search) ============

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

    // Run 3 searches with different phrasings
    console.log('\n--- Search 1: Primary ---');
    const companies1 = await exhaustiveSearch(Business, Country, Exclusion);

    console.log('\n--- Search 2: Supplier/Vendor variation ---');
    const companies2 = await exhaustiveSearch(`${Business} supplier vendor`, Country, Exclusion);

    console.log('\n--- Search 3: Manufacturer/Producer variation ---');
    const companies3 = await exhaustiveSearch(`${Business} manufacturer producer`, Country, Exclusion);

    const allCompanies = [...companies1, ...companies2, ...companies3];
    const uniqueCompanies = dedupeCompanies(allCompanies);
    console.log(`\nTotal unique from 3 searches: ${uniqueCompanies.length}`);

    const validCompanies = await parallelValidation(uniqueCompanies, Business, Country, Exclusion);

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
  res.json({ status: 'ok', service: 'Find Target v14 - Fast: Strict Validation, Slow: Lenient' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
