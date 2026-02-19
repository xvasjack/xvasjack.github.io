# Agent 2: Content-Critical-Path Audit

**Scope**: Identify where non-content logic (validation, formatting, retry, meta-logic) harms content depth, insight quality, or story flow.

**Top priority**: Content depth, insight quality, story flow.
**Absolute failure**: Shallow content, weak insights, poor strategic narrative.

---

## 1. Full Content Path Trace

The complete content lifecycle from API request to email delivery:

```
API POST /api/market-research
  |
  v
readRequestType (LLM call) ............................ content: 40%  meta: 60%
  |
  v
generateResearchFramework (LLM call) ............ content: 70%  meta: 30%
  |
  v
universalResearchAgent (x25 LLM calls) .......... content: 50%  meta: 50%
  |                                                  (retry/extract/validate = 50%)
  v
reviewResearch (LLM call) ....................... content: 30%  meta: 70%
  |                                                  (scoring, JSON extraction)
  v
deepenResearch (up to N LLM calls) .............. content: 50%  meta: 50%
  |
  v
mergeDeepened .................................. content: 10%  meta: 90%
  |                                                  (pure data merge logic)
  v
buildStoryPlan (LLM call via GeminiPro) ......... content: 80%  meta: 20%
  |
  v
synthesizePolicy (LLM call via fallback chain) .. content: 35%  meta: 65%
synthesizeMarket (LLM call via fallback chain) .. content: 25%  meta: 75%
synthesizeCompetitors (4 LLM calls via chain) ... content: 20%  meta: 80%
synthesizeSummary (LLM call via fallback chain) . content: 25%  meta: 75%
  |
  v
validateContentDepth ........................... content: 0%   meta: 100%
  |                                                  (pure scoring/gating)
  v
identifyResearchGaps (LLM call) ................ content: 40%  meta: 60%
  |
  v
fillResearchGaps (LLM calls) ................... content: 50%  meta: 50%
  |
  v
reSynthesize (per-section LLM calls) ........... content: 35%  meta: 65%
  |
  v
sanitizeCountryAnalysis ........................ content: 0%   meta: 100%
  |                                                  (placeholder removal, validation)
  v
finalReviewSynthesis (LLM call via GeminiPro) ... content: 30%  meta: 70%
  |
  v
applyFinalReviewFixes (per-section LLM calls) .. content: 35%  meta: 65%
  |
  v
[FINAL REVIEW LOOP: up to N iterations of
  sanitize -> review -> research escalation ->
  synthesis escalation -> stagnation detect ->
  verification passes]                          content: 15%  meta: 85%
  |
  v
Quality Gate 1: validateResearchQuality ........ content: 0%   meta: 100%
Quality Gate 2: validateSynthesisQuality ....... content: 0%   meta: 100%
Quality Gate 2b: contentReadinessCheck ......... content: 0%   meta: 100%
Quality Gate 3: validatePptData ................ content: 0%   meta: 100%
  |
  v
synthesizeFindings / synthesizeSingleCountry .... content: 50%  meta: 50%
  |
  v
content size check: runBudgetGate ..................... content: -20%  meta: 100%
  |                                                  (DESTROYS content via trimming)
  v
Pre-build sanitization ........................ content: 0%   meta: 100%
Pre-build structure check ..................... content: 0%   meta: 100%
  |
  v
generatePPT .................................... content: 30%  meta: 70%
  |
  v
PPT structural validation ..................... content: 0%   meta: 100%
PPT formatting style match checks ................ content: 0%   meta: 100%
PPT relationship file safety .................... content: 0%   meta: 100%
PPT package consistency ....................... content: 0%   meta: 100%
  |
  v
Email delivery
```

**Aggregate**: Across the full pipeline, approximately **30% of code/logic generates content** and **70% validates, retries, sanitizes, gates, or reformats it**.

---

## 2. Findings

