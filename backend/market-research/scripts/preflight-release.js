#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Project root is two levels up from scripts/
const PROJECT_ROOT = path.resolve(__dirname, '..');
const GIT_ROOT = path.resolve(PROJECT_ROOT, '..', '..');
const RELATIVE_PREFIX = 'backend/market-research/';

// ---------------------------------------------------------------------------
// 1. Dirty-tree guard
// ---------------------------------------------------------------------------
function checkDirtyTree() {
  let output;
  try {
    output = execFileSync('git', ['status', '--porcelain', '--', '.'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    return { pass: false, dirty: [`git status failed: ${err.message}`] };
  }

  const dirty = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => {
      // Extract filename from porcelain output (skip the 2-char status + space)
      const file = l.slice(3).replace(/^"(.*)"$/, '$1');
      return file.endsWith('.js') || file.endsWith('.json');
    });

  return { pass: dirty.length === 0, dirty };
}

// ---------------------------------------------------------------------------
// 2. HEAD-content verification (exported for unit testing)
// ---------------------------------------------------------------------------
function verifyHeadContent(checks) {
  const failures = [];
  let degradedMode = false;

  for (const { file, patterns } of checks) {
    // Build the git-relative path
    const gitPath = RELATIVE_PREFIX + file;
    let content;
    try {
      content = execFileSync('git', ['show', `HEAD:${gitPath}`], {
        cwd: GIT_ROOT,
        encoding: 'utf8',
      });
    } catch (err) {
      const errMsg = String(err?.message || err || '');
      const isPermError = err?.code === 'EPERM' || /EPERM/i.test(errMsg);
      if (isPermError) {
        // Sandbox fallback: when git execution is blocked, use local file content.
        // This still validates pattern presence but cannot guarantee HEAD parity.
        try {
          content = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
          degradedMode = true;
        } catch (readErr) {
          failures.push({ file, missing: patterns, error: readErr.message });
          continue;
        }
      } else {
        failures.push({ file, missing: patterns, error: err.message });
        continue;
      }
    }

    const missing = patterns.filter((p) => !content.includes(p));
    if (missing.length > 0) {
      failures.push({ file, missing });
    }
  }

  const totalPatterns = checks.reduce((n, c) => n + c.patterns.length, 0);
  const failedPatterns = failures.reduce((n, f) => n + f.missing.length, 0);
  const passedPatterns = totalPatterns - failedPatterns;

  return {
    pass: failures.length === 0,
    failures,
    totalPatterns,
    passedPatterns,
    degradedMode,
  };
}

// Default checks matching the spec
const DEFAULT_HEAD_CHECKS = [
  { file: 'server.js', patterns: ['collectPreRenderStructureIssues'] },
  {
    file: 'ppt-single-country.js',
    patterns: ['shouldAllowCompetitiveOptionalGroupGap', 'resolveTemplateRouteWithGeometryGuard'],
  },
  {
    file: 'research-orchestrator.js',
    patterns: ['runInBatchesUntilDeadline'],
  },
  { file: 'ppt-utils.js', patterns: ['sanitizeHyperlinkUrl'] },
  { file: 'quality-gates.js', patterns: ['validatePptData'] },
  {
    file: 'template-clone-postprocess.js',
    patterns: ['isLockedTemplateText'],
  },
  {
    file: 'pptx-validator.js',
    patterns: ['reconcileContentTypesAndPackage'],
  },
];

// ---------------------------------------------------------------------------
// 3. Module import smoke test
// ---------------------------------------------------------------------------
function checkModuleImports() {
  const modules = [
    'server.js',
    'research-orchestrator.js',
    'ppt-single-country.js',
    'ppt-utils.js',
    'quality-gates.js',
    'template-clone-postprocess.js',
    'pptx-validator.js',
    'ai-clients.js',
    'theme-normalizer.js',
    // regression-tests.js is skipped — requiring it triggers main()
    'validate-output.js',
    'research-agents.js',
    'research-framework.js',
  ];

  const failures = [];
  const loaded = [];

  for (const mod of modules) {
    const fullPath = path.join(PROJECT_ROOT, mod);
    try {
      require(fullPath);
      loaded.push(mod);
    } catch (err) {
      failures.push({ module: mod, error: err.code || err.message });
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    total: modules.length,
    loadedCount: loaded.length,
  };
}

// ---------------------------------------------------------------------------
// 4. Regression test runner
// ---------------------------------------------------------------------------
function runRegressionTests() {
  const result = spawnSync('node', ['regression-tests.js', '--rounds=1'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit', // stream stdout/stderr to parent
    timeout: 5 * 60 * 1000, // 5 min safety timeout
  });

  return {
    pass: result.status === 0,
    exitCode: result.status,
    signal: result.signal,
  };
}

// ---------------------------------------------------------------------------
// 5. Summary + main
// ---------------------------------------------------------------------------
function main() {
  console.log('');
  console.log('=== PREFLIGHT RELEASE CHECK ===');

  const results = [];
  let anyFail = false;

  // --- 1. Dirty tree ---
  const dirty = checkDirtyTree();
  if (dirty.pass) {
    results.push('[PASS] Clean working tree (no uncommitted changes)');
  } else {
    anyFail = true;
    results.push("[FAIL] Uncommitted changes detected — deployed commit won't include these:");
    for (const d of dirty.dirty) {
      results.push(`  ${d}`);
    }
  }

  // --- 2. HEAD content ---
  const head = verifyHeadContent(DEFAULT_HEAD_CHECKS);
  if (head.pass) {
    results.push(
      `[PASS] HEAD content verified (${head.passedPatterns}/${head.totalPatterns} patterns found)`
    );
    if (head.degradedMode) {
      results.push(
        '[WARN] HEAD parity check ran in degraded mode (git execution blocked; validated local files instead)'
      );
    }
  } else {
    anyFail = true;
    results.push(
      `[FAIL] HEAD content verification (${head.passedPatterns}/${head.totalPatterns} patterns found):`
    );
    for (const f of head.failures) {
      for (const m of f.missing) {
        results.push(`  ${f.file}: missing "${m}"${f.error ? ` (${f.error})` : ''}`);
      }
    }
  }

  // --- 3. Module imports ---
  const imports = checkModuleImports();
  if (imports.pass) {
    results.push(`[PASS] Module imports (${imports.loadedCount}/${imports.total} modules loaded)`);
  } else {
    anyFail = true;
    results.push(`[FAIL] Module import failures (${imports.loadedCount}/${imports.total} loaded):`);
    for (const f of imports.failures) {
      results.push(`  ${f.module}: ${f.error}`);
    }
  }

  // --- 4. Regression tests ---
  if (anyFail) {
    results.push('[SKIP] Regression tests (skipped due to earlier failures)');
  } else {
    const regression = runRegressionTests();
    if (regression.pass) {
      results.push('[PASS] Regression tests passed');
    } else {
      anyFail = true;
      const reason = regression.signal
        ? `killed by signal ${regression.signal}`
        : `exit code ${regression.exitCode}`;
      results.push(`[FAIL] Regression tests failed (${reason})`);
    }
  }

  // --- Print summary ---
  for (const line of results) {
    console.log(line);
  }

  if (anyFail) {
    console.log('=== PREFLIGHT FAILED — do NOT deploy ===');
    console.log('');
    process.exit(1);
  } else {
    console.log('=== ALL CHECKS PASSED — safe to deploy ===');
    console.log('');
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { verifyHeadContent };
