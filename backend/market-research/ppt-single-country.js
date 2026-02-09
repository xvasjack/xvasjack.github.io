const pptxgen = require('pptxgenjs');
const {
  truncate,
  truncateSubtitle,
  safeArray,
  ensureWebsite,
  isValidCompany,
  dedupeCompanies,
  enrichCompanyDesc,
  calculateColumnWidths,
  addSourceFootnote,
  addCalloutBox,
  addInsightsPanel,
  addOpportunitiesObstaclesSummary,
  addStackedBarChart,
  addLineChart,
  addBarChart,
  addPieChart,
  safeTableHeight,
  choosePattern,
  addDualChart,
  addChevronFlow,
  addInsightPanelsFromPattern,
  addCalloutOverlay,
  addMatrix,
  addCaseStudyRows,
  addFinancialCharts,
  templatePatterns,
  addTocSlide,
  addOpportunitiesBarriersSlide,
  addHorizontalFlowTable,
  flattenPlayerProfile,
  C_WHITE,
  C_BLACK,
  C_BORDER,
  C_MUTED,
  C_LIGHT_GRAY,
  C_GRAY_BG,
  C_SECONDARY,
} = require('./ppt-utils');
const { ensureString } = require('./shared/utils');
const { validatePptData } = require('./quality-gates');

// Safety wrapper: ensure any value going into a table cell is a plain string.
// AI sometimes returns nested objects/arrays instead of text — this prevents pptxgenjs crashes.
function safeCell(value, maxLen) {
  const str = ensureString(value);
  return maxLen ? truncate(str, maxLen) : str;
}

// Truncate text to max word count to prevent table overflow
function truncateWords(text, maxWords) {
  if (!text) return '';
  const words = String(text).trim().split(/\s+/);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ');
}

