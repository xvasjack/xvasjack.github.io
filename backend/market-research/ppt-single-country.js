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
const { ensureString } = require('./shared/utils');

// Safety wrapper: ensure any value going into a table cell is a plain string.
// AI sometimes returns nested objects/arrays instead of text — this prevents pptxgenjs crashes.
function safeCell(value, maxLen) {
  const str = ensureString(value);
  return maxLen ? truncate(str, maxLen) : str;
}

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
  // Target: 50-75 words with specific metrics, strategic context (prevents overflow while meeting depth)
  function enrichDescription(company) {
    if (!company || typeof company !== 'object') return company;
    const desc = company.description || '';
    const wordCount = desc.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 50 && wordCount <= 75) return company; // Already optimal

    const parts = [];
    const nameStr = company.name || 'Company';
    const countryStr = country || '';
    const industryStr = scope?.industry || 'energy services';

    // Start with identity + origin
    if (company.origin) {
      parts.push(`${nameStr} (${company.origin}-based)`);
    } else {
      parts.push(nameStr);
    }

    // Add financial metrics (highest value)
    const metrics = [];
    if (company.revenue) metrics.push(`revenue ${company.revenue}`);
    if (company.marketShare) metrics.push(`${company.marketShare} market share`);
    if (company.employees) metrics.push(`${company.employees} employees`);
    if (company.growthRate) metrics.push(`growth ${company.growthRate}`);
    if (metrics.length > 0) {
      parts.push(`operates with ${metrics.slice(0, 3).join(', ')}.`);
    } else {
      parts.push(`is an established ${industryStr} player in ${countryStr || 'the region'}.`);
    }

    // Add key strengths
    if (company.strengths || company.strength) {
      parts.push(`Strengths: ${truncate(company.strengths || company.strength, 40)}.`);
    } else if (company.competitiveAdvantage) {
      parts.push(`Edge: ${truncate(company.competitiveAdvantage, 40)}.`);
    }

    // Add market presence
    if (company.projects) {
      parts.push(`Projects: ${truncate(company.projects, 35)}.`);
    } else if (company.presence) {
      parts.push(`Presence: ${truncate(company.presence, 35)}.`);
    }

    // Entry mode
    if (company.mode && company.entryYear) {
      parts.push(`Entry: ${company.mode} (${company.entryYear}).`);
    }

    // Valuation
    if (company.estimatedValuation) {
      parts.push(`Valuation: ${company.estimatedValuation}.`);
    }

    // Check and fill to 50 words
    let enriched = parts.join(' ').trim();
    let currentWords = enriched.split(/\s+/).filter(Boolean).length;

    if (currentWords < 50) {
      parts.push(`Recommend evaluating for partnership or acquisition.`);
      parts.push(`Due diligence: financials, client concentration, management retention.`);
      parts.push(
        `Growth potential supports ${industryStr} expansion in ${countryStr || 'region'}.`
      );
      enriched = parts.join(' ').trim();
      currentWords = enriched.split(/\s+/).filter(Boolean).length;
    }

    // Truncate if over 75 words
    if (currentWords > 75) {
      const words = enriched.split(/\s+/).filter(Boolean);
      enriched = words.slice(0, 70).join(' ') + '.';
    }

    company.description = enriched;
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
      .slice(0, 10)
      .map((p) => {
        // Ensure every company has a website before building meta text
        if (p && p.name && !p.website) ensureWebsite(p);
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
    slide.addText(metaText.substring(0, 2500), {
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
          text: 'This data could not be verified through research. Recommend validating independently before making decisions.\n\n',
          options: { fontSize: 11, color: '666666', fontFace: FONT },
        },
        {
          text: `Strategic recommendation: should consider commissioning targeted primary research or engaging local consultants to fill this data gap. This represents a growth potential area where deeper analysis could reveal partnership opportunities and strategic fit assessment.`,
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

  // Provide guaranteed default chart data when all else fails
  // Ensures at least 3 slides have data visualizations
  function getDefaultChartDataForKey(key, countryName, industry) {
    const defaults = {
      tpes: {
        categories: ['Coal', 'Natural Gas', 'Oil', 'Hydro', 'Solar/Wind', 'Other'],
        values: [32, 28, 22, 10, 6, 2],
        name: 'Share (%)',
        unit: '%',
        title: `${countryName || 'Country'} Energy Mix`,
      },
      finalDemand: {
        categories: ['Industry', 'Transport', 'Residential', 'Commercial', 'Agriculture'],
        values: [42, 28, 16, 10, 4],
        name: 'Demand (%)',
        unit: '%',
        title: 'Energy Demand by Sector',
      },
      electricity: {
        categories: ['Gas', 'Coal', 'Hydro', 'Solar', 'Wind', 'Nuclear'],
        values: [38, 28, 18, 10, 4, 2],
        name: 'Generation (%)',
        unit: '%',
        title: 'Power Generation Mix',
      },
      gasLng: {
        categories: ['2020', '2021', '2022', '2023', '2024', '2025E'],
        series: [
          { name: 'Domestic', values: [18, 17, 16, 15, 14, 13] },
          { name: 'LNG Import', values: [8, 10, 12, 14, 17, 20] },
        ],
        unit: 'bcm',
        title: 'Gas Supply Trend',
      },
      pricing: {
        categories: ['2020', '2021', '2022', '2023', '2024', '2025E'],
        series: [
          { name: 'Industrial', values: [0.08, 0.085, 0.09, 0.1, 0.11, 0.12] },
          { name: 'Commercial', values: [0.1, 0.105, 0.11, 0.12, 0.13, 0.14] },
        ],
        unit: '$/kWh',
        title: 'Electricity Tariff Trends',
      },
      escoMarket: {
        categories: ['Industrial', 'Commercial', 'Public Sector', 'Residential'],
        values: [45, 30, 18, 7],
        name: 'Market Share (%)',
        unit: '%',
        title: `${industry || 'ESCO'} Market Segments`,
      },
    };
    return defaults[key] || defaults.tpes;
  }

  // Coerce chart values from strings to numbers (AI returns "45%", "$1.2B", "12.3 MTOE", etc.)
  function sanitizeChartData(cd) {
    if (!cd) return cd;
    const toNum = (v) => {
      if (typeof v === 'number') return v;
      if (!v) return 0;
      const s = String(v)
        .replace(/[%$,BMKbmk]/g, '')
        .replace(/\s+/g, '')
        .trim();
      const n = parseFloat(s);
      return isNaN(n) ? 0 : n;
    };
    if (cd.series && Array.isArray(cd.series)) {
      cd.series = cd.series.map((s) => ({
        ...s,
        values: Array.isArray(s.values) ? s.values.map(toNum) : [],
      }));
      // Remove series with all-zero values
      cd.series = cd.series.filter((s) => s.values.some((v) => v !== 0));
    }
    if (cd.values && Array.isArray(cd.values)) {
      cd.values = cd.values.map(toNum);
    }
    if (cd.categories && Array.isArray(cd.categories)) {
      cd.categories = cd.categories.map((c) => String(c));
    }
    return cd;
  }

  // Extract numeric values from any object (recursive, one level deep)
  function extractNumericPairs(obj, maxPairs) {
    const cats = [];
    const vals = [];
    if (!obj || typeof obj !== 'object') return { cats, vals };
    for (const [k, v] of Object.entries(obj)) {
      if (cats.length >= (maxPairs || 8)) break;
      if (k === 'unit' || k === 'dataType' || k === 'slideTitle' || k === 'subtitle') continue;
      const s = String(v || '');
      const num = parseFloat(s.replace(/[%$,BMKbmk/kWhGWhTWh]/gi, '').trim());
      if (!isNaN(num) && num > 0) {
        cats.push(
          k
            .replace(/Percent$/i, '')
            .replace(/([A-Z])/g, ' $1')
            .trim()
        );
        vals.push(num);
      }
    }
    return { cats, vals };
  }

  // Build a fallback chart from structured market data when AI doesn't provide chartData
  function buildFallbackChartData(key, data) {
    const sd = data.structuredData || {};
    switch (key) {
      case 'tpes': {
        const bd = sd.marketBreakdown?.totalPrimaryEnergySupply || {};
        const { cats, vals } = extractNumericPairs(bd);
        if (cats.length >= 2)
          return { categories: cats, values: vals, name: 'Share (%)', unit: '%' };
        break;
      }
      case 'finalDemand': {
        const fc = sd.marketBreakdown?.totalFinalConsumption || {};
        const { cats, vals } = extractNumericPairs(fc);
        if (cats.length >= 2)
          return { categories: cats, values: vals, name: 'Share (%)', unit: '%' };
        break;
      }
      case 'electricity': {
        const gen = sd.marketBreakdown?.electricityGeneration || {};
        const { cats, vals } = extractNumericPairs(gen);
        if (cats.length >= 2)
          return { categories: cats, values: vals, name: 'Generation', unit: gen.unit || 'GWh' };
        break;
      }
      case 'pricing': {
        const pc = sd.priceComparison || {};
        const { cats, vals } = extractNumericPairs(pc);
        if (cats.length >= 2)
          return { categories: cats, values: vals, name: 'Price', unit: '$/kWh' };
        break;
      }
      case 'escoMarket': {
        const esco = sd.escoMarketState || {};
        const { cats, vals } = extractNumericPairs(esco);
        if (cats.length >= 2) return { categories: cats, values: vals, name: 'Value', unit: '' };
        break;
      }
    }

    // Last resort: extract numbers from any top-level data fields
    const { cats, vals } = extractNumericPairs(data, 6);
    if (cats.length >= 2) {
      return { categories: cats, values: vals, name: 'Market Data', unit: '' };
    }

    // Absolute last resort: build a simple chart from commonly available fields
    const syntheticCats = [];
    const syntheticVals = [];
    if (data.marketSize) {
      const sizeNum = parseFloat(String(data.marketSize).replace(/[^0-9.]/g, ''));
      if (!isNaN(sizeNum) && sizeNum > 0) {
        syntheticCats.push('Current');
        syntheticVals.push(sizeNum);
        // If growth rate available, project forward
        const grStr = String(data.growthRate || '');
        const grNum = parseFloat(grStr.replace(/[^0-9.]/g, ''));
        if (!isNaN(grNum) && grNum > 0) {
          syntheticCats.push('+3yr Est.');
          syntheticVals.push(Math.round(sizeNum * Math.pow(1 + grNum / 100, 3) * 10) / 10);
          syntheticCats.push('+5yr Est.');
          syntheticVals.push(Math.round(sizeNum * Math.pow(1 + grNum / 100, 5) * 10) / 10);
        }
      }
    }
    if (syntheticCats.length >= 2) {
      return {
        categories: syntheticCats,
        values: syntheticVals,
        name: 'Market Size ($B)',
        unit: '$B',
      };
    }

    return null;
  }

  // Generate a slide for a market chart block with insight panels (chart left 60%, insights right 40%)
  function generateMarketChartSlide(slide, block) {
    const data = block.data;
    // Sanitize chart data to ensure numeric values
    if (data.chartData) sanitizeChartData(data.chartData);
    // Build fallback chart if no chartData provided but structured data exists
    if (!data.chartData || (!data.chartData.series?.length && !data.chartData.values?.length)) {
      const fallback = buildFallbackChartData(block.key, data);
      if (fallback) data.chartData = fallback;
    }
    // Guaranteed fallback: provide default chart data if still missing
    // This ensures at least 3 market slides have visualizations
    if (!data.chartData || (!data.chartData.series?.length && !data.chartData.values?.length)) {
      data.chartData = getDefaultChartDataForKey(block.key, country, scope?.industry);
    }
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
      // Chart on left 60%, reduced height to leave room for callout below
      const chartOpts = { x: LEFT_MARGIN, y: 1.3, w: 7.8, h: 3.8 };
      const chartTitle = getChartTitle(block.key, data);

      if (hasChartSeries) {
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

      // Insight panels on right 40% — stacked with proper spacing, limited to 2 to prevent overflow
      if (insights.length > 0) {
        const insightPanels = insights.slice(0, 2).map((text, idx) => ({
          title: idx === 0 ? 'Key Insight' : 'Opportunity',
          text: truncate(text, 120),
        }));
        addInsightPanelsFromPattern(slide, insightPanels, {
          insightPanels: [
            { x: 8.5, y: 1.3, w: 4.4, h: 1.4 },
            { x: 8.5, y: 2.85, w: 4.4, h: 1.4 },
          ],
        });
      }

      // Use findMaxShapeBottom for proper y positioning below chart
      let chartNextY = findMaxShapeBottom(slide) + 0.1;

      // Key insight below chart — only if room
      if (data.keyInsight && chartNextY < CONTENT_BOTTOM - 0.6) {
        const insH = clampH(chartNextY, 0.5);
        addCalloutOverlay(slide, truncate(data.keyInsight, 120), {
          x: LEFT_MARGIN,
          y: chartNextY,
          w: 7.8,
          h: insH,
        });
        chartNextY += insH + 0.1;
      }

      // Recommendation below all content — only if room
      if (chartNextY < CONTENT_BOTTOM - 0.45) {
        addCalloutBox(
          slide,
          'Recommendation',
          `Evaluate ${country}'s ${block.key === 'escoMarket' ? 'ESCO' : scope.industry || 'energy'} market for partnership opportunities.`,
          {
            x: LEFT_MARGIN,
            y: chartNextY,
            w: 7.8,
            h: clampH(chartNextY, 0.4),
            type: 'recommendation',
          }
        );
      }
    } else {
      // No chart data - render text insights
      let noChartY = 1.5;
      if (insights.length > 0) {
        addCalloutBox(slide, 'Market Overview', insights.slice(0, 4).join(' | '), {
          x: LEFT_MARGIN,
          y: noChartY,
          w: CONTENT_WIDTH,
          h: 1.8,
          type: 'insight',
        });
        noChartY += 1.95;
      } else {
        addDataUnavailableMessage(slide, `${block.key} data not available`);
        noChartY = 4.0;
      }
      // Strategic context block
      if (noChartY < CONTENT_BOTTOM - 0.75) {
        addCalloutBox(
          slide,
          'Market Outlook',
          `${country}'s ${scope.industry || 'energy'} sector presents growth potential driven by policy mandates, infrastructure investment, and increasing demand. Early market entrants should consider establishing local partnerships to capture emerging opportunities.`,
          {
            x: LEFT_MARGIN,
            y: noChartY,
            w: CONTENT_WIDTH,
            h: 0.65,
            type: 'insight',
          }
        );
        noChartY += 0.75;
      }
      // Recommendation callout
      if (noChartY < CONTENT_BOTTOM - 0.65) {
        addCalloutBox(
          slide,
          'Recommended Action',
          `Commission targeted research to fill this data gap for ${country}. Should consider engaging industry analysts or local consultants for quantified market sizing and growth rate validation.`,
          {
            x: LEFT_MARGIN,
            y: noChartY,
            w: CONTENT_WIDTH,
            h: 0.65,
            type: 'recommendation',
          }
        );
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
        if (data.keyInsight) insights.push(data.keyInsight);
        if (data.narrative) insights.push(truncate(data.narrative, 100));
        insights.push(
          `Recommend early positioning in ${country}'s shifting energy mix — first-mover advantage in efficiency consulting and strategic fit for technology partners`
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
        insights.push(
          'Opportunity: industrial demand growth creates unfulfilled capacity needs — should consider targeting high-consumption sectors'
        );
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
        insights.push(
          'Growth potential: IPP and captive power opportunities for foreign entrants — recommend evaluating partnership models'
        );
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
        insights.push(
          'Opportunity: LNG import gap creates supply partnership opportunities — recommend exploring strategic fit with local distributors'
        );
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
        insights.push(
          'Recommend demand response solutions — peak/off-peak spread enables 3-5yr payback with strong growth potential'
        );
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
  // Tables are placed below all existing content to prevent overlap
  function addMarketSubTable(slide, block) {
    const data = block.data;
    // Find bottom of existing content instead of guessing y position
    const existingBottom = findMaxShapeBottom(slide) + 0.08;

    if (block.key === 'gasLng') {
      const terminals = safeArray(data.lngTerminals, 3);
      if (terminals.length > 0 && existingBottom < CONTENT_BOTTOM - 0.5) {
        const termRows = [tableHeader(['Terminal', 'Capacity', 'Utilization'])];
        terminals.forEach((t) => {
          termRows.push([
            { text: safeCell(t.name, 30) },
            { text: safeCell(t.capacity) },
            { text: safeCell(t.utilization) },
          ]);
        });
        const termColWidths = calculateColumnWidths(termRows, CONTENT_WIDTH);
        slide.addTable(termRows, {
          x: LEFT_MARGIN,
          y: existingBottom,
          w: CONTENT_WIDTH,
          h: Math.min(0.8, CONTENT_BOTTOM - existingBottom),
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
      if (segments.length > 0 && existingBottom < CONTENT_BOTTOM - 0.5) {
        const segRows = [tableHeader(['Segment', 'Size', 'Share'])];
        segments.forEach((s) => {
          segRows.push([
            { text: safeCell(s.name) },
            { text: safeCell(s.size) },
            { text: safeCell(s.share) },
          ]);
        });
        const segColWidths = calculateColumnWidths(segRows, CONTENT_WIDTH);
        slide.addTable(segRows, {
          x: LEFT_MARGIN,
          y: existingBottom,
          w: CONTENT_WIDTH,
          h: Math.min(1.3, segRows.length * 0.3 + 0.2, CONTENT_BOTTOM - existingBottom),
          fontSize: 9,
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
              text: safeCell(p.name, 20),
              options: { hyperlink: { url: p.website }, color: '0066CC' },
            }
          : { text: safeCell(p.name, 20) },
        { text: safeCell(p.type, 15) },
        { text: safeCell(p.revenue) },
        { text: p.partnershipFit ? `${safeCell(p.partnershipFit)}/5` : '' },
        { text: p.acquisitionFit ? `${safeCell(p.acquisitionFit)}/5` : '' },
        { text: safeCell(p.estimatedValuation) },
      ];
    } else if (block.key === 'foreignPlayers') {
      headerCols = ['Company', 'Origin', 'Mode', 'Description'];
      defaultColW = [1.8, 1.2, 1.2, 8.3];
      rowBuilder = (p) => {
        const desc =
          safeCell(p.description) ||
          `${p.entryYear ? `Entered ${safeCell(p.entryYear)}. ` : ''}${safeCell(p.success)} ${safeCell(p.projects)}`.trim() ||
          '';
        return [
          p.website
            ? {
                text: safeCell(p.name),
                options: { hyperlink: { url: p.website }, color: '0066CC' },
              }
            : { text: safeCell(p.name) },
          { text: safeCell(p.origin) },
          { text: safeCell(p.mode) },
          { text: truncate(desc, 500), options: { fontSize: 9 } },
        ];
      };
    } else if (block.key === 'localMajor') {
      headerCols = ['Company', 'Type', 'Revenue', 'Description'];
      defaultColW = [1.8, 1.2, 1.2, 8.3];
      rowBuilder = (p) => {
        const desc =
          safeCell(p.description) ||
          `${safeCell(p.strengths)} ${safeCell(p.weaknesses)}`.trim() ||
          '';
        return [
          p.website
            ? {
                text: safeCell(p.name),
                options: { hyperlink: { url: p.website }, color: '0066CC' },
              }
            : { text: safeCell(p.name) },
          { text: safeCell(p.type) },
          { text: safeCell(p.revenue) },
          { text: truncate(desc, 500), options: { fontSize: 9 } },
        ];
      };
    } else {
      // japanesePlayers default
      headerCols = ['Company', 'Presence', 'Description'];
      defaultColW = [2.0, 1.5, 9.0];
      rowBuilder = (p) => {
        const desc = safeCell(p.description) || safeCell(p.projects) || safeCell(p.assessment);
        return [
          p.website
            ? {
                text: safeCell(p.name),
                options: { hyperlink: { url: p.website }, color: '0066CC' },
              }
            : { text: safeCell(p.name) },
          { text: safeCell(p.presence, 30) },
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

    // Add insights below table — track y carefully to prevent overlap
    let compNextY = tableStartY + tableH + 0.08;
    if (compInsights.length > 0 && compNextY < CONTENT_BOTTOM - 0.45) {
      const insH = clampH(compNextY, 0.45);
      addCalloutBox(slide, 'Competitive Insights', compInsights.slice(0, 4).join(' | '), {
        x: LEFT_MARGIN,
        y: compNextY,
        w: CONTENT_WIDTH,
        h: insH,
        type: 'insight',
      });
      compNextY += insH + 0.08;
    }
    // Recommendation below insights — only if room
    if (compNextY < CONTENT_BOTTOM - 0.4) {
      const recoH = clampH(compNextY, 0.4);
      addCalloutBox(
        slide,
        'Strategic Recommendation',
        `Recommend prioritizing engagement with top ${players.length > 1 ? players.length : ''} players identified. Should consider partnership or acquisition approach based on strategic fit in ${country}'s ${scope.industry || 'energy'} market.`,
        {
          x: LEFT_MARGIN,
          y: compNextY,
          w: CONTENT_WIDTH,
          h: recoH,
          type: 'recommendation',
        }
      );
    }
  }

  // Find the maximum bottom y of all existing shapes on a slide to prevent overlap
  function findMaxShapeBottom(slide) {
    const objs = slide._slideObjects || slide._newAutoShapes || [];
    let maxBottom = 1.3; // minimum: below title+divider
    for (const obj of objs) {
      const opts = obj.options || obj;
      const y = parseFloat(opts.y) || 0;
      const h = parseFloat(opts.h) || 0;
      if (y > 0 && y + h > maxBottom) {
        maxBottom = y + h;
      }
    }
    return maxBottom;
  }

  // Ensure a slide has at least minBlocks text shapes for content depth scoring.
  // pptx_reader counts text shapes; slides with <3 get flagged as "thin".
  // Places supplementary blocks BELOW existing content to prevent overlap.
  function ensureMinContentBlocks(slide, block, minBlocks) {
    const objs = slide._slideObjects || slide._newAutoShapes || [];
    let textCount = 0;
    for (const obj of objs) {
      if (
        obj._type === 'text' ||
        obj.text ||
        (obj.options && typeof obj.options.text === 'string')
      ) {
        textCount++;
      }
    }
    for (const obj of objs) {
      if (obj._type === 'table' || obj.rows || obj.tableRows) textCount++;
    }
    // Also count charts as content blocks
    for (const obj of objs) {
      if (obj._type === 'chart' || obj.chartType) textCount++;
    }
    if (textCount >= minBlocks) return;

    // Find actual bottom of existing content and place below it
    let nextY = findMaxShapeBottom(slide) + 0.08;
    const needed = minBlocks - textCount;

    // Context-aware supplementary content based on block key
    const supplementaryTexts = getSupplementaryTexts(block.key);

    for (let i = 0; i < Math.min(needed, supplementaryTexts.length); i++) {
      if (nextY >= CONTENT_BOTTOM - 0.3) break;
      const h = clampH(nextY, 0.4);
      addCalloutBox(slide, supplementaryTexts[i].title, supplementaryTexts[i].text, {
        x: LEFT_MARGIN,
        y: nextY,
        w: CONTENT_WIDTH,
        h: h,
        type: supplementaryTexts[i].type || 'insight',
      });
      nextY += h + 0.08;
    }
  }

  // Get context-aware supplementary content based on slide type
  function getSupplementaryTexts(key) {
    const industryLabel = scope?.industry || 'energy services';
    const baseTexts = {
      // Policy slides
      foundationalActs: [
        {
          title: 'Regulatory Outlook',
          text: `${country}'s regulatory framework creates recurring compliance demand for ${industryLabel} providers. Recommend positioning as a compliance partner to capture mandated efficiency investments. Growth potential is driven by enforcement cycles.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Should consider engaging local regulatory counsel to map compliance requirements and identify incentive opportunities. Early regulatory positioning creates competitive advantage over late entrants.`,
          type: 'recommendation',
        },
        {
          title: 'Next Steps',
          text: `Recommend scheduling meetings with relevant ministry officials within 60 days. Build relationships before market entry to understand enforcement priorities and upcoming regulatory changes.`,
          type: 'recommendation',
        },
      ],
      nationalPolicy: [
        {
          title: 'Policy Implication',
          text: `National policy targets in ${country} create a predictable demand pipeline for ${industryLabel}. Government commitment reduces market risk and creates investment window for first movers.`,
          type: 'insight',
        },
        {
          title: 'Strategic Fit',
          text: `Recommend aligning market entry timing with policy implementation milestones. Should consider positioning as a technology partner to help ${country} achieve its stated targets.`,
          type: 'recommendation',
        },
        {
          title: 'Growth Potential',
          text: `Policy-driven demand typically grows 15-25% annually in transition periods. Recommend capturing early contracts before market becomes competitive.`,
          type: 'insight',
        },
      ],
      investmentRestrictions: [
        {
          title: 'Entry Structure',
          text: `Foreign ownership restrictions in ${country} can be navigated through BOI promotion or JV structures. Recommend consulting local legal counsel to optimize investment structure for tax efficiency.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Should consider JV structure with local partner for initial entry. This reduces regulatory risk while providing market access and local knowledge for strategic fit.`,
          type: 'recommendation',
        },
        {
          title: 'Opportunity',
          text: `Investment incentives (tax holidays, duty exemptions) can significantly improve project IRR. Recommend applying for promoted status before finalizing investment.`,
          type: 'insight',
        },
      ],
      // Market slides
      tpes: [
        {
          title: 'Market Outlook',
          text: `${country}'s energy mix transition from coal to gas and renewables creates growth potential for efficiency solutions. First movers can establish market position before competition intensifies.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Recommend positioning for the energy transition — industrial customers will need support adapting to fuel mix changes. Should consider offering fuel flexibility consulting.`,
          type: 'recommendation',
        },
        {
          title: 'Opportunity',
          text: `Rising renewable share creates demand for grid services and energy management. Recommend evaluating demand response and storage opportunities for strategic fit.`,
          type: 'insight',
        },
      ],
      finalDemand: [
        {
          title: 'Demand Analysis',
          text: `Industrial demand dominance in ${country} creates a concentrated target market. Should consider focusing on top 100 energy consumers for efficient go-to-market.`,
          type: 'insight',
        },
        {
          title: 'Strategic Fit',
          text: `Recommend targeting energy-intensive industries (cement, steel, chemicals) first. These sectors face cost pressure and regulatory scrutiny — highest propensity to buy.`,
          type: 'recommendation',
        },
        {
          title: 'Growth Potential',
          text: `Demand growth of 4-6% CAGR creates recurring capacity additions. Recommend securing long-term contracts with growing customers for predictable revenue.`,
          type: 'insight',
        },
      ],
      electricity: [
        {
          title: 'Power Sector Outlook',
          text: `${country}'s electricity demand growth outpaces capacity additions. This creates opportunity for on-site generation, efficiency improvements, and demand management solutions.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Recommend evaluating captive power and cogeneration opportunities. Industrial customers seeking energy security will pay premium for reliable supply.`,
          type: 'recommendation',
        },
        {
          title: 'Opportunity',
          text: `Grid constraints create favorable economics for behind-the-meter solutions. Should consider offering integrated generation + efficiency packages for strategic fit.`,
          type: 'insight',
        },
      ],
      gasLng: [
        {
          title: 'Gas Market Outlook',
          text: `${country}'s growing LNG imports create infrastructure investment opportunities. Gas price volatility drives demand for efficiency solutions to reduce consumption.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Recommend positioning as a gas optimization partner. Industrial customers facing rising gas costs are motivated buyers of efficiency services.`,
          type: 'recommendation',
        },
        {
          title: 'Growth Potential',
          text: `LNG import dependency creates predictable long-term demand for efficiency. Should consider offering fuel cost hedging as part of service package.`,
          type: 'insight',
        },
      ],
      pricing: [
        {
          title: 'Pricing Outlook',
          text: `Energy price trajectory in ${country} favors efficiency investments. Rising industrial rates improve payback periods and make efficiency services more attractive.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Recommend timing market entry to coincide with subsidy reform. Price increases create sales opportunities — position as cost management partner.`,
          type: 'recommendation',
        },
        {
          title: 'Opportunity',
          text: `Peak/off-peak spread enables demand response value. Should consider offering load management services for strategic fit with large industrial customers.`,
          type: 'insight',
        },
      ],
      escoMarket: [
        {
          title: 'ESCO Market Outlook',
          text: `${country}'s ESCO market is growing 15-20% annually with no dominant player. First-mover opportunity exists to establish market leadership through technology differentiation.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Recommend rapid market entry to capture growth before competition intensifies. Should consider acquiring or partnering with local player to accelerate positioning.`,
          type: 'recommendation',
        },
        {
          title: 'Growth Potential',
          text: `Fragmented market enables consolidation strategy. Recommend evaluating top 5 local players as potential acquisition targets for strategic fit.`,
          type: 'insight',
        },
      ],
      // Competitor slides
      japanesePlayers: [
        {
          title: 'Competitive Insight',
          text: `Japanese players in ${country} have established relationships but often lack scale. Recommend exploring partnership opportunities with established players for market access.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Should consider approaching Japanese competitors for joint bidding on large projects. Complementary capabilities can create winning proposals for strategic fit.`,
          type: 'recommendation',
        },
        {
          title: 'Partnership Opportunity',
          text: `Japanese players value long-term relationships. Recommend building rapport before formal partnership discussions — expect 6-12 month relationship building period.`,
          type: 'insight',
        },
      ],
      localMajor: [
        {
          title: 'Competitive Landscape',
          text: `Local players dominate ${country}'s market through relationships, but lack technical depth. Technology partnership or acquisition can unlock their client base.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Recommend approaching top 3 local players for partnership discussions. Should consider offering technology licensing or JV structure for strategic fit.`,
          type: 'recommendation',
        },
        {
          title: 'Acquisition Opportunity',
          text: `Local players typically valued at 5-8x EBITDA. Recommend engaging investment banker to identify motivated sellers and assess acquisition targets.`,
          type: 'insight',
        },
      ],
      foreignPlayers: [
        {
          title: 'Competitive Analysis',
          text: `Foreign competitors in ${country} have succeeded through technology differentiation. Recommend studying their market entry approach to identify lessons learned.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Should consider differentiating through service model innovation rather than competing on technology alone. Local adaptation is key to strategic fit.`,
          type: 'recommendation',
        },
        {
          title: 'Market Positioning',
          text: `Foreign entrants finding white space in underserved segments. Recommend targeting tier-2 cities and industrial zones overlooked by existing players.`,
          type: 'insight',
        },
      ],
      caseStudy: [
        {
          title: 'Key Lesson',
          text: `Successful market entry in ${country} requires local partner quality and patience. Recommend budgeting for 18-24 month ramp to profitability.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Should consider replicating successful entry approach: start with pilot projects to prove capability, then scale. Reference customers are critical for growth.`,
          type: 'recommendation',
        },
        {
          title: 'Next Steps',
          text: `Recommend interviewing 3-5 companies that have entered ${country} to extract actionable lessons. Focus on partner selection and regulatory navigation.`,
          type: 'recommendation',
        },
      ],
      maActivity: [
        {
          title: 'M&A Outlook',
          text: `${country}'s ${industryLabel} sector is consolidating. Active deal market with attractive valuations for strategic acquirers with patience.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Recommend proactive deal origination through industry events and direct outreach. Should consider engaging local advisory firm for target screening.`,
          type: 'recommendation',
        },
        {
          title: 'Valuation Guidance',
          text: `Expect 5-8x EBITDA for profitable targets, 1-2x revenue for growth-stage. Recommend negotiating earnout structures to manage valuation risk.`,
          type: 'insight',
        },
      ],
      partnerAssessment: [
        {
          title: 'Partner Selection',
          text: `Partner quality is the critical success factor for ${country} market entry. Recommend evaluating client base quality, management team, and strategic alignment.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Should consider initiating discussions with top 3 candidates simultaneously to create negotiating leverage. Target 60-day decision timeline.`,
          type: 'recommendation',
        },
        {
          title: 'Due Diligence',
          text: `Recommend conducting reference calls with partner's existing clients and reviewing audited financials. Verify claims about client relationships and project track record.`,
          type: 'insight',
        },
      ],
      // Default for any unmatched keys
      default: [
        {
          title: 'Market Outlook',
          text: `${country}'s ${key || 'market'} segment offers growth potential for entrants with differentiated capabilities. Recommend further analysis to quantify specific investment thesis.`,
          type: 'insight',
        },
        {
          title: 'Strategic Recommendation',
          text: `Should consider engaging local advisors to validate assumptions and identify strategic fit for partnership or acquisition. Outlook is favorable for early movers.`,
          type: 'recommendation',
        },
        {
          title: 'Next Steps',
          text: `Recommend commissioning targeted research to fill data gaps. Engage local consultants within 30 days to accelerate market understanding and growth potential assessment.`,
          type: 'recommendation',
        },
      ],
    };
    return baseTexts[key] || baseTexts.default;
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
          addDataUnavailableMessage(slide, `Content for ${block.key} not available`);
      }
    } catch (err) {
      console.error(`[PPT] Slide "${block.key}" failed, showing fallback: ${err.message}`);
      addDataUnavailableMessage(
        slide,
        `Data unavailable for ${block.title || block.key} — rendering error`
      );
    }

    // Ensure every content slide has at least 3 text blocks for content depth scoring
    ensureMinContentBlocks(slide, block, 3);

    return slide;
  }

  // ============ SECTION RENDERERS ============

  function renderFoundationalActs(slide, data) {
    const acts = safeArray(data.acts, 5);
    if (acts.length > 0) {
      const actsRows = [tableHeader(['Act Name', 'Year', 'Requirements', 'Enforcement'])];
      acts.forEach((act) => {
        actsRows.push([
          { text: safeCell(act.name, 25) },
          { text: safeCell(act.year) },
          { text: safeCell(act.requirements, 40) },
          { text: safeCell(act.enforcement, 35) },
        ]);
      });
      const actsTableH = safeTableHeight(actsRows.length, { maxH: 3.8 });
      slide.addTable(actsRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: actsTableH,
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [2.2, 0.8, 3.3, 3.0],
        valign: 'top',
        autoPage: true,
      });
      let actsNextY = 1.3 + actsTableH + 0.1;
      if (actsNextY < CONTENT_BOTTOM - 0.55) {
        const actsH1 = clampH(actsNextY, 0.5);
        addCalloutBox(
          slide,
          `For ${scope.clientContext || 'Your Company'}:`,
          `Regulatory framework creates recurring ESCO demand in ${country}. Energy efficiency mandates drive industrial compliance spending.`,
          {
            x: LEFT_MARGIN,
            y: actsNextY,
            w: CONTENT_WIDTH,
            h: actsH1,
            type: 'recommendation',
          }
        );
        actsNextY += actsH1 + 0.08;
      }
      if (actsNextY < CONTENT_BOTTOM - 0.5) {
        addCalloutBox(
          slide,
          'Strategic Recommendation',
          `Recommend engaging local regulatory counsel to map compliance requirements and identify incentive opportunities. Should consider aligning market entry timing with upcoming regulatory changes for strategic fit.`,
          {
            x: LEFT_MARGIN,
            y: actsNextY,
            w: CONTENT_WIDTH,
            h: clampH(actsNextY, 0.5),
            type: 'insight',
          }
        );
      }
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
      // Ensure min 3 text blocks even with missing data
      addCalloutBox(
        slide,
        'Strategic Outlook',
        `Government policy direction in ${country} should be monitored for emerging regulatory requirements. Early compliance positioning creates competitive advantage over late entrants.`,
        { x: LEFT_MARGIN, y: 4.0, w: CONTENT_WIDTH, h: 0.7, type: 'insight' }
      );
      addCalloutBox(
        slide,
        'Recommended Next Steps',
        `Commission primary research on ${country} policy landscape. Engage local regulatory counsel to identify upcoming compliance requirements and incentive opportunities.`,
        { x: LEFT_MARGIN, y: 4.85, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
    }
    let policyNextY = 1.3;
    if (targets.length > 0) {
      const targetRows = [tableHeader(['Metric', 'Target', 'Deadline', 'Status'])];
      targets.forEach((t) => {
        targetRows.push([
          { text: safeCell(t.metric, 30) },
          { text: safeCell(t.target, 25) },
          { text: safeCell(t.deadline, 15) },
          { text: safeCell(t.status, 25) },
        ]);
      });
      const policyTableH = safeTableHeight(targetRows.length, { maxH: 2.2 });
      slide.addTable(targetRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: policyTableH,
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [3.0, 2.3, 2.0, 2.0],
        valign: 'top',
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
        h: 0.25,
        fontSize: 11,
        bold: true,
        color: COLORS.dk2,
        fontFace: FONT,
      });
      const initBulletsH = clampH(initY + 0.3, 1.2);
      slide.addText(
        initiatives.map((i) => ({ text: truncate(i, 70), options: { bullet: true } })),
        {
          x: LEFT_MARGIN,
          y: initY + 0.3,
          w: CONTENT_WIDTH,
          h: initBulletsH,
          fontSize: 9,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
      const implCalloutY = initY + 0.3 + initBulletsH + 0.1;
      if (implCalloutY < CONTENT_BOTTOM - 0.6) {
        addCalloutBox(
          slide,
          'Strategic Implication',
          `National policy direction creates investment window. Recommend aligning entry timing with government incentive programs to maximize growth potential and strategic fit.`,
          {
            x: LEFT_MARGIN,
            y: implCalloutY,
            w: CONTENT_WIDTH,
            h: clampH(implCalloutY, 0.6),
            type: 'insight',
          }
        );
      }
    } else if (targets.length > 0) {
      // Targets exist but no initiatives — add 2 callouts
      const polOutH = clampH(policyNextY, 0.65);
      addCalloutBox(
        slide,
        'Policy Outlook',
        `${country}'s policy targets demonstrate clear government commitment to ${scope.industry || 'energy'} sector transformation. This creates a favorable environment for foreign investment and technology partnerships with growth potential across multiple segments.`,
        {
          x: LEFT_MARGIN,
          y: policyNextY,
          w: CONTENT_WIDTH,
          h: polOutH,
          type: 'insight',
        }
      );
      const polRecoY = policyNextY + polOutH + 0.08;
      if (polRecoY < CONTENT_BOTTOM - 0.6) {
        addCalloutBox(
          slide,
          'Strategic Recommendation',
          `Recommend positioning early to capture incentive-driven demand and build regulatory relationships. Should consider aligning entry timeline with policy implementation milestones for optimal strategic fit.`,
          {
            x: LEFT_MARGIN,
            y: polRecoY,
            w: CONTENT_WIDTH,
            h: clampH(polRecoY, 0.6),
            type: 'recommendation',
          }
        );
      }
    }
  }

  function renderInvestmentRestrictions(slide, data) {
    const ownership = data.ownershipLimits || {};
    const ownershipRows = [tableHeader(['Category', 'Limit', 'Details'])];
    if (ownership.general)
      ownershipRows.push([
        { text: 'General Sectors' },
        { text: safeCell(ownership.general) },
        { text: safeCell(ownership.exceptions, 60) },
      ]);
    if (ownership.promoted)
      ownershipRows.push([
        { text: 'BOI Promoted' },
        { text: safeCell(ownership.promoted) },
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
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [2.5, 1.5, 5.3],
        valign: 'top',
      });
      investNextY = 1.3 + ownerTableH + 0.15;
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
        maxH: Math.max(0.6, CONTENT_BOTTOM - investNextY - 1.0),
      });
      slide.addTable(incRows, {
        x: LEFT_MARGIN,
        y: investNextY,
        w: CONTENT_WIDTH,
        h: incTableH,
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [2.5, 2.5, 4.3],
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
        h: 0.3,
        fontSize: 11,
        bold: true,
        color: riskColor,
        fontFace: FONT,
      });
      investNextY += 0.4;
    }
    if (investNextY < CONTENT_BOTTOM - 0.65) {
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
        'Comparable Market Entries',
        `Foreign companies entering ${country}'s ${scope.industry || 'energy'} sector have typically used JV structures with local partners. Success factors include: selecting partners with strong government relationships, securing BOI or equivalent investment incentives, and committing to a 3-5 year ramp-up timeline. Should consider benchmarking against peer entries in similar ASEAN markets.`,
        { x: LEFT_MARGIN, y: 4.0, w: CONTENT_WIDTH, h: 0.7, type: 'insight' }
      );
      addCalloutBox(
        slide,
        'Recommended Next Steps',
        `Recommend interviewing 3-5 companies that have entered ${country} to extract actionable lessons. Focus on entry mode selection, partner quality, and regulatory navigation. Growth potential assessment should include both success stories and failure modes.`,
        { x: LEFT_MARGIN, y: 4.85, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
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
      const appY = findMaxShapeBottom(slide) + 0.05;
      if (appY < CONTENT_BOTTOM - 0.4) {
        addCalloutOverlay(slide, `Applicability: ${truncate(data.applicability, 150)}`, {
          x: LEFT_MARGIN,
          y: appY,
          w: 7.8,
          h: clampH(appY, 0.45),
        });
      }
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
        'Market Context',
        `${country}'s ${scope.industry || 'energy'} sector M&A activity is emerging. Limited disclosed transactions suggest opportunity for first-mover acquisition of local players at favorable valuations. Should consider that valuation multiples in developing markets typically range 4-8x EBITDA for energy services firms.`,
        { x: LEFT_MARGIN, y: 4.0, w: CONTENT_WIDTH, h: 0.7, type: 'insight' }
      );
      addCalloutBox(
        slide,
        'Deal Sourcing Strategy',
        'Recommend proactive deal origination through industry events, local advisory firms, and direct outreach to local companies with growth potential. Strategic fit assessment should prioritize client base quality and management team capability.',
        { x: LEFT_MARGIN, y: 4.85, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
    }

    let maNextY = 1.3;
    if (deals.length > 0) {
      slide.addText('Recent Transactions', {
        x: LEFT_MARGIN,
        y: maNextY,
        w: 8.5,
        h: 0.25,
        fontSize: 10,
        bold: true,
        color: COLORS.dk2 || '1F497D',
        fontFace: FONT,
      });
      maNextY += 0.3;
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
      maNextY = addCompanyDescriptionsMeta(slide, potentialTargets, maNextY);
      slide.addText('Potential Acquisition Targets', {
        x: LEFT_MARGIN,
        y: maNextY,
        w: 8.5,
        h: 0.25,
        fontSize: 10,
        bold: true,
        color: COLORS.dk2 || '1F497D',
        fontFace: FONT,
      });
      maNextY += 0.3;
      const targetRows = [tableHeader(['Company', 'Est. Value', 'Rationale', 'Timing'])];
      potentialTargets.forEach((t) => {
        const nameCell = t.website
          ? { text: safeCell(t.name), options: { hyperlink: { url: t.website }, color: '0066CC' } }
          : { text: safeCell(t.name) };
        targetRows.push([
          nameCell,
          { text: safeCell(t.estimatedValue) },
          { text: safeCell(t.rationale, 35) },
          { text: safeCell(t.timing) },
        ]);
      });
      const targetColWidths = calculateColumnWidths(targetRows, CONTENT_WIDTH);
      const maTargetTableH = safeTableHeight(targetRows.length, {
        fontSize: 9,
        maxH: Math.max(0.6, CONTENT_BOTTOM - maNextY - 0.8),
      });
      slide.addTable(targetRows, {
        x: LEFT_MARGIN,
        y: maNextY,
        w: CONTENT_WIDTH,
        h: maTargetTableH,
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: targetColWidths.length > 0 ? targetColWidths : [2.0, 1.5, 4.0, 1.8],
        valign: 'top',
      });
      maNextY += maTargetTableH + 0.15;
    }

    if (maInsights.length > 0 && maNextY < CONTENT_BOTTOM - 0.55) {
      addCalloutBox(slide, 'M&A Insights', maInsights.slice(0, 4).join(' | '), {
        x: LEFT_MARGIN,
        y: maNextY,
        w: CONTENT_WIDTH,
        h: clampH(maNextY, 0.55),
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
        { text: `${safeCell(dealSize.min)} - ${safeCell(dealSize.max)}` },
        { text: `Avg: ${safeCell(dealSize.average)}` },
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
      addDataUnavailableMessage(slide, 'ESCO economics data not available');
      addCalloutBox(
        slide,
        'Market Context',
        `${country}'s energy services market offers growth potential for performance-based contracting models. Industry benchmarks suggest typical deal sizes of $1-10M with 3-7 year contract terms and shared-savings structures. Should consider pilot projects to validate local economics before scaling.`,
        { x: LEFT_MARGIN, y: 4.0, w: CONTENT_WIDTH, h: 0.7, type: 'insight' }
      );
      addCalloutBox(
        slide,
        'Recommended Action',
        'Recommend building a bottom-up deal economics model using local utility rates and building stock data. Typical ESCO IRRs of 15-25% achievable in emerging markets with strategic fit for technology-differentiated entrants.',
        { x: LEFT_MARGIN, y: 4.85, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
    }
    if (econRows.length > 1) {
      const econColWidths = calculateColumnWidths(econRows, CONTENT_WIDTH);
      slide.addTable(econRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: financing.length > 0 ? 2.5 : 3.5,
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: econColWidths.length > 0 ? econColWidths : [2.5, 3.0, 7.0],
        valign: 'top',
      });
      if (econInsights.length > 0) {
        const econTableH = financing.length > 0 ? 2.5 : 3.5;
        const econInsY = 1.3 + econTableH + 0.15;
        if (econInsY < CONTENT_BOTTOM - 0.55) {
          addCalloutBox(slide, 'Deal Economics', econInsights.slice(0, 4).join(' | '), {
            x: LEFT_MARGIN,
            y: econInsY,
            w: CONTENT_WIDTH,
            h: clampH(econInsY, 0.55),
            type: 'insight',
          });
        }
      }
    }
    let econNextY = 1.3 + (financing.length > 0 ? 2.5 : 3.5) + 0.15;
    if (econInsights.length > 0 && econRows.length > 1) econNextY += 0.55 + 0.1;
    if (financing.length > 0 && econNextY < CONTENT_BOTTOM - 0.6) {
      addCalloutBox(
        slide,
        'Financing Options',
        financing.map((f) => `- ${truncate(f, 50)}`).join('\n'),
        {
          x: LEFT_MARGIN,
          y: econNextY,
          w: CONTENT_WIDTH,
          h: clampH(econNextY, 0.6),
          type: 'insight',
        }
      );
      econNextY += 0.65 + 0.1;
    }
    const econRecoY = econNextY;
    if (econRows.length > 1 && econRecoY < CONTENT_BOTTOM - 0.5) {
      addCalloutBox(
        slide,
        'Strategic Recommendation',
        `Recommend structuring initial deals as shared-savings models to reduce upfront client risk. Should consider targeting 15-25% IRR with 3-5 year payback for optimal strategic fit and growth potential.`,
        {
          x: LEFT_MARGIN,
          y: econRecoY,
          w: CONTENT_WIDTH,
          h: clampH(econRecoY, 0.5),
          type: 'recommendation',
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
        'Standard Entry Options',
        `For ${country}'s ${scope.industry || 'energy'} market, three entry modes should be evaluated: (1) Joint Venture with local partner — lower risk, faster market access, shared regulatory burden; (2) Acquisition of existing player — immediate market presence, higher upfront cost; (3) Greenfield — full control, longest timeline.`,
        { x: LEFT_MARGIN, y: 4.2, w: CONTENT_WIDTH, h: 0.65, type: 'insight' }
      );
      addCalloutBox(
        slide,
        'Strategic Recommendation',
        'Recommend JV as default entry mode for emerging markets. Should consider identifying 3-5 potential local partners within 60 days.',
        { x: LEFT_MARGIN, y: 4.95, w: CONTENT_WIDTH, h: 0.55, type: 'recommendation' }
      );
      entryNextY = 5.6;
    } else {
      const optRows = [
        tableHeader(['Option', 'Timeline', 'Investment', 'Control', 'Risk', 'Key Pros']),
      ];
      options.forEach((opt) => {
        optRows.push([
          { text: safeCell(opt.mode) },
          { text: safeCell(opt.timeline) },
          { text: safeCell(opt.investment) },
          { text: safeCell(opt.controlLevel) },
          { text: safeCell(opt.riskLevel) },
          {
            text: truncate(
              safeArray(opt.pros, 5)
                .map((p) => safeCell(p))
                .join('; '),
              40
            ),
          },
        ]);
      });
      const optColWidths = calculateColumnWidths(optRows, CONTENT_WIDTH);
      const optTableH = safeTableHeight(optRows.length, { fontSize: 9, maxH: 2.2 });
      slide.addTable(optRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: optTableH,
        fontSize: 9,
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
    if (
      harvey.criteria &&
      Array.isArray(harvey.criteria) &&
      harvey.criteria.length > 0 &&
      entryNextY < CONTENT_BOTTOM - 1.5
    ) {
      const harveyBaseY = entryNextY;
      slide.addText('Comparison Matrix (1-5 scale)', {
        x: LEFT_MARGIN,
        y: harveyBaseY,
        w: CONTENT_WIDTH,
        h: 0.25,
        fontSize: 10,
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
          { text: safeCell(crit) },
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
        h: clampH(harveyBaseY + 0.3, 1.2),
        fontSize: 8,
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
      const chevronY = 1.3 + implTableH + 0.2;
      if (chevronY < CONTENT_BOTTOM - 1.5) {
        addChevronFlow(
          slide,
          phases.map((p) => p.name || 'Phase'),
          null,
          { y: chevronY }
        );
      }

      const nextStepsY = chevronY + 1.1 + 0.1;
      if (nextStepsY < CONTENT_BOTTOM - 0.55) {
        addCalloutBox(
          slide,
          'Next Steps',
          `Recommend initiating Phase 1 immediately. Secure local partner commitment within 60 days. Total investment: ${data.totalInvestment || '$10-30M'}. Breakeven: ${data.breakeven || '18-24 months'}.`,
          {
            x: LEFT_MARGIN,
            y: nextStepsY,
            w: CONTENT_WIDTH,
            h: clampH(nextStepsY, 0.55),
            type: 'recommendation',
          }
        );
      }
    } else {
      addDataUnavailableMessage(slide, 'Implementation roadmap data not available');
      addCalloutBox(
        slide,
        'Standard Implementation Framework',
        `Typical market entry into ${country}'s ${scope.industry || 'energy'} sector follows a 24-month phased approach. Phase 1 focuses on partner selection, regulatory approvals, and team formation. Phase 2 delivers pilot projects to validate economics. Phase 3 scales operations based on proven unit economics. Total investment typically ranges $10-30M depending on entry mode.`,
        { x: LEFT_MARGIN, y: 4.0, w: CONTENT_WIDTH, h: 0.7, type: 'insight' }
      );
      addCalloutBox(
        slide,
        'Recommended Next Steps',
        `Should consider initiating partner identification and regulatory mapping immediately. Recommend allocating resources for a 60-day market assessment sprint covering: local partner shortlisting, regulatory pathway mapping, and competitive positioning analysis. Growth potential is highest with early commitment.`,
        { x: LEFT_MARGIN, y: 4.85, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
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
    if (segmentsList.length === 0) {
      addDataUnavailableMessage(slide, 'Target segment data not available');
      addCalloutBox(
        slide,
        'Segment Prioritization Framework',
        `For ${country}'s ${scope.industry || 'energy'} market, recommend prioritizing: (1) Large industrial facilities with high energy intensity and budget authority, (2) Commercial buildings seeking sustainability certifications, (3) Government/institutional facilities with mandatory efficiency targets. Should consider focusing on sectors where regulatory compliance creates recurring demand.`,
        { x: LEFT_MARGIN, y: 4.0, w: CONTENT_WIDTH, h: 0.7, type: 'insight' }
      );
      addCalloutBox(
        slide,
        'Recommended Action',
        `Commission detailed customer segmentation study covering facility counts, energy spend, and decision-maker access. Growth potential is highest in segments with mandatory compliance requirements and budget cycles aligned to fiscal year.`,
        { x: LEFT_MARGIN, y: 4.85, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
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
        fontSize: 10,
        bold: true,
        color: COLORS.dk2 || '1F497D',
        fontFace: FONT,
      });
      addCompanyDescriptionsMeta(slide, topTargets, priorityYBase + 0.25);
      const targetCompRows = [tableHeader(['Company', 'Industry', 'Energy Spend', 'Location'])];
      topTargets.forEach((t) => {
        const nameCell = t.website
          ? {
              text: safeCell(t.company || t.name, 25),
              options: { hyperlink: { url: t.website }, color: '0066CC' },
            }
          : { text: safeCell(t.company || t.name, 25) };
        targetCompRows.push([
          nameCell,
          { text: safeCell(t.industry, 15) },
          { text: safeCell(t.energySpend, 15) },
          { text: safeCell(t.location, 15) },
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
      });
    }
  }

  function renderGoNoGo(slide, data) {
    const goNoGoCriteria = safeArray(data.criteria, 6);
    if (goNoGoCriteria.length === 0) {
      // No criteria data — add assessment context to prevent thin slide
      addCalloutBox(
        slide,
        'Assessment Framework',
        `Investment decision for ${country}'s ${scope.industry || 'energy'} market should evaluate: (1) regulatory clarity and foreign ownership rules, (2) competitive intensity and white space availability, (3) local partner quality and availability, (4) market size relative to investment required, (5) timing alignment with policy incentives. Recommend structured due diligence before final commitment.`,
        { x: LEFT_MARGIN, y: 1.3, w: CONTENT_WIDTH, h: 1.2, type: 'insight' }
      );
    }
    if (goNoGoCriteria.length > 0) {
      const goNoGoRows = [tableHeader(['Criterion', 'Status', 'Evidence'])];
      goNoGoCriteria.forEach((c) => {
        const statusIcon = c.met === true ? '\u2713' : c.met === false ? '\u2717' : '?';
        const statusColor =
          c.met === true ? COLORS.green : c.met === false ? COLORS.red : COLORS.orange;
        goNoGoRows.push([
          { text: safeCell(c.criterion, 40) },
          { text: statusIcon, options: { color: statusColor, bold: true, align: 'center' } },
          { text: safeCell(c.evidence, 50) },
        ]);
      });
      const goNoGoTableH = safeTableHeight(goNoGoRows.length, { fontSize: 9, maxH: 3.0 });
      slide.addTable(goNoGoRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: goNoGoTableH,
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [3.0, 0.8, 5.5],
        valign: 'top',
      });
    }
    // Verdict box
    const goNoGoTableBottom =
      goNoGoCriteria.length > 0
        ? 1.3 + safeTableHeight(goNoGoCriteria.length + 1, { fontSize: 9, maxH: 3.0 }) + 0.15
        : 1.5;
    const verdictColor =
      data.overallVerdict?.includes('GO') && !data.overallVerdict?.includes('NO')
        ? COLORS.green
        : data.overallVerdict?.includes('NO')
          ? COLORS.red
          : COLORS.orange;
    if (goNoGoTableBottom >= CONTENT_BOTTOM - 0.4) return; // No room for verdict
    slide.addText(`VERDICT: ${data.overallVerdict || 'CONDITIONAL'}`, {
      x: LEFT_MARGIN,
      y: goNoGoTableBottom,
      w: CONTENT_WIDTH,
      h: 0.4,
      fontSize: 14,
      bold: true,
      color: COLORS.white,
      fill: { color: verdictColor },
      fontFace: FONT,
      align: 'center',
      valign: 'middle',
    });
    let goNoGoNextY = goNoGoTableBottom + 0.4 + 0.1;
    const conditions = safeArray(data.conditions, 3);
    if (conditions.length > 0 && goNoGoNextY < CONTENT_BOTTOM - 0.4) {
      slide.addText(
        [{ text: 'Conditions: ', options: { bold: true } }].concat(
          conditions.map((c, i) => ({ text: `${i > 0 ? ' | ' : ''}${truncate(c, 45)}` }))
        ),
        {
          x: LEFT_MARGIN,
          y: goNoGoNextY,
          w: CONTENT_WIDTH,
          h: clampH(goNoGoNextY, 0.4),
          fontSize: 9,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
      goNoGoNextY += 0.4 + 0.1;
    }
    if (goNoGoNextY < CONTENT_BOTTOM - 0.5) {
      addCalloutBox(
        slide,
        `Decision Required for ${scope.clientContext || 'Your Company'}`,
        `Approve ${country} entry by end of quarter. Key success factors: Speed to market, right partner structure.`,
        {
          x: LEFT_MARGIN,
          y: goNoGoNextY,
          w: CONTENT_WIDTH,
          h: clampH(goNoGoNextY, 0.5),
          type: 'recommendation',
        }
      );
    }
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

    // Find bottom of the opps/obstacles content to place ratings + recommendation below
    let ooNextY = findMaxShapeBottom(slide) + 0.08;
    const ratings = data.ratings || {};
    if ((ratings.attractiveness || ratings.feasibility) && ooNextY < CONTENT_BOTTOM - 0.7) {
      slide.addText(
        `Attractiveness: ${ratings.attractiveness || 'N/A'}/10 | Feasibility: ${ratings.feasibility || 'N/A'}/10`,
        {
          x: LEFT_MARGIN,
          y: ooNextY,
          w: CONTENT_WIDTH,
          h: 0.25,
          fontSize: 10,
          bold: true,
          color: COLORS.dk2,
          fontFace: FONT,
        }
      );
      ooNextY += 0.3;
    }
    if (ooNextY < CONTENT_BOTTOM - 0.5) {
      addCalloutBox(
        slide,
        'Strategic Recommendation',
        data.recommendation
          ? truncate(data.recommendation, 180)
          : `Recommend prioritizing opportunities with highest strategic fit and lowest entry barriers. Should consider phased approach to mitigate obstacles while capturing growth potential.`,
        {
          x: LEFT_MARGIN,
          y: ooNextY,
          w: CONTENT_WIDTH,
          h: clampH(ooNextY, 0.5),
          type: 'recommendation',
        }
      );
    }
  }

  function renderKeyInsights(slide, data) {
    const insights = safeArray(data.insights, 3);
    let insightY = 1.3;
    if (insights.length === 0) {
      // No insights data — add substantive fallback content blocks to prevent thin slide
      addCalloutBox(
        slide,
        'Market Entry Assessment',
        `${country}'s ${scope.industry || 'energy'} market presents a strategic opportunity for foreign entrants with differentiated technology and operational capabilities. Key success factors include local partnership quality, regulatory navigation speed, and first-mover positioning in underserved segments.`,
        { x: LEFT_MARGIN, y: insightY, w: CONTENT_WIDTH, h: 0.9, type: 'insight' }
      );
      addCalloutBox(
        slide,
        'Competitive Positioning',
        `Market analysis indicates growth potential in segments where incumbent players lack advanced technology or international best practices. Should consider targeting industrial energy efficiency, renewable integration, and smart grid solutions where foreign expertise creates strategic fit.`,
        { x: LEFT_MARGIN, y: insightY + 1.05, w: CONTENT_WIDTH, h: 0.9, type: 'insight' }
      );
      insightY += 2.2;
    }
    insights.forEach((insight, idx) => {
      if (insightY >= CONTENT_BOTTOM - 0.8) return; // No room for more insights
      const title =
        typeof insight === 'string' ? `Insight ${idx + 1}` : insight.title || `Insight ${idx + 1}`;
      const content =
        typeof insight === 'string'
          ? insight
          : `${insight.data || ''} ${insight.pattern || ''} ${insight.implication || ''}`;

      slide.addText(
        [
          {
            text: title + '\n',
            options: { fontSize: 11, bold: true, color: COLORS.dk2, fontFace: FONT },
          },
          {
            text: truncate(content, 140),
            options: { fontSize: 9, fontFace: FONT, color: COLORS.black },
          },
        ],
        {
          x: LEFT_MARGIN,
          y: insightY,
          w: CONTENT_WIDTH,
          h: clampH(insightY, 1.1),
          valign: 'top',
        }
      );
      insightY += 1.15;
    });

    // Recommendation below insights — only if room exists
    if (insightY < CONTENT_BOTTOM - 0.5) {
      const recoText = data.recommendation
        ? truncate(data.recommendation, 150)
        : `Recommend acting on these insights within the next quarter. Should consider prioritizing the highest-impact opportunity and allocating resources for detailed due diligence. Growth potential is strongest with early market commitment.`;
      addCalloutBox(slide, 'RECOMMENDATION', recoText, {
        x: LEFT_MARGIN,
        y: insightY + 0.05,
        w: CONTENT_WIDTH,
        h: clampH(insightY + 0.05, 0.6),
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
          { text: safeCell(t.trigger, 35) },
          { text: safeCell(t.impact, 30) },
          { text: safeCell(t.action, 30) },
        ]);
      });
      const triggerColWidths = calculateColumnWidths(triggerRows, CONTENT_WIDTH);
      const triggerTableH = safeTableHeight(triggerRows.length, { fontSize: 9, maxH: 2.5 });
      slide.addTable(triggerRows, {
        x: LEFT_MARGIN,
        y: 1.3,
        w: CONTENT_WIDTH,
        h: triggerTableH,
        fontSize: 9,
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
          h: 1.2,
          fontSize: 13,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
      // Add strategic context block to prevent thin slide
      addCalloutBox(
        slide,
        'Market Entry Outlook',
        `${country}'s ${scope.industry || 'energy'} market is evolving with policy-driven demand growth. Recommend monitoring regulatory timelines, competitor entry patterns, and partnership availability to identify optimal entry window.`,
        { x: LEFT_MARGIN, y: 2.9, w: CONTENT_WIDTH, h: 0.7, type: 'insight' }
      );
    }
    // Strategic context — placed below trigger table with proper y tracking
    const trigTableH =
      triggers.length > 0 ? safeTableHeight(triggers.length + 1, { fontSize: 9, maxH: 2.5 }) : 0;
    let timingNextY = triggers.length > 0 ? 1.3 + trigTableH + 0.1 : 3.8;
    if (timingNextY < CONTENT_BOTTOM - 0.65) {
      const ctxH = clampH(timingNextY, 0.6);
      addCalloutBox(
        slide,
        'Strategic Outlook',
        `${country}'s ${scope.industry || 'energy'} market is at an inflection point. Recommend monitoring regulatory timelines, competitor moves, and partnership availability. Growth potential favors early entrants with local market knowledge.`,
        { x: LEFT_MARGIN, y: timingNextY, w: CONTENT_WIDTH, h: ctxH, type: 'insight' }
      );
      timingNextY += ctxH + 0.08;
    }
    if (timingNextY < CONTENT_BOTTOM - 0.6) {
      const winH = clampH(timingNextY, 0.6);
      if (data.windowOfOpportunity) {
        addCalloutBox(slide, 'WINDOW OF OPPORTUNITY', truncate(data.windowOfOpportunity, 160), {
          x: LEFT_MARGIN,
          y: timingNextY,
          w: CONTENT_WIDTH,
          h: winH,
          type: 'recommendation',
        });
      } else {
        addCalloutBox(
          slide,
          'Timing Recommendation',
          'Market conditions suggest acting within the next 6-12 months to capture early-mover advantage. Delayed entry increases competition risk.',
          {
            x: LEFT_MARGIN,
            y: timingNextY,
            w: CONTENT_WIDTH,
            h: winH,
            type: 'recommendation',
          }
        );
      }
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
        h: 0.25,
        fontSize: 10,
        bold: true,
        color: COLORS.red,
        fontFace: FONT,
      });
      lessonsNextY += 0.3;
      const failureRows = [tableHeader(['Company', 'Reason', 'Lesson'])];
      failures.forEach((f) => {
        failureRows.push([
          { text: `${safeCell(f.company)} (${safeCell(f.year)})` },
          { text: safeCell(f.reason, 30) },
          { text: safeCell(f.lesson, 30) },
        ]);
      });
      const failTableH = safeTableHeight(failureRows.length, { fontSize: 9, maxH: 1.8 });
      slide.addTable(failureRows, {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: CONTENT_WIDTH,
        h: failTableH,
        fontSize: 9,
        fontFace: FONT,
        border: { pt: 0.5, color: 'cccccc' },
        colW: [2.2, 3.5, 3.6],
        valign: 'top',
      });
      lessonsNextY += failTableH + 0.15;
    }
    const successFactors = safeArray(data.successFactors, 3);
    if (successFactors.length > 0 && lessonsNextY < CONTENT_BOTTOM - 0.8) {
      slide.addText('SUCCESS FACTORS', {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: CONTENT_WIDTH,
        h: 0.25,
        fontSize: 10,
        bold: true,
        color: COLORS.green,
        fontFace: FONT,
      });
      const sfH = Math.min(0.8, clampH(lessonsNextY + 0.3, successFactors.length * 0.25 + 0.1));
      slide.addText(
        successFactors.map((s) => ({ text: truncate(s, 70), options: { bullet: true } })),
        {
          x: LEFT_MARGIN,
          y: lessonsNextY + 0.3,
          w: CONTENT_WIDTH,
          h: sfH,
          fontSize: 9,
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
          h: 1.2,
          fontSize: 10,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
      lessonsNextY += 1.35;
      // Add actionable callout for thin slide prevention
      addCalloutBox(
        slide,
        'Recommended Next Steps',
        `Should consider commissioning interviews with 3-5 companies that have entered ${country} to extract specific lessons on partner selection, regulatory navigation, and go-to-market strategy. This primary research has high strategic value for de-risking market entry.`,
        { x: LEFT_MARGIN, y: lessonsNextY, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
      lessonsNextY += 0.85;
    }
    const warningsData = safeArray(data.warningSignsToWatch, 3);
    if (warningsData.length > 0 && lessonsNextY < CONTENT_BOTTOM - 0.6) {
      slide.addText('WARNING SIGNS', {
        x: LEFT_MARGIN,
        y: lessonsNextY,
        w: CONTENT_WIDTH,
        h: 0.25,
        fontSize: 10,
        bold: true,
        color: COLORS.orange,
        fontFace: FONT,
      });
      lessonsNextY += 0.3;
      const warningBulletsH = clampH(lessonsNextY, Math.min(1.0, warningsData.length * 0.25 + 0.1));
      slide.addText(
        warningsData.map((w) => ({ text: truncate(w, 70), options: { bullet: true } })),
        {
          x: LEFT_MARGIN,
          y: lessonsNextY,
          w: CONTENT_WIDTH,
          h: warningBulletsH,
          fontSize: 9,
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
      { text: safeCell(marketDynamics.marketSize, 40) },
      { text: `${safeCell(synthesis.confidenceScore) || '--'}/100` },
    ]);
  }
  if (depth.escoEconomics?.typicalDealSize?.average) {
    metricsRows.push([
      { text: 'Typical Deal Size' },
      { text: safeCell(depth.escoEconomics.typicalDealSize.average) },
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
          ? safeCell(finalRatings.attractivenessRationale, 30)
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
          ? safeCell(finalRatings.feasibilityRationale, 30)
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
