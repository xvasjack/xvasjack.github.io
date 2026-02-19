'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { migrate } = require('../../phase-tracker/storage/migrate');
const { openDb, closeDb } = require('../../phase-tracker/storage/db');
const {
  createRun,
  getRun,
  listRuns,
  updateRunStatus,
  generateRunId,
} = require('../../phase-tracker/storage/runs-repo');
const {
  startStageAttempt,
  finishStageAttempt,
  getStageAttempts,
  getLatestAttempt,
  appendEvent,
  getEvents,
} = require('../../phase-tracker/storage/stages-repo');
const {
  acquireRunLock,
  releaseRunLock,
  heartbeatRunLock,
  isRunLocked,
  cleanExpiredLocks,
} = require('../../phase-tracker/storage/locks');
const { writeStageArtifacts } = require('../../phase-tracker/artifacts/write-artifact');
const { attemptDir, ARTIFACT_FILES } = require('../../phase-tracker/artifacts/pathing');
const { STAGE_ORDER, STAGES } = require('../../phase-tracker/contracts/stages');
const { stagesThrough } = require('../../phase-tracker/core/stage-order');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-parallel-'));
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

function runStages(runId, through, dbPath) {
  updateRunStatus(runId, 'running', null, dbPath);
  for (const stageId of stagesThrough(through)) {
    const attempt = startStageAttempt(runId, stageId, dbPath);
    writeStageArtifacts({
      runId,
      stage: stageId,
      attempt: attempt.attempt,
      output: { stage: stageId, runId },
      meta: { stageId },
      dbPath,
    });
    finishStageAttempt(runId, stageId, attempt.attempt, dbPath);
  }
  updateRunStatus(runId, 'completed', null, dbPath);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('phase-tracker: parallel runs by runId', () => {
  let dbPath;

  beforeEach(() => {
    dbPath = tmpDbPath();
    migrate(dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  // ---- Unique run IDs ----

  test('generateRunId produces unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateRunId());
    }
    expect(ids.size).toBe(100);
  });

  test('generateRunId matches expected pattern', () => {
    const id = generateRunId();
    expect(id).toMatch(/^run-[a-z0-9]+-[a-f0-9]{8}$/);
  });

  // ---- Multiple concurrent runs share one DB ----

  test('two runs coexist in same database without interference', () => {
    const { id: runA } = createRun({
      industry: 'fintech',
      country: 'Germany',
      targetStage: '3',
      dbPath,
    });
    const { id: runB } = createRun({
      industry: 'healthcare',
      country: 'Japan',
      targetStage: '3a',
      dbPath,
    });

    // Both exist
    expect(getRun(runA, dbPath)).toBeTruthy();
    expect(getRun(runB, dbPath)).toBeTruthy();
    expect(getRun(runA, dbPath).industry).toBe('fintech');
    expect(getRun(runB, dbPath).industry).toBe('healthcare');

    // Run both through their targets
    runStages(runA, '3', dbPath);
    runStages(runB, '3a', dbPath);

    // Run A: stages 2, 2a, 3
    const attemptsA = getStageAttempts(runA, null, dbPath);
    expect(attemptsA).toHaveLength(3);
    expect(attemptsA.every((a) => a.run_id === runA)).toBe(true);

    // Run B: stages 2, 2a, 3, 3a
    const attemptsB = getStageAttempts(runB, null, dbPath);
    expect(attemptsB).toHaveLength(4);
    expect(attemptsB.every((a) => a.run_id === runB)).toBe(true);

    // No cross-contamination
    for (const a of attemptsA) {
      expect(a.run_id).not.toBe(runB);
    }
    for (const b of attemptsB) {
      expect(b.run_id).not.toBe(runA);
    }
  });

  // ---- Artifact isolation by runId ----

  test('artifacts isolated: each runId has its own directory tree', () => {
    const { id: runA } = createRun({
      industry: 'energy',
      country: 'Norway',
      targetStage: '2',
      dbPath,
    });
    const { id: runB } = createRun({
      industry: 'mining',
      country: 'Chile',
      targetStage: '2',
      dbPath,
    });

    runStages(runA, '2', dbPath);
    runStages(runB, '2', dbPath);

    const dirA = attemptDir(runA, '2', 1);
    const dirB = attemptDir(runB, '2', 1);

    // Different paths
    expect(dirA).not.toBe(dirB);

    // Both exist
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(true);

    // Each has its own output.json with correct runId
    const outputA = JSON.parse(fs.readFileSync(path.join(dirA, 'output.json'), 'utf-8'));
    const outputB = JSON.parse(fs.readFileSync(path.join(dirB, 'output.json'), 'utf-8'));
    expect(outputA.runId).toBe(runA);
    expect(outputB.runId).toBe(runB);
  });

  // ---- listRuns with status filter ----

  test('listRuns filters by status across multiple runs', () => {
    createRun({ industry: 'a', country: 'X', dbPath });
    createRun({ industry: 'b', country: 'Y', dbPath });
    const { id: runC } = createRun({ industry: 'c', country: 'Z', dbPath });

    // All start as pending
    const pending = listRuns({ status: 'pending', dbPath });
    expect(pending).toHaveLength(3);

    // Mark one as running
    updateRunStatus(runC, 'running', null, dbPath);
    const running = listRuns({ status: 'running', dbPath });
    expect(running).toHaveLength(1);
    expect(running[0].id).toBe(runC);

    // Still 2 pending
    const stillPending = listRuns({ status: 'pending', dbPath });
    expect(stillPending).toHaveLength(2);
  });

  // ---- Run locking ----

  test('acquireRunLock prevents double-lock on same runId', () => {
    const { id: runId } = createRun({
      industry: 'fintech',
      country: 'UK',
      dbPath,
    });

    const lock1 = acquireRunLock(runId, { holder: 'worker-1', dbPath });
    expect(lock1.acquired).toBe(true);
    expect(lock1.holder).toBe('worker-1');

    // Second lock attempt fails
    const lock2 = acquireRunLock(runId, { holder: 'worker-2', dbPath });
    expect(lock2.acquired).toBe(false);
    expect(lock2.holder).toBe('worker-1');

    // Release and re-acquire
    const released = releaseRunLock(runId, 'worker-1', dbPath);
    expect(released).toBe(true);

    const lock3 = acquireRunLock(runId, { holder: 'worker-2', dbPath });
    expect(lock3.acquired).toBe(true);
    expect(lock3.holder).toBe('worker-2');

    releaseRunLock(runId, 'worker-2', dbPath);
  });

  test('different runIds can be locked independently', () => {
    const { id: runA } = createRun({ industry: 'a', country: 'X', dbPath });
    const { id: runB } = createRun({ industry: 'b', country: 'Y', dbPath });

    const lockA = acquireRunLock(runA, { holder: 'w1', dbPath });
    const lockB = acquireRunLock(runB, { holder: 'w2', dbPath });

    expect(lockA.acquired).toBe(true);
    expect(lockB.acquired).toBe(true);

    releaseRunLock(runA, 'w1', dbPath);
    releaseRunLock(runB, 'w2', dbPath);
  });

  test('expired lock is auto-cleaned on next acquire', () => {
    const { id: runId } = createRun({ industry: 'a', country: 'X', dbPath });

    // Acquire with 1ms TTL (will expire immediately)
    acquireRunLock(runId, { holder: 'old-worker', ttlMs: 1, dbPath });

    // Brief wait for expiry
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    // New acquire should succeed because old lock expired
    const lock = acquireRunLock(runId, { holder: 'new-worker', dbPath });
    expect(lock.acquired).toBe(true);
    expect(lock.holder).toBe('new-worker');

    releaseRunLock(runId, 'new-worker', dbPath);
  });

  test('heartbeat extends lock expiry', () => {
    const { id: runId } = createRun({ industry: 'a', country: 'X', dbPath });

    acquireRunLock(runId, { holder: 'w1', ttlMs: 60000, dbPath });

    const heartbeated = heartbeatRunLock(runId, 'w1', { ttlMs: 120000, dbPath });
    expect(heartbeated).toBe(true);

    // Wrong holder can't heartbeat
    const wrongHeartbeat = heartbeatRunLock(runId, 'w2', { dbPath });
    expect(wrongHeartbeat).toBe(false);

    releaseRunLock(runId, 'w1', dbPath);
  });

  test('isRunLocked returns lock info or null', () => {
    const { id: runId } = createRun({ industry: 'a', country: 'X', dbPath });

    expect(isRunLocked(runId, dbPath)).toBeNull();

    acquireRunLock(runId, { holder: 'w1', dbPath });
    const lockInfo = isRunLocked(runId, dbPath);
    expect(lockInfo).toBeTruthy();
    expect(lockInfo.holder).toBe('w1');

    releaseRunLock(runId, 'w1', dbPath);
    expect(isRunLocked(runId, dbPath)).toBeNull();
  });

  test('cleanExpiredLocks clears stale locks', () => {
    const { id: runA } = createRun({ industry: 'a', country: 'X', dbPath });
    const { id: runB } = createRun({ industry: 'b', country: 'Y', dbPath });

    acquireRunLock(runA, { holder: 'w1', ttlMs: 1, dbPath });
    acquireRunLock(runB, { holder: 'w2', ttlMs: 300000, dbPath });

    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    const cleaned = cleanExpiredLocks(dbPath);
    expect(cleaned).toBe(1); // Only runA's lock expired

    expect(isRunLocked(runA, dbPath)).toBeNull();
    expect(isRunLocked(runB, dbPath)).toBeTruthy();

    releaseRunLock(runB, 'w2', dbPath);
  });

  // ---- Events isolated per run ----

  test('events are isolated per runId', () => {
    const { id: runA } = createRun({ industry: 'a', country: 'X', dbPath });
    const { id: runB } = createRun({ industry: 'b', country: 'Y', dbPath });

    appendEvent({ runId: runA, stage: '2', attempt: 1, type: 'info', message: 'A event', dbPath });
    appendEvent({ runId: runB, stage: '2', attempt: 1, type: 'info', message: 'B event', dbPath });
    appendEvent({ runId: runA, stage: '3', attempt: 1, type: 'warn', message: 'A warn', dbPath });

    const eventsA = getEvents(runA, { dbPath });
    expect(eventsA).toHaveLength(2);
    expect(eventsA.every((e) => e.run_id === runA)).toBe(true);

    const eventsB = getEvents(runB, { dbPath });
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0].message).toBe('B event');
  });

  // ---- Many parallel runs stress ----

  test('10 parallel runs complete without conflicts', () => {
    const runIds = [];
    for (let i = 0; i < 10; i++) {
      const { id } = createRun({
        industry: `industry-${i}`,
        country: `country-${i}`,
        targetStage: '3',
        dbPath,
      });
      runIds.push(id);
    }

    // Run them all through stage 3
    for (const runId of runIds) {
      runStages(runId, '3', dbPath);
    }

    // All completed
    const completed = listRuns({ status: 'completed', dbPath });
    expect(completed).toHaveLength(10);

    // Each has 3 stage attempts (2, 2a, 3)
    for (const runId of runIds) {
      const attempts = getStageAttempts(runId, null, dbPath);
      expect(attempts).toHaveLength(3);
    }
  });

  // ---- Custom runId for operator traceability ----

  test('custom runId: operator can assign a meaningful ID', () => {
    const customId = 'run-energy-norway-20260219';
    const { id } = createRun({
      industry: 'energy',
      country: 'Norway',
      id: customId,
      dbPath,
    });

    expect(id).toBe(customId);
    const run = getRun(customId, dbPath);
    expect(run.id).toBe(customId);
    expect(run.industry).toBe('energy');
  });

  // ---- listRuns respects limit ----

  test('listRuns respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      createRun({ industry: `ind-${i}`, country: `c-${i}`, dbPath });
    }

    const all = listRuns({ dbPath });
    expect(all).toHaveLength(10);

    const limited = listRuns({ limit: 3, dbPath });
    expect(limited).toHaveLength(3);
  });
});
