# Agent 6: Pre-Run Reliability Audit Report

## Runtime Risks Found (ranked by likelihood)

### 1. FIXED - callGeminiResearch silently swallows 4xx API errors (HIGH)
- **File**: `ai-clients.js`, lines 383-401 (original)
- **Risk**: When Gemini returns 400/401/403 (invalid key, quota exceeded, malformed request), the function returned `{ content: '', citations: [], researchQuality: 'failed' }` instead of throwing. Downstream code processed this empty content as a valid response, causing:
  - Silent data loss on every research topic when API key is invalid
  - Thin-response retries that waste budget on doomed requests
  - Empty research sections that pass through synthesis with no useful content
- **Impact**: Every research topic silently fails. Pipeline continues burning budget on synthesis/review loops for empty data.
- **Fix**: Now throws with `error.nonRetryable = true` for 4xx (non-429), matching callGemini and callGeminiPro patterns. Rate-limit (429) and server errors (5xx) still retry with cooldown.

### 2. FIXED - callGeminiResearch fetch not linked to pipeline abort signal (HIGH)
- **File**: `ai-clients.js`, lines 370-380 (original)
- **Risk**: The function creates its own AbortController for the 180s timeout but never links it to `pipelineSignal`. When the pipeline is aborted (user cancellation, pipeline timeout), in-flight HTTP requests continue running until the 180s timeout expires. With 25+ research topics running sequentially, this means:
  - Up to 180s wasted per in-flight request after abort
  - Gemini API tokens consumed for results that will be discarded
  - Pipeline cannot shut down promptly
- **Impact**: Abort signal is ineffective for the highest-volume API call in the system (25+ calls per run).
- **Fix**: Added listener that forwards `pipelineSignal.abort` to the fetch AbortController. Cleaned up in `finally` block to prevent memory leaks.

### 3. server.js starts with missing GEMINI_API_KEY (MEDIUM) - NOT FIXED (read-only)
- **File**: `server.js`, lines 77-81
- **Risk**: `GEMINI_API_KEY` is listed as required but the check only logs a warning. Server starts and accepts requests, which then fail at the first callGemini/callGeminiResearch call. The error is sent via email to the user but only after pipeline setup work is already done.
- **Recommendation for server.js owner**: Add `process.exit(1)` when critical env vars are missing, or at minimum return 503 from the API endpoint when GEMINI_API_KEY is not set.

### 4. research-engine.js identifyResearchGaps has bare inline retry without backoff (MEDIUM) - NOT FIXED (read-only)
- **File**: `research-engine.js`, lines 666-674
- **Risk**: When the first `callGemini` for gap identification fails, the retry is immediate (no delay, no exponential backoff). Under rate limiting, this guarantees the retry also fails.
- **Recommendation for research-engine.js owner**: Use `withRetry` wrapper or add a delay between the two attempts.

### 5. preflight-release.js unguarded require of preflight-gates.js at line 947 (LOW)
- **File**: `scripts/preflight-release.js`, line 947
- **Risk**: `const { checkRealOutputValidation } = require(...)` is outside any try-catch. If `preflight-gates.js` has a load error, the entire preflight script crashes with an unhandled exception instead of a clean FAIL report.
- **Not fixed**: Low likelihood in production. The module is checked earlier in the flow (smoke-release-readiness.js wraps it in try-catch).

### 6. Global costTracker race condition on concurrent requests (LOW) - NOT FIXED (read-only)
- **File**: `server.js`, lines 1129-1132
- **Risk**: `costTracker.totalCost` and `runBudgetUsed` are reset at the start of each request. If two requests run concurrently, the second request resets budget tracking for the first. The code has a comment acknowledging this ("acceptable for single-instance deployment").
- **Impact**: Only matters if concurrent requests are ever enabled. Currently single-instance.

## Files Changed

| File | Lines Changed | What Changed |
|------|--------------|--------------|
| `ai-clients.js` | ~383-401 | 4xx error handling: throw instead of silent empty return |
| `ai-clients.js` | ~370-380 | Added pipelineSignal forwarding to fetch AbortController |
| `ai-clients.js` | ~488-492 | Added cleanup of pipelineAbortHandler in finally block |

## Syntax Check Results
- `ai-clients.js`: PASS
- `scripts/smoke-release-readiness.js`: PASS (no changes)
- `scripts/preflight-release.js`: PASS (no changes)

## Risks in Files I Could Not Edit

| File | Risk | Severity | Description |
|------|------|----------|-------------|
| `server.js` | Missing env var soft-fail | MEDIUM | Server starts without GEMINI_API_KEY, first request fails at runtime |
| `server.js` | Concurrent request race condition | LOW | costTracker/budget reset affects concurrent requests |
| `research-engine.js` | Bare retry without backoff | MEDIUM | identifyResearchGaps retries immediately on failure, no delay |
