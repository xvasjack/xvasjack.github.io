#!/usr/bin/env node
/**
 * Template Comparison Script
 * Compares generated PPTX output against reference template
 *
 * Template: 251219_Escort_Phase 1 Market Selection_V3.pptx
 * Expected: 34 slides, 15 charts, 69 tables, 13 images
 *
 * Run: node compare-to-template.js <generated.pptx> [template.pptx]
 */

const path = require('path');
const fs = require('fs');
const {
  generateReport,
  extractAllText,
  readPPTX,
  countCharts,
  countTables,
  countImages,
} = require('./pptx-validator');

// Template reference metrics (from actual template analysis)
const TEMPLATE_METRICS = {
  slides: 36,
  charts: 16,
  tables: 80,
  images: 13,
  totalText: 45000,
  avgCharsPerSlide: 1250,
  sections: [
    { name: 'Title', slides: [1], minChars: 50 },
    { name: 'Context', slides: [2], minChars: 500 },
    { name: 'TOC', slides: [3, 6, 12, 21, 31], minChars: 100 },
    { name: 'Executive Summary', slides: [4, 5], minChars: 1500 },
    { name: 'Policy & Regulations', slides: [7, 8, 9, 10, 11], minChars: 1000 },
    { name: 'Market Data', slides: [13, 14, 15, 16, 17, 18, 19, 20], minChars: 600 },
    { name: 'Japanese Players', slides: [22, 23, 24, 25, 26, 27, 28, 29], minChars: 400 },
    { name: 'Strategy & Risk', slides: [28, 29, 30], minChars: 600 },
    { name: 'Appendix', slides: [32, 33, 34, 35, 36], minChars: 200 },
  ],
  expectedKeywords: [
    'Vietnam',
    'Energy',
    'Policy',
    'Regulation',
    'Market',
    'LNG',
    'Gas',
    'Electricity',
    'Japanese',
    'Osaka Gas',
    'Toho Gas',
    'ESCO',
    'PDP8',
    'Opportunities',
    'Obstacles',
    'Strategy',
    'Investment',
    'Partner',
  ],
  storyFlow: [
    { section: 'Executive Summary', purpose: 'Go/No-Go recommendation with confidence level' },
    { section: 'Policy', purpose: 'Regulatory landscape and foreign investment rules' },
    { section: 'Market Data', purpose: 'Quantified opportunity, demand-supply gap' },
    {
      section: 'Competitive Analysis',
      purpose: 'Who is there, what are they doing, gaps to exploit',
    },
    { section: 'Entry Strategy', purpose: 'Specific actionable recommendations' },
  ],
};

// Severity levels for gaps
const SEVERITY = {
  HIGH: '[HIGH]',
  MEDIUM: '[MEDIUM]',
  LOW: '[LOW]',
};

async function analyzeFile(filePath) {
  const { zip, fileSize } = await readPPTX(filePath);
  const textData = await extractAllText(zip);
  const chartData = await countCharts(zip);
  const tableData = await countTables(zip);
  const imageData = await countImages(zip);

  return {
    slides: textData.slideCount,
    charts: chartData.chartFiles,
    tables: tableData.totalTables,
    images: imageData.imageCount,
    totalText: textData.totalCharCount,
    avgCharsPerSlide: Math.round(textData.totalCharCount / textData.slideCount),
    fileSize: fileSize,
    slideDetails: textData.slides,
    tablesBySlide: tableData.tablesBySlide,
  };
}

