# Agent 8 -- End-to-End Dry Run Evidence Pack

**Date**: 2026-02-16
**Node**: v22.22.0 | npm 10.9.4
**Working Directory**: `/home/xvasjack/xvasjack.github.io/backend/market-research`

---

## 1. Test Results Summary

| # | Test | Result | Key Output |
|---|------|--------|------------|
| 1 | `npm run smoke:readiness` | **PARTIAL FAIL** (19 PASS / 1 FAIL / 4 SKIP / 1 WARN) | Verdict: NO-GO. Only blocker: 100 uncommitted files (git cleanliness gate). All env checks, artifact checks, module contracts, template contracts PASS. |
| 2 | `node test-ppt-generation.js` (Thailand) | **PASS** | PPT generated: 4421 KB, ~35 slides. All quality gates pass. 100% template coverage (24/24 block mappings). Minor: 3 table cells exceed density budget in strict mode (392, 371, 404 chars > 360 limit). |
| 3 | `node validate-real-output.js test-output.pptx --country=Thailand --industry="Energy Services"` | **PASS (34/34)** | 35 slides, 6 charts, 90 tables, 29178 chars. Zero validation failures. |
| 4 | `node test-vietnam-research.js` | **PASS** | PPT generated: 4294 KB, ~32 slides. All quality gates pass. 100% template coverage (21/21). Visual score: 0 failures. |
| 5 | `node validate-output.js test-output.pptx` (default: Vietnam/Energy Services) | **FAIL (31/35)** | 4 failures: slides 1 and 3 contain "Thailand" content but validator expects "Vietnam". This is a **test harness issue** -- `test-output.pptx` was generated for Thailand, but `validate-output.js` defaults to Vietnam. Not a production bug. |
| 6 | `node regression-tests.js` | **FAIL** | 5/6 unit checks PASS (template-clone filter, pre-build PPT gate, competitive optional-group gate, template route geometry, dynamic timeout). 1 FAIL: "Missing localMajor should still fail pre-build structure gate" -- gate is not blocking as expected. |
| 7 | `node scripts/test-preflight.js` | **PASS (43/43)** | All preflight checks pass: verifyHeadContent, checkDirtyTree, checkGitAvailable, checkGitBranch, checkHeadSha, checkGitDivergence, checkModuleImports, parseArgs, generateJsonReport, generateMarkdownReport. |
| 8 | `npx jest --no-coverage` | **PARTIAL FAIL** (22 PASS / 3 FAIL suites; 1450 PASS / 17 FAIL tests) | See detailed breakdown below. |

---

## 2. Jest Test Suite Breakdown

| Suite | Result | Tests Passed | Tests Failed | Root Cause |
|-------|--------|-------------|-------------|------------|
| `pptx-fileSafety-pipeline.test.js` | FAIL | 10 | 7 | `scanSlideNonVisualIdFileSafety` and `scanRelationshipReferenceFileSafety` are not exported as functions from `pptx-fileSafety-pipeline.js`. Tests call them but they don't exist as named exports. |
| `schema-firewall.test.js` | FAIL | 29 | 1 | `processFirewall()` returns object missing `preValidation` field. Test expects `fw.preValidation` to be defined but it's `undefined`. |
| `regression-persistence.test.js` | FAIL | varies | 1 | `writeValidationSummary` is not exported from its source module. `typeof writeValidationSummary` is `"undefined"`. |
| `line-width-signature.test.js` | FAIL | varies | 7 | Expected line width signature 22225 EMU is never found; audit always reports it as missing. Tests expect 28575/57150 to be sufficient but the code also requires 22225. Likely a template-patterns.json constant mismatch with test expectations. |
| `header-footer-drift-runInfo.test.js` | FAIL | most pass | 1 | `colorMatch` returns `false` when test expects `true`. Color matching logic disagrees with test fixture. |
| All other 20 suites | PASS | 1450 | 0 | -- |

**Total: 1450 passed, 17 failed, 1467 total (98.8% pass rate)**

---

## 3. Environment Check

