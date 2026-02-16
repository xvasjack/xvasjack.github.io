# Claude Agent Prompts (Pre-Run Hardening)

Last updated: 2026-02-16

Use these 8 prompts in parallel (one prompt per Claude agent).

Rules for every agent:
- Keep changes simple.
- Do not add complex new architecture.
- Prioritize content depth, insight quality, and story flow.
- Formatting drift is acceptable if content quality improves.
- Do not silently truncate strong content.
- If unsure, add warnings/logs instead of hard-fail gates.
- Run local checks before claiming done.

---

## Agent 1 Prompt - Content Depth Gaps

```text
You are Agent 1: Content Depth Auditor for backend/market-research.

Goal:
Find where strong content is being weakened before it reaches slides, then fix high-impact issues with minimal code change.

Priority:
1) Content depth and insight quality
2) Story flow
3) Avoid truncation/cutting
4) Readability

Focus files:
- research-engine.js
- content-quality-check.js
- content-gates.js
- server.js (stages 3, 3a, 5, 5a)

Tasks:
1. Map where content is generated, filtered, rewritten, or compacted.
2. Find at least 3 places where quality can drop (loss of context, generic rewrites, over-compression).
3. Implement only top 1-2 fixes with biggest impact and low risk.
4. Add/adjust tests for the exact regressions fixed.

Acceptance:
- No new complex subsystem.
- No reduction in factual detail.
- Existing smoke checks still pass.
- New tests pass.

Deliver:
- Commit with code + tests.
- Short report:
  - issue -> evidence -> fix -> validation
```

## Agent 2 Prompt - Story Flow Quality

```text
You are Agent 2: Story Flow Hardener for backend/market-research.

Goal:
Improve narrative flow quality so output is decision-useful, not a fact dump.

Focus files:
- story-flow-check.js
- content-quality-check.js
- server.js (stages 3a, 5a)

Tasks:
1. Review current story flow checks for weak signals.
2. Add simple but stronger checks for:
   - clear problem -> analysis -> implication -> action chain
   - consistency across sections
   - actionability of final recommendation
3. Keep scoring transparent and easy to read in runInfo.
4. Add tests for weak-flow examples and strong-flow examples.

Acceptance:
- No expensive new model loops.
- No hard-fail on minor wording issues.
- Only fail for truly weak flow.

Deliver:
- Commit with tests.
- 1-page summary of what changed and why.
```

## Agent 3 Prompt - No Silent Truncation

```text
You are Agent 3: No-Truncation Safety Agent for backend/market-research.

Goal:
Ensure high-quality content is not silently cut in final slide build path.

Focus files:
- deck-builder-single.js
- content-size-check.js
- server.js (stage 7, 7a, 8, 9)

Tasks:
1. Identify all active truncation/cut paths in production flow.
2. Keep only true file-safety hard caps (pathological payload protection).
3. Convert non-critical cuts into:
   - warning + rewrite request loop
   - or style/readability warning
4. Add clear logs when any hard cap is used.
5. Add regression tests proving important fields survive.

Acceptance:
- No silent trimming of key business points.
- PPT still builds and opens.
- Test coverage added for fixed paths.

Deliver:
- Commit with code + tests.
- List of removed/softened truncation points.
```

## Agent 4 Prompt - Final Review Loop Quality

```text
You are Agent 4: Final Reviewer Loop Stabilizer for backend/market-research.

Goal:
Make stage 9a final review more reliable and less flip-flop across rounds.

Focus files:
- server.js (reviewDeckBeforeDeliveryWithGeminiFlash, applySlideReviewChangesWithGeminiFlash, stage 9a loop)

Tasks:
1. Audit 9a decision rules and round memory.
2. Improve reviewer consistency:
   - keep accepted decisions sticky
   - avoid repeating same comments with no net change
3. Improve fallback behavior when screenshots are missing (use slide text + summary strongly).
4. Add clear per-round logs: what changed, what improved, what still blocked.

Acceptance:
- Max 5 rounds remains.
- No new paid model stages.
- Better deterministic behavior from existing signals.

Deliver:
- Commit with tests (or deterministic test harness if existing tests are hard to wire).
- Before/after example from one sample runInfo.
```

## Agent 5 Prompt - Plain English Cleanup

```text
You are Agent 5: Plain-English Cleanup Agent for backend/market-research.

Goal:
Replace confusing user-facing wording with simple words.

Focus:
- docs/*.md
- README.md
- runInfo-facing labels/messages in server.js

Do:
1. Replace technical/jargon terms in user-facing text.
2. Keep wording simple and direct.
3. Preserve exact behavior (text changes only unless a bug is found).
4. Update flow docs so non-technical owner can follow.

Do not:
- Rename deep internal function names unless low-risk and necessary.
- Break API contracts.

Deliver:
- Commit with doc/message updates.
- A “before -> after” glossary table.
```

## Agent 6 Prompt - Pre-Run Reliability Audit

```text
You are Agent 6: Pre-Run Reliability Auditor for backend/market-research.

Goal:
Catch likely runtime failures before paid runs.

Focus files:
- server.js
- ai-clients.js
- research-engine.js
- scripts/smoke-release-readiness.js
- scripts/preflight-release.js

Tasks:
1. Audit retry logic and failure paths for model calls and PPT build.
2. Find places where errors are swallowed or ambiguous.
3. Fix top 2 reliability risks with minimal changes.
4. Ensure runInfo clearly records root cause for failure.

Acceptance:
- Retry loops stay simple.
- No major architectural rewrite.
- Local smoke and preflight still pass.

Deliver:
- Commit with fixes + tests/check updates.
- Root-cause matrix (risk -> trigger -> fix).
```

## Agent 7 Prompt - Test Value Density

```text
You are Agent 7: Test Value Density Agent for backend/market-research.

Goal:
Increase confidence on critical quality paths, reduce noise.

Focus:
- Tests covering stages 3a, 5a, 7a, 8, 9, 9a
- Truncation and story quality regressions

Tasks:
1. Identify low-value tests vs high-value missing tests.
2. Add high-value regression tests for:
   - content depth collapse
   - weak story flow passing by mistake
   - key insight truncation before slide output
   - final review loop non-improvement rounds
3. Keep test runtime practical.

Acceptance:
- No giant snapshot churn.
- Tests are behavior-focused and readable.

Deliver:
- Commit with tests.
- Short “added vs removed/ignored” rationale.
```

## Agent 8 Prompt - End-to-End Dry-Run + Evidence Pack

```text
You are Agent 8: End-to-End Dry-Run Verifier for backend/market-research.

Goal:
Run local end-to-end checks and produce a clear quality evidence pack.

Run:
1) npm run smoke:readiness
2) node test-ppt-generation.js
3) node validate-real-output.js test-output.pptx --country=Thailand --industry="Energy Services"
4) node test-vietnam-research.js

Collect:
- pass/fail
- key warnings
- generated file sizes
- content quality indicators from runInfo/logs
- any truncation signals found

Deliver:
- No code changes unless a blocker is discovered.
- One markdown report:
  - what passed
  - what is still weak
  - exact next fixes (ranked by impact)
```

