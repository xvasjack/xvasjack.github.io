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

// ============ DRIFT THRESHOLDS ============

/**
 * Strict thresholds: zero tolerance. Any deviation is a hard failure.
 * Tolerated thresholds: minor deviations allowed (font rounding, text content variation).
 */
const DRIFT_THRESHOLDS = {
  // Geometry: position/dimension drift (in inches)
  geometry: {
    strict: 0, // zero drift for structural positions
    tolerated: 0.05, // 0.05 inches tolerance for minor rounding
  },
  // Slide dimensions: must match exactly (EMU values)
  slideDimensions: {
    strict: 0, // zero drift
  },
  // Font sizes: must match exactly
  fontSize: {
    strict: 0,
    tolerated: 1, // 1pt tolerance for font size rounding
  },
  // Color values: must match exactly (hex strings)
  color: {
    strict: true, // exact match required
  },
  // Section count: must match exactly
  sectionCount: {
    strict: 0,
  },
  // Slide count: tolerate minor variation
  slideCount: {
    strict: 0,
    tolerated: 2, // allow +/- 2 slides for dynamic content
  },
  // Text content: key headings must be exact, body text can vary
  text: {
    headingsStrict: true, // section headings must match exactly
    bodyTolerated: true, // body text content can differ
  },
  // Score regression: any score drop is flagged
  scoreRegression: {
    strict: 0, // zero regression tolerance
    tolerated: 5, // 5-point tolerance for minor score fluctuations
  },
};

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

// ============ STRUCTURAL BASELINE CAPTURE ============

/**
 * Capture a deterministic structural baseline from template-patterns.json
 * and a countryAnalysis payload. This captures:
 * - Slide geometry (dimensions, positions, placeholders)
 * - Text invariants (section headings, formatting styles)
 * - Template structure (pattern IDs, layout assignments)
 * - Font/color specifications
 *
 * @param {object} countryAnalysis - The country analysis data
 * @param {object} [templatePatterns] - Template patterns (loaded from file if not provided)
 * @returns {object} Structural baseline snapshot
 */
function captureStructuralBaseline(countryAnalysis, templatePatterns) {
  if (!templatePatterns) {
    const patternsPath = path.join(__dirname, 'template-patterns.json');
    if (fs.existsSync(patternsPath)) {
      templatePatterns = JSON.parse(fs.readFileSync(patternsPath, 'utf-8'));
    } else {
      templatePatterns = {};
    }
  }

  const snapshot = {
    _meta: {
      capturedAt: new Date().toISOString(),
      version: '2.0.0',
    },
    slideDimensions: extractSlideDimensions(templatePatterns),
    geometryInvariants: extractGeometryInvariants(templatePatterns),
    textInvariants: extractTextInvariants(countryAnalysis),
    fontSpecifications: extractFontSpecifications(templatePatterns),
    colorSpecifications: extractColorSpecifications(templatePatterns),
    sectionStructure: extractSectionStructure(countryAnalysis),
    templateStructure: extractTemplateStructure(templatePatterns),
  };

  return snapshot;
}

function extractSlideDimensions(templatePatterns) {
  const style = templatePatterns.style || {};
  return {
    widthInches: style.slideWidth || 13.3333,
    heightInches: style.slideHeight || 7.5,
    widthEmu: style.slideWidthEmu || 12192000,
    heightEmu: style.slideHeightEmu || 6858000,
  };
}

function extractGeometryInvariants(templatePatterns) {
  const positions = templatePatterns.pptxPositions || templatePatterns.positions || {};
  const patterns = templatePatterns.patterns || {};
  const invariants = {};

  // Core layout positions
  for (const [key, pos] of Object.entries(positions)) {
    if (pos && typeof pos === 'object') {
      invariants[key] = {
        x: pos.x ?? pos.left ?? null,
        y: pos.y ?? pos.top ?? null,
        w: pos.w ?? pos.width ?? null,
        h: pos.h ?? pos.height ?? null,
      };
    }
  }

  // Pattern-specific element positions
  for (const [patternName, pattern] of Object.entries(patterns)) {
    if (!pattern || !pattern.elements) continue;
    for (const [elemName, elem] of Object.entries(pattern.elements)) {
      if (elem && typeof elem === 'object' && !Array.isArray(elem)) {
        const key = `${patternName}.${elemName}`;
        invariants[key] = {
          x: elem.x ?? null,
          y: elem.y ?? null,
          w: elem.w ?? null,
          h: elem.h ?? null,
        };
      }
    }
  }

  return invariants;
}

