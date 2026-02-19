#!/usr/bin/env node
// Ops Runbook — executable runbook for market-research pipeline operators.
// Not documentation — a script that helps triage, validate, and debug.
//
// Usage:
//   node ops-runbook.js --validate-local
//   node ops-runbook.js --triage "error message here"
//   node ops-runbook.js --playbook "ppt-repair"
//   node ops-runbook.js --commands

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const SERVICE_DIR = __dirname;

// ============ ERROR PATTERNS ============

const ERROR_PATTERNS = [
  {
    pattern: /PPT structural check failed/i,
    rootCause: 'Generated PPTX file is malformed or truncated.',
    fix: [
      'Run the fileSafety pipeline: node -e "require(\'./deck-file-check\').validatePPTX(require(\'fs\').readFileSync(\'output.pptx\')).then(r => console.log(JSON.stringify(r, null, 2)))"',
      'Check deck-builder-single.js for recent template changes.',
      'Run regression tests: npm test -- --testPathPattern=market-research',
    ],
  },
  {
    pattern: /PPT building quality failed/i,
    rootCause: 'Too many slide blocks failed to build.',
    fix: [
      'Check pptMetrics in /api/runInfo for slideRenderFailureCount.',
      'Look for templateCoverage < 95% — indicates template pattern mismatch.',
      'Review template-patterns.json for missing or changed patterns.',
    ],
  },
  {
    pattern: /PPT formatting styleMatch failed/i,
    rootCause: 'Template coverage or geometry alignment regression.',
    fix: [
      'Check pptMetrics for templateCoverage, nonTemplatePatternCount, geometryIssueCount.',
      'Compare template-patterns.json against the base PPTX template.',
      'Run: node build-template-patterns.js to regenerate patterns.',
    ],
  },
  {
    pattern: /Country analysis quality gate failed/i,
    rootCause: 'Research output did not meet readiness thresholds.',
    fix: [
      'Check /api/runInfo for notReadyCountries details.',
      'Look at effectiveScore, coherenceScore, finalReviewCritical, finalReviewMajor.',
      'If coherence < 70, synthesis prompts may need tuning in research-engine.js.',
      'If critical issues > 1, check finalReview.issues for specific problems.',
    ],
  },
  {
    pattern: /Synthesis quality too low/i,
    rootCause: 'Synthesis pass scored below acceptable threshold.',
    fix: [
      'Check /api/runInfo for synthesisGate scores.',
      'Increase maxTokens in scope or GEMINI model config.',
      'Check if country rawData has enough content for synthesis.',
    ],
  },
  {
    pattern: /PPT data gate failed/i,
    rootCause: 'Country analysis sections have empty or invalid data for PPT building.',
    fix: [
      'Check /api/runInfo for pptDataGateFailures.',
      'Look for nonRenderableGroups, emptyBlocks, chartIssues.',
      'Check synthesis output for empty sections — may need gap fill.',
    ],
  },
  {
    pattern: /Pre-build structure gate failed/i,
    rootCause: 'Country analysis has non-canonical or missing required sections.',
    fix: [
      'Check /api/runInfo for preRenderStructureIssues.',
      'Verify synthesis output matches canonical section keys in server.js.',
      'Check cleanup-temp-fields.js if legitimate keys are being removed.',
    ],
  },
  {
    pattern: /Budget gate/i,
    rootCause: 'Fields or tables exceed size budgets — risk of PPT overflow.',
    fix: [
      'Check /api/runInfo for contentSizeCheck details per country.',
      'Review FIELD_CHAR_BUDGETS in content-size-check.js.',
      'If compaction is too aggressive, increase limits in content-size-check.js.',
    ],
  },
  {
    pattern: /Server PPT relationship fileSafety failed/i,
    rootCause: 'PPTX internal references are broken — missing relationship targets.',
    fix: [
      'Run fileSafety pipeline manually on the output buffer.',
      'Check deck-file-check.js scanRelationshipTargets for the specific broken refs.',
      'This often happens when slides are cloned incorrectly in deck-builder-single.js.',
    ],
  },
  {
    pattern: /Server PPT package consistency failed/i,
    rootCause: 'PPTX ZIP structure has duplicates, missing parts, or content-type mismatches.',
    fix: [
      'Run: node -e "require(\'./deck-file-check\').readPPTX(require(\'fs\').readFileSync(\'output.pptx\')).then(({zip}) => require(\'./deck-file-check\').scanPackageConsistency(zip).then(r => console.log(JSON.stringify(r, null, 2))))"',
      'Check for duplicate relationship IDs or slide IDs.',
      'Review template-fill.js if slide cloning is involved.',
    ],
  },
  {
    pattern: /Pipeline aborted/i,
    rootCause: 'Pipeline was aborted — either timeout or manual abort.',
    fix: [
      'Check PIPELINE_TIMEOUT_SECONDS env var (default: disabled).',
      'If timeout, consider increasing or disabling: DISABLE_PIPELINE_TIMEOUT=true.',
      'If manual abort, check AbortController usage in calling code.',
    ],
  },
  {
    pattern: /GEMINI|gemini.*error|API.*rate.*limit/i,
    rootCause: 'Gemini API call failed — rate limit, quota, or transient error.',
    fix: [
      'Check GEMINI_API_KEY is valid and has quota.',
      'Check /api/costs for current spend vs GEMINI_BUDGET_LIMIT.',
      'Rate limits: reduce concurrency in research batches (currently 2).',
    ],
  },
  {
    pattern: /ENOMEM|JavaScript heap out of memory|allocation failed/i,
    rootCause: 'Process ran out of memory (450MB limit on Railway).',
    fix: [
      'Check which stage consumed the most memory via perf-profiler metrics.',
      'Ensure rawData is cleaned up after PPT generation.',
      'Reduce country batch size or synthesis maxTokens.',
      'Run with: node --expose-gc --max-old-space-size=450 server.js',
    ],
  },
];

