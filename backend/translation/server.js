require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const JSZip = require('jszip');
const OpenAI = require('openai');

const { securityHeaders, rateLimiter, strictRateLimiter } = require('./shared/security');
const {
  requestLogger,
  healthCheck,
  errorHandler,
  notFoundHandler,
} = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { extractJSON } = require('./shared/ai-models');

setupGlobalErrorHandlers();

const app = express();
app.use(securityHeaders);
app.use(rateLimiter);
app.use(cors());
app.use(requestLogger);
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'missing',
});

const SLIDE_XML_RE = /^ppt\/slides\/slide\d+\.xml$/i;
const CHART_XML_RE = /^ppt\/charts\/chart\d+\.xml$/i;
const NOTES_XML_RE = /^ppt\/notesSlides\/notesSlide\d+\.xml$/i;

const DEFAULT_MODEL = process.env.TRANSLATION_MODEL || 'gpt-5.1';
const MAX_BATCH_ITEMS = Number(process.env.TRANSLATION_BATCH_ITEMS || 35);
const MAX_BATCH_CHARS = Number(process.env.TRANSLATION_BATCH_CHARS || 9000);
const MAX_TRANSLATION_RETRIES = Number(process.env.TRANSLATION_RETRIES || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.TRANSLATION_RETRY_BASE_MS || 10000);
const MAX_TRANSLATABLE_SEGMENTS = Number(process.env.TRANSLATION_MAX_SEGMENTS || 10000);

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    'OPENAI_API_KEY is not set - translation endpoint will fail until this is configured'
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getPartNames(zip) {
  return Object.keys(zip.files)
    .filter((part) => !zip.files[part].dir)
    .sort();
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isSlideXml(partPath) {
  return SLIDE_XML_RE.test(partPath);
}

function isChartXml(partPath) {
  return CHART_XML_RE.test(partPath);
}

function isNotesXml(partPath) {
  return NOTES_XML_RE.test(partPath);
}

function isEditableXmlPart(partPath, includeNotes) {
  if (isSlideXml(partPath) || isChartXml(partPath)) return true;
  if (includeNotes && isNotesXml(partPath)) return true;
  return false;
}

function decodeXmlText(value) {
  if (typeof value !== 'string' || !value) return '';
  const toCodePoint = (num) => {
    if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return '';
    try {
      return String.fromCodePoint(num);
    } catch {
      return '';
    }
  };

  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => toCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => toCodePoint(parseInt(dec, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function isValidXmlCodePoint(codePoint) {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function stripInvalidXmlChars(text) {
  if (typeof text !== 'string' || !text) return '';
  let cleaned = '';
  for (const ch of text) {
    if (isValidXmlCodePoint(ch.codePointAt(0))) {
      cleaned += ch;
    }
  }
  return cleaned;
}

function encodeXmlText(value) {
  return stripInvalidXmlChars(String(value || ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isInsideTag(xml, index, tagName) {
  const openTag = `<${tagName}`;
  const closeTag = `</${tagName}>`;

  const openPos = xml.lastIndexOf(openTag, index);
  if (openPos === -1) return false;

  const closePos = xml.lastIndexOf(closeTag, index);
  return closePos < openPos;
}

function sanitizeLanguage(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 80);
}

function toLanguageSlug(value) {
  return String(value || 'translated')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function safeOutputFilename(originalName, targetLanguage) {
  const basename = path
    .basename(originalName || 'translated.pptx')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const stem = basename.replace(/\.pptx$/i, '') || 'translated';
  const lang = toLanguageSlug(targetLanguage || 'translated') || 'translated';
  return `${stem}.${lang}.pptx`;
}

function analyzeTextForTranslation(text) {
  const raw = String(text || '');
  const leadingMatch = raw.match(/^\s*/);
  const trailingMatch = raw.match(/\s*$/);
  const leading = leadingMatch ? leadingMatch[0] : '';
  const trailing = trailingMatch ? trailingMatch[0] : '';
  const core = raw.slice(leading.length, raw.length - trailing.length);
  return { raw, leading, core, trailing };
}

function shouldTranslateCoreText(core) {
  const text = String(core || '').trim();
  if (!text) return false;
  if (!/\p{L}/u.test(text)) return false;
  if (/^(https?:\/\/|www\.)/i.test(text)) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return false;
  if (/^\{[^{}]+\}$/.test(text)) return false;
  if (/^<[^>]+>$/.test(text)) return false;
  return true;
}

function createSegment(match, encoded, tagStart, xml, kind, translatableOnly) {
  if (kind === 'a:t' && isInsideTag(xml, tagStart, 'a:fld')) {
    return null;
  }

  const contentStart = tagStart + match.indexOf('>') + 1;
  const contentEnd = contentStart + encoded.length;
  const decoded = decodeXmlText(encoded);
  const { leading, core, trailing } = analyzeTextForTranslation(decoded);
  const translatable = shouldTranslateCoreText(core);

  if (translatableOnly && !translatable) {
    return null;
  }

  return {
    kind,
    start: contentStart,
    end: contentEnd,
    encoded,
    decoded,
    leading,
    core,
    trailing,
    translatable,
  };
}

function extractATextSegments(xml, translatableOnly) {
  const segments = [];
  const regex = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let match;

  while ((match = regex.exec(xml)) !== null) {
    const encoded = match[1] || '';
    const segment = createSegment(match[0], encoded, match.index, xml, 'a:t', translatableOnly);
    if (segment) segments.push(segment);
  }

  return segments;
}

function extractChartStringCacheSegments(xml, translatableOnly) {
  const segments = [];
  const regex = /<c:v>([\s\S]*?)<\/c:v>/g;
  let match;

  while ((match = regex.exec(xml)) !== null) {
    if (!isInsideTag(xml, match.index, 'c:strCache')) continue;
    if (isInsideTag(xml, match.index, 'c:numCache')) continue;

    const encoded = match[1] || '';
    const segment = createSegment(match[0], encoded, match.index, xml, 'c:v', translatableOnly);
    if (segment) segments.push(segment);
  }

  return segments;
}

function collectEditableSegments(xml, partPath, options) {
  const { translatableOnly } = options;
  const segments = [];

  segments.push(...extractATextSegments(xml, translatableOnly));

  if (isChartXml(partPath)) {
    segments.push(...extractChartStringCacheSegments(xml, translatableOnly));
  }

  segments.sort((a, b) => a.start - b.start);

  // Non-overlap guard to keep rewrites deterministic.
  const nonOverlapping = [];
  let lastEnd = -1;
  for (const segment of segments) {
    if (segment.start < lastEnd) continue;
    nonOverlapping.push(segment);
    lastEnd = segment.end;
  }

  return nonOverlapping;
}

function rewriteXmlBySegments(xml, segments, replacer) {
  let cursor = 0;
  let out = '';

  for (const segment of segments) {
    out += xml.slice(cursor, segment.start);
    out += replacer(segment);
    cursor = segment.end;
  }

  out += xml.slice(cursor);
  return out;
}

function maskEditableText(xml, partPath) {
  const segments = collectEditableSegments(xml, partPath, { translatableOnly: false });
  return rewriteXmlBySegments(xml, segments, () => '__TEXT__');
}

function createBatches(items, maxItems, maxChars) {
  const batches = [];
  let current = [];
  let chars = 0;

  for (const item of items) {
    const itemSize = item.length;

    if (current.length > 0 && (current.length >= maxItems || chars + itemSize > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }

    current.push(item);
    chars += itemSize;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

function parseTranslationsResponse(rawContent, expectedLength) {
  const parsed = extractJSON(rawContent);
  if (!parsed) {
    throw new Error('Model response did not contain valid JSON');
  }

  let translations = null;

  if (Array.isArray(parsed)) {
    translations = parsed;
  } else if (Array.isArray(parsed.translations)) {
    translations = parsed.translations;
  }

  if (!Array.isArray(translations) || translations.length !== expectedLength) {
    throw new Error('Model response translation count mismatch');
  }

  return translations.map((value) => String(value == null ? '' : value));
}

function buildSystemPrompt(targetLanguage, sourceLanguage, glossary) {
  const glossarySection = glossary
    ? `\nGlossary and preferred terms (must be applied whenever relevant):\n${glossary}`
    : '';

  return [
    'You are translating text extracted from a PowerPoint file.',
    `Target language: ${targetLanguage}.`,
    `Source language: ${sourceLanguage}.`,
    'Critical rules:',
    '- Preserve meaning, tone, and business intent.',
    '- Keep numbers, currency, percentages, dates, URLs, and email addresses unchanged.',
    '- Preserve placeholders and tokens such as {name}, [value], %s, and <tag> exactly.',
    '- Return only JSON. No markdown, no commentary.',
    glossarySection,
  ].join('\n');
}

function buildUserPrompt(batch) {
  return [
    'Translate every item in the array and keep the same order.',
    `Return exactly this shape: {"translations":["...","..."]} with ${batch.length} items.`,
    'If an item should remain unchanged, return it unchanged in the corresponding index.',
    'Input:',
    JSON.stringify(batch),
  ].join('\n\n');
}

async function translateBatch(batch, options) {
  const { targetLanguage, sourceLanguage, glossary, model } = options;

  let attempt = 0;
  let delayMs = RETRY_BASE_DELAY_MS;
  let lastError = null;

  while (attempt < MAX_TRANSLATION_RETRIES) {
    attempt += 1;

    try {
      const response = await openai.chat.completions.create({
        model,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt(targetLanguage, sourceLanguage, glossary),
          },
          {
            role: 'user',
            content: buildUserPrompt(batch),
          },
        ],
      });

      const content = String(response?.choices?.[0]?.message?.content || '').trim();
      const translated = parseTranslationsResponse(content, batch.length);
      return translated;
    } catch (error) {
      lastError = error;
      const status = error?.status || error?.statusCode;
      const isRetryable = !status || status >= 500 || status === 429;
      const reachedMax = attempt >= MAX_TRANSLATION_RETRIES;

      console.error(
        `[translateBatch] Attempt ${attempt}/${MAX_TRANSLATION_RETRIES} failed: ${error.message}`
      );

      if (!isRetryable || reachedMax) {
        break;
      }

      console.log(`[translateBatch] Backing off for ${delayMs}ms before retry`);
      await sleep(delayMs);
      delayMs *= 2;
    }
  }

  throw lastError || new Error('Translation batch failed');
}

async function translateUniqueTexts(uniqueTexts, options) {
  const batches = createBatches(uniqueTexts, MAX_BATCH_ITEMS, MAX_BATCH_CHARS);
  const translationMap = new Map();

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`[translateUniqueTexts] Translating batch ${i + 1}/${batches.length}`);

    const translated = await translateBatch(batch, options);
    for (let j = 0; j < batch.length; j++) {
      translationMap.set(batch[j], translated[j]);
    }
  }

  return { translationMap, batchCount: batches.length };
}

function applyTranslationsToXml(xml, segments, translationMap) {
  let changedSegments = 0;

  const translatedXml = rewriteXmlBySegments(xml, segments, (segment) => {
    const translatedCore = translationMap.has(segment.core)
      ? translationMap.get(segment.core)
      : segment.core;

    const mergedDecoded = `${segment.leading}${translatedCore}${segment.trailing}`;
    if (mergedDecoded === segment.decoded) {
      return segment.encoded;
    }

    const encoded = encodeXmlText(mergedDecoded);

    if (encoded !== segment.encoded) {
      changedSegments += 1;
    }

    return encoded;
  });

  return {
    xml: translatedXml,
    changedSegments,
  };
}

async function verifyTextOnlyInvariants(inputBuffer, outputBuffer, editedParts) {
  const beforeZip = await JSZip.loadAsync(inputBuffer);
  const afterZip = await JSZip.loadAsync(outputBuffer);

  const beforeParts = getPartNames(beforeZip);
  const afterParts = getPartNames(afterZip);

  if (!arraysEqual(beforeParts, afterParts)) {
    throw new Error('Invariant failed: package part list changed');
  }

  const changedParts = [];

  for (const part of beforeParts) {
    const beforeFile = beforeZip.file(part);
    const afterFile = afterZip.file(part);
    if (!beforeFile || !afterFile) {
      throw new Error(`Invariant failed: missing part during verification (${part})`);
    }

    const beforeBuffer = await beforeFile.async('nodebuffer');
    const afterBuffer = await afterFile.async('nodebuffer');

    if (hashBuffer(beforeBuffer) !== hashBuffer(afterBuffer)) {
      changedParts.push(part);
    }
  }

  const expectedChanged = Array.from(editedParts.keys()).sort();
  const actualChanged = changedParts.sort();

  if (!arraysEqual(expectedChanged, actualChanged)) {
    throw new Error(
      `Invariant failed: unexpected changed parts. expected=${expectedChanged.join(',')} actual=${actualChanged.join(',')}`
    );
  }

  for (const part of actualChanged) {
    const beforeXml = await beforeZip.file(part).async('string');
    const afterXml = await afterZip.file(part).async('string');

    const beforeMasked = maskEditableText(beforeXml, part);
    const afterMasked = maskEditableText(afterXml, part);

    if (beforeMasked !== afterMasked) {
      throw new Error(`Invariant failed: non-text structure drift detected in ${part}`);
    }
  }
}

async function translatePptxBuffer(inputBuffer, options) {
  const { includeNotes } = options;
  const zip = await JSZip.loadAsync(inputBuffer);
  const partNames = getPartNames(zip);

  const editableXml = new Map();
  for (const part of partNames) {
    if (!isEditableXmlPart(part, includeNotes)) continue;
    const file = zip.file(part);
    if (!file) continue;
    editableXml.set(part, await file.async('string'));
  }

  const partSegments = new Map();
  const uniqueTexts = new Set();
  let translatableSegmentCount = 0;

  for (const [part, xml] of editableXml.entries()) {
    const segments = collectEditableSegments(xml, part, { translatableOnly: true });
    if (segments.length === 0) continue;

    partSegments.set(part, segments);
    translatableSegmentCount += segments.length;

    for (const segment of segments) {
      uniqueTexts.add(segment.core);
    }
  }

  if (translatableSegmentCount > MAX_TRANSLATABLE_SEGMENTS) {
    throw new Error(
      `Too many translatable segments (${translatableSegmentCount}). Please split the file into smaller decks.`
    );
  }

  if (translatableSegmentCount === 0) {
    return {
      buffer: inputBuffer,
      stats: {
        editableParts: editableXml.size,
        translatableSegments: 0,
        uniqueTexts: 0,
        changedParts: 0,
        changedSegments: 0,
        batches: 0,
      },
    };
  }

  const uniqueTextList = Array.from(uniqueTexts);
  const { translationMap, batchCount } = await translateUniqueTexts(uniqueTextList, options);

  const editedParts = new Map();
  let changedSegments = 0;

  for (const [part, segments] of partSegments.entries()) {
    const originalXml = editableXml.get(part);
    const applied = applyTranslationsToXml(originalXml, segments, translationMap);

    if (applied.xml !== originalXml) {
      zip.file(part, applied.xml);
      editedParts.set(part, { changedSegments: applied.changedSegments });
      changedSegments += applied.changedSegments;
    }
  }

  const outputBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  await verifyTextOnlyInvariants(inputBuffer, outputBuffer, editedParts);

  return {
    buffer: outputBuffer,
    stats: {
      editableParts: editableXml.size,
      translatableSegments: translatableSegmentCount,
      uniqueTexts: uniqueTextList.length,
      changedParts: editedParts.size,
      changedSegments,
      batches: batchCount,
    },
  };
}

app.get('/api/ppt-translate/options', (_req, res) => {
  res.json({
    success: true,
    defaults: {
      model: DEFAULT_MODEL,
      includeNotes: false,
    },
    limits: {
      maxFileSizeMB: 50,
      maxSegments: MAX_TRANSLATABLE_SEGMENTS,
    },
  });
});

app.post('/api/ppt-translate', strictRateLimiter, upload.single('pptxFile'), async (req, res) => {
  const startedAt = Date.now();

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'OPENAI_API_KEY is not configured',
      });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'pptxFile is required' });
    }

    if (!/\.pptx$/i.test(req.file.originalname || '')) {
      return res.status(400).json({ success: false, error: 'Only .pptx files are supported' });
    }

    const targetLanguage = sanitizeLanguage(req.body.targetLanguage, 'English');
    const sourceLanguage = sanitizeLanguage(req.body.sourceLanguage, 'auto');
    const glossary =
      typeof req.body.glossary === 'string' ? req.body.glossary.trim().slice(0, 4000) : '';
    const includeNotes = parseBoolean(req.body.includeNotes, false);
    const model = sanitizeLanguage(req.body.model, DEFAULT_MODEL);

    console.log(
      `[ppt-translate] file=${req.file.originalname} size=${req.file.size} target=${targetLanguage} source=${sourceLanguage} includeNotes=${includeNotes}`
    );

    const translated = await translatePptxBuffer(req.file.buffer, {
      targetLanguage,
      sourceLanguage,
      glossary,
      includeNotes,
      model,
    });

    const outputFilename = safeOutputFilename(req.file.originalname, targetLanguage);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Content-Length', translated.buffer.length);
    res.setHeader('X-Translation-Changed-Parts', String(translated.stats.changedParts));
    res.setHeader('X-Translation-Changed-Segments', String(translated.stats.changedSegments));
    res.setHeader('X-Translation-Batches', String(translated.stats.batches));

    console.log(
      `[ppt-translate] completed in ${Date.now() - startedAt}ms changedParts=${translated.stats.changedParts} changedSegments=${translated.stats.changedSegments}`
    );

    return res.send(translated.buffer);
  } catch (error) {
    console.error('[ppt-translate] error:', error.message);
    console.error(error.stack);

    return res.status(500).json({
      success: false,
      error: 'Translation failed',
      details: error.message,
    });
  }
});

app.get('/health', healthCheck('translation'));

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'translation' });
});

app.use((err, _req, res, next) => {
  if (err && err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds 50MB limit' : err.message;
    return res.status(400).json({ success: false, error: message });
  }
  return next(err);
});

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Translation server running on port ${PORT}`);
});
