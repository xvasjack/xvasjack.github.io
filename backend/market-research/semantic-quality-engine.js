/**
 * Semantic Quality Engine
 *
 * Deep semantic analysis of market-research synthesis outputs.
 * Focuses on deal economics parsing, contradiction detection,
 * decision-usefulness scoring, and anti-shallow checks.
 */

// ============ CURRENCY / NUMBER NORMALIZATION ============

const CURRENCY_SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };
const MAGNITUDE_SUFFIXES = {
  k: 1e3,
  K: 1e3,
  m: 1e6,
  M: 1e6,
  b: 1e9,
  B: 1e9,
  t: 1e12,
  T: 1e12,
};

/**
 * Normalize a monetary string like "$5M", "€2.3 billion", "500K USD" into
 * { value: <number>, currency: <string> }.
 * Returns null if unparseable.
 */
function normalizeCurrency(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  let currency = 'USD'; // default
  let cleaned = s;

  // Detect currency symbol at start
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (cleaned.startsWith(sym)) {
      currency = code;
      cleaned = cleaned.slice(sym.length).trim();
      break;
    }
  }

  // Detect trailing currency code (e.g., "100M USD")
  const trailingCode = cleaned.match(
    /\s+(USD|EUR|GBP|JPY|INR|CNY|KRW|THB|VND|IDR|MYR|SGD|PHP|AUD|CAD)$/i
  );
  if (trailingCode) {
    currency = trailingCode[1].toUpperCase();
    cleaned = cleaned.slice(0, trailingCode.index).trim();
  }

  // Remove commas
  cleaned = cleaned.replace(/,/g, '');

  // Try suffix form: "5M", "2.3B", "500K"
  const suffixMatch = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*([kKmMbBtT])$/);
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1]);
    const mult = MAGNITUDE_SUFFIXES[suffixMatch[2]];
    return { value: num * mult, currency };
  }

  // Try word form: "5 million", "2.3 billion"
  const wordMatch = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*(thousand|million|billion|trillion)$/i);
  if (wordMatch) {
    const num = parseFloat(wordMatch[1]);
    const wordMult = {
      thousand: 1e3,
      million: 1e6,
      billion: 1e9,
      trillion: 1e12,
    }[wordMatch[2].toLowerCase()];
    return { value: num * wordMult, currency };
  }

  // Plain number
  const plainMatch = cleaned.match(/^-?\d+(?:\.\d+)?$/);
  if (plainMatch) {
    return { value: parseFloat(cleaned), currency };
  }

  return null;
}

/**
 * Normalize a percentage string like "15%", "15.5 %", "15 percent" into a number (0-100 scale).
 * Returns null if unparseable.
 */
function normalizePercentage(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const match = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:%|percent)$/i);
  if (match) return parseFloat(match[1]);
  // Try bare "X-Y%" range — return midpoint
  const rangeMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*%$/);
  if (rangeMatch) {
    return (parseFloat(rangeMatch[1]) + parseFloat(rangeMatch[2])) / 2;
  }
  return null;
}

/**
 * Normalize a time-period string like "5 years", "18 months", "2-3 years" into months.
 * Returns null if unparseable.
 */
function normalizeTimePeriod(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();

  // Range: "2-3 years"
  const rangeYears = s.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*years?$/);
  if (rangeYears) {
    const avg = (parseFloat(rangeYears[1]) + parseFloat(rangeYears[2])) / 2;
    return Math.round(avg * 12);
  }
  const rangeMonths = s.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*months?$/);
  if (rangeMonths) {
    return Math.round((parseFloat(rangeMonths[1]) + parseFloat(rangeMonths[2])) / 2);
  }

  // Single: "5 years", "18 months"
  const singleYears = s.match(/^(\d+(?:\.\d+)?)\s*years?$/);
  if (singleYears) return Math.round(parseFloat(singleYears[1]) * 12);
  const singleMonths = s.match(/^(\d+(?:\.\d+)?)\s*months?$/);
  if (singleMonths) return Math.round(parseFloat(singleMonths[1]));

  // "Month X" pattern (from implementation.breakeven)
  const monthX = s.match(/^month\s+(\d+)$/);
  if (monthX) return parseInt(monthX[1], 10);

  return null;
}

// ============ DEAL ECONOMICS SEMANTIC PARSER ============

/**
 * Parse a dealEconomics object (from synthesizeSummary depth section)
 * into a structured semantic model.
 */
function parseDealEconomics(dealEcon) {
  if (!dealEcon || typeof dealEcon !== 'object') {
    return { valid: false, fields: {}, confidence: 0, issues: ['No deal economics data provided'] };
  }

  const fields = {};
  const issues = [];

  // Deal size
  if (dealEcon.typicalDealSize) {
    const ds = dealEcon.typicalDealSize;
    fields.dealSize = {
      min: normalizeCurrency(ds.min),
      max: normalizeCurrency(ds.max),
      average: normalizeCurrency(ds.average),
    };
    if (!fields.dealSize.min && !fields.dealSize.max && !fields.dealSize.average) {
      issues.push('Deal size values could not be parsed');
    }
  } else {
    issues.push('typicalDealSize missing');
  }

  // Contract terms
  if (dealEcon.contractTerms) {
    const ct = dealEcon.contractTerms;
    fields.contractDuration = normalizeTimePeriod(ct.duration);
    fields.revenueSplit = ct.revenueSplit || null;
    fields.guaranteeStructure = ct.guaranteeStructure || null;
    if (!fields.contractDuration) {
      issues.push('Contract duration could not be parsed');
    }
  } else {
    issues.push('contractTerms missing');
  }

  // Financials
  if (dealEcon.financials) {
    const fin = dealEcon.financials;
    fields.paybackPeriod = normalizeTimePeriod(fin.paybackPeriod);
    fields.irr = normalizePercentage(fin.irr);
    fields.marginProfile = normalizePercentage(fin.marginProfile);
    if (fields.irr == null && fields.paybackPeriod == null) {
      issues.push('Neither IRR nor payback period could be parsed');
    }
  } else {
    issues.push('financials missing');
  }

  // Financing options
  if (Array.isArray(dealEcon.financingOptions)) {
    fields.financingOptions = dealEcon.financingOptions.filter(
      (o) => typeof o === 'string' && o.trim().length > 0
    );
  }

  // Key insight
  if (dealEcon.keyInsight && typeof dealEcon.keyInsight === 'string') {
    fields.keyInsight = dealEcon.keyInsight;
  }

  // Calculate confidence
  const expectedFields = ['dealSize', 'contractDuration', 'paybackPeriod', 'irr'];
  let filledCount = 0;
  if (fields.dealSize && (fields.dealSize.min || fields.dealSize.max || fields.dealSize.average))
    filledCount++;
  if (fields.contractDuration) filledCount++;
  if (fields.paybackPeriod) filledCount++;
  if (fields.irr != null) filledCount++;

  const confidence = Math.round((filledCount / expectedFields.length) * 100);

  return {
    valid: filledCount >= 2,
    fields,
    confidence,
    issues,
  };
}

