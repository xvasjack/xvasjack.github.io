# PPT Stabilization Plan (Format + Content)

Date: 2026-02-11
Owner: backend/market-research
Status: Active

## 1) Objective

Lock the system so every generated deck is:
1. Structurally valid (opens without PowerPoint repair).
2. Template-consistent (layout, fonts, spacing, and mapping match the template).
3. Content-credible (no made-up citations/laws, clear storyline, insight depth >= threshold).
4. Operationally stable (no runaway retry loops, no silent quality bypasses, bounded runtime/cost).

## 2) Hard Requirements

- Template visual match:
  - Template-first building for all supported blocks.
  - No dynamic block drift in production mode.
  - Layout, font size, color, line thickness, and spacing anchored to template references.
- Content quality:
  - Effective score >= 80.
  - Story flow >= 80.
  - Critical issues = 0.
  - Major/open-gap tolerance follows current check config.
- Verification loop per fix batch:
  - Run 1 full check + 2 additional confirmation runs.
  - Max 5 fix/check rounds per run.
- Root-cause discipline:
  - Every bug fix must include: cause, proof, fix, and prevention note in `MISTAKES.md`.

## 3) Root-Cause Map (from logs + code)

### RC-1: Combined-results structure instability
- Symptoms:
  - `_wasArray`, `section_*`, `*deepen*`, `final_review_gap_*` leaking into final sections.
  - Extra/unknown keys causing wrong block selection and formatting mismatch.
- Cause:
  - Too-permissive section acceptance and dynamic key spread.
- Fix status:
  - Partially fixed: market canonicalization + transient-key filtering added.
- Remaining work:
  - Apply the same standard contract logic to policy/competitor/depth summary pathways.

### RC-2: Array-origin payload acceptance
- Symptoms:
  - Logs show array payloads accepted after normalization.
- Cause:
  - Acceptance checks executed before rejecting `_wasArray` marker.
- Fix status:
  - Fixed for policy and market acceptance order.
- Remaining work:
  - Extend acceptance guard to all synthesis sections uniformly.

### RC-3: Text cutting and JSON repair waste
- Symptoms:
  - Frequent Tier-1 parse failures, Tier-2 repairs, Tier-3 fallbacks.
  - Text cut short and occasional malformed outputs.
- Cause:
  - LLM JSON-mode instability under long prompts + oversized section payloads.
- Fix status:
  - Existing retry tiers still too tolerant.
- Remaining work:
  - Add per-section token budget caps, response length limits, and stricter reject-on-repair ratio.

### RC-4: Delivery check not strict enough (historical)
- Symptoms:
  - Decks reached users despite corruption/cut text.
- Cause:
  - Missing hard structural check at final buffer.
- Fix status:
  - Added post-generation structural check and XML file-safety scan.
- Remaining work:
  - Add stricter slide-content sufficiency checks per template block type.

### RC-5: Building mode drift (dynamic fallback)
- Symptoms:
  - Layout mismatch and non-template fallback slides.
- Cause:
  - Dynamic discovery and fallback slide generation enabled in production path.
- Fix status:
  - Template-first hardening added in `deck-builder-single.js`.
- Remaining work:
  - Enforce production mode flags at server level and log when fallback path is ever entered.

### RC-6: Text overflow and visual breakage
- Symptoms:
  - Long subtitles/tables overflow, crowded slides, cut-text artifacts.
- Cause:
  - No strict text budget per placeholder/shape tied to template layout.
- Fix status:
  - Overflow risks detected but not blocked or rewritten.
- Remaining work:
  - Implement deterministic text budget + compaction policy before build.

### RC-7: Quality check bypass ambiguity
- Symptoms:
  - "Ready" contents inconsistent with draft-mode bypass and gate logs.
- Cause:
  - Mixed operational modes and unclear readiness messaging.
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
  - enforce phase time budgets, resumable checkpoints, and safe-to-restart handling.

### RC-9: XML safety gap in shared text cleaning
- Symptoms:
  - decks occasionally open with repair prompts despite passing high-level synthesis checks.
- Cause:
  - shared `safeText()` returned raw strings, skipping XML-safe cleaning for control chars/unpaired surrogates.
- Fix status:
  - Fixed: `safeText()` now routes all text through XML-safe normalization.
- Remaining work:
  - keep this as a check to prevent old bugs from returning.

### RC-10: Content-type checker false positives
- Symptoms:
  - package runInfo reported “missing expected overrides” for parts that were already valid via `<Default Extension=...>`.
- Cause:
  - package checker only evaluated `<Override>` entries and ignored valid extension defaults.
- Fix status:
  - Fixed: checker now parses defaults and treats extension-level matches as satisfied.
- Remaining work:
  - keep reconcile + re-scan in final pipeline and only flag true mismatches.

### RC-11: Opaque package runInfo
- Symptoms:
  - logs showed `[object Object]` in missing override messages.
- Cause:
  - object arrays were directly joined in runInfo strings.
- Fix status:
  - Fixed: builder runInfo now print `part->expectedContentType`.
- Remaining work:
  - none (monitor for regressions in new runInfo paths).

