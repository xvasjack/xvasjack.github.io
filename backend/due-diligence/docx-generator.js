/**
 * DOCX Generator for Due Diligence Reports
 * Generates pixel-perfect DOCX output matching template styling
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  BorderStyle,
  WidthType,
  ShadingType,
  PageBreak,
} = require('docx');

const templateStyles = require('./template-styles.json');

// Convert hex color to docx format (remove # prefix)
function hexToDocx(hex) {
  return hex.replace('#', '');
}

// Convert points to half-points (docx font size unit)
function pointsToHalfPoints(points) {
  return points * 2;
}

// Convert points to twips (1 point = 20 twips)
function pointsToTwips(points) {
  return points * 20;
}

// Create a text run with template styling
function createTextRun(text, style = 'body', options = {}) {
  const fontStyle = templateStyles.fonts[style] || templateStyles.fonts.body;

  return new TextRun({
    text: text,
    font: fontStyle.family,
    size: pointsToHalfPoints(options.size || fontStyle.size),
    bold: options.bold !== undefined ? options.bold : fontStyle.bold,
    italics: options.italic !== undefined ? options.italic : fontStyle.italic,
    color: hexToDocx(options.color || fontStyle.color || '000000'),
  });
}

// Create a heading paragraph
function createHeading(text, level = 1) {
  const headingMap = {
    1: { style: 'heading1', level: HeadingLevel.HEADING_1 },
    2: { style: 'heading2', level: HeadingLevel.HEADING_2 },
    3: { style: 'heading3', level: HeadingLevel.HEADING_3 },
  };

  const config = headingMap[level] || headingMap[1];
  const fontStyle = templateStyles.fonts[config.style];

  return new Paragraph({
    heading: config.level,
    spacing: {
      before: pointsToTwips(templateStyles.paragraphs.spacing.before * 2),
      after: pointsToTwips(templateStyles.paragraphs.spacing.after),
    },
    children: [
      new TextRun({
        text: text,
        font: fontStyle.family,
        size: pointsToHalfPoints(fontStyle.size),
        bold: fontStyle.bold,
        color: hexToDocx(fontStyle.color),
      }),
    ],
  });
}

// Create a body paragraph
function createParagraph(text, options = {}) {
  // Handle text with potential inline formatting
  const runs = [];
  if (typeof text === 'string') {
    runs.push(createTextRun(text, 'body', options));
  } else if (Array.isArray(text)) {
    // Array of text runs with different formatting
    for (const item of text) {
      if (typeof item === 'string') {
        runs.push(createTextRun(item, 'body', options));
      } else if (item.text) {
        runs.push(createTextRun(item.text, 'body', { ...options, ...item }));
      }
    }
  }

  return new Paragraph({
    spacing: {
      before: pointsToTwips(options.spacingBefore || templateStyles.paragraphs.spacing.before),
      after: pointsToTwips(options.spacingAfter || templateStyles.paragraphs.spacing.after),
      line: Math.round((templateStyles.paragraphs.spacing.line / 100) * 240),
    },
    indent: options.indent ? { left: pointsToTwips(options.indent) } : undefined,
    children: runs,
  });
}

// Create a bullet list item
function createBulletItem(text, level = 0) {
  return new Paragraph({
    bullet: { level: level },
    spacing: {
      before: pointsToTwips(templateStyles.lists.spacing),
      after: pointsToTwips(templateStyles.lists.spacing),
    },
    children: [createTextRun(text, 'body')],
  });
}

// Create a table with template styling
function createTable(data, _options = {}) {
  if (!data || !data.headers || !data.rows) {
    console.warn('Invalid table data:', data);
    return null;
  }

  const tableStyle = templateStyles.tables;

  // Create header row
  const headerCells = data.headers.map((header) => {
    return new TableCell({
      shading: {
        type: ShadingType.SOLID,
        color: hexToDocx(tableStyle.headerRow.bgColor),
        fill: hexToDocx(tableStyle.headerRow.bgColor),
      },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 8, color: hexToDocx(tableStyle.borders.color) },
        bottom: { style: BorderStyle.SINGLE, size: 8, color: hexToDocx(tableStyle.borders.color) },
        left: { style: BorderStyle.SINGLE, size: 8, color: hexToDocx(tableStyle.borders.color) },
        right: { style: BorderStyle.SINGLE, size: 8, color: hexToDocx(tableStyle.borders.color) },
      },
      margins: {
        top: pointsToTwips(tableStyle.cellPadding.top),
        bottom: pointsToTwips(tableStyle.cellPadding.bottom),
        left: pointsToTwips(tableStyle.cellPadding.left),
        right: pointsToTwips(tableStyle.cellPadding.right),
      },
      children: [
        new Paragraph({
          children: [
            new TextRun({
              text: String(header),
              font: templateStyles.fonts.body.family,
              size: pointsToHalfPoints(tableStyle.headerRow.fontSize),
              bold: tableStyle.headerRow.bold,
              color: hexToDocx(tableStyle.headerRow.textColor),
            }),
          ],
        }),
      ],
    });
  });

  const headerRow = new TableRow({
    tableHeader: true,
    children: headerCells,
  });

  // Create data rows
  const dataRows = data.rows.map((row, rowIndex) => {
    const isAltRow = rowIndex % 2 === 1;
    const bgColor = isAltRow ? tableStyle.bodyRow.altBgColor : tableStyle.bodyRow.bgColor;

    const cells = row.map((cell) => {
      return new TableCell({
        shading: {
          type: ShadingType.SOLID,
          color: hexToDocx(bgColor),
          fill: hexToDocx(bgColor),
        },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 4, color: hexToDocx(tableStyle.borders.color) },
          bottom: {
            style: BorderStyle.SINGLE,
            size: 4,
            color: hexToDocx(tableStyle.borders.color),
          },
          left: { style: BorderStyle.SINGLE, size: 4, color: hexToDocx(tableStyle.borders.color) },
          right: { style: BorderStyle.SINGLE, size: 4, color: hexToDocx(tableStyle.borders.color) },
        },
        margins: {
          top: pointsToTwips(tableStyle.cellPadding.top),
          bottom: pointsToTwips(tableStyle.cellPadding.bottom),
          left: pointsToTwips(tableStyle.cellPadding.left),
          right: pointsToTwips(tableStyle.cellPadding.right),
        },
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: String(cell ?? ''),
                font: templateStyles.fonts.body.family,
                size: pointsToHalfPoints(tableStyle.bodyRow.fontSize),
                color: hexToDocx(templateStyles.fonts.body.color),
              }),
            ],
          }),
        ],
      });
    });

    return new TableRow({ children: cells });
  });

  return new Table({
    width: {
      size: 100,
      type: WidthType.PERCENTAGE,
    },
    rows: [headerRow, ...dataRows],
  });
}

// Build document content from structured sections
function buildDocumentContent(sections) {
  const children = [];

  for (const section of sections) {
    switch (section.type) {
      case 'title':
        children.push(
          new Paragraph({
            spacing: { before: 0, after: pointsToTwips(12) },
            children: [
              new TextRun({
                text: section.text,
                font: templateStyles.fonts.heading1.family,
                size: pointsToHalfPoints(20),
                bold: true,
                color: hexToDocx(templateStyles.fonts.heading1.color),
              }),
            ],
          })
        );
        break;

      case 'subtitle':
      case 'date':
        children.push(
          new Paragraph({
            spacing: { before: 0, after: pointsToTwips(6) },
            children: [
              new TextRun({
                text: section.text,
                font: templateStyles.fonts.caption.family,
                size: pointsToHalfPoints(templateStyles.fonts.caption.size),
                color: hexToDocx(templateStyles.fonts.caption.color),
                italics: templateStyles.fonts.caption.italic,
              }),
            ],
          })
        );
        break;

      case 'heading1':
        children.push(createHeading(section.text, 1));
        break;

      case 'heading2':
        children.push(createHeading(section.text, 2));
        break;

      case 'heading3':
        children.push(createHeading(section.text, 3));
        break;

      case 'paragraph':
      case 'text':
        children.push(createParagraph(section.text, section.options || {}));
        break;

      case 'bullet_list':
        if (Array.isArray(section.items)) {
          for (const item of section.items) {
            children.push(createBulletItem(item, section.level || 0));
          }
        }
        break;

      case 'bullet':
        children.push(createBulletItem(section.text, section.level || 0));
        break;

      case 'table': {
        const table = createTable(section.data);
        if (table) {
          // Add spacing before table
          children.push(
            new Paragraph({ spacing: { before: pointsToTwips(6), after: 0 }, children: [] })
          );
          children.push(table);
          // Add spacing after table
          children.push(
            new Paragraph({ spacing: { before: 0, after: pointsToTwips(6) }, children: [] })
          );
        }
        break;
      }

      case 'page_break':
        children.push(
          new Paragraph({
            children: [new PageBreak()],
          })
        );
        break;

      case 'spacer':
        children.push(
          new Paragraph({
            spacing: { before: pointsToTwips(section.height || 12), after: 0 },
            children: [],
          })
        );
        break;

      default:
        console.warn(`Unknown section type: ${section.type}`);
        if (section.text) {
          children.push(createParagraph(section.text));
        }
    }
  }

  return children;
}

// Main DOCX generation function
async function generateDocx(reportJson) {
  console.log('[DOCX] Generating DOCX from structured report...');

  // Validate input
  if (!reportJson) {
    throw new Error('Report JSON is required');
  }

  // Parse sections
  let parsedJson = reportJson;
  if (typeof reportJson === 'string') {
    try {
      parsedJson = JSON.parse(reportJson);
    } catch (e) {
      throw new Error('Invalid JSON string provided');
    }
  }

  const sections = parsedJson.sections || [];
  console.log(`[DOCX] Processing ${sections.length} sections...`);

  // Build document
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: templateStyles.fonts.body.family,
            size: pointsToHalfPoints(templateStyles.fonts.body.size),
          },
          paragraph: {
            spacing: {
              before: pointsToTwips(templateStyles.paragraphs.spacing.before),
              after: pointsToTwips(templateStyles.paragraphs.spacing.after),
              line: Math.round((templateStyles.paragraphs.spacing.line / 100) * 240),
            },
          },
        },
      },
      paragraphStyles: [
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: templateStyles.fonts.heading1.family,
            size: pointsToHalfPoints(templateStyles.fonts.heading1.size),
            bold: templateStyles.fonts.heading1.bold,
            color: hexToDocx(templateStyles.fonts.heading1.color),
          },
          paragraph: {
            spacing: {
              before: pointsToTwips(templateStyles.paragraphs.spacing.before * 2),
              after: pointsToTwips(templateStyles.paragraphs.spacing.after),
            },
          },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: templateStyles.fonts.heading2.family,
            size: pointsToHalfPoints(templateStyles.fonts.heading2.size),
            bold: templateStyles.fonts.heading2.bold,
            color: hexToDocx(templateStyles.fonts.heading2.color),
          },
          paragraph: {
            spacing: {
              before: pointsToTwips(templateStyles.paragraphs.spacing.before * 1.5),
              after: pointsToTwips(templateStyles.paragraphs.spacing.after),
            },
          },
        },
        {
          id: 'Heading3',
          name: 'Heading 3',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: {
            font: templateStyles.fonts.heading3.family,
            size: pointsToHalfPoints(templateStyles.fonts.heading3.size),
            bold: templateStyles.fonts.heading3.bold,
            color: hexToDocx(templateStyles.fonts.heading3.color),
          },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: pointsToTwips(templateStyles.page.marginTop),
              right: pointsToTwips(templateStyles.page.marginRight),
              bottom: pointsToTwips(templateStyles.page.marginBottom),
              left: pointsToTwips(templateStyles.page.marginLeft),
            },
          },
        },
        children: buildDocumentContent(sections),
      },
    ],
  });

  // Generate buffer
  const buffer = await Packer.toBuffer(doc);
  console.log(`[DOCX] Generated ${buffer.length} bytes`);

  return buffer;
}

// Convert HTML report to structured JSON (for backward compatibility)
function htmlToStructuredJson(html, companyName = 'Company') {
  console.log('[DOCX] Converting HTML to structured JSON...');

  const sections = [];

  // Add title
  sections.push({
    type: 'title',
    text: `Due Diligence Report: ${companyName}`,
  });

  // Add date
  sections.push({
    type: 'date',
    text: `Prepared: ${new Date().toLocaleDateString()}`,
  });

  // Parse HTML content
  // Remove script/style tags
  const cleanHtml = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Process content sequentially
  // Split by major elements
  const parts = cleanHtml.split(
    /(<(?:h[1-3]|table|ul|ol|p)[^>]*>[\s\S]*?<\/(?:h[1-3]|table|ul|ol|p)>)/gi
  );

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Check element type
    if (/<h1[^>]*>/i.test(trimmed)) {
      const text = trimmed.replace(/<[^>]+>/g, '').trim();
      if (text) sections.push({ type: 'heading1', text });
    } else if (/<h2[^>]*>/i.test(trimmed)) {
      const text = trimmed.replace(/<[^>]+>/g, '').trim();
      if (text) sections.push({ type: 'heading2', text });
    } else if (/<h3[^>]*>/i.test(trimmed)) {
      const text = trimmed.replace(/<[^>]+>/g, '').trim();
      if (text) sections.push({ type: 'heading3', text });
    } else if (/<table[^>]*>/i.test(trimmed)) {
      // Parse table
      const tableData = parseHtmlTable(trimmed);
      if (tableData) {
        sections.push({ type: 'table', data: tableData });
      }
    } else if (/<ul[^>]*>/i.test(trimmed) || /<ol[^>]*>/i.test(trimmed)) {
      // Parse list
      const items = [];
      const liMatches = trimmed.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi);
      for (const match of liMatches) {
        const itemText = match[1].replace(/<[^>]+>/g, '').trim();
        if (itemText) items.push(itemText);
      }
      if (items.length > 0) {
        sections.push({ type: 'bullet_list', items });
      }
    } else if (/<p[^>]*>/i.test(trimmed)) {
      const text = trimmed.replace(/<[^>]+>/g, '').trim();
      if (text) sections.push({ type: 'paragraph', text });
    } else {
      // Plain text
      const text = trimmed.replace(/<[^>]+>/g, '').trim();
      if (text && text.length > 10) {
        sections.push({ type: 'paragraph', text });
      }
    }
  }

  console.log(`[DOCX] Converted to ${sections.length} sections`);
  return { sections };
}

// Parse HTML table into structured data
function parseHtmlTable(tableHtml) {
  const headers = [];
  const rows = [];

  // Extract header row
  const theadMatch = tableHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  const headerSource = theadMatch ? theadMatch[1] : tableHtml;

  // Get header cells (first tr or thead)
  const headerTrMatch = headerSource.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
  if (headerTrMatch) {
    const thMatches = headerTrMatch[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi);
    for (const match of thMatches) {
      headers.push(match[1].replace(/<[^>]+>/g, '').trim());
    }
  }

  if (headers.length === 0) return null;

  // Extract body rows
  const tbodyMatch = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const bodySource = tbodyMatch ? tbodyMatch[1] : tableHtml;

  const trMatches = bodySource.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  let isFirst = true;

  for (const trMatch of trMatches) {
    // Skip first row if we used it for headers and there's no thead
    if (isFirst && !theadMatch) {
      isFirst = false;
      continue;
    }
    isFirst = false;

    const row = [];
    const tdMatches = trMatch[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi);
    for (const tdMatch of tdMatches) {
      row.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
    }

    if (row.length > 0) {
      rows.push(row);
    }
  }

  return { headers, rows };
}

module.exports = {
  generateDocx,
  htmlToStructuredJson,
  parseHtmlTable,
  createHeading,
  createParagraph,
  createBulletItem,
  createTable,
  templateStyles,
};