// ============ ENTRY STRATEGY SEMANTIC PARSER ============

/**
 * Parse an entryStrategy object into a structured semantic model.
 * Similar rigor to parseDealEconomics.
 */
function parseEntryStrategy(entryStrategy) {
  if (!entryStrategy || typeof entryStrategy !== 'object') {
    return { valid: false, fields: {}, confidence: 0, issues: ['No entry strategy data provided'] };
  }

  const fields = {};
  const issues = [];

  // Mode of entry (JV, acquisition, greenfield, partnership, etc.)
  if (entryStrategy.mode || entryStrategy.entryMode || entryStrategy.approach) {
    const mode = entryStrategy.mode || entryStrategy.entryMode || entryStrategy.approach;
    fields.entryMode = typeof mode === 'string' ? mode.trim() : String(mode);
    if (fields.entryMode.length < 3) {
      issues.push('Entry mode description too brief');
    }
  } else {
    issues.push('entryMode missing');
  }

  // Timeline / phases
  if (entryStrategy.timeline || entryStrategy.phases || entryStrategy.implementationTimeline) {
    const timeline =
      entryStrategy.timeline || entryStrategy.phases || entryStrategy.implementationTimeline;
    if (typeof timeline === 'string') {
      fields.timelineMonths = normalizeTimePeriod(timeline);
      fields.timelineRaw = timeline;
    } else if (Array.isArray(timeline)) {
      fields.phases = timeline.filter((p) => p && (typeof p === 'string' || typeof p === 'object'));
      fields.phaseCount = fields.phases.length;
    } else if (typeof timeline === 'object') {
      fields.phases = Object.entries(timeline).map(([k, v]) => ({ phase: k, detail: v }));
      fields.phaseCount = fields.phases.length;
    }
    if (!fields.timelineMonths && (!fields.phases || fields.phases.length === 0)) {
      issues.push('Timeline could not be parsed into phases or duration');
    }
  } else {
    issues.push('timeline/phases missing');
  }

  // Investment required
  if (
    entryStrategy.investmentRequired ||
    entryStrategy.initialInvestment ||
    entryStrategy.capitalRequired
  ) {
    const inv =
      entryStrategy.investmentRequired ||
      entryStrategy.initialInvestment ||
      entryStrategy.capitalRequired;
    fields.investmentRequired = normalizeCurrency(typeof inv === 'string' ? inv : String(inv));
    if (!fields.investmentRequired) {
      issues.push('Investment amount could not be parsed');
    }
  } else {
    issues.push('investmentRequired missing');
  }

  // Risk factors
  if (entryStrategy.risks || entryStrategy.riskFactors || entryStrategy.keyRisks) {
    const risks = entryStrategy.risks || entryStrategy.riskFactors || entryStrategy.keyRisks;
    if (Array.isArray(risks)) {
      fields.risks = risks.filter((r) => typeof r === 'string' && r.trim().length > 0);
    } else if (typeof risks === 'string') {
      fields.risks = [risks];
    }
  }

  // Success criteria / milestones
  if (entryStrategy.successCriteria || entryStrategy.milestones || entryStrategy.kpis) {
    const criteria =
      entryStrategy.successCriteria || entryStrategy.milestones || entryStrategy.kpis;
    if (Array.isArray(criteria)) {
      fields.successCriteria = criteria.filter((c) => typeof c === 'string' && c.trim().length > 0);
    } else if (typeof criteria === 'string') {
      fields.successCriteria = [criteria];
    }
  }

  // Calculate confidence
  const expectedFields = ['entryMode', 'timelineMonths', 'investmentRequired', 'risks'];
  let filledCount = 0;
  if (fields.entryMode) filledCount++;
  if (fields.timelineMonths || (fields.phases && fields.phases.length > 0)) filledCount++;
  if (fields.investmentRequired) filledCount++;
  if (fields.risks && fields.risks.length > 0) filledCount++;

  const confidence = Math.round((filledCount / expectedFields.length) * 100);

  return {
    valid: filledCount >= 2,
    fields,
    confidence,
    issues,
  };
}

// ============ PARTNER ASSESSMENT SEMANTIC PARSER ============

/**
 * Parse a partnerAssessment object into a structured semantic model.
 * Similar rigor to parseDealEconomics.
 */
