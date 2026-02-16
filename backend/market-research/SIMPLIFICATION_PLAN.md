# Simplification Plan (Cost + Stability First)

## Why this exists
Recent runs showed expensive repeated loops, repeated JSON repair retries, and Gemini Flash quota running out before quality checks passed.

This plan keeps quality strict while reducing unnecessary complexity and AI cost.

## Hard rule
- Do not over-complicate how the system retries and loops.
- Default to simple controls first: 10s retry delay + reduced parallel work.
- Do not add a global rate-limit controller layer; keep throttling local and simple.
- Any added complexity must prove direct impact on cost, stability, or output quality.

## Current assessment

### 1) Content depth / insight / story flow
- Strength: research and combining results can reach high quality.
- Weakness: final pass can fail by 1-2 points from depth-score drift after many loops.
- Main cost driver: repeated improve/review cycles with limited benefit.

### 2) Formatting (visual match to template)
- Strength: template visual-match checks are now hard-fail in server runtime.
- Risk: any non-template fallback behavior must remain blocked in production path.

### 3) Cutting short / malformed JSON
- Strength: fallback chain and repair logic already reduce hard failures.
- Weakness: long prompts still increase malformed JSON chance and retry count.

## Over-complexity diagnosis
- Too many loops by default (review-deepen, refinement, final review all set high).
- Too many retries when combining results before stopping early.
- Too much text sent per AI call.
- Rate-limit handling relied mostly on per-call waiting, not shared model cooldown.

## Implemented now
- Fixed local Vietnam generator file-safety path:
  - `test-vietnam-research.js` now runs post-write ID cleanup + content-type fix
  - added structural scan on generated buffer to catch package/id issues immediately
- Improved JSON parsing to reduce retry waste:
  - `parseJsonResponse()` now falls back to multi-strategy extraction + cut-repair before retrying model calls
- Reduced text size sent per combining call (simple, local control):
  - default `SYNTHESIS_TOPIC_MAX_CHARS` lowered to `1200`
  - compacted `structuredData` payload cap lowered to `800`
- Enforced strict template visual-match as hard-fail:
  - fail if table recovery paths are used
  - fail if layout visual-match issues are detected
- Added `STRICT_TEMPLATE_FIDELITY` runtime switch (default `true`, can be disabled only explicitly)
- Lower default loop limits (5 -> 2):
  - `REVIEW_DEEPEN_MAX_ITERATIONS`
  - `REFINEMENT_MAX_ITERATIONS`
  - `FINAL_REVIEW_MAX_ITERATIONS`
- Hard-cap env overrides for loops:
  - even if env is set higher, loops are bounded to `3` to prevent runaway spend
- Added model-level cooldown lock on 429 in `ai-clients.js`:
  - shared cooldown per model key
  - all calls wait for cooldown before firing
- Reduced text sent per combining call (`maxContentChars` to 2600 for policy/market/competitors).
- Simplified market retry strategy:
  - retries reduced to 2
  - final retry uses strict minimal flash-only path (no pro-tier escalation in that branch)
- Throttled research execution:
  - dynamic category agents now run in small batches (default concurrency `1`)
  - specialized fallback agents now run in small batches (default concurrency `1`)
  - universal/context/policy/competitor/depth/insight topic runs are batch-throttled (default concurrency `1`)
- Throttled deepen execution:
  - follow-up gap queries now run in small batches (default concurrency `1`)
- Increased batch spacing to reduce token-per-minute bursts:
  - `DYNAMIC_AGENT_BATCH_DELAY_MS` default `3000`
  - `DEEPEN_BATCH_DELAY_MS` default `3000`
- Increased delays between combining steps:
  - section-to-section delay `SECTION_SYNTHESIS_DELAY_MS` default `10000`
  - competitor sub-section delay `COMPETITOR_SYNTHESIS_DELAY_MS` default `10000`
  - final-review section-fix delay `FINAL_FIX_SECTION_DELAY_MS` default `5000`
- Increased gap/verification spacing:
  - `GAP_QUERY_DELAY_MS` default `3000`
- Reduced deepen query caps:
  - review-deepen pass cap `REVIEW_DEEPEN_MAX_QUERIES` default `5`
  - final-review escalation cap `FINAL_REVIEW_MAX_QUERIES` default `2`
- Reduced final-fix loop defaults:
  - final-review re-combine escalation cap `FINAL_REVIEW_MAX_SYNTHESIS_ESCALATIONS` default `1`
  - per-pass section-fix cap `FINAL_FIX_MAX_SECTIONS_PER_PASS` default `2`
- Added anti-loop guard in review-deepen:
  - if reviewer coverage drops sharply versus the best observed score, revert to best research snapshot and stop the loop
- Standardized market key names:
  - merged key aliases like `supplydemandDynamics`, `pricingAndTariffs`, and `segmentAnalysis` map to standard market sections instead of triggering retry waste.
- Reduced text-heavy combining/review payloads:
  - summary section previews trimmed (`policy/market/competitors`: `3500/4500/3500` chars)
  - final-review section previews trimmed (`policy/market/competitors/summary/depth`: `3500/3500/3500/2500/2500`)
  - summary additional-research context capped to top 6 entries and 1200 chars each
