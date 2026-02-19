/**
 * PPT Generation Test — uses production generateSingleCountryPPT()
 * Run: node test-ppt-generation.js
 * Produces: test-output.pptx
 */

const { generateSingleCountryPPT } = require('./deck-builder-single');
const { runContentSizeCheck } = require('./content-size-check');
const fs = require('fs');
const path = require('path');

// ============ MOCK DATA ============

const policy = {
  foundationalActs: {
    slideTitle: 'Thailand - Energy Services Foundational Acts',
    keyMessage:
      'Thailand regulatory framework increasingly favors energy efficiency investments with clear enforcement mechanisms',
    acts: [
      {
        name: 'Energy Conservation Promotion Act',
        year: '1992 (amended 2007)',
        requirements:
          'Designated facilities must appoint energy managers, submit energy management reports, and implement efficiency improvement plans',
        enforcement:
          'Department of Alternative Energy Development and Efficiency (DEDE) conducts annual audits with mandatory compliance deadlines',
        penalties:
          'Fines up to THB 500,000 for non-compliance; facility shutdown orders for repeat violations',
      },
      {
        name: 'Energy Industry Act B.E. 2550',
        year: '2007',
        requirements:
          'Licensing framework for energy service providers including ESCOs; technical standards for energy equipment and performance contracting',
        enforcement:
          'Energy Regulatory Commission (ERC) oversees licensing and compliance, annual performance reviews',
        penalties:
          'License revocation and fines up to THB 1,000,000; criminal liability for safety violations',
      },
      {
        name: 'Building Energy Code',
        year: '2009 (updated 2020)',
        requirements:
          'New commercial buildings over 2,000 sqm must meet minimum energy performance standards including OTTV below 50 W/sqm',
        enforcement:
          'Local building authorities verify compliance during construction permits and occupancy approvals',
        penalties:
          'Construction permit denial; mandatory retrofit within 2 years of non-compliance finding',
      },
    ],
  },
  nationalPolicy: {
    slideTitle: 'Thailand - National Energy Policy',
    policyDirection:
      'Thailand targets 30% renewable energy share by 2036 under the Alternative Energy Development Plan',
    targets: [
      {
        metric: 'Energy Intensity Reduction',
        target: '30% reduction from 2010 baseline',
        deadline: '2036',
        status: 'On track - 18% achieved by 2023',
      },
      {
        metric: 'Renewable Energy Share',
        target: '30% of final energy consumption',
        deadline: '2036',
        status: 'Progress - 15.5% as of 2023',
      },
      {
        metric: 'EV Penetration',
        target: '30% of new vehicle sales',
        deadline: '2030',
        status: 'Behind - currently at 12%',
      },
      {
        metric: 'Carbon Neutrality',
        target: 'Net zero GHG emissions',
        deadline: '2065',
        status: 'Roadmap published Q3 2023',
      },
    ],
    keyInitiatives: [
      'Smart Grid Development Program with THB 15.6B investment',
      'BCG Economy Model integrating bio-circular-green strategies',
      'ERC Sandbox for innovative energy trading pilots',
      'Thailand 4.0 industrial digitalization incentives for energy sector',
    ],
  },
  investmentRestrictions: {
    slideTitle: 'Thailand - Foreign Investment Rules',
    ownershipLimits: {
      general: '49% foreign ownership cap under Foreign Business Act',
      exceptions:
        'BOI-promoted projects may receive 100% foreign ownership; Treaty of Amity allows US nationals majority ownership',
      promoted: '100% under BOI Zone 3 incentives',
    },
    incentives: [
      {
        name: 'BOI Energy Efficiency Promotion',
        benefit: '8-year corporate tax exemption, import duty waivers on equipment',
        eligibility: 'Projects with minimum THB 50M investment in energy efficiency technology',
      },
      {
        name: 'Eastern Economic Corridor (EEC)',
        benefit: 'Enhanced tax holidays up to 13 years, land lease up to 99 years',
        eligibility: 'Operations located in Chachoengsao, Chonburi, or Rayong provinces',
      },
      {
        name: 'Green Bond Tax Incentives',
        benefit: 'Withholding tax exemption on green bond interest payments',
        eligibility: 'Certified green projects per Thai Green Bond framework',
      },
    ],
    riskLevel: 'Medium-Low',
    riskJustification:
      'Stable regulatory environment with established BOI framework; main risks are bureaucratic delays and periodic policy shifts during government transitions',
  },
};

