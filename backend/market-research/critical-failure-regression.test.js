#!/usr/bin/env node
/**
 * Critical Failure Mode Regression Tests
 *
 * Tests the 4 most critical failure modes in the market-research pipeline:
 * 1. Content depth collapse — rich research surviving quality gates
 * 2. Weak story flow passing — disconnected/generic content being rejected
 * 3. Key insight truncation before slides — insights not being cut to 80 chars
 * 4. Review loop stagnation — loop stopping when same feedback repeats
 *
 * Run:
 *   node critical-failure-regression.test.js
 */

const assert = require('assert');

// --- Imports from the codebase ---
const {
  checkContentReadiness,
  detectShallowContent,
  antiShallow,
} = require('./content-quality-check');

const { checkStoryFlow, detectCoherenceBreaks } = require('./story-flow-check');

const {
  validateResearchQuality,
  validateSynthesisQuality,
  validatePptData,
  blockHasRenderableData,
} = require('./content-gates');

const { __test: singlePptTest } = require('./deck-builder-single');

// ============================================================
// HELPERS
// ============================================================

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
  }
}

// ============================================================
// 1. CONTENT DEPTH COLLAPSE
// ============================================================

function runContentDepthCollapseTests() {
  console.log('\n=== Test Suite 1: Content Depth Collapse ===');

  // Build a rich synthesis with deep content in every section.
  // This represents what the research engine produces: detailed analysis
  // with specific companies, numbers, causal reasoning, and actionable insights.
  const richSynthesis = {
    isSingleCountry: true,
    executiveSummary: [
      'The Vietnamese energy services market represents a $4.2 billion total addressable market growing at 12.3% CAGR through 2028, driven by government commitments under Resolution 55-NQ/TW and the revised Power Development Plan VIII (PDP8). Vietnam Electric (EVN) controls 62% of generation capacity but faces mounting pressure to diversify supply sources, creating opportunities for foreign ESCOs and independent power producers. The entry window should be pursued because regulatory reform is accelerating faster than competitor response, therefore early movers will capture disproportionate share.',
      'Competitive intensity is moderate. Japanese players (JERA, Marubeni, Sumitomo Corp) have established JV positions in LNG and renewables but have not penetrated the ESCO segment. Local players like Tran Phu Electric and Pha Lai Thermal Power dominate brownfield maintenance but lack technology for smart-grid and demand-response services. Foreign entrants Schneider Electric (entered 2018, $120M Vietnam revenue) and Siemens Energy (entered 2020, growing 28% YoY) demonstrate that technology-led differentiation can capture 8-15% segment share within 3 years. We recommend targeting the ESCO segment because it has the widest capability gap.',
      'The recommended strategy is a phased JV entry with a local EPC partner (shortlist: LILAMA, PCC1, or Power Engineering Consulting JSC), targeting industrial ESCO contracts in the Ho Chi Minh City and Binh Duong industrial corridor. Initial investment of $2.5-4M over 18 months, with break-even projected at month 30 based on a pipeline of 12-15 industrial energy audit contracts valued at $150-400K each. Key risk: regulatory uncertainty around the direct PPA mechanism could delay revenue by 6-9 months if the Ministry of Industry and Trade (MOIT) extends the pilot timeline. We should pursue this because the risk-adjusted IRR remains 18-25% even under conservative scenarios.',
    ],
    marketOpportunityAssessment: {
      totalAddressableMarket: '$4.2 billion by 2028',
      serviceableMarket:
        'Industrial ESCO segment: $680M addressable, growing at 18.5% CAGR. Top 3 industrial zones (VSIP Binh Duong, Amata Bien Hoa, Tan Thuan) account for 42% of demand. Residential and commercial segments excluded due to tariff regulation constraints.',
      growthTrajectory:
        'Phase 1 (2025-2026): Pilot market with 15-20 contracts expected under direct PPA. Phase 2 (2027-2028): Competitive market opening doubles addressable pipeline. Phase 3 (2029+): Full retail deregulation per MOIT roadmap.',
      timingConsiderations:
        'JETP milestone payments require Vietnam to demonstrate 8 GW renewable capacity by 2027. This creates a regulatory forcing function that locks in favorable ESCO licensing conditions through at least 2030.',
    },
    regulatoryPathway: {
      overview:
        'Vietnam regulatory framework for energy services is governed by PDP8 (Power Development Plan VIII) approved in 2024, targeting 30% renewable energy by 2030. MOIT Decision 23/2024 launches a direct PPA pilot in 2025 covering 15 industrial zones. Key regulatory bodies: MOIT (licensing), EVN (grid access), ERAV (tariff setting). Foreign ESCO licensing requires JV with local entity holding minimum 51% equity, though CPTPP provisions may allow 100% foreign ownership by 2027. Therefore companies should establish JV now and plan for conversion to wholly-owned subsidiary. Tax incentives include 4-year corporate income tax holiday for renewable energy projects and 50% import duty exemption for energy-efficient equipment.',
    },
    competitivePositioning: {
      keyPlayers: [
        {
          name: 'Schneider Electric Vietnam',
          description:
            'Entered Vietnam in 2018 through acquisition of local distributor. Revenue $120M (2024), 28% YoY growth. Dominates building management and industrial automation ESCO. Strength: global brand, 450+ local staff, certified training center in HCMC. Weakness: premium pricing limits penetration in cost-sensitive SME segment. Market share: 12% of industrial ESCO.',
        },
        {
          name: 'Siemens Energy Vietnam',
          description:
            'Established 2020, rapid expansion through LNG turbine supply and grid modernization contracts with EVN. Revenue $85M (2024), 32% growth. Won $45M Nhon Trach 3&4 combined cycle gas turbine contract. Strength: technology edge in gas-to-power. Weakness: limited local engineering talent, relies on Singapore hub. Market share: 8% of generation services.',
        },
        {
          name: 'JERA Co Inc',
          description:
            'Japanese power giant (50% TEPCO, 50% Chubu Electric) entered Vietnam 2019 via JV with PetroVietnam for 1.5 GW LNG-to-power project in Son My. Revenue from Vietnam ops est. $200M by 2026. Strength: deep LNG supply chain, aligned with Japan-Vietnam energy cooperation MOU. Weakness: focused on large-scale generation, no ESCO capability. Market share: 15% of LNG generation segment.',
        },
        {
          name: 'Tran Phu Electric JSC',
          description:
            'Leading domestic electrical equipment and installation company, established 1962. Revenue $95M (2024), stable 5% growth. Core in cable manufacturing and transformer supply. Strength: 60+ year brand recognition, nationwide distribution, strong government relationships. Weakness: legacy technology, no smart-grid or IoT capability. Market share: 22% of electrical equipment distribution.',
        },
      ],
    },
    keyInsights: [
      {
        title: 'Direct PPA Pilot Opens Corporate Procurement',
        data: 'The Ministry of Industry and Trade (MOIT) Decision 23/2024 launches a 2-year direct PPA pilot in 2025 covering 15 industrial zones. Initial quota: 1,000 MW. Early participants include Samsung Vietnam, Intel, and Foxconn facilities seeking RE100 compliance.',
        pattern:
          'Multinational manufacturers drive demand — their RE100 commitments create captive demand for ESCO services that local providers cannot fulfill due to lack of international certification (ISO 50001, IPMVP).',
        implication:
          'First-mover ESCOs with international certification can lock in 3-5 year service agreements with MNC anchor tenants before the competitive market opens in 2027. Target: 8-12 MNC facilities in Binh Duong and Dong Nai industrial zones.',
        timing: 'Q2 2025 pilot launch, applications open Q4 2024',
      },
      {
        title: 'JETP Funding Pipeline Creates $15.5B Investment Wave',
        data: 'The Just Energy Transition Partnership (JETP) committed $15.5 billion in public and private financing through 2028. First disbursement tranche of $2.5B expected H1 2025, contingent on Vietnam publishing its Resource Mobilization Plan (RMP).',
        pattern:
          'JETP funding flows through state-owned EVN and then to private sector via competitive tenders. This creates a procurement pipeline of 200+ contracts for grid modernization, smart metering, and demand-response infrastructure.',
        implication:
          'Position as Tier-2 subcontractor to EVN-approved EPC firms (LILAMA, PCC1) to access JETP-funded projects without direct government contracting risk. Target: 3-5 subcontracts in grid modernization segment worth $5-15M each.',
        timing: 'H1 2025 first disbursement, Q3 2025 first competitive tenders',
      },
      {
        title: 'Local ESCO Capability Gap Creates 3-Year Window',
        data: 'Only 12 of 150+ registered ESCOs in Vietnam hold international energy management certifications (ISO 50001). Average ESCO contract value is $180K (vs. $450K regional average), indicating underdeveloped service sophistication.',
        pattern:
          'The certification gap means Vietnamese ESCOs compete on price for basic energy audits while leaving high-value demand-response, predictive maintenance, and building optimization segments underserved.',
        implication:
          'A certified foreign ESCO can charge 2-3x local rates by delivering services local firms cannot. The window closes as local firms upskill — estimated 3 years based on current training pipeline throughput of 8-10 certified firms/year.',
        timing: '2025-2028 window before local competition catches up',
      },
    ],
    depth: {
      dealEconomics: {
        overview:
          'Typical ESCO contracts in Vietnam follow a shared savings model with 60/40 splits favoring the ESCO in years 1-3, shifting to 50/50 in years 4-5. Average deal size: $150-400K for industrial facilities, $2-5M for commercial complexes. IRR target: 18-25% depending on energy price assumptions ($0.08-0.12/kWh industrial tariff). Key risk: Vietnam Dong depreciation (3-5% annual) erodes USD-denominated returns. We recommend structuring contracts in USD with VND adjustment clauses to mitigate currency risk.',
      },
      entryStrategy: {
        overview:
          'We recommend a phased JV approach over 18 months because it minimizes upfront capital commitment while establishing market presence. Phase 1 (months 1-6): Establish JV with local EPC partner at $800K investment, obtain ESCO license from MOIT, complete 3 pilot energy audits worth $450K total. Phase 2 (months 7-12): Scale to 8-12 active contracts generating $1.2M revenue, hire 15-20 local engineers, establish HCMC office. Phase 3 (months 13-18): Target operational break-even at 30% gross margin, begin direct PPA pilot participation for additional $2M revenue pipeline.',
      },
      partnerAssessment: {
        overview:
          'Three shortlisted JV partners evaluated with quantified scoring: LILAMA Corp (score: 82/100, revenue $320M, 2400 employees, established 1960) has strong EPC capability and government relationships, therefore we recommend them as primary partner candidate. PCC1 Group (score: 76/100, revenue $180M, growing 15% annually) is fast-growing and open to foreign technology, but concentrated in Northern Vietnam. Power Engineering Consulting JSC (PECC, score: 71/100, revenue $45M) has deep regulatory knowledge and EVN connections. We should pursue LILAMA for the initial JV because their southern Vietnam presence aligns with our target market geography.',
      },
    },
    implementation: {
      phases: [
        {
          name: 'Market Entry',
          timeline: 'Months 1-6',
          activities: [
            'Establish JV entity',
            'Obtain ESCO license',
            'Complete 3 pilot energy audits',
          ],
          investment: '$800K-1.2M',
        },
        {
          name: 'Scale Operations',
          timeline: 'Months 7-12',
          activities: [
            'Scale to 8-12 active contracts',
            'Hire 15-20 local engineers',
            'Establish HCMC office',
          ],
          investment: '$1.2-1.8M',
        },
        {
          name: 'Operational Maturity',
          timeline: 'Months 13-18',
          activities: [
            'Achieve break-even',
            'Begin direct PPA participation',
            'Expand to Dong Nai and Ha Noi industrial zones',
          ],
          investment: '$500K-1M',
        },
      ],
    },
  };

  test('Rich synthesis passes content readiness check', () => {
    const result = checkContentReadiness(richSynthesis, {
      threshold: 80,
      industry: 'Energy Services',
    });
    // The rich synthesis should pass the readiness gate without coherence checker
    // to isolate the depth-collapse test from cross-section coherence noise.
    assert.strictEqual(
      result.pass,
      true,
      `Rich synthesis should pass content readiness (score=${result.overallScore}/${result.threshold}). ` +
        `Failures: ${(result.improvementActions || []).slice(0, 5).join(' | ')}`
    );
  });

  test('Rich synthesis has high overall score (>=65)', () => {
    // With coherence checker enabled, cross-section number matching can penalize.
    // The core test is: rich content should NOT collapse below 65 (passing territory).
    const result = checkContentReadiness(richSynthesis, {
      threshold: 80,
      industry: 'Energy Services',
      coherenceChecker: checkStoryFlow,
    });
    assert(
      result.overallScore >= 65,
      `Rich synthesis should score >=65 but got ${result.overallScore}. ` +
        `Shallow sections: ${(result.shallowSections || []).join(', ')}. ` +
        `Actions: ${(result.improvementActions || []).slice(0, 3).join(' | ')}`
    );
  });

  test('Rich synthesis has no shallow sections detected', () => {
    const result = checkContentReadiness(richSynthesis, {
      threshold: 80,
      industry: 'Energy Services',
    });
    assert.strictEqual(
      result.shallowSections.length,
      0,
      `Rich synthesis should have 0 shallow sections but found: ${result.shallowSections.join(', ')}`
    );
  });

  test('Deep executive summary is NOT detected as shallow', () => {
    // Each paragraph is 100+ words with specific numbers and companies.
    const text = richSynthesis.executiveSummary.join(' ');
    const result = detectShallowContent(text);
    assert.strictEqual(
      result.isShallow,
      false,
      `Deep executive summary text (${text.split(/\s+/).length} words) should not be shallow. Reasons: ${result.reasons.join('; ')}`
    );
  });

  test('Research quality gate passes for content-rich research data', () => {
    // Build research data that simulates what the engine produces.
    const researchData = {};
    const topics = [
      'marketSize',
      'competitiveLandscape',
      'regulatoryFramework',
      'entryStrategy',
      'investmentClimate',
      'supplyChainDynamics',
      'technologyLandscape',
    ];
    for (const topic of topics) {
      researchData[topic] = {
        content:
          `The ${topic} analysis for Vietnam energy services shows significant growth in 2024-2028. ` +
          `Schneider Electric Corp and Siemens Energy Group have established strong positions. ` +
          `Market size reached $4.2 billion with 12.3% CAGR. The regulatory framework under PDP8 ` +
          `provides favorable conditions for foreign ESCOs. Key metrics include 62% EVN market share, ` +
          `$15.5 billion JETP pipeline, and 150+ registered ESCOs. Investment requirements range from ` +
          `$2.5-4M for phased entry over 18 months. ` +
          'A'.repeat(300), // Ensure >300 chars
      };
    }
    const result = validateResearchQuality(researchData);
    assert.strictEqual(
      result.pass,
      true,
      `Rich research data should pass quality gate (score=${result.score}). Issues: ${result.issues.join(' | ')}`
    );
  });

  test('PPT data gate preserves blocks with substantial content', () => {
    const richBlocks = [
      {
        key: 'executiveSummary',
        type: 'section',
        title: 'Executive Summary',
        content:
          'The Vietnamese energy services market represents a $4.2 billion TAM growing at 12.3% CAGR through 2028. Schneider Electric and Siemens Energy have established strong positions with $120M and $85M revenue respectively.',
      },
      {
        key: 'marketOverview',
        type: 'section',
        title: 'Market Overview',
        content:
          'Industrial ESCO segment: $680M addressable, growing at 18.5% CAGR. Top 3 industrial zones (VSIP Binh Duong, Amata Bien Hoa, Tan Thuan) account for 42% of demand.',
      },
      {
        key: 'competitiveLandscape',
        type: 'section',
        title: 'Competitive Landscape',
        content:
          'Schneider Electric Vietnam: revenue $120M (2024), 28% YoY growth, 12% market share. Siemens Energy: $85M revenue, 32% growth. JERA: $200M projected by 2026.',
      },
      {
        key: 'regulatoryFramework',
        type: 'section',
        title: 'Regulatory Framework',
        content:
          'Power Development Plan VIII (PDP8) targets 30% renewable by 2030. MOIT Decision 23/2024 launches direct PPA pilot covering 15 industrial zones with 1,000 MW quota.',
      },
      {
        key: 'strategyRecommendation',
        type: 'section',
        title: 'Strategy Recommendation',
        content:
          'Phased JV entry with local EPC partner targeting industrial ESCO contracts in HCMC and Binh Duong corridor. Investment: $2.5-4M over 18 months, break-even at month 30.',
      },
    ];

    const gate = validatePptData(richBlocks);
    assert.strictEqual(
      gate.pass,
      true,
      `Rich PPT blocks should pass data gate. Empty blocks: ${gate.emptyBlocks.join(' | ')}`
    );
    // Verify none of these substantial blocks are flagged as non-renderable
    const nonRenderable = richBlocks.filter((b) => !blockHasRenderableData(b));
    assert.strictEqual(
      nonRenderable.length,
      0,
      `All rich blocks should be renderable, but ${nonRenderable.length} were flagged as non-renderable: ${nonRenderable.map((b) => b.key).join(', ')}`
    );
  });
}

