'use strict';

/**
 * Reliability Digest — comprehensive reliability reporting from stress lab
 * and quality gate telemetry. Generates structured digests, markdown reports,
 * historical comparisons, and alert thresholds.
 */

const { cluster, getTopBlockers, getRiskScore } = require('./failure-cluster-analyzer');

// ============ DIGEST GENERATION ============

/**
 * Generate a comprehensive reliability digest from stress results and gate results.
 *
 * @param {Object} stressResults - Output from runStressLab() { telemetry, stats }
 * @param {Object} [gateResults] - Optional quality gate results { passed, failed, total, rejections }
 * @returns {Object} Structured digest JSON
 */
function generateDigest(stressResults, gateResults) {
  const telemetry = stressResults.telemetry || stressResults.results || [];
  const stats = stressResults.stats || {};
  const total = stats.total || telemetry.length || 0;
  const passed = stats.passed || 0;
  const failed = stats.failed || 0;
  const runtimeCrashes = stats.runtimeCrashes || 0;
  const dataGateRejections = stats.dataGateRejections || 0;

  // Crash-free rate
  const crashFreeRate = total > 0 ? (total - runtimeCrashes) / total : 1;

  // Gate rejection rate
  const gateTotal = gateResults ? gateResults.total || 0 : total;
  const gateRejections = gateResults
    ? gateResults.rejections || gateResults.failed || 0
    : dataGateRejections;
  const gateRejectionRate = gateTotal > 0 ? gateRejections / gateTotal : 0;

  // Recovery rate: passed / total (survives all mutations)
  const recoveryRate = total > 0 ? passed / total : 1;

  // Determinism score: based on consistency (1.0 if not measured)
  const determinismScore =
    stressResults.determinismScore != null ? stressResults.determinismScore : 1.0;

  // Per-mutation-class failure rates
  const mutationClassFailureRates = {};
  const failuresByMutationClass = stats.failuresByMutationClass || {};
  // Count total seeds per mutation class
  const seedsPerMutationClass = {};
  for (const t of telemetry) {
    for (const cls of t.mutationClasses || []) {
      seedsPerMutationClass[cls] = (seedsPerMutationClass[cls] || 0) + 1;
    }
  }
  for (const [cls, failCount] of Object.entries(failuresByMutationClass)) {
    const totalForClass = seedsPerMutationClass[cls] || failCount;
    mutationClassFailureRates[cls] = {
      failures: failCount,
      total: totalForClass,
      rate: totalForClass > 0 ? failCount / totalForClass : 0,
    };
  }

  // Per-phase failure rates
  const phaseFailureRates = {};
  const failuresByPhase = stats.failuresByPhase || {};
  for (const [phase, count] of Object.entries(failuresByPhase)) {
    phaseFailureRates[phase] = {
      failures: count,
      total,
      rate: total > 0 ? count / total : 0,
    };
  }

  // Top 10 blockers with risk scores
  const blockers = getTopBlockers(telemetry, 10);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      crashFreeRate: Math.round(crashFreeRate * 10000) / 10000,
      gateRejectionRate: Math.round(gateRejectionRate * 10000) / 10000,
      recoveryRate: Math.round(recoveryRate * 10000) / 10000,
      determinismScore,
      total,
      passed,
      failed,
      runtimeCrashes,
      dataGateRejections,
    },
    mutationClassFailureRates,
    phaseFailureRates,
    topBlockers: blockers,
    durationStats: {
      p50: stats.p50Duration || 0,
      p95: stats.p95Duration || 0,
      phaseDurationStats: stats.phaseDurationStats || {},
    },
  };
}

// ============ MARKDOWN FORMAT ============

/**
 * Format a digest as human-readable markdown.
 *
 * @param {Object} digest - Output from generateDigest()
 * @returns {string} Markdown formatted report
 */
