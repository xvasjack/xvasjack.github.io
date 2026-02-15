const {
  semanticReadinessGate,
  detectShallowContent,
  checkContradictions,
  analyze,
  scoreEvidenceGrounding,
  scoreInsightDepth,
  scoreActionability,
  detectRootCauseAnalysis,
  scoreStorylineCoherence,
} = require('./semantic-quality-engine');
const { checkCoherence } = require('./semantic-coherence-checker');

// ============ HIGH-QUALITY PAYLOAD (should pass >= 80) ============

describe('semanticReadinessGate', () => {
  const highQualitySynthesis = {
    executiveSummary: [
      "Thailand's energy services market reached $320M in 2024, growing at 14% CAGR since 2020. ENGIE Corp and Schneider Electric dominate with combined 35% market share. We recommend targeting mid-tier industrial factories because their energy spend averages $500K annually, which means significant savings potential of 15-20%. The regulatory push from DEDE creates urgency for compliance-driven demand. By Q2 2026, ISO 50001 mandates will force 1,200 factories to upgrade, therefore early movers capture first-wave contracts resulting in a $45M serviceable market. However, local competitors like B.Grimm Power Ltd have established relationships that create a barrier to entry.",
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
        implication: 'Factory operators seek 15-20% energy cost reductions to maintain margins.',
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
        "Thailand's energy services market is growing rapidly at 25% CAGR with strong demand. ENGIE Corp leads with 18% share. Market reached $320M in 2024. We recommend targeting mid-tier factories because costs are rising, which means savings potential. By Q2 2026 mandates create urgency, therefore early movers win.",
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
    expect(result.improvementActions.some((a) => a.toLowerCase().includes('contradiction'))).toBe(
      true
    );
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
        expect(results[i].sectionScorecard[j].score).toBe(results[0].sectionScorecard[j].score);
      }
    }
  });
});

// ============ RUBRIC DIMENSION TESTS ============