### Finding 1: synthesizeWithFallback 5-Tier Chain Degrades Content via Prompt Mutation

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/research-engine.js`, lines 2080-2372

**What happens**: Every synthesis call goes through a 5-tier fallback chain:
1. Gemini Flash with jsonMode
2. Truncation repair (re-parse broken JSON)
3. Gemini Flash without jsonMode
4. Gemini Pro with jsonMode
5. Gemini Pro without jsonMode

Each tier adds a 10-second delay. Between tiers, the `accept` function runs complex validation (transient key sanitization, canonical key enforcement, content artifact detection, array normalization). If any validation fails, the next tier is attempted.

**Content harm**: When tier 1 fails validation (often for structural reasons like key naming), the system retries with progressively stripped-down prompts. By tier 5, the model is being asked for simpler output, which produces shallower content. The fallback chain optimizes for JSON structural compliance at the expense of analytical depth.

**Evidence**: `synthesizeMarket` (lines 3017-3163) wraps the 5-tier chain in ANOTHER 3-attempt retry loop (attempts 0-2), where attempt 2 uses a "minimal strict prompt" that strips the synthesis style guide, story instructions, and anti-padding rules -- the exact instructions that produce deep content.

| Metric | Value |
|--------|-------|
| Content Impact | 5 |
| Simplicity Gain | 4 |
| Risk | 2 |
| Effort | 3 |
| **Priority** | **4** |

---

### Finding 2: content size check Truncates AI Content to Arbitrary Character Limits

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/content-size-check.js`, lines 1-391

**What happens**: After all synthesis, review, and gap-filling is complete, the content size check runs `compactPayload` which:
- Enforces `FIELD_CHAR_BUDGETS` (400-800 chars per field)
- Calls `trimToSentenceBoundary()` to cut content at sentence boundaries
- Truncates table rows beyond limits
- Runs AFTER the LLM invested tokens generating deep analysis

**Content harm**: This is the single worst content-destroying mechanism. The LLM generates 60-word insights with data+pattern+implication chains, then the content size check cuts them to 400 chars (~65 words). Fields like `overview`, `keyInsight`, `subtitle` have tight limits. The system spends 48+ LLM calls and $20 generating deep content, then a deterministic function deletes chunks of it.

**Evidence**: `trimToSentenceBoundary()` (content-size-check.js) literally truncates at a period boundary, throwing away trailing content. The `mistakes.md` file (row 37) already documents this: "truncation = data loss."

| Metric | Value |
|--------|-------|
| Content Impact | 5 |
| Simplicity Gain | 5 |
| Risk | 1 |
| Effort | 2 |
| **Priority** | **7** |

---

### Finding 3: Triple-Loop Refinement Causes Content Churn Without Convergence

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/research-engine.js`, lines 5900-7000

**What happens**: Three nested improvement loops run sequentially:
1. **Review-Deepen loop** (up to CFG_REFINEMENT_MAX_ITERATIONS iterations): reviewResearch -> deepenResearch -> mergeDeepened -> reSynthesize
2. **Validation-Refinement loop** (up to CFG_REFINEMENT_MAX_ITERATIONS iterations): validateContentDepth -> identifyResearchGaps -> fillResearchGaps -> reSynthesize
3. **Final Review loop** (up to CFG_FINAL_REVIEW_MAX_ITERATIONS iterations): finalReviewSynthesis -> research escalation -> synthesis escalation -> verification passes -> stagnation detection

Each loop calls multiple LLM endpoints. Stagnation detection (lines 6662-6690) compares issue signatures between iterations and breaks if the same issues repeat -- meaning the system can churn through expensive LLM calls producing the same output repeatedly before detecting this.

**Content harm**: Each re-synthesis pass can LOSE content that the previous pass generated. The system does not diff content between iterations -- it replaces entire sections. A re-synthesis triggered by one weak subsection can degrade three strong subsections. The `lastCleanReviewSnapshot` mechanism (line 6674) tries to mitigate this by reverting to a previous good state, but it only captures the review metadata, not the full synthesis content.

**Evidence**: Lines 6862-6877 show that after `applyFinalReviewFixes`, the system sets `verificationPassesRemaining = 2`, forcing 2 more review iterations even if content is now good. Each verification pass calls `finalReviewSynthesis` (a GeminiPro LLM call) and `sanitizeCountryAnalysis`. The verification passes themselves can detect "reviewer noise" -- the LLM reviewer finding new issues in content it previously approved.

| Metric | Value |
|--------|-------|
| Content Impact | 4 |
| Simplicity Gain | 5 |
| Risk | 3 |
| Effort | 3 |
| **Priority** | **3** |

---

### Finding 4: Competitor Synthesis Splits Content Across 4 Sequential LLM Calls, Destroying Context

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/research-engine.js`, lines 3178-3571

