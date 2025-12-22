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
const Anthropic = require('@anthropic-ai/sdk');
const JSZip = require('jszip');

// ============ GLOBAL ERROR HANDLERS - PREVENT CRASHES ============
// Memory logging helper for debugging Railway OOM issues
function logMemoryUsage(label = '') {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  console.log(`  [Memory${label ? ': ' + label : ''}] Heap: ${heapUsedMB}/${heapTotalMB}MB, RSS: ${rssMB}MB`);
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('=== UNHANDLED PROMISE REJECTION ===');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  console.error('Stack:', reason?.stack || 'No stack trace');
  logMemoryUsage('at rejection');
  // Don't exit - keep the server running
});

process.on('uncaughtException', (error) => {
  console.error('=== UNCAUGHT EXCEPTION ===');
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
  logMemoryUsage('at exception');
  // Don't exit - keep the server running
});

// ============ TYPE SAFETY HELPERS ============
// Ensure a value is a string (AI models may return objects/arrays instead of strings)
function ensureString(value, defaultValue = '') {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return defaultValue;
  // Handle arrays - join with comma
  if (Array.isArray(value)) return value.map(v => ensureString(v)).join(', ');
  // Handle objects - try to extract meaningful string
  if (typeof value === 'object') {
    // Common patterns from AI responses
    if (value.city && value.country) return `${value.city}, ${value.country}`;
    if (value.text) return ensureString(value.text);
    if (value.value) return ensureString(value.value);
    if (value.name) return ensureString(value.name);
    // Fallback: stringify
    try { return JSON.stringify(value); } catch { return defaultValue; }
  }
  // Convert other types to string
  return String(value);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Multer configuration for file uploads (memory storage)
// Add 50MB limit to prevent OOM on Railway containers
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }  // 50MB max
});

// Check required environment variables
const requiredEnvVars = ['OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'GEMINI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
const optionalEnvVars = ['SERPAPI_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY']; // Optional but recommended
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
// Note: ANTHROPIC_API_KEY is optional - V5 uses Gemini + ChatGPT for search/validation

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'missing'
});

// Initialize Anthropic (Claude)
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

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

// Convert PCM to WAV format (adds header for playability)
function pcmToWav(pcmBuffer, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const wavBuffer = Buffer.alloc(fileSize);

  // RIFF header
  wavBuffer.write('RIFF', 0);
  wavBuffer.writeUInt32LE(fileSize - 8, 4);
  wavBuffer.write('WAVE', 8);

  // fmt chunk
  wavBuffer.write('fmt ', 12);
  wavBuffer.writeUInt32LE(16, 16); // fmt chunk size
  wavBuffer.writeUInt16LE(1, 20);  // audio format (1 = PCM)
  wavBuffer.writeUInt16LE(numChannels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  wavBuffer.write('data', 36);
  wavBuffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wavBuffer, 44);

  return wavBuffer;
}

// Extract text from .docx files (Word documents)
async function extractDocxText(base64Content) {
  try {
    const buffer = Buffer.from(base64Content, 'base64');
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    if (!documentXml) {
      return '[Could not extract text from Word document]';
    }

    // Extract text from XML, removing tags
    let text = documentXml
      .replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, '$1')  // Extract text content
      .replace(/<w:p[^>]*>/g, '\n')  // Paragraph breaks
      .replace(/<[^>]+>/g, '')  // Remove remaining tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n\s*\n/g, '\n\n')  // Clean up multiple newlines
      .trim();

    console.log(`[DD] Extracted ${text.length} chars from DOCX`);
    return text || '[Empty Word document]';
  } catch (error) {
    console.error('[DD] DOCX extraction error:', error.message);
    return `[Error extracting Word document: ${error.message}]`;
  }
}

// Extract text from .pptx files (PowerPoint)
async function extractPptxText(base64Content) {
  try {
    const buffer = Buffer.from(base64Content, 'base64');
    const zip = await JSZip.loadAsync(buffer);

    let allText = [];
    let slideNum = 1;

    // Iterate through slide files
    for (const filename of Object.keys(zip.files)) {
      if (filename.match(/ppt\/slides\/slide\d+\.xml$/)) {
        const slideXml = await zip.file(filename)?.async('string');
        if (slideXml) {
          // Extract text from slide
          let slideText = slideXml
            .replace(/<a:t>([^<]*)<\/a:t>/g, '$1 ')  // Extract text
            .replace(/<a:p[^>]*>/g, '\n')  // Paragraph breaks
            .replace(/<[^>]+>/g, '')  // Remove tags
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();

          if (slideText) {
            allText.push(`[Slide ${slideNum}]\n${slideText}`);
          }
          slideNum++;
        }
      }
    }

    const result = allText.join('\n\n') || '[Empty PowerPoint]';
    console.log(`[DD] Extracted ${result.length} chars from PPTX (${slideNum - 1} slides)`);
    return result;
  } catch (error) {
    console.error('[DD] PPTX extraction error:', error.message);
    return `[Error extracting PowerPoint: ${error.message}]`;
  }
}

// Extract text from .xlsx files (Excel)
async function extractXlsxText(base64Content) {
  try {
    const buffer = Buffer.from(base64Content, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });

    let allText = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) {
        allText.push(`[Sheet: ${sheetName}]\n${csv}`);
      }
    }

    const result = allText.join('\n\n') || '[Empty Excel file]';
    console.log(`[DD] Extracted ${result.length} chars from XLSX`);
    return result;
  } catch (error) {
    console.error('[DD] XLSX extraction error:', error.message);
    return `[Error extracting Excel: ${error.message}]`;
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
async function sendEmail(to, subject, html, attachments = null, maxRetries = 3) {
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
      filename: a.filename || a.name,  // Support both 'filename' and 'name' properties
      content: a.content,
      type: 'application/octet-stream',
      disposition: 'attachment'
    }));
  }

  // Retry logic with exponential backoff
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailData)
      });

      if (response.ok) {
        if (attempt > 1) {
          console.log(`  Email sent successfully on attempt ${attempt}`);
        }
        return { success: true };
      }

      const error = await response.text();
      lastError = new Error(`Email failed (attempt ${attempt}/${maxRetries}): ${error}`);
      console.error(lastError.message);

      // Don't retry on 4xx client errors (except 429 rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw lastError;
      }
    } catch (fetchError) {
      lastError = fetchError;
      console.error(`  Email attempt ${attempt}/${maxRetries} failed:`, fetchError.message);
    }

    // Exponential backoff: 2s, 4s, 8s
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`  Retrying email in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Email failed after all retries');
}

// ============ AI TOOLS ============

// Gemini 2.5 Flash-Lite - cost-effective for general tasks ($0.10/$0.40 per 1M tokens)
async function callGemini(prompt) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      timeout: 90000
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini 2.5 Flash-Lite HTTP error ${response.status}:`, errorText.substring(0, 200));
      return '';
    }

    const data = await response.json();

    if (data.error) {
      console.error('Gemini 2.5 Flash-Lite API error:', data.error.message);
      return '';
    }

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!result) {
      console.warn('Gemini 2.5 Flash-Lite returned empty response');
    }
    return result;
  } catch (error) {
    console.error('Gemini 2.5 Flash-Lite error:', error.message);
    return '';
  }
}

// Gemini 2.5 Flash - stable model for validation tasks (upgraded from gemini-3-flash-preview which was unstable)
// With GPT-4o fallback when Gemini fails or times out
async function callGemini3Flash(prompt, jsonMode = false) {
  try {
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1  // Low temperature for consistent validation
      }
    };

    // Add JSON mode if requested
    if (jsonMode) {
      requestBody.generationConfig.responseMimeType = 'application/json';
    }

    // Using stable gemini-2.5-flash (gemini-3-flash-preview was unreliable)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeout: 30000  // Reduced from 120s to 30s - fail fast and use GPT-4o fallback
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini 3 Flash HTTP error ${response.status}:`, errorText.substring(0, 200));
      // Fallback to GPT-4o on HTTP errors
      return await callGPT4oFallback(prompt, jsonMode, `Gemini HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      console.error('Gemini 3 Flash API error:', data.error.message);
      // Fallback to GPT-4o
      return await callGPT4oFallback(prompt, jsonMode, 'Gemini 3 Flash API error');
    }

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!result) {
      // Empty response, try fallback
      return await callGPT4oFallback(prompt, jsonMode, 'Gemini 3 Flash empty response');
    }
    return result;
  } catch (error) {
    console.error('Gemini 3 Flash error:', error.message);
    // Fallback to GPT-4o on network timeout or other errors
    return await callGPT4oFallback(prompt, jsonMode, `Gemini error: ${error.message}`);
  }
}

// GPT-4o fallback function for when Gemini fails
async function callGPT4oFallback(prompt, jsonMode = false, reason = '') {
  try {
    console.log(`  Falling back to GPT-4o (reason: ${reason})...`);

    const requestOptions = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1
    };

    // Add JSON mode if requested
    if (jsonMode) {
      requestOptions.response_format = { type: 'json_object' };
    }

    const response = await openai.chat.completions.create(requestOptions);
    const result = response.choices?.[0]?.message?.content || '';

    if (result) {
      console.log('  GPT-4o fallback successful');
    }
    return result;
  } catch (fallbackError) {
    console.error('GPT-4o fallback error:', fallbackError.message);
    return ''; // Return empty if both fail
  }
}

// Gemini 2.5 Pro - Most capable model for critical validation tasks
// Use this for final data accuracy verification where errors are unacceptable
async function callGemini2Pro(prompt, jsonMode = false) {
  try {
    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0  // Zero temperature for deterministic validation
      }
    };

    if (jsonMode) {
      requestBody.generationConfig.responseMimeType = 'application/json';
    }

    // Using stable gemini-2.5-pro (upgraded from deprecated gemini-2.5-pro-preview-06-05)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeout: 180000  // Longer timeout for Pro model
    });
    const data = await response.json();

    if (data.error) {
      console.error('Gemini 2.5 Pro API error:', data.error.message);
      return '';
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (error) {
    console.error('Gemini 2.5 Pro error:', error.message);
    return '';
  }
}

// Claude (Anthropic) - excellent reasoning and analysis
async function callClaude(prompt, systemPrompt = null, jsonMode = false) {
  if (!anthropic) {
    console.warn('Claude not available - ANTHROPIC_API_KEY not set');
    return '';
  }
  try {
    const messages = [{ role: 'user', content: prompt }];
    const requestParams = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages
    };

    if (systemPrompt) {
      requestParams.system = systemPrompt;
    }

    const response = await anthropic.messages.create(requestParams);
    const text = response.content?.[0]?.text || '';

    return text;
  } catch (error) {
    console.error('Claude error:', error.message);
    return '';
  }
}

// Claude with web search via Perplexity - Claude reasons, Perplexity searches
async function callClaudeWithSearch(searchPrompt, reasoningTask) {
  // Step 1: Use Perplexity to search the web
  const searchResults = await callPerplexity(searchPrompt);

  if (!searchResults) {
    return { searchResults: '', analysis: '' };
  }

  // Step 2: Use Claude to analyze and reason about the results
  const analysis = await callClaude(
    `Here are search results about: ${searchPrompt}

SEARCH RESULTS:
${searchResults}

YOUR TASK:
${reasoningTask}`,
    'You are an expert M&A research analyst. Analyze the search results thoroughly and extract all relevant information.'
  );

  return { searchResults, analysis };
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
        model: 'sonar-pro',  // Upgraded from 'sonar' for better search results
        messages: [{ role: 'user', content: prompt }]
      }),
      timeout: 90000
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Perplexity HTTP error ${response.status}:`, errorText.substring(0, 200));
      return '';
    }

    const data = await response.json();

    if (data.error) {
      console.error('Perplexity API error:', data.error.message || data.error);
      return '';
    }

    const result = data.choices?.[0]?.message?.content || '';
    if (!result) {
      console.warn('Perplexity returned empty response for prompt:', prompt.substring(0, 100));
    }
    return result;
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
    const result = response.choices[0].message.content || '';
    if (!result) {
      console.warn('ChatGPT returned empty response for prompt:', prompt.substring(0, 100));
    }
    return result;
  } catch (error) {
    console.error('ChatGPT error:', error.message);
    return '';
  }
}

// OpenAI Search model - has real-time web search capability
// Updated to use gpt-4o-search-preview (more stable than mini version)
async function callOpenAISearch(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-search-preview',
      messages: [{ role: 'user', content: prompt }]
    });
    const result = response.choices[0].message.content || '';
    if (!result) {
      console.warn('OpenAI Search returned empty response, falling back to ChatGPT');
      return callChatGPT(prompt);
    }
    return result;
  } catch (error) {
    console.error('OpenAI Search error:', error.message, '- falling back to ChatGPT');
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

// Detect domain/context from text for domain-aware translation
function detectMeetingDomain(text) {
  const domains = {
    financial: /\b(revenue|EBITDA|valuation|M&A|merger|acquisition|IPO|equity|debt|ROI|P&L|balance sheet|cash flow|投資|収益|利益|財務)\b/i,
    legal: /\b(contract|agreement|liability|compliance|litigation|IP|intellectual property|NDA|terms|clause|legal|lawyer|attorney|契約|法的|弁護士)\b/i,
    medical: /\b(clinical|trial|FDA|patient|therapeutic|drug|pharmaceutical|biotech|efficacy|dosage|治療|患者|医療|臨床)\b/i,
    technical: /\b(API|architecture|infrastructure|database|server|cloud|deployment|code|software|engineering|システム|開発|技術)\b/i,
    hr: /\b(employee|hiring|compensation|benefits|performance|talent|HR|recruitment|人事|採用|給与)\b/i
  };

  for (const [domain, pattern] of Object.entries(domains)) {
    if (pattern.test(text)) {
      return domain;
    }
  }
  return 'general';
}

// Get domain-specific translation instructions
function getDomainInstructions(domain) {
  const instructions = {
    financial: 'This is a financial/investment due diligence meeting. Preserve financial terms like M&A, EBITDA, ROI, P&L accurately. Use standard financial terminology.',
    legal: 'This is a legal due diligence meeting. Preserve legal terms and contract language precisely. Maintain formal legal register.',
    medical: 'This is a medical/pharmaceutical due diligence meeting. Preserve medical terminology, drug names, and clinical terms accurately.',
    technical: 'This is a technical due diligence meeting. Preserve technical terms, acronyms, and engineering terminology accurately.',
    hr: 'This is an HR/talent due diligence meeting. Preserve HR terminology and employment-related terms accurately.',
    general: 'This is a business due diligence meeting. Preserve business terminology and professional tone.'
  };
  return instructions[domain] || instructions.general;
}

// Translate text using GPT-4o with context awareness
async function translateText(text, targetLang = 'en', options = {}) {
  const { previousSegments = [], domain = null } = options;

  // Minimum length check - 3 chars for CJK languages, 10 for others
  const minLength = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text) ? 3 : 10;
  if (!text || text.length < minLength) return text;

  try {
    // Auto-detect domain if not provided
    const effectiveDomain = domain || detectMeetingDomain(text + ' ' + previousSegments.join(' '));
    const domainInstructions = getDomainInstructions(effectiveDomain);

    // Build context from previous segments
    let contextSection = '';
    if (previousSegments.length > 0) {
      contextSection = `\n\nPrevious context (for reference only, do not translate these):
${previousSegments.slice(-3).map((seg, i) => `[${i + 1}] ${seg}`).join('\n')}

Now translate the following new segment, maintaining consistency with the context above:`;
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',  // Use GPT-4o for better translation quality
      messages: [
        {
          role: 'system',
          content: `You are a professional translator specializing in business meeting transcriptions.
${domainInstructions}

Translate accurately while:
- Preserving the original meaning and tone
- Using natural, fluent ${targetLang === 'en' ? 'English' : targetLang}
- Keeping business/technical terms accurate
- Maintaining consistency with any provided context
- Not adding or omitting information
Output only the translation, nothing else.`
        },
        {
          role: 'user',
          content: contextSection ? `${contextSection}\n\n${text}` : text
        }
      ],
      temperature: 0.3  // Balanced temperature for fluency while maintaining consistency
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

  // Add title with Calibri font
  sections.push(new Paragraph({
    children: [new TextRun({ text: title, font: 'Calibri', size: 48, bold: true })],
    spacing: { after: 400 }
  }));

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
        children: [new TextRun({ text: parts[i + 1].replace('/H1', '').trim(), font: 'Calibri', size: 36, bold: true })],
        spacing: { before: 400, after: 200 }
      }));
      i++;
    } else if (part === 'H2' && parts[i + 1]) {
      sections.push(new Paragraph({
        children: [new TextRun({ text: parts[i + 1].replace('/H2', '').trim(), font: 'Calibri', size: 28, bold: true })],
        spacing: { before: 300, after: 150 }
      }));
      i++;
    } else if (part === 'H3' && parts[i + 1]) {
      sections.push(new Paragraph({
        children: [new TextRun({ text: parts[i + 1].replace('/H3', '').trim(), font: 'Calibri', size: 24, bold: true })],
        spacing: { before: 200, after: 100 }
      }));
      i++;
    } else if (!part.startsWith('/H')) {
      // Regular text
      const lines = part.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // Check if this line contains [Online Source] - highlight it yellow
        const isOnlineSource = trimmedLine.includes('[Online Source]');

        // Handle bold text markers
        const children = [];
        const boldParts = trimmedLine.split('**');
        for (let j = 0; j < boldParts.length; j++) {
          if (boldParts[j]) {
            children.push(new TextRun({
              text: boldParts[j],
              font: 'Calibri',
              size: 22,
              bold: j % 2 === 1,
              highlight: isOnlineSource ? 'yellow' : undefined
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
  // Security block patterns - these indicate WAF/Cloudflare/bot protection
  const securityBlockPatterns = [
    'checking your browser',
    'please wait',
    'just a moment',
    'ddos protection',
    'cloudflare',
    'security check',
    'access denied',
    'not acceptable',
    'mod_security',
    'forbidden',
    'blocked',
    'captcha',
    'verify you are human',
    'bot detection',
    'please enable javascript',
    'enable cookies'
  ];

  const tryFetch = async (targetUrl) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000); // Increased to 20 seconds
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        },
        signal: controller.signal,
        redirect: 'follow'
      });
      clearTimeout(timeout);

      // Check for HTTP-level blocks
      if (response.status === 403 || response.status === 406) {
        return { status: 'security_blocked', reason: `HTTP ${response.status} - WAF/Security block` };
      }
      if (!response.ok) return { status: 'error', reason: `HTTP ${response.status}` };

      const html = await response.text();
      const lowerHtml = html.toLowerCase();

      // Check for security block patterns in content
      for (const pattern of securityBlockPatterns) {
        if (lowerHtml.includes(pattern) && html.length < 5000) {
          // Only flag as security block if page is small (likely a challenge page)
          return { status: 'security_blocked', reason: `Security protection detected: "${pattern}"` };
        }
      }

      const cleanText = html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 15000);

      if (cleanText.length > 100) {
        return { status: 'ok', content: cleanText };
      }
      return { status: 'insufficient', reason: 'Content too short' };
    } catch (e) {
      return { status: 'error', reason: e.message || 'Connection failed' };
    }
  };

  // Parse base URL
  let baseUrl = url;
  try {
    const parsed = new URL(url);
    baseUrl = `${parsed.protocol}//${parsed.host}`;
  } catch (e) {
    baseUrl = url.replace(/\/+$/, '');
  }

  // Try original URL first
  let result = await tryFetch(url);
  if (result.status === 'ok') return result;
  if (result.status === 'security_blocked') return result; // Return security block immediately

  // Try with/without www
  const hasWww = baseUrl.includes('://www.');
  const altBaseUrl = hasWww ? baseUrl.replace('://www.', '://') : baseUrl.replace('://', '://www.');

  // Try alternative paths (limited to reduce time)
  const urlPaths = ['/en', '/home', '/about'];
  for (const path of urlPaths) {
    result = await tryFetch(baseUrl + path);
    if (result.status === 'ok') return result;
    if (result.status === 'security_blocked') return result;
  }

  // Try HTTPS if original was HTTP
  if (url.startsWith('http://')) {
    const httpsUrl = url.replace('http://', 'https://');
    result = await tryFetch(httpsUrl);
    if (result.status === 'ok') return result;
    if (result.status === 'security_blocked') return result;
  }

  return { status: 'inaccessible', reason: 'Could not fetch content from any URL variation' };
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

// ============ VALIDATION (v24 - GPT-4o with LENIENT filtering) ============

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
    try {
      const batch = companies.slice(i, i + batchSize);
      if (!batch || batch.length === 0) continue;

      // Use cached _pageContent from verification step, or fetch if not available
      // Add .catch() to prevent any single failure from crashing the batch
      const pageTexts = await Promise.all(
        batch.map(c => {
          try {
            return c?._pageContent ? Promise.resolve(c._pageContent) : fetchWebsite(c?.website).catch(() => null);
          } catch (e) {
            return Promise.resolve(null);
          }
        })
      );

      // Add .catch() to each validation to prevent single failures from crashing batch
      const validations = await Promise.all(
        batch.map((company, idx) => {
          try {
            return validateCompanyStrict(company, business, country, exclusion, pageTexts[idx])
              .catch(e => {
                console.error(`  Validation error for ${company?.company_name}: ${e.message}`);
                return { valid: true, corrected_hq: company?.hq }; // Accept on error
              });
          } catch (e) {
            return Promise.resolve({ valid: true, corrected_hq: company?.hq });
          }
        })
      );

      batch.forEach((company, idx) => {
        try {
          if (validations[idx]?.valid && company) {
            // Remove internal _pageContent before adding to results
            const { _pageContent, ...cleanCompany } = company;
            validated.push({
              ...cleanCompany,
              hq: validations[idx].corrected_hq || company.hq
            });
          }
        } catch (e) {
          console.error(`  Error processing company ${company?.company_name}: ${e.message}`);
        }
      });

      console.log(`  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`);
    } catch (batchError) {
      console.error(`  Batch error at ${i}-${i + batchSize}: ${batchError.message}`);
      // Continue to next batch instead of crashing
    }
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
    try {
      const batch = companies.slice(i, i + batchSize);
      if (!batch || batch.length === 0) continue;

      const pageTexts = await Promise.all(
        batch.map(c => fetchWebsite(c?.website).catch(() => null))
      );
      const validations = await Promise.all(
        batch.map((company, idx) =>
          validateCompany(company, business, country, exclusion, pageTexts[idx])
            .catch(e => {
              console.error(`  Validation error for ${company?.company_name}: ${e.message}`);
              return { valid: true, corrected_hq: company?.hq };
            })
        )
      );

      batch.forEach((company, idx) => {
        try {
          if (validations[idx]?.valid && company) {
            validated.push({
              ...company,
              hq: validations[idx].corrected_hq || company.hq
            });
          }
        } catch (e) {
          console.error(`  Error processing company ${company?.company_name}: ${e.message}`);
        }
      });

      console.log(`  Validated ${Math.min(i + batchSize, companies.length)}/${companies.length}. Valid: ${validated.length}`);
    } catch (batchError) {
      console.error(`  Batch error at ${i}-${i + batchSize}: ${batchError.message}`);
    }
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
          content: `If "${region}" is a geographic region (like "Southeast Asia", "Europe", "Middle East"), list only the MAJOR MARKETS in it.
For Southeast Asia: Malaysia, Thailand, Indonesia, Vietnam, Philippines, Singapore (exclude Cambodia, Laos, Myanmar, Brunei unless explicitly mentioned).
For other regions: focus on the main industrial/commercial markets, not every small country.
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

// ============ PHASE 0.5: INDUSTRY TERMINOLOGY DISCOVERY ============

// Dynamically discover all terminology and sub-segments for any industry
async function discoverIndustryTerminology(business, countries) {
  console.log('\n' + '='.repeat(50));
  console.log('PHASE 0.5: INDUSTRY TERMINOLOGY DISCOVERY');
  console.log('='.repeat(50));

  const countryList = countries.join(', ');

  const discoveryPrompt = `You are an industry research expert preparing for an EXHAUSTIVE company search.

TASK: Before searching for "${business}" companies, I need to understand ALL terminology and sub-segments used in this industry globally and specifically in ${countryList}.

Think deeply about this industry. Consider:
- How do companies in this industry describe themselves?
- What are all the technical terms, trade names, and jargon used?
- What sub-categories and niches exist?
- How might smaller local companies describe themselves differently than large corporations?

Provide a comprehensive list:

1. ALTERNATIVE TERMINOLOGY (at least 10-15 terms)
   - Synonyms and variations of "${business}"
   - Technical/trade terms that mean the same thing
   - How different companies might describe this business differently
   - Older/traditional terms vs modern terms

2. SUB-SEGMENTS (at least 8-10 segments)
   - All sub-categories within "${business}"
   - Specialized niches
   - Product-type or application-based variations
   - Process-based variations

3. RELATED/ADJACENT CATEGORIES (at least 5-8 categories)
   - Closely related businesses that might also qualify
   - Companies that do "${business}" as part of their broader offering

4. LOCAL LANGUAGE TERMS FOR ${countryList}
   - Translations of "${business}" and key terms into local languages
   - Local business terminology used in each country
   - How local companies might name themselves

Return as JSON:
{
  "primary_term": "${business}",
  "alternative_terms": ["term1", "term2", ...],
  "sub_segments": ["segment1", "segment2", ...],
  "related_categories": ["category1", "category2", ...],
  "local_terms": {
    "Country1": ["term1", "term2"],
    "Country2": ["term1", "term2"]
  }
}

