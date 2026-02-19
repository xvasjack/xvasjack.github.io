'use strict';

/**
 * Enhanced Stress Lab — 300+ seed deterministic perturbation harness
 * with full phase telemetry, failure clustering, and seed replay.
 *
 * Builds on stress-test-harness.js with:
 * - 7 mutation classes (vs 4)
 * - Per-seed phase telemetry (which phase failed, stack trace, duration)
 * - Aggregate stats (failure rate per phase, p50/p95 duration)
 * - Deterministic seed replay via CLI
 */

const { generateSingleCountryPPT } = require('./deck-builder-single');
const { runContentSizeCheck } = require('./content-size-check');
const { isTransientKey } = require('./cleanup-temp-fields');
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

// ============ SEED SCENARIO DIVERSITY ============

const SEED_COUNTRIES = [
  'Test Country',
  'Emerging Market Alpha',
  'Developed Market Beta',
  'Frontier Market Gamma',
  'Island Nation Delta',
  'Landlocked Economy Epsilon',
];

const SEED_INDUSTRIES = [
  'Test Industry',
  'Renewable Energy',
  'Healthcare Services',
  'Fintech Solutions',
  'Logistics & Supply Chain',
  'Agricultural Technology',
];

const SEED_PROJECT_TYPES = [
  'market-entry',
  'market-expansion',
  'competitive-assessment',
  'due-diligence',
];

/**
 * Deterministically select scenario metadata for a seed.
 * Different seeds get different country/industry/project combinations,
 * ensuring diversity across the full seed range.
 */
function getSeedScenario(seed) {
  const rng = mulberry32(seed * 4217);
  const country = SEED_COUNTRIES[Math.floor(rng() * SEED_COUNTRIES.length)];
  const industry = SEED_INDUSTRIES[Math.floor(rng() * SEED_INDUSTRIES.length)];
  const projectType = SEED_PROJECT_TYPES[Math.floor(rng() * SEED_PROJECT_TYPES.length)];
  // Vary data shape: number of competitors, chart series length, etc.
  const competitorCount = 1 + Math.floor(rng() * 5); // 1-5
  const chartYears = 3 + Math.floor(rng() * 5); // 3-7
  const actCount = 1 + Math.floor(rng() * 4); // 1-4
  return { country, industry, projectType, competitorCount, chartYears, actCount };
}

// ============ DEFAULT SEED COUNTS ============

const DEFAULT_SEEDS = 30;
const DEEP_SEEDS = 300;

// ============ BASE PAYLOAD ============

