'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, it, beforeEach, afterEach, expect } = require('@jest/globals');

// Storage modules
const { openDb, closeDb, withTransaction } = require('../../phase-tracker/storage/db');
const { migrate } = require('../../phase-tracker/storage/migrate');
const {
  createRun,
  getRun,
  listRuns,
  updateRunStatus,
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
  acquireRunLock,
  releaseRunLock,
  heartbeatRunLock,
  isRunLocked,
  cleanExpiredLocks,
} = require('../../phase-tracker/storage/locks');

// Artifact modules
const {
  attemptDir,
  artifactPath,
  artifactRelPath,
  ARTIFACT_FILES,
} = require('../../phase-tracker/artifacts/pathing');
const {
  atomicWriteSync,
  writeArtifact,
  writeStageArtifacts,
  writeErrorArtifact,
  saveArtifactRecord,
} = require('../../phase-tracker/artifacts/write-artifact');
const { renderMd } = require('../../phase-tracker/artifacts/render-md');

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-tracker-test-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  migrate(dbPath);
});

afterEach(() => {
  closeDb(dbPath);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Runs Repo ──────────────────────────────────────────────

describe('runs-repo', () => {
  it('creates a run with auto-generated id', () => {
    const { id } = createRun({ industry: 'energy', country: 'Vietnam', dbPath });
    expect(id).toMatch(/^run-/);
    const run = getRun(id, dbPath);
    expect(run.industry).toBe('energy');
    expect(run.country).toBe('Vietnam');
    expect(run.status).toBe('pending');
  });

  it('creates a run with custom id', () => {
    const { id } = createRun({ industry: 'fintech', country: 'Brazil', id: 'custom-123', dbPath });
    expect(id).toBe('custom-123');
  });

  it('stores client context as JSON', () => {
    const ctx = JSON.stringify({ firm: 'Acme', focus: 'renewables' });
    createRun({ industry: 'energy', country: 'US', clientContext: ctx, dbPath });
    const runs = listRuns({ dbPath });
    expect(runs.length).toBe(1);
    expect(JSON.parse(runs[0].client_context)).toEqual({ firm: 'Acme', focus: 'renewables' });
  });

  it('stores target stage', () => {
    createRun({ industry: 'energy', country: 'US', targetStage: '4a', dbPath });
    const runs = listRuns({ dbPath });
    expect(runs[0].target_stage).toBe('4a');
  });

  it('lists runs filtered by status', () => {
    const { id: id1 } = createRun({ industry: 'a', country: 'b', dbPath });
    const { id: id2 } = createRun({ industry: 'c', country: 'd', dbPath });
    updateRunStatus(id1, 'running', null, dbPath);
    const running = listRuns({ status: 'running', dbPath });
    expect(running.length).toBe(1);
    expect(running[0].id).toBe(id1);
  });

  it('updates run to completed with finished_at', () => {
    const { id } = createRun({ industry: 'a', country: 'b', dbPath });
    updateRunStatus(id, 'completed', null, dbPath);
    const run = getRun(id, dbPath);
    expect(run.status).toBe('completed');
    expect(run.finished_at).toBeTruthy();
  });

  it('updates run to failed with error', () => {
    const { id } = createRun({ industry: 'a', country: 'b', dbPath });
    updateRunStatus(id, 'failed', JSON.stringify({ msg: 'boom' }), dbPath);
    const run = getRun(id, dbPath);
    expect(run.status).toBe('failed');
    expect(JSON.parse(run.error)).toEqual({ msg: 'boom' });
  });

  it('getRun returns null for nonexistent id', () => {
    expect(getRun('nonexistent', dbPath)).toBeNull();
  });

  it('rejects duplicate run ids', () => {
    createRun({ industry: 'a', country: 'b', id: 'dup-1', dbPath });
    expect(() => createRun({ industry: 'c', country: 'd', id: 'dup-1', dbPath })).toThrow();
  });
});

// ─── Stage Attempts ─────────────────────────────────────────

describe('stages-repo', () => {
  let runId;
  beforeEach(() => {
    runId = createRun({ industry: 'test', country: 'test', dbPath }).id;
  });

  it('starts a stage attempt with attempt=1', () => {
    const sa = startStageAttempt(runId, '2', dbPath);
    expect(sa.attempt).toBe(1);
    expect(sa.status).toBe('running');
    expect(sa.stage).toBe('2');
  });

  it('auto-increments attempt number', () => {
    const a1 = startStageAttempt(runId, '3', dbPath);
    const a2 = startStageAttempt(runId, '3', dbPath);
    expect(a1.attempt).toBe(1);
    expect(a2.attempt).toBe(2);
  });

  it('finishes a stage attempt with duration', () => {
    const sa = startStageAttempt(runId, '4', dbPath);
    finishStageAttempt(runId, '4', sa.attempt, dbPath);
    const latest = getLatestAttempt(runId, '4', dbPath);
    expect(latest.status).toBe('completed');
    expect(latest.finished_at).toBeTruthy();
    expect(typeof latest.duration_ms).toBe('number');
  });

  it('fails a stage attempt with error', () => {
    const sa = startStageAttempt(runId, '5', dbPath);
    failStageAttempt(runId, '5', sa.attempt, { msg: 'timeout' }, dbPath);
    const latest = getLatestAttempt(runId, '5', dbPath);
    expect(latest.status).toBe('failed');
    expect(JSON.parse(latest.error)).toEqual({ msg: 'timeout' });
  });

  it('gets all attempts for a run', () => {
    startStageAttempt(runId, '2', dbPath);
    startStageAttempt(runId, '3', dbPath);
    startStageAttempt(runId, '3', dbPath);
    const all = getStageAttempts(runId, null, dbPath);
    expect(all.length).toBe(3);
  });

  it('gets attempts filtered by stage', () => {
    startStageAttempt(runId, '2', dbPath);
    startStageAttempt(runId, '3', dbPath);
    startStageAttempt(runId, '3', dbPath);
    const s3 = getStageAttempts(runId, '3', dbPath);
    expect(s3.length).toBe(2);
  });

  it('getLatestAttempt returns null for no attempts', () => {
    expect(getLatestAttempt(runId, '99', dbPath)).toBeNull();
  });

  describe('full lifecycle', () => {
    it('runs through start → finish for multiple stages', () => {
      const stages = ['2', '2a', '3', '3a', '4'];
      for (const stage of stages) {
        const sa = startStageAttempt(runId, stage, dbPath);
        finishStageAttempt(runId, stage, sa.attempt, dbPath);
      }
      const all = getStageAttempts(runId, null, dbPath);
      expect(all.length).toBe(5);
      expect(all.every((a) => a.status === 'completed')).toBe(true);
    });

    it('handles retry: fail attempt 1, succeed attempt 2', () => {
      const a1 = startStageAttempt(runId, '4a', dbPath);
      failStageAttempt(runId, '4a', a1.attempt, 'quality gate failed', dbPath);

      const a2 = startStageAttempt(runId, '4a', dbPath);
      finishStageAttempt(runId, '4a', a2.attempt, dbPath);

      const attempts = getStageAttempts(runId, '4a', dbPath);
      expect(attempts.length).toBe(2);
      expect(attempts[0].status).toBe('failed');
      expect(attempts[1].status).toBe('completed');
    });
  });
});

// ─── Events ─────────────────────────────────────────────────

describe('events', () => {
  let runId;
  beforeEach(() => {
    runId = createRun({ industry: 'test', country: 'test', dbPath }).id;
  });

  it('appends an event', () => {
    appendEvent({
      runId,
      stage: '2',
      attempt: 1,
      type: 'info',
      message: 'starting research',
      dbPath,
    });
    const events = getEvents(runId, { dbPath });
    expect(events.length).toBe(1);
    expect(events[0].message).toBe('starting research');
    expect(events[0].type).toBe('info');
  });

  it('stores event data as JSON', () => {
    appendEvent({
      runId,
      stage: '3',
      attempt: 1,
      type: 'metric',
      message: 'tokens used',
      data: { count: 5000 },
      dbPath,
    });
    const events = getEvents(runId, { dbPath });
    expect(JSON.parse(events[0].data)).toEqual({ count: 5000 });
  });

  it('filters events by stage', () => {
    appendEvent({ runId, stage: '2', attempt: 1, type: 'info', message: 'a', dbPath });
    appendEvent({ runId, stage: '3', attempt: 1, type: 'info', message: 'b', dbPath });
    const s2 = getEvents(runId, { stage: '2', dbPath });
    expect(s2.length).toBe(1);
    expect(s2[0].message).toBe('a');
  });

  it('filters events by type', () => {
    appendEvent({ runId, stage: '2', attempt: 1, type: 'info', message: 'a', dbPath });
    appendEvent({ runId, stage: '2', attempt: 1, type: 'error', message: 'b', dbPath });
    const errors = getEvents(runId, { type: 'error', dbPath });
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('b');
  });

  it('handles null stage/attempt for run-level events', () => {
    appendEvent({ runId, type: 'info', message: 'run started', dbPath });
    const events = getEvents(runId, { dbPath });
    expect(events[0].stage).toBeNull();
    expect(events[0].attempt).toBeNull();
  });
});

// ─── Locks ──────────────────────────────────────────────────

describe('locks', () => {
  let runId;
  beforeEach(() => {
    runId = createRun({ industry: 'test', country: 'test', dbPath }).id;
  });

  it('acquires a lock on a run', () => {
    const result = acquireRunLock(runId, { holder: 'worker-1', dbPath });
    expect(result.acquired).toBe(true);
    expect(result.holder).toBe('worker-1');
  });

  it('prevents second lock on same runId', () => {
    acquireRunLock(runId, { holder: 'worker-1', dbPath });
    const result = acquireRunLock(runId, { holder: 'worker-2', dbPath });
    expect(result.acquired).toBe(false);
    expect(result.holder).toBe('worker-1');
  });

  it('allows locks on different runIds concurrently', () => {
    const run2 = createRun({ industry: 'test2', country: 'test2', dbPath }).id;
    const lock1 = acquireRunLock(runId, { holder: 'worker-1', dbPath });
    const lock2 = acquireRunLock(run2, { holder: 'worker-2', dbPath });
    expect(lock1.acquired).toBe(true);
    expect(lock2.acquired).toBe(true);
  });

  it('releases a lock', () => {
    acquireRunLock(runId, { holder: 'worker-1', dbPath });
    const released = releaseRunLock(runId, 'worker-1', dbPath);
    expect(released).toBe(true);
    // Now another worker can acquire
    const result = acquireRunLock(runId, { holder: 'worker-2', dbPath });
    expect(result.acquired).toBe(true);
  });

  it('only holder can release', () => {
    acquireRunLock(runId, { holder: 'worker-1', dbPath });
    const released = releaseRunLock(runId, 'worker-2', dbPath);
    expect(released).toBe(false);
    // Lock still held
    const check = isRunLocked(runId, dbPath);
    expect(check).toBeTruthy();
    expect(check.holder).toBe('worker-1');
  });

  it('heartbeat extends lock expiry', () => {
    acquireRunLock(runId, { holder: 'worker-1', ttlMs: 1000, dbPath });
    const before = isRunLocked(runId, dbPath);

    heartbeatRunLock(runId, 'worker-1', { ttlMs: 60000, dbPath });
    const after = isRunLocked(runId, dbPath);

    expect(new Date(after.expires_at).getTime()).toBeGreaterThan(
      new Date(before.expires_at).getTime()
    );
  });

  it('heartbeat fails for wrong holder', () => {
    acquireRunLock(runId, { holder: 'worker-1', dbPath });
    const result = heartbeatRunLock(runId, 'worker-2', { dbPath });
    expect(result).toBe(false);
  });

  it('expired lock is auto-cleaned on acquire', () => {
    // Acquire with very short TTL
    acquireRunLock(runId, { holder: 'worker-1', ttlMs: 1, dbPath });
    // Wait a tiny bit to ensure expiry
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    // Another worker should be able to acquire since lock expired
    const result = acquireRunLock(runId, { holder: 'worker-2', dbPath });
    expect(result.acquired).toBe(true);
    expect(result.holder).toBe('worker-2');
  });

  it('cleanExpiredLocks removes stale locks', () => {
    acquireRunLock(runId, { holder: 'worker-1', ttlMs: 1, dbPath });
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }
    const cleaned = cleanExpiredLocks(dbPath);
    expect(cleaned).toBe(1);
    expect(isRunLocked(runId, dbPath)).toBeNull();
  });

  it('isRunLocked returns null when no lock', () => {
    expect(isRunLocked(runId, dbPath)).toBeNull();
  });

  describe('lock contention', () => {
    it('10 workers contend for same lock — exactly 1 wins', () => {
      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(acquireRunLock(runId, { holder: `worker-${i}`, dbPath }));
      }
      const winners = results.filter((r) => r.acquired);
      const losers = results.filter((r) => !r.acquired);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(9);
      // All losers see the winner's holder
      const winnerHolder = winners[0].holder;
      for (const loser of losers) {
        expect(loser.holder).toBe(winnerHolder);
      }
    });

    it('multiple runs lock independently under contention', () => {
      const runs = [];
      for (let i = 0; i < 5; i++) {
        runs.push(createRun({ industry: `ind-${i}`, country: `c-${i}`, dbPath }).id);
      }
      // Each run gets its own lock
      for (const rid of runs) {
        const result = acquireRunLock(rid, { holder: `worker-for-${rid}`, dbPath });
        expect(result.acquired).toBe(true);
      }
      // All 5 locked concurrently
      for (const rid of runs) {
        expect(isRunLocked(rid, dbPath)).toBeTruthy();
      }
    });
  });
});

