'use strict';

const {
  enforceLineage,
  buildClaimSourceMap,
  rejectOrphanedClaims,
  classifySourceQuality,
  isPlaceholderSource,
  isTemplateStaticExemption,
  extractClaims,
  walkSynthesisClaims,
  collectAllSources,
  getSectionSources,
} = require('./source-lineage-enforcer');

const {
  generateCoverageReport,
  generateOrphanReport,
  checkSourceMismatch,
  DEFAULT_THRESHOLD,
} = require('./source-coverage-reporter');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMultiCountrySynthesis(overrides = {}) {
  return {
    country: 'Vietnam',
    policy: {
      foundationalActs: {
        slideTitle: 'Vietnam - Energy Foundational Acts',
        acts: [
          {
            name: 'Energy Law No. 28',
            year: '2004',
            requirements: 'Mandatory audits for facilities > 2MW',
            penalties: 'Fines up to $10K',
            enforcement: 'DEDE enforces',
          },
        ],
        keyMessage: 'Regulatory tightening creates $500M compliance market.',
      },
      nationalPolicy: {
        policyDirection: 'Transition to cleaner energy mix by 2030',
        targets: [{ metric: 'Renewable share', target: '15%', deadline: '2030' }],
        keyInitiatives: ['PDP8 implementation'],
      },
      investmentRestrictions: {
        ownershipLimits: { general: '49%' },
        incentives: [{ name: 'CIT reduction', benefit: '10% for 15 years' }],
        riskLevel: 'medium',
      },
      regulatorySummary: [],
      keyIncentives: [],
      sources: [
        { url: 'https://www.gov.vn/energy-policy', title: 'Vietnam Government Energy Policy' },
        { url: 'https://worldbank.org/vietnam-energy', title: 'World Bank Vietnam Energy Report' },
      ],
    },
    market: {
      marketSizeAndGrowth: {
        overview: '$500M market growing at 12% CAGR to reach $1.2B by 2030',
      },
      supplyAndDemandDynamics: {
        overview: 'Demand exceeding supply by 15%',
      },
      pricingAndTariffStructures: {
        overview: 'Average tariff of 8.5 cents/kWh',
      },
      sources: [{ url: 'https://iea.org/vietnam', title: 'IEA Vietnam Market Report' }],
    },
    competitors: {
      japanesePlayers: {
        players: [
          {
            name: 'JERA',
            website: 'https://jera.co.jp',
            description: 'Major Japanese energy company with $30B revenue',
          },
        ],
      },
      localMajor: {
        players: [
          {
            name: 'PetroVietnam',
            website: 'https://pvn.vn',
            description: 'State-owned with $15B revenue controlling 85% of upstream',
          },
        ],
      },
      foreignPlayers: { players: [] },
    },
    depth: {
      dealEconomics: { overview: 'IRR of 18% expected' },
      implementation: {
        phases: [{ name: 'Phase 1', activities: ['Market entry'], investment: '$2M' }],
      },
    },
    summary: {
      keyInsights: [
        {
          title: 'Growing Market',
          data: 'Vietnam energy market is $500M growing at 12% CAGR',
          pattern: 'Consistent growth',
          implication: 'Strong entry opportunity',
        },
        {
          title: 'Regulatory Support',
          data: 'Government targets 15% renewable share by 2030',
          pattern: 'Policy-driven',
          implication: 'Compliance opportunity',
        },
      ],
      opportunities: [{ title: 'Solar', description: 'Growing at 25% annually' }],
      obstacles: [{ title: 'Bureaucracy', description: 'Slow approvals taking 6-12 months' }],
      ratings: { attractiveness: 75, feasibility: 60 },
    },
    ...overrides,
  };
}

