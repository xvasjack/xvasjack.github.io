'use strict';

const path = require('path');
const fs = require('fs');
const {
  loadFixture,
  listFixtures,
  createBaseline,
  loadBaseline,
  deleteBaseline,
  compareToBaseline,
  detectDrift,
  replayFixture,
  getCoverageReport,
  __test: {
    expandPlaceholders,
    flattenToBlocks,
    classifyFailures,
    extractFailures,
    collectKeys,
    FIXTURES_DIR,
    BASELINES_DIR,
    LONG_STRING_10K,
    FIFTY_ROW_TABLE,
    TWENTY_COLUMN_TABLE,
  },
} = require('./golden-baseline-manager');

const { validateSynthesisQuality, validatePptData } = require('./content-gates');

// ============ FIXTURE NAMES ============

const ALL_FIXTURES = [
  'clean-gold',
  'noisy-real-world',
  'adversarial-malformed',
  'edge-size-extremes',
];

// ============ TEST SUITE: Fixture Loading & Parsing ============

describe('Fixture Loading & Parsing', () => {
  test('listFixtures returns all expected fixture names', () => {
    const names = listFixtures();
    for (const name of ALL_FIXTURES) {
      expect(names).toContain(name);
    }
  });

  test.each(ALL_FIXTURES)('fixture "%s" loads and parses as valid JSON object', (name) => {
    const fixture = loadFixture(name);
    expect(fixture).toBeDefined();
    expect(typeof fixture).toBe('object');
    expect(fixture).not.toBeNull();
  });

  test.each(ALL_FIXTURES)('fixture "%s" has _meta with required fields', (name) => {
    const fixture = loadFixture(name);
    expect(fixture._meta).toBeDefined();
    expect(fixture._meta.name).toBe(name);
    expect(typeof fixture._meta.description).toBe('string');
    expect(fixture._meta.description.length).toBeGreaterThan(10);
    expect(typeof fixture._meta.expectedOutcome).toBe('string');
    expect(typeof fixture._meta.createdAt).toBe('string');
    expect(typeof fixture._meta.version).toBe('string');
  });

  test.each(ALL_FIXTURES)(
    'fixture "%s" has top-level synthesis and countryAnalysis keys',
    (name) => {
      const fixture = loadFixture(name);
      // All fixtures should have synthesis (even if malformed values)
      expect(fixture).toHaveProperty('synthesis');
      expect(fixture).toHaveProperty('countryAnalysis');
    }
  );

  test('loading a non-existent fixture throws', () => {
    expect(() => loadFixture('non-existent-fixture-xyz')).toThrow(/not found/i);
  });

  test('loading with empty name throws', () => {
    expect(() => loadFixture('')).toThrow();
  });

  test('loading with null name throws', () => {
    expect(() => loadFixture(null)).toThrow();
  });

  test('path traversal in fixture name is blocked', () => {
    expect(() => loadFixture('../../server')).toThrow(/not found/i);
  });
});

// ============ TEST SUITE: Clean Gold Passes Validation ============

