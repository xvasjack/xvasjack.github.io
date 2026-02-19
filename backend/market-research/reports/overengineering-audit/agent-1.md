# Overengineering Audit - Agent 1: File Assessment & Complexity Hotspot Map

**Generated**: 2026-02-15
**Scope**: `/backend/market-research/` (66,975 lines across 67 JS files)
**Methodology**: Full source read of all files >500 lines; header+export read of all smaller files.

---

## Part 1: Per-File Assessment

### Legend
- **LOC**: Lines of code
- **Complexity**: Estimated cyclomatic complexity (L=low <10, M=medium 10-30, H=high 30-60, VH=very high >60)
- **Exports**: Number of publicly exported functions/constants
- **Contribution**: What value it adds (content quality, formatting, validation, infrastructure)
- **Deps**: Key dependencies (other files in this service it imports from)

---

### Source Files (non-test)

| File | LOC | Complexity | Exports | Category | Contribution | Deps |
|------|-----|-----------|---------|----------|-------------|------|
| research-engine.js | 7407 | VH | 17 | CORE-CONTENT | Pipeline orchestration, all synthesis, review/deepen loops, gap filling, story architect | ai-clients, research-agents, research-framework, quality-gates, schema-firewall, content-quality-engine, content-coherence-checker, context-fit-agent, transient-key-sanitizer |
| deck-builder-single.js | 7620 | VH | 2 (+7 test) | FORMATTING | PPT slide generation for single-country reports | ppt-utils (68 imports), pptx-validator, theme-normalizer, template-clone-postprocess, transient-key-sanitizer, template-contract-compiler, header-footer-drift-diagnostics |
| ppt-utils.js | 3011 | H | 67 | FORMATTING | Shared PPT helpers: truncation, tables, charts, layout, template patterns | template-contract-compiler, ai-clients |
| content-quality-check.js | 2275 | H | 28 | GATE/VALIDATION | Deep content analysis: contradiction detection, anti-shallow checks, decision-usefulness, readiness gate | (standalone) |
| preflight-gates.js | 1934 | H | 14 | GATE/VALIDATION | 14 preflight gates (dirty tree, exports, signatures, template contract, route geometry, schema, file safety, regression, stress, compatibility, sparse slide, source coverage, real output, formatting audit) | template-contract-compiler, route-geometry-enforcer, schema-firewall, pptx-file safety-pipeline, regression-tests, stress-lab, pptx-validator, source-coverage-reporter, validate-real-output |
| stress-lab.js | 1711 | H | 8 | GATE/VALIDATION | Enhanced stress testing with 7 mutation classes, 300+ seeds, phase telemetry | stress-test-harness |
| server.js | 1558 | H | 3 | INFRASTRUCTURE | Express server, API endpoints, pipeline orchestration, diagnostics | research-orchestrator, research-framework, ppt-single-country, ppt-multi-country, quality-gates, schema-firewall, budget-gate, perf-profiler, post-run-summary, ops-runbook, pptx-validator, content-quality-engine, source-lineage-enforcer, content-coherence-checker |
| stress-test-harness.js | 1556 | H | 12 | GATE/VALIDATION | Original stress test: seeded PRNG, base payloads, mutation framework | ppt-single-country, quality-gates, schema-firewall |
| regression-tests.js | 1506 | H | 6 | GATE/VALIDATION | Regression test suite with golden baselines | golden-baseline-manager, ppt-single-country, quality-gates |
| research-agents.js | 1405 | H | 9 | CORE-CONTENT | 6 specialized research agents + universalResearchAgent | ai-clients |
| deck-file-check.js | 1354 | H | 11 | GATE/VALIDATION | PPTX structural validation using JSZip (relationship targets, package consistency, slide IDs) | (standalone, uses JSZip) |
| golden-baseline-manager.js | 1351 | M | 15 | GATE/VALIDATION | Fixture loading, baseline snapshotting, drift detection | (standalone) |
| template-contract-compiler.js | 1116 | M | 8 | FORMATTING | Parses template-patterns.json into BLOCK_TEMPLATE_PATTERN_MAP, slide maps, table/chart contexts | (standalone) |
| ops-runbook.js | 1082 | M | 10 | INFRASTRUCTURE | Executable ops runbook: triage, validation, debugging CLI | pptx-validator, ppt-single-country, quality-gates |
| research-framework.js | 1080 | M | 7 | CORE-CONTENT | 26 hardcoded fallback topics, dynamic framework generation, request reading | ai-clients |
| deck-builder.js | 1062 | H | 1 | FORMATTING | Multi-country PPT generation (wraps ppt-single-country) | ppt-single-country, ppt-utils, pptx-validator, theme-normalizer |
| extract-template-complete.js | 1055 | M | 4 | INFRASTRUCTURE | Extracts template patterns from base PPTX file | (standalone, uses JSZip) |
| schema-firewall.js | 990 | M | 8 | GATE/VALIDATION | Schema validation, coercion, quarantine, trust-scoring for synthesis output | (standalone) |
| quality-gates.js | 913 | M | 12 | GATE/VALIDATION | Inter-stage validation: research quality, synthesis quality, PPT data readiness | (standalone) |
| route-geometry-enforcer.js | 824 | M | 6 | FORMATTING | Validates PPT block content types match slide geometry expectations | template-contract-compiler |
| story-flow-check.js | 589 | M | 4 | GATE/VALIDATION | Cross-section coherence: numeric/factual mismatches, timeline inconsistencies | ai-clients |
| ai-clients.js | 592 | L | 7 | CORE-CONTENT | Gemini API wrappers (flash, research, pro), cost tracking, budget guardrails, retry | (standalone) |
| post-run-summary.js | 568 | L | 3 | INFRASTRUCTURE | Auto-generates structured summary after pipeline run | perf-profiler |
| perf-profiler.js | 547 | M | 8 | INFRASTRUCTURE | Stage timing/memory profiling, parallelism recommendations | (standalone) |
| build-template-patterns.js | 517 | M | 2 | INFRASTRUCTURE | Regenerates template-patterns.json from base PPTX | (standalone, uses JSZip) |
| source-lineage-enforcer.js | 531 | M | 5 | GATE/VALIDATION | Claim-to-source mapping, fake source detection, source quality classification | (standalone) |
| failure-cluster-analyzer.js | 522 | M | 5 | GATE/VALIDATION | Clusters stress test failures by error signature, causal stage, mutation class | (standalone) |
| template-fill.js | 484 | M | 3 | FORMATTING | Post-processes cloned template slides | (standalone) |
| pptx-file safety-pipeline.js | 469 | M | 3 | GATE/VALIDATION | End-to-end PPTX file safety checks | pptx-validator |
| header-footer-drift-diagnostics.js | 415 | M | 3 | FORMATTING | Detects header/footer position drift across slides | (standalone) |
| content-size-check.js | 390 | L | 4 | GATE/VALIDATION | Pre-build budget analyzer: field char limits, table dimensions, chart data points | (standalone) |
| reliability-digest.js | 376 | L | 5 | INFRASTRUCTURE | Generates reliability reports from stress lab + gate telemetry | failure-cluster-analyzer |
| chart-quality-gate.js | 336 | L | 3 | GATE/VALIDATION | Chart data validation: numeric ranges, label sanity, axis limits | (standalone) |
| chart-data-normalizer.js | 334 | L | 4 | FORMATTING | Normalizes chart data inputs: unit conversion, missing value handling | (standalone) |
| context-fit-agent.js | 292 | L | 2 | CORE-CONTENT | LLM-based context fitting / text compression | ai-clients |
| source-coverage-reporter.js | 246 | L | 2 | GATE/VALIDATION | Reports how many claims have source citations | (standalone) |
| validate-real-output.js | 246 | L | 2 | GATE/VALIDATION | Validates actual PPT output against expectations | ppt-single-country |
| test-fix-loop.js | 215 | L | 1 | INFRASTRUCTURE | Automated test-fix iteration loop | (standalone) |
| validate-output.js | 168 | L | 2 | GATE/VALIDATION | Basic output validation | (standalone) |
| cleanup-temp-fields.js | 142 | L | 4 | INFRASTRUCTURE | Detects/removes transient keys from synthesis output | (standalone) |
| repair-pptx.js | 141 | L | 2 | FORMATTING | Repairs broken PPTX files (relationship fixup) | (standalone, uses JSZip) |
| theme-normalizer.js | 87 | L | 2 | FORMATTING | Normalizes PPTX theme XML to match template | (standalone) |

