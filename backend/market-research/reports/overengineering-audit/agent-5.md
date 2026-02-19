# Agent 5: Formatting-Enforcement Right-Sizing Audit

## Scope
Classify every formatting/validation module as STRUCTURAL file safety (keep), COSMETIC ENFORCEMENT (downgrade/remove), or DEV TOOLING (remove from production).

## Module Inventory

| # | Module | File | LOC | What It Enforces | Structural vs Cosmetic | Classification |
|---|--------|------|-----|------------------|----------------------|----------------|
| 1 | Route Geometry Enforcer | `route-geometry-enforcer.js` | 824 | Validates that PPT blocks target slides whose geometry supports the content type (table/chart/text). Provides fallback chains. | Cosmetic (layout routing). Never called in prod. | REMOVE (dead code) |
| 2 | Header/Footer Drift Diagnostics | `header-footer-drift-diagnostics.js` | 415 | Scans generated PPTX for header/footer line position drift from template ground truth. Diagnostics only -- does NOT fix anything. | Cosmetic (line position deltas in EMU). Logs warnings, writes report files to disk. | DOWNGRADE to optional debug |
| 3 | Theme Normalizer | `theme-normalizer.js` | 87 | Rewrites theme1.xml inside PPTX to match template colors and fonts (Segoe UI). | Structural (theme XML file safety) + Cosmetic (exact color values). | KEEP (small, prevents theme corruption) |
| 4 | Chart Data Normalizer | `chart-data-normalizer.js` | 334 | Validates/coerces chart payloads (categories, series, values). | Structural (prevents chart build crashes). | KEEP but note: NOT imported by any prod file. Only used by chart-quality-gate.js which is also dead. |
| 5 | Chart Quality Gate | `chart-quality-gate.js` | 336 | Scores chart data quality 0-100, rejects below threshold. | Cosmetic (quality scoring). | REMOVE (dead code -- not imported by prod) |
| 6 | PPTX Validator | `deck-file-check.js` | 1354 | ZIP file safety, XML validity, relationship targets, Content_Types reconciliation, non-visual ID normalization, package consistency checks. | STRUCTURAL (prevents corrupt PPTX). Used by server.js, deck-builder-single.js, deck-builder.js. | KEEP |
| 7 | PPTX file safety Pipeline | `pptx-file safety-pipeline.js` | 469 | 4-stage pipeline: rel target norm, non-visual ID norm, Content_Types reconciliation, rel reference file safety. | Structural. But NOT imported by production code (only ops-runbook.js + test). | REMOVE from prod (dev/ops tool) |
| 8 | Template Clone Postprocess | `template-fill.js` | 484 | Clones template slide XML into generated slides, replaces text tokens, patches chart relationships. | STRUCTURAL (ensures slides match template XML structure). Used by deck-builder-single.js. | KEEP |
| 9 | Repair PPTX | `repair-pptx.js` | 141 | CLI tool: normalizes IDs, reconciles Content_Types, validates. Has `main()` with `process.argv`. | Dev/ops CLI tool. No production import. | MOVE to scripts/ |
| 10 | Transient Key Sanitizer | `cleanup-temp-fields.js` | 142 | Strips AI synthesis artifacts (section_0, _wasArray, gap_1, deepen, etc.) from research data before building. | STRUCTURAL (prevents garbage keys from becoming slide content). Used by server.js, research-engine.js, deck-builder-single.js. | KEEP |
| 11 | Build Template Patterns | `build-template-patterns.js` | 517 | Offline script: transforms template-extracted.json into template-patterns.json. | Dev build tool. No production import. | MOVE to scripts/ |
| 12 | Extract Template Complete | `extract-template-complete.js` | 1055 | Offline script: extracts every formatting property from template PPTX. Hardcodes path to Escort template. | Dev build tool. No production import. | MOVE to scripts/ |
| 13 | Template Contract Compiler | `template-contract-compiler.js` | 1116 | Exports block-to-pattern mappings (BLOCK_TEMPLATE_PATTERN_MAP, BLOCK_TEMPLATE_SLIDE_MAP) + offline CLI functions (compile, drift, doctor, auditCoverage). | Mixed: Constants = STRUCTURAL (used by ppt-utils + ppt-single-country). Functions = Dev tooling (never called at runtime). | SPLIT: extract constants to simple JSON/module; move CLI functions to scripts/ |
| 14 | Template Patterns JSON | `template-patterns.json` | 64705 | Ground truth formatting data: positions, colors, fonts, chart styles, per-slide element geometry for all 34 template slides. | Data file. Loaded at module init by ppt-utils, route-geometry-enforcer, header-footer-drift-diagnostics, template-contract-compiler. | KEEP but PRUNE (most per-element detail is unused at runtime) |
| 15 | Context Fit Agent | `context-fit-agent.js` | 292 | Fits text tokens into template slide slots during clone postprocess. | STRUCTURAL (content placement). Used by template-fill.js. | KEEP |
| 16 | ppt-utils.js (formatting parts) | `ppt-utils.js` | ~3011 | Color constants, position constants, truncation functions, fitTextToShape, chart helpers, section dividers, table helpers. All driven by template-patterns.json. | Mixed: text sanitization + chart building = STRUCTURAL. Color constants + position constants = COSMETIC but harmless (just `const` declarations). | KEEP (actively used everywhere) |

