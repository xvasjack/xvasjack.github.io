# Agent 3: Gate Rationalization Report

## Executive Summary

The market-research pipeline has **14 distinct gate/validation systems** spread across 14+ files. Many are duplicative, only used in CI/test scripts, or enforce formatting constraints that conflict with the stated priority: **content depth is #1**.

The production pipeline (server.js) runs **9 sequential gates** that can each independently abort a $20-30 run. Several gates overlap in what they check, and formatting-focused gates block content delivery for cosmetic reasons.

---

## Gate Inventory

### PRODUCTION PIPELINE GATES (server.js, run on every request)

| # | Gate Name | File:Line | What it checks | Fail behavior | Protects Content? | Classification | Simplicity Gain | Risk |
|---|-----------|-----------|----------------|---------------|-------------------|----------------|-----------------|------|
| 1 | Research Quality Gate | quality-gates.js:122, server.js:625 | Research data has 2000+ chars, 5+ topics with 300+ chars, company names, year mentions | Retry weak topics (up to 5), then continue | YES | KEEP | 1 | 5 |
| 2 | Readiness Gate | server.js:729-822 | effective>=80, coherence>=80, critical<=1, major<=3, openGaps<=3 | Hard-fail (throws) unless SOFT_READINESS_GATE=true (default true) or draftPptMode | YES | DOWNGRADE | 3 | 3 |
| 3 | Synthesis Quality Gate | quality-gates.js:255, server.js:833 | Policy acts>=2, market sections present with numbers, 5+ competitors, summary with insights | Hard-fail if score<40 (throws). Score 40-60: retry once with boosted tokens. | YES | KEEP | 1 | 4 |
| 4 | content Readiness Gate | content-quality-check.js:1897, server.js:885 | 4-dimension rubric: insightDepth, evidenceGrounding, storylineCoherence, actionability (threshold 80) | Hard-fail (throws) unless draftPptMode | Partially - checks content quality but blocks delivery for stylistic/reasoning gaps | DOWNGRADE | 4 | 3 |
| 5 | PPT Data Gate | quality-gates.js:734, server.js:944 | Blocks have buildable data, <40% empty, no chart issues, no severe overflow (>600 chars) | Hard-fail (throws) unless draftPptMode | Partially - severe overflow check TRUNCATES content rather than protecting it | DOWNGRADE | 3 | 3 |
| 6 | Pre-build Structure Gate | server.js:358-420, server.js:1032 | All 5 canonical sections (policy/market/competitors/depth/summary) present as objects, no non-canonical keys | Hard-fail (throws) | YES - catches data shape corruption | KEEP | 1 | 5 |
| 7 | content size check | content-size-check.js:373, server.js:1046 | Field char budgets (500-800 chars), table density (16 rows/9 cols), chart min data points | Auto-compacts (trims text, truncates rows) - never blocks | NO - actively DESTROYS content by trimming to char limits | REMOVE | 5 | 2 |
| 8 | Post-build PPT Package file safety | server.js:1078-1139 | Relationship targets, non-visual IDs, content types, package consistency | Hard-fail (throws) on broken internal targets/package | YES - prevents corrupt PPTX files | KEEP | 1 | 5 |
| 9a | PPT Build Quality Gate | server.js:1144-1213 | Build failure rate (<35%), formatting audit (0 critical), template coverage (>=95%), table recoveries, geometry issues | Hard-fail on structural failures. Formatting warnings are warn-only unless templateStrictMode | Partially | DOWNGRADE | 3 | 3 |
| 9b | PPT Structural Validation | deck-file-check.js, server.js:1216-1261 | Min 12 slides, min 120KB, min 1 chart/3 tables, no forbidden text ("[truncated]"), <6 empty slides | Hard-fail (throws) | YES - catches clearly broken decks | KEEP | 1 | 4 |

### NON-PRODUCTION GATES (CI/test/scripts only - NOT in server.js pipeline)

