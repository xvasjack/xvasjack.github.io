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
  AlignmentType,
  Footer,
  PageNumber,
  ExternalHyperlink,
  ImageRun,
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

// Create a body paragraph with support for inline formatting and hyperlinks
function createParagraph(text, options = {}) {
  // Handle text with potential inline formatting
  let runs = [];
  if (typeof text === 'string') {
    // Check for hyperlinks or inline formatting
    if (text.includes('[') && text.includes('](')) {
      runs = parseTextWithLinks(text, options);
    } else if (text.includes('**') || text.includes('*')) {
      runs = parseInlineFormatting(text, options);
    } else {
      runs.push(createTextRun(text, 'body', options));
    }
  } else if (Array.isArray(text)) {
    // Array of text runs with different formatting
    for (const item of text) {
      if (typeof item === 'string') {
        if (item.includes('**') || item.includes('*')) {
          runs.push(...parseInlineFormatting(item, options));
        } else {
          runs.push(createTextRun(item, 'body', options));
        }
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
    indent: { left: pointsToTwips(templateStyles.lists.indent) },
    children: [createTextRun(text, 'body')],
  });
}

// Parse inline markdown-style formatting (**bold**, *italic*, ***bold-italic***)
function parseInlineFormatting(text, baseOptions = {}) {
  const runs = [];
  // Match ***bold-italic***, **bold**, *italic*, or plain text
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|([^*]+))/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      // bold-italic (***text***)
      runs.push(createTextRun(match[2], 'body', { ...baseOptions, bold: true, italic: true }));
    } else if (match[3]) {
      // bold (**text**)
      runs.push(createTextRun(match[3], 'body', { ...baseOptions, bold: true }));
    } else if (match[4]) {
      // italic (*text*)
      runs.push(createTextRun(match[4], 'body', { ...baseOptions, italic: true }));
    } else if (match[5]) {
      // plain text
      runs.push(createTextRun(match[5], 'body', baseOptions));
    }
  }

  return runs.length > 0 ? runs : [createTextRun(text, 'body', baseOptions)];
}

// Create a hyperlink with proper styling
function createHyperlink(text, url) {
  return new ExternalHyperlink({
    children: [
      new TextRun({
        text: text,
        style: 'Hyperlink',
      }),
    ],
    link: url,
  });
}

// Parse text with potential hyperlinks in markdown format [text](url)
function parseTextWithLinks(text, baseOptions = {}) {
  const runs = [];
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = linkRegex.exec(text)) !== null) {
    // Add text before the link
    if (match.index > lastIndex) {
      const beforeText = text.slice(lastIndex, match.index);
      runs.push(...parseInlineFormatting(beforeText, baseOptions));
    }
    // Add the hyperlink
    runs.push(createHyperlink(match[1], match[2]));
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last link
  if (lastIndex < text.length) {
    const afterText = text.slice(lastIndex);
    runs.push(...parseInlineFormatting(afterText, baseOptions));
  }

  return runs.length > 0 ? runs : parseInlineFormatting(text, baseOptions);
}

