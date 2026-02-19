# Phase Tracker Contract

## Overview

The phase tracker provides a staged, inspectable pipeline for market research runs.
Each run proceeds through ordered stages, producing file-based artifacts (.json, .md)
that can be inspected between stages.

**Execution mode:** run-through-target-stage-and-stop.

## Stage Model

| Stage | Label                | Kind    | Description                                       |
|-------|----------------------|---------|---------------------------------------------------|
| 2     | Country Research     | primary | Collect policy/market/competitor/depth data        |
| 2a    | Research Review      | review  | Fix weak/missing research via Gemini Pro           |
| 3     | Synthesis            | primary | Synthesize raw research into structured analysis   |
| 3a    | Synthesis Review     | review  | Score and improve synthesis quality                |
| 4     | Content Quality Check| primary | Hard check for depth, insight, evidence            |
| 4a    | Content Improve      | review  | Rewrite synthesis to pass quality thresholds       |
| 5     | Pre-build Check      | primary | Clean transient keys, validate PPT data structure  |
| 6     | Content-Size Scan    | primary | Identify overly dense content                      |
| 6a    | Readability Rewrite  | review  | Rewrite dense sections for slide readability       |
| 7     | Build PPT            | primary | Generate PowerPoint deck                           |
| 8     | PPT Health Check     | primary | Validate PPTX structure and file safety            |
| 8a    | Final Review         | review  | AI review of generated deck                        |
| 9     | Delivery             | primary | Email deck and persist run metadata                |

### Stage Kinds

- **primary** — Produces data or artifacts. Always runs.
- **review** — Quality gate / improvement loop. Validates/improves previous stage output.

### Execution Order

Stages execute in fixed order: `2 → 2a → 3 → 3a → 4 → 4a → 5 → 6 → 6a → 7 → 8 → 8a → 9`

The `--through` flag stops execution after the specified stage (inclusive).

## Run Record

```json
{
  "id":            "run-m1abc-1f2e3d4a",
  "industry":      "Energy Services",
  "country":       "Vietnam",
  "clientContext":  "Client is expanding APAC operations",
  "targetStage":   "3",
  "status":        "running",
  "createdAt":     "2026-02-19T12:00:00.000Z",
  "updatedAt":     "2026-02-19T12:05:00.000Z",
  "finishedAt":    null,
  "error":         null
}
```

### Run Statuses

| Status    | Terminal | Description                        |
|-----------|----------|------------------------------------|
| pending   | no       | Created, not started               |
| running   | no       | Currently executing stages         |
| completed | yes      | All target stages finished         |
| failed    | yes      | A stage failed (fail-fast)         |
| cancelled | yes      | Manually cancelled                 |

## Stage Attempt Record

```json
{
  "id":         42,
  "runId":      "run-m1abc-1f2e3d4a",
  "stage":      "2",
  "attempt":    1,
  "status":     "completed",
  "startedAt":  "2026-02-19T12:00:00.000Z",
  "finishedAt": "2026-02-19T12:02:30.000Z",
  "durationMs": 150000,
  "error":      null
}
```

### Attempt Statuses

| Status    | Description                       |
|-----------|-----------------------------------|
| running   | Currently executing               |
| completed | Finished successfully             |
| failed    | Finished with error               |
| skipped   | Skipped (not needed this run)     |

## Artifact Manifest

Each stage attempt produces artifacts in a deterministic directory:

```
reports/phase-runs/<runId>/stages/<stage>/attempt-<n>/
  ├── output.json       # Stage output data
  ├── output.md         # Human-readable summary
  ├── meta.json         # Timing, config, metadata
  ├── error.json        # Error details (if failed)
  └── events.ndjson     # Structured event log
```

### Manifest Entry

```json
{
  "filename":    "output.json",
  "path":        "reports/phase-runs/run-abc/stages/2/attempt-1/output.json",
  "sizeBytes":   42567,
  "contentType": "application/json",
  "createdAt":   "2026-02-19T12:02:30.000Z"
}
```

## CLI Interface

### phase-run

```bash
node scripts/phase-run.js \
  --country=Vietnam \
  --industry="Energy Services" \
  --through=3 \
  --run-id=run-custom-123 \
  --client-context="APAC expansion" \
  --strict-template=true \
  --attempts-per-stage=1
```

| Argument              | Required | Default | Description                          |
|-----------------------|----------|---------|--------------------------------------|
| --country             | yes      |         | Target country                       |
| --industry            | yes      |         | Target industry                      |
| --through             | yes      |         | Run through this stage (inclusive)    |
| --run-id              | no       | auto    | Custom run identifier                |
| --client-context      | no       | null    | Freeform context string              |
| --strict-template     | no       | true    | Enforce strict template fidelity     |
| --attempts-per-stage  | no       | 1       | Max attempts per stage (fail-fast)   |

### phase-status

```bash
node scripts/phase-status.js --run-id=run-abc123 [--json]
```

### phase-list

```bash
node scripts/phase-list.js [--status=completed] [--limit=20] [--json]
```

### phase-paths

```bash
node scripts/phase-paths.js --run-id=run-abc123 [--stage=2] [--attempt=1] [--json]
```

## Parallel Runs

Multiple runs can execute in parallel, identified by unique `runId` values.
Each run has its own:
- SQLite row in `runs` table
- Artifact directory under `reports/phase-runs/<runId>/`
- Run lock (prevents duplicate execution of the same runId)

## Fail-Fast Behavior

Default: `--attempts-per-stage=1` (no hidden retries).

If a stage fails on its first attempt, the entire run transitions to `failed` status.
The error artifact at `stages/<stage>/attempt-1/error.json` contains the failure details.

Higher values allow retry loops (e.g., `--attempts-per-stage=3` gives 3 tries before failing).

## Quality Gates

Existing quality gates are preserved:
- Research quality (`content-gates.js:validateResearchQuality`)
- Synthesis quality (`content-gates.js:validateSynthesisQuality`)
- PPT data validation (`content-gates.js:validatePptData`)
- Content readiness (`content-quality-check.js:checkContentReadiness`)
- File safety (`deck-file-check.js:validatePPTX`)

## Template Checks

Template fidelity is enforced when `--strict-template=true` (default):
- Template pattern resolution via `template-patterns.json`
- Geometry guards for tables/charts
- Style matching against template contracts
