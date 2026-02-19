# Agent 7: User Journey / API Simplification Audit

## 1. API Endpoint Map

| Endpoint | Method | Purpose | Production Use | Verdict |
|----------|--------|---------|----------------|---------|
| `/health` | GET | Platform health check (Railway probe) | YES - required | KEEP |
| `/api/market-research` | POST | Main pipeline trigger (prompt + email) | YES - the only user endpoint | KEEP |
| `/api/costs` | GET | Returns costTracker JSON | DEV/OPS only | EXTRACT to ops script |
| `/api/diagnostics` | GET | Returns lastRunDiagnostics | DEV/OPS only | EXTRACT to ops script |
| `/api/latest-ppt` | GET | Download last generated PPT buffer | DEV/QA only | EXTRACT to ops script |

**Findings:** Only 5 endpoints total. `/api/market-research` is the only production-facing endpoint. The other 3 non-health endpoints (`/api/costs`, `/api/diagnostics`, `/api/latest-ppt`) store state in global variables (`costTracker`, `lastRunDiagnostics`, `lastGeneratedPpt`) and are purely for operator debugging. They hold state from only the last run and have race conditions with concurrent requests (acknowledged in code comments).

---

## 2. Primary Path Diagram

```
USER: POST /api/market-research { prompt, email }
  |
  v
[1] readRequestType(userPrompt)                         -- research-framework.js (LLM call: Gemini)
  |   Extracts: industry, targetMarkets[], clientContext, projectType, focusAreas
  v
[2] FOR EACH country (batches of 2):
  |   researchCountry(country, industry, clientContext, scope)   -- research-engine.js
  |     |
  |     v
  |   [2a] generateResearchFramework(scope)         -- research-framework.js (LLM call: Gemini)
  |     |   Returns: ~25 topics in ~6 categories with search queries
  |     v
  |   [2b] universalResearchAgent(category, topics) -- research-agents.js (LLM calls: Gemini Search)
  |     |   Runs in batches of CFG_DYNAMIC_AGENT_CONCURRENCY
  |     |   Each topic: web search via callGeminiResearch
  |     v
  |   [2c] REVIEW-DEEPEN LOOP (up to N iterations)  -- orchestrator
  |     |   reviewResearch() -> identifyGaps -> deepenResearch() -> merge
  |     |   Stagnation detection, plateau exit, best-snapshot tracking
  |     v
  |   [2d] STORY ARCHITECT                          -- orchestrator
  |     |   buildStoryPlan() -- LLM call to plan narrative arc
  |     v
  |   [2e] PER-SECTION SYNTHESIS (sequential)       -- orchestrator
  |     |   synthesizePolicy() -> synthesizeMarket() -> synthesizeCompetitors()
  |     |   -> synthesizeSummary()
  |     |   Each: LLM call via callGemini with massive system prompts
  |     v
  |   [2f] validateContentDepth()                   -- quality-gates.js (code-only, no LLM)
  |     |   If score < 30: re-research + re-synthesize weak sections
  |     v
  |   [2g] ITERATIVE REFINEMENT LOOP (up to N iters) -- orchestrator
  |     |   identifyResearchGaps() (LLM) -> fillResearchGaps() -> reSynthesize()
  |     |   Multiple confidence scoring heuristics
  |     v
  |   [2h] FINAL REVIEW LOOP (up to N iters)        -- orchestrator
  |     |   finalReviewSynthesis() (LLM) -> applyFinalReviewFixes() (LLM)
  |     |   With: verification passes, reviewer noise detection,
  |     |   clean snapshot tracking, escalation budgets
  |     v
  |   [2i] Readiness scoring (code-only)
  |     |   confidenceScore, codeGateScore, effectiveScore,
  |     |   finalReviewCoherence -- 5+ scoring dimensions
  |
  v
[3] QUALITY GATE 1: validateResearchQuality()       -- server.js (code-only)
  |   Retry up to 5 weak topics per country (2min timeout)
  v
[4] READINESS GATE (in server.js)                   -- ~100 lines of branching
  |   Checks: effective>=80, content-depth>=80, coherence>=80
  |   Branches: draftPptMode bypass, soft gate, hard fail
  v
[5] synthesizeFindings()                            -- orchestrator (for multi-country comparison)
  v
[6] QUALITY GATE 2: validateSynthesisQuality()      -- quality-gates.js
  |   If <40: abort. If <60: retry with boosted tokens
  v
[7] QUALITY GATE 2b: contentReadinessCheck()        -- content-quality-check.js (2275 lines)
  |   + checkStoryFlow()                            -- story-flow-check.js (589 lines)
  v
[8] QUALITY GATE 3: validatePptData()               -- quality-gates.js
  |   Per-country PPT data completeness check
  v
[9] sanitizeTransientKeys()                         -- cleanup-temp-fields.js
  v
[10] collectPreRenderStructureIssues()              -- server.js (~200 lines of schema validation)
  v
[11] runBudgetGate()                                -- content-size-check.js (390 lines)
  |   Payload budget analysis and field compaction
  v
[12] generatePPT()                                  -- deck-builder.js -> deck-builder-single.js
  v
[13] POST-PPT HARDENING (3 passes):
  |   normalizeAbsoluteRelationshipTargets()
  |   normalizeSlideNonVisualIds()
  |   reconcileContentTypesAndPackage()
  |   scanRelationshipTargets() -- file safety check
  |   scanPackageConsistency() -- consistency check
  v
[14] PPT METRICS GATES (~60 lines):
  |   Failure rate, formatting audit, template coverage,
  |   table recovery, geometry issues, strict mode
  v
[15] QUALITY GATE 4: validatePPTX()                 -- deck-file-check.js (1354 lines)
  |   Structural validation: min slides, charts, tables, forbidden text, etc.
  v
[16] sendEmail(to, subject, pptx attachment)        -- shared/email.js
```

