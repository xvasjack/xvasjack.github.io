require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const OpenAI = require('openai');
const { createClient } = require('@deepgram/sdk');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { securityHeaders, rateLimiter, sanitizePath } = require('./shared/security');
const { requestLogger, healthCheck } = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { createTracker, trackingContext, recordTokens } = require('./shared/tracking');

// Setup global error handlers to prevent crashes
setupGlobalErrorHandlers();

const app = express();
app.use(securityHeaders);
app.use(rateLimiter);
app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Check required environment variables
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'PERPLEXITY_API_KEY',
  'GEMINI_API_KEY',
  'SENDGRID_API_KEY',
  'SENDER_EMAIL',
];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing environment variables:', missingVars.join(', '));
}
if (!process.env.SERPAPI_API_KEY) {
  console.warn('SERPAPI_API_KEY not set - Google search will be skipped');
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.warn('DEEPSEEK_API_KEY not set - Due Diligence reports will use GPT-4.1 fallback');
}
if (!process.env.DEEPGRAM_API_KEY) {
  console.warn('DEEPGRAM_API_KEY not set - Real-time transcription will not work');
}
// Note: ANTHROPIC_API_KEY is optional - V5 uses Gemini + ChatGPT for search/validation

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'missing',
});

// Initialize Deepgram
const deepgram = process.env.DEEPGRAM_API_KEY ? createClient(process.env.DEEPGRAM_API_KEY) : null;

// Initialize Cloudflare R2 (S3-compatible)
const r2Client =
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY
    ? new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

const R2_BUCKET = process.env.R2_BUCKET_NAME || 'dd-recordings';

if (!r2Client) {
  console.warn(
    'R2 not configured - recordings will only be stored in memory. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME'
  );
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
      ContentType: contentType,
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
      Key: key,
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
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
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
  wavBuffer.writeUInt16LE(1, 20); // audio format (1 = PCM)
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

// ============ AI TOOLS ============

// Detect domain/context from text for domain-aware translation
function detectMeetingDomain(text) {
  const domains = {
    financial:
      /\b(revenue|EBITDA|valuation|M&A|merger|acquisition|IPO|equity|debt|ROI|P&L|balance sheet|cash flow|投資|収益|利益|財務)\b/i,
    legal:
      /\b(contract|agreement|liability|compliance|litigation|IP|intellectual property|NDA|terms|clause|legal|lawyer|attorney|契約|法的|弁護士)\b/i,
    medical:
      /\b(clinical|trial|FDA|patient|therapeutic|drug|pharmaceutical|biotech|efficacy|dosage|治療|患者|医療|臨床)\b/i,
    technical:
      /\b(API|architecture|infrastructure|database|server|cloud|deployment|code|software|engineering|システム|開発|技術)\b/i,
    hr: /\b(employee|hiring|compensation|benefits|performance|talent|HR|recruitment|人事|採用|給与)\b/i,
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
    financial:
      'This is a financial/investment due diligence meeting. Preserve financial terms like M&A, EBITDA, ROI, P&L accurately. Use standard financial terminology.',
    legal:
      'This is a legal due diligence meeting. Preserve legal terms and contract language precisely. Maintain formal legal register.',
    medical:
      'This is a medical/pharmaceutical due diligence meeting. Preserve medical terminology, drug names, and clinical terms accurately.',
    technical:
      'This is a technical due diligence meeting. Preserve technical terms, acronyms, and engineering terminology accurately.',
    hr: 'This is an HR/talent due diligence meeting. Preserve HR terminology and employment-related terms accurately.',
    general:
      'This is a business due diligence meeting. Preserve business terminology and professional tone.',
  };
  return instructions[domain] || instructions.general;
}

// Translate text using GPT-4.1 with context awareness
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
${previousSegments
  .slice(-3)
  .map((seg, i) => `[${i + 1}] ${seg}`)
  .join('\n')}

Now translate the following new segment, maintaining consistency with the context above:`;
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4.1', // Use GPT-4.1 for better translation quality
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
Output only the translation, nothing else.`,
        },
        {
          role: 'user',
          content: contextSection ? `${contextSection}\n\n${text}` : text,
        },
      ],
      temperature: 0.3, // Balanced temperature for fluency while maintaining consistency
    });
    if (response.usage) {
      recordTokens('gpt-4.1', response.usage.prompt_tokens || 0, response.usage.completion_tokens || 0);
    }
    return response.choices[0].message.content || text;
  } catch (error) {
    console.error('Translation error:', error.message);
    return text;
  }
}

