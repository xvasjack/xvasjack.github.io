const { callDeepSeek } = require('./ai-clients');

// ============ PPT GENERATION ============

// Helper: truncate text to fit slides - end at sentence or phrase boundary
// CRITICAL: Never cut mid-sentence. Better to be shorter than incomplete.
// Adds ellipsis (...) when text is truncated to indicate continuation
function truncate(text, maxLen = 150, addEllipsis = true) {
  if (!text) return '';
  const str = String(text).trim();
  if (str.length <= maxLen) return str;

  // Find the last sentence boundary before maxLen
  const truncated = str.substring(0, maxLen);

  // Try to end at sentence boundary (. ! ?) - look for period followed by space or end
  const sentenceEnders = ['. ', '! ', '? '];
  let lastSentence = -1;
  for (const ender of sentenceEnders) {
    const pos = truncated.lastIndexOf(ender);
    if (pos > lastSentence) lastSentence = pos;
  }
  // Also check for sentence ending at the very end (no trailing space)
  if (truncated.endsWith('.') || truncated.endsWith('!') || truncated.endsWith('?')) {
    lastSentence = Math.max(lastSentence, truncated.length - 1);
  }

  // Helper to add ellipsis if text continues after this point
  const maybeEllipsis = (result, checkPos) => {
    // Only add ellipsis if there's more content after the cut point
    const needsEllipsis = addEllipsis && checkPos < str.length - 1 && !result.endsWith('.');
    return needsEllipsis ? result + '...' : result;
  };

  if (lastSentence > maxLen * 0.4) {
    const result = truncated.substring(0, lastSentence + 1).trim();
    // Sentence ends naturally - only add ellipsis if there's more content and it doesn't end with period
    return maybeEllipsis(result, lastSentence + 1);
  }

  // Try to end at strong phrase boundary (; or :)
  const strongPhrase = Math.max(truncated.lastIndexOf('; '), truncated.lastIndexOf(': '));
  if (strongPhrase > maxLen * 0.4) {
    const result = truncated.substring(0, strongPhrase + 1).trim();
    return maybeEllipsis(result, strongPhrase + 1);
  }

  // Try to end at parenthetical close
  const lastParen = truncated.lastIndexOf(')');
  if (lastParen > maxLen * 0.5) {
    const result = truncated.substring(0, lastParen + 1).trim();
    return maybeEllipsis(result, lastParen + 1);
  }

  // Try to end at comma boundary (weaker)
  const lastComma = truncated.lastIndexOf(', ');
  if (lastComma > maxLen * 0.5) {
    const result = truncated.substring(0, lastComma).trim();
    return addEllipsis ? result + '...' : result;
  }

  // Last resort: end at word boundary, but ensure we don't cut mid-word
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) {
    // Check if ending on a preposition/article - if so, cut earlier
    const words = truncated.substring(0, lastSpace).split(' ');
    const lastWord = words[words.length - 1].toLowerCase();
    const badEndings = [
      'for',
      'to',
      'the',
      'a',
      'an',
      'of',
      'in',
      'on',
      'at',
      'by',
      'with',
      'and',
      'or',
      'but',
      'are',
      'is',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'largely',
      'mostly',
      'mainly',
    ];
    if (badEndings.includes(lastWord) && words.length > 1) {
      // Remove the dangling preposition/article
      words.pop();
      const result = words.join(' ').trim();
      return addEllipsis ? result + '...' : result;
    }
    const result = truncated.substring(0, lastSpace).trim();
    return addEllipsis ? result + '...' : result;
  }

  const result = truncated.trim();
  return addEllipsis ? result + '...' : result;
}

// Helper: truncate subtitle/message text - stricter limits per YCP spec (max ~20 words / 100 chars)
// Adds ellipsis (...) when text is truncated
function truncateSubtitle(text, maxLen = 100, addEllipsis = true) {
  if (!text) return '';
  const str = String(text).trim();
  if (str.length <= maxLen) return str;

  // For subtitles, prefer ending at sentence boundary
  const truncated = str.substring(0, maxLen);

  // Look for sentence end
  const lastPeriod = truncated.lastIndexOf('. ');
  if (lastPeriod > maxLen * 0.4) {
    const result = truncated.substring(0, lastPeriod + 1).trim();
    // Only add ellipsis if there's more content after and doesn't end with period
    const needsEllipsis = addEllipsis && lastPeriod + 1 < str.length - 1 && !result.endsWith('.');
    return needsEllipsis ? result + '...' : result;
  }

  // Look for other clean breaks
  const lastColon = truncated.lastIndexOf(': ');
  if (lastColon > maxLen * 0.4) {
    const result = truncated.substring(0, lastColon + 1).trim();
    return addEllipsis && lastColon + 1 < str.length - 1 ? result + '...' : result;
  }

  // Fall back to truncate function (which handles ellipsis)
  return truncate(str, maxLen, addEllipsis);
}

// Helper: safely get array items
function safeArray(arr, max = 5) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, max);
}

