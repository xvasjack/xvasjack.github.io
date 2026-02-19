'use strict';

/**
 * Public stage IDs in pipeline execution order.
 * Maps internal pipeline stages to a stable external numbering.
 */
const PUBLIC_STAGES = ['2', '2a', '3', '3a', '4', '4a', '5', '6', '6a', '7', '8', '8a', '9'];

const STAGE_LABELS = {
  2: 'Country Research',
  '2a': 'Country Analysis Review',
  3: 'Synthesis',
  '3a': 'Synthesis Quality Review',
  4: 'Content Readiness Check',
  '4a': 'Content Review Loop',
  5: 'Pre-Build Check',
  6: 'Content Size Check',
  '6a': 'Readability Rewrite',
  7: 'PPT Generation',
  8: 'PPT Structure Hardening',
  '8a': 'Final Deck Review',
  9: 'Email Delivery',
};

const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /sendgrid/i,
  /bearer/i,
  /authorization/i,
];

const MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;

/**
 * Check if a key name looks like it holds a secret.
 */
function isSecretKey(key) {
  return SECRET_KEY_PATTERNS.some((pat) => pat.test(key));
}

/**
 * Recursively sanitize a value for safe hook emission.
 */
function sanitizeValue(value, depth) {
  if (depth > MAX_DEPTH) return '[nested]';
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      return value.slice(0, MAX_STRING_LENGTH) + '...[truncated]';
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeValue(v, depth + 1));
  }

  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSecretKey(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizeValue(val, depth + 1);
    }
  }
  return result;
}

/**
 * Sanitize a stage payload for hook emission.
 * Strips secrets, Buffers, functions, and truncates long strings.
 */
function sanitizeStagePayload(payload) {
  if (payload === null || payload === undefined) return {};
  if (typeof payload !== 'object') {
    return { value: String(payload).slice(0, MAX_STRING_LENGTH) };
  }
  return sanitizeValue(payload, 0);
}

/**
 * Emit a stage hook if defined.
 * Hooks must never crash the pipeline — errors are logged and swallowed.
 */
async function emitHook(hooks, event, stageId, payload) {
  if (!hooks) return;
  const fn = hooks[event];
  if (typeof fn !== 'function') return;
  try {
    const sanitized = sanitizeStagePayload(payload);
    await fn(stageId, sanitized);
  } catch (hookErr) {
    console.warn(`[Hook] ${event}(${stageId}) error: ${hookErr.message}`);
  }
}

/**
 * Check whether the pipeline should stop after the given stage.
 */
function shouldStopAfterStage(currentStage, targetStage) {
  if (!targetStage) return false;
  return currentStage === targetStage;
}

/**
 * Build a partial-success result when stopAfterStage triggers.
 */
function buildPartialResult({ scope, completedStages, stoppedAfterStage, startTime, totalCost }) {
  return {
    success: true,
    partial: true,
    stoppedAfterStage,
    completedStages: completedStages || [],
    scope: scope || null,
    totalCost: totalCost || 0,
    totalTimeSeconds: (Date.now() - startTime) / 1000,
  };
}

module.exports = {
  PUBLIC_STAGES,
  STAGE_LABELS,
  sanitizeStagePayload,
  emitHook,
  shouldStopAfterStage,
  buildPartialResult,
};
