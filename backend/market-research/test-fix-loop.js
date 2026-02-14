#!/usr/bin/env node
/**
 * Automated Test-Fix Loop - Generate, validate, report until all checks pass
 * Run: node test-fix-loop.js [--once|--auto|--max N]
 */
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { validatePPTX, generateReport, readPPTX } = require('./pptx-validator');
const { getExpectations, validateSlides } = require('./validate-output');
const { runVisualFidelityCheck } = require('./visual-fidelity-runner');
const { runSlideAudit } = require('./slide-audit-runner');
const { runXmlPackageAudit } = require('./xml-audit-runner');

const CONFIG = {
  maxIterations: 10,
  waitForFix: true,
  outputFile: path.join(__dirname, 'test-output.pptx'),
  issuesFile: path.join(__dirname, 'validation-issues.json'),
  genScript: path.join(__dirname, 'test-ppt-generation.js'),
};

const history = [];

async function generatePPT() {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('node', [CONFIG.genScript], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      resolve({
        success: code === 0 && fs.existsSync(CONFIG.outputFile),
        error: code !== 0 ? stderr || `Exit ${code}` : null,
        duration: Date.now() - start,
      });
    });
  });
}

async function validate(expectations) {
  const results = {
    passed: [],
    failed: [],
    warnings: [],
    details: null,
    visual: null,
    slideAudit: null,
    xmlAudit: null,
  };
  try {
    const basic = await validatePPTX(CONFIG.outputFile, expectations);
    results.passed.push(...basic.passed);
    results.failed.push(...basic.failed);
    results.warnings.push(...basic.warnings);
    const { zip } = await readPPTX(CONFIG.outputFile);
    const slideRes = await validateSlides(zip, expectations.slideChecks);
    results.passed.push(...slideRes.passed);
    results.failed.push(...slideRes.failed);
    results.details = await generateReport(CONFIG.outputFile);
    results.visual = await runVisualFidelityCheck(CONFIG.outputFile);
    results.slideAudit = await runSlideAudit(CONFIG.outputFile);
    results.xmlAudit = await runXmlPackageAudit(CONFIG.outputFile);
    if (results.visual.valid) {
      results.passed.push({
        check: 'Visual fidelity',
        message: `score ${results.visual.score}`,
      });
    } else {
      const failedVisualChecks = (results.visual.checks || []).filter((c) => !c.passed);
      results.failed.push({
        check: 'Visual fidelity',
        expected: 'valid visual match against template',
        actual: `score ${results.visual.score || 0} | highFailures=${results.visual.summary?.highFailures || 0}`,
      });
      for (const chk of failedVisualChecks.slice(0, 8)) {
        results.failed.push({
          check: `Visual: ${chk.name}`,
          expected: chk.expected,
          actual: chk.actual,
        });
      }
    }

    if (results.xmlAudit.valid) {
      results.passed.push({
        check: 'XML package integrity',
        message: `${results.xmlAudit.summary?.parsedParts || 0}/${results.xmlAudit.summary?.totalParts || 0} parts parsed`,
      });
    } else {
      results.failed.push({
        check: 'XML package integrity',
        expected: 'all XML/rels parts parse cleanly',
        actual: `${results.xmlAudit.summary?.issueCount || 0} issue(s)`,
      });
      for (const issue of (results.xmlAudit.issues || []).slice(0, 8)) {
        results.failed.push({
          check: `XML: ${issue.part}`,
          expected: 'well-formed UTF-8 XML',
          actual: `${issue.code} (${issue.message})`,
        });
      }
    }

    const auditHigh = Number(results.slideAudit.summary?.high || 0);
    if (auditHigh > 0) {
      results.failed.push({
        check: 'Slide-by-slide audit',
        expected: '0 high-severity issues',
        actual: auditHigh,
      });
      const topIssueSlides = (results.slideAudit.slides || [])
        .filter((s) => Number(s.issueCount || 0) > 0)
        .sort((a, b) => Number(b.issueCount || 0) - Number(a.issueCount || 0))
        .slice(0, 8);
      for (const s of topIssueSlides) {
        const lead = (s.issues || [])[0];
        if (!lead) continue;
        results.failed.push({
          check: `Slide ${s.slide}: ${lead.code}`,
          expected: 'no severe formatting drift',
          actual: lead.message,
        });
      }
    } else {
      results.passed.push({
        check: 'Slide-by-slide audit',
        message: `high=0, medium=${results.slideAudit.summary?.medium || 0}`,
      });
    }

    results.valid = results.failed.length === 0;
  } catch (err) {
    results.valid = false;
    results.error = err.message;
    results.failed.push({ check: 'Validation', expected: 'No errors', actual: err.message });
  }
  return results;
}

function printReport(iter, gen, val) {
  console.log('\n' + '='.repeat(70));
  console.log(`ITERATION ${iter}`);
  console.log('='.repeat(70));
  if (!gen.success) {
    console.log(`Generation FAILED: ${gen.error}`);
    return;
  }
  const stats = fs.statSync(CONFIG.outputFile);
  console.log(`Generated: ${(stats.size / 1024).toFixed(1)}KB in ${gen.duration}ms`);
  const total = val.passed.length + val.failed.length;
  console.log(
    `Validation: ${val.failed.length === 0 ? 'PASSED' : 'FAILED'} (${val.passed.length}/${total})`
  );
  if (val.details)
    console.log(
      `Structure: ${val.details.slides.count} slides, ${val.details.charts.chartFiles} charts, ${val.details.tables.totalTables} tables`
    );
  if (val.visual) {
    console.log(
      `Visual: ${val.visual.valid ? 'PASS' : 'FAIL'} | score ${val.visual.score || 0} | failed ${val.visual.summary?.failed || 0}`
    );
  }
  if (val.slideAudit) {
    console.log(
      `Slide audit: issueSlides=${val.slideAudit.summary?.slidesWithIssues || 0} | high=${val.slideAudit.summary?.high || 0} | medium=${val.slideAudit.summary?.medium || 0}`
    );
  }
  if (val.xmlAudit) {
    console.log(
      `XML audit: ${val.xmlAudit.valid ? 'PASS' : 'FAIL'} | parts=${val.xmlAudit.summary?.parsedParts || 0}/${val.xmlAudit.summary?.totalParts || 0} | issues=${val.xmlAudit.summary?.issueCount || 0}`
    );
  }
  if (val.failed.length > 0) {
    console.log('\nIssues:');
    val.failed.forEach((f, i) =>
      console.log(
        `  ${i + 1}. ${f.check}: expected ${f.expected}, got ${String(f.actual).substring(0, 60)}`
      )
    );
  }
  console.log('='.repeat(70));
  console.log(val.valid ? 'ALL CHECKS PASSED' : `${val.failed.length} ISSUES REMAINING`);
}