**Total LLM calls per country (estimated):** ~48 (documented in MEMORY.md)
**Total quality gates in server.js alone:** 7 distinct gates + 3 PPT hardening passes
**Total quality loops in orchestrator:** 3 nested loops (review-deepen, refinement, final review)

---

## 3. Unnecessary Complexity

### 3.1 Dead Code Path: Fallback 6-Agent System
- `researchCountry()` line 5878: `const useDynamicFramework = true;`
- The entire `else` branch (lines 5973-6041) with 6 specialized agents (policyResearchAgent, marketResearchAgent, etc.) is **dead code** -- unreachable because useDynamicFramework is hardcoded to true.
- These 6 agents in `research-agents.js` (1405 lines) are only reachable from this dead path.

### 3.2 Three Nested Review/Refinement Loops
Inside `researchCountry()` there are **three** sequential iterative loops, each with its own LLM calls:
1. **Review-Deepen Loop** (lines 6043-6188): review -> deepen -> merge, with stagnation detection, gap signature tracking, plateau detection, best-snapshot tracking, sharp-regression revert
2. **Iterative Refinement Loop** (lines 6392-6415+): identifyResearchGaps -> fillResearchGaps -> reSynthesize, with confidence scoring
3. **Final Review Loop** (lines ~6600-6947): finalReviewSynthesis -> applyFinalReviewFixes, with verification passes, reviewer noise detection, clean snapshot tracking, escalation budgets (research + synthesis)

Each loop has 5-10 exit conditions and multiple state variables. Combined, these represent ~1000 lines of loop control logic.

### 3.3 Excessive Quality Gates in server.js (7 gates)
After `researchCountry` returns (which already ran 3 internal loops), `server.js` runs:
1. validateResearchQuality + retry
2. Readiness gate (effective/coherence/critical/major/openGaps)
3. validateSynthesisQuality + retry with boosted tokens
4. contentReadinessCheck + checkStoryFlow
5. validatePptData
6. Pre-build structure check
7. content size check

Many of these re-check things the orchestrator already validated. The readiness gate in server.js (lines 730-822 = ~90 lines) rechecks scores that `researchCountry` already computed.

### 3.4 PPT Post-Processing Over-Hardening
After `generatePPT()`, the pipeline runs 5 separate XML-level repair/normalization passes:
- normalizeAbsoluteRelationshipTargets
- normalizeSlideNonVisualIds
- reconcileContentTypesAndPackage
- scanRelationshipTargets
- scanPackageConsistency

Then 60+ lines of metrics-based gates (failure rate, formatting audit, template coverage, geometry, strict mode). These are defensive against bugs in the PPT generator itself.

### 3.5 server.js is a 1558-line God Object
- Lines 138-514: ~376 lines of canonical key definitions, gate helper functions, and schema validation functions
- These belong in dedicated modules (quality-gates.js already exists)
- `runMarketResearch` is 900+ lines long

### 3.6 Configuration Explosion
- 11 env-var-controlled config values in server.js
- 33 env-var-controlled config values in research-engine.js
- Total: **44 env vars** controlling pipeline behavior
- Many have complex interdependencies (e.g., SOFT_READINESS_GATE interacts with HARD_FAIL_MIN_EFFECTIVE_SCORE)

