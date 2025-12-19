require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const OpenAI = require('openai');
const fetch = require('node-fetch');
const pptxgen = require('pptxgenjs');
const XLSX = require('xlsx');
const multer = require('multer');
const { createClient } = require('@deepgram/sdk');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle } = require('docx');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Multer configuration for file uploads (memory storage)
const upload = multer({ storage: multer.memoryStorage() });

// Check required environment variables
const requiredEnvVars = ['OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'GEMINI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
const optionalEnvVars = ['SERPAPI_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPGRAM_API_KEY']; // Optional but recommended
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}
if (!process.env.SERPAPI_API_KEY) {
  console.warn('SERPAPI_API_KEY not set - Google search will be skipped');
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.warn('DEEPSEEK_API_KEY not set - Due Diligence reports will use GPT-4o fallback');
}
if (!process.env.DEEPGRAM_API_KEY) {
  console.warn('DEEPGRAM_API_KEY not set - Real-time transcription will not work');
}

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'missing'
});

// Initialize Deepgram
const deepgram = process.env.DEEPGRAM_API_KEY ? createClient(process.env.DEEPGRAM_API_KEY) : null;

// Initialize Cloudflare R2 (S3-compatible)
const r2Client = (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      }
    })
  : null;

const R2_BUCKET = process.env.R2_BUCKET_NAME || 'dd-recordings';

if (!r2Client) {
  console.warn('R2 not configured - recordings will only be stored in memory. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME');
}

// R2 Upload function
async function uploadToR2(key, data, contentType = 'audio/webm') {
  if (!r2Client) {
    console.warn('[R2] R2 not configured, skipping upload');
    return null;
  }

  try {
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: data,
      ContentType: contentType
    });
    await r2Client.send(command);
    console.log(`[R2] Uploaded ${key} (${data.length} bytes)`);
    return key;
  } catch (error) {
    console.error('[R2] Upload error:', error.message);
    return null;
  }
}

// R2 Download function
async function downloadFromR2(key) {
  if (!r2Client) {
    return null;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key
    });
    const response = await r2Client.send(command);
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    console.error('[R2] Download error:', error.message);
    return null;
  }
}

// R2 Delete function (cleanup old recordings)
async function deleteFromR2(key) {
  if (!r2Client) {
    return false;
  }

  try {
    const command = new DeleteObjectCommand({
      Bucket: R2_BUCKET,
      Key: key
    });
    await r2Client.send(command);
    console.log(`[R2] Deleted ${key}`);
    return true;
  } catch (error) {
    console.error('[R2] Delete error:', error.message);
    return false;
  }
}

// Send email using SendGrid API
async function sendEmail(to, subject, html, attachments = null) {
  const senderEmail = process.env.SENDER_EMAIL;
  const emailData = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: senderEmail, name: 'Find Target' },
    subject: subject,
    content: [{ type: 'text/html', value: html }]
  };

  if (attachments) {
    const attachmentList = Array.isArray(attachments) ? attachments : [attachments];
    emailData.attachments = attachmentList.map(a => ({
      filename: a.name,
      content: a.content,
      type: 'application/octet-stream',
      disposition: 'attachment'
    }));
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailData)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Email failed: ${error}`);
  }

  return { success: true };
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
        model: 'sonar',
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

// OpenAI Search model - has real-time web search capability
// Note: gpt-4o-mini-search-preview does NOT support temperature parameter
async function callOpenAISearch(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini-search-preview',
      messages: [{ role: 'user', content: prompt }]
    });
    return response.choices[0].message.content || '';
  } catch (error) {
    console.error('OpenAI Search error:', error.message);
    // Fallback to regular gpt-4o if search model not available
    return callChatGPT(prompt);
  }
}

// DeepSeek Reasoner - for deep thinking/analysis tasks
async function callDeepSeekReasoner(prompt, maxTokens = 8000) {
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens
      }),
      timeout: 120000
    });
    const data = await response.json();

    // DeepSeek reasoner returns reasoning_content and content
    const reasoning = data.choices?.[0]?.message?.reasoning_content || '';
    const content = data.choices?.[0]?.message?.content || '';

    return { reasoning, content, raw: data };
  } catch (error) {
    console.error('DeepSeek Reasoner error:', error.message);
    return { reasoning: '', content: '', error: error.message };
  }
}

// DeepSeek Chat - for faster, simpler tasks
async function callDeepSeekChat(prompt, maxTokens = 4000) {
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3
      }),
      timeout: 60000
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('DeepSeek Chat error:', error.message);
    return '';
  }
}

// SerpAPI - Google Search integration
async function callSerpAPI(query) {
  if (!process.env.SERPAPI_API_KEY) {
    return '';
  }
  try {
    const params = new URLSearchParams({
      q: query,
      api_key: process.env.SERPAPI_API_KEY,
      engine: 'google',
      num: 100 // Get more results
    });
    const response = await fetch(`https://serpapi.com/search?${params}`, {
      timeout: 30000
    });
    const data = await response.json();

    // Extract organic results
    const results = [];
    if (data.organic_results) {
      for (const result of data.organic_results) {
        results.push({
          title: result.title || '',
          link: result.link || '',
          snippet: result.snippet || ''
        });
      }
    }
    return JSON.stringify(results);
  } catch (error) {
    console.error('SerpAPI error:', error.message);
    return '';
  }
}

// DeepSeek V3.2 - Cost-effective alternative to GPT-4o
async function callDeepSeek(prompt, maxTokens = 4000) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('DeepSeek API key not set, falling back to GPT-4o');
    return null; // Caller should handle fallback
  }
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3
      }),
      timeout: 120000
    });
    const data = await response.json();
    if (data.error) {
      console.error('DeepSeek API error:', data.error);
      return null;
    }
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('DeepSeek error:', error.message);
    return null;
  }
}

// Transcribe audio using OpenAI Whisper
async function transcribeAudio(audioBase64, mimeType, language = 'auto') {
  try {
    // Convert base64 to buffer
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Create form data for OpenAI API
    const FormData = require('form-data');
    const formData = new FormData();

    // Determine file extension from mime type
    const extMap = {
      'audio/webm': 'webm',
      'audio/mp3': 'mp3',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/m4a': 'm4a',
      'audio/mp4': 'm4a',
      'audio/ogg': 'ogg',
      'audio/flac': 'flac'
    };
    const ext = extMap[mimeType] || 'webm';

    formData.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');

    // If specific language is provided (not auto), use it
    if (language && language !== 'auto') {
      formData.append('language', language);
    }

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    const data = await response.json();
    if (data.error) {
      console.error('Whisper API error:', data.error);
      return { text: '', language: 'unknown', error: data.error.message };
    }

    return {
      text: data.text || '',
      language: data.language || 'unknown',
      duration: data.duration || 0,
      segments: data.segments || []
    };
  } catch (error) {
    console.error('Whisper transcription error:', error.message);
    return { text: '', language: 'unknown', error: error.message };
  }
}

// Translate text using GPT-4o
async function translateText(text, targetLang = 'en') {
  if (!text || text.length < 10) return text;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Translate the following text to ${targetLang === 'en' ? 'English' : targetLang}. Only output the translation, nothing else:\n\n${text}`
      }],
      temperature: 0.2
    });
    return response.choices[0].message.content || text;
  } catch (error) {
    console.error('Translation error:', error.message);
    return text;
  }
}

// Generate meeting minutes from transcript
async function generateMeetingMinutes(transcript, instructions = '') {
  const prompt = `You are an expert meeting summarizer. Create structured meeting minutes from the following transcript.

TRANSCRIPT:
${transcript}

${instructions ? `SPECIAL INSTRUCTIONS: ${instructions}\n` : ''}

Generate professional meeting minutes in HTML format with the following structure:
1. <h2>Meeting Summary</h2> - Brief overview (2-3 sentences)
2. <h2>Key Discussion Points</h2> - Main topics discussed
3. <h2>Decisions Made</h2> - Any decisions or conclusions reached
4. <h2>Action Items</h2> - Tasks assigned with responsible parties if mentioned
5. <h2>Next Steps</h2> - Follow-up items or future meetings

Use proper HTML formatting with bullet points (<ul><li>) where appropriate.
Be concise but capture all important information.`;

  const result = await callDeepSeek(prompt, 3000);
  if (result) return result;

  // Fallback to GPT-4o
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 3000
    });
    return response.choices[0].message.content || '';
  } catch (error) {
    console.error('Meeting minutes error:', error.message);
    return `<h2>Transcript</h2><p>${transcript}</p>`;
  }
}

// Generate Word document from HTML content
async function generateWordDocument(title, htmlContent, metadata = {}) {
  // Parse HTML content into sections
  const sections = [];

  // Add title
  sections.push(new Paragraph({
    text: title,
    heading: HeadingLevel.TITLE,
    spacing: { after: 400 }
  }));

  // Add metadata
  if (metadata.date) {
    sections.push(new Paragraph({
      children: [
        new TextRun({ text: 'Date: ', bold: true }),
        new TextRun({ text: metadata.date })
      ],
      spacing: { after: 100 }
    }));
  }
  if (metadata.preparedFor) {
    sections.push(new Paragraph({
      children: [
        new TextRun({ text: 'Prepared For: ', bold: true }),
        new TextRun({ text: metadata.preparedFor })
      ],
      spacing: { after: 200 }
    }));
  }

  // Simple HTML to docx conversion
  const cleanHtml = htmlContent
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n');

  // Extract headings and content
  const h1Regex = /<h1[^>]*>(.*?)<\/h1>/gi;
  const h2Regex = /<h2[^>]*>(.*?)<\/h2>/gi;
  const h3Regex = /<h3[^>]*>(.*?)<\/h3>/gi;

  // Split content by headings and process
  let processedContent = htmlContent;

  // Replace headings with markers
  processedContent = processedContent.replace(h1Regex, '|||H1|||$1|||/H1|||');
  processedContent = processedContent.replace(h2Regex, '|||H2|||$1|||/H2|||');
  processedContent = processedContent.replace(h3Regex, '|||H3|||$1|||/H3|||');

  // Remove other HTML tags
  processedContent = processedContent
    .replace(/<ul>/gi, '')
    .replace(/<\/ul>/gi, '')
    .replace(/<ol>/gi, '')
    .replace(/<\/ol>/gi, '')
    .replace(/<li>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<strong>/gi, '**')
    .replace(/<\/strong>/gi, '**')
    .replace(/<b>/gi, '**')
    .replace(/<\/b>/gi, '**')
    .replace(/<em>/gi, '_')
    .replace(/<\/em>/gi, '_')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');

  // Process the content with markers
  const parts = processedContent.split('|||');

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;

    if (part === 'H1' && parts[i + 1]) {
      sections.push(new Paragraph({
        text: parts[i + 1].replace('/H1', '').trim(),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 }
      }));
      i++;
    } else if (part === 'H2' && parts[i + 1]) {
      sections.push(new Paragraph({
        text: parts[i + 1].replace('/H2', '').trim(),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 150 }
      }));
      i++;
    } else if (part === 'H3' && parts[i + 1]) {
      sections.push(new Paragraph({
        text: parts[i + 1].replace('/H3', '').trim(),
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 }
      }));
      i++;
    } else if (!part.startsWith('/H')) {
      // Regular text
      const lines = part.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // Handle bold text markers
        const children = [];
        const boldParts = trimmedLine.split('**');
        for (let j = 0; j < boldParts.length; j++) {
          if (boldParts[j]) {
            children.push(new TextRun({
              text: boldParts[j],
              bold: j % 2 === 1
            }));
          }
        }

        if (children.length > 0) {
          sections.push(new Paragraph({
            children,
            spacing: { after: 100 }
          }));
        }
      }
    }
  }

  const doc = new Document({
    sections: [{
      properties: {},
      children: sections
    }]
  });

  return await Packer.toBuffer(doc);
}

// ============ SEARCH CONFIGURATION ============

const CITY_MAP = {
  'malaysia': ['Kuala Lumpur', 'Penang', 'Johor Bahru', 'Shah Alam', 'Petaling Jaya', 'Selangor', 'Ipoh', 'Klang', 'Subang', 'Melaka', 'Kuching', 'Kota Kinabalu'],
  'singapore': ['Singapore', 'Jurong', 'Tuas', 'Woodlands'],
  'thailand': ['Bangkok', 'Chonburi', 'Rayong', 'Samut Prakan', 'Ayutthaya', 'Chiang Mai', 'Pathum Thani', 'Nonthaburi', 'Samut Sakhon'],
  'indonesia': ['Jakarta', 'Surabaya', 'Bandung', 'Medan', 'Bekasi', 'Tangerang', 'Semarang', 'Sidoarjo', 'Cikarang', 'Karawang', 'Bogor'],
  'vietnam': ['Ho Chi Minh City', 'Hanoi', 'Da Nang', 'Hai Phong', 'Binh Duong', 'Dong Nai', 'Long An', 'Ba Ria', 'Can Tho'],
  'philippines': ['Manila', 'Cebu', 'Davao', 'Quezon City', 'Makati', 'Laguna', 'Cavite', 'Batangas', 'Bulacan'],
  'southeast asia': ['Kuala Lumpur', 'Singapore', 'Bangkok', 'Jakarta', 'Ho Chi Minh City', 'Manila', 'Penang', 'Johor Bahru', 'Surabaya', 'Hanoi']
};

const LOCAL_SUFFIXES = {
  'malaysia': ['Sdn Bhd', 'Berhad'],
  'singapore': ['Pte Ltd', 'Private Limited'],
  'thailand': ['Co Ltd', 'Co., Ltd.'],
  'indonesia': ['PT', 'CV'],
  'vietnam': ['Co Ltd', 'JSC', 'Công ty'],
  'philippines': ['Inc', 'Corporation']
};

const DOMAIN_MAP = {
  'malaysia': '.my',
  'singapore': '.sg',
  'thailand': '.th',
  'indonesia': '.co.id',
  'vietnam': '.vn',
  'philippines': '.ph'
};

const LOCAL_LANGUAGE_MAP = {
  'thailand': { lang: 'Thai', examples: ['หมึก', 'สี', 'เคมี'] },
  'vietnam': { lang: 'Vietnamese', examples: ['mực in', 'sơn', 'hóa chất'] },
  'indonesia': { lang: 'Bahasa Indonesia', examples: ['tinta', 'cat', 'kimia'] },
  'philippines': { lang: 'Tagalog', examples: ['tinta', 'pintura'] },
  'malaysia': { lang: 'Bahasa Malaysia', examples: ['dakwat', 'cat'] }
};

// ============ 14 SPECIALIZED SEARCH STRATEGIES (inspired by n8n workflow) ============

function buildOutputFormat() {
  return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
}

// Strategy 1: Broad Google Search (SerpAPI)
function strategy1_BroadSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  // Generate synonyms and variations
  const terms = business.split(/\s+or\s+|\s+and\s+|,/).map(t => t.trim()).filter(t => t);

  for (const c of countries) {
    queries.push(
      `${business} companies ${c}`,
      `${business} manufacturers ${c}`,
      `${business} suppliers ${c}`,
      `list of ${business} companies in ${c}`,
      `${business} industry ${c}`
    );
    for (const term of terms) {
      queries.push(`${term} ${c}`);
    }
  }

  return queries;
}

// Strategy 2: Broad Perplexity Search (EXPANDED)
function strategy2_BroadPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  // General queries
  queries.push(
    `Find ALL ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Complete list of ${business} manufacturers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} producers and makers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `All local ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `SME and family-owned ${business} businesses in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Independent ${business} companies in ${country} not owned by multinationals. ${outputFormat}`
  );

  // Per-country queries for more specificity
  for (const c of countries) {
    queries.push(
      `List all ${business} companies based in ${c}. ${outputFormat}`,
      `${business} factories and plants in ${c}. ${outputFormat}`,
      `Local ${business} manufacturers in ${c}. ${outputFormat}`
    );
  }

  return queries;
}

// Strategy 3: Lists, Rankings, Top Companies (SerpAPI)
function strategy3_ListsSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  for (const c of countries) {
    queries.push(
      `top ${business} companies ${c}`,
      `biggest ${business} ${c}`,
      `leading ${business} manufacturers ${c}`,
      `list of ${business} ${c}`,
      `best ${business} suppliers ${c}`,
      `${business} industry ${c} overview`,
      `major ${business} players ${c}`
    );
  }

  return queries;
}

// Strategy 4: City-Specific Search (Perplexity) - EXPANDED to ALL cities
function strategy4_CitiesPerplexity(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  for (const c of countries) {
    const cities = CITY_MAP[c.toLowerCase()] || [c];
    // Use ALL cities, not just top 5
    for (const city of cities) {
      queries.push(
        `${business} companies in ${city}, ${c}. Exclude ${exclusion}. ${outputFormat}`,
        `${business} manufacturers near ${city}. ${outputFormat}`
      );
    }
  }

  return queries;
}

// Strategy 5: Industrial Zones + Local Naming (SerpAPI)
function strategy5_IndustrialSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  for (const c of countries) {
    const suffixes = LOCAL_SUFFIXES[c.toLowerCase()] || [];

    // Local naming conventions
    for (const suffix of suffixes) {
      queries.push(`${business} ${suffix} ${c}`);
    }

    // Industrial zones
    queries.push(
      `${business} industrial estate ${c}`,
      `${business} manufacturing zone ${c}`,
      `${business} factory ${c}`
    );
  }

  return queries;
}

// Strategy 6: Associations & Directories (Perplexity)
function strategy6_DirectoriesPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} companies in trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} firms in Kompass directory for ${country}. Not ${exclusion}. ${outputFormat}`,
    `Chamber of commerce ${business} members in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${country} ${business} industry association member list. No ${exclusion}. ${outputFormat}`,
    `${business} companies on Yellow Pages ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} business directory ${country}. Exclude ${exclusion}. ${outputFormat}`
  ];
}

// Strategy 7: Trade Shows & Exhibitions (Perplexity)
function strategy7_ExhibitionsPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} exhibitors at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies at industry exhibitions in ${country} region. Not ${exclusion}. ${outputFormat}`,
    `${business} participants at expos and conferences in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors at international fairs from ${country}. Not ${exclusion}. ${outputFormat}`
  ];
}

// Strategy 8: Import/Export & Supplier Databases (Perplexity)
function strategy8_TradePerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} suppliers on Alibaba from ${country}. Not ${exclusion}. ${outputFormat}`,
    `${country} ${business} companies on Global Sources. Exclude ${exclusion}. ${outputFormat}`,
    `${business} OEM suppliers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} contract manufacturers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} approved vendors in ${country}. Exclude ${exclusion}. ${outputFormat}`
  ];
}

// Strategy 9: Local Domains + News (Perplexity)
function strategy9_DomainsPerplexity(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  for (const c of countries) {
    const domain = DOMAIN_MAP[c.toLowerCase()];
    if (domain) {
      queries.push(
        `${business} companies with ${domain} websites. Exclude ${exclusion}. ${outputFormat}`
      );
    }
  }

  queries.push(
    `Recent news about ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} company announcements and press releases ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  return queries;
}

// Strategy 10: Government Registries (SerpAPI)
function strategy10_RegistriesSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  for (const c of countries) {
    queries.push(
      `${business} company registration ${c}`,
      `${business} registered companies ${c}`,
      `${business} business registry ${c}`
    );
  }

  return queries;
}

// Strategy 11: City + Industrial Areas (SerpAPI) - EXPANDED
function strategy11_CityIndustrialSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  for (const c of countries) {
    const cities = CITY_MAP[c.toLowerCase()] || [c];
    // Use ALL cities
    for (const city of cities) {
      queries.push(
        `${business} ${city}`,
        `${business} companies ${city}`,
        `${business} factory ${city}`,
        `${business} manufacturer ${city}`
      );
    }
  }

  return queries;
}

// Strategy 12: Deep Web Search (OpenAI Search) - EXPANDED with real-time search
function strategy12_DeepOpenAISearch(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  const countries = country.split(',').map(c => c.trim());
  const queries = [];

  // General deep searches
  queries.push(
    `Search the web for ${business} companies in ${country}. Find company websites, LinkedIn profiles, industry directories. Exclude ${exclusion}. ${outputFormat}`,
    `Find lesser-known ${business} companies in ${country} that may not appear in top search results. ${outputFormat}`,
    `Search for small and medium ${business} enterprises (SMEs) in ${country}. ${outputFormat}`,
    `Find independent local ${business} companies in ${country}, not subsidiaries of multinationals. ${outputFormat}`,
    `Search industry news and press releases for ${business} companies in ${country}. ${outputFormat}`,
    `Find ${business} startups and new companies in ${country}. ${outputFormat}`
  );

  // Per-country deep searches
  for (const c of countries) {
    queries.push(
      `Search for all ${business} manufacturers in ${c}. Include company name, website, and location. ${outputFormat}`,
      `Find ${business} producers in ${c} with their official websites. ${outputFormat}`
    );
  }

  return queries;
}

// Strategy 13: Industry Publications (Perplexity)
function strategy13_PublicationsPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} companies mentioned in industry magazines and trade publications for ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} market report ${country} - list all companies mentioned. Not ${exclusion}. ${outputFormat}`,
    `${business} industry analysis ${country} - companies covered. Exclude ${exclusion}. ${outputFormat}`,
    `${business} ${country} magazine articles listing companies. Not ${exclusion}. ${outputFormat}`
  ];
}

// Strategy 14: Final Sweep - Local Language + Comprehensive (OpenAI Search)
function strategy14_LocalLanguageOpenAISearch(business, country, exclusion) {
  const countries = country.split(',').map(c => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  // Local language searches
  queries.push(
    `Search for ${business} companies in ${country} using local language terms. Translate "${business}" to Thai, Vietnamese, Bahasa Indonesia, Tagalog, Malay as appropriate. ${outputFormat}`
  );

  for (const c of countries) {
    const langInfo = LOCAL_LANGUAGE_MAP[c.toLowerCase()];
    if (langInfo) {
      queries.push(
        `Search in ${langInfo.lang} for ${business} companies in ${c}. ${outputFormat}`,
        `Find ${business} manufacturers in ${c} using local language search terms. ${outputFormat}`
      );
    }
  }

  // Supply chain and related industry searches
  queries.push(
    `Find companies in the ${business} supply chain in ${country}. Include raw material suppliers and equipment makers. ${outputFormat}`,
    `Search for ${business} related companies in ${country}: formulators, blenders, repackagers. ${outputFormat}`,
    `Find niche and specialty ${business} companies in ${country}. ${outputFormat}`
  );

  // Final comprehensive sweep
  queries.push(
    `Comprehensive search: Find ALL ${business} companies in ${country} that have not been mentioned yet. Search obscure directories, local business listings, industry forums. ${outputFormat}`
  );

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
          content: `Extract company information from the text. Return JSON: {"companies": [{"company_name": "...", "website": "...", "hq": "..."}]}

RULES:
- Extract ALL companies mentioned that could be in: ${country}
- website must start with http:// or https://
- If website not in text, you may look it up if you know it's a real company
- hq must be "City, Country" format ONLY
- Include companies even if some info is incomplete - we'll verify later
- Be thorough - extract every company that might match`
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

// ============ DEDUPLICATION (Enhanced for v20) ============

function normalizeCompanyName(name) {
  if (!name) return '';
  return name.toLowerCase()
    // Remove ALL common legal suffixes globally (expanded list)
    .replace(/\s*(sdn\.?\s*bhd\.?|bhd\.?|berhad|pte\.?\s*ltd\.?|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|co\.?,?\s*ltd\.?|llc|llp|gmbh|s\.?a\.?|pt\.?|cv\.?|tbk\.?|jsc|plc|public\s*limited|private\s*limited|joint\s*stock|company|\(.*?\))$/gi, '')
    // Also remove these if they appear anywhere (for cases like "PT Company Name")
    .replace(/^(pt\.?|cv\.?)\s+/gi, '')
    .replace(/[^\w\s]/g, '')  // Remove special characters
    .replace(/\s+/g, ' ')      // Normalize spaces
    .trim();
}

function normalizeWebsite(url) {
  if (!url) return '';
  return url.toLowerCase()
    .replace(/^https?:\/\//, '')           // Remove protocol
    .replace(/^www\./, '')                  // Remove www
    .replace(/\/+$/, '')                    // Remove trailing slashes
    // Remove common path suffixes that don't differentiate companies
    .replace(/\/(home|index|main|default|about|about-us|contact|products?|services?|en|th|id|vn|my|sg|ph|company)(\/.*)?$/i, '')
    .replace(/\.(html?|php|aspx?|jsp)$/i, ''); // Remove file extensions
}

// Extract domain root for additional deduplication
function extractDomainRoot(url) {
  const normalized = normalizeWebsite(url);
  // Get just the domain without any path
  return normalized.split('/')[0];
}

function dedupeCompanies(allCompanies) {
  const seenWebsites = new Map();
  const seenDomains = new Map();
  const seenNames = new Map();
  const results = [];

  for (const c of allCompanies) {
    if (!c || !c.website || !c.company_name) continue;
    if (!c.website.startsWith('http')) continue;

    const websiteKey = normalizeWebsite(c.website);
    const domainKey = extractDomainRoot(c.website);
    const nameKey = normalizeCompanyName(c.company_name);

    // Skip if we've seen this exact URL, domain, or normalized name
    if (seenWebsites.has(websiteKey)) continue;
    if (seenDomains.has(domainKey)) continue;
    if (nameKey && seenNames.has(nameKey)) continue;

    seenWebsites.set(websiteKey, true);
    seenDomains.set(domainKey, true);
    if (nameKey) seenNames.set(nameKey, true);
    results.push(c);
  }

  return results;
}

// ============ PRE-FILTER: Remove only obvious non-company URLs ============

function isSpamOrDirectoryURL(url) {
  if (!url) return true;
  const urlLower = url.toLowerCase();

  // Only filter out obvious non-company URLs (very conservative)
  const obviousSpam = [
    'wikipedia.org',
    'facebook.com',
    'twitter.com',
    'instagram.com',
    'youtube.com'
  ];

  for (const pattern of obviousSpam) {
    if (urlLower.includes(pattern)) return true;
  }

  return false;
}

function preFilterCompanies(companies) {
  return companies.filter(c => {
    if (!c || !c.website) return false;
    if (isSpamOrDirectoryURL(c.website)) {
      console.log(`    Pre-filtered: ${c.company_name} - Social media/wiki`);
      return false;
    }
    return true;
  });
}

// ============ EXHAUSTIVE PARALLEL SEARCH WITH 14 STRATEGIES ============

// Process SerpAPI results and extract companies using GPT
async function processSerpResults(serpResults, business, country, exclusion) {
  if (!serpResults || serpResults.length === 0) return [];

  const outputFormat = buildOutputFormat();
  const prompt = `From these Google search results, extract companies that match:
- Business: ${business}
- Country: ${country}
- Exclude: ${exclusion}

Search Results:
${serpResults.join('\n\n')}

${outputFormat}`;

  const response = await callChatGPT(prompt);
  return extractCompanies(response, country);
}

async function exhaustiveSearch(business, country, exclusion) {
  console.log('Starting EXHAUSTIVE 14-STRATEGY PARALLEL search...');
  const startTime = Date.now();

  // Generate all queries for each strategy
  const serpQueries1 = strategy1_BroadSerpAPI(business, country, exclusion);
  const perpQueries2 = strategy2_BroadPerplexity(business, country, exclusion);
  const serpQueries3 = strategy3_ListsSerpAPI(business, country, exclusion);
  const perpQueries4 = strategy4_CitiesPerplexity(business, country, exclusion);
  const serpQueries5 = strategy5_IndustrialSerpAPI(business, country, exclusion);
  const perpQueries6 = strategy6_DirectoriesPerplexity(business, country, exclusion);
  const perpQueries7 = strategy7_ExhibitionsPerplexity(business, country, exclusion);
  const perpQueries8 = strategy8_TradePerplexity(business, country, exclusion);
  const perpQueries9 = strategy9_DomainsPerplexity(business, country, exclusion);
  const serpQueries10 = strategy10_RegistriesSerpAPI(business, country, exclusion);
  const serpQueries11 = strategy11_CityIndustrialSerpAPI(business, country, exclusion);
  const openaiQueries12 = strategy12_DeepOpenAISearch(business, country, exclusion);
  const perpQueries13 = strategy13_PublicationsPerplexity(business, country, exclusion);
  const openaiQueries14 = strategy14_LocalLanguageOpenAISearch(business, country, exclusion);

  const allSerpQueries = [...serpQueries1, ...serpQueries3, ...serpQueries5, ...serpQueries10, ...serpQueries11];
  const allPerpQueries = [...perpQueries2, ...perpQueries4, ...perpQueries6, ...perpQueries7, ...perpQueries8, ...perpQueries9, ...perpQueries13];
  const allOpenAISearchQueries = [...openaiQueries12, ...openaiQueries14];

  console.log(`  Strategy breakdown:`);
  console.log(`    SerpAPI (Google): ${allSerpQueries.length} queries`);
  console.log(`    Perplexity: ${allPerpQueries.length} queries`);
  console.log(`    OpenAI Search: ${allOpenAISearchQueries.length} queries`);
  console.log(`    Total: ${allSerpQueries.length + allPerpQueries.length + allOpenAISearchQueries.length}`);

  // Run all strategies in parallel
  const [serpResults, perpResults, openaiSearchResults, geminiResults] = await Promise.all([
    // SerpAPI queries
    process.env.SERPAPI_API_KEY
      ? Promise.all(allSerpQueries.map(q => callSerpAPI(q)))
      : Promise.resolve([]),

    // Perplexity queries
    Promise.all(allPerpQueries.map(q => callPerplexity(q))),

    // OpenAI Search queries
    Promise.all(allOpenAISearchQueries.map(q => callOpenAISearch(q))),

    // Also run some Gemini queries for diversity
    Promise.all([
      callGemini(`Find ALL ${business} companies in ${country}. Exclude ${exclusion}. ${buildOutputFormat()}`),
      callGemini(`List ${business} factories and manufacturing plants in ${country}. Not ${exclusion}. ${buildOutputFormat()}`),
      callGemini(`${business} SME and family businesses in ${country}. Exclude ${exclusion}. ${buildOutputFormat()}`)
    ])
  ]);

  console.log(`  All API calls done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Process SerpAPI results through GPT for extraction
  let serpCompanies = [];
  if (serpResults.length > 0) {
    console.log(`  Processing ${serpResults.filter(r => r).length} SerpAPI results...`);
    serpCompanies = await processSerpResults(serpResults.filter(r => r), business, country, exclusion);
    console.log(`    Extracted ${serpCompanies.length} companies from SerpAPI`);
  }

  // Extract from Perplexity results
  console.log(`  Extracting from ${perpResults.length} Perplexity results...`);
  const perpExtractions = await Promise.all(
    perpResults.map(text => extractCompanies(text, country))
  );
  const perpCompanies = perpExtractions.flat();
  console.log(`    Extracted ${perpCompanies.length} companies from Perplexity`);

  // Extract from OpenAI Search results
  console.log(`  Extracting from ${openaiSearchResults.length} OpenAI Search results...`);
  const openaiExtractions = await Promise.all(
    openaiSearchResults.map(text => extractCompanies(text, country))
  );
  const openaiCompanies = openaiExtractions.flat();
  console.log(`    Extracted ${openaiCompanies.length} companies from OpenAI Search`);

  // Extract from Gemini results
  console.log(`  Extracting from ${geminiResults.length} Gemini results...`);
  const geminiExtractions = await Promise.all(
    geminiResults.map(text => extractCompanies(text, country))
  );
  const geminiCompanies = geminiExtractions.flat();
  console.log(`    Extracted ${geminiCompanies.length} companies from Gemini`);

  // Combine and dedupe all
  const allCompanies = [...serpCompanies, ...perpCompanies, ...openaiCompanies, ...geminiCompanies];
  const uniqueCompanies = dedupeCompanies(allCompanies);

  console.log(`  Raw total: ${allCompanies.length}, Unique: ${uniqueCompanies.length}`);
  console.log(`Search completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return uniqueCompanies;
}

// ============ WEBSITE VERIFICATION ============

async function verifyWebsite(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);

    if (!response.ok) return { valid: false, reason: `HTTP ${response.status}` };

    const html = await response.text();
    const lowerHtml = html.toLowerCase();

    // Check for parked domain / placeholder signs
    const parkedSigns = [
      'domain is for sale',
      'buy this domain',
      'this domain is parked',
      'parked by',
      'domain parking',
      'this page is under construction',
      'coming soon',
      'website coming soon',
      'under maintenance',
      'godaddy',
      'namecheap parking',
      'sedoparking',
      'hugedomains',
      'afternic',
      'domain expired',
      'this site can\'t be reached',
      'page not found',
      '404 not found',
      'website not found'
    ];

    for (const sign of parkedSigns) {
      if (lowerHtml.includes(sign)) {
        return { valid: false, reason: `Parked/placeholder: "${sign}"` };
      }
    }

    // Check for minimal content (likely placeholder)
    const textContent = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (textContent.length < 200) {
      return { valid: false, reason: 'Too little content (likely placeholder)' };
    }

    return { valid: true, content: textContent.substring(0, 15000) };
  } catch (e) {
    return { valid: false, reason: e.message || 'Connection failed' };
  }
}

async function filterVerifiedWebsites(companies) {
  console.log(`\nVerifying ${companies.length} websites...`);
  const startTime = Date.now();
  const batchSize = 15; // Increased for better parallelization
  const verified = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(c => verifyWebsite(c.website)));

    batch.forEach((company, idx) => {
      if (results[idx].valid) {
        verified.push({
          ...company,
          _pageContent: results[idx].content // Cache the content for validation
        });
      } else {
        console.log(`    Removed: ${company.company_name} - ${results[idx].reason}`);
      }
    });

    console.log(`  Verified ${Math.min(i + batchSize, companies.length)}/${companies.length}. Working: ${verified.length}`);
  }

  console.log(`Website verification done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Working: ${verified.length}/${companies.length}`);
  return verified;
}

