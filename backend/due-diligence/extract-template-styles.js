/**
 * Extract template styles from DD Report DOCX template
 * Parses word/styles.xml and word/document.xml to create template-styles.json
 *
 * Usage: node extract-template-styles.js [path-to-template.docx]
 */

const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

// Default template path
const DEFAULT_TEMPLATE = '/mnt/c/Users/User/Downloads/260114_SunCorp_Netpluz DD Report v4 (1).docx';

// Convert EMU (English Metric Units) to points
// 914400 EMU = 1 inch = 72 points
function _emuToPoints(emu) {
  return Math.round((parseInt(emu, 10) / 914400) * 72);
}

// Convert twips to points (1 point = 20 twips)
function twipsToPoints(twips) {
  return Math.round(parseInt(twips, 10) / 20);
}

// Convert half-points to points
function halfPointsToPoints(hp) {
  return Math.round(parseInt(hp, 10) / 2);
}

// Parse color from various formats (theme, hex, rgb)
function parseColor(colorNode, themeColors) {
  if (!colorNode) return null;

  // Direct hex color
  const val = colorNode.match(/w:val="([^"]+)"/)?.[1];
  if (val && val !== 'auto' && /^[0-9A-Fa-f]{6}$/.test(val)) {
    return `#${val.toUpperCase()}`;
  }

  // Theme color reference
  const themeColor = colorNode.match(/w:themeColor="([^"]+)"/)?.[1];
  if (themeColor && themeColors[themeColor]) {
    return themeColors[themeColor];
  }

  return null;
}

// Extract font info from run properties
function extractFontInfo(rPr) {
  const font = {};

  // Font family
  const fontMatch = rPr.match(/w:rFonts[^>]*w:ascii="([^"]+)"/);
  if (fontMatch) font.family = fontMatch[1];

  // Font size (in half-points)
  const sizeMatch = rPr.match(/<w:sz\s+w:val="(\d+)"[^/]*\/>/);
  if (sizeMatch) font.size = halfPointsToPoints(sizeMatch[1]);

  // Bold
  if (/<w:b(?:\s|\/|>)/.test(rPr) && !/<w:b\s+w:val="(?:0|false)"/.test(rPr)) {
    font.bold = true;
  }

  // Italic
  if (/<w:i(?:\s|\/|>)/.test(rPr) && !/<w:i\s+w:val="(?:0|false)"/.test(rPr)) {
    font.italic = true;
  }

  // Color
  const colorMatch = rPr.match(/<w:color[^>]+>/);
  if (colorMatch) {
    const color = parseColor(colorMatch[0], {});
    if (color) font.color = color;
  }

  return font;
}

// Extract paragraph properties
function extractParagraphProps(pPr) {
  const para = {};

  // Spacing before (in twips)
  const beforeMatch = pPr.match(/w:spacing[^>]*w:before="(\d+)"/);
  if (beforeMatch) para.spacingBefore = twipsToPoints(beforeMatch[1]);

  // Spacing after (in twips)
  const afterMatch = pPr.match(/w:spacing[^>]*w:after="(\d+)"/);
  if (afterMatch) para.spacingAfter = twipsToPoints(afterMatch[1]);

  // Line spacing (in 240ths of a line)
  const lineMatch = pPr.match(/w:spacing[^>]*w:line="(\d+)"/);
  if (lineMatch) para.lineSpacing = Math.round((parseInt(lineMatch[1], 10) / 240) * 100);

  // Indentation
  const leftMatch = pPr.match(/w:ind[^>]*w:left="(\d+)"/);
  if (leftMatch) para.indentLeft = twipsToPoints(leftMatch[1]);

  return para;
}

// Extract table style properties
function _extractTableStyle(tblPr, _tblStylePr) {
  const table = {
    borders: {},
    cell: {},
  };

  // Table borders
  const borderTypes = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
  for (const type of borderTypes) {
    const borderMatch = tblPr.match(
      new RegExp(`<w:${type}[^>]*w:val="([^"]+)"[^>]*w:color="([^"]+)"[^>]*w:sz="(\\d+)"`, 'i')
    );
    if (borderMatch) {
      table.borders[type] = {
        style: borderMatch[1],
        color: `#${borderMatch[2]}`,
        width: Math.round(parseInt(borderMatch[3], 10) / 8), // 8ths of a point
      };
    }
  }

  return table;
}

