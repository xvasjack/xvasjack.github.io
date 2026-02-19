'use strict';

const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { openDb } = require('../storage/db');
const { migrate } = require('../storage/migrate');
const { createRun, getRun, listRuns, updateRunStatus } = require('../storage/runs-repo');
const {
  startStageAttempt,
  finishStageAttempt,
  failStageAttempt,
  getStageAttempts,
  appendEvent,
} = require('../storage/stages-repo');
const { acquireRunLock, releaseRunLock, heartbeatRunLock } = require('../storage/locks');
const { writeStageArtifacts, writeErrorArtifact } = require('../artifacts/write-artifact');
const { renderMd } = require('../artifacts/render-md');
const { STAGE_ORDER, VALID_STAGE_IDS } = require('../contracts/stages');
const { executeStage, loadStageContext } = require('./stage-controller');
const { emitHook, sanitizeStagePayload } = require('./stage-payload-sanitizer');
const { runStrictTemplateGate, buildTemplateErrorArtifact } = require('./template-strict-gate');

// ── Validation ───────────────────────────────────────────────────────────────
function validateThroughStage(through) {
  if (!VALID_STAGE_IDS.has(through)) {
    throw new Error(`Invalid --through stage "${through}". Valid: ${STAGE_ORDER.join(', ')}`);
  }
}

// ── Stage queries ────────────────────────────────────────────────────────────
function getCompletedStages(runId, dbPath) {
  const db = openDb(dbPath);
  const rows = db
    .prepare(
      `SELECT DISTINCT stage FROM stage_attempts
       WHERE run_id = ? AND status = 'completed'
       ORDER BY id`
    )
    .all(runId);
  return rows.map((r) => r.stage);
}

function getNextPendingStage(runId, dbPath) {
  const completed = new Set(getCompletedStages(runId, dbPath));
  for (const stage of STAGE_ORDER) {
    if (!completed.has(stage)) return stage;
  }
  return null;
}