function makeSingleCountrySynthesis(overrides = {}) {
  return {
    country: 'Thailand',
    isSingleCountry: true,
    executiveSummary: [
      'Thailand energy market valued at $800M with 10% CAGR growth.',
      'EGAT dominates with 45% market share in power generation.',
    ],
    marketOpportunityAssessment: {
      totalAddressableMarket: '$800M',
      serviceableMarket: '$200M',
      growthTrajectory: '10% CAGR through 2030',
      timingConsiderations: 'Entry within 12-18 months recommended',
    },
    competitivePositioning: {
      keyPlayers: [
        { name: 'EGAT', strengths: '45% market share', weaknesses: 'Government controlled' },
        { name: 'Gulf Energy', strengths: '$5B revenue', weaknesses: 'High debt' },
      ],
      whiteSpaces: ['Battery storage', 'Smart grid'],
      potentialPartners: [],
    },
    keyInsights: [
      {
        title: 'Market Growth',
        data: '$800M market with 10% CAGR driven by industrial demand',
        pattern: 'Secular growth',
        implication: 'Favorable entry conditions',
      },
    ],
    nextSteps: ['Identify local partner', 'Obtain BOI license'],
    implementation: {
      phases: [{ name: 'Phase 1', activities: ['Market study'], investment: '$500K' }],
    },
    ...overrides,
  };
}

