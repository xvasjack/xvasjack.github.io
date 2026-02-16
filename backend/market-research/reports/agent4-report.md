# Agent 4 Report: Stage 9a Final Review Loop Stabilization

## Current Review Loop Behavior (Before Fix)

**File:** `/home/xvasjack/xvasjack.github.io/backend/market-research/server.js`

### Problems Found

1. **Max rounds too high (5):** Each round costs a Gemini review call + a Gemini synthesis rewrite call + a full PPT rebuild. 5 rounds = up to 15 LLM calls just for the polish pass. Most useful feedback comes in rounds 1-2.

2. **No convergence tracking:** If round 1 says "slide 3 needs more data" and the fixer adds data, round 2 might say the same thing again (different reviewer call, same LLM nondeterminism). The loop would keep trying to fix the same issue forever until it hit the max.

3. **Flip-flop between rounds:** No mechanism to prevent contradictory feedback. Round 1 could say "add more detail to market size section," round 2 could say "market size section is too cluttered, simplify." The synthesis edit function would apply both contradictory changes, oscillating the content.

4. **Screenshot-missing fallback was weak:** When LibreOffice/pdftoppm were unavailable (common on Railway), `buildFinalReviewImages` returns empty. The text fallback was attempted but the reviewer prompt didn't change its guidance -- it still looked for visual/formatting issues it couldn't possibly verify from text alone, generating phantom issues.

5. **Failed review calls created phantom issues:** If `reviewDeckBeforeDeliveryWithGeminiFlash` threw (API timeout, rate limit), `finalDeckReview` stayed null. The code then created a fake "final deck reviewer marked not ready" issue and spent a full round trying to "fix" something that wasn't actually wrong -- the review just failed.

6. **Hard failure on exhaustion:** After 5 rounds, if the reviewer never said `ready=true`, the entire pipeline threw an error. This is wrong because stages 2a, 3a, 5a, and 9 already validated content quality and structural integrity. Stage 9a is a polish pass; it should not hard-fail the entire delivery.

## What Was Fixed

### 1. Reduced max rounds from 5 to 3
- 3 rounds is sufficient for meaningful feedback. Beyond that, diminishing returns.
- Saves 2 full cycles of (review + rewrite + rebuild) = ~6 fewer LLM calls.

### 2. Convergence tracking
- Added `issueOccurrenceCount` map that normalizes issue text and counts appearances across rounds.
- `ISSUE_ACCEPT_THRESHOLD = 2`: After an issue appears in 2 rounds, it's accepted (filtered out). The loop stops trying to fix it.
- Prevents infinite retry on issues the fixer can't resolve.

### 3. Flip-flop / contradiction detection
- Added `filterContradictoryIssues()` that compares current round issues against all prior locked decisions.
- Uses token-overlap similarity (>60% overlap = contradiction). Simple but effective for catching "add detail" vs "simplify" type reversals.
- Contradictory issues are silently dropped before being sent to the fixer.

### 4. Effective readiness from filtering
- `effectiveReady = ready || nonContradictoryMessages.length === 0`: If the reviewer says not-ready but ALL its issues are either recurring (accepted) or contradictory (filtered), the deck is accepted.
- This is the key convergence mechanism -- the loop naturally terminates when it has nothing new to fix.

### 5. Screenshot-missing content-only review mode
- When screenshots AND text fallback are both unavailable, `effectiveInputMode` is set to `content_review_only`.
- The reviewer prompt is adjusted: "Review the SYNTHESIS CONTENT ONLY... Do NOT flag visual/formatting issues since you cannot see the slides."
- For text-only fallback: prompt says "Do NOT flag visual formatting issues you cannot verify from text alone."
- Prevents phantom visual issues when the reviewer has no visual input.

### 6. Null review graceful handling
- If the Gemini review call throws/returns null, the round is skipped (no phantom issues created).
- On the final attempt, if review is still unavailable, the deck is accepted as-is (prior quality gates already passed).

### 7. Soft failure on exhaustion (no more hard throw)
- Instead of `throw new Error("Final deck review failed...")`, the loop now logs a warning and accepts the deck with `acceptedWithWarnings = true`.
- Rationale: stages 2a/3a/5a/9 already validated content and structure. Stage 9a is polish, not correctness.
- `lastRunRunInfo.finalDeckReviewLoop.acceptedWithWarnings` and `.remainingIssues` are set so downstream can see what happened.

### 8. Stronger anti-flip-flop in reviewer prompt
- Added explicit locked-decisions section to the prompt: "Locked decisions from prior rounds (DO NOT reverse these)"
- Added rules: "focus ONLY on issues that were NOT already addressed" and "Issues that have been raised and attempted multiple times should be accepted as-is."
- Added per-mode input guidance so the reviewer knows what it can and cannot see.

## Files Changed

| File | Section | Lines Changed |
|------|---------|---------------|
| `server.js` | `reviewDeckBeforeDeliveryWithGeminiFlash` prompt (lines ~724-752) | Replaced prompt with mode-aware, anti-flip-flop version |
| `server.js` | Stage 9a loop (lines ~2753-2951) | Replaced with convergence-tracked, contradiction-filtered version with soft failure |

Total: ~200 lines replaced/added in one file.

## Tests Run

- `node -c server.js` -- syntax check passed (exit 0, no output)
- No runtime test available (would require full pipeline execution with Gemini API keys)