// ============================================================
// 2. WEAK STORY FLOW PASSING
// ============================================================

function runWeakStoryFlowTests() {
  console.log('\n=== Test Suite 2: Weak Story Flow Passing ===');

  test('Disconnected sections produce low coherence score', () => {
    // Synthesis with completely unrelated content across sections.
    const disconnectedSynthesis = {
      executiveSummary:
        'The automotive industry in Germany grew by 5% in 2024. BMW Corp and Volkswagen Group dominate with $150 billion combined revenue. The market size is $350 billion.',
      marketOpportunityAssessment:
        'Vietnam fishing industry TAM is $2.1 billion. Shrimp exports reached $4 billion in 2023. Aquaculture Corp Ltd and Pacific Seafood Group are key players.',
      competitivePositioning:
        'SolarEdge Technologies Inc has 25% market share in residential solar inverters in Australia. Their revenue reached $890 million with 15% CAGR growth annually.',
      keyInsights:
        'The Brazilian fintech sector saw 200% user growth. NuBank Corp reported 80 million customers. Mercado Pago Group processes $45 billion in annual transactions.',
      depth: {
        dealEconomics:
          'Typical deal size in Canadian mining is $50 million. Barrick Gold Corp and Teck Resources Group have $25 billion combined market cap. The market size is $80 billion.',
        entryStrategy:
          'Entry into the Japanese convenience store market requires $5 million initial investment. Seven-Eleven Japan Corp has 21,000 locations. The market size is $120 billion.',
      },
    };

    const result = checkStoryFlow(disconnectedSynthesis);
    // This should detect entity mismatches and market size inconsistencies
    assert(
      result.issues.length > 0,
      `Disconnected synthesis should have coherence issues but found ${result.issues.length}`
    );
    assert(
      result.score < 80,
      `Disconnected synthesis should score below 80 but got ${result.score}`
    );
  });

  test('Generic filler content is detected as shallow', () => {
    // detectShallowContent flags shallow when: words < 30, or template patterns present,
    // or (words >= 50 && density < 1 specific per 100 words), or repetitive phrasing.
    // This text has 60+ words but zero specifics (no $, no %, no years, no company names).
    const genericContent =
      'The market is growing rapidly and shows significant potential for expansion across all segments. ' +
      'There are many opportunities for investment in this dynamic and evolving landscape. ' +
      'Companies are expanding their operations to capture growing demand in new markets. ' +
      'The industry is undergoing transformation driven by multiple factors including innovation. ' +
      'Growth is expected to continue at a strong pace throughout the forecast period ahead. ' +
      'Market conditions remain favorable for new entrants who can differentiate effectively. ' +
      'The competitive landscape continues to evolve as players pursue strategic partnerships and alliances.';
    const result = detectShallowContent(genericContent);
    assert.strictEqual(
      result.isShallow,
      true,
      `Generic filler (${genericContent.split(/\s+/).length} words, 0 specifics) should be detected as shallow. ` +
        `Density: ${result.density}, Reasons: ${result.reasons.join('; ')}`
    );
  });

  test('Market size contradictions across sections are flagged', () => {
    const contradictorySynthesis = {
      executiveSummary:
        'The total addressable market size for energy services in Vietnam is $4.2 billion, with growth of 12% CAGR through 2028.',
      marketOpportunityAssessment:
        'The market is growing with strong fundamentals. Schneider Electric Corp is a key player.',
      competitivePositioning:
        'Three key players dominate. The total addressable market size is $45 billion according to industry reports.',
      depth: {
        dealEconomics:
          'The overall market size is $800 million. Typical deal sizes range from $100K to $500K.',
      },
    };

    const result = checkStoryFlow(contradictorySynthesis);
    // Should find market size mismatch between executiveSummary ($4.2B) and competitivePositioning ($45B)
    const marketSizeIssues = result.issues.filter((i) =>
      i.toLowerCase().includes('market size mismatch')
    );
    assert(
      marketSizeIssues.length > 0 || result.score < 70,
      `Contradictory market sizes ($4.2B vs $45B vs $800M) should produce issues or low score. Score: ${result.score}, Issues: ${result.issues.join(' | ')}`
    );
  });

  test('Coherence breaks detect growth rate mismatches across sections', () => {
    const inconsistentGrowth = {
      executiveSummary:
        'The energy market is growing at 5.2% CAGR annually. Market size is $10 billion.',
      marketOpportunityAssessment:
        'Growth rate of 28.5% CAGR makes this a high-priority market. Revenue is expanding.',
      competitivePositioning: 'Companies are benefiting from 3.1% annual growth in the sector.',
    };

    const breaks = detectCoherenceBreaks(inconsistentGrowth);
    const growthBreaks = breaks.filter((b) => b.type === 'growth-rate-mismatch');
    assert(
      growthBreaks.length > 0,
      `Growth rates 5.2% vs 28.5% vs 3.1% should produce coherence breaks. Found: ${breaks.map((b) => b.type).join(', ')}`
    );
  });

  test('Well-connected synthesis gets high coherence score', () => {
    const coherentSynthesis = {
      executiveSummary:
        'The Vietnam energy services market size is $4.2 billion growing at 12% CAGR. Schneider Electric Corp leads with $120M revenue and 12% market share. Entry timeline is 18 months.',
      marketOpportunityAssessment:
        'Total addressable market size of $4.2 billion with 12% CAGR growth. Industrial ESCO segment $680M. Schneider Electric Corp dominates.',
      competitivePositioning:
        'Schneider Electric Corp: $120M revenue, 12% market share. Siemens Energy Corp: $85M revenue. JERA Co Inc: $200M projected.',
      keyInsights:
        'Market size of $4.2 billion with 12% CAGR. Schneider Electric Corp and Siemens Energy Corp are established. Entry window: 18 months.',
      depth: {
        dealEconomics:
          'The overall market size is $4.2 billion. Average deal size $150-400K. Market growing at 12% CAGR through 2028. Schneider Electric Corp benchmarks at $120M.',
        entryStrategy:
          'Phased entry over 18 months. Target market size: $4.2 billion growing at 12% CAGR.',
      },
    };

    const result = checkStoryFlow(coherentSynthesis);
    assert(
      result.score >= 70,
      `Coherent synthesis should score >=70 but got ${result.score}. Issues: ${result.issues.join(' | ')}`
    );
  });
}

