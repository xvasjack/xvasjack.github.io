#!/usr/bin/env node
/**
 * PPTX Validation Script - Generate and validate PPT output
 * Run: node validate-output.js [file.pptx]
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { validatePPTX, generateReport, readPPTX, extractAllText } = require('./pptx-validator');
const { runVisualFidelityCheck } = require('./visual-fidelity-runner');
const { runSlideAudit } = require('./slide-audit-runner');
const { runXmlPackageAudit } = require('./xml-audit-runner');

/**
 * Get expectations based on country and industry
 * @param {string} country - Target country (default: 'Vietnam')
 * @param {string} industry - Industry focus (default: 'Energy Services')
 * @returns {Object} Expectations configuration
 */
function getExpectations(country = 'Vietnam', industry = 'Energy Services') {
  return {
    minSlides: 7,
    maxSlides: 40,
    minFileSize: 50 * 1024,
    maxFileSize: 30 * 1024 * 1024,
    minCharts: 1,
    minTables: 3,
    requireInsights: true,
    titleContains: [country, 'Market'],
    requiredText: ['Energy', industry, 'Opportunities', 'Obstacles'],
    slideChecks: [
      { slide: 1, minChars: 20, mustContain: [country] },
      { slide: 2, minChars: 50, mustContain: ['Table of Contents', country] },
      { slide: 3, minChars: 50, mustContain: ['Executive Summary', country] },
    ],
    tableChecks: [],
  };
}

// Default expectations (for backward compatibility)
const EXPECTATIONS = getExpectations();

async function generatePPT() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, 'test-ppt-generation.js')], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      const out = path.join(__dirname, 'test-output.pptx');
      if (code !== 0) reject(new Error(stderr || `Exit ${code}`));
      else if (!fs.existsSync(out)) reject(new Error('Output not created'));
      else resolve(out);
    });
  });
}

async function validateSlides(zip, checks) {
  const results = { passed: [], failed: [] };
  const textData = await extractAllText(zip);
  for (const chk of checks) {
    const slide = textData.slides.find((s) => s.slideNum === chk.slide);
    if (!slide?.exists) {
      results.failed.push({ check: `Slide ${chk.slide}`, expected: 'Exists', actual: 'Missing' });
      continue;
    }
    if (chk.minChars) {
      if (slide.charCount < chk.minChars)
        results.failed.push({
          check: `Slide ${chk.slide} len`,
          expected: `>=${chk.minChars}`,
          actual: slide.charCount,
        });
      else results.passed.push({ check: `Slide ${chk.slide} len`, message: `${slide.charCount}` });
    }
    for (const t of chk.mustContain || []) {
      if (slide.fullText.toLowerCase().includes(t.toLowerCase()))
        results.passed.push({ check: `Slide ${chk.slide} "${t}"`, message: 'Found' });
      else
        results.failed.push({
          check: `Slide ${chk.slide} "${t}"`,
          expected: t,
          actual: slide.fullText.substring(0, 60),
        });
    }
  }
  return results;
}