function parsePartnerAssessment(partnerAssessment) {
  if (!partnerAssessment || typeof partnerAssessment !== 'object') {
    return {
      valid: false,
      fields: {},
      confidence: 0,
      issues: ['No partner assessment data provided'],
    };
  }

  const fields = {};
  const issues = [];

  // Partner candidates list
  if (
    partnerAssessment.candidates ||
    partnerAssessment.potentialPartners ||
    partnerAssessment.partners
  ) {
    const partners =
      partnerAssessment.candidates ||
      partnerAssessment.potentialPartners ||
      partnerAssessment.partners;
    if (Array.isArray(partners)) {
      fields.partners = partners
        .map((p) => {
          if (typeof p === 'string') return { name: p };
          if (typeof p === 'object' && p !== null) {
            return {
              name: p.name || p.company || p.partnerName || 'Unknown',
              strengths: p.strengths || p.advantages || null,
              weaknesses: p.weaknesses || p.disadvantages || p.risks || null,
              fitScore: p.fitScore || p.score || null,
              rationale: p.rationale || p.reason || p.description || null,
            };
          }
          return null;
        })
        .filter(Boolean);
    } else if (typeof partners === 'object') {
      fields.partners = Object.entries(partners).map(([name, detail]) => ({
        name,
        rationale: typeof detail === 'string' ? detail : JSON.stringify(detail),
      }));
    }
    if (!fields.partners || fields.partners.length === 0) {
      issues.push('No valid partner candidates found');
    }
  } else {
    issues.push('partner candidates missing');
  }

  // Selection criteria
  if (
    partnerAssessment.selectionCriteria ||
    partnerAssessment.criteria ||
    partnerAssessment.evaluationCriteria
  ) {
    const criteria =
      partnerAssessment.selectionCriteria ||
      partnerAssessment.criteria ||
      partnerAssessment.evaluationCriteria;
    if (Array.isArray(criteria)) {
      fields.selectionCriteria = criteria.filter(
        (c) => typeof c === 'string' && c.trim().length > 0
      );
    } else if (typeof criteria === 'string') {
      fields.selectionCriteria = [criteria];
    }
  } else {
    issues.push('selectionCriteria missing');
  }

  // Partnership model / structure
  if (partnerAssessment.model || partnerAssessment.structure || partnerAssessment.partnershipType) {
    const model =
      partnerAssessment.model || partnerAssessment.structure || partnerAssessment.partnershipType;
    fields.partnershipModel = typeof model === 'string' ? model.trim() : String(model);
  } else {
    issues.push('partnership model/structure missing');
  }

  // Due diligence / assessment notes
  if (partnerAssessment.dueDiligence || partnerAssessment.assessment || partnerAssessment.notes) {
    const dd =
      partnerAssessment.dueDiligence || partnerAssessment.assessment || partnerAssessment.notes;
    fields.dueDiligence = typeof dd === 'string' ? dd : JSON.stringify(dd);
  }

  // Key insight
  if (partnerAssessment.keyInsight && typeof partnerAssessment.keyInsight === 'string') {
    fields.keyInsight = partnerAssessment.keyInsight;
  }

  // Calculate confidence
  const expectedFields = ['partners', 'selectionCriteria', 'partnershipModel', 'dueDiligence'];
  let filledCount = 0;
  if (fields.partners && fields.partners.length > 0) filledCount++;
  if (fields.selectionCriteria && fields.selectionCriteria.length > 0) filledCount++;
  if (fields.partnershipModel) filledCount++;
  if (fields.dueDiligence) filledCount++;

  const confidence = Math.round((filledCount / expectedFields.length) * 100);

  return {
    valid: filledCount >= 2,
    fields,
    confidence,
    issues,
  };
}

// ============ INSIGHT STRUCTURE VALIDATION ============

/**
 * Validate that an insight has the required structure:
 * finding + implication + action + risk/caveat.
 * Returns { valid, missing[], score }
 */
