# Phase Tracker: Troubleshooting

## Common Issues

### Run stuck in "running" status

**Symptoms:** `getRun()` shows `status: 'running'` but no work is happening.

**Cause:** Worker crashed mid-run without updating status.

**Fix:**
```bash
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  const { updateRunStatus } = require('./phase-tracker/storage/runs-repo');
  const { releaseRunLock } = require('./phase-tracker/storage/locks');
  migrate();
  updateRunStatus('<runId>', 'failed', JSON.stringify({ reason: 'worker crash' }));
  // If locked, force-release (use the holder from isRunLocked output)
  releaseRunLock('<runId>', '<holder>');
"
```

Then resume:
```bash
node scripts/phase-run.js --run-id=<runId> --through=<target>
```

---

### Stage failed — where is the error?

**Check the error artifact:**
```bash
cat reports/phase-runs/<runId>/stages/<stage>/attempt-<n>/error.json
```

**Check the events log:**
```bash
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  const { getEvents } = require('./phase-tracker/storage/stages-repo');
  migrate();
  const events = getEvents('<runId>', { stage: '<stage>', type: 'error' });
  events.forEach(e => console.log(e.message, e.data));
"
```

**Check the stage attempt record:**
```bash
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  const { getLatestAttempt } = require('./phase-tracker/storage/stages-repo');
  migrate();
  const a = getLatestAttempt('<runId>', '<stage>');
  console.log(JSON.stringify(a, null, 2));
"
```

---

### Template check failed with blocking slide keys

**Symptoms:** Stage 8 fails with `TEMPLATE_STRICT_FAILURE` and `blockingSlideKeys`.

**Inspect:**
```bash
# Read the error artifact
cat reports/phase-runs/<runId>/stages/8/attempt-1/error.json | node -e "
  const data = require('fs').readFileSync('/dev/stdin','utf8');
  const err = JSON.parse(data);
  console.log('Blocking slide keys:');
  err.blockingSlideKeys.forEach(k => console.log(' ', k));
  console.log('Issues:');
  err.issues.forEach(i => console.log(' ', i.code, i.severity, i.slide));
"
```

**Common causes:**
- `line_width_signature_mismatch` — Line widths in generated PPTX don't match template contract
- `font_family_mismatch` — Wrong font family (usually Century Gothic vs Segoe UI)
- `color_drift` — Theme colors shifted from template baseline

**Fix:** These are PPT rendering bugs. Fix the relevant slide builder code, then resume:
```bash
node scripts/phase-run.js --run-id=<runId> --through=8
```
This creates attempt 2 for stage 8.

---

### "database is locked" error

**Cause:** Two writes happening simultaneously, exceeding 5-second busy timeout.

**Fix:** Retry. The operations are idempotent. If persistent, check for stuck processes:
```bash
# Find processes holding the database
fuser reports/phase-runs/phase-tracker.sqlite 2>/dev/null
```

---

### Run ID not found

**Cause:** Typo in run ID, or database file was deleted/moved.

**Check:**
```bash
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  const { listRuns } = require('./phase-tracker/storage/runs-repo');
  migrate();
  listRuns({ limit: 10 }).forEach(r => console.log(r.id, r.status));
"
```

---

### Missing artifact files

**Cause:** Run was interrupted before writing artifacts, or disk was cleaned.

**Check DB record vs disk:**
```bash
# DB says artifact exists?
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  const { openDb } = require('./phase-tracker/storage/db');
  migrate();
  const db = openDb();
  const arts = db.prepare('SELECT * FROM artifacts WHERE run_id = ?').all('<runId>');
  arts.forEach(a => console.log(a.stage, a.attempt, a.filename, a.path));
"

# Files actually on disk?
ls -la reports/phase-runs/<runId>/stages/
```

---

### How to completely reset

**Delete everything and start fresh:**
```bash
rm -rf reports/phase-runs/
```

The database and all artifact directories will be recreated on next run.

---

### How to check which stages are done for a run

```bash
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  const { getStageAttempts } = require('./phase-tracker/storage/stages-repo');
  migrate();
  const attempts = getStageAttempts('<runId>');
  const byStage = {};
  attempts.forEach(a => {
    if (!byStage[a.stage]) byStage[a.stage] = [];
    byStage[a.stage].push({ attempt: a.attempt, status: a.status, ms: a.duration_ms });
  });
  for (const [stage, list] of Object.entries(byStage)) {
    const latest = list[list.length - 1];
    console.log(stage.padEnd(4), latest.status.padEnd(10), (latest.ms || 0) + 'ms',
      list.length > 1 ? '(' + list.length + ' attempts)' : '');
  }
"
```

---

### How to find the output file for a specific stage

```bash
# Pattern: reports/phase-runs/<runId>/stages/<stage>/attempt-<n>/<filename>

# Examples:
cat reports/phase-runs/<runId>/stages/2/attempt-1/output.json    # Research raw data
cat reports/phase-runs/<runId>/stages/3/attempt-1/output.json    # Synthesis
cat reports/phase-runs/<runId>/stages/3/attempt-1/output.md      # Synthesis (readable)
cat reports/phase-runs/<runId>/stages/7/attempt-1/output.json    # PPT build metadata
cat reports/phase-runs/<runId>/stages/8/attempt-1/output.json    # Health check results
cat reports/phase-runs/<runId>/stages/8/attempt-1/error.json     # If health check failed
```

---

### Event types

| Type | Meaning |
|------|---------|
| `info` | Normal progress message |
| `warn` | Non-blocking issue detected |
| `error` | Error occurred (may or may not stop the stage) |
| `metric` | Performance measurement |
| `gate` | Quality gate result (pass/fail with score) |
