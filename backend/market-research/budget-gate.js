// Budget gate — pre-render budget analyzer that sits between quality gates
// and PPT renderer. Catches payloads that are structurally valid but would
// cause late render stress (overflow, dense tables, thin charts).

// ============ CONSTANTS ============

const FIELD_CHAR_BUDGETS = {
  _default: 500,
  'policy.regulatorySummary': 800,
  'policy.foundationalActs': 600,
  'policy.nationalPolicy': 600,
  'policy.investmentRestrictions': 600,
  'policy.keyIncentives': 600,
  'market.marketSizeAndGrowth.overview': 600,
  'market.marketSizeAndGrowth.keyInsight': 400,
  'market.supplyAndDemandDynamics.overview': 600,
  'market.pricingAndTariffStructures.overview': 600,
  'competitors.localMajor': 800,
  'competitors.foreignPlayers': 800,
  'competitors.japanesePlayers': 800,
  'depth.dealEconomics': 600,
  'depth.partnerAssessment': 600,
  'depth.entryStrategy': 600,
  'depth.implementation': 600,
  'depth.targetSegments': 600,
  'summary.recommendation': 500,
  'summary.goNoGo': 400,
  'insights.whyNow': 500,
};

const TABLE_MAX_ROWS = parseInt(process.env.TABLE_FLEX_MAX_ROWS, 10) || 16;
const TABLE_MAX_COLS = parseInt(process.env.TABLE_FLEX_MAX_COLS, 10) || 9;
const TABLE_MAX_AVG_CELL_LEN = 80;
const TABLE_DENSITY_LIMIT = 200;
const CHART_MIN_DATA_POINTS = 4;

// ============ HELPERS ============

function getFieldLimit(section, key) {
  const full = key ? `${section}.${key}` : section;
  return FIELD_CHAR_BUDGETS[full] || FIELD_CHAR_BUDGETS._default;
}

function walkStringFields(obj, prefix, cb, depth) {
  if (depth > 10) return;
  if (obj == null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => walkStringFields(item, `${prefix}[${i}]`, cb, depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      cb(path, v, prefix, k);
    } else if (v && typeof v === 'object') {
      walkStringFields(v, path, cb, depth + 1);
    }
  }
}

function findTableCandidates(obj, prefix, results, depth) {
  if (depth > 10) return;
  if (obj == null || typeof obj !== 'object') return;
  if (Array.isArray(obj) && obj.length > 0) {
    const firstObj = obj.find((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (firstObj) {
      const stringKeys = Object.keys(firstObj).filter((k) => typeof firstObj[k] === 'string');
      if (stringKeys.length >= 3) {
        results.push({ path: prefix, rows: obj });
        return;
      }
    }
    obj.forEach((item, i) => findTableCandidates(item, `${prefix}[${i}]`, results, depth + 1));
    return;
  }
  if (!Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      findTableCandidates(v, prefix ? `${prefix}.${k}` : k, results, depth + 1);
    }
  }
}

function findChartData(obj, prefix, results, depth) {
  if (depth > 10) return;
  if (obj == null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => findChartData(item, `${prefix}[${i}]`, results, depth + 1));
    return;
  }
  if (obj.series || obj.values) {
    results.push({ path: prefix, chartData: obj });
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') {
      findChartData(v, prefix ? `${prefix}.${k}` : k, results, depth + 1);
    }
  }
}

function flattenSeries(series) {
  if (!series) return [];
  if (!Array.isArray(series)) return [];
  const result = [];
  for (const item of series) {
    if (typeof item === 'number') {
      result.push(item);
    } else if (item?.data && Array.isArray(item.data)) {
      result.push(...item.data);
    } else if (item?.values && Array.isArray(item.values)) {
      result.push(...item.values);
    }
  }
  return result;
}

function trimToSentenceBoundary(text, limit) {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastPeriod = slice.lastIndexOf('. ');
  const lastExcl = slice.lastIndexOf('! ');
  const lastQuest = slice.lastIndexOf('? ');
  const boundary = Math.max(lastPeriod, lastExcl, lastQuest);
  if (boundary > limit * 0.3) {
    return slice.slice(0, boundary + 1).trim();
  }
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > limit * 0.3) {
    return slice.slice(0, lastSpace).trim();
  }
  return slice.trim();
}

function sectionFromPath(path) {
  const parts = path.replace(/\[\d+\]/g, '').split('.');
  return parts[0] || '';
}

