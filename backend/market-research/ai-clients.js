const fetch = require('node-fetch');
const { recordTokens } = require('./shared/tracking');

// ============ COST TRACKING ============
const costTracker = {
  date: new Date().toISOString().split('T')[0],
  totalCost: 0,
  calls: [],
};

// Pricing per 1M tokens (from DeepSeek docs - Dec 2024)
// Both deepseek-chat and deepseek-reasoner use same pricing
// deepseek-chat = V3.2 Non-thinking Mode (max 8K output)
// deepseek-reasoner = V3.2 Thinking Mode (max 64K output)
const PRICING = {
  'deepseek-chat': { input: 0.28, output: 0.42 }, // Cache miss pricing
  'deepseek-reasoner': { input: 0.28, output: 0.42 }, // Same pricing, but thinking mode
  'kimi-128k': { input: 0.84, output: 0.84 }, // Moonshot v1 128k context
  'kimi-32k': { input: 0.35, output: 0.35 }, // Moonshot v1 32k context
};

function trackCost(model, inputTokens, outputTokens, searchCount = 0) {
  let cost = 0;
  const pricing = PRICING[model];

  if (pricing) {
    if (pricing.perSearch) {
      cost = searchCount * pricing.perSearch;
    } else {
      cost = (inputTokens / 1000000) * pricing.input + (outputTokens / 1000000) * pricing.output;
    }
  }

  costTracker.totalCost += cost;
  costTracker.calls.push({
    model,
    inputTokens,
    outputTokens,
    searchCount,
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

// DeepSeek Chat - for lighter tasks (scope parsing)
async function callDeepSeekChat(prompt, systemPrompt = '', maxTokens = 4096) {
  try {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`DeepSeek Chat HTTP error ${response.status}:`, errorText.substring(0, 200));
      return { content: '', usage: { input: 0, output: 0 } };
    }

    const data = await response.json();
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    trackCost('deepseek-chat', inputTokens, outputTokens);
    recordTokens('deepseek-chat', inputTokens, outputTokens);

    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: { input: inputTokens, output: outputTokens },
    };
  } catch (error) {
    console.error('DeepSeek Chat API error:', error.message);
    return { content: '', usage: { input: 0, output: 0 } };
  }
}

// DeepSeek V3.2 Thinking Mode - for deep analysis with chain-of-thought
async function callDeepSeek(prompt, systemPrompt = '', maxTokens = 16384) {
  try {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `DeepSeek Reasoner HTTP error ${response.status}:`,
        errorText.substring(0, 200)
      );
      // Fallback to chat model
      console.log('Falling back to deepseek-chat...');
      return callDeepSeekChat(prompt, systemPrompt, maxTokens);
    }

    const data = await response.json();
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    trackCost('deepseek-reasoner', inputTokens, outputTokens);
    recordTokens('deepseek-reasoner', inputTokens, outputTokens);

    // R1 returns reasoning_content + content
    const content = data.choices?.[0]?.message?.content || '';
    const reasoning = data.choices?.[0]?.message?.reasoning_content || '';

    console.log(
      `  [DeepSeek V3.2 Thinking] Reasoning: ${reasoning.length} chars, Output: ${content.length} chars`
    );

    return {
      content,
      reasoning,
      usage: { input: inputTokens, output: outputTokens },
    };
  } catch (error) {
    console.error('DeepSeek Reasoner API error:', error.message);
    return { content: '', usage: { input: 0, output: 0 } };
  }
}

// Kimi (Moonshot) API - for deep research with web browsing
// Uses 128k context for thorough analysis with retry logic
async function callKimi(query, systemPrompt = '', useWebSearch = true) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: query });

  const requestBody = {
    model: 'moonshot-v1-128k',
    messages,
    max_tokens: 8192,
    temperature: 0.3,
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
    trackCost('kimi-128k', inputTokens, outputTokens);
    recordTokens('kimi-128k', inputTokens, outputTokens);

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
    console.error('Kimi API error:', error.message);
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
- Recent news and developments (2024-2025)
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

Search the web for recent data (2024-2025). Find:
1. Specific statistics and numbers
2. Key regulations and their enforcement status
3. Major companies and their market positions
4. Recent deals, partnerships, or market developments
5. Government initiatives and deadlines

Be specific. Cite sources. No fluff.`;

  return callKimi(query, systemPrompt, true);
}

module.exports = {
  costTracker,
  PRICING,
  trackCost,
  withRetry,
  callDeepSeekChat,
  callDeepSeek,
  callKimi,
  callKimiDeepResearch,
};
