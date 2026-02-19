#!/usr/bin/env bash
# phase-verify.sh — Full verification of phase-tracker status queries,
# artifact paths, and database integrity.
# Covers: run CRUD, stage lifecycle, artifact presence, lock management,
# parallel run isolation, and resume-after-failure flow.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

VERIFY_DIR=$(mktemp -d /tmp/phase-verify-XXXXXX)
VERIFY_DB="$VERIFY_DIR/verify.sqlite"
trap 'rm -rf "$VERIFY_DIR"; rm -rf reports/phase-runs/run-verify-*' EXIT

PASS=0
FAIL=0

ok() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== Phase Tracker Full Verification ==="
echo "DB: $VERIFY_DB"
echo ""

# --- 1. Schema migration (idempotent) ---
echo "[1/10] Schema migration..."
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  migrate('$VERIFY_DB');
  migrate('$VERIFY_DB');  // second call should be idempotent
" && ok "schema migration idempotent" || fail "schema migration"

# --- 2. Run CRUD ---
echo "[2/10] Run create / get / list..."
RUN_A=$(node -e "
  const { createRun } = require('./phase-tracker/storage/runs-repo');
  const { id } = createRun({
    industry: 'fintech', country: 'Germany',
    targetStage: '3a', dbPath: '$VERIFY_DB'
  });
  process.stdout.write(id);
")
RUN_B=$(node -e "
  const { createRun } = require('./phase-tracker/storage/runs-repo');
  const { id } = createRun({
    industry: 'healthcare', country: 'Japan',
    targetStage: '5', id: 'run-verify-custom', dbPath: '$VERIFY_DB'
  });
  process.stdout.write(id);
")

node -e "
  const { getRun, listRuns } = require('./phase-tracker/storage/runs-repo');
  const a = getRun('$RUN_A', '$VERIFY_DB');
  const b = getRun('$RUN_B', '$VERIFY_DB');
  if (!a || a.industry !== 'fintech') process.exit(1);
  if (!b || b.id !== 'run-verify-custom') process.exit(1);
  const runs = listRuns({ dbPath: '$VERIFY_DB' });
  if (runs.length !== 2) process.exit(1);
" && ok "run CRUD (create, get, list, custom ID)" || fail "run CRUD"

# --- 3. Run status transitions ---
echo "[3/10] Status transitions..."
node -e "
  const { getRun, updateRunStatus } = require('./phase-tracker/storage/runs-repo');

  // pending -> running
  updateRunStatus('$RUN_A', 'running', null, '$VERIFY_DB');
  let r = getRun('$RUN_A', '$VERIFY_DB');
  if (r.status !== 'running') process.exit(1);
  if (r.finished_at) process.exit(1);

  // running -> failed (sets finished_at)
  updateRunStatus('$RUN_A', 'failed', JSON.stringify({reason:'test'}), '$VERIFY_DB');
  r = getRun('$RUN_A', '$VERIFY_DB');
  if (r.status !== 'failed') process.exit(1);
  if (!r.finished_at) process.exit(1);

  // failed -> running (resume)
  updateRunStatus('$RUN_A', 'running', null, '$VERIFY_DB');
  r = getRun('$RUN_A', '$VERIFY_DB');
  if (r.status !== 'running') process.exit(1);
" && ok "status transitions (pending->running->failed->running)" || fail "status transitions"

# --- 4. Stage attempt lifecycle ---
echo "[4/10] Stage attempts..."
node -e "
  const { startStageAttempt, finishStageAttempt, failStageAttempt,
          getStageAttempts, getLatestAttempt } = require('./phase-tracker/storage/stages-repo');

  // Start and complete stage 2
  const a1 = startStageAttempt('$RUN_A', '2', '$VERIFY_DB');
  if (a1.attempt !== 1) process.exit(1);
  if (a1.status !== 'running') process.exit(1);
  finishStageAttempt('$RUN_A', '2', 1, '$VERIFY_DB');

  const latest2 = getLatestAttempt('$RUN_A', '2', '$VERIFY_DB');
  if (latest2.status !== 'completed') process.exit(1);
  if (typeof latest2.duration_ms !== 'number') process.exit(1);

  // Start and fail stage 2a
  const a2 = startStageAttempt('$RUN_A', '2a', '$VERIFY_DB');
  failStageAttempt('$RUN_A', '2a', 1, 'test error', '$VERIFY_DB');
  const latest2a = getLatestAttempt('$RUN_A', '2a', '$VERIFY_DB');
  if (latest2a.status !== 'failed') process.exit(1);
  if (!latest2a.error.includes('test error')) process.exit(1);

  // Retry stage 2a (auto-increments to attempt 2)
  const a3 = startStageAttempt('$RUN_A', '2a', '$VERIFY_DB');
  if (a3.attempt !== 2) process.exit(1);
  finishStageAttempt('$RUN_A', '2a', 2, '$VERIFY_DB');

  // Query all attempts for stage 2a
  const attempts = getStageAttempts('$RUN_A', '2a', '$VERIFY_DB');
  if (attempts.length !== 2) process.exit(1);
  if (attempts[0].status !== 'failed') process.exit(1);
  if (attempts[1].status !== 'completed') process.exit(1);
" && ok "stage attempts (start, finish, fail, retry, query)" || fail "stage attempts"

# --- 5. Artifact file creation ---
echo "[5/10] Artifact files..."
node -e "
  const { writeStageArtifacts, writeErrorArtifact } = require('./phase-tracker/artifacts/write-artifact');
  const { renderMd } = require('./phase-tracker/artifacts/render-md');

  // Write output artifacts for stage 2
  writeStageArtifacts({
    runId: '$RUN_A', stage: '2', attempt: 1,
    output: { topics: 25, data: 'test' },
    meta: { stageId: '2' },
    dbPath: '$VERIFY_DB'
  });
  renderMd({
    runId: '$RUN_A', stage: '2', attempt: 1,
    output: { topics: 25, data: 'test' },
    meta: { stageId: '2' },
    dbPath: '$VERIFY_DB'
  });

  // Write error artifact for stage 2a attempt 1
  writeErrorArtifact({
    runId: '$RUN_A', stage: '2a', attempt: 1,
    error: { code: 'VERIFY_FAIL', message: 'test failure' },
    dbPath: '$VERIFY_DB'
  });
"

# Check files exist
ARTS_BASE="reports/phase-runs/$RUN_A/stages"
for f in \
  "$ARTS_BASE/2/attempt-1/output.json" \
  "$ARTS_BASE/2/attempt-1/output.md" \
  "$ARTS_BASE/2/attempt-1/meta.json" \
  "$ARTS_BASE/2a/attempt-1/error.json"; do
  if [ -f "$f" ]; then
    ok "artifact exists: $(basename "$(dirname "$(dirname "$f")")")/$(basename "$(dirname "$f")")/$(basename "$f")"
  else
    fail "missing artifact: $f"
  fi
done

# Validate output.json content
node -e "
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync('$ARTS_BASE/2/attempt-1/output.json', 'utf-8'));
  if (data.topics !== 25) process.exit(1);
" && ok "output.json content valid" || fail "output.json content"

# Validate output.md has stage header
node -e "
  const fs = require('fs');
  const md = fs.readFileSync('$ARTS_BASE/2/attempt-1/output.md', 'utf-8');
  if (!md.includes('# Stage 2')) process.exit(1);
  if (!md.includes('$RUN_A')) process.exit(1);
" && ok "output.md has stage header and runId" || fail "output.md content"

# Validate error.json
node -e "
  const fs = require('fs');
  const err = JSON.parse(fs.readFileSync('$ARTS_BASE/2a/attempt-1/error.json', 'utf-8'));
  if (err.code !== 'VERIFY_FAIL') process.exit(1);
" && ok "error.json content valid" || fail "error.json content"

# --- 6. Events ---
echo "[6/10] Event logging..."
node -e "
  const { appendEvent, getEvents } = require('./phase-tracker/storage/stages-repo');

  appendEvent({ runId: '$RUN_A', stage: '2', attempt: 1, type: 'info', message: 'test info', dbPath: '$VERIFY_DB' });
  appendEvent({ runId: '$RUN_A', stage: '2', attempt: 1, type: 'gate', message: 'gate passed',
    data: { score: 75, threshold: 60 }, dbPath: '$VERIFY_DB' });
  appendEvent({ runId: '$RUN_A', stage: '2a', attempt: 1, type: 'error', message: 'test err', dbPath: '$VERIFY_DB' });

  const all = getEvents('$RUN_A', { dbPath: '$VERIFY_DB' });
  if (all.length !== 3) process.exit(1);

  const gates = getEvents('$RUN_A', { stage: '2', type: 'gate', dbPath: '$VERIFY_DB' });
  if (gates.length !== 1) process.exit(1);
  const gateData = JSON.parse(gates[0].data);
  if (gateData.score !== 75) process.exit(1);
" && ok "event logging and filtering" || fail "event logging"

# --- 7. Run locking ---
echo "[7/10] Run locking..."
node -e "
  const { acquireRunLock, releaseRunLock, isRunLocked } = require('./phase-tracker/storage/locks');

  const lock1 = acquireRunLock('$RUN_A', { holder: 'w1', dbPath: '$VERIFY_DB' });
  if (!lock1.acquired) process.exit(1);

  const lock2 = acquireRunLock('$RUN_A', { holder: 'w2', dbPath: '$VERIFY_DB' });
  if (lock2.acquired) process.exit(1);
  if (lock2.holder !== 'w1') process.exit(1);

  const info = isRunLocked('$RUN_A', '$VERIFY_DB');
  if (!info || info.holder !== 'w1') process.exit(1);

  releaseRunLock('$RUN_A', 'w1', '$VERIFY_DB');
  if (isRunLocked('$RUN_A', '$VERIFY_DB')) process.exit(1);
" && ok "lock acquire, deny, check, release" || fail "run locking"

# --- 8. Parallel run isolation ---
echo "[8/10] Parallel run isolation..."
node -e "
  const { startStageAttempt, finishStageAttempt, getStageAttempts } = require('./phase-tracker/storage/stages-repo');
  const { updateRunStatus } = require('./phase-tracker/storage/runs-repo');

  updateRunStatus('$RUN_B', 'running', null, '$VERIFY_DB');
  const a = startStageAttempt('$RUN_B', '2', '$VERIFY_DB');
  finishStageAttempt('$RUN_B', '2', a.attempt, '$VERIFY_DB');

  // Run A has 3 attempts (2, 2a x2), Run B has 1
  const attA = getStageAttempts('$RUN_A', null, '$VERIFY_DB');
  const attB = getStageAttempts('$RUN_B', null, '$VERIFY_DB');

  if (attA.some(a => a.run_id !== '$RUN_A')) process.exit(1);
  if (attB.some(a => a.run_id !== '$RUN_B')) process.exit(1);
  if (attB.length !== 1) process.exit(1);
" && ok "parallel runs isolated (no cross-contamination)" || fail "parallel isolation"

# --- 9. Stage order validation ---
echo "[9/10] Stage order contracts..."
node -e "
  const { STAGE_ORDER, STAGES, VALID_STAGE_IDS } = require('./phase-tracker/contracts/stages');
  const { stagesThrough, isValidStage, nextStage } = require('./phase-tracker/core/stage-order');

  const expected = ['2','2a','3','3a','4','4a','5','6','6a','7','8','8a','9'];
  if (JSON.stringify(STAGE_ORDER) !== JSON.stringify(expected)) process.exit(1);

  if (!isValidStage('2') || !isValidStage('8a') || isValidStage('1') || isValidStage('10')) process.exit(1);

  if (JSON.stringify(stagesThrough('3a')) !== JSON.stringify(['2','2a','3','3a'])) process.exit(1);

  // Chain walk
  let cur = '2';
  const chain = [cur];
  while (nextStage(cur)) { cur = nextStage(cur); chain.push(cur); }
  if (JSON.stringify(chain) !== JSON.stringify(expected)) process.exit(1);
" && ok "stage order, validation, stagesThrough, nextStage" || fail "stage order"

# --- 10. Artifact DB records ---
echo "[10/10] Artifact DB records..."
node -e "
  const { openDb, closeDb } = require('./phase-tracker/storage/db');
  const db = openDb('$VERIFY_DB');
  const arts = db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY stage, attempt, filename')
    .all('$RUN_A');

  // Should have output.json, output.md, meta.json for stage 2, error.json for stage 2a
  if (arts.length < 4) { console.error('Expected >= 4 artifacts, got', arts.length); process.exit(1); }

  const filenames = arts.map(a => a.stage + ':' + a.filename);
  if (!filenames.includes('2:output.json')) process.exit(1);
  if (!filenames.includes('2:output.md')) process.exit(1);
  if (!filenames.includes('2:meta.json')) process.exit(1);
  if (!filenames.includes('2a:error.json')) process.exit(1);

  // All have size > 0
  if (arts.some(a => a.size_bytes <= 0)) process.exit(1);

  closeDb('$VERIFY_DB');
" && ok "artifact DB records match disk files" || fail "artifact DB records"

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ $FAIL -gt 0 ]; then
  exit 1
else
  echo "=== ALL CHECKS PASSED ==="
fi
