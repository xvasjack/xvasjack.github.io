# Phase Tracker Quickstart

Run market research stage-by-stage with file-based inspection at every stop.

## Concepts

| Term | Meaning |
|------|---------|
| **Run** | One market-research job (1 country, 1 industry). Has a unique `runId`. |
| **Stage** | One step in the pipeline. Ordered: `2 -> 2a -> 3 -> 3a -> 4 -> 4a -> 5 -> 6 -> 6a -> 7 -> 8 -> 8a -> 9` |
| **Target stage** | The stage to stop at. The pipeline runs stages 2..target, then stops. |
| **Attempt** | Each stage execution. Attempt 1 is the first try. If it fails and you resume, attempt 2 is created. |
| **Artifact** | Output file from a stage attempt. Always at: `reports/phase-runs/<runId>/stages/<stage>/attempt-<n>/` |

## Stage Reference

| ID | Name | Kind | Outputs |
|----|------|------|---------|
| 2 | Country Research | primary | research-raw.json, research-raw.md |
| 2a | Research Review | review | research-reviewed.json, review-issues.json |
| 3 | Synthesis | primary | synthesis.json, synthesis.md |
| 3a | Synthesis Review | review | synthesis-reviewed.json, synthesis-scores.json |
| 4 | Content Quality Check | primary | content-check.json |
| 4a | Content Improve | review | synthesis-improved.json, synthesis-improved.md |
| 5 | Pre-build Check | primary | ppt-data.json, prebuild-check.json |
| 6 | Content-Size Scan | primary | size-scan.json |
| 6a | Readability Rewrite | review | ppt-data-readable.json, ppt-data-readable.md |
| 7 | Build PPT | primary | deck.pptx, build-meta.json |
| 8 | PPT Health Check | primary | health-check.json |
| 8a | Final Review | review | final-review.json, final-review.md |
| 9 | Delivery | primary | delivery-receipt.json |

## Quick Start

### 1. Run through a target stage

```bash
# Run stages 2 -> 2a -> 3, stop after stage 3
node scripts/phase-run.js \
  --country="Germany" \
  --industry="fintech" \
  --through=3
```

The script prints a `runId` (e.g. `run-m1abc-1f2e3d4a`). Use it for all subsequent commands.

### 2. Inspect stage output

```bash
# List all artifacts for a run
ls reports/phase-runs/<runId>/stages/

# Read stage 2 output (JSON)
cat reports/phase-runs/<runId>/stages/2/attempt-1/output.json

# Read stage 2 output (human-readable)
cat reports/phase-runs/<runId>/stages/2/attempt-1/output.md

# Read stage metadata
cat reports/phase-runs/<runId>/stages/2/attempt-1/meta.json
```

### 3. Continue from where you stopped

```bash
# Resume the same run from stage 3a through 5
node scripts/phase-run.js \
  --run-id=<runId> \
  --through=5
```

The tracker auto-detects which stages are done and starts from the next one.

### 4. Check run status

```bash
# Quick status check
node -e "
  const { migrate } = require('./phase-tracker/storage/migrate');
  const { getRun } = require('./phase-tracker/storage/runs-repo');
  const { getStageAttempts } = require('./phase-tracker/storage/stages-repo');
  migrate();
  const run = getRun('<runId>');
  console.log('Status:', run.status);
  const attempts = getStageAttempts('<runId>');
  attempts.forEach(a => console.log(a.stage, a.status, a.duration_ms + 'ms'));
"
```

### 5. If a stage fails

```bash
# Check the error artifact
cat reports/phase-runs/<runId>/stages/<stage>/attempt-1/error.json

# Resume from the failed stage (creates attempt 2)
node scripts/phase-run.js \
  --run-id=<runId> \
  --through=<target>
```

## File Layout

```
reports/phase-runs/
  phase-tracker.sqlite          # SQLite database (all run metadata)
  <runId>/
    stages/
      2/
        attempt-1/
          output.json           # Stage output data
          output.md             # Human-readable output
          meta.json             # Stage metadata
          events.ndjson         # Event log (optional)
      2a/
        attempt-1/
          output.json
          output.md
          ...
      3/
        attempt-1/
          error.json            # If stage failed
        attempt-2/              # If resumed after failure
          output.json
          output.md
```

## Smoke Test

```bash
# Verify phase-tracker infrastructure works
bash scripts/phase-smoke.sh
```

## Full Verification

```bash
# Validate status queries, artifact paths, and DB integrity
bash scripts/phase-verify.sh
```