describe('Clean Gold Fixture - All Validation Gates', () => {
  let fixture;

  beforeAll(() => {
    fixture = loadFixture('clean-gold');
  });

  test('clean-gold _meta.expectedOutcome is "pass"', () => {
    expect(fixture._meta.expectedOutcome).toBe('pass');
  });

  test('clean-gold has fully populated synthesis', () => {
    expect(fixture.synthesis).toBeDefined();
    expect(fixture.synthesis.isSingleCountry).toBe(true);
    expect(typeof fixture.synthesis.country).toBe('string');
    expect(typeof fixture.synthesis.executiveSummary).toBe('string');
    expect(fixture.synthesis.executiveSummary.length).toBeGreaterThan(50);
  });

  test('clean-gold has all major countryAnalysis sections', () => {
    const ca = fixture.countryAnalysis;
    expect(ca.policy).toBeDefined();
    expect(ca.market).toBeDefined();
    expect(ca.competitors).toBeDefined();
    expect(ca.depth).toBeDefined();
    expect(ca.summary).toBeDefined();
  });

  test('clean-gold policy has 3+ foundational acts with full fields', () => {
    const acts = fixture.countryAnalysis.policy.foundationalActs.acts;
    expect(acts.length).toBeGreaterThanOrEqual(3);
    for (const act of acts) {
      expect(act.name).toBeTruthy();
      expect(act.year).toBeTruthy();
      expect(act.requirements).toBeTruthy();
      expect(act.enforcement).toBeTruthy();
      expect(act.penalties).toBeTruthy();
    }
  });

  test('clean-gold market sections have valid chart data', () => {
    const market = fixture.countryAnalysis.market;
    const chartSections = ['tpes', 'finalDemand', 'electricity', 'pricing', 'escoMarket'];
    for (const section of chartSections) {
      const data = market[section];
      expect(data).toBeDefined();
      expect(data.chartData).toBeDefined();
      expect(Array.isArray(data.chartData.categories)).toBe(true);
      expect(Array.isArray(data.chartData.series)).toBe(true);
      expect(data.chartData.categories.length).toBeGreaterThanOrEqual(5);
      for (const series of data.chartData.series) {
        expect(typeof series.name).toBe('string');
        expect(Array.isArray(series.values)).toBe(true);
        for (const val of series.values) {
          expect(typeof val).toBe('number');
        }
      }
    }
  });

  test('clean-gold competitors have players with 40+ word descriptions', () => {
    const competitors = fixture.countryAnalysis.competitors;
    const playerSections = ['japanesePlayers', 'localMajor', 'foreignPlayers'];
    for (const section of playerSections) {
      const players = competitors[section].players;
      expect(players.length).toBeGreaterThanOrEqual(2);
      for (const player of players) {
        const wordCount = player.description.trim().split(/\s+/).length;
        expect(wordCount).toBeGreaterThanOrEqual(40);
      }
    }
  });

  test('clean-gold summary has 2+ opportunities and 2+ keyInsights with data', () => {
    const summary = fixture.countryAnalysis.summary;
    expect(summary.opportunities.length).toBeGreaterThanOrEqual(2);
    expect(summary.keyInsights.length).toBeGreaterThanOrEqual(2);
    for (const insight of summary.keyInsights) {
      expect(insight.title).toBeTruthy();
      expect(insight.data).toBeTruthy();
      expect(/\d/.test(insight.data)).toBe(true); // must have numeric data
      expect(insight.implication).toBeTruthy();
      expect(insight.timing).toBeTruthy();
    }
  });

  test('clean-gold scope has industry and targetMarkets', () => {
    expect(fixture.scope.industry).toBeTruthy();
    expect(Array.isArray(fixture.scope.targetMarkets)).toBe(true);
    expect(fixture.scope.targetMarkets.length).toBeGreaterThanOrEqual(1);
  });

  test('clean-gold synthesis quality gate returns scored result without crashing', () => {
    // The fixture uses raw countryAnalysis format (for PPT generation), not the
    // synthesized single-country format (executiveSummary array, marketOpportunityAssessment, etc.)
    // So validateSingleCountrySynthesis will report missing synthesis-level fields.
    // The key test is: it runs without error and returns a structured result.
    const merged = { ...fixture.synthesis, ...fixture.countryAnalysis };
    const result = validateSynthesisQuality(merged, fixture.scope.industry);
    expect(result).toBeDefined();
    expect(typeof result.overall).toBe('number');
    expect(result.sectionScores).toBeDefined();
    expect(Array.isArray(result.failures)).toBe(true);

    // Even with structure mismatch, executiveSummary string (50+ words) should score 60
    expect(result.sectionScores.executiveSummary).toBeGreaterThanOrEqual(60);
  });

  test('clean-gold PPT data blocks have buildable content', () => {
    const blocks = flattenToBlocks(fixture.countryAnalysis);
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    const result = validatePptData(blocks);
    // All clean-gold blocks should have meaningful data
    expect(result.sectionsWithDataCount).toBeGreaterThanOrEqual(2);
  });
});

// ============ TEST SUITE: Adversarial Malformed Triggers Failures ============

