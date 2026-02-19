# Overengineering Audit: Master Simplification Plan

**Generated**: 2026-02-15
**Synthesized by**: Agent 8 (from 7 agent reports)

---

## 1. Executive Summary

### Codebase Overview

| Metric | Value |
|--------|-------|
| Total lines of code | 66,975 |
| Total files (JS) | 67 |
| Production files | ~18 (imported by server.js) |
| Non-production files in root | ~27 |
| Test files | 27 (19,517 LOC in .test.js) + 6 non-test test files (6,695 LOC) |
| template-patterns.json | 64,705 lines |
| Environment variables | 44 |
| Production API endpoints | 1 |
| Quality gates (server.js) | 7-9 sequential |
| Iterative review loops | 3 nested |
| LLM calls per country | ~48 typical, ~220 worst case |

### Category Breakdown

| Category | Files | LOC | % of Total |
|----------|-------|-----|-----------|
| CORE-CONTENT | 6 | 11,376 | 17.0% |
| FORMATTING | 12 | 15,098 | 22.5% |
| GATE/VALIDATION | 18 | 16,232 | 24.2% |
| INFRASTRUCTURE | 9 | 4,752 | 7.1% |
| TEST | 27 | 19,517 | 29.1% |

### Core Problem Statement

The codebase has **inverted the effort pyramid**: content quality is the stated #1 priority, but only 17% of code generates content while 53% validates/gates it. The pipeline treats quality as a **gating problem** (generate, then reject) instead of a **generation problem** (produce it right the first time). This manifests as: content-destroying truncation gates, retry chains that produce progressively shallower output, regex-based quality checks that reject analytically strong content for stylistic reasons, and triple-nested review loops that churn without converging. The system spends $20-30 and 48+ LLM calls generating deep research, then deterministic code deletes, truncates, or rejects much of it.

### Estimated LOC Removable

| Action | LOC |
|--------|-----|
| Dead code deletion (files) | ~3,500 |
| Non-production files to scripts/ | ~4,200 |
| Test files to delete | ~13,100 |
| Test files to consolidate | ~3,300 saved |
| Gate/validation simplification | ~5,500 |
| Review loop consolidation | ~800 |
| template-patterns.json pruning | ~50,000 |
| **Total removable/movable** | **~30,400 LOC of JS + ~50,000 lines JSON** |

---

## 2. Ranked Top 20 Simplifications

### Rank 1: Remove content size check Content Truncation

| Field | Value |
|-------|-------|
| **Title** | Remove content-size-check.js content truncation |
| **Agents** | 2, 3 |
| **Evidence** | content-size-check.js:295 `compactPayload()` trims fields to 500-800 chars, truncates tables to 16 rows. Runs at server.js:1046 on every request. Same anti-pattern as mistakes.md row 37. |
| **Content Impact** | 5 |
| **Simplicity Gain** | 5 |
| **Risk** | 2 |
| **Effort** | 1 |
| **Priority Score** | **+7** |
| **Recommended Action** | Delete `content-size-check.js` entirely. Remove the `runBudgetGate()` call at server.js:1046-1061. If text overflow is a concern, handle it in the PPT builder via font shrinking, not via data destruction. |
| **Rollback** | `git revert` the deletion commit. |

---

### Rank 2: Downgrade content Quality Engine to Warn-Only

| Field | Value |
|-------|-------|
| **Title** | Downgrade content-quality-check.js readiness gate from hard-fail to warn-only |
| **Agents** | 1, 2, 3 |
| **Evidence** | content-quality-check.js (2275 lines, 28 exports). `contentReadinessCheck` at server.js:885 throws Error when score < 80. Checks "causal reasoning chains", "named companies" (requires Corp/Ltd/Inc suffix), "action verbs" -- stylistic criteria. `scoreDecisionUsefulness` (lines 917-970) scores by counting regex matches. The 30-phrase "consultant filler" detector flags legitimate strategy vocabulary ("go-to-market", "optimize"). All 2275 lines are READ-ONLY checks that never improve content but can kill the entire $20-30 pipeline. |
| **Content Impact** | 5 |
| **Simplicity Gain** | 4 |
| **Risk** | 2 |
| **Effort** | 2 |
| **Priority Score** | **+5** |
| **Recommended Action** | Change `contentReadinessCheck` in server.js from `throw Error` to `console.warn`. Log the rubric scores and improvement suggestions but never block delivery. Keep the scoring functions for diagnostics. Long-term: replace the 2275-line regex engine with better synthesis prompts that produce quality content in the first place. |
| **Rollback** | Re-enable hard-fail by changing warn back to throw. |

---

### Rank 3: Fix Canonical Key Enforcement Ordering (Accept Before Normalize)

| Field | Value |
|-------|-------|
| **Title** | Reorder canonical key enforcement so normalization runs before accept/reject |
| **Agents** | 1, 2 |
| **Evidence** | research-engine.js: `marketAccept` (lines 2973-3012) rejects output based on non-canonical keys BEFORE `validateMarketSynthesis` (line 3078) can normalize them. Valid content under slightly different keys (e.g., `supplydemandDynamics` vs `supplyAndDemandDynamics`) triggers a retry with stripped-down prompt, producing shallower content. ~300 lines of regex heuristics in `canonicalizeMarketSectionKey` (lines 1506-1614) plus duplicated alias maps in deck-builder-single.js (lines 493-706). |
| **Content Impact** | 4 |
| **Simplicity Gain** | 4 |
| **Risk** | 1 |
| **Effort** | 2 |
| **Priority Score** | **+5** |
| **Recommended Action** | Move key normalization/canonicalization to run BEFORE the accept function in `synthesizeWithFallback`. Better yet: use Gemini's structured output mode (JSON schema) to enforce exact key names at generation time, eliminating all alias maps. Remove duplicated alias maps from deck-builder-single.js. |
| **Rollback** | Revert normalization ordering. |