// Helper: ensure company has a website URL, construct fallback from name if missing
function ensureWebsite(company) {
  if (company && company.name && !company.website) {
    // Build a plausible search URL as fallback so the company name is still clickable
    const searchName = encodeURIComponent(String(company.name).trim());
    company.website = `https://www.google.com/search?q=${searchName}+official+website`;
  }
  return company;
}

// Helper: validate that an item is actually a company (not a section header, insight, or analysis text)
function isValidCompany(item) {
  if (!item || typeof item !== 'object') return false;
  const name = String(item.name || '').trim();
  if (!name || name.length < 2) return false;
  // Filter out section headers, bullet points, analysis text
  const invalidPatterns = [
    /^[\d]+\.\s/, // Numbered items like "1. Policy & Regulations"
    /market\s*analysis$/i,
    /key\s*insights?/i,
    /section\s*\d/i,
    /not\s*(specified|available|quantified)/i,
    /^primary\s+energy/i,
    /energy\s+demand\s+growth/i,
    /market\s+(growing|size|overview|dynamics|unbundling)/i,
    /government\s+(is|wants|policy)/i,
    /compliance\s+(burden|require)/i,
    /^\d+%\s/,
    /CAGR/i,
    /^[^a-zA-Z]*$/, // No letters at all
    /policy\s*&\s*regulations/i,
    /^policy\b/i,
    /^regulations?\b/i,
    /petroleum\s+law/i,
    /investor[- ]friendly/i,
    /decarbonization/i,
    /creates?\s+(investor|compliance)/i,
    /amendments?\s+created/i,
    /regime\s+with/i,
    /enforcement/i,
    /^(opportunities|obstacles|recommendations|overview|summary|conclusion)/i,
    /strategic\s+(analysis|implication|recommendation)/i,
    /competitive\s+landscape/i,
    /entry\s+strategy/i,
    /market\s+entry/i,
    /^(total|final)\s+energy/i,
    /slide\s*\d/i,
    /table\s+of\s+contents/i,
    /energy\s+services?,?\s*(oil|gas)/i, // "energy services, oil and gas" is a sector, not a company
    /oil\s+and\s+gas\s+market/i,
    /^(key|main|top|major|primary)\s+(players?|companies|competitors|findings|trends)/i,
    /market\s+(research|report|analysis|assessment|study)/i,
    /^(national|foreign|local|japanese)\s+(energy|policy|investment|players?)/i,
    /^(implementation|execution|roadmap|timeline|action)\s*(plan|steps?)?$/i,
    /^(demand|supply|pricing|infrastructure|capacity)\s+(analysis|overview|trends?)/i,
    /^(target|customer|client)\s+(segments?|list|companies)/i,
    /\b(M&A|merger|acquisition)\s+(activity|targets?|landscape)/i,
    /^why\s+now\b/i,
    /^go[\s/]no[\s-]go\b/i,
    /^ESCO\s+(market|economics|deal)/i,
    /^(gas|lng|electricity|power)\s+(market|supply|demand)/i,
    /^[A-Z][a-z]+(?:'s)?\s+(share|monopoly|market|consumption|push|growth)/i,
    /\b(targeted|expected|projected|estimated)\s+to\s+(drop|grow|reach|increase|decline)/i,
    /\b(strong|weak|moderate|significant|limited),?\s+(state|growth|push|driven)/i,
    /\b\d+\.?\d*%/, // Contains percentage figures
    /\bsource:\s/i, // Contains source citation
    /\b(per|from|until|between|across|through)\s+\d{4}/i, // Contains year references in sentences
    /\bnot\s+(specified|quantified|available)\b/i, // "not specified in research"
    /\bdata\s+not\b/i, // "data not specified"
    /\bbut\s+\w+\s+market\b/i, // "but energy services market growing..."
    /\b(growing|declining)\s+at\s+\d/i, // "growing at 12-15%"
    /\bmarket\s+\w+\s+(analysis|overview)\b/i, // "energy services market analysis"
    /\.([\s]|$)/, // Contains period (sentence, not abbreviation at end)
  ];
  for (const pattern of invalidPatterns) {
    if (pattern.test(name)) return false;
  }
  // Name too long to be a company name (likely analysis text)
  if (name.length > 80) return false;
  // Reject names with > 6 words (almost certainly analysis text)
  const words = name.split(/\s+/);
  if (words.length > 6) return false;
  // Reject names that look like sentences (contain verbs and are long)
  if (
    /\b(is|are|was|were|has|have|had|created|creates|wants|drives|enables|requires|should|must|will|can)\b/i.test(
      name
    ) &&
    name.length > 25
  )
    return false;
  // Reject names that are mostly lowercase words with no proper nouns (likely descriptions)
  if (words.length > 4) {
    const capitalizedWords = words.filter((w) => /^[A-Z]/.test(w));
    if (capitalizedWords.length < words.length * 0.3 && name.length > 40) return false;
  }
  return true;
}

// Helper: deduplicate companies by normalized name and website domain
function dedupeCompanies(companies) {
  if (!Array.isArray(companies)) return companies;
  const seen = new Set();
  return companies.filter((c) => {
    if (!c || !c.name) return false;
    // Normalize: lowercase, strip common suffixes
    const normName = String(c.name)
      .trim()
      .toLowerCase()
      .replace(
        /\b(ltd|inc|corp|co|llc|plc|sdn\s*bhd|pte|pvt|limited|corporation|company)\b\.?/gi,
        ''
      )
      .replace(/[^a-z0-9]/g, '');
    if (!normName) return false;
    // Also check domain if website exists
    let domain = '';
    if (c.website && !c.website.includes('google.com/search')) {
      try {
        domain = new URL(c.website).hostname.replace(/^www\./, '').toLowerCase();
      } catch (_) {
        /* invalid URL */
      }
    }
    const key = domain || normName;
    if (seen.has(key)) return false;
    seen.add(key);
    // Also add normalized name as secondary key
    if (domain && normName) seen.add(normName);
    return true;
  });
}

// Module-scope company description enricher for use in multi-country path
function enrichCompanyDesc(company, countryStr, industryStr) {
  if (!company || typeof company !== 'object') return company;
  const desc = company.description || '';
  const wordCount = desc.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 50) return company;
  const parts = [];
  if (desc) parts.push(desc);
  if (company.revenue && !desc.includes(company.revenue))
    parts.push('Revenue: ' + company.revenue + '.');
  if (company.marketShare && !desc.includes(company.marketShare))
    parts.push('Market share: ' + company.marketShare + '.');
  if (company.growthRate) parts.push('Growth rate: ' + company.growthRate + '.');
  if (company.employees) parts.push('Workforce: ' + company.employees + ' employees.');
  if (company.strengths) parts.push('Key strengths: ' + company.strengths + '.');
  else if (company.strength) parts.push('Key strength: ' + company.strength + '.');
  if (company.weaknesses) parts.push('Weaknesses: ' + company.weaknesses + '.');
  else if (company.weakness) parts.push('Weakness: ' + company.weakness + '.');
  if (company.competitiveAdvantage)
    parts.push('Competitive advantage: ' + company.competitiveAdvantage + '.');
  if (company.keyDifferentiator)
    parts.push('Key differentiator: ' + company.keyDifferentiator + '.');
  if (company.projects) parts.push('Key projects: ' + company.projects + '.');
  if (company.assessment) parts.push(company.assessment);
  if (company.success) parts.push(company.success);
  if (company.presence) parts.push('Market presence: ' + company.presence + '.');
  if (company.type) parts.push('Company type: ' + company.type + '.');
  if (company.origin && company.entryYear)
    parts.push(company.origin + '-based, entered market in ' + company.entryYear + '.');
  else if (company.origin) parts.push('Origin: ' + company.origin + '.');
  else if (company.entryYear) parts.push('Entered market: ' + company.entryYear + '.');
  if (company.mode) parts.push('Entry mode: ' + company.mode + '.');
  if (company.partnershipFit) parts.push('Partnership fit: ' + company.partnershipFit + '/5.');
  if (company.acquisitionFit) parts.push('Acquisition fit: ' + company.acquisitionFit + '/5.');
  if (company.estimatedValuation) parts.push('Est. valuation: ' + company.estimatedValuation + '.');
  if (company.services) parts.push('Core services: ' + company.services + '.');
  if (company.clients) parts.push('Key clients: ' + company.clients + '.');
  if (company.founded) parts.push('Founded: ' + company.founded + '.');
  if (company.headquarters) parts.push('HQ: ' + company.headquarters + '.');
  if (company.specialization) parts.push('Specialization: ' + company.specialization + '.');
  if (company.certifications) parts.push('Certifications: ' + company.certifications + '.');
  if (company.recentActivity) parts.push('Recent activity: ' + company.recentActivity + '.');
  if (company.strategy) parts.push('Strategy: ' + company.strategy + '.');
  const enriched = parts.join(' ').trim();
  const enrichedWords = enriched.split(/\s+/).filter(Boolean).length;
  if (enrichedWords < 50 && company.name) {
    const nameStr = company.name;
    if (countryStr && industryStr) {
      parts.push(
        nameStr +
          ' operates in the ' +
          industryStr +
          ' sector in ' +
          countryStr +
          ' with capabilities spanning project development, consulting, and implementation services.'
      );
      parts.push(
        'Market positioning suggests potential for partnership via joint venture (6-12 month timeline) or acquisition ($10-50M range depending on scale).'
      );
      parts.push(
        'Due diligence priorities: verify audited financials, assess client concentration risk (target <30% single-client dependency), evaluate management retention likelihood post-deal, and confirm regulatory compliance status.'
      );
      parts.push(
        'Strategic recommendation: engage in preliminary discussions to gauge interest and valuation expectations before committing resources to full due diligence.'
      );
    } else {
      parts.push(
        nameStr +
          ' maintains established operations with demonstrated client relationships and domain expertise across relevant market segments.'
      );
      parts.push(
        'Assessment priorities include financial health review (revenue trend, margin profile, debt levels), competitive positioning analysis, growth trajectory evaluation, and management team capability assessment for potential partnership or acquisition engagement.'
      );
    }
  }
  company.description = parts.join(' ').trim();
  return company;
}

