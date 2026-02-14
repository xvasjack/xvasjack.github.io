'use strict';

const { generateSingleCountryPPT } = require('./ppt-single-country');
const { runBudgetGate } = require('./budget-gate');
const { isTransientKey } = require('./transient-key-sanitizer');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

// ============ SEEDED PRNG (mulberry32) ============

function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============ BASE PAYLOAD ============

function buildBasePayload() {
  const policy = {
    foundationalActs: {
      slideTitle: 'Test Country - Foundational Acts',
      keyMessage:
        'Regulatory framework supports industry investment with clear enforcement mechanisms',
      acts: [
        {
          name: 'Primary Industry Act',
          year: '2015 (amended 2020)',
          requirements:
            'Designated facilities must comply with operational standards and submit annual reports',
          enforcement:
            'Department of Industry conducts annual audits with mandatory compliance deadlines',
          penalties:
            'Fines up to 500,000 for non-compliance; operational shutdown orders for repeat violations',
        },
        {
          name: 'Secondary Industry Act',
          year: '2018',
          requirements:
            'Licensing framework for service providers including technical standards for equipment and performance contracting',
          enforcement:
            'Regulatory Commission oversees licensing and compliance, annual performance reviews',
          penalties:
            'License revocation and fines up to 1,000,000; criminal liability for safety violations',
        },
        {
          name: 'Building Standards Code',
          year: '2010 (updated 2022)',
          requirements:
            'New commercial buildings over 2,000 sqm must meet minimum performance standards',
          enforcement:
            'Local building authorities verify compliance during construction permits and occupancy approvals',
          penalties:
            'Construction permit denial; mandatory retrofit within 2 years of non-compliance finding',
        },
      ],
    },
    nationalPolicy: {
      slideTitle: 'Test Country - National Policy',
      policyDirection:
        'Test Country targets 30% improvement by 2036 under the National Development Plan',
      targets: [
        {
          metric: 'Efficiency Improvement',
          target: '30% reduction from 2010 baseline',
          deadline: '2036',
          status: 'On track - 18% achieved by 2023',
        },
        {
          metric: 'Renewable Share',
          target: '30% of final consumption',
          deadline: '2036',
          status: 'Progress - 15.5% as of 2023',
        },
        {
          metric: 'Technology Adoption',
          target: '30% of new installations',
          deadline: '2030',
          status: 'Behind - currently at 12%',
        },
        {
          metric: 'Carbon Neutrality',
          target: 'Net zero emissions',
          deadline: '2065',
          status: 'Roadmap published Q3 2023',
        },
      ],
      keyInitiatives: [
        'Smart Infrastructure Development Program with 15.6B investment',
        'Circular Economy Model integrating sustainable strategies',
        'Regulatory Sandbox for innovative pilot projects',
        'Industry 4.0 digitalization incentives',
      ],
    },
    investmentRestrictions: {
      slideTitle: 'Test Country - Foreign Investment Rules',
      ownershipLimits: {
        general: '49% foreign ownership cap under Foreign Business Act',
        exceptions:
          'Promoted projects may receive 100% foreign ownership; special treaties allow majority ownership',
        promoted: '100% under special zone incentives',
      },
      incentives: [
        {
          name: 'Industry Promotion Scheme',
          benefit: '8-year corporate tax exemption, import duty waivers on equipment',
          eligibility: 'Projects with minimum 50M investment in relevant technology',
        },
        {
          name: 'Special Economic Zone',
          benefit: 'Enhanced tax holidays up to 13 years, long-term land lease',
          eligibility: 'Operations located in designated economic zones',
        },
        {
          name: 'Green Finance Incentives',
          benefit: 'Withholding tax exemption on green bond interest payments',
          eligibility: 'Certified green projects per national green framework',
        },
      ],
      riskLevel: 'Medium-Low',
      riskJustification:
        'Stable regulatory environment with established framework; main risks are bureaucratic delays and periodic policy shifts during government transitions',
    },
  };

  const market = {
    tpes: {
      slideTitle: 'Test Country - Total Primary Supply',
      keyInsight: 'Primary supply growing steadily with diversification trend',
      narrative: 'Total primary supply reached 137 units in 2023, growing 2.1% YoY',
      chartData: {
        categories: ['2019', '2020', '2021', '2022', '2023'],
        series: [
          { name: 'Category A', values: [53.2, 48.7, 50.1, 52.8, 53.4] },
          { name: 'Category B', values: [41.3, 36.2, 38.5, 40.1, 41.8] },
          { name: 'Category C', values: [18.5, 16.8, 17.2, 17.9, 18.1] },
          { name: 'Category D', values: [11.2, 12.5, 13.8, 15.2, 16.4] },
        ],
        unit: 'Units',
      },
      structuredData: {
        marketBreakdown: {
          totalPrimarySupply: { categoryAPercent: '39%', categoryDPercent: '12%' },
        },
      },
    },
    finalDemand: {
      slideTitle: 'Test Country - Final Demand',
      keyInsight: 'Industry accounts for 37% of final demand, presenting largest opportunity',
      chartData: {
        categories: ['2019', '2020', '2021', '2022', '2023'],
        series: [
          { name: 'Industry', values: [32.1, 29.5, 31.2, 33.8, 35.4] },
          { name: 'Transport', values: [27.8, 22.1, 24.5, 26.9, 28.2] },
          { name: 'Commercial', values: [12.5, 10.8, 11.9, 13.1, 13.8] },
          { name: 'Residential', values: [8.9, 9.2, 9.1, 9.3, 9.5] },
        ],
        unit: 'Units',
      },
      keyDrivers: [
        'Manufacturing sector expansion driving industrial demand',
        'Technology adoption reducing transport consumption',
      ],
      structuredData: {
        marketBreakdown: {
          totalFinalConsumption: { industryPercent: '37%', transportPercent: '29%' },
        },
      },
    },
    electricity: {
      slideTitle: 'Test Country - Electricity & Power',
      keyInsight: 'Peak demand growing 3.2% annually; capacity additions accelerating',
      demandGrowth: '3.2% CAGR 2020-2023',
      totalCapacity: '53.7 GW installed (2023)',
      keyTrend: 'Rapid deployment with 4.2 GW added in 2022-2023',
      chartData: {
        categories: ['2019', '2020', '2021', '2022', '2023'],
        series: [
          { name: 'Source A', values: [62.5, 58.3, 60.1, 59.2, 57.8] },
          { name: 'Source B', values: [18.2, 17.5, 17.8, 16.9, 15.8] },
          { name: 'Source C', values: [10.8, 14.2, 15.5, 17.8, 20.1] },
          { name: 'Imports', values: [8.5, 10.0, 6.6, 6.1, 6.3] },
        ],
        unit: '%',
      },
      structuredData: {
        marketBreakdown: {
          generation: { current: '210 TWh (2023)', projected2030: '280 TWh' },
        },
      },
    },
    gasLng: {
      slideTitle: 'Test Country - Gas & LNG Market',
      keyInsight:
        'Domestic production declining 5% annually; imports surging to fill 35% of demand',
      pipelineNetwork: '4,200 km transmission network; capacity constraints in southern corridor',
      chartData: {
        categories: ['2019', '2020', '2021', '2022', '2023'],
        series: [
          { name: 'Domestic Production', values: [36.2, 33.5, 31.8, 30.1, 28.5] },
          { name: 'LNG Imports', values: [8.5, 7.2, 10.8, 13.5, 16.2] },
          { name: 'Pipeline Imports', values: [10.1, 9.8, 10.2, 10.5, 10.8] },
        ],
        unit: 'bcm',
      },
      lngTerminals: [
        { name: 'Terminal Alpha', capacity: '11.5 MTPA', utilization: '78%' },
        { name: 'Terminal Beta', capacity: '7.5 MTPA', utilization: '42%' },
      ],
      structuredData: {
        infrastructureCapacity: {
          importCurrent: '19 MTPA',
          importPlanned: '24 MTPA by 2027',
          pipelineCapacity: '4,500 MMscfd',
        },
      },
    },
    pricing: {
      slideTitle: 'Test Country - Pricing',
      keyInsight:
        'Industrial rates rising 12% in 2023; creates strong ROI case for efficiency investments',
      outlook: 'Tariff increases expected to continue through 2026',
      comparison: 'Mid-range for the region — 15% above neighbor A, 8% below neighbor B',
      chartData: {
        categories: ['2019', '2020', '2021', '2022', '2023'],
        series: [
          { name: 'Industrial Rate', values: [3.12, 2.98, 3.21, 3.58, 4.01] },
          { name: 'Commercial Rate', values: [3.85, 3.72, 3.95, 4.32, 4.78] },
          { name: 'Residential Rate', values: [2.95, 2.88, 3.05, 3.38, 3.72] },
        ],
        unit: 'Currency/kWh',
      },
      structuredData: {
        priceComparison: {
          generationCost: '2.85/kWh',
          retailPrice: '4.01/kWh (industrial)',
          industrialRate: '4.01/kWh',
        },
      },
    },
    escoMarket: {
      slideTitle: 'Test Country - Services Market',
      keyInsight: 'Market growing 15% annually; government mandates drive 40% of current projects',
      marketSize: '8.5 billion (2023)',
      growthRate: '15% CAGR 2020-2023',
      keyDrivers: 'Rising costs and regulatory expectations driving adoption',
      chartData: {
        categories: ['2019', '2020', '2021', '2022', '2023'],
        series: [
          { name: 'Government', values: [1.8, 1.5, 2.1, 2.8, 3.4] },
          { name: 'Industrial', values: [1.2, 1.0, 1.4, 1.9, 2.5] },
          { name: 'Commercial', values: [0.8, 0.6, 0.9, 1.2, 1.6] },
          { name: 'Residential', values: [0.3, 0.2, 0.4, 0.5, 0.7] },
        ],
        unit: 'Billion',
      },
      segments: [
        { name: 'Segment A - Optimization', size: '3.2B', share: '38%' },
        { name: 'Segment B - Process', size: '2.5B', share: '29%' },
        { name: 'Segment C - Systems', size: '1.8B', share: '21%' },
        { name: 'Segment D - Integration', size: '1.0B', share: '12%' },
      ],
      structuredData: {
        marketState: {
          registeredProviders: '45 registered providers',
          totalProjects: '1,200+ completed projects',
        },
      },
    },
  };

  const competitors = {
    japanesePlayers: {
      slideTitle: 'Test Country - Japanese Companies',
      marketInsight:
        'Japanese firms hold 22% of industrial market through long-term relationships with manufacturers',
      players: [
        {
          name: 'Japan Corp Alpha',
          presence: 'Since 1990, 3 facilities',
          description:
            'Leading provider with 12.5B revenue. Controls 28% of commercial market through integrated management solutions. Annual growth of 8% driven by modernization projects.',
          entryYear: '1990',
          revenue: '12.5B',
          strategicAssessment:
            'Strong position in OEM segment but limited penetration in locally-owned facilities; partnership opportunity for local market access',
        },
        {
          name: 'Japan Corp Beta',
          presence: 'Since 2001, 2 offices',
          description:
            'Grid modernization and management specialist with 4.2B revenue. Focuses on power quality and distribution solutions. Revenue grew 15% in 2023.',
          entryYear: '2001',
          revenue: '4.2B',
          strategicAssessment:
            'Technology leader but premium pricing limits SME market access; acquisition target for broader coverage',
        },
        {
          name: 'Japan Corp Gamma',
          presence: 'Since 1988, regional hub',
          description:
            'Diversified solutions including generation, storage, and building management with 3.8B revenue. Serves both commercial and industrial facilities with IoT-based monitoring.',
          entryYear: '1988',
          revenue: '3.8B',
        },
      ],
    },
    localMajor: {
      slideTitle: 'Test Country - Major Local Players',
      concentration: 'Top 5 local players hold 45% of domestic market',
      players: [
        {
          name: 'Local Corp Alpha',
          type: 'Listed company',
          revenue: '8.2B',
          marketShare: '15%',
          description:
            'Largest local player by project count with 300+ completed contracts across government and industrial segments. Revenue grew 22% YoY.',
          strategicAssessment:
            'Market leader with government relationships but limited technical depth; JV partner candidate for technology transfer',
        },
        {
          name: 'Local Corp Beta',
          type: 'Listed conglomerate',
          revenue: '15.1B',
          marketShare: '8%',
          description:
            'Diversified group expanding into services from existing base. Total revenue 15.1B with services segment growing 35%.',
          strategicAssessment:
            'Financial strength and existing customer base create cross-sell opportunities; services division still nascent',
        },
        {
          name: 'Local Corp Gamma',
          type: 'Engineering contractor',
          revenue: '6.8B',
          marketShare: '10%',
          description:
            'Engineering-led operator with deep technical capabilities. 6.8B revenue with 10% market share. Strong execution with 95% completion rate.',
          strategicAssessment:
            'Best technical execution among local players; potential acquisition target valued at 8-10x EBITDA',
        },
      ],
    },
    foreignPlayers: {
      slideTitle: 'Test Country - Foreign Companies',
      competitiveInsight:
        'European players dominate technical consulting while Asian firms compete on price in equipment-led projects',
      players: [
        {
          name: 'Foreign Corp Alpha',
          origin: 'France',
          mode: 'Wholly-owned subsidiary',
          entryYear: '1998',
          revenue: '9.8B',
          description:
            'Market leader in building management and automation with 9.8B revenue. Platform deployed in 500+ buildings. Recent focus on data center optimization.',
          strategicAssessment:
            'Dominant technology position but high-cost structure limits addressable market; partnership model preferred',
        },
        {
          name: 'Foreign Corp Beta',
          origin: 'Germany',
          mode: 'Joint venture with local partner',
          entryYear: '2005',
          revenue: '5.5B',
          description:
            'Infrastructure services and grid solutions specialist with growing services division. 5.5B revenue with 18% growth in digital services.',
          strategicAssessment:
            'Strong in heavy industry; limited presence in commercial segment creates complementary partnership potential',
        },
        {
          name: 'Foreign Corp Gamma',
          origin: 'South Korea',
          mode: 'Branch office',
          entryYear: '2015',
          revenue: '2.1B',
          description:
            'Aggressive expansion in smart building and project development. 2.1B revenue growing 28% annually. Won 3 major government contracts in 2023.',
          strategicAssessment:
            'Fast-growing with technology advantages; price-competitive but limited local team constrains delivery capacity',
        },
      ],
    },
    caseStudy: {
      slideTitle: 'Test Country - Market Entry Case Study',
      company: 'Global Services Corp',
      entryYear: '2010',
      entryMode: 'Acquisition of local utility',
      investment: 'USD 180M total (USD 120M acquisition + USD 60M expansion)',
      outcome:
        'Achieved profitability by Year 3 with 4.2B revenue by 2023. Successfully expanded from initial service into broader management, winning 15 major contracts.',
      applicability:
        'Demonstrates acquisition-led entry can accelerate market access; local talent retention critical for relationship-driven market',
      keyLessons: [
        'Retain local management — business relationships are personal and non-transferable',
        'Start with adjacent service to build trust before cross-selling',
        'Government contracts provide stable base revenue but private sector delivers higher margins',
        'Incentive programs should be structured early for maximum benefit',
      ],
    },
    maActivity: {
      slideTitle: 'Test Country - M&A Activity',
      valuationMultiples: '8-12x EBITDA for services companies; 6-8x for traditional contractors',
      recentDeals: [
        {
          year: '2023',
          buyer: 'Acquirer Alpha',
          target: 'Target Services Inc',
          value: '2.8B',
          rationale: 'Vertical integration into services',
        },
        {
          year: '2022',
          buyer: 'Acquirer Beta',
          target: 'Service Pro Corp',
          value: '1.5B',
          rationale: 'Expand downstream management',
        },
        {
          year: '2023',
          buyer: 'Acquirer Gamma',
          target: 'Smart Solutions Ltd',
          value: '950M',
          rationale: 'Grid modernization capabilities',
        },
      ],
      potentialTargets: [
        {
          name: 'Target Alpha',
          estimatedValue: '800M-1.2B',
          rationale: 'Largest independent provider with government contract portfolio',
          timing: '2025-2026 — founder approaching retirement',
        },
        {
          name: 'Target Beta',
          estimatedValue: '400-600M',
          rationale: 'Leading commercial provider with smart building IP',
          timing: '2025 — Series B fundraising expected',
        },
        {
          name: 'Target Gamma',
          estimatedValue: '600-900M',
          rationale: 'Industrial optimization specialist with proprietary monitoring tech',
          timing: '2026 — 3-year lock-up expiring',
        },
      ],
    },
  };

  const depth = {
    dealEconomics: {
      slideTitle: 'Test Country - Deal Economics',
      keyInsight:
        'Average deal size 25M with 18-22% IRR; payback under 4 years makes market among most attractive in region',
      typicalDealSize: { min: '5M', max: '80M', average: '25M' },
      contractTerms: {
        duration: '5-10 years',
        revenueSplit: '70/30 provider/client in years 1-3, transitioning to 50/50',
        guaranteeStructure: 'Minimum 15% savings guarantee with penalty clause',
      },
      financials: {
        paybackPeriod: '3.2 years average',
        irr: '18-22%',
        marginProfile: 'Gross margin 35-42%, improving with scale',
      },
      financingOptions: [
        'Self-financing with balance sheet (most common for deals under 20M)',
        'Third-party financing through commercial banks at 5.5-7% interest rates',
        'Green bonds and sustainability-linked loans with 50-75 bps discount',
      ],
    },
    partnerAssessment: {
      slideTitle: 'Test Country - Partner Assessment',
      recommendedPartner: 'Partner Alpha — best combination of market access and cultural fit',
      partners: [
        {
          name: 'Partner Alpha',
          type: 'Listed services company',
          revenue: '9.1B',
          partnershipFit: 4,
          acquisitionFit: 3,
          estimatedValuation: '14-18B (listed)',
          description:
            'Subsidiary focused on clean solutions with 250+ commercial projects and strong regulatory relationships. Listed with 9.1B revenue. Culture fit is high.',
        },
        {
          name: 'Partner Beta',
          type: 'Industrial utilities provider',
          revenue: '7.5B',
          partnershipFit: 3,
          acquisitionFit: 4,
          estimatedValuation: '9-12B',
          description:
            'Leading industrial estate utilities provider with 95% uptime record. 7.5B revenue with proven delivery. Technical team of 200+ engineers.',
        },
        {
          name: 'Partner Gamma',
          type: 'Private services firm',
          revenue: '2.8B',
          partnershipFit: 5,
          acquisitionFit: 5,
          estimatedValuation: '900M-1.4B',
          description:
            'Leading independent firm with 15-year track record and government contract portfolio worth 2.0B annually. Founder approaching retirement creates acquisition window.',
        },
      ],
    },
    entryStrategy: {
      slideTitle: 'Test Country - Entry Strategy Options',
      recommendation:
        'Joint Venture with local partner recommended — balances speed-to-market with risk management',
      options: [
        {
          mode: 'Joint Venture',
          timeline: '6-12 months to operational',
          investment: 'USD 15-25M',
          controlLevel: 'Shared (51/49 or 49/51)',
          riskLevel: 'Medium',
          pros: [
            'Immediate local market access',
            'Shared regulatory burden',
            'Local talent and relationships',
            'Lower initial capital requirement',
          ],
          cons: [
            'Shared decision-making',
            'Potential culture clashes',
            'Complex exit mechanisms',
            'Profit sharing reduces returns',
          ],
        },
        {
          mode: 'Acquisition',
          timeline: '12-18 months to close + integrate',
          investment: 'USD 30-50M',
          controlLevel: 'Full',
          riskLevel: 'Medium-High',
          pros: [
            'Full control of operations',
            'Immediate revenue stream',
            'Existing customer base',
            'Faster scale than greenfield',
          ],
          cons: [
            'High upfront capital',
            'Integration risk',
            'Cultural integration challenges',
            'Premium valuation in current market',
          ],
        },
        {
          mode: 'Greenfield',
          timeline: '18-24 months to first project',
          investment: 'USD 8-15M',
          controlLevel: 'Full',
          riskLevel: 'High',
          pros: [
            'Full control from day one',
            'Build culture from scratch',
            'Choose optimal location',
            'No legacy issues',
          ],
          cons: [
            'Slow market entry',
            'No existing relationships',
            'Must build team from scratch',
            'Higher risk of failure',
          ],
        },
      ],
      harveyBalls: {
        criteria: [
          'Speed to Market',
          'Investment Required',
          'Market Access',
          'Risk Level',
          'Control',
        ],
        jv: [4, 3, 5, 3, 2],
        acquisition: [3, 1, 4, 2, 5],
        greenfield: [1, 4, 1, 1, 5],
      },
    },
    implementation: {
      slideTitle: 'Test Country - Implementation Roadmap',
      totalInvestment: 'USD 20-35M over 3 years',
      breakeven: '30-36 months from market entry',
      phases: [
        {
          name: 'Phase 1: Market Entry',
          activities: [
            'Establish entity structure',
            'Obtain regulatory promotion',
            'Hire core team of 15-20',
            'Secure first 3 pilot projects',
          ],
          milestones: ['Regulatory approval obtained', 'First pilot project signed'],
          investment: 'USD 5-8M',
        },
        {
          name: 'Phase 2: Scale Operations',
          activities: [
            'Expand to 50+ team members',
            'Build project pipeline to 20+ opportunities',
            'Develop financing partnerships',
            'Launch marketing program',
          ],
          milestones: ['10th project completed', 'Revenue reaches 500M'],
          investment: 'USD 8-12M',
        },
        {
          name: 'Phase 3: Market Leadership',
          activities: [
            'Expand beyond capital to regional markets',
            'Launch IoT-based monitoring platform',
            'Develop strategic partnerships',
            'Consider bolt-on acquisitions',
          ],
          milestones: ['Top 5 market position', '1.5B annual revenue'],
          investment: 'USD 7-15M',
        },
      ],
    },
    targetSegments: {
      slideTitle: 'Test Country - Target Customer Segments',
      goToMarketApproach:
        'Land-and-expand strategy starting with foreign manufacturers, then broadening to local industrial and commercial',
      segments: [
        {
          name: 'Foreign Manufacturers',
          size: '2.8B addressable',
          marketIntensity: 'High',
          decisionMaker: 'HQ + local plant manager',
          priority: 5,
        },
        {
          name: 'Industrial Estates',
          size: '4.2B addressable',
          marketIntensity: 'Very High',
          decisionMaker: 'Estate management + tenant committee',
          priority: 4,
        },
        {
          name: 'Commercial Buildings',
          size: '3.5B addressable',
          marketIntensity: 'Medium',
          decisionMaker: 'Property management / building owner',
          priority: 3,
        },
        {
          name: 'Government Facilities',
          size: '2.1B addressable',
          marketIntensity: 'Medium',
          decisionMaker: 'Department / provincial office',
          priority: 3,
        },
      ],
      topTargets: [
        {
          company: 'Target Corp Alpha',
          industry: 'Manufacturing',
          annualSpend: '1.2B annually',
          location: 'Industrial Estate Zone A',
        },
        {
          company: 'Target Corp Beta',
          industry: 'Petrochemical',
          annualSpend: '3.5B annually',
          location: 'Industrial Estate Zone B',
        },
        {
          company: 'Target Corp Gamma',
          industry: 'Commercial',
          annualSpend: '800M annually',
          location: 'Capital metropolitan area (45 properties)',
        },
      ],
    },
  };

  const summary = {
    opportunities: [
      {
        opportunity: 'Rising industrial costs creating urgent demand for efficiency solutions',
        size: '12B market by 2027',
        timing: '2025-2026',
        action: 'Target top 50 intensive operations with guaranteed savings proposals',
      },
      {
        opportunity: 'Government building retrofit mandate covering 5,000+ facilities',
        size: '3.5B government pipeline',
        timing: '2025-2028',
        action: 'Register as approved service provider and bid on Phase 1 contracts',
      },
      'Regulatory legislation expected by 2027 will accelerate private sector adoption',
      {
        opportunity: 'Data center boom driving 45% growth in cooling efficiency services',
        size: '1.8B by 2026',
        timing: '2025-2027',
        action: 'Develop specialized cooling optimization service offering',
      },
    ],
    obstacles: [
      {
        obstacle: 'Market fragmented with 45+ competitors and intense price competition',
        severity: 'High',
        mitigation:
          'Differentiate on technology and guaranteed savings rather than competing on price',
      },
      {
        obstacle: 'Complex licensing requirements add 6-9 months to market entry timeline',
        severity: 'Medium',
        mitigation: 'Engage specialist legal counsel and begin application process immediately',
      },
      {
        obstacle:
          'Local companies have deep government relationships difficult for foreign entrants to replicate',
        severity: 'Medium-High',
        mitigation: 'Partner with established local provider for government channel access',
      },
    ],
    keyInsights: [
      {
        title: 'Cost pressure creating urgency across manufacturing sector',
        data: 'Wages rose 8% annually 2021-2024 while costs increased 12%, compressing margins from 18% to 13% for mid-tier manufacturers.',
        pattern: 'Double cost squeeze accelerates demand from reactive to proactive.',
        implication:
          'Position services as cost management tool rather than sustainability initiative — CFO-driven sales cycle delivers faster conversion.',
        timing: 'Move by Q2 2026 — regulation starts Jan 2027, creating step-change in demand',
      },
      {
        title: 'Smart city program unlocking 15B in integrated management contracts',
        data: 'National initiative designating 30 pilot cities by 2027 with mandatory management systems in all new government buildings.',
        pattern:
          'Policy creates market: government mandate removes buyer hesitation and guarantees baseline demand.',
        implication:
          'Obtain registration immediately and build reference projects in Phase 1 locations to qualify for Phase 2.',
        timing: 'Phase 1 RFPs issuing Q3 2025 — must have local entity and registration by Q2 2025',
      },
      {
        title: 'Manufacturing investment redirecting 200B+ to this market',
        data: 'Trade organization reports 35% of manufacturers considering this market for production relocation, with 200B in committed investments through 2027.',
        pattern: 'Supply chain diversification creates captive demand.',
        implication:
          'Leverage HQ relationships to secure facility contracts during design phase, before local competitors engage.',
      },
    ],
    ratings: {
      attractiveness: 8,
      feasibility: 7,
      attractivenessRationale:
        'Large addressable market (12B+) with strong growth drivers; favorable regulatory environment with incentives reducing effective tax to near-zero for first 8 years',
      feasibilityRationale:
        'Established market with clear regulatory framework; main challenges are relationship-driven sales cycle and 45+ existing competitors',
    },
    goNoGo: {
      overallVerdict: 'CONDITIONAL GO',
      conditions: [
        'Secure local partner with registration by Q2 2025',
        'Obtain regulatory promotion before committing full investment',
        'Validate unit economics with 3 pilot projects before scaling',
      ],
      criteria: [
        {
          criterion: 'Market Size > USD 500M',
          met: true,
          evidence: '12B and growing 15% annually; projected 20B by 2028',
        },
        {
          criterion: 'Regulatory Environment Favorable',
          met: true,
          evidence: 'Incentive framework, registration program, building code enforcement',
        },
        {
          criterion: 'Competitive Positioning Achievable',
          met: true,
          evidence:
            'Technology gap in industrial segment; foreign manufacturing base creates captive demand',
        },
        {
          criterion: 'Local Partner Available',
          met: true,
          evidence: '3 qualified JV candidates identified with complementary capabilities',
        },
        {
          criterion: 'IRR > 15% Achievable',
          met: true,
          evidence: 'Market IRRs of 18-22% confirmed; tax incentives improve returns further',
        },
        {
          criterion: 'Political Stability',
          met: false,
          evidence:
            'Recent government transition creates policy uncertainty; new administration priorities unclear',
        },
      ],
    },
    timingIntelligence: {
      slideTitle: 'Test Country - Why Now?',
      windowOfOpportunity:
        'Critical 18-month window (Q2 2025 - Q4 2026): Regulatory legislation in draft, smart city Phase 1 RFPs issuing, and FDI surge creates convergence of demand drivers.',
      triggers: [
        {
          trigger: 'Regulatory Legislation',
          impact:
            'Creates mandatory reporting and financial incentive — estimated 3x demand increase',
          action: 'Begin pre-positioning campaigns and audit service development by Q3 2025',
        },
        {
          trigger: 'Smart City Phase 1 RFPs',
          impact: '30 pilot cities releasing 5B in management contracts starting Q3 2025',
          action:
            'Complete registration and secure at least 2 government reference projects before Q3 2025',
        },
        {
          trigger: 'FDI Wave',
          impact: '200B in manufacturing investment requiring facility systems through 2027',
          action: 'Activate HQ channel partnerships and assign dedicated team by Q1 2025',
        },
        {
          trigger: 'Regional Carbon Market Launch',
          impact: 'Regional trading creates monetization path for savings certificates',
          action: 'Develop quantification methodology for projects',
        },
      ],
    },
    lessonsLearned: {
      slideTitle: 'Test Country - Lessons from Market',
      subtitle: 'What previous entrants learned about this services market',
      failures: [
        {
          company: 'Failed Entrant Alpha (US)',
          year: '2018',
          reason:
            'Attempted greenfield entry without local partner; failed to win any government contracts in 2 years',
          lesson: 'Government channel requires established local partner',
        },
        {
          company: 'Failed Entrant Beta (China)',
          year: '2019',
          reason:
            'Aggressive low-price strategy eroded margins; exited after 18 months with 50M loss',
          lesson: 'Price competition alone is unsustainable in relationship-driven market',
        },
        {
          company: 'Failed Entrant Gamma (Germany)',
          year: '2016',
          reason:
            'Over-engineered solutions for local market; average project cost 2x local competitors',
          lesson: 'Right-size technology for local conditions and budgets',
        },
      ],
      successFactors: [
        'Local partner with government relationships is non-negotiable for public sector access',
        'Guaranteed performance contracts build trust faster than consulting-only approaches',
        'Decision-making is relationship-driven — invest 6-12 months in relationship building',
        'Regulatory promotion should be obtained early — retroactive application not possible',
      ],
      warningSignsToWatch: [
        'New government minister may shift policy priorities — monitor cabinet reshuffle impacts',
        'Rising interest rates could squeeze financing margins — stress-test models at 8% cost of capital',
        'Competitors re-entering market with improved offerings and financing — monitor pricing pressure',
      ],
    },
    recommendation:
      'Proceed with conditional market entry via Joint Venture with Local Corp Alpha. Prioritize registration, regulatory promotion application, and 3 pilot projects in foreign manufacturing segment. Total Phase 1 investment of USD 5-8M with expected breakeven at 30-36 months.',
  };

  const countryAnalysis = {
    country: 'Test Country',
    policy,
    market,
    competitors,
    depth,
    summary,
  };

  const synthesis = {
    isSingleCountry: true,
    country: 'Test Country',
    executiveSummary:
      'Test Country presents a compelling market entry opportunity for Test Industry services, driven by rising industrial costs, government mandates for building retrofits, and a critical 18-month window. The market is valued at 8.5B (2023) growing 15% annually, with projected 12B+ by 2027. A Joint Venture with Local Corp Alpha is recommended as the optimal entry strategy. Key success factors include securing registration, obtaining regulatory promotion for tax incentives, and establishing pilot projects with foreign manufacturers. Total Phase 1 investment of USD 5-8M with expected breakeven at 30-36 months and IRR of 18-22%.',
  };

  const scope = {
    industry: 'Test Industry',
    projectType: 'market-entry',
    targetMarkets: ['Test Country'],
  };

  return { synthesis, countryAnalysis, scope };
}