function extractTextInvariants(countryAnalysis) {
  if (!countryAnalysis || typeof countryAnalysis !== 'object') return {};

  const invariants = {
    sectionHeadings: [],
    slideTitles: [],
    country: countryAnalysis.country || null,
  };

  const scalarKeys = new Set(['country', 'executiveSummary']);

  for (const [section, sectionData] of Object.entries(countryAnalysis)) {
    if (scalarKeys.has(section)) continue;
    if (!sectionData || typeof sectionData !== 'object' || Array.isArray(sectionData)) continue;

    invariants.sectionHeadings.push(section);
    for (const [subKey, subData] of Object.entries(sectionData)) {
      if (subData && typeof subData === 'object' && subData.slideTitle) {
        invariants.slideTitles.push({
          section,
          subKey,
          slideTitle: subData.slideTitle,
        });
      }
    }
  }

  return invariants;
}

function extractFontSpecifications(templatePatterns) {
  const style = templatePatterns.style || {};
  const fonts = style.fonts || {};
  return JSON.parse(JSON.stringify(fonts));
}

function extractColorSpecifications(templatePatterns) {
  const style = templatePatterns.style || {};
  const colors = style.colors || {};
  return JSON.parse(JSON.stringify(colors));
}

function extractSectionStructure(countryAnalysis) {
  if (!countryAnalysis || typeof countryAnalysis !== 'object') return {};

  const structure = {};
  const knownSections = ['policy', 'market', 'competitors', 'depth', 'summary'];
  const scalarKeys = new Set(['country', 'executiveSummary']);

  // Always track the 5 known sections
  for (const section of knownSections) {
    const sectionData = countryAnalysis[section];
    if (!sectionData || typeof sectionData !== 'object') {
      structure[section] = { present: false, subKeys: [] };
      continue;
    }
    structure[section] = {
      present: true,
      subKeys: Object.keys(sectionData).sort(),
    };
  }

  // Also capture any additional top-level object sections (e.g. insights)
  for (const key of Object.keys(countryAnalysis)) {
    if (knownSections.includes(key) || scalarKeys.has(key)) continue;
    const val = countryAnalysis[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      structure[key] = {
        present: true,
        subKeys: Object.keys(val).sort(),
      };
    }
  }

  return structure;
}

function extractTemplateStructure(templatePatterns) {
  const patterns = templatePatterns.patterns || {};
  const structure = {};

  for (const [name, pattern] of Object.entries(patterns)) {
    if (!pattern || typeof pattern !== 'object') continue;
    structure[name] = {
      id: pattern.id,
      layout: pattern.layout,
      templateSlides: pattern.templateSlides || [],
      elementKeys: pattern.elements ? Object.keys(pattern.elements).sort() : [],
    };
  }

  return structure;
}

// ============ STRUCTURAL BASELINE PERSISTENCE ============

const STRUCTURAL_BASELINES_DIR = path.join(__dirname, 'fixtures', 'wave2b', '.structural-baselines');

function ensureStructuralBaselinesDir() {
  if (!fs.existsSync(STRUCTURAL_BASELINES_DIR)) {
    fs.mkdirSync(STRUCTURAL_BASELINES_DIR, { recursive: true });
  }
}