### Test Files

| File | LOC | Category |
|------|-----|----------|
| golden-baseline-drift.test.js | 1148 | TEST |
| chart-data-file safety.test.js | 1248 | TEST |
| template-style match-hardening.test.js | 1077 | TEST |
| reliability-observability.test.js | 973 | TEST |
| preflight-hardening.test.js | 946 | TEST |
| test-ppt-generation.js | 929 | TEST |
| fixture-quality.test.js | 886 | TEST |
| source-lineage.test.js | 873 | TEST |
| content-depth.test.js | 831 | TEST |
| content-readiness-check.test.js | 820 | TEST |
| test-vietnam-research.js | 778 | TEST |
| operator-automation.test.js | 775 | TEST |
| header-footer-drift-diagnostics.test.js | 752 | TEST |
| route-geometry-enforcer.test.js | 740 | TEST |
| stress-lab.test.js | 626 | TEST |
| schema-firewall.test.js | 533 | TEST |
| content-quality-check.test.js | 462 | TEST |
| pptx-file safety-pipeline.test.js | 444 | TEST |
| perf-profiler.test.js | 420 | TEST |
| formatting-audit-strict.test.js | 387 | TEST |
| real-output-gate.test.js | 361 | TEST |
| preflight-gates.test.js | 350 | TEST |
| regression-persistence.test.js | 349 | TEST |
| line-width-signature.test.js | 341 | TEST |
| template-contract-compiler.test.js | 309 | TEST |
| template-contract-unification.test.js | 301 | TEST |
| strict-geometry-enforcement.test.js | 299 | TEST |