---

### Rank 4: Remove Context-Fit Agent LLM Truncation

| Field | Value |
|-------|-------|
| **Title** | Remove context-fit-agent.js LLM-based content compression |
| **Agents** | 2, 5 |
| **Evidence** | context-fit-agent.js (292 lines). `aiFitTokens` makes an LLM call to compress content to `maxCharsPerSlot = 360` chars (~60 words). Pays for an LLM call to make content shorter/shallower. Agent 7 notes it is not imported by production code. |
| **Content Impact** | 3 |
| **Simplicity Gain** | 4 |
| **Risk** | 1 |
| **Effort** | 1 |
| **Priority Score** | **+5** |
| **Recommended Action** | Delete `context-fit-agent.js`. If template-fill.js imports it, replace with simple text splitting (the `heuristicFitTokens` path that already exists). Never use an LLM call to shorten LLM-generated content. |
| **Rollback** | `git revert`. |

---

### Rank 5: Delete Stress Test Frameworks (Two Overlapping Systems)

| Field | Value |
|-------|-------|
| **Title** | Delete duplicate stress test harnesses |
| **Agents** | 1, 6, 7 |
| **Evidence** | stress-lab.js (1711 LOC) and stress-test-harness.js (1556 LOC) = 3,267 combined lines. Two separate stress frameworks testing the same thing. stress-lab extends stress-test-harness but both maintained independently. 300+ seeds overkill for a service running a few times/day at $20-30/run. Neither is imported by server.js. Plus stress-lab.test.js (626 LOC). |
| **Content Impact** | 3 |
| **Simplicity Gain** | 5 |
| **Risk** | 1 |
| **Effort** | 1 |
| **Priority Score** | **+6** (averaged across agents) |
| **Recommended Action** | Delete `stress-lab.js`, `stress-test-harness.js`, `stress-lab.test.js`. If stress testing is needed later, write a simple 100-line script with 10-20 seeds in `scripts/`. |
| **Rollback** | `git revert`. |

---

### Rank 6: Remove Hardcoded Content Defaults (ensureSummaryCompleteness)

| Field | Value |
|-------|-------|
| **Title** | Remove hardcoded consulting template defaults from ensureSummaryCompleteness |
| **Agents** | 2, 4 |
| **Evidence** | research-engine.js lines 3831-4230. `ensureImplementationRoadmap`, `ensurePartnerAssessment`, `ensureDepthStrategyAndSegments`, `normalizeInsight` replace LLM-generated industry-specific analysis with generic defaults ("Phase 1: Setup (Months 0-6)", "Joint Venture/Acquisition/Greenfield" with boilerplate). `ensurePartnerDescription` (lines 3894-3915) hardcodes "energy services" -- violates NO HARDCODED INDUSTRY LOGIC rule from MEMORY.md. The system generates deep content, replaces it with filler, then penalizes itself for the filler via content quality engine. |
| **Content Impact** | 5 |
| **Simplicity Gain** | 4 |
| **Risk** | 2 |
| **Effort** | 3 |
| **Priority Score** | **+4** |
| **Recommended Action** | Remove all hardcoded defaults from `ensureSummaryCompleteness`. If synthesis produces incomplete depth sections, let them be incomplete -- partial real analysis is better than generic filler. If completeness is critical, add the missing requirements to the synthesis prompt instead of post-hoc patching. Remove the energy-specific `ensurePartnerDescription` immediately. |
| **Rollback** | Restore default-filling functions. |

---

### Rank 7: Delete Non-Production Gate Files

| Field | Value |
|-------|-------|
| **Title** | Delete 6 non-production validation files not imported by server.js |
| **Agents** | 1, 3, 5, 7 |
| **Evidence** | preflight-gates.js (1934), schema-firewall.js (990), route-geometry-enforcer.js (824), source-lineage-enforcer.js (531), golden-baseline-manager.js (1351), pptx-file safety-pipeline.js (469) = 6,099 LOC. None are in the server.js import tree. Schema-firewall duplicates validation in research-engine.js. Route-geometry-enforcer is completely dead (zero production callers). PPTX-file safety-pipeline duplicates logic already inline in server.js:1078-1139. |
| **Content Impact** | 2 |
| **Simplicity Gain** | 5 |
| **Risk** | 1 |
| **Effort** | 2 |
| **Priority Score** | **+4** |
| **Recommended Action** | Delete all 6 files. Delete their test files (preflight-gates.test.js, preflight-hardening.test.js, schema-firewall.test.js, route-geometry-enforcer.test.js, strict-geometry-enforcement.test.js, template-contract-unification.test.js, source-lineage.test.js, golden-baseline-drift.test.js, fixture-quality.test.js). If any CI scripts reference them, update or remove those scripts. |
| **Rollback** | `git revert`. |

---

### Rank 8: Remove Transient Key Sanitization Redundancy