const market = {
  tpes: {
    slideTitle: 'Thailand - Total Primary Energy Supply',
    keyInsight: 'Natural gas dominates at 39% but declining as renewables accelerate to 12% share',
    narrative:
      'Thailand TPES reached 137 Mtoe in 2023, growing 2.1% YoY driven by industrial recovery',
    chartData: {
      categories: ['2019', '2020', '2021', '2022', '2023'],
      series: [
        { name: 'Natural Gas', values: [53.2, 48.7, 50.1, 52.8, 53.4] },
        { name: 'Oil', values: [41.3, 36.2, 38.5, 40.1, 41.8] },
        { name: 'Coal', values: [18.5, 16.8, 17.2, 17.9, 18.1] },
        { name: 'Renewables', values: [11.2, 12.5, 13.8, 15.2, 16.4] },
        { name: 'Imports', values: [6.1, 5.8, 6.2, 6.7, 7.3] },
      ],
      unit: 'Mtoe',
    },
    structuredData: {
      marketBreakdown: {
        totalPrimaryEnergySupply: { naturalGasPercent: '39%', renewablePercent: '12%' },
      },
    },
  },
  finalDemand: {
    slideTitle: 'Thailand - Final Energy Demand',
    keyInsight: 'Industry accounts for 37% of final demand, presenting largest ESCO opportunity',
    chartData: {
      categories: ['2019', '2020', '2021', '2022', '2023'],
      series: [
        { name: 'Industry', values: [32.1, 29.5, 31.2, 33.8, 35.4] },
        { name: 'Transport', values: [27.8, 22.1, 24.5, 26.9, 28.2] },
        { name: 'Commercial', values: [12.5, 10.8, 11.9, 13.1, 13.8] },
        { name: 'Residential', values: [8.9, 9.2, 9.1, 9.3, 9.5] },
        { name: 'Agriculture', values: [4.2, 4.0, 4.1, 4.3, 4.4] },
      ],
      unit: 'Mtoe',
    },
    keyDrivers: [
      'Manufacturing sector expansion driving industrial demand',
      'EV adoption reducing transport petroleum demand',
    ],
    structuredData: {
      marketBreakdown: {
        totalFinalConsumption: { industryPercent: '37%', transportPercent: '29%' },
      },
    },
  },
  electricity: {
    slideTitle: 'Thailand - Electricity & Power',
    keyInsight:
      'Peak demand growing 3.2% annually; renewable capacity additions outpacing thermal since 2022',
    demandGrowth: '3.2% CAGR 2020-2023',
    totalCapacity: '53.7 GW installed (2023)',
    keyTrend: 'Rapid solar PV deployment with 4.2 GW added in 2022-2023',
    chartData: {
      categories: ['2019', '2020', '2021', '2022', '2023'],
      series: [
        { name: 'Natural Gas', values: [62.5, 58.3, 60.1, 59.2, 57.8] },
        { name: 'Coal/Lignite', values: [18.2, 17.5, 17.8, 16.9, 15.8] },
        { name: 'Renewables', values: [10.8, 14.2, 15.5, 17.8, 20.1] },
        { name: 'Imports', values: [8.5, 10.0, 6.6, 6.1, 6.3] },
      ],
      unit: '%',
    },
    structuredData: {
      marketBreakdown: {
        electricityGeneration: { current: '210 TWh (2023)', projected2030: '280 TWh' },
      },
    },
  },
  gasLng: {
    slideTitle: 'Thailand - Gas & LNG Market',
    keyInsight:
      'Domestic gas production declining 5% annually; LNG imports surging to fill 35% of demand by 2025',
    pipelineNetwork:
      '4,200 km transmission network operated by PTT; capacity constraints in southern corridor',
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
      { name: 'Map Ta Phut LNG', capacity: '11.5 MTPA', utilization: '78%' },
      { name: 'Nong Fab LNG (Phase 2)', capacity: '7.5 MTPA', utilization: '42%' },
      { name: 'Floating LNG (planned)', capacity: '5.0 MTPA', utilization: 'Under construction' },
    ],
    structuredData: {
      infrastructureCapacity: {
        lngImportCurrent: '19 MTPA',
        lngImportPlanned: '24 MTPA by 2027',
        pipelineCapacity: '4,500 MMscfd',
      },
    },
  },
  pricing: {
    slideTitle: 'Thailand - Energy Pricing',
    keyInsight:
      'Industrial electricity rates rising 12% in 2023; creates strong ROI case for efficiency investments',
    outlook:
      'Tariff increases expected to continue through 2026 as fuel adjustment charges remain elevated',
    comparison: 'Thailand industrial rates 15% above Vietnam, 8% below Japan — mid-range for ASEAN',
    chartData: {
      categories: ['2019', '2020', '2021', '2022', '2023'],
      series: [
        { name: 'Industrial Rate', values: [3.12, 2.98, 3.21, 3.58, 4.01] },
        { name: 'Commercial Rate', values: [3.85, 3.72, 3.95, 4.32, 4.78] },
        { name: 'Residential Rate', values: [2.95, 2.88, 3.05, 3.38, 3.72] },
      ],
      unit: 'THB/kWh',
    },
    structuredData: {
      priceComparison: {
        generationCost: 'THB 2.85/kWh',
        retailPrice: 'THB 4.01/kWh (industrial)',
        industrialRate: 'THB 4.01/kWh',
      },
    },
  },
  escoMarket: {
    slideTitle: 'Thailand - ESCO Market',
    keyInsight:
      'ESCO market growing 15% annually; government buildings mandate drives 40% of current projects',
    marketSize: 'THB 8.5 billion (2023)',
    growthRate: '15% CAGR 2020-2023',
    keyDrivers: 'Rising energy costs and carbon tax expectations driving private sector adoption',
    chartData: {
      categories: ['2019', '2020', '2021', '2022', '2023'],
      series: [
        { name: 'Government', values: [1.8, 1.5, 2.1, 2.8, 3.4] },
        { name: 'Industrial', values: [1.2, 1.0, 1.4, 1.9, 2.5] },
        { name: 'Commercial', values: [0.8, 0.6, 0.9, 1.2, 1.6] },
        { name: 'Residential', values: [0.3, 0.2, 0.4, 0.5, 0.7] },
      ],
      unit: 'THB Billion',
    },
    segments: [
      { name: 'Building HVAC Optimization', size: 'THB 3.2B', share: '38%' },
      { name: 'Industrial Process Efficiency', size: 'THB 2.5B', share: '29%' },
      { name: 'Lighting & Electrical', size: 'THB 1.8B', share: '21%' },
      { name: 'Renewable Integration', size: 'THB 1.0B', share: '12%' },
    ],
    structuredData: {
      escoMarketState: {
        registeredESCOs: '45 registered providers',
        totalProjects: '1,200+ completed projects',
      },
    },
  },
};