---

## Part 2: Complexity Hotspot Map

### Category Totals

| Category | Files | LOC | % of Total |
|----------|-------|-----|-----------|
| CORE-CONTENT | 6 | 11,376 | 17.0% |
| FORMATTING | 12 | 15,098 | 22.5% |
| GATE/VALIDATION | 18 | 16,232 | 24.2% |
| INFRASTRUCTURE | 9 | 4,752 | 7.1% |
| TEST | 27 | 19,517 | 29.1% |
| **Total** | **67** | **66,975** | **100%** |

### The Imbalance

Content quality is the stated #1 priority, yet:
- **CORE-CONTENT**: 11,376 lines (17%) -- the thing that matters most
- **FORMATTING**: 15,098 lines (22.5%) -- secondary priority by business definition
- **GATE/VALIDATION**: 16,232 lines (24.2%) -- gates that check things, not improve them
- **TEST**: 19,517 lines (29.1%) -- tests for the gates, not the content

For every 1 line of content-quality code, there are 1.3 lines of formatting code and 1.4 lines of validation code. The validation+test infrastructure (35,749 lines, 53.4%) exceeds all production code combined.

### Top 10 Complexity Hotspots

Ranked by complexity-to-value ratio (highest overengineering first):

| Rank | File | LOC | Category | Why It's a Hotspot |
|------|------|-----|----------|-------------------|
| 1 | deck-builder-single.js | 7620 | FORMATTING | Largest file in codebase, handles ALL PPT building in one monolith. 450 lines of inline XML audit, 135-line geometry guard, duplicated utils, 6200-line main function |
| 2 | preflight-gates.js | 1934 | GATE/VALIDATION | 14 gates across 3 modes with CLI, report gen, readiness scoring. Many gates call other large modules (stress-lab, regression-tests, route-geometry-enforcer) |
| 3 | stress-lab.js + stress-test-harness.js | 3267 | GATE/VALIDATION | Two overlapping stress test frameworks. stress-lab extends stress-test-harness but both are maintained separately. Combined 3267 lines |
| 4 | content-quality-check.js | 2275 | GATE/VALIDATION | Standalone deep analysis module with parsers, contradiction detection, anti-shallow, readiness gate. Much of this overlaps with quality-gates.js |
| 5 | golden-baseline-manager.js | 1351 | GATE/VALIDATION | Fixture loading, snapshotting, drift detection for golden baselines. Supports the gate infrastructure, not content |
| 6 | deck-file-check.js | 1354 | GATE/VALIDATION | Validates internal PPTX ZIP structure (relationship targets, package consistency, slide IDs). Defense-in-depth for a library (pptxgenjs) that should produce valid files |
| 7 | ppt-utils.js | 3011 | FORMATTING | 67 exports. Chart functions (addStackedBarChart, addLineChart, addBarChart, addPieChart) are ~400 lines of near-identical patterns. Contains an LLM call (buildStoryNarrative) that belongs in orchestrator |
| 8 | schema-firewall.js | 990 | GATE/VALIDATION | Full schema validation + coercion + quarantine + trust-scoring. Validates synthesis output that the AI prompt should produce correctly |
| 9 | route-geometry-enforcer.js | 824 | FORMATTING | Validates PPT block content types vs slide geometry. 824 lines of type-checking that could be a lookup table |
| 10 | research-engine.js | 7407 | CORE-CONTENT | The most important file, but also has complexity debt: 5-tier fallback chain (300 lines), 100-line key canonicalization with regex heuristics, duplicated utilities, 1150-line main pipeline function |

---

## Part 3: File Categorization

### CORE-CONTENT (6 files, 11,376 lines)
Files that directly improve research quality, content depth, or insight generation.