### Summary Counts

| Classification | Modules | Total LOC |
|---------------|---------|-----------|
| KEEP (structural, actively used) | theme-normalizer, pptx-validator, template-clone-postprocess, transient-key-sanitizer, context-fit-agent, ppt-utils | 5,370 |
| KEEP but split/prune | template-contract-compiler (constants only ~200 LOC needed), template-patterns.json (could prune ~50K lines) | 65,821 -> ~15,000 after prune |
| REMOVE (dead production code) | route-geometry-enforcer, chart-quality-gate | 1,160 |
| DOWNGRADE to optional | header-footer-drift-diagnostics | 415 |
| MOVE to scripts/ (dev tools, not runtime) | pptx-file safety-pipeline, repair-pptx, build-template-patterns, extract-template-complete | 2,182 |
| REMOVE from prod (dead, only test-imported) | chart-data-normalizer (if chart-quality-gate removed) | 334 |

**Total LOC removable/movable from production: ~4,091 LOC of JS + ~50,000 lines from template-patterns.json pruning**

---

## Top 10 Recommendations

Scoring: Content Impact (1-5), Simplicity Gain (1-5), Risk (1-5), Effort (1-5)
**Priority = (Content + Simplicity) - Risk - Effort** (higher = do first)

### 1. Remove route-geometry-enforcer.js from production

| Metric | Score |
|--------|-------|
| Content Impact | 1 (zero -- never called) |
| Simplicity Gain | 4 (824 LOC of dead code + complex fallback chains) |
| Risk | 1 (not imported by any production file) |
| Effort | 1 (delete file, delete test files) |
| **Priority** | **+3** |

**What:** Delete `route-geometry-enforcer.js`. It exports `enforce()`, `enforceStrict()`, `auditAllRoutes()` etc. but is only imported by test files (`*.test.js`). Zero production callers.

**Risk:** None. Already dead code.

**Rollback:** `git revert` the deletion commit.

---

### 2. Remove chart-quality-gate.js and chart-data-normalizer.js from production

| Metric | Score |
|--------|-------|
| Content Impact | 1 (zero -- never called in prod) |
| Simplicity Gain | 3 (670 LOC of dead code) |
| Risk | 1 (not imported by any production file) |
| Effort | 1 (delete files, delete test files) |
| **Priority** | **+2** |

**What:** `chart-quality-gate.js` (336 LOC) is not imported by any production module. `chart-data-normalizer.js` (334 LOC) is only imported by chart-quality-gate.js. Both are dead code chains.

**Risk:** None. Only test files reference them.

**Rollback:** `git revert`.

---

### 3. Move dev/ops CLI tools out of production root

| Metric | Score |
|--------|-------|
| Content Impact | 1 (not runtime) |
| Simplicity Gain | 4 (removes 2,182 LOC from prod confusion) |
| Risk | 1 (not imported at runtime) |
| Effort | 2 (move files, update any script references) |
| **Priority** | **+2** |

**What:** Move these to `scripts/` directory:
- `repair-pptx.js` (141 LOC) -- CLI tool with `process.argv`
- `build-template-patterns.js` (517 LOC) -- offline builder
- `extract-template-complete.js` (1055 LOC) -- offline extractor
- `pptx-file safety-pipeline.js` (469 LOC) -- only used by ops-runbook.js

