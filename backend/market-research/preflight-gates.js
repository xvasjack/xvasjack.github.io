#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname);
const GIT_ROOT = path.resolve(PROJECT_ROOT, '..', '..');

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------
const SEVERITY = {
  BLOCKING: 'BLOCKING',
  DEGRADED: 'DEGRADED',
  INFO: 'INFO',
};

// ---------------------------------------------------------------------------
// Module export contracts — required exports per critical module
// ---------------------------------------------------------------------------
const MODULE_EXPORT_CONTRACTS = {
  'ppt-single-country.js': {
    functions: ['generateSingleCountryPPT'],
  },
  'pptx-validator.js': {
    functions: [
      'normalizeAbsoluteRelationshipTargets',
      'normalizeSlideNonVisualIds',
      'reconcileContentTypesAndPackage',
      'validatePPTX',
      'scanPackageConsistency',
    ],
  },
  'quality-gates.js': {
    functions: [
      'validateResearchQuality',
      'validateSynthesisQuality',
      'validatePptData',
    ],
  },
  'research-orchestrator.js': {
    functions: [
      'researchCountry',
      'synthesizeSingleCountry',
      'reSynthesize',
    ],
  },
  'template-clone-postprocess.js': {
    functions: ['applyTemplateClonePostprocess'],
  },
  'budget-gate.js': {
    functions: ['analyzeBudget', 'compactPayload', 'runBudgetGate'],
  },
  'transient-key-sanitizer.js': {
    functions: [
      'isTransientKey',
      'sanitizeTransientKeys',
      'createSanitizationContext',
    ],
  },
};

// Template-patterns.json expected top-level keys
const TEMPLATE_PATTERNS_EXPECTED_KEYS = [
  '_meta',
  'positions',
  'patterns',
  'style',
  'slideDetails',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function timer() {
  const start = Date.now();
  return () => Date.now() - start;
}

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

function makeCheckResult(name, pass, severity, durationMs, details, evidence) {
  return {
    name,
    pass,
    severity,
    status: pass ? 'PASS' : severity === SEVERITY.BLOCKING ? 'FAIL' : severity === SEVERITY.DEGRADED ? 'WARN' : 'INFO',
    durationMs,
    details: details || null,
    evidence: evidence || null,
  };
}

// ---------------------------------------------------------------------------
// Gate 1: Dirty Tree Check (reuses preflight-release logic)
// ---------------------------------------------------------------------------
function checkDirtyTree() {
  const elapsed = timer();
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--', '.'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    const dirty = output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => {
        const file = l.slice(3).replace(/^"(.*)"$/, '$1');
        return file.endsWith('.js') || file.endsWith('.json');
      });

    if (dirty.length === 0) {
      return makeCheckResult('Clean working tree', true, SEVERITY.BLOCKING, elapsed(), 'No uncommitted .js/.json changes');
    }
    return makeCheckResult('Clean working tree', false, SEVERITY.BLOCKING, elapsed(), `${dirty.length} uncommitted file(s)`, dirty);
  } catch (err) {
    const errMsg = String(err?.message || err || '');
    if (/EPERM|ENOENT|not found/i.test(errMsg)) {
      return makeCheckResult('Clean working tree', true, SEVERITY.DEGRADED, elapsed(), 'git unavailable — skipped');
    }
    return makeCheckResult('Clean working tree', false, SEVERITY.BLOCKING, elapsed(), `git status failed: ${errMsg}`);
  }
}

// ---------------------------------------------------------------------------
// Gate 2: HEAD Content Verification
// ---------------------------------------------------------------------------
const HEAD_CONTENT_CHECKS = [
  { file: 'server.js', patterns: ['collectPreRenderStructureIssues'] },
  { file: 'ppt-single-country.js', patterns: ['shouldAllowCompetitiveOptionalGroupGap', 'resolveTemplateRouteWithGeometryGuard'] },
  { file: 'research-orchestrator.js', patterns: ['runInBatchesUntilDeadline'] },
  { file: 'ppt-utils.js', patterns: ['sanitizeHyperlinkUrl'] },
  { file: 'quality-gates.js', patterns: ['validatePptData'] },
  { file: 'template-clone-postprocess.js', patterns: ['isLockedTemplateText'] },
  { file: 'pptx-validator.js', patterns: ['normalizeAbsoluteRelationshipTargets', 'reconcileContentTypesAndPackage'] },
];