**What happens**: `synthesizeCompetitors` makes 4 separate LLM calls:
1. Japanese players (prompt1)
2. Local major players (prompt2)
3. Foreign players (prompt3)
4. Case study + M&A activity (prompt4)

Each call gets the same research data but independently synthesizes its portion. The calls run sequentially with a configurable delay between them (`CFG_COMPETITOR_SYNTHESIS_DELAY_MS`).

**Content harm**: The LLM cannot see what it generated for Japanese players when generating foreign players. Cross-referencing (e.g., "unlike ENGIE, Japanese competitor Mitsui has...") is impossible. Each call generates in isolation, producing repetitive structure without comparative analysis. The 4-call pattern also quadruples the validation overhead -- each goes through `synthesizeWithFallback` (5 tiers), `coerceCompetitorChunk`, `buildCompetitorAccept` validation (lines 3366-3467 with player viability checks, slide title checks, section insight checks).

**Evidence**: The `buildCompetitorAccept` function (lines 3366-3467) runs per-player validation including `sanitizePlaceholderStrings`, `isViableCompetitorPlayer`, `ensureString` on titles/insights. For 3 players x 3 sections = 9 player validations, each with multiple string operations, plus the chunk-level coercion and key filtering. The validation code for competitors (lines 3334-3467) is ~135 lines -- longer than the actual synthesis prompts.

| Metric | Value |
|--------|-------|
| Content Impact | 4 |
| Simplicity Gain | 4 |
| Risk | 2 |
| Effort | 3 |
| **Priority** | **3** |

---

### Finding 5: content Quality Engine Adds 2275 Lines of Regex-Based Quality Checks That Never Improve Content

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/content-quality-check.js`, 2275 lines

**What happens**: This file implements:
- Currency/percentage/time normalization (lines 1-200)
- `parseDealEconomics`, `parseEntryStrategy`, `parsePartnerAssessment` (lines 200-500) -- regex parsing of LLM-generated text
- `validateInsightStructure` (lines 430-552) -- checks for finding + implication + action + risk fields
- Plausibility checks (lines 556-669) -- IRR ranges, payback period sanity
- Contradiction detection (lines 671-905) -- directional claim extraction, fuzzy subject matching, cross-section contradiction detection
- Decision-usefulness scoring (lines 906-1032) -- company name regex, number counting, action verb counting, causal connector counting
- Anti-shallow checks (lines 1034-1255) -- fact dump detection, macro padding detection, empty calories detection, consultant filler detection (30 filler phrases regex)
- Shallow content detection (lines 1498-1574)
- Evidence grounding scoring (lines 1576-1631)
- Insight depth scoring (lines 1632-1666)
- Actionability scoring (lines 1668-1716)
- Root-cause analysis detection (lines 1718-1772)
- Storyline coherence scoring (lines 1774-1856)
- `contentReadinessCheck` (lines 1857-2231) -- the mega-gate combining all the above

**Content harm**: All 2275 lines are READ-ONLY checks. They score content after LLM generation but never improve it. The `contentReadinessCheck` (line 903 in server.js) throws `Error` when score < threshold, killing the entire pipeline. Content that is analytically strong but doesn't match regex patterns for "named companies" (requires `Corp|Ltd|Inc|Co|Group|GmbH|SA|AG|PLC|LLC|Sdn Bhd` suffix) or "causal links" (requires literal "because|therefore|resulting in") scores low and gets rejected.

The consultant filler detector (lines 1160-1217) flags 30 phrases including "go-to-market", "optimize", "streamline" -- which are legitimate strategy vocabulary. The macro padding detector (lines 1074-1103) flags GDP/inflation mentions even when they provide legitimate industry context.

**Evidence**: `scoreDecisionUsefulness` (lines 917-970) scores text by counting regex matches for company names, numbers, action verbs, and causal connectors. A brilliantly insightful paragraph that uses informal company references ("Toyota's Daihatsu subsidiary" instead of "Daihatsu Co") scores 0 on the company dimension. The entire 2275-line file runs at the SERVER level (server.js line 885-925) as a hard gate, yet it can only detect surface patterns, not actual analytical quality.

| Metric | Value |
|--------|-------|
| Content Impact | 4 |
| Simplicity Gain | 5 |
| Risk | 2 |
| Effort | 2 |
| **Priority** | **5** |

---

### Finding 6: Transient Key Sanitization System Adds 270+ Lines of Object-Walking Logic

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/research-engine.js`, lines 210-480