// ============ SECTION-BASED SLIDE GENERATOR ============
// Generates slides dynamically based on data depth using pattern library
async function generateSingleCountryPPT(synthesis, countryAnalysis, scope) {
  console.log(`Generating section-based single-country PPT for ${(synthesis || {}).country}...`);

  const pptx = new pptxgen();

  // Set exact slide size to match YCP template (13.333" x 7.5" = 16:9 widescreen)
  pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
  pptx.layout = 'YCP';

  // YCP Theme Colors (from Escort template extraction — template-patterns.json)
  const tpColors = templatePatterns.style?.colors || {};
  const COLORS = {
    headerLine: tpColors.dk2 || '1F497D',
    accent3: tpColors.accent3 || '011AB7',
    accent1: tpColors.accent1 || '007FFF',
    dk2: tpColors.dk2 || '1F497D',
    white: tpColors.lt1 || 'FFFFFF',
    black: tpColors.dk1 || '000000',
    gray: 'F2F2F2',
    footerText: '808080',
    green: '2E7D32',
    orange: tpColors.orange || 'E46C0A',
    red: 'B71C1C',
    hyperlink: '0066CC',
    border: C_BORDER,
    muted: C_MUTED,
    lightGray: C_LIGHT_GRAY,
    secondary: C_SECONDARY,
    warningFill: 'FFF8E1',
    darkGray: '444444',
  };

  // ===== DEFINE MASTER SLIDES =====
  // "No Bar" for cover slide — clean background, no header line
  pptx.defineSlideMaster({
    title: 'NO_BAR',
    background: { color: COLORS.white },
    objects: [],
  });

  // "Main" for content slides — white background with double header lines (from Escort template)
  const tpPos = templatePatterns.pptxPositions || {};
  const hlTop = tpPos.headerLineTop || { x: 0, y: 1.0208, w: 13.3333, h: 0 };
  const hlBot = tpPos.headerLineBottom || { x: 0, y: 1.0972, w: 13.3333, h: 0 };
  const flPos = tpPos.footerLine || { x: 0, y: 7.2361, w: 13.3333, h: 0 };
  // Footer elements from template extraction
  const tpFooter = templatePatterns.style?.footer || {};
  const crPos = tpFooter.copyrightPos || { x: 4.11, y: 7.26, w: 5.12, h: 0.24, fontSize: 8 };
  const crText = tpFooter.copyrightText || '(C) YCP 2026';
  pptx.defineSlideMaster({
    title: 'YCP_MAIN',
    background: { color: COLORS.white },
    objects: [
      {
        line: {
          x: hlTop.x,
          y: hlTop.y,
          w: hlTop.w,
          h: 0,
          line: { color: hlTop.color || '293F55', width: hlTop.thickness || 4.5 },
        },
      },
      {
        line: {
          x: hlBot.x,
          y: hlBot.y,
          w: hlBot.w,
          h: 0,
          line: { color: hlBot.color || '293F55', width: hlBot.thickness || 2.25 },
        },
      },
      // Footer line (thin separator above copyright)
      {
        line: {
          x: flPos.x,
          y: flPos.y,
          w: flPos.w,
          h: 0,
          line: { color: flPos.color || '293F55', width: flPos.thickness || 2.25 },
        },
      },
      // Copyright text
      {
        text: {
          text: crText,
          options: {
            x: crPos.x,
            y: crPos.y,
            w: crPos.w,
            h: crPos.h,
            fontSize: crPos.fontSize || 8,
            fontFace: 'Segoe UI',
            color: COLORS.footerText,
            align: 'center',
          },
        },
      },
    ],
  });

  // Legacy alias — keep for any remaining references
  pptx.defineSlideMaster({
    title: 'YCP_MASTER',
    background: { color: COLORS.white },
    objects: [],
  });

  pptx.author = 'YCP Market Research';
  pptx.title = `${(synthesis || {}).country} - ${scope.industry} Market Analysis`;
  pptx.subject = scope.projectType;

  // Set default font to Segoe UI (YCP standard)
  pptx.theme = { headFontFace: 'Segoe UI', bodyFontFace: 'Segoe UI' };
  const FONT = 'Segoe UI';

  // Slide numbers (from template footer extraction)
  const pgPos = tpFooter.pageNumPos || { x: 10.22, y: 7.28, w: 3.11, h: 0.2 };
  pptx.slideNumber = {
    x: pgPos.x,
    y: pgPos.y,
    w: pgPos.w,
    h: pgPos.h,
    fontSize: 8,
    fontFace: FONT,
    color: COLORS.footerText,
  };

  // Use countryAnalysis for detailed data (policy, market, competitors, etc.)
  // synthesis contains metadata like isSingleCountry, confidenceScore, etc.
  const policy = countryAnalysis.policy || {};
  const market = countryAnalysis.market || {};
  const competitors = countryAnalysis.competitors || {};
  const depth = countryAnalysis.depth || {};
  // Provide safe defaults for summary to prevent empty slides
  const rawSummary = countryAnalysis.summary || countryAnalysis.summaryAssessment || {};
  const summary = {
    timingIntelligence: rawSummary.timingIntelligence || {},
    lessonsLearned: rawSummary.lessonsLearned || {},
    opportunities: rawSummary.opportunities || [],
    obstacles: rawSummary.obstacles || [],
    ratings: rawSummary.ratings || { attractiveness: 0, feasibility: 0 },
    keyInsights: rawSummary.keyInsights || [],
    goNoGo: rawSummary.goNoGo || {},
    recommendation: rawSummary.recommendation || '',
  };
  const country = countryAnalysis.country || (synthesis || {}).country;

  // Enrichment fallback: use synthesis when available, otherwise fall back to countryAnalysis summary
  const enrichment = synthesis || {};

  // Format projects field — handles both string and array-of-objects from AI synthesis
  function formatProjects(projects) {
    if (!projects) return '';
    if (typeof projects === 'string') return projects;
    if (Array.isArray(projects)) {
      return projects
        .slice(0, 3)
        .map((proj) => {
          if (typeof proj === 'string') return proj;
          if (proj && typeof proj === 'object') {
            const parts = [proj.name || proj.project || ''];
            if (proj.value) parts.push(proj.value);
            if (proj.year) parts.push(proj.year);
            if (proj.status) parts.push(proj.status);
            return parts.filter(Boolean).join(' - ');
          }
          return String(proj);
        })
        .filter(Boolean)
        .join('; ');
    }
    return ensureString(projects);
  }

  // Enrich thin company descriptions by combining available data fields
  // Target: 50+ words with specific metrics, strategic context, and market relevance
  function enrichDescription(company) {
    if (!company || typeof company !== 'object') return company;
    const desc = company.description || '';
    const wordCount = desc.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 45) return company; // Already rich enough
    // Build a richer description from available fields
    const parts = [];
    if (desc) parts.push(desc);
    // Financial metrics first (most valuable for consulting output)
    if (company.revenue && !desc.includes(company.revenue))
      parts.push(`Revenue: ${company.revenue}.`);
    if (company.marketShare && !desc.includes(company.marketShare))
      parts.push(`Market share: ${company.marketShare}.`);
    if (company.growthRate) parts.push(`Growth rate: ${company.growthRate}.`);
    if (company.employees) parts.push(`Workforce: ${company.employees} employees.`);
    // Strategic assessment (support both singular and plural field names)
    if (company.strengths) parts.push(`Key strengths: ${company.strengths}.`);
    else if (company.strength) parts.push(`Key strength: ${company.strength}.`);
    if (company.weaknesses) parts.push(`Weaknesses: ${company.weaknesses}.`);
    else if (company.weakness) parts.push(`Weakness: ${company.weakness}.`);
    if (company.competitiveAdvantage)
      parts.push(`Competitive advantage: ${company.competitiveAdvantage}.`);
    if (company.keyDifferentiator) parts.push(`Key differentiator: ${company.keyDifferentiator}.`);
    // Market presence
    if (company.projects) parts.push(`Key projects: ${formatProjects(company.projects)}.`);
    if (company.assessment) parts.push(company.assessment);
    if (company.success) parts.push(company.success);
    if (company.presence) parts.push(`Market presence: ${company.presence}.`);
    if (company.type) parts.push(`Company type: ${company.type}.`);
    // Origin and market entry
    if (company.origin && company.entryYear)
      parts.push(`${company.origin}-based, entered market in ${company.entryYear}.`);
    else if (company.origin) parts.push(`Origin: ${company.origin}.`);
    else if (company.entryYear) parts.push(`Entered market: ${company.entryYear}.`);
    if (company.mode) parts.push(`Entry mode: ${company.mode}.`);
    // Partnership/acquisition fit
    if (company.partnershipFit) parts.push(`Partnership fit: ${company.partnershipFit}/5.`);
    if (company.acquisitionFit) parts.push(`Acquisition fit: ${company.acquisitionFit}/5.`);
    if (company.estimatedValuation) parts.push(`Est. valuation: ${company.estimatedValuation}.`);
    // Additional context
    // Financial highlights
    if (company.financialHighlights?.investmentToDate)
      parts.push(`Investment to date: ${company.financialHighlights.investmentToDate}.`);
    if (company.financialHighlights?.profitMargin)
      parts.push(`Profit margin: ${company.financialHighlights.profitMargin}.`);
    if (company.investmentToDate && !company.financialHighlights?.investmentToDate)
      parts.push(`Investment to date: ${company.investmentToDate}.`);
    if (company.profitMargin && !company.financialHighlights?.profitMargin)
      parts.push(`Profit margin: ${company.profitMargin}.`);
    if (company.services) parts.push(`Core services: ${company.services}.`);
    if (company.clients) parts.push(`Key clients: ${company.clients}.`);
    if (company.founded) parts.push(`Founded: ${company.founded}.`);
    if (company.headquarters) parts.push(`HQ: ${company.headquarters}.`);
    if (company.specialization) parts.push(`Specialization: ${company.specialization}.`);
    if (company.certifications) parts.push(`Certifications: ${company.certifications}.`);
    if (company.recentActivity) parts.push(`Recent activity: ${company.recentActivity}.`);
    if (company.strategy) parts.push(`Strategy: ${company.strategy}.`);
    // Let thin descriptions stay thin — no fabricated filler
    let result = parts.join(' ').trim();
    const words = result.split(/\s+/);
    if (words.length > 60) result = words.slice(0, 60).join(' ');
    company.description = result;
    return company;
  }

  // Apply validation, deduplication, and description enrichment to all player arrays
  function enrichPlayerArray(arr) {
    if (!Array.isArray(arr)) return arr;
    return dedupeCompanies(
      arr.filter(isValidCompany).map(ensureWebsite).map(flattenPlayerProfile).map(enrichDescription)
    );
  }
  if (competitors.japanesePlayers?.players)
    competitors.japanesePlayers.players = enrichPlayerArray(competitors.japanesePlayers.players);
  if (competitors.localMajor?.players)
    competitors.localMajor.players = enrichPlayerArray(competitors.localMajor.players);
  if (competitors.foreignPlayers?.players)
    competitors.foreignPlayers.players = enrichPlayerArray(competitors.foreignPlayers.players);
  if (depth.partnerAssessment?.partners)
    depth.partnerAssessment.partners = enrichPlayerArray(depth.partnerAssessment.partners);
  if (competitors.maActivity?.potentialTargets)
    competitors.maActivity.potentialTargets = enrichPlayerArray(
      competitors.maActivity.potentialTargets
    );

  // Global cross-array dedup: remove companies that appear in multiple arrays
  const globalSeen = new Set();
  function globalDedup(arr) {
    if (!arr) return arr;
    return arr.filter((item) => {
      const key = String(item.name || '')
        .trim()
        .toLowerCase()
        .replace(
          /\b(ltd|inc|corp|co|llc|plc|sdn\s*bhd|pte|pvt|limited|corporation|company)\b\.?/gi,
          ''
        )
        .replace(/[^a-z0-9]/g, '');
      if (!key || globalSeen.has(key)) return false;
      globalSeen.add(key);
      return true;
    });
  }
  if (competitors.japanesePlayers?.players)
    competitors.japanesePlayers.players = globalDedup(competitors.japanesePlayers.players);
  if (competitors.localMajor?.players)
    competitors.localMajor.players = globalDedup(competitors.localMajor.players);
  if (competitors.foreignPlayers?.players)
    competitors.foreignPlayers.players = globalDedup(competitors.foreignPlayers.players);
  if (depth.partnerAssessment?.partners)
    depth.partnerAssessment.partners = globalDedup(depth.partnerAssessment.partners);
  if (competitors.maActivity?.potentialTargets)
    competitors.maActivity.potentialTargets = globalDedup(competitors.maActivity.potentialTargets);

  // Debug: confirm data source
  console.log(`  [PPT] Using countryAnalysis data for ${country}`);
  console.log(`  [PPT] policy keys: ${Object.keys(policy).join(', ') || 'EMPTY'}`);
  console.log(`  [PPT] market keys: ${Object.keys(market).join(', ') || 'EMPTY'}`);
  console.log(`  [PPT] depth keys: ${Object.keys(depth).join(', ') || 'EMPTY'}`);
  console.log(`  [PPT] summary.goNoGo: ${summary.goNoGo ? 'present' : 'EMPTY'}`);

  // Truncate title to max 70 chars
  function truncateTitle(text) {
    if (!text) return '';
    const str = String(text).trim();
    if (str.length <= 70) return str;
    const cut = str.substring(0, 70);
    const lastSpace = cut.lastIndexOf(' ');
    return lastSpace > 40 ? cut.substring(0, lastSpace) : cut;
  }

  // Standard slide layout — positions from Escort template extraction
  const tpTitle = tpPos.title || { x: 0.3758, y: 0.2917, w: 12.5862, h: 0.6944 };
  const tpContent = tpPos.contentArea || { x: 0.3758, y: 1.5, w: 12.5862, h: 5.0 };
  const tpSource = tpPos.sourceBar || { x: 0.3758, y: 6.6944, w: 12.5862, h: 0.25 };
  // Title font from template extraction
  const tpTitleFont = templatePatterns.style?.fonts?.title || {};
  const tpTitleFontSize = tpTitleFont.size || 20;
  const tpTitleBold = tpTitleFont.bold !== undefined ? tpTitleFont.bold : false;
  const CONTENT_WIDTH = tpContent.w; // Full content width for 16:9 widescreen
  const LEFT_MARGIN = tpContent.x; // Left margin from template
  const TITLE_X = tpTitle.x; // Title x position
  const TITLE_W = tpTitle.w; // Title width
  const SOURCE_W = tpSource.w; // Footer/source width
  const CONTENT_Y = tpContent.y; // Content area top Y from template

  // Maximum y for content shapes (source bar y = bottom of content zone)
  const CONTENT_BOTTOM = tpSource.y;
  // Footer y position
  const FOOTER_Y = tpSource.y;

  // Helper: apply alternating row fill for readability (skip header row at idx 0)
  function applyAlternateRowFill(_rows) {
    // No-op: Escort template uses no alternate row shading
  }

  // Helper: clamp shape height so bottom doesn't exceed CONTENT_BOTTOM
  function clampH(y, h) {
    const maxH = Math.max(0.3, CONTENT_BOTTOM - y);
    return Math.min(h, maxH);
  }

  // Options: { sources: [{url, title}], dataQuality: 'high'|'medium'|'low'|'estimated' }
  function addSlideWithTitle(title, subtitle = '', options = {}) {
    // Use YCP_MAIN master (has header line built in)
    const slide = pptx.addSlide({ masterName: 'YCP_MAIN' });

    // Title shape (position + font from template extraction)
    slide.addText(truncateTitle(title), {
      x: TITLE_X,
      y: tpTitle.y,
      w: TITLE_W,
      h: tpTitle.h,
      fontSize: tpTitleFontSize,
      bold: tpTitleBold,
      color: COLORS.dk2,
      fontFace: FONT,
      valign: 'top',
    });
    // Subtitle as separate shape (below title, above header line)
    if (subtitle) {
      const dataQualityIndicator =
        options.dataQuality === 'estimated' ? ' *' : options.dataQuality === 'low' ? ' +' : '';
      slide.addText(subtitle + dataQualityIndicator, {
        x: TITLE_X,
        y: tpTitle.y + tpTitle.h + 0.02,
        w: TITLE_W,
        h: 0.3,
        fontSize: 14,
        italic: true,
        color: COLORS.black,
        fontFace: FONT,
        valign: 'top',
      });
    }
    // Header line is provided by YCP_MAIN master — no manual line needed

    // Merge data quality indicator + source citations into ONE shape to prevent overlap
    const hasDataQuality = options.dataQuality === 'estimated' || options.dataQuality === 'low';
    const sourcesToRender = options.sources || options.citations;
    const footerParts = [];

    if (hasDataQuality) {
      const legend =
        options.dataQuality === 'estimated'
          ? '* Estimated data - verify independently'
          : '+ Limited data availability';
      footerParts.push({
        text: legend + (sourcesToRender && sourcesToRender.length > 0 ? '   |   ' : ''),
        options: { fontSize: 8, italic: true, color: COLORS.black, fontFace: FONT },
      });
    }

    if (sourcesToRender && sourcesToRender.length > 0) {
      footerParts.push({
        text: 'Sources: ',
        options: { fontSize: 10, fontFace: FONT, color: COLORS.muted },
      });

      sourcesToRender.slice(0, 3).forEach((source, idx) => {
        if (idx > 0)
          footerParts.push({
            text: ', ',
            options: { fontSize: 10, fontFace: FONT, color: COLORS.muted },
          });

        const sourceUrl = typeof source === 'object' ? source.url : source;
        const sourceTitle = typeof source === 'object' ? source.title : null;

        if (sourceUrl && sourceUrl.startsWith('http')) {
          let displayText;
          try {
            const url = new URL(sourceUrl);
            displayText = sourceTitle || url.hostname.replace('www.', '');
          } catch (e) {
            displayText = sourceTitle || truncate(sourceUrl, 30);
          }
          footerParts.push({
            text: displayText,
            options: {
              fontSize: 10,
              fontFace: FONT,
              color: COLORS.hyperlink,
              hyperlink: { url: sourceUrl },
            },
          });
        } else {
          footerParts.push({
            text: sourceTitle || String(source),
            options: { fontSize: 10, fontFace: FONT, color: COLORS.muted },
          });
        }
      });
    } else if (!hasDataQuality) {
      // Default source when none provided
      footerParts.push({
        text: 'Source: YCP Analysis',
        options: { fontSize: 10, fontFace: FONT, color: COLORS.muted },
      });
    }

    if (footerParts.length > 0) {
      slide.addText(footerParts, {
        x: LEFT_MARGIN,
        y: FOOTER_Y,
        w: SOURCE_W,
        h: 0.27,
        valign: 'top',
      });
    }

    return slide;
  }

  // Helper for table header row
  function tableHeader(cols) {
    return cols.map((text) => ({
      text,
      options: {
        bold: false,
        fontSize: 14,
        fill: { color: COLORS.accent3 },
        color: COLORS.white,
        fontFace: FONT,
      },
    }));
  }

  // Helper to show "Data unavailable" message on slides with missing data
  function addDataUnavailableMessage(slide, message = 'Data not available for this section') {
    // Single text shape with fill to avoid overlap between rect+text
    slide.addText(
      [
        {
          text: '! ' + message + '\n',
          options: { fontSize: 14, bold: true, color: COLORS.black, fontFace: FONT },
        },
        {
          text: 'This data could not be verified through research. Recommend validating independently before making decisions.',
          options: { fontSize: 12, color: COLORS.black, fontFace: FONT },
        },
      ],
      {
        x: LEFT_MARGIN,
        y: 2.0,
        w: CONTENT_WIDTH,
        h: 2.0,
        fill: { color: COLORS.warningFill },
        line: { color: COLORS.orange, pt: 1 },
        margin: [8, 12, 8, 12],
        valign: 'top',
      }
    );
  }

  // Helper to extract citations from raw research data for a specific topic category
  function getCitationsForCategory(category) {
    if (!countryAnalysis.rawData) return [];
    const citations = [];
    for (const [key, data] of Object.entries(countryAnalysis.rawData)) {
      if (key.startsWith(category) && data.citations && Array.isArray(data.citations)) {
        citations.push(...data.citations);
      }
    }
    // Deduplicate and limit to 5
    return [...new Set(citations)].slice(0, 5);
  }

  // Helper to get data quality for a category (returns lowest quality among topics)
  function getDataQualityForCategory(category) {
    if (!countryAnalysis.rawData) return 'unknown';
    const qualities = [];
    for (const [key, data] of Object.entries(countryAnalysis.rawData)) {
      if (key.startsWith(category) && data.dataQuality) {
        qualities.push(data.dataQuality);
      }
    }
    // Return worst quality level
    if (qualities.includes('estimated')) return 'estimated';
    if (qualities.includes('low')) return 'low';
    if (qualities.includes('medium')) return 'medium';
    if (qualities.includes('high')) return 'high';
    return 'unknown';
  }

  // ============ DATA BLOCK CLASSIFICATION ============
  // Classify data blocks in a section for pattern selection
  function classifyDataBlocks(sectionName, sectionData) {
    const blocks = [];

    switch (sectionName) {
      case 'Policy & Regulations': {
        const foundActs = sectionData.foundationalActs || {};
        blocks.push({
          key: 'foundationalActs',
          dataType: 'regulation_list',
          data: foundActs,
          title:
            foundActs.slideTitle ||
            `${country} - ${scope.industry || 'Industry'} Foundational Acts`,
          subtitle: truncateSubtitle(foundActs.subtitle || foundActs.keyMessage || '', 180),
          citations: getCitationsForCategory('policy_'),
          dataQuality: getDataQualityForCategory('policy_'),
        });

        const natPolicy = sectionData.nationalPolicy || {};
        blocks.push({
          key: 'nationalPolicy',
          dataType: 'policy_analysis',
          data: natPolicy,
          title: natPolicy.slideTitle || `${country} - National Energy Policy`,
          subtitle: truncateSubtitle(natPolicy.policyDirection || '', 180),
          citations: getCitationsForCategory('policy_'),
          dataQuality: getDataQualityForCategory('policy_'),
        });

        const investRestrict = sectionData.investmentRestrictions || {};
        blocks.push({
          key: 'investmentRestrictions',
          dataType: 'regulation_list',
          data: investRestrict,
          title: investRestrict.slideTitle || `${country} - Foreign Investment Rules`,
          subtitle: truncateSubtitle(investRestrict.riskJustification || '', 180),
          citations: getCitationsForCategory('policy_'),
          dataQuality: getDataQualityForCategory('policy_'),
        });

        const keyIncentives = sectionData.keyIncentives || [];
        if (Array.isArray(keyIncentives) && keyIncentives.length > 0) {
          blocks.push({
            key: 'keyIncentives',
            dataType: 'regulation_list',
            data: { incentives: keyIncentives },
            title: `${country} - Key Investment Incentives`,
            subtitle: truncateSubtitle(`${keyIncentives.length} incentive programs identified`, 95),
            citations: getCitationsForCategory('policy_'),
            dataQuality: getDataQualityForCategory('policy_'),
          });
        }
        break;
      }

      case 'Market Overview': {
        const marketCitations = getCitationsForCategory('market_');
        const marketDQ = getDataQualityForCategory('market_');
        // Hardcoded fallback keys (energy-specific)
        const hardcodedMarketKeys = [
          'tpes',
          'finalDemand',
          'electricity',
          'gasLng',
          'pricing',
          'escoMarket',
        ];
        const hardcodedLabels = {
          tpes: 'Total Primary Energy Supply',
          finalDemand: 'Final Energy Demand',
          electricity: 'Electricity & Power',
          gasLng: 'Gas & LNG Market',
          pricing: 'Energy Pricing',
          escoMarket: 'ESCO Market',
        };
        // Dynamic key discovery: use actual keys from sectionData
        const skipKeys = new Set([
          '_synthesisError',
          'message',
          'slideTitle',
          'subtitle',
          'keyMessage',
        ]);
        const dynamicKeys = Object.keys(sectionData).filter(
          (k) =>
            !skipKeys.has(k) &&
            sectionData[k] &&
            typeof sectionData[k] === 'object' &&
            !Array.isArray(sectionData[k])
        );
        // Use dynamic keys if found, otherwise fall back to hardcoded energy keys
        const marketKeys = dynamicKeys.length > 0 ? dynamicKeys : hardcodedMarketKeys;
        for (const key of marketKeys) {
          const subData = sectionData[key] || {};
          const label =
            hardcodedLabels[key] ||
            key
              .replace(/([A-Z])/g, ' $1')
              .replace(/^./, (s) => s.toUpperCase())
              .trim();
          blocks.push({
            key: key,
            _isMarket: true,
            dataType: subData.dataType || detectMarketDataType(key, subData),
            data: subData,
            title: subData.slideTitle || `${country} - ${label}`,
            subtitle: '', // keyInsight rendered in callout overlay, not subtitle
            citations: marketCitations,
            dataQuality: marketDQ,
          });
        }
        break;
      }

      case 'Competitive Landscape': {
        const compCitations = getCitationsForCategory('competitors_');
        const compDQ = getDataQualityForCategory('competitors_');

        blocks.push({
          key: 'japanesePlayers',
          dataType: 'company_comparison',
          data: sectionData.japanesePlayers || {},
          title:
            (sectionData.japanesePlayers || {}).slideTitle ||
            `${country} - Japanese ${scope.industry || 'Industry'} Companies`,
          subtitle: truncateSubtitle(
            (sectionData.japanesePlayers || {}).marketInsight ||
              (sectionData.japanesePlayers || {}).subtitle ||
              '',
            95
          ),
          citations: compCitations,
          dataQuality: compDQ,
        });

        blocks.push({
          key: 'localMajor',
          dataType: 'company_comparison',
          data: sectionData.localMajor || {},
          title: (sectionData.localMajor || {}).slideTitle || `${country} - Major Local Players`,
          subtitle: truncateSubtitle(
            (sectionData.localMajor || {}).concentration ||
              (sectionData.localMajor || {}).subtitle ||
              '',
            95
          ),
          citations: compCitations,
          dataQuality: compDQ,
        });

        blocks.push({
          key: 'foreignPlayers',
          dataType: 'company_comparison',
          data: sectionData.foreignPlayers || {},
          title:
            (sectionData.foreignPlayers || {}).slideTitle ||
            `${country} - Foreign ${scope.industry || 'Industry'} Companies`,
          subtitle: truncateSubtitle(
            (sectionData.foreignPlayers || {}).competitiveInsight ||
              (sectionData.foreignPlayers || {}).subtitle ||
              '',
            95
          ),
          citations: compCitations,
          dataQuality: compDQ,
        });

        blocks.push({
          key: 'caseStudy',
          dataType: 'case_study',
          data: sectionData.caseStudy || {},
          title: (sectionData.caseStudy || {}).slideTitle || `${country} - Market Entry Case Study`,
          subtitle: truncateSubtitle(
            (sectionData.caseStudy || {}).applicability ||
              (sectionData.caseStudy || {}).subtitle ||
              '',
            95
          ),
          citations: compCitations,
          dataQuality: compDQ,
        });

        blocks.push({
          key: 'maActivity',
          dataType: 'section_summary',
          data: sectionData.maActivity || {},
          title: (sectionData.maActivity || {}).slideTitle || `${country} - M&A Activity`,
          subtitle: truncateSubtitle(
            (sectionData.maActivity || {}).valuationMultiples ||
              (sectionData.maActivity || {}).subtitle ||
              '',
            95
          ),
          citations: compCitations,
          dataQuality: compDQ,
        });
        break;
      }

      case 'Strategic Analysis': {
        const depthCitations = getCitationsForCategory('depth_');
        const depthDQ = getDataQualityForCategory('depth_');

        blocks.push({
          key: 'escoEconomics',
          dataType: 'financial_performance',
          data: sectionData.escoEconomics || {},
          title: (sectionData.escoEconomics || {}).slideTitle || `${country} - ESCO Deal Economics`,
          subtitle: truncateSubtitle(
            (sectionData.escoEconomics || {}).keyInsight ||
              (sectionData.escoEconomics || {}).subtitle ||
              '',
            95
          ),
          citations: depthCitations,
          dataQuality: depthDQ,
        });

        blocks.push({
          key: 'partnerAssessment',
          dataType: 'company_comparison',
          data: sectionData.partnerAssessment || {},
          title:
            (sectionData.partnerAssessment || {}).slideTitle || `${country} - Partner Assessment`,
          subtitle: truncateSubtitle(
            (sectionData.partnerAssessment || {}).recommendedPartner ||
              (sectionData.partnerAssessment || {}).subtitle ||
              '',
            95
          ),
          citations: depthCitations,
          dataQuality: depthDQ,
        });

        blocks.push({
          key: 'entryStrategy',
          dataType: 'section_summary',
          data: sectionData.entryStrategy || {},
          title:
            (sectionData.entryStrategy || {}).slideTitle || `${country} - Entry Strategy Options`,
          subtitle: truncateSubtitle(
            (sectionData.entryStrategy || {}).recommendation ||
              (sectionData.entryStrategy || {}).subtitle ||
              '',
            95
          ),
          citations: depthCitations,
          dataQuality: depthDQ,
        });

        blocks.push({
          key: 'implementation',
          dataType: 'section_summary',
          data: sectionData.implementation || {},
          title:
            (sectionData.implementation || {}).slideTitle || `${country} - Implementation Roadmap`,
          subtitle: truncateSubtitle(
            `Total: ${(sectionData.implementation || {}).totalInvestment || 'TBD'} | Breakeven: ${(sectionData.implementation || {}).breakeven || 'TBD'}`,
            95
          ),
          citations: depthCitations,
          dataQuality: depthDQ,
        });

        blocks.push({
          key: 'targetSegments',
          dataType: 'section_summary',
          data: sectionData.targetSegments || {},
          title:
            (sectionData.targetSegments || {}).slideTitle ||
            `${country} - Target Customer Segments`,
          subtitle: truncateSubtitle(
            (sectionData.targetSegments || {}).goToMarketApproach ||
              (sectionData.targetSegments || {}).subtitle ||
              '',
            95
          ),
          citations: depthCitations,
          dataQuality: depthDQ,
        });
        break;
      }

      case 'Recommendations': {
        blocks.push({
          key: 'goNoGo',
          dataType: 'section_summary',
          data: sectionData.goNoGo || {},
          title: `${country} - Go/No-Go Assessment`,
          subtitle: truncateSubtitle(
            (sectionData.goNoGo || {}).overallVerdict || 'Investment Decision Framework',
            95
          ),
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'opportunitiesObstacles',
          dataType: 'opportunities_vs_barriers',
          data: {
            opportunities: sectionData.opportunities,
            obstacles: sectionData.obstacles,
            ratings: sectionData.ratings,
            recommendation: sectionData.recommendation,
          },
          title: `${country} - Opportunities & Obstacles`,
          subtitle: truncateSubtitle(sectionData.recommendation || '', 180),
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'keyInsights',
          dataType: 'section_summary',
          data: { insights: sectionData.keyInsights, recommendation: sectionData.recommendation },
          title: `${country} - Key Insights`,
          subtitle: 'Strategic implications for market entry',
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'timingIntelligence',
          dataType: 'section_summary',
          data: sectionData.timingIntelligence || {},
          title: (sectionData.timingIntelligence || {}).slideTitle || `${country} - Why Now?`,
          subtitle: truncateSubtitle(
            (sectionData.timingIntelligence || {}).windowOfOpportunity ||
              'Time-sensitive factors driving urgency',
            95
          ),
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'lessonsLearned',
          dataType: 'case_study',
          data: sectionData.lessonsLearned || {},
          title:
            (sectionData.lessonsLearned || {}).slideTitle || `${country} - Lessons from Market`,
          subtitle: truncateSubtitle(
            (sectionData.lessonsLearned || {}).subtitle || 'What previous entrants learned',
            95
          ),
          citations: [],
          dataQuality: 'unknown',
        });
        break;
      }
    }

    return blocks;
  }

  // Auto-detect market data type from sub-section data shape
  function detectMarketDataType(key, data) {
    if (data.chartData?.series && data.chartData.series.length >= 2) {
      return 'time_series_multi_insight';
    }
    if (data.chartData?.series) return 'time_series_simple';
    if (data.chartData?.values) return 'composition_breakdown';
    if (key === 'gasLng' && data.chartData?.series) return 'two_related_series';
    return 'section_summary';
  }

  // ============ PATTERN-BASED SLIDE GENERATION ============

  // Generate a slide for a market chart block with insight panels (chart left 60%, insights right 40%)
  function generateMarketChartSlide(slide, block) {
    const data = block.data;
    const chartData = data.chartData;
    const pattern = choosePattern(block.dataType, data);

    // Collect insights for the panel
    const insights = collectMarketInsights(block.key, data);

    if (
      pattern === 'chart_callout_dual' &&
      chartData?.series &&
      chartData.series.length >= 2 &&
      block.dataType !== 'composition_breakdown'
    ) {
      // Dual chart: split series into two charts
      const halfLen = Math.ceil(chartData.series.length / 2);
      const leftSeries = { ...chartData, series: chartData.series.slice(0, halfLen) };
      const rightSeries = { ...chartData, series: chartData.series.slice(halfLen) };
      addDualChart(
        slide,
        { chartData: leftSeries, title: '', type: 'bar' },
        { chartData: rightSeries, title: '', type: 'bar' },
        null,
        {
          callout: insights.length > 0 ? { title: 'Key Insight', text: insights[0] } : null,
        }
      );
      return;
    }

    // Standard chart + insight panels layout
    const hasChartSeries = chartData && chartData.series && chartData.series.length > 0;
    const hasChartValues = chartData && chartData.values && chartData.values.length > 0;

    if (hasChartSeries || hasChartValues) {
      // Chart on left 60%
      const chartOpts = { x: LEFT_MARGIN, y: CONTENT_Y, w: 7.8, h: 3.6 };
      const chartTitle = getChartTitle(block.key, data);

      if (hasChartSeries) {
        // Determine chart type
        if (
          block.key === 'gasLng' ||
          block.key === 'pricing' ||
          block.dataType === 'time_series_annotated'
        ) {
          addLineChart(slide, chartTitle, chartData, chartOpts);
        } else {
          addStackedBarChart(slide, chartTitle, chartData, chartOpts);
        }
      } else if (hasChartValues) {
        if (block.key === 'electricity') {
          addPieChart(slide, chartTitle, chartData, chartOpts);
        } else {
          addBarChart(slide, chartTitle, chartData, chartOpts);
        }
      }

      // Insight panels on right 40% using pattern library
      if (insights.length > 0) {
        const insightPanels = insights.slice(0, 3).map((text, idx) => ({
          title: idx === 0 ? 'Key Insight' : idx === 1 ? 'Market Data' : 'Opportunity',
          text: truncate(text, 200),
        }));
        addInsightPanelsFromPattern(slide, insightPanels);
      }

      // Add callout overlay on chart area for key data point
      if (data.keyInsight) {
        addCalloutOverlay(slide, truncate(data.keyInsight, 200), {
          x: LEFT_MARGIN + 0.5,
          y: 4.95,
          w: 7.0,
          h: 0.55,
        });
      }
      // Add synthesis-driven market outlook if available (fallback to countryAnalysis)
      const growthTrajectory =
        enrichment.marketOpportunityAssessment?.growthTrajectory ||
        countryAnalysis?.summary?.marketOpportunityAssessment?.growthTrajectory ||
        null;
      if (growthTrajectory) {
        addCalloutBox(
          slide,
          'Market Outlook',
          typeof growthTrajectory === 'string'
            ? growthTrajectory
            : JSON.stringify(growthTrajectory),
          { x: LEFT_MARGIN + 0.5, y: 5.55, w: 7.0, h: 0.5, type: 'insight' }
        );
      }
    } else {
      // No chart data - render text insights with sufficient content blocks (min 3)
      if (insights.length > 0) {
        addCalloutBox(slide, 'Market Overview', insights.slice(0, 4).join(' | '), {
          x: LEFT_MARGIN,
          y: CONTENT_Y,
          w: CONTENT_WIDTH,
          h: 2.0,
          type: 'insight',
        });
      } else {
        addDataUnavailableMessage(slide, `${block.key} data not available`);
      }
    }
  }

  // Collect market insights from structured data for a given market sub-section
  function collectMarketInsights(key, data) {
    const insights = [];

    switch (key) {
      case 'tpes':
        if (data.structuredData?.marketBreakdown?.totalPrimaryEnergySupply) {
          const bd = data.structuredData.marketBreakdown.totalPrimaryEnergySupply;
          if (bd.naturalGasPercent) insights.push(`Natural Gas: ${bd.naturalGasPercent}`);
          if (bd.renewablePercent) insights.push(`Renewable: ${bd.renewablePercent}`);
        }
        // keyInsight rendered in callout overlay, not duplicated here
        if (data.narrative) insights.push(truncate(data.narrative, 100));
        break;

      case 'finalDemand':
        if (data.structuredData?.marketBreakdown?.totalFinalConsumption) {
          const c = data.structuredData.marketBreakdown.totalFinalConsumption;
          if (c.industryPercent) insights.push(`Industry: ${c.industryPercent}`);
          if (c.transportPercent) insights.push(`Transport: ${c.transportPercent}`);
        }
        safeArray(data.keyDrivers, 2).forEach((d) => insights.push(truncate(d, 80)));
        break;

      case 'electricity':
        if (data.demandGrowth) insights.push(`Demand Growth: ${data.demandGrowth}`);
        if (data.totalCapacity) insights.push(`Capacity: ${data.totalCapacity}`);
        if (data.keyTrend) insights.push(truncate(data.keyTrend, 100));
        if (data.structuredData?.marketBreakdown?.electricityGeneration) {
          const gen = data.structuredData.marketBreakdown.electricityGeneration;
          if (gen.current) insights.push(`Current: ${gen.current}`);
          if (gen.projected2030) insights.push(`2030 Target: ${gen.projected2030}`);
        }
        break;

      case 'gasLng':
        if (data.structuredData?.infrastructureCapacity) {
          const infra = data.structuredData.infrastructureCapacity;
          if (infra.lngImportCurrent) insights.push(`LNG Import: ${infra.lngImportCurrent}`);
          if (infra.lngImportPlanned) insights.push(`Planned: ${infra.lngImportPlanned}`);
          if (infra.pipelineCapacity) insights.push(`Pipeline: ${infra.pipelineCapacity}`);
        }
        if (data.pipelineNetwork) insights.push(truncate(data.pipelineNetwork, 120));
        break;

      case 'pricing':
        if (data.structuredData?.priceComparison) {
          const prices = data.structuredData.priceComparison;
          if (prices.generationCost) insights.push(`Generation: ${prices.generationCost}`);
          if (prices.retailPrice) insights.push(`Retail: ${prices.retailPrice}`);
          if (prices.industrialRate) insights.push(`Industrial: ${prices.industrialRate}`);
        }
        if (data.outlook) insights.push(truncate(data.outlook, 120));
        if (data.comparison) insights.push(truncate(`Regional: ${data.comparison}`, 120));
        break;

      case 'escoMarket':
        if (data.marketSize) insights.push(`Market Size: ${data.marketSize}`);
        if (data.growthRate) insights.push(`Growth: ${data.growthRate}`);
        if (data.structuredData?.escoMarketState) {
          const state = data.structuredData.escoMarketState;
          if (state.registeredESCOs) insights.push(`Registered ESCOs: ${state.registeredESCOs}`);
          if (state.totalProjects) insights.push(`Total Projects: ${state.totalProjects}`);
        }
        if (data.keyDrivers) insights.push(truncate(data.keyDrivers, 80));
        break;
    }

    return insights;
  }

  // Get chart title based on market sub-section key
  function getChartTitle(key, data) {
    const unit = data.chartData?.unit || '';
    switch (key) {
      case 'tpes':
        return `TPES by Source (${unit || 'Mtoe'})`;
      case 'finalDemand':
        return `Demand by Sector (${unit || '%'})`;
      case 'electricity':
        return `Power Generation Mix (${unit || '%'})`;
      case 'gasLng':
        return `Gas Supply Trend (${unit || 'bcm'})`;
      case 'pricing':
        return 'Energy Price Trends';
      case 'escoMarket':
        return `Market Segments (${unit || '%'})`;
      default:
        return data.chartData?.title || 'Market Data';
    }
  }

  // Generate slides for a specific market sub-section that also has a table (e.g. gasLng terminals, escoMarket segments)
  function addMarketSubTable(slide, block) {
    const data = block.data;
    const hasChart = !!(
      (data.chartData?.series && data.chartData.series.length > 0) ||
      (data.chartData?.values && data.chartData.values.length > 0)
    );

    if (block.key === 'gasLng') {
      const terminals = safeArray(data.lngTerminals, 3);
      const termStartY = hasChart ? 5.65 : 2.5;
      if (terminals.length > 0 && termStartY < CONTENT_BOTTOM - 0.6) {
        const termRows = [tableHeader(['Terminal', 'Capacity', 'Utilization'])];
        terminals.forEach((t) => {
          termRows.push([
            { text: safeCell(t.name, 30) },
            { text: safeCell(t.capacity) },
            { text: safeCell(t.utilization) },
          ]);
        });
        const termColWidths = calculateColumnWidths(termRows, CONTENT_WIDTH);
        applyAlternateRowFill(termRows);
        slide.addTable(termRows, {
          x: LEFT_MARGIN,
          y: termStartY,
          w: CONTENT_WIDTH,
          h: Math.min(0.8, CONTENT_BOTTOM - termStartY),
          fontSize: 14,
          fontFace: FONT,
          border: { pt: 1, color: COLORS.border },
          colW: termColWidths.length > 0 ? termColWidths : [4.0, 4.25, 4.35],
          valign: 'top',
        });
      }
    }

    if (block.key === 'escoMarket') {
      const segments = safeArray(data.segments, 4);
      if (segments.length > 0) {
        const segRows = [tableHeader(['Segment', 'Size', 'Share'])];
        segments.forEach((s) => {
          segRows.push([
            { text: safeCell(s.name) },
            { text: safeCell(s.size) },
            { text: safeCell(s.share) },
          ]);
        });
        const segColWidths = calculateColumnWidths(segRows, CONTENT_WIDTH);
        const segStartY = hasChart ? 6.1 : 3.2;
        applyAlternateRowFill(segRows);
        slide.addTable(segRows, {
          x: LEFT_MARGIN,
          y: segStartY,
          w: CONTENT_WIDTH,
          h: Math.min(1.3, segRows.length * 0.35 + 0.2, CONTENT_BOTTOM - segStartY),
          fontSize: 14,
          fontFace: FONT,
          border: { pt: 1, color: COLORS.border },
          colW: segColWidths.length > 0 ? segColWidths : [5.48, 3.56, 3.56],
          valign: 'top',
        });
      }
    }
  }

  // Generate a slide for a company comparison block (Japanese/Local/Foreign players)
  function generateCompanySlide(slide, block) {
    const data = block.data;
    const players = safeArray(data.players || data.partners, 5)
      .map(ensureWebsite)
      .map(enrichDescription);

    // Build dynamic insights
    const compInsights = [];
    if (data.marketInsight) compInsights.push(truncate(data.marketInsight, 120));
    if (data.concentration) compInsights.push(truncate(data.concentration, 120));
    if (data.competitiveInsight) compInsights.push(truncate(data.competitiveInsight, 120));
    if (data.recommendedPartner) compInsights.push(`Top Pick: ${data.recommendedPartner}`);
    if (players.length > 0) {
      compInsights.push(`${players.length} players identified`);
      const topPlayer = players[0];
      if (topPlayer.marketShare)
        compInsights.push(`Leader: ${topPlayer.name} (${topPlayer.marketShare})`);
    }

    if (players.length === 0) {
      addDataUnavailableMessage(slide, `${block.key} data not available`);
      return;
    }

    const tableStartY = CONTENT_Y;

    // Determine columns based on block type
    let headerCols, rowBuilder, defaultColW;

    if (block.key === 'partnerAssessment') {
      headerCols = [
        'Company',
        'Type',
        'Revenue',
        'Partnership Fit',
        'Acquisition Fit',
        'Description',
      ];
      defaultColW = [1.8, 1.2, 1.2, 1.2, 1.2, 6.0];
      rowBuilder = (p) => [
        p.website
          ? {
              text: safeCell(p.name, 35),
              options: { hyperlink: { url: p.website }, color: COLORS.hyperlink },
            }
          : { text: safeCell(p.name, 35) },
        { text: safeCell(p.type, 30) },
        { text: safeCell(p.revenue) },
        { text: p.partnershipFit ? `${safeCell(p.partnershipFit)}/5` : '' },
        { text: p.acquisitionFit ? `${safeCell(p.acquisitionFit)}/5` : '' },
        { text: truncateWords(safeCell(p.description), 50), options: { fontSize: 14 } },
      ];
    } else if (block.key === 'foreignPlayers') {
      headerCols = ['Company', 'Origin', 'Mode', 'Description'];
      defaultColW = [1.8, 1.2, 1.2, 8.4];
      rowBuilder = (p) => {
        // Build description with revenue and entryYear prepended (skip if already in description)
        const descParts = [];
        const baseDesc =
          safeCell(p.description) ||
          `${safeCell(p.success)} ${formatProjects(p.projects)}`.trim() ||
          '';
        if (p.revenue && !baseDesc.includes(safeCell(p.revenue)))
          descParts.push(`Revenue: ${safeCell(p.revenue)}.`);
        if (p.entryYear && !baseDesc.includes(safeCell(p.entryYear)))
          descParts.push(`Entered: ${safeCell(p.entryYear)}.`);
        if (baseDesc) descParts.push(baseDesc);
        const desc = descParts.join(' ');
        return [
          p.website
            ? {
                text: safeCell(p.name),
                options: { hyperlink: { url: p.website }, color: COLORS.hyperlink },
              }
            : { text: safeCell(p.name) },
          { text: safeCell(p.origin) },
          { text: safeCell(p.mode) },
          { text: truncateWords(desc, 65), options: { fontSize: 14 } },
        ];
      };
    } else if (block.key === 'localMajor') {
      headerCols = ['Company', 'Type', 'Revenue', 'Description'];
      defaultColW = [1.8, 1.2, 1.2, 8.4];
      rowBuilder = (p) => {
        // Build description with revenue prepended if not already in a column
        const descParts = [];
        const baseDesc =
          safeCell(p.description) ||
          `${safeCell(p.strengths)} ${safeCell(p.weaknesses)}`.trim() ||
          (p.projects ? `Projects: ${formatProjects(p.projects)}` : '') ||
          '';
        if (baseDesc) descParts.push(baseDesc);
        const desc = descParts.join(' ');
        return [
          p.website
            ? {
                text: safeCell(p.name),
                options: { hyperlink: { url: p.website }, color: COLORS.hyperlink },
              }
            : { text: safeCell(p.name) },
          { text: safeCell(p.type) },
          { text: safeCell(p.revenue) },
          { text: truncateWords(desc, 65), options: { fontSize: 14 } },
        ];
      };
    } else {
      // japanesePlayers default
      headerCols = ['Company', 'Entry Year', 'Mode', 'Description'];
      defaultColW = [2.0, 1.0, 1.2, 8.4];
      rowBuilder = (p) => {
        // Build description with revenue prepended (skip if already in description)
        const descParts = [];
        const baseDesc =
          safeCell(p.description) || formatProjects(p.projects) || safeCell(p.assessment);
        if (p.revenue && (!baseDesc || !baseDesc.includes(safeCell(p.revenue))))
          descParts.push(`Revenue: ${safeCell(p.revenue)}.`);
        if (baseDesc) descParts.push(baseDesc);
        const desc = descParts.join(' ');
        return [
          p.website
            ? {
                text: safeCell(p.name),
                options: { hyperlink: { url: p.website }, color: COLORS.hyperlink },
              }
            : { text: safeCell(p.name) },
          { text: safeCell(p.entryYear) },
          { text: safeCell(p.mode) },
          { text: truncateWords(desc, 65), options: { fontSize: 14 } },
        ];
      };
    }

    const rows = [tableHeader(headerCols)];
    players.forEach((p) => rows.push(rowBuilder(p)));
    const colWidths = calculateColumnWidths(rows, CONTENT_WIDTH);
    const tableH = safeTableHeight(rows.length, { fontSize: 14, maxH: 4.5 });

    applyAlternateRowFill(rows);
    slide.addTable(rows, {
      x: LEFT_MARGIN,
      y: tableStartY,
      w: CONTENT_WIDTH,
      h: tableH,
      fontSize: 14,
      fontFace: FONT,
      border: { pt: 1, color: COLORS.border },
      colW: colWidths.length > 0 ? colWidths : defaultColW,
      valign: 'top',
      autoPage: false,
    });

    // Add insights below table
    const compInsightY = tableStartY + tableH + 0.15;
    if (compInsights.length > 0) {
      addCalloutBox(slide, 'Competitive Insights', compInsights.slice(0, 4).join(' | '), {
        x: LEFT_MARGIN,
        y: compInsightY,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
    }
    // Add synthesis-driven competitive insight if available (fallback to countryAnalysis)
    let compRecoY = compInsights.length > 0 ? compInsightY + 0.65 + 0.1 : compInsightY;
    const whiteSpaces =
      enrichment.competitivePositioning?.whiteSpaces ||
      countryAnalysis?.summary?.competitivePositioning?.whiteSpaces ||
      null;
    if (
      whiteSpaces &&
      (Array.isArray(whiteSpaces) ? whiteSpaces.length > 0 : true) &&
      compRecoY < CONTENT_BOTTOM - 0.55
    ) {
      addCalloutBox(
        slide,
        'Competitive Insight',
        Array.isArray(whiteSpaces) ? whiteSpaces.join('. ') : String(whiteSpaces),
        { x: LEFT_MARGIN, y: compRecoY, w: CONTENT_WIDTH, h: 0.5, type: 'insight' }
      );
      compRecoY += 0.5 + 0.1;
    }

    // Potential partners from Stage 3 competitivePositioning
    const potentialPartners =
      enrichment.competitivePositioning?.potentialPartners ||
      countryAnalysis?.summary?.competitivePositioning?.potentialPartners ||
      null;
    if (
      potentialPartners &&
      (Array.isArray(potentialPartners) ? potentialPartners.length > 0 : true) &&
      compRecoY < CONTENT_BOTTOM - 0.55
    ) {
      addCalloutBox(
        slide,
        'Potential Partners',
        Array.isArray(potentialPartners) ? potentialPartners.join(', ') : String(potentialPartners),
        { x: LEFT_MARGIN, y: compRecoY, w: CONTENT_WIDTH, h: 0.5, type: 'insight' }
      );
      compRecoY += 0.5 + 0.1;
    }

    // Strategic assessment panel: show top 2-3 players' strategicAssessment
    const playersWithAssessment = players.filter((p) => p.strategicAssessment).slice(0, 3);
    if (playersWithAssessment.length > 0 && compRecoY < CONTENT_BOTTOM - 0.5) {
      const assessmentParts = [];
      playersWithAssessment.forEach((p, idx) => {
        if (idx > 0) {
          assessmentParts.push({
            text: '\n',
            options: { fontSize: 11, color: COLORS.darkGray, fontFace: FONT },
          });
        }
        assessmentParts.push({
          text: ensureString(p.name) + ': ',
          options: { fontSize: 11, bold: true, color: COLORS.darkGray, fontFace: FONT },
        });
        assessmentParts.push({
          text: truncateWords(ensureString(p.strategicAssessment), 40),
          options: { fontSize: 11, color: COLORS.darkGray, fontFace: FONT },
        });
      });
      const assessH = Math.min(clampH(compRecoY, 1.2), 0.3 + playersWithAssessment.length * 0.3);
      slide.addText(assessmentParts, {
        x: LEFT_MARGIN,
        y: compRecoY,
        w: CONTENT_WIDTH,
        h: assessH,
        fill: { color: COLORS.white },
        line: { color: COLORS.gray, pt: 1 },
        margin: [4, 8, 4, 8],
        valign: 'top',
      });
    }
  }

  // Generate a pattern-based slide for a single data block
  // Wrapped in try-catch so one failed slide doesn't kill the entire deck
  function generatePatternSlide(block) {
    const slide = addSlideWithTitle(block.title, block.subtitle, {
      citations: block.citations,
      dataQuality: block.dataQuality,
    });

    try {
      // Route to appropriate renderer based on block key and pattern
      switch (block.key) {
        // ===== POLICY SECTION =====
        case 'foundationalActs':
          renderFoundationalActs(slide, block.data);
          break;
        case 'nationalPolicy':
          renderNationalPolicy(slide, block.data);
          break;
        case 'investmentRestrictions':
          renderInvestmentRestrictions(slide, block.data);
          break;
        case 'keyIncentives':
          renderKeyIncentives(slide, block.data);
          break;

        // ===== MARKET SECTION =====
        case 'tpes':
        case 'finalDemand':
        case 'electricity':
        case 'gasLng':
        case 'pricing':
        case 'escoMarket':
          generateMarketChartSlide(slide, block);
          addMarketSubTable(slide, block);
          break;

        // ===== COMPETITOR SECTION =====
        case 'japanesePlayers':
        case 'localMajor':
        case 'foreignPlayers':
        case 'partnerAssessment':
          generateCompanySlide(slide, block);
          break;
        case 'caseStudy':
          renderCaseStudy(slide, block.data);
          break;
        case 'maActivity':
          renderMAActivity(slide, block.data);
          break;

        // ===== DEPTH SECTION =====
        case 'escoEconomics':
          renderEscoEconomics(slide, block.data);
          break;
        case 'entryStrategy':
          renderEntryStrategy(slide, block.data);
          break;
        case 'implementation':
          renderImplementation(slide, block.data);
          break;
        case 'targetSegments':
          renderTargetSegments(slide, block.data);
          break;

        // ===== SUMMARY SECTION =====
        case 'goNoGo':
          renderGoNoGo(slide, block.data);
          break;
        case 'opportunitiesObstacles':
          renderOpportunitiesObstacles(slide, block.data);
          break;
        case 'keyInsights':
          renderKeyInsights(slide, block.data);
          break;
        case 'timingIntelligence':
          renderTimingIntelligence(slide, block.data);
          break;
        case 'lessonsLearned':
          renderLessonsLearned(slide, block.data);
          break;

        default:
          if (block._isMarket) {
            generateMarketChartSlide(slide, block);
            addMarketSubTable(slide, block);
          } else {
            addDataUnavailableMessage(slide, `Content for ${block.key} not available`);
          }
      }
    } catch (err) {
      console.error(`[PPT] Slide "${block.key}" failed, showing fallback: ${err.message}`);
      addDataUnavailableMessage(
        slide,
        `Data unavailable for ${block.title || block.key} — rendering error`
      );
    }

    return slide;
  }

  // ============ SECTION RENDERERS ============

  function renderFoundationalActs(slide, data) {
    const acts = safeArray(data.acts, 5);
    if (acts.length > 0) {
      const actsRows = [tableHeader(['Act Name', 'Year', 'Requirements', 'Enforcement'])];
      acts.forEach((act) => {
        // Combine penalties into requirements cell to preserve table width
        let reqText = safeCell(act.requirements, 150);
        const penaltiesText = ensureString(act.penalties);
        if (penaltiesText) {
          reqText += `\nPenalties: ${truncate(penaltiesText, 100)}`;
        }
        actsRows.push([
          { text: safeCell(act.name, 45) },
          { text: safeCell(act.year) },
          { text: reqText },
          { text: safeCell(act.enforcement, 80) },
        ]);
      });
      const actsTableH = safeTableHeight(actsRows.length, { fontSize: 14, maxH: 4.5 });
      applyAlternateRowFill(actsRows);
      slide.addTable(actsRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: actsTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: [2.96, 1.08, 4.53, 4.03],
        valign: 'top',
        autoPage: false,
      });
      // Key message summary below table if available
      let actsNextY = CONTENT_Y + actsTableH + 0.15;
      const keyMessage = ensureString(data.keyMessage);
      if (keyMessage && actsNextY < CONTENT_BOTTOM - 0.5) {
        slide.addText(truncate(keyMessage, 150), {
          x: LEFT_MARGIN,
          y: actsNextY,
          w: CONTENT_WIDTH,
          h: 0.35,
          fontSize: 11,
          italic: true,
          color: COLORS.secondary,
          fontFace: FONT,
        });
        actsNextY += 0.4;
      }
      // Synthesis-driven regulatory insight if available (fallback to countryAnalysis)
      const actsRecoY = actsNextY + 0.7 + 0.1;
      const keyRegulations =
        enrichment.regulatoryPathway?.keyRegulations ||
        countryAnalysis?.summary?.regulatoryPathway?.keyRegulations ||
        null;
      if (keyRegulations && actsRecoY < CONTENT_BOTTOM - 0.7) {
        addCalloutBox(
          slide,
          'Regulatory Insight',
          typeof keyRegulations === 'string' ? keyRegulations : JSON.stringify(keyRegulations),
          { x: LEFT_MARGIN, y: actsRecoY, w: CONTENT_WIDTH, h: 0.6, type: 'insight' }
        );
      }
    } else {
      addDataUnavailableMessage(slide, 'Legislation data not available');
      return;
    }
  }

  function renderNationalPolicy(slide, data) {
    const targets = safeArray(data.targets, 4);
    if (targets.length === 0 && safeArray(data.keyInitiatives, 4).length === 0) {
      addDataUnavailableMessage(slide, 'National policy data not available');
      return;
    }
    let policyNextY = CONTENT_Y;
    if (targets.length > 0) {
      const targetRows = [tableHeader(['Metric', 'Target', 'Deadline', 'Status'])];
      targets.forEach((t) => {
        targetRows.push([
          { text: safeCell(t.metric) },
          { text: safeCell(t.target, 80) },
          { text: safeCell(t.deadline, 60) },
          { text: safeCell(t.status, 80) },
        ]);
      });
      const policyTableH = safeTableHeight(targetRows.length, { fontSize: 14, maxH: 2.5 });
      applyAlternateRowFill(targetRows);
      slide.addTable(targetRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: policyTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: [4.13, 3.09, 2.69, 2.69],
        valign: 'top',
      });
      policyNextY = CONTENT_Y + policyTableH + 0.15;
    }
    const initiatives = safeArray(data.keyInitiatives, 4);
    if (initiatives.length > 0) {
      const initY = policyNextY;
      slide.addText('Key Initiatives', {
        x: LEFT_MARGIN,
        y: initY,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 14,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      const initBulletsH = clampH(initY + 0.35, 1.4);
      slide.addText(
        initiatives.map((i) => ({ text: truncate(i, 80), options: { bullet: true } })),
        {
          x: LEFT_MARGIN,
          y: initY + 0.35,
          w: CONTENT_WIDTH,
          h: initBulletsH,
          fontSize: 12,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
    }
    // Add synthesis-driven policy timeline if available (fallback to countryAnalysis)
    const policyTimeline =
      enrichment.regulatoryPathway?.timeline ||
      countryAnalysis?.summary?.regulatoryPathway?.timeline ||
      null;
    if (policyTimeline && policyNextY < CONTENT_BOTTOM - 0.8) {
      addCalloutBox(
        slide,
        'Policy Timeline',
        typeof policyTimeline === 'string' ? policyTimeline : JSON.stringify(policyTimeline),
        { x: LEFT_MARGIN, y: policyNextY, w: CONTENT_WIDTH, h: 0.7, type: 'insight' }
      );
      policyNextY += 0.7 + 0.15;
    }
  }

  function renderInvestmentRestrictions(slide, data) {
    const ownership = data.ownershipLimits || {};
    // Early return if all data fields are empty
    if (
      !ownership.general &&
      !ownership.promoted &&
      !data.riskLevel &&
      safeArray(data.incentives, 1).length === 0 &&
      !data.riskJustification
    ) {
      addDataUnavailableMessage(slide, 'Investment restrictions data not available');
      return;
    }
    const ownershipRows = [tableHeader(['Category', 'Limit', 'Details'])];
    if (ownership.general)
      ownershipRows.push([
        { text: 'General Sectors' },
        { text: safeCell(ownership.general) },
        { text: safeCell(ownership.exceptions, 100) },
      ]);
    if (ownership.promoted)
      ownershipRows.push([
        {
          text: safeCell(ownership.category || ownership.type || 'Promoted Investment'),
        },
        { text: safeCell(ownership.promoted) },
        {
          text: safeCell(ownership.promotedDetails || ownership.incentiveDetails || ''),
        },
      ]);
    let investNextY = CONTENT_Y;
    if (ownershipRows.length > 1) {
      const ownerTableH = safeTableHeight(ownershipRows.length, { fontSize: 14, maxH: 1.8 });
      applyAlternateRowFill(ownershipRows);
      slide.addTable(ownershipRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: ownerTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: [3.36, 2.02, 7.22],
        valign: 'top',
      });
      investNextY = CONTENT_Y + ownerTableH + 0.15;
    }
    const incentivesList = safeArray(data.incentives, 3);
    if (incentivesList.length > 0) {
      const incRows = [tableHeader(['Incentive', 'Benefit', 'Eligibility'])];
      incentivesList.forEach((inc) => {
        incRows.push([
          { text: safeCell(inc.name) },
          { text: safeCell(inc.benefit) },
          { text: safeCell(inc.eligibility, 50) },
        ]);
      });
      const incTableH = safeTableHeight(incRows.length, {
        fontSize: 14,
        maxH: Math.max(0.6, CONTENT_BOTTOM - investNextY - 1.0),
      });
      applyAlternateRowFill(incRows);
      slide.addTable(incRows, {
        x: LEFT_MARGIN,
        y: investNextY,
        w: CONTENT_WIDTH,
        h: incTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: [3.36, 3.36, 5.88],
        valign: 'top',
      });
      investNextY = investNextY + incTableH + 0.15;
    }
    if (data.riskLevel && investNextY < CONTENT_BOTTOM - 0.4) {
      const riskColor = data.riskLevel.toLowerCase().includes('high')
        ? COLORS.red
        : data.riskLevel.toLowerCase().includes('low')
          ? COLORS.green
          : COLORS.orange;
      slide.addText(`Regulatory Risk: ${safeCell(data.riskLevel).toUpperCase()}`, {
        x: LEFT_MARGIN,
        y: investNextY,
        w: CONTENT_WIDTH,
        h: 0.4,
        fontSize: 14,
        bold: true,
        color: riskColor,
        fontFace: FONT,
      });
      investNextY += 0.45;
      // Show riskJustification below the risk level label
      const riskJustification = ensureString(data.riskJustification);
      if (riskJustification && investNextY < CONTENT_BOTTOM - 0.4) {
        slide.addText(truncate(riskJustification, 150), {
          x: LEFT_MARGIN,
          y: investNextY,
          w: CONTENT_WIDTH,
          h: 0.35,
          fontSize: 11,
          color: COLORS.secondary,
          fontFace: FONT,
        });
        investNextY += 0.4;
      }
    }
    // Licensing requirements from Stage 3
    const licensingReqs =
      enrichment.regulatoryPathway?.licensingRequirements ||
      countryAnalysis?.summary?.regulatoryPathway?.licensingRequirements ||
      null;
    if (licensingReqs && investNextY < CONTENT_BOTTOM - 0.8) {
      addCalloutBox(
        slide,
        'Licensing Requirements',
        typeof licensingReqs === 'string' ? licensingReqs : JSON.stringify(licensingReqs),
        { x: LEFT_MARGIN, y: investNextY, w: CONTENT_WIDTH, h: 0.7, type: 'insight' }
      );
      investNextY += 0.7 + 0.15;
    }
    const regRisks =
      enrichment.regulatoryPathway?.risks ||
      countryAnalysis?.summary?.regulatoryPathway?.risks ||
      null;
    if (regRisks && investNextY < CONTENT_BOTTOM - 0.8) {
      addCalloutBox(
        slide,
        'Investment Risk',
        typeof regRisks === 'string' ? regRisks : JSON.stringify(regRisks),
        { x: LEFT_MARGIN, y: investNextY, w: CONTENT_WIDTH, h: 0.7, type: 'warning' }
      );
    }
  }

  function renderKeyIncentives(slide, data) {
    const incentives = safeArray(data.incentives, 5);
    if (incentives.length === 0) {
      addDataUnavailableMessage(slide, 'Key incentives data not available');
      return;
    }
    const incRows = [tableHeader(['Initiative', 'Key Content', 'Highlights', 'Implications'])];
    incentives.forEach((inc) => {
      incRows.push([
        { text: safeCell(inc.initiative || inc.name, 25) },
        { text: safeCell(inc.keyContent, 60) },
        { text: safeCell(inc.highlights, 40) },
        { text: safeCell(inc.implications, 50) },
      ]);
    });
    const incTableH = safeTableHeight(incRows.length, { fontSize: 14, maxH: 4.5 });
    applyAlternateRowFill(incRows);
    slide.addTable(incRows, {
      x: LEFT_MARGIN,
      y: CONTENT_Y,
      w: CONTENT_WIDTH,
      h: incTableH,
      fontSize: 14,
      fontFace: FONT,
      border: { pt: 1, color: COLORS.border },
      colW: [2.5, 3.5, 3.1, 3.5],
      valign: 'top',
      autoPage: false,
    });
  }

  function renderCaseStudy(slide, data) {
    if (!data.company && safeArray(data.keyLessons, 4).length === 0) {
      addDataUnavailableMessage(slide, 'Case study data not available');
      return;
    }

    // Use addCaseStudyRows pattern for rich rendering
    const caseRows = [
      { label: 'Company', content: data.company || '' },
      { label: 'Entry Year', content: data.entryYear || '' },
      { label: 'Entry Mode', content: data.entryMode || '' },
      { label: 'Investment', content: data.investment || '' },
      { label: 'Outcome', content: truncate(data.outcome || '', 200) },
    ].filter((row) => row.content);
    if (caseRows.length > 0) addCaseStudyRows(slide, caseRows);

    // Key lessons as insight panels on right side
    const lessons = safeArray(data.keyLessons, 4);
    if (lessons.length > 0) {
      const lessonPanels = lessons.map((l, idx) => ({
        title: `Lesson ${idx + 1}`,
        text: truncate(l, 150),
      }));
      addInsightPanelsFromPattern(slide, lessonPanels);
    }

    if (data.applicability) {
      addCalloutOverlay(slide, `Applicability: ${truncate(data.applicability, 200)}`, {
        x: LEFT_MARGIN,
        y: 6.0,
        w: CONTENT_WIDTH,
        h: 0.5,
      });
    }
  }

  function renderMAActivity(slide, data) {
    const deals = safeArray(data.recentDeals, 3);
    const potentialTargets = safeArray(data.potentialTargets, 3)
      .map(ensureWebsite)
      .map(enrichDescription);

    const maInsights = [];
    if (data.valuationMultiples) maInsights.push(`Multiples: ${data.valuationMultiples}`);
    if (data.structuredData?.maActivity?.dealVolume) {
      maInsights.push(`Deal Volume: ${data.structuredData.maActivity.dealVolume}`);
    }
    if (deals.length > 0) maInsights.push(`${deals.length} recent deals identified`);
    if (potentialTargets.length > 0)
      maInsights.push(`${potentialTargets.length} potential targets`);

    if (deals.length === 0 && potentialTargets.length === 0) {
      addDataUnavailableMessage(slide, 'M&A activity data not available');
      return;
    }

    let maNextY = CONTENT_Y;
    if (deals.length > 0) {
      slide.addText('Recent Transactions', {
        x: LEFT_MARGIN,
        y: maNextY,
        w: 8.5,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      maNextY += 0.35;
      const dealRows = [tableHeader(['Year', 'Buyer', 'Target', 'Value', 'Rationale'])];
      deals.forEach((d) => {
        dealRows.push([
          { text: safeCell(d.year) },
          { text: safeCell(d.buyer) },
          { text: safeCell(d.target) },
          { text: safeCell(d.value) },
          { text: safeCell(d.rationale, 30) },
        ]);
      });
      const dealColWidths = calculateColumnWidths(dealRows, CONTENT_WIDTH);
      const dealTableH = safeTableHeight(dealRows.length, { fontSize: 14, maxH: 2.0 });
      applyAlternateRowFill(dealRows);
      slide.addTable(dealRows, {
        x: LEFT_MARGIN,
        y: maNextY,
        w: CONTENT_WIDTH,
        h: dealTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: dealColWidths.length > 0 ? dealColWidths : [1.08, 2.42, 2.42, 2.02, 4.66],
        valign: 'top',
      });
      maNextY += dealTableH + 0.15;
    }

    if (potentialTargets.length > 0) {
      slide.addText('Potential Acquisition Targets', {
        x: LEFT_MARGIN,
        y: maNextY,
        w: 8.5,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      maNextY += 0.35;
      const targetRows = [tableHeader(['Company', 'Est. Value', 'Rationale', 'Timing'])];
      potentialTargets.forEach((t) => {
        const nameCell = t.website
          ? {
              text: safeCell(t.name),
              options: { hyperlink: { url: t.website }, color: COLORS.hyperlink },
            }
          : { text: safeCell(t.name) };
        targetRows.push([
          nameCell,
          { text: safeCell(t.estimatedValue) },
          { text: safeCell(t.rationale, 40) },
          { text: safeCell(t.timing) },
        ]);
      });
      const targetColWidths = calculateColumnWidths(targetRows, CONTENT_WIDTH);
      const maTargetTableH = safeTableHeight(targetRows.length, {
        fontSize: 14,
        maxH: Math.max(0.6, CONTENT_BOTTOM - maNextY - 1.0),
      });
      applyAlternateRowFill(targetRows);
      slide.addTable(targetRows, {
        x: LEFT_MARGIN,
        y: maNextY,
        w: CONTENT_WIDTH,
        h: maTargetTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: targetColWidths.length > 0 ? targetColWidths : [2.69, 2.02, 5.48, 2.41],
        valign: 'top',
      });
      maNextY += maTargetTableH + 0.15;
    }

    if (maInsights.length > 0) {
      addCalloutBox(slide, 'M&A Insights', maInsights.slice(0, 4).join(' | '), {
        x: LEFT_MARGIN,
        y: maNextY,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
    }
  }

  function renderEscoEconomics(slide, data) {
    const rawDealSize = data.typicalDealSize;
    let dealSizeText = '';
    let dealSize = {};
    if (typeof rawDealSize === 'string') {
      dealSizeText = rawDealSize;
    } else if (rawDealSize && typeof rawDealSize === 'object') {
      dealSize = rawDealSize;
      dealSizeText =
        dealSize.average ||
        (dealSize.min && dealSize.max
          ? `${dealSize.min} - ${dealSize.max}`
          : dealSize.min || dealSize.max || 'Deal size under research');
    }
    const terms = data.contractTerms || {};
    const financials = data.financials || {};

    const econInsights = [];
    if (dealSizeText) econInsights.push(`Avg Deal: ${dealSizeText}`);
    if (financials.irr) econInsights.push(`Expected IRR: ${financials.irr}`);
    if (financials.paybackPeriod) econInsights.push(`Payback: ${financials.paybackPeriod}`);
    if (terms.duration) econInsights.push(`Contract: ${terms.duration}`);
    if (data.keyInsight) econInsights.push(truncate(data.keyInsight, 80));

    const econRows = [tableHeader(['Metric', 'Value', 'Notes'])];
    if (dealSizeText)
      econRows.push([
        { text: 'Typical Deal Size' },
        { text: safeCell(dealSizeText) },
        { text: dealSize.average ? `Avg: ${safeCell(dealSize.average)}` : '' },
      ]);
    if (terms.duration)
      econRows.push([
        { text: 'Contract Duration' },
        { text: safeCell(terms.duration) },
        { text: '' },
      ]);
    if (terms.savingsSplit)
      econRows.push([
        { text: 'Savings Split' },
        { text: safeCell(terms.savingsSplit) },
        { text: safeCell(terms.guaranteeStructure) },
      ]);
    if (financials.paybackPeriod)
      econRows.push([
        { text: 'Payback Period' },
        { text: safeCell(financials.paybackPeriod) },
        { text: '' },
      ]);
    if (financials.irr)
      econRows.push([{ text: 'Expected IRR' }, { text: safeCell(financials.irr) }, { text: '' }]);
    if (financials.marginProfile)
      econRows.push([
        { text: 'Gross Margin' },
        { text: safeCell(financials.marginProfile) },
        { text: '' },
      ]);

    const financing = safeArray(data.financingOptions, 3);
    if (econRows.length === 1 && financing.length === 0) {
      addDataUnavailableMessage(slide, 'Economics data not available');
      return;
    }
    if (econRows.length > 1) {
      const econColWidths = calculateColumnWidths(econRows, CONTENT_WIDTH);
      applyAlternateRowFill(econRows);
      slide.addTable(econRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: financing.length > 0 ? 3.0 : 4.0,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: econColWidths.length > 0 ? econColWidths : [2.5, 3.0, 7.1],
        valign: 'top',
      });
      if (econInsights.length > 0) {
        const econTableH = financing.length > 0 ? 3.0 : 4.0;
        addCalloutBox(slide, 'Deal Economics', econInsights.slice(0, 4).join(' | '), {
          x: LEFT_MARGIN,
          y: CONTENT_Y + econTableH + 0.15,
          w: CONTENT_WIDTH,
          h: 0.65,
          type: 'insight',
        });
      }
    }
    if (financing.length > 0) {
      addCalloutBox(
        slide,
        'Financing Options',
        financing.map((f) => `- ${truncate(f, 120)}`).join('\n'),
        {
          x: LEFT_MARGIN,
          y:
            econInsights.length > 0 ? CONTENT_Y + 3.0 + 0.15 + 0.65 + 0.15 : CONTENT_Y + 3.0 + 0.15,
          w: CONTENT_WIDTH,
          h: 0.8,
          type: 'insight',
        }
      );
    }
  }

  function renderEntryStrategy(slide, data) {
    const options = safeArray(data.options, 3);

    const stratInsights = [];
    if (data.recommendation)
      stratInsights.push(`Recommended: ${truncate(data.recommendation, 120)}`);
    if (options.length > 0) {
      stratInsights.push(`${options.length} entry options analyzed`);
      const lowestRisk = options.find((o) => o.riskLevel?.toLowerCase().includes('low'));
      const fastest = options.find((o) => o.timeline?.includes('12') || o.timeline?.includes('6'));
      if (lowestRisk) stratInsights.push(`Low Risk: ${lowestRisk.mode}`);
      if (fastest) stratInsights.push(`Fastest: ${fastest.mode} (${fastest.timeline})`);
    }

    let entryNextY = 4.7;
    if (options.length === 0) {
      addDataUnavailableMessage(slide, 'Entry strategy analysis not available');
      return;
    } else {
      const optRows = [
        tableHeader(['Option', 'Timeline', 'Investment', 'Control', 'Risk', 'Pros', 'Cons']),
      ];
      options.forEach((opt) => {
        optRows.push([
          { text: safeCell(opt.mode) },
          { text: safeCell(opt.timeline) },
          { text: safeCell(opt.investment) },
          { text: safeCell(opt.controlLevel) },
          { text: safeCell(opt.riskLevel) },
          {
            text: safeArray(opt.pros, 3)
              .map((p) => `+ ${safeCell(p, 50)}`)
              .join('\n'),
            options: { fontSize: 14 },
          },
          {
            text: safeArray(opt.cons, 3)
              .map((c) => `- ${safeCell(c, 50)}`)
              .join('\n'),
            options: { fontSize: 14 },
          },
        ]);
      });
      const optColWidths = calculateColumnWidths(optRows, CONTENT_WIDTH);
      const optTableH = safeTableHeight(optRows.length, { fontSize: 14, maxH: 2.5 });
      applyAlternateRowFill(optRows);
      slide.addTable(optRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: optTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: optColWidths.length > 0 ? optColWidths : [1.5, 1.3, 1.5, 1.3, 1.1, 3.0, 2.9],
        valign: 'top',
      });
      entryNextY = CONTENT_Y + optTableH + 0.15;
      if (stratInsights.length > 0) {
        addCalloutBox(slide, 'Strategy Insights', stratInsights.slice(0, 4).join(' | '), {
          x: LEFT_MARGIN,
          y: entryNextY,
          w: CONTENT_WIDTH,
          h: 0.55,
          type: 'insight',
        });
        entryNextY += 0.55 + 0.15;
      }
    }

    // Harvey Balls comparison
    const harvey = data.harveyBalls || {};
    if (harvey.criteria && Array.isArray(harvey.criteria) && harvey.criteria.length > 0) {
      const harveyBaseY = entryNextY;
      slide.addText('Comparison Matrix (1-5 scale)', {
        x: LEFT_MARGIN,
        y: harveyBaseY,
        w: CONTENT_WIDTH,
        h: 0.25,
        fontSize: 14,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      const renderHarvey = (arr, idx) => {
        if (!Array.isArray(arr) || idx >= arr.length) return '';
        const val = Math.max(0, Math.min(5, parseInt(arr[idx], 10) || 0));
        return '\u25CF'.repeat(val) + '\u25CB'.repeat(5 - val);
      };
      // Derive column headers from options data or harvey ball keys
      const harveyModes =
        options.length > 0
          ? options.map((o) => o.mode || o.name || 'Option')
          : data.entryModes || ['Joint Venture', 'Acquisition', 'Greenfield'];
      const harveyKeys =
        options.length > 0
          ? options.map((o) => (o.mode || o.name || '').toLowerCase().replace(/\s+/g, ''))
          : ['jv', 'acquisition', 'greenfield'];
      // Map friendly keys to harvey data keys
      const keyMap = {
        jointventure: 'jv',
        jv: 'jv',
        acquisition: 'acquisition',
        greenfield: 'greenfield',
      };
      const harveyRows = [tableHeader(['Criteria', ...harveyModes.slice(0, 3)])];
      harvey.criteria.forEach((crit, idx) => {
        const row = [{ text: safeCell(crit) }];
        harveyKeys.slice(0, 3).forEach((key) => {
          const mappedKey = keyMap[key] || key;
          row.push({ text: renderHarvey(harvey[mappedKey], idx) });
        });
        harveyRows.push(row);
      });
      const harveyColWidths = calculateColumnWidths(harveyRows, CONTENT_WIDTH);
      applyAlternateRowFill(harveyRows);
      slide.addTable(harveyRows, {
        x: LEFT_MARGIN,
        y: harveyBaseY + 0.3,
        w: CONTENT_WIDTH,
        h: Math.min(0.3 + harvey.criteria.length * 0.25, 2.5),
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: harveyColWidths.length > 0 ? harveyColWidths : [3.36, 3.09, 3.02, 3.13],
        valign: 'middle',
      });
    }
  }

  function renderImplementation(slide, data) {
    const phases = safeArray(data.phases, 3);
    if (phases.length > 0) {
      // Phases as table with distinct colors per phase
      const phaseColors = [COLORS.accent1, COLORS.green, COLORS.orange];
      const phaseRows = [
        phases.map((phase, pi) => ({
          text: phase.name || 'Phase',
          options: {
            bold: true,
            color: COLORS.white,
            fill: { color: phaseColors[pi % phaseColors.length] },
            align: 'center',
            fontSize: 12,
          },
        })),
        phases.map((phase) => ({
          text:
            safeArray(phase.activities, 3)
              .map((a) => `- ${truncate(a, 60)}`)
              .join('\n') || '',
          options: { fontSize: 14, valign: 'top' },
        })),
        phases.map((phase) => {
          const parts = [];
          const milestones = safeArray(phase.milestones, 2);
          if (milestones.length > 0)
            parts.push(`Milestones: ${milestones.map((m) => truncate(m, 60)).join(', ')}`);
          if (phase.investment) parts.push(`Investment: ${phase.investment}`);
          return {
            text: parts.join('\n') || '',
            options: { fontSize: 14, color: COLORS.footerText, bold: false },
          };
        }),
      ];
      const phaseColW = phases.map(() => CONTENT_WIDTH / phases.length);
      const implTableH = safeTableHeight(phaseRows.length, { fontSize: 14, maxH: 4.0 });
      applyAlternateRowFill(phaseRows);
      slide.addTable(phaseRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: implTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: phaseColW,
        valign: 'top',
      });

      // Add chevron flow for phases below table
      addChevronFlow(
        slide,
        phases.map((p) => p.name || 'Phase'),
        null,
        { y: CONTENT_Y + implTableH + 0.3 }
      );

      // Next steps from Stage 3
      const nextSteps = enrichment.nextSteps || countryAnalysis?.summary?.nextSteps || null;
      const chevronBottomY = CONTENT_Y + implTableH + 0.3 + 0.7;
      if (nextSteps && chevronBottomY < CONTENT_BOTTOM - 0.7) {
        addCalloutBox(
          slide,
          'Next Steps',
          typeof nextSteps === 'string'
            ? nextSteps
            : Array.isArray(nextSteps)
              ? nextSteps.join('; ')
              : JSON.stringify(nextSteps),
          { x: LEFT_MARGIN, y: chevronBottomY, w: CONTENT_WIDTH, h: 0.6, type: 'insight' }
        );
      }
    } else {
      addDataUnavailableMessage(slide, 'Implementation roadmap data not available');
      return;
    }
  }

  function renderTargetSegments(slide, data) {
    const segmentsList = safeArray(data.segments, 3);

    const segInsights = [];
    if (data.goToMarketApproach) segInsights.push(truncate(data.goToMarketApproach, 80));
    if (segmentsList.length > 0) {
      segInsights.push(`${segmentsList.length} target segments identified`);
      const highPriority = segmentsList.find((s) => s.priority >= 4);
      if (highPriority) segInsights.push(`Top Priority: ${highPriority.name}`);
    }

    let nextSegY = CONTENT_Y;
    if (segmentsList.length === 0) {
      addDataUnavailableMessage(slide, 'Target segment data not available');
      return;
    }
    if (segmentsList.length > 0) {
      const segmentRows = [
        tableHeader(['Segment', 'Size', 'Energy Intensity', 'Decision Maker', 'Priority']),
      ];
      segmentsList.forEach((s) => {
        segmentRows.push([
          { text: safeCell(s.name, 25) },
          { text: safeCell(s.size, 20) },
          { text: safeCell(s.energyIntensity, 15) },
          { text: safeCell(s.decisionMaker, 18) },
          { text: s.priority ? `${safeCell(s.priority)}/5` : '' },
        ]);
      });
      const segColWidths = calculateColumnWidths(segmentRows, CONTENT_WIDTH);
      const segTableH = Math.min(1.8, segmentRows.length * 0.4 + 0.2);
      applyAlternateRowFill(segmentRows);
      slide.addTable(segmentRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: segTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: segColWidths.length > 0 ? segColWidths : [2.5, 2.5, 2.1, 2.5, 3.0],
        valign: 'top',
      });
      nextSegY = CONTENT_Y + segTableH + 0.15;
      if (segInsights.length > 0) {
        addCalloutBox(slide, 'Market Approach', segInsights.slice(0, 2).join(' | '), {
          x: LEFT_MARGIN,
          y: nextSegY,
          w: CONTENT_WIDTH,
          h: 0.65,
          type: 'insight',
        });
        nextSegY += 0.65 + 0.15;
      }
    }

    // Top targets
    const topTargets = safeArray(data.topTargets, 3)
      .map((t) => {
        if (t && t.company && !t.name) t.name = t.company;
        return t;
      })
      .filter(isValidCompany)
      .map(ensureWebsite)
      .map(enrichDescription);

    if (topTargets.length > 0 && nextSegY < CONTENT_BOTTOM - 1.0) {
      const priorityYBase = nextSegY;
      slide.addText('Priority Target Companies', {
        x: LEFT_MARGIN,
        y: priorityYBase,
        w: CONTENT_WIDTH,
        h: 0.25,
        fontSize: 14,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      const targetCompRows = [tableHeader(['Company', 'Industry', 'Energy Spend', 'Location'])];
      topTargets.forEach((t) => {
        const nameCell = t.website
          ? {
              text: safeCell(t.company || t.name, 25),
              options: { hyperlink: { url: t.website }, color: COLORS.hyperlink },
            }
          : { text: safeCell(t.company || t.name, 25) };
        targetCompRows.push([
          nameCell,
          { text: safeCell(t.industry, 30) },
          { text: safeCell(t.energySpend, 25) },
          { text: safeCell(t.location, 30) },
        ]);
      });
      const targetColWidths = calculateColumnWidths(targetCompRows, CONTENT_WIDTH);
      const targetTableStartY = priorityYBase + 0.45;
      const targetTableH = Math.min(1.0, Math.max(0.4, CONTENT_BOTTOM - targetTableStartY));
      applyAlternateRowFill(targetCompRows);
      slide.addTable(targetCompRows, {
        x: LEFT_MARGIN,
        y: targetTableStartY,
        w: CONTENT_WIDTH,
        h: targetTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: targetColWidths.length > 0 ? targetColWidths : [3.36, 3.09, 3.02, 3.13],
        valign: 'top',
      });
    }
  }

  function renderGoNoGo(slide, data) {
    const goNoGoCriteria = safeArray(data.criteria, 6);
    if (goNoGoCriteria.length === 0) {
      addDataUnavailableMessage(slide, 'Go/no-go criteria not available');
      return;
    }
    if (goNoGoCriteria.length > 0) {
      const goNoGoRows = [tableHeader(['Criterion', 'Status', 'Evidence'])];
      goNoGoCriteria.forEach((c) => {
        const statusIcon = c.met === true ? '\u2713' : c.met === false ? '\u2717' : '?';
        const statusColor =
          c.met === true ? COLORS.green : c.met === false ? COLORS.red : COLORS.orange;
        goNoGoRows.push([
          { text: safeCell(c.criterion, 60) },
          { text: statusIcon, options: { color: statusColor, bold: true, align: 'center' } },
          { text: safeCell(c.evidence, 80) },
        ]);
      });
      const goNoGoTableH = safeTableHeight(goNoGoRows.length, { fontSize: 14, maxH: 3.5 });
      applyAlternateRowFill(goNoGoRows);
      slide.addTable(goNoGoRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: goNoGoTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: [4.03, 1.08, 7.49],
        valign: 'top',
      });
    }
    // Verdict box
    const goNoGoTableBottom =
      goNoGoCriteria.length > 0
        ? CONTENT_Y + safeTableHeight(goNoGoCriteria.length + 1, { fontSize: 14, maxH: 3.5 }) + 0.15
        : 1.5;
    const verdictColor =
      data.overallVerdict?.includes('GO') && !data.overallVerdict?.includes('NO')
        ? COLORS.green
        : data.overallVerdict?.includes('NO')
          ? COLORS.red
          : COLORS.orange;
    if (data.overallVerdict) {
      slide.addText(`VERDICT: ${data.overallVerdict}`, {
        x: LEFT_MARGIN,
        y: goNoGoTableBottom,
        w: CONTENT_WIDTH,
        h: 0.45,
        fontSize: 16,
        bold: true,
        color: COLORS.white,
        fill: { color: verdictColor },
        fontFace: FONT,
        align: 'center',
        valign: 'middle',
      });
    }
    let goNoGoNextY = goNoGoTableBottom + 0.45 + 0.1;
    const conditions = safeArray(data.conditions, 3);
    if (conditions.length > 0) {
      slide.addText(
        [{ text: 'Conditions: ', options: { bold: true } }].concat(
          conditions.map((c, i) => ({ text: `${i > 0 ? ' | ' : ''}${truncate(c, 50)}` }))
        ),
        {
          x: LEFT_MARGIN,
          y: goNoGoNextY,
          w: CONTENT_WIDTH,
          h: 0.45,
          fontSize: 10,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
      goNoGoNextY += 0.45 + 0.1;
    }
  }

  function renderOpportunitiesObstacles(slide, data) {
    // Use matrix pattern for richer visual display
    const oppsFormatted = safeArray(data.opportunities, 5)
      .filter(Boolean)
      .map((o) =>
        typeof o === 'string'
          ? o
          : [
              o.opportunity || '',
              o.size ? `(${o.size})` : '',
              o.timing ? `Timing: ${o.timing}` : '',
              o.action ? `Action: ${o.action}` : '',
            ]
              .filter(Boolean)
              .join(' ')
      );
    const obsFormatted = safeArray(data.obstacles, 5)
      .filter(Boolean)
      .map((o) =>
        typeof o === 'string'
          ? o
          : [
              o.obstacle || '',
              o.severity ? `[${o.severity}]` : '',
              o.mitigation ? `Mitigation: ${o.mitigation}` : '',
            ]
              .filter(Boolean)
              .join(' ')
      );

    // Early return if no data at all
    const ratings = data.ratings || {};
    if (
      oppsFormatted.length === 0 &&
      obsFormatted.length === 0 &&
      !ratings.attractiveness &&
      !ratings.feasibility
    ) {
      addDataUnavailableMessage(slide, 'Opportunities and obstacles data not available');
      return;
    }

    addOpportunitiesObstaclesSummary(slide, oppsFormatted, obsFormatted, {
      x: LEFT_MARGIN,
      y: CONTENT_Y,
      fullWidth: CONTENT_WIDTH,
    });

    if (ratings.attractiveness || ratings.feasibility) {
      // Build rating text parts with rationale
      const ratingParts = [];
      const ratingTextParts = [];
      if (ratings.attractiveness)
        ratingTextParts.push(`Attractiveness: ${ratings.attractiveness}/10`);
      if (ratings.feasibility) ratingTextParts.push(`Feasibility: ${ratings.feasibility}/10`);
      ratingParts.push({
        text: ratingTextParts.join(' | '),
        options: { fontSize: 12, bold: true, color: COLORS.dk2, fontFace: FONT },
      });
      const rationale = [];
      if (ratings.attractivenessRationale)
        rationale.push(`Attractiveness: ${ensureString(ratings.attractivenessRationale)}`);
      if (ratings.feasibilityRationale)
        rationale.push(`Feasibility: ${ensureString(ratings.feasibilityRationale)}`);
      if (rationale.length > 0) {
        ratingParts.push({
          text: '\n' + truncateWords(rationale.join(' | '), 40),
          options: { fontSize: 11, color: COLORS.secondary, fontFace: FONT },
        });
      }
      const ratingH = rationale.length > 0 ? 0.5 : 0.25;
      slide.addText(ratingParts, {
        x: LEFT_MARGIN,
        y: CONTENT_BOTTOM - (rationale.length > 0 ? 1.3 : 1.1),
        w: CONTENT_WIDTH,
        h: ratingH,
        valign: 'top',
      });
    }
    // Show recommendation only if real data exists
    if (data.recommendation) {
      addCalloutBox(slide, 'Strategic Recommendation', truncate(data.recommendation, 200), {
        x: LEFT_MARGIN,
        y: CONTENT_BOTTOM - 0.75,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'recommendation',
      });
    }
  }

  // Dynamic text sizing: reduce font size before truncating
  function dynamicText(text, maxChars, baseFontPt, floorPt) {
    const minPt = floorPt || 10;
    if (!text) return { text: '', fontSize: baseFontPt };
    if (text.length <= maxChars) return { text, fontSize: baseFontPt };
    for (let fs = baseFontPt - 1; fs >= minPt; fs--) {
      const scaledMax = Math.floor(maxChars * (baseFontPt / fs));
      if (text.length <= scaledMax) return { text, fontSize: fs };
    }
    const finalMax = Math.floor(maxChars * (baseFontPt / minPt));
    return { text: text.substring(0, finalMax - 3) + '...', fontSize: minPt };
  }

  function renderKeyInsights(slide, data) {
    const insights = safeArray(data.insights, 3);
    let insightY = CONTENT_Y;
    // Prefer synthesis keyInsights over countryAnalysis insights (fallback chain)
    const synthesisInsights =
      enrichment.keyInsights || countryAnalysis?.summary?.keyInsights || null;
    const insightSource =
      synthesisInsights && synthesisInsights.length > 0 ? synthesisInsights : data.insights || [];
    const resolvedInsights = safeArray(insightSource, 3);
    if (resolvedInsights.length === 0 && insights.length === 0) {
      addDataUnavailableMessage(slide, 'Key insights data not available');
      return;
    }
    // Use resolvedInsights if we got synthesis data, otherwise use the original insights
    const finalInsights = resolvedInsights.length > 0 ? resolvedInsights : insights;
    finalInsights.forEach((insight, idx) => {
      const rawTitle =
        typeof insight === 'string'
          ? `Insight ${idx + 1}`
          : ensureString(insight.title) || `Insight ${idx + 1}`;
      let rawContent = '';
      if (typeof insight === 'string') {
        rawContent = insight;
      } else {
        const parts = [];
        if (insight.data) parts.push(ensureString(insight.data));
        if (insight.pattern) parts.push(`So what: ${ensureString(insight.pattern)}`);
        if (insight.implication) parts.push(`Action: ${ensureString(insight.implication)}`);
        if (insight.timing) parts.push(`Timing: ${ensureString(insight.timing)}`);
        rawContent = parts.join('\n');
      }

      const titleSized = dynamicText(rawTitle, 70, 14);
      slide.addText(titleSized.text, {
        x: LEFT_MARGIN,
        y: insightY,
        w: CONTENT_WIDTH,
        h: 0.35,
        fontSize: titleSized.fontSize,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      const contentSized = dynamicText(truncate(rawContent, 200), 200, 11, 7);
      slide.addText(contentSized.text, {
        x: LEFT_MARGIN,
        y: insightY + 0.35,
        w: CONTENT_WIDTH,
        h: 0.9,
        fontSize: contentSized.fontSize,
        fontFace: FONT,
        color: COLORS.black,
        valign: 'top',
      });
      insightY += 1.4; // step = 0.35 + 0.9 + 0.15
    });

    // Show recommendation only if real data exists
    if (data.recommendation) {
      const recoY = Math.max(insightY + 0.1, 5.65);
      addCalloutBox(slide, 'RECOMMENDATION', truncate(data.recommendation, 150), {
        y: Math.min(recoY, 5.85),
        h: 0.8,
        type: 'recommendation',
      });
    }
  }

  function renderTimingIntelligence(slide, data) {
    const triggers = safeArray(data.triggers, 4);

    if (triggers.length > 0) {
      const triggerRows = [tableHeader(['Trigger', 'Impact', 'Action Required'])];
      triggers.forEach((t) => {
        triggerRows.push([
          { text: safeCell(t.trigger, 60) },
          { text: safeCell(t.impact, 50) },
          { text: safeCell(t.action, 50) },
        ]);
      });
      const triggerColWidths = calculateColumnWidths(triggerRows, CONTENT_WIDTH);
      applyAlternateRowFill(triggerRows);
      slide.addTable(triggerRows, {
        x: LEFT_MARGIN,
        y: CONTENT_Y,
        w: CONTENT_WIDTH,
        h: Math.min(0.3 + triggerRows.length * 0.35, 3.5),
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: triggerColWidths.length > 0 ? triggerColWidths : [4.0, 4.25, 4.35],
        valign: 'top',
      });
    } else {
      addDataUnavailableMessage(slide, 'Timing data not available');
      return;
    }
    const triggerTableH =
      triggers.length > 0 ? Math.min(0.3 + (triggers.length + 1) * 0.35, 3.5) : 0;
    const windowY =
      (triggers.length > 0 ? Math.min(CONTENT_Y + triggerTableH + 0.15, 4.5) : 3.8) + 0.85;
    if (data.windowOfOpportunity) {
      addCalloutBox(slide, 'WINDOW OF OPPORTUNITY', data.windowOfOpportunity, {
        x: LEFT_MARGIN,
        y: windowY,
        w: CONTENT_WIDTH,
        h: 0.9,
        type: 'recommendation',
      });
    } else {
      const timingConsiderations =
        enrichment.marketOpportunityAssessment?.timingConsiderations ||
        countryAnalysis?.summary?.marketOpportunityAssessment?.timingConsiderations ||
        null;
      if (timingConsiderations) {
        addCalloutBox(
          slide,
          'Timing Window',
          typeof timingConsiderations === 'string'
            ? timingConsiderations
            : JSON.stringify(timingConsiderations),
          { x: LEFT_MARGIN, y: windowY, w: CONTENT_WIDTH, h: 0.9, type: 'insight' }
        );
      }
    }
  }

  function renderLessonsLearned(slide, data) {
    let lessonsNextY = CONTENT_Y;
    const failures = safeArray(data.failures, 3);
    if (failures.length > 0) {
      slide.addText('FAILURES TO AVOID', {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: 4.5,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.red,
        fontFace: FONT,
      });
      lessonsNextY += 0.35;
      const failureRows = [tableHeader(['Company', 'Reason', 'Lesson'])];
      failures.forEach((f) => {
        failureRows.push([
          { text: `${safeCell(f.company)} (${safeCell(f.year)})` },
          { text: safeCell(f.reason, 60) },
          { text: safeCell(f.lesson, 60) },
        ]);
      });
      const failTableH = safeTableHeight(failureRows.length, { fontSize: 14, maxH: 2.0 });
      applyAlternateRowFill(failureRows);
      slide.addTable(failureRows, {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: CONTENT_WIDTH,
        h: failTableH,
        fontSize: 14,
        fontFace: FONT,
        border: { pt: 1, color: COLORS.border },
        colW: [2.96, 4.7, 4.94],
        valign: 'top',
      });
      lessonsNextY += failTableH + 0.15;
    }
    const successFactors = safeArray(data.successFactors, 3);
    if (successFactors.length > 0 && lessonsNextY < CONTENT_BOTTOM - 0.2) {
      slide.addText('SUCCESS FACTORS', {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.green,
        fontFace: FONT,
      });
      const sfH = Math.min(1.0, successFactors.length * 0.3 + 0.1);
      if (lessonsNextY + 0.35 + sfH <= CONTENT_BOTTOM - 0.2) {
        slide.addText(
          successFactors.map((s) => ({ text: truncate(s, 100), options: { bullet: true } })),
          {
            x: LEFT_MARGIN,
            y: lessonsNextY + 0.35,
            w: CONTENT_WIDTH,
            h: sfH,
            fontSize: 10,
            fontFace: FONT,
            color: COLORS.black,
            valign: 'top',
          }
        );
        lessonsNextY += 0.35 + sfH + 0.15;
      }
    }
    const warningSigns = safeArray(data.warningSignsToWatch, 3);
    if (failures.length === 0 && successFactors.length === 0 && warningSigns.length === 0) {
      addDataUnavailableMessage(slide, 'Lessons learned data not available');
      return;
    }
    if (warningSigns.length > 0 && lessonsNextY < CONTENT_BOTTOM - 0.2) {
      slide.addText('WARNING SIGNS', {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.orange,
        fontFace: FONT,
      });
      lessonsNextY += 0.35;
      const warningBulletsH = Math.min(1.5, Math.max(0.4, CONTENT_BOTTOM - lessonsNextY));
      if (lessonsNextY + warningBulletsH <= CONTENT_BOTTOM) {
        slide.addText(
          warningSigns.map((w) => ({ text: truncate(w, 100), options: { bullet: true } })),
          {
            x: LEFT_MARGIN,
            y: lessonsNextY,
            w: CONTENT_WIDTH,
            h: warningBulletsH,
            fontSize: 10,
            fontFace: FONT,
            color: COLORS.black,
            valign: 'top',
          }
        );
      }
    }
  }

  // ============ SECTION GENERATION ============
  // Generate an entire section: TOC divider + content slides
  // Check if a section has any real content (not just empty objects or "Data unavailable" placeholders)
  function sectionHasContent(blocks) {
    return blocks.some(
      (b) =>
        b.data &&
        Object.keys(b.data).length > 0 &&
        !JSON.stringify(b.data).includes('Data unavailable')
    );
  }

  // Section names for TOC slides
  const SECTION_NAMES = [
    'Market Overview',
    'Policy & Regulatory',
    'Competitive Landscape',
    'Strategic Analysis',
    'Recommendations',
    'Appendix',
  ];

  // 2C: Extract usable content from rawData when synthesis failed
  function extractRawDataFallback(sectionName) {
    if (!countryAnalysis.rawData) return null;
    const prefixMap = {
      'Market Overview': 'market_',
      'Policy & Regulatory': 'policy_',
      'Competitive Landscape': 'competitors_',
      'Strategic Analysis': 'depth_',
      Recommendations: 'insight_',
    };
    const prefix = prefixMap[sectionName];
    if (!prefix) return null;
    const parts = [];
    for (const [key, data] of Object.entries(countryAnalysis.rawData)) {
      if (key.startsWith(prefix) && data?.content) {
        const snippet =
          typeof data.content === 'string'
            ? data.content.substring(0, 300)
            : JSON.stringify(data.content).substring(0, 300);
        parts.push(`${key}: ${snippet}`);
      }
    }
    if (parts.length === 0) return null;
    return parts.slice(0, 5).join('\n\n');
  }

  function generateSection(sectionName, sectionNumber, totalSections, sectionData) {
    // Use TOC slide instead of old section divider — highlight active section
    addTocSlide(pptx, sectionNumber - 1, SECTION_NAMES, COLORS, FONT);

    // Detect _synthesisError sentinel — synthesis completely failed for this section
    if (sectionData && sectionData._synthesisError) {
      console.warn(
        `[PPT] Section "${sectionName}" has _synthesisError: ${sectionData.message || 'unknown'}`
      );
      const slide = addSlideWithTitle(`${sectionName}`, 'Synthesis Error');
      slide.addText(
        [
          {
            text: `Synthesis failed for ${sectionName}\n`,
            options: { fontSize: 14, bold: true, color: COLORS.red, fontFace: FONT },
          },
          {
            text: `${sectionData.message || 'All AI synthesis attempts failed.'}  Data may still be available in rawData.`,
            options: { fontSize: 11, color: COLORS.black, fontFace: FONT },
          },
        ],
        {
          x: LEFT_MARGIN,
          y: 2.0,
          w: CONTENT_WIDTH,
          h: 2.0,
          fill: { color: COLORS.warningFill },
          line: { color: COLORS.red, pt: 1 },
          margin: [8, 12, 8, 12],
          valign: 'top',
        }
      );
      return 1;
    }

    // Map display name to internal classifyDataBlocks name
    const classifyName =
      sectionName === 'Policy & Regulatory' ? 'Policy & Regulations' : sectionName;
    const blocks = classifyDataBlocks(classifyName, sectionData);
    const pptGate = validatePptData(blocks);
    console.log('[Quality Gate] PPT data:', JSON.stringify(pptGate));
    if (
      pptGate.pass === false &&
      pptGate.emptyBlocks &&
      pptGate.emptyBlocks.length > blocks.length * 0.5
    ) {
      throw new Error(
        `PPT data gate failed for "${sectionName}": ${pptGate.emptyBlocks.length}/${blocks.length} blocks empty. ${pptGate.reason || ''}`
      );
    }

    if (!sectionHasContent(blocks)) {
      // 2C: rawData fallback — try to extract something useful from rawData
      const rawFallbackContent = extractRawDataFallback(sectionName);
      if (rawFallbackContent) {
        const slide = addSlideWithTitle(`${sectionName}`, 'Data from Raw Research (Unprocessed)');
        slide.addText(truncate(rawFallbackContent, 1200), {
          x: LEFT_MARGIN,
          y: CONTENT_Y,
          w: CONTENT_WIDTH,
          h: 5.0,
          fontSize: 11,
          color: COLORS.black,
          fontFace: FONT,
          valign: 'top',
        });
        return 1;
      }
      // Section has no real content - render one summary slide instead of hollow slides
      const slide = addSlideWithTitle(`${sectionName}`, 'Limited Data Available');
      slide.addText('Detailed analysis for this section requires additional research data.', {
        x: LEFT_MARGIN,
        y: 2.5,
        w: CONTENT_WIDTH,
        h: 1.5,
        fontSize: 16,
        color: COLORS.secondary,
        fontFace: FONT,
        valign: 'top',
      });
      return 1;
    }

    // Track unavailable slides per section (Bug 25: limit to 1 per section)
    let unavailableCount = 0;
    for (const block of blocks) {
      const blockDataStr = JSON.stringify(block.data || {});
      const isLikelyEmpty =
        !block.data ||
        Object.keys(block.data).length === 0 ||
        blockDataStr.includes('Data unavailable') ||
        blockDataStr.includes('Insufficient research data') ||
        blockDataStr.includes('No data available') ||
        blockDataStr.includes('Not available') ||
        blockDataStr.includes('data could not be verified');
      if (isLikelyEmpty) {
        unavailableCount++;
        if (unavailableCount > 1) continue; // Skip extra unavailable slides
      }
      generatePatternSlide(block);
    }
    return blocks.length;
  }

  // ============ MAIN FLOW ============

  // Section definitions — reordered: Market first, Policy second, renamed "Policy & Regulatory"
  const sectionDefs = [
    { name: 'Market Overview', data: market },
    { name: 'Policy & Regulatory', data: policy },
    { name: 'Competitive Landscape', data: competitors },
    { name: 'Strategic Analysis', data: depth },
    { name: 'Recommendations', data: null }, // uses summary
  ];

  // classifyDataBlocks still uses "Policy & Regulations" internally — map the name
  function classifyBlocksForSection(sec) {
    const classifyName = sec.name === 'Policy & Regulatory' ? 'Policy & Regulations' : sec.name;
    return classifyDataBlocks(classifyName, sec.name === 'Recommendations' ? summary : sec.data);
  }

  // Pre-calculate block counts and content status
  const sectionBlockInfo = sectionDefs.map((sec) => {
    const blocks = classifyBlocksForSection(sec);
    const hasContent = sectionHasContent(blocks);
    return { count: blocks.length, hasContent };
  });
  const sectionBlockCounts = sectionBlockInfo.map((info) => info.count);

  // ===== SLIDE 1: COVER (uses NO_BAR master) =====
  const titleSlide = pptx.addSlide({ masterName: 'NO_BAR' });
  titleSlide.addText((country || 'UNKNOWN').toUpperCase(), {
    x: 0.5,
    y: 2.2,
    w: 9.0,
    h: 0.8,
    fontSize: 42,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  titleSlide.addText(`${scope.industry} - Market Overview & Analysis`, {
    x: 0.5,
    y: 3.0,
    w: 9.0,
    h: 0.5,
    fontSize: 24,
    color: COLORS.accent1,
    fontFace: FONT,
  });
  titleSlide.addText('Executive Summary - Deep Research Report', {
    x: 0.5,
    y: 3.6,
    w: 12,
    h: 0.5,
    fontSize: 16,
    italic: true,
    color: COLORS.black,
    fontFace: FONT,
  });
  titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
    x: 0.5,
    y: 6.5,
    w: 9,
    h: 0.3,
    fontSize: 10,
    color: COLORS.secondary,
    fontFace: FONT,
  });

  // ===== SLIDE 2: TABLE OF CONTENTS (no section highlighted) =====
  addTocSlide(pptx, -1, SECTION_NAMES, COLORS, FONT);

  // ===== SLIDE 3: EXECUTIVE SUMMARY =====
  const execSlide = pptx.addSlide({ masterName: 'YCP_MAIN' });
  execSlide.addText('Executive Summary', {
    x: TITLE_X,
    y: tpTitle.y,
    w: TITLE_W,
    h: tpTitle.h,
    fontSize: tpTitleFontSize,
    fontFace: FONT,
    color: COLORS.dk2,
    bold: tpTitleBold,
  });
  const execContentRaw =
    synthesis.executiveSummary ||
    synthesis.summary?.executiveSummary ||
    summary.recommendation ||
    `This report provides a comprehensive analysis of the ${scope.industry || 'target'} market in ${country || 'the selected country'}. Detailed findings are presented in the following sections.`;
  // Fix 0: executiveSummary can be an array of strings — join them
  let execText = Array.isArray(execContentRaw)
    ? execContentRaw.join('\n\n')
    : String(execContentRaw || '');
  // Fix 9: overflow protection — count words, reduce font or truncate
  const execWordCount = execText.split(/\s+/).filter(Boolean).length;
  let execFontSize = 14;
  if (execWordCount > 500) {
    execText = execText.split(/\s+/).slice(0, 500).join(' ');
    execFontSize = 12;
  } else if (execWordCount > 280) {
    execFontSize = 12;
  }
  execSlide.addText(execText, {
    x: LEFT_MARGIN,
    y: tpContent.y,
    w: CONTENT_WIDTH,
    h: tpContent.h,
    fontSize: execFontSize,
    fontFace: FONT,
    color: COLORS.black,
    lineSpacingMultiple: 1.3,
    valign: 'top',
  });

  // ===== SLIDE 4: OPPORTUNITIES & BARRIERS =====
  // Removed duplicate: depth section renderOpportunitiesObstacles handles this

  // ===== GENERATE ALL SECTIONS =====
  // Section 1: Market Overview (index 0)
  generateSection('Market Overview', 1, 6, market);
  // Section 2: Policy & Regulatory (index 1) — classifyDataBlocks maps to "Policy & Regulations"
  generateSection('Policy & Regulatory', 2, 6, policy);
  // Regulatory transition summary slide (if data available)
  if (
    policy?.regulatorySummary &&
    Array.isArray(policy.regulatorySummary) &&
    policy.regulatorySummary.length > 0
  ) {
    const regSummarySlide = addSlideWithTitle(`${country} - Regulatory Transition Summary`, '', {
      citations: getCitationsForCategory('policy_'),
      dataQuality: getDataQualityForCategory('policy_'),
    });
    addHorizontalFlowTable(regSummarySlide, policy.regulatorySummary, { font: FONT });
  }
  // Section 3: Competitive Landscape (index 2)
  generateSection('Competitive Landscape', 3, 6, competitors);
  // Section 4: Strategic Analysis (index 3)
  generateSection('Strategic Analysis', 4, 6, depth);
  // Section 5: Recommendations (index 4) — uses summary data
  generateSection('Recommendations', 5, 6, summary);

  // ===== APPENDIX: FINAL SUMMARY SLIDE (Section 6) =====
  addTocSlide(pptx, 5, SECTION_NAMES, COLORS, FONT); // Highlight "Appendix"
  const finalSlide = addSlideWithTitle(
    `${country} - Research Summary`,
    `Analysis completed ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
  );
  const metricsRows = [tableHeader(['Metric', 'Value', 'Confidence'])];
  const escoMarketSize = market.escoMarket?.marketSize;
  if (escoMarketSize) {
    metricsRows.push([
      { text: 'Market Size' },
      { text: safeCell(escoMarketSize, 40) },
      {
        text: `${safeCell(enrichment.confidenceScore || countryAnalysis?.summary?.confidenceScore) || '--'}/100`,
      },
    ]);
  }
  if (depth.escoEconomics?.typicalDealSize?.average) {
    metricsRows.push([
      { text: 'Typical Deal Size' },
      { text: safeCell(depth.escoEconomics.typicalDealSize.average) },
      { text: '' },
    ]);
  }
  const moa = enrichment.marketOpportunityAssessment || {};
  if (moa.totalAddressableMarket) {
    metricsRows.push([
      { text: 'Total Addressable Market (TAM)' },
      { text: safeCell(moa.totalAddressableMarket, 40) },
      { text: '' },
    ]);
  }
  if (moa.serviceableMarket) {
    metricsRows.push([
      { text: 'Serviceable Market (SAM)' },
      { text: safeCell(moa.serviceableMarket, 40) },
      { text: '' },
    ]);
  }
  const finalRatings = summary.ratings || {};
  if (finalRatings.attractiveness) {
    metricsRows.push([
      { text: 'Attractiveness' },
      { text: `${safeCell(finalRatings.attractiveness)}/10` },
      {
        text: finalRatings.attractivenessRationale
          ? safeCell(finalRatings.attractivenessRationale, 80)
          : '',
      },
    ]);
  }
  if (finalRatings.feasibility) {
    metricsRows.push([
      { text: 'Feasibility' },
      { text: `${safeCell(finalRatings.feasibility)}/10` },
      {
        text: finalRatings.feasibilityRationale
          ? safeCell(finalRatings.feasibilityRationale, 80)
          : '',
      },
    ]);
  }
  if (metricsRows.length > 1) {
    const metricsTableH = Math.min(2.5, metricsRows.length * 0.35 + 0.2);
    applyAlternateRowFill(metricsRows);
    finalSlide.addTable(metricsRows, {
      x: LEFT_MARGIN,
      y: CONTENT_Y,
      w: CONTENT_WIDTH,
      h: metricsTableH,
      fontSize: 14,
      fontFace: FONT,
      border: { pt: 1, color: COLORS.border },
      colW: [3.36, 4.7, 4.54],
      valign: 'top',
    });
  }
  const finalGoNoGo = summary.goNoGo || {};
  if (finalGoNoGo.overallVerdict) {
    const finalVerdictType =
      finalGoNoGo.overallVerdict.includes('GO') && !finalGoNoGo.overallVerdict.includes('NO')
        ? 'positive'
        : finalGoNoGo.overallVerdict.includes('NO')
          ? 'negative'
          : 'warning';
    addCalloutBox(
      finalSlide,
      `VERDICT: ${finalGoNoGo.overallVerdict}`,
      (finalGoNoGo.conditions || []).slice(0, 2).join('; ') || '--',
      { y: 4.0, h: 0.9, type: finalVerdictType }
    );
  }
  addSourceFootnote(
    finalSlide,
    [
      'Government statistical agencies',
      'Industry associations',
      'Company filings and annual reports',
    ],
    COLORS,
    FONT
  );

  // Phase 2e: Enforce empty slide ratio — reject garbage decks
  const allSlides = pptx.slides || [];
  const contentSlides = allSlides.slice(3); // Skip cover, TOC, exec summary
  if (contentSlides.length > 0) {
    let emptySlideCount = 0;
    for (const sl of contentSlides) {
      const slideText = JSON.stringify(sl.data || sl);
      if (
        slideText.includes('Data unavailable') ||
        slideText.includes('Insufficient research data')
      ) {
        emptySlideCount++;
      }
    }
    const emptyRatio = emptySlideCount / contentSlides.length;
    if (emptyRatio > 0.4) {
      throw new Error(
        `PPT empty slide ratio too high: ${(emptyRatio * 100).toFixed(0)}% (${emptySlideCount}/${contentSlides.length}) content slides are empty. Research data insufficient for quality output.`
      );
    }
  }

  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  const totalSlides = 4 + sectionDefs.length + sectionBlockCounts.reduce((a, b) => a + b, 0) + 2; // cover + TOC + exec + opps + sections + appendix TOC + summary
  console.log(
    `Section-based PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB, ~${totalSlides} slides`
  );
  return pptxBuffer;
}

module.exports = { generateSingleCountryPPT };