function buildBasePayload(seed) {
  const scenario = seed != null ? getSeedScenario(seed) : null;
  const country = scenario ? scenario.country : 'Test Country';
  const industry = scenario ? scenario.industry : 'Test Industry';
  const projectType = scenario ? scenario.projectType : 'market-entry';
  const policy = {
    foundationalActs: {
      slideTitle: `${country} - Foundational Acts`,
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
      slideTitle: `${country} - National Policy`,
      policyDirection: `${country} targets 30% improvement by 2036 under the National Development Plan`,
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
      ],
      keyInitiatives: [
        'Smart Infrastructure Development Program with 15.6B investment',
        'Circular Economy Model integrating sustainable strategies',
        'Regulatory Sandbox for innovative pilot projects',
      ],
    },
    investmentRestrictions: {
      slideTitle: `${country} - Foreign Investment Rules`,
      ownershipLimits: {
        general: '49% foreign ownership cap under Foreign Business Act',
        exceptions: 'Promoted projects may receive 100% foreign ownership',
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
      ],
      riskLevel: 'Medium-Low',
      riskJustification:
        'Stable regulatory environment with established framework; main risks are bureaucratic delays',
    },
  };

  const market = {
    tpes: {
      slideTitle: `${country} - Total Primary Supply`,
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
    },
    finalDemand: {
      slideTitle: `${country} - Final Demand`,
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
    },
    electricity: {
      slideTitle: `${country} - Electricity & Power`,
      keyInsight: 'Peak demand growing 3.2% annually; capacity additions accelerating',
      demandGrowth: '3.2% CAGR 2020-2023',
      totalCapacity: '53.7 GW installed (2023)',
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
    },
    pricing: {
      slideTitle: `${country} - Pricing`,
      keyInsight: 'Industrial rates rising 12% in 2023',
      chartData: {
        categories: ['2019', '2020', '2021', '2022', '2023'],
        series: [
          { name: 'Industrial Rate', values: [3.12, 2.98, 3.21, 3.58, 4.01] },
          { name: 'Commercial Rate', values: [3.85, 3.72, 3.95, 4.32, 4.78] },
          { name: 'Residential Rate', values: [2.95, 2.88, 3.05, 3.38, 3.72] },
        ],
        unit: 'Currency/kWh',
      },
    },
    escoMarket: {
      slideTitle: `${country} - Services Market`,
      keyInsight: 'Market growing 15% annually',
      marketSize: '8.5 billion (2023)',
      growthRate: '15% CAGR 2020-2023',
      chartData: {
        categories: ['2019', '2020', '2021', '2022', '2023'],
        series: [
          { name: 'Government', values: [1.8, 1.5, 2.1, 2.8, 3.4] },
          { name: 'Industrial', values: [1.2, 1.0, 1.4, 1.9, 2.5] },
          { name: 'Commercial', values: [0.8, 0.6, 0.9, 1.2, 1.6] },
        ],
        unit: 'Billion',
      },
    },
  };

  const competitors = {
    japanesePlayers: {
      slideTitle: `${country} - Japanese Companies`,
      marketInsight: 'Japanese firms hold 22% of industrial market',
      players: [
        {
          name: 'Japan Corp Alpha',
          presence: 'Since 1990, 3 facilities',
          description:
            'Leading provider with 12.5B revenue. Controls 28% of commercial market through integrated management solutions. Annual growth of 8% driven by modernization projects.',
          entryYear: '1990',
          revenue: '12.5B',
          strategicAssessment: 'Strong position in OEM segment',
        },
        {
          name: 'Japan Corp Beta',
          presence: 'Since 2001, 2 offices',
          description:
            'Grid modernization specialist with 4.2B revenue. Focuses on power quality and distribution solutions. Revenue grew 15% in 2023.',
          entryYear: '2001',
          revenue: '4.2B',
          strategicAssessment: 'Technology leader but premium pricing limits SME market access',
        },
      ],
    },
    localMajor: {
      slideTitle: `${country} - Major Local Players`,
      concentration: 'Top 5 local players hold 45% of domestic market',
      players: [
        {
          name: 'Local Corp Alpha',
          type: 'Listed company',
          revenue: '8.2B',
          marketShare: '15%',
          description:
            'Largest local player by project count with 300+ completed contracts across government and industrial segments. Revenue grew 22% YoY.',
          strategicAssessment: 'Market leader with government relationships',
        },
        {
          name: 'Local Corp Beta',
          type: 'Listed conglomerate',
          revenue: '15.1B',
          marketShare: '8%',
          description:
            'Diversified group expanding into services from existing base. Total revenue 15.1B with services segment growing 35%.',
          strategicAssessment: 'Financial strength and existing customer base',
        },
      ],
    },
    foreignPlayers: {
      slideTitle: `${country} - Foreign Companies`,
      competitiveInsight: 'European players dominate technical consulting',
      players: [
        {
          name: 'Foreign Corp Alpha',
          origin: 'France',
          mode: 'Wholly-owned subsidiary',
          entryYear: '1998',
          revenue: '9.8B',
          description:
            'Market leader in building management and automation with 9.8B revenue. Platform deployed in 500+ buildings. Recent focus on data center optimization.',
          strategicAssessment: 'Dominant technology position',
        },
        {
          name: 'Foreign Corp Beta',
          origin: 'Germany',
          mode: 'Joint venture with local partner',
          entryYear: '2005',
          revenue: '5.5B',
          description:
            'Infrastructure services and grid solutions specialist with growing services division. 5.5B revenue with 18% growth in digital services.',
          strategicAssessment: 'Strong in heavy industry',
        },
      ],
    },
    caseStudy: {
      slideTitle: `${country} - Market Entry Case Study`,
      company: 'Global Services Corp',
      entryYear: '2010',
      entryMode: 'Acquisition of local utility',
      investment: 'USD 180M total',
      outcome: 'Achieved profitability by Year 3 with 4.2B revenue by 2023.',
      applicability: 'Demonstrates acquisition-led entry can accelerate market access',
      keyLessons: [
        'Retain local management for relationship continuity',
        'Start with adjacent service to build trust',
        'Government contracts provide stable base revenue',
      ],
    },
    maActivity: {
      slideTitle: `${country} - M&A Activity`,
      valuationMultiples: '8-12x EBITDA for services companies',
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
      ],
    },
  };

  const depth = {
    dealEconomics: {
      slideTitle: `${country} - Deal Economics`,
      keyInsight: 'Average deal size 25M with 18-22% IRR',
      typicalDealSize: { min: '5M', max: '80M', average: '25M' },
      contractTerms: {
        duration: '5-10 years',
        revenueSplit: '70/30 provider/client',
        guaranteeStructure: 'Minimum 15% savings guarantee',
      },
      financials: {
        paybackPeriod: '3.2 years average',
        irr: '18-22%',
        marginProfile: 'Gross margin 35-42%',
      },
    },
    partnerAssessment: {
      slideTitle: `${country} - Partner Assessment`,
      recommendedPartner: 'Partner Alpha',
      partners: [
        {
          name: 'Partner Alpha',
          type: 'Listed services company',
          revenue: '9.1B',
          partnershipFit: 4,
          acquisitionFit: 3,
          description: 'Subsidiary focused on clean solutions with 250+ commercial projects.',
        },
        {
          name: 'Partner Beta',
          type: 'Industrial utilities provider',
          revenue: '7.5B',
          partnershipFit: 3,
          acquisitionFit: 4,
          description: 'Leading industrial estate utilities provider with 95% uptime record.',
        },
      ],
    },
    entryStrategy: {
      slideTitle: `${country} - Entry Strategy Options`,
      recommendation: 'Joint Venture with local partner recommended',
      options: [
        {
          mode: 'Joint Venture',
          timeline: '6-12 months',
          investment: 'USD 15-25M',
          riskLevel: 'Medium',
          pros: ['Immediate local market access', 'Shared regulatory burden'],
          cons: ['Shared decision-making', 'Potential culture clashes'],
        },
        {
          mode: 'Acquisition',
          timeline: '12-18 months',
          investment: 'USD 30-50M',
          riskLevel: 'Medium-High',
          pros: ['Full control', 'Immediate revenue stream'],
          cons: ['High upfront capital', 'Integration risk'],
        },
      ],
      harveyBalls: {
        criteria: ['Speed to Market', 'Investment Required', 'Market Access'],
        jv: [4, 3, 5],
        acquisition: [3, 1, 4],
        greenfield: [1, 4, 1],
      },
    },
    implementation: {
      slideTitle: `${country} - Implementation Roadmap`,
      totalInvestment: 'USD 20-35M over 3 years',
      breakeven: '30-36 months',
      phases: [
        {
          name: 'Phase 1: Market Entry',
          activities: ['Establish entity', 'Obtain regulatory promotion', 'Hire core team'],
          milestones: ['Regulatory approval obtained', 'First pilot project signed'],
          investment: 'USD 5-8M',
        },
        {
          name: 'Phase 2: Scale Operations',
          activities: ['Expand to 50+ team', 'Build pipeline to 20+ opportunities'],
          milestones: ['10th project completed', 'Revenue reaches 500M'],
          investment: 'USD 8-12M',
        },
      ],
    },
    targetSegments: {
      slideTitle: `${country} - Target Customer Segments`,
      goToMarketApproach: 'Land-and-expand strategy starting with foreign manufacturers',
      segments: [
        {
          name: 'Foreign Manufacturers',
          size: '2.8B addressable',
          marketIntensity: 'High',
          priority: 5,
        },
        {
          name: 'Industrial Estates',
          size: '4.2B addressable',
          marketIntensity: 'Very High',
          priority: 4,
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
        action: 'Target top 50 intensive operations',
      },
      {
        opportunity: 'Government building retrofit mandate covering 5,000+ facilities',
        size: '3.5B government pipeline',
        timing: '2025-2028',
        action: 'Register as approved service provider',
      },
    ],
    obstacles: [
      {
        obstacle: 'Market fragmented with 45+ competitors',
        severity: 'High',
        mitigation: 'Differentiate on technology and guaranteed savings',
      },
      {
        obstacle: 'Complex licensing requirements add 6-9 months',
        severity: 'Medium',
        mitigation: 'Engage specialist legal counsel immediately',
      },
    ],
    keyInsights: [
      {
        title: 'Cost pressure creating urgency across manufacturing sector',
        data: 'Wages rose 8% annually 2021-2024 while costs increased 12%',
        pattern: 'Double cost squeeze accelerates demand.',
        implication: 'Position services as cost management tool.',
        timing: 'Move by Q2 2026',
      },
      {
        title: 'Smart city program unlocking 15B in integrated management contracts',
        data: 'National initiative designating 30 pilot cities by 2027',
        pattern: 'Policy creates market.',
        implication: 'Obtain registration immediately.',
        timing: 'Phase 1 RFPs issuing Q3 2025',
      },
    ],
    ratings: {
      attractiveness: 8,
      feasibility: 7,
      attractivenessRationale: 'Large addressable market (12B+) with strong growth drivers',
      feasibilityRationale: 'Established market with clear regulatory framework',
    },
    goNoGo: {
      overallVerdict: 'CONDITIONAL GO',
      conditions: ['Secure local partner by Q2 2025', 'Obtain regulatory promotion'],
      criteria: [
        {
          criterion: 'Market Size > USD 500M',
          met: true,
          evidence: '12B and growing 15% annually',
        },
        {
          criterion: 'Regulatory Environment Favorable',
          met: true,
          evidence: 'Incentive framework and registration program',
        },
        {
          criterion: 'Political Stability',
          met: false,
          evidence: 'Recent government transition creates policy uncertainty',
        },
      ],
    },
    timingIntelligence: {
      slideTitle: `${country} - Why Now?`,
      windowOfOpportunity: 'Critical 18-month window (Q2 2025 - Q4 2026)',
      triggers: [
        {
          trigger: 'Regulatory Legislation',
          impact: 'Creates mandatory reporting and financial incentive',
          action: 'Begin pre-positioning by Q3 2025',
        },
        {
          trigger: 'Smart City Phase 1 RFPs',
          impact: '30 pilot cities releasing 5B in management contracts',
          action: 'Complete registration before Q3 2025',
        },
      ],
    },
    lessonsLearned: {
      slideTitle: `${country} - Lessons from Market`,
      failures: [
        {
          company: 'Failed Entrant Alpha (US)',
          year: '2018',
          reason: 'Attempted greenfield entry without local partner',
          lesson: 'Government channel requires established local partner',
        },
      ],
      successFactors: [
        'Local partner with government relationships is non-negotiable',
        'Guaranteed performance contracts build trust faster',
      ],
    },
    recommendation:
      'Proceed with conditional market entry via Joint Venture with Local Corp Alpha.',
  };

  const countryAnalysis = { country, policy, market, competitors, depth, summary };

  const synthesis = {
    isSingleCountry: true,
    country,
    executiveSummary: `${country} presents a compelling market entry opportunity for ${industry} services.`,
  };

  const scope = {
    industry,
    projectType,
    targetMarkets: [country],
  };

  return { synthesis, countryAnalysis, scope };
}