// ============ MUTATION ENGINE ============

const MUTATION_CATEGORIES = ['long-string', 'transient-key', 'sparse-section', 'type-mismatch'];

/**
 * Deterministically select which mutation categories apply for a given seed.
 * Returns 2-4 categories per seed.
 */
function selectMutationsForSeed(seed) {
  const rng = mulberry32(seed * 7919); // different sequence from main mutations
  const count = 2 + Math.floor(rng() * 3); // 2, 3, or 4
  const shuffled = [...MUTATION_CATEGORIES].sort(() => rng() - 0.5);
  return shuffled.slice(0, count);
}

function categorizeMutation(seed) {
  return selectMutationsForSeed(seed).join('+');
}

/**
 * Deep-clone a value (JSON-safe).
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Collect all paths to string-valued fields in an object.
 */
function collectStringPaths(obj, prefix, results) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      collectStringPaths(obj[i], prefix.concat(i), results);
    }
    return;
  }
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') {
      results.push(prefix.concat(key));
    } else if (val && typeof val === 'object') {
      collectStringPaths(val, prefix.concat(key), results);
    }
  }
}

/**
 * Collect all paths to array-valued fields in an object.
 */
function collectArrayPaths(obj, prefix, results) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    results.push([...prefix]);
    for (let i = 0; i < obj.length; i++) {
      collectArrayPaths(obj[i], prefix.concat(i), results);
    }
    return;
  }
  for (const [key, val] of Object.entries(obj)) {
    if (val && typeof val === 'object') {
      collectArrayPaths(val, prefix.concat(key), results);
    }
  }
}

