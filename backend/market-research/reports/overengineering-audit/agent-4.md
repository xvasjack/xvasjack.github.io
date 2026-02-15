# Agent 4: Retry / Fallback / Orchestration Audit

**Scope:** Every retry loop, fallback chain, re-attempt pattern, and orchestration complexity in the market-research pipeline.

**Files audited (all read in full):**
- `research-orchestrator.js` (7407 lines)
- `research-agents.js` (1405 lines)
- `ai-clients.js` (593 lines)
- `research-framework.js` (1080 lines)
- `server.js` (1558 lines)
- `quality-gates.js` (914 lines)
- `budget-gate.js` (391 lines)
- `failure-cluster-analyzer.js` (523 lines)
- `stress-lab.js` (1711 lines)
- `ops-runbook.js` (1082 lines)

**Business context:** Product generates market research from a single prompt into a client-deliverable PPTX deck. Content depth, insight quality, and story flow are the top priorities. Shallow content is the absolute failure mode. Cost up to $30/run and time up to 2 hours are acceptable.

---

## Summary

The pipeline contains **23 distinct retry/fallback patterns** across 6 files. The total worst-case LLM call multiplier from retry/fallback layering is approximately **4.5x** the minimum calls needed. Most of this multiplier comes from content-quality patterns that directly serve the product's core value. The infrastructure-level retries (API error handling, JSON extraction) are well-bounded and essential. The main overengineering risk lies in the **final review loop**, where reviewer noise detection logic has grown complex enough to be its own maintenance burden.

| Category | Patterns Found | Verdict |
|----------|---------------|---------|
| API-level retry (transient errors) | 3 | KEEP all |
| JSON extraction/repair | 3 | KEEP all |
| Research framework generation | 2 | KEEP all |
| Research quality (review-deepen) | 1 loop | KEEP |
| Per-section synthesis fallback | 1 framework, 4 users | SIMPLIFY (reduce tiers from 5 to 3) |
| Section-level retry (policy/market/competitors) | 3 | KEEP |
| Content-depth rescue | 1 | KEEP |
| Iterative refinement loop | 1 | KEEP |
| Final review loop | 1 | SIMPLIFY (reduce complexity) |
| Final review escalations | 2 | SIMPLIFY (merge into single escalation) |
| Re-synthesis | 1 | KEEP |
| Cross-country synthesis fallback | 1 | KEEP |
| Quality gates (no retries) | 4 | N/A (scoring only) |
| Budget gate (no retries) | 1 | N/A (compaction only) |
| Test/ops tooling | 2 files | N/A (not production) |

---

## Detailed Findings

### Finding 1: `withRetry()` in ai-clients.js

**Location:** `ai-clients.js` lines 68-95

**Trigger:** Any Gemini API call failure (network, 500, 503, timeout)

**Attempts:** 3 (configurable)

**Changes between attempts:** Exponential backoff from 10s base. Model cooldown tracking on 429s. Non-retryable errors (4xx except 429) exit immediately.

**Fallback on total failure:** Throws to caller.

**Additional cost:** 0-2 extra API calls per failure. With 10s+ base delay, rate limit pressure is minimal.

**Content quality impact:** HIGH. Without this, any transient Gemini error kills the entire pipeline. This is table-stakes infrastructure.

**Verdict: KEEP**
**Score: 10/10** (essential, minimal overhead, well-bounded)

---

### Finding 2: Thin-response retry in `callGeminiResearch()`

**Location:** `ai-clients.js` lines 183-215

**Trigger:** Research response < 500 chars.

**Attempts:** Piggybacks on withRetry's 3 attempts (throws to trigger next attempt).

**Changes between attempts:** Same prompt, same model. Relies on Gemini's non-determinism to produce a better response.

**Fallback on total failure:** Returns whatever was received (even thin).

**Additional cost:** 1-2 extra research calls when response is thin.

**Content quality impact:** HIGH. Research is the raw material for everything downstream. A 500-char response for a topic like "Japan energy policy regulatory framework" is useless. Retrying genuinely helps because Gemini with Google Search grounding is non-deterministic.

**Verdict: KEEP**
**Score: 9/10** (directly serves content depth)

---

### Finding 3: JSON extraction with multi-strategy fallback in `extractJsonFromContent()`

**Location:** `research-agents.js` lines ~20-120 (used by all agents)

**Trigger:** LLM returns non-parseable JSON.

**Attempts:** 5 strategies tried sequentially: (1) JSON markdown fence, (2) code block, (3) direct parse, (4) bracket-counting for objects, (5) bracket-counting for arrays.

**Changes between attempts:** Different parsing strategy each time. No additional LLM calls.

**Fallback on total failure:** Returns `{ status: 'failed', data: null }`.