// ============ MUTATION ENGINE ============

const MUTATION_CLASSES = {
  'transient-keys': {
    name: 'Transient Keys',
    description: 'Inject section_N wrappers, _wasArray flags, deepen_* keys',
  },
  'schema-corruption': {
    name: 'Schema Corruption',
    description: 'Wrong types, missing required fields, extra fields',
  },
  'geometry-override': {
    name: 'Geometry Override Conflicts',
    description: 'Route table data to chart slides, vice versa',
  },
  'long-text': {
    name: 'Long Text Extremes',
    description: '10K+ char strings in various fields',
  },
  'table-density': {
    name: 'Table Density Extremes',
    description: '50+ row tables, 20+ column tables, wide cells',
  },
  'chart-anomalies': {
    name: 'Chart Data Anomalies',
    description: 'All-zero, negative in stacked, non-numeric values',
  },
  'empty-null': {
    name: 'Empty/Null Sections',
    description: 'Missing entire sections, null values in arrays',
  },
};

const MUTATION_CLASS_KEYS = Object.keys(MUTATION_CLASSES);

// ============ PATH HELPERS ============

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

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

function collectObjectPaths(obj, prefix, results) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  results.push([...prefix]);
  for (const [key, val] of Object.entries(obj)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      collectObjectPaths(val, prefix.concat(key), results);
    }
  }
}