/**
 * Collect all paths to object-valued (non-array, non-null) fields.
 */
function collectObjectPaths(obj, prefix, results) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  results.push([...prefix]);
  for (const [key, val] of Object.entries(obj)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      collectObjectPaths(val, prefix.concat(key), results);
    }
  }
}

/**
 * Get a value at a nested path.
 */
function getAtPath(obj, pathArr) {
  let current = obj;
  for (const key of pathArr) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Set a value at a nested path.
 */
function setAtPath(obj, pathArr, value) {
  if (pathArr.length === 0) return;
  let current = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    if (current == null || typeof current !== 'object') return;
    current = current[pathArr[i]];
  }
  if (current != null && typeof current === 'object') {
    current[pathArr[pathArr.length - 1]] = value;
  }
}

/**
 * Delete a key at a nested path.
 */
function deleteAtPath(obj, pathArr) {
  if (pathArr.length === 0) return;
  let current = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    if (current == null || typeof current !== 'object') return;
    current = current[pathArr[i]];
  }
  if (current != null && typeof current === 'object') {
    delete current[pathArr[pathArr.length - 1]];
  }
}

// Target fields for long-string mutations
const LONG_STRING_TARGET_FIELDS = [
  'slideTitle',
  'keyInsight',
  'description',
  'narrative',
  'keyMessage',
  'policyDirection',
  'recommendation',
  'outcome',
  'applicability',
  'competitiveInsight',
  'marketInsight',
  'executiveSummary',
  'riskJustification',
  'windowOfOpportunity',
  'goToMarketApproach',
];