| File | LOC | Notes |
|------|-----|-------|
| research-engine.js | 7407 | Central pipeline. Contains the synthesis logic, review/deepen loops, story architect, gap filling. THE most critical file |
| research-agents.js | 1405 | 6 specialized agents + universalResearchAgent. Prompt templates, web research calls |
| research-framework.js | 1080 | Dynamic framework generation (25 topics per industry/country), fallback topics, request reading |
| ai-clients.js | 592 | Clean Gemini wrappers. Cost tracking, retry logic. Well-structured |
| context-fit-agent.js | 292 | LLM-based text compression to fit slide space constraints |
| server.js (partial) | ~600 | Pipeline orchestration portion of server.js (rest is infrastructure) |

### FORMATTING (12 files, 15,098 lines)
Files that control PPT layout, template compliance, chart building, styling.

| File | LOC | Notes |
|------|-----|-------|
| deck-builder-single.js | 7620 | All single-country PPT building. One enormous function plus inline audit |
| ppt-utils.js | 3011 | 67 shared helpers. Repetitive chart code. Duplicated string utils |
| deck-builder.js | 1062 | Multi-country PPT (wraps single-country) |
| template-contract-compiler.js | 1116 | Parses template-patterns.json into runtime maps |
| route-geometry-enforcer.js | 824 | Type-checks blocks vs slide geometry |
| template-fill.js | 484 | Post-processes cloned template slides |
| header-footer-drift-diagnostics.js | 415 | Detects header/footer position drift |
| chart-data-normalizer.js | 334 | Normalizes chart data inputs |
| repair-pptx.js | 141 | Repairs broken PPTX relationship targets |
| theme-normalizer.js | 87 | Normalizes theme XML |

### GATE/VALIDATION (18 files, 16,232 lines)
Files that validate, check, or gate outputs. They detect problems but do not fix them.

| File | LOC | Notes |
|------|-----|-------|
| content-quality-check.js | 2275 | Deep content analysis (contradiction, anti-shallow, readiness) |
| preflight-gates.js | 1934 | 14 preflight gates with CLI and reporting |
| stress-lab.js | 1711 | Enhanced stress testing framework |
| stress-test-harness.js | 1556 | Original stress testing framework |
| regression-tests.js | 1506 | Regression test suite |
| deck-file-check.js | 1354 | PPTX structural validation |
| golden-baseline-manager.js | 1351 | Golden baseline management |
| schema-firewall.js | 990 | Schema validation and trust-scoring |
| quality-gates.js | 913 | Inter-stage quality gates |
| story-flow-check.js | 589 | Cross-section coherence |
| source-lineage-enforcer.js | 531 | Claim-source mapping and fake source detection |
| failure-cluster-analyzer.js | 522 | Clusters stress test failures |
| pptx-file safety-pipeline.js | 469 | End-to-end PPTX file safety |
| content-size-check.js | 390 | Pre-build budget limits |
| chart-quality-gate.js | 336 | Chart data validation |
| source-coverage-reporter.js | 246 | Source citation coverage |
| validate-real-output.js | 246 | Validates actual output |
| validate-output.js | 168 | Basic output validation |

### INFRASTRUCTURE (9 files, 4,752 lines)
Files that support operations, tooling, profiling, or build processes.

| File | LOC | Notes |
|------|-----|-------|
| server.js (infra portion) | ~958 | Express setup, email, diagnostics endpoints |
| ops-runbook.js | 1082 | Executable ops runbook |
| extract-template-complete.js | 1055 | Template pattern extraction tool |
| post-run-summary.js | 568 | Post-run auto-summary |
| perf-profiler.js | 547 | Stage timing/memory profiling |
| build-template-patterns.js | 517 | Template pattern build tool |
| reliability-digest.js | 376 | Reliability reporting |
| test-fix-loop.js | 215 | Automated test-fix loop |
| cleanup-temp-fields.js | 142 | Transient key detection (clean, focused) |

### DEAD-WEIGHT (potential)
No file is entirely dead, but several have significant dead-weight sections:

| File | Dead Section | LOC Wasted | Reason |
|------|-------------|-----------|--------|
| deck-builder-single.js | auditGeneratedPptFormatting (inline XML parsing) | ~450 | Should be in a separate audit module, not in the builder |
| deck-builder-single.js | Duplicated ensureString, normalizePptTextGlyphs, stripInvalidSurrogates | ~45 | Copy-pasted from ppt-utils.js |
| ppt-utils.js | Duplicated ensureString, normalizePptTextGlyphs, stripInvalidSurrogates | ~45 | Canonical copy, but deck-builder-single.js has its own |
| research-engine.js | Duplicated runInBatches | ~50 | Also in research-agents.js |
| research-engine.js | Duplicated parsePositiveIntEnv / parseNonNegativeIntEnv | ~30 | Also in server.js |
| stress-test-harness.js | Entire file | 1556 | Superseded by stress-lab.js which extends it, but both are maintained |