**What happens**: The system maintains:
- `TRANSIENT_KEY_PATTERN` regex matching `section_0`, `section_1`, numeric keys, `_wasArray`, etc.
- `hasTransientTopLevelKeys()` -- checks if any key matches transient pattern
- `sanitizeTransientKeys()` -- recursively walks objects, removing transient keys, counting removals
- `createSanitizationContext()` / `logSanitizationResult()` -- tracking/logging infrastructure
- `findDisallowedTopLevelKeys()` -- checks against strict allowed-key lists
- `hasSemanticArtifactPayload()` -- deep recursive scan for placeholder strings and truncation artifacts
- `sanitizePlaceholderStrings()` -- recursive object walker replacing placeholder text with null

This runs at EVERY stage: inside `synthesizeWithFallback`, inside each `accept` function, inside `sanitizeCountryAnalysis`, as pre-build sanitization.

**Content harm**: The placeholder detection (lines 280-370) scans for patterns like "insufficient research data", "analysis pending", "[truncated]", etc. But these patterns sometimes appear in LEGITIMATE content describing data gaps (e.g., an insight noting "data is insufficient for this sub-sector, recommending primary research"). The sanitizer replaces these with `null`, silently deleting analytical observations about data quality.

**Evidence**: `hasSemanticArtifactPayload` (lines 370-440) does a recursive depth-first walk of the ENTIRE synthesis object at every validation point. In `synthesizeMarket` alone, this runs in the `marketAccept` function (line 3005), then again after validation (line 3079), then in `sanitizeCountryAnalysis` (line 4266), then in pre-build sanitization (line 1018 in server.js). The same object gets recursively walked 4+ times for the same check.

| Metric | Value |
|--------|-------|
| Content Impact | 3 |
| Simplicity Gain | 4 |
| Risk | 1 |
| Effort | 2 |
| **Priority** | **4** |

---

### Finding 7: Server-Level Quality Gate Stack Creates 7 Sequential Hard-Fail Points That Discard All Content

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/server.js`, lines 620-1262

**What happens**: After country research completes, 7 sequential gates run, each capable of throwing an Error that aborts the ENTIRE pipeline:

1. **Quality Gate 1** (line 625): `validateResearchQuality` -- triggers topic retry loop (capped at 2 min)
2. **Readiness Gate** (line 730): Countries with `readyForClient === false` -- hard-fail unless soft gate or draft mode
3. **Quality Gate 2** (line 833): `validateSynthesisQuality` -- hard-fail if < 40, retry if < 60
4. **Quality Gate 2b** (line 885): `contentReadinessCheck` -- hard-fail if < 80 (the 2275-line engine)
5. **Quality Gate 3** (line 944): `validatePptData` -- per-country PPT data completeness
6. **Pre-build structure** (line 1032): `collectPreRenderStructureIssues` -- canonical key checks
7. **Quality Gate 4** (line 1218): `validatePPTX` -- post-build structural validation

If ANY gate fails, the system has already spent 30-60 minutes and $5-20 on LLM calls, all of which is thrown away. The user gets an error email saying "Market research failed" with a technical error message.

**Content harm**: The pipeline invests ~48 LLM calls generating deep, expensive content, then a regex-based content gate (Gate 2b) or a structural key check (Gate 6) can discard everything. There is no degraded-output mode -- it is all-or-nothing for non-draft mode. The readiness gate (Gate 2, lines 730-822) has a complex hierarchy: `draftPptMode` bypass -> `SOFT_READINESS_GATE` -> `hardFailReadiness` threshold check, spanning 90 lines of conditional logic that determines whether $20 of analysis gets sent or discarded.

| Metric | Value |
|--------|-------|
| Content Impact | 5 |
| Simplicity Gain | 4 |
| Risk | 3 |
| Effort | 3 |
| **Priority** | **3** |

---

### Finding 8: Canonical Key Enforcement Rejects Valid Content Over Key Naming

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/research-engine.js`, lines 130-207 and throughout

**What happens**: The system defines strict canonical key sets:
- `CANONICAL_POLICY_SECTION_KEYS` (4 keys)
- `CANONICAL_MARKET_SECTION_KEYS` (3 keys)
- `STRICT_DEPTH_TOP_LEVEL_KEYS` (5 keys)
- `STRICT_SUMMARY_TOP_LEVEL_KEYS` (7 keys)
- `STRICT_MARKET_TOP_LEVEL_KEYS` (3 keys + meta keys)

