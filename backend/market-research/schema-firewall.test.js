'use strict';

const {
  validate,
  coerce,
  quarantine,
  getTrustScore,
  getActionLedger,
  enforceSourceLineage,
  processFirewall,
  createActionLedger,
  createQuarantine,
  SECTION_SCHEMAS,
  SINGLE_COUNTRY_SCHEMAS,
  LEGACY_KEY_MAP,
  ROOT_META_KEYS,
} = require('./schema-firewall');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeValidMultiCountrySynthesis() {
  return {
    country: 'Vietnam',
    policy: {
      foundationalActs: {
        slideTitle: 'Vietnam - Energy Foundational Acts',
        subtitle: 'Key regulatory framework',
        acts: [
          { name: 'Energy Law No. 28', year: '2004', requirements: 'Mandatory audits for facilities > 2MW', penalties: 'Fines up to $10K', enforcement: 'DEDE enforces with 23 auditors' },
          { name: 'Petroleum Law 2022', year: '2022', requirements: 'Updated exploration licensing', penalties: 'License revocation', enforcement: 'Ministry oversight' },
        ],
        keyMessage: 'Regulatory tightening creates compliance-driven demand.',
      },
      nationalPolicy: {
        slideTitle: 'Vietnam - National Energy Policy',
        policyDirection: 'Transition to cleaner energy mix',
        targets: [{ metric: 'Renewable share', target: '15%', deadline: '2030', status: 'On track' }],
        keyInitiatives: ['PDP8 implementation'],
      },
      investmentRestrictions: {
        slideTitle: 'Vietnam - Foreign Investment Rules',
        ownershipLimits: { general: '49%', promoted: '100%', exceptions: 'BOT schemes' },
        incentives: [{ name: 'CIT reduction', benefit: '10% for 15 years', eligibility: 'Energy projects' }],
        riskLevel: 'medium',
        riskJustification: 'Bureaucratic delays common',
      },
      regulatorySummary: [{ domain: 'Electricity', currentState: 'Regulated', transition: 'Liberalizing', futureState: 'Competitive market' }],
      keyIncentives: [{ initiative: 'FiT program', keyContent: 'Feed-in tariffs for solar', highlights: '9.35 cents/kWh', implications: 'Attracts foreign investors' }],
      sources: [{ url: 'https://example.com/policy', title: 'Policy Source' }],
    },
    market: {
      marketSizeAndGrowth: { subtitle: 'Growing market', overview: '$500M market growing at 12% CAGR', chartData: { series: [100, 200, 300, 400, 500] } },
      supplyAndDemandDynamics: { subtitle: 'Supply constrained', overview: 'Demand exceeding supply by 15%' },
      pricingAndTariffStructures: { subtitle: 'Tariff reform', overview: 'Progressive tariff structure' },
      sources: [{ url: 'https://example.com/market', title: 'Market Source' }],
    },
    competitors: {
      japanesePlayers: {
        slideTitle: 'Vietnam - Japanese Companies',
        subtitle: 'Strong presence',
        players: [
          { name: 'JERA', website: 'https://jera.co.jp', description: 'Major Japanese energy company with $30B revenue and 15% market share in Vietnamese LNG imports since 2019.' },
          { name: 'Mitsui', website: 'https://mitsui.com', description: 'Trading giant with energy portfolio worth $5B in Southeast Asia operations.' },
          { name: 'TEPCO', website: 'https://tepco.co.jp', description: 'Largest Japanese utility expanding into Vietnam via JV partnerships since 2020.' },
        ],
        marketInsight: 'Japanese firms dominate LNG segment',
        dataType: 'company_comparison',
      },
      localMajor: {
        slideTitle: 'Vietnam - Local Players',
        subtitle: 'State-dominated',
        players: [
          { name: 'PetroVietnam', website: 'https://pvn.vn', description: 'State-owned oil and gas monopoly with $15B revenue controlling 85% of upstream production and all refining capacity.' },
          { name: 'EVN', website: 'https://evn.com.vn', description: 'National electricity utility managing 95% of grid capacity with plans to invest $10B by 2025.' },
          { name: 'PV Gas', website: 'https://pvgas.com.vn', description: 'Gas distribution subsidiary with $3B revenue and 70% market share in domestic gas transport.' },
        ],
        concentration: 'High SOE concentration',
        dataType: 'company_comparison',
      },
      foreignPlayers: {
        slideTitle: 'Vietnam - Foreign Companies',
        subtitle: 'Growing presence',
        players: [
          { name: 'ExxonMobil', website: 'https://exxonmobil.com', description: 'US major with Blue Whale gas project worth $10B, entered Vietnam in 2009 via exploration licenses.' },
          { name: 'TotalEnergies', website: 'https://totalenergies.com', description: 'French supermajor with $2B invested across offshore blocks and renewable energy projects since 2015.' },
          { name: 'Shell', website: 'https://shell.com', description: 'Dutch-British major focused on LNG trading and downstream retail operations in Vietnam since 2010.' },
        ],
        competitiveInsight: 'Western majors focus on upstream',
        dataType: 'company_comparison',
      },
    },
    depth: {
      dealEconomics: { slideTitle: 'Vietnam - Deal Economics', typicalDealSize: { min: '$5M', max: '$50M', average: '$20M' } },
      partnerAssessment: { slideTitle: 'Vietnam - Partner Assessment', partners: [{ name: 'PVN', type: 'SOE', partnershipFit: 4 }] },
      entryStrategy: { slideTitle: 'Vietnam - Entry Strategy', options: [{ mode: 'JV', timeline: '12 months', investment: '$10M' }] },
      implementation: {
        slideTitle: 'Vietnam - Roadmap',
        subtitle: 'Phased approach',
        phases: [
          { name: 'Phase 1: Setup', activities: ['Legal setup', 'Partner selection'], milestones: ['Entity registered'], investment: '$2M' },
          { name: 'Phase 2: Launch', activities: ['First contracts', 'Team build'], milestones: ['Revenue start'], investment: '$5M' },
          { name: 'Phase 3: Scale', activities: ['Expand', 'New segments'], milestones: ['Break-even'], investment: '$3M' },
        ],
        totalInvestment: '$10M',
        breakeven: 'Month 18',
      },
      targetSegments: { segments: [{ name: 'Industrial', size: '500 factories' }] },
    },
    summary: {
      timingIntelligence: { triggers: [{ trigger: 'PDP8 execution', impact: 'Procurement wave', action: 'Enter before Q3 2026' }] },
      lessonsLearned: { failures: [{ company: 'ENGIE', year: '2018', reason: 'Wrong partner', lesson: 'Choose SOE partner' }] },
      opportunities: [{ opportunity: 'ESCO market', size: '$90M', timing: '2026', action: 'Enter via JV' }],
      obstacles: [{ obstacle: 'Bureaucracy', severity: 'High', mitigation: 'Local partner' }],
      ratings: { attractiveness: 7, attractivenessRationale: 'Large growing market', feasibility: 6, feasibilityRationale: 'Complex regulations' },
      keyInsights: [
        { title: 'Gas supply crunch creates ESCO demand', data: 'Erawan output fell 30% in 2024', pattern: 'Structural supply gap', implication: 'Should position as cost management solution', timing: 'Q1 2026' },
        { title: 'Labor costs drive energy efficiency', data: 'Wages rose 8% annually 2021-2024', pattern: 'Aging workforce inflation', implication: 'Target CFOs with ROI messaging', timing: 'Q2 2026' },
      ],
      recommendation: 'Enter via JV with PVN subsidiary',
      goNoGo: { criteria: [{ criterion: 'Market size', met: true, evidence: '$500M TAM' }], overallVerdict: 'GO' },
    },
  };
}