---

## Part 4: Hotspot Details with Scoring

### Scoring Key
- **Content impact** (1-5): How much would simplifying this improve content quality? 5 = frees up significant tokens/effort for content.
- **Simplicity gain** (1-5): How much simpler would the codebase become? 5 = massive reduction in complexity.
- **Risk** (1-5): How likely is this change to break production? 5 = very risky.
- **Effort** (1-5): How much work to simplify? 5 = weeks of work.
- **Priority** = (Content impact + Simplicity gain) - Risk - Effort. Higher = do first.

---

### Hotspot 1: deck-builder-single.js is a 7620-line monolith

**File**: `deck-builder-single.js:1403-7607`
**What it does**: `generateSingleCountryPPT` is a single function spanning ~6200 lines. It builds every slide type (policy, market, competitors, depth, summary, charts, tables, insights) in one imperative sequence. Contains inline normalization (alias maps at lines 493-706), inline audit (auditGeneratedPptFormatting at lines 840-1289), and duplicated utilities (lines 159-203).
**Why it's overengineered**: A 6200-line function is unmaintainable. Every change risks breaking unrelated slides. The inline XML audit (450 lines) should be a separate module. The alias maps duplicate canonicalization logic from research-engine.js. The function does building AND validation AND normalization AND auditing.
**Simpler alternative**: Break into per-section builders (buildPolicySlides, buildMarketSlides, buildCompetitorSlides, etc.) each ~300-500 lines. Extract auditGeneratedPptFormatting to its own module. Remove duplicated string utils.

| Metric | Score |
|--------|-------|
| Content impact | 2 |
| Simplicity gain | 5 |
| Risk | 4 |
| Effort | 4 |
| **Priority** | **-1** |

---

### Hotspot 2: 14-gate preflight system

**File**: `preflight-gates.js:1-1934`
**What it does**: Runs 14 separate preflight checks before release: dirty tree, HEAD content, module exports, function signatures, template contract, route geometry, schema firewall, file safety pipeline, regression tests, stress tests, schema compatibility, sparse slide, source coverage, real output validation, formatting audit. Three gate modes (dev/test/release). CLI with report generation.
**Why it's overengineered**: 14 gates is excessive for a service with 1 user. Gates like "dirty tree" and "HEAD content" are CI concerns, not service concerns. The gate system orchestrates 9 other large modules (stress-lab, regression-tests, route-geometry-enforcer, etc.), creating a 20,000+ line dependency tree for a single pre-deploy check. Many gates overlap (e.g., schema-firewall AND schema-compatibility, formatting-audit AND template-contract).
**Simpler alternative**: Collapse to 4 gates: (1) lint/format, (2) unit tests, (3) integration smoke test, (4) output validation. Let CI handle the rest. Remove the 3-mode system.

| Metric | Score |
|--------|-------|
| Content impact | 3 |
| Simplicity gain | 5 |
| Risk | 2 |
| Effort | 3 |
| **Priority** | **3** |

---

### Hotspot 3: Duplicate stress test frameworks

**File**: `stress-lab.js:1-1711` and `stress-test-harness.js:1-1556`
**What it does**: Two stress testing frameworks. stress-test-harness.js is the original (seeded PRNG, base payloads, 6 mutation types). stress-lab.js is the "enhanced" version (7 mutation classes, 300+ seeds, phase telemetry) that imports from and extends the harness. Combined 3267 lines.
**Why it's overengineered**: Two frameworks for the same purpose. stress-lab.js was built on top of stress-test-harness.js but didn't replace it. Both are maintained independently. The original harness is 1556 lines of infrastructure for generating mutated payloads -- for a service that runs at most a few times per day. 300+ seeds is overkill when each run costs $20-30.
**Simpler alternative**: Merge into one file. Use 10-20 seeds maximum. Drop the phase telemetry and failure-cluster-analyzer (522 lines) -- just log failures.

| Metric | Score |
|--------|-------|
| Content impact | 3 |
| Simplicity gain | 4 |
| Risk | 1 |
| Effort | 2 |
| **Priority** | **4** |

---

### Hotspot 4: content quality engine doing what prompts should do

