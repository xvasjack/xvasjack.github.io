# Profile Slides Comparison Notes

Date: 2026-03-06
Scope: Comparison based on the screenshots shared (target-list summary + company slides 1-3).

## Summary Slide (Target List)
What is better in old:
- Full list is visible in one place.

What is better in new:
- None yet on readability when many service columns appear.

What to improve now:
- Keep max 6 service columns per slide.
- If more than 6, split into multiple summary slides (same companies, next set of service columns).
- Keep service header text short (2 lines max) so columns stay readable.

Status:
- Implemented in code: summary slide now auto-splits to max 6 service columns per slide.

## Slide 1 (Osadi)
What is better in old:
- Better visual balance.
- Financial chart is easy to read.
- Less text clutter.

What is better in new:
- More detail on offerings and partners.

What to improve now:
- Remove yellow placeholder text (`check speeda & DBD`) before final output.
- Trim left table content so no overflow at the bottom.
- Keep only highest-value rows on the main slide; move extra detail to appendix/backup.
- Add financial section back when usable figures exist.

## Slide 2 (LME)
What is better in old:
- Cleaner service area and chart section.
- Easier for client to scan quickly.

What is better in new:
- More complete list of services.

What to improve now:
- Reduce long service bullets into short, punchy lines.
- Prevent footer/notes overlap at bottom.
- Ensure company naming is normalized and consistent.
- Keep the right panel from becoming text-heavy.

## Slide 3 (Truly Resources)
What is better in old:
- Better readability and spacing.
- Financial block adds decision value.

What is better in new:
- Export/service detail is richer.

What to improve now:
- Remove unresolved placeholder text.
- Replace shorthand labels (for example: `r.o.s`, `c.o.s`, `pbs`, `hts`) with plain labels.
- Cap visible rows so content does not spill outside the slide.
- Keep country/service lists concise on the main page.

## Cross-Slide Hard Fixes Before Client Use
- No placeholder text allowed.
- No text overflow outside slide boundaries.
- Keep one clean style for labels and company names.
- Keep financial section when data exists; if no data, show a clear "data unavailable" block.
- Keep readability first: shorter lines, fewer rows, consistent spacing.

## Priority Order
1. Overflow and placeholder cleanup (must-fix).
2. Label simplification and naming consistency.
3. Reintroduce financial block where data exists.
4. Optional: move deep detail to appendix slides.