## 4) Execution Plan (Exhaustive)

## Phase A: Data Contract Lockdown (Structure + Acceptance)

1. Add standard section contracts for all sections:
   - policy: foundationalActs, nationalPolicy, investmentRestrictions, regulatorySummary, keyIncentives, sources
   - market: marketSizeAndGrowth, supplyAndDemandDynamics, pricingAndTariffStructures
   - competitors: japanesePlayers, localMajor, foreignPlayers, caseStudy, maActivity
   - depth: dealEconomics, partnerAssessment, entryStrategy, implementation, targetSegments
   - summary: goNoGo, opportunitiesObstacles, keyInsights
2. Reject unknown/transient keys at section boundary.
3. Reject array-origin payloads globally before scoring/acceptance.
4. Add section contract checkers with explicit reason codes.

Exit criteria:
- No temporary keys in final combined payload.
- 100% section payloads pass contract checker.

## Phase B: Deterministic Building

1. Keep template-first mode as default production path.
2. Disable non-template fallback slide generation in production mode.
3. Make template mapping complete and strict:
   - if block cannot map to template, fail run (strict mode) with clear error info.
4. Set table/chart/text layout from template references only.
5. Add font/shape consistency checks:
   - font family, min/max font size, color palette, line thickness.

Exit criteria:
- Template mapping coverage == 100% for supported deck types.
- 0 non-template slides in strict mode.

## Phase C: Text Budget + Shortening

1. Define per-block text budgets (title/subtitle/body/table cell).
2. Add predictable shortening steps before build:
   - sentence ranking by evidence density.
   - hard max characters per shape.
   - preserve numbers/citations first.
3. Add table column adaptivity:
   - if template has 5 cols and data has 3, build 3 meaningful columns.
4. Add multi-pass fit check:
   - if overflow predicted, shorten again; if still overflow in strict mode, fail with error info.

Exit criteria:
- 0 severe overflow violations in strict mode.
- Readability thresholds met (line count and min font size constraints).

## Phase D: Structural + Visual Check

1. Keep hard PPT structural check:
   - ZIP/XML file safety
   - min slides/charts/tables
   - non-empty content checks
2. Add visual comparison checks (template difference checker):
   - slide size/resolution
   - block bounding box deltas
   - text style deltas
3. Add slide-level quality report artifact per run (JSON + markdown summary).

Exit criteria:
- No repair prompt in Office open tests.
- Layout/style differences within threshold for all mapped blocks.

## Phase E: Content Accuracy + Story Quality

1. Citation accuracy checker:
   - reject suspicious decree/law IDs that are not source-backed.
   - require source URL/domain trace for legal claims.
2. Numeric consistency checker:
   - detect contradictory market numbers across sections.
3. Story flow checker:
   - enforce story continuity (problem -> trigger -> opportunity -> economics -> execution -> decision).
   - enforce minimum insight count and quality.
4. Depth checker:
   - no placeholder text, no "insufficient data" in final strict mode.

Exit criteria:
- Content quality check >= target with no critical citation/consistency failures.

## Phase F: Runtime Reliability

1. Add phase-level time budgets and cancellation reasons.
2. Add checkpoint/resume for long runs.
3. Add retry budget caps by model and by section.
4. Add predictable fail-fast path:
   - if section cannot stabilize after retries, fail early in strict mode.

Exit criteria:
- No silent timeout aborts.
- Predictable fail-fast error info.

## 5) Verification Protocol (Per Fix Batch)

For each code fix batch:
1. Static checks:
   - syntax checks
   - module import checks
2. Local structural tests:
   - generate/validate sample deck(s)
   - ensure no XML fileSafety failures
3. Full pipeline run (strict mode):
   - Pass A (primary)
   - Pass B (confirmation 1)
   - Pass C (confirmation 2)
4. Compare Pass A/B/C:
   - data structure stability
   - template mapping coverage
   - overflow/cut-text counts
   - story-flow/effective score
5. If any regression exists, do next fix round.
6. Stop after max 5 rounds and ship detailed failure report.

## 6) Definition of Done

A run is "done" only when all are true:
- Opens without repair.
- No severe formatting drift from template baseline.
- No cut/placeholder critical sections.
- Story flow >= 80 and effective >= 80.
- No critical content accuracy issues.
- Verification protocol completed with 3 consecutive successful passes.

## 7) Immediate Next Tasks

1. Keep strict build cleanup for all sections and block any temporary keys at build boundary.
2. Add strict per-shape text budget + shortening step in `deck-builder-single.js`.
3. Add strict-mode switch in API request/options with default for production.
4. Add slide-style comparison checker (font/size/color/bounds) against template map.
5. Add final run report artifact (pass/fail reasons by slide/block).
6. Add an end-of-run “XML-safe text” non-regression assertion over all slide text nodes.
7. Add end-of-run package check requiring zero dangling overrides and zero content-type mismatches.

## 8) Tracking

- Every new failure mode must be appended to `MISTAKES.md` with prevention rule.
- Every deployment must include:
  - commit hash
  - strict-mode run report
  - checker summary
  - known residual risks
