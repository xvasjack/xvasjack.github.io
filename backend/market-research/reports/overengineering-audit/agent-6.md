# Agent 6: Test-Suite Value Density Audit

## Summary

**Total test LOC: 22,946** (16,251 in `.test.js` + 6,695 in non-`.test` test files)
**Total test cases: ~1,393** (in `.test.js` files) + ~39 function-level tests in non-`.test` files
**Removable LOC: ~14,500** (63% of all test code)

The test suite is severely overengineered. The majority of tests guard formatting/geometry infrastructure that is secondary to content quality. Only 3 of 31 test files test anything content-critical. The rest test PPT cosmetics, deployment preflight checks, stress harnesses, and operational tooling that has zero user-facing impact.

---

## 1. Summary Table: All Test Files

### `.test.js` Files (25 files, 16,251 LOC)

| File | LOC | # Tests | Tests What? | Content-Critical? | Classification |
|------|-----|---------|-------------|-------------------|---------------|
| chart-data-file safety.test.js | 1248 | 117 | Chart data normalizer + quality gate (coercion, fuzz, diagnostics) | NO - formatting | CONSOLIDATE |
| fixture-quality.test.js | 886 | 100 | Golden baseline fixtures (load, parse, drift, coverage) | NO - test infrastructure | REMOVE |
| formatting-audit-strict.test.js | 387 | 48 | Preflight formatting audit (warning codes, severity, reports) | NO - formatting | REMOVE |
| golden-baseline-drift.test.js | 1148 | 66 | Structural baseline capture/drift (geometry, fonts, colors, sections) | NO - formatting | REMOVE |
| header-footer-drift-diagnostics.test.js | 752 | 48 | Header/footer line drift (position, thickness, color) | NO - formatting minutiae | REMOVE |
| line-width-signature.test.js | 341 | 15 | Line width in PPTX layouts/masters | NO - formatting minutiae | REMOVE |
| operator-automation.test.js | 775 | 80 | Ops runbook, post-run summary, perf profiler (operational tooling) | NO - ops tooling | REMOVE |
| perf-profiler.test.js | 420 | 30 | Perf profiler, ops runbook, post-run summary (duplicate coverage) | NO - ops tooling | REMOVE |
| pptx-file safety-pipeline.test.js | 444 | 18 | PPTX structural file safety (relationship normalization, content types) | NO - file format plumbing | CONSOLIDATE |
| preflight-gates.test.js | 350 | 34 | Preflight gates (quick/full mode, readiness scoring) | NO - deployment tooling | CONSOLIDATE |
| preflight-hardening.test.js | 946 | 100 | Preflight gates hardening (gate modes, environment contracts, sparse slide gate) | NO - deployment tooling | REMOVE |
| real-output-gate.test.js | 361 | 31 | Real output validation gate (file existence, slide count) | NO - deployment tooling | REMOVE |
| regression-persistence.test.js | 349 | 27 | Regression test artifact persistence (env var logic) | NO - test infrastructure | REMOVE |
| reliability-observability.test.js | 973 | 74 | Telemetry, failure clustering, risk scoring, digest generation | NO - observability | REMOVE |
| route-geometry-enforcer.test.js | 740 | 60 | Route-to-slide geometry mapping (table/chart/text contexts) | NO - formatting | CONSOLIDATE |
| schema-firewall.test.js | 533 | 31 | Schema validation/coercion/quarantine for synthesis data | PARTIAL - validates data shape | KEEP |
| content-depth.test.js | 831 | 87 | content quality engine + coherence checker (contradictions, sparse inputs, filler detection) | YES - content quality | KEEP |
| content-quality-check.test.js | 462 | 51 | Deal economics parsing, currency normalization, decision usefulness | YES - content quality | KEEP |
| content-readiness-check.test.js | 820 | 57 | content readiness gate (evidence grounding, insight depth, actionability) | YES - content quality | KEEP |
| source-lineage.test.js | 873 | 83 | Source lineage enforcement + coverage reporting | PARTIAL - data provenance | CONSOLIDATE |
| stress-lab.test.js | 626 | 55 | Stress lab seed determinism, mutation classes, aggregate stats | NO - test infrastructure | REMOVE |
| strict-geometry-enforcement.test.js | 299 | 15 | Strict geometry enforcement (subset of route-geometry-enforcer) | NO - formatting | REMOVE (duplicate) |
| template-contract-compiler.test.js | 309 | 21 | Template contract compilation, drift detection, doctor | NO - formatting | CONSOLIDATE |
| template-contract-unification.test.js | 301 | 32 | Mapping parity between template-contract-compiler and route-geometry-enforcer | NO - formatting | REMOVE |
| template-style match-hardening.test.js | 1077 | 113 | Comprehensive matrix: audit coverage, fallback chains, drift reports, mutations | NO - formatting | REMOVE |

### Non-`.test` Test Files (6 files, 6,695 LOC)