**File**: `content-quality-check.js:1-2275`
**What it does**: 28 exported functions for deep content analysis: parseDealEconomics (extracts IRR, payback, CAPEX from text), parseEntryStrategy, parsePartnerAssessment, validateInsightStructure, contradiction detection (extractClaims, fuzzySubjectMatch, checkContradictions, checkCrossSectionContradictions), anti-shallow checks (detectFactDump, detectMacroPadding, detectEmptyCalories, detectConsultantFiller), decision-usefulness scoring, evidence grounding, readiness gate.
**Why it's overengineered**: This is 2275 lines of post-hoc code trying to validate what the AI should have produced correctly in the first place. The parseDealEconomics function (100 lines of regex) extracts financial metrics that the synthesis prompt should return in structured format. The anti-shallow checks detect "consultant filler" and "empty calories" that better prompts would not produce. The contradiction detection (350 lines) catches cross-section inconsistencies that a single coherent synthesis pass would avoid.
**Simpler alternative**: Invest those 2275 lines of effort into better synthesis prompts with structured output schemas. Keep a lightweight readiness gate (~200 lines) that checks completeness, not semantics. Let the LLM do the content work -- it's better at it.

| Metric | Score |
|--------|-------|
| Content impact | 5 |
| Simplicity gain | 4 |
| Risk | 3 |
| Effort | 3 |
| **Priority** | **3** |

---

### Hotspot 5: Schema firewall guarding against the AI's own output

**File**: `schema-firewall.js:1-990`
**What it does**: Defines full schema (type helpers, section schemas for policy/market/competitors/depth/summary), validates synthesis output, coerces types, quarantines invalid fields, assigns trust scores per field. Legacy key mapping. Action ledger for every field (kept/coerced/dropped/quarantined).
**Why it's overengineered**: 990 lines of runtime schema validation for data produced by prompts this codebase controls. The trust-scoring and quarantine system (fields get "quarantined" with a trust score) adds complexity without fixing the root cause: if the AI produces bad data, the fix is the prompt, not a firewall. The coercion logic silently transforms bad data into "acceptable" data, masking prompt quality issues.
**Simpler alternative**: Use a JSON schema validator (ajv, ~5 lines) to check structure. Fix prompts when validation fails. Remove trust scoring and quarantine -- data is either valid or it triggers a re-synthesis.

| Metric | Score |
|--------|-------|
| Content impact | 4 |
| Simplicity gain | 3 |
| Risk | 3 |
| Effort | 2 |
| **Priority** | **2** |

---

### Hotspot 6: 5-tier synthesis fallback chain

**File**: `research-engine.js:2075-2372`
**What it does**: `synthesizeWithFallback` implements 5 tiers of increasingly desperate attempts to get valid JSON from the AI: (1) Gemini 3 Flash with full prompt, (2) retry with simplified prompt, (3) Gemini 3 Pro with simplified prompt, (4) minimal prompt with Pro, (5) honest fallback (hardcoded placeholder). Each tier has its own prompt construction, JSON parsing, validation, and error handling.
**Why it's overengineered**: 300 lines for what is essentially "call AI, parse JSON, retry if broken." The 5 tiers create maintenance burden -- every change to synthesis prompts must consider all tiers. Tiers 3-4 use Gemini Pro at higher cost. Tier 5 (honest fallback) produces placeholder content that the product explicitly wants to avoid. In practice, if Gemini Flash fails twice and Pro fails once, the content is probably unsalvageable -- more retries won't help.
**Simpler alternative**: 2 tiers: (1) Flash with structured JSON output mode (Gemini supports this), (2) Pro with structured JSON output mode. If both fail, skip the section and flag it. Remove tier 5 entirely -- placeholder content is worse than missing content.

| Metric | Score |
|--------|-------|
| Content impact | 4 |
| Simplicity gain | 3 |
| Risk | 2 |
| Effort | 2 |
| **Priority** | **3** |

---

### Hotspot 7: PPTX validator defending against pptxgenjs bugs

**File**: `deck-file-check.js:1-1354`
**What it does**: Opens the generated PPTX as a ZIP file and validates: relationship targets (no dangling refs), package consistency (no duplicate IDs), slide non-visual IDs (uniqueness), content types (all parts registered). Also reconciles content types and normalizes relationship targets.
**Why it's overengineered**: 1354 lines of validating that a third-party library (pptxgenjs) produces valid output. If pptxgenjs has bugs, the fix should be upstream patches or library replacement, not a 1354-line post-hoc validator. The reconciliation logic (normalizing targets, deduping IDs) means the validator is silently fixing bugs, making them invisible.
**Simpler alternative**: If pptxgenjs produces invalid PPTX, switch to python-pptx (more mature) or report bugs upstream. Keep a 50-line smoke test that opens the ZIP and checks slide count. Remove the reconciliation -- if the file is broken, re-generate it.