| Field | Value |
|-------|-------|
| **Title** | Reduce transient key sanitization from 4+ passes to 1 |
| **Agents** | 2 |
| **Evidence** | research-engine.js lines 210-480: `sanitizeTransientKeys`, `hasTransientTopLevelKeys`, `hasSemanticArtifactPayload`, `sanitizePlaceholderStrings`. Same object gets recursively walked 4+ times: inside `synthesizeWithFallback` accept function, after validation, in `sanitizeCountryAnalysis`, and in pre-build sanitization (server.js:1018). The placeholder detection also deletes legitimate content describing data gaps (e.g., "data is insufficient for this sub-sector"). |
| **Content Impact** | 3 |
| **Simplicity Gain** | 4 |
| **Risk** | 1 |
| **Effort** | 2 |
| **Priority Score** | **+4** |
| **Recommended Action** | Run transient key sanitization ONCE, at the final pre-build stage only. Remove it from all intermediate stages (accept functions, post-validation, sanitizeCountryAnalysis). Narrow the placeholder detection regex to avoid matching legitimate analytical observations about data gaps. |
| **Rollback** | Re-add intermediate sanitization calls. |

---

### Rank 9: Consolidate 3 Review Loops into 1

| Field | Value |
|-------|-------|
| **Title** | Merge review-deepen, iterative refinement, and final review into a single loop |
| **Agents** | 1, 2, 4, 7 |
| **Evidence** | research-engine.js: (1) Review-Deepen loop lines 6043-6188, (2) Iterative Refinement loop lines 6392-6586, (3) Final Review loop lines 6597-6947. All three do the same thing: score content, identify gaps, research gaps, re-synthesize. Combined ~1000 lines of loop control logic. Each re-synthesis can LOSE content from previous passes. The final review loop alone is 350 lines with verification passes, dual escalation, snapshot tracking, noise detection. Agent 4 rates it 4/10 with "high complexity, diminishing returns after 1st iteration." |
| **Content Impact** | 5 |
| **Simplicity Gain** | 5 |
| **Risk** | 3 |
| **Effort** | 4 |
| **Priority Score** | **+3** |
| **Recommended Action** | Merge all three loops into one unified loop with max 3 iterations: (1) score via both code gate and LLM reviewer, (2) fill gaps, (3) re-synthesize weak sections only. Remove verification passes, snapshot tracking, noise detection, dual escalation. Cap at 3 iterations total. This cuts ~800 lines and saves 3-5 Pro LLM calls per run. |
| **Rollback** | Restore the 3 separate loops. |

---

### Rank 10: Simplify Synthesis Fallback from 5 Tiers to 3

| Field | Value |
|-------|-------|
| **Title** | Reduce synthesizeWithFallback from 5 tiers to 3 |
| **Agents** | 1, 2, 4 |
| **Evidence** | research-engine.js lines 2080-2372. 5 tiers: (1) Flash jsonMode, (2) truncation repair (free), (3) Flash non-jsonMode + boosted tokens, (4) Pro jsonMode, (5) Pro non-jsonMode. Tiers 4-5 (Pro) are rarely triggered and add ~6x Flash cost. Callers already have their own retry loops (synthesizePolicy retries 3x, synthesizeMarket retries 3x). Agent 2 shows tiers 3-5 strip synthesis style guide/story instructions, producing shallower content. |
| **Content Impact** | 4 |
| **Simplicity Gain** | 3 |
| **Risk** | 2 |
| **Effort** | 2 |
| **Priority Score** | **+3** |
| **Recommended Action** | Keep Tier 1 (Flash jsonMode), Tier 2 (truncation repair, free), Tier 3 (Flash non-jsonMode + boosted tokens). Remove Tiers 4-5 (Pro). If Tier 3 fails, return null and let the caller's retry handle it. Never strip the style guide or anti-padding rules from retry prompts -- these are what produce deep content. |
| **Rollback** | Re-add Pro tiers. |

---

### Rank 11: Reduce Server.js Gate Stack from 7 to 4

| Field | Value |
|-------|-------|
| **Title** | Consolidate server.js quality gates, downgrade 3 to warn-only |
| **Agents** | 2, 3, 7 |
| **Evidence** | server.js runs 7-9 sequential gates that can each abort a $20-30 run. Gates 2 (Readiness), 4 (content Readiness), 5 (PPT Data overflow) block delivery for scores/stylistic reasons. Gate 2 re-checks scores the orchestrator already computed. Gate 4 is the 2275-line regex engine (see Rank 2). Gate 5's 600-char overflow limit contradicts "content depth is #1." |
| **Content Impact** | 4 |
| **Simplicity Gain** | 4 |
| **Risk** | 3 |
| **Effort** | 2 |
| **Priority Score** | **+3** |
| **Recommended Action** | KEEP hard-fail: Research Quality (Gate 1), Synthesis Quality (Gate 3), Pre-build Structure (Gate 6), PPT Package file safety (Gate 8), PPT Structural Validation (Gate 9b). DOWNGRADE to warn-only: Readiness (Gate 2 -- make SOFT_READINESS_GATE permanent), content Readiness (Gate 4), PPT Data overflow (Gate 5), PPT Build Quality formatting (Gate 9a). REMOVE: content size check (Gate 7 -- see Rank 1). |
| **Rollback** | Re-enable hard-fail on downgraded gates via env vars. |

---

### Rank 12: Delete 18 Low-Value Test Files

