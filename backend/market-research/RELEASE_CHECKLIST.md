# Release Checklist — Market Research Backend

## Before Any Paid Backend Run

1. **Commit all changes**
   ```bash
   git add -A && git commit -m "description"
   ```

2. **Run preflight**
   ```bash
   npm run preflight:release
   ```
   This checks:
   - No uncommitted changes in critical files
   - Required fix patterns present in HEAD commit
   - All modules import without errors
   - Regression tests pass (unit + structural)

   Reports are written to `preflight-reports/` (JSON + markdown).

3. **Run with stress test (optional, recommended before major releases)**
   ```bash
   npm run preflight:stress
   # or with custom seed count:
   node scripts/preflight-release.js --stress-seeds=50
   ```

4. **Verify you're on the right branch**
   ```bash
   git log --oneline -3
   ```

5. **Push to main** (Railway deploys from main)
   ```bash
   git checkout main && git merge your-branch && git push origin main
   ```

6. **Verify deployment**
   - Check Railway deploy logs
   - Hit the health endpoint to confirm the new commit is live

## Preflight Reports

After each run, check `preflight-reports/` for:
- `preflight-report.json` — machine-readable results (CI integration)
- `preflight-report.md` — human-readable summary

## Operator Commands Quick Reference

| Command | What it does |
|---------|-------------|
| `npm run preflight:release` | Run all checks (no stress) |
| `npm run preflight:stress` | Run all checks + 30-seed stress test |
| `npm run test:preflight` | Run preflight unit tests only |
| `node scripts/preflight-release.js --stress-seeds=50` | Custom stress seed count |
| `node scripts/preflight-release.js --report-dir=/tmp` | Custom report output dir |
| `node scripts/preflight-release.js --help` | Show usage |

## If Preflight Fails

- **Uncommitted changes**: Commit or stash before deploying. The deployed commit won't include uncommitted work.
- **HEAD content missing**: Your latest fixes aren't committed. Run `git diff` to see what's staged vs unstaged.
- **Module import failure**: A required file is missing or has a syntax error. Check the reported module.
- **Regression test failure**: A code change broke existing behavior. Fix the regression before deploying.
- **Stress test failure**: Runtime crashes found — there are unguarded code paths. Fix before deploying.
- **WARN (degraded mode)**: Git execution was blocked. Preflight validated local files but cannot guarantee HEAD parity. Proceed with caution.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All checks passed |
| 1 | One or more checks failed |

## Hard Rules (from MISTAKES.md)

- No paid run until preflight passes.
- "Done" = code is on main AND pushed. Verify with `git log origin/main`.
- Every fix must include regression test coverage.
- Always verify the exact file the user will open, not just "it works locally."