| Metric | Score |
|--------|-------|
| Content impact | 2 |
| Simplicity gain | 3 |
| Risk | 2 |
| Effort | 2 |
| **Priority** | **1** |

---

### Hotspot 8: Repetitive chart functions in ppt-utils.js

**File**: `ppt-utils.js:1255-1918`
**What it does**: Four chart functions (addStackedBarChart, addLineChart, addBarChart, addPieChart) each ~100 lines. Each function: validates data, normalizes labels, handles empty data fallback, sets axis formatting, applies colors, positions the chart. The validation/fallback patterns are nearly identical across all four.
**Why it's overengineered**: ~400 lines of repetitive code. Each chart function re-implements the same validation pattern (check if data exists, check if labels exist, check if numbers are finite, provide fallback data). The axis formatting is copy-pasted with minor variations.
**Simpler alternative**: One `addChart(type, data, options)` function (~150 lines) with a type parameter. Shared validation. Type-specific config via lookup table.

| Metric | Score |
|--------|-------|
| Content impact | 1 |
| Simplicity gain | 2 |
| Risk | 2 |
| Effort | 1 |
| **Priority** | **0** |

---

### Hotspot 9: Key canonicalization regex heuristics

**File**: `research-engine.js:1506-1614`
**What it does**: `canonicalizeMarketSectionKey` -- 100+ lines of regex patterns that map AI-generated section keys to canonical names. Examples: `/^market\s*size/i` -> `marketSize`, `/^growth.*forecast/i` -> `growthForecast`, `/entry.*barrier/i` -> `entryBarriers`. Similar alias maps exist in deck-builder-single.js (lines 493-706): MARKET_CANONICAL_ALIAS_MAP, POLICY_ALIAS_MAP, COMPETITOR_ALIAS_MAP, DEPTH_ALIAS_MAP.
**Why it's overengineered**: ~300 combined lines of regex heuristics to normalize keys the AI should produce correctly. The alias maps are duplicated between orchestrator and PPT builder. Each new AI model or prompt change can break these patterns, requiring more regex patches.
**Simpler alternative**: Use Gemini's structured output mode (JSON schema) to enforce exact key names at generation time. No canonicalization needed. Remove all alias maps.

| Metric | Score |
|--------|-------|
| Content impact | 4 |
| Simplicity gain | 3 |
| Risk | 2 |
| Effort | 2 |
| **Priority** | **3** |

---

### Hotspot 10: Golden baseline manager + failure cluster analyzer

**File**: `golden-baseline-manager.js:1-1351` and `failure-cluster-analyzer.js:1-522`
**What it does**: golden-baseline-manager loads fixtures, snapshots baselines, detects drift between runs. failure-cluster-analyzer clusters stress test failures by error signature, causal pipeline stage, and mutation class. Combined 1873 lines of test infrastructure.
**Why it's overengineered**: Golden baselines assume deterministic output from an LLM-based pipeline, which is inherently non-deterministic. The failure clustering (error signature extraction, causal analysis) is sophisticated tooling for a stress test that itself may be overkill (see Hotspot 3). 1873 lines of meta-testing infrastructure.
**Simpler alternative**: Simple fixture files (JSON) loaded with `require()`. No drift detection -- just update fixtures when the schema changes. Remove failure clustering -- just grep the error log.

| Metric | Score |
|--------|-------|
| Content impact | 2 |
| Simplicity gain | 3 |
| Risk | 1 |
| Effort | 1 |
| **Priority** | **3** |

---

### Hotspot 11: Code duplication across files

**File**: Multiple files
**What it does**:
- `ensureString`, `normalizePptTextGlyphs`, `stripInvalidSurrogates`: duplicated in deck-builder-single.js (lines 159-203) AND ppt-utils.js (lines 1-46)
- `runInBatches`: duplicated in research-engine.js (lines 109-145) AND research-agents.js
- `parsePositiveIntEnv`, `parseNonNegativeIntEnv`: duplicated in research-engine.js AND server.js
- Key canonicalization: duplicated in research-engine.js (canonicalizeMarketSectionKey) AND deck-builder-single.js (alias maps)
**Why it's overengineered**: Textbook code duplication. Each copy evolves independently, causing subtle bugs when one is updated but not the other.
**Simpler alternative**: Move shared utils to `shared/utils.js` (which already exists). Single source of truth.

| Metric | Score |
|--------|-------|
| Content impact | 2 |
| Simplicity gain | 2 |
| Risk | 1 |
| Effort | 1 |
| **Priority** | **2** |

