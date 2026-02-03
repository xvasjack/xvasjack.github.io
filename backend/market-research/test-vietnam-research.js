#!/usr/bin/env node
/**
 * Vietnam Energy Services Market Research - Test Generation
 * Mock data for Japanese companies entering Vietnam energy services market
 * Based on template: 251219_Escort_Phase 1 Market Selection_V3.pptx
 *
 * Template structure: 34 slides, 15 charts, 69 tables, 13 images
 * Run: node test-vietnam-research.js
 */

const PptxGenJS = require('pptxgenjs');
const fs = require('fs');
const path = require('path');

// ============ STYLING CONSTANTS ============
const COLORS = {
  dk1: '000000',
  dk2: '1F497D',
  lt1: 'FFFFFF',
  lt2: 'EEECE1',
  accent1: '4F81BD',
  accent2: 'C0504D',
  accent3: '011AB7',
  black: '000000',
  white: 'FFFFFF',
  gray: '666666',
  lightGray: 'F5F5F5',
  green: '2E7D32',
  orange: 'E46C0A',
  red: 'C62828',
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

// ============ HELPER FUNCTIONS ============
function truncate(text, maxLen = 150) {
  if (!text) return '';
  const str = String(text).trim();
  return str.length <= maxLen ? str : str.substring(0, maxLen).trim() + '...';
}

function tableHeader(headers) {
  return headers.map((h) => ({
    text: h,
    options: { bold: true, fill: { color: COLORS.dk2 }, color: COLORS.white, fontSize: 11 },
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
  const minColWidth = 0.8,
    maxColWidth = totalWidth * 0.5;
  widths = widths.map((w) => Math.min(Math.max(w, minColWidth), maxColWidth));
  const currentTotal = widths.reduce((a, b) => a + b, 0);
  if (currentTotal !== totalWidth) widths = widths.map((w) => (w / currentTotal) * totalWidth);
  return widths;
}

function addInsightsPanel(slide, insights = [], options = {}) {
  const panelX = options.x || 9.8,
    panelY = options.y || 1.5,
    panelW = options.w || 3.2,
    panelH = options.h || 4.0;
  if (insights.length === 0) return;
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
  slide.addShape('line', {
    x: panelX,
    y: panelY + 0.35,
    w: panelW,
    h: 0,
    line: { color: COLORS.dk2, width: 1.5 },
  });
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
  const boxX = options.x || LEFT_MARGIN,
    boxY = options.y || 4.5,
    boxW = options.w || CONTENT_WIDTH,
    boxH = options.h || 1.5;
  const type = options.type || 'insight';
  const colorMap = {
    insight: { bg: 'E3F2FD', border: '2196F3', titleColor: '1565C0' },
    warning: { bg: 'FFF3E0', border: 'FF9800', titleColor: 'E65100' },
    recommendation: { bg: 'E8F5E9', border: '4CAF50', titleColor: '2E7D32' },
  };
  const colors = colorMap[type] || colorMap.insight;
  slide.addShape('rect', {
    x: boxX,
    y: boxY,
    w: boxW,
    h: boxH,
    fill: { color: colors.bg },
    line: { color: colors.border, width: 1.5 },
  });
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
  // Increased max length from 300 to 800 to prevent truncation
  slide.addText(truncate(content, 800), {
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

// ============ VIETNAM MOCK DATA ============
const mockData = {
  country: 'Vietnam',
  industry: 'Energy Services',
  client: 'Shizuoka Gas',
  clientOrigin: 'Japanese', // For universal language: "Japanese FDI" etc.
  focus: 'Japanese gas players entering Vietnam',
  targetCustomers: ['Toyota', 'Canon', 'Panasonic'], // FDI manufacturers to target
  recommendedPartners: ['Itochu', 'Sumitomo'], // Trading houses for JV

  policy: {
    foundationalActs: [
      {
        name: 'Law on Economical Use of Energy (No. 50/2010/QH12)',
        year: 2010,
        enforcement: 'Active',
        description: 'Mandates energy audits for large consumers, building codes',
      },
      {
        name: 'Revised Law on Energy Efficiency (2025)',
        year: 2025,
        enforcement: 'Effective Jan 2026',
        description: 'Expands scope, strengthens penalties, adds carbon pricing',
      },
      {
        name: 'Power Development Plan 8 (PDP8)',
        year: 2023,
        enforcement: 'Active',
        description: 'Maps power expansion to 2030, 70GW renewable target',
      },
      {
        name: 'National Energy Development Strategy to 2030',
        year: 2020,
        enforcement: 'Active',
        description: 'Sets overall direction: diversify supply, reduce imports',
      },
    ],
    foreignOwnership: {
      general: '49%',
      ppp: '100% allowed',
      boiEquivalent: 'Investment incentives via Decree 31',
      restrictions: 'Power transmission remains state-controlled',
    },
    incentives: [
      {
        name: 'CIT Exemption (4+9)',
        benefit: '4 years 0%, 9 years 50% reduction',
        eligibility: 'Renewable/high-tech projects',
      },
      {
        name: 'Import Duty Exemption',
        benefit: 'Zero duty on equipment',
        eligibility: 'Clean energy projects',
      },
      {
        name: 'Land Rent Reduction',
        benefit: 'Up to 70% off for 15 years',
        eligibility: 'Industrial zones, disadvantaged areas',
      },
      {
        name: 'Accelerated Depreciation',
        benefit: '1.5x faster depreciation',
        eligibility: 'Energy efficiency equipment',
      },
    ],
  },

  market: {
    tpes: {
      slideTitle: 'Vietnam - Total Primary Energy Supply',
      keyInsight: 'Coal dominates at 47%, but renewables surging from 6% to 15% by 2030',
      chartData: {
        categories: ['2020', '2021', '2022', '2023', '2024', '2025P', '2030P'],
        series: [
          { name: 'Coal', values: [47, 48, 49, 48, 47, 45, 38] },
          { name: 'Oil', values: [25, 24, 23, 22, 21, 20, 18] },
          { name: 'Natural Gas', values: [12, 13, 14, 15, 16, 17, 20] },
          { name: 'Hydro', values: [10, 9, 8, 9, 9, 10, 9] },
          { name: 'Renewable', values: [6, 6, 6, 6, 7, 8, 15] },
        ],
        unit: '%',
      },
    },

    electricity: {
      slideTitle: 'Vietnam - Electricity Consumption vs Capacity',
      totalCapacity: '80 GW installed capacity (2024)',
      demandGrowth: '8.5% CAGR 2020-2024',
      keyTrend: 'Demand outpacing supply, brownouts in industrial zones',
      chartData: {
        categories: ['2020', '2021', '2022', '2023', '2024', '2030P'],
        series: [
          { name: 'Demand (GW)', values: [42, 46, 50, 55, 60, 90] },
          { name: 'Capacity (GW)', values: [60, 65, 70, 75, 80, 130] },
        ],
        unit: 'GW',
      },
    },

    gasLng: {
      slideTitle: 'Vietnam - Gas & LNG Market',
      pipelineNetwork:
        '1,500 km pipeline (primarily offshore connecting production to power plants)',
      domesticDecline: 'Domestic gas production declining 5% annually from mature fields',
      lngTerminals: [
        {
          name: 'Thi Vai LNG (Block B)',
          capacity: '1 MTPA',
          status: 'Operating 2023',
          utilization: '70%',
        },
        { name: 'Hai Linh LNG', capacity: '3.6 MTPA', status: 'COD 2026', utilization: 'Planned' },
        {
          name: 'Son My LNG',
          capacity: '6 MTPA',
          status: 'Under development',
          utilization: 'Planned',
        },
      ],
      chartData: {
        categories: ['2020', '2021', '2022', '2023', '2024', '2025P', '2030P'],
        series: [
          { name: 'Domestic Production', values: [10.5, 9.8, 9.2, 8.5, 8.0, 7.5, 5.0] },
          { name: 'LNG Imports', values: [0, 0, 0, 0.8, 1.5, 3.0, 10.0] },
        ],
        unit: 'bcm',
      },
    },

    electricityPrice: {
      slideTitle: 'Vietnam - Electricity Price',
      averagePrice: '8.5 US cents/kWh (residential)',
      industrialPrice: '7.2 US cents/kWh',
      trend: 'Prices rising 3-5% annually, pressure from coal import costs',
    },
  },

  competitors: {
    japanesePlayers: {
      slideTitle: 'Vietnam - Japanese Energy Companies',
      marketInsight: 'Growing presence in LNG, solar, and industrial efficiency',
      players: [
        {
          name: 'Osaka Gas',
          presence: 'LNG/Solar JV with Sojitz',
          investment: '$200M+',
          projects: 'Rooftop solar, coal-to-gas switching',
          assessment: 'Strong',
        },
        {
          name: 'Toho Gas',
          presence: 'Industrial gas services',
          investment: '$50M',
          projects: 'Green steam, gas metering',
          assessment: 'Growing',
        },
        {
          name: 'Tokyo Gas',
          presence: 'LNG terminal development',
          investment: '$150M',
          projects: 'Hai Linh LNG',
          assessment: 'Moderate',
        },
        {
          name: 'JERA',
          presence: 'Power generation JV',
          investment: '$300M',
          projects: 'Nghi Son 2 coal, LNG import',
          assessment: 'Strong',
        },
      ],
    },

    caseStudies: [
      {
        company: 'Osaka Gas',
        project: 'Rooftop Solar with Sojitz',
        year: '2021',
        partner: 'Sojitz Corporation',
        investment: '$100M committed',
        model: 'PPA (Power Purchase Agreement)',
        outcome: 'Operating 50MW across 30 industrial sites',
        whyItWorked: [
          'Sojitz had existing relationships with 50+ industrial parks',
          '50/50 JV structure avoided 49% foreign ownership cap for power',
          'PPA model = no upfront customer investment = faster sales cycle',
          '15-year contracts locked in revenue before competitors arrived',
        ],
        implicationForShizuoka: {
          headline: "Don't go direct. Partner with trading house that has customer base.",
          specifics: [
            'Top candidates: Itochu (strong Vietnam presence), Sumitomo (energy focus)',
            'Expected structure: 50/50 JV with $10-15M initial commitment',
            'First project: Rooftop solar for existing JP client (Toyota, Canon)',
            'Timeline: Sign JV Q1, first project COD Q4',
          ],
        },
      },
      {
        company: 'Osaka Gas',
        project: 'Coal-to-Gas Fuel Switching',
        year: '2022',
        partner: 'Local industrial customer',
        investment: '$30M',
        model: 'ESaaS (Energy Service as a Service)',
        outcome:
          '20% CO2 reduction, customer locked in for 10 years (Source: Osaka Gas ESG Report 2023)',
        whyItWorked: [
          'Targeted Japanese OEMs facing Scope 2 pressure from HQ',
          'ESaaS model = Osaka Gas owns equipment, customer pays monthly fee',
          'Carbon reduction measurable and reportable to Japanese parent',
          'Long-term contract protected against customer switching',
        ],
        implicationForShizuoka: {
          headline: "Target Japanese FDI with ESG pressure — they're pre-sold on decarbonization.",
          specifics: [
            'Priority targets: Toyota, Canon, Panasonic Vietnam factories',
            'Approach: Leverage existing Japan HQ relationships',
            'Value prop: Help them hit Scope 2 targets with verifiable reduction',
            'Contract structure: 10-year ESaaS with take-or-pay clause',
          ],
        },
      },
      {
        company: 'Toho Gas',
        project: 'Nhon Trach 3&4 Gas Metering',
        year: '2023',
        partner: 'PetroVietnam Gas',
        investment: '$20M',
        model: 'Equipment + Service contract',
        outcome: 'Metering systems for 1,500MW gas-fired plant',
        whyItWorked: [
          'Toho Gas positioned as technical partner, not competitor',
          'PVN needed metering expertise for new LNG facilities',
          'Low capital commitment ($20M) but opened door to larger projects',
          'SOE relationship now asset for future deals',
        ],
        implicationForShizuoka: {
          headline:
            'Technical partnership with SOE is low-risk entry — builds relationship for bigger deals.',
          specifics: [
            'Consider: Technical advisory to PVN/EVN on gas infrastructure',
            'Investment: $5-10M, primarily expertise and equipment',
            'Timeline: 6-12 months to establish, 2+ years to monetize',
            'Upside: SOE relationship unlocks access to their industrial customers',
          ],
        },
      },
    ],

    localMajor: [
      {
        name: 'PetroVietnam (PVN)',
        type: 'State-owned',
        revenue: '$25B',
        marketShare: '40%',
        strengths: 'Upstream dominance, LNG import monopoly',
      },
      {
        name: 'EVN',
        type: 'State utility',
        revenue: '$15B',
        marketShare: '35%',
        strengths: 'Transmission control, power purchase',
      },
      {
        name: 'PV Power',
        type: 'SOE subsidiary',
        revenue: '$2B',
        marketShare: '10%',
        strengths: 'Gas-fired generation fleet',
      },
    ],
  },

  depth: {
    entryStrategy: {
      slideTitle: 'Vietnam - Entry Strategy Options',
      recommendation: 'JV with local industrial partner + PVN relationship recommended',
      options: [
        {
          mode: 'Joint Venture',
          timeline: '6-12 months',
          investment: '$10-30M',
          controlLevel: 'Shared (49-51%)',
          riskLevel: 'Medium',
          pros: ['Fast entry', 'Local relationships', 'Regulatory navigation'],
        },
        {
          mode: 'Acquisition',
          timeline: '18-24 months',
          investment: '$50-150M',
          controlLevel: 'Full (100%)',
          riskLevel: 'High',
          pros: ['Immediate scale', 'Existing contracts', 'Talent acquisition'],
        },
        {
          mode: 'Greenfield',
          timeline: '24-36 months',
          investment: '$20-50M',
          controlLevel: 'Full (100%)',
          riskLevel: 'Medium',
          pros: ['Own culture', 'Choose technology', 'No legacy issues'],
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
        acquisition: [2, 1, 5, 2, 4],
        greenfield: [1, 3, 5, 3, 1],
      },
    },
  },

  summary: {
    opportunities: [
      'Rapid industrialization driving 8%+ annual electricity demand growth',
      'Government committed to 15% renewable by 2030 (PDP8)',
      'LNG import market nascent - first-mover advantage available',
      'Japanese FDI manufacturers seeking decarbonization partners',
      'Limited ESCO competition - fragmented local market',
      'Strong Japan-Vietnam bilateral relations (ODA, trade agreements)',
    ],
    obstacles: [
      'State-owned enterprise dominance (PVN, EVN control supply chain)',
      'Regulatory uncertainty (FIT changes, grid access rules)',
      'Foreign ownership limits (49% for power, case-by-case for infrastructure)',
      'LNG price volatility vs cheap domestic coal',
      'Limited local technical talent for advanced energy services',
      'Long project timelines (2-3 years from concept to COD)',
    ],
  },
};

// ============ GENERATE VIETNAM PPTX ============
async function generateVietnamPPT() {
  console.log('Creating Vietnam Energy Services Market Research PPT...\n');

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = `Market Research - ${mockData.country} ${mockData.industry}`;
  pptx.author = 'YCP Market Research';
  pptx.subject = `${mockData.client} Project`;

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
    if (subtitle)
      slide.addText(subtitle, {
        x: LEFT_MARGIN,
        y: 0.8,
        w: CONTENT_WIDTH,
        h: 0.4,
        fontSize: 12,
        color: COLORS.gray,
        fontFace: FONT,
      });
    return slide;
  }

  function addTOCSlide(activeSection = 0, transitionStatement = '') {
    const slide = pptx.addSlide();
    slide.addText('Table of Contents', {
      x: LEFT_MARGIN,
      y: 0.3,
      w: CONTENT_WIDTH,
      h: 0.5,
      fontSize: 24,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
    });
    slide.addText(`${mockData.country}`, {
      x: LEFT_MARGIN,
      y: 0.85,
      w: CONTENT_WIDTH,
      h: 0.3,
      fontSize: 14,
      color: COLORS.gray,
      fontFace: FONT,
    });
    // Dynamic section names based on mockData
    const competitorSection = mockData.focus || `${mockData.industry} Competitors`;
    const sections = [
      '1. Policy & Regulations',
      '2. Market Data',
      `3. ${competitorSection}`,
      '4. Appendix',
    ];
    sections.forEach((sec, idx) => {
      const isActive = idx + 1 === activeSection;
      slide.addText(sec, {
        x: LEFT_MARGIN,
        y: 1.5 + idx * 0.5,
        w: 6,
        h: 0.4,
        fontSize: 16,
        bold: isActive,
        color: isActive ? COLORS.dk2 : COLORS.gray,
        fontFace: FONT,
      });
    });
    // Round 2: Add transition statement if provided
    if (transitionStatement) {
      addCalloutBox(slide, 'Section Transition', transitionStatement, {
        x: 6.5,
        y: 1.5,
        w: 6.0,
        h: 2.0,
        type: 'insight',
      });
    }
    return slide;
  }

  // SLIDE 1: Title
  const titleSlide = pptx.addSlide();
  titleSlide.addText(`${mockData.client} Project`, {
    x: 0,
    y: 1.8,
    w: '100%',
    h: 0.5,
    fontSize: 18,
    color: COLORS.gray,
    fontFace: FONT,
    align: 'center',
  });
  titleSlide.addText('Escort – Phase 1 Selection of Target Country', {
    x: 0,
    y: 2.3,
    w: '100%',
    h: 0.8,
    fontSize: 28,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
    align: 'center',
  });
  titleSlide.addText(`${mockData.country} - ${mockData.industry} Market Analysis`, {
    x: 0,
    y: 3.2,
    w: '100%',
    h: 0.5,
    fontSize: 20,
    color: COLORS.gray,
    fontFace: FONT,
    align: 'center',
  });
  console.log('  Slide 1: Title');

  // SLIDE 2: Why This Project? (Context slide - Story Flow P0)
  const whyProjectSlide = addSlideWithTitle(
    `Why ${mockData.country}? ${mockData.client}'s strategic imperative for overseas expansion`,
    `Project context: Identify optimal market for ${mockData.clientOrigin} energy services expansion in Southeast Asia`
  );

  // Strategic context table
  const contextRows = [tableHeader(['Strategic Question', 'Answer', 'Evidence'])];
  contextRows.push([
    { text: 'Why expand overseas?' },
    { text: 'Domestic market saturated, growth requires new markets' },
    { text: 'Japan gas demand declining 1-2%/yr since 2020' },
  ]);
  contextRows.push([
    { text: `Why ${mockData.country}?` },
    {
      text: `Fastest-growing energy market in ASEAN, strong ${mockData.clientOrigin}-bilateral ties`,
    },
    { text: '8%+ demand CAGR, $50B bilateral trade' },
  ]);
  contextRows.push([
    { text: 'Why energy services?' },
    { text: `Core competency match — ${mockData.client}'s industrial steam/efficiency expertise` },
    { text: 'Technical differentiation vs local players' },
  ]);
  contextRows.push([
    { text: 'Why now?' },
    { text: 'PDP8 creates supply gap, competitors already moving, 18-24mo window' },
    { text: 'Osaka Gas entered 2021, JERA 2020' },
  ]);
  whyProjectSlide.addTable(contextRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 9.0,
    h: 2.5,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });

  addCalloutBox(
    whyProjectSlide,
    'Project Scope & Deliverables',
    `This report assesses ${mockData.country} as a target market for ${mockData.client} energy services expansion.\n\n` +
      '• Market attractiveness: Policy, demand, pricing, supply gaps\n' +
      '• Competitive landscape: Japanese and local players, gaps to exploit\n' +
      '• Entry strategy: Mode, partner, timing, investment sizing\n' +
      '• Risk assessment: Key barriers and specific mitigations',
    { x: LEFT_MARGIN, y: 4.0, w: 9.0, h: 2.0, type: 'insight' }
  );

  addInsightsPanel(
    whyProjectSlide,
    [
      'Confidence: HIGH based on peer validation',
      'Scope: Market entry, not operations',
      'Timeline: Decision needed Q1 for Q4 entry',
      'Investment range: $10-30M initial',
    ],
    { x: 9.5, y: 1.3, w: 3.3 }
  );
  console.log('  Slide 2: Why This Project');

  // SLIDE 3: TOC
  addTOCSlide(0);
  console.log('  Slide 3: Table of Contents');

  // SLIDE 3: Executive Summary - GO Recommendation (McKinsey-style hypothesis-driven)
  const targetCustomersList = mockData.targetCustomers.join(', ');
  const partnersList = mockData.recommendedPartners.join(' or ');

  const execSlide1 = addSlideWithTitle(
    `Executive Summary: GO - ${mockData.country} offers structurally attractive entry`,
    `Recommend JV with local ESCO targeting ${mockData.clientOrigin} FDI manufacturers. Timeline: 6-12 months to first project. Investment: $10-30M.`
  );

  // "Why Now?" urgency box - the key insight
  addCalloutBox(
    execSlide1,
    'Why Now? Your window is 18-24 months',
    [
      '• PDP8 creates 7-8GW annual demand — EVN cannot keep up alone',
      '• 2024 brownouts forced industrial parks to seek alternatives urgently (Source: EVN Annual Report 2024, Reuters June 2024)',
      `• ${mockData.clientOrigin} OEMs (${targetCustomersList}) facing Scope 2 pressure, seeking partners`,
      '• Osaka Gas already proved the model — your window closes as market crowds',
    ].join('\n'),
    { x: LEFT_MARGIN, y: 1.3, w: 9.0, h: 1.8, type: 'recommendation' }
  );

  // Specific recommendation table
  const execRows1 = [tableHeader(['Decision Factor', 'Assessment', 'Your Action'])];
  execRows1.push(['Market Timing', 'Supply gap widening now', 'Enter Q1-Q2 before window closes']);
  execRows1.push([
    'Target Segment',
    `$500M industrial steam, 0% ${mockData.clientOrigin} share`,
    `Start with ${mockData.clientOrigin} FDI factories`,
  ]);
  execRows1.push(['Entry Mode', 'JV fastest (6-12mo vs 24-36mo)', `Partner with ${partnersList}`]);
  execRows1.push([
    'First Project',
    `Rooftop solar for ${mockData.targetCustomers[0]}/${mockData.targetCustomers[1]}`,
    `Leverage existing ${mockData.clientOrigin} relationships`,
  ]);
  execSlide1.addTable(execRows1, {
    x: LEFT_MARGIN,
    y: 3.3,
    w: 9.0,
    h: 2.2,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });

  // Specific insights with confidence
  addInsightsPanel(
    execSlide1,
    [
      'Confidence: HIGH — 4 Japanese players validating market',
      'Target: $200M revenue in 5 years (4% of addressable)',
      'Risk: Manageable with right partner structure',
      'Key success factor: Speed to market',
    ],
    { x: 9.5, y: 1.3, w: 3.3 }
  );
  console.log('  Slide 4: Executive Summary - GO Recommendation');

  // SLIDE 5: Executive Summary - Barriers
  const execSlide2 = addSlideWithTitle(
    `Executive Summary: Barriers are manageable – here's why`,
    `${mockData.country} ${mockData.industry}: SOE dominance blocks ~40% of market, but partner structure de-risks entry`
  );
  addCalloutBox(execSlide2, 'Key Barriers', mockData.summary.obstacles.slice(0, 3).join(' | '), {
    x: LEFT_MARGIN,
    y: 1.3,
    w: CONTENT_WIDTH,
    h: 1.0,
    type: 'warning',
  });
  // Round 3: Added quantification to barrier table
  const barrierRows = [tableHeader(['Barrier', 'Severity', 'Quantified Impact', 'Mitigation'])];
  barrierRows.push([
    'SOE Dominance',
    'High',
    'Blocks ~40% of market (PVN upstream, EVN grid)',
    'Partner with PVN-affiliated company',
  ]);
  barrierRows.push([
    '49% Ownership Limit',
    'Medium',
    'Adds $2-5M legal/structuring costs',
    'Structure as 50/50 technical JV',
  ]);
  barrierRows.push([
    'Regulatory Uncertainty',
    'Medium',
    'FIT changes can shift IRR by 2-3%',
    'Flexible contracts, price adjustment clauses',
  ]);
  barrierRows.push([
    'LNG Price Volatility',
    'Medium',
    '$2-5/MMBtu swings affect margins',
    'Take-or-pay (80%), hedging structures',
  ]);
  execSlide2.addTable(barrierRows, {
    x: LEFT_MARGIN,
    y: 2.5,
    w: 9,
    h: 2.5,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  addInsightsPanel(
    execSlide2,
    [
      'Confidence: MEDIUM – mitigated by partner',
      'SOE blocks 40% but leaves $3B accessible',
      'Key: partner selection de-risks 80%',
      'All 4 JP peers navigated successfully',
    ],
    { x: 9.5, y: 2.5, w: 3.3 }
  );
  // Round 3: Add quantification callout
  addCalloutBox(
    execSlide2,
    'Barrier Quantification Summary',
    'Total addressable market with SOE blockage: $3B of $5B SAM accessible to foreign players. 49% ownership adds ~$3M to deal costs but manageable via JV structure. Net: barriers reduce opportunity by 40%, not eliminate it.',
    { x: LEFT_MARGIN, y: 5.2, w: 9.0, h: 1.0, type: 'insight' }
  );
  console.log('  Slide 5: Executive Summary - Barriers');

  // SLIDE 6: TOC - Policy Section
  addTOCSlide(
    1,
    "Policy sets the rules of the game. Vietnam's regulatory framework creates ESCO market demand through mandates (audits, building codes) while allowing foreign participation via JV structures."
  );
  console.log('  Slide 6: TOC - Policy Section');

  // SLIDE 7: Policy Overview
  const policySlide = addSlideWithTitle(
    `${mockData.country} regulations favor foreign ESCO entry`,
    'PDP8 + Energy Efficiency Law create ESCO market demand. Source: Decree 21 requires annual audits for >1000 TOE consumers.'
  );
  const policyRows = [tableHeader(['Act/Policy', 'Year', 'Key Provisions', 'Impact'])];
  mockData.policy.foundationalActs.forEach((act) => {
    policyRows.push([
      { text: act.name },
      { text: String(act.year) },
      { text: act.description },
      { text: act.enforcement },
    ]);
  });
  const policyColWidths = calculateColumnWidths(policyRows, CONTENT_WIDTH);
  policySlide.addTable(policyRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 8.5,
    h: 3.0,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  // Policy timeline chart
  const policyTimelineChart = [
    {
      name: 'Policy Milestones',
      labels: ['2010', '2020', '2023', '2025', '2030'],
      values: [1, 2, 3, 4, 5],
      color: CHART_COLORS[5],
    },
  ];
  policySlide.addChart('line', policyTimelineChart, {
    x: 9.0,
    y: 1.3,
    w: 3.8,
    h: 2.0,
    showLegend: false,
    lineDataSymbol: 'circle',
  });
  addInsightsPanel(
    policySlide,
    [
      'Confidence: HIGH – based on Decree 31, PDP8',
      'PDP8 sets 70GW renewable target',
      'EE Law 2025 expands scope',
      'Foreign participation encouraged',
    ],
    { x: 9.5, y: 3.5, w: 3.3 }
  );
  // Round 2: Add callout box - Why Policy Matters
  addCalloutBox(
    policySlide,
    'Why Policy Matters',
    'Energy Efficiency Law + PDP8 mandates create ESCO demand. Decree 21 requires annual audits for >1000 TOE consumers = captive customer base for energy services.',
    { x: LEFT_MARGIN, y: 5.0, w: 8.5, h: 1.0, type: 'insight' }
  );
  console.log('  Slide 6: Policy Overview');

  // SLIDE 7: Foundational Acts Detail
  const actsSlide = addSlideWithTitle(
    '1.1 The Foundational Acts: Defining Control & Competition',
    'Key legislation shaping energy services market'
  );
  const actsRows = [tableHeader(['Legislation', 'Scope', 'Foreign Investor Implications'])];
  actsRows.push([
    'Law on Energy Efficiency (2010)',
    'Energy audits, building codes',
    'Creates ESCO market demand',
  ]);
  actsRows.push([
    'Revised EE Law (2025)',
    'Expanded scope, carbon pricing',
    'Increases compliance pressure',
  ]);
  actsRows.push(['PDP8 (2023)', 'Power development roadmap', 'Renewable/LNG opportunities']);
  actsRows.push([
    'Electricity Law (Revised 2024)',
    'Market liberalization',
    'Wholesale competition possible',
  ]);
  actsSlide.addTable(actsRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: CONTENT_WIDTH,
    h: 2.0,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  // Add liberalization timeline table
  const libRows = [tableHeader(['Phase', 'Timeline', 'Status'])];
  libRows.push(['Wholesale Competition', '2024-2026', 'In Progress']);
  libRows.push(['Retail Competition', '2030+', 'Planned']);
  libRows.push(['Full Deregulation', '2035+', 'Target']);
  actsSlide.addTable(libRows, {
    x: LEFT_MARGIN,
    y: 3.5,
    w: 6.0,
    h: 1.3,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  addCalloutBox(
    actsSlide,
    'Key Insight',
    `${mockData.country} follows Japan-style gradual liberalization - wholesale competition before retail. Distribution remains regulated, creating ESCO opportunity.`,
    { x: 6.5, y: 3.5, w: 6.3, h: 1.3, type: 'insight' }
  );
  console.log('  Slide 7: Foundational Acts');

  // SLIDE 8: Policy Details
  const policyDetailSlide = addSlideWithTitle(
    `Electricity liberalization creates 18-month JV window for ${mockData.client}`,
    `${mockData.country}'s efficiency targets (+2%/yr) match ${mockData.client}'s core expertise in industrial steam. Wholesale competition (2024-2026) = direct contracting NOW. Source: National Energy Strategy 2020.`
  );
  // Strategy goals table
  const strategyRows = [tableHeader(['Goal', 'Target', 'Implication'])];
  strategyRows.push(['Diversify Supply', 'Multiple sources', 'LNG/renewable opportunity']);
  strategyRows.push(['Reduce Imports', '<30% by 2030', 'Domestic production focus']);
  strategyRows.push(['Renewable Share', '15-20%', 'Solar/wind services']);
  strategyRows.push(['Energy Efficiency', '+2%/yr', 'ESCO market demand']);
  policyDetailSlide.addTable(strategyRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 8.5,
    h: 2.0,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  addInsightsPanel(
    policyDetailSlide,
    [
      'Clear strategic direction supports investment',
      'Efficiency targets create ESCO demand',
      'Import reduction = domestic opportunity',
      `Alignment with ${mockData.clientOrigin} technology strengths`,
    ],
    { x: 9.5, y: 1.3, w: 3.3 }
  );
  // Round 3: Add client-specific callout
  addCalloutBox(
    policyDetailSlide,
    `For ${mockData.client}: Wholesale Competition = Contract Direct NOW`,
    `Liberalization phases (2024-2026 wholesale, 2030+ retail) create early-mover window. ${mockData.client} can:\n` +
      `• Sign direct PPAs with industrial customers before retail opens\n` +
      `• Partner with ${mockData.recommendedPartners.join(' or ')} for distribution access\n` +
      `• Lock in 15-year contracts while competitors wait for retail deregulation\n` +
      `Timeline mirrors ${mockData.clientOrigin} 2015-2030 liberalization = proven playbook available.`,
    { x: LEFT_MARGIN, y: 3.5, w: 9.0, h: 2.0, type: 'recommendation' }
  );
  console.log('  Slide 8: Policy Details');

  // SLIDE 9: Regulations
  const regSlide = addSlideWithTitle(
    'Regulation',
    'Key regulations affecting energy services operations'
  );
  const regRows = [tableHeader(['Regulation', 'Requirement', 'Penalty/Incentive'])];
  regRows.push([
    'Energy Audit (Decree 21)',
    'Annual audit for >1000 TOE consumers',
    'Fines up to VND 200M',
  ]);
  regRows.push([
    'Building Energy Code',
    'New buildings must meet EE standards',
    'No permit without compliance',
  ]);
  regRows.push(['Renewable Portfolio', 'Utilities must purchase RE at FIT', 'Guaranteed offtake']);
  regSlide.addTable(regRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 8.5,
    h: 2.0,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  // Compliance timeline table
  const complianceRows = [tableHeader(['Regulation', 'Deadline', 'Impact'])];
  complianceRows.push(['Energy Audit', 'Annual', 'Creates ESCO demand']);
  complianceRows.push(['Building Code', 'New construction', 'Efficiency services']);
  complianceRows.push(['Carbon Reporting', '2026', 'ESG compliance']);
  regSlide.addTable(complianceRows, {
    x: 9.0,
    y: 1.3,
    w: 3.8,
    h: 1.5,
    fontSize: 9,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  // Round 2: Add callout box - Regulation creates ESCO demand
  addCalloutBox(
    regSlide,
    'Regulation Creates ESCO Demand',
    `Annual energy audits (Decree 21) + building codes = recurring demand for efficiency services. Carbon reporting (2026) will add ESG compliance pressure. Source: ${mockData.country} Ministry of Industry.`,
    { x: LEFT_MARGIN, y: 3.5, w: CONTENT_WIDTH, h: 1.0, type: 'insight' }
  );
  console.log('  Slide 9: Regulations');

  // SLIDE 10: Incentives
  const incentivesSlide = addSlideWithTitle(
    `Regulatory framework creates $500M+ recurring ESCO demand in ${mockData.country}`,
    `Energy audit mandates (>1000 TOE) + building codes + carbon reporting (2026) = sustained compliance-driven demand. ${mockData.clientOrigin} OEMs facing Scope 2 pressure; 18-month window before local ESCOs mature.`
  );
  const incRows = [tableHeader(['Incentive', 'Benefit', 'Eligibility', 'Duration'])];
  mockData.policy.incentives.forEach((inc) => {
    incRows.push([
      { text: inc.name },
      { text: inc.benefit },
      { text: inc.eligibility },
      { text: '15 years' },
    ]);
  });
  incentivesSlide.addTable(incRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 8.5,
    h: 2.5,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  // Add tax benefit visualization
  const taxBenefitChart = [
    {
      name: 'Effective Tax Rate (%)',
      labels: ['Standard', 'With Incentives'],
      values: [20, 8],
      color: CHART_COLORS[1],
    },
  ];
  incentivesSlide.addChart('bar', taxBenefitChart, {
    x: 9.0,
    y: 1.3,
    w: 3.8,
    h: 2.5,
    barDir: 'col',
    showLegend: false,
    showValue: true,
    dataLabelFontSize: 10,
  });
  // Round 3: ROI Calculation Example
  addCalloutBox(
    incentivesSlide,
    'ROI Calculation: $10M Renewable Project Example',
    'CIT Exemption (4+9): Years 1-4: 0% tax = $800K/yr savings | Years 5-13: 50% reduction = $400K/yr savings\n' +
      'Total CIT savings: ($800K × 4) + ($400K × 9) = $6.8M over 13 years\n' +
      'Import duty exemption on equipment: ~$500K additional savings\n' +
      'Net benefit: $7.3M tax incentives on $10M investment = 73% of principal recovered via incentives',
    { x: LEFT_MARGIN, y: 4.0, w: CONTENT_WIDTH, h: 1.8, type: 'recommendation' }
  );
  console.log('  Slide 10: Incentives');

  // SLIDE 11: TOC - Market Section
  addTOCSlide(
    2,
    "These regulations create the following market dynamics: 8%+ demand CAGR, supply gap of 7-8GW annually, and energy transition from coal to gas/renewables. This is the opportunity you're entering."
  );
  console.log('  Slide 11: TOC - Market Section');

  // SLIDE 12: Market Landscape Summary (McKinsey-style: TAM/SAM/SOM breakdown)
  const marketSummarySlide = addSlideWithTitle(
    `$50 billion total market, $5 billion addressable, $200 million capturable for ${mockData.client}`,
    'Market sizing: TAM → SAM → SOM funnel for realistic opportunity assessment'
  );

  // TAM/SAM/SOM table
  const marketSummaryRows = [
    tableHeader(['Market Layer', '2024 Size', '2030 Projection', 'Your Relevance']),
  ];
  marketSummaryRows.push([
    { text: 'TAM (Total)', options: { bold: true } },
    { text: '$25 billion' },
    { text: '$50 billion' },
    { text: 'All Vietnam energy services — too broad, includes SOE-controlled segments' },
  ]);
  marketSummaryRows.push([
    { text: 'SAM (Serviceable)', options: { bold: true } },
    { text: '$3 billion' },
    { text: '$5 billion' },
    {
      text: 'Industrial energy services + rooftop solar + ESCO — where foreign players can compete',
    },
  ]);
  marketSummaryRows.push([
    { text: 'SOM (Obtainable)', options: { bold: true, color: COLORS.green } },
    { text: '$100 million' },
    { text: '$200 million' },
    { text: 'Japanese FDI factories in industrial parks — your realistic 5-year target' },
  ]);
  marketSummarySlide.addTable(marketSummaryRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 9.0,
    h: 2.0,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });

  // Segment breakdown
  addCalloutBox(
    marketSummarySlide,
    'Segment Breakdown: Where to Play',
    'Industrial Steam ($500 million, 0% JP share) → Your entry point, technical expertise match\n' +
      "Rooftop Solar ($1.5 billion, Osaka Gas leads) → Partner or acquire, don't compete directly\n" +
      'Gas Supply ($2 billion, PVN controlled) → Access via SOE relationship, not direct ownership\n' +
      'Grid Services ($1 billion, EVN controlled) → Avoid entirely, regulatory barriers',
    { x: LEFT_MARGIN, y: 3.5, w: 9.0, h: 2.0, type: 'insight' }
  );

  // Add TAM/SAM/SOM chart for better visualization
  const tamSamSomChart = [
    { name: 'TAM', labels: ['2024', '2030'], values: [25, 50], color: CHART_COLORS[0] },
    { name: 'SAM', labels: ['2024', '2030'], values: [3, 5], color: CHART_COLORS[1] },
    { name: 'SOM', labels: ['2024', '2030'], values: [0.1, 0.2], color: CHART_COLORS[2] },
  ];
  marketSummarySlide.addChart('bar', tamSamSomChart, {
    x: 9.5,
    y: 1.3,
    w: 3.3,
    h: 2.0,
    barDir: 'col',
    showLegend: true,
    legendPos: 'b',
    dataLabelFontSize: 8,
  });
  addInsightsPanel(
    marketSummarySlide,
    [
      'Confidence: HIGH – validated by Osaka Gas model',
      'TAM: $50B (all energy services)',
      'SAM: $5B (where you can compete)',
      'SOM: $200M (your 5-year target)',
    ],
    { x: 9.5, y: 3.5, w: 3.3 }
  );
  console.log('  Slide 12: Market Landscape Summary');

  // SLIDE 13: TPES
  const tpesSlide = addSlideWithTitle(
    'Coal decline creates gas/renewable opportunity',
    `Coal 47%→30% by 2030 creates 17pt swing to gas/renewables. This is YOUR entry window. Source: PDP8, IEA.`
  );
  const tpesChartData = mockData.market.tpes.chartData.series.map((s, idx) => ({
    name: s.name,
    labels: mockData.market.tpes.chartData.categories,
    values: s.values,
    color: CHART_COLORS[idx % CHART_COLORS.length],
  }));
  tpesSlide.addChart('bar', tpesChartData, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 8.8,
    h: 4.0,
    barDir: 'bar',
    barGrouping: 'stacked',
    showLegend: true,
    legendPos: 'b',
    showValue: true,
    dataLabelFontSize: 8,
    dataLabelColor: 'FFFFFF',
  });
  addInsightsPanel(
    tpesSlide,
    [
      'Coal still dominant (47%)',
      'Gas projected to double by 2030',
      'Renewables: 6% to 15%',
      'Import dependence increasing',
    ],
    { x: 9.5, y: 1.3, w: 3.3 }
  );
  // Round 2: Add callout box - Energy Transition Opportunity
  addCalloutBox(
    tpesSlide,
    'Energy Transition Opportunity',
    'Coal→gas transition is YOUR entry window. 17pt swing from coal to gas/renewables by 2030 = massive demand for transition services, LNG supply, and efficiency upgrades. Source: PDP8, IEA World Energy Outlook 2024.',
    { x: LEFT_MARGIN, y: 5.5, w: 9.0, h: 1.0, type: 'insight' }
  );
  console.log('  Slide 13: TPES');

  // SLIDE 14: Energy Demand Quote
  const demandSlide = addSlideWithTitle(
    `8% demand CAGR vs ${mockData.clientOrigin} decline = reverse slope opportunity`,
    `${mockData.country} adding 7-8GW/yr vs Japan contracting 1%/yr. Growth markets reward scale; ${mockData.client}'s domestic expertise deploys into expanding pie.`
  );
  demandSlide.addText(
    `"${mockData.country}'s electricity demand is growing at 8-10% annually, driven by manufacturing FDI and urbanization. We must add 7-8 GW of new capacity every year just to keep up."`,
    {
      x: LEFT_MARGIN,
      y: 1.5,
      w: 8.5,
      h: 1.2,
      fontSize: 13,
      italic: true,
      color: COLORS.dk2,
      fontFace: FONT,
    }
  );
  demandSlide.addText(
    '- Nguyen Thi Lam Giang, Director General, Department of Energy Efficiency (2024)',
    { x: LEFT_MARGIN, y: 2.7, w: 8.5, h: 0.3, fontSize: 10, color: COLORS.gray, fontFace: FONT }
  );
  // Add demand growth chart
  const demandGrowthChart = [
    {
      name: 'Demand Growth (%)',
      labels: ['2020', '2021', '2022', '2023', '2024'],
      values: [7.5, 8.2, 9.1, 8.8, 8.5],
      color: CHART_COLORS[0],
    },
  ];
  demandSlide.addChart('line', demandGrowthChart, {
    x: 9.0,
    y: 1.3,
    w: 3.8,
    h: 2.5,
    showLegend: false,
    lineDataSymbol: 'circle',
  });
  addInsightsPanel(
    demandSlide,
    [
      'Government acknowledges supply crunch',
      'Policy support for efficiency/demand response',
      'Industrial parks facing power rationing',
      'Creates urgency for energy services',
    ],
    { x: 9.5, y: 4.0, w: 3.3 }
  );
  // Round 2: Add callout box - Supply Gap Quantified
  addCalloutBox(
    demandSlide,
    'Supply Gap Quantified + Coal Transition Economics',
    `8% CAGR = 7-8GW new capacity needed annually. 2024 brownouts forced industrial parks (${mockData.targetCustomers.join(', ')}) to install backup diesel → captive opportunity.\n\n` +
      `Coal Transition Cost-of-Transition Estimates:\n` +
      `• Coal plant conversion: $300-500/kW (retrofit boiler/turbine) — 3-5yr payback at current gas prices\n` +
      `• New gas capacity: $800-1,000/kW greenfield — 15% IRR achievable with take-or-pay PPA\n` +
      `• ${mockData.clientOrigin} playbook: Timeline mirrors Japan 2015-2030 coal phase-down = proven transition templates available.\n` +
      `Source: Director General quote, Ministry of Industry; IEA Coal Transition Economics 2024.`,
    { x: LEFT_MARGIN, y: 4.2, w: 9.0, h: 2.0, type: 'insight' }
  );
  console.log('  Slide 14: Energy Demand Quote');

  // SLIDE 15: Electricity Consumption vs Capacity
  const elecSlide = addSlideWithTitle(
    `Every MW ${mockData.client} deploys serves unfulfilled demand`,
    `Gap widening from 18GW (2024) to 40GW (2030). Private sector required. ${mockData.client} captures 0.5% addressable = 200MW = $150M revenue. Source: PDP8.`
  );
  const elecChartData = mockData.market.electricity.chartData.series.map((s, idx) => ({
    name: s.name,
    labels: mockData.market.electricity.chartData.categories,
    values: s.values,
    color: CHART_COLORS[idx % CHART_COLORS.length],
  }));
  elecSlide.addChart('line', elecChartData, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 8.5,
    h: 3.5,
    showLegend: true,
    legendPos: 'b',
    lineDataSymbol: 'circle',
    lineDataSymbolSize: 8,
  });
  addInsightsPanel(
    elecSlide,
    [
      `Capacity: ${mockData.market.electricity.totalCapacity}`,
      `Demand growth: ${mockData.market.electricity.demandGrowth}`,
      'Gap widening without new investment',
      'Private sector participation needed',
    ],
    { x: 9.5, y: 1.3, w: 3.3 }
  );
  // Round 2: Add callout box - Private Sector Needed
  addCalloutBox(
    elecSlide,
    'Private Sector Needed',
    `Gap widening from 18GW (2024) to 40GW (2030). This creates opportunity for behind-the-meter solutions where private sector can operate without grid constraints. ${mockData.client} can capture 5% addressable = $250M revenue opportunity in industrial efficiency. Source: PDP8.`,
    { x: LEFT_MARGIN, y: 5.0, w: 9.0, h: 1.2, type: 'insight' }
  );
  console.log('  Slide 15: Electricity Consumption vs Capacity');

  // SLIDE 16: Electricity Price
  const priceSlide = addSlideWithTitle(
    `Low prices force focus on peak-shaving + demand response`,
    `${mockData.country} industrial rates (7.2¢/kWh) 40% below Japan = efficiency savings harder to monetize. Peak-offpeak spread (9.2¢ vs 5.1¢ = 1.8x) creates demand response opportunity.`
  );
  const priceRows = [tableHeader(['Customer Type', 'Price (US cents/kWh)', 'Trend'])];
  priceRows.push(['Residential', '8.5', '+3-5% annually']);
  priceRows.push(['Industrial (Peak)', '9.2', '+4-6% annually']);
  priceRows.push(['Industrial (Off-peak)', '5.1', '+3% annually']);
  priceRows.push(['Large Industry', '7.2', 'Negotiated']);
  priceSlide.addTable(priceRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 6.5,
    h: 2.0,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  // Add price comparison chart
  const priceCompChart = [
    {
      name: 'Price (US¢/kWh)',
      labels: ['Residential', 'Ind Peak', 'Ind Off-peak', 'Large Ind'],
      values: [8.5, 9.2, 5.1, 7.2],
      color: CHART_COLORS[4],
    },
  ];
  priceSlide.addChart('bar', priceCompChart, {
    x: 7.0,
    y: 1.3,
    w: 5.5,
    h: 2.3,
    barDir: 'col',
    showLegend: false,
    showValue: true,
    dataLabelFontSize: 9,
  });
  addCalloutBox(
    priceSlide,
    'ESCO Payback Calculation: Peak-Shaving Case Study',
    `Low electricity prices (7.2¢/kWh vs Japan 18¢) make pure efficiency harder to monetize. Pivot to peak-shaving economics:\n\n` +
      `ESCO Project Example ($1M investment in 1MW battery + controls):\n` +
      `• Peak-offpeak arbitrage: (9.2¢ - 5.1¢) × 8hrs/day × 300days = $9,840/yr per 100kW\n` +
      `• Demand charge reduction: $15/kW/mo × 1000kW × 12mo = $180,000/yr\n` +
      `• Total annual savings: $278,000 | Simple payback: 3.6 years\n` +
      `• ESaaS model: ${mockData.client} owns equipment, charges 50% of savings = $139K/yr revenue\n\n` +
      `Focus on: (1) Demand charge reduction, (2) Peak shaving, (3) Captive generation for ${mockData.targetCustomers.join(', ')} factories.`,
    { x: LEFT_MARGIN, y: 3.6, w: CONTENT_WIDTH, h: 2.3, type: 'insight' }
  );
  console.log('  Slide 16: Electricity Price');

  // SLIDE 17: Natural Gas Import vs Domestic
  const gasSlide = addSlideWithTitle(
    `LNG import gap = ${mockData.client}'s supply opportunity`,
    `Domestic production declining 5%/yr from mature fields (8.0→5.0 bcm by 2030). LNG imports scaling 1→10 MTPA. First-mover window: 18-24 months before market crowds. Source: PVN.`
  );
  const gasChartData = mockData.market.gasLng.chartData.series.map((s, idx) => ({
    name: s.name,
    labels: mockData.market.gasLng.chartData.categories,
    values: s.values,
    color: CHART_COLORS[idx % CHART_COLORS.length],
  }));
  gasSlide.addChart('bar', gasChartData, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 8.5,
    h: 3.0,
    barDir: 'col',
    barGrouping: 'stacked',
    showLegend: true,
    legendPos: 'b',
  });
  addInsightsPanel(
    gasSlide,
    [
      'Domestic production declining',
      'LNG imports growing 20%+ annually',
      'Gap = import opportunity',
      'Pipeline: 1,500km offshore',
    ],
    { x: 9.5, y: 1.3, w: 3.3 }
  );
  // Round 2: Add callout box - First-Mover in LNG
  addCalloutBox(
    gasSlide,
    `First-Mover in LNG: Infrastructure + ${mockData.client} Opportunity`,
    `Domestic production declining 5%/yr from mature fields. LNG market nascent (1 MTPA → 10 MTPA by 2030).\n\n` +
      `Pipeline Infrastructure Detail:\n` +
      `• Existing: 1,500km offshore pipeline (PVN-controlled) — connects production fields to thermal plants\n` +
      `• Planned: 200km onshore distribution network (2025-2028) — creates industrial park access\n` +
      `• Capacity: Current 8 bcm/yr, expanding to 15 bcm/yr by 2030\n\n` +
      `First-mover window calculation: Osaka Gas entered 2021 → 50MW by 2024 = 3yr ramp. 18-24 months remaining before market crowds.\n` +
      `Source: PVN Infrastructure Master Plan 2024, JETRO Vietnam Energy Report.`,
    { x: LEFT_MARGIN, y: 4.3, w: 9.0, h: 2.0, type: 'insight' }
  );
  console.log('  Slide 17: Gas Import vs Domestic');

  // SLIDE 18: LNG Terminals
  const lngSlide = addSlideWithTitle(
    `${mockData.country} LNG buildout = downstream opportunity, not terminal ownership`,
    `Total 10.6 MTPA capacity by 2030. Terminal equity expensive ($500M+ per project). ${mockData.client} opportunity: downstream gas distribution + industrial supply contracts.`
  );
  const lngRows = [tableHeader(['Terminal', 'Capacity (MTPA)', 'Status', 'Target COD'])];
  mockData.market.gasLng.lngTerminals.forEach((term) => {
    lngRows.push([
      { text: term.name },
      { text: term.capacity },
      { text: term.status },
      { text: term.utilization },
    ]);
  });
  lngSlide.addTable(lngRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 8.5,
    h: 2.0,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  // Add LNG capacity chart
  const lngCapacityChart = [
    {
      name: 'Capacity (MTPA)',
      labels: ['Thi Vai', 'Hai Linh', 'Son My'],
      values: [1, 3.6, 6],
      color: CHART_COLORS[0],
    },
  ];
  lngSlide.addChart('bar', lngCapacityChart, {
    x: 9.0,
    y: 1.3,
    w: 3.8,
    h: 2.5,
    barDir: 'bar',
    showLegend: false,
    dataLabelFontSize: 9,
  });
  addCalloutBox(
    lngSlide,
    `Partner Roles + Investment Requirements for ${mockData.client}`,
    `Terminal Investment Economics (NOT recommended for ${mockData.client}):\n` +
      `• Thi Vai: $350M invested, PVN + JFE consortium — fully subscribed\n` +
      `• Hai Linh: $500M, Tokyo Gas + local partners — equity closed\n` +
      `• Son My: $800M+ projected, US/Korean consortium — high capital barrier\n\n` +
      `RECOMMENDED: Downstream distribution via JV with ${mockData.recommendedPartners.join(' or ')}:\n` +
      `• Investment: $10-30M for industrial gas distribution network\n` +
      `• Model: Tolling agreement with terminal operator (avoid capex) + direct supply to ${mockData.targetCustomers.join(', ')}\n` +
      `• Partner role: ${mockData.recommendedPartners[0]} provides customer access; ${mockData.client} provides technical expertise\n` +
      `Source: Vietnam LNG Industry Report 2024, Terminal operator annual reports.`,
    { x: LEFT_MARGIN, y: 3.6, w: CONTENT_WIDTH, h: 2.5, type: 'recommendation' }
  );
  console.log('  Slide 18: LNG Terminals');

  // SLIDE 19: Gas Price Analysis
  const gasPriceSlide = addSlideWithTitle(
    `Gas price dynamics favor long-term contracts`,
    `LNG term contracts ($8-10/MMBtu) vs spot ($10-15) = $2-5/MMBtu margin protection. Take-or-pay structures de-risk volume uncertainty. ${mockData.clientOrigin} trading house partnership unlocks procurement advantage.`
  );
  const gasPriceRows = [tableHeader(['Source', 'Price ($/MMBtu)', 'Availability', 'Trend'])];
  gasPriceRows.push(['Domestic (Pipeline)', '6-7', 'Declining', 'Down 5%/yr']);
  gasPriceRows.push(['LNG Spot', '10-15', 'Volatile', 'Fluctuating']);
  gasPriceRows.push(['LNG Term Contract', '8-10', 'Growing', 'Preferred']);
  gasPriceSlide.addTable(gasPriceRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 6.5,
    h: 1.8,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  // Add gas price comparison chart
  const gasPriceChart = [
    {
      name: 'Price ($/MMBtu)',
      labels: ['Domestic', 'LNG Term', 'LNG Spot'],
      values: [6.5, 9, 12.5],
      color: CHART_COLORS[2],
    },
  ];
  gasPriceSlide.addChart('bar', gasPriceChart, {
    x: 7.0,
    y: 1.3,
    w: 3.0,
    h: 2.5,
    barDir: 'col',
    showLegend: false,
    showValue: true,
    dataLabelFontSize: 9,
  });
  addInsightsPanel(
    gasPriceSlide,
    [
      'Domestic gas cheaper but declining',
      'LNG price gap narrowing',
      'Term contracts preferred',
      `${mockData.clientOrigin} trading expertise valued`,
    ],
    { x: 10.2, y: 1.3, w: 2.6 }
  );
  // Round 2: Add callout box - Pricing Opportunity with ROI calculation
  addCalloutBox(
    gasPriceSlide,
    `ROI Calculation: Gas Supply Contract for ${mockData.client}`,
    `LNG term contracts ($8-10/MMBtu) vs spot ($10-15/MMBtu) = stable margin opportunity.\n\n` +
      `Sample Deal Economics (1 MTPA gas supply to industrial customer):\n` +
      `• Procurement cost (term contract): $8.5/MMBtu × 52 Tbtu/yr = $442M/yr\n` +
      `• Selling price (industrial rate): $10.5/MMBtu = $546M/yr\n` +
      `• Gross margin: $104M/yr (19% margin)\n` +
      `• Working capital requirement: ~$40M (90-day inventory)\n` +
      `• ROI: 104/40 = 260% on working capital | Payback: ~4 months\n\n` +
      `Risk mitigation: Take-or-pay structures proven by Osaka Gas (80% commitment). ${mockData.clientOrigin} trading house expertise creates procurement advantage.\n` +
      `Source: Osaka Gas annual report, GIIGNL 2024 pricing data.`,
    { x: LEFT_MARGIN, y: 3.5, w: CONTENT_WIDTH, h: 2.5, type: 'insight' }
  );
  console.log('  Slide 19: Gas Price Analysis');

  // SLIDE 20: TOC - Japanese Players
  addTOCSlide(
    3,
    "Given this market opportunity, here's who's competing: 4 Japanese players active (Osaka Gas, JERA, Tokyo Gas, Toho Gas), but industrial steam segment wide open. This informs your entry strategy."
  );
  console.log('  Slide 20: TOC - Japanese Players');

  // SLIDE 21: Japanese Players Gap Analysis (McKinsey-style: identify YOUR gap)
  const jpOverviewSlide = addSlideWithTitle(
    'Osaka Gas owns solar. JERA owns LNG-to-power. No one owns industrial steam.',
    'Gap analysis: 4 Japanese players active, but industrial energy services segment wide open'
  );

  // Gap analysis table - what each player owns vs doesn't own
  const jpRows = [
    tableHeader(['Player', 'What They Own', "What They DON'T Own", 'Your Opportunity']),
  ];
  jpRows.push([
    'Osaka Gas',
    'Rooftop solar (50MW)',
    'Industrial steam, gas services',
    "Partner, don't compete on solar",
  ]);
  jpRows.push([
    'JERA',
    'LNG-to-power (large scale)',
    'ESCO, distributed energy',
    'Different segment entirely',
  ]);
  jpRows.push([
    'Tokyo Gas',
    'LNG terminal (Hai Linh)',
    'Customer relationships',
    'Downstream services',
  ]);
  jpRows.push([
    'Toho Gas',
    'Metering equipment only',
    'Energy services contracts',
    'Technical partner model',
  ]);
  jpOverviewSlide.addTable(jpRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 9.0,
    h: 2.3,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });

  // YOUR GAP callout box - the key insight
  addCalloutBox(
    jpOverviewSlide,
    `Your Gap: Industrial Steam/Efficiency for ${mockData.clientOrigin} Factories`,
    `Segment size: $500M | ${mockData.clientOrigin} penetration: 0% | ` +
      `${mockData.client} technical expertise in industrial steam matches unmet demand. ` +
      `Enter via efficiency services for ${targetCustomersList} factories — then expand to solar PPA as relationships mature.`,
    { x: LEFT_MARGIN, y: 3.8, w: 9.0, h: 1.5, type: 'recommendation' }
  );

  addInsightsPanel(
    jpOverviewSlide,
    [
      'Confidence: HIGH – $500M segment, 0% JP share',
      'Solar: Osaka Gas owns it — partner instead',
      'LNG: JERA/Tokyo Gas — different scale',
      'Your niche: Industrial efficiency for JP FDI',
    ],
    { x: 9.5, y: 1.3, w: 3.3 }
  );
  console.log('  Slide 21: Japanese Players Gap Analysis');

  // SLIDE 22: Investment Summary Table
  const investSlide = addSlideWithTitle(
    'All successful entrants used JV + trading house',
    'Pattern: 100% of Japanese entrants partnered with trading house (Sojitz, Marubeni) or SOE (PVN, EVN). None went greenfield alone.'
  );
  const investRows = [
    tableHeader(['Company', 'Year', 'Structure', 'Stake (%)', 'Value', 'Partner']),
  ];
  investRows.push(['Osaka Gas', '2021', 'JV', '50', '$100M', 'Sojitz']);
  investRows.push(['Tokyo Gas', '2022', 'Project Finance', '25', '$150M', 'Marubeni, PVN']);
  investRows.push(['Toho Gas', '2023', 'Technical Partner', '0', '$20M', 'PV Gas']);
  investRows.push(['JERA', '2020', 'JV', '49', '$300M', 'EVN']);
  investSlide.addTable(investRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 8.5,
    h: 2.5,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  // Add investment comparison chart
  const investChart = [
    {
      name: 'Investment ($M)',
      labels: ['JERA', 'Tokyo Gas', 'Osaka Gas', 'Toho Gas'],
      values: [300, 150, 100, 20],
      color: CHART_COLORS[3],
    },
  ];
  investSlide.addChart('bar', investChart, {
    x: 9.0,
    y: 1.3,
    w: 3.8,
    h: 2.5,
    barDir: 'bar',
    showLegend: false,
    dataLabelFontSize: 9,
  });
  // Round 3: Enhanced pattern insight with validation
  addCalloutBox(
    investSlide,
    'Pattern Recognition: 100% Success Rate with JV + Trading House',
    '✓ Osaka Gas: JV with Sojitz → 50MW deployed in 3 years\n' +
      '✓ Tokyo Gas: Project finance with Marubeni + PVN → LNG terminal access\n' +
      '✓ JERA: JV with EVN → 300MW gas power\n' +
      '✓ Toho Gas: Technical partnership with PVN → metering contracts\n\n' +
      'Zero Japanese entrants succeeded via greenfield or acquisition. This validates your recommended JV approach.',
    { x: LEFT_MARGIN, y: 4.0, w: CONTENT_WIDTH, h: 2.0, type: 'insight' }
  );
  console.log('  Slide 22: Investment Summary');

  // SLIDES 23-25: Case Studies (McKinsey-style: Playbook extraction)
  mockData.competitors.caseStudies.forEach((cs, idx) => {
    // Playbook-style title: Why did this work? Not just what happened.
    const csSlide = addSlideWithTitle(
      `${cs.company} Playbook: Why ${cs.project} Worked`,
      `${cs.year} | Partner: ${cs.partner} | Investment: ${cs.investment}`
    );

    // Left side: What happened + Why it worked
    const csRows = [
      [
        { text: 'Model', options: { bold: true, fill: { color: COLORS.dk2 }, color: 'FFFFFF' } },
        { text: cs.model },
      ],
      [
        { text: 'Outcome', options: { bold: true, fill: { color: COLORS.dk2 }, color: 'FFFFFF' } },
        { text: cs.outcome },
      ],
    ];
    csSlide.addTable(csRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: 5.8,
      h: 1.0,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [1.2, 4.6],
    });

    // Why it worked - the insight
    csSlide.addText('Why It Worked:', {
      x: LEFT_MARGIN,
      y: 2.5,
      w: 5.8,
      h: 0.3,
      fontSize: 11,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
    });
    const whyBullets = (cs.whyItWorked || []).map((w) => ({ text: w, options: { bullet: true } }));
    csSlide.addText(whyBullets, {
      x: LEFT_MARGIN,
      y: 2.85,
      w: 5.8,
      h: 2.0,
      fontSize: 10,
      fontFace: FONT,
      color: COLORS.black,
    });

    // Right side: IMPLICATION FOR SHIZUOKA GAS (the playbook)
    const impl = cs.implicationForShizuoka || { headline: '', specifics: [] };
    addCalloutBox(
      csSlide,
      'IMPLICATION FOR SHIZUOKA GAS',
      impl.headline + '\n\n' + impl.specifics.map((s) => `• ${s}`).join('\n'),
      { x: 6.3, y: 1.3, w: 6.5, h: 4.0, type: 'recommendation' }
    );

    console.log(`  Slide ${23 + idx}: Case Study Playbook - ${cs.company}`);
  });

  // SLIDE 27: Local Players - Where SOEs are strong vs weak (McKinsey-style gap analysis)
  const localSlide = addSlideWithTitle(
    'SOEs dominate supply chain, but neglect industrial energy services',
    "Implication: Partner with SOEs for access, compete in services where they're weak"
  );

  // Gap analysis - where SOEs are strong vs weak
  const localRows = [
    tableHeader(['SOE', "Where They're STRONG", "Where They're WEAK", 'Your Strategy']),
  ];
  localRows.push([
    'PVN (PetroVietnam)',
    'Upstream, LNG import monopoly',
    'Downstream services, ESCO',
    'Technical partner for gas supply',
  ]);
  localRows.push([
    'EVN',
    'Transmission, grid control',
    'Distributed generation, efficiency',
    'Avoid grid — focus captive power',
  ]);
  localRows.push([
    'PV Power',
    'Gas-fired generation fleet',
    'Customer relationships, services',
    'Target their industrial customers',
  ]);
  localSlide.addTable(localRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 9.0,
    h: 1.8,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });

  // Strategic implication callout
  addCalloutBox(
    localSlide,
    "Strategic Implication: Work WITH SOEs, Compete WHERE They're Weak",
    "1. Don't compete on generation or transmission — SOEs will block you\n" +
      '2. PVN relationship essential for gas supply — approach via Sojitz/Itochu who have existing ties\n' +
      '3. Target industrial parks directly — EVN has no presence in behind-the-meter services\n' +
      '4. Local ESCO market fragmented (no player >5% share per ENERDATA 2024 study) — consolidation opportunity',
    { x: LEFT_MARGIN, y: 3.3, w: 5.5, h: 2.0, type: 'insight' }
  );

  // Round 3: Add PVN partnership roadmap
  addCalloutBox(
    localSlide,
    'PVN Partnership Roadmap',
    'Month 1-3: Introduction via Sojitz/Itochu (existing PVN ties)\n' +
      'Month 4-6: Joint feasibility study for specific project\n' +
      'Month 7-12: Technical advisory contract ($5-10M scope)\n' +
      'Year 2+: Expand to gas supply agreements, co-development\n\n' +
      'Toho Gas model: Started with $20M metering → now positioned for larger deals.',
    { x: 6.0, y: 3.3, w: 6.8, h: 2.0, type: 'recommendation' }
  );

  addInsightsPanel(
    localSlide,
    [
      'SOEs: 85% of supply chain',
      'But 0% of industrial services',
      'Your entry: Behind-the-meter',
      'Key: PVN relationship via partner',
    ],
    { x: 9.5, y: 1.3, w: 3.3 }
  );
  console.log('  Slide 26: Local Players Gap Analysis');

  // SLIDE 28: Entry Strategy (McKinsey-style: ONE clear recommendation)
  const entrySlide = addSlideWithTitle(
    `JV is the only viable option for ${mockData.client}`,
    'Acquisition: No suitable targets. Greenfield: Too slow. JV: 6-12 months with right partner.'
  );

  // Why JV wins - elimination logic
  const whyJVRows = [tableHeader(['Option', 'Why NOT This', 'Timeline', 'Verdict'])];
  whyJVRows.push([
    { text: 'Acquisition', options: { color: COLORS.red } },
    { text: 'No suitable targets — local ESCOs too small/informal, no one to buy' },
    { text: '18-24 mo' },
    { text: '✗ RULED OUT', options: { bold: true, color: COLORS.red } },
  ]);
  whyJVRows.push([
    { text: 'Greenfield', options: { color: COLORS.orange } },
    { text: '2+ years to first project — too slow given 18-24 month competitive window' },
    { text: '24-36 mo' },
    { text: '✗ TOO SLOW', options: { bold: true, color: COLORS.orange } },
  ]);
  whyJVRows.push([
    { text: 'Joint Venture', options: { bold: true, color: COLORS.green } },
    { text: 'Partner brings relationships + local knowledge, you bring technology + capital' },
    { text: '6-12 mo' },
    { text: '✓ RECOMMENDED', options: { bold: true, color: COLORS.green } },
  ]);
  entrySlide.addTable(whyJVRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 9.0,
    h: 1.8,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });

  // SPECIFIC RECOMMENDATION callout
  addCalloutBox(
    entrySlide,
    'SPECIFIC RECOMMENDATION',
    `Partner: ${mockData.recommendedPartners[0]} Corporation (existing ${mockData.country} energy investments, strong ${mockData.clientOrigin} OEM relationships)\n` +
      'Structure: 50/50 JV, $15M initial capital commitment\n' +
      `First project: Industrial solar PPA for ${mockData.clientOrigin} FDI factory (${mockData.targetCustomers[0]} or ${mockData.targetCustomers[1]} ${mockData.country})\n` +
      'Timeline: Sign JV agreement Q1 → First project COD by Q4\n\n' +
      `Alternative partner: ${mockData.recommendedPartners[1]} Corporation (energy sector focus, less ${mockData.country} presence)`,
    { x: LEFT_MARGIN, y: 3.3, w: 9.0, h: 2.2, type: 'recommendation' }
  );

  // Entry timeline chart (Gantt-style)
  const timelineChart = [
    {
      name: 'Partner Selection',
      labels: ['Q1', 'Q2', 'Q3', 'Q4'],
      values: [3, 0, 0, 0],
      color: CHART_COLORS[0],
    },
    {
      name: 'JV Agreement',
      labels: ['Q1', 'Q2', 'Q3', 'Q4'],
      values: [1, 2, 0, 0],
      color: CHART_COLORS[1],
    },
    {
      name: 'First Project',
      labels: ['Q1', 'Q2', 'Q3', 'Q4'],
      values: [0, 1, 2, 1],
      color: CHART_COLORS[2],
    },
  ];
  entrySlide.addChart('bar', timelineChart, {
    x: 9.5,
    y: 1.3,
    w: 3.3,
    h: 2.0,
    barDir: 'bar',
    barGrouping: 'stacked',
    showLegend: true,
    legendPos: 'b',
    dataLabelFontSize: 7,
  });

  // Harvey Balls with clear winner highlighted
  const renderHarvey = (val) => '●'.repeat(val) + '○'.repeat(5 - val);
  const harveyRows = [tableHeader(['Criteria', 'JV ✓', 'Acq ✗', 'GF ✗'])];
  mockData.depth.entryStrategy.harveyBalls.criteria.forEach((crit, idx) => {
    harveyRows.push([
      { text: crit },
      {
        text: renderHarvey(mockData.depth.entryStrategy.harveyBalls.jv[idx]),
        options: { bold: true },
      },
      {
        text: renderHarvey(mockData.depth.entryStrategy.harveyBalls.acquisition[idx]),
        options: { color: COLORS.gray },
      },
      {
        text: renderHarvey(mockData.depth.entryStrategy.harveyBalls.greenfield[idx]),
        options: { color: COLORS.gray },
      },
    ]);
  });
  entrySlide.addTable(harveyRows, {
    x: 9.5,
    y: 3.5,
    w: 3.3,
    h: 2.0,
    fontSize: 8,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [1.3, 0.65, 0.65, 0.7],
  });

  // Add confidence tag via callout
  addCalloutBox(
    entrySlide,
    'Confidence: HIGH – elimination logic clear',
    'Acquisition ruled out: No targets. Greenfield ruled out: Too slow. JV is the only path that meets timeline and risk requirements.',
    { x: LEFT_MARGIN, y: 5.7, w: 9.0, h: 0.7, type: 'insight' }
  );
  console.log('  Slide 27: Entry Strategy - JV Recommendation');

  // SLIDE 28: Risk Assessment with Mitigations (McKinsey-style: Show HOW to manage, not just list)
  const riskSlide = addSlideWithTitle(
    'Risks are manageable with right partner and structure',
    'Every major risk has a proven mitigation — Osaka Gas case studies show the path'
  );

  // Risk table with specific mitigations
  const riskRows = [tableHeader(['Risk', 'Severity', 'Mitigation', 'Proof Point'])];
  riskRows.push([
    { text: 'SOE blocks access' },
    { text: 'HIGH', options: { bold: true, color: COLORS.red } },
    { text: 'Partner via Sojitz/Itochu who have existing PVN ties' },
    { text: 'Osaka Gas used Sojitz → 50MW deployed' },
  ]);
  riskRows.push([
    { text: '49% ownership cap' },
    { text: 'MEDIUM', options: { bold: true, color: COLORS.orange } },
    { text: '50/50 JV structure with local entity holds license' },
    { text: 'Standard structure for all JP players in VN' },
  ]);
  riskRows.push([
    { text: 'Regulatory uncertainty' },
    { text: 'MEDIUM', options: { bold: true, color: COLORS.orange } },
    { text: 'Flexible contracts with price adjustment clauses' },
    { text: 'PPA model has 15-year visibility' },
  ]);
  riskRows.push([
    { text: 'LNG price volatility' },
    { text: 'MEDIUM', options: { bold: true, color: COLORS.orange } },
    { text: 'Term contracts + take-or-pay structure' },
    { text: 'Osaka Gas hedged via 80% take-or-pay' },
  ]);
  riskRows.push([
    { text: 'Slow project timelines' },
    { text: 'LOW', options: { color: COLORS.green } },
    { text: 'Target industrial parks (faster permits)' },
    { text: 'Behind-the-meter avoids grid approval' },
  ]);
  riskSlide.addTable(riskRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 9.0,
    h: 3.2,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });

  // Risk severity chart
  const riskSeverityChart = [
    {
      name: 'Severity (1-5)',
      labels: ['SOE Block', 'Ownership', 'Regulation', 'LNG Price', 'Timeline'],
      values: [4, 3, 3, 3, 2],
      color: 'FF6B6B',
    },
    {
      name: 'With Mitigation',
      labels: ['SOE Block', 'Ownership', 'Regulation', 'LNG Price', 'Timeline'],
      values: [2, 1, 2, 2, 1],
      color: '4CAF50',
    },
  ];
  riskSlide.addChart('bar', riskSeverityChart, {
    x: 9.3,
    y: 1.3,
    w: 3.5,
    h: 3.0,
    barDir: 'col',
    barGrouping: 'clustered',
    showLegend: true,
    legendPos: 'b',
    dataLabelFontSize: 7,
  });

  addCalloutBox(
    riskSlide,
    'Bottom Line on Risk | Confidence: MEDIUM-HIGH – 4 peers validating',
    `No "unknown unknowns" — all risks have been encountered and mitigated by ${mockData.clientOrigin} peers (Osaka Gas, JERA, Tokyo Gas, Toho Gas). ` +
      `Key is partner selection: right partner (${mockData.recommendedPartners.join('/')}) de-risks 80% of concerns.`,
    { x: LEFT_MARGIN, y: 4.7, w: 12.5, h: 1.0, type: 'insight' }
  );
  console.log('  Slide 28: Risk Assessment');

  // SLIDE 29: Opportunities & Obstacles (McKinsey-style: Weighted scorecard)
  const ooSlide = addSlideWithTitle(
    `${mockData.country} is ATTRACTIVE (+14) – risk mitigated by partner`,
    'Net score +14 = ATTRACTIVE. Sensitivity: If SOE blocks, score drops to +8. Partner selection de-risks both.'
  );

  // Opportunities with weights
  ooSlide.addShape('rect', {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 5.8,
    h: 4.2,
    fill: { color: 'E8F5E9' },
    line: { color: '4CAF50', width: 1.5 },
  });
  ooSlide.addText('OPPORTUNITIES (+32 points)', {
    x: LEFT_MARGIN + 0.15,
    y: 1.4,
    w: 5.5,
    h: 0.35,
    fontSize: 12,
    bold: true,
    color: '2E7D32',
    fontFace: FONT,
  });
  const oppScored = [
    { text: '+8 | Market Growth: 8%+ demand CAGR', options: { bullet: false } },
    { text: '+6 | First-mover: LNG import nascent', options: { bullet: false } },
    { text: '+6 | Policy: Government committed to transition', options: { bullet: false } },
    { text: '+5 | FDI customers: ESG pressure pre-sells', options: { bullet: false } },
    { text: '+4 | Fragmented: No dominant local ESCO', options: { bullet: false } },
    { text: '+3 | Bilateral: Strong JP-VN relations', options: { bullet: false } },
  ];
  ooSlide.addText(oppScored, {
    x: LEFT_MARGIN + 0.15,
    y: 1.85,
    w: 5.5,
    h: 3.5,
    fontSize: 9,
    fontFace: FONT,
    color: COLORS.black,
  });

  // Obstacles with weights
  ooSlide.addShape('rect', {
    x: 6.5,
    y: 1.3,
    w: 5.8,
    h: 4.2,
    fill: { color: 'FFF3E0' },
    line: { color: 'FF9800', width: 1.5 },
  });
  ooSlide.addText('OBSTACLES (-18 points)', {
    x: 6.65,
    y: 1.4,
    w: 5.5,
    h: 0.35,
    fontSize: 12,
    bold: true,
    color: 'E65100',
    fontFace: FONT,
  });
  const obsScored = [
    { text: '-5 | SOE Dominance: PVN/EVN control chain', options: { bullet: false } },
    { text: '-4 | Ownership: 49% cap for power', options: { bullet: false } },
    { text: '-3 | Regulation: FIT/grid rules evolving', options: { bullet: false } },
    { text: '-3 | LNG Price: Volatile vs cheap coal', options: { bullet: false } },
    { text: '-2 | Talent: Limited local expertise', options: { bullet: false } },
    { text: '-1 | Timeline: 2-3 year project cycles', options: { bullet: false } },
  ];
  ooSlide.addText(obsScored, {
    x: 6.65,
    y: 1.85,
    w: 5.5,
    h: 3.5,
    fontSize: 9,
    fontFace: FONT,
    color: COLORS.black,
  });

  // Net score visualization chart
  const netScoreChart = [
    {
      name: 'Score',
      labels: ['Opportunities', 'Obstacles', 'Net'],
      values: [32, -18, 14],
      color: CHART_COLORS[1],
    },
  ];
  ooSlide.addChart('bar', netScoreChart, {
    x: 9.5,
    y: 4.8,
    w: 3.0,
    h: 1.5,
    barDir: 'col',
    showLegend: false,
    showValue: true,
    dataLabelFontSize: 9,
  });

  // Methodology note
  ooSlide.addText(
    'Scoring Methodology: Each factor rated 1-10 based on YCP ASEAN Market Entry Framework. Weights derived from 50+ Japanese market entries since 2018. Net score >10 = Attractive, 0-10 = Conditional, <0 = Unattractive.',
    {
      x: LEFT_MARGIN,
      y: 5.6,
      w: 9.0,
      h: 0.4,
      fontSize: 8,
      italic: true,
      color: COLORS.gray,
      fontFace: FONT,
    }
  );

  // Round 3: Enhanced callout with sensitivity analysis
  addCalloutBox(
    ooSlide,
    'NET SCORE: +14 (ATTRACTIVE) | With Sensitivity Analysis',
    `Base case: +14 = ATTRACTIVE → Recommend GO with JV structure\n\n` +
      `Sensitivity scenarios:\n` +
      `• If SOE blocks access: Score drops from +14 to +8 (CONDITIONAL) — mitigate via Sojitz/Itochu partner\n` +
      `• If 49% ownership cap tightened: Score drops to +5 (CONDITIONAL) — mitigate via technical partnership model\n` +
      `• If both risks materialize: Score drops to +2 (MARGINAL) — but unlikely given regulatory trajectory\n\n` +
      `Partner selection de-risks 80% of downside scenarios.`,
    { x: LEFT_MARGIN, y: 5.6, w: 12.5, h: 1.3, type: 'recommendation' }
  );
  console.log('  Slide 29: Opportunities & Obstacles Scorecard');

  // SLIDE 30: Recommended Next Steps (Call-to-Action - Story Flow P0)
  const nextStepsSlide = addSlideWithTitle(
    `Recommended Next Steps: Execute JV strategy in 4 phases`,
    `Decision required: Approve ${mockData.country} entry by end of Q1 to meet Q4 COD target`
  );

  // Phase timeline table
  const phaseRows = [
    tableHeader(['Phase', 'Timeline', 'Key Actions', 'Deliverable', 'Investment']),
  ];
  phaseRows.push([
    { text: '1. Partner Selection', options: { bold: true } },
    { text: 'Q1 (Weeks 1-8)' },
    {
      text: `Approach ${mockData.recommendedPartners[0]}, ${mockData.recommendedPartners[1]} for JV discussions. Due diligence on partner capabilities.`,
    },
    { text: 'Signed MOU with selected partner' },
    { text: '$50K (legal, travel)' },
  ]);
  phaseRows.push([
    { text: '2. JV Formation', options: { bold: true } },
    { text: 'Q1-Q2 (Weeks 8-16)' },
    { text: 'Negotiate JV terms, legal structure, governance. Register local entity.' },
    { text: 'JV company incorporated' },
    { text: '$500K (capital, legal)' },
  ]);
  phaseRows.push([
    { text: '3. First Project', options: { bold: true } },
    { text: 'Q2-Q3 (Weeks 16-32)' },
    {
      text: `Sign first PPA with ${mockData.targetCustomers[0]} or ${mockData.targetCustomers[1]} Vietnam factory. Procure equipment.`,
    },
    { text: 'Signed PPA, equipment ordered' },
    { text: '$3-5M (equipment, install)' },
  ]);
  phaseRows.push([
    { text: '4. Scale Operations', options: { bold: true } },
    { text: 'Q4+ (Week 32+)' },
    { text: 'COD first project. Pipeline development. Expand to 5+ industrial customers.' },
    { text: '50MW pipeline by end Y1' },
    { text: '$10-20M (growth capital)' },
  ]);
  nextStepsSlide.addTable(phaseRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 12.5,
    h: 3.0,
    fontSize: 9,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });

  // Decision required box
  addCalloutBox(
    nextStepsSlide,
    `DECISION REQUIRED: Approve ${mockData.country} entry by end of Q1`,
    'Recommended decision: GO with JV entry strategy.\n\n' +
      '• Total investment: $15-30M over 18 months (phased, with checkpoints)\n' +
      '• Target return: 15-20% IRR on energy services, 5-year payback\n' +
      '• Key risk mitigation: Partner selection (de-risks 80% of concerns)\n' +
      '• Window: 18-24 months before market crowds (Osaka Gas first-mover advantage erodes)',
    { x: LEFT_MARGIN, y: 4.5, w: 8.8, h: 2.0, type: 'recommendation' }
  );

  addInsightsPanel(
    nextStepsSlide,
    [
      `Immediate action: Approach ${mockData.recommendedPartners[0]} Q1`,
      'Confidence: HIGH based on peer models',
      `Contingency: ${mockData.recommendedPartners[1]} as backup partner`,
      'Success metric: First PPA signed by Q3',
    ],
    { x: 9.5, y: 4.5, w: 3.3 }
  );
  console.log('  Slide 30: Recommended Next Steps');

  // SLIDE 30B: Regional Comparison Matrix (2x2 Chart - 16th chart)
  const regionalMatrixSlide = addSlideWithTitle(
    `${mockData.country} vs ASEAN peers: High growth, moderate entry difficulty`,
    `Regional comparison validates ${mockData.country} selection. Higher growth than Thailand/Indonesia, lower barriers than Philippines. Source: YCP ASEAN Market Entry Framework.`
  );

  // Create 2x2 matrix data: Market Size (Y) vs Entry Difficulty (X)
  // Using scatter chart to show positioning
  const regionalScatterData = [
    {
      name: mockData.country,
      labels: [mockData.country],
      values: [[55, 75]], // [Entry Difficulty, Market Growth] - Vietnam: moderate difficulty, high growth
      color: CHART_COLORS[0],
    },
    {
      name: 'Thailand',
      labels: ['Thailand'],
      values: [[40, 45]], // Lower difficulty, moderate growth
      color: CHART_COLORS[1],
    },
    {
      name: 'Indonesia',
      labels: ['Indonesia'],
      values: [[60, 65]], // Higher difficulty, good growth
      color: CHART_COLORS[2],
    },
    {
      name: 'Philippines',
      labels: ['Philippines'],
      values: [[75, 55]], // High difficulty, moderate growth
      color: CHART_COLORS[3],
    },
    {
      name: 'Malaysia',
      labels: ['Malaysia'],
      values: [[35, 35]], // Low difficulty, low growth (mature market)
      color: CHART_COLORS[4],
    },
  ];

  // Use bar chart as proxy for 2x2 positioning (Market Growth Score)
  const marketGrowthChart = [
    {
      name: 'Market Growth Score',
      labels: [mockData.country, 'Indonesia', 'Philippines', 'Thailand', 'Malaysia'],
      values: [85, 70, 55, 50, 35],
      color: CHART_COLORS[0],
    },
  ];
  regionalMatrixSlide.addChart('bar', marketGrowthChart, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 5.5,
    h: 2.5,
    barDir: 'bar',
    showLegend: false,
    showValue: true,
    dataLabelFontSize: 10,
    catAxisTitle: 'Country',
    valAxisTitle: 'Growth Score (0-100)',
  });

  // Entry Difficulty Score chart
  const entryDifficultyChart = [
    {
      name: 'Entry Difficulty Score',
      labels: [mockData.country, 'Indonesia', 'Philippines', 'Thailand', 'Malaysia'],
      values: [55, 65, 75, 40, 30],
      color: CHART_COLORS[2],
    },
  ];
  regionalMatrixSlide.addChart('bar', entryDifficultyChart, {
    x: 6.3,
    y: 1.3,
    w: 5.5,
    h: 2.5,
    barDir: 'bar',
    showLegend: false,
    showValue: true,
    dataLabelFontSize: 10,
    catAxisTitle: 'Country',
    valAxisTitle: 'Difficulty Score (0-100, lower=easier)',
  });

  // Regional comparison table
  const regionalRows = [
    tableHeader([
      'Country',
      'Market Size ($B)',
      'Growth CAGR',
      'Entry Difficulty',
      'Recommendation',
    ]),
  ];
  regionalRows.push([
    { text: mockData.country, options: { bold: true, color: COLORS.green } },
    { text: '$5B SAM' },
    { text: '8.5%' },
    { text: 'Moderate (55/100)' },
    { text: 'GO - Primary target', options: { color: COLORS.green } },
  ]);
  regionalRows.push([
    { text: 'Indonesia' },
    { text: '$8B SAM' },
    { text: '6.5%' },
    { text: 'High (65/100)' },
    { text: 'CONDITIONAL - SOE barriers' },
  ]);
  regionalRows.push([
    { text: 'Philippines' },
    { text: '$3B SAM' },
    { text: '5.0%' },
    { text: 'Very High (75/100)' },
    { text: 'WAIT - Regulatory uncertainty' },
  ]);
  regionalRows.push([
    { text: 'Thailand' },
    { text: '$4B SAM' },
    { text: '4.5%' },
    { text: 'Low (40/100)' },
    { text: 'CONDITIONAL - Mature, competitive' },
  ]);
  regionalRows.push([
    { text: 'Malaysia' },
    { text: '$2B SAM' },
    { text: '3.0%' },
    { text: 'Very Low (30/100)' },
    { text: 'NO GO - Petronas dominance' },
  ]);
  regionalMatrixSlide.addTable(regionalRows, {
    x: LEFT_MARGIN,
    y: 4.0,
    w: CONTENT_WIDTH,
    h: 2.3,
    fontSize: 9,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  console.log('  Slide 30B: Regional Comparison Matrix');

  // SLIDE 31: TOC - Appendix
  addTOCSlide(4);
  console.log('  Slide 31: TOC - Appendix');

  // SLIDE 32: Appendix - Power Mix
  const appPowerSlide = addSlideWithTitle(
    `${mockData.country} Electricity Supply Mix`,
    'Shift from coal to gas and renewables by 2030 | Source: IEA, PDP8'
  );
  const powerMixData = [
    { name: 'Coal', labels: ['2024', '2030P'], values: [47, 30] },
    { name: 'Gas', labels: ['2024', '2030P'], values: [15, 25] },
    { name: 'Hydro', labels: ['2024', '2030P'], values: [18, 15] },
    { name: 'Solar', labels: ['2024', '2030P'], values: [12, 18] },
    { name: 'Wind', labels: ['2024', '2030P'], values: [5, 10] },
    { name: 'Other', labels: ['2024', '2030P'], values: [3, 2] },
  ].map((s, i) => ({ ...s, color: CHART_COLORS[i] }));
  appPowerSlide.addChart('pie', powerMixData, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: 5.5,
    h: 4.0,
    showLegend: true,
    legendPos: 'r',
  });
  addInsightsPanel(
    appPowerSlide,
    [
      'Coal: 47% → 30% (-17pts)',
      'Gas: 15% → 25% (+10pts)',
      'Renewables: 17% → 28% (+11pts)',
      `Implication: Gas services opportunity`,
    ],
    { x: 9.5, y: 1.3, w: 3.3 }
  );
  console.log('  Slide 32: Appendix - Power Mix');

  // SLIDE 33: Appendix - Price Reference
  const appPriceSlide = addSlideWithTitle(
    `${mockData.country} Electricity Ceiling Price`,
    `Regulated tariffs rising 3-5% annually | Source: ${mockData.country} Ministry of Industry`
  );
  const priceRefRows = [
    tableHeader(['Category', 'Current Price (US¢/kWh)', '2030 Target', 'CAGR', 'Notes']),
  ];
  priceRefRows.push(['Residential Base', '8.5', '10.2', '+3%', 'Subsidized']);
  priceRefRows.push(['Industrial Peak', '12.1', '14.5', '+4%', 'Demand charge rising']);
  priceRefRows.push(['Industrial Off-peak', '5.8', '6.5', '+2%', 'Incentive for load shift']);
  priceRefRows.push(['Large Industry', '7.2', '9.0', '+4%', 'Negotiated rates']);
  appPriceSlide.addTable(priceRefRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: CONTENT_WIDTH,
    h: 2.5,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  // Add regional electricity price comparison table
  const regionalPriceRows = [
    tableHeader([
      'Country',
      'Industrial Rate (US¢/kWh)',
      'Peak-Offpeak Spread',
      'ESCO Opportunity',
    ]),
  ];
  regionalPriceRows.push([
    { text: mockData.country, options: { bold: true } },
    { text: '7.2' },
    { text: '1.8x (9.2 vs 5.1)' },
    { text: 'Peak-shaving, demand response' },
  ]);
  regionalPriceRows.push([
    { text: 'Thailand' },
    { text: '10.5' },
    { text: '1.5x' },
    { text: 'Energy efficiency (mature market)' },
  ]);
  regionalPriceRows.push([
    { text: 'Indonesia' },
    { text: '8.5' },
    { text: '1.3x' },
    { text: 'Captive power (grid reliability)' },
  ]);
  regionalPriceRows.push([
    { text: 'Philippines' },
    { text: '14.5' },
    { text: '2.2x' },
    { text: 'Best ESCO economics, but high barriers' },
  ]);
  regionalPriceRows.push([
    { text: 'Japan (reference)' },
    { text: '18.0' },
    { text: '1.4x' },
    { text: `${mockData.client} home market benchmark` },
  ]);
  appPriceSlide.addTable(regionalPriceRows, {
    x: LEFT_MARGIN,
    y: 4.0,
    w: CONTENT_WIDTH,
    h: 2.0,
    fontSize: 9,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });

  addCalloutBox(
    appPriceSlide,
    `Regional Price Comparison: ${mockData.country} Positioning`,
    `${mockData.country} prices (7.2¢) sit 40% below Japan (18¢) but offer better peak-offpeak spread (1.8x vs 1.4x).\n\n` +
      `ESCO strategy implication: Pure efficiency ROI lower than Japan → pivot to:\n` +
      `• Demand response (capitalize on 1.8x spread)\n` +
      `• Captive generation (avoid grid reliability issues affecting ${mockData.targetCustomers.join(', ')})\n` +
      `• Carbon credits (premium pricing for ${mockData.clientOrigin} OEMs with Scope 2 targets)\n\n` +
      `Rising prices (+3-5%/yr) improve payback economics each year. Source: ${mockData.country} Ministry of Industry, IEA.`,
    { x: LEFT_MARGIN, y: 6.2, w: CONTENT_WIDTH, h: 1.5, type: 'insight' }
  );
  console.log('  Slide 33: Appendix - Price Reference');

  // SLIDE 34: Glossary 1 (Country-specific context)
  const glossarySlide1 = addSlideWithTitle(
    'Glossary (1/2)',
    `Key terms with ${mockData.country}-specific context`
  );
  const glossaryRows1 = [tableHeader(['Term', 'Definition', `${mockData.country} Context`])];
  glossaryRows1.push([
    'PDP8',
    'Power Development Plan 8',
    `${mockData.country}'s master plan targeting 70GW renewable capacity by 2030. Key driver of solar/wind investment.`,
  ]);
  glossaryRows1.push([
    'ESCO',
    'Energy Service Company',
    `In ${mockData.country}: Market fragmented, no player >5% share (ENERDATA 2024). JERA, Osaka Gas entering via JV structures.`,
  ]);
  glossaryRows1.push([
    'FIT',
    'Feed-in Tariff',
    `${mockData.country} FIT was 9.35¢/kWh for solar (2017-2020). Now transitioned to auction system.`,
  ]);
  glossaryRows1.push([
    'PPA',
    'Power Purchase Agreement',
    `In ${mockData.country}: 20-year PPAs typical for renewables. Foreign investors prefer PPA to direct sales.`,
  ]);
  glossaryRows1.push([
    'MTPA',
    'Million Tonnes Per Annum',
    `${mockData.country} LNG capacity: 1 MTPA (2024), targeting 10.6 MTPA by 2030.`,
  ]);
  glossarySlide1.addTable(glossaryRows1, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: CONTENT_WIDTH,
    h: 3.5,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });
  console.log('  Slide 34: Glossary 1');

  // SLIDE 35: Glossary 2 (Country-specific context)
  const glossarySlide2 = addSlideWithTitle(
    'Glossary (2/2)',
    `Key terms with ${mockData.country}-specific context`
  );
  const glossaryRows2 = [tableHeader(['Term', 'Definition', `${mockData.country} Context`])];
  glossaryRows2.push([
    'PVN',
    `Petro${mockData.country}`,
    'State-owned, controls upstream gas + LNG imports. Key gatekeeper for gas supply. Partner via trading house.',
  ]);
  glossaryRows2.push([
    'EVN',
    `Electricity ${mockData.country}`,
    'State utility, controls transmission grid. Avoid grid sales; focus on behind-the-meter services.',
  ]);
  glossaryRows2.push([
    'Decree 31',
    'Investment incentives law',
    'Provides CIT exemption (4+9 years), land rent reduction. Apply via industrial zone entry.',
  ]);
  glossaryRows2.push([
    '49% Rule',
    'Foreign ownership cap',
    'Applies to power sector. Work around via 50/50 JV with local partner holding license.',
  ]);
  glossaryRows2.push([
    'COD',
    'Commercial Operation Date',
    `${mockData.country} avg: 18-24 months from signing to COD for rooftop solar. Faster in industrial parks.`,
  ]);
  glossarySlide2.addTable(glossaryRows2, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: CONTENT_WIDTH,
    h: 3.5,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });

  // Data methodology note
  addCalloutBox(
    glossarySlide2,
    'Data Sources & Methodology',
    `Primary sources: IEA World Energy Outlook 2024, ${mockData.country} Ministry of Industry and Trade, PDP8 (2023), World Bank ${mockData.country} Energy Report.\n` +
      'Competitor data: Company announcements, JETRO, YCP proprietary database.\n' +
      'Scoring methodology: YCP ASEAN Market Entry Framework based on 50+ Japanese market entries since 2018.',
    { x: LEFT_MARGIN, y: 5.0, w: CONTENT_WIDTH, h: 1.5, type: 'insight' }
  );
  console.log('  Slide 35: Glossary 2');

  // SLIDE 36: Data Methodology & Sources (new appendix slide)
  const methodSlide = addSlideWithTitle(
    'Data Methodology & Sources',
    'Transparency on data collection and analysis approach'
  );
  const methodRows = [
    tableHeader(['Data Category', 'Primary Source', 'Secondary Validation', 'Confidence']),
  ];
  methodRows.push(['Market sizing', 'IEA, World Bank', 'JETRO, industry reports', 'HIGH']);
  methodRows.push([
    'Policy/regulation',
    `${mockData.country} govt publications`,
    'Law firm briefs (Baker McKenzie)',
    'HIGH',
  ]);
  methodRows.push([
    'Competitor activity',
    'Company announcements',
    'YCP proprietary interviews',
    'MEDIUM-HIGH',
  ]);
  methodRows.push([
    'Pricing data',
    'EVN published tariffs',
    'Industrial customer interviews',
    'HIGH',
  ]);
  methodRows.push(['Entry strategy', 'YCP case database', 'Client interviews', 'HIGH']);
  methodSlide.addTable(methodRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: CONTENT_WIDTH,
    h: 2.5,
    fontSize: 10,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
  });

  addCalloutBox(
    methodSlide,
    'Limitations & Caveats',
    '• Competitor investment figures based on public announcements; actual may vary ±20%\n' +
      '• Policy landscape evolving rapidly; recommend re-validation before final investment decision\n' +
      '• LNG price projections assume JKM benchmark; spot volatility not fully modeled\n' +
      '• SOE relationship dynamics based on peer experience; individual outcomes may vary',
    { x: LEFT_MARGIN, y: 4.0, w: CONTENT_WIDTH, h: 1.8, type: 'warning' }
  );
  console.log('  Slide 36: Data Methodology');

  // Save PPT
  const outputPath = path.join(__dirname, 'vietnam-output.pptx');
  await pptx.writeFile({ fileName: outputPath });

  const stats = fs.statSync(outputPath);
  console.log(`\n${'='.repeat(60)}`);
  console.log('VIETNAM PPTX GENERATION COMPLETE');
  console.log('='.repeat(60));
  console.log(`Output: ${outputPath}`);
  console.log(`Slides: 36`);
  console.log(`Size: ${(stats.size / 1024).toFixed(1)} KB`);

  return outputPath;
}

// Run generation
generateVietnamPPT()
  .then((outputPath) => {
    console.log('\nGeneration successful!');
    console.log('Next step: node compare-to-template.js vietnam-output.pptx');
  })
  .catch((err) => {
    console.error('\nGeneration failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
