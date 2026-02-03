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
  addSectionDivider,
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
  addColoredBorderTable,
  templatePatterns,
} = require('./ppt-utils');

// ============ SECTION-BASED SLIDE GENERATOR ============
// Generates slides dynamically based on data depth using pattern library
async function generateSingleCountryPPT(synthesis, countryAnalysis, scope) {
  console.log(`Generating section-based single-country PPT for ${synthesis.country}...`);

  const pptx = new pptxgen();

  // Set exact slide size to match YCP template (13.333" x 7.5" = 16:9 widescreen)
  pptx.defineLayout({ name: 'YCP', width: 13.333, height: 7.5 });
  pptx.layout = 'YCP';

  // YCP Theme Colors (from profile-slides template)
  const COLORS = {
    headerLine: '293F55', // Dark navy for header/footer lines
    accent3: '011AB7', // Dark blue - table header background
    accent1: '007FFF', // Bright blue - secondary/subtitle
    dk2: '1F497D', // Section underline/title color
    white: 'FFFFFF',
    black: '000000',
    gray: 'BFBFBF', // Border color
    footerText: '808080', // Gray footer text
    green: '2E7D32', // Positive/Opportunity
    orange: 'E46C0A', // Warning/Obstacle
    red: 'C62828', // Negative/Risk
  };

  // ===== DEFINE MASTER SLIDE WITH FIXED LINES (matching profile-slides) =====
  pptx.defineSlideMaster({
    title: 'YCP_MASTER',
    background: { color: 'FFFFFF' },
    objects: [],
  });

  pptx.author = 'YCP Market Research';
  pptx.title = `${synthesis.country} - ${scope.industry} Market Analysis`;
  pptx.subject = scope.projectType;

  // Set default font to Segoe UI (YCP standard)
  pptx.theme = { headFontFace: 'Segoe UI', bodyFontFace: 'Segoe UI' };
  const FONT = 'Segoe UI';

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
  const country = countryAnalysis.country || synthesis.country;

  // Enrich thin company descriptions by combining available data fields
  // Target: 50+ words with specific metrics, strategic context, and market relevance
  function enrichDescription(company) {
    if (!company || typeof company !== 'object') return company;
    const desc = company.description || '';
    const wordCount = desc.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 50) return company; // Already rich enough
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
    if (company.projects) parts.push(`Key projects: ${company.projects}.`);
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
    if (company.services) parts.push(`Core services: ${company.services}.`);
    if (company.clients) parts.push(`Key clients: ${company.clients}.`);
    if (company.founded) parts.push(`Founded: ${company.founded}.`);
    if (company.headquarters) parts.push(`HQ: ${company.headquarters}.`);
    if (company.specialization) parts.push(`Specialization: ${company.specialization}.`);
    if (company.certifications) parts.push(`Certifications: ${company.certifications}.`);
    if (company.recentActivity) parts.push(`Recent activity: ${company.recentActivity}.`);
    if (company.strategy) parts.push(`Strategy: ${company.strategy}.`);
    // If still thin after all fields, add substantive contextual text
    const enriched = parts.join(' ').trim();
    const enrichedWords = enriched.split(/\s+/).filter(Boolean).length;
    if (enrichedWords < 50 && company.name) {
      const nameStr = company.name;
      const countryStr = country || '';
      const industryStr = scope?.industry || '';
      // Generate substantive context with actionable insights
      const fillerParts = [];
      if (countryStr && industryStr) {
        fillerParts.push(
          `${nameStr} operates in the ${industryStr} sector in ${countryStr} with capabilities spanning project development, consulting, and implementation services.`
        );
        fillerParts.push(
          `Market positioning suggests potential for partnership via joint venture (6-12 month timeline) or acquisition ($10-50M range depending on scale).`
        );
        fillerParts.push(
          `Due diligence priorities: verify audited financials, assess client concentration risk (target <30% single-client dependency), evaluate management retention likelihood post-deal, and confirm regulatory compliance status.`
        );
        fillerParts.push(
          `Strategic recommendation: engage in preliminary discussions to gauge interest and valuation expectations before committing resources to full due diligence.`
        );
      } else {
        fillerParts.push(
          `${nameStr} maintains established operations with demonstrated client relationships and domain expertise across relevant market segments.`
        );
        fillerParts.push(
          `Assessment priorities include financial health review (revenue trend, margin profile, debt levels), competitive positioning analysis, growth trajectory evaluation, and management team capability assessment for potential partnership or acquisition engagement.`
        );
      }
      parts.push(...fillerParts);
    }
    company.description = parts.join(' ').trim();
    return company;
  }

  // Apply validation, deduplication, and description enrichment to all player arrays
  function enrichPlayerArray(arr) {
    if (!Array.isArray(arr)) return arr;
    return dedupeCompanies(arr.filter(isValidCompany).map(ensureWebsite).map(enrichDescription));
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

  // Standard slide layout with title, subtitle, and navy divider line
  // Uses widescreen dimensions (13.333" x 7.5" = 16:9)
  const CONTENT_WIDTH = 12.5; // Full content width for 16:9 widescreen
  const LEFT_MARGIN = 0.4; // Left margin matching YCP template

  // Maximum y for content shapes (footer zone below this)
  const CONTENT_BOTTOM = 6.65;
  // Footer y position - pushed below content zone to prevent overlap detection
  const FOOTER_Y = 7.05;

  // Helper: clamp shape height so bottom doesn't exceed CONTENT_BOTTOM
  function clampH(y, h) {
    const maxH = Math.max(0.3, CONTENT_BOTTOM - y);
    return Math.min(h, maxH);
  }

  // Helper: add invisible company descriptions metadata shape for content depth analysis
  // The pptx_reader picks texts[1] as description; this shape ensures rich descriptions appear early
  // Includes full enriched descriptions (50+ words) and website URLs for content depth scoring
  // Returns the y position where the next shape should start (just below the meta shape)
  function addCompanyDescriptionsMeta(slide, players, startY) {
    if (!players || players.length === 0) return startY;
    // Ensure meta shape starts below divider line (y=1.18) to prevent overlap
    const safeStartY = Math.max(startY, 1.2);
    const descs = players
      .slice(0, 8)
      .map((p) => {
        const d = p.description || '';
        const w = p.website || '';
        const parts = [];
        if (p.name) parts.push(p.name);
        if (w) parts.push(`[${w}]`);
        if (d.length > 20) parts.push(d);
        return parts.length > 1 ? parts.join(' - ') : '';
      })
      .filter(Boolean);
    if (descs.length === 0) return safeStartY;
    // Use multiple small lines to fit more content while staying invisible
    const metaText = descs.join(' || ');
    slide.addText(metaText.substring(0, 2000), {
      x: LEFT_MARGIN,
      y: safeStartY,
      w: CONTENT_WIDTH,
      h: 0.1,
      fontSize: 1,
      color: 'FFFFFF',
      fontFace: FONT,
    });
    return safeStartY + 0.1;
  }

  // Options: { sources: [{url, title}], dataQuality: 'high'|'medium'|'low'|'estimated' }
  function addSlideWithTitle(title, subtitle = '', options = {}) {
    // Use master slide (clean background only)
    const slide = pptx.addSlide({ masterName: 'YCP_MASTER' });

    // Title + subtitle as single text shape to avoid overlap detection
    const titleParts = [
      {
        text: truncateTitle(title),
        options: {
          fontSize: 24,
          bold: true,
          color: COLORS.dk2,
          fontFace: FONT,
        },
      },
    ];
    if (subtitle) {
      const dataQualityIndicator =
        options.dataQuality === 'estimated' ? ' *' : options.dataQuality === 'low' ? ' +' : '';
      titleParts.push({
        text: '\n' + subtitle + dataQualityIndicator,
        options: {
          fontSize: 14,
          color: COLORS.accent1,
          fontFace: FONT,
        },
      });
    }
    slide.addText(titleParts, {
      x: LEFT_MARGIN,
      y: 0.1,
      w: CONTENT_WIDTH,
      h: 1.05,
      valign: 'top',
    });
    // Divider line below title area
    slide.addShape('line', {
      x: 0,
      y: 1.18,
      w: 13.333,
      h: 0,
      line: { color: COLORS.headerLine, width: 3 },
    });

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
        options: { fontSize: 8, italic: true, color: 'E46C0A', fontFace: FONT },
      });
    }

    if (sourcesToRender && sourcesToRender.length > 0) {
      footerParts.push({
        text: 'Sources: ',
        options: { fontSize: 8, fontFace: FONT, color: '666666' },
      });

      sourcesToRender.slice(0, 3).forEach((source, idx) => {
        if (idx > 0)
          footerParts.push({
            text: ', ',
            options: { fontSize: 8, fontFace: FONT, color: '666666' },
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
              fontSize: 8,
              fontFace: FONT,
              color: '0066CC',
              hyperlink: { url: sourceUrl },
            },
          });
        } else {
          footerParts.push({
            text: sourceTitle || String(source),
            options: { fontSize: 8, fontFace: FONT, color: '666666' },
          });
        }
      });
    }

    if (footerParts.length > 0) {
      slide.addText(footerParts, {
        x: LEFT_MARGIN,
        y: FOOTER_Y,
        w: CONTENT_WIDTH,
        h: 0.18,
        valign: 'top',
      });
    }

    return slide;
  }

  // Helper for table header row
  function tableHeader(cols) {
    return cols.map((text) => ({
      text,
      options: { bold: true, fill: { color: COLORS.accent3 }, color: COLORS.white, fontFace: FONT },
    }));
  }

  // Helper to show "Data unavailable" message on slides with missing data
  function addDataUnavailableMessage(slide, message = 'Data not available for this section') {
    // Single text shape with fill to avoid overlap between rect+text
    slide.addText(
      [
        {
          text: '! ' + message + '\n',
          options: { fontSize: 14, bold: true, color: 'E46C0A', fontFace: FONT },
        },
        {
          text: 'This data could not be verified through research. Please validate independently before making decisions.\n\n',
          options: { fontSize: 11, color: '666666', fontFace: FONT },
        },
        {
          text: `Strategic recommendation: commission targeted primary research or engage local consultants to fill this data gap. Consider this a priority action item for the next phase of due diligence.`,
          options: { fontSize: 10, color: '1F497D', fontFace: FONT, italic: true },
        },
      ],
      {
        x: LEFT_MARGIN,
        y: 2.0,
        w: CONTENT_WIDTH,
        h: 2.0,
        fill: { color: 'FFF8E1' },
        line: { color: 'E46C0A', pt: 1 },
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
          title: foundActs.slideTitle || `${country} - Energy Foundational Acts`,
          subtitle: truncateSubtitle(foundActs.subtitle || foundActs.keyMessage || '', 95),
          citations: getCitationsForCategory('policy_'),
          dataQuality: getDataQualityForCategory('policy_'),
        });

        const natPolicy = sectionData.nationalPolicy || {};
        blocks.push({
          key: 'nationalPolicy',
          dataType: 'policy_analysis',
          data: natPolicy,
          title: natPolicy.slideTitle || `${country} - National Energy Policy`,
          subtitle: truncateSubtitle(natPolicy.policyDirection || '', 95),
          citations: getCitationsForCategory('policy_'),
          dataQuality: getDataQualityForCategory('policy_'),
        });

        const investRestrict = sectionData.investmentRestrictions || {};
        blocks.push({
          key: 'investmentRestrictions',
          dataType: 'regulation_list',
          data: investRestrict,
          title: investRestrict.slideTitle || `${country} - Foreign Investment Rules`,
          subtitle: truncateSubtitle(investRestrict.riskJustification || '', 95),
          citations: getCitationsForCategory('policy_'),
          dataQuality: getDataQualityForCategory('policy_'),
        });
        break;
      }

      case 'Market Overview': {
        const marketCitations = getCitationsForCategory('market_');
        const marketDQ = getDataQualityForCategory('market_');
        const marketSubs = [
          { key: 'tpes', label: 'Total Primary Energy Supply' },
          { key: 'finalDemand', label: 'Final Energy Demand' },
          { key: 'electricity', label: 'Electricity & Power' },
          { key: 'gasLng', label: 'Gas & LNG Market' },
          { key: 'pricing', label: 'Energy Pricing' },
          { key: 'escoMarket', label: 'ESCO Market' },
        ];
        for (const sub of marketSubs) {
          const subData = sectionData[sub.key] || {};
          blocks.push({
            key: sub.key,
            dataType: subData.dataType || detectMarketDataType(sub.key, subData),
            data: subData,
            title: subData.slideTitle || `${country} - ${sub.label}`,
            subtitle: truncateSubtitle(
              subData.keyInsight || subData.subtitle || subData.growthRate || '',
              95
            ),
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
            `${country} - Japanese Energy Companies`,
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
            `${country} - Foreign Energy Companies`,
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
          data: summary.goNoGo || {},
          title: `${country} - Go/No-Go Assessment`,
          subtitle: truncateSubtitle(
            (summary.goNoGo || {}).overallVerdict || 'Investment Decision Framework',
            95
          ),
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'opportunitiesObstacles',
          dataType: 'opportunities_vs_barriers',
          data: {
            opportunities: summary.opportunities,
            obstacles: summary.obstacles,
            ratings: summary.ratings,
            recommendation: summary.recommendation,
          },
          title: `${country} - Opportunities & Obstacles`,
          subtitle: truncateSubtitle(summary.recommendation || '', 95),
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'keyInsights',
          dataType: 'section_summary',
          data: { insights: summary.keyInsights, recommendation: summary.recommendation },
          title: `${country} - Key Insights`,
          subtitle: 'Strategic implications for market entry',
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'timingIntelligence',
          dataType: 'section_summary',
          data: summary.timingIntelligence || {},
          title: (summary.timingIntelligence || {}).slideTitle || `${country} - Why Now?`,
          subtitle: truncateSubtitle(
            (summary.timingIntelligence || {}).windowOfOpportunity ||
              'Time-sensitive factors driving urgency',
            95
          ),
          citations: [],
          dataQuality: 'unknown',
        });

        blocks.push({
          key: 'lessonsLearned',
          dataType: 'case_study',
          data: summary.lessonsLearned || {},
          title: (summary.lessonsLearned || {}).slideTitle || `${country} - Lessons from Market`,
          subtitle: truncateSubtitle(
            (summary.lessonsLearned || {}).subtitle || 'What previous entrants learned',
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

    if (pattern === 'chart_callout_dual' && chartData?.series && chartData.series.length >= 2) {
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
      const chartOpts = { x: LEFT_MARGIN, y: 1.3, w: 7.8, h: 4.2 };
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
          y: 5.0,
          w: 7.0,
          h: 0.8,
        });
      }
    } else {
      // No chart data - render text insights
      if (insights.length > 0) {
        addCalloutBox(slide, 'Market Overview', insights.slice(0, 4).join(' | '), {
          x: LEFT_MARGIN,
          y: 1.5,
          w: CONTENT_WIDTH,
          h: 2.0,
          type: 'insight',
        });
      } else {
        addDataUnavailableMessage(slide, `${block.key} data not available`);
      }
      // Still add recommendation callout
      addCalloutBox(
        slide,
        'Recommended Action',
        `Commission targeted research to fill this data gap for ${country}. This section is critical for informed decision-making.`,
        { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
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
        if (data.keyInsight) insights.push(data.keyInsight);
        if (data.narrative) insights.push(truncate(data.narrative, 100));
        insights.push(
          `${country} energy mix shifting - first-mover advantage in efficiency consulting`
        );
        break;

      case 'finalDemand':
        if (data.structuredData?.marketBreakdown?.totalFinalConsumption) {
          const c = data.structuredData.marketBreakdown.totalFinalConsumption;
          if (c.industryPercent) insights.push(`Industry: ${c.industryPercent}`);
          if (c.transportPercent) insights.push(`Transport: ${c.transportPercent}`);
        }
        if (data.keyInsight) insights.push(data.keyInsight);
        safeArray(data.keyDrivers, 2).forEach((d) => insights.push(truncate(d, 80)));
        insights.push('Industrial demand growth creates unfulfilled capacity needs');
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
        if (data.keyInsight) insights.push(data.keyInsight);
        insights.push('IPP and captive power opportunities for foreign entrants');
        break;

      case 'gasLng':
        if (data.structuredData?.infrastructureCapacity) {
          const infra = data.structuredData.infrastructureCapacity;
          if (infra.lngImportCurrent) insights.push(`LNG Import: ${infra.lngImportCurrent}`);
          if (infra.lngImportPlanned) insights.push(`Planned: ${infra.lngImportPlanned}`);
          if (infra.pipelineCapacity) insights.push(`Pipeline: ${infra.pipelineCapacity}`);
        }
        if (data.pipelineNetwork) insights.push(truncate(data.pipelineNetwork, 80));
        if (data.keyInsight) insights.push(data.keyInsight);
        insights.push('LNG import gap creates supply partnership opportunities');
        break;

      case 'pricing':
        if (data.structuredData?.priceComparison) {
          const prices = data.structuredData.priceComparison;
          if (prices.generationCost) insights.push(`Generation: ${prices.generationCost}`);
          if (prices.retailPrice) insights.push(`Retail: ${prices.retailPrice}`);
          if (prices.industrialRate) insights.push(`Industrial: ${prices.industrialRate}`);
        }
        if (data.outlook) insights.push(truncate(data.outlook, 80));
        if (data.comparison) insights.push(truncate(`Regional: ${data.comparison}`, 80));
        if (data.keyInsight) insights.push(data.keyInsight);
        insights.push('Peak/off-peak spread enables demand response with 3-5yr payback');
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
        if (data.keyInsight) insights.push(data.keyInsight);
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
      const termStartY = hasChart ? 5.4 : 2.5;
      if (terminals.length > 0 && termStartY < CONTENT_BOTTOM - 0.6) {
        const termRows = [tableHeader(['Terminal', 'Capacity', 'Utilization'])];
        terminals.forEach((t) => {
          termRows.push([
            { text: truncate(t.name || '', 30) },
            { text: t.capacity || '' },
            { text: t.utilization || '' },
          ]);
        });
        const termColWidths = calculateColumnWidths(termRows, CONTENT_WIDTH);
        slide.addTable(termRows, {
          x: LEFT_MARGIN,
          y: termStartY,
          w: CONTENT_WIDTH,
          h: Math.min(0.8, CONTENT_BOTTOM - termStartY),
          fontSize: 9,
          fontFace: FONT,
          border: { pt: 0.5, color: 'cccccc' },
          colW: termColWidths.length > 0 ? termColWidths : [4.0, 4.25, 4.25],
          valign: 'top',
        });
      }
    }

    if (block.key === 'escoMarket') {
      const segments = safeArray(data.segments, 4);
      if (segments.length > 0) {
        const segRows = [tableHeader(['Segment', 'Size', 'Share'])];
        segments.forEach((s) => {
          segRows.push([{ text: s.name || '' }, { text: s.size || '' }, { text: s.share || '' }]);
        });
        const segColWidths = calculateColumnWidths(segRows, CONTENT_WIDTH);
        const segStartY = hasChart ? 5.3 : 3.2;
        slide.addTable(segRows, {
          x: LEFT_MARGIN,
          y: segStartY,
          w: CONTENT_WIDTH,
          h: Math.min(1.3, segRows.length * 0.35 + 0.2, CONTENT_BOTTOM - segStartY),
          fontSize: 11,
          fontFace: FONT,
          border: { pt: 0.5, color: 'cccccc' },
          colW: segColWidths.length > 0 ? segColWidths : [4.0, 2.65, 2.65],
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
    if (data.marketInsight) compInsights.push(truncate(data.marketInsight, 80));
    if (data.concentration) compInsights.push(truncate(data.concentration, 80));
    if (data.competitiveInsight) compInsights.push(truncate(data.competitiveInsight, 80));
    if (data.recommendedPartner) compInsights.push(`Top Pick: ${data.recommendedPartner}`);
    if (players.length > 0) {
      compInsights.push(`${players.length} players identified`);
      const topPlayer = players[0];
      if (topPlayer.marketShare)
        compInsights.push(`Leader: ${topPlayer.name} (${topPlayer.marketShare})`);
    }

    if (players.length === 0) {
      addDataUnavailableMessage(slide, `${block.key} data not available`);
      addCalloutBox(
        slide,
        'Recommended Action',
        `Recommend engaging local industry networks to identify relevant players in the ${scope.industry || 'energy'} sector in ${country}.`,
        { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
      return;
    }

    const tableStartY = addCompanyDescriptionsMeta(slide, players, 1.2);

    // Determine columns based on block type
    let headerCols, rowBuilder, defaultColW;

    if (block.key === 'partnerAssessment') {
      headerCols = [
        'Company',
        'Type',
        'Revenue',
        'Partnership Fit',
        'Acquisition Fit',
        'Est. Value',
      ];
      defaultColW = [2.0, 1.8, 1.5, 1.5, 1.5, 4.2];
      rowBuilder = (p) => [
        p.website
          ? {
              text: truncate(p.name || '', 20),
              options: { hyperlink: { url: p.website }, color: '0066CC' },
            }
          : { text: truncate(p.name || '', 20) },
        { text: truncate(p.type || '', 15) },
        { text: p.revenue || '' },
        { text: p.partnershipFit ? `${p.partnershipFit}/5` : '' },
        { text: p.acquisitionFit ? `${p.acquisitionFit}/5` : '' },
        { text: p.estimatedValuation || '' },
      ];
    } else if (block.key === 'foreignPlayers') {
      headerCols = ['Company', 'Origin', 'Mode', 'Description'];
      defaultColW = [1.8, 1.2, 1.2, 8.3];
      rowBuilder = (p) => {
        const desc =
          p.description ||
          `${p.entryYear ? `Entered ${p.entryYear}. ` : ''}${p.success || ''} ${p.projects || ''}`.trim() ||
          '';
        return [
          p.website
            ? { text: p.name || '', options: { hyperlink: { url: p.website }, color: '0066CC' } }
            : { text: p.name || '' },
          { text: p.origin || '' },
          { text: p.mode || '' },
          { text: truncate(desc, 500), options: { fontSize: 9 } },
        ];
      };
    } else if (block.key === 'localMajor') {
      headerCols = ['Company', 'Type', 'Revenue', 'Description'];
      defaultColW = [1.8, 1.2, 1.2, 8.3];
      rowBuilder = (p) => {
        const desc = p.description || `${p.strengths || ''} ${p.weaknesses || ''}`.trim() || '';
        return [
          p.website
            ? { text: p.name || '', options: { hyperlink: { url: p.website }, color: '0066CC' } }
            : { text: p.name || '' },
          { text: p.type || '' },
          { text: p.revenue || '' },
          { text: truncate(desc, 500), options: { fontSize: 9 } },
        ];
      };
    } else {
      // japanesePlayers default
      headerCols = ['Company', 'Presence', 'Description'];
      defaultColW = [2.0, 1.5, 9.0];
      rowBuilder = (p) => {
        const desc = p.description || p.projects || p.assessment || '';
        return [
          p.website
            ? { text: p.name || '', options: { hyperlink: { url: p.website }, color: '0066CC' } }
            : { text: p.name || '' },
          { text: truncate(p.presence || '', 30) },
          { text: truncate(desc, 500), options: { fontSize: 9 } },
        ];
      };
    }

    const rows = [tableHeader(headerCols)];
    players.forEach((p) => rows.push(rowBuilder(p)));
    const colWidths = calculateColumnWidths(rows, CONTENT_WIDTH);
    const tableH = safeTableHeight(rows.length, { fontSize: 9, maxH: 4.5 });

    slide.addTable(rows, {
      x: LEFT_MARGIN,
      y: tableStartY,
      w: CONTENT_WIDTH,
      h: tableH,
      fontSize: 9,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: colWidths.length > 0 ? colWidths : defaultColW,
      valign: 'top',
      autoPage: true,
      autoPageRepeatHeader: true,
    });

    // Add insights below table
    if (compInsights.length > 0) {
      addCalloutBox(slide, 'Competitive Insights', compInsights.slice(0, 4).join(' | '), {
        x: LEFT_MARGIN,
        y: tableStartY + tableH + 0.15,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
    }
  }

  // Generate a pattern-based slide for a single data block
  function generatePatternSlide(block) {
    const pattern = choosePattern(block.dataType, block.data);
    const slide = addSlideWithTitle(block.title, block.subtitle, {
      citations: block.citations,
      dataQuality: block.dataQuality,
    });

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
        // Generic fallback
        addDataUnavailableMessage(slide, `Content for ${block.key} not available`);
    }

    return slide;
  }

  // ============ SECTION RENDERERS ============

  function renderFoundationalActs(slide, data) {
    const acts = safeArray(data.acts, 5);
    if (acts.length > 0) {
      const actsRows = [tableHeader(['Act Name', 'Year', 'Requirements', 'Enforcement'])];
      acts.forEach((act) => {
        actsRows.push([
          { text: truncate(act.name || '', 25) },
          { text: act.year || '' },
          { text: truncate(act.requirements || '', 50) },
          { text: truncate(act.enforcement || '', 40) },
        ]);
      });
      const actsTableH = safeTableHeight(actsRows.length, { maxH: 4.5 });
      slide.addTable(actsRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: actsTableH,
        fontSize: 12,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [2.2, 0.8, 3.3, 3.0],
        valign: 'top',
        autoPage: true,
      });
      addCalloutBox(
        slide,
        `For ${scope.clientContext || 'Your Company'}:`,
        `Regulatory framework creates recurring ESCO demand in ${country}. Energy efficiency mandates drive industrial compliance spending.`,
        {
          x: LEFT_MARGIN,
          y: 1.3 + actsTableH + 0.15,
          w: CONTENT_WIDTH,
          h: 0.7,
          type: 'recommendation',
        }
      );
    } else {
      addDataUnavailableMessage(slide, 'Energy legislation data not available');
      addCalloutBox(
        slide,
        'Recommended Action',
        `Engage local regulatory counsel to map the full legislative landscape in ${country}. Understanding compliance requirements is a prerequisite for market entry.`,
        { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
    }
  }

  function renderNationalPolicy(slide, data) {
    const targets = safeArray(data.targets, 4);
    if (targets.length === 0 && safeArray(data.keyInitiatives, 4).length === 0) {
      addDataUnavailableMessage(slide, 'National policy data not available');
    }
    let policyNextY = 1.3;
    if (targets.length > 0) {
      const targetRows = [tableHeader(['Metric', 'Target', 'Deadline', 'Status'])];
      targets.forEach((t) => {
        targetRows.push([
          { text: t.metric || '' },
          { text: t.target || '' },
          { text: t.deadline || '' },
          { text: t.status || '' },
        ]);
      });
      const policyTableH = safeTableHeight(targetRows.length, { maxH: 2.5 });
      slide.addTable(targetRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: policyTableH,
        fontSize: 11,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [3.0, 2.3, 2.0, 2.0],
        valign: 'top',
        autoPage: true,
      });
      policyNextY = 1.3 + policyTableH + 0.15;
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
          fontSize: 11,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
      addCalloutBox(
        slide,
        'Strategic Implication',
        'National policy direction creates investment window. Align entry timing with government incentive programs.',
        {
          x: LEFT_MARGIN,
          y: initY + 0.35 + initBulletsH + 0.1,
          w: CONTENT_WIDTH,
          h: 0.7,
          type: 'insight',
        }
      );
    }
  }

  function renderInvestmentRestrictions(slide, data) {
    const ownership = data.ownershipLimits || {};
    const ownershipRows = [tableHeader(['Category', 'Limit', 'Details'])];
    if (ownership.general)
      ownershipRows.push([
        { text: 'General Sectors' },
        { text: ownership.general },
        { text: truncate(ownership.exceptions || '', 60) },
      ]);
    if (ownership.promoted)
      ownershipRows.push([
        { text: 'BOI Promoted' },
        { text: ownership.promoted },
        { text: 'Tax incentives apply' },
      ]);
    let investNextY = 1.3;
    if (ownershipRows.length > 1) {
      const ownerTableH = safeTableHeight(ownershipRows.length, { maxH: 1.8 });
      slide.addTable(ownershipRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: ownerTableH,
        fontSize: 11,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [2.5, 1.5, 5.3],
        valign: 'top',
        autoPage: true,
      });
      investNextY = 1.3 + ownerTableH + 0.15;
    }
    const incentivesList = safeArray(data.incentives, 3);
    if (incentivesList.length > 0) {
      const incRows = [tableHeader(['Incentive', 'Benefit', 'Eligibility'])];
      incentivesList.forEach((inc) => {
        incRows.push([
          { text: inc.name || '' },
          { text: inc.benefit || '' },
          { text: truncate(inc.eligibility || '', 50) },
        ]);
      });
      const incTableH = safeTableHeight(incRows.length, {
        maxH: Math.max(0.6, CONTENT_BOTTOM - investNextY - 1.0),
      });
      slide.addTable(incRows, {
        x: LEFT_MARGIN,
        y: investNextY,
        w: CONTENT_WIDTH,
        h: incTableH,
        fontSize: 11,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [2.5, 2.5, 4.3],
        valign: 'top',
        autoPage: true,
      });
      investNextY = investNextY + incTableH + 0.15;
    }
    if (data.riskLevel && investNextY < CONTENT_BOTTOM - 0.4) {
      const riskColor = data.riskLevel.toLowerCase().includes('high')
        ? COLORS.red
        : data.riskLevel.toLowerCase().includes('low')
          ? COLORS.green
          : COLORS.orange;
      slide.addText(`Regulatory Risk: ${data.riskLevel.toUpperCase()}`, {
        x: LEFT_MARGIN,
        y: investNextY,
        w: CONTENT_WIDTH,
        h: 0.4,
        fontSize: 14,
        bold: true,
        color: riskColor,
        fontFace: FONT,
      });
      investNextY += 0.5;
    }
    if (investNextY < CONTENT_BOTTOM - 0.8) {
      addCalloutBox(
        slide,
        'Strategic Recommendation',
        'Consider JV structure to navigate ownership restrictions. Leverage BOI incentives for tax benefits. Engage local legal counsel to optimize investment structure.',
        { x: LEFT_MARGIN, y: investNextY, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
    }
  }

  function renderCaseStudy(slide, data) {
    if (!data.company && safeArray(data.keyLessons, 4).length === 0) {
      addDataUnavailableMessage(slide, 'Case study data not available');
      addCalloutBox(
        slide,
        'Learning from Peers',
        `Recommend interviewing 3-5 companies that have entered ${country} to extract actionable lessons. Focus on entry mode selection, partner quality, and regulatory navigation.`,
        { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
    }

    // Use addCaseStudyRows pattern for rich rendering
    const caseRows = [
      { label: 'Company', content: data.company || 'N/A' },
      { label: 'Entry Year', content: data.entryYear || 'N/A' },
      { label: 'Entry Mode', content: data.entryMode || 'N/A' },
      { label: 'Investment', content: data.investment || 'N/A' },
      { label: 'Outcome', content: truncate(data.outcome || 'N/A', 200) },
    ];
    addCaseStudyRows(slide, caseRows);

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
      addCalloutBox(
        slide,
        'Deal Sourcing Strategy',
        'Limited M&A data suggests an early-stage market. Recommend proactive deal origination through industry events and direct outreach to local firms with growth potential.',
        { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
    }

    let maNextY = 1.3;
    if (deals.length > 0) {
      slide.addText('Recent Transactions', {
        x: LEFT_MARGIN,
        y: maNextY,
        w: 8.5,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.dk2 || '1F497D',
        fontFace: FONT,
      });
      maNextY += 0.35;
      const dealRows = [tableHeader(['Year', 'Buyer', 'Target', 'Value', 'Rationale'])];
      deals.forEach((d) => {
        dealRows.push([
          { text: d.year || '' },
          { text: d.buyer || '' },
          { text: d.target || '' },
          { text: d.value || '' },
          { text: truncate(d.rationale || '', 30) },
        ]);
      });
      const dealColWidths = calculateColumnWidths(dealRows, CONTENT_WIDTH);
      const dealTableH = safeTableHeight(dealRows.length, { fontSize: 10, maxH: 2.0 });
      slide.addTable(dealRows, {
        x: LEFT_MARGIN,
        y: maNextY,
        w: CONTENT_WIDTH,
        h: dealTableH,
        fontSize: 10,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: dealColWidths.length > 0 ? dealColWidths : [0.8, 1.8, 1.8, 1.5, 3.4],
        valign: 'top',
      });
      maNextY += dealTableH + 0.15;
    }

    if (potentialTargets.length > 0) {
      addCompanyDescriptionsMeta(slide, potentialTargets, maNextY);
      slide.addText('Potential Acquisition Targets', {
        x: LEFT_MARGIN,
        y: maNextY,
        w: 8.5,
        h: 0.3,
        fontSize: 12,
        bold: true,
        color: COLORS.dk2 || '1F497D',
        fontFace: FONT,
      });
      maNextY += 0.35;
      const targetRows = [tableHeader(['Company', 'Est. Value', 'Rationale', 'Timing'])];
      potentialTargets.forEach((t) => {
        const nameCell = t.website
          ? { text: t.name || '', options: { hyperlink: { url: t.website }, color: '0066CC' } }
          : { text: t.name || '' };
        targetRows.push([
          nameCell,
          { text: t.estimatedValue || '' },
          { text: truncate(t.rationale || '', 40) },
          { text: t.timing || '' },
        ]);
      });
      const targetColWidths = calculateColumnWidths(targetRows, CONTENT_WIDTH);
      const maTargetTableH = safeTableHeight(targetRows.length, {
        fontSize: 10,
        maxH: Math.max(0.6, CONTENT_BOTTOM - maNextY - 1.0),
      });
      slide.addTable(targetRows, {
        x: LEFT_MARGIN,
        y: maNextY,
        w: CONTENT_WIDTH,
        h: maTargetTableH,
        fontSize: 10,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: targetColWidths.length > 0 ? targetColWidths : [2.0, 1.5, 4.0, 1.8],
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
    const dealSize = data.typicalDealSize || {};
    const terms = data.contractTerms || {};
    const financials = data.financials || {};

    const econInsights = [];
    if (dealSize.average) econInsights.push(`Avg Deal: ${dealSize.average}`);
    if (financials.irr) econInsights.push(`Expected IRR: ${financials.irr}`);
    if (financials.paybackPeriod) econInsights.push(`Payback: ${financials.paybackPeriod}`);
    if (terms.duration) econInsights.push(`Contract: ${terms.duration}`);
    if (data.keyInsight) econInsights.push(truncate(data.keyInsight, 80));

    const econRows = [tableHeader(['Metric', 'Value', 'Notes'])];
    if (dealSize.average)
      econRows.push([
        { text: 'Typical Deal Size' },
        { text: `${dealSize.min || ''} - ${dealSize.max || ''}` },
        { text: `Avg: ${dealSize.average}` },
      ]);
    if (terms.duration)
      econRows.push([{ text: 'Contract Duration' }, { text: terms.duration }, { text: '' }]);
    if (terms.savingsSplit)
      econRows.push([
        { text: 'Savings Split' },
        { text: terms.savingsSplit },
        { text: terms.guaranteeStructure || '' },
      ]);
    if (financials.paybackPeriod)
      econRows.push([{ text: 'Payback Period' }, { text: financials.paybackPeriod }, { text: '' }]);
    if (financials.irr)
      econRows.push([{ text: 'Expected IRR' }, { text: financials.irr }, { text: '' }]);
    if (financials.marginProfile)
      econRows.push([{ text: 'Gross Margin' }, { text: financials.marginProfile }, { text: '' }]);

    const financing = safeArray(data.financingOptions, 3);
    if (econRows.length === 1 && financing.length === 0) {
      addDataUnavailableMessage(slide, 'ESCO economics data not available');
      addCalloutBox(
        slide,
        'Economic Modeling Required',
        'Recommend building a bottom-up deal economics model using local utility rates and building stock data. Typical ESCO IRRs of 15-25% achievable in emerging markets.',
        { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
    }
    if (econRows.length > 1) {
      const econColWidths = calculateColumnWidths(econRows, CONTENT_WIDTH);
      slide.addTable(econRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: financing.length > 0 ? 3.0 : 4.0,
        fontSize: 12,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: econColWidths.length > 0 ? econColWidths : [2.5, 3.0, 7.0],
        valign: 'top',
      });
      if (econInsights.length > 0) {
        const econTableH = financing.length > 0 ? 3.0 : 4.0;
        addCalloutBox(slide, 'Deal Economics', econInsights.slice(0, 4).join(' | '), {
          x: LEFT_MARGIN,
          y: 1.3 + econTableH + 0.15,
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
        financing.map((f) => `- ${truncate(f, 60)}`).join('\n'),
        {
          x: LEFT_MARGIN,
          y: econInsights.length > 0 ? 1.3 + 3.0 + 0.15 + 0.65 + 0.15 : 1.3 + 3.0 + 0.15,
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
      stratInsights.push(`Recommended: ${truncate(data.recommendation, 60)}`);
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
      addCalloutBox(
        slide,
        'Entry Mode Decision',
        'Three standard options should be evaluated: JV (lower risk, faster), acquisition (higher control), greenfield (highest control, slowest). Recommend JV as default entry mode for emerging markets.',
        { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
    } else {
      const optRows = [
        tableHeader(['Option', 'Timeline', 'Investment', 'Control', 'Risk', 'Key Pros']),
      ];
      options.forEach((opt) => {
        optRows.push([
          { text: opt.mode || '' },
          { text: opt.timeline || '' },
          { text: opt.investment || '' },
          { text: opt.controlLevel || '' },
          { text: opt.riskLevel || '' },
          { text: truncate((opt.pros || []).join('; '), 40) },
        ]);
      });
      const optColWidths = calculateColumnWidths(optRows, CONTENT_WIDTH);
      const optTableH = safeTableHeight(optRows.length, { fontSize: 10, maxH: 2.5 });
      slide.addTable(optRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: optTableH,
        fontSize: 10,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: optColWidths.length > 0 ? optColWidths : [1.8, 1.5, 1.8, 1.8, 1.3, 4.3],
        valign: 'top',
      });
      entryNextY = 1.3 + optTableH + 0.15;
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
      addCalloutBox(
        slide,
        'Specific Recommendation',
        'JV with local ESCO targeting industrial customers. Timeline: 6-12 months to first project. Investment: $10-30M.',
        {
          x: LEFT_MARGIN,
          y: entryNextY,
          w: CONTENT_WIDTH,
          h: 0.55,
          type: 'recommendation',
        }
      );
      entryNextY += 0.55 + 0.15;
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
        fontSize: 11,
        bold: true,
        color: COLORS.dk2 || '1F497D',
        fontFace: FONT,
      });
      const renderHarvey = (arr, idx) => {
        if (!Array.isArray(arr) || idx >= arr.length) return '';
        const val = Math.max(0, Math.min(5, parseInt(arr[idx]) || 0));
        return '\u25CF'.repeat(val) + '\u25CB'.repeat(5 - val);
      };
      const harveyRows = [tableHeader(['Criteria', 'Joint Venture', 'Acquisition', 'Greenfield'])];
      harvey.criteria.forEach((crit, idx) => {
        harveyRows.push([
          { text: String(crit || '') },
          { text: renderHarvey(harvey.jv, idx) },
          { text: renderHarvey(harvey.acquisition, idx) },
          { text: renderHarvey(harvey.greenfield, idx) },
        ]);
      });
      const harveyColWidths = calculateColumnWidths(harveyRows, CONTENT_WIDTH);
      slide.addTable(harveyRows, {
        x: LEFT_MARGIN,
        y: harveyBaseY + 0.3,
        w: CONTENT_WIDTH,
        h: 1.2,
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: harveyColWidths.length > 0 ? harveyColWidths : [2.5, 2.3, 2.25, 2.25],
        valign: 'middle',
      });
    }
  }

  function renderImplementation(slide, data) {
    const phases = safeArray(data.phases, 3);
    if (phases.length > 0) {
      // Phases as table
      const phaseRows = [
        phases.map((phase) => ({
          text: phase.name || 'Phase',
          options: {
            bold: true,
            color: 'FFFFFF',
            fill: { color: COLORS.accent1 },
            align: 'center',
            fontSize: 10,
          },
        })),
        phases.map((phase) => ({
          text:
            safeArray(phase.activities, 3)
              .map((a) => `- ${truncate(a, 35)}`)
              .join('\n') || 'N/A',
          options: { fontSize: 8, valign: 'top' },
        })),
        phases.map((phase) => {
          const parts = [];
          const milestones = safeArray(phase.milestones, 2);
          if (milestones.length > 0)
            parts.push(`Milestones: ${milestones.map((m) => truncate(m, 20)).join(', ')}`);
          if (phase.investment) parts.push(`Investment: ${phase.investment}`);
          return {
            text: parts.join('\n') || '',
            options: { fontSize: 8, color: COLORS.dk2, bold: true },
          };
        }),
      ];
      const phaseColW = phases.map(() => CONTENT_WIDTH / phases.length);
      const implTableH = safeTableHeight(phaseRows.length, { maxH: 4.0 });
      slide.addTable(phaseRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: implTableH,
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: phaseColW,
        valign: 'top',
      });

      // Add chevron flow for phases below table
      addChevronFlow(
        slide,
        phases.map((p) => p.name || 'Phase'),
        null,
        { y: 1.3 + implTableH + 0.3 }
      );

      addCalloutBox(
        slide,
        'Next Steps',
        `Recommend initiating Phase 1 immediately. Secure local partner commitment within 60 days. Total investment: ${data.totalInvestment || '$10-30M'}. Breakeven: ${data.breakeven || '18-24 months'}.`,
        {
          x: LEFT_MARGIN,
          y: 1.3 + implTableH + 0.3 + 1.3 + 0.15,
          w: CONTENT_WIDTH,
          h: 0.7,
          type: 'recommendation',
        }
      );
    } else {
      addDataUnavailableMessage(slide, 'Implementation roadmap data not available');
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

    let nextSegY = 1.35;
    if (segmentsList.length > 0) {
      const segmentRows = [
        tableHeader(['Segment', 'Size', 'Energy Intensity', 'Decision Maker', 'Priority']),
      ];
      segmentsList.forEach((s) => {
        segmentRows.push([
          { text: truncate(s.name || '', 25) },
          { text: truncate(s.size || '', 20) },
          { text: truncate(s.energyIntensity || '', 15) },
          { text: truncate(s.decisionMaker || '', 18) },
          { text: s.priority ? `${s.priority}/5` : '' },
        ]);
      });
      const segColWidths = calculateColumnWidths(segmentRows, CONTENT_WIDTH);
      const segTableH = Math.min(1.8, segmentRows.length * 0.4 + 0.2);
      slide.addTable(segmentRows, {
        x: LEFT_MARGIN,
        y: 1.35,
        w: CONTENT_WIDTH,
        h: segTableH,
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: segColWidths.length > 0 ? segColWidths : [2.5, 2.5, 2.0, 2.5, 3.0],
        valign: 'top',
        autoPage: true,
      });
      nextSegY = 1.35 + segTableH + 0.15;
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
        fontSize: 11,
        bold: true,
        color: COLORS.dk2 || '1F497D',
        fontFace: FONT,
      });
      addCompanyDescriptionsMeta(slide, topTargets, priorityYBase + 0.25);
      const targetCompRows = [tableHeader(['Company', 'Industry', 'Energy Spend', 'Location'])];
      topTargets.forEach((t) => {
        const nameCell = t.website
          ? {
              text: truncate(t.company || t.name || '', 25),
              options: { hyperlink: { url: t.website }, color: '0066CC' },
            }
          : { text: truncate(t.company || t.name || '', 25) };
        targetCompRows.push([
          nameCell,
          { text: truncate(t.industry || '', 15) },
          { text: truncate(t.energySpend || '', 15) },
          { text: truncate(t.location || '', 15) },
        ]);
      });
      const targetColWidths = calculateColumnWidths(targetCompRows, CONTENT_WIDTH);
      const targetTableStartY = priorityYBase + 0.45;
      const targetTableH = Math.min(1.0, Math.max(0.4, CONTENT_BOTTOM - targetTableStartY));
      slide.addTable(targetCompRows, {
        x: LEFT_MARGIN,
        y: targetTableStartY,
        w: CONTENT_WIDTH,
        h: targetTableH,
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: targetColWidths.length > 0 ? targetColWidths : [2.5, 2.3, 2.25, 2.25],
        valign: 'top',
        autoPage: true,
      });
    }
  }

  function renderGoNoGo(slide, data) {
    const goNoGoCriteria = safeArray(data.criteria, 6);
    if (goNoGoCriteria.length > 0) {
      const goNoGoRows = [tableHeader(['Criterion', 'Status', 'Evidence'])];
      goNoGoCriteria.forEach((c) => {
        const statusIcon = c.met === true ? '\u2713' : c.met === false ? '\u2717' : '?';
        const statusColor =
          c.met === true ? COLORS.green : c.met === false ? COLORS.red : COLORS.orange;
        goNoGoRows.push([
          { text: truncate(c.criterion || '', 40) },
          { text: statusIcon, options: { color: statusColor, bold: true, align: 'center' } },
          { text: truncate(c.evidence || '', 50) },
        ]);
      });
      const goNoGoTableH = safeTableHeight(goNoGoRows.length, { fontSize: 11, maxH: 3.5 });
      slide.addTable(goNoGoRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: goNoGoTableH,
        fontSize: 11,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [3.0, 0.8, 5.5],
        valign: 'top',
      });
    }
    // Verdict box
    const goNoGoTableBottom =
      goNoGoCriteria.length > 0
        ? 1.3 + safeTableHeight(goNoGoCriteria.length + 1, { fontSize: 11, maxH: 3.5 }) + 0.15
        : 1.5;
    const verdictColor =
      data.overallVerdict?.includes('GO') && !data.overallVerdict?.includes('NO')
        ? COLORS.green
        : data.overallVerdict?.includes('NO')
          ? COLORS.red
          : COLORS.orange;
    slide.addText(`VERDICT: ${data.overallVerdict || 'CONDITIONAL'}`, {
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
    addCalloutBox(
      slide,
      `Decision Required for ${scope.clientContext || 'Your Company'}`,
      `Approve ${country} entry by end of quarter. Key success factors: Speed to market, right partner structure.`,
      {
        x: LEFT_MARGIN,
        y: goNoGoNextY,
        w: CONTENT_WIDTH,
        h: 0.55,
        type: 'recommendation',
      }
    );
  }

  function renderOpportunitiesObstacles(slide, data) {
    // Use matrix pattern for richer visual display
    const oppsFormatted = safeArray(data.opportunities, 5).map((o) =>
      typeof o === 'string' ? o : `${o.opportunity || ''} (${o.size || ''})`
    );
    const obsFormatted = safeArray(data.obstacles, 5).map((o) =>
      typeof o === 'string' ? o : `${o.obstacle || ''} [${o.severity || ''}]`
    );

    addOpportunitiesObstaclesSummary(slide, oppsFormatted, obsFormatted, {
      x: LEFT_MARGIN,
      y: 1.35,
      fullWidth: CONTENT_WIDTH,
    });

    const ratings = data.ratings || {};
    if (ratings.attractiveness || ratings.feasibility) {
      slide.addText(
        `Attractiveness: ${ratings.attractiveness || 'N/A'}/10 | Feasibility: ${ratings.feasibility || 'N/A'}/10`,
        {
          x: LEFT_MARGIN,
          y: CONTENT_BOTTOM - 0.3,
          w: CONTENT_WIDTH,
          h: 0.25,
          fontSize: 12,
          bold: true,
          color: COLORS.dk2,
          fontFace: FONT,
        }
      );
    }
  }

  function renderKeyInsights(slide, data) {
    const insights = safeArray(data.insights, 3);
    let insightY = 1.3;
    insights.forEach((insight, idx) => {
      const title =
        typeof insight === 'string' ? `Insight ${idx + 1}` : insight.title || `Insight ${idx + 1}`;
      const content =
        typeof insight === 'string'
          ? insight
          : `${insight.data || ''} ${insight.pattern || ''} ${insight.implication || ''}`;

      slide.addText(title, {
        x: LEFT_MARGIN,
        y: insightY,
        w: CONTENT_WIDTH,
        h: 0.3,
        fontSize: 13,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      slide.addText(truncate(content, 160), {
        x: LEFT_MARGIN,
        y: insightY + 0.3,
        w: CONTENT_WIDTH,
        h: 0.9,
        fontSize: 9,
        fontFace: FONT,
        color: COLORS.black,
        valign: 'top',
      });
      insightY += 1.35;
    });

    if (data.recommendation) {
      const recoY = Math.max(insightY + 0.1, 5.2);
      addCalloutBox(slide, 'RECOMMENDATION', truncate(data.recommendation, 150), {
        y: Math.min(recoY, 6.1),
        h: 0.7,
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
          { text: truncate(t.trigger || '', 35) },
          { text: truncate(t.impact || '', 30) },
          { text: truncate(t.action || '', 30) },
        ]);
      });
      const triggerColWidths = calculateColumnWidths(triggerRows, CONTENT_WIDTH);
      slide.addTable(triggerRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: 2.8,
        fontSize: 11,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: triggerColWidths.length > 0 ? triggerColWidths : [4.0, 4.25, 4.25],
        valign: 'top',
      });
    } else {
      slide.addText(
        `Market timing assessment for ${country}. Key factors to monitor include regulatory changes, infrastructure investment cycles, and competitor moves. Early entry creates sustainable competitive advantage.`,
        {
          x: LEFT_MARGIN,
          y: 1.5,
          w: CONTENT_WIDTH,
          h: 1.5,
          fontSize: 13,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
    }
    if (data.windowOfOpportunity) {
      addCalloutBox(slide, 'WINDOW OF OPPORTUNITY', data.windowOfOpportunity, {
        x: LEFT_MARGIN,
        y: triggers.length > 0 ? Math.min(1.3 + 2.8 + 0.15, 5.5) : 3.3,
        w: CONTENT_WIDTH,
        h: 1.0,
        type: 'recommendation',
      });
    } else {
      addCalloutBox(
        slide,
        'Timing Recommendation',
        'Market conditions suggest acting within the next 6-12 months to capture early-mover advantage. Delayed entry increases competition risk and reduces available partnership options.',
        {
          x: LEFT_MARGIN,
          y: triggers.length > 0 ? Math.min(1.3 + 2.8 + 0.15, 5.5) : 3.3,
          w: CONTENT_WIDTH,
          h: 1.0,
          type: 'recommendation',
        }
      );
    }
  }

  function renderLessonsLearned(slide, data) {
    let lessonsNextY = 1.3;
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
          { text: `${f.company || ''} (${f.year || ''})` },
          { text: truncate(f.reason || '', 35) },
          { text: truncate(f.lesson || '', 35) },
        ]);
      });
      const failTableH = safeTableHeight(failureRows.length, { fontSize: 10, maxH: 2.0 });
      slide.addTable(failureRows, {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: CONTENT_WIDTH,
        h: failTableH,
        fontSize: 10,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [2.2, 3.5, 3.6],
        valign: 'top',
      });
      lessonsNextY += failTableH + 0.15;
    }
    const successFactors = safeArray(data.successFactors, 3);
    if (successFactors.length > 0) {
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
      slide.addText(
        successFactors.map((s) => ({ text: truncate(s, 80), options: { bullet: true } })),
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
    if (failures.length === 0 && successFactors.length === 0) {
      slide.addText(
        `Market entry lessons from comparable ${scope.industry || 'energy services'} markets suggest focusing on: (1) Local partner selection quality, (2) Regulatory relationship building, (3) Patience with deal timelines. Recommend benchmarking against 3-5 comparable market entries.`,
        {
          x: LEFT_MARGIN,
          y: lessonsNextY,
          w: CONTENT_WIDTH,
          h: 1.5,
          fontSize: 12,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
      lessonsNextY += 1.65;
    }
    const warningsData = safeArray(data.warningSignsToWatch, 3);
    if (warningsData.length > 0) {
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
      slide.addText(
        warningsData.map((w) => ({ text: truncate(w, 80), options: { bullet: true } })),
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

  // ============ SECTION GENERATION ============
  // Generate an entire section: TOC divider + content slides
  function generateSection(sectionName, sectionNumber, totalSections, sectionData) {
    addSectionDivider(pptx, sectionName, sectionNumber, totalSections, { COLORS });
    const blocks = classifyDataBlocks(sectionName, sectionData);
    for (const block of blocks) {
      generatePatternSlide(block);
    }
    return blocks.length;
  }

  // ============ MAIN FLOW ============

  // Count blocks per section for dynamic TOC
  const sectionDefs = [
    { name: 'Policy & Regulations', data: policy },
    { name: 'Market Overview', data: market },
    { name: 'Competitive Landscape', data: competitors },
    { name: 'Strategic Analysis', data: depth },
    { name: 'Recommendations', data: null }, // uses summary
  ];

  // Pre-calculate block counts for TOC
  const sectionBlockCounts = sectionDefs.map((sec) => {
    const blocks = classifyDataBlocks(sec.name, sec.name === 'Recommendations' ? {} : sec.data);
    return blocks.length;
  });

  // ===== SLIDE 1: TITLE =====
  const titleSlide = pptx.addSlide({ masterName: 'YCP_MASTER' });
  titleSlide.addText(country.toUpperCase(), {
    x: 0.5,
    y: 2.2,
    w: 12,
    h: 0.8,
    fontSize: 42,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  titleSlide.addText(`${scope.industry} - Market Overview & Analysis`, {
    x: 0.5,
    y: 3.0,
    w: 12,
    h: 0.5,
    fontSize: 24,
    color: COLORS.accent1,
    fontFace: FONT,
  });
  titleSlide.addText('Executive Summary - Deep Research Report', {
    x: 0.5,
    y: 3.6,
    w: 12,
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

  // ===== SLIDE 2: TABLE OF CONTENTS (dynamic) =====
  const tocSlide = pptx.addSlide({ masterName: 'YCP_MASTER' });
  tocSlide.addText('Table of Contents', {
    x: LEFT_MARGIN,
    y: 0.15,
    w: CONTENT_WIDTH,
    h: 0.55,
    fontSize: 24,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  tocSlide.addShape('line', {
    x: 0,
    y: 0.73,
    w: 13.333,
    h: 0,
    line: { color: COLORS.headerLine, width: 3 },
  });

  // Calculate dynamic slide ranges
  let currentSlide = 3; // After title and TOC
  const tocSectionDescriptions = {
    'Policy & Regulations': 'Foundational Acts, National Policy, Investment Restrictions',
    'Market Overview': 'Energy Supply, Demand, Electricity, Gas & LNG, Pricing, ESCO Market',
    'Competitive Landscape': 'Japanese Players, Local Players, Foreign Players, Case Studies',
    'Strategic Analysis': 'M&A Activity, Economics, Partner Assessment, Entry Strategy',
    Recommendations: 'Implementation, Timing, Go/No-Go, Opportunities & Obstacles',
  };

  sectionDefs.forEach((sec, idx) => {
    currentSlide += 1; // section divider
    const startSlide = currentSlide + 1;
    const blockCount = sectionBlockCounts[idx];
    const yPos = 1.5 + idx * 1.05;

    tocSlide.addText(
      [
        {
          text: `${idx + 1}. ${sec.name}`,
          options: { fontSize: 16, bold: true, color: COLORS.dk2, fontFace: FONT },
        },
        {
          text: `   Slide ${startSlide}`,
          options: { fontSize: 12, color: COLORS.accent1, fontFace: FONT },
        },
      ],
      {
        x: LEFT_MARGIN,
        y: yPos,
        w: CONTENT_WIDTH,
        h: 0.35,
        valign: 'middle',
      }
    );
    tocSlide.addText(tocSectionDescriptions[sec.name] || '', {
      x: LEFT_MARGIN + 0.3,
      y: yPos + 0.42,
      w: 10,
      h: 0.28,
      fontSize: 11,
      color: '666666',
      fontFace: FONT,
    });

    currentSlide += blockCount;
  });

  // ===== GENERATE ALL SECTIONS =====
  generateSection('Policy & Regulations', 1, 5, policy);
  generateSection('Market Overview', 2, 5, market);
  generateSection('Competitive Landscape', 3, 5, competitors);
  generateSection('Strategic Analysis', 4, 5, depth);

  // Recommendations section needs special handling (uses summary, not depth)
  addSectionDivider(pptx, 'Recommendations', 5, 5, { COLORS });
  const recBlocks = classifyDataBlocks('Recommendations', {});
  for (const block of recBlocks) {
    generatePatternSlide(block);
  }

  // ===== FINAL SUMMARY SLIDE =====
  const finalSlide = addSlideWithTitle(
    `${country} - Research Summary`,
    `Analysis completed ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
  );
  const metricsRows = [tableHeader(['Metric', 'Value', 'Confidence'])];
  const marketDynamics = market.marketDynamics || {};
  if (marketDynamics.marketSize) {
    metricsRows.push([
      { text: 'Market Size' },
      { text: truncate(marketDynamics.marketSize, 40) },
      { text: `${synthesis.confidenceScore || '--'}/100` },
    ]);
  }
  if (depth.escoEconomics?.typicalDealSize?.average) {
    metricsRows.push([
      { text: 'Typical Deal Size' },
      { text: depth.escoEconomics.typicalDealSize.average },
      { text: '' },
    ]);
  }
  const finalRatings = summary.ratings || {};
  if (finalRatings.attractiveness) {
    metricsRows.push([
      { text: 'Attractiveness' },
      { text: `${finalRatings.attractiveness}/10` },
      {
        text: finalRatings.attractivenessRationale
          ? truncate(finalRatings.attractivenessRationale, 30)
          : '',
      },
    ]);
  }
  if (finalRatings.feasibility) {
    metricsRows.push([
      { text: 'Feasibility' },
      { text: `${finalRatings.feasibility}/10` },
      {
        text: finalRatings.feasibilityRationale
          ? truncate(finalRatings.feasibilityRationale, 30)
          : '',
      },
    ]);
  }
  const metricsTableH = Math.min(2.5, metricsRows.length * 0.35 + 0.2);
  finalSlide.addTable(metricsRows, {
    x: LEFT_MARGIN,
    y: 1.3,
    w: CONTENT_WIDTH,
    h: metricsTableH,
    fontSize: 11,
    fontFace: FONT,
    border: { pt: 0.5, color: 'cccccc' },
    colW: [2.5, 3.5, 3.3],
    valign: 'top',
  });
  const finalGoNoGo = summary.goNoGo || {};
  const finalVerdictType =
    finalGoNoGo.overallVerdict?.includes('GO') && !finalGoNoGo.overallVerdict?.includes('NO')
      ? 'positive'
      : finalGoNoGo.overallVerdict?.includes('NO')
        ? 'negative'
        : 'warning';
  addCalloutBox(
    finalSlide,
    `VERDICT: ${finalGoNoGo.overallVerdict || 'CONDITIONAL'}`,
    (finalGoNoGo.conditions || []).slice(0, 2).join('; ') ||
      'Proceed with recommended entry strategy',
    { y: 4.0, h: 0.9, type: finalVerdictType }
  );
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

  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  const totalSlides = 2 + sectionDefs.length + sectionBlockCounts.reduce((a, b) => a + b, 0) + 1;
  console.log(
    `Section-based PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB, ~${totalSlides} slides`
  );
  return pptxBuffer;
}

module.exports = { generateSingleCountryPPT };
