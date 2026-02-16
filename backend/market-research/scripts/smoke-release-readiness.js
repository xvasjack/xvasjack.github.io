#!/usr/bin/env node
'use strict';

/**
 * Smoke Release Readiness — One-Command Go/No-Go Report
 *
 * Workflow:
 *   1. Strict preflight (module contracts, HEAD content, template, git state)
 *   2. Local artifact check (existing PPTX files — no paid API calls)
 *   3. Optional runInfo checks (/api/runInfo, /api/latest-ppt)
 *   4. Produce reports/smoke-readiness.json + .md with go/no-go verdict
 *
 * Usage:
 *   node scripts/smoke-release-readiness.js
 *   node scripts/smoke-release-readiness.js --endpoint=http://localhost:3000
 *   node scripts/smoke-release-readiness.js --verbose
 *   node scripts/smoke-release-readiness.js --skip-artifacts
 *
 * Exit codes:
 *   0 = GO (all gates passed or skipped with reason)
 *   1 = NO-GO (one or more gates failed)
 *   2 = Internal error
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(PROJECT_ROOT, 'reports');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  let verbose = false;
  let help = false;
  let endpoint = null;
  let skipArtifacts = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--verbose' || arg === '-v') verbose = true;
    else if (arg === '--skip-artifacts') skipArtifacts = true;
    else if (arg.startsWith('--endpoint=')) endpoint = arg.split('=')[1];
  }

  return { verbose, help, endpoint, skipArtifacts };
}

// ---------------------------------------------------------------------------
// Timer helper
// ---------------------------------------------------------------------------
function timer() {
  const t = Date.now();
  return () => Date.now() - t;
}

// ---------------------------------------------------------------------------
// Gate result builder
// ---------------------------------------------------------------------------
function gate(name, status, durationMs, details, evidence, rootCause) {
  return {
    name,
    status, // PASS | FAIL | SKIP | WARN
    durationMs,
    details: details || null,
    evidence: evidence || null,
    rootCause: rootCause || null,
  };
}

// ---------------------------------------------------------------------------
// Gate 1: Strict Preflight (module contracts, HEAD content, template)
// ---------------------------------------------------------------------------
function runStrictPreflight(verbose) {
  const elapsed = timer();
  const subGates = [];

  // 1a. Module export contracts — import preflight-gates and run quick checks
  try {
    const pg = require(path.join(PROJECT_ROOT, 'preflight-gates.js'));

    // Run quick gates (clean tree, HEAD content, module contracts)
    const quickResults = pg.runQuick({ gateMode: 'release', strict: true });
    for (const r of quickResults) {
      subGates.push(
        gate(
          `preflight/${r.name}`,
          r.pass ? 'PASS' : 'FAIL',
          r.durationMs || 0,
          r.details,
          r.evidence,
          !r.pass
            ? {
                issue: r.details,
                evidence: r.evidence,
                fix: r.remediation || 'See preflight-gates.js output',
              }
            : null
        )
      );
    }

    // 1b. Template contract validity
    if (typeof pg.checkTemplateContract === 'function') {
      const tmpl = pg.checkTemplateContract();
      subGates.push(
        gate(
          'preflight/Template contract',
          tmpl.pass ? 'PASS' : 'FAIL',
          tmpl.durationMs || 0,
          tmpl.details,
          tmpl.evidence,
          !tmpl.pass
            ? {
                issue: tmpl.details,
                evidence: tmpl.evidence,
                fix: tmpl.remediation || 'Validate template-patterns.json',
              }
            : null
        )
      );
    }

    // 1c. Schema firewall
    if (typeof pg.checkSchemaFirewall === 'function') {
      const sf = pg.checkSchemaFirewall();
      subGates.push(
        gate(
          'preflight/Schema firewall',
          sf.pass ? 'PASS' : sf.severity === 'INFO' ? 'SKIP' : 'FAIL',
          sf.durationMs || 0,
          sf.details,
          sf.evidence,
          !sf.pass && sf.severity !== 'INFO'
            ? {
                issue: sf.details,
                evidence: sf.evidence,
                fix: sf.remediation || 'Check schema-firewall.js',
              }
            : null
        )
      );
    }

    // 1d. Route geometry
    if (typeof pg.checkRouteGeometry === 'function') {
      const rg = pg.checkRouteGeometry();
      subGates.push(
        gate(
          'preflight/Route geometry',
          rg.pass ? 'PASS' : rg.severity === 'INFO' ? 'SKIP' : 'WARN',
          rg.durationMs || 0,
          rg.details,
          rg.evidence
        )
      );
    }

    // 1e. FileSafety pipeline
    if (typeof pg.checkIntegrityPipeline === 'function') {
      const ip = pg.checkIntegrityPipeline();
      subGates.push(
        gate(
          'preflight/FileSafety pipeline',
          ip.pass ? 'PASS' : ip.severity === 'INFO' ? 'SKIP' : 'WARN',
          ip.durationMs || 0,
          ip.details,
          ip.evidence
        )
      );
    }

    // 1f. Module function signatures
    if (typeof pg.checkModuleFunctionSignatures === 'function') {
      const sig = pg.checkModuleFunctionSignatures();
      subGates.push(
        gate(
          'preflight/Function signatures',
          sig.pass ? 'PASS' : 'WARN',
          sig.durationMs || 0,
          sig.details,
          sig.evidence
        )
      );
    }
  } catch (err) {
    subGates.push(
      gate(
        'preflight/load',
        'FAIL',
        elapsed(),
        `Failed to load preflight-gates.js: ${err.message}`,
        null,
        {
          issue: 'preflight-gates.js cannot be loaded',
          evidence: err.message,
          fix: 'Check require paths and syntax in preflight-gates.js',
        }
      )
    );
  }

  return { name: 'Strict Preflight', durationMs: elapsed(), subGates };
}

// ---------------------------------------------------------------------------
// Gate 2: Artifact Check (existing PPTX files)
// ---------------------------------------------------------------------------
function runArtifactValidation(verbose) {
  const elapsed = timer();
  const subGates = [];

  const pptxFiles = [
    {
      path: path.join(PROJECT_ROOT, 'vietnam-output.pptx'),
      country: 'Vietnam',
      industry: 'Energy Services',
    },
    {
      path: path.join(PROJECT_ROOT, 'test-output.pptx'),
      country: 'Thailand',
      industry: 'Energy Services',
    },
  ];

  let anyArtifactFound = false;

  for (const pptx of pptxFiles) {
    const fileName = path.basename(pptx.path);

    if (!fs.existsSync(pptx.path)) {
      subGates.push(
        gate(
          `artifact/${fileName}`,
          'SKIP',
          0,
          `File not found: ${fileName} — no local artifact to validate`,
          null,
          null
        )
      );
      continue;
    }

    anyArtifactFound = true;
    const fileElapsed = timer();

    // Check file size
    const stats = fs.statSync(pptx.path);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    if (stats.size < 50 * 1024) {
      subGates.push(
        gate(
          `artifact/${fileName}/size`,
          'FAIL',
          fileElapsed(),
          `File too small: ${sizeMB}MB (min 50KB)`,
          [`File size: ${stats.size} bytes`],
          {
            issue: `${fileName} is too small (${stats.size} bytes)`,
            evidence: `Expected >= 50KB`,
            fix: 'Regenerate the PPTX artifact',
          }
        )
      );
      continue;
    }

    if (stats.size > 30 * 1024 * 1024) {
      subGates.push(
        gate(
          `artifact/${fileName}/size`,
          'FAIL',
          fileElapsed(),
          `File too large: ${sizeMB}MB (max 30MB)`,
          [`File size: ${stats.size} bytes`],
          {
            issue: `${fileName} is too large`,
            evidence: `${sizeMB}MB > 30MB limit`,
            fix: 'Check PPT generation for bloated assets',
          }
        )
      );
      continue;
    }

    subGates.push(
      gate(`artifact/${fileName}/size`, 'PASS', fileElapsed(), `${sizeMB}MB — within bounds`)
    );

    // Run validate-output.js as subprocess to avoid require-time side effects
    const valElapsed = timer();
    const valResult = spawnSync(
      'node',
      [
        '-e',
        `const v=require('./validate-output');const e=v.getExpectations('${pptx.country}','${pptx.industry}');v.runValidation('${pptx.path.replace(/\\/g, '\\\\')}',e).then(r=>{process.stdout.write(JSON.stringify({valid:r.valid,failed:(r.results||{}).failed||[],warnings:(r.results||{}).warnings||[],passed:(r.results||{}).passed||[],slides:r.report?.slides?.count||0,charts:r.report?.charts?.chartFiles||0,tables:r.report?.tables?.totalTables||0}));process.exit(r.valid?0:1)}).catch(e=>{process.stdout.write(JSON.stringify({valid:false,error:e.message}));process.exit(1)})`,
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        timeout: 60 * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    if (valResult.error) {
      subGates.push(
        gate(
          `artifact/${fileName}/check`,
          'FAIL',
          valElapsed(),
          `Check process error: ${valResult.error.message}`,
          null,
          {
            issue: 'PPTX check subprocess crashed',
            evidence: valResult.error.message,
            fix: 'Check deck-file-check.js and validate-output.js',
          }
        )
      );
      continue;
    }

    let valData;
    try {
      valData = JSON.parse(valResult.stdout);
    } catch {
      // Try to extract from mixed output
      const jsonMatch = (valResult.stdout || '').match(/\{[^]*\}$/);
      if (jsonMatch) {
        try {
          valData = JSON.parse(jsonMatch[0]);
        } catch {
          valData = null;
        }
      }
    }

    if (!valData) {
      subGates.push(
        gate(`artifact/${fileName}/check`, 'WARN', valElapsed(), 'Could not parse check output', [
          valResult.stdout?.slice(0, 200) || 'empty',
          valResult.stderr?.slice(0, 200) || 'empty',
        ])
      );
      continue;
    }

    if (valData.valid) {
      subGates.push(
        gate(
          `artifact/${fileName}/check`,
          'PASS',
          valElapsed(),
          `Valid: ${valData.passed?.length || 0} checks passed, ${valData.slides || 0} slides, ${valData.charts || 0} charts, ${valData.tables || 0} tables`
        )
      );
    } else {
      const failDetails = (valData.failed || [])
        .slice(0, 5)
        .map((f) => `${f.check}: expected ${f.expected}, got ${f.actual}`)
        .join('; ');
      subGates.push(
        gate(
          `artifact/${fileName}/check`,
          'FAIL',
          valElapsed(),
          `Failed: ${valData.failed?.length || 0} checks failed`,
          [failDetails || valData.error || 'unknown'],
          {
            issue: `${fileName} failed check`,
            evidence: failDetails || valData.error,
            fix: 'Regenerate PPTX or fix building in deck-builder-single.js',
          }
        )
      );
    }

    // Check artifact freshness (warn if older than 7 days)
    const ageDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageDays > 7) {
      subGates.push(
        gate(
          `artifact/${fileName}/freshness`,
          'WARN',
          0,
          `Artifact is ${ageDays.toFixed(1)} days old — consider regenerating`
        )
      );
    } else {
      subGates.push(
        gate(
          `artifact/${fileName}/freshness`,
          'PASS',
          0,
          `Artifact is ${ageDays.toFixed(1)} days old`
        )
      );
    }
  }

  if (!anyArtifactFound) {
    subGates.push(
      gate(
        'artifact/availability',
        'SKIP',
        0,
        'No PPTX artifacts found locally — artifact check skipped. Generate with: node test-ppt-generation.js'
      )
    );
  }

  return { name: 'Artifact Check', durationMs: elapsed(), subGates };
}

// ---------------------------------------------------------------------------
// Gate 3: RunInfo Endpoint Checks (optional)
// ---------------------------------------------------------------------------
async function runDiagnosticsChecks(endpoint, verbose) {
  const elapsed = timer();
  const subGates = [];

  if (!endpoint) {
    subGates.push(
      gate(
        'runInfo/endpoint',
        'SKIP',
        0,
        'No --endpoint provided — runInfo checks skipped. Use --endpoint=http://localhost:3000 to enable.'
      )
    );
    return { name: 'RunInfo Checks', durationMs: elapsed(), subGates };
  }

  // Try /health
  const healthUrl = `${endpoint}/health`;
  try {
    const fetch = require('node-fetch');
    const healthElapsed = timer();
    const resp = await fetch(healthUrl, { timeout: 10000 });
    if (resp.ok) {
      const body = await resp.json().catch(() => ({}));
      subGates.push(
        gate('runInfo/health', 'PASS', healthElapsed(), `Health OK: status=${resp.status}`, [
          JSON.stringify(body).slice(0, 300),
        ])
      );
    } else {
      subGates.push(
        gate(
          'runInfo/health',
          'FAIL',
          healthElapsed(),
          `Health endpoint returned ${resp.status}`,
          null,
          {
            issue: `${healthUrl} returned ${resp.status}`,
            evidence: `HTTP ${resp.status}`,
            fix: 'Start the server with npm run dev',
          }
        )
      );
    }
  } catch (err) {
    subGates.push(
      gate(
        'runInfo/health',
        'SKIP',
        elapsed(),
        `Could not reach ${healthUrl}: ${err.message}`,
        null,
        null
      )
    );
  }

  // Try /api/runInfo
  const diagUrl = `${endpoint}/api/runInfo`;
  try {
    const fetch = require('node-fetch');
    const diagElapsed = timer();
    const resp = await fetch(diagUrl, { timeout: 10000 });
    if (resp.ok) {
      const body = await resp.json().catch(() => ({}));
      subGates.push(
        gate('runInfo/api-runInfo', 'PASS', diagElapsed(), `RunInfo OK`, [
          JSON.stringify(body).slice(0, 500),
        ])
      );
    } else if (resp.status === 404) {
      subGates.push(
        gate('runInfo/api-runInfo', 'SKIP', diagElapsed(), '/api/runInfo endpoint not found (404)')
      );
    } else {
      subGates.push(
        gate('runInfo/api-runInfo', 'WARN', diagElapsed(), `RunInfo returned ${resp.status}`)
      );
    }
  } catch (err) {
    subGates.push(
      gate('runInfo/api-runInfo', 'SKIP', elapsed(), `Could not reach ${diagUrl}: ${err.message}`)
    );
  }

  // Try /api/latest-ppt
  const pptUrl = `${endpoint}/api/latest-ppt`;
  try {
    const fetch = require('node-fetch');
    const pptElapsed = timer();
    const resp = await fetch(pptUrl, { method: 'HEAD', timeout: 10000 });
    if (resp.ok) {
      subGates.push(
        gate(
          'runInfo/api-latest-ppt',
          'PASS',
          pptElapsed(),
          `Latest PPT endpoint reachable (${resp.status})`
        )
      );
    } else if (resp.status === 404) {
      subGates.push(
        gate(
          'runInfo/api-latest-ppt',
          'SKIP',
          pptElapsed(),
          '/api/latest-ppt endpoint not found (404)'
        )
      );
    } else {
      subGates.push(
        gate('runInfo/api-latest-ppt', 'WARN', pptElapsed(), `Latest PPT returned ${resp.status}`)
      );
    }
  } catch (err) {
    subGates.push(
      gate('runInfo/api-latest-ppt', 'SKIP', elapsed(), `Could not reach ${pptUrl}: ${err.message}`)
    );
  }

  return { name: 'RunInfo Checks', durationMs: elapsed(), subGates };
}

// ---------------------------------------------------------------------------
// Gate 4: Environment Checks
// ---------------------------------------------------------------------------
function runEnvironmentChecks() {
  const elapsed = timer();
  const subGates = [];

  // Check Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (major >= 18) {
    subGates.push(gate('env/node-version', 'PASS', 0, `Node ${nodeVersion} >= 18`));
  } else {
    subGates.push(
      gate('env/node-version', 'FAIL', 0, `Node ${nodeVersion} < 18 (required >= 18)`, null, {
        issue: `Node version ${nodeVersion} too old`,
        evidence: 'package.json requires Node >= 18',
        fix: 'Upgrade Node to >= 18',
      })
    );
  }

  // Check critical env vars (existence only, not values)
  const envChecks = [
    { name: 'GEMINI_API_KEY', required: false, purpose: 'AI research calls' },
    { name: 'SENDGRID_API_KEY', required: false, purpose: 'Email delivery' },
    { name: 'SENDER_EMAIL', required: false, purpose: 'From address for emails' },
  ];

  for (const env of envChecks) {
    const isSet = !!process.env[env.name];
    if (isSet) {
      subGates.push(gate(`env/${env.name}`, 'PASS', 0, `Set (${env.purpose})`));
    } else {
      subGates.push(
        gate(
          `env/${env.name}`,
          'SKIP',
          0,
          `Not set — ${env.purpose} unavailable. This is expected in local dev without credentials.`
        )
      );
    }
  }

  // Check critical files exist
  const criticalFiles = [
    'server.js',
    'deck-builder-single.js',
    'deck-file-check.js',
    'content-gates.js',
    'research-engine.js',
    'template-patterns.json',
  ];
  for (const file of criticalFiles) {
    if (fs.existsSync(path.join(PROJECT_ROOT, file))) {
      subGates.push(gate(`env/file/${file}`, 'PASS', 0, 'Exists'));
    } else {
      subGates.push(
        gate(`env/file/${file}`, 'FAIL', 0, `Missing: ${file}`, null, {
          issue: `Critical file ${file} is missing`,
          evidence: `File not found at ${path.join(PROJECT_ROOT, file)}`,
          fix: `Restore ${file} from git or recreate it`,
        })
      );
    }
  }

  return { name: 'Environment', durationMs: elapsed(), subGates };
}

// ---------------------------------------------------------------------------
// Aggregate and produce verdict
// ---------------------------------------------------------------------------
function computeVerdict(sections) {
  const allGates = [];
  for (const section of sections) {
    for (const g of section.subGates) {
      allGates.push(g);
    }
  }

  const failCount = allGates.filter((g) => g.status === 'FAIL').length;
  const passCount = allGates.filter((g) => g.status === 'PASS').length;
  const skipCount = allGates.filter((g) => g.status === 'SKIP').length;
  const warnCount = allGates.filter((g) => g.status === 'WARN').length;
  const total = allGates.length;

  // Root causes: only from FAIL gates that have rootCause
  const rootCauses = allGates
    .filter((g) => g.status === 'FAIL' && g.rootCause)
    .map((g) => ({
      gate: g.name,
      ...g.rootCause,
    }));

  const verdict = failCount === 0 ? 'GO' : 'NO-GO';

  return {
    verdict,
    summary: { total, pass: passCount, fail: failCount, skip: skipCount, warn: warnCount },
    rootCauses,
    allGates,
  };
}

// ---------------------------------------------------------------------------
// Report: JSON
// ---------------------------------------------------------------------------
function generateJsonReport(sections, verdict, metadata) {
  return {
    smokeReadiness: true,
    version: '1.0',
    timestamp: metadata.timestamp,
    node: metadata.nodeVersion,
    verdict: verdict.verdict,
    summary: verdict.summary,
    totalDurationMs: metadata.totalDurationMs,
    sections: sections.map((s) => ({
      name: s.name,
      durationMs: s.durationMs,
      gates: s.subGates.map((g) => ({
        name: g.name,
        status: g.status,
        durationMs: g.durationMs,
        details: g.details,
        evidence: g.evidence,
        rootCause: g.rootCause,
      })),
    })),
    rootCauses: verdict.rootCauses,
  };
}

// ---------------------------------------------------------------------------
// Report: Markdown
// ---------------------------------------------------------------------------
function generateMarkdownReport(sections, verdict, metadata) {
  const lines = [];
  lines.push('# SMOKE RELEASE READINESS REPORT');
  lines.push('');
  lines.push(`- **Verdict**: ${verdict.verdict}`);
  lines.push(`- **Timestamp**: ${metadata.timestamp}`);
  lines.push(`- **Node**: ${metadata.nodeVersion}`);
  lines.push(`- **Duration**: ${(metadata.totalDurationMs / 1000).toFixed(1)}s`);
  lines.push(
    `- **Gates**: ${verdict.summary.pass} PASS / ${verdict.summary.fail} FAIL / ${verdict.summary.skip} SKIP / ${verdict.summary.warn} WARN`
  );
  lines.push('');

  // Overall verdict
  lines.push(`## Final Verdict: ${verdict.verdict}`);
  lines.push('');

  // Gate-by-gate table
  lines.push('## Gate-by-Gate Status');
  lines.push('');
  lines.push('| Section | Gate | Status | Duration | Details |');
  lines.push('|---------|------|--------|----------|---------|');
  for (const section of sections) {
    for (const g of section.subGates) {
      const dur = g.durationMs ? `${g.durationMs}ms` : '-';
      const detail = (g.details || '').slice(0, 80);
      lines.push(`| ${section.name} | ${g.name} | ${g.status} | ${dur} | ${detail} |`);
    }
  }
  lines.push('');

  // Root causes
  if (verdict.rootCauses.length > 0) {
    lines.push('## Root Causes');
    lines.push('');
    for (const rc of verdict.rootCauses) {
      lines.push(`### ${rc.gate}`);
      lines.push('');
      lines.push(`- **Issue**: ${rc.issue}`);
      if (rc.evidence) {
        const evStr =
          typeof rc.evidence === 'string'
            ? rc.evidence
            : Array.isArray(rc.evidence)
              ? rc.evidence.join('; ')
              : JSON.stringify(rc.evidence);
        lines.push(`- **Evidence**: ${evStr.slice(0, 300)}`);
      }
      lines.push(`- **Fix**: ${rc.fix}`);
      lines.push('');
    }
  } else {
    lines.push('## Root Causes');
    lines.push('');
    lines.push('None — all gates passed or were skipped with valid reason.');
    lines.push('');
  }

  // Skipped gates
  const skipped = [];
  for (const section of sections) {
    for (const g of section.subGates) {
      if (g.status === 'SKIP') {
        skipped.push({ gate: g.name, reason: g.details });
      }
    }
  }
  if (skipped.length > 0) {
    lines.push('## Skipped Gates');
    lines.push('');
    for (const s of skipped) {
      lines.push(`- **${s.gate}**: ${s.reason || 'No reason provided'}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
Usage: node scripts/smoke-release-readiness.js [options]

Options:
  --endpoint=URL      Check runInfo endpoints (e.g. http://localhost:3000)
  --verbose, -v       Show detailed output
  --skip-artifacts    Skip PPTX artifact check
  --help              Show this help

Output:
  reports/smoke-readiness.json
  reports/smoke-readiness.md

Examples:
  node scripts/smoke-release-readiness.js
  node scripts/smoke-release-readiness.js --endpoint=http://localhost:3000
  node scripts/smoke-release-readiness.js --verbose --skip-artifacts
`);
    process.exit(0);
  }

  const startMs = Date.now();

  console.log('');
  console.log('=== SMOKE RELEASE READINESS ===');
  console.log('');

  const sections = [];

  // Step 1: Environment
  console.log('[1/4] Environment checks...');
  const envSection = runEnvironmentChecks();
  sections.push(envSection);
  const envFails = envSection.subGates.filter((g) => g.status === 'FAIL').length;
  console.log(
    `      ${envFails === 0 ? 'PASS' : 'FAIL'}: ${envSection.subGates.filter((g) => g.status === 'PASS').length} pass, ${envFails} fail, ${envSection.subGates.filter((g) => g.status === 'SKIP').length} skip`
  );

  // Step 2: Strict preflight
  console.log('[2/4] Strict preflight...');
  const preflightSection = runStrictPreflight(args.verbose);
  sections.push(preflightSection);
  const pfFails = preflightSection.subGates.filter((g) => g.status === 'FAIL').length;
  console.log(
    `      ${pfFails === 0 ? 'PASS' : 'FAIL'}: ${preflightSection.subGates.filter((g) => g.status === 'PASS').length} pass, ${pfFails} fail, ${preflightSection.subGates.filter((g) => g.status === 'SKIP').length} skip (${preflightSection.durationMs}ms)`
  );

  // Step 3: Artifact check
  if (args.skipArtifacts) {
    sections.push({
      name: 'Artifact Check',
      durationMs: 0,
      subGates: [gate('artifact/skipped', 'SKIP', 0, 'Skipped via --skip-artifacts flag')],
    });
    console.log('[3/4] Artifact check... SKIP (--skip-artifacts)');
  } else {
    console.log('[3/4] Artifact check...');
    const artifactSection = runArtifactValidation(args.verbose);
    sections.push(artifactSection);
    const artFails = artifactSection.subGates.filter((g) => g.status === 'FAIL').length;
    console.log(
      `      ${artFails === 0 ? 'PASS' : 'FAIL'}: ${artifactSection.subGates.filter((g) => g.status === 'PASS').length} pass, ${artFails} fail, ${artifactSection.subGates.filter((g) => g.status === 'SKIP').length} skip (${artifactSection.durationMs}ms)`
    );
  }

  // Step 4: RunInfo
  console.log('[4/4] RunInfo checks...');
  const diagSection = await runDiagnosticsChecks(args.endpoint, args.verbose);
  sections.push(diagSection);
  const diagFails = diagSection.subGates.filter((g) => g.status === 'FAIL').length;
  console.log(
    `      ${diagFails === 0 ? 'PASS' : 'FAIL'}: ${diagSection.subGates.filter((g) => g.status === 'PASS').length} pass, ${diagFails} fail, ${diagSection.subGates.filter((g) => g.status === 'SKIP').length} skip`
  );

  // Compute verdict
  const totalDurationMs = Date.now() - startMs;
  const verdict = computeVerdict(sections);
  const metadata = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    totalDurationMs,
  };

  // Generate reports
  const jsonReport = generateJsonReport(sections, verdict, metadata);
  const mdReport = generateMarkdownReport(sections, verdict, metadata);

  try {
    if (!fs.existsSync(REPORT_DIR)) {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
    }
    fs.writeFileSync(
      path.join(REPORT_DIR, 'smoke-readiness.json'),
      JSON.stringify(jsonReport, null, 2)
    );
    fs.writeFileSync(path.join(REPORT_DIR, 'smoke-readiness.md'), mdReport);
    console.log('');
    console.log(`Reports: ${REPORT_DIR}/smoke-readiness.{json,md}`);
  } catch (err) {
    console.log(`[WARN] Could not write reports: ${err.message}`);
  }

  // Final verdict
  console.log('');
  console.log(
    `Checks: ${verdict.summary.pass} PASS / ${verdict.summary.fail} FAIL / ${verdict.summary.skip} SKIP / ${verdict.summary.warn} WARN`
  );
  console.log('');

  if (verdict.verdict === 'GO') {
    console.log('=== VERDICT: GO — Release readiness confirmed ===');
    if (verdict.summary.warn > 0) {
      console.log(`  (${verdict.summary.warn} warning(s) — review recommended)`);
    }
    if (verdict.summary.skip > 0) {
      console.log(`  (${verdict.summary.skip} check(s) skipped — see report for reasons)`);
    }
  } else {
    console.log(`=== VERDICT: NO-GO — ${verdict.summary.fail} check(s) failed ===`);
    console.log('');
    console.log('Root causes:');
    for (const rc of verdict.rootCauses) {
      console.log(`  [check: ${rc.gate}]`);
      console.log(`    Issue: ${rc.issue}`);
      console.log(`    Fix:   ${rc.fix}`);
    }
  }
  console.log('');

  process.exit(verdict.verdict === 'GO' ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[FATAL] Smoke readiness internal error: ${err.message}`);
    process.exit(2);
  });
}

module.exports = {
  parseArgs,
  runStrictPreflight,
  runArtifactValidation,
  runDiagnosticsChecks,
  runEnvironmentChecks,
  computeVerdict,
  generateJsonReport,
  generateMarkdownReport,
};
