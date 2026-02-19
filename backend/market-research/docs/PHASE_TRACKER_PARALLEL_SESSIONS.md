# Phase Tracker: Parallel Sessions

Run multiple market-research jobs simultaneously. Each gets its own `runId`, its own artifact tree, and its own lock.

## How It Works

- Every run gets a unique `runId` (format: `run-{timestamp}-{random}`)
- All runs share one SQLite database (`reports/phase-runs/phase-tracker.sqlite`)
- SQLite WAL mode allows concurrent reads + writes
- Each run's artifacts go to `reports/phase-runs/<runId>/` (no overlap)
- Run locks prevent two workers from executing the same runId at once

## Running in Parallel

### Start two runs simultaneously

```bash
# Terminal 1: energy research in Norway
node scripts/phase-run.js \
  --country="Norway" \
  --industry="energy services" \
  --through=5 &

# Terminal 2: healthcare in Japan
node scripts/phase-run.js \
  --country="Japan" \
  --industry="healthcare" \
  --through=5 &

# Wait for both
wait
```

### Custom run IDs for traceability

```bash
# Assign meaningful IDs
node scripts/phase-run.js \
  --run-id="run-energy-norway-20260219" \
  --country="Norway" \
  --industry="energy services" \
  --through=3

node scripts/phase-run.js \
  --run-id="run-healthcare-japan-20260219" \
  --country="Japan" \
  --industry="healthcare" \
  --through=3
```

### List all runs

```bash
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  const { listRuns } = require('./phase-tracker/storage/runs-repo');
  migrate();
  const runs = listRuns();
  runs.forEach(r => console.log(r.id, r.status, r.industry, r.country));
"
```

### List runs by status

```bash
# Only running jobs
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  const { listRuns } = require('./phase-tracker/storage/runs-repo');
  migrate();
  listRuns({ status: 'running' }).forEach(r =>
    console.log(r.id, r.industry, r.country)
  );
"
```

## Run Locking

Locks prevent two workers from processing the same `runId` concurrently.

### How locks work

1. Worker acquires lock before starting: `acquireRunLock(runId, { holder: 'worker-1' })`
2. Returns `{ acquired: true }` or `{ acquired: false, holder: 'other-worker' }`
3. Lock has TTL (default 5 min). If the worker dies, the lock auto-expires.
4. Worker heartbeats to extend TTL: `heartbeatRunLock(runId, holder)`
5. Worker releases on completion: `releaseRunLock(runId, holder)`

### Check if a run is locked

```bash
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  const { isRunLocked } = require('./phase-tracker/storage/locks');
  migrate();
  const lock = isRunLocked('<runId>');
  console.log(lock ? 'Locked by: ' + lock.holder : 'Not locked');
"
```

### Force-release expired locks

```bash
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  const { cleanExpiredLocks } = require('./phase-tracker/storage/locks');
  migrate();
  const cleaned = cleanExpiredLocks();
  console.log('Cleaned', cleaned, 'expired locks');
"
```

## Artifact Isolation

Each run has its own directory tree. No cross-contamination.

```
reports/phase-runs/
  phase-tracker.sqlite
  run-energy-norway-20260219/
    stages/
      2/attempt-1/output.json
      2a/attempt-1/output.json
      3/attempt-1/output.json
  run-healthcare-japan-20260219/
    stages/
      2/attempt-1/output.json
      2a/attempt-1/output.json
      3/attempt-1/output.json
```

### Compare outputs between runs

```bash
# Diff stage 3 synthesis between two runs
diff \
  reports/phase-runs/run-energy-norway-20260219/stages/3/attempt-1/output.json \
  reports/phase-runs/run-healthcare-japan-20260219/stages/3/attempt-1/output.json
```

## SQLite Concurrency

- **WAL mode** enabled: multiple readers + one writer at a time
- **Busy timeout**: 5 seconds (waits for locks, doesn't fail immediately)
- **Foreign keys**: enforced (can't create stage_attempt for nonexistent run)
- **Connection pooling**: reuses connections per database path

### If you hit "database is locked"

This means a write took longer than 5 seconds. Possible causes:
- Very large artifact write while another write is in progress
- Disk I/O bottleneck

Fix: the operations are idempotent. Just retry.
