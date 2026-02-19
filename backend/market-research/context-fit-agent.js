const { callGemini } = require('./ai-clients');

const MODE_FALSE_RE = /^(0|false|no|off)$/i;

function normalizeToken(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeTokens(tokens) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(tokens) ? tokens : []) {
    const tok = normalizeToken(raw);
    if (!tok) continue;
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tok);
  }
  return out;
}

function splitSentences(text) {
  const raw = normalizeToken(text);
  if (!raw) return [];
  return raw
    .split(/(?<=[.!?;:])\s+/)
    .map((s) => normalizeToken(s))
    .filter(Boolean);
}

function compressTextToLimit(text, maxChars = 360) {
  const raw = normalizeToken(text);
  if (!raw) return '';
  if (raw.length <= maxChars) return raw;
  const sentences = splitSentences(raw);
  if (sentences.length === 0) return raw.slice(0, Math.max(24, maxChars - 3)).trim() + '...';
  let out = '';
  for (const sentence of sentences) {
    const candidate = out ? `${out} ${sentence}` : sentence;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  if (!out) return raw.slice(0, Math.max(24, maxChars - 3)).trim() + '...';
  if (out.length < raw.length) return `${out}...`;
  return out;
}

function looksLikeTitle(token) {
  const t = normalizeToken(token);
  if (!t) return false;
  if (t.length > 220) return false;
  if (/^source\s*:/i.test(t)) return false;
  if (/^(table of contents|appendix)$/i.test(t)) return true;
  if (/[A-Za-z].*[-:–].*[A-Za-z]/.test(t)) return true;
  if (t.length >= 16 && t.length <= 140 && /^[A-Z0-9]/.test(t)) return true;
  return false;
}

function splitLongToken(token, chunkLimit) {
  const t = normalizeToken(token);
  if (!t) return [];
  if (t.length <= chunkLimit) return [t];
  const sentences = splitSentences(t);
  if (sentences.length <= 1) {
    const chunks = [];
    let cursor = 0;
    while (cursor < t.length) {
      chunks.push(t.slice(cursor, cursor + chunkLimit).trim());
      cursor += chunkLimit;
    }
    return chunks.filter(Boolean);
  }
  const chunks = [];
  let acc = '';
  for (const sentence of sentences) {
    const next = acc ? `${acc} ${sentence}` : sentence;
    if (next.length > chunkLimit && acc) {
      chunks.push(acc);
      acc = sentence;
    } else {
      acc = next;
    }
  }
  if (acc) chunks.push(acc);
  return chunks.filter(Boolean);
}

function fillBodySlotsBalanced(parts, slotCount, startIdx, slots) {
  if (!Array.isArray(parts) || parts.length === 0) return slots;
  const bodyIndices = [];
  for (let i = startIdx; i < slotCount; i++) bodyIndices.push(i);
  if (bodyIndices.length === 0) return slots;

  for (const part of parts) {
    let bestIndex = bodyIndices[0];
    for (const idx of bodyIndices) {
      const bestLen = normalizeToken(slots[bestIndex]).length;
      const curLen = normalizeToken(slots[idx]).length;
      if (curLen < bestLen) bestIndex = idx;
    }
    if (!slots[bestIndex]) slots[bestIndex] = part;
    else slots[bestIndex] = `${slots[bestIndex]} | ${part}`;
  }
  return slots;
}

function ruleFitTokens(tokens, slotCount, { maxCharsPerSlot = 360 } = {}) {
  if (slotCount <= 0) return [];
  const cleaned = dedupeTokens(tokens);
  if (cleaned.length === 0) return [];
  if (slotCount === 1) {
    return [compressTextToLimit(cleaned.join(' | '), 1800)];
  }

  const slots = new Array(slotCount).fill('');
  let cursorStart = 0;
  if (looksLikeTitle(cleaned[0])) {
    slots[0] = compressTextToLimit(cleaned[0], Math.min(240, maxCharsPerSlot));
    cursorStart = 1;
  }

  const bodyTokens = cleaned.slice(cursorStart);
  const parts = [];
  for (const tok of bodyTokens) {
    splitLongToken(tok, maxCharsPerSlot).forEach((p) => parts.push(p));
  }
  fillBodySlotsBalanced(parts, slotCount, cursorStart, slots);

  for (let i = 0; i < slots.length; i++) {
    const isTitleSlot = i === 0 && cursorStart === 1;
    const slotLimit = isTitleSlot ? Math.min(260, maxCharsPerSlot) : maxCharsPerSlot;
    slots[i] = compressTextToLimit(slots[i], slotLimit);
  }

  const nonEmpty = slots.map((s) => normalizeToken(s)).filter(Boolean);
  if (nonEmpty.length === 0) return [];
  return nonEmpty;
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Continue.
  }
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue.
    }
  }
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {
      // Continue.
    }
  }
  return null;
}