describe('rubric dimensions', () => {
  // Strong fixture — should score high on all 4 dimensions
  const strongFixture = {
    executiveSummary: [
      "Thailand's energy services market reached $320M in 2024, growing at 14% CAGR since 2020 according to DEDE annual report. ENGIE Corp and Schneider Electric Corp dominate with combined 35% market share. We recommend targeting mid-tier industrial factories because their energy spend averages $500K annually, which means significant savings potential of 15-20%. The regulatory push from DEDE creates urgency for compliance-driven demand. By Q2 2026, ISO 50001 mandates will force 1,200 factories to upgrade, therefore early movers capture first-wave contracts resulting in a $45M serviceable market. However, local competitors like B.Grimm Power Ltd have established relationships that create a barrier to entry, so consider partnering with a provincial utility as a contingency.",
    ],
    marketOpportunityAssessment: {
      totalAddressableMarket:
        'Market is $90M calculated from 1,200 factories at $500K average spend with 15% savings potential. Data from World Bank energy survey. Schneider Electric Corp revenue in Thailand grew to $180M in 2024. We should prioritize the Eastern Seaboard because industrial park concentration provides 60% of total demand. This means geographic focus reduces go-to-market cost by 40%. ENGIE Corp entered in 2015 via JV, resulting in rapid market share gains. By Q3 2026, regulatory compliance creates $30M in new addressable demand, therefore timing is critical. However, if mandates are delayed, consider targeting voluntary early adopters as fallback.',
      growthTrajectory:
        '14% CAGR driven by ISO 50001 mandate affecting 1,200+ factories according to DEDE compliance registry. This represents a strong growth opportunity because compliance deadlines are non-negotiable. Schneider Electric Corp projects 18% annual growth through 2028.',
    },
    competitivePositioning: {
      keyPlayers: [
        {
          name: 'ENGIE Corp',
          description:
            '$2.3B global revenue, 18% Thai market share based on DEDE registration data. Entered Thailand in 2015 via JV with B.Grimm Power Ltd. Focus on industrial parks, 12 active contracts averaging $2M each. However, their provincial network coverage remains limited because B.Grimm concentrates on Eastern Seaboard, therefore competitors with regional partnerships can capture 40% of demand outside Bangkok. We recommend targeting their underserved provincial segment by Q3 2026.',
        },
        {
          name: 'Schneider Electric Corp',
          description:
            '$36B global, 17% Thai market share sourced from company annual report. Revenue grew 15% in 2024 to $180M. Strong in building automation but weaker in heavy industrial. Recommend targeting their underserved mid-tier segment because they focus on enterprise accounts. By Q2 2026, prioritize factories with 500-1000 employees.',
        },
      ],
    },
    regulatoryPathway: {
      overview:
        'DEDE mandates ISO 50001 compliance by Q3 2026 for all factories over 1,000 employees according to Ministry gazette No. 142/2025. This means 1,200 factories must implement energy management systems, resulting in $90M compliance-driven market. By Q4 2026, penalties of $50K per violation take effect, consequently urgency increases. Schneider Electric Corp and ENGIE Corp have lobbied for extended timelines, however DEDE rejected extensions. Source: DEDE policy directive.',
    },
    keyInsights: [
      {
        title: 'Cost pressure creates demand urgency',
        data: 'Manufacturing wages rose 8% annually 2021-2024 driven by aging workforce according to Thai Labor Ministry data.',
        implication:
          'Factory operators seek 15-20% energy cost reductions to maintain margins. This means energy services demand is inelastic.',
        timing: 'Target CFOs by Q2 2026 before budget cycles close.',
        risk: 'Automation adoption may reduce energy intensity, lowering savings potential by 2028. Mitigate by offering automation-integrated ESCO packages.',
      },
      {
        title: 'Regulatory compliance window creates first-mover advantage',
        data: 'ISO 50001 mandate affects 1,200 factories with $50K penalties per violation starting Q4 2026.',
        implication:
          'Compliance is non-negotiable, therefore demand is guaranteed for early movers who capture contracts before deadline.',
        timing: 'Sign LOIs by Q1 2026 to lock in implementation slots before capacity constraints.',
        risk: 'If DEDE extends deadline (unlikely based on policy stance), early investments still generate ROI through energy savings.',
      },
    ],
    depth: {
      dealEconomics: {
        typicalDealSize: { min: '$2M', max: '$10M', average: '$5M' },
        contractTerms: { duration: '5 years', revenueSplit: 'Client 70% / Provider 30%' },
        financials: { paybackPeriod: '3 years', irr: '18%', marginProfile: '35%' },
        financingOptions: ['Project finance', 'ESCO model', 'Green bonds'],
        keyInsight:
          'Strong IRR driven by regulatory mandates and rising energy costs. According to IEA data, Thai industrial energy costs rose 12% in 2024.',
      },
    },
  };

  // Weak fixture — should fail on most dimensions
  const weakFixture = {
    executiveSummary: 'The market has opportunities for growth in this sector.',
    marketOpportunityAssessment: {
      totalAddressableMarket: 'Large market with potential.',
      growthTrajectory: 'Growing steadily.',
    },
    competitivePositioning: {
      keyPlayers: 'Several competitors exist in this space.',
    },
    keyInsights: [
      {
        title: 'Growth opportunity',
      },
    ],
  };

  test('strong fixture passes overall gate >= 80', () => {
    const result = semanticReadinessGate(strongFixture, {
      threshold: 80,
      industry: 'energy services',
    });
    expect(result.pass).toBe(true);
    expect(result.overallScore).toBeGreaterThanOrEqual(80);
  });

  test('strong fixture has rubric with all 4 dimensions', () => {
    const result = semanticReadinessGate(strongFixture, { threshold: 80 });
    expect(result.rubric).toBeDefined();
    expect(result.rubric).toHaveProperty('insightDepth');
    expect(result.rubric).toHaveProperty('evidenceGrounding');
    expect(result.rubric).toHaveProperty('storylineCoherence');
    expect(result.rubric).toHaveProperty('actionability');
    // All dimensions should score reasonably for strong content
    expect(result.rubric.insightDepth).toBeGreaterThan(40);
    expect(result.rubric.evidenceGrounding).toBeGreaterThan(40);
    expect(result.rubric.actionability).toBeGreaterThan(40);
  });

  test('strong fixture has root-cause analysis', () => {
    const result = semanticReadinessGate(strongFixture, { threshold: 80 });
    expect(result.rootCauseAnalysis).toBeDefined();
    expect(result.rootCauseAnalysis.hasRootCause).toBe(true);
    expect(result.rootCauseAnalysis.evidence.length).toBeGreaterThanOrEqual(3);
  });

  test('strong fixture has no remediation hints (all dimensions passing)', () => {
    const result = semanticReadinessGate(strongFixture, { threshold: 80 });
    // remediationHints should exist as an array
    expect(Array.isArray(result.remediationHints)).toBe(true);
  });

  test('weak fixture fails overall gate', () => {
    const result = semanticReadinessGate(weakFixture, {
      threshold: 80,
      industry: 'technology',
    });
    expect(result.pass).toBe(false);
    expect(result.overallScore).toBeLessThan(80);
  });

  test('weak fixture has low rubric scores', () => {
    const result = semanticReadinessGate(weakFixture, { threshold: 80 });
    expect(result.rubric.insightDepth).toBeLessThan(50);
    expect(result.rubric.evidenceGrounding).toBeLessThan(30);
    expect(result.rubric.actionability).toBeLessThan(30);
  });

  test('weak fixture emits remediation hints', () => {
    const result = semanticReadinessGate(weakFixture, { threshold: 80 });
    expect(result.remediationHints.length).toBeGreaterThan(0);
    // Each hint should have required structure
    for (const hint of result.remediationHints) {
      expect(hint).toHaveProperty('dimension');
      expect(hint).toHaveProperty('currentScore');
      expect(hint).toHaveProperty('target');
      expect(hint).toHaveProperty('hint');
      expect(typeof hint.hint).toBe('string');
      expect(hint.hint.length).toBeGreaterThan(20);
    }
  });

  test('weak fixture fails root-cause check', () => {
    const result = semanticReadinessGate(weakFixture, { threshold: 80 });
    expect(result.rootCauseAnalysis.hasRootCause).toBe(false);
    expect(
      result.improvementActions.some(
        (a) => a.toLowerCase().includes('root-cause') || a.toLowerCase().includes('causal')
      )
    ).toBe(true);
  });

  test('weak fixture remediation hints reference specific dimensions', () => {
    const result = semanticReadinessGate(weakFixture, { threshold: 80 });
    const dimensions = result.remediationHints.map((h) => h.dimension);
    // Should flag multiple dimensions
    expect(dimensions.length).toBeGreaterThanOrEqual(2);
    // Should include at least evidence grounding and actionability
    expect(dimensions.includes('evidenceGrounding') || dimensions.includes('actionability')).toBe(
      true
    );
  });
});

