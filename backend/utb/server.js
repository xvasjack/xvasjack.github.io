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
    "total_revenue_url": "Direct URL to the source document (e.g., 'https://company.com/ir/annual-report-2023.pdf')",
    "revenue_by_segment": [
      {"segment": "Segment name", "percentage": "Exact % (e.g., '47%')", "source": "Document name", "source_url": "Direct URL to source"}
    ],
    "revenue_by_geography": [
      {"region": "Region name", "percentage": "Exact % (e.g., '32%')", "source": "Document name", "source_url": "Direct URL to source"}
    ],
    "revenue_history": [
      {"year": "FY2020", "revenue": 123.4},
      {"year": "FY2021", "revenue": 145.2},
      {"year": "FY2022", "revenue": 167.8},
      {"year": "FY2023", "revenue": 189.5}
    ],
    "revenue_unit": "JPY 100M"
  }
}

IMPORTANT:
- If you cannot find EXACT percentages with sources, return empty arrays. No approximations allowed.
- Always include source_url when available. Use the most direct link to the source document.
- For revenue_history: Extract 3-5 years of annual revenue. Convert to 100M JPY units (億円). If company reports in USD/EUR, convert using approximate rates.
- For revenue_unit: Use "JPY 100M" for Japanese companies, "USD M" for US companies, etc.`).catch(e => ({ section: 'profile', error: e.message })),

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
    "overview": "1-2 sentences. What do they sell, to whom?",
    "product_lines": [
      {
        "name": "Business segment name",
        "what_it_does": "One sentence - customer value",
        "revenue_significance": "High/Medium/Low",
        "source_url": "URL to source"
      }
    ],
    "strategic_capabilities": [
      {
        "category": "Technology|Scale|Relationships|Cost|Brand",
        "capability": "Specific capability with number (e.g., '1,200+ patents in polymer chemistry')",
        "source": "Source document name",
        "source_url": "URL to source"
      }
    ]
  },
  "operations": {
    "manufacturing_footprint": [
      {"location": "City, Country", "type": "Manufacturing|R&D|HQ|Distribution", "details": "Capacity/employees/products", "source_url": "URL"}
    ]
  }
}

BE CONCISE. Each field should be brief and scannable. Include source_url for every data point.`).catch(e => ({ section: 'products', error: e.message })),

    // Synthesis 3: Competitive Landscape
    callChatGPT(`You are writing a COMPREHENSIVE competitive analysis for M&A ADVISORS.

COMPANY: ${companyName}

RESEARCH ON COMPETITORS:
${research.competitors}

RESEARCH ON PRODUCTS (for context):
${research.products}

---

CRITICAL INSTRUCTIONS:
- Be concise. No verbose explanations.
- For competitors - list 10-12 global competitors with key metrics.
- Include source URLs for all data points.

Respond in this EXACT JSON format:
{
  "competitive_landscape": {
    "company_position": {
      "market_rank": "#1, #2, Top 5, etc.",
      "market_share": "X%",
      "source_url": "URL to market share source",
      "why_they_win": [
        {
          "advantage_type": "Technology|Scale|Cost|Relationships|Brand|Geography",
          "description": "One sentence with specific evidence",
          "source_url": "URL"
        }
      ],
      "key_vulnerability": "One sentence",
      "vulnerability_source_url": "URL"
    },
    "key_competitors": [
      {
        "name": "Competitor name",
        "hq_country": "Country",
        "revenue": "$XB",
        "market_share": "X%",
        "positioning": "Premium|Mid-tier|Value",
        "key_strength": "One sentence",
        "threat_level": "High|Medium|Low",
        "source_url": "URL"
      }
    ]
  }
}

IMPORTANT: List 10 competitors. Keep each field brief and scannable.`).catch(e => ({ section: 'competitors', error: e.message })),

    // Synthesis 4: M&A Deep Dive - Structured Analysis
    callChatGPT(`Extract M&A intelligence for ${companyName}. BE CONCISE - one sentence per field max.

RESEARCH ON M&A HISTORY:
${research.maHistory}

RESEARCH ON LEADERSHIP & STRATEGY:
${research.leadership}

RESEARCH ON FINANCIALS:
${research.financials}

---

Respond in this EXACT JSON format:
{
  "ma_deep_dive": {
    "deal_history": [
      {
        "target": "Company name",
        "year": "YYYY",
        "deal_value": "$XM or undisclosed",
        "deal_type": "Acquisition|Merger|JV|Minority",
        "strategic_rationale": "Technology|Market Access|Capacity|Talent|Vertical Integration",
        "outcome": "Integrated|Standalone|Divested",
        "source_url": "URL to announcement"
      }
    ],
    "ma_profile": {
      "acquirer_type": "Serial Acquirer|Opportunistic|Transformational|Bolt-on Only",
      "primary_focus": "Technology|Geography|Capacity|Vertical Integration",
      "typical_deal_size": "$X-YM range",
      "integration_style": "Full Absorption|Standalone|Hybrid",
      "valuation_discipline": "Premium Payer|Disciplined|Value Buyer"
    },
    "deal_capacity": {
      "dry_powder": "$XM (cash + debt capacity)",
      "appetite_level": "High|Medium|Low",
      "decision_speed": "Fast (<6mo)|Normal (6-12mo)|Slow (>12mo)",
      "source_url": "URL to financials"
    }
  }
}

Keep all fields brief. Include source_url for verifiable claims.`).catch(e => ({ section: 'ma_analysis', error: e.message })),

    // Synthesis 5: Ideal Target Profile - SEA/Asia Target List with Products
    callChatGPT(`Identify 10 REAL acquisition targets for ${companyName} in SOUTHEAST ASIA or ASIA. BE CONCISE.

RESEARCH:
${research.products}
${research.maHistory}
${research.leadership}
${research.financials}

${context ? `CLIENT CONTEXT: ${context}` : ''}

---

GEOGRAPHIC FOCUS: Prioritize targets in:
1. Southeast Asia (Singapore, Thailand, Vietnam, Indonesia, Malaysia, Philippines)
2. If not enough in SEA, expand to broader Asia (Japan, Korea, China, Taiwan, India)
Do NOT include targets from Americas, Europe, or other regions.

Respond in this EXACT JSON format:
{
  "ideal_target": {
    "segments": ["Segment 1", "Segment 2", "Segment 3", "Segment 4"],
    "target_list": [
      {
        "company_name": "Actual company name",
        "hq_country": "Country",
        "hq_city": "City",
        "revenue": "$XM",
        "ownership": "Public|Private|PE-backed",
        "products_offered": [true, false, true, false],
        "website": "company URL"
      }
    ]
  }
}

IMPORTANT:
- "segments" should list the 4-6 main product/service categories based on the buyer's business
- "products_offered" is a boolean array matching the segments array (true = company offers this product/service)
- Real SEA/Asia companies only
- Include company website URL`).catch(e => ({ section: 'ideal_target', error: e.message }))
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

