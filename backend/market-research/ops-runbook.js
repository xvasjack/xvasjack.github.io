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
    pattern: /PPT structural validation failed/i,
    rootCause: 'Generated PPTX file is malformed or truncated.',
    fix: [
      'Run the integrity pipeline: node -e "require(\'./pptx-validator\').validatePPTX(require(\'fs\').readFileSync(\'output.pptx\')).then(r => console.log(JSON.stringify(r, null, 2)))"',
      'Check ppt-single-country.js for recent template changes.',
      'Run regression tests: npm test -- --testPathPattern=market-research',
    ],
  },
  {
    pattern: /PPT rendering quality failed/i,
    rootCause: 'Too many slide blocks failed to render.',
    fix: [
      'Check pptMetrics in /api/diagnostics for slideRenderFailureCount.',
      'Look for templateCoverage < 95% — indicates template pattern mismatch.',
      'Review template-patterns.json for missing or changed patterns.',
    ],
  },
  {
    pattern: /PPT formatting fidelity failed/i,
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
      'Check /api/diagnostics for notReadyCountries details.',
      'Look at effectiveScore, coherenceScore, finalReviewCritical, finalReviewMajor.',
      'If coherence < 70, synthesis prompts may need tuning in research-orchestrator.js.',
      'If critical issues > 1, check finalReview.issues for specific problems.',
    ],
  },
  {
    pattern: /Synthesis quality too low/i,
    rootCause: 'Synthesis pass scored below acceptable threshold.',
    fix: [
      'Check /api/diagnostics for synthesisGate scores.',
      'Increase maxTokens in scope or GEMINI model config.',
      'Check if country rawData has enough content for synthesis.',
    ],
  },
  {
    pattern: /PPT data gate failed/i,
    rootCause: 'Country analysis sections have empty or invalid data for PPT rendering.',
    fix: [
      'Check /api/diagnostics for pptDataGateFailures.',
      'Look for nonRenderableGroups, emptyBlocks, chartIssues.',
      'Check synthesis output for empty sections — may need gap fill.',
    ],
  },
  {
    pattern: /Pre-render structure gate failed/i,
    rootCause: 'Country analysis has non-canonical or missing required sections.',
    fix: [
      'Check /api/diagnostics for preRenderStructureIssues.',
      'Verify synthesis output matches canonical section keys in server.js.',
      'Check transient-key-sanitizer.js if legitimate keys are being removed.',
    ],
  },
  {
    pattern: /Budget gate/i,
    rootCause: 'Fields or tables exceed size budgets — risk of PPT overflow.',
    fix: [
      'Check /api/diagnostics for budgetGate details per country.',
      'Review FIELD_CHAR_BUDGETS in budget-gate.js.',
      'If compaction is too aggressive, increase limits in budget-gate.js.',
    ],
  },
  {
    pattern: /Server PPT relationship integrity failed/i,
    rootCause: 'PPTX internal references are broken — missing relationship targets.',
    fix: [
      'Run integrity pipeline manually on the output buffer.',
      'Check pptx-validator.js scanRelationshipTargets for the specific broken refs.',
      'This often happens when slides are cloned incorrectly in ppt-single-country.js.',
    ],
  },
  {
    pattern: /Server PPT package consistency failed/i,
    rootCause: 'PPTX ZIP structure has duplicates, missing parts, or content-type mismatches.',
    fix: [
      'Run: node -e "require(\'./pptx-validator\').readPPTX(require(\'fs\').readFileSync(\'output.pptx\')).then(({zip}) => require(\'./pptx-validator\').scanPackageConsistency(zip).then(r => console.log(JSON.stringify(r, null, 2))))"',
      'Check for duplicate relationship IDs or slide IDs.',
      'Review template-clone-postprocess.js if slide cloning is involved.',
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
      'Run validator: node -e "require(\'./pptx-validator\').validatePPTX(require(\'fs\').readFileSync(\'<file>\')).then(r => console.log(JSON.stringify(r, null, 2)))"',
      'Check for: duplicate IDs, broken relationships, missing content types',
      'Run repair: node repair-pptx.js <file>',
      'If repair fails, check ppt-single-country.js slide generation',
    ],
  },
  'quality-gate-failing': {
    title: 'Quality gate failing',
    steps: [
      'Check /api/diagnostics for the failing gate',
      'Research gate: look at researchTopicChars — any topic < 200 chars is likely thin',
      'Synthesis gate: check synthesisGate.overall score and failures array',
      'PPT data gate: check pptDataGateFailures for empty blocks',
      'Readiness gate: check notReadyCountries for effectiveScore and coherenceScore',
      'If score is borderline (50-70), consider SOFT_READINESS_GATE=true to proceed with warnings',
    ],
  },
  'budget-gate-compacting': {
    title: 'Budget gate compacting too much',
    steps: [
      'Check /api/diagnostics budgetGate for each country',
      'Look at compacted field count and risk level',
      'If risk=high with many compactions, increase FIELD_CHAR_BUDGETS in budget-gate.js',
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
      'Check /api/diagnostics for total run time',
      'Check perf-profiler.getStageMetrics() for per-stage breakdown',
      'Typical bottlenecks: countryResearch (API calls), synthesis (LLM), pptGeneration (XML)',
      'If countryResearch is slow: check Gemini API latency, consider increasing batch size',
      'If synthesis is slow: check maxTokens setting, consider gemini-3-flash for speed',
      'If pptGeneration is slow: check payload size — budget gate should have caught oversize',
    ],
  },
  'email-not-arriving': {
    title: 'Results email not arriving',
    steps: [
      'Check server logs for "Failed to send" or SendGrid errors',
      'Verify SENDGRID_API_KEY is valid',
      'Verify SENDER_EMAIL is set and verified in SendGrid',
      'Check spam/junk folder',
      'Check /api/diagnostics — if stage=error, the pipeline failed before email',
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
      cmd: 'curl -s http://localhost:3010/api/diagnostics | jq .',
      desc: 'Get last run diagnostics',
    },
  ],
  Debugging: [
    {
      cmd: 'curl -s http://localhost:3010/api/diagnostics | jq .stage',
      desc: 'Check which stage failed',
    },
    {
      cmd: 'curl -s http://localhost:3010/api/diagnostics | jq .error',
      desc: 'Get error message',
    },
    {
      cmd: 'curl -s http://localhost:3010/api/diagnostics | jq .notReadyCountries',
      desc: 'Check readiness gate details',
    },
    {
      cmd: 'curl -s http://localhost:3010/api/diagnostics | jq .budgetGate',
      desc: 'Check budget gate results',
    },
    {
      cmd: 'curl -s http://localhost:3010/api/diagnostics | jq .ppt',
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
 * Runs a local validation sequence:
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
    'budget-gate.js',
    'quality-gates.js',
    'pptx-validator.js',
    'research-orchestrator.js',
    'ai-clients.js',
    'ppt-single-country.js',
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
  const modulesToCheck = ['./budget-gate', './quality-gates', './perf-profiler'];
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
    // Server not running — that's OK for local validation
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
      'Check /api/diagnostics for full error context.',
      'Search server logs for the error message.',
      'Check the stage field in diagnostics to narrow the failure point.',
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
  console.log('  node ops-runbook.js --validate-local    Run local validation sequence');
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
  ERROR_PATTERNS,
  PLAYBOOKS,
  COMMANDS,
};