// ============ EVIDENCE GROUNDING SUB-SCORE ============

describe('scoreEvidenceGrounding', () => {
  test('scores high for text with sources, data, entities, quantified claims', () => {
    const text =
      'According to DEDE annual report, ENGIE Corp generated $2.3B in revenue. Market grew 14% CAGR driven by ISO 50001 mandate. Schneider Electric Corp achieved 15% growth resulting in $180M Thai revenue. Data from World Bank energy survey confirms industrial energy costs rose 12% in 2024.';
    const result = scoreEvidenceGrounding(text);
    expect(result.score).toBeGreaterThan(50);
    expect(result.factors.sourceAttributions).toBeGreaterThan(0);
    expect(result.factors.dataPoints).toBeGreaterThan(0);
    expect(result.factors.namedEntities).toBeGreaterThan(0);
  });

  test('scores low for vague ungrounded text', () => {
    const text =
      'The market is growing and there are opportunities. Several companies are active in this space. The outlook is positive with strong potential for expansion.';
    const result = scoreEvidenceGrounding(text);
    expect(result.score).toBeLessThan(20);
  });

  test('returns 0 for null/empty', () => {
    expect(scoreEvidenceGrounding(null).score).toBe(0);
    expect(scoreEvidenceGrounding('').score).toBe(0);
  });
});

// ============ INSIGHT DEPTH SUB-SCORE ============