/**
 * Apply long-string mutations: replace random string fields with very long strings.
 */
function applyLongStringMutations(payload, rng) {
  const stringPaths = [];
  collectStringPaths(payload, [], stringPaths);

  // Filter to target fields likely to cause rendering issues
  const targetPaths = stringPaths.filter((p) => {
    const lastKey = p[p.length - 1];
    return typeof lastKey === 'string' && LONG_STRING_TARGET_FIELDS.some((f) => lastKey === f);
  });

  if (targetPaths.length === 0) return;

  // Mutate 1-5 fields
  const count = 1 + Math.floor(rng() * Math.min(5, targetPaths.length));
  const shuffled = [...targetPaths].sort(() => rng() - 0.5);
  for (let i = 0; i < count; i++) {
    const len = rng() > 0.5 ? 5000 : 10000;
    const char = rng() > 0.5 ? 'X' : 'Y';
    setAtPath(payload, shuffled[i], char.repeat(len));
  }
}

// Transient keys to inject (must all match isTransientKey from ./transient-key-sanitizer.js)
const TRANSIENT_KEYS_POOL = [
  'section_0',
  'section_1',
  'section_2',
  'gap_1',
  'gap_2',
  'gap_3',
  '_wasArray',
  '_synthesisError',
  '_debugInfo',
  'marketDeepen_2',
  'marketDeepen_3',
  'finalReviewGap1',
  'finalReviewGap2',
  'deepen_market',
  'deepen_competitors',
  'deepen_policy',
  'competitorsDeepen_1',
  'policyDeepen_0',
  'verify_1',
  'verify_2',
];