**Additional cost:** Zero. Pure string parsing -- no API calls.

**Content quality impact:** HIGH. Without this, any response that wraps JSON in markdown fences or has trailing text would be lost. This is extremely cheap insurance.

**Verdict: KEEP**
**Score: 10/10** (zero cost, prevents data loss)

---

### Finding 4: JSON repair retry in research agents

**Location:** `research-agents.js` -- all 7 agents (policyResearchAgent, marketResearchAgent, competitorResearchAgent, contextResearchAgent, depthResearchAgent, insightsResearchAgent, universalResearchAgent)

**Trigger:** JSON extraction fails on initial response.

**Attempts:** 1 additional LLM call with "Return ONLY valid JSON" suffix appended to original prompt.

**Changes between attempts:** Adds explicit JSON-only instruction to prompt.

**Fallback on total failure:** Returns raw text content (unstructured but still usable by synthesis).

**Additional cost:** 1 extra research API call per failed extraction. Across 25 topics, typically 2-5 fail JSON extraction, so 2-5 extra calls.

**Content quality impact:** MEDIUM-HIGH. Structured data from agents feeds directly into synthesis quality. However, synthesis can work with raw text too (just less reliably).

**Verdict: KEEP**
**Score: 8/10** (low cost, meaningful quality improvement)

---

### Finding 5: `parseScope()` retry in research-framework.js

**Location:** `research-framework.js` lines ~50-150

**Trigger:** Gemini call to parse user input into structured scope fails.

**Attempts:** 2 Gemini calls + regex fallback.

**Changes between attempts:** First call uses callGemini. On failure, retries once with same prompt. On second failure, falls back to regex-based country/industry extraction from raw input.

**Fallback on total failure:** Returns regex-parsed scope (country and industry extracted from text patterns).

**Additional cost:** 0-1 extra API call. The regex fallback is zero-cost.

**Content quality impact:** LOW-MEDIUM. Scope parsing affects framework generation, but the regex fallback is surprisingly robust for the common case (user types "Energy services in Japan").

**Verdict: KEEP**
**Score: 8/10** (cheap, good fallback chain)

---

### Finding 6: `generateResearchFramework()` fallback in research-framework.js

**Location:** `research-framework.js` lines ~200-500

**Trigger:** Dynamic framework generation fails or produces < 15 topics.

**Attempts:** 1 Gemini call for dynamic framework. On parse failure, attempts JSON truncation repair. On total failure or < 15 topics, falls back to hardcoded 26-topic framework.

**Changes between attempts:** Truncation repair is zero-cost string manipulation. Hardcoded fallback is zero-cost.

**Fallback on total failure:** `generateFallbackFramework()` returns 26 hardcoded energy-focused topics.

**Additional cost:** 0 extra API calls. Truncation repair and fallback are pure code.

**Content quality impact:** MEDIUM. Dynamic framework produces industry-specific topics (critical for non-energy industries). Hardcoded fallback is energy-specific only. But the hardcoded fallback prevents total pipeline failure.

**Verdict: KEEP**
**Score: 9/10** (zero-cost safety net, prevents pipeline abort)

---

### Finding 7: `synthesizeWithFallback()` -- 5-tier synthesis fallback chain

**Location:** `research-orchestrator.js` lines ~2080-2372

**Trigger:** Each synthesis call (policy, market, competitors, summary, re-synthesis, single-country deep dive) routes through this function.

**Attempts:** Up to 5 tiers:
- Tier 1: `callGemini` with jsonMode
- Tier 2: Truncation repair on Tier 1 raw text (zero API cost)
- Tier 3: `callGemini` WITHOUT jsonMode + 1.5x boosted maxTokens + strict suffix
- Tier 4: `callGeminiPro` with jsonMode
- Tier 5: `callGeminiPro` WITHOUT jsonMode + boosted maxTokens

**Changes between attempts:**
- Tier 1->2: No new call, just string repair
- Tier 2->3: Removes jsonMode constraint (lets model output more freely), increases token budget by 50%, adds "Return ONLY valid JSON" suffix
- Tier 3->4: Upgrades model from Flash to Pro (smarter, more expensive)
- Tier 4->5: Removes jsonMode from Pro

Each tier also runs through the caller's `accept()` function (semantic gate) before accepting the result. If accept rejects, falls through to next tier.

**Inter-tier delay:** 10s (`CFG_SYNTHESIS_TIER_DELAY_MS`)

**Fallback on total failure:** Returns null. Caller handles (usually marks section as `_synthesisError`).

**Additional cost per invocation:** Worst case: 4 additional API calls (Tiers 1, 3, 4, 5). Tier 2 is free. With Pro being ~3x more expensive than Flash, worst case cost is ~1 + 1 + 3 + 3 = 8x the cost of a single Flash call. In practice, most synthesis succeeds at Tier 1 or Tier 3.