Be EXHAUSTIVE. The goal is to ensure we don't miss any company due to terminology differences.`;

  try {
    // Query multiple AI models for comprehensive coverage
    console.log('  Querying GPT-4o, Gemini, and Perplexity for terminology discovery...');
    const [gptResult, geminiResult, perplexityResult] = await Promise.all([
      callOpenAISearch(discoveryPrompt).catch(e => { console.error('  GPT error:', e.message); return ''; }),
      callGemini(discoveryPrompt).catch(e => { console.error('  Gemini error:', e.message); return ''; }),
      callPerplexity(discoveryPrompt).catch(e => { console.error('  Perplexity error:', e.message); return ''; })
    ]);

    // Extract JSON from each result (with null safety)
    const extractJSON = (text) => {
      if (!text || typeof text !== 'string') return null;
      try {
        // Try to find JSON in the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        console.error('  JSON extraction error:', e.message);
      }
      return null;
    };

    const gptTerms = extractJSON(gptResult);
    const geminiTerms = extractJSON(geminiResult);
    const perplexityTerms = extractJSON(perplexityResult);

    // Merge all discovered terms
    const allTerms = new Set([business]); // Always include the original term
    const allSubSegments = new Set();
    const allRelated = new Set();
    const allLocalTerms = new Set();

    for (const result of [gptTerms, geminiTerms, perplexityTerms]) {
      if (!result) continue;

      if (Array.isArray(result.alternative_terms)) {
        result.alternative_terms.forEach(t => allTerms.add(t));
      }
      if (Array.isArray(result.sub_segments)) {
        result.sub_segments.forEach(t => allSubSegments.add(t));
      }
      if (Array.isArray(result.related_categories)) {
        result.related_categories.forEach(t => allRelated.add(t));
      }
      if (result.local_terms) {
        if (Array.isArray(result.local_terms)) {
          result.local_terms.forEach(t => allLocalTerms.add(t));
        } else if (typeof result.local_terms === 'object') {
          Object.values(result.local_terms).forEach(terms => {
            if (Array.isArray(terms)) {
              terms.forEach(t => allLocalTerms.add(t));
            }
          });
        }
      }
    }

    const terminology = {
      primary_term: business,
      alternative_terms: [...allTerms],
      sub_segments: [...allSubSegments],
      related_categories: [...allRelated],
      local_terms: [...allLocalTerms],
      all_search_terms: [...allTerms, ...allSubSegments, ...allRelated, ...allLocalTerms]
    };

    console.log(`  Discovered terminology:`);
    console.log(`    Alternative terms: ${terminology.alternative_terms.length}`);
    console.log(`    Sub-segments: ${terminology.sub_segments.length}`);
    console.log(`    Related categories: ${terminology.related_categories.length}`);
    console.log(`    Local language terms: ${terminology.local_terms.length}`);
    console.log(`    Total unique search terms: ${terminology.all_search_terms.length}`);

    // Log some examples
    if (terminology.alternative_terms.length > 0) {
      console.log(`    Examples: ${terminology.alternative_terms.slice(0, 5).join(', ')}...`);
    }

    return terminology;
  } catch (error) {
    console.error('  Error in terminology discovery:', error.message);
    // Return minimal terminology with just the original term
    return {
      primary_term: business,
      alternative_terms: [business],
      sub_segments: [],
      related_categories: [],
      local_terms: [],
      all_search_terms: [business]
    };
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
// terminology parameter contains dynamically discovered terms from Phase 0.5
function generateExpansionPrompt(round, business, country, existingList, shortlistSample, terminology = null) {
  const baseInstruction = `You are a thorough M&A researcher finding ALL ${business} companies in ${country}.
Return results as: Company Name | Website (must start with http)
Find at least 20 NEW companies not in our existing list.
DO NOT include companies from this list: ${existingList}`;

  const cities = getCitiesForCountry(country);
  const domain = getDomainForCountry(country);

  // Use dynamically discovered terminology if available
  const altTerms = terminology?.alternative_terms?.slice(0, 10).join(', ') || '';
  const subSegments = terminology?.sub_segments?.slice(0, 8).join(', ') || '';
  const localTerms = terminology?.local_terms?.slice(0, 10).join(', ') || '';
  const relatedCats = terminology?.related_categories?.slice(0, 5).join(', ') || '';

  const prompts = {
    1: `${baseInstruction}

ROUND 1 - RELATED TERMINOLOGY SEARCH:
The user searched for "${business}" but companies may use different terms.
${altTerms ? `We have discovered these alternative terms used in the industry: ${altTerms}` : ''}
${subSegments ? `Industry sub-segments to search: ${subSegments}` : ''}
${relatedCats ? `Related categories: ${relatedCats}` : ''}

Search using ALL these terminology variations to find companies we might otherwise miss.
Think about what OTHER words or phrases companies in this industry might use to describe themselves.`,

    2: `${baseInstruction}

ROUND 2 - DOMESTIC & LOCAL COMPANIES:
Focus ONLY on locally-owned, independent companies in ${country}.
Ignore subsidiaries of multinational corporations.
Look for:
- Family-owned businesses
- Local SMEs
- Domestic manufacturers
- Companies founded locally (not foreign subsidiaries)
${altTerms ? `Search using these terms: ${business}, ${altTerms}` : ''}
These are often harder to find but are the real targets.`,

    3: `${baseInstruction}

ROUND 3 - CITY-BY-CITY DEEP DIVE:
Search for ${business} companies in each of these cities/regions:
${cities ? cities.join(', ') : `Major cities and industrial areas in ${country}`}
Include companies in industrial estates, free trade zones, and business parks.
${subSegments ? `Also search for these sub-segments: ${subSegments}` : ''}`,

    4: `${baseInstruction}

ROUND 4 - TRADE ASSOCIATIONS & MEMBER DIRECTORIES:
Find ${business} companies that are members of:
- Industry associations relevant to ${business}
- Trade organizations
- Chamber of commerce
- Business federations
in ${country}. Look for member directories and lists.
${altTerms ? `Search for associations related to: ${altTerms}` : ''}`,

    5: `${baseInstruction}

ROUND 5 - LOCAL LANGUAGE SEARCH:
Search for ${business} companies in ${country} using LOCAL LANGUAGE terms.

${localTerms ? `Use these discovered local language terms: ${localTerms}` : `First, translate "${business}" into the local language(s) of ${country}.`}

IMPORTANT:
- Search using the local language translations
- Look for companies with local language names (not English names)
- Focus on companies that may only have local language websites
- Search local business directories using local language
- Think about how local entrepreneurs would name their company in their native language`,

    6: `${baseInstruction}

ROUND 6 - SUPPLY CHAIN SEARCH:
For companies like: ${shortlistSample}
Find their:
- Suppliers (who supplies to them)
- Customers (who buys from them)
- Raw material suppliers
that are also ${business} companies in ${country}.
${relatedCats ? `Also look for companies in related categories: ${relatedCats}` : ''}`,

    7: `${baseInstruction}

ROUND 7 - INDUSTRY PUBLICATIONS & ARTICLES:
Search for ${business} companies mentioned in:
- Industry magazines and trade publications for ${business}
- News articles about the ${business} industry in ${country}
- Trade publication interviews
- Company profiles in business journals
${subSegments ? `Also search for coverage of: ${subSegments}` : ''}`,

    8: `${baseInstruction}

ROUND 8 - TRADE SHOWS & EXHIBITIONS:
Find ${business} companies that exhibited at:
- Industry trade shows relevant to ${business} (past 3 years)
- B2B exhibitions
- Industry-specific fairs
in ${country} or international shows with ${country} exhibitors.
${altTerms ? `Search for exhibitors in: ${altTerms}` : ''}`,

    9: `${baseInstruction}

ROUND 9 - WHAT AM I MISSING?
I already found these companies: ${shortlistSample}
${altTerms ? `We searched for: ${business}, ${altTerms}` : ''}
${localTerms ? `Local terms used: ${localTerms}` : ''}

Think step by step: What ${business} companies in ${country} might I have MISSED?
- Companies with unusual names (especially local language names)
- Companies that don't advertise much
- Companies in smaller cities
- Companies that use completely different terminology to describe themselves
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
${altTerms ? `Search using ALL these terms: ${business}, ${altTerms}` : ''}
${localTerms ? `Don't forget local language searches: ${localTerms}` : ''}
${domain ? `Also search for companies with ${domain} domains.` : ''}
The goal is to find EVERY company, no matter how small or obscure.`
  };

  return prompts[round] || prompts[1];
}

// Run a single expansion round with all 3 search-enabled models
// terminology parameter contains dynamically discovered terms from Phase 0.5
async function runExpansionRound(round, business, country, existingCompanies, terminology = null) {
  console.log(`\n--- Expansion Round ${round}/10 ---`);

  try {
    const existingNames = (existingCompanies || [])
      .filter(c => c && c.company_name)
      .map(c => c.company_name.toLowerCase());

    const existingList = (existingCompanies || [])
      .filter(c => c && c.company_name)
      .slice(0, 30)
      .map(c => c.company_name)
      .join(', ');

    const shortlistSample = (existingCompanies || [])
      .filter(c => c && c.company_name)
      .slice(0, 10)
      .map(c => c.company_name)
      .join(', ');

    // Pass terminology to the prompt generator for dynamic term usage
    const prompt = generateExpansionPrompt(round, business, country, existingList, shortlistSample, terminology);

    // Run all 3 search-enabled models in parallel with error handling
    console.log(`  Querying GPT-4o-mini Search, Gemini 2.0 Flash, Perplexity Sonar...`);
    const [gptResult, geminiResult, perplexityResult] = await Promise.all([
      callOpenAISearch(prompt).catch(e => { console.error(`  GPT error: ${e.message}`); return ''; }),
      callGemini(prompt).catch(e => { console.error(`  Gemini error: ${e.message}`); return ''; }),
      callPerplexity(prompt).catch(e => { console.error(`  Perplexity error: ${e.message}`); return ''; })
    ]);

    // Extract companies from each result with error handling
    const [gptCompanies, geminiCompanies, perplexityCompanies] = await Promise.all([
      extractCompanies(gptResult, country).catch(() => []),
      extractCompanies(geminiResult, country).catch(() => []),
      extractCompanies(perplexityResult, country).catch(() => [])
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
  } catch (error) {
    console.error(`  Expansion round ${round} error: ${error.message}`);
    return []; // Return empty array on error instead of crashing
  }
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

    // ========== PHASE 0.5: Industry Terminology Discovery ==========
    let terminology;
    try {
      terminology = await discoverIndustryTerminology(Business, countries);
    } catch (termError) {
      console.error('Terminology discovery failed, using defaults:', termError.message);
      terminology = {
        primary_term: Business,
        alternative_terms: [Business],
        sub_segments: [],
        related_categories: [],
        local_terms: [],
        all_search_terms: [Business]
      };
    }

    // Build expanded search terms string for prompts (with null safety)
    const expandedTerms = (terminology.all_search_terms || [Business]).slice(0, 20).join(', ');
    const localTermsStr = (terminology.local_terms || []).slice(0, 10).join(', ');

    // ========== PHASE 1: Country-by-Country Direct Search ==========
    console.log('\n' + '='.repeat(50));
    console.log(`PHASE 1: COUNTRY-BY-COUNTRY SEARCH (${countries.length} countries)`);
    console.log('='.repeat(50));

    let allPhase1Companies = [];

    // For each country, do a direct AI search using discovered terminology
    for (const targetCountry of countries) {
      try {
        console.log(`\n--- Searching: ${targetCountry} ---`);

        // Enhanced prompt using discovered terminology
        const directPrompt = `List ALL companies in ${targetCountry} that are in ANY of these categories:
- ${Business}
- Alternative terms: ${expandedTerms}
${localTermsStr ? `- Local language terms: ${localTermsStr}` : ''}

Include:
- Large and small companies
- Local/domestic companies
- Lesser-known companies
- Companies that may describe themselves differently but do the same business
Exclude: ${Exclusion}
Return as: Company Name | Website (must start with http)
Find as many as possible - be exhaustive. Search using ALL the terminology variations above.`;

        // Ask all 3 AI models the same direct question with error handling
        const [gptResult, geminiResult, perplexityResult] = await Promise.all([
          callOpenAISearch(directPrompt).catch(e => { console.error(`  GPT error: ${e.message}`); return ''; }),
          callGemini(directPrompt).catch(e => { console.error(`  Gemini error: ${e.message}`); return ''; }),
          callPerplexity(directPrompt).catch(e => { console.error(`  Perplexity error: ${e.message}`); return ''; })
        ]);

        // Extract companies with error handling
        const [gptCompanies, geminiCompanies, perplexityCompanies] = await Promise.all([
          extractCompanies(gptResult, targetCountry).catch(() => []),
          extractCompanies(geminiResult, targetCountry).catch(() => []),
          extractCompanies(perplexityResult, targetCountry).catch(() => [])
        ]);

        console.log(`  GPT: ${gptCompanies.length} | Gemini: ${geminiCompanies.length} | Perplexity: ${perplexityCompanies.length}`);
        allPhase1Companies = [...allPhase1Companies, ...gptCompanies, ...geminiCompanies, ...perplexityCompanies];
      } catch (countryError) {
        console.error(`  Error searching ${targetCountry}: ${countryError.message}`);
        // Continue to next country instead of crashing
      }
    }

    // Also run terminology-enhanced exhaustive search for the full region
    console.log(`\n--- Full Region Search with Expanded Terminology: ${Country} ---`);

    // Run primary search first with error handling
    let regionCompanies = [];
    console.log(`  Searching with primary term: ${Business}`);
    try {
      const primaryResults = await exhaustiveSearch(Business, Country, Exclusion);
      regionCompanies = [...primaryResults];
      console.log(`  Primary term found: ${primaryResults.length} companies`);
    } catch (e) {
      console.error(`  Primary search error: ${e.message}`);
    }

    // Then run ONE additional search with the best alternative term (sequential to avoid overwhelming APIs)
    const altTerms = terminology.alternative_terms || [];
    const topAlternative = altTerms.find(t => t !== Business && t.length > 3);
    if (topAlternative) {
      console.log(`  Searching with alternative term: ${topAlternative}`);
      try {
        const altResults = await exhaustiveSearch(topAlternative, Country, Exclusion);
        regionCompanies = [...regionCompanies, ...altResults];
        console.log(`  Alternative term found: ${altResults.length} companies`);
      } catch (e) {
        console.error(`  Alternative search error: ${e.message}`);
      }
    }

    console.log(`Region search total: ${regionCompanies.length} companies`);
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
      try {
        const roundStart = Date.now();

        // Cycle through countries for each round
        const targetCountry = countries[round % countries.length];
        // Pass terminology to enable dynamic term usage in expansion rounds
        const newCompanies = await runExpansionRound(round, Business, targetCountry, allCompanies, terminology);

        if (newCompanies && newCompanies.length > 0) {
          allCompanies = dedupeCompanies([...allCompanies, ...newCompanies]);
          totalNewFound += newCompanies.length;
        }

        const roundTime = ((Date.now() - roundStart) / 1000).toFixed(1);
        console.log(`  Round ${round}/10 [${targetCountry}]: +${(newCompanies || []).length} new (${roundTime}s). Total: ${allCompanies.length}`);
      } catch (roundError) {
        console.error(`  Round ${round} error: ${roundError.message}`);
        // Continue to next round instead of crashing
      }
    }

    console.log(`\nPhase 2 complete. Found ${totalNewFound} additional companies.`);

    // ========== PHASE 3: Final Validation ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 3: FINAL VALIDATION');
    console.log('='.repeat(50));

    let finalCompanies = [...shortlistA]; // Start with already validated companies

    try {
      console.log(`Total candidates: ${allCompanies.length}`);

      const phase2New = allCompanies.filter(c =>
        !shortlistA.some(s => s.company_name === c.company_name)
      );
      console.log(`New from Phase 2 (need validation): ${phase2New.length}`);

      if (phase2New.length > 0) {
        const preFiltered2 = preFilterCompanies(phase2New);
        const validated2 = await parallelValidationStrict(preFiltered2, Business, Country, Exclusion);
        console.log(`Phase 2 validated: ${validated2.length}`);
        finalCompanies = dedupeCompanies([...shortlistA, ...validated2]);
      }
    } catch (phase3Error) {
      console.error(`Phase 3 validation error: ${phase3Error.message}`);
      // Continue with what we have from shortlistA
    }

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

// ============ V5 AGENTIC SEARCH ============

// Gemini 2.0 Flash with Google Search grounding - for deep agentic search
// The model can execute multiple searches per request and iterate until exhaustive
async function callGemini2FlashWithSearch(prompt, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Use gemini-2.5-flash which supports Google Search grounding (gemini-3-flash-preview doesn't support search grounding yet)
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 8192
          }
        }),
        timeout: 180000  // 3 minutes for deep search
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Gemini 2.5 Flash Search HTTP error ${response.status} (attempt ${attempt + 1}):`, errorText.substring(0, 200));
        if (attempt === maxRetries) return { text: '', groundingMetadata: null };
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }

      const data = await response.json();

      if (data.error) {
        console.error(`Gemini 2.5 Flash Search API error (attempt ${attempt + 1}):`, data.error.message);
        if (attempt === maxRetries) return { text: '', groundingMetadata: null };
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const groundingMetadata = data.candidates?.[0]?.groundingMetadata || null;

      // Log grounding info for debugging
      if (groundingMetadata) {
        console.log(`    Grounding: ${groundingMetadata.webSearchQueries?.length || 0} queries, ${groundingMetadata.groundingChunks?.length || 0} chunks`);
      } else {
        console.warn('    No grounding metadata returned - search may not have executed');
      }

      if (!text) {
        console.warn('    Gemini 2.5 Flash Search returned empty text');
      }

      return { text, groundingMetadata };
    } catch (error) {
      console.error(`Gemini 2.5 Flash Search error (attempt ${attempt + 1}):`, error.message);
      if (attempt === maxRetries) return { text: '', groundingMetadata: null };
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return { text: '', groundingMetadata: null };
}

// Extract companies from Gemini search response using Gemini 3 Flash for quality
async function extractCompaniesV5(text, country) {
  if (!text || text.length < 50) return [];
  try {
    const extraction = await callGemini3Flash(`Extract company information from the text. Return JSON: {"companies": [{"company_name": "...", "website": "...", "hq": "..."}]}

RULES:
- Extract ALL companies mentioned that could be in: ${country}
- website must start with http:// or https://
- If website not mentioned, use "unknown" (we'll find it later)
- hq must be "City, Country" format
- Include companies even if some info is incomplete
- Be THOROUGH - extract EVERY company mentioned, even briefly

TEXT:
${text.substring(0, 40000)}`, true);

    // Parse JSON from response
    try {
      const jsonMatch = extraction.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return Array.isArray(parsed.companies) ? parsed.companies : [];
      }
    } catch (e) {
      console.error('V5 JSON parse error:', e.message);
    }
    return [];
  } catch (e) {
    console.error('V5 Extraction error:', e.message);
    return [];
  }
}

// Run a single deep agentic search task
// This gives the AI full agency to search multiple times until exhaustive
async function runAgenticSearchTask(taskPrompt, country, searchLog) {
  const startTime = Date.now();

  console.log(`  Executing agentic search task...`);
  const result = await callGemini2FlashWithSearch(taskPrompt);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Extract grounding info for logging
  const searchQueries = result.groundingMetadata?.webSearchQueries || [];
  const sources = result.groundingMetadata?.groundingChunks?.map(c => c.web?.uri).filter(Boolean) || [];

  console.log(`    Completed in ${duration}s. Searches: ${searchQueries.length}. Sources: ${sources.length}`);

  // Log this search
  searchLog.push({
    task: taskPrompt.substring(0, 100) + '...',
    duration: parseFloat(duration),
    searchQueries,
    sourceCount: sources.length,
    responseLength: result.text.length
  });

  // Extract companies from result
  const companies = await extractCompaniesV5(result.text, country);
  console.log(`    Extracted ${companies.length} companies`);

  return companies;
}

// Run a ChatGPT-powered search task (GPT-4o Search with web grounding)
async function runChatGPTSearchTask(searchQuery, reasoningTask, country, searchLog) {
  const startTime = Date.now();
  console.log(`  Executing ChatGPT Search task...`);

  // ChatGPT Search - it has built-in web search and will return comprehensive results
  const searchPrompt = `You are an M&A research analyst. Search the web and find ALL relevant companies.

SEARCH QUERY: ${searchQuery}

TASK: ${reasoningTask}

INSTRUCTIONS:
1. Search the web comprehensively for companies matching this query
2. Look at multiple sources - company directories, industry associations, trade publications
3. Don't stop at the first few results - dig deeper

For EACH company found, provide:
- Company name (official name)
- Website (must be real company website, not directory)
- Headquarters location (City, Country)

Be thorough - find EVERY company you can. Return as a structured list.`;

  const searchResult = await callOpenAISearch(searchPrompt);

  if (!searchResult) {
    console.log(`    ChatGPT returned no results`);
    searchLog.push({
      task: `[ChatGPT] ${searchQuery.substring(0, 80)}...`,
      duration: ((Date.now() - startTime) / 1000),
      searchQueries: [searchQuery],
      sourceCount: 0,
      responseLength: 0,
      model: 'chatgpt-search'
    });
    return [];
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`    Completed in ${duration}s`);

  searchLog.push({
    task: `[ChatGPT] ${searchQuery.substring(0, 80)}...`,
    duration: parseFloat(duration),
    searchQueries: [searchQuery],
    sourceCount: 1,
    responseLength: searchResult.length,
    model: 'chatgpt-search'
  });

  // Extract companies from ChatGPT's response
  const companies = await extractCompaniesV5(searchResult, country);
  console.log(`    Extracted ${companies.length} companies`);

  return companies;
}

// Expand regional inputs to individual countries using AI
async function expandRegionToCountries(regionInput) {
  const inputLower = regionInput.toLowerCase();

  // If comma-separated, user already specified countries - return as-is
  if (inputLower.includes(',')) {
    return regionInput;
  }

  // Hardcoded region mappings (main business markets only)
  const regionMappings = {
    // Southeast Asia - 6 main markets (exclude Cambodia, Laos, Myanmar unless explicit)
    'southeast asia': 'Malaysia, Indonesia, Singapore, Thailand, Vietnam, Philippines',
    'south east asia': 'Malaysia, Indonesia, Singapore, Thailand, Vietnam, Philippines',
    'sea': 'Malaysia, Indonesia, Singapore, Thailand, Vietnam, Philippines',
    'asean': 'Malaysia, Indonesia, Singapore, Thailand, Vietnam, Philippines',

    // Other common regions
    'east asia': 'Japan, South Korea, Taiwan, China, Hong Kong',
    'north asia': 'Japan, South Korea, Taiwan, China',
    'south asia': 'India, Pakistan, Bangladesh, Sri Lanka',
    'middle east': 'UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, Oman',
    'gcc': 'UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, Oman',
    'europe': 'Germany, France, UK, Italy, Spain, Netherlands, Poland',
    'western europe': 'Germany, France, UK, Italy, Spain, Netherlands, Belgium',
    'eastern europe': 'Poland, Czech Republic, Romania, Hungary, Slovakia',
    'apac': 'Malaysia, Indonesia, Singapore, Thailand, Vietnam, Philippines, Japan, South Korea, Taiwan, China, India, Australia',
    'asia pacific': 'Malaysia, Indonesia, Singapore, Thailand, Vietnam, Philippines, Japan, South Korea, Taiwan, China, India, Australia',
    'latam': 'Brazil, Mexico, Argentina, Chile, Colombia, Peru',
    'latin america': 'Brazil, Mexico, Argentina, Chile, Colombia, Peru'
  };

  // Check for matching region
  for (const [region, countries] of Object.entries(regionMappings)) {
    if (inputLower.includes(region)) {
      console.log(`  Expanding region "${regionInput}" → "${countries}"`);
      return countries;
    }
  }

  // Check for generic "asia" (default to Southeast Asia main markets)
  if (inputLower === 'asia') {
    const countries = 'Malaysia, Indonesia, Singapore, Thailand, Vietnam, Philippines';
    console.log(`  Expanding region "${regionInput}" → "${countries}"`);
    return countries;
  }

  // Return as-is if not a recognized region
  return regionInput;
}

// Generate business term variations using AI (synonyms, industry terminology)
async function generateBusinessTermVariations(business) {
  console.log(`  Generating search term variations for "${business}"...`);

  const prompt = `For M&A target search, generate alternative search terms for: "${business}"

RULES:
- Generate 3-5 alternative phrasings/synonyms that mean the SAME specific thing
- Include common industry terminology variations
- Include abbreviations if applicable
- Do NOT broaden the scope (e.g., don't suggest "printing ink" for "gravure ink" - stay specific)
- Focus on how different people might describe this EXACT business

Examples:
- "gravure ink manufacturer" → "rotogravure ink producer", "gravure printing ink maker", "intaglio ink manufacturer"
- "flexure ink" → "flexographic ink", "flexo ink", "flexible packaging ink"
- "CNC machining" → "computer numerical control machining", "precision CNC", "CNC manufacturing"

Return ONLY a JSON array of strings, nothing else.
Example: ["term1", "term2", "term3"]

Variations for "${business}":`;

  try {
    const result = await callGemini3Flash(prompt, true);
    if (result) {
      const jsonMatch = result.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        const variations = JSON.parse(jsonMatch[0]);
        if (Array.isArray(variations) && variations.length > 0) {
          console.log(`  Generated variations: ${variations.join(', ')}`);
          return variations;
        }
      }
    }
  } catch (e) {
    console.error(`  Term variation generation failed: ${e.message}`);
  }

  return []; // Return empty array if generation fails
}

// ============ V5 PARALLEL ARCHITECTURE ============