// ============ PLAYBOOKS ============

const PLAYBOOKS = {
  'ppt-repair': {
    title: 'PPT opens with repair prompt',
    steps: [
      'Download the PPT from /api/latest-ppt',
      'Run checker: node -e "require(\'./deck-file-check\').validatePPTX(require(\'fs\').readFileSync(\'<file>\')).then(r => console.log(JSON.stringify(r, null, 2)))"',
      'Check for: duplicate IDs, broken relationships, missing content types',
      'Run repair: node repair-pptx.js <file>',
      'If repair fails, check deck-builder-single.js slide generation',
    ],
  },
  'quality-gate-failing': {
    title: 'Quality gate failing',
    steps: [
      'Check /api/runInfo for the failing gate',
      'Research gate: look at researchTopicChars — any topic < 200 chars is likely thin',
      'Synthesis gate: check synthesisGate.overall score and failures array',
      'PPT data gate: check pptDataGateFailures for empty blocks',
      'Readiness check: check notReadyCountries for effectiveScore and coherenceScore',
      'Content gate: check contentReadiness.overallScore and failed section reasons',
    ],
  },
  'content-size-check-compacting': {
    title: 'Content size check compacting too much',
    steps: [
      'Check /api/runInfo contentSizeCheck for the selected country',
      'Look at compacted field count and risk level',
      'If risk=high with many compactions, increase FIELD_CHAR_BUDGETS in content-size-check.js',
      'Check TABLE_MAX_ROWS (default 16), TABLE_MAX_COLS (default 9)',
      'If tables are being truncated too aggressively, raise TABLE_FLEX_MAX_ROWS env var',
    ],
  },
  'stress-test-crash': {
    title: 'Stress test crashes',
    steps: [
      'Check which seed caused the crash: look at stress-test-harness.js output',
      'Replay the seed: node stress-test-harness.js --seed=<seed>',
      'Check memory usage at crash point — likely OOM if > 400MB heap',
      'Check mutation class — some mutations produce invalid payloads',
      'Run with --expose-gc flag and lower concurrency',
    ],
  },
  'slow-pipeline': {
    title: 'Pipeline running slower than expected',
    steps: [
      'Check /api/runInfo for total run time',
      'Check perf-profiler.getStageMetrics() for per-stage breakdown',
      'Typical bottlenecks: countryResearch (API calls), synthesis (LLM), pptGeneration (XML)',
      'If countryResearch is slow: check Gemini API latency, consider increasing batch size',
      'If synthesis is slow: check maxTokens setting, consider gemini-3-flash for speed',
      'If pptGeneration is slow: check payload size — content size check should have caught oversize',
    ],
  },
  'email-not-arriving': {
    title: 'Results email not arriving',
    steps: [
      'Check server logs for "Failed to send" or SendGrid errors',
      'Verify SENDGRID_API_KEY is valid',
      'Verify SENDER_EMAIL is set and verified in SendGrid',
      'Check spam/junk folder',
      'Check /api/runInfo — if stage=error, the pipeline failed before email',
      'If pipeline succeeded, check the error email catch block in server.js',
    ],
  },
};

// ============ COMMAND COOKBOOK ============

