'use strict';

/**
 * Source Coverage Reporter — per-slide coverage scoring and orphan reporting.
 *
 * Generates coverage reports, orphan artifacts, and detects source mismatches
 * between semantic output and rendered text.
 */

const {
  enforceLineage,
  buildClaimSourceMap,
  classifySourceQuality,
  walkSynthesisClaims,
  collectAllSources,
  getSectionSources,
  isPlaceholderSource,
} = require('./source-lineage-enforcer');

// Default threshold: 60% of claims must have source coverage
const DEFAULT_THRESHOLD = 60;

// ---------------------------------------------------------------------------
// Coverage Report
// ---------------------------------------------------------------------------

/**
 * generateCoverageReport(synthesis) — per-section source coverage score + deck-level gate.
 *
 * Returns:
 * {
 *   perSection: { sectionKey: { claims: number, covered: number, score: number } },
 *   overall: number,
 *   pass: boolean,
 *   threshold: number
 * }
 */
function generateCoverageReport(synthesis, options = {}) {
  const threshold = options.threshold !== undefined ? options.threshold : DEFAULT_THRESHOLD;

  if (!synthesis || typeof synthesis !== 'object') {
    return {
      perSection: {},
      overall: 0,
      pass: false,
      threshold,
    };
  }

  const claimSourceMap = buildClaimSourceMap(synthesis);
  const perSection = {};
  let totalClaims = 0;
  let totalCovered = 0;

  for (const [sectionKey, data] of Object.entries(claimSourceMap)) {
    const claimCount = data.claims.length;
    const coveredCount = Math.round((data.coverage / 100) * claimCount);
    const sourceQualities = data.sources.map((s) => s.quality);

    // Penalize sections with only weak/missing sources
    const hasStrongSource = sourceQualities.some((q) => q === 'primary' || q === 'secondary');
    const adjustedScore = hasStrongSource ? data.coverage : Math.min(data.coverage, 30);

    perSection[sectionKey] = {
      claims: claimCount,
      covered: coveredCount,
      score: adjustedScore,
      sourceCount: data.sources.length,
      sourceQualities,
    };

    totalClaims += claimCount;
    totalCovered += coveredCount;
  }

  const overall = totalClaims > 0 ? Math.round((totalCovered / totalClaims) * 100) : 100;
  const pass = overall >= threshold;

  return {
    perSection,
    overall,
    pass,
    threshold,
  };
}

// ---------------------------------------------------------------------------
// Orphan Report
// ---------------------------------------------------------------------------

/**
 * generateOrphanReport(synthesis) — report artifact listing all claims without valid lineage.
 *
 * Returns:
 * {
 *   orphans: [{ claim, section, field, reason }],
 *   count: number,
 *   severity: 'none' | 'low' | 'medium' | 'high' | 'critical'
 * }
 */
function generateOrphanReport(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') {
    return {
      orphans: [],
      count: 0,
      severity: 'none',
    };
  }

  const lineageResult = enforceLineage(synthesis);
  const allSources = collectAllSources(synthesis);

  const orphans = lineageResult.orphanedClaims.map((claim) => {
    // Determine specific reason for orphaning
    let reason = claim.reason || 'No valid source reference found';

    // Check if section has placeholder-only sources
    const sectionSources = getSectionSources(synthesis, claim.section);
    const allPlaceholder =
      sectionSources.length > 0 &&
      sectionSources.every(
        (s) => !s.url || !s.url.startsWith('http') || isPlaceholderSource(s.title || '')
      );
    if (allPlaceholder && sectionSources.length > 0) {
      reason = 'Section has only placeholder/invalid sources';
    }

    return {
      claim: claim.text,
      section: claim.section,
      field: claim.field,
      reason,
    };
  });

  const count = orphans.length;
  const totalClaims = lineageResult.claims.length;
  const orphanRate = totalClaims > 0 ? count / totalClaims : 0;

  let severity;
  if (count === 0) severity = 'none';
  else if (orphanRate < 0.1) severity = 'low';
  else if (orphanRate < 0.3) severity = 'medium';
  else if (orphanRate < 0.6) severity = 'high';
  else severity = 'critical';

  return {
    orphans,
    count,
    severity,
  };
}

// ---------------------------------------------------------------------------
// Source Mismatch Detection
// ---------------------------------------------------------------------------

/**
 * checkSourceMismatch(semanticOutput, renderedText) — detect when rendered text
 * contains claims that are not present in the semantic output, or vice versa.
 *
 * This catches cases where the PPT renderer introduces numbers/claims not in
 * the synthesis, or drops sourced claims during rendering.
 *
 * Returns:
 * {
 *   mismatches: [{ type, text, location }],
 *   addedInRender: string[],
 *   droppedFromRender: string[],
 *   match: boolean
 * }
 */
function checkSourceMismatch(semanticOutput, renderedText) {
  if (!semanticOutput || typeof semanticOutput !== 'string') {
    return {
      mismatches: [],
      addedInRender: [],
      droppedFromRender: [],
      match: true,
    };
  }
  if (!renderedText || typeof renderedText !== 'string') {
    return {
      mismatches: [],
      addedInRender: [],
      droppedFromRender: [],
      match: true,
    };
  }

  const NUMBER_RE =
    /(?:\$[\d,.]+\s*(?:B|M|K|billion|million|thousand|trillion)?|[\d,.]+\s*%|[\d,.]+\s*(?:GW|MW|kW|TWh|GWh|MWh))/gi;

  const semanticNumbers = new Set(
    (semanticOutput.match(NUMBER_RE) || []).map((n) => n.trim().toLowerCase())
  );
  const renderedNumbers = new Set(
    (renderedText.match(NUMBER_RE) || []).map((n) => n.trim().toLowerCase())
  );

  const addedInRender = [];
  const droppedFromRender = [];
  const mismatches = [];

  // Numbers in rendered that are NOT in semantic
  for (const num of renderedNumbers) {
    if (!semanticNumbers.has(num)) {
      addedInRender.push(num);
      mismatches.push({
        type: 'added_in_render',
        text: num,
        location: 'rendered',
      });
    }
  }

  // Numbers in semantic that are NOT in rendered
  for (const num of semanticNumbers) {
    if (!renderedNumbers.has(num)) {
      droppedFromRender.push(num);
      mismatches.push({
        type: 'dropped_from_render',
        text: num,
        location: 'semantic',
      });
    }
  }

  return {
    mismatches,
    addedInRender,
    droppedFromRender,
    match: mismatches.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateCoverageReport,
  generateOrphanReport,
  checkSourceMismatch,
  DEFAULT_THRESHOLD,
};