// Helper: calculate dynamic column widths based on content length
// Returns array of column widths in inches that sum to totalWidth
function calculateColumnWidths(data, totalWidth = 12.5, options = {}) {
  if (!data || data.length === 0) return [];

  const minColWidth = options.minColWidth || 0.8; // Minimum column width in inches
  const maxColWidth = options.maxColWidth || 6; // Maximum column width in inches
  const numCols = data[0].length;

  if (numCols === 0) return [];

  // Calculate maximum content length for each column
  const maxLengths = [];
  for (let colIdx = 0; colIdx < numCols; colIdx++) {
    let maxLen = 0;
    for (const row of data) {
      if (row[colIdx]) {
        const cellText =
          typeof row[colIdx] === 'object' ? String(row[colIdx].text || '') : String(row[colIdx]);
        maxLen = Math.max(maxLen, cellText.length);
      }
    }
    // Apply minimum length to avoid zero-width columns
    maxLengths.push(Math.max(maxLen, 5));
  }

  // Calculate total length for proportional distribution
  const totalLength = maxLengths.reduce((sum, len) => sum + len, 0);

  // Calculate proportional widths
  let widths = maxLengths.map((len) => (len / totalLength) * totalWidth);

  // Apply min/max constraints
  widths = widths.map((w) => Math.max(minColWidth, Math.min(maxColWidth, w)));

  // Normalize to ensure widths sum to totalWidth
  const currentTotal = widths.reduce((sum, w) => sum + w, 0);
  if (currentTotal !== totalWidth) {
    const scale = totalWidth / currentTotal;
    widths = widths.map((w) => w * scale);
  }

  return widths;
}