const COMMANDS = {
  'Health Checks': [
    { cmd: 'curl -s http://localhost:3010/health | jq .', desc: 'Check service health' },
    { cmd: 'curl -s http://localhost:3010/api/costs | jq .', desc: 'Check API cost tracker' },
    {
      cmd: 'curl -s http://localhost:3010/api/runInfo | jq .',
      desc: 'Get last run runInfo',
    },
  ],
  Debugging: [
    {
      cmd: 'curl -s http://localhost:3010/api/runInfo | jq .stage',
      desc: 'Check which stage failed',
    },
    {
      cmd: 'curl -s http://localhost:3010/api/runInfo | jq .error',
      desc: 'Get error message',
    },
    {
      cmd: 'curl -s http://localhost:3010/api/runInfo | jq .notReadyCountries',
      desc: 'Check readiness gate details',
    },
    {
      cmd: 'curl -s http://localhost:3010/api/runInfo | jq .contentSizeCheck',
      desc: 'Check content size check results',
    },
    {
      cmd: 'curl -s http://localhost:3010/api/runInfo | jq .ppt',
      desc: 'Check PPT metrics',
    },
  ],
  Profiling: [
    {
      cmd: 'node -e "const p = require(\'./perf-profiler\'); console.log(JSON.stringify(p.getStageMetrics(), null, 2))"',
      desc: 'Get per-stage performance metrics',
    },
    {
      cmd: 'node -e "const p = require(\'./perf-profiler\'); console.log(JSON.stringify(p.getHighCostStages(), null, 2))"',
      desc: 'Find high-cost late-failure stages',
    },
    {
      cmd: 'node -e "const p = require(\'./perf-profiler\'); console.log(JSON.stringify(p.getParallelismRecommendations(), null, 2))"',
      desc: 'Get parallelism recommendations',
    },
  ],
  'Stress Testing': [
    {
      cmd: 'node stress-test-harness.js',
      desc: 'Run stress test with default settings',
    },
    {
      cmd: 'node stress-test-harness.js --seed=12345',
      desc: 'Replay specific stress test seed',
    },
    {
      cmd: 'node regression-tests.js',
      desc: 'Run regression test suite',
    },
  ],
  PPT: [
    {
      cmd: 'curl -s -o latest.pptx http://localhost:3010/api/latest-ppt',
      desc: 'Download latest generated PPT',
    },
    {
      cmd: 'node repair-pptx.js latest.pptx',
      desc: 'Repair a PPTX file',
    },
    {
      cmd: 'node build-template-patterns.js',
      desc: 'Rebuild template patterns from base PPTX',
    },
  ],
  'Local Development': [
    { cmd: 'npm run dev', desc: 'Start server in dev mode' },
    { cmd: 'npm test -- --testPathPattern=market-research', desc: 'Run market-research tests' },
    { cmd: 'npm run lint:fix', desc: 'Fix lint issues' },
    {
      cmd: 'node --expose-gc --max-old-space-size=450 server.js',
      desc: 'Start with production memory constraints',
    },
  ],
};

// ============ VALIDATE LOCAL ============

/**
 * Runs a local check sequence:
 * 1. Preflight checks (env vars, dependencies)
 * 2. Lint check
 * 3. Test suite
 * 4. Health check (if server is running)
 *
 * @returns {{ passed: boolean, steps: Array<{name: string, passed: boolean, output: string}> }}
 */