function keyFromPath(path) {
  const parts = path.replace(/\[\d+\]/g, '').split('.');
  return parts.slice(1).join('.') || '';
}

function deepClone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

// ============ ANALYZE BUDGET ============

/**
 * Analyzes a country analysis object and returns a budget report
 * describing field overflows, table density, chart issues, and overall risk.
 * @param {object} countryAnalysis
 * @returns {{ risk: string, fieldBudgets: Array, tableDensity: Array, chartSanity: Array, issues: string[] }}
 */
function analyzeBudget(countryAnalysis) {
  const fieldBudgets = [];
  const tableDensity = [];
  const chartSanity = [];
  const issues = [];

  if (!countryAnalysis || typeof countryAnalysis !== 'object') {
    return { risk: 'high', fieldBudgets, tableDensity, chartSanity, issues: ['No analysis data'] };
  }

  // --- Field char budgets ---
  walkStringFields(
    countryAnalysis,
    '',
    (path, value, parentPath) => {
      const section = sectionFromPath(path);
      const key = keyFromPath(path);
      const limit = getFieldLimit(section, key);
      const charCount = value.length;
      const exceeded = charCount > limit;
      fieldBudgets.push({ section, key, charCount, limit, exceeded });
      if (exceeded) {
        issues.push(`Field "${path}" is ${charCount} chars (limit ${limit})`);
      }
    },
    0
  );

  // --- Table density ---
  const tableCandidates = [];
  findTableCandidates(countryAnalysis, '', tableCandidates, 0);

  for (const candidate of tableCandidates) {
    const { path, rows: tableRows } = candidate;
    const section = sectionFromPath(path);
    const key = keyFromPath(path);
    const rowCount = tableRows.length;

    // Determine columns from first valid object
    const sampleObj = tableRows.find((r) => r && typeof r === 'object' && !Array.isArray(r));
    if (!sampleObj) continue;
    const cols = Object.keys(sampleObj).length;

    // Average cell length
    let totalCellLen = 0;
    let cellCount = 0;
    for (const row of tableRows) {
      if (!row || typeof row !== 'object') continue;
      for (const val of Object.values(row)) {
        totalCellLen += String(val || '').length;
        cellCount++;
      }
    }
    const avgCellLen = cellCount > 0 ? Math.round(totalCellLen / cellCount) : 0;
    const densityScore = Math.round(rowCount * cols * (avgCellLen / 40));
    const overBudget =
      densityScore > TABLE_DENSITY_LIMIT ||
      rowCount > TABLE_MAX_ROWS ||
      cols > TABLE_MAX_COLS ||
      avgCellLen > TABLE_MAX_AVG_CELL_LEN;

    tableDensity.push({ section, key, rows: rowCount, cols, avgCellLen, densityScore, overBudget });

    if (overBudget) {
      const reasons = [];
      if (rowCount > TABLE_MAX_ROWS) reasons.push(`${rowCount} rows > ${TABLE_MAX_ROWS}`);
      if (cols > TABLE_MAX_COLS) reasons.push(`${cols} cols > ${TABLE_MAX_COLS}`);
      if (avgCellLen > TABLE_MAX_AVG_CELL_LEN)
        reasons.push(`avg cell ${avgCellLen} chars > ${TABLE_MAX_AVG_CELL_LEN}`);
      if (densityScore > TABLE_DENSITY_LIMIT)
        reasons.push(`density ${densityScore} > ${TABLE_DENSITY_LIMIT}`);
      issues.push(`Table at "${path}": ${reasons.join(', ')}`);
    }
  }

  // --- Chart sanity ---
  const chartCandidates = [];
  findChartData(countryAnalysis, '', chartCandidates, 0);

  for (const candidate of chartCandidates) {
    const { path, chartData } = candidate;
    const section = sectionFromPath(path);
    const key = keyFromPath(path);
    const seriesValues = flattenSeries(chartData.series);
    const plainValues = Array.isArray(chartData.values) ? chartData.values : [];
    const allValues = seriesValues.length > 0 ? seriesValues : plainValues;
    const numericValues = allValues.filter((v) => typeof v === 'number' && !isNaN(v));
    const issueList = [];

    if (numericValues.length < CHART_MIN_DATA_POINTS) {
      issueList.push(
        `Only ${numericValues.length} numeric data points (need >= ${CHART_MIN_DATA_POINTS})`
      );
    }
    if (numericValues.length > 0 && numericValues.every((v) => v === 0)) {
      issueList.push('All-zero series — chart will be empty');
    }
    if (chartData.stacked || chartData.type === 'stackedBar') {
      const negCount = numericValues.filter((v) => v < 0).length;
      if (negCount > 0) {
        issueList.push(`${negCount} negative values in stacked chart data`);
      }
    }

    const issue = issueList.length > 0 ? issueList.join('; ') : null;
    chartSanity.push({
      section,
      key,
      dataPoints: numericValues.length,
      minRequired: CHART_MIN_DATA_POINTS,
      issue,
    });

    if (issue) {
      issues.push(`Chart at "${path}": ${issue}`);
    }
  }

  // --- Risk classification ---
  const anyFieldDoubled = fieldBudgets.some((f) => f.exceeded && f.charCount > f.limit * 2);
  let risk = 'low';
  if (issues.length >= 4 || anyFieldDoubled) {
    risk = 'high';
  } else if (issues.length >= 1) {
    risk = 'medium';
  }

  return { risk, fieldBudgets, tableDensity, chartSanity, issues };
}

