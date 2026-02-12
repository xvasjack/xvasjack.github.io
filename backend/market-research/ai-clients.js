const fetch = require('node-fetch');
const { recordTokens } = require('./shared/tracking');

// ============ COST TRACKING ============
const costTracker = {
  date: new Date().toISOString().split('T')[0],
  totalCost: 0,
  calls: [],
};

// Pricing per 1M tokens
const PRICING = {
  'gemini-2.5-flash': { input: 0.15, output: 0.6 },
  'gemini-3-flash-preview': { input: 0.5, output: 3.0 },
  'gemini-3-pro-preview': { input: 1.25, output: 10.0 },
};

// ============ BUDGET GUARDRAILS ============
const GEMINI_BUDGET_LIMIT = parseFloat(process.env.GEMINI_BUDGET_LIMIT || '20.00');
let runBudgetUsed = 0;

function checkBudget() {
  if (runBudgetUsed >= GEMINI_BUDGET_LIMIT) {
    throw new Error(
      `Gemini budget exceeded: $${runBudgetUsed.toFixed(2)} >= $${GEMINI_BUDGET_LIMIT}`
    );
  }
  if (runBudgetUsed >= GEMINI_BUDGET_LIMIT * 0.8) {
    console.warn(
      `[Budget] WARNING: ${((runBudgetUsed / GEMINI_BUDGET_LIMIT) * 100).toFixed(0)}% of budget used ($${runBudgetUsed.toFixed(2)}/$${GEMINI_BUDGET_LIMIT})`
    );
  }
}

function resetBudget() {
  runBudgetUsed = 0;
  console.log('[Budget] Reset budget tracker');
}

function trackCost(
  model,
  inputTokens,
  outputTokens,
  customInputPrice = null,
  customOutputPrice = null
) {
  let cost = 0;
  const pricing = PRICING[model];

  if (customInputPrice !== null && customOutputPrice !== null) {
    cost =
      (inputTokens / 1000000) * customInputPrice + (outputTokens / 1000000) * customOutputPrice;
  } else if (pricing) {
    cost = (inputTokens / 1000000) * pricing.input + (outputTokens / 1000000) * pricing.output;
  }

  costTracker.totalCost += cost;
  runBudgetUsed += cost;
  costTracker.calls.push({
    model,
    inputTokens,
    outputTokens,
    cost,
    time: new Date().toISOString(),
  });
  console.log(
    `  [Cost] ${model}: $${cost.toFixed(4)} (Total: $${costTracker.totalCost.toFixed(4)}, Budget: $${runBudgetUsed.toFixed(4)}/$${GEMINI_BUDGET_LIMIT})`
  );
  return cost;
}

// ============ AI TOOLS ============

function parseRetryAfterHeaderMs(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
  }
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
}

function parseRetryDelayMsFromText(text) {
  const body = String(text || '');
  if (!body) return null;
  const patterns = [
    /retry(?:ing)?\s+in\s+([0-9]+(?:\.[0-9]+)?)\s*s/i,
    /"retryDelay"\s*:\s*"([0-9]+(?:\.[0-9]+)?)s"/i,
  ];
  for (const re of patterns) {
    const match = body.match(re);
    if (!match) continue;
    const seconds = Number.parseFloat(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.round(seconds * 1000);
    }
  }
  return null;
}

function computeRetryDelayMs(error, baseDelayMs, attempt) {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1); // 1x, 2x, 4x...
  const hintedDelay = Number.isFinite(error?.retryAfterMs) ? Number(error.retryAfterMs) : null;
  const delay = Math.max(exponentialDelay, hintedDelay || 0);
  // Small jitter avoids synchronized retries across parallel requests.
  const jitter = Math.round(delay * (Math.random() * 0.1));
  return Math.max(250, delay + jitter);
}

async function waitForRetryDelay(delayMs, signal = null) {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Retry wait aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Retry utility with exponential backoff
// Accepts optional signal (AbortSignal) to cancel retries when pipeline aborts
async function withRetry(
  fn,
  maxRetries = 3,
  baseDelayMs = 1000,
  operationName = 'API call',
  signal = null
) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error(`${operationName} aborted before attempt ${attempt}`);
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error?.nonRetryable) {
        throw error;
      }
      if (signal?.aborted) {
        throw new Error(`${operationName} aborted during attempt ${attempt}`);
      }
      if (attempt < maxRetries) {
        const delay = computeRetryDelayMs(error, baseDelayMs, attempt);
        console.log(
          `  [Retry] ${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`
        );
        await waitForRetryDelay(delay, signal);
      }
    }
  }
  console.error(`  [Retry] ${operationName} failed after ${maxRetries} attempts`);
  throw lastError;
}