function validateInsightStructure(insight) {
  if (!insight || typeof insight !== 'object') {
    return { valid: false, missing: ['finding', 'implication', 'action', 'risk'], score: 0 };
  }

  const missing = [];
  let score = 0;

  // Finding: the factual observation
  const findingFields = ['finding', 'data', 'observation', 'title', 'fact'];
  const hasFinding = findingFields.some((f) => {
    const val = insight[f];
    return val && typeof val === 'string' && val.trim().length >= 10;
  });
  if (hasFinding) {
    score += 25;
  } else {
    missing.push('finding');
  }

  // Implication: what the finding means
  const implicationFields = ['implication', 'impact', 'meaning', 'significance', 'pattern'];
  const hasImplication = implicationFields.some((f) => {
    const val = insight[f];
    return val && typeof val === 'string' && val.trim().length >= 10;
  });
  if (hasImplication) {
    score += 25;
  } else {
    // Check if the finding text itself contains implication language
    const findingText = findingFields
      .map((f) => insight[f])
      .filter(Boolean)
      .join(' ');
    const hasImplicitImplication =
      /\b(this means|which implies|suggesting|indicating|therefore|consequently)\b/i.test(
        findingText
      );
    if (hasImplicitImplication) {
      score += 15; // partial credit
    } else {
      missing.push('implication');
    }
  }

  // Action: recommended next step
  const actionFields = ['action', 'recommendation', 'nextStep', 'timing', 'strategy'];
  const hasAction = actionFields.some((f) => {
    const val = insight[f];
    return val && typeof val === 'string' && val.trim().length >= 5;
  });
  if (hasAction) {
    score += 25;
  } else {
    // Check if any text contains action language
    const allText = Object.values(insight)
      .filter((v) => typeof v === 'string')
      .join(' ');
    const hasImplicitAction =
      /\b(should|recommend|target|pursue|consider|focus|prioritize|by Q[1-4]|by 20\d{2})\b/i.test(
        allText
      );
    if (hasImplicitAction) {
      score += 15; // partial credit
    } else {
      missing.push('action');
    }
  }

  // Risk / caveat: what could go wrong
  const riskFields = ['risk', 'caveat', 'warning', 'limitation', 'downside', 'risks'];
  const hasRisk = riskFields.some((f) => {
    const val = insight[f];
    return (
      val &&
      ((typeof val === 'string' && val.trim().length >= 5) ||
        (Array.isArray(val) && val.length > 0))
    );
  });
  if (hasRisk) {
    score += 25;
  } else {
    // Check for implicit risk language
    const allText = Object.values(insight)
      .filter((v) => typeof v === 'string')
      .join(' ');
    const hasImplicitRisk =
      /\b(however|but|risk|caveat|unless|except|downside|challenge|barrier|threat)\b/i.test(
        allText
      );
    if (hasImplicitRisk) {
      score += 15; // partial credit
    } else {
      missing.push('risk');
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    score,
  };
}

// ============ PLAUSIBILITY CONSTRAINTS ============

const PLAUSIBILITY_RANGES = {
  irr: { min: -10, max: 80, typical: { min: 8, max: 25 }, unit: '%' },
  paybackPeriod: { min: 3, max: 240, typical: { min: 12, max: 180 }, unit: 'months' },
  contractDuration: { min: 6, max: 360, typical: { min: 36, max: 180 }, unit: 'months' },
  dealSizeMin: { min: 1000, max: 1e12, unit: 'currency' },
  dealSizeMax: { min: 1000, max: 1e12, unit: 'currency' },
  marginProfile: { min: -50, max: 95, typical: { min: 10, max: 60 }, unit: '%' },
};

/**
 * Check plausibility of parsed deal economics values.
 * Returns array of { field, value, issue, severity } objects.
 */
function checkPlausibility(parsedDealEcon) {
  const warnings = [];
  if (!parsedDealEcon || !parsedDealEcon.fields) return warnings;

  const f = parsedDealEcon.fields;

  // IRR
  if (f.irr != null) {
    const range = PLAUSIBILITY_RANGES.irr;
    if (f.irr > range.max) {
      warnings.push({
        field: 'irr',
        value: f.irr,
        issue: `IRR of ${f.irr}% exceeds maximum plausible value of ${range.max}%`,
        severity: 'error',
      });
    } else if (f.irr < range.min) {
      warnings.push({
        field: 'irr',
        value: f.irr,
        issue: `IRR of ${f.irr}% is below minimum plausible value of ${range.min}%`,
        severity: 'error',
      });
    } else if (f.irr > range.typical.max) {
      warnings.push({
        field: 'irr',
        value: f.irr,
        issue: `IRR of ${f.irr}% is above typical range (${range.typical.min}-${range.typical.max}%)`,
        severity: 'warning',
      });
    }
  }

  // Payback period
  if (f.paybackPeriod != null) {
    const range = PLAUSIBILITY_RANGES.paybackPeriod;
    if (f.paybackPeriod < range.min) {
      warnings.push({
        field: 'paybackPeriod',
        value: f.paybackPeriod,
        issue: `Payback period of ${f.paybackPeriod} months is implausibly short (min ${range.min})`,
        severity: 'error',
      });
    } else if (f.paybackPeriod > range.max) {
      warnings.push({
        field: 'paybackPeriod',
        value: f.paybackPeriod,
        issue: `Payback period of ${f.paybackPeriod} months is implausibly long (max ${range.max})`,
        severity: 'error',
      });
    }
  }

  // Contract duration
  if (f.contractDuration != null) {
    const range = PLAUSIBILITY_RANGES.contractDuration;
    if (f.contractDuration < range.min) {
      warnings.push({
        field: 'contractDuration',
        value: f.contractDuration,
        issue: `Contract duration of ${f.contractDuration} months is implausibly short`,
        severity: 'warning',
      });
    } else if (f.contractDuration > range.max) {
      warnings.push({
        field: 'contractDuration',
        value: f.contractDuration,
        issue: `Contract duration of ${f.contractDuration} months is implausibly long`,
        severity: 'warning',
      });
    }
  }

  // Deal size: min should be <= max
  if (f.dealSize) {
    const { min: dsMin, max: dsMax } = f.dealSize;
    if (dsMin && dsMax && dsMin.value > dsMax.value) {
      warnings.push({
        field: 'dealSize',
        value: { min: dsMin.value, max: dsMax.value },
        issue: `Deal size min ($${dsMin.value}) exceeds max ($${dsMax.value})`,
        severity: 'error',
      });
    }
  }

  // Margin profile
  if (f.marginProfile != null) {
    const range = PLAUSIBILITY_RANGES.marginProfile;
    if (f.marginProfile > range.max) {
      warnings.push({
        field: 'marginProfile',
        value: f.marginProfile,
        issue: `Margin of ${f.marginProfile}% exceeds ${range.max}%`,
        severity: 'error',
      });
    }
  }

  return warnings;
}

// ============ CONTRADICTION DETECTION ============

/**
 * Extract directional claims from text for contradiction checking.
 * Returns array of { subject, direction, magnitude?, raw }
 */
function extractClaims(text) {
  if (!text || typeof text !== 'string') return [];
  const claims = [];

  // Split into sentences for better subject extraction
  const sentences = text.split(/[.!?;]+/).filter((s) => s.trim().length > 10);

  const upVerbs = /\b(growing|grew|increased|rising|expanding|booming|surging|accelerating)\b/i;
  const downVerbs =
    /\b(declining|decreased|falling|shrinking|contracting|weakening|stagnant|depressed)\b/i;
  const strongDemand = /\b(strong|robust|booming|high)\s+(demand|growth)\b/i;
  const weakDemand = /\b(weak|low|declining|stagnant)\s+(demand|growth)\b/i;

  for (const sentence of sentences) {
    const trimmed = sentence.trim();

    // Extract a subject: look for noun phrases before the verb
    // Normalize the subject to just key noun words
    const subjectFromSentence = extractSubjectPhrase(trimmed);

    if (upVerbs.test(trimmed) || strongDemand.test(trimmed)) {
      const magMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*%/);
      claims.push({
        subject: subjectFromSentence,
        direction: 'up',
        magnitude: magMatch ? magMatch[1] + '%' : null,
        raw: trimmed.slice(0, 80),
      });
    }

    if (downVerbs.test(trimmed) || weakDemand.test(trimmed)) {
      const magMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*%/);
      claims.push({
        subject: subjectFromSentence,
        direction: 'down',
        magnitude: magMatch ? magMatch[1] + '%' : null,
        raw: trimmed.slice(0, 80),
      });
    }
  }

  return claims;
}

/**
 * Extract the key noun phrase from a sentence to use as subject for contradiction matching.
 * Strips articles, prepositions, and normalizes to lowercase key words.
 */
