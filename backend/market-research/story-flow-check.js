/**
 * Story Flow Checker
 *
 * Cross-section coherence analysis for market-research synthesis outputs.
 * Detects numeric/factual mismatches, timeline inconsistencies,
 * and entity naming divergences across linked sections.
 */

const { normalizeCurrency, normalizeTimePeriod } = require('./content-quality-check');

// ============ NUMBER EXTRACTION ============

/**
 * Extract all monetary values from text with surrounding context.
 * Returns [{ raw, value, currency, context }]
 */
function extractMonetaryValues(text) {
  if (!text || typeof text !== 'string') return [];

  const results = [];
  // Match currency values: $5M, $5 million, EUR 2.3 billion, etc.
  const patterns = [
    /(?:\$|€|£|¥|₹)\s*[\d,.]+\s*(?:thousand|million|billion|trillion|[kKmMbBtT])?/gi,
    /[\d,.]+\s*(?:thousand|million|billion|trillion|[kKmMbBtT])\s*(?:USD|EUR|GBP|JPY|INR|CNY|KRW|THB|VND|IDR|MYR|SGD|PHP|AUD|CAD)/gi,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const normalized = normalizeCurrency(match[0]);
      if (normalized) {
        // Extract surrounding context (30 chars each side)
        const start = Math.max(0, match.index - 30);
        const end = Math.min(text.length, match.index + match[0].length + 30);
        const context = text.slice(start, end).replace(/\s+/g, ' ').trim();
        results.push({
          raw: match[0],
          value: normalized.value,
          currency: normalized.currency,
          context,
        });
      }
    }
  }

  return results;
}

/**
 * Extract percentage values from text with context.
 * Returns [{ raw, value, context }]
 */
function extractPercentages(text) {
  if (!text || typeof text !== 'string') return [];

  const results = [];
  const pattern = /(\d+(?:\.\d+)?)\s*%/g;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = Math.max(0, match.index - 30);
    const end = Math.min(text.length, match.index + match[0].length + 30);
    const context = text.slice(start, end).replace(/\s+/g, ' ').trim();
    results.push({
      raw: match[0],
      value: parseFloat(match[1]),
      context,
    });
  }

  return results;
}

/**
 * Extract timeline references from text with context.
 * Returns [{ raw, months, context }]
 */
function extractTimelines(text) {
  if (!text || typeof text !== 'string') return [];

  const results = [];
  const pattern = /(\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?)\s*(?:months?|years?)/gi;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const months = normalizeTimePeriod(match[0]);
    if (months != null) {
      const start = Math.max(0, match.index - 30);
      const end = Math.min(text.length, match.index + match[0].length + 30);
      const context = text.slice(start, end).replace(/\s+/g, ' ').trim();
      results.push({
        raw: match[0],
        months,
        context,
      });
    }
  }

  return results;
}

/**
 * Extract company/entity names from text.
 * Returns [name, ...]
 */
function extractEntityNames(text) {
  if (!text || typeof text !== 'string') return [];

  const results = new Set();

  // Formal company names with suffixes
  const companyPattern =
    /([A-Z][a-zA-Z&]+(?:\s+[A-Z][a-zA-Z&]+)*)\s+(?:Corp(?:oration)?|Ltd|Inc|Co(?:mpany)?|Group|GmbH|SA|AG|PLC|LLC|Sdn\s+Bhd|SE|NV|BV|Pty)/g;
  let match;
  while ((match = companyPattern.exec(text)) !== null) {
    results.add(match[0].trim());
  }

  // Also capture names with "name": "..." pattern from JSON-like structures
  const jsonNamePattern = /"(?:name|company|partnerName)"\s*:\s*"([^"]+)"/g;
  while ((match = jsonNamePattern.exec(text)) !== null) {
    results.add(match[1].trim());
  }

  return [...results];
}

// ============ SECTION TEXT EXTRACTION ============

/**
 * Extract text content from each section of a synthesis.
 * Returns { sectionName: textContent }
 */