function saveStructuralBaseline(name, snapshot) {
  if (!name || typeof name !== 'string') {
    throw new Error('Structural baseline name must be a non-empty string');
  }
  ensureStructuralBaselinesDir();
  const filePath = path.join(
    STRUCTURAL_BASELINES_DIR,
    `${path.basename(name)}.structural.json`
  );
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

function loadStructuralBaseline(name) {
  const filePath = path.join(
    STRUCTURAL_BASELINES_DIR,
    `${path.basename(name)}.structural.json`
  );
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function deleteStructuralBaseline(name) {
  const filePath = path.join(
    STRUCTURAL_BASELINES_DIR,
    `${path.basename(name)}.structural.json`
  );
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

// ============ STRUCTURAL DRIFT COMPARISON ============

/**
 * Compare a current structural snapshot to a saved structural baseline.
 * Returns a categorized drift report with strict/tolerated classification.
 *
 * @param {string} name - Baseline name
 * @param {object} currentSnapshot - Current structural snapshot
 * @param {object} [thresholds] - Override thresholds (defaults to DRIFT_THRESHOLDS)
 * @returns {object} Structural drift report
 */
function compareStructuralBaseline(name, currentSnapshot, thresholds) {
  const baseline = loadStructuralBaseline(name);
  if (!baseline) {
    return {
      baselineFound: false,
      name,
      error: `No structural baseline found for "${name}"`,
      drift: null,
    };
  }

  const t = thresholds || DRIFT_THRESHOLDS;
  const drift = detectStructuralDrift(baseline, currentSnapshot, t);

  return {
    baselineFound: true,
    name,
    baselineCreatedAt: baseline._meta?.capturedAt,
    drift,
    hasDrift: drift.totalDriftItems > 0,
    hasStrictViolations: drift.strictViolations.length > 0,
    hasToleratedDrift: drift.toleratedDrift.length > 0,
    verdict: drift.strictViolations.length > 0 ? 'FAIL' : drift.toleratedDrift.length > 0 ? 'WARN' : 'PASS',
  };
}

/**
 * Core structural drift detection engine.
 */
function detectStructuralDrift(baseline, current, thresholds) {
  const report = {
    strictViolations: [],
    toleratedDrift: [],
    totalDriftItems: 0,
  };

  if (!baseline || !current) {
    report.strictViolations.push({
      category: 'missing-data',
      detail: !baseline ? 'Baseline is null' : 'Current snapshot is null',
    });
    report.totalDriftItems = 1;
    return report;
  }

  // 1. Slide dimension drift
  compareSlideDimensions(baseline.slideDimensions, current.slideDimensions, thresholds, report);

  // 2. Geometry invariant drift
  compareGeometryInvariants(baseline.geometryInvariants, current.geometryInvariants, thresholds, report);

  // 3. Font specification drift
  compareFontSpecifications(baseline.fontSpecifications, current.fontSpecifications, report);

  // 4. Color specification drift
  compareColorSpecifications(baseline.colorSpecifications, current.colorSpecifications, report);

  // 5. Section structure drift
  compareSectionStructure(baseline.sectionStructure, current.sectionStructure, report);

  // 6. Text invariant drift
  compareTextInvariants(baseline.textInvariants, current.textInvariants, thresholds, report);

  // 7. Template structure drift
  compareTemplateStructure(baseline.templateStructure, current.templateStructure, report);

  report.totalDriftItems = report.strictViolations.length + report.toleratedDrift.length;
  return report;
}

function compareSlideDimensions(baseline, current, thresholds, report) {
  if (!baseline || !current) return;

  const fields = ['widthInches', 'heightInches', 'widthEmu', 'heightEmu'];
  for (const field of fields) {
    if (baseline[field] != null && current[field] != null && baseline[field] !== current[field]) {
      report.strictViolations.push({
        category: 'slide-dimensions',
        field,
        baselineValue: baseline[field],
        currentValue: current[field],
        delta: current[field] - baseline[field],
      });
    }
  }
}

function compareGeometryInvariants(baseline, current, thresholds, report) {
  if (!baseline || !current) return;

  const geoThreshold = thresholds.geometry || { strict: 0, tolerated: 0.05 };
  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);

  for (const key of allKeys) {
    const base = baseline[key];
    const cur = current[key];

    if (!base && cur) {
      report.strictViolations.push({
        category: 'geometry-added',
        element: key,
        detail: 'New geometry element not in baseline',
      });
      continue;
    }
    if (base && !cur) {
      report.strictViolations.push({
        category: 'geometry-removed',
        element: key,
        detail: 'Baseline geometry element missing from current',
      });
      continue;
    }
    if (!base || !cur) continue;

    for (const dim of ['x', 'y', 'w', 'h']) {
      if (base[dim] == null || cur[dim] == null) continue;
      const delta = Math.abs(cur[dim] - base[dim]);
      if (delta === 0) continue;

      if (delta > geoThreshold.tolerated) {
        report.strictViolations.push({
          category: 'geometry-drift',
          element: key,
          dimension: dim,
          baselineValue: base[dim],
          currentValue: cur[dim],
          delta: cur[dim] - base[dim],
        });
      } else if (delta > geoThreshold.strict) {
        report.toleratedDrift.push({
          category: 'geometry-drift-minor',
          element: key,
          dimension: dim,
          baselineValue: base[dim],
          currentValue: cur[dim],
          delta: cur[dim] - base[dim],
        });
      }
    }
  }
}

function compareFontSpecifications(baseline, current, report) {
  if (!baseline || !current) return;

  const baseFlat = flattenObject(baseline);
  const curFlat = flattenObject(current);
  const allKeys = new Set([...Object.keys(baseFlat), ...Object.keys(curFlat)]);

  for (const key of allKeys) {
    if (baseFlat[key] !== curFlat[key]) {
      if (!(key in baseFlat)) {
        report.toleratedDrift.push({
          category: 'font-added',
          field: key,
          currentValue: curFlat[key],
        });
      } else if (!(key in curFlat)) {
        report.strictViolations.push({
          category: 'font-removed',
          field: key,
          baselineValue: baseFlat[key],
        });
      } else {
        report.strictViolations.push({
          category: 'font-changed',
          field: key,
          baselineValue: baseFlat[key],
          currentValue: curFlat[key],
        });
      }
    }
  }
}

function compareColorSpecifications(baseline, current, report) {
  if (!baseline || !current) return;

  const baseFlat = flattenObject(baseline);
  const curFlat = flattenObject(current);
  const allKeys = new Set([...Object.keys(baseFlat), ...Object.keys(curFlat)]);

  for (const key of allKeys) {
    if (baseFlat[key] !== curFlat[key]) {
      if (!(key in baseFlat)) {
        report.toleratedDrift.push({
          category: 'color-added',
          field: key,
          currentValue: curFlat[key],
        });
      } else if (!(key in curFlat)) {
        report.strictViolations.push({
          category: 'color-removed',
          field: key,
          baselineValue: baseFlat[key],
        });
      } else {
        report.strictViolations.push({
          category: 'color-changed',
          field: key,
          baselineValue: baseFlat[key],
          currentValue: curFlat[key],
        });
      }
    }
  }
}

function compareSectionStructure(baseline, current, report) {
  if (!baseline || !current) return;

  const allSections = new Set([...Object.keys(baseline), ...Object.keys(current)]);

  for (const section of allSections) {
    const base = baseline[section];
    const cur = current[section];

    if (!base && cur) {
      report.toleratedDrift.push({
        category: 'section-added',
        section,
      });
      continue;
    }
    if (base && !cur) {
      report.strictViolations.push({
        category: 'section-removed',
        section,
      });
      continue;
    }
    if (!base || !cur) continue;

    // Presence change
    if (base.present !== cur.present) {
      if (base.present && !cur.present) {
        report.strictViolations.push({
          category: 'section-missing',
          section,
          detail: 'Section was present in baseline but missing in current',
        });
      } else {
        report.toleratedDrift.push({
          category: 'section-appeared',
          section,
          detail: 'Section was missing in baseline but present in current',
        });
      }
      continue;
    }

    // SubKey changes
    const baseSubKeys = new Set(base.subKeys || []);
    const curSubKeys = new Set(cur.subKeys || []);

    for (const sk of curSubKeys) {
      if (!baseSubKeys.has(sk)) {
        report.toleratedDrift.push({
          category: 'subkey-added',
          section,
          subKey: sk,
        });
      }
    }
    for (const sk of baseSubKeys) {
      if (!curSubKeys.has(sk)) {
        report.strictViolations.push({
          category: 'subkey-removed',
          section,
          subKey: sk,
        });
      }
    }
  }
}

function compareTextInvariants(baseline, current, thresholds, report) {
  if (!baseline || !current) return;

  // Country must match exactly
  if (baseline.country && current.country && baseline.country !== current.country) {
    report.strictViolations.push({
      category: 'country-mismatch',
      baselineValue: baseline.country,
      currentValue: current.country,
    });
  }

  // Section headings must match (strict)
  const baseHeadings = new Set(baseline.sectionHeadings || []);
  const curHeadings = new Set(current.sectionHeadings || []);

  for (const h of baseHeadings) {
    if (!curHeadings.has(h)) {
      report.strictViolations.push({
        category: 'heading-removed',
        heading: h,
      });
    }
  }
  for (const h of curHeadings) {
    if (!baseHeadings.has(h)) {
      report.toleratedDrift.push({
        category: 'heading-added',
        heading: h,
      });
    }
  }

  // Slide titles: check structural presence (title text can vary for dynamic content)
  const baseTitles = baseline.slideTitles || [];
  const curTitles = current.slideTitles || [];

  const baseTitleKeys = new Set(baseTitles.map((t) => `${t.section}/${t.subKey}`));
  const curTitleKeys = new Set(curTitles.map((t) => `${t.section}/${t.subKey}`));

  for (const tk of baseTitleKeys) {
    if (!curTitleKeys.has(tk)) {
      report.strictViolations.push({
        category: 'slide-title-removed',
        titleKey: tk,
      });
    }
  }
  for (const tk of curTitleKeys) {
    if (!baseTitleKeys.has(tk)) {
      report.toleratedDrift.push({
        category: 'slide-title-added',
        titleKey: tk,
      });
    }
  }
}

function compareTemplateStructure(baseline, current, report) {
  if (!baseline || !current) return;

  const allPatterns = new Set([...Object.keys(baseline), ...Object.keys(current)]);

  for (const pattern of allPatterns) {
    const base = baseline[pattern];
    const cur = current[pattern];

    if (!base && cur) {
      report.toleratedDrift.push({
        category: 'pattern-added',
        pattern,
      });
      continue;
    }
    if (base && !cur) {
      report.strictViolations.push({
        category: 'pattern-removed',
        pattern,
      });
      continue;
    }
    if (!base || !cur) continue;

    // Layout change is strict
    if (base.layout !== cur.layout) {
      report.strictViolations.push({
        category: 'pattern-layout-changed',
        pattern,
        baselineValue: base.layout,
        currentValue: cur.layout,
      });
    }

    // Element keys change
    const baseElems = new Set(base.elementKeys || []);
    const curElems = new Set(cur.elementKeys || []);

    for (const e of baseElems) {
      if (!curElems.has(e)) {
        report.strictViolations.push({
          category: 'pattern-element-removed',
          pattern,
          element: e,
        });
      }
    }
    for (const e of curElems) {
      if (!baseElems.has(e)) {
        report.toleratedDrift.push({
          category: 'pattern-element-added',
          pattern,
          element: e,
        });
      }
    }
  }
}

// ============ UTILITY ============

function flattenObject(obj, prefix = '', result = {}) {
  if (!obj || typeof obj !== 'object') return result;
  if (Array.isArray(obj)) {
    result[prefix] = JSON.stringify(obj);
    return result;
  }
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenObject(value, fullKey, result);
    } else {
      result[fullKey] = Array.isArray(value) ? JSON.stringify(value) : value;
    }
  }
  return result;
}

