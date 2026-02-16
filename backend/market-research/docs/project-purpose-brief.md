# Project Purpose Brief

Last updated: 2026-02-15

## Core Purpose

This tool should be simple.

Primary job:
- Generate market research for a user across different industries and countries from one prompt.

Primary output:
- A client-deliverable deck that the internal team can further polish.

Decision support goal:
- Help clients understand the market and support market-entry decisions when needed.

## Priority Order (Highest to Lowest)

1. Content depth
2. Insights quality
3. Story flow (clear narrative)
4. Formatting/template style match (secondary)
5. Runtime speed (secondary)

## Acceptance Philosophy

What is acceptable:
- Slow run (up to 2 hours).
- Format drift (if content is excellent).

What is not acceptable:
- Shallow content.
- Weak or missing insights.
- Poor strategic narrative.

## Budget and Runtime Constraints

- Max runtime target: 2 hours per run.
- Max cost target: USD 30 per run.

## Product Direction

- Prefer simple architecture over complicated control planes unless complexity clearly improves content quality.
- Reliability and formatting controls should not dominate development effort at the expense of insight depth.
- The best output is a strong strategic narrative first, then presentation polish.

## Practical Implication for Engineering Decisions

Any feature should justify itself primarily by:
- Improving depth of analysis.
- Improving quality of insights.
- Improving strategic story flow.

If a feature mainly improves:
- Edge-case formatting precision,
- Operational ceremony, or
- Internal gate complexity

then it should be considered optional or a candidate for simplification unless it directly protects content quality.

## Simplification Heuristic

When in doubt, choose:
- Fewer code paths.
- Fewer fallback branches.
- Fewer mandatory checks not tied to content quality.
- Fewer retries and control layers that increase cost without clear quality gain.

Keep:
- Strong content quality checks.
- Hard checks that prevent shallow output.

