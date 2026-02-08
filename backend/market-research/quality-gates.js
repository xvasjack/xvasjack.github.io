// Quality gates — validation functions that run BETWEEN pipeline stages.
// All gates LOG issues but NEVER block the pipeline.

// ============ HELPERS ============

function countWords(str) {
  if (!str || typeof str !== 'string') return 0;
  return str.trim().split(/\s+/).filter(Boolean).length;
}

function deepGet(obj, path) {
  if (!obj || typeof path !== 'string') return undefined;
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

function hasNumericData(arr) {
  if (!Array.isArray(arr)) return false;
  return arr.some((v) => typeof v === 'number' && !isNaN(v));
}

// ============ GATE 1: RESEARCH QUALITY ============

function validateResearchQuality(researchData) {
  const issues = [];
  const retryTopics = [];

  if (!researchData || typeof researchData !== 'object') {
    return { pass: false, score: 0, issues: ['No research data provided'], retryTopics: [] };
  }

  const entries = Object.entries(researchData);
  const topicNames = Object.keys(researchData);

  // Metric 1: Total content chars (30 pts)
  let totalChars = 0;
  for (const [, val] of entries) {
    totalChars += (val?.content || '').length;
  }
  const charScore = Math.min(30, Math.round((totalChars / 2000) * 30));
  if (totalChars < 2000) {
    issues.push(`Total content ${totalChars} chars (need >= 2000)`);
  }

  // Metric 2: Topics with 300+ char content (25 pts)
  let topicsWithContent = 0;
  for (const [name, val] of entries) {
    const len = (val?.content || '').length;
    if (len >= 300) {
      topicsWithContent++;
    } else {
      retryTopics.push(name);
    }
  }
  const topicScore = Math.min(25, Math.round((topicsWithContent / 5) * 25));
  if (topicsWithContent < 5) {
    issues.push(`Only ${topicsWithContent} topics have 300+ chars (need >= 5)`);
  }

  // Metric 3: Structured data (25 pts)
  let structuredCount = 0;
  for (const [, val] of entries) {
    if (val?.structuredData) structuredCount++;
  }
  const structuredScore = Math.min(25, Math.round((structuredCount / 3) * 25));
  if (structuredCount < 3) {
    issues.push(`Only ${structuredCount} topics have structuredData (need >= 3)`);
  }

  // Metric 4: Company mentions (10 pts)
  const companyRegex = /[A-Z][a-z]+ (?:Corp|Ltd|Inc|Co|Group|Energy|Electric|Power|Solutions)/;
  let hasCompany = false;
  const allContent = entries.map(([, v]) => v?.content || '').join(' ');
  if (companyRegex.test(allContent)) {
    hasCompany = true;
  }
  const companyScore = hasCompany ? 10 : 0;
  if (!hasCompany) {
    issues.push('No specific company names found in research content');
  }

  // Metric 5: Year mentions (10 pts)
  const yearRegex = /20[2-9]\d/;
  let hasYear = false;
  if (yearRegex.test(allContent)) {
    hasYear = true;
  }
  const yearScore = hasYear ? 10 : 0;
  if (!hasYear) {
    issues.push('No year >= 2020 mentioned in research content');
  }

  const score = charScore + topicScore + structuredScore + companyScore + yearScore;

  return {
    pass: score >= 40,
    score,
    issues,
    retryTopics,
  };
}

// ============ INDUSTRY RELEVANCE SCORING ============

function scoreIndustryRelevance(synthesis, industry) {
  if (!industry) return { score: 30, failures: [] };

  const text = JSON.stringify(synthesis).toLowerCase();
  const term = industry.toLowerCase();
  const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const matches = text.match(regex) || [];
  const count = matches.length;

  const failures = [];
  if (count < 10) {
    failures.push(
      `Content has only ${count} mentions of '${industry}' — likely padded with macro data`
    );
  }

  return {
    score: Math.min(30, count * 3),
    failures,
  };
}

// ============ GATE 2: SYNTHESIS QUALITY ============

function validateSynthesisQuality(synthesis, industry) {
  if (!synthesis || typeof synthesis !== 'object') {
    return {
      pass: false,
      sectionScores: { policy: 0, market: 0, competitors: 0, summary: 0 },
      overall: 0,
      failures: ['No synthesis data provided'],
      emptyFields: [],
    };
  }

  // Detect single-country synthesis (from synthesizeSingleCountry)
  if (synthesis.isSingleCountry) {
    return validateSingleCountrySynthesis(synthesis, industry);
  }

  // Multi-country / standard validation below
  const failures = [];
  const emptyFields = [];

  // --- Policy section (25 pts) ---
  let policyScore = 0;
  const policy = synthesis.policy;
  if (policy) {
    const acts = policy.foundationalActs?.acts || [];
    if (acts.length >= 2) {
      policyScore += 50;
    } else {
      failures.push(`Policy: only ${acts.length} foundational acts (need >= 2)`);
    }
    const validActs = acts.filter((a) => a?.name && a?.year);
    if (validActs.length >= 2) {
      policyScore += 50;
    } else {
      failures.push(`Policy: only ${validActs.length} acts have both name and year`);
    }
  } else {
    failures.push('Policy section missing');
    emptyFields.push('policy');
  }

  // --- Market section (25 pts) ---
  let marketScore = 0;
  const market = synthesis.market;
  if (market) {
    // Check sub-sections with chartData.series containing numeric values
    const marketSubSections = [
      'tpes',
      'finalDemand',
      'electricity',
      'gasLng',
      'pricing',
      'escoMarket',
    ];
    let sectionsWithCharts = 0;
    for (const sub of marketSubSections) {
      const section = market[sub];
      if (section?.chartData?.series && hasNumericData(flattenSeries(section.chartData.series))) {
        sectionsWithCharts++;
      }
    }
    if (sectionsWithCharts >= 3) {
      marketScore += 50;
    } else {
      failures.push(
        `Market: only ${sectionsWithCharts}/6 sub-sections have numeric chart data (need >= 3)`
      );
    }

    // escoMarket.marketSize check
    if (market.escoMarket?.marketSize) {
      marketScore += 50;
    } else {
      failures.push('Market: escoMarket.marketSize is empty');
      emptyFields.push('market.escoMarket.marketSize');
    }
  } else {
    failures.push('Market section missing');
    emptyFields.push('market');
  }

  // --- Competitors section (25 pts) ---
  let competitorsScore = 0;
  const competitors = synthesis.competitors;
  if (competitors) {
    // Find all arrays of objects with 'name' field
    let totalCompanies = 0;
    let totalDescWords = 0;
    let descCount = 0;
    for (const [, val] of Object.entries(competitors)) {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item?.name) {
            totalCompanies++;
            const desc = item.description || item.overview || '';
            const wc = countWords(desc);
            totalDescWords += wc;
            descCount++;
          }
        }
      } else if (val && typeof val === 'object') {
        // Check nested arrays (e.g. competitors.majorPlayers.domestic)
        for (const [, nested] of Object.entries(val)) {
          if (Array.isArray(nested)) {
            for (const item of nested) {
              if (item?.name) {
                totalCompanies++;
                const desc = item.description || item.overview || '';
                const wc = countWords(desc);
                totalDescWords += wc;
                descCount++;
              }
            }
          }
        }
      }
    }

    if (totalCompanies >= 5) {
      competitorsScore += 50;
    } else {
      failures.push(`Competitors: only ${totalCompanies} companies found (need >= 5)`);
    }

    const avgDescWords = descCount > 0 ? totalDescWords / descCount : 0;
    if (avgDescWords >= 40) {
      competitorsScore += 50;
    } else {
      failures.push(
        `Competitors: average description ${Math.round(avgDescWords)} words (need >= 40)`
      );
    }
  } else {
    failures.push('Competitors section missing');
    emptyFields.push('competitors');
  }

  // --- Summary section (25 pts) ---
  let summaryScore = 0;
  const summary = synthesis.summary;
  if (summary) {
    const insights = summary.keyInsights || [];
    const insightsWithData = insights.filter((i) => i?.data && /\d/.test(String(i.data)));
    if (insightsWithData.length >= 2) {
      summaryScore += 50;
    } else {
      failures.push(
        `Summary: only ${insightsWithData.length} insights with numeric data (need >= 2)`
      );
    }

    const opportunities = summary.opportunities || [];
    if (opportunities.length >= 2) {
      summaryScore += 50;
    } else {
      failures.push(`Summary: only ${opportunities.length} opportunities (need >= 2)`);
    }
  } else {
    failures.push('Summary section missing');
    emptyFields.push('summary');
  }

  // Fix 14: Industry-specificity scoring
  const industryRelevance = scoreIndustryRelevance(synthesis, industry);
  failures.push(...industryRelevance.failures);

  const overall = Math.round(
    ((policyScore + marketScore + competitorsScore + summaryScore) / 4) * 0.7 +
      industryRelevance.score
  );

  return {
    pass: overall >= 40,
    sectionScores: {
      policy: policyScore,
      market: marketScore,
      competitors: competitorsScore,
      summary: summaryScore,
      industryRelevance: industryRelevance.score,
    },
    overall,
    failures,
    emptyFields,
  };
}

