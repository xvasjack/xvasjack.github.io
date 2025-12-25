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

    // ===== DEFINE MASTER SLIDE WITH FIXED LINES (CANNOT BE MOVED) =====
    pptx.defineSlideMaster({
      title: 'YCP_TRADING_MASTER',
      background: { color: 'FFFFFF' },
      objects: [
        { line: { x: 0, y: 1.02, w: 13.333, h: 0, line: { color: COLORS.navyLine, width: 4.5 } } },
        { line: { x: 0, y: 1.10, w: 13.333, h: 0, line: { color: COLORS.navyLine, width: 2.25 } } },
        { line: { x: 0, y: 7.24, w: 13.333, h: 0, line: { color: COLORS.navyLine, width: 2.25 } } }
      ]
    });

    // Use master slide - lines are fixed in background and cannot be moved
    const slide = pptx.addSlide({ masterName: 'YCP_TRADING_MASTER' });

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

    // Footer line is now in master slide (cannot be moved)

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



// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Trading Comparable server running on port ${PORT}`);
});