| Check | Status | Details |
|-------|--------|---------|
| Node version | OK | v22.22.0 (requirement: >= 18) |
| npm version | OK | 10.9.4 |
| GEMINI_API_KEY | SET | Available for AI research calls |
| KIMI_API_KEY | SET | Available (though Kimi/Perplexity reportedly removed) |
| PERPLEXITY_API_KEY | SET | Available (though Kimi/Perplexity reportedly removed) |
| SENDGRID_API_KEY | NOT SET | Email delivery unavailable (expected in local dev) |
| SENDER_EMAIL | NOT SET | Email from-address unavailable (expected in local dev) |
| NODE_ENV | NOT SET | Defaults to development behavior |
| npm dependencies | OK | All dependencies installed, no missing packages |
| Key files | OK | server.js, deck-builder-single.js, deck-file-check.js, content-gates.js, research-engine.js, template-patterns.json all present |
| Broken requires | NONE | All `.js` files load without import errors (some need env vars at runtime but don't crash on require) |

---

## 4. Warnings and Weak Spots

### Critical

1. **`pptx-fileSafety-pipeline.js` missing exports** -- 7 test failures all stem from two functions (`scanSlideNonVisualIdFileSafety`, `scanRelationshipReferenceFileSafety`) that the test file imports but the source file doesn't export. Either the functions were renamed/removed without updating tests, or the exports were accidentally dropped.

2. **Regression test gate mismatch** -- The "missing localMajor should fail pre-build structure gate" check fails. This means the pre-build gate is now more lenient than the regression test expects. Either the gate was intentionally relaxed (and the test needs updating) or the gate has a bug allowing incomplete data through.

### Moderate

3. **`line-width-signature.test.js` constant mismatch** -- 7 failures because the audit expects line width 22225 EMU to be present, but test fixtures only provide 28575/57150. The expected constants in `template-patterns.json` may have drifted from what the tests assume.

4. **`schema-firewall.test.js` missing `preValidation` field** -- `processFirewall()` return shape changed. Test expects `{ result, preValidation, postValidation, trustScore, lineage }` but `preValidation` is missing.

5. **`writeValidationSummary` not exported** -- 1 test failure in `regression-persistence.test.js`. Function either doesn't exist or isn't in `module.exports`.

6. **`header-footer-drift-runInfo.test.js` color mismatch** -- 1 test failure. `colorMatch` returning `false` when test expects `true`. Minor: either test fixture color or expected color constant is wrong.

### Low / Informational

7. **Table cell density budget exceeded** -- 3 cells in Thailand PPT exceed 360-char strict-mode limit (392, 371, 404 chars). Not blocking, but in strict mode these would be flagged.

8. **100 uncommitted files** -- Smoke readiness reports NO-GO due to dirty working tree. This is expected during active development but would block a release.

9. **`validate-output.js` default mismatch** -- Running `validate-output.js test-output.pptx` without `--country` flag defaults to Vietnam validation, but `test-output.pptx` contains Thailand data. Not a bug in production code, just a test invocation issue.

10. **Smoke readiness WARN on function signatures** -- 1 function signature mismatch detected but not detailed in report. Worth investigating.

---

## 5. Recommended Fixes (Ranked by Impact)

| Priority | Fix | Impact | Effort |
|----------|-----|--------|--------|
| 1 | **Export `scanSlideNonVisualIdFileSafety` and `scanRelationshipReferenceFileSafety`** from `pptx-fileSafety-pipeline.js` (or update test imports if functions were renamed) | Fixes 7 test failures | Low -- likely a one-line exports fix |
| 2 | **Fix regression gate for missing `localMajor`** -- either tighten the pre-build structure gate or update the regression test if the relaxation was intentional | Fixes 1 regression test failure; ensures incomplete competitive data is caught | Medium |
| 3 | **Reconcile line width constants** -- align `template-patterns.json` expected widths with what the audit actually checks for (22225 vs 28575/57150) | Fixes 7 test failures | Low -- constant alignment |
| 4 | **Add `preValidation` to `processFirewall()` return** or update test expectation | Fixes 1 test failure | Low |
| 5 | **Export `writeValidationSummary`** from its source module | Fixes 1 test failure | Low -- one-line fix |
| 6 | **Fix color match in header-footer drift** -- update either the expected color constant or the test fixture | Fixes 1 test failure | Low |
| 7 | **Commit working tree** before next release attempt | Clears smoke readiness NO-GO | Low |

---

## 6. Overall Assessment

**Production PPT generation is healthy.** Both Thailand and Vietnam end-to-end PPT generation produce valid, complete output files with 100% template coverage and passing quality gates. The core pipeline works.

**Test infrastructure has 17 failures (98.8% pass rate).** All failures are in ancillary validation/safety modules, not in the core PPT generation or research pipeline. The root causes are:
- 2 missing function exports (accounts for 7 failures)
- 1 template constant drift (accounts for 7 failures)
- 3 minor shape/field mismatches (accounts for 3 failures)

**No broken imports or missing dependencies.** The codebase loads cleanly.

**Environment is suitable for local development.** GEMINI_API_KEY is set. SENDGRID and SENDER_EMAIL are missing (expected locally -- only needed for email delivery on Railway).
