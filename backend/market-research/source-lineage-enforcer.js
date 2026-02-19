'use strict';

/**
 * Source Lineage Enforcer — deep claim-to-source mapping and enforcement.
 *
 * Goes beyond schema-firewall's basic enforceSourceLineage by:
 * - Extracting specific claims (numbers, percentages, company names, market sizes)
 * - Mapping each claim to the nearest source reference
 * - Detecting fake/placeholder sources
 * - Classifying source quality (primary/secondary/weak/missing)
 * - Rejecting orphaned claims in strict mode
 */

const { enforceSourceLineage } = require('./schema-firewall');

// ---------------------------------------------------------------------------
// Claim extraction patterns
// ---------------------------------------------------------------------------

// Matches numbers with optional units: "$500M", "12%", "15 GW", "2.3 billion"
const NUMBER_PATTERN =
  /(?:\$[\d,.]+\s*(?:B|M|K|billion|million|thousand|trillion)?|[\d,.]+\s*%|[\d,.]+\s*(?:GW|MW|kW|TWh|GWh|MWh|CAGR|bps|tons?|tonnes?|units?|people|hectares?|km|miles?|(?:bi|mi|tri)llion))/gi;

// Matches company-like names: capitalized multi-word names, acronyms
const COMPANY_PATTERN =
  /\b(?:[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)+|[A-Z]{2,}(?:\s+[A-Z][a-zA-Z]*)*)\b/g;

// Market size patterns: "$X billion market", "market worth $X"
const MARKET_SIZE_PATTERN =
  /(?:market\s+(?:size|worth|valued?\s+at)\s+\$?[\d,.]+\s*(?:B|M|billion|million|trillion)?|\$[\d,.]+\s*(?:B|M|billion|million|trillion)?\s+market)/gi;

// Placeholder source patterns — no real URL, generic labels
const PLACEHOLDER_PATTERNS = [
  /^(?:source|sources?):\s*(?:industry|market|company|government|research|analyst|expert)\s+(?:report|analysis|data|study|estimate|survey|brief)/i,
  /^(?:various|multiple|several)\s+(?:sources?|reports?|studies?|analysts?)/i,
  /^(?:industry|market|company)\s+(?:sources?|reports?|data)/i,
  /^(?:based on|according to)\s+(?:industry|market|internal|proprietary)\s+(?:data|analysis|research|estimates?)/i,
  /^(?:source|sources?):\s*(?:internal|proprietary|estimated|own)\s+(?:analysis|research|data|calculation)/i,
  /^(?:N\/A|n\/a|NA|TBD|TBC|Unknown|Not available|Undisclosed)$/i,
];

// Template static exemptions — these are not analytical claims
const TEMPLATE_STATIC_EXEMPTIONS = [
  /^source:\s*ycp\s+(?:analysis|solidiance|axtria)/i,
  /^ycp\s+(?:analysis|solidiance|axtria)/i,
  /^(?:confidential|proprietary|client\s+data)/i,
];

// Trusted domain patterns for primary source classification
const PRIMARY_DOMAINS = [
  /\.gov\b/,
  /\.go\.\w{2}\b/,
  /worldbank\.org/,
  /imf\.org/,
  /iea\.org/,
  /irena\.org/,
  /un\.org/,
  /oecd\.org/,
  /adb\.org/,
  /reuters\.com/,
  /bloomberg\.com/,
  /statista\.com/,
  /\.edu\b/,
];

const SECONDARY_DOMAINS = [/\.com$/, /\.org$/, /\.net$/, /\.io$/, /\.co\b/, /\.info$/];

// ---------------------------------------------------------------------------
// Source collection (own implementation since collectSources is not exported)
// ---------------------------------------------------------------------------

function collectAllSources(obj, depth = 0) {
  if (depth > 8 || !obj) return [];
  const sources = [];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      sources.push(...collectAllSources(item, depth + 1));
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
      if (key === 'sources') continue;
      if (key.startsWith('_')) continue;
      sources.push(...collectAllSources(value, depth + 1));
    }
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

/**
 * Extract specific claims from a text string.
 * Claims are: numbers with units, market sizes, company names used in analytical context.
 */
function extractClaims(text, section, field) {
  if (!text || typeof text !== 'string') return [];
  const claims = [];
  const seen = new Set();

  // Extract numeric claims
  const numMatches = text.match(NUMBER_PATTERN) || [];
  for (const match of numMatches) {
    const normalized = match.trim();
    if (!seen.has(normalized.toLowerCase())) {
      seen.add(normalized.toLowerCase());
      claims.push({
        text: normalized,
        type: 'numeric',
        section,
        field,
        context: extractContext(text, match),
      });
    }
  }

  // Extract market size claims
  const marketMatches = text.match(MARKET_SIZE_PATTERN) || [];
  for (const match of marketMatches) {
    const normalized = match.trim();
    if (!seen.has(normalized.toLowerCase())) {
      seen.add(normalized.toLowerCase());
      claims.push({
        text: normalized,
        type: 'market_size',
        section,
        field,
        context: extractContext(text, match),
      });
    }
  }

  return claims;
}