function getSectionTexts(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') return {};

  const texts = {};
  const topSections = [
    'executiveSummary',
    'marketOpportunityAssessment',
    'competitivePositioning',
    'regulatoryPathway',
    'keyInsights',
  ];

  for (const section of topSections) {
    const val = synthesis[section];
    if (!val) continue;
    texts[section] = typeof val === 'string' ? val : JSON.stringify(val);
  }

  if (synthesis.depth && typeof synthesis.depth === 'object') {
    for (const [key, val] of Object.entries(synthesis.depth)) {
      if (!val) continue;
      texts[`depth.${key}`] = typeof val === 'string' ? val : JSON.stringify(val);
    }
  }

  return texts;
}

// ============ TOPIC OVERLAP HELPERS ============

/**
 * Extract significant keywords from text (4+ char words, no stopwords).
 * Returns a Set of lowercase keywords.
 */
function extractKeywords(text) {
  if (!text || typeof text !== 'string') return new Set();
  const stopwords = new Set([
    'this',
    'that',
    'with',
    'from',
    'have',
    'been',
    'will',
    'would',
    'could',
    'should',
    'their',
    'there',
    'these',
    'those',
    'which',
    'where',
    'when',
    'what',
    'into',
    'also',
    'more',
    'most',
    'such',
    'than',
    'them',
    'then',
    'they',
    'were',
    'your',
    'each',
    'some',
    'very',
    'well',
    'much',
    'both',
    'does',
    'only',
    'over',
    'just',
    'like',
    'about',
    'other',
    'after',
    'being',
    'under',
    'still',
    'while',
    'based',
    'make',
    'including',
    'through',
    'between',
    'during',
    'before',
    // JSON artifacts
    'true',
    'false',
    'null',
    'string',
    'number',
    'value',
    'name',
    'type',
    'data',
    'title',
    'description',
    'content',
    'text',
    'object',
    'array',
    'field',
  ]);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/);
  const keywords = new Set();
  for (const w of words) {
    if (w.length >= 4 && !stopwords.has(w) && !/^\d+$/.test(w)) {
      keywords.add(w);
    }
  }
  return keywords;
}

/**
 * Calculate Jaccard similarity between two keyword sets.
 * Returns a value between 0 (no overlap) and 1 (identical).
 */
function keywordOverlap(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

// ============ GENERIC FILLER DETECTION ============

/**
 * Detect generic/boilerplate filler content that adds no decision value.
 * Returns { isGeneric, fillerRatio, reasons[] }
 */
function detectGenericFiller(text) {
  if (!text || typeof text !== 'string') return { isGeneric: false, fillerRatio: 0, reasons: [] };

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words < 20) return { isGeneric: false, fillerRatio: 0, reasons: [] };

  const reasons = [];

  // Generic phrases that any AI can produce without real research
  const genericPhrases = [
    /\brapidly growing market\b/gi,
    /\bsignificant growth potential\b/gi,
    /\bstrong market fundamentals\b/gi,
    /\bfavorable regulatory environment\b/gi,
    /\bstrategic location\b/gi,
    /\brich natural resources\b/gi,
    /\bgrowing middle class\b/gi,
    /\bincreasing urbanization\b/gi,
    /\bdigital transformation\b/gi,
    /\bsustainable development\b/gi,
    /\bincreasingly competitive\b/gi,
    /\bwell-positioned\b/gi,
    /\bthe market is expected to\b/gi,
    /\bthe region offers\b/gi,
    /\bpresents (?:significant |substantial )?opportunities\b/gi,
    /\bkey players include\b/gi,
    /\bthe government has implemented\b/gi,
    /\bstrong demand for\b/gi,
    /\bthe sector is characterized by\b/gi,
    /\bprovides a (?:strong |solid )?foundation\b/gi,
    /\battractive investment destination\b/gi,
    /\brobust economic growth\b/gi,
    /\bemerging market\b/gi,
  ];

  let genericCount = 0;
  for (const pattern of genericPhrases) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern) || [];
    genericCount += matches.length;
  }

  const genericDensity = genericCount / (words / 100);
  if (genericDensity > 3) {
    reasons.push(
      `High generic phrase density: ${genericCount} boilerplate phrases in ${words} words`
    );
  }

  // Check for vague quantifiers without actual numbers
  const vagueQuantifiers =
    text.match(
      /\b(significant|substantial|considerable|numerous|various|several|multiple|many|increasing|growing)\b/gi
    ) || [];
  const specificNumbers =
    text.match(/(?:\$|€|£|¥)?\d[\d,.]*(?:\s*(?:million|billion|M|B|K|%|GW|MW))?/g) || [];

  if (vagueQuantifiers.length > specificNumbers.length * 2 && vagueQuantifiers.length >= 4) {
    reasons.push(
      `Vague over specific: ${vagueQuantifiers.length} vague quantifiers vs ${specificNumbers.length} actual numbers`
    );
  }

  // Check for sections that lack any country/company/product specificity
  const hasCountryName =
    /\b[A-Z][a-z]+(?:land|ia|an|stan|rea|nam|way|den|pan|ico|ria|pia|ina|ba|da)\b/.test(text);
  const hasCompanyName =
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Corp|Ltd|Inc|Co|Group|GmbH|SA|AG|PLC|LLC|Sdn\s+Bhd)/g.test(
      text
    );
  if (!hasCountryName && !hasCompanyName && words > 80) {
    reasons.push('No country or company names found in 80+ word section — likely generic filler');
  }

  const fillerRatio = words > 0 ? genericCount / (words / 100) : 0;
  return {
    isGeneric: reasons.length > 0,
    fillerRatio: Math.round(fillerRatio * 100) / 100,
    reasons,
  };
}

