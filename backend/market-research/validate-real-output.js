#!/usr/bin/env node
/**
 * Validate Real Market Research PPTX Output
 * Tests against production-quality expectations
 * Run: node validate-real-output.js [file.pptx]
 */
const path = require('path');
const fs = require('fs');
const {
  validatePPTX,
  generateReport,
  readPPTX,
  extractAllText,
  countTables,
} = require('./pptx-validator');

/**
 * Get real expectations based on country and industry
 * @param {string} country - Target country (default: 'Vietnam')
 * @param {string} industry - Industry focus (default: 'Energy Services')
 * @returns {Object} Real expectations configuration
 */
function getRealExpectations(country = 'Vietnam', industry = 'Energy Services') {
  return {
    minSlides: 20,
    maxSlides: 40,
    minFileSize: 200 * 1024,
    maxFileSize: 30 * 1024 * 1024,
    minCharts: 2,
    minTables: 20,
    minImages: 0,
    requireInsights: true,
    country, // Store for later use
    industry,
    requiredText: [
      'Market',
      'Analysis',
      'Energy',
      'Policy',
      'Competitive',
      'Opportunities',
      'Obstacles',
    ],
    slideChecks: [{ slide: 1, minChars: 30, mustContain: [country] }],
    tableChecks: [],
    // Content quality checks
    qualityChecks: {
      minAvgCharsPerSlide: 300,
      maxEmptySlides: 2,
      requiredSections: ['Policy', 'Market', 'Competitive', 'Opportunities'],
    },
  };
}

// Default expectations (for backward compatibility)
const REAL_EXPECTATIONS = getRealExpectations();

async function validateRealOutput(filePath, expectations = REAL_EXPECTATIONS) {
  const all = { passed: [], failed: [], warnings: [] };
  const pass = (c, m) => all.passed.push({ check: c, message: m });
  const fail = (c, e, a) => all.failed.push({ check: c, expected: e, actual: a });
  const warn = (c, m) => all.warnings.push({ check: c, message: m });

  try {
    // Basic validation
    const basic = await validatePPTX(filePath, expectations);
    all.passed.push(...basic.passed);
    all.failed.push(...basic.failed);
    all.warnings.push(...basic.warnings);

    // Get detailed data
    const { zip } = await readPPTX(filePath);
    const textData = await extractAllText(zip);
    const tableData = await countTables(zip);
    const report = await generateReport(filePath);

    // Quality checks
    const q = expectations.qualityChecks;
    if (q) {
      // Average chars per slide
      const avgChars = textData.totalCharCount / textData.slideCount;
      if (avgChars < q.minAvgCharsPerSlide)
        fail('Avg content', `>= ${q.minAvgCharsPerSlide} chars/slide`, avgChars.toFixed(0));
      else pass('Avg content', `${avgChars.toFixed(0)} chars/slide`);

      // Empty slides
      const emptySlides = textData.slides.filter((s) => s.charCount < 100);
      if (emptySlides.length > q.maxEmptySlides)
        warn('Empty slides', `${emptySlides.length} slides with <100 chars`);
      else pass('Content density', `${emptySlides.length} sparse slides`);

      // Required sections
      const fullText = textData.slides
        .map((s) => s.fullText)
        .join(' ')
        .toLowerCase();
      for (const section of q.requiredSections) {
        if (fullText.includes(section.toLowerCase())) pass(`Section: ${section}`, 'Found');
        else fail(`Section: ${section}`, 'Present', 'Missing');
      }

      // Template sequence can vary by mode; require TOC presence anywhere instead of fixed slide index.
      if (fullText.includes('table of contents')) {
        pass('Section: Table of Contents', 'Found');
      } else {
        fail('Section: Table of Contents', 'Present', 'Missing');
      }
    }

    // Table distribution check
    const slidesWithTables = tableData.tablesBySlide.length;
    if (slidesWithTables < 5)
      warn('Table distribution', `Only ${slidesWithTables} slides have tables`);
    else pass('Table distribution', `${slidesWithTables} slides with tables`);

    // Print report
    const total = all.passed.length + all.failed.length;
    console.log('\n' + '='.repeat(70));
    console.log(
      `REAL OUTPUT VALIDATION: ${all.failed.length === 0 ? 'PASSED' : 'FAILED'} (${all.passed.length}/${total})`
    );
    console.log('='.repeat(70));
    console.log(`\nStructure:`);
    console.log(
      `  Slides: ${report.slides.count} | Charts: ${report.charts.chartFiles} | Tables: ${report.tables.totalTables}`
    );
    console.log(`  Text: ${report.text.total} chars (avg ${report.text.avgPerSlide}/slide)`);
    console.log(`  File: ${report.metadata.fileSize}`);

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

    console.log('\nSlide Summary:');
    const sections = {};
    const country = expectations.country || 'Vietnam';
    const countryPattern = new RegExp(`${country}\\s*-\\s*([^0-9]+)`, 'i');
    textData.slides.forEach((s) => {
      const first50 = s.fullText.substring(0, 50).replace(/\s+/g, ' ');
      const sectionMatch = first50.match(countryPattern);
      if (sectionMatch) {
        const section = sectionMatch[1].trim();
        sections[section] = (sections[section] || 0) + 1;
      }
    });
    Object.entries(sections).forEach(([s, c]) => console.log(`  ${s}: ${c} slide(s)`));

    // Export issues
    const issuesFile = path.join(__dirname, 'real-output-issues.json');
    fs.writeFileSync(
      issuesFile,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          file: filePath,
          valid: all.failed.length === 0,
          summary: {
            passed: all.passed.length,
            failed: all.failed.length,
            warnings: all.warnings.length,
          },
          failed: all.failed,
          warnings: all.warnings,
          structure: {
            slides: report.slides.count,
            charts: report.charts.chartFiles,
            tables: report.tables.totalTables,
            text: report.text.total,
          },
          sections,
        },
        null,
        2
      )
    );
    console.log(`\nIssues exported to: ${issuesFile}`);

    return { valid: all.failed.length === 0, results: all, report, sections };
  } catch (err) {
    console.error('Validation error:', err.message);
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
  const fileArg = args.find((a) => !a.startsWith('--'));
  const defaultFile = path.join(
    __dirname,
    '../../Market_Research_energy_services_2025-12-31 (6).pptx'
  );
  const filePath = fileArg || defaultFile;

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Validating: ${filePath}`);
  console.log(`Country: ${country} | Industry: ${industry}`);

  const customExpectations = getRealExpectations(country, industry);
  const result = await validateRealOutput(filePath, customExpectations);
  process.exit(result.valid ? 0 : 1);
}

module.exports = { REAL_EXPECTATIONS, getRealExpectations, validateRealOutput };
if (require.main === module) main();