// Phase 0: Plan search strategy - determine languages, generate comprehensive search plan
async function planSearchStrategyV5(business, country, exclusion) {
  console.log('\n' + '='.repeat(50));
  console.log('PHASE 0: PLANNING SEARCH STRATEGY');
  console.log('='.repeat(50));

  const startTime = Date.now();

  // Expand regional inputs to specific countries
  const expandedCountry = await expandRegionToCountries(country);
  console.log(`  Country input: "${country}" → "${expandedCountry}"`);

  // Generate business term variations
  const businessVariations = await generateBusinessTermVariations(business);
  console.log(`  Term variations: ${businessVariations.length > 0 ? businessVariations.join(', ') : 'none generated'}`);

  // Determine languages for each country
  const countries = expandedCountry.split(',').map(c => c.trim());
  const countryLanguages = {};
  for (const c of countries) {
    const cLower = c.toLowerCase();
    if (cLower.includes('thailand')) countryLanguages[c] = 'Thai';
    else if (cLower.includes('vietnam')) countryLanguages[c] = 'Vietnamese';
    else if (cLower.includes('indonesia')) countryLanguages[c] = 'Indonesian/Bahasa';
    else if (cLower.includes('malaysia')) countryLanguages[c] = 'Malay/Chinese';
    else if (cLower.includes('philippines')) countryLanguages[c] = 'Filipino/English';
    else if (cLower.includes('japan')) countryLanguages[c] = 'Japanese';
    else if (cLower.includes('korea')) countryLanguages[c] = 'Korean';
    else if (cLower.includes('china')) countryLanguages[c] = 'Chinese';
    else if (cLower.includes('taiwan')) countryLanguages[c] = 'Chinese';
    else countryLanguages[c] = 'English/Local';
  }

  console.log(`  Languages: ${Object.entries(countryLanguages).map(([c, l]) => `${c}=${l}`).join(', ')}`);
  console.log(`  Planning completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  return {
    expandedCountry,
    countries,
    businessVariations,
    countryLanguages
  };
}

// Run a single Perplexity search task
async function runPerplexitySearchTask(searchPrompt, country, searchLog) {
  const startTime = Date.now();

  console.log(`  Executing Perplexity search...`);
  const result = await callPerplexity(searchPrompt);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`    Completed in ${duration}s`);

  // Log this search
  searchLog.push({
    task: `[Perplexity] ${searchPrompt.substring(0, 80)}...`,
    duration: parseFloat(duration),
    searchQueries: [searchPrompt.substring(0, 100)],
    sourceCount: 1,
    responseLength: result.length,
    model: 'perplexity-sonar-pro'
  });

  // Extract companies from result
  const companies = await extractCompaniesV5(result, country);
  console.log(`    Extracted ${companies.length} companies`);

  return companies;
}

// Phase 1: Perplexity main search with batched validation
// Key: Run searches in 4 batches to avoid rate limits, validate each batch before next
async function runPerplexityMainSearchWithValidation(plan, business, exclusion, searchLog) {
  console.log('\n' + '='.repeat(50));
  console.log('PHASE 1: PERPLEXITY MAIN SEARCH (BATCHED) + VALIDATION');
  console.log('='.repeat(50));

  const { expandedCountry, countries, businessVariations } = plan;
  const startTime = Date.now();

  // Generate Perplexity search queries - comprehensive but focused
  const perplexityQueries = [
    // Main comprehensive search
    `List ALL ${business} companies, manufacturers, and producers in ${expandedCountry}.
     Include: company names, official websites (not directories), headquarters locations.
     Be EXHAUSTIVE - find every company you can. Include large, medium, and small companies.
     EXCLUSIONS: ${exclusion}`,

    // SME and local focus
    `Find small and medium-sized ${business} companies in ${expandedCountry}.
     Focus on: family businesses, local manufacturers, independent producers.
     These are often acquisition targets. Include websites and HQ locations.
     Exclude large multinationals and ${exclusion}`,

    // Industry associations and directories
    `Find ${business} companies through industry associations and trade directories in ${expandedCountry}.
     Search: association member lists, trade show exhibitors, certification bodies.
     Return company names, websites, and locations.`,

    // Contract manufacturing and suppliers
    `Find ${business} OEM, ODM, and contract manufacturers in ${expandedCountry}.
     Include: toll manufacturers, private label producers, subcontractors.
     Return company names, websites, and HQ locations.`,

    // Supply chain exploration
    `Who are the ${business} suppliers and manufacturers in ${expandedCountry}?
     Look at: raw material suppliers, equipment manufacturers, finished goods producers.
     Return company names, official websites, and headquarters.`
  ];

  // Add country-specific searches
  for (const c of countries.slice(0, 4)) {
    perplexityQueries.push(
      `Complete list of ${business} companies in ${c}.
       Include all manufacturers, industrial estates, and local producers.
       Return company name, website, and city location.`
    );
  }

  // Add term variation searches
  for (const variation of businessVariations.slice(0, 3)) {
    perplexityQueries.push(
      `Find ${variation} companies and manufacturers in ${expandedCountry}.
       Return company names, websites, and headquarters locations.`
    );
  }

  console.log(`  Generated ${perplexityQueries.length} Perplexity search queries`);

  // Split queries into 4 batches to avoid rate limits
  const batchSize = Math.ceil(perplexityQueries.length / 4);
  const batches = [];
  for (let i = 0; i < perplexityQueries.length; i += batchSize) {
    batches.push(perplexityQueries.slice(i, i + batchSize));
  }

  console.log(`  Split into ${batches.length} batches (${batches.map(b => b.length).join(', ')} queries each)`);

  // Accumulate results across batches
  const allValidated = [];
  const allFlagged = [];
  const allRejected = [];
  const seenWebsites = new Set(); // Track already validated websites

  // Process each batch: search → dedupe → validate → next batch
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    console.log(`\n  --- BATCH ${batchIdx + 1}/${batches.length} (${batch.length} queries) ---`);

    // Run this batch of Perplexity searches in parallel
    const searchPromises = batch.map((query, idx) =>
      runPerplexitySearchTask(query, expandedCountry, searchLog)
        .catch(e => {
          console.error(`    Perplexity batch ${batchIdx + 1} query ${idx + 1} failed: ${e.message}`);
          return [];
        })
    );

    const searchResults = await Promise.all(searchPromises);
    let batchCompanies = searchResults.flat();
    console.log(`    Found ${batchCompanies.length} companies (before dedup)`);

    // Dedupe within batch
    const uniqueBatch = dedupeCompanies(batchCompanies);
    console.log(`    After dedup: ${uniqueBatch.length} unique companies`);

    // Remove companies already validated in previous batches
    const newCompanies = uniqueBatch.filter(c => {
      const website = c.website?.toLowerCase();
      if (!website || seenWebsites.has(website)) return false;
      return true;
    });
    console.log(`    New companies (not in previous batches): ${newCompanies.length}`);

    if (newCompanies.length === 0) {
      console.log(`    Skipping validation - no new companies`);
      continue;
    }

    // Pre-filter
    const preFiltered = preFilterCompanies(newCompanies);
    console.log(`    After pre-filter: ${preFiltered.length} companies`);

    if (preFiltered.length === 0) {
      console.log(`    Skipping validation - no companies after pre-filter`);
      continue;
    }

    // Validate this batch
    console.log(`    Validating ${preFiltered.length} companies...`);
    const batchResults = await validateCompaniesV5(preFiltered, business, expandedCountry, exclusion);

    // Add to accumulated results
    allValidated.push(...batchResults.validated);
    allFlagged.push(...batchResults.flagged);
    allRejected.push(...batchResults.rejected);

    // Track validated websites to avoid re-validating
    for (const c of [...batchResults.validated, ...batchResults.flagged, ...batchResults.rejected]) {
      if (c.website) seenWebsites.add(c.website.toLowerCase());
    }

    console.log(`    Batch ${batchIdx + 1} results: ${batchResults.validated.length} valid, ${batchResults.flagged.length} flagged, ${batchResults.rejected.length} rejected`);
    console.log(`    Running totals: ${allValidated.length} valid, ${allFlagged.length} flagged, ${allRejected.length} rejected`);
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n  Phase 1 completed in ${duration} minutes`);
  console.log(`    Validated: ${allValidated.length}`);
  console.log(`    Flagged: ${allFlagged.length}`);
  console.log(`    Rejected: ${allRejected.length}`);

  return { validated: allValidated, flagged: allFlagged, rejected: allRejected };
}

// Phase 2: Parallel Gemini + ChatGPT secondary searches
// Key: Run 5 Gemini and 5 ChatGPT searches SIMULTANEOUSLY (not sequentially)
async function runParallelSecondarySearches(plan, business, exclusion, searchLog) {
  console.log('\n' + '='.repeat(50));
  console.log('PHASE 2: PARALLEL GEMINI + CHATGPT SEARCHES');
  console.log('='.repeat(50));

  const { expandedCountry, countries, businessVariations } = plan;
  const startTime = Date.now();

  // Generate 5 Gemini search tasks (diverse angles)
  const geminiTasks = [
    // Task 1: Industrial zones and estates
    `Find ${business} companies in industrial zones and estates across ${expandedCountry}.
Search for companies in: industrial parks, free trade zones, special economic zones, manufacturing clusters.
Return company name, website, and specific location for each.
Exclude: ${exclusion}`,

    // Task 2: Local language searches
    `Find ${business} companies in ${expandedCountry} using LOCAL LANGUAGE search terms.
Many smaller companies ONLY appear in local language searches.
Search in: Thai, Vietnamese, Indonesian, Malay, Chinese as appropriate.
Return company names (original language OK), websites, and HQ locations.
Exclude: ${exclusion}`,

    // Task 3: Supply chain discovery
    `Find ${business} companies through supply chain exploration in ${expandedCountry}.
Search for: OEM suppliers, contract manufacturers, tier-2 suppliers, raw material suppliers.
Look at supplier directories and procurement databases.
Return company name, website, HQ location.
Exclude: ${exclusion}`,

    // Task 4: Government and certification directories
    `Find ${business} companies through government directories and certifications in ${expandedCountry}.
Search: BOI promoted companies, ISO certified manufacturers, export directories, SME registries.
Return company name, website, and location.
Exclude: ${exclusion}`,

    // Task 5: Regional focus on top countries
    `Find ALL ${business} companies specifically in ${countries.slice(0, 3).join(', ')}.
Be EXHAUSTIVE - search each country individually and thoroughly.
Include: large manufacturers, SMEs, family businesses, local producers.
Return company name, website, and city/country for each.
Exclude: ${exclusion}`
  ];

  // Generate 5 ChatGPT search tasks (complementary angles)
  const chatgptTasks = [
    // Task 1: Comprehensive market players
    {
      query: `Complete list of ${business} companies in ${expandedCountry}`,
      reasoning: `Find ALL market participants - manufacturers, suppliers, producers. Focus on M&A targets.`
    },
    // Task 2: Hidden gems - smaller players
    {
      query: `Lesser known ${business} SMEs and family businesses in ${expandedCountry}`,
      reasoning: `Find smaller companies that don't rank high in searches - often best M&A targets.`
    },
    // Task 3: Trade associations
    {
      query: `${business} trade associations member companies ${expandedCountry}`,
      reasoning: `Find companies through industry association memberships and directories.`
    },
    // Task 4: Recent news and developments
    {
      query: `${business} companies ${expandedCountry} recent news acquisitions investments`,
      reasoning: `Find companies mentioned in recent industry news, M&A activity, investments.`
    },
    // Task 5: Alternative terminology
    {
      query: `${businessVariations.length > 0 ? businessVariations[0] : business} manufacturers ${expandedCountry}`,
      reasoning: `Search using alternative industry terminology to find missed companies.`
    }
  ];

  console.log(`  Running ${geminiTasks.length} Gemini + ${chatgptTasks.length} ChatGPT searches in PARALLEL...`);

  // Run ALL searches in parallel (not sequential!)
  const allSearchPromises = [
    // Gemini searches (all 5 in parallel)
    ...geminiTasks.map((task, idx) =>
      runAgenticSearchTask(task, expandedCountry, searchLog)
        .catch(e => {
          console.error(`  Gemini task ${idx + 1} failed: ${e.message}`);
          return [];
        })
    ),
    // ChatGPT searches (all 5 in parallel)
    ...chatgptTasks.map((task, idx) =>
      runChatGPTSearchTask(task.query, task.reasoning, expandedCountry, searchLog)
        .catch(e => {
          console.error(`  ChatGPT task ${idx + 1} failed: ${e.message}`);
          return [];
        })
    )
  ];

  const searchResults = await Promise.all(allSearchPromises);
  const allCompanies = searchResults.flat();

  console.log(`  Total companies from Phase 2: ${allCompanies.length} (before dedup)`);

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`  Phase 2 completed in ${duration} minutes`);

  return allCompanies;
}

// Generate diverse search tasks for a business/country
// Key insight: Exhaustiveness comes from DIFFERENT SEARCH ANGLES, not more search tools
function generateSearchTasks(business, country, exclusion, businessVariations = []) {
  const countries = country.split(',').map(c => c.trim());
  const countryList = countries.join(', ');

  const tasks = [];

  // Task 1: Comprehensive primary search with specific terminology variations
  tasks.push(`You are an M&A research analyst. Find ALL ${business} companies in ${countryList}.

YOUR TASK: Search exhaustively using MULTIPLE TERMINOLOGY VARIATIONS.

SEARCH STRATEGY - Execute ALL of these searches:
1. "${business} companies ${country}"
2. "${business} manufacturers ${country}"
3. "${business} suppliers ${country}"
4. "${business} producers ${country}"
5. "list of ${business} companies ${country}"
6. "${business} industry ${country} companies"

ALSO try synonyms and related terms:
- If looking for "packaging", also search: "carton", "box", "container", "corrugated"
- If looking for "electronics", also search: "EMS", "PCB", "assembly", "components"
- If looking for "food", also search: "processing", "manufacturing", "production"
- Think of what PRODUCTS these companies make, not just the industry term

For EACH company found, provide:
- Company name (official name)
- Website (must be real company website, not directory)
- Headquarters location (City, Country)

EXCLUSIONS: ${exclusion}

Return a comprehensive list. Include EVERY company mentioned.`);

  // Task 2: SME and local company focus with specific search patterns
  tasks.push(`Find small and medium ${business} companies in ${countryList} that are locally owned.

IMPORTANT: These companies are HARDER to find - they don't rank high in Google.

SEARCH STRATEGY - Try these specific patterns:
- "SME ${business} ${country}"
- "local ${business} manufacturer ${country}"
- "family business ${business} ${country}"
- "${business} ${country} private company"
- "${country} ${business} domestic manufacturer"
- "independent ${business} company ${country}"

ALSO search for:
- Companies mentioned in "top 10 local..." or "leading domestic..." lists
- Companies mentioned in government SME directories or awards
- Companies mentioned in local business news

Exclude: ${exclusion}, and subsidiaries of large multinationals.

Return company name, website, and HQ location for each.`);

  // Task 3: Industrial estate/zone specific searches for each country
  for (const c of countries) {
    tasks.push(`Find ${business} companies located in SPECIFIC INDUSTRIAL ESTATES and ZONES in ${c}.

CRITICAL: Search for companies BY LOCATION, not just by industry.

For ${c}, search these types of locations:
- Industrial estates (search "${business} [estate name]")
- Free trade zones / Special economic zones
- Industrial parks
- Manufacturing clusters
- Export processing zones

EXAMPLES of search patterns:
- "${business} companies Amata industrial estate" (Thailand)
- "${business} manufacturer Penang" (Malaysia)
- "${business} Batam free trade zone" (Indonesia)
- "${business} VSIP industrial park" (Vietnam)

Find WHICH industrial zones exist in ${c} for ${business} industry, then search each zone specifically.

Return company name, website, and HQ location (specific city/zone, ${c}).

Exclude: ${exclusion}`);
  }

  // Task 4: Industry associations, trade shows, and directories with SPECIFIC searches
  tasks.push(`Find ${business} companies through INDUSTRY ASSOCIATIONS and TRADE EVENTS in ${countryList}.

SEARCH STRATEGY - Be SPECIFIC:

1. INDUSTRY ASSOCIATIONS:
   - "${business} association ${country} member list"
   - "${country} ${business} federation members"
   - Search for the actual association names, then find their member directories

2. TRADE SHOWS (search for exhibitor lists):
   - "${business} trade show ${country} exhibitors"
   - "${business} expo ${country} participants"
   - Search for major trade shows in this industry and find who exhibited

3. CHAMBERS OF COMMERCE:
   - "${country} chamber of commerce ${business} members"
   - "German chamber ${country} ${business}" (foreign chambers often list suppliers)

4. CERTIFICATION BODIES:
   - "ISO certified ${business} ${country}"
   - "${business} ${country} certified companies"

Return company name, website, and HQ for each found.

Exclude: ${exclusion}`);

  // Task 5: Local language search with SPECIFIC terms
  tasks.push(`Find ${business} companies in ${countryList} using LOCAL LANGUAGE search terms.

CRITICAL: Many smaller companies ONLY appear in local language searches.

SEARCH STRATEGY:
${countries.map(c => {
    if (c.toLowerCase().includes('thailand')) {
      return `- For Thailand: Search using Thai script. Translate "${business}" to Thai and search.`;
    } else if (c.toLowerCase().includes('vietnam')) {
      return `- For Vietnam: Search using Vietnamese with diacritics. Example: "công ty ${business}"`;
    } else if (c.toLowerCase().includes('indonesia')) {
      return `- For Indonesia: Search "perusahaan ${business}" and "produsen ${business}"`;
    } else if (c.toLowerCase().includes('malaysia')) {
      return `- For Malaysia: Search in both Malay and Chinese.`;
    } else if (c.toLowerCase().includes('philippines')) {
      return `- For Philippines: Search in both English and Filipino.`;
    } else {
      return `- For ${c}: Search in the local language of ${c}`;
    }
  }).join('\n')}

Also search for:
- Company names that are in local language only
- Local business directories in that language
- Local industry news in that language

Return company name (original language is fine), website, and HQ location.

Exclude: ${exclusion}`);

  // Task 6: Supply chain discovery - find suppliers/customers of known players
  tasks.push(`Find ${business} companies in ${countryList} through SUPPLY CHAIN exploration.

SEARCH STRATEGY - Look at the ECOSYSTEM:

1. CONTRACT MANUFACTURING:
   - "${business} OEM ${country}"
   - "${business} ODM ${country}"
   - "${business} contract manufacturer ${country}"
   - "outsourced ${business} production ${country}"

2. SUPPLIER RELATIONSHIPS:
   - "suppliers to [major brand] ${country}"
   - "${country} ${business} export to [major importing country]"
   - Search for companies mentioned as suppliers in news articles

3. ADJACENT SERVICES:
   - Companies that do ${business} as PART of broader operations
   - Companies that handle specific STAGES of ${business} production
   - Niche specialists within the ${business} value chain

4. RECENT ENTRANTS:
   - "new ${business} company ${country}"
   - "${business} startup ${country}"
   - "recently established ${business} ${country}"

Return company name, website, and HQ for each.

Exclude: ${exclusion}`);

  // Task 7: Product-specific searches (NEW)
  tasks.push(`Find ${business} companies in ${countryList} by searching for SPECIFIC PRODUCTS they make.

CRITICAL: Instead of searching for "${business} companies", search for WHAT THEY PRODUCE.

SEARCH STRATEGY:
1. Think: What specific PRODUCTS do ${business} companies make?
2. Search for those products + country, e.g.:
   - "[specific product] manufacturer ${country}"
   - "[product category] supplier ${country}"
   - "[end product] maker ${country}"

EXAMPLE: If searching for "packaging companies":
- Search: "corrugated box manufacturer ${country}"
- Search: "flexible packaging producer ${country}"
- Search: "blister pack supplier ${country}"
- Search: "shrink wrap manufacturer ${country}"

For ${business}, identify 5-10 specific products and search for each.

Return company name, website, and HQ for each.

Exclude: ${exclusion}`);

  // Task 8: Competitor discovery (NEW)
  tasks.push(`Find MORE ${business} companies in ${countryList} by discovering COMPETITORS of known companies.

SEARCH STRATEGY:
1. Take well-known ${business} companies in ${countryList}
2. Search for their competitors:
   - "[known company] competitors ${country}"
   - "companies like [known company] ${country}"
   - "alternatives to [known company] ${country}"

3. Also search for:
   - "top ${business} companies ${country} ranked"
   - "leading ${business} manufacturers ${country}"
   - "market share ${business} ${country}" (often lists multiple players)

4. Look at industry reports that compare companies

This strategy finds companies that are in the SAME space but might use different terminology.

Return company name, website, and HQ for each.

Exclude: ${exclusion}`);

  // Task 7: Search using term variations (if provided)
  if (businessVariations && businessVariations.length > 0) {
    const variationsList = businessVariations.slice(0, 5).join('", "');
    tasks.push(`Find companies in ${countryList} using ALTERNATIVE INDUSTRY TERMINOLOGY.

The user is looking for: "${business}"

Search using these EQUIVALENT terms (they mean the same thing):
${businessVariations.slice(0, 5).map(v => `- "${v}"`).join('\n')}

These are industry synonyms - search for EACH term separately to find companies that might be missed by the primary search term.

For EACH company found, provide:
- Company name
- Website
- Headquarters location

Exclude: ${exclusion}

Be thorough - different companies may use different terminology to describe the same business.`);
  }

  return tasks;
}

// Validate a single company with one model
async function validateSingleCompany(company, business, country, exclusion, pageContent, model) {
  const validationPrompt = `Validate if this company matches the search criteria.

COMPANY: ${company.company_name}
WEBSITE: ${company.website}
CLAIMED HQ: ${company.hq}

WEBSITE CONTENT:
${pageContent ? pageContent.substring(0, 8000) : 'Could not fetch website'}

CRITERIA:
- Business type: ${business}
- Target countries: ${country}
- Exclusions: ${exclusion}

VALIDATION RULES:
1. Is this a real company (not a directory, marketplace, or article)?
2. Does their business relate to "${business}"?
3. Is their HQ in one of the target countries (${country})?
4. Do they violate any exclusion criteria (${exclusion})?

Return JSON only: {"valid": true/false, "reason": "one sentence explanation", "corrected_hq": "City, Country or null if unknown"}`;

  try {
    let result;
    if (model === 'gemini') {
      result = await callGemini3Flash(validationPrompt, true);
    } else {
      // ChatGPT validation
      result = await callChatGPT(validationPrompt);
    }

    const jsonMatch = result.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { valid: parsed.valid === true, reason: parsed.reason || '', corrected_hq: parsed.corrected_hq };
    }
    return { valid: false, reason: 'Parse error' };
  } catch (e) {
    return { valid: false, reason: `Error: ${e.message}` };
  }
}