function getAtPath(obj, pathArr) {
  let current = obj;
  for (const key of pathArr) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

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

// ============ MUTATION CLASS: TRANSIENT KEYS ============

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

function applyTransientKeyMutations(payload, rng) {
  const objectPaths = [];
  collectObjectPaths(payload, [], objectPaths);
  if (objectPaths.length === 0) return;

  const count = 3 + Math.floor(rng() * 8); // 3-10 transient keys
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

// ============ MUTATION CLASS: SCHEMA CORRUPTION ============

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

function applySchemaCorruptionMutations(payload, rng) {
  // Wrong types for string fields
  const stringPaths = [];
  collectStringPaths(payload, [], stringPaths);
  const stringTargetCount = 2 + Math.floor(rng() * 5);
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

  // Add extra unexpected fields
  const objectPaths = [];
  collectObjectPaths(payload, [], objectPaths);
  const extraCount = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < Math.min(extraCount, objectPaths.length); i++) {
    const targetPath = objectPaths[Math.floor(rng() * objectPaths.length)];
    const target = getAtPath(payload, targetPath);
    if (target && typeof target === 'object' && !Array.isArray(target)) {
      target['__extraField_' + Math.floor(rng() * 1000)] = { unexpected: true, value: rng() };
    }
  }
}

// ============ MUTATION CLASS: GEOMETRY OVERRIDE CONFLICTS ============

function applyGeometryOverrideMutations(payload, rng) {
  const ca = payload.countryAnalysis;
  if (!ca) return;

  // Inject chart data into sections that normally expect table data
  const tableBlockKeys = ['dealEconomics', 'partnerAssessment', 'targetSegments'];
  for (const key of tableBlockKeys) {
    if (rng() > 0.4) continue;
    const section = ca.depth && ca.depth[key];
    if (section && typeof section === 'object') {
      section.chartData = {
        categories: ['2020', '2021', '2022', '2023', '2024'],
        series: [{ name: 'Injected Series', values: [10, 20, 30, 40, 50] }],
        unit: 'Injected',
      };
      section._forceChartLayout = true;
    }
  }

  // Inject table data into sections that normally expect chart data
  const chartBlockKeys = ['tpes', 'finalDemand', 'electricity', 'pricing'];
  for (const key of chartBlockKeys) {
    if (rng() > 0.4) continue;
    const section = ca.market && ca.market[key];
    if (section && typeof section === 'object') {
      section.tableData = [
        { label: 'Injected Row 1', value: '100', growth: '5%' },
        { label: 'Injected Row 2', value: '200', growth: '10%' },
      ];
      section._forceTableLayout = true;
      // Optionally remove chart data to force table route
      if (rng() > 0.5) {
        delete section.chartData;
      }
    }
  }
}

// ============ MUTATION CLASS: LONG TEXT EXTREMES ============

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

function applyLongTextMutations(payload, rng) {
  const stringPaths = [];
  collectStringPaths(payload, [], stringPaths);
  const targetPaths = stringPaths.filter((p) => {
    const lastKey = p[p.length - 1];
    return typeof lastKey === 'string' && LONG_STRING_TARGET_FIELDS.some((f) => lastKey === f);
  });
  if (targetPaths.length === 0) return;

  const count = 1 + Math.floor(rng() * Math.min(5, targetPaths.length));
  const shuffled = [...targetPaths].sort(() => rng() - 0.5);
  for (let i = 0; i < count; i++) {
    // Generate strings of 5K, 10K, or 15K chars
    const lenOptions = [5000, 10000, 15000];
    const len = lenOptions[Math.floor(rng() * lenOptions.length)];
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ';
    let text = '';
    for (let j = 0; j < len; j++) {
      text += chars[Math.floor(rng() * chars.length)];
    }
    setAtPath(payload, shuffled[i], text);
  }
}

// ============ MUTATION CLASS: TABLE DENSITY EXTREMES ============

function applyTableDensityMutations(payload, rng) {
  const ca = payload.countryAnalysis;
  if (!ca) return;

  // Inject oversized tables into market sections
  const sectionKeys = Object.keys(ca.market || {});
  if (sectionKeys.length === 0) return;

  const targetKey = sectionKeys[Math.floor(rng() * sectionKeys.length)];
  const section = ca.market[targetKey];
  if (!section || typeof section !== 'object') return;

  // Choose extreme dimension
  const variant = Math.floor(rng() * 3);
  if (variant === 0) {
    // 50+ row table
    const rowCount = 50 + Math.floor(rng() * 20);
    const longCell = 'Market data with extended analysis detail. '.repeat(5);
    section.tableData = Array.from({ length: rowCount }, (_, i) => ({
      segment: `Segment ${i + 1}`,
      value: `$${(Math.random() * 1000).toFixed(1)}M`,
      growth: `${(Math.random() * 20).toFixed(1)}%`,
      detail: longCell,
    }));
  } else if (variant === 1) {
    // 20+ column table
    const colCount = 20 + Math.floor(rng() * 5);
    const rows = Array.from({ length: 5 }, (_, i) => {
      const row = {};
      for (let c = 0; c < colCount; c++) {
        row[`col_${c}`] = `Value_${i}_${c}_${Math.floor(rng() * 100)}`;
      }
      return row;
    });
    section.tableData = rows;
  } else {
    // Very wide cells (1000+ chars per cell)
    const wideCell = 'X'.repeat(1000 + Math.floor(rng() * 2000));
    section.tableData = [
      { a: wideCell, b: wideCell, c: wideCell },
      { a: wideCell, b: wideCell, c: wideCell },
      { a: wideCell, b: wideCell, c: wideCell },
    ];
  }
}

// ============ MUTATION CLASS: CHART DATA ANOMALIES ============

function applyChartAnomalyMutations(payload, rng) {
  const ca = payload.countryAnalysis;
  if (!ca || !ca.market) return;

  const sectionsWithCharts = Object.entries(ca.market).filter(
    ([, v]) => v && typeof v === 'object' && v.chartData
  );
  if (sectionsWithCharts.length === 0) return;

  for (const [, section] of sectionsWithCharts) {
    if (rng() > 0.5) continue;
    const anomalyType = Math.floor(rng() * 4);

    if (anomalyType === 0 && section.chartData.series) {
      // All-zero values
      for (const s of Array.isArray(section.chartData.series) ? section.chartData.series : []) {
        if (Array.isArray(s.values)) {
          s.values = s.values.map(() => 0);
        }
      }
    } else if (anomalyType === 1 && section.chartData.series) {
      // Negative values in stacked data
      section.chartData.stacked = true;
      for (const s of Array.isArray(section.chartData.series) ? section.chartData.series : []) {
        if (Array.isArray(s.values)) {
          s.values = s.values.map((v) => (rng() > 0.5 ? -Math.abs(v) : v));
        }
      }
    } else if (anomalyType === 2 && section.chartData.series) {
      // Non-numeric values
      for (const s of Array.isArray(section.chartData.series) ? section.chartData.series : []) {
        if (Array.isArray(s.values)) {
          s.values = s.values.map((v) => (rng() > 0.4 ? (rng() > 0.5 ? 'NaN' : null) : v));
        }
      }
    } else if (anomalyType === 3) {
      // Replace series with non-array
      section.chartData.series = rng() > 0.5 ? 'not-an-array' : { invalid: true };
    }
  }
}

// ============ MUTATION CLASS: EMPTY/NULL SECTIONS ============

const DELETABLE_SECTIONS = [
  'countryAnalysis.policy',
  'countryAnalysis.market',
  'countryAnalysis.competitors',
  'countryAnalysis.depth',
  'countryAnalysis.summary',
  'countryAnalysis.competitors.japanesePlayers',
  'countryAnalysis.competitors.caseStudy',
  'countryAnalysis.competitors.maActivity',
  'countryAnalysis.summary.keyInsights',
  'countryAnalysis.summary.timingIntelligence',
  'countryAnalysis.summary.lessonsLearned',
  'countryAnalysis.depth.partnerAssessment',
  'countryAnalysis.depth.targetSegments',
];

function applyEmptyNullMutations(payload, rng) {
  // Delete entire sections
  for (const sectionPath of DELETABLE_SECTIONS) {
    if (rng() > 0.7) continue;
    const parts = sectionPath.split('.');
    const parentPath = parts.slice(0, -1);
    const key = parts[parts.length - 1];
    const parent = getAtPath(payload, parentPath);
    if (parent && typeof parent === 'object') {
      if (rng() > 0.5) {
        delete parent[key]; // full delete
      } else {
        parent[key] = null; // set to null
      }
    }
  }

  // Inject nulls into arrays
  const arrayPaths = [];
  collectArrayPaths(payload, [], arrayPaths);
  const nullTargets = arrayPaths.filter(() => rng() > 0.7);
  for (const arrPath of nullTargets.slice(0, 5)) {
    const arr = getAtPath(payload, arrPath);
    if (Array.isArray(arr) && arr.length > 0) {
      const idx = Math.floor(rng() * arr.length);
      arr[idx] = null;
    }
  }

  // Replace some objects with empty {}
  const objectPaths = [];
  collectObjectPaths(payload, [], objectPaths);
  const emptyTargets = objectPaths.filter((p) => p.length >= 3 && rng() > 0.85);
  for (const objPath of emptyTargets.slice(0, 3)) {
    const parentPath = objPath.slice(0, -1);
    const key = objPath[objPath.length - 1];
    const parent = getAtPath(payload, parentPath);
    if (parent && typeof parent === 'object' && typeof key === 'string') {
      parent[key] = {};
    }
  }
}

// ============ MUTATION DISPATCH ============

const MUTATION_APPLIERS = {
  'transient-keys': applyTransientKeyMutations,
  'schema-corruption': applySchemaCorruptionMutations,
  'geometry-override': applyGeometryOverrideMutations,
  'long-text': applyLongTextMutations,
  'table-density': applyTableDensityMutations,
  'chart-anomalies': applyChartAnomalyMutations,
  'empty-null': applyEmptyNullMutations,
};

/**
 * Fisher-Yates shuffle using seeded RNG (deterministic).
 */
function fisherYatesShuffle(arr, rng) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Select 2-4 mutation classes for a given seed (deterministic).
 */
function selectMutationsForSeed(seed) {
  const rng = mulberry32(seed * 7919);
  const count = 2 + Math.floor(rng() * 3); // 2, 3, or 4
  const shuffled = fisherYatesShuffle(MUTATION_CLASS_KEYS, rng);
  return shuffled.slice(0, count);
}

/**
 * Apply mutations to a deep-cloned payload based on seed.
 */
function mutatePayload(basePayload, seed) {
  const payload = deepClone(basePayload);
  const rng = mulberry32(seed);
  const classes = selectMutationsForSeed(seed);

  for (const cls of classes) {
    const applier = MUTATION_APPLIERS[cls];
    if (applier) {
      applier(payload, rng);
    }
  }

  return { payload, mutationClasses: classes };
}

// ============ ERROR CLASSIFICATION ============

const DATA_GATE_PATTERNS = [
  /\[PPT\] Data gate failed/i,
  /\[PPT\] Cell text exceeds hard cap/i,
  /\[PPT TEMPLATE\] Missing table geometry/i,
  /Build normalization rejected/i,
  /not-buildable groups/i,
  /thin placeholder/i,
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
  for (const pattern of RUNTIME_CRASH_PATTERNS) {
    if (pattern.test(msg)) return 'runtime-crash';
  }
  for (const pattern of DATA_GATE_PATTERNS) {
    if (pattern.test(msg)) return 'data-gate';
  }
  if (/\[PPT/.test(msg)) return 'data-gate';
  return 'runtime-crash';
}

// ============ PIPELINE PHASES ============

const PHASES = ['build-payload', 'content-size-check', 'build-ppt', 'validate-pptx'];

/**
 * Run a single seed through all pipeline phases, collecting telemetry.
 */
async function runSeed(seed) {
  const startTime = Date.now();
  const mutationClasses = selectMutationsForSeed(seed);
  const scenario = getSeedScenario(seed);
  const telemetry = {
    version: TELEMETRY_VERSION,
    seed,
    scenario: {
      country: scenario.country,
      industry: scenario.industry,
      projectType: scenario.projectType,
    },
    mutationClasses,
    phases: {},
    status: 'pass',
    error: null,
    errorClass: null,
    failedPhase: null,
    stack: null,
    durationMs: 0,
  };

  let synthesis, countryAnalysis, scope;
  let mutatedPayload;

  // Phase 1: Build & mutate payload
  const p1Start = Date.now();
  try {
    const base = buildBasePayload(seed);
    synthesis = base.synthesis;
    countryAnalysis = base.countryAnalysis;
    scope = base.scope;
    const result = mutatePayload({ synthesis, countryAnalysis, scope }, seed);
    mutatedPayload = result.payload;
    telemetry.phases['build-payload'] = { durationMs: Date.now() - p1Start, status: 'pass' };
  } catch (err) {
    telemetry.phases['build-payload'] = {
      durationMs: Date.now() - p1Start,
      status: 'fail',
      error: err.message,
    };
    telemetry.status = 'fail';
    telemetry.error = err.message;
    telemetry.errorClass = classifyError(err.message);
    telemetry.failedPhase = 'build-payload';
    telemetry.stack = err.stack;
    telemetry.durationMs = Date.now() - startTime;
    return telemetry;
  }

  // Phase 2: Content-size check
  const p2Start = Date.now();
  try {
    if (mutatedPayload.countryAnalysis) {
      const sizeCheckResult = runContentSizeCheck(mutatedPayload.countryAnalysis, { dryRun: false });
      if (sizeCheckResult.compactionLog.length > 0) {
        mutatedPayload.countryAnalysis = sizeCheckResult.payload;
      }
    }
    telemetry.phases['content-size-check'] = { durationMs: Date.now() - p2Start, status: 'pass' };
  } catch (err) {
    telemetry.phases['content-size-check'] = {
      durationMs: Date.now() - p2Start,
      status: 'fail',
      error: err.message,
    };
    telemetry.status = 'fail';
    telemetry.error = err.message;
    telemetry.errorClass = classifyError(err.message);
    telemetry.failedPhase = 'content-size-check';
    telemetry.stack = err.stack;
    telemetry.durationMs = Date.now() - startTime;
    return telemetry;
  }

  // Phase 3: Build PPT
  let buffer;
  const p3Start = Date.now();
  try {
    buffer = await generateSingleCountryPPT(
      mutatedPayload.synthesis || synthesis,
      mutatedPayload.countryAnalysis || countryAnalysis,
      mutatedPayload.scope || scope
    );
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('Not a buffer - got ' + typeof buffer);
    }
    if (buffer.length < 1000) {
      throw new Error('Buffer too small: ' + buffer.length + ' bytes');
    }
    telemetry.phases['build-ppt'] = { durationMs: Date.now() - p3Start, status: 'pass' };
  } catch (err) {
    telemetry.phases['build-ppt'] = {
      durationMs: Date.now() - p3Start,
      status: 'fail',
      error: err.message,
    };
    telemetry.status = 'fail';
    telemetry.error = err.message;
    telemetry.errorClass = classifyError(err.message);
    telemetry.failedPhase = 'build-ppt';
    telemetry.stack = err.stack;
    telemetry.durationMs = Date.now() - startTime;
    return telemetry;
  }

  // Phase 4: Validate PPTX
  const p4Start = Date.now();
  try {
    const zip = await JSZip.loadAsync(buffer);
    const entries = Object.keys(zip.files);
    if (!entries.some((e) => e.includes('ppt/slides/slide1.xml'))) {
      throw new Error('Missing slide1.xml in PPTX package');
    }
    if (!entries.some((e) => e.includes('[Content_Types].xml'))) {
      throw new Error('Missing [Content_Types].xml in PPTX package');
    }
    telemetry.phases['validate-pptx'] = { durationMs: Date.now() - p4Start, status: 'pass' };
  } catch (err) {
    telemetry.phases['validate-pptx'] = {
      durationMs: Date.now() - p4Start,
      status: 'fail',
      error: err.message,
    };
    telemetry.status = 'fail';
    telemetry.error = err.message;
    telemetry.errorClass = classifyError(err.message);
    telemetry.failedPhase = 'validate-pptx';
    telemetry.stack = err.stack;
    telemetry.durationMs = Date.now() - startTime;
    return telemetry;
  }

  telemetry.durationMs = Date.now() - startTime;
  return telemetry;
}

// ============ TELEMETRY SCHEMA VERSION ============

const TELEMETRY_VERSION = '2.0.0';

// ============ AGGREGATE STATS ============

function computePercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeAggregateStats(telemetryResults) {
  const stats = {
    version: TELEMETRY_VERSION,
    total: telemetryResults.length,
    passed: 0,
    failed: 0,
    runtimeCrashes: 0,
    dataGateRejections: 0,
    failuresByPhase: {},
    failuresByMutationClass: {},
    durationByPhase: {},
    overallDurations: [],
  };

  for (const phase of PHASES) {
    stats.failuresByPhase[phase] = 0;
    stats.durationByPhase[phase] = [];
  }

  for (const t of telemetryResults) {
    if (t.status === 'pass') {
      stats.passed++;
    } else {
      stats.failed++;
      if (t.errorClass === 'runtime-crash') stats.runtimeCrashes++;
      if (t.errorClass === 'data-gate') stats.dataGateRejections++;
      if (t.failedPhase) {
        if (typeof stats.failuresByPhase[t.failedPhase] !== 'number') {
          stats.failuresByPhase[t.failedPhase] = 0;
        }
        stats.failuresByPhase[t.failedPhase]++;
      }
      for (const cls of t.mutationClasses || []) {
        stats.failuresByMutationClass[cls] = (stats.failuresByMutationClass[cls] || 0) + 1;
      }
    }

    stats.overallDurations.push(t.durationMs);

    for (const phase of PHASES) {
      if (t.phases[phase]) {
        stats.durationByPhase[phase].push(t.phases[phase].durationMs);
      }
    }
  }

  // Compute percentiles
  stats.overallDurations.sort((a, b) => a - b);
  stats.p50Duration = computePercentile(stats.overallDurations, 50);
  stats.p95Duration = computePercentile(stats.overallDurations, 95);

  stats.phaseDurationStats = {};
  for (const phase of PHASES) {
    const durations = stats.durationByPhase[phase].sort((a, b) => a - b);
    stats.phaseDurationStats[phase] = {
      p50: computePercentile(durations, 50),
      p95: computePercentile(durations, 95),
      count: durations.length,
    };
  }

  return stats;
}

// ============ DETERMINISM CHECK ============

/**
 * Check determinism by running the same seed N times and comparing results.
 * Returns { deterministic: boolean, seed, runs, mismatches }
 */
async function checkDeterminism(seed, runs = 3) {
  const results = [];
  for (let i = 0; i < runs; i++) {
    const telemetry = await runSeed(seed);
    results.push(telemetry);
  }

  const mismatches = [];
  const baseline = results[0];
  for (let i = 1; i < results.length; i++) {
    const current = results[i];
    if (baseline.status !== current.status) {
      mismatches.push({ run: i, field: 'status', expected: baseline.status, got: current.status });
    }
    if (baseline.error !== current.error) {
      mismatches.push({ run: i, field: 'error', expected: baseline.error, got: current.error });
    }
    if (baseline.failedPhase !== current.failedPhase) {
      mismatches.push({
        run: i,
        field: 'failedPhase',
        expected: baseline.failedPhase,
        got: current.failedPhase,
      });
    }
    if (baseline.errorClass !== current.errorClass) {
      mismatches.push({
        run: i,
        field: 'errorClass',
        expected: baseline.errorClass,
        got: current.errorClass,
      });
    }
    // Check mutation classes are identical
    const baseClasses = (baseline.mutationClasses || []).join(',');
    const curClasses = (current.mutationClasses || []).join(',');
    if (baseClasses !== curClasses) {
      mismatches.push({
        run: i,
        field: 'mutationClasses',
        expected: baseClasses,
        got: curClasses,
      });
    }
  }

  return {
    deterministic: mismatches.length === 0,
    seed,
    runs,
    mismatches,
  };
}

// ============ TELEMETRY EXPORT ============

/**
 * Export telemetry results as machine-readable JSON.
 */
function exportTelemetryJSON(results) {
  const stats = computeAggregateStats(results);
  return JSON.stringify(
    {
      version: TELEMETRY_VERSION,
      generatedAt: new Date().toISOString(),
      stats,
      results: results.map((t) => ({
        version: TELEMETRY_VERSION,
        seed: t.seed,
        status: t.status,
        error: t.error,
        errorClass: t.errorClass,
        failedPhase: t.failedPhase,
        mutationClasses: t.mutationClasses,
        durationMs: t.durationMs,
        phases: t.phases,
      })),
    },
    null,
    2
  );
}

// ============ REPORT ============

function buildReport(telemetryResults, stats) {
  const lines = [];
  lines.push('# Stress Lab Report');
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- Seeds: 1-${stats.total}`);
  lines.push(`- Total: ${stats.total} | Passed: ${stats.passed} | Failed: ${stats.failed}`);
  lines.push(`- Runtime crashes (bugs): ${stats.runtimeCrashes}`);
  lines.push(`- Data-gate rejections (expected): ${stats.dataGateRejections}`);
  lines.push(`- Duration p50: ${stats.p50Duration}ms | p95: ${stats.p95Duration}ms`);
  lines.push('');

  // Phase failure breakdown
  lines.push('## Failures by Phase');
  lines.push('| Phase | Failures | p50 (ms) | p95 (ms) |');
  lines.push('|-------|----------|----------|----------|');
  for (const phase of PHASES) {
    const ps = stats.phaseDurationStats[phase];
    lines.push(`| ${phase} | ${stats.failuresByPhase[phase]} | ${ps.p50} | ${ps.p95} |`);
  }
  lines.push('');

  // Mutation class failure breakdown
  if (Object.keys(stats.failuresByMutationClass).length > 0) {
    lines.push('## Failures by Mutation Class');
    lines.push('| Mutation Class | Failures |');
    lines.push('|----------------|----------|');
    const sorted = Object.entries(stats.failuresByMutationClass).sort((a, b) => b[1] - a[1]);
    for (const [cls, count] of sorted) {
      lines.push(`| ${cls} | ${count} |`);
    }
    lines.push('');
  }

  // Failure details
  const failures = telemetryResults.filter((t) => t.status === 'fail');
  if (failures.length > 0) {
    lines.push('## Failure Details');
    lines.push('| Seed | Class | Phase | Mutations | Error |');
    lines.push('|------|-------|-------|-----------|-------|');
    for (const f of failures) {
      const errMsg = (f.error || 'Unknown').replace(/\|/g, '\\|').substring(0, 200);
      const cls = f.errorClass === 'runtime-crash' ? 'BUG' : 'gate';
      const mutations = (f.mutationClasses || []).join('+');
      lines.push(`| ${f.seed} | ${cls} | ${f.failedPhase || '?'} | ${mutations} | ${errMsg} |`);
    }
    lines.push('');
  }

  // Top crash signatures (from failure clustering)
  if (stats.topCrashSignatures && stats.topCrashSignatures.length > 0) {
    lines.push('## Top Crash Signatures');
    lines.push('| # | Risk | Count | Signature | Replay |');
    lines.push('|---|------|-------|-----------|--------|');
    for (let i = 0; i < stats.topCrashSignatures.length; i++) {
      const sig = stats.topCrashSignatures[i];
      const sigText = (sig.signature || '').substring(0, 60).replace(/\|/g, '\\|');
      const cls = (sig.errorClasses || []).includes('runtime-crash') ? 'BUG' : 'gate';
      lines.push(
        `| ${i + 1} | ${sig.riskScore} (${cls}) | ${sig.count} | ${sigText} | \`${sig.replayCommand}\` |`
      );
    }
    lines.push('');
  }

  // Scenario diversity coverage
  if (stats.scenarioCoverage) {
    lines.push('## Scenario Coverage');
    lines.push(`- Countries: ${stats.scenarioCoverage.countries.join(', ')}`);
    lines.push(`- Industries: ${stats.scenarioCoverage.industries.join(', ')}`);
    lines.push(`- Project Types: ${stats.scenarioCoverage.projectTypes.join(', ')}`);
    lines.push('');
  }

  const verdict = stats.runtimeCrashes === 0 ? 'PASS' : 'FAIL';
  lines.push(`## Result: ${verdict}`);
  if (stats.runtimeCrashes === 0 && stats.dataGateRejections > 0) {
    lines.push(
      `(All ${stats.dataGateRejections} failures are deliberate data-gate rejections, not runtime crashes)`
    );
  }

  return lines.join('\n');
}

