#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

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
    const errMsg = String(err?.message || err || '');
    const isEnvError =
      err?.code === 'EPERM' ||
      err?.code === 'ENOENT' ||
      /EPERM/i.test(errMsg) ||
      /ENOENT/i.test(errMsg) ||
      /not found/i.test(errMsg);
    if (isEnvError) {
      return {
        pass: false,
        dirty: [],
        gitUnavailable: true,
        restricted: true,
        warning: 'git unavailable — cannot verify clean tree.',
        remediation:
          "Ensure git is installed and available in PATH. Run 'which git' to verify. " +
          'If running in a container, install git or mount the host git binary.',
      };
    }
    return {
      pass: false,
      dirty: [`git status failed: ${errMsg}`],
      restricted: false,
      remediation: `Investigate git error: ${errMsg}`,
    };
  }

  const dirty = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => {
      const file = l.slice(3).replace(/^"(.*)"$/, '$1');
      return file.endsWith('.js') || file.endsWith('.json');
    });

  return {
    pass: dirty.length === 0,
    dirty,
    restricted: false,
    remediation: dirty.length > 0
      ? "Run 'git stash' or 'git add -A && git commit -m \"pre-deploy\"' to clean the working tree."
      : null,
  };
}

// ---------------------------------------------------------------------------
// 1b. Git availability check
// ---------------------------------------------------------------------------
function checkGitAvailable() {
  try {
    execFileSync('git', ['--version'], { cwd: GIT_ROOT, encoding: 'utf8' });
    return { pass: true };
  } catch (err) {
    return {
      pass: false,
      error: String(err?.message || err || ''),
      remediation:
        "git is not available. Install git ('apt-get install git' or 'brew install git') " +
        "and ensure it is in your PATH. Run 'which git' to verify.",
    };
  }
}

// ---------------------------------------------------------------------------
// 1c. Git branch check
// ---------------------------------------------------------------------------
function checkGitBranch(expectedBranch) {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: GIT_ROOT,
      encoding: 'utf8',
    }).trim();

    if (!branch) {
      return {
        pass: false,
        branch: '(detached HEAD)',
        remediation:
          `You are in detached HEAD state. Run 'git checkout ${expectedBranch}' ` +
          'to switch to the expected branch before deploying.',
      };
    }

    if (branch !== expectedBranch) {
      return {
        pass: false,
        branch,
        remediation:
          `Currently on branch '${branch}', expected '${expectedBranch}'. ` +
          `Run 'git checkout ${expectedBranch}' to switch.`,
      };
    }

    return { pass: true, branch };
  } catch (err) {
    return {
      pass: false,
      branch: 'unknown',
      error: String(err?.message || err || ''),
      remediation:
        "Could not determine current branch. Ensure you are inside a git repository. " +
        "Run 'git status' to verify.",
    };
  }
}

// ---------------------------------------------------------------------------
// 1d. HEAD SHA check
// ---------------------------------------------------------------------------
function checkHeadSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: GIT_ROOT,
      encoding: 'utf8',
    }).trim();

    if (!sha || sha.length < 7) {
      return {
        pass: false,
        sha: null,
        remediation:
          "HEAD SHA could not be resolved. Ensure the repository has at least one commit. " +
          "Run 'git log --oneline -1' to verify.",
      };
    }

    // Check if HEAD is an ancestor of a branch (not orphaned)
    const result = spawnSync('git', ['branch', '--contains', sha], {
      cwd: GIT_ROOT,
      encoding: 'utf8',
    });
    const branches = (result.stdout || '')
      .split('\n')
      .map((l) => l.replace(/^\*?\s*/, '').trim())
      .filter(Boolean);

    if (branches.length === 0) {
      return {
        pass: false,
        sha,
        remediation:
          `HEAD (${sha.slice(0, 8)}) is not contained in any branch. ` +
          "This commit may be orphaned. Run 'git log --oneline -3' to inspect and " +
          "'git checkout main' to return to a tracked branch.",
      };
    }

    return { pass: true, sha, branches };
  } catch (err) {
    return {
      pass: false,
      sha: null,
      error: String(err?.message || err || ''),
      remediation:
        "Could not read HEAD SHA. Ensure git is available and you are in a valid repository. " +
        "Run 'git status' to verify.",
    };
  }
}

