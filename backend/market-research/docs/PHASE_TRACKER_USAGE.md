# Phase Tracker Usage

## Overview

The phase tracker runs the market research pipeline in discrete stages, persisting all artifacts and state to SQLite + filesystem. Supports resume, parallel runs by runId, and strict template validation.

## Stages

| Stage | Name | Description |
|-------|------|-------------|
| 2 | Country Research | AI-powered web research via Gemini |
| 2a | Research Review | Gemini Pro review of research quality |
| 3 | Synthesize | Combine research into structured synthesis |
| 3a | Synthesis Review | Quality gate + Gemini Pro improvement |
| 4 | Content Readiness | Score content completeness/coherence |
| 4a | Content Improve | Gemini Pro improvement if stage 4 fails |
| 5 | Pre-Build Check | Sanitize data + validate PPT-readiness |
| 6 | Content Size Check | Detect oversized content (dry run) |
| 6a | Readability Rewrite | Rewrite high-risk content for slides |
| 7 | Build PPT | Generate PPTX via pptxgenjs |
| 8 | File Safety | Normalize relationships + validate PPTX |
| 8a | Final Review | Pass-through (stage 8 normalizes) |
| 9 | Delivery | Final summary + output PPTX |

## Commands

### Start a new run

```bash
npm run phase:run -- --run-id vn-es-001 --country Vietnam --industry "Energy Services" --through 2
```

`--country` and `--industry` are required for new runs. `--through` sets the last stage to execute (inclusive).

### Resume a run

```bash
npm run phase:run -- --run-id vn-es-001 --through 2a
```

Automatically resumes from the next pending stage. No `--country`/`--industry` needed for existing runs.

### Run to completion

```bash
npm run phase:run -- --run-id vn-es-001 --through 9
```

### Check run status

```bash
npm run phase:status -- --run-id vn-es-001
npm run phase:status -- --run-id vn-es-001 --json
```

Shows completed/failed/pending stages, gate results, durations.

### List all runs

```bash
npm run phase:list
npm run phase:list -- --status running
npm run phase:list -- --limit 50 --json
```

### Inspect artifact paths

```bash
npm run phase:paths -- --run-id vn-es-001
npm run phase:paths -- --run-id vn-es-001 --stage 2a
npm run phase:paths -- --run-id vn-es-001 --json
```

### Run tests

```bash
npm run phase:test
node --test tests/phase-tracker/runner.test.js
```

## Options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--run-id` | Yes | — | Unique run identifier |
| `--through` | Yes | — | Last stage to execute (inclusive) |
| `--country` | New runs | — | Target country |
| `--industry` | New runs | — | Target industry |
| `--client-context` | No | null | Freeform context string |
| `--strict-template` | No | true | Hard-fail on template violations |
| `--attempts-per-stage` | No | 1 | Fail-fast by default |
| `--db-path` | No | reports/phase-runs/phase-tracker.sqlite | Custom DB path |

## Artifacts

Each stage writes artifacts to:

```
reports/phase-runs/<runId>/stages/<stage>/attempt-<n>/
  output.json     # Stage output data
  summary.md      # Human-readable markdown
  error.json      # Error details (if failed)
  deck.pptx       # Binary PPT (stages 7, 8, 8a)
  final.pptx      # Final output (stage 9)
```

## Strict Template Gate

Enabled by default (`--strict-template=true`). After stage 7 (PPT build), validates:

- Slide element positions (title, titleBar, contentArea, sourceBar) within 0.15" tolerance
- Theme colors (dk1, dk2, accent1, accent3, accent6, lt1)
- Fonts (heading, body)
- Table border colors

On failure:
- Hard-fails the run (no silent degradation)
- Prints blocking slide keys to terminal
- Writes error artifact with full violation details

Disable with `--strict-template=false`.

## Fail-Fast Behavior

Default: 1 attempt per stage. If a stage fails, the run stops immediately. Resume later with the same `--run-id`.

## Parallel Runs

Different `--run-id` values can run simultaneously. Same `--run-id` is protected by an exclusive lock with 5-minute TTL and 30-second heartbeat.

## Database

SQLite via `node:sqlite` (Node.js built-in, no native addons). WAL mode for concurrent reads. Tables: `runs`, `stage_attempts`, `artifacts`, `events`, `run_locks`.
