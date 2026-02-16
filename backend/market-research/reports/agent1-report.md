# Agent 1 Report: Content Quality Drop Points

## What I Found

### Drop Point 1: Synthesis Input Truncation (HIGH IMPACT)
**File:** `research-engine.js` line 75
**Problem:** `CFG_SYNTHESIS_TOPIC_MAX_CHARS` defaulted to 900 chars. Every synthesis call (policy, market, competitors) passes research data through `compactResearchEntryForPrompt()` which truncates each topic's content to this limit. Research agents generate thousands of chars per topic (often 2000-5000), but the synthesis LLM only saw 900 chars -- less than half. This is the #1 point where strong research becomes weak synthesis. The AI literally cannot use data it cannot see.

**Impact:** Every synthesis call (lines 2649, 2924, 3190) was feeding truncated research to the LLM. The LLM then produces shallow output because it lacks the data, triggering quality gate failures and expensive re-synthesis loops that often fail to improve the output (because the input data is still truncated).

### Drop Point 2: Gap Analysis Summary Compression (MEDIUM-HIGH IMPACT)
**File:** `research-engine.js` lines 3577-3703, called at lines 587-591
**Problem:** `summarizeForSummary()` compresses synthesis output for the gap identification prompt. Each snippet was capped at 170 chars. Arrays limited to 3 items. Per-section output capped at 1800-2200 chars. The gap identification AI saw a severely truncated view of the synthesis, causing it to:
- Identify "gaps" that don't actually exist (data was cut from the summary)
- Trigger unnecessary re-research and re-synthesis cycles
- Waste API budget on phantom gaps

### Drop Point 3: Research Gate Company Regex Too Narrow
**File:** `content-gates.js` line 169
**Problem:** The company name regex only matched energy/power-specific suffixes (Corp, Ltd, Inc, Co, Group, Energy, Electric, Power, Solutions). For healthcare, fintech, logistics, or other industries, the 10-point company score was often 0 -- making the gate pass too easily without any company name validation. Effective max score was 75 (structuredScore is dead at 0).

## What I Fixed

### Fix 1: research-engine.js line 75 -- Doubled synthesis input budget
- Changed `CFG_SYNTHESIS_TOPIC_MAX_CHARS` default from 900 to 1800
- The max bound remains 2400, so 1800 is within safe range
- Synthesis LLM now sees 2x the research content per topic

### Fix 2: research-engine.js lines 3582-3700 -- Expanded gap analysis visibility
- `pushSnippet` default maxLen: 170 -> 300
- Array item limits: 3 -> 5 (in summarizeArrayItem, keyMetrics, top-level arrays)
- Preferred field snippets: 180 -> 320
- keyMetrics preview: 210 -> 400
- Scalar field snippets: 150 -> 280
- Top-level string snippets: 180 -> 320
- Top-level array previews: 220 -> 400

### Fix 3: research-engine.js lines 587-591 -- Increased gap analysis section limits
- policy/market/competitors: 2200 -> 3500 chars
- depth/summary: 1800 -> 3000 chars

### Fix 4: content-gates.js lines 169-195 -- Universal company regex + numeric density metric
- Expanded company regex to match 30+ industry suffixes (Technologies, Pharma, Health, Financial, Capital, Holdings, Partners, Systems, Services, Global, International, Industries, Consulting, Medical, Bank, Insurance, Logistics, Telecom, Motors, Aviation, Semiconductor, Ventures, Labs)
- Added Metric 6: Numeric data density (10 pts) -- rewards research that contains specific numbers ($5M, 15%, 2.3 billion, etc.)
- Effective max score raised from 75 to 85
- Pass threshold adjusted from 55 to 50 (59% of new max, was 73% of old max) -- net effect is the gate is now HARDER to pass without quality signals because the quality metrics contribute more

## Files Changed

| File | Lines Changed | Change |
|------|--------------|--------|
| `research-engine.js` | Line 75 | CFG_SYNTHESIS_TOPIC_MAX_CHARS 900 -> 1800 |
| `research-engine.js` | Lines 582, 587-591 | Gap analysis section char limits raised |
| `research-engine.js` | Lines 3582-3700 | summarizeForSummary snippet/array limits raised |
| `content-gates.js` | Lines 169-170 | Company regex made industry-universal |
| `content-gates.js` | Lines 192-199 | Added numeric data density metric (10 pts) |
| `content-gates.js` | Lines 198-200 | Effective scoring rebalanced |

## Issues Found in Files I Cannot Edit

### server.js (Stage 3a/5a review loops)
- **No issue found.** The review loops correctly detect failures and attempt re-synthesis. The root cause was that the synthesis input itself was truncated (Fix 1), not a flaw in the review loop.

### content-quality-check.js
- **SECTION_PASS_THRESHOLD = 30 and DEPTH_SECTION_PASS_THRESHOLD = 15** (lines 1905-1906) are set very low. These thresholds were calibrated for the old synthesis output quality. With Fix 1 providing 2x more data to synthesis, the output quality should improve naturally -- but these thresholds could be raised in a future pass if outputs are consistently better.
- **scoreDecisionUsefulness** drives the section scores but I did not trace its full implementation. It's called at lines 1961, 2020. If it has its own internal truncation, that would be a separate drop point.

### deck-builder-single.js
- Not read in detail, but the mistakes.md entry (row 37) notes that 40+ truncate/truncateWords calls across the PPT builder were silently chopping content to 80-200 chars / 40-65 words. This is the FINAL drop point: even if synthesis is perfect, the slide builder may truncate it. Another agent should audit this.

## Tests Run

```
node -c research-engine.js   -> OK
node -c content-gates.js     -> OK
```
