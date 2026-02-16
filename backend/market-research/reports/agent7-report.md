# Agent 7 Report: Critical Failure Mode Regression Tests

## Test File
`/home/xvasjack/xvasjack.github.io/backend/market-research/critical-failure-regression.test.js`

## Tests Written

### Suite 1: Content Depth Collapse (6 tests)
Verifies that rich, detailed research content survives quality gates without being reduced to shallow bullet points.

| Test | What It Covers |
|------|---------------|
| Rich synthesis passes content readiness check | A full synthesis with 3 exec summary paragraphs (100+ words each), detailed market data, 4 named competitors with revenue/share, 3 structured insights, and implementation phases passes checkContentReadiness at threshold=80 |
| Rich synthesis has high overall score (>=65) | Same synthesis scores at least 65 even with coherence checker enabled (cross-section number matching can penalize but should not collapse depth) |
| Rich synthesis has no shallow sections detected | No section of the rich synthesis is flagged as shallow by detectShallowContent |
| Deep executive summary is NOT detected as shallow | The 3-paragraph exec summary with specific companies, dollar amounts, percentages, and years is not flagged shallow |
| Research quality gate passes for rich research data | 7 research topics with 300+ chars, company names, years, and dollar amounts pass validateResearchQuality |
| PPT data gate preserves blocks with substantial content | 5 blocks with detailed content pass validatePptData and all are marked renderable by blockHasRenderableData |

### Suite 2: Weak Story Flow Passing (5 tests)
Verifies that disconnected, generic, or contradictory content is correctly rejected by quality checks.

| Test | What It Covers |
|------|---------------|
| Disconnected sections produce low coherence score | Synthesis with unrelated topics across sections (German auto, Vietnam fishing, Australia solar, Brazilian fintech, Canadian mining) gets issues and low score from checkStoryFlow |
| Generic filler content is detected as shallow | 70+ word text with zero specific data points (no $, no %, no years, no company names) is flagged as shallow by detectShallowContent |
| Market size contradictions across sections are flagged | $4.2B in exec summary vs $45B in competitive positioning vs $800M in deal economics produces coherence issues or low score |
| Coherence breaks detect growth rate mismatches | 5.2% vs 28.5% vs 3.1% CAGR across sections produces growth-rate-mismatch breaks from detectCoherenceBreaks |
| Well-connected synthesis gets high coherence score | Synthesis with consistent $4.2B, 12%, and company names across all sections scores >=70 |

### Suite 3: Key Insight Truncation Before Slides (5 tests)
Verifies that safeCell in deck-builder-single.js does not truncate key insights below meaningful length.

| Test | What It Covers |
|------|---------------|
| safeCell does NOT truncate text under 3000 chars | 500+ word insight text passes through safeCell unchanged when STRICT_TEMPLATE_FIDELITY is enabled (default) |
| safeCell preserves 500+ char insights without cutting to 80 | Verifies the old bug (truncating to 80 chars) does not recur. Result must be >300 chars |
| safeCell with explicit maxLen=80 still preserves content | safeCell(text, 80) remaps the tiny cap to 300 chars internally, preventing hard-clipping |
| safeCell hard cap at 3000 chars protects against crashes | 5000-char input is capped at ~3000 chars (safety limit, not content truncation) |
| PPT data gate does not reject blocks with long content | Blocks with 500+ char content fields pass validatePptData without being flagged as non-renderable |

### Suite 4: Review Loop Stagnation (5 tests)
Verifies that review loops terminate after their MAX retry count even when feedback never improves.

| Test | What It Covers |
|------|---------------|
| Review loop with identical feedback stops within 3 iterations | Simulated loop with same issues every round caps at MAX_RETRIES=3 |
| Content review loop caps at MAX_CONTENT_REVIEW_RETRIES=3 | Simulated content review with stagnant score=55 (below 80) terminates at 3 attempts |
| Final deck review loop caps at MAX_FINAL_DECK_REVIEW_RETRIES=5 | Simulated McKinsey-style review with identical issues and ready=false terminates at 5 rounds |
| Stage 2a review loop caps at MAX_STAGE2_REVIEW_RETRIES=3 | Simulated Gemini Pro country review with stillNeedsReview=true terminates at 3 attempts |
| Stagnation detection: same score across 3 attempts is recognized | All attempts recording score=55 are correctly identified as stagnant |

## Test Results

**21 passed, 0 failed**

```
=== Test Suite 1: Content Depth Collapse ===     6/6 PASS
=== Test Suite 2: Weak Story Flow Passing ===    5/5 PASS
=== Test Suite 3: Key Insight Truncation ===     5/5 PASS
=== Test Suite 4: Review Loop Stagnation ===     5/5 PASS
```

## Issues Discovered While Writing Tests

1. **Coherence checker false positive on same-section numbers**: `checkStoryFlow` extracts monetary values from executiveSummary and matches both $4.2B (market size) and $15.5B (JETP funding) as "market size" values within the same section, producing a 3.7x mismatch. The market-size regex (`/market.*?\$[\d,.]+/`) is too broad and captures non-market-size dollar figures when they appear near the word "market" in context. This is not a bug in the test data -- it is a real issue in production where the coherence checker may penalize valid content.

2. **detectShallowContent only catches generic filler at 50+ words**: Content under 50 words skips the density check entirely, meaning short generic text (30-49 words) can pass the shallow detector as long as it avoids template patterns. The `words < 30` check flags very short content, but the 30-49 word gap has no density enforcement.

3. **Review loop stagnation is handled by hard caps, not by detecting repeated feedback**: The server.js review loops (Stage 2a, content review, final deck review) rely on MAX_RETRIES constants (3 or 5) to prevent infinite loops. There is no logic to detect "same feedback returned 3 times in a row" and exit early. This means the system always burns all retry budget even when feedback is not changing. The MISTAKES.md (rows 21, 25) documents this as a known issue.
