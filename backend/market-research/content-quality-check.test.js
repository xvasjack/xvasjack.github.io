const {
  analyze,
  getDecisionScore,
  checkContradictions,
  antiShallow,
  parseDealEconomics,
  checkPlausibility,
  generateDealEconomicsRenderBlocks,
  normalizeCurrency,
  normalizePercentage,
  normalizeTimePeriod,
  detectFactDump,
  detectMacroPadding,
  detectEmptyCalories,
  scoreDecisionUsefulness,
  extractClaims,
} = require('./content-quality-check');

// ============ DEAL ECONOMICS PARSING ============

describe('parseDealEconomics', () => {
  test('parses a complete deal economics object', () => {
    const dealEcon = {
      typicalDealSize: { min: '$2M', max: '$10M', average: '$5M' },
      contractTerms: {
        duration: '5 years',
        revenueSplit: 'Client 70% / Provider 30%',
        guaranteeStructure: 'Performance',
      },
      financials: { paybackPeriod: '3 years', irr: '15-20%', marginProfile: '35%' },
      financingOptions: ['Project finance', 'ESCO model', 'Green bonds'],
      keyInsight: 'Strong IRR driven by regulatory mandates',
    };

    const result = parseDealEconomics(dealEcon);
    expect(result.valid).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(75);
    expect(result.fields.dealSize.min.value).toBe(2000000);
    expect(result.fields.dealSize.max.value).toBe(10000000);
    expect(result.fields.contractDuration).toBe(60);
    expect(result.fields.irr).toBe(17.5); // midpoint of 15-20%
    expect(result.fields.paybackPeriod).toBe(36);
    expect(result.fields.financingOptions).toHaveLength(3);
    expect(result.issues).toHaveLength(0);
  });

  test('handles missing fields gracefully', () => {
    const result = parseDealEconomics({ typicalDealSize: { average: '$5M' } });
    expect(result.valid).toBe(false);
    expect(result.confidence).toBeLessThan(50);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test('returns invalid for null/undefined input', () => {
    expect(parseDealEconomics(null).valid).toBe(false);
    expect(parseDealEconomics(undefined).valid).toBe(false);
    expect(parseDealEconomics({}).confidence).toBe(0);
  });
});

// ============ NORMALIZATION ============

describe('normalizeCurrency', () => {
  test('parses "$5M" format', () => {
    const result = normalizeCurrency('$5M');
    expect(result).toEqual({ value: 5000000, currency: 'USD' });
  });

  test('parses "€2.3 billion" format', () => {
    const result = normalizeCurrency('€2.3 billion');
    expect(result).toEqual({ value: 2300000000, currency: 'EUR' });
  });

  test('parses "500K USD" format', () => {
    const result = normalizeCurrency('500K USD');
    expect(result).toEqual({ value: 500000, currency: 'USD' });
  });

  test('parses plain number with symbol', () => {
    const result = normalizeCurrency('£1000');
    expect(result).toEqual({ value: 1000, currency: 'GBP' });
  });

  test('returns null for unparseable input', () => {
    expect(normalizeCurrency('')).toBeNull();
    expect(normalizeCurrency(null)).toBeNull();
    expect(normalizeCurrency('N/A')).toBeNull();
  });
});

describe('normalizePercentage', () => {
  test('parses "15%" format', () => {
    expect(normalizePercentage('15%')).toBe(15);
  });

  test('parses "15-20%" range to midpoint', () => {
    expect(normalizePercentage('15-20%')).toBe(17.5);
  });

  test('parses "8.5 percent"', () => {
    expect(normalizePercentage('8.5 percent')).toBe(8.5);
  });

  test('returns null for non-percentage', () => {
    expect(normalizePercentage('hello')).toBeNull();
  });
});

describe('normalizeTimePeriod', () => {
  test('parses "5 years" to months', () => {
    expect(normalizeTimePeriod('5 years')).toBe(60);
  });

  test('parses "18 months"', () => {
    expect(normalizeTimePeriod('18 months')).toBe(18);
  });

  test('parses "2-3 years" range to midpoint in months', () => {
    expect(normalizeTimePeriod('2-3 years')).toBe(30);
  });

  test('parses "Month 18" format', () => {
    expect(normalizeTimePeriod('Month 18')).toBe(18);
  });
});

// ============ PLAUSIBILITY ============

describe('checkPlausibility', () => {
  test('flags implausible IRR (1000%)', () => {
    const parsed = {
      valid: true,
      fields: { irr: 1000 },
    };
    const warnings = checkPlausibility(parsed);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].field).toBe('irr');
    expect(warnings[0].severity).toBe('error');
  });

  test('flags payback period of 0 months', () => {
    const parsed = {
      valid: true,
      fields: { paybackPeriod: 0 },
    };
    const warnings = checkPlausibility(parsed);
    expect(warnings.some((w) => w.field === 'paybackPeriod' && w.severity === 'error')).toBe(true);
  });

  test('flags deal size min > max', () => {
    const parsed = {
      valid: true,
      fields: {
        dealSize: {
          min: { value: 10000000, currency: 'USD' },
          max: { value: 5000000, currency: 'USD' },
        },
      },
    };
    const warnings = checkPlausibility(parsed);
    expect(warnings.some((w) => w.field === 'dealSize')).toBe(true);
  });

  test('accepts reasonable values without errors', () => {
    const parsed = {
      valid: true,
      fields: {
        irr: 15,
        paybackPeriod: 36,
        contractDuration: 60,
        dealSize: {
          min: { value: 2000000, currency: 'USD' },
          max: { value: 10000000, currency: 'USD' },
        },
      },
    };
    const warnings = checkPlausibility(parsed);
    const errors = warnings.filter((w) => w.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});

// ============ CONTRADICTION DETECTION ============

describe('checkContradictions', () => {
  test('detects contradictory growth claims', () => {
    const synthesis = {
      marketOpportunityAssessment: {
        growthTrajectory:
          'The energy services market is growing at 15% CAGR driven by policy mandates',
      },
      competitivePositioning: {
        analysis: 'The energy services market is declining due to oversupply and weak demand',
      },
    };

    const contradictions = checkContradictions(synthesis);
    expect(contradictions.length).toBeGreaterThan(0);
  });

  test('returns empty for consistent data', () => {
    const synthesis = {
      marketOpportunityAssessment: {
        growthTrajectory: 'Solar market growing at 20% CAGR',
        totalAddressableMarket: '$500M expanding rapidly',
      },
    };

    const contradictions = checkContradictions(synthesis);
    expect(contradictions).toHaveLength(0);
  });
});

// ============ DECISION-USEFULNESS ============

describe('getDecisionScore', () => {
  test('scores high-quality synthesis above threshold', () => {
    const synthesis = {
      executiveSummary: [
        "Thailand's energy services market reached $320M in 2024, growing at 14% CAGR since 2020. ENGIE Corp and Schneider Electric dominate with combined 35% market share. We recommend targeting mid-tier industrial factories because their energy spend averages $500K annually, which means significant savings potential. The regulatory push from DEDE creates urgency for compliance-driven demand.",
      ],
      marketOpportunityAssessment: {
        totalAddressableMarket:
          '$90M calculated from 1,200 factories at $500K average spend with 15% savings potential. This represents a significant opportunity because industrial energy costs are rising 8% annually, resulting in increased demand for efficiency services. Schneider Electric entered in 2018 and should prioritize expanding beyond Bangkok.',
      },
      competitivePositioning: {
        keyPlayers: [
          {
            name: 'ENGIE Corp',
            description:
              '$2.3B revenue, 18% market share, entered Thailand in 2015 via JV with B.Grimm Power Ltd. Focus on industrial parks, 12 active contracts averaging $2M each. Therefore their weakness is limited provincial network coverage.',
          },
        ],
      },
      keyInsights: [
        {
          title: 'Labor cost pressure makes energy savings an HR priority',
          data: 'Manufacturing wages rose 8% annually 2021-2024 because aging workforce drives inflation. Should target CFOs by Q2 2026.',
          pattern: 'Cost pressure mechanism',
          implication: 'Position as cost management, recommend targeting before budget cycles',
          timing: 'By Q2 2026',
        },
      ],
    };

    const result = getDecisionScore(synthesis);
    expect(result.overall).toBeGreaterThan(20);
    expect(result.flagged.length).toBeLessThan(6);
  });

  test('flags low-quality generic synthesis', () => {
    const synthesis = {
      executiveSummary: 'The market is growing and there are opportunities.',
      marketOpportunityAssessment: { totalAddressableMarket: 'Large market' },
      competitivePositioning: { keyPlayers: [] },
      keyInsights: [],
    };

    const result = getDecisionScore(synthesis);
    expect(result.overall).toBeLessThan(30);
    expect(result.flagged.length).toBeGreaterThan(0);
  });
});

// ============ ANTI-SHALLOW ============

describe('antiShallow', () => {
  test('detects fact dump pattern', () => {
    const text = `
- GDP growth is 5.2%
- Population is 70 million
- Inflation rate is 3.1%
- Trade balance is positive
- Foreign investment is increasing
- Manufacturing sector is large
- Tourism contributes 12% of GDP
- Agriculture employs 30% of workforce
- Infrastructure spending is rising
- Education levels are improving
- Healthcare spending is growing
- Technology adoption is increasing
    `.trim();

    const result = antiShallow(text, 'energy services');
    expect(result.pass).toBe(false);
    expect(result.issues.some((i) => i.includes('Fact dump'))).toBe(true);
  });

  test('detects macro padding', () => {
    const text = `The GDP of Thailand reached $500 billion in 2024. The population stands at 70 million people. The inflation rate has been stable at 2.5%. The current account surplus indicates strong macroeconomic fundamentals. Foreign direct investment inflows reached $15B. The trade balance remains favorable due to strong exports.`;

    const result = antiShallow(text, 'energy services');
    expect(result.pass).toBe(false);
    expect(result.issues.some((i) => i.includes('Macro padding'))).toBe(true);
  });

  test('detects empty calories', () => {
    const text = `It is worth noting that the market presents various significant opportunities in several key areas. It is important to note that numerous substantial factors could potentially drive considerable growth. Many important stakeholders may consider various essential strategies going forward. The fundamental dynamics appear to suggest that critical developments might lead to major changes in this context. With respect to the overall landscape, it should be noted that significant considerations are important.`;

    const result = antiShallow(text, 'energy services');
    expect(result.pass).toBe(false);
    expect(result.issues.some((i) => i.includes('Empty calories'))).toBe(true);
  });

  test('passes for high-quality analytical text', () => {
    const text = `ENGIE Corp entered Thailand in 2018 via JV with B.Grimm, focusing on industrial parks near Bangkok. They've won 12 contracts averaging $2M each, however their provincial network coverage remains limited because B.Grimm's operations concentrate in the Eastern Seaboard. This means competitors with regional partnerships can capture the 40% of industrial demand outside Bangkok. Therefore, a joint venture with a provincial utility would provide geographic coverage that ENGIE currently lacks. Manufacturing wages rose 8% annually from 2021-2024, consequently factory operators seek 15-20% energy cost reductions. Schneider Electric's revenue in Thailand grew to $180M in 2024.`;

    const result = antiShallow(text, 'energy services');
    expect(result.pass).toBe(true);
  });
});

// ============ RENDER BLOCKS ============

describe('generateDealEconomicsRenderBlocks', () => {
  test('generates blocks from valid parsed deal economics', () => {
    const parsed = parseDealEconomics({
      typicalDealSize: { min: '$2M', max: '$10M', average: '$5M' },
      contractTerms: { duration: '5 years', revenueSplit: '70/30' },
      financials: { paybackPeriod: '3 years', irr: '18%' },
      financingOptions: ['Project finance', 'Green bonds'],
      keyInsight: 'Strong returns driven by mandates',
    });

    const blocks = generateDealEconomicsRenderBlocks(parsed);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks.every((b) => b.key === 'dealEconomics')).toBe(true);
    expect(blocks.some((b) => b.title === 'Typical Deal Size')).toBe(true);
    expect(blocks.some((b) => b.title === 'Financial Metrics')).toBe(true);
  });

  test('returns empty for invalid parsed data', () => {
    const blocks = generateDealEconomicsRenderBlocks({ valid: false });
    expect(blocks).toHaveLength(0);
  });
});

// ============ FULL ANALYSIS ============

describe('analyze', () => {
  test('returns comprehensive report for good synthesis', () => {
    const synthesis = {
      executiveSummary: [
        "Thailand's energy services market reached $320M in 2024, growing at 14% CAGR. ENGIE Corp and Schneider Electric dominate. We recommend targeting mid-tier industrial factories because energy costs are rising, which means significant savings potential. The DEDE regulatory push should create urgency.",
      ],
      marketOpportunityAssessment: {
        totalAddressableMarket: '1200 factories x $500K = $90M TAM',
        serviceableMarket: '$45M with 50% penetration assumption',
        growthTrajectory: '14% CAGR driven by ISO 50001 mandate',
      },
      competitivePositioning: {
        keyPlayers: [{ name: 'ENGIE Corp', description: 'Major player with $2.3B global revenue' }],
        whiteSpaces: ['Provincial coverage gap outside Bangkok'],
      },
      keyInsights: [
        {
          title: 'Cost pressure insight',
          data: '8% annual wage increase 2021-2024',
          pattern: 'Aging workforce',
          implication: 'Target CFOs',
          timing: 'Q2 2026',
        },
      ],
      depth: {
        dealEconomics: {
          typicalDealSize: { min: '$2M', max: '$10M', average: '$5M' },
          contractTerms: { duration: '5 years' },
          financials: { paybackPeriod: '3 years', irr: '18%' },
          keyInsight: 'Solid returns',
        },
      },
    };

    const report = analyze(synthesis, 'energy services');
    expect(report).toHaveProperty('overallScore');
    expect(report).toHaveProperty('sectionScores');
    expect(report).toHaveProperty('contradictions');
    expect(report).toHaveProperty('plausibility');
    expect(report).toHaveProperty('antiShallowResults');
    expect(report).toHaveProperty('suggestions');
    expect(report.overallScore).toBeGreaterThan(0);
  });

  test('returns low score for empty synthesis', () => {
    const report = analyze({}, 'energy services');
    expect(report.overallScore).toBe(0);
    expect(report.pass).toBe(false);
  });

  test('returns zero for null input', () => {
    const report = analyze(null);
    expect(report.overallScore).toBe(0);
    expect(report.pass).toBe(false);
    expect(report.suggestions).toContain('No synthesis data provided');
  });
});

// ============ SPARSE / NOISY PAYLOAD REGRESSION ============

describe('sparse and noisy payload handling', () => {
  test('handles synthesis with all null depth fields', () => {
    const synthesis = {
      executiveSummary: ['A reasonable paragraph about the market with enough words to count.'],
      depth: {
        dealEconomics: null,
        partnerAssessment: null,
      },
    };

    const report = analyze(synthesis, 'technology');
    expect(report).toHaveProperty('overallScore');
    expect(report.plausibility).toHaveLength(0);
  });

  test('handles synthesis with deeply nested empty strings', () => {
    const synthesis = {
      executiveSummary: '',
      marketOpportunityAssessment: {
        totalAddressableMarket: '',
        serviceableMarket: '',
        growthTrajectory: '',
      },
      depth: {
        dealEconomics: {
          typicalDealSize: { min: '', max: '', average: '' },
          contractTerms: { duration: '' },
          financials: { paybackPeriod: '', irr: '' },
        },
      },
    };

    const report = analyze(synthesis, 'healthcare');
    expect(report.overallScore).toBeLessThan(20);
    expect(report.pass).toBe(false);
  });

  test('handles noisy JSON with extra fields', () => {
    const synthesis = {
      _metadata: { generatedAt: '2026-01-01' },
      randomField: [1, 2, 3],
      executiveSummary: [
        'Valid paragraph with Schneider Electric Corp reaching $180M revenue in 2024, growing at 12% annually. This represents a compelling opportunity because industrial demand is rising.',
      ],
      depth: {
        dealEconomics: {
          typicalDealSize: { min: '$1M', max: '$8M', average: '$4M' },
          financials: { irr: '22%', paybackPeriod: '4 years' },
          extraNestedField: { foo: 'bar' },
        },
      },
    };

    const report = analyze(synthesis, 'manufacturing');
    expect(report).toHaveProperty('overallScore');
    // Should not crash on extra fields
    expect(report.plausibility.filter((p) => p.severity === 'error')).toHaveLength(0);
  });
});

// ============ EXTRACT CLAIMS ============

describe('extractClaims', () => {
  test('extracts growth claims from text', () => {
    const text =
      'The solar market is growing at 20% annually. Battery storage demand increased by 35%.';
    const claims = extractClaims(text);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.some((c) => c.direction === 'up')).toBe(true);
  });

  test('extracts decline claims', () => {
    const text = 'Coal demand is declining rapidly. Fossil fuel investment decreased by 15%.';
    const claims = extractClaims(text);
    expect(claims.some((c) => c.direction === 'down')).toBe(true);
  });

  test('returns empty for neutral text', () => {
    const claims = extractClaims('The company was founded in 2005 and has 500 employees.');
    expect(claims).toHaveLength(0);
  });
});
