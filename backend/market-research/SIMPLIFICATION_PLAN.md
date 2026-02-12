# Simplification Plan (Cost + Stability First)

## Why this exists
Recent runs showed expensive loop churn, repeated JSON repair retries, and flash quota exhaustion before final readiness gates passed.

This plan keeps quality strict while reducing unnecessary complexity and token burn.

## Hard rule
- Do not overengineer runtime control loops.
- Default to simple controls first: 10s retry base delay + reduced parallelism.
- Any added complexity must prove direct impact on cost, stability, or output quality.

## Current assessment

### 1) Content depth / insight / storyflow
- Strength: research and synthesis can reach high coherence.
- Weakness: final pass can fail by 1-2 points from depth-gate drift after many loops.
- Main cost driver: repeated refine/review cycles with limited marginal gain.

### 2) Formatting fidelity
- Strength: template fidelity gates are now hard-fail in server runtime.
- Risk: any non-template fallback behavior must remain blocked in production path.

### 3) Truncation / malformed JSON
- Strength: fallback chain and repair logic already reduce hard failures.
- Weakness: long prompts still increase malformed JSON probability and retry count.

## Overengineering diagnosis
- Too many iteration loops by default (review-deepen, refinement, final review all high).
- Heavy synthesis retries before early stop.
- High token payloads per synthesis call.
- Rate-limit handling relied mostly on per-call backoff, not shared model cooldown.

## Implemented now
- Lower default iteration limits (5 -> 3):
  - `REVIEW_DEEPEN_MAX_ITERATIONS`
  - `REFINEMENT_MAX_ITERATIONS`
  - `FINAL_REVIEW_MAX_ITERATIONS`
- Hard-cap env overrides for iteration loops:
  - even if env is set higher, loops are bounded to `3` to prevent runaway spend
- Added model-level cooldown lock on 429 in `ai-clients.js`:
  - shared cooldown per model key
  - all calls wait for cooldown before firing
- Reduced synthesis prompt payload caps (`maxContentChars` to 2600 for policy/market/competitors).
- Simplified market retry strategy:
  - retries reduced to 2
  - final retry uses strict minimal flash-only path (no pro-tier escalation in that branch)
- Throttled research execution:
  - dynamic category agents now run in small batches (default concurrency `2`)
  - specialized fallback agents now run in small batches (default concurrency `2`)
  - universal/context/policy/competitor/depth/insight topic runs are batch-throttled (default concurrency `2`)
- Throttled deepen execution:
  - follow-up gap queries now run in small batches (default concurrency `2`)
- Increased batch spacing to reduce token-per-minute bursts:
  - `DYNAMIC_AGENT_BATCH_DELAY_MS` default `3000`
  - `DEEPEN_BATCH_DELAY_MS` default `3000`
- Increased synthesis spacing defaults:
  - section-to-section delay `SECTION_SYNTHESIS_DELAY_MS` default `5000`
  - competitor sub-section delay `COMPETITOR_SYNTHESIS_DELAY_MS` default `5000`
  - final-review section-fix delay `FINAL_FIX_SECTION_DELAY_MS` default `3000`
- Increased gap/verification spacing:
  - `GAP_QUERY_DELAY_MS` default `3000`
- Reduced deepen query caps:
  - review-deepen pass cap `REVIEW_DEEPEN_MAX_QUERIES` default `8`
  - final-review escalation cap `FINAL_REVIEW_MAX_QUERIES` default `6`
- Added anti-churn guard in review-deepen:
  - if reviewer coverage drops sharply versus the best observed score, revert to best research snapshot and stop the loop
- Hardened market key canonicalization:
  - merged key aliases like `supplydemandDynamics`, `pricingAndTariffs`, and `segmentAnalysis` map to canonical market sections instead of triggering retry churn.

## Next safe simplifications (if needed)
- Add per-section retry budget (hard cap on model calls per section per run).
- Collapse duplicate reviewer passes when issue signature is unchanged.
- Keep a single synthesis strict mode for market/policy/competitors unless explicit debug mode is enabled.