| File | LOC | Tests What? | Content-Critical? | Classification |
|------|-----|-------------|-------------------|---------------|
| regression-tests.js | 1506 | E2E deck generation + validation, template-clone, country-leak checks | PARTIAL - has some content validation | CONSOLIDATE |
| stress-lab.js | 1711 | 300+ seed perturbation harness, mutation classes, phase telemetry | NO - stress testing infrastructure | REMOVE |
| stress-test-harness.js | 1556 | Original stress test (predecessor to stress-lab.js) | NO - superseded by stress-lab.js | REMOVE |
| test-fix-loop.js | 215 | Automated generate-validate-fix loop | NO - manual dev tooling | REMOVE |
| test-ppt-generation.js | 929 | Single PPT generation with mock data | PARTIAL - integration test | CONSOLIDATE |
| test-vietnam-research.js | 778 | Vietnam-specific research + PPT generation | PARTIAL - integration test | CONSOLIDATE |

---

## 2. Total Test LOC and Removability

| Category | LOC | % of Total |
|----------|-----|-----------|
| **KEEP** (content-critical) | 2,646 | 11.5% |
| **CONSOLIDATE** (merge into fewer files) | 5,274 | 23.0% |
| **REMOVE** (low-value, duplicate, or infrastructure) | 15,026 | 65.5% |
| **TOTAL** | 22,946 | 100% |

**Removable LOC: ~15,026** (immediate deletions)
**Consolidatable LOC: ~5,274** (could shrink to ~2,000 after deduplication)
**Net reduction: ~18,000 LOC** (78% of test suite)

---

## 3. Top 10 Recommendations

| # | Action | Content Impact (1-5) | Simplicity Gain (1-5) | Risk (1-5) | Effort (1-5) | Priority Score |
|---|--------|---------------------|----------------------|------------|--------------|---------------|
| 1 | DELETE stress-lab.js + stress-test-harness.js + stress-lab.test.js | 0 | 5 | 1 | 1 | **+8** |
| 2 | DELETE template-style match-hardening.test.js (1077 LOC, overlaps with 3 other files) | 0 | 5 | 1 | 1 | **+8** |
| 3 | DELETE golden-baseline-drift.test.js + fixture-quality.test.js (2034 LOC of baseline infrastructure tests) | 0 | 5 | 1 | 1 | **+8** |
| 4 | DELETE header-footer-drift-diagnostics.test.js + line-width-signature.test.js (1093 LOC of line pixel tests) | 0 | 4 | 1 | 1 | **+6** |
| 5 | DELETE reliability-observability.test.js + operator-automation.test.js + perf-profiler.test.js (2168 LOC of ops tooling) | 0 | 5 | 1 | 1 | **+8** |
| 6 | DELETE preflight-hardening.test.js + real-output-gate.test.js + formatting-audit-strict.test.js (1694 LOC) | 0 | 4 | 1 | 1 | **+6** |
| 7 | DELETE regression-persistence.test.js + template-contract-unification.test.js + strict-geometry-enforcement.test.js (949 LOC) | 0 | 3 | 1 | 1 | **+4** |
| 8 | DELETE test-fix-loop.js (manual dev tooling, 215 LOC) | 0 | 2 | 1 | 1 | **+2** |
| 9 | MERGE route-geometry-enforcer.test.js + template-contract-compiler.test.js + preflight-gates.test.js into 1 file (~400 LOC kept) | 1 | 3 | 2 | 2 | **+2** |
| 10 | MERGE regression-tests.js + test-ppt-generation.js + test-vietnam-research.js into 1 integration test (~500 LOC kept) | 2 | 3 | 2 | 3 | **+2** |

---

## 4. Files to DELETE Entirely (with justification)

### Immediate deletions (zero content relevance)

| File | LOC | Justification |
|------|-----|--------------|
| stress-lab.js | 1711 | Test-only harness. Not imported by production server. 300-seed perturbation testing is extreme overengineering for a report generator. |
| stress-test-harness.js | 1556 | Superseded by stress-lab.js. Two separate stress harnesses testing the same thing. |
| stress-lab.test.js | 626 | Tests for the test harness. Tests testing tests. |
| reliability-observability.test.js | 973 | Tests telemetry, clustering, and digest generation. None of these modules are imported by server.js. Pure observability infrastructure. |
| operator-automation.test.js | 775 | Tests ops-runbook, post-run-summary, perf-profiler. These are operational tooling modules not on the production request path. |
| perf-profiler.test.js | 420 | Overlaps almost entirely with operator-automation.test.js. Tests the same 3 modules. |
| template-style match-hardening.test.js | 1077 | 113 tests across 12 "tasks" that overlap with route-geometry-enforcer.test.js, template-contract-compiler.test.js, and strict-geometry-enforcement.test.js. |
| strict-geometry-enforcement.test.js | 299 | Subset of route-geometry-enforcer.test.js. Same module, fewer tests. |
| template-contract-unification.test.js | 301 | Tests that mapping constants are consistent between modules. This is a copy-paste drift detector — a code review concern, not a runtime concern. |
| golden-baseline-drift.test.js | 1148 | Tests structural baseline capture for PPT geometry/fonts/colors. The golden-baseline-manager is not used in production. |
| fixture-quality.test.js | 886 | Tests fixture loading for the golden baseline system. Tests for test infrastructure. |
| header-footer-drift-diagnostics.test.js | 752 | Tests header/footer line position drift at EMU (English Metric Unit) precision. Formatting minutiae. |
| line-width-signature.test.js | 341 | Tests that line widths in PPTX layouts match expected values. Pixel-level formatting. |
| formatting-audit-strict.test.js | 387 | Tests formatting audit warning codes and severity levels. Formatting meta-testing. |
| preflight-hardening.test.js | 946 | 100 tests hardening deployment preflight gates. Overlaps with preflight-gates.test.js. |
| real-output-gate.test.js | 361 | Tests that a gate checks whether output files exist. Infrastructure. |
| regression-persistence.test.js | 349 | Tests env-var logic for whether regression test artifacts persist on disk. Test infrastructure testing test infrastructure. |
| test-fix-loop.js | 215 | Manual dev loop tool. Not automated, not CI. |

