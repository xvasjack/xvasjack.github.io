# Agent 5 Report: Plain-English Cleanup

Date: 2026-02-16

## Files Changed

| File | Type of change |
|------|---------------|
| `SIMPLIFICATION_PLAN.md` | Replaced jargon throughout (~40 term changes) |
| `RELEASE_CHECKLIST.md` | Simplified failure messages and terminology |
| `PLAIN_LANGUAGE_RULES.md` | Added 8 new banned terms with plain alternatives |
| `PPT_STABILIZATION_PLAN.md` | Replaced jargon across all 8 root causes and 6 phases |
| `README.md` | Minor: "synthesis engine" -> "result-combining engine" |
| `docs/file-map.md` | Simplified descriptions for 8 file entries |
| `docs/plain-english-map.md` | Added 11 new glossary entries |
| `docs/overengineering-adjudication.md` | Replaced jargon in 6 places |
| `docs/project-purpose-brief.md` | Simplified 3 terms |
| `docs/claude-agent-prompts-overengineering-audit.md` | Simplified 5 terms (orchestrator, synthesize, etc.) |
| `docs/runbooks/incident-response.md` | Simplified 4 error code names and descriptions |
| `docs/runbooks/release-checklist.md` | Minor: "pipeline" -> "check" |

## Main Terminology Changes

| Old term | New term | Files affected |
|----------|----------|---------------|
| synthesis / synthesize | combining results / combine | SIMPLIFICATION_PLAN, PPT_STABILIZATION_PLAN, file-map, overengineering-audit, agent-prompts |
| orchestration / orchestrator | research steps / flow / coordinator | agent-prompts, plain-english-map, PLAIN_LANGUAGE_RULES |
| truncation / truncate | cutting short / cut text | SIMPLIFICATION_PLAN, PPT_STABILIZATION_PLAN, plain-english-map, PLAIN_LANGUAGE_RULES |
| compaction | shortening | SIMPLIFICATION_PLAN, overengineering-adjudication |
| churn | retry waste / repeated loops | SIMPLIFICATION_PLAN, plain-english-map, PLAIN_LANGUAGE_RULES |
| quality gate | quality check | RELEASE_CHECKLIST, PPT_STABILIZATION_PLAN, incident-response, plain-english-map |
| fidelity / styleMatch | visual match (to template) | SIMPLIFICATION_PLAN, PPT_STABILIZATION_PLAN |
| coherence | story flow | PPT_STABILIZATION_PLAN |
| regression | old bug coming back | file-map, RELEASE_CHECKLIST, plain-english-map, PLAIN_LANGUAGE_RULES |
| canonicalization | standardizing (key names) | SIMPLIFICATION_PLAN, plain-english-map, PLAIN_LANGUAGE_RULES |
| idempotent | safe to re-run | plain-english-map, PLAIN_LANGUAGE_RULES |
| convergence | settling on final version | plain-english-map, PLAIN_LANGUAGE_RULES |
| token burn | AI cost | SIMPLIFICATION_PLAN, plain-english-map |
| divergence (git) | out of date / behind | RELEASE_CHECKLIST |
| remediation | fix suggestion | RELEASE_CHECKLIST |
| schema | data structure | PPT_STABILIZATION_PLAN |
| geometry | layout | PPT_STABILIZATION_PLAN |
| deterministic | rule-based / predictable | PPT_STABILIZATION_PLAN |
| transient key | temporary key | PPT_STABILIZATION_PLAN |

## User-Facing .js Text That Should Be Simplified (for other agents)

These are log messages and labels in .js files that use jargon. I did NOT edit these files (other agents own them), but they should be updated:

### server.js
1. **`[Quality Gate]`** prefix used in 8+ log messages (lines 1262, 1342, 1352, 1391, 1401, 1602, 2646, 2684). Should be `[Quality Check]`.
2. **`// ============ MAIN ORCHESTRATOR ============`** (line 1145). Should be `// ============ MAIN FLOW ============`.
3. **`Pipeline aborted`** (line 1175-1176). Should be `Run stopped` or `Run aborted`.
4. **`compacted=`** and **`compactionLog`** and **`compactionEnabled`** (lines 2173-2321). Should use "shortened" or "shortening" instead.
5. **`coherenceScore`** / **`coherenceChecker`** (lines 1521, 1551, 1660, 1745, 1867, 2277, 2294). Should be `storyFlowScore` / `storyFlowChecker`.
6. **`PIPELINE_TIMEOUT_SECONDS`** / **`DISABLE_PIPELINE_TIMEOUT`** (lines 123-129). Consider renaming to `RUN_TIMEOUT_SECONDS` / `DISABLE_RUN_TIMEOUT`.

### Other .js files (from grep scan)
7. **`content-size-check.js`**: Uses "compaction" terminology internally.
8. **`research-engine.js`**: Uses "synthesis" terminology in function names and logs.
9. **`preflight-gates.js`**: Uses "pipeline" in several places.
10. **`ops-runbook.js`**: Uses "pipeline" and "fidelity" in user-facing descriptions.
11. **`pptx-fileSafety-pipeline.js`**: File name itself uses "pipeline" -- consider renaming to `pptx-file-safety-check.js`.
12. **`scripts/template-styleMatch-scoreboard.js`**: Uses "fidelity" in output labels.

## Summary

Cleaned up 12 doc files. Added 11 new entries to the plain-English glossary and 8 new banned terms to the rules file. The docs now consistently use "combining results" instead of "synthesis", "quality check" instead of "quality gate", "cutting short" instead of "truncation", and "visual match" instead of "fidelity/styleMatch". The .js files still contain many of these old terms in log messages and variable names -- listed above for other agents to address.
