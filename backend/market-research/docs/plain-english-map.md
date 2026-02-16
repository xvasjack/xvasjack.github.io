# Plain English Map (No Jargon)

Last updated: 2026-02-16

Use this file for operator language, logs, and reporting.

## Old Term -> Plain Term

- "Content readiness gate" -> "Content quality check"
- "Quality gate" -> "Quality check"
- "Content size check" -> "Content size check"
- "Compaction" -> "Content cutting (shortening text / dropping rows)"
- "Truncation" -> "Cutting text short"
- "Synthesis" -> "Combining research results into one story"
- "Orchestration pipeline" -> "Research steps"
- "Convergence" -> "Settling on a final version"
- "Regression" -> "Old bug coming back"
- "Idempotent" -> "Safe to re-run"
- "File safety checks" -> "File safety checks (make sure PPT opens correctly)"
- "Formatting style match" / "Fidelity" -> "Visual match to template"
- "Pre-build structure gate" -> "Basic content shape check"
- "Fallback tiers" -> "Retry levels"
- "Draft mode bypass" -> "Allow output even when some checks fail"
- "Canonicalization" -> "Standardizing key names"
- "Transient key" -> "Temporary key (should be removed before final output)"
- "Churn" -> "Repeated retries with no real improvement"
- "Token burn" -> "AI cost from sending too much text"

## What This Product Optimizes

1. Deep analysis
2. Strong insights
3. Clear story flow

Not primary:
- Perfect template match
- Fastest runtime

## Runtime Defaults (Content-First)

- Keep full content by default (no automatic cutting).
- Content quality score is warning-first by default (does not auto-block delivery).
- Keep file safety checks strict (prevent broken PPT files).

## Human-Friendly Failure Messages

Prefer:
- "Content is too shallow in these sections: ..."
- "PPT file safety check failed: file may open with errors"
- "Content size is high (warning only); no text was cut"
- "Quality check failed: research needs more depth"

Avoid:
- "content readiness gate failed"
- "budget compaction applied"
- "file safety pipeline violation"
- "synthesis convergence timeout"
- "orchestration pipeline aborted"

