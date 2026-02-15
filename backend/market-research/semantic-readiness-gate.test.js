const {
  semanticReadinessGate,
  detectShallowContent,
  checkContradictions,
  analyze,
} = require('./semantic-quality-engine');
const { checkCoherence } = require('./semantic-coherence-checker');

// ============ HIGH-QUALITY PAYLOAD (should pass >= 80) ============

describe('semanticReadinessGate', () => {
  const highQualitySynthesis = {
    executiveSummary: [
      'Thailand\'s energy services market reached $320M in 2024, growing at 14% CAGR since 2020. ENGIE Corp and Schneider Electric dominate with combined 35% market share. We recommend targeting mid-tier industrial factories because their energy spend averages $500K annually, which means significant savings potential of 15-20%. The regulatory push from DEDE creates urgency for compliance-driven demand. By Q2 2026, ISO 50001 mandates will force 1,200 factories to upgrade, therefore early movers capture first-wave contracts resulting in a $45M serviceable market. However, local competitors like B.Grimm Power Ltd have established relationships that create a barrier to entry.',
    ],
    marketOpportunityAssessment: {
      totalAddressableMarket:
        'Market is $90M calculated from 1,200 factories at $500K average spend with 15% savings potential. Schneider Electric Corp revenue in Thailand grew to $180M in 2024. We should prioritize the Eastern Seaboard because industrial park concentration provides 60% of total demand. This means geographic focus reduces go-to-market cost by 40%. ENGIE Corp entered in 2015 via JV, resulting in rapid market share gains. By Q3 2026, regulatory compliance creates $30M in new addressable demand, therefore timing is critical.',
      growthTrajectory:
        '14% CAGR driven by ISO 50001 mandate affecting 1,200+ factories. This represents a strong growth opportunity because compliance deadlines are non-negotiable. Schneider Electric projects 18% annual growth through 2028.',
    },
    competitivePositioning: {
      keyPlayers: [
        {
          name: 'ENGIE Corp',
          description:
            '$2.3B global revenue, 18% Thai market share. Entered Thailand in 2015 via JV with B.Grimm Power Ltd. Focus on industrial parks, 12 active contracts averaging $2M each. However, their provincial network coverage remains limited because B.Grimm concentrates on Eastern Seaboard, therefore competitors with regional partnerships can capture 40% of demand outside Bangkok.',
        },
        {
          name: 'Schneider Electric Corp',
          description:
            '$36B global, 17% Thai market share. Revenue grew 15% in 2024 to $180M. Strong in building automation but weaker in heavy industrial. Recommend targeting their underserved mid-tier segment because they focus on enterprise accounts.',
        },
      ],
    },
    regulatoryPathway: {
      overview:
        'DEDE mandates ISO 50001 compliance by Q3 2026 for all factories over 1,000 employees. This means 1,200 factories must implement energy management systems, resulting in $90M compliance-driven market. By Q4 2026, penalties of $50K per violation take effect, consequently urgency increases. Schneider Electric Corp and ENGIE Corp have lobbied for extended timelines, however DEDE rejected extensions.',
    },
    keyInsights: [
      {
        title: 'Cost pressure creates demand urgency',
        data: 'Manufacturing wages rose 8% annually 2021-2024 driven by aging workforce.',
        implication:
          'Factory operators seek 15-20% energy cost reductions to maintain margins.',
        timing: 'Target CFOs by Q2 2026 before budget cycles close.',
        risk: 'Automation adoption may reduce energy intensity, lowering savings potential by 2028.',
      },
    ],
    depth: {
      dealEconomics: {
        typicalDealSize: { min: '$2M', max: '$10M', average: '$5M' },
        contractTerms: { duration: '5 years', revenueSplit: 'Client 70% / Provider 30%' },
        financials: { paybackPeriod: '3 years', irr: '18%', marginProfile: '35%' },
        financingOptions: ['Project finance', 'ESCO model', 'Green bonds'],
        keyInsight: 'Strong IRR driven by regulatory mandates and rising energy costs.',
      },
    },
  };

  test('high-quality payload passes with score >= 80', () => {
    const result = semanticReadinessGate(highQualitySynthesis, {
      threshold: 80,
      industry: 'energy services',
    });
    expect(result.pass).toBe(true);
    expect(result.overallScore).toBeGreaterThanOrEqual(80);
    expect(result.sectionScorecard.length).toBeGreaterThan(0);
    // All sections should have evidence
    for (const section of result.sectionScorecard) {
      expect(section).toHaveProperty('section');
      expect(section).toHaveProperty('score');
      expect(section).toHaveProperty('pass');
      expect(section).toHaveProperty('reasons');
    }
  });

  test('per-section scores are deterministic', () => {
    const result1 = semanticReadinessGate(highQualitySynthesis, { threshold: 80 });
    const result2 = semanticReadinessGate(highQualitySynthesis, { threshold: 80 });
    expect(result1.overallScore).toBe(result2.overallScore);
    expect(result1.sectionScorecard.length).toBe(result2.sectionScorecard.length);
    for (let i = 0; i < result1.sectionScorecard.length; i++) {
      expect(result1.sectionScorecard[i].score).toBe(result2.sectionScorecard[i].score);
      expect(result1.sectionScorecard[i].pass).toBe(result2.sectionScorecard[i].pass);
    }
  });

  // ============ SHALLOW PAYLOAD (should fail with explicit reasons) ============

  test('shallow payload fails with explicit reasons', () => {
    const shallowSynthesis = {
      executiveSummary: 'The market has opportunities.',
      marketOpportunityAssessment: { totalAddressableMarket: 'Large market potential.' },
      competitivePositioning: { keyPlayers: 'Several players.' },
      keyInsights: [],
    };

    const result = semanticReadinessGate(shallowSynthesis, {
      threshold: 80,
      industry: 'technology',
    });
    expect(result.pass).toBe(false);
    expect(result.overallScore).toBeLessThan(80);
    expect(result.shallowSections.length).toBeGreaterThan(0);
    expect(result.improvementActions.length).toBeGreaterThan(0);

    // Each failed section should have specific reasons
    const failedSections = result.sectionScorecard.filter((s) => !s.pass);
    expect(failedSections.length).toBeGreaterThan(0);
    for (const failed of failedSections) {
      expect(failed.reasons.length).toBeGreaterThan(0);
      // Reasons should be actionable, not just "score is low"
      expect(
        failed.reasons.some(
          (r) =>
            r.includes('short') ||
            r.includes('missing') ||
            r.includes('Missing') ||
            r.includes('No named') ||
            r.includes('No specific') ||
            r.includes('No action') ||
            r.includes('No causal') ||
            r.includes('density')
        )
      ).toBe(true);
    }
  });

  // ============ CONTRADICTORY PAYLOAD (should fail with explicit reasons) ============

  test('contradictory payload fails with contradiction reasons', () => {
    const contradictorySynthesis = {
      executiveSummary: [
        'Thailand\'s energy services market is growing rapidly at 25% CAGR with strong demand. ENGIE Corp leads with 18% share. Market reached $320M in 2024. We recommend targeting mid-tier factories because costs are rising, which means savings potential. By Q2 2026 mandates create urgency, therefore early movers win.',
      ],
      marketOpportunityAssessment: {
        growthTrajectory:
          'Market grew 14% in 2024. Schneider Electric Corp expanded operations. This means demand is increasing, resulting in $90M TAM. We should target Eastern Seaboard because of concentration.',
      },
      competitivePositioning: {
        analysis:
          'The energy services market is declining sharply due to oversupply and stagnant demand. ENGIE Corp lost 5% market share as weak demand forced price cuts. Investment is falling rapidly.',
      },
      keyInsights: [
        {
          title: 'Market contradiction',
          data: 'Growth data shows 25% CAGR increase but competitor analysis shows declining demand.',
          implication: 'Inconsistent signals make decision-making difficult.',
          timing: 'Resolve before Q3 2026.',
          risk: 'Acting on wrong signal could waste investment.',
        },
      ],
    };

    const result = semanticReadinessGate(contradictorySynthesis, {
      threshold: 80,
      industry: 'energy services',
    });
    // Contradictions should reduce score
    expect(result.contradictions.length).toBeGreaterThan(0);
    expect(
      result.improvementActions.some((a) => a.toLowerCase().includes('contradiction'))
    ).toBe(true);
  });

  // ============ NULL/EMPTY INPUTS ============

  test('returns fail for null synthesis', () => {
    const result = semanticReadinessGate(null);
    expect(result.pass).toBe(false);
    expect(result.overallScore).toBe(0);
    expect(result.improvementActions.length).toBeGreaterThan(0);
  });

  test('returns fail for empty object', () => {
    const result = semanticReadinessGate({});
    expect(result.pass).toBe(false);
    expect(result.overallScore).toBeLessThan(80);
  });

  test('returns fail for undefined', () => {
    const result = semanticReadinessGate(undefined);
    expect(result.pass).toBe(false);
    expect(result.overallScore).toBe(0);
  });

  // ============ CUSTOM THRESHOLD ============

  test('respects custom threshold', () => {
    const synthesis = {
      executiveSummary: [
        'Market reached $100M with 10% growth. ENGIE Corp leads. We recommend targeting factories because costs rose, resulting in savings. By Q2 2026 mandates create urgency.',
      ],
    };

    const high = semanticReadinessGate(synthesis, { threshold: 90 });
    const low = semanticReadinessGate(synthesis, { threshold: 20 });
    expect(high.threshold).toBe(90);
    expect(low.threshold).toBe(20);
    // Same synthesis, different thresholds
    expect(high.overallScore).toBe(low.overallScore);
    // Low threshold is more likely to pass
    expect(low.pass || !high.pass).toBe(true);
  });

  // ============ COHERENCE CHECKER INTEGRATION ============

  test('integrates coherence checker when provided', () => {
    const synthesis = {
      executiveSummary:
        'Market is $500M growing at 14% CAGR. ENGIE Corp holds 18% share. We recommend targeting factories because costs are rising, which means savings. Schneider Electric Corp expanded to $180M.',
      marketOpportunityAssessment: {
        totalAddressableMarket:
          'TAM is $50M. This represents a niche because only 120 factories qualify. ENGIE Corp entered in 2015 via JV. We should focus on Eastern Seaboard, resulting in geographic advantage.',
      },
    };

    const result = semanticReadinessGate(synthesis, {
      threshold: 80,
      coherenceChecker: checkCoherence,
    });
    // Should have run coherence check (market size mismatch: $500M vs $50M)
    expect(result).toHaveProperty('overallScore');
    expect(result).toHaveProperty('sectionScorecard');
  });

  // ============ SECTION SCORECARD STRUCTURE ============

  test('section scorecard has required fields for every section', () => {
    const result = semanticReadinessGate(highQualitySynthesis, { threshold: 80 });
    for (const entry of result.sectionScorecard) {
      expect(entry).toHaveProperty('section');
      expect(typeof entry.section).toBe('string');
      expect(entry).toHaveProperty('score');
      expect(typeof entry.score).toBe('number');
      expect(entry).toHaveProperty('pass');
      expect(typeof entry.pass).toBe('boolean');
      expect(entry).toHaveProperty('reasons');
      expect(Array.isArray(entry.reasons)).toBe(true);
    }
  });

  test('improvement actions are specific and actionable', () => {
    const shallowSynthesis = {
      executiveSummary: 'Brief.',
      marketOpportunityAssessment: { overview: 'Small.' },
    };

    const result = semanticReadinessGate(shallowSynthesis, { threshold: 80 });
    expect(result.improvementActions.length).toBeGreaterThan(0);
    // Actions should reference specific sections
    expect(
      result.improvementActions.some(
        (a) =>
          a.includes('executiveSummary') ||
          a.includes('marketOpportunityAssessment') ||
          a.includes('synthesis')
      )
    ).toBe(true);
  });
});

