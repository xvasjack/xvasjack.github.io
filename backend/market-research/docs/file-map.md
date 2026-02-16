# File Map (What each file is for)

## Core runtime

- `server.js`
Main API entrypoint. Runs all stages and handles delivery.

- `research-engine.js`
Research + result-combining engine.

- `research-framework.js`
Reads request details and research framework shape.

- `ai-clients.js`  
All Gemini/API call wrappers and cost tracking.

## Content quality

- `content-gates.js`
Rule-based content readiness checks.

- `content-quality-check.js`  
Higher-level content scoring.

- `story-flow-check.js`
Story flow checks used by content scoring.

- `content-size-check.js`  
Legacy name: content size check logic.

## Slide building

- `deck-builder-single.js`  
Core slide builder for one country.

- `deck-builder.js`  
Single-country deck entrypoint (calls `deck-builder-single.js`).

- `ppt-utils.js`  
Low-level helpers for shapes/charts/tables/layout.

- `template-fill.js`
Template clone + text replacement post-processing.

## File safety and check

- `deck-file-check.js`
PPT package safety / file safety checks.

- `validate-output.js`
Basic check script for generated output.

- `validate-real-output.js`
Stricter "real output" check.

## Operations and release

- `scripts/preflight-release.js`  
Pre-release checks.

- `scripts/smoke-release-readiness.js`  
One-command readiness gate.

- `regression-tests.js`
Round-based tests and artifact check (catches old bugs coming back).

## New readability layer

- `README.md`  
Top-level plain-English intro.

- `system-map.js`  
Machine-readable and API-readable flow map.

- `docs/logic-flow.md`
Step-by-step flow map.

- `docs/plain-english-map.md`
Jargon-to-plain-English translation table.