function formatDigestMarkdown(digest) {
  const lines = [];
  const s = digest.summary || {};

  lines.push('# Reliability Digest');
  lines.push(`Generated: ${digest.generatedAt || new Date().toISOString()}`);
  lines.push('');

  // Summary KPIs
  lines.push('## Summary');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Crash-Free Rate | ${(s.crashFreeRate * 100).toFixed(2)}% |`);
  lines.push(`| Gate Rejection Rate | ${(s.gateRejectionRate * 100).toFixed(2)}% |`);
  lines.push(`| Recovery Rate | ${(s.recoveryRate * 100).toFixed(2)}% |`);
  lines.push(`| Determinism Score | ${s.determinismScore} |`);
  lines.push(`| Total Seeds | ${s.total} |`);
  lines.push(`| Passed | ${s.passed} |`);
  lines.push(`| Failed | ${s.failed} |`);
  lines.push(`| Runtime Crashes | ${s.runtimeCrashes} |`);
  lines.push(`| Data Gate Rejections | ${s.dataGateRejections} |`);
  lines.push('');

  // Duration stats
  const ds = digest.durationStats || {};
  lines.push('## Duration');
  lines.push(`- p50: ${ds.p50}ms`);
  lines.push(`- p95: ${ds.p95}ms`);
  lines.push('');

  // Mutation class failure rates
  const mcfr = digest.mutationClassFailureRates || {};
  if (Object.keys(mcfr).length > 0) {
    lines.push('## Mutation Class Failure Rates');
    lines.push('| Mutation Class | Failures | Total | Rate |');
    lines.push('|----------------|----------|-------|------|');
    for (const [cls, data] of Object.entries(mcfr)) {
      lines.push(
        `| ${cls} | ${data.failures} | ${data.total} | ${(data.rate * 100).toFixed(1)}% |`
      );
    }
    lines.push('');
  }

  // Phase failure rates
  const pfr = digest.phaseFailureRates || {};
  if (Object.keys(pfr).length > 0) {
    lines.push('## Phase Failure Rates');
    lines.push('| Phase | Failures | Total | Rate |');
    lines.push('|-------|----------|-------|------|');
    for (const [phase, data] of Object.entries(pfr)) {
      lines.push(
        `| ${phase} | ${data.failures} | ${data.total} | ${(data.rate * 100).toFixed(1)}% |`
      );
    }
    lines.push('');
  }

  // Top blockers
  const blockers = digest.topBlockers || [];
  if (blockers.length > 0) {
    lines.push('## Top Blockers');
    lines.push('| Rank | Risk | Count | Signature |');
    lines.push('|------|------|-------|-----------|');
    for (const b of blockers) {
      const sig = (b.signature || '').substring(0, 60).replace(/\|/g, '\\|');
      lines.push(`| ${b.rank} | ${b.riskScore} | ${b.count} | ${sig} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============ TREND COMPARISON ============

/**
 * Compare two digests to identify trends.
 *
 * @param {Object} previous - Previous digest
 * @param {Object} current - Current digest
 * @returns {Object} Trend comparison
 */
function compareDigests(previous, current) {
  const prevSummary = (previous && previous.summary) || {};
  const curSummary = (current && current.summary) || {};

  const prevCrashRate = 1 - (prevSummary.crashFreeRate || 1);
  const curCrashRate = 1 - (curSummary.crashFreeRate || 1);

  // Determine crash rate trend
  let crashRateTrend = 'stable';
  // If no previous data (null/undefined digest), treat as baseline — no trend yet
  if (previous == null) {
    crashRateTrend = 'stable';
  } else if (prevCrashRate === 0 && curCrashRate > 0) {
    crashRateTrend = 'worsening';
  } else if (prevCrashRate > 0 && curCrashRate === 0) {
    crashRateTrend = 'improving';
  } else if (curCrashRate < prevCrashRate * 0.8) {
    crashRateTrend = 'improving';
  } else if (curCrashRate > prevCrashRate * 1.2) {
    crashRateTrend = 'worsening';
  }

  // Find new failures (signatures in current but not previous)
  const prevSignatures = new Set(
    ((previous && previous.topBlockers) || []).map((b) => b.signature)
  );
  const curSignatures = new Set(((current && current.topBlockers) || []).map((b) => b.signature));

  const newFailures = [...curSignatures].filter((s) => !prevSignatures.has(s));
  const fixedFailures = [...prevSignatures].filter((s) => !curSignatures.has(s));

  // KPI deltas
  const crashFreeRateDelta = (curSummary.crashFreeRate || 1) - (prevSummary.crashFreeRate || 1);
  const gateRejectionRateDelta =
    (curSummary.gateRejectionRate || 0) - (prevSummary.gateRejectionRate || 0);
  const recoveryRateDelta = (curSummary.recoveryRate || 1) - (prevSummary.recoveryRate || 1);

  return {
    crashRateTrend,
    newFailures,
    fixedFailures,
    deltas: {
      crashFreeRate: Math.round(crashFreeRateDelta * 10000) / 10000,
      gateRejectionRate: Math.round(gateRejectionRateDelta * 10000) / 10000,
      recoveryRate: Math.round(recoveryRateDelta * 10000) / 10000,
    },
    previous: prevSummary,
    current: curSummary,
  };
}

// ============ ALERT THRESHOLDS ============

/**
 * Default alert thresholds.
 */
const DEFAULT_THRESHOLDS = {
  maxCrashRatePercent: 5,
  maxNewRuntimeCrashes: 0,
  maxGateRejectionRatePercent: 50,
  minDeterminismScore: 0.99,
  minRecoveryRatePercent: 50,
};

/**
 * Check a digest against alert thresholds.
 *
 * @param {Object} digest - Output from generateDigest()
 * @param {Object} [thresholds] - Custom thresholds (merged with defaults)
 * @returns {Array} Array of alert objects { level, metric, message, value, threshold }
 */
function checkAlerts(digest, thresholds) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const s = (digest && digest.summary) || {};
  const alerts = [];

  // Crash rate check
  const crashRatePercent = (1 - (s.crashFreeRate || 1)) * 100;
  if (crashRatePercent > t.maxCrashRatePercent) {
    alerts.push({
      level: 'critical',
      metric: 'crashRate',
      message: `Crash rate ${crashRatePercent.toFixed(2)}% exceeds threshold ${t.maxCrashRatePercent}%`,
      value: crashRatePercent,
      threshold: t.maxCrashRatePercent,
    });
  }

  // New runtime crashes
  const runtimeCrashes = s.runtimeCrashes || 0;
  if (runtimeCrashes > t.maxNewRuntimeCrashes) {
    alerts.push({
      level: 'critical',
      metric: 'runtimeCrashes',
      message: `${runtimeCrashes} runtime crashes detected (threshold: ${t.maxNewRuntimeCrashes})`,
      value: runtimeCrashes,
      threshold: t.maxNewRuntimeCrashes,
    });
  }

  // Gate rejection rate
  const gateRejectionPercent = (s.gateRejectionRate || 0) * 100;
  if (gateRejectionPercent > t.maxGateRejectionRatePercent) {
    alerts.push({
      level: 'warning',
      metric: 'gateRejectionRate',
      message: `Gate rejection rate ${gateRejectionPercent.toFixed(2)}% exceeds threshold ${t.maxGateRejectionRatePercent}%`,
      value: gateRejectionPercent,
      threshold: t.maxGateRejectionRatePercent,
    });
  }

  // Determinism score
  const determinismScore = s.determinismScore != null ? s.determinismScore : 1.0;
  if (determinismScore < t.minDeterminismScore) {
    alerts.push({
      level: 'warning',
      metric: 'determinismScore',
      message: `Determinism score ${determinismScore} below threshold ${t.minDeterminismScore}`,
      value: determinismScore,
      threshold: t.minDeterminismScore,
    });
  }

  // Recovery rate
  const recoveryRatePercent = (s.recoveryRate || 1) * 100;
  if (recoveryRatePercent < t.minRecoveryRatePercent) {
    alerts.push({
      level: 'warning',
      metric: 'recoveryRate',
      message: `Recovery rate ${recoveryRatePercent.toFixed(2)}% below threshold ${t.minRecoveryRatePercent}%`,
      value: recoveryRatePercent,
      threshold: t.minRecoveryRatePercent,
    });
  }

  return alerts;
}