/**
 * Apply transient-key mutations: inject keys that should be auto-stripped by sanitizeRenderPayload.
 */
function applyTransientKeyMutations(payload, rng) {
  const objectPaths = [];
  collectObjectPaths(payload, [], objectPaths);

  if (objectPaths.length === 0) return;

  // Inject 3-8 transient keys at random objects
  const count = 3 + Math.floor(rng() * 6);
  for (let i = 0; i < count; i++) {
    const targetPath = objectPaths[Math.floor(rng() * objectPaths.length)];
    const key = TRANSIENT_KEYS_POOL[Math.floor(rng() * TRANSIENT_KEYS_POOL.length)];
    const fakeValue =
      rng() > 0.5
        ? 'transient-injected-value-' + Math.floor(rng() * 1000)
        : { injected: true, data: 'noise-' + Math.floor(rng() * 1000) };
    const target = getAtPath(payload, targetPath);
    if (target && typeof target === 'object' && !Array.isArray(target)) {
      target[key] = fakeValue;
    }
  }
}

// Optional sections that can be safely removed
const DELETABLE_COMPETITOR_SECTIONS = ['japanesePlayers', 'caseStudy', 'maActivity'];
const DELETABLE_SUMMARY_SECTIONS = ['keyInsights', 'timingIntelligence', 'lessonsLearned'];

