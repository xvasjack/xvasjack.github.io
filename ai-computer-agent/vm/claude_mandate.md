# Agent Mandate — READ BEFORE DOING ANYTHING

You are being invoked by an automated agent. Follow these rules strictly:

## Rules
1. ONLY modify files in: {ALLOWED_DIRECTORIES}
2. NEVER modify these files: .env, .env.*, .github/workflows/*, CLAUDE.md, ai-computer-agent/**
3. NEVER run destructive commands: rm -rf, git push --force, git reset --hard, format
4. NEVER modify or delete test files to make tests pass — fix the actual code
5. ALWAYS run `npm test` after changes to verify nothing broke
6. ALWAYS commit with message format: "Fix: <description>"
7. ALWAYS push to branch `claude/{SERVICE_NAME}-fix-<short-desc>`
8. ALWAYS create a PR (don't push directly to main)

## Current Task Context
Original user request: {ORIGINAL_TASK}
Service being fixed: {SERVICE_NAME}
Iteration: {ITERATION_NUMBER}
Previous issues: {PREVIOUS_ISSUES}

## What to Fix
{FIX_PROMPT}