// Helper: create table row options with proper styling
function createTableRowOptions(isHeader = false, isAlternate = false, COLORS = {}) {
  const options = {
    fontFace: 'Segoe UI',
    fontSize: 10,
    valign: 'middle',
  };

  if (isHeader) {
    options.bold = true;
    options.fill = { color: COLORS.accent3 || '011AB7' }; // Navy background
    options.color = COLORS.white || 'FFFFFF';
  } else if (isAlternate) {
    options.fill = { color: 'F5F5F5' }; // Light gray for alternating rows
    options.color = COLORS.black || '000000';
  } else {
    options.color = COLORS.black || '000000';
  }

  return options;
}

// Helper: add source footnote to slide
// Uses widescreen dimensions (13.333" x 7.5" = 16:9)
function addSourceFootnote(slide, sources, COLORS, FONT) {
  if (!sources || (Array.isArray(sources) && sources.length === 0)) return;

  let sourceText = '';
  if (typeof sources === 'string') {
    sourceText = `Source: ${sources}`;
  } else if (Array.isArray(sources)) {
    const sourceList = sources
      .slice(0, 3)
      .map((s) => (typeof s === 'string' ? s : s.name || s.source || ''))
      .filter(Boolean);
    sourceText = sourceList.length > 0 ? `Sources: ${sourceList.join('; ')}` : '';
  }

  if (sourceText) {
    slide.addText(truncate(sourceText, 120), {
      x: 0.4,
      y: 7.05,
      w: 12.5,
      h: 0.2,
      fontSize: 8,
      fontFace: FONT,
      color: COLORS?.footerText || '666666',
      valign: 'top',
    });
  }
}

// Helper: add callout/insight box to slide (single shape to avoid overlap detection)
// Uses widescreen dimensions (13.333" x 7.5" = 16:9)
function addCalloutBox(slide, title, content, options = {}) {
  const boxX = options.x || 0.4; // LEFT_MARGIN for widescreen
  const boxY = options.y || 5.3;
  const boxW = options.w || 12.5; // CONTENT_WIDTH for widescreen
  const boxH = options.h || 1.2;
  const boxType = options.type || 'insight'; // insight, warning, recommendation
  const FONT = 'Segoe UI';

  // Box colors based on type
  const typeColors = {
    insight: { fill: 'F5F5F5', border: '1F497D', titleColor: '1F497D' },
    warning: { fill: 'FFF8E1', border: 'E46C0A', titleColor: 'E46C0A' },
    recommendation: { fill: 'EDFDFF', border: '007FFF', titleColor: '007FFF' },
    positive: { fill: 'F0FFF0', border: '2E7D32', titleColor: '2E7D32' },
    negative: { fill: 'FFF0F0', border: 'C62828', titleColor: 'C62828' },
  };
  const colors = typeColors[boxType] || typeColors.insight;

  // Use single addText shape with fill+border to avoid shape overlap
  const textParts = [];
  if (title) {
    textParts.push({
      text: title + '\n',
      options: { fontSize: 10, bold: true, color: colors.titleColor, fontFace: FONT },
    });
  }
  if (content) {
    textParts.push({
      text: truncate(content, 160),
      options: { fontSize: 9, color: '000000', fontFace: FONT },
    });
  }
  if (textParts.length > 0) {
    // Clamp height so callout doesn't extend past content zone (6.65")
    const maxBottom = 6.65;
    const clampedH = boxY + boxH > maxBottom ? Math.max(0.3, maxBottom - boxY) : boxH;
    if (boxY < maxBottom) {
      slide.addText(textParts, {
        x: boxX,
        y: boxY,
        w: boxW,
        h: clampedH,
        fill: { color: colors.fill },
        line: { color: colors.border, pt: 1.5 },
        margin: [5, 8, 5, 8],
        valign: 'top',
      });
    }
  }
}

