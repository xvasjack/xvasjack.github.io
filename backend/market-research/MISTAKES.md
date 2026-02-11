# Mistakes Log (Market Research)

Purpose: record concrete mistakes, why they hurt, and how to prevent repeats.

## 2026-02-11

| # | Mistake | Why it was wrong | Prevention rule |
|---|---------|------------------|-----------------|
| 1 | Ran diagnostics/grep from the wrong path (`/home/xvasjack` instead of repo root). | Lost time and produced false "missing file/repo" errors. | Always run `pwd` + `git rev-parse --show-toplevel` before investigation/edits. |
| 2 | Triggered expensive backend runs before fully hardening known failure paths. | Burned budget on repeated failures that were already visible in logs. | No paid run until static checks + code-path checks pass (see checklist below). |
| 3 | Allowed synthesis prompts to instruct placeholder strings like `"Insufficient research data for this field"`. | Final review flags these as credibility failures; coherence drops below gate. | Use `null`/empty structures, never placeholder prose in client-facing fields. |
| 4 | Accepted `_wasArray` fallback results after retries for key sections. | Schema quality degraded and section integrity became unstable across passes. | For required sections, fail fast or force object re-synthesis; do not silently accept array-converted output. |
| 5 | Relied on repeated deepen/review loops despite persistent `coverage=75` plateau. | High cost with low marginal quality improvement. | Add stagnation detector: if score plateaus across loops, switch strategy (targeted fixes) instead of repeating same loop. |
| 6 | Let summary/insight completeness regress during re-synthesis passes. | Quality gate failed with `only 1 key insights (need ≥3)`. | Re-apply summary completeness guard after every section re-synthesis, not just initial synthesis. |
| 7 | Treated formatting overflow too rigidly in some checks. | Can reduce content quality even when user priority is insight depth. | Content first: allow controlled overflow/flex layout, then trim wording selectively. |
| 8 | Did not enforce a strict "pre-run QA contract" before long runs. | Repeated runtime discovery of issues that should be caught locally. | Use mandatory pre-run QA checklist and block run if any item fails. |
| 9 | Let `review-deepen` loops continue when coverage repeatedly plateaued at 75/100. | Burned cost with near-zero quality gain. | Detect stagnation and stop repeated deepen cycles when score delta is negligible across passes. |
| 10 | Allowed policy/market retries to continue even when array payload was already salvageable. | Extra paid model calls were spent on retries that were not improving structure. | Normalize and validate array-tagged payloads early; accept salvage when core sections are present. |
| 11 | Kept strict overflow-related hard failures in depth/competitor validation. | Penalized content quality despite user priority on insight depth. | Treat overflow as warning-level for validation; only hard-fail for thin/empty content or broken output. |
| 12 | Re-synthesis prompt still asked to flag uncertainty with terms like "estimated/unverified". | Encouraged wording that later quality checks treat as weak/placeholder content. | Force `null`/empty values for uncertain data and ban hedging placeholders in re-synthesis prompts. |
| 13 | Final-review fixer listed `depth` in re-synthesis targets but did not implement a `depth` fix path. | Major depth issues remained unresolved across passes, keeping coherence below gate and wasting loops. | Keep fixer capabilities in lockstep with allowed `sectionFixes`; add explicit `depth` handling with summary/depth regeneration. |
| 14 | Allowed off-scope gap/deepen queries (e.g., adjacent sectors) to enter the pipeline. | Created narrative drift, inconsistent policy/market storyline, and lower coherence despite high raw score. | Sanitize all generated queries by country/industry scope before running research. |
| 15 | Final-review stagnation signature keyed on verbose issue text. | Small wording changes bypassed stagnation detection, causing repeated expensive cycles on same issue set. | Use normalized issue signatures (severity+section+type+query signature), not free-text descriptions. |
| 16 | Universal agent merged failed first-pass content with retry-success content. | Contradictory claims from failed output leaked into synthesis, damaging coherence and trust. | On successful retry, replace content/citations with retry payload; never concatenate failed + fixed outputs. |
| 17 | Market synthesis lacked robust unwrapping of nested `section_0`/numeric containers. | Valid data looked "thin" to validators, triggering unnecessary retries and extra model spend. | Normalize nested/array-shaped market payloads before validation and quantify from normalized sections. |
| 18 | Final review escalated credibility/placeholder issues to new research queries. | Wasted budget hunting data instead of removing unsupported claims from synthesis. | Force suspicious/hallucination cleanup to `synthesis` escalation and sanitize/drop speculative gap queries. |
| 19 | Treated reviewer scores as raw values without numeric normalization. | String-like scores (e.g., `"75/100"`) bypassed stagnation guards, causing redundant 5-pass loops. | Normalize all scores with robust parsing before comparisons and gate checks. |
| 20 | Allowed legal/research gaps that were not grounded in synthesized evidence. | Triggered speculative searches (hallucinated decrees/resolutions), adding cost and coherence noise. | Drop legal-token gaps unless the same token already appears in synthesized content. |
| 21 | Ignored array payload variants in policy normalization (arrays inside `section_n`). | Policy retries repeated despite salvageable payload structure. | Normalize both object and array section payloads; map arrays to acts/targets/incentives where structurally valid. |
| 22 | Did not enforce default slide-title hygiene in section validators. | Final review flagged "sloppy slide titles," lowering coherence despite adequate data. | Apply deterministic fallback titles for policy/market/competitor sections during validation. |

## Mandatory Pre-Run QA Checklist (Before Any Paid Run)

1. `pwd` and repo root verified.
2. Lint/type/syntax checks pass for edited files.
3. No prompt text that asks model to output placeholder prose.
4. `_wasArray` handling for policy/market/competitors is strict (no silent degrade path).
5. Summary guard guarantees >=3 structured key insights after any re-synthesis.
6. Quality gate logic inspected for dead loops/stagnation behavior.
7. Formatting pipeline validated locally (slide size, font family, table margins/borders, header/footer geometry).
8. Only then trigger backend run.