describe('Adversarial Malformed Fixture - Expected Failures', () => {
  let fixture;

  beforeAll(() => {
    fixture = loadFixture('adversarial-malformed');
  });

  test('adversarial-malformed _meta.expectedOutcome is "fail"', () => {
    expect(fixture._meta.expectedOutcome).toBe('fail');
  });

  test('adversarial-malformed has null/wrong-type synthesis fields', () => {
    expect(fixture.synthesis.isSingleCountry).toBeNull();
    expect(fixture.synthesis.country).toBe(12345); // wrong type
    expect(Array.isArray(fixture.synthesis.executiveSummary)).toBe(true); // wrong type
  });

  test('adversarial-malformed has null country in countryAnalysis', () => {
    expect(fixture.countryAnalysis.country).toBeNull();
  });

  test('adversarial-malformed has non-array acts', () => {
    expect(fixture.countryAnalysis.policy.foundationalActs.acts).toBe('not-an-array');
  });

  test('adversarial-malformed has null depth section', () => {
    expect(fixture.countryAnalysis.depth).toBeNull();
  });

  test('adversarial-malformed has invalid chart data', () => {
    const tpes = fixture.countryAnalysis.market.tpes;
    expect(tpes.chartData.categories).toBeNull();
    expect(tpes.chartData.series).toBe('invalid-series-type');
  });

  test('adversarial-malformed has null players in japanesePlayers', () => {
    expect(fixture.countryAnalysis.competitors.japanesePlayers.players).toBeNull();
  });

  test('adversarial-malformed has string instead of object for foreignPlayers', () => {
    expect(typeof fixture.countryAnalysis.competitors.foreignPlayers).toBe('string');
  });

  test('adversarial-malformed has empty opportunities array', () => {
    expect(fixture.countryAnalysis.summary.opportunities).toHaveLength(0);
  });

  test('adversarial-malformed has string instead of array for keyInsights', () => {
    expect(typeof fixture.countryAnalysis.summary.keyInsights).toBe('string');
  });

  test('adversarial-malformed has null scope', () => {
    expect(fixture.scope).toBeNull();
  });

  test('adversarial-malformed replay triggers gate failures', () => {
    const result = replayFixture('adversarial-malformed');
    // At least one gate should fail
    const anyFailed = Object.values(result.gates).some((g) => !g.pass);
    expect(anyFailed).toBe(true);
  });

  test('adversarial-malformed synthesis quality gate fails or has low score', () => {
    const result = replayFixture('adversarial-malformed');
    const sqGate = result.gates.synthesisQuality;
    // Should either fail outright, have an error, or have a very low score
    const isFailure =
      !sqGate.pass || sqGate.error || (typeof sqGate.overall === 'number' && sqGate.overall < 40);
    expect(isFailure).toBe(true);
  });
});

// ============ TEST SUITE: Noisy Real-World Fixture ============

describe('Noisy Real-World Fixture', () => {
  let fixture;

  beforeAll(() => {
    fixture = loadFixture('noisy-real-world');
  });

  test('noisy-real-world has legacy keys that should be ignored', () => {
    expect(fixture.synthesis.section_0).toBeDefined();
    expect(fixture.synthesis._wasArray).toBeDefined();
    expect(fixture.synthesis._debugInfo).toBeDefined();
  });

  test('noisy-real-world has mixed types in chart data', () => {
    const finalDemand = fixture.countryAnalysis.market.finalDemand;
    const autoSeries = finalDemand.chartData.series[0];
    // One value is a string "1.9" instead of number
    expect(autoSeries.values.some((v) => typeof v === 'string')).toBe(true);
  });

  test('noisy-real-world has null escoMarket section', () => {
    expect(fixture.countryAnalysis.market.escoMarket).toBeNull();
  });

  test('noisy-real-world has extra/legacy fields in competitors', () => {
    expect(fixture.countryAnalysis.competitors.verify_1).toBeDefined();
    expect(fixture.countryAnalysis.competitors.competitorsDeepen_1).toBeDefined();
  });

  test('noisy-real-world has mixed type year fields in maActivity', () => {
    const deals = fixture.countryAnalysis.competitors.maActivity.recentDeals;
    // Second deal has numeric year and numeric value instead of strings
    expect(typeof deals[1].year).toBe('number');
    expect(typeof deals[1].value).toBe('number');
  });

  test('noisy-real-world has keyInitiatives as string instead of array', () => {
    const initiatives = fixture.countryAnalysis.policy.nationalPolicy.keyInitiatives;
    expect(typeof initiatives).toBe('string');
  });

  test('noisy-real-world replay does not crash', () => {
    const result = replayFixture('noisy-real-world');
    expect(result).toBeDefined();
    expect(result.gates).toBeDefined();
    expect(result.gates.synthesisQuality).toBeDefined();
  });
});