// Helper: add insights panel to chart slides (right side of chart)
// Displays key insights as bullet points next to charts for YCP-quality output
function addInsightsPanel(slide, insights = [], options = {}) {
  if (!insights || insights.length === 0) return;

  const FONT = 'Segoe UI';
  const panelX = options.x || 9.8; // Position to right of chart
  const panelY = options.y || 1.5;
  const panelW = options.w || 3.2;
  const panelH = options.h || 4.0;

  // Panel header
  slide.addText('Key Insights', {
    x: panelX,
    y: panelY,
    w: panelW,
    h: 0.35,
    fontSize: 12,
    bold: true,
    color: '1F497D', // Navy
    fontFace: FONT,
    valign: 'bottom',
  });

  // Navy underline for header
  slide.addShape('line', {
    x: panelX,
    y: panelY + 0.35,
    w: panelW,
    h: 0,
    line: { color: '1F497D', width: 1.5 },
  });

  // Build bullet points with navy bullets
  const bulletPoints = insights.slice(0, 4).map((insight) => ({
    text: truncate(String(insight), 150),
    options: {
      fontSize: 10,
      color: '333333',
      fontFace: FONT,
      bullet: { type: 'bullet', color: '1F497D' },
      paraSpaceBefore: 8,
      paraSpaceAfter: 4,
    },
  }));

  slide.addText(bulletPoints, {
    x: panelX,
    y: panelY + 0.45,
    w: panelW,
    h: panelH - 0.5,
    valign: 'top',
  });
}

// Helper: add section divider slide (Table of Contents style)
// Creates a visual break between major sections with section title
function addSectionDivider(pptx, sectionTitle, sectionNumber, totalSections, options = {}) {
  const FONT = 'Segoe UI';
  const COLORS = options.COLORS || {
    headerLine: '293F55',
    accent3: '011AB7',
    dk2: '1F497D',
    white: 'FFFFFF',
  };

  // Use plain slide (not master) for section dividers to avoid master line overlaps
  const slide = pptx.addSlide();

  // Section number (small, top left) — use background fill on text instead of separate rect
  const sectionLabel =
    sectionNumber && totalSections ? `Section ${sectionNumber} of ${totalSections}` : '';
  if (sectionLabel) {
    slide.addText(sectionLabel, {
      x: 0.5,
      y: 0.5,
      w: 3,
      h: 0.3,
      fontSize: 12,
      color: 'FFFFFF',
      fontFace: FONT,
      italic: true,
    });
  }

  // Section title (large, centered)
  slide.addText(sectionTitle, {
    x: 0.5,
    y: 2.8,
    w: 12.333,
    h: 1.5,
    fontSize: 44,
    bold: true,
    color: 'FFFFFF',
    fontFace: FONT,
    align: 'center',
    valign: 'middle',
  });

  // Decorative line under title
  slide.addShape('line', {
    x: 4,
    y: 4.5,
    w: 5.333,
    h: 0,
    line: { color: 'FFFFFF', width: 3 },
  });

  // Set slide background color instead of rect shape to avoid overlaps
  slide.background = { color: COLORS.accent3 || '011AB7' };

  return slide;
}

// Helper: create Opportunities & Obstacles summary slide (two-column layout)
// Uses single shapes per section to avoid overlap detection between rect+text
function addOpportunitiesObstaclesSummary(slide, opportunities = [], obstacles = [], options = {}) {
  const FONT = 'Segoe UI';
  const LEFT_MARGIN = options.x || 0.4;
  const contentY = options.y || 1.4;
  const fullWidth = options.fullWidth || 12.5;
  const COLORS = {
    green: '2E7D32',
    orange: 'E46C0A',
    white: 'FFFFFF',
    lightGreen: 'E8F5E9',
    lightOrange: 'FFF3E0',
  };

  // Opportunities header (single text shape with fill)
  slide.addText('Opportunities', {
    x: LEFT_MARGIN,
    y: contentY,
    w: fullWidth,
    h: 0.4,
    fontSize: 13,
    bold: true,
    color: COLORS.white,
    fontFace: FONT,
    valign: 'middle',
    margin: [0, 8, 0, 8],
    fill: { color: COLORS.green },
  });

  const oppBullets = (opportunities || []).slice(0, 4).map((opp) => ({
    text: truncate(String(opp), 150),
    options: {
      fontSize: 10,
      color: '333333',
      fontFace: FONT,
      bullet: { type: 'bullet', code: '2714', color: COLORS.green },
      paraSpaceBefore: 6,
      paraSpaceAfter: 3,
    },
  }));

  // Size opp bullets area based on content count
  const oppH = Math.min(2.0, Math.max(0.6, oppBullets.length * 0.4 + 0.2));
  if (oppBullets.length > 0) {
    slide.addText(oppBullets, {
      x: LEFT_MARGIN,
      y: contentY + 0.5,
      w: fullWidth,
      h: oppH,
      valign: 'top',
      fill: { color: COLORS.lightGreen },
    });
  }

  // Obstacles header — position dynamically below opportunities
  const obsY = contentY + 0.5 + oppH + 0.15;
  slide.addText('Obstacles & Risks', {
    x: LEFT_MARGIN,
    y: obsY,
    w: fullWidth,
    h: 0.4,
    fontSize: 13,
    bold: true,
    color: COLORS.white,
    fontFace: FONT,
    valign: 'middle',
    margin: [0, 8, 0, 8],
    fill: { color: COLORS.orange },
  });

  const obsBullets = (obstacles || []).slice(0, 4).map((obs) => ({
    text: truncate(String(obs), 150),
    options: {
      fontSize: 10,
      color: '333333',
      fontFace: FONT,
      bullet: { type: 'bullet', code: '26A0', color: COLORS.orange },
      paraSpaceBefore: 6,
      paraSpaceAfter: 3,
    },
  }));

  // Size obs bullets area based on content count, cap to stay above footer
  const obsH = Math.min(2.0, Math.max(0.6, obsBullets.length * 0.4 + 0.2), 6.65 - (obsY + 0.5));
  if (obsBullets.length > 0) {
    slide.addText(obsBullets, {
      x: LEFT_MARGIN,
      y: obsY + 0.5,
      w: fullWidth,
      h: Math.max(0.3, obsH),
      valign: 'top',
      fill: { color: COLORS.lightOrange },
    });
  }
}