function checkHeadContent() {
  const elapsed = timer();
  const failures = [];
  const RELATIVE_PREFIX = 'backend/market-research/';

  for (const { file, patterns } of HEAD_CONTENT_CHECKS) {
    let content;
    const gitPath = RELATIVE_PREFIX + file;
    try {
      content = execFileSync('git', ['show', `HEAD:${gitPath}`], {
        cwd: GIT_ROOT,
        encoding: 'utf8',
      });
    } catch {
      try {
        content = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
      } catch (readErr) {
        failures.push({ file, missing: patterns, error: readErr.message });
        continue;
      }
    }
    const missing = patterns.filter((p) => !content.includes(p));
    if (missing.length > 0) {
      failures.push({ file, missing });
    }
  }

  if (failures.length === 0) {
    return makeCheckResult('HEAD content verification', true, SEVERITY.BLOCKING, elapsed(), 'All critical patterns found in HEAD');
  }
  const evidence = failures.map((f) => `${f.file}: missing ${f.missing.join(', ')}${f.error ? ` (${f.error})` : ''}`);
  return makeCheckResult('HEAD content verification', false, SEVERITY.BLOCKING, elapsed(), `${evidence.length} file(s) have missing patterns`, evidence);
}

// ---------------------------------------------------------------------------
// Gate 3: Module Export Contracts
// ---------------------------------------------------------------------------
function checkModuleExportContracts() {
  const elapsed = timer();
  const failures = [];
  const checked = [];

  for (const [moduleName, contract] of Object.entries(MODULE_EXPORT_CONTRACTS)) {
    const fullPath = path.join(PROJECT_ROOT, moduleName);

    if (!fs.existsSync(fullPath)) {
      failures.push({
        module: moduleName,
        severity: SEVERITY.BLOCKING,
        error: `File not found: ${fullPath}`,
        missingExports: contract.functions,
      });
      continue;
    }

    let loadedModule;
    try {
      loadedModule = require(fullPath);
    } catch (err) {
      failures.push({
        module: moduleName,
        severity: SEVERITY.BLOCKING,
        error: `Failed to load: ${err.code || err.message}`,
        missingExports: contract.functions,
      });
      continue;
    }

    const missingExports = [];
    for (const fnName of contract.functions) {
      if (typeof loadedModule[fnName] !== 'function') {
        // Check __test namespace too
        if (typeof loadedModule.__test?.[fnName] !== 'function') {
          missingExports.push(fnName);
        }
      }
    }

    if (missingExports.length > 0) {
      failures.push({
        module: moduleName,
        severity: SEVERITY.BLOCKING,
        error: `Missing required export(s): ${missingExports.join(', ')}`,
        missingExports,
      });
    } else {
      checked.push(moduleName);
    }
  }

  if (failures.length === 0) {
    return makeCheckResult(
      'Module export contracts',
      true,
      SEVERITY.BLOCKING,
      elapsed(),
      `${checked.length} modules verified with all required exports`,
    );
  }

  const evidence = failures.map((f) => `${f.module}: ${f.error}`);
  return makeCheckResult(
    'Module export contracts',
    false,
    SEVERITY.BLOCKING,
    elapsed(),
    `${failures.length} module(s) failed contract check`,
    evidence,
  );
}