| Field | Value |
|-------|-------|
| **Title** | Delete 18 test files (13,123 LOC) that test formatting, ops tooling, and test infrastructure |
| **Agents** | 6 |
| **Evidence** | 88.5% of test LOC guards formatting, infrastructure, or operational tooling. Only 11.5% (2,646 LOC in 4 files) guards content quality. 3,434 LOC is meta-testing (tests testing test infrastructure). 2,417 LOC across 4 files tests a single geometry module. Two complete stress harnesses exist (3,267 LOC). See Agent 6 for full deletion list. |
| **Content Impact** | 0 |
| **Simplicity Gain** | 5 |
| **Risk** | 1 |
| **Effort** | 1 |
| **Priority Score** | **+3** |
| **Recommended Action** | Delete these 18 files: stress-lab.test.js, template-style match-hardening.test.js, golden-baseline-drift.test.js, fixture-quality.test.js, header-footer-drift-diagnostics.test.js, line-width-signature.test.js, reliability-observability.test.js, operator-automation.test.js, perf-profiler.test.js, preflight-hardening.test.js, real-output-gate.test.js, formatting-audit-strict.test.js, regression-persistence.test.js, template-contract-unification.test.js, strict-geometry-enforcement.test.js, test-fix-loop.js, stress-lab.js (if not deleted in Rank 5), stress-test-harness.js (if not deleted in Rank 5). |
| **Rollback** | `git revert`. |

---

### Rank 13: Delete Dead Code (6 Specialized Agents + synthesizeSingleCountry)

| Field | Value |
|-------|-------|
| **Title** | Delete confirmed dead code paths |
| **Agents** | 7 |
| **Evidence** | `useDynamicFramework = true` is hardcoded (research-engine.js line 5878). The `else` branch (lines 5973-6041) calling 6 specialized agents is unreachable dead code. These 6 agents in research-agents.js (policyResearchAgent, marketResearchAgent, etc.) are only reachable from this dead path. `synthesizeSingleCountry()` (lines 7022-7270, ~250 lines) is exported but never called in production. |
| **Content Impact** | 0 |
| **Simplicity Gain** | 4 |
| **Risk** | 1 |
| **Effort** | 1 |
| **Priority Score** | **+2** |
| **Recommended Action** | Remove `useDynamicFramework` guard and dead else branch from `researchCountry()`. Remove 6 specialized agent functions from research-agents.js (keep only `universalResearchAgent`). Delete `synthesizeSingleCountry()` from research-engine.js. Total: ~1,700 lines. |
| **Rollback** | `git revert`. |

---

### Rank 14: Move Dev/Ops Tools to scripts/

| Field | Value |
|-------|-------|
| **Title** | Relocate dev/ops CLI tools from production root to scripts/ |
| **Agents** | 5, 7 |
| **Evidence** | repair-pptx.js (141), build-template-patterns.js (517), extract-template-complete.js (1055), pptx-file safety-pipeline.js (469), ops-runbook.js (1082), test-ppt-generation.js (929), test-vietnam-research.js (778), test-fix-loop.js (215) = ~5,186 LOC. None imported by server.js. All are standalone CLI tools or test scripts. |
| **Content Impact** | 0 |
| **Simplicity Gain** | 3 |
| **Risk** | 1 |
| **Effort** | 2 |
| **Priority Score** | **+0** (but zero risk, improves organization) |
| **Recommended Action** | Move all listed files to `scripts/` directory. Update any require paths in ops-runbook.js. These files still exist for use, just not in the production root. |
| **Rollback** | Move files back. |

---

### Rank 15: Fix Competitor Synthesis Context Isolation

| Field | Value |
|-------|-------|
| **Title** | Allow competitor synthesis LLM calls to cross-reference each other |
| **Agents** | 2 |
| **Evidence** | research-engine.js lines 3178-3571. `synthesizeCompetitors` makes 4 sequential LLM calls (japanesePlayers, localMajor, foreignPlayers, caseStudy) where each call cannot see what was generated for previous categories. Cross-referencing ("unlike ENGIE, Japanese competitor Mitsui has...") is impossible. Validation code for competitors (lines 3334-3467, ~135 lines) is longer than the actual synthesis prompts. |
| **Content Impact** | 4 |
| **Simplicity Gain** | 3 |
| **Risk** | 3 |
| **Effort** | 3 |
| **Priority Score** | **+1** |
| **Recommended Action** | Pass previous competitor chunks as context to subsequent synthesis calls. For chunk 2 (localMajor), include chunk 1 (japanesePlayers) in the prompt. For chunk 3 (foreignPlayers), include chunks 1+2. This enables cross-referencing. Alternatively: synthesize all competitors in a single call with a longer prompt. |
| **Rollback** | Revert to isolated calls. |

---

### Rank 16: Remove Prompt Validation Checklist from Synthesis Prompts

| Field | Value |
|-------|-------|
| **Title** | Remove 7200-char LLM self-verification checklist from synthesis prompts |
| **Agents** | 2 |
| **Evidence** | research-engine.js lines 7020-7268. `synthesizeSingleCountry` prompt includes a 7200-char validation checkpoint telling the LLM to "STOP" and verify word counts, number counts, company descriptions. LLMs are poor at self-counting. The system's own validation code checks all the same things. The 7200 chars could be used for more research context instead. Similar patterns exist in other synthesis prompts. |
| **Content Impact** | 3 |
| **Simplicity Gain** | 3 |
| **Risk** | 1 |
| **Effort** | 1 |
| **Priority Score** | **+4** |
| **Recommended Action** | Remove the "VALIDATION CHECKPOINT" sections from all synthesis prompts. Use the freed prompt space for additional research context or more specific analytical instructions. Keep the system-level validation (quality gates) which does this checking more reliably. |
| **Rollback** | Re-add checklists to prompts. |