### 3.7 synthesizeSingleCountry is Dead Code
- `synthesizeSingleCountry()` (lines 7022-7270, ~250 lines) is exported but never called by the production path
- Contains a massive 4500+ char system prompt

---

## 4. Auxiliary Systems Assessment

### Files NOT imported by production code (server.js dependency tree)

| File | Lines | Purpose | Verdict |
|------|-------|---------|--------|
| ops-runbook.js | 1082 | CLI triage/debug tool | KEEP as standalone script |
| post-run-summary.js | 568 | Post-run reporting | REMOVE (never used in production) |
| reliability-digest.js | 376 | Stress lab digest generation | REMOVE (testing only) |
| source-coverage-reporter.js | 246 | Source coverage scoring | REMOVE (testing only) |
| source-lineage-enforcer.js | 531 | Source claim tracking | REMOVE (testing only) |
| failure-cluster-analyzer.js | 522 | Failure pattern clustering | REMOVE (testing only) |
| stress-lab.js | 1711 | Stress test harness | EXTRACT to scripts/ |
| stress-test-harness.js | 1556 | Stress test runner | EXTRACT to scripts/ |
| golden-baseline-manager.js | 1351 | Baseline fixture management | EXTRACT to scripts/ |
| perf-profiler.js | 547 | Performance metrics store | REMOVE (unused in prod) |
| context-fit-agent.js | 292 | Unused agent | REMOVE |
| repair-pptx.js | 141 | Standalone PPTX repair | EXTRACT to scripts/ |
| validate-output.js | 168 | Output validation CLI | EXTRACT to scripts/ |
| validate-real-output.js | 246 | Real output validation CLI | EXTRACT to scripts/ |
| test-ppt-generation.js | 929 | PPT generation test | EXTRACT to scripts/ |
| test-vietnam-research.js | 778 | Vietnam-specific test | EXTRACT to scripts/ |
| test-fix-loop.js | 215 | Fix loop test | EXTRACT to scripts/ |
| build-template-patterns.js | 517 | Template pattern extraction | EXTRACT to scripts/ |
| extract-template-complete.js | 1055 | Full template extraction | EXTRACT to scripts/ |
| theme-normalizer.js | 87 | Theme normalization | CHECK if imported by PPT chain |

**Total non-production lines:** ~11,918 lines sitting alongside production code

### Test Files in Root (should be in __tests__/)

| File | Lines |
|------|-------|
| chart-data-file safety.test.js | 1248 |
| fixture-quality.test.js | 886 |
| formatting-audit-strict.test.js | 387 |
| golden-baseline-drift.test.js | 1148 |
| header-footer-drift-diagnostics.test.js | 752 |
| line-width-signature.test.js | 341 |
| operator-automation.test.js | 775 |
| perf-profiler.test.js | 420 |
| pptx-file safety-pipeline.test.js | 444 |
| preflight-gates.test.js | 350 |
| preflight-hardening.test.js | 946 |
| real-output-gate.test.js | 361 |
| regression-persistence.test.js | 349 |
| reliability-observability.test.js | 973 |
| route-geometry-enforcer.test.js | 740 |
| schema-firewall.test.js | 533 |
| content-depth.test.js | 831 |
| content-quality-check.test.js | 462 |
| content-readiness-check.test.js | 820 |
| source-lineage.test.js | 873 |
| strict-geometry-enforcement.test.js | 299 |
| stress-lab.test.js | 626 |
| template-contract-compiler.test.js | 309 |
| template-contract-unification.test.js | 301 |
| template-style match-hardening.test.js | 1077 |

**Total test lines in root:** ~14,221 lines (should be in `__tests__/`)

### scripts/ Directory
6 scripts, all for release/preflight/smoke testing. Appropriate location.

### Production Module Sizes

| File | Lines | Role |
|------|-------|------|
| research-engine.js | 7407 | Core pipeline logic |
| deck-builder-single.js | 7620 | PPT slide generation |
| ppt-utils.js | 3011 | PPT helper functions |
| content-quality-check.js | 2275 | content readiness gate |
| preflight-gates.js | 1934 | Preflight gate logic |
| server.js | 1558 | HTTP server + pipeline runner |
| regression-tests.js | 1506 | Regression test suite |
| deck-file-check.js | 1354 | PPTX XML validation |
| research-agents.js | 1405 | Research agents (mostly dead) |
| template-contract-compiler.js | 1116 | Template contract |
| deck-builder.js | 1062 | Multi-country PPT wrapper |
| research-framework.js | 1080 | Framework generation |

