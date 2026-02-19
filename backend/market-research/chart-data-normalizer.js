'use strict';

/**
 * Chart Data Normalizer — normalize, validate, and classify chart payloads.
 *
 * Replaces noisy console.warn chart-skip warnings with structured ChartOutcome
 * objects. Coerces malformed inputs to safe types so charts build or are
 * explicitly rejected with a reason code.
 */

// ─── Reason codes ───────────────────────────────────────────────────────────

const REASON = Object.freeze({
  VALID: 'VALID',
  COERCED_VALUES: 'COERCED_VALUES',
  COERCED_CATEGORIES: 'COERCED_CATEGORIES',
  FIXED_LENGTH_MISMATCH: 'FIXED_LENGTH_MISMATCH',
  NULL_INPUT: 'NULL_INPUT',
  MISSING_CATEGORIES: 'MISSING_CATEGORIES',
  EMPTY_CATEGORIES: 'EMPTY_CATEGORIES',
  TOO_FEW_CATEGORIES: 'TOO_FEW_CATEGORIES',
  MISSING_SERIES: 'MISSING_SERIES',
  EMPTY_SERIES: 'EMPTY_SERIES',
  NO_VALID_SERIES: 'NO_VALID_SERIES',
  ALL_ZEROS: 'ALL_ZEROS',
  SERIES_LENGTH_MISMATCH: 'SERIES_LENGTH_MISMATCH',
});

// ─── ChartOutcome builder ───────────────────────────────────────────────────