// Generate UTB PowerPoint slides with structured data (1 slide per segment)
async function generateUTBSlides(companyName, website, research, additionalContext) {
  const { synthesis, metadata } = research;

  console.log('[UTB] Generating slides...');

  const pptx = new pptxgen();
  pptx.author = 'YCP Solidiance';
  pptx.title = `UTB: ${companyName}`;
  pptx.subject = 'M&A Buyer Intelligence Report';

  // Set exact slide size to match YCP template (13.333" x 7.5" = 16:9 widescreen)
  pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
  pptx.layout = 'YCP';

  // YCP Theme Colors (matching profile-slides template exactly)
  const COLORS = {
    headerLine: '293F55',    // Dark navy for header/footer lines
    headerBg: '1524A9',      // Dark blue for table header row
    labelBg: '011AB7',       // Dark blue for label column (accent3)
    companyBg: '007FFF',     // Bright blue for company column
    white: 'FFFFFF',
    black: '000000',
    gray: 'BFBFBF',          // Gray for dotted borders between rows
    footerText: '808080'     // Gray footer text
  };

  // Define master slide with fixed lines (matching YCP template)
  pptx.defineSlideMaster({
    title: 'YCP_MASTER',
    background: { color: 'FFFFFF' },
    objects: [
      // Thick header line (y: 1.02")
      { line: { x: 0, y: 1.02, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 4.5 } } },
      // Thin header line (y: 1.10")
      { line: { x: 0, y: 1.10, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } } },
      // Footer line (y: 7.24")
      { line: { x: 0, y: 7.24, w: 13.333, h: 0, line: { color: COLORS.headerLine, width: 2.25 } } }
    ]
  });

  // Helper: Add slide title (YCP format - black text, left-aligned, valign bottom)
  const addSlideTitle = (slide, title) => {
    slide.addText(title, {
      x: 0.38, y: 0.07, w: 9.5, h: 0.9,
      fontSize: 24, fontFace: 'Segoe UI',
      color: COLORS.black, valign: 'bottom'
    });
  };

  // Helper: Add footnote
  const addFootnote = (slide, text = 'Source: Company disclosures, public filings') => {
    slide.addText(text, {
      x: 0.38, y: 6.85, w: 12.5, h: 0.3,
      fontSize: 10, fontFace: 'Segoe UI',
      color: COLORS.footerText, valign: 'top'
    });
  };

  // Helper: Get row border (dotted between rows, solid white on edges)
  const getRowBorder = (isLastRow) => {
    return isLastRow
      ? { pt: 3, color: COLORS.white }
      : { pt: 1, color: COLORS.gray, type: 'dash' };
  };

  const prod = synthesis.products_and_services || {};
  const maDeepDive = synthesis.ma_deep_dive || {};

  // ========== SLIDE 1: TITLE SLIDE ==========
  const titleSlide = pptx.addSlide({ masterName: 'YCP_MASTER' });

  // Company name - centered, black, large
  titleSlide.addText(companyName, {
    x: 0.38, y: 2.5, w: 12.54, h: 1.0,
    fontSize: 36, fontFace: 'Segoe UI', bold: true,
    color: COLORS.black, align: 'center'
  });

  // Client intention (from additionalContext)
  if (additionalContext) {
    titleSlide.addText(additionalContext, {
      x: 0.38, y: 3.6, w: 12.54, h: 0.8,
      fontSize: 16, fontFace: 'Segoe UI',
      color: COLORS.footerText, align: 'center'
    });
  }

  // Generated date at bottom
  titleSlide.addText(`Generated: ${new Date().toLocaleDateString()}`, {
    x: 0.38, y: 6.5, w: 12.54, h: 0.3,
    fontSize: 10, fontFace: 'Segoe UI',
    color: COLORS.footerText, align: 'center'
  });

  // ========== SLIDE 2: BUSINESS OVERVIEW ==========
  if (prod.product_lines && prod.product_lines.length > 0) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'Business Overview');

    // Subtitle: one-line business descriptor
    const overview = prod.overview || `${companyName} business segments and operations`;
    slide.addText(overview, {
      x: 0.38, y: 0.85, w: 12.54, h: 0.25,
      fontSize: 11, fontFace: 'Segoe UI',
      color: COLORS.footerText, align: 'left'
    });

    // Column widths: Segment (2.5") + Description (9.92")
    const segmentColW = 2.5;
    const descColW = 9.92;
    const tableStartX = 0.38;
    const tableStartY = 1.25;
    const rowHeight = 0.7;
    const headerHeight = 0.35;
    const lines = prod.product_lines.slice(0, 7); // Max 7 rows

    // Column header: Business Segment
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: tableStartX, y: tableStartY, w: segmentColW, h: headerHeight,
      fill: { type: 'none' },
      line: { type: 'none' }
    });
    slide.addText('Business Segment', {
      x: tableStartX, y: tableStartY, w: segmentColW, h: headerHeight,
      fontSize: 11, fontFace: 'Segoe UI', bold: true,
      color: COLORS.black, align: 'left', valign: 'bottom'
    });
    // Header underline for segment column
    slide.addShape(pptx.shapes.LINE, {
      x: tableStartX, y: tableStartY + headerHeight, w: segmentColW - 0.1, h: 0,
      line: { color: COLORS.gray, width: 1 }
    });

    // Column header: Description
    slide.addText('Description', {
      x: tableStartX + segmentColW + 0.12, y: tableStartY, w: descColW, h: headerHeight,
      fontSize: 11, fontFace: 'Segoe UI', bold: true,
      color: COLORS.black, align: 'left', valign: 'bottom'
    });
    // Header underline for description column
    slide.addShape(pptx.shapes.LINE, {
      x: tableStartX + segmentColW + 0.12, y: tableStartY + headerHeight, w: descColW, h: 0,
      line: { color: COLORS.gray, width: 1 }
    });

    // Data rows
    const dataStartY = tableStartY + headerHeight + 0.1;

    lines.forEach((line, i) => {
      const y = dataStartY + i * rowHeight;
      const isLastRow = i === lines.length - 1;

      // Blue segment block (fixed width, uniform height)
      slide.addShape(pptx.shapes.RECTANGLE, {
        x: tableStartX, y: y, w: segmentColW, h: rowHeight - 0.08,
        fill: { color: COLORS.labelBg },
        line: { type: 'none' }
      });

      // Segment name (white text, centered both ways)
      slide.addText(line.name || '', {
        x: tableStartX + 0.1, y: y, w: segmentColW - 0.2, h: rowHeight - 0.08,
        fontSize: 11, fontFace: 'Segoe UI', bold: true,
        color: COLORS.white, align: 'center', valign: 'middle'
      });

      // Description with solid square bullets
      const desc = line.what_it_does || line.description || '';
      const sentences = desc.replace(/\. /g, '.|').split('|').filter(s => s.trim()).slice(0, 2);
      const bulletText = sentences.map(s => '■  ' + s.trim()).join('\n');

      slide.addText(bulletText, {
        x: tableStartX + segmentColW + 0.12, y: y + 0.08, w: descColW, h: rowHeight - 0.16,
        fontSize: 10, fontFace: 'Segoe UI',
        color: COLORS.black, align: 'left', valign: 'middle',
        lineSpacing: 16
      });

      // Dotted horizontal divider spanning full width (not on last row)
      if (!isLastRow) {
        slide.addShape(pptx.shapes.LINE, {
          x: tableStartX, y: y + rowHeight - 0.04, w: segmentColW + 0.12 + descColW, h: 0,
          line: { color: COLORS.gray, width: 0.5, dashType: 'dash' }
        });
      }
    });

    addFootnote(slide);
  }

  // ========== SLIDE 3: PAST M&A ==========
  const dealHistory = maDeepDive.deal_history || maDeepDive.deal_stories || [];
  if (dealHistory.length > 0) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'Past M&A');

    const rows = [
      [
        { text: 'Target', options: { fill: { color: COLORS.headerBg }, color: COLORS.white, bold: false, align: 'left', valign: 'middle', border: { pt: 3, color: COLORS.white } } },
        { text: 'Year', options: { fill: { color: COLORS.headerBg }, color: COLORS.white, bold: false, align: 'center', valign: 'middle', border: { pt: 3, color: COLORS.white } } },
        { text: 'Value', options: { fill: { color: COLORS.headerBg }, color: COLORS.white, bold: false, align: 'center', valign: 'middle', border: { pt: 3, color: COLORS.white } } },
        { text: 'Type', options: { fill: { color: COLORS.headerBg }, color: COLORS.white, bold: false, align: 'center', valign: 'middle', border: { pt: 3, color: COLORS.white } } },
        { text: 'Rationale', options: { fill: { color: COLORS.headerBg }, color: COLORS.white, bold: false, align: 'left', valign: 'middle', border: { pt: 3, color: COLORS.white } } }
      ]
    ];

    const deals = dealHistory.slice(0, 8);
    deals.forEach((deal, i) => {
      const isLastRow = i === deals.length - 1;
      rows.push([
        { text: deal.target || deal.deal || '', options: {
          fill: { color: COLORS.companyBg },
          color: COLORS.white,
          bold: false,
          align: 'left',
          valign: 'middle',
          border: { pt: 3, color: COLORS.white }
        }},
        { text: deal.year || '', options: {
          fill: { color: COLORS.white },
          color: COLORS.black,
          align: 'center',
          valign: 'middle',
          border: [{ pt: 3, color: COLORS.white }, { pt: 3, color: COLORS.white }, getRowBorder(isLastRow), { pt: 3, color: COLORS.white }]
        }},
        { text: deal.deal_value || '', options: {
          fill: { color: COLORS.white },
          color: COLORS.black,
          align: 'center',
          valign: 'middle',
          border: [{ pt: 3, color: COLORS.white }, { pt: 3, color: COLORS.white }, getRowBorder(isLastRow), { pt: 3, color: COLORS.white }]
        }},
        { text: deal.deal_type || '', options: {
          fill: { color: COLORS.white },
          color: COLORS.black,
          align: 'center',
          valign: 'middle',
          border: [{ pt: 3, color: COLORS.white }, { pt: 3, color: COLORS.white }, getRowBorder(isLastRow), { pt: 3, color: COLORS.white }]
        }},
        { text: deal.strategic_rationale || '', options: {
          fill: { color: COLORS.white },
          color: COLORS.black,
          align: 'left',
          valign: 'middle',
          border: [{ pt: 3, color: COLORS.white }, { pt: 3, color: COLORS.white }, getRowBorder(isLastRow), { pt: 3, color: COLORS.white }]
        }}
      ]);
    });

    slide.addTable(rows, {
      x: 0.38, y: 1.2, w: 12.54,
      colW: [3.0, 1.0, 1.5, 1.8, 5.24],
      rowH: 0.5,
      fontFace: 'Segoe UI',
      fontSize: 10,
      valign: 'middle'
    });

    addFootnote(slide);
  }

  // ========== SLIDE 4: TARGET LIST with Products/Services Tick Marks ==========
  const idealTarget = synthesis.ideal_target || {};
  const targetList = idealTarget.target_list || [];
  const segments = idealTarget.segments || ['Product 1', 'Product 2', 'Product 3', 'Product 4'];

  if (targetList.length > 0) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });

    // Title: "Target List – SEA/Asia"
    const targetTitle = additionalContext
      ? `Target List – ${additionalContext.substring(0, 40)}`
      : 'Target List – SEA/Asia';
    addSlideTitle(slide, targetTitle);

    // Use max 4 segments, fully spelled out (no truncation)
    const displaySegments = segments.slice(0, 4);
    const numSegments = displaySegments.length;

    // Column widths: Company(2.6) + HQ(0.9) + Revenue(1.0) + segments(remaining, evenly split)
    const fixedColsW = 2.6 + 0.9 + 1.0;
    const segmentColW = (12.54 - fixedColsW) / numSegments;
    const colWidths = [2.6, 0.9, 1.0, ...Array(numSegments).fill(segmentColW)];

    // Build header row with tall uniform blocks
    const headerOpts = {
      fill: { color: COLORS.headerBg },
      color: COLORS.white,
      bold: true,
      align: 'center',
      valign: 'middle',
      border: { pt: 2, color: COLORS.white }
    };

    const headerRow = [
      { text: 'Company', options: { ...headerOpts, align: 'left' } },
      { text: 'HQ', options: headerOpts },
      { text: 'Revenue', options: headerOpts }
    ];

    // Add segment columns to header (full names, no truncation)
    displaySegments.forEach(seg => {
      headerRow.push({
        text: seg,
        options: { ...headerOpts, fontSize: 9 }
      });
    });

    const rows = [headerRow];
    const targets = targetList.slice(0, 10);

    targets.forEach((t, i) => {
      const isLastRow = i === targets.length - 1;

      // Company column: lighter blue, plain text (no hyperlinks)
      const row = [
        { text: `${i + 1}. ${t.company_name || ''}`, options: {
          fill: { color: COLORS.companyBg },
          color: COLORS.white,
          bold: false,
          align: 'left',
          valign: 'middle',
          border: { pt: 2, color: COLORS.white }
        }},
        { text: t.hq_country || '', options: {
          fill: { color: COLORS.white },
          color: COLORS.black,
          align: 'center',
          valign: 'middle',
          border: [{ pt: 2, color: COLORS.white }, { pt: 2, color: COLORS.white }, getRowBorder(isLastRow), { pt: 2, color: COLORS.white }]
        }},
        { text: t.revenue || t.estimated_revenue || '', options: {
          fill: { color: COLORS.white },
          color: COLORS.black,
          align: 'center',
          valign: 'middle',
          border: [{ pt: 2, color: COLORS.white }, { pt: 2, color: COLORS.white }, getRowBorder(isLastRow), { pt: 2, color: COLORS.white }]
        }}
      ];

      // Add tick marks for each segment (centered, consistent size)
      const productsOffered = t.products_offered || [];
      displaySegments.forEach((seg, si) => {
        const hasProduct = productsOffered[si] === true;
        row.push({
          text: hasProduct ? '✓' : '',
          options: {
            fill: { color: COLORS.white },
            color: '00A651', // Green tick
            fontSize: 12,
            bold: true,
            align: 'center',
            valign: 'middle',
            border: [{ pt: 2, color: COLORS.white }, { pt: 2, color: COLORS.white }, getRowBorder(isLastRow), { pt: 2, color: COLORS.white }]
          }
        });
      });

      rows.push(row);
    });

    slide.addTable(rows, {
      x: 0.38, y: 1.2, w: 12.54,
      colW: colWidths,
      rowH: [0.55, ...Array(targets.length).fill(0.5)], // Taller header row
      fontFace: 'Segoe UI',
      fontSize: 10,
      valign: 'middle'
    });

    // Bottom boundary line
    const tableBottom = 1.2 + 0.55 + (targets.length * 0.5);
    slide.addShape(pptx.shapes.LINE, {
      x: 0.38, y: tableBottom, w: 12.54, h: 0,
      line: { color: COLORS.gray, width: 1 }
    });

    addFootnote(slide, 'Source: Company disclosures, industry databases');
  }

  // ========== SLIDE 5: M&A STRATEGY (Row-Based Geographic Framework) ==========
  if (targetList.length >= 2) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'M&A Strategy');

    // Define geographic strategy themes based on target locations
    const geoStrategies = [];

    // Group targets by region
    const seaCountries = ['Singapore', 'Thailand', 'Vietnam', 'Indonesia', 'Malaysia', 'Philippines'];
    const greaterChinaCountries = ['China', 'Taiwan', 'Hong Kong'];
    const neaCountries = ['Japan', 'Korea', 'South Korea'];

    const seaTargets = targetList.filter(t => seaCountries.some(c => (t.hq_country || '').includes(c)));
    const gcTargets = targetList.filter(t => greaterChinaCountries.some(c => (t.hq_country || '').includes(c)));
    const neaTargets = targetList.filter(t => neaCountries.some(c => (t.hq_country || '').includes(c)));
    const otherTargets = targetList.filter(t =>
      !seaCountries.some(c => (t.hq_country || '').includes(c)) &&
      !greaterChinaCountries.some(c => (t.hq_country || '').includes(c)) &&
      !neaCountries.some(c => (t.hq_country || '').includes(c))
    );

    // Build strategy rows based on available targets
    if (seaTargets.length > 0) {
      const topTarget = seaTargets[0];
      geoStrategies.push({
        region: 'Southeast Asia',
        strategy: `■  Acquire ${topTarget.company_name} (${topTarget.hq_country}) to establish regional footprint\n■  Leverage local distribution networks and customer relationships`,
        rationale: `■  Access to high-growth ASEAN markets with favorable demographics\n■  Cost-effective manufacturing base and supply chain diversification`
      });
    }

    if (gcTargets.length > 0) {
      const topTarget = gcTargets[0];
      geoStrategies.push({
        region: 'Greater China',
        strategy: `■  Target ${topTarget.company_name} for technology and scale expansion\n■  Build presence in world's largest manufacturing ecosystem`,
        rationale: `■  Access to advanced manufacturing capabilities and R&D talent\n■  Strategic positioning in key supply chain hub`
      });
    }

    if (neaTargets.length > 0) {
      const topTarget = neaTargets[0];
      geoStrategies.push({
        region: 'Northeast Asia',
        strategy: `■  Partner with or acquire ${topTarget.company_name} for premium segment\n■  Strengthen technical capabilities through talent acquisition`,
        rationale: `■  Access to high-value customer segments and premium pricing\n■  Technology transfer and quality improvement opportunities`
      });
    }

    if (otherTargets.length > 0 && geoStrategies.length < 3) {
      const topTarget = otherTargets[0];
      geoStrategies.push({
        region: 'Other Asia',
        strategy: `■  Evaluate ${topTarget.company_name} for niche market entry\n■  Diversify geographic exposure beyond core markets`,
        rationale: `■  Risk diversification across multiple markets\n■  Access to unique capabilities or customer segments`
      });
    }

    // Ensure at least 3 rows
    while (geoStrategies.length < 3) {
      geoStrategies.push({
        region: geoStrategies.length === 0 ? 'Southeast Asia' : (geoStrategies.length === 1 ? 'Greater China' : 'Northeast Asia'),
        strategy: '■  Identify acquisition targets in region\n■  Build local market intelligence',
        rationale: '■  Expand geographic footprint\n■  Diversify revenue streams'
      });
    }

    // Column widths: Region(2.0) + Strategy(5.27) + Rationale(5.27)
    const colWidths = [2.0, 5.27, 5.27];
    const tableStartX = 0.38;
    const tableStartY = 1.2;
    const headerHeight = 0.5;
    const rowHeight = 1.2;

    // Header row
    const headerOpts = {
      fill: { color: COLORS.headerBg },
      color: COLORS.white,
      bold: true,
      align: 'center',
      valign: 'middle',
      border: { pt: 2, color: COLORS.white }
    };

    const rows = [
      [
        { text: 'Region', options: headerOpts },
        { text: 'Strategy', options: headerOpts },
        { text: 'Rationale', options: headerOpts }
      ]
    ];

    // Data rows
    geoStrategies.slice(0, 4).forEach((gs, i) => {
      const isLastRow = i === Math.min(geoStrategies.length, 4) - 1;

      rows.push([
        { text: gs.region, options: {
          fill: { color: COLORS.labelBg },
          color: COLORS.white,
          bold: true,
          fontSize: 12,
          align: 'center',
          valign: 'middle',
          border: { pt: 2, color: COLORS.white }
        }},
        { text: gs.strategy, options: {
          fill: { color: COLORS.white },
          color: COLORS.black,
          fontSize: 10,
          align: 'left',
          valign: 'top',
          border: [{ pt: 2, color: COLORS.white }, { pt: 2, color: COLORS.white }, getRowBorder(isLastRow), { pt: 2, color: COLORS.white }]
        }},
        { text: gs.rationale, options: {
          fill: { color: COLORS.white },
          color: COLORS.black,
          fontSize: 10,
          align: 'left',
          valign: 'top',
          border: [{ pt: 2, color: COLORS.white }, { pt: 2, color: COLORS.white }, getRowBorder(isLastRow), { pt: 2, color: COLORS.white }]
        }}
      ]);
    });

    slide.addTable(rows, {
      x: tableStartX, y: tableStartY, w: 12.54,
      colW: colWidths,
      rowH: [headerHeight, ...Array(rows.length - 1).fill(rowHeight)],
      fontFace: 'Segoe UI',
      fontSize: 14,
      valign: 'middle'
    });

    addFootnote(slide);
  }

  // ========== SLIDE 6: FINANCIAL BAR CHART (if revenue history available) ==========
  const fin = synthesis.financials || {};
  const revenueHistory = fin.revenue_history || [];

  if (revenueHistory.length >= 2) {
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });
    addSlideTitle(slide, 'Revenue Trend');

    // Chart data
    const chartData = [{
      name: 'Revenue',
      labels: revenueHistory.map(r => r.year),
      values: revenueHistory.map(r => r.revenue)
    }];

    // Add bar chart
    slide.addChart(pptx.charts.BAR, chartData, {
      x: 0.5, y: 1.3, w: 12, h: 5.0,
      barDir: 'col', // Vertical bars
      barGapWidthPct: 50,
      chartColors: [COLORS.companyBg], // Bright blue bars
      showValue: true,
      dataLabelPosition: 'outEnd',
      dataLabelFontSize: 10,
      dataLabelFontFace: 'Segoe UI',
      dataLabelColor: COLORS.black,
      catAxisTitle: 'Fiscal Year',
      catAxisTitleFontSize: 10,
      catAxisLabelFontSize: 10,
      catAxisLabelFontFace: 'Segoe UI',
      valAxisTitle: fin.revenue_unit || 'JPY 100M',
      valAxisTitleFontSize: 10,
      valAxisLabelFontSize: 9,
      valAxisLabelFontFace: 'Segoe UI',
      valAxisMinVal: 0,
      showLegend: false,
      showTitle: false
    });

    addFootnote(slide, 'Source: Company disclosures, annual reports');
  }

  // Generate base64
  const base64Content = await pptx.write({ outputType: 'base64' });
  console.log('[UTB] Slides generated successfully');

  return base64Content;
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

    // Generate PowerPoint slides with structured data (1 slide per segment)
    const slidesBase64 = await generateUTBSlides(companyName, website, research, context);

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
      { content: slidesBase64, name: `UTB_${companyName.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.pptx` }
    );

    console.log(`[UTB] Slides report sent successfully to ${email}`);
  } catch (error) {
    console.error('[UTB] Error:', error);
    await sendEmail(email, `UTB Error - ${companyName}`, `<p>Error: ${error.message}</p>`).catch(() => {});
  }
});



// ============ HEALTHCHECK ============
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'utb' });
});

// ============ SERVER STARTUP ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`UTB server running on port ${PORT}`);
});