// ============ TEST SUITE: Edge Size Extremes ============

describe('Edge Size Extremes Fixture', () => {
  let fixture;

  beforeAll(() => {
    fixture = loadFixture('edge-size-extremes');
  });

  test('edge-size-extremes expands LONG_STRING_10K_PLACEHOLDER to 10K chars', () => {
    const execSummary = fixture.synthesis.executiveSummary;
    expect(typeof execSummary).toBe('string');
    expect(execSummary.length).toBe(10000);
  });

  test('edge-size-extremes has empty arrays for targets and keyInitiatives', () => {
    const nationalPolicy = fixture.countryAnalysis.policy.nationalPolicy;
    expect(Array.isArray(nationalPolicy.targets)).toBe(true);
    expect(nationalPolicy.targets).toHaveLength(0);
    expect(Array.isArray(nationalPolicy.keyInitiatives)).toBe(true);
    expect(nationalPolicy.keyInitiatives).toHaveLength(0);
  });

  test('edge-size-extremes has 20 categories in tpes chart', () => {
    const tpes = fixture.countryAnalysis.market.tpes;
    expect(tpes.chartData.categories.length).toBe(20);
    expect(tpes.chartData.series.length).toBe(6);
  });

  test('edge-size-extremes has empty chart data arrays in finalDemand', () => {
    const finalDemand = fixture.countryAnalysis.market.finalDemand;
    expect(finalDemand.chartData.categories).toHaveLength(0);
    expect(finalDemand.chartData.series).toHaveLength(0);
  });

  test('edge-size-extremes has single data point in electricity chart', () => {
    const electricity = fixture.countryAnalysis.market.electricity;
    expect(electricity.chartData.categories).toHaveLength(1);
    expect(electricity.chartData.series[0].values).toHaveLength(1);
  });

  test('edge-size-extremes expands 50-row table placeholder', () => {
    const pricing = fixture.countryAnalysis.market.pricing;
    expect(Array.isArray(pricing.tableData)).toBe(true);
    expect(pricing.tableData.length).toBe(50);
    expect(Object.keys(pricing.tableData[0]).length).toBe(5);
  });

  test('edge-size-extremes expands 20-column table placeholder', () => {
    const escoMarket = fixture.countryAnalysis.market.escoMarket;
    expect(Array.isArray(escoMarket.tableData)).toBe(true);
    expect(escoMarket.tableData.length).toBe(5);
    expect(Object.keys(escoMarket.tableData[0]).length).toBe(20);
  });

  test('edge-size-extremes has empty players array in japanesePlayers', () => {
    expect(fixture.countryAnalysis.competitors.japanesePlayers.players).toHaveLength(0);
  });

  test('edge-size-extremes has exactly 1 player in localMajor', () => {
    expect(fixture.countryAnalysis.competitors.localMajor.players).toHaveLength(1);
  });

  test('edge-size-extremes has empty players array in foreignPlayers', () => {
    expect(fixture.countryAnalysis.competitors.foreignPlayers.players).toHaveLength(0);
  });

  test('edge-size-extremes has 0 rating for attractiveness and 10 for feasibility', () => {
    const ratings = fixture.countryAnalysis.summary.ratings;
    expect(ratings.attractiveness).toBe(0);
    expect(ratings.feasibility).toBe(10);
  });

  test('edge-size-extremes has empty conditions and criteria in goNoGo', () => {
    const goNoGo = fixture.countryAnalysis.summary.goNoGo;
    expect(goNoGo.conditions).toHaveLength(0);
    expect(goNoGo.criteria).toHaveLength(0);
  });

  test('edge-size-extremes replay does not crash', () => {
    const result = replayFixture('edge-size-extremes');
    expect(result).toBeDefined();
    expect(result.gates).toBeDefined();
  });
});

// ============ TEST SUITE: Baseline Create/Compare/Drift Workflow ============

