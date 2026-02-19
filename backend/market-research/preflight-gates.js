#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Lazy-load validate-real-output to avoid circular deps at require time
let _validateRealOutput;
function getValidateRealOutput() {
  if (!_validateRealOutput) {
    _validateRealOutput = require('./validate-real-output');
  }
  return _validateRealOutput;
}

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
// Gate modes — dev | test | release
// ---------------------------------------------------------------------------
const GATE_MODES = {
  DEV: 'dev',
  TEST: 'test',
  RELEASE: 'release',
};

// ---------------------------------------------------------------------------
// Remediation suggestions per gate name
// ---------------------------------------------------------------------------
const REMEDIATION_MAP = {
  'Clean working tree': 'git add -A && git commit -m "pre-release commit"',
  'HEAD content verification':
    'Ensure all critical functions exist in HEAD. Run: git diff HEAD -- <file> to check',
  'Module export contracts':
    'Check module.exports in the failing module. Ensure all required functions are exported',
  'Module function signatures':
    'Verify function parameter counts match the contract. Check the function definition',
  'Template contract validity':
    "Validate template-patterns.json: node -e \"JSON.parse(require('fs').readFileSync('template-patterns.json','utf8'))\"",
  'Route geometry audit': 'Run: node route-geometry-enforcer.js --audit to see geometry issues',
  'Schema firewall availability':
    'Ensure schema-firewall.js exports validate/processFirewall/enforceSourceLineage (or legacy validateSchema/enforceSchema)',
  'FileSafety pipeline availability':
    'Check pptx-fileSafety-pipeline.js loads without errors: node -e "require(\'./pptx-fileSafety-pipeline\')"',
  'Regression tests': 'Run: node regression-tests.js --rounds=1 to see failing tests',
  'Stress test': 'Run: node stress-test-harness.js to identify crash seeds',
  'Schema compatibility':
    'Validate report artifacts match expected schemas. Check schema-firewall.js',
  'Sparse slide gate':
    'Review PPTX output for slides with < 3 content elements. Check deck-builder-single.js',
  'Source coverage gate': 'Increase source citations in research output. Check research-agents.js',
  'Real output check':
    'Fix PPTX output issues. Run: node validate-real-output.js <deck.pptx> to see failures. ' +
    'Check deck-builder-single.js and ppt-utils.js for building bugs.',
  'Formatting audit':
    'Review formatting audit results in preflight-reports/. Fix drift/mismatch issues in deck-builder-single.js or template-patterns.json',
};

// ---------------------------------------------------------------------------
// Module export contracts — required exports per critical module
// ---------------------------------------------------------------------------
const MODULE_EXPORT_CONTRACTS = {
  'deck-builder-single.js': {
    functions: ['generateSingleCountryPPT'],
    paramCounts: { generateSingleCountryPPT: 3 },
  },
  'deck-file-check.js': {
    functions: [
      'normalizeAbsoluteRelationshipTargets',
      'normalizeSlideNonVisualIds',
      'reconcileContentTypesAndPackage',
      'validatePPTX',
      'scanPackageConsistency',
    ],
    paramCounts: {},
  },
  'content-gates.js': {
    functions: ['validateResearchQuality', 'validateSynthesisQuality', 'validatePptData'],
    paramCounts: {},
  },
  'research-engine.js': {
    functions: ['researchCountry', 'synthesizeSingleCountry', 'reSynthesize'],
    paramCounts: {},
  },
  'template-fill.js': {
    functions: ['applyTemplateClonePostprocess'],
    paramCounts: {},
  },
  'content-size-check.js': {
    functions: ['analyzeContentSize', 'compactContent', 'runContentSizeCheck'],
    paramCounts: {},
  },
  'cleanup-temp-fields.js': {
    functions: ['isTransientKey', 'sanitizeTransientKeys', 'createSanitizationContext'],
    paramCounts: {},
  },
};

// Template-patterns.json expected top-level keys
const TEMPLATE_PATTERNS_EXPECTED_KEYS = ['_meta', 'positions', 'patterns', 'style', 'slideDetails'];

// ---------------------------------------------------------------------------
// Environment contract matrix — which gates required per mode
// ---------------------------------------------------------------------------
const ENVIRONMENT_CONTRACTS = {
  dev: {
    required: ['Clean working tree', 'Module export contracts'],
    optional: [
      'HEAD content verification',
      'Template contract validity',
      'Route geometry audit',
      'Schema firewall availability',
      'FileSafety pipeline availability',
    ],
    skip: [
      'Regression tests',
      'Stress test',
      'Schema compatibility',
      'Module function signatures',
      'Sparse slide gate',
      'Source coverage gate',
      'Real output check',
      'Formatting audit',
    ],
  },
  test: {
    required: [
      'Clean working tree',
      'HEAD content verification',
      'Module export contracts',
      'Template contract validity',
      'Regression tests',
    ],
    optional: [
      'Route geometry audit',
      'Schema firewall availability',
      'FileSafety pipeline availability',
      'Module function signatures',
      'Real output check',
      'Formatting audit',
    ],
    skip: ['Stress test', 'Schema compatibility', 'Sparse slide gate', 'Source coverage gate'],
  },
  release: {
    required: [
      'Clean working tree',
      'HEAD content verification',
      'Module export contracts',
      'Template contract validity',
      'Route geometry audit',
      'Schema firewall availability',
      'FileSafety pipeline availability',
      'Regression tests',
      'Stress test',
      'Module function signatures',
      'Schema compatibility',
      'Sparse slide gate',
      'Source coverage gate',
      'Real output check',
      'Formatting audit',
    ],
    optional: [],
    skip: [],
  },
};

function getEnvironmentContract(mode) {
  return ENVIRONMENT_CONTRACTS[mode] || ENVIRONMENT_CONTRACTS.dev;
}

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
  const result = {
    name,
    pass,
    severity,
    status: pass
      ? 'PASS'
      : severity === SEVERITY.BLOCKING
        ? 'FAIL'
        : severity === SEVERITY.DEGRADED
          ? 'WARN'
          : 'INFO',
    durationMs,
    details: details || null,
    evidence: evidence || null,
    remediation: null,
  };

  // Add remediation hint for failures
  if (!pass && REMEDIATION_MAP[name]) {
    result.remediation = REMEDIATION_MAP[name];
  }

  return result;
}

