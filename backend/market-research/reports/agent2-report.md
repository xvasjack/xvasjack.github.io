# Agent 2 Report: Story Flow Quality Check Improvements

## Weaknesses Found

### story-flow-check.js
1. **No disconnected section detection** - The checker only verified numeric/entity consistency. Two sections could talk about completely different topics (e.g., solar energy in Thailand vs automotive in Germany) and get a perfect score.
2. **No generic filler detection** - Boilerplate phrases like "rapidly growing market", "significant growth potential", "favorable regulatory environment" passed unchallenged. The checker had zero awareness of whether content was specific to the actual research topic.
3. **Score threshold too lenient** - Used a flat -15 per issue. One issue = 85/100 ("strong"). A report with market size mismatches AND disconnected sections could still pass as "strong".
4. **Market size mismatch ratio too generous** - Required >3x difference to flag. A 2.5x mismatch in market size across sections ($5B vs $2B) should absolutely be flagged.
5. **Timeline mismatch ratio too generous** - Same problem, required >3x to flag.
6. **explainScore produced generic recommendations** - "Standardize market size figures" without saying what to actually do. Not decision-useful.
7. **No missing critical section detection** - If executiveSummary or keyInsights were entirely absent, no issue was raised.

### content-quality-check.js
1. **getDecisionScore THRESHOLD too low (40)** - Sections with almost no specifics, no named companies, and no actionable content could score 40+ and pass.
2. **analyze pass threshold too low (50)** - Weak content with a score of 50 was marked as passing.
3. **scoreDecisionUsefulness ignored repetition** - Content that repeated the same sentence 5 times in different words scored the same as unique content.
4. **Flagged messages not decision-useful** - Told user "0 companies, 0 numbers, 0 action items" without explaining WHY that matters or WHAT to do about it.

## What Was Fixed

### story-flow-check.js
- **Added topic connectivity detection** (`extractKeywords` + `keywordOverlap`): Measures Jaccard similarity between section keyword sets. Flags sections with <5% overlap as "disconnected" with a -15 penalty.
- **Added generic filler detection** (`detectGenericFiller`): 23 boilerplate phrase patterns, vague-vs-specific quantifier ratio check, country/company name absence check. Applied to all top-level sections.
- **Added missing critical section detection**: executiveSummary, marketOpportunityAssessment, and keyInsights are flagged if absent (-25 each).
- **Tightened mismatch thresholds**: Market size and timeline mismatch ratios lowered from >3x to >2x.
- **Severity-weighted scoring**: Market size/timeline mismatches -20, disconnected sections -15, missing critical sections -25, entity mismatches -10, generic filler -10.
- **Improved explainScore**: Recommendations now start with "ACTION:" and give specific steps. New recommendation categories for disconnected sections, generic filler, and missing sections. Summary for moderate/weak scores now names affected sections and top problems.
- **Exported new helpers** for testing: `extractKeywords`, `keywordOverlap`, `detectGenericFiller`.

### content-quality-check.js
- **Raised getDecisionScore THRESHOLD from 40 to 50**: Sections need real specifics to pass.
- **Raised analyze pass threshold from 50 to 60**: Overall quality bar raised.
- **Added repetition penalty to scoreDecisionUsefulness**: Detects duplicate sentences and repeated sentence starters. Up to -15 point penalty.
- **Improved flagged messages**: Now diagnose WHY a section is weak ("Weak because: no named companies, no specific numbers, no actionable recommendations") instead of just listing counts.

## Files Changed

| File | Lines Added | Lines Removed | Net Change |
|------|-------------|---------------|------------|
| `story-flow-check.js` | ~190 | ~60 | +130 |
| `content-quality-check.js` | ~25 | ~8 | +17 |

## Issues Found in Files I Cannot Edit

### server.js
- No issues found. `checkStoryFlow` is correctly passed as `coherenceChecker` to `checkContentReadiness`. The integration point is clean and does not need changes.

## Tests Run

1. **Syntax check**: `node -c story-flow-check.js` and `node -c content-quality-check.js` -- both pass.
2. **Existing test suite**: `npx jest market-research/content-depth.test.js` -- 70/70 tests pass.
3. **Content readiness tests**: `npx jest market-research/content-readiness-check.test.js` -- 46/46 tests pass.
4. **Smoke tests** (manual):
   - Empty synthesis returns score 0
   - Disconnected sections (solar Thailand vs automotive Germany vs healthcare Africa) correctly flagged with score 70
   - Generic filler detection catches 11 boilerplate phrases in 39 words
   - Keyword overlap: 0.33 for related topics, 0.00 for unrelated topics
   - Repetitive content correctly penalized (-5 points)
   - Vague content correctly flagged with specific diagnosis messages
   - Weak content correctly fails `analyze` pass gate