const competitors = {
  japanesePlayers: {
    slideTitle: 'Thailand - Japanese Energy Services Companies',
    marketInsight:
      'Japanese firms hold 22% of industrial ESCO market through long-term relationships with Japanese manufacturers in Thailand',
    players: [
      {
        name: 'Daikin Industries Thailand',
        presence: 'Since 1990, 3 facilities',
        description:
          'Leading HVAC and energy management provider with THB 12.5B revenue in Thailand. Controls 28% of commercial HVAC market through integrated building management solutions targeting Japanese auto and electronics manufacturers. Annual growth of 8% driven by factory modernization projects across Eastern Seaboard industrial estates.',
        entryYear: '1990',
        revenue: 'THB 12.5B',
        strategicAssessment:
          'Strong position in Japanese OEM segment but limited penetration in Thai-owned industrial facilities; partnership opportunity for local market access',
      },
      {
        name: 'Hitachi Energy Thailand',
        presence: 'Since 2001, 2 offices',
        description:
          'Grid modernization and industrial energy management specialist with THB 4.2B Thai revenue. Focuses on power quality and distribution solutions for heavy industry. Revenue grew 15% in 2023 driven by EV manufacturing plant energy systems for Toyota and Honda Thailand operations.',
        entryYear: '2001',
        revenue: 'THB 4.2B',
        strategicAssessment:
          'Technology leader in grid-scale solutions but premium pricing limits SME market access; acquisition target for broader market coverage',
      },
      {
        name: 'Panasonic Energy Solutions',
        presence: 'Since 1988, regional hub',
        description:
          'Diversified energy solutions including solar PV, battery storage, and building management systems with THB 3.8B revenue. Serves both commercial buildings and industrial facilities with integrated IoT-based energy monitoring platforms generating recurring service revenue of THB 450M annually.',
        entryYear: '1988',
        revenue: 'THB 3.8B',
        // NO strategicAssessment — tests null handling
      },
    ],
  },
  localMajor: {
    slideTitle: 'Thailand - Major Local Players',
    concentration: 'Top 5 local players hold 45% of domestic ESCO market',
    players: [
      {
        name: 'Absolute Clean Energy (ACE)',
        type: 'Listed energy company',
        revenue: 'THB 8.2B',
        marketShare: '15%',
        description:
          'Largest Thai ESCO by project count with 300+ completed energy savings contracts across government and industrial segments. Revenue grew 22% YoY driven by mandatory government building retrofits. Strong relationships with DEDE and provincial energy offices provide pipeline visibility.',
        strategicAssessment:
          'Market leader with government relationships but limited technical depth in complex industrial processes; JV partner candidate for technology transfer',
      },
      {
        name: 'Energy Absolute PCL',
        type: 'Listed renewable energy',
        revenue: 'THB 15.1B',
        marketShare: '8%',
        description:
          'Diversified clean energy group expanding into ESCO services from renewable generation base. THB 15.1B total revenue with ESCO segment growing 35% to reach THB 1.2B in 2023. Leverages existing solar and wind farm relationships to cross-sell efficiency services to industrial clients.',
        strategicAssessment:
          'Financial strength and existing energy customer base create cross-sell opportunities; ESCO division still nascent with limited technical team',
      },
      {
        name: 'Gunkul Engineering',
        type: 'Engineering contractor',
        revenue: 'THB 6.8B',
        marketShare: '10%',
        description:
          'Engineering-led ESCO with deep technical capabilities in electrical systems and renewable integration. THB 6.8B revenue with 10% market share in industrial segment. Strong execution track record with 95% project completion rate and 12% average energy savings delivery against guaranteed targets.',
        strategicAssessment:
          'Best technical execution among local players; potential acquisition target valued at 8-10x EBITDA based on comparable transactions',
      },
    ],
  },
  foreignPlayers: {
    slideTitle: 'Thailand - Foreign Energy Services Companies',
    competitiveInsight:
      'European players dominate technical consulting while Korean and Chinese firms compete on price in equipment-led projects',
    players: [
      {
        name: 'Schneider Electric Thailand',
        origin: 'France',
        mode: 'Wholly-owned subsidiary',
        entryYear: '1998',
        revenue: 'THB 9.8B',
        description:
          'Market leader in building management and industrial automation with THB 9.8B Thailand revenue. EcoStruxure platform deployed in 500+ buildings. Recent focus on data center energy optimization as cloud demand surges with 45% revenue growth in this segment during 2022-2023.',
        strategicAssessment:
          'Dominant technology position but high-cost structure limits addressable market; partnership model preferred over direct competition',
      },
      {
        name: 'Siemens Energy Thailand',
        origin: 'Germany',
        mode: 'Joint venture with local partner',
        entryYear: '2005',
        revenue: 'THB 5.5B',
        description:
          'Gas turbine services and grid solutions specialist with growing ESCO division. THB 5.5B revenue with 18% growth in digital energy services. MindSphere IoT platform gaining traction in petrochemical sector with 12 major deployments at Map Ta Phut industrial estate.',
        strategicAssessment:
          'Strong in heavy industry and petrochemicals; limited presence in commercial building segment creates complementary partnership potential',
      },
      {
        name: 'Samsung C&T Energy Division',
        origin: 'South Korea',
        mode: 'Branch office',
        entryYear: '2015',
        revenue: 'THB 2.1B',
        description:
          'Aggressive expansion in smart building and renewable energy project development. THB 2.1B Thailand revenue growing 28% annually. Leverages Samsung Electronics ecosystem for IoT and building automation integration. Won 3 major government smart city contracts in 2023 totaling THB 850M.',
        strategicAssessment:
          'Fast-growing with technology integration advantages; price-competitive but limited local engineering team constrains project delivery capacity',
      },
    ],
  },
  caseStudy: {
    slideTitle: 'Thailand - Market Entry Case Study: Veolia',
    company: 'Veolia Environment Thailand',
    entryYear: '2010',
    entryMode: 'Acquisition of local water/energy utility',
    investment: 'USD 180M total (USD 120M acquisition + USD 60M expansion)',
    outcome:
      'Achieved profitability by Year 3 with THB 4.2B revenue by 2023. Successfully expanded from water treatment into industrial energy management, winning 15 major ESCO contracts. Key success factor was retaining local management team and leveraging Veolia global technology platform for differentiated offerings.',
    applicability:
      'Demonstrates acquisition-led entry can accelerate market access; local talent retention critical for relationship-driven Thai market',
    keyLessons: [
      'Retain local management — Thai business relationships are personal and non-transferable',
      'Start with adjacent service (water) to build trust before cross-selling energy services',
      'Government contracts provide stable base revenue but private sector delivers higher margins',
      'BOI incentives significantly improve deal economics — structure early for maximum tax benefit',
    ],
  },
  maActivity: {
    slideTitle: 'Thailand - M&A Activity',
    valuationMultiples: '8-12x EBITDA for ESCO companies; 6-8x for traditional energy contractors',
    recentDeals: [
      {
        year: '2023',
        buyer: 'BCPG PCL',
        target: 'Thai Solar Energy',
        value: 'THB 2.8B',
        rationale: 'Vertical integration into ESCO services',
      },
      {
        year: '2022',
        buyer: 'Gulf Energy',
        target: 'Energy Pro (ESCO)',
        value: 'THB 1.5B',
        rationale: 'Expand downstream energy management',
      },
      {
        year: '2023',
        buyer: 'Ratch Group',
        target: 'Smart Grid Solutions',
        value: 'THB 950M',
        rationale: 'Grid modernization capabilities',
      },
    ],
    potentialTargets: [
      {
        name: 'Thai Energy Conservation',
        estimatedValue: 'THB 800M-1.2B',
        rationale: 'Largest independent ESCO with government contract portfolio',
        timing: '2025-2026 — founder approaching retirement',
      },
      {
        name: 'Green Building Solutions',
        estimatedValue: 'THB 400-600M',
        rationale: 'Leading commercial building ESCO with smart building IP',
        timing: '2025 — Series B fundraising expected',
      },
      {
        name: 'EcoTech Industries',
        estimatedValue: 'THB 600-900M',
        rationale: 'Industrial process optimization specialist with proprietary monitoring tech',
        timing: '2026 — 3-year lock-up from last investment expiring',
      },
    ],
  },
};