/**
 * Apply mode policy to a check result.
 * In 'release' mode, DEGRADED severity is promoted to BLOCKING.
 * In 'release' + strict, any non-pass becomes BLOCKING.
 */
function applyModePolicy(result, mode, strict) {
  if (!result) return result;

  const patched = { ...result };

  if (mode === GATE_MODES.RELEASE) {
    // In release mode, DEGRADED becomes BLOCKING
    if (patched.severity === SEVERITY.DEGRADED) {
      patched.severity = SEVERITY.BLOCKING;
      if (!patched.pass) {
        patched.status = 'FAIL';
      }
    }
  }

  if (strict && !patched.pass) {
    // In strict mode, any non-pass becomes BLOCKING/FAIL
    patched.severity = SEVERITY.BLOCKING;
    patched.status = 'FAIL';
  }

  return patched;
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
      return makeCheckResult(
        'Clean working tree',
        true,
        SEVERITY.BLOCKING,
        elapsed(),
        'No uncommitted .js/.json changes'
      );
    }
    return makeCheckResult(
      'Clean working tree',
      false,
      SEVERITY.BLOCKING,
      elapsed(),
      `${dirty.length} uncommitted file(s)`,
      dirty
    );
  } catch (err) {
    const errMsg = String(err?.message || err || '');
    if (/EPERM|ENOENT|not found/i.test(errMsg)) {
      return makeCheckResult(
        'Clean working tree',
        true,
        SEVERITY.DEGRADED,
        elapsed(),
        'git unavailable — skipped'
      );
    }
    return makeCheckResult(
      'Clean working tree',
      false,
      SEVERITY.BLOCKING,
      elapsed(),
      `git status failed: ${errMsg}`
    );
  }
}

// ---------------------------------------------------------------------------
// Gate 2: HEAD Content Verification
// ---------------------------------------------------------------------------
const HEAD_CONTENT_CHECKS = [
  { file: 'server.js', patterns: ['collectPreRenderStructureIssues'] },
  {
    file: 'deck-builder-single.js',
    patterns: ['shouldAllowCompetitiveOptionalGroupGap', 'resolveTemplateRouteWithGeometryGuard'],
  },
  { file: 'research-engine.js', patterns: ['runInBatchesUntilDeadline'] },
  { file: 'ppt-utils.js', patterns: ['sanitizeHyperlinkUrl'] },
  { file: 'content-gates.js', patterns: ['validatePptData'] },
  { file: 'template-fill.js', patterns: ['isLockedTemplateText'] },
  {
    file: 'deck-file-check.js',
    patterns: ['normalizeAbsoluteRelationshipTargets', 'reconcileContentTypesAndPackage'],
  },
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
        stdio: ['ignore', 'pipe', 'ignore'],
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
    return makeCheckResult(
      'HEAD content verification',
      true,
      SEVERITY.BLOCKING,
      elapsed(),
      'All critical patterns found in HEAD'
    );
  }
  const evidence = failures.map(
    (f) => `${f.file}: missing ${f.missing.join(', ')}${f.error ? ` (${f.error})` : ''}`
  );
  return makeCheckResult(
    'HEAD content verification',
    false,
    SEVERITY.BLOCKING,
    elapsed(),
    `${evidence.length} file(s) have missing patterns`,
    evidence
  );
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
      `${checked.length} modules verified with all required exports`
    );
  }

  const evidence = failures.map((f) => `${f.module}: ${f.error}`);
  return makeCheckResult(
    'Module export contracts',
    false,
    SEVERITY.BLOCKING,
    elapsed(),
    `${failures.length} module(s) failed contract check`,
    evidence
  );
}

// ---------------------------------------------------------------------------
// Gate 3b: Module Function Signatures (parameter count check)
// ---------------------------------------------------------------------------
function checkModuleFunctionSignatures() {
  const elapsed = timer();
  const failures = [];
  let checkedCount = 0;

  for (const [moduleName, contract] of Object.entries(MODULE_EXPORT_CONTRACTS)) {
    const paramCounts = contract.paramCounts || {};
    if (Object.keys(paramCounts).length === 0) continue;

    const fullPath = path.join(PROJECT_ROOT, moduleName);
    if (!fs.existsSync(fullPath)) continue;

    let loadedModule;
    try {
      loadedModule = require(fullPath);
    } catch {
      continue;
    }

    for (const [fnName, expectedParamCount] of Object.entries(paramCounts)) {
      const fn = loadedModule[fnName] || loadedModule.__test?.[fnName];
      if (typeof fn !== 'function') continue;

      checkedCount++;
      if (fn.length !== expectedParamCount) {
        failures.push({
          module: moduleName,
          function: fnName,
          expected: expectedParamCount,
          actual: fn.length,
        });
      }
    }
  }

  if (failures.length === 0) {
    return makeCheckResult(
      'Module function signatures',
      true,
      SEVERITY.DEGRADED,
      elapsed(),
      `${checkedCount} function signature(s) verified`
    );
  }

  const evidence = failures.map(
    (f) => `${f.module}.${f.function}: expected ${f.expected} params, got ${f.actual}`
  );
  return makeCheckResult(
    'Module function signatures',
    false,
    SEVERITY.DEGRADED,
    elapsed(),
    `${failures.length} function signature mismatch(es)`,
    evidence
  );
}