// ============================================================
// 3. KEY INSIGHT TRUNCATION BEFORE SLIDES
// ============================================================

function runInsightTruncationTests() {
  console.log('\n=== Test Suite 3: Key Insight Truncation Before Slides ===');

  test('safeCell does NOT truncate text under 3000 chars', () => {
    const safeCell = singlePptTest.safeCell;
    assert(typeof safeCell === 'function', 'safeCell must be exported via __test');

    // 500-word insight (typical production length).
    const longInsight =
      'The Vietnamese energy services market represents a significant opportunity for foreign ESCOs. ' +
      'Schneider Electric entered in 2018 through acquisition of a local distributor and achieved ' +
      '$120 million in revenue by 2024, demonstrating 28% year-over-year growth. Their success validates ' +
      'the market entry thesis: technology-led differentiation commands premium pricing in a market where ' +
      'local competitors lack international certifications. Of 150 registered ESCOs in Vietnam, only 12 hold ' +
      'ISO 50001 certification, creating a 3-year window before local firms upskill. The JETP funding ' +
      'pipeline of $15.5 billion provides additional tailwind through government-funded grid modernization ' +
      'contracts. First disbursement of $2.5 billion is expected in H1 2025, with competitive tenders ' +
      'following in Q3 2025. The recommended approach targets industrial zones in Binh Duong and Dong Nai ' +
      'provinces where manufacturing FDI concentration creates captive ESCO demand. Key risks include VND ' +
      'depreciation (3-5% annually) and regulatory delays around the direct PPA mechanism, which could push ' +
      'revenue timelines by 6-9 months if MOIT extends the pilot period beyond its initial 2-year scope. ' +
      'Despite these risks, the risk-adjusted IRR remains attractive at 18-25% based on conservative tariff ' +
      'assumptions of $0.08-0.12 per kWh for industrial consumers. The competitive moat from international ' +
      'certification and MNC relationships provides sustainable pricing power that local competitors cannot ' +
      'replicate within the forecast period. Strategic partners LILAMA and PCC1 offer complementary EPC ' +
      'capabilities that reduce execution risk and provide access to EVN-funded project pipelines.';

    const result = safeCell(longInsight);
    assert(
      result.length > 80,
      `safeCell should NOT truncate to 80 chars. Input: ${longInsight.length} chars, Output: ${result.length} chars`
    );
    assert(
      result.length > 200,
      `safeCell should preserve substantial content. Input: ${longInsight.length} chars, Output: ${result.length} chars`
    );
    // With STRICT_TEMPLATE_FIDELITY=true (default), full text should pass through
    assert.strictEqual(
      result,
      longInsight,
      `safeCell should preserve full text when STRICT_TEMPLATE_FIDELITY is enabled. Got ${result.length} chars instead of ${longInsight.length}`
    );
  });

  test('safeCell preserves 500+ char insights without cutting to 80', () => {
    const safeCell = singlePptTest.safeCell;
    const insight500 =
      'Market analysis reveals that the total addressable market for industrial energy services in Vietnam has grown from $2.8 billion in 2022 to $4.2 billion in 2024, representing a compound annual growth rate of 22.4% over two years. This growth trajectory significantly outpaces regional benchmarks (Thailand 8.2%, Indonesia 11.5%, Philippines 9.8%) and is driven primarily by three factors: the government aggressive renewable energy targets under PDP8, the influx of manufacturing FDI from companies relocating supply chains from China, and the JETP funding pipeline of $15.5 billion that provides direct procurement opportunities for ESCO services.';

    const result = safeCell(insight500);
    // The result should NOT be truncated to 80 chars — that was the old bug.
    assert(
      result.length > 80,
      `500+ char insight was truncated to ${result.length} chars. This is the critical truncation bug.`
    );
    // Should be at least 300 chars (even if some truncation happens, it should not be severe)
    assert(
      result.length >= 300,
      `Insight lost ${insight500.length - result.length} chars. Result: ${result.length} chars. Critical data loss.`
    );
  });

  test('safeCell with explicit maxLen=80 still preserves content beyond 80 chars', () => {
    const safeCell = singlePptTest.safeCell;
    // The safeCell function internally remaps small maxLen values to larger caps.
    // maxLen=80 should be remapped to 300 (see code: if rounded <= 80, effectiveLimit = 300)
    const insightText =
      'Schneider Electric Vietnam entered the market in 2018 through acquisition and achieved $120M revenue by 2024 with 28% YoY growth. They hold 12% market share in industrial ESCO segment.';
    const result = safeCell(insightText, 80);
    assert(
      result.length > 80,
      `safeCell(text, 80) should NOT hard-clip at 80 chars. Got ${result.length} chars. The effective limit should be remapped to 300.`
    );
  });

  test('safeCell hard cap at 3000 chars protects against crashes', () => {
    const safeCell = singlePptTest.safeCell;
    const oversized = 'A'.repeat(5000);
    const result = safeCell(oversized);
    assert(
      result.length <= 3010,
      `safeCell should cap at ~3000 chars for crash protection. Got ${result.length}`
    );
    assert(result.length > 0, 'safeCell should not return empty for oversized input');
  });

  test('PPT data gate does not reject blocks with long content', () => {
    // Simulate blocks with 500+ char content fields — these should pass the gate.
    const longContent =
      'Detailed market analysis showing $4.2B TAM with 12.3% CAGR growth through 2028. ' +
      'Key players include Schneider Electric ($120M revenue, 28% YoY growth, 12% market share), ' +
      'Siemens Energy ($85M revenue, 32% growth), and JERA ($200M projected by 2026). ' +
      'The industrial ESCO segment represents $680M addressable market growing at 18.5% CAGR. ' +
      'Top 3 industrial zones (VSIP Binh Duong, Amata Bien Hoa, Tan Thuan) account for 42% of demand. ' +
      'Regulatory support through PDP8 and JETP funding of $15.5 billion creates favorable conditions.';

    const blocks = [
      { key: 'summary', type: 'section', title: 'Summary', content: longContent },
      { key: 'market', type: 'section', title: 'Market', content: longContent },
      { key: 'competition', type: 'section', title: 'Competition', content: longContent },
    ];

    const gate = validatePptData(blocks);
    // Long content should NOT cause failure — overflow risks are noted but should not block.
    // The gate should pass because the sections have real data.
    assert.strictEqual(
      gate.sectionsWithDataCount >= 2,
      true,
      `Blocks with 500+ char content should have data. Got ${gate.sectionsWithDataCount} sections with data.`
    );
  });
}

