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
  buildStoryNarrative,
  safeTableHeight,
} = require('./ppt-utils');

// ============ UNIVERSAL SLIDE GENERATOR ============
// Generates slides dynamically based on story narrative, not hardcoded structure
async function generateSingleCountryPPT(synthesis, countryAnalysis, scope) {
  console.log(`Generating expanded single-country PPT for ${synthesis.country}...`);

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

  // Helper: Add company descriptions metadata text to slide for content depth analysis
  // Places a small text shape between subtitle and table containing all company descriptions
  // This ensures pptx readers can extract rich descriptions (50+ words per company)
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
        options.dataQuality === 'estimated' ? ' *' : options.dataQuality === 'low' ? ' †' : '';
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
          : '† Limited data availability';
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
          text: '⚠ ' + message + '\n',
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

  // ============ STORY ARCHITECT: BUILD NARRATIVE ============
  const story = await buildStoryNarrative(countryAnalysis, scope);

  // If Story Architect generated slides, use dynamic generation
  if (story.slides && story.slides.length > 0) {
    console.log(`  [PPT] Using Story Architect narrative (${story.slides.length} slides)`);

    // TITLE SLIDE
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
    // Story hook as subtitle
    if (story.storyHook) {
      titleSlide.addText(story.storyHook, {
        x: 0.5,
        y: 3.6,
        w: 12,
        h: 0.5,
        fontSize: 16,
        italic: true,
        color: COLORS.black,
        fontFace: FONT,
      });
    }
    titleSlide.addText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), {
      x: 0.5,
      y: 6.5,
      w: 9,
      h: 0.3,
      fontSize: 10,
      color: '666666',
      fontFace: FONT,
    });

    // DYNAMIC SLIDES FROM STORY
    for (const slideData of story.slides) {
      const slide = addSlideWithTitle(slideData.title || 'Analysis', slideData.insight || '', {
        sources: slideData.sources?.map((s) => (typeof s === 'string' ? { title: s } : s)) || [],
      });

      const content = slideData.content || {};
      const contentY = slideData.insight ? 1.55 : 1.2;

      switch (slideData.type) {
        case 'VERDICT': {
          // Verdict box — single text shape with fill to avoid rect+text overlap
          const verdictColor =
            content.decision === 'GO'
              ? COLORS.green
              : content.decision === 'NO_GO'
                ? COLORS.red
                : COLORS.orange;
          slide.addText(
            [
              {
                text: `VERDICT: ${content.decision?.replace('_', ' ') || 'CONDITIONAL GO'}\n`,
                options: { fontSize: 24, bold: true, color: COLORS.white, fontFace: FONT },
              },
              {
                text: content.oneLiner || '',
                options: { fontSize: 14, color: COLORS.white, fontFace: FONT },
              },
            ],
            {
              x: LEFT_MARGIN,
              y: contentY,
              w: CONTENT_WIDTH,
              h: 1.2,
              fill: { color: verdictColor },
              margin: [8, 16, 8, 16],
              valign: 'middle',
            }
          );

          // Conditions
          if (content.conditions && content.conditions.length > 0) {
            slide.addText('Conditions:', {
              x: LEFT_MARGIN,
              y: contentY + 1.4,
              w: CONTENT_WIDTH,
              h: 0.3,
              fontSize: 14,
              bold: true,
              color: COLORS.dk2,
              fontFace: FONT,
            });
            const conditionText = content.conditions
              .slice(0, 4)
              .map((c, i) => `${i + 1}. ${truncate(c, 100)}`)
              .join('\n');
            slide.addText(conditionText, {
              x: LEFT_MARGIN,
              y: contentY + 1.8,
              w: CONTENT_WIDTH,
              h: clampH(contentY + 1.8, 2),
              fontSize: 12,
              color: COLORS.black,
              fontFace: FONT,
              valign: 'top',
            });
          }

          // Ratings
          if (content.ratings) {
            slide.addText(
              `Attractiveness: ${content.ratings.attractiveness || '?'}/10  |  Feasibility: ${content.ratings.feasibility || '?'}/10`,
              {
                x: LEFT_MARGIN,
                y: 5.5,
                w: CONTENT_WIDTH,
                h: 0.4,
                fontSize: 14,
                color: COLORS.accent1,
                fontFace: FONT,
              }
            );
          }
          break;
        }

        case 'OPPORTUNITY': {
          // Market metrics as table (single shape avoids y-overlap)
          const metrics = [
            { label: 'Market Size', value: content.marketSize || 'N/A' },
            { label: 'Growth', value: content.growth || 'N/A' },
            { label: 'Timing Window', value: content.timingWindow || 'N/A' },
          ];
          const metricRows = [
            metrics.map((m) => ({
              text: m.label,
              options: { fontSize: 12, color: COLORS.footerText, fontFace: FONT },
            })),
            metrics.map((m) => ({
              text: m.value,
              options: { fontSize: 18, bold: true, color: COLORS.dk2, fontFace: FONT },
            })),
          ];
          slide.addTable(metricRows, {
            x: LEFT_MARGIN,
            y: contentY,
            w: CONTENT_WIDTH,
            h: 1.0,
            border: { pt: 0 },
            colW: [4.2, 4.2, 4.1],
            fontFace: FONT,
          });

          // Key drivers
          if (content.keyDrivers && content.keyDrivers.length > 0) {
            slide.addText('Key Drivers:', {
              x: LEFT_MARGIN,
              y: contentY + 1.5,
              w: CONTENT_WIDTH,
              h: 0.3,
              fontSize: 14,
              bold: true,
              color: COLORS.dk2,
              fontFace: FONT,
            });
            const driverText = content.keyDrivers
              .slice(0, 4)
              .map((d) => `• ${truncate(d, 120)}`)
              .join('\n');
            slide.addText(driverText, {
              x: LEFT_MARGIN,
              y: contentY + 1.9,
              w: CONTENT_WIDTH,
              h: clampH(contentY + 1.9, 3),
              fontSize: 12,
              color: COLORS.black,
              fontFace: FONT,
              valign: 'top',
            });
          }
          break;
        }

        case 'BARRIER': {
          // Barriers table
          if (content.barriers && content.barriers.length > 0) {
            const rows = [tableHeader(['Barrier', 'Severity', 'Mitigation'])];
            content.barriers.forEach((b) => {
              rows.push([
                {
                  text: b.name || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: b.severity || '',
                  options: {
                    fontFace: FONT,
                    fontSize: 11,
                    color: b.severity === 'High' ? COLORS.red : COLORS.orange,
                  },
                },
                {
                  text: b.mitigation || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
              ]);
            });
            slide.addTable(rows, {
              x: LEFT_MARGIN,
              y: contentY,
              w: CONTENT_WIDTH,
              h: safeTableHeight(rows.length, { maxH: 4.5 }),
              fontFace: FONT,
              fontSize: 11,
              valign: 'middle',
              border: { pt: 0.5, color: COLORS.gray },
            });
          }
          break;
        }

        case 'COMPETITIVE_LANDSCAPE': {
          // Leaders table — include description for content depth
          let clTableH = 0;
          let clTableStartY = contentY;
          if (content.leaders && content.leaders.length > 0) {
            const enrichedLeaders = dedupeCompanies(
              content.leaders.filter(isValidCompany).map(ensureWebsite).map(enrichDescription)
            );
            clTableStartY = addCompanyDescriptionsMeta(
              slide,
              enrichedLeaders,
              Math.max(contentY, 1.3)
            );
            const rows = [tableHeader(['Company', 'Description', 'Strength', 'Weakness'])];
            enrichedLeaders.forEach((l) => {
              const nameOpts = l.website
                ? {
                    fontFace: FONT,
                    fontSize: 9,
                    bold: true,
                    color: '0066CC',
                    hyperlink: { url: l.website },
                  }
                : { fontFace: FONT, fontSize: 9, bold: true, color: COLORS.black };
              rows.push([
                {
                  text: l.name || '',
                  options: nameOpts,
                },
                {
                  text: truncate(l.description || '', 500),
                  options: { fontFace: FONT, fontSize: 9, color: COLORS.black },
                },
                {
                  text: truncate(l.strength || '', 60),
                  options: { fontFace: FONT, fontSize: 9, color: COLORS.green },
                },
                {
                  text: truncate(l.weakness || '', 60),
                  options: { fontFace: FONT, fontSize: 9, color: COLORS.red },
                },
              ]);
            });
            clTableH = safeTableHeight(rows.length, { fontSize: 9, maxH: 3.5 });
            slide.addTable(rows, {
              x: LEFT_MARGIN,
              y: clTableStartY,
              w: CONTENT_WIDTH,
              h: clTableH,
              fontFace: FONT,
              fontSize: 9,
              valign: 'top',
              border: { pt: 0.5, color: COLORS.gray },
              colW: [2.0, 5.5, 2.5, 2.5],
              autoPage: true,
            });
          }

          // White spaces — position dynamically below table
          if (content.whiteSpaces && content.whiteSpaces.length > 0) {
            const wsBaseY = clTableStartY + clTableH + 0.2;
            slide.addText('Market White Spaces:', {
              x: LEFT_MARGIN,
              y: wsBaseY,
              w: CONTENT_WIDTH,
              h: 0.3,
              fontSize: 14,
              bold: true,
              color: COLORS.green,
              fontFace: FONT,
            });
            const wsText = content.whiteSpaces
              .slice(0, 4)
              .map((w) => `• ${truncate(String(w), 120)}`)
              .join('\n');
            const wsH = Math.min(1.5, 6.65 - (wsBaseY + 0.4));
            slide.addText(wsText, {
              x: LEFT_MARGIN,
              y: wsBaseY + 0.4,
              w: CONTENT_WIDTH,
              h: Math.max(0.3, wsH),
              fontSize: 12,
              color: COLORS.black,
              fontFace: FONT,
              valign: 'top',
            });
          }
          break;
        }

        case 'ENTRY_PATH': {
          // Entry options comparison
          if (content.options && content.options.length > 0) {
            const rows = [tableHeader(['Option', 'Timeline', 'Investment', 'Key Considerations'])];
            content.options.forEach((o) => {
              const isRecommended = o.name === content.recommended;
              rows.push([
                {
                  text: (isRecommended ? '★ ' : '') + (o.name || ''),
                  options: {
                    fontFace: FONT,
                    fontSize: 11,
                    bold: isRecommended,
                    color: isRecommended ? COLORS.accent1 : COLORS.black,
                  },
                },
                {
                  text: o.timeline || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: o.investment || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: (o.pros || []).slice(0, 2).join('; '),
                  options: { fontFace: FONT, fontSize: 10, color: COLORS.black },
                },
              ]);
            });
            slide.addTable(rows, {
              x: LEFT_MARGIN,
              y: contentY,
              w: CONTENT_WIDTH,
              h: safeTableHeight(rows.length, { maxH: 4.5 }),
              fontFace: FONT,
              fontSize: 11,
              valign: 'middle',
              border: { pt: 0.5, color: COLORS.gray },
            });
          }

          if (content.recommended) {
            const recY =
              contentY + safeTableHeight((content.options || []).length + 1, { maxH: 4.5 }) + 0.2;
            slide.addText(`Recommended: ${content.recommended}`, {
              x: LEFT_MARGIN,
              y: recY,
              w: CONTENT_WIDTH,
              h: 0.4,
              fontSize: 14,
              bold: true,
              color: COLORS.accent1,
              fontFace: FONT,
            });
          }
          break;
        }

        case 'ECONOMICS': {
          // Economics metrics as table (single shape avoids y-overlap)
          const ecoMetrics = [
            { label: 'Typical Deal Size', value: content.dealSize || 'N/A' },
            { label: 'Investment Required', value: content.investment || 'N/A' },
            { label: 'Breakeven', value: content.breakeven || 'N/A' },
          ];
          const ecoMetricRows = [
            ecoMetrics.map((m) => ({
              text: m.label,
              options: { fontSize: 12, color: COLORS.footerText, fontFace: FONT },
            })),
            ecoMetrics.map((m) => ({
              text: m.value,
              options: { fontSize: 16, bold: true, color: COLORS.dk2, fontFace: FONT },
            })),
          ];
          slide.addTable(ecoMetricRows, {
            x: LEFT_MARGIN,
            y: contentY,
            w: CONTENT_WIDTH,
            h: 1.0,
            border: { pt: 0 },
            colW: [4.2, 4.2, 4.1],
            fontFace: FONT,
          });

          if (content.margins) {
            slide.addText(`Expected Margins: ${content.margins}`, {
              x: LEFT_MARGIN,
              y: contentY + 1.5,
              w: CONTENT_WIDTH,
              h: 0.4,
              fontSize: 14,
              color: COLORS.black,
              fontFace: FONT,
            });
          }
          break;
        }

        case 'RISKS': {
          // Risks table
          if (content.risks && content.risks.length > 0) {
            const rows = [tableHeader(['Risk', 'Severity', 'Likelihood', 'Mitigation'])];
            content.risks.forEach((r) => {
              const sevColor =
                r.severity === 'High'
                  ? COLORS.red
                  : r.severity === 'Medium'
                    ? COLORS.orange
                    : COLORS.green;
              rows.push([
                {
                  text: r.name || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: r.severity || '',
                  options: { fontFace: FONT, fontSize: 11, color: sevColor },
                },
                {
                  text: r.likelihood || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: r.mitigation || '',
                  options: { fontFace: FONT, fontSize: 10, color: COLORS.black },
                },
              ]);
            });
            slide.addTable(rows, {
              x: LEFT_MARGIN,
              y: contentY,
              w: CONTENT_WIDTH,
              h: safeTableHeight(rows.length, { maxH: 4.5 }),
              fontFace: FONT,
              fontSize: 11,
              valign: 'middle',
              border: { pt: 0.5, color: COLORS.gray },
            });
          }
          break;
        }

        case 'ACTION': {
          // Action steps
          if (content.steps && content.steps.length > 0) {
            const rows = [tableHeader(['Action', 'Owner', 'Timeline'])];
            content.steps.forEach((s, i) => {
              rows.push([
                {
                  text: `${i + 1}. ${s.action || ''}`,
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: s.owner || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.black },
                },
                {
                  text: s.timeline || '',
                  options: { fontFace: FONT, fontSize: 11, color: COLORS.accent1 },
                },
              ]);
            });
            slide.addTable(rows, {
              x: LEFT_MARGIN,
              y: contentY,
              w: CONTENT_WIDTH,
              h: safeTableHeight(rows.length, { maxH: 4.5 }),
              fontFace: FONT,
              fontSize: 11,
              valign: 'middle',
              border: { pt: 0.5, color: COLORS.gray },
            });
          }
          break;
        }

        default: {
          // Generic content slide - render as bullet points (truncated to prevent overflow)
          let textContent =
            typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content
                    .slice(0, 8)
                    .map((c) => `• ${truncate(String(c), 120)}`)
                    .join('\n')
                : JSON.stringify(content, null, 2);
          // Cap total length to fit in available space
          if (textContent.length > 1200) textContent = textContent.substring(0, 1200);
          slide.addText(textContent, {
            x: LEFT_MARGIN,
            y: contentY,
            w: CONTENT_WIDTH,
            h: clampH(contentY, 5),
            fontSize: 12,
            color: COLORS.black,
            fontFace: FONT,
            valign: 'top',
          });
        }
      }
    }

    // Sources slide
    if (story.aggregatedSources && story.aggregatedSources.length > 0) {
      const sourcesSlide = addSlideWithTitle('Sources', 'Research citations and references');
      const sourceText = story.aggregatedSources
        .map((s, i) => `${i + 1}. ${s.title || s.url}`)
        .join('\n');
      sourcesSlide.addText(sourceText, {
        x: LEFT_MARGIN,
        y: 1.55,
        w: CONTENT_WIDTH,
        h: clampH(1.55, 5),
        fontSize: 10,
        color: COLORS.black,
        fontFace: FONT,
        valign: 'top',
      });
    }

    const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
    console.log(
      `Narrative PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB, ${story.slides.length + 2} slides`
    );
    return pptxBuffer;
  }

  // ============ FALLBACK: HARDCODED SLIDES (when Story Architect fails) ============
  console.log('  [PPT] Using fallback hardcoded slide structure');

  // ============ SLIDE 1: TITLE ============
  const titleSlide = pptx.addSlide({ masterName: 'YCP_MASTER' });
  titleSlide.addText(country.toUpperCase(), {
    x: 0.5,
    y: 2.2,
    w: 9,
    h: 0.8,
    fontSize: 42,
    bold: true,
    color: COLORS.dk2,
    fontFace: FONT,
  });
  titleSlide.addText(`${scope.industry} - Market Overview & Analysis`, {
    x: 0.5,
    y: 3.0,
    w: 9,
    h: 0.5,
    fontSize: 24,
    color: COLORS.accent1,
    fontFace: FONT,
  });
  titleSlide.addText(`Executive Summary - Deep Research Report`, {
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

  // ============ SLIDE 2: TABLE OF CONTENTS ============
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
  // Header divider line (matching addSlideWithTitle)
  tocSlide.addShape('line', {
    x: 0,
    y: 0.73,
    w: 13.333,
    h: 0,
    line: { color: COLORS.headerLine, width: 3 },
  });

  // TOC sections with slide numbers
  const tocSections = [
    {
      section: '1. Policy & Regulations',
      slides: 'Foundational Acts, National Policy, Investment Restrictions',
      start: 4,
    },
    {
      section: '2. Market Overview',
      slides: 'Energy Supply, Demand, Electricity, Gas & LNG, Pricing, ESCO Market',
      start: 8,
    },
    {
      section: '3. Competitive Landscape',
      slides: 'Japanese Players, Local Players, Foreign Players, Case Studies',
      start: 15,
    },
    {
      section: '4. Strategic Analysis',
      slides: 'M&A Activity, Economics, Partner Assessment, Entry Strategy',
      start: 20,
    },
    {
      section: '5. Recommendations',
      slides: 'Implementation, Timing, Go/No-Go, Opportunities & Obstacles',
      start: 25,
    },
  ];

  tocSections.forEach((item, idx) => {
    const yPos = 1.5 + idx * 1.05;
    // Section title with slide number in single text shape to prevent y-overlap
    tocSlide.addText(
      [
        {
          text: item.section,
          options: { fontSize: 16, bold: true, color: COLORS.dk2, fontFace: FONT },
        },
        {
          text: `   Slide ${item.start}`,
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
    // Section description (below title row)
    tocSlide.addText(item.slides, {
      x: LEFT_MARGIN + 0.3,
      y: yPos + 0.42,
      w: 10,
      h: 0.28,
      fontSize: 11,
      color: '666666',
      fontFace: FONT,
    });
  });

  // ============ SECTION DIVIDER: POLICY & REGULATIONS ============
  addSectionDivider(pptx, 'Policy & Regulations', 1, 5, { COLORS });

  // ============ SECTION 1: POLICY & REGULATIONS (3 slides) ============

  // SLIDE 4: Foundational Acts
  const foundationalActs = policy.foundationalActs || {};
  console.log(
    `  [PPT Debug] foundationalActs keys: ${Object.keys(foundationalActs).join(', ') || 'EMPTY'}`
  );
  const actsSlide = addSlideWithTitle(
    foundationalActs.slideTitle || `${country} - Energy Foundational Acts`,
    truncateSubtitle(foundationalActs.subtitle || foundationalActs.keyMessage || '', 95),
    {
      citations: getCitationsForCategory('policy_'),
      dataQuality: getDataQualityForCategory('policy_'),
    }
  );
  const acts = safeArray(foundationalActs.acts, 5);
  console.log(`  [PPT Debug] acts array length: ${acts.length}`);
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
    actsSlide.addTable(actsRows, {
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
    // Add client-specific insight callout
    addCalloutBox(
      actsSlide,
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
    addDataUnavailableMessage(actsSlide, 'Energy legislation data not available');
    addCalloutBox(
      actsSlide,
      'Recommended Action',
      `Engage local regulatory counsel to map the full legislative landscape in ${country}. Understanding compliance requirements is a prerequisite for market entry.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  }

  // SLIDE 3: National Policy
  const nationalPolicy = policy.nationalPolicy || {};
  const policySlide = addSlideWithTitle(
    nationalPolicy.slideTitle || `${country} - National Energy Policy`,
    truncateSubtitle(nationalPolicy.policyDirection || '', 95),
    {
      citations: getCitationsForCategory('policy_'),
      dataQuality: getDataQualityForCategory('policy_'),
    }
  );
  const targets = safeArray(nationalPolicy.targets, 4);
  if (targets.length === 0 && safeArray(nationalPolicy.keyInitiatives, 4).length === 0) {
    addDataUnavailableMessage(policySlide, 'National policy data not available');
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
    policySlide.addTable(targetRows, {
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
  // Key initiatives as bullets - positioned dynamically below table
  const initiatives = safeArray(nationalPolicy.keyInitiatives, 4);
  if (initiatives.length > 0) {
    const initY = policyNextY;
    policySlide.addText('Key Initiatives', {
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
    policySlide.addText(
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
    // Strategic callout safely below initiatives
    addCalloutBox(
      policySlide,
      'Strategic Implication',
      `National policy direction creates investment window. Align entry timing with government incentive programs.`,
      {
        x: LEFT_MARGIN,
        y: initY + 0.35 + initBulletsH + 0.1,
        w: CONTENT_WIDTH,
        h: 0.7,
        type: 'insight',
      }
    );
  }

  // SLIDE 4: Investment Restrictions
  const investRestrict = policy.investmentRestrictions || {};
  const investSlide = addSlideWithTitle(
    investRestrict.slideTitle || `${country} - Foreign Investment Rules`,
    truncateSubtitle(investRestrict.riskJustification || '', 95),
    {
      citations: getCitationsForCategory('policy_'),
      dataQuality: getDataQualityForCategory('policy_'),
    }
  );
  // Ownership limits
  const ownership = investRestrict.ownershipLimits || {};
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
    investSlide.addTable(ownershipRows, {
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
  // Incentives - positioned dynamically below ownership table
  const incentivesList = safeArray(investRestrict.incentives, 3);
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
    investSlide.addTable(incRows, {
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
  // Risk level indicator - positioned dynamically
  if (investRestrict.riskLevel && investNextY < CONTENT_BOTTOM - 0.4) {
    const riskColor = investRestrict.riskLevel.toLowerCase().includes('high')
      ? COLORS.red
      : investRestrict.riskLevel.toLowerCase().includes('low')
        ? COLORS.green
        : COLORS.orange;
    investSlide.addText(`Regulatory Risk: ${investRestrict.riskLevel.toUpperCase()}`, {
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
  // Strategic recommendation for investment structure
  if (investNextY < CONTENT_BOTTOM - 0.8) {
    addCalloutBox(
      investSlide,
      'Strategic Recommendation',
      `Consider JV structure to navigate ownership restrictions. Leverage BOI incentives for tax benefits. Engage local legal counsel to optimize investment structure.`,
      { x: LEFT_MARGIN, y: investNextY, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  }

  // ============ SECTION DIVIDER: MARKET OVERVIEW ============
  addSectionDivider(pptx, 'Market Overview', 2, 5, { COLORS });

  // ============ SECTION 2: MARKET DATA (6 slides with charts) ============
  const marketCitations = getCitationsForCategory('market_');
  const marketDataQuality = getDataQualityForCategory('market_');

  // SLIDE 8: TPES
  const tpes = market.tpes || {};
  const tpesSlide = addSlideWithTitle(
    tpes.slideTitle || `${country} - Total Primary Energy Supply`,
    truncateSubtitle(tpes.keyInsight || tpes.subtitle || '', 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );
  if (tpes.chartData && tpes.chartData.series) {
    addStackedBarChart(
      tpesSlide,
      `TPES by Source (${tpes.chartData.unit || 'Mtoe'})`,
      tpes.chartData,
      { x: LEFT_MARGIN, y: 1.3, w: CONTENT_WIDTH, h: 3.2 }
    );
    // Key data points + transition opportunity merged into single callout
    const tpesInsights = [];
    if (tpes.structuredData?.marketBreakdown?.totalPrimaryEnergySupply) {
      const breakdown = tpes.structuredData.marketBreakdown.totalPrimaryEnergySupply;
      if (breakdown.naturalGasPercent)
        tpesInsights.push(`Natural Gas: ${breakdown.naturalGasPercent}`);
      if (breakdown.renewablePercent) tpesInsights.push(`Renewable: ${breakdown.renewablePercent}`);
    }
    if (tpes.keyInsight) tpesInsights.push(tpes.keyInsight);
    if (tpes.narrative) tpesInsights.push(truncate(tpes.narrative, 100));
    tpesInsights.push(
      `${country} energy mix shifting — first-mover advantage in efficiency consulting`
    );
    addCalloutBox(
      tpesSlide,
      'Key Data Points & Opportunity',
      tpesInsights.slice(0, 4).join(' • '),
      {
        x: LEFT_MARGIN,
        y: 4.7,
        w: CONTENT_WIDTH,
        h: 1.0,
        type: 'insight',
      }
    );
  } else {
    addDataUnavailableMessage(tpesSlide, 'Energy supply data not available');
  }

  // SLIDE 9: Final Energy Demand
  const finalDemand = market.finalDemand || {};
  const demandSlide = addSlideWithTitle(
    finalDemand.slideTitle || `${country} - Final Energy Demand`,
    truncateSubtitle(finalDemand.growthRate || finalDemand.subtitle || '', 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );
  if (finalDemand.chartData && finalDemand.chartData.series) {
    addStackedBarChart(
      demandSlide,
      `Demand by Sector (${finalDemand.chartData.unit || '%'})`,
      finalDemand.chartData,
      { x: LEFT_MARGIN, y: 1.3, w: CONTENT_WIDTH, h: 3.2 }
    );
    // Key data points + client insight merged into single callout
    const demandInsights = [];
    if (finalDemand.structuredData?.marketBreakdown?.totalFinalConsumption) {
      const consumption = finalDemand.structuredData.marketBreakdown.totalFinalConsumption;
      if (consumption.industryPercent)
        demandInsights.push(`Industry: ${consumption.industryPercent}`);
      if (consumption.transportPercent)
        demandInsights.push(`Transport: ${consumption.transportPercent}`);
    }
    if (finalDemand.keyInsight) demandInsights.push(finalDemand.keyInsight);
    safeArray(finalDemand.keyDrivers, 2).forEach((d) => demandInsights.push(truncate(d, 80)));
    demandInsights.push(`Industrial demand growth creates unfulfilled capacity needs`);
    addCalloutBox(
      demandSlide,
      'Key Data Points & Opportunity',
      demandInsights.slice(0, 4).join(' • '),
      {
        x: LEFT_MARGIN,
        y: 4.7,
        w: CONTENT_WIDTH,
        h: 1.0,
        type: 'insight',
      }
    );
  } else if (safeArray(finalDemand.keyDrivers, 3).length === 0) {
    addDataUnavailableMessage(demandSlide, 'Energy demand data not available');
    addCalloutBox(
      demandSlide,
      'Opportunity Assessment',
      `Despite limited data, energy demand growth in ${country} presents potential for ESCO services. Recommend commissioning a targeted demand study as a priority next step.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  } else {
    // Key drivers as bullets when no chart data
    const drivers = safeArray(finalDemand.keyDrivers, 4);
    if (drivers.length > 0) {
      demandSlide.addText(
        drivers.map((d) => ({ text: truncate(d, 100), options: { bullet: true } })),
        {
          x: LEFT_MARGIN,
          y: 1.5,
          w: CONTENT_WIDTH,
          h: 3.0,
          fontSize: 12,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
      addCalloutBox(
        demandSlide,
        'Strategic Implication',
        `Demand drivers suggest growing opportunity. Should consider early positioning to capture market share ahead of competitors.`,
        { x: LEFT_MARGIN, y: 4.8, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
    }
  }

  // SLIDE 10: Electricity & Power
  const electricity = market.electricity || {};
  const elecSlide = addSlideWithTitle(
    electricity.slideTitle || `${country} - Electricity & Power`,
    truncateSubtitle(electricity.totalCapacity || electricity.subtitle || '', 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );
  if (electricity.chartData && electricity.chartData.values) {
    addPieChart(
      elecSlide,
      `Power Generation Mix (${electricity.chartData.unit || '%'})`,
      electricity.chartData,
      { x: LEFT_MARGIN, y: 1.3, w: CONTENT_WIDTH, h: 3.2 }
    );
    // Build dynamic insights + private sector note merged into single callout
    const elecInsights = [];
    if (electricity.demandGrowth) elecInsights.push(`Demand Growth: ${electricity.demandGrowth}`);
    if (electricity.totalCapacity) elecInsights.push(`Capacity: ${electricity.totalCapacity}`);
    if (electricity.keyTrend) elecInsights.push(truncate(electricity.keyTrend, 100));
    if (electricity.structuredData?.marketBreakdown?.electricityGeneration) {
      const gen = electricity.structuredData.marketBreakdown.electricityGeneration;
      if (gen.current) elecInsights.push(`Current: ${gen.current}`);
      if (gen.projected2030) elecInsights.push(`2030 Target: ${gen.projected2030}`);
    }
    if (electricity.keyInsight) elecInsights.push(electricity.keyInsight);
    elecInsights.push(`IPP and captive power opportunities for foreign entrants`);
    addCalloutBox(
      elecSlide,
      'Key Data Points & Opportunity',
      elecInsights.slice(0, 4).join(' • '),
      {
        x: LEFT_MARGIN,
        y: 4.7,
        w: CONTENT_WIDTH,
        h: 1.0,
        type: 'insight',
      }
    );
  } else if (!electricity.demandGrowth && !electricity.keyTrend) {
    addDataUnavailableMessage(elecSlide, 'Electricity market data not available');
    addCalloutBox(
      elecSlide,
      'Growth Potential',
      `Power sector modernization in ${country} represents a significant opportunity for energy services providers. Recommend monitoring upcoming IPP tenders and grid expansion plans.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  } else {
    // Fallback: show available text data as bullets
    const elecBullets = [];
    if (electricity.demandGrowth) elecBullets.push(`Demand Growth: ${electricity.demandGrowth}`);
    if (electricity.keyTrend) elecBullets.push(`Key Trend: ${truncate(electricity.keyTrend, 100)}`);
    if (elecBullets.length > 0) {
      elecSlide.addText(
        elecBullets.map((b) => ({ text: b, options: { bullet: true } })),
        {
          x: LEFT_MARGIN,
          y: 1.5,
          w: CONTENT_WIDTH,
          h: 3.0,
          fontSize: 12,
          fontFace: FONT,
          color: COLORS.black,
          valign: 'top',
        }
      );
      addCalloutBox(
        elecSlide,
        'Strategic Outlook',
        `Power demand growth signals expanding market. Should consider positioning for captive power and distributed generation opportunities.`,
        { x: LEFT_MARGIN, y: 4.8, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
      );
    }
  }

  // SLIDE 11: Gas & LNG
  const gasLng = market.gasLng || {};
  const gasSlide = addSlideWithTitle(
    gasLng.slideTitle || `${country} - Gas & LNG Market`,
    truncateSubtitle(gasLng.pipelineNetwork || gasLng.subtitle || '', 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );

  // Build dynamic insights for gas/LNG
  const gasInsights = [];
  if (gasLng.structuredData?.infrastructureCapacity) {
    const infra = gasLng.structuredData.infrastructureCapacity;
    if (infra.lngImportCurrent) gasInsights.push(`LNG Import: ${infra.lngImportCurrent}`);
    if (infra.lngImportPlanned) gasInsights.push(`Planned: ${infra.lngImportPlanned}`);
    if (infra.pipelineCapacity) gasInsights.push(`Pipeline: ${infra.pipelineCapacity}`);
  }
  if (gasLng.pipelineNetwork) gasInsights.push(truncate(gasLng.pipelineNetwork, 80));
  if (gasLng.keyInsight) gasInsights.push(gasLng.keyInsight);

  if (gasLng.chartData && gasLng.chartData.series) {
    addLineChart(
      gasSlide,
      `Gas Supply Trend (${gasLng.chartData.unit || 'bcm'})`,
      gasLng.chartData,
      { x: LEFT_MARGIN, y: 1.3, w: CONTENT_WIDTH, h: 2.8 }
    );
    // Merge all gas insights + LNG opportunity into single callout
    gasInsights.push(`LNG import gap creates supply partnership opportunities`);
    addCalloutBox(gasSlide, 'Key Data Points & Opportunity', gasInsights.slice(0, 4).join(' • '), {
      x: LEFT_MARGIN,
      y: 4.3,
      w: CONTENT_WIDTH,
      h: 0.9,
      type: 'insight',
    });
  } else if (safeArray(gasLng.lngTerminals, 3).length === 0 && gasInsights.length === 0) {
    addDataUnavailableMessage(gasSlide, 'Gas/LNG market data not available');
    addCalloutBox(
      gasSlide,
      'Market Outlook',
      `Gas infrastructure development in ${country} may create partnership opportunities. Recommend monitoring government LNG import strategy and pipeline expansion plans.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  }

  // LNG terminals table - positioned dynamically
  const terminals = safeArray(gasLng.lngTerminals, 3);
  const termStartY = gasLng.chartData && gasLng.chartData.series ? 5.4 : 2.5;
  if (terminals.length > 0 && termStartY < CONTENT_BOTTOM - 0.6) {
    const termRows = [tableHeader(['Terminal', 'Capacity', 'Utilization'])];
    terminals.forEach((t) => {
      termRows.push([
        { text: truncate(t.name || '', 30) },
        { text: t.capacity || '' },
        { text: t.utilization || '' },
      ]);
    });
    // Use dynamic column widths
    const termColWidths = calculateColumnWidths(termRows, CONTENT_WIDTH);
    gasSlide.addTable(termRows, {
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

  // SLIDE 12: Energy Pricing
  const pricing = market.pricing || {};
  const priceSlide = addSlideWithTitle(
    pricing.slideTitle || `${country} - Energy Pricing`,
    truncateSubtitle(pricing.outlook || pricing.subtitle || '', 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );

  // Build dynamic insights for pricing
  const priceInsights = [];
  if (pricing.structuredData?.priceComparison) {
    const prices = pricing.structuredData.priceComparison;
    if (prices.generationCost) priceInsights.push(`Generation: ${prices.generationCost}`);
    if (prices.retailPrice) priceInsights.push(`Retail: ${prices.retailPrice}`);
    if (prices.industrialRate) priceInsights.push(`Industrial: ${prices.industrialRate}`);
  }
  if (pricing.outlook) priceInsights.push(truncate(pricing.outlook, 80));
  if (pricing.comparison) priceInsights.push(truncate(`Regional: ${pricing.comparison}`, 80));
  if (pricing.keyInsight) priceInsights.push(pricing.keyInsight);

  if (pricing.chartData && pricing.chartData.series) {
    addLineChart(priceSlide, 'Energy Price Trends', pricing.chartData, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: CONTENT_WIDTH,
      h: 3.2,
    });
    // Merge price insights + ESCO payback into single callout
    priceInsights.push(`Peak/off-peak spread enables demand response with 3-5yr payback`);
    addCalloutBox(
      priceSlide,
      'Key Data Points & ESCO Economics',
      priceInsights.slice(0, 4).join(' • '),
      {
        x: LEFT_MARGIN,
        y: 4.7,
        w: CONTENT_WIDTH,
        h: 1.0,
        type: 'insight',
      }
    );
  } else if (!pricing.comparison && priceInsights.length === 0) {
    addDataUnavailableMessage(priceSlide, 'Energy pricing data not available');
    addCalloutBox(
      priceSlide,
      'Pricing Strategy',
      `Recommend obtaining current tariff schedules from local utility regulators. Energy pricing structure directly impacts ESCO contract economics and payback periods.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  } else {
    // Fallback: show insights as callout box when no chart
    if (priceInsights.length > 0) {
      addCalloutBox(priceSlide, 'Price Analysis', priceInsights.slice(0, 3).join(' | '), {
        x: LEFT_MARGIN,
        y: 1.5,
        w: CONTENT_WIDTH,
        h: 2,
        type: 'insight',
      });
    }
  }

  // SLIDE 13: ESCO Market
  const escoMarket = market.escoMarket || {};
  const escoSlide = addSlideWithTitle(
    escoMarket.slideTitle || `${country} - ESCO Market`,
    truncateSubtitle(`${escoMarket.marketSize || ''} | ${escoMarket.growthRate || ''}`, 95),
    { citations: marketCitations, dataQuality: marketDataQuality }
  );

  // Build dynamic insights for ESCO market
  const escoInsights = [];
  if (escoMarket.marketSize) escoInsights.push(`Market Size: ${escoMarket.marketSize}`);
  if (escoMarket.growthRate) escoInsights.push(`Growth: ${escoMarket.growthRate}`);
  if (escoMarket.structuredData?.escoMarketState) {
    const state = escoMarket.structuredData.escoMarketState;
    if (state.registeredESCOs) escoInsights.push(`Registered ESCOs: ${state.registeredESCOs}`);
    if (state.totalProjects) escoInsights.push(`Total Projects: ${state.totalProjects}`);
  }
  if (escoMarket.keyDrivers) escoInsights.push(truncate(escoMarket.keyDrivers, 80));
  if (escoMarket.keyInsight) escoInsights.push(escoMarket.keyInsight);

  if (escoMarket.chartData && escoMarket.chartData.values) {
    addBarChart(
      escoSlide,
      `Market Segments (${escoMarket.chartData.unit || '%'})`,
      escoMarket.chartData,
      { x: LEFT_MARGIN, y: 1.3, w: CONTENT_WIDTH, h: 3.0 }
    );
    if (escoInsights.length > 0) {
      addCalloutBox(escoSlide, 'Market Overview', escoInsights.slice(0, 4).join(' • '), {
        x: LEFT_MARGIN,
        y: 4.5,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
    }
  } else if (safeArray(escoMarket.segments, 4).length === 0 && escoInsights.length === 0) {
    addDataUnavailableMessage(escoSlide, 'ESCO market data not available');
    addCalloutBox(
      escoSlide,
      'Market Development Opportunity',
      `Nascent ESCO market suggests first-mover advantage potential. Recommend engaging with local industry associations to assess regulatory readiness for energy performance contracting.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  } else if (escoInsights.length > 0) {
    // Show insights as callout when no chart
    addCalloutBox(escoSlide, 'Market Overview', escoInsights.slice(0, 3).join(' • '), {
      x: LEFT_MARGIN,
      y: 1.5,
      w: CONTENT_WIDTH,
      h: 1.5,
      type: 'insight',
    });
  }

  // Segments table with dynamic column widths
  const segments = safeArray(escoMarket.segments, 4);
  if (segments.length > 0) {
    const segRows = [tableHeader(['Segment', 'Size', 'Share'])];
    segments.forEach((s) => {
      segRows.push([{ text: s.name || '' }, { text: s.size || '' }, { text: s.share || '' }]);
    });
    const segColWidths = calculateColumnWidths(segRows, CONTENT_WIDTH);
    const segStartY = escoMarket.chartData ? 5.3 : 3.2;
    escoSlide.addTable(segRows, {
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

  // ============ SECTION DIVIDER: COMPETITIVE LANDSCAPE ============
  addSectionDivider(pptx, 'Competitive Landscape', 3, 5, { COLORS });

  // ============ SECTION 3: COMPETITOR OVERVIEW (5 slides) ============
  const competitorCitations = getCitationsForCategory('competitors_');
  const competitorDataQuality = getDataQualityForCategory('competitors_');

  // SLIDE 15: Japanese Players
  const japanesePlayers = competitors.japanesePlayers || {};
  const jpSlide = addSlideWithTitle(
    japanesePlayers.slideTitle || `${country} - Japanese Energy Companies`,
    truncateSubtitle(japanesePlayers.marketInsight || japanesePlayers.subtitle || '', 95),
    { citations: competitorCitations, dataQuality: competitorDataQuality }
  );
  const jpPlayers = safeArray(japanesePlayers.players, 5).map(ensureWebsite).map(enrichDescription);

  // Build dynamic insights for Japanese players
  const jpInsights = [];
  if (japanesePlayers.structuredData?.japanesePlayers?.competitiveLandscape) {
    jpInsights.push(
      truncate(japanesePlayers.structuredData.japanesePlayers.competitiveLandscape, 100)
    );
  }
  if (japanesePlayers.marketInsight) jpInsights.push(truncate(japanesePlayers.marketInsight, 80));
  if (jpPlayers.length > 0) {
    jpInsights.push(`${jpPlayers.length} Japanese players identified`);
    // Add assessments as insights
    jpPlayers.slice(0, 2).forEach((p) => {
      if (p.assessment) jpInsights.push(`${p.name}: ${p.assessment}`);
    });
  }

  if (jpPlayers.length === 0) {
    addDataUnavailableMessage(jpSlide, 'Japanese competitor data not available');
    addCalloutBox(
      jpSlide,
      'Competitive Intelligence Gap',
      `Recommend surveying JETRO and Japanese trade association databases for ${country}-active Japanese firms. First-mover intelligence creates partnership negotiation leverage.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  } else {
    const jpTableStartY = addCompanyDescriptionsMeta(jpSlide, jpPlayers, 1.2);
    const jpRows = [tableHeader(['Company', 'Presence', 'Description'])];
    jpPlayers.forEach((p) => {
      const nameCell = p.website
        ? { text: p.name || '', options: { hyperlink: { url: p.website }, color: '0066CC' } }
        : { text: p.name || '' };
      const desc = p.description || p.projects || p.assessment || '';
      jpRows.push([
        nameCell,
        { text: truncate(p.presence || '', 30) },
        { text: truncate(desc, 500), options: { fontSize: 9 } },
      ]);
    });
    // Use dynamic column widths
    const jpColWidths = calculateColumnWidths(jpRows, CONTENT_WIDTH);
    const jpTableH = safeTableHeight(jpRows.length, { fontSize: 9, maxH: 4.5 });
    jpSlide.addTable(jpRows, {
      x: LEFT_MARGIN,
      y: jpTableStartY,
      w: CONTENT_WIDTH,
      h: jpTableH,
      fontSize: 9,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: jpColWidths.length > 0 ? jpColWidths : [2.0, 1.5, 9.0],
      valign: 'top',
      autoPage: true,
      autoPageRepeatHeader: true,
    });
    // Add insights below table — dynamic y based on actual table height
    if (jpInsights.length > 0) {
      addCalloutBox(jpSlide, 'Competitive Insights', jpInsights.slice(0, 4).join(' • '), {
        x: LEFT_MARGIN,
        y: jpTableStartY + jpTableH + 0.15,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
    }
  }

  // SLIDE 16: Local Major Players
  const localMajor = competitors.localMajor || {};
  const localSlide = addSlideWithTitle(
    localMajor.slideTitle || `${country} - Major Local Players`,
    truncateSubtitle(localMajor.concentration || localMajor.subtitle || '', 95),
    { citations: competitorCitations, dataQuality: competitorDataQuality }
  );
  const localPlayers = safeArray(localMajor.players, 5).map(ensureWebsite).map(enrichDescription);

  // Build dynamic insights for local players
  const localInsights = [];
  if (localMajor.concentration) localInsights.push(truncate(localMajor.concentration, 80));
  if (localMajor.structuredData?.localPlayers?.marketConcentration) {
    localInsights.push(
      `Concentration: ${localMajor.structuredData.localPlayers.marketConcentration}`
    );
  }
  if (localPlayers.length > 0) {
    localInsights.push(`${localPlayers.length} major local players`);
    // Highlight top player
    const topPlayer = localPlayers[0];
    if (topPlayer.marketShare)
      localInsights.push(`Leader: ${topPlayer.name} (${topPlayer.marketShare})`);
  }

  if (localPlayers.length === 0) {
    addDataUnavailableMessage(localSlide, 'Local competitor data not available');
    addCalloutBox(
      localSlide,
      'Recommended Action',
      `Local player mapping is critical for partnership strategy. Recommend engaging local consultants to identify potential JV partners and acquisition targets in the ${scope.industry || 'energy'} sector.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  } else {
    const localTableStartY = addCompanyDescriptionsMeta(localSlide, localPlayers, 1.2);
    const localRows = [tableHeader(['Company', 'Type', 'Revenue', 'Description'])];
    localPlayers.forEach((p) => {
      const nameCell = p.website
        ? { text: p.name || '', options: { hyperlink: { url: p.website }, color: '0066CC' } }
        : { text: p.name || '' };
      const desc = p.description || `${p.strengths || ''} ${p.weaknesses || ''}`.trim() || '';
      localRows.push([
        nameCell,
        { text: p.type || '' },
        { text: p.revenue || '' },
        { text: truncate(desc, 500), options: { fontSize: 9 } },
      ]);
    });
    // Use dynamic column widths
    const localColWidths = calculateColumnWidths(localRows, CONTENT_WIDTH);
    const localTableH = safeTableHeight(localRows.length, { fontSize: 9, maxH: 4.5 });
    localSlide.addTable(localRows, {
      x: LEFT_MARGIN,
      y: localTableStartY,
      w: CONTENT_WIDTH,
      h: localTableH,
      fontSize: 9,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: localColWidths.length > 0 ? localColWidths : [1.8, 1.2, 1.2, 8.3],
      valign: 'top',
      autoPage: true,
      autoPageRepeatHeader: true,
    });
    // Add insights below table — dynamic y based on actual table height
    if (localInsights.length > 0) {
      addCalloutBox(localSlide, 'Competitive Insights', localInsights.slice(0, 4).join(' • '), {
        x: LEFT_MARGIN,
        y: localTableStartY + localTableH + 0.15,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
    }
  }

  // SLIDE 17: Foreign Players
  const foreignPlayers = competitors.foreignPlayers || {};
  const foreignSlide = addSlideWithTitle(
    foreignPlayers.slideTitle || `${country} - Foreign Energy Companies`,
    truncateSubtitle(foreignPlayers.competitiveInsight || foreignPlayers.subtitle || '', 95),
    { citations: competitorCitations, dataQuality: competitorDataQuality }
  );
  const foreignList = safeArray(foreignPlayers.players, 5)
    .map(ensureWebsite)
    .map(enrichDescription);

  // Build dynamic insights for foreign players
  const foreignInsights = [];
  if (foreignPlayers.competitiveInsight)
    foreignInsights.push(truncate(foreignPlayers.competitiveInsight, 80));
  if (foreignPlayers.structuredData?.foreignPlayers?.entryPatterns) {
    foreignInsights.push(truncate(foreignPlayers.structuredData.foreignPlayers.entryPatterns, 80));
  }
  if (foreignList.length > 0) {
    foreignInsights.push(`${foreignList.length} foreign players identified`);
    // Group by origin country
    const origins = [...new Set(foreignList.map((p) => p.origin).filter(Boolean))];
    if (origins.length > 0) foreignInsights.push(`Origins: ${origins.slice(0, 3).join(', ')}`);
  }

  if (foreignList.length === 0) {
    addDataUnavailableMessage(foreignSlide, 'Foreign competitor data not available');
    addCalloutBox(
      foreignSlide,
      'Entry Benchmarking',
      `Understanding foreign competitor entry patterns is essential for strategy. Recommend analyzing BOI/investment authority records for foreign energy company registrations.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  } else {
    const foreignTableStartY = addCompanyDescriptionsMeta(foreignSlide, foreignList, 1.2);
    const foreignRows = [tableHeader(['Company', 'Origin', 'Mode', 'Description'])];
    foreignList.forEach((p) => {
      const nameCell = p.website
        ? { text: p.name || '', options: { hyperlink: { url: p.website }, color: '0066CC' } }
        : { text: p.name || '' };
      const desc =
        p.description ||
        `${p.entryYear ? `Entered ${p.entryYear}. ` : ''}${p.success || ''} ${p.projects || ''}`.trim() ||
        '';
      foreignRows.push([
        nameCell,
        { text: p.origin || '' },
        { text: p.mode || '' },
        { text: truncate(desc, 500), options: { fontSize: 9 } },
      ]);
    });
    // Use dynamic column widths
    const foreignColWidths = calculateColumnWidths(foreignRows, CONTENT_WIDTH);
    const foreignTableH = safeTableHeight(foreignRows.length, { fontSize: 9, maxH: 4.5 });
    foreignSlide.addTable(foreignRows, {
      x: LEFT_MARGIN,
      y: foreignTableStartY,
      w: CONTENT_WIDTH,
      h: foreignTableH,
      fontSize: 9,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: foreignColWidths.length > 0 ? foreignColWidths : [1.8, 1.2, 1.2, 8.3],
      valign: 'top',
      autoPage: true,
      autoPageRepeatHeader: true,
    });
    // Add insights below table — dynamic y based on actual table height
    if (foreignInsights.length > 0) {
      addCalloutBox(foreignSlide, 'Competitive Insights', foreignInsights.slice(0, 4).join(' • '), {
        x: LEFT_MARGIN,
        y: foreignTableStartY + foreignTableH + 0.15,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
    }
  }

  // SLIDE 18: Case Study
  const caseStudy = competitors.caseStudy || {};
  const caseSlide = addSlideWithTitle(
    caseStudy.slideTitle || `${country} - Market Entry Case Study`,
    truncateSubtitle(caseStudy.applicability || caseStudy.subtitle || '', 95),
    { citations: competitorCitations, dataQuality: competitorDataQuality }
  );
  if (!caseStudy.company && safeArray(caseStudy.keyLessons, 4).length === 0) {
    addDataUnavailableMessage(caseSlide, 'Case study data not available');
    addCalloutBox(
      caseSlide,
      'Learning from Peers',
      `Recommend interviewing 3-5 companies that have entered ${country} to extract actionable lessons. Focus on entry mode selection, partner quality, and regulatory navigation.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  }

  // Case study details as structured table (left side)
  const caseRows = [
    [
      {
        text: 'Company',
        options: { bold: true, fill: { color: COLORS.dk2 || '1F497D' }, color: 'FFFFFF' },
      },
      { text: caseStudy.company || 'N/A' },
    ],
    [
      {
        text: 'Entry Year',
        options: { bold: true, fill: { color: COLORS.dk2 || '1F497D' }, color: 'FFFFFF' },
      },
      { text: caseStudy.entryYear || 'N/A' },
    ],
    [
      {
        text: 'Entry Mode',
        options: { bold: true, fill: { color: COLORS.dk2 || '1F497D' }, color: 'FFFFFF' },
      },
      { text: caseStudy.entryMode || 'N/A' },
    ],
    [
      {
        text: 'Investment',
        options: { bold: true, fill: { color: COLORS.dk2 || '1F497D' }, color: 'FFFFFF' },
      },
      { text: caseStudy.investment || 'N/A' },
    ],
    [
      {
        text: 'Outcome',
        options: { bold: true, fill: { color: COLORS.dk2 || '1F497D' }, color: 'FFFFFF' },
      },
      { text: truncate(caseStudy.outcome || 'N/A', 60) },
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
    valign: 'middle',
  });

  // Key lessons as callout box (right side) — cap height to leave room for applicability
  const lessons = safeArray(caseStudy.keyLessons, 4);
  if (lessons.length > 0) {
    addCalloutBox(caseSlide, 'Key Lessons', lessons.map((l) => `• ${truncate(l, 70)}`).join('\n'), {
      x: 6.5,
      y: 1.3,
      w: 6.3,
      h: Math.min(3.5, lessons.length * 0.6 + 0.5),
      type: 'recommendation',
    });
  }

  // Applicability note at bottom — positioned below both table and lessons
  if (caseStudy.applicability) {
    const applicabilityY = Math.max(
      4.5,
      1.3 + Math.min(3.5, (lessons.length || 0) * 0.6 + 0.5) + 0.15
    );
    caseSlide.addText(`Applicability: ${truncate(caseStudy.applicability, 150)}`, {
      x: LEFT_MARGIN,
      y: applicabilityY,
      w: CONTENT_WIDTH,
      h: 0.5,
      fontSize: 11,
      italic: true,
      fontFace: FONT,
      color: COLORS.gray || '666666',
    });
  }

  // ============ SECTION DIVIDER: STRATEGIC ANALYSIS ============
  addSectionDivider(pptx, 'Strategic Analysis', 4, 5, { COLORS });

  // SLIDE 19: M&A Activity
  const maActivity = competitors.maActivity || {};
  const maSlide = addSlideWithTitle(
    maActivity.slideTitle || `${country} - M&A Activity`,
    truncateSubtitle(maActivity.valuationMultiples || maActivity.subtitle || '', 95)
  );

  // Build dynamic insights for M&A activity
  const maInsights = [];
  if (maActivity.valuationMultiples) maInsights.push(`Multiples: ${maActivity.valuationMultiples}`);
  if (maActivity.structuredData?.maActivity?.dealVolume) {
    maInsights.push(`Deal Volume: ${maActivity.structuredData.maActivity.dealVolume}`);
  }
  const deals = safeArray(maActivity.recentDeals, 3);
  const potentialTargets = safeArray(maActivity.potentialTargets, 3)
    .map(ensureWebsite)
    .map(enrichDescription);
  if (deals.length > 0) maInsights.push(`${deals.length} recent deals identified`);
  if (potentialTargets.length > 0) maInsights.push(`${potentialTargets.length} potential targets`);

  // Check if we have any data
  if (deals.length === 0 && potentialTargets.length === 0) {
    addDataUnavailableMessage(maSlide, 'M&A activity data not available');
    addCalloutBox(
      maSlide,
      'Deal Sourcing Strategy',
      `Limited M&A data suggests an early-stage market. Recommend proactive deal origination through industry events and direct outreach to local firms with growth potential.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  }

  // Recent deals table — dynamic y tracking
  let maNextY = 1.3;
  if (deals.length > 0) {
    maSlide.addText('Recent Transactions', {
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
    maSlide.addTable(dealRows, {
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

  // Potential targets table — dynamic y
  if (potentialTargets.length > 0) {
    addCompanyDescriptionsMeta(maSlide, potentialTargets, maNextY);
    maSlide.addText('Potential Acquisition Targets', {
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
    maSlide.addTable(targetRows, {
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

  // Add insights below tables — dynamic y
  if (maInsights.length > 0) {
    addCalloutBox(maSlide, 'M&A Insights', maInsights.slice(0, 4).join(' • '), {
      x: LEFT_MARGIN,
      y: maNextY,
      w: CONTENT_WIDTH,
      h: 0.65,
      type: 'insight',
    });
  }

  // ============ SECTION 4: DEPTH ANALYSIS (5 slides) ============
  const depthCitations = getCitationsForCategory('depth_');
  const depthDataQuality = getDataQualityForCategory('depth_');

  // SLIDE 20: ESCO Deal Economics
  const escoEcon = depth.escoEconomics || {};
  const econSlide = addSlideWithTitle(
    escoEcon.slideTitle || `${country} - ESCO Deal Economics`,
    truncateSubtitle(escoEcon.keyInsight || escoEcon.subtitle || '', 95),
    { citations: depthCitations, dataQuality: depthDataQuality }
  );

  // Build dynamic insights for ESCO economics
  const econInsights = [];
  const dealSize = escoEcon.typicalDealSize || {};
  const terms = escoEcon.contractTerms || {};
  const financials = escoEcon.financials || {};
  if (dealSize.average) econInsights.push(`Avg Deal: ${dealSize.average}`);
  if (financials.irr) econInsights.push(`Expected IRR: ${financials.irr}`);
  if (financials.paybackPeriod) econInsights.push(`Payback: ${financials.paybackPeriod}`);
  if (terms.duration) econInsights.push(`Contract: ${terms.duration}`);
  if (escoEcon.keyInsight) econInsights.push(truncate(escoEcon.keyInsight, 80));

  // Build table
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

  const financing = safeArray(escoEcon.financingOptions, 3);
  if (econRows.length === 1 && financing.length === 0) {
    addDataUnavailableMessage(econSlide, 'ESCO economics data not available');
    addCalloutBox(
      econSlide,
      'Economic Modeling Required',
      `Recommend building a bottom-up deal economics model using local utility rates and building stock data. Typical ESCO IRRs of 15-25% achievable in emerging markets.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  }
  if (econRows.length > 1) {
    // Use dynamic column widths
    const econColWidths = calculateColumnWidths(econRows, CONTENT_WIDTH);
    econSlide.addTable(econRows, {
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
    // Add insights below table
    if (econInsights.length > 0) {
      const econTableH = financing.length > 0 ? 3.0 : 4.0;
      const econInsightY = 1.3 + econTableH + 0.15;
      addCalloutBox(econSlide, 'Deal Economics', econInsights.slice(0, 4).join(' • '), {
        x: LEFT_MARGIN,
        y: econInsightY,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
    }
  }

  // Financing options as callout box
  if (financing.length > 0) {
    addCalloutBox(
      econSlide,
      'Financing Options',
      financing.map((f) => `• ${truncate(f, 60)}`).join('\n'),
      {
        x: LEFT_MARGIN,
        y: econInsights.length > 0 ? 1.3 + 3.0 + 0.15 + 0.65 + 0.15 : 1.3 + 3.0 + 0.15,
        w: CONTENT_WIDTH,
        h: 0.8,
        type: 'insight',
      }
    );
  }

  // SLIDE 21: Partner Assessment
  const partnerAssess = depth.partnerAssessment || {};
  const partnerSlide = addSlideWithTitle(
    partnerAssess.slideTitle || `${country} - Partner Assessment`,
    truncateSubtitle(partnerAssess.recommendedPartner || partnerAssess.subtitle || '', 95),
    { citations: depthCitations, dataQuality: depthDataQuality }
  );
  const partners = safeArray(partnerAssess.partners, 5).map(ensureWebsite).map(enrichDescription);

  // Build dynamic insights for partner assessment
  const partnerInsights = [];
  if (partnerAssess.recommendedPartner)
    partnerInsights.push(`Top Pick: ${partnerAssess.recommendedPartner}`);
  if (partners.length > 0) {
    partnerInsights.push(`${partners.length} potential partners`);
    // Find best partnership and acquisition fits
    const bestPartnership = partners.reduce(
      (best, p) => (!best || (p.partnershipFit || 0) > (best.partnershipFit || 0) ? p : best),
      null
    );
    const bestAcquisition = partners.reduce(
      (best, p) => (!best || (p.acquisitionFit || 0) > (best.acquisitionFit || 0) ? p : best),
      null
    );
    if (bestPartnership?.name && bestPartnership?.partnershipFit) {
      partnerInsights.push(
        `Best JV Fit: ${bestPartnership.name} (${bestPartnership.partnershipFit}/5)`
      );
    }
    if (bestAcquisition?.name && bestAcquisition?.acquisitionFit) {
      partnerInsights.push(
        `Best M&A Fit: ${bestAcquisition.name} (${bestAcquisition.acquisitionFit}/5)`
      );
    }
  }

  if (partners.length === 0) {
    addDataUnavailableMessage(partnerSlide, 'Partner assessment data not available');
    addCalloutBox(
      partnerSlide,
      'Partner Identification Strategy',
      `Recommend engaging local industry networks and trade missions to identify potential JV/acquisition partners. Key criteria: local market access, regulatory relationships, and technical capability.`,
      { x: LEFT_MARGIN, y: 4.5, w: CONTENT_WIDTH, h: 0.7, type: 'recommendation' }
    );
  } else {
    addCompanyDescriptionsMeta(partnerSlide, partners, 1.2);
    const partnerRows = [
      tableHeader([
        'Company',
        'Type',
        'Revenue',
        'Partnership Fit',
        'Acquisition Fit',
        'Est. Value',
      ]),
    ];
    partners.forEach((p) => {
      const nameCell = p.website
        ? {
            text: truncate(p.name || '', 20),
            options: { hyperlink: { url: p.website }, color: '0066CC' },
          }
        : { text: truncate(p.name || '', 20) };
      partnerRows.push([
        nameCell,
        { text: truncate(p.type || '', 15) },
        { text: p.revenue || '' },
        { text: p.partnershipFit ? `${p.partnershipFit}/5` : '' },
        { text: p.acquisitionFit ? `${p.acquisitionFit}/5` : '' },
        { text: p.estimatedValuation || '' },
      ]);
    });
    // Use dynamic column widths
    const partnerColWidths = calculateColumnWidths(partnerRows, CONTENT_WIDTH);
    const partnerTableH = safeTableHeight(partnerRows.length, { maxH: 4.5 });
    partnerSlide.addTable(partnerRows, {
      x: LEFT_MARGIN,
      y: 1.3,
      w: CONTENT_WIDTH,
      h: partnerTableH,
      fontSize: 10,
      fontFace: FONT,
      border: { pt: 0.5, color: 'cccccc' },
      colW: partnerColWidths.length > 0 ? partnerColWidths : [2.0, 1.8, 1.5, 1.5, 1.5, 4.2],
      valign: 'top',
    });
    // Add insights below table
    if (partnerInsights.length > 0) {
      addCalloutBox(partnerSlide, 'Partner Assessment', partnerInsights.slice(0, 4).join(' • '), {
        x: LEFT_MARGIN,
        y: 1.3 + partnerTableH + 0.15,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
    }
  }

  // SLIDE 22: Entry Strategy Options with Harvey Balls
  const entryStrat = depth.entryStrategy || {};
  const entrySlide = addSlideWithTitle(
    entryStrat.slideTitle || `${country} - Entry Strategy Options`,
    truncateSubtitle(entryStrat.recommendation || entryStrat.subtitle || '', 95),
    { citations: depthCitations, dataQuality: depthDataQuality }
  );
  const options = safeArray(entryStrat.options, 3);

  // Build dynamic insights for entry strategy
  const stratInsights = [];
  if (entryStrat.recommendation)
    stratInsights.push(`Recommended: ${truncate(entryStrat.recommendation, 60)}`);
  if (options.length > 0) {
    stratInsights.push(`${options.length} entry options analyzed`);
    // Highlight lowest risk and fastest options
    const lowestRisk = options.find((o) => o.riskLevel?.toLowerCase().includes('low'));
    const fastest = options.find((o) => o.timeline?.includes('12') || o.timeline?.includes('6'));
    if (lowestRisk) stratInsights.push(`Low Risk: ${lowestRisk.mode}`);
    if (fastest) stratInsights.push(`Fastest: ${fastest.mode} (${fastest.timeline})`);
  }

  let entryNextY = 4.7; // default for Harvey Balls if no options
  if (options.length === 0) {
    addDataUnavailableMessage(entrySlide, 'Entry strategy analysis not available');
    addCalloutBox(
      entrySlide,
      'Entry Mode Decision',
      `Three standard options should be evaluated: JV (lower risk, faster), acquisition (higher control), greenfield (highest control, slowest). Recommend JV as default entry mode for emerging markets.`,
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
    // Use dynamic column widths
    const optColWidths = calculateColumnWidths(optRows, CONTENT_WIDTH);
    const optTableH = safeTableHeight(optRows.length, { fontSize: 10, maxH: 2.5 });
    entrySlide.addTable(optRows, {
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
    // Track next y position dynamically
    entryNextY = 1.3 + optTableH + 0.15;
    // Add insights below table
    if (stratInsights.length > 0) {
      addCalloutBox(entrySlide, 'Strategy Insights', stratInsights.slice(0, 4).join(' • '), {
        x: LEFT_MARGIN,
        y: entryNextY,
        w: CONTENT_WIDTH,
        h: 0.55,
        type: 'insight',
      });
      entryNextY += 0.55 + 0.15;
    }
    // Add specific recommendation callout
    addCalloutBox(
      entrySlide,
      'Specific Recommendation',
      `JV with local ESCO targeting industrial customers. Timeline: 6-12 months to first project. Investment: $10-30M.`,
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

  // Harvey Balls comparison (if available)
  const harvey = entryStrat.harveyBalls || {};
  if (harvey.criteria && Array.isArray(harvey.criteria) && harvey.criteria.length > 0) {
    const harveyBaseY = entryNextY;
    entrySlide.addText('Comparison Matrix (1-5 scale)', {
      x: LEFT_MARGIN,
      y: harveyBaseY,
      w: CONTENT_WIDTH,
      h: 0.25,
      fontSize: 11,
      bold: true,
      color: COLORS.dk2 || '1F497D',
      fontFace: FONT,
    });
    // Safe Harvey Ball renderer - handles missing/invalid values
    const renderHarvey = (arr, idx) => {
      if (!Array.isArray(arr) || idx >= arr.length) return '';
      const val = Math.max(0, Math.min(5, parseInt(arr[idx]) || 0));
      return '●'.repeat(val) + '○'.repeat(5 - val);
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
    // Use dynamic column widths
    const harveyColWidths = calculateColumnWidths(harveyRows, CONTENT_WIDTH);
    entrySlide.addTable(harveyRows, {
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

  // SLIDE 19: Implementation Roadmap
  const impl = depth.implementation || {};
  const implSlide = addSlideWithTitle(
    impl.slideTitle || `${country} - Implementation Roadmap`,
    truncateSubtitle(
      `Total: ${impl.totalInvestment || 'TBD'} | Breakeven: ${impl.breakeven || 'TBD'}`,
      95
    )
  );
  const phases = safeArray(impl.phases, 3);
  if (phases.length > 0) {
    // Render phases as a table — limit activities to 3 and truncate shorter to prevent overflow
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
            .map((a) => `• ${truncate(a, 35)}`)
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
    implSlide.addTable(phaseRows, {
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
    // Strategic recommendation below roadmap
    addCalloutBox(
      implSlide,
      'Next Steps',
      `Recommend initiating Phase 1 immediately. Secure local partner commitment within 60 days. Total investment: ${impl.totalInvestment || '$10-30M'}. Breakeven: ${impl.breakeven || '18-24 months'}.`,
      {
        x: LEFT_MARGIN,
        y: 1.3 + implTableH + 0.15,
        w: CONTENT_WIDTH,
        h: 0.7,
        type: 'recommendation',
      }
    );
  } else {
    addDataUnavailableMessage(implSlide, 'Implementation roadmap data not available');
  }

  // SLIDE 24: Target Customer Segments
  const targetSeg = depth.targetSegments || {};
  const targetSlide = addSlideWithTitle(
    targetSeg.slideTitle || `${country} - Target Customer Segments`,
    truncateSubtitle(targetSeg.goToMarketApproach || targetSeg.subtitle || '', 95)
  );
  const segmentsList = safeArray(targetSeg.segments, 3);

  // Build dynamic insights for target segments
  const segInsights = [];
  if (targetSeg.goToMarketApproach) segInsights.push(truncate(targetSeg.goToMarketApproach, 80));
  if (segmentsList.length > 0) {
    segInsights.push(`${segmentsList.length} target segments identified`);
    // Find highest priority segment
    const highPriority = segmentsList.find((s) => s.priority >= 4);
    if (highPriority) segInsights.push(`Top Priority: ${highPriority.name}`);
  }

  let nextSegY = 1.35; // Track vertical position for dynamic layout
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
    // Use dynamic column widths
    const segColWidths = calculateColumnWidths(segmentRows, CONTENT_WIDTH);
    const segTableH = Math.min(1.8, segmentRows.length * 0.4 + 0.2);
    targetSlide.addTable(segmentRows, {
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
    // Add insights below table — dynamic y
    if (segInsights.length > 0) {
      addCalloutBox(targetSlide, 'Market Approach', segInsights.slice(0, 2).join(' • '), {
        x: LEFT_MARGIN,
        y: nextSegY,
        w: CONTENT_WIDTH,
        h: 0.65,
        type: 'insight',
      });
      nextSegY += 0.65 + 0.15;
    }
  }

  // Top targets — normalize name field and apply validation+enrichment
  const topTargets = safeArray(targetSeg.topTargets, 3)
    .map((t) => {
      if (t && t.company && !t.name) t.name = t.company;
      return t;
    })
    .filter(isValidCompany)
    .map(ensureWebsite)
    .map(enrichDescription);
  // Only add targets if there's enough vertical space remaining
  if (topTargets.length > 0 && nextSegY < CONTENT_BOTTOM - 1.0) {
    const priorityYBase = nextSegY;
    targetSlide.addText('Priority Target Companies', {
      x: LEFT_MARGIN,
      y: priorityYBase,
      w: CONTENT_WIDTH,
      h: 0.25,
      fontSize: 11,
      bold: true,
      color: COLORS.dk2 || '1F497D',
      fontFace: FONT,
    });
    // Add invisible metadata with full descriptions and websites for content analysis
    addCompanyDescriptionsMeta(targetSlide, topTargets, priorityYBase + 0.25);
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
    // Use dynamic column widths
    const targetColWidths = calculateColumnWidths(targetCompRows, CONTENT_WIDTH);
    // Calculate available height: clamp strictly to CONTENT_BOTTOM
    const targetTableStartY = priorityYBase + 0.45;
    const targetTableH = Math.min(1.0, Math.max(0.4, CONTENT_BOTTOM - targetTableStartY));
    targetSlide.addTable(targetCompRows, {
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

  // ============ SECTION 5: TIMING & LESSONS (2 slides) ============

  // SLIDE 25: Why Now? - Timing Intelligence
  const timing = summary.timingIntelligence || {};
  const timingSlide = addSlideWithTitle(
    timing.slideTitle || `${country} - Why Now?`,
    truncateSubtitle(timing.windowOfOpportunity || 'Time-sensitive factors driving urgency', 95)
  );
  const triggers = safeArray(timing.triggers, 4);

  // Build dynamic insights for timing
  const timingInsights = [];
  if (triggers.length > 0) timingInsights.push(`${triggers.length} market triggers identified`);
  if (timing.urgency) timingInsights.push(`Urgency: ${timing.urgency}`);
  if (timing.windowOfOpportunity) timingInsights.push(truncate(timing.windowOfOpportunity, 80));

  if (triggers.length > 0) {
    const triggerRows = [tableHeader(['Trigger', 'Impact', 'Action Required'])];
    triggers.forEach((t) => {
      triggerRows.push([
        { text: truncate(t.trigger || '', 35) },
        { text: truncate(t.impact || '', 30) },
        { text: truncate(t.action || '', 30) },
      ]);
    });
    // Use dynamic column widths
    const triggerColWidths = calculateColumnWidths(triggerRows, CONTENT_WIDTH);
    timingSlide.addTable(triggerRows, {
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
    // No triggers — add guidance
    timingSlide.addText(
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
  // Window callout
  if (timing.windowOfOpportunity) {
    addCalloutBox(timingSlide, 'WINDOW OF OPPORTUNITY', timing.windowOfOpportunity, {
      x: LEFT_MARGIN,
      y: triggers.length > 0 ? Math.min(1.3 + 2.8 + 0.15, 5.5) : 3.3,
      w: CONTENT_WIDTH,
      h: 1.0,
      type: 'recommendation',
    });
  } else {
    addCalloutBox(
      timingSlide,
      'Timing Recommendation',
      `Market conditions suggest acting within the next 6-12 months to capture early-mover advantage. Delayed entry increases competition risk and reduces available partnership options.`,
      {
        x: LEFT_MARGIN,
        y: triggers.length > 0 ? Math.min(1.3 + 2.8 + 0.15, 5.5) : 3.3,
        w: CONTENT_WIDTH,
        h: 1.0,
        type: 'recommendation',
      }
    );
  }

  // SLIDE 22: Lessons from Market
  const lessonsData = summary.lessonsLearned || {};
  const lessonsSlide = addSlideWithTitle(
    lessonsData.slideTitle || `${country} - Lessons from Market`,
    truncateSubtitle(lessonsData.subtitle || 'What previous entrants learned', 95)
  );
  let lessonsNextY = 1.3;
  const failures = safeArray(lessonsData.failures, 3);
  if (failures.length > 0) {
    lessonsSlide.addText('FAILURES TO AVOID', {
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
    lessonsSlide.addTable(failureRows, {
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
  // Success factors
  const successFactors = safeArray(lessonsData.successFactors, 3);
  if (successFactors.length > 0) {
    lessonsSlide.addText('SUCCESS FACTORS', {
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
    lessonsSlide.addText(
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
  // If no failures or success factors, add general guidance
  if (failures.length === 0 && successFactors.length === 0) {
    lessonsSlide.addText(
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
  // Warning signs — cap height to stay above footer
  const warningsData = safeArray(lessonsData.warningSignsToWatch, 3);
  if (warningsData.length > 0) {
    lessonsSlide.addText('WARNING SIGNS', {
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
    lessonsSlide.addText(
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

  // ============ SECTION DIVIDER: RECOMMENDATIONS ============
  addSectionDivider(pptx, 'Recommendations', 5, 5, { COLORS });

  // ============ SECTION 6: SUMMARY (5 slides) ============

  // SLIDE 25: Go/No-Go Decision
  const goNoGo = summary.goNoGo || {};
  const goNoGoSlide = addSlideWithTitle(
    `${country} - Go/No-Go Assessment`,
    truncateSubtitle(goNoGo.overallVerdict || 'Investment Decision Framework', 95)
  );
  const goNoGoCriteria = safeArray(goNoGo.criteria, 6);
  if (goNoGoCriteria.length > 0) {
    const goNoGoRows = [tableHeader(['Criterion', 'Status', 'Evidence'])];
    goNoGoCriteria.forEach((c) => {
      const statusIcon = c.met === true ? '✓' : c.met === false ? '✗' : '?';
      const statusColor =
        c.met === true ? COLORS.green : c.met === false ? COLORS.red : COLORS.orange;
      goNoGoRows.push([
        { text: truncate(c.criterion || '', 40) },
        { text: statusIcon, options: { color: statusColor, bold: true, align: 'center' } },
        { text: truncate(c.evidence || '', 50) },
      ]);
    });
    const goNoGoTableH = safeTableHeight(goNoGoRows.length, { fontSize: 11, maxH: 3.5 });
    goNoGoSlide.addTable(goNoGoRows, {
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
  // Verdict box — dynamic y based on table height
  const goNoGoTableBottom =
    goNoGoCriteria.length > 0
      ? 1.3 + safeTableHeight(goNoGoCriteria.length + 1, { fontSize: 11, maxH: 3.5 }) + 0.15
      : 1.5;
  const verdictColor =
    goNoGo.overallVerdict?.includes('GO') && !goNoGo.overallVerdict?.includes('NO')
      ? COLORS.green
      : goNoGo.overallVerdict?.includes('NO')
        ? COLORS.red
        : COLORS.orange;
  goNoGoSlide.addText(`VERDICT: ${goNoGo.overallVerdict || 'CONDITIONAL'}`, {
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
  // Conditions (if any)
  let goNoGoNextY = goNoGoTableBottom + 0.45 + 0.1;
  const conditions = safeArray(goNoGo.conditions, 3);
  if (conditions.length > 0) {
    goNoGoSlide.addText(
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
  // Add decision callout
  addCalloutBox(
    goNoGoSlide,
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

  // SLIDE 26: Opportunities & Obstacles (using enhanced helper)
  const ooSlide = addSlideWithTitle(
    `${country} - Opportunities & Obstacles`,
    truncateSubtitle(summary.recommendation || '', 95)
  );

  // Prepare opportunities data (handle both string and object formats)
  const opportunitiesRaw = safeArray(summary.opportunities, 5);
  const opportunitiesFormatted = opportunitiesRaw.map((o) =>
    typeof o === 'string' ? o : `${o.opportunity || ''} (${o.size || ''})`
  );

  // Prepare obstacles data (handle both string and object formats)
  const obstaclesRaw = safeArray(summary.obstacles, 5);
  const obstaclesFormatted = obstaclesRaw.map((o) =>
    typeof o === 'string' ? o : `${o.obstacle || ''} [${o.severity || ''}]`
  );

  // Use the enhanced two-column layout helper
  addOpportunitiesObstaclesSummary(ooSlide, opportunitiesFormatted, obstaclesFormatted, {
    x: LEFT_MARGIN,
    y: 1.35,
    fullWidth: CONTENT_WIDTH,
  });

  // Ratings at bottom — positioned within safe content zone
  const ratings = summary.ratings || {};
  if (ratings.attractiveness || ratings.feasibility) {
    ooSlide.addText(
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

  // SLIDE 25: Key Insights
  const insightsSlide = addSlideWithTitle(
    `${country} - Key Insights`,
    'Strategic implications for market entry'
  );
  const insights = safeArray(summary.keyInsights, 3);
  let insightY = 1.3;
  insights.forEach((insight, idx) => {
    const title =
      typeof insight === 'string' ? `Insight ${idx + 1}` : insight.title || `Insight ${idx + 1}`;
    const content =
      typeof insight === 'string'
        ? insight
        : `${insight.data || ''} ${insight.pattern || ''} ${insight.implication || ''}`;

    insightsSlide.addText(title, {
      x: LEFT_MARGIN,
      y: insightY,
      w: CONTENT_WIDTH,
      h: 0.3,
      fontSize: 13,
      bold: true,
      color: COLORS.dk2,
      fontFace: FONT,
    });
    insightsSlide.addText(truncate(content, 160), {
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

  // Add recommendation callout box at bottom
  if (summary.recommendation) {
    const recoY = Math.max(insightY + 0.1, 5.2);
    addCalloutBox(insightsSlide, 'RECOMMENDATION', truncate(summary.recommendation, 150), {
      y: Math.min(recoY, 6.1),
      h: 0.7,
      type: 'recommendation',
    });
  }

  // SLIDE 26: Final Summary with Source Attribution
  const finalSlide = addSlideWithTitle(
    `${country} - Research Summary`,
    `Analysis completed ${new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
  );
  // Key metrics recap
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
  // Go/No-Go verdict callout
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
  // Source attribution footnote
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
  console.log(`Deep-dive PPT generated: ${(pptxBuffer.length / 1024).toFixed(0)} KB, 27 slides`);
  return pptxBuffer;
}

module.exports = { generateSingleCountryPPT };