// ---------------------------------------------------------------------------
// 1e. Divergence from origin/main check
// ---------------------------------------------------------------------------
function checkGitDivergence(remoteBranch) {
  const target = remoteBranch || 'origin/main';
  try {
    // Fetch latest from remote (best effort)
    spawnSync('git', ['fetch', '--quiet', target.split('/')[0]], {
      cwd: GIT_ROOT,
      timeout: 15000,
    });

    // Check if remote branch exists
    const remoteCheck = spawnSync('git', ['rev-parse', '--verify', target], {
      cwd: GIT_ROOT,
      encoding: 'utf8',
    });
    if (remoteCheck.status !== 0) {
      return {
        pass: false,
        ahead: 0,
        behind: 0,
        error: `Remote branch '${target}' not found`,
        remediation:
          `Remote branch '${target}' does not exist. Run 'git fetch origin' to update remote refs. ` +
          "If this is a new repository, push your branch first with 'git push -u origin main'.",
      };
    }

    const revList = execFileSync('git', ['rev-list', '--left-right', '--count', `${target}...HEAD`], {
      cwd: GIT_ROOT,
      encoding: 'utf8',
    }).trim();

    const [behind, ahead] = revList.split(/\s+/).map(Number);

    if (behind > 0) {
      return {
        pass: false,
        ahead,
        behind,
        remediation:
          `Local is ${behind} commit(s) behind ${target} and ${ahead} ahead. ` +
          `Run 'git pull origin main --rebase' to sync, then 'git push'.`,
      };
    }

    return { pass: true, ahead, behind };
  } catch (err) {
    return {
      pass: false,
      ahead: 0,
      behind: 0,
      error: String(err?.message || err || ''),
      remediation:
        `Could not check divergence from ${target}. Run 'git fetch origin' and retry. ` +
        "Ensure the remote is configured with 'git remote -v'.",
    };
  }
}