// Validate companies using dual-model consensus (Gemini + ChatGPT)
// Both say yes → Valid | One says yes → Flagged | None say yes → Rejected
async function validateCompaniesV5(companies, business, country, exclusion) {
  console.log(`\nV5 Dual-Model Validation: ${companies.length} companies with Gemini + ChatGPT consensus...`);
  const startTime = Date.now();

  const validated = [];   // Both models agree = Valid
  const flagged = [];     // Only one model agrees = Flagged for review
  const rejected = [];    // Neither model agrees = Rejected

  const batchSize = 5; // Smaller batches since we're calling 2 models per company

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);

    const validations = await Promise.all(batch.map(async (company) => {
      try {
        // Fetch website content for validation (shared between both models)
        let pageContent = '';
        let fetchResult = { status: 'error', reason: 'No website' };

        if (company.website && company.website.startsWith('http')) {
          try {
            fetchResult = await fetchWebsite(company.website);
          } catch (e) {
            fetchResult = { status: 'error', reason: e.message };
          }
        }

        // Handle different fetch results
        if (fetchResult.status === 'security_blocked') {
          // Website has security/Cloudflare protection - FLAG for human review, don't remove
          console.log(`    ? SECURITY: ${company.company_name} (${fetchResult.reason}) - flagging for human review`);
          return {
            company,
            status: 'flagged',
            geminiValid: false,
            chatgptValid: false,
            geminiReason: `Security blocked: ${fetchResult.reason}`,
            chatgptReason: `Security blocked: ${fetchResult.reason}`,
            securityBlocked: true
          };
        }

        if (fetchResult.status !== 'ok') {
          // Website truly inaccessible - remove
          console.log(`    ✗ REMOVED: ${company.company_name} (${fetchResult.reason})`);
          return { company, status: 'skipped' };
        }

        pageContent = fetchResult.content;

        // Run both validations in parallel
        const [geminiResult, chatgptResult] = await Promise.all([
          validateSingleCompany(company, business, country, exclusion, pageContent, 'gemini'),
          validateSingleCompany(company, business, country, exclusion, pageContent, 'chatgpt')
        ]);

        // Determine consensus status
        const geminiValid = geminiResult.valid === true;
        const chatgptValid = chatgptResult.valid === true;

        let status;
        if (geminiValid && chatgptValid) {
          status = 'valid';
        } else if (geminiValid || chatgptValid) {
          status = 'flagged';
        } else {
          status = 'rejected';
        }

        return {
          company,
          status,
          geminiValid,
          chatgptValid,
          geminiReason: geminiResult.reason,
          chatgptReason: chatgptResult.reason,
          corrected_hq: geminiResult.corrected_hq || chatgptResult.corrected_hq
        };
      } catch (e) {
        console.error(`  Validation error for ${company.company_name}: ${e.message}`);
        return { company, status: 'rejected', geminiValid: false, chatgptValid: false, geminiReason: 'Error', chatgptReason: 'Error' };
      }
    }));

    for (const v of validations) {
      // Skip companies with inaccessible websites (already logged above)
      if (v.status === 'skipped') continue;

      const companyData = {
        company_name: v.company.company_name,
        website: v.company.website,
        hq: v.corrected_hq || v.company.hq,
        geminiVote: v.geminiValid ? 'YES' : 'NO',
        chatgptVote: v.chatgptValid ? 'YES' : 'NO',
        reason: v.geminiValid ? v.geminiReason : v.chatgptReason,
        securityBlocked: v.securityBlocked || false
      };

      if (v.status === 'valid') {
        validated.push(companyData);
        console.log(`    ✓ VALID: ${v.company.company_name} (Gemini: YES, ChatGPT: YES)`);
      } else if (v.status === 'flagged') {
        flagged.push(companyData);
        if (v.securityBlocked) {
          console.log(`    ? FLAGGED: ${v.company.company_name} (Security/WAF blocked - needs human review)`);
        } else {
          console.log(`    ? FLAGGED: ${v.company.company_name} (Gemini: ${v.geminiValid ? 'YES' : 'NO'}, ChatGPT: ${v.chatgptValid ? 'YES' : 'NO'})`);
        }
      } else {
        rejected.push(companyData);
        console.log(`    ✗ REJECTED: ${v.company.company_name} (Gemini: NO, ChatGPT: NO)`);
      }
    }

    console.log(`  Progress: ${Math.min(i + batchSize, companies.length)}/${companies.length} | Valid: ${validated.length} | Flagged: ${flagged.length} | Rejected: ${rejected.length}`);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nV5 Dual-Model Validation done in ${duration}s`);
  console.log(`  Valid (both agree): ${validated.length}`);
  console.log(`  Flagged (one agrees): ${flagged.length}`);
  console.log(`  Rejected (none agree): ${rejected.length}`);

  return { validated, flagged, rejected };
}

// Build email with search log summary and three-tier validation results
function buildV5EmailHTML(validationResults, business, country, exclusion, searchLog) {
  const { validated, flagged, rejected } = validationResults;

  // Note: Companies with inaccessible websites are removed entirely during validation (not shown)
  // Flagged = companies where one model agrees but the other doesn't
  const allFlagged = [...flagged];

  // Separate Gemini and ChatGPT tasks
  const geminiTasks = searchLog.filter(s => !s.model || (s.model !== 'chatgpt-search'));
  const chatgptTasks = searchLog.filter(s => s.model === 'chatgpt-search');

  const geminiSummary = geminiTasks.map((s, i) =>
    `<li><strong>[Gemini]</strong> Task ${i + 1}: ${s.searchQueries.length} searches, ${s.sourceCount} sources, ${s.duration}s</li>`
  ).join('');

  const chatgptSummary = chatgptTasks.map((s, i) =>
    `<li><strong>[ChatGPT]</strong> Task ${i + 1}: ${s.duration}s</li>`
  ).join('');

  const totalSearches = searchLog.reduce((sum, s) => sum + s.searchQueries.length, 0);
  const totalSources = searchLog.reduce((sum, s) => sum + s.sourceCount, 0);
  const totalDuration = searchLog.reduce((sum, s) => sum + s.duration, 0);

  let html = `
    <h2>V5 Agentic Search Results</h2>
    <p><strong>Business:</strong> ${business}</p>
    <p><strong>Country:</strong> ${country}</p>
    <p><strong>Exclusions:</strong> ${exclusion}</p>

    <h3>Validation Summary (Dual-Model Consensus)</h3>
    <p>Each company was validated by <strong>both Gemini AND ChatGPT</strong>:</p>
    <ul>
      <li><span style="color: #22c55e; font-weight: bold;">VALIDATED (${validated.length})</span> - Both models agree this is a match</li>
      <li><span style="color: #f59e0b; font-weight: bold;">FLAGGED FOR REVIEW (${allFlagged.length})</span> - Needs human review (one model disagree or insufficient website info)</li>
    </ul>
    <p style="font-size: 12px; color: #666;">Note: Companies clearly outside target region or business scope are automatically excluded.</p>

    <h3>Search Summary</h3>
    <p><strong>Models Used:</strong> Gemini 3 Flash (${geminiTasks.length} tasks) + ChatGPT Search (${chatgptTasks.length} tasks)</p>
    <p>Total internal searches: ${totalSearches} | Sources consulted: ${totalSources} | Search time: ${totalDuration.toFixed(1)}s</p>

    <h4>Gemini Search Tasks</h4>
    <ul>${geminiSummary || '<li>None</li>'}</ul>

    <h4>ChatGPT Search Tasks</h4>
    <ul>${chatgptSummary || '<li>None</li>'}</ul>
  `;

  // Section 1: Validated Companies (Both agree)
  html += `
    <h3 style="color: #22c55e; border-bottom: 2px solid #22c55e; padding-bottom: 8px;">
      ✓ VALIDATED COMPANIES (${validated.length})
    </h3>
    <p style="color: #666; font-size: 12px;">Both Gemini and ChatGPT confirmed these match your criteria</p>
  `;

  if (validated.length > 0) {
    html += `
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; margin-bottom: 30px;">
      <tr style="background-color: #dcfce7;">
        <th>#</th>
        <th>Company</th>
        <th>Website</th>
        <th>Headquarters</th>
        <th>Gemini</th>
        <th>ChatGPT</th>
      </tr>
    `;
    validated.forEach((c, i) => {
      html += `
      <tr>
        <td>${i + 1}</td>
        <td>${c.company_name}</td>
        <td><a href="${c.website}">${c.website}</a></td>
        <td>${c.hq}</td>
        <td style="color: #22c55e;">✓ YES</td>
        <td style="color: #22c55e;">✓ YES</td>
      </tr>
      `;
    });
    html += '</table>';
  } else {
    html += '<p><em>No companies were validated by both models.</em></p>';
  }

  // Section 2: Flagged for Human Review (model disagreements only - inaccessible websites are removed)
  html += `
    <h3 style="color: #f59e0b; border-bottom: 2px solid #f59e0b; padding-bottom: 8px;">
      ? FLAGGED FOR HUMAN REVIEW (${allFlagged.length})
    </h3>
    <p style="color: #666; font-size: 12px;">These need manual verification - models disagreed on whether they match criteria</p>
  `;

  if (allFlagged.length > 0) {
    html += `
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; margin-bottom: 30px;">
      <tr style="background-color: #fef3c7;">
        <th>#</th>
        <th>Company</th>
        <th>Website</th>
        <th>Headquarters</th>
        <th>Reason</th>
      </tr>
    `;
    allFlagged.forEach((c, i) => {
      // Determine reason to display
      let displayReason = '';
      let reasonStyle = 'font-size: 11px; color: #666;';

      if (c.securityBlocked) {
        displayReason = '🔒 Security/WAF blocked - verify manually';
        reasonStyle = 'font-size: 11px; color: #dc2626; font-weight: bold;';
      } else if (c.geminiVote === 'YES' && c.chatgptVote === 'NO') {
        displayReason = 'Gemini: Yes, ChatGPT: No';
      } else if (c.geminiVote === 'NO' && c.chatgptVote === 'YES') {
        displayReason = 'Gemini: No, ChatGPT: Yes';
      } else {
        displayReason = c.reason || 'Needs verification';
      }

      html += `
      <tr>
        <td>${i + 1}</td>
        <td>${c.company_name}</td>
        <td><a href="${c.website}">${c.website}</a></td>
        <td>${c.hq}</td>
        <td style="${reasonStyle}">${displayReason}</td>
      </tr>
      `;
    });
    html += '</table>';
  } else {
    html += '<p><em>No companies need human review.</em></p>';
  }

  // Note: Companies rejected for wrong region/large company/wrong business are not shown

  return html;
}

// V5 ENDPOINT - Parallel Architecture with Perplexity as Main Search
app.post('/api/find-target-v5', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`V5 PARALLEL SEARCH: ${new Date().toISOString()}`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(70));

  res.json({
    success: true,
    message: 'Request received. Parallel search running. Results will be emailed in ~10-15 minutes.'
  });

  try {
    const totalStart = Date.now();
    const searchLog = [];

    // ========== PHASE 0: Plan Search Strategy ==========
    const plan = await planSearchStrategyV5(Business, Country, Exclusion);

    // ========== PHASE 1: Perplexity Main Search + Parallel Validation ==========
    // This is the PRIMARY search - runs Perplexity searches in parallel, then validates immediately
    const phase1Results = await runPerplexityMainSearchWithValidation(plan, Business, Exclusion, searchLog);

    // ========== PHASE 2: Parallel Gemini + ChatGPT Secondary Searches ==========
    // These run 5 Gemini + 5 ChatGPT searches SIMULTANEOUSLY (not sequentially)
    const phase2Companies = await runParallelSecondarySearches(plan, Business, Exclusion, searchLog);

    // ========== PHASE 3: Process Phase 2 Companies ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 3: PROCESS SECONDARY SEARCH RESULTS');
    console.log('='.repeat(50));

    // Dedupe Phase 2 companies
    const uniquePhase2 = dedupeCompanies(phase2Companies);
    console.log(`  Phase 2 companies after dedup: ${uniquePhase2.length}`);

    // Remove companies already validated/flagged in Phase 1
    const phase1Websites = new Set([
      ...phase1Results.validated.map(c => c.website?.toLowerCase()),
      ...phase1Results.flagged.map(c => c.website?.toLowerCase())
    ].filter(Boolean));

    const newCompanies = uniquePhase2.filter(c => {
      const website = c.website?.toLowerCase();
      return website && !phase1Websites.has(website);
    });
    console.log(`  New companies (not in Phase 1): ${newCompanies.length}`);

    // Find missing websites for new companies
    const needWebsite = newCompanies.filter(c => !c.website || c.website === 'unknown' || !c.website.startsWith('http'));
    const hasWebsite = newCompanies.filter(c => c.website && c.website.startsWith('http'));
    const companiesWithWebsites = [...hasWebsite];

    if (needWebsite.length > 0) {
      console.log(`  Looking up websites for ${needWebsite.length} companies...`);
      const websitePrompt = `Find the official websites for these companies:

${needWebsite.slice(0, 30).map(c => `- ${c.company_name} (${c.hq})`).join('\n')}

Return JSON: {"websites": [{"company_name": "...", "website": "https://..."}]}

Only include real company websites (not LinkedIn, Facebook, directories). If you can't find a website, omit that company.`;

      const websiteResult = await callGemini2FlashWithSearch(websitePrompt);
      try {
        const jsonMatch = websiteResult.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed.websites)) {
            for (const w of parsed.websites) {
              const original = needWebsite.find(c =>
                c.company_name.toLowerCase().includes(w.company_name.toLowerCase()) ||
                w.company_name.toLowerCase().includes(c.company_name.toLowerCase())
              );
              if (original && w.website && w.website.startsWith('http')) {
                companiesWithWebsites.push({ ...original, website: w.website });
              }
            }
          }
        }
      } catch (e) {
        console.error('  Website lookup parse error:', e.message);
      }
      console.log(`  Companies with websites: ${companiesWithWebsites.length}`);
    }

    // Pre-filter and validate Phase 2 companies
    const preFiltered = preFilterCompanies(companiesWithWebsites);
    console.log(`  After pre-filter: ${preFiltered.length}`);

    let phase2Validated = { validated: [], flagged: [], rejected: [] };
    if (preFiltered.length > 0) {
      console.log(`  Validating ${preFiltered.length} Phase 2 companies...`);
      phase2Validated = await validateCompaniesV5(preFiltered, Business, plan.expandedCountry, Exclusion);
    }

    // ========== PHASE 4: Merge and Final Results ==========
    console.log('\n' + '='.repeat(50));
    console.log('PHASE 4: FINAL RESULTS');
    console.log('='.repeat(50));

    // Merge Phase 1 and Phase 2 results
    const allValidated = [...phase1Results.validated, ...phase2Validated.validated];
    const allFlagged = [...phase1Results.flagged, ...phase2Validated.flagged];
    const allRejected = [...phase1Results.rejected, ...phase2Validated.rejected];

    // Final dedup
    const finalValidated = dedupeCompanies(allValidated);
    const finalFlagged = dedupeCompanies(allFlagged);
    const finalRejected = dedupeCompanies(allRejected);

    console.log(`FINAL MERGED RESULTS:`);
    console.log(`  ✓ VALIDATED (both models agree): ${finalValidated.length}`);
    console.log(`    - From Perplexity (Phase 1): ${phase1Results.validated.length}`);
    console.log(`    - From Gemini/ChatGPT (Phase 2): ${phase2Validated.validated.length}`);
    console.log(`  ? FLAGGED (needs review): ${finalFlagged.length}`);
    console.log(`  ✗ REJECTED (neither agrees): ${finalRejected.length}`);

    // Calculate stats
    const perplexityTasks = searchLog.filter(s => s.model === 'perplexity-sonar-pro').length;
    const geminiTasks = searchLog.filter(s => !s.model || s.model === 'gemini').length;
    const chatgptTasks = searchLog.filter(s => s.model === 'chatgpt-search').length;
    const totalSearches = searchLog.reduce((sum, s) => sum + s.searchQueries.length, 0);
    const totalSources = searchLog.reduce((sum, s) => sum + s.sourceCount, 0);

    console.log(`\nSearch Statistics:`);
    console.log(`  Perplexity searches: ${perplexityTasks}`);
    console.log(`  Gemini searches: ${geminiTasks}`);
    console.log(`  ChatGPT searches: ${chatgptTasks}`);
    console.log(`  Total internal searches: ${totalSearches}`);
    console.log(`  Total sources consulted: ${totalSources}`);

    // Send email with three-tier results
    const finalResults = { validated: finalValidated, flagged: finalFlagged, rejected: finalRejected };
    const htmlContent = buildV5EmailHTML(finalResults, Business, plan.expandedCountry, Exclusion, searchLog);

    await sendEmail(
      Email,
      `[V5 PARALLEL] ${Business} in ${Country} (${finalValidated.length} validated + ${finalFlagged.length} flagged)`,
      htmlContent
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log('\n' + '='.repeat(70));
    console.log(`V5 PARALLEL SEARCH COMPLETE!`);
    console.log(`Email sent to: ${Email}`);
    console.log(`Validated: ${finalValidated.length} | Flagged: ${finalFlagged.length} | Rejected: ${finalRejected.length}`);
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(70));

  } catch (error) {
    console.error('V5 Processing error:', error);
    try {
      await sendEmail(Email, `Find Target V5 - Error`, `<p>Error: ${error.message}</p>`);
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

// Helper: Check business relevance using Gemini 2.5 Flash (stable, cost-effective)
async function checkRelevanceWithOpenAI(companies, filterCriteria) {
  const companyNames = companies.map(c => c.name);
  const prompt = buildReasoningPrompt(companyNames, filterCriteria);

  try {
    // Use stable Gemini 2.5 Flash (upgraded from gemini-3-flash-preview)
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt + '\n\nRespond with valid JSON only.' }] }],
        generationConfig: { responseMimeType: 'application/json' }
      }),
      timeout: 90000
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 100)}`);
    }

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { source: 'gemini-2.5-flash', results: parsed.results || parsed.companies || parsed };
    }
    return null;
  } catch (error) {
    console.error('Gemini 2.5 Flash relevance check error:', error.message);
    // Fallback to GPT-4o
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }],
        response_format: { type: 'json_object' },
        temperature: 0.2
      });
      const content = response.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return { source: 'gpt-4o-fallback', results: parsed.results || parsed.companies || parsed };
      }
      return null;
    } catch (e) {
      console.error('GPT-4o fallback error:', e.message);
      return null;
    }
  }
}

// Helper: Check business relevance using Gemini 2.5 Flash-Lite (upgraded from 2.0)
async function checkRelevanceWithGemini(companies, filterCriteria) {
  const companyNames = companies.map(c => c.name);
  const prompt = buildReasoningPrompt(companyNames, filterCriteria);

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
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
      return { source: 'gemini-2.5-flash-lite', results: parsed.results || parsed.companies || parsed };
    }
    return null;
  } catch (error) {
    console.error('Gemini 2.5 Flash-Lite error:', error.message);
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
      c.filterReason || '',
      (c.dataWarnings && c.dataWarnings.length > 0) ? c.dataWarnings.join('; ') : ''
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
      '',
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

      // Build dynamic title: "Listed Cosmetics Companies in Southeast Asia"
      if (industry || region) {
        const statusText = status.toLowerCase() === 'listed' ? 'Listed ' : '';
        const industryText = industry || '';

        // Check if all countries are Southeast Asian - if so, use "Southeast Asia"
        const seaCountries = ['singapore', 'malaysia', 'indonesia', 'thailand', 'philippines', 'vietnam'];
        const regionCountries = region ? region.split(',').map(r => r.trim().toLowerCase()) : [];
        const allAreSEA = regionCountries.length > 0 && regionCountries.every(c =>
          seaCountries.some(sea => c.includes(sea))
        );

        let regionText;
        if (allAreSEA && regionCountries.length >= 3) {
          regionText = 'Southeast Asia';
        } else {
          regionText = region ? region.split(',').map(r => r.trim()).join(', ').replace(/, ([^,]*)$/, ' and $1') : '';
        }

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
      // Look for row with "company" AND any financial column (sales, revenue, market, ebitda, etc.)
      if ((rowStr.includes('company') || rowStr.includes('name')) &&
          (rowStr.includes('sales') || rowStr.includes('revenue') || rowStr.includes('market') || rowStr.includes('ebitda') || rowStr.includes('p/e') || rowStr.includes('ev/') || rowStr.includes('ev '))) {
        headerRowIndex = i;
        headers = row;
        console.log(`Found header row at index ${i}: ${row.slice(0, 10).join(', ')}`);
        break;
      }
    }

    if (headerRowIndex === -1) {
      // Fallback: find first row with "company" in it
      for (let i = 0; i < Math.min(20, allRows.length); i++) {
        const row = allRows[i];
        if (!row) continue;
        const rowStr = row.join(' ').toLowerCase();
        if (rowStr.includes('company name') || rowStr.includes('company')) {
          headerRowIndex = i;
          headers = row;
          console.log(`Fallback header row at index ${i}: ${row.slice(0, 10).join(', ')}`);
          break;
        }
      }
    }

    if (headerRowIndex === -1) {
      headerRowIndex = 0;
      headers = allRows[0] || [];
      console.log(`Using first row as header: ${headers.slice(0, 10).join(', ')}`);
    }

    console.log(`Header row index: ${headerRowIndex}`);

    // ========== COMPREHENSIVE RAW DATA DUMP ==========
    // Show EVERY column with header and first 3 sample values
    console.log(`\n${'='.repeat(60)}`);
    console.log(`RAW EXCEL DATA INSPECTION (${headers.length} columns)`);
    console.log(`${'='.repeat(60)}`);

    const dataRowsPreview = allRows.slice(headerRowIndex + 1, headerRowIndex + 6); // First 5 data rows

    for (let colIdx = 0; colIdx < headers.length; colIdx++) {
      const header = headers[colIdx];
      if (!header) continue;

      // Get sample values from this column
      const samples = [];
      for (const row of dataRowsPreview) {
        if (row && row[colIdx] !== undefined && row[colIdx] !== null && row[colIdx] !== '') {
          samples.push(row[colIdx]);
        }
      }

      console.log(`  Col ${colIdx}: "${header}"`);
      console.log(`    Sample values: [${samples.slice(0, 3).join(', ')}]`);
    }

    console.log(`${'='.repeat(60)}\n`);

    // Also log first 3 complete data rows for reference
    console.log(`FIRST 3 COMPLETE DATA ROWS:`);
    for (let i = headerRowIndex + 1; i < Math.min(headerRowIndex + 4, allRows.length); i++) {
      const row = allRows[i];
      if (row) {
        console.log(`  Row ${i}: ${row.slice(0, 15).map((v, idx) => `[${idx}]${v}`).join(' | ')}`);
      }
    }

    // Find column indices - enhanced to detect TTM vs FY columns
    const findCol = (patterns, excludePatterns = []) => {
      for (const pattern of patterns) {
        const idx = headers.findIndex(h => {
          if (!h) return false;
          const hLower = h.toString().toLowerCase();
          // Check if header matches pattern
          if (!hLower.includes(pattern.toLowerCase())) return false;
          // Check if header contains any exclude patterns
          for (const exclude of excludePatterns) {
            if (hLower.includes(exclude.toLowerCase())) return false;
          }
          return true;
        });
        if (idx !== -1) return idx;
      }
      return -1;
    };

    // Find Sales/Revenue column - with DATA VALIDATION to ensure correct column
    const findSalesCol = () => {
      const salesPatterns = ['net sales', 'total sales', 'total revenue', 'net revenue', 'sales', 'revenue', 'turnover', 'revenues'];
      const excludePatterns = ['growth', 'margin', 'rank', 'yoy', 'change', '%', 'per ', 'ratio', 'count', '#', 'cagr', 'number'];

      // Find ALL candidate columns matching sales/revenue patterns
      const candidates = [];
      for (let idx = 0; idx < headers.length; idx++) {
        const h = headers[idx];
        if (!h) continue;
        const hLower = h.toString().toLowerCase();

        // Check if header matches any sales pattern
        let matchesPattern = false;
        for (const pattern of salesPatterns) {
          if (hLower.includes(pattern.toLowerCase())) {
            matchesPattern = true;
            break;
          }
        }
        if (!matchesPattern) continue;

        // Check for exclude patterns
        let excluded = false;
        for (const exclude of excludePatterns) {
          if (hLower.includes(exclude.toLowerCase())) {
            excluded = true;
            console.log(`  Excluding col ${idx} "${h}" - contains "${exclude}"`);
            break;
          }
        }
        if (excluded) continue;

        candidates.push({ idx, header: h });
      }

      console.log(`\n=== SALES COLUMN CANDIDATES ===`);
      if (candidates.length === 0) {
        console.log('  No candidate columns found!');
        return -1;
      }

      // Get data rows for validation
      const dataRows = allRows.slice(headerRowIndex + 1);

      // Validate each candidate by sampling actual data values
      for (const candidate of candidates) {
        console.log(`\n  Checking candidate: col ${candidate.idx} = "${candidate.header}"`);

        // Sample first 10 non-empty values from this column
        const sampleValues = [];
        let rowsSampled = 0;
        for (const row of dataRows) {
          if (rowsSampled >= 10) break;
          if (!row || row.length === 0) continue;

          const cellValue = row[candidate.idx];
          if (cellValue === undefined || cellValue === null || cellValue === '') continue;

          const numVal = parseFloat(String(cellValue).replace(/[,%]/g, ''));
          if (!isNaN(numVal)) {
            sampleValues.push(numVal);
            rowsSampled++;
          }
        }

        console.log(`    Sample values (first ${sampleValues.length}): [${sampleValues.slice(0, 5).join(', ')}${sampleValues.length > 5 ? '...' : ''}]`);

        if (sampleValues.length === 0) {
          console.log(`    SKIP: No numeric values found`);
          continue;
        }

        // Validate: Sales values should NOT be small sequential integers (ranks)
        const allSmallIntegers = sampleValues.every(v => v >= 1 && v <= 20 && Number.isInteger(v));
        if (allSmallIntegers && sampleValues.length >= 3) {
          // Check if they look sequential (like ranks: 1,2,3,4...)
          const sorted = [...sampleValues].sort((a, b) => a - b);
          const looksLikeRank = sorted.every((v, i) => v >= 1 && v <= 20);
          if (looksLikeRank) {
            console.log(`    SKIP: Values look like ranking (small integers 1-20)`);
            continue;
          }
        }

        // Validate: Sales values should NOT all be percentages (0-100 range with decimals)
        const avgValue = sampleValues.reduce((a, b) => a + b, 0) / sampleValues.length;
        const maxValue = Math.max(...sampleValues);

        if (maxValue < 100 && sampleValues.every(v => v >= -100 && v <= 100)) {
          // Check if this looks like margin percentages
          if (sampleValues.some(v => v < 0) || sampleValues.every(v => Math.abs(v) < 50)) {
            console.log(`    SKIP: Values look like percentages/margins (avg: ${avgValue.toFixed(1)})`);
            continue;
          }
        }

        // Validate: At least some values should be substantial (>50 for typical sales in millions)
        if (maxValue < 50) {
          console.log(`    SKIP: All values too small for revenue (max: ${maxValue})`);
          continue;
        }

        // This candidate passes validation
        console.log(`    ACCEPTED: Values look like revenue (avg: ${avgValue.toFixed(0)}, max: ${maxValue.toFixed(0)})`);
        return candidate.idx;
      }

      // If no validated candidate, fall back to first candidate with a warning
      if (candidates.length > 0) {
        console.log(`\n  WARNING: No validated sales column found, using first candidate: col ${candidates[0].idx}`);
        return candidates[0].idx;
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
      sales: findSalesCol(),
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

    console.log(`\n=== COLUMN MAPPING ===`);
    console.log(`  Company: col ${cols.company} = "${headers[cols.company] || 'N/A'}"`);
    console.log(`  Country: col ${cols.country} = "${headers[cols.country] || 'N/A'}"`);
    console.log(`  Sales/Revenue: col ${cols.sales} = "${headers[cols.sales] || 'NOT FOUND'}"`);
    console.log(`  Market Cap: col ${cols.marketCap} = "${headers[cols.marketCap] || 'N/A'}"`);
    console.log(`  EV: col ${cols.ev} = "${headers[cols.ev] || 'N/A'}"`);
    console.log(`  EBITDA: col ${cols.ebitda} = "${headers[cols.ebitda] || 'N/A'}"`);
    console.log(`  Net Margin: col ${cols.netMargin} = "${headers[cols.netMargin] || 'N/A'}"`);
    console.log(`  EV/EBITDA: col ${cols.evEbitda} = "${headers[cols.evEbitda] || 'N/A'}"`);
    console.log(`  P/E TTM: col ${cols.peTTM} = "${headers[cols.peTTM] || 'N/A'}"`);
    console.log(`  P/E FY: col ${cols.peFY} = "${headers[cols.peFY] || 'N/A'}"`);
    console.log(`  P/B: col ${cols.pb} = "${headers[cols.pb] || 'N/A'}"`);

    if (cols.sales < 0) {
      console.log(`\n*** WARNING: Sales/Revenue column NOT FOUND! Available headers:`);
      headers.forEach((h, i) => console.log(`    [${i}] ${h}`));
    }

    // Extract data rows
    const dataRows = allRows.slice(headerRowIndex + 1);
    const allCompanies = [];
    let loggedCount = 0;

    for (const row of dataRows) {
      if (!row || row.length === 0) continue;

      const companyName = cols.company >= 0 ? row[cols.company] : null;
      if (!companyName) continue;

      const nameStr = String(companyName).toLowerCase().trim();

      // Skip rows that are clearly NOT company names
      if (nameStr.includes('total') || nameStr.includes('median') || nameStr.includes('average') ||
          nameStr.includes('note:') || nameStr.includes('source:') || nameStr.includes('unit') ||
          nameStr.startsWith('*') || nameStr.length < 2) continue;
      if (nameStr.startsWith('spd') && nameStr.length > 10) continue;

      // Skip sub-header rows (period indicators, unit indicators, etc.)
      if (nameStr.includes('latest') || nameStr.includes('fiscal') || nameStr.includes('period') ||
          nameStr === 'fy' || nameStr === 'ttm' || nameStr === 'ltm' ||
          nameStr.includes('million') || nameStr.includes('billion') || nameStr.includes('usd') ||
          nameStr.includes('currency') || nameStr.includes('local')) continue;

      const parseNum = (idx) => {
        if (idx < 0 || row[idx] === undefined || row[idx] === null || row[idx] === '') return null;
        const rawVal = row[idx];
        const val = parseFloat(String(rawVal).replace(/[,%]/g, ''));
        return isNaN(val) ? null : val;
      };

      // Get raw cell values for debugging
      const rawSales = cols.sales >= 0 ? row[cols.sales] : 'N/A';
      const rawMarketCap = cols.marketCap >= 0 ? row[cols.marketCap] : 'N/A';
      const rawEV = cols.ev >= 0 ? row[cols.ev] : 'N/A';

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
        filterReason: '',
        dataWarnings: [],
        // Store raw row data for AI validation
        _rawRow: row.slice(0, 20), // First 20 columns
        _colMapping: { ...cols }
      };

      // Log first 5 companies with their raw and parsed values
      if (loggedCount < 5) {
        console.log(`\n--- ${company.name} ---`);
        console.log(`  RAW: Sales[col ${cols.sales}]="${rawSales}" | MCap[col ${cols.marketCap}]="${rawMarketCap}" | EV[col ${cols.ev}]="${rawEV}"`);
        console.log(`  PARSED: Sales=${company.sales} | MCap=${company.marketCap} | EV=${company.ev} | EBITDA=${company.ebitda}`);
        loggedCount++;
      }

      // DATA VALIDATION: Check for suspicious/inconsistent financial data
      const warnings = [];

      // Check 1: EBITDA should be less than Sales (EBITDA margin > 100% is very suspicious)
      if (company.sales && company.ebitda && company.ebitda > company.sales) {
        warnings.push(`EBITDA (${company.ebitda}) > Sales (${company.sales}) - possible unit mismatch`);
      }

      // Check 2: Sales should be reasonable compared to Market Cap (PSR typically 0.1x - 50x)
      if (company.sales && company.marketCap) {
        const psr = company.marketCap / company.sales;
        if (psr > 100) {
          warnings.push(`PSR ${psr.toFixed(1)}x is extremely high - check Sales units`);
        } else if (psr < 0.01) {
          warnings.push(`PSR ${psr.toFixed(3)}x is extremely low - check Market Cap units`);
        }
      }

      // Check 3: EV should be in similar ballpark as Market Cap (typically 0.5x - 3x)
      if (company.ev && company.marketCap) {
        const evToMcap = company.ev / company.marketCap;
        if (evToMcap > 10) {
          warnings.push(`EV/Market Cap ratio ${evToMcap.toFixed(1)}x is unusual - verify data`);
        } else if (evToMcap < 0.1) {
          warnings.push(`EV/Market Cap ratio ${evToMcap.toFixed(2)}x is unusual - verify data`);
        }
      }

      // Check 4: If EV/EBITDA is provided, verify it roughly matches EV / EBITDA calculation
      if (company.evEbitda && company.ev && company.ebitda && company.ebitda > 0) {
        const calculatedEvEbitda = company.ev / company.ebitda;
        const diff = Math.abs(calculatedEvEbitda - company.evEbitda) / company.evEbitda;
        if (diff > 0.5) { // More than 50% difference
          warnings.push(`EV/EBITDA mismatch: provided ${company.evEbitda.toFixed(1)}x vs calculated ${calculatedEvEbitda.toFixed(1)}x`);
        }
      }

      // Check 5: Very small Sales compared to other metrics (possible unit issue - e.g., Sales in billions but others in millions)
      if (company.sales && company.sales < 100) {
        if ((company.marketCap && company.marketCap > 1000) ||
            (company.ev && company.ev > 1000) ||
            (company.ebitda && company.ebitda > 100)) {
          warnings.push(`Sales (${company.sales}) seems too small relative to other metrics - possible unit mismatch`);
        }
      }

      company.dataWarnings = warnings;
      if (warnings.length > 0) {
        console.log(`Data warning for ${companyName}: ${warnings.join('; ')}`);
      }

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
    const sheetHeaders = ['Company', 'Country', 'Sales', 'Market Cap', 'EV', 'EBITDA', 'Net Margin %', 'Op Margin %', 'EBITDA Margin %', 'EV/EBITDA', 'P/E (TTM)', 'P/E (FY)', 'P/BV', 'Filter Reason', 'Data Warnings'];

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

      // First remove prefixes (PT for Indonesian companies, etc.)
      const prefixes = [
        /^PT\s+/i,           // Indonesian: PT Mitra Keluarga -> Mitra Keluarga
        /^CV\s+/i,           // Indonesian: CV Company Name
        /^P\.?T\.?\s+/i,     // Variations: P.T. or P T
      ];

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
        /\s+(Tbk|TBK)\.?$/i,  // Indonesian suffix (removed PT from here since it's a prefix)
        /\s+(Oyj|OYJ|AB)\.?$/i,
        /\s+(SE)\.?$/i,
        /\s+(SpA|SPA|S\.p\.A\.)\.?$/i,
        /\s+(Pte|PTE)\.?\s*(Ltd|LTD)?\.?$/i,
        /\s+(Sdn|SDN)\.?\s*(Bhd|BHD)?\.?$/i,
        /,\s*(Inc|Ltd|LLC|Corp)\.?$/i,
        /\s+Holdings?$/i,
        /\s+Group$/i,
        /\s+International$/i,
        /\s+Healthcare$/i,
        /\s+Hospitals?$/i,
        /\s+Medical$/i,
        /\s+Services?$/i,
        /\s+Systems?$/i,
        /\s+Center$/i,
        /\s+Centre$/i,
        /\s+Business$/i
      ];

      // Abbreviations for common words (applied after suffix removal)
      const abbreviations = {
        'International': 'Intl',
        'Holdings': 'Hldgs',
        'Hospital': 'Hosp',
        'Hospitals': 'Hosp',
        'Medical': 'Med',
        'Healthcare': 'HC',
        'Metropolitan': 'Metro',
        'Management': 'Mgmt',
        'Corporation': 'Corp',
        'Services': 'Svc',
        'Technology': 'Tech',
        'Development': 'Dev',
        'Investment': 'Inv',
        'Pharmaceutical': 'Pharma',
        'Manufacturing': 'Mfg'
      };

      let cleaned = String(name).trim();

      // Remove prefixes first
      for (const prefix of prefixes) {
        cleaned = cleaned.replace(prefix, '');
      }

      // Remove suffixes (run multiple passes to catch compound suffixes)
      for (let i = 0; i < 3; i++) {
        for (const suffix of suffixes) {
          cleaned = cleaned.replace(suffix, '');
        }
      }

      cleaned = cleaned.trim();

      // Apply abbreviations if name is still long
      const MAX_LENGTH = 22; // Max chars to fit single line at font 12 in 2.42" column
      if (cleaned.length > MAX_LENGTH) {
        for (const [full, abbr] of Object.entries(abbreviations)) {
          cleaned = cleaned.replace(new RegExp(full, 'gi'), abbr);
        }
      }

      // If still too long, remove words from the end until it fits
      while (cleaned.length > MAX_LENGTH && cleaned.includes(' ')) {
        const words = cleaned.split(' ');
        words.pop(); // Remove last word
        cleaned = words.join(' ');
      }

      return cleaned.trim();
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
    let displayCompanies = sortedCompanies.slice(0, 30);

    // ===== AI DATA VALIDATION using Gemini 2.5 Pro =====
    // Critical validation step to ensure data accuracy before PowerPoint generation
    console.log('Running Gemini 2.5 Pro validation for top 30 companies...');

    const validationPrompt = `You are a financial data validation expert. Verify the accuracy of these parsed company financial metrics.

