# Stage-by-Stage Test Plan

Last updated: 2026-02-18

## Goal

For each stage, answer two questions:

1. Does this stage work?
2. How well does this stage work?

This plan starts at stage 2, as requested.

## Roles (AI loops)

- Senior reviewer: Gemini Pro
- Junior fixer: Gemini Flash

So in review loops, Pro gives fix comments, Flash applies fixes.

## How to run

Use two test layers:

1. Quick local checks (fast, low cost)
2. Real run check (full pipeline + stage scorecard from `/api/runInfo`)

## First stage (stage 2) quick start

Run this:

```bash
npm run stage:check -- --stage=2 --prompt="Energy Services market entry in Vietnam"
```

Stage 3 and 3a live outputs:

```bash
npm run stage:check -- --stage=3 --prompt="Energy Services market entry in Vietnam"
npm run stage:check -- --stage=3a --prompt="Energy Services market entry in Vietnam"
```

You get full Stage 2 output files in `reports/latest/`:
- `2-output-...md` (easy to read)
- `2-output-...json` (full raw output)

You will get output like:

```text
+------+--------+----------+----+--------+
| ID   | Works? | Quality  | G  | ms     |
+------+--------+----------+----+--------+
| 2    | YES    | 78/100   | B  | 123456 |
+------+--------+----------+----+--------+
```

- `Works?=YES` means stage 2 ran and produced usable country research.
- `Quality` is the stage score.
- `G` is grade (`A` best, `F` worst).

### Quick local checks

Run these from `backend/market-research`:

```bash
node critical-failure-regression.test.js
npx jest --runInBand content-readiness-check.test.js content-depth.test.js
node regression-tests.js --rounds=1
node test-ppt-generation.js
node validate-real-output.js test-output.pptx --country=Thailand --industry="Energy Services"
```

### Real run check

1) Start server:

```bash
npm run dev
```

2) Trigger one run:

```bash
curl -sS -X POST "http://localhost:3000/api/market-research" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt":"Generate market entry research for Energy Services in Vietnam in one deck.",
    "email":"your-email@example.com"
  }'
```

3) Save run info after completion:

```bash
curl -sS "http://localhost:3000/api/runInfo" > reports/latest/runinfo-latest.json
```

## Stage scorecard (from stage 2 onward)

```text
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| ID  | Internal| Does it work? (binary pass)          | How well? (quality score)                 | Where to read it                             |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 2   | 2       | countryResearchFailures is empty      | researchTopicCount >= 20                  | runInfo.countries[0].*                       |
|     |         | and country object exists             | and median topic chars >= 300             |                                              |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 2a  | 2a      | stage2ReviewLoop exists               | resolved in <= 2 tries (best)             | runInfo.stage2ReviewLoop                     |
|     |         | and last stillNeedsReview = false     | max 3 tries (hard limit)                  |                                              |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 3   | 3       | synthesis object built                | synthesisGate.overall >= 70               | runInfo.synthesisGate                        |
|     |         | (pipeline reaches stage 3a/4)         | fewer failures is better                  |                                              |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 3a  | 3a      | synthesisReviewLoop recorded          | score improves vs first attempt           | runInfo.synthesisReviewLoop                  |
|     |         | when stage 3 output is weak           | pass=true by <= 3 tries                   |                                              |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 4   | 5       | contentReadiness exists               | overallScore >= threshold (80 default)    | runInfo.contentReadiness                     |
|     |         | and pass=true (or softBypass true)    | contradictions <= 1, shallow <= 2         |                                              |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 4a  | 5a      | contentReviewLoop recorded            | score rises each loop (or by final loop)  | runInfo.contentReviewLoop                    |
|     |         | when stage 4 fails                    | pass=true by <= 3 tries                   |                                              |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 5   | 6       | preRenderCheck exists                 | zero data failures and zero structure     | runInfo.preRenderCheck,                      |
|     |         | and no pre-build hard fail            | issues by final attempt                   | runInfo.preRenderCheckAttempts               |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 6   | 7       | contentSizeCheck exists               | risk target: low/medium (high = weak)     | runInfo.contentSizeCheck                     |
|     |         | for country                           | fewer issues is better                    |                                              |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 6a  | 7a      | size review loop runs if risk=high    | remainingHighRisk goes down to 0          | runInfo.contentSizeReviewLoop                |
|     |         | and does not crash                    | by <= 3 tries                              |                                              |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 7   | 8       | PPT build succeeds                    | templateCoverage >= 95 (reference target) | runInfo.ppt, /api/latest-ppt                 |
|     |         | and latest PPT endpoint works         | slideRenderFailureCount low (0 best)      |                                              |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 8   | 9       | stage9Attempts last pass=true         | pptStructure.valid=true                   | runInfo.stage9Attempts,                      |
|     |         |                                      | failed checks = 0 (best)                  | runInfo.pptStructure                         |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 8a  | 9a      | finalDeckReviewLoop exists            | acceptedWithWarnings=false (best)         | runInfo.finalDeckReviewLoop                  |
|     |         | and at least 1 round recorded         | rounds <= 3, fewer open issues is better  |                                              |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
| 9   | 10      | delivery path completed               | within project budget/time target         | API logs + run summary                       |
|     |         | and /api/latest-ppt is downloadable   | (example target: <= $30, <= 2h)           |                                              |
+-----+---------+--------------------------------------+-------------------------------------------+----------------------------------------------+
```

## Stage-by-stage improvement order

Use this order in review sessions:

1. Stage 2
2. Stage 2a
3. Stage 3
4. Stage 3a
5. Stage 4
6. Stage 4a
7. Stage 5
8. Stage 6
9. Stage 6a
10. Stage 7
11. Stage 8
12. Stage 8a
13. Stage 9

## Decision rule per stage

For each stage:

1. If binary pass = no: fix stage first, do not move on.
2. If binary pass = yes but quality score < target: keep improving stage.
3. Move to next stage only when pass=yes and quality target is met.

## Notes

- Public stage numbers are continuous (2, 2a, 3, 3a, 4, 4a, ... 9).
- Internal routing labels in code are still legacy (`5a`, `6`, `7`, `9a`, `10`) for compatibility.
- This is expected and already mapped in the scorecard table above.
