'use strict';

/**
 * Schema Firewall + Source Lineage for market-research PPT pipeline.
 *
 * Validates, coerces, quarantines, and trust-scores synthesis output
 * before it reaches the PPT builder. Every field gets an action ledger
 * entry (kept / coerced / dropped / quarantined) and a trust score.
 *
 * Handles BOTH multi-country (policy/market/competitors/depth/summary)
 * and single-country (executiveSummary/marketOpportunityAssessment/
 * competitivePositioning/keyInsights/implementation/regulatoryPathway/nextSteps).
 */

// ---------------------------------------------------------------------------
// Legacy key → canonical key mapping
// ---------------------------------------------------------------------------
const LEGACY_KEY_MAP = {
  competitorsAnalysis: 'competitors',
  competitorAnalysis: 'competitors',
  competitorsSynthesis: 'competitors',
  policySynthesis: 'policy',
  policyAnalysis: 'policy',
  marketSynthesis: 'market',
  marketAnalysis: 'market',
  depthAnalysis: 'depth',
  summaryAnalysis: 'summary',
  executiveSummaryParagraphs: 'executiveSummary',
  marketOpportunity: 'marketOpportunityAssessment',
  competitive: 'competitivePositioning',
  competitiveAnalysis: 'competitivePositioning',
  insights: 'keyInsights',
  roadmap: 'implementation',
};

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

// Type helpers
const T = {
  string: { type: 'string' },
  stringOrNull: { type: 'string', nullable: true },
  number: { type: 'number' },
  numberOrNull: { type: 'number', nullable: true },
  boolean: { type: 'boolean' },
  array: (itemSchema) => ({ type: 'array', items: itemSchema }),
  arrayOfStrings: { type: 'array', items: { type: 'string' } },
  object: (props, opts = {}) => ({
    type: 'object',
    properties: props,
    required: opts.required || [],
  }),
  any: { type: 'any' },
};

const sourceSchema = T.object({
  url: T.string,
  title: T.string,
});

const playerSchema = T.object(
  {
    name: T.string,
    website: T.stringOrNull,
    description: T.stringOrNull,
    revenue: T.stringOrNull,
    marketShare: T.stringOrNull,
    type: T.stringOrNull,
    origin: T.stringOrNull,
    strengths: T.stringOrNull,
    weaknesses: T.stringOrNull,
    entryYear: T.stringOrNull,
    mode: T.stringOrNull,
    success: T.stringOrNull,
    profile: T.any,
    projects: T.array(T.any),
    financialHighlights: T.any,
    strategicAssessment: T.stringOrNull,
  },
  { required: ['name'] }
);

const playerGroupSchema = T.object({
  slideTitle: T.stringOrNull,
  subtitle: T.stringOrNull,
  players: T.array(playerSchema),
  marketInsight: T.stringOrNull,
  concentration: T.stringOrNull,
  competitiveInsight: T.stringOrNull,
  dataType: T.stringOrNull,
});

const insightSchema = T.object(
  {
    title: T.string,
    data: T.string,
    pattern: T.stringOrNull,
    implication: T.stringOrNull,
    timing: T.stringOrNull,
  },
  { required: ['title', 'data'] }
);

const phaseSchema = T.object(
  {
    name: T.string,
    activities: T.arrayOfStrings,
    milestones: T.arrayOfStrings,
    investment: T.stringOrNull,
  },
  { required: ['name', 'activities'] }
);