HEADER ROW FROM EXCEL (for reference):
${headers.slice(0, 15).join(' | ')}

COMPANIES TO VALIDATE (showing parsed values and raw row data):
${displayCompanies.slice(0, 15).map((c, i) => {
  const rawValues = c._rawRow ? c._rawRow.slice(0, 15).map(v => v === null || v === undefined ? 'NULL' : String(v)).join(' | ') : 'N/A';
  return `${i + 1}. ${c.name}
   Parsed: Sales=${c.sales}, Market Cap=${c.marketCap}, EV=${c.ev}, EBITDA=${c.ebitda}, Net Margin=${c.netMargin}%
   Raw Row: ${rawValues}
   Column indices: sales=${c._colMapping?.sales}, marketCap=${c._colMapping?.marketCap}, ev=${c._colMapping?.ev}`;
}).join('\n\n')}

VALIDATION TASK:
1. Check if the parsed Sales value correctly matches the Sales column in the raw data
2. Check if Market Cap, EV, and EBITDA values are correctly extracted
3. Identify any unit mismatches (e.g., Sales in billions vs others in millions)
4. Flag any companies where the data looks incorrect

Return JSON with this exact format:
{
  "validationPassed": true/false,
  "issues": [
    {"company": "Company Name", "field": "sales", "parsedValue": 6, "expectedValue": 6000, "issue": "Possible unit mismatch - value appears to be in billions, should be millions"}
  ],
  "corrections": [
    {"company": "Company Name", "field": "sales", "correctedValue": 6000}
  ]
}`;

    try {
      const validationResult = await callGemini2Pro(validationPrompt, true);
      if (validationResult) {
        const validation = JSON.parse(validationResult);
        console.log('Gemini 2.5 Pro validation result:', JSON.stringify(validation, null, 2));

        // Apply corrections if any
        if (validation.corrections && validation.corrections.length > 0) {
          console.log(`Applying ${validation.corrections.length} data corrections from AI validation...`);
          for (const correction of validation.corrections) {
            const company = displayCompanies.find(c => c.name.toLowerCase().includes(correction.company.toLowerCase()));
            if (company && correction.field && correction.correctedValue !== undefined) {
              const oldValue = company[correction.field];
              company[correction.field] = correction.correctedValue;
              console.log(`  Corrected ${company.name}: ${correction.field} from ${oldValue} to ${correction.correctedValue}`);
            }
          }
        }

        // Log issues for review
        if (validation.issues && validation.issues.length > 0) {
          console.log('AI detected potential data issues:');
          validation.issues.forEach(issue => {
            console.log(`  - ${issue.company}: ${issue.field} = ${issue.parsedValue}, expected ${issue.expectedValue}. ${issue.issue}`);
          });
        }
      }
    } catch (validationError) {
      console.error('AI validation error (non-fatal, continuing with original data):', validationError.message);
    }

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

    // Row 1 style: DARK BLUE with solid white borders - font 12
    const row1DarkStyle = {
      fill: COLORS.darkBlue,
      color: COLORS.white,
      fontFace: 'Segoe UI',
      fontSize: 12,
      bold: false,
      valign: 'middle',
      align: 'center',
      margin: cellMargin,
      border: solidWhiteBorder
    };

    // Row 1 empty cells (white background) with solid white borders - font 12
    const row1EmptyStyle = {
      fill: COLORS.white,
      color: COLORS.black,
      fontFace: 'Segoe UI',
      fontSize: 12,
      valign: 'middle',
      margin: cellMargin,
      border: solidWhiteBorder
    };

    // Row 2 style: LIGHT BLUE with WHITE text, font 12, center aligned, solid white borders
    const row2Style = {
      fill: COLORS.lightBlue,
      color: COLORS.white,
      fontFace: 'Segoe UI',
      fontSize: 12,
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
      fontSize: 12,
      valign: 'middle',
      margin: cellMargin,
      border: [dashBorder, dataVerticalBorder, dashBorder, dataVerticalBorder]
    };

    // Median "Median" label style - light blue with dash top and bottom borders
    const medianLabelStyle = {
      fill: COLORS.lightBlue,
      color: COLORS.white,
      fontFace: 'Segoe UI',
      fontSize: 12,
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
      fontSize: 12,
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
      fontSize: 12,
      valign: 'middle',
      margin: cellMargin,
      border: [noBorder, noBorder, noBorder, noBorder]
    };

    // Last data row style - sysDash border at bottom (line below last company), white solid vertical borders
    const lastDataStyle = {
      fill: COLORS.white,
      color: COLORS.black,
      fontFace: 'Segoe UI',
      fontSize: 12,
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
      fontSize: 12,
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
  'SG': 'Singapore',
  'ISP': 'Internet Service Provider',
  'IBC': 'International Broadcasting',
  'IT': 'Information Technology',
  'AI': 'Artificial Intelligence',
  'IoT': 'Internet of Things',
  'ERP': 'Enterprise Resource Planning',
  'CRM': 'Customer Relationship Management',
  'SaaS': 'Software as a Service',
  'API': 'Application Programming Interface',
  'IP-KVM': 'Internet Protocol Keyboard Video Mouse',
  'KVM': 'Keyboard Video Mouse',
  'CCTV': 'Closed-Circuit Television',
  'UPS': 'Uninterruptible Power Supply',
  'NEC': 'Nippon Electric Company',
  'HACCP': 'Hazard Analysis Critical Control Point',
  'GMP': 'Good Manufacturing Practice',
  'CE': 'Conformité Européenne',
  'FDA': 'Food and Drug Administration',
  'SKU': 'Stock Keeping Unit',
  'POE': 'Power over Ethernet',
  'LAN': 'Local Area Network',
  'WAN': 'Wide Area Network',
  'VPN': 'Virtual Private Network'
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
  'B2B', 'B2C',            // Business models
  'AI', 'IT', 'IoT'        // Tech terms - widely known
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
      if (metric?.label) textParts.push(ensureString(metric.label));
      if (metric?.value) textParts.push(ensureString(metric.value));
    });
  }

  // Also include breakdown_items
  if (companyData.breakdown_items && Array.isArray(companyData.breakdown_items)) {
    companyData.breakdown_items.forEach(item => {
      if (item?.label) textParts.push(ensureString(item.label));
      if (item?.value) textParts.push(ensureString(item.value));
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
async function generatePPTX(companies, targetDescription = '') {
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

    // ===== TARGET LIST SLIDE (FIRST SLIDE) =====
    if (targetDescription && companies.length > 0) {
      console.log('Generating Target List slide...');
      const meceData = await generateMECESegments(targetDescription, companies);

      const targetSlide = pptx.addSlide();

      // ===== HEADER LINES (same as profile slides) =====
      targetSlide.addShape(pptx.shapes.LINE, {
        x: 0, y: 1.02, w: 13.333, h: 0,
        line: { color: COLORS.headerLine, width: 4.5 }
      });
      targetSlide.addShape(pptx.shapes.LINE, {
        x: 0, y: 1.10, w: 13.333, h: 0,
        line: { color: COLORS.headerLine, width: 2.25 }
      });

      // ===== FOOTER LINE =====
      targetSlide.addShape(pptx.shapes.LINE, {
        x: 0, y: 7.24, w: 13.333, h: 0,
        line: { color: COLORS.headerLine, width: 2.25 }
      });

      // Title Case helper function
      const toTitleCase = (str) => {
        return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
      };

      // Title: "Target List – {Target Description}" in Title Case
      // Position same as profile slides, valign: bottom
      const formattedTitle = `Target List – ${toTitleCase(targetDescription)}`;
      targetSlide.addText(formattedTitle, {
        x: 0.38, y: 0.07, w: 9.5, h: 0.9,
        fontSize: 24, fontFace: 'Segoe UI',
        color: '000000', valign: 'bottom'
      });

      // Helper function to parse location (handles JSON format like {"HQ":"Singapore"})
      // Also cleans up "HQ:", "- HQ:" prefixes from location values
      const parseLocation = (location) => {
        if (!location) return { country: 'Other', hqCity: '' };
        let loc = ensureString(location);

        // Clean up "- HQ:" or "HQ:" prefix from the start
        loc = loc.replace(/^-?\s*HQ:\s*/i, '').trim();

        // Check if location is JSON format (e.g., {"HQ":"Chatuchak, Bangkok, Thailand"})
        if (loc.includes('{') && loc.includes('}')) {
          try {
            // Try to extract the value from JSON-like string
            const match = loc.match(/"HQ"\s*:\s*"([^"]+)"/i) || loc.match(/"([^"]+)"\s*:\s*"([^"]+)"/);
            if (match) {
              let hqValue = match[1] || match[2] || '';
              // Clean up any remaining "HQ:" prefix
              hqValue = hqValue.replace(/^-?\s*HQ:\s*/i, '').trim();
              const parts = hqValue.split(',').map(p => p.trim());
              // Country is always last part
              const country = parts[parts.length - 1] || 'Other';
              // HQ city is first part only (just the district/area, not including state)
              const hqCity = parts[0] || '';
              return { country, hqCity };
            }
          } catch (e) {
            // Fall through to normal parsing
          }
        }

        // Normal parsing - extract country from location (last part after comma)
        const parts = loc.split(',').map(p => p.trim());
        const country = parts[parts.length - 1] || 'Other';
        // HQ city is first part only (just the district/area)
        const hqCity = parts[0] || '';
        return { country, hqCity };
      };

      // Group companies by country
      const companyByCountry = {};
      companies.forEach((c, i) => {
        const { country, hqCity } = parseLocation(c.location);
        if (!companyByCountry[country]) companyByCountry[country] = [];
        companyByCountry[country].push({ ...c, index: i + 1, hqCity });
      });

      // Determine if single country or multi-country
      const countries = Object.keys(companyByCountry);
      const isMultiCountry = countries.length > 1;

      // Build table data
      const segments = meceData.segments || [];
      const companySegments = meceData.companySegments || {};

      // Template colors (from analysis of YCP Target List Slide Template)
      const TL_COLORS = {
        headerBg: '1524A9',      // Dark blue for header row
        countryBg: '011AB7',     // Dark blue for country column (accent3)
        companyBg: '007FFF',     // Bright blue for company column (accent1)
        white: 'FFFFFF',
        black: '000000',
        gray: 'BFBFBF',          // Gray for dotted borders between rows
        checkMark: '00B050'      // Green for check marks
      };

      // Build table rows
      const tableRows = [];

      // Row 1: Merged header for products (spans all segment columns)
      const productHeaderRow = [];

      if (isMultiCountry) {
        // Empty cell for country column header (white background)
        productHeaderRow.push({
          text: '',
          options: {
            fill: TL_COLORS.white,
            valign: 'middle',
            align: 'center',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      }

      // Empty cell for company column header
      productHeaderRow.push({
        text: '',
        options: {
          fill: TL_COLORS.white,
          valign: 'middle',
          align: 'center',
          border: { pt: 3, color: TL_COLORS.white }
        }
      });

      // Empty cell for HQ column header
      productHeaderRow.push({
        text: '',
        options: {
          fill: TL_COLORS.white,
          valign: 'middle',
          align: 'center',
          border: { pt: 3, color: TL_COLORS.white }
        }
      });

      // Merged header for all product columns (spans all segment columns)
      if (segments.length > 0) {
        productHeaderRow.push({
          text: 'Products / Services',
          options: {
            colspan: segments.length,
            fill: TL_COLORS.headerBg,
            color: TL_COLORS.white,
            bold: false,
            align: 'center',
            valign: 'middle',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      }

      tableRows.push(productHeaderRow);

      // Row 2: Segment names (sub-headers for products)
      const headerRow = [];

      if (isMultiCountry) {
        // Empty cell for country column header (white background)
        headerRow.push({
          text: '',
          options: {
            fill: TL_COLORS.white,
            valign: 'middle',
            align: 'center',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      }

      // Empty cell for company column header
      headerRow.push({
        text: '',
        options: {
          fill: TL_COLORS.white,
          valign: 'middle',
          align: 'center',
          border: { pt: 3, color: TL_COLORS.white }
        }
      });

      // HQ column header (dark blue background, white text)
      headerRow.push({
        text: 'HQ',
        options: {
          fill: TL_COLORS.headerBg,
          color: TL_COLORS.white,
          bold: false,
          align: 'center',
          valign: 'middle',
          border: { pt: 3, color: TL_COLORS.white }
        }
      });

      // Segment headers (bright blue background like company names, white text)
      segments.forEach(seg => {
        headerRow.push({
          text: seg,
          options: {
            fill: TL_COLORS.companyBg,
            color: TL_COLORS.white,
            bold: false,
            align: 'center',
            valign: 'middle',
            border: { pt: 3, color: TL_COLORS.white }
          }
        });
      });

      tableRows.push(headerRow);

      // Data rows grouped by country
      const countryKeys = Object.keys(companyByCountry);
      countryKeys.forEach((country) => {
        const countryCompanies = companyByCountry[country];
        countryCompanies.forEach((comp, idx) => {
          const row = [];
          const isFirstInCountry = idx === 0;
          const isLastInCountry = idx === countryCompanies.length - 1;

          // Determine if this is the last company in the last country (for bottom border)
          const isLastCountry = countryKeys.indexOf(country) === countryKeys.length - 1;
          const isVeryLastRow = isLastCountry && isLastInCountry;

          // Border style: dotted gray between rows, solid white on edges
          const rowBottomBorder = isVeryLastRow
            ? { pt: 3, color: TL_COLORS.white }
            : { pt: 1, color: TL_COLORS.gray, type: 'dash' };

          if (isMultiCountry) {
            // Country column (only show text for first company in group, use rowspan)
            if (isFirstInCountry) {
              row.push({
                text: country,
                options: {
                  rowspan: countryCompanies.length,
                  fill: TL_COLORS.countryBg,
                  color: TL_COLORS.white,
                  bold: false,
                  align: 'center',
                  valign: 'middle',
                  border: { pt: 3, color: TL_COLORS.white }
                }
              });
            }
          }

          // Company name with numbering (bright blue background, WHITE text, left-aligned)
          // Keep 3pt white borders on ALL sides for company name cells
          const companyName = comp.title || comp.company_name || 'Unknown';
          row.push({
            text: `${comp.index}. ${companyName}`,
            options: {
              fill: TL_COLORS.companyBg,
              color: TL_COLORS.white,
              bold: false,
              align: 'left',
              valign: 'middle',
              border: { pt: 3, color: TL_COLORS.white },
              hyperlink: { url: comp.website || '' }
            }
          });

          // HQ column (white background, black text)
          const hqCity = comp.hqCity || '';
          row.push({
            text: hqCity,
            options: {
              fill: TL_COLORS.white,
              color: TL_COLORS.black,
              bold: false,
              align: 'left',
              valign: 'middle',
              border: [
                { pt: 3, color: TL_COLORS.white },    // top
                { pt: 3, color: TL_COLORS.white },    // right
                rowBottomBorder,                       // bottom (dotted between rows)
                { pt: 3, color: TL_COLORS.white }     // left
              ]
            }
          });

          // Segment tick marks (white background, green check marks)
          const compSegments = companySegments[String(comp.index)] || [];
          segments.forEach((seg, segIdx) => {
            const hasTick = compSegments[segIdx] === true;
            row.push({
              text: hasTick ? '✓' : '',
              options: {
                fill: TL_COLORS.white,
                color: TL_COLORS.checkMark,
                align: 'center',
                valign: 'middle',
                border: [
                  { pt: 3, color: TL_COLORS.white },    // top
                  { pt: 3, color: TL_COLORS.white },    // right
                  rowBottomBorder,                       // bottom (dotted between rows)
                  { pt: 3, color: TL_COLORS.white }     // left
                ]
              }
            });
          });

          tableRows.push(row);
        });
      });

      // Calculate column widths (from template: Country=1.12", Company=2.14", HQ=1.5", Segments=~1.17" each)
      const tableWidth = 12.6;
      let colWidths = [];

      if (isMultiCountry) {
        const countryColWidth = 1.12;
        const companyColWidth = 2.14;
        const hqColWidth = 1.5;
        const remainingWidth = tableWidth - countryColWidth - companyColWidth - hqColWidth;
        const segmentColWidth = segments.length > 0 ? remainingWidth / segments.length : 1.17;
        colWidths = [countryColWidth, companyColWidth, hqColWidth];
        segments.forEach(() => colWidths.push(segmentColWidth));
      } else {
        // Single country - no country column, company column takes more space
        const companyColWidth = 2.5;
        const hqColWidth = 1.5;
        const remainingWidth = tableWidth - companyColWidth - hqColWidth;
        const segmentColWidth = segments.length > 0 ? remainingWidth / segments.length : 1.17;
        colWidths = [companyColWidth, hqColWidth];
        segments.forEach(() => colWidths.push(segmentColWidth));
      }

      // Add target list table (position from template: x=0.3663", y=1.467")
      // Cell margins: 0.1 inch left/right, 0 inch top/bottom
      targetSlide.addTable(tableRows, {
        x: 0.37, y: 1.47, w: tableWidth,
        colW: colWidths,
        fontFace: 'Segoe UI',
        fontSize: 14,
        valign: 'middle',
        rowH: 0.32,
        margin: [0, 0.1, 0, 0.1]  // [top, right, bottom, left] in inches
      });

      // Footnote (from template: x=0.3754", y=6.6723", font 10pt)
      targetSlide.addText('出典: Company websites', {
        x: 0.38, y: 6.67, w: 12.54, h: 0.42,
        fontSize: 10, fontFace: 'Segoe UI',
        color: '000000', valign: 'top'
      });

      console.log('Target List slide generated');
    }

    // ===== INDIVIDUAL COMPANY PROFILE SLIDES =====
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
            const flagX = 10.64, flagY = 0.22, flagW = 0.83, flagH = 0.55;
            // Add flag image
            slide.addImage({
              data: `data:image/png;base64,${flagBase64}`,
              x: flagX, y: flagY, w: flagW, h: flagH
            });
            // Add 1pt black outline around flag
            slide.addShape(pptx.shapes.RECTANGLE, {
              x: flagX, y: flagY, w: flagW, h: flagH,
              fill: { type: 'none' },
              line: { color: '000000', width: 1 }
            });
          }
        } catch (e) {
          console.log('Flag fetch failed for', countryCode);
        }
      }

      // ===== LOGO (top right of slide) =====
      if (company.website && typeof company.website === 'string') {
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
      const locationText = ensureString(company.location);
      const locationLines = locationText.split('\n').filter(line => line.trim());
      const isSingleLocation = locationLines.length <= 1 && !locationText.toLowerCase().includes('branch') && !locationText.toLowerCase().includes('factory') && !locationText.toLowerCase().includes('warehouse');
      const locationLabel = isSingleLocation ? 'HQ' : 'Location';

      // Helper function to check if value is empty or placeholder text
      const isEmptyValue = (val) => {
        if (!val) return true;
        const strVal = ensureString(val);
        const lower = strVal.toLowerCase().trim();
        const emptyPhrases = [
          '', 'not specified', 'n/a', 'unknown', 'not available', 'not found',
          'not explicitly mentioned', 'not mentioned', 'none', 'none specified',
          'not disclosed', 'not provided', 'no information', 'no data',
          'none explicitly mentioned'
        ];
        // Check exact match or if value contains placeholder phrases
        if (emptyPhrases.includes(lower)) return true;
        // Check if value contains placeholder phrases (e.g., "Number of Employees: Not specified")
        const containsPhrases = ['not specified', 'not available', 'not found', 'not disclosed',
                                  'not provided', 'not mentioned', 'not explicitly', 'none explicitly',
                                  'no information', 'no data', 'n/a', 'unknown'];
        for (const phrase of containsPhrases) {
          if (lower.includes(phrase)) return true;
        }
        return false;
      };

      // Helper function to remove company suffixes
      const removeCompanySuffix = (name) => {
        if (!name) return name;
        return name
          .replace(/\s*(Co\.,?\s*Ltd\.?|Ltd\.?|Sdn\.?\s*Bhd\.?|Pte\.?\s*Ltd\.?|Inc\.?|Corp\.?|LLC|GmbH|JSC|PT\.?|Tbk\.?|S\.?A\.?|PLC)\s*$/gi, '')
          .trim();
      };

      // Helper function to clean location value (remove JSON format and "HQ:" prefix)
      const cleanLocationValue = (location, label) => {
        if (!location) return location;
        let cleaned = location;

        // Handle JSON format like {"HQ":"Chatuchak, Bangkok, Thailand"} or {"HQ":"CBD, Singapore"}
        if (cleaned.includes('{') && cleaned.includes('}')) {
          try {
            // Try to extract the value from JSON-like string
            const match = cleaned.match(/"HQ"\s*:\s*"([^"]+)"/i) || cleaned.match(/"([^"]+)"\s*:\s*"([^"]+)"/);
            if (match) {
              cleaned = match[1] || match[2] || cleaned;
            }
          } catch (e) {
            // Fall through to normal cleaning
          }
        }

        // If label is HQ, remove "- HQ:" or "HQ:" prefix from value
        if (label === 'HQ') {
          cleaned = cleaned.replace(/^-?\s*HQ:\s*/i, '').trim();
        }

        return cleaned;
      };

      // Base company info rows - only add if value exists
      const tableData = [];

      // Always add Name with hyperlink (remove company suffix)
      // Use title as fallback if company_name is empty
      const companyName = company.company_name || company.title || '';
      if (!isEmptyValue(companyName)) {
        const cleanName = removeCompanySuffix(companyName);
        tableData.push(['Name', cleanName, company.website || null]);
      }

      // Add Est. Year if available
      if (!isEmptyValue(company.established_year)) {
        tableData.push(['Est. Year', company.established_year, null]);
      }

      // Add Location if available (clean up HQ: prefix if needed)
      if (!isEmptyValue(company.location)) {
        const cleanLocation = cleanLocationValue(company.location, locationLabel);
        tableData.push([locationLabel, cleanLocation, null]);
      }

      // Add Business if available
      if (!isEmptyValue(company.business)) {
        tableData.push(['Business', company.business, null]);
      }

      // Track existing labels to prevent duplicates
      const existingLabels = new Set(tableData.map(row => row[0].toLowerCase()));

      // Metrics to exclude (worthless or duplicate)
      const EXCLUDED_METRICS = [
        'market position', 'market share', 'market leader',
        'number of branches', 'branches', 'number of locations', 'locations',
        'operating hours', 'business hours', 'office hours',
        'years of experience', 'experience', 'years in business',
        'awards', 'recognitions', 'achievements',
        'certification', 'certifications', 'iso', 'accreditation', 'accreditations'
      ];

      // Get the right table category to exclude from left table (prevent duplication)
      const rightTableCategory = ensureString(company.breakdown_title).toLowerCase();
      // Map breakdown titles to keywords to exclude
      const categoryKeywords = {
        'customers': ['customer', 'client', 'buyer'],
        'services': ['service'],
        'products and applications': ['product', 'application'],
        'key suppliers': ['supplier', 'vendor', 'partner'],
        'key partnerships': ['partner', 'partnership']
      };
      const excludeKeywords = categoryKeywords[rightTableCategory] || [];

      // Add key metrics as separate rows if available (skip duplicates and empty values)
      if (company.key_metrics && Array.isArray(company.key_metrics)) {
        company.key_metrics.forEach(metric => {
          // Ensure label and value are strings (AI may return objects/arrays)
          const metricLabel = ensureString(metric?.label);
          const metricValue = ensureString(metric?.value);

          if (metricLabel && metricValue && !isEmptyValue(metricValue)) {
            const labelLower = metricLabel.toLowerCase();

            // Skip excluded metrics
            const isExcluded = EXCLUDED_METRICS.some(ex => labelLower.includes(ex));

            // Skip if this category is already shown on the right table
            const isInRightTable = excludeKeywords.some(kw => labelLower.includes(kw));

            // Skip if this label already exists or is duplicate of business/location
            if (!isExcluded &&
                !isInRightTable &&
                !existingLabels.has(labelLower) &&
                !labelLower.includes('business') &&
                !labelLower.includes('location')) {
              tableData.push([metricLabel, metricValue, null]);
              existingLabels.add(labelLower);
            }
          }
        });
      } else if (company.metrics && !isEmptyValue(company.metrics)) {
        // Fallback for old format (single string)
        tableData.push(['Key Metrics', company.metrics, null]);
      }

      // Helper function to format cell text with bullet points
      // Uses regular bullet • (U+2022) directly in text
      const formatCellText = (text) => {
        if (!text || typeof text !== 'string') return text;

        // Check if text has multiple lines - if so, format as bullet points
        const hasMultipleLines = text.includes('\n');
        const hasBulletMarkers = text.includes('■') || text.includes('•') || text.includes('\n-') || text.startsWith('-');

        if (hasMultipleLines || hasBulletMarkers) {
          // Split by newline and filter out empty lines
          const lines = text.split('\n').filter(line => line.trim());

          // Only format as bullets if we have 2+ lines
          if (lines.length >= 2) {
            // Clean each line and prepend bullet character directly
            const formattedLines = lines.map(line => {
              const cleanLine = line.replace(/^[■\-•]\s*/, '').trim();
              return '• ' + cleanLine;
            });
            return formattedLines.join('\n');
          }
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
      // Filter valid breakdown items (non-empty) and ensure string types
      const validBreakdownItems = (company.breakdown_items || [])
        .map(item => ({
          label: ensureString(item?.label),
          value: ensureString(item?.value)
        }))
        .filter(item => item.label && item.value && !isEmptyValue(item.label) && !isEmptyValue(item.value));

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
// Using GPT-4o-mini (60% cost savings for simple extraction task)
async function extractBasicInfo(scrapedContent, websiteUrl) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
  SINGAPORE RULE: Always use 2 levels: "District/Area, Singapore". Extract the specific neighborhood/district/area from the street address. NEVER use generic terms like "CBD" or "Central" - instead extract the actual neighborhood name from the address.
  Singapore district examples by postal code prefix or road name:
  - "Jurong West, Singapore" (Jurong area roads)
  - "Woodlands, Singapore" (Woodlands area)
  - "Yishun, Singapore" (Yishun area)
  - "Ang Mo Kio, Singapore" (AMK area)
  - "Tuas, Singapore" (Tuas industrial area)
  - "Changi, Singapore" (Changi area)
  - "Bedok, Singapore" (Bedok area)
  - "Tampines, Singapore" (Tampines area)
  - "Bukit Batok, Singapore" (Bukit Batok area)
  - "Toa Payoh, Singapore" (Toa Payoh area)
  - "Geylang, Singapore" (Geylang area)
  - "Raffles Place, Singapore" (Financial district)
  - "Marina Bay, Singapore" (Marina area)
  - "Orchard, Singapore" (Orchard Road area)
  If address has a specific road name like "Ubi", "Kaki Bukit", "Paya Lebar", etc., use that area name. NEVER use "Singapore, Singapore" - always find the specific area.

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
- Write ALL text using regular English alphabet only (A-Z, no diacritics/accents)
- Convert ALL Vietnamese: "Phú" → "Phu", "Đông" → "Dong", "Nguyễn" → "Nguyen", "Bình" → "Binh", "Thạnh" → "Thanh", "Cương" → "Cuong"
- Convert ALL foreign characters: "São" → "Sao", "北京" → "Beijing", "東京" → "Tokyo"
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
// Using GPT-4o-mini (60% cost savings for structured output task)
async function extractBusinessInfo(scrapedContent, basicInfo) {
  // Ensure locationText is always a string (AI might return object/array)
  const locationText = typeof basicInfo.location === 'string' ? basicInfo.location : '';
  const hqMatch = locationText.match(/HQ:\s*([^,\n]+),\s*([^\n]+)/i);
  const hqCountry = hqMatch ? hqMatch[2].trim().toLowerCase() : '';
  const currencyExchange = CURRENCY_EXCHANGE[hqCountry] || '';

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
- Write ALL text using regular English alphabet only (A-Z, no diacritics/accents)
- Convert ALL Vietnamese: "Phú" → "Phu", "Đông" → "Dong", "Nguyễn" → "Nguyen", "Bình" → "Binh", "Thạnh" → "Thanh", "Cương" → "Cuong"
- Convert ALL foreign characters: "São" → "Sao", "北京" → "Beijing", "東京" → "Tokyo"
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
// Using GPT-4o-mini (60% cost savings for pattern-based extraction)
async function extractKeyMetrics(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
- Export countries (only if exports to multiple countries, list regions)
- Distribution network (number of distributors/partners)
- Markets served (if domestic only, write "Nationwide" instead of listing regions)

QUALITY & COMPLIANCE:
- Certifications (ISO, HACCP, GMP, FDA, CE, halal, etc.)
- Patents or proprietary technology

OUTPUT JSON:
{
  "key_metrics": [
    {"label": "Key Metrics", "value": "- Production capacity of 800+ tons per month\\n- 250+ machines\\n- 300+ employees"},
    {"label": "Key Suppliers", "value": "6 suppliers including Hikvision, Dahua, Paradox, ZKTeco, Ruijie"},
    {"label": "Export Countries", "value": "SEA, South Asia, North Africa"},
    {"label": "Distribution Network", "value": "700 domestic distribution partners"},
    {"label": "Certification", "value": "ISO 9001, ISO 14001"},
    {"label": "Notable Partnerships", "value": "Launch partnership with Dainichiseika Color & Chemicals (Japanese) in 2009 technology transfer, joint product development and marketing"}
  ]
}

MERGE DUPLICATIVE INFORMATION:
When you find BOTH a count AND specific names for the same category, MERGE them into ONE coherent entry:
- BAD: {"label": "Number of Suppliers", "value": "6"} AND {"label": "Key Suppliers", "value": "Hikvision, Dahua, Paradox"}
- GOOD: {"label": "Key Suppliers", "value": "6 suppliers including Hikvision, Dahua, Paradox, ZKTeco, Ruijie"}

- BAD: {"label": "Number of Customers", "value": "250,000"} AND {"label": "Key Customers", "value": "Installers, Dealers, Integrators"}
- GOOD: {"label": "Key Customers", "value": "Over 250,000 installations including Installers, Dealers, System Integrators"}

- BAD: {"label": "Number of Employees", "value": "100+"} in metrics array
- GOOD: Include employee count in "Key Metrics" bullet point

SEGMENTATION REQUIREMENT:
For metrics with MANY items (e.g., Customers, Suppliers), segment them by category using POINT FORM:
Example for Customers:
{"label": "Customers", "value": "- Residential: Customer1, Customer2, Customer3\\n- Commercial: Customer4, Customer5\\n- Industrial: Customer6, Customer7"}

Example for Suppliers:
{"label": "Suppliers", "value": "- Raw Materials: Supplier1, Supplier2\\n- Packaging: Supplier3, Supplier4\\n- Equipment: Supplier5"}

IMPORTANT: Always use "- " prefix for each segment line to create point form for easier reading.

RULES:
- Write ALL text using regular English alphabet only (A-Z, no diacritics/accents)
- Convert ALL Vietnamese: "Phú" → "Phu", "Đông" → "Dong", "Nguyễn" → "Nguyen", "Bình" → "Binh", "Thạnh" → "Thanh", "Cương" → "Cuong", "Thiêm" → "Thiem"
- Convert ALL foreign characters: "São" → "Sao", "北京" → "Beijing", "東京" → "Tokyo"
- Remove company suffixes from ALL names: Co., Ltd, JSC, Sdn Bhd, Pte Ltd, Inc, Corp, LLC, GmbH
- Extract as many metrics as found (8-15 ideally)
- For metrics with multiple items, use "- " bullet points separated by "\\n"
- For long lists of customers/suppliers, SEGMENT by category as shown above
- Labels should be 1-3 words
- Be specific with numbers when available
- For Shareholding: ONLY include if EXPLICITLY stated on website (e.g., "family-owned", "publicly traded", "PE-backed"). NEVER assume ownership structure.
- DO NOT include: years of experience, awards, recognitions, market position, operating hours, number of branches/locations (not useful for M&A)
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
// Using GPT-4o-mini (60% cost savings for category segmentation)
async function extractProductsBreakdown(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst deciding what to put in the RIGHT-SIDE TABLE of a company profile slide.

THE RIGHT SIDE HAS MORE SPACE - use it for the content with THE MOST DATA.

DECISION PROCESS:
1. Count how many items each category has:
   - How many CUSTOMERS are listed?
   - How many PRODUCTS are shown?
   - How many SERVICES are offered?
   - How many SUPPLIERS/PARTNERS are mentioned?
2. Pick the category with THE HIGHEST COUNT to display on the right side
3. The right table can show more detail, so put the richest content there

EXAMPLE:
- If website lists 20 customers but only 5 services → use "Customers"
- If website shows 15 products but only 3 customers → use "Products and Applications"
- If website has 10 suppliers but only 2 products → use "Key Suppliers"

CATEGORY OPTIONS:
1. "Customers" - When many clients listed (segment by industry: Educational, Government, Healthcare, etc.)
2. "Products and Applications" - When many products shown (segment by type/application)
3. "Services" - When many services offered (segment by service type)
4. "Key Suppliers" - When many suppliers/partners mentioned
5. "Product Categories" - When product catalog is extensive
6. "Business Segments" - When multiple distinct business units

OUTPUT JSON:
{
  "breakdown_title": "Customers",
  "breakdown_items": [
    {"label": "Educational", "value": "University A, Polytechnic B, School C"},
    {"label": "Government", "value": "Agency X, Ministry Y"},
    {"label": "Healthcare", "value": "Hospital A, Clinic B"}
  ]
}

RULES:
- Write ALL text using regular English alphabet only (A-Z, no diacritics/accents)
- Convert ALL Vietnamese: "Phú" → "Phu", "Đông" → "Dong", "Nguyễn" → "Nguyen", "Bình" → "Binh", "Thạnh" → "Thanh", "Cương" → "Cuong"
- Convert ALL foreign characters: "São" → "Sao", "北京" → "Beijing", "東京" → "Tokyo"
- Remove company suffixes from ALL names: Co., Ltd, JSC, Sdn Bhd, Pte Ltd, Inc, Corp, LLC, GmbH
- PRIORITIZE the category with MOST available content from the website
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
// Using GPT-4o-mini (60% cost savings for number extraction)
async function extractFinancialMetrics(scrapedContent, previousData) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
      model: 'gpt-4o-search-preview',
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
      model: 'gpt-4o-search-preview',
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

// AI Agent 6: Generate MECE segments for target list slide
async function generateMECESegments(targetDescription, companies) {
  if (!targetDescription || companies.length === 0) {
    return { segments: [], companySegments: {} };
  }

  try {
    console.log('Generating MECE segments for target list...');

    // Prepare company summaries for AI
    const companySummaries = companies.map((c, i) => ({
      id: i + 1,
      name: c.title || c.company_name || 'Unknown',
      business: c.business || '',
      location: c.location || ''
    }));

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an M&A analyst creating a target list slide. Given a target description and company information, create MECE (Mutually Exclusive, Collectively Exhaustive) segments to categorize these companies.

Create 4-6 segment columns that are:
1. Relevant to the target description (e.g., for "security product distributors" → segments could be product types like "CCTV", "Access Control", "Fire Safety", etc.)
2. Mutually exclusive (each segment is distinct)
3. Collectively exhaustive (covers all relevant categories for this industry)

For each company, mark which segments apply to them based on their business description.

OUTPUT JSON:
{
  "segments": ["Segment 1", "Segment 2", "Segment 3", "Segment 4", "Segment 5"],
  "companySegments": {
    "1": [true, false, true, false, true],
    "2": [false, true, true, true, false]
  }
}

Where:
- "segments" is an array of 4-6 segment names (short, 2-3 words each)
- "companySegments" maps company ID to an array of booleans indicating which segments apply

Return ONLY valid JSON.`
        },
        {
          role: 'user',
          content: `Target Description: ${targetDescription}

Companies:
${companySummaries.map(c => `${c.id}. ${c.name}\n   Business: ${c.business}\n   Location: ${c.location}`).join('\n\n')}

Create MECE segments for these ${targetDescription} companies and mark which segments apply to each.`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    const result = JSON.parse(response.choices[0].message.content);
    console.log(`Generated ${result.segments?.length || 0} MECE segments`);
    return result;
  } catch (e) {
    console.error('MECE segmentation error:', e.message);
    return { segments: [], companySegments: {} };
  }
}