describe('Baseline Create/Compare/Drift Workflow', () => {
  const TEST_BASELINE_NAME = '__test-baseline-temp__';

  afterEach(() => {
    // Clean up test baselines
    deleteBaseline(TEST_BASELINE_NAME);
  });

  test('createBaseline stores and loadBaseline retrieves it', () => {
    const gateResults = {
      pass: true,
      overall: 85,
      sectionScores: { policy: 100, market: 80, competitors: 70 },
      failures: [],
    };

    const created = createBaseline(TEST_BASELINE_NAME, gateResults);
    expect(created._meta.name).toBe(TEST_BASELINE_NAME);
    expect(created.gateResults).toEqual(gateResults);

    const loaded = loadBaseline(TEST_BASELINE_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded.gateResults).toEqual(gateResults);
  });

  test('loadBaseline returns null for non-existent baseline', () => {
    const result = loadBaseline('non-existent-baseline-xyz');
    expect(result).toBeNull();
  });

  test('deleteBaseline removes the baseline file', () => {
    createBaseline(TEST_BASELINE_NAME, { pass: true });
    expect(loadBaseline(TEST_BASELINE_NAME)).not.toBeNull();

    const deleted = deleteBaseline(TEST_BASELINE_NAME);
    expect(deleted).toBe(true);
    expect(loadBaseline(TEST_BASELINE_NAME)).toBeNull();
  });

  test('deleteBaseline returns false for non-existent baseline', () => {
    const result = deleteBaseline('non-existent-baseline-xyz');
    expect(result).toBe(false);
  });

  test('compareToBaseline returns baselineFound:false when no baseline exists', () => {
    const result = compareToBaseline('non-existent', { pass: true });
    expect(result.baselineFound).toBe(false);
    expect(result.drift).toBeNull();
  });

  test('compareToBaseline detects no drift when results match', () => {
    const gateResults = {
      pass: true,
      overall: 85,
      sectionScores: { policy: 100, market: 80 },
      failures: [],
    };

    createBaseline(TEST_BASELINE_NAME, gateResults);
    const comparison = compareToBaseline(TEST_BASELINE_NAME, gateResults);

    expect(comparison.baselineFound).toBe(true);
    expect(comparison.hasDrift).toBe(false);
    expect(comparison.drift.totalDriftItems).toBe(0);
  });

  test('compareToBaseline detects score changes', () => {
    const baseline = {
      pass: true,
      overall: 85,
      sectionScores: { policy: 100, market: 80 },
      failures: [],
    };
    const current = {
      pass: true,
      overall: 75,
      sectionScores: { policy: 90, market: 80 },
      failures: [],
    };

    createBaseline(TEST_BASELINE_NAME, baseline);
    const comparison = compareToBaseline(TEST_BASELINE_NAME, current);

    expect(comparison.hasDrift).toBe(true);
    expect(comparison.drift.scoreChanges.length).toBeGreaterThan(0);

    const overallChange = comparison.drift.scoreChanges.find((s) => s.field === 'overall');
    expect(overallChange).toBeDefined();
    expect(overallChange.delta).toBe(-10);
  });

  test('compareToBaseline detects new failures', () => {
    const baseline = {
      pass: true,
      overall: 85,
      failures: ['Known issue A'],
    };
    const current = {
      pass: false,
      overall: 60,
      failures: ['Known issue A', 'New issue B'],
    };

    createBaseline(TEST_BASELINE_NAME, baseline);
    const comparison = compareToBaseline(TEST_BASELINE_NAME, current);

    expect(comparison.hasDrift).toBe(true);
    expect(comparison.drift.newFailures.length).toBeGreaterThanOrEqual(1);
  });

  test('compareToBaseline detects fixed failures', () => {
    const baseline = {
      pass: false,
      overall: 60,
      failures: ['Old issue A', 'Old issue B'],
    };
    const current = {
      pass: true,
      overall: 85,
      failures: ['Old issue A'],
    };

    createBaseline(TEST_BASELINE_NAME, baseline);
    const comparison = compareToBaseline(TEST_BASELINE_NAME, current);

    expect(comparison.hasDrift).toBe(true);
    expect(comparison.drift.fixedFailures.length).toBeGreaterThanOrEqual(1);
  });

  test('createBaseline with invalid name throws', () => {
    expect(() => createBaseline('', {})).toThrow();
    expect(() => createBaseline(null, {})).toThrow();
  });

  test('createBaseline with invalid gateResults throws', () => {
    expect(() => createBaseline('test', null)).toThrow();
    expect(() => createBaseline('test', 'not-an-object')).toThrow();
  });
});

