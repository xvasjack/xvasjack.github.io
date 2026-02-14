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

3. **Verify you're on the right branch**
   ```bash
   git log --oneline -3
   ```

4. **Push to main** (Railway deploys from main)
   ```bash
   git checkout main && git merge your-branch && git push origin main
   ```

5. **Verify deployment**
   - Check Railway deploy logs
   - Hit the health endpoint to confirm the new commit is live

## If Preflight Fails

- **Uncommitted changes**: Commit or stash before deploying. The deployed commit won't include uncommitted work.
- **HEAD content missing**: Your latest fixes aren't committed. Run `git diff` to see what's staged vs unstaged.
- **Module import failure**: A required file is missing or has a syntax error. Check the reported module.
- **Regression test failure**: A code change broke existing behavior. Fix the regression before deploying.

## Hard Rules (from MISTAKES.md)

- No paid run until preflight passes.
- "Done" = code is on main AND pushed. Verify with `git log origin/main`.
- Every fix must include regression test coverage.
- Always verify the exact file the user will open, not just "it works locally."
