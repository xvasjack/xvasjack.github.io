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
  const trailingCode = cleaned.match(/\s+(USD|EUR|GBP|JPY|INR|CNY|KRW|THB|VND|IDR|MYR|SGD|PHP|AUD|CAD)$/i);
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
  const wordMatch = cleaned.match(
    /^(-?\d+(?:\.\d+)?)\s*(thousand|million|billion|trillion)$/i
  );
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
  const downVerbs = /\b(declining|decreased|falling|shrinking|contracting|weakening|stagnant|depressed)\b/i;
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
  let s = sentence.replace(/["{},:\[\]]/g, ' ').trim();
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
 * Check for contradictions within a synthesis object.
 * Looks for opposing directional claims about the same subject.
 */
function checkContradictions(synthesis) {
  if (!synthesis || typeof synthesis !== 'object') return [];

  const contradictions = [];
  const text = JSON.stringify(synthesis);

  const claims = extractClaims(text);

  // Group claims by subject
  const grouped = {};
  for (const claim of claims) {
    // Fuzzy match: normalize subject
    const key = claim.subject.replace(/\b(the|a|an|is|are|was|were|has|have)\b/g, '').trim();
    if (!key) continue;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(claim);
  }

  // Detect opposing directions
  for (const [subject, subjectClaims] of Object.entries(grouped)) {
    const ups = subjectClaims.filter((c) => c.direction === 'up');
    const downs = subjectClaims.filter((c) => c.direction === 'down');
    if (ups.length > 0 && downs.length > 0) {
      contradictions.push({
        subject,
        claimA: ups[0].raw,
        claimB: downs[0].raw,
        severity: 'warning',
        message: `Contradictory claims about "${subject}": one says increasing, another says decreasing`,
      });
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
  const companyPattern = /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Corp|Ltd|Inc|Co|Group|GmbH|SA|AG|PLC|LLC|Sdn\s+Bhd)/g;
  const companyMatches = text.match(companyPattern) || [];
  factors.namedCompanies = companyMatches.length;
  const companyScore = Math.min(15, companyMatches.length * 5);

  // Specific numbers (not just years)
  const numberPattern = /(?:\$|€|£|¥)?\d[\d,.]*(?:\s*(?:million|billion|M|B|K|%|GW|MW|kW|TWh|GWh))/gi;
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
  const causalPatterns = /\b(because|which means|resulting in|driven by|due to|leading to|this implies|therefore|consequently)\b/gi;
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
  const overall = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

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
 * Run all anti-shallow checks on a synthesis section.
 */
function antiShallow(text, industry) {
  const factDump = detectFactDump(text);
  const macroPad = detectMacroPadding(text, industry);
  const emptyCalories = detectEmptyCalories(text);

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

  return {
    pass: issues.length === 0,
    issues,
    details: { factDump, macroPadding: macroPad, emptyCalories },
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
  const sym = Object.entries(CURRENCY_SYMBOLS).find(([, code]) => code === currency)?.[0] || currency + ' ';
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
    pass: overallScore >= 40,
  };
}

// ============ EXPORTS ============

module.exports = {
  // Core analysis
  analyze,
  getDecisionScore,
  checkContradictions,
  antiShallow,

  // Deal economics
  parseDealEconomics,
  checkPlausibility,
  generateDealEconomicsRenderBlocks,

  // Normalization helpers
  normalizeCurrency,
  normalizePercentage,
  normalizeTimePeriod,

  // Sub-checks (exported for testing)
  detectFactDump,
  detectMacroPadding,
  detectEmptyCalories,
  scoreDecisionUsefulness,
  extractClaims,
};