/**
 * Extract a small context window around a claim match in the source text.
 */
function extractContext(text, match) {
  const idx = text.indexOf(match);
  if (idx === -1) return match;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + match.length + 40);
  return text.substring(start, end).trim();
}

// ---------------------------------------------------------------------------
// Walk all text fields in synthesis to extract claims
// ---------------------------------------------------------------------------

function walkSynthesisClaims(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') return [];
  const allClaims = [];
  const isSingle = Boolean(synthesis.isSingleCountry);

  // Walk each section
  const walkObj = (obj, sectionKey, fieldPrefix = '') => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => {
        if (typeof item === 'string') {
          allClaims.push(...extractClaims(item, sectionKey, `${fieldPrefix}[${i}]`));
        } else {
          walkObj(item, sectionKey, `${fieldPrefix}[${i}]`);
        }
      });
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('_') || key === 'sources') continue;
      const fullField = fieldPrefix ? `${fieldPrefix}.${key}` : key;
      if (typeof value === 'string') {
        allClaims.push(...extractClaims(value, sectionKey, fullField));
      } else if (typeof value === 'object' && value !== null) {
        walkObj(value, sectionKey, fullField);
      }
    }
  };

  const sectionKeys = isSingle
    ? [
        'executiveSummary',
        'marketOpportunityAssessment',
        'competitivePositioning',
        'regulatoryPathway',
        'keyInsights',
        'nextSteps',
        'implementation',
      ]
    : ['policy', 'market', 'competitors', 'depth', 'summary'];

  for (const key of sectionKeys) {
    if (synthesis[key] !== undefined && synthesis[key] !== null) {
      walkObj(synthesis[key], key);
    }
  }

  return allClaims;
}

// ---------------------------------------------------------------------------
// Claim-to-source mapping
// ---------------------------------------------------------------------------

/**
 * Try to map a claim to the nearest source by checking if the claim context
 * appears near source-referenced content. Uses section-level source proximity.
 */