---

### Rank 17: Remove Thin Response Rejection for Short Authoritative Answers

| Field | Value |
|-------|-------|
| **Title** | Change thin-response threshold from hard rejection to contextual check |
| **Agents** | 2 |
| **Evidence** | ai-clients.js lines ~300-400. `callGeminiResearch` throws and retries when response < 500 chars. Some topics have genuinely short authoritative answers (e.g., "No foreign ownership restrictions apply. 100% foreign ownership permitted since 2019." = 127 chars). Retry produces padded, tangential content. |
| **Content Impact** | 3 |
| **Simplicity Gain** | 2 |
| **Risk** | 1 |
| **Effort** | 1 |
| **Priority Score** | **+3** |
| **Recommended Action** | Lower threshold from 500 to 200 chars. Below 200 chars, retry once. Below 50 chars, always retry (likely an error). Accept any response >= 200 chars. This preserves the guard against truly empty responses while allowing short authoritative answers. |
| **Rollback** | Restore 500-char threshold. |

---

### Rank 18: Remove content Coherence Checker (Duplicate of 3 Other Systems)

| Field | Value |
|-------|-------|
| **Title** | Delete story-flow-check.js |
| **Agents** | 2 |
| **Evidence** | story-flow-check.js (589 lines). Duplicates functionality with: (1) `checkContradictions` in content-quality-check.js (lines 758-855), (2) `checkCrossSectionContradictions` in content-quality-check.js (lines 875-904), (3) `finalReviewSynthesis` in research-engine.js (LLM-based, catches same issues more accurately). Content can pass coherence checker but fail content engine's contradiction check (or vice versa), triggering unnecessary retries. |
| **Content Impact** | 2 |
| **Simplicity Gain** | 4 |
| **Risk** | 1 |
| **Effort** | 2 |
| **Priority Score** | **+3** |
| **Recommended Action** | Delete `story-flow-check.js`. Remove the `checkStoryFlow` parameter from `contentReadinessCheck` calls in server.js. The LLM-based final review already catches cross-section inconsistencies more accurately than regex extraction. |
| **Rollback** | `git revert`. |

---

### Rank 19: Reduce Code Duplication Across Files

| Field | Value |
|-------|-------|
| **Title** | Deduplicate shared utilities across files |
| **Agents** | 1 |
| **Evidence** | `ensureString`, `normalizePptTextGlyphs`, `stripInvalidSurrogates` duplicated in deck-builder-single.js (lines 159-203) AND ppt-utils.js (lines 1-46). `runInBatches` duplicated in research-engine.js (lines 109-145) AND research-agents.js. `parsePositiveIntEnv`/`parseNonNegativeIntEnv` duplicated in research-engine.js AND server.js. Key canonicalization duplicated in research-engine.js AND deck-builder-single.js. ~300 lines of duplication total. |
| **Content Impact** | 2 |
| **Simplicity Gain** | 2 |
| **Risk** | 1 |
| **Effort** | 1 |
| **Priority Score** | **+2** |
| **Recommended Action** | Move shared utilities to a single `shared/utils.js` module (which already exists in the project). Import from there in all files. Remove duplicate copies. |
| **Rollback** | Restore inline copies. |

---

### Rank 20: Consolidate Repetitive Chart Functions

| Field | Value |
|-------|-------|
| **Title** | Merge 4 repetitive chart functions into 1 generic function |
| **Agents** | 1 |
| **Evidence** | ppt-utils.js lines 1255-1918: `addStackedBarChart`, `addLineChart`, `addBarChart`, `addPieChart` each ~100 lines with near-identical validation/fallback patterns. ~400 lines of repetitive code. |
| **Content Impact** | 1 |
| **Simplicity Gain** | 2 |
| **Risk** | 2 |
| **Effort** | 2 |
| **Priority Score** | **+/-0** |
| **Recommended Action** | Merge into `addChart(type, data, options)` (~150 lines) with type-specific config via lookup table. Shared validation. This is low priority (formatting code, secondary concern). |
| **Rollback** | Restore individual functions. |

---

## 3. Phased Implementation

### Phase 1 -- Quick Wins (1-2 days, low risk)

**Objective**: Remove dead code, delete unused files, relocate dev tools. Zero content risk.

| # | Action | Files Affected | LOC Saved | Risk |
|---|--------|---------------|-----------|------|
| 1 | Delete content-size-check.js | content-size-check.js, server.js | 391 | Low |
| 2 | Delete stress-lab.js + stress-test-harness.js | 2 files + test | 3,893 | None |
| 3 | Delete 6 non-production gate files | preflight-gates.js, schema-firewall.js, route-geometry-enforcer.js, source-lineage-enforcer.js, golden-baseline-manager.js, pptx-file safety-pipeline.js | 6,099 | None |
| 4 | Delete dead code (6 specialized agents, synthesizeSingleCountry, useDynamicFramework guard) | research-agents.js, research-engine.js | ~1,700 | None |
| 5 | Delete 18 low-value test files | 18 .test.js files | 13,123 | None |
| 6 | Delete chart-quality-gate.js + chart-data-normalizer.js | 2 files | 670 | None |
| 7 | Delete context-fit-agent.js | 1 file | 292 | Low |
| 8 | Delete story-flow-check.js | 1 file + update server.js | 589 | Low |
| 9 | Move dev tools to scripts/ | ~8 files | 0 (moved) | None |
| 10 | Remove prompt validation checklists | research-engine.js | ~200 (prompt chars) | Low |
| **Total** | | | **~26,757** | |