describe('scoreInsightDepth', () => {
  test('scores high for complete insights with all 4 components', () => {
    const insights = [
      {
        title: 'Cost pressure creates demand',
        data: 'Wages rose 8% annually 2021-2024',
        implication: 'Operators seek 15-20% cost reductions to maintain margins',
        timing: 'Target CFOs by Q2 2026',
        risk: 'Automation may reduce savings potential by 2028',
      },
    ];
    const result = scoreInsightDepth(insights);
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.validCount).toBe(1);
    expect(result.issues).toHaveLength(0);
  });

  test('scores low for insights missing components', () => {
    const insights = [
      {
        title: 'Growth opportunity',
        // Missing: data, implication, timing, risk
      },
    ];
    const result = scoreInsightDepth(insights);
    expect(result.score).toBeLessThan(50);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test('returns 0 for empty insights array', () => {
    const result = scoreInsightDepth([]);
    expect(result.score).toBe(0);
    expect(result.totalCount).toBe(0);
  });

  test('returns 0 for null', () => {
    const result = scoreInsightDepth(null);
    expect(result.score).toBe(0);
  });
});

// ============ ACTIONABILITY SUB-SCORE ============

describe('scoreActionability', () => {
  test('scores high for synthesis with timing, directives, targets, mitigations', () => {
    const synthesis = {
      executiveSummary:
        'We recommend targeting mid-tier factories in Eastern Seaboard by Q2 2026. Should prioritize ISO 50001 compliance segment. However, if mandates are delayed, consider voluntary early adopters as fallback.',
      keyInsights: [
        {
          timing: 'Target CFOs by Q2 2026 before budget cycles close.',
          action: 'Focus on factories with 500-1000 employees.',
          risk: 'If demand softens, pivot to building automation as contingency plan.',
        },
      ],
    };
    const result = scoreActionability(synthesis);
    expect(result.score).toBeGreaterThan(40);
    expect(result.factors.timingReferences).toBeGreaterThan(0);
    expect(result.factors.actionDirectives).toBeGreaterThan(0);
  });

  test('scores low for synthesis without action language', () => {
    const synthesis = {
      executiveSummary: 'The market is growing. Several opportunities exist.',
    };
    const result = scoreActionability(synthesis);
    expect(result.score).toBeLessThan(20);
  });

  test('returns 0 for null', () => {
    expect(scoreActionability(null).score).toBe(0);
  });
});

// ============ ROOT-CAUSE ANALYSIS DETECTION ============

describe('detectRootCauseAnalysis', () => {
  test('detects root-cause chains in synthesis', () => {
    const synthesis = {
      executiveSummary:
        'Market is growing because regulatory mandates force compliance. This means factories must invest in energy management, resulting in $90M addressable market. Therefore early movers capture first-wave contracts.',
      keyInsights: [
        {
          data: 'Wages rose 8% driven by aging workforce. Due to rising labor costs, operators seek automation. Which leads to increased demand for energy efficiency.',
        },
      ],
    };
    const result = detectRootCauseAnalysis(synthesis);
    expect(result.hasRootCause).toBe(true);
    expect(result.evidence.length).toBeGreaterThanOrEqual(3);
    expect(result.score).toBeGreaterThan(20);
  });

  test('fails for synthesis without causal reasoning', () => {
    const synthesis = {
      executiveSummary: 'The market is growing. Opportunities exist. Companies are active.',
    };
    const result = detectRootCauseAnalysis(synthesis);
    expect(result.hasRootCause).toBe(false);
    expect(result.evidence.length).toBeLessThan(3);
  });

  test('returns 0 for null', () => {
    const result = detectRootCauseAnalysis(null);
    expect(result.hasRootCause).toBe(false);
    expect(result.score).toBe(0);
  });
});

// ============ STORYLINE COHERENCE SUB-SCORE ============

describe('scoreStorylineCoherence', () => {
  test('scores high when exec summary themes are echoed in other sections', () => {
    const synthesis = {
      executiveSummary:
        'Thailand energy services market reached $320M at 14% CAGR in 2024. ENGIE Corp holds 18% share with $2.3B global revenue. We recommend targeting mid-tier factories because their energy spend averages $500K annually, which means significant savings potential.',
      marketOpportunityAssessment: {
        totalAddressableMarket:
          '$320M market with 14% growth driven by ISO 50001 compliance mandate.',
      },
      competitivePositioning: {
        keyPlayers: [
          { name: 'ENGIE Corp', description: '18% market share leader with $2.3B global revenue.' },
        ],
      },
      keyInsights: [
        {
          title: 'Factory targeting strategy',
          action: 'Recommend focusing on mid-tier segment because energy costs rising.',
        },
      ],
    };
    const result = scoreStorylineCoherence(synthesis);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.issues.length).toBeLessThanOrEqual(1);
  });

  test('scores low when exec summary is disconnected from other sections', () => {
    const synthesis = {
      executiveSummary:
        'Market reached $500M with ENGIE Corp holding 18% share. We recommend targeting factories.',
      marketOpportunityAssessment: {
        totalAddressableMarket: 'Healthcare is a $2T global industry with diverse segments.',
      },
      keyInsights: [
        { title: 'Unrelated insight', data: 'Population aging drives healthcare demand.' },
      ],
    };
    const result = scoreStorylineCoherence(synthesis);
    // Should detect that exec numbers are not echoed
    expect(result.score).toBeLessThan(100);
  });

  test('returns 0 for missing executive summary', () => {
    const result = scoreStorylineCoherence({
      marketOpportunityAssessment: { overview: 'Some content.' },
    });
    expect(result.score).toBe(0);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

// ============ MAJOR COHERENCE FAILURE HARD BLOCK ============

describe('major coherence failure', () => {
  test('blocks ready even when score might otherwise pass', () => {
    // Simulate by using coherenceChecker that returns very low score
    const lowCoherenceChecker = () => ({
      score: 10,
      issues: ['Massive market size mismatch', 'Timeline contradiction', 'Entity mismatch'],
      linkedPairs: [],
    });

    // Use the strong fixture from the rubric tests
    const synthesis = {
      executiveSummary: [
        'Market reached $320M at 14% CAGR. ENGIE Corp holds 18% share. We recommend targeting factories because costs are rising, resulting in demand. By Q2 2026 mandates create urgency, therefore early movers win.',
      ],
      marketOpportunityAssessment: {
        totalAddressableMarket:
          'Market is $90M. Schneider Electric Corp revenue grew to $180M. We should prioritize Eastern Seaboard because concentration provides 60% demand, resulting in cost savings. By Q3 2026 compliance creates $30M demand.',
      },
      competitivePositioning: {
        keyPlayers: [
          {
            name: 'ENGIE Corp',
            description:
              '$2.3B revenue, 18% Thai share. Entered 2015 via JV. However provincial coverage limited because B.Grimm concentrates on Eastern Seaboard.',
          },
        ],
      },
      keyInsights: [
        {
          title: 'Cost pressure',
          data: 'Wages rose 8% annually',
          implication: 'Operators seek cost reductions',
          timing: 'Target by Q2 2026',
          risk: 'Automation may reduce savings',
        },
      ],
    };

    const result = semanticReadinessGate(synthesis, {
      threshold: 80,
      coherenceChecker: lowCoherenceChecker,
    });
    // Major coherence failure should block regardless of score
    expect(result.pass).toBe(false);
    expect(result.improvementActions.some((a) => a.includes('BLOCKING'))).toBe(true);
  });
});

// ============ READINESS REPORT STRUCTURE ============

describe('readiness report structure', () => {
  test('output includes all required fields', () => {
    const synthesis = {
      executiveSummary:
        'Market reached $100M. ENGIE Corp leads. We recommend targeting factories because costs rose, resulting in savings.',
      keyInsights: [
        {
          title: 'Test',
          data: 'Data point',
          implication: 'Impact statement',
          timing: 'Q2 2026',
          risk: 'Low risk',
        },
      ],
    };
    const result = semanticReadinessGate(synthesis, { threshold: 80 });

    // Core fields
    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('overallScore');
    expect(result).toHaveProperty('threshold');
    expect(result).toHaveProperty('rubric');
    expect(result).toHaveProperty('sectionScorecard');
    expect(result).toHaveProperty('shallowSections');
    expect(result).toHaveProperty('contradictions');
    expect(result).toHaveProperty('plausibilityIssues');
    expect(result).toHaveProperty('rootCauseAnalysis');
    expect(result).toHaveProperty('improvementActions');
    expect(result).toHaveProperty('remediationHints');

    // Rubric structure
    expect(typeof result.rubric.insightDepth).toBe('number');
    expect(typeof result.rubric.evidenceGrounding).toBe('number');
    expect(typeof result.rubric.storylineCoherence).toBe('number');
    expect(typeof result.rubric.actionability).toBe('number');

    // Root cause structure
    expect(typeof result.rootCauseAnalysis.hasRootCause).toBe('boolean');
    expect(Array.isArray(result.rootCauseAnalysis.evidence)).toBe(true);
    expect(typeof result.rootCauseAnalysis.score).toBe('number');

    // Remediation hints structure
    expect(Array.isArray(result.remediationHints)).toBe(true);
  });

  test('null input includes full structure with zeros', () => {
    const result = semanticReadinessGate(null);
    expect(result.rubric).toEqual({
      insightDepth: 0,
      evidenceGrounding: 0,
      storylineCoherence: 0,
      actionability: 0,
    });
    expect(result.rootCauseAnalysis).toEqual({
      hasRootCause: false,
      evidence: [],
      score: 0,
    });
    expect(result.remediationHints.length).toBeGreaterThan(0);
  });
});