async function runValidation(filePath, expectations = EXPECTATIONS) {
  const all = { passed: [], failed: [], warnings: [] };
  try {
    const basic = await validatePPTX(filePath, expectations);
    all.passed.push(...basic.passed);
    all.failed.push(...basic.failed);
    all.warnings.push(...basic.warnings);
    const { zip } = await readPPTX(filePath);
    const slideRes = await validateSlides(zip, expectations.slideChecks || []);
    all.passed.push(...slideRes.passed);
    all.failed.push(...slideRes.failed);
    const report = await generateReport(filePath);
    const visual = await runVisualFidelityCheck(filePath);
    const slideAudit = await runSlideAudit(filePath);
    const xmlAudit = await runXmlPackageAudit(filePath);
    const visualFailed = (visual.checks || []).filter((c) => !c.passed);

    if (!xmlAudit.valid) {
      all.failed.push({
        check: 'XML package integrity',
        expected: 'all XML/rels parts parse cleanly',
        actual: `${xmlAudit.summary?.issueCount || 0} issue(s)`,
      });
      for (const issue of (xmlAudit.issues || []).slice(0, 8)) {
        all.failed.push({
          check: `XML: ${issue.part}`,
          expected: 'well-formed UTF-8 XML',
          actual: `${issue.code} (${issue.message})`,
        });
      }
    } else {
      all.passed.push({
        check: 'XML package integrity',
        message: `${xmlAudit.summary?.parsedParts || 0}/${xmlAudit.summary?.totalParts || 0} parts parsed`,
      });
    }

    if (visual.valid) {
      all.passed.push({
        check: 'Visual fidelity',
        message: `score ${visual.score} (${visual.summary?.passed || 0}/${(visual.summary?.passed || 0) + (visual.summary?.failed || 0)})`,
      });
    } else {
      all.failed.push({
        check: 'Visual fidelity',
        expected: 'valid visual match against template',
        actual: `score ${visual.score || 0} | highFailures=${visual.summary?.highFailures || 0}`,
      });
      for (const chk of visualFailed.slice(0, 8)) {
        all.failed.push({
          check: `Visual: ${chk.name}`,
          expected: chk.expected,
          actual: chk.actual,
        });
      }
    }

    const auditHigh = Number(slideAudit.summary?.high || 0);
    const auditMed = Number(slideAudit.summary?.medium || 0);
    const issueSlides = Number(slideAudit.summary?.slidesWithIssues || 0);
    if (auditHigh > 0) {
      all.failed.push({
        check: 'Slide-by-slide audit',
        expected: '0 high-severity slide issues',
        actual: auditHigh,
      });
      const topIssueSlides = (slideAudit.slides || [])
        .filter((s) => Number(s.issueCount || 0) > 0)
        .sort((a, b) => Number(b.issueCount || 0) - Number(a.issueCount || 0))
        .slice(0, 8);
      for (const s of topIssueSlides) {
        const lead = (s.issues || [])[0];
        if (!lead) continue;
        all.failed.push({
          check: `Slide ${s.slide}: ${lead.code}`,
          expected: 'no severe formatting drift',
          actual: lead.message,
        });
      }
    } else {
      all.passed.push({
        check: 'Slide-by-slide audit',
        message: `high=0, medium=${auditMed}, issueSlides=${issueSlides}`,
      });
    }

    const total = all.passed.length + all.failed.length;
    console.log('\n' + '='.repeat(60));
    console.log(
      `VALIDATION: ${all.failed.length === 0 ? 'PASSED' : 'FAILED'} (${all.passed.length}/${total})`
    );
    console.log('='.repeat(60));
    console.log(
      `Slides: ${report.slides.count} | Charts: ${report.charts.chartFiles} | Tables: ${report.tables.totalTables} | Text: ${report.text.total} chars`
    );
    console.log(
      `Visual: ${visual.valid ? 'PASS' : 'FAIL'} | Score: ${visual.score || 0} | Failed checks: ${visual.summary?.failed || 0}`
    );
    console.log(
      `Slide audit: issueSlides=${slideAudit.summary?.slidesWithIssues || 0} | high=${auditHigh} | medium=${auditMed}`
    );
    console.log(
      `XML audit: ${xmlAudit.valid ? 'PASS' : 'FAIL'} | parts=${xmlAudit.summary?.parsedParts || 0}/${xmlAudit.summary?.totalParts || 0} | issues=${xmlAudit.summary?.issueCount || 0}`
    );

    if (all.failed.length > 0) {
      console.log('\nFailed:');
      all.failed.forEach((f) =>
        console.log(`  [FAIL] ${f.check}: expected ${f.expected}, got ${f.actual}`)
      );
    }
    if (all.warnings.length > 0) {
      console.log('\nWarnings:');
      all.warnings.forEach((w) => console.log(`  [WARN] ${w.check}: ${w.message}`));
    }
    console.log('\nSlides:');
    report.slides.details.forEach((s) =>
      console.log(`  ${s.slide}: ${s.chars} chars - "${s.preview.substring(0, 50)}..."`)
    );

    return { valid: all.failed.length === 0, results: all, report, visual, slideAudit, xmlAudit };
  } catch (err) {
    console.error('Error:', err.message);
    return { valid: false, error: err.message };
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const countryArg = args.find((a) => a.startsWith('--country='));
  const industryArg = args.find((a) => a.startsWith('--industry='));
  const country = countryArg ? countryArg.split('=')[1] : 'Vietnam';
  const industry = industryArg ? industryArg.split('=')[1] : 'Energy Services';

  // Find file path (first non-flag argument)
  const fileArg = args.find((a) => !a.startsWith('--') && fs.existsSync(a));

  let filePath;
  if (fileArg) {
    filePath = fileArg;
  } else {
    console.log('Generating PPT...');
    try {
      filePath = await generatePPT();
    } catch (e) {
      console.error('Gen failed:', e.message);
      process.exit(1);
    }
  }

  // Create custom expectations based on country/industry
  const customExpectations = getExpectations(country, industry);
  console.log(`Validating for: ${country} / ${industry}`);

  const result = await runValidation(filePath, customExpectations);
  process.exit(result.valid ? 0 : 1);
}

module.exports = { EXPECTATIONS, getExpectations, generatePPT, runValidation, validateSlides };
if (require.main === module) main();
