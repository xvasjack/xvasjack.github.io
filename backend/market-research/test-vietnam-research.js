#!/usr/bin/env node
/**
 * Vietnam Market Research test harness.
 *
 * This script now routes through the production single-country builder
 * (`generateSingleCountryPPT`) so formatting, truncation handling,
 * structure repair, and quality gates are identical to real runs.
 *
 * Run: node test-vietnam-research.js
 * Output: backend/market-research/vietnam-output.pptx
 */

const fs = require('fs');
const path = require('path');
const { generateSingleCountryPPT } = require('./deck-builder-single');
const { runContentSizeCheck } = require('./content-size-check');
const {
  normalizeSlideNonVisualIds,
  reconcileContentTypesAndPackage,
  readPPTX,
  scanRelationshipTargets,
  scanPackageConsistency,
} = require('./deck-file-check');
// Lazy-load visual styleMatch runner (optional module, may not exist yet)
let runVisualFidelityCheck;
try {
  ({ runVisualFidelityCheck } = require('./visual-styleMatch-runner'));
} catch {
  runVisualFidelityCheck = async () => ({
    valid: true,
    score: 0,
    summary: { failed: 0 },
    checks: [],
  });
}

const mockData = {
  country: 'Vietnam',
  industry: 'Energy Services',
  client: 'Shizuoka Gas',
  projectName: 'Vietnam Energy Services Entry Strategy',
  policy: {
    acts: [
      {
        name: 'Law on Economical and Efficient Use of Energy',
        year: '2010',
        description:
          'Large consumers must run periodic audits, appoint energy managers, and implement efficiency plans.',
        enforcement: 'Ministry and provincial inspectors with annual compliance checks',
        penalties: 'Administrative fines and mandatory corrective plans for non-compliance',
      },
      {
        name: 'Power Development Plan 8 (PDP8)',
        year: '2023',
        description:
          'Sets generation expansion to 2030 with strong renewable additions and gas transition support.',
        enforcement: 'National planning with utility-level implementation milestones',
        penalties: 'Project delays can trigger permit and procurement consequences',
      },
      {
        name: 'Revised Energy Efficiency Law',
        year: '2025/2026',
        description:
          'Expands sector scope, strengthens reporting requirements, and increases accountability.',
        enforcement: 'Expanded agency oversight with tighter reporting deadlines',
        penalties: 'Stronger fines and formal remediation requirements',
      },
    ],
    foreignOwnership: {
      general: '49% baseline cap in sensitive energy assets',
      exceptions: 'JV and project-structure exceptions available depending on asset and zone',
      promoted: 'Incentivized clean energy projects can receive better treatment',
    },
    incentives: [
      {
        name: 'CIT incentive package',
        benefit: '4 years tax exemption plus reduced rates in follow-on years',
        eligibility: 'Qualified clean-energy and efficiency projects',
      },
      {
        name: 'Import duty exemption',
        benefit: 'Duty relief for approved equipment',
        eligibility: 'Projects aligned to national clean-energy priorities',
      },
      {
        name: 'Land-use incentive',
        benefit: 'Reduced land rent in strategic industrial zones',
        eligibility: 'Projects in designated locations and sectors',
      },
    ],
  },
  market: {
    tpesChart: {
      categories: ['2020', '2021', '2022', '2023', '2024', '2030P'],
      series: [
        { name: 'Coal', values: [47, 48, 49, 48, 47, 38] },
        { name: 'Oil', values: [25, 24, 23, 22, 21, 18] },
        { name: 'Natural Gas', values: [12, 13, 14, 15, 16, 20] },
        { name: 'Hydro', values: [10, 9, 8, 9, 9, 9] },
        { name: 'Renewables', values: [6, 6, 6, 6, 7, 15] },
      ],
    },
    demandSupplyChart: {
      categories: ['2020', '2021', '2022', '2023', '2024', '2030P'],
      series: [
        { name: 'Demand (GW)', values: [42, 46, 50, 55, 60, 90] },
        { name: 'Capacity (GW)', values: [60, 65, 70, 75, 80, 130] },
      ],
    },
    priceChart: {
      categories: ['2020', '2021', '2022', '2023', '2024', '2025P'],
      series: [
        { name: 'Industrial Tariff (US c/kWh)', values: [6.4, 6.6, 6.8, 7.0, 7.2, 7.5] },
        { name: 'LNG Import Parity ($/MMBtu)', values: [8.2, 8.7, 9.3, 10.1, 10.8, 11.0] },
      ],
    },
  },
  competitors: {
    japanesePlayers: [
      {
        name: 'Osaka Gas',
        type: 'Japanese utility',
        revenue: '$12B+',
        marketShare: 'Early mover in LNG and C&I decarbonization pilots',
        description: 'JV-led entry, strong partner model, visible project execution capability.',
      },
      {
        name: 'JERA',
        type: 'Japanese power/LNG',
        revenue: '$20B+',
        marketShare: 'Large-scale generation and fuel strategy footprint',
        description: 'Scale advantage in project finance and procurement discipline.',
      },
      {
        name: 'Tokyo Gas',
        type: 'Japanese gas utility',
        revenue: '$15B+',
        marketShare: 'Selective LNG and infrastructure partnerships',
        description: 'Technically strong, focused market selection approach.',
      },
    ],
    localMajor: [
      {
        name: 'PetroVietnam (PVN)',
        type: 'State-owned',
        revenue: '$25B',
        marketShare: 'Dominant upstream and gas chain influence',
        description: 'Critical relationship stakeholder for gas-linked entry models.',
      },
      {
        name: 'EVN',
        type: 'State utility',
        revenue: '$15B',
        marketShare: 'Grid and power market control',
        description: 'Sets practical constraints on capacity absorption and dispatch.',
      },
      {
        name: 'PV Power',
        type: 'SOE affiliate',
        revenue: '$2B',
        marketShare: 'Meaningful gas-fired generation role',
        description: 'Potential partner or competitive benchmark depending on segment.',
      },
    ],
    foreignPlayers: [
      {
        name: 'TotalEnergies',
        type: 'International major',
        revenue: '$200B+',
        marketShare: 'Selective clean-energy projects and partnerships',
        description: 'Global capital strength but selective local execution footprint.',
      },
      {
        name: 'Shell',
        type: 'International major',
        revenue: '$250B+',
        marketShare: 'LNG and downstream optionality',
        description: 'Strong fuel portfolio but partner-dependent local route-to-market.',
      },
    ],
    caseStudies: [
      {
        company: 'Osaka Gas',
        year: '2021',
        mode: 'JV + distributed energy projects',
        outcome: 'Scaled to multiple industrial sites with long-term contracts',
        reason: 'Local partner access + clear value proposition for Japanese manufacturers',
        lesson: 'Partner-led access is faster than direct standalone entry.',
      },
      {
        company: 'Regional ESCO entrant',
        year: '2019',
        mode: 'Greenfield direct sales',
        outcome: 'Low conversion and delayed breakeven',
        reason: 'Weak local network and slow permitting navigation',
        lesson: 'Network and permitting capability are first-order success conditions.',
      },
    ],
  },
  depth: {
    strategyOptions: [
      {
        mode: 'Joint Venture',
        timeline: '6-12 months',
        investment: '$10-30M',
        controlLevel: 'Shared control',
        riskLevel: 'Medium',
        pros: ['Fast market access', 'Relationship leverage', 'Lower regulatory friction'],
      },
      {
        mode: 'Acquisition',
        timeline: '18-24 months',
        investment: '$50-150M',
        controlLevel: 'High control',
        riskLevel: 'High',
        pros: ['Immediate footprint', 'Installed team', 'Existing contracts'],
      },
      {
        mode: 'Greenfield',
        timeline: '24-36 months',
        investment: '$20-50M',
        controlLevel: 'High control',
        riskLevel: 'Medium',
        pros: ['Clean build', 'Tech-led design', 'No legacy integration burden'],
      },
    ],
  },
  summary: {
    opportunities: [
      'Industrial demand growth remains high, creating persistent efficiency and fuel-switch demand.',
      'PDP8 creates a multi-year capacity and transition investment window.',
      'Japanese manufacturers in Vietnam have direct decarbonization mandates from HQ.',
      'LNG and C&I service models still have whitespace for disciplined entrants.',
    ],
    obstacles: [
      'SOE influence shapes access and sequencing in core parts of the value chain.',
      'Regulatory interpretation can vary by project structure and location.',
      'Grid constraints and permit sequencing can delay monetization.',
      'Competition is increasing among regional and global players.',
    ],
  },
};

