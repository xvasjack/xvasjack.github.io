'use strict';

const { openDb } = require('../storage/db');
const { STAGE_ORDER } = require('../contracts/stages');

// ── Build run scorecard ──────────────────────────────────────────────────────
function buildScorecard(runId, dbPath) {
  const db = openDb(dbPath);

  const stageRows = db
    .prepare(
      `SELECT stage, status, duration_ms, error
       FROM stage_attempts
       WHERE run_id = ? AND attempt = 1
       ORDER BY id`
    )
    .all(runId);

  const artifactRows = db
    .prepare(
      `SELECT stage, filename, path, size_bytes
       FROM artifacts
       WHERE run_id = ?
       ORDER BY stage, id`
    )
    .all(runId);

  const eventRows = db
    .prepare(
      `SELECT stage, type, message, data
       FROM events
       WHERE run_id = ? AND type IN ('info', 'gate')
       ORDER BY id`
    )
    .all(runId);

  const stageMap = {};
  for (const row of stageRows) {
    stageMap[row.stage] = {
      stage: row.stage,
      status: row.status,
      durationMs: row.duration_ms,
      error: row.error ? safeJsonParse(row.error) : null,
      artifacts: [],
      gateResults: null,
    };
  }

  for (const art of artifactRows) {
    if (stageMap[art.stage]) {
      stageMap[art.stage].artifacts.push({
        filename: art.filename,
        path: art.path,
        sizeBytes: art.size_bytes,
      });
    }
  }

  for (const evt of eventRows) {
    if (stageMap[evt.stage] && evt.data) {
      const data = safeJsonParse(evt.data);
      if (data?.gateResults) stageMap[evt.stage].gateResults = data.gateResults;
    }
  }

  const stages = STAGE_ORDER.map((s) => stageMap[s] || { stage: s, status: 'pending' });

  const completed = stages.filter((s) => s.status === 'completed').length;
  const failed = stages.filter((s) => s.status === 'failed').length;
  const pending = stages.filter((s) => s.status === 'pending' || !s.status).length;
  const totalDurationMs = stages.reduce((acc, s) => acc + (s.durationMs || 0), 0);

  const withGates = stages.filter((s) => s.gateResults && typeof s.gateResults.pass === 'boolean');
  const gatesPassed = withGates.filter((s) => s.gateResults.pass).length;
  const gatePassRate = withGates.length > 0 ? gatesPassed / withGates.length : null;

  return {
    runId,
    stages,
    summary: {
      total: STAGE_ORDER.length,
      completed,
      failed,
      pending,
      totalDurationMs,
      gatePassRate,
      gatesPassed,
      gatesTotal: withGates.length,
    },
  };
}

// ── Format scorecard for terminal ────────────────────────────────────────────
function formatScorecardTerminal(scorecard) {
  const lines = [];
  lines.push(`\nScorecard for run: ${scorecard.runId}`);
  lines.push('-'.repeat(72));
  lines.push(
    padRight('Stage', 8) +
      padRight('Status', 12) +
      padRight('Duration', 12) +
      padRight('Gate', 8) +
      'Artifacts'
  );
  lines.push('-'.repeat(72));

  for (const s of scorecard.stages) {
    const status = statusIcon(s.status) + ' ' + (s.status || 'pending');
    const duration = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '-';
    const gate =
      s.gateResults && typeof s.gateResults.pass === 'boolean'
        ? s.gateResults.pass
          ? 'PASS'
          : 'FAIL'
        : '-';
    const artCount = (s.artifacts || []).length;
    lines.push(
      padRight(s.stage, 8) +
        padRight(status, 12) +
        padRight(duration, 12) +
        padRight(gate, 8) +
        String(artCount)
    );
  }

  lines.push('-'.repeat(72));
  const { summary } = scorecard;
  lines.push(
    `Completed: ${summary.completed}/${summary.total}  ` +
      `Failed: ${summary.failed}  ` +
      `Pending: ${summary.pending}  ` +
      `Duration: ${(summary.totalDurationMs / 1000).toFixed(1)}s`
  );
  if (summary.gatePassRate != null) {
    lines.push(
      `Gates passed: ${summary.gatesPassed}/${summary.gatesTotal} (${(summary.gatePassRate * 100).toFixed(0)}%)`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function padRight(str, len) {
  const s = String(str || '');
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function statusIcon(status) {
  switch (status) {
    case 'completed':
      return '+';
    case 'failed':
      return 'X';
    case 'running':
      return '>';
    default:
      return '.';
  }
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

module.exports = { buildScorecard, formatScorecardTerminal };