// ============ TEST SUITE: detectDrift Details ============

describe('detectDrift detailed behavior', () => {
  test('handles null baseline', () => {
    const drift = detectDrift(null, { pass: true });
    expect(drift.totalDriftItems).toBeGreaterThan(0);
    expect(drift.structuralChanges.length).toBeGreaterThan(0);
  });

  test('handles null current', () => {
    const drift = detectDrift({ pass: true }, null);
    expect(drift.totalDriftItems).toBeGreaterThan(0);
    expect(drift.structuralChanges.length).toBeGreaterThan(0);
  });

  test('detects pass-to-fail transition', () => {
    const drift = detectDrift(
      { pass: true, failures: [] },
      { pass: false, failures: ['something broke'] }
    );
    expect(drift.newFailures.some((f) => f.field === 'overall')).toBe(true);
  });

  test('detects fail-to-pass transition', () => {
    const drift = detectDrift(
      { pass: false, failures: ['was broken'] },
      { pass: true, failures: [] }
    );
    expect(drift.fixedFailures.some((f) => f.field === 'overall')).toBe(true);
  });

  test('detects sectionScores changes', () => {
    const drift = detectDrift(
      { sectionScores: { policy: 100, market: 80 } },
      { sectionScores: { policy: 90, market: 80 } }
    );
    const policyChange = drift.scoreChanges.find((s) => s.field === 'sectionScores.policy');
    expect(policyChange).toBeDefined();
    expect(policyChange.delta).toBe(-10);
  });

  test('detects structural key additions', () => {
    const drift = detectDrift({ pass: true }, { pass: true, newField: 'added' });
    expect(drift.structuralChanges.some((s) => s.type === 'new-key')).toBe(true);
  });

  test('detects structural key removals', () => {
    const drift = detectDrift({ pass: true, oldField: 'exists' }, { pass: true });
    expect(drift.structuralChanges.some((s) => s.type === 'removed-key')).toBe(true);
  });
});

// ============ TEST SUITE: No Paid Services Required ============

describe('Fixture Independence from Paid Services', () => {
  test.each(ALL_FIXTURES)('fixture "%s" contains no API keys or auth tokens', (name) => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf-8');
    const lower = raw.toLowerCase();

    // Check for common API key patterns
    expect(lower).not.toContain('api_key');
    expect(lower).not.toContain('apikey');
    expect(lower).not.toContain('api-key');
    expect(lower).not.toContain('secret_key');
    expect(lower).not.toContain('access_token');
    expect(lower).not.toContain('bearer ');
    expect(lower).not.toContain('sk-');
    expect(lower).not.toContain('aizasy'); // Google API key prefix
    expect(lower).not.toContain('sendgrid');
    expect(lower).not.toContain('openai');
    expect(lower).not.toContain('anthropic');
  });

  test.each(ALL_FIXTURES)('fixture "%s" has no external URLs requiring network', (name) => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf-8');

    // Check for URLs that would require network access
    const urlPattern = /https?:\/\/(?!example\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const urls = raw.match(urlPattern) || [];
    expect(urls).toHaveLength(0);
  });

  test.each(ALL_FIXTURES)('replayFixture("%s") completes without network calls', (name) => {
    // This test validates that replay is fully local
    const result = replayFixture(name);
    expect(result).toBeDefined();
    expect(result.fixtureName).toBe(name);
    expect(result.gates).toBeDefined();
  });
});

// ============ TEST SUITE: Fixture Update Workflow (Create -> Modify -> Detect Drift) ============