| # | Gate Name | File | What it checks | Used by | Classification | Simplicity Gain | Risk |
|---|-----------|------|----------------|---------|----------------|-----------------|------|
| 10 | Preflight Gates | preflight-gates.js (1934 lines) | Clean git tree, HEAD content, module exports, function signatures, template contracts, route geometry, schema firewall, regression tests, stress checks, schema compatibility, sparse slides, source coverage, real output validation, formatting audit | CI/release scripts only | REMOVE from codebase or move to devDependencies | 5 | 1 |
| 11 | Schema Firewall | schema-firewall.js (990 lines) | Validate/coerce/quarantine synthesis against schemas, trust scoring, source lineage | Only used by source-lineage-enforcer.js and tests. NOT in server.js | REMOVE or DOWNGRADE | 4 | 2 |
| 12 | Route Geometry Enforcer | route-geometry-enforcer.js (800 lines) | Slide geometry matches expected (text/table/chart), fallback chain, strict mode | Only used by tests and template-contract-compiler. NOT in server.js | REMOVE or DOWNGRADE | 4 | 2 |
| 13 | Source Lineage Enforcer | source-lineage-enforcer.js (520 lines) | Claim-to-source mapping, orphaned claim detection | Only used by source-coverage-reporter.js and tests. NOT in server.js | REMOVE | 4 | 1 |
| 14 | Golden Baseline Manager | golden-baseline-manager.js (1300 lines) | Baseline drift detection, structural comparison, fixture management | Only used by tests. NOT in server.js | REMOVE | 5 | 1 |
| 15 | Template Contract Compiler | template-contract-compiler.js (1100 lines) | Compile template patterns into contracts, drift detection, coverage audit | Used by deck-builder-single.js and ppt-utils.js for template mapping constants, but the gate functions (drift, doctor, auditCoverage) are only used in tests/scripts | DOWNGRADE - keep constants, remove gate functions | 3 | 2 |
| 16 | PPTX file safety Pipeline | pptx-file safety-pipeline.js (470 lines) | 4-stage pipeline: relationship normalization, non-visual ID normalization, content types reconciliation, reference file safety | Used by ops-runbook.js only. NOT in server.js (server.js does these stages inline) | REMOVE - duplicated in server.js:1078-1139 | 4 | 1 |
| 17 | Chart Quality Gate | chart-quality-gate.js (337 lines) | Score chart data 0-100, normalize, validate | NOT called in server.js pipeline | REMOVE from production consideration | 3 | 1 |
| 18 | Validate Output | validate-output.js (168 lines) | CLI script to validate PPTX output against expectations | Standalone CLI tool, never imported by server.js | KEEP as dev tool | 1 | 1 |
| 19 | Validate Real Output | validate-real-output.js (247 lines) | Production-level PPTX validation with quality checks | Only called by preflight-gates.js (test/CI) | KEEP as dev tool | 1 | 1 |
| 20 | Decision Gate | content-quality-check.js:1266 | Score decision-usefulness per section | Called internally by contentReadinessCheck, not standalone in pipeline | Part of Gate 4 | - | - |
| 21 | content Coherence Checker | story-flow-check.js | Cross-section numeric/factual consistency | Called as coherenceChecker parameter to contentReadinessCheck (Gate 4) | Part of Gate 4 | - | - |

---

## Recommendations

### KEEP (5 gates) - Hard-fail, protects real value

| Gate | Reason |
|------|--------|
| 1. Research Quality | Catches empty/broken research data before expensive synthesis. Retry mechanism is valuable. Low threshold (score >= 55). |
| 3. Synthesis Quality | Catches structurally broken synthesis (missing sections, no data). Threshold is reasonable (>= 60). Already has retry logic. |
| 6. Pre-build Structure | Catches data shape corruption that would crash the PPT builder. Simple checks, low false-positive risk. |
| 8. Post-build Package file safety | Prevents sending corrupt PPTX files that won't open. This is the one gate you absolutely cannot skip. |
| 9b. PPT Structural Validation | Catches clearly broken/truncated decks. Min slides/size/content checks are sensible. |

### DOWNGRADE (4 gates) - Change from hard-fail to warn-only

| Gate | Current behavior | Proposed change | Why |
|------|-----------------|-----------------|-----|
| 2. Readiness Gate | Hard-fail when effective<80, coherence<80, etc. (already has SOFT_READINESS_GATE env var) | Make SOFT_READINESS_GATE the permanent behavior. Remove the hard-fail path entirely. Log warnings. | The readiness check is useful diagnostics but blocking delivery over score thresholds wastes the $20-30 already spent. The user should see the report and judge quality themselves. |
| 4. content Readiness Gate | Hard-fail when overallScore < 80 | Warn-only. Log the rubric scores and improvement actions but never throw. | This gate has the HIGHEST false-positive risk. It checks "causal reasoning chains", "action verbs", "named companies" - stylistic criteria that may not apply to all industries. A score of 79 vs 81 should not determine whether the user gets their report. |
| 5. PPT Data Gate (overflow part) | Hard-fail on >600 char fields and chart issues | Remove the overflow hard-fail (severeOverflowCount). Keep the empty-block check as warn-only. | The 600-char overflow limit contradicts "content depth is #1 priority." Let the builder handle overflow through font shrinking, not gate blocking. |
| 9a. PPT Build Quality | Hard-fail on template coverage <95%, table recoveries, geometry issues, formatting audit | Warn-only for all formatting metrics. Keep only the build failure rate check (>35% failures = something is truly broken). | Template coverage, geometry issues, and formatting audit are FORMATTING concerns. The user cares about content. A deck with 90% template coverage and good content is better than no deck. |

