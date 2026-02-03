#!/usr/bin/env node
/**
 * DD Tool Automated Testing Script (DOCX Output Version)
 *
 * Workflow:
 * 1. Extract text from test DOCX
 * 2. Submit to DD API
 * 3. Poll for completion
 * 4. Download generated DOCX
 * 5. Extract styles from both generated and template DOCX
 * 6. Compare styling and structure
 * 7. Report issues only
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

// Configuration
const API_BASE =
  process.env.DD_API_URL || 'https://xvasjackgithubio-production-aa37.up.railway.app';
const TEST_DOC_PATH =
  process.env.TEST_DOC || '/mnt/c/Users/User/Downloads/Netpluz_DD_Mega_Summary.docx';
const TEMPLATE_PATH =
  process.env.TEMPLATE_DOC ||
  '/mnt/c/Users/User/Downloads/260114_SunCorp_Netpluz DD Report v4 (1).docx';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test@example.com';
const POLL_INTERVAL = 30000; // 30 seconds
const MAX_POLL_TIME = 15 * 60 * 1000; // 15 minutes
const OUTPUT_DIR = '/tmp';

// Load template styles config if available
let templateStylesConfig = null;
try {
  templateStylesConfig = require('./template-styles.json');
  console.log('[TEST] Loaded template-styles.json config');
} catch (e) {
  console.log('[TEST] template-styles.json not found, will extract from template');
}

// ============ DOCX EXTRACTION ============

async function extractDocxText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file('word/document.xml')?.async('string');

  if (!documentXml) {
    throw new Error('Could not find document.xml in DOCX');
  }

  const text = documentXml
    .replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, '$1')
    .replace(/<w:p[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();

  return text;
}

async function extractDocxStyles(filePathOrBuffer) {
  let buffer;
  if (typeof filePathOrBuffer === 'string') {
    buffer = fs.readFileSync(filePathOrBuffer);
  } else {
    buffer = filePathOrBuffer;
  }

  const zip = await JSZip.loadAsync(buffer);

  const styles = {
    fonts: new Set(),
    fontSizes: new Set(),
    colors: new Set(),
    shadingColors: new Set(),
    sections: [],
    tables: { count: 0, styles: [] },
    bulletTypes: new Set(),
    headings: [],
  };

  // Extract styles from styles.xml
  const stylesXml = await zip.file('word/styles.xml')?.async('string');
  if (stylesXml) {
    // Extract fonts
    const fontMatches = stylesXml.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/g) || [];
    fontMatches.forEach((m) => {
      const font = m.match(/w:ascii="([^"]+)"/)?.[1];
      if (font) styles.fonts.add(font);
    });

    // Extract font sizes (in half-points)
    const sizeMatches = stylesXml.match(/<w:sz\s+w:val="(\d+)"/g) || [];
    sizeMatches.forEach((m) => {
      const size = m.match(/w:val="(\d+)"/)?.[1];
      if (size) styles.fontSizes.add(parseInt(size) / 2);
    });

    // Extract colors
    const colorMatches = stylesXml.match(/<w:color\s+w:val="([0-9A-Fa-f]+)"/g) || [];
    colorMatches.forEach((m) => {
      const color = m.match(/w:val="([0-9A-Fa-f]+)"/)?.[1];
      if (color && color !== 'auto') styles.colors.add('#' + color.toUpperCase());
    });
  }

  // Extract document structure
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (documentXml) {
    // Find section headers (typically styled text followed by content)
    const headerMatches =
      documentXml.match(/<w:pStyle\s+w:val="(Heading\d+|Title|Subtitle)[^"]*"[^>]*>/g) || [];
    headerMatches.forEach((m) => {
      const style = m.match(/w:val="([^"]+)"/)?.[1];
      if (style) styles.headings.push(style);
    });

    // Count tables
    const tableMatches = documentXml.match(/<w:tbl>/g) || [];
    styles.tables.count = tableMatches.length;

    // Find table styles
    const tblStyleMatches = documentXml.match(/<w:tblStyle\s+w:val="([^"]+)"/g) || [];
    tblStyleMatches.forEach((m) => {
      const style = m.match(/w:val="([^"]+)"/)?.[1];
      if (style) styles.tables.styles.push(style);
    });

    // Extract inline fonts and colors from document
    const inlineFonts = documentXml.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/g) || [];
    inlineFonts.forEach((m) => {
      const font = m.match(/w:ascii="([^"]+)"/)?.[1];
      if (font) styles.fonts.add(font);
    });

    const inlineColors = documentXml.match(/<w:color\s+w:val="([0-9A-Fa-f]+)"/g) || [];
    inlineColors.forEach((m) => {
      const color = m.match(/w:val="([0-9A-Fa-f]+)"/)?.[1];
      if (color && color !== 'auto') styles.colors.add('#' + color.toUpperCase());
    });

    const inlineSizes = documentXml.match(/<w:sz\s+w:val="(\d+)"/g) || [];
    inlineSizes.forEach((m) => {
      const size = m.match(/w:val="(\d+)"/)?.[1];
      if (size) styles.fontSizes.add(parseInt(size) / 2);
    });

    // Extract shading colors (table backgrounds)
    const shadingMatches = documentXml.match(/<w:shd[^>]*w:fill="([0-9A-Fa-f]+)"/g) || [];
    shadingMatches.forEach((m) => {
      const color = m.match(/w:fill="([0-9A-Fa-f]+)"/)?.[1];
      if (color && color !== 'auto') styles.shadingColors.add('#' + color.toUpperCase());
    });

    // Find bullet/numbering types
    const numIdMatches = documentXml.match(/<w:numId\s+w:val="(\d+)"/g) || [];
    numIdMatches.forEach((m) => {
      const id = m.match(/w:val="(\d+)"/)?.[1];
      if (id && id !== '0') styles.bulletTypes.add('numId-' + id);
    });
  }

  // Extract numbering definitions
  const numberingXml = await zip.file('word/numbering.xml')?.async('string');
  if (numberingXml) {
    // Find bullet formats
    const bulletFormats = numberingXml.match(/<w:lvlText\s+w:val="([^"]+)"/g) || [];
    bulletFormats.forEach((m) => {
      const format = m.match(/w:val="([^"]+)"/)?.[1];
      if (format) styles.bulletTypes.add(format);
    });
  }

  // Convert Sets to Arrays for comparison
  return {
    fonts: Array.from(styles.fonts),
    fontSizes: Array.from(styles.fontSizes).sort((a, b) => a - b),
    colors: Array.from(styles.colors),
    shadingColors: Array.from(styles.shadingColors),
    headings: styles.headings,
    tables: styles.tables,
    bulletTypes: Array.from(styles.bulletTypes),
  };
}

async function extractTemplateSections(filePath) {
  const text = await extractDocxText(filePath);

  // Find section headers (numbered like 1.0, 1.1, 2.0, etc.)
  const sectionPattern = /(\d+\.\d*)\s+([^\n]+)/g;
  const sections = [];
  let match;

  while ((match = sectionPattern.exec(text)) !== null) {
    sections.push({
      number: match[1],
      title: match[2].trim(),
    });
  }

  return sections;
}

// ============ API INTERACTION ============

async function submitToDD(content, fileName) {
  console.log(`\n[TEST] Submitting ${fileName} to DD API...`);

  const response = await fetch(`${API_BASE}/api/due-diligence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [
        {
          name: fileName,
          type: 'txt',
          content: content,
        },
      ],
      email: TEST_EMAIL,
      components: ['overview', 'market_competition', 'financials', 'future_plans', 'workplan'],
      reportLength: 'medium',
    }),
  });

  const data = await response.json();
  console.log(`[TEST] Response:`, data);

  if (!data.success || !data.reportId) {
    throw new Error(`DD API error: ${data.error || 'No reportId returned'}`);
  }

  return data.reportId;
}

async function pollForReport(reportId) {
  console.log(`\n[TEST] Polling for report ${reportId}...`);

  const startTime = Date.now();

  while (Date.now() - startTime < MAX_POLL_TIME) {
    const response = await fetch(`${API_BASE}/api/reports/${reportId}`);
    const data = await response.json();

    console.log(
      `[TEST] Status: ${data.status} (${Math.round((Date.now() - startTime) / 1000)}s elapsed)` +
        (data.hasDocx ? ` - DOCX: ${data.docxSize} bytes` : '')
    );

    if (data.status === 'completed') {
      console.log(`[TEST] Report ready! (${data.reportJson?.sections?.length || 0} sections)`);
      return data;
    }

    if (data.status === 'error') {
      throw new Error(`Report generation failed: ${data.error}`);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new Error('Timeout waiting for report');
}

async function downloadDocx(reportId) {
  console.log(`\n[TEST] Downloading DOCX for report ${reportId}...`);

  const response = await fetch(`${API_BASE}/api/reports/${reportId}/download`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Download failed: ${error.error || response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`[TEST] Downloaded ${buffer.length} bytes`);

  return buffer;
}

// ============ COMPARISON ============

// Semantic category mapping - maps template sections to data categories
const SEMANTIC_CATEGORIES = {
  'company background': ['company overview', 'corporate', 'background', 'history', 'about'],
  'company capabilities': ['capabilities', 'products', 'services', 'offerings', 'solutions'],
  market: ['market', 'industry', 'sector', 'trends'],
  competition: ['competition', 'competitive', 'competitors', 'landscape'],
  'competitive advantage': ['advantage', 'strengths', 'differentiation'],
  vulnerable: ['vulnerable', 'weakness', 'risks', 'challenges', 'threats'],
  'income statement': ['income', 'revenue', 'profit', 'p&l', 'financial performance'],
  'revenue breakdown': [
    'revenue breakdown',
    'revenue analysis',
    'by country',
    'by product',
    'by service',
  ],
  'top customers': ['customer', 'concentration', 'top 5', 'top 10'],
  'balance sheet': ['balance sheet', 'assets', 'liabilities', 'financial position'],
  'future plans': ['future', 'strategy', 'plans', 'growth', 'expansion'],
  workplan: ['workplan', 'pre-dd', 'due diligence', 'next steps', 'information gaps'],
};

function checkSemanticCoverage(text, category) {
  const keywords = SEMANTIC_CATEGORIES[category.toLowerCase()] || [category.toLowerCase()];
  const textLower = text.toLowerCase();

  for (const keyword of keywords) {
    if (textLower.includes(keyword)) {
      return true;
    }
  }
  return false;
}

function compareDocxToTemplate(generatedStyles, templateStyles, generatedText, templateSections) {
  const issues = [];

  // 1. Check semantic coverage (not exact section titles)
  console.log('\n[TEST] === SECTION COVERAGE CHECK (Semantic) ===');

  const coveredCategories = new Set();
  const missingCategories = [];

  for (const section of templateSections) {
    const title = section.title.toLowerCase();
    let categoryFound = false;

    for (const [category, keywords] of Object.entries(SEMANTIC_CATEGORIES)) {
      for (const keyword of keywords) {
        if (title.includes(keyword)) {
          if (checkSemanticCoverage(generatedText, category)) {
            coveredCategories.add(category);
            categoryFound = true;
          }
          break;
        }
      }
      if (categoryFound) break;
    }

    if (!categoryFound) {
      const words = section.title.split(/\s+/).filter((w) => w.length > 3);
      const found = words.some((word) => generatedText.toLowerCase().includes(word.toLowerCase()));
      if (!found) {
        missingCategories.push(`${section.number} ${section.title}`);
      }
    }
  }

  const coveragePercent =
    ((templateSections.length - missingCategories.length) / templateSections.length) * 100;
  console.log(
    `[TEST] Coverage: ${coveragePercent.toFixed(0)}% (${templateSections.length - missingCategories.length}/${templateSections.length} categories)`
  );

  if (coveragePercent < 70) {
    issues.push({
      type: 'LOW_COVERAGE',
      severity: 'HIGH',
      detail: `Only ${coveragePercent.toFixed(0)}% of expected topics covered`,
    });
  }

  for (const missing of missingCategories.slice(0, 5)) {
    issues.push({
      type: 'MISSING_TOPIC',
      severity: 'MEDIUM',
      detail: `Topic not found: ${missing}`,
    });
  }

  // 2. Check table count (informational - table count depends on source content)
  console.log('[TEST] === TABLE CHECK ===');
  console.log(`[TEST] Generated tables: ${generatedStyles.tables.count}`);
  console.log(`[TEST] Template tables: ${templateStyles.tables.count}`);

  // Only flag as issue if we have NO tables at all (financial data should have at least one)
  if (generatedStyles.tables.count === 0) {
    issues.push({
      type: 'MISSING_TABLES',
      severity: 'MEDIUM',
      detail: `No tables generated - financial reports should have at least one table`,
    });
  } else if (generatedStyles.tables.count < 3) {
    // Soft warning if very few tables
    issues.push({
      type: 'FEW_TABLES',
      severity: 'LOW',
      detail: `Only ${generatedStyles.tables.count} tables - consider adding more tabular data`,
    });
  }

  // 3. Check fonts
  console.log('[TEST] === FONT CHECK ===');
  console.log(`[TEST] Generated fonts: ${generatedStyles.fonts.join(', ')}`);
  console.log(`[TEST] Template fonts: ${templateStyles.fonts.join(', ')}`);

  // Check if primary template font is used
  const primaryFont =
    templateStylesConfig?.fonts?.body?.family || templateStyles.fonts[0] || 'Arial';
  if (!generatedStyles.fonts.includes(primaryFont)) {
    issues.push({
      type: 'FONT_MISMATCH',
      severity: 'MEDIUM',
      detail: `Template uses ${primaryFont}, but output uses: ${generatedStyles.fonts.join(', ') || 'default'}`,
    });
  }

  // 4. Check colors
  console.log('[TEST] === COLOR CHECK ===');
  console.log(`[TEST] Generated colors: ${generatedStyles.colors.join(', ')}`);
  console.log(`[TEST] Template colors: ${templateStyles.colors.join(', ')}`);

  // Check key colors from config or template
  const expectedColors = templateStylesConfig
    ? [
        templateStylesConfig.fonts.heading1.color,
        templateStylesConfig.fonts.heading2.color,
        templateStylesConfig.tables.headerRow.bgColor,
      ]
    : templateStyles.colors.slice(0, 3);

  for (const color of expectedColors) {
    if (color && !generatedStyles.colors.includes(color.toUpperCase())) {
      issues.push({
        type: 'COLOR_MISMATCH',
        severity: 'LOW',
        detail: `Expected color ${color} not found in output`,
      });
    }
  }

  // 5. Check table shading (header backgrounds)
  console.log('[TEST] === TABLE SHADING CHECK ===');
  console.log(`[TEST] Generated shading: ${generatedStyles.shadingColors.join(', ')}`);

  const expectedHeaderBg = templateStylesConfig?.tables?.headerRow?.bgColor;
  if (expectedHeaderBg && !generatedStyles.shadingColors.includes(expectedHeaderBg.toUpperCase())) {
    issues.push({
      type: 'TABLE_HEADER_STYLE',
      severity: 'MEDIUM',
      detail: `Table headers should have background color ${expectedHeaderBg}`,
    });
  }

  // 6. Check bullet/list formatting
  console.log('[TEST] === BULLET CHECK ===');
  console.log(`[TEST] Generated bullets: ${generatedStyles.bulletTypes.length}`);
  console.log(`[TEST] Template bullets: ${templateStyles.bulletTypes.length}`);

  if (templateStyles.bulletTypes.length > 0 && generatedStyles.bulletTypes.length === 0) {
    issues.push({
      type: 'MISSING_BULLETS',
      severity: 'LOW',
      detail: 'Template has bullet points but output has none',
    });
  }

  // 7. Check headings structure
  console.log('[TEST] === HEADING CHECK ===');
  console.log(`[TEST] Generated headings: ${generatedStyles.headings.length}`);
  console.log(`[TEST] Template headings: ${templateStyles.headings.length}`);

  if (generatedStyles.headings.length < templateStyles.headings.length * 0.5) {
    issues.push({
      type: 'MISSING_HEADINGS',
      severity: 'MEDIUM',
      detail: `Expected ~${templateStyles.headings.length} headings, found ${generatedStyles.headings.length}`,
    });
  }

  // 8. Content completeness check
  console.log('[TEST] === CONTENT CHECK ===');
  const minExpectedLength = 3000;
  if (generatedText.length < minExpectedLength) {
    issues.push({
      type: 'CONTENT_TOO_SHORT',
      severity: 'HIGH',
      detail: `Report text is only ${generatedText.length} chars (expected >${minExpectedLength})`,
    });
  }

  // Check for "not available" or similar placeholders
  const placeholderMatches =
    generatedText.match(/not (found|available)|data unavailable|n\/a|tbd/gi) || [];
  if (placeholderMatches.length > 5) {
    issues.push({
      type: 'INCOMPLETE_DATA',
      severity: 'MEDIUM',
      detail: `Found ${placeholderMatches.length} placeholder/unavailable markers`,
    });
  }

  return issues;
}

// ============ MAIN ============

async function main() {
  console.log('='.repeat(60));
  console.log('DD TOOL AUTOMATED TEST (DOCX OUTPUT)');
  console.log('='.repeat(60));
  console.log(`API: ${API_BASE}`);
  console.log(`Test Doc: ${TEST_DOC_PATH}`);
  console.log(`Template: ${TEMPLATE_PATH}`);
  console.log('='.repeat(60));

  try {
    // Step 1: Extract test document content
    console.log('\n[STEP 1] Extracting test document...');
    const testContent = await extractDocxText(TEST_DOC_PATH);
    console.log(`Extracted ${testContent.length} chars`);

    // Step 2: Extract template specs
    console.log('\n[STEP 2] Extracting template formatting specs...');
    const templateStyles = await extractDocxStyles(TEMPLATE_PATH);
    const templateSections = await extractTemplateSections(TEMPLATE_PATH);
    console.log(`Template fonts: ${templateStyles.fonts.join(', ')}`);
    console.log(`Template font sizes: ${templateStyles.fontSizes.join('pt, ')}pt`);
    console.log(`Template colors: ${templateStyles.colors.join(', ')}`);
    console.log(`Template sections: ${templateSections.length}`);
    console.log(`Template tables: ${templateStyles.tables.count}`);

    // Step 3: Submit to DD API
    console.log('\n[STEP 3] Submitting to DD API...');
    const reportId = await submitToDD(testContent, path.basename(TEST_DOC_PATH));

    // Step 4: Poll for completion
    console.log('\n[STEP 4] Waiting for report generation...');
    const report = await pollForReport(reportId);

    // Step 5: Download DOCX
    console.log('\n[STEP 5] Downloading generated DOCX...');
    const docxBuffer = await downloadDocx(reportId);

    // Save DOCX for manual inspection
    const outputDocxPath = path.join(OUTPUT_DIR, `dd-test-output-${reportId}.docx`);
    fs.writeFileSync(outputDocxPath, docxBuffer);
    console.log(`[TEST] DOCX saved to: ${outputDocxPath}`);

    // Step 6: Extract styles from generated DOCX
    console.log('\n[STEP 6] Extracting styles from generated DOCX...');
    const generatedStyles = await extractDocxStyles(docxBuffer);
    const generatedText = await extractDocxText(outputDocxPath);
    console.log(`Generated fonts: ${generatedStyles.fonts.join(', ')}`);
    console.log(`Generated colors: ${generatedStyles.colors.join(', ')}`);
    console.log(`Generated tables: ${generatedStyles.tables.count}`);
    console.log(`Generated text: ${generatedText.length} chars`);

    // Step 7: Compare against template
    console.log('\n[STEP 7] Comparing output to template...');
    const issues = compareDocxToTemplate(
      generatedStyles,
      templateStyles,
      generatedText,
      templateSections
    );

    // Step 8: Report issues
    console.log('\n' + '='.repeat(60));
    console.log('ISSUES FOUND');
    console.log('='.repeat(60));

    if (issues.length === 0) {
      console.log('\n[OK] No issues found! Report matches template expectations.');
    } else {
      const highIssues = issues.filter((i) => i.severity === 'HIGH');
      const mediumIssues = issues.filter((i) => i.severity === 'MEDIUM');
      const lowIssues = issues.filter((i) => i.severity === 'LOW');

      if (highIssues.length > 0) {
        console.log(`\n[HIGH SEVERITY] (${highIssues.length})`);
        highIssues.forEach((i) => console.log(`  X ${i.type}: ${i.detail}`));
      }

      if (mediumIssues.length > 0) {
        console.log(`\n[MEDIUM SEVERITY] (${mediumIssues.length})`);
        mediumIssues.forEach((i) => console.log(`  ! ${i.type}: ${i.detail}`));
      }

      if (lowIssues.length > 0) {
        console.log(`\n[LOW SEVERITY] (${lowIssues.length})`);
        lowIssues.forEach((i) => console.log(`  - ${i.type}: ${i.detail}`));
      }

      console.log(`\nTotal issues: ${issues.length}`);
    }

    // Save report JSON for inspection
    if (report.reportJson) {
      const jsonPath = path.join(OUTPUT_DIR, `dd-test-output-${reportId}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(report.reportJson, null, 2));
      console.log(`\nReport JSON saved to: ${jsonPath}`);
    }

    console.log(`\nGenerated DOCX: ${outputDocxPath}`);

    // Return exit code based on high severity issues
    process.exit(issues.filter((i) => i.severity === 'HIGH').length > 0 ? 1 : 0);
  } catch (error) {
    console.error('\n[ERROR]', error.message);
    console.error(error.stack);
    process.exit(2);
  }
}

main();
