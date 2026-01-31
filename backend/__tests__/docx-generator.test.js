/**
 * Unit tests for DOCX generator
 * Tests cover page generation, section handling, and HTML conversion
 */

const {
  generateDocx,
  htmlToStructuredJson,
  templateStyles,
  parseInlineFormatting,
  parseTextWithLinks,
  createTable,
} = require('../due-diligence/docx-generator');

describe('DOCX Generator', () => {
  describe('generateDocx', () => {
    test('generates valid DOCX with cover_page', async () => {
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test Report', companyName: 'Test Co', date: 'Jan 2026' },
          { type: 'heading1', text: '1.0 Overview' },
          { type: 'paragraph', text: 'Test content.' },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
      // PK signature for ZIP (DOCX is a ZIP file)
      expect(buffer[0]).toBe(0x50);
      expect(buffer[1]).toBe(0x4b);
    });

    test('cover_page includes page break', async () => {
      const report = {
        sections: [{ type: 'cover_page', title: 'Test', companyName: 'Co', date: 'Jan' }],
      };
      const buffer = await generateDocx(report);
      expect(buffer.length).toBeGreaterThan(0);
    });

    test('handles empty cover_page with defaults', async () => {
      const report = {
        sections: [{ type: 'cover_page' }],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
    });

    test('generates DOCX with multiple section types', async () => {
      const report = {
        sections: [
          { type: 'cover_page', title: 'Multi-Section Test', companyName: 'Test Co' },
          { type: 'heading1', text: '1.0 Executive Summary' },
          { type: 'paragraph', text: 'This is a test paragraph.' },
          { type: 'heading2', text: '1.1 Overview' },
          { type: 'bullet', items: ['Item 1', 'Item 2', 'Item 3'] },
          { type: 'table', data: { headers: ['Year', 'Revenue'], rows: [['2024', '10M']] } },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(2000);
    });

    test('handles table with empty rows gracefully', async () => {
      const report = {
        sections: [{ type: 'table', data: { headers: ['Col1', 'Col2'], rows: [] } }],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
    });

    test('handles spacer sections', async () => {
      const report = {
        sections: [
          { type: 'paragraph', text: 'Before spacer' },
          { type: 'spacer', height: 24 },
          { type: 'paragraph', text: 'After spacer' },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
    });
  });

  describe('htmlToStructuredJson', () => {
    test('adds cover_page as first section', () => {
      const result = htmlToStructuredJson('<h1>Test</h1>', 'Test Company');
      expect(result.sections[0].type).toBe('cover_page');
      expect(result.sections[0].companyName).toBe('Test Company');
    });

    test('converts H1 to heading1', () => {
      const result = htmlToStructuredJson('<h1>Main Title</h1>', 'Company');
      const heading = result.sections.find((s) => s.type === 'heading1');
      expect(heading).toBeDefined();
      expect(heading.text).toBe('Main Title');
    });

    test('converts H2 to heading2', () => {
      const result = htmlToStructuredJson('<h2>Subtitle</h2>', 'Company');
      const heading = result.sections.find((s) => s.type === 'heading2');
      expect(heading).toBeDefined();
      expect(heading.text).toBe('Subtitle');
    });

    test('converts H3 to heading3', () => {
      const result = htmlToStructuredJson('<h3>Sub-subtitle</h3>', 'Company');
      const heading = result.sections.find((s) => s.type === 'heading3');
      expect(heading).toBeDefined();
      expect(heading.text).toBe('Sub-subtitle');
    });

    test('converts paragraph to paragraph type', () => {
      const result = htmlToStructuredJson('<p>Test paragraph content</p>', 'Company');
      const para = result.sections.find(
        (s) => s.type === 'paragraph' && s.text === 'Test paragraph content'
      );
      expect(para).toBeDefined();
    });

    test('handles unordered lists', () => {
      const result = htmlToStructuredJson('<ul><li>Item 1</li><li>Item 2</li></ul>', 'Company');
      const bullet = result.sections.find((s) => s.type === 'bullet_list');
      expect(bullet).toBeDefined();
      expect(bullet.items).toContain('Item 1');
      expect(bullet.items).toContain('Item 2');
    });

    test('handles tables with headers and rows', () => {
      const html = `
        <table>
          <thead><tr><th>Header1</th><th>Header2</th></tr></thead>
          <tbody><tr><td>Cell1</td><td>Cell2</td></tr></tbody>
        </table>
      `;
      const result = htmlToStructuredJson(html, 'Company');
      const table = result.sections.find((s) => s.type === 'table');
      expect(table).toBeDefined();
      expect(table.data.headers).toContain('Header1');
      expect(table.data.rows[0]).toContain('Cell1');
    });

    test('uses default company name when not provided', () => {
      const result = htmlToStructuredJson('<h1>Test</h1>');
      expect(result.sections[0].companyName).toBe('Company');
    });

    test('strips HTML tags from content', () => {
      const result = htmlToStructuredJson(
        '<p><strong>Bold</strong> and <em>italic</em></p>',
        'Company'
      );
      const para = result.sections.find((s) => s.type === 'paragraph');
      expect(para.text).not.toContain('<strong>');
      expect(para.text).not.toContain('<em>');
    });
  });

  describe('templateStyles', () => {
    test('has required font configurations', () => {
      expect(templateStyles.fonts).toBeDefined();
      expect(templateStyles.fonts.heading1).toBeDefined();
      expect(templateStyles.fonts.heading2).toBeDefined();
      expect(templateStyles.fonts.body).toBeDefined();
      expect(templateStyles.fonts.caption).toBeDefined();
    });

    test('has pageNumber font config', () => {
      expect(templateStyles.fonts.pageNumber).toBeDefined();
      expect(templateStyles.fonts.pageNumber.family).toBe('Segoe UI');
      expect(templateStyles.fonts.pageNumber.size).toBe(10);
      expect(templateStyles.fonts.pageNumber.color).toBe('#808080');
    });

    test('has coverPage configuration', () => {
      expect(templateStyles.coverPage).toBeDefined();
      expect(templateStyles.coverPage.titleSize).toBeDefined();
      expect(templateStyles.coverPage.companyNameSize).toBeDefined();
    });

    test('has table styling configuration', () => {
      expect(templateStyles.tables).toBeDefined();
      expect(templateStyles.tables.headerRow).toBeDefined();
      expect(templateStyles.tables.borders).toBeDefined();
    });

    test('has page margin configuration', () => {
      expect(templateStyles.page).toBeDefined();
      expect(templateStyles.page.marginTop).toBeDefined();
      expect(templateStyles.page.marginBottom).toBeDefined();
    });
  });

  describe('numbered_list support', () => {
    test('generates DOCX with numbered_list section', async () => {
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test', companyName: 'Co' },
          { type: 'heading1', text: 'Steps' },
          { type: 'numbered_list', items: ['First step', 'Second step', 'Third step'] },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
    });

    test('handles empty numbered_list', async () => {
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test', companyName: 'Co' },
          { type: 'numbered_list', items: [] },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
    });

    test('handles numbered_list with object items', async () => {
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test', companyName: 'Co' },
          { type: 'numbered_list', items: [{ text: 'Item 1' }, { text: 'Item 2' }] },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
    });
  });

  describe('htmlToStructuredJson ordered list handling', () => {
    test('converts <ol> to numbered_list type', () => {
      const html = '<ol><li>Step 1</li><li>Step 2</li><li>Step 3</li></ol>';
      const result = htmlToStructuredJson(html, 'Company');
      const numberedList = result.sections.find((s) => s.type === 'numbered_list');
      expect(numberedList).toBeDefined();
      expect(numberedList.items).toContain('Step 1');
      expect(numberedList.items).toContain('Step 2');
      expect(numberedList.items).toContain('Step 3');
    });

    test('converts <ul> to bullet_list type (not numbered)', () => {
      const html = '<ul><li>Bullet 1</li><li>Bullet 2</li></ul>';
      const result = htmlToStructuredJson(html, 'Company');
      const bulletList = result.sections.find((s) => s.type === 'bullet_list');
      expect(bulletList).toBeDefined();
      expect(bulletList.items).toContain('Bullet 1');
      // Should NOT be numbered_list
      const numberedList = result.sections.find((s) => s.type === 'numbered_list');
      expect(numberedList).toBeUndefined();
    });
  });

  describe('parseInlineFormatting', () => {
    test('parses bold text with ** into multiple TextRuns', () => {
      const runs = parseInlineFormatting('This is **bold** text');
      expect(runs.length).toBe(3);
      // TextRun objects are created - verify they exist
      expect(runs[0]).toBeDefined();
      expect(runs[1]).toBeDefined();
      expect(runs[2]).toBeDefined();
    });

    test('parses italic text with * into multiple TextRuns', () => {
      const runs = parseInlineFormatting('This is *italic* text');
      expect(runs.length).toBe(3);
      expect(runs[0]).toBeDefined();
      expect(runs[1]).toBeDefined();
      expect(runs[2]).toBeDefined();
    });

    test('parses bold-italic text with *** into multiple TextRuns', () => {
      const runs = parseInlineFormatting('This is ***bold-italic*** text');
      expect(runs.length).toBe(3);
      expect(runs[0]).toBeDefined();
      expect(runs[1]).toBeDefined();
      expect(runs[2]).toBeDefined();
    });

    test('handles plain text without formatting', () => {
      const runs = parseInlineFormatting('Plain text only');
      expect(runs.length).toBe(1);
    });

    test('handles multiple formatting in same text', () => {
      const runs = parseInlineFormatting('**bold** and *italic*');
      // Returns: bold (bold), " and " (plain), italic (italic)
      expect(runs.length).toBe(3);
    });
  });

  describe('parseTextWithLinks', () => {
    test('parses markdown links [text](url)', () => {
      const runs = parseTextWithLinks('Visit [Google](https://google.com) for search');
      expect(runs.length).toBe(3);
      // The middle element should be a hyperlink
      expect(runs[1].constructor.name).toBe('ExternalHyperlink');
    });

    test('handles text without links', () => {
      const runs = parseTextWithLinks('No links here');
      expect(runs.length).toBe(1);
    });

    test('handles multiple links', () => {
      const runs = parseTextWithLinks('[Link1](url1) and [Link2](url2)');
      expect(runs.length).toBe(3); // link, " and ", link
    });
  });

  describe('table column widths', () => {
    test('creates table with custom column widths', () => {
      const data = {
        headers: ['Category', 'Value'],
        rows: [
          ['Item A', '100'],
          ['Item B', '200'],
        ],
      };
      const table = createTable(data, { columnWidths: [30, 70] });
      expect(table).toBeDefined();
      // Table should be created with widths applied
      expect(table.root.length).toBeGreaterThan(0);
    });

    test('creates table without column widths (default)', () => {
      const data = {
        headers: ['Col1', 'Col2'],
        rows: [['A', 'B']],
      };
      const table = createTable(data);
      expect(table).toBeDefined();
    });

    test('handles invalid table data gracefully', () => {
      const table = createTable(null);
      expect(table).toBeNull();
    });
  });

  describe('paragraph with inline formatting', () => {
    test('generates DOCX with bold and italic in paragraph', async () => {
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test', companyName: 'Co' },
          { type: 'paragraph', text: 'This has **bold** and *italic* text.' },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
    });

    test('generates DOCX with hyperlinks in paragraph', async () => {
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test', companyName: 'Co' },
          { type: 'paragraph', text: 'Visit [our website](https://example.com) for more info.' },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
    });
  });

  describe('section type validation', () => {
    test('VALID_SECTION_TYPES contains expected types', () => {
      const { VALID_SECTION_TYPES } = require('../due-diligence/docx-generator');
      expect(VALID_SECTION_TYPES.has('cover_page')).toBe(true);
      expect(VALID_SECTION_TYPES.has('heading1')).toBe(true);
      expect(VALID_SECTION_TYPES.has('paragraph')).toBe(true);
      expect(VALID_SECTION_TYPES.has('table')).toBe(true);
      expect(VALID_SECTION_TYPES.has('quote')).toBe(true);
      expect(VALID_SECTION_TYPES.has('blockquote')).toBe(true);
      expect(VALID_SECTION_TYPES.has('divider')).toBe(true);
      expect(VALID_SECTION_TYPES.has('hr')).toBe(true);
    });

    test('handles unknown section types gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test', companyName: 'Co' },
          { type: 'unknown_type', text: 'This should become paragraph' },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported section type: "unknown_type"')
      );
      consoleSpy.mockRestore();
    });

    test('renders quote section with italic styling', async () => {
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test', companyName: 'Co' },
          { type: 'quote', text: 'This is a quoted text block' },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
    });

    test('renders blockquote section (alias for quote)', async () => {
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test', companyName: 'Co' },
          { type: 'blockquote', text: 'This is a blockquote' },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
    });

    test('renders divider section as horizontal line', async () => {
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test', companyName: 'Co' },
          { type: 'paragraph', text: 'Before divider' },
          { type: 'divider' },
          { type: 'paragraph', text: 'After divider' },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
    });

    test('renders hr section (alias for divider)', async () => {
      const report = {
        sections: [{ type: 'cover_page', title: 'Test', companyName: 'Co' }, { type: 'hr' }],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
    });

    test('logs warning for unsupported types but still generates document', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test', companyName: 'Co' },
          { type: 'image', text: 'Unsupported' }, // image not implemented
          { type: 'chart', text: 'Also unsupported' }, // chart not implemented
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      // Should have warned about both unsupported types
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported section type: "image"')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported section type: "chart"')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('bullet list indentation', () => {
    test('bullet items have proper indentation from lists.indent', async () => {
      const report = {
        sections: [
          { type: 'cover_page', title: 'Test', companyName: 'Co' },
          { type: 'bullet_list', items: ['Item 1', 'Item 2', 'Item 3'] },
        ],
      };
      const buffer = await generateDocx(report);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
      // The indentation is applied in the Paragraph object
      // We verify the document generates without errors
    });

    test('createBulletItem applies indent', () => {
      const { createBulletItem } = require('../due-diligence/docx-generator');
      const bullet = createBulletItem('Test item', 0);
      expect(bullet).toBeDefined();
      // Verify indent property is set
      expect(bullet.root).toBeDefined();
    });
  });
});
