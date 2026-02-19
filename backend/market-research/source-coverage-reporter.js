'use strict';

/**
 * Source Coverage Reporter — per-slide coverage scoring and orphan reporting.
 *
 * Generates coverage reports, orphan artifacts, and detects source mismatches
 * between content output and built text.
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
 * checkSourceMismatch(contentOutput, builtText) — detect when built text
 * contains claims that are not present in the content output, or vice versa.
 *
 * This catches cases where the PPT builder introduces numbers/claims not in
 * the synthesis, or drops sourced claims during building.
 *
 * Returns:
 * {
 *   mismatches: [{ type, text, location }],
 *   addedInRender: string[],
 *   droppedFromRender: string[],
 *   match: boolean
 * }
 */
function checkSourceMismatch(contentOutput, builtText) {
  if (!contentOutput || typeof contentOutput !== 'string') {
    return {
      mismatches: [],
      addedInRender: [],
      droppedFromRender: [],
      match: true,
    };
  }
  if (!builtText || typeof builtText !== 'string') {
    return {
      mismatches: [],
      addedInRender: [],
      droppedFromRender: [],
      match: true,
    };
  }

  const NUMBER_RE =
    /(?:\$[\d,.]+\s*(?:B|M|K|billion|million|thousand|trillion)?|[\d,.]+\s*%|[\d,.]+\s*(?:GW|MW|kW|TWh|GWh|MWh))/gi;

  const contentNumbers = new Set(
    (contentOutput.match(NUMBER_RE) || []).map((n) => n.trim().toLowerCase())
  );
  const builtNumbers = new Set(
    (builtText.match(NUMBER_RE) || []).map((n) => n.trim().toLowerCase())
  );

  const addedInRender = [];
  const droppedFromRender = [];
  const mismatches = [];

  // Numbers in built that are NOT in content
  for (const num of builtNumbers) {
    if (!contentNumbers.has(num)) {
      addedInRender.push(num);
      mismatches.push({
        type: 'added_in_render',
        text: num,
        location: 'built',
      });
    }
  }

  // Numbers in content that are NOT in built
  for (const num of contentNumbers) {
    if (!builtNumbers.has(num)) {
      droppedFromRender.push(num);
      mismatches.push({
        type: 'dropped_from_render',
        text: num,
        location: 'content',
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