// ============ FETCH WEBSITE FOR VALIDATION ============

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

// ============ DYNAMIC EXCLUSION RULES BUILDER (n8n-style PAGE SIGNAL detection) ============

function buildExclusionRules(exclusion, business) {
  const exclusionLower = exclusion.toLowerCase();
  let rules = '';

  // Detect if user wants to exclude LARGE companies - use PAGE SIGNALS like n8n
  if (exclusionLower.includes('large') || exclusionLower.includes('big') ||
      exclusionLower.includes('mnc') || exclusionLower.includes('multinational') ||
      exclusionLower.includes('major') || exclusionLower.includes('giant')) {
    rules += `
LARGE COMPANY DETECTION - Look for these PAGE SIGNALS to REJECT:
- "global presence", "worldwide operations", "global leader", "world's largest"
- Stock ticker symbols or mentions of: NYSE, NASDAQ, SGX, SET, IDX, listed, IPO
- "multinational", "global network", offices/operations in 10+ countries
- Revenue figures >$100M, employee count >1000
- "Fortune 500", "Forbes Global"
- Company name contains known MNC: Toyo Ink, Sakata, Flint, Siegwerk, Sun Chemical, DIC
- Website says "subsidiary of", "part of [X] Group", "member of [X] Group"
- Company name ends with "Tbk" (Indonesian listed)

If NONE of these signals are found → ACCEPT (assume local company)
`;
  }

  // Detect if user wants to exclude LISTED/PUBLIC companies
  if (exclusionLower.includes('listed') || exclusionLower.includes('public')) {
    rules += `
LISTED COMPANY DETECTION - REJECT if page shows:
- Stock ticker, NYSE, NASDAQ, SGX, SET, IDX, or any stock exchange
- "publicly traded", "listed company", "IPO"
- Company name contains "Tbk"
`;
  }

  // Detect if user wants to exclude DISTRIBUTORS
  if (exclusionLower.includes('distributor')) {
    rules += `
DISTRIBUTOR DETECTION - REJECT only if:
- Company ONLY distributes/resells with NO manufacturing
- No mention of factory, plant, production facility, "we manufacture"

ACCEPT if they manufacture (even if also distribute) - most manufacturers also sell their products
`;
  }

  return rules;
}

// ============ VALIDATION (v23 - n8n-style PAGE SIGNAL detection) ============

async function validateCompanyStrict(company, business, country, exclusion, pageText) {
  // If we couldn't fetch the website, validate by name only (give benefit of doubt)
  const contentToValidate = pageText || `Company name: ${company.company_name}. Validate based on name only.`;

  const exclusionRules = buildExclusionRules(exclusion, business);

  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o',  // Use smarter model for better validation
      messages: [
        {
          role: 'system',
          content: `You are a company validator for M&A research. Be LENIENT - when in doubt, ACCEPT.

VALIDATION TASK:
- Business sought: "${business}"
- Target countries: ${country}
- Exclusions: ${exclusion}

VALIDATION RULES:

1. LOCATION CHECK:
- Is HQ in one of the target countries (${country})?
- IMPORTANT: If country is a REGION like "Southeast Asia", accept companies in ANY Southeast Asian country (Malaysia, Thailand, Vietnam, Indonesia, Philippines, Singapore, etc.)
- If HQ is clearly outside the target region → REJECT

2. BUSINESS MATCH (BE LENIENT):
- Does the company's business relate to "${business}"?
- Accept related products, services, manufacturers, suppliers
- Only reject if COMPLETELY unrelated

3. EXCLUSION CHECK:
${exclusionRules}
- For "large companies" exclusion: REJECT both large multinationals AND their subsidiaries
- Example: "DIC Indonesia", "Toyo Ink Philippines", "Sun Chemical" → REJECT (subsidiaries of large corporations)
- Only accept truly independent SMEs and local companies

4. SPAM CHECK:
- Only reject obvious directories, marketplaces, domain-for-sale sites

OUTPUT: Return JSON only: {"valid": true/false, "reason": "one sentence"}`
        },
        {
          role: 'user',
          content: `COMPANY: ${company.company_name}
WEBSITE: ${company.website}
HQ: ${company.hq}

PAGE CONTENT:
${contentToValidate.substring(0, 10000)}`
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
    // On error, accept (benefit of doubt)
    console.log(`    Error validating ${company.company_name}, accepting`);
    return { valid: true, corrected_hq: company.hq };
  }
}

async function parallelValidationStrict(companies, business, country, exclusion) {
  console.log(`\nSTRICT Validating ${companies.length} verified companies...`);
  const startTime = Date.now();
  const batchSize = 10; // Increased for better parallelization
  const validated = [];

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);
    // Use cached _pageContent from verification step, or fetch if not available
    const pageTexts = await Promise.all(
      batch.map(c => c._pageContent ? Promise.resolve(c._pageContent) : fetchWebsite(c.website))
    );
    const validations = await Promise.all(
      batch.map((company, idx) => validateCompanyStrict(company, business, country, exclusion, pageTexts[idx]))
    );

    batch.forEach((company, idx) => {
      if (validations[idx].valid) {
        // Remove internal _pageContent before adding to results
        const { _pageContent, ...cleanCompany } = company;
        validated.push({
          ...cleanCompany,
          hq: validations[idx].corrected_hq || company.hq
        });
      }
    });

    console.log(`  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`);
  }

  console.log(`STRICT Validation done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Valid: ${validated.length}`);
  return validated;
}

// ============ VALIDATION FOR SLOW MODE (v23 - n8n style) ============

async function validateCompany(company, business, country, exclusion, pageText) {
  const exclusionRules = buildExclusionRules(exclusion, business);

  try {
    const validation = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a company validator. Be LENIENT on business match. Be STRICT on exclusions by detecting signals in page content.

VALIDATION TASK:
- Business sought: "${business}"
- Target countries: ${country}
- Exclusions: ${exclusion}

VALIDATION RULES:

1. LOCATION CHECK:
- Is HQ actually in one of the target countries (${country})?
- If HQ is outside these countries → REJECT

2. BUSINESS MATCH (BE LENIENT):
- Does the company's business relate to "${business}"?
- Accept related products, services, or sub-categories
- Only reject if completely unrelated

3. EXCLUSION CHECK - DETECT VIA PAGE SIGNALS:
${exclusionRules}

4. SPAM CHECK:
- Is this a directory, marketplace, domain-for-sale, or aggregator site? → REJECT

OUTPUT: Return JSON: {"valid": true/false, "reason": "brief", "corrected_hq": "City, Country or null"}`
        },
        {
          role: 'user',
          content: `COMPANY: ${company.company_name}
WEBSITE: ${company.website}
HQ: ${company.hq}

PAGE CONTENT:
${pageText ? pageText.substring(0, 8000) : 'Could not fetch - validate by name only'}`
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
    // On error, accept (benefit of doubt)
    console.log(`    Error validating ${company.company_name}, accepting`);
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

    // Pre-filter obvious spam/directories before expensive verification
    const preFiltered = preFilterCompanies(companies);
    console.log(`After pre-filter: ${preFiltered.length} companies`);

    // Filter out fake/dead websites before expensive validation
    const verifiedCompanies = await filterVerifiedWebsites(preFiltered);
    console.log(`\nCompanies with working websites: ${verifiedCompanies.length}`);

    const validCompanies = await parallelValidationStrict(verifiedCompanies, Business, Country, Exclusion);

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

    // Pre-filter obvious spam/directories
    const preFiltered = preFilterCompanies(uniqueCompanies);
    console.log(`After pre-filter: ${preFiltered.length} companies`);

    const validCompanies = await parallelValidation(preFiltered, Business, Country, Exclusion);

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

// ============ V4 ULTRA-EXHAUSTIVE ENDPOINT ============

// Ask AI to expand a region into individual countries (no hardcoding)
async function expandRegionToCountries(region) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You help identify countries in geographic regions. Return a JSON array of country names only.`
        },
        {
          role: 'user',
          content: `If "${region}" is a geographic region (like "Southeast Asia", "Europe", "Middle East"), list all the countries in it.
If "${region}" is already a single country, just return that country.
Return ONLY a JSON array of country names, nothing else.
Example: ["Malaysia", "Thailand", "Indonesia"]`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    const countries = result.countries || result;

    if (Array.isArray(countries) && countries.length > 0) {
      console.log(`  Region "${region}" expanded to: ${countries.join(', ')}`);
      return countries;
    }
    return [region]; // Return original if not a region
  } catch (e) {
    console.log(`  Could not expand region, using as-is: ${region}`);
    return [region];
  }
}

// Simple Levenshtein similarity for fuzzy matching
function levenshteinSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  if (longer.length === 0) return 1.0;

  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return (longer.length - costs[s2.length]) / longer.length;
}

// Get cities for a country (dynamic)
function getCitiesForCountry(country) {
  const countryLower = country.toLowerCase();
  for (const [key, cities] of Object.entries(CITY_MAP)) {
    if (countryLower.includes(key)) return cities;
  }
  // Default: ask AI to determine cities
  return null;
}

// Get company suffixes for a country (dynamic)
function getSuffixesForCountry(country) {
  const countryLower = country.toLowerCase();
  for (const [key, suffixes] of Object.entries(LOCAL_SUFFIXES)) {
    if (countryLower.includes(key)) return suffixes;
  }
  return ['Ltd', 'Co', 'Inc', 'Corp'];
}

// Get domain for a country (dynamic)
function getDomainForCountry(country) {
  const countryLower = country.toLowerCase();
  for (const [key, domain] of Object.entries(DOMAIN_MAP)) {
    if (countryLower.includes(key)) return domain;
  }
  return null;
}

// Generate dynamic expansion prompts based on round number
function generateExpansionPrompt(round, business, country, existingList, shortlistSample) {
  const baseInstruction = `You are a thorough M&A researcher finding ALL ${business} companies in ${country}.
Return results as: Company Name | Website (must start with http)
Find at least 20 NEW companies not in our existing list.
DO NOT include companies from this list: ${existingList}`;

  const cities = getCitiesForCountry(country);
  const suffixes = getSuffixesForCountry(country);
  const domain = getDomainForCountry(country);
  const localLang = LOCAL_LANGUAGE_MAP[country.toLowerCase()];

  const prompts = {
    1: `${baseInstruction}

ROUND 1 - RELATED TERMINOLOGY SEARCH:
The user searched for "${business}" but companies may use different terms.
Think about what OTHER words or phrases companies in this industry might use to describe themselves.
Consider:
- Alternative industry terminology
- Different product descriptions
- Related processes or services
- Synonyms and variations
Search using ALL these related terms to find companies we might otherwise miss.`,

    2: `${baseInstruction}

ROUND 2 - DOMESTIC & LOCAL COMPANIES:
Focus ONLY on locally-owned, independent companies in ${country}.
Ignore subsidiaries of multinational corporations.
Look for:
- Family-owned businesses
- Local SMEs
- Domestic manufacturers
- Companies founded locally (not foreign subsidiaries)
These are often harder to find but are the real targets.`,

    3: `${baseInstruction}

ROUND 3 - CITY-BY-CITY DEEP DIVE:
Search for ${business} companies in each of these cities/regions:
${cities ? cities.join(', ') : `Major cities and industrial areas in ${country}`}
Include companies in industrial estates, free trade zones, and business parks.`,

    4: `${baseInstruction}

ROUND 4 - TRADE ASSOCIATIONS & MEMBER DIRECTORIES:
Find ${business} companies that are members of:
- Industry associations relevant to ${business}
- Trade organizations
- Chamber of commerce
- Business federations
in ${country}. Look for member directories and lists.`,

    5: localLang ? `${baseInstruction}

ROUND 5 - LOCAL LANGUAGE SEARCH:
Search for ${business} companies using ${localLang.lang} terms.
Search queries should include local business terminology.
Focus on companies that may only have local language websites.
Look for: ${localLang.examples.join(', ')} related businesses.` : `${baseInstruction}

ROUND 5 - ALTERNATIVE NAMING:
Search for ${business} companies using:
- Local language business names
- Alternative industry terminology
- Regional naming conventions
in ${country}.`,

    6: `${baseInstruction}

ROUND 6 - SUPPLY CHAIN SEARCH:
For companies like: ${shortlistSample}
Find their:
- Suppliers (who supplies to them)
- Customers (who buys from them)
- Raw material suppliers
that are also ${business} companies in ${country}.`,

    7: `${baseInstruction}

ROUND 7 - INDUSTRY PUBLICATIONS & ARTICLES:
Search for ${business} companies mentioned in:
- Industry magazines and trade publications for ${business}
- News articles about the ${business} industry in ${country}
- Trade publication interviews
- Company profiles in business journals`,

    8: `${baseInstruction}

ROUND 8 - TRADE SHOWS & EXHIBITIONS:
Find ${business} companies that exhibited at:
- Industry trade shows relevant to ${business} (past 3 years)
- B2B exhibitions
- Industry-specific fairs
in ${country} or international shows with ${country} exhibitors.`,

    9: `${baseInstruction}

ROUND 9 - WHAT AM I MISSING?
I already found these companies: ${shortlistSample}
Think step by step: What ${business} companies in ${country} might I have MISSED?
- Companies with unusual names
- Companies that don't advertise much
- Companies in smaller cities
- Companies that use different terminology
- Older established companies
- Newer startups
Find companies that wouldn't appear in a typical Google search.`,

    10: `${baseInstruction}

ROUND 10 - FINAL DISCOVERY:
This is the last round. Search EXHAUSTIVELY for any ${business} company in ${country} not yet found.
- Search in local business directories
- Look for companies in industrial zones
- Check import/export records
- Find any company we might have missed
The goal is to find EVERY company, no matter how small or obscure.
${domain ? `Also search for companies with ${domain} domains.` : ''}`
  };

  return prompts[round] || prompts[1];
}

// Run a single expansion round with all 3 search-enabled models
async function runExpansionRound(round, business, country, existingCompanies) {
  console.log(`\n--- Expansion Round ${round}/10 ---`);

  const existingNames = existingCompanies
    .filter(c => c && c.company_name)
    .map(c => c.company_name.toLowerCase());

  const existingList = existingCompanies
    .filter(c => c && c.company_name)
    .slice(0, 30)
    .map(c => c.company_name)
    .join(', ');

  const shortlistSample = existingCompanies
    .filter(c => c && c.company_name)
    .slice(0, 10)
    .map(c => c.company_name)
    .join(', ');

  const prompt = generateExpansionPrompt(round, business, country, existingList, shortlistSample);

  // Run all 3 search-enabled models in parallel
  console.log(`  Querying GPT-4o-mini Search, Gemini 2.0 Flash, Perplexity Sonar...`);
  const [gptResult, geminiResult, perplexityResult] = await Promise.all([
    callOpenAISearch(prompt),
    callGemini(prompt),
    callPerplexity(prompt)
  ]);

  // Extract companies from each result
  const [gptCompanies, geminiCompanies, perplexityCompanies] = await Promise.all([
    extractCompanies(gptResult, country),
    extractCompanies(geminiResult, country),
    extractCompanies(perplexityResult, country)
  ]);

  console.log(`  GPT-4o-mini: ${gptCompanies.length} | Gemini: ${geminiCompanies.length} | Perplexity: ${perplexityCompanies.length}`);

  // Combine and filter out duplicates
  const allNewCompanies = [...gptCompanies, ...geminiCompanies, ...perplexityCompanies];
  const trulyNew = allNewCompanies.filter(c => {
    if (!c || !c.company_name) return false;
    const nameLower = c.company_name.toLowerCase();
    return !existingNames.some(existing =>
      existing.includes(nameLower) || nameLower.includes(existing) ||
      levenshteinSimilarity(existing, nameLower) > 0.8
    );
  });

  const uniqueNew = dedupeCompanies(trulyNew);
  console.log(`  New unique companies: ${uniqueNew.length}`);

  return uniqueNew;
}

app.post('/api/find-target-v4', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`V4 EXHAUSTIVE SEARCH: ${new Date().toISOString()}`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(70));

  res.json({
    success: true,
    message: 'Request received. Exhaustive search running. Results will be emailed in ~30-45 minutes.'
  });

  try {
    const totalStart = Date.now();

    // ========== PHASE 0: Expand Region to Countries ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 0: REGION EXPANSION');
    console.log('='.repeat(50));

    const countries = await expandRegionToCountries(Country);
    console.log(`Will search ${countries.length} countries: ${countries.join(', ')}`);

    // ========== PHASE 1: Country-by-Country Direct Search ==========
    console.log('\n' + '='.repeat(50));
    console.log(`PHASE 1: COUNTRY-BY-COUNTRY SEARCH (${countries.length} countries)`);
    console.log('='.repeat(50));

    let allPhase1Companies = [];

    // For each country, do a direct AI search (like asking ChatGPT)
    for (const targetCountry of countries) {
      console.log(`\n--- Searching: ${targetCountry} ---`);

      // Direct prompt - like you'd ask in ChatGPT chat
      const directPrompt = `List ALL ${Business} companies in ${targetCountry}.
Include:
- Large and small companies
- Local/domestic companies
- Lesser-known companies
- Companies that may use different terminology
Exclude: ${Exclusion}
Return as: Company Name | Website (must start with http)
Find as many as possible - be exhaustive.`;

      // Ask all 3 AI models the same direct question
      const [gptResult, geminiResult, perplexityResult] = await Promise.all([
        callOpenAISearch(directPrompt),
        callGemini(directPrompt),
        callPerplexity(directPrompt)
      ]);

      // Extract companies
      const [gptCompanies, geminiCompanies, perplexityCompanies] = await Promise.all([
        extractCompanies(gptResult, targetCountry),
        extractCompanies(geminiResult, targetCountry),
        extractCompanies(perplexityResult, targetCountry)
      ]);

      console.log(`  GPT: ${gptCompanies.length} | Gemini: ${geminiCompanies.length} | Perplexity: ${perplexityCompanies.length}`);
      allPhase1Companies = [...allPhase1Companies, ...gptCompanies, ...geminiCompanies, ...perplexityCompanies];
    }

    // Also run the original exhaustiveSearch for the full region (catches different results)
    console.log(`\n--- Full Region Search: ${Country} ---`);
    const regionCompanies = await exhaustiveSearch(Business, Country, Exclusion);
    console.log(`Region search: ${regionCompanies.length} companies`);
    allPhase1Companies = [...allPhase1Companies, ...regionCompanies];

    const phase1Raw = dedupeCompanies(allPhase1Companies);
    console.log(`\nPhase 1 total: ${phase1Raw.length} unique companies`);

    // ========== PHASE 1.5: Initial Validation ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 1.5: INITIAL VALIDATION → SHORTLIST');
    console.log('='.repeat(50));

    const preFiltered1 = preFilterCompanies(phase1Raw);
    console.log(`After pre-filter: ${preFiltered1.length}`);

    const shortlistA = await parallelValidationStrict(preFiltered1, Business, Country, Exclusion);
    console.log(`Shortlist A (validated): ${shortlistA.length} companies`);

    // ========== PHASE 2: EXPANSION ROUNDS ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 2: 10 EXPANSION ROUNDS (3 AI models × 10 strategies)');
    console.log('='.repeat(50));

    let allCompanies = [...shortlistA];
    let totalNewFound = 0;

    for (let round = 1; round <= 10; round++) {
      const roundStart = Date.now();

      // Cycle through countries for each round
      const targetCountry = countries[round % countries.length];
      const newCompanies = await runExpansionRound(round, Business, targetCountry, allCompanies);

      if (newCompanies.length > 0) {
        allCompanies = dedupeCompanies([...allCompanies, ...newCompanies]);
        totalNewFound += newCompanies.length;
      }

      const roundTime = ((Date.now() - roundStart) / 1000).toFixed(1);
      console.log(`  Round ${round}/10 [${targetCountry}]: +${newCompanies.length} new (${roundTime}s). Total: ${allCompanies.length}`);
    }

    console.log(`\nPhase 2 complete. Found ${totalNewFound} additional companies.`);

    // ========== PHASE 3: Final Validation ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 3: FINAL VALIDATION');
    console.log('='.repeat(50));

    console.log(`Total candidates: ${allCompanies.length}`);

    const phase2New = allCompanies.filter(c =>
      !shortlistA.some(s => s.company_name === c.company_name)
    );
    console.log(`New from Phase 2 (need validation): ${phase2New.length}`);

    const preFiltered2 = preFilterCompanies(phase2New);
    const validated2 = await parallelValidationStrict(preFiltered2, Business, Country, Exclusion);
    console.log(`Phase 2 validated: ${validated2.length}`);

    const finalCompanies = dedupeCompanies([...shortlistA, ...validated2]);
    console.log(`FINAL TOTAL: ${finalCompanies.length} validated companies`);

    // ========== Send Results ==========
    const htmlContent = buildEmailHTML(finalCompanies, Business, Country, Exclusion);
    await sendEmail(
      Email,
      `[V4 EXHAUSTIVE] ${Business} in ${Country} (${finalCompanies.length} companies)`,
      htmlContent
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log('\n' + '='.repeat(70));
    console.log(`V4 EXHAUSTIVE COMPLETE!`);
    console.log(`Email sent to: ${Email}`);
    console.log(`Final companies: ${finalCompanies.length}`);
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(70));

  } catch (error) {
    console.error('V4 Processing error:', error);
    try {
      await sendEmail(Email, `Find Target V4 - Error`, `<p>Error: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

// ============ VALIDATION ENDPOINT ============

// Parse company names from text (one per line)
function parseCompanyList(text) {
  if (!text) return [];
  return text
    .split(/[\n\r]+/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && line.length < 200);
}

// Parse countries from text
function parseCountries(text) {
  if (!text) return [];
  return text
    .split(/[\n\r]+/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

// Check if URL is a valid company website (not social media, maps, directories)
function isValidCompanyWebsite(url) {
  if (!url) return false;
  const urlLower = url.toLowerCase();

  const invalidPatterns = [
    'google.com/maps',
    'google.com/search',
    'maps.google',
    'facebook.com',
    'linkedin.com',
    'twitter.com',
    'instagram.com',
    'youtube.com',
    'wikipedia.org',
    'bloomberg.com',
    'reuters.com',
    'alibaba.com',
    'made-in-china.com',
    'globalsources.com',
    'indiamart.com',
    'yellowpages',
    'yelp.com',
    'trustpilot.com',
    'glassdoor.com',
    'crunchbase.com',
    'zoominfo.com',
    'dnb.com',
    'opencorporates.com'
  ];

  for (const pattern of invalidPatterns) {
    if (urlLower.includes(pattern)) return false;
  }

  if (!url.startsWith('http')) return false;

  return true;
}

// Extract clean URL from text
function extractCleanURL(text) {
  if (!text) return null;

  const urlMatches = text.match(/https?:\/\/[^\s"'<>\])+,]+/gi);
  if (!urlMatches) return null;

  for (const url of urlMatches) {
    const cleanUrl = url.replace(/[.,;:!?)]+$/, '');
    if (isValidCompanyWebsite(cleanUrl)) {
      return cleanUrl;
    }
  }

  return null;
}

// Method 1: Use SerpAPI (Google Search) - Most reliable
async function findWebsiteViaSerpAPI(companyName, countries) {
  if (!process.env.SERPAPI_API_KEY) return null;

  const countryStr = countries.slice(0, 2).join(' ');
  const query = `"${companyName}" ${countryStr} official website`;

  try {
    const params = new URLSearchParams({
      q: query,
      api_key: process.env.SERPAPI_API_KEY,
      engine: 'google',
      num: 10
    });

    const response = await fetch(`https://serpapi.com/search?${params}`, { timeout: 15000 });
    const data = await response.json();

    if (data.organic_results) {
      for (const result of data.organic_results) {
        if (result.link && isValidCompanyWebsite(result.link)) {
          const titleLower = (result.title || '').toLowerCase();
          const snippetLower = (result.snippet || '').toLowerCase();
          const companyLower = companyName.toLowerCase();
          const companyWords = companyLower.split(/\s+/).filter(w => w.length > 2);

          const matchCount = companyWords.filter(w =>
            titleLower.includes(w) || snippetLower.includes(w)
          ).length;

          if (matchCount >= Math.min(2, companyWords.length)) {
            return result.link;
          }
        }
      }

      for (const result of data.organic_results) {
        if (result.link && isValidCompanyWebsite(result.link)) {
          return result.link;
        }
      }
    }

    return null;
  } catch (e) {
    console.error(`SerpAPI error for ${companyName}:`, e.message);
    return null;
  }
}

// Method 2: Use Perplexity
async function findWebsiteViaPerplexity(companyName, countries) {
  const countryStr = countries.join(', ');

  try {
    const result = await callPerplexity(
      `What is the official company website URL for "${companyName}" located in ${countryStr}?
       Return ONLY the direct website URL (like https://www.company.com).
       Do NOT return Google Maps, LinkedIn, Facebook, or any directory links.
       If you cannot find the official website, respond with "NOT_FOUND".`
    );

    return extractCleanURL(result);
  } catch (e) {
    console.error(`Perplexity error for ${companyName}:`, e.message);
    return null;
  }
}

// Method 3: Use OpenAI Search
async function findWebsiteViaOpenAISearch(companyName, countries) {
  const countryStr = countries.join(', ');

  try {
    const result = await callOpenAISearch(
      `Find the official company website for "${companyName}" in ${countryStr}.
       Return ONLY the direct URL to their official website (e.g., https://www.companyname.com).
       Do NOT return Google Maps links, LinkedIn, Facebook, or directory websites.
       If the official website cannot be found, say "NOT_FOUND".`
    );

    return extractCleanURL(result);
  } catch (e) {
    console.error(`OpenAI Search error for ${companyName}:`, e.message);
    return null;
  }
}

// Method 4: Use Gemini
async function findWebsiteViaGemini(companyName, countries) {
  const countryStr = countries.join(', ');

  try {
    const result = await callGemini(
      `What is the official website URL for the company "${companyName}" based in ${countryStr}?
       Return only the URL starting with https:// or http://
       Do not return Google Maps, social media, or directory links.
       If unknown, respond with NOT_FOUND.`
    );

    return extractCleanURL(result);
  } catch (e) {
    console.error(`Gemini error for ${companyName}:`, e.message);
    return null;
  }
}

// Combined website finder - tries multiple methods for accuracy
async function findCompanyWebsiteMulti(companyName, countries) {
  console.log(`  Finding website for: ${companyName}`);

  const [serpResult, perpResult, openaiResult, geminiResult] = await Promise.all([
    findWebsiteViaSerpAPI(companyName, countries),
    findWebsiteViaPerplexity(companyName, countries),
    findWebsiteViaOpenAISearch(companyName, countries),
    findWebsiteViaGemini(companyName, countries)
  ]);

  console.log(`    SerpAPI: ${serpResult || 'not found'}`);
  console.log(`    Perplexity: ${perpResult || 'not found'}`);
  console.log(`    OpenAI Search: ${openaiResult || 'not found'}`);
  console.log(`    Gemini: ${geminiResult || 'not found'}`);

  const candidates = [serpResult, perpResult, openaiResult, geminiResult].filter(url => url);

  if (candidates.length === 0) {
    console.log(`    No website found for ${companyName}`);
    return null;
  }

  const domainCounts = {};
  for (const url of candidates) {
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    } catch (e) {}
  }

  let bestDomain = null;
  let bestCount = 0;
  for (const [domain, count] of Object.entries(domainCounts)) {
    if (count > bestCount) {
      bestCount = count;
      bestDomain = domain;
    }
  }

  if (bestDomain) {
    for (const url of candidates) {
      try {
        const domain = new URL(url).hostname.replace(/^www\./, '');
        if (domain === bestDomain) {
          console.log(`    Selected: ${url} (${bestCount} sources agree)`);
          return url;
        }
      } catch (e) {}
    }
  }

  const finalResult = serpResult || perpResult || openaiResult || geminiResult;
  console.log(`    Selected: ${finalResult}`);
  return finalResult;
}

// Validate if company matches target business - STRICTLY based on website content
async function validateCompanyBusinessStrict(company, targetBusiness, pageText) {
  if (!pageText || pageText.length < 100) {
    return {
      in_scope: false,
      reason: 'Could not fetch sufficient website content',
      business_description: 'Unable to determine - website inaccessible or insufficient content'
    };
  }

  const systemPrompt = (model) => `You are a company validator. Determine if the company matches the target business criteria STRICTLY based on the website content provided.

TARGET BUSINESS: "${targetBusiness}"

RULES:
1. Your determination must be based ONLY on what the website content says
2. If the website clearly shows the company is in the target business → IN SCOPE
3. If the website shows a different business → OUT OF SCOPE
4. If the website content is unclear or doesn't describe business activities → OUT OF SCOPE
5. Be accurate - do not guess or assume

OUTPUT: Return JSON: {"in_scope": true/false, "confidence": "high/medium/low", "reason": "brief explanation based on website content", "business_description": "what this company actually does based on website"}`;

  const userPrompt = `COMPANY: ${company.company_name}
WEBSITE: ${company.website}

WEBSITE CONTENT:
${pageText.substring(0, 10000)}`;

  try {
    // First pass: gpt-4o-mini (fast and cheap)
    const firstPass = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt('gpt-4o-mini') },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(firstPass.choices[0].message.content);

    // Check if we need a second pass with gpt-4o
    const needsSecondPass =
      result.confidence === 'low' ||
      result.confidence === 'medium' ||
      result.reason?.toLowerCase().includes('unclear') ||
      result.reason?.toLowerCase().includes('insufficient') ||
      result.reason?.toLowerCase().includes('cannot determine') ||
      result.reason?.toLowerCase().includes('not clear');

    if (needsSecondPass) {
      console.log(`  → Re-validating ${company.company_name} with gpt-4o (confidence: ${result.confidence})`);

      // Second pass: gpt-4o (more accurate)
      const secondPass = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt('gpt-4o') },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' }
      });

      const finalResult = JSON.parse(secondPass.choices[0].message.content);
      return {
        in_scope: finalResult.in_scope,
        reason: finalResult.reason,
        business_description: finalResult.business_description
      };
    }

    return {
      in_scope: result.in_scope,
      reason: result.reason,
      business_description: result.business_description
    };
  } catch (e) {
    console.error(`Error validating ${company.company_name}:`, e.message);
    return { in_scope: false, reason: 'Validation error', business_description: 'Error during validation' };
  }
}