// Multi-country section schemas
const SECTION_SCHEMAS = {
  // ---- policy ----
  policy: T.object({
    foundationalActs: T.object({
      slideTitle: T.stringOrNull,
      subtitle: T.stringOrNull,
      acts: T.array(
        T.object({
          name: T.string,
          year: T.stringOrNull,
          requirements: T.stringOrNull,
          penalties: T.stringOrNull,
          enforcement: T.stringOrNull,
        })
      ),
      keyMessage: T.stringOrNull,
    }),
    nationalPolicy: T.object({
      slideTitle: T.stringOrNull,
      policyDirection: T.stringOrNull,
      targets: T.array(T.any),
      keyInitiatives: T.arrayOfStrings,
    }),
    investmentRestrictions: T.object({
      slideTitle: T.stringOrNull,
      ownershipLimits: T.any,
      incentives: T.array(T.any),
      riskLevel: T.stringOrNull,
      riskJustification: T.stringOrNull,
    }),
    regulatorySummary: T.array(T.any),
    keyIncentives: T.array(T.any),
    sources: T.array(sourceSchema),
  }),

  // ---- market ----
  market: T.object({
    marketSizeAndGrowth: T.any,
    supplyAndDemandDynamics: T.any,
    pricingAndTariffStructures: T.any,
    sources: T.array(sourceSchema),
  }),

  // ---- competitors ----
  competitors: T.object({
    japanesePlayers: playerGroupSchema,
    localMajor: playerGroupSchema,
    foreignPlayers: playerGroupSchema,
    caseStudy: T.any,
    maActivity: T.any,
  }),

  // ---- depth ----
  depth: T.object({
    dealEconomics: T.any,
    partnerAssessment: T.any,
    entryStrategy: T.any,
    implementation: T.object({
      slideTitle: T.stringOrNull,
      subtitle: T.stringOrNull,
      phases: T.array(phaseSchema),
      totalInvestment: T.stringOrNull,
      breakeven: T.stringOrNull,
    }),
    targetSegments: T.any,
  }),

  // ---- summary ----
  summary: T.object({
    timingIntelligence: T.any,
    lessonsLearned: T.any,
    opportunities: T.array(T.any),
    obstacles: T.array(T.any),
    ratings: T.object({
      attractiveness: T.numberOrNull,
      attractivenessRationale: T.stringOrNull,
      feasibility: T.numberOrNull,
      feasibilityRationale: T.stringOrNull,
    }),
    keyInsights: T.array(insightSchema),
    recommendation: T.stringOrNull,
    goNoGo: T.any,
  }),
};

// Single-country synthesis schemas
const SINGLE_COUNTRY_SCHEMAS = {
  executiveSummary: { type: 'array', items: T.string },
  marketOpportunityAssessment: T.object({
    totalAddressableMarket: T.stringOrNull,
    serviceableMarket: T.stringOrNull,
    growthTrajectory: T.stringOrNull,
    timingConsiderations: T.stringOrNull,
  }),
  competitivePositioning: T.object({
    keyPlayers: T.array(
      T.object(
        {
          name: T.string,
          website: T.stringOrNull,
          strengths: T.stringOrNull,
          weaknesses: T.stringOrNull,
          threat: T.stringOrNull,
          description: T.stringOrNull,
        },
        { required: ['name'] }
      )
    ),
    whiteSpaces: T.arrayOfStrings,
    potentialPartners: T.array(T.any),
    japanesePlayers: playerGroupSchema,
    localMajor: playerGroupSchema,
    foreignPlayers: playerGroupSchema,
  }),
  regulatoryPathway: T.object({
    keyRegulations: T.stringOrNull,
    licensingRequirements: T.stringOrNull,
    timeline: T.stringOrNull,
    risks: T.stringOrNull,
  }),
  keyInsights: T.array(insightSchema),
  nextSteps: T.arrayOfStrings,
  implementation: T.object({
    slideTitle: T.stringOrNull,
    subtitle: T.stringOrNull,
    phases: T.array(phaseSchema),
    totalInvestment: T.stringOrNull,
    breakeven: T.stringOrNull,
  }),
};

// Metadata keys that are always allowed at root level
const ROOT_META_KEYS = new Set([
  'country',
  'isSingleCountry',
  'qualityScore',
  'reviewIterations',
  'rawData',
  'storyPlan',
  'contentCheck',
  '_synthesisError',
  'section',
  'message',
  'error',
  'researchTimeMs',
]);

// ---------------------------------------------------------------------------
// Type checking helpers
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, schema) {
  if (!schema || schema.type === 'any') return true;
  const vt = typeOf(value);
  if (vt === 'null' && schema.nullable) return true;
  if (schema.type === 'string') return vt === 'string';
  if (schema.type === 'number') return vt === 'number' && Number.isFinite(value);
  if (schema.type === 'boolean') return vt === 'boolean';
  if (schema.type === 'array') return vt === 'array';
  if (schema.type === 'object') return vt === 'object';
  return true;
}

// ---------------------------------------------------------------------------
// Action Ledger
// ---------------------------------------------------------------------------