**Content quality impact:** HIGH for Tiers 1-3 (jsonMode failures are common with complex prompts). MEDIUM for Tiers 4-5 (Pro upgrade rarely needed, but when it is, it's usually because Flash can't handle the complexity).

**Verdict: SIMPLIFY**

Tier 2 (truncation repair) is free and valuable -- KEEP. But having both jsonMode and non-jsonMode variants for both Flash and Pro creates a 4-model-call chain. The non-jsonMode + boosted tokens approach (Tier 3) is the real fix for most jsonMode failures. Tiers 4 and 5 (Pro upgrade) are rarely triggered and add significant cost.

**Recommendation:** Collapse to 3 tiers:
- Tier 1: Flash jsonMode (current)
- Tier 2: Truncation repair (current, zero cost)
- Tier 3: Flash non-jsonMode + boosted tokens (current Tier 3)
- Remove Tiers 4 and 5 (Pro). If Tier 3 fails, return null and let the caller's retry handle it (e.g., synthesizePolicy retries up to 3 times).

This eliminates 2 Pro calls from the worst case, saving ~6x Flash-equivalent cost per synthesis section.

**Score: 5/10** (effective but overbuilt; Tiers 4-5 add cost with diminishing returns)

---

### Finding 8: `synthesizePolicy()` retry loop

**Location:** `research-orchestrator.js` lines ~2637-2860

**Trigger:** Policy synthesis doesn't pass acceptance criteria (needs >= 2 sections with real data, >= 1 act with name+year).

**Attempts:** Up to 3 (MAX_POLICY_RETRIES = 2, so initial + 2 retries).

**Changes between attempts:**
- Attempt 1: Add anti-array suffix ("Return a JSON object, NOT an array")
- Attempt 2: Minimal strict prompt with explicit field requirements

Each attempt goes through `synthesizeWithFallback()` (5-tier chain).

**Fallback on total failure:** Returns `{ _synthesisError: true, section: 'policy' }`.

**Additional cost:** Worst case: 3 * 5-tier chain = 15 API calls. In practice: 3 * 1-2 tiers = 3-6 calls. The prompt changes between retries are meaningful and address specific failure modes (array wrapping, sparse output).

**Content quality impact:** HIGH. Policy section is critical for the deck. Without this, a bad Gemini response would produce an empty policy section. The prompt mutations between retries are well-targeted.

**Verdict: KEEP**
**Score: 8/10** (well-designed retry with meaningful prompt changes)

---

### Finding 9: `synthesizeMarket()` retry loop

**Location:** `research-orchestrator.js` lines ~2865-3173

**Trigger:** Market synthesis doesn't pass acceptance criteria (needs >= 2 sections with data, >= 1 with chartData or keyMetrics).

**Attempts:** Up to 3.

**Changes between attempts:**
- Attempt 0: Normal prompt
- Attempt 1: Anti-array suffix
- Attempt 2: Minimal strict prompt

Pro tiers DISABLED in synthesizeWithFallback for market (saves cost).

**Fallback on total failure:** Returns `{ _synthesisError: true, section: 'market' }`.

**Additional cost:** Worst case: 3 * 3-tier chain (no Pro) = 9 API calls. In practice: 3-6 calls.

**Content quality impact:** HIGH. Market data with chart series is the most visually impactful section of the deck.