function compareMetrics(generated, template = TEMPLATE_METRICS) {
  const gaps = [];
  const passed = [];

  // Slide count
  const slideDiff = template.slides - generated.slides;
  const slidePct = ((slideDiff / template.slides) * 100).toFixed(0);
  if (slideDiff > 5) {
    gaps.push({
      severity: SEVERITY.HIGH,
      metric: 'Slides',
      expected: template.slides,
      actual: generated.slides,
      diff: `Missing ${slideDiff} (${slidePct}% fewer)`,
    });
  } else if (slideDiff > 0) {
    gaps.push({
      severity: SEVERITY.MEDIUM,
      metric: 'Slides',
      expected: template.slides,
      actual: generated.slides,
      diff: `Missing ${slideDiff}`,
    });
  } else {
    passed.push({ metric: 'Slides', expected: template.slides, actual: generated.slides });
  }

  // Chart count
  const chartDiff = template.charts - generated.charts;
  const chartPct = ((chartDiff / template.charts) * 100).toFixed(0);
  if (chartDiff > 5) {
    gaps.push({
      severity: SEVERITY.HIGH,
      metric: 'Charts',
      expected: template.charts,
      actual: generated.charts,
      diff: `Missing ${chartDiff} (${chartPct}% fewer)`,
    });
  } else if (chartDiff > 0) {
    gaps.push({
      severity: SEVERITY.MEDIUM,
      metric: 'Charts',
      expected: template.charts,
      actual: generated.charts,
      diff: `Missing ${chartDiff}`,
    });
  } else {
    passed.push({ metric: 'Charts', expected: template.charts, actual: generated.charts });
  }

  // Table count
  const tableDiff = template.tables - generated.tables;
  const tablePct = ((tableDiff / template.tables) * 100).toFixed(0);
  if (tableDiff > 20) {
    gaps.push({
      severity: SEVERITY.HIGH,
      metric: 'Tables',
      expected: template.tables,
      actual: generated.tables,
      diff: `Missing ${tableDiff} (${tablePct}% fewer)`,
    });
  } else if (tableDiff > 10) {
    gaps.push({
      severity: SEVERITY.MEDIUM,
      metric: 'Tables',
      expected: template.tables,
      actual: generated.tables,
      diff: `Missing ${tableDiff}`,
    });
  } else if (tableDiff > 0) {
    gaps.push({
      severity: SEVERITY.LOW,
      metric: 'Tables',
      expected: template.tables,
      actual: generated.tables,
      diff: `Missing ${tableDiff}`,
    });
  } else {
    passed.push({ metric: 'Tables', expected: template.tables, actual: generated.tables });
  }

  // Image count
  const imageDiff = template.images - generated.images;
  if (imageDiff > 5) {
    gaps.push({
      severity: SEVERITY.MEDIUM,
      metric: 'Images',
      expected: template.images,
      actual: generated.images,
      diff: `Missing ${imageDiff}`,
    });
  } else if (imageDiff > 0) {
    gaps.push({
      severity: SEVERITY.LOW,
      metric: 'Images',
      expected: template.images,
      actual: generated.images,
      diff: `Missing ${imageDiff}`,
    });
  } else {
    passed.push({ metric: 'Images', expected: template.images, actual: generated.images });
  }

  // Text density
  const avgDiff = template.avgCharsPerSlide - generated.avgCharsPerSlide;
  if (generated.avgCharsPerSlide < 500) {
    gaps.push({
      severity: SEVERITY.HIGH,
      metric: 'Content Density',
      expected: `${template.avgCharsPerSlide} chars/slide`,
      actual: `${generated.avgCharsPerSlide} chars/slide`,
      diff: 'Slides too sparse',
    });
  } else if (generated.avgCharsPerSlide < 800) {
    gaps.push({
      severity: SEVERITY.MEDIUM,
      metric: 'Content Density',
      expected: `${template.avgCharsPerSlide} chars/slide`,
      actual: `${generated.avgCharsPerSlide} chars/slide`,
      diff: 'Below template average',
    });
  } else {
    passed.push({
      metric: 'Content Density',
      expected: `${template.avgCharsPerSlide}`,
      actual: `${generated.avgCharsPerSlide}`,
    });
  }

  return { gaps, passed };
}

