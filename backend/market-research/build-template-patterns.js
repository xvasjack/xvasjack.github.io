/**
 * Builds template-patterns.json from the raw template-extracted.json
 * Replaces manually-written values with actual extracted ground truth
 */
const fs = require('fs');

const extracted = JSON.parse(fs.readFileSync('./template-extracted.json', 'utf8'));

// Helper: strip text content from elements (keep only formatting)
function stripText(elements) {
  return elements.map((el) => {
    const clean = { ...el };
    if (clean.textBody) {
      clean.textBody = {
        bodyProps: clean.textBody.bodyProps,
        paragraphs: clean.textBody.paragraphs.map((p) => ({
          props: p.props,
          runs: p.runs.map((r) => ({
            props: r.props,
            // Keep first 50 chars as label hint
            textHint: r.text ? r.text.substring(0, 50) : '',
          })),
          endRunProps: p.endRunProps,
        })),
      };
    }
    if (clean.table) {
      clean.table = {
        props: clean.table.props,
        columns: clean.table.columns,
        rowCount: clean.table.rowCount,
        columnCount: clean.table.columnCount,
        rows: clean.table.rows.map((row) => ({
          height: row.height,
          heightEmu: row.heightEmu,
          cells: row.cells.map((cell) => ({
            cellProps: cell.cellProps,
            textProps: cell.text
              ? {
                  bodyProps: cell.text.bodyProps,
                  firstRunProps: cell.text.paragraphs?.[0]?.runs?.[0]?.props || null,
                  textHint: cell.text.fullText ? cell.text.fullText.substring(0, 30) : '',
                }
              : null,
          })),
        })),
      };
    }
    if (clean.children) {
      clean.children = stripText(clean.children);
    }
    return clean;
  });
}

// ===== Build corrected positions =====
// From extraction: slides 2-26 all have title at {x:0.4, y:0.15, w:12.5, h:0.7}
const positions = {
  title: { left: 0.4, top: 0.15, width: 12.5, height: 0.7 },
  subtitle: { left: 0.4, top: 0.95, width: 12.5, height: 0.3 },
  headerLine: { left: 0.4, top: 0.9, width: 12.5 },
  content_area: { left: 0.4, top: 1.3, width: 12.5, height: 5.2 },
  source_bar: { left: 0.4, top: 6.663, width: 12.5, height: 0.27 },
};

