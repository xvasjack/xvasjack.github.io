# PPT Stabilization Plan (Format + Content)

Date: 2026-02-11
Owner: backend/market-research
Status: Active

## 1) Objective

Lock the pipeline so every generated deck is:
1. Structurally valid (opens without PowerPoint repair).
2. Template-consistent (layout, typography, geometry, and mapping are deterministic).
3. Content-credible (no hallucinated citations/decrees, coherent storyline, insight depth >= threshold).
4. Operationally stable (no runaway retry loops, no silent quality bypasses, bounded runtime/cost).

## 2) Hard Requirements

- Template fidelity:
  - Template-first rendering for all supported blocks.
  - No dynamic block drift in production mode.
  - Geometry, font size, color, stroke, and spacing anchored to template references.
- Content quality:
  - Effective score >= 80.
  - Coherence >= 80.
  - Critical issues = 0.
  - Major/open-gap tolerance follows current gate config.
- Verification loop per fix batch:
  - Run 1 full check pass + 2 additional confirmation passes.
  - Max 5 fix/check rounds per run.
- Root-cause discipline:
  - Every bug fix must include: cause, proof, fix, and prevention note in `MISTAKES.md`.

## 3) Root-Cause Map (from logs + code)

### RC-1: Synthesis schema instability
- Symptoms:
  - `_wasArray`, `section_*`, `*deepen*`, `final_review_gap_*` leaking into final sections.
  - Extra/unknown keys causing wrong block selection and formatting drift.
- Cause:
  - Over-permissive section acceptance and dynamic key propagation.
- Fix status:
  - Partially fixed: market canonicalization + transient-key filtering added.
- Remaining work:
  - Apply the same canonical contract logic to policy/competitor/depth summary pathways.

### RC-2: Array-origin payload acceptance
- Symptoms:
  - Logs show array payloads accepted after normalization.
- Cause:
  - Acceptance checks executed before rejecting `_wasArray` marker.
- Fix status:
  - Fixed for policy and market acceptance order.
- Remaining work:
  - Extend acceptance guard to all synthesis sections uniformly.

### RC-3: Truncation and JSON repair churn
- Symptoms:
  - Frequent Tier-1 parse failures, Tier-2 repairs, Tier-3 fallbacks.
  - Narrative/section truncation and occasional malformed outputs.
- Cause:
  - LLM JSON-mode instability under long prompts + oversized section payloads.
- Fix status:
  - Existing retry tiers still too tolerant.
- Remaining work:
  - Add per-section token budget caps, response length contracts, and stricter reject-on-repair ratio.

### RC-4: Delivery gate not strict enough (historical)
- Symptoms:
  - Decks reached users despite corruption/truncation.
- Cause:
  - Missing hard structural gate at final buffer.
- Fix status:
  - Added post-generation structural gate and XML integrity scan.
- Remaining work:
  - Add stricter slide-content sufficiency checks per template block type.

### RC-5: Rendering mode drift (dynamic fallback)
- Symptoms:
  - Layout inconsistency and non-template fallback slides.
- Cause:
  - Dynamic discovery and fallback slide generation enabled in production path.
- Fix status:
  - Template-first hardening added in `ppt-single-country.js`.
- Remaining work:
  - Enforce production mode flags at server level and emit diagnostics when fallback path is ever entered.

### RC-6: Text overflow and visual breakage
- Symptoms:
  - Long subtitles/tables overflow, crowded slides, truncation artifacts.
- Cause:
  - No strict text budget per placeholder/shape tied to template geometry.
- Fix status:
  - Overflow risks detected but not blocked or rewritten.
- Remaining work:
  - Implement deterministic text budget + compaction policy before render.

### RC-7: Quality gate bypass ambiguity
- Symptoms:
  - "Ready" semantics inconsistent with draft-mode bypass and gate logs.
- Cause:
  - Mixed operational modes and noisy readiness messaging.
- Fix status:
  - Improved readiness rule text in errors.
- Remaining work:
  - Separate run modes clearly (`strict`, `draft`) with explicit response payload and UI badge.

### RC-8: Runtime instability (container restarts/timeouts)
- Symptoms:
  - mid-run container stop/start; 25-min timeout aborts in historical logs.
- Cause:
  - Long chains + retries + heavy model usage under infrastructure limits.
- Fix status:
  - timeout/rules partially adjusted historically.
- Remaining work:
  - enforce phase time budgets, resumable checkpoints, and idempotent restart handling.

## 4) Execution Plan (Exhaustive)

## Phase A: Contract Lockdown (Schema + Acceptance)