function checkStructure(generated, template = TEMPLATE_METRICS) {
  const structure = { passed: [], failed: [] };

  // Check for Title slide
  if (generated.slideDetails[0] && generated.slideDetails[0].charCount >= 20) {
    structure.passed.push('Title slide present');
  } else {
    structure.failed.push('Title slide missing or empty');
  }

  // Check for TOC slides
  const tocSlides = generated.slideDetails.filter(
    (s) =>
      s.fullText.toLowerCase().includes('table of contents') ||
      s.fullText.toLowerCase().includes('contents')
  );
  if (tocSlides.length >= 4) {
    structure.passed.push(`TOC slides present (${tocSlides.length})`);
  } else if (tocSlides.length > 0) {
    structure.failed.push(`Missing TOC dividers (found ${tocSlides.length}, expected ~5)`);
  } else {
    structure.failed.push('Missing TOC slides');
  }

  // Check for Executive Summary
  const execSlides = generated.slideDetails.filter(
    (s) =>
      s.fullText.toLowerCase().includes('executive summary') ||
      s.fullText.toLowerCase().includes('opportunities and')
  );
  if (execSlides.length >= 2) {
    structure.passed.push('Executive Summary present');
  } else {
    structure.failed.push('Missing Executive Summary section');
  }

  // Check for Policy section
  const policySlides = generated.slideDetails.filter(
    (s) =>
      s.fullText.toLowerCase().includes('policy') ||
      s.fullText.toLowerCase().includes('regulation') ||
      s.fullText.toLowerCase().includes('foundational acts')
  );
  if (policySlides.length >= 4) {
    structure.passed.push(`Policy section present (${policySlides.length} slides)`);
  } else if (policySlides.length >= 2) {
    structure.failed.push(`Policy section thin (${policySlides.length}/5 expected)`);
  } else {
    structure.failed.push('Missing Policy section');
  }

  // Check for Market Data section
  const marketSlides = generated.slideDetails.filter(
    (s) =>
      s.fullText.toLowerCase().includes('market') ||
      s.fullText.toLowerCase().includes('tpes') ||
      s.fullText.toLowerCase().includes('electricity') ||
      s.fullText.toLowerCase().includes('lng')
  );
  if (marketSlides.length >= 6) {
    structure.passed.push(`Market Data section present (${marketSlides.length} slides)`);
  } else if (marketSlides.length >= 3) {
    structure.failed.push(`Market Data section thin (${marketSlides.length}/8 expected)`);
  } else {
    structure.failed.push('Missing Market Data section');
  }

  // Check for Japanese Players section
  const jpSlides = generated.slideDetails.filter(
    (s) =>
      s.fullText.toLowerCase().includes('japanese') ||
      s.fullText.toLowerCase().includes('osaka gas') ||
      s.fullText.toLowerCase().includes('toho gas') ||
      s.fullText.toLowerCase().includes('case study')
  );
  if (jpSlides.length >= 5) {
    structure.passed.push(`Japanese Players section present (${jpSlides.length} slides)`);
  } else if (jpSlides.length >= 2) {
    structure.failed.push(`Japanese Players section thin (${jpSlides.length}/9 expected)`);
  } else {
    structure.failed.push('Missing Japanese Players section');
  }

  // Check for Glossary/Appendix
  const appendixSlides = generated.slideDetails.filter(
    (s) =>
      s.fullText.toLowerCase().includes('glossary') || s.fullText.toLowerCase().includes('appendix')
  );
  if (appendixSlides.length >= 2) {
    structure.passed.push('Glossary/Appendix present');
  } else {
    structure.failed.push('Missing Glossary/Appendix');
  }

  return structure;
}

function checkKeywords(generated, template = TEMPLATE_METRICS) {
  const fullText = generated.slideDetails
    .map((s) => s.fullText)
    .join(' ')
    .toLowerCase();
  const found = [];
  const missing = [];

  for (const keyword of template.expectedKeywords) {
    if (fullText.includes(keyword.toLowerCase())) {
      found.push(keyword);
    } else {
      missing.push(keyword);
    }
  }

  return {
    found,
    missing,
    coverage: ((found.length / template.expectedKeywords.length) * 100).toFixed(0),
  };
}

