#!/usr/bin/env node
'use strict';

/**
 * Release Loop FlowManager
 *
 * One command to run the full local release loop:
 *   preflight -> regression -> stress (configurable) -> 2 extra rounds -> fresh PPT -> final report
 *
 * Usage:
 *   node scripts/release-loop.js
 *   node scripts/release-loop.js --stress-seeds=100
 *   node scripts/release-loop.js --skip-ppt
 *   node scripts/release-loop.js --verbose
 *   node scripts/release-loop.js --stress-seeds=300 --verbose
 *
 * Exit codes:
 *   0 = GO (all steps passed)
 *   1 = NO-GO (a step failed)
 *   2 = Internal error (script bug or environment issue)
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(PROJECT_ROOT, 'release-reports');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  let stressSeeds = 30;
  let skipPpt = false;
  let verbose = false;
  let help = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--skip-ppt') {
      skipPpt = true;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg.startsWith('--stress-seeds=')) {
      const val = parseInt(arg.split('=')[1], 10);
      if (Number.isFinite(val) && val > 0) {
        stressSeeds = val;
      }
    }
  }

  return { stressSeeds, skipPpt, verbose, help };
}

// ---------------------------------------------------------------------------
// Step runner — runs a child process and captures result
// ---------------------------------------------------------------------------
function runStep(name, command, args, opts = {}) {
  const startMs = Date.now();
  const stdio = opts.verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'];

  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: opts.timeout || 10 * 60 * 1000,
    stdio,
  });

  const durationMs = Date.now() - startMs;
  const pass = result.status === 0;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';

  return {
    name,
    pass,
    exitCode: result.status,
    signal: result.signal,
    durationMs,
    stdout: stdout.slice(0, 5000),
    stderr: stderr.slice(0, 5000),
    error: result.error ? result.error.message : null,
  };
}

// ---------------------------------------------------------------------------
// Remediation messages for each step
// ---------------------------------------------------------------------------
const REMEDIATION = {
  preflight: [
    'Fix dirty tree: commit or stash uncommitted changes.',
    'Fix HEAD content: ensure key functions exist in committed files.',
    'Fix module imports: check require paths and syntax errors.',
    'Run: node scripts/preflight-release.js --help for details.',
  ],
  'regression-round-1': [
    'Regression tests failed on initial round.',
    'Run: node regression-tests.js --rounds=1 to see detailed output.',
    'Check template-fill.js, content-gates.js, and deck-builder-single.js.',
  ],
  'stress-test': [
    'Stress test found runtime crashes.',
    'Run: node stress-test-harness.js to replay failures.',
    'Check stress-report.md for crash details and seed numbers.',
    'Replay a specific seed: node stress-test-harness.js --seed=<N>',
  ],
  'regression-round-2': [
    'Regression failed on confirmation round 2.',
    'This suggests a flaky or environment-dependent test.',
    'Run: node regression-tests.js --rounds=1 multiple times to isolate.',
  ],
  'regression-round-3': [
    'Regression failed on confirmation round 3.',
    'This suggests a flaky or environment-dependent test.',
    'Run: node regression-tests.js --rounds=1 multiple times to isolate.',
  ],
  'ppt-generation': [
    'PPT generation failed.',
    'Check if GEMINI_API_KEY and SENDGRID_API_KEY are set.',
    'Run: node ops-runbook.js --playbook ppt-repair for troubleshooting.',
    'Try: node scripts/release-loop.js --skip-ppt to skip this step.',
  ],
  'final-check': [
    'Final check failed after all rounds passed.',
    'Run: node scripts/preflight-release.js --strict for details.',
    'Check module imports and HEAD content.',
  ],
};

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------
function runReleaseLoop(argv) {
  const args = parseArgs(argv || []);

  if (args.help) {
    console.log(`
Usage: node scripts/release-loop.js [options]

Options:
  --stress-seeds=N    Number of stress test seeds (default: 30)
  --skip-ppt          Skip PPT generation step
  --verbose, -v       Show full output from each step
  --help              Show this help

Examples:
  npm run release:loop                          # standard release loop
  npm run release:loop:deep                     # deep release loop (300 seeds)
  node scripts/release-loop.js --stress-seeds=100 --verbose
`);
    return { verdict: 'HELP', exitCode: 0, steps: [], report: null };
  }

  const startMs = Date.now();
  const steps = [];
  let failed = false;
  let failedStep = null;

  console.log('');
  console.log('=== RELEASE LOOP ===');
  console.log(`  Stress seeds: ${args.stressSeeds}`);
  console.log(`  Skip PPT: ${args.skipPpt}`);
  console.log(`  Verbose: ${args.verbose}`);
  console.log('');

  // -----------------------------------------------------------------------
  // Step 1: Preflight checks
  // -----------------------------------------------------------------------
  console.log('[1/6] Preflight checks...');
  const preflight = runStep(
    'preflight',
    'node',
    ['scripts/preflight-release.js'],
    { verbose: args.verbose, timeout: 5 * 60 * 1000 }
  );
  steps.push(preflight);
  if (!preflight.pass) {
    failed = true;
    failedStep = 'preflight';
    console.log(`[FAIL] Preflight checks failed (exit ${preflight.exitCode}, ${preflight.durationMs}ms)`);
  } else {
    console.log(`[PASS] Preflight checks (${preflight.durationMs}ms)`);
  }

  // -----------------------------------------------------------------------
  // Step 2: Regression tests (round 1)
  // -----------------------------------------------------------------------
  if (!failed) {
    console.log('[2/6] Regression tests (round 1)...');
    const regression1 = runStep(
      'regression-round-1',
      'node',
      ['regression-tests.js', '--rounds=1'],
      { verbose: args.verbose, timeout: 5 * 60 * 1000 }
    );
    steps.push(regression1);
    if (!regression1.pass) {
      failed = true;
      failedStep = 'regression-round-1';
      console.log(`[FAIL] Regression round 1 failed (exit ${regression1.exitCode}, ${regression1.durationMs}ms)`);
    } else {
      console.log(`[PASS] Regression round 1 (${regression1.durationMs}ms)`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 3: Stress tests
  // -----------------------------------------------------------------------
  if (!failed) {
    console.log(`[3/6] Stress tests (${args.stressSeeds} seeds)...`);
    const stress = runStep(
      'stress-test',
      'node',
      ['regression-tests.js', '--rounds=1', '--stress', `--stress-seeds=${args.stressSeeds}`],
      { verbose: args.verbose, timeout: 10 * 60 * 1000 }
    );
    steps.push(stress);
    if (!stress.pass) {
      failed = true;
      failedStep = 'stress-test';
      console.log(`[FAIL] Stress tests failed (exit ${stress.exitCode}, ${stress.durationMs}ms)`);
    } else {
      console.log(`[PASS] Stress tests (${stress.durationMs}ms)`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 4: Regression tests (confirmation round 2)
  // -----------------------------------------------------------------------
  if (!failed) {
    console.log('[4/6] Regression tests (confirmation round 2)...');
    const regression2 = runStep(
      'regression-round-2',
      'node',
      ['regression-tests.js', '--rounds=1'],
      { verbose: args.verbose, timeout: 5 * 60 * 1000 }
    );
    steps.push(regression2);
    if (!regression2.pass) {
      failed = true;
      failedStep = 'regression-round-2';
      console.log(`[FAIL] Regression round 2 failed (exit ${regression2.exitCode}, ${regression2.durationMs}ms)`);
    } else {
      console.log(`[PASS] Regression round 2 (${regression2.durationMs}ms)`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 5: Regression tests (confirmation round 3)
  // -----------------------------------------------------------------------
  if (!failed) {
    console.log('[5/6] Regression tests (confirmation round 3)...');
    const regression3 = runStep(
      'regression-round-3',
      'node',
      ['regression-tests.js', '--rounds=1'],
      { verbose: args.verbose, timeout: 5 * 60 * 1000 }
    );
    steps.push(regression3);
    if (!regression3.pass) {
      failed = true;
      failedStep = 'regression-round-3';
      console.log(`[FAIL] Regression round 3 failed (exit ${regression3.exitCode}, ${regression3.durationMs}ms)`);
    } else {
      console.log(`[PASS] Regression round 3 (${regression3.durationMs}ms)`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 6: PPT generation (or skip)
  // -----------------------------------------------------------------------
  if (!failed) {
    if (args.skipPpt) {
      steps.push({
        name: 'ppt-generation',
        pass: true,
        exitCode: 0,
        signal: null,
        durationMs: 0,
        stdout: '',
        stderr: '',
        error: null,
        skipped: true,
      });
      console.log('[SKIP] PPT generation (--skip-ppt)');
    } else {
      console.log('[6/6] PPT generation test...');
      // Try to run test-ppt-generation.js if it exists, otherwise use
      // the validate-output module for a dry-run check
      const pptScript = fs.existsSync(path.join(PROJECT_ROOT, 'test-ppt-generation.js'))
        ? 'test-ppt-generation.js'
        : null;

      if (pptScript) {
        const pptResult = runStep(
          'ppt-generation',
          'node',
          [pptScript],
          { verbose: args.verbose, timeout: 10 * 60 * 1000 }
        );
        steps.push(pptResult);
        if (!pptResult.pass) {
          failed = true;
          failedStep = 'ppt-generation';
          console.log(`[FAIL] PPT generation failed (exit ${pptResult.exitCode}, ${pptResult.durationMs}ms)`);
        } else {
          console.log(`[PASS] PPT generation (${pptResult.durationMs}ms)`);
        }
      } else {
        // No PPT generation script available — run a preflight in release mode instead
        const finalCheck = runStep(
          'ppt-generation',
          'node',
          ['scripts/preflight-release.js', '--mode=release'],
          { verbose: args.verbose, timeout: 5 * 60 * 1000 }
        );
        steps.push(finalCheck);
        if (!finalCheck.pass) {
          failed = true;
          failedStep = 'ppt-generation';
          console.log(`[FAIL] Release-mode preflight failed (exit ${finalCheck.exitCode}, ${finalCheck.durationMs}ms)`);
        } else {
          console.log(`[PASS] Release-mode preflight (${finalCheck.durationMs}ms)`);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Generate report
  // -----------------------------------------------------------------------
  const totalDurationMs = Date.now() - startMs;
  const verdict = failed ? 'NO-GO' : 'GO';
  const exitCode = failed ? 1 : 0;

  const report = generateReport(steps, {
    verdict,
    failedStep,
    stressSeeds: args.stressSeeds,
    skipPpt: args.skipPpt,
    totalDurationMs,
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
  });

  // Write reports
  try {
    if (!fs.existsSync(REPORT_DIR)) {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
    }
    fs.writeFileSync(
      path.join(REPORT_DIR, 'release-report.json'),
      JSON.stringify(report.json, null, 2)
    );
    fs.writeFileSync(
      path.join(REPORT_DIR, 'release-report.md'),
      report.markdown
    );
    console.log('');
    console.log(`Reports: ${REPORT_DIR}/release-report.{json,md}`);
  } catch (err) {
    console.log(`[WARN] Could not write reports: ${err.message}`);
  }

  // Final verdict
  console.log('');
  if (failed) {
    console.log(`=== VERDICT: NO-GO (failed at: ${failedStep}) ===`);
    console.log('');
    console.log('Remediation:');
    const remediationSteps = REMEDIATION[failedStep] || ['Check the output above for details.'];
    for (const step of remediationSteps) {
      console.log(`  - ${step}`);
    }
    console.log('');
  } else {
    console.log(`=== VERDICT: GO (all ${steps.length} steps passed in ${(totalDurationMs / 1000).toFixed(1)}s) ===`);
    console.log('');
  }

  return { verdict, exitCode, steps, report };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------
function generateReport(steps, metadata) {
  const json = {
    releaseLoop: true,
    version: '1.0',
    verdict: metadata.verdict,
    timestamp: metadata.timestamp,
    node: metadata.nodeVersion,
    stressSeeds: metadata.stressSeeds,
    skipPpt: metadata.skipPpt,
    totalDurationMs: metadata.totalDurationMs,
    failedStep: metadata.failedStep,
    steps: steps.map((s) => ({
      name: s.name,
      pass: s.pass,
      exitCode: s.exitCode,
      durationMs: s.durationMs,
      skipped: s.skipped || false,
      error: s.error || null,
    })),
    remediation: metadata.failedStep
      ? REMEDIATION[metadata.failedStep] || null
      : null,
  };

  const mdLines = [];
  mdLines.push('# RELEASE LOOP REPORT');
  mdLines.push('');
  mdLines.push(`- **Verdict**: ${metadata.verdict}`);
  mdLines.push(`- **Timestamp**: ${metadata.timestamp}`);
  mdLines.push(`- **Node**: ${metadata.nodeVersion}`);
  mdLines.push(`- **Duration**: ${(metadata.totalDurationMs / 1000).toFixed(1)}s`);
  mdLines.push(`- **Stress seeds**: ${metadata.stressSeeds}`);
  mdLines.push(`- **Skip PPT**: ${metadata.skipPpt}`);
  mdLines.push('');
  mdLines.push(`## Result: ${metadata.verdict}`);
  mdLines.push('');
  mdLines.push('| Step | Status | Duration |');
  mdLines.push('|------|--------|----------|');
  for (const s of steps) {
    const status = s.skipped ? 'SKIP' : s.pass ? 'PASS' : 'FAIL';
    const dur = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '-';
    mdLines.push(`| ${s.name} | ${status} | ${dur} |`);
  }
  mdLines.push('');

  if (metadata.failedStep) {
    mdLines.push(`## Failed Step: ${metadata.failedStep}`);
    mdLines.push('');
    mdLines.push('### Remediation');
    mdLines.push('');
    const remSteps = REMEDIATION[metadata.failedStep] || ['Check output above.'];
    for (const step of remSteps) {
      mdLines.push(`- ${step}`);
    }
    mdLines.push('');

    // Include stderr/stdout from failed step
    const failedStepData = steps.find((s) => s.name === metadata.failedStep);
    if (failedStepData) {
      if (failedStepData.stderr) {
        mdLines.push('### Error Output');
        mdLines.push('');
        mdLines.push('```');
        mdLines.push(failedStepData.stderr.slice(0, 2000));
        mdLines.push('```');
        mdLines.push('');
      }
      if (failedStepData.stdout) {
        mdLines.push('### Standard Output');
        mdLines.push('');
        mdLines.push('```');
        mdLines.push(failedStepData.stdout.slice(0, 2000));
        mdLines.push('```');
        mdLines.push('');
      }
    }
  }

  const markdown = mdLines.join('\n');
  return { json, markdown };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  try {
    const result = runReleaseLoop(process.argv.slice(2));
    process.exit(result.exitCode);
  } catch (err) {
    console.error(`[FATAL] Release loop internal error: ${err.message}`);
    process.exit(2);
  }
}

module.exports = { runReleaseLoop, parseArgs, generateReport, REMEDIATION };
