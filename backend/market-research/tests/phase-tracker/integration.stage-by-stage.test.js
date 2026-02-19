'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { migrate } = require('../../phase-tracker/storage/migrate');
const { openDb, closeDb } = require('../../phase-tracker/storage/db');
const {
  createRun,
  getRun,
  updateRunStatus,
  generateRunId,
} = require('../../phase-tracker/storage/runs-repo');
const {
  startStageAttempt,
  finishStageAttempt,
  failStageAttempt,
  getStageAttempts,
  getLatestAttempt,
  appendEvent,
  getEvents,
} = require('../../phase-tracker/storage/stages-repo');
const {
  writeStageArtifacts,
  writeErrorArtifact,
} = require('../../phase-tracker/artifacts/write-artifact');
const { renderMd } = require('../../phase-tracker/artifacts/render-md');
const {
  attemptDir,
  artifactPath,
  ARTIFACT_FILES,
} = require('../../phase-tracker/artifacts/pathing');
const { STAGE_ORDER, STAGES } = require('../../phase-tracker/contracts/stages');
const {
  stagesThrough,
  nextStage,
  isValidStage,
  formatStage,
} = require('../../phase-tracker/core/stage-order');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-stage-'));
  return path.join(dir, 'test.sqlite');
}

function cleanupDb(dbPath) {
  closeDb(dbPath);
  const dir = path.dirname(dbPath);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Simulate running stages 2..through with deterministic fake output */
function simulateStagesThrough(runId, through, dbPath) {
  const stages = stagesThrough(through);
  const results = {};

  updateRunStatus(runId, 'running', null, dbPath);

  for (const stageId of stages) {
    const attempt = startStageAttempt(runId, stageId, dbPath);
    const output = {
      stage: stageId,
      label: STAGES[stageId].label,
      data: `Simulated output for stage ${stageId}`,
      timestamp: new Date().toISOString(),
    };

    writeStageArtifacts({
      runId,
      stage: stageId,
      attempt: attempt.attempt,
      output,
      meta: { stageId, kind: STAGES[stageId].kind },
      dbPath,
    });
    renderMd({
      runId,
      stage: stageId,
      attempt: attempt.attempt,
      output,
      meta: { stageId, kind: STAGES[stageId].kind },
      dbPath,
    });

    appendEvent({
      runId,
      stage: stageId,
      attempt: attempt.attempt,
      type: 'info',
      message: `Stage ${stageId} completed`,
      dbPath,
    });

    finishStageAttempt(runId, stageId, attempt.attempt, dbPath);
    results[stageId] = attempt;
  }

  const isLast = through === STAGE_ORDER[STAGE_ORDER.length - 1];
  updateRunStatus(runId, isLast ? 'completed' : 'completed', null, dbPath);
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('phase-tracker: stage-by-stage operator flow', () => {
  let dbPath;

  beforeEach(() => {
    dbPath = tmpDbPath();
    migrate(dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  // ---- Stage order validation ----

  test('STAGE_ORDER contains all 13 public stages in correct order', () => {
    expect(STAGE_ORDER).toEqual([
      '2',
      '2a',
      '3',
      '3a',
      '4',
      '4a',
      '5',
      '6',
      '6a',
      '7',
      '8',
      '8a',
      '9',
    ]);
  });

  test('every stage in STAGE_ORDER has a STAGES definition', () => {
    for (const id of STAGE_ORDER) {
      expect(STAGES[id]).toBeDefined();
      expect(STAGES[id].id).toBe(id);
      expect(STAGES[id].label).toBeTruthy();
      expect(['primary', 'review']).toContain(STAGES[id].kind);
    }
  });

  test('stagesThrough returns correct prefix slices', () => {
    expect(stagesThrough('2')).toEqual(['2']);
    expect(stagesThrough('3')).toEqual(['2', '2a', '3']);
    expect(stagesThrough('9')).toEqual(STAGE_ORDER);
  });

  test('nextStage chains the full pipeline', () => {
    let current = '2';
    const chain = [current];
    while (nextStage(current)) {
      current = nextStage(current);
      chain.push(current);
    }
    expect(chain).toEqual(STAGE_ORDER);
  });

  test('isValidStage rejects bogus IDs', () => {
    expect(isValidStage('2')).toBe(true);
    expect(isValidStage('2a')).toBe(true);
    expect(isValidStage('1')).toBe(false);
    expect(isValidStage('10')).toBe(false);
    expect(isValidStage('')).toBe(false);
  });

  // ---- Single-stage flow: create run -> start stage -> finish ----

  test('single-stage flow: 2 -> pending -> running -> completed', () => {
    const { id: runId } = createRun({
      industry: 'fintech',
      country: 'Germany',
      targetStage: '2',
      dbPath,
    });

    // Run starts as pending
    let run = getRun(runId, dbPath);
    expect(run.status).toBe('pending');
    expect(run.target_stage).toBe('2');

    // Mark running
    updateRunStatus(runId, 'running', null, dbPath);
    run = getRun(runId, dbPath);
    expect(run.status).toBe('running');

    // Start stage 2
    const attempt = startStageAttempt(runId, '2', dbPath);
    expect(attempt.stage).toBe('2');
    expect(attempt.attempt).toBe(1);
    expect(attempt.status).toBe('running');

    // Complete stage 2
    finishStageAttempt(runId, '2', 1, dbPath);
    const latest = getLatestAttempt(runId, '2', dbPath);
    expect(latest.status).toBe('completed');
    expect(latest.duration_ms).toBeGreaterThanOrEqual(0);

    // Complete run
    updateRunStatus(runId, 'completed', null, dbPath);
    run = getRun(runId, dbPath);
    expect(run.status).toBe('completed');
    expect(run.finished_at).toBeTruthy();
  });

  // ---- Full pipeline walk: 2 -> 2a -> 3 -> ... -> 9 ----

  test('full pipeline walk: all 13 stages complete in order', () => {
    const { id: runId } = createRun({
      industry: 'healthcare',
      country: 'Japan',
      targetStage: '9',
      dbPath,
    });

    const results = simulateStagesThrough(runId, '9', dbPath);

    // Every stage should have exactly 1 completed attempt
    for (const stageId of STAGE_ORDER) {
      const attempts = getStageAttempts(runId, stageId, dbPath);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe('completed');
      expect(results[stageId]).toBeDefined();
    }

    // Run is completed
    const run = getRun(runId, dbPath);
    expect(run.status).toBe('completed');
    expect(run.finished_at).toBeTruthy();
  });

  // ---- Partial run: stop at target stage ----

  test('run-through-and-stop: stops at target stage 3a', () => {
    const { id: runId } = createRun({
      industry: 'logistics',
      country: 'Brazil',
      targetStage: '3a',
      dbPath,
    });

    const results = simulateStagesThrough(runId, '3a', dbPath);

    // Stages 2, 2a, 3, 3a should be completed (Object.keys sorts integer keys first)
    expect(Object.keys(results).sort()).toEqual(['2', '2a', '3', '3a'].sort());

    for (const stageId of ['2', '2a', '3', '3a']) {
      const latest = getLatestAttempt(runId, stageId, dbPath);
      expect(latest.status).toBe('completed');
    }

    // Stages after 3a should have no attempts
    for (const stageId of ['4', '4a', '5', '6', '6a', '7', '8', '8a', '9']) {
      const attempts = getStageAttempts(runId, stageId, dbPath);
      expect(attempts).toHaveLength(0);
    }
  });

  // ---- Artifacts written per stage ----

  test('artifacts: output.json + output.md + meta.json written per stage', () => {
    const { id: runId } = createRun({
      industry: 'energy',
      country: 'Norway',
      targetStage: '2',
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);
    const attempt = startStageAttempt(runId, '2', dbPath);

    const output = { topics: 25, rawData: { policy: 'test' } };
    const meta = { stageId: '2', kind: 'primary' };

    writeStageArtifacts({
      runId,
      stage: '2',
      attempt: attempt.attempt,
      output,
      meta,
      dbPath,
    });
    renderMd({
      runId,
      stage: '2',
      attempt: attempt.attempt,
      output,
      meta,
      dbPath,
    });

    finishStageAttempt(runId, '2', attempt.attempt, dbPath);

    // Check files on disk
    const dir = attemptDir(runId, '2', 1);
    expect(fs.existsSync(path.join(dir, 'output.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'output.md'))).toBe(true);

    // Validate output.json content
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'output.json'), 'utf-8'));
    expect(written.topics).toBe(25);
    expect(written.rawData.policy).toBe('test');

    // Validate output.md has stage header
    const md = fs.readFileSync(path.join(dir, 'output.md'), 'utf-8');
    expect(md).toContain('# Stage 2');
    expect(md).toContain(runId);
  });

  // ---- Events logged per stage ----

  test('events: appendEvent creates queryable event stream', () => {
    const { id: runId } = createRun({
      industry: 'fintech',
      country: 'UK',
      targetStage: '3',
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);
    const attempt = startStageAttempt(runId, '2', dbPath);

    appendEvent({
      runId,
      stage: '2',
      attempt: attempt.attempt,
      type: 'info',
      message: 'Started research',
      data: { topicCount: 25 },
      dbPath,
    });
    appendEvent({
      runId,
      stage: '2',
      attempt: attempt.attempt,
      type: 'gate',
      message: 'Research quality gate passed',
      data: { score: 72, threshold: 60 },
      dbPath,
    });

    finishStageAttempt(runId, '2', attempt.attempt, dbPath);

    // Query all events for run
    const allEvents = getEvents(runId, { dbPath });
    expect(allEvents).toHaveLength(2);

    // Filter by type
    const gateEvents = getEvents(runId, { stage: '2', type: 'gate', dbPath });
    expect(gateEvents).toHaveLength(1);
    expect(JSON.parse(gateEvents[0].data).score).toBe(72);
  });

  // ---- formatStage for operator display ----

  test('formatStage returns human-readable labels', () => {
    expect(formatStage('2')).toBe('2 — Country Research');
    expect(formatStage('3a')).toBe('3a — Synthesis Review');
    expect(formatStage('9')).toBe('9 — Delivery');
    expect(formatStage('99')).toBe('99 — (unknown)');
  });

  // ---- Resume from a specific stage ----

  test('resume: run stages 2-3, then resume from 3a onward', () => {
    const runId = 'run-resume-test-001';
    createRun({
      industry: 'mining',
      country: 'Chile',
      targetStage: '3',
      id: runId,
      dbPath,
    });

    // First execution: stages 2, 2a, 3
    simulateStagesThrough(runId, '3', dbPath);
    const run = getRun(runId, dbPath);
    expect(run.status).toBe('completed');

    // Verify 3 stages done
    const firstAttempts = getStageAttempts(runId, null, dbPath);
    expect(firstAttempts).toHaveLength(3);

    // Resume: mark running again and continue from 3a
    updateRunStatus(runId, 'running', null, dbPath);
    for (const stageId of ['3a', '4', '4a', '5']) {
      const attempt = startStageAttempt(runId, stageId, dbPath);
      writeStageArtifacts({
        runId,
        stage: stageId,
        attempt: attempt.attempt,
        output: { resumed: true, stage: stageId },
        dbPath,
      });
      finishStageAttempt(runId, stageId, attempt.attempt, dbPath);
    }
    updateRunStatus(runId, 'completed', null, dbPath);

    // Total: 3 + 4 = 7 stage attempts
    const allAttempts = getStageAttempts(runId, null, dbPath);
    expect(allAttempts).toHaveLength(7);

    // All completed
    for (const a of allAttempts) {
      expect(a.status).toBe('completed');
    }
  });

  // ---- Stage inputs/outputs declared in contract ----

  test('contract: every stage declares inputs and outputs', () => {
    for (const stageId of STAGE_ORDER) {
      const stage = STAGES[stageId];
      expect(Array.isArray(stage.inputs)).toBe(true);
      expect(Array.isArray(stage.outputs)).toBe(true);
      expect(stage.outputs.length).toBeGreaterThan(0);
    }
  });

  test('contract: review stages consume primary stage outputs', () => {
    // 2a consumes research-raw.json from stage 2
    expect(STAGES['2a'].inputs).toContain('research-raw.json');
    expect(STAGES['2'].outputs).toContain('research-raw.json');

    // 3a consumes synthesis.json from stage 3
    expect(STAGES['3a'].inputs).toContain('synthesis.json');
    expect(STAGES['3'].outputs).toContain('synthesis.json');
  });

  // ---- Cleanup: artifacts directory created per run ----

  test('artifacts directory structure: reports/phase-runs/<runId>/stages/<stage>/attempt-<n>/', () => {
    const { id: runId } = createRun({
      industry: 'retail',
      country: 'India',
      targetStage: '2',
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);
    const attempt = startStageAttempt(runId, '2', dbPath);
    writeStageArtifacts({
      runId,
      stage: '2',
      attempt: attempt.attempt,
      output: { test: true },
      dbPath,
    });

    const dir = attemptDir(runId, '2', 1);
    expect(dir).toContain(path.join('reports', 'phase-runs', runId, 'stages', '2', 'attempt-1'));
    expect(fs.existsSync(dir)).toBe(true);
  });
});