// Build validation results email
function buildValidationEmailHTML(companies, targetBusiness, countries, outputOption) {
  const inScopeCompanies = companies.filter(c => c.in_scope);
  const outOfScopeCompanies = companies.filter(c => !c.in_scope);

  let html = `
    <h2>Speeda List Validation Results</h2>
    <p><strong>Target Business:</strong> ${targetBusiness}</p>
    <p><strong>Countries:</strong> ${countries.join(', ')}</p>
    <p><strong>Total Companies Processed:</strong> ${companies.length}</p>
    <p><strong>In-Scope:</strong> ${inScopeCompanies.length}</p>
    <p><strong>Out-of-Scope:</strong> ${outOfScopeCompanies.length}</p>
    <br>
  `;

  if (outputOption === 'all_companies') {
    html += `
    <h3>All Companies</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #f0f0f0;">
        <tr><th>#</th><th>Company</th><th>Website</th><th>Status</th><th>Business Description</th></tr>
      </thead>
      <tbody>
    `;
    companies.forEach((c, i) => {
      const statusColor = c.in_scope ? '#10b981' : '#ef4444';
      const statusText = c.in_scope ? 'IN SCOPE' : 'OUT OF SCOPE';
      html += `<tr>
        <td>${i + 1}</td>
        <td>${c.company_name}</td>
        <td>${c.website ? `<a href="${c.website}">${c.website}</a>` : 'Not found'}</td>
        <td style="color: ${statusColor}; font-weight: bold;">${statusText}</td>
        <td>${c.business_description || c.reason || '-'}</td>
      </tr>`;
    });
    html += '</tbody></table>';
  } else {
    html += `
    <h3>In-Scope Companies</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #f0f0f0;">
        <tr><th>#</th><th>Company</th><th>Website</th><th>Business Description</th></tr>
      </thead>
      <tbody>
    `;
    if (inScopeCompanies.length === 0) {
      html += '<tr><td colspan="4" style="text-align: center;">No in-scope companies found</td></tr>';
    } else {
      inScopeCompanies.forEach((c, i) => {
        html += `<tr>
          <td>${i + 1}</td>
          <td>${c.company_name}</td>
          <td>${c.website ? `<a href="${c.website}">${c.website}</a>` : 'Not found'}</td>
          <td>${c.business_description || '-'}</td>
        </tr>`;
      });
    }
    html += '</tbody></table>';
  }

  return html;
}

// Build validation results as Excel file (returns base64 string)
function buildValidationExcel(companies, targetBusiness, countries, outputOption) {
  const inScopeCompanies = companies.filter(c => c.in_scope);

  // Create workbook
  const wb = XLSX.utils.book_new();

  // Always create 2 sheets: In-Scope Only and All Companies (for both_sheets or as default)
  // Sheet 1: In-Scope Only
  const inScopeData = inScopeCompanies.map((c, i) => ({
    '#': i + 1,
    'Company': c.company_name,
    'Website': c.website || 'Not found',
    'Business Description': c.business_description || '-'
  }));
  const inScopeSheet = XLSX.utils.json_to_sheet(inScopeData);
  inScopeSheet['!cols'] = [
    { wch: 5 },   // #
    { wch: 40 },  // Company
    { wch: 50 },  // Website
    { wch: 60 }   // Business Description
  ];
  XLSX.utils.book_append_sheet(wb, inScopeSheet, 'In-Scope Only');

  // Sheet 2: All Companies with status
  const allData = companies.map((c, i) => ({
    '#': i + 1,
    'Company': c.company_name,
    'Website': c.website || 'Not found',
    'Status': c.in_scope ? 'IN SCOPE' : 'OUT OF SCOPE',
    'Business Description': c.business_description || c.reason || '-'
  }));
  const allSheet = XLSX.utils.json_to_sheet(allData);
  allSheet['!cols'] = [
    { wch: 5 },   // #
    { wch: 40 },  // Company
    { wch: 50 },  // Website
    { wch: 15 },  // Status
    { wch: 60 }   // Business Description
  ];
  XLSX.utils.book_append_sheet(wb, allSheet, 'All Companies');

  // Write to buffer and convert to base64
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return buffer.toString('base64');
}