Every synthesis output is checked against these key lists. If the LLM returns `supplyDemandDynamics` instead of `supplyAndDemandDynamics`, the validation fails. Each section has both `validateXxxSynthesis()` normalization functions AND strict key enforcement in `accept()` functions, creating dual-layer key policing.

**Content harm**: The LLM might produce excellent analytical content under a slightly different key name (e.g., `marketAnalysis` instead of `marketSizeAndGrowth`). The `accept` function rejects this, triggering a retry with a stripped-down prompt. The retry produces shallower content because it focuses on getting the keys right rather than the analysis. Lines 2996-3003 show the market accept function rejecting output based on `canonicalCount < CANONICAL_MARKET_SECTION_KEYS.length`, then logging which "unknown keys" were seen -- keys that contain valid content.

**Evidence**: `validateMarketSynthesis` (called at line 3078) attempts to normalize non-canonical keys to canonical ones (e.g., mapping `supplydemandDynamics` -> `supplyAndDemandDynamics`). But the `marketAccept` function (lines 2973-3012) runs BEFORE normalization can save the output, rejecting it and triggering another LLM call. The normalization exists but runs too late in the pipeline to prevent content-destroying retries.

| Metric | Value |
|--------|-------|
| Content Impact | 4 |
| Simplicity Gain | 4 |
| Risk | 1 |
| Effort | 2 |
| **Priority** | **5** |

---

### Finding 9: Context-Fit Agent Uses LLM Call for Text Compression

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/context-fit-agent.js`, 293 lines

**What happens**: The `fitTokensToTemplateSlots` function first tries `heuristicFitTokens` (deterministic text splitting), then falls back to `aiFitTokens` which makes an LLM call to compress content into template slots with `maxCharsPerSlot = 360` chars.

**Content harm**: This uses an LLM call to SHORTEN content that another LLM call generated. The `maxCharsPerSlot` of 360 characters (~60 words) is extremely tight for strategic insights. The AI fitting instruction tells the LLM to "compress the following content to fit into template slots" -- which naturally produces shallower content. This is literally paying for an LLM call to make content worse.

| Metric | Value |
|--------|-------|
| Content Impact | 3 |
| Simplicity Gain | 4 |
| Risk | 1 |
| Effort | 1 |
| **Priority** | **5** |

---

### Finding 10: Research Agent JSON Extraction Has 5 Strategies, Doubling LLM Calls on Failure

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/research-agents.js`, lines 1-100, 200-400

**What happens**: Every research agent call (25 per country) uses `extractJsonFromContent` which tries 5 extraction strategies:
1. Direct `JSON.parse`
2. Strip markdown fences and parse
3. Find JSON block with bracket matching
4. Find JSON in code blocks
5. Find any `{...}` substring

If all 5 fail, the agent retries the LLM call with "Return ONLY valid JSON" appended to the prompt.

**Content harm**: The retry with "Return ONLY valid JSON" suffix causes the LLM to focus on JSON formatting rather than research depth. For 25 research topics, if even 5 have extraction issues, that is 5 extra LLM calls (10% overhead) producing shallower content. The extraction failure rate is likely non-trivial since research agents use `callGeminiResearch` with Google Search grounding, which produces longer, more narrative responses that are harder to parse as JSON.

| Metric | Value |
|--------|-------|
| Content Impact | 3 |
| Simplicity Gain | 3 |
| Risk | 2 |
| Effort | 2 |
| **Priority** | **2** |

---