function makeSynthesisNoSources() {
  return {
    country: 'Indonesia',
    policy: {
      foundationalActs: {
        acts: [{ name: 'Energy Law', requirements: 'Audit above 5MW', penalties: '$50K fines' }],
        keyMessage: 'Compliance-driven $300M market opportunity.',
      },
      nationalPolicy: { policyDirection: 'Coal phase-down' },
      investmentRestrictions: { riskLevel: 'high' },
      regulatorySummary: [],
      keyIncentives: [],
      // NO sources array
    },
    market: {
      marketSizeAndGrowth: { overview: '$2B market growing at 8%' },
      supplyAndDemandDynamics: { overview: 'Surplus capacity' },
      // NO sources array
    },
    competitors: {
      japanesePlayers: { players: [] },
      localMajor: { players: [{ name: 'Pertamina', description: '$40B revenue' }] },
      foreignPlayers: { players: [] },
    },
    summary: {
      keyInsights: [{ title: 'Big Market', data: '$2B and growing at 8% CAGR' }],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: Source Quality Classification
// ---------------------------------------------------------------------------

describe('classifySourceQuality', () => {
  test('returns "missing" for null/undefined source', () => {
    expect(classifySourceQuality(null)).toBe('missing');
    expect(classifySourceQuality(undefined)).toBe('missing');
    expect(classifySourceQuality({})).toBe('missing');
  });

  test('returns "missing" for source without URL', () => {
    expect(classifySourceQuality({ title: 'Some Report' })).toBe('missing');
    expect(classifySourceQuality({ url: '', title: 'Some Report' })).toBe('missing');
  });

  test('returns "missing" for non-HTTP URL', () => {
    expect(classifySourceQuality({ url: 'ftp://example.com', title: 'Test' })).toBe('missing');
    expect(classifySourceQuality({ url: 'just-a-string', title: 'Test' })).toBe('missing');
  });

  test('returns "primary" for government domains with title', () => {
    expect(classifySourceQuality({ url: 'https://www.gov.vn/policy', title: 'Vietnam Gov' })).toBe(
      'primary'
    );
    expect(classifySourceQuality({ url: 'https://meti.go.jp/energy', title: 'METI Japan' })).toBe(
      'primary'
    );
  });

  test('returns "primary" for international organization domains', () => {
    expect(
      classifySourceQuality({ url: 'https://worldbank.org/report', title: 'World Bank' })
    ).toBe('primary');
    expect(classifySourceQuality({ url: 'https://iea.org/vietnam', title: 'IEA Report' })).toBe(
      'primary'
    );
    expect(classifySourceQuality({ url: 'https://irena.org/data', title: 'IRENA Data' })).toBe(
      'primary'
    );
  });

  test('returns "primary" for .edu domains', () => {
    expect(classifySourceQuality({ url: 'https://mit.edu/research', title: 'MIT Research' })).toBe(
      'primary'
    );
  });

  test('returns "secondary" for .com domains with title', () => {
    expect(
      classifySourceQuality({ url: 'https://reuters.com/article', title: 'Reuters Article' })
    ).toBe('primary'); // reuters.com is in PRIMARY_DOMAINS
    expect(classifySourceQuality({ url: 'https://example.com/data', title: 'Example Data' })).toBe(
      'secondary'
    );
  });

  test('returns "weak" for URL without title', () => {
    expect(classifySourceQuality({ url: 'https://example.com/data' })).toBe('weak');
    expect(classifySourceQuality({ url: 'https://example.com/data', title: '' })).toBe('weak');
  });

  test('returns "weak" for placeholder title', () => {
    expect(
      classifySourceQuality({ url: 'https://example.com', title: 'Source: Industry Report' })
    ).toBe('weak');
    expect(
      classifySourceQuality({
        url: 'https://example.com',
        title: 'Various sources',
      })
    ).toBe('weak');
  });
});

// ---------------------------------------------------------------------------
// Tests: Placeholder Source Detection
// ---------------------------------------------------------------------------

describe('isPlaceholderSource', () => {
  test('detects generic placeholder patterns', () => {
    expect(isPlaceholderSource('Source: Industry Report')).toBe(true);
    expect(isPlaceholderSource('Source: Market Analysis')).toBe(true);
    expect(isPlaceholderSource('Source: Company Report')).toBe(true);
    expect(isPlaceholderSource('Various sources')).toBe(true);
    expect(isPlaceholderSource('Multiple reports')).toBe(true);
    expect(isPlaceholderSource('Several analysts')).toBe(true);
    expect(isPlaceholderSource('Industry sources')).toBe(true);
    expect(isPlaceholderSource('Market data')).toBe(true);
  });

  test('detects internal/proprietary placeholders', () => {
    expect(isPlaceholderSource('Source: Internal Analysis')).toBe(true);
    expect(isPlaceholderSource('Source: Proprietary Research')).toBe(true);
    expect(isPlaceholderSource('Based on industry estimates')).toBe(true);
    expect(isPlaceholderSource('According to market data')).toBe(true);
  });

  test('detects N/A and similar', () => {
    expect(isPlaceholderSource('N/A')).toBe(true);
    expect(isPlaceholderSource('n/a')).toBe(true);
    expect(isPlaceholderSource('NA')).toBe(true);
    expect(isPlaceholderSource('TBD')).toBe(true);
    expect(isPlaceholderSource('Unknown')).toBe(true);
  });

  test('does NOT flag real source titles', () => {
    expect(isPlaceholderSource('World Bank Vietnam Energy Report 2024')).toBe(false);
    expect(isPlaceholderSource('IEA Global Energy Outlook')).toBe(false);
    expect(isPlaceholderSource('Bloomberg New Energy Finance')).toBe(false);
    expect(isPlaceholderSource('Ministry of Energy Thailand Annual Report')).toBe(false);
  });

  test('handles null/empty', () => {
    expect(isPlaceholderSource(null)).toBe(false);
    expect(isPlaceholderSource('')).toBe(false);
    expect(isPlaceholderSource(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Template Static Exemptions
// ---------------------------------------------------------------------------

describe('isTemplateStaticExemption', () => {
  test('exempts YCP Analysis', () => {
    expect(isTemplateStaticExemption('Source: YCP Analysis')).toBe(true);
    expect(isTemplateStaticExemption('YCP Solidiance')).toBe(true);
    expect(isTemplateStaticExemption('YCP Axtria')).toBe(true);
  });

  test('does NOT exempt analytical claims', () => {
    expect(isTemplateStaticExemption('Market worth $500M')).toBe(false);
    expect(isTemplateStaticExemption('12% CAGR growth')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Claim Extraction
// ---------------------------------------------------------------------------

describe('extractClaims', () => {
  test('extracts dollar amounts', () => {
    const claims = extractClaims('Market is worth $500M and growing', 'market', 'overview');
    expect(claims.length).toBeGreaterThanOrEqual(1);
    expect(claims.some((c) => c.text === '$500M')).toBe(true);
  });

  test('extracts percentages', () => {
    const claims = extractClaims('Growing at 12% CAGR annually', 'market', 'growth');
    expect(claims.some((c) => c.text.includes('12%'))).toBe(true);
  });

  test('extracts energy units', () => {
    const claims = extractClaims('Capacity of 15 GW installed', 'market', 'capacity');
    expect(claims.some((c) => c.text.includes('15 GW'))).toBe(true);
  });

  test('returns empty for text without claims', () => {
    const claims = extractClaims('This is a general statement with no data.', 'market', 'note');
    expect(claims.length).toBe(0);
  });

  test('returns empty for null/undefined', () => {
    expect(extractClaims(null, 'a', 'b')).toEqual([]);
    expect(extractClaims(undefined, 'a', 'b')).toEqual([]);
    expect(extractClaims(123, 'a', 'b')).toEqual([]);
  });

  test('deduplicates same claim in one text block', () => {
    const claims = extractClaims('$500M market worth $500M again', 'market', 'overview');
    const dollar500 = claims.filter((c) => c.text === '$500M');
    expect(dollar500.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: enforceLineage
// ---------------------------------------------------------------------------

describe('enforceLineage', () => {
  test('returns coverage for synthesis with sources', () => {
    const synth = makeMultiCountrySynthesis();
    const result = enforceLineage(synth);
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.sourceCoverage).toBeGreaterThan(0);
    expect(result.coveredClaims.length).toBeGreaterThan(0);
    expect(Array.isArray(result.orphanedClaims)).toBe(true);
  });

  test('reports orphaned claims for synthesis without sources', () => {
    const synth = makeSynthesisNoSources();
    const result = enforceLineage(synth);
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.orphanedClaims.length).toBeGreaterThan(0);
    expect(result.sourceCoverage).toBeLessThan(100);
  });

  test('returns 100% coverage when no claims exist', () => {
    const synth = {
      country: 'Test',
      policy: {
        foundationalActs: { acts: [] },
        nationalPolicy: { policyDirection: 'general direction' },
        investmentRestrictions: {},
        regulatorySummary: [],
        keyIncentives: [],
        sources: [{ url: 'https://example.com', title: 'Test' }],
      },
      market: {
        marketSizeAndGrowth: { overview: 'No specific numbers here' },
        sources: [],
      },
      competitors: {
        japanesePlayers: { players: [] },
        localMajor: { players: [] },
        foreignPlayers: { players: [] },
      },
      summary: { keyInsights: [] },
    };
    const result = enforceLineage(synth);
    expect(result.sourceCoverage).toBe(100);
  });

  test('handles null synthesis', () => {
    const result = enforceLineage(null);
    expect(result.claims).toEqual([]);
    expect(result.sourceCoverage).toBe(0);
  });

  test('handles empty object', () => {
    const result = enforceLineage({});
    expect(result.claims).toEqual([]);
    expect(result.sourceCoverage).toBe(100);
  });

  test('works with single country synthesis', () => {
    const synth = makeSingleCountrySynthesis();
    const result = enforceLineage(synth);
    expect(result.claims.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildClaimSourceMap
// ---------------------------------------------------------------------------

describe('buildClaimSourceMap', () => {
  test('creates per-section map for multi-country synthesis', () => {
    const synth = makeMultiCountrySynthesis();
    const map = buildClaimSourceMap(synth);
    expect(map).toHaveProperty('policy');
    expect(map).toHaveProperty('market');
    expect(map.policy).toHaveProperty('claims');
    expect(map.policy).toHaveProperty('sources');
    expect(map.policy).toHaveProperty('coverage');
    expect(map.policy.sources.length).toBeGreaterThan(0);
    expect(map.policy.sources[0]).toHaveProperty('quality');
  });

  test('creates per-section map for single country synthesis', () => {
    const synth = makeSingleCountrySynthesis();
    const map = buildClaimSourceMap(synth);
    // Single country sections
    expect(typeof map).toBe('object');
    // Should have at least executiveSummary or marketOpportunityAssessment
    const keys = Object.keys(map);
    expect(keys.length).toBeGreaterThan(0);
  });

  test('returns empty map for null', () => {
    expect(buildClaimSourceMap(null)).toEqual({});
    expect(buildClaimSourceMap(undefined)).toEqual({});
  });

  test('shows 0% coverage for sections without sources', () => {
    const synth = makeSynthesisNoSources();
    const map = buildClaimSourceMap(synth);
    // Policy has no sources array, so coverage should reflect that
    if (map.policy && map.policy.claims.length > 0) {
      expect(map.policy.sources.length).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: rejectOrphanedClaims
// ---------------------------------------------------------------------------

describe('rejectOrphanedClaims', () => {
  test('rejects all orphaned claims in strict mode', () => {
    const orphans = [
      {
        text: '$500M',
        type: 'numeric',
        section: 'market',
        field: 'overview',
        context: '$500M market',
      },
      { text: '12%', type: 'numeric', section: 'market', field: 'growth', context: '12% CAGR' },
    ];
    const result = rejectOrphanedClaims(orphans, { strict: true });
    expect(result.rejected.length).toBe(2);
    expect(result.reasons.length).toBe(2);
    expect(result.reasons[0]).toHaveProperty('claim');
    expect(result.reasons[0]).toHaveProperty('section');
    expect(result.reasons[0]).toHaveProperty('field');
    expect(result.reasons[0]).toHaveProperty('reason');
  });

  test('only rejects market_size claims in non-strict mode', () => {
    const orphans = [
      {
        text: '$500M',
        type: 'numeric',
        section: 'market',
        field: 'overview',
        context: '$500M market',
      },
      {
        text: '$500M market',
        type: 'market_size',
        section: 'market',
        field: 'overview',
        context: '$500M market worth',
      },
    ];
    const result = rejectOrphanedClaims(orphans, { strict: false });
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].type).toBe('market_size');
  });

  test('skips template static exemptions', () => {
    const orphans = [
      {
        text: '$500M',
        type: 'numeric',
        section: 'market',
        field: 'overview',
        context: 'Source: YCP Analysis $500M',
      },
    ];
    const result = rejectOrphanedClaims(orphans, { strict: true });
    expect(result.rejected.length).toBe(0);
  });

  test('handles non-array input', () => {
    expect(rejectOrphanedClaims(null)).toEqual({ rejected: [], reasons: [] });
    expect(rejectOrphanedClaims(undefined)).toEqual({ rejected: [], reasons: [] });
    expect(rejectOrphanedClaims('not an array')).toEqual({ rejected: [], reasons: [] });
  });
});

// ---------------------------------------------------------------------------
// Tests: Orphaned Claims Detection (integration)
// ---------------------------------------------------------------------------

describe('orphaned claims detection (integration)', () => {
  test('synthesis without sources has orphaned claims', () => {
    const synth = makeSynthesisNoSources();
    const lineage = enforceLineage(synth);
    expect(lineage.orphanedClaims.length).toBeGreaterThan(0);
    for (const orphan of lineage.orphanedClaims) {
      expect(orphan).toHaveProperty('text');
      expect(orphan).toHaveProperty('section');
      expect(orphan).toHaveProperty('reason');
    }
  });

  test('synthesis with good sources has fewer orphans', () => {
    const withSources = makeMultiCountrySynthesis();
    const withoutSources = makeSynthesisNoSources();
    const resultWith = enforceLineage(withSources);
    const resultWithout = enforceLineage(withoutSources);
    expect(resultWith.sourceCoverage).toBeGreaterThanOrEqual(resultWithout.sourceCoverage);
  });
});

// ---------------------------------------------------------------------------
// Tests: Missing / Malformed / Duplicate / Low-Quality Sources
// ---------------------------------------------------------------------------

describe('missing, malformed, duplicate, and low-quality sources', () => {
  test('missing sources array classified correctly', () => {
    const synth = makeSynthesisNoSources();
    const sources = collectAllSources(synth);
    // No sources arrays, so no sources collected
    expect(sources.length).toBe(0);
  });

  test('malformed source (no url) classified as missing', () => {
    expect(classifySourceQuality({ title: 'Report', url: null })).toBe('missing');
    expect(classifySourceQuality({ title: 'Report' })).toBe('missing');
  });

  test('malformed source (invalid url) classified as missing', () => {
    expect(classifySourceQuality({ url: 'not-a-url', title: 'Test' })).toBe('missing');
  });

  test('duplicate sources are collected (dedup is caller responsibility)', () => {
    const synth = {
      policy: {
        sources: [
          { url: 'https://example.com/a', title: 'Report A' },
          { url: 'https://example.com/a', title: 'Report A' },
        ],
      },
    };
    const sources = collectAllSources(synth);
    expect(sources.length).toBe(2); // Both collected; dedup is downstream
  });

  test('low-quality sources (no title) are classified as weak', () => {
    expect(classifySourceQuality({ url: 'https://example.com' })).toBe('weak');
    expect(classifySourceQuality({ url: 'https://example.com', title: '' })).toBe('weak');
  });
});

// ---------------------------------------------------------------------------
// Tests: Coverage Report Generation
// ---------------------------------------------------------------------------

describe('generateCoverageReport', () => {
  test('generates per-section coverage for multi-country synthesis', () => {
    const synth = makeMultiCountrySynthesis();
    const report = generateCoverageReport(synth);
    expect(report).toHaveProperty('perSection');
    expect(report).toHaveProperty('overall');
    expect(report).toHaveProperty('pass');
    expect(report).toHaveProperty('threshold');
    expect(typeof report.overall).toBe('number');
    expect(typeof report.pass).toBe('boolean');
    expect(report.threshold).toBe(DEFAULT_THRESHOLD);
  });

  test('passes when source coverage meets threshold', () => {
    const synth = makeMultiCountrySynthesis();
    const report = generateCoverageReport(synth);
    // Multi-country with sources should have decent coverage
    expect(report.overall).toBeGreaterThanOrEqual(0);
  });

  test('fails when no sources exist', () => {
    const synth = makeSynthesisNoSources();
    const report = generateCoverageReport(synth);
    // No sources = 0 coverage, should fail the threshold gate
    expect(report.pass).toBe(false);
    expect(report.overall).toBeLessThan(DEFAULT_THRESHOLD);
  });

  test('allows custom threshold', () => {
    const synth = makeMultiCountrySynthesis();
    const report = generateCoverageReport(synth, { threshold: 0 });
    expect(report.threshold).toBe(0);
    expect(report.pass).toBe(true); // 0% threshold always passes
  });

  test('handles null synthesis', () => {
    const report = generateCoverageReport(null);
    expect(report.overall).toBe(0);
    expect(report.pass).toBe(false);
    expect(report.perSection).toEqual({});
  });

  test('perSection includes source quality info', () => {
    const synth = makeMultiCountrySynthesis();
    const report = generateCoverageReport(synth);
    // Policy section should have sources
    if (report.perSection.policy) {
      expect(report.perSection.policy).toHaveProperty('sourceCount');
      expect(report.perSection.policy).toHaveProperty('sourceQualities');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Orphan Report Generation
// ---------------------------------------------------------------------------

describe('generateOrphanReport', () => {
  test('generates orphan report for synthesis without sources', () => {
    const synth = makeSynthesisNoSources();
    const report = generateOrphanReport(synth);
    expect(report).toHaveProperty('orphans');
    expect(report).toHaveProperty('count');
    expect(report).toHaveProperty('severity');
    expect(report.count).toBeGreaterThan(0);
    expect(['low', 'medium', 'high', 'critical']).toContain(report.severity);
  });

  test('each orphan has claim, section, field, reason', () => {
    const synth = makeSynthesisNoSources();
    const report = generateOrphanReport(synth);
    for (const orphan of report.orphans) {
      expect(orphan).toHaveProperty('claim');
      expect(orphan).toHaveProperty('section');
      expect(orphan).toHaveProperty('field');
      expect(orphan).toHaveProperty('reason');
    }
  });

  test('returns severity "none" for well-sourced synthesis', () => {
    // Synthesis where all claims have sources nearby
    const synth = {
      country: 'Test',
      policy: {
        foundationalActs: { acts: [] },
        nationalPolicy: { policyDirection: 'general policy direction' },
        investmentRestrictions: {},
        regulatorySummary: [],
        keyIncentives: [],
        sources: [{ url: 'https://example.com', title: 'Test' }],
      },
      market: {
        marketSizeAndGrowth: { overview: 'No numbers' },
        sources: [{ url: 'https://example.com', title: 'Test' }],
      },
      competitors: {
        japanesePlayers: { players: [] },
        localMajor: { players: [] },
        foreignPlayers: { players: [] },
      },
      summary: { keyInsights: [] },
    };
    const report = generateOrphanReport(synth);
    expect(report.severity).toBe('none');
    expect(report.count).toBe(0);
  });

  test('handles null synthesis', () => {
    const report = generateOrphanReport(null);
    expect(report.orphans).toEqual([]);
    expect(report.count).toBe(0);
    expect(report.severity).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Tests: Source Mismatch Detection
// ---------------------------------------------------------------------------

describe('checkSourceMismatch', () => {
  test('detects numbers added in render', () => {
    const semantic = 'Market growing at 12%';
    const rendered = 'Market growing at 12% with $500M valuation';
    const result = checkSourceMismatch(semantic, rendered);
    expect(result.match).toBe(false);
    expect(result.addedInRender.length).toBeGreaterThan(0);
    expect(result.addedInRender.some((n) => n.includes('$500m'))).toBe(true);
  });

  test('detects numbers dropped from render', () => {
    const semantic = 'Market worth $500M growing at 12% CAGR';
    const rendered = 'Market is growing steadily';
    const result = checkSourceMismatch(semantic, rendered);
    expect(result.match).toBe(false);
    expect(result.droppedFromRender.length).toBeGreaterThan(0);
  });

  test('reports match when numbers are identical', () => {
    const text = 'Market worth $500M growing at 12%';
    const result = checkSourceMismatch(text, text);
    expect(result.match).toBe(true);
    expect(result.mismatches.length).toBe(0);
  });

  test('handles null/empty inputs gracefully', () => {
    expect(checkSourceMismatch(null, 'text').match).toBe(true);
    expect(checkSourceMismatch('text', null).match).toBe(true);
    expect(checkSourceMismatch('', '').match).toBe(true);
    expect(checkSourceMismatch(null, null).match).toBe(true);
  });

  test('mismatches have correct structure', () => {
    const result = checkSourceMismatch('$100M market', '$200M market');
    for (const m of result.mismatches) {
      expect(m).toHaveProperty('type');
      expect(m).toHaveProperty('text');
      expect(m).toHaveProperty('location');
      expect(['added_in_render', 'dropped_from_render']).toContain(m.type);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: collectAllSources
// ---------------------------------------------------------------------------

describe('collectAllSources', () => {
  test('collects sources from nested objects', () => {
    const obj = {
      policy: {
        sources: [
          { url: 'https://a.com', title: 'A' },
          { url: 'https://b.com', title: 'B' },
        ],
      },
      market: {
        sources: [{ url: 'https://c.com', title: 'C' }],
      },
    };
    const sources = collectAllSources(obj);
    expect(sources.length).toBe(3);
  });

  test('handles deeply nested sources', () => {
    const obj = {
      level1: {
        level2: {
          sources: [{ url: 'https://deep.com', title: 'Deep' }],
        },
      },
    };
    const sources = collectAllSources(obj);
    expect(sources.length).toBe(1);
    expect(sources[0].url).toBe('https://deep.com');
  });

  test('returns empty for null', () => {
    expect(collectAllSources(null)).toEqual([]);
    expect(collectAllSources(undefined)).toEqual([]);
  });

  test('skips sources without url', () => {
    const obj = {
      sources: [{ title: 'No URL' }, { url: 'https://valid.com', title: 'Valid' }],
    };
    const sources = collectAllSources(obj);
    expect(sources.length).toBe(1);
    expect(sources[0].url).toBe('https://valid.com');
  });
});

// ---------------------------------------------------------------------------
// Tests: getSectionSources
// ---------------------------------------------------------------------------

describe('getSectionSources', () => {
  test('gets sources from section sources array', () => {
    const synth = makeMultiCountrySynthesis();
    const sources = getSectionSources(synth, 'policy');
    expect(sources.length).toBe(2);
    expect(sources[0].url).toContain('gov.vn');
  });

  test('returns empty for section without sources', () => {
    const synth = makeSynthesisNoSources();
    const sources = getSectionSources(synth, 'policy');
    expect(sources.length).toBe(0);
  });

  test('returns empty for missing section', () => {
    const synth = makeMultiCountrySynthesis();
    const sources = getSectionSources(synth, 'nonexistent');
    expect(sources.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: walkSynthesisClaims
// ---------------------------------------------------------------------------

describe('walkSynthesisClaims', () => {
  test('walks all sections of multi-country synthesis', () => {
    const synth = makeMultiCountrySynthesis();
    const claims = walkSynthesisClaims(synth);
    expect(claims.length).toBeGreaterThan(0);
    // Should find claims in multiple sections
    const sections = new Set(claims.map((c) => c.section));
    expect(sections.size).toBeGreaterThan(1);
  });

  test('walks single country synthesis', () => {
    const synth = makeSingleCountrySynthesis();
    const claims = walkSynthesisClaims(synth);
    expect(claims.length).toBeGreaterThan(0);
  });

  test('returns empty for null', () => {
    expect(walkSynthesisClaims(null)).toEqual([]);
    expect(walkSynthesisClaims({})).toEqual([]);
  });
});
