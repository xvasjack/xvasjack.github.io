/**
 * Mock PPT Generation Test
 * Tests slide generation with fake research data - no API keys needed
 * Run: node test-ppt-generation.js
 */

const PptxGenJS = require('pptxgenjs');
const fs = require('fs');
const path = require('path');

// Import key functions from server.js by extracting them
// (In production, these would be in a shared module)

const COLORS = {
  dk1: '000000',
  dk2: '1F497D',
  lt1: 'FFFFFF',
  lt2: 'EEECE1',
  accent1: '4F81BD',
  accent2: 'C0504D',
  accent3: '011AB7',
  hlink: '0000FF',
  black: '000000',
  white: 'FFFFFF',
  gray: '666666',
  lightGray: 'F5F5F5',
  green: '2E7D32',
  orange: 'E46C0A',
  red: 'C62828',
  footerBg: 'F8F9FA',
  footerText: '666666',
};

const CHART_COLORS = [
  '0066CC',
  '009E73',
  'D55E00',
  'CC79A7',
  '1F497D',
  'F0E442',
  '56B4E9',
  'E69F00',
];

const FONT = 'Segoe UI';
const LEFT_MARGIN = 0.35;
const CONTENT_WIDTH = 12.5;

// Helper functions
function truncate(text, maxLen = 150) {
  if (!text) return '';
  const str = String(text).trim();
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen).trim() + '...';
}

function safeArray(arr, max = 5) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, max);
}

function tableHeader(headers) {
  return headers.map((h) => ({
    text: h,
    options: {
      bold: true,
      fill: { color: COLORS.dk2 },
      color: COLORS.white,
      fontSize: 11,
    },
  }));
}

function calculateColumnWidths(data, totalWidth = 12.5) {
  if (!data || !Array.isArray(data) || data.length === 0) return [];
  const numCols = data[0].length;
  if (numCols === 0) return [];

  const maxLengths = [];
  for (let colIdx = 0; colIdx < numCols; colIdx++) {
    let maxLen = 0;
    for (const row of data) {
      if (row[colIdx] !== undefined) {
        const cellText =
          typeof row[colIdx] === 'object' ? String(row[colIdx].text || '') : String(row[colIdx]);
        maxLen = Math.max(maxLen, cellText.length);
      }
    }
    maxLengths.push(Math.max(maxLen, 5));
  }

  const totalLength = maxLengths.reduce((a, b) => a + b, 0);
  let widths = maxLengths.map((len) => (len / totalLength) * totalWidth);

  const minColWidth = 0.8;
  const maxColWidth = totalWidth * 0.5;
  widths = widths.map((w) => Math.min(Math.max(w, minColWidth), maxColWidth));

  const currentTotal = widths.reduce((a, b) => a + b, 0);
  if (currentTotal !== totalWidth) {
    const scale = totalWidth / currentTotal;
    widths = widths.map((w) => w * scale);
  }

  return widths;
}

function addInsightsPanel(slide, insights = [], options = {}) {
  const panelX = options.x || 9.8;
  const panelY = options.y || 1.5;
  const panelW = options.w || 3.2;
  const panelH = options.h || 4.0;

  if (insights.length === 0) return;

  // Panel header
  slide.addText('Key Insights', {
    x: panelX,
    y: panelY,
    w: panelW,
    h: 0.35,
    fontSize: 12,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });

  // Navy underline
  slide.addShape('line', {
    x: panelX,
    y: panelY + 0.35,
    w: panelW,
    h: 0,
    line: { color: COLORS.dk2, width: 1.5 },
  });

  // Bullet points
  const bulletPoints = insights.slice(0, 4).map((insight) => ({
    text: truncate(String(insight), 150),
    options: { bullet: { type: 'bullet', color: COLORS.dk2 } },
  }));

  slide.addText(bulletPoints, {
    x: panelX,
    y: panelY + 0.5,
    w: panelW,
    h: panelH - 0.5,
    fontSize: 10,
    fontFace: FONT,
    color: COLORS.black,
    valign: 'top',
  });
}