// ============ STORY FLOW CHECK ============

/**
 * Check coherence across linked sections of a synthesis.
 *
 * - Market size claims match across market overview vs executive summary vs deal economics
 * - Timeline claims consistent (entry strategy timeline vs implementation phases)
 * - Company names consistent across competitor sections
 * - Sections topically connected (not talking about unrelated subjects)
 * - Generic filler content detected and penalized
 *
 * @param {object} synthesis - Full synthesis object
 * @returns {{ score, issues[], linkedPairs[] }}
 */
function checkStoryFlow(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') {
    return { score: 0, issues: ['No synthesis data provided'], linkedPairs: [] };
  }

  const issues = [];
  const linkedPairs = [];
  const sectionTexts = getSectionTexts(synthesis);

  if (Object.keys(sectionTexts).length === 0) {
    return { score: 0, issues: ['No sections found in synthesis'], linkedPairs: [] };
  }

  // 1. Market size coherence: compare monetary values across sections
  const sectionMonetary = {};
  for (const [section, text] of Object.entries(sectionTexts)) {
    sectionMonetary[section] = extractMonetaryValues(text);
  }

  // Find "market size" / "TAM" values and check they match
  const marketSizeSections = [
    'executiveSummary',
    'marketOpportunityAssessment',
    'depth.dealEconomics',
  ];
  const marketSizeValues = [];
  for (const section of marketSizeSections) {
    const text = sectionTexts[section];
    if (!text) continue;
    // Look for market size context
    const marketSizePattern =
      /(?:market(?:\s+size)?|TAM|total addressable|addressable market)[^.]*?(?:\$|€|£|¥)[\d,.]+\s*(?:million|billion|M|B|K|trillion|T)?/gi;
    const matches = text.match(marketSizePattern) || [];
    for (const m of matches) {
      const normalized = normalizeCurrency(
        m.match(/(?:\$|€|£|¥)[\d,.]+\s*(?:million|billion|M|B|K|trillion|T)?/i)?.[0] || ''
      );
      if (normalized) {
        marketSizeValues.push({
          section,
          value: normalized.value,
          currency: normalized.currency,
          raw: m,
        });
      }
    }
  }

  // If we have market size values from multiple sections, check consistency
  if (marketSizeValues.length >= 2) {
    for (let i = 0; i < marketSizeValues.length; i++) {
      for (let j = i + 1; j < marketSizeValues.length; j++) {
        const a = marketSizeValues[i];
        const b = marketSizeValues[j];
        if (a.currency === b.currency) {
          const ratio = Math.max(a.value, b.value) / Math.min(a.value, b.value);
          linkedPairs.push({
            sectionA: a.section,
            sectionB: b.section,
            type: 'market-size',
            valueA: a.value,
            valueB: b.value,
            ratio: Math.round(ratio * 100) / 100,
          });
          if (ratio > 2) {
            issues.push(
              `Market size mismatch: ${a.section} says ${a.raw.slice(0, 60)} but ${b.section} says ${b.raw.slice(0, 60)} (${ratio.toFixed(1)}x difference)`
            );
          }
        }
      }
    }
  }

  // 2. Timeline coherence
  const timelineSections = ['depth.entryStrategy', 'depth.implementationPlan', 'executiveSummary'];
  const sectionTimelineData = {};
  for (const section of timelineSections) {
    const text = sectionTexts[section];
    if (!text) continue;
    sectionTimelineData[section] = extractTimelines(text);
  }

  // Compare timelines across sections
  const timelineKeys = Object.keys(sectionTimelineData);
  for (let i = 0; i < timelineKeys.length; i++) {
    for (let j = i + 1; j < timelineKeys.length; j++) {
      const a = sectionTimelineData[timelineKeys[i]];
      const b = sectionTimelineData[timelineKeys[j]];
      if (a.length > 0 && b.length > 0) {
        // Compare the largest timeline value from each section
        const maxA = Math.max(...a.map((t) => t.months));
        const maxB = Math.max(...b.map((t) => t.months));
        if (maxA > 0 && maxB > 0) {
          const ratio = Math.max(maxA, maxB) / Math.min(maxA, maxB);
          linkedPairs.push({
            sectionA: timelineKeys[i],
            sectionB: timelineKeys[j],
            type: 'timeline',
            valueA: maxA,
            valueB: maxB,
            ratio: Math.round(ratio * 100) / 100,
          });
          if (ratio > 2) {
            issues.push(
              `Timeline mismatch: ${timelineKeys[i]} implies ${maxA} months but ${timelineKeys[j]} implies ${maxB} months (${ratio.toFixed(1)}x difference)`
            );
          }
        }
      }
    }
  }

  // 3. Company name consistency across competitor sections
  const competitorSections = ['competitivePositioning', 'executiveSummary', 'keyInsights'];
  const sectionEntities = {};
  for (const section of competitorSections) {
    const text = sectionTexts[section];
    if (!text) continue;
    sectionEntities[section] = extractEntityNames(text);
  }

  // Check that company names mentioned in executive summary also appear in competitive positioning
  if (sectionEntities.executiveSummary && sectionEntities.competitivePositioning) {
    const execNames = sectionEntities.executiveSummary.map((n) => n.toLowerCase());
    const compNames = sectionEntities.competitivePositioning.map((n) => n.toLowerCase());

    for (const name of execNames) {
      const nameWords = name.split(/\s+/);
      const firstWord = nameWords[0];
      // Check if any competitor section name matches (fuzzy: first word)
      const found = compNames.some(
        (cn) => cn.includes(firstWord) || (firstWord.length > 3 && cn.split(/\s+/)[0] === firstWord)
      );
      if (!found && firstWord.length > 3) {
        linkedPairs.push({
          sectionA: 'executiveSummary',
          sectionB: 'competitivePositioning',
          type: 'entity-name',
          entity: name,
          found: false,
        });
        issues.push(
          `Entity "${name}" mentioned in executiveSummary but not found in competitivePositioning`
        );
      }
    }
  }

  // 4. Section topic connectivity: check that adjacent/linked sections share keywords
  const sectionKeywords = {};
  for (const [section, text] of Object.entries(sectionTexts)) {
    sectionKeywords[section] = extractKeywords(text);
  }

  // Check exec summary against each other top-level section — they should share topic keywords
  const execKw = sectionKeywords.executiveSummary;
  if (execKw && execKw.size >= 5) {
    const topSections = ['marketOpportunityAssessment', 'competitivePositioning', 'keyInsights'];
    for (const section of topSections) {
      const sectionKw = sectionKeywords[section];
      if (!sectionKw || sectionKw.size < 5) continue;
      const overlap = keywordOverlap(execKw, sectionKw);
      linkedPairs.push({
        sectionA: 'executiveSummary',
        sectionB: section,
        type: 'topic-connectivity',
        overlap: Math.round(overlap * 100) / 100,
      });
      if (overlap < 0.05) {
        issues.push(
          `Disconnected sections: executiveSummary and ${section} share almost no topic keywords (${Math.round(overlap * 100)}% overlap) — sections may be about different subjects`
        );
      }
    }
  }

  // 5. Generic filler detection across sections
  for (const [section, text] of Object.entries(sectionTexts)) {
    // Only check top-level sections (not depth subsections which are more structured)
    if (section.startsWith('depth.')) continue;
    const fillerCheck = detectGenericFiller(text);
    if (fillerCheck.isGeneric) {
      for (const reason of fillerCheck.reasons) {
        issues.push(`${section}: ${reason}`);
      }
    }
  }

  // 6. Check for missing critical sections
  const criticalSections = ['executiveSummary', 'marketOpportunityAssessment', 'keyInsights'];
  for (const section of criticalSections) {
    if (!sectionTexts[section]) {
      issues.push(
        `Critical section missing: ${section} — report has no ${section
          .replace(/([A-Z])/g, ' $1')
          .toLowerCase()
          .trim()}`
      );
    }
  }

  // Calculate score: start at 100, deduct per issue with severity weighting
  // Market size / timeline mismatches: -20 each (factual errors are severe)
  // Disconnected sections: -15 each
  // Generic filler: -10 each
  // Entity mismatches: -10 each
  // Missing critical sections: -25 each
  let score = 100;
  for (const issue of issues) {
    const lower = issue.toLowerCase();
    if (lower.includes('market size mismatch') || lower.includes('timeline mismatch')) {
      score -= 20;
    } else if (lower.includes('disconnected sections')) {
      score -= 15;
    } else if (lower.includes('critical section missing')) {
      score -= 25;
    } else if (lower.includes('entity')) {
      score -= 10;
    } else {
      // Generic filler, vague quantifiers, etc.
      score -= 10;
    }
  }
  score = Math.max(0, Math.min(100, score));

  return { score, issues, linkedPairs };
}