/**
 * Apply sparse-section mutations: randomly delete optional sections, empty arrays, or clear objects.
 */
function applySparseSectionMutations(payload, rng) {
  const competitors = payload.countryAnalysis && payload.countryAnalysis.competitors;
  const summaryObj = payload.countryAnalysis && payload.countryAnalysis.summary;

  // Randomly delete optional competitor sections
  if (competitors) {
    for (const section of DELETABLE_COMPETITOR_SECTIONS) {
      if (rng() > 0.5 && competitors[section]) {
        delete competitors[section];
      }
    }
  }

  // Randomly delete optional summary sections
  if (summaryObj) {
    for (const section of DELETABLE_SUMMARY_SECTIONS) {
      if (rng() > 0.5 && summaryObj[section]) {
        delete summaryObj[section];
      }
    }
  }

  // Randomly empty arrays throughout
  const arrayPaths = [];
  collectArrayPaths(payload, [], arrayPaths);
  const arrayTargets = arrayPaths.filter(() => rng() > 0.7);
  for (const arrPath of arrayTargets.slice(0, 5)) {
    const parentPath = arrPath.slice(0, -1);
    const key = arrPath[arrPath.length - 1];
    const parent = getAtPath(payload, parentPath);
    if (
      parent &&
      typeof parent === 'object' &&
      typeof key === 'string' &&
      Array.isArray(parent[key])
    ) {
      parent[key] = [];
    }
  }

  // Randomly set objects to {}
  const objectPaths = [];
  collectObjectPaths(payload, [], objectPaths);
  // Only target leaf-ish objects (path length >= 3) to avoid obliterating top-level structure
  const deepObjects = objectPaths.filter((p) => p.length >= 3 && rng() > 0.85);
  for (const objPath of deepObjects.slice(0, 3)) {
    const parentPath = objPath.slice(0, -1);
    const key = objPath[objPath.length - 1];
    const parent = getAtPath(payload, parentPath);
    if (parent && typeof parent === 'object' && typeof key === 'string') {
      parent[key] = {};
    }
  }
}