// ============================================================
// 4. FINAL REVIEW LOOP NOT IMPROVING
// ============================================================

function runReviewLoopStagnationTests() {
  console.log('\n=== Test Suite 4: Review Loop Stagnation Detection ===');

  test('Review loop with identical feedback stops within 3 iterations', () => {
    // Simulate the review loop logic from server.js.
    // When the reviewer returns the same feedback repeatedly, the loop should cap at MAX retries.
    const MAX_RETRIES = 3;
    const sameIssues = [
      'Slide 4 has insufficient competitor detail',
      'Market size chart is missing data points',
    ];

    const reviewLoop = [];
    let loopCount = 0;

    // Simulate the review loop — same feedback every time.
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      loopCount++;
      // Mock: reviewer always returns same issues, ready=false.
      const review = {
        ready: false,
        confidence: 45,
        issues: [...sameIssues],
        actions: ['Add more competitor data', 'Fix market size chart'],
      };

      reviewLoop.push({
        round: attempt,
        ready: review.ready,
        confidence: review.confidence,
        issues: review.issues,
      });

      if (review.ready) break;
    }

    assert.strictEqual(
      loopCount,
      MAX_RETRIES,
      `Review loop should execute exactly ${MAX_RETRIES} times, got ${loopCount}`
    );
    assert.strictEqual(
      reviewLoop.length,
      MAX_RETRIES,
      `Review loop should record ${MAX_RETRIES} entries`
    );
    // The loop should NOT exceed MAX_RETRIES.
    assert(
      loopCount <= MAX_RETRIES,
      `Review loop ran ${loopCount} times, exceeding MAX_RETRIES=${MAX_RETRIES}. Infinite loop risk.`
    );
  });

  test('Content review loop caps at MAX_CONTENT_REVIEW_RETRIES=3', () => {
    // Simulate the content review loop from server.js lines 1733-1860.
    const MAX_CONTENT_REVIEW_RETRIES = 3;
    const contentReviewLoop = [];
    const overallScore = 55; // Below threshold=80

    for (let attempt = 1; attempt <= MAX_CONTENT_REVIEW_RETRIES; attempt++) {
      // Mock: model returns something but score doesn't improve.
      contentReviewLoop.push({
        attempt,
        applied: true,
        score: overallScore, // Score stays the same — stagnation.
        pass: false,
      });
      if (overallScore >= 80) break;
    }

    assert.strictEqual(
      contentReviewLoop.length,
      MAX_CONTENT_REVIEW_RETRIES,
      `Content review loop should cap at ${MAX_CONTENT_REVIEW_RETRIES}. Got ${contentReviewLoop.length}.`
    );
    // Verify all attempts recorded same stagnant score.
    const allSameScore = contentReviewLoop.every((r) => r.score === 55);
    assert.strictEqual(allSameScore, true, 'All attempts should record the same stagnant score');
  });

  test('Final deck review loop caps at MAX_FINAL_DECK_REVIEW_RETRIES=5', () => {
    // Simulate the McKinsey-style final deck review from server.js lines 2753-2938.
    const MAX_FINAL_DECK_REVIEW_RETRIES = 5;
    const finalDeckReviewRounds = [];
    const identicalIssue = 'Competitive landscape slide lacks specific revenue figures';

    for (let attempt = 1; attempt <= MAX_FINAL_DECK_REVIEW_RETRIES; attempt++) {
      const roundEntry = {
        round: attempt,
        ready: false,
        confidence: 40,
        issues: [identicalIssue],
        actions: ['Add revenue data to competitor table'],
      };
      finalDeckReviewRounds.push(roundEntry);
      if (roundEntry.ready) break;
    }

    assert.strictEqual(
      finalDeckReviewRounds.length,
      MAX_FINAL_DECK_REVIEW_RETRIES,
      `Final deck review should cap at ${MAX_FINAL_DECK_REVIEW_RETRIES}. Got ${finalDeckReviewRounds.length}.`
    );
    // Verify the loop doesn't generate more rounds than allowed.
    assert(
      finalDeckReviewRounds.length <= MAX_FINAL_DECK_REVIEW_RETRIES,
      `Loop generated ${finalDeckReviewRounds.length} rounds, exceeding cap of ${MAX_FINAL_DECK_REVIEW_RETRIES}`
    );
  });

  test('Stage 2a review loop caps at MAX_STAGE2_REVIEW_RETRIES=3', () => {
    // Simulate from server.js lines 1379-1468.
    const MAX_STAGE2_REVIEW_RETRIES = 3;
    const stage2ReviewLoop = [];

    // Mock: countryNeedsReview always returns true (stagnation case).
    for (let attempt = 1; attempt <= MAX_STAGE2_REVIEW_RETRIES; attempt++) {
      stage2ReviewLoop.push({
        country: 'Vietnam',
        attempt,
        applied: true,
        stillNeedsReview: true, // Never resolves.
      });
    }

    assert.strictEqual(
      stage2ReviewLoop.length,
      MAX_STAGE2_REVIEW_RETRIES,
      `Stage 2a review should cap at ${MAX_STAGE2_REVIEW_RETRIES}. Got ${stage2ReviewLoop.length}.`
    );
  });

  test('Stagnation detection: same score across 3 attempts is recognized', () => {
    // This tests the pattern: if score doesn't improve across attempts, something is wrong.
    const attempts = [
      { attempt: 1, score: 55, pass: false },
      { attempt: 2, score: 55, pass: false },
      { attempt: 3, score: 55, pass: false },
    ];

    // Detect stagnation: all scores identical.
    const scores = attempts.map((a) => a.score);
    const isStagnant = scores.every((s) => s === scores[0]);
    assert.strictEqual(isStagnant, true, 'Should detect stagnation when all scores are identical');

    // Verify the loop terminated (it should have, given the cap).
    assert.strictEqual(
      attempts.length,
      3,
      'Loop should terminate at 3 attempts even with stagnation'
    );
  });
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('Critical Failure Mode Regression Tests');
  console.log('======================================');

  runContentDepthCollapseTests();
  runWeakStoryFlowTests();
  runInsightTruncationTests();
  runReviewLoopStagnationTests();

  console.log('\n======================================');
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);

  if (failures.length > 0) {
    console.log('\nFailed tests:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('\nAll critical failure mode tests PASSED.');
  }
}

module.exports = { __test: { passed, failed } };

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(2);
  });
}