function extractSubjectPhrase(sentence) {
  // Remove JSON artifacts
  const s = sentence.replace(/["{},:[\]]/g, ' ').trim();
  // Take the first clause (before "is", "are", "has", etc.)
  const verbSplit = s.split(/\b(?:is|are|was|were|has|have)\b/i);
  let subject = (verbSplit[0] || s).trim();
  // Remove articles, prepositions
  subject = subject.replace(/\b(the|a|an|of|in|at|by|for|to|from|with|on|and)\b/gi, '');
  // Collapse whitespace and lowercase
  subject = subject.replace(/\s+/g, ' ').trim().toLowerCase();
  // Limit length
  if (subject.length > 40) subject = subject.slice(0, 40).trim();
  return subject;
}

/**
 * Recursively extract all string values from an object, joining them with periods.
 * This avoids JSON key names polluting subject extraction.
 */
function extractTextValues(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(extractTextValues).filter(Boolean).join('. ');
  if (typeof obj === 'object')
    return Object.values(obj).map(extractTextValues).filter(Boolean).join('. ');
  return String(obj);
}

/**
 * Check for contradictions within a synthesis object.
 * Looks for opposing directional claims about the same subject,
 * including cross-section contradictions (economics vs strategy vs timeline).
 */
function checkContradictions(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') return [];

  const contradictions = [];

  // Extract claims per section for cross-section attribution
  const sectionTexts = {};
  const sections = [
    'executiveSummary',
    'marketOpportunityAssessment',
    'competitivePositioning',
    'regulatoryPathway',
    'keyInsights',
  ];

  for (const section of sections) {
    const val = synthesis[section];
    if (!val) continue;
    // Use extractTextValues to get clean text without JSON keys
    sectionTexts[section] = extractTextValues(val);
  }

  // Also include depth sections
  if (synthesis.depth && typeof synthesis.depth === 'object') {
    for (const [key, val] of Object.entries(synthesis.depth)) {
      if (!val) continue;
      sectionTexts[`depth.${key}`] = extractTextValues(val);
    }
  }

  // Extract claims per section
  const sectionClaims = {};
  for (const [section, text] of Object.entries(sectionTexts)) {
    sectionClaims[section] = extractClaims(text).map((c) => ({ ...c, section }));
  }

  // Flatten all claims
  const allClaims = Object.values(sectionClaims).flat();

  // Group claims by subject
  const grouped = {};
  for (const claim of allClaims) {
    const key = claim.subject.replace(/\b(the|a|an|is|are|was|were|has|have)\b/g, '').trim();
    if (!key) continue;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(claim);
  }

  // Also try fuzzy matching: if two subjects share 2+ significant words, group them
  const keys = Object.keys(grouped);
  const mergedGroups = {};
  const keyMapping = {};

  for (const key of keys) {
    let merged = false;
    for (const existingKey of Object.keys(mergedGroups)) {
      if (fuzzySubjectMatch(key, existingKey)) {
        mergedGroups[existingKey].push(...grouped[key]);
        keyMapping[key] = existingKey;
        merged = true;
        break;
      }
    }
    if (!merged) {
      mergedGroups[key] = [...grouped[key]];
      keyMapping[key] = key;
    }
  }

  // Detect opposing directions
  for (const [subject, subjectClaims] of Object.entries(mergedGroups)) {
    const ups = subjectClaims.filter((c) => c.direction === 'up');
    const downs = subjectClaims.filter((c) => c.direction === 'down');
    if (ups.length > 0 && downs.length > 0) {
      const upSections = [...new Set(ups.map((c) => c.section).filter(Boolean))];
      const downSections = [...new Set(downs.map((c) => c.section).filter(Boolean))];
      const isCrossSection =
        upSections.length > 0 &&
        downSections.length > 0 &&
        !upSections.every((s) => downSections.includes(s));

      contradictions.push({
        subject,
        claimA: ups[0].raw,
        claimB: downs[0].raw,
        sectionA: ups[0].section || 'unknown',
        sectionB: downs[0].section || 'unknown',
        crossSection: isCrossSection,
        severity: isCrossSection ? 'error' : 'warning',
        message: isCrossSection
          ? `Cross-section contradiction about "${subject}": ${ups[0].section || 'unknown'} says increasing, ${downs[0].section || 'unknown'} says decreasing`
          : `Contradictory claims about "${subject}": one says increasing, another says decreasing`,
      });
    }
  }

  return contradictions;
}

/**
 * Fuzzy match two subject strings: returns true if they share 2+ significant words
 * (words with 4+ chars, excluding stopwords).
 */
function fuzzySubjectMatch(a, b) {
  const wordsA = a.split(/\s+/).filter((w) => w.length >= 4);
  const wordsB = b.split(/\s+/).filter((w) => w.length >= 4);
  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.includes(w)) shared++;
  }
  return shared >= 2;
}

/**
 * Enhanced cross-section contradiction detection for specific section pairs.
 * Checks economics vs strategy vs timeline coherence.
 */
function checkCrossSectionContradictions(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') return [];
  const contradictions = [];

  // Check: high-growth market claim vs conservative deal economics
  const marketText = synthesis.marketOpportunityAssessment
    ? typeof synthesis.marketOpportunityAssessment === 'string'
      ? synthesis.marketOpportunityAssessment
      : JSON.stringify(synthesis.marketOpportunityAssessment)
    : '';

  const dealEcon = synthesis.depth?.dealEconomics;
  if (marketText && dealEcon) {
    const growthMatch = marketText.match(/(\d+(?:\.\d+)?)\s*%\s*(?:CAGR|growth|annually)/i);
    const parsed = parseDealEconomics(dealEcon);
    if (growthMatch && parsed.fields.irr != null) {
      const growthRate = parseFloat(growthMatch[1]);
      // If market growth is > 15% but IRR is < 10%, flag inconsistency
      if (growthRate > 15 && parsed.fields.irr < 10) {
        contradictions.push({
          type: 'economics-vs-market',
          message: `High market growth (${growthRate}% CAGR) but low deal IRR (${parsed.fields.irr}%) — typically high-growth markets offer higher returns`,
          severity: 'warning',
        });
      }
    }
  }

  return contradictions;
}

// ============ DECISION-USEFULNESS SCORING ============