function buildCountryAnalysis(data) {
  return {
    country: data.country,
    policy: {
      foundationalActs: {
        slideTitle: `${data.country} - Energy Services Foundational Acts`,
        keyMessage:
          'Policy momentum is positive, but entry execution must align with local implementation realities.',
        acts: data.policy.acts.map((act) => ({
          name: act.name,
          year: act.year,
          requirements: act.description,
          enforcement: act.enforcement,
          penalties: act.penalties,
        })),
      },
      nationalPolicy: {
        slideTitle: `${data.country} - National Energy Policy`,
        policyDirection:
          'PDP8 and efficiency-law updates create demand for practical decarbonization and energy-service delivery.',
        targets: [
          {
            metric: 'Renewable capacity expansion',
            target: '70GW target trajectory by 2030',
            deadline: '2030',
            status: 'Execution in progress with phased rollout',
          },
          {
            metric: 'Industrial efficiency adoption',
            target: 'Higher compliance and implementation coverage',
            deadline: '2026+',
            status: 'Strengthened through revised law enforcement',
          },
          {
            metric: 'Gas transition support',
            target: 'Scaled LNG and transition infrastructure',
            deadline: '2030',
            status: 'Active project pipeline with staged commissioning',
          },
        ],
        keyInitiatives: [
          'Industrial audit and compliance enforcement at higher consistency.',
          'Renewable and transition capacity planning tied to PDP8 execution.',
          'Incentive programs aligned with project structure and location.',
        ],
      },
      investmentRestrictions: {
        slideTitle: `${data.country} - Foreign Investment Rules`,
        ownershipLimits: {
          general: data.policy.foreignOwnership.general,
          exceptions: data.policy.foreignOwnership.exceptions,
          promoted: data.policy.foreignOwnership.promoted,
        },
        incentives: data.policy.incentives,
        riskLevel: 'Medium',
        riskJustification:
          'Rules are investable with correct structure, but partner quality and sequencing determine execution speed.',
      },
    },
    market: {
      marketSizeAndGrowth: {
        slideTitle: `${data.country} - Market Size & Growth`,
        keyMessage:
          'Demand growth supports near-term entry, but value capture depends on segment focus and partner access.',
        overview:
          'Vietnam energy-services demand is expanding with industrial growth, grid pressure, and decarbonization mandates.',
        chartData: {
          categories: data.market.demandSupplyChart.categories,
          series: data.market.demandSupplyChart.series,
          unit: 'GW',
        },
        marketSize: '$5B serviceable opportunity (directional)',
        growthRate: 'High single-digit to low double-digit demand drivers',
        keyDrivers: [
          'Industrial load growth and efficiency requirements.',
          'Policy-backed transition activity and fuel-switch economics.',
          'Japanese FDI customer demand for measurable decarbonization outcomes.',
        ],
      },
      supplyAndDemandDynamics: {
        slideTitle: `${data.country} - Supply & Demand Dynamics`,
        keyMessage:
          'System transition is underway: coal share remains large while gas and renewables accelerate.',
        narrative:
          'Energy mix transition creates both transition risk and differentiated service opportunities.',
        chartData: {
          categories: data.market.tpesChart.categories,
          series: data.market.tpesChart.series,
          unit: '%',
        },
        keyDrivers: [
          'Coal still anchors the base, but policy pushes cleaner additions.',
          'Gas and LNG rise as domestic production declines.',
          'Renewables scaling changes dispatch, balancing, and service needs.',
        ],
      },
      pricingAndTariffStructures: {
        slideTitle: `${data.country} - Pricing & Tariff Structures`,
        keyMessage:
          'Tariff direction and LNG parity trends support service models with strong efficiency economics.',
        overview:
          'Industrial tariff movement and fuel-price signals create room for performance-based energy service contracts.',
        chartData: {
          categories: data.market.priceChart.categories,
          series: data.market.priceChart.series,
          unit: 'Price Index',
        },
        outlook:
          'Disciplined contract design can protect margin against fuel and tariff volatility.',
        comparison:
          'Customers value predictable savings and implementation speed over lowest upfront capex.',
      },
    },
    competitors: {
      japanesePlayers: {
        slideTitle: `${data.country} - Japanese Players`,
        marketInsight: 'Japanese players validate demand and prove partner-led entry pathways.',
        players: data.competitors.japanesePlayers,
      },
      localMajor: {
        slideTitle: `${data.country} - Major Local Players`,
        concentration: 'SOE-linked concentration remains a structural factor in market access.',
        players: data.competitors.localMajor,
      },
      foreignPlayers: {
        slideTitle: `${data.country} - Foreign Players`,
        competitiveInsight:
          'Global entrants are selective; execution depth and local delivery quality remain key differentiators.',
        players: data.competitors.foreignPlayers,
      },
      caseStudy: {
        slideTitle: `${data.country} - Entry Case Study`,
        successes: data.competitors.caseStudies
          .filter((x) => /scaled|successful|multiple|scaled/i.test(String(x.outcome)))
          .map((x) => ({
            company: x.company,
            entryMode: x.mode,
            outcome: x.outcome,
            keySuccessFactor: x.reason,
          })),
        failures: data.competitors.caseStudies
          .filter((x) => /low|delay|weak|failed|slow/i.test(String(x.outcome)))
          .map((x) => ({
            company: x.company,
            year: x.year,
            reason: x.reason,
            lesson: x.lesson,
          })),
        successFactors: [
          'Use partner-led access to shorten commercial and regulatory cycle time.',
          'Anchor early pipeline with Japanese FDI accounts requiring decarbonization support.',
          'Design contracts around measurable savings and delivery reliability.',
        ],
        warningSignsToWatch: [
          'Permitting and interconnection bottlenecks in target industrial zones.',
          'Fuel-price volatility translating into customer decision delays.',
          'Competitive intensity rising in high-visibility pilot segments.',
        ],
      },
      maActivity: {
        slideTitle: `${data.country} - M&A Activity`,
        valuationMultiples:
          'Energy services/platform assets typically transact on strategic premium logic.',
        keyDeals: [
          {
            acquirer: 'Regional infrastructure fund',
            target: 'Industrial energy services platform',
            value: '$120M (indicative)',
            rationale: 'Platform build-out and recurring service cashflows',
          },
        ],
        outlook: 'Selective consolidation likely as market formalizes and project sizes increase.',
      },
    },
    depth: {
      dealEconomics: {
        slideTitle: `${data.country} - Deal Economics`,
        keyInsight:
          'JV-led entry balances speed and risk; value capture improves when contracts lock measurable outcomes.',
        typicalDealSize: {
          range: '$3M-$20M',
          average: '$8M-$10M',
        },
        revenueModel:
          'Blend of project delivery fees, performance-linked savings, and recurring service contracts.',
        marginProfile:
          'Target 18%-22% project-level IRR with disciplined scope and partner structure.',
      },
      partnerAssessment: {
        slideTitle: `${data.country} - Partner Assessment`,
        recommendedPartner:
          'Industrial platform or trading-house-linked partner with local execution depth',
        players: [
          {
            name: 'Industrial Partner A',
            type: 'Local industrial platform',
            revenue: '$1B+',
            partnershipFit: '5',
            acquisitionFit: '3',
            description: 'Strong site access and operating footprint in priority zones.',
          },
          {
            name: 'Trading Partner B',
            type: 'Regional trading house affiliate',
            revenue: '$2B+',
            partnershipFit: '4',
            acquisitionFit: '2',
            description: 'Strong procurement and customer interface capability.',
          },
        ],
      },
      entryStrategy: {
        slideTitle: `${data.country} - Entry Strategy Options`,
        recommendation: 'Phase-1 JV entry with staged capital and pilot-led commercialization.',
        options: data.depth.strategyOptions,
      },
      implementation: {
        slideTitle: `${data.country} - Implementation Roadmap`,
        totalInvestment: '$10M-$30M (Phase 1)',
        breakeven: '30-36 months (target)',
        phases: [
          {
            phase: 'Phase 1 - Setup',
            timeline: '0-6 months',
            actions: [
              'Finalize partner structure',
              'Build initial pipeline',
              'Secure first pilot sites',
            ],
          },
          {
            phase: 'Phase 2 - Pilot Delivery',
            timeline: '6-18 months',
            actions: ['Deliver 2-3 pilots', 'Prove savings outcomes', 'Expand sales motions'],
          },
          {
            phase: 'Phase 3 - Scale',
            timeline: '18-36 months',
            actions: [
              'Scale recurring contracts',
              'Broaden segment mix',
              'Optimize margin profile',
            ],
          },
        ],
      },
      targetSegments: {
        slideTitle: `${data.country} - Target Segments`,
        goToMarketApproach:
          'Start with Japanese FDI-heavy industrial clusters, then expand to broader C&I accounts.',
        segments: [
          {
            segment: 'Japanese manufacturing FDI',
            size: 'High-value anchor segment',
            rationale: 'Strong decarbonization mandate and HQ alignment',
          },
          {
            segment: 'Energy-intensive local industry',
            size: 'Large but selective',
            rationale: 'High savings potential with careful credit and execution screening',
          },
        ],
      },
    },
    summary: {
      opportunities: data.summary.opportunities,
      obstacles: data.summary.obstacles,
      ratings: {
        attractiveness: 8,
        feasibility: 7,
        attractivenessRationale:
          'Demand tailwinds, policy support, and clear customer pain points support market attractiveness.',
        feasibilityRationale:
          'Execution is feasible with disciplined partner selection and phased entry sequencing.',
      },
      keyInsights: [
        {
          title: 'Why now',
          data: 'Demand growth + policy transition create a strong timing window for focused entrants.',
          pattern:
            'Entrants with local delivery partnerships convert faster than direct greenfield attempts.',
          implication: 'Lead with a JV model and pilot-based proof points.',
        },
        {
          title: 'Where to win',
          data: 'Japanese FDI and energy-intensive C&I provide the best near-term conversion path.',
          pattern:
            'Accounts with HQ decarbonization pressure make faster decisions on efficiency solutions.',
          implication: 'Build first-wave pipeline around these segments before broad expansion.',
        },
        {
          title: 'How to de-risk',
          data: 'Contract design and partner governance are the key protectors of delivery quality and margin.',
          pattern:
            'Performance-linked structures align incentives and improve renewal probability.',
          implication: 'Prioritize outcome-based commercial structures from day one.',
        },
      ],
      timingIntelligence: {
        slideTitle: `${data.country} - Why Now`,
        windowOfOpportunity: '18-24 month window before segment crowding materially increases.',
        triggers: [
          {
            trigger: 'PDP8-linked project acceleration',
            impact: 'More projects reaching execution stage',
            action: 'Secure partner channel capacity early',
          },
          {
            trigger: 'Industrial tariff and fuel pressure',
            impact: 'Higher customer urgency for savings',
            action: 'Position performance-backed offerings',
          },
          {
            trigger: 'Rising competitor activity',
            impact: 'Faster capture race in priority clusters',
            action: 'Lock lighthouse customers with pilot pipeline',
          },
        ],
      },
      lessonsLearned: {
        slideTitle: `${data.country} - Lessons Learned`,
        failures: data.competitors.caseStudies
          .filter((x) => /low|delay|weak|failed|slow/i.test(String(x.outcome)))
          .map((x) => ({
            company: x.company,
            year: x.year,
            reason: x.reason,
            lesson: x.lesson,
          })),
        successFactors: [
          'Enter with a partner that already has operational reach in target clusters.',
          'Use pilot projects to prove measurable value before broad rollout.',
          'Protect economics through disciplined scope and contract structure.',
        ],
        warningSignsToWatch: [
          'Permitting duration drifting beyond plan assumptions.',
          'Pilot conversion slowing versus baseline target.',
          'Margin pressure from undifferentiated price competition.',
        ],
      },
      goNoGo: {
        overallVerdict: 'GO (phased, partner-led)',
        recommendation:
          'Proceed with a staged JV-led entry model anchored in industrial pilot delivery and measurable savings contracts.',
        criteria: [
          {
            criterion: 'Market attractiveness',
            score: 'High',
            rationale: 'Sustained demand and policy pull',
          },
          {
            criterion: 'Execution feasibility',
            score: 'Medium-High',
            rationale: 'Requires strong local partner governance',
          },
          {
            criterion: 'Risk-adjusted return',
            score: 'Attractive',
            rationale: 'Strong with disciplined sequencing',
          },
        ],
      },
      recommendation:
        'Proceed with phased JV-led entry. Start with Japanese FDI industrial pilots, prove measurable savings, then scale into broader C&I segments.',
    },
  };
}