// ---------------------------------------------------------------------------
// 2. HEAD-content verification
// ---------------------------------------------------------------------------
function verifyHeadContent(checks) {
  const failures = [];
  let degradedMode = false;

  for (const { file, patterns } of checks) {
    const gitPath = RELATIVE_PREFIX + file;
    let content;
    try {
      content = execFileSync('git', ['show', `HEAD:${gitPath}`], {
        cwd: GIT_ROOT,
        encoding: 'utf8',
      });
    } catch (err) {
      const errMsg = String(err?.message || err || '');
      const isEnvError =
        err?.code === 'EPERM' ||
        err?.code === 'ENOENT' ||
        /EPERM/i.test(errMsg) ||
        /ENOENT/i.test(errMsg);
      if (isEnvError) {
        try {
          content = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
          degradedMode = true;
        } catch (readErr) {
          failures.push({ file, missing: patterns, error: readErr.message });
          continue;
        }
      } else {
        failures.push({ file, missing: patterns, error: errMsg });
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

  return { pass: failures.length === 0, failures, totalPatterns, passedPatterns, degradedMode };
}

const DEFAULT_HEAD_CHECKS = [
  { file: 'server.js', patterns: ['collectPreRenderStructureIssues'] },
  {
    file: 'ppt-single-country.js',
    patterns: ['shouldAllowCompetitiveOptionalGroupGap', 'resolveTemplateRouteWithGeometryGuard'],
  },
  { file: 'research-orchestrator.js', patterns: ['runInBatchesUntilDeadline'] },
  { file: 'ppt-utils.js', patterns: ['sanitizeHyperlinkUrl'] },
  { file: 'quality-gates.js', patterns: ['validatePptData'] },
  { file: 'template-clone-postprocess.js', patterns: ['isLockedTemplateText'] },
  {
    file: 'pptx-validator.js',
    patterns: ['normalizeAbsoluteRelationshipTargets', 'reconcileContentTypesAndPackage'],
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
    'validate-output.js',
    'research-agents.js',
    'research-framework.js',
  ];

  const failures = [];
  const loaded = [];
  const moduleContracts = {
    'pptx-validator.js': [
      'normalizeAbsoluteRelationshipTargets',
      'normalizeSlideNonVisualIds',
      'reconcileContentTypesAndPackage',
    ],
  };

  for (const mod of modules) {
    const fullPath = path.join(PROJECT_ROOT, mod);
    try {
      const loadedModule = require(fullPath);
      const requiredExports = moduleContracts[mod] || [];
      const missingExports = requiredExports.filter((exportName) => {
        return typeof loadedModule?.[exportName] !== 'function';
      });
      if (missingExports.length > 0) {
        failures.push({
          module: mod,
          error: `missing required export(s): ${missingExports.join(', ')}`,
        });
        continue;
      }
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
    stdio: 'inherit',
    timeout: 5 * 60 * 1000,
  });

  return {
    pass: result.status === 0,
    exitCode: result.status,
    signal: result.signal,
  };
}

// ---------------------------------------------------------------------------
// 5. Stress test integration
// ---------------------------------------------------------------------------
function runStressCheck(seeds) {
  try {
    const { runStressTest } = require(path.join(PROJECT_ROOT, 'stress-test-harness.js'));
    // runStressTest is async but we run it synchronously via subprocess for isolation
    const result = spawnSync(
      'node',
      [
        '-e',
        `const h=require('./stress-test-harness');h.runStressTest({seeds:${seeds}}).then(r=>{process.stdout.write(JSON.stringify(r));process.exit(r.runtimeCrashes>0?1:0)}).catch(e=>{console.error(e.message);process.exit(2)})`,
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout: 10 * 60 * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    if (result.status === 2 || result.error) {
      return {
        pass: false,
        skipped: false,
        runtimeCrashes: -1,
        dataGateRejections: 0,
        total: seeds,
        passed: 0,
        failed: seeds,
        error: result.stderr || result.error?.message || 'stress harness crashed',
      };
    }

    try {
      const parsed = JSON.parse(result.stdout);
      return {
        pass: parsed.runtimeCrashes === 0,
        skipped: false,
        runtimeCrashes: parsed.runtimeCrashes || 0,
        dataGateRejections: parsed.dataGateRejections || 0,
        total: parsed.total || seeds,
        passed: parsed.passed || 0,
        failed: parsed.failed || 0,
        report: parsed.report || '',
      };
    } catch {
      return {
        pass: result.status === 0,
        skipped: false,
        runtimeCrashes: result.status === 0 ? 0 : -1,
        dataGateRejections: 0,
        total: seeds,
        passed: result.status === 0 ? seeds : 0,
        failed: result.status === 0 ? 0 : seeds,
        error: 'could not parse stress test output',
      };
    }
  } catch (err) {
    return {
      pass: true,
      skipped: true,
      reason: `stress-test-harness.js not loadable: ${err.message}`,
      runtimeCrashes: 0,
      dataGateRejections: 0,
      total: 0,
      passed: 0,
      failed: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// 6. Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  let stressSeeds = null;
  let reportDir = path.join(PROJECT_ROOT, 'preflight-reports');
  let help = false;
  let strict = false;
  let gateMode = 'dev';
  let expectedBranch = 'main';

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg.startsWith('--stress-seeds=')) {
      const val = parseInt(arg.split('=')[1], 10);
      if (Number.isFinite(val) && val > 0) {
        stressSeeds = Math.min(val, 100);
      }
    } else if (arg.startsWith('--report-dir=')) {
      reportDir = arg.split('=')[1];
    } else if (arg.startsWith('--mode=')) {
      const val = arg.split('=')[1];
      if (val === 'dev' || val === 'test' || val === 'release') {
        gateMode = val;
      }
    } else if (arg.startsWith('--expected-branch=')) {
      expectedBranch = arg.split('=')[1];
    }
  }

  return { stressSeeds, reportDir, help, strict, gateMode, expectedBranch };
}

// ---------------------------------------------------------------------------
// 7. Report generation
// ---------------------------------------------------------------------------
function generateJsonReport(checkResults, metadata) {
  return {
    preflight: true,
    version: '2.0',
    timestamp: metadata.timestamp,
    node: metadata.nodeVersion,
    gitBranch: metadata.gitBranch,
    stressSeeds: metadata.stressSeeds,
    strict: metadata.strict || false,
    gateMode: metadata.gateMode || 'dev',
    overallPass: checkResults.every((r) => r.pass || r.status === 'SKIP' || r.status === 'WARN'),
    checks: checkResults.map((r) => ({
      name: r.name,
      status: r.status,
      pass: r.pass,
      durationMs: r.durationMs || 0,
      details: r.details || null,
      warning: r.warning || null,
    })),
  };
}

function generateMarkdownReport(checkResults, metadata) {
  const lines = [];
  lines.push('# PREFLIGHT RELEASE REPORT');
  lines.push('');
  lines.push(`- **Timestamp**: ${metadata.timestamp}`);
  lines.push(`- **Node**: ${metadata.nodeVersion}`);
  lines.push(`- **Branch**: ${metadata.gitBranch}`);
  if (metadata.gateMode) {
    lines.push(`- **Gate Mode**: ${metadata.gateMode}`);
  }
  if (metadata.strict) {
    lines.push('- **Strict**: YES');
  }
  if (metadata.stressSeeds) {
    lines.push(`- **Stress seeds**: ${metadata.stressSeeds}`);
  }
  lines.push('');

  const overall = checkResults.every(
    (r) => r.pass || r.status === 'SKIP' || (!metadata.strict && r.status === 'WARN')
  );
  lines.push(`## Result: ${overall ? 'PASS' : 'FAIL'}`);
  lines.push('');

  lines.push('| Check | Status | Duration |');
  lines.push('|-------|--------|----------|');
  for (const r of checkResults) {
    const icon =
      r.status === 'PASS'
        ? 'PASS'
        : r.status === 'FAIL'
          ? 'FAIL'
          : r.status === 'WARN'
            ? 'WARN'
            : 'SKIP';
    const dur = r.durationMs ? `${r.durationMs}ms` : '-';
    lines.push(`| ${r.name} | ${icon} | ${dur} |`);
  }
  lines.push('');

  for (const r of checkResults) {
    if (r.details && (r.status === 'FAIL' || r.status === 'WARN')) {
      lines.push(`### ${r.name}`);
      lines.push('');
      if (typeof r.details === 'string') {
        lines.push(r.details);
      } else {
        lines.push('```json');
        lines.push(JSON.stringify(r.details, null, 2));
        lines.push('```');
      }
      lines.push('');
    }
  }

  if (metadata.stressDetails) {
    lines.push('### Stress Test Details');
    lines.push('');
    lines.push(metadata.stressDetails);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 8. Git branch helper
// ---------------------------------------------------------------------------
function getGitBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd: GIT_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// 9. Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
Usage: node scripts/preflight-release.js [options]

Options:
  --strict                  Treat any non-pass (including WARN) as failure;
                            git-degraded paths become hard failures
  --mode=dev|test|release   Gate severity mode (default: dev)
  --expected-branch=NAME    Expected git branch (default: main)
  --stress-seeds=N          Run stress test with N seeds (1-100, default: skip)
  --report-dir=PATH         Output directory for reports (default: preflight-reports/)
  --help                    Show this help

Strict mode git checks:
  In --strict mode, the following are HARD FAILURES (not warnings):
  - Git binary unavailable
  - Uncommitted changes in working tree
  - Not on expected branch (default: main)
  - HEAD SHA unresolvable or orphaned
  - Local branch diverged from origin/main

Examples:
  npm run preflight:release                         # standard checks only
  npm run preflight:stress                          # checks + 30-seed stress test
  node scripts/preflight-release.js --strict        # strict mode (no warnings allowed)
  node scripts/preflight-release.js --mode=release --strict  # release hard gates
  node scripts/preflight-release.js --strict --expected-branch=staging
  node scripts/preflight-release.js --stress-seeds=50
`);
    process.exit(0);
  }

  const modeLabel = args.gateMode.toUpperCase() + (args.strict ? ' / STRICT' : '');
  console.log('');
  console.log(`=== PREFLIGHT RELEASE CHECK (${modeLabel}) ===`);
  if (args.stressSeeds) {
    console.log(`  (stress test enabled: ${args.stressSeeds} seeds)`);
  }
  console.log('');

  const checkResults = [];
  let anyFail = false;

  // --- 0a. Git availability ---
  if (args.strict) {
    const tGit = Date.now();
    const gitAvail = checkGitAvailable();
    const dGit = Date.now() - tGit;
    if (gitAvail.pass) {
      checkResults.push({
        name: 'Git available',
        pass: true,
        status: 'PASS',
        durationMs: dGit,
        details: null,
      });
      console.log('[PASS] Git is available');
    } else {
      anyFail = true;
      checkResults.push({
        name: 'Git available',
        pass: false,
        status: 'FAIL',
        durationMs: dGit,
        details: gitAvail.error,
        remediation: gitAvail.remediation,
      });
      console.log('[FAIL] Git is not available — all git checks will fail');
      console.log(`  Remediation: ${gitAvail.remediation}`);
    }

    // --- 0b. Branch check ---
    const tBranch = Date.now();
    const branchResult = checkGitBranch(args.expectedBranch);
    const dBranch = Date.now() - tBranch;
    if (branchResult.pass) {
      checkResults.push({
        name: 'Git branch',
        pass: true,
        status: 'PASS',
        durationMs: dBranch,
        details: `On branch '${branchResult.branch}'`,
      });
      console.log(`[PASS] On expected branch '${branchResult.branch}'`);
    } else {
      anyFail = true;
      checkResults.push({
        name: 'Git branch',
        pass: false,
        status: 'FAIL',
        durationMs: dBranch,
        details: branchResult.remediation,
        remediation: branchResult.remediation,
      });
      console.log(`[FAIL] Wrong branch: '${branchResult.branch}' (expected '${args.expectedBranch}')`);
      console.log(`  Remediation: ${branchResult.remediation}`);
    }

    // --- 0c. HEAD SHA check ---
    const tSha = Date.now();
    const shaResult = checkHeadSha();
    const dSha = Date.now() - tSha;
    if (shaResult.pass) {
      checkResults.push({
        name: 'HEAD SHA',
        pass: true,
        status: 'PASS',
        durationMs: dSha,
        details: `SHA: ${shaResult.sha.slice(0, 8)} on branch(es): ${shaResult.branches.join(', ')}`,
      });
      console.log(`[PASS] HEAD SHA ${shaResult.sha.slice(0, 8)} is trackable`);
    } else {
      anyFail = true;
      checkResults.push({
        name: 'HEAD SHA',
        pass: false,
        status: 'FAIL',
        durationMs: dSha,
        details: shaResult.remediation,
        remediation: shaResult.remediation,
      });
      console.log(`[FAIL] HEAD SHA not trackable: ${shaResult.sha || 'unknown'}`);
      console.log(`  Remediation: ${shaResult.remediation}`);
    }

    // --- 0d. Divergence check ---
    const tDiv = Date.now();
    const divResult = checkGitDivergence();
    const dDiv = Date.now() - tDiv;
    if (divResult.pass) {
      const aheadMsg = divResult.ahead > 0 ? ` (${divResult.ahead} ahead)` : '';
      checkResults.push({
        name: 'Git divergence',
        pass: true,
        status: 'PASS',
        durationMs: dDiv,
        details: `In sync with origin/main${aheadMsg}`,
      });
      console.log(`[PASS] Not diverged from origin/main${aheadMsg}`);
    } else {
      anyFail = true;
      checkResults.push({
        name: 'Git divergence',
        pass: false,
        status: 'FAIL',
        durationMs: dDiv,
        details: divResult.remediation,
        remediation: divResult.remediation,
      });
      const divergeMsg = divResult.error
        ? divResult.error
        : `${divResult.behind} behind, ${divResult.ahead} ahead`;
      console.log(`[FAIL] Diverged from origin/main: ${divergeMsg}`);
      console.log(`  Remediation: ${divResult.remediation}`);
    }
  }

  // --- 1. Dirty tree ---
  const t1 = Date.now();
  const dirty = checkDirtyTree();
  const d1 = Date.now() - t1;
  if (dirty.pass) {
    checkResults.push({
      name: 'Clean tree',
      pass: true,
      status: 'PASS',
      durationMs: d1,
      details: null,
    });
    console.log('[PASS] Clean working tree (no uncommitted .js/.json changes)');
  } else if (dirty.gitUnavailable) {
    if (args.strict) {
      anyFail = true;
      checkResults.push({
        name: 'Clean tree',
        pass: false,
        status: 'FAIL',
        durationMs: d1,
        warning: dirty.warning,
        details: `git unavailable — cannot verify clean tree.\n  Remediation: ${dirty.remediation}`,
        remediation: dirty.remediation,
      });
      console.log('[FAIL] git unavailable — cannot verify clean tree (strict mode)');
      console.log(`  Remediation: ${dirty.remediation}`);
    } else {
      checkResults.push({
        name: 'Clean tree',
        pass: true,
        status: 'WARN',
        durationMs: d1,
        warning: dirty.warning,
        details: null,
        remediation: dirty.remediation,
      });
      console.log(`[WARN] ${dirty.warning}`);
      console.log(`  Remediation: ${dirty.remediation}`);
    }
  } else {
    anyFail = true;
    checkResults.push({
      name: 'Clean tree',
      pass: false,
      status: 'FAIL',
      durationMs: d1,
      details: dirty.dirty.join('\n'),
      remediation: dirty.remediation,
    });
    console.log("[FAIL] Uncommitted changes — deployed commit won't include these:");
    for (const d of dirty.dirty) console.log(`  ${d}`);
    console.log(`  Remediation: ${dirty.remediation}`);
  }

  // --- 2. HEAD content ---
  const t2 = Date.now();
  const head = verifyHeadContent(DEFAULT_HEAD_CHECKS);
  const d2 = Date.now() - t2;
  const headRemediation =
    "Commit your changes with 'git add -A && git commit -m \"fix\"'. " +
    "Then re-run preflight to verify HEAD contains all required patterns.";
  if (head.pass) {
    const status = head.degradedMode ? 'WARN' : 'PASS';

    if (args.strict && status === 'WARN') {
      anyFail = true;
      checkResults.push({
        name: 'HEAD content',
        pass: false,
        status: 'FAIL',
        durationMs: d2,
        details: 'Strict mode: degraded HEAD check treated as failure',
        remediation:
          "git is blocked — HEAD content could not be verified against the actual commit. " +
          "Ensure git is available and the repository is valid. Run 'git show HEAD:backend/market-research/server.js' to test.",
      });
      console.log('[FAIL] HEAD content verified in degraded mode (strict mode rejects warnings)');
      console.log('  Remediation: Ensure git is available for accurate HEAD content verification.');
    } else {
      checkResults.push({
        name: 'HEAD content',
        pass: true,
        status,
        durationMs: d2,
        warning: head.degradedMode ? 'Ran in degraded mode (local files, not git HEAD)' : null,
        details: null,
      });
      console.log(
        `[${status}] HEAD content verified (${head.passedPatterns}/${head.totalPatterns} patterns)`
      );
      if (head.degradedMode) {
        console.log('  [WARN] git execution blocked — validated local files instead of HEAD');
      }
    }
  } else {
    anyFail = true;
    const detailLines = [];
    for (const f of head.failures) {
      for (const m of f.missing) {
        const line = `${f.file}: missing "${m}"${f.error ? ` (${f.error})` : ''}`;
        detailLines.push(line);
        console.log(`  ${line}`);
      }
    }
    checkResults.push({
      name: 'HEAD content',
      pass: false,
      status: 'FAIL',
      durationMs: d2,
      details: detailLines.join('\n'),
      remediation: headRemediation,
    });
    console.log(`[FAIL] HEAD content (${head.passedPatterns}/${head.totalPatterns} patterns)`);
    console.log(`  Remediation: ${headRemediation}`);
  }

  // --- 3. Module imports ---
  const t3 = Date.now();
  const imports = checkModuleImports();
  const d3 = Date.now() - t3;
  if (imports.pass) {
    checkResults.push({
      name: 'Module imports',
      pass: true,
      status: 'PASS',
      durationMs: d3,
      details: null,
    });
    console.log(`[PASS] Module imports (${imports.loadedCount}/${imports.total} loaded)`);
  } else {
    anyFail = true;
    const detailLines = imports.failures.map((f) => `${f.module}: ${f.error}`);
    checkResults.push({
      name: 'Module imports',
      pass: false,
      status: 'FAIL',
      durationMs: d3,
      details: detailLines.join('\n'),
    });
    console.log(`[FAIL] Module imports (${imports.loadedCount}/${imports.total} loaded):`);
    for (const f of imports.failures) console.log(`  ${f.module}: ${f.error}`);
  }

  // --- 4. Regression tests ---
  if (anyFail) {
    checkResults.push({
      name: 'Regression tests',
      pass: true,
      status: 'SKIP',
      durationMs: 0,
      details: 'Skipped due to earlier failures',
    });
    console.log('[SKIP] Regression tests (skipped — fix above failures first)');
  } else {
    console.log('[....] Running regression tests...');
    const t4 = Date.now();
    const regression = runRegressionTests();
    const d4 = Date.now() - t4;
    if (regression.pass) {
      checkResults.push({
        name: 'Regression tests',
        pass: true,
        status: 'PASS',
        durationMs: d4,
        details: null,
      });
      console.log(`[PASS] Regression tests passed (${(d4 / 1000).toFixed(1)}s)`);
    } else {
      anyFail = true;
      const reason = regression.signal
        ? `killed by signal ${regression.signal}`
        : `exit code ${regression.exitCode}`;
      checkResults.push({
        name: 'Regression tests',
        pass: false,
        status: 'FAIL',
        durationMs: d4,
        details: reason,
      });
      console.log(`[FAIL] Regression tests failed (${reason})`);
    }
  }

  // --- 5. Stress test (optional) ---
  if (args.stressSeeds) {
    if (anyFail) {
      checkResults.push({
        name: 'Stress test',
        pass: true,
        status: 'SKIP',
        durationMs: 0,
        details: 'Skipped due to earlier failures',
      });
      console.log('[SKIP] Stress test (skipped — fix above failures first)');
    } else {
      console.log(`[....] Running stress test (${args.stressSeeds} seeds)...`);
      const t5 = Date.now();
      const stress = runStressCheck(args.stressSeeds);
      const d5 = Date.now() - t5;

      if (stress.skipped) {
        checkResults.push({
          name: 'Stress test',
          pass: true,
          status: 'SKIP',
          durationMs: d5,
          details: stress.reason,
        });
        console.log(`[SKIP] Stress test: ${stress.reason}`);
      } else if (stress.pass) {
        const summary = `${stress.passed}/${stress.total} passed, ${stress.dataGateRejections} expected gate rejections, 0 runtime crashes`;
        checkResults.push({
          name: 'Stress test',
          pass: true,
          status: 'PASS',
          durationMs: d5,
          details: summary,
        });
        console.log(`[PASS] Stress test (${summary}, ${(d5 / 1000).toFixed(1)}s)`);
      } else {
        anyFail = true;
        const summary = `${stress.runtimeCrashes} runtime crash(es) out of ${stress.total} seeds`;
        checkResults.push({
          name: 'Stress test',
          pass: false,
          status: 'FAIL',
          durationMs: d5,
          details: summary,
        });
        console.log(`[FAIL] Stress test: ${summary}`);
      }
    }
  }

  // --- Generate reports ---
  const metadata = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    gitBranch: getGitBranch(),
    stressSeeds: args.stressSeeds,
    strict: args.strict,
    gateMode: args.gateMode,
  };

  const jsonReport = generateJsonReport(checkResults, metadata);
  const mdReport = generateMarkdownReport(checkResults, metadata);

  try {
    if (!fs.existsSync(args.reportDir)) {
      fs.mkdirSync(args.reportDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(args.reportDir, 'preflight-report.json'),
      JSON.stringify(jsonReport, null, 2)
    );
    fs.writeFileSync(path.join(args.reportDir, 'preflight-report.md'), mdReport);
    console.log('');
    console.log(`Reports: ${args.reportDir}/preflight-report.{json,md}`);
  } catch (reportErr) {
    console.log(`[WARN] Could not write reports: ${reportErr.message}`);
  }

  // --- Final verdict ---
  console.log('');
  if (anyFail) {
    console.log('=== PREFLIGHT FAILED — do NOT deploy ===');
    console.log('');
    process.exit(1);
  } else {
    const hasWarns = checkResults.some((r) => r.status === 'WARN');
    if (args.strict && hasWarns) {
      // Strict mode: warnings are failures (should already be caught above, but safety net)
      console.log('=== PREFLIGHT FAILED — strict mode rejects warnings ===');
      console.log('');
      process.exit(1);
    } else if (hasWarns) {
      console.log('=== PREFLIGHT PASSED WITH WARNINGS — review warnings above ===');
    } else {
      console.log('=== ALL CHECKS PASSED — safe to deploy ===');
    }
    console.log('');
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  checkDirtyTree,
  checkGitAvailable,
  checkGitBranch,
  checkHeadSha,
  checkGitDivergence,
  verifyHeadContent,
  checkModuleImports,
  runRegressionTests,
  runStressCheck,
  parseArgs,
  generateJsonReport,
  generateMarkdownReport,
  DEFAULT_HEAD_CHECKS,
};
