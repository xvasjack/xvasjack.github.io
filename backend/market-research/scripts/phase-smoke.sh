#!/usr/bin/env bash
# phase-smoke.sh — Minimal deterministic smoke test for phase-tracker infrastructure.
# Exercises: DB init, run create, stage lifecycle, artifact write, error artifact.
# No AI calls. No network. Pure local validation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# Use a temp directory for the smoke test DB and artifacts
SMOKE_DIR=$(mktemp -d /tmp/phase-smoke-XXXXXX)
SMOKE_DB="$SMOKE_DIR/smoke.sqlite"
trap 'rm -rf "$SMOKE_DIR"' EXIT

echo "=== Phase Tracker Smoke Test ==="
echo "DB: $SMOKE_DB"
echo ""

# --- 1. Database migration ---
echo "[1/7] Migrating database schema..."
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  migrate('$SMOKE_DB');
  console.log('  OK: schema applied');
"

# --- 2. Create a run ---
echo "[2/7] Creating run..."
RUN_ID=$(node -e "
  const { createRun } = require('./phase-tracker/storage/runs-repo');
  const { id } = createRun({
    industry: 'smoke-test',
    country: 'Testland',
    targetStage: '3',
    dbPath: '$SMOKE_DB'
  });
  process.stdout.write(id);
")
echo "  OK: runId=$RUN_ID"

# --- 3. Check run status ---
echo "[3/7] Verifying run status..."
node -e "
  const { getRun } = require('./phase-tracker/storage/runs-repo');
  const run = getRun('$RUN_ID', '$SMOKE_DB');
  if (!run) { console.error('  FAIL: run not found'); process.exit(1); }
  if (run.status !== 'pending') { console.error('  FAIL: expected pending, got', run.status); process.exit(1); }
  if (run.target_stage !== '3') { console.error('  FAIL: target_stage wrong'); process.exit(1); }
  console.log('  OK: status=pending, target_stage=3');
"

# --- 4. Run stages 2 and 2a ---
echo "[4/7] Running stages 2 and 2a..."
node -e "
  const { updateRunStatus } = require('./phase-tracker/storage/runs-repo');
  const { startStageAttempt, finishStageAttempt } = require('./phase-tracker/storage/stages-repo');
  const { writeStageArtifacts } = require('./phase-tracker/artifacts/write-artifact');
  const { renderMd } = require('./phase-tracker/artifacts/render-md');

  updateRunStatus('$RUN_ID', 'running', null, '$SMOKE_DB');

  for (const stage of ['2', '2a']) {
    const a = startStageAttempt('$RUN_ID', stage, '$SMOKE_DB');
    writeStageArtifacts({
      runId: '$RUN_ID', stage, attempt: a.attempt,
      output: { stage, smoke: true, ts: Date.now() },
      meta: { stage, kind: 'smoke' },
      dbPath: '$SMOKE_DB'
    });
    renderMd({
      runId: '$RUN_ID', stage, attempt: a.attempt,
      output: { stage, smoke: true },
      meta: { stage },
      dbPath: '$SMOKE_DB'
    });
    finishStageAttempt('$RUN_ID', stage, a.attempt, '$SMOKE_DB');
    console.log('  OK: stage', stage, 'completed (attempt', a.attempt + ')');
  }
"

# --- 5. Fail stage 3 (simulated) ---
echo "[5/7] Simulating stage 3 failure..."
node -e "
  const { startStageAttempt, failStageAttempt } = require('./phase-tracker/storage/stages-repo');
  const { writeErrorArtifact } = require('./phase-tracker/artifacts/write-artifact');

  const a = startStageAttempt('$RUN_ID', '3', '$SMOKE_DB');
  writeErrorArtifact({
    runId: '$RUN_ID', stage: '3', attempt: a.attempt,
    error: { code: 'SMOKE_FAIL', message: 'Intentional smoke test failure' },
    dbPath: '$SMOKE_DB'
  });
  failStageAttempt('$RUN_ID', '3', a.attempt, 'Intentional smoke test failure', '$SMOKE_DB');
  console.log('  OK: stage 3 failed (attempt', a.attempt + ')');
"

# --- 6. Verify artifacts on disk ---
echo "[6/7] Checking artifact files..."
STAGE2_DIR="reports/phase-runs/$RUN_ID/stages/2/attempt-1"
STAGE3_DIR="reports/phase-runs/$RUN_ID/stages/3/attempt-1"

PASS=true
for f in "$STAGE2_DIR/output.json" "$STAGE2_DIR/output.md" "$STAGE2_DIR/meta.json" "$STAGE3_DIR/error.json"; do
  if [ -f "$f" ]; then
    SIZE=$(wc -c < "$f")
    echo "  OK: $f ($SIZE bytes)"
  else
    echo "  FAIL: missing $f"
    PASS=false
  fi
done

# --- 7. Verify DB state ---
echo "[7/7] Verifying database state..."
node -e "
  const { getRun } = require('./phase-tracker/storage/runs-repo');
  const { getStageAttempts, getLatestAttempt } = require('./phase-tracker/storage/stages-repo');
  const { closeDb } = require('./phase-tracker/storage/db');

  const attempts = getStageAttempts('$RUN_ID', null, '$SMOKE_DB');
  if (attempts.length !== 3) {
    console.error('  FAIL: expected 3 attempts, got', attempts.length);
    process.exit(1);
  }

  const s2 = getLatestAttempt('$RUN_ID', '2', '$SMOKE_DB');
  const s2a = getLatestAttempt('$RUN_ID', '2a', '$SMOKE_DB');
  const s3 = getLatestAttempt('$RUN_ID', '3', '$SMOKE_DB');

  if (s2.status !== 'completed') { console.error('  FAIL: stage 2 not completed'); process.exit(1); }
  if (s2a.status !== 'completed') { console.error('  FAIL: stage 2a not completed'); process.exit(1); }
  if (s3.status !== 'failed') { console.error('  FAIL: stage 3 not failed'); process.exit(1); }

  console.log('  OK: 2=completed, 2a=completed, 3=failed');

  closeDb('$SMOKE_DB');
"

# --- Cleanup artifacts (DB already in temp dir) ---
rm -rf "reports/phase-runs/$RUN_ID"

echo ""
if $PASS; then
  echo "=== SMOKE TEST PASSED ==="
else
  echo "=== SMOKE TEST FAILED ==="
  exit 1
fi