function addCalloutBox(slide, title, content, options = {}) {
  const boxX = options.x || LEFT_MARGIN;
  const boxY = options.y || 4.5;
  const boxW = options.w || CONTENT_WIDTH;
  const boxH = options.h || 1.5;
  const type = options.type || 'insight';

  const colorMap = {
    insight: { bg: 'E3F2FD', border: '2196F3', titleColor: '1565C0' },
    warning: { bg: 'FFF3E0', border: 'FF9800', titleColor: 'E65100' },
    recommendation: { bg: 'E8F5E9', border: '4CAF50', titleColor: '2E7D32' },
  };

  const colors = colorMap[type] || colorMap.insight;

  // Background box
  slide.addShape('rect', {
    x: boxX,
    y: boxY,
    w: boxW,
    h: boxH,
    fill: { color: colors.bg },
    line: { color: colors.border, width: 1.5 },
  });

  // Title
  slide.addText(title, {
    x: boxX + 0.15,
    y: boxY + 0.1,
    w: boxW - 0.3,
    h: 0.3,
    fontSize: 11,
    bold: true,
    color: colors.titleColor,
    fontFace: FONT,
  });

  // Content
  slide.addText(truncate(content, 300), {
    x: boxX + 0.15,
    y: boxY + 0.45,
    w: boxW - 0.3,
    h: boxH - 0.55,
    fontSize: 10,
    fontFace: FONT,
    color: COLORS.black,
    valign: 'top',
  });
}

function mergeHistoricalProjected(data) {
  if (!data) return null;
  if (data.categories && data.series) return data;

  const historical = data.historical || {};
  const projected = data.projected || {};
  const allYears = [...Object.keys(historical), ...Object.keys(projected)].sort();

  if (allYears.length === 0) return null;

  const seriesNames = new Set();
  Object.values(historical).forEach((yearData) => {
    if (typeof yearData === 'object') {
      Object.keys(yearData).forEach((k) => seriesNames.add(k));
    }
  });
  Object.values(projected).forEach((yearData) => {
    if (typeof yearData === 'object') {
      Object.keys(yearData).forEach((k) => seriesNames.add(k));
    }
  });

  if (seriesNames.size === 0) return null;

  const series = [];
  seriesNames.forEach((seriesName) => {
    const values = allYears.map((year) => {
      const yearData = historical[year] || projected[year] || {};
      return typeof yearData === 'object' ? yearData[seriesName] || 0 : 0;
    });
    series.push({ name: seriesName, values });
  });

  return {
    categories: allYears,
    series,
    projectedStartIndex: Object.keys(historical).length,
    unit: data.unit || '',
  };
}

function addStackedBarChart(slide, title, data, options = {}) {
  let chartData = data;
  if (data && (data.historical || data.projected) && !data.categories) {
    chartData = mergeHistoricalProjected(data);
  }

  if (!chartData || !chartData.categories || !chartData.series || chartData.series.length === 0) {
    return;
  }

  const hasProjections =
    chartData.projectedStartIndex && chartData.projectedStartIndex < chartData.categories.length;
  const chartTitle =
    hasProjections && !title.includes('Projected') ? `${title} (includes projections)` : title;

  const pptxChartData = chartData.series.map((s, idx) => ({
    name: s.name,
    labels: chartData.categories,
    values: s.values,
    color: CHART_COLORS[idx % CHART_COLORS.length],
  }));

  slide.addChart('bar', pptxChartData, {
    x: options.x || 0.5,
    y: options.y || 1.5,
    w: options.w || 9,
    h: options.h || 4.5,
    barDir: 'bar',
    barGrouping: 'stacked',
    showLegend: true,
    legendPos: 'b',
    showTitle: !!chartTitle,
    title: chartTitle,
    titleFontFace: FONT,
    titleFontSize: 14,
    showValue: true,
    dataLabelFontSize: 9,
    dataLabelColor: 'FFFFFF',
  });
}

