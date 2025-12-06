require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');

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

// Perplexity API call
async function searchWithPerplexity(query) {
  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [{ role: 'user', content: query }]
    })
  });
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// Main search function
async function findCompanies(business, country, exclusion) {
  const companies = new Map();

  // Search queries with different angles
  const searchQueries = [
    `List real ${business} companies headquartered in ${country}. Exclude ${exclusion}. Provide company name, website URL, and city headquarters for each.`,
    `Find ${business} businesses based in ${country}, not ${exclusion}. Include their official websites and HQ locations.`,
    `${business} firms in ${country} excluding ${exclusion}. List company names with websites and headquarters city.`,
    `Local ${business} companies in ${country} cities. No ${exclusion}. Show name, website, HQ location.`,
    `${country} based ${business} directory. Exclude ${exclusion}. Provide name, website, headquarters.`
  ];

  console.log('Starting company search...');

  // Run searches
  for (let i = 0; i < searchQueries.length; i++) {
    console.log(`Running search ${i + 1}/${searchQueries.length}...`);
    try {
      const result = await searchWithPerplexity(searchQueries[i]);

      // Extract companies using OpenAI
      const extraction = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Extract company information from the text. Return ONLY a JSON array of objects with keys: company_name, website, hq.
            Rules:
            - website must be a valid URL starting with http
            - hq must be "City, ${country}" format
            - Only include companies actually headquartered in ${country}
            - Exclude any ${exclusion}
            Return [] if no valid companies found.`
          },
          {
            role: 'user',
            content: result
          }
        ],
        response_format: { type: 'json_object' }
      });

      const content = extraction.choices[0].message.content;
      let parsed;
      try {
        parsed = JSON.parse(content);
        const companyList = parsed.companies || parsed.data || parsed;
        if (Array.isArray(companyList)) {
          for (const company of companyList) {
            if (company.company_name && company.website && company.hq) {
              // Use website as key to deduplicate
              const key = company.website.toLowerCase().replace(/\/$/, '');
              if (!companies.has(key)) {
                companies.set(key, {
                  company_name: company.company_name.trim(),
                  website: company.website.trim(),
                  hq: company.hq.trim()
                });
              }
            }
          }
        }
      } catch (e) {
        console.log('Parse error, continuing...');
      }
    } catch (error) {
      console.error(`Search ${i + 1} failed:`, error.message);
    }
  }

  console.log(`Found ${companies.size} unique companies`);
  return Array.from(companies.values());
}

// Validate companies
async function validateCompanies(companies, business, country, exclusion) {
  if (companies.length === 0) return [];

  console.log('Validating companies...');

  const validation = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are validating a list of companies.

        Criteria:
        - Business type: ${business}
        - Must be headquartered in: ${country}
        - Must NOT be: ${exclusion}

        Return ONLY a JSON array of companies that pass ALL criteria.
        Each object must have: company_name, website, hq
        Remove any duplicates or invalid entries.
        Return [] if none pass.`
      },
      {
        role: 'user',
        content: JSON.stringify(companies)
      }
    ],
    response_format: { type: 'json_object' }
  });

  try {
    const content = validation.choices[0].message.content;
    const parsed = JSON.parse(content);
    return parsed.companies || parsed.data || parsed || [];
  } catch (e) {
    return companies;
  }
}

// Build HTML email
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
          <th>Company</th>
          <th>Website</th>
          <th>Headquarters</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const company of companies) {
    html += `
      <tr>
        <td>${company.company_name}</td>
        <td><a href="${company.website}">${company.website}</a></td>
        <td>${company.hq}</td>
      </tr>
    `;
  }

  html += `
      </tbody>
    </table>
  `;

  return html;
}

// Main endpoint
app.post('/api/find-target', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  // Validate input
  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n=== New Request ===`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);

  // Send immediate response
  res.json({
    success: true,
    message: 'Request received. Results will be emailed within 45 minutes.'
  });

  // Process in background
  try {
    // Search for companies
    const rawCompanies = await findCompanies(Business, Country, Exclusion);

    // Validate
    const validCompanies = await validateCompanies(rawCompanies, Business, Country, Exclusion);

    // Build email
    const htmlContent = buildEmailHTML(validCompanies, Business, Country, Exclusion);

    // Send email
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: Email,
      subject: `${Business} in ${Country} exclude ${Exclusion} (${validCompanies.length} companies)`,
      html: htmlContent
    });

    console.log(`Email sent to ${Email} with ${validCompanies.length} companies`);
  } catch (error) {
    console.error('Processing error:', error);

    // Send error email
    try {
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: Email,
        subject: `Find Target - Error Processing Request`,
        html: `<p>Sorry, there was an error processing your request for "${Business}" in "${Country}".</p><p>Please try again later.</p>`
      });
    } catch (emailError) {
      console.error('Failed to send error email:', emailError);
    }
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Find Target Backend' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