**Verification after Phase 1**:
- `npm test` passes (remaining tests)
- `node server.js` starts without errors
- Submit a test research request and verify content quality is unchanged or improved (content size check removal should improve it)

---

### Phase 2 -- Medium Impact (3-5 days, moderate risk)

**Objective**: Simplify gates, fix key enforcement, reduce retry overhead. Moderate content risk -- requires testing with real runs.

| # | Action | Files Affected | LOC Saved | Risk |
|---|--------|---------------|-----------|------|
| 1 | Downgrade content readiness gate to warn-only | server.js, content-quality-check.js | ~50 (logic change) | Medium |
| 2 | Fix canonical key enforcement ordering (normalize before accept) | research-engine.js | ~100 | Medium |
| 3 | Reduce synthesizeWithFallback from 5 to 3 tiers | research-engine.js | ~100 | Medium |
| 4 | Reduce transient key sanitization to 1 pass | research-engine.js, server.js | ~150 | Low |
| 5 | Remove hardcoded content defaults (ensureSummaryCompleteness) | research-engine.js | ~400 | Medium |
| 6 | Downgrade readiness gate, PPT data overflow, PPT build formatting to warn-only | server.js | ~80 | Medium |
| 7 | Lower thin-response threshold from 500 to 200 chars | ai-clients.js | ~10 | Low |
| 8 | Deduplicate shared utilities | Multiple files | ~300 | Low |
| **Total** | | | **~1,190** | |

**Verification after Phase 2**:
- Run 3 test research requests (different industries/countries)
- Compare output quality against a Phase-1 baseline
- Verify no sections are empty that were previously filled
- Check that key normalization handles edge cases (run with known problematic industry)

---

### Phase 3 -- Strategic Refactoring (1-2 weeks, higher risk)

**Objective**: Architectural changes to the content generation pipeline. Requires careful A/B testing.

| # | Action | Files Affected | LOC Saved | Risk |
|---|--------|---------------|-----------|------|
| 1 | Merge 3 review loops into 1 unified loop | research-engine.js | ~800 | High |
| 2 | Fix competitor synthesis context isolation | research-engine.js | ~50 (net, adds context passing) | Medium |
| 3 | Prune template-patterns.json to runtime-only | template-patterns.json | ~50,000 | Medium |
| 4 | Split template-contract-compiler.js | template-contract-compiler.js | ~900 (moved) | Medium |
| 5 | Consolidate chart functions | ppt-utils.js | ~250 | Low |
| 6 | Move test files to __tests__/ | 25+ files | 0 (moved) | None |
| 7 | Reduce env var config from 44 to ~10 mode-based | server.js, research-engine.js | ~200 | Medium |
| **Total** | | | **~2,200 + 50,000 JSON** | |

**Key architectural decisions**:
- **Generation-first vs Gate-first**: Phase 3 completes the shift from "generate then gate" to "generate well the first time." The unified review loop exists as a safety net, not as the primary quality mechanism.
- **Structured output**: Adopt Gemini's structured output (JSON schema) for all synthesis calls to eliminate key canonicalization entirely.
- **Single-pass synthesis**: Evaluate whether competitor synthesis can be done in 1 call instead of 4, now that context passing is enabled.

**Verification after Phase 3**:
- Run 5 test requests across different industries (energy, healthcare, fintech, logistics, consumer goods)
- A/B compare: run same prompt on old code (pre-Phase-3) and new code
- Measure: (a) content word count per section, (b) number of specific data points, (c) number of named entities, (d) total LLM calls, (e) total cost, (f) total time
- Accept new code only if content metrics are equal or better

---

## 4. Keep / Downgrade / Remove Master List

