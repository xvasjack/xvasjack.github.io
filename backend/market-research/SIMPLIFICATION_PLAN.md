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
- Added model-level cooldown lock on 429 in `ai-clients.js`:
  - shared cooldown per model key
  - all calls wait for cooldown before firing
- Reduced synthesis prompt payload caps (`maxContentChars` to 2600 for policy/market/competitors).
- Simplified market retry strategy:
  - retries reduced to 2
  - final retry uses strict minimal flash-only path (no pro-tier escalation in that branch)
- Reduced review-deepen query fan-out default from 20 to 12.
- Throttled research execution:
  - dynamic category agents now run in small batches (default concurrency `2`)
  - specialized fallback agents now run in small batches (default concurrency `2`)
  - universal/context/policy/competitor/depth/insight topic runs are batch-throttled (default concurrency `2`)
- Throttled deepen execution:
  - follow-up gap queries now run in small batches (default concurrency `2`)
- Hardened market key canonicalization:
  - merged key aliases like `supplydemandDynamics`, `pricingAndTariffs`, and `segmentAnalysis` map to canonical market sections instead of triggering retry churn.

## Next safe simplifications (if needed)
- Add per-section retry budget (hard cap on model calls per section per run).
- Collapse duplicate reviewer passes when issue signature is unchanged.
- Keep a single synthesis strict mode for market/policy/competitors unless explicit debug mode is enabled.