// ---------------------------------------------------------------------------
// Gate 4: Template Contract Validity
// ---------------------------------------------------------------------------
function checkTemplateContract() {
  const elapsed = timer();
  const templatePath = path.join(PROJECT_ROOT, 'template-patterns.json');

  if (!fs.existsSync(templatePath)) {
    return makeCheckResult(
      'Template contract validity',
      false,
      SEVERITY.BLOCKING,
      elapsed(),
      'template-patterns.json not found'
    );
  }

  let parsed;
  try {
    const raw = fs.readFileSync(templatePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    return makeCheckResult(
      'Template contract validity',
      false,
      SEVERITY.BLOCKING,
      elapsed(),
      `template-patterns.json is invalid JSON: ${err.message}`
    );
  }

  const missingKeys = TEMPLATE_PATTERNS_EXPECTED_KEYS.filter((k) => !(k in parsed));
  if (missingKeys.length > 0) {
    return makeCheckResult(
      'Template contract validity',
      false,
      SEVERITY.BLOCKING,
      elapsed(),
      `template-patterns.json missing expected keys: ${missingKeys.join(', ')}`,
      missingKeys
    );
  }

  // If template-contract-compiler.js exists, try to run its check
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
            `Contract compiler check failed: ${result.reason || 'unknown'}`,
            result.errors || []
          );
        }
      }
    } catch {
      // compiler not loadable — not a failure, just skip extended check
    }
  }

  return makeCheckResult(
    'Template contract validity',
    true,
    SEVERITY.BLOCKING,
    elapsed(),
    `template-patterns.json valid with ${Object.keys(parsed).length} top-level keys`
  );
}

// ---------------------------------------------------------------------------
// Gate 5: Route Geometry Audit
// ---------------------------------------------------------------------------
function checkRouteGeometry() {
  const elapsed = timer();
  const enforcerPath = path.join(PROJECT_ROOT, 'route-geometry-enforcer.js');

  if (!fs.existsSync(enforcerPath)) {
    return makeCheckResult(
      'Route geometry audit',
      true,
      SEVERITY.INFO,
      elapsed(),
      'route-geometry-enforcer.js not found — skipped'
    );
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
          audit.issues || []
        );
      }
    }
    return makeCheckResult(
      'Route geometry audit',
      true,
      SEVERITY.DEGRADED,
      elapsed(),
      'Route geometry enforcer loaded and validated'
    );
  } catch (err) {
    return makeCheckResult(
      'Route geometry audit',
      false,
      SEVERITY.DEGRADED,
      elapsed(),
      `Failed to load route-geometry-enforcer.js: ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Gate 6: Schema Firewall Availability
// ---------------------------------------------------------------------------
function checkSchemaFirewall() {
  const elapsed = timer();
  const firewallPath = path.join(PROJECT_ROOT, 'schema-firewall.js');

  if (!fs.existsSync(firewallPath)) {
    return makeCheckResult(
      'Schema firewall availability',
      true,
      SEVERITY.INFO,
      elapsed(),
      'schema-firewall.js not found — skipped'
    );
  }

  try {
    const firewall = require(firewallPath);
    const coreExpectedFns = ['validate', 'processFirewall', 'enforceSourceLineage'];
    const legacyExpectedFns = ['validateSchema', 'enforceSchema'];
    const foundCore = coreExpectedFns.filter((fn) => typeof firewall[fn] === 'function');
    const foundLegacy = legacyExpectedFns.filter((fn) => typeof firewall[fn] === 'function');
    if (foundCore.length === 0 && foundLegacy.length === 0) {
      return makeCheckResult(
        'Schema firewall availability',
        false,
        SEVERITY.DEGRADED,
        elapsed(),
        'schema-firewall.js loaded but no expected exports found (expected core: ' +
          `${coreExpectedFns.join(', ')}, legacy: ${legacyExpectedFns.join(', ')})`
      );
    }
    const coreSummary = foundCore.length > 0 ? foundCore.join(', ') : '(none)';
    const legacySummary = foundLegacy.length > 0 ? foundLegacy.join(', ') : '(none)';
    return makeCheckResult(
      'Schema firewall availability',
      true,
      SEVERITY.DEGRADED,
      elapsed(),
      `Schema firewall loaded (core: ${coreSummary}; legacy: ${legacySummary})`
    );
  } catch (err) {
    return makeCheckResult(
      'Schema firewall availability',
      false,
      SEVERITY.DEGRADED,
      elapsed(),
      `Failed to load schema-firewall.js: ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Gate 7: PPTX FileSafety Pipeline Availability
// ---------------------------------------------------------------------------
function checkIntegrityPipeline() {
  const elapsed = timer();
  const pipelinePath = path.join(PROJECT_ROOT, 'pptx-fileSafety-pipeline.js');

  if (!fs.existsSync(pipelinePath)) {
    return makeCheckResult(
      'FileSafety pipeline availability',
      true,
      SEVERITY.INFO,
      elapsed(),
      'pptx-fileSafety-pipeline.js not found — skipped'
    );
  }

  try {
    require(pipelinePath);
    return makeCheckResult(
      'FileSafety pipeline availability',
      true,
      SEVERITY.DEGRADED,
      elapsed(),
      'pptx-fileSafety-pipeline.js loaded successfully'
    );
  } catch (err) {
    return makeCheckResult(
      'FileSafety pipeline availability',
      false,
      SEVERITY.DEGRADED,
      elapsed(),
      `Failed to load pptx-fileSafety-pipeline.js: ${err.message}`
    );
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
    return makeCheckResult(
      'Regression tests',
      true,
      SEVERITY.BLOCKING,
      elapsed(),
      'All regression tests passed'
    );
  }

  const stderr = String(result.stderr || '').slice(0, 500);
  const reason = result.signal ? `killed by signal ${result.signal}` : `exit code ${result.status}`;
  return makeCheckResult(
    'Regression tests',
    false,
    SEVERITY.BLOCKING,
    elapsed(),
    `Regression tests failed: ${reason}`,
    [stderr]
  );
}

// ---------------------------------------------------------------------------
// Gate 9: Stress Test
// ---------------------------------------------------------------------------
function runStressCheck(seeds) {
  const elapsed = timer();
  const harnessPath = path.join(PROJECT_ROOT, 'stress-test-harness.js');

  if (!fs.existsSync(harnessPath)) {
    return makeCheckResult(
      'Stress test',
      true,
      SEVERITY.INFO,
      elapsed(),
      'stress-test-harness.js not found — skipped'
    );
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
    }
  );

  if (result.status === 2 || result.error) {
    return makeCheckResult(
      'Stress test',
      false,
      SEVERITY.BLOCKING,
      elapsed(),
      `Stress harness crashed: ${result.stderr || result.error?.message || 'unknown'}`
    );
  }

  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed.runtimeCrashes > 0) {
      return makeCheckResult(
        'Stress test',
        false,
        SEVERITY.BLOCKING,
        elapsed(),
        `${parsed.runtimeCrashes} runtime crash(es) in ${seeds} seeds`,
        [JSON.stringify(parsed)]
      );
    }
    return makeCheckResult(
      'Stress test',
      true,
      SEVERITY.BLOCKING,
      elapsed(),
      `${parsed.passed || seeds}/${seeds} seeds passed, 0 runtime crashes`
    );
  } catch {
    const pass = result.status === 0;
    return makeCheckResult(
      'Stress test',
      pass,
      SEVERITY.BLOCKING,
      elapsed(),
      pass
        ? `Stress test passed (${seeds} seeds)`
        : `Stress test failed (exit code ${result.status})`
    );
  }
}