// Create a table with template styling
// options.columnWidths: Array of percentages [30, 70] or absolute values in twips
function createTable(data, options = {}) {
  if (!data || !data.headers || !data.rows) {
    console.warn('Invalid table data:', data);
    return null;
  }

  const tableStyle = templateStyles.tables;
  const { columnWidths } = options;

  // Calculate column widths if provided
  const getColumnWidth = (index) => {
    if (!columnWidths || !columnWidths[index]) return undefined;
    const width = columnWidths[index];
    // If width is a percentage (<=100), convert to percentage type
    // Otherwise treat as absolute twips
    if (width <= 100) {
      return { size: width, type: WidthType.PERCENTAGE };
    }
    return { size: width, type: WidthType.DXA };
  };

  // Create header row
  const headerCells = data.headers.map((header, index) => {
    const cellConfig = {
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
    };
    const colWidth = getColumnWidth(index);
    if (colWidth) {
      cellConfig.width = colWidth;
    }
    return new TableCell(cellConfig);
  });

  const headerRow = new TableRow({
    tableHeader: true,
    children: headerCells,
  });

  // Create data rows
  const dataRows = data.rows.map((row, rowIndex) => {
    const isAltRow = rowIndex % 2 === 1;
    const bgColor = isAltRow ? tableStyle.bodyRow.altBgColor : tableStyle.bodyRow.bgColor;

    const cells = row.map((cell, colIndex) => {
      const cellConfig = {
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
      };
      const colWidth = getColumnWidth(colIndex);
      if (colWidth) {
        cellConfig.width = colWidth;
      }
      return new TableCell(cellConfig);
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

// Valid section types whitelist
const VALID_SECTION_TYPES = new Set([
  'title',
  'subtitle',
  'date',
  'heading1',
  'heading2',
  'heading3',
  'paragraph',
  'text',
  'bullet_list',
  'bullet',
  'numbered_list',
  'table',
  'page_break',
  'spacer',
  'cover_page',
  'quote',
  'blockquote',
  'divider',
  'hr',
  'figure', // Includes figure for org charts
]);

// Build document content from structured sections
function buildDocumentContent(sections) {
  const children = [];

  // Validate section types and warn about unsupported ones
  for (const section of sections) {
    if (section.type && !VALID_SECTION_TYPES.has(section.type)) {
      console.warn(`[DOCX] Unsupported section type: "${section.type}", treating as paragraph`);
    }
  }

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
                size: pointsToHalfPoints(templateStyles.fonts.heading1.size),
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

      case 'numbered_list': {
        // Render numbered list items with manual numbering
        const items = section.items || [];
        items.forEach((item, idx) => {
          const itemText = typeof item === 'string' ? item : item.text || '';
          children.push(
            new Paragraph({
              spacing: {
                before: pointsToTwips(templateStyles.lists.spacing),
                after: pointsToTwips(templateStyles.lists.spacing),
              },
              indent: { left: pointsToTwips(templateStyles.lists.indent) },
              children: [
                new TextRun({
                  text: `${idx + 1}. ${itemText}`,
                  font: templateStyles.fonts.body.family,
                  size: pointsToHalfPoints(templateStyles.fonts.body.size),
                  color: hexToDocx(templateStyles.fonts.body.color),
                }),
              ],
            })
          );
        });
        break;
      }

      case 'table': {
        const tableOptions = {};
        if (section.columnWidths) {
          tableOptions.columnWidths = section.columnWidths;
        }
        const table = createTable(section.data, tableOptions);
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

      case 'cover_page': {
        // Handle empty cover page
        if (!section.title && !section.companyName) {
          section.title = 'PRE-DUE DILIGENCE REPORT';
          section.companyName = 'Company';
        }

        // Cover page configuration
        const coverConfig = templateStyles.coverPage || {
          titleSize: 20,
          companyNameSize: 16,
          verticalOffset: 200,
        };

        // Add vertical spacing to center content (~200pt from top for A4)
        children.push(
          new Paragraph({
            spacing: { before: pointsToTwips(coverConfig.verticalOffset), after: 0 },
            children: [],
          })
        );

        // Title - centered, larger font (20pt)
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: pointsToTwips(12) },
            children: [
              new TextRun({
                text: section.title || 'PRE-DUE DILIGENCE REPORT',
                font: templateStyles.fonts.heading1.family,
                size: pointsToHalfPoints(coverConfig.titleSize),
                bold: true,
                color: hexToDocx(templateStyles.fonts.heading1.color),
              }),
            ],
          })
        );

        // Company name - centered, on separate line
        if (section.companyName) {
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: pointsToTwips(24) },
              children: [
                new TextRun({
                  text: section.companyName,
                  font: templateStyles.fonts.heading1.family,
                  size: pointsToHalfPoints(coverConfig.companyNameSize),
                  bold: true,
                  color: hexToDocx(templateStyles.fonts.heading2.color),
                }),
              ],
            })
          );
        }

        // Prepared for client - centered
        if (section.preparedFor) {
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: pointsToTwips(12) },
              children: [
                new TextRun({
                  text: `Prepared for ${section.preparedFor}`,
                  font: templateStyles.fonts.body.family,
                  size: pointsToHalfPoints(12),
                  color: hexToDocx(templateStyles.fonts.body.color),
                }),
              ],
            })
          );
        }

        // Purpose statement - centered
        if (section.purpose) {
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: pointsToTwips(24) },
              children: [
                new TextRun({
                  text: section.purpose,
                  font: templateStyles.fonts.body.family,
                  size: pointsToHalfPoints(11),
                  italics: true,
                  color: hexToDocx(templateStyles.fonts.caption.color),
                }),
              ],
            })
          );
        }

        // Date - centered
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: pointsToTwips(48) },
            children: [
              new TextRun({
                text: section.date || `Prepared: ${new Date().toLocaleDateString()}`,
                font: templateStyles.fonts.caption.family,
                size: pointsToHalfPoints(templateStyles.fonts.caption.size),
                color: hexToDocx(templateStyles.fonts.caption.color),
                italics: templateStyles.fonts.caption.italic,
              }),
            ],
          })
        );

        // Confidential disclaimer - centered, at bottom
        if (section.confidential) {
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: pointsToTwips(48), after: pointsToTwips(24) },
              children: [
                new TextRun({
                  text: section.confidential,
                  font: templateStyles.fonts.caption.family,
                  size: pointsToHalfPoints(9),
                  italics: true,
                  color: hexToDocx('#666666'),
                }),
              ],
            })
          );
        }

        // Page break after cover
        children.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      }

      case 'quote':
      case 'blockquote': {
        children.push(
          new Paragraph({
            spacing: { before: pointsToTwips(12), after: pointsToTwips(12) },
            indent: { left: pointsToTwips(36), right: pointsToTwips(36) },
            children: [
              new TextRun({
                text: section.text || '',
                font: templateStyles.fonts.body.family,
                size: pointsToHalfPoints(templateStyles.fonts.body.size),
                italics: true,
                color: hexToDocx('#666666'),
              }),
            ],
          })
        );
        break;
      }

      case 'divider':
      case 'hr': {
        children.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } },
            spacing: { before: pointsToTwips(12), after: pointsToTwips(12) },
            children: [],
          })
        );
        break;
      }

      case 'figure': {
        // Handle figure with image (e.g., organization chart)
        if (section.imageBase64) {
          try {
            const imageBuffer = Buffer.from(section.imageBase64, 'base64');
            children.push(
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: pointsToTwips(12), after: pointsToTwips(6) },
                children: [
                  new ImageRun({
                    data: imageBuffer,
                    transformation: {
                      width: section.width || 500,
                      height: section.height || 300,
                    },
                  }),
                ],
              })
            );
          } catch (imgError) {
            console.warn('[DOCX] Failed to insert image:', imgError.message);
          }
        }
        // Caption for the figure
        if (section.caption) {
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: pointsToTwips(4), after: pointsToTwips(12) },
              children: [
                new TextRun({
                  text: section.caption,
                  font: templateStyles.fonts.caption.family,
                  size: pointsToHalfPoints(templateStyles.fonts.caption.size),
                  italics: true,
                  color: hexToDocx(templateStyles.fonts.caption.color),
                }),
              ],
            })
          );
        }
        break;
      }

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
      characterStyles: [
        {
          id: 'Hyperlink',
          name: 'Hyperlink',
          basedOn: 'DefaultParagraphFont',
          run: {
            color: hexToDocx(templateStyles.fonts.heading2.color),
            underline: { type: 'single' },
          },
        },
      ],
    },
    defaultTabStop: 720,
    creator: 'DD Report Generator',
    title: 'Due Diligence Report',
    theme: {
      majorFont: templateStyles.fonts.heading1.family,
      minorFont: templateStyles.fonts.body.family,
      colors: {
        accent1: hexToDocx(templateStyles.tables.headerRow.bgColor),
        accent2: hexToDocx(templateStyles.fonts.heading1.color),
        dark1: '000000',
        dark2: hexToDocx(templateStyles.fonts.heading1.color),
        light1: 'FFFFFF',
        light2: hexToDocx(templateStyles.tables.bodyRow.altBgColor),
        hyperlink: hexToDocx(templateStyles.fonts.heading2.color),
        followedHyperlink: hexToDocx(templateStyles.fonts.heading1.color),
      },
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
          titlePage: true, // Different first page (no page number on cover)
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  (() => {
                    const pageNumStyle =
                      templateStyles.fonts.pageNumber || templateStyles.fonts.caption;
                    return new TextRun({
                      children: [PageNumber.CURRENT],
                      font: pageNumStyle.family,
                      size: pointsToHalfPoints(pageNumStyle.size),
                      color: hexToDocx(pageNumStyle.color),
                    });
                  })(),
                ],
              }),
            ],
          }),
          first: new Footer({
            children: [], // Empty footer for cover page (no page number)
          }),
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

  // Add cover page (centered title, company name, date with page break)
  sections.push({
    type: 'cover_page',
    title: 'PRE-DUE DILIGENCE REPORT',
    companyName: companyName,
    preparedFor: 'Sun Corporation',
    purpose:
      'Evaluation of Minority Investment with Path to Majority / Full Acquisition (5–10 Years)',
    confidential: 'This report is confidential and prepared solely for internal discussion.',
    date: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
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
    } else if (/<ol[^>]*>/i.test(trimmed)) {
      // Parse ordered list as numbered_list
      const items = [];
      const liMatches = trimmed.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi);
      for (const match of liMatches) {
        const itemText = match[1].replace(/<[^>]+>/g, '').trim();
        if (itemText) items.push(itemText);
      }
      if (items.length > 0) {
        sections.push({ type: 'numbered_list', items });
      }
    } else if (/<ul[^>]*>/i.test(trimmed)) {
      // Parse unordered list as bullet_list
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
  parseInlineFormatting,
  createHyperlink,
  parseTextWithLinks,
  templateStyles,
  VALID_SECTION_TYPES,
};