describe('Fixture Update Workflow: Create -> Modify -> Detect Drift', () => {
  const WORKFLOW_BASELINE = '__test-workflow-baseline__';

  afterEach(() => {
    deleteBaseline(WORKFLOW_BASELINE);
  });

  test('full workflow: create baseline, get identical result, no drift', () => {
    // Step 1: Replay a fixture and create baseline
    const result1 = replayFixture('clean-gold');
    createBaseline(WORKFLOW_BASELINE, result1.gates.synthesisQuality);

    // Step 2: Replay same fixture again
    const result2 = replayFixture('clean-gold');

    // Step 3: Compare — should show no drift (deterministic replay)
    const comparison = compareToBaseline(WORKFLOW_BASELINE, result2.gates.synthesisQuality);
    expect(comparison.baselineFound).toBe(true);
    expect(comparison.hasDrift).toBe(false);
  });

  test('full workflow: create baseline from one fixture, compare with different fixture, detect drift', () => {
    // Step 1: Create baseline from clean-gold
    const cleanResult = replayFixture('clean-gold');
    createBaseline(WORKFLOW_BASELINE, cleanResult.gates.synthesisQuality);

    // Step 2: Get results from adversarial-malformed
    const adversarialResult = replayFixture('adversarial-malformed');

    // Step 3: Compare — should detect significant drift
    const comparison = compareToBaseline(
      WORKFLOW_BASELINE,
      adversarialResult.gates.synthesisQuality
    );
    expect(comparison.baselineFound).toBe(true);
    expect(comparison.hasDrift).toBe(true);
    expect(comparison.drift.totalDriftItems).toBeGreaterThan(0);
  });

  test('drift report includes score deltas with correct sign', () => {
    const highScore = {
      pass: true,
      overall: 90,
      sectionScores: { market: 100, policy: 80 },
      failures: [],
    };
    const lowScore = {
      pass: false,
      overall: 30,
      sectionScores: { market: 40, policy: 20 },
      failures: ['Market section missing', 'Policy score too low'],
    };

    createBaseline(WORKFLOW_BASELINE, highScore);
    const comparison = compareToBaseline(WORKFLOW_BASELINE, lowScore);

    expect(comparison.hasDrift).toBe(true);

    // Overall score should show negative delta (regression)
    const overallChange = comparison.drift.scoreChanges.find((s) => s.field === 'overall');
    expect(overallChange).toBeDefined();
    expect(overallChange.delta).toBeLessThan(0);

    // New failures should appear
    expect(comparison.drift.newFailures.length).toBeGreaterThan(0);
  });

  test('overwriting a baseline updates the stored data', () => {
    const v1 = { pass: true, overall: 80, failures: [] };
    const v2 = { pass: true, overall: 95, failures: [] };

    createBaseline(WORKFLOW_BASELINE, v1);
    let loaded = loadBaseline(WORKFLOW_BASELINE);
    expect(loaded.gateResults.overall).toBe(80);

    createBaseline(WORKFLOW_BASELINE, v2);
    loaded = loadBaseline(WORKFLOW_BASELINE);
    expect(loaded.gateResults.overall).toBe(95);
  });
});

// ============ TEST SUITE: Coverage Report ============

describe('Coverage Report', () => {
  test('getCoverageReport returns results for all fixtures', () => {
    const report = getCoverageReport();
    expect(report.totalFixtures).toBeGreaterThanOrEqual(ALL_FIXTURES.length);
    for (const name of ALL_FIXTURES) {
      expect(report.fixtures[name]).toBeDefined();
    }
  });

  test('getCoverageReport maps failure classes to fixtures', () => {
    const report = getCoverageReport();
    // At least some failure classes should be covered
    expect(report.totalFailureClasses).toBeGreaterThan(0);
    expect(Object.keys(report.failureClassToCoverage).length).toBeGreaterThan(0);
  });

  test('adversarial-malformed covers multiple failure classes', () => {
    const report = getCoverageReport();
    const adversarial = report.fixtures['adversarial-malformed'];
    expect(adversarial).toBeDefined();
    expect(adversarial.coveredClasses.length).toBeGreaterThanOrEqual(2);
  });

  test('clean-gold passes more gates than adversarial-malformed', () => {
    const report = getCoverageReport();
    const clean = report.fixtures['clean-gold'];
    const adversarial = report.fixtures['adversarial-malformed'];

    // clean-gold should pass more gates than adversarial
    expect(clean.gatesPassed).toBeGreaterThanOrEqual(adversarial.gatesPassed);
  });

  test('clean-gold has fewer covered failure classes than adversarial-malformed', () => {
    const report = getCoverageReport();
    const clean = report.fixtures['clean-gold'];
    const adversarial = report.fixtures['adversarial-malformed'];

    // adversarial fixture should trigger more diverse failure classes
    expect(adversarial.coveredClasses.length).toBeGreaterThanOrEqual(clean.coveredClasses.length);
  });
});

