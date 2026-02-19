# Latest Logic Flow (Simple)

Last updated: 2026-02-16

```text
+-----+----------------------------------------+------------------------------------------------------------------+-----------------------------+
| ID  | Stage name                             | What it does                                                     | Retry / loop                |
+-----+----------------------------------------+------------------------------------------------------------------+-----------------------------+
| 1   | Read request                           | Reads user prompt into: industry, country, client info.         | Up to 3 attempts            |
| 2   | Research country                       | Collects policy, market, competitor, depth data.                | Up to 3 attempts            |
| 2a  | Country review loop (Gemini 3 Pro)     | Fixes weak/missing country sections.                            | Up to 3 retries             |
| 3   | Build main draft                       | Builds one-country strategy draft from research.                | Up to 3 attempts            |
| 3a  | Draft review loop (Gemini 3 Pro)       | Scores + improves draft quality if weak.                        | Up to 3 retries             |
| 4   | Main content check                     | Hard check: depth, insight, evidence, action value.             | If fail -> stage 4a         |
| 4a  | Content improve loop (Gemini 3 Pro)    | Rewrites draft to pass main content check.                      | Up to 3 retries             |
| 5   | Pre-build check (merged)               | Cleans temp fields and checks slide data is build-ready.        | Up to 3 retries             |
| 6   | Content-size scan                      | Finds very dense text/table/chart content.                      | Check-only (no hard cut)    |
| 6a  | Readability rewrite loop (Gemini 3 Pro)| Rewrites dense sections for slide readability, keeps facts.     | Up to 3 retries             |
| 7   | Build PPT                              | Builds PPT from draft + country data.                           | Up to 3 attempts            |
| 8   | PPT health check                       | Checks file safety and structure so PPT opens cleanly.          | Up to 3 retries             |
| 8a  | Final review loop (Gemini Flash)       | Reviews screenshots first; fallback to slide text + summary.    | Up to 3 rounds              |
| 9   | Delivery                               | Emails PPT and saves latest run info + latest PPT API.          | Email send (single path)    |
+-----+----------------------------------------+------------------------------------------------------------------+-----------------------------+
```

## Notes

- Single-country only.
- `CONTENT_FIRST_MODE=true` means stage 6 does not force text cutting.
- Stage 6a is auto-rewrite for readability when stage 6 risk is high.
- Stage 8a is screenshot-first for review.
- If screenshot tools are missing, stage 8a falls back to extracted slide text + summary review.
- Latest run info endpoint: `GET /api/runInfo`
- Latest PPT endpoint: `GET /api/latest-ppt`
- Routing logs are in run info:
  - `issueLog[]` (what was wrong)
  - `fixAttempts[]` (which owner stage tried to fix)
  - `ownerStageCounts` (how many issues routed to each stage)
  - `finalOwnerThatSolved` (last owner stage that resolved a loop)
- Final review logs are in:
  - `finalDeckReviewLoop.attempts[]`
  - includes `issues`, `actions`, `lockedDecisions`, `changeSummary`
- Internal code still uses legacy IDs (`5a`, `6`, `7`, `9a`) for routing compatibility.