function exportIssues(results) {
  const data = {
    timestamp: new Date().toISOString(),
    valid: results.valid,
    summary: {
      passed: results.passed.length,
      failed: results.failed.length,
      warnings: results.warnings.length,
    },
    failed: results.failed,
    warnings: results.warnings,
    structure: results.details
      ? {
          slides: results.details.slides.count,
          charts: results.details.charts.chartFiles,
          tables: results.details.tables.totalTables,
        }
      : null,
    visual: results.visual
      ? {
          valid: results.visual.valid,
          score: results.visual.score || 0,
          failed: results.visual.summary?.failed || 0,
          checks: (results.visual.checks || []).filter((c) => !c.passed).slice(0, 12),
        }
      : null,
    slideAudit: results.slideAudit
      ? {
          summary: results.slideAudit.summary || {},
          topSlides: (results.slideAudit.slides || [])
            .filter((s) => Number(s.issueCount || 0) > 0)
            .sort((a, b) => Number(b.issueCount || 0) - Number(a.issueCount || 0))
            .slice(0, 10)
            .map((s) => ({
              slide: s.slide,
              issueCount: s.issueCount,
              issues: (s.issues || []).slice(0, 3),
            })),
        }
      : null,
    xmlAudit: results.xmlAudit
      ? {
          valid: results.xmlAudit.valid,
          summary: results.xmlAudit.summary || {},
          issues: (results.xmlAudit.issues || []).slice(0, 20),
        }
      : null,
  };
  fs.writeFileSync(CONFIG.issuesFile, JSON.stringify(data, null, 2));
}

async function waitForInput(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) =>
    rl.question(prompt, (a) => {
      rl.close();
      r(a.trim().toLowerCase());
    })
  );
}

async function runLoop(expectations) {
  console.log('='.repeat(70));
  console.log('AUTOMATED TEST-FIX LOOP');
  console.log('='.repeat(70));
  console.log(`Max iterations: ${CONFIG.maxIterations} | Wait for fix: ${CONFIG.waitForFix}`);

  let iter = 0,
    allPassed = false;
  while (iter < CONFIG.maxIterations && !allPassed) {
    iter++;
    const gen = await generatePPT();
    const val = gen.success
      ? await validate(expectations)
      : {
          valid: false,
          passed: [],
          failed: [{ check: 'Generation', expected: 'Success', actual: gen.error }],
          warnings: [],
        };
    history.push({ iter, gen, val });
    printReport(iter, gen, val);
    exportIssues(val);

    if (val.valid) {
      allPassed = true;
      break;
    }

    if (CONFIG.waitForFix && iter < CONFIG.maxIterations) {
      console.log('\nWaiting for fix... [Enter=retry, q=quit]');
      const action = await waitForInput('> ');
      if (action === 'q') {
        console.log('Exiting.');
        process.exit(1);
      }
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(`SUMMARY: ${history.length} iterations, ${allPassed ? 'PASSED' : 'FAILED'}`);
  if (history.length > 1) {
    const first = history[0].val.failed.length,
      last = history[history.length - 1].val.failed.length;
    console.log(`Progress: ${first} -> ${last} issues (${first - last} fixed)`);
  }
  return { success: allPassed, iterations: history.length, history };
}

async function runOnce(expectations) {
  if (!fs.existsSync(CONFIG.outputFile)) {
    const gen = await generatePPT();
    if (!gen.success) {
      console.error('Generation failed:', gen.error);
      process.exit(1);
    }
  }
  const val = await validate(expectations);
  printReport(1, { success: true, duration: 0 }, val);
  exportIssues(val);
  return val;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      'Usage: node test-fix-loop.js [--once|--auto|--max N] [--country=X] [--industry=Y]'
    );
    process.exit(0);
  }
  if (args.includes('--auto')) CONFIG.waitForFix = false;
  const maxIdx = args.indexOf('--max');
  if (maxIdx >= 0 && args[maxIdx + 1]) CONFIG.maxIterations = parseInt(args[maxIdx + 1], 10) || 10;

  const countryArg = args.find((a) => a.startsWith('--country='));
  const industryArg = args.find((a) => a.startsWith('--industry='));
  const country = countryArg ? countryArg.split('=')[1] : 'Thailand';
  const industry = industryArg ? industryArg.split('=')[1] : 'Energy Services';
  const expectations = getExpectations(country, industry);

  if (args.includes('--once')) {
    const r = await runOnce(expectations);
    process.exit(r.valid ? 0 : 1);
  } else {
    const r = await runLoop(expectations);
    process.exit(r.success ? 0 : 1);
  }
}

module.exports = { CONFIG, generatePPT, validate, runLoop, runOnce, exportIssues };
if (require.main === module) main();