// ============ COHERENCE BREAK DETECTION ============

/**
 * Find specific numeric/factual mismatches between sections.
 * More granular than checkStoryFlow — identifies exact break points.
 *
 * @param {object} synthesis
 * @returns {Array<{ type, sectionA, sectionB, valueA, valueB, description }>}
 */
function detectCoherenceBreaks(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') return [];

  const breaks = [];
  const sectionTexts = getSectionTexts(synthesis);

  // 1. Find duplicate numeric claims with different values
  const sectionNumbers = {};
  for (const [section, text] of Object.entries(sectionTexts)) {
    sectionNumbers[section] = {
      monetary: extractMonetaryValues(text),
      percentages: extractPercentages(text),
      timelines: extractTimelines(text),
    };
  }

  // Compare CAGR/growth rate claims across sections
  const growthPattern = /(\d+(?:\.\d+)?)\s*%\s*(?:CAGR|growth|annually|annual growth)/gi;
  const sectionGrowth = {};
  for (const [section, text] of Object.entries(sectionTexts)) {
    const re = new RegExp(growthPattern.source, growthPattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!sectionGrowth[section]) sectionGrowth[section] = [];
      sectionGrowth[section].push({
        value: parseFloat(match[1]),
        raw: match[0],
        context: text
          .slice(Math.max(0, match.index - 20), match.index + match[0].length + 20)
          .trim(),
      });
    }
  }

  // Cross-compare growth rates
  const growthSections = Object.keys(sectionGrowth);
  for (let i = 0; i < growthSections.length; i++) {
    for (let j = i + 1; j < growthSections.length; j++) {
      const a = sectionGrowth[growthSections[i]];
      const b = sectionGrowth[growthSections[j]];
      for (const va of a) {
        for (const vb of b) {
          if (Math.abs(va.value - vb.value) > 5 && va.value > 0 && vb.value > 0) {
            breaks.push({
              type: 'growth-rate-mismatch',
              sectionA: growthSections[i],
              sectionB: growthSections[j],
              valueA: `${va.value}%`,
              valueB: `${vb.value}%`,
              description: `Growth rate of ${va.value}% in ${growthSections[i]} vs ${vb.value}% in ${growthSections[j]}`,
            });
          }
        }
      }
    }
  }

  // Compare market share claims
  const sharePattern = /(\d+(?:\.\d+)?)\s*%\s*(?:market share|share)/gi;
  const sectionShares = {};
  for (const [section, text] of Object.entries(sectionTexts)) {
    const re = new RegExp(sharePattern.source, sharePattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!sectionShares[section]) sectionShares[section] = [];
      sectionShares[section].push({
        value: parseFloat(match[1]),
        raw: match[0],
      });
    }
  }

  // Check if combined market shares in any single section exceed 100%
  for (const [section, shares] of Object.entries(sectionShares)) {
    const total = shares.reduce((sum, s) => sum + s.value, 0);
    if (total > 100 && shares.length >= 2) {
      breaks.push({
        type: 'market-share-overflow',
        sectionA: section,
        sectionB: section,
        valueA: `${total}%`,
        valueB: '100%',
        description: `Market shares in ${section} sum to ${total.toFixed(1)}% (exceeds 100%)`,
      });
    }
  }

  return breaks;
}