### REMOVE (7 systems) - Delete or move to devDependencies

| System | Evidence it's low-value | Lines saved |
|--------|------------------------|-------------|
| 7. content size check (compaction) | Actively destroys content by trimming fields to 500-800 char limits and truncating tables to 16 rows. This is the exact "truncation = data loss" bug from mistakes.md row 37. The user pays for 48 LLM calls generating 585K tokens, then the content size check throws content away. | 391 |
| 10. Preflight Gates | 1934-line CI/release gate system. Not called in production. Only used by test scripts and release-loop.js. Move to devDependencies or a separate CI package. | 1934 |
| 11. Schema Firewall | 990 lines of validation/coercion/quarantine/trust-scoring. Not called in server.js. The coerce() function duplicates logic already in research-engine.js (validateCompetitorsSynthesis, validateMarketSynthesis, validatePolicySynthesis). | 990 |
| 12. Route Geometry Enforcer | 800 lines. Not called in server.js or deck-builder-single.js. Only used by tests. | 800 |
| 13. Source Lineage Enforcer | 520 lines. Not called in production pipeline. Source coverage is a nice-to-have diagnostic but should not be a gate. | 520 |
| 14. Golden Baseline Manager | 1300 lines. Only used by tests for drift detection. Test infrastructure, not production code. | 1300 |
| 16. PPTX file safety Pipeline | 470 lines. Server.js does the same 4 stages inline (lines 1078-1139). This is a dead duplicate. | 470 |

**Total lines removable: ~6,405 lines across 7 files**

---

## Scoring Summary (Top Findings)

| Finding | Content Impact (1-5) | Simplicity Gain (1-5) | Risk (1-5) | Effort (1-5) | Priority Score |
|---------|---------------------|-----------------------|------------|--------------|----------------|
| Remove content size check (compaction) - it destroys content | 5 | 5 | 2 | 1 | **7** |
| Downgrade content Readiness Gate to warn-only | 4 | 4 | 2 | 1 | **5** |
| Remove 6 non-production gate files (6,000+ lines) | 2 | 5 | 1 | 2 | **4** |
| Downgrade PPT Build Quality formatting checks to warn | 3 | 3 | 2 | 1 | **3** |
| Downgrade Readiness Gate (make soft-gate permanent) | 3 | 3 | 2 | 1 | **3** |
| Downgrade PPT Data Gate overflow check | 3 | 3 | 2 | 1 | **3** |

Priority = (Content Impact + Simplicity Gain) - Risk - Effort

---

## Critical Finding: content size check Destroys Content

The content-size-check.js `compactPayload()` function (line 295) actively trims content to character limits (500-800 chars per field) and truncates tables to 16 rows. This runs on EVERY request (server.js:1046-1061).

This is the same anti-pattern documented in mistakes.md row 37: "40+ truncate/truncateWords calls... were silently chopping AI-generated research content." The content size check is a SECOND truncation system that survived the first cleanup.

**Recommendation: Delete content-size-check.js entirely.** If overflow is a concern, handle it in the builder by shrinking fonts, not in a gate by destroying data.

---

## Gate Flow Diagram (Production Pipeline)

```
Research Data
    |
    v
[Gate 1: Research Quality] -- retry weak topics if fail
    |
    v
[Gate 2: Readiness] -- SOFT by default, hard-fail if critical/major issues
    |
    v
Synthesis
    |
    v
[Gate 3: Synthesis Quality] -- hard-fail < 40, retry 40-60
    |
    v
[Gate 4: content Readiness] -- hard-fail < 80 (BLOCKS MOST OFTEN)
    |
    v
[Gate 5: PPT Data] -- hard-fail on empty/overflow/chart issues
    |
    v
[Sanitize transient keys]
    |
    v
[Gate 6: Pre-build Structure] -- hard-fail on missing sections
    |
    v
[Gate 7: content size check] -- auto-compact (DESTROYS CONTENT)
    |
    v
PPT Generation
    |
    v
[Gate 8: Package file safety] -- normalize IDs, fix content types, verify
    |
    v
[Gate 9a: Build Quality] -- hard-fail on formatting failures
    |
    v
[Gate 9b: Structural Validation] -- hard-fail on min slides/size/charts
    |
    v
Email delivery
```

**9 gates, 9 points of failure, each can waste a $20-30 run.**

After this audit's recommendations:
- 5 hard-fail gates remain (Gates 1, 3, 6, 8, 9b)
- 4 become warn-only (Gates 2, 4, 5, 9a)
- 1 removed (Gate 7 - content size check)
- 6 non-production files removed (~6,000 lines)
