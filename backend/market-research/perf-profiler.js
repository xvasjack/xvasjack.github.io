// Performance profiler for the market-research PPT pipeline.
// Wraps pipeline stages, records timing/memory/payload metrics,
// detects high-cost late failures, and recommends parallelism tuning.

'use strict';

// ============ CONSTANTS ============

const PIPELINE_STAGES = [
  'scopeParsing',
  'countryResearch',
  'researchQualityGate',
  'readinessGate',
  'synthesis',
  'synthesisQualityGate',
  'pptDataGate',
  'transientKeySanitization',
  'preRenderStructureGate',
  'budgetGate',
  'pptGeneration',
  'pptIntegrity',
  'pptStructuralValidation',
  'formattingFidelityCheck',
  'emailDelivery',
];

// Stages that MUST run sequentially (shared state or data dependency).
const SEQUENTIAL_STAGES = new Set([
  'scopeParsing',         // Must complete before anything else
  'synthesis',            // Depends on all country research results
  'pptGeneration',        // Depends on synthesis + country analyses
  'pptIntegrity',         // Depends on PPT buffer
  'pptStructuralValidation', // Depends on normalized PPT buffer
  'formattingFidelityCheck', // Depends on PPT metrics
  'emailDelivery',        // Depends on validated PPT buffer
]);

// Stages that can safely run in parallel (per-country or independent).
const PARALLELIZABLE_STAGES = new Set([
  'countryResearch',          // Per-country, already batched in pairs
  'researchQualityGate',      // Per-country validation
  'readinessGate',            // Per-country check
  'pptDataGate',              // Per-country validation
  'transientKeySanitization', // Per-country sanitization
  'preRenderStructureGate',   // Per-country structure check
  'budgetGate',               // Per-country budget analysis
]);

const MEMORY_LIMIT_MB = 450;

// ============ STAGE METRICS STORE ============

class StageMetricsStore {
  constructor() {
    this._runs = [];       // Array of complete run records
    this._currentRun = null;
  }

  startRun(runId) {
    this._currentRun = {
      runId: runId || `run_${Date.now()}`,
      startedAt: Date.now(),
      stages: {},
      completedAt: null,
      success: null,
    };
    return this._currentRun.runId;
  }

  endRun(success = true) {
    if (!this._currentRun) return null;
    this._currentRun.completedAt = Date.now();
    this._currentRun.success = success;
    this._runs.push(this._currentRun);
    const run = this._currentRun;
    this._currentRun = null;
    // Keep last 50 runs to avoid memory bloat
    if (this._runs.length > 50) this._runs.shift();
    return run;
  }

  recordStageStart(stageName) {
    if (!this._currentRun) return;
    const mem = process.memoryUsage();
    this._currentRun.stages[stageName] = {
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      failed: false,
      error: null,
      memoryAtStart: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        externalMB: Math.round(mem.external / 1024 / 1024),
      },
      memoryAtEnd: null,
      payloadSizeBytes: null,
    };
  }

  recordStageEnd(stageName, { failed = false, error = null, payloadSizeBytes = null } = {}) {
    if (!this._currentRun || !this._currentRun.stages[stageName]) return;
    const stage = this._currentRun.stages[stageName];
    stage.endTime = Date.now();
    stage.durationMs = stage.endTime - stage.startTime;
    stage.failed = failed;
    stage.error = error;
    const mem = process.memoryUsage();
    stage.memoryAtEnd = {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
    };
    if (payloadSizeBytes != null) {
      stage.payloadSizeBytes = payloadSizeBytes;
    }
  }

  getRuns() {
    return this._runs.slice();
  }

  getCurrentRun() {
    return this._currentRun;
  }

  clear() {
    this._runs = [];
    this._currentRun = null;
  }
}

// Singleton store
const metricsStore = new StageMetricsStore();

// ============ PROFILING WRAPPER ============

/**
 * Wraps an async function as a profiled pipeline stage.
 * Records start/end time, memory, payload size, and errors.
 *
 * @param {string} stageName - Name of the pipeline stage
 * @param {Function} fn - Async function to profile
 * @returns {Function} Wrapped function that records metrics
 */