**Risk:** Minimal. Update `ops-runbook.js` require path. No production impact.

**Rollback:** Move files back.

---

### 4. Downgrade header-footer-drift-diagnostics to opt-in debug mode

| Metric | Score |
|--------|-------|
| Content Impact | 2 (drift warnings add noise to logs, never block generation) |
| Simplicity Gain | 3 (415 LOC + disk I/O for report writing) |
| Risk | 2 (loses drift visibility, but drift is cosmetic) |
| Effort | 2 (gate behind env var, remove disk writes) |
| **Priority** | **+1** |

**What:** Currently called on every generation (`scanHeaderFooterDrift` at line 1238 of deck-builder-single.js). It scans every slide for header/footer line position drift, logs warnings, and writes a JSON report to disk. This is diagnostics-only -- it never fixes or blocks anything.

Change: Guard behind `ENABLE_DRIFT_DIAGNOSTICS=true` env var (default: off). Remove the `writeHeaderFooterDriftReport()` disk write entirely. Keep the scan available for debugging.

**Risk:** Lose early warning if header/footer lines drift. Acceptable because the team manually polishes decks anyway.

**Rollback:** Set `ENABLE_DRIFT_DIAGNOSTICS=true`.

---

### 5. Split template-contract-compiler.js: extract constants, move functions to scripts/

| Metric | Score |
|--------|-------|
| Content Impact | 1 |
| Simplicity Gain | 4 (reduce 1116 LOC module to ~200 LOC constants file) |
| Risk | 2 (must verify all imports still resolve) |
| Effort | 3 (refactor imports in ppt-utils.js, deck-builder-single.js, route-geometry-enforcer) |
| **Priority** | **0** |

**What:** Production only uses the constants: `BLOCK_TEMPLATE_PATTERN_MAP`, `BLOCK_TEMPLATE_SLIDE_MAP`, `TABLE_TEMPLATE_CONTEXTS`, `CHART_TEMPLATE_CONTEXTS`, `SECTION_DIVIDER_TEMPLATE_SLIDES`. The functions (`compile()`, `drift()`, `doctor()`, `auditCoverage()`, `checkSparseContent()`, `generateDriftReport()`, `verifyMappingParity()`, `assertMappingParity()`) are CLI/dev tooling only.

Split into: `template-constants.js` (constants, ~200 LOC) + `scripts/template-contract-tools.js` (functions, ~900 LOC).

**Risk:** Medium. Multiple files import from template-contract-compiler. Must update all require paths. Test thoroughly.

**Rollback:** `git revert`.

---

### 6. Prune template-patterns.json to runtime-needed data only

| Metric | Score |
|--------|-------|
| Content Impact | 1 |
| Simplicity Gain | 5 (reduce 64,705 lines to ~15,000) |
| Risk | 3 (must verify every field access across codebase) |
| Effort | 4 (audit all consumers, build pruned version, regression test) |
| **Priority** | **-1** |

**What:** 64,705 lines of JSON. Most is per-element detail (individual shape positions, paragraph run properties, cell formatting per slide) that no runtime code actually reads. Runtime accesses: `positions.*`, `style.*`, `pptxPositions.*`, `patterns.*` (template slides list), `chartStyles.*`, `theme.*`. The per-slide `slideDetails` with full element trees is only used by route-geometry-enforcer (dead) and header-footer-drift (downgraded).

Build a `template-patterns-runtime.json` with only the fields accessed at runtime. Keep full version for dev tools.

**Risk:** Missing a field access could cause silent undefined at runtime. Requires exhaustive grep of all property paths.

**Rollback:** Restore full file.

---

### 7. Disable STRICT_TEMPLATE_FIDELITY by default

| Metric | Score |
|--------|-------|
| Content Impact | 4 (when enabled, prevents text truncation = more content shown) |
| Simplicity Gain | 2 (simplifies 13+ code paths) |
| Risk | 3 (could cause overflow in tight slide layouts) |
| Effort | 1 (change default from 'true' to 'false') |
| **Priority** | **+2** |

**What:** `STRICT_TEMPLATE_FIDELITY` (default: true) controls ~13 code paths in deck-builder-single.js. When true, it preserves full text (no truncation), enforces exact template geometry, and makes layout warnings into hard failures. But per the business context, content depth is priority #1. The strict mode ALREADY preserves content (line 370-373: "Preserve full text in strict mode").