// ============ CHART GENERATION ============
// YCP Color Palette for charts - WCAG 2.1 AA accessible colors
// Colors selected for sufficient contrast and colorblind-friendly combinations
const CHART_COLORS = [
  '0066CC', // Blue (primary) - high contrast, safe for colorblind
  'D55E00', // Orange-red - distinguishable for deuteranopia
  '009E73', // Teal/Green - safe for protanopia
  'CC79A7', // Muted pink - distinguishable across color blindness types
  '1F497D', // Navy - dark contrast
  'F0E442', // Yellow - high visibility (use with dark text)
  '56B4E9', // Sky blue - complements orange-red
  'E69F00', // Amber/Gold - warm contrast
];

// Extended accessible color palette for more than 8 categories
const CHART_COLORS_EXTENDED = [
  ...CHART_COLORS,
  '8B4513', // Saddle brown
  '4B0082', // Indigo
  '2F4F4F', // Dark slate gray
  'B22222', // Firebrick
];

// Semantic colors for specific meanings (opportunities, risks, etc.)
const SEMANTIC_COLORS = {
  positive: '2E7D32', // Green - opportunities, success
  negative: 'C62828', // Red - risks, failures
  warning: 'E46C0A', // Orange - warnings, caution
  neutral: '666666', // Gray - neutral information
  primary: '0066CC', // Blue - primary actions
  accent: '1F497D', // Navy - headers, emphasis
};

// Helper to merge historical and projected data into unified chart format
// Input: { historical: { 2020: { coal: 40, gas: 30 }, 2021: { coal: 38, gas: 32 } },
//          projected: { 2030: { coal: 20, gas: 40 }, 2040: { coal: 10, gas: 50 } } }
// Output: { categories: ['2020', '2021', '2030', '2040'], series: [...], projectedStartIndex: 2 }
function mergeHistoricalProjected(data, options = {}) {
  if (!data) return null;

  // If data is already in unified format, return it
  if (data.categories && data.series) {
    return data;
  }

  // Handle historical/projected format
  const historical = data.historical || {};
  const projected = data.projected || {};
  const allYears = [...Object.keys(historical), ...Object.keys(projected)].sort();

  if (allYears.length === 0) return null;

  // Identify all data series (e.g., coal, gas, renewable)
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

  // Build series data
  const series = [];
  seriesNames.forEach((seriesName) => {
    const values = allYears.map((year) => {
      const yearData = historical[year] || projected[year] || {};
      return typeof yearData === 'object' ? yearData[seriesName] || 0 : 0;
    });
    series.push({ name: seriesName, values });
  });

  // Find where projections start
  const projectedStartIndex = Object.keys(historical).length;

  return {
    categories: allYears,
    series,
    projectedStartIndex, // For visual differentiation
    unit: data.unit || options.unit || '',
  };
}

// Add a stacked bar chart to a slide
// data format: { categories: ['2020', '2021', '2022'], series: [{ name: 'Coal', values: [40, 38, 35] }, { name: 'Gas', values: [30, 32, 35] }] }
// Also supports: { historical: {...}, projected: {...} } format which gets auto-converted
function addStackedBarChart(slide, title, data, options = {}) {
  // Try to convert historical/projected format
  let chartData = data;
  if (data && (data.historical || data.projected) && !data.categories) {
    chartData = mergeHistoricalProjected(data);
  }

  if (!chartData || !chartData.categories || !chartData.series || chartData.series.length === 0) {
    return; // Skip if no valid data
  }

  // Add visual indicator for projected data in title if applicable
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
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    catAxisLabelFontFace: 'Segoe UI',
    catAxisLabelFontSize: 10,
    valAxisLabelFontFace: 'Segoe UI',
    valAxisLabelFontSize: 10,
    // Data labels enabled by default for YCP-quality output
    showValue: options.showValues !== false, // Default to true
    dataLabelFontFace: 'Segoe UI',
    dataLabelFontSize: 9,
    dataLabelColor: 'FFFFFF', // White text on colored bars
    dataLabelPosition: 'ctr', // Center position
  });
}

