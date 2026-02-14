// Post-run auto-summary — generates a structured summary after any pipeline run.
// Consumes perf-profiler metrics, quality gate scores, budget gate actions, and PPTX integrity.

'use strict';

const { metricsStore, budgetGateTelemetry } = require('./perf-profiler');

// ============ HEALTH THRESHOLDS ============

const HEALTH_THRESHOLDS = {
  totalDurationMinutes: { good: 30, warn: 45 },
  peakMemoryMB: { good: 300, warn: 400 },
  qualityGateMinScore: 60,
  integrityMinScore: 90,
  budgetGateMaxCompactions: 10,
};

// ============ GENERATE SUMMARY ============

/**
 * Generates a post-run summary from pipeline run data.
 *
 * @param {object} options
 * @param {object} [options.diagnostics] - lastRunDiagnostics from server.js
 * @param {object} [options.pptStructureValidation] - PPTX validation result
 * @param {Array}  [options.budgetResults] - Array of { country, budgetResult } from budget gate
 * @param {number} [options.startTime] - Pipeline start timestamp (ms)
 * @param {number} [options.endTime] - Pipeline end timestamp (ms)
 * @returns {object} Summary object
 */
function generateSummary(options = {}) {
  const { diagnostics, pptStructureValidation, budgetResults, startTime, endTime } = options;

  // Duration breakdown from profiler
  const durationBreakdown = buildDurationBreakdown(startTime, endTime);

  // Memory stats
  const memoryStats = buildMemoryStats();

  // Quality gate scores
  const qualityGateScores = buildQualityGateScores(diagnostics);

  // Budget gate actions
  const budgetGateActions = buildBudgetGateActions(diagnostics, budgetResults);

  // PPTX integrity score
  const integrityScore = buildIntegrityScore(diagnostics, pptStructureValidation);

  // Overall health assessment
  const health = assessHealth(durationBreakdown, memoryStats, qualityGateScores, budgetGateActions, integrityScore);

  return {
    timestamp: new Date().toISOString(),
    duration: durationBreakdown,
    memory: memoryStats,
    qualityGates: qualityGateScores,
    budgetGate: budgetGateActions,
    integrity: integrityScore,
    health,
  };
}

// ============ DURATION BREAKDOWN ============

function buildDurationBreakdown(startTime, endTime) {
  const currentRun = metricsStore.getCurrentRun();
  const stages = {};

  // From profiler if available
  const runData = currentRun || (metricsStore.getRuns().length > 0 ? metricsStore.getRuns().slice(-1)[0] : null);

  if (runData && runData.stages) {
    for (const [name, data] of Object.entries(runData.stages)) {
      stages[name] = {
        durationMs: data.durationMs || 0,
        durationSec: data.durationMs ? Number((data.durationMs / 1000).toFixed(1)) : 0,
        failed: data.failed || false,
      };
    }
  }

  const totalMs = startTime && endTime ? endTime - startTime : sumDurations(stages);
  const totalSec = Number((totalMs / 1000).toFixed(1));
  const totalMin = Number((totalMs / 60000).toFixed(1));

  // Find slowest stage
  let slowestStage = null;
  let slowestMs = 0;
  for (const [name, data] of Object.entries(stages)) {
    if (data.durationMs > slowestMs) {
      slowestMs = data.durationMs;
      slowestStage = name;
    }
  }

  return {
    totalMs,
    totalSec,
    totalMin,
    stages,
    slowestStage,
    slowestStageMs: slowestMs,
  };
}

function sumDurations(stages) {
  let total = 0;
  for (const data of Object.values(stages)) {
    total += data.durationMs || 0;
  }
  return total;
}

// ============ MEMORY STATS ============