async function extractTemplateStyles(templatePath) {
  console.log(`\nExtracting styles from: ${templatePath}\n`);

  // Read and unzip the DOCX
  const docxBuffer = fs.readFileSync(templatePath);
  const zip = await JSZip.loadAsync(docxBuffer);

  // Extract XML files
  const stylesXml = await zip.file('word/styles.xml')?.async('string');
  const documentXml = await zip.file('word/document.xml')?.async('string');
  const themeXml = await zip.file('word/theme/theme1.xml')?.async('string');

  if (!stylesXml || !documentXml) {
    throw new Error('Could not find required XML files in DOCX');
  }

  // Initialize styles object
  const styles = {
    metadata: {
      extractedFrom: path.basename(templatePath),
      extractedAt: new Date().toISOString(),
    },
    fonts: {
      heading1: { family: 'Arial', size: 24, bold: true, color: '#1E3A5F' },
      heading2: { family: 'Arial', size: 16, bold: true, color: '#2563EB' },
      heading3: { family: 'Arial', size: 14, bold: true, color: '#1E40AF' },
      body: { family: 'Arial', size: 11, color: '#000000' },
      caption: { family: 'Arial', size: 9, color: '#666666', italic: true },
    },
    tables: {
      headerRow: {
        bgColor: '#1E3A5F',
        textColor: '#FFFFFF',
        bold: true,
        fontSize: 11,
      },
      bodyRow: {
        bgColor: '#FFFFFF',
        altBgColor: '#F0F4FA',
        fontSize: 10,
      },
      borders: {
        color: '#D1D5DB',
        width: 1,
        style: 'single',
      },
      cellPadding: {
        top: 4,
        right: 6,
        bottom: 4,
        left: 6,
      },
    },
    paragraphs: {
      spacing: {
        before: 6, // points
        after: 6, // points
        line: 115, // percent (1.15)
      },
    },
    lists: {
      bullet: '•',
      indent: 36, // points (0.5 inch)
      spacing: 3, // points between items
    },
    page: {
      marginTop: 72, // 1 inch
      marginBottom: 72,
      marginLeft: 72,
      marginRight: 72,
    },
  };

  // Parse theme colors if available
  const themeColors = {};
  if (themeXml) {
    // Extract theme color definitions
    const colorMatches = themeXml.matchAll(/<a:(\w+)\s+val="([0-9A-Fa-f]{6})"/g);
    for (const match of colorMatches) {
      themeColors[match[1]] = `#${match[2].toUpperCase()}`;
    }
    console.log('Theme colors found:', Object.keys(themeColors).length);
  }

  // Parse named styles from styles.xml
  const styleMatches = stylesXml.matchAll(
    /<w:style[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g
  );

  for (const match of styleMatches) {
    const styleId = match[1];
    const styleContent = match[2];

    // Get style name
    const nameMatch = styleContent.match(/w:name\s+w:val="([^"]+)"/);
    const styleName = nameMatch ? nameMatch[1] : styleId;

    // Extract run properties (font settings)
    const rPrMatch = styleContent.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
    const fontInfo = rPrMatch ? extractFontInfo(rPrMatch[1]) : {};

    // Extract paragraph properties
    const pPrMatch = styleContent.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/);
    const paraInfo = pPrMatch ? extractParagraphProps(pPrMatch[1]) : {};

    // Map to our styles structure
    if (styleName.toLowerCase().includes('heading 1') || styleId === 'Heading1') {
      Object.assign(styles.fonts.heading1, fontInfo);
    } else if (styleName.toLowerCase().includes('heading 2') || styleId === 'Heading2') {
      Object.assign(styles.fonts.heading2, fontInfo);
    } else if (styleName.toLowerCase().includes('heading 3') || styleId === 'Heading3') {
      Object.assign(styles.fonts.heading3, fontInfo);
    } else if (styleName.toLowerCase() === 'normal' || styleId === 'Normal') {
      Object.assign(styles.fonts.body, fontInfo);
      if (paraInfo.spacingBefore) styles.paragraphs.spacing.before = paraInfo.spacingBefore;
      if (paraInfo.spacingAfter) styles.paragraphs.spacing.after = paraInfo.spacingAfter;
      if (paraInfo.lineSpacing) styles.paragraphs.spacing.line = paraInfo.lineSpacing;
    }

    console.log(`  Style: ${styleName} (${styleId})`);
  }

  // Analyze actual document content for common patterns
  console.log('\nAnalyzing document content patterns...');

  // Find table styles from actual tables in document
  const tableMatches = documentXml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g);
  let tableCount = 0;

  for (const tblMatch of tableMatches) {
    tableCount++;
    const tableXml = tblMatch[1];

    // Check first row for header styling
    const firstRowMatch = tableXml.match(/<w:tr>([\s\S]*?)<\/w:tr>/);
    if (firstRowMatch) {
      // Look for shading (background color) in first row cells
      const shadingMatch = firstRowMatch[1].match(/<w:shd[^>]*w:fill="([^"]+)"/);
      if (shadingMatch && shadingMatch[1] !== 'auto') {
        styles.tables.headerRow.bgColor = `#${shadingMatch[1].toUpperCase()}`;
      }

      // Look for text color in first row
      const colorMatch = firstRowMatch[1].match(/<w:color[^>]*w:val="([^"]+)"/);
      if (colorMatch && colorMatch[1] !== 'auto' && /^[0-9A-Fa-f]{6}$/.test(colorMatch[1])) {
        styles.tables.headerRow.textColor = `#${colorMatch[1].toUpperCase()}`;
      }
    }

    // Check for alternating row colors
    const allRows = tableXml.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g);
    let rowIndex = 0;
    for (const rowMatch of allRows) {
      if (rowIndex > 0) {
        // Skip header row
        const shadingMatch = rowMatch[1].match(/<w:shd[^>]*w:fill="([^"]+)"/);
        if (shadingMatch && shadingMatch[1] !== 'auto') {
          if (rowIndex % 2 === 0) {
            styles.tables.bodyRow.altBgColor = `#${shadingMatch[1].toUpperCase()}`;
          }
        }
      }
      rowIndex++;
    }
  }

  console.log(`  Found ${tableCount} tables`);

  // Find heading patterns from actual content
  const headingPatterns = documentXml.matchAll(
    /<w:pStyle\s+w:val="(Heading\d+)"[^/]*\/>([\s\S]*?)<\/w:p>/gi
  );
  for (const hMatch of headingPatterns) {
    console.log(`  Found heading style: ${hMatch[1]}`);
  }

  // Extract specific colors used in the document
  const allColors = new Set();
  const colorUses = documentXml.matchAll(/<w:color[^>]*w:val="([0-9A-Fa-f]{6})"/gi);
  for (const cm of colorUses) {
    allColors.add(`#${cm[1].toUpperCase()}`);
  }
  console.log(`  Colors found in document: ${Array.from(allColors).join(', ')}`);

  // Extract shading colors
  const shadingColors = new Set();
  const shadingUses = documentXml.matchAll(/<w:shd[^>]*w:fill="([0-9A-Fa-f]{6})"/gi);
  for (const sm of shadingUses) {
    shadingColors.add(`#${sm[1].toUpperCase()}`);
  }
  console.log(`  Shading colors found: ${Array.from(shadingColors).join(', ')}`);

  // Update styles based on most common colors if we found good matches
  if (allColors.has('#1E3A5F')) styles.fonts.heading1.color = '#1E3A5F';
  if (allColors.has('#2563EB')) styles.fonts.heading2.color = '#2563EB';
  if (shadingColors.has('#1E3A5F')) styles.tables.headerRow.bgColor = '#1E3A5F';

  return styles;
}

async function main() {
  const templatePath = process.argv[2] || DEFAULT_TEMPLATE;

  // Check if template exists
  if (!fs.existsSync(templatePath)) {
    console.error(`Template file not found: ${templatePath}`);
    process.exit(1);
  }

  try {
    const styles = await extractTemplateStyles(templatePath);

    // Write to JSON file
    const outputPath = path.join(__dirname, 'template-styles.json');
    fs.writeFileSync(outputPath, JSON.stringify(styles, null, 2));

    console.log(`\nStyles extracted successfully!`);
    console.log(`Output: ${outputPath}`);
    console.log('\nExtracted styles:');
    console.log(JSON.stringify(styles, null, 2));
  } catch (error) {
    console.error('Error extracting styles:', error.message);
    process.exit(1);
  }
}

main();