/**
 * Call Gemini 3 Flash for synthesis tasks
 * Fast and capable for structured synthesis
 */
async function callGemini(prompt, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[Gemini] No GEMINI_API_KEY set. Cannot proceed.');
  }

  checkBudget();

  const {
    temperature = 0.3,
    maxTokens = 8192,
    systemPrompt,
    jsonMode = false,
    timeout = 90000,
    maxRetries = 3,
  } = options;

  return withRetry(
    async () => {
      const contents = [];
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const generationConfig = {
        temperature,
        maxOutputTokens: maxTokens,
      };
      if (jsonMode) {
        generationConfig.responseMimeType = 'application/json';
      }

      const requestBody = { contents, generationConfig };
      if (systemPrompt) {
        requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          const errText = await response.text();
          const error = new Error(`Gemini API error ${response.status}: ${errText}`);
          error.status = response.status;
          const retryAfterMs =
            parseRetryAfterHeaderMs(response.headers?.get('retry-after')) ||
            parseRetryDelayMsFromText(errText);
          if (retryAfterMs) error.retryAfterMs = retryAfterMs;
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            error.nonRetryable = true;
          }
          throw error;
        }

        let data;
        try {
          data = await response.json();
        } catch (parseErr) {
          throw new Error(`API returned non-JSON response (HTTP ${response.status})`);
        }
        const candidate = data.candidates?.[0];
        if (!candidate || !candidate.content?.parts?.[0]?.text) {
          throw new Error('Gemini returned empty response');
        }

        const text = candidate.content.parts[0].text;

        // Track cost
        const inputTokens = data.usageMetadata?.promptTokenCount || 0;
        const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
        trackCost('gemini-3-flash-preview', inputTokens, outputTokens);

        return text;
      } finally {
        clearTimeout(timeoutId);
      }
    },
    maxRetries,
    1000,
    'Gemini'
  );
}

/**
 * Call Gemini 2.5 Flash with Google Search grounding for deep research
 * Returns { content, citations, researchQuality }
 */