async function aiFitTokens(tokens, slotCount, { maxCharsPerSlot = 360, context = '' } = {}) {
  const normalized = dedupeTokens(tokens);
  if (normalized.length === 0 || slotCount <= 0) return [];

  const prompt = [
    'Fit research slide content into fixed template slots.',
    `Context: ${context || 'market research slide'}`,
    `Slot count: ${slotCount}`,
    `Max chars per slot: ${maxCharsPerSlot}`,
    '',
    'Input content tokens (ordered by relevance):',
    ...normalized.map((t, i) => `${i + 1}. ${t}`),
    '',
    'Return ONLY JSON with this schema:',
    '{"slots":["...", "..."]}',
    '',
    'Rules:',
    '- Preserve meaning and key numbers.',
    '- Use concise business phrasing.',
    '- Keep title-like text in early slots.',
    '- No placeholder text.',
    '- slots.length must be <= slot count.',
  ].join('\n');

  const raw = await callGemini(prompt, {
    temperature: 0.2,
    maxTokens: 2048,
    jsonMode: true,
    timeout: 45000,
    maxRetries: 2,
  });
  const parsed = extractJsonObject(raw);
  const slots = Array.isArray(parsed?.slots) ? parsed.slots : [];
  const cleaned = slots
    .map((s) => compressTextToLimit(s, maxCharsPerSlot))
    .map((s) => normalizeToken(s))
    .filter(Boolean)
    .slice(0, slotCount);
  return cleaned;
}

function shouldTryAI({
  tokenCount,
  slotCount,
  forceAI = false,
  allowAI = true,
  mode = 'auto',
}) {
  if (!allowAI) return false;
  if (MODE_FALSE_RE.test(String(mode || 'auto'))) return false;
  if (mode === 'rule') return false;
  if (mode === 'ai') return true;
  if (forceAI) return true;
  if (slotCount <= 0) return false;
  // Auto mode: use AI when there is clear compression pressure.
  return tokenCount > Math.max(slotCount + 2, Math.ceil(slotCount * 1.4));
}

async function fitTokensToTemplateSlots(
  tokens,
  slotCount,
  {
    maxCharsPerSlot = 360,
    mode = String(process.env.CONTEXT_FIT_AGENT_MODE || 'auto')
      .trim()
      .toLowerCase(),
    allowAI = true,
    forceAI = false,
    context = '',
  } = {}
) {
  const cleaned = dedupeTokens(tokens);
  if (slotCount <= 0 || cleaned.length === 0) {
    return {
      tokens: [],
      method: 'none',
      stats: { inputTokens: cleaned.length, slotCount, outputTokens: 0 },
    };
  }

  const aiEnabled = Boolean(process.env.GEMINI_API_KEY);
  if (
    aiEnabled &&
    shouldTryAI({
      tokenCount: cleaned.length,
      slotCount,
      forceAI,
      allowAI,
      mode,
    })
  ) {
    try {
      const aiTokens = await aiFitTokens(cleaned, slotCount, {
        maxCharsPerSlot,
        context,
      });
      if (aiTokens.length > 0) {
        return {
          tokens: aiTokens.slice(0, slotCount),
          method: 'ai',
          stats: { inputTokens: cleaned.length, slotCount, outputTokens: aiTokens.length },
        };
      }
    } catch (err) {
      // Fall through to rule fitting.
      console.warn(`[Context Fit] AI fit failed, fallback to rule: ${err.message}`);
    }
  }

  const ruleTokens = ruleFitTokens(cleaned, slotCount, { maxCharsPerSlot });
  return {
    tokens: ruleTokens.slice(0, slotCount),
    method: 'rule',
    stats: { inputTokens: cleaned.length, slotCount, outputTokens: ruleTokens.length },
  };
}

module.exports = {
  fitTokensToTemplateSlots,
  ruleFitTokens,
};

