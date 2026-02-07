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

// ============ GATE 2: SYNTHESIS QUALITY ============

function validateSynthesisQuality(synthesis) {
  const failures = [];
  const emptyFields = [];

  if (!synthesis || typeof synthesis !== 'object') {
    return {
      pass: false,
      sectionScores: { policy: 0, market: 0, competitors: 0, summary: 0 },
      overall: 0,
      failures: ['No synthesis data provided'],
      emptyFields: [],
    };
  }

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
      'escoMarket',
      'energyEfficiency',
      'renewableEnergy',
      'buildingEnergy',
      'industrialEnergy',
      'evMarket',
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

  const overall = Math.round((policyScore + marketScore + competitorsScore + summaryScore) / 4);

  return {
    pass: overall >= 40,
    sectionScores: {
      policy: policyScore,
      market: marketScore,
      competitors: competitorsScore,
      summary: summaryScore,
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
  const sectionNames = [...new Set(blocks.map((b) => b?.section).filter(Boolean))];
  const sectionsWithData = sectionNames.filter((section) => {
    const sectionBlocks = blocks.filter((b) => b?.section === section);
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

  // Check chart data values are numbers
  for (const block of blocks) {
    if (block?.chartData?.series) {
      const values = flattenSeries(block.chartData.series);
      const nonNumeric = values.filter((v) => typeof v !== 'number' || isNaN(v));
      if (nonNumeric.length > 0) {
        chartIssues.push(
          `Block "${block.title || 'unknown'}": ${nonNumeric.length} non-numeric values in chart series`
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

module.exports = {
  validateResearchQuality,
  validateSynthesisQuality,
  validatePptData,
};