| Item | Category | Agent(s) | Decision | Reason |
|------|----------|----------|----------|--------|
| research-engine.js | CORE-CONTENT | 1,2,4,7 | KEEP + REFACTOR | Central pipeline. Needs loop consolidation, dead code removal, deduplication |
| research-agents.js | CORE-CONTENT | 1,4,7 | KEEP + TRIM | Remove 6 dead specialized agents, keep universalResearchAgent |
| research-framework.js | CORE-CONTENT | 1,4 | KEEP | Clean, well-structured with good fallback |
| ai-clients.js | CORE-CONTENT | 1,2,4 | KEEP + ADJUST | Lower thin-response threshold from 500 to 200 |
| context-fit-agent.js | CORE-CONTENT | 2,5,7 | REMOVE | LLM call to shorten content. Not imported in production |
| server.js | INFRASTRUCTURE | 2,3,7 | KEEP + SIMPLIFY | Downgrade 3 gates to warn-only, extract gate helpers, remove content size check call |
| deck-builder-single.js | FORMATTING | 1,5 | KEEP (defer refactor) | 7620-line monolith. Needs breakup but high effort/risk. Phase 3+ |
| ppt-utils.js | FORMATTING | 1,5 | KEEP + CONSOLIDATE | Consolidate chart functions. Remove duplicated string utils |
| deck-builder.js | FORMATTING | 1 | KEEP | Wraps single-country, reasonable |
| template-contract-compiler.js | FORMATTING | 3,5 | SPLIT | Extract constants (~200 LOC) to template-constants.js, move functions to scripts/ |
| template-fill.js | FORMATTING | 5 | KEEP | Structural, used by PPT builder |
| header-footer-drift-diagnostics.js | FORMATTING | 5 | DOWNGRADE | Gate behind ENABLE_DRIFT_DIAGNOSTICS env var, remove disk writes |
| chart-data-normalizer.js | FORMATTING | 5,6 | REMOVE | Only imported by chart-quality-gate.js which is dead |
| repair-pptx.js | FORMATTING | 5,7 | MOVE to scripts/ | CLI tool, not runtime |
| theme-normalizer.js | FORMATTING | 5 | KEEP | 87 lines, prevents theme corruption |
| route-geometry-enforcer.js | GATE/VALIDATION | 1,3,5 | REMOVE | Dead code. Zero production callers |
| content-quality-check.js | GATE/VALIDATION | 1,2,3 | DOWNGRADE | 2275 lines. Change from hard-fail to warn-only |
| preflight-gates.js | GATE/VALIDATION | 1,3,7 | REMOVE | 1934 lines. CI only, not in production pipeline |
| stress-lab.js | GATE/VALIDATION | 1,6,7 | REMOVE | Test harness. Not production |
| stress-test-harness.js | GATE/VALIDATION | 1,6,7 | REMOVE | Superseded by stress-lab.js, itself being removed |
| deck-file-check.js | GATE/VALIDATION | 1,3,5 | KEEP | Prevents corrupt PPTX files |
| golden-baseline-manager.js | GATE/VALIDATION | 1,3,6 | REMOVE | Test infrastructure only |
| schema-firewall.js | GATE/VALIDATION | 1,3 | REMOVE | Duplicates orchestrator validation. Not in server.js |
| quality-gates.js | GATE/VALIDATION | 1,3,4 | KEEP | Used by server.js. Reasonable thresholds |
| story-flow-check.js | GATE/VALIDATION | 2 | REMOVE | Duplicates 3 other systems |
| source-lineage-enforcer.js | GATE/VALIDATION | 3,7 | REMOVE | Not in production pipeline |
| failure-cluster-analyzer.js | GATE/VALIDATION | 1,7 | REMOVE | Clusters stress test failures. Stress tests being removed |
| pptx-file safety-pipeline.js | GATE/VALIDATION | 3,5 | REMOVE | Duplicated inline in server.js |
| content-size-check.js | GATE/VALIDATION | 2,3 | REMOVE | Actively destroys content |
| chart-quality-gate.js | GATE/VALIDATION | 3,5 | REMOVE | Dead code. Not in production |
| source-coverage-reporter.js | GATE/VALIDATION | 3,7 | REMOVE | Not in production pipeline |
| validate-real-output.js | GATE/VALIDATION | 3,7 | MOVE to scripts/ | CLI validation tool |
| validate-output.js | GATE/VALIDATION | 3,7 | MOVE to scripts/ | CLI validation tool |
| cleanup-temp-fields.js | INFRASTRUCTURE | 2,5 | KEEP | Structural, but reduce invocations from 4+ to 1 |
| ops-runbook.js | INFRASTRUCTURE | 1,7 | MOVE to scripts/ | CLI tool, not runtime |
| extract-template-complete.js | INFRASTRUCTURE | 5,7 | MOVE to scripts/ | Offline extraction tool |
| post-run-summary.js | INFRASTRUCTURE | 7 | REMOVE | Not imported by server.js |
| perf-profiler.js | INFRASTRUCTURE | 7 | REMOVE | Not imported by production server.js |
| build-template-patterns.js | INFRASTRUCTURE | 5,7 | MOVE to scripts/ | Offline builder |
| reliability-digest.js | INFRASTRUCTURE | 7 | REMOVE | Stress lab reporter, being removed |
| test-fix-loop.js | INFRASTRUCTURE | 6,7 | REMOVE | Manual dev tool |
| template-patterns.json | DATA | 5 | KEEP + PRUNE | 64,705 lines. Prune to ~15,000 runtime-needed fields |
| golden-baseline-drift.test.js | TEST | 6 | REMOVE | Tests removed module |
| chart-data-file safety.test.js | TEST | 6 | CONSOLIDATE | Keep normalization tests, drop fuzz |
| template-style match-hardening.test.js | TEST | 6 | REMOVE | Overlaps with 3 other test files |
| reliability-observability.test.js | TEST | 6 | REMOVE | Tests non-production modules |
| preflight-hardening.test.js | TEST | 6 | REMOVE | Overlaps with preflight-gates.test.js |
| test-ppt-generation.js | TEST | 6,7 | CONSOLIDATE | Merge into single integration test |
| fixture-quality.test.js | TEST | 6 | REMOVE | Tests test infrastructure |
| source-lineage.test.js | TEST | 6 | CONSOLIDATE | Merge and shrink |
| content-depth.test.js | TEST | 6 | KEEP | Content quality tests |
| content-readiness-check.test.js | TEST | 6 | KEEP | Content quality tests |
| test-vietnam-research.js | TEST | 6,7 | CONSOLIDATE | Merge into integration test |
| operator-automation.test.js | TEST | 6 | REMOVE | Tests ops tooling |
| header-footer-drift-diagnostics.test.js | TEST | 6 | REMOVE | Formatting minutiae |
| route-geometry-enforcer.test.js | TEST | 6 | REMOVE (if module deleted) | Dead module tests |
| stress-lab.test.js | TEST | 6 | REMOVE | Tests test harness |
| schema-firewall.test.js | TEST | 6 | KEEP | Data shape validation |
| content-quality-check.test.js | TEST | 6 | KEEP | Content quality tests |
| pptx-file safety-pipeline.test.js | TEST | 6 | CONSOLIDATE | Keep basic pipeline run |
| perf-profiler.test.js | TEST | 6 | REMOVE | Tests non-production module |
| formatting-audit-strict.test.js | TEST | 6 | REMOVE | Formatting meta-testing |
| real-output-gate.test.js | TEST | 6 | REMOVE | Tests deployment tooling |
| preflight-gates.test.js | TEST | 6 | CONSOLIDATE | Merge with others |
| regression-persistence.test.js | TEST | 6 | REMOVE | Tests test infrastructure |
| line-width-signature.test.js | TEST | 6 | REMOVE | Pixel-level formatting |
| template-contract-compiler.test.js | TEST | 6 | CONSOLIDATE | Merge with others |
| template-contract-unification.test.js | TEST | 6 | REMOVE | Mapping drift testing |
| strict-geometry-enforcement.test.js | TEST | 6 | REMOVE | Duplicate of geometry test |