// ============ EXTRACTION WITH GPT-4.1-nano ============

// ============ DEDUPLICATION (Enhanced for v20) ============

// Extract domain root for additional deduplication
// ============ PRE-FILTER: Remove only obvious non-company URLs ============

// ============ EXHAUSTIVE PARALLEL SEARCH WITH 14 STRATEGIES ============

// Process SerpAPI results and extract companies using GPT
// ============ WEBSITE VERIFICATION ============

// ============ FETCH WEBSITE FOR VALIDATION ============

// ============ VALIDATION (v24 - GPT-4.1 with LENIENT filtering) ============

// ============ VALIDATION FOR SLOW MODE (v23 - n8n style) ============

// ============ HEALTH CHECK ============
app.get('/health', healthCheck('transcription'));

// ============ FAST ENDPOINT ============

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Find Target v40 - DD Report with Real-Time Transcription' });
});

// Check if real-time transcription is available
app.get('/api/transcription-status', (req, res) => {
  res.json({
    available: !!process.env.DEEPGRAM_API_KEY,
    message: process.env.DEEPGRAM_API_KEY
      ? 'Ready for real-time transcription'
      : 'DEEPGRAM_API_KEY not configured',
  });
});

// ============ WEBSOCKET SERVER FOR REAL-TIME TRANSCRIPTION ============

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
setInterval(
  () => {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionId, session] of activeSessions.entries()) {
      // Remove sessions older than 2 hours (safety net for missed cleanups)
      if (session.startTime && now - session.startTime.getTime() > 2 * 60 * 60 * 1000) {
        activeSessions.delete(sessionId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(
        `[WS] Periodic cleanup: removed ${cleaned} stale sessions. Active: ${activeSessions.size}`
      );
    }
  },
  10 * 60 * 1000
);

