# Review And Fix Routing Plan (Simple)

Last updated: 2026-02-15

## 1) How the system decides "good" or "bad" today

```text
+-----+-------------------------------+----------------------------------------------+------------------------------+
| ID  | Check step                    | What says good/bad                            | Pass line                    |
+-----+-------------------------------+----------------------------------------------+------------------------------+
| 2a  | Country review loop           | Missing sections, weak country object shape   | All core sections exist      |
| 3a  | Synthesis score + review      | Synthesis score + fail list from check rules  | score >= stage pass line     |
| 5   | Main content check            | Depth, insight, evidence, story flow checks   | overall >= 80 and no major   |
| 6   | Pre-build check               | Data check + shape check                      | no blocking data/shape issue |
| 7   | Content-size scan             | Size risk report                              | info only by default         |
| 8   | Build PPT                     | PPT build success/failure                     | buffer exists                |
| 9   | File/style/structure checks   | File opens right + style/shape checks         | all hard checks pass         |
| 9a  | Final deck review             | Gemini 3 Pro readiness review                 | ready=true                   |
+-----+-------------------------------+----------------------------------------------+------------------------------+
```

## 2) Who does the next fix today

```text
+-------------------------------+----------------------------------------------+
| If this step fails            | Who tries the next fix now                    |
+-------------------------------+----------------------------------------------+
| 2a                            | 2a Gemini review (same stage)                 |
| 3a                            | 3a Gemini review (same stage)                 |
| 5 / 5a                        | 5a Gemini rewrite of synthesis                |
| 6                             | 6 uses country-review repair path             |
| 8                             | 8 retries build, may ask synthesis rewrite    |
| 9                             | 9 retries file/style cleanup                  |
| 9a                            | 9a retries final review + cleanup pass        |
+-------------------------------+----------------------------------------------+
```

Current gap: review loops exist, but issue-to-owner routing is still loose.
Example: a stage 8 fail can trigger a stage 5-style rewrite, even when issue is really stage 9 file/style.

## 3) Rule for better fixing

Use one rule everywhere:

1. Fix at the earliest stage that owns the problem.
2. Only move to later-stage patching if owner-stage fix fails.
3. Log who owned the issue and what fix was tried.

## 4) Owner map (this is the key)

```text
+--------------------------------------+----------------+----------------------------------------------+
| Issue type                           | Owner stage    | Why this stage owns it                       |
+--------------------------------------+----------------+----------------------------------------------+
| Missing facts / no numbers           | 2 / 2a         | Need better research inputs first            |
| Missing section blocks               | 2a             | Country object is incomplete                 |
| Contradiction in story               | 3a             | Story build layer owns consistency           |
| Weak insight / weak recommendation   | 5a             | Content quality rewrite layer                |
| Too long content                     | 7 -> 3a/5a     | Rewrite tighter text, do not blind cut first |
| Data/shape mismatch before build     | 6 -> 2a        | Source section structure is wrong            |
| PPT build crash                      | 8 -> 6/3a      | Build layer first, then upstream if needed   |
| File/structure/style fail            | 9              | File cleanup layer owns this                 |
| Final deck not ready                 | 9a -> router   | 9a should route to true owner stage          |
+--------------------------------------+----------------+----------------------------------------------+
```

## 5) Exact answer to your 5a question

If stage 5a says "content gap", next step should depend on gap type:

```text
+--------------------------------------+------------------------------+
| Gap found in 5a                      | Next step owner              |
+--------------------------------------+------------------------------+
| "Need more facts/evidence"           | Send back to 2/2a            |
| "Story has contradiction"            | Send to 3a                   |
| "Section is missing"                 | Send to 2a                   |
| "Insight is shallow but data exists" | Keep in 5a rewrite           |
+--------------------------------------+------------------------------+
```

So: 5a should not always self-fix. It should route by gap type.

## 6) Plan to implement this in code

### Step A: Add one shared issue format

Every check/review returns issues like:

```json
{
  "type": "missing_evidence | contradiction | missing_section | shape_error | build_error | file_error | style_error | size_risk",
  "severity": "high | medium | low",
  "message": "plain english message",
  "ownerStage": "2|2a|3a|5a|6|8|9",
  "sourceStage": "where it was found"
}
```

### Step B: Add a fix router

Add one function in `server.js`:

- input: issue list + current state
- output: next owner stage to run

Simple owner priority:

1. `2/2a` first
2. then `3a`
3. then `5a`
4. then `6`
5. then `8`
6. then `9`

### Step C: Change 5a behavior

At the end of each 5a try:

1. classify failed reasons into issue types
2. if owner is `2/2a`, run targeted country repair
3. if owner is `3a`, run synthesis consistency repair
4. if owner is `5a`, keep rewriting there

### Step D: Make 9a a real traffic cop

9a should return structured issues with `ownerStage`.
If `ready=false`, route to owner stage directly instead of random retry.

### Step E: Add clear run log

Save to `runInfo`:

- `issueLog[]`
- `fixAttempts[]`
- `ownerStageCounts`
- `finalOwnerThatSolved`

This answers: "who was nudged to improve what?"

## 7) Best stage for each kind of fix (short answer)

```text
Facts/data weak      -> Stage 2/2a
Story logic weak     -> Stage 3a
Insight depth weak   -> Stage 5a
Shape mismatch       -> Stage 6 (then 2a if needed)
Build crash          -> Stage 8 (then upstream route)
File/style fail      -> Stage 9
Final go/no-go check -> Stage 9a
```

## 8) Rollout order (safe)

1. Add shared issue format + logs only (no behavior change).
2. Add router in dry-run mode (show route, do not enforce).
3. Enable route enforcement for 5a only.
4. Enable route enforcement for 9a.
5. Keep max 3 retries per stage and stop loops if no score movement.