// ============ MAIN RUNNER ============

async function runStressLab({
  seeds = DEFAULT_SEEDS,
  deep = false,
  reportPath = null,
  onProgress = null,
} = {}) {
  const seedCount = deep ? Math.max(seeds, DEEP_SEEDS) : seeds;
  const telemetryResults = [];

  for (let seed = 1; seed <= seedCount; seed++) {
    const telemetry = await runSeed(seed);
    telemetryResults.push(telemetry);
    if (onProgress) onProgress(seed, seedCount, telemetry);
  }

  const stats = computeAggregateStats(telemetryResults);

  // Integrate failure clustering
  const clusterAnalyzer = require('./failure-cluster-analyzer');
  const { clusters } = clusterAnalyzer.cluster(telemetryResults);
  const topBlockers = clusterAnalyzer.getTopBlockers(telemetryResults, 20);
  stats.topCrashSignatures = topBlockers.slice(0, 10).map((b) => ({
    signature: b.signature,
    count: b.count,
    riskScore: b.riskScore,
    representativeSeed: b.seeds[0],
    replayCommand: b.replayCommand,
    phases: b.phases,
    errorClasses: b.errorClasses,
  }));
  stats.clusterCount = clusters.length;

  // Compute scenario diversity coverage
  const scenarioCoverage = { countries: new Set(), industries: new Set(), projectTypes: new Set() };
  for (const t of telemetryResults) {
    if (t.scenario) {
      scenarioCoverage.countries.add(t.scenario.country);
      scenarioCoverage.industries.add(t.scenario.industry);
      scenarioCoverage.projectTypes.add(t.scenario.projectType);
    }
  }
  stats.scenarioCoverage = {
    countries: [...scenarioCoverage.countries],
    industries: [...scenarioCoverage.industries],
    projectTypes: [...scenarioCoverage.projectTypes],
  };

  const report = buildReport(telemetryResults, stats);

  if (reportPath) {
    const dir = path.dirname(reportPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(reportPath, report);
  }

  return {
    telemetry: telemetryResults,
    stats,
    report,
    topBlockers,
  };
}

/**
 * Replay a single seed — returns full telemetry for that seed.
 */
async function replaySeed(seed) {
  return runSeed(seed);
}

/**
 * Get mutation class definitions.
 */
function getMutationClasses() {
  return { ...MUTATION_CLASSES };
}

// ============ EXPORTS ============

module.exports = {
  runStressLab,
  replaySeed,
  getMutationClasses,
  checkDeterminism,
  exportTelemetryJSON,
  TELEMETRY_VERSION,
  DEFAULT_SEEDS,
  DEEP_SEEDS,
  // Internals for testing
  __test: {
    mulberry32,
    buildBasePayload,
    mutatePayload,
    selectMutationsForSeed,
    classifyError,
    computeAggregateStats,
    computePercentile,
    getSeedScenario,
    MUTATION_CLASS_KEYS,
    PHASES,
    SEED_COUNTRIES,
    SEED_INDUSTRIES,
    SEED_PROJECT_TYPES,
    deepClone,
    applyTransientKeyMutations,
    applySchemaCorruptionMutations,
    applyGeometryOverrideMutations,
    applyLongTextMutations,
    applyTableDensityMutations,
    applyChartAnomalyMutations,
    applyEmptyNullMutations,
  },
};

// ============ CLI ============

if (require.main === module) {
  const args = process.argv.slice(2);
  let seeds = DEFAULT_SEEDS;
  let deep = false;
  let singleSeed = null;
  let reportPath = null;

  for (const arg of args) {
    if (arg.startsWith('--seeds=') || arg.startsWith('--stress-seeds=')) {
      seeds = parseInt(arg.split('=')[1], 10) || DEFAULT_SEEDS;
    } else if (arg.startsWith('--seed=')) {
      singleSeed = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--deep' || arg === '--nightly') {
      deep = true;
    } else if (arg === '--quick') {
      deep = false;
      seeds = DEFAULT_SEEDS;
    } else if (arg.startsWith('--report=')) {
      reportPath = arg.split('=')[1];
    }
  }

  if (singleSeed !== null) {
    console.log(`Replaying seed ${singleSeed}...`);
    replaySeed(singleSeed)
      .then((telemetry) => {
        console.log(JSON.stringify(telemetry, null, 2));
        process.exit(telemetry.status === 'pass' ? 0 : 1);
      })
      .catch((err) => {
        console.error('Replay error:', err);
        process.exit(2);
      });
  } else {
    const effectiveSeeds = deep ? Math.max(seeds, DEEP_SEEDS) : seeds;
    if (!reportPath) {
      reportPath = path.join(__dirname, 'stress-lab-report.md');
    }

    const mode = deep ? 'deep/nightly' : 'quick';
    console.log(`Running stress lab in ${mode} mode with ${effectiveSeeds} seeds...`);
    const startTime = Date.now();

    runStressLab({
      seeds,
      deep,
      reportPath,
      onProgress: (current, total, t) => {
        if (current % 50 === 0 || current === total) {
          const pct = ((current / total) * 100).toFixed(0);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`  [${pct}%] ${current}/${total} seeds (${elapsed}s) - ${t.status}`);
        }
      },
    })
      .then((result) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('');
        console.log(result.report);
        console.log('');
        console.log(`Completed in ${elapsed}s`);
        console.log(`Report written to: ${reportPath}`);
        if (result.topBlockers && result.topBlockers.length > 0) {
          console.log(`Top ${result.topBlockers.length} crash signatures identified`);
        }
        process.exit(result.stats.runtimeCrashes > 0 ? 1 : 0);
      })
      .catch((err) => {
        console.error('Stress lab error:', err);
        process.exit(2);
      });
  }
}
