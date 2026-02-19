# Simple Flow Q&A (Fixed Width)

Last updated: 2026-02-16

```text
+----+------------------------------------------------+--------------------------------------------------------------+
| #  | Question                                       | Answer                                                       |
+----+------------------------------------------------+--------------------------------------------------------------+
| 1  | Is there still a separate "set country" stage?| No. Removed. Request reader result is used directly.        |
+----+------------------------------------------------+--------------------------------------------------------------+
| 2  | What is stage 4?                               | Stage 4 = Main content check.                               |
|    |                                                | It checks depth, insights, evidence, actionability, flow.   |
+----+------------------------------------------------+--------------------------------------------------------------+
| 3  | If stage 4 is weak, what happens?              | Stage 4a runs Gemini 3 Pro review loop (max 3 retries).    |
|    |                                                | If still weak after retries, run fails.                     |
+----+------------------------------------------------+--------------------------------------------------------------+
| 4  | Is there a review loop for stage 2?            | Yes. Stage 2a Gemini 3 Pro review loop (max 3 retries).    |
+----+------------------------------------------------+--------------------------------------------------------------+
| 5  | Is there a review loop for stage 3?            | Yes. Stage 3a includes score + review (max 3 retries).     |
+----+------------------------------------------------+--------------------------------------------------------------+
| 6  | Are checks merged before build?                | Yes. Stage 5 is merged pre-build checks.                    |
+----+------------------------------------------------+--------------------------------------------------------------+
| 7  | Who fixes when a review fails?                 | Router picks owner stage (2a/3a/5a/6/8/9) and logs it.      |
+----+------------------------------------------------+--------------------------------------------------------------+
| 8  | If content-size risk is high, what happens?    | Stage 6a rewrites dense text (Gemini 3 Pro, max 3 retries). |
|    |                                                | It keeps key facts and avoids hard text cutting.             |
+----+------------------------------------------------+--------------------------------------------------------------+
| 9  | How does final slide review work now?          | 8a uses Gemini Flash and reviews slide screenshots first.    |
|    |                                                | If screenshots are unavailable, it reviews slide text + summary. |
|    |                                                | It keeps round logs to avoid flip-flop.                      |
+----+------------------------------------------------+--------------------------------------------------------------+
```

```text
LATEST FLOW (fixed width)

+-----+---------------------------------------------+-----------------------------------------------+-------------------------+
| ID  | Stage Name                                  | What it does                                  | Retry / fallback        |
+-----+---------------------------------------------+-----------------------------------------------+-------------------------+
| 1   | Read request                                | Read prompt into request details + country.   | Up to 3 attempts        |
| 2   | Research country                            | Build country analysis from research data.    | Up to 3 attempts        |
| 2a  | Research review loop (Gemini 3 Pro)         | Improve country analysis quality/shape.       | Up to 3 retries         |
| 3   | Build main draft                            | Build single-country strategy draft.          | Up to 3 attempts        |
| 3a  | Draft score + review (Gemini 3 Pro)         | Score + improve weak draft quality.           | Up to 3 retries         |
| 4   | Main content check                          | Hard content quality check.                   | If fail -> go to 4a     |
| 4a  | Content review loop (Gemini 3 Pro)          | Rewrite draft to pass content check.          | Up to 3 retries         |
| 5   | Pre-build check (merged)                    | Temp-key cleanup + data/shape checks.         | Up to 3 retries         |
| 6   | Content-size scan                           | Detect oversize text/table risk.              | Analysis mode (no cut)  |
| 6a  | Readability rewrite loop (Gemini 3 Pro)     | Rewrite dense text, keep facts.               | Up to 3 retries         |
| 7   | Build PPT                                   | Build slides into PPTX.                       | Up to 3 attempts        |
| 8   | File safety + style + structure checks      | Validate package/structure; style=reference.  | Up to 3 retries         |
| 8a  | Final review loop                           | Gemini Flash reviews screenshots first.       | Up to 3 rounds          |
|     |                                             | If missing, it uses extracted slide text.     |                         |
| 9   | Deliver                                     | Send final PPT by email.                      | Single send path        |
+-----+---------------------------------------------+-----------------------------------------------+-------------------------+
```
