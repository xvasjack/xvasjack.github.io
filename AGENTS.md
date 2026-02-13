# Project Rules: Market Research Deck

These rules are mandatory for work in this repository.

## 1) Core Delivery Targets
- Content quality is primary and must clear effective score >= 80 before shipping.
- Storyline must be insight-driven (clear "why now", causal logic, actionable recommendation).
- Formatting must follow Escort template extraction (template-repository driven slide mapping).

## 2) Formatting Policy
- Use extracted template geometry/styles as default.
- Minor overflow is acceptable when needed to preserve critical analysis.
- Do not drop key insights purely for visual neatness.
- Hard-fail only on structural output issues (corrupt PPT, invalid XML/layout objects).

## 3) Root-Cause Standard
- No assumption-only fixes. Use logs/code/data-flow evidence.
- If evidence is insufficient, improve diagnostics first, then re-run.

## 4) Fix/Validation Loop
- After each fix, run 2 additional verification passes.
- Cap refinement at 5 rounds per run.
- Stop repeated deepen loops when score plateaus (stagnation guard).

## 5) Cost Discipline
- Do local/static checks before paid backend runs.
- Avoid repeated expensive retries when payload is already salvageable.
- Prefer deterministic code fixes over repeated blind reruns.
- Normalize reviewer scores before loop/gate comparisons (avoid string-score loop bugs).
- Reject speculative legal/decree research gaps unless grounded in synthesized evidence.

## 6) Execution Discipline (Ultra Important)
- Fix exactly one issue at a time.
- Do not batch-fix multiple root causes in a single iteration.
- Each iteration must follow: one issue -> one fix -> validation -> report.
- If additional issues are discovered, queue them for the next iteration instead of changing scope.

## 7) Communication Clarity (Ultra Important)
- Always explain in high-school-level plain English.
- Avoid jargon whenever possible.
- If a technical term must be used, define it in one short sentence.
- Prefer short examples/analogies over abstract wording.