function profile(stageName, fn) {
  return async function profiledStage(...args) {
    metricsStore.recordStageStart(stageName);
    try {
      const result = await fn(...args);
      const payloadSizeBytes = estimatePayloadSize(result);
      metricsStore.recordStageEnd(stageName, { payloadSizeBytes });
      return result;
    } catch (err) {
      metricsStore.recordStageEnd(stageName, {
        failed: true,
        error: err.message || String(err),
      });
      throw err;
    }
  };
}

function estimatePayloadSize(value) {
  if (value == null) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

// ============ METRICS QUERIES ============

/**
 * Returns per-stage metrics across all recorded runs.
 * Includes p50/p95 duration, avg memory delta, failure rate.
 */
function getStageMetrics() {
  const runs = metricsStore.getRuns();
  if (runs.length === 0) return { runs: 0, stages: {} };

  const stageAgg = {};

  for (const run of runs) {
    for (const [name, data] of Object.entries(run.stages)) {
      if (!stageAgg[name]) {
        stageAgg[name] = { durations: [], memoryDeltas: [], failures: 0, total: 0, payloadSizes: [] };
      }
      const agg = stageAgg[name];
      agg.total++;
      if (data.failed) agg.failures++;
      if (data.durationMs != null) agg.durations.push(data.durationMs);
      if (data.memoryAtStart && data.memoryAtEnd) {
        agg.memoryDeltas.push(data.memoryAtEnd.heapUsedMB - data.memoryAtStart.heapUsedMB);
      }
      if (data.payloadSizeBytes != null) {
        agg.payloadSizes.push(data.payloadSizeBytes);
      }
    }
  }

  const stages = {};
  for (const [name, agg] of Object.entries(stageAgg)) {
    const sorted = agg.durations.slice().sort((a, b) => a - b);
    stages[name] = {
      runs: agg.total,
      failureRate: agg.total > 0 ? Number((agg.failures / agg.total).toFixed(3)) : 0,
      p50DurationMs: percentile(sorted, 0.5),
      p95DurationMs: percentile(sorted, 0.95),
      avgMemoryDeltaMB: avg(agg.memoryDeltas),
      avgPayloadSizeBytes: avg(agg.payloadSizes),
      isParallelizable: PARALLELIZABLE_STAGES.has(name),
    };
  }

  return { runs: runs.length, stages };
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.ceil(p * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

function avg(arr) {
  if (arr.length === 0) return null;
  return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
}

// ============ HIGH-COST LATE-FAILURE DETECTION ============

/**
 * Identifies stages where failures happen AFTER significant work.
 * Scores each stage by (cumulative time before failure) * (failure rate).
 * Recommends moving cheap checks earlier.
 */
function getHighCostStages() {
  const runs = metricsStore.getRuns();
  if (runs.length === 0) return { stages: [], recommendations: [] };

  // Collect per-stage failure info with cumulative time at failure
  const stageFailureData = {};

  for (const run of runs) {
    const stageEntries = Object.entries(run.stages).sort(
      (a, b) => (a[1].startTime || 0) - (b[1].startTime || 0)
    );

    let cumulativeMs = 0;
    for (const [name, data] of stageEntries) {
      cumulativeMs += data.durationMs || 0;

      if (!stageFailureData[name]) {
        stageFailureData[name] = { failures: 0, total: 0, cumulativeMsAtFailure: [] };
      }
      stageFailureData[name].total++;
      if (data.failed) {
        stageFailureData[name].failures++;
        stageFailureData[name].cumulativeMsAtFailure.push(cumulativeMs);
      }
    }
  }

  const stages = [];
  for (const [name, data] of Object.entries(stageFailureData)) {
    const failureRate = data.total > 0 ? data.failures / data.total : 0;
    const avgCumulativeMs =
      data.cumulativeMsAtFailure.length > 0
        ? Math.round(
            data.cumulativeMsAtFailure.reduce((s, v) => s + v, 0) /
              data.cumulativeMsAtFailure.length
          )
        : 0;
    const costOfFailure = Math.round(avgCumulativeMs * failureRate);

    stages.push({
      stage: name,
      failureRate: Number(failureRate.toFixed(3)),
      avgCumulativeMsAtFailure: avgCumulativeMs,
      costOfFailure,
      totalRuns: data.total,
      totalFailures: data.failures,
    });
  }

  // Sort by costOfFailure descending
  stages.sort((a, b) => b.costOfFailure - a.costOfFailure);

  // Generate recommendations
  const recommendations = [];
  for (const s of stages) {
    if (s.costOfFailure > 0 && s.failureRate > 0.1) {
      const stageIdx = PIPELINE_STAGES.indexOf(s.stage);
      if (stageIdx > 3) {
        recommendations.push(
          `Move "${s.stage}" checks earlier in the pipeline. ` +
            `Current cost-of-failure: ${s.costOfFailure}ms ` +
            `(${Math.round(s.failureRate * 100)}% failure rate after avg ${s.avgCumulativeMsAtFailure}ms of work).`
        );
      }
    }
  }

  return { stages, recommendations };
}

// ============ SAFE PARALLELISM TUNING ============

/**
 * Analyzes which stages can safely run in parallel and recommends
 * max concurrency under the 450MB memory constraint.
 */
function getParallelismRecommendations() {
  const metrics = getStageMetrics();
  const recommendations = [];

  for (const [name, data] of Object.entries(metrics.stages)) {
    if (!data.isParallelizable) continue;

    const memPerInstance = Math.abs(data.avgMemoryDeltaMB || 20);
    // Estimate max concurrency: leave 100MB headroom for base process
    const availableMB = MEMORY_LIMIT_MB - 100;
    const maxConcurrency = memPerInstance > 0 ? Math.max(1, Math.floor(availableMB / memPerInstance)) : 4;
    // Cap at reasonable limit
    const recommended = Math.min(maxConcurrency, 6);

    recommendations.push({
      stage: name,
      isParallelizable: true,
      avgMemoryDeltaMB: memPerInstance,
      maxConcurrencyUnder450MB: recommended,
      p95DurationMs: data.p95DurationMs,
    });
  }

  // Add sequential stages for completeness
  for (const name of SEQUENTIAL_STAGES) {
    if (!metrics.stages[name]) continue;
    recommendations.push({
      stage: name,
      isParallelizable: false,
      reason: 'Sequential dependency — shared state or pipeline data dependency',
      p95DurationMs: metrics.stages[name].p95DurationMs,
    });
  }

  return recommendations;
}

// ============ BUDGET GATE OBSERVABILITY ============

/**
 * Generates telemetry from budget gate results.
 * @param {object} budgetResult - Output of runBudgetGate()
 * @param {string} country - Country name
 * @returns {object} Telemetry object
 */
function budgetGateTelemetry(budgetResult, country) {
  if (!budgetResult || !budgetResult.report) {
    return { country, error: 'No budget result provided' };
  }

  const { report, compactionLog } = budgetResult;
  const fieldsCompacted = compactionLog ? compactionLog.length : 0;

  // Risk level breakdown from field budgets
  const fieldAnalysis = {
    total: (report.fieldBudgets || []).length,
    exceeded: (report.fieldBudgets || []).filter((f) => f.exceeded).length,
    doubleExceeded: (report.fieldBudgets || []).filter(
      (f) => f.exceeded && f.charCount > f.limit * 2
    ).length,
  };

  // Table density breakdown
  const tableAnalysis = {
    total: (report.tableDensity || []).length,
    overBudget: (report.tableDensity || []).filter((t) => t.overBudget).length,
  };

  // Chart sanity breakdown
  const chartAnalysis = {
    total: (report.chartSanity || []).length,
    withIssues: (report.chartSanity || []).filter((c) => c.issue).length,
  };

  // Estimate quality impact of compaction
  let qualityImpact = 'none';
  if (fieldsCompacted === 0) {
    qualityImpact = 'none';
  } else if (fieldsCompacted <= 3) {
    qualityImpact = 'minimal';
  } else if (fieldsCompacted <= 8) {
    qualityImpact = 'moderate';
  } else {
    qualityImpact = 'significant';
  }

  // Compaction details
  const compactionDetails = (compactionLog || []).map((entry) => ({
    field: `${entry.section}.${entry.key}`,
    action: entry.action,
    charsBefore: entry.before,
    charsAfter: entry.after,
    reduction: entry.before > 0 ? Math.round((1 - entry.after / entry.before) * 100) : 0,
  }));

  return {
    country,
    risk: report.risk,
    issueCount: (report.issues || []).length,
    fieldsCompacted,
    qualityImpact,
    fieldAnalysis,
    tableAnalysis,
    chartAnalysis,
    compactionDetails,
  };
}

// ============ PERFORMANCE SUMMARY ============

/**
 * Consolidated performance view: total time, per-stage breakdown,
 * memory peaks, parallelism utilization.
 * @returns {object} Performance summary
 */
function getPerformanceSummary() {
  const runs = metricsStore.getRuns();
  const currentRun = metricsStore.getCurrentRun();
  const latestRun = currentRun || (runs.length > 0 ? runs[runs.length - 1] : null);

  if (!latestRun) {
    return {
      hasData: false,
      totalRuns: runs.length,
      latest: null,
    };
  }

  // Total time
  let totalMs = 0;
  if (latestRun.completedAt && latestRun.startedAt) {
    totalMs = latestRun.completedAt - latestRun.startedAt;
  } else {
    for (const data of Object.values(latestRun.stages || {})) {
      totalMs += data.durationMs || 0;
    }
  }

  // Per-stage breakdown
  const stageBreakdown = [];
  let peakHeapMB = 0;
  let peakRssMB = 0;
  let peakStage = null;
  let parallelStageCount = 0;
  let totalParallelMs = 0;
  let totalSequentialMs = 0;

  for (const [name, data] of Object.entries(latestRun.stages || {})) {
    const isParallel = PARALLELIZABLE_STAGES.has(name);

    stageBreakdown.push({
      name,
      durationMs: data.durationMs || 0,
      durationSec: data.durationMs ? Number((data.durationMs / 1000).toFixed(1)) : 0,
      percentOfTotal: totalMs > 0 ? Number(((data.durationMs || 0) / totalMs * 100).toFixed(1)) : 0,
      failed: data.failed || false,
      memoryStartMB: data.memoryAtStart?.heapUsedMB || 0,
      memoryEndMB: data.memoryAtEnd?.heapUsedMB || 0,
      memoryDeltaMB: (data.memoryAtEnd?.heapUsedMB || 0) - (data.memoryAtStart?.heapUsedMB || 0),
      payloadSizeBytes: data.payloadSizeBytes || 0,
      isParallelizable: isParallel,
    });

    if (isParallel) {
      parallelStageCount++;
      totalParallelMs += data.durationMs || 0;
    } else {
      totalSequentialMs += data.durationMs || 0;
    }

    const endHeap = data.memoryAtEnd?.heapUsedMB || 0;
    const endRss = data.memoryAtEnd?.rssMB || 0;
    if (endHeap > peakHeapMB) {
      peakHeapMB = endHeap;
      peakStage = name;
    }
    if (endRss > peakRssMB) {
      peakRssMB = endRss;
    }
  }

  // Sort by duration descending
  stageBreakdown.sort((a, b) => b.durationMs - a.durationMs);

  // Parallelism utilization: ratio of parallel-eligible time to total
  const parallelismUtilization = totalMs > 0
    ? Number((totalParallelMs / totalMs * 100).toFixed(1))
    : 0;

  return {
    hasData: true,
    totalRuns: runs.length,
    latest: {
      runId: latestRun.runId,
      success: latestRun.success,
      totalMs,
      totalSec: Number((totalMs / 1000).toFixed(1)),
      totalMin: Number((totalMs / 60000).toFixed(1)),
      stageCount: Object.keys(latestRun.stages || {}).length,
      stages: stageBreakdown,
      memory: {
        peakHeapMB,
        peakRssMB,
        peakStage,
        headroomMB: MEMORY_LIMIT_MB - peakRssMB,
        utilizationPercent: Math.round((peakRssMB / MEMORY_LIMIT_MB) * 100),
      },
      parallelism: {
        parallelStageCount,
        totalParallelMs,
        totalSequentialMs,
        parallelismUtilization,
      },
    },
  };
}

// ============ EXPORTS ============

module.exports = {
  PIPELINE_STAGES,
  SEQUENTIAL_STAGES,
  PARALLELIZABLE_STAGES,
  metricsStore,
  profile,
  getStageMetrics,
  getHighCostStages,
  getParallelismRecommendations,
  budgetGateTelemetry,
  estimatePayloadSize,
  getPerformanceSummary,
};