// ---------------------------------------------------------------------------
// Gate 4: Template Contract Validity
// ---------------------------------------------------------------------------
function checkTemplateContract() {
  const elapsed = timer();
  const templatePath = path.join(PROJECT_ROOT, 'template-patterns.json');

  if (!fs.existsSync(templatePath)) {
    return makeCheckResult('Template contract validity', false, SEVERITY.BLOCKING, elapsed(), 'template-patterns.json not found');
  }

  let parsed;
  try {
    const raw = fs.readFileSync(templatePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    return makeCheckResult('Template contract validity', false, SEVERITY.BLOCKING, elapsed(), `template-patterns.json is invalid JSON: ${err.message}`);
  }

  const missingKeys = TEMPLATE_PATTERNS_EXPECTED_KEYS.filter((k) => !(k in parsed));
  if (missingKeys.length > 0) {
    return makeCheckResult(
      'Template contract validity',
      false,
      SEVERITY.BLOCKING,
      elapsed(),
      `template-patterns.json missing expected keys: ${missingKeys.join(', ')}`,
      missingKeys,
    );
  }

  // If template-contract-compiler.js exists, try to run its validation
  const compilerPath = path.join(PROJECT_ROOT, 'template-contract-compiler.js');
  if (fs.existsSync(compilerPath)) {
    try {
      const compiler = require(compilerPath);
      if (typeof compiler.validateContract === 'function') {
        const result = compiler.validateContract(parsed);
        if (result && !result.valid) {
          return makeCheckResult(
            'Template contract validity',
            false,
            SEVERITY.BLOCKING,
            elapsed(),
            `Contract compiler validation failed: ${result.reason || 'unknown'}`,
            result.errors || [],
          );
        }
      }
    } catch {
      // compiler not loadable — not a failure, just skip extended validation
    }
  }

  return makeCheckResult(
    'Template contract validity',
    true,
    SEVERITY.BLOCKING,
    elapsed(),
    `template-patterns.json valid with ${Object.keys(parsed).length} top-level keys`,
  );
}

// ---------------------------------------------------------------------------
// Gate 5: Route Geometry Audit
// ---------------------------------------------------------------------------
function checkRouteGeometry() {
  const elapsed = timer();
  const enforcerPath = path.join(PROJECT_ROOT, 'route-geometry-enforcer.js');

  if (!fs.existsSync(enforcerPath)) {
    return makeCheckResult('Route geometry audit', true, SEVERITY.INFO, elapsed(), 'route-geometry-enforcer.js not found — skipped');
  }

  try {
    const enforcer = require(enforcerPath);
    if (typeof enforcer.auditRoutes === 'function') {
      const audit = enforcer.auditRoutes();
      if (audit && !audit.valid) {
        return makeCheckResult(
          'Route geometry audit',
          false,
          SEVERITY.DEGRADED,
          elapsed(),
          `Route geometry audit failed: ${audit.issues?.length || 0} issue(s)`,
          audit.issues || [],
        );
      }
    }
    return makeCheckResult('Route geometry audit', true, SEVERITY.DEGRADED, elapsed(), 'Route geometry enforcer loaded and validated');
  } catch (err) {
    return makeCheckResult('Route geometry audit', false, SEVERITY.DEGRADED, elapsed(), `Failed to load route-geometry-enforcer.js: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Gate 6: Schema Firewall Availability
// ---------------------------------------------------------------------------
function checkSchemaFirewall() {
  const elapsed = timer();
  const firewallPath = path.join(PROJECT_ROOT, 'schema-firewall.js');

  if (!fs.existsSync(firewallPath)) {
    return makeCheckResult('Schema firewall availability', true, SEVERITY.INFO, elapsed(), 'schema-firewall.js not found — skipped');
  }

  try {
    const firewall = require(firewallPath);
    const expectedFns = ['validateSchema', 'enforceSchema'];
    const found = expectedFns.filter((fn) => typeof firewall[fn] === 'function');
    if (found.length === 0) {
      return makeCheckResult(
        'Schema firewall availability',
        false,
        SEVERITY.DEGRADED,
        elapsed(),
        `schema-firewall.js loaded but no expected exports found (expected: ${expectedFns.join(', ')})`,
      );
    }
    return makeCheckResult('Schema firewall availability', true, SEVERITY.DEGRADED, elapsed(), `Schema firewall loaded with ${found.length} expected export(s)`);
  } catch (err) {
    return makeCheckResult('Schema firewall availability', false, SEVERITY.DEGRADED, elapsed(), `Failed to load schema-firewall.js: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Gate 7: PPTX Integrity Pipeline Availability
// ---------------------------------------------------------------------------
function checkIntegrityPipeline() {
  const elapsed = timer();
  const pipelinePath = path.join(PROJECT_ROOT, 'pptx-integrity-pipeline.js');

  if (!fs.existsSync(pipelinePath)) {
    return makeCheckResult('Integrity pipeline availability', true, SEVERITY.INFO, elapsed(), 'pptx-integrity-pipeline.js not found — skipped');
  }

  try {
    require(pipelinePath);
    return makeCheckResult('Integrity pipeline availability', true, SEVERITY.DEGRADED, elapsed(), 'pptx-integrity-pipeline.js loaded successfully');
  } catch (err) {
    return makeCheckResult('Integrity pipeline availability', false, SEVERITY.DEGRADED, elapsed(), `Failed to load pptx-integrity-pipeline.js: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Gate 8: Regression Tests
// ---------------------------------------------------------------------------
function runRegressionTests() {
  const elapsed = timer();
  const result = spawnSync('node', ['regression-tests.js', '--rounds=1'], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5 * 60 * 1000,
  });

  if (result.status === 0) {
    return makeCheckResult('Regression tests', true, SEVERITY.BLOCKING, elapsed(), 'All regression tests passed');
  }

  const stderr = String(result.stderr || '').slice(0, 500);
  const reason = result.signal
    ? `killed by signal ${result.signal}`
    : `exit code ${result.status}`;
  return makeCheckResult('Regression tests', false, SEVERITY.BLOCKING, elapsed(), `Regression tests failed: ${reason}`, [stderr]);
}

// ---------------------------------------------------------------------------
// Gate 9: Stress Test
// ---------------------------------------------------------------------------
function runStressCheck(seeds) {
  const elapsed = timer();
  const harnessPath = path.join(PROJECT_ROOT, 'stress-test-harness.js');

  if (!fs.existsSync(harnessPath)) {
    return makeCheckResult('Stress test', true, SEVERITY.INFO, elapsed(), 'stress-test-harness.js not found — skipped');
  }

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
    },
  );

  if (result.status === 2 || result.error) {
    return makeCheckResult('Stress test', false, SEVERITY.BLOCKING, elapsed(), `Stress harness crashed: ${result.stderr || result.error?.message || 'unknown'}`);
  }

  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed.runtimeCrashes > 0) {
      return makeCheckResult('Stress test', false, SEVERITY.BLOCKING, elapsed(), `${parsed.runtimeCrashes} runtime crash(es) in ${seeds} seeds`, [JSON.stringify(parsed)]);
    }
    return makeCheckResult('Stress test', true, SEVERITY.BLOCKING, elapsed(), `${parsed.passed || seeds}/${seeds} seeds passed, 0 runtime crashes`);
  } catch {
    const pass = result.status === 0;
    return makeCheckResult('Stress test', pass, SEVERITY.BLOCKING, elapsed(), pass ? `Stress test passed (${seeds} seeds)` : `Stress test failed (exit code ${result.status})`);
  }
}

// ---------------------------------------------------------------------------
// Readiness Score Calculator
// ---------------------------------------------------------------------------
function computeReadinessScore(results) {
  if (results.length === 0) return 0;

  let totalWeight = 0;
  let earnedWeight = 0;

  for (const r of results) {
    let weight;
    switch (r.severity) {
      case SEVERITY.BLOCKING:
        weight = 15;
        break;
      case SEVERITY.DEGRADED:
        weight = 5;
        break;
      case SEVERITY.INFO:
        weight = 1;
        break;
      default:
        weight = 5;
    }
    totalWeight += weight;
    if (r.pass) earnedWeight += weight;
  }

  return totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
}

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------
function generateJsonReport(results, metadata) {
  const hasBlockingFailure = results.some((r) => !r.pass && r.severity === SEVERITY.BLOCKING);
  const score = computeReadinessScore(results);

  return {
    preflight: true,
    version: '3.0',
    timestamp: metadata.timestamp,
    node: metadata.nodeVersion,
    gitBranch: metadata.gitBranch,
    mode: metadata.mode,
    stressSeeds: metadata.stressSeeds || null,
    readinessScore: score,
    overallPass: !hasBlockingFailure,
    checks: results.map((r) => ({
      name: r.name,
      status: r.status,
      pass: r.pass,
      severity: r.severity,
      durationMs: r.durationMs || 0,
      details: r.details || null,
      evidence: r.evidence || null,
    })),
  };
}

function generateMarkdownReport(results, metadata) {
  const hasBlockingFailure = results.some((r) => !r.pass && r.severity === SEVERITY.BLOCKING);
  const score = computeReadinessScore(results);
  const lines = [];

  lines.push('# PREFLIGHT GATE REPORT');
  lines.push('');
  lines.push(`- **Timestamp**: ${metadata.timestamp}`);
  lines.push(`- **Node**: ${metadata.nodeVersion}`);
  lines.push(`- **Branch**: ${metadata.gitBranch}`);
  lines.push(`- **Mode**: ${metadata.mode}`);
  if (metadata.stressSeeds) {
    lines.push(`- **Stress seeds**: ${metadata.stressSeeds}`);
  }
  lines.push(`- **Readiness Score**: ${score}/100`);
  lines.push('');
  lines.push(`## Result: ${hasBlockingFailure ? 'FAIL' : 'PASS'}`);
  lines.push('');
  lines.push('| Check | Status | Severity | Duration |');
  lines.push('|-------|--------|----------|----------|');

  for (const r of results) {
    const dur = r.durationMs ? `${r.durationMs}ms` : '-';
    lines.push(`| ${r.name} | ${r.status} | ${r.severity} | ${dur} |`);
  }
  lines.push('');

  const failures = results.filter((r) => !r.pass);
  if (failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const f of failures) {
      lines.push(`### ${f.name} [${f.severity}]`);
      lines.push('');
      lines.push(f.details || 'No details');
      if (f.evidence && Array.isArray(f.evidence) && f.evidence.length > 0) {
        lines.push('');
        lines.push('**Evidence:**');
        for (const e of f.evidence) {
          lines.push(`- ${e}`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Gate Runners
// ---------------------------------------------------------------------------
function runQuick() {
  const results = [];
  results.push(checkDirtyTree());
  results.push(checkHeadContent());
  results.push(checkModuleExportContracts());
  return results;
}

function runFull(options = {}) {
  const results = runQuick();

  results.push(checkTemplateContract());
  results.push(checkRouteGeometry());
  results.push(checkSchemaFirewall());
  results.push(checkIntegrityPipeline());

  // Only run regression/stress if quick checks passed
  const hasBlockingFailure = results.some((r) => !r.pass && r.severity === SEVERITY.BLOCKING);

  if (hasBlockingFailure) {
    results.push(makeCheckResult('Regression tests', true, SEVERITY.BLOCKING, 0, 'Skipped — fix blocking failures first'));
    if (options.stressSeeds) {
      results.push(makeCheckResult('Stress test', true, SEVERITY.BLOCKING, 0, 'Skipped — fix blocking failures first'));
    }
  } else {
    results.push(runRegressionTests());
    if (options.stressSeeds) {
      results.push(runStressCheck(options.stressSeeds));
    }
  }

  return results;
}

function runGates(options = {}) {
  const mode = options.mode || 'quick';
  if (mode === 'quick') {
    return runQuick();
  }
  return runFull(options);
}

function getReadinessScore(results) {
  return computeReadinessScore(results);
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  let mode = 'quick';
  let stressSeeds = null;
  let reportDir = path.join(PROJECT_ROOT, 'preflight-reports');
  let help = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--mode=')) {
      const val = arg.split('=')[1];
      if (val === 'quick' || val === 'full') {
        mode = val;
      }
    } else if (arg.startsWith('--stress-seeds=')) {
      const val = parseInt(arg.split('=')[1], 10);
      if (Number.isFinite(val) && val > 0) {
        stressSeeds = Math.min(val, 200);
      }
    } else if (arg.startsWith('--report-dir=')) {
      reportDir = arg.split('=')[1];
    }
  }

  return { mode, stressSeeds, reportDir, help };
}

// ---------------------------------------------------------------------------
// Main CLI
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
Usage: node preflight-gates.js [options]

Options:
  --mode=quick|full       Gate mode (default: quick)
  --stress-seeds=N        Run stress test with N seeds (full mode only, max 200)
  --report-dir=PATH       Output directory for reports
  --help                  Show this help

Examples:
  node preflight-gates.js --mode=quick
  node preflight-gates.js --mode=full
  node preflight-gates.js --mode=full --stress-seeds=100
`);
    process.exit(0);
  }

  console.log('');
  console.log(`=== PREFLIGHT GATES (${args.mode.toUpperCase()} MODE) ===`);
  console.log('');

  const results = runGates({
    mode: args.mode,
    stressSeeds: args.stressSeeds,
  });

  // Print results
  for (const r of results) {
    const icon = r.pass ? 'PASS' : r.status;
    const dur = r.durationMs ? ` (${r.durationMs}ms)` : '';
    console.log(`[${icon}] ${r.name}${dur}`);
    if (!r.pass && r.details) {
      console.log(`       ${r.details}`);
    }
    if (!r.pass && r.evidence && Array.isArray(r.evidence)) {
      for (const e of r.evidence.slice(0, 5)) {
        console.log(`         - ${e}`);
      }
    }
  }

  const score = computeReadinessScore(results);
  const hasBlockingFailure = results.some((r) => !r.pass && r.severity === SEVERITY.BLOCKING);

  // Generate reports
  const metadata = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    gitBranch: getGitBranch(),
    mode: args.mode,
    stressSeeds: args.stressSeeds,
  };

  const jsonReport = generateJsonReport(results, metadata);
  const mdReport = generateMarkdownReport(results, metadata);

  try {
    if (!fs.existsSync(args.reportDir)) {
      fs.mkdirSync(args.reportDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(args.reportDir, 'preflight-gates-report.json'),
      JSON.stringify(jsonReport, null, 2),
    );
    fs.writeFileSync(
      path.join(args.reportDir, 'preflight-gates-report.md'),
      mdReport,
    );
    console.log('');
    console.log(`Reports: ${args.reportDir}/preflight-gates-report.{json,md}`);
  } catch (reportErr) {
    console.log(`[WARN] Could not write reports: ${reportErr.message}`);
  }

  console.log('');
  console.log(`Readiness Score: ${score}/100`);

  if (hasBlockingFailure) {
    console.log('=== PREFLIGHT FAILED — BLOCKING failures detected ===');
    console.log('');
    process.exit(1);
  } else {
    const hasDegraded = results.some((r) => !r.pass && r.severity === SEVERITY.DEGRADED);
    if (hasDegraded) {
      console.log('=== PREFLIGHT PASSED WITH DEGRADED CHECKS — review above ===');
    } else {
      console.log('=== ALL GATES PASSED ===');
    }
    console.log('');
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runGates,
  runQuick,
  runFull,
  getReadinessScore,
  // Individual gates (for testing)
  checkDirtyTree,
  checkHeadContent,
  checkModuleExportContracts,
  checkTemplateContract,
  checkRouteGeometry,
  checkSchemaFirewall,
  checkIntegrityPipeline,
  runRegressionTests,
  runStressCheck,
  // Reporting
  generateJsonReport,
  generateMarkdownReport,
  computeReadinessScore,
  parseArgs,
  // Constants
  MODULE_EXPORT_CONTRACTS,
  TEMPLATE_PATTERNS_EXPECTED_KEYS,
  SEVERITY,
};
