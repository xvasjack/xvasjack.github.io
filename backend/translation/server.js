require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const JSZip = require('jszip');
const OpenAI = require('openai');

const {
  securityHeaders,
  rateLimiter,
  strictRateLimiter,
  isValidEmail,
  escapeHtml,
} = require('./shared/security');
const {
  requestLogger,
  healthCheck,
  errorHandler,
  notFoundHandler,
} = require('./shared/middleware');
const { setupGlobalErrorHandlers } = require('./shared/logging');
const { sendEmail } = require('./shared/email');
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
const JAPANESE_FONT_FAMILY = process.env.TRANSLATION_JA_FONT || 'Yu Gothic';
const JAPANESE_UNRESOLVED_GENERIC_RE = /\b(banking|transportation|financial services)\b/i;
const JAPANESE_GENERIC_TERM_OVERRIDES = [
  {
    pattern: /\bbanking\s*&\s*financial\s*services\b/gi,
    replacement: '銀行・金融サービス',
  },
  {
    pattern: /\bairports?\s*&\s*transportation\b/gi,
    replacement: '空港・交通',
  },
  {
    pattern: /\bfinance\s*(?:and|&)\s*banking\b/gi,
    replacement: '金融・銀行',
  },
  {
    pattern: /\bfinancial\s*services\b/gi,
    replacement: '金融サービス',
  },
  {
    pattern: /\btransportation\b/gi,
    replacement: '交通',
  },
  {
    pattern: /\bbanking\b/gi,
    replacement: '銀行',
  },
];

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    'OPENAI_API_KEY is not set - translation endpoint will fail until this is configured'
  );
}
if (!process.env.SENDGRID_API_KEY || !process.env.SENDER_EMAIL) {
  console.warn(
    'SENDGRID_API_KEY or SENDER_EMAIL is not set - email delivery will fail until these are configured'
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

function buildTranslationEmailHtml(payload) {
  const { originalFilename, outputFilename, targetLanguage, sourceLanguage, includeNotes, stats } =
    payload;
  return `
  <div style="font-family: Calibri, Arial, sans-serif; max-width: 780px; margin: 0 auto;">
    <h2 style="color: #1f2937; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">PowerPoint Translation Complete</h2>
    <p style="color: #374151;">Your translated PowerPoint is attached to this email.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 14px 0;">
      <tr><td style="padding: 6px 0; color: #6b7280; width: 170px;">Original file</td><td style="padding: 6px 0; color: #111827;"><strong>${escapeHtml(originalFilename)}</strong></td></tr>
      <tr><td style="padding: 6px 0; color: #6b7280;">Translated file</td><td style="padding: 6px 0; color: #111827;"><strong>${escapeHtml(outputFilename)}</strong></td></tr>
      <tr><td style="padding: 6px 0; color: #6b7280;">Target language</td><td style="padding: 6px 0; color: #111827;">${escapeHtml(targetLanguage)}</td></tr>
      <tr><td style="padding: 6px 0; color: #6b7280;">Source language</td><td style="padding: 6px 0; color: #111827;">${escapeHtml(sourceLanguage)}</td></tr>
      <tr><td style="padding: 6px 0; color: #6b7280;">Include notes</td><td style="padding: 6px 0; color: #111827;">${includeNotes ? 'Yes' : 'No'}</td></tr>
    </table>
    <hr style="border: 1px solid #e5e7eb; margin: 20px 0;">
    <p style="color: #374151; margin: 0;">Updated <strong>${stats.changedSegments}</strong> text segments across <strong>${stats.changedParts}</strong> PPT parts.</p>
    ${
      stats.fontChangedParts
        ? `<p style="color: #374151; margin: 8px 0 0 0;">Applied <strong>Yu Gothic</strong> font normalization on <strong>${stats.fontChangedParts}</strong> PPT parts.</p>`
        : ''
    }
    <p style="color: #9ca3af; font-size: 12px; margin-top: 22px;">Generated by YCP Translation Tool</p>
  </div>
  `;
}

function isJapaneseLanguage(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return (
    normalized === 'ja' ||
    normalized === 'jp' ||
    normalized.includes('japanese') ||
    normalized.includes('日本')
  );
}

function normalizeLooseText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function applyJapaneseTerminologyOverrides(value) {
  let text = String(value == null ? '' : value);
  if (!text) return text;

  for (const rule of JAPANESE_GENERIC_TERM_OVERRIDES) {
    text = text.replace(rule.pattern, rule.replacement);
  }

  return text;
}

function collectJapaneseRetryCandidates(uniqueTexts, translationMap) {
  const retryCandidates = [];

  for (const sourceText of uniqueTexts) {
    if (!JAPANESE_UNRESOLVED_GENERIC_RE.test(sourceText)) {
      continue;
    }

    const translated = String(translationMap.get(sourceText) || '');
    if (!translated) {
      retryCandidates.push(sourceText);
      continue;
    }

    const sourceNormalized = normalizeLooseText(sourceText).toLowerCase();
    const translatedNormalized = normalizeLooseText(translated).toLowerCase();

    const unchanged = sourceNormalized === translatedNormalized;
    const stillContainsEnglishGeneric = JAPANESE_UNRESOLVED_GENERIC_RE.test(translated);
    if (unchanged || stillContainsEnglishGeneric) {
      retryCandidates.push(sourceText);
    }
  }

  return retryCandidates;
}

function applyJapaneseTextConventions(value) {
  let text = String(value == null ? '' : value);
  if (!text) return text;

  const hqLabelMatch = text.match(/^(\s*)本社(\s*[:：]?\s*)$/u);
  if (hqLabelMatch) {
    text = `${hqLabelMatch[1]}本社所在地${hqLabelMatch[2]}`;
  }

  text = text.replace(/\bHQ\b/gi, '本社所在地');
  text = text.replace(/\bHeadquarters\b/gi, '本社所在地');
  text = applyJapaneseTerminologyOverrides(text);

  if (/^\s*(Es\.?\s*Year|Est\.?\s*Year)\s*$/i.test(text)) {
    text = '設立年';
  }

  const trimmed = text.trim();
  if (/^(?:19|20)\d{2}$/.test(trimmed)) {
    text = `${trimmed}年`;
  }

  if (/(Es\.?\s*Year|Est\.?\s*Year|設立年|創業年)/i.test(text)) {
    text = text.replace(/\b((?:19|20)\d{2})\b(?!\s*年)/g, '$1年');
  }

  return text;
}

function applyLanguageConventions(value, targetLanguage) {
  const text = String(value == null ? '' : value);
  if (!isJapaneseLanguage(targetLanguage)) {
    return text;
  }
  return applyJapaneseTextConventions(text);
}

function isPptXmlPart(partPath) {
  return /^ppt\/.+\.xml$/i.test(partPath);
}

function normalizeTypefaceAttributes(xml, fontFamily) {
  const safeFont = String(fontFamily || 'Yu Gothic')
    .replace(/["']/g, '')
    .trim()
    .slice(0, 80);
  const resolvedFont = safeFont || 'Yu Gothic';
  return String(xml || '')
    .replace(/typeface="[^"]*"/gi, `typeface="${resolvedFont}"`)
    .replace(/typeface='[^']*'/gi, `typeface='${resolvedFont}'`);
}

function maskTypefaceAttributes(xml) {
  return String(xml || '')
    .replace(/typeface="[^"]*"/gi, 'typeface="__FONT__"')
    .replace(/typeface='[^']*'/gi, "typeface='__FONT__'");
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

function buildSystemPrompt(targetLanguage, sourceLanguage, glossary, options = {}) {
  const { forceTranslate = false } = options;
  const glossarySection = glossary
    ? `\nGlossary and preferred terms (must be applied whenever relevant):\n${glossary}`
    : '';
  const strictJapaneseSection =
    isJapaneseLanguage(targetLanguage) && forceTranslate
      ? '\nStrict retry mode:\n- Do not leave generic English business terms untranslated (e.g., Banking, Transportation, Financial Services).\n- Keep English only for brand names, legal entity names, product names, acronyms, URLs/emails, or placeholders.'
      : '';
  const japaneseSection = isJapaneseLanguage(targetLanguage)
    ? '\nJapanese-specific rules:\n- Translate "HQ" as "本社所在地" (do not use "本社" as the standalone label).\n- For establishment year labels such as "Es. Year", use a year suffix like "1995年".\n- Keep terminology concise and business-appropriate.'
    : '';

  return [
    'You are translating text extracted from a PowerPoint file.',
    `Target language: ${targetLanguage}.`,
    `Source language: ${sourceLanguage}.`,
    'Critical rules:',
    '- Preserve meaning, tone, and business intent.',
    '- Keep numbers, currency, percentages, dates, URLs, and email addresses unchanged unless target-language formatting requires it.',
    '- Preserve placeholders and tokens such as {name}, [value], %s, and <tag> exactly.',
    '- Return only JSON. No markdown, no commentary.',
    glossarySection,
    japaneseSection,
    strictJapaneseSection,
  ].join('\n');
}

function buildUserPrompt(batch, options = {}) {
  const { targetLanguage, forceTranslate = false } = options;
  const unchangedRule =
    isJapaneseLanguage(targetLanguage) || forceTranslate
      ? 'Only keep an item unchanged when it is a company/product/proper noun, acronym, URL/email, placeholder, or already target-language text.'
      : 'If an item should remain unchanged, return it unchanged in the corresponding index.';

  return [
    'Translate every item in the array and keep the same order.',
    `Return exactly this shape: {"translations":["...","..."]} with ${batch.length} items.`,
    unchangedRule,
    'Input:',
    JSON.stringify(batch),
  ].join('\n\n');
}

async function translateBatch(batch, options) {
  const { targetLanguage, sourceLanguage, glossary, model, forceTranslate = false } = options;

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
            content: buildSystemPrompt(targetLanguage, sourceLanguage, glossary, {
              forceTranslate,
            }),
          },
          {
            role: 'user',
            content: buildUserPrompt(batch, {
              targetLanguage,
              forceTranslate,
            }),
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

function applyTranslationsToXml(xml, segments, translationMap, options) {
  const { targetLanguage } = options;
  let changedSegments = 0;

  const translatedXml = rewriteXmlBySegments(xml, segments, (segment) => {
    let translatedCore = translationMap.has(segment.core)
      ? translationMap.get(segment.core)
      : segment.core;
    translatedCore = applyLanguageConventions(translatedCore, targetLanguage);

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

async function enforcePptxFontFamily(zip, fontFamily) {
  const changedParts = new Set();
  const partNames = getPartNames(zip);

  for (const part of partNames) {
    if (!isPptXmlPart(part)) continue;
    const file = zip.file(part);
    if (!file) continue;

    const originalXml = await file.async('string');
    if (!/typeface\s*=/.test(originalXml)) continue;

    const normalizedXml = normalizeTypefaceAttributes(originalXml, fontFamily);
    if (normalizedXml !== originalXml) {
      zip.file(part, normalizedXml);
      changedParts.add(part);
    }
  }

  return changedParts;
}

async function verifyTextOnlyInvariants(inputBuffer, outputBuffer, editedParts, options = {}) {
  const { allowTypefaceChanges = false } = options;
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

    const beforeMaskedText = maskEditableText(beforeXml, part);
    const afterMaskedText = maskEditableText(afterXml, part);
    const beforeMasked = allowTypefaceChanges
      ? maskTypefaceAttributes(beforeMaskedText)
      : beforeMaskedText;
    const afterMasked = allowTypefaceChanges
      ? maskTypefaceAttributes(afterMaskedText)
      : afterMaskedText;

    if (beforeMasked !== afterMasked) {
      const driftType = allowTypefaceChanges ? 'non-text/non-font' : 'non-text';
      throw new Error(`Invariant failed: ${driftType} structure drift detected in ${part}`);
    }
  }
}

async function translatePptxBuffer(inputBuffer, options) {
  const { includeNotes, targetLanguage } = options;
  const enforceJapaneseFont = isJapaneseLanguage(targetLanguage);
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
    const segments = collectEditableSegments(xml, part, { translatableOnly: false });
    if (segments.length === 0) continue;

    partSegments.set(part, segments);

    for (const segment of segments) {
      if (!segment.translatable) continue;
      translatableSegmentCount += 1;
      uniqueTexts.add(segment.core);
    }
  }

  if (translatableSegmentCount > MAX_TRANSLATABLE_SEGMENTS) {
    throw new Error(
      `Too many translatable segments (${translatableSegmentCount}). Please split the file into smaller decks.`
    );
  }

  if (translatableSegmentCount === 0 && !enforceJapaneseFont) {
    return {
      buffer: inputBuffer,
      stats: {
        editableParts: editableXml.size,
        translatableSegments: 0,
        uniqueTexts: 0,
        changedParts: 0,
        changedSegments: 0,
        batches: 0,
        fontChangedParts: 0,
        strictRetryCandidates: 0,
        strictRetryBatches: 0,
      },
    };
  }

  const uniqueTextList = Array.from(uniqueTexts);
  let translationMap = new Map();
  let batchCount = 0;
  let strictRetryCandidates = 0;
  let strictRetryBatches = 0;
  if (uniqueTextList.length > 0) {
    const translated = await translateUniqueTexts(uniqueTextList, options);
    translationMap = translated.translationMap;
    batchCount = translated.batchCount;

    if (isJapaneseLanguage(targetLanguage)) {
      const retryCandidates = collectJapaneseRetryCandidates(uniqueTextList, translationMap);
      strictRetryCandidates = retryCandidates.length;

      if (retryCandidates.length > 0) {
        console.log(
          `[translatePptxBuffer] strict JP retry for ${retryCandidates.length} unresolved generic terms`
        );

        const strictRetryResult = await translateUniqueTexts(retryCandidates, {
          ...options,
          forceTranslate: true,
        });
        strictRetryBatches = strictRetryResult.batchCount;

        for (const sourceText of retryCandidates) {
          if (strictRetryResult.translationMap.has(sourceText)) {
            translationMap.set(sourceText, strictRetryResult.translationMap.get(sourceText));
          }
        }
      }
    }
  }

  const editedParts = new Map();
  let changedSegments = 0;

  for (const [part, segments] of partSegments.entries()) {
    const originalXml = editableXml.get(part);
    const applied = applyTranslationsToXml(originalXml, segments, translationMap, {
      targetLanguage,
    });

    if (applied.xml !== originalXml) {
      zip.file(part, applied.xml);
      editedParts.set(part, { changedSegments: applied.changedSegments });
      changedSegments += applied.changedSegments;
    }
  }

  let fontChangedParts = 0;
  if (enforceJapaneseFont) {
    const fontChanged = await enforcePptxFontFamily(zip, JAPANESE_FONT_FAMILY);
    fontChangedParts = fontChanged.size;

    for (const part of fontChanged) {
      if (!editedParts.has(part)) {
        editedParts.set(part, { changedSegments: 0, fontChanged: true });
        continue;
      }
      const current = editedParts.get(part);
      current.fontChanged = true;
      editedParts.set(part, current);
    }
  }

  const outputBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  await verifyTextOnlyInvariants(inputBuffer, outputBuffer, editedParts, {
    allowTypefaceChanges: enforceJapaneseFont,
  });

  return {
    buffer: outputBuffer,
    stats: {
      editableParts: editableXml.size,
      translatableSegments: translatableSegmentCount,
      uniqueTexts: uniqueTextList.length,
      changedParts: editedParts.size,
      changedSegments,
      batches: batchCount,
      fontChangedParts,
      strictRetryCandidates,
      strictRetryBatches,
    },
  };
}

app.get('/api/ppt-translate/options', (_req, res) => {
  res.json({
    success: true,
    defaults: {
      model: DEFAULT_MODEL,
      includeNotes: false,
      japaneseFontFamily: JAPANESE_FONT_FAMILY,
      delivery: 'email',
    },
    limits: {
      maxFileSizeMB: 50,
      maxSegments: MAX_TRANSLATABLE_SEGMENTS,
    },
    requiresEmail: true,
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
    if (!process.env.SENDGRID_API_KEY || !process.env.SENDER_EMAIL) {
      return res.status(500).json({
        success: false,
        error: 'Email delivery is not configured (SENDGRID_API_KEY/SENDER_EMAIL)',
      });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'pptxFile is required' });
    }

    if (!/\.pptx$/i.test(req.file.originalname || '')) {
      return res.status(400).json({ success: false, error: 'Only .pptx files are supported' });
    }

    const recipientEmail = String(req.body.email || req.body.Email || '')
      .trim()
      .slice(0, 320);
    if (!isValidEmail(recipientEmail)) {
      return res.status(400).json({ success: false, error: 'A valid email is required' });
    }

    const targetLanguage = sanitizeLanguage(req.body.targetLanguage, 'English');
    const sourceLanguage = sanitizeLanguage(req.body.sourceLanguage, 'auto');
    const glossary =
      typeof req.body.glossary === 'string' ? req.body.glossary.trim().slice(0, 4000) : '';
    const includeNotes = parseBoolean(req.body.includeNotes, false);
    const model = sanitizeLanguage(req.body.model, DEFAULT_MODEL);

    console.log(
      `[ppt-translate] file=${req.file.originalname} size=${req.file.size} target=${targetLanguage} source=${sourceLanguage} includeNotes=${includeNotes} email=${recipientEmail}`
    );

    const translated = await translatePptxBuffer(req.file.buffer, {
      targetLanguage,
      sourceLanguage,
      glossary,
      includeNotes,
      model,
    });

    const outputFilename = safeOutputFilename(req.file.originalname, targetLanguage);

    await sendEmail({
      to: recipientEmail,
      subject: `Translated PPT: ${path.basename(req.file.originalname || 'presentation.pptx')}`,
      html: buildTranslationEmailHtml({
        originalFilename: req.file.originalname || 'presentation.pptx',
        outputFilename,
        targetLanguage,
        sourceLanguage,
        includeNotes,
        stats: translated.stats,
      }),
      attachments: [
        {
          filename: outputFilename,
          content: translated.buffer.toString('base64'),
          type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        },
      ],
      fromName: 'YCP Translation',
    });

    console.log(
      `[ppt-translate] completed in ${Date.now() - startedAt}ms changedParts=${translated.stats.changedParts} changedSegments=${translated.stats.changedSegments} fontChangedParts=${translated.stats.fontChangedParts || 0} strictRetryCandidates=${translated.stats.strictRetryCandidates || 0} strictRetryBatches=${translated.stats.strictRetryBatches || 0} emailedTo=${recipientEmail}`
    );

    return res.json({
      success: true,
      message: `Translation complete. The PPTX has been emailed to ${recipientEmail}.`,
      email: recipientEmail,
      filename: outputFilename,
      stats: translated.stats,
    });
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