// ── Main runner ──────────────────────────────────────────────────────────────
async function runThrough({
  runId,
  through,
  country,
  industry,
  clientContext,
  strictTemplate = true,
  dbPath,
  hooks,
}) {
  validateThroughStage(through);

  // Ensure DB is migrated
  migrate(dbPath);

  let run = getRun(runId, dbPath);

  if (!run) {
    // New run — country and industry required
    if (!country || !industry) {
      throw new Error(`New run "${runId}" requires --country and --industry.`);
    }
    const { id } = createRun({
      id: runId,
      country,
      industry,
      clientContext: clientContext || null,
      targetStage: through,
      dbPath,
    });
    run = getRun(id, dbPath);
    console.log(`[phase-runner] Created new run: ${runId} (${country} / ${industry})`);
  } else {
    // Existing run — update target stage
    updateRunStatus(runId, run.status === 'failed' ? 'pending' : run.status, null, dbPath);
    const db = openDb(dbPath);
    db.prepare('UPDATE runs SET target_stage = ?, updated_at = ? WHERE id = ?').run(
      through,
      new Date().toISOString(),
      runId
    );
    console.log(`[phase-runner] Resuming run: ${runId} (${run.country} / ${run.industry})`);
  }

  const runCountry = run.country;
  const runIndustry = run.industry;
  const runClientContext = run.client_context || null;

  // Acquire lock
  const lockResult = acquireRunLock(runId, { dbPath });
  if (!lockResult.acquired) {
    throw new Error(
      `Run ${runId} is locked by ${lockResult.holder}. Wait for it to finish or remove the lock manually.`
    );
  }
  const holder = lockResult.holder;
  console.log(`[phase-runner] Lock acquired: ${holder}`);

  // Mark running
  updateRunStatus(runId, 'running', null, dbPath);

  // Determine stage range
  const throughIdx = STAGE_ORDER.indexOf(through);
  const nextPending = getNextPendingStage(runId, dbPath);

  if (!nextPending) {
    releaseRunLock(runId, holder, dbPath);
    console.log(`[phase-runner] All stages already completed for run ${runId}.`);
    return { runId, status: 'completed', stages: [] };
  }

  const startIdx = STAGE_ORDER.indexOf(nextPending);
  if (startIdx > throughIdx) {
    releaseRunLock(runId, holder, dbPath);
    console.log(`[phase-runner] Stage ${nextPending} is past --through ${through}. Nothing to do.`);
    return { runId, status: 'completed', stages: [] };
  }

  const stagesToRun = STAGE_ORDER.slice(startIdx, throughIdx + 1);
  console.log(`[phase-runner] Stages to run: ${stagesToRun.join(' -> ')}`);

  // Build context from completed stages
  const context = await loadStageContext(runId, dbPath, {
    country: runCountry,
    industry: runIndustry,
    clientContext: runClientContext,
  });

  const results = [];
  let failed = false;

  for (const stage of stagesToRun) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[phase-runner] STAGE ${stage} starting...`);
    console.log('='.repeat(60));

    // Refresh lock
    heartbeatRunLock(runId, holder, { dbPath });

    // Emit hook
    await emitHook(hooks, 'onStageStart', stage, { runId, stage });

    const attemptRecord = startStageAttempt(runId, stage, dbPath);
    const attempt = attemptRecord.attempt;
    const startTime = Date.now();

    try {
      const stageResult = await executeStage(stage, context, {
        runId,
        dbPath,
        strictTemplate,
      });

      const durationMs = Date.now() - startTime;

      // Template strict gate check after PPT build (stage 7)
      if (stage === '7' && strictTemplate && stageResult.pptInspection) {
        const gateResult = runStrictTemplateGate(stageResult.pptInspection);
        if (!gateResult.pass) {
          const errorArt = buildTemplateErrorArtifact(gateResult);
          writeErrorArtifact({
            runId,
            stage,
            attempt,
            error: errorArt,
            dbPath,
          });
          // Terminal output for blocking slide keys
          console.error(`\n[TEMPLATE STRICT GATE] HARD FAIL`);
          console.error(gateResult.summary);
          throw new Error(
            `Template strict gate failed: ${gateResult.violations.length} violation(s). ` +
              `Blocking slide keys: ${gateResult.blockingSlideKeys.join(', ')}`
          );
        }
      }

      // Write artifacts
      const outputData = sanitizeStagePayload(stageResult.data);
      writeStageArtifacts({
        runId,
        stage,
        attempt,
        output: outputData,
        meta: {
          stage,
          durationMs,
          gateResults: stageResult.gateResults || null,
          metrics: stageResult.metrics || null,
          completedAt: new Date().toISOString(),
        },
        dbPath,
      });

      // Write markdown summary
      renderMd({
        runId,
        stage,
        attempt,
        output: outputData,
        meta: {
          durationMs,
          gateResults: stageResult.gateResults || null,
        },
        dbPath,
      });

      // Write binary artifacts (e.g. PPTX) directly to attempt dir
      if (stageResult.binary) {
        const { attemptDir } = require('../artifacts/pathing');
        const dir = attemptDir(runId, stage, attempt);
        fs.mkdirSync(dir, { recursive: true });
        for (const [filename, buffer] of Object.entries(stageResult.binary)) {
          const binPath = path.join(dir, filename);
          fs.writeFileSync(binPath, buffer);
          // Record in DB
          const { saveArtifactRecord } = require('../artifacts/write-artifact');
          saveArtifactRecord({ runId, stage, attempt, filename, filePath: binPath, dbPath });
        }
      }

      // Mark completed
      finishStageAttempt(runId, stage, attempt, dbPath);

      // Log event
      appendEvent({
        runId,
        stage,
        attempt,
        type: 'info',
        message: `Stage ${stage} completed in ${durationMs}ms`,
        data: { durationMs, gateResults: stageResult.gateResults || null },
        dbPath,
      });

      // Emit hook
      await emitHook(hooks, 'onStageComplete', stage, {
        runId,
        stage,
        durationMs,
        gateResults: stageResult.gateResults,
      });

      results.push({
        stage,
        status: 'completed',
        durationMs,
        gateResults: stageResult.gateResults || null,
      });
      console.log(`[phase-runner] STAGE ${stage} completed (${durationMs}ms)`);
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorData = { message: err.message, stack: err.stack };

      // Write error artifact
      writeErrorArtifact({ runId, stage, attempt, error: err, dbPath });

      // Mark failed
      failStageAttempt(runId, stage, attempt, errorData, dbPath);

      // Log error event
      appendEvent({
        runId,
        stage,
        attempt,
        type: 'error',
        message: `Stage ${stage} failed: ${err.message}`,
        data: errorData,
        dbPath,
      });

      // Emit hook
      await emitHook(hooks, 'onStageFail', stage, { runId, stage, error: err.message, durationMs });

      results.push({ stage, status: 'failed', durationMs, error: err.message });
      console.error(`[phase-runner] STAGE ${stage} FAILED (${durationMs}ms): ${err.message}`);

      failed = true;
      break; // fail-fast
    }
  }

  // Update run status
  const allCompleted = getNextPendingStage(runId, dbPath) === null;
  const finalStatus = failed ? 'failed' : allCompleted ? 'completed' : 'pending';
  updateRunStatus(runId, finalStatus, failed ? results.find((r) => r.error)?.error : null, dbPath);

  // Release lock
  releaseRunLock(runId, holder, dbPath);
  console.log(`\n[phase-runner] Lock released. Run ${runId} status: ${finalStatus}`);

  return { runId, status: finalStatus, stages: results };
}

module.exports = {
  runThrough,
  getCompletedStages,
  getNextPendingStage,
  validateThroughStage,
};
