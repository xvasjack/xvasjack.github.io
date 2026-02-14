# Incident Response Runbook

## Error Code Reference

### PPT_STRUCTURAL_VALIDATION (Critical)
**Symptom:** Generated PPTX file is malformed, opens with repair prompt.
**Steps:**
1. Run integrity pipeline: `node -e "require('./pptx-integrity-pipeline').runIntegrityPipeline(require('fs').readFileSync('output.pptx')).then(r => console.log(JSON.stringify(r, null, 2)))"`
2. Check for duplicate slide IDs or broken relationship refs
3. Run repair: `node repair-pptx.js output.pptx`
4. If repair fails, check template clone postprocess in `ppt-single-country.js`

### PPT_RENDERING_QUALITY (High)
**Symptom:** Too many slide blocks failed to render. templateCoverage < 95%.
**Steps:**
1. Check PPT metrics: `curl -s http://localhost:3010/api/diagnostics | jq .ppt`
2. Review template-patterns.json for missing patterns
3. Regenerate: `node build-template-patterns.js`

### QUALITY_GATE_FAILED (High)
**Symptom:** Research output did not meet readiness thresholds.
**Steps:**
1. Check diagnostics: `curl -s http://localhost:3010/api/diagnostics | jq "{synthesisGate, notReadyCountries}"`
2. Check per-country scores
3. If borderline (50-70), use `SOFT_READINESS_GATE=true`

### BUDGET_GATE (Medium)
**Symptom:** Fields or tables exceed size budgets.
**Steps:**
1. Check budget gate: `curl -s http://localhost:3010/api/diagnostics | jq .budgetGate`
2. Review `FIELD_CHAR_BUDGETS` in `budget-gate.js`
3. Increase limits if compaction is too aggressive

### GEMINI_API_ERROR (High)
**Symptom:** Gemini API call failed (rate limit, quota, or transient).
**Steps:**
1. Verify `GEMINI_API_KEY` is set and valid
2. Check costs: `curl -s http://localhost:3010/api/costs | jq .`
3. Reduce concurrency if rate-limited: `RESEARCH_BATCH_SIZE=1`

### OOM (Critical)
**Symptom:** JavaScript heap out of memory, process killed.
**Steps:**
1. Check stage memory: `node -e "console.log(JSON.stringify(require('./perf-profiler').getStageMetrics(), null, 2))"`
2. Run with GC: `node --expose-gc --max-old-space-size=450 server.js`
3. Reduce batch size: `COUNTRY_BATCH_SIZE=1`

### PIPELINE_ABORT (Medium)
**Symptom:** Pipeline was aborted (timeout or manual).
**Steps:**
1. Check `PIPELINE_TIMEOUT_SECONDS` env var
2. Disable timeout: `DISABLE_PIPELINE_TIMEOUT=true`
3. Check for abort controller usage in calling code

### EMAIL_DELIVERY (Medium)
**Symptom:** Results email not arriving.
**Steps:**
1. Verify `SENDGRID_API_KEY` is set
2. Verify `SENDER_EMAIL` is set and verified in SendGrid
3. Check spam/junk folder
4. Check server logs for SendGrid errors

## General Triage Process

1. Check `/api/diagnostics` for the `stage` and `error` fields
2. Match error message against known patterns using: `node ops-runbook.js --triage "error message"`
3. Follow the matched runbook steps above
4. If no match, check server logs for the full stack trace
5. Use `node ops-runbook.js --playbook <name>` for scenario-specific guides

## Escalation

If automated triage does not resolve the issue:
1. Capture full diagnostics: `curl -s http://localhost:3010/api/diagnostics > diag.json`
2. Capture perf metrics: `node -e "console.log(JSON.stringify(require('./perf-profiler').getStageMetrics(), null, 2))" > perf.json`
3. Check Railway logs for container-level errors
4. Review recent commits for template or schema changes