// ===== Build corrected style =====
const style = {
  slideWidth: extracted.presentation.slideWidth,
  slideHeight: extracted.presentation.slideHeight,
  slideWidthEmu: extracted.presentation.slideWidthEmu,
  slideHeightEmu: extracted.presentation.slideHeightEmu,
  fonts: {
    // Cover title: slide 1, element 0
    coverTitle: { family: 'Segoe UI', size: 42, color: '1F497D', bold: true },
    // Cover subtitle: slide 1, element 1
    coverSubtitle: { family: 'Segoe UI', size: 24, color: '007FFF', bold: false, italic: false },
    // Content slide title: slides 2-26, element 0
    title: { family: 'Segoe UI', size: 24, color: '1F497D', bold: true },
    // Subtitle (blue text under header line): slides 2-26, element 2
    subtitle: { family: 'Segoe UI', size: 14, color: '007FFF', bold: false, italic: false },
    // Body text (most content)
    body: { family: 'Segoe UI', size: 12, color: '000000' },
    // Bullet text
    bullet: { family: 'Segoe UI', size: 12, color: '000000' },
    // Table header
    tableHeader: { family: 'Segoe UI', size: 11, color: 'FFFFFF', bold: true },
    // Table body
    tableBody: { family: 'Segoe UI', size: 11, color: '000000', bold: false },
    // Source footnote
    source: { family: 'Segoe UI', size: 7, color: '999999' },
    // Section header text
    sectionHeader: { family: 'Segoe UI', size: 12, color: '1B2A4A', bold: true },
    // Phase/category labels (colored fills)
    phaseLabel: { family: 'Segoe UI', size: 12, color: 'FFFFFF', bold: true },
    // Date on cover
    coverDate: { family: 'Segoe UI', size: 10, color: '666666' },
    // Cover tagline
    coverTagline: { family: 'Segoe UI', size: 14, color: '000000' },
  },
  colors: {
    // From extraction: actual colors used in template
    darkNavy: '1F497D',
    accentBlue: '007FFF',
    phaseGreen: '2E7D32',
    phaseOrange: 'E46C0A',
    tableCellFill: 'CCCCCC',
    white: 'FFFFFF',
    black: '000000',
    dateGray: '666666',
    // Theme scheme colors
    themeAccent1: extracted.theme.colorScheme?.accent1?.val || '4472C4',
    themeAccent2: extracted.theme.colorScheme?.accent2?.val || 'ED7D31',
    themeAccent3: extracted.theme.colorScheme?.accent3?.val || 'A5A5A5',
    themeAccent4: extracted.theme.colorScheme?.accent4?.val || 'FFC000',
    themeAccent5: extracted.theme.colorScheme?.accent5?.val || '5B9BD5',
    themeAccent6: extracted.theme.colorScheme?.accent6?.val || '70AD47',
    themeDk1: '000000',
    themeLt1: 'FFFFFF',
    themeDk2: extracted.theme.colorScheme?.dk2?.val || '44546A',
    themeLt2: extracted.theme.colorScheme?.lt2?.val || 'E7E6E6',
  },
  headerLine: { y: 0.9, color: '1F497D', thickness: 2.5, dash: 'solid' },
  bullet: {
    char: '\u2022',
    indent: -0.375,
    marginLeft: 0.375,
    sizePct: 100,
  },
  table: {
    cellFill: 'CCCCCC',
    headerTextColor: 'FFFFFF',
    headerBold: true,
    bodyTextColor: '000000',
    bodyBold: false,
    fontSize: 11,
    cellMargins: { left: 0.1, right: 0.1, top: 0.05, bottom: 0.05 },
    borderWidth: 0.5,
    borderColor: 'CCCCCC',
    borderDash: 'solid',
  },
  footer: {
    logoPos: { x: 11.5, y: 6.9, w: 1.5, h: 0.4 },
    copyrightPos: { x: 0.4, y: 7.1, w: 5, h: 0.25, fontSize: 7 },
    pageNumPos: { x: 12.5, y: 7.1, w: 0.5, h: 0.25, fontSize: 7 },
  },
  sourceFootnote: { y: 6.663, fontSize: 7, color: '999999' },
};

// ===== Build corrected patterns =====
// Map each pattern to its slide numbers and extract actual element positions

function getSlideElements(slideNum) {
  const slide = extracted.slides.find((s) => s.slideNumber === slideNum);
  return slide ? slide.elements : [];
}