// ============ COMBINED DRIFT CHECK ============

/**
 * Run both gate-result drift and structural drift checks.
 * @param {string} name - Baseline name
 * @param {object} currentGateResults - Current gate validation results
 * @param {object} currentCountryAnalysis - Current country analysis data
 * @param {object} [templatePatterns] - Template patterns (auto-loaded if null)
 * @returns {object} Combined drift report
 */
function runFullDriftCheck(name, currentGateResults, currentCountryAnalysis, templatePatterns) {
  const gateReport = compareToBaseline(name, currentGateResults);
  const currentStructural = captureStructuralBaseline(currentCountryAnalysis, templatePatterns);
  const structuralReport = compareStructuralBaseline(name, currentStructural);

  const verdicts = [];
  if (gateReport.hasDrift) verdicts.push('gate-drift');
  if (structuralReport.hasStrictViolations) verdicts.push('structural-strict');
  if (structuralReport.hasToleratedDrift) verdicts.push('structural-tolerated');

  return {
    name,
    gate: gateReport,
    structural: structuralReport,
    overallVerdict: structuralReport.hasStrictViolations || (gateReport.hasDrift && gateReport.drift?.newFailures?.length > 0)
      ? 'FAIL'
      : verdicts.length > 0
        ? 'WARN'
        : 'PASS',
    verdictReasons: verdicts,
  };
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
  // Structural baseline API
  captureStructuralBaseline,
  saveStructuralBaseline,
  loadStructuralBaseline,
  deleteStructuralBaseline,
  compareStructuralBaseline,
  detectStructuralDrift,
  runFullDriftCheck,
  DRIFT_THRESHOLDS,
  // Internals for testing
  __test: {
    expandPlaceholders,
    generateRepeatingText,
    generateTable,
    flattenToBlocks,
    classifyFailures,
    extractFailures,
    collectKeys,
    flattenObject,
    extractSlideDimensions,
    extractGeometryInvariants,
    extractTextInvariants,
    extractFontSpecifications,
    extractColorSpecifications,
    extractSectionStructure,
    extractTemplateStructure,
    compareSlideDimensions,
    compareGeometryInvariants,
    compareFontSpecifications,
    compareColorSpecifications,
    compareSectionStructure,
    compareTextInvariants,
    compareTemplateStructure,
    FIXTURES_DIR,
    BASELINES_DIR,
    STRUCTURAL_BASELINES_DIR,
    LONG_STRING_10K,
    FIFTY_ROW_TABLE,
    TWENTY_COLUMN_TABLE,
  },
};