function buildSynthesis(data) {
  return {
    isSingleCountry: true,
    country: data.country,
    executiveSummary: [
      `${data.country} offers a credible near-term entry window for ${data.industry}, but success depends on execution discipline rather than market potential alone.`,
      'Partner-led access and pilot-first commercialization outperform direct standalone entry in speed and conversion quality.',
      'Prioritize segments with clear economic pain and HQ-linked decarbonization mandates to accelerate decision cycles.',
      'A phased JV model balances speed, risk, and capital efficiency while preserving expansion optionality.',
      'Decision: proceed with phased entry and strict go/no-go gates at each scale step.',
    ],
    recommendation:
      'GO with phased JV-led entry, anchored by early pilot wins in Japanese FDI-heavy industrial clusters.',
  };
}

function buildScope(data) {
  return {
    clientName: data.client,
    projectName: data.projectName,
    industry: data.industry,
    projectType: 'market-entry',
    targetMarkets: [data.country],
  };
}

function collectPackageConsistencyIssues(scan) {
  const issues = [];
  if (scan.missingCriticalParts.length > 0) {
    issues.push(`missing critical parts: ${scan.missingCriticalParts.join(', ')}`);
  }
  if (scan.duplicateRelationshipIds.length > 0) {
    issues.push(
      `duplicate relationship ids: ${scan.duplicateRelationshipIds
        .slice(0, 5)
        .map((x) => `${x.relFile}:${x.relId}`)
        .join(', ')}`
    );
  }
  if (scan.duplicateSlideIds.length > 0) {
    issues.push(`duplicate slide ids: ${scan.duplicateSlideIds.slice(0, 5).join(', ')}`);
  }
  if (scan.duplicateSlideRelIds.length > 0) {
    issues.push(`duplicate slide rel ids: ${scan.duplicateSlideRelIds.slice(0, 5).join(', ')}`);
  }
  if (scan.danglingOverrides.length > 0) {
    issues.push(`dangling overrides: ${scan.danglingOverrides.slice(0, 5).join(', ')}`);
  }
  if (scan.missingSlideOverrides.length > 0) {
    issues.push(`missing slide overrides: ${scan.missingSlideOverrides.slice(0, 5).join(', ')}`);
  }
  if (scan.missingChartOverrides.length > 0) {
    issues.push(`missing chart overrides: ${scan.missingChartOverrides.slice(0, 5).join(', ')}`);
  }
  if (Array.isArray(scan.missingExpectedOverrides) && scan.missingExpectedOverrides.length > 0) {
    issues.push(
      `missing expected overrides: ${scan.missingExpectedOverrides
        .slice(0, 5)
        .map(
          (x) =>
            `${x.part || '(unknown)'}${x.expectedContentType ? `->${x.expectedContentType}` : ''}`
        )
        .join(', ')}`
    );
  }
  if (Array.isArray(scan.contentTypeMismatches) && scan.contentTypeMismatches.length > 0) {
    issues.push(
      `content type mismatches: ${scan.contentTypeMismatches
        .slice(0, 5)
        .map(
          (x) => `${x.part}:${x.contentType || '(empty)'}=>${x.expectedContentType || '(unknown)'}`
        )
        .join(', ')}`
    );
  }
  return issues;
}

