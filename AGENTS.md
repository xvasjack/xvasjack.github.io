# Project rules

These rules apply to work in this repository.

## Delivery
- Run the quality checks before release. Fix structural output issues (corrupt PPT, invalid XML or layout objects) before anything else.
- Use the extracted template geometry and styles as the default. Do not drop key analysis only for visual neatness.
- Never commit confidential material: client names, client or employer documents, logos, data from paid databases, personal paths or inboxes.

## Root cause
- No fixes based only on assumptions. Use logs, code and data flow evidence.
- If the evidence is not enough, improve diagnostics first, then re-run.

## Fix and validation loop
- Fix one issue at a time: one issue, one fix, validation, report.
- After each fix, run 2 more verification passes. Cap refinement at 5 rounds per run.
- Queue newly found issues for the next iteration.

## Cost
- Run local and static checks before paid backend runs.
- Prefer deterministic code fixes over repeated reruns.

## Communication
- Write plain English for a non-technical reader. Define any technical word in one short sentence.
- When giving steps, say exactly what to click or type and what result to expect.
- Default to short replies.

## Git
- After a requested change, run the tests, then commit and push.
- If a push fails, explain the blocker in one short line and give one next step.

## Plans
- Plans are concise and specific, presented as a numbered table.
