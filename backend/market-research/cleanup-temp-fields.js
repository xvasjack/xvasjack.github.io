'use strict';

/**
 * Canonical transient-key sanitizer for market-research pipeline.
 *
 * Single source of truth for detecting and stripping transient/non-template keys
 * produced by AI synthesis (section_N wrappers, _wasArray flags, *_deepen* suffixes,
 * finalReviewGap* leftovers, pure numeric keys, _synthesisError markers).
 *
 * Used by:
 *   - server.js           (pre-build structure gating)
 *   - research-engine.js (synthesis check)
 *   - deck-builder-single.js    (build-time sanitization)
 */

// ---------------------------------------------------------------------------
// Pattern list — superset of all patterns previously scattered across 3 files.
// Order: most specific first so early-exit is meaningful.
// ---------------------------------------------------------------------------
const TRANSIENT_KEY_PATTERNS = [
  /^_/, // underscore-prefixed internal keys (_wasArray, _synthesisError, _debugInfo)
  /^section[_-]?\d+$/i, // section_0, section-1, section2
  /^gap[_-]?\d+$/i, // gap_1, gap-2, gap3
  /^verify[_-]?\d+$/i, // verify_1, verify-2
  /^final[_-]?review[_-]?gap[_-]?\d+$/i, // finalReviewGap1, final_review_gap_2
  /^\d+$/, // pure numeric keys (array-to-object artifacts)
  /deepen/i, // anything containing "deepen" (marketDeepen_2, deepen_policy, etc.)
  /_wasarray$/i, // trailing _wasArray (redundant with ^_ but catches mid-key)
  /_synthesiserror$/i, // trailing _synthesisError
];

// Stable metadata keys that look transient but MUST be preserved.
const STABLE_EXEMPTIONS = new Set(['finalreview']);

/**
 * Returns true when `key` matches a transient pattern and is NOT an exempt stable key.
 *
 * Exemptions:
 *   - `finalReview` (stable review metadata) is always kept.
 *   - Empty/whitespace-only keys are treated as transient.
 */
function isTransientKey(key) {
  const raw = String(key ?? '').trim();
  if (!raw) return true;

  const compact = raw.replace(/\s+/g, '').toLowerCase();
  if (STABLE_EXEMPTIONS.has(compact)) return false;

  return TRANSIENT_KEY_PATTERNS.some((re) => re.test(raw));
}

// ---------------------------------------------------------------------------
// Instrumentation context — lightweight counters per sanitization pass.
// ---------------------------------------------------------------------------

/**
 * Creates a fresh sanitization context for instrumentation.
 * Pass this into `sanitizeTransientKeys` to collect drop stats.
 *
 * @returns {{ droppedTransientKeyCount: number, droppedTransientKeySamples: string[] }}
 */
function createSanitizationContext() {
  return {
    droppedTransientKeyCount: 0,
    droppedTransientKeySamples: [], // capped at 25 samples
  };
}

const MAX_SAMPLES = 25;

function recordDrop(ctx, key, depth) {
  ctx.droppedTransientKeyCount++;
  if (ctx.droppedTransientKeySamples.length < MAX_SAMPLES) {
    ctx.droppedTransientKeySamples.push(`${'  '.repeat(depth)}${key}`);
  }
}

// ---------------------------------------------------------------------------
// Recursive sanitizer
// ---------------------------------------------------------------------------

/**
 * Recursively strips transient keys from a value tree.
 *
 * @param {*} value        — any JSON-serializable value
 * @param {object} [ctx]   — sanitization context from `createSanitizationContext()`
 * @param {object} [opts]  — { maxDepth: 8 }
 * @returns {*}            — cleaned value (new object references; original untouched)
 */
function sanitizeTransientKeys(value, ctx, opts) {
  const maxDepth = opts?.maxDepth ?? 8;
  if (!ctx) ctx = createSanitizationContext();
  return _sanitize(value, ctx, 0, maxDepth);
}

function _sanitize(value, ctx, depth, maxDepth) {
  if (depth > maxDepth) return value;
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => _sanitize(item, ctx, depth + 1, maxDepth));
  }
  if (typeof value !== 'object') return value;

  const cleaned = {};
  for (const [key, child] of Object.entries(value)) {
    if (isTransientKey(key)) {
      recordDrop(ctx, key, depth);
      continue;
    }
    cleaned[key] = _sanitize(child, ctx, depth + 1, maxDepth);
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

/**
 * Logs sanitization results. Call after sanitizeTransientKeys if ctx has drops.
 *
 * @param {string} label   — e.g. "pre-build" or "build:market"
 * @param {object} ctx     — sanitization context
 */
function logSanitizationResult(label, ctx) {
  if (!ctx || ctx.droppedTransientKeyCount === 0) return;
  console.log(
    `[TransientSanitizer:${label}] dropped ${ctx.droppedTransientKeyCount} transient key(s): ${ctx.droppedTransientKeySamples.slice(0, 10).join(', ')}`
  );
}

module.exports = {
  TRANSIENT_KEY_PATTERNS,
  STABLE_EXEMPTIONS,
  isTransientKey,
  createSanitizationContext,
  sanitizeTransientKeys,
  logSanitizationResult,
};
