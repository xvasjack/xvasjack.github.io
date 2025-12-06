require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Gmail transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// ============ AI TOOLS ============

// Gemini API call
async function callGemini(prompt) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (error) {
    console.error('Gemini error:', error.message);
    return '';
  }
}

// Perplexity API call (has web search)
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
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('Perplexity error:', error.message);
    return '';
  }
}

// OpenAI ChatGPT call
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

// ============ AGENT FUNCTIONS ============

// Extract companies from AI response
async function extractCompanies(text, country) {
  if (!text) return [];

  try {
    const extraction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract company information from the text. Return ONLY a valid JSON array.
Each object must have: company_name, website, hq
- website must start with http
- hq format: "City, Country"
- Only companies in ${country}
Return [] if none found.`
        },
        { role: 'user', content: text }
      ],
      response_format: { type: 'json_object' }
    });

    const content = extraction.choices[0].message.content;
    const parsed = JSON.parse(content);
    return parsed.companies || parsed.data || parsed || [];
  } catch (e) {
    return [];
  }
}

// Merge companies without duplicates
function mergeCompanies(existing, newOnes) {
  const seen = new Map();

  for (const c of existing) {
    if (c.website) {
      const key = c.website.toLowerCase().replace(/\/$/, '').replace(/^https?:\/\//, '');
      seen.set(key, c);
    }
  }

  for (const c of newOnes) {
    if (c.website) {
      const key = c.website.toLowerCase().replace(/\/$/, '').replace(/^https?:\/\//, '');
      if (!seen.has(key)) {
        seen.set(key, c);
      }
    }
  }

  return Array.from(seen.values());
}

// Agent 1: Gemini - General search with synonyms
async function agent1Gemini(business, country, exclusion) {
  console.log('Agent 1 (Gemini): Starting general search...');

  const queries = [
    `List ${business} companies headquartered in ${country}. Exclude ${exclusion}. Provide company name, website URL, headquarters city.`,
    `Find ${business} suppliers and distributors in ${country}. Not ${exclusion}. Include websites.`,
    `${business} vendors based in ${country} excluding ${exclusion}. List with official websites.`,
    `Directory of ${business} firms in ${country}. No ${exclusion}. Company name, website, HQ city.`,
    `${country} ${business} companies list with websites. Exclude ${exclusion}.`,
    `Local ${business} dealers in ${country}. Not ${exclusion}. Names and websites.`,
    `${business} traders and wholesalers in ${country}. Exclude ${exclusion}.`,
    `Find all ${business} in ${country} cities. No ${exclusion}. With websites.`
  ];

  let allCompanies = [];

  for (const query of queries) {
    const result = await callGemini(query);
    const companies = await extractCompanies(result, country);
    allCompanies = mergeCompanies(allCompanies, companies);
    console.log(`  Query done. Total: ${allCompanies.length}`);
  }

  console.log(`Agent 1 done. Found: ${allCompanies.length}`);
  return allCompanies;
}

// Agent 2: Perplexity - Web search with variations
async function agent2Perplexity(business, country, exclusion, previous) {
  console.log('Agent 2 (Perplexity): Web search with variations...');

  const queries = [
    `Search for ${business} companies in ${country}. Exclude ${exclusion}. List company names and websites.`,
    `Find more ${business} distributors in ${country}. No ${exclusion}. Official websites only.`,
    `${country} ${business} supplier directory. Exclude ${exclusion}. With website URLs.`,
    `List of ${business} vendors operating in ${country}. Not ${exclusion}.`,
    `${business} resellers and agents in ${country}. Exclude ${exclusion}.`,
    `Find ${business} importers in ${country}. No ${exclusion}. Websites required.`
  ];

  let allCompanies = [...previous];

  for (const query of queries) {
    const result = await callPerplexity(query);
    const companies = await extractCompanies(result, country);
    allCompanies = mergeCompanies(allCompanies, companies);
    console.log(`  Query done. Total: ${allCompanies.length}`);
  }

  console.log(`Agent 2 done. Total: ${allCompanies.length}`);
  return allCompanies;
}

// Agent 3: ChatGPT - Industry associations and trade directories
async function agent3ChatGPT(business, country, exclusion, previous) {
  console.log('Agent 3 (ChatGPT): Industry associations & trade directories...');

  const queries = [
    `List ${business} companies that are members of trade associations in ${country}. Exclude ${exclusion}. Include websites.`,
    `${business} companies from ${country} industry directories. No ${exclusion}. Names and websites.`,
    `Find ${business} firms registered with chambers of commerce in ${country}. Exclude ${exclusion}.`,
    `${country} ${business} association member companies. Not ${exclusion}. With official websites.`,
    `Trade directory listing of ${business} in ${country}. Exclude ${exclusion}.`
  ];

  let allCompanies = [...previous];

  for (const query of queries) {
    const result = await callChatGPT(query);
    const companies = await extractCompanies(result, country);
    allCompanies = mergeCompanies(allCompanies, companies);
    console.log(`  Query done. Total: ${allCompanies.length}`);
  }

  console.log(`Agent 3 done. Total: ${allCompanies.length}`);
  return allCompanies;
}

// Agent 4: Gemini - City-specific and local registries
async function agent4Gemini(business, country, exclusion, previous) {
  console.log('Agent 4 (Gemini): City-specific search...');

  // Common cities by country
  const cityMap = {
    'Malaysia': ['Kuala Lumpur', 'Penang', 'Johor Bahru', 'Shah Alam', 'Petaling Jaya'],
    'Singapore': ['Singapore'],
    'Thailand': ['Bangkok', 'Chonburi', 'Rayong', 'Samut Prakan', 'Ayutthaya'],
    'Indonesia': ['Jakarta', 'Surabaya', 'Bandung', 'Medan', 'Bekasi'],
    'Vietnam': ['Ho Chi Minh City', 'Hanoi', 'Da Nang', 'Hai Phong', 'Binh Duong'],
    'Philippines': ['Manila', 'Cebu', 'Davao', 'Quezon City', 'Makati']
  };

  const countries = country.split(',').map(c => c.trim());
  let allCompanies = [...previous];

  for (const c of countries) {
    const cities = cityMap[c] || [c];
    for (const city of cities.slice(0, 3)) {
      const query = `${business} companies in ${city}, ${c}. Exclude ${exclusion}. List company name, website, city.`;
      const result = await callGemini(query);
      const companies = await extractCompanies(result, c);
      allCompanies = mergeCompanies(allCompanies, companies);
      console.log(`  ${city} done. Total: ${allCompanies.length}`);
    }
  }

  console.log(`Agent 4 done. Total: ${allCompanies.length}`);
  return allCompanies;
}

// Agent 5: Perplexity - Exhibition participants and industry events
async function agent5Perplexity(business, country, exclusion, previous) {
  console.log('Agent 5 (Perplexity): Exhibition & event participants...');

  const queries = [
    `${business} companies that exhibited at trade shows in ${country}. Exclude ${exclusion}. With websites.`,
    `List of ${business} exhibitors from ${country} at industry events. No ${exclusion}.`,
    `${country} ${business} companies at conferences and expos. Exclude ${exclusion}. Websites required.`,
    `Find ${business} firms that participated in ${country} trade fairs. Not ${exclusion}.`,
    `${business} booth exhibitors from ${country}. Exclude ${exclusion}. Company websites.`
  ];

  let allCompanies = [...previous];

  for (const query of queries) {
    const result = await callPerplexity(query);
    const companies = await extractCompanies(result, country);
    allCompanies = mergeCompanies(allCompanies, companies);
    console.log(`  Query done. Total: ${allCompanies.length}`);
  }

  console.log(`Agent 5 done. Total: ${allCompanies.length}`);
  return allCompanies;
}

// Agent 6: ChatGPT - Creative final pass
async function agent6ChatGPT(business, country, exclusion, previous) {
  console.log('Agent 6 (ChatGPT): Creative final pass...');

  const queries = [
    `What are some lesser-known ${business} companies in ${country}? Exclude ${exclusion}. Include websites.`,
    `Small and medium ${business} enterprises in ${country}. Not ${exclusion}. With official sites.`,
    `Family-owned ${business} businesses in ${country}. Exclude ${exclusion}. Websites needed.`,
    `New or emerging ${business} companies in ${country}. No ${exclusion}. List with websites.`,
    `Regional ${business} players in ${country}. Exclude ${exclusion}. Company websites.`
  ];

  let allCompanies = [...previous];

  for (const query of queries) {
    const result = await callChatGPT(query);
    const companies = await extractCompanies(result, country);
    allCompanies = mergeCompanies(allCompanies, companies);
    console.log(`  Query done. Total: ${allCompanies.length}`);
  }

  console.log(`Agent 6 done. Total: ${allCompanies.length}`);
  return allCompanies;
}

// ============ VALIDATION ============

// Fetch website content
async function fetchWebsite(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompanyFinder/1.0)' }
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();

    // Clean HTML
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

// Validate single company
async function validateCompany(company, business, country, exclusion, pageText) {
  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are validating if a company matches criteria. Be STRICT.
Return JSON: { "valid": true/false, "reason": "..." }

REJECT if:
- HQ is NOT in ${country}
- Company is a ${exclusion}
- It's a directory/marketplace/social media site
- Website doesn't match a real ${business} company`
        },
        {
          role: 'user',
          content: `Company: ${company.company_name}
Website: ${company.website}
Claimed HQ: ${company.hq}
Business type needed: ${business}
Country needed: ${country}
Exclusions: ${exclusion}

Website content preview:
${pageText ? pageText.substring(0, 3000) : 'Could not fetch'}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(validation.choices[0].message.content);
    return result.valid === true;
  } catch (e) {
    return true; // Keep if validation fails
  }
}

// Validate all companies
async function validateCompanies(companies, business, country, exclusion) {
  console.log(`Validating ${companies.length} companies...`);

  const validated = [];
  const batchSize = 5;

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);

    const results = await Promise.all(batch.map(async (company) => {
      const pageText = await fetchWebsite(company.website);
      const isValid = await validateCompany(company, business, country, exclusion, pageText);
      return isValid ? company : null;
    }));

    validated.push(...results.filter(c => c !== null));
    console.log(`  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`);
  }

  console.log(`Validation done. Valid companies: ${validated.length}`);
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
        <tr>
          <th>#</th>
          <th>Company</th>
          <th>Website</th>
          <th>Headquarters</th>
        </tr>
      </thead>
      <tbody>
  `;

  companies.forEach((company, index) => {
    html += `
      <tr>
        <td>${index + 1}</td>
        <td>${company.company_name}</td>
        <td><a href="${company.website}">${company.website}</a></td>
        <td>${company.hq}</td>
      </tr>
    `;
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

  // Send immediate response
  res.json({
    success: true,
    message: 'Request received. Results will be emailed within 45 minutes.'
  });

  // Process in background
  try {
    // Run 6 agents sequentially
    let companies = await agent1Gemini(Business, Country, Exclusion);
    companies = await agent2Perplexity(Business, Country, Exclusion, companies);
    companies = await agent3ChatGPT(Business, Country, Exclusion, companies);
    companies = await agent4Gemini(Business, Country, Exclusion, companies);
    companies = await agent5Perplexity(Business, Country, Exclusion, companies);
    companies = await agent6ChatGPT(Business, Country, Exclusion, companies);

    console.log(`\nTotal before validation: ${companies.length}`);

    // Validate companies
    const validCompanies = await validateCompanies(companies, Business, Country, Exclusion);

    // Build and send email
    const htmlContent = buildEmailHTML(validCompanies, Business, Country, Exclusion);

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: Email,
      subject: `${Business} in ${Country} exclude ${Exclusion} (${validCompanies.length} companies)`,
      html: htmlContent
    });

    console.log(`\nEMAIL SENT to ${Email} with ${validCompanies.length} companies`);
  } catch (error) {
    console.error('Processing error:', error);

    try {
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: Email,
        subject: `Find Target - Error Processing Request`,
        html: `<p>Sorry, there was an error processing your request for "${Business}" in "${Country}".</p><p>Error: ${error.message}</p><p>Please try again later.</p>`
      });
    } catch (emailError) {
      console.error('Failed to send error email:', emailError);
    }
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Find Target Backend v2' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