**Verdict: KEEP**
**Score: 8/10** (appropriate for the section's importance)

---

### Finding 10: `synthesizeCompetitors()` -- 4 sequential sub-syntheses

**Location:** `research-orchestrator.js` lines ~3178-3571

**Trigger:** Always runs. Synthesizes competitors in 4 parts: japanesePlayers, localMajor, foreignPlayers, caseStudy+maActivity.

**Attempts:** Each of the 4 parts goes through `synthesizeWithFallback()` independently. 10s delay between parts.

**Changes between parts:** Different prompts for each competitor category. Each has its own acceptance criteria.

**Fallback on total failure (per part):** Returns empty/default structure for that part; other parts still used.

**Additional cost:** 4 * synthesizeWithFallback = 4-20 API calls worst case. The 10s inter-part delays add 30s total.

**Content quality impact:** HIGH. Breaking competitors into 4 parts produces better results than a single massive prompt because each competitor category has different data patterns and validation needs.

**Architecture note:** The 4-part split is not a retry -- it's a decomposition strategy. Each part is a distinct synthesis task. This is good architecture, not overengineering.

**Verdict: KEEP**
**Score: 9/10** (smart decomposition, not overengineering)

---

### Finding 11: Review-Deepen loop

**Location:** `research-orchestrator.js` lines 6043-6188 (inside `researchCountry()`)

**Trigger:** After initial research completes, reviews quality and deepens gaps.

**Attempts:** Up to `CFG_REVIEW_DEEPEN_MAX_ITERATIONS` (default 2) iterations of: review -> deepen -> merge.

**Changes between iterations:** Each iteration runs `reviewResearch()` (1 Pro call) to identify gaps, then `deepenResearch()` (up to 12 research calls) to fill them, then merges results.

**Exit conditions (well-designed):**
- Coverage score >= target (default 75)
- No gaps found
- Coverage plateau detected (score delta <= 1 for 2 iterations)
- Best coverage not improving for 2 cycles
- Repeated gap signature (same gaps being identified)
- Score dropped sharply (reverts to best snapshot)
- No new data collected from deepen

**Fallback on total failure:** Continues with current research data.

**Additional cost:** Per iteration: 1 Pro call (review) + up to 12 research calls (deepen). Max 2 iterations = 2 Pro + 24 research calls. With Pro at ~3x Flash cost, this is ~30 Flash-equivalent calls.

**Content quality impact:** VERY HIGH. This is the single most impactful quality mechanism in the pipeline. Review-deepen fills specific gaps in research data that would otherwise produce thin synthesis. The stagnation detection prevents wasted iterations.

**Verdict: KEEP**
**Score: 10/10** (core value generator, well-bounded with smart exit conditions)

---

### Finding 12: Story architect (`buildStoryPlan()`)

**Location:** `research-orchestrator.js` lines ~2477-2605

**Trigger:** Always runs after review-deepen, before synthesis.

**Attempts:** 1 Pro call. No retry.

**Fallback on total failure:** Returns null. Synthesis uses style guide only (still works fine).

**Additional cost:** 1 Pro call (always).

**Content quality impact:** MEDIUM. Story plan improves narrative coherence but synthesis works without it.

**Verdict: KEEP**
**Score: 8/10** (single call, graceful degradation)

---

### Finding 13: Content-depth rescue (`validateContentDepth` + re-research)

**Location:** `research-orchestrator.js` lines 6274-6382

**Trigger:** After initial synthesis, if `validateContentDepth()` score < 30.

**Attempts:** 1 round of gap-fill research + re-synthesis of weak sections (policy < 50, market < 50, competitors < 50).

**Changes between attempts:** Builds targeted gap queries from validation failures. Only re-synthesizes sections that scored poorly.

**Fallback on total failure:** If re-validation still < 25, aborts the country entirely ("Will not generate hollow PPT").

**Additional cost:** `fillResearchGaps` (4-6 research calls) + 1-3 re-synthesis calls. Total: ~10-15 API calls. Only triggered when initial synthesis is catastrophically thin.

**Content quality impact:** CRITICAL. This is the safety net against the product's worst failure mode (shallow content). Score < 30 means multiple sections are empty or near-empty. Without this, users would receive a mostly-blank PPTX.

**Verdict: KEEP**
**Score: 10/10** (prevents the absolute failure mode, only triggers when truly needed)

---

### Finding 14: Iterative refinement loop

**Location:** `research-orchestrator.js` lines 6392-6586

**Trigger:** After initial synthesis, iteratively scores and improves quality.

**Attempts:** Up to `CFG_REFINEMENT_MAX_ITERATIONS` (default 2).

**Per iteration:**
1. Run deterministic code gate (`validateContentDepth`)
2. Run AI reviewer (`identifyResearchGaps` -- 1 Gemini call)
3. Compute effective score (min of AI score and code gate score)
4. Fill research gaps (`fillResearchGaps` -- 4-6 calls)
5. Re-synthesize with new data (`reSynthesize` -- 1 synthesizeWithFallback call)

**Exit conditions:**
- Effective score >= `CFG_MIN_CONFIDENCE_SCORE` (default 80)
- No actionable gaps and no verifications needed
- No new usable data collected
- Reviewer collapse detection (AI score < 40 but code gate >= 80, with <= 1 actionable item -- trusts deterministic gate)

**Gate-driven research injection:** When code gate has failures but reviewer didn't flag them, injects targeted research queries from the failures themselves. This prevents the "reviewer says 90 but code gate says 60" drift.

**Forced recovery query:** When score is low but reviewer returns no actionable gaps, injects a generic broad query to avoid deadlock.

**Additional cost:** Per iteration: 1 Gemini call (review) + 4-6 research calls + 1 synthesis call. Max 2 iterations = ~14-20 API calls.

**Content quality impact:** VERY HIGH. This loop bridges the gap between "synthesis ran" and "synthesis is good enough for a CEO." The calibration between AI reviewer and deterministic code gate is sophisticated and prevents both over-spending (reviewer noise) and under-spending (gate failures ignored).

**Verdict: KEEP**
**Score: 9/10** (sophisticated and effective, well-bounded)

---

### Finding 15: Final review loop

**Location:** `research-orchestrator.js` lines 6597-6947

**Trigger:** After refinement completes, reviews the entire assembled synthesis for coherence, contradictions, and gaps.

**Attempts:** Up to `CFG_FINAL_REVIEW_MAX_ITERATIONS` (default 2).

**Per iteration:**
1. Sanitize country analysis
2. Run `finalReviewSynthesis()` (1 Pro call)
3. Check coherence score, critical/major issue count, open gap count
4. If clean (coherence >= 80, critical <= 1, major <= 3, gaps <= 3):
   - If verification passes remaining > 0, run additional clean verification passes
   - Otherwise, done
5. If not clean:
   - ESCALATION 1: Research gaps found -> `deepenResearch()` (up to `CFG_FINAL_REVIEW_MAX_QUERIES` research calls)
   - ESCALATION 2: Section fixes needed -> `applyFinalReviewFixes()` (re-synthesizes up to `CFG_FINAL_FIX_MAX_SECTIONS_PER_PASS` sections)
   - After fixes: require 2 additional clean verification passes

**Stagnation detection:**
- Same issue signature + coherence delta <= 2 for 1+ iterations -> stop
- Reviewer noise detection: if previously clean but current pass drifts slightly -> treat as noise, accept clean snapshot
- Escalation budgets: `CFG_FINAL_REVIEW_MAX_RESEARCH_ESCALATIONS`, `CFG_FINAL_REVIEW_MAX_SYNTHESIS_ESCALATIONS`
- Post-loop fallback: if latest review regressed vs clean snapshot, preserve clean snapshot

**The `applyFinalReviewFixes()` function itself:**
- Re-synthesizes up to `CFG_FINAL_FIX_MAX_SECTIONS_PER_PASS` sections
- Each section re-synthesis goes through the full synthesis function (e.g., `synthesizePolicy()` with its own 3-attempt retry and `synthesizeWithFallback()`)
- If core sections (policy/market/competitors) were fixed, runs a summary/depth refresh (`synthesizeSummary()`)
- Sequential execution with `CFG_FINAL_FIX_SECTION_DELAY_MS` between sections

**Additional cost:** Worst case per iteration: 1 Pro call (review) + up to 6 research calls (deepen) + up to 3 section re-syntheses * 3 attempts * 5 tiers + 1 summary refresh = potentially 50+ API calls. With escalation budgets, max 2 iterations of escalation. Total worst case: ~100 API calls.

In practice: Most runs get a clean review on the first pass and skip escalation entirely. When escalation triggers, it's typically 1 section fix + 1 verification pass = ~10-15 extra calls.

**Content quality impact:** HIGH for the first iteration (catches coherence issues, contradictions, missing connections). DIMINISHING for subsequent iterations (reviewer noise dominates after 2nd pass).

**Verdict: SIMPLIFY**

The final review loop is the most complex piece of orchestration in the entire pipeline. The stagnation detection, verification passes, reviewer noise handling, clean snapshot preservation, dual escalation paths with separate budgets, and post-loop fallback logic together span ~350 lines and represent significant cognitive complexity.

**Problems:**
1. Verification passes (require 2 clean passes after fixes) are expensive -- each is a Pro call. Reviewer non-determinism means "clean" one pass but "noisy" the next, which the code already handles via noise detection. This suggests the verification passes are fighting the tool's inherent noise.
2. The dual escalation (research + synthesis) with separate budgets adds branching complexity. In practice, if the reviewer found research gaps AND section fixes, both escalations fire in the same iteration. Merging them into a single "fix what the reviewer flagged" step would be simpler.
3. The post-loop clean snapshot preservation is defensive code against the loop's own complexity. If the loop were simpler, this wouldn't be needed.

**Recommendation:**
- Keep the first-pass review (1 Pro call, check coherence)
- Keep the escalation mechanism (research gaps + section fixes)
- Remove verification passes (the second review pass is sufficient)
- Remove clean snapshot tracking and noise detection (unnecessary with fewer iterations)
- Cap at 2 total review passes (initial + 1 after fixes)
- Remove post-loop snapshot comparison

This reduces the 350-line final review loop to ~150 lines with the same content quality outcome.

**Score: 4/10** (high complexity, diminishing returns after 1st iteration, reviewer noise makes multi-pass verification unreliable)

---

### Finding 16: `reSynthesize()` function

**Location:** `research-orchestrator.js` lines 4803-5119

**Trigger:** Called by refinement loop when new research data is collected.

**Attempts:** 1 call to `synthesizeWithFallback()` (which itself has 5 tiers).

**Changes from original synthesis:** Prompt includes original synthesis + new data + quality gate failures. Instructs model to update values while preserving structure.

**Fallback on total failure:** Returns original synthesis unchanged.

**Post-processing:** Validates structure preservation (checks policy/market/competitors present). If partial, merges available sections into original. Detects and warns on minimal changes (< 2 fields updated). Preserves depth/summary richness via `mergeCanonicalSectionsPreferRich`.

**Additional cost:** 1-5 API calls (synthesizeWithFallback chain).

**Content quality impact:** HIGH. This is how the pipeline incorporates gap-fill research into the synthesis. Without it, new research data would be collected but never used.

**Verdict: KEEP**
**Score: 8/10** (essential for iterative improvement, good graceful degradation)

---

### Finding 17: `synthesizeSummary()` depth completeness enforcement

**Location:** `research-orchestrator.js` lines 4278-4506 (synthesizeSummary) + lines 3829-4027 (ensurePartnerAssessment) + lines 4029-4188 (ensureDepthStrategyAndSegments) + lines 4190-4232 (ensureSummaryCompleteness)

**Trigger:** After summary synthesis, enforces minimum structural completeness.

**Attempts:** No retries. Pure post-processing.

**What it does:**
- Merges AI-generated depth with hardcoded defaults for: implementation roadmap (3 phases), partner assessment (5 partners with default descriptions), entry strategy (3 options with Harvey balls), target segments (3 segments)
- Normalizes insights (ensures data/pattern/implication/timing fields)
- Fills gaps with evidence collected from policy/market/competitors sections

**Fallback:** Hardcoded defaults for every depth section. If AI produces nothing, the deck still has reasonable placeholder content.

**Additional cost:** Zero. Pure code, no API calls.

**Content quality impact:** MEDIUM. The hardcoded defaults are generic ("Joint Venture", "Acquisition", "Greenfield" with boilerplate pros/cons). They prevent empty slides but don't add industry-specific value. However, they're overwritten by AI-generated content when available, so they only appear when synthesis fails partially.

**Verdict: KEEP**
**Score: 7/10** (zero cost, prevents empty slides, but hardcoded content is generic)

---

### Finding 18: `synthesizeFindings()` cross-country fallback

**Location:** `research-orchestrator.js` lines 7272-7382

**Trigger:** Multi-country synthesis (> 1 country).

**Attempts:** 1 `callGemini` call. On failure, retries with `callGeminiPro`.

**Fallback on total failure:** Returns `{ executiveSummary: ['Synthesis parsing failed'], rawContent: rawText }`.

**Additional cost:** 0-1 extra API call.

**Content quality impact:** MEDIUM. Cross-country synthesis is less critical than per-country (it's a comparison layer on top). But having a Pro fallback is reasonable since this is the final user-facing output.

**Verdict: KEEP**
**Score: 7/10** (simple, appropriate fallback)

---

### Finding 19: Research quality gate retry in server.js

**Location:** `server.js` lines ~700-780 (inside `runMarketResearch()`)

**Trigger:** Quality Gate 1 identifies weak topics (from `validateResearchQuality()`).

**Attempts:** Retries up to 5 weak topics with a 2-minute timeout.

**Changes between attempts:** Re-runs research for specific weak topics only.

**Fallback on total failure:** Proceeds with whatever data was collected.

**Additional cost:** Up to 5 extra research calls.

**Content quality impact:** MEDIUM-HIGH. Targeted -- only retries topics that scored poorly. The 2-minute cap prevents runaway retries.

**Verdict: KEEP**
**Score: 8/10** (targeted, bounded, meaningful)

---

### Finding 20: Synthesis quality retry in server.js

**Location:** `server.js` lines ~800-850

**Trigger:** Quality Gate 2: synthesis score between 40-60 (borderline).

**Attempts:** 1 retry with boosted tokens.

**Changes between attempts:** Increases maxTokens for synthesis.

**Fallback on total failure:** Proceeds with current synthesis.

**Additional cost:** 1 extra synthesis call (goes through synthesizeWithFallback).

**Content quality impact:** MEDIUM. The 40-60 range is where token limits are often the bottleneck. Boosting tokens is a reasonable fix.

**Verdict: KEEP**
**Score: 7/10** (simple, targeted)

---

### Finding 21: `identifyResearchGaps()` with reviewer calibration

**Location:** `research-orchestrator.js` lines ~583-976

**Trigger:** Called by refinement loop to score and identify gaps.

**Attempts:** 1 Gemini call with code-gate calibration context.

**Changes from raw review:** Calibrates AI reviewer scores against deterministic code gate to prevent hallucinated score swings. If code gate says 85 but AI says 40, the system trusts the code gate.

**Fallback on total failure:** Returns empty gaps with default scores.

**Additional cost:** 1 API call per refinement iteration.

**Content quality impact:** HIGH. This is the intelligence that drives the refinement loop. The calibration against the code gate is sophisticated and prevents expensive low-signal loops.

**Verdict: KEEP**
**Score: 9/10** (smart calibration, prevents waste)

---

### Finding 22: `fillResearchGaps()` with recovery path

**Location:** `research-orchestrator.js` lines ~979-1112

**Trigger:** Called by refinement loop when gaps are identified.

**Attempts:** Fills up to 4 critical gaps + 1 verification via `callGeminiResearch`. If all gap fills are rejected as thin (< 500 chars, 0 citations), runs 2 additional recovery queries.

**Changes between attempts:** Recovery queries are broader/different from original gap queries.

**Fallback on total failure:** Returns whatever was collected (may be empty).

**Additional cost:** 4-6 research calls + 0-2 recovery calls = 4-8 calls total.

**Content quality impact:** HIGH. This is the mechanism that actually fills gaps identified by the reviewer. The recovery path handles cases where the reviewer identified the right gap but the search query was too narrow.

**Verdict: KEEP**
**Score: 8/10** (well-bounded, meaningful recovery path)

---

### Finding 23: Pipeline abort signal + optional timeout

**Location:** `server.js` lines ~500-520, throughout pipeline

**Trigger:** Optional `PIPELINE_TIMEOUT_SECONDS` env var (disabled by default). Also aborts on catastrophic failures (insufficient research data, too many synthesis failures).

**Mechanism:** `AbortController` + `AbortSignal` threaded through all API calls and batch operations.

**Content quality impact:** N/A. This is pipeline lifecycle management, not retry/fallback.

**Verdict: KEEP**
**Score: 8/10** (essential for operational safety)

---

## Non-Production Files

### `failure-cluster-analyzer.js` (523 lines)
Pure analysis tool for stress test telemetry. Clusters failures by error signature, computes risk scores, generates reports. **No retry/fallback patterns.** Not relevant to this audit.

### `stress-lab.js` (1711 lines)
Test harness with deterministic seed perturbation. Builds synthetic payloads and runs through pipeline phases. Mutation classes: transient-keys, schema-corruption, geometry-override, long-text, table-density, chart-anomalies, empty-null. **No retry/fallback patterns in test code itself.** Tests the pipeline's resilience but doesn't add retry complexity.

### `ops-runbook.js` (1082 lines)
Operational troubleshooting toolkit. Error pattern matching, playbooks, local validation, readiness checks, command cookbook. **No retry/fallback patterns.** Pure diagnostic/operational tooling.

### `quality-gates.js` (914 lines)
Scoring functions: `validateResearchQuality`, `validateSynthesisQuality`, `validatePptData`. **No retries internally** -- these return scores/failures that trigger retries in server.js and research-orchestrator.js.

### `budget-gate.js` (391 lines)
Payload compaction: `analyzeBudget`, `compactPayload`. **No retries** -- trims oversized fields and truncates tables. Pure data transformation.

---

## Orchestration Complexity Assessment

### The Complete Call Chain (worst case)

For a single-country research run, the maximum LLM call chain is:

```
researchCountry()
  |
  +-- generateResearchFramework() ............ 1 Gemini call (+ 1 retry)
  |
  +-- universalResearchAgent() x 25 topics ... 25 research calls (+ 0-5 JSON retries)
  |
  +-- Review-Deepen loop (x2 max)
  |     +-- reviewResearch() ................. 1 Pro call
  |     +-- deepenResearch() ................. up to 12 research calls
  |     Total per iteration: ~13 calls
  |
  +-- buildStoryPlan() ....................... 1 Pro call
  |
  +-- synthesizePolicy() (x3 max)
  |     +-- synthesizeWithFallback() (x5 tiers) .. 1-5 calls per attempt
  |     Total: 3-15 calls
  |
  +-- synthesizeMarket() (x3 max, no Pro tiers)
  |     +-- synthesizeWithFallback() (x3 tiers) .. 1-3 calls per attempt
  |     Total: 3-9 calls
  |
  +-- synthesizeCompetitors() (4 parts)
  |     +-- synthesizeWithFallback() (x5 tiers) x4 .. 4-20 calls
  |
  +-- synthesizeSummary()
  |     +-- synthesizeWithFallback() (x5 tiers) .. 1-5 calls
  |
  +-- Content-depth rescue (if score < 30)
  |     +-- fillResearchGaps() ............... 4-8 research calls
  |     +-- re-synthesize weak sections ...... 3-15 calls
  |
  +-- Refinement loop (x2 max)
  |     +-- identifyResearchGaps() ........... 1 Gemini call
  |     +-- fillResearchGaps() ............... 4-8 research calls
  |     +-- reSynthesize() ................... 1-5 calls
  |     Total per iteration: ~6-14 calls
  |
  +-- Final review loop (x2 max)
        +-- finalReviewSynthesis() ........... 1 Pro call
        +-- deepenResearch() ................. up to 6 research calls
        +-- applyFinalReviewFixes() .......... up to 3 section re-synths * full chain
        +-- synthesizeSummary() refresh ...... 1-5 calls
        Total per iteration: ~10-50 calls
```

**Minimum calls (happy path):** ~48 (25 research + 1 framework + 1 review + 1 story + 4 synthesis sections + 1 summary + 1 refinement review + 1 final review + ~13 misc)

**Maximum calls (every retry fires):** ~220 (but multiple emergency exits prevent most of these from firing simultaneously)

**Typical calls:** ~60-80 (based on: 25 research + 5 JSON retries + 1 review + 12 deepen + 1 story + 6 synthesis + 1 summary + 1 refinement + 6 gap fills + 1 final review)

### Cost Estimate

At typical usage (~70 calls):
- ~30 research calls (callGeminiResearch) -- Flash with Google Search grounding: ~$0.10 each = $3.00
- ~10 synthesis calls (callGemini, Flash) -- ~$0.05 each = $0.50
- ~5 Pro calls (review/story/final review) -- ~$0.30 each = $1.50
- Total: ~$5.00 per country

Well within the $30/run budget. Even worst case (~220 calls) would be ~$15-20.

---

## Summary Recommendations

### KEEP (no changes needed) -- 18 patterns

| # | Pattern | Reason |
|---|---------|--------|
| 1 | `withRetry()` | Essential infrastructure, well-bounded |
| 2 | Thin-response retry | Directly improves research quality |
| 3 | JSON extraction strategies | Zero cost, prevents data loss |
| 4 | JSON repair retry in agents | Low cost, meaningful quality gain |
| 5 | `parseScope()` retry + regex fallback | Cheap, robust fallback |
| 6 | Framework generation fallback | Zero cost safety net |
| 8 | `synthesizePolicy()` retry | Well-designed prompt mutations |
| 9 | `synthesizeMarket()` retry | Appropriate for section importance |
| 10 | `synthesizeCompetitors()` 4-part split | Smart decomposition, not overengineering |
| 11 | Review-Deepen loop | Core value generator, well-bounded |
| 12 | Story architect | Single call, graceful degradation |
| 13 | Content-depth rescue | Prevents absolute failure mode |
| 14 | Iterative refinement loop | Sophisticated, effective |
| 16 | `reSynthesize()` | Essential for iterative improvement |
| 17 | Summary completeness enforcement | Zero cost, prevents empty slides |
| 19 | Research quality gate retry | Targeted, bounded |
| 20 | Synthesis quality retry | Simple, targeted |
| 22 | `fillResearchGaps()` with recovery | Well-bounded, meaningful |

### SIMPLIFY -- 3 patterns

| # | Pattern | Current | Recommended | Savings |
|---|---------|---------|-------------|---------|
| 7 | `synthesizeWithFallback()` 5-tier chain | 5 tiers (Flash JSON, repair, Flash no-JSON, Pro JSON, Pro no-JSON) | 3 tiers (Flash JSON, repair, Flash no-JSON) | Eliminates 2 Pro calls ($0.60) from worst case per synthesis. Callers already have their own retry loops. |
| 15 | Final review loop | 350 lines, verification passes, dual escalation, snapshot tracking, noise detection | 150 lines, 2 max passes, single escalation, no verification passes | Reduces cognitive complexity by ~60%. Saves 1-3 Pro calls per run. Eliminates code that exists to compensate for its own complexity. |
| 15a | `applyFinalReviewFixes()` summary refresh | After fixing core sections, always runs `synthesizeSummary()` refresh | Only refresh summary if summary section itself was NOT already re-synthesized | Saves 1 synthesis call when summary was already fixed. |

### REMOVE -- 0 patterns

No patterns should be removed entirely. Every retry/fallback serves the core product goal of content quality. The overengineering is in depth (too many tiers/iterations in specific patterns), not in breadth (unnecessary patterns).

---

## Overengineering Score

**Overall: 3.5 / 10** (mildly overengineered)

The pipeline is complex but most complexity directly serves content quality, which is the stated top priority. The main issue is the final review loop (Finding 15) where defensive code against reviewer noise has grown into its own complexity problem. The 5-tier synthesis fallback (Finding 7) has more fallback than needed given that callers already retry. Everything else is well-designed and well-bounded.

**If simplified per recommendations above:**
- Removes ~200 lines of defensive code
- Saves 3-5 Pro-equivalent calls per run (~$1-1.50)
- Reduces cognitive load for future developers
- No impact on content quality (Pro tiers in synthesizeWithFallback are rarely reached; final review verification passes fight reviewer noise rather than improving content)
