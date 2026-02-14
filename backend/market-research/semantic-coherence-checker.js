/**
 * Semantic Coherence Checker
 *
 * Cross-section coherence analysis for market-research synthesis outputs.
 * Detects numeric/factual mismatches, timeline inconsistencies,
 * and entity naming divergences across linked sections.
 */

const { normalizeCurrency, normalizeTimePeriod } = require('./semantic-quality-engine');

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

// ============ COHERENCE CHECK ============

/**
 * Check coherence across linked sections of a synthesis.
 *
 * - Market size claims match across market overview vs executive summary vs deal economics
 * - Timeline claims consistent (entry strategy timeline vs implementation phases)
 * - Company names consistent across competitor sections
 *
 * @param {object} synthesis - Full synthesis object
 * @returns {{ score, issues[], linkedPairs[] }}
 */
function checkCoherence(synthesis) {
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
          if (ratio > 3) {
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
          if (ratio > 3) {
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

  // Calculate score: start at 100, deduct for issues
  const score = Math.max(0, Math.min(100, 100 - issues.length * 15));

  return { score, issues, linkedPairs };
}

// ============ COHERENCE BREAK DETECTION ============

/**
 * Find specific numeric/factual mismatches between sections.
 * More granular than checkCoherence — identifies exact break points.
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
 * @param {Array<string>} issues - Array of issue description strings from checkCoherence
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
 * @param {{ score, issues, linkedPairs }} analysis - Output from checkCoherence
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
        } else if (pair.ratio && pair.ratio > 3) {
          sectionStatus[section].problems++;
          sectionStatus[section].details.push(`${pair.type} mismatch (${pair.ratio}x difference)`);
        }
      }
    }
  }

  const perSection = Object.entries(sectionStatus).map(([section, data]) => ({
    section,
    status: data.problems === 0 ? 'consistent' : 'issues-found',
    details: data.details.length > 0 ? data.details.join('; ') : 'All checks passed',
  }));

  // Summary
  let summary;
  if (score >= 80) {
    summary = `Coherence score: ${score}/100 (strong). Sections are well-aligned with minimal inconsistencies.`;
  } else if (score >= 50) {
    summary = `Coherence score: ${score}/100 (moderate). Some cross-section inconsistencies detected that should be resolved.`;
  } else {
    summary = `Coherence score: ${score}/100 (weak). Significant mismatches across sections — synthesis needs reconciliation.`;
  }

  // Recommendations from issues
  const recommendations = [];
  if (Array.isArray(issues)) {
    if (issues.some((i) => i.toLowerCase().includes('market size'))) {
      recommendations.push(
        'Standardize market size figures across executive summary, market assessment, and deal economics.'
      );
    }
    if (issues.some((i) => i.toLowerCase().includes('timeline'))) {
      recommendations.push(
        'Reconcile timeline claims between entry strategy and implementation sections.'
      );
    }
    if (issues.some((i) => i.toLowerCase().includes('entity'))) {
      recommendations.push(
        'Ensure all named companies are consistently referenced across competitive and summary sections.'
      );
    }
    if (issues.length === 0) {
      recommendations.push('No issues found. Maintain current consistency across sections.');
    }
  }

  return { summary, perSection, recommendations };
}

// ============ EXPORTS ============

module.exports = {
  checkCoherence,
  detectCoherenceBreaks,
  getRemediationHints,
  explainScore,

  // Internal helpers (exported for testing)
  extractMonetaryValues,
  extractPercentages,
  extractTimelines,
  extractEntityNames,
  getSectionTexts,
};