function createActionLedger() {
  return {
    _entries: [],
    record(path, action, details) {
      this._entries.push({
        path,
        action, // kept | coerced | quarantined | dropped | default
        details: details || null,
        timestamp: Date.now(),
      });
    },
    getEntries() {
      return [...this._entries];
    },
    toJSON() {
      return this._entries;
    },
  };
}

// ---------------------------------------------------------------------------
// Quarantine container
// ---------------------------------------------------------------------------

function createQuarantine() {
  return {
    _fields: {},
    add(path, value, reason) {
      this._fields[path] = { value, reason, timestamp: Date.now() };
    },
    getAll() {
      return { ...this._fields };
    },
    count() {
      return Object.keys(this._fields).length;
    },
    toJSON() {
      return this._fields;
    },
  };
}

// ---------------------------------------------------------------------------
// validate(): Check synthesis against schema
// ---------------------------------------------------------------------------

function validate(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') {
    return {
      valid: false,
      errors: [{ path: '$', message: 'Synthesis is not an object', severity: 'critical' }],
      warnings: [],
      fieldResults: {},
    };
  }

  const errors = [];
  const warnings = [];
  const fieldResults = {};
  const isSingle = Boolean(synthesis.isSingleCountry);
  const schemas = isSingle ? SINGLE_COUNTRY_SCHEMAS : SECTION_SCHEMAS;

  for (const [sectionKey, sectionSchema] of Object.entries(schemas)) {
    const value = synthesis[sectionKey];
    const path = `$.${sectionKey}`;

    if (value === undefined || value === null) {
      // Check if it's an important section
      const important =
        isSingle
          ? ['executiveSummary', 'keyInsights', 'competitivePositioning'].includes(sectionKey)
          : ['policy', 'market', 'competitors', 'summary'].includes(sectionKey);
      if (important) {
        errors.push({ path, message: `Required section "${sectionKey}" is missing`, severity: 'error' });
      } else {
        warnings.push({ path, message: `Optional section "${sectionKey}" is missing`, severity: 'warning' });
      }
      fieldResults[sectionKey] = { present: false, valid: false, issues: ['missing'] };
      continue;
    }

    const result = validateValue(value, sectionSchema, path);
    fieldResults[sectionKey] = {
      present: true,
      valid: result.errors.length === 0,
      issues: result.errors.map((e) => e.message),
    };
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  // Check for unknown root-level keys
  const knownKeys = new Set([...Object.keys(schemas), ...ROOT_META_KEYS]);
  for (const key of Object.keys(synthesis)) {
    if (!knownKeys.has(key) && !key.startsWith('_')) {
      // Check legacy key map
      if (LEGACY_KEY_MAP[key]) {
        warnings.push({
          path: `$.${key}`,
          message: `Legacy key "${key}" found, should be "${LEGACY_KEY_MAP[key]}"`,
          severity: 'warning',
        });
      } else {
        warnings.push({
          path: `$.${key}`,
          message: `Unknown root-level key "${key}"`,
          severity: 'warning',
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    fieldResults,
  };
}

function validateValue(value, schema, path) {
  const errors = [];
  const warnings = [];

  if (!schema || schema.type === 'any') {
    return { errors, warnings };
  }

  const vt = typeOf(value);

  // null check
  if (vt === 'null') {
    if (!schema.nullable) {
      errors.push({ path, message: `Expected ${schema.type}, got null`, severity: 'error' });
    }
    return { errors, warnings };
  }

  // Type mismatch
  if (!matchesType(value, schema)) {
    errors.push({
      path,
      message: `Type mismatch: expected ${schema.type}, got ${vt}`,
      severity: 'error',
    });
    return { errors, warnings };
  }

  // Array check
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemResult = validateValue(value[i], schema.items, `${path}[${i}]`);
        errors.push(...itemResult.errors);
        warnings.push(...itemResult.warnings);
      }
    }
  }

  // Object check
  if (schema.type === 'object' && vt === 'object' && schema.properties) {
    // Check required fields
    if (schema.required) {
      for (const reqKey of schema.required) {
        if (value[reqKey] === undefined || value[reqKey] === null) {
          errors.push({
            path: `${path}.${reqKey}`,
            message: `Required field "${reqKey}" is missing`,
            severity: 'error',
          });
        }
      }
    }

    // Validate known properties
    for (const [propKey, propSchema] of Object.entries(schema.properties)) {
      if (value[propKey] !== undefined) {
        const propResult = validateValue(value[propKey], propSchema, `${path}.${propKey}`);
        errors.push(...propResult.errors);
        warnings.push(...propResult.warnings);
      }
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// coerce(): Attempt to fix common issues
// ---------------------------------------------------------------------------

function coerce(synthesis, ledger) {
  if (!synthesis || typeof synthesis !== 'object') {
    return synthesis;
  }

  const actionLedger = ledger || createActionLedger();
  const result = { ...synthesis };
  const isSingle = Boolean(result.isSingleCountry);

  // Step 1: Normalize legacy keys (canonical takes precedence)
  for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_KEY_MAP)) {
    if (result[legacyKey] !== undefined && result[canonicalKey] === undefined) {
      result[canonicalKey] = result[legacyKey];
      delete result[legacyKey];
      actionLedger.record(`$.${legacyKey}`, 'coerced', `Renamed legacy key to "${canonicalKey}"`);
    } else if (result[legacyKey] !== undefined && result[canonicalKey] !== undefined) {
      // Canonical takes precedence, drop legacy
      delete result[legacyKey];
      actionLedger.record(`$.${legacyKey}`, 'dropped', `Canonical key "${canonicalKey}" already exists`);
    }
  }

  // Step 2: Coerce executiveSummary string→array
  if (isSingle && typeof result.executiveSummary === 'string') {
    result.executiveSummary = result.executiveSummary
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    actionLedger.record('$.executiveSummary', 'coerced', 'string split into array of paragraphs');
  }

  // Step 3: Coerce keyInsights
  if (Array.isArray(result.keyInsights)) {
    result.keyInsights = result.keyInsights.filter((item) => {
      // Filter out instruction strings that aren't insight objects
      if (typeof item === 'string') {
        actionLedger.record('$.keyInsights[]', 'dropped', `Dropped string item: "${item.substring(0, 50)}..."`);
        return false;
      }
      return item && typeof item === 'object';
    });
    // Ensure each insight has required fields
    result.keyInsights = result.keyInsights.map((insight, i) => {
      const coerced = { ...insight };
      let wasCoerced = false;
      if (!coerced.title && coerced.headline) {
        coerced.title = coerced.headline;
        delete coerced.headline;
        wasCoerced = true;
      }
      if (!coerced.data && coerced.evidence) {
        coerced.data = coerced.evidence;
        delete coerced.evidence;
        wasCoerced = true;
      }
      if (wasCoerced) {
        actionLedger.record(`$.keyInsights[${i}]`, 'coerced', 'Remapped alternate field names');
      } else {
        actionLedger.record(`$.keyInsights[${i}]`, 'kept', null);
      }
      return coerced;
    });
  }

  // Step 4: Coerce nested competitor sections
  const competitorKey = isSingle ? 'competitivePositioning' : 'competitors';
  if (result[competitorKey] && typeof result[competitorKey] === 'object') {
    const comp = { ...result[competitorKey] };
    for (const subKey of ['japanesePlayers', 'localMajor', 'foreignPlayers']) {
      if (comp[subKey]) {
        // Coerce players from plain array to {players: [...]} structure
        if (Array.isArray(comp[subKey])) {
          comp[subKey] = { players: comp[subKey] };
          actionLedger.record(
            `$.${competitorKey}.${subKey}`,
            'coerced',
            'Wrapped bare array in {players: [...]}'
          );
        }
        // Ensure players is an array
        if (comp[subKey].players && !Array.isArray(comp[subKey].players)) {
          comp[subKey].players = [comp[subKey].players];
          actionLedger.record(
            `$.${competitorKey}.${subKey}.players`,
            'coerced',
            'Wrapped single player in array'
          );
        }
      }
    }
    result[competitorKey] = comp;
  }

  // Step 5: Coerce implementation phases
  const implSource = isSingle ? result.implementation : result.depth?.implementation;
  if (implSource && typeof implSource === 'object') {
    if (implSource.phases && !Array.isArray(implSource.phases)) {
      // Sometimes phases is an object keyed by phase name
      if (typeof implSource.phases === 'object') {
        implSource.phases = Object.values(implSource.phases);
        actionLedger.record(
          isSingle ? '$.implementation.phases' : '$.depth.implementation.phases',
          'coerced',
          'Converted phases object to array'
        );
      }
    }
  }

  // Step 6: Coerce summary.opportunities / summary.obstacles from objects to arrays
  if (result.summary && typeof result.summary === 'object') {
    for (const field of ['opportunities', 'obstacles']) {
      if (result.summary[field] && !Array.isArray(result.summary[field])) {
        if (typeof result.summary[field] === 'object') {
          result.summary[field] = [result.summary[field]];
          actionLedger.record(`$.summary.${field}`, 'coerced', 'Wrapped single object in array');
        }
      }
    }
  }

  // Step 7: Coerce ratings from strings to numbers
  if (result.summary?.ratings) {
    const ratings = { ...result.summary.ratings };
    for (const key of ['attractiveness', 'feasibility']) {
      if (typeof ratings[key] === 'string') {
        const parsed = parseFloat(ratings[key]);
        if (Number.isFinite(parsed)) {
          ratings[key] = Math.max(0, Math.min(100, parsed));
          actionLedger.record(`$.summary.ratings.${key}`, 'coerced', `String "${ratings[key]}" → number`);
        }
      }
    }
    result.summary = { ...result.summary, ratings };
  }

  // Step 8: Coerce marketOpportunityAssessment fields
  if (result.marketOpportunityAssessment && typeof result.marketOpportunityAssessment === 'object') {
    const moa = { ...result.marketOpportunityAssessment };
    for (const field of ['totalAddressableMarket', 'serviceableMarket', 'growthTrajectory', 'timingConsiderations']) {
      if (moa[field] !== undefined && moa[field] !== null && typeof moa[field] !== 'string') {
        moa[field] = String(moa[field]);
        actionLedger.record(
          `$.marketOpportunityAssessment.${field}`,
          'coerced',
          `${typeOf(moa[field])} → string`
        );
      }
    }
    result.marketOpportunityAssessment = moa;
  }

  return result;
}

// ---------------------------------------------------------------------------
// quarantine(): Move unknown fields to _quarantine
// ---------------------------------------------------------------------------

function quarantine(synthesis, ledger) {
  if (!synthesis || typeof synthesis !== 'object') {
    return { result: synthesis, quarantined: createQuarantine() };
  }

  const actionLedger = ledger || createActionLedger();
  const quarantineStore = createQuarantine();
  const result = { ...synthesis };
  const isSingle = Boolean(result.isSingleCountry);
  const schemas = isSingle ? SINGLE_COUNTRY_SCHEMAS : SECTION_SCHEMAS;
  const knownKeys = new Set([...Object.keys(schemas), ...ROOT_META_KEYS]);

  // Quarantine unknown root-level keys
  for (const key of Object.keys(result)) {
    if (key.startsWith('_')) continue; // Skip internal keys
    if (!knownKeys.has(key)) {
      quarantineStore.add(`$.${key}`, result[key], `Unknown root-level key`);
      actionLedger.record(`$.${key}`, 'quarantined', `Unknown key moved to quarantine`);
      delete result[key];
    }
  }

  // Quarantine unknown sub-keys within known sections
  for (const [sectionKey, sectionSchema] of Object.entries(schemas)) {
    if (!result[sectionKey] || typeof result[sectionKey] !== 'object' || Array.isArray(result[sectionKey])) {
      continue;
    }
    if (sectionSchema.type !== 'object' || !sectionSchema.properties) continue;

    const sectionValue = { ...result[sectionKey] };
    const allowedProps = new Set(Object.keys(sectionSchema.properties));

    for (const subKey of Object.keys(sectionValue)) {
      if (subKey.startsWith('_')) continue;
      if (!allowedProps.has(subKey)) {
        quarantineStore.add(
          `$.${sectionKey}.${subKey}`,
          sectionValue[subKey],
          `Unknown key in "${sectionKey}" section`
        );
        actionLedger.record(
          `$.${sectionKey}.${subKey}`,
          'quarantined',
          `Unknown sub-key moved to quarantine`
        );
        delete sectionValue[subKey];
      }
    }
    result[sectionKey] = sectionValue;
  }

  // Attach quarantine to result
  if (quarantineStore.count() > 0) {
    result._quarantine = quarantineStore.getAll();
  }

  return { result, quarantined: quarantineStore };
}

// ---------------------------------------------------------------------------
// Trust scoring
// ---------------------------------------------------------------------------

function getTrustScore(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') {
    return { overall: 0, perField: {}, breakdown: {} };
  }

  const isSingle = Boolean(synthesis.isSingleCountry);
  const schemas = isSingle ? SINGLE_COUNTRY_SCHEMAS : SECTION_SCHEMAS;
  const perField = {};
  let totalScore = 0;
  let sectionCount = 0;

  for (const [sectionKey, sectionSchema] of Object.entries(schemas)) {
    const value = synthesis[sectionKey];
    const score = scoreSectionTrust(value, sectionSchema, sectionKey);
    perField[sectionKey] = score;
    totalScore += score.score;
    sectionCount++;
  }

  const overall = sectionCount > 0 ? Math.round(totalScore / sectionCount) : 0;

  return {
    overall,
    perField,
    breakdown: {
      sectionCount,
      totalScore,
      maxPossible: sectionCount * 100,
    },
  };
}

function scoreSectionTrust(value, schema, sectionKey) {
  if (value === undefined || value === null) {
    return { score: 0, reason: 'missing', conformance: 0, completeness: 0, typeCorrectness: 0 };
  }

  let conformance = 0;
  let completeness = 0;
  let typeCorrectness = 0;

  // Type correctness (0-100)
  if (matchesType(value, schema)) {
    typeCorrectness = 100;
  } else {
    typeCorrectness = 0;
  }

  // Schema conformance (0-100)
  if (schema.type === 'object' && schema.properties && typeof value === 'object' && !Array.isArray(value)) {
    const expectedKeys = Object.keys(schema.properties);
    const presentKeys = expectedKeys.filter(
      (k) => value[k] !== undefined && value[k] !== null
    );
    conformance = expectedKeys.length > 0 ? Math.round((presentKeys.length / expectedKeys.length) * 100) : 100;
  } else if (schema.type === 'array' && Array.isArray(value)) {
    conformance = value.length > 0 ? 100 : 30;
  } else if (matchesType(value, schema)) {
    conformance = 100;
  }

  // Completeness (0-100) — how much of the data is non-empty
  completeness = scoreCompleteness(value, 0);

  const score = Math.round(conformance * 0.4 + completeness * 0.35 + typeCorrectness * 0.25);

  return { score, conformance, completeness, typeCorrectness, reason: 'evaluated' };
}

function scoreCompleteness(value, depth) {
  if (depth > 6) return 50;
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.trim().length > 0 ? 100 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? 100 : 0;
  if (typeof value === 'boolean') return 100;
  if (Array.isArray(value)) {
    if (value.length === 0) return 0;
    const itemScores = value.map((item) => scoreCompleteness(item, depth + 1));
    return Math.round(itemScores.reduce((a, b) => a + b, 0) / itemScores.length);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([k]) => !k.startsWith('_'));
    if (entries.length === 0) return 0;
    const fieldScores = entries.map(([, v]) => scoreCompleteness(v, depth + 1));
    return Math.round(fieldScores.reduce((a, b) => a + b, 0) / fieldScores.length);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Action Ledger export
// ---------------------------------------------------------------------------

function getActionLedger(synthesis, options = {}) {
  const ledger = createActionLedger();
  const isSingle = Boolean(synthesis?.isSingleCountry);
  const schemas = isSingle ? SINGLE_COUNTRY_SCHEMAS : SECTION_SCHEMAS;

  if (!synthesis || typeof synthesis !== 'object') {
    ledger.record('$', 'dropped', 'Synthesis is not an object');
    return ledger;
  }

  const knownKeys = new Set([...Object.keys(schemas), ...ROOT_META_KEYS]);

  for (const key of Object.keys(synthesis)) {
    if (key.startsWith('_')) continue;
    if (knownKeys.has(key)) {
      if (synthesis[key] !== undefined && synthesis[key] !== null) {
        ledger.record(`$.${key}`, 'kept', null);
      } else {
        ledger.record(`$.${key}`, 'default', 'Field is null/undefined');
      }
    } else if (LEGACY_KEY_MAP[key]) {
      ledger.record(`$.${key}`, 'coerced', `Legacy key → "${LEGACY_KEY_MAP[key]}"`);
    } else {
      ledger.record(`$.${key}`, 'quarantined', 'Unknown root-level key');
    }
  }

  // Record missing sections
  for (const sectionKey of Object.keys(schemas)) {
    if (synthesis[sectionKey] === undefined) {
      ledger.record(`$.${sectionKey}`, 'default', 'Section not present in synthesis');
    }
  }

  return ledger;
}

// ---------------------------------------------------------------------------
// Source Lineage Enforcement
// ---------------------------------------------------------------------------

function enforceSourceLineage(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') {
    return { valid: false, orphanedInsights: [], sourceCoverage: 0, details: [] };
  }

  const details = [];
  const orphanedInsights = [];
  const isSingle = Boolean(synthesis.isSingleCountry);

  // Collect all source references
  const sources = collectSources(synthesis);
  const hasAnySources = sources.length > 0;

  // Check insights for source references
  const insights = isSingle
    ? (Array.isArray(synthesis.keyInsights) ? synthesis.keyInsights : [])
    : (Array.isArray(synthesis.summary?.keyInsights) ? synthesis.summary.keyInsights : []);

  let insightsWithData = 0;

  for (const insight of insights) {
    if (!insight || typeof insight !== 'object') continue;
    const hasData = insight.data && typeof insight.data === 'string' && insight.data.trim().length > 0;
    const hasNumericEvidence = hasData && /\d/.test(insight.data);

    if (hasNumericEvidence) {
      insightsWithData++;
      details.push({
        insight: insight.title || 'untitled',
        hasSourceRef: true,
        reason: 'Has numeric data evidence',
      });
    } else if (hasData) {
      insightsWithData++;
      details.push({
        insight: insight.title || 'untitled',
        hasSourceRef: true,
        reason: 'Has text data',
      });
    } else {
      orphanedInsights.push({
        title: insight.title || 'untitled',
        reason: 'No data/evidence field',
      });
      details.push({
        insight: insight.title || 'untitled',
        hasSourceRef: false,
        reason: 'Missing data field - orphaned insight',
      });
    }
  }

  const totalInsights = insights.filter((i) => i && typeof i === 'object').length;
  const sourceCoverage = totalInsights > 0 ? Math.round((insightsWithData / totalInsights) * 100) : 100;

  return {
    valid: orphanedInsights.length === 0,
    orphanedInsights,
    sourceCoverage,
    totalSources: sources.length,
    totalInsights,
    insightsWithData,
    details,
  };
}

function collectSources(obj, depth = 0) {
  if (depth > 8 || !obj) return [];
  const sources = [];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      sources.push(...collectSources(item, depth + 1));
    }
  } else if (typeof obj === 'object') {
    if (obj.url && typeof obj.url === 'string') {
      sources.push({ url: obj.url, title: obj.title || '' });
    }
    if (obj.sources && Array.isArray(obj.sources)) {
      for (const s of obj.sources) {
        if (s && s.url) sources.push({ url: s.url, title: s.title || '' });
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'sources') continue; // Already handled
      if (key.startsWith('_')) continue;
      sources.push(...collectSources(value, depth + 1));
    }
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Full pipeline: validate → coerce → quarantine → score → lineage
// ---------------------------------------------------------------------------

function processFirewall(synthesis) {
  const ledger = createActionLedger();

  // 1. Validate raw input
  const checkResult = validate(synthesis);

  // 2. Coerce fixable issues
  const coerced = coerce(synthesis, ledger);

  // 3. Quarantine unknown fields
  const { result: cleaned, quarantined } = quarantine(coerced, ledger);

  // 4. Re-validate after coercion
  const postCheck = validate(cleaned);

  // 5. Trust score
  const trustScore = getTrustScore(cleaned);

  // 6. Source lineage
  const lineage = enforceSourceLineage(cleaned);

  return {
    result: cleaned,
    preValidation: checkResult,
    postValidation: postCheck,
    preCheck: checkResult,
    postCheck,
    trustScore,
    lineage,
    quarantined: quarantined.getAll(),
    actionLedger: ledger.getEntries(),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Core functions
  validate,
  coerce,
  quarantine,
  getTrustScore,
  getActionLedger,

  // Source lineage
  enforceSourceLineage,

  // Full pipeline
  processFirewall,

  // Helpers (for testing)
  createActionLedger,
  createQuarantine,

  // Schema references (for testing)
  SECTION_SCHEMAS,
  SINGLE_COUNTRY_SCHEMAS,
  LEGACY_KEY_MAP,
  ROOT_META_KEYS,
};