// Single-country synthesis validation
// Checks fields from synthesizeSingleCountry(): executiveSummary, marketOpportunityAssessment,
// competitivePositioning, keyInsights
function validateSingleCountrySynthesis(synthesis, industry) {
  const failures = [];
  const emptyFields = [];

  // --- Executive Summary (25 pts) ---
  let execScore = 0;
  const execSummary = synthesis.executiveSummary;
  if (Array.isArray(execSummary)) {
    // Filter to actual paragraphs (skip instruction strings)
    const paragraphs = execSummary.filter((p) => typeof p === 'string' && countWords(p) >= 20);
    if (paragraphs.length >= 3) {
      execScore = 100;
    } else if (paragraphs.length >= 2) {
      execScore = 60;
      failures.push(
        `ExecutiveSummary: only ${paragraphs.length} substantial paragraphs (need >= 3)`
      );
    } else if (paragraphs.length >= 1) {
      execScore = 30;
      failures.push(
        `ExecutiveSummary: only ${paragraphs.length} substantial paragraphs (need >= 3)`
      );
    } else {
      failures.push('ExecutiveSummary: no substantial paragraphs');
    }
  } else if (typeof execSummary === 'string' && countWords(execSummary) >= 50) {
    execScore = 60;
  } else {
    failures.push('ExecutiveSummary section missing or empty');
    emptyFields.push('executiveSummary');
  }

  // --- Market Opportunity Assessment (25 pts) ---
  let marketScore = 0;
  const moa = synthesis.marketOpportunityAssessment;
  if (moa && typeof moa === 'object') {
    if (moa.totalAddressableMarket && /\d/.test(String(moa.totalAddressableMarket))) {
      marketScore += 50;
    } else {
      failures.push('MarketOpportunity: totalAddressableMarket missing or has no numbers');
    }
    // Check for at least one other substantive field
    const otherFields = ['serviceableMarket', 'growthTrajectory', 'timingConsiderations'];
    const filledOthers = otherFields.filter(
      (f) => moa[f] && typeof moa[f] === 'string' && moa[f].length > 10
    );
    if (filledOthers.length >= 1) {
      marketScore += 50;
    } else {
      failures.push(
        'MarketOpportunity: needs at least one of serviceableMarket/growthTrajectory/timingConsiderations'
      );
    }
  } else {
    failures.push('MarketOpportunityAssessment section missing');
    emptyFields.push('marketOpportunityAssessment');
  }

  // --- Competitive Positioning (25 pts) ---
  let compScore = 0;
  const cp = synthesis.competitivePositioning;
  if (cp && typeof cp === 'object') {
    const players = cp.keyPlayers || [];
    const namedPlayers = players.filter((p) => p?.name);
    if (namedPlayers.length >= 3) {
      compScore += 50;
    } else {
      failures.push(
        `CompetitivePositioning: only ${namedPlayers.length} named key players (need >= 3)`
      );
    }
    // Check description quality
    let totalDescWords = 0;
    let descCount = 0;
    for (const player of namedPlayers) {
      const desc = player.description || '';
      totalDescWords += countWords(desc);
      descCount++;
    }
    const avgDesc = descCount > 0 ? totalDescWords / descCount : 0;
    if (avgDesc >= 30) {
      compScore += 50;
    } else if (namedPlayers.length >= 3) {
      // Players exist but descriptions are thin
      compScore += 20;
      failures.push(
        `CompetitivePositioning: average description ${Math.round(avgDesc)} words (need >= 30)`
      );
    }

    // Content validation: check competitor descriptions for specific metrics
    const metricPatterns = [
      /\$[\d,.]+[BMKbmk]?(?:\s+(?:billion|million|revenue))?/i,
      /\d+(\.\d+)?%\s*(?:market\s+share|share)/i,
      /\d+(\.\d+)?%\s*(?:growth|CAGR|increase|decline)/i,
      /(?:entered|established|founded|launched)\s+(?:in\s+)?\d{4}/i,
    ];
    for (const player of namedPlayers) {
      const desc = player.description || '';
      const wc = countWords(desc);
      if (wc >= 45) {
        const hasMetric = metricPatterns.some((pat) => pat.test(desc));
        if (!hasMetric) {
          failures.push(
            `CompetitivePositioning: "${player.name}" description has enough words but lacks specific metrics (revenue, market share, growth, entry year)`
          );
          compScore = Math.max(0, compScore - 10);
        }
      }
    }
  } else {
    failures.push('CompetitivePositioning section missing');
    emptyFields.push('competitivePositioning');
  }

  // --- Key Insights (25 pts) ---
  let insightsScore = 0;
  const insights = synthesis.keyInsights;
  if (Array.isArray(insights)) {
    // Filter to structured insight objects (skip instruction strings)
    const structuredInsights = insights.filter((i) => i && typeof i === 'object' && i.title);
    const withData = structuredInsights.filter((i) => i.data && /\d/.test(String(i.data)));
    const withImplication = structuredInsights.filter(
      (i) => i.implication && i.implication.length > 10
    );

    // Completeness: 75% of insights must have both data and implication
    const complete = structuredInsights.filter(
      (i) => i.data && /\d/.test(String(i.data)) && i.implication && i.implication.length > 10
    );
    const completeness =
      structuredInsights.length > 0 ? complete.length / structuredInsights.length : 0;

    if (withData.length >= 2 && withImplication.length >= 2 && completeness >= 0.75) {
      insightsScore = 100;
    } else if (withData.length >= 2 && withImplication.length >= 2) {
      insightsScore = 70;
      failures.push(
        `KeyInsights: completeness ${Math.round(completeness * 100)}% (need >= 75% with both data and implication)`
      );
    } else if (withData.length >= 1) {
      insightsScore = 50;
      failures.push(
        `KeyInsights: ${withData.length} with data, ${withImplication.length} with implications (need >= 2 each)`
      );
    } else {
      failures.push('KeyInsights: no insights with numeric data');
    }

    // Timing validation: timing field must contain a year or quarter
    const timingPattern = /\d{4}|Q[1-4]/;
    for (const insight of structuredInsights) {
      if (insight.timing && !timingPattern.test(String(insight.timing))) {
        failures.push(
          `KeyInsights: "${insight.title}" timing "${insight.timing}" lacks a year (YYYY) or quarter (Q1-Q4)`
        );
        insightsScore = Math.max(0, insightsScore - 10);
      }
    }
  } else {
    failures.push('KeyInsights section missing');
    emptyFields.push('keyInsights');
  }

  // --- Implementation Roadmap (scored separately, added to overall) ---
  let roadmapScore = 0;
  const phases = synthesis.implementation?.phases;
  if (!Array.isArray(phases) || phases.length < 2) {
    failures.push('Missing implementation roadmap');
    roadmapScore = 0;
  } else {
    const allComplete = phases.every(
      (p) => Array.isArray(p?.activities) && p.activities.length > 0 && p.investment != null
    );
    const hasActivitiesOnly = phases.every(
      (p) => Array.isArray(p?.activities) && p.activities.length > 0
    );
    if (allComplete) {
      roadmapScore = 100;
    } else if (hasActivitiesOnly) {
      roadmapScore = 50;
      failures.push('Implementation roadmap phases missing investment fields');
    } else {
      roadmapScore = 25;
      failures.push('Implementation roadmap phases missing activities or investment');
    }
  }

  // --- Macro-data padding detection ---
  const macroWarnings = detectMacroPadding(
    JSON.stringify(synthesis.competitivePositioning) +
      JSON.stringify(synthesis.marketOpportunityAssessment) +
      JSON.stringify(synthesis.keyInsights),
    industry
  );
  failures.push(...macroWarnings);

  // Fix 14: Industry-specificity scoring
  const industryRelevance = scoreIndustryRelevance(synthesis, industry);
  failures.push(...industryRelevance.failures);

  const overall = Math.round(
    ((execScore + marketScore + compScore + insightsScore + roadmapScore) / 5) * 0.7 +
      industryRelevance.score
  );

  return {
    pass: overall >= 60,
    sectionScores: {
      executiveSummary: execScore,
      marketOpportunity: marketScore,
      competitivePositioning: compScore,
      keyInsights: insightsScore,
      roadmap: roadmapScore,
      industryRelevance: industryRelevance.score,
    },
    overall,
    failures,
    emptyFields,
  };
}