function checkInsightQuality(generated) {
  const issues = [];
  const strengths = [];

  // Check for "So What" patterns (insight subtitles)
  const slidesWithInsight = generated.slideDetails.filter(
    (s) =>
      s.fullText.toLowerCase().includes('key insight') ||
      s.fullText.toLowerCase().includes('implication') ||
      s.fullText.toLowerCase().includes('recommendation') ||
      s.fullText.toLowerCase().includes('opportunity')
  );

  if (slidesWithInsight.length >= 10) {
    strengths.push(`Strong insight coverage (${slidesWithInsight.length} slides with insights)`);
  } else if (slidesWithInsight.length >= 5) {
    issues.push({
      severity: SEVERITY.MEDIUM,
      issue: `Limited insights (${slidesWithInsight.length} slides) - add "So What" to each slide`,
    });
  } else {
    issues.push({
      severity: SEVERITY.HIGH,
      issue: 'Missing insights - slides are data dumps without "So What"',
    });
  }

  // Check for specific recommendations
  const hasSpecificReco = generated.slideDetails.some(
    (s) =>
      s.fullText.toLowerCase().includes('partner with') ||
      (s.fullText.toLowerCase().includes('invest') && s.fullText.toLowerCase().includes('$')) ||
      s.fullText.toLowerCase().includes('timeline')
  );
  if (hasSpecificReco) {
    strengths.push('Contains specific, actionable recommendations');
  } else {
    issues.push({
      severity: SEVERITY.HIGH,
      issue: 'Recommendations too vague - add specific partners, investment amounts, timelines',
    });
  }

  // Check for quantified opportunity
  const hasQuantified = generated.slideDetails.some(
    (s) =>
      s.fullText.toLowerCase().includes('$') &&
      (s.fullText.toLowerCase().includes('billion') || s.fullText.toLowerCase().includes('million'))
  );
  if (hasQuantified) {
    strengths.push('Market opportunity is quantified');
  } else {
    issues.push({
      severity: SEVERITY.MEDIUM,
      issue: 'Missing market sizing - add TAM/SAM figures with $',
    });
  }

  // Check for sourced data
  const hasSources = generated.slideDetails.some(
    (s) =>
      s.fullText.toLowerCase().includes('source:') ||
      s.fullText.toLowerCase().includes('iea') ||
      s.fullText.toLowerCase().includes('world bank')
  );
  if (hasSources) {
    strengths.push('Data sources cited');
  } else {
    issues.push({
      severity: SEVERITY.LOW,
      issue: 'Missing data sources - add citations for credibility',
    });
  }

  return { issues, strengths };
}