// ============ MOCK DATA ============
const mockData = {
  country: 'Thailand',
  industry: 'Energy Services',

  policy: {
    foundationalActs: [
      { name: 'Energy Efficiency & Conservation Act', year: 2024, enforcement: 'Enforced' },
      { name: 'Renewable Energy Development Act', year: 2022, enforcement: 'Partial' },
    ],
    foreignOwnership: { general: '49%', boiPromoted: '100%' },
    incentives: [
      {
        name: 'Green Investment Tax Allowance',
        benefit: '100% CAPEX for 5 years',
        eligibility: 'BOI registered',
      },
      { name: 'Carbon Credit Scheme', benefit: 'Tax deduction', eligibility: 'All companies' },
    ],
  },

  market: {
    tpes: {
      slideTitle: 'Thailand - Total Primary Energy Supply',
      keyInsight: 'Natural gas dominates at 42%, but renewables growing 8% annually',
      chartData: {
        categories: ['2020', '2021', '2022', '2023', '2024'],
        series: [
          { name: 'Natural Gas', values: [42, 41, 40, 39, 38] },
          { name: 'Oil', values: [35, 34, 33, 32, 31] },
          { name: 'Renewable', values: [15, 17, 19, 21, 23] },
          { name: 'Coal', values: [8, 8, 8, 8, 8] },
        ],
        unit: '%',
      },
    },

    electricity: {
      slideTitle: 'Thailand - Electricity & Power',
      totalCapacity: '50 GW installed capacity',
      demandGrowth: '4.2% CAGR 2020-2024',
      keyTrend: 'Solar capacity doubled in 3 years, now 15% of mix',
      chartData: {
        categories: ['Natural Gas', 'Coal', 'Hydro', 'Solar', 'Wind', 'Biomass'],
        values: [45, 20, 12, 15, 3, 5],
        unit: '%',
      },
    },

    gasLng: {
      slideTitle: 'Thailand - Gas & LNG Market',
      pipelineNetwork: '4,500 km pipeline network connecting major industrial zones',
      lngTerminals: [
        { name: 'Map Ta Phut LNG', capacity: '11.5 MTPA', utilization: '85%' },
        { name: 'Nong Fab Terminal', capacity: '7.5 MTPA', utilization: '60%' },
      ],
      chartData: {
        categories: ['2020', '2021', '2022', '2023', '2024'],
        series: [
          { name: 'Domestic Production', values: [35, 33, 31, 29, 27] },
          { name: 'LNG Imports', values: [12, 14, 16, 18, 20] },
        ],
        unit: 'bcm',
      },
    },

    escoMarket: {
      slideTitle: 'Thailand - ESCO Market',
      marketSize: '$450M (2024)',
      growthRate: '12% CAGR',
      segments: [
        { name: 'Industrial', size: '$200M', share: '44%' },
        { name: 'Commercial', size: '$150M', share: '33%' },
        { name: 'Public Sector', size: '$100M', share: '23%' },
      ],
    },
  },

  competitors: {
    japanesePlayers: {
      slideTitle: 'Thailand - Japanese Energy Companies',
      marketInsight: 'Strong presence in upstream, limited ESCO activity',
      players: [
        {
          name: 'JERA',
          presence: 'Power generation JV',
          projects: 'Gulf JERA (2,500 MW)',
          assessment: 'Strong',
        },
        {
          name: 'Osaka Gas',
          presence: 'LNG trading',
          projects: 'PTT LNG supply',
          assessment: 'Moderate',
        },
        {
          name: 'Tokyo Gas',
          presence: 'Engineering services',
          projects: 'Industrial efficiency',
          assessment: 'Growing',
        },
      ],
    },

    localMajor: {
      slideTitle: 'Thailand - Major Local Players',
      concentration: 'Top 5 control 70% of market',
      players: [
        {
          name: 'PTT Group',
          type: 'State-owned',
          revenue: '$65B',
          marketShare: '35%',
          strengths: 'Vertical integration',
        },
        {
          name: 'EGAT',
          type: 'State utility',
          revenue: '$12B',
          marketShare: '20%',
          strengths: 'Grid control',
        },
        {
          name: 'Gulf Energy',
          type: 'Private',
          revenue: '$3B',
          marketShare: '10%',
          strengths: 'IPP leadership',
        },
      ],
    },

    caseStudy: {
      slideTitle: 'Thailand - Market Entry Case Study',
      company: 'Engie (France)',
      entryYear: '2016',
      entryMode: 'Acquisition + JV',
      investment: '$500M',
      outcome: 'Profitable within 3 years, now #2 foreign player',
      keyLessons: [
        'Local partner essential for regulatory navigation',
        'BOI promotion critical for foreign ownership >49%',
        'Industrial customers more receptive than commercial',
        'Long sales cycles (12-18 months) require patience',
      ],
    },

    maActivity: {
      slideTitle: 'Thailand - M&A Activity',
      valuationMultiples: '8-12x EBITDA for energy services',
      recentDeals: [
        {
          year: '2023',
          buyer: 'Gulf Energy',
          target: 'ESCO Asia',
          value: '$120M',
          rationale: 'Market consolidation',
        },
        {
          year: '2022',
          buyer: 'Banpu',
          target: 'SolarCo',
          value: '$85M',
          rationale: 'Renewable expansion',
        },
      ],
      potentialTargets: [
        {
          name: 'Thai ESCO Ltd',
          estimatedValue: '$50-70M',
          rationale: 'Strong industrial client base',
          timing: '2025',
        },
      ],
    },
  },

  depth: {
    escoEconomics: {
      slideTitle: 'Thailand - ESCO Deal Economics',
      keyInsight: 'Attractive IRR but requires patient capital',
      typicalDealSize: { min: '$500K', max: '$5M', average: '$1.5M' },
      contractTerms: {
        duration: '5-10 years',
        savingsSplit: '70/30 client/ESCO',
        guaranteeStructure: 'Performance guarantee required',
      },
      financials: {
        paybackPeriod: '3-5 years',
        irr: '15-25%',
        marginProfile: '25-35% gross margin',
      },
      financingOptions: [
        'Green bonds (4-5% rate)',
        'EXIM Bank facilities',
        'Commercial bank project finance',
      ],
    },

    partnerAssessment: {
      slideTitle: 'Thailand - Partner Assessment',
      recommendedPartner: 'Thai Energy Solutions',
      partners: [
        {
          name: 'Thai Energy Solutions',
          type: 'ESCO',
          revenue: '$25M',
          partnershipFit: 4,
          acquisitionFit: 3,
          estimatedValuation: '$50M',
        },
        {
          name: 'Green Power Co',
          type: 'Developer',
          revenue: '$40M',
          partnershipFit: 3,
          acquisitionFit: 4,
          estimatedValuation: '$80M',
        },
        {
          name: 'EE Consulting',
          type: 'Advisory',
          revenue: '$8M',
          partnershipFit: 5,
          acquisitionFit: 2,
          estimatedValuation: '$15M',
        },
      ],
    },

    entryStrategy: {
      slideTitle: 'Thailand - Entry Strategy Options',
      recommendation: 'JV with local ESCO recommended for fastest market access',
      options: [
        {
          mode: 'Joint Venture',
          timeline: '6-12 months',
          investment: '$10-20M',
          controlLevel: 'Shared',
          riskLevel: 'Medium',
          pros: ['Fast entry', 'Local expertise'],
        },
        {
          mode: 'Acquisition',
          timeline: '12-18 months',
          investment: '$50-100M',
          controlLevel: 'Full',
          riskLevel: 'High',
          pros: ['Immediate scale', 'Existing contracts'],
        },
        {
          mode: 'Greenfield',
          timeline: '18-24 months',
          investment: '$5-15M',
          controlLevel: 'Full',
          riskLevel: 'Low',
          pros: ['Own culture', 'No legacy issues'],
        },
      ],
      harveyBalls: {
        criteria: [
          'Speed to Market',
          'Investment Required',
          'Control Level',
          'Risk Profile',
          'Local Knowledge',
        ],
        jv: [5, 3, 3, 3, 5],
        acquisition: [3, 1, 5, 2, 4],
        greenfield: [1, 4, 5, 4, 1],
      },
    },
  },

  summary: {
    opportunities: [
      'Growing industrial energy efficiency demand',
      'Government incentives for green investments',
      'Limited Japanese competition in ESCO segment',
      'Strong GDP growth driving energy consumption',
    ],
    obstacles: [
      '49% foreign ownership limit without BOI',
      'Long sales cycles in B2B segment',
      'Price-sensitive market',
      'Limited local talent pool',
    ],
  },
};

