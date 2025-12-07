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

// Send email using Brevo API (free tier allows any recipient)
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
      timeout: 30000
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
      timeout: 30000
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

// ============ EXTRACTION & DEDUPLICATION ============

async function extractCompanies(text, country) {
  if (!text) return [];
  try {
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract company information. Return JSON: {"companies": [{company_name, website, hq}]}
- website must start with http
- hq format: "City, Country"
- Only companies in ${country}
Return {"companies": []} if none.`
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

function dedupeCompanies(allCompanies) {
  const seen = new Map();
  for (const c of allCompanies) {
    if (c && c.website) {
      const key = c.website.toLowerCase().replace(/\/$/, '').replace(/^https?:\/\//, '');
      if (!seen.has(key)) {
        seen.set(key, c);
      }
    }
  }
  return Array.from(seen.values());
}

// ============ PARALLEL SEARCH ============

// Generate all search queries
function generateQueries(business, country, exclusion) {
  const cityMap = {
    'Malaysia': ['Kuala Lumpur', 'Penang', 'Johor Bahru', 'Shah Alam', 'Petaling Jaya'],
    'Singapore': ['Singapore'],
    'Thailand': ['Bangkok', 'Chonburi', 'Rayong', 'Samut Prakan', 'Ayutthaya'],
    'Indonesia': ['Jakarta', 'Surabaya', 'Bandung', 'Medan', 'Bekasi'],
    'Vietnam': ['Ho Chi Minh City', 'Hanoi', 'Da Nang', 'Hai Phong', 'Binh Duong'],
    'Philippines': ['Manila', 'Cebu', 'Davao', 'Quezon City', 'Makati']
  };

  const countries = country.split(',').map(c => c.trim());

  // Gemini queries
  const geminiQueries = [
    `List ${business} companies headquartered in ${country}. Exclude ${exclusion}. Provide company name, website URL, headquarters city.`,
    `Find ${business} suppliers and distributors in ${country}. Not ${exclusion}. Include websites.`,
    `${business} vendors based in ${country} excluding ${exclusion}. List with official websites.`,
    `Directory of ${business} firms in ${country}. No ${exclusion}. Company name, website, HQ city.`,
    `${country} ${business} companies list with websites. Exclude ${exclusion}.`,
    `Local ${business} dealers in ${country}. Not ${exclusion}. Names and websites.`,
    `${business} traders and wholesalers in ${country}. Exclude ${exclusion}.`,
    `Find all ${business} in ${country} cities. No ${exclusion}. With websites.`
  ];

  // Add city-specific Gemini queries
  for (const c of countries) {
    const cities = cityMap[c] || [c];
    for (const city of cities.slice(0, 3)) {
      geminiQueries.push(`${business} companies in ${city}, ${c}. Exclude ${exclusion}. List company name, website, city.`);
    }
  }

  // Perplexity queries (web search)
  const perplexityQueries = [
    `Search for ${business} companies in ${country}. Exclude ${exclusion}. List company names and websites.`,
    `Find more ${business} distributors in ${country}. No ${exclusion}. Official websites only.`,
    `${country} ${business} supplier directory. Exclude ${exclusion}. With website URLs.`,
    `List of ${business} vendors operating in ${country}. Not ${exclusion}.`,
    `${business} resellers and agents in ${country}. Exclude ${exclusion}.`,
    `Find ${business} importers in ${country}. No ${exclusion}. Websites required.`,
    `${business} companies that exhibited at trade shows in ${country}. Exclude ${exclusion}. With websites.`,
    `List of ${business} exhibitors from ${country} at industry events. No ${exclusion}.`,
    `${country} ${business} companies at conferences and expos. Exclude ${exclusion}. Websites required.`,
    `Find ${business} firms that participated in ${country} trade fairs. Not ${exclusion}.`
  ];

  // ChatGPT queries
  const chatgptQueries = [
    `List ${business} companies that are members of trade associations in ${country}. Exclude ${exclusion}. Include websites.`,
    `${business} companies from ${country} industry directories. No ${exclusion}. Names and websites.`,
    `Find ${business} firms registered with chambers of commerce in ${country}. Exclude ${exclusion}.`,
    `${country} ${business} association member companies. Not ${exclusion}. With official websites.`,
    `Trade directory listing of ${business} in ${country}. Exclude ${exclusion}.`,
    `What are some lesser-known ${business} companies in ${country}? Exclude ${exclusion}. Include websites.`,
    `Small and medium ${business} enterprises in ${country}. Not ${exclusion}. With official sites.`,
    `Family-owned ${business} businesses in ${country}. Exclude ${exclusion}. Websites needed.`,
    `New or emerging ${business} companies in ${country}. No ${exclusion}. List with websites.`,
    `Regional ${business} players in ${country}. Exclude ${exclusion}. Company websites.`
  ];

  return { geminiQueries, perplexityQueries, chatgptQueries };
}

// Run all searches in parallel
async function parallelSearch(business, country, exclusion) {
  console.log('Starting PARALLEL search...');
  const startTime = Date.now();

  const { geminiQueries, perplexityQueries, chatgptQueries } = generateQueries(business, country, exclusion);

  console.log(`  Gemini queries: ${geminiQueries.length}`);
  console.log(`  Perplexity queries: ${perplexityQueries.length}`);
  console.log(`  ChatGPT queries: ${chatgptQueries.length}`);
  console.log(`  Total queries: ${geminiQueries.length + perplexityQueries.length + chatgptQueries.length}`);

  // Run all API calls in parallel
  const [geminiResults, perplexityResults, chatgptResults] = await Promise.all([
    // Gemini - run all queries in parallel
    Promise.all(geminiQueries.map(q => callGemini(q))),
    // Perplexity - run all queries in parallel
    Promise.all(perplexityQueries.map(q => callPerplexity(q))),
    // ChatGPT - run all queries in parallel
    Promise.all(chatgptQueries.map(q => callChatGPT(q)))
  ]);

  console.log(`  All API calls done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Extract companies from all results in parallel
  const allTexts = [...geminiResults, ...perplexityResults, ...chatgptResults];
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

// ============ PARALLEL VALIDATION ============

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

async function validateCompany(company, business, country, exclusion, pageText) {
  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Validate if company matches criteria. Return JSON: {"valid": true/false, "reason": "..."}
REJECT if: HQ not in ${country}, is ${exclusion}, is directory/marketplace, not a real ${business} company.`
        },
        {
          role: 'user',
          content: `Company: ${company.company_name}\nWebsite: ${company.website}\nHQ: ${company.hq}\nBusiness: ${business}\nCountry: ${country}\nExclusions: ${exclusion}\n\nWebsite preview:\n${pageText ? pageText.substring(0, 3000) : 'Could not fetch'}`
        }
      ],
      response_format: { type: 'json_object' }
    });
    const result = JSON.parse(validation.choices[0].message.content);
    return result.valid === true;
  } catch (e) {
    return true;
  }
}

async function parallelValidation(companies, business, country, exclusion) {
  console.log(`\nStarting PARALLEL validation of ${companies.length} companies...`);
  const startTime = Date.now();
  const batchSize = 10; // Increased batch size
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
      if (validations[idx]) validated.push(company);
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

    // PARALLEL SEARCH
    const companies = await parallelSearch(Business, Country, Exclusion);
    console.log(`\nFound ${companies.length} unique companies`);

    // PARALLEL VALIDATION
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
  res.json({ status: 'ok', service: 'Find Target Backend v3 - Parallel' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