async function callGeminiResearch(topic, country, industry, pipelineSignal = null) {
  console.log(`  [Gemini Research] ${topic.substring(0, 80)}... for ${country || 'unknown'}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[Gemini Research] No GEMINI_API_KEY set. Cannot proceed.');
  }

  const systemPrompt = `You are a senior market research analyst at McKinsey. You have access to web search.

Your job is to conduct DEEP research on the given topic. Not surface-level - actually dig into:
- Primary sources (government websites, official statistics, company filings)
- Recent news and developments (2025-2026)
- Specific numbers with sources
- Company-specific intelligence
- Regulatory details with enforcement reality

For every claim, you MUST provide:
- Specific numbers (market size in $, growth %, dates)
- Source type (government data, company filing, industry report)
- Context (why this matters, how it compares)

DO NOT give generic statements like "the market is growing". Give specifics like "The ESCO market reached $2.3B in 2024, up 14% YoY, driven by mandatory energy audits under the 2023 Energy Act."`;

  const query = `Research this topic thoroughly for ${country}'s ${industry} market:

${topic}

Search the web for recent data (2025-2026). Find:
1. Specific statistics and numbers
2. Key regulations and their enforcement status
3. Major companies and their market positions
4. Recent deals, partnerships, or market developments
5. Government initiatives and deadlines

Be specific. Cite sources. No fluff.`;

  return withRetry(
    async () => {
      checkBudget();

      if (pipelineSignal?.aborted) {
        return { content: '', citations: [], researchQuality: 'aborted' };
      }

      const contents = [{ role: 'user', parts: [{ text: query }] }];

      const requestBody = {
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 12288,
        },
        tools: [{ google_search: {} }],
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000); // 180s timeout
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          const errText = await response.text();
          if (response.status >= 500 || response.status === 429) {
            const error = new Error(
              `Gemini Research HTTP ${response.status}: ${errText.substring(0, 200)}`
            );
            error.status = response.status;
            const retryAfterMs =
              parseRetryAfterHeaderMs(response.headers?.get('retry-after')) ||
              parseRetryDelayMsFromText(errText);
            if (retryAfterMs) error.retryAfterMs = retryAfterMs;
            throw error;
          }
          console.error(
            `[Gemini Research] HTTP error ${response.status}:`,
            errText.substring(0, 200)
          );
          return { content: '', citations: [], researchQuality: 'failed' };
        }

        let data;
        try {
          data = await response.json();
        } catch (parseErr) {
          throw new Error(`API returned non-JSON response (HTTP ${response.status})`);
        }
        const candidate = data.candidates?.[0];

        // Track cost
        const inputTokens = data.usageMetadata?.promptTokenCount || 0;
        const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
        trackCost('gemini-2.5-flash', inputTokens, outputTokens);
        recordTokens('gemini-2.5-flash', inputTokens, outputTokens);

        const content = candidate?.content?.parts?.[0]?.text || '';

        // Extract citations from grounding metadata (try multiple paths for API compatibility)
        const groundingMeta = candidate?.groundingMetadata || {};
        const groundingChunks =
          groundingMeta.groundingChunks ||
          groundingMeta.supportingChunks ||
          groundingMeta.chunks ||
          [];
        let citations = groundingChunks
          .filter((chunk) => chunk.web?.uri)
          .map((chunk) => ({
            url: chunk.web.uri,
            title:
              chunk.web.title || chunk.web.uri.replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
          }))
          .slice(0, 15);

        // Fallback: extract URLs from grounding supports
        if (citations.length === 0 && groundingMeta.groundingSupports) {
          const supportUrls = new Set();
          for (const support of groundingMeta.groundingSupports) {
            for (const idx of support.groundingChunkIndices || []) {
              const chunk = groundingChunks[idx];
              if (chunk?.web?.uri) supportUrls.add(chunk.web.uri);
            }
          }
          citations = [...supportUrls].slice(0, 15).map((url) => ({
            url,
            title: url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
          }));
        }

        // Fallback: extract URLs directly from content text
        if (citations.length === 0 && content) {
          const urlRegex = /https?:\/\/[^\s"'<>)\]},]+/g;
          const foundUrls = [...new Set(content.match(urlRegex) || [])];
          citations = foundUrls.slice(0, 10).map((url) => ({
            url: url.replace(/[.,;:]+$/, ''),
            title: url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
          }));
        }

        // Quality check
        if (!content || content.length < 500) {
          console.log(
            `  [Gemini Research] Thin response (${content.length} chars) — retrying with reformulated query`
          );
          // Throw to trigger withRetry's retry mechanism with reformulated query on next attempt
          throw new Error(`Thin response (${content.length} chars), retrying`);
        }

        const researchQuality = 'good';
        console.log(
          `  [Gemini Research] Response: ${content.length} chars, quality: ${researchQuality}, citations: ${citations.length}`
        );

        return {
          content,
          citations,
          usage: { input: inputTokens, output: outputTokens },
          researchQuality,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
    3,
    2000,
    'Gemini Research',
    pipelineSignal
  );
}

/**
 * Call Gemini 3 Pro Preview for high-quality synthesis/analysis
 * Higher capability model for complex tasks
 */
async function callGeminiPro(prompt, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[Gemini Pro] No GEMINI_API_KEY set. Cannot proceed.');
  }

  checkBudget();

  const {
    temperature = 0.3,
    maxTokens = 12000,
    systemPrompt,
    jsonMode = false,
    timeout = 120000,
    maxRetries = 3,
  } = options;

  return withRetry(
    async () => {
      const contents = [];
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const generationConfig = {
        temperature,
        maxOutputTokens: maxTokens,
      };
      if (jsonMode) {
        generationConfig.responseMimeType = 'application/json';
      }

      const requestBody = { contents, generationConfig };
      if (systemPrompt) {
        requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          const errText = await response.text();
          const error = new Error(`Gemini Pro API error ${response.status}: ${errText}`);
          error.status = response.status;
          const retryAfterMs =
            parseRetryAfterHeaderMs(response.headers?.get('retry-after')) ||
            parseRetryDelayMsFromText(errText);
          if (retryAfterMs) error.retryAfterMs = retryAfterMs;
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            error.nonRetryable = true;
          }
          throw error;
        }

        let data;
        try {
          data = await response.json();
        } catch (parseErr) {
          throw new Error(`API returned non-JSON response (HTTP ${response.status})`);
        }
        const candidate = data.candidates?.[0];
        if (!candidate || !candidate.content?.parts?.[0]?.text) {
          throw new Error('Gemini Pro returned empty response');
        }

        const text = candidate.content.parts[0].text;

        // Track cost
        const inputTokens = data.usageMetadata?.promptTokenCount || 0;
        const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
        trackCost('gemini-3-pro-preview', inputTokens, outputTokens);

        return text;
      } finally {
        clearTimeout(timeoutId);
      }
    },
    maxRetries,
    1000,
    'Gemini Pro'
  );
}

// Factory for per-request cost tracking (future use)
function createCostTracker() {
  return { totalCost: 0, calls: [], date: new Date().toISOString().split('T')[0] };
}

module.exports = {
  costTracker,
  createCostTracker,
  PRICING,
  trackCost,
  withRetry,
  callGemini,
  callGeminiResearch,
  callGeminiPro,
  checkBudget,
  resetBudget,
};