const depth = {
  dealEconomics: {
    slideTitle: 'Thailand - ESCO Deal Economics',
    keyInsight:
      'Average deal size THB 25M with 18-22% IRR; payback under 4 years makes Thailand among most attractive ESCO markets in ASEAN',
    typicalDealSize: { min: 'THB 5M', max: 'THB 80M', average: 'THB 25M' },
    contractTerms: {
      duration: '5-10 years',
      revenueSplit: '70/30 ESCO/client in years 1-3, transitioning to 50/50',
      guaranteeStructure: 'Minimum 15% energy savings guarantee with penalty clause',
    },
    financials: {
      paybackPeriod: '3.2 years average',
      irr: '18-22%',
      marginProfile: 'Gross margin 35-42%, improving with scale',
    },
    financingOptions: [
      'ESCO self-financing with balance sheet (most common for deals under THB 20M)',
      'Third-party financing through commercial banks at 5.5-7% interest rates',
      'Green bonds and sustainability-linked loans with 50-75 bps discount',
    ],
  },
  partnerAssessment: {
    slideTitle: 'Thailand - Partner Assessment',
    recommendedPartner:
      'Bangchak Green Energy (BGE) — best combination of market access and cultural fit',
    partners: [
      {
        name: 'Bangchak Green Energy',
        type: 'Listed ESCO',
        revenue: 'THB 9.1B',
        partnershipFit: 4,
        acquisitionFit: 3,
        estimatedValuation: 'THB 14-18B (listed)',
        description:
          'Bangchak subsidiary focused on clean energy solutions with 250+ commercial ESCO projects and strong BOI relationships. Listed on SET with THB 9.1B revenue. Culture fit is high due to existing Japanese partnerships. Broad renewables portfolio creates clear synergy with foreign technology partner.',
      },
      {
        name: 'WHA Utilities & Power',
        type: 'Industrial utilities provider',
        revenue: 'THB 7.5B',
        partnershipFit: 3,
        acquisitionFit: 4,
        estimatedValuation: 'THB 9-12B',
        description:
          'Leading industrial estate utilities provider with 95% uptime track record. THB 7.5B revenue with proven delivery in industrial energy management. Technical team of 200+ engineers across 11 industrial estates. Corporate structure may complicate JV negotiations but strategic interest in ESCO diversification creates clear acquisition rationale.',
      },
      {
        name: 'Thai Carbon Solutions',
        type: 'Private ESCO',
        revenue: 'THB 2.8B',
        partnershipFit: 5,
        acquisitionFit: 5,
        estimatedValuation: 'THB 900M-1.4B',
        description:
          'Leading independent carbon management and ESCO firm with 15-year track record and government contract portfolio worth THB 2.0B annually. Founder approaching retirement creates acquisition window. Deep relationships with provincial energy offices. Revenue THB 2.8B with stable 25% margins.',
      },
    ],
  },
  entryStrategy: {
    slideTitle: 'Thailand - Entry Strategy Options',
    recommendation:
      'Joint Venture with local ESCO recommended — balances speed-to-market with risk management',
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
    slideTitle: 'Thailand - Implementation Roadmap',
    totalInvestment: 'USD 20-35M over 3 years',
    breakeven: '30-36 months from market entry',
    phases: [
      {
        name: 'Phase 1: Market Entry',
        activities: [
          'Establish JV/entity structure',
          'Obtain BOI promotion',
          'Hire core team of 15-20',
          'Secure first 3 pilot projects',
        ],
        milestones: ['BOI approval obtained', 'First pilot project signed'],
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
        milestones: ['10th project completed', 'Revenue reaches THB 500M'],
        investment: 'USD 8-12M',
      },
      {
        name: 'Phase 3: Market Leadership',
        activities: [
          'Expand beyond Bangkok to regional markets',
          'Launch IoT-based monitoring platform',
          'Develop strategic partnerships',
          'Consider bolt-on acquisitions',
        ],
        milestones: ['Top 5 market position', 'THB 1.5B annual revenue'],
        investment: 'USD 7-15M',
      },
    ],
  },
  targetSegments: {
    slideTitle: 'Thailand - Target Customer Segments',
    goToMarketApproach:
      'Land-and-expand strategy starting with Japanese manufacturers, then broadening to Thai industrial and commercial',
    segments: [
      {
        name: 'Japanese Manufacturers',
        size: 'THB 2.8B addressable',
        marketIntensity: 'High',
        decisionMaker: 'Japan HQ + local plant manager',
        priority: 5,
      },
      {
        name: 'Thai Industrial Estates',
        size: 'THB 4.2B addressable',
        marketIntensity: 'Very High',
        decisionMaker: 'Estate management + tenant committee',
        priority: 4,
      },
      {
        name: 'Commercial Buildings',
        size: 'THB 3.5B addressable',
        marketIntensity: 'Medium',
        decisionMaker: 'Property management / building owner',
        priority: 3,
      },
      {
        name: 'Government Facilities',
        size: 'THB 2.1B addressable',
        marketIntensity: 'Medium',
        decisionMaker: 'DEDE / provincial energy office',
        priority: 3,
      },
    ],
    topTargets: [
      {
        company: 'Toyota Motor Thailand',
        industry: 'Automotive',
        annualSpend: 'THB 1.2B annually',
        location: 'Gateway City Industrial Estate, Chachoengsao',
      },
      {
        company: 'SCG Chemicals',
        industry: 'Petrochemical',
        annualSpend: 'THB 3.5B annually',
        location: 'Map Ta Phut Industrial Estate, Rayong',
      },
      {
        company: 'Central Group',
        industry: 'Retail/Commercial',
        annualSpend: 'THB 800M annually',
        location: 'Bangkok metropolitan area (45 properties)',
      },
    ],
  },
};

