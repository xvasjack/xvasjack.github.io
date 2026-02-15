/**
 * Google Sheets tracking for API usage and costs
 * Uses Service Account authentication
 * Tracks per-request: service, timestamp, email, inputs, estimated cost
 */

const fetch = require('node-fetch');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

// AsyncLocalStorage for per-request token tracking isolation
const trackingContext = new AsyncLocalStorage();

/**
 * Record real token usage from an API response into the current request's tracker.
 * Called inside AI wrapper functions after receiving the API response.
 * No-op if called outside a trackingContext.run() scope.
 */
function recordTokens(model, inputTokens, outputTokens) {
  const tracker = trackingContext.getStore();
  if (tracker) {
    tracker.addModelCall(model, inputTokens || 0, outputTokens || 0);
  }
}

// Google Sheets API configuration
const SHEETS_API_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Cost estimates per model (USD per 1K tokens)
const MODEL_COSTS = {
  // OpenAI
  'gpt-5.1': { input: 0.00125, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-5-search-api': { input: 0.00125, output: 0.01 },
  // Perplexity
  'sonar-pro': { input: 0.003, output: 0.015 },
  sonar: { input: 0.001, output: 0.001 },
  // Gemini
  'gemini-2.5-flash': { input: 0.00015, output: 0.0006 },
  'gemini-2.5-flash-lite': { input: 0.0001, output: 0.0004 },
  'gemini-2.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-3-flash': { input: 0.00015, output: 0.0006 },
  // Anthropic
  'claude-3-opus': { input: 0.015, output: 0.075 },
  'claude-3-sonnet': { input: 0.003, output: 0.015 },
  'claude-sonnet-4': { input: 0.003, output: 0.015 },
  'claude-3-haiku': { input: 0.00025, output: 0.00125 },
  // DeepSeek
  deepseek: { input: 0.00014, output: 0.00028 },
  'deepseek-chat': { input: 0.00028, output: 0.00042 },
  'deepseek-reasoner': { input: 0.00042, output: 0.00168 },
  // Kimi
  'kimi-k2': { input: 0.0006, output: 0.0025 },
  'gemini-2.0-flash': { input: 0.0001, output: 0.0004 },
};

// Cache access token
let cachedToken = null;
let tokenExpiry = 0;

/**
 * Base64URL encode (no padding, URL-safe)
 */
function base64url(data) {
  return Buffer.from(data)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Create JWT for Google Service Account
 */
function createJWT(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 3600; // 1 hour

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: expiry,
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signInput = `${headerB64}.${payloadB64}`;

  // Sign with RSA-SHA256
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signInput);
  const signature = sign
    .sign(serviceAccount.private_key, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${signInput}.${signature}`;
}

/**
 * Get access token from Google (with caching)
 */
async function getAccessToken(serviceAccount) {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && Date.now() < tokenExpiry - 300000) {
    return cachedToken;
  }

  const jwt = createJWT(serviceAccount);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;

  return cachedToken;
}

/**
 * Estimate token count from text (rough: 1 token ≈ 4 chars)
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * Calculate estimated cost from token counts
 */
function calculateCostFromTokens(model, inputTokens, outputTokens) {
  const m = model?.toLowerCase();
  if (!m) return 0;

  // Exact match first
  let costs = MODEL_COSTS[m];
  if (!costs) {
    // Longest key match (prevents gpt-5.1 matching before gpt-4o-mini)
    const sorted = Object.keys(MODEL_COSTS).sort((a, b) => b.length - a.length);
    const key = sorted.find((k) => m.includes(k));
    costs = key ? MODEL_COSTS[key] : null;
  }
  if (!costs) {
    console.warn(`[Tracking] Unknown model: ${model}`);
    return 0;
  }

  return (inputTokens / 1000) * costs.input + (outputTokens / 1000) * costs.output;
}

/**
 * Calculate estimated cost for a model call
 */
function calculateCost(model, inputText, outputText) {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  return calculateCostFromTokens(model, inputTokens, outputTokens);
}

/**
 * Track a request to Google Sheets
 */
async function trackRequest(data) {
  const spreadsheetId = process.env.TRACKING_SHEET_ID;
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT;

  if (!spreadsheetId || !serviceAccountJson) {
    console.log('[Tracking] Skipped - TRACKING_SHEET_ID or GOOGLE_SERVICE_ACCOUNT not set');
    return false;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (e) {
    console.error('[Tracking] Invalid GOOGLE_SERVICE_ACCOUNT JSON:', e.message);
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
    const accessToken = await getAccessToken(serviceAccount);

    const url = `${SHEETS_API_URL}/${spreadsheetId}/values/Sheet1!A:H:append?valueInputOption=USER_ENTERED`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
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
  addModelCall(model, inputTextOrTokens, outputTextOrTokens) {
    const inputTokens =
      typeof inputTextOrTokens === 'number' ? inputTextOrTokens : estimateTokens(inputTextOrTokens);
    const outputTokens =
      typeof outputTextOrTokens === 'number'
        ? outputTextOrTokens
        : estimateTokens(outputTextOrTokens);
    const cost = calculateCostFromTokens(model, inputTokens, outputTokens);
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
  calculateCostFromTokens,
  estimateTokens,
  MODEL_COSTS,
  trackingContext,
  recordTokens,
};
