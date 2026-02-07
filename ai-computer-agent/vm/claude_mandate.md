# Agent Mandate — READ BEFORE DOING ANYTHING

You are being invoked by an automated agent. Follow these rules strictly:

## Rules
1. ONLY modify files in: {ALLOWED_DIRECTORIES}
2. NEVER modify these files: .env, .env.*, .github/workflows/*, CLAUDE.md, ai-computer-agent/**
3. NEVER run destructive commands: rm -rf, git push --force, git reset --hard, format
4. NEVER modify or delete test files to make tests pass — fix the actual code
5. Run `npm test` ONLY if you changed function signatures, module.exports,
   or code logic. For prompt text edits (string literals in synthesize*
   functions), skip npm test — it doesn't test prompt quality
6. ALWAYS commit with message format: "Fix: <description>"
7. ALWAYS commit and push directly to main
8. NEVER create PRs or feature branches
9. DIFF SIZE: Your fix should be 5-50 lines of changes.
   If >100 lines, you are patching symptoms, not fixing root cause.
   Step back and trace the data flow. Fixes >350 lines are auto-rejected.

## Current Task Context
Original user request: {ORIGINAL_TASK}
Service being fixed: {SERVICE_NAME}
Iteration: {ITERATION_NUMBER}
Previous issues: {PREVIOUS_ISSUES}

## Fix Taxonomy — What to Hardcode vs What Must Be Dynamic

### HARDCODE these (from template-patterns.json):
- Colors: exact hex values (darkNavy: "1B2A4A", mediumBlue: "2E5090", orange: "E46C0A")
- Fonts: Century Gothic, exact sizes (title: 20, subtitle: 11, body: 10, source: 7, table: 9)
- Positions: x, y, w, h from pattern definitions in template-patterns.json
- Header line: y position, color, thickness
- Slide dimensions: 13.333 x 7.5 inches
- Table header fill: "1F497D", alt row fill: "F2F2F2"
- Read `backend/market-research/template-patterns.json` for all exact values

### DYNAMIC (from research data — never hardcode):
- Content text, market analysis prose, company descriptions
- Data values, chart data series, growth rates, market sizes
- Company names, dates, country names, currency values
- Number of slides per section (depends on data volume)

### NEVER CHANGE:
- Function signatures or module.exports
- Test files or test expectations
- API endpoint paths (/api/*)
- package.json
- Email templates

## ANTI-FABRICATION — HARD RULE

**NEVER hardcode content to mask empty research results.**

Fabricating content violates user trust. You will be blocked by:
1. PreToolUse hook (blocks fake URLs, fake companies, fallback functions)
2. Diff validator (rejects commits with fabrication patterns)
3. This commit will be reverted if it gets through

Examples of FORBIDDEN fabrications:
- Fake company URLs: `https://www.energy-services-company.com.vn`
- Fake company names: `Local Energy Services Co.`
- Fallback data functions: `getFallbackCompetitors()`, `getDefaultChartData()`
- Hardcoded year arrays: `[2019, 2020, 2021, 2022, 2023]`
- Estimated values: `$50B (estimated)`

If data is missing, the fix is in the RESEARCH PIPELINE, not in adding fake data.

If your fix adds ANY of these, it will be auto-reverted:
- Arrays of hardcoded numbers [35, 33, 31, 29, 27]
- Objects with hardcoded chartData/series/values
- "Estimated revenue" or "estimated enterprise value" in added code
- const defaultResult = { ... } or const fallbackData = { ... }

## WHEN YOU CANNOT FIX THE ISSUE

If you determine the issue is in the AI research pipeline (Kimi/Gemini
returning empty or thin data) and you cannot make the API return better
results by changing prompts or queries:

1. STOP. Do not hardcode content to mask the problem.
2. Commit with message: "Diagnostic: CANNOT_FIX — [what you investigated, root cause, what human action is needed]"
3. Do NOT create new files — just commit the diagnostic message.

A commit that says "I couldn't fix this, here's what I found" is 1000x
better than a commit that injects fake data.

## Fix Priority Order (ALWAYS follow this)
1. Content empty/hollow → fix research-orchestrator.js (API calls, search queries, parsing)
2. Content shallow/generic → fix synthesis prompts in research-orchestrator.js
3. Layout/pattern wrong → fix ppt-utils.js (choosePattern) or ppt-single-country.js (data classification)
4. Formatting wrong → fix values in template-patterns.json or pptxgenjs params in ppt-utils.js
5. Cosmetic only → fix individual element styling in ppt-single-country.js

## Iteration Rules
- Iteration 1-2: Fix the MOST critical issues only. Small diffs. One area of concern.
- Iteration 3+: If same category persists, the surface fix isn't working. Look one level deeper.
- Iteration 5+: STOP patching same files. The root cause is in a DIFFERENT file. Trace the data flow.
- If you changed the same file 3+ times without improvement: the bug is UPSTREAM of that file.

## MANDATORY DEEP ANALYSIS PROTOCOL

Before writing ANY code, you MUST complete these steps. Shallow fixes get reverted.

### Step 1: Understand What Was Actually Produced
- Read the "Content Pipeline Diagnostic" section below (if present)
- Read the slide text excerpts — this is what the pipeline ACTUALLY generated
- Identify: what SPECIFIC content is missing? What exists but is generic?

### Step 2: Trace the Data Flow (read the code, don't guess)
1. Open research-orchestrator.js → find the synthesize*() function for the failing section
2. Read the prompt string — find the DEPTH REQUIREMENTS section
3. Does the prompt ALREADY ask for what's missing?
   - YES → problem is UPSTREAM: research data is thin. Fix search queries in research-agents.js
   - NO → add the specific requirement to the prompt

### Step 3: Design Your Fix
1. ROOT CAUSE: [which function in which file loses/corrupts the data?]
2. Why previous fixes failed: [what did they change vs what should change?]
3. My approach: [file:function to modify, and WHY]
4. List 3 approaches. For EACH:
   - Does this fix the root cause or just patch the symptom?
   - Does this add ANY hardcoded content? (if yes → REJECTED)
   - Will this work for ANY country/industry? (if no → REJECTED)
   - Would this produce the SAME output regardless of research data? (if yes → WRONG)
5. PICK the approach that fixes the root cause and generalizes.

### Step 4: Verify Before Committing
- Run `npm test`
- Read your own diff. Does it contain ANY fabricated content strings? → DELETE THEM
- Commit message: explain WHY this approach, not just WHAT changed

You are fixing a PIPELINE. Your fix must generalize.
If the same issue could recur with different inputs, your fix is wrong.

## Decision Tree — What Kind of Fix Is This?

ASK YOURSELF: Is the OUTPUT content wrong, or is the FORMATTING wrong?

### If CONTENT is wrong (thin, generic, missing data, no insights):
-> The fix is almost always in the AI PROMPT TEXT, not in code.
-> Go to research-orchestrator.js
-> Find the synthesize*() function for the failing section
-> Look at the prompt string — it starts with "You are synthesizing..."
-> Edit the DEPTH REQUIREMENTS section of that prompt
-> Example: If market data is shallow, add "Include specific market size figures in USD with source year" to the prompt
-> WRONG APPROACH: Adding code in ppt-single-country.js to pad/enrich thin content

### If FORMATTING is wrong (wrong fonts, positions, colors, overflow):
-> The fix is in template-patterns.json (values) or ppt-utils.js (code that reads them)
-> DO NOT touch research-orchestrator.js prompts
-> Example: If title font is wrong, check template-patterns.json title.fontSize

### If LAYOUT is wrong (wrong slide pattern, chart missing, wrong element arrangement):
-> The fix is in ppt-utils.js choosePattern() or ppt-single-country.js slide building
-> Check template-patterns.json for the expected pattern definition

### If DATA EXISTS but is MISSING from slides:
-> The fix is in ppt-single-country.js — data is being dropped during slide generation
-> Trace the data flow: research-orchestrator.js output → ppt-single-country.js input
-> Check if the expected field name matches what the slide builder reads

## What to Fix
{FIX_PROMPT}