// ─── Transactions ───────────────────────────────────────────

describe('withTransaction', () => {
  it('commits on success', () => {
    const db = openDb(dbPath);
    withTransaction(db, () => {
      createRun({ industry: 'tx-test', country: 'US', id: 'tx-1', dbPath });
    });
    expect(getRun('tx-1', dbPath)).toBeTruthy();
  });

  it('rolls back on error', () => {
    const db = openDb(dbPath);
    expect(() => {
      withTransaction(db, () => {
        createRun({ industry: 'tx-test', country: 'US', id: 'tx-2', dbPath });
        throw new Error('boom');
      });
    }).toThrow('boom');
    expect(getRun('tx-2', dbPath)).toBeNull();
  });
});

// ─── Artifact Pathing ───────────────────────────────────────

describe('artifact pathing', () => {
  it('builds correct attempt directory', () => {
    const dir = attemptDir('run-abc', '3a', 2);
    expect(dir).toContain(
      path.join('reports', 'phase-runs', 'run-abc', 'stages', '3a', 'attempt-2')
    );
  });

  it('builds correct artifact path', () => {
    const p = artifactPath('run-abc', '3a', 2, 'output.json');
    expect(p).toEndWith(path.join('attempt-2', 'output.json'));
  });

  it('builds relative path from project root', () => {
    const rel = artifactRelPath('run-abc', '3a', 2, 'output.json');
    expect(rel).toBe(
      path.join('reports', 'phase-runs', 'run-abc', 'stages', '3a', 'attempt-2', 'output.json')
    );
  });

  it('has all standard artifact filenames', () => {
    expect(ARTIFACT_FILES.OUTPUT_JSON).toBe('output.json');
    expect(ARTIFACT_FILES.OUTPUT_MD).toBe('output.md');
    expect(ARTIFACT_FILES.META_JSON).toBe('meta.json');
    expect(ARTIFACT_FILES.ERROR_JSON).toBe('error.json');
    expect(ARTIFACT_FILES.EVENTS_NDJSON).toBe('events.ndjson');
  });
});