// ============ REMEDIATION HINTS ============

/**
 * Generate actionable remediation hints for coherence issues.
 *
 * @param {Array<string>} issues - Array of issue description strings from checkStoryFlow
 * @returns {Array<{ issue, hint, priority }>}
 */
function getRemediationHints(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return [];

  return issues.map((issue) => {
    const lower = issue.toLowerCase();

    if (lower.includes('market size mismatch')) {
      return {
        issue,
        hint: 'Reconcile market size figures across sections. Use a single authoritative source (e.g., the market overview TAM) and reference it consistently. If sections discuss different market segments, clarify the scope explicitly.',
        priority: 'high',
      };
    }

    if (lower.includes('timeline mismatch')) {
      return {
        issue,
        hint: 'Align timeline estimates between entry strategy and implementation plan. If one section describes a phased approach and another a total timeline, ensure the phases sum correctly to the stated total.',
        priority: 'high',
      };
    }

    if (lower.includes('entity') && lower.includes('not found')) {
      return {
        issue,
        hint: 'Ensure all companies mentioned in the executive summary are also covered in the competitive positioning section. Add a brief competitive assessment for each named company.',
        priority: 'medium',
      };
    }

    if (lower.includes('growth rate') || lower.includes('cagr')) {
      return {
        issue,
        hint: 'Use a consistent CAGR figure across all sections. If different timeframes yield different growth rates, specify the timeframe (e.g., "2024-2028 CAGR of X%").',
        priority: 'high',
      };
    }

    if (lower.includes('market share') && lower.includes('exceed')) {
      return {
        issue,
        hint: 'Market share percentages should not sum to more than 100%. Check if some figures include overlapping segments or different market definitions.',
        priority: 'medium',
      };
    }

    // Generic hint for unrecognized issues
    return {
      issue,
      hint: 'Review the flagged sections for consistency. Ensure numeric claims, entity names, and directional statements align across all sections.',
      priority: 'low',
    };
  });
}

