/**
 * Google Sheets tracking for API usage and costs
 * Tracks per-request: service, timestamp, email, inputs, estimated cost
 */

const fetch = require('node-fetch');

// Google Sheets API configuration
const SHEETS_API_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

// Cost estimates per model (USD per 1K tokens)
const MODEL_COSTS = {
  // OpenAI
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4o-search-preview': { input: 0.0025, output: 0.01 },
  // Perplexity
  'sonar-pro': { input: 0.003, output: 0.015 },
  sonar: { input: 0.001, output: 0.001 },
  // Gemini (per 1K chars ≈ 250 tokens, converted to per 1K tokens)
  'gemini-2.5-flash': { input: 0.00015, output: 0.0006 },
  'gemini-3-flash': { input: 0.00015, output: 0.0006 },
  // Anthropic
  'claude-3-opus': { input: 0.015, output: 0.075 },
  'claude-3-sonnet': { input: 0.003, output: 0.015 },
  'claude-3-haiku': { input: 0.00025, output: 0.00125 },
  // DeepSeek
  deepseek: { input: 0.00014, output: 0.00028 },
};

/**
 * Estimate token count from text (rough: 1 token ≈ 4 chars)
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * Calculate estimated cost for a model call
 */
function calculateCost(model, inputText, outputText) {
  const modelKey = Object.keys(MODEL_COSTS).find((k) => model?.toLowerCase().includes(k));
  if (!modelKey) return 0;

  const costs = MODEL_COSTS[modelKey];
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);

  return (inputTokens / 1000) * costs.input + (outputTokens / 1000) * costs.output;
}

/**
 * Track a request to Google Sheets
 * @param {Object} data - Request data to track
 * @param {string} data.service - Service name (e.g., 'target-v6')
 * @param {string} data.email - User email
 * @param {Object} data.inputs - Input parameters
 * @param {number} data.estimatedCost - Estimated cost in USD
 * @param {number} data.duration - Duration in seconds
 * @param {Object} data.results - Result counts
 */
async function trackRequest(data) {
  const spreadsheetId = process.env.TRACKING_SHEET_ID;
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;

  if (!spreadsheetId || !apiKey) {
    console.log('[Tracking] Skipped - TRACKING_SHEET_ID or GOOGLE_SHEETS_API_KEY not set');
    return false;
  }

  const timestamp = new Date().toISOString();
  const row = [
    timestamp,
    data.service || '',
    data.email || '',
    JSON.stringify(data.inputs || {}),
    (data.estimatedCost || 0).toFixed(4),
    (data.duration || 0).toFixed(1),
    JSON.stringify(data.results || {}),
    JSON.stringify(data.modelCalls || {}),
  ];

  try {
    // Append row to Sheet1
    const url = `${SHEETS_API_URL}/${spreadsheetId}/values/Sheet1!A:H:append?valueInputOption=USER_ENTERED&key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: [row],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[Tracking] Failed to write:', error);
      return false;
    }

    console.log(`[Tracking] Logged: ${data.service} - $${(data.estimatedCost || 0).toFixed(4)}`);
    return true;
  } catch (e) {
    console.error('[Tracking] Error:', e.message);
    return false;
  }
}

/**
 * Request tracker class - accumulates costs during a request
 */
class RequestTracker {
  constructor(service, email, inputs) {
    this.service = service;
    this.email = email;
    this.inputs = inputs;
    this.startTime = Date.now();
    this.totalCost = 0;
    this.modelCalls = {};
  }

  /**
   * Track a model call
   */
  addModelCall(model, inputText, outputText) {
    const cost = calculateCost(model, inputText, outputText);
    this.totalCost += cost;

    if (!this.modelCalls[model]) {
      this.modelCalls[model] = { count: 0, cost: 0 };
    }
    this.modelCalls[model].count++;
    this.modelCalls[model].cost += cost;

    return cost;
  }

  /**
   * Finalize and send tracking data
   */
  async finish(results) {
    const duration = (Date.now() - this.startTime) / 1000;

    return trackRequest({
      service: this.service,
      email: this.email,
      inputs: this.inputs,
      estimatedCost: this.totalCost,
      duration,
      results,
      modelCalls: this.modelCalls,
    });
  }
}

/**
 * Create a new request tracker
 */
function createTracker(service, email, inputs) {
  return new RequestTracker(service, email, inputs);
}

module.exports = {
  trackRequest,
  createTracker,
  calculateCost,
  estimateTokens,
  MODEL_COSTS,
};