function countWords(str) {
  if (!str || typeof str !== 'string') return 0;
  return str.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Score a text block on decision-usefulness (0-100).
 * Factors: specificity (named companies, real numbers), actionability, completeness.
 */
function scoreDecisionUsefulness(text) {
  if (!text || typeof text !== 'string') return { score: 0, factors: {} };

  const words = countWords(text);
  if (words < 10) return { score: 0, factors: { tooShort: true } };

  const factors = {};

  // Factor 1: Specificity — named entities (30 pts)
  const companyPattern =
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Corp|Ltd|Inc|Co|Group|GmbH|SA|AG|PLC|LLC|Sdn\s+Bhd)/g;
  const companyMatches = text.match(companyPattern) || [];
  factors.namedCompanies = companyMatches.length;
  const companyScore = Math.min(15, companyMatches.length * 5);

  // Specific numbers (not just years)
  const numberPattern =
    /(?:\$|€|£|¥)?\d[\d,.]*(?:\s*(?:million|billion|M|B|K|%|GW|MW|kW|TWh|GWh))/gi;
  const numberMatches = text.match(numberPattern) || [];
  factors.specificNumbers = numberMatches.length;
  const numberScore = Math.min(15, numberMatches.length * 3);

  // Factor 2: Actionability — action verbs, recommendations (25 pts)
  const actionPatterns = [
    /\b(recommend|should|target|prioritize|pursue|avoid|consider|focus on|invest in)\b/gi,
    /\b(by Q[1-4]|by 20\d{2}|within \d+ months|this week|next quarter)\b/gi,
  ];
  let actionCount = 0;
  for (const pat of actionPatterns) {
    const matches = text.match(pat) || [];
    actionCount += matches.length;
  }
  factors.actionVerbs = actionCount;
  const actionScore = Math.min(25, actionCount * 5);

  // Factor 3: Evidence chains (20 pts)
  // Look for "because", "which means", "resulting in", "driven by"
  const causalPatterns =
    /\b(because|which means|resulting in|driven by|due to|leading to|this implies|therefore|consequently)\b/gi;
  const causalMatches = text.match(causalPatterns) || [];
  factors.causalLinks = causalMatches.length;
  const causalScore = Math.min(20, causalMatches.length * 5);

  // Factor 4: Completeness — sufficient depth (10 pts)
  const completenessScore = words >= 100 ? 10 : Math.round((words / 100) * 10);
  factors.wordCount = words;

  const score = companyScore + numberScore + actionScore + causalScore + completenessScore;

  return {
    score: Math.min(100, score),
    factors,
  };
}

/**
 * Score decision-usefulness per section of a synthesis object.
 * Returns { sectionScores: {}, overall: number, flagged: string[] }
 */
function getDecisionScore(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') {
    return { sectionScores: {}, overall: 0, flagged: [] };
  }

  const sectionScores = {};
  const flagged = [];
  // Calibrated for noisy synthesized JSON sections where signal often appears in nested fields.
  const THRESHOLD = 40;

  // Score each top-level section
  const sections = [
    'executiveSummary',
    'marketOpportunityAssessment',
    'competitivePositioning',
    'regulatoryPathway',
    'keyInsights',
  ];

  for (const section of sections) {
    const val = synthesis[section];
    if (!val) {
      sectionScores[section] = 0;
      flagged.push(`${section}: missing`);
      continue;
    }

    const text = typeof val === 'string' ? val : JSON.stringify(val);
    const result = scoreDecisionUsefulness(text);
    sectionScores[section] = result.score;

    if (result.score < THRESHOLD) {
      flagged.push(
        `${section}: score ${result.score}/100 (below ${THRESHOLD} threshold) — ` +
          `${result.factors.namedCompanies || 0} companies, ${result.factors.specificNumbers || 0} numbers, ${result.factors.actionVerbs || 0} action items`
      );
    }
  }

  // Depth sections (deal economics, etc.)
  if (synthesis.depth) {
    for (const [key, val] of Object.entries(synthesis.depth)) {
      const text = typeof val === 'string' ? val : JSON.stringify(val);
      const result = scoreDecisionUsefulness(text);
      sectionScores[`depth.${key}`] = result.score;
      if (result.score < THRESHOLD) {
        flagged.push(`depth.${key}: score ${result.score}/100 (below ${THRESHOLD})`);
      }
    }
  }

  const scores = Object.values(sectionScores);
  const overall =
    scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  return { sectionScores, overall, flagged };
}

// ============ ANTI-SHALLOW CHECKS ============

/**
 * Detect "fact dump" patterns: long lists of generic facts without analysis.
 */
function detectFactDump(text) {
  if (!text || typeof text !== 'string') return { isFactDump: false };

  // Heuristic: high bullet/list density relative to analytical connectors
  const bulletCount = (text.match(/^[\s]*[-•*]\s/gm) || []).length;
  const numberedCount = (text.match(/^[\s]*\d+[.)]\s/gm) || []).length;
  const listItems = bulletCount + numberedCount;

  const analyticalConnectors = (
    text.match(
      /\b(however|therefore|consequently|this means|this implies|because|which suggests|the implication|as a result|in contrast)\b/gi
    ) || []
  ).length;

  const words = countWords(text);
  if (words < 50) return { isFactDump: false };

  const listDensity = listItems / (words / 50); // lists per 50 words
  const analysisDensity = analyticalConnectors / (words / 100); // connectors per 100 words

  const isFactDump = listDensity > 1.5 && analysisDensity < 0.5;

  return {
    isFactDump,
    listItems,
    analyticalConnectors,
    listDensity: Math.round(listDensity * 100) / 100,
    analysisDensity: Math.round(analysisDensity * 100) / 100,
  };
}

/**
 * Detect "macro padding": GDP/population/inflation data stuffed into
 * industry-specific sections.
 */
function detectMacroPadding(text, _industry) {
  if (!text || typeof text !== 'string') return { isMacroPadded: false, mentions: [] };

  const macroTerms = [
    /\bGDP\b/g,
    /\bgross domestic product\b/gi,
    /\bpopulation(?:\s+(?:of|is|was|stands at))?\s+\d/gi,
    /\binflation rate\b/gi,
    /\btrade balance\b/gi,
    /\bcurrent account\b/gi,
    /\bforeign direct investment\b/gi,
    /\bconsumer price index\b/gi,
    /\bunemployment rate\b/gi,
  ];

  const mentions = [];
  for (const pattern of macroTerms) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      mentions.push(match[0]);
    }
  }

  return {
    isMacroPadded: mentions.length >= 3,
    mentions,
    count: mentions.length,
  };
}

/**
 * Detect "empty calories": wordy paragraphs that say nothing specific.
 * Checks for high filler-word density and low information content.
 */