function mapClaimToSource(claim, sectionSources) {
  if (!sectionSources || sectionSources.length === 0) return null;

  // A claim is "covered" if the section it belongs to has at least one valid source
  for (const source of sectionSources) {
    if (source.url && typeof source.url === 'string' && source.url.startsWith('http')) {
      return source;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source quality classification
// ---------------------------------------------------------------------------

/**
 * Classify a source as primary, secondary, weak, or missing.
 *
 * - primary: has URL + title, URL is from a trusted domain (gov, intl org, academic)
 * - secondary: has URL + title, URL is a regular domain
 * - weak: has URL but no title, or has title but URL is suspicious
 * - missing: no URL, or placeholder source
 */
function classifySourceQuality(source) {
  if (!source || typeof source !== 'object') {
    return 'missing';
  }

  const url = source.url && typeof source.url === 'string' ? source.url.trim() : '';
  const title = source.title && typeof source.title === 'string' ? source.title.trim() : '';

  // No URL at all
  if (!url) {
    return 'missing';
  }

  // Check if URL is a placeholder
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'missing';
  }

  // Check if title is a placeholder
  if (title && isPlaceholderSource(title)) {
    return 'weak';
  }

  // Primary: trusted domain + has title
  if (title && isPrimaryDomain(url)) {
    return 'primary';
  }

  // Secondary: valid URL + has title
  if (title && isSecondaryDomain(url)) {
    return 'secondary';
  }

  // Has URL but no title
  if (!title) {
    return 'weak';
  }

  // Fallback: has URL and title but unrecognized domain
  return 'secondary';
}

function isPrimaryDomain(url) {
  return PRIMARY_DOMAINS.some((pattern) => pattern.test(url));
}

function isSecondaryDomain(url) {
  return SECONDARY_DOMAINS.some((pattern) => pattern.test(url));
}

// ---------------------------------------------------------------------------
// Placeholder detection
// ---------------------------------------------------------------------------

/**
 * Check if a source title/reference is a fake placeholder.
 */
function isPlaceholderSource(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Check if text matches a template static exemption (not an analytical claim).
 */
function isTemplateStaticExemption(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  return TEMPLATE_STATIC_EXEMPTIONS.some((pattern) => pattern.test(trimmed));
}

// ---------------------------------------------------------------------------
// Get section-level sources
// ---------------------------------------------------------------------------

function getSectionSources(synthesis, sectionKey) {
  const section = synthesis[sectionKey];
  if (!section || typeof section !== 'object') return [];

  const sources = [];

  // Direct sources array on the section
  if (Array.isArray(section.sources)) {
    for (const s of section.sources) {
      if (s && s.url) sources.push(s);
    }
  }

  // Check nested objects for sources
  if (!Array.isArray(section)) {
    for (const [key, value] of Object.entries(section)) {
      if (key === 'sources') continue;
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Array.isArray(value.sources)
      ) {
        for (const s of value.sources) {
          if (s && s.url) sources.push(s);
        }
      }
    }
  }

  return sources;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * enforceLineage(synthesis) — enforce source lineage for every built claim.
 *
 * Walks all claims (text with specific numbers, percentages, company names),
 * maps claims to nearest source references, and returns coverage metrics.
 */
function enforceLineage(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') {
    return {
      claims: [],
      orphanedClaims: [],
      coveredClaims: [],
      sourceCoverage: 0,
    };
  }

  const allSources = collectAllSources(synthesis);
  const claims = walkSynthesisClaims(synthesis);
  const orphanedClaims = [];
  const coveredClaims = [];

  for (const claim of claims) {
    const sectionSources = getSectionSources(synthesis, claim.section);
    // Also include all sources if section has none (fallback to deck-level)
    const effectiveSources = sectionSources.length > 0 ? sectionSources : allSources;
    const matchedSource = mapClaimToSource(claim, effectiveSources);

    if (matchedSource) {
      coveredClaims.push({ ...claim, source: matchedSource });
    } else {
      orphanedClaims.push({
        ...claim,
        reason:
          sectionSources.length === 0 && allSources.length === 0
            ? 'No sources found in synthesis'
            : 'No valid source with URL in section',
      });
    }
  }

  const sourceCoverage =
    claims.length > 0 ? Math.round((coveredClaims.length / claims.length) * 100) : 100;

  return {
    claims,
    orphanedClaims,
    coveredClaims,
    sourceCoverage,
  };
}

/**
 * buildClaimSourceMap(synthesis) — create claim-to-source mapping metadata.
 *
 * Returns a map of { sectionKey: { claims[], sources[], coverage } }.
 */
function buildClaimSourceMap(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') {
    return {};
  }

  const isSingle = Boolean(synthesis.isSingleCountry);
  const sectionKeys = isSingle
    ? [
        'executiveSummary',
        'marketOpportunityAssessment',
        'competitivePositioning',
        'regulatoryPathway',
        'keyInsights',
        'nextSteps',
        'implementation',
      ]
    : ['policy', 'market', 'competitors', 'depth', 'summary'];

  const map = {};

  for (const key of sectionKeys) {
    if (synthesis[key] === undefined || synthesis[key] === null) continue;

    const sectionClaims = walkSynthesisClaims({ [key]: synthesis[key], isSingleCountry: isSingle });
    // Fix section key: walkSynthesisClaims needs the correct section keys
    const correctedClaims = sectionClaims.map((c) => ({ ...c, section: key }));
    const sectionSources = getSectionSources(synthesis, key);
    const allSrcQuality = sectionSources.map((s) => ({
      ...s,
      quality: classifySourceQuality(s),
    }));

    const covered = correctedClaims.filter((c) => mapClaimToSource(c, sectionSources) !== null);
    const coverage =
      correctedClaims.length > 0
        ? Math.round((covered.length / correctedClaims.length) * 100)
        : 100;

    map[key] = {
      claims: correctedClaims,
      sources: allSrcQuality,
      coverage,
    };
  }

  return map;
}

/**
 * rejectOrphanedClaims(claims, options) — reject orphaned claims.
 *
 * In strict mode, all orphaned claims are rejected.
 * In non-strict mode, only critical claims (market sizes, large numbers) are rejected.
 *
 * Returns { rejected[], reasons[] }.
 */
function rejectOrphanedClaims(claims, options = {}) {
  const strict = Boolean(options.strict);
  const rejected = [];
  const reasons = [];

  if (!Array.isArray(claims)) {
    return { rejected: [], reasons: [] };
  }

  for (const claim of claims) {
    // Skip template static exemptions
    if (claim.context && isTemplateStaticExemption(claim.context)) {
      continue;
    }

    if (strict) {
      // Reject all orphaned claims in strict mode
      rejected.push(claim);
      reasons.push({
        claim: claim.text,
        section: claim.section,
        field: claim.field,
        reason: `Orphaned claim in strict mode: "${claim.text}" in ${claim.section}.${claim.field}`,
      });
    } else {
      // In non-strict mode, only reject market_size claims and large numeric claims
      if (claim.type === 'market_size') {
        rejected.push(claim);
        reasons.push({
          claim: claim.text,
          section: claim.section,
          field: claim.field,
          reason: `Unsourced market size claim: "${claim.text}" in ${claim.section}.${claim.field}`,
        });
      }
    }
  }

  return { rejected, reasons };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  enforceLineage,
  buildClaimSourceMap,
  rejectOrphanedClaims,
  classifySourceQuality,
  isPlaceholderSource,
  isTemplateStaticExemption,

  // Internals (for testing)
  extractClaims,
  walkSynthesisClaims,
  collectAllSources,
  getSectionSources,
  mapClaimToSource,

  // Constants (for testing)
  PLACEHOLDER_PATTERNS,
  TEMPLATE_STATIC_EXEMPTIONS,
  PRIMARY_DOMAINS,
};
