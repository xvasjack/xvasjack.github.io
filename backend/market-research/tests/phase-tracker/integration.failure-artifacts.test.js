'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { migrate } = require('../../phase-tracker/storage/migrate');
const { openDb, closeDb } = require('../../phase-tracker/storage/db');
const { createRun, getRun, updateRunStatus } = require('../../phase-tracker/storage/runs-repo');
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
const { STAGES } = require('../../phase-tracker/contracts/stages');
const { validateShape, PhaseRunArgsSchema } = require('../../phase-tracker/contracts/types');
const { stagesThrough } = require('../../phase-tracker/core/stage-order');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-fail-'));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('phase-tracker: failure artifacts and recovery', () => {
  let dbPath;

  beforeEach(() => {
    dbPath = tmpDbPath();
    migrate(dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  // ---- Stage failure writes error.json ----

  test('failed stage writes error.json artifact', () => {
    const { id: runId } = createRun({
      industry: 'fintech',
      country: 'Germany',
      targetStage: '3',
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);

    // Stage 2 succeeds
    const attempt2 = startStageAttempt(runId, '2', dbPath);
    writeStageArtifacts({
      runId,
      stage: '2',
      attempt: attempt2.attempt,
      output: { topics: 25 },
      dbPath,
    });
    finishStageAttempt(runId, '2', attempt2.attempt, dbPath);

    // Stage 2a fails
    const attempt2a = startStageAttempt(runId, '2a', dbPath);
    const error = new Error('Gemini Pro timeout after 30s');
    error.code = 'GEMINI_TIMEOUT';

    writeErrorArtifact({
      runId,
      stage: '2a',
      attempt: attempt2a.attempt,
      error,
      dbPath,
    });
    failStageAttempt(runId, '2a', attempt2a.attempt, error.message, dbPath);

    // Verify error.json on disk
    const errorPath = path.join(attemptDir(runId, '2a', 1), 'error.json');
    expect(fs.existsSync(errorPath)).toBe(true);

    const errorJson = JSON.parse(fs.readFileSync(errorPath, 'utf-8'));
    expect(errorJson.name).toBe('Error');
    expect(errorJson.message).toBe('Gemini Pro timeout after 30s');
    expect(errorJson.stack).toBeTruthy();

    // Verify stage attempt status
    const latest = getLatestAttempt(runId, '2a', dbPath);
    expect(latest.status).toBe('failed');
    expect(latest.error).toContain('Gemini Pro timeout');
    expect(latest.duration_ms).toBeGreaterThanOrEqual(0);
  });

  // ---- Fail-fast: 1 attempt per stage, no hidden retries ----

  test('fail-fast: stage failure stops pipeline with single attempt', () => {
    const { id: runId } = createRun({
      industry: 'healthcare',
      country: 'Japan',
      targetStage: '9',
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);

    // Stages 2 and 2a succeed
    for (const stageId of ['2', '2a']) {
      const a = startStageAttempt(runId, stageId, dbPath);
      writeStageArtifacts({
        runId,
        stage: stageId,
        attempt: a.attempt,
        output: { ok: true },
        dbPath,
      });
      finishStageAttempt(runId, stageId, a.attempt, dbPath);
    }

    // Stage 3 fails — pipeline stops
    const attempt3 = startStageAttempt(runId, '3', dbPath);
    writeErrorArtifact({
      runId,
      stage: '3',
      attempt: attempt3.attempt,
      error: { code: 'SYNTHESIS_FAILED', message: 'Insufficient data for synthesis' },
      dbPath,
    });
    failStageAttempt(runId, '3', attempt3.attempt, 'Insufficient data for synthesis', dbPath);
    updateRunStatus(
      runId,
      'failed',
      JSON.stringify({ stage: '3', reason: 'synthesis failed' }),
      dbPath
    );

    // Run is failed
    const run = getRun(runId, dbPath);
    expect(run.status).toBe('failed');
    expect(run.finished_at).toBeTruthy();
    expect(JSON.parse(run.error).stage).toBe('3');

    // Only 3 stage attempts exist (2, 2a, 3) — no stages after 3
    const all = getStageAttempts(runId, null, dbPath);
    expect(all).toHaveLength(3);

    // Stage 3 has exactly 1 attempt (fail-fast, no retries)
    const stage3 = getStageAttempts(runId, '3', dbPath);
    expect(stage3).toHaveLength(1);
    expect(stage3[0].status).toBe('failed');

    // No attempts for stages 3a..9
    for (const stageId of ['3a', '4', '4a', '5', '6', '6a', '7', '8', '8a', '9']) {
      expect(getStageAttempts(runId, stageId, dbPath)).toHaveLength(0);
    }
  });

  // ---- Error artifact contains full error shape ----

  test('error artifact captures Error name, message, and stack', () => {
    const { id: runId } = createRun({
      industry: 'energy',
      country: 'Norway',
      targetStage: '7',
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);
    const attempt = startStageAttempt(runId, '7', dbPath);

    const err = new TypeError('Cannot read property "slides" of undefined');
    writeErrorArtifact({ runId, stage: '7', attempt: attempt.attempt, error: err, dbPath });

    const errorPath = path.join(attemptDir(runId, '7', 1), 'error.json');
    const parsed = JSON.parse(fs.readFileSync(errorPath, 'utf-8'));
    expect(parsed.name).toBe('TypeError');
    expect(parsed.message).toContain('slides');
    expect(parsed.stack).toContain('TypeError');
  });

  // ---- Error artifact from plain object ----

  test('error artifact from plain object (not Error instance)', () => {
    const { id: runId } = createRun({
      industry: 'fintech',
      country: 'UK',
      targetStage: '8',
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);
    const attempt = startStageAttempt(runId, '8', dbPath);

    writeErrorArtifact({
      runId,
      stage: '8',
      attempt: attempt.attempt,
      error: {
        code: 'PPTX_CORRUPT',
        message: 'ZIP central directory missing',
        severity: 'critical',
        blockingSlideKeys: ['ppt/slideLayouts/slideLayout1.xml', 'ppt/slides/slide5.xml'],
      },
      dbPath,
    });

    const errorPath = path.join(attemptDir(runId, '8', 1), 'error.json');
    const parsed = JSON.parse(fs.readFileSync(errorPath, 'utf-8'));
    expect(parsed.code).toBe('PPTX_CORRUPT');
    expect(parsed.blockingSlideKeys).toContain('ppt/slideLayouts/slideLayout1.xml');
    expect(parsed.severity).toBe('critical');
  });

  // ---- Strict template failure with blocking slide keys ----

  test('template failure: error artifact with blockingSlideKeys for operator inspection', () => {
    const { id: runId } = createRun({
      industry: 'healthcare',
      country: 'Brazil',
      targetStage: '8',
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);

    // Stages 2..7 succeed
    for (const stageId of ['2', '2a', '3', '3a', '4', '4a', '5', '6', '6a', '7']) {
      const a = startStageAttempt(runId, stageId, dbPath);
      writeStageArtifacts({
        runId,
        stage: stageId,
        attempt: a.attempt,
        output: { ok: true },
        dbPath,
      });
      finishStageAttempt(runId, stageId, a.attempt, dbPath);
    }

    // Stage 8 (PPT Health Check) fails with template violations
    const attempt8 = startStageAttempt(runId, '8', dbPath);
    const templateError = {
      code: 'TEMPLATE_STRICT_FAILURE',
      message: 'Strict template check failed: 3 blocking slide keys',
      severity: 'critical',
      blockingSlideKeys: [
        'ppt/slideLayouts/slideLayout1.xml',
        'ppt/slideLayouts/slideLayout3.xml',
        'ppt/slideMasters/slideMaster1.xml',
      ],
      issues: [
        {
          code: 'line_width_signature_mismatch',
          severity: 'critical',
          slide: 'slideLayout1.xml',
          expected: [12700, 6350],
          actual: [9525],
          message: 'Line widths do not match template contract',
        },
        {
          code: 'font_family_mismatch',
          severity: 'critical',
          slide: 'slideLayout3.xml',
          expected: 'Segoe UI',
          actual: 'Century Gothic',
        },
        {
          code: 'color_drift',
          severity: 'critical',
          slide: 'slideMaster1.xml',
          expected: '#1B3A5C',
          actual: '#2B4A6C',
          delta: 16,
        },
      ],
      templateSource: '251219_Escort_Phase 1 Market Selection_V3.pptx',
    };

    // Write error artifact with template details
    writeErrorArtifact({
      runId,
      stage: '8',
      attempt: attempt8.attempt,
      error: templateError,
      dbPath,
    });

    // Also log as gate event
    appendEvent({
      runId,
      stage: '8',
      attempt: attempt8.attempt,
      type: 'gate',
      message: 'Strict template check FAILED',
      data: templateError,
      dbPath,
    });

    failStageAttempt(runId, '8', attempt8.attempt, JSON.stringify(templateError), dbPath);
    updateRunStatus(
      runId,
      'failed',
      JSON.stringify({ stage: '8', reason: 'template check' }),
      dbPath
    );

    // Operator inspection: read error.json
    const errorPath = path.join(attemptDir(runId, '8', 1), 'error.json');
    const parsed = JSON.parse(fs.readFileSync(errorPath, 'utf-8'));

    expect(parsed.code).toBe('TEMPLATE_STRICT_FAILURE');
    expect(parsed.blockingSlideKeys).toHaveLength(3);
    expect(parsed.issues).toHaveLength(3);
    expect(parsed.issues[0].code).toBe('line_width_signature_mismatch');
    expect(parsed.templateSource).toContain('Escort');

    // Operator can query gate events
    const gateEvents = getEvents(runId, { stage: '8', type: 'gate', dbPath });
    expect(gateEvents).toHaveLength(1);
    const gateData = JSON.parse(gateEvents[0].data);
    expect(gateData.blockingSlideKeys).toEqual(parsed.blockingSlideKeys);
  });

  // ---- Recovery flow: resume same runId after failure ----

  test('recovery: resume failed run with same runId', () => {
    const runId = 'run-recovery-test-001';
    createRun({
      industry: 'logistics',
      country: 'Singapore',
      targetStage: '9',
      id: runId,
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);

    // Stages 2, 2a succeed
    for (const stageId of ['2', '2a']) {
      const a = startStageAttempt(runId, stageId, dbPath);
      writeStageArtifacts({
        runId,
        stage: stageId,
        attempt: a.attempt,
        output: { ok: true },
        dbPath,
      });
      finishStageAttempt(runId, stageId, a.attempt, dbPath);
    }

    // Stage 3 fails (attempt 1)
    const failAttempt = startStageAttempt(runId, '3', dbPath);
    expect(failAttempt.attempt).toBe(1);
    writeErrorArtifact({
      runId,
      stage: '3',
      attempt: failAttempt.attempt,
      error: { message: 'Rate limit hit' },
      dbPath,
    });
    failStageAttempt(runId, '3', failAttempt.attempt, 'Rate limit hit', dbPath);
    updateRunStatus(runId, 'failed', JSON.stringify({ stage: '3' }), dbPath);

    // --- RECOVERY: operator re-runs ---
    updateRunStatus(runId, 'running', null, dbPath);

    // Stage 3, attempt 2
    const retryAttempt = startStageAttempt(runId, '3', dbPath);
    expect(retryAttempt.attempt).toBe(2); // Auto-incremented

    writeStageArtifacts({
      runId,
      stage: '3',
      attempt: retryAttempt.attempt,
      output: { synthesis: 'recovered data' },
      dbPath,
    });
    finishStageAttempt(runId, '3', retryAttempt.attempt, dbPath);

    // Continue stages 3a..5
    for (const stageId of ['3a', '4', '4a', '5']) {
      const a = startStageAttempt(runId, stageId, dbPath);
      writeStageArtifacts({
        runId,
        stage: stageId,
        attempt: a.attempt,
        output: { recovered: true },
        dbPath,
      });
      finishStageAttempt(runId, stageId, a.attempt, dbPath);
    }
    updateRunStatus(runId, 'completed', null, dbPath);

    // Verify recovery: stage 3 has 2 attempts
    const stage3 = getStageAttempts(runId, '3', dbPath);
    expect(stage3).toHaveLength(2);
    expect(stage3[0].status).toBe('failed');
    expect(stage3[1].status).toBe('completed');

    // Error artifact from attempt 1 still exists
    const errorPath = path.join(attemptDir(runId, '3', 1), 'error.json');
    expect(fs.existsSync(errorPath)).toBe(true);

    // Output artifact from attempt 2 exists
    const outputPath = path.join(attemptDir(runId, '3', 2), 'output.json');
    expect(fs.existsSync(outputPath)).toBe(true);

    // Latest attempt for stage 3 is the successful one
    const latest = getLatestAttempt(runId, '3', dbPath);
    expect(latest.attempt).toBe(2);
    expect(latest.status).toBe('completed');

    // Run is completed
    const run = getRun(runId, dbPath);
    expect(run.status).toBe('completed');
    expect(run.finished_at).toBeTruthy();
  });

  // ---- Events recorded for failed stages ----

  test('error events captured alongside error artifacts', () => {
    const { id: runId } = createRun({
      industry: 'energy',
      country: 'Australia',
      targetStage: '5',
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);
    const attempt = startStageAttempt(runId, '5', dbPath);

    appendEvent({
      runId,
      stage: '5',
      attempt: attempt.attempt,
      type: 'error',
      message: 'Schema validation failed: missing pptData.slides',
      data: { missing: ['slides'], found: ['summary', 'metadata'] },
      dbPath,
    });

    writeErrorArtifact({
      runId,
      stage: '5',
      attempt: attempt.attempt,
      error: { code: 'SCHEMA_INVALID', missing: ['slides'] },
      dbPath,
    });

    failStageAttempt(runId, '5', attempt.attempt, 'Schema validation failed', dbPath);

    // Query error events
    const errors = getEvents(runId, { type: 'error', dbPath });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Schema validation');
    expect(JSON.parse(errors[0].data).missing).toEqual(['slides']);
  });

  // ---- validateShape for PhaseRunArgs ----

  test('validateShape: valid PhaseRunArgs passes', () => {
    const args = {
      runId: 'run-abc123-12345678',
      country: 'Germany',
      industry: 'fintech',
      through: '3a',
      strictTemplate: true,
      attemptsPerStage: 1,
    };
    const result = validateShape(args, PhaseRunArgsSchema);
    expect(result.valid).toBe(true);
  });

  test('validateShape: missing required fields fails', () => {
    const result = validateShape({ runId: 'x' }, PhaseRunArgsSchema);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('country'),
        expect.stringContaining('industry'),
        expect.stringContaining('through'),
      ])
    );
  });

  test('validateShape: wrong type fails', () => {
    const result = validateShape(
      {
        runId: 'x',
        country: 'Y',
        industry: 'Z',
        through: '3',
        attemptsPerStage: 'one', // should be integer
      },
      PhaseRunArgsSchema
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('attemptsPerStage'))).toBe(true);
  });

  // ---- Multiple failures on same stage produce separate attempt dirs ----

  test('multiple failures create separate attempt directories', () => {
    const { id: runId } = createRun({
      industry: 'mining',
      country: 'Peru',
      targetStage: '3',
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);

    // Stage 2 succeeds
    const a2 = startStageAttempt(runId, '2', dbPath);
    writeStageArtifacts({ runId, stage: '2', attempt: a2.attempt, output: { ok: true }, dbPath });
    finishStageAttempt(runId, '2', a2.attempt, dbPath);

    // Stage 2a fails 3 times
    for (let i = 1; i <= 3; i++) {
      const a = startStageAttempt(runId, '2a', dbPath);
      expect(a.attempt).toBe(i);

      writeErrorArtifact({
        runId,
        stage: '2a',
        attempt: a.attempt,
        error: { message: `Attempt ${i} failed`, attempt: i },
        dbPath,
      });
      failStageAttempt(runId, '2a', a.attempt, `Attempt ${i} failed`, dbPath);

      // Each attempt has its own directory
      const dir = attemptDir(runId, '2a', i);
      expect(fs.existsSync(path.join(dir, 'error.json'))).toBe(true);
    }

    // 3 failed attempts for stage 2a
    const attempts = getStageAttempts(runId, '2a', dbPath);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.status === 'failed')).toBe(true);

    // Directories are separate
    const dir1 = attemptDir(runId, '2a', 1);
    const dir2 = attemptDir(runId, '2a', 2);
    const dir3 = attemptDir(runId, '2a', 3);
    expect(dir1).not.toBe(dir2);
    expect(dir2).not.toBe(dir3);
  });

  // ---- Run cancelled status ----

  test('cancelled run sets finished_at', () => {
    const { id: runId } = createRun({
      industry: 'retail',
      country: 'India',
      targetStage: '9',
      dbPath,
    });

    updateRunStatus(runId, 'running', null, dbPath);
    updateRunStatus(runId, 'cancelled', null, dbPath);

    const run = getRun(runId, dbPath);
    expect(run.status).toBe('cancelled');
    expect(run.finished_at).toBeTruthy();
  });
});
