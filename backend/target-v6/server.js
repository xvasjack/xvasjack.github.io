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

  // Run all strategies in parallel (with error handling to prevent one failure from crashing all)
  const [serpResults, perpResults, openaiSearchResults, geminiResults] = await Promise.all([
    // SerpAPI queries
    process.env.SERPAPI_API_KEY
      ? Promise.all(allSerpQueries.map(q => callSerpAPI(q).catch(e => { console.error(`SerpAPI error: ${e.message}`); return null; })))
      : Promise.resolve([]),

    // Perplexity queries
    Promise.all(allPerpQueries.map(q => callPerplexity(q).catch(e => { console.error(`Perplexity error: ${e.message}`); return null; }))),

    // OpenAI Search queries
    Promise.all(allOpenAISearchQueries.map(q => callOpenAISearch(q).catch(e => { console.error(`OpenAI Search error: ${e.message}`); return null; }))),

    // Also run some Gemini queries for diversity
    Promise.all([
      callGemini(`Find ALL ${business} companies in ${country}. Exclude ${exclusion}. ${buildOutputFormat()}`),
      callGemini(`List ${business} factories and manufacturing plants in ${country}. Not ${exclusion}. ${buildOutputFormat()}`),
      callGemini(`${business} SME and family businesses in ${country}. Exclude ${exclusion}. ${buildOutputFormat()}`)
    ].map(p => p.catch(e => { console.error(`Gemini error: ${e.message}`); return null; })))
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
    perpResults.filter(r => r).map(text => extractCompanies(text, country).catch(e => { console.error(`Extraction error: ${e.message}`); return []; }))
  );
  const perpCompanies = perpExtractions.flat();
  console.log(`    Extracted ${perpCompanies.length} companies from Perplexity`);

  // Extract from OpenAI Search results
  console.log(`  Extracting from ${openaiSearchResults.length} OpenAI Search results...`);
  const openaiExtractions = await Promise.all(
    openaiSearchResults.filter(r => r).map(text => extractCompanies(text, country).catch(e => { console.error(`Extraction error: ${e.message}`); return []; }))
  );
  const openaiCompanies = openaiExtractions.flat();
  console.log(`    Extracted ${openaiCompanies.length} companies from OpenAI Search`);

  // Extract from Gemini results
  console.log(`  Extracting from ${geminiResults.length} Gemini results...`);
  const geminiExtractions = await Promise.all(
    geminiResults.filter(r => r).map(text => extractCompanies(text, country).catch(e => { console.error(`Extraction error: ${e.message}`); return []; }))
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

  // Try alternative paths on BOTH original and www/non-www variants
  const urlVariants = [baseUrl, altBaseUrl];
  const urlPaths = ['', '/en', '/home', '/about', '/index.html', '/index.php'];

  for (const variant of urlVariants) {
    for (const path of urlPaths) {
      const testUrl = variant + path;
      result = await tryFetch(testUrl);
      if (result.status === 'ok') return result;
      if (result.status === 'security_blocked') return result;
    }
  }

  // Try HTTPS if original was HTTP (on both variants)
  if (url.startsWith('http://')) {
    for (const variant of urlVariants) {
      const httpsVariant = variant.replace('http://', 'https://');
      result = await tryFetch(httpsVariant);
      if (result.status === 'ok') return result;
      if (result.status === 'security_blocked') return result;
    }
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
  const contentToValidate = (typeof pageText === 'string' && pageText) ? pageText : `Company name: ${company.company_name}. Validate based on name only.`;

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
${(typeof pageText === 'string' && pageText) ? pageText.substring(0, 8000) : 'Could not fetch - validate by name only'}`
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

  // If comma-separated, user already specified countries - return as array
  if (inputLower.includes(',')) {
    return regionInput.split(',').map(c => c.trim());
  }

  // Hardcoded region mappings (main business markets only)
  const regionMappings = {
    // Southeast Asia - 6 main markets (exclude Cambodia, Laos, Myanmar unless explicit)
    'southeast asia': ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'],
    'south east asia': ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'],
    'sea': ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'],
    'asean': ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'],

    // Other common regions
    'east asia': ['Japan', 'South Korea', 'Taiwan', 'China', 'Hong Kong'],
    'north asia': ['Japan', 'South Korea', 'Taiwan', 'China'],
    'south asia': ['India', 'Pakistan', 'Bangladesh', 'Sri Lanka'],
    'middle east': ['UAE', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman'],
    'gcc': ['UAE', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman'],
    'europe': ['Germany', 'France', 'UK', 'Italy', 'Spain', 'Netherlands', 'Poland'],
    'western europe': ['Germany', 'France', 'UK', 'Italy', 'Spain', 'Netherlands', 'Belgium'],
    'eastern europe': ['Poland', 'Czech Republic', 'Romania', 'Hungary', 'Slovakia'],
    'apac': ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines', 'Japan', 'South Korea', 'Taiwan', 'China', 'India', 'Australia'],
    'asia pacific': ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines', 'Japan', 'South Korea', 'Taiwan', 'China', 'India', 'Australia'],
    'latam': ['Brazil', 'Mexico', 'Argentina', 'Chile', 'Colombia', 'Peru'],
    'latin america': ['Brazil', 'Mexico', 'Argentina', 'Chile', 'Colombia', 'Peru']
  };

  // Check for matching region
  for (const [region, countries] of Object.entries(regionMappings)) {
    if (inputLower.includes(region)) {
      console.log(`  Expanding region "${regionInput}" → "${countries.join(', ')}"`);
      return countries;
    }
  }

  // Check for generic "asia" (default to Southeast Asia main markets)
  if (inputLower === 'asia') {
    const countries = ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'];
    console.log(`  Expanding region "${regionInput}" → "${countries.join(', ')}"`);
    return countries;
  }

  // Return as-is if not a recognized region (single country as array)
  return [regionInput];
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

  // Expand regional inputs to specific countries (returns array)
  const countries = await expandRegionToCountries(country);
  const expandedCountry = countries.join(', '); // String for prompts
  console.log(`  Country input: "${country}" → "${expandedCountry}"`);

  // Generate business term variations
  const businessVariations = await generateBusinessTermVariations(business);
  console.log(`  Term variations: ${businessVariations.length > 0 ? businessVariations.join(', ') : 'none generated'}`);

  // Determine languages for each country
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

// V6 Phase 2: Gemini-heavy iterative searches with Perplexity + ChatGPT support
// Key: Run searches over and over with heavy Gemini emphasis to find ALL possible targets
async function runIterativeSecondarySearchesV6(plan, business, exclusion, searchLog, existingValidated = []) {
  console.log('\n' + '='.repeat(50));
  console.log('V6 PHASE 2: GEMINI-HEAVY ITERATIVE SEARCHES');
  console.log('='.repeat(50));

  const { expandedCountry, countries, businessVariations } = plan;
  const startTime = Date.now();
  const NUM_ROUNDS = 16; // More rounds for exhaustive search

  // Track all validated and flagged companies across rounds
  const allValidated = [...existingValidated];
  const allFlagged = [];
  const allRejected = [];
  const seenWebsites = new Set(existingValidated.map(c => c.website?.toLowerCase()).filter(Boolean));

  // Simple brute force prompts - just keep asking for more
  const geminiAngles = [
    (found) => `Find ALL ${business} companies in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find ${business} manufacturers in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find ${business} producers in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find ${business} suppliers in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find small ${business} companies in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find local ${business} companies in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `List of ${business} companies in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (do NOT repeat): ${found.join(', ')}\nFind MORE companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`,

    (found) => `Find more ${business} companies in ${expandedCountry}.
${found.length > 0 ? `ALREADY FOUND (${found.length} companies): ${found.join(', ')}\nFind ANY additional companies not in this list.` : ''}
Return company name, website, location. Exclude: ${exclusion}`
  ];

  const chatgptAngles = [
    (found) => ({
      query: `${business} companies in ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.'
    }),

    (found) => ({
      query: `${business} manufacturers ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.'
    }),

    (found) => ({
      query: `${business} producers ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.'
    }),

    (found) => ({
      query: `${business} suppliers ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.'
    }),

    (found) => ({
      query: `small ${business} companies ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.'
    }),

    (found) => ({
      query: `local ${business} companies ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.'
    }),

    (found) => ({
      query: `list of ${business} companies ${expandedCountry}`,
      context: found.length > 0 ? `Already found: ${found.join(', ')}. Find MORE.` : 'Find all.'
    }),

    (found) => ({
      query: `all ${business} companies ${expandedCountry}`,
      context: found.length > 0 ? `Found ${found.length}: ${found.join(', ')}. Find ANY more.` : 'Find all.'
    })
  ];

  // Run 8 rounds of search → validate
  for (let round = 0; round < NUM_ROUNDS; round++) {
    console.log(`\n  --- ROUND ${round + 1}/${NUM_ROUNDS} ---`);

    // Get list of already-found company names for the prompt
    const foundCompanyNames = allValidated.map(c => c.company_name).slice(0, 50); // Limit to avoid prompt overflow

    // Generate prompts for this round (cycle through available prompts)
    const geminiPrompt = geminiAngles[round % geminiAngles.length](foundCompanyNames);
    const chatgptConfig = chatgptAngles[round % chatgptAngles.length](foundCompanyNames);

    // V6: Run MULTIPLE Gemini searches per round (heavy emphasis) + one ChatGPT
    console.log(`    Running 3x Gemini + 1x ChatGPT searches in parallel...`);

    // Generate 3 different Gemini prompts for this round
    const geminiPrompt1 = geminiAngles[round % geminiAngles.length](foundCompanyNames);
    const geminiPrompt2 = geminiAngles[(round + 1) % geminiAngles.length](foundCompanyNames);
    const geminiPrompt3 = geminiAngles[(round + 2) % geminiAngles.length](foundCompanyNames);

    const [geminiCompanies1, geminiCompanies2, geminiCompanies3, chatgptCompanies] = await Promise.all([
      runAgenticSearchTask(geminiPrompt1, expandedCountry, searchLog)
        .catch(e => { console.error(`    Gemini-1 round ${round + 1} failed: ${e.message}`); return []; }),
      runAgenticSearchTask(geminiPrompt2, expandedCountry, searchLog)
        .catch(e => { console.error(`    Gemini-2 round ${round + 1} failed: ${e.message}`); return []; }),
      runAgenticSearchTask(geminiPrompt3, expandedCountry, searchLog)
        .catch(e => { console.error(`    Gemini-3 round ${round + 1} failed: ${e.message}`); return []; }),
      runChatGPTSearchTask(
        chatgptConfig.query,
        chatgptConfig.context,
        expandedCountry,
        searchLog
      ).catch(e => { console.error(`    ChatGPT round ${round + 1} failed: ${e.message}`); return []; })
    ]);

    const totalGemini = geminiCompanies1.length + geminiCompanies2.length + geminiCompanies3.length;
    console.log(`    Gemini found: ${totalGemini} (${geminiCompanies1.length}+${geminiCompanies2.length}+${geminiCompanies3.length}), ChatGPT found: ${chatgptCompanies.length}`);

    // Combine and dedupe
    const roundCompanies = [...geminiCompanies1, ...geminiCompanies2, ...geminiCompanies3, ...chatgptCompanies];
    const uniqueRound = dedupeCompanies(roundCompanies);

    // Filter out already-validated companies
    const newCompanies = uniqueRound.filter(c => {
      const website = c.website?.toLowerCase();
      if (!website || seenWebsites.has(website)) return false;
      return true;
    });

    console.log(`    New companies (not previously found): ${newCompanies.length}`);

    if (newCompanies.length === 0) {
      console.log(`    No new companies found in round ${round + 1}, continuing...`);
      continue;
    }

    // Pre-filter
    const preFiltered = preFilterCompanies(newCompanies);
    console.log(`    After pre-filter: ${preFiltered.length}`);

    if (preFiltered.length === 0) {
      continue;
    }

    // V6: Validate this round's companies with Gemini-only validation
    console.log(`    V6 Validating ${preFiltered.length} companies with Gemini...`);
    const roundResults = await validateCompaniesV6(preFiltered, business, expandedCountry, exclusion);

    // Add to cumulative results
    allValidated.push(...roundResults.validated);
    allFlagged.push(...roundResults.flagged);
    allRejected.push(...roundResults.rejected);

    // Track seen websites
    for (const c of [...roundResults.validated, ...roundResults.flagged, ...roundResults.rejected]) {
      if (c.website) seenWebsites.add(c.website.toLowerCase());
    }

    console.log(`    Round ${round + 1} results: ${roundResults.validated.length} valid, ${roundResults.flagged.length} flagged`);
    console.log(`    Cumulative: ${allValidated.length} valid, ${allFlagged.length} flagged`);
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n  Phase 2 completed in ${duration} minutes`);
  console.log(`    Total validated: ${allValidated.length}`);
  console.log(`    Total flagged: ${allFlagged.length}`);

  return { validated: allValidated, flagged: allFlagged, rejected: allRejected };
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

// V6 VALIDATION: GPT-4o parallel validation (best reasoning for judgment tasks)
async function validateCompaniesV6(companies, business, country, exclusion) {
  console.log(`\nV6 GPT-4o Validation: ${companies.length} companies...`);
  const startTime = Date.now();

  const validated = [];   // GPT-4o says valid
  const flagged = [];     // Security blocked - needs human review
  const rejected = [];    // GPT-4o says invalid

  const batchSize = 10; // Parallel validation

  for (let i = 0; i < companies.length; i += batchSize) {
    const batch = companies.slice(i, i + batchSize);

    const validations = await Promise.all(batch.map(async (company) => {
      try {
        // Fetch website content for validation
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
          console.log(`    ? SECURITY: ${company.company_name} (${fetchResult.reason}) - flagging for human review`);
          return {
            company,
            status: 'flagged',
            valid: false,
            reason: `Security blocked: ${fetchResult.reason}`,
            securityBlocked: true
          };
        }

        if (fetchResult.status !== 'ok') {
          console.log(`    ✗ REMOVED: ${company.company_name} (${fetchResult.reason})`);
          return { company, status: 'skipped' };
        }

        pageContent = fetchResult.content;

        // GPT-4o validation
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

        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: validationPrompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1
        });

        const result = JSON.parse(response.choices[0].message.content);
        return {
          company,
          status: result.valid === true ? 'valid' : 'rejected',
          valid: result.valid === true,
          reason: result.reason || '',
          corrected_hq: result.corrected_hq
        };
      } catch (e) {
        console.error(`  Validation error for ${company.company_name}: ${e.message}`);
        return { company, status: 'rejected', valid: false, reason: 'Error' };
      }
    }));

    for (const v of validations) {
      if (v.status === 'skipped') continue;

      const companyData = {
        company_name: v.company.company_name,
        website: v.company.website,
        hq: v.corrected_hq || v.company.hq,
        reason: v.reason,
        securityBlocked: v.securityBlocked || false
      };

      if (v.status === 'valid') {
        validated.push(companyData);
        console.log(`    ✓ VALID: ${v.company.company_name}`);
      } else if (v.status === 'flagged') {
        flagged.push(companyData);
        console.log(`    ? FLAGGED: ${v.company.company_name} (Security blocked)`);
      } else {
        rejected.push(companyData);
        console.log(`    ✗ REJECTED: ${v.company.company_name} - ${v.reason}`);
      }
    }

    console.log(`  Progress: ${Math.min(i + batchSize, companies.length)}/${companies.length} | Valid: ${validated.length} | Flagged: ${flagged.length} | Rejected: ${rejected.length}`);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nV6 GPT-4o Validation done in ${duration}s`);
  console.log(`  Valid: ${validated.length}`);
  console.log(`  Flagged (security): ${flagged.length}`);
  console.log(`  Rejected: ${rejected.length}`);

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

// V6 Email HTML builder - clean and simple
function buildV6EmailHTML(validationResults, business, country, exclusion) {
  const { validated, flagged } = validationResults;

  let html = `
    <h2>${business} in ${country}</h2>
    <p style="color: #666; margin-bottom: 20px;">Exclusions: ${exclusion}</p>
  `;

  // Validated Companies
  if (validated.length > 0) {
    html += `
    <h3 style="color: #22c55e; margin-bottom: 10px;">Validated (${validated.length})</h3>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; margin-bottom: 30px;">
      <tr style="background-color: #dcfce7;">
        <th style="text-align: left;">#</th>
        <th style="text-align: left;">Company</th>
        <th style="text-align: left;">Website</th>
        <th style="text-align: left;">HQ</th>
      </tr>
    `;
    validated.forEach((c, i) => {
      html += `
      <tr>
        <td>${i + 1}</td>
        <td>${c.company_name}</td>
        <td><a href="${c.website}">${c.website}</a></td>
        <td>${c.hq}</td>
      </tr>
      `;
    });
    html += '</table>';
  }

  // Flagged Companies (security blocked)
  if (flagged.length > 0) {
    html += `
      <h3 style="color: #f59e0b; margin-bottom: 10px;">Flagged - Check Manually (${flagged.length})</h3>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; margin-bottom: 30px;">
        <tr style="background-color: #fef3c7;">
          <th style="text-align: left;">#</th>
          <th style="text-align: left;">Company</th>
          <th style="text-align: left;">Website</th>
          <th style="text-align: left;">HQ</th>
        </tr>
    `;
    flagged.forEach((c, i) => {
      html += `
      <tr>
        <td>${i + 1}</td>
        <td>${c.company_name}</td>
        <td><a href="${c.website}">${c.website}</a></td>
        <td>${c.hq || '-'}</td>
      </tr>
      `;
    });
    html += '</table>';
  }

  if (validated.length === 0 && flagged.length === 0) {
    html += '<p>No companies found matching your criteria.</p>';
  }

  return html;
}

// V6 ENDPOINT - Iterative Parallel Search Architecture
app.post('/api/find-target-v6', async (req, res) => {
  const { Business, Country, Exclusion, Email } = req.body;

  if (!Business || !Country || !Exclusion || !Email) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`V6 ITERATIVE PARALLEL SEARCH: ${new Date().toISOString()}`);
  console.log(`Business: ${Business}`);
  console.log(`Country: ${Country}`);
  console.log(`Exclusion: ${Exclusion}`);
  console.log(`Email: ${Email}`);
  console.log('='.repeat(70));

  // Return immediately - process in background
  res.json({
    success: true,
    message: 'Request received. Results will be emailed in ~12-15 minutes.'
  });

  try {
    const totalStart = Date.now();
    const searchLog = [];

    // ========== STEP 1: Plan Search Strategy ==========
    console.log('\n' + '='.repeat(50));
    console.log('STEP 1: PLANNING');
    console.log('='.repeat(50));
    const plan = await planSearchStrategyV5(Business, Country, Exclusion);
    const { expandedCountry } = plan;

    // ========== STEP 2: Iterative Parallel Search (10 rounds) ==========
    console.log('\n' + '='.repeat(50));
    console.log('STEP 2: ITERATIVE PARALLEL SEARCH (10 rounds)');
    console.log('='.repeat(50));

    const NUM_ROUNDS = 10;
    const allCompanies = [];
    const seenWebsites = new Set();

    // Generic search prompts that work for ANY business type
    // Each round uses a different search angle to maximize coverage
    const getSearchPrompt = (round, business, country, exclusion, alreadyFoundList, alreadyFoundCount) => {
      // Escalating pressure - gets stronger each round
      let pressureClause = '';
      if (alreadyFoundList) {
        const pressureLevel = Math.min(round + 1, 10); // 1-10 scale
        const pressureIntro = pressureLevel <= 3
          ? `I have already found ${alreadyFoundCount} companies. Do NOT repeat any of these`
          : pressureLevel <= 6
          ? `IMPORTANT: ${alreadyFoundCount} companies already found. You MUST find DIFFERENT companies not in this list`
          : `CRITICAL: I already have ${alreadyFoundCount} companies. Repeating any will be considered a FAILURE. Search DEEPER - look for lesser-known, smaller, regional players NOT in this list`;

        pressureClause = `\n\n${pressureIntro}:\n${alreadyFoundList}\n\nFind NEW companies only. Search harder for obscure, local, and lesser-known players.`;
      }

      const prompts = [
        // Round 1: Comprehensive search
        `Find ALL ${business} companies in ${country}. Be exhaustive - include large, medium, and small companies.${pressureClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 2: Small and medium enterprises
        `Find small and medium-sized ${business} companies in ${country}. Focus on companies that are potential acquisition targets.${pressureClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 3: Private and family-owned
        `Find private and family-owned ${business} companies in ${country}. These are often not well-known but important players.${pressureClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 4: Regional/local players
        `Find regional and local ${business} companies in ${country}. Look for companies operating in specific provinces, states, or cities.${pressureClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 5: Industry associations and directories
        `Find ${business} companies in ${country} through industry associations, trade directories, and member lists.${pressureClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 6: Leading/established companies
        `Find leading and established ${business} companies in ${country}. Include market leaders and well-known players.${pressureClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 7: Emerging/newer companies
        `Find emerging and newer ${business} companies in ${country}. Look for companies founded in recent years.${pressureClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 8: Specialized/niche
        `Find specialized and niche ${business} companies in ${country}. Look for companies with specific focus areas.${pressureClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 9: Alternative search terms
        `List of ${business} companies operating in ${country}. Search using alternative industry terms and keywords.${pressureClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`,

        // Round 10: Final sweep
        `Find any remaining ${business} companies in ${country} that haven't been found yet. Be thorough - dig into obscure sources.${pressureClause}\nReturn company name, website, HQ location. Exclude: ${exclusion}`
      ];

      return prompts[round % prompts.length];
    };

    const roundDescriptions = [
      'comprehensive', 'SME focus', 'private/family', 'regional/local',
      'associations', 'leading', 'emerging', 'specialized', 'alternative terms', 'final sweep'
    ];

    for (let round = 0; round < NUM_ROUNDS; round++) {
      const roundStart = Date.now();

      // Build "already found" list with both names and domains for better dedup
      const alreadyFoundNames = allCompanies.slice(0, 80).map(c => c.company_name);
      const alreadyFoundDomains = allCompanies.slice(0, 80).map(c => {
        try {
          return new URL(c.website).hostname.replace('www.', '');
        } catch { return ''; }
      }).filter(d => d);
      const alreadyFound = [...new Set([...alreadyFoundNames, ...alreadyFoundDomains])].join(', ');

      console.log(`\n  --- ROUND ${round + 1}/${NUM_ROUNDS} (${roundDescriptions[round]}) ---`);

      // Generate prompt for this round with escalating pressure
      const prompt = getSearchPrompt(round, Business, expandedCountry, Exclusion, alreadyFound, allCompanies.length);

      // Run all 3 models in parallel
      const [perplexityResults, geminiResults, chatgptResults] = await Promise.all([
        runPerplexitySearchTask(prompt, expandedCountry, searchLog)
          .catch(e => { console.error(`    Perplexity failed: ${e.message}`); return []; }),
        runAgenticSearchTask(prompt, expandedCountry, searchLog)
          .catch(e => { console.error(`    Gemini failed: ${e.message}`); return []; }),
        runChatGPTSearchTask(`${Business} companies ${expandedCountry}`, prompt, expandedCountry, searchLog)
          .catch(e => { console.error(`    ChatGPT failed: ${e.message}`); return []; })
      ]);

      // Combine results from this round
      const roundCompanies = [...perplexityResults, ...geminiResults, ...chatgptResults];
      console.log(`    Found: Perplexity ${perplexityResults.length}, Gemini ${geminiResults.length}, ChatGPT ${chatgptResults.length}`);

      // Dedupe within round
      const uniqueRound = dedupeCompanies(roundCompanies);

      // Filter out already-seen companies
      const newCompanies = uniqueRound.filter(c => {
        const website = c.website?.toLowerCase();
        if (!website || seenWebsites.has(website)) return false;
        seenWebsites.add(website);
        return true;
      });

      // Pre-filter (free - no API calls)
      const preFiltered = preFilterCompanies(newCompanies);

      // Add to master list
      allCompanies.push(...preFiltered);

      const roundDuration = ((Date.now() - roundStart) / 1000).toFixed(1);
      console.log(`    New companies: ${preFiltered.length} | Total: ${allCompanies.length} | Time: ${roundDuration}s`);
    }

    console.log(`\n  Search complete. Total unique companies: ${allCompanies.length}`);

    // ========== STEP 3: GPT-4o Validation ==========
    console.log('\n' + '='.repeat(50));
    console.log('STEP 3: GPT-4o VALIDATION');
    console.log('='.repeat(50));

    const validationResults = await validateCompaniesV6(allCompanies, Business, expandedCountry, Exclusion);
    const { validated, flagged, rejected } = validationResults;

    // ========== STEP 4: Results ==========
    console.log('\n' + '='.repeat(50));
    console.log('STEP 4: FINAL RESULTS');
    console.log('='.repeat(50));

    console.log(`V6 FINAL RESULTS:`);
    console.log(`  ✓ VALIDATED: ${validated.length}`);
    console.log(`  ? FLAGGED (security blocked): ${flagged.length}`);
    console.log(`  ✗ REJECTED: ${rejected.length}`);

    // Stats
    const perplexityCount = searchLog.filter(s => s.model === 'perplexity-sonar-pro').length;
    const geminiCount = searchLog.filter(s => !s.model || s.model === 'gemini').length;
    const chatgptCount = searchLog.filter(s => s.model === 'chatgpt-search').length;

    console.log(`\nSearch Statistics:`);
    console.log(`  Rounds: ${NUM_ROUNDS}`);
    console.log(`  Perplexity: ${perplexityCount} searches`);
    console.log(`  Gemini: ${geminiCount} searches`);
    console.log(`  ChatGPT: ${chatgptCount} searches`);
    console.log(`  Total: ${perplexityCount + geminiCount + chatgptCount} searches`);

    // ========== STEP 5: Generate PPT for all companies ==========
    const allWebsites = [
      ...validated.map(c => c.website),
      ...flagged.map(c => c.website)
    ].filter(w => w);

    let pptAttachment = null;

    if (allWebsites.length > 0) {
      console.log('\n' + '='.repeat(50));
      console.log('STEP 5: GENERATING PPT');
      console.log(`Processing ${allWebsites.length} websites...`);
      console.log('='.repeat(50));

      try {
        // Call profile-slides API to generate PPT content
        const pptResponse = await fetch('https://xvasjackgithubio-production-fb38.up.railway.app/api/generate-ppt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            websites: allWebsites,
            targetDescription: `${Business} in ${expandedCountry}`
          })
        });

        const pptResult = await pptResponse.json();

        if (pptResult.success && pptResult.content) {
          console.log(`PPT generated: ${pptResult.companiesProcessed} companies processed`);
          pptAttachment = {
            content: pptResult.content,
            name: pptResult.filename || `Profile_Slides_${new Date().toISOString().split('T')[0]}.pptx`
          };
        } else {
          console.log(`PPT generation failed: ${pptResult.error || 'Unknown error'}`);
        }
      } catch (pptError) {
        console.error('Failed to generate PPT:', pptError.message);
      }
    }

    // ========== STEP 6: Send email with results and PPT ==========
    const finalResults = { validated, flagged, rejected };
    const htmlContent = buildV6EmailHTML(finalResults, Business, expandedCountry, Exclusion);

    await sendEmail(
      Email,
      `[V6] ${Business} in ${Country} (${validated.length} validated + ${flagged.length} flagged)`,
      htmlContent,
      pptAttachment
    );

    const totalTime = ((Date.now() - totalStart) / 1000 / 60).toFixed(1);
    console.log('\n' + '='.repeat(70));
    console.log(`V6 ITERATIVE SEARCH COMPLETE!`);
    console.log(`Email sent to: ${Email}${pptAttachment ? ' with PPT attachment' : ''}`);
    console.log(`Validated: ${validated.length} | Flagged: ${flagged.length} | Rejected: ${rejected.length}`);
    console.log(`Total time: ${totalTime} minutes`);
    console.log('='.repeat(70));

  } catch (error) {
    console.error('V6 Processing error:', error);
    // Try to send error email
    sendEmail(Email, `Find Target V6 - Error`, `<p>Error: ${error.message}</p>`)
      .catch(e => console.error('Failed to send error email:', e));
  }
});

// ============ HEALTHCHECK ============
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'target-v6' });
});

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Target V6 server running on port ${PORT}`);
});
