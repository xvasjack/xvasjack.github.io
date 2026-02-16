# Simple Flow Q&A (Fixed Width)

Last updated: 2026-02-15

```text
+----+------------------------------------------------+--------------------------------------------------------------+
| #  | Question                                       | Answer                                                       |
+----+------------------------------------------------+--------------------------------------------------------------+
| 1  | Is there still a separate "set country" stage?| No. Removed. Request reader result is used directly.        |
+----+------------------------------------------------+--------------------------------------------------------------+
| 2  | What is stage 5?                               | Stage 5 = Main content gate.                                |
|    |                                                | It checks depth, insights, evidence, actionability, flow.   |
+----+------------------------------------------------+--------------------------------------------------------------+
| 3  | If stage 5 is weak, what happens?              | Stage 5a runs Gemini 3 Pro review loop (max 3 retries).    |
|    |                                                | If still weak after retries, run fails.                     |
+----+------------------------------------------------+--------------------------------------------------------------+
| 4  | Is there a review loop for stage 2?            | Yes. Stage 2a Gemini 3 Pro review loop (max 3 retries).    |
+----+------------------------------------------------+--------------------------------------------------------------+
| 5  | Is there a review loop for stage 3/4?          | Yes. Stage 3a now includes score + review (max 3 retries). |
+----+------------------------------------------------+--------------------------------------------------------------+
| 6  | Are old stage 6 and 7 merged?                  | Yes. One merged pre-build check stage now.                  |
+----+------------------------------------------------+--------------------------------------------------------------+
| 7  | Who fixes when a review fails?                 | Router picks owner stage (2a/3a/5a/6/8/9) and logs it.      |
+----+------------------------------------------------+--------------------------------------------------------------+
| 8  | If content-size risk is high, what happens?    | Stage 7a rewrites dense text (Gemini 3 Pro, max 3 retries). |
|    |                                                | It keeps key facts and avoids hard text cutting.             |
+----+------------------------------------------------+--------------------------------------------------------------+
| 9  | How does final slide review work now?          | 9a uses Gemini Flash and reviews slide screenshots first.    |
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
| 3   | Synthesize                                  | Build single-country strategy synthesis.      | Up to 3 attempts        |
| 3a  | Synthesis score + review (Gemini 3 Pro)     | Score + improve weak synthesis quality.       | Up to 3 retries         |
| 5   | Main content check                          | Hard content quality check.                   | If fail -> go to 5a     |
| 5a  | Content review loop (Gemini 3 Pro)          | Rewrite synthesis to pass content check.      | Up to 3 retries         |
| 6   | Pre-build check (merged)                    | Temp-key cleanup + data/shape checks.         | Up to 3 retries         |
| 7   | Content-size scan                           | Detect oversize text/table risk.              | Analysis mode (no cut)  |
| 7a  | Readability rewrite loop (Gemini 3 Pro)    | Rewrite dense text, keep facts.               | Up to 3 retries         |
| 8   | Build PPT                                   | Build slides into PPTX.                       | Up to 3 attempts        |
| 9   | File safety + style + structure checks      | Validate package/structure; style=reference. | Up to 3 retries         |
| 9a  | Final review loop                           | Gemini Flash reviews screenshots first.       | Up to 5 rounds          |
|     |                                             | If missing, it uses extracted slide text.     |                         |
| 10  | Deliver                                     | Send final PPT by email.                      | Single send path        |
+-----+---------------------------------------------+-----------------------------------------------+-------------------------+
```
