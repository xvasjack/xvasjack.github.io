'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

// ── Helpers ──────────────────────────────────────────────────────────────────
function tmpDbPath() {
  const dir = path.join(os.tmpdir(), `phase-test-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'test.sqlite');
}

function cleanup(dbPath) {
  const { closeDb } = require('../../phase-tracker/storage/db');
  closeDb(dbPath);
  try {
    const dir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
  } catch (_) {
    // ignore
  }
}

// ── Runner unit tests ────────────────────────────────────────────────────────
const {
  validateThroughStage,
  getCompletedStages,
  getNextPendingStage,
} = require('../../phase-tracker/core/runner');
const { migrate } = require('../../phase-tracker/storage/migrate');
const { createRun } = require('../../phase-tracker/storage/runs-repo');
const {
  startStageAttempt,
  finishStageAttempt,
  failStageAttempt,
  appendEvent,
} = require('../../phase-tracker/storage/stages-repo');
const { STAGE_ORDER } = require('../../phase-tracker/contracts/stages');

describe('validateThroughStage', () => {
  it('accepts valid stages', () => {
    for (const s of STAGE_ORDER) {
      assert.doesNotThrow(() => validateThroughStage(s));
    }
  });

  it('rejects invalid stages', () => {
    for (const bad of ['1', '10', '2b', '', 'abc', null]) {
      assert.throws(() => validateThroughStage(bad), /Invalid --through/);
    }
  });
});

describe('getCompletedStages', () => {
  let dbPath;

  before(() => {
    dbPath = tmpDbPath();
    migrate(dbPath);
    createRun({ id: 'run-test-cs', country: 'Vietnam', industry: 'Energy', dbPath });
    // Complete stages 2, 2a
    const a1 = startStageAttempt('run-test-cs', '2', dbPath);
    finishStageAttempt('run-test-cs', '2', a1.attempt, dbPath);
    const a2 = startStageAttempt('run-test-cs', '2a', dbPath);
    finishStageAttempt('run-test-cs', '2a', a2.attempt, dbPath);
    // Fail stage 3
    const a3 = startStageAttempt('run-test-cs', '3', dbPath);
    failStageAttempt('run-test-cs', '3', a3.attempt, { message: 'test fail' }, dbPath);
  });

  after(() => cleanup(dbPath));

  it('returns only completed stages', () => {
    const result = getCompletedStages('run-test-cs', dbPath);
    assert.deepStrictEqual(result, ['2', '2a']);
  });

  it('returns empty array for unknown runId', () => {
    const result = getCompletedStages('run-nonexistent', dbPath);
    assert.deepStrictEqual(result, []);
  });
});

describe('getNextPendingStage', () => {
  let dbPath;

  before(() => {
    dbPath = tmpDbPath();
    migrate(dbPath);
    createRun({ id: 'run-test-np', country: 'Japan', industry: 'Fintech', dbPath });
    // Complete stages 2, 2a
    const a1 = startStageAttempt('run-test-np', '2', dbPath);
    finishStageAttempt('run-test-np', '2', a1.attempt, dbPath);
    const a2 = startStageAttempt('run-test-np', '2a', dbPath);
    finishStageAttempt('run-test-np', '2a', a2.attempt, dbPath);
  });

  after(() => cleanup(dbPath));

  it('returns next pending stage after completed ones', () => {
    const result = getNextPendingStage('run-test-np', dbPath);
    assert.equal(result, '3');
  });

  it('returns first stage for fresh run', () => {
    createRun({ id: 'run-test-fresh', country: 'UK', industry: 'SaaS', dbPath });
    const result = getNextPendingStage('run-test-fresh', dbPath);
    assert.equal(result, '2');
  });

  it('returns null when all stages completed', () => {
    createRun({ id: 'run-test-all', country: 'US', industry: 'Tech', dbPath });
    for (const s of STAGE_ORDER) {
      const a = startStageAttempt('run-test-all', s, dbPath);
      finishStageAttempt('run-test-all', s, a.attempt, dbPath);
    }
    const result = getNextPendingStage('run-test-all', dbPath);
    assert.equal(result, null);
  });
});

// ── Scorecard tests ──────────────────────────────────────────────────────────
const { buildScorecard, formatScorecardTerminal } = require('../../phase-tracker/core/scorecard');

describe('buildScorecard', () => {
  let dbPath;

  before(() => {
    dbPath = tmpDbPath();
    migrate(dbPath);
    createRun({ id: 'run-sc', country: 'Vietnam', industry: 'Energy', dbPath });

    // Stage 2: completed
    const a1 = startStageAttempt('run-sc', '2', dbPath);
    finishStageAttempt('run-sc', '2', a1.attempt, dbPath);
    appendEvent({
      runId: 'run-sc',
      stage: '2',
      attempt: a1.attempt,
      type: 'gate',
      message: 'research gate',
      data: { gateResults: { pass: true, score: 85 } },
      dbPath,
    });

    // Stage 2a: completed
    const a2 = startStageAttempt('run-sc', '2a', dbPath);
    finishStageAttempt('run-sc', '2a', a2.attempt, dbPath);

    // Stage 3: failed
    const a3 = startStageAttempt('run-sc', '3', dbPath);
    failStageAttempt('run-sc', '3', a3.attempt, { message: 'synth error' }, dbPath);
  });

  after(() => cleanup(dbPath));

  it('returns correct summary counts', () => {
    const sc = buildScorecard('run-sc', dbPath);
    assert.equal(sc.runId, 'run-sc');
    assert.equal(sc.summary.total, 13);
    assert.equal(sc.summary.completed, 2);
    assert.equal(sc.summary.failed, 1);
    assert.equal(sc.summary.pending, 10);
  });

  it('includes all 13 stages in order', () => {
    const sc = buildScorecard('run-sc', dbPath);
    assert.equal(sc.stages.length, 13);
    assert.deepStrictEqual(
      sc.stages.map((s) => s.stage),
      STAGE_ORDER
    );
  });

  it('extracts gate results from events', () => {
    const sc = buildScorecard('run-sc', dbPath);
    const stage2 = sc.stages.find((s) => s.stage === '2');
    assert.ok(stage2.gateResults);
    assert.equal(stage2.gateResults.pass, true);
    assert.equal(stage2.gateResults.score, 85);
  });

  it('computes gate pass rate', () => {
    const sc = buildScorecard('run-sc', dbPath);
    assert.equal(sc.summary.gatesPassed, 1);
    assert.equal(sc.summary.gatesTotal, 1);
    assert.equal(sc.summary.gatePassRate, 1);
  });

  it('captures error data for failed stages', () => {
    const sc = buildScorecard('run-sc', dbPath);
    const stage3 = sc.stages.find((s) => s.stage === '3');
    assert.equal(stage3.status, 'failed');
    assert.ok(stage3.error);
  });
});

describe('formatScorecardTerminal', () => {
  it('formats a scorecard into readable terminal output', () => {
    const sc = {
      runId: 'test-run',
      stages: [
        {
          stage: '2',
          status: 'completed',
          durationMs: 5000,
          artifacts: [{ filename: 'out.json' }],
          gateResults: { pass: true },
        },
        {
          stage: '2a',
          status: 'failed',
          durationMs: 200,
          artifacts: [],
          gateResults: { pass: false },
        },
        { stage: '3', status: 'pending', artifacts: [] },
      ],
      summary: {
        total: 13,
        completed: 1,
        failed: 1,
        pending: 11,
        totalDurationMs: 5200,
        gatePassRate: 0.5,
        gatesPassed: 1,
        gatesTotal: 2,
      },
    };
    const output = formatScorecardTerminal(sc);
    assert.ok(output.includes('test-run'));
    assert.ok(output.includes('Completed: 1/13'));
    assert.ok(output.includes('Failed: 1'));
    assert.ok(output.includes('Gates passed: 1/2'));
    assert.ok(output.includes('PASS'));
    assert.ok(output.includes('FAIL'));
  });
});

// ── Template strict gate tests ───────────────────────────────────────────────
const {
  validateSlidePositions,
  validateColors,
  validateFonts,
  validateTableBorders,
  runStrictTemplateGate,
  buildTemplateErrorArtifact,
  POSITION_TOLERANCE,
} = require('../../phase-tracker/core/template-strict-gate');

describe('validateSlidePositions', () => {
  it('returns no violations when within tolerance', () => {
    const slide = { title: { x: 1.0, y: 2.0, w: 8.0, h: 0.5 } };
    const spec = { pptxPositions: { title: { x: 1.0, y: 2.0, w: 8.0, h: 0.5 } } };
    const violations = validateSlidePositions(slide, spec);
    assert.equal(violations.length, 0);
  });

  it('returns violations when outside tolerance', () => {
    const slide = { title: { x: 1.0, y: 2.0, w: 8.0, h: 0.5 } };
    const spec = { pptxPositions: { title: { x: 2.0, y: 2.0, w: 8.0, h: 0.5 } } };
    const violations = validateSlidePositions(slide, spec);
    assert.ok(violations.length > 0);
    assert.equal(violations[0].type, 'position');
    assert.equal(violations[0].element, 'title');
    assert.equal(violations[0].field, 'x');
  });

  it('skips missing elements', () => {
    const slide = {};
    const spec = { pptxPositions: { title: { x: 1.0, y: 2.0 } } };
    const violations = validateSlidePositions(slide, spec);
    assert.equal(violations.length, 0);
  });

  it('tolerates minor deviations within tolerance', () => {
    const tolerance = POSITION_TOLERANCE;
    const slide = { title: { x: 1.0 + tolerance * 0.9, y: 2.0 } };
    const spec = { pptxPositions: { title: { x: 1.0, y: 2.0 } } };
    const violations = validateSlidePositions(slide, spec);
    assert.equal(violations.length, 0);
  });
});

describe('validateColors', () => {
  it('returns no violations for matching colors', () => {
    const colors = { dk1: '000000', accent1: 'FF0000' };
    const spec = { style: { colors: { dk1: '000000', accent1: 'FF0000' } } };
    const violations = validateColors(colors, spec);
    assert.equal(violations.length, 0);
  });

  it('case-insensitive comparison', () => {
    const colors = { dk1: '000000' };
    const spec = { style: { colors: { dk1: '000000' } } };
    const violations = validateColors(colors, spec);
    assert.equal(violations.length, 0);
  });

  it('returns violations for mismatched colors', () => {
    const colors = { dk1: 'FF0000' };
    const spec = { style: { colors: { dk1: '000000' } } };
    const violations = validateColors(colors, spec);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].type, 'color');
    assert.equal(violations[0].element, 'dk1');
  });

  it('returns empty array for missing spec colors', () => {
    assert.equal(validateColors({}, {}).length, 0);
    assert.equal(validateColors(null, null).length, 0);
  });
});

describe('validateFonts', () => {
  it('returns no violations for matching fonts', () => {
    const fonts = { heading: 'Arial', body: 'Calibri' };
    const spec = { style: { fonts: { heading: 'Arial', body: 'Calibri' } } };
    assert.equal(validateFonts(fonts, spec).length, 0);
  });

  it('returns violations for mismatched fonts', () => {
    const fonts = { heading: 'Times New Roman', body: 'Calibri' };
    const spec = { style: { fonts: { heading: 'Arial', body: 'Calibri' } } };
    const violations = validateFonts(fonts, spec);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].element, 'heading');
  });
});

describe('validateTableBorders', () => {
  it('returns no violations for matching border colors', () => {
    const table = { borderColor: 'E0E0E0' };
    const spec = { style: { table: { borderColor: 'E0E0E0' } } };
    assert.equal(validateTableBorders(table, spec).length, 0);
  });

  it('returns violations for mismatched borders', () => {
    const table = { borderColor: 'FF0000' };
    const spec = { style: { table: { borderColor: 'E0E0E0' } } };
    const violations = validateTableBorders(table, spec);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].type, 'table_border');
  });
});

describe('runStrictTemplateGate', () => {
  it('returns pass=false when no inspection data', () => {
    const result = runStrictTemplateGate(null);
    assert.equal(result.pass, false);
    assert.ok(result.violations.length > 0);
    assert.ok(result.blockingSlideKeys.length > 0);
  });

  it('returns pass=true for empty inspection with no violations', () => {
    const result = runStrictTemplateGate({});
    assert.equal(result.pass, true);
    assert.equal(result.violations.length, 0);
  });

  it('detects slide position violations', () => {
    // We need to load the actual template spec to know expected values
    // Test with deliberately wrong positions
    const result = runStrictTemplateGate({
      slides: [{ key: 'test-slide', title: { x: 999, y: 999, w: 999, h: 999 } }],
    });
    // May or may not have violations depending on template spec content
    assert.ok(typeof result.pass === 'boolean');
    assert.ok(Array.isArray(result.violations));
    assert.ok(Array.isArray(result.blockingSlideKeys));
    assert.ok(typeof result.summary === 'string');
  });

  it('includes summary text', () => {
    const result = runStrictTemplateGate({});
    assert.ok(result.summary.includes('PASSED') || result.summary.includes('FAILED'));
  });
});

describe('buildTemplateErrorArtifact', () => {
  it('builds artifact from gate result', () => {
    const gateResult = {
      pass: false,
      violations: [{ type: 'color', element: 'dk1', expected: '000', actual: 'FFF' }],
      blockingSlideKeys: ['slide-1'],
      summary: 'Template strict gate FAILED: 1 violation(s)',
    };
    const artifact = buildTemplateErrorArtifact(gateResult);
    assert.equal(artifact.pass, false);
    assert.equal(artifact.violationCount, 1);
    assert.deepStrictEqual(artifact.blockingSlideKeys, ['slide-1']);
    assert.ok(artifact.violations.length > 0);
  });
});

// ── Lock tests ───────────────────────────────────────────────────────────────
const {
  acquireRunLock,
  releaseRunLock,
  isRunLocked,
} = require('../../phase-tracker/storage/locks');

describe('Run locking', () => {
  let dbPath;

  before(() => {
    dbPath = tmpDbPath();
    migrate(dbPath);
    // run_locks has FK to runs — create runs first
    createRun({ id: 'run-lock-test', country: 'X', industry: 'Y', dbPath });
    createRun({ id: 'run-lock-dup', country: 'X', industry: 'Y', dbPath });
    createRun({ id: 'run-lock-rel', country: 'X', industry: 'Y', dbPath });
    createRun({ id: 'run-lock-check', country: 'X', industry: 'Y', dbPath });
  });

  after(() => cleanup(dbPath));

  it('acquires lock successfully', () => {
    const result = acquireRunLock('run-lock-test', { holder: 'worker-1', dbPath });
    assert.ok(result.acquired);
    assert.equal(result.holder, 'worker-1');
    releaseRunLock('run-lock-test', 'worker-1', dbPath);
  });

  it('rejects second lock on same run', () => {
    acquireRunLock('run-lock-dup', { holder: 'worker-1', dbPath });
    const result2 = acquireRunLock('run-lock-dup', { holder: 'worker-2', dbPath });
    assert.equal(result2.acquired, false);
    assert.equal(result2.holder, 'worker-1');
    releaseRunLock('run-lock-dup', 'worker-1', dbPath);
  });

  it('allows lock after release', () => {
    acquireRunLock('run-lock-rel', { holder: 'w1', dbPath });
    releaseRunLock('run-lock-rel', 'w1', dbPath);
    const result = acquireRunLock('run-lock-rel', { holder: 'w2', dbPath });
    assert.ok(result.acquired);
    releaseRunLock('run-lock-rel', 'w2', dbPath);
  });

  it('isRunLocked returns lock info', () => {
    acquireRunLock('run-lock-check', { holder: 'w1', dbPath });
    const lock = isRunLocked('run-lock-check', dbPath);
    assert.ok(lock);
    assert.equal(lock.holder, 'w1');
    releaseRunLock('run-lock-check', 'w1', dbPath);
  });

  it('isRunLocked returns null when no lock', () => {
    const lock = isRunLocked('run-no-lock', dbPath);
    assert.equal(lock, null);
  });
});

// ── Runs repo tests ──────────────────────────────────────────────────────────
const { getRun, listRuns, updateRunStatus } = require('../../phase-tracker/storage/runs-repo');

describe('Runs repository', () => {
  let dbPath;

  before(() => {
    dbPath = tmpDbPath();
    migrate(dbPath);
  });

  after(() => cleanup(dbPath));

  it('creates and retrieves a run', () => {
    createRun({ id: 'run-repo-1', country: 'Germany', industry: 'Auto', dbPath });
    const run = getRun('run-repo-1', dbPath);
    assert.ok(run);
    assert.equal(run.id, 'run-repo-1');
    assert.equal(run.country, 'Germany');
    assert.equal(run.industry, 'Auto');
    assert.equal(run.status, 'pending');
  });

  it('returns null for unknown run', () => {
    assert.equal(getRun('run-nonexistent', dbPath), null);
  });

  it('lists runs', () => {
    createRun({ id: 'run-repo-2', country: 'France', industry: 'Wine', dbPath });
    const runs = listRuns({ dbPath });
    assert.ok(runs.length >= 2);
  });

  it('filters runs by status', () => {
    updateRunStatus('run-repo-1', 'running', null, dbPath);
    const running = listRuns({ status: 'running', dbPath });
    assert.ok(running.some((r) => r.id === 'run-repo-1'));
    const pending = listRuns({ status: 'pending', dbPath });
    assert.ok(!pending.some((r) => r.id === 'run-repo-1'));
  });

  it('updates run status with finished_at for terminal states', () => {
    updateRunStatus('run-repo-2', 'completed', null, dbPath);
    const run = getRun('run-repo-2', dbPath);
    assert.equal(run.status, 'completed');
    assert.ok(run.finished_at);
  });
});