// Helper: flatten chart series into a single array of values
function flattenSeries(series) {
  if (!series) return [];
  if (Array.isArray(series)) {
    // series could be [{data: [1,2,3]}, ...] or just [1,2,3]
    const result = [];
    for (const item of series) {
      if (typeof item === 'number') {
        result.push(item);
      } else if (item?.data && Array.isArray(item.data)) {
        result.push(...item.data);
      } else if (item?.values && Array.isArray(item.values)) {
        result.push(...item.values);
      }
    }
    return result;
  }
  return [];
}

// ============ GATE 3: PPT DATA ============

function validatePptData(blocks) {
  const overflowRisks = [];
  const emptyBlocks = [];
  const chartIssues = [];

  if (!Array.isArray(blocks) || blocks.length === 0) {
    return {
      pass: false,
      overflowRisks: [],
      emptyBlocks: ['No blocks provided'],
      chartIssues: [],
    };
  }

  // Check sections with real data (at least 3 of 5)
  const sectionNames = [...new Set(blocks.map((b) => b?.key).filter(Boolean))];
  const sectionsWithData = sectionNames.filter((section) => {
    const sectionBlocks = blocks.filter((b) => b?.key === section);
    return sectionBlocks.some(
      (b) => b?.type !== 'unavailable' && b?.content !== 'Data unavailable'
    );
  });

  if (sectionsWithData.length < 3) {
    emptyBlocks.push(`Only ${sectionsWithData.length}/5 sections have real data (need >= 3)`);
  }

  // Check company descriptions
  for (const block of blocks) {
    if (block?.type === 'company' || block?.type === 'competitor') {
      const desc = block.description || block.content || '';
      const wc = countWords(desc);
      if (wc < 30) {
        emptyBlocks.push(
          `Company "${block.name || block.title || 'unknown'}": description only ${wc} words (min 30)`
        );
      }
    }
  }

  // Check for overflow risks
  for (const block of blocks) {
    if (!block) continue;
    for (const [field, val] of Object.entries(block)) {
      if (typeof val === 'string' && val.length > 300) {
        overflowRisks.push({
          block: block.title || block.name || block.section || 'unknown',
          field,
          charCount: val.length,
        });
      }
    }
  }

  // Check chart data values are numbers and minimum data points
  for (const block of blocks) {
    if (block?.chartData?.series) {
      const values = flattenSeries(block.chartData.series);
      const nonNumeric = values.filter((v) => typeof v !== 'number' || isNaN(v));
      if (nonNumeric.length > 0) {
        chartIssues.push(
          `Block "${block.title || 'unknown'}": ${nonNumeric.length} non-numeric values in chart series`
        );
      }
      // Minimum 4 data points required (was 3)
      const numericValues = values.filter((v) => typeof v === 'number' && !isNaN(v));
      if (numericValues.length < 4) {
        chartIssues.push(
          `Block "${block.title || 'unknown'}": only ${numericValues.length} data points (need >= 4)`
        );
      } else if (numericValues.length < 5) {
        // Warning only, not a hard failure
        emptyBlocks.push(
          `Chart "${block.title || 'unknown'}" has only ${numericValues.length} data points — template shows 5+`
        );
      }
    }
  }

  // Check "Data unavailable" ratio
  const unavailableCount = blocks.filter(
    (b) => b?.type === 'unavailable' || b?.content === 'Data unavailable'
  ).length;
  const unavailableRatio = unavailableCount / blocks.length;
  if (unavailableRatio >= 0.4) {
    emptyBlocks.push(
      `${Math.round(unavailableRatio * 100)}% of blocks are "Data unavailable" (threshold < 40%)`
    );
  }

  const pass = sectionsWithData.length >= 3 && unavailableRatio < 0.4 && chartIssues.length === 0;

  return {
    pass,
    overflowRisks,
    emptyBlocks,
    chartIssues,
  };
}

// ============ MACRO-DATA PADDING DETECTION ============

function detectMacroPadding(text, industry) {
  const warnings = [];
  if (!text || typeof text !== 'string') return warnings;
  if (!industry) return warnings;

  const macroRegex =
    /\b(GDP|gross domestic product|population|inflation rate|trade balance|current account)\b/gi;
  let match;
  const seen = new Set();
  while ((match = macroRegex.exec(text)) !== null) {
    const term = match[1].toLowerCase();
    if (!seen.has(term)) {
      seen.add(term);
      warnings.push(`Possible macro-data padding: '${match[1]}' found in industry-specific field`);
    }
  }
  return warnings;
}

module.exports = {
  validateResearchQuality,
  validateSynthesisQuality,
  validatePptData,
  detectMacroPadding,
};