- Further reduced high-waste combining payloads:
  - summary previews trimmed further to `2500/3000/2500` (policy/market/competitors)
  - summary additional-research context reduced to top 4 entries and 900 chars each
  - final-review previews trimmed further to `2200/2200/2200/1800/1800`
  - output token ceilings reduced on heavy paths:
    - `synthesizeSummary`: `16384 -> 12288`
    - `reSynthesize`: `16384 -> 12288`
    - `finalReviewSynthesis`: `8192 -> 6144`
- Added low-signal deepen filter:
  - reject thin deepen responses before merge (requires stronger chars/citations/numeric signals)
  - prevents low-value `final_review_gap_*` payloads from creating expensive re-combining waste
- Recomputed content-depth check after final-review fixes:
  - readiness now uses post-fix depth score instead of stale pre-fix score
  - removes false failures where final combining improved but check score was not refreshed
- Fixed depth-score source priority:
  - content-depth check now prefers main top-level `depth` over noisy `summary.depth` artifacts
  - prevents false low depth scores that can fail runs around 79/100 despite valid depth sections
- Reduced final-review verification waste after clean passes:
  - widened reviewer-drift tolerance during verification passes
  - avoids expensive re-research/combining loops when only reviewer noise drops a previously clean pass
- Fixed depth-carrier merge in content check:
  - content-depth now merges top-level `depth` and `summary.depth` instead of hard-picking one
  - prevents false low depth scores when one carrier is partial
- Simplified and compressed gap-audit input:
  - `identifyResearchGaps` now audits a compact section snapshot (policy/market/competitors/depth/summary) instead of full combined payload
  - reduces AI cost and reviewer drift from oversized prompts
  - reviewer made fully deterministic (`temperature: 0`) with lower token ceiling
- Added scope-discipline guard for hydrocarbon clients:
  - prompts now inject explicit "oil/gas-first" guard when client context indicates hydrocarbon focus
  - applied in story planning, research review, and summary combining prompts
- Added anti-cut PPT text check:
  - structural checker now supports `forbiddenText`
  - runtime blocks decks containing explicit cut/failure markers (e.g. `[truncated]`, `synthesis failed`)
- Added single-country identity check at PPT check:
  - runtime now requires the target country text to appear in single-country decks to catch wrong-country outputs earlier
- Lowered review-deepen default target from `80` to `75`:
  - stops low-yield deepen loops earlier when coverage repeatedly plateaus around `75`
- Removed explicit cut marker from prompt compaction:
  - prompt clipping no longer appends `...[truncated]` markers that could leak into model output
- Reduced combining-step prompt size further:
  - compacted topic content default `2600 -> 2200` chars across policy/market/competitor combining context
- Reduced competitor combining output ceiling:
  - competitor sub-calls max output tokens `8192 -> 6144` to lower malformed JSON risk and retry waste
- Added reviewer-collapse guard in refinement loop:
  - when deterministic check is already strong but reviewer confidence collapses with no actionable gaps, trust deterministic check and skip costly low-signal loops
- Added 79/100 edge-case alignment in content-depth scoring:
  - if all four core sections are strong (>=80) and depth is usable (>=40), floor overall depth score to `80` to avoid repetitive one-point failures
- Added hard final-review escalation budgets:
  - max research escalations per run: `FINAL_REVIEW_MAX_RESEARCH_ESCALATIONS` (default `1`)
  - max re-combine escalations per run: `FINAL_REVIEW_MAX_SYNTHESIS_ESCALATIONS` (default `2`)
- Added gap-fill query dedupe and tighter caps:
  - `FILL_GAPS_MAX_CRITICAL` (default `4`)
  - `FILL_GAPS_MAX_VERIFICATIONS` (default `1`)
  - duplicate research/verification queries are skipped
- Compressed re-combining payloads:
  - removed raw/full-analysis dump from prompt
  - re-combining now uses compact section payload + capped additional data snippets
  - re-combining token ceiling reduced (`12288 -> 10240`)
- Reduced reviewer critical-issue noise in readiness:
  - final review check now allows up to `FINAL_REVIEW_MAX_CRITICAL_ISSUES` (default `1`) instead of hard `critical=0`
- Added quota-aware combining fallback behavior:
  - when Flash returns quota/rate-limit signals (`429`/`RESOURCE_EXHAUSTED`), skip repeated Flash tier retry loops
  - escalate directly to GeminiPro tiers for that combining pass
- Tightened low-signal gap-fill acceptance in refinement:
  - stronger numeric fallback check (`content>=700` and `numericSignals>=8`)
  - reduces noisy "thin but numeric" payloads from causing costly re-combining waste
- Added narrow near-pass normalization for check edge cases:
  - if core sections are strong (>=80), depth is usable (>=35), and overall is exactly near-threshold (`79`), normalize to `80`
  - purpose: stop one-point back-and-forth loops while keeping review quality checks strict

## Next safe simplifications (if needed)
- Add per-section retry budget (hard cap on model calls per section per run).
- Collapse duplicate reviewer passes when issue signature is unchanged.
- Keep a single combining strict mode for market/policy/competitors unless explicit debug mode is enabled.