**Total codebase:** 66,975 lines across all .js files in root

---

## 5. Dependency Assessment

```json
{
  "cors": "^2.8.5",           // KEEP - standard
  "dotenv": "^16.6.1",        // KEEP - standard
  "express": "^4.18.2",       // KEEP - standard
  "express-rate-limit": "^7.1.5", // KEEP - security
  "helmet": "^7.1.0",         // KEEP - security
  "node-fetch": "^2.7.0",     // KEEP - HTTP client for Gemini
  "pptxgenjs": "^4.0.1"       // KEEP - core PPT generation
}
```

**Dependencies are lean.** Only 7 production deps. No bloat here.

---

## 6. Top 10 Simplification Recommendations

Scoring: Content impact (1-5), Simplicity gain (1-5), Risk (1-5), Effort (1-5)
Priority = (Content + Simplicity) - Risk - Effort. Higher is better.

| # | Recommendation | Content | Simplicity | Risk | Effort | Priority |
|---|---------------|---------|-----------|------|--------|----------|
| 1 | **Delete dead fallback path**: Remove `useDynamicFramework=true` guard, delete 6 specialized agents (policyResearchAgent etc.), remove dead else branch in researchCountry | 0 | 5 | 1 | 1 | +3 |
| 2 | **Delete synthesizeSingleCountry**: 250 lines, exported but never called in production | 0 | 3 | 1 | 1 | +1 |
| 3 | **Merge 3 review loops into 1**: Review-Deepen + Iterative Refinement + Final Review all do the same thing (score -> find gaps -> research -> re-synthesize). Unify into a single loop with configurable exit criteria | 3 | 5 | 3 | 4 | +1 |
| 4 | **Consolidate quality gates**: server.js runs 7 gates that overlap with orchestrator's internal checks. Merge redundant readiness/depth checks into a single post-research gate | 2 | 5 | 3 | 3 | +1 |
| 5 | **Move 376 lines of gate helpers out of server.js**: Canonical key definitions, gate text collectors, chart data finders -- move to quality-gates.js where they belong | 0 | 4 | 1 | 2 | +1 |
| 6 | **Move test files to `__tests__/`**: 25 test files (14,221 lines) sitting in root alongside production code | 0 | 3 | 1 | 2 | 0 |
| 7 | **Move non-production JS files to scripts/tools/**: 12+ utility/test scripts (11,918 lines) in root | 0 | 3 | 1 | 2 | 0 |
| 8 | **Reduce env var config surface**: 44 env vars is unmaintainable. Group into 3-4 "mode" presets (conservative, balanced, aggressive) with 5-6 override vars max | 1 | 4 | 2 | 3 | 0 |
| 9 | **Simplify PPT post-processing**: 5 XML-level repair passes + metrics gates suggests the PPT generator has structural bugs. Fix the generator instead of post-hoc repair | 3 | 4 | 4 | 4 | -1 |
| 10 | **Remove non-production auxiliary modules from deployment**: ops-runbook, post-run-summary, reliability-digest, stress-lab, perf-profiler etc. don't need to be deployed to Railway | 0 | 2 | 1 | 2 | -1 |

---

## 7. Key Metrics Summary

| Metric | Value |
|--------|-------|
| Production endpoints | 1 (POST /api/market-research) |
| Debug/ops endpoints | 3 |
| Total production JS files (imported by server.js tree) | ~18 |
| Total non-production JS files in root | ~27 |
| Lines of production code | ~35,000 |
| Lines of test/tool code in root | ~26,000 |
| Quality gates (server.js) | 7 |
| Iterative loops (orchestrator) | 3 nested |
| LLM calls per country | ~48 |
| Environment variables controlling pipeline | 44 |
| Dead code (confirmed unreachable) | ~1,700 lines (6 agents + synthesizeSingleCountry + fallback path) |
| Dependencies | 7 (lean) |

## 8. Critical Insight

The pipeline has a **single API endpoint** but **15+ internal stages** with **3 nested review loops** and **7 quality gates**. The complexity is not in the API surface -- it is in the internal pipeline orchestration. The most impactful simplification is merging the 3 review loops into 1 unified loop, which would cut ~1000 lines of loop control logic, reduce LLM calls (currently the same data gets reviewed by 3 different loop mechanisms), and make the pipeline behavior predictable.

The second biggest win is deleting confirmed dead code: the 6 specialized agents, synthesizeSingleCountry, and the fallback path -- ~1,700 lines that deploy to Railway, consume memory, but never execute.