function detectEmptyCalories(text) {
  if (!text || typeof text !== 'string') return { isEmpty: false };

  const words = countWords(text);
  if (words < 30) return { isEmpty: false };

  // Filler/hedge patterns
  const fillerPatterns = [
    /\b(various|several|many|numerous|significant|substantial|considerable|important|major|key|critical|essential|vital|fundamental)\b/gi,
    /\b(it is worth noting|it should be noted|it is important to note|as mentioned|going forward|in this context|in terms of|with respect to|in the area of)\b/gi,
    /\b(may|might|could potentially|is expected to|is anticipated|is projected|tends to|appears to)\b/gi,
  ];

  let fillerCount = 0;
  for (const pat of fillerPatterns) {
    const matches = text.match(pat) || [];
    fillerCount += matches.length;
  }

  // Specific content signals
  const specificSignals = [
    /\$\d/g, // dollar amounts
    /\d+(?:\.\d+)?%/g, // percentages
    /(?:20[2-9]\d)/g, // recent years
    /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Corp|Ltd|Inc|Co|Group)/g, // company names
  ];

  let specificCount = 0;
  for (const pat of specificSignals) {
    const matches = text.match(pat) || [];
    specificCount += matches.length;
  }

  const fillerDensity = fillerCount / (words / 100);
  const specificDensity = specificCount / (words / 100);

  const isEmpty = fillerDensity > 8 && specificDensity < 2;

  return {
    isEmpty,
    fillerCount,
    specificCount,
    fillerDensity: Math.round(fillerDensity * 100) / 100,
    specificDensity: Math.round(specificDensity * 100) / 100,
  };
}

/**
 * Detect generic consultant filler phrases that add no substance.
 * Returns { hasFiller, phrases[], count, density }
 */
function detectConsultantFiller(text) {
  if (!text || typeof text !== 'string')
    return { hasFiller: false, phrases: [], count: 0, density: 0 };

  const words = countWords(text);
  if (words < 20) return { hasFiller: false, phrases: [], count: 0, density: 0 };

  const fillerPhrases = [
    /\bleverage synergies\b/gi,
    /\bstrategic value creation\b/gi,
    /\bholistic approach\b/gi,
    /\bparadigm shift\b/gi,
    /\bbest[- ]in[- ]class\b/gi,
    /\bworld[- ]class\b/gi,
    /\bcutting[- ]edge\b/gi,
    /\bnext[- ]generation\b/gi,
    /\bgame[- ]chang(?:er|ing)\b/gi,
    /\bmove the needle\b/gi,
    /\blow[- ]hanging fruit\b/gi,
    /\bvalue[- ]added\b/gi,
    /\bvalue proposition\b/gi,
    /\bthought leader(?:ship)?\b/gi,
    /\bcore competenc(?:y|ies)\b/gi,
    /\bscalable solution\b/gi,
    /\brobust framework\b/gi,
    /\bstakeholder alignment\b/gi,
    /\bactionable insights\b/gi,
    /\bgo[- ]to[- ]market\b/gi,
    /\bdeep dive\b/gi,
    /\bsynerg(?:y|ies|istic)\b/gi,
    /\btransformative\b/gi,
    /\bdisruptive innovation\b/gi,
    /\becosystem play\b/gi,
    /\bstrategic alignment\b/gi,
    /\bunlock(?:ing)? value\b/gi,
    /\boptimize\b/gi,
    /\bstreamline\b/gi,
    /\bempower(?:ing|ment)?\b/gi,
    /\bimpactful\b/gi,
  ];

  const found = [];
  for (const pattern of fillerPhrases) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      found.push(match[0].toLowerCase());
    }
  }

  const density = found.length / (words / 100);
  return {
    hasFiller: found.length >= 3,
    phrases: [...new Set(found)],
    count: found.length,
    density: Math.round(density * 100) / 100,
  };
}

/**
 * Run all anti-shallow checks on a synthesis section.
 */
function antiShallow(text, industry) {
  const factDump = detectFactDump(text);
  const macroPad = detectMacroPadding(text, industry);
  const emptyCalories = detectEmptyCalories(text);
  const consultantFiller = detectConsultantFiller(text);

  const issues = [];
  if (factDump.isFactDump) {
    issues.push(
      `Fact dump detected: ${factDump.listItems} list items with only ${factDump.analyticalConnectors} analytical connectors`
    );
  }
  if (macroPad.isMacroPadded) {
    issues.push(
      `Macro padding detected: ${macroPad.count} macro-economic references (${macroPad.mentions.slice(0, 3).join(', ')})`
    );
  }
  if (emptyCalories.isEmpty) {
    issues.push(
      `Empty calories: high filler density (${emptyCalories.fillerDensity}) with low specifics (${emptyCalories.specificDensity})`
    );
  }
  if (consultantFiller.hasFiller) {
    issues.push(
      `Consultant filler detected: ${consultantFiller.count} generic phrases (${consultantFiller.phrases.slice(0, 3).join(', ')})`
    );
  }

  return {
    pass: issues.length === 0,
    issues,
    details: { factDump, macroPadding: macroPad, emptyCalories, consultantFiller },
  };
}

// ============ DECISION GATE ============

/**
 * Run a minimum decision-usefulness gate on a synthesis.
 * Returns structured pass/fail with per-section details.
 * @param {object} synthesis - The synthesis object
 * @param {object} [options] - Options: { minScore: number }
 * @returns {{ pass, overallScore, minScore, sectionResults: { section, score, pass, factors }[], failedSections: string[] }}
 */
function runDecisionGate(synthesis, options = {}) {
  const minScore = options.minScore || 50;

  if (!synthesis || typeof synthesis !== 'object') {
    return {
      pass: false,
      overallScore: 0,
      minScore,
      sectionResults: [],
      failedSections: ['No synthesis provided'],
    };
  }

  const decision = getDecisionScore(synthesis);
  const sectionResults = [];
  const failedSections = [];

  for (const [section, score] of Object.entries(decision.sectionScores)) {
    const sectionPass = score >= minScore;
    sectionResults.push({
      section,
      score,
      pass: sectionPass,
    });
    if (!sectionPass) {
      failedSections.push(`${section}: ${score}/${minScore}`);
    }
  }

  return {
    pass: decision.overall >= minScore,
    overallScore: decision.overall,
    minScore,
    sectionResults,
    failedSections,
  };
}

// ============ RENDER CONTENT GENERATION ============

/**
 * Convert structured deal economics into formatted render blocks
 * suitable for PPT rendering.
 */