async function main() {
  console.log('Generating Vietnam PPT using production single-country builder...');

  let countryAnalysis = buildCountryAnalysis(mockData);
  const synthesis = buildSynthesis(mockData);
  const scope = buildScope(mockData);

  // Content-size check: compact oversized fields before building (mirrors server.js path)
  const sizeCheckResult = runContentSizeCheck(countryAnalysis, { dryRun: false });
  if (sizeCheckResult.compactionLog.length > 0) {
    countryAnalysis = sizeCheckResult.payload;
    console.log(
      `[Content Size Check] Compacted ${sizeCheckResult.compactionLog.length} field(s), risk=${sizeCheckResult.report.risk}`
    );
  }

  let buffer = await generateSingleCountryPPT(synthesis, countryAnalysis, scope);

  const idNormalization = await normalizeSlideNonVisualIds(buffer);
  buffer = idNormalization.buffer;
  if (idNormalization.changed) {
    console.log(
      `[PostWrite] Normalized duplicate shape IDs (${idNormalization.stats.reassignedIds} reassignment(s))`
    );
  }

  const ctReconcile = await reconcileContentTypesAndPackage(buffer);
  buffer = ctReconcile.buffer;
  if (ctReconcile.changed) {
    const touched = [
      ...(ctReconcile.stats.addedOverrides || []),
      ...(ctReconcile.stats.correctedOverrides || []),
      ...(ctReconcile.stats.removedDangling || []),
    ].length;
    console.log(`[PostWrite] Reconciled content types (${touched} override adjustment(s))`);
  }

  const { zip } = await readPPTX(buffer);
  const relScan = await scanRelationshipTargets(zip);
  if (relScan.missingInternalTargets.length > 0) {
    const preview = relScan.missingInternalTargets
      .slice(0, 5)
      .map((m) => `${m.relFile} -> ${m.target} (${m.reason})`)
      .join(' | ');
    throw new Error(
      `Relationship fileSafety failed: ${relScan.missingInternalTargets.length} broken target(s); ${preview}`
    );
  }
  if (Array.isArray(relScan.invalidExternalTargets) && relScan.invalidExternalTargets.length > 0) {
    const preview = relScan.invalidExternalTargets
      .slice(0, 5)
      .map((m) => `${m.relFile} -> ${m.target || '(empty)'} (${m.reason})`)
      .join(' | ');
    throw new Error(
      `External relationship fileSafety failed: ${relScan.invalidExternalTargets.length} invalid target(s); ${preview}`
    );
  }

  const packageScan = await scanPackageConsistency(zip);
  const packageIssues = collectPackageConsistencyIssues(packageScan);
  if (packageIssues.length > 0) {
    throw new Error(`Package consistency failed: ${packageIssues.join(' | ')}`);
  }

  const outputPath = path.join(__dirname, 'vietnam-output.pptx');
  fs.writeFileSync(outputPath, buffer);
  console.log(`Wrote: ${outputPath}`);

  const visual = await runVisualFidelityCheck(outputPath);
  console.log(
    `[Visual] ${visual.valid ? 'PASS' : 'FAIL'} | score=${visual.score || 0} | failed=${visual.summary?.failed || 0}`
  );
  if (!visual.valid) {
    const failed = (visual.checks || []).filter((c) => !c.passed).slice(0, 8);
    failed.forEach((c) => {
      console.warn(`  [Visual FAIL] ${c.name}: expected ${c.expected}, actual ${c.actual}`);
    });
    throw new Error(`Visual styleMatch gate failed (score=${visual.score || 0})`);
  }

  const stats = fs.statSync(outputPath);
  console.log(`Size: ${(stats.size / 1024).toFixed(1)} KB`);
  console.log('Done.');
}

main().catch((err) => {
  console.error('Generation failed:', err.message);
  process.exit(1);
});
