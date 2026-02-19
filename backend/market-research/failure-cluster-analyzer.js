'use strict';

/**
 * Failure Cluster Analyzer — takes telemetry from stress lab,
 * clusters failures by root error signature, causal stage, and
 * mutation class, then produces a prioritized "Top 20 blockers" report.
 */

// ============ ERROR SIGNATURE EXTRACTION ============

/**
 * Extract a normalized error signature from an error message.
 * Strips variable parts (numbers, paths, seed-specific data) to group
 * similar errors together.
 */
function extractErrorSignature(errorMessage) {
  if (!errorMessage || typeof errorMessage !== 'string') return 'unknown-error';

  let sig = errorMessage;

  // Strip file paths
  sig = sig.replace(/\/[^\s:]+\.(js|ts|json|xml):\d+:\d+/g, '<path>');
  sig = sig.replace(/at\s+[^\s]+\s+\([^)]+\)/g, '');

  // Normalize property access patterns (reading 'x') -> (reading PROP)
  sig = sig.replace(/\(reading\s+['"]?\w+['"]?\)/gi, '(reading PROP)');

  // Normalize numbers (but keep key identifiers)
  sig = sig.replace(/\b\d{4,}\b/g, 'N');
  sig = sig.replace(/seed[=\s]*\d+/gi, 'seed=N');

  // Normalize quotes
  sig = sig.replace(/["'`]/g, '');

  // Collapse whitespace
  sig = sig.replace(/\s+/g, ' ').trim();

  // Truncate to reasonable length
  if (sig.length > 120) sig = sig.substring(0, 120);

  return sig || 'unknown-error';
}

// ============ CLUSTERING ============

/**
 * Cluster failures from telemetry results.
 * Groups by: error signature, failed phase, mutation classes.
 *
 * @param {Array} telemetryResults - Array of telemetry objects from stress lab
 * @returns {Object} Clustered failures
 */
function cluster(telemetryResults) {
  if (!Array.isArray(telemetryResults)) {
    return { clusters: [], bySignature: {}, byPhase: {}, byMutationClass: {} };
  }

  const failures = telemetryResults.filter((t) => t && t.status === 'fail');

  // Group by error signature
  const bySignature = {};
  for (const f of failures) {
    const sig = extractErrorSignature(f.error);
    if (!bySignature[sig]) {
      bySignature[sig] = {
        signature: sig,
        seeds: [],
        phases: new Set(),
        mutationClasses: new Set(),
        errorClasses: new Set(),
        sampleError: f.error,
        sampleStack: f.stack,
        count: 0,
      };
    }
    const entry = bySignature[sig];
    entry.seeds.push(f.seed);
    if (f.failedPhase) entry.phases.add(f.failedPhase);
    for (const cls of f.mutationClasses || []) {
      entry.mutationClasses.add(cls);
    }
    if (f.errorClass) entry.errorClasses.add(f.errorClass);
    entry.count++;
  }

  // Convert Sets to arrays for serialization
  const clusters = Object.values(bySignature).map((c) => ({
    ...c,
    phases: [...c.phases],
    mutationClasses: [...c.mutationClasses],
    errorClasses: [...c.errorClasses],
  }));

  // Sort by count (most frequent first)
  clusters.sort((a, b) => b.count - a.count);

  // Group by phase
  const byPhase = {};
  for (const f of failures) {
    const phase = f.failedPhase || 'unknown';
    if (!byPhase[phase]) byPhase[phase] = [];
    byPhase[phase].push(f.seed);
  }

  // Group by mutation class
  const byMutationClass = {};
  for (const f of failures) {
    for (const cls of f.mutationClasses || []) {
      if (!byMutationClass[cls]) byMutationClass[cls] = [];
      byMutationClass[cls].push(f.seed);
    }
  }

  return { clusters, bySignature, byPhase, byMutationClass };
}

// ============ PHASE CONFIDENCE ============

/**
 * Get confidence probability that the cluster's root cause is in a specific phase.
 * Returns an object mapping each phase to a probability (0-1).
 *
 * @param {Object} clusterEntry - A cluster entry from cluster()
 * @returns {Object} Phase confidence probabilities
 */
function getPhaseConfidence(clusterEntry) {
  const confidence = {
    'build-payload': 0,
    'content-size-check': 0,
    'build-ppt': 0,
    'validate-pptx': 0,
  };

  if (!clusterEntry || !clusterEntry.phases || clusterEntry.phases.length === 0) {
    return confidence;
  }

  const phases = clusterEntry.phases;
  const seeds = clusterEntry.seeds || [];
  const totalInCluster = clusterEntry.count || seeds.length || 1;

  // If only one phase appears, high confidence it's the root cause
  if (phases.length === 1) {
    confidence[phases[0]] = 0.95;
    // Small probability it's upstream
    const phaseOrder = ['build-payload', 'content-size-check', 'build-ppt', 'validate-pptx'];
    const idx = phaseOrder.indexOf(phases[0]);
    if (idx > 0) {
      confidence[phaseOrder[idx - 1]] = 0.05;
      confidence[phases[0]] = 0.9;
    }
    return confidence;
  }

  // Multiple phases: distribute proportionally
  // Earlier phases get slightly higher weight as they're more likely to be root cause
  const phaseWeights = {
    'build-payload': 1.5,
    'content-size-check': 1.3,
    'build-ppt': 1.1,
    'validate-pptx': 1.0,
  };

  let totalWeight = 0;
  for (const phase of phases) {
    totalWeight += phaseWeights[phase] || 1.0;
  }

  for (const phase of phases) {
    confidence[phase] = totalWeight > 0 ? (phaseWeights[phase] || 1.0) / totalWeight : 0;
  }

  // Round to 2 decimal places
  for (const key of Object.keys(confidence)) {
    confidence[key] = Math.round(confidence[key] * 100) / 100;
  }

  return confidence;
}

// ============ RISK SCORING ============

/**
 * Compute a paid-run risk score (0-100) for a failure cluster.
 * Higher = more likely to hit in production.
 *
 * Factors:
 * - Frequency weight: how many seeds trigger it (0-40 pts)
 * - Severity weight: runtime-crash vs data-gate (0-30 pts)
 * - Paid-run phase bonus: runtime crashes in build/validate get +5
 * - Mutation breadth: if many mutation classes trigger it, the root cause is fragile (0-15 pts)
 * - Phase: earlier phases = wider blast radius (0-15 pts)
 */
function getRiskScore(clusterEntry, totalSeeds) {
  if (!clusterEntry || totalSeeds <= 0) return 0;

  let score = 0;
  const count = clusterEntry.count || 0;

  // Frequency weight (0-40 pts)
  const frequencyRatio = count / totalSeeds;
  score += Math.min(40, Math.round(frequencyRatio * 400));

  // Severity weight: runtime-crash vs data-gate (0-30 pts)
  const hasRuntimeCrash = (clusterEntry.errorClasses || []).includes('runtime-crash');
  score += hasRuntimeCrash ? 30 : 5;

  // Mutation breadth factor (0-15 pts)
  const mutationCount = (clusterEntry.mutationClasses || []).length;
  score += Math.min(15, mutationCount * 3);

  // Phase factor (0-15 pts)
  const phases = clusterEntry.phases || [];
  const phaseWeights = {
    'build-payload': 15,
    'content-size-check': 12,
    'build-ppt': 8,
    'validate-pptx': 5,
  };
  let maxPhaseWeight = 0;
  for (const phase of phases) {
    maxPhaseWeight = Math.max(maxPhaseWeight, phaseWeights[phase] || 5);
  }
  score += maxPhaseWeight;

  // Paid-run phase bonus: build/validate failures are expensive, but should
  // not outweigh the broader blast radius of earlier-phase failures.
  if (hasRuntimeCrash) {
    const paidPhases = ['build-ppt', 'validate-pptx'];
    const hitsPaidPhase = phases.some((p) => paidPhases.includes(p));
    if (hitsPaidPhase) {
      score += 5;
    }
  }

  return Math.min(100, score);
}

// ============ TOP BLOCKERS ============

/**
 * Get the top N blockers from clustered failures.
 *
 * @param {Array} telemetryResults - Raw telemetry from stress lab
 * @param {number} [topN=20] - Number of top blockers to return
 * @returns {Array} Top blockers with risk scores and replay commands
 */
function getTopBlockers(telemetryResults, topN = 20) {
  if (!Array.isArray(telemetryResults)) return [];

  const totalSeeds = telemetryResults.length;
  const { clusters } = cluster(telemetryResults);

  const blockers = clusters.slice(0, topN).map((c, idx) => ({
    rank: idx + 1,
    signature: c.signature,
    count: c.count,
    seeds: c.seeds.slice(0, 10), // Limit to first 10 seeds for readability
    totalSeeds: c.seeds.length,
    riskScore: getRiskScore(c, totalSeeds),
    errorClasses: c.errorClasses,
    phases: c.phases,
    mutationClasses: c.mutationClasses,
    sampleError: c.sampleError,
    replayCommand: `node stress-lab.js --seed=${c.seeds[0]}`,
  }));

  // Sort by risk score (highest first)
  blockers.sort((a, b) => b.riskScore - a.riskScore);

  // Re-rank after risk sort
  blockers.forEach((b, i) => {
    b.rank = i + 1;
  });

  return blockers;
}

// ============ CRASH TREND TRACKING ============

/**
 * Track runtime crash count over time (across multiple runs).
 * Accepts an array of run summaries and returns trend data.
 *
 * @param {Array} runSummaries - Array of { timestamp, runtimeCrashes, totalSeeds }
 * @returns {Object} Trend analysis
 */
function trackCrashTrend(runSummaries) {
  if (!Array.isArray(runSummaries) || runSummaries.length === 0) {
    return { trend: 'no-data', runs: [], direction: 'flat' };
  }

  const runs = runSummaries
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      timestamp: r.timestamp || new Date().toISOString(),
      crashes: r.runtimeCrashes || 0,
      total: r.totalSeeds || 0,
      crashRate: r.totalSeeds > 0 ? r.runtimeCrashes / r.totalSeeds : 0,
    }));

  if (runs.length < 2) {
    return { trend: 'insufficient-data', runs, direction: 'flat' };
  }

  // Determine direction
  const firstHalf = runs.slice(0, Math.floor(runs.length / 2));
  const secondHalf = runs.slice(Math.floor(runs.length / 2));
  const avgFirst = firstHalf.reduce((sum, r) => sum + r.crashRate, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((sum, r) => sum + r.crashRate, 0) / secondHalf.length;

  let direction = 'flat';
  if (avgSecond < avgFirst * 0.8) direction = 'improving';
  else if (avgSecond > avgFirst * 1.2) direction = 'worsening';

  return { trend: 'tracked', runs, direction };
}

// ============ REPORT FORMAT ============

/**
 * Format top blockers as a markdown report.
 */
function formatBlockersReport(blockers) {
  if (!Array.isArray(blockers) || blockers.length === 0) {
    return '# Top Blockers Report\n\nNo failures found.';
  }

  const lines = [];
  lines.push('# Top Blockers Report');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Total blockers: ${blockers.length}`);
  lines.push('');
  lines.push('| Rank | Risk | Count | Phase | Mutations | Signature | Replay |');
  lines.push('|------|------|-------|-------|-----------|-----------|--------|');

  for (const b of blockers) {
    const sig = (b.signature || '').substring(0, 60).replace(/\|/g, '\\|');
    const mutations = (b.mutationClasses || []).join('+');
    const phases = (b.phases || []).join(',');
    const cls = (b.errorClasses || []).includes('runtime-crash') ? 'BUG' : 'gate';
    lines.push(
      `| ${b.rank} | ${b.riskScore} (${cls}) | ${b.count} | ${phases} | ${mutations} | ${sig} | \`${b.replayCommand}\` |`
    );
  }

  lines.push('');

  // Detailed breakdowns
  for (const b of blockers.slice(0, 5)) {
    lines.push(`### #${b.rank}: ${(b.signature || '').substring(0, 80)}`);
    lines.push(`- Risk Score: ${b.riskScore}`);
    lines.push(`- Occurrences: ${b.totalSeeds}`);
    lines.push(`- Seeds: ${b.seeds.join(', ')}${b.totalSeeds > 10 ? '...' : ''}`);
    lines.push(`- Phases: ${(b.phases || []).join(', ')}`);
    lines.push(`- Mutation Classes: ${(b.mutationClasses || []).join(', ')}`);
    lines.push(`- Sample Error: \`${(b.sampleError || '').substring(0, 200)}\``);
    lines.push(`- Replay: \`${b.replayCommand}\``);
    lines.push('');
  }

  return lines.join('\n');
}