// ============ COMPACT PAYLOAD ============

/**
 * Takes a country analysis and its budget report, returns a deep-cloned
 * compacted copy with a log of what was changed. Never mutates the input.
 * @param {object} countryAnalysis
 * @param {{ fieldBudgets: Array, tableDensity: Array, chartSanity: Array }} budgetReport
 * @returns {{ payload: object, compactionLog: Array }}
 */
function compactPayload(countryAnalysis, budgetReport) {
  const payload = deepClone(countryAnalysis);
  const compactionLog = [];

  // --- Trim fields over char budget ---
  for (const fb of budgetReport.fieldBudgets) {
    if (!fb.exceeded) continue;
    const fullPath = fb.key ? `${fb.section}.${fb.key}` : fb.section;
    const parts = fullPath.split('.');
    let target = payload;
    for (let i = 0; i < parts.length - 1; i++) {
      if (target == null || typeof target !== 'object') {
        target = null;
        break;
      }
      target = target[parts[i]];
    }
    if (target == null || typeof target !== 'object') continue;
    const lastKey = parts[parts.length - 1];
    const original = target[lastKey];
    if (typeof original !== 'string') continue;

    const trimmed = trimToSentenceBoundary(original, fb.limit);
    target[lastKey] = trimmed;
    compactionLog.push({
      section: fb.section,
      key: fb.key,
      action: 'trimmed',
      before: original.length,
      after: trimmed.length,
    });
  }

  // --- Truncate table rows over density ---
  for (const td of budgetReport.tableDensity) {
    if (!td.overBudget) continue;
    const fullPath = td.key ? `${td.section}.${td.key}` : td.section;
    const parts = fullPath.split('.');
    let target = payload;
    for (let i = 0; i < parts.length - 1; i++) {
      if (target == null || typeof target !== 'object') {
        target = null;
        break;
      }
      target = target[parts[i]];
    }
    if (target == null || typeof target !== 'object') continue;
    const lastKey = parts[parts.length - 1];
    const arr = target[lastKey];
    if (!Array.isArray(arr)) continue;

    const maxRows = Math.min(arr.length, TABLE_MAX_ROWS);
    if (arr.length > maxRows) {
      const removed = arr.length - maxRows;
      target[lastKey] = arr.slice(0, maxRows);
      compactionLog.push({
        section: td.section,
        key: td.key,
        action: 'truncated_rows',
        before: arr.length,
        after: maxRows,
      });
    }
  }

  // Charts with issues are NOT compacted — they need re-research, not truncation.

  return { payload, compactionLog };
}

// ============ RUN BUDGET GATE ============

/**
 * Main entry point. Runs budget analysis and optionally compacts the payload.
 * @param {object} countryAnalysis
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ report: object, payload: object, compactionLog: Array }}
 */
function runBudgetGate(countryAnalysis, options) {
  const { dryRun = false } = options || {};
  const report = analyzeBudget(countryAnalysis);

  if (!dryRun && (report.risk === 'high' || report.risk === 'medium')) {
    const { payload, compactionLog } = compactPayload(countryAnalysis, report);
    return { report, payload, compactionLog };
  }

  return { report, payload: countryAnalysis, compactionLog: [] };
}

module.exports = {
  FIELD_CHAR_BUDGETS,
  analyzeBudget,
  compactPayload,
  runBudgetGate,
};