async function runComparison(generatedPath, templatePath = null) {
  console.log('='.repeat(70));
  console.log('TEMPLATE COMPARISON');
  console.log('='.repeat(70));

  // Analyze generated file
  console.log(`\nAnalyzing: ${generatedPath}`);
  const generated = await analyzeFile(generatedPath);

  // Optionally analyze template if provided
  let template = TEMPLATE_METRICS;
  if (templatePath && fs.existsSync(templatePath)) {
    console.log(`Template: ${templatePath}`);
    const templateData = await analyzeFile(templatePath);
    template = { ...TEMPLATE_METRICS, ...templateData };
  } else {
    console.log('Template: Using stored reference metrics');
  }

  // Structure comparison
  console.log('\n' + '-'.repeat(40));
  console.log('STRUCTURE COMPARISON');
  console.log('-'.repeat(40));
  console.log(
    `Template: ${template.slides} slides, ${template.charts} charts, ${template.tables} tables, ${template.images} images`
  );
  console.log(
    `Generated: ${generated.slides} slides, ${generated.charts} charts, ${generated.tables} tables, ${generated.images} images`
  );

  // Metric gaps
  const { gaps, passed } = compareMetrics(generated, template);

  if (gaps.length > 0) {
    console.log('\nGAPS:');
    gaps.forEach((g) =>
      console.log(
        `  ${g.severity} ${g.metric}: expected ${g.expected}, got ${g.actual} - ${g.diff}`
      )
    );
  }

  if (passed.length > 0) {
    console.log('\nPASSED:');
    passed.forEach((p) => console.log(`  [OK] ${p.metric}: ${p.actual}`));
  }

  // Structure check
  console.log('\n' + '-'.repeat(40));
  console.log('SECTION STRUCTURE');
  console.log('-'.repeat(40));
  const structure = checkStructure(generated, template);
  structure.passed.forEach((s) => console.log(`  [OK] ${s}`));
  structure.failed.forEach((s) => console.log(`  [FAIL] ${s}`));

  // Keyword coverage
  console.log('\n' + '-'.repeat(40));
  console.log('KEYWORD COVERAGE');
  console.log('-'.repeat(40));
  const keywords = checkKeywords(generated, template);
  console.log(
    `  Coverage: ${keywords.coverage}% (${keywords.found.length}/${template.expectedKeywords.length})`
  );
  if (keywords.missing.length > 0) {
    console.log(`  Missing: ${keywords.missing.join(', ')}`);
  }

  // Insight quality
  console.log('\n' + '-'.repeat(40));
  console.log('INSIGHT QUALITY');
  console.log('-'.repeat(40));
  const quality = checkInsightQuality(generated);
  quality.strengths.forEach((s) => console.log(`  [GOOD] ${s}`));
  quality.issues.forEach((i) => console.log(`  ${i.severity} ${i.issue}`));

  // Summary
  const highIssues =
    gaps.filter((g) => g.severity === SEVERITY.HIGH).length +
    quality.issues.filter((i) => i.severity === SEVERITY.HIGH).length +
    structure.failed.length;
  const mediumIssues =
    gaps.filter((g) => g.severity === SEVERITY.MEDIUM).length +
    quality.issues.filter((i) => i.severity === SEVERITY.MEDIUM).length;

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`High Priority Issues: ${highIssues}`);
  console.log(`Medium Priority Issues: ${mediumIssues}`);
  console.log(
    `Structure Checks: ${structure.passed.length} passed, ${structure.failed.length} failed`
  );
  console.log(`Keyword Coverage: ${keywords.coverage}%`);

  // Export results
  const resultsFile = path.join(__dirname, 'template-comparison-results.json');
  fs.writeFileSync(
    resultsFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        generated: generatedPath,
        metrics: {
          generated,
          template: {
            slides: template.slides,
            charts: template.charts,
            tables: template.tables,
            images: template.images,
          },
        },
        gaps,
        passed,
        structure,
        keywords,
        quality,
        summary: {
          highIssues,
          mediumIssues,
          passedStructure: structure.passed.length,
          failedStructure: structure.failed.length,
          keywordCoverage: keywords.coverage,
        },
      },
      null,
      2
    )
  );
  console.log(`\nResults exported: ${resultsFile}`);

  return { gaps, structure, keywords, quality, summary: { highIssues, mediumIssues } };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log('Usage: node compare-to-template.js <generated.pptx> [template.pptx]');
    console.log('');
    console.log('Options:');
    console.log('  generated.pptx    Path to generated PPTX file');
    console.log(
      '  template.pptx     Optional path to template (uses stored metrics if not provided)'
    );
    console.log('');
    console.log('Example:');
    console.log('  node compare-to-template.js vietnam-output.pptx');
    console.log(
      '  node compare-to-template.js vietnam-output.pptx "/mnt/c/Users/User/Downloads/251219_Escort_Phase 1 Market Selection_V3.pptx"'
    );
    process.exit(0);
  }

  const generatedPath = args[0];
  const templatePath = args[1];

  if (!fs.existsSync(generatedPath)) {
    console.error(`File not found: ${generatedPath}`);
    process.exit(1);
  }

  await runComparison(generatedPath, templatePath);
}

module.exports = {
  TEMPLATE_METRICS,
  analyzeFile,
  compareMetrics,
  checkStructure,
  checkKeywords,
  checkInsightQuality,
  runComparison,
};
if (require.main === module) main();