---

## 5. Go/No-Go Criteria

All criteria are tied to **content quality**, not formatting.

### Before Each Phase

1. **Baseline capture**: Run 2 identical research requests (same prompt, same industry/country) on current code. Save the output PPTX and synthesis JSON. This is the quality baseline.
2. **Content metrics**: For each baseline, measure:
   - Total word count per section (policy, market, competitors, depth, summary)
   - Number of named entities (companies, regulations, organizations)
   - Number of quantitative data points (percentages, dollar amounts, years, growth rates)
   - Number of specific insights with data+action+timing
   - Number of chart data series with real values
3. **LLM call count**: Record total LLM calls and cost per run.

### After Each Phase

1. **Same-prompt test**: Run the same 2 prompts on new code. Compare output against baseline.
2. **Content parity check**: Every metric must be >= baseline. Specifically:
   - Word count per section: >= 90% of baseline (some reduction acceptable from removing filler)
   - Named entities: >= 100% of baseline
   - Quantitative data points: >= 100% of baseline
   - Specific insights: >= 100% of baseline
   - No section that was non-empty in baseline is empty in new output
3. **No-go triggers** (roll back the phase):
   - Any section drops to 0 content that was non-zero in baseline
   - Named entities drop below 80% of baseline
   - Total word count drops below 70% of baseline
   - Pipeline fails (throws error) on a prompt that succeeded in baseline
4. **Expected improvements** (validate these):
   - content size check removal (Phase 1): word counts should INCREASE (no more truncation)
   - content gate downgrade (Phase 2): fewer pipeline failures, same content
   - Thin-response fix (Phase 2): fewer padded research responses
   - Review loop merge (Phase 3): fewer LLM calls, similar or better content

### Specific Tests to Run

| Phase | Test | Pass Criteria |
|-------|------|---------------|
| 1 | Research: "Energy services market in Japan" | Produces complete deck, all sections filled |
| 1 | Research: "Healthcare IT market in Germany" | Produces complete deck (non-energy industry) |
| 2 | Research: "Fintech market in Nigeria" | Dynamic framework generates relevant topics (not energy fallback) |
| 2 | Research: "Logistics infrastructure in Vietnam" | Competitor section has cross-references between player categories |
| 3 | Research: "Consumer goods market in Brazil" | Single review loop produces quality >= triple-loop baseline |
| 3 | Compare LLM call count: new vs old | New code uses <= 70% of old code's LLM calls |

---

## 6. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|-----------|
| 1 | content size check removal causes PPT builder to crash on oversized content | Medium | High | Test with verbose synthesis output. If builder crashes, add font-shrinking logic in ppt-utils.js instead of truncation. |
| 2 | content gate downgrade lets genuinely shallow content through to users | Medium | Medium | Keep scoring as diagnostics. If output quality degrades, re-enable as warn + manual review rather than hard-fail. |
| 3 | Key normalization reorder breaks edge cases where accept function's early rejection was preventing bad data | Low | Medium | Test with 5+ diverse industries. The normalization functions already handle the key mapping -- they just ran too late. |
| 4 | Deleting 6 specialized agents removes fallback for cases where universalResearchAgent fails | Low | Low | universalResearchAgent has been the only path for months (useDynamicFramework = true). The specialized agents were already dead code. |
| 5 | Review loop consolidation causes content quality regression | Medium | High | A/B test: run same prompt through old triple-loop and new single-loop. Compare content metrics. Keep old code in a branch until validated. |
| 6 | Removing ensureSummaryCompleteness defaults creates empty depth sections | Medium | Medium | First: improve the synthesis prompt to generate complete depth sections. Only remove defaults after verifying the prompt produces the needed fields. |
| 7 | Removing stress tests means regressions go undetected | Low | Low | The stress tests never ran in production. A single integration test (kept in Phase 1) catches real regressions. Content-quality tests (4 files, 2,646 LOC) are preserved. |
| 8 | template-patterns.json pruning removes a field that is accessed at runtime | Medium | High | Exhaustive grep of all property access paths before pruning. Build a test that loads the pruned version and runs a full PPT generation. |
| 9 | Concurrent changes during phased rollout cause merge conflicts | Low | Medium | Execute phases sequentially. Each phase is a single PR. No parallel work on these files during the phase. |
| 10 | Reduced retry tiers (5->3) cause more synthesis failures in edge cases | Low | Medium | Monitor synthesis success rate for 1 week after Phase 2. If failure rate increases >5%, re-add Pro tier as Tier 4 only. |