function validateLocal() {
  const steps = [];

  // Step 1: Check required env vars
  const requiredVars = ['GEMINI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
  const missingVars = requiredVars.filter((v) => !process.env[v]);
  steps.push({
    name: 'Environment variables',
    passed: missingVars.length === 0,
    output: missingVars.length === 0 ? 'All required env vars set' : `Missing: ${missingVars.join(', ')}`,
    command: 'echo $GEMINI_API_KEY $SENDGRID_API_KEY $SENDER_EMAIL',
  });

  // Step 2: Check key files exist
  const fs = require('fs');
  const keyFiles = [
    'server.js',
    'content-size-check.js',
    'content-gates.js',
    'deck-file-check.js',
    'research-engine.js',
    'ai-clients.js',
    'deck-builder-single.js',
  ];
  const missingFiles = keyFiles.filter((f) => !fs.existsSync(path.join(SERVICE_DIR, f)));
  steps.push({
    name: 'Key files present',
    passed: missingFiles.length === 0,
    output:
      missingFiles.length === 0
        ? `All ${keyFiles.length} key files present`
        : `Missing: ${missingFiles.join(', ')}`,
    command: `ls -la ${keyFiles.map((f) => path.join(SERVICE_DIR, f)).join(' ')}`,
  });

  // Step 3: Try to require main modules (syntax check)
  const modulesToCheck = ['./content-size-check', './content-gates', './perf-profiler'];
  const moduleErrors = [];
  for (const mod of modulesToCheck) {
    try {
      require(mod);
    } catch (err) {
      moduleErrors.push(`${mod}: ${err.message}`);
    }
  }
  steps.push({
    name: 'Module syntax check',
    passed: moduleErrors.length === 0,
    output: moduleErrors.length === 0 ? 'All modules load OK' : moduleErrors.join('; '),
    command: `node -e "require('${modulesToCheck.join("'); require('")}')"`,
  });

  // Step 4: Check if server is reachable
  let serverReachable = false;
  try {
    execSync('curl -sf http://localhost:3010/health', { timeout: 5000, stdio: 'pipe' });
    serverReachable = true;
  } catch {
    // Server not running — that's OK for local check
  }
  steps.push({
    name: 'Server health check',
    passed: serverReachable,
    output: serverReachable ? 'Server responding at :3010' : 'Server not running (OK for local dev)',
    command: 'curl -s http://localhost:3010/health | jq .',
  });

  const passed = steps.every((s) => s.passed || s.name === 'Server health check');

  return { passed, steps };
}

// ============ TRIAGE ERROR ============

/**
 * Given an error message, identifies likely root cause and fix steps.
 * @param {string} errorMessage
 * @returns {{ matched: boolean, pattern: string|null, rootCause: string|null, fix: string[]|null }}
 */
function triageError(errorMessage) {
  if (!errorMessage || typeof errorMessage !== 'string') {
    return { matched: false, pattern: null, rootCause: null, fix: null };
  }

  for (const ep of ERROR_PATTERNS) {
    if (ep.pattern.test(errorMessage)) {
      return {
        matched: true,
        pattern: ep.pattern.source,
        rootCause: ep.rootCause,
        fix: ep.fix,
      };
    }
  }

  return {
    matched: false,
    pattern: null,
    rootCause: null,
    fix: [
      'Check /api/runInfo for full error context.',
      'Search server logs for the error message.',
      'Check the stage field in runInfo to narrow the failure point.',
    ],
  };
}

// ============ GET PLAYBOOK ============

/**
 * Returns a playbook for a known recurring issue.
 * @param {string} name - Playbook key (e.g., "ppt-repair", "quality-gate-failing")
 * @returns {{ found: boolean, title: string|null, steps: string[]|null, availablePlaybooks: string[] }}
 */
function getPlaybook(name) {
  const available = Object.keys(PLAYBOOKS);

  if (!name || !PLAYBOOKS[name]) {
    return { found: false, title: null, steps: null, availablePlaybooks: available };
  }

  const pb = PLAYBOOKS[name];
  return { found: true, title: pb.title, steps: pb.steps, availablePlaybooks: available };
}

// ============ GET COMMANDS ============

/**
 * Returns the full command cookbook.
 * @param {string} [category] - Optional filter by category
 * @returns {object}
 */
function getCommands(category) {
  if (category && COMMANDS[category]) {
    return { [category]: COMMANDS[category] };
  }
  return COMMANDS;
}

// ============ ERROR CODE RUNBOOKS ============

const ERROR_CODE_RUNBOOKS = {
  PPT_STRUCTURAL_VALIDATION: {
    code: 'PPT_STRUCTURAL_VALIDATION',
    title: 'PPTX structural check failure',
    severity: 'critical',
    steps: [
      { action: 'Run fileSafety pipeline on the output buffer', command: 'node -e "require(\'./pptx-fileSafety-pipeline\').runFileSafetyPipeline(require(\'fs\').readFileSync(\'output.pptx\')).then(r => console.log(JSON.stringify(r, null, 2)))"' },
      { action: 'Check for duplicate slide IDs or broken refs', command: 'node -e "require(\'./deck-file-check\').validatePPTX(require(\'fs\').readFileSync(\'output.pptx\')).then(r => console.log(JSON.stringify(r, null, 2)))"' },
      { action: 'Run repair', command: 'node repair-pptx.js output.pptx' },
      { action: 'If repair fails, check template clone postprocess', command: 'grep -n "cloneSlide\\|duplicateSlide" deck-builder-single.js' },
    ],
  },
  PPT_RENDERING_QUALITY: {
    code: 'PPT_RENDERING_QUALITY',
    title: 'Slide building failure rate too high',
    severity: 'high',
    steps: [
      { action: 'Check PPT metrics for build failures', command: 'curl -s http://localhost:3010/api/runInfo | jq .ppt' },
      { action: 'Review template pattern coverage', command: 'node -e "console.log(JSON.stringify(require(\'./template-contract-compiler\').compile(), null, 2))"' },
      { action: 'Regenerate template patterns', command: 'node build-template-patterns.js' },
    ],
  },
  QUALITY_GATE_FAILED: {
    code: 'QUALITY_GATE_FAILED',
    title: 'Research quality gate failure',
    severity: 'high',
    steps: [
      { action: 'Check runInfo for failing gate', command: 'curl -s http://localhost:3010/api/runInfo | jq "{synthesisGate, notReadyCountries, pptDataGateFailures}"' },
      { action: 'Check synthesis scores per country', command: 'curl -s http://localhost:3010/api/runInfo | jq ".countries[]? | {country, score: .synthesisScores?.overall}"' },
      { action: 'If borderline, try soft bypass', command: 'SOFT_READINESS_GATE=true node server.js' },
    ],
  },
  BUDGET_GATE: {
    code: 'BUDGET_GATE',
    title: 'Budget gate overflow risk',
    severity: 'medium',
    steps: [
      { action: 'Check content size check details', command: 'curl -s http://localhost:3010/api/runInfo | jq .contentSizeCheck' },
      { action: 'Review field char budgets', command: 'grep -n "FIELD_CHAR_BUDGETS" content-size-check.js' },
      { action: 'Increase limits if needed', command: 'Edit FIELD_CHAR_BUDGETS in content-size-check.js' },
    ],
  },
  GEMINI_API_ERROR: {
    code: 'GEMINI_API_ERROR',
    title: 'Gemini API call failure',
    severity: 'high',
    steps: [
      { action: 'Check API key validity', command: 'node -e "console.log(!!process.env.GEMINI_API_KEY ? \'Key set\' : \'Key missing\')"' },
      { action: 'Check cost budget', command: 'curl -s http://localhost:3010/api/costs | jq .' },
      { action: 'Reduce concurrency if rate-limited', command: 'Set RESEARCH_BATCH_SIZE=1 in env' },
    ],
  },
  OOM: {
    code: 'OOM',
    title: 'Out of memory',
    severity: 'critical',
    steps: [
      { action: 'Check stage memory usage', command: 'node -e "console.log(JSON.stringify(require(\'./perf-profiler\').getStageMetrics(), null, 2))"' },
      { action: 'Run with GC and constrained heap', command: 'node --expose-gc --max-old-space-size=450 server.js' },
      { action: 'Reduce batch size or maxTokens', command: 'Set COUNTRY_BATCH_SIZE=1 in env' },
    ],
  },
  PIPELINE_ABORT: {
    code: 'PIPELINE_ABORT',
    title: 'Pipeline aborted (timeout or manual)',
    severity: 'medium',
    steps: [
      { action: 'Check timeout config', command: 'echo $PIPELINE_TIMEOUT_SECONDS' },
      { action: 'Disable timeout if needed', command: 'DISABLE_PIPELINE_TIMEOUT=true node server.js' },
      { action: 'Check for abort controller usage', command: 'grep -n "AbortController\\|abort()" server.js' },
    ],
  },
  EMAIL_DELIVERY: {
    code: 'EMAIL_DELIVERY',
    title: 'Email delivery failure',
    severity: 'medium',
    steps: [
      { action: 'Verify SendGrid key', command: 'node -e "console.log(!!process.env.SENDGRID_API_KEY ? \'Key set\' : \'Key missing\')"' },
      { action: 'Verify sender email', command: 'echo $SENDER_EMAIL' },
      { action: 'Check server logs for SendGrid errors', command: 'grep -i "sendgrid\\|email.*fail" server.log' },
    ],
  },
};

// ============ OPERATIONAL PROFILES ============

const PROFILES = {
  'fast-check': {
    name: 'fast-check',
    description: 'Quick sanity check: env vars, module syntax, template contract',
    checks: ['env-vars', 'key-files', 'module-syntax', 'template-contract'],
    estimatedSeconds: 5,
  },
  'release-check': {
    name: 'release-check',
    description: 'Release readiness: fast-check + regression tests + preflight gates',
    checks: ['env-vars', 'key-files', 'module-syntax', 'template-contract', 'regression-tests', 'preflight-gates'],
    estimatedSeconds: 30,
  },
  'deep-audit': {
    name: 'deep-audit',
    description: 'Full audit: release-check + stress test + fileSafety pipeline',
    checks: [
      'env-vars', 'key-files', 'module-syntax', 'template-contract',
      'regression-tests', 'preflight-gates', 'stress-test', 'fileSafety-pipeline',
    ],
    estimatedSeconds: 120,
  },
};

// ============ RUN LOCAL READINESS ============

/**
 * One-command local readiness workflow.
 * @param {object} options
 * @param {string} options.mode - 'fast-check' | 'release-check' | 'deep-audit'
 * @param {boolean} [options.strict] - If true, any warning becomes a failure
 * @returns {{ pass: boolean, mode: string, checks: Array, duration: number, verdict: string }}
 */
function runLocalReadiness(options = {}) {
  const startMs = Date.now();
  const mode = options.mode || 'fast-check';
  const strict = !!options.strict;
  const profile = PROFILES[mode];

  if (!profile) {
    return {
      pass: false,
      mode,
      checks: [{ name: 'profile-lookup', pass: false, output: `Unknown mode: ${mode}. Valid: ${Object.keys(PROFILES).join(', ')}` }],
      duration: Date.now() - startMs,
      verdict: `Invalid mode "${mode}"`,
    };
  }

  const checks = [];
  const fs = require('fs');

  // --- env-vars ---
  if (profile.checks.includes('env-vars')) {
    const requiredVars = ['GEMINI_API_KEY', 'SENDGRID_API_KEY', 'SENDER_EMAIL'];
    const missing = requiredVars.filter((v) => !process.env[v]);
    checks.push({
      name: 'env-vars',
      pass: missing.length === 0,
      output: missing.length === 0 ? 'All required env vars set' : `Missing: ${missing.join(', ')}`,
    });
  }

  // --- key-files ---
  if (profile.checks.includes('key-files')) {
    const keyFiles = ['server.js', 'content-size-check.js', 'content-gates.js', 'deck-file-check.js', 'research-engine.js', 'ai-clients.js', 'deck-builder-single.js'];
    const missing = keyFiles.filter((f) => !fs.existsSync(path.join(SERVICE_DIR, f)));
    checks.push({
      name: 'key-files',
      pass: missing.length === 0,
      output: missing.length === 0 ? `All ${keyFiles.length} key files present` : `Missing: ${missing.join(', ')}`,
    });
  }

  // --- module-syntax ---
  if (profile.checks.includes('module-syntax')) {
    const modulesToCheck = ['./content-size-check', './content-gates', './perf-profiler'];
    const errors = [];
    for (const mod of modulesToCheck) {
      try {
        require(mod);
      } catch (err) {
        errors.push(`${mod}: ${err.message}`);
      }
    }
    checks.push({
      name: 'module-syntax',
      pass: errors.length === 0,
      output: errors.length === 0 ? 'All modules load OK' : errors.join('; '),
    });
  }

  // --- template-contract ---
  if (profile.checks.includes('template-contract')) {
    let contractOk = false;
    let contractOutput = '';
    try {
      const tcc = require('./template-contract-compiler');
      const contract = tcc.compile();
      const slideCount = contract && contract.slides ? Object.keys(contract.slides).length : 0;
      contractOk = slideCount > 0;
      contractOutput = contractOk ? `Template contract compiled: ${slideCount} slides` : 'Template contract has 0 slides';
    } catch (err) {
      contractOutput = `Template contract error: ${err.message}`;
    }
    checks.push({
      name: 'template-contract',
      pass: contractOk,
      output: contractOutput,
    });
  }

  // --- regression-tests ---
  if (profile.checks.includes('regression-tests')) {
    let testPass = false;
    let testOutput = '';
    try {
      execSync('npx jest --testPathPattern=market-research --no-coverage --passWithNoTests 2>&1', {
        cwd: path.join(SERVICE_DIR, '..'),
        timeout: 60000,
        stdio: 'pipe',
      });
      testPass = true;
      testOutput = 'All tests passed';
    } catch (err) {
      testOutput = `Tests failed: ${(err.stdout || err.message || '').toString().slice(0, 200)}`;
    }
    checks.push({
      name: 'regression-tests',
      pass: testPass,
      output: testOutput,
    });
  }

  // --- preflight-gates ---
  if (profile.checks.includes('preflight-gates')) {
    let preflightPass = false;
    let preflightOutput = '';
    try {
      const preflight = require('./preflight-gates');
      if (typeof preflight.runAll === 'function') {
        const result = preflight.runAll();
        preflightPass = result && result.pass !== false;
        preflightOutput = preflightPass ? 'Preflight gates passed' : `Preflight issues: ${JSON.stringify(result).slice(0, 200)}`;
      } else {
        preflightPass = true;
        preflightOutput = 'Preflight module loaded (no runAll export)';
      }
    } catch (err) {
      preflightOutput = `Preflight error: ${err.message}`;
    }
    checks.push({
      name: 'preflight-gates',
      pass: preflightPass,
      output: preflightOutput,
    });
  }

  // --- stress-test ---
  if (profile.checks.includes('stress-test')) {
    let stressPass = false;
    let stressOutput = '';
    try {
      execSync('node stress-test-harness.js --quick 2>&1', {
        cwd: SERVICE_DIR,
        timeout: 120000,
        stdio: 'pipe',
      });
      stressPass = true;
      stressOutput = 'Stress test passed';
    } catch (err) {
      stressOutput = `Stress test failed: ${(err.stdout || err.message || '').toString().slice(0, 200)}`;
    }
    checks.push({
      name: 'stress-test',
      pass: stressPass,
      output: stressOutput,
    });
  }

  // --- fileSafety-pipeline ---
  if (profile.checks.includes('fileSafety-pipeline')) {
    let fileSafetyPass = false;
    let fileSafetyOutput = '';
    try {
      const integ = require('./pptx-fileSafety-pipeline');
      fileSafetyPass = typeof integ.runFileSafetyPipeline === 'function';
      fileSafetyOutput = fileSafetyPass ? 'FileSafety pipeline module available' : 'Missing runFileSafetyPipeline export';
    } catch (err) {
      fileSafetyOutput = `FileSafety pipeline error: ${err.message}`;
    }
    checks.push({
      name: 'fileSafety-pipeline',
      pass: fileSafetyPass,
      output: fileSafetyOutput,
    });
  }

  const duration = Date.now() - startMs;
  const failures = checks.filter((c) => !c.pass);
  const pass = strict ? failures.length === 0 : failures.filter((c) => c.name !== 'preflight-gates' && c.name !== 'stress-test' && c.name !== 'fileSafety-pipeline').length === 0;

  let verdict;
  if (pass && failures.length === 0) {
    verdict = `All ${checks.length} checks passed (${mode})`;
  } else if (pass) {
    verdict = `Passed with ${failures.length} non-critical warning(s) (${mode})`;
  } else {
    verdict = `FAILED: ${failures.length} check(s) failed (${mode})`;
  }

  return { pass, mode, checks, duration, verdict };
}

// ============ RECOMMEND ACTIONS ============

/**
 * Post-run action recommender. Given runInfo from a pipeline run,
 * returns exact remediation commands for each detected issue.
 * @param {object} runInfo - lastRunRunInfo from server.js
 * @returns {{ actions: Array<{issue: string, severity: string, command: string}>, summary: string }}
 */
function recommendActions(runInfo) {
  const actions = [];

  if (!runInfo) {
    return { actions: [{ issue: 'No runInfo provided', severity: 'info', command: 'curl -s http://localhost:3010/api/runInfo | jq .' }], summary: 'No runInfo to analyze' };
  }

  // Check stage failure
  if (runInfo.error || runInfo.stage === 'error') {
    const triage = triageError(runInfo.error || '');
    if (triage.matched) {
      actions.push({
        issue: triage.rootCause,
        severity: 'critical',
        command: triage.fix[0],
      });
    } else {
      actions.push({
        issue: `Pipeline error: ${runInfo.error || 'unknown'}`,
        severity: 'critical',
        command: 'Check server logs for full stack trace',
      });
    }
  }

  // Quality gate issues
  if (runInfo.notReadyCountries && runInfo.notReadyCountries.length > 0) {
    actions.push({
      issue: `${runInfo.notReadyCountries.length} country(ies) not ready`,
      severity: 'high',
      command: 'curl -s http://localhost:3010/api/runInfo | jq .notReadyCountries',
    });
  }

  // Synthesis gate
  if (runInfo.synthesisGate && !runInfo.synthesisGate.pass) {
    actions.push({
      issue: `Synthesis gate failed (score: ${runInfo.synthesisGate.overall || 'N/A'})`,
      severity: 'high',
      command: 'Check synthesis prompts in research-engine.js',
    });
  }

  // PPT data gate
  if (runInfo.pptDataGateFailures && runInfo.pptDataGateFailures.length > 0) {
    actions.push({
      issue: `PPT data gate failures: ${runInfo.pptDataGateFailures.length}`,
      severity: 'high',
      command: 'curl -s http://localhost:3010/api/runInfo | jq .pptDataGateFailures',
    });
  }

  // Budget gate
  if (runInfo.contentSizeCheck) {
    for (const [country, bg] of Object.entries(runInfo.contentSizeCheck)) {
      if (bg.risk === 'high') {
        actions.push({
          issue: `Budget gate high risk for ${country}`,
          severity: 'medium',
          command: `curl -s http://localhost:3010/api/runInfo | jq '.contentSizeCheck["${country}"]'`,
        });
      }
    }
  }

  // PPT metrics
  if (runInfo.ppt) {
    if (runInfo.ppt.templateCoverage != null && runInfo.ppt.templateCoverage < 95) {
      actions.push({
        issue: `Low template coverage: ${runInfo.ppt.templateCoverage}%`,
        severity: 'medium',
        command: 'node build-template-patterns.js',
      });
    }
    if (runInfo.ppt.slideRenderFailureCount > 0) {
      actions.push({
        issue: `${runInfo.ppt.slideRenderFailureCount} slide build failures`,
        severity: 'high',
        command: 'Check deck-builder-single.js build logic',
      });
    }
  }

  const summary = actions.length === 0
    ? 'No issues detected — pipeline looks healthy'
    : `${actions.length} action(s) recommended (${actions.filter((a) => a.severity === 'critical').length} critical)`;

  return { actions, summary };
}

// ============ EXECUTE RUNBOOK ============

/**
 * Runbook decision tree execution helper.
 * Given an error code, returns the step-by-step fix sequence.
 * @param {string} errorCode - Error code key (e.g., 'PPT_STRUCTURAL_VALIDATION', 'OOM')
 * @returns {{ found: boolean, code: string, title: string|null, severity: string|null, steps: Array|null, availableCodes: string[] }}
 */
function executeRunbook(errorCode) {
  const availableCodes = Object.keys(ERROR_CODE_RUNBOOKS);

  if (!errorCode || !ERROR_CODE_RUNBOOKS[errorCode]) {
    return { found: false, code: errorCode || null, title: null, severity: null, steps: null, availableCodes };
  }

  const rb = ERROR_CODE_RUNBOOKS[errorCode];
  return {
    found: true,
    code: rb.code,
    title: rb.title,
    severity: rb.severity,
    steps: rb.steps.slice(),
    availableCodes,
  };
}

// ============ GET PROFILE ============

/**
 * Returns config for an operational profile.
 * @param {string} name - 'fast-check' | 'release-check' | 'deep-audit'
 * @returns {object|null}
 */
function getProfile(name) {
  return PROFILES[name] || null;
}

// ============ GENERATE COMMAND COOKBOOK ============

/**
 * Auto-generate command list by scanning *.js files for CLI usage patterns.
 * Reads the first 20 lines of each JS file looking for Usage/CLI comments.
 * @returns {{ generated: Array<{file: string, commands: string[]}>, timestamp: string }}
 */
function generateCommandCookbook() {
  const fs = require('fs');
  const generated = [];

  let jsFiles;
  try {
    jsFiles = fs.readdirSync(SERVICE_DIR).filter((f) => f.endsWith('.js') && !f.includes('.test.'));
  } catch {
    return { generated: [], timestamp: new Date().toISOString() };
  }

  for (const file of jsFiles) {
    const filePath = path.join(SERVICE_DIR, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').slice(0, 30);
      const commands = [];

      for (const line of lines) {
        // Match lines like: //   node ops-runbook.js --validate-local
        const cliMatch = line.match(/\/\/\s+(node\s+\S+\.js\s+.+)/);
        if (cliMatch) {
          commands.push(cliMatch[1].trim());
        }
      }

      // Also check for require.main === module pattern
      if (content.includes('require.main === module')) {
        // Extract CLI flags from process.argv checks
        const flagMatches = content.match(/['"]--[\w-]+['"]/g);
        if (flagMatches) {
          const uniqueFlags = [...new Set(flagMatches.map((f) => f.replace(/['"]/g, '')))];
          for (const flag of uniqueFlags) {
            if (flag !== '--help') {
              const exists = commands.some((c) => c.includes(flag));
              if (!exists) {
                commands.push(`node ${file} ${flag}`);
              }
            }
          }
        }
      }

      if (commands.length > 0) {
        generated.push({ file, commands });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return { generated, timestamp: new Date().toISOString() };
}

// ============ SAFE TO RUN VERDICT ============

/**
 * Clear yes/no verdict: "Is it safe to run the paid pipeline?"
 * @param {Array} checks - Array of { name, pass, output } from runLocalReadiness or similar
 * @returns {{ safe: boolean, verdict: string, evidence: Array<{check: string, status: string, detail: string}>, blockers: string[] }}
 */
function getSafeToRunVerdict(checks) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return {
      safe: false,
      verdict: 'UNSAFE: No checks provided — cannot determine safety',
      evidence: [],
      blockers: ['No checks were provided'],
    };
  }

  const evidence = checks.map((c) => ({
    check: c.name,
    status: c.pass ? 'PASS' : 'FAIL',
    detail: c.output || '',
  }));

  // Critical checks that MUST pass
  const criticalChecks = ['env-vars', 'key-files', 'module-syntax'];
  const blockers = [];

  for (const c of checks) {
    if (criticalChecks.includes(c.name) && !c.pass) {
      blockers.push(`${c.name}: ${c.output || 'failed'}`);
    }
  }

  // Also block if more than half of all checks fail
  const failCount = checks.filter((c) => !c.pass).length;
  if (failCount > checks.length / 2) {
    blockers.push(`${failCount}/${checks.length} checks failed — majority failure`);
  }

  const safe = blockers.length === 0;
  const verdict = safe
    ? `SAFE: All critical checks passed (${checks.length} total checks, ${failCount} warnings)`
    : `UNSAFE: ${blockers.length} blocker(s) — ${blockers[0]}`;

  return { safe, verdict, evidence, blockers };
}

// ============ CLI ============

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = args[0] || '--help';

  if (flag === '--validate-local') {
    const result = validateLocal();
    console.log('\n=== LOCAL VALIDATION ===\n');
    for (const step of result.steps) {
      const icon = step.passed ? 'PASS' : 'FAIL';
      console.log(`[${icon}] ${step.name}: ${step.output}`);
      console.log(`       Reproduce: ${step.command}`);
    }
    console.log(`\nOverall: ${result.passed ? 'PASS' : 'FAIL'}`);
    process.exit(result.passed ? 0 : 1);
  }

  if (flag === '--triage') {
    const msg = args.slice(1).join(' ');
    if (!msg) {
      console.error('Usage: node ops-runbook.js --triage "error message"');
      process.exit(1);
    }
    const result = triageError(msg);
    console.log('\n=== ERROR TRIAGE ===\n');
    if (result.matched) {
      console.log(`Root cause: ${result.rootCause}`);
      console.log('Fix steps:');
      result.fix.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    } else {
      console.log('No known pattern matched. Generic steps:');
      result.fix.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    }
    process.exit(0);
  }

  if (flag === '--playbook') {
    const name = args[1];
    const result = getPlaybook(name);
    console.log('\n=== PLAYBOOK ===\n');
    if (result.found) {
      console.log(`${result.title}\n`);
      result.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    } else {
      console.log('Available playbooks:');
      result.availablePlaybooks.forEach((p) => console.log(`  - ${p}: ${PLAYBOOKS[p].title}`));
    }
    process.exit(0);
  }

  if (flag === '--commands') {
    const category = args[1];
    const cmds = getCommands(category);
    console.log('\n=== COMMAND COOKBOOK ===\n');
    for (const [cat, entries] of Object.entries(cmds)) {
      console.log(`${cat}:`);
      for (const entry of entries) {
        console.log(`  $ ${entry.cmd}`);
        console.log(`    ${entry.desc}\n`);
      }
    }
    process.exit(0);
  }

  console.log('Usage:');
  console.log('  node ops-runbook.js --validate-local    Run local check sequence');
  console.log('  node ops-runbook.js --triage "msg"      Triage an error message');
  console.log('  node ops-runbook.js --playbook <name>   Show a playbook');
  console.log('  node ops-runbook.js --commands [cat]    Show command cookbook');
  process.exit(0);
}

// ============ EXPORTS ============

module.exports = {
  validateLocal,
  triageError,
  getPlaybook,
  getCommands,
  runLocalReadiness,
  recommendActions,
  executeRunbook,
  getProfile,
  generateCommandCookbook,
  getSafeToRunVerdict,
  ERROR_PATTERNS,
  PLAYBOOKS,
  COMMANDS,
  ERROR_CODE_RUNBOOKS,
  PROFILES,
};