// Replacement values for type-mismatch mutations
const TYPE_MISMATCH_REPLACEMENTS = [
  [1, 2, 3],
  { nested: 'obj' },
  null,
  undefined,
  0,
  true,
  '',
  42,
  false,
  [{ deeply: 'nested' }],
];

/**
 * Apply type-mismatch mutations: replace string fields with non-strings and arrays with strings.
 */
function applyTypeMismatchMutations(payload, rng) {
  // Replace some string fields with non-string values
  const stringPaths = [];
  collectStringPaths(payload, [], stringPaths);
  const stringTargetCount = 2 + Math.floor(rng() * 4);
  const shuffledStrings = [...stringPaths].sort(() => rng() - 0.5);
  for (let i = 0; i < Math.min(stringTargetCount, shuffledStrings.length); i++) {
    const replacement =
      TYPE_MISMATCH_REPLACEMENTS[Math.floor(rng() * TYPE_MISMATCH_REPLACEMENTS.length)];
    setAtPath(payload, shuffledStrings[i], replacement);
  }

  // Replace some arrays with strings
  const arrayPaths = [];
  collectArrayPaths(payload, [], arrayPaths);
  const arrayTargetCount = 1 + Math.floor(rng() * 3);
  const shuffledArrays = [...arrayPaths].sort(() => rng() - 0.5);
  for (let i = 0; i < Math.min(arrayTargetCount, shuffledArrays.length); i++) {
    const arrPath = shuffledArrays[i];
    if (arrPath.length === 0) continue;
    const parentPath = arrPath.slice(0, -1);
    const key = arrPath[arrPath.length - 1];
    const parent = getAtPath(payload, parentPath);
    if (parent && typeof parent === 'object' && typeof key === 'string') {
      parent[key] = 'was-array-now-string';
    }
  }

  // Replace some objects with strings
  const objectPaths = [];
  collectObjectPaths(payload, [], objectPaths);
  const deepObjPaths = objectPaths.filter((p) => p.length >= 3);
  const objTargetCount = 1 + Math.floor(rng() * 2);
  const shuffledObjs = [...deepObjPaths].sort(() => rng() - 0.5);
  for (let i = 0; i < Math.min(objTargetCount, shuffledObjs.length); i++) {
    const objPath = shuffledObjs[i];
    const parentPath = objPath.slice(0, -1);
    const key = objPath[objPath.length - 1];
    const parent = getAtPath(payload, parentPath);
    if (parent && typeof parent === 'object' && typeof key === 'string') {
      parent[key] = 'was-object-now-string';
    }
  }
}

const MUTATION_APPLIERS = {
  'long-string': applyLongStringMutations,
  'transient-key': applyTransientKeyMutations,
  'sparse-section': applySparseSectionMutations,
  'type-mismatch': applyTypeMismatchMutations,
};

/**
 * Apply random subsets of mutations to a deep-cloned payload based on a seed.
 */
function mutatePayload(basePayload, seed) {
  const payload = deepClone(basePayload);
  const rng = mulberry32(seed);
  const categories = selectMutationsForSeed(seed);

  for (const category of categories) {
    const applier = MUTATION_APPLIERS[category];
    if (applier) {
      applier(payload, rng);
    }
  }

  return payload;
}

// ============ ERROR CLASSIFICATION ============

/**
 * Classify an error as either a deliberate data-gate rejection (expected)
 * or a runtime crash (Stage-4 bug).
 *
 * Data-gate rejections: the renderer intentionally validated and rejected bad data.
 * Runtime crashes: TypeError, ReferenceError, unguarded null access — real bugs.
 */
const DATA_GATE_PATTERNS = [
  /\[PPT\] Data gate failed/i,
  /\[PPT\] Cell text exceeds hard cap/i,
  /\[PPT TEMPLATE\] Missing table geometry/i,
  /Render normalization rejected/i,
  /non-renderable groups/i,
  /semantically empty/i,
  /exceed \d+ chars/i,
  /Data quality below threshold/i,
];

const RUNTIME_CRASH_PATTERNS = [
  /is not a function/i,
  /is not iterable/i,
  /Cannot read propert/i,
  /Cannot destructure/i,
  /is not defined/i,
  /is not an object/i,
  /undefined is not/i,
  /null is not/i,
  /Maximum call stack/i,
  /Invalid array length/i,
  /Assignment to constant/i,
];