const summaryData = {
  opportunities: [
    {
      opportunity: 'Rising industrial energy costs creating urgent demand for efficiency solutions',
      size: 'THB 12B market by 2027',
      timing: '2025-2026',
      action: 'Target top 50 energy-intensive manufacturers with guaranteed savings proposals',
    },
    {
      opportunity: 'Government building retrofit mandate covering 5,000+ facilities',
      size: 'THB 3.5B government pipeline',
      timing: '2025-2028',
      action: 'Register as approved DEDE service provider and bid on Phase 1 contracts',
    },
    'Carbon tax legislation expected by 2027 will accelerate private sector ESCO adoption',
    {
      opportunity: 'Data center boom driving 45% growth in cooling efficiency services',
      size: 'THB 1.8B by 2026',
      timing: '2025-2027',
      action: 'Develop specialized data center cooling optimization service offering',
    },
  ],
  obstacles: [
    {
      obstacle: 'Thai ESCO market fragmented with 45+ competitors and intense price competition',
      severity: 'High',
      mitigation:
        'Differentiate on technology and guaranteed savings rather than competing on price',
    },
    {
      obstacle: 'Complex BOI and licensing requirements add 6-9 months to market entry timeline',
      severity: 'Medium',
      mitigation: 'Engage specialist legal counsel and begin BOI application process immediately',
    },
    {
      obstacle:
        'Local companies have deep government relationships difficult for foreign entrants to replicate',
      severity: 'Medium-High',
      mitigation: 'Partner with established local ESCO for government channel access',
    },
  ],
  keyInsights: [
    {
      title: 'Labor cost pressure creating energy efficiency urgency across Thai manufacturing',
      data: 'Manufacturing wages rose 8% annually 2021-2024 while energy costs increased 12%, compressing margins from 18% to 13% for mid-tier manufacturers.',
      pattern:
        'Aging workforce drives wage inflation while energy transition increases fuel costs — double cost squeeze accelerates ESCO demand from reactive to proactive.',
      implication:
        'Position energy efficiency as cost management tool rather than sustainability initiative — CFO-driven sales cycle delivers faster conversion than CSR-driven approach.',
      timing:
        'Move by Q2 2026 — carbon tax starts Jan 2027, creating step-change in demand that early movers capture',
    },
    {
      title:
        'Government smart city program unlocking THB 15B in integrated energy management contracts',
      data: 'Thailand 4.0 smart city initiative designating 30 pilot cities by 2027 with mandatory energy management systems in all new government buildings over 2,000 sqm.',
      pattern:
        'Policy creates market: government mandate removes buyer hesitation and guarantees baseline demand for qualified ESCO providers meeting DEDE technical standards.',
      implication:
        'Obtain DEDE ESCO registration immediately and build reference projects in Phase 1 smart city locations to qualify for larger Phase 2 contracts.',
      timing:
        'Phase 1 RFPs issuing Q3 2025 — must have local entity and DEDE registration by Q2 2025 to participate',
    },
    {
      title:
        'Japanese manufacturing exodus from China redirecting THB 200B+ industrial investment to Thailand',
      data: 'Japan External Trade Organization reports 35% of Japanese manufacturers considering Thailand for production relocation, with THB 200B in committed investments through 2027.',
      pattern:
        'Supply chain diversification from China creates captive demand — Japanese manufacturers prefer Japanese or Japanese-affiliated energy service providers for new facility construction.',
      implication:
        'Leverage Japan HQ relationships to secure facility energy management contracts during factory design phase, before local competitors can engage.',
      // NO timing — tests graceful handling of missing field
    },
  ],
  ratings: {
    attractiveness: 8,
    feasibility: 7,
    attractivenessRationale:
      'Large addressable market (THB 12B+) with strong growth drivers (carbon tax, smart city mandate, industrial relocation); favorable regulatory environment with BOI incentives reducing effective tax to near-zero for first 8 years',
    feasibilityRationale:
      'Established ESCO market with clear regulatory framework; main challenges are relationship-driven sales cycle and 45+ existing competitors requiring differentiated value proposition',
  },
  goNoGo: {
    overallVerdict: 'CONDITIONAL GO',
    conditions: [
      'Secure local JV partner with DEDE registration by Q2 2025',
      'Obtain BOI promotion before committing full investment',
      'Validate unit economics with 3 pilot projects before scaling',
    ],
    criteria: [
      {
        criterion: 'Market Size > USD 500M',
        met: true,
        evidence: 'THB 12B (~USD 340M) and growing 15% annually; projected THB 20B by 2028',
      },
      {
        criterion: 'Regulatory Environment Favorable',
        met: true,
        evidence: 'BOI incentives, DEDE ESCO framework, building energy code enforcement',
      },
      {
        criterion: 'Competitive Positioning Achievable',
        met: true,
        evidence:
          'Technology gap in industrial ESCO segment; Japanese manufacturing base creates captive demand',
      },
      {
        criterion: 'Local Partner Available',
        met: true,
        evidence: '3 qualified JV candidates identified with complementary capabilities',
      },
      {
        criterion: 'IRR > 15% Achievable',
        met: true,
        evidence: 'Market IRRs of 18-22% confirmed; BOI tax incentives improve returns further',
      },
      {
        criterion: 'Political Stability',
        met: false,
        evidence:
          'Recent government transition creates policy uncertainty; new administration energy priorities unclear until mid-2025',
      },
    ],
  },
  timingIntelligence: {
    slideTitle: 'Thailand - Why Now?',
    windowOfOpportunity:
      'Critical 18-month window (Q2 2025 - Q4 2026): Carbon tax legislation in draft, smart city Phase 1 RFPs issuing, and Japanese FDI surge creates once-in-decade convergence of demand drivers.',
    triggers: [
      {
        trigger: 'Carbon Tax Legislation',
        impact:
          'Creates mandatory reporting and financial incentive for energy efficiency — estimated 3x ESCO demand increase',
        action:
          'Begin pre-positioning marketing campaigns and carbon audit service development by Q3 2025',
      },
      {
        trigger: 'Smart City Phase 1 RFPs',
        impact: '30 pilot cities releasing THB 5B in energy management contracts starting Q3 2025',
        action:
          'Complete DEDE ESCO registration and secure at least 2 government reference projects before Q3 2025',
      },
      {
        trigger: 'Japanese FDI Wave',
        impact:
          'THB 200B in manufacturing investment requiring factory energy systems through 2027',
        action:
          'Activate Japan HQ channel partnerships and assign dedicated Japan-desk team by Q1 2025',
      },
      {
        trigger: 'ASEAN Carbon Market Launch',
        impact: 'Regional carbon trading creates monetization path for energy savings certificates',
        action: 'Develop carbon credit quantification methodology for ESCO projects',
      },
    ],
  },
  lessonsLearned: {
    slideTitle: 'Thailand - Lessons from Market',
    subtitle: 'What previous entrants learned about Thailand energy services market',
    failures: [
      {
        company: 'EnerTech Solutions (US)',
        year: '2018',
        reason:
          'Attempted greenfield entry without local partner; failed to win any government contracts in 2 years',
        lesson: 'Government channel requires established local partner',
      },
      {
        company: 'China Energy Services Group',
        year: '2019',
        reason:
          'Aggressive low-price strategy eroded margins; exited after 18 months with THB 50M loss',
        lesson: 'Price competition alone is unsustainable in relationship-driven Thai market',
      },
      {
        company: 'German ESCO GmbH',
        year: '2016',
        reason:
          'Over-engineered solutions for Thai market; average project cost 2x local competitors',
        lesson: 'Right-size technology for local conditions and budgets',
      },
    ],
    successFactors: [
      'Local partner with government relationships is non-negotiable for public sector access',
      'Guaranteed energy savings performance contracts build trust faster than consulting-only approaches',
      'Thai decision-making is relationship-driven — invest 6-12 months in relationship building before expecting signed contracts',
      'BOI promotion should be obtained early — retroactive application is not possible',
    ],
    warningSignsToWatch: [
      'New government energy minister may shift policy priorities — monitor cabinet reshuffle impacts',
      'Rising interest rates could squeeze ESCO financing margins — stress-test deal models at 8% cost of capital',
      'Chinese ESCO competitors re-entering market with improved offerings and BRI financing — monitor pricing pressure',
    ],
  },
  recommendation:
    'Proceed with conditional market entry via Joint Venture with Absolute Clean Energy (ACE). Prioritize DEDE ESCO registration, BOI promotion application, and 3 pilot projects in Japanese manufacturing segment. Total Phase 1 investment of USD 5-8M with expected breakeven at 30-36 months.',
};