function makeValidSingleCountrySynthesis() {
  return {
    isSingleCountry: true,
    country: 'Thailand',
    qualityScore: 75,
    reviewIterations: 2,
    executiveSummary: [
      'Thailand energy services market reached $320M in 2024 growing at 14% CAGR. (Refer: Chapter 2)',
      'Regulatory reforms under Energy Conservation Act 2022 mandate audits for large facilities. (Refer: Chapter 1)',
      'Market demand driven by aging infrastructure and rising labor costs. (Refer: Chapter 2)',
      'Recommended entry via JV with B.Grimm targeting industrial zones. (Refer: Chapter 3)',
    ],
    marketOpportunityAssessment: {
      totalAddressableMarket: '1200 factories x $500K avg spend x 15% savings = $90M TAM',
      serviceableMarket: '$45M with 50% penetration in 3 years',
      growthTrajectory: '14% CAGR driven by mandatory ISO 50001 compliance by 2026',
      timingConsiderations: 'PDP8 execution milestones accelerate procurement in 2026',
    },
    competitivePositioning: {
      keyPlayers: [
        { name: 'ENGIE', website: 'https://engie.com', strengths: 'Global brand', weaknesses: 'Limited regional presence', threat: 'Could block JV partners', description: 'French energy services major with $2B APAC revenue and 12% market share in Thai industrial ESCO contracts since 2018 JV with B.Grimm.' },
        { name: 'Schneider Electric', website: 'https://schneider-electric.com', strengths: 'Tech platform', weaknesses: 'Premium pricing', threat: 'Technology lock-in', description: 'Global EMS leader with $35B revenue entering Thai ESCO market via digital solutions targeting manufacturing sector since 2020.' },
        { name: 'Daikin', website: 'https://daikin.com', strengths: 'HVAC dominance', weaknesses: 'Narrow scope', threat: 'Could expand services', description: 'Japanese HVAC leader with 40% Thai market share generating $800M regional revenue through direct and dealer channels since 1990.' },
      ],
      whiteSpaces: ['Provincial industrial zones underserved', 'Combined heat-power efficiency'],
      potentialPartners: [{ name: 'B.Grimm', website: 'https://bgrimm.com', rationale: 'Strong government relationships and industrial park network' }],
    },
    keyInsights: [
      { title: 'Labor cost pressure makes energy savings an HR priority', data: 'Manufacturing wages rose 8% annually 2021-2024 while productivity gained only 2%.', pattern: 'Aging workforce drives wage inflation without productivity gains.', implication: 'Position energy efficiency as cost management targeting CFOs.', timing: 'Move by Q2 2026 before budget cycles lock.' },
      { title: 'Grid congestion creates captive demand', data: 'Southern grid at 95% capacity with 15 planned additions blocked.', pattern: 'Infrastructure bottleneck forces on-site solutions.', implication: 'Should target high-load manufacturers in congested zones.', timing: 'Q1-Q2 2026 window before grid reinforcement.' },
      { title: 'Compliance wave approaching', data: 'Energy Conservation Act mandates audits for 4200 facilities by 2027.', pattern: 'Regulatory pressure creates compliance-driven demand.', implication: 'Recommend positioning as compliance enabler.', timing: 'By end 2026 to capture first-mover advantage.' },
    ],
    nextSteps: ['Identify JV partner shortlist', 'Regulatory mapping', 'Pilot project design', 'Team recruitment', 'Board approval'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Schema Firewall', () => {
  // ====== 1. Valid multi-country synthesis passes validation ======
  test('valid multi-country synthesis passes validation', () => {
    const synthesis = makeValidMultiCountrySynthesis();
    const result = validate(synthesis);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.fieldResults.policy.present).toBe(true);
    expect(result.fieldResults.market.present).toBe(true);
    expect(result.fieldResults.competitors.present).toBe(true);
    expect(result.fieldResults.summary.present).toBe(true);
  });

  // ====== 2. Valid single-country synthesis passes validation ======
  test('valid single-country synthesis passes validation', () => {
    const synthesis = makeValidSingleCountrySynthesis();
    const result = validate(synthesis);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.fieldResults.executiveSummary.present).toBe(true);
    expect(result.fieldResults.keyInsights.present).toBe(true);
  });

  // ====== 3. Missing required sections fail validation ======
  test('missing required sections produce errors', () => {
    const synthesis = { country: 'Vietnam' };
    const result = validate(synthesis);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes('policy'))).toBe(true);
    expect(result.errors.some((e) => e.message.includes('market'))).toBe(true);
  });

  // ====== 4. Coerce: string executiveSummary → array ======
  test('coerce converts string executiveSummary to array', () => {
    const synthesis = {
      isSingleCountry: true,
      executiveSummary: 'Paragraph one.\n\nParagraph two.\n\nParagraph three.',
    };
    const ledger = createActionLedger();
    const result = coerce(synthesis, ledger);
    expect(Array.isArray(result.executiveSummary)).toBe(true);
    expect(result.executiveSummary).toHaveLength(3);
    expect(ledger.getEntries().some((e) => e.action === 'coerced')).toBe(true);
  });

  // ====== 5. Coerce: legacy key renaming ======
  test('coerce renames legacy keys to canonical keys', () => {
    const synthesis = {
      competitorsAnalysis: { japanesePlayers: { players: [] } },
    };
    const ledger = createActionLedger();
    const result = coerce(synthesis, ledger);
    expect(result.competitors).toBeDefined();
    expect(result.competitorsAnalysis).toBeUndefined();
    expect(ledger.getEntries().some((e) => e.action === 'coerced' && e.path === '$.competitorsAnalysis')).toBe(true);
  });

  // ====== 6. Coerce: canonical key takes precedence over legacy ======
  test('coerce drops legacy key when canonical already exists', () => {
    const synthesis = {
      competitors: { japanesePlayers: { players: [{ name: 'JERA' }] } },
      competitorsAnalysis: { japanesePlayers: { players: [{ name: 'Old' }] } },
    };
    const ledger = createActionLedger();
    const result = coerce(synthesis, ledger);
    expect(result.competitors.japanesePlayers.players[0].name).toBe('JERA');
    expect(result.competitorsAnalysis).toBeUndefined();
    expect(ledger.getEntries().some((e) => e.action === 'dropped')).toBe(true);
  });

  // ====== 7. Coerce: bare competitor array → {players: [...]} ======
  test('coerce wraps bare competitor array in players object', () => {
    const synthesis = {
      competitors: {
        japanesePlayers: [{ name: 'JERA' }, { name: 'Mitsui' }],
        localMajor: { players: [{ name: 'PVN' }] },
      },
    };
    const ledger = createActionLedger();
    const result = coerce(synthesis, ledger);
    expect(result.competitors.japanesePlayers.players).toHaveLength(2);
    expect(result.competitors.japanesePlayers.players[0].name).toBe('JERA');
    expect(ledger.getEntries().some((e) => e.details?.includes('Wrapped bare array'))).toBe(true);
  });

  // ====== 8. Coerce: filter instruction strings from keyInsights ======
  test('coerce filters instruction strings from keyInsights', () => {
    const synthesis = {
      isSingleCountry: true,
      keyInsights: [
        { title: 'Real insight', data: 'With data 50%' },
        'Provide 3-5 insights. Each must reveal something.',
        'COMPLETE CHAIN REQUIRED: data → pattern → implication',
        { title: 'Another insight', data: 'More evidence 2024' },
      ],
    };
    const ledger = createActionLedger();
    const result = coerce(synthesis, ledger);
    expect(result.keyInsights).toHaveLength(2);
    expect(result.keyInsights[0].title).toBe('Real insight');
    expect(result.keyInsights[1].title).toBe('Another insight');
  });

  // ====== 9. Coerce: remap alternate insight field names ======
  test('coerce remaps headline→title and evidence→data in insights', () => {
    const synthesis = {
      isSingleCountry: true,
      keyInsights: [{ headline: 'My Headline', evidence: 'My Evidence 123' }],
    };
    const ledger = createActionLedger();
    const result = coerce(synthesis, ledger);
    expect(result.keyInsights[0].title).toBe('My Headline');
    expect(result.keyInsights[0].data).toBe('My Evidence 123');
    expect(result.keyInsights[0].headline).toBeUndefined();
    expect(result.keyInsights[0].evidence).toBeUndefined();
  });

  // ====== 10. Quarantine: unknown root-level keys ======
  test('quarantine moves unknown root-level keys to quarantine', () => {
    const synthesis = {
      country: 'Vietnam',
      policy: { foundationalActs: { acts: [] } },
      unknownSection: { data: 'something' },
      anotherWeirdKey: 'hello',
    };
    const { result, quarantined } = quarantine(synthesis);
    expect(result.unknownSection).toBeUndefined();
    expect(result.anotherWeirdKey).toBeUndefined();
    expect(quarantined.count()).toBe(2);
    const q = quarantined.getAll();
    expect(q['$.unknownSection']).toBeDefined();
    expect(q['$.anotherWeirdKey']).toBeDefined();
    expect(result._quarantine).toBeDefined();
  });

  // ====== 11. Quarantine: unknown sub-keys within sections ======
  test('quarantine moves unknown sub-keys within known sections', () => {
    const synthesis = {
      country: 'Vietnam',
      policy: {
        foundationalActs: { acts: [] },
        nationalPolicy: {},
        weirdSubKey: { data: 'should be quarantined' },
      },
    };
    const { result, quarantined } = quarantine(synthesis);
    expect(result.policy.weirdSubKey).toBeUndefined();
    expect(quarantined.count()).toBe(1);
    expect(quarantined.getAll()['$.policy.weirdSubKey']).toBeDefined();
  });

  // ====== 12. Quarantine: internal underscore keys are preserved ======
  test('quarantine preserves _internal keys', () => {
    const synthesis = {
      country: 'Vietnam',
      _synthesisError: false,
      policy: { foundationalActs: { acts: [] }, _debugInfo: 'test' },
    };
    const { result } = quarantine(synthesis);
    expect(result._synthesisError).toBe(false);
    expect(result.policy._debugInfo).toBe('test');
  });

  // ====== 13. Trust scoring: complete synthesis scores high ======
  test('trust scoring gives high score to complete synthesis', () => {
    const synthesis = makeValidMultiCountrySynthesis();
    const score = getTrustScore(synthesis);
    expect(score.overall).toBeGreaterThanOrEqual(60);
    expect(score.perField.policy.score).toBeGreaterThan(0);
    expect(score.perField.market.score).toBeGreaterThan(0);
    expect(score.perField.competitors.score).toBeGreaterThan(0);
  });

  // ====== 14. Trust scoring: empty synthesis scores zero ======
  test('trust scoring gives zero for null synthesis', () => {
    const score = getTrustScore(null);
    expect(score.overall).toBe(0);
  });

  // ====== 15. Trust scoring: partial synthesis gets intermediate score ======
  test('trust scoring handles partial synthesis', () => {
    const synthesis = {
      country: 'Vietnam',
      policy: { foundationalActs: { acts: [{ name: 'Law 1', year: '2020' }] } },
      market: null,
      competitors: null,
    };
    const score = getTrustScore(synthesis);
    expect(score.perField.policy.score).toBeGreaterThan(0);
    expect(score.perField.market.score).toBe(0);
    expect(score.perField.competitors.score).toBe(0);
    expect(score.overall).toBeGreaterThan(0);
    expect(score.overall).toBeLessThan(50);
  });

  // ====== 16. Action ledger completeness ======
  test('action ledger records entries for all keys', () => {
    const synthesis = makeValidMultiCountrySynthesis();
    const ledger = getActionLedger(synthesis);
    const entries = ledger.getEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.path === '$.policy' && e.action === 'kept')).toBe(true);
    expect(entries.some((e) => e.path === '$.market' && e.action === 'kept')).toBe(true);
    expect(entries.some((e) => e.path === '$.competitors' && e.action === 'kept')).toBe(true);
    expect(entries.some((e) => e.path === '$.summary' && e.action === 'kept')).toBe(true);
  });

  // ====== 17. Action ledger records legacy keys ======
  test('action ledger records legacy keys as coerced', () => {
    const synthesis = { competitorsAnalysis: { players: [] } };
    const ledger = getActionLedger(synthesis);
    const entries = ledger.getEntries();
    expect(entries.some((e) => e.action === 'coerced' && e.path === '$.competitorsAnalysis')).toBe(true);
  });

  // ====== 18. Source lineage: all insights have data ======
  test('source lineage passes when all insights have data', () => {
    const synthesis = makeValidSingleCountrySynthesis();
    const lineage = enforceSourceLineage(synthesis);
    expect(lineage.valid).toBe(true);
    expect(lineage.orphanedInsights).toHaveLength(0);
    expect(lineage.sourceCoverage).toBe(100);
  });

  // ====== 19. Source lineage: orphaned insights detected ======
  test('source lineage detects orphaned insights', () => {
    const synthesis = {
      isSingleCountry: true,
      keyInsights: [
        { title: 'Good insight', data: 'Has evidence 50%' },
        { title: 'Bad insight' },
        { title: 'Also bad', data: '' },
      ],
    };
    const lineage = enforceSourceLineage(synthesis);
    expect(lineage.valid).toBe(false);
    expect(lineage.orphanedInsights.length).toBeGreaterThan(0);
    expect(lineage.orphanedInsights.some((o) => o.title === 'Bad insight')).toBe(true);
  });

  // ====== 20. Mutation: type corruption (array where object expected) ======
  test('validation catches type corruption: array instead of object', () => {
    const synthesis = makeValidMultiCountrySynthesis();
    synthesis.policy = ['not', 'an', 'object'];
    const result = validate(synthesis);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('Type mismatch'))).toBe(true);
  });

  // ====== 21. Mutation: nested anomaly — acts as string instead of array ======
  test('validation catches nested type anomaly', () => {
    const synthesis = makeValidMultiCountrySynthesis();
    synthesis.policy.foundationalActs.acts = 'not an array';
    const result = validate(synthesis);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes('acts') && e.message.includes('Type mismatch'))).toBe(true);
  });

  // ====== 22. Mutation: missing required field in insight ======
  test('validation catches missing required fields in insight objects', () => {
    const synthesis = makeValidSingleCountrySynthesis();
    synthesis.keyInsights[0] = { pattern: 'No title or data' };
    const result = validate(synthesis);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('title'))).toBe(true);
  });

  // ====== 23. Full pipeline: processFirewall returns all components ======
  test('processFirewall returns complete result object', () => {
    const synthesis = makeValidMultiCountrySynthesis();
    synthesis.weirdKey = 'should be quarantined';
    const fw = processFirewall(synthesis);
    expect(fw.result).toBeDefined();
    expect(fw.preValidation).toBeDefined();
    expect(fw.postValidation).toBeDefined();
    expect(fw.trustScore).toBeDefined();
    expect(fw.lineage).toBeDefined();
    expect(fw.quarantined).toBeDefined();
    expect(fw.actionLedger).toBeDefined();
    expect(fw.quarantined['$.weirdKey']).toBeDefined();
    expect(fw.result.weirdKey).toBeUndefined();
  });

  // ====== 24. Coerce: summary.opportunities object → array ======
  test('coerce wraps single opportunity object in array', () => {
    const synthesis = {
      summary: {
        opportunities: { opportunity: 'Single', size: '$10M' },
        obstacles: { obstacle: 'Single', severity: 'High' },
      },
    };
    const result = coerce(synthesis);
    expect(Array.isArray(result.summary.opportunities)).toBe(true);
    expect(result.summary.opportunities).toHaveLength(1);
    expect(Array.isArray(result.summary.obstacles)).toBe(true);
    expect(result.summary.obstacles).toHaveLength(1);
  });

  // ====== 25. Coerce: implementation phases object → array ======
  test('coerce converts phases object to array', () => {
    const synthesis = {
      depth: {
        implementation: {
          phases: {
            setup: { name: 'Phase 1', activities: ['Legal'] },
            launch: { name: 'Phase 2', activities: ['Sales'] },
          },
        },
      },
    };
    const result = coerce(synthesis);
    expect(Array.isArray(result.depth.implementation.phases)).toBe(true);
    expect(result.depth.implementation.phases).toHaveLength(2);
  });

  // ====== 26. validate() handles null input ======
  test('validate handles null input gracefully', () => {
    const result = validate(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0].severity).toBe('critical');
  });

  // ====== 27. Legacy key map coverage ======
  test('LEGACY_KEY_MAP contains expected mappings', () => {
    expect(LEGACY_KEY_MAP.competitorsAnalysis).toBe('competitors');
    expect(LEGACY_KEY_MAP.policySynthesis).toBe('policy');
    expect(LEGACY_KEY_MAP.marketSynthesis).toBe('market');
    expect(LEGACY_KEY_MAP.executiveSummaryParagraphs).toBe('executiveSummary');
    expect(LEGACY_KEY_MAP.insights).toBe('keyInsights');
  });

  // ====== 28. Source lineage: multi-country uses summary.keyInsights ======
  test('source lineage checks summary.keyInsights for multi-country', () => {
    const synthesis = makeValidMultiCountrySynthesis();
    const lineage = enforceSourceLineage(synthesis);
    expect(lineage.valid).toBe(true);
    expect(lineage.totalInsights).toBe(2);
    expect(lineage.insightsWithData).toBe(2);
  });

  // ====== 29. Quarantine helper: count and getAll ======
  test('quarantine helper tracks fields correctly', () => {
    const q = createQuarantine();
    expect(q.count()).toBe(0);
    q.add('$.foo', 'bar', 'unknown');
    q.add('$.baz', 123, 'unknown');
    expect(q.count()).toBe(2);
    const all = q.getAll();
    expect(all['$.foo'].value).toBe('bar');
    expect(all['$.baz'].value).toBe(123);
  });

  // ====== 30. Action ledger helper ======
  test('action ledger records and exports entries', () => {
    const ledger = createActionLedger();
    ledger.record('$.field', 'kept', null);
    ledger.record('$.other', 'coerced', 'string to array');
    const entries = ledger.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].path).toBe('$.field');
    expect(entries[0].action).toBe('kept');
    expect(entries[1].details).toBe('string to array');
    // toJSON
    expect(JSON.stringify(ledger)).toContain('$.field');
  });
});
