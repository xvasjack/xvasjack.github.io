# SMOKE RELEASE READINESS REPORT

- **Verdict**: NO-GO
- **Timestamp**: 2026-02-19T04:39:21.650Z
- **Node**: v22.22.0
- **Duration**: 2.0s
- **Gates**: 20 PASS / 1 FAIL / 4 SKIP / 0 WARN

## Final Verdict: NO-GO

## Gate-by-Gate Status

| Section | Gate | Status | Duration | Details |
|---------|------|--------|----------|---------|
| Environment | env/node-version | PASS | - | Node v22.22.0 >= 18 |
| Environment | env/GEMINI_API_KEY | SKIP | - | Not set — AI research calls unavailable. This is expected in local dev without c |
| Environment | env/SENDGRID_API_KEY | SKIP | - | Not set — Email delivery unavailable. This is expected in local dev without cred |
| Environment | env/SENDER_EMAIL | SKIP | - | Not set — From address for emails unavailable. This is expected in local dev wit |
| Environment | env/file/server.js | PASS | - | Exists |
| Environment | env/file/deck-builder-single.js | PASS | - | Exists |
| Environment | env/file/deck-file-check.js | PASS | - | Exists |
| Environment | env/file/content-gates.js | PASS | - | Exists |
| Environment | env/file/research-engine.js | PASS | - | Exists |
| Environment | env/file/template-patterns.json | PASS | - | Exists |
| Strict Preflight | preflight/Clean working tree | FAIL | 63ms | 92 uncommitted file(s) |
| Strict Preflight | preflight/HEAD content verification | PASS | 76ms | All critical patterns found in HEAD |
| Strict Preflight | preflight/Module export contracts | PASS | 169ms | 7 modules verified with all required exports |
| Strict Preflight | preflight/Template contract | PASS | 38ms | template-patterns.json valid with 12 top-level keys |
| Strict Preflight | preflight/Schema firewall | PASS | 1ms | Schema firewall loaded (core: validate, processFirewall, enforceSourceLineage; l |
| Strict Preflight | preflight/Route geometry | PASS | 1ms | Route geometry enforcer loaded and validated |
| Strict Preflight | preflight/FileSafety pipeline | PASS | 2ms | pptx-fileSafety-pipeline.js loaded successfully |
| Strict Preflight | preflight/Function signatures | PASS | - | 1 function signature(s) verified |
| Artifact Check | artifact/vietnam-output.pptx/size | PASS | - | 4.19MB — within bounds |
| Artifact Check | artifact/vietnam-output.pptx/check | PASS | 855ms | Valid: 35 checks passed, 32 slides, 3 charts, 87 tables |
| Artifact Check | artifact/vietnam-output.pptx/freshness | PASS | - | Artifact is 0.6 days old |
| Artifact Check | artifact/test-output.pptx/size | PASS | - | 4.32MB — within bounds |
| Artifact Check | artifact/test-output.pptx/check | PASS | 800ms | Valid: 35 checks passed, 35 slides, 6 charts, 90 tables |
| Artifact Check | artifact/test-output.pptx/freshness | PASS | - | Artifact is 0.6 days old |
| RunInfo Checks | runInfo/endpoint | SKIP | - | No --endpoint provided — runInfo checks skipped. Use --endpoint=http://localhost |

## Root Causes

### preflight/Clean working tree

- **Issue**: 92 uncommitted file(s)
- **Evidence**: D backend/market-research/budget-gate.js; M backend/market-research/build-template-patterns.js; D backend/market-research/chart-data-integrity.test.js; M backend/market-research/chart-data-normalizer.js; M backend/market-research/chart-quality-gate.js; M backend/market-research/content-quality-check
- **Fix**: git add -A && git commit -m "pre-release commit"

## Skipped Gates

- **env/GEMINI_API_KEY**: Not set — AI research calls unavailable. This is expected in local dev without credentials.
- **env/SENDGRID_API_KEY**: Not set — Email delivery unavailable. This is expected in local dev without credentials.
- **env/SENDER_EMAIL**: Not set — From address for emails unavailable. This is expected in local dev without credentials.
- **runInfo/endpoint**: No --endpoint provided — runInfo checks skipped. Use --endpoint=http://localhost:3000 to enable.