// ============ ASSEMBLE & GENERATE ============

const countryAnalysis = {
  country: 'Thailand',
  policy,
  market,
  competitors,
  depth,
  summary: summaryData,
};

const synthesis = {
  isSingleCountry: true,
  country: 'Thailand',
  executiveSummary:
    'Thailand presents a compelling market entry opportunity for Energy Services, driven by rising industrial energy costs, government mandates for building retrofits, and a critical 18-month window created by carbon tax legislation and Japanese FDI surge. The ESCO market is valued at THB 8.5B (2023) growing 15% annually, with projected THB 12B+ by 2027. A Joint Venture with Absolute Clean Energy (ACE) is recommended as the optimal entry strategy, balancing speed-to-market with risk management. Key success factors include securing DEDE ESCO registration, obtaining BOI promotion for tax incentives, and establishing pilot projects with Japanese manufacturers in the Eastern Seaboard industrial estates. Total Phase 1 investment of USD 5-8M with expected breakeven at 30-36 months and IRR of 18-22%. The regulatory environment is favorable with established BOI framework, though bureaucratic delays and political transitions warrant monitoring.',
};

const scope = {
  industry: 'Energy Services',
  projectType: 'market-entry',
  targetMarkets: ['Thailand'],
};

async function main() {
  console.log('Generating test PPT using production generateSingleCountryPPT()...');

  // Content-size check: compact oversized fields before building (mirrors server.js path)
  const sizeCheckResult = runContentSizeCheck(countryAnalysis, { dryRun: false });
  const buildAnalysis =
    sizeCheckResult.compactionLog.length > 0 ? sizeCheckResult.payload : countryAnalysis;
  if (sizeCheckResult.compactionLog.length > 0) {
    console.log(
      `[Content Size Check] Compacted ${sizeCheckResult.compactionLog.length} field(s), risk=${sizeCheckResult.report.risk}`
    );
  }

  const buffer = await generateSingleCountryPPT(synthesis, buildAnalysis, scope);
  const outputPath = path.join(__dirname, 'test-output.pptx');
  fs.writeFileSync(outputPath, buffer);
  console.log(`Generated ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error('Test generation failed:', err);
  process.exit(1);
});
