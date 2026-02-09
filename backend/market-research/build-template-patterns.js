/**
 * Builds template-patterns.json from the raw template-extracted.json
 * Source: 251219_Escort_Phase 1 Market Selection_V3.pptx (34 slides, 15 charts)
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

// ===== Positions from Escort template =====
// Layout 1: title bar at {x:0.38, y:0.05, w:12.59, h:0.91}
// Layout 7/8: title at {x:0.62, y:0.18, w:11.48, h:0.91}
// Content slides (7-10): title at {x:0.37, y:0.29, w:12.59, h:0.69}
// Layout 1 lines: y=1.02 and y=1.10 (double line header)
// Footer: copyright at {x:4.11, y:7.26, w:5.12, h:0.24}
// Page number: {x:10.22, y:7.28, w:3.11, h:0.20}
// Source bar: {x:0.37, y:6.69, w:12.59, h:0.25}
const positions = {
  titleBar: { left: 0.3758, top: 0.0486, width: 12.5862, height: 0.9097 },
  title: { left: 0.3758, top: 0.2917, width: 12.5862, height: 0.6944 },
  headerLineTop: { left: 0, top: 1.0208, width: 13.3333 },
  headerLineBottom: { left: 0, top: 1.0972, width: 13.3333 },
  content_area: { left: 0.3758, top: 1.5, width: 12.5862, height: 5.0 },
  source_bar: { left: 0.3758, top: 6.6944, width: 12.5862, height: 0.25 },
  footer_line: { left: 0, top: 7.2361, width: 13.3333 },
};

// ===== Theme-based style =====
// Theme "YCP": accent1=007FFF, accent2=EDFDFF, accent3=011AB7, accent4=1524A9, accent5=001C44, accent6=E46C0A
// dk2=1F497D (dark navy), lt2=1F497D
const tc = extracted.theme.colorScheme || {};
const style = {
  slideWidth: extracted.presentation.slideWidth,
  slideHeight: extracted.presentation.slideHeight,
  slideWidthEmu: extracted.presentation.slideWidthEmu,
  slideHeightEmu: extracted.presentation.slideHeightEmu,
  fonts: {
    majorLatin: 'Segoe UI',
    minorLatin: 'Segoe UI',
    title: { family: 'Segoe UI', size: 20, bold: false },
    tableHeader: { family: 'Segoe UI', size: 14, bold: false },
    tableBody: { family: 'Segoe UI', size: 14, bold: false },
    footer: { family: 'Segoe UI', size: 8 },
    source: { family: 'Segoe UI', size: 10 },
    coverCompany: { family: 'Segoe UI' },
    coverTitle: { family: 'Segoe UI' },
  },
  colors: {
    // Theme scheme colors (ground truth from Escort)
    dk1: tc.dk1?.lastClr || '000000',
    lt1: tc.lt1?.lastClr || 'FFFFFF',
    dk2: tc.dk2?.val || '1F497D',
    lt2: tc.lt2?.val || '1F497D',
    accent1: tc.accent1?.val || '007FFF',
    accent2: tc.accent2?.val || 'EDFDFF',
    accent3: tc.accent3?.val || '011AB7',
    accent4: tc.accent4?.val || '1524A9',
    accent5: tc.accent5?.val || '001C44',
    accent6: tc.accent6?.val || 'E46C0A',
    // Semantic mappings
    tableHeaderFill: tc.accent3?.val || '011AB7',
    accentBlue: tc.accent1?.val || '007FFF',
    darkNavy: tc.dk2?.val || '1F497D',
    orange: tc.accent6?.val || 'E46C0A',
    gridLine: 'D6D7D9',
  },
  headerLines: {
    top: { y: 1.0208, color: 'scheme:dk2', thickness: 1.75 },
    bottom: { y: 1.0972, color: 'scheme:dk2', thickness: 1.75 },
  },
  dividerLine: { x: 0.4983, y: 2.2292, w: 4.4983, thickness: 1.75 },
  table: {
    headerFill: 'scheme:bg1',
    headerFontSize: 14,
    bodyFontSize: 14,
    borderWidth: 0.5,
    borderColor: 'D6D7D9',
  },
  footer: {
    copyrightPos: { x: 4.11, y: 7.26, w: 5.12, h: 0.24, fontSize: 8 },
    copyrightText: '(C) YCP 2026',
    pageNumPos: { x: 10.22, y: 7.28, w: 3.11, h: 0.2 },
    logoPos: { x: 0.38, y: 7.3, w: 0.47, h: 0.17 },
  },
};

// ===== Patterns mapped to Escort template slides =====
const patterns = {
  cover: {
    id: 1,
    description: 'Title slide with company name and project title',
    templateSlides: [1],
    layout: 2,
    elements: {
      companyName: { x: 0.4555, y: 1.6333, w: 9.3541, h: 2.8349 },
      projectTitle: { x: 0.4555, y: 4.862, w: 9.3541, h: 1.6491 },
    },
  },
  toc_divider: {
    id: 2,
    description: 'Table of contents with section navigation',
    templateSlides: [2, 5, 11, 20, 30],
    layout: 5,
    elements: {
      title: { fontSize: 18, font: '+mn-lt' },
      tocTable: { x: 0.3758, y: 1.5, w: 12.5862 },
    },
  },
  executive_summary: {
    id: 3,
    description: 'Executive summary section',
    templateSlides: [3],
    layout: 6,
  },
  country_overview: {
    id: 4,
    description: 'Country overview with flag and key metrics',
    templateSlides: [4],
    layout: 7,
    elements: {
      title: { x: 0.37, y: 0.29, w: 12.59, h: 0.69 },
      dividerLine: { x: 2.1851, y: 1.729, w: 8.6231, thickness: 1.75 },
      tables: 2,
    },
  },
  regulatory_table: {
    id: 5,
    description: 'Regulatory or policy data table with header bar',
    templateSlides: [6, 7, 8, 9, 10, 12, 21],
    layout: 1,
    elements: {
      titleBar: { x: 0.38, y: 0.05, w: 12.59, h: 0.91 },
      dividerLine: { x: 0.4983, y: 2.2292, w: 4.4983 },
      table: { x: 0.38, y: 1.5, w: 12.59 },
    },
  },
  chart_with_grid: {
    id: 6,
    description: 'Chart with data grid lines and annotations',
    templateSlides: [13, 14, 15, 16, 17, 18, 19, 31, 32],
    layout: 1,
    elements: {
      titleBar: { x: 0.38, y: 0.05, w: 12.59, h: 0.91 },
      dividerLine: { x: 0.4983, y: 2.2292, w: 4.4983 },
      chart: {},
      gridLines: { color: 'D6D7D9', thickness: 0.25 },
    },
  },
  company_comparison: {
    id: 7,
    description: 'Company comparison table with source notes',
    templateSlides: [22],
    layout: 1,
    elements: {
      sourceBar: { x: 0.37, y: 6.69, w: 12.59, h: 0.25, fontSize: 10 },
      table: { x: 0.38, y: 1.5, w: 12.59 },
    },
  },
  case_study: {
    id: 8,
    description: 'Case study with structured content and table',
    templateSlides: [23, 24, 27, 28],
    layout: 1,
    elements: {
      title: { fontSize: 20 },
      table: { x: 0.38, y: 1.5, w: 12.59 },
    },
  },
  financial_charts: {
    id: 9,
    description: 'Dual financial charts with company data',
    templateSlides: [26, 29],
    layout: 7,
    elements: {
      dividerLine: { x: 2.1851, y: 1.729, w: 8.6231 },
      chartLeft: {},
      chartRight: {},
    },
  },
  company_profile: {
    id: 10,
    description: 'Company profile with logo and description',
    templateSlides: [25],
    layout: 1,
  },
  glossary: {
    id: 11,
    description: 'Glossary tables (term/definition)',
    templateSlides: [33, 34],
    layout: 6,
    elements: {
      table: { x: 0.38, y: 1.5, w: 12.59 },
    },
  },
};

// ===== Chart palette from actual chart data =====
const chartPalette = {
  themeAccents: [
    tc.accent1?.val,
    tc.accent2?.val,
    tc.accent3?.val,
    tc.accent4?.val,
    tc.accent5?.val,
    tc.accent6?.val,
  ].filter(Boolean),
  primary: [tc.accent1?.val || '007FFF', tc.accent3?.val || '011AB7'],
  extended: [
    tc.accent1?.val || '007FFF',
    tc.accent3?.val || '011AB7',
    tc.accent6?.val || 'E46C0A',
    tc.accent4?.val || '1524A9',
    tc.accent5?.val || '001C44',
    'C0504D',
    '4F81BD',
    '2E7D32',
  ],
};

// ===== EMU constants from extraction =====
const _extractedConstants = {
  emuPerInch: 914400,
  emuPerPoint: 12700,
  slideWidthEmu: extracted.presentation.slideWidthEmu,
  slideHeightEmu: extracted.presentation.slideHeightEmu,
  // Layout 1 title bar
  layout1TitleBar: { x: 343558, y: 44450, cx: 11501120, cy: 831215 },
  // Layout 1 header lines
  layout1LineTop: { x: 0, y: 933450, cx: 12192000, cy: 0 },
  layout1LineBottom: { x: 0, y: 1003300, cx: 12192000, cy: 0 },
  // Layout 1 footer line
  layout1FooterLine: { x: 0, y: 6615113, cx: 12192000, cy: 0 },
  // Common divider line (直線コネクタ 66)
  commonDividerLine: { x: 455613, y: 2037398, cx: 4113213, cy: 0, lineWidth: 22225 },
  // Cover positions
  coverCompanyName: { x: 416483, y: 1492803, cx: 8551583, cy: 2590483 },
  coverProjectTitle: { x: 416483, y: 4443767, cx: 8551583, cy: 1507267 },
};

// ===== Build slideDetails =====
const slideDetails = extracted.slides.map((slide) => ({
  slideNumber: slide.slideNumber,
  name: slide.name,
  elementCount: slide.elementCount,
  elementTypes: slide.elementTypes,
  elements: stripText(slide.elements),
  relationships: slide.relationships,
}));

// ===== Build layout details =====
const layoutDetails = (extracted.slideLayouts || []).map((layout) => ({
  index: layout.index,
  elements: stripText(layout.elements),
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
      'Ground truth extracted from Escort template PPTX (251219_Escort_Phase 1 Market Selection_V3.pptx). All values are actual measurements.',
    slideCount: 34,
    chartCount: 15,
    layoutCount: 8,
  },
  positions,
  style,
  patterns,
  chartPalette,
  _extractedConstants,
  theme: extracted.theme,
  slideMaster: { elements: stripText(extracted.slideMaster.elements) },
  slideLayouts: layoutDetails,
  slideDetails,
  chartDetails,
};

const outputPath = './template-patterns.json';
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

const stats = fs.statSync(outputPath);
console.log(`Written: ${outputPath} (${(stats.size / 1024).toFixed(1)} KB)`);
console.log(`Slides: ${slideDetails.length}`);
console.log(`Charts: ${chartDetails.length}`);
console.log(`Layouts: ${layoutDetails.length}`);
console.log(`Total elements: ${slideDetails.reduce((s, sl) => s + sl.elementCount, 0)}`);

// Verify JSON is valid
try {
  JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  console.log('JSON validation: PASS');
} catch (e) {
  console.error('JSON validation: FAIL -', e.message);
}