function generateDealEconomicsRenderBlocks(parsedDealEcon) {
  if (!parsedDealEcon || !parsedDealEcon.valid) return [];

  const blocks = [];
  const f = parsedDealEcon.fields;

  // Deal size block
  if (f.dealSize && (f.dealSize.min || f.dealSize.max || f.dealSize.average)) {
    const sizeItems = [];
    if (f.dealSize.min) sizeItems.push(`Min: ${formatCurrency(f.dealSize.min)}`);
    if (f.dealSize.max) sizeItems.push(`Max: ${formatCurrency(f.dealSize.max)}`);
    if (f.dealSize.average) sizeItems.push(`Average: ${formatCurrency(f.dealSize.average)}`);

    blocks.push({
      key: 'dealEconomics',
      type: 'metrics',
      title: 'Typical Deal Size',
      data: sizeItems,
    });
  }

  // Financial metrics block
  const financialItems = [];
  if (f.paybackPeriod != null) financialItems.push(`Payback: ${formatMonths(f.paybackPeriod)}`);
  if (f.irr != null) financialItems.push(`IRR: ${f.irr}%`);
  if (f.marginProfile != null) financialItems.push(`Margin: ${f.marginProfile}%`);

  if (financialItems.length > 0) {
    blocks.push({
      key: 'dealEconomics',
      type: 'metrics',
      title: 'Financial Metrics',
      data: financialItems,
    });
  }

  // Contract terms block
  if (f.contractDuration || f.revenueSplit || f.guaranteeStructure) {
    const termItems = [];
    if (f.contractDuration) termItems.push(`Duration: ${formatMonths(f.contractDuration)}`);
    if (f.revenueSplit) termItems.push(`Revenue Split: ${f.revenueSplit}`);
    if (f.guaranteeStructure) termItems.push(`Guarantee: ${f.guaranteeStructure}`);

    blocks.push({
      key: 'dealEconomics',
      type: 'metrics',
      title: 'Contract Terms',
      data: termItems,
    });
  }

  // Financing options block
  if (f.financingOptions && f.financingOptions.length > 0) {
    blocks.push({
      key: 'dealEconomics',
      type: 'list',
      title: 'Financing Options',
      data: f.financingOptions,
    });
  }

  // Key insight block
  if (f.keyInsight) {
    blocks.push({
      key: 'dealEconomics',
      type: 'insight',
      title: 'Key Investment Thesis',
      content: f.keyInsight,
    });
  }

  return blocks;
}

function formatCurrency(normalized) {
  if (!normalized) return 'N/A';
  const { value, currency } = normalized;
  const sym =
    Object.entries(CURRENCY_SYMBOLS).find(([, code]) => code === currency)?.[0] || currency + ' ';
  if (value >= 1e9) return `${sym}${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${sym}${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${sym}${(value / 1e3).toFixed(0)}K`;
  return `${sym}${value}`;
}

function formatMonths(months) {
  if (months == null) return 'N/A';
  if (months >= 24 && months % 12 === 0) return `${months / 12} years`;
  if (months >= 12) return `${(months / 12).toFixed(1)} years`;
  return `${months} months`;
}

// ============ FULL QUALITY REPORT ============

/**
 * Generate a comprehensive quality report for an entire synthesis deck.
 *
 * @param {object} synthesis - The full synthesis object
 * @param {string} [industry] - The industry context
 * @returns {{ sectionScores, overallScore, contradictions, plausibility, antiShallowResults, suggestions, pass }}
 */
function analyze(synthesis, industry) {
  if (!synthesis || typeof synthesis !== 'object') {
    return {
      sectionScores: {},
      overallScore: 0,
      contradictions: [],
      plausibility: [],
      antiShallowResults: {},
      suggestions: ['No synthesis data provided'],
      pass: false,
    };
  }

  // 1. Decision-usefulness scores
  const decision = getDecisionScore(synthesis);

  // 2. Contradiction checks
  const contradictions = checkContradictions(synthesis);

  // 3. Plausibility checks on deal economics
  let plausibility = [];
  if (synthesis.depth?.dealEconomics) {
    const parsed = parseDealEconomics(synthesis.depth.dealEconomics);
    plausibility = checkPlausibility(parsed);
  }

  // 4. Anti-shallow per section
  const antiShallowResults = {};
  const textSections = {
    executiveSummary: synthesis.executiveSummary,
    marketOpportunityAssessment: synthesis.marketOpportunityAssessment,
    competitivePositioning: synthesis.competitivePositioning,
    keyInsights: synthesis.keyInsights,
  };

  for (const [key, val] of Object.entries(textSections)) {
    if (!val) continue;
    const text = typeof val === 'string' ? val : JSON.stringify(val);
    antiShallowResults[key] = antiShallow(text, industry);
  }

  // 5. Generate suggestions
  const suggestions = [];

  for (const flag of decision.flagged) {
    suggestions.push(`Low decision-usefulness: ${flag}`);
  }

  for (const c of contradictions) {
    suggestions.push(`Contradiction: ${c.message}`);
  }

  for (const p of plausibility) {
    if (p.severity === 'error') {
      suggestions.push(`Implausible value: ${p.issue}`);
    }
  }

  for (const [section, result] of Object.entries(antiShallowResults)) {
    for (const issue of result.issues) {
      suggestions.push(`${section}: ${issue}`);
    }
  }

  // 6. Overall score
  let overallScore = decision.overall;

  // Deductions for issues
  const errorCount = plausibility.filter((p) => p.severity === 'error').length;
  overallScore -= errorCount * 10;
  overallScore -= contradictions.length * 5;
  const shallowSections = Object.values(antiShallowResults).filter((r) => !r.pass).length;
  overallScore -= shallowSections * 5;

  overallScore = Math.max(0, Math.min(100, overallScore));

  return {
    sectionScores: decision.sectionScores,
    overallScore,
    contradictions,
    plausibility,
    antiShallowResults,
    suggestions,
    pass: overallScore >= 50,
  };
}

// ============ EXPORTS ============

module.exports = {
  // Core analysis
  analyze,
  getDecisionScore,
  checkContradictions,
  checkCrossSectionContradictions,
  antiShallow,
  runDecisionGate,

  // Semantic parsers
  parseDealEconomics,
  parseEntryStrategy,
  parsePartnerAssessment,
  checkPlausibility,
  generateDealEconomicsRenderBlocks,

  // Insight validation
  validateInsightStructure,

  // Normalization helpers
  normalizeCurrency,
  normalizePercentage,
  normalizeTimePeriod,

  // Sub-checks (exported for testing)
  detectFactDump,
  detectMacroPadding,
  detectEmptyCalories,
  detectConsultantFiller,
  scoreDecisionUsefulness,
  extractClaims,
};
