# Latest Logic Flow (Simple)

Last updated: 2026-02-15

```text
+-----+----------------------------------------+----------------------------------------------------------+-----------------------------+
| ID  | Stage name                             | What it does                                             | Retry / loop                |
+-----+----------------------------------------+----------------------------------------------------------+-----------------------------+
| 1   | Read request                           | Reads user prompt into: industry, country, client info. | Up to 3 attempts            |
| 2   | Research country                       | Collects policy, market, competitor, depth data.        | Up to 3 attempts            |
| 2a  | Country review loop (Gemini 3 Pro)     | Fixes weak/missing country sections.                     | Up to 3 retries             |
| 3   | Build synthesis                        | Builds one-country strategy story from research.         | Up to 3 attempts            |
| 3a  | Synthesis review loop (Gemini 3 Pro)   | Scores + improves synthesis if quality is weak.          | Up to 3 retries             |
| 5   | Main content check                     | Hard check: depth, insight, evidence, action value.      | If fail -> stage 5a         |
| 5a  | Content improve loop (Gemini 3 Pro)    | Rewrites synthesis to pass content check.                | Up to 3 retries             |
| 6   | Pre-build check (merged)               | Cleans temp fields and checks slide data is build-ready. | Up to 3 retries             |
| 7   | Content-size scan                      | Finds very dense text/table/chart content.               | Check-only (no hard cut)    |
| 7a  | Readability rewrite loop (Gemini 3 Pro)| Rewrites dense sections for slide readability, keeps facts.| Up to 3 retries             |
| 8   | Build PPT                              | Builds PPT from synthesis + country data.                | Up to 3 attempts            |
| 9   | PPT health check                       | Checks file health so PPT opens clean and is usable.     | Up to 3 retries             |
| 9a  | Final review loop (Gemini Flash)       | Reviews screenshots first; if unavailable, uses slide text + summary. Then revise/rebuild.| Up to 5 rounds              |
| 10  | Delivery                               | Emails PPT and saves latest run info + latest PPT API.   | Email send (single path)    |
+-----+----------------------------------------+----------------------------------------------------------+-----------------------------+
```

## Notes

- Single-country only.
- `CONTENT_FIRST_MODE=true` means stage 7 does not force text cutting.
- Stage 7a is auto-rewrite for readability when stage 7 risk is high.
- Stage 9a is screenshot-first for review.
- If screenshot tools are missing, stage 9a falls back to extracted slide text + summary review.
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
