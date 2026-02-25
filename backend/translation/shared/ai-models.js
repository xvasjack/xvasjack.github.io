/**
 * Shared AI model utilities for all backend services
 * Provides unified retry logic, fallback chains, and cost tracking
 */

const fetch = require('node-fetch');

// ============ MODEL CONFIGURATION ============

const MODEL_CONFIG = {
  // OpenAI
  'gpt-5.1': {
    provider: 'openai',
    cost: { input: 1.25, output: 10.0 }, // per 1M tokens
    timeout: 30000,
    maxTokens: 8192,
  },
  'gpt-4o-mini': {
    provider: 'openai',
    cost: { input: 0.15, output: 0.6 },
    timeout: 30000,
    maxTokens: 4096,
  },
  // Google Gemini
  'gemini-2.5-flash': {
    provider: 'gemini',
    cost: { input: 0.1, output: 0.4 },
    timeout: 30000,
    maxTokens: 8192,
  },
  'gemini-2.5-flash-lite': {
    provider: 'gemini',
    cost: { input: 0.02, output: 0.08 },
    timeout: 20000,
    maxTokens: 4096,
  },
  // DeepSeek
  'deepseek-chat': {
    provider: 'deepseek',
    cost: { input: 0.28, output: 0.42 },
    timeout: 30000,
    maxTokens: 4096,
  },
  'deepseek-reasoner': {
    provider: 'deepseek',
    cost: { input: 0.42, output: 1.68 },
    timeout: 120000,
    maxTokens: 16384,
  },
  // Perplexity
  'sonar-pro': {
    provider: 'perplexity',
    cost: { input: 3.0, output: 15.0 },
    timeout: 90000,
    maxTokens: 4096,
  },
  // Kimi
  'kimi-k2': {
    provider: 'kimi',
    cost: { input: 0.6, output: 2.5 },
    timeout: 30000,
    maxTokens: 16384,
  },
};

// Temperature presets for different task types
const TEMPERATURE_PRESETS = {
  deterministic: 0.0, // For validation, exact matching
  conservative: 0.1, // For structured output, parsing
  balanced: 0.3, // For analysis, general tasks
  creative: 0.7, // For creative writing, suggestions
};

// ============ RETRY UTILITY ============

/**
 * Execute a function with exponential backoff retry logic
 * @param {Function} fn - Async function to execute
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 * @param {number} baseDelayMs - Base delay in ms (doubles each retry)
 * @param {string} operationName - Name for logging
 * @returns {Promise<any>} Result of the function or null on failure
 */
