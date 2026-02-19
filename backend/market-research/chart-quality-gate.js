'use strict';

/**
 * Chart Quality Gate — score, validate, and diagnose chart data.
 *
 * Provides:
 * - scoreChartQuality(chartData)      → 0-100 score
 * - runChartGate(chartData, opts)     → { pass, score, issues[], reasonCodes[] }
 * - generateChartDiagnostics(blocks)  → JSON runInfo artifact
 */

const {
  normalizeChartPayload,
  inferChartIntent,
  detectLengthMismatches,
  REASON,
} = require('./chart-data-normalizer');

// ─── Error class for strict-mode failures ───────────────────────────────────

class ChartGateError extends Error {
  /**
   * @param {string} message
   * @param {string} code — structured error code
   * @param {{ score?: number, issues?: string[], reasonCodes?: string[] }} details
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ChartGateError';
    this.code = code;
    this.score = details.score ?? 0;
    this.issues = details.issues ?? [];
    this.reasonCodes = details.reasonCodes ?? [];
  }
}

// ─── Error codes ────────────────────────────────────────────────────────────

const GATE_CODE = Object.freeze({
  REJECTED_BY_NORMALIZER: 'CHART_REJECTED_BY_NORMALIZER',
  BELOW_MIN_SCORE: 'CHART_BELOW_MIN_SCORE',
});

// ─── scoreChartQuality ──────────────────────────────────────────────────────

/**
 * Score chart data quality on a 0-100 scale.
 *
 * Scoring dimensions (weights sum to 100):
 *   1. Data completeness    (30 pts) — categories present, series present, values present
 *   2. Type stability       (25 pts) — all values numeric, categories are strings, no coercion needed
 *   3. Value range quality  (25 pts) — not all zeros, reasonable spread, no extreme outliers
 *   4. Series balance       (20 pts) — series lengths match categories, consistent naming
 *
 * @param {object} chartData — raw or normalized chart payload
 * @returns {number} 0-100
 */
function scoreChartQuality(chartData) {
  if (!chartData || typeof chartData !== 'object') return 0;

  let score = 0;

  // ── 1. Data completeness (30 pts) ──
  const hasCats = Array.isArray(chartData.categories) && chartData.categories.length > 0;
  const hasSeries = Array.isArray(chartData.series) && chartData.series.length > 0;
  const hasValues =
    hasSeries && chartData.series.some((s) => s && Array.isArray(s.values) && s.values.length > 0);

  if (hasCats) score += 10;
  if (hasSeries) score += 10;
  if (hasValues) score += 10;

  if (!hasCats || !hasSeries || !hasValues) return score; // no point continuing

  const cats = chartData.categories;
  const series = chartData.series;

  // ── 2. Type stability (25 pts) ──
  let typeScore = 25;

  // Check categories are strings
  const nonStringCats = cats.filter((c) => typeof c !== 'string').length;
  if (nonStringCats > 0) typeScore -= Math.min(10, nonStringCats * 2);

  // Check values are numbers
  let badValueCount = 0;
  let totalValueCount = 0;
  for (const s of series) {
    if (!s || !Array.isArray(s.values)) continue;
    for (const v of s.values) {
      totalValueCount++;
      if (typeof v !== 'number' || !Number.isFinite(v)) badValueCount++;
    }
  }
  if (totalValueCount > 0) {
    const badRatio = badValueCount / totalValueCount;
    typeScore -= Math.round(badRatio * 15);
  }

  score += Math.max(0, typeScore);

  // ── 3. Value range quality (25 pts) ──
  let rangeScore = 25;

  // Collect all numeric values
  const allVals = [];
  for (const s of series) {
    if (!s || !Array.isArray(s.values)) continue;
    for (const v of s.values) {
      if (typeof v === 'number' && Number.isFinite(v)) allVals.push(v);
    }
  }

  if (allVals.length === 0) {
    rangeScore = 0;
  } else {
    // All zeros?
    if (allVals.every((v) => v === 0)) {
      rangeScore = 0;
    } else {
      // Check spread (coefficient of variation)
      const mean = allVals.reduce((a, b) => a + b, 0) / allVals.length;
      if (mean === 0) {
        rangeScore -= 10;
      } else {
        const variance = allVals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / allVals.length;
        const cv = Math.sqrt(variance) / Math.abs(mean);
        // Extremely high CV (>10) suggests outlier issues
        if (cv > 10) rangeScore -= 10;
        else if (cv > 5) rangeScore -= 5;
      }

      // Check for negative values in what looks like composition data
      const intent = inferChartIntent(chartData);
      if (intent === 'composition' && allVals.some((v) => v < 0)) {
        rangeScore -= 10;
      }
    }
  }

  score += Math.max(0, rangeScore);

  // ── 4. Series balance (20 pts) ──
  let balanceScore = 20;

  const catLen = cats.length;
  let mismatchCount = 0;
  let missingNameCount = 0;

  for (const s of series) {
    if (!s) {
      missingNameCount++;
      mismatchCount++;
      continue;
    }
    if (!s.name || typeof s.name !== 'string' || s.name.trim() === '') missingNameCount++;
    if (Array.isArray(s.values) && s.values.length !== catLen) mismatchCount++;
  }

  if (mismatchCount > 0) balanceScore -= Math.min(15, mismatchCount * 5);
  if (missingNameCount > 0) balanceScore -= Math.min(5, missingNameCount * 2);

  score += Math.max(0, balanceScore);

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── runChartGate ───────────────────────────────────────────────────────────

/**
 * Run the chart quality gate.
 *
 * @param {object} chartData — raw chart payload
 * @param {{ strict?: boolean, minScore?: number }} opts
 * @returns {{ pass: boolean, score: number, issues: string[], reasonCodes: string[] }}
 * @throws {ChartGateError} in strict mode when gate fails
 */
function runChartGate(chartData, opts = {}) {
  const strict = opts.strict === true;
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : 50;

  const issues = [];
  const reasonCodes = [];

  // Step 1: normalize
  const normResult = normalizeChartPayload(chartData);

  if (normResult.outcome.status === 'rejected') {
    reasonCodes.push(normResult.outcome.reasonCode);
    issues.push(...normResult.issues);

    const result = { pass: false, score: 0, issues, reasonCodes };

    if (strict) {
      throw new ChartGateError(
        `Chart gate failed: ${normResult.outcome.reasonCode}`,
        GATE_CODE.REJECTED_BY_NORMALIZER,
        result
      );
    }

    return result;
  }

  // Carry normalization issues
  if (normResult.issues.length > 0) {
    issues.push(...normResult.issues);
    reasonCodes.push(REASON.COERCED_VALUES);
  }

  // Step 2: length mismatch detection (on original data before normalization fixed it)
  const mismatchResult = detectLengthMismatches(chartData);
  if (mismatchResult.hasMismatch) {
    reasonCodes.push(REASON.SERIES_LENGTH_MISMATCH);
    for (const m of mismatchResult.mismatches) {
      issues.push(
        `series "${m.seriesName}" length (${m.seriesLength}) != categories (${m.categoriesLength})`
      );
    }
  }

  // Step 3: score on the RAW input data (measures incoming quality, not post-fix quality)
  const score = scoreChartQuality(chartData);
  const pass = score >= minScore;

  if (!pass) {
    reasonCodes.push('BELOW_MIN_SCORE');
    issues.push(`Score ${score} below minimum ${minScore}`);
  }

  const result = { pass, score, issues, reasonCodes };

  if (strict && !pass) {
    throw new ChartGateError(
      `Chart gate failed: score ${score} < ${minScore}`,
      GATE_CODE.BELOW_MIN_SCORE,
      result
    );
  }

  return result;
}

// ─── generateChartDiagnostics ───────────────────────────────────────────────

/**
 * Generate per-block chart runInfo for a list of blocks.
 *
 * Each block is expected to have a `chartData` field (or be the chart data itself).
 *
 * @param {Array<object>} blocks — array of block objects
 * @returns {{ timestamp: string, totalBlocks: number, chartsFound: number,
 *             chartsValid: number, chartsRejected: number, chartsNormalized: number,
 *             perBlock: Array<object> }}
 */
function generateChartDiagnostics(blocks) {
  if (!Array.isArray(blocks)) {
    return {
      timestamp: new Date().toISOString(),
      totalBlocks: 0,
      chartsFound: 0,
      chartsValid: 0,
      chartsRejected: 0,
      chartsNormalized: 0,
      perBlock: [],
    };
  }

  let chartsFound = 0;
  let chartsValid = 0;
  let chartsRejected = 0;
  let chartsNormalized = 0;

  const perBlock = blocks.map((block, idx) => {
    // Try to find chart data in the block
    const chartData = block?.chartData || block?.chart_data || block;

    // Check if this looks like chart data
    const hasChartShape =
      chartData &&
      typeof chartData === 'object' &&
      (Array.isArray(chartData.categories) || Array.isArray(chartData.series));

    if (!hasChartShape) {
      return {
        blockIndex: idx,
        hasChart: false,
        status: 'no_chart_data',
        score: null,
        issues: [],
        reasonCodes: [],
        intent: null,
      };
    }

    chartsFound++;

    const normResult = normalizeChartPayload(chartData);
    const intent = inferChartIntent(chartData);
    const score = normResult.normalized ? scoreChartQuality(normResult.normalized) : 0;

    const status = normResult.outcome.status;
    if (status === 'valid') chartsValid++;
    else if (status === 'normalized') chartsNormalized++;
    else if (status === 'rejected') chartsRejected++;

    return {
      blockIndex: idx,
      hasChart: true,
      status,
      score,
      issues: normResult.issues,
      reasonCodes: [normResult.outcome.reasonCode],
      intent,
      wasModified: normResult.wasModified,
    };
  });

  return {
    timestamp: new Date().toISOString(),
    totalBlocks: blocks.length,
    chartsFound,
    chartsValid,
    chartsRejected,
    chartsNormalized,
    perBlock,
  };
}

module.exports = {
  scoreChartQuality,
  runChartGate,
  generateChartDiagnostics,
  ChartGateError,
  GATE_CODE,
};