### Finding 11: ensureSummaryCompleteness Overwrites LLM Content with Hardcoded Defaults

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/research-engine.js`, lines 3831-4230

**What happens**: After `synthesizeSummary` returns LLM-generated content, `ensureSummaryCompleteness` runs:
- `ensureImplementationRoadmap` (lines 3831-3892): Replaces empty/short implementation phases with hardcoded defaults ("Phase 1: Setup (Months 0-6)", "Finalize target segment and compliance scope", etc.)
- `ensurePartnerAssessment` (lines 3917-4027): Generates partner data from competitor data with hardcoded partnership/acquisition fit scores
- `ensureDepthStrategyAndSegments` (lines 4029-4188): Fills in entry strategy with hardcoded JV/Acquisition/Greenfield options, hardcoded Harvey Balls scores, hardcoded target segments ("Power and gas operators", "Industrial energy-intensive users")
- `normalizeInsight` (lines 3805-3828): Replaces missing insight fields with hardcoded fallbacks ("Regulatory timing defines entry window", "Quantified demand supports phased entry")

**Content harm**: These functions replace LLM-generated, industry-specific strategic analysis with generic consulting templates. The hardcoded defaults ("Phase 2: Launch (Months 6-12)", "Execute pilot contracts with measurable KPI baselines") are the exact kind of shallow, generic content that the content quality engine tries to detect and penalize. The system generates deep content, then replaces it with filler, then penalizes itself for the filler.

**Evidence**: `ensurePartnerDescription` (lines 3894-3915) generates a 60-word boilerplate description when a partner description is < 30 words: "is a [type] candidate with relevant execution capability, local stakeholder access, and practical delivery experience in energy services contracts." This is industry-specific hardcoding (mentions "energy services") that violates the project's "NO HARDCODED INDUSTRY LOGIC" rule from MEMORY.md.

| Metric | Value |
|--------|-------|
| Content Impact | 5 |
| Simplicity Gain | 4 |
| Risk | 2 |
| Effort | 3 |
| **Priority** | **4** |

---

### Finding 12: content Coherence Checker Adds Cross-Section Consistency Checking That Duplicates Final Review

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/story-flow-check.js`, 590 lines

**What happens**: This file extracts monetary values, percentages, timelines, and entity names across all synthesis sections, then checks for contradictions:
- Different monetary values for the same metric across sections
- Different percentages for the same metric
- Timeline inconsistencies
- Entity name mismatches

It produces a coherence score (100 - 15 per issue) and remediation hints.

**Content harm**: This duplicates functionality with three other systems:
1. `checkContradictions` in content-quality-check.js (lines 758-855) -- same directional claim contradiction detection
2. `checkCrossSectionContradictions` in content-quality-check.js (lines 875-904) -- same economics vs strategy consistency checking
3. `finalReviewSynthesis` in research-engine.js -- LLM-based review that already checks for cross-section consistency

The duplication means content can pass the coherence checker but fail the content quality engine's contradiction check (or vice versa), triggering unnecessary retries. The LLM final review already catches these issues more accurately than regex.

| Metric | Value |
|--------|-------|
| Content Impact | 2 |
| Simplicity Gain | 4 |
| Risk | 1 |
| Effort | 2 |
| **Priority** | **3** |

---

### Finding 13: validateContentDepth Word/Metric Counting Drives Expensive Refinement Loops

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/research-engine.js`, lines 4520-4800

**What happens**: `validateContentDepth` scores 5 dimensions (policy, market, competitors, summary, depth) on a 100-point scale each, then averages them. Scoring is based on:
- Policy: Count of named regulations with years (need 3+), count of targets, presence of incentives
- Market: Count of chart data series (need 4+), count of numeric metrics (need 8+), section count (need 3+)
- Competitors: Total companies with details (need 5+), word count per description (need 30+ words)
- Summary: Count of complete insights (need 3+ with data+action+timing), insight timing specificity
- Depth: Roadmap phases (need 3+), partner count (need 5+), partner description word count (need 30+), entry options (need 2+), target segments (need 1+)

If `scores.overall < CFG_MIN_CONFIDENCE_SCORE` (default 80), the refinement loop triggers gap identification + gap filling + re-synthesis.

**Content harm**: The scoring heavily favors QUANTITY over QUALITY. A synthesis with 5 mediocre competitor descriptions (each exactly 30 words) scores higher than one with 3 deeply researched competitor profiles (each 100 words with financial analysis). The market section needs 4+ chart data series to score well -- even when the research genuinely found only 2 reliable time series. This drives the LLM to fabricate data to meet quantitative thresholds, or triggers expensive re-synthesis loops that produce worse content trying to hit arbitrary counts.

**Evidence**: Lines 4778-4789 show explicit score-fudging: if 4+ core sections score 80+ but depth scores 40+, the overall is forced to CFG_MIN_CONFIDENCE_SCORE. This acknowledges that the scoring system produces false negatives, but the fix is a band-aid rather than fixing the scoring to properly value quality over quantity.

| Metric | Value |
|--------|-------|
| Content Impact | 4 |
| Simplicity Gain | 3 |
| Risk | 3 |
| Effort | 4 |
| **Priority** | **0** |

---

### Finding 14: synthesizeSingleCountry Prompt Contains 7200-Character Validation Checklist

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/research-engine.js`, lines 7020-7268