async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000, operationName = 'API call') {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        console.log(`  ${operationName} succeeded on attempt ${attempt}`);
      }
      return result;
    } catch (error) {
      lastError = error;
      console.error(`  ${operationName} attempt ${attempt}/${maxRetries} failed:`, error.message);

      // Don't retry on 4xx client errors (except 429 rate limit)
      if (error.status >= 400 && error.status < 500 && error.status !== 429) {
        console.error(`  ${operationName} failed with client error, not retrying`);
        return null;
      }

      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.log(`  Retrying ${operationName} in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.error(`  ${operationName} failed after ${maxRetries} attempts:`, lastError?.message);
  return null;
}

// ============ SAFE API CALL WRAPPER ============

/**
 * Wrap an API call with try-catch and fallback
 * @param {Function} fn - Async function to execute
 * @param {string} modelName - Model name for logging
 * @param {any} fallbackValue - Value to return on failure
 * @returns {Promise<any>} Result or fallbackValue
 */
async function safeAPICall(fn, modelName = 'API', fallbackValue = '') {
  try {
    return await fn();
  } catch (error) {
    console.error(`  ${modelName} call failed:`, error.message);
    return fallbackValue;
  }
}

// ============ FALLBACK CHAIN ============

/**
 * Call primary function, fallback to secondary on failure
 * @param {Function} primaryFn - Primary async function
 * @param {Function} fallbackFn - Fallback async function
 * @param {string} primaryName - Primary model name for logging
 * @param {string} fallbackName - Fallback model name for logging
 * @returns {Promise<{result: any, usedFallback: boolean, model: string}>}
 */
async function callWithFallback(
  primaryFn,
  fallbackFn,
  primaryName = 'Primary',
  fallbackName = 'Fallback'
) {
  try {
    const result = await primaryFn();
    if (result) {
      return { result, usedFallback: false, model: primaryName };
    }
    console.log(`  ${primaryName} returned empty, trying ${fallbackName}...`);
  } catch (error) {
    console.log(`  ${primaryName} failed (${error.message}), trying ${fallbackName}...`);
  }

  try {
    const fallbackResult = await fallbackFn();
    return { result: fallbackResult, usedFallback: true, model: fallbackName };
  } catch (fallbackError) {
    console.error(`  ${fallbackName} also failed:`, fallbackError.message);
    return { result: null, usedFallback: true, model: fallbackName };
  }
}

// ============ COST TRACKING ============

/**
 * Calculate cost for a model call
 * @param {string} model - Model identifier
 * @param {number} inputTokens - Input token count
 * @param {number} outputTokens - Output token count
 * @returns {{cost: number, breakdown: {input: number, output: number}}}
 */
function calculateModelCost(model, inputTokens = 0, outputTokens = 0) {
  const config = MODEL_CONFIG[model];
  if (!config) {
    console.warn(`  Unknown model for cost calculation: ${model}`);
    return { cost: 0, breakdown: { input: 0, output: 0 } };
  }

  const inputCost = (inputTokens / 1000000) * config.cost.input;
  const outputCost = (outputTokens / 1000000) * config.cost.output;

  return {
    cost: inputCost + outputCost,
    breakdown: { input: inputCost, output: outputCost },
  };
}

/**
 * Create a cost tracker for a session
 * @returns {Object} Cost tracker with add and getSummary methods
 */
function createCostTracker() {
  const costs = [];
  let totalCost = 0;

  return {
    add(model, inputTokens, outputTokens, feature = 'general') {
      const { cost, breakdown } = calculateModelCost(model, inputTokens, outputTokens);
      costs.push({
        model,
        inputTokens,
        outputTokens,
        cost,
        breakdown,
        feature,
        timestamp: new Date().toISOString(),
      });
      totalCost += cost;
      return cost;
    },

    getSummary() {
      const byModel = {};
      const byFeature = {};

      for (const entry of costs) {
        byModel[entry.model] = (byModel[entry.model] || 0) + entry.cost;
        byFeature[entry.feature] = (byFeature[entry.feature] || 0) + entry.cost;
      }

      return {
        totalCost,
        callCount: costs.length,
        byModel,
        byFeature,
        details: costs,
      };
    },

    getTotalCost() {
      return totalCost;
    },
  };
}

// ============ JSON RESPONSE HELPERS ============

/**
 * Extract JSON from a model response that might have markdown code blocks
 * @param {string} text - Raw response text
 * @returns {any} Parsed JSON or null
 */
function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;

  // Try parsing directly first
  try {
    return JSON.parse(text);
  } catch {
    // Continue to other methods
  }

  // Try extracting from markdown code block
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {
      // Continue to other methods
    }
  }

  // Try finding JSON array or object
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {
      // Continue
    }
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // Continue
    }
  }

  return null;
}

/**
 * Ensure a value is a string (AI models may return objects/arrays)
 * @param {any} value - Value to convert
 * @param {string} defaultValue - Default if conversion fails
 * @returns {string}
 */
function ensureString(value, defaultValue = '') {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return defaultValue;
  if (Array.isArray(value)) return value.map((v) => ensureString(v)).join(', ');
  if (typeof value === 'object') {
    if (value.text) return ensureString(value.text);
    if (value.value) return ensureString(value.value);
    if (value.name) return ensureString(value.name);
    if (value.city && value.country) return `${value.city}, ${value.country}`;
    try {
      return JSON.stringify(value);
    } catch {
      return defaultValue;
    }
  }
  return String(value);
}

// ============ TIMEOUT WRAPPER ============

/**
 * Wrap a promise with a timeout
 * @param {Promise} promise - Promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} operationName - Name for error message
 * @returns {Promise}
 */
function withTimeout(promise, timeoutMs, operationName = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);
}

// ============ GEMINI HELPER ============

/**
 * Call Gemini API with consistent error handling
 * @param {string} prompt - Prompt text
 * @param {Object} options - Options
 * @param {string} options.model - Model name (default: gemini-2.5-flash)
 * @param {boolean} options.jsonMode - Enable JSON response mode
 * @param {number} options.temperature - Temperature (default: 0.1)
 * @param {number} options.timeout - Timeout in ms
 * @returns {Promise<string>} Response text or empty string
 */
async function callGemini(prompt, options = {}) {
  const {
    model = 'gemini-2.5-flash',
    jsonMode = false,
    temperature = 0.1,
    timeout = 30000,
  } = options;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('  GEMINI_API_KEY not set');
    return '';
  }

  const modelPath = model.includes('/') ? model : `models/${model}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      ...(jsonMode && { responseMimeType: 'application/json' }),
    },
  };

  try {
    const response = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }),
      timeout,
      'Gemini API'
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`  Gemini API error: ${response.status} - ${error}`);
      return '';
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (error) {
    console.error('  Gemini call failed:', error.message);
    return '';
  }
}

// ============ PERPLEXITY HELPER ============

/**
 * Call Perplexity API for web search
 * @param {string} prompt - Search prompt
 * @param {Object} options - Options
 * @param {string} options.model - Model name (default: sonar-pro)
 * @param {number} options.timeout - Timeout in ms
 * @returns {Promise<string>} Response text or empty string
 */
async function callPerplexity(prompt, options = {}) {
  const { model = 'sonar-pro', timeout = 90000 } = options;

  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.warn('  PERPLEXITY_API_KEY not set');
    return '';
  }

  try {
    const response = await withTimeout(
      fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
        }),
      }),
      timeout,
      'Perplexity API'
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`  Perplexity API error: ${response.status} - ${error}`);
      return '';
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('  Perplexity call failed:', error.message);
    return '';
  }
}

module.exports = {
  // Configuration
  MODEL_CONFIG,
  TEMPERATURE_PRESETS,

  // Retry and error handling
  withRetry,
  safeAPICall,
  callWithFallback,
  withTimeout,

  // Cost tracking
  calculateModelCost,
  createCostTracker,

  // Response helpers
  extractJSON,
  ensureString,

  // API helpers
  callGemini,
  callPerplexity,
};