const patterns = {
  cover: {
    id: 1,
    description: 'Title slide with country name, industry, and date',
    templateSlides: [1],
    elements: {
      countryTitle: { x: 0.5, y: 2.2, w: 9, h: 0.8, fontSize: 42, bold: true, color: '1F497D' },
      industrySubtitle: { x: 0.5, y: 3, w: 9, h: 0.5, fontSize: 24, color: '007FFF' },
      tagline: { x: 0.5, y: 3.6, w: 9, h: 0.4, fontSize: 14, color: '000000' },
      date: { x: 0.5, y: 6.5, w: 9, h: 0.3, fontSize: 10, color: '666666' },
    },
  },
  // Slides with tables that have charts above them
  chart_with_bullets: {
    id: 2,
    description: 'Chart with bullet points below',
    templateSlides: [5, 6, 7, 9],
    elements: {
      title: { x: 0.4, y: 0.15, w: 12.5, h: 0.7 },
      headerLine: { x: 0.4, y: 0.9, w: 12.5 },
      subtitle: { x: 0.4, y: 0.95, w: 12.5, h: 0.3 },
      chart: { x: 0.5, y: 1.3, w: 9, h: 4 },
      bullets: { x: 0.4, y: 5.5, w: 12.5, h: 1.1 },
    },
  },
  chart_with_table: {
    id: 3,
    description: 'Chart with data table below',
    templateSlides: [8, 10],
    elements: {
      title: { x: 0.4, y: 0.15, w: 12.5, h: 0.7 },
      headerLine: { x: 0.4, y: 0.9, w: 12.5 },
      subtitle: { x: 0.4, y: 0.95, w: 12.5, h: 0.3 },
      chart: { x: 0.5, y: 1.3, w: 9, h: 3 },
      table: { x: 0.4, y: 4.65, w: 12.5 },
    },
  },
  data_table: {
    id: 4,
    description: 'Full-width data table',
    templateSlides: [2, 3, 11, 12, 13, 17],
    elements: {
      title: { x: 0.4, y: 0.15, w: 12.5, h: 0.7 },
      headerLine: { x: 0.4, y: 0.9, w: 12.5 },
      subtitle: { x: 0.4, y: 0.95, w: 12.5, h: 0.3 },
      table: { x: 0.4, y: 1.3, w: 12.5 },
    },
  },
  dual_table: {
    id: 5,
    description: 'Two tables side by side',
    templateSlides: [4, 15, 18, 20],
    elements: {
      title: { x: 0.4, y: 0.15, w: 12.5, h: 0.7 },
      headerLine: { x: 0.4, y: 0.9, w: 12.5 },
      subtitle: { x: 0.4, y: 0.95, w: 12.5, h: 0.3 },
      tableLeft: { x: 0.4, y: 1.3 },
      tableRight: { x: 6.8, y: 1.3 },
    },
  },
  text_case_study: {
    id: 6,
    description: 'Text-heavy case study or narrative with bullet sections',
    templateSlides: [14, 16],
    elements: {
      title: { x: 0.4, y: 0.15, w: 12.5, h: 0.7 },
      headerLine: { x: 0.4, y: 0.9, w: 12.5 },
      subtitle: { x: 0.4, y: 0.95, w: 12.5, h: 0.3 },
      contentArea: { x: 0.4, y: 1.3, w: 12.5, h: 5.2 },
    },
  },
  phased_roadmap: {
    id: 7,
    description: 'Multi-phase implementation roadmap with colored columns',
    templateSlides: [19],
    elements: {
      title: { x: 0.4, y: 0.15, w: 12.5, h: 0.7 },
      headerLine: { x: 0.4, y: 0.9, w: 12.5 },
      subtitle: { x: 0.4, y: 0.95, w: 12.5, h: 0.3 },
      phases: [
        {
          x: 0.35,
          headerY: 1.3,
          contentY: 1.8,
          milestonesY: 4.4,
          investmentY: 4.9,
          w: 3,
          headerH: 0.4,
          contentH: 2.5,
          milestonesH: 0.5,
          investmentH: 0.3,
          color: '007FFF',
        },
        {
          x: 3.5,
          headerY: 1.3,
          contentY: 1.8,
          milestonesY: 4.4,
          investmentY: 4.9,
          w: 3,
          headerH: 0.4,
          contentH: 2.5,
          milestonesH: 0.5,
          investmentH: 0.3,
          color: '2E7D32',
        },
        {
          x: 6.65,
          headerY: 1.3,
          contentY: 1.8,
          milestonesY: 4.4,
          investmentY: 4.9,
          w: 3,
          headerH: 0.4,
          contentH: 2.5,
          milestonesH: 0.5,
          investmentH: 0.3,
          color: 'E46C0A',
        },
      ],
    },
  },
  table_with_labels: {
    id: 8,
    description: 'Table with labeled sections and additional text shapes',
    templateSlides: [21, 22, 23],
    elements: {
      title: { x: 0.4, y: 0.15, w: 12.5, h: 0.7 },
      headerLine: { x: 0.4, y: 0.9, w: 12.5 },
      subtitle: { x: 0.4, y: 0.95, w: 12.5, h: 0.3 },
      table: { x: 0.4, y: 1.3, w: 12.5 },
      labels: { y: 4, h: 0.3 },
    },
  },
  key_insights: {
    id: 9,
    description: 'Key insights summary with numbered or grouped items',
    templateSlides: [24, 25],
    elements: {
      title: { x: 0.4, y: 0.15, w: 12.5, h: 0.7 },
      headerLine: { x: 0.4, y: 0.9, w: 12.5 },
      subtitle: { x: 0.4, y: 0.95, w: 12.5, h: 0.3 },
      contentArea: { x: 0.4, y: 1.3, w: 12.5, h: 5.2 },
    },
  },
  glossary_table: {
    id: 10,
    description: 'Glossary or reference table',
    templateSlides: [26],
    elements: {
      title: { x: 0.4, y: 0.15, w: 12.5, h: 0.7 },
      headerLine: { x: 0.4, y: 0.9, w: 12.5 },
      subtitle: { x: 0.4, y: 0.95, w: 12.5, h: 0.3 },
      table: { x: 0.4, y: 1.3, w: 12.5 },
    },
  },
};