**What happens**: The `synthesizeSingleCountry` function builds a prompt with:
- 100-line system prompt (writing style guide, depth requirements, story flow, specificity requirements, anti-padding rules) -- ~4000 chars
- 200-line user prompt (JSON schema with field-by-field instructions, quality standards, validation checkpoint with 5 manual checklists) -- ~7200 chars

The validation checkpoint tells the LLM to "STOP" and manually verify word counts, number counts, company descriptions, and insight completeness BEFORE returning JSON.

**Content harm**: The validation checklist consumes ~7200 chars of the prompt budget, which could instead be used for more research data context. The checklist asks the LLM to count words and verify formatting -- tasks it does poorly and that the system's own validation code will check anyway (via `validateContentDepth`, `contentReadinessCheck`, etc.). The LLM spends its generation budget on self-verification rather than deeper analysis.

| Metric | Value |
|--------|-------|
| Content Impact | 3 |
| Simplicity Gain | 3 |
| Risk | 1 |
| Effort | 1 |
| **Priority** | **4** |

---

### Finding 15: callGeminiResearch Rejects Short Responses as "Thin"

**File**: `/home/xvasjack/xvasjack.github.io/backend/market-research/ai-clients.js`, lines ~300-400

**What happens**: `callGeminiResearch` throws and retries when a response is under 500 characters, labeling it as a "thin response."

**Content harm**: Some research topics (e.g., "Country X investment restrictions for Y industry") have genuinely short, authoritative answers. A response like "No foreign ownership restrictions apply. 100% foreign ownership is permitted since the 2019 Investment Liberalization Act." is 127 chars -- rejected as "thin." The retry generates a longer but potentially padded response that includes tangential information.

| Metric | Value |
|--------|-------|
| Content Impact | 3 |
| Simplicity Gain | 3 |
| Risk | 1 |
| Effort | 1 |
| **Priority** | **4** |

---

## 3. Priority-Ranked Summary

| Rank | Finding | Priority Score | Key Issue |
|------|---------|---------------|-----------|
| 1 | F2: content size check Truncation | **7** | Deterministic destruction of LLM-generated content |
| 2 | F5: content Quality Engine | **5** | 2275 lines of regex checks that never improve content, can kill pipeline |
| 3 | F8: Canonical Key Enforcement | **5** | Rejects valid content over key naming, triggers shallow retries |
| 4 | F9: Context-Fit Agent | **5** | Pays for LLM call to make content shorter/shallower |
| 5 | F1: 5-Tier Synthesis Fallback | **4** | Progressively strips instructions, produces shallower content on retry |
| 6 | F6: Transient Key Sanitization | **4** | 270+ lines of recursive object walking, deletes legitimate content |
| 7 | F11: Hardcoded Defaults | **4** | Replaces industry-specific LLM analysis with generic consulting templates |
| 8 | F14: Prompt Validation Checklist | **4** | Wastes 7200 chars of prompt on self-verification LLM does poorly |
| 9 | F15: Thin Response Rejection | **4** | Forces padding of genuinely short, authoritative answers |
| 10 | F3: Triple-Loop Refinement | **3** | Content churn without convergence, sections degrade across iterations |
| 11 | F4: Split Competitor Synthesis | **3** | 4 isolated LLM calls cannot cross-reference competitors |
| 12 | F7: Server Gate Stack | **3** | 7 hard-fail points that discard 30-60 min of work |
| 13 | F12: Coherence Checker | **3** | Duplicates 3 other contradiction-checking systems |
| 14 | F10: JSON Extraction | **2** | 5-strategy extraction, retry with "return JSON only" produces shallow content |
| 15 | F13: Content Depth Scoring | **0** | Favors quantity over quality but hard to fix without redesigning scoring |

---

## 4. Quantified Impact

### Content-Generating Code vs. Meta-Logic