function makeOutcome(status, reasonCode, details = null) {
  return { status, reasonCode, details };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function coerceNumber(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function coerceString(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

// ─── normalizeChartPayload ──────────────────────────────────────────────────

/**
 * Normalize a chart payload for type stability.
 *
 * @param {any} chartData — raw chart data from synthesis
 * @returns {{ normalized: object|null, issues: string[], wasModified: boolean, outcome: object }}
 */
function normalizeChartPayload(chartData) {
  const issues = [];
  let wasModified = false;

  // --- null / undefined / non-object guard ---
  if (!chartData || typeof chartData !== 'object') {
    return {
      normalized: null,
      issues: ['Input is null or not an object'],
      wasModified: false,
      outcome: makeOutcome('rejected', REASON.NULL_INPUT, 'chartData was falsy or non-object'),
    };
  }

  // --- categories ---
  let categories = chartData.categories;
  if (!Array.isArray(categories)) {
    if (categories === null || categories === undefined) {
      return {
        normalized: null,
        issues: ['categories missing'],
        wasModified: false,
        outcome: makeOutcome('rejected', REASON.MISSING_CATEGORIES),
      };
    }
    // Try wrapping a single value
    categories = [categories];
    wasModified = true;
    issues.push('categories was not an array — wrapped');
  }

  if (categories.length === 0) {
    return {
      normalized: null,
      issues: ['categories array is empty'],
      wasModified: false,
      outcome: makeOutcome('rejected', REASON.EMPTY_CATEGORIES),
    };
  }

  if (categories.length < 2) {
    return {
      normalized: null,
      issues: ['fewer than 2 categories'],
      wasModified: false,
      outcome: makeOutcome('rejected', REASON.TOO_FEW_CATEGORIES, `count=${categories.length}`),
    };
  }

  // Coerce categories to strings
  const coercedCategories = categories.map(coerceString);
  if (
    coercedCategories.some(
      (c, i) => c !== String(categories[i]) || typeof categories[i] !== 'string'
    )
  ) {
    wasModified = true;
    issues.push('Some categories coerced to string');
  }

  // --- series ---
  const series = chartData.series;
  if (!Array.isArray(series)) {
    if (series === null || series === undefined) {
      return {
        normalized: null,
        issues: ['series missing'],
        wasModified: false,
        outcome: makeOutcome('rejected', REASON.MISSING_SERIES),
      };
    }
    return {
      normalized: null,
      issues: ['series is not an array'],
      wasModified: false,
      outcome: makeOutcome('rejected', REASON.MISSING_SERIES, 'series was not an array'),
    };
  }

  if (series.length === 0) {
    return {
      normalized: null,
      issues: ['series array is empty'],
      wasModified: false,
      outcome: makeOutcome('rejected', REASON.EMPTY_SERIES),
    };
  }

  // Normalize each series entry
  const normalizedSeries = [];
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    if (!s || typeof s !== 'object') {
      issues.push(`series[${i}] is not an object — skipped`);
      wasModified = true;
      continue;
    }

    const name = coerceString(s.name || `Series ${i + 1}`);
    const values = s.values;

    if (!Array.isArray(values)) {
      issues.push(`series[${i}].values is not an array — skipped`);
      wasModified = true;
      continue;
    }

    // Coerce values to numbers
    const coercedValues = values.map(coerceNumber);
    const hadCoercion = coercedValues.some(
      (v, j) => v !== values[j] || typeof values[j] !== 'number' || !Number.isFinite(values[j])
    );
    if (hadCoercion) {
      wasModified = true;
      issues.push(`series[${i}] had non-numeric values coerced`);
    }

    // Length mismatch: pad or trim to match categories length
    let finalValues = coercedValues;
    if (coercedValues.length !== coercedCategories.length) {
      issues.push(
        `series[${i}] length (${coercedValues.length}) != categories length (${coercedCategories.length})`
      );
      wasModified = true;
      if (coercedValues.length < coercedCategories.length) {
        // Pad with zeros
        finalValues = [
          ...coercedValues,
          ...Array(coercedCategories.length - coercedValues.length).fill(0),
        ];
      } else {
        // Trim
        finalValues = coercedValues.slice(0, coercedCategories.length);
      }
    }

    normalizedSeries.push({ name, values: finalValues });
  }

  if (normalizedSeries.length === 0) {
    return {
      normalized: null,
      issues: [...issues, 'no valid series remained after normalization'],
      wasModified,
      outcome: makeOutcome('rejected', REASON.NO_VALID_SERIES),
    };
  }

  // --- All-zeros check ---
  const allZeros = normalizedSeries.every((s) => s.values.every((v) => v === 0));
  if (allZeros) {
    return {
      normalized: null,
      issues: [...issues, 'all values are zero — no data signal'],
      wasModified,
      outcome: makeOutcome('rejected', REASON.ALL_ZEROS),
    };
  }

  // --- Build result ---
  const normalized = {
    categories: coercedCategories,
    series: normalizedSeries,
  };
  // Preserve unit if present
  if (chartData.unit !== undefined) {
    normalized.unit = coerceString(chartData.unit);
  }
  // Preserve projectedStartIndex
  if (chartData.projectedStartIndex !== undefined) {
    normalized.projectedStartIndex = coerceNumber(chartData.projectedStartIndex);
  }

  const status = wasModified ? 'normalized' : 'valid';

  return {
    normalized,
    issues,
    wasModified,
    outcome: makeOutcome(
      status,
      wasModified ? REASON.COERCED_VALUES : REASON.VALID,
      issues.length ? issues.join('; ') : null
    ),
  };
}

// ─── inferChartIntent ───────────────────────────────────────────────────────

/**
 * Classify chart data as time_series | composition | comparison | unknown.
 *
 * Heuristics:
 * - time_series: categories look like years/dates (4-digit numbers or date patterns)
 * - composition: single series, values sum to ~100 (within 5%), or all positive
 *   and clearly represent parts of a whole
 * - comparison: multiple series with non-temporal categories
 * - unknown: fallback
 *
 * @param {object} chartData — { categories, series }
 * @returns {'time_series'|'composition'|'comparison'|'unknown'}
 */
function inferChartIntent(chartData) {
  if (!chartData || !Array.isArray(chartData.categories) || !Array.isArray(chartData.series)) {
    return 'unknown';
  }

  const { categories, series } = chartData;
  if (categories.length === 0 || series.length === 0) return 'unknown';

  // Check if categories look temporal (years, dates)
  const yearPattern = /^\d{4}$/;
  const datePattern = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$/;
  const quarterPattern = /^Q[1-4]\s*\d{4}$|^\d{4}\s*Q[1-4]$/i;

  const temporalCount = categories.filter(
    (c) =>
      yearPattern.test(String(c)) || datePattern.test(String(c)) || quarterPattern.test(String(c))
  ).length;

  const isTemporal = temporalCount >= categories.length * 0.6;

  if (isTemporal) return 'time_series';

  // Check composition: single series, values are all non-negative, sum close to 100
  if (series.length === 1 && Array.isArray(series[0].values)) {
    const vals = series[0].values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    const allNonNeg = vals.every((v) => v >= 0);
    if (allNonNeg && vals.length > 0) {
      const sum = vals.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) <= 5) return 'composition';
    }
  }

  // Multiple series with non-temporal categories → comparison
  if (series.length >= 2) return 'comparison';

  return 'unknown';
}

// ─── detectLengthMismatches ─────────────────────────────────────────────────

/**
 * Detect label/value length mismatches without modifying data.
 *
 * @param {object} chartData — { categories, series }
 * @returns {{ hasMismatch: boolean, mismatches: Array<{seriesIndex, seriesName, seriesLength, categoriesLength}> }}
 */
function detectLengthMismatches(chartData) {
  if (!chartData || !Array.isArray(chartData.categories) || !Array.isArray(chartData.series)) {
    return { hasMismatch: false, mismatches: [] };
  }

  const catLen = chartData.categories.length;
  const mismatches = [];

  for (let i = 0; i < chartData.series.length; i++) {
    const s = chartData.series[i];
    if (s && Array.isArray(s.values) && s.values.length !== catLen) {
      mismatches.push({
        seriesIndex: i,
        seriesName: s.name || `Series ${i + 1}`,
        seriesLength: s.values.length,
        categoriesLength: catLen,
      });
    }
  }

  return { hasMismatch: mismatches.length > 0, mismatches };
}

module.exports = {
  normalizeChartPayload,
  inferChartIntent,
  detectLengthMismatches,
  REASON,
  // For testing internals
  __test: { coerceNumber, coerceString, makeOutcome },
};
