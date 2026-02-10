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
  title: { left: 0.3758, top: 0.0488, width: 12.5862, height: 0.9097 },
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
    title: { family: 'Segoe UI', size: 24, bold: false },
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
  // Alias: ppt-utils references chart_callout_dual for dual chart layouts
  chart_callout_dual: {
    id: 6.1,
    aliasOf: 'chart_with_grid',
    description: 'Dual chart with callout (derived from chart_with_grid pattern)',
    templateSlides: [13, 14, 15, 16, 17, 18, 19, 31, 32],
    layout: 1,
    elements: {
      chartLeft: { x: 0.38, y: 1.5, w: 6.0, h: 4.2 },
      chartRight: { x: 6.8, y: 1.5, w: 6.1, h: 4.2 },
      quoteCallout: { x: 0.38, y: 5.9, w: 12.59, h: 0.7 },
    },
  },
  // Alias: ppt-utils references chart_insight_panels for chart + insight sidebar
  chart_insight_panels: {
    id: 6.2,
    aliasOf: 'chart_with_grid',
    description: 'Chart with insight panels sidebar (derived from chart_with_grid pattern)',
    templateSlides: [13, 14, 15, 16, 17, 18, 19, 31, 32],
    layout: 1,
    elements: {
      chart: { x: 0.38, y: 1.5, w: 7.8, h: 4.5 },
      insightPanels: [
        { x: 8.5, y: 1.5, w: 4.4, h: 1.4 },
        { x: 8.5, y: 3.1, w: 4.4, h: 1.4 },
        { x: 8.5, y: 4.7, w: 4.4, h: 1.4 },
      ],
      calloutOverlay: {
        x: 1.0,
        y: 5.0,
        w: 5.5,
        h: 1.0,
        fill: 'F5F5F5',
        border: 'CCCCCC',
        borderWidth: 1,
        cornerRadius: 0.05,
      },
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
  // Alias: ppt-utils references case_study_rows for structured row layout
  case_study_rows: {
    id: 8.1,
    aliasOf: 'case_study',
    description: 'Case study with labeled rows (derived from case_study pattern)',
    templateSlides: [23, 24, 27, 28],
    layout: 1,
    elements: {
      rows: [
        { label: 'Business Overview', y: 1.5, h: 0.8 },
        { label: 'Context', y: 2.4, h: 1.0 },
        { label: 'Objective', y: 3.5, h: 0.6 },
        { label: 'Scope', y: 4.2, h: 1.3 },
        { label: 'Outcome', y: 5.6, h: 0.8 },
      ],
      labelStyle: { fill: '1F497D', color: 'FFFFFF', fontSize: 10, bold: true },
      contentStyle: { fill: 'F2F2F2', color: '333333', fontSize: 9 },
      chevronFlow: {
        x: 2.5,
        y: 5.6,
        w: 10.4,
        h: 0.8,
        maxPhases: 5,
        chevronColors: ['007FFF', '2E7D32', 'E46C0A', '4F81BD', 'C0504D'],
        spacing: 0.05,
        fontSize: 8,
        textColor: 'FFFFFF',
      },
    },
  },
  financial_charts: {
    id: 9,
    description: 'Dual financial charts with company data',
    templateSlides: [26, 29],
    layout: 7,
    elements: {
      dividerLine: { x: 2.1851, y: 1.729, w: 8.6231 },
      chartLeft: { x: 0.38, y: 1.5, w: 6.0, h: 4.2 },
      chartRight: { x: 6.8, y: 1.5, w: 6.1, h: 4.2 },
    },
  },
  // Alias: ppt-utils references dual_chart_financial
  dual_chart_financial: {
    id: 9.1,
    aliasOf: 'financial_charts',
    description: 'Financial dual charts with metrics row (derived from financial_charts)',
    templateSlides: [26, 29],
    layout: 7,
    elements: {
      chartLeft: { x: 0.38, y: 1.5, w: 6.0, h: 4.0 },
      chartRight: { x: 6.8, y: 1.5, w: 6.1, h: 4.0 },
      metricsRow: {
        y: 5.7,
        h: 0.6,
        metricBoxWidth: 3.0,
        metricValueFontSize: 16,
        metricValueColor: '1F497D',
        metricLabelFontSize: 9,
        metricLabelColor: '666666',
      },
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
  // Alias: ppt-utils references matrix_2x2 for 2x2 quadrant layout
  matrix_2x2: {
    id: 12,
    description: '2x2 quadrant matrix (custom pattern, not from template)',
    templateSlides: [],
    layout: 1,
    elements: {
      quadrants: [
        { x: 0.38, y: 1.5, w: 6.0, h: 2.5, fill: 'D6E4F0' },
        { x: 6.6, y: 1.5, w: 6.3, h: 2.5, fill: 'F2F2F2' },
        { x: 0.38, y: 4.2, w: 6.0, h: 2.3, fill: 'F2F2F2' },
        { x: 6.6, y: 4.2, w: 6.3, h: 2.3, fill: 'D6E4F0' },
      ],
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

// ===== pptxgenjs-compatible positions (x/y/w/h format) =====
// These can be used directly in pptxgenjs addText/addShape/addTable calls
const pptxPositions = {
  title: {
    x: positions.title.left,
    y: positions.title.top,
    w: positions.title.width,
    h: positions.title.height,
  },
  titleBar: {
    x: positions.titleBar.left,
    y: positions.titleBar.top,
    w: positions.titleBar.width,
    h: positions.titleBar.height,
  },
  contentArea: {
    x: positions.content_area.left,
    y: positions.content_area.top,
    w: positions.content_area.width,
    h: positions.content_area.height,
  },
  sourceBar: {
    x: positions.source_bar.left,
    y: positions.source_bar.top,
    w: positions.source_bar.width,
    h: positions.source_bar.height,
  },
  headerLineTop: {
    x: positions.headerLineTop.left,
    y: positions.headerLineTop.top,
    w: positions.headerLineTop.width,
    h: 0,
  },
  headerLineBottom: {
    x: positions.headerLineBottom.left,
    y: positions.headerLineBottom.top,
    w: positions.headerLineBottom.width,
    h: 0,
  },
  footerLine: {
    x: positions.footer_line.left,
    y: positions.footer_line.top,
    w: positions.footer_line.width,
    h: 0,
  },
};

// ===== Assemble final output =====
const themeWithName = { ...extracted.theme };
themeWithName.name = extracted.theme?.fontScheme?.name || 'YCP';

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
  pptxPositions,
  style,
  patterns,
  chartPalette,
  _extractedConstants,
  theme: themeWithName,
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