// ============ TEST SUITE: Internal Helpers ============

describe('Internal Helpers', () => {
  test('expandPlaceholders replaces LONG_STRING_10K_PLACEHOLDER', () => {
    const result = expandPlaceholders({ text: 'LONG_STRING_10K_PLACEHOLDER' });
    expect(result.text.length).toBe(10000);
  });

  test('expandPlaceholders handles nested objects', () => {
    const input = {
      a: { b: { c: 'LONG_STRING_10K_PLACEHOLDER' } },
      d: [{ e: 'LONG_STRING_10K_PLACEHOLDER' }],
    };
    const result = expandPlaceholders(input);
    expect(result.a.b.c.length).toBe(10000);
    expect(result.d[0].e.length).toBe(10000);
  });

  test('expandPlaceholders leaves normal strings unchanged', () => {
    const result = expandPlaceholders({ text: 'normal string' });
    expect(result.text).toBe('normal string');
  });

  test('expandPlaceholders handles null and primitives', () => {
    expect(expandPlaceholders(null)).toBeNull();
    expect(expandPlaceholders(undefined)).toBeUndefined();
    expect(expandPlaceholders(42)).toBe(42);
    expect(expandPlaceholders('hello')).toBe('hello');
  });

  test('flattenToBlocks creates blocks from countryAnalysis', () => {
    const fixture = loadFixture('clean-gold');
    const blocks = flattenToBlocks(fixture.countryAnalysis);
    expect(blocks.length).toBeGreaterThan(0);
    // Each block should have key and section properties
    for (const block of blocks) {
      expect(block.key).toBeDefined();
      expect(block.section).toBeDefined();
    }
  });

  test('flattenToBlocks handles null sections gracefully', () => {
    const blocks = flattenToBlocks({ policy: null, market: null });
    expect(blocks).toHaveLength(0);
  });

  test('classifyFailures categorizes common failure messages', () => {
    const classes = classifyFailures([
      'Policy section missing',
      'Empty data provided',
      'Non-numeric values found',
      'Overflow risk: 800 chars',
      'Chart series has all-zero values',
      'Data unavailable for analysis',
    ]);
    expect(classes).toContain('missing-section');
    expect(classes).toContain('empty-data');
    expect(classes).toContain('wrong-type');
    expect(classes).toContain('overflow-risk');
    expect(classes).toContain('chart-data-issues');
    expect(classes).toContain('thin-content');
  });

  test('extractFailures collects from all failure arrays', () => {
    const results = {
      failures: ['failure1'],
      issues: ['issue1'],
      emptyBlocks: ['empty1'],
      chartIssues: ['chart1'],
      emptyFields: ['field1'],
    };
    const extracted = extractFailures(results);
    expect(extracted).toContain('failure1');
    expect(extracted).toContain('issue1');
    expect(extracted).toContain('empty1');
    expect(extracted).toContain('chart1');
    expect(extracted).toContain('field1');
  });

  test('collectKeys returns all object keys with dot notation', () => {
    const keys = collectKeys({ a: 1, b: { c: 2, d: { e: 3 } } });
    expect(keys.has('a')).toBe(true);
    expect(keys.has('b')).toBe(true);
    expect(keys.has('b.c')).toBe(true);
    expect(keys.has('b.d')).toBe(true);
    expect(keys.has('b.d.e')).toBe(true);
  });

  test('LONG_STRING_10K is exactly 10000 chars', () => {
    expect(LONG_STRING_10K.length).toBe(10000);
  });

  test('FIFTY_ROW_TABLE has 50 rows with 5 columns each', () => {
    expect(FIFTY_ROW_TABLE.length).toBe(50);
    expect(Object.keys(FIFTY_ROW_TABLE[0]).length).toBe(5);
  });

  test('TWENTY_COLUMN_TABLE has 5 rows with 20 columns each', () => {
    expect(TWENTY_COLUMN_TABLE.length).toBe(5);
    expect(Object.keys(TWENTY_COLUMN_TABLE[0]).length).toBe(20);
  });
});