// Add a line chart to a slide
// data format: { categories: ['2020', '2021', '2022'], series: [{ name: 'Price', values: [10, 12, 14] }] }
// Also supports: { historical: {...}, projected: {...} } format which gets auto-converted
function addLineChart(slide, title, data, options = {}) {
  // Try to convert historical/projected format
  let chartData = data;
  if (data && (data.historical || data.projected) && !data.categories) {
    chartData = mergeHistoricalProjected(data);
  }

  if (!chartData || !chartData.categories || !chartData.series || chartData.series.length === 0) {
    return; // Skip if no valid data
  }

  // Add visual indicator for projected data in title if applicable
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

  slide.addChart('line', pptxChartData, {
    x: options.x || 0.5,
    y: options.y || 1.5,
    w: options.w || 9,
    h: options.h || 4.5,
    showLegend: chartData.series.length > 1,
    legendPos: 'b',
    showTitle: !!chartTitle,
    title: chartTitle,
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    catAxisLabelFontFace: 'Segoe UI',
    catAxisLabelFontSize: 10,
    valAxisLabelFontFace: 'Segoe UI',
    valAxisLabelFontSize: 10,
    lineDataSymbol: 'circle',
    lineDataSymbolSize: 6,
    // Data labels for line charts
    showValue: options.showValues !== false, // Default to true
    dataLabelFontFace: 'Segoe UI',
    dataLabelFontSize: 9,
    dataLabelPosition: 't', // Position above the line points
  });
}

// Add a bar chart (horizontal or vertical) to a slide
function addBarChart(slide, title, data, options = {}) {
  if (!data || !data.categories || !data.values || data.values.length === 0) {
    return; // Skip if no valid data
  }

  const chartData = [
    {
      name: data.name || 'Value',
      labels: data.categories,
      values: data.values,
      color: CHART_COLORS[0],
    },
  ];

  slide.addChart('bar', chartData, {
    x: options.x || 0.5,
    y: options.y || 1.5,
    w: options.w || 9,
    h: options.h || 4.5,
    barDir: options.horizontal ? 'bar' : 'col',
    showLegend: false,
    showTitle: !!title,
    title: title,
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    catAxisLabelFontFace: 'Segoe UI',
    catAxisLabelFontSize: 10,
    valAxisLabelFontFace: 'Segoe UI',
    valAxisLabelFontSize: 10,
    showValue: true,
    dataLabelFontFace: 'Segoe UI',
    dataLabelFontSize: 9,
  });
}

// Add a pie/doughnut chart to a slide
function addPieChart(slide, title, data, options = {}) {
  if (!data || !data.categories || !data.values || data.values.length === 0) {
    return; // Skip if no valid data
  }

  const chartData = [
    {
      name: data.name || 'Share',
      labels: data.categories,
      values: data.values,
    },
  ];

  slide.addChart(options.doughnut ? 'doughnut' : 'pie', chartData, {
    x: options.x || 2,
    y: options.y || 1.5,
    w: options.w || 6,
    h: options.h || 4.5,
    showLegend: true,
    legendPos: 'r',
    showTitle: !!title,
    title: title,
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    showPercent: true,
    chartColors: CHART_COLORS.slice(0, data.categories.length),
  });
}