wss.on('connection', (ws, _req) => {
  console.log('[WS] New client connected for real-time transcription');

  // Check session limit to prevent memory exhaustion
  if (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
    console.warn(`[WS] Session limit reached (${MAX_ACTIVE_SESSIONS}), rejecting connection`);
    ws.send(JSON.stringify({ type: 'error', message: 'Server busy. Please try again later.' }));
    ws.close();
    return;
  }

  const sessionTracker = createTracker('transcription', 'websocket-session', {});

  trackingContext.run(sessionTracker, () => {
  let deepgramConnection = null;
  const sessionId = Date.now().toString();
  const audioChunks = [];
  let fullTranscript = '';
  let detectedLanguage = 'en';
  let translatedTranscript = '';

  // Segment buffering for improved translation context
  let segmentBuffer = []; // Buffer to accumulate segments before translation
  const translationContext = []; // Previous translated segments for context
  let detectedDomain = null; // Auto-detected meeting domain
  const SEGMENT_BUFFER_SIZE = 2; // Number of segments to buffer before translating
  const MAX_CONTEXT_SEGMENTS = 5; // Maximum previous segments to keep for context

  // Store session data
  activeSessions.set(sessionId, {
    startTime: new Date(),
    audioChunks: [],
    transcript: '',
    translatedTranscript: '',
    language: 'en',
    segmentBuffer: [],
    translationContext: [],
    detectedDomain: null,
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
        isJsonMessage =
          message.length < 1024 &&
          message[0] === 123 &&
          (message.includes(0x22) || message.toString().includes('"type"'));
      }

      if (isJsonMessage) {
        const data = JSON.parse(message.toString());

        if (data.type === 'start') {
          // Start Deepgram connection
          console.log(
            `[WS] Starting transcription session ${sessionId}, language: ${data.language || 'auto'}`
          );

          if (!deepgram) {
            ws.send(JSON.stringify({ type: 'error', message: 'Deepgram API key not configured' }));
            return;
          }

          // Check if multi-language mode is requested
          const isMultiLang =
            !data.language || data.language === 'auto' || data.language === 'multi';

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
            diarize: true, // Enable speaker identification
          };

          // Set language - if specific language requested, use it; otherwise use 'multi' for auto-detection
          // Nova-3 with language='multi' enables true multilingual code-switching
          // See: https://developers.deepgram.com/docs/multilingual-code-switching
          const currentSession = activeSessions.get(sessionId);
          if (isMultiLang) {
            dgOptions.language = 'multi'; // Multilingual code-switching mode
            dgOptions.endpointing = 100; // Recommended for code-switching (100ms)
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
          const detectLanguageFromText = (text) => {
            if (!text || text.length < 3) return null;

            // Check for Chinese characters (CJK Unified Ideographs)
            if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
            // Check for Japanese (Hiragana, Katakana)
            if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja';
            // Check for Korean (Hangul)
            if (/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) return 'ko';
            // Check for Thai
            if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
            // Check for Vietnamese (special diacritics - Unicode ranges for Vietnamese vowels with tones and đ)
            if (
              /[\u00c0-\u00c3\u00c8-\u00ca\u00cc-\u00cd\u00d2-\u00d5\u00d9-\u00da\u00dd\u00e0-\u00e3\u00e8-\u00ea\u00ec-\u00ed\u00f2-\u00f5\u00f9-\u00fa\u00fd\u0102-\u0103\u0110-\u0111\u0128-\u0129\u0168-\u0169\u01a0-\u01b0\u1ea0-\u1ef9]/i.test(
                text
              )
            )
              return 'vi';
            // Check for Hindi/Devanagari
            if (/[\u0900-\u097f]/.test(text)) return 'hi';
            // Check for Arabic
            if (/[\u0600-\u06ff]/.test(text)) return 'ar';
            // Check for Indonesian/Malay (common words)
            if (
              /\b(dan|yang|untuk|dengan|ini|itu|dari|ke|tidak|ada|akan|pada|sudah|juga|saya|kami|mereka)\b/i.test(
                text
              )
            )
              return 'id';

            return 'en'; // Default to English
          };

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
              detLang = dgData.channel.languages[0]; // Primary language by word count
            }

            // Check for per-word language (code-switching detection)
            let segmentLang = null;
            if (words.length > 0 && words[0].language) {
              segmentLang = words[0].language; // Language of first word in segment
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
                speaker = words[0].speaker; // Speaker number (0, 1, 2, etc.)
              }

              // Use per-segment language for accurate code-switching detection
              const thisSegmentLang = segmentLang || effectiveLang;

              console.log(
                `[WS] Transcript: "${transcript}" (final: ${isFinal}, lang: ${thisSegmentLang}, speaker: ${speaker})`
              );
              // Send interim results to client with speaker info and per-segment language
              ws.send(
                JSON.stringify({
                  type: 'transcript',
                  text: transcript,
                  isFinal,
                  language: thisSegmentLang,
                  speaker: speaker !== null ? speaker + 1 : null, // Convert to 1-indexed
                })
              );

              // Accumulate final transcripts
              if (isFinal) {
                fullTranscript += transcript + ' ';
                if (session) session.transcript = fullTranscript;

                // Check if this segment is non-English (using per-segment language detection)
                const isNonEnglishLang =
                  thisSegmentLang && thisSegmentLang !== 'en' && !thisSegmentLang.startsWith('en');
                // prettier-ignore
                // eslint-disable-next-line no-misleading-character-class
                const hasNonEnglishChars = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u0900-\u097f\u0e00-\u0e7f\u0600-\u06ff]/.test(transcript);
                const needsTranslation = isNonEnglishLang || hasNonEnglishChars;

                // Translate non-English segments with buffering for better context
                if (needsTranslation && transcript.length >= 3) {
                  // Add to segment buffer with metadata
                  segmentBuffer.push({
                    text: transcript,
                    speaker: speaker,
                    lang: thisSegmentLang,
                  });

                  // Update domain detection with accumulated text
                  if (!detectedDomain) {
                    detectedDomain = detectMeetingDomain(fullTranscript);
                    if (session) session.detectedDomain = detectedDomain;
                  }

                  // Translate when buffer reaches threshold OR segment is long enough (for responsiveness)
                  const shouldTranslateNow =
                    segmentBuffer.length >= SEGMENT_BUFFER_SIZE ||
                    transcript.length > 50 || // Long segments translate immediately
                    /[。！？.!?]$/.test(transcript); // End of sentence

                  if (shouldTranslateNow && segmentBuffer.length > 0) {
                    try {
                      // Combine buffered segments for translation
                      const combinedText = segmentBuffer.map((s) => s.text).join(' ');
                      const primarySpeaker = segmentBuffer[0].speaker;
                      const primaryLang = segmentBuffer[0].lang;

                      // Translate with context
                      const translated = await translateText(combinedText, 'en', {
                        previousSegments: translationContext,
                        domain: detectedDomain,
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

                        ws.send(
                          JSON.stringify({
                            type: 'translation',
                            text: translated,
                            originalLang: primaryLang,
                            speaker: primarySpeaker !== null ? primarySpeaker + 1 : null,
                            fullTranslation: translatedTranscript,
                            domain: detectedDomain, // Include detected domain for UI
                          })
                        );
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
                      const combinedText = segmentBuffer.map((s) => s.text).join(' ');
                      const primarySpeaker = segmentBuffer[0].speaker;
                      const primaryLang = segmentBuffer[0].lang;

                      const translated = await translateText(combinedText, 'en', {
                        previousSegments: translationContext,
                        domain: detectedDomain,
                      });

                      if (translated !== combinedText) {
                        translatedTranscript += translated + ' ';
                        if (session) session.translatedTranscript = translatedTranscript;

                        translationContext.push(translated);
                        if (translationContext.length > MAX_CONTEXT_SEGMENTS) {
                          translationContext.shift();
                        }
                        if (session) session.translationContext = translationContext;

                        ws.send(
                          JSON.stringify({
                            type: 'translation',
                            text: translated,
                            originalLang: primaryLang,
                            speaker: primarySpeaker !== null ? primarySpeaker + 1 : null,
                            fullTranslation: translatedTranscript,
                            domain: detectedDomain,
                          })
                        );
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

                  ws.send(
                    JSON.stringify({
                      type: 'translation',
                      text: transcript,
                      originalLang: 'en',
                      speaker: speaker !== null ? speaker + 1 : null,
                      fullTranslation: translatedTranscript,
                      domain: detectedDomain,
                    })
                  );
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
              const combinedText = segmentBuffer.map((s) => s.text).join(' ');
              const primarySpeaker = segmentBuffer[0].speaker;
              const primaryLang = segmentBuffer[0].lang;

              const translated = await translateText(combinedText, 'en', {
                previousSegments: translationContext,
                domain: detectedDomain,
              });

              if (translated !== combinedText) {
                translatedTranscript += translated + ' ';
                if (session) session.translatedTranscript = translatedTranscript;

                ws.send(
                  JSON.stringify({
                    type: 'translation',
                    text: translated,
                    originalLang: primaryLang,
                    speaker: primarySpeaker !== null ? primarySpeaker + 1 : null,
                    fullTranslation: translatedTranscript,
                    domain: detectedDomain,
                  })
                );
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
          ws.send(
            JSON.stringify({
              type: 'complete',
              sessionId,
              transcript: fullTranscript.trim(),
              translatedTranscript: translatedTranscript.trim(),
              language: detectedLanguage,
              duration,
              r2Key: r2Key, // Only set if upload actually succeeded
            })
          );
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
            const currentSize = audioSession.audioChunks.reduce(
              (sum, chunk) => sum + chunk.length,
              0
            );
            if (currentSize < 100 * 1024 * 1024) {
              audioSession.audioChunks.push(message);
            } else {
              console.warn(
                `[WS] Session ${sessionId} audio limit reached (100MB), skipping chunk storage`
              );
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
    sessionTracker.finish({ status: 'completed', sessionId }).catch(() => {});
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
  }); // end trackingContext.run
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
    duration: Math.round((Date.now() - session.startTime.getTime()) / 1000),
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
    size: audioBuffer.length,
  });
});

// Download recording from R2
app.get('/api/recording/:r2Key(*)', async (req, res) => {
  const r2Key = sanitizePath(req.params.r2Key);

  if (!r2Key) {
    return res.status(400).json({ error: 'R2 key required' });
  }

  try {
    const audioBuffer = await downloadFromR2(r2Key);

    if (!audioBuffer) {
      return res.status(404).json({ error: 'Recording not found in R2' });
    }

    // Set headers for file download (sanitize filename for header injection prevention)
    const filename = (r2Key.split('/').pop() || 'recording.wav').replace(/["\r\n]/g, '');
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
    memorySize: 0,
  };

  if (session) {
    result.inMemory = session.audioChunks && session.audioChunks.length > 0;
    result.memorySize = result.inMemory ? Buffer.concat(session.audioChunks).length : 0;
    result.r2Key = session.r2Key || null;
    result.inR2 = !!session.r2Key;
  }

  res.json(result);
});
