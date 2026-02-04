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
  'kimi-k2.5': { input: 0.6, output: 2.5 }, // Kimi K2.5 256k context
};

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
    // Use custom pricing (for models not in PRICING map, like Gemini)
    cost =
      (inputTokens / 1000000) * customInputPrice + (outputTokens / 1000000) * customOutputPrice;
  } else if (pricing) {
    if (pricing.perSearch) {
      cost = inputTokens * pricing.perSearch; // inputTokens is searchCount for search models
    } else {
      cost = (inputTokens / 1000000) * pricing.input + (outputTokens / 1000000) * pricing.output;
    }
  }

  costTracker.totalCost += cost;
  costTracker.calls.push({
    model,
    inputTokens,
    outputTokens,
    cost,
    time: new Date().toISOString(),
  });
  console.log(
    `  [Cost] ${model}: $${cost.toFixed(4)} (Total: $${costTracker.totalCost.toFixed(4)})`
  );
  return cost;
}

// ============ AI TOOLS ============

// Retry utility with exponential backoff
async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000, operationName = 'API call') {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        console.log(
          `  [Retry] ${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  console.error(`  [Retry] ${operationName} failed after ${maxRetries} attempts`);
  throw lastError;
}

// Kimi K2 API - for deep research with web browsing
// Uses 256k context for thorough analysis with retry logic
async function callKimi(query, systemPrompt = '', useWebSearch = true, maxTokens = 8192) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: query });

  const requestBody = {
    model: 'kimi-k2.5',
    messages,
    max_tokens: maxTokens,
    temperature: 0.6,
  };

  // Enable web search tool if requested (can be disabled via env var for testing)
  const webSearchEnabled = process.env.KIMI_WEB_SEARCH !== 'false';
  if (useWebSearch && webSearchEnabled) {
    requestBody.tools = [
      {
        type: 'builtin_function',
        function: { name: '$web_search' },
      },
    ];
  }

  const kimiBaseUrl = process.env.KIMI_API_BASE || 'https://api.moonshot.ai/v1';

  try {
    // Use retry logic for network resilience
    const data = await withRetry(
      async () => {
        const response = await fetch(`${kimiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.KIMI_API_KEY}`,
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          // Throw to trigger retry for server errors
          if (response.status >= 500 || response.status === 429) {
            throw new Error(`Kimi HTTP ${response.status}: ${errorText.substring(0, 100)}`);
          }
          console.error(`Kimi HTTP error ${response.status}:`, errorText.substring(0, 200));
          return null; // Don't retry client errors
        }

        return await response.json();
      },
      3,
      2000,
      'Kimi research'
    );

    if (!data) {
      return { content: '', citations: [], researchQuality: 'failed' };
    }

    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    trackCost('kimi-k2.5', inputTokens, outputTokens);
    recordTokens('kimi-k2.5', inputTokens, outputTokens);

    // Debug: log if response has tool calls or empty content
    const content = data.choices?.[0]?.message?.content || '';
    const toolCalls = data.choices?.[0]?.message?.tool_calls;

    // Validate research quality
    let researchQuality = 'good';
    if (!content && toolCalls) {
      console.log(
        '  [Kimi] Response contains tool_calls instead of content - web search may need handling'
      );
      researchQuality = 'failed';
    } else if (!content) {
      console.log('  [Kimi] Empty response - finish_reason:', data.choices?.[0]?.finish_reason);
      researchQuality = 'failed';
    } else if (content.length < 100) {
      console.log(`  [Kimi] Thin response (${content.length} chars) - may be incomplete`);
      researchQuality = 'thin';
    }

    // Extract URLs from content for source citations
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
    const extractedUrls = content.match(urlRegex) || [];
    // Dedupe and clean URLs
    const citations = [...new Set(extractedUrls)]
      .filter((url) => {
        // Filter out common non-source URLs
        const skipPatterns = [
          'facebook.com',
          'twitter.com',
          'linkedin.com',
          'youtube.com',
          'instagram.com',
        ];
        return !skipPatterns.some((p) => url.includes(p));
      })
      .slice(0, 10)
      .map((url) => ({
        url: url.replace(/[.,;:!?)]+$/, ''), // Clean trailing punctuation
        title: url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
      }));

    return {
      content,
      citations,
      usage: { input: inputTokens, output: outputTokens },
      researchQuality,
    };
  } catch (error) {
    console.error('Kimi API error:', error?.message);
    return { content: '', citations: [], researchQuality: 'failed' };
  }
}

// Kimi deep research - comprehensive research on a topic
// Lets Kimi browse and think deeply about the research question
async function callKimiDeepResearch(topic, country, industry) {
  console.log(`  [Kimi Deep Research] ${topic} for ${country}...`);

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

  return callKimi(query, systemPrompt, true);
}

// Light tasks (scope parsing, gap ID, review). No web search.
async function callKimiChat(prompt, systemPrompt = '', maxTokens = 4096) {
  const result = await callKimi(prompt, systemPrompt, false, maxTokens);
  return result; // { content, citations, usage, researchQuality }
}

// Heavy synthesis/analysis. No web search.
async function callKimiAnalysis(prompt, systemPrompt = '', maxTokens = 12000) {
  const result = await callKimi(prompt, systemPrompt, false, maxTokens);
  return result;
}

/**
 * Call Gemini 3 Flash for synthesis tasks
 * Fast and capable for structured synthesis
 * Falls back to KimiChat if no Gemini key
 */
async function callGemini(prompt, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('  [Gemini] No API key, falling back to KimiChat');
    return callKimiChat(prompt, options.systemPrompt || '', options.maxTokens || 8192).then(
      (r) => r.content
    );
  }

  const { temperature = 0.3, maxTokens = 8192, systemPrompt, jsonMode = false } = options;

  return withRetry(
    async () => {
      const contents = [];
      if (systemPrompt) {
        contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
        contents.push({
          role: 'model',
          parts: [{ text: 'Understood. I will follow these instructions.' }],
        });
      }
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const generationConfig = {
        temperature,
        maxOutputTokens: maxTokens,
      };
      if (jsonMode) {
        generationConfig.responseMimeType = 'application/json';
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents, generationConfig }),
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const candidate = data.candidates?.[0];
      if (!candidate || !candidate.content?.parts?.[0]?.text) {
        throw new Error('Gemini returned empty response');
      }

      const text = candidate.content.parts[0].text;

      // Track cost
      const inputTokens = data.usageMetadata?.promptTokenCount || 0;
      const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
      trackCost('gemini-3-flash-preview', inputTokens, outputTokens, 0.5, 3.0);

      return text;
    },
    3,
    1000,
    'Gemini'
  );
}

module.exports = {
  costTracker,
  PRICING,
  trackCost,
  withRetry,
  callKimi,
  callKimiChat,
  callKimiAnalysis,
  callKimiDeepResearch,
  callGemini,
};