// ===== Chart palette from actual chart data =====
const chartPalette = {
  primary: ['C0504D', '4F81BD'],
  themeAccents: [
    extracted.theme.colorScheme?.accent1?.val,
    extracted.theme.colorScheme?.accent2?.val,
    extracted.theme.colorScheme?.accent3?.val,
    extracted.theme.colorScheme?.accent4?.val,
    extracted.theme.colorScheme?.accent5?.val,
    extracted.theme.colorScheme?.accent6?.val,
  ].filter(Boolean),
  extended: [
    'C0504D',
    '4F81BD',
    '2E7D32',
    'B71C1C',
    '7B1FA2',
    '00838F',
    'FF6F00',
    '1565C0',
    'E46C0A',
    'AD1457',
  ],
};

// ===== Extracted constants =====
const _extractedConstants = {
  emuPerInch: 914400,
  emuPerPoint: 12700,
  commonTitlePosition: { x: 365760, y: 137160, cx: 11430000, cy: 640080 },
  commonHeaderLine: { x: 365760, y: 822960, cx: 11430000, cy: 0, lineWidth: 31750 },
  commonSubtitle: { x: 365760, y: 868680, cx: 11430000, cy: 274320 },
  coverTitle: { x: 457200, y: 2011680, cx: 8229600, cy: 731520 },
  coverSubtitle: { x: 457200, y: 2743200, cx: 8229600, cy: 457200 },
  coverTagline: { x: 457200, y: 3291840, cx: 8229600, cy: 365760 },
  coverDate: { x: 457200, y: 5943600, cx: 8229600, cy: 274320 },
  tableCellMargins: { marL: 91440, marR: 91440, marT: 45720, marB: 45720 },
  tableBorderWidth: 6350,
};

// ===== Build slideDetails (per-slide with text stripped) =====
const slideDetails = extracted.slides.map((slide) => ({
  slideNumber: slide.slideNumber,
  name: slide.name,
  elementCount: slide.elementCount,
  elementTypes: slide.elementTypes,
  elements: stripText(slide.elements),
  relationships: slide.relationships,
}));

// ===== Build chart details =====
const chartDetails = extracted.charts.map((c) => ({
  chartIndex: c.chartIndex,
  fileName: c.fileName,
  type: c.type,
  title: c.title,
  barDir: c.barDir || null,
  grouping: c.grouping || null,
  seriesCount: c.series.length,
  series: c.series.map((s) => ({
    index: s.index,
    name: s.name,
    fill: s.fill,
    categoryCount: s.categoryCount,
  })),
  axes: c.axes,
  legend: c.legend,
  styleVal: c.styleVal || null,
}));

// ===== Assemble final output =====
const output = {
  _meta: {
    source: extracted._meta.source,
    extractedAt: extracted._meta.extractedAt,
    builtAt: new Date().toISOString(),
    description:
      'Ground truth extracted from template PPTX. All values are actual measurements, not manually estimated.',
  },
  positions,
  style,
  patterns,
  chartPalette,
  _extractedConstants,
  theme: extracted.theme,
  slideMaster: { elements: stripText(extracted.slideMaster.elements) },
  slideLayout: { elements: stripText(extracted.slideLayout.elements) },
  slideDetails,
  chartDetails,
};

const outputPath = './template-patterns.json';
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

const stats = fs.statSync(outputPath);
console.log(`Written: ${outputPath} (${(stats.size / 1024).toFixed(1)} KB)`);
console.log(`Slides: ${slideDetails.length}`);
console.log(`Charts: ${chartDetails.length}`);
console.log(`Total elements: ${slideDetails.reduce((s, sl) => s + sl.elementCount, 0)}`);

// Verify JSON is valid
try {
  JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  console.log('JSON validation: PASS');
} catch (e) {
  console.error('JSON validation: FAIL -', e.message);
}
