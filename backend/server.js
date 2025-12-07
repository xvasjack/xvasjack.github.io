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

// ============ COMPREHENSIVE QUERY GENERATION (11 STRATEGIES) ============

function generateAllQueries(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());

  // City mapping for various regions
  const cityMap = {
    'Malaysia': ['Kuala Lumpur', 'Penang', 'Johor Bahru', 'Shah Alam', 'Petaling Jaya', 'Selangor', 'Ipoh', 'Klang'],
    'Singapore': ['Singapore'],
    'Thailand': ['Bangkok', 'Chonburi', 'Rayong', 'Samut Prakan', 'Ayutthaya', 'Chiang Mai', 'Pathum Thani'],
    'Indonesia': ['Jakarta', 'Surabaya', 'Bandung', 'Medan', 'Bekasi', 'Tangerang', 'Semarang', 'Sidoarjo'],
    'Vietnam': ['Ho Chi Minh City', 'Hanoi', 'Da Nang', 'Hai Phong', 'Binh Duong', 'Dong Nai'],
    'Philippines': ['Manila', 'Cebu', 'Davao', 'Quezon City', 'Makati', 'Laguna'],
    'India': ['Mumbai', 'Delhi', 'Bangalore', 'Chennai', 'Hyderabad', 'Pune', 'Ahmedabad'],
    'China': ['Shanghai', 'Beijing', 'Shenzhen', 'Guangzhou', 'Dongguan', 'Suzhou'],
    'Japan': ['Tokyo', 'Osaka', 'Nagoya', 'Yokohama', 'Fukuoka'],
    'South Korea': ['Seoul', 'Busan', 'Incheon', 'Daegu'],
    'Taiwan': ['Taipei', 'Taichung', 'Kaohsiung', 'Tainan']
  };

  // Local company naming conventions
  const localSuffixes = {
    'Malaysia': ['Sdn Bhd', 'Berhad'],
    'Singapore': ['Pte Ltd', 'Private Limited'],
    'Thailand': ['Co Ltd', 'Company Limited'],
    'Indonesia': ['PT', 'CV'],
    'Vietnam': ['Co Ltd', 'JSC', 'LLC'],
    'Philippines': ['Inc', 'Corporation'],
    'India': ['Pvt Ltd', 'Private Limited', 'Ltd'],
    'China': ['Co Ltd', 'Limited'],
    'Japan': ['Co Ltd', 'KK', 'Inc'],
    'South Korea': ['Co Ltd', 'Corp'],
    'Taiwan': ['Co Ltd', 'Corp']
  };

  // Domain suffixes
  const domainMap = {
    'Malaysia': '.my', 'Singapore': '.sg', 'Thailand': '.th', 'Indonesia': '.id',
    'Vietnam': '.vn', 'Philippines': '.ph', 'India': '.in', 'China': '.cn',
    'Japan': '.jp', 'South Korea': '.kr', 'Taiwan': '.tw'
  };

  const queries = { perplexity: [], gemini: [], chatgpt: [] };
  const outputFormat = `For each company provide: company_name, website (must start with http), hq (format: "City, Country" only). List as many as possible.`;

  // ===== STRATEGY 1: BROAD SEARCHES (Perplexity - web search) =====
  queries.perplexity.push(
    `Find all ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Search for ${business} suppliers and distributors in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} vendors and dealers based in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${country} ${business} companies comprehensive list. Exclude ${exclusion}. ${outputFormat}`,
    `All ${business} trading companies in ${country}. Not ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 2: LISTS AND RANKINGS (Gemini) =====
  queries.gemini.push(
    `List of top ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Leading ${business} firms in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Major ${business} players in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Best ${business} companies in ${country}. No ${exclusion}. ${outputFormat}`,
    `Established ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 3: CITY-SPECIFIC (Perplexity) =====
  for (const c of countries) {
    const cities = cityMap[c] || [c];
    for (const city of cities.slice(0, 5)) {
      queries.perplexity.push(
        `${business} companies in ${city}, ${c}. Exclude ${exclusion}. ${outputFormat}`
      );
    }
  }

  // ===== STRATEGY 4: LOCAL NAMING CONVENTIONS (Gemini) =====
  for (const c of countries) {
    const suffixes = localSuffixes[c] || [];
    for (const suffix of suffixes.slice(0, 2)) {
      queries.gemini.push(
        `${business} companies with "${suffix}" in ${c}. Exclude ${exclusion}. ${outputFormat}`
      );
    }
  }

  // ===== STRATEGY 5: INDUSTRIAL ZONES (Gemini) =====
  for (const c of countries) {
    queries.gemini.push(
      `${business} companies in industrial estates and manufacturing zones in ${c}. Exclude ${exclusion}. ${outputFormat}`,
      `${business} factories and plants in ${c}. Not ${exclusion}. ${outputFormat}`
    );
  }

  // ===== STRATEGY 6: TRADE ASSOCIATIONS (Perplexity) =====
  queries.perplexity.push(
    `${business} companies that are members of trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} firms in Kompass directory for ${country}. Not ${exclusion}. ${outputFormat}`,
    `Chamber of commerce ${business} members in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${country} ${business} industry association members. No ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 7: EXHIBITIONS (Gemini) =====
  queries.gemini.push(
    `${business} companies that exhibited at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors from ${country} at industry events. No ${exclusion}. ${outputFormat}`,
    `${country} ${business} companies at conferences and expos. Exclude ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 8: IMPORT/EXPORT (Perplexity) =====
  queries.perplexity.push(
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} suppliers on Alibaba from ${country}. Not ${exclusion}. ${outputFormat}`,
    `${country} ${business} companies in supplier databases. Exclude ${exclusion}. ${outputFormat}`,
    `${business} wholesalers and stockists in ${country}. No ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 9: LOCAL DOMAINS (Perplexity) =====
  for (const c of countries) {
    const domain = domainMap[c];
    if (domain) {
      queries.perplexity.push(
        `${business} companies with ${domain} websites in ${c}. Exclude ${exclusion}. ${outputFormat}`
      );
    }
  }

  // ===== STRATEGY 10: DEEP SEARCH - SME & NICHE (ChatGPT) =====
  queries.chatgpt.push(
    `Lesser-known ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Small and medium ${business} enterprises in ${country}. Not ${exclusion}. ${outputFormat}`,
    `Family-owned ${business} businesses in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `New or emerging ${business} companies in ${country}. No ${exclusion}. ${outputFormat}`,
    `Regional ${business} players in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Niche ${business} specialists in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} companies serving specific industries in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Boutique ${business} firms in ${country}. No ${exclusion}. ${outputFormat}`
  );

  // ===== STRATEGY 11: FINAL SWEEP (ChatGPT) =====
  queries.chatgpt.push(
    `Any other ${business} companies in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Alternative ${business} suppliers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} service providers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Complete directory of ${business} in ${country}. No ${exclusion}. ${outputFormat}`
  );

  // Country-specific sweeps
  for (const c of countries) {
    queries.chatgpt.push(
      `All ${business} companies based in ${c}. Exclude ${exclusion}. ${outputFormat}`
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
          content: `Extract company information. Return JSON: {"companies": [{"company_name": "...", "website": "...", "hq": "..."}]}
Rules:
- website must start with http:// or https://
- hq must be "City, Country" format ONLY
- Include ALL companies mentioned that are in: ${country}
- Return {"companies": []} if none found`
        },
        { role: 'user', content: text.substring(0, 12000) }
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

// ============ COMPREHENSIVE PARALLEL SEARCH ============

async function comprehensiveSearch(business, country, exclusion) {
  console.log('Starting COMPREHENSIVE PARALLEL search (11 strategies)...');
  const startTime = Date.now();

  const queries = generateAllQueries(business, country, exclusion);

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

// ============ LENIENT VALIDATION ============

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
      .substring(0, 12000);
    return cleanText.length > 50 ? cleanText : null;
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
          content: `You are a company validator. Validate if this company matches criteria.

VALIDATION RULES:

1. LOCATION CHECK:
   - Is HQ in one of: ${country}?
   - If clearly outside → REJECT
   - If unclear but might be in region → ACCEPT

2. BUSINESS MATCH (BE LENIENT):
   - Does company relate to "${business}"?
   - Accept related products, services, sub-categories
   - Only reject if COMPLETELY unrelated

3. EXCLUSION CHECK (${exclusion}):
   - "large/MNC": Reject Fortune 500, global multinationals, stock listed, >1000 employees
   - "distributor": Reject if ONLY distributes (not if also trades/manufactures)
   - "manufacturer": Reject if ONLY manufactures

4. SPAM CHECK:
   - Reject directories, marketplaces, aggregators, domain-for-sale

5. IF WEBSITE COULDN'T BE FETCHED:
   - Give benefit of doubt → ACCEPT (unless name clearly wrong)

Return JSON: {"valid": true/false, "reason": "brief", "corrected_hq": "City, Country or null"}`
        },
        {
          role: 'user',
          content: `Company: ${company.company_name}
Website: ${company.website}
Claimed HQ: ${company.hq}
Business: ${business}
Countries: ${country}
Exclusions: ${exclusion}

Website content:
${pageText ? pageText.substring(0, 4000) : 'Could not fetch - give benefit of doubt'}`
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
    // On error, default to ACCEPT (lenient)
    console.log(`    Validation error for ${company.company_name}, accepting by default`);
    return { valid: true, corrected_hq: company.hq };
  }
}

async function parallelValidation(companies, business, country, exclusion) {
  console.log(`\nValidating ${companies.length} companies (lenient mode)...`);
  const startTime = Date.now();
  const batchSize = 10;
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

// ============ SLOW ENDPOINT (2x queries) ============

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

    // Run search twice with different phrasings
    const companies1 = await comprehensiveSearch(Business, Country, Exclusion);
    const companies2 = await comprehensiveSearch(`${Business} supplier vendor dealer`, Country, Exclusion);

    const allCompanies = [...companies1, ...companies2];
    const uniqueCompanies = dedupeCompanies(allCompanies);
    console.log(`\nFound ${uniqueCompanies.length} unique companies from exhaustive search`);

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
  res.json({ status: 'ok', service: 'Find Target v11 - Comprehensive 11-Strategy Search' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