// AI Review Agent: Clean up and remove duplicative/unnecessary information
// Uses Gemini 3 Flash for frontier reasoning - with GPT-4o fallback if Gemini fails
async function reviewAndCleanData(companyData) {
  try {
    console.log('  Step 6: Running AI review agent (Gemini 3 Flash with GPT-4o fallback)...');

    const prompt = `You are a data quality reviewer for M&A company profiles. Review the extracted data and clean it up by:

1. REMOVE DUPLICATIVE ROWS:
   - If "Number of X" appears alongside "Key X names", merge them into one row
   - Example: "Number of Suppliers: 6" + "Key Suppliers: A, B, C" → "Key Suppliers: 6 suppliers including A, B, C"
   - Example: "Number of Customers" + "Key Customers" → merge into "Key Customers"

2. REMOVE UNNECESSARY/WORTHLESS ROWS:
   - Remove rows with vague values like "Various", "Multiple", "Several" without specifics
   - Remove rows about awards, achievements, recognitions (not useful for M&A)
   - Remove rows about years of experience (not useful for M&A)
   - Remove rows about operating hours, office hours

3. MERGE SIMILAR INFORMATION:
   - "Customers" and "Customer Segments" → merge into one "Key Customers" row
   - "Products" and "Product Categories" → keep only the more detailed one
   - If breakdown_items and key_metrics have overlapping info, keep in key_metrics only

4. CLEAN UP HQ/LOCATION:
   - If location looks like JSON ({"HQ":"..."}), extract the actual location value
   - Format should be: "City, State/Province, Country" or "District, Singapore" for Singapore

Review and clean this company data:

${JSON.stringify(companyData, null, 2)}

OUTPUT JSON with the same structure but cleaned up:
{
  "company_name": "...",
  "established_year": "...",
  "location": "cleaned location",
  "business": "...",
  "message": "...",
  "title": "...",
  "key_metrics": [cleaned array],
  "breakdown_title": "...",
  "breakdown_items": [cleaned array]
}

Return ONLY valid JSON.`;

    // Use Gemini 3 Flash with JSON mode for frontier reasoning
    const result = await callGemini3Flash(prompt, true);

    if (!result) {
      console.log('  AI review agent (both Gemini 3 Flash and GPT-4o) returned empty, keeping original data');
      return companyData;
    }

    // Parse JSON from response
    let cleaned;
    try {
      cleaned = JSON.parse(result);
    } catch (parseError) {
      // Try to extract JSON from response if not pure JSON
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleaned = JSON.parse(jsonMatch[0]);
      } else {
        console.log('  Failed to parse Gemini response, keeping original data');
        return companyData;
      }
    }

    // Merge cleaned data with original (preserve fields not in prompt)
    return {
      ...companyData,
      location: cleaned.location || companyData.location,
      key_metrics: cleaned.key_metrics || companyData.key_metrics,
      breakdown_items: cleaned.breakdown_items || companyData.breakdown_items
    };
  } catch (e) {
    console.error('Review agent error:', e.message);
    return companyData; // Return original data if review fails
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
          <h4 style="margin: 0 0 8px 0;">${i + 1}. ${ensureString(c.title || c.company_name) || 'Unknown'}</h4>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Website:</strong> ${ensureString(c.website)}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Established:</strong> ${ensureString(c.established_year) || '-'}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Location:</strong> ${ensureString(c.location) || '-'}</p>
          <p style="margin: 4px 0; font-size: 13px;"><strong>Business:</strong> ${ensureString(c.business) || '-'}</p>
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
  const { websites, email, targetDescription } = req.body;

  if (!websites || !Array.isArray(websites) || websites.length === 0) {
    return res.status(400).json({ error: 'Please provide an array of website URLs' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Please provide an email address' });
  }

  if (!targetDescription) {
    return res.status(400).json({ error: 'Please provide a target description' });
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`PROFILE SLIDES REQUEST: ${new Date().toISOString()}`);
  console.log(`Target: ${targetDescription}`);
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
      logMemoryUsage(`start company ${i + 1}`);

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

        // Step 5: Search online for missing mandatory info (established_year, location)
        // These are mandatory fields - search online if not found on website
        const missingFields = [];
        if (!basicInfo.established_year) missingFields.push('established_year');
        if (!basicInfo.location) missingFields.push('location');

        let searchedInfo = {};
        if (missingFields.length > 0 && basicInfo.company_name) {
          console.log(`  Step 5: Searching online for missing mandatory info: ${missingFields.join(', ')}...`);
          searchedInfo = await searchMissingInfo(basicInfo.company_name, website, missingFields);
        }

        // Use only key metrics from scraped website (no web search for metrics to prevent hallucination)
        const allKeyMetrics = metricsInfo.key_metrics || [];

        // Combine all extracted data (mandatory fields supplemented by web search)
        // Use ensureString() for all AI-generated fields to prevent [object Object] issues
        let companyData = {
          website: scraped.url,
          company_name: ensureString(basicInfo.company_name),
          established_year: ensureString(basicInfo.established_year || searchedInfo.established_year),
          location: ensureString(basicInfo.location || searchedInfo.location),
          business: ensureString(businessInfo.business),
          message: ensureString(businessInfo.message),
          footnote: ensureString(businessInfo.footnote),
          title: ensureString(businessInfo.title),
          key_metrics: allKeyMetrics,  // Only from scraped website
          breakdown_title: ensureString(productsBreakdown.breakdown_title) || 'Products and Applications',
          breakdown_items: productsBreakdown.breakdown_items || [],
          metrics: ensureString(metricsInfo.metrics)  // Fallback for old format
        };

        // Step 6: Run AI review agent to clean up duplicative/unnecessary data
        companyData = await reviewAndCleanData(companyData);

        console.log(`  ✓ Completed: ${companyData.title || companyData.company_name} (${companyData.key_metrics?.length || 0} metrics after review)`);
        results.push(companyData);

        // Memory cleanup: Release large objects to prevent OOM on Railway
        // scraped.content can be 1-5MB per website, must release before next iteration
        if (scraped) scraped.content = null;

      } catch (error) {
        console.error(`  Error processing ${website}:`, error.message);
        results.push({
          website,
          error: error.message,
          step: 0
        });
      }

      // Force garbage collection hint between companies (if available)
      // This helps Railway containers stay under memory limits
      if (global.gc) {
        global.gc();
      }
    }

    const companies = results.filter(r => !r.error);
    const errors = results.filter(r => r.error);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`PROFILE SLIDES EXTRACTION COMPLETE`);
    console.log(`Extracted: ${companies.length}/${websites.length} successful`);
    console.log('='.repeat(50));

    // Memory cleanup before PPTX generation (which is memory-intensive)
    // Clear the results array since we only need companies/errors now
    results.length = 0;
    if (global.gc) global.gc();
    logMemoryUsage('before PPTX generation');

    // Generate PPTX using PptxGenJS (with target list slide)
    let pptxResult = null;
    if (companies.length > 0) {
      pptxResult = await generatePPTX(companies, targetDescription);
      logMemoryUsage('after PPTX generation');
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

    // Memory cleanup after email sent
    if (pptxResult) pptxResult.content = null;
    pptxResult = null;

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
// ============ UTB PHASE 0: DOCUMENT FETCHING ============
// Actually fetch and read company documents (annual reports, mid-term plans, etc.)

async function utbPhase0FetchDocuments(companyName, website, context) {
  console.log(`[UTB Phase 0] Fetching company documents for: ${companyName}`);

  const documents = {
    irPage: '',
    annualReport: '',
    midtermPlan: '',
    mergerInfo: '',
    recentDisclosures: ''
  };

  try {
    // 1. Find and fetch IR page
    const baseUrl = website.replace(/\/$/, '');
    const irUrls = [
      `${baseUrl}/ir/`,
      `${baseUrl}/investor/`,
      `${baseUrl}/investors/`,
      `${baseUrl}/ir`,
      `${baseUrl}/investor-relations/`,
      `${baseUrl}/en/ir/`,
      `${baseUrl}/english/ir/`
    ];

    for (const irUrl of irUrls) {
      const irContent = await fetchWebsite(irUrl);
      if (irContent && irContent.length > 200) {
        documents.irPage = irContent;
        console.log(`[UTB Phase 0] Found IR page at: ${irUrl}`);
        break;
      }
    }

    // 2. Use Perplexity to find specific document content
    const docSearchPromises = [
      // Search for annual report data
      callPerplexity(`Find the OFFICIAL ANNUAL REPORT data for ${companyName} (${website}).

Search for their latest:
- 有価証券報告書 (Securities Report) if Japanese company
- Annual Report / 10-K / 20-F if listed
- Official financial statements

EXTRACT and return the EXACT data:
1. Revenue breakdown by segment (exact percentages from the report)
2. Revenue breakdown by geography (exact percentages)
3. Employee count
4. Key financial metrics

For EACH number, cite: "X% (Source: [Document Name] FY20XX, page Y)"

If you cannot find the official document, state "Official document not accessible".`).catch(e => ''),

      // Search for mid-term plan
      callPerplexity(`Find the OFFICIAL MID-TERM MANAGEMENT PLAN (中期経営計画) for ${companyName} (${website}).

Search for their:
- Medium-term management plan
- 中期経営計画 / 中計
- Strategic plan / business plan

EXTRACT and return:
1. Plan period (e.g., FY2024-2026)
2. Key numerical targets (revenue, profit, ROIC, etc.)
3. Strategic priorities and focus areas
4. Investment priorities
5. M&A strategy if mentioned

Cite the source document name and date for each piece of data.`).catch(e => ''),

      // Search for M&A/merger announcements
      callPerplexity(`Find any MERGER, ACQUISITION, or CORPORATE ACTION announcements for ${companyName} (${website}).

Search for:
- Recent M&A announcements
- Merger agreements (合併契約)
- Business integration news
- Corporate restructuring
${context && context.toLowerCase().includes('nissei') ? `- Specifically look for merger with Nissei` : ''}
${context && context.toLowerCase().includes('merg') ? `- Focus on: ${context}` : ''}

Return:
1. Target/partner company name
2. Transaction type and terms
3. Timeline and status
4. Strategic rationale
5. Source document (press release date, disclosure number)`).catch(e => ''),

      // Search for recent disclosures
      callPerplexity(`Find the most recent OFFICIAL DISCLOSURES and IR materials for ${companyName} (${website}).

Look for:
- Latest earnings release (決算短信)
- Recent investor presentations
- Timely disclosures (適時開示)
- Press releases from last 6 months

Return key announcements with:
1. Date
2. Type of disclosure
3. Key content
4. Source URL if available`).catch(e => '')
    ];

    const [annualReport, midtermPlan, mergerInfo, recentDisclosures] = await Promise.all(docSearchPromises);

    documents.annualReport = annualReport || '';
    documents.midtermPlan = midtermPlan || '';
    documents.mergerInfo = mergerInfo || '';
    documents.recentDisclosures = recentDisclosures || '';

    console.log(`[UTB Phase 0] Documents fetched - IR: ${documents.irPage.length}chars, Annual: ${documents.annualReport.length}chars, Midterm: ${documents.midtermPlan.length}chars, Merger: ${documents.mergerInfo.length}chars`);

  } catch (error) {
    console.error(`[UTB Phase 0] Error fetching documents:`, error.message);
  }

  return documents;
}

async function utbPhase1Research(companyName, website, context, officialDocs = {}) {
  console.log(`[UTB Phase 1] Starting deep fact-finding for: ${companyName}`);
  const localLang = detectLanguage(website);

  // Build document context string from Phase 0
  const docContext = [];
  if (officialDocs.annualReport) docContext.push(`ANNUAL REPORT DATA:\n${officialDocs.annualReport}`);
  if (officialDocs.midtermPlan) docContext.push(`MID-TERM PLAN DATA:\n${officialDocs.midtermPlan}`);
  if (officialDocs.mergerInfo) docContext.push(`MERGER/M&A INFO:\n${officialDocs.mergerInfo}`);
  if (officialDocs.recentDisclosures) docContext.push(`RECENT DISCLOSURES:\n${officialDocs.recentDisclosures}`);
  const documentContext = docContext.length > 0 ? `\n\nOFFICIAL DOCUMENT DATA (use this as primary source):\n${docContext.join('\n\n')}` : '';

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

    // Query 2: Financial Analysis FROM OFFICIAL DOCUMENTS
    callPerplexity(`Research ${companyName} financial data - DATA MUST COME FROM OFFICIAL COMPANY DOCUMENTS:
${documentContext}

CRITICAL: Only provide data you can source from:
- Annual reports (有価証券報告書 for Japanese companies)
- Investor presentations
- Mid-term management plans (中期経営計画)
- Earnings releases
- Official company filings (10-K, 20-F, etc.)

For EVERY number, specify the source document and date.

1. REVENUE BREAKDOWN FROM ANNUAL REPORT:
   - Total annual revenue (fiscal year, currency, source document)
   - Revenue by business segment - EXACT percentages from segment reporting
   - Revenue by geography - EXACT percentages from geographic reporting

2. FROM MID-TERM PLAN (if available):
   - Strategic targets and KPIs
   - Growth projections
   - Investment priorities

3. FROM LATEST EARNINGS:
   - Most recent quarterly results
   - Management commentary

DO NOT estimate or approximate. If exact data is not available in official documents, state "Not disclosed in official filings".

Format each data point as: "[Number] (Source: [Document Name], [Date])"

For Japanese companies specifically search for: 有価証券報告書, 決算短信, 中期経営計画, IR資料`).catch(e => ({ type: 'financials', data: '', error: e.message })),

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

    // Query 4: Competitive Landscape - COMPREHENSIVE
    callPerplexity(`Research ${companyName} competitive landscape - COMPREHENSIVE GLOBAL ANALYSIS:

CRITICAL: This is a large global industry. Provide a COMPREHENSIVE list of competitors.

1. GLOBAL COMPETITORS (list AT LEAST 10-12 companies):
   For EACH competitor provide:
   - Company name
   - HQ country
   - Revenue (with source)
   - Estimated market share (with source if available)
   - Main products/segments they compete in
   - Geographic focus
   - How they position vs ${companyName}

2. ${companyName} COMPETITIVE POSITION:
   - Their market rank with specific market share %
   - What specifically makes customers choose them (with evidence)
   - Specific competitive vulnerabilities

Include all major global players, regional champions, and emerging competitors.
This should be an exhaustive view of the competitive landscape, not a shortlist.

Provide SPECIFIC data with sources. No generic statements.`).catch(e => ({ type: 'competitors', data: '', error: e.message })),

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
async function utbPhase2Synthesis(companyName, website, research, context, officialDocs = {}) {
  console.log(`[UTB Phase 2] Synthesizing intelligence for: ${companyName}`);

  // Build document context for synthesis
  const docContext = [];
  if (officialDocs.annualReport) docContext.push(`ANNUAL REPORT:\n${officialDocs.annualReport}`);
  if (officialDocs.midtermPlan) docContext.push(`MID-TERM PLAN:\n${officialDocs.midtermPlan}`);
  if (officialDocs.mergerInfo) docContext.push(`MERGER INFO:\n${officialDocs.mergerInfo}`);
  const officialDocContext = docContext.length > 0 ? `\n\nOFFICIAL DOCUMENTS (PRIMARY SOURCE - use this data):\n${docContext.join('\n\n')}` : '';

  const synthesisPrompts = [
    // Synthesis 1: Revenue Breakdown Only
    callChatGPT(`You are extracting VERIFIED revenue data for M&A advisors.

COMPANY: ${companyName}
WEBSITE: ${website}
${context ? `CLIENT CONTEXT: ${context}` : ''}
${officialDocContext}

RESEARCH ON FINANCIALS:
${research.financials}

---

CRITICAL REQUIREMENTS:
- Only include data you can verify from the research. NO approximations, NO ranges, NO guesses.
- Every percentage must be EXACT (e.g., "47%" not "approximately 45-50%")
- Every data point must have a source (company filings, annual report, investor presentation, etc.)
- If you cannot find an exact verified number, write "Not disclosed" - do NOT estimate
- Do NOT include generic notes like "largest geography" - only include specific sourced information

Respond in this EXACT JSON format:
{
  "financials": {
    "total_revenue": "Exact amount with currency and fiscal year, with source (e.g., 'USD 2.3B (FY2023 Annual Report)')",
    "revenue_by_segment": [
      {"segment": "Segment name", "percentage": "Exact % (e.g., '47%')", "source": "Where this data comes from"}
    ],
    "revenue_by_geography": [
      {"region": "Region name", "percentage": "Exact % (e.g., '32%')", "source": "Where this data comes from"}
    ]
  }
}

IMPORTANT: If you cannot find EXACT percentages with sources, return empty arrays. No approximations allowed.`).catch(e => ({ section: 'profile', error: e.message })),

    // Synthesis 2: Products, Services & Operations
    callChatGPT(`You are writing for M&A ADVISORS who need to understand a company's business quickly. NOT engineers.

COMPANY: ${companyName}

RESEARCH ON PRODUCTS & SERVICES:
${research.products}

RESEARCH ON OPERATIONS:
${research.operations}

---

CRITICAL INSTRUCTIONS:
- Be concise, direct, and professional. No jargon. No generic AI fluff.
- Do NOT list technical model numbers or product codes
- Every statement must be backed by concrete facts from the research
- If you don't have specific data, don't write generic filler - leave it out

For STRATEGIC CAPABILITIES - provide CONCRETE EXAMPLES with numbers:
- BAD: "Strong patent portfolio providing defensible moat"
- GOOD: "1,200+ active patents in polymer chemistry (per 2023 annual report)"
- BAD: "Vertically integrated across the value chain"
- GOOD: "Owns raw material sourcing (2 mines in Chile), manufacturing (4 plants), and distribution (direct sales to 80% of customers)"

Respond in this EXACT JSON format:
{
  "products_and_services": {
    "overview": "2-3 sentences explaining the business in plain English. What do they sell, to whom?",
    "product_lines": [
      {
        "name": "Business segment name",
        "what_it_does": "Plain English explanation of customer value",
        "revenue_significance": "High/Medium/Low revenue contributor"
      }
    ],
    "strategic_capabilities": [
      {
        "capability": "Specific capability with concrete details (e.g., '1,200+ patents in X technology')",
        "evidence": "Concrete proof - numbers, examples, specifics from research"
      }
    ]
  },
  "operations": {
    "manufacturing_footprint": [
      {"location": "City, Country", "details": "Specific details about this facility (capacity, employees, products made)"}
    ]
  }
}

REMEMBER: Concrete facts only. No generic statements. If you cannot provide specific evidence, do not include the capability.`).catch(e => ({ section: 'products', error: e.message })),

    // Synthesis 3: Competitive Landscape
    callChatGPT(`You are writing a COMPREHENSIVE competitive analysis for M&A ADVISORS.

COMPANY: ${companyName}

RESEARCH ON COMPETITORS:
${research.competitors}

RESEARCH ON PRODUCTS (for context):
${research.products}

---

CRITICAL INSTRUCTIONS:
- Be concise, direct, and professional. No generic statements.
- For "Why This Company Wins" - write clearly and elaborately. Each point must stand on its own with clear reasoning and evidence.
- For competitors - this is a large global industry. List the TOP 10-12 global competitors comprehensively.
- For each competitor, provide: their products, market positioning, estimated market share, revenue size.
- If you don't have specific data on a competitor, still include them but note what's unknown.

Respond in this EXACT JSON format:
{
  "competitive_landscape": {
    "company_position": {
      "market_rank": "#1, #2, Top 5, etc. with specific market share % if available",
      "why_they_win": [
        {
          "point": "Clear statement of competitive advantage",
          "reasoning": "Detailed explanation with specific evidence - customer examples, data points, concrete proof"
        }
      ],
      "vulnerability": "Specific competitive threat with concrete evidence"
    },
    "key_competitors": [
      {
        "name": "Competitor name",
        "hq_country": "Country",
        "revenue": "Estimated revenue (with source if available)",
        "market_share": "Estimated % (with source if available)",
        "key_products": "Their main product lines in this market",
        "positioning": "How they position vs the target company - premium/value, geographic focus, customer segments",
        "competitive_threat": "Specific threat they pose - gaining share, attacking same customers, technology edge"
      }
    ]
  }
}

IMPORTANT: List at least 10 competitors. This should be a comprehensive view of the competitive landscape, not a shortlist.`).catch(e => ({ section: 'competitors', error: e.message })),

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

    // Synthesis 5: Ideal Target Profile - Concrete Target List
    callChatGPT(`You are an M&A advisor identifying SPECIFIC acquisition targets for a buyer.

COMPANY: ${companyName}

ALL RESEARCH:
${research.products}
${research.maHistory}
${research.leadership}
${research.financials}

${context ? `CLIENT CONTEXT: ${context}` : ''}

---

CRITICAL: No generic analysis or paragraphs. Identify 10 REAL, SPECIFIC companies that would be good acquisition targets.

Based on the buyer's strategy, past acquisitions, and market position, find 10 actual companies that:
- Fill gaps in their product portfolio or geographic coverage
- Align with their demonstrated M&A preferences
- Are realistically acquirable (consider size, ownership, strategic fit)

For each target, provide concrete details - not generic descriptions.

Respond in this EXACT JSON format:
{
  "ideal_target": {
    "target_list": [
      {
        "company_name": "Actual company name",
        "hq_country": "Country",
        "what_they_do": "Concise description of their business",
        "estimated_revenue": "Revenue estimate with source if available",
        "ownership": "Public (ticker) / Private / PE-backed",
        "strategic_fit": "Specific reason why this target fits the buyer - what gap does it fill, what synergy does it create",
        "key_products": "Their main products/services relevant to the buyer"
      }
    ]
  }
}

IMPORTANT: These must be REAL companies, not hypothetical descriptions. If you cannot identify 10 real companies, include as many as you can find with confidence.`).catch(e => ({ section: 'ideal_target', error: e.message }))
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

  // Phase 0: Fetch official documents (annual reports, mid-term plans, merger info)
  const officialDocs = await utbPhase0FetchDocuments(companyName, website, additionalContext);

  // Phase 1: Deep fact-finding (with document context)
  const rawResearch = await utbPhase1Research(companyName, website, additionalContext, officialDocs);

  // Phase 2: Section-by-section synthesis (with document context)
  const synthesis = await utbPhase2Synthesis(companyName, website, rawResearch, additionalContext, officialDocs);

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

  // ========== SHEET 1: COMPANY ANALYSIS ==========
  const sheet1 = workbook.addWorksheet('Company Analysis');
  sheet1.columns = [
    { key: 'a', width: 25 },
    { key: 'b', width: 25 },
    { key: 'c', width: 25 },
    { key: 'd', width: 25 },
    { key: 'e', width: 25 },
    { key: 'f', width: 25 }
  ];

  // Title
  sheet1.mergeCells('A1:F1');
  const titleCell = sheet1.getCell('A1');
  titleCell.value = `UTB: ${companyName}`;
  titleCell.font = { bold: true, size: 18, color: { argb: navy } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lightBlue } };
  sheet1.getRow(1).height = 35;

  sheet1.mergeCells('A2:F2');
  sheet1.getCell('A2').value = website;
  sheet1.getCell('A2').font = { size: 11, color: { argb: 'FF64748B' } };

  let r = 4;
  const fin = synthesis.financials || {};

  // Revenue by Segment (with sources)
  if (fin.revenue_by_segment && fin.revenue_by_segment.length > 0) {
    r = addSectionTitle(sheet1, 'Revenue by Segment', r);
    const segHeader = sheet1.getRow(r);
    segHeader.values = ['Segment', 'Share', 'Source', '', '', ''];
    styleHeaderRow(segHeader, blue);
    r++;
    fin.revenue_by_segment.forEach((seg, i) => {
      sheet1.getCell(`A${r}`).value = seg.segment;
      sheet1.getCell(`A${r}`).font = { bold: true };
      sheet1.getCell(`B${r}`).value = seg.percentage || seg.revenue;
      sheet1.getCell(`C${r}`).value = seg.source || '';
      styleDataRow(sheet1.getRow(r), i % 2 === 0);
      r++;
    });
    r++;
  }

  // Revenue by Geography (with sources)
  if (fin.revenue_by_geography && fin.revenue_by_geography.length > 0) {
    r = addSectionTitle(sheet1, 'Revenue by Geography', r);
    const geoHeader = sheet1.getRow(r);
    geoHeader.values = ['Region', 'Share', 'Source', '', '', ''];
    styleHeaderRow(geoHeader, blue);
    r++;
    fin.revenue_by_geography.forEach((geo, i) => {
      sheet1.getCell(`A${r}`).value = geo.region;
      sheet1.getCell(`A${r}`).font = { bold: true };
      sheet1.getCell(`B${r}`).value = geo.percentage;
      sheet1.getCell(`C${r}`).value = geo.source || '';
      styleDataRow(sheet1.getRow(r), i % 2 === 0);
      r++;
    });
    r++;
  }

  // Business Segments
  const prod = synthesis.products_and_services || {};
  if (prod.product_lines && prod.product_lines.length > 0) {
    r = addSectionTitle(sheet1, 'Business Segments', r);
    const plHeader = sheet1.getRow(r);
    plHeader.values = ['Segment', 'What It Does', 'Revenue Significance', '', '', ''];
    styleHeaderRow(plHeader, blue);
    r++;
    prod.product_lines.forEach((line, i) => {
      sheet1.getCell(`A${r}`).value = line.name;
      sheet1.getCell(`A${r}`).font = { bold: true };
      sheet1.mergeCells(`B${r}:C${r}`);
      sheet1.getCell(`B${r}`).value = line.what_it_does || line.description || '';
      sheet1.getCell(`D${r}`).value = line.revenue_significance || '';
      styleDataRow(sheet1.getRow(r), i % 2 === 0);
      r++;
    });
    r++;
  }

  // Strategic Capabilities (with concrete evidence)
  if (prod.strategic_capabilities && prod.strategic_capabilities.length > 0) {
    r = addSectionTitle(sheet1, 'Strategic Capabilities', r);
    const capHeader = sheet1.getRow(r);
    capHeader.values = ['Capability', 'Evidence', '', '', '', ''];
    styleHeaderRow(capHeader, navy);
    r++;
    prod.strategic_capabilities.forEach((cap, i) => {
      sheet1.getCell(`A${r}`).value = cap.capability;
      sheet1.getCell(`A${r}`).font = { bold: true };
      sheet1.mergeCells(`B${r}:D${r}`);
      sheet1.getCell(`B${r}`).value = cap.evidence || cap.business_impact || '';
      sheet1.getCell(`B${r}`).alignment = { wrapText: true };
      styleDataRow(sheet1.getRow(r), i % 2 === 0);
      r++;
    });
    r++;
  }

  // Manufacturing Footprint
  const ops = synthesis.operations || {};
  if (ops.manufacturing_footprint && ops.manufacturing_footprint.length > 0) {
    r = addSectionTitle(sheet1, 'Manufacturing Footprint', r);
    const mfgHeader = sheet1.getRow(r);
    mfgHeader.values = ['Location', 'Details', '', '', '', ''];
    styleHeaderRow(mfgHeader);
    r++;
    ops.manufacturing_footprint.forEach((mfg, i) => {
      sheet1.getCell(`A${r}`).value = mfg.location;
      sheet1.getCell(`A${r}`).font = { bold: true };
      sheet1.mergeCells(`B${r}:D${r}`);
      sheet1.getCell(`B${r}`).value = mfg.details || mfg.strategic_value || '';
      styleDataRow(sheet1.getRow(r), i % 2 === 0);
      r++;
    });
    r++;
  }

  // Why This Company Wins
  const comp = synthesis.competitive_landscape || {};
  const pos = comp.company_position || {};
  if (pos.market_rank || pos.why_they_win) {
    r = addSectionTitle(sheet1, 'Why This Company Wins', r);

    if (pos.market_rank) {
      sheet1.getCell(`A${r}`).value = 'Market Position';
      sheet1.getCell(`A${r}`).font = { bold: true };
      sheet1.mergeCells(`B${r}:D${r}`);
      sheet1.getCell(`B${r}`).value = pos.market_rank;
      styleDataRow(sheet1.getRow(r));
      r++;
    }

    // New format: why_they_win as array of {point, reasoning}
    if (pos.why_they_win && Array.isArray(pos.why_they_win)) {
      pos.why_they_win.forEach((item, i) => {
        sheet1.getCell(`A${r}`).value = item.point;
        sheet1.getCell(`A${r}`).font = { bold: true, color: { argb: 'FF16A34A' } };
        sheet1.mergeCells(`B${r}:E${r}`);
        sheet1.getCell(`B${r}`).value = item.reasoning;
        sheet1.getCell(`B${r}`).alignment = { wrapText: true };
        sheet1.getRow(r).height = 40;
        styleDataRow(sheet1.getRow(r), i % 2 === 0);
        r++;
      });
    }

    if (pos.vulnerability) {
      sheet1.getCell(`A${r}`).value = 'Vulnerability';
      sheet1.getCell(`A${r}`).font = { bold: true, color: { argb: 'FFDC2626' } };
      sheet1.mergeCells(`B${r}:D${r}`);
      sheet1.getCell(`B${r}`).value = pos.vulnerability;
      sheet1.getCell(`B${r}`).alignment = { wrapText: true };
      styleDataRow(sheet1.getRow(r), true);
      r++;
    }
    r++;
  }

  // Competitors (comprehensive - 10-12)
  const competitors = comp.key_competitors || [];
  if (competitors.length > 0) {
    r = addSectionTitle(sheet1, 'Competitive Landscape', r);
    const compHeader = sheet1.getRow(r);
    compHeader.values = ['Company', 'HQ', 'Revenue', 'Market Share', 'Key Products', 'Competitive Threat'];
    styleHeaderRow(compHeader, blue);
    r++;
    competitors.forEach((c, i) => {
      sheet1.getCell(`A${r}`).value = c.name;
      sheet1.getCell(`A${r}`).font = { bold: true };
      sheet1.getCell(`B${r}`).value = c.hq_country || '';
      sheet1.getCell(`C${r}`).value = c.revenue || '';
      sheet1.getCell(`D${r}`).value = c.market_share || '';
      sheet1.getCell(`E${r}`).value = c.key_products || '';
      sheet1.getCell(`F${r}`).value = c.competitive_threat || c.positioning || '';
      sheet1.getRow(r).height = 30;
      styleDataRow(sheet1.getRow(r), i % 2 === 0);
      r++;
    });
  }

  // ========== M&A DATA (on same sheet) ==========
  const maDeepDive = synthesis.ma_deep_dive || {};
  const dealStories = maDeepDive.deal_stories || [];

  // M&A History
  if (dealStories.length > 0) {
    r++;
    r = addSectionTitle(sheet1, 'M&A History', r);
    dealStories.forEach((story, i) => {
      sheet1.getCell(`A${r}`).value = story.deal;
      sheet1.getCell(`A${r}`).font = { bold: true, color: { argb: blue } };
      sheet1.mergeCells(`B${r}:F${r}`);
      sheet1.getCell(`B${r}`).value = story.full_story;
      sheet1.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
      sheet1.getRow(r).height = 60;
      styleDataRow(sheet1.getRow(r), i % 2 === 0);
      r++;
    });
    r++;
  }

  // M&A Philosophy
  if (maDeepDive.ma_philosophy) {
    r = addSectionTitle(sheet1, 'M&A Philosophy', r);
    sheet1.mergeCells(`A${r}:F${r}`);
    sheet1.getCell(`A${r}`).value = maDeepDive.ma_philosophy;
    sheet1.getCell(`A${r}`).alignment = { wrapText: true, vertical: 'top' };
    sheet1.getRow(r).height = 80;
    r += 2;
  }

  // Deal Capacity
  const capacity = maDeepDive.deal_capacity || {};
  if (capacity.financial_firepower || capacity.appetite_level) {
    r = addSectionTitle(sheet1, 'Deal Capacity', r);
    if (capacity.financial_firepower) {
      sheet1.getCell(`A${r}`).value = 'Financial Firepower';
      sheet1.getCell(`A${r}`).font = { bold: true };
      sheet1.mergeCells(`B${r}:D${r}`);
      sheet1.getCell(`B${r}`).value = capacity.financial_firepower;
      styleDataRow(sheet1.getRow(r));
      r++;
    }
    if (capacity.appetite_level) {
      sheet1.getCell(`A${r}`).value = 'Appetite Level';
      sheet1.getCell(`A${r}`).font = { bold: true };
      sheet1.mergeCells(`B${r}:D${r}`);
      sheet1.getCell(`B${r}`).value = capacity.appetite_level;
      styleDataRow(sheet1.getRow(r), true);
      r++;
    }
    if (capacity.decision_process) {
      sheet1.getCell(`A${r}`).value = 'Decision Speed';
      sheet1.getCell(`A${r}`).font = { bold: true };
      sheet1.mergeCells(`B${r}:D${r}`);
      sheet1.getCell(`B${r}`).value = capacity.decision_process;
      styleDataRow(sheet1.getRow(r));
      r++;
    }
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
        <p>Your UTB buyer intelligence report is attached.</p>
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

async function generateDueDiligenceReport(files, instructions, reportLength, instructionMode = 'auto') {
  console.log(`[DD] Processing ${files.length} source files...`);

  // Combine all file contents
  let combinedContent = '';
  const filesSummary = [];

  for (const file of files) {
    console.log(`[DD] - File: ${file.name} (${file.type}) - ${file.content?.length || 0} chars`);
    filesSummary.push(`- ${file.name} (${file.type.toUpperCase()})`);

    // Handle base64 encoded files (binary formats) - extract actual content
    if (file.content.startsWith('[BASE64:')) {
      const base64Match = file.content.match(/\[BASE64:(\w+)\](.+)/);
      if (base64Match) {
        const ext = base64Match[1].toLowerCase();
        const base64Data = base64Match[2];

        let extractedContent = '';
        try {
          if (ext === 'docx' || ext === 'doc') {
            extractedContent = await extractDocxText(base64Data);
          } else if (ext === 'pptx' || ext === 'ppt') {
            extractedContent = await extractPptxText(base64Data);
          } else if (ext === 'xlsx' || ext === 'xls') {
            extractedContent = await extractXlsxText(base64Data);
          } else {
            extractedContent = `[Binary file type .${ext} - cannot extract text]`;
          }
        } catch (extractError) {
          console.error(`[DD] Extraction error for ${file.name}:`, extractError.message);
          extractedContent = `[Error extracting ${file.name}: ${extractError.message}]`;
        }

        combinedContent += `\n\n=== SOURCE: ${file.name} ===\n${extractedContent}\n`;
      } else {
        combinedContent += `\n\n=== SOURCE: ${file.name} ===\n[Could not parse binary content]\n`;
      }
    } else {
      combinedContent += `\n\n=== SOURCE: ${file.name} ===\n${file.content}\n`;
    }
  }

  console.log(`[DD] Total combined content: ${combinedContent.length} chars`);

  // Log all source headers to verify all files are included
  const sourceHeaders = combinedContent.match(/=== SOURCE: [^=]+ ===/g) || [];
  console.log(`[DD] Files included in combined content (${sourceHeaders.length}):`);
  sourceHeaders.forEach((header, i) => console.log(`[DD]   ${i + 1}. ${header}`));

  // Extract URLs from instructions and fetch them
  let onlineResearchContent = '';
  let onlineSourcesUsed = [];
  if (instructions) {
    const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;
    const urls = instructions.match(urlRegex) || [];

    for (const url of urls.slice(0, 3)) { // Limit to 3 URLs
      console.log(`[DD] Fetching URL for research: ${url}`);
      try {
        const scraped = await scrapeWebsite(url);
        if (scraped.success) {
          onlineSourcesUsed.push(scraped.url);
          onlineResearchContent += `\n\n=== ONLINE SOURCE: ${scraped.url} ===\n${scraped.content.substring(0, 15000)}\n`;
          console.log(`[DD] Fetched ${scraped.content.length} chars from ${url}`);
        } else {
          console.log(`[DD] Failed to fetch ${url}: ${scraped.error}`);
        }
      } catch (e) {
        console.log(`[DD] Error fetching ${url}: ${e.message}`);
      }
    }
  }

  const lengthInstructions = {
    short: `Create a 1-PAGE summary covering:
- Business overview (what does the company do)
- Key facts and figures mentioned
- Notable risks or concerns
- Growth potential or opportunities`,

    medium: `Create a 2-3 PAGE report with these sections (SKIP any section that has no relevant content):
1. BUSINESS OVERVIEW - What the company does, products/services, market position
2. KEY FACTS & FIGURES - Financial metrics, revenue, growth, any numbers mentioned
3. RISKS & CONCERNS - Business, financial, operational issues identified
4. OPPORTUNITIES - Growth potential, market opportunities, synergies`,

    long: `Create a COMPREHENSIVE report (SKIP any section that has no relevant content):
1. COMPANY OVERVIEW - Business description, history, structure, management
2. INDUSTRY & MARKET - Market context, competition, trends
3. BUSINESS MODEL - Revenue streams, customers, competitive advantages
4. FINANCIAL OVERVIEW - Any financial data, metrics, performance indicators
5. OPERATIONS - How the business operates, technology, processes
6. RISKS & CONCERNS - All identified risks and red flags
7. OPPORTUNITIES - Growth potential, synergies, strategic options
8. KEY QUESTIONS - What additional information would be needed`
  };

  // Build instruction section based on mode
  let instructionSection = '';
  if (instructionMode === 'manual' && instructions) {
    instructionSection = `
CONTEXT FROM USER:
${instructions}
`;
  }

  const onlineSourceNote = onlineSourcesUsed.length > 0
    ? `\nONLINE SOURCES RESEARCHED:\n${onlineSourcesUsed.map(u => `- ${u}`).join('\n')}\n\nIMPORTANT: Any information from online sources MUST be clearly marked with [Online Source] at the start of that bullet point or paragraph.`
    : '';

  // Build explicit file list for the prompt
  const explicitFileList = files.map((f, i) => `   FILE ${i + 1}: "${f.name}"`).join('\n');

  const prompt = `You are writing a factual due diligence summary. You have been provided ${filesSummary.length} source documents that you MUST ALL read completely.

**MANDATORY: READ ALL ${filesSummary.length} FILES BELOW**
${explicitFileList}

You MUST extract and include information from EVERY SINGLE FILE listed above. Do not skip any file. Each file contains unique information that must be included in the report.
${instructionSection}
=== BEGIN ALL SOURCE CONTENT (${filesSummary.length} FILES) ===
${combinedContent}
=== END ALL SOURCE CONTENT ===

${onlineResearchContent ? `=== BEGIN ONLINE RESEARCH (from websites) ===
${onlineResearchContent}
=== END ONLINE RESEARCH ===` : ''}

REPORT STRUCTURE:
${lengthInstructions[reportLength]}

CRITICAL RULES - FOLLOW EXACTLY:
1. **READ EVERY FILE**: You have ${filesSummary.length} source files. You MUST read and extract key information from ALL of them. Each "=== SOURCE: filename ===" section is a different file - process them ALL.
2. **NO HALLUCINATION**: ONLY include facts explicitly stated in the source materials above.
3. Quote specific names, numbers, dates, and facts directly from the materials.
4. If a file contains meeting transcript or conversation, extract the key business facts discussed.

${onlineResearchContent ? `5. Any information from ONLINE RESEARCH section must be prefixed with **[Online Source]**.` : ''}

OUTPUT FORMAT:
- Start with: <h1 style="font-family: Calibri, sans-serif;">Due Diligence: [Company Name from materials]</h1>
- Use <h2> for section headers, <ul><li> for bullet points
- Add style="font-family: Calibri, sans-serif;" to all elements
- Generate CLEAN HTML only - no markdown
- SKIP sections with no relevant content
- At the end, add a "Sources Referenced" section listing which files you extracted information from`;

  try {
    const maxTokens = reportLength === 'short' ? 3000 : reportLength === 'medium' ? 6000 : 10000;
    console.log(`[DD] Prompt length: ${prompt.length} chars`);
    console.log(`[DD] Starting AI generation with Gemini 2.5 Pro (max ${maxTokens} tokens)...`);

    // Use Gemini 2.5 Pro for best quality DD reports
    const geminiResult = await callGemini2Pro(prompt);
    if (geminiResult) {
      let result = geminiResult;
      // Clean up any markdown artifacts
      result = result.replace(/```html/gi, '').replace(/```/g, '').trim();
      console.log(`[DD] Report generated using Gemini 2.5 Pro (${result.length} chars)`);
      return result;
    }

    // Fallback to GPT-4o if Gemini fails
    console.log('[DD] Gemini unavailable, falling back to GPT-4o...');
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: maxTokens
    });

    let result = response.choices[0].message.content || '';

    // Clean up any markdown artifacts
    result = result.replace(/```html/gi, '').replace(/```/g, '').trim();

    console.log(`[DD] Report generated using GPT-4o (${result.length} chars)`);
    return result;
  } catch (error) {
    console.error('[DD] Error in AI report generation:', error.message);
    console.error('[DD] Stack:', error.stack);
    throw error;
  }
}

app.post('/api/due-diligence', async (req, res) => {
  const {
    files = [],
    audioFiles = [],
    instructions,
    instructionMode = 'auto',  // 'auto' or 'manual'
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
  console.log(`[DD] Request body size: ${JSON.stringify(req.body).length} bytes`);
  console.log(`[DD] Documents received: ${files.length}`);
  files.forEach((f, i) => console.log(`     ${i + 1}. ${f.name} (${f.type}) - content: ${f.content?.length || 0} chars`));
  console.log(`[DD] Audio Files: ${audioFiles.length}`);
  audioFiles.forEach(f => console.log(`     - ${f.name} (${f.mimeType})`));
  console.log(`[DD] Real-time Session: ${sessionId || 'None'}`);
  console.log(`[DD] Has Raw Transcript: ${rawTranscript ? 'Yes (' + rawTranscript.length + ' chars)' : 'No'}`);
  console.log(`[DD] Report Length: ${length}`);
  console.log(`[DD] Email: ${email}`);
  console.log(`[DD] Instruction Mode: ${instructionMode}`);
  console.log(`[DD] Instructions: ${instructions ? instructions.substring(0, 100) + '...' : 'None'}`);
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

    // Step 2: Translate if needed (with domain awareness)
    let translatedTranscripts = [];
    for (const t of transcripts) {
      if (translateToEnglish && t.language !== 'en' && t.language !== 'english' && t.text.length > 10) {
        console.log(`[DD] Translating from ${t.language} to English: ${t.name}`);
        // Detect domain from transcript content for better translation accuracy
        const domain = detectMeetingDomain(t.text);
        console.log(`[DD] Detected domain: ${domain}`);
        const translated = await translateText(t.text, 'en', { domain });
        translatedTranscripts.push({
          ...t,
          originalText: t.text,
          text: translated,
          wasTranslated: true,
          detectedDomain: domain
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

    if (outputType === 'transcript') {
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

    } else if (outputType === 'meeting_minutes') {
      // Generate meeting minutes
      console.log('[DD] Generating meeting minutes...');
      outputContent = await generateMeetingMinutes(combinedTranscript, instructions);
      emailSubject = `Meeting Minutes - ${new Date().toLocaleDateString()}`;
      docTitle = 'Meeting Minutes';

    } else {
      // Generate full DD report
      console.log('[DD] Generating due diligence report...');
      console.log(`[DD] Input files array length: ${files.length}`);
      files.forEach((f, i) => console.log(`[DD]   File ${i + 1}: ${f.name} (${f.type}) - ${f.content?.length || 0} chars`));

      // Add transcripts to files for processing
      const allFiles = [...files];

      // Add audio file transcripts (from uploaded audio)
      if (combinedTranscript) {
        allFiles.push({
          name: 'Audio File Transcripts',
          type: 'transcript',
          content: combinedTranscript
        });
      }

      // Add real-time recording transcript (CRITICAL: this was missing!)
      if (rawTranscript && rawTranscript.trim().length > 0) {
        // Strip HTML tags from transcripts (they come from UI with HTML formatting)
        const stripHtml = (text) => text
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<span[^>]*class="speaker-label"[^>]*>([^<]*)<\/span>/gi, '$1')
          .replace(/<[^>]+>/g, '')
          .replace(/\n\s*\n/g, '\n')
          .trim();

        const cleanRaw = stripHtml(rawTranscript);
        const cleanTranslated = translatedTranscript ? stripHtml(translatedTranscript) : '';

        // Use translated transcript if available, otherwise use raw
        const transcriptToUse = cleanTranslated.length > 0
          ? `ENGLISH TRANSLATION:\n${cleanTranslated}\n\n${'='.repeat(40)}\n\nORIGINAL (${detectedLanguage || 'detected language'}):\n${cleanRaw}`
          : cleanRaw;

        allFiles.push({
          name: 'Real-Time Meeting Recording',
          type: 'transcript',
          content: transcriptToUse
        });
        console.log(`[DD] Added real-time transcript to report: ${cleanRaw.length} chars`);
      }

      console.log(`[DD] Final allFiles count before report generation: ${allFiles.length}`);
      allFiles.forEach((f, i) => console.log(`[DD]   Final file ${i + 1}: ${f.name}`));

      outputContent = await generateDueDiligenceReport(allFiles, instructions, length, instructionMode);
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
    <div style="font-family: Calibri, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 30px;">
      <p style="font-size: 16px; color: #333;">Please find the ${docTitle} attached.</p>
      <p style="font-size: 14px; color: #666; margin-top: 20px;"><strong>Source Materials:</strong></p>
      <ul style="margin: 8px 0; padding-left: 20px; color: #666; font-size: 13px;">${fileList}</ul>
    </div>`;

    // Step 6: Generate attachments (Word doc, transcript, audio)
    let attachments = [];
    const dateStr = new Date().toISOString().slice(0, 10);

    // 6a: Word document
    if (generateWord) {
      console.log('[DD] Generating Word document...');
      try {
        const wordBuffer = await generateWordDocument(docTitle, outputContent, {});
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
      // Strip HTML tags from translated transcript (it comes from UI with HTML formatting)
      const cleanTranslation = translatedTranscript
        ? translatedTranscript
            .replace(/<br\s*\/?>/gi, '\n')  // Convert <br> to newlines
            .replace(/<span[^>]*class="speaker-label"[^>]*>([^<]*)<\/span>/gi, '$1')  // Keep speaker label text
            .replace(/<[^>]+>/g, '')  // Remove any remaining HTML tags
            .replace(/\n\s*\n/g, '\n')  // Clean up multiple newlines
            .trim()
        : '';

      const cleanRawTranscript = rawTranscript
        ? rawTranscript
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<span[^>]*class="speaker-label"[^>]*>([^<]*)<\/span>/gi, '$1')
            .replace(/<[^>]+>/g, '')
            .replace(/\n\s*\n/g, '\n')
            .trim()
        : '';

      const transcriptContent = `TRANSCRIPT - ${new Date().toLocaleString()}
${'='.repeat(50)}

${cleanTranslation ? `ORIGINAL (${detectedLanguage || 'detected'}):\n${cleanRawTranscript}\n\n${'='.repeat(50)}\n\nENGLISH TRANSLATION:\n${cleanTranslation}` : transcriptText}
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
          const pcmBuffer = Buffer.concat(session.audioChunks);
          // Convert PCM to WAV for playability (16kHz, 16-bit, mono)
          const wavBuffer = pcmToWav(pcmBuffer, 16000, 1, 16);
          attachments.push({
            filename: `Recording_${dateStr}.wav`,
            content: wavBuffer.toString('base64')
          });
          console.log(`[DD] Audio attached as WAV: ${wavBuffer.length} bytes`);
        } catch (audioError) {
          console.error('[DD] Audio attachment failed:', audioError.message);
        }
      }
    }

    // Step 7: Send email
    console.log(`[DD] Sending email to ${email} with ${attachments.length} attachment(s)...`);
    console.log(`[DD] Attachments: ${attachments.map(a => a.filename || a.name || 'unnamed').join(', ')}`);
    await sendEmail(email, emailSubject, emailHtml, attachments.length > 0 ? attachments : null);
    console.log(`[DD] ✓ ${docTitle} sent successfully to ${email}`);
    console.log(`[DD] ====== DD REPORT COMPLETED SUCCESSFULLY ======`);

  } catch (error) {
    console.error('[DD] ====== DD REPORT FAILED ======');
    console.error('[DD] Error:', error.message);
    console.error('[DD] Stack:', error.stack);
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
const MAX_ACTIVE_SESSIONS = 50; // Prevent memory exhaustion from too many concurrent sessions

// Periodic cleanup of stale sessions (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [sessionId, session] of activeSessions.entries()) {
    // Remove sessions older than 2 hours (safety net for missed cleanups)
    if (session.startTime && (now - session.startTime.getTime() > 2 * 60 * 60 * 1000)) {
      activeSessions.delete(sessionId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[WS] Periodic cleanup: removed ${cleaned} stale sessions. Active: ${activeSessions.size}`);
  }
}, 10 * 60 * 1000);

wss.on('connection', (ws, req) => {
  console.log('[WS] New client connected for real-time transcription');

  // Check session limit to prevent memory exhaustion
  if (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
    console.warn(`[WS] Session limit reached (${MAX_ACTIVE_SESSIONS}), rejecting connection`);
    ws.send(JSON.stringify({ type: 'error', message: 'Server busy. Please try again later.' }));
    ws.close();
    return;
  }

  let deepgramConnection = null;
  let sessionId = Date.now().toString();
  let audioChunks = [];
  let fullTranscript = '';
  let detectedLanguage = 'en';
  let translatedTranscript = '';

  // Segment buffering for improved translation context
  let segmentBuffer = [];  // Buffer to accumulate segments before translation
  let translationContext = [];  // Previous translated segments for context
  let detectedDomain = null;  // Auto-detected meeting domain
  const SEGMENT_BUFFER_SIZE = 2;  // Number of segments to buffer before translating
  const MAX_CONTEXT_SEGMENTS = 5;  // Maximum previous segments to keep for context

  // Store session data
  activeSessions.set(sessionId, {
    startTime: new Date(),
    audioChunks: [],
    transcript: '',
    translatedTranscript: '',
    language: 'en',
    segmentBuffer: [],
    translationContext: [],
    detectedDomain: null
  });
  console.log(`[WS] Session ${sessionId} created. Active sessions: ${activeSessions.size}`);

  // Send session ID to client
  ws.send(JSON.stringify({ type: 'session', sessionId }));

  ws.on('message', async (message) => {
    try {
      // Check if it's a control message (JSON) or audio data (binary)
      // JSON messages start with '{' (ASCII 123), but audio can also start with this byte
      // So we try to parse as JSON first, and if it fails, treat as audio
      let isJsonMessage = typeof message === 'string';
      if (!isJsonMessage && message instanceof Buffer) {
        // Quick heuristic: JSON messages are usually small (<1KB), audio chunks are larger
        // Also check if it starts with '{' and contains common JSON characters
        isJsonMessage = message.length < 1024 && message[0] === 123 &&
                       (message.includes(0x22) || message.toString().includes('"type"'));
      }

      if (isJsonMessage) {
        const data = JSON.parse(message.toString());

        if (data.type === 'start') {
          // Start Deepgram connection
          console.log(`[WS] Starting transcription session ${sessionId}, language: ${data.language || 'auto'}`);

          if (!deepgram) {
            ws.send(JSON.stringify({ type: 'error', message: 'Deepgram API key not configured' }));
            return;
          }

          // Check if multi-language mode is requested
          const isMultiLang = !data.language || data.language === 'auto' || data.language === 'multi';

          // Languages supported by Nova-3 (use Nova-2 for unsupported languages)
          // Nova-3 supports: en, es, fr, de, hi, ru, pt, ja, it, nl, bg, ca, cs, da, et, fi,
          // el, hu, id, ko, lv, lt, ms, no, pl, ro, sk, sv, tr, uk, vi, zh
          // Nova-2 needed for: ar (Arabic), th (Thai) - not yet in Nova-3
          // Languages that need Nova-2 (not well supported in Nova-3)
          const nova2OnlyLangs = ['th', 'ms', 'tl'];
          const useNova2 = !isMultiLang && nova2OnlyLangs.includes(data.language);

          const dgOptions = {
            // Use Nova-3 for most languages (better accuracy), Nova-2 for unsupported ones
            model: useNova2 ? 'nova-2' : 'nova-3',
            smart_format: true,
            interim_results: true,
            utterance_end_ms: 1000,
            encoding: 'linear16',
            sample_rate: 16000,
            channels: 1,
            punctuate: true,
            diarize: true  // Enable speaker identification
          };

          // Set language - if specific language requested, use it; otherwise use 'multi' for auto-detection
          // Nova-3 with language='multi' enables true multilingual code-switching
          // See: https://developers.deepgram.com/docs/multilingual-code-switching
          const currentSession = activeSessions.get(sessionId);
          if (isMultiLang) {
            dgOptions.language = 'multi';  // Multilingual code-switching mode
            dgOptions.endpointing = 100;   // Recommended for code-switching (100ms)
            detectedLanguage = 'multi';
            if (currentSession) currentSession.language = 'multi';
          } else {
            dgOptions.language = data.language;
            detectedLanguage = data.language;
            if (currentSession) currentSession.language = data.language;
          }

          console.log('[WS] Deepgram options:', JSON.stringify(dgOptions));

          deepgramConnection = deepgram.listen.live(dgOptions);

          deepgramConnection.on('open', () => {
            console.log(`[WS] Deepgram connection opened for session ${sessionId}`);
            ws.send(JSON.stringify({ type: 'ready' }));
          });

          // Helper function to detect language from text content
          function detectLanguageFromText(text) {
            if (!text || text.length < 3) return null;

            // Check for Chinese characters (CJK Unified Ideographs)
            if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
            // Check for Japanese (Hiragana, Katakana)
            if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja';
            // Check for Korean (Hangul)
            if (/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) return 'ko';
            // Check for Thai
            if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
            // Check for Vietnamese (special diacritics)
            if (/[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(text)) return 'vi';
            // Check for Hindi/Devanagari
            if (/[\u0900-\u097f]/.test(text)) return 'hi';
            // Check for Arabic
            if (/[\u0600-\u06ff]/.test(text)) return 'ar';
            // Check for Indonesian/Malay (common words)
            if (/\b(dan|yang|untuk|dengan|ini|itu|dari|ke|tidak|ada|akan|pada|sudah|juga|saya|kami|mereka)\b/i.test(text)) return 'id';

            return 'en';  // Default to English
          }

          deepgramConnection.on('Results', async (dgData) => {
            console.log('[WS] Deepgram data received:', JSON.stringify(dgData).substring(0, 200));
            const alternative = dgData.channel?.alternatives?.[0];
            const transcript = alternative?.transcript;
            const words = alternative?.words || [];
            const isFinal = dgData.is_final;

            // Nova-3 multi-language: get language from multiple sources
            // 1. Per-word language tags (most accurate for code-switching)
            // 2. Channel-level languages array (sorted by word count)
            // 3. detected_language field
            // 4. Text-based detection as fallback
            let detLang = null;

            // Check channel-level languages array (Nova-3 multi format)
            if (dgData.channel?.languages && dgData.channel.languages.length > 0) {
              detLang = dgData.channel.languages[0];  // Primary language by word count
            }

            // Check for per-word language (code-switching detection)
            let segmentLang = null;
            if (words.length > 0 && words[0].language) {
              segmentLang = words[0].language;  // Language of first word in segment
            }

            // Fallback to detected_language field
            if (!detLang) {
              detLang = dgData.channel?.detected_language;
            }

            // Final fallback: text-based detection
            if (!detLang && transcript) {
              detLang = detectLanguageFromText(transcript);
            }

            // Use segment language if available, else channel language
            const effectiveLang = segmentLang || detLang || detectedLanguage;

            // Get session with null safety
            const session = activeSessions.get(sessionId);

            if (effectiveLang && effectiveLang !== detectedLanguage) {
              detectedLanguage = effectiveLang;
              if (session) session.language = effectiveLang;
              console.log(`[WS] Language detected: ${effectiveLang}`);
            }

            if (transcript) {
              // Extract speaker info from words array (diarization)
              let speaker = null;
              if (words.length > 0 && words[0].speaker !== undefined) {
                speaker = words[0].speaker;  // Speaker number (0, 1, 2, etc.)
              }

              // Use per-segment language for accurate code-switching detection
              const thisSegmentLang = segmentLang || effectiveLang;

              console.log(`[WS] Transcript: "${transcript}" (final: ${isFinal}, lang: ${thisSegmentLang}, speaker: ${speaker})`);
              // Send interim results to client with speaker info and per-segment language
              ws.send(JSON.stringify({
                type: 'transcript',
                text: transcript,
                isFinal,
                language: thisSegmentLang,
                speaker: speaker !== null ? speaker + 1 : null  // Convert to 1-indexed
              }));

              // Accumulate final transcripts
              if (isFinal) {
                fullTranscript += transcript + ' ';
                if (session) session.transcript = fullTranscript;

                // Check if this segment is non-English (using per-segment language detection)
                const isNonEnglishLang = thisSegmentLang && thisSegmentLang !== 'en' && !thisSegmentLang.startsWith('en');
                const hasNonEnglishChars = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u0900-\u097f\u0e00-\u0e7f\u0600-\u06ff]/.test(transcript);
                const needsTranslation = isNonEnglishLang || hasNonEnglishChars;

                // Translate non-English segments with buffering for better context
                if (needsTranslation && transcript.length >= 3) {
                  // Add to segment buffer with metadata
                  segmentBuffer.push({
                    text: transcript,
                    speaker: speaker,
                    lang: thisSegmentLang
                  });

                  // Update domain detection with accumulated text
                  if (!detectedDomain) {
                    detectedDomain = detectMeetingDomain(fullTranscript);
                    if (session) session.detectedDomain = detectedDomain;
                  }

                  // Translate when buffer reaches threshold OR segment is long enough (for responsiveness)
                  const shouldTranslateNow = segmentBuffer.length >= SEGMENT_BUFFER_SIZE ||
                                             transcript.length > 50 ||  // Long segments translate immediately
                                             /[。！？.!?]$/.test(transcript);  // End of sentence

                  if (shouldTranslateNow && segmentBuffer.length > 0) {
                    try {
                      // Combine buffered segments for translation
                      const combinedText = segmentBuffer.map(s => s.text).join(' ');
                      const primarySpeaker = segmentBuffer[0].speaker;
                      const primaryLang = segmentBuffer[0].lang;

                      // Translate with context
                      const translated = await translateText(combinedText, 'en', {
                        previousSegments: translationContext,
                        domain: detectedDomain
                      });

                      // Only add if translation is different from original
                      if (translated !== combinedText) {
                        translatedTranscript += translated + ' ';
                        if (session) session.translatedTranscript = translatedTranscript;

                        // Update translation context (keep last N segments)
                        translationContext.push(translated);
                        if (translationContext.length > MAX_CONTEXT_SEGMENTS) {
                          translationContext.shift();
                        }
                        if (session) session.translationContext = translationContext;

                        ws.send(JSON.stringify({
                          type: 'translation',
                          text: translated,
                          originalLang: primaryLang,
                          speaker: primarySpeaker !== null ? primarySpeaker + 1 : null,
                          fullTranslation: translatedTranscript,
                          domain: detectedDomain  // Include detected domain for UI
                        }));
                      }

                      // Clear buffer after translation
                      segmentBuffer = [];
                      if (session) session.segmentBuffer = [];
                    } catch (e) {
                      console.error('[WS] Translation error:', e.message);
                    }
                  }
                } else if (!needsTranslation && transcript.length >= 3) {
                  // For English segments in multilingual meetings, add to translation too
                  // First, flush any pending non-English segments in buffer
                  if (segmentBuffer.length > 0) {
                    try {
                      const combinedText = segmentBuffer.map(s => s.text).join(' ');
                      const primarySpeaker = segmentBuffer[0].speaker;
                      const primaryLang = segmentBuffer[0].lang;

                      const translated = await translateText(combinedText, 'en', {
                        previousSegments: translationContext,
                        domain: detectedDomain
                      });

                      if (translated !== combinedText) {
                        translatedTranscript += translated + ' ';
                        if (session) session.translatedTranscript = translatedTranscript;

                        translationContext.push(translated);
                        if (translationContext.length > MAX_CONTEXT_SEGMENTS) {
                          translationContext.shift();
                        }
                        if (session) session.translationContext = translationContext;

                        ws.send(JSON.stringify({
                          type: 'translation',
                          text: translated,
                          originalLang: primaryLang,
                          speaker: primarySpeaker !== null ? primarySpeaker + 1 : null,
                          fullTranslation: translatedTranscript,
                          domain: detectedDomain
                        }));
                      }
                      segmentBuffer = [];
                      if (session) session.segmentBuffer = [];
                    } catch (e) {
                      console.error('[WS] Translation error (buffer flush):', e.message);
                    }
                  }

                  // Add English segment to translation panel
                  translatedTranscript += transcript + ' ';
                  if (session) session.translatedTranscript = translatedTranscript;

                  // Update context with English segment too
                  translationContext.push(transcript);
                  if (translationContext.length > MAX_CONTEXT_SEGMENTS) {
                    translationContext.shift();
                  }
                  if (session) session.translationContext = translationContext;

                  ws.send(JSON.stringify({
                    type: 'translation',
                    text: transcript,
                    originalLang: 'en',
                    speaker: speaker !== null ? speaker + 1 : null,
                    fullTranslation: translatedTranscript,
                    domain: detectedDomain
                  }));
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

          // Flush any remaining segments in the translation buffer
          if (segmentBuffer.length > 0) {
            try {
              const combinedText = segmentBuffer.map(s => s.text).join(' ');
              const primarySpeaker = segmentBuffer[0].speaker;
              const primaryLang = segmentBuffer[0].lang;

              const translated = await translateText(combinedText, 'en', {
                previousSegments: translationContext,
                domain: detectedDomain
              });

              if (translated !== combinedText) {
                translatedTranscript += translated + ' ';
                if (session) session.translatedTranscript = translatedTranscript;

                ws.send(JSON.stringify({
                  type: 'translation',
                  text: translated,
                  originalLang: primaryLang,
                  speaker: primarySpeaker !== null ? primarySpeaker + 1 : null,
                  fullTranslation: translatedTranscript,
                  domain: detectedDomain
                }));
              }
              segmentBuffer = [];
              console.log(`[WS] Flushed remaining translation buffer for session ${sessionId}`);
            } catch (e) {
              console.error('[WS] Translation error (final flush):', e.message);
            }
          }

          // Upload audio to R2 if available (wait for upload to complete)
          let r2Key = null;
          if (session.audioChunks && session.audioChunks.length > 0) {
            const pcmBuffer = Buffer.concat(session.audioChunks);
            const dateStr = new Date().toISOString().split('T')[0];
            const keyPath = `recordings/${dateStr}/${sessionId}.wav`;

            // Convert PCM to WAV for playability (16kHz, 16-bit, mono)
            const wavBuffer = pcmToWav(pcmBuffer, 16000, 1, 16);

            // Wait for upload to complete before sending response
            try {
              const uploadedKey = await uploadToR2(keyPath, wavBuffer, 'audio/wav');
              if (uploadedKey) {
                r2Key = uploadedKey;
                session.r2Key = uploadedKey;
                console.log(`[WS] Recording saved to R2: ${uploadedKey}`);
              } else {
                console.warn(`[WS] R2 upload returned null for session ${sessionId}`);
              }
            } catch (uploadError) {
              console.error(`[WS] R2 upload failed for session ${sessionId}:`, uploadError.message);
            }
          }

          // Send final results (only include r2Key if upload succeeded)
          ws.send(JSON.stringify({
            type: 'complete',
            sessionId,
            transcript: fullTranscript.trim(),
            translatedTranscript: translatedTranscript.trim(),
            language: detectedLanguage,
            duration,
            r2Key: r2Key // Only set if upload actually succeeded
          }));
        }

      } else {
        // Binary audio data - forward to Deepgram
        if (deepgramConnection && deepgramConnection.getReadyState() === 1) {
          deepgramConnection.send(message);

          // Store audio chunk for later saving (with null safety)
          audioChunks.push(message);
          const audioSession = activeSessions.get(sessionId);
          if (audioSession && audioSession.audioChunks) {
            // Memory limit: max 100MB per session to prevent memory exhaustion
            const currentSize = audioSession.audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
            if (currentSize < 100 * 1024 * 1024) {
              audioSession.audioChunks.push(message);
            } else {
              console.warn(`[WS] Session ${sessionId} audio limit reached (100MB), skipping chunk storage`);
            }
          }
        }
      }
    } catch (error) {
      // Don't send JSON parse errors to client - they're usually from binary data misdetection
      if (error instanceof SyntaxError && error.message.includes('JSON')) {
        console.warn('[WS] Ignoring JSON parse error (likely binary data):', error.message);
      } else {
        console.error('[WS] Error processing message:', error);
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected from session ${sessionId}`);
    if (deepgramConnection) {
      deepgramConnection.finish();
    }
    // Keep session data for 30 minutes for retrieval (reduced from 1 hour to save memory)
    // Clear audio chunks immediately to free memory, keep only transcript
    const closingSession = activeSessions.get(sessionId);
    if (closingSession) {
      closingSession.audioChunks = []; // Free audio memory immediately
    }
    setTimeout(() => {
      activeSessions.delete(sessionId);
      console.log(`[WS] Session ${sessionId} cleaned up`);
    }, 1800000); // 30 minutes
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
    const filename = r2Key.split('/').pop() || 'recording.wav';
    const contentType = filename.endsWith('.wav') ? 'audio/wav' : 'audio/pcm';
    res.setHeader('Content-Type', contentType);
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
