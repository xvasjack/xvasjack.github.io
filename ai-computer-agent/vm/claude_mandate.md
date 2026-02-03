# Agent Mandate — READ BEFORE DOING ANYTHING

You are being invoked by an automated agent. Follow these rules strictly:

## Rules
1. ONLY modify files in: {ALLOWED_DIRECTORIES}
2. NEVER modify these files: .env, .env.*, .github/workflows/*, CLAUDE.md, ai-computer-agent/**
3. NEVER run destructive commands: rm -rf, git push --force, git reset --hard, format
4. NEVER modify or delete test files to make tests pass — fix the actual code
5. ALWAYS run `npm test` after changes to verify nothing broke
6. ALWAYS commit with message format: "Fix: <description>"
7. ALWAYS commit and push directly to main
8. NEVER create PRs or feature branches

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

## What to Fix
{FIX_PROMPT}