---

### Hotspot 12: Overlapping review loops in orchestrator

**File**: `research-engine.js:5121-5865`
**What it does**: Three sequential review stages: (1) review-deepen (reviews research, identifies weak areas, does targeted re-research), (2) iterative refinement (re-synthesizes sections that fail quality gates), (3) final review (LLM-based review that checks for contradictions, shallow content, missing data). Each has stagnation detection.
**Why it's overengineered**: Three review loops is excessive. The final review (LLM call) catches the same issues as content-quality-check.js and quality-gates.js. The iterative refinement re-calls synthesizeWithFallback (which itself has 5 tiers). Combined with the gap-filling stage earlier in the pipeline, there are 4 separate "try to improve content" stages. Each one adds latency and cost.
**Simpler alternative**: One review stage: (1) synthesize, (2) check quality with a lightweight gate, (3) if below threshold, re-synthesize once with the quality feedback injected into the prompt. No stagnation detection needed if you only retry once.

| Metric | Score |
|--------|-------|
| Content impact | 5 |
| Simplicity gain | 4 |
| Risk | 3 |
| Effort | 3 |
| **Priority** | **3** |

---

### Hotspot 13: Ops runbook as executable code

**File**: `ops-runbook.js:1-1082`
**What it does**: An executable CLI that helps triage errors, validate local setup, and run debugging playbooks. Contains 15+ error patterns with root causes and fix steps, plus playbooks for common scenarios (ppt-repair, quality-debug, stress-run).
**Why it's overengineered**: 1082 lines of operational tooling for a service with 1 operator. The error patterns and fix steps are documentation masquerading as code. The playbooks shell out to other scripts. This could be a markdown file.
**Simpler alternative**: A markdown file with error patterns and fix commands. Copy-paste the commands when needed.

| Metric | Score |
|--------|-------|
| Content impact | 1 |
| Simplicity gain | 2 |
| Risk | 1 |
| Effort | 1 |
| **Priority** | **1** |

---

### Hotspot 14: Route geometry enforcer

**File**: `route-geometry-enforcer.js:1-824`
**What it does**: For each PPT block, validates that the content type (table, chart, text, list) matches what the template slide geometry expects. Checks row counts, column counts, chart data point counts against template constraints.
**Why it's overengineered**: 824 lines of type-checking at the boundary between synthesis and building. The builder (deck-builder-single.js) already handles mismatches by falling back to simpler layouts. This is pre-checking what the builder will handle anyway.
**Simpler alternative**: Let the builder handle mismatches (it already does). If a block doesn't fit, the builder truncates or simplifies. Remove this module entirely.

| Metric | Score |
|--------|-------|
| Content impact | 1 |
| Simplicity gain | 2 |
| Risk | 2 |
| Effort | 1 |
| **Priority** | **0** |

---

## Priority Summary (sorted highest to lowest)

| Priority | Hotspot | Action |
|----------|---------|--------|
| **4** | #3: Duplicate stress test frameworks | Merge into one, reduce seeds to 10-20 |
| **3** | #2: 14-gate preflight system | Collapse to 4 gates, let CI handle the rest |
| **3** | #4: content quality engine | Replace with better prompts + 200-line readiness check |
| **3** | #6: 5-tier synthesis fallback | Reduce to 2 tiers with structured output mode |
| **3** | #9: Key canonicalization regex | Use Gemini structured output to enforce key names |
| **3** | #10: Golden baseline + failure cluster | Replace with simple JSON fixtures |
| **3** | #12: Overlapping review loops | Collapse to single review-retry |
| **2** | #5: Schema firewall | Replace with ajv + prompt fixes |
| **2** | #11: Code duplication | Move to shared/utils.js |
| **1** | #7: PPTX validator | Reduce to 50-line smoke test |
| **1** | #13: Ops runbook | Convert to markdown |
| **0** | #8: Repetitive chart functions | Consolidate to single addChart() |
| **0** | #14: Route geometry enforcer | Remove entirely |
| **-1** | #1: deck-builder-single.js monolith | High effort/risk, defer until formatting is a priority |

---

## Key Insight

The codebase has **inverted the effort pyramid**. The stated priority is content quality, but the codebase spends 3x more lines on checking/validating/formatting than on actually producing good content. The validation layer (gates, firewalls, enforcers, analyzers) exists because the content layer is not trusted to produce correct output -- but the fix for that is better prompts and structured output schemas, not more post-hoc validation code.

**Estimated lines removable/simplifiable**: ~15,000-20,000 (22-30% of total) by implementing the above changes, with zero content quality regression and likely content quality improvement from reinvesting effort into prompts.