// ============ GENERATE TEST PPT ============
async function generateTestPPT() {
  console.log('Creating test PPT with mock data...\n');

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = `Market Research - ${mockData.country}`;
  pptx.author = 'YCP Market Research';

  // Helper to add slide with title
  function addSlideWithTitle(title, subtitle = '') {
    const slide = pptx.addSlide();
    slide.addText(title, {
      x: LEFT_MARGIN,
      y: 0.3,
      w: CONTENT_WIDTH,
      h: 0.5,
      fontSize: 24,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
    });
    if (subtitle) {
      slide.addText(subtitle, {
        x: LEFT_MARGIN,
        y: 0.8,
        w: CONTENT_WIDTH,
        h: 0.4,
        fontSize: 12,
        color: COLORS.gray,
        fontFace: FONT,
      });
    }
    return slide;
  }

  // SLIDE 1: Title
  const titleSlide = pptx.addSlide();
  titleSlide.addText(`${mockData.country} Market Analysis`, {
    x: 0,
    y: 2.5,
    w: '100%',
    h: 1,
    fontSize: 44,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
    align: 'center',
  });
  titleSlide.addText(`${mockData.industry} | YCP Research`, {
    x: 0,
    y: 3.6,
    w: '100%',
    h: 0.5,
    fontSize: 18,
    color: COLORS.gray,
    fontFace: FONT,
    align: 'center',
  });
  console.log('  ✓ Title slide');

  // SLIDE 2: TPES with Insights Panel
  const tpesSlide = addSlideWithTitle(
    mockData.market.tpes.slideTitle,
    mockData.market.tpes.keyInsight
  );
  addStackedBarChart(tpesSlide, 'TPES by Source (%)', mockData.market.tpes.chartData, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 8.8,
    h: 5.0,
  });
  addInsightsPanel(
    tpesSlide,
    [
      'Natural Gas: 38% (declining)',
      'Renewables: 23% (growing 8% p.a.)',
      'Oil: 31% (stable)',
      'Transition to cleaner mix underway',
    ],
    { x: 9.5, y: 1.3, w: 3.4 }
  );
  console.log('  ✓ TPES slide with insights panel');

  // SLIDE 3: ESCO Market with Dynamic Table
  const escoSlide = addSlideWithTitle(
    mockData.market.escoMarket.slideTitle,
    `${mockData.market.escoMarket.marketSize} | ${mockData.market.escoMarket.growthRate}`
  );
  const escoInsights = [
    `Market Size: ${mockData.market.escoMarket.marketSize}`,
    `Growth: ${mockData.market.escoMarket.growthRate}`,
    'Industrial segment largest at 44%',
    'Strong government support for efficiency',
  ];
  addCalloutBox(escoSlide, 'Market Overview', escoInsights.join(' • '), {
    x: LEFT_MARGIN,
    y: 1.3,
    w: CONTENT_WIDTH,
    h: 1.2,
    type: 'insight',
  });

  const segRows = [tableHeader(['Segment', 'Size', 'Share'])];
  mockData.market.escoMarket.segments.forEach((s) => {
    segRows.push([{ text: s.name }, { text: s.size }, { text: s.share }]);
  });
  const segColWidths = calculateColumnWidths(segRows, CONTENT_WIDTH);
  escoSlide.addTable(segRows, {
    x: LEFT_MARGIN,
    y: 2.7,
    w: CONTENT_WIDTH,
    h: 2.0,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: segColWidths,
  });
  console.log('  ✓ ESCO Market slide with dynamic column widths');

  // SLIDE 4: Japanese Players with Insights
  const jpSlide = addSlideWithTitle(
    mockData.competitors.japanesePlayers.slideTitle,
    mockData.competitors.japanesePlayers.marketInsight
  );
  const jpRows = [tableHeader(['Company', 'Presence', 'Projects', 'Assessment'])];
  mockData.competitors.japanesePlayers.players.forEach((p) => {
    jpRows.push([
      { text: p.name },
      { text: p.presence },
      { text: p.projects },
      { text: p.assessment },
    ]);
  });
  const jpColWidths = calculateColumnWidths(jpRows, 9.0);
  jpSlide.addTable(jpRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 9.0,
    h: 3.0,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: jpColWidths,
  });
  addInsightsPanel(
    jpSlide,
    [
      '3 Japanese players identified',
      'JERA: Strong (power generation)',
      'Limited ESCO activity currently',
      'Opportunity for first-mover advantage',
    ],
    { x: 9.5, y: 1.3, w: 3.3 }
  );
  console.log('  ✓ Japanese Players slide with insights');

  // SLIDE 5: Case Study with Two-Column Layout
  const caseSlide = addSlideWithTitle(
    mockData.competitors.caseStudy.slideTitle,
    'Successful foreign market entry example'
  );
  const caseRows = [
    [
      { text: 'Company', options: { bold: true, fill: { color: COLORS.dk2 }, color: 'FFFFFF' } },
      { text: mockData.competitors.caseStudy.company },
    ],
    [
      { text: 'Entry Year', options: { bold: true, fill: { color: COLORS.dk2 }, color: 'FFFFFF' } },
      { text: mockData.competitors.caseStudy.entryYear },
    ],
    [
      { text: 'Entry Mode', options: { bold: true, fill: { color: COLORS.dk2 }, color: 'FFFFFF' } },
      { text: mockData.competitors.caseStudy.entryMode },
    ],
    [
      { text: 'Investment', options: { bold: true, fill: { color: COLORS.dk2 }, color: 'FFFFFF' } },
      { text: mockData.competitors.caseStudy.investment },
    ],
    [
      { text: 'Outcome', options: { bold: true, fill: { color: COLORS.dk2 }, color: 'FFFFFF' } },
      { text: mockData.competitors.caseStudy.outcome },
    ],
  ];
  caseSlide.addTable(caseRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 6.0,
    h: 3.0,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [1.8, 4.2],
  });
  addCalloutBox(
    caseSlide,
    'Key Lessons',
    mockData.competitors.caseStudy.keyLessons.map((l) => `• ${l}`).join('\n'),
    {
      x: 6.5,
      y: 1.3,
      w: 6.3,
      h: 4.5,
      type: 'recommendation',
    }
  );
  console.log('  ✓ Case Study slide with two-column layout');

  // SLIDE 6: Entry Strategy with Harvey Balls
  const entrySlide = addSlideWithTitle(
    mockData.depth.entryStrategy.slideTitle,
    mockData.depth.entryStrategy.recommendation
  );
  const optRows = [tableHeader(['Option', 'Timeline', 'Investment', 'Control', 'Risk'])];
  mockData.depth.entryStrategy.options.forEach((opt) => {
    optRows.push([
      { text: opt.mode },
      { text: opt.timeline },
      { text: opt.investment },
      { text: opt.controlLevel },
      { text: opt.riskLevel },
    ]);
  });
  const optColWidths = calculateColumnWidths(optRows, 9.0);
  entrySlide.addTable(optRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 9.0,
    h: 2.0,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: optColWidths,
  });
  addInsightsPanel(
    entrySlide,
    [
      'Recommended: Joint Venture',
      '3 entry options analyzed',
      'JV fastest at 6-12 months',
      'Greenfield lowest risk',
    ],
    { x: 9.5, y: 1.3, w: 3.3, h: 2.0 }
  );

  // Harvey Balls
  const renderHarvey = (val) => '●'.repeat(val) + '○'.repeat(5 - val);
  const harveyRows = [tableHeader(['Criteria', 'Joint Venture', 'Acquisition', 'Greenfield'])];
  mockData.depth.entryStrategy.harveyBalls.criteria.forEach((crit, idx) => {
    harveyRows.push([
      { text: crit },
      { text: renderHarvey(mockData.depth.entryStrategy.harveyBalls.jv[idx]) },
      { text: renderHarvey(mockData.depth.entryStrategy.harveyBalls.acquisition[idx]) },
      { text: renderHarvey(mockData.depth.entryStrategy.harveyBalls.greenfield[idx]) },
    ]);
  });
  entrySlide.addTable(harveyRows, {
    x: LEFT_MARGIN,
    y: 3.8,
    w: CONTENT_WIDTH,
    h: 2.5,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [3.0, 3.0, 3.0, 3.5],
  });
  console.log('  ✓ Entry Strategy slide with Harvey Balls');

  // SLIDE 7: Opportunities & Obstacles
  const ooSlide = addSlideWithTitle(
    `${mockData.country} - Opportunities & Obstacles`,
    'Summary of key factors'
  );

  // Two-column layout
  // Opportunities (left)
  ooSlide.addShape('rect', {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 6.0,
    h: 5.0,
    fill: { color: 'E8F5E9' },
    line: { color: '4CAF50', width: 1.5 },
  });
  ooSlide.addText('✓ OPPORTUNITIES', {
    x: LEFT_MARGIN + 0.2,
    y: 1.4,
    w: 5.6,
    h: 0.4,
    fontSize: 14,
    bold: true,
    color: '2E7D32',
    fontFace: FONT,
  });
  ooSlide.addText(
    mockData.summary.opportunities.map((o) => ({ text: `✓ ${o}`, options: { bullet: false } })),
    {
      x: LEFT_MARGIN + 0.2,
      y: 1.9,
      w: 5.6,
      h: 4.2,
      fontSize: 11,
      fontFace: FONT,
      color: COLORS.black,
    }
  );

  // Obstacles (right)
  ooSlide.addShape('rect', {
    x: 6.7,
    y: 1.3,
    w: 6.0,
    h: 5.0,
    fill: { color: 'FFF3E0' },
    line: { color: 'FF9800', width: 1.5 },
  });
  ooSlide.addText('⚠ OBSTACLES', {
    x: 6.9,
    y: 1.4,
    w: 5.6,
    h: 0.4,
    fontSize: 14,
    bold: true,
    color: 'E65100',
    fontFace: FONT,
  });
  ooSlide.addText(
    mockData.summary.obstacles.map((o) => ({ text: `⚠ ${o}`, options: { bullet: false } })),
    { x: 6.9, y: 1.9, w: 5.6, h: 4.2, fontSize: 11, fontFace: FONT, color: COLORS.black }
  );
  console.log('  ✓ Opportunities & Obstacles slide');

  // Save PPT
  const outputPath = path.join(__dirname, 'test-output.pptx');
  await pptx.writeFile({ fileName: outputPath });

  console.log(`\n✅ PPT generated successfully!`);
  console.log(`   Output: ${outputPath}`);
  console.log(`   Slides: 7`);

  // Verify file exists and size
  const stats = fs.statSync(outputPath);
  console.log(`   Size: ${(stats.size / 1024).toFixed(1)} KB`);

  return outputPath;
}

// Run test
generateTestPPT()
  .then((outputPath) => {
    console.log('\n🎉 Test completed successfully!');
    console.log('   Open the file in PowerPoint to verify visually.');
  })
  .catch((err) => {
    console.error('\n❌ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