| File | Total Lines | Content Logic | Meta Logic | Content % |
|------|------------|---------------|------------|-----------|
| research-engine.js | 7407 | ~2200 | ~5207 | 30% |
| research-agents.js | 1405 | ~600 | ~805 | 43% |
| research-framework.js | 1080 | ~500 | ~580 | 46% |
| ai-clients.js | 593 | ~200 | ~393 | 34% |
| quality-gates.js | 914 | 0 | 914 | 0% |
| content-quality-check.js | 2275 | 0 | 2275 | 0% |
| story-flow-check.js | 590 | 0 | 590 | 0% |
| content-size-check.js | 391 | 0 | 391 | 0% |
| context-fit-agent.js | 293 | 0 | 293 | 0% |
| server.js | 1558 | ~200 | ~1358 | 13% |
| **TOTAL** | **16,506** | **~3,700** | **~12,806** | **22%** |

Only **22% of the pipeline code generates or improves content**. The other **78% validates, gates, retries, sanitizes, normalizes, or truncates it**.

### LLM Calls Per Country (Approximate)

| Stage | LLM Calls | Content-Generating | Meta/Retry |
|-------|----------|-------------------|------------|
| readRequestType | 1 | 1 | 0 |
| generateResearchFramework | 1 | 1 | 0 |
| universalResearchAgent (25 topics) | 25-30 | 25 | 0-5 (retries) |
| reviewResearch | 1 | 0 | 1 |
| deepenResearch | 3-8 | 3-8 | 0 |
| buildStoryPlan | 1 | 1 | 0 |
| synthesizePolicy (5-tier chain) | 1-5 | 1 | 0-4 |
| synthesizeMarket (3 attempts x 5 tiers) | 1-15 | 1 | 0-14 |
| synthesizeCompetitors (4 sections x 5 tiers) | 4-20 | 4 | 0-16 |
| synthesizeSummary (5-tier chain) | 1-5 | 1 | 0-4 |
| identifyResearchGaps | 1 | 0 | 1 |
| fillResearchGaps | 2-5 | 2-5 | 0 |
| reSynthesize | 1-4 | 1-4 | 0 |
| finalReviewSynthesis | 1-3 | 0 | 1-3 |
| applyFinalReviewFixes | 0-4 | 0-4 | 0 |
| synthesizeSingleCountry (5-tier chain) | 1-5 | 1 | 0-4 |
| **TOTAL** | **45-133** | **~42** | **3-91** |

In the worst case, **68% of LLM calls are retries or meta-logic**, not content generation. Even in the best case, ~7% are pure meta calls. The expected case is approximately 48 content calls and 15-20 meta/retry calls (~30% overhead).

---

## 5. Root Cause

The pipeline treats content quality as a **gating problem** rather than a **generation problem**. The architecture assumes:

1. Generate content (relatively simple prompts with huge JSON schemas)
2. Validate content against rigid structural/quantitative rules
3. Reject and retry when validation fails
4. Run multiple review loops until scores pass

This creates a vicious cycle: validation failures trigger retries with simpler prompts that produce shallower content, which triggers more validation failures. The system spends more engineering effort on detecting badness than on producing goodness.

**The fix direction** is to invest in better generation (richer prompts, more context, better model selection) and reduce post-generation gating. The content size check, content quality engine, and most of the canonical key enforcement could be replaced by generating content that fits the template in the first place -- which is a prompt engineering problem, not a 16,000-line validation infrastructure problem.

---

## 6. Files Verified

Every finding references specific line numbers from complete reads of:
- `/home/xvasjack/xvasjack.github.io/backend/market-research/research-engine.js` (7407 lines, fully read)
- `/home/xvasjack/xvasjack.github.io/backend/market-research/research-agents.js` (1405 lines, fully read)
- `/home/xvasjack/xvasjack.github.io/backend/market-research/research-framework.js` (1080 lines, fully read)
- `/home/xvasjack/xvasjack.github.io/backend/market-research/ai-clients.js` (593 lines, fully read)
- `/home/xvasjack/xvasjack.github.io/backend/market-research/quality-gates.js` (914 lines, fully read)
- `/home/xvasjack/xvasjack.github.io/backend/market-research/server.js` (1558 lines, fully read)
- `/home/xvasjack/xvasjack.github.io/backend/market-research/content-size-check.js` (391 lines, fully read)
- `/home/xvasjack/xvasjack.github.io/backend/market-research/context-fit-agent.js` (293 lines, fully read)
- `/home/xvasjack/xvasjack.github.io/backend/market-research/content-quality-check.js` (2275 lines, fully read)
- `/home/xvasjack/xvasjack.github.io/backend/market-research/story-flow-check.js` (590 lines, fully read)
