'use strict';

/**
 * Golden Baseline Manager — fixture loading, baseline snapshotting,
 * drift detection, and coverage reporting for regression test fixtures.
 *
 * No external API calls. All operations are local file-based.
 */

const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'wave2b');
const BASELINES_DIR = path.join(__dirname, 'fixtures', 'wave2b', '.baselines');

// ============ FIXTURE LOADING ============

/**
 * Load a fixture by name from fixtures/wave2b/.
 * @param {string} name - Fixture name (without .json extension)
 * @returns {object} Parsed fixture data
 */
function loadFixture(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Fixture name must be a non-empty string');
  }

  // Prevent path traversal
  const sanitized = path.basename(name.replace(/\.json$/, ''));
  const filePath = path.join(FIXTURES_DIR, `${sanitized}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Fixture not found: ${sanitized} (looked at ${filePath})`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Fixture ${sanitized} has invalid JSON: ${err.message}`);
  }

  // Expand placeholder strings for edge-size-extremes fixture
  if (sanitized === 'edge-size-extremes') {
    parsed = expandPlaceholders(parsed);
  }

  return parsed;
}

/**
 * List all available fixture names.
 * @returns {string[]} Array of fixture names (without .json)
 */
function listFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

// ============ PLACEHOLDER EXPANSION ============

const LONG_STRING_10K = generateRepeatingText(10000);
const FIFTY_ROW_TABLE = generateTable(50, 5);
const TWENTY_COLUMN_TABLE = generateTable(5, 20);

function generateRepeatingText(targetLength) {
  const sentences = [
    'Market analysis indicates sustained growth potential across all segments. ',
    'Investment opportunities continue to emerge as regulatory frameworks mature. ',
    'Competitive dynamics are shifting with new entrants from adjacent industries. ',
    'Technology adoption rates exceed regional averages in key verticals. ',
    'Local talent availability supports scaling operations within 12-18 months. ',
    'Government incentive programs provide favorable conditions for foreign investment. ',
    'Supply chain infrastructure meets requirements for most operational models. ',
    'Consumer demand patterns align with projected growth trajectories. ',
    'Financial services ecosystem supports complex deal structures and financing. ',
    'Risk profile remains within acceptable parameters for market entry decisions. ',
  ];
  let result = '';
  let idx = 0;
  while (result.length < targetLength) {
    result += sentences[idx % sentences.length];
    idx++;
  }
  return result.substring(0, targetLength);
}

function generateTable(rows, cols) {
  const table = [];
  for (let r = 0; r < rows; r++) {
    const row = {};
    for (let c = 0; c < cols; c++) {
      row[`col_${c}`] = `Row${r + 1}_Col${c + 1}_Value_${(Math.random() * 1000).toFixed(0)}`;
    }
    table.push(row);
  }
  return table;
}

function expandPlaceholders(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    if (obj === 'LONG_STRING_10K_PLACEHOLDER') return LONG_STRING_10K;
    if (obj === 'FIFTY_ROW_TABLE_PLACEHOLDER') return obj; // stays as string marker
    if (obj === 'TWENTY_COLUMN_TABLE_PLACEHOLDER') return obj; // stays as string marker
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => expandPlaceholders(item));
  }
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'tableData' && value === 'FIFTY_ROW_TABLE_PLACEHOLDER') {
        result[key] = FIFTY_ROW_TABLE;
      } else if (key === 'tableData' && value === 'TWENTY_COLUMN_TABLE_PLACEHOLDER') {
        result[key] = TWENTY_COLUMN_TABLE;
      } else {
        result[key] = expandPlaceholders(value);
      }
    }
    return result;
  }
  return obj;
}

// ============ BASELINE MANAGEMENT ============

function ensureBaselinesDir() {
  if (!fs.existsSync(BASELINES_DIR)) {
    fs.mkdirSync(BASELINES_DIR, { recursive: true });
  }
}

/**
 * Snapshot gate results as a golden baseline.
 * @param {string} name - Baseline name (typically matches fixture name)
 * @param {object} gateResults - Gate validation results to snapshot
 * @returns {object} The stored baseline with metadata
 */
function createBaseline(name, gateResults) {
  if (!name || typeof name !== 'string') {
    throw new Error('Baseline name must be a non-empty string');
  }
  if (!gateResults || typeof gateResults !== 'object') {
    throw new Error('Gate results must be a non-null object');
  }

  ensureBaselinesDir();

  const baseline = {
    _meta: {
      name,
      createdAt: new Date().toISOString(),
      version: '1.0.0',
    },
    gateResults: JSON.parse(JSON.stringify(gateResults)), // deep clone
  };

  const filePath = path.join(BASELINES_DIR, `${path.basename(name)}.baseline.json`);
  fs.writeFileSync(filePath, JSON.stringify(baseline, null, 2));
  return baseline;
}

/**
 * Load a golden baseline by name.
 * @param {string} name - Baseline name
 * @returns {object|null} The baseline data or null if not found
 */
function loadBaseline(name) {
  const filePath = path.join(BASELINES_DIR, `${path.basename(name)}.baseline.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Delete a baseline by name.
 * @param {string} name - Baseline name
 * @returns {boolean} True if deleted, false if not found
 */
function deleteBaseline(name) {
  const filePath = path.join(BASELINES_DIR, `${path.basename(name)}.baseline.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

// ============ DRIFT DETECTION ============

/**
 * Compare current results to a golden baseline, return drift report.
 * @param {string} name - Baseline name to compare against
 * @param {object} currentResults - Current gate validation results
 * @returns {object} Drift report
 */
function compareToBaseline(name, currentResults) {
  const baseline = loadBaseline(name);
  if (!baseline) {
    return {
      baselineFound: false,
      name,
      error: `No baseline found for "${name}"`,
      drift: null,
    };
  }

  const drift = detectDrift(baseline.gateResults, currentResults);

  return {
    baselineFound: true,
    name,
    baselineCreatedAt: baseline._meta.createdAt,
    drift,
    hasDrift: drift.totalDriftItems > 0,
  };
}

/**
 * Detailed drift detection between baseline and current results.
 * @param {object} baseline - Baseline gate results
 * @param {object} current - Current gate results
 * @returns {object} Detailed drift report
 */
function detectDrift(baseline, current) {
  const report = {
    newFailures: [],
    fixedFailures: [],
    scoreChanges: [],
    structuralChanges: [],
    totalDriftItems: 0,
  };

  if (!baseline || !current) {
    report.structuralChanges.push({
      type: 'missing-data',
      detail: !baseline ? 'Baseline is null/undefined' : 'Current results are null/undefined',
    });
    report.totalDriftItems = 1;
    return report;
  }

  // Compare pass/fail status
  if (baseline.pass !== undefined && current.pass !== undefined) {
    if (baseline.pass && !current.pass) {
      report.newFailures.push({
        field: 'overall',
        baselineValue: 'pass',
        currentValue: 'fail',
      });
    } else if (!baseline.pass && current.pass) {
      report.fixedFailures.push({
        field: 'overall',
        baselineValue: 'fail',
        currentValue: 'pass',
      });
    }
  }

  // Compare scores
  compareScores(baseline, current, '', report);

  // Compare failure arrays
  const baselineFailures = extractFailures(baseline);
  const currentFailures = extractFailures(current);

  const baselineSet = new Set(baselineFailures);
  const currentSet = new Set(currentFailures);

  for (const failure of currentFailures) {
    if (!baselineSet.has(failure)) {
      report.newFailures.push({ field: 'failures', detail: failure });
    }
  }

  for (const failure of baselineFailures) {
    if (!currentSet.has(failure)) {
      report.fixedFailures.push({ field: 'failures', detail: failure });
    }
  }

  // Compare structural keys
  const baselineKeys = collectKeys(baseline);
  const currentKeys = collectKeys(current);

  for (const key of currentKeys) {
    if (!baselineKeys.has(key)) {
      report.structuralChanges.push({ type: 'new-key', key });
    }
  }
  for (const key of baselineKeys) {
    if (!currentKeys.has(key)) {
      report.structuralChanges.push({ type: 'removed-key', key });
    }
  }

  report.totalDriftItems =
    report.newFailures.length +
    report.fixedFailures.length +
    report.scoreChanges.length +
    report.structuralChanges.length;

  return report;
}

function compareScores(baseline, current, prefix, report) {
  // Compare direct numeric fields (score, overall, sectionScores)
  const numericFields = ['score', 'overall', 'semanticallyEmptyRatio'];
  for (const field of numericFields) {
    if (typeof baseline[field] === 'number' && typeof current[field] === 'number') {
      if (baseline[field] !== current[field]) {
        report.scoreChanges.push({
          field: prefix ? `${prefix}.${field}` : field,
          baselineValue: baseline[field],
          currentValue: current[field],
          delta: current[field] - baseline[field],
        });
      }
    }
  }

  // Recurse into sectionScores
  if (baseline.sectionScores && current.sectionScores) {
    for (const [key, baseVal] of Object.entries(baseline.sectionScores)) {
      const curVal = current.sectionScores[key];
      if (typeof baseVal === 'number' && typeof curVal === 'number' && baseVal !== curVal) {
        report.scoreChanges.push({
          field: `sectionScores.${key}`,
          baselineValue: baseVal,
          currentValue: curVal,
          delta: curVal - baseVal,
        });
      }
    }
  }
}

function extractFailures(results) {
  const failures = [];
  if (Array.isArray(results.failures)) {
    failures.push(...results.failures.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))));
  }
  if (Array.isArray(results.issues)) {
    failures.push(...results.issues.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))));
  }
  if (Array.isArray(results.emptyBlocks)) {
    failures.push(
      ...results.emptyBlocks.map((f) => (typeof f === 'string' ? f : JSON.stringify(f)))
    );
  }
  if (Array.isArray(results.chartIssues)) {
    failures.push(
      ...results.chartIssues.map((f) => (typeof f === 'string' ? f : JSON.stringify(f)))
    );
  }
  if (Array.isArray(results.emptyFields)) {
    failures.push(
      ...results.emptyFields.map((f) => (typeof f === 'string' ? f : JSON.stringify(f)))
    );
  }
  return failures;
}

function collectKeys(obj, prefix = '', result = new Set()) {
  if (!obj || typeof obj !== 'object') return result;
  if (Array.isArray(obj)) return result;
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    result.add(fullKey);
    if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      collectKeys(obj[key], fullKey, result);
    }
  }
  return result;
}

// ============ FIXTURE REPLAY ============

/**
 * Deterministic fixture replay — runs the fixture through quality gates.
 * No paid API calls. All validation is local.
 * @param {string} name - Fixture name to replay
 * @returns {object} Gate results for the fixture
 */
function replayFixture(name) {
  const {
    validateResearchQuality,
    validateSynthesisQuality,
    validatePptData,
  } = require('./quality-gates');

  const fixture = loadFixture(name);
  const { synthesis, countryAnalysis, scope } = fixture;

  const results = {
    fixtureName: name,
    fixtureMeta: fixture._meta || null,
    gates: {},
  };

  // Gate: Synthesis quality
  try {
    const industry = scope?.industry || null;
    results.gates.synthesisQuality = validateSynthesisQuality(
      synthesis?.isSingleCountry ? { ...synthesis, ...countryAnalysis } : countryAnalysis,
      industry
    );
  } catch (err) {
    results.gates.synthesisQuality = {
      pass: false,
      error: err.message,
      errorType: 'exception',
    };
  }

  // Gate: PPT data (if countryAnalysis is available)
  try {
    if (countryAnalysis && typeof countryAnalysis === 'object') {
      // Flatten countryAnalysis sections into blocks for PPT data validation
      const blocks = flattenToBlocks(countryAnalysis);
      results.gates.pptData = validatePptData(blocks);
    } else {
      results.gates.pptData = {
        pass: false,
        error: 'No countryAnalysis data available',
        errorType: 'missing-data',
      };
    }
  } catch (err) {
    results.gates.pptData = {
      pass: false,
      error: err.message,
      errorType: 'exception',
    };
  }

  return results;
}

/**
 * Flatten countryAnalysis into a block array suitable for validatePptData.
 */
function flattenToBlocks(countryAnalysis) {
  const blocks = [];
  const sections = ['policy', 'market', 'competitors', 'depth', 'summary'];

  for (const section of sections) {
    const sectionData = countryAnalysis[section];
    if (!sectionData || typeof sectionData !== 'object') continue;

    for (const [subKey, subData] of Object.entries(sectionData)) {
      if (!subData || typeof subData !== 'object') continue;
      blocks.push({
        key: section,
        section,
        subKey,
        title: subData.slideTitle || subKey,
        ...subData,
      });
    }
  }

  return blocks;
}

// ============ COVERAGE REPORTING ============

/**
 * Report which failure classes are covered by which fixtures.
 * Runs all fixtures through gates and maps failures to fixtures.
 * @returns {object} Coverage report
 */
function getCoverageReport() {
  const fixtures = listFixtures();
  const coverage = {
    fixtures: {},
    failureClassToCoverage: {},
    uncoveredClasses: [],
    totalFixtures: fixtures.length,
    totalFailureClasses: 0,
  };

  // Known failure classes to track coverage against
  const knownFailureClasses = [
    'missing-section',
    'empty-data',
    'wrong-type',
    'null-required-field',
    'overflow-risk',
    'chart-data-issues',
    'semantic-empty',
    'schema-violation',
    'deep-nesting',
    'boundary-values',
  ];

  for (const name of fixtures) {
    try {
      const result = replayFixture(name);
      const meta = result.fixtureMeta || {};
      const allFailures = [];

      // Collect all failures from all gates
      for (const [gateName, gateResult] of Object.entries(result.gates)) {
        if (gateResult.failures) allFailures.push(...gateResult.failures);
        if (gateResult.issues) allFailures.push(...gateResult.issues);
        if (gateResult.emptyBlocks) allFailures.push(...gateResult.emptyBlocks);
        if (gateResult.chartIssues) allFailures.push(...gateResult.chartIssues);
        if (gateResult.emptyFields) allFailures.push(...gateResult.emptyFields);
        if (gateResult.error) allFailures.push(gateResult.error);
      }

      // Classify which failure classes this fixture covers
      const coveredClasses = classifyFailures(allFailures);

      coverage.fixtures[name] = {
        expectedOutcome: meta.expectedOutcome || 'unknown',
        gatesPassed: Object.values(result.gates).filter((g) => g.pass).length,
        gatesFailed: Object.values(result.gates).filter((g) => !g.pass).length,
        totalFailures: allFailures.length,
        coveredClasses,
      };

      for (const cls of coveredClasses) {
        if (!coverage.failureClassToCoverage[cls]) {
          coverage.failureClassToCoverage[cls] = [];
        }
        coverage.failureClassToCoverage[cls].push(name);
      }
    } catch (err) {
      coverage.fixtures[name] = {
        error: err.message,
        coveredClasses: [],
      };
    }
  }

  // Determine which known classes are not covered
  const coveredSet = new Set(Object.keys(coverage.failureClassToCoverage));
  coverage.uncoveredClasses = knownFailureClasses.filter((cls) => !coveredSet.has(cls));
  coverage.totalFailureClasses = coveredSet.size;

  return coverage;
}

function classifyFailures(failures) {
  const classes = new Set();
  for (const f of failures) {
    const text = typeof f === 'string' ? f : JSON.stringify(f);
    const lower = text.toLowerCase();

    if (/missing|not found|section missing/.test(lower)) classes.add('missing-section');
    if (/empty|no .* provided|0.*items|no blocks/.test(lower)) classes.add('empty-data');
    if (/type|not a|invalid|non-numeric/.test(lower)) classes.add('wrong-type');
    if (/null|undefined/.test(lower)) classes.add('null-required-field');
    if (/overflow|exceed|char|too long|10k|600/.test(lower)) classes.add('overflow-risk');
    if (/chart|series|data point|all-zero|negative|stacked/.test(lower))
      classes.add('chart-data-issues');
    if (/semantic|placeholder|unavailable|insufficient|tbd|n\/a/.test(lower))
      classes.add('semantic-empty');
    if (/schema|structural|corrupt/.test(lower)) classes.add('schema-violation');
    if (/nest|deep|level|circular/.test(lower)) classes.add('deep-nesting');
    if (/boundary|extreme|max|min|zero|single|empty array/.test(lower))
      classes.add('boundary-values');
  }
  return [...classes];
}

// ============ EXPORTS ============

module.exports = {
  loadFixture,
  listFixtures,
  createBaseline,
  loadBaseline,
  deleteBaseline,
  compareToBaseline,
  detectDrift,
  replayFixture,
  getCoverageReport,
  // Internals for testing
  __test: {
    expandPlaceholders,
    generateRepeatingText,
    generateTable,
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
};
