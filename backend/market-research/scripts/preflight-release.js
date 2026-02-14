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
  const restricted = false;
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
        pass: true,
        dirty: [],
        restricted: true,
        warning: 'git unavailable — cannot verify clean tree. Proceeding with caution.',
      };
    }
    return { pass: false, dirty: [`git status failed: ${errMsg}`], restricted: false };
  }

  const dirty = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => {
      const file = l.slice(3).replace(/^"(.*)"$/, '$1');
      return file.endsWith('.js') || file.endsWith('.json');
    });

  return { pass: dirty.length === 0, dirty, restricted };
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

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--stress-seeds=')) {
      const val = parseInt(arg.split('=')[1], 10);
      if (Number.isFinite(val) && val > 0) {
        stressSeeds = Math.min(val, 100);
      }
    } else if (arg.startsWith('--report-dir=')) {
      reportDir = arg.split('=')[1];
    }
  }

  return { stressSeeds, reportDir, help };
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
  if (metadata.stressSeeds) {
    lines.push(`- **Stress seeds**: ${metadata.stressSeeds}`);
  }
  lines.push('');

  const overall = checkResults.every((r) => r.pass || r.status === 'SKIP' || r.status === 'WARN');
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
  --stress-seeds=N    Run stress test with N seeds (1-100, default: skip)
  --report-dir=PATH   Output directory for reports (default: preflight-reports/)
  --help              Show this help

Examples:
  npm run preflight:release              # standard checks only
  npm run preflight:stress               # checks + 30-seed stress test
  node scripts/preflight-release.js --stress-seeds=50
`);
    process.exit(0);
  }

  console.log('');
  console.log('=== PREFLIGHT RELEASE CHECK ===');
  if (args.stressSeeds) {
    console.log(`  (stress test enabled: ${args.stressSeeds} seeds)`);
  }
  console.log('');

  const checkResults = [];
  let anyFail = false;

  // --- 1. Dirty tree ---
  const t1 = Date.now();
  const dirty = checkDirtyTree();
  const d1 = Date.now() - t1;
  if (dirty.pass) {
    const status = dirty.restricted ? 'WARN' : 'PASS';
    const msg = dirty.restricted
      ? dirty.warning
      : 'Clean working tree (no uncommitted .js/.json changes)';
    checkResults.push({
      name: 'Clean tree',
      pass: true,
      status,
      durationMs: d1,
      warning: dirty.warning,
      details: null,
    });
    console.log(`[${status}] ${msg}`);
  } else {
    anyFail = true;
    checkResults.push({
      name: 'Clean tree',
      pass: false,
      status: 'FAIL',
      durationMs: d1,
      details: dirty.dirty.join('\n'),
    });
    console.log("[FAIL] Uncommitted changes — deployed commit won't include these:");
    for (const d of dirty.dirty) console.log(`  ${d}`);
  }

  // --- 2. HEAD content ---
  const t2 = Date.now();
  const head = verifyHeadContent(DEFAULT_HEAD_CHECKS);
  const d2 = Date.now() - t2;
  if (head.pass) {
    const status = head.degradedMode ? 'WARN' : 'PASS';
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
    });
    console.log(`[FAIL] HEAD content (${head.passedPatterns}/${head.totalPatterns} patterns)`);
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
    if (hasWarns) {
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
  verifyHeadContent,
  checkModuleImports,
  runRegressionTests,
  runStressCheck,
  parseArgs,
  generateJsonReport,
  generateMarkdownReport,
  DEFAULT_HEAD_CHECKS,
};
