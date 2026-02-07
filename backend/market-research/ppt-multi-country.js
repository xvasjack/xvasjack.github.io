const pptxgen = require('pptxgenjs');
const {
  truncate,
  truncateSubtitle,
  safeArray,
  ensureWebsite,
  isValidCompany,
  dedupeCompanies,
  enrichCompanyDesc,
  safeTableHeight,
} = require('./ppt-utils');
const { generateSingleCountryPPT } = require('./ppt-single-country');

// Multi-country comparison PPT - Matches YCP Escort format
// Structure: Title → Overview → For each country: Policy & Regulations → Market → Competitor Overview
async function generatePPT(synthesis, countryAnalyses, scope) {
  console.log('\n=== STAGE 4: PPT GENERATION ===');

  // Route to single-country PPT if applicable
  if (synthesis.isSingleCountry) {
    return generateSingleCountryPPT(synthesis, countryAnalyses[0], scope);
  }

  const pptx = new pptxgen();

  // Set exact slide size to match YCP template (13.333" x 7.5" = 16:9 widescreen)
  pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
  pptx.layout = 'YCP';

  // ===== DEFINE MASTER SLIDES =====
  // "No Bar" for cover slide — clean background, no header line
  pptx.defineSlideMaster({ title: 'NO_BAR', background: { color: 'FFFFFF' }, objects: [] });

  // "Main" for content slides — white background with header line
  pptx.defineSlideMaster({
    title: 'YCP_MAIN',
    background: { color: 'FFFFFF' },
    objects: [
      { line: { x: 0.376, y: 0.73, w: 12.586, h: 0, line: { color: '293F55', width: 3 } } },
    ],
  });

  pptx.author = 'YCP Market Research';
  pptx.title = `${scope.industry} Market Analysis - ${scope.targetMarkets.join(', ')}`;
  pptx.subject = scope.projectType;

  // YCP Theme Colors (matching ppt-single-country.js)
  const COLORS = {
    headerLine: '1B2A4A',
    accent3: '1B2A4A',
    accent1: '3C57FE',
    dk2: '1B2A4A',
    white: 'FFFFFF',
    black: '000000',
    gray: 'D6D7D9',
    footerText: '808080',
    green: '1D8348',
    orange: 'E46C0A',
    red: 'B71C1C',
  };

  // Set default font to Segoe UI (YCP standard)
  pptx.theme = { headFontFace: 'Segoe UI', bodyFontFace: 'Segoe UI' };
  const FONT = 'Segoe UI';

  // Widescreen dimensions (13.333" x 7.5" = 16:9)
  const CONTENT_WIDTH = 12.5; // Full content width for 16:9 widescreen
  const LEFT_MARGIN = 0.4; // Left margin matching YCP template

  // Truncate title to max 70 chars
  function truncateTitle(text) {
    if (!text) return '';
    const str = String(text).trim();
    if (str.length <= 70) return str;
    const cut = str.substring(0, 70);
    const lastSpace = cut.lastIndexOf(' ');
    return lastSpace > 40 ? cut.substring(0, lastSpace) : cut;
  }

  // Standard slide layout with title, subtitle (header line provided by YCP_MAIN master)
  function addSlide(title, subtitle = '') {
    const slide = pptx.addSlide({ masterName: 'YCP_MAIN' });
    // Title - 20pt bold navy
    slide.addText(truncateTitle(title), {
      x: LEFT_MARGIN,
      y: 0.049,
      w: CONTENT_WIDTH,
      h: 0.7,
      fontSize: 20,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
      valign: 'top',
      wrap: true,
    });
    // Header line is provided by YCP_MAIN master — no manual line needed
    // Message/subtitle - 11pt blue (the "so what")
    if (subtitle) {
      slide.addText(subtitle, {
        x: LEFT_MARGIN,
        y: 0.78,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 11,
        color: COLORS.accent1,
        fontFace: FONT,
      });
    }
    return slide;
  }

  // ============ SLIDE 1: TITLE ============
  const titleSlide = pptx.addSlide({ masterName: 'NO_BAR' });
  titleSlide.addText(scope.industry.toUpperCase(), {
    x: 0.5,
    y: 2.2,
    w: 9,
    h: 0.8,
    fontSize: 42,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  titleSlide.addText('Market Comparison', {
    x: 0.5,
    y: 3.0,
    w: 9,
    h: 0.5,
    fontSize: 24,
    color: COLORS.accent1,
    fontFace: FONT,
  });
  titleSlide.addText(scope.targetMarkets.join(' | '), {
    x: 0.5,
    y: 3.6,
    w: 9,
    h: 0.4,
    fontSize: 14,
    color: COLORS.black,
    fontFace: FONT,
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5,
    y: 6.5,
    w: 9,
    h: 0.3,
    fontSize: 10,
    color: '666666',
    fontFace: FONT,
  });

  // ============ SLIDE 2: OVERVIEW (Comparison Table) ============
  const overviewSlide = addSlide('Overview', 'Market comparison across countries');

  const overviewRows = [
    [
      {
        text: 'Country',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Market Size',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Foreign Ownership',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Risk Level',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
    ],
  ];

  countryAnalyses.forEach((c) => {
    if (c.error) return;
    overviewRows.push([
      { text: c.country, options: { fontFace: FONT } },
      { text: truncate(c.market?.marketSize || 'N/A', 60), options: { fontFace: FONT } },
      {
        text: truncate(c.policy?.foreignOwnershipRules || 'N/A', 60),
        options: { fontFace: FONT },
      },
      {
        text: truncate(c.policy?.regulatoryRisk || 'N/A', 40),
        options: { fontFace: FONT },
      },
    ]);
  });

  overviewSlide.addTable(overviewRows, {
    x: LEFT_MARGIN,
    y: 1.467,
    w: CONTENT_WIDTH,
    h: 4.7,
    fontSize: 12,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.0, 2.5, 2.5, 2.3],
    valign: 'top',
  });

  // ============ SLIDE 3: EXECUTIVE SUMMARY ============
  const execSlide = addSlide(
    'Executive Summary',
    synthesis.executiveSummary?.subtitle || 'Key findings across markets'
  );
  const execPoints = Array.isArray(synthesis.executiveSummary)
    ? synthesis.executiveSummary.slice(0, 5)
    : typeof synthesis.executiveSummary === 'string'
      ? [synthesis.executiveSummary]
      : synthesis.executiveSummary?.keyFindings ||
        synthesis.executiveSummary?.points || ['No executive summary available'];
  const keyFindings = safeArray(execPoints, 4);
  if (keyFindings.length > 0) {
    execSlide.addText(
      keyFindings.map((f, idx) => ({
        text: `${idx + 1}. ${truncate(typeof f === 'string' ? f : f.finding || f.text || '', 120)}`,
        options: { bullet: false, paraSpaceBefore: idx > 0 ? 8 : 0 },
      })),
      {
        x: LEFT_MARGIN,
        y: 1.467,
        w: CONTENT_WIDTH,
        h: 4.5,
        fontSize: 13,
        fontFace: FONT,
        color: COLORS.black,
        valign: 'top',
      }
    );
  }
  // Recommendation box
  if (synthesis.recommendation) {
    execSlide.addText('RECOMMENDATION', {
      x: LEFT_MARGIN,
      y: 5.5,
      w: CONTENT_WIDTH,
      h: 0.3,
      fontSize: 12,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
    });
    execSlide.addText(truncate(synthesis.recommendation, 200), {
      x: LEFT_MARGIN,
      y: 5.85,
      w: CONTENT_WIDTH,
      h: 0.7,
      fontSize: 11,
      fontFace: FONT,
      color: COLORS.black,
      valign: 'top',
      fill: { color: 'EDFDFF' },
      line: { color: COLORS.accent1, pt: 1 },
    });
  }

  // ============ SLIDE 4: MARKET SIZE COMPARISON (Bar Chart) ============
  const sizeSlide = addSlide('Market Size Comparison', 'Relative market opportunity by country');
  // Extract market sizes for chart
  const chartLabels = [];
  const chartValues = [];
  countryAnalyses.forEach((c) => {
    if (c.error) return;
    chartLabels.push(c.country);
    // Try to extract numeric value from market size string
    const sizeStr = c.market?.marketSize || '';
    const numMatch = sizeStr.match(/[$€]?\s*([\d,.]+)\s*(billion|million|B|M)?/i);
    let value = 0;
    if (numMatch) {
      value = parseFloat(numMatch[1].replace(/,/g, ''));
      if (/billion|B/i.test(numMatch[2] || '')) value *= 1000; // Convert to millions
    }
    chartValues.push(value || 100); // Default to 100 if can't parse
  });

  if (chartLabels.length > 0 && chartValues.some((v) => v > 0)) {
    sizeSlide.addChart(
      'bar',
      [
        {
          name: 'Market Size ($M)',
          labels: chartLabels,
          values: chartValues,
        },
      ],
      {
        x: LEFT_MARGIN,
        y: 1.467,
        w: CONTENT_WIDTH,
        h: 4.5,
        barDir: 'bar',
        showValue: true,
        dataLabelPosition: 'outEnd',
        dataLabelFontFace: FONT,
        dataLabelFontSize: 10,
        chartColors: [COLORS.accent1],
        valAxisMaxVal: Math.max(...chartValues) * 1.2,
        catAxisLabelFontFace: FONT,
        catAxisLabelFontSize: 11,
        valAxisLabelFontFace: FONT,
        valAxisLabelFontSize: 10,
      }
    );
  }

  // ============ SLIDE 5: ATTRACTIVENESS vs FEASIBILITY MATRIX ============
  const matrixSlide = addSlide(
    'Market Positioning Matrix',
    'Attractiveness vs Feasibility across markets'
  );
  // Draw quadrant background
  matrixSlide.addShape('rect', {
    x: 0.5,
    y: 1.467,
    w: 4.25,
    h: 2.5,
    fill: { color: 'D6E4F0' }, // Bottom-left (low-low)
  });
  matrixSlide.addShape('rect', {
    x: 4.75,
    y: 1.467,
    w: 4.25,
    h: 2.5,
    fill: { color: 'F2F2F2' }, // Bottom-right (high attract, low feas)
  });
  matrixSlide.addShape('rect', {
    x: 0.5,
    y: 3.967,
    w: 4.25,
    h: 2.5,
    fill: { color: 'F2F2F2' }, // Top-left (low attract, high feas)
  });
  matrixSlide.addShape('rect', {
    x: 4.75,
    y: 3.967,
    w: 4.25,
    h: 2.5,
    fill: { color: 'D6E4F0' }, // Top-right (high-high)
  });
  // Axis labels
  matrixSlide.addText('← Low Attractiveness | High Attractiveness →', {
    x: 0.5,
    y: 6.4,
    w: 8.5,
    h: 0.25,
    fontSize: 9,
    color: COLORS.footerText,
    fontFace: FONT,
    align: 'center',
  });
  matrixSlide.addText('High\nFeasibility\n\n\n\n\n\nLow\nFeasibility', {
    x: 9.1,
    y: 1.467,
    w: 0.6,
    h: 5.0,
    fontSize: 8,
    color: COLORS.footerText,
    fontFace: FONT,
    align: 'center',
    valign: 'middle',
  });
  // Plot countries as circles
  countryAnalyses.forEach((c, idx) => {
    if (c.error) return;
    const attract = c.summary?.ratings?.attractiveness || 5;
    const feas = c.summary?.ratings?.feasibility || 5;
    // Map 0-10 to x: 0.5-8.5 and y: 1.3-5.8 (inverted for y)
    const x = 0.5 + (attract / 10) * 8.0;
    const y = 5.8 - (feas / 10) * 4.5 + 0.3;
    // Country bubble
    const colors = [COLORS.accent1, COLORS.accent3, '2E7D32', 'E46C0A', 'C62828'];
    matrixSlide.addShape('ellipse', {
      x: x - 0.4,
      y: y - 0.3,
      w: 0.8,
      h: 0.6,
      fill: { color: colors[idx % colors.length] },
    });
    matrixSlide.addText(c.country.substring(0, 3).toUpperCase(), {
      x: x - 0.4,
      y: y - 0.15,
      w: 0.8,
      h: 0.3,
      fontSize: 8,
      bold: true,
      color: COLORS.white,
      fontFace: FONT,
      align: 'center',
      valign: 'middle',
    });
  });
  // Legend
  matrixSlide.addText('Score Legend:', {
    x: 0.5,
    y: 6.7,
    w: 1.5,
    h: 0.2,
    fontSize: 8,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  countryAnalyses.forEach((c, idx) => {
    if (c.error) return;
    matrixSlide.addText(
      `${c.country}: A=${c.summary?.ratings?.attractiveness || '?'}/F=${c.summary?.ratings?.feasibility || '?'}`,
      {
        x: 2.0 + idx * 2.2,
        y: 6.7,
        w: 2.2,
        h: 0.2,
        fontSize: 8,
        color: COLORS.black,
        fontFace: FONT,
      }
    );
  });

  // ============ SLIDE 6: RECOMMENDATION SUMMARY ============
  const recSlide = addSlide('Recommendation Summary', 'Prioritized market entry approach');
  // Build recommendation table
  const recRows = [
    [
      {
        text: 'Country',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Priority',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Entry Mode',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
      {
        text: 'Key Action',
        options: {
          bold: true,
          fill: { color: COLORS.accent3 },
          color: COLORS.white,
          fontFace: FONT,
        },
      },
    ],
  ];
  // Sort by attractiveness score
  const sortedCountries = [...countryAnalyses]
    .filter((c) => !c.error)
    .sort((a, b) => {
      const aScore =
        (a.summary?.ratings?.attractiveness || 0) + (a.summary?.ratings?.feasibility || 0);
      const bScore =
        (b.summary?.ratings?.attractiveness || 0) + (b.summary?.ratings?.feasibility || 0);
      return bScore - aScore;
    });
  sortedCountries.forEach((c, idx) => {
    const priority = idx === 0 ? 'PRIMARY' : idx === 1 ? 'SECONDARY' : 'MONITOR';
    const priorityColor = idx === 0 ? COLORS.green : idx === 1 ? COLORS.accent1 : COLORS.footerText;
    const entryMode = c.depth?.entryStrategy?.recommendation || c.summary?.recommendation || 'TBD';
    const keyAction =
      c.summary?.opportunities?.[0] || c.summary?.keyInsights?.[0]?.implication || '';
    recRows.push([
      { text: c.country },
      { text: priority, options: { color: priorityColor, bold: true } },
      { text: truncate(entryMode, 30) },
      {
        text: truncate(typeof keyAction === 'string' ? keyAction : keyAction.opportunity || '', 50),
      },
    ]);
  });
  const recTableH = safeTableHeight(recRows.length, { maxH: 4.5 });
  recSlide.addTable(recRows, {
    x: LEFT_MARGIN,
    y: 1.467,
    w: CONTENT_WIDTH,
    h: recTableH,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [1.8, 1.3, 2.5, 3.7],
    valign: 'top',
  });
  // Next steps
  recSlide.addText('Recommended Next Steps:', {
    x: LEFT_MARGIN,
    y: 1.467 + recTableH + 0.15,
    w: CONTENT_WIDTH,
    h: 0.3,
    fontSize: 12,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  const nextSteps = synthesis.nextSteps ||
    synthesis.executiveSummary?.nextSteps || [
      'Conduct detailed due diligence on primary market',
      'Identify and approach potential partners',
      'Develop market entry business case',
    ];
  recSlide.addText(
    safeArray(nextSteps, 3).map((s) => ({
      text: truncate(typeof s === 'string' ? s : s.step || '', 80),
      options: { bullet: true },
    })),
    {
      x: LEFT_MARGIN,
      y: 1.467 + recTableH + 0.5,
      w: CONTENT_WIDTH,
      h: 0.8,
      fontSize: 10,
      fontFace: FONT,
      color: COLORS.black,
      valign: 'top',
    }
  );

  // ============ COUNTRY SECTIONS ============
  // For each country: Policy & Regulations → Market → Competitor Overview
  for (const ca of countryAnalyses) {
    if (ca.error) continue;
    const countryName = ca.country;

    // ---------- SLIDE: {Country} - Policy & Regulations ----------
    const reg = ca.policy || {};
    const regSubtitle = reg.governmentStance ? truncateSubtitle(reg.governmentStance, 95) : '';
    const regSlide = addSlide(`${countryName} - Policy & Regulations`, regSubtitle);

    const regRows = [
      [
        {
          text: 'Area',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
        {
          text: 'Details',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
      ],
    ];

    // Add key legislation
    const laws = safeArray(reg.keyLegislation, 3);
    laws.forEach((law, idx) => {
      regRows.push([{ text: `Key Law ${idx + 1}` }, { text: truncate(law, 100) }]);
    });

    if (reg.foreignOwnershipRules) {
      regRows.push([
        { text: 'Foreign Ownership' },
        { text: truncate(reg.foreignOwnershipRules, 100) },
      ]);
    }

    const incentives = safeArray(reg.incentives, 2);
    incentives.forEach((inc, idx) => {
      regRows.push([{ text: idx === 0 ? 'Incentives' : '' }, { text: truncate(inc, 100) }]);
    });

    if (reg.regulatoryRisk) {
      regRows.push([{ text: 'Risk Level' }, { text: truncate(reg.regulatoryRisk, 100) }]);
    }

    regSlide.addTable(regRows, {
      x: LEFT_MARGIN,
      y: 1.467,
      w: CONTENT_WIDTH,
      h: 4.7,
      fontSize: 14,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.0, 7.3],
      valign: 'top',
    });

    // ---------- SLIDE: {Country} - Market ----------
    const market = ca.market || {};
    const marketSubtitle = market.marketSize ? truncateSubtitle(market.marketSize, 95) : '';
    const marketSlide = addSlide(`${countryName} - Market`, marketSubtitle);

    const marketRows = [
      [
        {
          text: 'Metric',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
        {
          text: 'Value',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
      ],
    ];

    if (market.marketSize) {
      marketRows.push([{ text: 'Market Size' }, { text: truncate(market.marketSize, 100) }]);
    }
    if (market.demand) {
      marketRows.push([{ text: 'Demand Drivers' }, { text: truncate(market.demand, 100) }]);
    }
    if (market.pricing) {
      marketRows.push([{ text: 'Pricing/Tariffs' }, { text: truncate(market.pricing, 100) }]);
    }
    if (market.supplyChain) {
      marketRows.push([{ text: 'Supply Chain' }, { text: truncate(market.supplyChain, 100) }]);
    }
    if (market.energyIntensity) {
      marketRows.push([
        { text: 'Energy Intensity' },
        { text: truncate(market.energyIntensity, 100) },
      ]);
    }
    if (market.keyObservation) {
      marketRows.push([
        { text: 'Key Observation' },
        { text: truncate(market.keyObservation, 100) },
      ]);
    }

    marketSlide.addTable(marketRows, {
      x: LEFT_MARGIN,
      y: 1.467,
      w: CONTENT_WIDTH,
      h: 4.7,
      fontSize: 11,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.0, 7.3],
      valign: 'top',
    });

    // ---------- SLIDE: {Country} - Competitor Overview ----------
    const comp = ca.competitors || {};
    // Extract just the intensity level (Low/Medium/High), not the full reasoning
    let compIntensityLevel = '';
    if (comp.competitiveIntensity) {
      const intensityStr = String(comp.competitiveIntensity);
      const levelMatch = intensityStr.match(/^(low|medium|high|medium-high|medium-low)/i);
      if (levelMatch) {
        compIntensityLevel = `Competitive intensity: ${levelMatch[1]}`;
      } else {
        compIntensityLevel = truncateSubtitle(`Competitive intensity: ${intensityStr}`, 60);
      }
    }
    const compSlide = addSlide(`${countryName} - Competitor Overview`, compIntensityLevel);

    const compRows = [
      [
        {
          text: 'Company',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
        {
          text: 'Type',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
        {
          text: 'Notes',
          options: {
            bold: true,
            fill: { color: COLORS.accent3 },
            color: COLORS.white,
            fontFace: FONT,
          },
        },
      ],
    ];

    dedupeCompanies(
      safeArray(comp.localPlayers, 3)
        .map((p) => (typeof p === 'string' ? { name: p } : p))
        .filter(isValidCompany)
        .map(ensureWebsite)
        .map((c) => enrichCompanyDesc(c, ca.country || '', scope.industry || ''))
    ).forEach((p) => {
      const name = p.name || 'Unknown';
      const desc = p.description || '';
      const nameCell = p.website
        ? {
            text: truncate(name, 30),
            options: { hyperlink: { url: p.website }, color: '0066CC' },
          }
        : { text: truncate(name, 30) };
      compRows.push([
        nameCell,
        { text: 'Local' },
        { text: truncate(desc, 350), options: { fontSize: 9 } },
      ]);
    });

    dedupeCompanies(
      safeArray(comp.foreignPlayers, 3)
        .map((p) => (typeof p === 'string' ? { name: p } : p))
        .filter(isValidCompany)
        .map(ensureWebsite)
        .map((c) => enrichCompanyDesc(c, ca.country || '', scope.industry || ''))
    ).forEach((p) => {
      const name = p.name || 'Unknown';
      const desc = p.description || '';
      const nameCell = p.website
        ? {
            text: truncate(name, 30),
            options: { hyperlink: { url: p.website }, color: '0066CC' },
          }
        : { text: truncate(name, 30) };
      compRows.push([
        nameCell,
        { text: 'Foreign' },
        { text: truncate(desc, 350), options: { fontSize: 9 } },
      ]);
    });

    const compTableH = safeTableHeight(compRows.length, { maxH: 4.0 });
    compSlide.addTable(compRows, {
      x: LEFT_MARGIN,
      y: 1.467,
      w: CONTENT_WIDTH,
      h: compTableH,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: [2.5, 1.0, 5.8],
      valign: 'top',
    });

    // Entry barriers section — dynamic y based on table
    const barriers = safeArray(comp.entryBarriers, 4);
    const barriersY = 1.467 + compTableH + 0.15;
    if (barriers.length > 0 && barriersY < 6.0) {
      compSlide.addShape('line', {
        x: LEFT_MARGIN,
        y: barriersY,
        w: CONTENT_WIDTH,
        h: 0,
        line: { color: COLORS.dk2, width: 2.5 },
      });
      compSlide.addText('Barriers to Entry', {
        x: LEFT_MARGIN,
        y: barriersY + 0.1,
        w: CONTENT_WIDTH,
        h: 0.35,
        fontSize: 14,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      compSlide.addText(
        barriers.map((b) => ({ text: truncate(b, 90), options: { bullet: true } })),
        {
          x: LEFT_MARGIN,
          y: barriersY + 0.5,
          w: CONTENT_WIDTH,
          h: Math.min(1.3, 7.0 - (barriersY + 0.5)),
          fontSize: 14,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
    }
  }

  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  console.log(`PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB`);

  return pptxBuffer;
}

module.exports = { generatePPT };