// ============ RELIABILITY KPIs ============

/**
 * Extract key reliability KPIs from a digest.
 *
 * @param {Object} digest - Output from generateDigest()
 * @returns {Object} Key KPIs
 */
function getReliabilityKPIs(digest) {
  const s = (digest && digest.summary) || {};
  const blockers = (digest && digest.topBlockers) || [];

  return {
    crashFreeRate: s.crashFreeRate != null ? s.crashFreeRate : 1,
    meanTimeToGateRejection: computeMTTGR(digest),
    determinismScore: s.determinismScore != null ? s.determinismScore : 1.0,
    topBlockerRisk: blockers.length > 0 ? blockers[0].riskScore : 0,
    topBlockerSignature: blockers.length > 0 ? blockers[0].signature : null,
    totalBlockers: blockers.length,
    runtimeCrashes: s.runtimeCrashes || 0,
    recoveryRate: s.recoveryRate != null ? s.recoveryRate : 1,
  };
}

/**
 * Compute mean time (duration) to gate rejection from phase duration stats.
 * Approximation: average duration of failed seeds.
 */
function computeMTTGR(digest) {
  const ds = (digest && digest.durationStats) || {};
  // Use p50 as approximation of mean duration for gate rejections
  return ds.p50 || 0;
}

// ============ EXPORTS ============

module.exports = {
  generateDigest,
  formatDigestMarkdown,
  compareDigests,
  checkAlerts,
  getReliabilityKPIs,
  DEFAULT_THRESHOLDS,
};
