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
   - Required fix patterns present in latest commit
   - All modules load without errors
   - Tests pass (unit + structural)

   Reports are written to `preflight-reports/` (JSON + markdown).

3. **Run strict preflight (recommended for production deploys)**
   ```bash
   node scripts/preflight-release.js --strict
   ```
   Strict mode adds hard-fail git checks:
   - **Git available**: git binary must be reachable (no degraded mode)
   - **Branch check**: must be on expected branch (default: `main`)
   - **HEAD SHA**: must resolve to a valid, trackable commit
   - **Out of date**: local must not be behind `origin/main`
   - **Clean tree**: git-unavailable is a hard FAIL, not a warning

   Each failure includes a fix suggestion with the exact command to run.

4. **Run with stress test (optional, recommended before major releases)**
   ```bash
   npm run preflight:stress
   # or with custom seed count:
   node scripts/preflight-release.js --stress-seeds=50
   ```

5. **Verify you're on the right branch**
   ```bash
   git log --oneline -3
   ```
   Or use strict preflight which does this automatically:
   ```bash
   node scripts/preflight-release.js --strict --expected-branch=main
   ```

6. **Push to main** (Railway deploys from main)
   ```bash
   git checkout main && git merge your-branch && git push origin main
   ```

7. **Verify deployment**
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
| `node scripts/preflight-release.js --strict` | Strict mode (git checks hard-fail) |
| `node scripts/preflight-release.js --strict --expected-branch=staging` | Strict with custom branch |
| `node scripts/preflight-release.js --stress-seeds=50` | Custom stress seed count |
| `node scripts/preflight-release.js --report-dir=/tmp` | Custom report output dir |
| `node scripts/preflight-release.js --help` | Show usage |

## Strict Mode Git Checks (--strict)

In strict mode, the following are **HARD FAILURES** (not warnings):

| Check | What it verifies | On failure, run: |
|-------|-----------------|-----------------|
| Git available | `git --version` succeeds | `apt-get install git` or `brew install git` |
| Branch | On expected branch (default: main) | `git checkout main` |
| HEAD SHA | HEAD resolves to a commit on a branch | `git log --oneline -3` to inspect |
| Out of date | Not behind origin/main | `git pull origin main --rebase` |
| Clean tree (degraded) | Git is accessible for tree check | Ensure git is in PATH |
| Clean tree (dirty) | No uncommitted .js/.json changes | `git stash` or `git add -A && git commit` |

## Strict Mode Formatting Audit (--strict)

In strict mode, **all formatting warnings are promoted to hard failures**:

| Warning Code | What it detects | Behavior |
|-------------|----------------|----------|
| `header_footer_line_drift` | Header/footer Y-position drift > 2500 EMU | Non-strict: WARN, Strict: FAIL |
| `line_width_signature_mismatch` | Expected line thickness (57150, 28575) not present | Non-strict: WARN, Strict: FAIL |
| `table_margin_drift` | Table margins deviate from template baseline | Non-strict: WARN, Strict: FAIL |
| `table_anchor_top_heavy` | Most cells top-anchored vs expected center | Non-strict: WARN, Strict: FAIL |
| `table_outer_border_missing` | No 3pt table borders detected | Non-strict: WARN, Strict: FAIL |
| `long_text_run_density` | Very long text runs (>900 chars) | Non-strict: WARN, Strict: FAIL |
| `long_table_cell_density` | Overly long table cells (>620 chars) | Non-strict: WARN, Strict: FAIL |
| `slide_size_mismatch` | Slide dimensions differ from template | Always: FAIL (critical) |
| `table_margin_runaway` | Extreme margin values detected | Always: FAIL (critical) |

Failure messages list **exact blocking slide keys** with root causes:
```
PPT formatting audit strict-mode failure: 2 warning(s) promoted to hard fail.
Blocking slide keys: header_footer_line_drift, table_margin_drift
Root causes:
  - [header_footer_line_drift] Header/footer line drift detected (delta EMU: top=3200)
  - [table_margin_drift] Table margins drift from template baseline (near-expected ratio=0.65)
```

Both the PPT builder (`deck-builder-single.js` via `strictGeometryMode`) and the server pipeline (`server.js` via `scope.templateStrictMode`) enforce this behavior at runtime. The preflight gate (`Formatting audit`) also enforces it from stored report data.

## If Preflight Fails

- **Git not available**: Install git and ensure it's in PATH. Run `which git` to verify.
- **Wrong branch**: Run `git checkout main` (or your expected branch).
- **HEAD not trackable**: Your HEAD may be detached or orphaned. Run `git checkout main`.
- **Behind origin/main**: Run `git pull origin main --rebase` to sync.
- **Uncommitted changes**: Commit or stash before deploying. The deployed commit won't include uncommitted work. Run `git stash` or `git add -A && git commit -m "pre-deploy"`.
- **HEAD content missing**: Your latest fixes aren't committed. Run `git diff` to see what's staged vs unstaged, then `git add -A && git commit`.
- **Module load failure**: A required file is missing or has a syntax error. Check the reported module.
- **Test failure**: A code change broke existing behavior. Fix the problem before deploying.
- **Stress test failure**: Runtime crashes found — there are unguarded code paths. Fix before deploying.
- **Formatting check failure (strict)**: Formatting mismatch detected and strict mode is active. The failure message lists exact blocking slide keys and root causes. Fix the mismatch in `deck-builder-single.js` or update `template-patterns.json`. In non-strict mode, these are warnings only.
- **WARN (degraded mode, non-strict)**: Git could not run. Preflight checked local files but cannot confirm they match your latest commit. Use `--strict` to make this a hard failure.

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
- Use `--strict` for production deploys to prevent false confidence from degraded git state.