// ============ REPLAY ARTIFACT ============

/**
 * Generate a deterministic replay artifact for a failure cluster.
 * Returns an object with all info needed to reproduce the failure.
 *
 * @param {Object} clusterEntry - A cluster entry from cluster()
 * @returns {Object} Replay artifact
 */
function generateReplayArtifact(clusterEntry) {
  if (!clusterEntry) {
    return { seed: null, mutationClasses: [], command: '', expectedError: null };
  }

  const seed = clusterEntry.seeds && clusterEntry.seeds.length > 0 ? clusterEntry.seeds[0] : null;
  const mutationClasses = clusterEntry.mutationClasses || [];
  const command = seed !== null ? `node stress-lab.js --seed=${seed}` : '';
  const expectedError = clusterEntry.sampleError || null;

  return {
    seed,
    mutationClasses,
    command,
    expectedError,
  };
}

// ============ STACK TRACE SIGNATURE ============

/**
 * Extract a normalized stack trace signature from a stack string.
 * Keeps the first 2-3 meaningful frame locations, strips noise.
 */
function extractStackSignature(stack) {
  if (!stack || typeof stack !== 'string') return '';
  const lines = stack.split('\n');
  const frames = [];
  for (const line of lines) {
    const match = line.match(/at\s+(?:(\S+)\s+)?\(?(\/[^:]+|[^:]+\.js):(\d+):\d+\)?/);
    if (match) {
      const fn = match[1] || 'anonymous';
      const file = (match[2] || '').replace(/^.*\//, ''); // basename only
      const lineNum = match[3];
      frames.push(`${fn}@${file}:${lineNum}`);
      if (frames.length >= 3) break;
    }
  }
  return frames.join(' > ');
}

// ============ COMBINED SIGNATURE ============

/**
 * Create a combined signature from error message and stack trace
 * for more precise clustering.
 */
function extractCombinedSignature(errorMessage, stack) {
  const errSig = extractErrorSignature(errorMessage);
  const stackSig = extractStackSignature(stack);
  if (stackSig) return `${errSig} [${stackSig}]`;
  return errSig;
}

// ============ CLUSTER SUMMARY ============

/**
 * Run full clustering pipeline and return a combined summary.
 * Convenience function that combines cluster + topBlockers + formatted report.
 *
 * @param {Array} telemetryResults - Raw telemetry from stress lab
 * @param {Object} [options] - Options
 * @param {number} [options.topN=20] - Number of top blockers
 * @param {boolean} [options.useStackSignatures=false] - Whether to use combined error+stack signatures
 * @returns {Object} { clusters, topBlockers, report, stats }
 */
function clusterWithSummary(telemetryResults, options = {}) {
  const { topN = 20, useStackSignatures = false } = options;

  if (!Array.isArray(telemetryResults)) {
    return { clusters: [], topBlockers: [], report: 'No data', stats: {} };
  }

  // If using stack signatures, re-cluster with combined signatures
  let clusterResult;
  if (useStackSignatures) {
    const failures = telemetryResults.filter((t) => t && t.status === 'fail');
    const bySignature = {};
    for (const f of failures) {
      const sig = extractCombinedSignature(f.error, f.stack);
      if (!bySignature[sig]) {
        bySignature[sig] = {
          signature: sig,
          seeds: [],
          phases: new Set(),
          mutationClasses: new Set(),
          errorClasses: new Set(),
          sampleError: f.error,
          sampleStack: f.stack,
          count: 0,
        };
      }
      const entry = bySignature[sig];
      entry.seeds.push(f.seed);
      if (f.failedPhase) entry.phases.add(f.failedPhase);
      for (const cls of f.mutationClasses || []) entry.mutationClasses.add(cls);
      if (f.errorClass) entry.errorClasses.add(f.errorClass);
      entry.count++;
    }
    const clusters = Object.values(bySignature).map((c) => ({
      ...c,
      phases: [...c.phases],
      mutationClasses: [...c.mutationClasses],
      errorClasses: [...c.errorClasses],
    }));
    clusters.sort((a, b) => b.count - a.count);
    clusterResult = { clusters, bySignature, byPhase: {}, byMutationClass: {} };
  } else {
    clusterResult = cluster(telemetryResults);
  }

  const topBlockers = getTopBlockers(telemetryResults, topN);
  const report = formatBlockersReport(topBlockers);

  const totalFailures = telemetryResults.filter((t) => t && t.status === 'fail').length;
  const runtimeCrashes = telemetryResults.filter(
    (t) => t && t.status === 'fail' && t.errorClass === 'runtime-crash'
  ).length;

  return {
    clusters: clusterResult.clusters,
    topBlockers,
    report,
    stats: {
      totalSeeds: telemetryResults.length,
      totalFailures,
      runtimeCrashes,
      uniqueSignatures: clusterResult.clusters.length,
    },
  };
}

// ============ EXPORTS ============

module.exports = {
  cluster,
  getTopBlockers,
  getRiskScore,
  getPhaseConfidence,
  trackCrashTrend,
  formatBlockersReport,
  generateReplayArtifact,
  clusterWithSummary,
  __test: {
    extractErrorSignature,
    extractStackSignature,
    extractCombinedSignature,
  },
};