// ============ SCORE EXPLAINABILITY ============

/**
 * Generate a human-readable per-section breakdown explaining a coherence score.
 *
 * @param {{ score, issues, linkedPairs }} analysis - Output from checkStoryFlow
 * @returns {{ summary, perSection: { section, status, details }[], recommendations: string[] }}
 */
function explainScore(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return {
      summary: 'No analysis data provided.',
      perSection: [],
      recommendations: [],
    };
  }

  const { score, issues, linkedPairs } = analysis;

  // Build per-section status from linkedPairs and issues
  const sectionStatus = {};

  if (Array.isArray(linkedPairs)) {
    for (const pair of linkedPairs) {
      const sections = [pair.sectionA, pair.sectionB].filter(Boolean);
      for (const section of sections) {
        if (!sectionStatus[section])
          sectionStatus[section] = { checks: 0, problems: 0, details: [] };
        sectionStatus[section].checks++;

        if (pair.type === 'entity-name' && pair.found === false) {
          sectionStatus[section].problems++;
          sectionStatus[section].details.push(`Missing entity: ${pair.entity}`);
        } else if (pair.type === 'topic-connectivity' && pair.overlap < 0.05) {
          sectionStatus[section].problems++;
          sectionStatus[section].details.push(
            `Disconnected: only ${Math.round((pair.overlap || 0) * 100)}% topic overlap with linked section`
          );
        } else if (pair.ratio && pair.ratio > 2) {
          sectionStatus[section].problems++;
          sectionStatus[section].details.push(`${pair.type} mismatch (${pair.ratio}x difference)`);
        }
      }
    }
  }

  // Also attribute issue-level problems to sections
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      // Extract section name from issue strings like "executiveSummary: ..."
      const colonIdx = issue.indexOf(':');
      if (colonIdx > 0 && colonIdx < 40) {
        const possibleSection = issue.slice(0, colonIdx).trim();
        if (/^[a-zA-Z.]+$/.test(possibleSection)) {
          if (!sectionStatus[possibleSection])
            sectionStatus[possibleSection] = { checks: 0, problems: 0, details: [] };
          sectionStatus[possibleSection].problems++;
          sectionStatus[possibleSection].details.push(issue.slice(colonIdx + 1).trim());
        }
      }
    }
  }

  const perSection = Object.entries(sectionStatus).map(([section, data]) => ({
    section,
    status: data.problems === 0 ? 'consistent' : 'issues-found',
    details: data.details.length > 0 ? data.details.join('; ') : 'All checks passed',
  }));

  // Summary — more specific and decision-useful
  let summary;
  if (score >= 80) {
    summary = `Coherence score: ${score}/100 (strong). Sections are well-aligned with minimal inconsistencies.`;
  } else if (score >= 50) {
    const problemCount = issues ? issues.length : 0;
    const problemSections = perSection
      .filter((s) => s.status === 'issues-found')
      .map((s) => s.section);
    summary =
      `Coherence score: ${score}/100 (moderate). ${problemCount} issue(s) found` +
      (problemSections.length > 0 ? ` affecting: ${problemSections.join(', ')}.` : '.') +
      ' Fix these before presenting to decision-makers.';
  } else {
    const criticalIssues = (issues || []).filter(
      (i) =>
        i.toLowerCase().includes('mismatch') ||
        i.toLowerCase().includes('disconnected') ||
        i.toLowerCase().includes('missing')
    );
    summary =
      `Coherence score: ${score}/100 (weak). Report is not decision-ready. ` +
      (criticalIssues.length > 0
        ? `Top problem: ${criticalIssues[0]}`
        : 'Multiple sections need reconciliation.');
  }

  // Recommendations — specific and actionable
  const recommendations = [];
  if (Array.isArray(issues)) {
    if (issues.some((i) => i.toLowerCase().includes('market size'))) {
      recommendations.push(
        'ACTION: Pick one authoritative market size source. Update executiveSummary and marketOpportunityAssessment to use the same figure. If sections cover different segments, label them explicitly (e.g., "addressable market" vs "total market").'
      );
    }
    if (issues.some((i) => i.toLowerCase().includes('timeline'))) {
      recommendations.push(
        'ACTION: Align entry strategy timeline with implementation plan. If the entry strategy says 18 months but implementation has 4 phases totaling 36 months, either shorten phases or extend the stated timeline.'
      );
    }
    if (issues.some((i) => i.toLowerCase().includes('entity'))) {
      recommendations.push(
        'ACTION: All named companies in the executive summary must appear in competitivePositioning. Add at least a one-sentence competitive assessment for each missing company.'
      );
    }
    if (issues.some((i) => i.toLowerCase().includes('disconnected'))) {
      recommendations.push(
        'ACTION: Sections are discussing different topics. The executive summary should preview the same themes that other sections develop in detail. Re-synthesize with a unified narrative thread.'
      );
    }
    if (
      issues.some(
        (i) =>
          i.toLowerCase().includes('generic') ||
          i.toLowerCase().includes('filler') ||
          i.toLowerCase().includes('vague') ||
          i.toLowerCase().includes('boilerplate')
      )
    ) {
      recommendations.push(
        'ACTION: Replace generic phrases ("significant growth potential", "favorable regulatory environment") with specific data. Name actual companies, cite real numbers, reference specific regulations.'
      );
    }
    if (issues.some((i) => i.toLowerCase().includes('critical section missing'))) {
      recommendations.push(
        'ACTION: Critical section(s) missing from the report. A market research synthesis must include at minimum: executiveSummary, marketOpportunityAssessment, and keyInsights.'
      );
    }
    if (issues.length === 0) {
      recommendations.push('All checks passed. Narrative is coherent across sections.');
    }
  }

  return { summary, perSection, recommendations };
}

// ============ EXPORTS ============

module.exports = {
  checkStoryFlow,
  detectCoherenceBreaks,
  getRemediationHints,
  explainScore,

  // Internal helpers (exported for testing)
  extractMonetaryValues,
  extractPercentages,
  extractTimelines,
  extractEntityNames,
  getSectionTexts,
  extractKeywords,
  keywordOverlap,
  detectGenericFiller,
};