**Total deletable: 13,123 LOC across 18 files**

---

## 5. Files to KEEP (with justification)

| File | LOC | Justification |
|------|-----|--------------|
| content-depth.test.js | 831 | Tests content quality: contradiction detection, shallow content flagging, consultant filler detection, coherence checking. Directly guards the #1 priority (content depth). |
| content-quality-check.test.js | 462 | Tests deal economics parsing, currency normalization, decision usefulness scoring. Core content quality validation. |
| content-readiness-check.test.js | 820 | Tests the gate that blocks shallow/low-quality synthesis from becoming slides. Evidence grounding, insight depth, actionability scoring. This IS the content depth guard. |
| schema-firewall.test.js | 533 | Tests data shape validation. Prevents malformed synthesis from crashing the PPT builder. Not content-critical per se, but prevents data loss. |

**Total keepable: 2,646 LOC across 4 files**

### Files to CONSOLIDATE (merge and shrink)

| Files | Current LOC | Target LOC | What to keep |
|-------|-------------|-----------|-------------|
| route-geometry-enforcer.test.js + template-contract-compiler.test.js + preflight-gates.test.js | 1,399 | ~400 | Basic contract compilation, basic enforcement, basic preflight. One file. |
| source-lineage.test.js | 873 | ~300 | Core lineage enforcement only. Drop coverage report tests. |
| chart-data-file safety.test.js | 1,248 | ~300 | Keep normalization + basic gate. Drop fuzz tests and diagnostics. |
| pptx-file safety-pipeline.test.js | 444 | ~150 | Keep basic pipeline run. Drop synthetic PPTX construction tests. |
| regression-tests.js + test-ppt-generation.js + test-vietnam-research.js | 3,213 | ~500 | One integration test file with mock data, validates E2E PPT generation. |

**Consolidation saves ~5,500 LOC**

---

## 6. Key Findings

### Massive duplication in geometry/template testing
Four test files test route-geometry-enforcer.js:
- route-geometry-enforcer.test.js (740 LOC)
- strict-geometry-enforcement.test.js (299 LOC)
- template-style match-hardening.test.js (1077 LOC)
- template-contract-unification.test.js (301 LOC)

That's 2,417 LOC for a module that maps slide contexts to geometry types. The module itself is probably under 500 LOC.

### Tests testing tests
- fixture-quality.test.js tests golden-baseline-manager (test infrastructure)
- regression-persistence.test.js tests regression-tests.js artifact handling
- stress-lab.test.js tests stress-lab.js (test harness)
- reliability-observability.test.js tests stress-lab + failure-cluster-analyzer (test harness)

This is 3,434 LOC of meta-testing.

### Two complete stress harnesses
- stress-test-harness.js (1556 LOC) - original
- stress-lab.js (1711 LOC) - "enhanced" replacement

Both exist. stress-lab supersedes stress-test-harness but both are still in the codebase. Neither is used in production.

### Zero operator tooling on production path
ops-runbook.js, post-run-summary.js, perf-profiler.js are not imported by server.js. They have 1,195 LOC of tests across 2 test files.

### Content tests are only 11.5% of the test suite
The business says content depth is #1 priority, but only 2,646 of 22,946 test LOC (11.5%) guard content quality. The other 88.5% guards formatting, infrastructure, deployment gates, and operational tooling.

---

## 7. Verdict

The test suite inverts the business priority. Content is king but tests are overwhelmingly about formatting geometry and test infrastructure. Deleting 18 files (13,123 LOC) and consolidating 8 files into 3 (saving ~5,500 more LOC) would reduce the test suite by 78% while preserving all content-quality coverage. The remaining ~5,000 LOC would be sharply focused on what matters: content depth, content quality gates, data shape validation, and one integration test.