Actually, keeping it true is CORRECT for the content-first mission. **Recommendation reversed: KEEP defaulting to true.** Instead, remove the 3-4 code paths where strict mode enforces purely cosmetic things (e.g., exact table budget enforcement at line 2754) while keeping the content-preserving paths.

**Risk:** Selective removal requires understanding each of the 13 code paths.

**Rollback:** Set `STRICT_TEMPLATE_FIDELITY=true` env var.

---

### 8. Remove disk I/O from drift diagnostics entirely

| Metric | Score |
|--------|-------|
| Content Impact | 1 |
| Simplicity Gain | 2 (removes fs.writeFileSync in production path) |
| Risk | 1 |
| Effort | 1 (delete writeHeaderFooterDriftReport call at line 1265) |
| **Priority** | **+1** |

**What:** `writeHeaderFooterDriftReport(driftReport)` at line 1265 of deck-builder-single.js writes a JSON file to disk on every generation. This is:
- A security concern (arbitrary file creation on production server)
- Unnecessary I/O in the hot path
- Railway containers are ephemeral so the files are lost anyway

Remove the `writeReport` call. Keep `scanDrift` if drift diagnostics are kept.

**Risk:** None. The written files are never read by anything automated.

**Rollback:** Re-add the call.

---

### 9. Inline chart-data-normalizer logic into ppt-utils chart functions (if ever needed)

| Metric | Score |
|--------|-------|
| Content Impact | 3 (chart data validation prevents blank charts) |
| Simplicity Gain | 2 |
| Risk | 3 (could break chart building if done wrong) |
| Effort | 3 |
| **Priority** | **-1** |

**What:** The chart-data-normalizer has good logic (coerce values, detect mismatches, handle nulls) but it's completely disconnected from the actual chart building in ppt-utils.js. The chart helpers in ppt-utils (`addBarChart`, `addPieChart`, etc.) do their own ad-hoc validation inline. Consider integrating normalizer logic into the chart helpers as lightweight guards.

**Risk:** Medium. Chart building is complex. Must test with real data.

**Rollback:** Keep existing inline validation.

---

### 10. Gate template-clone-postprocess behind env var for faster iteration

| Metric | Score |
|--------|-------|
| Content Impact | 3 (clone postprocess affects template style match significantly) |
| Simplicity Gain | 2 (already has `enabled: true` parameter) |
| Risk | 4 (disabling would degrade output quality) |
| Effort | 1 (already parameterized) |
| **Priority** | **0** |

**What:** `applyTemplateClonePostprocess` at line 7317 is already parameterized with `enabled: true`. Could add env var `SKIP_TEMPLATE_CLONE=true` to bypass during development/debugging. This saves significant processing time during iteration.

**Risk:** Output quality drops without clone postprocess. Only for dev use.

**Rollback:** Remove env var / set to false.

---

## Quick Wins (Do First)

| Priority | Recommendation | LOC Saved | Effort |
|----------|---------------|-----------|--------|
| +3 | #1 Remove route-geometry-enforcer.js | 824 | 1 hour |
| +2 | #2 Remove chart-quality-gate + chart-data-normalizer | 670 | 1 hour |
| +2 | #7 Selectively relax STRICT_TEMPLATE_FIDELITY cosmetic paths | ~50 | 2 hours |
| +2 | #3 Move dev tools to scripts/ | 2,182 (moved) | 2 hours |
| +1 | #4 Gate drift diagnostics behind env var | 415 (gated) | 1 hour |
| +1 | #8 Remove drift report disk writes | ~10 | 15 min |

**Total quick-win LOC removed from production: ~1,494 deleted + 2,597 moved to scripts/**

## Key Insight

The biggest formatting overhead is NOT in standalone modules -- it's embedded in `deck-builder-single.js` (7,620 lines) and `ppt-utils.js` (3,011 lines). The standalone modules are mostly dead code or dev tools that never should have been in the production root. The real formatting complexity is the 64,705-line `template-patterns.json` being loaded into memory on every request, and the 13+ STRICT_TEMPLATE_FIDELITY code paths scattered through the builder.

The dead code (recommendations #1, #2) is risk-free to delete immediately. The dev tools (#3) are risk-free to relocate. Everything else requires careful testing.