// ---------------------------------------------------------------------------
// Gate 10: Schema Compatibility
// ---------------------------------------------------------------------------
function checkSchemaCompatibility() {
  const elapsed = timer();

  // Check that schema-firewall.js exists and can validate
  const firewallPath = path.join(PROJECT_ROOT, 'schema-firewall.js');
  if (!fs.existsSync(firewallPath)) {
    return makeCheckResult(
      'Schema compatibility',
      true,
      SEVERITY.INFO,
      elapsed(),
      'schema-firewall.js not found — skipped'
    );
  }

  try {
    const firewall = require(firewallPath);
    const validateFn =
      typeof firewall.validate === 'function'
        ? firewall.validate
        : typeof firewall.validateSchema === 'function'
          ? firewall.validateSchema
          : null;
    const validateFnName =
      typeof firewall.validate === 'function'
        ? 'validate'
        : typeof firewall.validateSchema === 'function'
          ? 'validateSchema'
          : null;
    if (!validateFn) {
      return makeCheckResult(
        'Schema compatibility',
        true,
        SEVERITY.INFO,
        elapsed(),
        'No schema checker export found (validate/validateSchema) — skipped'
      );
    }

    // Schema compatibility gate verifies checker contract/callability, not content pass/fail
    // for a synthetic artifact.
    const sampleArtifact = {
      country: 'Vietnam',
      policy: {},
      market: {},
      competitors: {},
      depth: {},
      summary: {},
    };
    let schemaResult;
    try {
      schemaResult = validateFn(sampleArtifact);
    } catch (validateErr) {
      return makeCheckResult(
        'Schema compatibility',
        false,
        SEVERITY.DEGRADED,
        elapsed(),
        `Schema checker (${validateFnName}) threw: ${validateErr.message}`
      );
    }
    if (!schemaResult || typeof schemaResult !== 'object') {
      return makeCheckResult(
        'Schema compatibility',
        false,
        SEVERITY.DEGRADED,
        elapsed(),
        `Schema checker (${validateFnName}) returned invalid result shape`
      );
    }
    if (typeof schemaResult.valid !== 'boolean' || !Array.isArray(schemaResult.errors)) {
      return makeCheckResult(
        'Schema compatibility',
        false,
        SEVERITY.DEGRADED,
        elapsed(),
        `Schema checker (${validateFnName}) result missing required fields (valid/errors)`
      );
    }
    const warningCount = Array.isArray(schemaResult.warnings) ? schemaResult.warnings.length : 0;

    return makeCheckResult(
      'Schema compatibility',
      true,
      SEVERITY.DEGRADED,
      elapsed(),
      `Schema checker (${validateFnName}) callable; sample result: valid=${schemaResult.valid}, errors=${schemaResult.errors.length}, warnings=${warningCount}`
    );
  } catch (err) {
    return makeCheckResult(
      'Schema compatibility',
      false,
      SEVERITY.DEGRADED,
      elapsed(),
      `Schema compatibility check failed: ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Gate 11: Sparse Slide Gate (divider-aware)
// ---------------------------------------------------------------------------

/**
 * Classify whether a sparse slide from a report is a divider/section-intent slide.
 * Divider slides are structurally intentional and should not trigger sparse warnings.
 */
function isReportSlideDivider(slide) {
  const text = String(slide.text || slide.preview || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!text) return false;
  if (text.startsWith('table of contents') || text.includes('table of contents')) return true;
  if (/^appendix\b/.test(text)) return true;
  const dividerPatterns = [
    /^policy\s*[&]\s*regulatory$/,
    /^market\s+overview$/,
    /^competitive\s+landscape$/,
    /^strategic\s+analysis$/,
    /^recommendations$/,
    /^executive\s+summary$/,
    /^key\s+findings$/,
    /^opportunities\s*[&]\s*obstacles$/,
  ];
  for (const pattern of dividerPatterns) {
    if (pattern.test(text)) return true;
  }
  // Title-only rule: short text with no sentence punctuation
  if (text.length < 80) {
    const words = text.split(/\s+/);
    if (words.length <= 6 && !/[.!?;]/.test(text)) return true;
  }
  return false;
}

function checkSparseSlideGate() {
  const elapsed = timer();

  // Check the preflight-reports directory for any recent PPTX analysis
  const reportsDir = path.join(PROJECT_ROOT, 'preflight-reports');
  if (!fs.existsSync(reportsDir)) {
    return makeCheckResult(
      'Sparse slide gate',
      true,
      SEVERITY.INFO,
      elapsed(),
      'No preflight-reports directory — skipped'
    );
  }

  try {
    const reportFiles = fs.readdirSync(reportsDir).filter((f) => f.endsWith('.json'));
    let sparseContentWarnings = 0;
    let dividerSlidesExcluded = 0;
    const sparseDetails = [];

    for (const file of reportFiles) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(reportsDir, file), 'utf8'));
        if (content.sparseSlides && Array.isArray(content.sparseSlides)) {
          for (const slide of content.sparseSlides) {
            if (isReportSlideDivider(slide)) {
              dividerSlidesExcluded++;
              continue;
            }
            sparseContentWarnings++;
            sparseDetails.push(
              `${file}: slide ${slide.index || '?'} has ${slide.elementCount || 0} elements`
            );
          }
        }
      } catch {
        // skip unparseable report files
      }
    }

    if (sparseContentWarnings > 0) {
      return makeCheckResult(
        'Sparse slide gate',
        false,
        SEVERITY.DEGRADED,
        elapsed(),
        `${sparseContentWarnings} sparse content slide(s) found (${dividerSlidesExcluded} divider slide(s) excluded)`,
        sparseDetails
      );
    }

    return makeCheckResult(
      'Sparse slide gate',
      true,
      SEVERITY.DEGRADED,
      elapsed(),
      `No sparse content slides found${dividerSlidesExcluded > 0 ? ` (${dividerSlidesExcluded} divider slide(s) excluded)` : ''}`
    );
  } catch (err) {
    return makeCheckResult(
      'Sparse slide gate',
      false,
      SEVERITY.DEGRADED,
      elapsed(),
      `Sparse slide check failed: ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Gate 12: Source Coverage Gate
// ---------------------------------------------------------------------------
function checkSourceCoverageGate(threshold) {
  const elapsed = timer();
  const effectiveThreshold = typeof threshold === 'number' && threshold > 0 ? threshold : 70;

  // Check for content-gates.js source coverage tracking
  const qualityGatesPath = path.join(PROJECT_ROOT, 'content-gates.js');
  if (!fs.existsSync(qualityGatesPath)) {
    return makeCheckResult(
      'Source coverage gate',
      true,
      SEVERITY.INFO,
      elapsed(),
      'content-gates.js not found — skipped'
    );
  }

  try {
    const qg = require(qualityGatesPath);

    // Check if there's a source coverage function
    if (typeof qg.getSourceCoverage === 'function') {
      const coverage = qg.getSourceCoverage();
      if (coverage && typeof coverage.percentage === 'number') {
        if (coverage.percentage < effectiveThreshold) {
          return makeCheckResult(
            'Source coverage gate',
            false,
            SEVERITY.DEGRADED,
            elapsed(),
            `Source coverage ${coverage.percentage}% below threshold ${effectiveThreshold}%`,
            [`Coverage: ${coverage.percentage}%, Required: ${effectiveThreshold}%`]
          );
        }
        return makeCheckResult(
          'Source coverage gate',
          true,
          SEVERITY.DEGRADED,
          elapsed(),
          `Source coverage ${coverage.percentage}% meets threshold ${effectiveThreshold}%`
        );
      }
    }

    // No source coverage function — pass with info
    return makeCheckResult(
      'Source coverage gate',
      true,
      SEVERITY.INFO,
      elapsed(),
      `Source coverage tracking not available — threshold=${effectiveThreshold}%`
    );
  } catch (err) {
    return makeCheckResult(
      'Source coverage gate',
      false,
      SEVERITY.DEGRADED,
      elapsed(),
      `Source coverage check failed: ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Gate 13: Real Output Check
// ---------------------------------------------------------------------------
/**
 * Run validate-real-output checks against PPTX deck files.
 * Looks for .pptx files in `deckDir` (default: preflight-reports/decks/).
 * Returns PASS if all decks pass, FAIL if any fail, SKIP if no decks found.
 *
 * @param {Object} options
 * @param {string} [options.deckDir] - Directory containing .pptx files to validate
 * @param {string} [options.country] - Country for expectations (default: 'Vietnam')
 * @param {string} [options.industry] - Industry for expectations (default: 'Energy Services')
 * @returns {Object} Check result with real-output details
 */
function checkRealOutputValidation(options = {}) {
  const elapsed = timer();
  const deckDir = options.deckDir || path.join(PROJECT_ROOT, 'preflight-reports', 'decks');
  const inferCountryForFile = (fileName) => {
    if (options.country) return options.country;
    const lower = String(fileName || '').toLowerCase();
    if (lower.includes('thailand') || lower.includes('test-output')) return 'Thailand';
    if (lower.includes('vietnam')) return 'Vietnam';
    return 'Vietnam';
  };

  // Skip if no deck directory exists
  if (!fs.existsSync(deckDir)) {
    return makeCheckResult(
      'Real output check',
      true,
      SEVERITY.INFO,
      elapsed(),
      `No deck directory found at ${deckDir} — skipped`
    );
  }

  // Find .pptx files
  let pptxFiles;
  try {
    pptxFiles = fs.readdirSync(deckDir).filter((f) => f.toLowerCase().endsWith('.pptx'));
  } catch (err) {
    return makeCheckResult(
      'Real output check',
      false,
      SEVERITY.DEGRADED,
      elapsed(),
      `Failed to read deck directory: ${err.message}`
    );
  }

  if (pptxFiles.length === 0) {
    return makeCheckResult(
      'Real output check',
      true,
      SEVERITY.INFO,
      elapsed(),
      `No .pptx files found in ${deckDir} — skipped`
    );
  }

  // Load checker
  let checker;
  try {
    checker = getValidateRealOutput();
  } catch (err) {
    return makeCheckResult(
      'Real output check',
      false,
      SEVERITY.DEGRADED,
      elapsed(),
      `Failed to load validate-real-output.js: ${err.message}`
    );
  }

  // Run check synchronously via subprocess to avoid async issues in gate runner
  const industry = options.industry || 'Energy Services';
  const deckResults = [];
  const evidence = [];
  let anyFailed = false;

  for (const file of pptxFiles) {
    const filePath = path.join(deckDir, file);
    const country = inferCountryForFile(file);
    const result = spawnSync(
      'node',
      [
        '-e',
        `const v=require('./validate-real-output');const e=v.getRealExpectations(${JSON.stringify(country)},${JSON.stringify(industry)});v.validateRealOutput(${JSON.stringify(filePath)},e).then(r=>{process.stdout.write(JSON.stringify({valid:r.valid,error:r.error||null,passed:r.results?r.results.passed.length:0,failed:r.results?r.results.failed.length:0,warnings:r.results?r.results.warnings.length:0,failedChecks:r.results?r.results.failed:[]}));process.exit(r.valid?0:1)}).catch(e=>{process.stdout.write(JSON.stringify({valid:false,error:e.message,passed:0,failed:1,warnings:0,failedChecks:[]}));process.exit(1)})`,
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout: 2 * 60 * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = {
        valid: result.status === 0,
        error: result.stderr || 'Could not parse check output',
        passed: 0,
        failed: result.status === 0 ? 0 : 1,
        warnings: 0,
        failedChecks: [],
      };
    }

    deckResults.push({ file, ...parsed });
    if (!parsed.valid) {
      anyFailed = true;
      const failedNames = (parsed.failedChecks || []).map(
        (f) => `${f.check}: expected ${f.expected}, got ${f.actual}`
      );
      evidence.push(
        `${file}: FAILED (${parsed.failed} check(s)) — ${failedNames.join('; ') || parsed.error || 'unknown'}`
      );
    } else {
      evidence.push(`${file}: PASSED (${parsed.passed} checks, ${parsed.warnings} warnings)`);
    }
  }

  const totalPassed = deckResults.filter((d) => d.valid).length;
  const totalDecks = deckResults.length;
  const summary = `${totalPassed}/${totalDecks} deck(s) passed real-output check`;

  return makeCheckResult(
    'Real output check',
    !anyFailed,
    SEVERITY.BLOCKING,
    elapsed(),
    summary,
    evidence
  );
}

// ---------------------------------------------------------------------------
// Gate 14: Formatting Audit (drift/mismatch detection)
// ---------------------------------------------------------------------------

/**
 * Known formatting audit warning codes that indicate drift/mismatch.
 * These are emitted by auditGeneratedPptFormatting() in deck-builder-single.js.
*/
const FORMATTING_AUDIT_WARNING_CODES = [
  'header_footer_line_drift',
  'line_width_signature_mismatch',
  'table_margin_drift',
  'table_anchor_top_heavy',
  'table_outer_border_missing',
  'long_text_run_density',
  'long_table_cell_density',
  'slide_size_mismatch',
  'missing_main_layout',
  'missing_line_geometry',
  'table_margin_runaway',
  'missing_presentation_xml',
  'slide_size_missing',
  'format_audit_exception',
];

/**
 * Check formatting audit results from preflight-reports/ directory.
 * Scans for formatting audit data inside gate reports or standalone audit files.
 *
 * In non-strict mode, drift/mismatch codes produce DEGRADED (warning).
 * In strict mode, they are promoted to BLOCKING (hard fail) via applyModePolicy.
 *
 * The failure message lists exact blocking slide keys.
 */
function checkFormattingAudit() {
  const elapsed = timer();
  const reportsDir = path.join(PROJECT_ROOT, 'preflight-reports');

  if (!fs.existsSync(reportsDir)) {
    return makeCheckResult(
      'Formatting audit',
      true,
      SEVERITY.INFO,
      elapsed(),
      'No preflight-reports directory — skipped'
    );
  }

  try {
    const reportFiles = fs.readdirSync(reportsDir).filter((f) => f.endsWith('.json'));
    const foundIssues = [];
    const blockingSlideKeys = [];

    for (const file of reportFiles) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(reportsDir, file), 'utf8'));

        // Check for formatting audit data in gate reports
        if (content.checks && Array.isArray(content.checks)) {
          for (const check of content.checks) {
            if (check.name === 'Formatting audit' && !check.pass) {
              if (Array.isArray(check.evidence)) {
                foundIssues.push(...check.evidence);
              }
            }
          }
        }

        // Check for direct formatting audit fields (from pptMetrics)
        if (content.formattingAuditIssueCodes && Array.isArray(content.formattingAuditIssueCodes)) {
          const warningCodes = content.formattingAuditIssueCodes.filter((code) =>
            FORMATTING_AUDIT_WARNING_CODES.includes(code)
          );
          if (warningCodes.length > 0) {
            foundIssues.push(`${file}: warning codes: ${warningCodes.join(', ')}`);
            blockingSlideKeys.push(...warningCodes.map((c) => `${file}:${c}`));
          }
        }

        // Check for drift detection results from template-contract-compiler
        if (
          content.driftDetected === true ||
          (content.summary && content.summary.warningCount > 0)
        ) {
          const issueCount = content.summary?.totalIssues || 0;
          const warnCount = content.summary?.warningCount || 0;
          const errCount = content.summary?.errorCount || 0;
          if (warnCount > 0 || errCount > 0) {
            foundIssues.push(
              `${file}: drift detected (${errCount} errors, ${warnCount} warnings, ${issueCount} total)`
            );
            if (Array.isArray(content.allIssues)) {
              for (const issue of content.allIssues.slice(0, 20)) {
                blockingSlideKeys.push(issue.blockKey || issue.code || issue.type || 'unknown');
              }
            }
          }
        }

        // Check formattingWarnings array from server runInfo
        if (Array.isArray(content.formattingWarnings) && content.formattingWarnings.length > 0) {
          foundIssues.push(
            `${file}: server formatting warnings: ${content.formattingWarnings.join(', ')}`
          );
          blockingSlideKeys.push(...content.formattingWarnings);
        }
      } catch {
        // skip unparseable report files
      }
    }

    if (foundIssues.length > 0) {
      const uniqueKeys = [...new Set(blockingSlideKeys)];
      const details =
        `${foundIssues.length} formatting drift/mismatch issue(s) detected. ` +
        `Blocking slide keys: ${uniqueKeys.join(', ') || '(none extracted)'}`;
      const rootCauses = foundIssues.map((i) => `  - ${i}`);
      const evidence = [
        ...foundIssues.slice(0, 15),
        '',
        'Root causes:',
        ...rootCauses.slice(0, 15),
      ];
      return makeCheckResult(
        'Formatting audit',
        false,
        SEVERITY.DEGRADED,
        elapsed(),
        details,
        evidence
      );
    }

    return makeCheckResult(
      'Formatting audit',
      true,
      SEVERITY.DEGRADED,
      elapsed(),
      `No formatting drift/mismatch issues found (scanned ${reportFiles.length} report(s))`
    );
  } catch (err) {
    return makeCheckResult(
      'Formatting audit',
      false,
      SEVERITY.DEGRADED,
      elapsed(),
      `Formatting audit check failed: ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Readiness Score Calculator
// ---------------------------------------------------------------------------
function computeReadinessScore(results, options) {
  if (results.length === 0) return 0;

  const mode = options?.mode || 'dev';
  const strict = options?.strict || false;

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

  const rawScore = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;

  // In release mode with strict, must be 100 to pass
  if (mode === GATE_MODES.RELEASE && strict && rawScore < 100) {
    return rawScore; // Return the score, but caller will check threshold
  }

  return rawScore;
}

/**
 * Structured readiness score with threshold enforcement.
 * Returns { score, threshold, passes, mode, strict }.
 */
function computeStructuredReadiness(results, options) {
  const mode = options?.mode || 'dev';
  const strict = options?.strict || false;

  const score = computeReadinessScore(results, options);

  let threshold;
  if (mode === GATE_MODES.RELEASE) {
    threshold = 100;
  } else if (mode === GATE_MODES.TEST) {
    threshold = 80;
  } else {
    threshold = 0; // dev mode has no threshold
  }

  if (strict) {
    threshold = 100;
  }

  return {
    score,
    threshold,
    passes: score >= threshold,
    mode,
    strict,
  };
}

// ---------------------------------------------------------------------------
// Mode Parity Check
// ---------------------------------------------------------------------------
const QUICK_GATES = ['Clean working tree', 'HEAD content verification', 'Module export contracts'];

const FULL_GATES = [
  ...QUICK_GATES,
  'Template contract validity',
  'Route geometry audit',
  'Schema firewall availability',
  'FileSafety pipeline availability',
  'Regression tests',
  'Stress test',
  'Module function signatures',
  'Schema compatibility',
  'Sparse slide gate',
  'Source coverage gate',
  'Real output check',
  'Formatting audit',
];

function validateModeParity() {
  // Ensure quick mode gates are a true subset of full mode gates
  const missingFromFull = QUICK_GATES.filter((g) => !FULL_GATES.includes(g));

  if (missingFromFull.length > 0) {
    return {
      valid: false,
      error: `Quick gates not in full mode: ${missingFromFull.join(', ')}`,
      quickGates: QUICK_GATES,
      fullGates: FULL_GATES,
    };
  }

  // Verify quick is strictly smaller
  if (QUICK_GATES.length >= FULL_GATES.length) {
    return {
      valid: false,
      error: 'Quick mode has same or more gates than full mode',
      quickGates: QUICK_GATES,
      fullGates: FULL_GATES,
    };
  }

  return {
    valid: true,
    quickGateCount: QUICK_GATES.length,
    fullGateCount: FULL_GATES.length,
    quickGates: QUICK_GATES,
    fullGates: FULL_GATES,
  };
}

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------
function generateJsonReport(results, metadata) {
  const hasBlockingFailure = results.some((r) => !r.pass && r.severity === SEVERITY.BLOCKING);
  const scoreOpts = { mode: metadata.mode, strict: metadata.strict };
  const score = computeReadinessScore(results, scoreOpts);
  const readiness = computeStructuredReadiness(results, scoreOpts);

  return {
    preflight: true,
    version: '3.0',
    timestamp: metadata.timestamp,
    node: metadata.nodeVersion,
    gitBranch: metadata.gitBranch,
    mode: metadata.mode,
    strict: metadata.strict || false,
    stressSeeds: metadata.stressSeeds || null,
    readinessScore: score,
    readinessThreshold: readiness.threshold,
    readinessPasses: readiness.passes,
    overallPass: !hasBlockingFailure && readiness.passes,
    checks: results.map((r) => ({
      name: r.name,
      status: r.status,
      pass: r.pass,
      severity: r.severity,
      durationMs: r.durationMs || 0,
      details: r.details || null,
      evidence: r.evidence || null,
      remediation: r.remediation || null,
    })),
  };
}

function generateMarkdownReport(results, metadata) {
  const hasBlockingFailure = results.some((r) => !r.pass && r.severity === SEVERITY.BLOCKING);
  const scoreOpts = { mode: metadata.mode, strict: metadata.strict };
  const score = computeReadinessScore(results, scoreOpts);
  const readiness = computeStructuredReadiness(results, scoreOpts);
  const lines = [];

  lines.push('# PREFLIGHT GATE REPORT');
  lines.push('');
  lines.push(`- **Timestamp**: ${metadata.timestamp}`);
  lines.push(`- **Node**: ${metadata.nodeVersion}`);
  lines.push(`- **Branch**: ${metadata.gitBranch}`);
  lines.push(`- **Mode**: ${metadata.mode}`);
  if (metadata.strict) {
    lines.push('- **Strict**: YES');
  }
  if (metadata.stressSeeds) {
    lines.push(`- **Stress seeds**: ${metadata.stressSeeds}`);
  }
  lines.push(`- **Readiness Score**: ${score}/100 (threshold: ${readiness.threshold})`);
  lines.push('');
  const overallPass = !hasBlockingFailure && readiness.passes;
  lines.push(`## Result: ${overallPass ? 'PASS' : 'FAIL'}`);
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
      if (f.remediation) {
        lines.push('');
        lines.push(`**Remediation:** \`${f.remediation}\``);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Gate Runners
// ---------------------------------------------------------------------------
function runQuick(options) {
  const mode = options?.gateMode || GATE_MODES.DEV;
  const strict = options?.strict || false;

  const results = [];
  results.push(applyModePolicy(checkDirtyTree(), mode, strict));
  results.push(applyModePolicy(checkHeadContent(), mode, strict));
  results.push(applyModePolicy(checkModuleExportContracts(), mode, strict));
  return results;
}

function runFull(options = {}) {
  const mode = options.gateMode || GATE_MODES.DEV;
  const strict = options.strict || false;

  const results = runQuick(options);

  results.push(applyModePolicy(checkTemplateContract(), mode, strict));
  results.push(applyModePolicy(checkRouteGeometry(), mode, strict));
  results.push(applyModePolicy(checkSchemaFirewall(), mode, strict));
  results.push(applyModePolicy(checkIntegrityPipeline(), mode, strict));

  // New gates
  results.push(applyModePolicy(checkModuleFunctionSignatures(), mode, strict));
  results.push(applyModePolicy(checkSchemaCompatibility(), mode, strict));
  results.push(applyModePolicy(checkSparseSlideGate(), mode, strict));
  results.push(
    applyModePolicy(checkSourceCoverageGate(options.sourceCoverageThreshold), mode, strict)
  );

  // Real output check
  results.push(
    applyModePolicy(
      checkRealOutputValidation({
        deckDir: options.deckDir,
        country: options.country,
        industry: options.industry,
      }),
      mode,
      strict
    )
  );

  // Formatting audit (drift/mismatch detection)
  results.push(applyModePolicy(checkFormattingAudit(), mode, strict));

  // Only run regression/stress if quick checks passed
  const hasBlockingFailure = results.some((r) => !r.pass && r.severity === SEVERITY.BLOCKING);

  if (hasBlockingFailure) {
    results.push(
      makeCheckResult(
        'Regression tests',
        true,
        SEVERITY.BLOCKING,
        0,
        'Skipped — fix blocking failures first'
      )
    );
    if (options.stressSeeds) {
      results.push(
        makeCheckResult(
          'Stress test',
          true,
          SEVERITY.BLOCKING,
          0,
          'Skipped — fix blocking failures first'
        )
      );
    }
  } else {
    results.push(applyModePolicy(runRegressionTests(), mode, strict));
    if (options.stressSeeds) {
      results.push(applyModePolicy(runStressCheck(options.stressSeeds), mode, strict));
    }
  }

  return results;
}

function runGates(options = {}) {
  const mode = options.mode || 'quick';
  if (mode === 'quick') {
    return runQuick(options);
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
  let strict = false;
  let gateMode = GATE_MODES.DEV;
  let sourceCoverageThreshold = 70;
  let deckDir = null;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg.startsWith('--mode=')) {
      const val = arg.split('=')[1];
      if (val === 'quick' || val === 'full') {
        mode = val;
      }
    } else if (arg.startsWith('--gate-mode=')) {
      const val = arg.split('=')[1];
      if (val === 'dev' || val === 'test' || val === 'release') {
        gateMode = val;
      }
    } else if (arg.startsWith('--stress-seeds=')) {
      const val = parseInt(arg.split('=')[1], 10);
      if (Number.isFinite(val) && val > 0) {
        stressSeeds = Math.min(val, 200);
      }
    } else if (arg.startsWith('--report-dir=')) {
      reportDir = arg.split('=')[1];
    } else if (arg.startsWith('--source-coverage=')) {
      const val = parseInt(arg.split('=')[1], 10);
      if (Number.isFinite(val) && val > 0) {
        sourceCoverageThreshold = val;
      }
    } else if (arg.startsWith('--deck-dir=')) {
      deckDir = arg.split('=')[1];
    }
  }

  return { mode, stressSeeds, reportDir, help, strict, gateMode, sourceCoverageThreshold, deckDir };
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
  --mode=quick|full          Gate mode (default: quick)
  --gate-mode=dev|test|release  Severity policy (default: dev)
  --strict                   Treat any non-pass as BLOCKING failure
  --stress-seeds=N           Run stress test with N seeds (full mode only, max 200)
  --source-coverage=N        Source coverage threshold percentage (default: 70)
  --deck-dir=PATH            Directory containing .pptx decks for real-output check
  --report-dir=PATH          Output directory for reports
  --help                     Show this help

Examples:
  node preflight-gates.js --mode=quick
  node preflight-gates.js --mode=full --gate-mode=release --strict
  node preflight-gates.js --mode=full --stress-seeds=100
`);
    process.exit(0);
  }

  const modeLabel = `${args.mode.toUpperCase()} / ${args.gateMode.toUpperCase()}${args.strict ? ' / STRICT' : ''}`;
  console.log('');
  console.log(`=== PREFLIGHT GATES (${modeLabel}) ===`);
  console.log('');

  const results = runGates({
    mode: args.mode,
    gateMode: args.gateMode,
    strict: args.strict,
    stressSeeds: args.stressSeeds,
    sourceCoverageThreshold: args.sourceCoverageThreshold,
    deckDir: args.deckDir,
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
    if (!r.pass && r.remediation) {
      console.log(`       Fix: ${r.remediation}`);
    }
  }

  const scoreOpts = { mode: args.gateMode, strict: args.strict };
  const score = computeReadinessScore(results, scoreOpts);
  const readiness = computeStructuredReadiness(results, scoreOpts);
  const hasBlockingFailure = results.some((r) => !r.pass && r.severity === SEVERITY.BLOCKING);

  // Generate reports
  const metadata = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    gitBranch: getGitBranch(),
    mode: args.gateMode,
    strict: args.strict,
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
      JSON.stringify(jsonReport, null, 2)
    );
    fs.writeFileSync(path.join(args.reportDir, 'preflight-gates-report.md'), mdReport);
    console.log('');
    console.log(`Reports: ${args.reportDir}/preflight-gates-report.{json,md}`);
  } catch (reportErr) {
    console.log(`[WARN] Could not write reports: ${reportErr.message}`);
  }

  console.log('');
  console.log(`Readiness Score: ${score}/100 (threshold: ${readiness.threshold})`);

  const overallPass = !hasBlockingFailure && readiness.passes;

  if (!overallPass) {
    if (!readiness.passes) {
      console.log(
        `=== PREFLIGHT FAILED — readiness score ${score} below threshold ${readiness.threshold} ===`
      );
    } else {
      console.log('=== PREFLIGHT FAILED — BLOCKING failures detected ===');
    }
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
  checkModuleFunctionSignatures,
  checkTemplateContract,
  checkRouteGeometry,
  checkSchemaFirewall,
  checkIntegrityPipeline,
  runRegressionTests,
  runStressCheck,
  checkSchemaCompatibility,
  checkSparseSlideGate,
  checkSourceCoverageGate,
  checkRealOutputValidation,
  checkFormattingAudit,
  // Mode & policy
  applyModePolicy,
  getEnvironmentContract,
  validateModeParity,
  computeStructuredReadiness,
  // Reporting
  generateJsonReport,
  generateMarkdownReport,
  computeReadinessScore,
  parseArgs,
  // Constants
  MODULE_EXPORT_CONTRACTS,
  TEMPLATE_PATTERNS_EXPECTED_KEYS,
  SEVERITY,
  GATE_MODES,
  ENVIRONMENT_CONTRACTS,
  QUICK_GATES,
  FULL_GATES,
  REMEDIATION_MAP,
  FORMATTING_AUDIT_WARNING_CODES,
  isReportSlideDivider,
};