function classifyError(errorMessage) {
  const msg = String(errorMessage || '');
  // Check runtime crash patterns first (they're the bugs)
  for (const pattern of RUNTIME_CRASH_PATTERNS) {
    if (pattern.test(msg)) return 'runtime-crash';
  }
  // Check data-gate patterns (expected behavior)
  for (const pattern of DATA_GATE_PATTERNS) {
    if (pattern.test(msg)) return 'data-gate';
  }
  // Default: if the message contains [PPT] it's likely a deliberate gate
  if (/\[PPT/.test(msg) || /generation failed:.*\[PPT/i.test(msg)) return 'data-gate';
  // Unknown errors default to runtime-crash (conservative)
  return 'runtime-crash';
}

// ============ REPORT BUILDER ============

function buildReport(results, passed, failed, total, runtimeCrashes, dataGateRejections) {
  const lines = [];
  lines.push('# Stress Test Report');
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- Seeds: 1-${total}`);
  lines.push(`- Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  lines.push(`- Runtime crashes (bugs): ${runtimeCrashes}`);
  lines.push(`- Data-gate rejections (expected): ${dataGateRejections}`);
  lines.push('');

  if (failed > 0) {
    lines.push('## Failure Summary');
    lines.push('| Seed | Class | Category | Error |');
    lines.push('|------|-------|----------|-------|');
    for (const r of results) {
      if (r.status === 'fail') {
        const errMsg = (r.error || 'Unknown').replace(/\|/g, '\\|').substring(0, 200);
        const cls = r.errorClass === 'runtime-crash' ? 'BUG' : 'gate';
        lines.push(`| ${r.seed} | ${cls} | ${r.category || 'unknown'} | ${errMsg} |`);
      }
    }
    lines.push('');
  }

  // Risk category breakdown
  const categoryCount = {};
  for (const r of results) {
    if (r.status === 'fail') {
      const cat = r.category || 'unknown';
      // Split combined categories and count each
      const parts = cat.split('+');
      for (const part of parts) {
        categoryCount[part] = (categoryCount[part] || 0) + 1;
      }
    }
  }

  if (Object.keys(categoryCount).length > 0) {
    lines.push('## Risk Categories');
    lines.push('| Category | Count | % |');
    lines.push('|----------|-------|---|');
    for (const [cat, count] of Object.entries(categoryCount).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${cat} | ${count} | ${((count / total) * 100).toFixed(1)}% |`);
    }
    lines.push('');
  }

  // Pass/fail rates by individual mutation category
  const categoryResults = {};
  for (const r of results) {
    const cat = categorizeMutation(r.seed);
    const parts = cat.split('+');
    for (const part of parts) {
      if (!categoryResults[part]) categoryResults[part] = { pass: 0, fail: 0 };
      if (r.status === 'pass') categoryResults[part].pass++;
      else categoryResults[part].fail++;
    }
  }

  if (Object.keys(categoryResults).length > 0) {
    lines.push('## Category Pass Rates');
    lines.push('| Category | Pass | Fail | Pass Rate |');
    lines.push('|----------|------|------|-----------|');
    for (const [cat, counts] of Object.entries(categoryResults).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      const catTotal = counts.pass + counts.fail;
      lines.push(
        `| ${cat} | ${counts.pass} | ${counts.fail} | ${((counts.pass / catTotal) * 100).toFixed(1)}% |`
      );
    }
    lines.push('');
  }

  const verdict = runtimeCrashes === 0 ? 'PASS' : 'FAIL';
  lines.push(`## Result: ${verdict}`);
  if (runtimeCrashes === 0 && dataGateRejections > 0) {
    lines.push(
      `(All ${dataGateRejections} failures are deliberate data-gate rejections, not runtime crashes)`
    );
  }

  return lines.join('\n');
}

// ============ RUNNER ============

async function runStressTest({ seeds = 30, reportPath = null } = {}) {
  const results = [];

  for (let seed = 1; seed <= seeds; seed++) {
    const category = categorizeMutation(seed);
    try {
      const { synthesis, countryAnalysis, scope } = buildBasePayload();
      const mutated = mutatePayload({ synthesis, countryAnalysis, scope }, seed);

      // Budget gate: compact oversized fields before rendering (mirrors server.js path)
      const budgetResult = runBudgetGate(mutated.countryAnalysis, { dryRun: false });
      if (budgetResult.compactionLog.length > 0) {
        mutated.countryAnalysis = budgetResult.payload;
      }

      const buffer = await generateSingleCountryPPT(
        mutated.synthesis,
        mutated.countryAnalysis,
        mutated.scope
      );

      // Assertion: must produce a Buffer
      if (!Buffer.isBuffer(buffer)) {
        throw new Error('Not a buffer — got ' + typeof buffer);
      }

      // Assertion: buffer must be non-trivial
      if (buffer.length < 1000) {
        throw new Error('Buffer too small: ' + buffer.length + ' bytes');
      }

      // Assertion: must be a valid PPTX (ZIP) package
      const zip = await JSZip.loadAsync(buffer);
      const entries = Object.keys(zip.files);

      if (!entries.some((e) => e.includes('ppt/slides/slide1.xml'))) {
        throw new Error('Missing slide1.xml in PPTX package');
      }

      if (!entries.some((e) => e.includes('[Content_Types].xml'))) {
        throw new Error('Missing [Content_Types].xml in PPTX package');
      }

      results.push({ seed, status: 'pass' });
    } catch (err) {
      const errMsg = err.message || String(err);
      const errorClass = classifyError(errMsg);
      results.push({
        seed,
        status: 'fail',
        error: errMsg,
        category,
        errorClass,
      });
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const failures = results.filter((r) => r.status === 'fail');
  const runtimeCrashes = failures.filter((r) => r.errorClass === 'runtime-crash').length;
  const dataGateRejections = failures.filter((r) => r.errorClass === 'data-gate').length;
  const report = buildReport(results, passed, failed, seeds, runtimeCrashes, dataGateRejections);

  if (reportPath) {
    const dir = path.dirname(reportPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(reportPath, report);
  }

  return { passed, failed, total: seeds, failures, runtimeCrashes, dataGateRejections, report };
}

// ============ TABLE PRESSURE STRESS TEST ============

async function runTablePressureStressTest() {
  console.log('[Stress] Running table pressure stress test...');
  const payload = buildBasePayload();
  const longCell = 'Market analysis data point with extensive detail. '.repeat(20);
  payload.market.marketSizeAndGrowth = {
    slideTitle: 'Market Size Stress Test',
    keyMessage: 'Testing extreme table rendering resilience',
    tableData: Array.from({ length: 25 }, (_, i) => ({
      segment: `Segment ${i + 1}`,
      value2023: `$${(Math.random() * 1000).toFixed(1)}M`,
      value2024: `$${(Math.random() * 1000).toFixed(1)}M`,
      growth: `${(Math.random() * 20).toFixed(1)}%`,
      marketShare: `${(Math.random() * 100).toFixed(1)}%`,
      drivers: longCell,
      challenges: longCell,
      outlook: longCell,
      region: `Region ${i % 5}`,
      subSegment: `Sub-${i}`,
      notes: longCell,
      forecast: `$${(Math.random() * 2000).toFixed(1)}M`,
    })),
  };
  try {
    const result = await generateSingleCountryPPT(payload);
    const metrics = result.__pptMetrics;
    console.log('[Stress] Table pressure test PASSED - no crash');
    console.log(`[Stress]   slideRenderFailures: ${metrics?.slideRenderFailureCount || 0}`);
    console.log(`[Stress]   tableFallbackCount: ${metrics?.tableFallbackCount || 0}`);
    console.log(`[Stress]   tableRecoveryCount: ${metrics?.tableRecoveryCount || 0}`);
    console.log(
      `[Stress]   tableRecoveryTypes: ${JSON.stringify(metrics?.tableRecoveryTypes || {})}`
    );
    return { passed: true, metrics };
  } catch (err) {
    console.error(`[Stress] Table pressure test FAILED: ${err.message}`);
    return { passed: false, error: err.message };
  }
}

// ============ EXPORTS ============

module.exports = { runStressTest, runTablePressureStressTest };

// ============ CLI ============

if (require.main === module) {
  const args = process.argv.slice(2);
  let seeds = 30;
  let reportPath = null;

  for (const arg of args) {
    if (arg.startsWith('--seeds=')) {
      seeds = parseInt(arg.split('=')[1], 10) || 30;
    } else if (arg.startsWith('--report=')) {
      reportPath = arg.split('=')[1];
    }
  }

  if (!reportPath) {
    reportPath = path.join(__dirname, 'stress-test-report.md');
  }

  console.log(`Running stress test with ${seeds} seeds...`);
  const startTime = Date.now();

  runStressTest({ seeds, reportPath })
    .then((result) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log('');
      console.log(result.report);
      console.log('');
      console.log(`Completed in ${elapsed}s`);
      console.log(`Report written to: ${reportPath}`);
      process.exit(result.runtimeCrashes > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Stress test harness error:', err);
      process.exit(2);
    });
}