function buildMemoryStats() {
  const current = process.memoryUsage();
  const currentMB = {
    heapUsed: Math.round(current.heapUsed / 1024 / 1024),
    heapTotal: Math.round(current.heapTotal / 1024 / 1024),
    rss: Math.round(current.rss / 1024 / 1024),
    external: Math.round(current.external / 1024 / 1024),
  };

  // Find peak from profiler data
  let peakHeapMB = currentMB.heapUsed;
  let peakRssMB = currentMB.rss;
  let peakStage = null;

  const runData =
    metricsStore.getCurrentRun() ||
    (metricsStore.getRuns().length > 0 ? metricsStore.getRuns().slice(-1)[0] : null);

  if (runData && runData.stages) {
    for (const [name, data] of Object.entries(runData.stages)) {
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
  }

  return {
    current: currentMB,
    peakHeapMB,
    peakRssMB,
    peakStage,
    memoryLimitMB: 450,
    headroomMB: 450 - peakRssMB,
    utilizationPercent: Math.round((peakRssMB / 450) * 100),
  };
}

// ============ QUALITY GATE SCORES ============

function buildQualityGateScores(diagnostics) {
  const scores = {
    researchQuality: null,
    synthesisQuality: null,
    pptDataGate: null,
    readinessGate: null,
  };

  if (!diagnostics) return scores;

  // Research quality — from country diagnostics
  if (Array.isArray(diagnostics.countries)) {
    const validScores = diagnostics.countries
      .map((c) => c.synthesisScores?.overall)
      .filter((s) => s != null);
    if (validScores.length > 0) {
      scores.researchQuality = {
        avgScore: Math.round(validScores.reduce((s, v) => s + v, 0) / validScores.length),
        perCountry: diagnostics.countries.map((c) => ({
          country: c.country,
          score: c.synthesisScores?.overall || null,
          valid: c.synthesisValid,
        })),
      };
    }
  }

  // Synthesis quality gate
  if (diagnostics.synthesisGate) {
    scores.synthesisQuality = {
      pass: diagnostics.synthesisGate.pass,
      overall: diagnostics.synthesisGate.overall,
      failures: diagnostics.synthesisGate.failures || [],
    };
  }

  // PPT data gate
  if (diagnostics.pptDataGateFailures) {
    scores.pptDataGate = {
      pass: false,
      failures: diagnostics.pptDataGateFailures,
    };
  } else {
    scores.pptDataGate = { pass: true, failures: [] };
  }

  // Readiness gate
  if (diagnostics.notReadyCountries) {
    scores.readinessGate = {
      pass: false,
      softBypassed: diagnostics.qualityGateSoftBypass || false,
      draftBypassed: diagnostics.qualityGateBypassedForDraft || false,
      notReady: diagnostics.notReadyCountries,
    };
  } else {
    scores.readinessGate = { pass: true, softBypassed: false, draftBypassed: false };
  }

  return scores;
}

// ============ BUDGET GATE ACTIONS ============

function buildBudgetGateActions(diagnostics, budgetResults) {
  const actions = {
    totalCompactions: 0,
    worstRisk: 'low',
    perCountry: [],
  };

  const riskOrder = { low: 0, medium: 1, high: 2 };

  // From diagnostics
  if (diagnostics?.budgetGate) {
    for (const [country, bg] of Object.entries(diagnostics.budgetGate)) {
      actions.perCountry.push({
        country,
        risk: bg.risk,
        issueCount: (bg.issues || []).length,
        compactions: bg.compacted || 0,
      });
      actions.totalCompactions += bg.compacted || 0;
      if ((riskOrder[bg.risk] || 0) > (riskOrder[actions.worstRisk] || 0)) {
        actions.worstRisk = bg.risk;
      }
    }
  }

  // From direct budget results (richer telemetry)
  if (Array.isArray(budgetResults)) {
    for (const { country, budgetResult } of budgetResults) {
      const telemetry = budgetGateTelemetry(budgetResult, country);
      const existing = actions.perCountry.find((p) => p.country === country);
      if (existing) {
        existing.telemetry = telemetry;
      } else {
        actions.perCountry.push({
          country,
          risk: telemetry.risk,
          issueCount: telemetry.issueCount,
          compactions: telemetry.fieldsCompacted,
          telemetry,
        });
        actions.totalCompactions += telemetry.fieldsCompacted;
        if ((riskOrder[telemetry.risk] || 0) > (riskOrder[actions.worstRisk] || 0)) {
          actions.worstRisk = telemetry.risk;
        }
      }
    }
  }

  return actions;
}

// ============ INTEGRITY SCORE ============

function buildIntegrityScore(diagnostics, pptStructureValidation) {
  const integrity = {
    score: 100,
    valid: true,
    checks: {
      structureValid: null,
      passedChecks: 0,
      failedChecks: 0,
      warningChecks: 0,
    },
    pptMetrics: null,
  };

  if (pptStructureValidation) {
    integrity.checks.structureValid = pptStructureValidation.valid;
    integrity.checks.passedChecks = pptStructureValidation.summary?.passed || 0;
    integrity.checks.failedChecks = pptStructureValidation.summary?.failed || 0;
    integrity.checks.warningChecks = pptStructureValidation.summary?.warnings || 0;
    integrity.valid = pptStructureValidation.valid;

    const total =
      integrity.checks.passedChecks + integrity.checks.failedChecks + integrity.checks.warningChecks;
    if (total > 0) {
      integrity.score = Math.round((integrity.checks.passedChecks / total) * 100);
    }
  } else if (diagnostics?.pptStructure) {
    const ps = diagnostics.pptStructure;
    integrity.checks.structureValid = ps.valid;
    integrity.checks.passedChecks = ps.passed || 0;
    integrity.checks.failedChecks = ps.failed || 0;
    integrity.checks.warningChecks = ps.warnings || 0;
    integrity.valid = ps.valid;

    const total = (ps.passed || 0) + (ps.failed || 0) + (ps.warnings || 0);
    if (total > 0) {
      integrity.score = Math.round(((ps.passed || 0) / total) * 100);
    }
  }

  if (diagnostics?.ppt) {
    integrity.pptMetrics = {
      templateCoverage: diagnostics.ppt.templateCoverage,
      slideRenderFailures: diagnostics.ppt.slideRenderFailureCount,
      geometryIssues: diagnostics.ppt.geometryIssueCount,
      budgetGateRisk: diagnostics.ppt.budgetGateRisk,
    };
  }

  return integrity;
}

// ============ HEALTH ASSESSMENT ============

function assessHealth(duration, memory, qualityGates, budgetGate, integrity) {
  const issues = [];
  let status = 'healthy';

  // Duration check
  if (duration.totalMin > HEALTH_THRESHOLDS.totalDurationMinutes.warn) {
    issues.push(`Slow run: ${duration.totalMin}min (warn threshold: ${HEALTH_THRESHOLDS.totalDurationMinutes.warn}min)`);
    status = 'degraded';
  } else if (duration.totalMin > HEALTH_THRESHOLDS.totalDurationMinutes.good) {
    issues.push(`Above target: ${duration.totalMin}min (target: ${HEALTH_THRESHOLDS.totalDurationMinutes.good}min)`);
  }

  // Memory check
  if (memory.peakRssMB > HEALTH_THRESHOLDS.peakMemoryMB.warn) {
    issues.push(`High memory: ${memory.peakRssMB}MB peak RSS (limit: 450MB)`);
    status = 'degraded';
  } else if (memory.peakRssMB > HEALTH_THRESHOLDS.peakMemoryMB.good) {
    issues.push(`Elevated memory: ${memory.peakRssMB}MB peak RSS`);
  }

  // Quality gates
  if (qualityGates.readinessGate && !qualityGates.readinessGate.pass) {
    if (qualityGates.readinessGate.softBypassed) {
      issues.push('Readiness gate soft-bypassed');
    } else if (qualityGates.readinessGate.draftBypassed) {
      issues.push('Readiness gate bypassed (draft mode)');
    } else {
      issues.push('Readiness gate failed');
      status = 'unhealthy';
    }
  }

  // Budget gate
  if (budgetGate.totalCompactions > HEALTH_THRESHOLDS.budgetGateMaxCompactions) {
    issues.push(`Heavy compaction: ${budgetGate.totalCompactions} fields compacted`);
    if (status !== 'unhealthy') status = 'degraded';
  }
  if (budgetGate.worstRisk === 'high') {
    issues.push('Budget gate risk: high');
    if (status !== 'unhealthy') status = 'degraded';
  }

  // Integrity
  if (!integrity.valid) {
    issues.push('PPTX integrity validation failed');
    status = 'unhealthy';
  } else if (integrity.score < HEALTH_THRESHOLDS.integrityMinScore) {
    issues.push(`Low integrity score: ${integrity.score}/100`);
    if (status !== 'unhealthy') status = 'degraded';
  }

  return {
    status,
    issueCount: issues.length,
    issues,
    recommendation:
      status === 'healthy'
        ? 'Pipeline run completed within normal parameters.'
        : status === 'degraded'
          ? 'Pipeline completed but with warnings. Review issues above.'
          : 'Pipeline has failures requiring attention. See issues above.',
  };
}

// ============ FORMAT SUMMARY (text) ============

/**
 * Formats a summary object into a human-readable text block.
 * @param {object} summary - Output of generateSummary()
 * @returns {string}
 */
function formatSummary(summary) {
  const lines = [];
  lines.push('=== POST-RUN SUMMARY ===');
  lines.push(`Timestamp: ${summary.timestamp}`);
  lines.push('');

  // Duration
  lines.push(`Duration: ${summary.duration.totalSec}s (${summary.duration.totalMin}min)`);
  if (summary.duration.slowestStage) {
    lines.push(
      `  Slowest stage: ${summary.duration.slowestStage} (${(summary.duration.slowestStageMs / 1000).toFixed(1)}s)`
    );
  }
  lines.push('');

  // Memory
  lines.push(`Memory: peak heap=${summary.memory.peakHeapMB}MB, peak RSS=${summary.memory.peakRssMB}MB`);
  lines.push(`  Headroom: ${summary.memory.headroomMB}MB (${100 - summary.memory.utilizationPercent}% available)`);
  if (summary.memory.peakStage) {
    lines.push(`  Peak at: ${summary.memory.peakStage}`);
  }
  lines.push('');

  // Quality gates
  lines.push('Quality Gates:');
  if (summary.qualityGates.researchQuality) {
    lines.push(`  Research: avg=${summary.qualityGates.researchQuality.avgScore}`);
  }
  if (summary.qualityGates.synthesisQuality) {
    lines.push(
      `  Synthesis: ${summary.qualityGates.synthesisQuality.pass ? 'PASS' : 'FAIL'} (${summary.qualityGates.synthesisQuality.overall}/100)`
    );
  }
  lines.push(`  PPT Data: ${summary.qualityGates.pptDataGate?.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`  Readiness: ${summary.qualityGates.readinessGate?.pass ? 'PASS' : 'FAIL'}`);
  lines.push('');

  // Budget gate
  lines.push(`Budget Gate: risk=${summary.budgetGate.worstRisk}, compactions=${summary.budgetGate.totalCompactions}`);
  lines.push('');

  // Integrity
  lines.push(`Integrity: ${summary.integrity.score}/100 (${summary.integrity.valid ? 'valid' : 'INVALID'})`);
  lines.push('');

  // Health
  lines.push(`Health: ${summary.health.status.toUpperCase()}`);
  if (summary.health.issues.length > 0) {
    for (const issue of summary.health.issues) {
      lines.push(`  - ${issue}`);
    }
  }
  lines.push(summary.health.recommendation);

  return lines.join('\n');
}

// ============ TIMING REPORT ============

/**
 * Returns per-stage timing with bottleneck identification.
 * Output is CI-artifact friendly (valid JSON, no ANSI codes).
 * @param {object} summary - Output of generateSummary()
 * @returns {object} Timing report
 */
function getTimingReport(summary) {
  if (!summary || !summary.duration) {
    return {
      totalMs: 0,
      totalSec: 0,
      stages: [],
      bottleneck: null,
      bottleneckPercent: 0,
    };
  }

  const { totalMs, totalSec, stages, slowestStage, slowestStageMs } = summary.duration;
  const stageList = Object.entries(stages || {})
    .map(([name, data]) => ({
      name,
      durationMs: data.durationMs || 0,
      durationSec: data.durationSec || 0,
      percentOfTotal: totalMs > 0 ? Number(((data.durationMs || 0) / totalMs * 100).toFixed(1)) : 0,
      failed: data.failed || false,
    }))
    .sort((a, b) => b.durationMs - a.durationMs);

  return {
    totalMs: totalMs || 0,
    totalSec: totalSec || 0,
    stages: stageList,
    bottleneck: slowestStage || null,
    bottleneckMs: slowestStageMs || 0,
    bottleneckPercent: totalMs > 0 && slowestStageMs ? Number((slowestStageMs / totalMs * 100).toFixed(1)) : 0,
  };
}

// ============ MEMORY REPORT ============

/**
 * Returns peak memory, growth rate, and GC pressure indicators.
 * Output is CI-artifact friendly (valid JSON, no ANSI codes).
 * @param {object} summary - Output of generateSummary()
 * @returns {object} Memory report
 */
function getMemoryReport(summary) {
  if (!summary || !summary.memory) {
    return {
      peakHeapMB: 0,
      peakRssMB: 0,
      peakStage: null,
      headroomMB: 450,
      utilizationPercent: 0,
      gcPressure: 'none',
      growthRate: null,
    };
  }

  const mem = summary.memory;

  // GC pressure estimation based on utilization
  let gcPressure = 'none';
  if (mem.utilizationPercent > 90) {
    gcPressure = 'critical';
  } else if (mem.utilizationPercent > 75) {
    gcPressure = 'high';
  } else if (mem.utilizationPercent > 50) {
    gcPressure = 'moderate';
  } else {
    gcPressure = 'low';
  }

  // Estimate growth rate from stage data
  let growthRate = null;
  const stages = summary.duration?.stages;
  if (stages) {
    const stageNames = Object.keys(stages);
    if (stageNames.length >= 2) {
      const totalDuration = summary.duration.totalMs || 1;
      const heapGrowth = (mem.peakHeapMB || 0) - (mem.current?.heapUsed || 0);
      growthRate = {
        mbPerMinute: totalDuration > 0 ? Number((Math.abs(heapGrowth) / (totalDuration / 60000)).toFixed(1)) : 0,
        direction: heapGrowth >= 0 ? 'growing' : 'shrinking',
      };
    }
  }

  return {
    peakHeapMB: mem.peakHeapMB || 0,
    peakRssMB: mem.peakRssMB || 0,
    peakStage: mem.peakStage || null,
    headroomMB: mem.headroomMB || 0,
    memoryLimitMB: mem.memoryLimitMB || 450,
    utilizationPercent: mem.utilizationPercent || 0,
    gcPressure,
    growthRate,
  };
}

// ============ EXPORTS ============

module.exports = {
  generateSummary,
  formatSummary,
  getTimingReport,
  getMemoryReport,
  HEALTH_THRESHOLDS,
};
