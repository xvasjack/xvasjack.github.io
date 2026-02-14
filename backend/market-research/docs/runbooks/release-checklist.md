# Pre-Release Checklist

## Quick Check (< 10 seconds)

Run: `node ops-runbook.js --validate-local`

Or programmatic: `require('./ops-runbook').runLocalReadiness({ mode: 'fast-check' })`

- [ ] All required env vars set (GEMINI_API_KEY, SENDGRID_API_KEY, SENDER_EMAIL)
- [ ] All key files present (server.js, budget-gate.js, quality-gates.js, etc.)
- [ ] All modules load without syntax errors
- [ ] Template contract compiles with > 0 slides

## Release Check (< 60 seconds)

Run: `require('./ops-runbook').runLocalReadiness({ mode: 'release-check' })`

Includes everything from Quick Check plus:
- [ ] All Jest tests pass: `npm test -- --testPathPattern=market-research`
- [ ] Preflight gates pass

## Deep Audit (< 3 minutes)

Run: `require('./ops-runbook').runLocalReadiness({ mode: 'deep-audit' })`

Includes everything from Release Check plus:
- [ ] Stress test passes: `node stress-test-harness.js --quick`
- [ ] Integrity pipeline module available

## Safe-to-Run Verdict

Before running a paid pipeline:
```js
const { runLocalReadiness, getSafeToRunVerdict } = require('./ops-runbook');
const result = runLocalReadiness({ mode: 'release-check', strict: true });
const verdict = getSafeToRunVerdict(result.checks);
console.log(verdict.verdict);
// "SAFE: All critical checks passed (6 total checks, 0 warnings)"
// or "UNSAFE: 1 blocker(s) -- env-vars: Missing: GEMINI_API_KEY"
```

## Pre-Deploy Steps

1. Run release-check locally
2. Verify safe-to-run verdict is SAFE
3. Check cost budget: `curl -s http://localhost:3010/api/costs | jq .`
4. Commit and push all changes
5. Verify Railway deployment health: `curl -s <railway-url>/health`

## Post-Deploy Verification

1. Run a test request with a small scope (1 country, known industry)
2. Check `/api/diagnostics` for any warnings
3. Check `/api/costs` to verify spend is within budget
4. Verify email delivery with test recipient
5. Download and inspect generated PPTX