// ─── Atomic Writes ──────────────────────────────────────────

describe('atomic writes', () => {
  it('writes file atomically (no partial reads)', () => {
    const filePath = path.join(tmpDir, 'atomic-test.json');
    const data = JSON.stringify({ key: 'value', nested: { a: 1 } });
    atomicWriteSync(filePath, data);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(data);
  });

  it('no .tmp files remain after write', () => {
    const filePath = path.join(tmpDir, 'atomic-clean.json');
    atomicWriteSync(filePath, 'test');
    const files = fs.readdirSync(tmpDir);
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('creates parent directories', () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'dir', 'file.json');
    atomicWriteSync(filePath, '{}');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('overwrites existing file atomically', () => {
    const filePath = path.join(tmpDir, 'overwrite.json');
    atomicWriteSync(filePath, 'first');
    atomicWriteSync(filePath, 'second');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('second');
  });
});

// ─── Write Artifact Integration ─────────────────────────────

describe('writeArtifact', () => {
  let runId;
  beforeEach(() => {
    // Override RUNS_BASE to use tmpDir for artifact file writes
    runId = createRun({ industry: 'test', country: 'test', dbPath }).id;
  });

  it('writes artifact and records in DB', () => {
    const result = writeArtifact({
      runId,
      stage: '2',
      attempt: 1,
      filename: 'output.json',
      content: { data: 'hello' },
      dbPath,
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(result.path)).toBe(true);
    // Check DB record
    const db = openDb(dbPath);
    const record = db
      .prepare('SELECT * FROM artifacts WHERE run_id = ? AND filename = ?')
      .get(runId, 'output.json');
    expect(record).toBeTruthy();
    expect(record.content_type).toBe('application/json');
  });

  it('writes stage artifacts bundle', () => {
    const results = writeStageArtifacts({
      runId,
      stage: '3',
      attempt: 1,
      output: { synthesis: 'test data' },
      meta: { duration_ms: 1234, model: 'gemini-3-flash' },
      events: [
        { type: 'info', message: 'started' },
        { type: 'metric', message: 'tokens', data: { count: 500 } },
      ],
      dbPath,
    });
    expect(results.outputJson).toBeTruthy();
    expect(results.metaJson).toBeTruthy();
    expect(results.eventsNdjson).toBeTruthy();
  });

  it('writes error artifact', () => {
    const result = writeErrorArtifact({
      runId,
      stage: '4',
      attempt: 1,
      error: new Error('quality gate failed'),
      dbPath,
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
    const content = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
    expect(content.name).toBe('Error');
    expect(content.message).toBe('quality gate failed');
    expect(content.stack).toBeTruthy();
  });

  it('saveArtifactRecord records externally-written files', () => {
    const filePath = path.join(tmpDir, 'external.json');
    fs.writeFileSync(filePath, '{"ext": true}');
    saveArtifactRecord({
      runId,
      stage: '7',
      attempt: 1,
      filename: 'external.json',
      filePath,
      dbPath,
    });
    const db = openDb(dbPath);
    const record = db
      .prepare('SELECT * FROM artifacts WHERE run_id = ? AND filename = ?')
      .get(runId, 'external.json');
    expect(record).toBeTruthy();
  });
});

// ─── Render Markdown ────────────────────────────────────────

describe('renderMd', () => {
  let runId;
  beforeEach(() => {
    runId = createRun({ industry: 'energy', country: 'Vietnam', dbPath }).id;
  });

  it('renders stage output as markdown', () => {
    const result = renderMd({
      runId,
      stage: '3',
      attempt: 1,
      output: {
        executiveSummary: 'Vietnam energy market is growing',
        keyFindings: ['finding 1', 'finding 2'],
        marketSize: { current: '$5B', projected: '$12B' },
      },
      meta: { duration_ms: 5000, model: 'gemini-3-flash' },
      dbPath,
    });
    const md = fs.readFileSync(result.path, 'utf-8');
    expect(md).toContain('# Stage 3');
    expect(md).toContain(runId);
    expect(md).toContain('Vietnam energy market');
    expect(md).toContain('finding 1');
    expect(md).toContain('$5B');
    expect(md).toContain('duration_ms');
  });

  it('handles null/empty output', () => {
    const result = renderMd({
      runId,
      stage: '2',
      attempt: 1,
      output: null,
      dbPath,
    });
    const md = fs.readFileSync(result.path, 'utf-8');
    expect(md).toContain('No output data');
  });

  it('handles string output', () => {
    const result = renderMd({
      runId,
      stage: '2',
      attempt: 1,
      output: 'Plain text research output',
      dbPath,
    });
    const md = fs.readFileSync(result.path, 'utf-8');
    expect(md).toContain('Plain text research output');
  });
});

// ─── Migration Idempotency ──────────────────────────────────

describe('migration', () => {
  it('can run migrate multiple times without error', () => {
    expect(() => migrate(dbPath)).not.toThrow();
    expect(() => migrate(dbPath)).not.toThrow();
    expect(() => migrate(dbPath)).not.toThrow();
  });

  it('tables exist after migration', () => {
    const db = openDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = tables.map((t) => t.name);
    expect(names).toContain('runs');
    expect(names).toContain('stage_attempts');
    expect(names).toContain('artifacts');
    expect(names).toContain('events');
    expect(names).toContain('run_locks');
  });
});

// ─── End-to-End Stage Attempt Lifecycle ─────────────────────

describe('end-to-end stage attempt lifecycle', () => {
  it('runs full lifecycle: create run → stages → artifacts → events → complete', () => {
    // 1. Create run
    const { id: runId } = createRun({
      industry: 'healthcare',
      country: 'Japan',
      targetStage: '4a',
      dbPath,
    });
    updateRunStatus(runId, 'running', null, dbPath);

    // 2. Acquire lock
    const lock = acquireRunLock(runId, { holder: 'e2e-worker', dbPath });
    expect(lock.acquired).toBe(true);

    // 3. Run stage 2
    const s2 = startStageAttempt(runId, '2', dbPath);
    appendEvent({
      runId,
      stage: '2',
      attempt: s2.attempt,
      type: 'info',
      message: 'research started',
      dbPath,
    });
    writeStageArtifacts({
      runId,
      stage: '2',
      attempt: s2.attempt,
      output: { research: 'data' },
      meta: { model: 'gemini-2.5-flash' },
      dbPath,
    });
    finishStageAttempt(runId, '2', s2.attempt, dbPath);

    // 4. Run stage 3 (fail then retry)
    const s3a1 = startStageAttempt(runId, '3', dbPath);
    failStageAttempt(runId, '3', s3a1.attempt, 'synthesis failed', dbPath);
    writeErrorArtifact({
      runId,
      stage: '3',
      attempt: s3a1.attempt,
      error: new Error('synthesis failed'),
      dbPath,
    });

    const s3a2 = startStageAttempt(runId, '3', dbPath);
    finishStageAttempt(runId, '3', s3a2.attempt, dbPath);

    // 5. Run stage 4, 4a
    const s4 = startStageAttempt(runId, '4', dbPath);
    finishStageAttempt(runId, '4', s4.attempt, dbPath);
    const s4a = startStageAttempt(runId, '4a', dbPath);
    finishStageAttempt(runId, '4a', s4a.attempt, dbPath);

    // 6. Complete run
    updateRunStatus(runId, 'completed', null, dbPath);
    releaseRunLock(runId, 'e2e-worker', dbPath);

    // Verify final state
    const run = getRun(runId, dbPath);
    expect(run.status).toBe('completed');
    expect(run.finished_at).toBeTruthy();

    const allAttempts = getStageAttempts(runId, null, dbPath);
    expect(allAttempts.length).toBe(5); // s2, s3a1, s3a2, s4, s4a

    const s3attempts = getStageAttempts(runId, '3', dbPath);
    expect(s3attempts[0].status).toBe('failed');
    expect(s3attempts[1].status).toBe('completed');

    const events = getEvents(runId, { dbPath });
    expect(events.length).toBeGreaterThanOrEqual(1);

    expect(isRunLocked(runId, dbPath)).toBeNull();
  });
});

// ─── Custom toEndWith matcher ───────────────────────────────

expect.extend({
  toEndWith(received, expected) {
    const pass = received.endsWith(expected);
    return {
      message: () => `expected "${received}" to end with "${expected}"`,
      pass,
    };
  },
});