1. Add canonical section contracts for all sections:
   - policy: foundationalActs, nationalPolicy, investmentRestrictions, regulatorySummary, keyIncentives, sources
   - market: marketSizeAndGrowth, supplyAndDemandDynamics, pricingAndTariffStructures
   - competitors: japanesePlayers, localMajor, foreignPlayers, caseStudy, maActivity
   - depth: dealEconomics, partnerAssessment, entryStrategy, implementation, targetSegments
   - summary: goNoGo, opportunitiesObstacles, keyInsights
2. Reject unknown/transient keys at section boundary.
3. Reject array-origin payloads globally before scoring/acceptance.
4. Add section contract validators with explicit reason codes.

Exit criteria:
- No transient keys in final synthesis payload.
- 100% section payloads pass contract validator.

## Phase B: Deterministic Rendering

1. Keep template-first mode as default production path.
2. Disable non-template fallback slide generation in production mode.
3. Make template mapping complete and strict:
   - if block cannot map to template, fail run (strict mode) with actionable diagnostics.
4. Normalize table/chart/text geometry from template references only.
5. Add typography/shape consistency assertions:
   - font family, min/max font size, color palette, line thickness.

Exit criteria:
- Template mapping coverage == 100% for supported deck types.
- 0 non-template slides in strict mode.

## Phase C: Text Budget + Compaction

1. Define per-block text budgets (title/subtitle/body/table cell).
2. Add deterministic compaction pipeline before render:
   - sentence ranking by evidence density.
   - hard max characters per shape.
   - preserve numbers/citations first.
3. Add table column adaptivity:
   - if template has 5 cols and data has 3, render 3 meaningful columns.
4. Add multi-pass fit check:
   - if overflow predicted, compact again; if still overflow in strict mode, fail with diagnostics.

Exit criteria:
- 0 severe overflow violations in strict mode.
- Readability thresholds met (line count and min font size constraints).

## Phase D: Structural + Visual Validation

1. Keep hard PPT structural validation gate:
   - ZIP/XML integrity
   - min slides/charts/tables
   - non-empty content checks
2. Add visual regression checks (template delta checker):
   - slide size/resolution
   - block bounding box deltas
   - text style deltas
3. Add slide-level quality report artifact per run (JSON + markdown summary).

Exit criteria:
- No repair prompt in Office open tests.
- Geometry/style deltas within threshold for all mapped blocks.

## Phase E: Content Integrity + Storyline Quality

1. Citation integrity checker:
   - reject suspicious decree/law IDs that are not source-backed.
   - require source URL/domain trace for legal claims.
2. Numeric consistency checker:
   - detect contradictory market numbers across sections.
3. Storyline checker:
   - enforce arc continuity (problem -> trigger -> opportunity -> economics -> execution -> decision).
   - enforce minimum insight count and quality.
4. Depth checker:
   - no placeholder text, no "insufficient data" in final strict mode.

Exit criteria:
- Content gate >= target with no critical citation/consistency failures.

## Phase F: Runtime Reliability

1. Add phase-level time budgets and cancellation reasons.
2. Add checkpoint/resume for long runs.
3. Add retry budget caps by model and by section.
4. Add deterministic degrade path:
   - if section cannot stabilize after retries, fail early in strict mode.

Exit criteria:
- No silent timeout aborts.
- Predictable fail-fast diagnostics.

## 5) Verification Protocol (Per Fix Batch)

For each code fix batch:
1. Static checks:
   - syntax checks
   - module import checks
2. Local structural tests:
   - generate/validate sample deck(s)
   - ensure no XML integrity failures
3. Full pipeline run (strict mode):
   - Pass A (primary)
   - Pass B (confirmation 1)
   - Pass C (confirmation 2)
4. Compare Pass A/B/C:
   - schema stability
   - template mapping coverage
   - overflow/truncation counts
   - coherence/effective score
5. If any regression exists, do next fix round.
6. Stop after max 5 rounds and ship detailed failure report.

## 6) Definition of Done

A run is "done" only when all are true:
- Opens without repair.
- No severe formatting drift from template baseline.
- No truncated/placeholder critical sections.
- Coherence >= 80 and effective >= 80.
- No critical content integrity issues.
- Verification protocol completed with 3 consecutive successful passes.

## 7) Immediate Next Tasks

1. Extend canonical contract filter to policy/competitors/depth/summary outputs.
2. Add strict per-shape text budget + compaction step in `ppt-single-country.js`.
3. Add strict-mode switch in API request/options with default for production.
4. Add slide-style regression checker (font/size/color/bounds) against template map.
5. Add final run report artifact (pass/fail reasons by slide/block).

## 8) Tracking

- Every new failure mode must be appended to `MISTAKES.md` with prevention rule.
- Every deployment must include:
  - commit hash
  - strict-mode run report
  - validator summary
  - known residual risks
