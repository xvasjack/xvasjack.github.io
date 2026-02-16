# Overengineering Adjudication (Content-First)

Last updated: 2026-02-15

This memo converts the large audit into a practical, low-risk simplification plan.

## Context

Business priority is:
1. Content depth
2. Insight quality
3. Story flow

Formatting precision and runtime speed are secondary.

## What Is Confirmed (Evidence-Based)

### 1) content size check can reduce content depth
- `content-size-check.js` sets strict character budgets and trims content (`content-size-check.js`).
- Shortening is run in production path (`server.js:1048`).
- This can cut rich analysis after AI generation.

Decision:
- High-confidence simplification candidate.

### 2) Content gate hard-fails can block strong but stylistically different output
- Content readiness currently blocks in runtime when below threshold (`server.js:903`).
- For a content-first product, this can be too strict when narrative is useful but style scoring is imperfect.

Decision:
- Candidate to downgrade from hard-fail to warning in production mode.

### 3) There is meaningful non-content complexity
- Multiple checks/runInfo/reports/retry levels exist.
- Some complexity is legitimate (PPT openability/file safety), some is likely excessive.

Decision:
- Simplify selectively; do not mass-delete without dependency checks.

## What Should NOT Be Blindly Deleted

The audit proposes deleting some modules that are currently used by release workflows and run info.

Examples:
- `preflight-gates.js` is used by `scripts/preflight-release.js` and smoke tooling.
- Structural file safety logic (package consistency / relationship normalization) protects against broken PPT files.

Decision:
- Keep file safety and release-safety components unless replaced with simpler equivalents.

## Recommended Execution Order

## Phase 1 (Immediate, low risk)
1. Disable content-size-check shortening by default (or set to warn-only).
2. Downgrade content readiness from hard-fail to warn-only in production content-first mode.
3. Keep file safety gates for PPT openability.

Success criteria:
- No increase in shallow-content failures.
- No increase in PPT repair/open failures.
- Improved narrative completeness and reduced cut-text complaints.

## Phase 2 (Targeted simplification)
1. Reduce fallback levels where evidence shows diminishing quality returns.
2. Remove clearly dead branches after proving unreachable in runtime.
3. Consolidate overlapping review loops with strict iteration cap.

Success criteria:
- Lower code-path count.
- Stable or improved content quality scores.
- No cost explosion.

## Phase 3 (Optional cleanup)
1. Prune low-value tests only after mapping coverage of content-critical risks.
2. Archive/move dev-only tools out of main production surface.

Success criteria:
- Faster maintenance.
- No old bugs coming back in content quality or deck file safety.

## Red Lines

Do not remove without replacement:
- PPT file safety/openability protections.
- Core content-generation path.
- Visibility tooling needed to diagnose shallow output root causes.

## Operating Principle

Prefer simple systems that increase content quality.
Avoid complexity that mostly polices formatting or internal process ceremony.

