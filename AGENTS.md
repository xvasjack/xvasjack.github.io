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
- HARD RULE: Explain everything in "like I am 5 years old" plain English unless the user asks for technical depth.
- Assume the user is non-technical by default.
- Do not use jargon. If a technical word is unavoidable, define it in one very short sentence right away.
- When giving steps, write exactly what to click/type and what result to expect.
- Replace command-heavy wording with simple meaning-first wording (example: "check what changed" before command names).
- Response length rule: default to 1-2 short lines only.
- No code blocks, command snippets, or technical dumps unless the user explicitly asks for them.

## 8) Git Push Policy (Hard Rule)
- AUTOPUSH: After I complete a requested file/code change, I must save and push it to `main` automatically.
- Skip AUTOPUSH only if the user clearly says "do not push", "local only", or "draft only".
- If push fails, explain the blocker in one short line and give one short next step.

## 9) Plan Writing Format (Hard Rule)
- Plans must be concise, specific, and complete in plain English.
- For each requested change, always show: exact row text + plain meaning + exact reason.
- Do not include generic summaries, API/interface notes, test sections, or assumptions unless explicitly requested.
- ALWAYS present plans in a table.
- ALWAYS include `#` as the first column so issues are easy to reference by number.
- Default to one numbered table with short cells unless the user explicitly asks for a different format.
- Required table columns: #, Slide, Exact row text, Action, Fix layer (Prompt/Validator/Hard filter), Scope (which slides), Reason.
- Never use vague wording like "long list" or "noise" without showing the exact text example.
- For every removal rule, state clearly if it applies to all slides or only specific slides.