app.post('/api/validation', async (req, res) => {
  const { Companies, Countries, TargetBusiness, OutputOption, Email } = req.body;

  if (!Companies || !Countries || !TargetBusiness || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW VALIDATION REQUEST: ${new Date().toISOString()}`);
  console.log(`Target Business: ${TargetBusiness}`);
  console.log(`Countries: ${Countries}`);
  console.log(`Output Option: ${OutputOption || 'in_scope_only'}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(50));

  res.json({
    success: true,
    message: 'Validation request received. Results will be emailed within 10 minutes.'
  });

  try {
    const totalStart = Date.now();

    const companyList = parseCompanyList(Companies);
    const countryList = parseCountries(Countries);
    const outputOption = OutputOption || 'in_scope_only';

    console.log(`Parsed ${companyList.length} companies and ${countryList.length} countries`);

    if (companyList.length === 0) {
      await sendEmail(Email, 'Speeda List Validation - No Companies', '<p>No valid company names were found in your input.</p>');
      return;
    }

    // Process 15 companies in parallel for much faster results
    const batchSize = 15;
    const results = [];

    for (let i = 0; i < companyList.length; i += batchSize) {
      const batch = companyList.slice(i, i + batchSize);
      console.log(`\nProcessing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(companyList.length / batchSize)} (${batch.length} companies)`);

      const batchResults = await Promise.all(batch.map(async (companyName) => {
        const website = await findCompanyWebsiteMulti(companyName, countryList);

        if (!website) {
          return {
            company_name: companyName,
            website: null,
            in_scope: false,
            reason: 'Official website not found',
            business_description: 'Could not locate official company website'
          };
        }

        const pageText = await fetchWebsite(website);

        if (!pageText || pageText.length < 100) {
          return {
            company_name: companyName,
            website,
            in_scope: false,
            reason: 'Website inaccessible or no content',
            business_description: 'Could not fetch website content for validation'
          };
        }

        const validation = await validateCompanyBusinessStrict(
          { company_name: companyName, website },
          TargetBusiness,
          pageText
        );

        return {
          company_name: companyName,
          website,
          in_scope: validation.in_scope,
          reason: validation.reason,
          business_description: validation.business_description
        };
      }));

      results.push(...batchResults);
      console.log(`Completed: ${results.length}/${companyList.length}`);
    }

    const inScopeCount = results.filter(r => r.in_scope).length;

    // Build Excel file
    const excelBase64 = buildValidationExcel(results, TargetBusiness, countryList, outputOption);

    // Simple email body
    const emailBody = `
      <h2>Speeda List Validation Complete</h2>
      <p><strong>Target Business:</strong> ${TargetBusiness}</p>
      <p><strong>Countries:</strong> ${countryList.join(', ')}</p>
      <p><strong>Results:</strong> ${inScopeCount} in-scope out of ${results.length} companies</p>
      <br>
      <p>Please see the attached Excel file for detailed results.</p>
    `;

    await sendEmail(
      Email,
      `Speeda List Validation: ${inScopeCount}/${results.length} in-scope for "${TargetBusiness}"`,
      emailBody,
      {
        content: excelBase64,
        name: `validation-results-${new Date().toISOString().split('T')[0]}.xlsx`
      }
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log(`\n${'='.repeat(50)}`);
    console.log(`VALIDATION COMPLETE! Email sent to ${Email}`);
    console.log(`Total companies: ${results.length}, In-scope: ${inScopeCount}`);
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Validation error:', error);
    try {
      await sendEmail(Email, `Speeda List Validation - Error`, `<p>Error: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

// ============ TRADING COMPARABLE ============

// Helper function to calculate median
function calculateMedian(values) {
  const nums = values.filter(v => typeof v === 'number' && !isNaN(v) && isFinite(v) && v > 0);
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Format number for display
function formatNum(val, decimals = 1) {
  if (val === null || val === undefined || isNaN(val)) return '-';
  return Number(val).toFixed(decimals);
}

// Format as multiple (with x suffix)
function formatMultiple(val) {
  if (val === null || val === undefined || isNaN(val)) return '-';
  return Number(val).toFixed(1) + 'x';
}

// Format as percentage
function formatPercent(val) {
  if (val === null || val === undefined || isNaN(val)) return '-';
  return Number(val).toFixed(1) + '%';
}

// Build reasoning prompt for AI relevance check - no hardcoded examples
function buildReasoningPrompt(companyNames, filterCriteria) {
  return `You are filtering companies for a trading comparable analysis.

FILTER CRITERIA: "${filterCriteria}"

Companies to evaluate:
${companyNames.map((name, i) => `${i + 1}. ${name}`).join('\n')}

For EACH company, think step by step:
1. What is this company's PRIMARY business? (research if needed)
2. Does "${filterCriteria}" describe their main business activity?
3. Would an investment banker consider this company a direct peer/comparable?

Decision rules:
- relevant=true: Company's PRIMARY business matches the filter criteria
- relevant=false: Company operates in a different industry, or the criteria is only a minor part of their business

Output JSON: {"results": [{"index": 0, "name": "Company Name", "relevant": false, "business": "5-10 word description of actual business"}]}`;
}

// Helper: Check business relevance using OpenAI o1 (best reasoning model)
async function checkRelevanceWithOpenAI(companies, filterCriteria) {
  const companyNames = companies.map(c => c.name);
  const prompt = buildReasoningPrompt(companyNames, filterCriteria);

  try {
    // Try o1 first (best reasoning)
    const response = await openai.chat.completions.create({
      model: 'o1',
      messages: [{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }]
    });
    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { source: 'openai-o1', results: parsed.results || parsed.companies || parsed };
    }
    return null;
  } catch (error) {
    console.error('OpenAI o1 error:', error.message);
    // Fallback to o3-mini with high reasoning
    try {
      const response = await openai.chat.completions.create({
        model: 'o3-mini',
        messages: [{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }],
        reasoning_effort: 'high'
      });
      const content = response.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return { source: 'openai-o3-high', results: parsed.results || parsed.companies || parsed };
      }
      return null;
    } catch (e) {
      console.error('OpenAI o3-mini fallback error:', e.message);
      return null;
    }
  }
}

// Helper: Check business relevance using Gemini 2.0 Flash
async function checkRelevanceWithGemini(companies, filterCriteria) {
  const companyNames = companies.map(c => c.name);
  const prompt = buildReasoningPrompt(companyNames, filterCriteria);

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { source: 'gemini-2.0-flash', results: parsed.results || parsed.companies || parsed };
    }
    return null;
  } catch (error) {
    console.error('Gemini 2.0 Flash error:', error.message);
    return null;
  }
}

// Helper: Check business relevance using Perplexity sonar (best with web search)
async function checkRelevanceWithPerplexity(companies, filterCriteria) {
  const companyNames = companies.map(c => c.name);
  const prompt = buildReasoningPrompt(companyNames, filterCriteria);

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }]
      })
    });
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { source: 'perplexity-pro', results: parsed.results || parsed.companies || parsed };
    }
    return null;
  } catch (error) {
    console.error('Perplexity sonar error:', error.message);
    return null;
  }
}

// Helper: Check relevance with 3 AIs in parallel, use majority voting
async function checkBusinessRelevanceMultiAI(companies, filterCriteria) {
  console.log(`  Running 3-AI relevance check for: "${filterCriteria}"`);

  // Run all 3 AIs in parallel
  const [openaiResult, geminiResult, perplexityResult] = await Promise.all([
    checkRelevanceWithOpenAI(companies, filterCriteria),
    checkRelevanceWithGemini(companies, filterCriteria),
    checkRelevanceWithPerplexity(companies, filterCriteria)
  ]);

  const aiResults = [openaiResult, geminiResult, perplexityResult].filter(r => r !== null);
  console.log(`  Got responses from ${aiResults.length} AIs: ${aiResults.map(r => r.source).join(', ')}`);

  // Merge results using majority voting (2/3 must agree)
  const mergedResults = companies.map((c, i) => {
    const votes = [];
    const descriptions = [];

    for (const aiResult of aiResults) {
      if (!Array.isArray(aiResult.results)) continue;
      const result = aiResult.results.find(r => r.index === i || r.name === c.name);
      if (result) {
        votes.push(result.relevant === true);
        if (result.business) descriptions.push(result.business);
      }
    }

    // Majority voting: need majority to say relevant to KEEP
    // If 2+ AIs say NOT relevant, exclude the company
    const relevantVotes = votes.filter(v => v === true).length;
    const notRelevantVotes = votes.filter(v => v === false).length;
    const totalVotes = votes.length;

    let relevant;
    if (totalVotes >= 2) {
      // Majority voting - need more relevant than not-relevant to keep
      relevant = relevantVotes > notRelevantVotes;
    } else if (totalVotes === 1) {
      relevant = votes[0];
    } else {
      relevant = true; // No AI responded, keep by default
    }

    const business = descriptions[0] || 'Unknown business';

    return {
      index: i,
      name: c.name,
      relevant,
      business,
      votes: `${relevantVotes}/${totalVotes} voted relevant`
    };
  });

  const keptCount = mergedResults.filter(r => r.relevant).length;
  const removedCount = mergedResults.filter(r => !r.relevant).length;
  console.log(`  Majority voting result: ${keptCount} kept, ${removedCount} removed`);

  return mergedResults;
}

// ============ NEW 3-PHASE FILTERING SYSTEM (DeepSeek-powered) ============

/**
 * PHASE 1: Deep Analysis
 * Analyze all companies first, understand the landscape, create filtering strategy
 */
async function phase1DeepAnalysis(companies, targetDescription) {
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 1: DEEP ANALYSIS (DeepSeek Reasoner)');
  console.log('='.repeat(60));

  const companyList = companies.map((c, i) => `${i + 1}. ${c.name} (${c.country || 'Unknown'})`).join('\n');

  const prompt = `You are a senior investment banking analyst preparing a trading comparable analysis.

TARGET PEER GROUP: "${targetDescription}"

COMPANY LIST (${companies.length} companies from Speeda database):
${companyList}

TASK: Analyze this company list deeply before any filtering.

THINK THROUGH:
1. What industries/sectors are represented in this list?
2. What does "${targetDescription}" ACTUALLY mean in precise business terms?
   - What specific products/services?
   - What business model characteristics?
   - What geographic considerations?
3. Looking at the company names, identify:
   - Companies that are OBVIOUSLY relevant (core peers)
   - Companies that are OBVIOUSLY irrelevant (different industry entirely)
   - Companies that need careful evaluation (could go either way)
4. What are common "false positive" traps to avoid?
   - Holding companies that own the business but aren't pure-play
   - Diversified conglomerates where target segment is small
   - Companies with similar names but different businesses
5. What are common "false negative" mistakes to avoid?
   - Regional naming variations
   - Companies that changed names or rebranded

OUTPUT FORMAT (JSON):
{
  "targetAnalysis": {
    "businessDefinition": "precise definition of what constitutes a peer",
    "keyCharacteristics": ["characteristic 1", "characteristic 2", ...],
    "mustHave": ["criteria that a peer MUST meet"],
    "mustNotHave": ["criteria that should EXCLUDE a company"]
  },
  "companyCategories": {
    "obviouslyRelevant": [{"index": 0, "name": "Company", "reason": "why obviously relevant"}],
    "obviouslyIrrelevant": [{"index": 1, "name": "Company", "reason": "why obviously not relevant"}],
    "needsEvaluation": [{"index": 2, "name": "Company", "concern": "what needs to be verified"}]
  },
  "filteringStrategy": {
    "approach": "description of recommended filtering approach",
    "steps": [
      {"step": 1, "criteria": "specific criteria", "rationale": "why this step"},
      {"step": 2, "criteria": "specific criteria", "rationale": "why this step"}
    ]
  },
  "warnings": ["potential pitfalls to watch for"]
}`;

  // Use GPT-4o for deep analysis
  let analysisResult;
  console.log('Using GPT-4o for deep analysis...');
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });
    analysisResult = response.choices[0].message.content;
  } catch (error) {
    console.error('GPT-4o analysis error:', error.message);
  }

  // Parse the result
  try {
    const jsonMatch = analysisResult.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('\n--- Analysis Summary ---');
      console.log('Target Definition:', parsed.targetAnalysis?.businessDefinition);
      console.log('Obviously Relevant:', parsed.companyCategories?.obviouslyRelevant?.length || 0);
      console.log('Obviously Irrelevant:', parsed.companyCategories?.obviouslyIrrelevant?.length || 0);
      console.log('Needs Evaluation:', parsed.companyCategories?.needsEvaluation?.length || 0);
      console.log('Filter Steps:', parsed.filteringStrategy?.steps?.length || 0);
      return parsed;
    }
  } catch (error) {
    console.error('Failed to parse analysis result:', error.message);
  }

  return null;
}

/**
 * PHASE 2: Deliberate Filtering
 * Evaluate each company carefully against the strategy from Phase 1
 */
async function phase2DeliberateFiltering(companies, analysis, targetDescription, outputWorkbook, sheetHeaders, startSheetNumber) {
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 2: DELIBERATE FILTERING');
  console.log('='.repeat(60));

  let currentCompanies = [...companies];
  let sheetNumber = startSheetNumber;
  const filterLog = [];
  const allReasoning = [];

  // If analysis failed, use simple approach
  if (!analysis) {
    console.log('No analysis available, using simple filtering...');
    return { companies: currentCompanies, filterLog, sheetNumber, reasoning: allReasoning };
  }

  // First, apply obvious exclusions from Phase 1
  const obviouslyIrrelevant = analysis.companyCategories?.obviouslyIrrelevant || [];
  if (obviouslyIrrelevant.length > 0) {
    const irrelevantIndices = new Set(obviouslyIrrelevant.map(c => c.index));
    const removedCompanies = [];
    const keptCompanies = [];

    currentCompanies.forEach((c, idx) => {
      if (irrelevantIndices.has(idx)) {
        const match = obviouslyIrrelevant.find(x => x.index === idx);
        c.filterReason = match?.reason || 'Obviously not in target industry';
        removedCompanies.push(c);
      } else {
        keptCompanies.push(c);
      }
    });

    if (removedCompanies.length > 0 && keptCompanies.length >= 3) {
      currentCompanies = keptCompanies;
      const logEntry = `Phase 1 Quick Filter: Removed ${removedCompanies.length} obviously irrelevant companies`;
      filterLog.push(logEntry);
      console.log(logEntry);

      // Create sheet
      const sheetData = createSheetData(currentCompanies, sheetHeaders,
        `After Quick Filter - ${currentCompanies.length} companies`);

      // Add removed section
      sheetData.push([], [], ['REMOVED - Obviously Not Relevant'], ['Company', 'Reason']);
      removedCompanies.forEach(c => sheetData.push([c.name, c.filterReason]));

      const sheet = XLSX.utils.aoa_to_sheet(sheetData);
      XLSX.utils.book_append_sheet(outputWorkbook, sheet, `${sheetNumber}. Quick Filter`);
      sheetNumber++;
    }
  }

  // Now apply each filter step from the strategy
  const filterSteps = analysis.filteringStrategy?.steps || [];
  const targetDef = analysis.targetAnalysis?.businessDefinition || targetDescription;

  for (let stepIdx = 0; stepIdx < filterSteps.length; stepIdx++) {
    const step = filterSteps[stepIdx];
    console.log(`\nFilter Step ${stepIdx + 1}: ${step.criteria}`);
    console.log(`Rationale: ${step.rationale}`);

    if (currentCompanies.length <= 5) {
      console.log('Skipping - already at minimum company count');
      break;
    }

    // Evaluate each company against this criterion
    const evaluationPrompt = `You are evaluating companies for a trading comparable analysis.

TARGET PEER GROUP: "${targetDescription}"
BUSINESS DEFINITION: "${targetDef}"

CURRENT FILTER CRITERION: "${step.criteria}"
RATIONALE: "${step.rationale}"

Companies to evaluate:
${currentCompanies.map((c, i) => `${i + 1}. ${c.name} (${c.country || 'Unknown'})`).join('\n')}

For EACH company, evaluate against the criterion "${step.criteria}":

THINK CAREFULLY for each company:
1. What is this company's actual primary business?
2. Does it meet the criterion "${step.criteria}"?
3. How confident are you? (0-100%)

OUTPUT JSON:
{
  "evaluations": [
    {
      "index": 0,
      "name": "Company Name",
      "passes": true/false,
      "confidence": 85,
      "business": "what this company actually does",
      "reasoning": "why it passes/fails this criterion"
    }
  ]
}

IMPORTANT: Only mark passes=false if you are >70% confident the company does NOT meet the criterion.
When uncertain, keep the company (passes=true) for manual review.`;

    let evalResult;
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: evaluationPrompt }],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      });
      evalResult = response.choices[0].message.content;
    } catch (error) {
      console.error('Evaluation error:', error.message);
      continue;
    }

    // Parse and apply results
    try {
      const jsonMatch = evalResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const evaluations = parsed.evaluations || [];

        const removedCompanies = [];
        const keptCompanies = [];

        currentCompanies.forEach((c, idx) => {
          const eval_ = evaluations.find(e => e.index === idx);
          if (eval_ && !eval_.passes && eval_.confidence >= 70) {
            c.filterReason = `${eval_.business} - ${eval_.reasoning}`;
            c.confidence = eval_.confidence;
            removedCompanies.push(c);
          } else {
            if (eval_) {
              c.businessDescription = eval_.business;
            }
            keptCompanies.push(c);
          }
        });

        // Only apply if we keep enough companies
        if (keptCompanies.length >= 5 && removedCompanies.length > 0) {
          currentCompanies = keptCompanies;
          const logEntry = `Step ${stepIdx + 1} (${step.criteria}): Removed ${removedCompanies.length} companies`;
          filterLog.push(logEntry);
          console.log(`  ${logEntry}`);

          // Create sheet
          const sheetData = createSheetData(currentCompanies, sheetHeaders,
            `Step ${stepIdx + 1}: ${step.criteria} - ${currentCompanies.length} remaining`);

          sheetData.push([], [], [`REMOVED - Did not meet: "${step.criteria}"`], ['Company', 'Business', 'Reason', 'Confidence']);
          removedCompanies.forEach(c => sheetData.push([c.name, '', c.filterReason, `${c.confidence}%`]));

          const sheet = XLSX.utils.aoa_to_sheet(sheetData);
          const sheetName = `${sheetNumber}. Step ${stepIdx + 1}`;
          XLSX.utils.book_append_sheet(outputWorkbook, sheet, sheetName.substring(0, 31));
          sheetNumber++;
        } else {
          console.log(`  Skipping - would remove too many (${removedCompanies.length}) or keep too few (${keptCompanies.length})`);
        }
      }
    } catch (error) {
      console.error('Failed to parse evaluation:', error.message);
    }
  }

  return { companies: currentCompanies, filterLog, sheetNumber, reasoning: allReasoning };
}

/**
 * PHASE 3: Self-Validation
 * Review the final peer set for coherence and catch any mistakes
 */
async function phase3Validation(companies, targetDescription, analysis) {
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 3: SELF-VALIDATION');
  console.log('='.repeat(60));

  if (companies.length === 0) {
    return { valid: false, issues: ['No companies remaining'], suggestions: [] };
  }

  const validationPrompt = `You are a senior investment banker reviewing a trading comparable peer set.

TARGET: "${targetDescription}"

FINAL PEER SET (${companies.length} companies):
${companies.map((c, i) => `${i + 1}. ${c.name} (${c.country || 'Unknown'})${c.businessDescription ? ' - ' + c.businessDescription : ''}`).join('\n')}

VALIDATION CHECKLIST:
1. COHERENCE: Do all these companies belong together as peers?
   - Are they in the same/similar industry?
   - Are there any obvious outliers that don't fit?

2. COMPLETENESS: Is this a reasonable peer set?
   - Are there enough companies (ideally 5-15)?
   - Is there geographic diversity appropriate for the target?

3. MISTAKES: Were any obvious errors made?
   - Any company that clearly doesn't belong?
   - Any naming confusion (similar name, different business)?

4. QUALITY: Would an investment banker accept this peer set?
   - Are these companies that would typically be used in a real analysis?

OUTPUT JSON:
{
  "overallAssessment": "good/acceptable/poor",
  "coherenceScore": 85,
  "issues": [
    {"company": "Name", "issue": "description of problem", "severity": "high/medium/low"}
  ],
  "suggestions": [
    "suggestion for improvement"
  ],
  "finalVerdict": "one sentence summary"
}`;

  let validationResult;
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: validationPrompt }],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });
    validationResult = response.choices[0].message.content;
  } catch (error) {
    console.error('Validation error:', error.message);
    return { valid: true, issues: [], suggestions: [] };
  }

  try {
    const jsonMatch = validationResult.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('\n--- Validation Result ---');
      console.log('Assessment:', parsed.overallAssessment);
      console.log('Coherence Score:', parsed.coherenceScore);
      console.log('Issues Found:', parsed.issues?.length || 0);
      console.log('Verdict:', parsed.finalVerdict);
      return parsed;
    }
  } catch (error) {
    console.error('Failed to parse validation:', error.message);
  }

  return { valid: true, issues: [], suggestions: [] };
}

/**
 * MAIN: Apply the 3-phase filtering pipeline
 */
async function applyThreePhaseFiltering(companies, targetDescription, outputWorkbook, sheetHeaders, startSheetNumber) {
  console.log('\n' + '█'.repeat(60));
  console.log('STARTING 3-PHASE FILTERING PIPELINE');
  console.log('█'.repeat(60));
  console.log(`Companies: ${companies.length}`);
  console.log(`Target: ${targetDescription}`);

  // Phase 1: Deep Analysis
  const analysis = await phase1DeepAnalysis(companies, targetDescription);

  // Phase 2: Deliberate Filtering
  const filterResult = await phase2DeliberateFiltering(
    companies,
    analysis,
    targetDescription,
    outputWorkbook,
    sheetHeaders,
    startSheetNumber
  );

  // Phase 3: Validation
  const validation = await phase3Validation(filterResult.companies, targetDescription, analysis);

  // Add validation info to filter log
  if (validation.overallAssessment) {
    filterResult.filterLog.push(`Validation: ${validation.overallAssessment} (coherence: ${validation.coherenceScore}%)`);
  }
  if (validation.issues?.length > 0) {
    filterResult.filterLog.push(`Validation Issues: ${validation.issues.map(i => i.company + ' - ' + i.issue).join('; ')}`);
  }

  return {
    companies: filterResult.companies,
    filterLog: filterResult.filterLog,
    sheetNumber: filterResult.sheetNumber,
    analysis,
    validation,
    reasoning: filterResult.reasoning
  };
}

// ============ END 3-PHASE FILTERING SYSTEM ============

// Helper: Generate filtering steps based on target description
async function generateFilteringSteps(targetDescription, companyCount) {
  const prompt = `You are creating a methodical filtering approach for trading comparable analysis.

Target: "${targetDescription}"
Number of companies to filter: ${companyCount}

Create 2-4 progressive filtering steps to narrow down from a broad industry to the specific target.
Each step should be more specific than the previous.

Example for "payroll outsourcing company in Asia":
Step 1: "Business process outsourcing (BPO) or HR services companies"
Step 2: "HR technology or payroll services companies"
Step 3: "Payroll processing or payroll outsourcing companies"
Step 4: "Payroll companies with Asia focus or operations"

Return JSON: {"steps": ["step 1 criteria", "step 2 criteria", "step 3 criteria"]}

Make each step progressively more selective. First step should be broad, last step should match the target closely.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    return parsed.steps || [`Companies related to ${targetDescription}`];
  } catch (error) {
    console.error('Error generating filtering steps:', error);
    return [`Companies related to ${targetDescription}`];
  }
}

// Helper: Apply iterative qualitative filtering with multiple AI checks
async function applyIterativeQualitativeFilter(companies, targetDescription, outputWorkbook, sheetHeaders, startSheetNumber) {
  let currentCompanies = [...companies];
  let sheetNumber = startSheetNumber;
  const filterLog = [];

  // Generate filtering steps
  console.log('Generating filtering steps...');
  const filteringSteps = await generateFilteringSteps(targetDescription, currentCompanies.length);
  console.log(`Generated ${filteringSteps.length} filtering steps:`, filteringSteps);

  // Apply each filtering step
  for (let stepIdx = 0; stepIdx < filteringSteps.length; stepIdx++) {
    const filterCriteria = filteringSteps[stepIdx];
    console.log(`\nApplying filter step ${stepIdx + 1}: "${filterCriteria}"`);

    if (currentCompanies.length <= 3) {
      console.log('  Skipping - already at minimum company count');
      break;
    }

    // Run multi-AI relevance check
    const relevanceResults = await checkBusinessRelevanceMultiAI(currentCompanies, filterCriteria);

    const removedCompanies = [];
    const keptCompanies = [];

    for (let i = 0; i < currentCompanies.length; i++) {
      const result = relevanceResults[i];
      const company = { ...currentCompanies[i] };

      if (result && !result.relevant) {
        company.filterReason = result.business;
        removedCompanies.push(company);
      } else {
        keptCompanies.push(company);
      }
    }

    // Only apply filter if it doesn't remove too many companies
    if (keptCompanies.length >= 3) {
      currentCompanies = keptCompanies;
      const logEntry = `Filter ${sheetNumber - 1} (${filterCriteria}): Removed ${removedCompanies.length} companies`;
      filterLog.push(logEntry);
      console.log(`  ${logEntry}`);

      // Create sheet for this filter step
      const sheetData = createSheetData(currentCompanies, sheetHeaders,
        `Step ${stepIdx + 1}: ${filterCriteria} - ${currentCompanies.length} companies (removed ${removedCompanies.length})`);

      // Add removed companies section (5 rows gap, clear header)
      if (removedCompanies.length > 0) {
        // Add 5 empty rows for visual separation
        for (let i = 0; i < 5; i++) {
          sheetData.push([]);
        }
        // Header row for out-of-scope section
        sheetData.push(['OUT OF SCOPE - Not matching: "' + filterCriteria + '"', 'Business Description (Reason for Exclusion)']);
        sheetData.push(['Company Name', 'What They Actually Do']);
        // List removed companies
        for (const c of removedCompanies) {
          sheetData.push([c.name, c.filterReason || 'Does not match filter criteria']);
        }
      }

      const sheet = XLSX.utils.aoa_to_sheet(sheetData);

      // Apply styling to the out-of-scope header row
      if (removedCompanies.length > 0) {
        const headerRowIdx = sheetData.length - removedCompanies.length - 2; // Row index of "OUT OF SCOPE" header
        const subHeaderRowIdx = headerRowIdx + 1;

        // Style header cells (dark background)
        const headerStyle = { fill: { fgColor: { rgb: '1E3A5F' } }, font: { bold: true, color: { rgb: 'FFFFFF' } } };
        const subHeaderStyle = { fill: { fgColor: { rgb: '374151' } }, font: { bold: true, color: { rgb: 'FFFFFF' } } };

        // Apply styles if xlsx supports it (basic xlsx doesn't, but we set the data clearly)
        // The header text itself makes it clear
      }

      const sheetName = `${sheetNumber}. Q${stepIdx + 1} ${filterCriteria.substring(0, 20)}`;
      XLSX.utils.book_append_sheet(outputWorkbook, sheet, sheetName.substring(0, 31));
      sheetNumber++;
    } else {
      console.log(`  Skipping filter - would leave only ${keptCompanies.length} companies`);
    }

    // Stop if we're in the target range
    if (currentCompanies.length >= 3 && currentCompanies.length <= 30) {
      console.log(`  Reached target range: ${currentCompanies.length} companies`);
      break;
    }
  }

  return { companies: currentCompanies, filterLog, sheetNumber };
}

// Helper: Create sheet data from companies
function createSheetData(companies, headers, title) {
  const data = [[title], [], headers];

  for (const c of companies) {
    const row = [
      c.name,
      c.country || '-',
      c.sales,
      c.marketCap,
      c.ev,
      c.ebitda,
      c.netMargin,
      c.opMargin,
      c.ebitdaMargin,
      c.evEbitda,
      c.peTTM,
      c.peFY,
      c.pb,
      c.filterReason || ''
    ];
    data.push(row);
  }

  // Add median row
  if (companies.length > 0) {
    const medianRow = [
      'MEDIAN',
      '',
      calculateMedian(companies.map(c => c.sales)),
      calculateMedian(companies.map(c => c.marketCap)),
      calculateMedian(companies.map(c => c.ev)),
      calculateMedian(companies.map(c => c.ebitda)),
      calculateMedian(companies.map(c => c.netMargin)),
      calculateMedian(companies.map(c => c.opMargin)),
      calculateMedian(companies.map(c => c.ebitdaMargin)),
      calculateMedian(companies.map(c => c.evEbitda)),
      calculateMedian(companies.map(c => c.peTTM)),
      calculateMedian(companies.map(c => c.peFY)),
      calculateMedian(companies.map(c => c.pb)),
      ''
    ];
    data.push([]);
    data.push(medianRow);
  }

  return data;
}

app.post('/api/trading-comparable', upload.single('ExcelFile'), async (req, res) => {
  const { TargetCompanyOrIndustry, Email, IsProfitable } = req.body;
  const excelFile = req.file;

  if (!excelFile || !TargetCompanyOrIndustry || !Email) {
    return res.status(400).json({ error: 'Excel file, target company/industry, and email are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW TRADING COMPARABLE REQUEST: ${new Date().toISOString()}`);
  console.log(`Target: ${TargetCompanyOrIndustry}`);
  console.log(`Email: ${Email}`);
  console.log(`Profitable: ${IsProfitable}`);
  console.log(`File: ${excelFile.originalname} (${excelFile.size} bytes)`);
  console.log('='.repeat(50));

  res.json({
    success: true,
    message: 'Request received. Results will be emailed shortly.'
  });

  try {
    const workbook = XLSX.read(excelFile.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Read Filter List sheet to extract criteria for slide title
    let slideTitle = TargetCompanyOrIndustry; // Default fallback
    const filterListSheet = workbook.Sheets['Filter List'];
    if (filterListSheet) {
      const filterRows = XLSX.utils.sheet_to_json(filterListSheet, { header: 1 });
      let region = '';
      let industry = '';
      let status = '';

      // Parse the Filter List sheet to find Region, Industry, Status
      for (const row of filterRows) {
        if (!row || row.length < 2) continue;
        const label = String(row[0] || '').toLowerCase();
        const value = String(row[1] || '');

        if (label.includes('region')) {
          region = value;
        } else if (label.includes('industry')) {
          industry = value;
        } else if (label.includes('status')) {
          status = value;
        }
      }

      // Build dynamic title: "Listed Cosmetics Companies in Malaysia, Singapore and Thailand"
      if (industry || region) {
        const statusText = status.toLowerCase() === 'listed' ? 'Listed ' : '';
        const industryText = industry || '';
        const regionText = region ? region.split(',').map(r => r.trim()).join(', ').replace(/, ([^,]*)$/, ' and $1') : '';

        slideTitle = `${statusText}${industryText} Companies in ${regionText}`.trim();
        console.log(`Dynamic slide title from Filter List: ${slideTitle}`);
      }
    }

    console.log(`Total rows in file: ${allRows.length}`);

    // Find the header row - look for row containing company-related headers
    let headerRowIndex = -1;
    let headers = [];

    for (let i = 0; i < Math.min(20, allRows.length); i++) {
      const row = allRows[i];
      if (!row) continue;
      const rowStr = row.join(' ').toLowerCase();
      if ((rowStr.includes('company') || rowStr.includes('name')) &&
          (rowStr.includes('sales') || rowStr.includes('market') || rowStr.includes('ebitda') || rowStr.includes('p/e') || rowStr.includes('ev/'))) {
        headerRowIndex = i;
        headers = row;
        break;
      }
    }

    if (headerRowIndex === -1) {
      headerRowIndex = 0;
      headers = allRows[0] || [];
    }

    console.log(`Header row index: ${headerRowIndex}`);
    console.log(`Headers: ${headers.slice(0, 15).join(', ')}...`);

    // Find column indices - enhanced to detect TTM vs FY columns
    const findCol = (patterns) => {
      for (const pattern of patterns) {
        const idx = headers.findIndex(h =>
          h && h.toString().toLowerCase().includes(pattern.toLowerCase())
        );
        if (idx !== -1) return idx;
      }
      return -1;
    };

    // Find all columns matching a pattern (for TTM/FY detection)
    const findAllCols = (patterns) => {
      const found = [];
      for (let idx = 0; idx < headers.length; idx++) {
        const h = headers[idx];
        if (!h) continue;
        const hLower = h.toString().toLowerCase();
        for (const pattern of patterns) {
          if (hLower.includes(pattern.toLowerCase())) {
            found.push({ idx, header: h });
            break;
          }
        }
      }
      return found;
    };

    // Find P/E columns - prefer TTM over FY
    const peCols = findAllCols(['p/e', 'pe ', 'per ', 'price/earnings', 'price-earnings']);
    let peTTMCol = -1;
    let peFYCol = -1;

    for (const col of peCols) {
      const hLower = col.header.toLowerCase();
      if (hLower.includes('ttm') || hLower.includes('trailing') || hLower.includes('ltm')) {
        peTTMCol = col.idx;
      } else if (hLower.includes('fy') || hLower.includes('annual') || hLower.includes('year')) {
        peFYCol = col.idx;
      }
    }
    // If no specific TTM/FY found, use first P/E column as FY
    if (peTTMCol === -1 && peFYCol === -1 && peCols.length > 0) {
      peFYCol = peCols[0].idx;
    }

    const cols = {
      company: findCol(['company name', 'company', 'name']),
      country: findCol(['country', 'region', 'location']),
      sales: findCol(['sales', 'revenue']),
      marketCap: findCol(['market cap', 'mcap', 'market capitalization']),
      ev: findCol(['enterprise value', ' ev ', 'ev/']),
      ebitda: findCol(['ebitda']),
      netMargin: findCol(['net margin', 'net income margin', 'profit margin', 'net profit margin']),
      opMargin: findCol(['operating margin', 'op margin', 'oper margin', 'opm']),
      ebitdaMargin: findCol(['ebitda margin', 'ebitda %', 'ebitda/sales']),
      evEbitda: findCol(['ev/ebitda', 'ev / ebitda']),
      peTTM: peTTMCol,
      peFY: peFYCol,
      pb: findCol(['p/b', 'pb ', 'p/bv', 'pbv', 'price/book'])
    };

    if (cols.company === -1) cols.company = 0;

    console.log(`Column mapping:`, cols);

    // Extract data rows
    const dataRows = allRows.slice(headerRowIndex + 1);
    const allCompanies = [];

    for (const row of dataRows) {
      if (!row || row.length === 0) continue;

      const companyName = cols.company >= 0 ? row[cols.company] : null;
      if (!companyName) continue;

      const nameStr = String(companyName).toLowerCase();
      if (nameStr.includes('total') || nameStr.includes('median') || nameStr.includes('average') ||
          nameStr.includes('note:') || nameStr.includes('source:') || nameStr.includes('unit') ||
          nameStr.startsWith('*') || nameStr.length < 2) continue;
      if (nameStr.startsWith('spd') && nameStr.length > 10) continue;

      const parseNum = (idx) => {
        if (idx < 0 || !row[idx]) return null;
        const val = parseFloat(String(row[idx]).replace(/[,%]/g, ''));
        return isNaN(val) ? null : val;
      };

      const company = {
        name: companyName,
        country: cols.country >= 0 ? row[cols.country] || '-' : '-',
        sales: parseNum(cols.sales),
        marketCap: parseNum(cols.marketCap),
        ev: parseNum(cols.ev),
        ebitda: parseNum(cols.ebitda),
        netMargin: parseNum(cols.netMargin),
        opMargin: parseNum(cols.opMargin),
        ebitdaMargin: parseNum(cols.ebitdaMargin),
        evEbitda: parseNum(cols.evEbitda),
        peTTM: parseNum(cols.peTTM),
        peFY: parseNum(cols.peFY),
        pb: parseNum(cols.pb),
        filterReason: ''
      };

      // Only include if it has at least some financial data
      const hasData = company.sales || company.marketCap || company.evEbitda || company.peTTM || company.peFY || company.pb;
      if (hasData) {
        allCompanies.push(company);
      }
    }

    console.log(`Extracted ${allCompanies.length} companies with data`);

    if (allCompanies.length === 0) {
      await sendEmail(Email, 'Trading Comparable - No Data Found',
        '<p>No valid company data was found in your Excel file. Please ensure the file has company names and financial metrics.</p>');
      return;
    }

    // Create output workbook
    const outputWorkbook = XLSX.utils.book_new();
    const sheetHeaders = ['Company', 'Country', 'Sales', 'Market Cap', 'EV', 'EBITDA', 'Net Margin %', 'Op Margin %', 'EBITDA Margin %', 'EV/EBITDA', 'P/E (TTM)', 'P/E (FY)', 'P/BV', 'Filter Reason'];

    // Sheet 1: All Original Companies
    const sheet1Data = createSheetData(allCompanies, sheetHeaders, `Original Data - ${allCompanies.length} companies`);
    const sheet1 = XLSX.utils.aoa_to_sheet(sheet1Data);
    XLSX.utils.book_append_sheet(outputWorkbook, sheet1, '1. Original');

    const isProfitable = IsProfitable === 'yes';
    let currentCompanies = [...allCompanies];
    let sheetNumber = 2;
    const filterLog = [];

    // FILTER 0: Always remove companies with negative EV (regardless of profitable toggle)
    const removedByNegEV = [];
    currentCompanies = currentCompanies.filter(c => {
      if (c.ev !== null && c.ev < 0) {
        c.filterReason = 'Negative enterprise value';
        removedByNegEV.push(c);
        return false;
      }
      return true;
    });

    if (removedByNegEV.length > 0) {
      filterLog.push(`Filter (EV): Removed ${removedByNegEV.length} companies with negative enterprise value`);
      console.log(filterLog[filterLog.length - 1]);

      const sheetEVData = createSheetData(currentCompanies, sheetHeaders,
        `After Negative EV Filter - ${currentCompanies.length} companies (removed ${removedByNegEV.length})`);
      const sheetEV = XLSX.utils.aoa_to_sheet(sheetEVData);
      XLSX.utils.book_append_sheet(outputWorkbook, sheetEV, `${sheetNumber}. After EV Filter`);
      sheetNumber++;
    }

    if (isProfitable) {
      // FILTER 1: Remove companies without P/E OR with negative net margin (loss-making)
      const removedByPE = [];
      currentCompanies = currentCompanies.filter(c => {
        // Check for valid P/E ratio
        const hasPE = (c.peTTM !== null && c.peTTM > 0) || (c.peFY !== null && c.peFY > 0);
        // Check for negative net margin (loss-making company)
        const hasNegativeMargin = c.netMargin !== null && c.netMargin < 0;

        if (!hasPE) {
          c.filterReason = 'No P/E ratio';
          removedByPE.push(c);
          return false;
        }
        if (hasNegativeMargin) {
          c.filterReason = 'Negative net margin (loss-making)';
          removedByPE.push(c);
          return false;
        }
        return true;
      });

      filterLog.push(`Filter (P/E + Margin): Removed ${removedByPE.length} companies without P/E or with negative margin`);
      console.log(filterLog[filterLog.length - 1]);

      // Sheet: After P/E filter
      const sheetPEData = createSheetData(currentCompanies, sheetHeaders,
        `After P/E & Margin Filter - ${currentCompanies.length} companies (removed ${removedByPE.length})`);
      const sheetPE = XLSX.utils.aoa_to_sheet(sheetPEData);
      XLSX.utils.book_append_sheet(outputWorkbook, sheetPE, `${sheetNumber}. After PE Filter`);
      sheetNumber++;
    }

    // QUALITATIVE FILTER: Apply 3-phase filtering pipeline (DeepSeek-powered)
    // Phase 1: Deep Analysis - understand companies and create strategy
    // Phase 2: Deliberate Filtering - evaluate each company carefully
    // Phase 3: Self-Validation - review final peer set
    console.log(`\nStarting 3-phase filtering with ${currentCompanies.length} companies...`);
    const qualResult = await applyThreePhaseFiltering(
      currentCompanies,
      TargetCompanyOrIndustry,
      outputWorkbook,
      sheetHeaders,
      sheetNumber
    );

    currentCompanies = qualResult.companies;
    filterLog.push(...qualResult.filterLog);
    sheetNumber = qualResult.sheetNumber;

    // Store analysis and validation results for potential use in email/output
    const analysisResult = qualResult.analysis;
    const validationResult = qualResult.validation;

    // FINAL SHEET: Summary with medians
    const finalCompanies = currentCompanies;
    const medians = {
      sales: calculateMedian(finalCompanies.map(c => c.sales)),
      marketCap: calculateMedian(finalCompanies.map(c => c.marketCap)),
      ev: calculateMedian(finalCompanies.map(c => c.ev)),
      ebitda: calculateMedian(finalCompanies.map(c => c.ebitda)),
      netMargin: calculateMedian(finalCompanies.map(c => c.netMargin)),
      opMargin: calculateMedian(finalCompanies.map(c => c.opMargin)),
      ebitdaMargin: calculateMedian(finalCompanies.map(c => c.ebitdaMargin)),
      evEbitda: calculateMedian(finalCompanies.map(c => c.evEbitda)),
      peTTM: calculateMedian(finalCompanies.map(c => c.peTTM)),
      peFY: calculateMedian(finalCompanies.map(c => c.peFY)),
      pb: calculateMedian(finalCompanies.map(c => c.pb))
    };

    // Create final summary sheet
    const summaryData = [
      [`Trading Comparable Analysis: ${TargetCompanyOrIndustry}`],
      [`Generated: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`],
      [],
      ['FILTER SUMMARY'],
      [`Started with ${allCompanies.length} companies`],
      ...filterLog.map(f => [f]),
      [`Final shortlist: ${finalCompanies.length} companies`],
      [],
      ['FINAL COMPARABLE COMPANIES'],
      sheetHeaders,
    ];

    for (const c of finalCompanies) {
      summaryData.push([
        c.name, c.country || '-', c.sales, c.marketCap, c.ev, c.ebitda, c.netMargin,
        c.opMargin, c.ebitdaMargin, c.evEbitda, c.peTTM, c.peFY, c.pb, ''
      ]);
    }

    summaryData.push([]);
    summaryData.push([
      'MEDIAN', '', medians.sales, medians.marketCap, medians.ev, medians.ebitda, medians.netMargin,
      medians.opMargin, medians.ebitdaMargin, medians.evEbitda, medians.peTTM, medians.peFY, medians.pb, ''
    ]);

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(outputWorkbook, summarySheet, 'Summary');

    // Generate Excel buffer
    const excelBuffer = XLSX.write(outputWorkbook, { type: 'base64', bookType: 'xlsx' });

    // Generate PPT slide - matching trading comps template EXACTLY
    // Using proper TABLE structure:
    // - Row 1: DARK BLUE (#003399) - merged cells for "Financial Information" and "Multiples"
    // - Row 2: LIGHT BLUE (#B4C6E7) - column headers
    // - Data rows: white with dotted line borders
    // - Median row: last 4 cells dark blue

    const pptx = new pptxgen();
    pptx.author = 'YCP';
    pptx.title = 'Trading Comparable';

    // Set exact slide size (16:9 widescreen)
    pptx.defineLayout({ name: 'TRADING', width: 13.333, height: 7.5 });
    pptx.layout = 'TRADING';

    // Template colors (extracted from reference PPTX theme1.xml)
    const COLORS = {
      darkBlue: '011AB7',      // Row 1 (Financial Information, Multiples) - accent3
      lightBlue: '007FFF',     // Row 2 column headers AND median cell - accent1
      navyLine: '293F55',      // Header/footer lines from slideLayout1
      white: 'FFFFFF',
      black: '000000',
      gray: '808080',
      lineGray: 'A0A0A0'
    };

    const slide = pptx.addSlide();

    // ===== HEADER LINES (from slideLayout1) =====
    // Thick line at y=1.02" (933847 EMU), width 4.5pt (57150 EMU)
    slide.addShape(pptx.shapes.LINE, {
      x: 0, y: 1.02, w: 13.333, h: 0,
      line: { color: COLORS.navyLine, width: 4.5 }
    });
    // Thin line at y=1.10" (1005855 EMU), width 2.25pt (28575 EMU)
    slide.addShape(pptx.shapes.LINE, {
      x: 0, y: 1.10, w: 13.333, h: 0,
      line: { color: COLORS.navyLine, width: 2.25 }
    });

    // ===== TITLE + SUBTITLE (positioned per slideLayout1: x=0.38", y=0.05") =====
    // Title at top (font 24), subtitle below (font 16), combined text box
    slide.addText([
      { text: `Trading Comparable – ${slideTitle}`, options: { fontSize: 24, fontFace: 'Segoe UI', color: COLORS.black, breakLine: true } },
      { text: `Considering financial data availability, profitability and business relevance, ${finalCompanies.length} companies are considered as peers`, options: { fontSize: 16, fontFace: 'Segoe UI', color: COLORS.black } }
    ], {
      x: 0.38, y: 0.05, w: 12.5, h: 0.91,
      valign: 'bottom'
    });

    // Helper function to clean company name
    const cleanCompanyName = (name) => {
      if (!name) return '-';
      const suffixes = [
        /\s+(Bhd|BHD|Berhad|BERHAD)\.?$/i,
        /\s+(PCL|Pcl|P\.C\.L\.)\.?$/i,
        /\s+(JSC|Jsc|J\.S\.C\.)\.?$/i,
        /\s+(Ltd|LTD|Limited|LIMITED)\.?$/i,
        /\s+(Inc|INC|Incorporated|INCORPORATED)\.?$/i,
        /\s+(Corp|CORP|Corporation|CORPORATION)\.?$/i,
        /\s+(Co|CO|Company|COMPANY)\.?,?\s*(Ltd|LTD|Limited)?\.?$/i,
        /\s+(PLC|Plc|P\.L\.C\.)\.?$/i,
        /\s+(AG|A\.G\.)\.?$/i,
        /\s+(SA|S\.A\.|S\.A)\.?$/i,
        /\s+(NV|N\.V\.)\.?$/i,
        /\s+(GmbH|GMBH)\.?$/i,
        /\s+(Tbk|TBK|PT)\.?$/i,
        /\s+(Oyj|OYJ|AB)\.?$/i,
        /\s+(SE)\.?$/i,
        /\s+(SpA|SPA|S\.p\.A\.)\.?$/i,
        /\s+(Pte|PTE)\.?\s*(Ltd|LTD)?\.?$/i,
        /\s+(Sdn|SDN)\.?\s*(Bhd|BHD)?\.?$/i,
        /,\s*(Inc|Ltd|LLC|Corp)\.?$/i,
        /\s+Holdings?$/i,
        /\s+Group$/i,
        /\s+International$/i
      ];
      let cleaned = String(name).trim();
      for (const suffix of suffixes) {
        cleaned = cleaned.replace(suffix, '');
      }
      cleaned = cleaned.trim();
      // Truncate to 20 chars max to fit on one line
      if (cleaned.length > 20) {
        cleaned = cleaned.substring(0, 18) + '..';
      }
      return cleaned;
    };

    // Helper functions
    const formatFinNum = (val) => {
      if (val === null || val === undefined) return '-';
      if (typeof val === 'number') return Math.round(val).toLocaleString('en-US');
      return String(val);
    };

    const formatMultipleX = (val) => {
      if (val === null || val === undefined) return '-';
      if (typeof val === 'number') return val.toFixed(1) + 'x';
      return String(val);
    };

    const formatPct = (val) => {
      if (val === null || val === undefined) return '-';
      if (typeof val === 'number') return val.toFixed(1) + '%';
      return String(val);
    };

    // ===== BUILD TABLE =====
    // Sort companies by sales (highest to lowest), then take top 30
    const sortedCompanies = [...finalCompanies].sort((a, b) => {
      const salesA = a.sales !== null && a.sales !== undefined ? a.sales : 0;
      const salesB = b.sales !== null && b.sales !== undefined ? b.sales : 0;
      return salesB - salesA;
    });
    const displayCompanies = sortedCompanies.slice(0, 30);
    const tableRows = [];

    // Cell margin
    const cellMargin = [0, 0.04, 0, 0.04];

    // Border styles (3pt white solid for header rows)
    const solidWhiteBorder = { type: 'solid', pt: 3, color: COLORS.white };
    // Dashed border for horizontal lines between data rows
    const dashBorder = { type: 'dash', pt: 1, color: 'BFBFBF' };
    // 2.5pt white solid for data row vertical borders (visually hidden against white background)
    const dataVerticalBorder = { type: 'solid', pt: 2.5, color: COLORS.white };
    const noBorder = { type: 'none' };

    // Row 1 style: DARK BLUE with solid white borders - font 14
    const row1DarkStyle = {
      fill: COLORS.darkBlue,
      color: COLORS.white,
      fontFace: 'Segoe UI',
      fontSize: 14,
      bold: false,
      valign: 'middle',
      align: 'center',
      margin: cellMargin,
      border: solidWhiteBorder
    };

    // Row 1 empty cells (white background) with solid white borders - font 14
    const row1EmptyStyle = {
      fill: COLORS.white,
      color: COLORS.black,
      fontFace: 'Segoe UI',
      fontSize: 14,
      valign: 'middle',
      margin: cellMargin,
      border: solidWhiteBorder
    };

    // Row 2 style: LIGHT BLUE with WHITE text, font 14, center aligned, solid white borders
    const row2Style = {
      fill: COLORS.lightBlue,
      color: COLORS.white,
      fontFace: 'Segoe UI',
      fontSize: 14,
      bold: false,
      valign: 'middle',
      align: 'center',
      margin: cellMargin,
      border: solidWhiteBorder
    };

    // Data row style - sysDash horizontal borders, white solid vertical borders (from YCP template)
    // Border order: [top, right, bottom, left]
    const dataStyle = {
      fill: COLORS.white,
      color: COLORS.black,
      fontFace: 'Segoe UI',
      fontSize: 14,
      valign: 'middle',
      margin: cellMargin,
      border: [dashBorder, dataVerticalBorder, dashBorder, dataVerticalBorder]
    };

    // Median "Median" label style - light blue with dash top and bottom borders
    const medianLabelStyle = {
      fill: COLORS.lightBlue,
      color: COLORS.white,
      fontFace: 'Segoe UI',
      fontSize: 14,
      bold: true,
      valign: 'middle',
      margin: cellMargin,
      border: [dashBorder, solidWhiteBorder, dashBorder, solidWhiteBorder]
    };

    // Median value cells - white background with dash top and bottom borders
    const medianValueStyle = {
      fill: COLORS.white,
      color: COLORS.black,
      fontFace: 'Segoe UI',
      fontSize: 14,
      bold: true,
      valign: 'middle',
      margin: cellMargin,
      border: [dashBorder, solidWhiteBorder, dashBorder, solidWhiteBorder]
    };

    // Median empty cells - NO borders (no lines from last company to Median)
    const medianEmptyStyle = {
      fill: COLORS.white,
      color: COLORS.black,
      fontFace: 'Segoe UI',
      fontSize: 14,
      valign: 'middle',
      margin: cellMargin,
      border: [noBorder, noBorder, noBorder, noBorder]
    };

    // Last data row style - sysDash border at bottom (line below last company), white solid vertical borders
    const lastDataStyle = {
      fill: COLORS.white,
      color: COLORS.black,
      fontFace: 'Segoe UI',
      fontSize: 14,
      valign: 'middle',
      margin: cellMargin,
      border: [dashBorder, dataVerticalBorder, dashBorder, dataVerticalBorder]
    };

    // === ROW 1: Dark blue merged headers ===
    tableRows.push([
      { text: '', options: { ...row1EmptyStyle } },
      { text: '', options: { ...row1EmptyStyle } },
      { text: 'Financial Information (USD M)', options: { ...row1DarkStyle, colspan: 5 } },
      { text: 'Multiples', options: { ...row1DarkStyle, colspan: 3 } }
    ]);

    // === ROW 2: Light blue column headers (all center aligned) ===
    tableRows.push([
      { text: 'Company Name', options: { ...row2Style } },
      { text: 'Country', options: { ...row2Style } },
      { text: 'Sales', options: { ...row2Style } },
      { text: 'Market Cap', options: { ...row2Style } },
      { text: 'EV', options: { ...row2Style } },
      { text: 'EBITDA', options: { ...row2Style } },
      { text: 'Net Margin', options: { ...row2Style } },
      { text: 'EV/ EBITDA', options: { ...row2Style } },
      { text: 'PER', options: { ...row2Style } },
      { text: 'PBR', options: { ...row2Style } }
    ]);

    // === DATA ROWS ===
    displayCompanies.forEach((c, idx) => {
      const peValue = c.peTTM !== null ? c.peTTM : c.peFY;
      const companyName = `${idx + 1}. ${cleanCompanyName(c.name)}`;
      const isLastRow = idx === displayCompanies.length - 1;
      const rowStyle = isLastRow ? lastDataStyle : dataStyle;

      tableRows.push([
        { text: companyName, options: { ...rowStyle, align: 'left' } },
        { text: String(c.country || '-'), options: { ...rowStyle, align: 'left' } },
        { text: formatFinNum(c.sales), options: { ...rowStyle, align: 'right' } },
        { text: formatFinNum(c.marketCap), options: { ...rowStyle, align: 'right' } },
        { text: formatFinNum(c.ev), options: { ...rowStyle, align: 'right' } },
        { text: formatFinNum(c.ebitda), options: { ...rowStyle, align: 'right' } },
        { text: formatPct(c.netMargin), options: { ...rowStyle, align: 'right' } },
        { text: formatMultipleX(c.evEbitda), options: { ...rowStyle, align: 'right' } },
        { text: formatMultipleX(peValue), options: { ...rowStyle, align: 'right' } },
        { text: formatMultipleX(c.pb), options: { ...rowStyle, align: 'right' } }
      ]);
    });

    // === MEDIAN ROW ===
    // Only the "Median" cell has light blue fill; values have white background
    const medianPE = medians.peTTM !== null ? medians.peTTM : medians.peFY;
    tableRows.push([
      { text: '', options: { ...medianEmptyStyle } },
      { text: '', options: { ...medianEmptyStyle } },
      { text: '', options: { ...medianEmptyStyle } },
      { text: '', options: { ...medianEmptyStyle } },
      { text: '', options: { ...medianEmptyStyle } },
      { text: '', options: { ...medianEmptyStyle } },
      { text: 'Median', options: { ...medianLabelStyle, align: 'center' } },
      { text: formatMultipleX(medians.evEbitda), options: { ...medianValueStyle, align: 'right' } },
      { text: formatMultipleX(medianPE), options: { ...medianValueStyle, align: 'right' } },
      { text: formatMultipleX(medians.pb), options: { ...medianValueStyle, align: 'right' } }
    ]);

    // Calculate dimensions (from reference PPTX)
    const numRows = displayCompanies.length + 3;
    const availableHeight = 5.2;
    const rowHeight = Math.min(0.179, availableHeight / numRows); // Reference: 0.179" per row

    // Column widths from reference PPTX (total: 12.59")
    // Col 1: 2.42", Col 2: 1.31", Cols 3-10: 1.11" each
    const colWidths = [2.42, 1.31, 1.11, 1.11, 1.11, 1.11, 1.11, 1.11, 1.11, 1.11];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0); // 12.59"

    // Add TABLE to slide (position from reference: x=0.38", y=1.47")
    // Cell-level borders are set in each cell style
    slide.addTable(tableRows, {
      x: 0.38,
      y: 1.47,
      w: tableWidth,
      fontSize: 14,
      fontFace: 'Segoe UI',
      colW: colWidths,
      rowH: rowHeight
    });

    // ===== FOOTER =====
    const footerY = 6.66;
    slide.addText('Note: EV (Enterprise Value)', {
      x: 0.38, y: footerY, w: 4, h: 0.18,
      fontSize: 9, fontFace: 'Segoe UI', color: COLORS.black
    });
    const dataDate = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    slide.addText(`Data as of ${dataDate}`, {
      x: 0.38, y: footerY + 0.18, w: 4, h: 0.18,
      fontSize: 9, fontFace: 'Segoe UI', color: COLORS.black
    });
    slide.addText('Source: Speeda', {
      x: 0.38, y: footerY + 0.36, w: 4, h: 0.18,
      fontSize: 9, fontFace: 'Segoe UI', color: COLORS.black
    });

    // ===== FOOTER LINE (from slideLayout1: y=7.24", width 2.25pt) =====
    slide.addShape(pptx.shapes.LINE, {
      x: 0, y: 7.24, w: 13.333, h: 0,
      line: { color: COLORS.navyLine, width: 2.25 }
    });

    // ===== YCP LOGO (from slideLayout1: x=0.38", y=7.30") =====
    // Logo image stored in backend folder
    try {
      const logoPath = path.join(__dirname, 'ycp-logo.png');
      const logoExists = require('fs').existsSync(logoPath);
      if (logoExists) {
        slide.addImage({
          path: logoPath,
          x: 0.38, y: 7.30, w: 0.47, h: 0.17
        });
      }
    } catch (e) {
      console.log('Logo not found, skipping');
    }

    // ===== FOOTER COPYRIGHT (from slideLayout1: center, y=7.26") =====
    slide.addText('(C) YCP 2025 all rights reserved', {
      x: 4.1, y: 7.26, w: 5.1, h: 0.20,
      fontSize: 8, fontFace: 'Segoe UI', color: COLORS.gray, align: 'center'
    });

    // ===== PAGE NUMBER =====
    slide.addText('1', {
      x: 12.5, y: 7.26, w: 0.5, h: 0.20,
      fontSize: 10, fontFace: 'Segoe UI', color: COLORS.black, align: 'right'
    });

    // Generate PPT buffer
    const pptBuffer = await pptx.write({ outputType: 'base64' });

    // Send email with Excel and PPT attachments
    const validationSection = validationResult ? `
<h3 style="color: #1e3a5f;">AI Validation</h3>
<p style="color: #374151;">
  <strong>Assessment:</strong> ${validationResult.overallAssessment || 'N/A'}
  (Coherence: ${validationResult.coherenceScore || 'N/A'}%)<br>
  <strong>Verdict:</strong> ${validationResult.finalVerdict || 'Analysis complete'}
</p>
${validationResult.issues?.length > 0 ? `
<p style="color: #d97706; font-size: 12px;">
  <strong>Notes:</strong> ${validationResult.issues.map(i => i.company + ' - ' + i.issue).join('; ')}
</p>` : ''}
` : '';

    const emailHTML = `
<h2 style="color: #1e3a5f;">Trading Comparable Analysis – ${TargetCompanyOrIndustry}</h2>
<p style="color: #374151;">Please find attached the Excel file and PowerPoint slide with your trading comparable analysis.</p>

<h3 style="color: #1e3a5f;">Filter Summary</h3>
<ul style="color: #374151;">
  <li>Started with: ${allCompanies.length} companies</li>
  ${filterLog.map(f => `<li>${f}</li>`).join('\n')}
  <li><strong>Final shortlist: ${finalCompanies.length} companies</strong></li>
</ul>

${validationSection}

<h3 style="color: #1e3a5f;">Median Multiples</h3>
<table border="1" cellpadding="8" style="border-collapse: collapse;">
  <tr style="background-color: #1e3a5f; color: white;">
    <th>EV/EBITDA</th>
    <th>P/E (TTM)</th>
    <th>P/E (FY)</th>
    <th>P/BV</th>
  </tr>
  <tr style="text-align: center;">
    <td>${formatMultiple(medians.evEbitda)}</td>
    <td>${formatMultiple(medians.peTTM)}</td>
    <td>${formatMultiple(medians.peFY)}</td>
    <td>${formatMultiple(medians.pb)}</td>
  </tr>
</table>

<p style="font-size: 12px; color: #6b7280; margin-top: 20px;">
<strong>Attachments:</strong><br>
• Excel file - contains multiple sheets showing each filtering step<br>
• PowerPoint slide - summary view for presentations<br>
<br>
Data as of ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}<br>
Source: Speeda
</p>
`;

    const sanitizedName = TargetCompanyOrIndustry.replace(/[^a-zA-Z0-9]/g, '_');
    await sendEmail(
      Email,
      `Trading Comps: ${TargetCompanyOrIndustry} - ${finalCompanies.length} peers`,
      emailHTML,
      [
        {
          content: excelBuffer,
          name: `Trading_Comparable_${sanitizedName}.xlsx`
        },
        {
          content: pptBuffer,
          name: `Trading_Comparable_${sanitizedName}.pptx`
        }
      ]
    );

    console.log(`\n${'='.repeat(50)}`);
    console.log(`TRADING COMPARABLE COMPLETE! Email sent to ${Email}`);
    console.log(`Original: ${allCompanies.length} → Final: ${finalCompanies.length} companies`);
    console.log(`Median EV/EBITDA: ${medians.evEbitda}, P/E TTM: ${medians.peTTM}, P/B: ${medians.pb}`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Trading comparable error:', error);
    try {
      await sendEmail(Email, 'Trading Comparable - Error', `<p>Error processing your request: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

// ============ WRITE LIKE ANIL ============

const ANIL_SYSTEM_PROMPT = `You are helping users write emails in Anil's professional style.

CONSTRAINTS:
- Tone: polite, formal, concise, tactfully assertive; client-first; no hype.
- Structure: greeting; 1-line context; purpose in line 1–2; facts (numbers/dates/acronyms); explicit ask; next step; polite close; sign-off "Best Regards," (NO name after - user will add their own).
- Diction: prefer "Well noted.", "Do let me know…", "Happy to…", "We will keep you informed…"
- BANNED words: "excited", "super", "thrilled", vague time ("soon", "ASAP", "at the earliest"), emotive over-apologies.
- IMPORTANT: Do NOT invent specific dates, times, or deadlines. Only include dates/times if they were provided in the user's input. If no date given, use phrases like "at your earliest convenience" or leave the timing open.
- Honorifics by region (e.g., "-san" for Japanese, "Dato" for Malaysian); short paragraphs with blank lines; numbered lists for terms.
- When dates ARE provided: use absolute format + TZ (e.g., 09 Jan 2026, 14:00 SGT). Currencies spaced (USD 12m). Multiples like "7x EBITDA". FY labels (FY25).

SUBJECT LINE PATTERNS:
- Intro: {A} ↔ {B} — {topic}
- {Deal/Company}: NDA + IM
- {Project}: NBO status
- Correction: aligned IM on {topic}
- {Company}: exclusivity terms
- Meeting: {topic}

EXAMPLE STYLE (note the structure and tone):

Dear Martin,

As discussed, we have received two NBOs for Nimbus:
1) NorthBridge: 0.9x FY25 Revenue; exclusivity 30 days; breakup fee USD 0.5m.
2) Helios: 1.0x FY25 Revenue; exclusivity 21 days; no breakup fee.

We suggest holding to at least 1.0x FY25 Revenue and requiring a modest breakup fee to avoid creep downwards.

Do let me know if you prefer to invite management interviews before revisions.

Thank you.

Best Regards,

OUTPUT FORMAT:
- First line: Subject: [subject line]
- Then blank line
- Then email body
- End with "Best Regards," (no name - user adds their own signature)`;

app.post('/api/write-like-anil', async (req, res) => {
  console.log('\n' + '='.repeat(50));
  console.log('WRITE LIKE ANIL REQUEST');
  console.log('='.repeat(50));

  const { mode, prompt, context, draft, notes } = req.body;

  let userMessage = '';

  if (mode === 'generate') {
    userMessage = `Generate a professional email for the following request:

REQUEST: ${prompt}

${context ? `ADDITIONAL CONTEXT: ${context}` : ''}

Write the email in Anil's style. Include a suggested subject line.`;
  } else if (mode === 'rewrite') {
    userMessage = `Rewrite the following email draft in Anil's style:

ORIGINAL DRAFT:
${draft}

${notes ? `REWRITE INSTRUCTIONS: ${notes}` : ''}

Maintain the core message but apply Anil's tone, structure, and conventions. Include a suggested subject line.`;
  } else {
    return res.status(400).json({ error: 'Invalid mode. Use "generate" or "rewrite".' });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: ANIL_SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3
    });

    const email = response.choices[0].message.content || '';
    console.log('Generated email:', email.substring(0, 200) + '...');

    res.json({ email });
  } catch (error) {
    console.error('Write Like Anil error:', error);
    res.status(500).json({ error: 'Failed to generate email' });
  }
});

// ============ PROFILE SLIDES ============

// Country to flag code mapping
const COUNTRY_FLAG_MAP = {
  'philippines': 'PH', 'ph': 'PH', 'manila': 'PH',
  'thailand': 'TH', 'th': 'TH', 'bangkok': 'TH',
  'malaysia': 'MY', 'my': 'MY', 'kuala lumpur': 'MY',
  'indonesia': 'ID', 'id': 'ID', 'jakarta': 'ID',
  'singapore': 'SG', 'sg': 'SG',
  'vietnam': 'VN', 'vn': 'VN', 'ho chi minh': 'VN', 'hanoi': 'VN',
  'japan': 'JP', 'jp': 'JP', 'tokyo': 'JP',
  'china': 'CN', 'cn': 'CN', 'beijing': 'CN', 'shanghai': 'CN',
  'korea': 'KR', 'kr': 'KR', 'seoul': 'KR',
  'taiwan': 'TW', 'tw': 'TW', 'taipei': 'TW',
  'usa': 'US', 'us': 'US', 'united states': 'US', 'america': 'US',
  'uk': 'GB', 'united kingdom': 'GB', 'england': 'GB', 'london': 'GB',
  'australia': 'AU', 'au': 'AU', 'sydney': 'AU',
  'india': 'IN', 'in': 'IN', 'mumbai': 'IN', 'delhi': 'IN',
  'hong kong': 'HK', 'hk': 'HK'
};

// Common shortform definitions
const SHORTFORM_DEFINITIONS = {
  'HQ': 'Headquarters',
  'SEA': 'Southeast Asia',
  'THB': 'Thai Baht',
  'PHP': 'Philippine Peso',
  'MYR': 'Malaysian Ringgit',
  'IDR': 'Indonesian Rupiah',
  'SGD': 'Singapore Dollar',
  'VND': 'Vietnamese Dong',
  'USD': 'US Dollar',
  'JPY': 'Japanese Yen',
  'CNY': 'Chinese Yuan',
  'KRW': 'Korean Won',
  'TWD': 'Taiwan Dollar',
  'INR': 'Indian Rupee',
  'HKD': 'Hong Kong Dollar',
  'AUD': 'Australian Dollar',
  'GBP': 'British Pound',
  'EUR': 'Euro',
  'ISO': 'International Organization for Standardization',
  'B2B': 'Business to Business',
  'B2C': 'Business to Consumer',
  'R&D': 'Research and Development',
  'OEM': 'Original Equipment Manufacturer',
  'ODM': 'Original Design Manufacturer',
  'SME': 'Small and Medium Enterprise',
  'CAGR': 'Compound Annual Growth Rate',
  'YoY': 'Year over Year',
  'QoQ': 'Quarter over Quarter',
  'FY': 'Fiscal Year',
  'M': 'Million',
  'B': 'Billion',
  'K': 'Thousand',
  'DBD': 'Department of Business Development',
  'EBITDA': 'Earnings Before Interest, Taxes, Depreciation and Amortization',
  'ROE': 'Return on Equity',
  'ROI': 'Return on Investment',
  'GM': 'Gross Margin',
  'NM': 'Net Margin',
  'JV': 'Joint Venture',
  'M&A': 'Mergers and Acquisitions',
  'IPO': 'Initial Public Offering',
  'CEO': 'Chief Executive Officer',
  'CFO': 'Chief Financial Officer',
  'COO': 'Chief Operating Officer',
  'HoHo': 'Ho Chi Minh City',
  'KL': 'Kuala Lumpur',
  'BKK': 'Bangkok',
  'JKT': 'Jakarta',
  'MNL': 'Manila',
  'SG': 'Singapore'
};

// Exchange rate mapping by country (for footnote)
const EXCHANGE_RATE_MAP = {
  'PH': '為替レート: PHP 100M = 3億円',
  'TH': '為替レート: THB 100M = 4億円',
  'MY': '為替レート: MYR 10M = 3億円',
  'ID': '為替レート: IDR 100B = 10億円',
  'SG': '為替レート: SGD 1M = 1億円',
  'VN': '為替レート: VND 100B = 6億円',
  'JP': '',
  'CN': '為替レート: CNY 10M = 2億円',
  'KR': '為替レート: KRW 1B = 1億円',
  'TW': '為替レート: TWD 10M = 0.5億円',
  'US': '為替レート: USD 1M = 1.5億円',
  'GB': '為替レート: GBP 1M = 2億円',
  'AU': '為替レート: AUD 1M = 1億円',
  'IN': '為替レート: INR 100M = 2億円',
  'HK': '為替レート: HKD 10M = 2億円'
};

// Get country code from location string
function getCountryCode(location) {
  if (!location) return null;
  const loc = location.toLowerCase();
  for (const [key, code] of Object.entries(COUNTRY_FLAG_MAP)) {
    if (loc.includes(key)) return code;
  }
  return null;
}

// Common shortforms that don't need explanation
const COMMON_SHORTFORMS = [
  'M', 'B', 'K',           // Million, Billion, Thousand
  'HQ',                    // Headquarters
  'CEO', 'CFO', 'COO',     // C-suite titles
  // All currency codes - well known
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'KRW', 'TWD',
  'IDR', 'SGD', 'MYR', 'THB', 'PHP', 'VND', 'INR', 'HKD', 'AUD',
  'ISO',                   // Well-known standard
  'FY',                    // Fiscal Year
  'YoY', 'QoQ',            // Year over Year, Quarter over Quarter
  'B2B', 'B2C'             // Business models
];

// Detect shortforms in text and return formatted note (only uncommon ones)
function detectShortforms(companyData) {
  // Collect all text including key_metrics array
  const textParts = [
    companyData.company_name,
    companyData.location,
    companyData.business,
    companyData.metrics,
    companyData.footnote
  ];

  // Also include key_metrics array values
  if (companyData.key_metrics && Array.isArray(companyData.key_metrics)) {
    companyData.key_metrics.forEach(metric => {
      if (metric.label) textParts.push(metric.label);
      if (metric.value) textParts.push(metric.value);
    });
  }

  // Also include breakdown_items
  if (companyData.breakdown_items && Array.isArray(companyData.breakdown_items)) {
    companyData.breakdown_items.forEach(item => {
      if (item.label) textParts.push(item.label);
      if (item.value) textParts.push(item.value);
    });
  }

  const allText = textParts.filter(Boolean).join(' ');

  const foundShortforms = [];

  for (const [shortform, definition] of Object.entries(SHORTFORM_DEFINITIONS)) {
    // Skip common shortforms that don't need explanation
    if (COMMON_SHORTFORMS.includes(shortform)) continue;

    // Match shortform as whole word (with word boundaries)
    const regex = new RegExp(`\\b${shortform}\\b`, 'i');
    if (regex.test(allText)) {
      foundShortforms.push(`${shortform} (${definition})`);
    }
  }

  if (foundShortforms.length > 0) {
    return 'Note: ' + foundShortforms.join(', ');
  }
  return null;
}

// Fetch image as base64
async function fetchImageAsBase64(url) {
  try {
    const response = await fetch(url, { timeout: 5000 });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  } catch (e) {
    console.log('Failed to fetch image:', url);
    return null;
  }
}

// Generate PPTX using PptxGenJS - matching YCP template
async function generatePPTX(companies) {
  try {
    console.log('Generating PPTX with PptxGenJS...');

    const pptx = new pptxgen();
    pptx.author = 'YCP';
    pptx.title = 'Company Profile Slides';
    pptx.subject = 'Company Profiles';

    // Set exact slide size to match template (13.333" x 7.5" = 16:9 widescreen)
    pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
    pptx.layout = 'YCP';

    // YCP Theme Colors (from template)
    const COLORS = {
      headerLine: '293F55',    // Dark navy for header/footer lines
      accent3: '011AB7',       // Dark blue - label column background
      white: 'FFFFFF',
      black: '000000',
      gray: 'BFBFBF',          // Dashed border color
      dk2: '1F497D',           // Section underline color
      footerText: '808080'     // Gray footer text
    };

    for (const company of companies) {
      const slide = pptx.addSlide();

      // ===== HEADER LINES (from template) =====
      // Thick line under title area
      slide.addShape(pptx.shapes.LINE, {
        x: 0, y: 1.02, w: 13.333, h: 0,
        line: { color: COLORS.headerLine, width: 4.5 }
      });
      // Thin line below
      slide.addShape(pptx.shapes.LINE, {
        x: 0, y: 1.10, w: 13.333, h: 0,
        line: { color: COLORS.headerLine, width: 2.25 }
      });

      // ===== FOOTER LINE =====
      slide.addShape(pptx.shapes.LINE, {
        x: 0, y: 7.24, w: 13.333, h: 0,
        line: { color: COLORS.headerLine, width: 2.25 }
      });

      // ===== TITLE + MESSAGE (combined in one text box) =====
      const titleText = company.title || company.company_name || 'Company Profile';
      const messageText = company.message || '';

      // Create combined text with title (font 24) and message (font 16)
      const titleContent = messageText ? [
        { text: titleText, options: { fontSize: 24, fontFace: 'Segoe UI', color: COLORS.black, breakLine: true } },
        { text: messageText, options: { fontSize: 16, fontFace: 'Segoe UI', color: COLORS.black } }
      ] : titleText;

      slide.addText(titleContent, {
        x: 0.38, y: 0.07, w: 9.5, h: 0.9,
        fontSize: 24, fontFace: 'Segoe UI',
        color: COLORS.black, valign: 'bottom',
        margin: [0, 0, 0, 0]  // No left/right margin
      });

      // ===== FLAG (top right) =====
      const countryCode = getCountryCode(company.location);
      if (countryCode) {
        try {
          const flagUrl = `https://flagcdn.com/w80/${countryCode.toLowerCase()}.png`;
          const flagBase64 = await fetchImageAsBase64(flagUrl);
          if (flagBase64) {
            slide.addImage({
              data: `data:image/png;base64,${flagBase64}`,
              x: 10.64, y: 0.22, w: 0.83, h: 0.55
            });
          }
        } catch (e) {
          console.log('Flag fetch failed for', countryCode);
        }
      }

      // ===== LOGO (top right of slide) =====
      if (company.website) {
        try {
          const domain = company.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

          // Try multiple logo sources
          const logoSources = [
            `https://logo.clearbit.com/${domain}`,
            `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
            `https://icon.horse/icon/${domain}`
          ];

          let logoBase64 = null;
          for (const logoUrl of logoSources) {
            console.log(`  Trying logo from: ${logoUrl}`);
            logoBase64 = await fetchImageAsBase64(logoUrl);
            if (logoBase64) {
              console.log(`  Logo fetched successfully from ${logoUrl}`);
              break;
            }
          }

          if (logoBase64) {
            // Use square container to prevent stretching (logos are typically square)
            slide.addImage({
              data: `data:image/png;base64,${logoBase64}`,
              x: 12.1, y: 0.12, w: 0.7, h: 0.7,
              sizing: { type: 'contain', w: 0.7, h: 0.7 }
            });
          } else {
            console.log(`  Logo not available for ${domain} from any source`);
          }
        } catch (e) {
          console.log('Logo fetch failed for', company.website, e.message);
        }
      }

      // ===== SECTION HEADERS =====
      // Left: "会社概要資料" - positioned per ref v4
      slide.addText('会社概要資料', {
        x: 0.37, y: 1.37, w: 6.1, h: 0.35,
        fontSize: 14, fontFace: 'Segoe UI',
        color: COLORS.black, align: 'center'
      });
      slide.addShape(pptx.shapes.LINE, {
        x: 0.37, y: 1.79, w: 6.1, h: 0,
        line: { color: COLORS.dk2, width: 1.75 }
      });

      // Right: Dynamic title based on breakdown_title - positioned at 6.86" x 1.37"
      const rightSectionTitle = company.breakdown_title || 'Products and Applications';
      slide.addText(rightSectionTitle, {
        x: 6.86, y: 1.37, w: 6.1, h: 0.35,
        fontSize: 14, fontFace: 'Segoe UI',
        color: COLORS.black, align: 'center'
      });
      slide.addShape(pptx.shapes.LINE, {
        x: 6.86, y: 1.79, w: 6.1, h: 0,
        line: { color: COLORS.dk2, width: 1.75 }
      });

      // ===== LEFT TABLE (会社概要資料) =====
      // Determine if single location (for HQ label)
      const locationText = company.location || '';
      const locationLines = locationText.split('\n').filter(line => line.trim());
      const isSingleLocation = locationLines.length <= 1 && !locationText.toLowerCase().includes('branch') && !locationText.toLowerCase().includes('factory') && !locationText.toLowerCase().includes('warehouse');
      const locationLabel = isSingleLocation ? 'HQ' : 'Location';

      // Helper function to check if value is empty or "not specified"
      const isEmptyValue = (val) => {
        if (!val) return true;
        const lower = val.toLowerCase().trim();
        return lower === '' || lower === 'not specified' || lower === 'n/a' || lower === 'unknown' || lower === 'not available' || lower === 'not found';
      };

      // Base company info rows - only add if value exists
      const tableData = [];

      // Always add Name with hyperlink
      if (!isEmptyValue(company.company_name)) {
        tableData.push(['Name', company.company_name, company.website || null]);
      }

      // Add Est. Year if available
      if (!isEmptyValue(company.established_year)) {
        tableData.push(['Est. Year', company.established_year, null]);
      }

      // Add Location if available
      if (!isEmptyValue(company.location)) {
        tableData.push([locationLabel, company.location, null]);
      }

      // Add Business if available
      if (!isEmptyValue(company.business)) {
        tableData.push(['Business', company.business, null]);
      }

      // Track existing labels to prevent duplicates
      const existingLabels = new Set(tableData.map(row => row[0].toLowerCase()));

      // Add key metrics as separate rows if available (skip duplicates and empty values)
      if (company.key_metrics && Array.isArray(company.key_metrics)) {
        company.key_metrics.forEach(metric => {
          if (metric.label && metric.value && !isEmptyValue(metric.value)) {
            const labelLower = metric.label.toLowerCase();
            // Skip if this label already exists or is duplicate of business/location
            if (!existingLabels.has(labelLower) &&
                !labelLower.includes('business') &&
                !labelLower.includes('location') &&
                !labelLower.includes('product') &&
                !labelLower.includes('service')) {
              tableData.push([metric.label, metric.value, null]);
              existingLabels.add(labelLower);
            }
          }
        });
      } else if (company.metrics && !isEmptyValue(company.metrics)) {
        // Fallback for old format (single string)
        tableData.push(['Key Metrics', company.metrics, null]);
      }

      // Helper function to format cell text with proper PowerPoint bullets
      const formatCellText = (text) => {
        if (!text || typeof text !== 'string') return text;

        // Check if text contains bullet points (■, -, or •)
        if (text.includes('■') || text.includes('\n-') || text.startsWith('-')) {
          // Split by newline and filter out empty lines
          const lines = text.split('\n').filter(line => line.trim());

          // Convert to array of text objects with bullet formatting
          return lines.map((line, index) => {
            const cleanLine = line.replace(/^[■\-•]\s*/, '').trim();
            return {
              text: cleanLine + (index < lines.length - 1 ? '\n' : ''),
              options: { bullet: true }
            };
          });
        }
        return text;
      };

      const rows = tableData.map((row) => {
        const valueCell = {
          text: formatCellText(row[1]),
          options: {
            fill: { color: COLORS.white },
            color: COLORS.black,
            align: 'left',
            border: [
              { pt: 1, color: COLORS.gray, type: 'dash' },
              { pt: 0 },
              { pt: 1, color: COLORS.gray, type: 'dash' },
              { pt: 0 }
            ]
          }
        };

        // Add hyperlink if URL is provided (third element in row array)
        if (row[2]) {
          valueCell.options.hyperlink = { url: row[2], tooltip: 'Visit company website' };
          valueCell.options.color = '0563C1'; // Blue hyperlink color
        }

        return [
          {
            text: row[0],
            options: {
              fill: { color: COLORS.accent3 },
              color: COLORS.white,
              align: 'center',
              bold: false
            }
          },
          valueCell
        ];
      });

      const tableStartY = 1.85;
      const rowHeight = 0.35;

      slide.addTable(rows, {
        x: 0.37, y: tableStartY,
        w: 6.1,
        colW: [1.4, 4.7],
        rowH: rowHeight,
        fontFace: 'Segoe UI',
        fontSize: 14,
        valign: 'middle',
        border: { pt: 2.5, color: COLORS.white },
        margin: [0, 0.04, 0, 0.04]
      });

      // ===== RIGHT SECTION (Products/Applications breakdown) =====
      // Filter valid breakdown items (non-empty)
      const validBreakdownItems = (company.breakdown_items || []).filter(item =>
        item.label && item.value && !isEmptyValue(item.label) && !isEmptyValue(item.value)
      );

      // If at least 2 valid items, use table format; otherwise use text box
      if (validBreakdownItems.length >= 2) {
        // Use table format
        const rightTableData = validBreakdownItems.map(item => [item.label, item.value]);

        const rightRows = rightTableData.map((row) => [
          {
            text: row[0],
            options: {
              fill: { color: COLORS.accent3 },
              color: COLORS.white,
              align: 'center',
              bold: false
            }
          },
          {
            text: row[1],
            options: {
              fill: { color: COLORS.white },
              color: COLORS.black,
              align: 'left',
              border: [
                { pt: 1, color: COLORS.gray, type: 'dash' },
                { pt: 0 },
                { pt: 1, color: COLORS.gray, type: 'dash' },
                { pt: 0 }
              ]
            }
          }
        ]);

        // Position at 6.86" horizontally and 1.91" vertically as requested
        slide.addTable(rightRows, {
          x: 6.86, y: 1.91,
          w: 6.1,
          colW: [1.4, 4.7],
          rowH: rowHeight,
          fontFace: 'Segoe UI',
          fontSize: 14,
          valign: 'middle',
          border: { pt: 2.5, color: COLORS.white },
          margin: [0, 0.04, 0, 0.04]
        });
      } else if (validBreakdownItems.length > 0) {
        // Use text box with point form format: "Segment: A, B, C"
        const textContent = validBreakdownItems.map(item => `${item.label}: ${item.value}`).join('\n');

        slide.addText(textContent, {
          x: 6.86, y: 1.91, w: 6.1, h: 2.0,
          fontSize: 14, fontFace: 'Segoe UI',
          color: COLORS.black, valign: 'top',
          margin: [0, 0, 0, 0]
        });
      }
      // If no valid items, don't add anything to the right section

      // ===== FOOTNOTE (single text box with stacked content) =====
      const footnoteLines = [];

      // Line 1: Note with shortform explanations (only uncommon ones)
      const shortformNote = detectShortforms(company);
      if (shortformNote) {
        footnoteLines.push(shortformNote);
      }

      // Line 2: Exchange rate - always add for countries with pre-set rates (especially SEA)
      const exchangeRate = countryCode ? EXCHANGE_RATE_MAP[countryCode] : null;
      if (exchangeRate) {
        footnoteLines.push(exchangeRate);
      }

      // Line 3: Source
      footnoteLines.push('Source: Company website');

      // Create single text box with all footnote content stacked
      const footnoteContent = footnoteLines.join('\n');
      const footnoteHeight = 0.18 * footnoteLines.length;

      slide.addText(footnoteContent, {
        x: 0.38, y: 6.85, w: 12.5, h: footnoteHeight,
        fontSize: 10, fontFace: 'Segoe UI',
        color: COLORS.black, valign: 'top',
        margin: [0, 0, 0, 0]  // No left/right margin
      });
    }

    // Generate base64
    const base64Content = await pptx.write({ outputType: 'base64' });

    console.log('PPTX generated successfully');

    return {
      success: true,
      content: base64Content
    };
  } catch (error) {
    console.error('PptxGenJS error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Currency exchange mapping by country
const CURRENCY_EXCHANGE = {
  'philippines': '為替レート: PHP 100M = 3億円',
  'thailand': '為替レート: THB 100M = 4億円',
  'malaysia': '為替レート: MYR 10M = 3億円',
  'indonesia': '為替レート: IDR 10B = 1億円',
  'singapore': '為替レート: SGD 1M = 1億円',
  'vietnam': '為替レート: VND 100B = 6億円'
};

// Scrape website and convert to clean text (similar to fetchWebsite but returns more content)
async function scrapeWebsite(url) {
  try {
    // Normalize URL
    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const html = await response.text();

    // Clean HTML to readable text (similar to n8n's markdownify)
    const cleanText = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanText.length < 100) {
      return { success: false, error: 'Insufficient content' };
    }

    return { success: true, content: cleanText.substring(0, 25000), url };
  } catch (e) {
    return { success: false, error: e.message || 'Connection failed' };
  }
}

// AI Agent 1: Extract company name, established year, location
async function extractBasicInfo(scrapedContent, websiteUrl) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You extract company information from website content.

OUTPUT JSON with these fields:
- company_name: Company name with first letter of each word capitalized
- established_year: Clean numbers only (e.g., "1995"), leave empty if not found
- location: Format locations 3 levels deep: "District/Area, City/State, Country"
  Examples:
  - "Puchong, Selangor, Malaysia"
  - "Bangna, Bangkok, Thailand"
  - "Batam, Riau Islands, Indonesia"
  EXCEPTION: For Singapore, just use "Singapore" (single location) or include the area like "Jurong, Singapore"

  For multiple locations, group by type with sub-bullet points:
  Example format:
  "- HQ: Puchong, Selangor, Malaysia
  - Factories:
    - Batam, Riau Islands, Indonesia
    - Rayong, Thailand
  - Branches:
    - Ho Chi Minh City, Vietnam
    - Jakarta, Indonesia
    - Manila, Philippines"

  IMPORTANT: When multiple locations of same type (e.g., 3 branches), group under one header with sub-bullets. Don't repeat "Branch 1:", "Branch 2:" etc.
  Types: HQ, Warehouses, Factories, Branches, Offices. No postcodes or full addresses.

RULES:
- Write ALL text using regular English alphabet only (no diacritics/accents)
- Convert foreign characters: "Việt Nam" → "Vietnam", "São Paulo" → "Sao Paulo", "北京" → "Beijing"
- Leave fields empty if information not found
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Website: ${websiteUrl}
Content: ${scrapedContent.substring(0, 12000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 1 error:', e.message);
    return { company_name: '', established_year: '', location: '' };
  }
}

// AI Agent 2: Extract business, message, footnote, title
async function extractBusinessInfo(scrapedContent, basicInfo) {
  const locationText = basicInfo.location || '';
  const hqMatch = locationText.match(/HQ:\s*([^,\n]+),\s*([^\n]+)/i);
  const hqCountry = hqMatch ? hqMatch[2].trim().toLowerCase() : '';
  const currencyExchange = CURRENCY_EXCHANGE[hqCountry] || '';

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You extract business information from website content for M&A discussion slides.

INPUT:
- HTML content from company website
- Previously extracted: company name, year, location

OUTPUT JSON:
1. business: Description of what company does. MAXIMUM 3 bullet points. Format each business line starting with "- ".

   FORMAT REQUIREMENT: Use this structure:
   - "Manufacture [category] such as [top 3 products]"
   - "Distribute [category] such as [top 3 products]"
   - "Provide [service type] such as [top 3 services]"

   Examples:
   "- Manufacture industrial chemicals such as adhesives, solvents, coatings\\n- Distribute automotive products such as lubricants, filters, batteries\\n- Provide technical services such as installation, maintenance, training"

   Keep it to the MOST KEY items only (3 bullet points max, 3 examples per bullet).

2. message: One-liner introductory message about the company. Example: "Malaysia-based distributor specializing in electronic components and industrial automation products across Southeast Asia."

3. footnote: Two parts:
   - Notes (optional): If unusual shortforms used, write full-form like "SKU (Stock Keeping Unit)". Separate multiple with comma.
   - Currency: ${currencyExchange || 'Leave empty if no matching currency'}
   Separate notes and currency with semicolon. Always end with new line: "出典: 会社ウェブサイト、SPEEDA"

4. title: Company name WITHOUT suffix (remove Pte Ltd, Sdn Bhd, Co Ltd, JSC, PT, Inc, etc.)

RULES:
- Write ALL text using regular English alphabet only (no diacritics/accents)
- Convert foreign characters: "Việt Nam" → "Vietnam", "São Paulo" → "Sao Paulo", "北京" → "Beijing"
- All bullet points must use "- " (dash followed by space)
- Each bullet point on new line using "\\n"
- Keep it to the MOST KEY items only (3 bullet points max)
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Company: ${basicInfo.company_name}
Established: ${basicInfo.established_year}
Location: ${basicInfo.location}

Website Content:
${scrapedContent.substring(0, 12000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 2 error:', e.message);
    return { business: '', message: '', footnote: '', title: basicInfo.company_name || '' };
  }
}

// AI Agent 3: Extract key metrics for M&A evaluation
async function extractKeyMetrics(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst extracting COMPREHENSIVE key business metrics for potential buyers evaluating this company.

EXTRACT AS MANY OF THESE METRICS AS POSSIBLE (aim for 8-15 metrics):

CUSTOMERS & MARKET:
- Number of customers (total active customers)
- Key customer names (notable clients)
- Customer segments served
- Market share or market position

SUPPLIERS & PARTNERSHIPS:
- Number of suppliers
- Key supplier/partner names
- Notable partnerships, JVs, technology transfers
- Exclusive distribution agreements

OPERATIONS & SCALE:
- Production capacity (units/month, tons/month)
- Factory/warehouse size (m², sq ft)
- Number of machines/equipment
- Number of employees/headcount
- Number of SKUs/products

GEOGRAPHIC REACH:
- Export countries (list regions/countries)
- Distribution network (number of distributors/partners)
- Number of branches/offices/locations
- Markets served

QUALITY & COMPLIANCE:
- Certifications (ISO, HACCP, GMP, FDA, CE, halal, etc.)
- Awards and recognitions
- Patents or proprietary technology

OUTPUT JSON:
{
  "key_metrics": [
    {"label": "Shareholding", "value": "Family owned (100%)"},
    {"label": "Key Metrics", "value": "- Production capacity of 800+ tons per month\\n- 250+ machines\\n- 300+ employees"},
    {"label": "Export Countries", "value": "SEA, South Asia, North Africa"},
    {"label": "Distribution Network", "value": "700 domestic distribution partners"},
    {"label": "Certification", "value": "ISO 9001, ISO 14001"},
    {"label": "Notable Partnerships", "value": "Launch partnership with Dainichiseika Color & Chemicals (Japanese) in 2009 technology transfer, joint product development and marketing"}
  ]
}

SEGMENTATION REQUIREMENT:
For metrics with MANY items (e.g., Customers, Suppliers), segment them by category using POINT FORM:
Example for Customers:
{"label": "Customers", "value": "- Residential: Customer1, Customer2, Customer3\\n- Commercial: Customer4, Customer5\\n- Industrial: Customer6, Customer7"}

Example for Suppliers:
{"label": "Suppliers", "value": "- Raw Materials: Supplier1, Supplier2\\n- Packaging: Supplier3, Supplier4\\n- Equipment: Supplier5"}

IMPORTANT: Always use "- " prefix for each segment line to create point form for easier reading.

RULES:
- Write ALL text using regular English alphabet only (no diacritics/accents)
- Convert foreign characters: "Việt Nam" → "Vietnam", "São Paulo" → "Sao Paulo", "北京" → "Beijing"
- Extract as many metrics as found (8-15 ideally)
- For metrics with multiple items, use "- " bullet points separated by "\\n"
- For long lists of customers/suppliers, SEGMENT by category as shown above
- Labels should be 1-3 words
- Be specific with numbers when available
- Include shareholding structure if mentioned
- NEVER make up data - only include what's explicitly stated
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Company: ${previousData.company_name}
Industry/Business: ${previousData.business}

Website Content (extract ALL M&A-relevant metrics):
${scrapedContent.substring(0, 18000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 3 error:', e.message);
    return { key_metrics: [] };
  }
}

// AI Agent 3b: Extract products/applications breakdown for right table
async function extractProductsBreakdown(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst extracting a breakdown of important information for the right-side table on a company profile slide.

DETERMINE THE BEST CATEGORY for this company's breakdown. Choose ONE of these:

1. "Products and Applications" - For manufacturers/producers (list product categories and their applications)
2. "Products and Services" - For companies offering both products and services
3. "Services" - For pure service companies (consulting, logistics, etc.)
4. "Customers" - When customer segmentation is the key differentiator
5. "Product Categories" - For distributors/retailers with product portfolio
6. "Business Segments" - For diversified companies with multiple business lines

OUTPUT JSON:
{
  "breakdown_title": "Products and Applications",
  "breakdown_items": [
    {"label": "Industrial", "value": "Lubricants, Adhesives, Solvents"},
    {"label": "Consumer", "value": "Cleaning products, Personal care"},
    {"label": "Automotive", "value": "Engine oils, Brake fluids, Coolants"}
  ]
}

RULES:
- Write ALL text using regular English alphabet only (no diacritics/accents)
- Convert foreign characters: "Việt Nam" → "Vietnam", "São Paulo" → "Sao Paulo", "北京" → "Beijing"
- Choose the breakdown category that best showcases the company's value proposition
- Use 3-6 items maximum
- Labels should be segment/category names (1-3 words)
- Values should be comma-separated examples (3-5 items each)
- For customers, segment by industry/type (e.g., "Residential", "Commercial", "Industrial")
- For products, segment by application/industry/type
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Company: ${previousData.company_name}
Industry/Business: ${previousData.business}

Website Content:
${scrapedContent.substring(0, 15000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 3b (products) error:', e.message);
    return { breakdown_title: 'Products and Applications', breakdown_items: [] };
  }
}

// AI Agent 3c: Extract financial metrics for 財務実績 section
async function extractFinancialMetrics(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst extracting financial performance metrics from website content.

Focus on financial metrics important for M&A evaluation:

PRIORITY FINANCIAL METRICS:
1. Revenue: Annual revenue, sales figures, turnover
2. Profit: Net profit, operating profit, EBITDA
3. Growth: Revenue growth rate, YoY growth
4. Employees: Number of employees, workforce size
5. Assets: Total assets, net assets
6. Capital: Registered capital, paid-up capital

OUTPUT JSON with this structure:
{
  "financial_metrics": [
    {"label": "Revenue", "value": "USD 50M (2023)"},
    {"label": "Net Profit", "value": "USD 5M"},
    {"label": "Growth Rate", "value": "15% YoY"},
    {"label": "Employees", "value": "500+"}
  ]
}

IMPORTANT RULES:
- Only extract financial data that is EXPLICITLY mentioned on the website
- Include currency and year if available
- If no financial data found, return empty array
- Maximum 4 financial metrics
- Do NOT make up financial figures

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: `Company: ${previousData.company_name}
Industry/Business: ${previousData.business}

Website Content (extract financial metrics):
${scrapedContent.substring(0, 15000)}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Agent 3b error:', e.message);
    return { financial_metrics: [] };
  }
}

// AI Agent 4: Search for missing company information (est year, location, HQ)
async function searchMissingInfo(companyName, website, missingFields) {
  if (!companyName || missingFields.length === 0) {
    return {};
  }

  try {
    console.log(`  Searching for missing info: ${missingFields.join(', ')}`);

    // Use OpenAI Search model which has web search capability
    const searchQuery = `${companyName} company ${missingFields.includes('established_year') ? 'founded year established' : ''} ${missingFields.includes('location') ? 'headquarters location country' : ''}`.trim();

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini-search-preview',
      messages: [
        {
          role: 'user',
          content: `Search for information about "${companyName}" (website: ${website}).

I need to find:
${missingFields.includes('established_year') ? '- When was this company founded/established? (year only)' : ''}
${missingFields.includes('location') ? '- Where is this company headquartered? (city, country)' : ''}

Return ONLY a JSON object with these fields (include only fields you can find with confidence):
{
  ${missingFields.includes('established_year') ? '"established_year": "YYYY",' : ''}
  ${missingFields.includes('location') ? '"location": "City, Country"' : ''}
}

If you cannot find reliable information for a field, omit it from the response.
Return ONLY valid JSON, no explanations.`
        }
      ]
    });

    const content = response.choices[0].message.content || '';

    // Try to parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      console.log(`  Found missing info:`, result);
      return result;
    }

    return {};
  } catch (e) {
    console.error('Agent 4 (search) error:', e.message);

    // Fallback to Perplexity if OpenAI search fails
    try {
      const perplexityPrompt = `What is the founding year and headquarters location of ${companyName} (${website})? Reply ONLY with JSON: {"established_year": "YYYY", "location": "City, Country"}`;
      const perplexityResponse = await callPerplexity(perplexityPrompt);

      const jsonMatch = perplexityResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        console.log(`  Found via Perplexity:`, result);
        return result;
      }
    } catch (pe) {
      console.error('Perplexity fallback error:', pe.message);
    }

    return {};
  }
}

// AI Agent 5: Search web for additional company metrics
async function searchAdditionalMetrics(companyName, website, existingMetrics) {
  if (!companyName) {
    return { additional_metrics: [] };
  }

  try {
    console.log(`  Step 6: Searching web for additional metrics...`);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini-search-preview',
      messages: [
        {
          role: 'user',
          content: `Search for detailed business information about "${companyName}" (website: ${website}).

I need M&A-relevant metrics for an acquisition discussion. Find:

1. COMPANY SCALE:
   - Number of employees/headcount
   - Revenue figures (annual revenue)
   - Number of retail stores, offices, branches
   - Market capitalization (if public)

2. OPERATIONS:
   - Number of products/SKUs
   - Production capacity
   - Factory/warehouse locations and sizes
   - Number of suppliers

3. CUSTOMERS & MARKET:
   - Number of customers
   - Key customer names or segments
   - Market share
   - Geographic markets served

4. CERTIFICATIONS & QUALITY:
   - ISO certifications
   - Industry-specific certifications
   - Awards

5. PARTNERSHIPS:
   - Key partnerships
   - Joint ventures
   - Major suppliers

Already have: ${existingMetrics.map(m => m.label).join(', ')}

Return ONLY a JSON object:
{
  "additional_metrics": [
    {"label": "Employees", "value": "164,000+ worldwide"},
    {"label": "Retail Stores", "value": "500+ stores globally"},
    {"label": "Revenue", "value": "USD 383B (2023)"}
  ]
}

Only include metrics you can verify. Do not repeat metrics already provided.
Return ONLY valid JSON.`
        }
      ]
    });

    const content = response.choices[0].message.content || '';

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      console.log(`  Found ${result.additional_metrics?.length || 0} additional metrics via web search`);
      return result;
    }

    return { additional_metrics: [] };
  } catch (e) {
    console.error('Agent 5 (additional metrics search) error:', e.message);
    return { additional_metrics: [] };
  }
}

// Build profile slides email HTML (simple version with PPTX attached)
function buildProfileSlidesEmailHTML(companies, errors, hasPPTX) {
  const companyNames = companies.map(c => c.title || c.company_name).join(', ');

  let html = `
    <h2>Profile Slides</h2>
    <p>Your profile slides have been generated.</p>
    <br>
    <p><strong>Companies Extracted:</strong> ${companies.length}</p>
    <p><strong>Companies:</strong> ${companyNames || 'N/A'}</p>
  `;

  if (hasPPTX) {
    html += `<br><p style="color: #16a34a;"><strong>✓ PowerPoint file attached.</strong></p>`;
  } else {
    html += `<br><p style="color: #dc2626;"><strong>⚠ PPTX generation failed. Data included below.</strong></p>`;

    // Include extracted data as fallback
    companies.forEach((c, i) => {
      html += `
        <div style="margin: 16px 0; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h4 style="margin: 0 0 8px 0;">${i + 1}. ${c.title || c.company_name || 'Unknown'}</h4>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Website:</strong> ${c.website}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Established:</strong> ${c.established_year || '-'}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Location:</strong> ${c.location || '-'}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Business:</strong> ${c.business || '-'}</p>
        </div>
      `;
    });
  }

  // Errors section
  if (errors.length > 0) {
    html += `<br><h3 style="color: #dc2626;">Failed Extractions</h3>`;
    html += `<ul>`;
    errors.forEach(e => {
      html += `<li><strong>${e.website}</strong>: ${e.error}</li>`;
    });
    html += `</ul>`;
  }

  return html;
}

// Main profile slides endpoint
app.post('/api/profile-slides', async (req, res) => {
  const { websites, email } = req.body;

  if (!websites || !Array.isArray(websites) || websites.length === 0) {
    return res.status(400).json({ error: 'Please provide an array of website URLs' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Please provide an email address' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`PROFILE SLIDES REQUEST: ${new Date().toISOString()}`);
  console.log(`Processing ${websites.length} website(s)`);
  console.log(`Email: ${email}`);
  console.log('='.repeat(50));

  // Return immediately - process in background
  res.json({
    success: true,
    message: 'Request received. Results will be emailed within 5-10 minutes.',
    companies: [],
    errors: [],
    total: websites.length
  });

  // Process in background
  try {
    const results = [];

    for (let i = 0; i < websites.length; i++) {
      const website = websites[i].trim();
      if (!website) continue;

      console.log(`\n[${i + 1}/${websites.length}] Processing: ${website}`);

      try {
        // Step 1: Scrape website
        console.log('  Step 1: Scraping website...');
        const scraped = await scrapeWebsite(website);

        if (!scraped.success) {
          console.log(`  Failed to scrape: ${scraped.error}`);
          results.push({
            website,
            error: `Failed to scrape: ${scraped.error}`,
            step: 1
          });
          continue;
        }
        console.log(`  Scraped ${scraped.content.length} characters`);

        // Step 2: Extract basic info (company name, year, location)
        console.log('  Step 2: Extracting company name, year, location...');
        const basicInfo = await extractBasicInfo(scraped.content, website);
        console.log(`  Company: ${basicInfo.company_name || 'Not found'}`);

        // Step 3: Extract business details
        console.log('  Step 3: Extracting business, message, footnote, title...');
        const businessInfo = await extractBusinessInfo(scraped.content, basicInfo);

        // Step 4: Extract key metrics
        console.log('  Step 4: Extracting key metrics...');
        const metricsInfo = await extractKeyMetrics(scraped.content, {
          company_name: basicInfo.company_name,
          business: businessInfo.business
        });

        // Step 4b: Extract products/applications breakdown for right table
        console.log('  Step 4b: Extracting products/applications breakdown...');
        const productsBreakdown = await extractProductsBreakdown(scraped.content, {
          company_name: basicInfo.company_name,
          business: businessInfo.business
        });

        // Note: Web search agents removed to prevent hallucination
        // All data now comes exclusively from scraped website content

        // Use only key metrics from scraped website (no web search)
        const allKeyMetrics = metricsInfo.key_metrics || [];

        // Combine all extracted data (only from scraped content, no web search)
        const companyData = {
          website: scraped.url,
          company_name: basicInfo.company_name || '',
          established_year: basicInfo.established_year || '',  // Only from website
          location: basicInfo.location || '',  // Only from website
          business: businessInfo.business || '',
          message: businessInfo.message || '',
          footnote: businessInfo.footnote || '',
          title: businessInfo.title || '',
          key_metrics: allKeyMetrics,  // Only from scraped website
          breakdown_title: productsBreakdown.breakdown_title || 'Products and Applications',
          breakdown_items: productsBreakdown.breakdown_items || [],
          metrics: metricsInfo.metrics || ''  // Fallback for old format
        };

        console.log(`  ✓ Completed: ${companyData.title || companyData.company_name} (${allKeyMetrics.length} metrics)`);
        results.push(companyData);

      } catch (error) {
        console.error(`  Error processing ${website}:`, error.message);
        results.push({
          website,
          error: error.message,
          step: 0
        });
      }
    }

    const companies = results.filter(r => !r.error);
    const errors = results.filter(r => r.error);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`PROFILE SLIDES EXTRACTION COMPLETE`);
    console.log(`Extracted: ${companies.length}/${websites.length} successful`);
    console.log('='.repeat(50));

    // Generate PPTX using PptxGenJS
    let pptxResult = null;
    if (companies.length > 0) {
      pptxResult = await generatePPTX(companies);
    }

    // Build email content
    const companyNames = companies.slice(0, 3).map(c => c.title || c.company_name).join(', ');
    const subject = `Profile Slides: ${companies.length} companies${companyNames ? ` (${companyNames}${companies.length > 3 ? '...' : ''})` : ''}`;
    const htmlContent = buildProfileSlidesEmailHTML(companies, errors, pptxResult?.success);

    // Send email with PPTX attachment
    const attachment = pptxResult?.success ? {
      content: pptxResult.content,
      name: `Profile_Slides_${new Date().toISOString().split('T')[0]}.pptx`
    } : null;

    await sendEmail(email, subject, htmlContent, attachment);

    console.log(`Email sent to ${email}${attachment ? ' with PPTX attachment' : ''}`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Profile slides error:', error);
    try {
      await sendEmail(email, 'Profile Slides - Error', `<p>Error processing your request: ${error.message}</p>`);
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

// ============ FINANCIAL CHART MAKER ============

// Country to currency mapping for LC/local currency detection
const COUNTRY_CURRENCY_MAP = {
  'japan': { code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
  'united states': { code: 'USD', symbol: '$', name: 'US Dollar' },
  'usa': { code: 'USD', symbol: '$', name: 'US Dollar' },
  'china': { code: 'CNY', symbol: '¥', name: 'Chinese Yuan' },
  'korea': { code: 'KRW', symbol: '₩', name: 'Korean Won' },
  'south korea': { code: 'KRW', symbol: '₩', name: 'Korean Won' },
  'thailand': { code: 'THB', symbol: '฿', name: 'Thai Baht' },
  'malaysia': { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit' },
  'singapore': { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' },
  'indonesia': { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah' },
  'vietnam': { code: 'VND', symbol: '₫', name: 'Vietnamese Dong' },
  'philippines': { code: 'PHP', symbol: '₱', name: 'Philippine Peso' },
  'india': { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
  'australia': { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  'uk': { code: 'GBP', symbol: '£', name: 'British Pound' },
  'united kingdom': { code: 'GBP', symbol: '£', name: 'British Pound' },
  'europe': { code: 'EUR', symbol: '€', name: 'Euro' },
  'germany': { code: 'EUR', symbol: '€', name: 'Euro' },
  'france': { code: 'EUR', symbol: '€', name: 'Euro' },
  'taiwan': { code: 'TWD', symbol: 'NT$', name: 'Taiwan Dollar' },
  'hong kong': { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar' },
  'brazil': { code: 'BRL', symbol: 'R$', name: 'Brazilian Real' },
  'mexico': { code: 'MXN', symbol: 'MX$', name: 'Mexican Peso' },
  'canada': { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' }
};

// AI agent to analyze Excel financial data
async function analyzeFinancialExcel(excelContent) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a financial data extraction expert. Analyze the Excel data and extract key financial information.

OUTPUT JSON with these fields:
- company_name: The company name found in the file (look for headers, titles, or file metadata)
- currency: The currency used (e.g., "USD", "JPY", "EUR"). If it says "LC" or "local currency", look for country mentions to determine actual currency. If currency symbol found (¥, $, €, etc.), identify it.
- country: Country of the company if mentioned
- revenue_data: Array of objects with { period: "FY2023" or "2023", value: number } - extract revenue/sales figures for multiple years. Value should be raw numbers (e.g., 1000000 not "1M").
- revenue_unit: The unit for revenue (e.g., "millions", "billions", "thousands", or "units" for raw numbers)
- margin_data: Array of objects with { period: "FY2023", margin_type: "operating" | "ebitda" | "pretax" | "net" | "gross", value: number (as percentage, e.g., 15.5 for 15.5%) }
  Priority order for margins: operating margin > EBITDA margin > pre-tax margin > net margin > gross margin
  Include the highest priority margin type available. If multiple margin types exist, include them all sorted by priority.
- fiscal_year_end: Month of fiscal year end if mentioned (e.g., "March", "December")

RULES:
- Extract ALL years/periods available (not just most recent)
- Revenue values should be numeric (convert "1,234" to 1234, "1.5M" to 1500000)
- Margin values as percentages (e.g., 12.5 for 12.5%)
- If LC/local currency mentioned, determine from country context
- Return ONLY valid JSON`
        },
        {
          role: 'user',
          content: `Analyze this financial data:\n\n${excelContent}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (e) {
    console.error('Financial analysis error:', e.message);
    return null;
  }
}

// Initialize xlsx-chart for Excel chart generation
const XLSXChart = require('xlsx-chart');

// Generate financial chart Excel workbook with COMBO chart (column + line)
// Uses xlsx-chart library which properly supports combo charts
async function generateFinancialChartExcel(financialDataArray) {
  return new Promise((resolve) => {
    try {
      const dataArray = Array.isArray(financialDataArray) ? financialDataArray : [financialDataArray];
      console.log('Generating Financial Chart Excel with xlsx-chart...');
      console.log(`Processing ${dataArray.length} company/companies`);

      // For now, we'll generate one file for the first company
      // xlsx-chart doesn't support multiple sheets easily, so we use the first company
      const financialData = dataArray[0];
      if (!financialData) {
        return resolve({ success: false, error: 'No financial data provided' });
      }

      const currency = financialData.currency || 'USD';
      const currencyUnit = financialData.revenue_unit || 'millions';
      const revenueData = financialData.revenue_data || [];
      const marginData = financialData.margin_data || [];

      if (revenueData.length === 0) {
        return resolve({ success: false, error: 'No revenue data found' });
      }

      // Sort revenue by period
      revenueData.sort((a, b) => {
        const yearA = parseInt(String(a.period).replace(/\D/g, ''));
        const yearB = parseInt(String(b.period).replace(/\D/g, ''));
        return yearA - yearB;
      });

      const chartLabels = revenueData.map(d => String(d.period));
      const revenueValues = revenueData.map(d => d.value || 0);

      // Get highest priority margin
      const marginPriority = ['operating', 'ebitda', 'pretax', 'net', 'gross'];
      const marginLabelMap = {
        'operating': '営業利益率 (%)',
        'ebitda': 'EBITDA利益率 (%)',
        'pretax': '税前利益率 (%)',
        'net': '純利益率 (%)',
        'gross': '粗利益率 (%)'
      };

      let selectedMarginType = null;
      let marginValues = [];

      for (const marginType of marginPriority) {
        const typeData = marginData.filter(m => m.margin_type === marginType);
        if (typeData.length > 0) {
          selectedMarginType = marginType;
          marginValues = chartLabels.map(period => {
            const found = typeData.find(m => String(m.period) === period);
            return found ? found.value : 0;
          });
          break;
        }
      }

      const unitDisplay = currencyUnit === 'millions' ? '百万' : (currencyUnit === 'billions' ? '十億' : '');
      const revenueLabel = `売上高 (${currency}${unitDisplay})`;
      const marginLabel = selectedMarginType ? marginLabelMap[selectedMarginType] : '利益率 (%)';
      const companyName = financialData.company_name || 'Financial Performance';

      // Build xlsx-chart options
      const titles = [revenueLabel];
      if (selectedMarginType && marginValues.some(v => v !== 0)) {
        titles.push(marginLabel);
      }

      // Build data object for xlsx-chart
      const data = {};

      // Revenue series (column chart)
      data[revenueLabel] = { chart: 'column' };
      chartLabels.forEach((label, i) => {
        data[revenueLabel][label] = revenueValues[i];
      });

      // Margin series (line chart) if available
      if (selectedMarginType && marginValues.some(v => v !== 0)) {
        data[marginLabel] = { chart: 'line' };
        chartLabels.forEach((label, i) => {
          data[marginLabel][label] = marginValues[i];
        });
      }

      const opts = {
        titles: titles,
        fields: chartLabels,
        data: data,
        chartTitle: companyName + ' - 財務実績'
      };

      const xlsxChart = new XLSXChart();
      xlsxChart.generate(opts, (err, buffer) => {
        if (err) {
          console.error('xlsx-chart error:', err);
          return resolve({ success: false, error: err.message || 'Chart generation failed' });
        }

        const base64Content = buffer.toString('base64');
        console.log('Financial Chart Excel generated successfully');
        resolve({
          success: true,
          content: base64Content
        });
      });

    } catch (error) {
      console.error('Financial Chart Excel error:', error);
      resolve({
        success: false,
        error: error.message
      });
    }
  });
}

// Generate financial chart PowerPoint with data table (no charts - they corrupt files)
// Both pptxgenjs charts and manual OOXML embedding cause file corruption
async function generateFinancialChartPPTX(financialDataArray) {
  try {
    const dataArray = Array.isArray(financialDataArray) ? financialDataArray : [financialDataArray];

    console.log('Generating Financial Chart PPTX (table-based)...');
    console.log(`Processing ${dataArray.length} company/companies`);

    const pptx = new pptxgen();
    pptx.author = 'YCP';
    pptx.title = 'Financial Charts';
    pptx.subject = 'Financial Performance';

    pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
    pptx.layout = 'YCP';

    const COLORS = {
      headerLine: '293F55',
      white: 'FFFFFF',
      black: '000000',
      dk2: '1F497D',
      footerText: '808080',
      chartBlue: '5B9BD5',
      chartOrange: 'ED7D31'
    };

    for (const financialData of dataArray) {
      if (!financialData) continue;

      const slide = pptx.addSlide();

      // Header lines
      slide.addShape(pptx.shapes.LINE, { x: 0, y: 1.02, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 4.5 } });
      slide.addShape(pptx.shapes.LINE, { x: 0, y: 1.10, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } });

      // Footer line
      slide.addShape(pptx.shapes.LINE, { x: 0, y: 7.24, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } });
      slide.addText('(C) YCP 2025 all rights reserved', { x: 4.1, y: 7.26, w: 5.1, h: 0.2, fontSize: 8, fontFace: 'Segoe UI', color: COLORS.footerText, align: 'center' });

      // Title
      const companyName = financialData.company_name || 'Financial Performance';
      const currency = financialData.currency || 'USD';
      const currencyUnit = financialData.revenue_unit || 'millions';

      slide.addText(companyName, { x: 0.38, y: 0.05, w: 9.5, h: 0.6, fontSize: 24, fontFace: 'Segoe UI', color: COLORS.black, valign: 'bottom' });
      slide.addText(`Financial Overview (${currency}, ${currencyUnit})`, { x: 0.38, y: 0.65, w: 9.5, h: 0.3, fontSize: 14, fontFace: 'Segoe UI', color: COLORS.footerText });

      // Section header
      slide.addText('財務実績', { x: 6.86, y: 4.35, w: 6.1, h: 0.30, fontSize: 14, fontFace: 'Segoe UI', color: COLORS.black, align: 'center' });
      slide.addShape(pptx.shapes.LINE, { x: 6.86, y: 4.65, w: 6.1, h: 0, line: { color: COLORS.dk2, width: 1.75 } });

      // Financial data table
      const revenueData = financialData.revenue_data || [];
      const marginData = financialData.margin_data || [];

      if (revenueData.length > 0) {
        revenueData.sort((a, b) => parseInt(String(a.period).replace(/\D/g, '')) - parseInt(String(b.period).replace(/\D/g, '')));

        const periods = revenueData.map(d => String(d.period));
        const revenues = revenueData.map(d => d.value || 0);

        // Find margin data
        const marginPriority = ['operating', 'ebitda', 'pretax', 'net', 'gross'];
        const marginLabelMap = { 'operating': '営業利益率', 'ebitda': 'EBITDA利益率', 'pretax': '税前利益率', 'net': '純利益率', 'gross': '粗利益率' };

        let marginType = null, margins = [];
        for (const mt of marginPriority) {
          const data = marginData.filter(m => m.margin_type === mt);
          if (data.length > 0) {
            marginType = mt;
            margins = periods.map(p => { const f = data.find(m => String(m.period) === p); return f ? f.value : 0; });
            break;
          }
        }

        const unitDisplay = currencyUnit === 'millions' ? '百万' : (currencyUnit === 'billions' ? '十億' : '');
        const revLabel = `売上高 (${currency}${unitDisplay})`;

        // Build table
        const tableRows = [];
        tableRows.push([{ text: '', options: { fill: COLORS.dk2 } }, ...periods.map(p => ({ text: p, options: { fill: COLORS.dk2, color: COLORS.white, bold: true, align: 'center' } }))]);
        tableRows.push([{ text: revLabel, options: { fill: COLORS.chartBlue, color: COLORS.white, bold: true } }, ...revenues.map(v => ({ text: v.toLocaleString(), options: { align: 'right' } }))]);

        if (marginType && margins.some(v => v !== 0)) {
          tableRows.push([{ text: marginLabelMap[marginType] + ' (%)', options: { fill: COLORS.chartOrange, color: COLORS.white, bold: true } }, ...margins.map(v => ({ text: v.toFixed(1) + '%', options: { align: 'right', color: COLORS.chartOrange } }))]);
        }

        const colW = [1.8, ...periods.map(() => (6.0 - 1.8) / periods.length)];
        slide.addTable(tableRows, { x: 6.86, y: 4.75, w: 6.0, colW, fontFace: 'Segoe UI', fontSize: 10, border: { type: 'solid', pt: 0.5, color: 'CCCCCC' }, valign: 'middle' });
      }

      slide.addText('Source: Company financial data', { x: 0.38, y: 6.90, w: 12.5, h: 0.18, fontSize: 10, fontFace: 'Segoe UI', color: COLORS.black });
    }

    const base64Content = await pptx.write({ outputType: 'base64' });
    console.log('Financial Chart PPTX generated successfully');

    return { success: true, content: base64Content };
  } catch (error) {
    console.error('Financial Chart PPTX error:', error);
    return { success: false, error: error.message };
  }
}

// Financial Chart API endpoint - supports multiple files (up to 20)
app.post('/api/financial-chart', upload.array('excelFiles', 20), async (req, res) => {
  const { email } = req.body;
  const excelFiles = req.files;

  if (!excelFiles || excelFiles.length === 0 || !email) {
    return res.status(400).json({ error: 'Excel file(s) and email are required' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`NEW FINANCIAL CHART REQUEST: ${new Date().toISOString()}`);
  console.log(`Email: ${email}`);
  console.log(`Files: ${excelFiles.length}`);
  excelFiles.forEach((f, i) => console.log(`  ${i + 1}. ${f.originalname} (${f.size} bytes)`));
  console.log('='.repeat(50));

  // Respond immediately
  res.json({
    success: true,
    message: `Request received. Processing ${excelFiles.length} file(s).`,
    fileCount: excelFiles.length
  });

  try {
    const allFinancialData = [];
    const errors = [];

    // Process each Excel file
    for (let i = 0; i < excelFiles.length; i++) {
      const excelFile = excelFiles[i];
      console.log(`\nProcessing file ${i + 1}/${excelFiles.length}: ${excelFile.originalname}`);

      try {
        // Parse Excel file
        const workbook = XLSX.read(excelFile.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        // Get CSV format for AI analysis
        const csvContent = XLSX.utils.sheet_to_csv(sheet);

        // Use AI to analyze financial data
        console.log('  Analyzing with AI...');
        const financialData = await analyzeFinancialExcel(`File name: ${excelFile.originalname}\n\nContent:\n${csvContent.substring(0, 15000)}`);

        if (financialData) {
          financialData._fileName = excelFile.originalname;
          allFinancialData.push(financialData);
          console.log(`  ✓ Extracted: ${financialData.company_name || 'Unknown'}`);
        } else {
          errors.push({ file: excelFile.originalname, error: 'Failed to analyze' });
          console.log(`  ✗ Failed to analyze`);
        }
      } catch (fileError) {
        errors.push({ file: excelFile.originalname, error: fileError.message });
        console.log(`  ✗ Error: ${fileError.message}`);
      }
    }

    if (allFinancialData.length === 0) {
      throw new Error('No financial data could be extracted from any file');
    }

    console.log(`\nSuccessfully processed ${allFinancialData.length}/${excelFiles.length} files`);

    // Generate PowerPoint with embedded Excel charts (one slide per company)
    // Uses OOXML chart embedding for reliable chart rendering
    const pptxResult = await generateFinancialChartPPTX(allFinancialData);

    if (!pptxResult.success) {
      throw new Error(pptxResult.error || 'Failed to generate PowerPoint');
    }

    // Build email content with summary of all companies
    const companyNames = allFinancialData.map(d => d.company_name || 'Unknown').join(', ');
    const summaryRows = allFinancialData.map(d => `
      <tr>
        <td style="padding: 8px; border: 1px solid #e2e8f0;">${d.company_name || 'Unknown'}</td>
        <td style="padding: 8px; border: 1px solid #e2e8f0;">${d.currency || '-'}</td>
        <td style="padding: 8px; border: 1px solid #e2e8f0;">${d.revenue_data ? d.revenue_data.length + ' periods' : '-'}</td>
        <td style="padding: 8px; border: 1px solid #e2e8f0;">${d.margin_data ? [...new Set(d.margin_data.map(m => m.margin_type))].join(', ') : '-'}</td>
      </tr>
    `).join('');

    const errorSection = errors.length > 0 ? `
      <h3 style="color: #dc2626; margin-top: 20px;">Failed Files (${errors.length})</h3>
      <ul style="color: #666;">
        ${errors.map(e => `<li>${e.file}: ${e.error}</li>`).join('')}
      </ul>
    ` : '';

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a365d;">Financial Charts - ${allFinancialData.length} Companies</h2>
        <p>Your financial chart PowerPoint has been generated with ${allFinancialData.length} slide${allFinancialData.length > 1 ? 's' : ''}.</p>

        <h3 style="color: #2563eb; margin-top: 20px;">Companies Processed</h3>
        <table style="border-collapse: collapse; width: 100%; margin-top: 10px;">
          <tr style="background: #f8fafc;">
            <th style="padding: 8px; border: 1px solid #e2e8f0; text-align: left;">Company</th>
            <th style="padding: 8px; border: 1px solid #e2e8f0; text-align: left;">Currency</th>
            <th style="padding: 8px; border: 1px solid #e2e8f0; text-align: left;">Revenue</th>
            <th style="padding: 8px; border: 1px solid #e2e8f0; text-align: left;">Margins</th>
          </tr>
          ${summaryRows}
        </table>

        ${errorSection}

        <p style="margin-top: 20px; color: #64748b; font-size: 12px;">
          Generated by Financial Chart Maker<br>
          ${new Date().toISOString()}
        </p>
      </div>
    `;

    // Send email with PPTX attachment
    const firstCompany = allFinancialData[0]?.company_name || 'Financial_Charts';
    await sendEmail(
      email,
      `Financial Charts: ${allFinancialData.length} companies${allFinancialData.length <= 3 ? ' (' + companyNames + ')' : ''}`,
      htmlContent,
      {
        content: pptxResult.content,
        name: `Financial_Charts_${allFinancialData.length}_companies_${new Date().toISOString().split('T')[0]}.pptx`
      }
    );

    console.log(`Financial chart PPTX sent to ${email}`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error('Financial chart error:', error);
    try {
      await sendEmail(
        email,
        'Financial Chart - Error',
        `<p>Error processing your financial data: ${error.message}</p><p>Please ensure your Excel files contain financial data with revenue and margin information.</p>`
      );
    } catch (e) {
      console.error('Failed to send error email:', e);
    }
  }
});

// ============ UTB (UNDERSTANDING THE BUSINESS) - COMPREHENSIVE M&A INTELLIGENCE ============

// Initialize ExcelJS
let ExcelJS;
try {
  ExcelJS = require('exceljs');
} catch (e) {
  console.warn('ExcelJS not available - UTB Excel generation disabled');
}

// Language detection from domain
function detectLanguage(website) {
  const domainMatch = website.match(/\.([a-z]{2,3})(?:\/|$)/i);
  const tld = domainMatch ? domainMatch[1].toLowerCase() : '';
  const languageMap = {
    'jp': { lang: 'Japanese', native: '日本語', searchPrefix: '日本語で' },
    'cn': { lang: 'Chinese', native: '中文', searchPrefix: '用中文' },
    'kr': { lang: 'Korean', native: '한국어', searchPrefix: '한국어로' },
    'de': { lang: 'German', native: 'Deutsch', searchPrefix: 'Auf Deutsch:' },
    'fr': { lang: 'French', native: 'Français', searchPrefix: 'En français:' },
    'th': { lang: 'Thai', native: 'ไทย', searchPrefix: 'ภาษาไทย:' },
    'vn': { lang: 'Vietnamese', native: 'Tiếng Việt', searchPrefix: 'Bằng tiếng Việt:' },
    'id': { lang: 'Indonesian', native: 'Indonesia', searchPrefix: 'Dalam Bahasa Indonesia:' },
    'tw': { lang: 'Chinese (Traditional)', native: '繁體中文', searchPrefix: '用繁體中文' }
  };
  return languageMap[tld] || null;
}

// UTB Phase 1: Deep Fact-Finding with 6 parallel specialized queries
async function utbPhase1Research(companyName, website, context) {
  console.log(`[UTB Phase 1] Starting deep fact-finding for: ${companyName}`);
  const localLang = detectLanguage(website);

  const queries = [
    // Query 1: Company Deep Dive - Products & Services
    callPerplexity(`Research ${companyName} (${website}) - PRODUCTS & SERVICES DEEP DIVE:

CRITICAL: I need SPECIFIC details, not general descriptions.

1. PRODUCT LINES: List ALL major product lines with:
   - Specific product/model names (e.g., "Model X-7", "Series 5000", brand names)
   - Key specifications or features
   - Target applications/industries served

2. SERVICE OFFERINGS: List specific services with names
   - Consulting services, support packages, etc.

3. TECHNOLOGY/IP: Proprietary technologies, patents, unique capabilities
   - Specific technology names or trademarked processes

4. VALUE CHAIN POSITION: Where they sit (R&D, manufacturing, distribution, etc.)

BE SPECIFIC with names and numbers. Generic descriptions are NOT useful.
${context ? `CONTEXT: ${context}` : ''}`).catch(e => ({ type: 'products', data: '', error: e.message })),

    // Query 2: Financial Analysis
    callPerplexity(`Research ${companyName} financial data - DETAILED BREAKDOWN:

1. REVENUE:
   - Total annual revenue (most recent, in local currency AND USD)
   - Revenue breakdown by business segment (% and amounts)
   - Revenue breakdown by geography (Japan, Asia, Americas, Europe, etc.)
   - Revenue trend (last 3-5 years if available)

2. PROFITABILITY:
   - Operating margin, EBITDA margin, Net margin
   - Trend in profitability

3. KEY METRICS:
   - Market cap (if public)
   - Number of employees
   - Revenue per employee

4. RECENT PERFORMANCE:
   - Latest quarterly/annual results highlights
   - Any guidance or forecasts

Provide SPECIFIC numbers and percentages. Source data from annual reports, investor presentations, or financial databases.`).catch(e => ({ type: 'financials', data: '', error: e.message })),

    // Query 3: Manufacturing & Operations
    callPerplexity(`Research ${companyName} manufacturing and operations footprint:

1. MANUFACTURING LOCATIONS:
   - List ALL manufacturing facilities by country/city
   - What is produced at each location
   - Capacity information if available (units, square meters, etc.)

2. R&D CENTERS:
   - Research facility locations
   - Key areas of R&D focus

3. SUPPLY CHAIN:
   - Key suppliers or supply chain dependencies
   - Vertical integration level

4. OPERATIONAL FOOTPRINT:
   - Number of locations globally
   - Sales/distribution offices by region

Provide SPECIFIC locations (city, country) not just "facilities in Asia".`).catch(e => ({ type: 'operations', data: '', error: e.message })),

    // Query 4: Competitive Landscape
    callPerplexity(`Research ${companyName} competitive landscape - DETAILED ANALYSIS:

1. DIRECT COMPETITORS:
   - List 5-10 main competitors BY NAME
   - For each: approximate revenue, HQ location, key differentiator
   - Market share estimates if available

2. COMPETITIVE POSITIONING:
   - How ${companyName} ranks vs competitors (market share, technology, etc.)
   - Key competitive advantages
   - Competitive weaknesses or gaps

3. MARKET DYNAMICS:
   - Total addressable market size
   - Market growth rate
   - Key trends affecting competition

4. BARRIERS TO ENTRY:
   - What protects ${companyName}'s position

Provide SPECIFIC competitor names and data, not generic statements.`).catch(e => ({ type: 'competitors', data: '', error: e.message })),

    // Query 5: M&A History & Strategy
    callPerplexity(`Research ${companyName} M&A activity and corporate development - COMPREHENSIVE:

1. PAST ACQUISITIONS (last 10 years):
   - Target company name
   - Year of acquisition
   - Deal value (if disclosed)
   - Strategic rationale
   - Integration outcome

2. PAST DIVESTITURES:
   - Any businesses sold off

3. STRATEGIC PARTNERSHIPS & JVs:
   - Partner name
   - Nature of partnership
   - Year established

4. INVESTMENTS:
   - Minority investments made
   - VC/CVC activity

5. M&A STRATEGY SIGNALS:
   - Management statements about M&A
   - Investor presentation mentions of inorganic growth
   - Recent news about M&A intentions

Provide SPECIFIC deal names, dates, and values.`).catch(e => ({ type: 'ma_history', data: '', error: e.message })),

    // Query 6: Leadership & Strategy
    callPerplexity(`Research ${companyName} leadership and strategic direction:

1. LEADERSHIP TEAM:
   - CEO name and background (tenure, previous roles)
   - Key executives (CFO, COO, CTO, etc.)
   - Board composition (notable members)

2. STRATEGIC PRIORITIES:
   - Stated strategic initiatives
   - Medium-term plan (if disclosed)
   - Key focus areas for growth

3. RECENT NEWS:
   - Major announcements in last 12 months
   - New product launches
   - Market expansion news

4. INVESTOR MESSAGING:
   - Key themes from investor presentations
   - Guidance or targets shared

Provide SPECIFIC names and quotes where available.`).catch(e => ({ type: 'leadership', data: '', error: e.message }))
  ];

  // Add local language query if applicable
  if (localLang) {
    queries.push(
      callPerplexity(`${localLang.searchPrefix} ${companyName}について詳しく調べてください:

Search for ${companyName} in ${localLang.lang}:
- Recent press releases and news
- Management interviews and statements
- Industry awards and recognition
- Local market reputation and positioning
- Detailed product/service information not available in English
- Employee reviews or company culture insights

Provide findings in English with specific details.`).catch(e => ({ type: 'local', data: '', error: e.message }))
    );
  }

  // Execute all queries in parallel
  const results = await Promise.all(queries);

  // Organize results
  const research = {
    products: typeof results[0] === 'string' ? results[0] : '',
    financials: typeof results[1] === 'string' ? results[1] : '',
    operations: typeof results[2] === 'string' ? results[2] : '',
    competitors: typeof results[3] === 'string' ? results[3] : '',
    maHistory: typeof results[4] === 'string' ? results[4] : '',
    leadership: typeof results[5] === 'string' ? results[5] : '',
    localInsights: localLang && results[6] && typeof results[6] === 'string' ? results[6] : ''
  };

  console.log(`[UTB Phase 1] Complete. Research lengths: products=${research.products.length}, financials=${research.financials.length}, operations=${research.operations.length}, competitors=${research.competitors.length}, maHistory=${research.maHistory.length}, leadership=${research.leadership.length}`);

  return research;
}

// UTB Phase 2: Section-by-Section Synthesis
async function utbPhase2Synthesis(companyName, website, research, context) {
  console.log(`[UTB Phase 2] Synthesizing intelligence for: ${companyName}`);

  const synthesisPrompts = [
    // Synthesis 1: Executive Summary & Company Profile
    callChatGPT(`You are a senior M&A advisor. Based on the research below, write a COMPREHENSIVE company profile.

COMPANY: ${companyName}
WEBSITE: ${website}
${context ? `CLIENT CONTEXT: ${context}` : ''}

RESEARCH ON PRODUCTS & SERVICES:
${research.products}

RESEARCH ON FINANCIALS:
${research.financials}

RESEARCH ON LEADERSHIP:
${research.leadership}

---

Respond in this EXACT JSON format:
{
  "executive_summary": "3-4 sentences capturing the essence of this company for an M&A advisor. What are they, why do they matter, what's their trajectory?",
  "company_profile": {
    "legal_name": "Full legal name",
    "hq_location": "City, Country",
    "founded": "Year",
    "ownership_structure": "Public (ticker) / Private / PE-backed by [name]",
    "employees": "Number with source year",
    "website": "${website}"
  },
  "financials": {
    "total_revenue": "Amount in local currency and USD equivalent",
    "revenue_growth": "YoY or CAGR if available",
    "revenue_by_segment": [
      {"segment": "Segment name", "revenue": "Amount or %", "description": "What this segment does"}
    ],
    "revenue_by_geography": [
      {"region": "Region name", "percentage": "X%", "notes": "Any relevant notes"}
    ],
    "profitability": {
      "operating_margin": "X% or N/A",
      "ebitda_margin": "X% or N/A",
      "net_margin": "X% or N/A"
    },
    "key_metrics": "Any other important financial metrics"
  },
  "leadership": {
    "ceo": {"name": "Name", "tenure": "Since year", "background": "Brief background"},
    "key_executives": [
      {"title": "Title", "name": "Name", "background": "Brief"}
    ]
  }
}

IMPORTANT: Use SPECIFIC numbers and names. If information is not available, write "Not disclosed" rather than making things up.`).catch(e => ({ section: 'profile', error: e.message })),

    // Synthesis 2: Products, Services & Operations
    callChatGPT(`You are writing for M&A ADVISORS who need to understand a company's business quickly. NOT engineers.

COMPANY: ${companyName}

RESEARCH ON PRODUCTS & SERVICES:
${research.products}

RESEARCH ON OPERATIONS:
${research.operations}

---

CRITICAL INSTRUCTIONS:
- Do NOT list technical model numbers or product codes (e.g., "SYSTEM 800 SE", "Model X-7000")
- Instead, explain what the business DOES and WHY IT MATTERS for an acquirer
- Write like you're briefing a Managing Director before a client meeting
- Focus on: revenue drivers, competitive advantages, customer value proposition

Respond in this EXACT JSON format:
{
  "products_and_services": {
    "overview": "2-3 sentences explaining the business in plain English. What do they sell, to whom, and why do customers choose them?",
    "product_lines": [
      {
        "name": "Business segment name (not model numbers)",
        "what_it_does": "Plain English explanation of customer value",
        "revenue_significance": "High/Medium/Low revenue contributor",
        "why_it_matters": "Why an acquirer should care - moat, growth, margins"
      }
    ],
    "strategic_capabilities": [
      {
        "capability": "What they can do that competitors struggle with",
        "business_impact": "How this translates to customer wins or pricing power",
        "defensibility": "Why this is hard to replicate"
      }
    ]
  },
  "operations": {
    "manufacturing_footprint": [
      {"location": "City, Country", "strategic_value": "Why this location matters (cost, market access, talent)"}
    ],
    "global_presence": {
      "summary": "Brief description of geographic reach and key markets",
      "expansion_trajectory": "Where they're growing and why"
    }
  }
}

REMEMBER: An M&A advisor reading this should understand the business model and competitive position in 2 minutes. No jargon.`).catch(e => ({ section: 'products', error: e.message })),

    // Synthesis 3: Competitive Landscape
    callChatGPT(`You are writing a competitive analysis for M&A ADVISORS. Focus on deal implications.

COMPANY: ${companyName}

RESEARCH ON COMPETITORS:
${research.competitors}

RESEARCH ON PRODUCTS (for context):
${research.products}

---

CRITICAL INSTRUCTIONS:
- Write for someone evaluating this company as an acquisition target or buyer
- Focus on: market position, competitive moat, vulnerability to disruption
- Explain WHY competitive dynamics matter for valuation and deal thesis

Respond in this EXACT JSON format:
{
  "competitive_landscape": {
    "market_overview": {
      "market_size": "Total addressable market in USD",
      "growth_rate": "Market CAGR",
      "market_maturity": "Emerging / Growth / Mature / Declining - with brief explanation"
    },
    "company_position": {
      "market_rank": "#1, #2, Top 5, etc. with context",
      "how_they_win": "Plain English: why do customers choose them over alternatives?",
      "competitive_moat": "What protects their position - switching costs, brand, scale, IP, relationships?",
      "vulnerability": "Biggest competitive threat or disruption risk"
    },
    "key_competitors": [
      {
        "name": "Competitor name",
        "size_comparison": "Larger/Similar/Smaller than target",
        "threat_to_position": "Why they matter - are they gaining share, attacking same customers?",
        "ma_relevance": "Could they be acquirer, target, or consolidation partner?"
      }
    ],
    "deal_implications": "2-3 sentences on what competitive dynamics mean for valuation or strategic fit"
  }
}

REMEMBER: Help an MD quickly understand if this company has a defensible position worth paying for.`).catch(e => ({ section: 'competitors', error: e.message })),

    // Synthesis 4: M&A Deep Dive - Full Story Analysis
    callChatGPT(`You are an M&A advisor writing a DEEP intelligence brief on a company's acquisition behavior.

COMPANY: ${companyName}

RESEARCH ON M&A HISTORY:
${research.maHistory}

RESEARCH ON LEADERSHIP & STRATEGY:
${research.leadership}

RESEARCH ON FINANCIALS:
${research.financials}

---

CRITICAL: I need DEPTH, not breadth. Don't give me 10 shallow bullet points. Give me 3-4 deals analyzed DEEPLY.

For EACH significant acquisition, write 3-5 sentences explaining:
1. What they bought and why (the strategic logic)
2. What it tells us about their priorities
3. How they executed (price paid, integration approach)
4. What it means for future deals they'd consider

Then synthesize: What patterns emerge? What does this tell us about how they think about M&A?

Respond in this EXACT JSON format:
{
  "ma_deep_dive": {
    "deal_stories": [
      {
        "deal": "Target company name (Year)",
        "full_story": "3-5 sentence deep analysis of this deal - what they bought, why, how, and what it tells us"
      }
    ],
    "ma_philosophy": "2-3 paragraphs synthesizing their overall M&A philosophy. Are they empire builders or focused acquirers? Do they buy technology, market access, or capacity? How aggressive are they on valuation? How do they integrate - hands-off or full absorption?",
    "deal_capacity": {
      "financial_firepower": "Based on balance sheet and past deals, what can they spend?",
      "appetite_level": "High/Medium/Low - are they actively hunting or opportunistic?",
      "decision_process": "Fast/Deliberate/Slow - how long do their deals take?"
    }
  }
}

REMEMBER: An MD reading this should deeply understand HOW this company thinks about M&A.`).catch(e => ({ section: 'ma_analysis', error: e.message })),

    // Synthesis 5: Ideal Target Profile - Deep Strategic Analysis
    callChatGPT(`You are an M&A advisor writing THE most important page of a buyer brief: What exactly should we pitch them?

COMPANY: ${companyName}

ALL RESEARCH:
${research.products}
${research.maHistory}
${research.leadership}
${research.financials}

${context ? `CLIENT CONTEXT: ${context}` : ''}

---

CRITICAL: Don't give me a checklist of shallow criteria. Give me ONE deep, insightful analysis.

Write 2-3 paragraphs that answer: "If I had to describe the PERFECT acquisition target for ${companyName}, what would it look like and WHY?"

Consider and SYNTHESIZE:
- Value chain position: Do they want upstream suppliers, downstream distribution, or horizontal competitors?
- Industry adjacencies: Which specific sectors fit their strategy and why?
- Geography: Which countries/regions and why (market access, cost, talent)?
- Company stage: Early-stage tech, growth companies, or mature cash-flow businesses?
- Size: What's their sweet spot and why?

Then give me ONE specific example: "A company like [description] in [country] would be highly attractive because [specific reasons tied to their strategy]"

Respond in this EXACT JSON format:
{
  "ideal_target": {
    "strategic_analysis": "2-3 paragraphs of deep analysis on what they want and WHY. Connect dots between their strategy, past deals, and future needs. This should read like insight, not a checklist.",
    "sweet_spot": {
      "value_chain": "Where in the value chain (upstream/midstream/downstream) and why",
      "industries": "Which specific industries/segments and why",
      "geographies": "Which countries/regions and why",
      "size_range": "Revenue or deal size range and why this fits",
      "stage": "Growth stage preference and why"
    },
    "example_target": "One specific, concrete example: 'A company like [X] that does [Y] in [Z country] would be attractive because [specific strategic fit]'",
    "what_to_avoid": "1-2 sentences on what would NOT fit and why"
  }
}`).catch(e => ({ section: 'ideal_target', error: e.message }))
  ];

  // Add local insights synthesis if available
  if (research.localInsights) {
    synthesisPrompts.push(
      callChatGPT(`Synthesize these local language insights about ${companyName}:

LOCAL INSIGHTS:
${research.localInsights}

Respond in JSON:
{
  "local_insights": {
    "key_findings": ["Important findings not available in English sources"],
    "reputation": "How they're perceived locally",
    "recent_developments": "Recent news or announcements",
    "cultural_considerations": "Any cultural factors relevant for engagement"
  }
}`).catch(e => ({ section: 'local', error: e.message }))
    );
  }

  // Execute all synthesis in parallel
  const synthesisResults = await Promise.all(synthesisPrompts);

  // Parse and combine results
  const sections = {};
  for (const result of synthesisResults) {
    if (typeof result === 'string') {
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          Object.assign(sections, parsed);
        }
      } catch (e) {
        console.error('Failed to parse synthesis result:', e.message);
      }
    } else if (result.error) {
      console.error(`Synthesis error for ${result.section}:`, result.error);
    }
  }

  console.log(`[UTB Phase 2] Complete. Sections generated: ${Object.keys(sections).join(', ')}`);

  return sections;
}

// Main UTB Research Function
async function conductUTBResearch(companyName, website, additionalContext) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[UTB] Starting comprehensive research for: ${companyName}`);
  console.log(`[UTB] Website: ${website}`);
  console.log('='.repeat(60));

  // Phase 1: Deep fact-finding
  const rawResearch = await utbPhase1Research(companyName, website, additionalContext);

  // Phase 2: Section-by-section synthesis
  const synthesis = await utbPhase2Synthesis(companyName, website, rawResearch, additionalContext);

  console.log(`[UTB] Research complete for: ${companyName}`);

  return {
    synthesis,
    rawResearch,
    metadata: {
      company: companyName,
      website,
      generatedAt: new Date().toISOString(),
      localLanguage: detectLanguage(website)?.lang || null
    }
  };
}

// Generate UTB Excel workbook with structured data
async function generateUTBExcel(companyName, website, research, additionalContext) {
  if (!ExcelJS) {
    throw new Error('ExcelJS not available');
  }

  const { synthesis, metadata } = research;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'UTB - M&A Buyer Intelligence';
  workbook.created = new Date();

  // Colors
  const navy = 'FF1A365D';
  const blue = 'FF2563EB';
  const lightBlue = 'FFDBEAFE';
  const lightGray = 'FFF8FAFC';
  const white = 'FFFFFFFF';

  // Helper: Style header row
  const styleHeaderRow = (row, color = navy) => {
    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }
      };
    });
    row.height = 22;
  };

  // Helper: Style data row
  const styleDataRow = (row, isAlternate = false) => {
    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isAlternate ? lightGray : white } };
      cell.font = { size: 10 };
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }
      };
    });
  };

  // Helper: Add section title
  const addSectionTitle = (ws, title, row) => {
    ws.mergeCells(`A${row}:F${row}`);
    const cell = ws.getCell(`A${row}`);
    cell.value = title;
    cell.font = { bold: true, size: 14, color: { argb: navy } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lightBlue } };
    cell.alignment = { vertical: 'middle' };
    ws.getRow(row).height = 28;
    return row + 1;
  };

  // ========== SHEET 1: EXECUTIVE SUMMARY ==========
  const summarySheet = workbook.addWorksheet('Executive Summary');
  summarySheet.columns = [
    { key: 'label', width: 20 },
    { key: 'value', width: 60 }
  ];

  // Title
  summarySheet.mergeCells('A1:B1');
  const titleCell = summarySheet.getCell('A1');
  titleCell.value = `UTB: ${companyName}`;
  titleCell.font = { bold: true, size: 18, color: { argb: navy } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lightBlue } };
  summarySheet.getRow(1).height = 35;

  summarySheet.mergeCells('A2:B2');
  summarySheet.getCell('A2').value = website;
  summarySheet.getCell('A2').font = { size: 11, color: { argb: 'FF64748B' } };

  // Executive Summary
  let r = 4;
  r = addSectionTitle(summarySheet, 'Executive Summary', r);
  summarySheet.mergeCells(`A${r}:B${r}`);
  summarySheet.getCell(`A${r}`).value = synthesis.executive_summary || 'No executive summary available';
  summarySheet.getCell(`A${r}`).alignment = { wrapText: true, vertical: 'top' };
  summarySheet.getRow(r).height = 60;
  r += 2;

  // Company Profile
  const profile = synthesis.company_profile || {};
  r = addSectionTitle(summarySheet, 'Company Profile', r);
  const profileData = [
    ['Legal Name', profile.legal_name || companyName],
    ['Headquarters', profile.hq_location || 'Not disclosed'],
    ['Founded', profile.founded || 'Not disclosed'],
    ['Ownership', profile.ownership_structure || 'Not disclosed'],
    ['Employees', profile.employees || 'Not disclosed'],
    ['Website', website]
  ];
  profileData.forEach((item, i) => {
    summarySheet.getCell(`A${r}`).value = item[0];
    summarySheet.getCell(`A${r}`).font = { bold: true, size: 10 };
    summarySheet.getCell(`B${r}`).value = item[1];
    styleDataRow(summarySheet.getRow(r), i % 2 === 0);
    r++;
  });
  r++;

  // Leadership
  const lead = synthesis.leadership || {};
  r = addSectionTitle(summarySheet, 'Leadership', r);
  if (lead.ceo) {
    summarySheet.getCell(`A${r}`).value = 'CEO';
    summarySheet.getCell(`A${r}`).font = { bold: true };
    summarySheet.getCell(`B${r}`).value = `${lead.ceo.name || 'N/A'} - ${lead.ceo.background || ''}`;
    styleDataRow(summarySheet.getRow(r));
    r++;
  }
  if (lead.key_executives && lead.key_executives.length > 0) {
    lead.key_executives.forEach((exec, i) => {
      summarySheet.getCell(`A${r}`).value = exec.title || 'Executive';
      summarySheet.getCell(`A${r}`).font = { bold: true };
      summarySheet.getCell(`B${r}`).value = `${exec.name || 'N/A'} - ${exec.background || ''}`;
      styleDataRow(summarySheet.getRow(r), i % 2 === 0);
      r++;
    });
  }

  // ========== SHEET 2: FINANCIALS ==========
  const finSheet = workbook.addWorksheet('Financials');
  finSheet.columns = [
    { key: 'label', width: 25 },
    { key: 'value', width: 30 },
    { key: 'notes', width: 45 }
  ];

  const fin = synthesis.financials || {};
  let fr = 1;
  fr = addSectionTitle(finSheet, 'Financial Overview', fr);

  const finOverview = [
    ['Total Revenue', fin.total_revenue || 'Not disclosed', ''],
    ['Revenue Growth', fin.revenue_growth || 'Not disclosed', ''],
    ['Operating Margin', fin.profitability?.operating_margin || 'Not disclosed', ''],
    ['EBITDA Margin', fin.profitability?.ebitda_margin || 'Not disclosed', ''],
    ['Net Margin', fin.profitability?.net_margin || 'Not disclosed', ''],
    ['Key Metrics', fin.key_metrics || '', '']
  ];
  finOverview.forEach((item, i) => {
    finSheet.getCell(`A${fr}`).value = item[0];
    finSheet.getCell(`A${fr}`).font = { bold: true };
    finSheet.getCell(`B${fr}`).value = item[1];
    finSheet.getCell(`C${fr}`).value = item[2];
    styleDataRow(finSheet.getRow(fr), i % 2 === 0);
    fr++;
  });
  fr++;

  // Revenue by Segment
  if (fin.revenue_by_segment && fin.revenue_by_segment.length > 0) {
    fr = addSectionTitle(finSheet, 'Revenue by Segment', fr);
    const segHeader = finSheet.getRow(fr);
    segHeader.values = ['Segment', 'Revenue', 'Description'];
    styleHeaderRow(segHeader, blue);
    fr++;
    fin.revenue_by_segment.forEach((seg, i) => {
      finSheet.getCell(`A${fr}`).value = seg.segment;
      finSheet.getCell(`B${fr}`).value = seg.revenue;
      finSheet.getCell(`C${fr}`).value = seg.description;
      styleDataRow(finSheet.getRow(fr), i % 2 === 0);
      fr++;
    });
    fr++;
  }

  // Revenue by Geography
  if (fin.revenue_by_geography && fin.revenue_by_geography.length > 0) {
    fr = addSectionTitle(finSheet, 'Revenue by Geography', fr);
    const geoHeader = finSheet.getRow(fr);
    geoHeader.values = ['Region', 'Share', 'Notes'];
    styleHeaderRow(geoHeader, blue);
    fr++;
    fin.revenue_by_geography.forEach((geo, i) => {
      finSheet.getCell(`A${fr}`).value = geo.region;
      finSheet.getCell(`B${fr}`).value = geo.percentage;
      finSheet.getCell(`C${fr}`).value = geo.notes || '';
      styleDataRow(finSheet.getRow(fr), i % 2 === 0);
      fr++;
    });
  }

  // ========== SHEET 3: PRODUCTS & OPERATIONS ==========
  const prodSheet = workbook.addWorksheet('Products & Operations');
  prodSheet.columns = [
    { key: 'a', width: 25 },
    { key: 'b', width: 35 },
    { key: 'c', width: 40 }
  ];

  const prod = synthesis.products_and_services || {};
  let pr = 1;

  // Products Overview
  pr = addSectionTitle(prodSheet, 'Business Overview', pr);
  prodSheet.mergeCells(`A${pr}:C${pr}`);
  prodSheet.getCell(`A${pr}`).value = prod.overview || 'No overview available';
  prodSheet.getCell(`A${pr}`).alignment = { wrapText: true };
  prodSheet.getRow(pr).height = 50;
  pr += 2;

  // Business Segments (renamed from Product Lines)
  if (prod.product_lines && prod.product_lines.length > 0) {
    pr = addSectionTitle(prodSheet, 'Business Segments', pr);
    const plHeader = prodSheet.getRow(pr);
    plHeader.values = ['Segment', 'What It Does', 'Why It Matters'];
    styleHeaderRow(plHeader, blue);
    pr++;
    prod.product_lines.forEach((line, i) => {
      prodSheet.getCell(`A${pr}`).value = line.name;
      prodSheet.getCell(`A${pr}`).font = { bold: true };
      prodSheet.getCell(`B${pr}`).value = line.what_it_does || line.description || '';
      prodSheet.getCell(`C${pr}`).value = line.why_it_matters || '';
      styleDataRow(prodSheet.getRow(pr), i % 2 === 0);
      pr++;
    });
    pr++;
  }

  // Strategic Capabilities (replaces Technology & IP)
  if (prod.strategic_capabilities && prod.strategic_capabilities.length > 0) {
    pr = addSectionTitle(prodSheet, 'Strategic Capabilities (Why Customers Choose Them)', pr);
    const capHeader = prodSheet.getRow(pr);
    capHeader.values = ['Capability', 'Business Impact', 'Defensibility'];
    styleHeaderRow(capHeader, navy);
    pr++;
    prod.strategic_capabilities.forEach((cap, i) => {
      prodSheet.getCell(`A${pr}`).value = cap.capability;
      prodSheet.getCell(`A${pr}`).font = { bold: true };
      prodSheet.getCell(`B${pr}`).value = cap.business_impact || '';
      prodSheet.getCell(`C${pr}`).value = cap.defensibility || '';
      styleDataRow(prodSheet.getRow(pr), i % 2 === 0);
      pr++;
    });
    pr++;
  }

  // Operations
  const ops = synthesis.operations || {};
  if (ops.manufacturing_footprint && ops.manufacturing_footprint.length > 0) {
    pr = addSectionTitle(prodSheet, 'Manufacturing & Operations', pr);
    const mfgHeader = prodSheet.getRow(pr);
    mfgHeader.values = ['Location', 'Strategic Value', ''];
    styleHeaderRow(mfgHeader);
    pr++;
    ops.manufacturing_footprint.forEach((mfg, i) => {
      prodSheet.getCell(`A${pr}`).value = mfg.location;
      prodSheet.getCell(`A${pr}`).font = { bold: true };
      prodSheet.mergeCells(`B${pr}:C${pr}`);
      prodSheet.getCell(`B${pr}`).value = mfg.strategic_value || mfg.function || '';
      styleDataRow(prodSheet.getRow(pr), i % 2 === 0);
      pr++;
    });
    pr++;
  }

  // Global Presence
  if (ops.global_presence) {
    pr = addSectionTitle(prodSheet, 'Global Footprint', pr);
    if (ops.global_presence.summary) {
      prodSheet.getCell(`A${pr}`).value = 'Presence';
      prodSheet.getCell(`A${pr}`).font = { bold: true };
      prodSheet.mergeCells(`B${pr}:C${pr}`);
      prodSheet.getCell(`B${pr}`).value = ops.global_presence.summary;
      styleDataRow(prodSheet.getRow(pr));
      pr++;
    }
    if (ops.global_presence.expansion_trajectory) {
      prodSheet.getCell(`A${pr}`).value = 'Growth Direction';
      prodSheet.getCell(`A${pr}`).font = { bold: true };
      prodSheet.mergeCells(`B${pr}:C${pr}`);
      prodSheet.getCell(`B${pr}`).value = ops.global_presence.expansion_trajectory;
      styleDataRow(prodSheet.getRow(pr), true);
      pr++;
    }
  }

  // ========== SHEET 4: COMPETITIVE LANDSCAPE ==========
  const compSheet = workbook.addWorksheet('Competitive Landscape');
  compSheet.columns = [
    { key: 'a', width: 25 },
    { key: 'b', width: 35 },
    { key: 'c', width: 40 }
  ];

  const comp = synthesis.competitive_landscape || {};
  let cr = 1;

  // Market Overview
  const mkt = comp.market_overview || {};
  cr = addSectionTitle(compSheet, 'Market Overview', cr);
  const mktData = [
    ['Market Size', mkt.market_size || 'Not disclosed'],
    ['Growth Rate', mkt.growth_rate || 'Not disclosed'],
    ['Market Stage', mkt.market_maturity || 'Not disclosed']
  ];
  mktData.forEach((item, i) => {
    compSheet.getCell(`A${cr}`).value = item[0];
    compSheet.getCell(`A${cr}`).font = { bold: true };
    compSheet.mergeCells(`B${cr}:C${cr}`);
    compSheet.getCell(`B${cr}`).value = item[1];
    styleDataRow(compSheet.getRow(cr), i % 2 === 0);
    cr++;
  });
  cr++;

  // Company Position - Deal Focused
  const pos = comp.company_position || {};
  cr = addSectionTitle(compSheet, 'Why This Company Wins', cr);

  if (pos.market_rank) {
    compSheet.getCell(`A${cr}`).value = 'Market Position';
    compSheet.getCell(`A${cr}`).font = { bold: true };
    compSheet.mergeCells(`B${cr}:C${cr}`);
    compSheet.getCell(`B${cr}`).value = pos.market_rank;
    styleDataRow(compSheet.getRow(cr));
    cr++;
  }
  if (pos.how_they_win) {
    compSheet.getCell(`A${cr}`).value = 'Why Customers Buy';
    compSheet.getCell(`A${cr}`).font = { bold: true, color: { argb: 'FF16A34A' } };
    compSheet.mergeCells(`B${cr}:C${cr}`);
    compSheet.getCell(`B${cr}`).value = pos.how_they_win;
    compSheet.getCell(`B${cr}`).alignment = { wrapText: true };
    styleDataRow(compSheet.getRow(cr), true);
    cr++;
  }
  if (pos.competitive_moat) {
    compSheet.getCell(`A${cr}`).value = 'Competitive Moat';
    compSheet.getCell(`A${cr}`).font = { bold: true, color: { argb: 'FF16A34A' } };
    compSheet.mergeCells(`B${cr}:C${cr}`);
    compSheet.getCell(`B${cr}`).value = pos.competitive_moat;
    compSheet.getCell(`B${cr}`).alignment = { wrapText: true };
    styleDataRow(compSheet.getRow(cr));
    cr++;
  }
  if (pos.vulnerability) {
    compSheet.getCell(`A${cr}`).value = 'Key Vulnerability';
    compSheet.getCell(`A${cr}`).font = { bold: true, color: { argb: 'FFDC2626' } };
    compSheet.mergeCells(`B${cr}:C${cr}`);
    compSheet.getCell(`B${cr}`).value = pos.vulnerability;
    compSheet.getCell(`B${cr}`).alignment = { wrapText: true };
    styleDataRow(compSheet.getRow(cr), true);
    cr++;
  }
  cr++;

  // Competitors Table - M&A Focused
  const competitors = comp.key_competitors || comp.competitors || [];
  if (competitors.length > 0) {
    cr = addSectionTitle(compSheet, 'Competitive Landscape & M&A Implications', cr);
    const compHeader = compSheet.getRow(cr);
    compHeader.values = ['Competitor', 'Threat to Position', 'M&A Relevance'];
    styleHeaderRow(compHeader, blue);
    cr++;
    competitors.forEach((c, i) => {
      compSheet.getCell(`A${cr}`).value = `${c.name}${c.size_comparison ? ' (' + c.size_comparison + ')' : ''}`;
      compSheet.getCell(`A${cr}`).font = { bold: true };
      compSheet.getCell(`B${cr}`).value = c.threat_to_position || c.key_differentiator || '';
      compSheet.getCell(`C${cr}`).value = c.ma_relevance || '';
      styleDataRow(compSheet.getRow(cr), i % 2 === 0);
      cr++;
    });
    cr++;
  }

  // Deal Implications
  if (comp.deal_implications) {
    cr = addSectionTitle(compSheet, 'What This Means for a Deal', cr);
    compSheet.mergeCells(`A${cr}:C${cr}`);
    compSheet.getCell(`A${cr}`).value = comp.deal_implications;
    compSheet.getCell(`A${cr}`).alignment = { wrapText: true };
    compSheet.getCell(`A${cr}`).font = { italic: true };
    compSheet.getRow(cr).height = 50;
  }

  // ========== SHEET 5: M&A DEEP DIVE ==========
  const maSheet = workbook.addWorksheet('M&A Deep Dive');
  maSheet.columns = [
    { key: 'a', width: 25 },
    { key: 'b', width: 75 }
  ];

  const maDeepDive = synthesis.ma_deep_dive || {};
  let mr = 1;

  // Deal Stories - Deep Analysis Per Deal
  const dealStories = maDeepDive.deal_stories || [];
  if (dealStories.length > 0) {
    mr = addSectionTitle(maSheet, 'Deal-by-Deal Analysis', mr);
    dealStories.forEach((story, i) => {
      maSheet.getCell(`A${mr}`).value = story.deal;
      maSheet.getCell(`A${mr}`).font = { bold: true, size: 11, color: { argb: blue } };
      mr++;
      maSheet.mergeCells(`A${mr}:B${mr}`);
      maSheet.getCell(`A${mr}`).value = story.full_story;
      maSheet.getCell(`A${mr}`).alignment = { wrapText: true, vertical: 'top' };
      maSheet.getRow(mr).height = 80;
      styleDataRow(maSheet.getRow(mr), i % 2 === 0);
      mr++;
      mr++; // Extra space between deals
    });
  }

  // M&A Philosophy - Deep Synthesis
  if (maDeepDive.ma_philosophy) {
    mr = addSectionTitle(maSheet, 'How They Think About M&A', mr);
    maSheet.mergeCells(`A${mr}:B${mr}`);
    maSheet.getCell(`A${mr}`).value = maDeepDive.ma_philosophy;
    maSheet.getCell(`A${mr}`).alignment = { wrapText: true, vertical: 'top' };
    maSheet.getRow(mr).height = 120;
    mr += 2;
  }

  // Deal Capacity
  const capacity = maDeepDive.deal_capacity || {};
  if (capacity.financial_firepower || capacity.appetite_level) {
    mr = addSectionTitle(maSheet, 'Deal Capacity', mr);
    if (capacity.financial_firepower) {
      maSheet.getCell(`A${mr}`).value = 'Financial Firepower';
      maSheet.getCell(`A${mr}`).font = { bold: true };
      maSheet.getCell(`B${mr}`).value = capacity.financial_firepower;
      styleDataRow(maSheet.getRow(mr));
      mr++;
    }
    if (capacity.appetite_level) {
      maSheet.getCell(`A${mr}`).value = 'Appetite Level';
      maSheet.getCell(`A${mr}`).font = { bold: true };
      maSheet.getCell(`B${mr}`).value = capacity.appetite_level;
      if (capacity.appetite_level.includes('High')) {
        maSheet.getCell(`B${mr}`).font = { color: { argb: 'FF16A34A' }, bold: true };
      }
      styleDataRow(maSheet.getRow(mr), true);
      mr++;
    }
    if (capacity.decision_process) {
      maSheet.getCell(`A${mr}`).value = 'Decision Speed';
      maSheet.getCell(`A${mr}`).font = { bold: true };
      maSheet.getCell(`B${mr}`).value = capacity.decision_process;
      styleDataRow(maSheet.getRow(mr));
      mr++;
    }
  }

  // ========== SHEET 6: IDEAL TARGET (Deep Analysis) ==========
  const tpSheet = workbook.addWorksheet('Ideal Target');
  tpSheet.columns = [
    { key: 'a', width: 25 },
    { key: 'b', width: 75 }
  ];

  const idealTarget = synthesis.ideal_target || {};
  let tr = 1;

  // Strategic Analysis - The Deep Insight
  if (idealTarget.strategic_analysis) {
    tr = addSectionTitle(tpSheet, 'What They\'re Really Looking For', tr);
    tpSheet.mergeCells(`A${tr}:B${tr}`);
    tpSheet.getCell(`A${tr}`).value = idealTarget.strategic_analysis;
    tpSheet.getCell(`A${tr}`).alignment = { wrapText: true, vertical: 'top' };
    tpSheet.getRow(tr).height = 150;
    tr += 2;
  }

  // Sweet Spot - Key Criteria
  const sweetSpot = idealTarget.sweet_spot || {};
  if (Object.keys(sweetSpot).length > 0) {
    tr = addSectionTitle(tpSheet, 'The Sweet Spot', tr);
    const spotData = [
      ['Value Chain Position', sweetSpot.value_chain],
      ['Target Industries', sweetSpot.industries],
      ['Target Geographies', sweetSpot.geographies],
      ['Size Range', sweetSpot.size_range],
      ['Company Stage', sweetSpot.stage]
    ].filter(item => item[1]);

    spotData.forEach((item, i) => {
      tpSheet.getCell(`A${tr}`).value = item[0];
      tpSheet.getCell(`A${tr}`).font = { bold: true };
      tpSheet.getCell(`B${tr}`).value = item[1];
      tpSheet.getCell(`B${tr}`).alignment = { wrapText: true };
      styleDataRow(tpSheet.getRow(tr), i % 2 === 0);
      tr++;
    });
    tr++;
  }

  // Concrete Example
  if (idealTarget.example_target) {
    tr = addSectionTitle(tpSheet, 'Example of an Ideal Target', tr);
    tpSheet.mergeCells(`A${tr}:B${tr}`);
    tpSheet.getCell(`A${tr}`).value = idealTarget.example_target;
    tpSheet.getCell(`A${tr}`).alignment = { wrapText: true, vertical: 'top' };
    tpSheet.getCell(`A${tr}`).font = { italic: true, color: { argb: 'FF16A34A' } };
    tpSheet.getRow(tr).height = 60;
    tr += 2;
  }

  // What to Avoid
  if (idealTarget.what_to_avoid) {
    tr = addSectionTitle(tpSheet, 'What NOT to Pitch', tr);
    tpSheet.mergeCells(`A${tr}:B${tr}`);
    tpSheet.getCell(`A${tr}`).value = idealTarget.what_to_avoid;
    tpSheet.getCell(`A${tr}`).alignment = { wrapText: true };
    tpSheet.getCell(`A${tr}`).font = { color: { argb: 'FFDC2626' } };
    tpSheet.getRow(tr).height = 40;
  }

  // Generate buffer
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer.toString('base64');
}

// UTB API endpoint
app.post('/api/utb', async (req, res) => {
  const { companyName, website, context, email } = req.body;

  if (!companyName || !website || !email) {
    return res.status(400).json({ error: 'Company name, website, and email are required' });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[UTB] REQUEST: ${companyName}`);
  console.log(`[UTB] Website: ${website}`);
  console.log(`[UTB] Email: ${email}`);
  console.log(`[UTB] Context: ${context ? context.substring(0, 100) + '...' : 'None'}`);
  console.log('='.repeat(60));

  // Respond immediately
  res.json({ success: true, message: `UTB report for ${companyName} will be emailed in 10-15 minutes.` });

  try {
    // Conduct comprehensive research
    const research = await conductUTBResearch(companyName, website, context);

    // Generate Excel workbook with structured data
    const excelBase64 = await generateUTBExcel(companyName, website, research, context);

    // Send email with attachment
    await sendEmail(
      email,
      `UTB: ${companyName}`,
      `<div style="font-family:Arial,sans-serif;max-width:500px;">
        <h2 style="color:#1a365d;margin-bottom:5px;">${companyName}</h2>
        <p style="color:#64748b;margin-top:0;">${website}</p>
        <p>Your UTB buyer intelligence report is attached:</p>
        <ul style="font-size:13px;color:#475569;">
          <li><b>Executive Summary</b> - Company profile & leadership</li>
          <li><b>Financials</b> - Revenue breakdown & margins</li>
          <li><b>Products & Operations</b> - Business segments & capabilities</li>
          <li><b>Competitive Landscape</b> - Market position & moat</li>
          <li><b>M&A Deep Dive</b> - Deal-by-deal analysis & M&A philosophy</li>
          <li><b>Ideal Target</b> - Deep strategic analysis of what to pitch</li>
        </ul>
        <p style="font-size:12px;color:#94a3b8;">Generated: ${new Date().toLocaleString()}</p>
      </div>`,
      { content: excelBase64, name: `UTB_${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx` }
    );

    console.log(`[UTB] Excel report sent successfully to ${email}`);
  } catch (error) {
    console.error('[UTB] Error:', error);
    await sendEmail(email, `UTB Error - ${companyName}`, `<p>Error: ${error.message}</p>`).catch(() => {});
  }
});

// ============ DUE DILIGENCE REPORT GENERATOR ============

async function generateDueDiligenceReport(files, instructions, reportLength) {
  // Combine all file contents
  let combinedContent = '';
  const filesSummary = [];

  for (const file of files) {
    filesSummary.push(`- ${file.name} (${file.type.toUpperCase()})`);

    // Handle base64 encoded files (binary formats)
    if (file.content.startsWith('[BASE64:')) {
      combinedContent += `\n\n=== FILE: ${file.name} ===\n[Binary file - content summarized by AI]\n`;
    } else {
      combinedContent += `\n\n=== FILE: ${file.name} ===\n${file.content.substring(0, 50000)}\n`;
    }
  }

  const lengthInstructions = {
    short: `Create a concise 1-PAGE EXECUTIVE SUMMARY. Focus only on:
- Key business overview (2-3 sentences)
- Critical financial highlights (revenue, growth, margins)
- Top 3 opportunities
- Top 3 risks/red flags
- Clear recommendation (proceed/proceed with caution/pass)
Keep it extremely concise - this should fit on one page.`,

    medium: `Create a 2-3 PAGE due diligence report with these sections:
1. EXECUTIVE SUMMARY (1 paragraph)
2. BUSINESS OVERVIEW
   - Company description
   - Products/services
   - Market position
3. FINANCIAL ANALYSIS
   - Key metrics and trends
   - Revenue and profitability
4. KEY RISKS
   - Business risks
   - Financial risks
   - Operational concerns
5. OPPORTUNITIES
   - Growth potential
   - Synergies
6. RECOMMENDATION
Be thorough but concise. Focus on actionable insights.`,

    long: `Create a COMPREHENSIVE due diligence report with detailed analysis:

1. EXECUTIVE SUMMARY
   - Investment thesis
   - Key findings
   - Recommendation

2. COMPANY OVERVIEW
   - Business description
   - History and milestones
   - Corporate structure
   - Management team

3. INDUSTRY & MARKET ANALYSIS
   - Market size and growth
   - Competitive landscape
   - Industry trends
   - Regulatory environment

4. BUSINESS MODEL ANALYSIS
   - Revenue streams
   - Customer segments
   - Value proposition
   - Competitive advantages

5. FINANCIAL ANALYSIS
   - Historical performance
   - Revenue analysis
   - Profitability metrics
   - Cash flow analysis
   - Balance sheet review
   - Key ratios

6. OPERATIONAL REVIEW
   - Operations overview
   - Technology and systems
   - Supply chain
   - Human resources

7. RISK ASSESSMENT
   - Strategic risks
   - Operational risks
   - Financial risks
   - Legal/regulatory risks
   - Market risks

8. OPPORTUNITIES & SYNERGIES
   - Growth opportunities
   - Cost synergies
   - Revenue synergies
   - Strategic benefits

9. VALUATION CONSIDERATIONS
   - Comparable analysis
   - Key value drivers
   - Valuation ranges

10. DEAL CONSIDERATIONS
    - Key due diligence items
    - Critical success factors
    - Potential deal breakers
    - Next steps

11. APPENDICES
    - Key data tables
    - Supporting analysis

Be extremely thorough and detailed. Extract all relevant information from the materials.`
  };

  const prompt = `You are an expert M&A advisor creating a due diligence report.

MATERIALS PROVIDED:
${filesSummary.join('\n')}

${instructions ? `SPECIAL INSTRUCTIONS FROM CLIENT:\n${instructions}\n` : ''}

REPORT REQUIREMENTS:
${lengthInstructions[reportLength]}

MATERIAL CONTENTS:
${combinedContent.substring(0, 100000)}

Generate a professional due diligence report in HTML format. Use proper headings (<h1>, <h2>, <h3>), bullet points (<ul>, <li>), and tables where appropriate. Make it visually structured and easy to read.

IMPORTANT:
- Be specific with numbers, names, and facts from the materials
- Highlight red flags clearly
- Provide actionable recommendations
- Use professional M&A language
- If information is missing, note it as "Not provided in materials"`;

  try {
    const maxTokens = reportLength === 'short' ? 2000 : reportLength === 'medium' ? 4000 : 8000;

    // Try DeepSeek V3.2 first (more cost-effective)
    const deepseekResult = await callDeepSeek(prompt, maxTokens);
    if (deepseekResult) {
      console.log('[DD] Report generated using DeepSeek V3.2');
      return deepseekResult;
    }

    // Fallback to GPT-4o if DeepSeek unavailable
    console.log('[DD] Falling back to GPT-4o');
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: maxTokens
    });

    return response.choices[0].message.content || '';
  } catch (error) {
    console.error('Error in DD report generation:', error.message);
    throw error;
  }
}

app.post('/api/due-diligence', async (req, res) => {
  const {
    files = [],
    audioFiles = [],
    instructions,
    reportLength,
    outputType = 'dd_report',
    audioLang = 'auto',
    translateToEnglish = true,
    generateWord = true,
    email,
    // Real-time recording data
    rawTranscript,
    translatedTranscript,
    detectedLanguage,
    sessionId
  } = req.body;

  // Validate: need at least one file (document or audio) or transcript and email
  const hasContent = files.length > 0 || audioFiles.length > 0 || rawTranscript;
  if (!hasContent || !email) {
    return res.status(400).json({ error: 'At least one file/recording and email are required' });
  }

  const validLengths = ['short', 'medium', 'long'];
  const length = validLengths.includes(reportLength) ? reportLength : 'medium';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[DD] NEW DUE DILIGENCE REQUEST: ${new Date().toISOString()}`);
  console.log(`[DD] Documents: ${files.length}`);
  files.forEach(f => console.log(`     - ${f.name} (${f.type})`));
  console.log(`[DD] Audio Files: ${audioFiles.length}`);
  audioFiles.forEach(f => console.log(`     - ${f.name} (${f.mimeType})`));
  console.log(`[DD] Real-time Session: ${sessionId || 'None'}`);
  console.log(`[DD] Has Raw Transcript: ${rawTranscript ? 'Yes (' + rawTranscript.length + ' chars)' : 'No'}`);
  console.log(`[DD] Report Length: ${length}`);
  console.log(`[DD] Email: ${email}`);
  console.log(`[DD] Special Instructions: ${instructions ? instructions.substring(0, 100) + '...' : 'None'}`);
  console.log('='.repeat(60));

  // Respond immediately
  res.json({
    success: true,
    message: `DD Report & Transcript will be emailed within 10-15 minutes.`
  });

  try {
    // Step 1: Transcribe all audio files
    let transcripts = [];
    let detectedLanguages = [];

    for (const audioFile of audioFiles) {
      console.log(`[DD] Transcribing: ${audioFile.name}`);
      const result = await transcribeAudio(audioFile.content, audioFile.mimeType, audioLang);

      if (result.error) {
        console.error(`[DD] Transcription failed for ${audioFile.name}: ${result.error}`);
        transcripts.push({ name: audioFile.name, text: `[Transcription failed: ${result.error}]`, language: 'unknown' });
      } else {
        console.log(`[DD] Transcribed ${audioFile.name}: ${result.text.substring(0, 100)}... (${result.language})`);
        transcripts.push({
          name: audioFile.name,
          text: result.text,
          language: result.language,
          duration: result.duration
        });
        if (result.language && result.language !== 'unknown') {
          detectedLanguages.push(result.language);
        }
      }
    }

    // Step 2: Translate if needed
    let translatedTranscripts = [];
    for (const t of transcripts) {
      if (translateToEnglish && t.language !== 'en' && t.language !== 'english' && t.text.length > 10) {
        console.log(`[DD] Translating from ${t.language} to English: ${t.name}`);
        const translated = await translateText(t.text, 'en');
        translatedTranscripts.push({
          ...t,
          originalText: t.text,
          text: translated,
          wasTranslated: true
        });
      } else {
        translatedTranscripts.push({ ...t, wasTranslated: false });
      }
    }

    // Step 3: Combine all content
    let combinedTranscript = translatedTranscripts.map(t =>
      `=== ${t.name} ${t.wasTranslated ? `(Translated from ${t.language})` : ''} ===\n${t.text}`
    ).join('\n\n');

    // Step 4: Generate output based on type
    let outputContent = '';
    let emailSubject = '';
    let docTitle = '';

    if (output === 'transcript') {
      // Just return the transcript
      outputContent = `<h2>Transcripts</h2>`;
      for (const t of translatedTranscripts) {
        outputContent += `
          <div style="margin-bottom: 20px; padding: 15px; background: #f8fafc; border-radius: 8px;">
            <h3 style="margin: 0 0 10px 0; color: #1e40af;">${t.name}</h3>
            ${t.wasTranslated ? `<p style="font-size: 12px; color: #64748b; margin: 0 0 10px 0;"><em>Translated from ${t.language}</em></p>` : ''}
            ${t.duration ? `<p style="font-size: 12px; color: #64748b; margin: 0 0 10px 0;">Duration: ${Math.round(t.duration / 60)} minutes</p>` : ''}
            <p style="white-space: pre-wrap; line-height: 1.6;">${t.text}</p>
            ${t.wasTranslated ? `<details style="margin-top: 15px;"><summary style="cursor: pointer; color: #64748b;">Show Original (${t.language})</summary><p style="white-space: pre-wrap; margin-top: 10px; padding: 10px; background: #e2e8f0; border-radius: 4px;">${t.originalText}</p></details>` : ''}
          </div>`;
      }
      emailSubject = `Transcript - ${audioFiles[0]?.name || 'Recording'}`;
      docTitle = 'Transcript';

    } else if (output === 'meeting_minutes') {
      // Generate meeting minutes
      console.log('[DD] Generating meeting minutes...');
      outputContent = await generateMeetingMinutes(combinedTranscript, instructions);
      emailSubject = `Meeting Minutes - ${new Date().toLocaleDateString()}`;
      docTitle = 'Meeting Minutes';

    } else {
      // Generate full DD report
      console.log('[DD] Generating due diligence report...');

      // Add transcripts to files for processing
      const allFiles = [...files];
      if (combinedTranscript) {
        allFiles.push({
          name: 'Meeting Transcripts',
          type: 'transcript',
          content: combinedTranscript
        });
      }

      outputContent = await generateDueDiligenceReport(allFiles, instructions, length);
      const lengthLabel = { short: '1-Page Summary', medium: '2-3 Page Report', long: 'Comprehensive Report' };
      emailSubject = `Due Diligence Report - ${files[0]?.name || audioFiles[0]?.name || 'Analysis'} (${lengthLabel[length]})`;
      docTitle = 'Due Diligence Report';
    }

    // Step 5: Build email HTML
    const allFileNames = [...files.map(f => f.name), ...audioFiles.map(f => f.name)];
    const fileList = allFileNames.map(n => `<li>${n}</li>`).join('');

    const headerColors = {
      dd_report: 'linear-gradient(135deg, #1e40af 0%, #3b82f6 100%)',
      meeting_minutes: 'linear-gradient(135deg, #059669 0%, #10b981 100%)',
      transcript: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)'
    };

    const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
      <div style="background: ${headerColors[output]}; padding: 30px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">${docTitle}</h1>
        <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0 0;">${new Date().toLocaleDateString()}</p>
      </div>

      <div style="background: #f8fafc; padding: 20px; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0;">
        <p style="margin: 0; color: #64748b; font-size: 14px;"><strong>Materials Processed:</strong></p>
        <ul style="margin: 8px 0; padding-left: 20px; color: #475569; font-size: 13px;">${fileList}</ul>
        ${transcripts.length > 0 ? `<p style="margin: 8px 0 0 0; color: #64748b; font-size: 13px;"><strong>Audio Transcribed:</strong> ${transcripts.length} file(s) ${detectedLanguages.length > 0 ? `(${[...new Set(detectedLanguages)].join(', ')})` : ''}</p>` : ''}
        ${instructions ? `<p style="margin: 12px 0 0 0; color: #64748b; font-size: 13px;"><strong>Special Instructions:</strong> ${instructions}</p>` : ''}
      </div>

      <div style="background: white; padding: 30px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
        ${outputContent}
      </div>

      <div style="margin-top: 20px; padding: 15px; background: #f1f5f9; border-radius: 8px; font-size: 12px; color: #64748b;">
        <p style="margin: 0;">Generated: ${new Date().toLocaleString()}</p>
        <p style="margin: 4px 0 0 0;">This ${docTitle.toLowerCase()} is AI-generated and should be reviewed for accuracy.</p>
      </div>
    </div>`;

    // Step 6: Generate attachments (Word doc, transcript, audio)
    let attachments = [];
    const dateStr = new Date().toISOString().slice(0, 10);

    // 6a: Word document
    if (generateWord) {
      console.log('[DD] Generating Word document...');
      try {
        const wordBuffer = await generateWordDocument(docTitle, outputContent, {
          date: new Date().toLocaleDateString(),
          preparedFor: email
        });
        attachments.push({
          filename: `${docTitle.replace(/\s+/g, '_')}_${dateStr}.docx`,
          content: wordBuffer.toString('base64')
        });
        console.log('[DD] Word document generated');
      } catch (docError) {
        console.error('[DD] Word document generation failed:', docError.message);
      }
    }

    // 6b: Transcript text file (for safekeeping)
    const transcriptText = rawTranscript || combinedTranscript;
    if (transcriptText) {
      const transcriptContent = `TRANSCRIPT - ${new Date().toLocaleString()}
${'='.repeat(50)}

${translatedTranscript ? `ORIGINAL (${detectedLanguage || 'detected'}):\n${rawTranscript}\n\n${'='.repeat(50)}\n\nENGLISH TRANSLATION:\n${translatedTranscript}` : transcriptText}
`;
      attachments.push({
        filename: `Transcript_${dateStr}.txt`,
        content: Buffer.from(transcriptContent).toString('base64')
      });
      console.log('[DD] Transcript file attached');
    }

    // 6c: Audio recording (if from real-time session)
    if (sessionId && activeSessions.has(sessionId)) {
      const session = activeSessions.get(sessionId);
      if (session.audioChunks && session.audioChunks.length > 0) {
        console.log('[DD] Attaching audio recording from session...');
        try {
          const audioBuffer = Buffer.concat(session.audioChunks);
          attachments.push({
            filename: `Recording_${dateStr}.webm`,
            content: audioBuffer.toString('base64')
          });
          console.log(`[DD] Audio attached: ${audioBuffer.length} bytes`);
        } catch (audioError) {
          console.error('[DD] Audio attachment failed:', audioError.message);
        }
      }
    }

    // Step 7: Send email
    await sendEmail(email, emailSubject, emailHtml, attachments.length > 0 ? attachments : null);
    console.log(`[DD] ${docTitle} sent successfully to ${email}`);

  } catch (error) {
    console.error('[DD] Error:', error);
    try {
      await sendEmail(
        email,
        'Due Diligence Report - Error',
        `<div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #dc2626;">Error Processing Request</h2>
          <p>We encountered an error while processing your request:</p>
          <p style="background: #fee2e2; padding: 12px; border-radius: 6px; color: #991b1b;">${error.message}</p>
          <p>Please try again or contact support if the issue persists.</p>
        </div>`
      );
    } catch (emailError) {
      console.error('[DD] Failed to send error email:', emailError);
    }
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Find Target v40 - DD Report with Real-Time Transcription' });
});

// Check if real-time transcription is available
app.get('/api/transcription-status', (req, res) => {
  res.json({
    available: !!process.env.DEEPGRAM_API_KEY,
    message: process.env.DEEPGRAM_API_KEY ? 'Ready for real-time transcription' : 'DEEPGRAM_API_KEY not configured'
  });
});

// ============ WEBSOCKET SERVER FOR REAL-TIME TRANSCRIPTION ============

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Use noServer mode for better Railway compatibility
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrade manually
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname === '/ws/transcribe') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Store active sessions for recording storage
const activeSessions = new Map();

wss.on('connection', (ws, req) => {
  console.log('[WS] New client connected for real-time transcription');

  let deepgramConnection = null;
  let sessionId = Date.now().toString();
  let audioChunks = [];
  let fullTranscript = '';
  let detectedLanguage = 'en';
  let translatedTranscript = '';

  // Store session data
  activeSessions.set(sessionId, {
    startTime: new Date(),
    audioChunks: [],
    transcript: '',
    translatedTranscript: '',
    language: 'en'
  });

  // Send session ID to client
  ws.send(JSON.stringify({ type: 'session', sessionId }));

  ws.on('message', async (message) => {
    try {
      // Check if it's a control message (JSON) or audio data (binary)
      if (typeof message === 'string' || (message instanceof Buffer && message[0] === 123)) {
        const data = JSON.parse(message.toString());

        if (data.type === 'start') {
          // Start Deepgram connection
          console.log(`[WS] Starting transcription session ${sessionId}, language: ${data.language || 'auto'}`);

          if (!deepgram) {
            ws.send(JSON.stringify({ type: 'error', message: 'Deepgram API key not configured' }));
            return;
          }

          const dgOptions = {
            model: 'nova-2',
            smart_format: true,
            interim_results: true,
            utterance_end_ms: 1000,
            encoding: 'linear16',
            sample_rate: 16000,
            channels: 1,
            punctuate: true
          };

          // Set language - if not auto, use specific language
          if (data.language && data.language !== 'auto') {
            dgOptions.language = data.language;
          }
          // Note: removed detect_language as it may cause 400 errors

          console.log('[WS] Deepgram options:', JSON.stringify(dgOptions));

          deepgramConnection = deepgram.listen.live(dgOptions);

          deepgramConnection.on('open', () => {
            console.log(`[WS] Deepgram connection opened for session ${sessionId}`);
            ws.send(JSON.stringify({ type: 'ready' }));
          });

          deepgramConnection.on('Results', async (dgData) => {
            console.log('[WS] Deepgram data received:', JSON.stringify(dgData).substring(0, 200));
            const transcript = dgData.channel?.alternatives?.[0]?.transcript;
            const isFinal = dgData.is_final;
            const detLang = dgData.channel?.detected_language || detectedLanguage;

            if (detLang && detLang !== detectedLanguage) {
              detectedLanguage = detLang;
              activeSessions.get(sessionId).language = detLang;
            }

            if (transcript) {
              console.log(`[WS] Transcript: "${transcript}" (final: ${isFinal})`);
              // Send interim results to client
              ws.send(JSON.stringify({
                type: 'transcript',
                text: transcript,
                isFinal,
                language: detectedLanguage
              }));

              // Accumulate final transcripts
              if (isFinal) {
                fullTranscript += transcript + ' ';
                activeSessions.get(sessionId).transcript = fullTranscript;

                // If non-English, translate in real-time
                if (detectedLanguage !== 'en' && transcript.length > 5) {
                  try {
                    const translated = await translateText(transcript, 'en');
                    translatedTranscript += translated + ' ';
                    activeSessions.get(sessionId).translatedTranscript = translatedTranscript;
                    ws.send(JSON.stringify({
                      type: 'translation',
                      text: translated,
                      fullTranslation: translatedTranscript
                    }));
                  } catch (e) {
                    console.error('[WS] Translation error:', e.message);
                  }
                }
              }
            }
          });

          deepgramConnection.on('error', (error) => {
            console.error(`[WS] Deepgram error for session ${sessionId}:`, error);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
          });

          deepgramConnection.on('close', () => {
            console.log(`[WS] Deepgram connection closed for session ${sessionId}`);
          });

        } else if (data.type === 'stop') {
          // Stop transcription
          console.log(`[WS] Stopping transcription session ${sessionId}`);
          if (deepgramConnection) {
            deepgramConnection.finish();
            deepgramConnection = null;
          }

          // Get session data
          const session = activeSessions.get(sessionId);
          const duration = Math.round((Date.now() - session.startTime.getTime()) / 1000);

          // Upload audio to R2 if available
          let r2Key = null;
          if (session.audioChunks && session.audioChunks.length > 0) {
            const audioBuffer = Buffer.concat(session.audioChunks);
            const dateStr = new Date().toISOString().split('T')[0];
            r2Key = `recordings/${dateStr}/${sessionId}.pcm`;

            // Upload async - don't block response
            uploadToR2(r2Key, audioBuffer, 'audio/pcm').then(key => {
              if (key) {
                session.r2Key = key;
                console.log(`[WS] Recording saved to R2: ${key}`);
              }
            });
          }

          // Send final results
          ws.send(JSON.stringify({
            type: 'complete',
            sessionId,
            transcript: fullTranscript.trim(),
            translatedTranscript: translatedTranscript.trim(),
            language: detectedLanguage,
            duration,
            r2Key: r2Key // Include R2 key so frontend can download later
          }));
        }

      } else {
        // Binary audio data - forward to Deepgram
        if (deepgramConnection && deepgramConnection.getReadyState() === 1) {
          deepgramConnection.send(message);

          // Store audio chunk for later saving
          audioChunks.push(message);
          activeSessions.get(sessionId).audioChunks.push(message);
        }
      }
    } catch (error) {
      console.error('[WS] Error processing message:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected from session ${sessionId}`);
    if (deepgramConnection) {
      deepgramConnection.finish();
    }
    // Keep session data for 1 hour for retrieval
    setTimeout(() => {
      activeSessions.delete(sessionId);
    }, 3600000);
  });

  ws.on('error', (error) => {
    console.error(`[WS] WebSocket error for session ${sessionId}:`, error);
  });
});

// Endpoint to get session data (for generating reports after recording)
app.get('/api/transcription-session/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  res.json({
    transcript: session.transcript,
    translatedTranscript: session.translatedTranscript,
    language: session.language,
    duration: Math.round((Date.now() - session.startTime.getTime()) / 1000)
  });
});

// Endpoint to get audio from session (base64)
app.get('/api/transcription-session/:sessionId/audio', (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  // Combine audio chunks into single buffer
  const audioBuffer = Buffer.concat(session.audioChunks);
  const audioBase64 = audioBuffer.toString('base64');

  res.json({
    audio: audioBase64,
    mimeType: 'audio/webm',
    size: audioBuffer.length
  });
});

// Download recording from R2
app.get('/api/recording/:r2Key(*)', async (req, res) => {
  const r2Key = req.params.r2Key;

  if (!r2Key) {
    return res.status(400).json({ error: 'R2 key required' });
  }

  try {
    const audioBuffer = await downloadFromR2(r2Key);

    if (!audioBuffer) {
      return res.status(404).json({ error: 'Recording not found in R2' });
    }

    // Set headers for file download
    const filename = r2Key.split('/').pop() || 'recording.pcm';
    res.setHeader('Content-Type', 'audio/pcm');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', audioBuffer.length);
    res.send(audioBuffer);

  } catch (error) {
    console.error('[R2] Download endpoint error:', error);
    res.status(500).json({ error: 'Failed to download recording' });
  }
});

// List recordings for a session (checks both memory and R2)
app.get('/api/recording-status/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = activeSessions.get(sessionId);

  const result = {
    inMemory: false,
    inR2: false,
    r2Key: null,
    memorySize: 0
  };

  if (session) {
    result.inMemory = session.audioChunks && session.audioChunks.length > 0;
    result.memorySize = result.inMemory ? Buffer.concat(session.audioChunks).length : 0;
    result.r2Key = session.r2Key || null;
    result.inR2 = !!session.r2Key;
  }

  res.json(result);
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws/transcribe`);
});