// ============ STORY ARCHITECT ============
// Transforms raw research data into a narrative with key insights
// Returns a universal slide structure based on the story, not hardcoded slides
async function buildStoryNarrative(countryAnalysis, scope) {
  console.log('\n  [STORY ARCHITECT] Building narrative from research...');

  const systemPrompt = `You are a senior partner at McKinsey preparing a board presentation. Your job is to transform raw research into a compelling narrative that drives a decision.

=== STORYTELLING PRINCIPLES ===
1. LEAD WITH THE VERDICT: Executives want the answer first, then the reasoning.
2. EVERY SLIDE = ONE INSIGHT: Not "here's information about X" but "here's what X means for you"
3. CONNECT THE DOTS: Each slide should logically lead to the next
4. CUT RUTHLESSLY: If a fact doesn't support the decision, delete it. 8 great slides beat 25 mediocre ones.
5. QUANTIFY EVERYTHING: "Big market" → "$1.5B market growing 12% annually"

=== ASSERTIVE SLIDE TITLES (CRITICAL) ===
Generate conclusion-driven titles that tell the story, NOT descriptive labels.
BAD (descriptive): "Thailand - Market Size", "Vietnam - Energy Policy"
GOOD (assertive): "$50 billion total market, $5 billion addressable for client", "Electricity liberalization creates 18-month JV window"
Each title should be a conclusion the reader can act on, not a topic they need to read about.

=== INSIGHT QUALITY ===
BAD (information): "Thailand requires 50% local content for energy services"
GOOD (insight): "The 50% local content rule means you can't compete on cost alone—local partnerships aren't optional, they're your competitive moat"

BAD (list): "Key players include Schlumberger, Halliburton, Baker Hughes"
GOOD (insight): "The Big 3 dominate offshore, but none have cracked the industrial efficiency market—a $200M segment growing 15% annually"

=== SLIDE TYPES TO USE ===
1. VERDICT: Go/No-Go with conditions (always first after title)
2. OPPORTUNITY: Market size, growth, timing window
3. BARRIER: What makes this hard (regulatory, competitive, operational)
4. COMPETITIVE_LANDSCAPE: Who's winning, who's losing, white spaces
5. ENTRY_PATH: How to get in (JV, acquisition, greenfield)
6. ECONOMICS: Deal sizes, margins, investment required
7. RISKS: Top 3-5 risks with mitigations
8. ACTION: Specific next steps with timeline

Return 8-12 slides maximum. Quality over quantity.`;

  const prompt = `RESEARCH DATA:
${JSON.stringify(countryAnalysis, null, 2)}

CLIENT CONTEXT:
- Industry: ${scope.industry}
- Project Type: ${scope.projectType}
- Client: ${scope.clientContext || 'Not specified'}
- Target Market: ${scope.targetMarkets?.join(', ') || countryAnalysis.country}

Transform this research into a narrative. Return JSON:

{
  "storyHook": "One sentence that frames the entire presentation (e.g., 'The 2025 deadline changes everything')",

  "verdict": {
    "decision": "GO" | "CONDITIONAL_GO" | "NO_GO",
    "confidence": "HIGH" | "MEDIUM" | "LOW",
    "conditions": ["condition 1", "condition 2"],
    "oneLiner": "One sentence summary of recommendation"
  },

  "slides": [
    {
      "type": "VERDICT" | "OPPORTUNITY" | "BARRIER" | "COMPETITIVE_LANDSCAPE" | "ENTRY_PATH" | "ECONOMICS" | "RISKS" | "ACTION",
      "title": "ASSERTIVE title that states a conclusion (e.g. '$50B market, $5B addressable' NOT 'Market Size')",
      "insight": "The 'so what' - one sentence that makes this slide matter",
      "content": {
        // Type-specific content structure
        // For VERDICT: { decision, conditions, ratings: {attractiveness, feasibility} }
        // For OPPORTUNITY: { marketSize, growth, timingWindow, keyDrivers }
        // For BARRIER: { barriers: [{name, severity, mitigation}] }
        // For COMPETITIVE_LANDSCAPE: { leaders: [{name, strength, weakness}], whiteSpaces }
        // For ENTRY_PATH: { options: [{name, timeline, investment, pros, cons}], recommended }
        // For ECONOMICS: { dealSize, margins, investment, breakeven }
        // For RISKS: { risks: [{name, severity, likelihood, mitigation}] }
        // For ACTION: { steps: [{action, owner, timeline}] }
      },
      "sources": ["source URLs or names relevant to this slide"]
    }
  ],

  "aggregatedSources": [
    {"url": "actual URL", "title": "source name"}
  ]
}`;

  try {
    const response = await callDeepSeek(prompt, systemPrompt, 8192);

    // Parse response
    let story;
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        story = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('  [STORY ARCHITECT] Failed to parse response:', parseError.message);
      // Return minimal default structure
      return {
        storyHook: `${countryAnalysis.country} Market Entry Analysis`,
        verdict: {
          decision: 'CONDITIONAL_GO',
          confidence: 'MEDIUM',
          conditions: ['Further analysis required'],
          oneLiner: 'Proceed with caution',
        },
        slides: [],
        aggregatedSources: [],
      };
    }

    console.log(`  [STORY ARCHITECT] Generated ${story.slides?.length || 0} slides with narrative`);
    return story;
  } catch (error) {
    console.error('  [STORY ARCHITECT] Error:', error.message);
    return {
      storyHook: `${countryAnalysis.country} Market Entry Analysis`,
      verdict: { decision: 'CONDITIONAL_GO', confidence: 'LOW', conditions: [], oneLiner: '' },
      slides: [],
      aggregatedSources: [],
    };
  }
}

// Helper: calculate safe table height based on row count to prevent overlap
function safeTableHeight(rowCount, opts = {}) {
  const { fontSize = 11, maxH = 5.0 } = opts;
  const rowH = fontSize <= 9 ? 0.35 : fontSize >= 12 ? 0.45 : 0.4;
  return Math.max(0.6, Math.min(rowH * rowCount + 0.15, maxH));
}

module.exports = {
  truncate,
  truncateSubtitle,
  safeArray,
  ensureWebsite,
  isValidCompany,
  dedupeCompanies,
  enrichCompanyDesc,
  calculateColumnWidths,
  createTableRowOptions,
  addSourceFootnote,
  addCalloutBox,
  addInsightsPanel,
  addSectionDivider,
  addOpportunitiesObstaclesSummary,
  CHART_COLORS,
  CHART_COLORS_EXTENDED,
  SEMANTIC_COLORS,
  mergeHistoricalProjected,
  addStackedBarChart,
  addLineChart,
  addBarChart,
  addPieChart,
  buildStoryNarrative,
  safeTableHeight,
};