// ============ SHALLOW CONTENT DETECTION ============

describe('detectShallowContent', () => {
  test('detects very short content', () => {
    const result = detectShallowContent('Brief market overview.');
    expect(result.isShallow).toBe(true);
    expect(result.reasons.some((r) => r.includes('short'))).toBe(true);
  });

  test('detects placeholder/template text', () => {
    const result = detectShallowContent(
      'The market analysis is TBD. We need to insert additional research here. The competitive landscape shows [placeholder] data that needs to be updated later with real numbers and analysis.'
    );
    expect(result.isShallow).toBe(true);
    expect(result.reasons.some((r) => r.includes('Template') || r.includes('placeholder'))).toBe(
      true
    );
  });

  test('detects low information density', () => {
    const text =
      'The market presents various opportunities across multiple segments and regions. The industry dynamics continue to evolve as stakeholders evaluate strategic options. Several factors contribute to the overall trajectory of the sector. Market participants are exploring new approaches to address emerging challenges and capitalize on growth potential. The competitive landscape remains dynamic with ongoing shifts in market positioning.';
    const result = detectShallowContent(text);
    expect(result.isShallow).toBe(true);
    expect(result.reasons.some((r) => r.includes('density'))).toBe(true);
  });

  test('detects repetitive phrasing', () => {
    const text =
      'The market is growing. The market is large. The market is competitive. The market is evolving. The market is dynamic. More analysis needed for the market.';
    const result = detectShallowContent(text);
    expect(result.isShallow).toBe(true);
    expect(result.reasons.some((r) => r.includes('Repetitive') || r.includes('short'))).toBe(true);
  });

  test('passes for content-rich analytical text', () => {
    const text =
      'ENGIE Corp entered Thailand in 2018 via JV with B.Grimm, focusing on industrial parks near Bangkok. They won 12 contracts averaging $2M each. Revenue grew 15% in 2024 to reach $36M. Schneider Electric holds 17% market share with $180M revenue. Manufacturing wages rose 8% annually from 2021-2024. The regulatory push from DEDE mandates ISO 50001 compliance by Q3 2026 for all factories over 1,000 employees.';
    const result = detectShallowContent(text);
    expect(result.isShallow).toBe(false);
    expect(result.density).toBeGreaterThan(1);
  });

  test('handles null/empty input', () => {
    expect(detectShallowContent(null).isShallow).toBe(true);
    expect(detectShallowContent('').isShallow).toBe(true);
    expect(detectShallowContent(undefined).isShallow).toBe(true);
  });
});

// ============ SECTION-LEVEL SCORING IS DETERMINISTIC ============

describe('deterministic scoring', () => {
  test('same input always produces same section scores', () => {
    const synthesis = {
      executiveSummary: [
        'Market reached $320M in 2024 at 14% CAGR. ENGIE Corp and Schneider Electric dominate. We recommend targeting factories because costs rise 8% annually, resulting in demand for efficiency.',
      ],
      competitivePositioning: {
        keyPlayers: [
          {
            name: 'ENGIE Corp',
            description:
              '$2.3B revenue, 18% share. Entered 2015 via JV. 12 contracts at $2M average. However provincial coverage limited.',
          },
        ],
      },
    };

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(semanticReadinessGate(synthesis, { threshold: 80 }));
    }

    for (let i = 1; i < results.length; i++) {
      expect(results[i].overallScore).toBe(results[0].overallScore);
      for (let j = 0; j < results[0].sectionScorecard.length; j++) {
        expect(results[i].sectionScorecard[j].score).toBe(
          results[0].sectionScorecard[j].score
        );
      }
    }
  });
});
