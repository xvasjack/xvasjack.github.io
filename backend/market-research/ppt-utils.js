const { callGeminiPro, callGemini } = require('./ai-clients');
const { ensureString: _ensureString } = require('./shared/utils');

// PPTX-safe ensureString: strips XML-invalid control characters.
// eslint-disable-next-line no-control-regex
const XML_INVALID_CHARS_UTILS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
function stripInvalidSurrogates(value) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i] + value[i + 1];
        i++;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    out += value[i];
  }
  return out;
}
function ensureString(value, defaultValue) {
  return stripInvalidSurrogates(
    _ensureString(value, defaultValue).replace(XML_INVALID_CHARS_UTILS, '')
  );
}

// Load template patterns for smart layout engine
let templatePatterns = {};
try {
  templatePatterns = require('./template-patterns.json');
} catch (e) {
  console.warn('[ppt-utils] template-patterns.json not found, using defaults');
}

const TEMPLATE = templatePatterns.pptxPositions
  ? {
      title: templatePatterns.pptxPositions.title,
      contentArea: templatePatterns.pptxPositions.contentArea,
      sourceBar: templatePatterns.pptxPositions.sourceBar,
    }
  : {
      title: { x: 0.3758, y: 0.0488, w: 12.5862, h: 0.9097 },
      contentArea: { x: 0.3758, y: 1.5, w: 12.5862, h: 5.0 },
      sourceBar: { x: 0.3758, y: 6.6944, w: 12.5862, h: 0.25 },
    };

// Template colors shorthand — avoids repeating templatePatterns.style?.colors? everywhere
const TP_COLORS = templatePatterns.style?.colors || {};
const C_DK2 = TP_COLORS.dk2 || '1F497D';
const C_ACCENT1 = TP_COLORS.accent1 || '007FFF';
const C_ACCENT3 = TP_COLORS.accent3 || '011AB7';
const C_ACCENT6 = TP_COLORS.accent6 || 'E46C0A';
const C_TABLE_HEADER = TP_COLORS.tableHeaderFill || 'FFFFFF';
const C_WHITE = TP_COLORS.lt1 || 'FFFFFF';
const C_BLACK = TP_COLORS.dk1 || '000000'; // Standard text color (template dk1)
const C_TRUE_BLACK = '000000'; // Chart axes/titles
const C_BORDER = templatePatterns.style?.table?.borderColor || 'D6D7D9'; // Template table border
const rawBorderStyle = templatePatterns.style?.table?.borderStyle || 'dash';
const C_BORDER_STYLE = rawBorderStyle === 'sysDash' ? 'dash' : rawBorderStyle;
const TABLE_BORDER_WIDTH = templatePatterns.style?.table?.borderWidth || 1;
const C_MUTED = '999999'; // Muted/unavailable text
const C_AXIS_GRAY = TP_COLORS.gridLine || 'D6D7D9'; // Chart axis/grid lines
const C_CALLOUT_FILL = TP_COLORS.calloutFill || 'D9D9D9'; // Callout bg (bg1 lumMod 85%)
const C_CALLOUT_BORDER = TP_COLORS.calloutBorder || 'BFBFBF'; // Callout border (bg1 lumMod 75%)
// Cell margins in inches (pptxgenjs table margin is inch-based).
// NOTE: Converting to points here caused 3in cell padding in output XML
// (e.g., marL/marR=2743200 EMU). Keep raw inch values from template metadata.
// Template baseline: LR=0.04in, TB=0
const TABLE_CELL_MARGIN = [
  Number(templatePatterns.style?.table?.cellMarginTB || 0),
  Number(templatePatterns.style?.table?.cellMarginLR || 0.04),
  Number(templatePatterns.style?.table?.cellMarginTB || 0),
  Number(templatePatterns.style?.table?.cellMarginLR || 0.04),
];
const C_LIGHT_GRAY = 'F5F5F5'; // Panel/callout backgrounds
const C_GRAY_BG = 'F2F2F2'; // Alternate row/content backgrounds
const C_SECONDARY = '666666'; // Secondary text
const C_LIGHT_BLUE = 'D6E4F0'; // Matrix quadrant / section overview

// Template font specs
const TP_FONTS = templatePatterns.style?.fonts || {};
const TITLE_FONT_SIZE = TP_FONTS.title?.size || 20;
const TITLE_BOLD = TP_FONTS.title?.bold !== undefined ? TP_FONTS.title.bold : false;

// Shared chart axis/grid defaults (identical across all chart types)
const CHART_AXIS_DEFAULTS = {
  titleColor: C_TRUE_BLACK,
  catAxisLabelColor: C_TRUE_BLACK,
  catAxisLineColor: C_AXIS_GRAY,
  catGridLineColor: C_AXIS_GRAY,
  valAxisLabelColor: C_TRUE_BLACK,
  valAxisLineColor: C_AXIS_GRAY,
  valGridLineColor: C_AXIS_GRAY,
};

// ============ PPT GENERATION ============

// Helper: truncate text to fit slides - end at sentence or phrase boundary
// CRITICAL: Never cut mid-sentence. Better to be shorter than incomplete.
// Adds ellipsis (...) when text is truncated to indicate continuation
function truncate(text, maxLen = 600, addEllipsis = true) {
  if (!text) return '';
  const str = String(text).trim().replace(XML_INVALID_CHARS_UTILS, '');
  if (str.length <= maxLen) return str;

  // Find the last sentence boundary before maxLen
  const truncated = str.substring(0, maxLen);

  // Try to end at sentence boundary (. ! ?) - look for period followed by space or end
  const sentenceEnders = ['. ', '! ', '? '];
  let lastSentence = -1;
  for (const ender of sentenceEnders) {
    const pos = truncated.lastIndexOf(ender);
    if (pos > lastSentence) lastSentence = pos;
  }
  // Also check for sentence ending at the very end (no trailing space)
  if (truncated.endsWith('.') || truncated.endsWith('!') || truncated.endsWith('?')) {
    lastSentence = Math.max(lastSentence, truncated.length - 1);
  }

  // Helper to add ellipsis if text continues after this point
  const maybeEllipsis = (result, checkPos) => {
    // Only add ellipsis if there's more content after the cut point
    const needsEllipsis = addEllipsis && checkPos < str.length - 1 && !result.endsWith('.');
    return needsEllipsis ? result + '...' : result;
  };

  if (lastSentence > maxLen * 0.4) {
    const result = truncated.substring(0, lastSentence + 1).trim();
    // Sentence ends naturally - only add ellipsis if there's more content and it doesn't end with period
    return maybeEllipsis(result, lastSentence + 1);
  }

  // Try to end at strong phrase boundary (; or :)
  const strongPhrase = Math.max(truncated.lastIndexOf('; '), truncated.lastIndexOf(': '));
  if (strongPhrase > maxLen * 0.4) {
    const result = truncated.substring(0, strongPhrase + 1).trim();
    return maybeEllipsis(result, strongPhrase + 1);
  }

  // Try to end at parenthetical close
  const lastParen = truncated.lastIndexOf(')');
  if (lastParen > maxLen * 0.5) {
    const result = truncated.substring(0, lastParen + 1).trim();
    return maybeEllipsis(result, lastParen + 1);
  }

  // Try to end at comma boundary (weaker)
  const lastComma = truncated.lastIndexOf(', ');
  if (lastComma > maxLen * 0.5) {
    const result = truncated.substring(0, lastComma).trim();
    return addEllipsis ? result + '...' : result;
  }

  // Last resort: end at word boundary, but ensure we don't cut mid-word
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) {
    // Check if ending on a preposition/article - if so, cut earlier
    const words = truncated.substring(0, lastSpace).split(' ');
    const lastWord = words[words.length - 1].toLowerCase();
    const badEndings = [
      'for',
      'to',
      'the',
      'a',
      'an',
      'of',
      'in',
      'on',
      'at',
      'by',
      'with',
      'and',
      'or',
      'but',
      'are',
      'is',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'largely',
      'mostly',
      'mainly',
    ];
    if (badEndings.includes(lastWord) && words.length > 1) {
      // Remove the dangling preposition/article
      words.pop();
      const result = words.join(' ').trim();
      return addEllipsis ? result + '...' : result;
    }
    const result = truncated.substring(0, lastSpace).trim();
    return addEllipsis ? result + '...' : result;
  }

  const result = truncated.trim();
  return addEllipsis ? result + '...' : result;
}

// Helper: truncate subtitle/message text (max 180 chars for 1-2 sentence subtitles)
// Adds ellipsis (...) when text is truncated
function truncateSubtitle(text, maxLen = 180, addEllipsis = true) {
  if (!text) return '';
  const str = String(text).trim().replace(XML_INVALID_CHARS_UTILS, '');
  if (str.length <= maxLen) return str;

  // For subtitles, prefer ending at sentence boundary
  const truncated = str.substring(0, maxLen);

  // Look for sentence end
  const lastPeriod = truncated.lastIndexOf('. ');
  if (lastPeriod > maxLen * 0.4) {
    const result = truncated.substring(0, lastPeriod + 1).trim();
    // Only add ellipsis if there's more content after and doesn't end with period
    const needsEllipsis = addEllipsis && lastPeriod + 1 < str.length - 1 && !result.endsWith('.');
    return needsEllipsis ? result + '...' : result;
  }

  // Look for other clean breaks
  const lastColon = truncated.lastIndexOf(': ');
  if (lastColon > maxLen * 0.4) {
    const result = truncated.substring(0, lastColon + 1).trim();
    return addEllipsis && lastColon + 1 < str.length - 1 ? result + '...' : result;
  }

  // Fall back to truncate function (which handles ellipsis)
  return truncate(str, maxLen, addEllipsis);
}

// Helper: safely get array items
function safeArray(arr, max = 5) {
  if (Array.isArray(arr)) return arr.slice(0, max);
  if (typeof arr === 'string' && arr.trim()) {
    return arr
      .split(/;\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, max);
  }
  return [];
}

// Guard addTable calls so malformed AI rows never throw and break slide generation.
function normalizeTableRows(rows) {
  if (!Array.isArray(rows)) return null;
  const normalized = rows
    .map((row) => {
      if (Array.isArray(row)) {
        const cells = row.map((cell) => {
          if (cell == null) return { text: '' };
          if (typeof cell === 'object' && !Array.isArray(cell)) {
            const normalizedCell = { ...cell };
            normalizedCell.text = ensureString(
              Object.prototype.hasOwnProperty.call(normalizedCell, 'text')
                ? normalizedCell.text
                : ''
            );
            return normalizedCell;
          }
          return { text: ensureString(cell) };
        });
        return cells.length > 0 ? cells : null;
      }
      if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
        return [{ text: ensureString(row.text || '') }];
      }
      if (typeof row === 'string' || typeof row === 'number' || typeof row === 'boolean') {
        return [{ text: ensureString(row) }];
      }
      return null;
    })
    .filter((row) => Array.isArray(row) && row.length > 0);
  return normalized.length > 0 ? normalized : null;
}

function tableCellText(cell) {
  if (cell == null) return '';
  if (typeof cell === 'object' && !Array.isArray(cell)) {
    return ensureString(Object.prototype.hasOwnProperty.call(cell, 'text') ? cell.text : '').trim();
  }
  return ensureString(cell).trim();
}

function compactTableColumns(rows, options = {}, context = 'table') {
  if (!Array.isArray(rows) || rows.length === 0) return { rows, options };
  const colCount = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  if (colCount <= 1) return { rows, options };

  const usedColumns = [];
  for (let col = 0; col < colCount; col++) {
    let hasContent = false;
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      if (tableCellText(row[col]).length > 0) {
        hasContent = true;
        break;
      }
    }
    usedColumns.push(hasContent);
  }

  let keepIndexes = usedColumns.map((used, idx) => (used ? idx : -1)).filter((idx) => idx >= 0);
  if (keepIndexes.length === 0) keepIndexes = [0];
  if (keepIndexes.length === colCount) return { rows, options };

  const compactedRows = rows.map((row) =>
    keepIndexes.map((idx) => (row && row[idx] !== undefined ? row[idx] : { text: '' }))
  );

  let compactedOptions = options;
  if (options && typeof options === 'object') {
    compactedOptions = { ...options };
    if (Array.isArray(compactedOptions.colW) && compactedOptions.colW.length >= colCount) {
      const original = compactedOptions.colW.map((w) => Number(w) || 0);
      let filtered = keepIndexes.map((idx) => original[idx] || 0);
      const sumOriginal = original.reduce((acc, w) => acc + w, 0);
      const sumFiltered = filtered.reduce((acc, w) => acc + w, 0);
      if (sumOriginal > 0 && sumFiltered > 0) {
        const scale = sumOriginal / sumFiltered;
        filtered = filtered.map((w) => Number((w * scale).toFixed(3)));
      }
      compactedOptions.colW = filtered;
    }
  }

  console.log(`[PPT] ${context}: compacted table columns ${colCount} -> ${keepIndexes.length}`);
  return { rows: compactedRows, options: compactedOptions };
}

// Normalize table margins to inches to avoid pt-vs-inch regressions in generated XML.
// Heuristic: values >2 are treated as points and converted to inches.
function normalizeTableMarginValue(raw) {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < 0) return 0;
  if (numeric > 2) {
    const inches = numeric / 72;
    if (Number.isFinite(inches) && inches <= 2) return Number(inches.toFixed(4));
  }
  return numeric;
}

function normalizeTableMarginArray(margin, fallback = TABLE_CELL_MARGIN) {
  if (!Array.isArray(margin) || margin.length !== 4) return null;
  return margin.map((value, idx) => {
    const normalized = normalizeTableMarginValue(value);
    if (normalized == null) return Number(fallback?.[idx] || 0);
    return normalized;
  });
}

function sanitizeTableCellMargins(rows, context = 'table') {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  let corrected = 0;
  const sanitized = rows.map((row) => {
    if (!Array.isArray(row)) return row;
    return row.map((cell) => {
      if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return cell;
      if (!cell.options || !Array.isArray(cell.options.margin)) return cell;
      const normalizedMargin = normalizeTableMarginArray(cell.options.margin);
      if (!normalizedMargin) return cell;
      const changed = normalizedMargin.some(
        (value, idx) => Math.abs(value - Number(cell.options.margin[idx] ?? 0)) > 1e-6
      );
      if (!changed) return cell;
      corrected++;
      return {
        ...cell,
        options: {
          ...cell.options,
          margin: normalizedMargin,
        },
      };
    });
  });
  if (corrected > 0) {
    console.warn(`[PPT] ${context}: normalized ${corrected} table cell margin(s) to inch units`);
  }
  return sanitized;
}

function safeAddTable(slide, rows, options = {}, context = 'table') {
  const normalizedRows = normalizeTableRows(rows);
  if (!normalizedRows) {
    console.warn(`[PPT] ${context}: invalid rows, skipping table`);
    return false;
  }
  let addOptions = options && typeof options === 'object' ? { ...options } : options;
  const compacted = compactTableColumns(normalizedRows, addOptions, context);
  let tableRows = compacted.rows;
  addOptions = compacted.options;
  tableRows = sanitizeTableCellMargins(tableRows, context);
  if (addOptions && typeof addOptions === 'object') {
    // Keep table layout deterministic across runs and template-conformant.
    delete addOptions.autoPage;
    delete addOptions.autoPageRepeatHeader;
    delete addOptions.autoPageHeaderRows;
    const normalizedMargin = normalizeTableMarginArray(addOptions.margin);
    if (normalizedMargin) addOptions.margin = normalizedMargin;
  }
  try {
    slide.addTable(tableRows, addOptions);
    return true;
  } catch (err) {
    console.warn(`[PPT] ${context}: addTable failed (${err.message})`);
    return false;
  }
}

// Helper: safely convert any value to text for addText calls
function safeText(value) {
  if (typeof value === 'string') return ensureString(value);
  if (Array.isArray(value)) return value.map((v) => ensureString(v)).join('\n\n');
  if (value && typeof value === 'object') return ensureString(value);
  return String(value || '');
}

function sanitizeHyperlinkUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// Helper: ensure company has a website URL, construct fallback from name if missing
function ensureWebsite(company) {
  if (!company || typeof company !== 'object') return company;
  const existing = sanitizeHyperlinkUrl(company.website);
  if (existing) {
    company.website = existing;
    return company;
  }

  if (company.name) {
    // Build a plausible search URL as fallback so the company name is still clickable.
    const searchName = encodeURIComponent(String(company.name).trim());
    const fallback = `https://www.google.com/search?q=${searchName}+official+website`;
    company.website = sanitizeHyperlinkUrl(fallback);
  } else if (Object.prototype.hasOwnProperty.call(company, 'website')) {
    delete company.website;
  }
  return company;
}

// Helper: validate that an item is actually a company (not a section header, insight, or analysis text)
function isValidCompany(item) {
  if (!item || typeof item !== 'object') return false;
  const name = String(item.name || '').trim();
  if (!name || name.length < 2) return false;
  // Filter out section headers, bullet points, analysis text
  const invalidPatterns = [
    /^[\d]+\.\s/, // Numbered items like "1. Policy & Regulations"
    /market\s*analysis$/i,
    /key\s*insights?/i,
    /section\s*\d/i,
    /not\s*(specified|available|quantified)/i,
    /^primary\s+energy/i,
    /energy\s+demand\s+growth/i,
    /market\s+(growing|size|overview|dynamics|unbundling)/i,
    /government\s+(is|wants|policy)/i,
    /compliance\s+(burden|require)/i,
    /^\d+%\s/,
    /CAGR/i,
    /^[^a-zA-Z]*$/, // No letters at all
    /policy\s*&\s*regulations/i,
    /^policy\b/i,
    /^regulations?\b/i,
    /petroleum\s+law/i,
    /investor[- ]friendly/i,
    /decarbonization/i,
    /creates?\s+(investor|compliance)/i,
    /amendments?\s+created/i,
    /regime\s+with/i,
    /enforcement/i,
    /^(opportunities|obstacles|recommendations|overview|summary|conclusion)/i,
    /strategic\s+(analysis|implication|recommendation)/i,
    /competitive\s+landscape/i,
    /entry\s+strategy/i,
    /market\s+entry/i,
    /^(total|final)\s+energy/i,
    /slide\s*\d/i,
    /table\s+of\s+contents/i,
    /energy\s+services?,?\s*(oil|gas)/i, // "energy services, oil and gas" is a sector, not a company
    /oil\s+and\s+gas\s+market/i,
    /^(key|main|top|major|primary)\s+(players?|companies|competitors|findings|trends)/i,
    /market\s+(research|report|analysis|assessment|study)/i,
    /^(national|foreign|local|japanese)\s+(energy|policy|investment|players?)/i,
    /^(implementation|execution|roadmap|timeline|action)\s*(plan|steps?)?$/i,
    /^(demand|supply|pricing|infrastructure|capacity)\s+(analysis|overview|trends?)/i,
    /^(target|customer|client)\s+(segments?|list|companies)/i,
    /\b(M&A|merger|acquisition)\s+(activity|targets?|landscape)/i,
    /^why\s+now\b/i,
    /^go[\s/]no[\s-]go\b/i,
    /^ESCO\s+(market|economics|deal)/i,
    /^(gas|lng|electricity|power)\s+(market|supply|demand)/i,
    /^[A-Z][a-z]+(?:'s)?\s+(share|monopoly|market|consumption|push|growth)/i,
    /\b(targeted|expected|projected|estimated)\s+to\s+(drop|grow|reach|increase|decline)/i,
    /\b(strong|weak|moderate|significant|limited),?\s+(state|growth|push|driven)/i,
    /\b\d+\.?\d*%/, // Contains percentage figures
    /\bsource:\s/i, // Contains source citation
    /\b(per|from|until|between|across|through)\s+\d{4}/i, // Contains year references in sentences
    /\bnot\s+(specified|quantified|available)\b/i, // "not specified in research"
    /\bdata\s+not\b/i, // "data not specified"
    /\bbut\s+\w+\s+market\b/i, // "but energy services market growing..."
    /\b(growing|declining)\s+at\s+\d/i, // "growing at 12-15%"
    /\bmarket\s+\w+\s+(analysis|overview)\b/i, // "energy services market analysis"
    /[a-z]{3,}\.\s+[A-Z]/, // Contains period ending a sentence (lowercase word. Uppercase start) — allows abbreviations like J.P. and A.T.
  ];
  for (const pattern of invalidPatterns) {
    if (pattern.test(name)) return false;
  }
  // Name too long to be a company name (likely analysis text)
  if (name.length > 80) return false;
  // Reject names with > 6 words (almost certainly analysis text)
  const words = name.split(/\s+/);
  if (words.length > 6) return false;
  // Reject names that look like sentences (contain verbs and are long)
  if (
    /\b(is|are|was|were|has|have|had|created|creates|wants|drives|enables|requires|should|must|will|can)\b/i.test(
      name
    ) &&
    name.length > 25
  )
    return false;
  // Reject names that are mostly lowercase words with no proper nouns (likely descriptions)
  if (words.length > 4) {
    const capitalizedWords = words.filter((w) => /^[A-Z]/.test(w));
    if (capitalizedWords.length < words.length * 0.3 && name.length > 40) return false;
  }
  return true;
}

// Helper: deduplicate companies by normalized name and website domain
function dedupeCompanies(companies) {
  if (!Array.isArray(companies)) return companies;
  const seen = new Set();
  return companies.filter((c) => {
    if (!c || !c.name) return false;
    // Normalize: lowercase, strip common suffixes
    const normName = String(c.name)
      .trim()
      .toLowerCase()
      .replace(
        /\b(ltd|inc|corp|co|llc|plc|sdn\s*bhd|pte|pvt|limited|corporation|company)\b\.?/gi,
        ''
      )
      .replace(/[^a-z0-9]/g, '');
    if (!normName) return false;
    // Also check domain if website exists
    let domain = '';
    if (c.website && !c.website.includes('google.com/search')) {
      try {
        domain = new URL(c.website).hostname.replace(/^www\./, '').toLowerCase();
      } catch (_) {
        /* invalid URL */
      }
    }
    const key = domain || normName;
    if (seen.has(key)) return false;
    seen.add(key);
    // Also add normalized name as secondary key
    if (domain && normName) seen.add(normName);
    return true;
  });
}

// Flatten nested competitor player profile/financialHighlights into top-level fields
// AI synthesis returns data nested under profile/financialHighlights keys;
// PPT renderers expect flat top-level fields like revenue, employees, entryYear, etc.
function flattenPlayerProfile(p) {
  if (!p || typeof p !== 'object') return {};
  const flat = { ...p };
  if (p.profile && typeof p.profile === 'object') {
    flat.revenue = p.revenue || p.profile.revenueGlobal || p.profile.revenueLocal;
    flat.employees = p.employees || p.profile.employees;
    flat.entryYear = p.entryYear || p.profile.entryYear;
    flat.mode = p.mode || p.profile.entryMode;
    if (!flat.description && p.profile.overview) flat.description = p.profile.overview;
  }
  if (p.financialHighlights && typeof p.financialHighlights === 'object') {
    flat.growthRate = p.growthRate || p.financialHighlights.growthRate;
    flat.profitMargin = p.profitMargin || p.financialHighlights.profitMargin;
    flat.investmentToDate = p.investmentToDate || p.financialHighlights.investmentToDate;
  }
  return flat;
}

// Module-scope company description enricher for use in multi-country path
function enrichCompanyDesc(company, countryStr, industryStr) {
  if (!company || typeof company !== 'object') return company;
  const desc = company.description || '';
  const wordCount = desc.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 50) return company;
  const parts = [];
  if (desc) parts.push(desc);
  if (company.revenue && !desc.includes(company.revenue))
    parts.push('Revenue: ' + company.revenue + '.');
  if (company.marketShare && !desc.includes(company.marketShare))
    parts.push('Market share: ' + company.marketShare + '.');
  if (company.growthRate) parts.push('Growth rate: ' + company.growthRate + '.');
  if (company.employees) parts.push('Workforce: ' + company.employees + ' employees.');
  if (company.strengths) parts.push('Key strengths: ' + company.strengths + '.');
  else if (company.strength) parts.push('Key strength: ' + company.strength + '.');
  if (company.weaknesses) parts.push('Weaknesses: ' + company.weaknesses + '.');
  else if (company.weakness) parts.push('Weakness: ' + company.weakness + '.');
  if (company.competitiveAdvantage)
    parts.push('Competitive advantage: ' + company.competitiveAdvantage + '.');
  if (company.keyDifferentiator)
    parts.push('Key differentiator: ' + company.keyDifferentiator + '.');
  if (company.projects) parts.push('Key projects: ' + company.projects + '.');
  if (company.assessment) parts.push(company.assessment);
  if (company.success) parts.push(company.success);
  if (company.presence) parts.push('Market presence: ' + company.presence + '.');
  if (company.type) parts.push('Company type: ' + company.type + '.');
  if (company.origin && company.entryYear)
    parts.push(company.origin + '-based, entered market in ' + company.entryYear + '.');
  else if (company.origin) parts.push('Origin: ' + company.origin + '.');
  else if (company.entryYear) parts.push('Entered market: ' + company.entryYear + '.');
  if (company.mode) parts.push('Entry mode: ' + company.mode + '.');
  if (company.partnershipFit) parts.push('Partnership fit: ' + company.partnershipFit + '/5.');
  if (company.acquisitionFit) parts.push('Acquisition fit: ' + company.acquisitionFit + '/5.');
  if (company.estimatedValuation) parts.push('Est. valuation: ' + company.estimatedValuation + '.');
  if (company.services) parts.push('Core services: ' + company.services + '.');
  if (company.clients) parts.push('Key clients: ' + company.clients + '.');
  if (company.founded) parts.push('Founded: ' + company.founded + '.');
  if (company.headquarters) parts.push('HQ: ' + company.headquarters + '.');
  if (company.specialization) parts.push('Specialization: ' + company.specialization + '.');
  if (company.certifications) parts.push('Certifications: ' + company.certifications + '.');
  if (company.recentActivity) parts.push('Recent activity: ' + company.recentActivity + '.');
  if (company.strategy) parts.push('Strategy: ' + company.strategy + '.');
  // Let thin descriptions stay thin — no fabricated filler
  company.description = parts.join(' ').trim();
  return company;
}

// Helper: dynamically size text to fit within a shape
function fitTextToShape(text, maxW, maxH, baseFontPt) {
  const avgCharWidth = baseFontPt * 0.006; // inches per char
  const lineHeight = baseFontPt * 0.017; // inches per line
  const charsPerLine = Math.floor(maxW / avgCharWidth);
  const maxLines = Math.floor(maxH / lineHeight);
  const textLines = Math.ceil(text.length / charsPerLine);

  if (textLines <= maxLines) return { text, fontSize: baseFontPt };

  // Try reducing font size
  for (let fs = baseFontPt - 1; fs >= 7; fs--) {
    const cw = fs * 0.006;
    const lh = fs * 0.017;
    const cpl = Math.floor(maxW / cw);
    const ml = Math.floor(maxH / lh);
    if (Math.ceil(text.length / cpl) <= ml) return { text, fontSize: fs };
  }

  // Still doesn't fit at 7pt — return full text at 7pt, let pptxgenjs handle overflow
  // Never truncate paid-for AI content with "..."
  return { text, fontSize: 7 };
}

// Helper: calculate dynamic column widths based on content length
// Returns array of column widths in inches that sum to totalWidth
function calculateColumnWidths(data, totalWidth = 12.6, options = {}) {
  if (!data || data.length === 0) return [];

  const minColWidth = options.minColWidth || 0.8; // Minimum column width in inches
  const maxColWidth = options.maxColWidth || 6; // Maximum column width in inches
  const numCols = data[0].length;

  if (numCols === 0) return [];

  // Calculate maximum content length for each column
  const maxLengths = [];
  for (let colIdx = 0; colIdx < numCols; colIdx++) {
    let maxLen = 0;
    for (const row of data) {
      if (row[colIdx]) {
        const cellText =
          typeof row[colIdx] === 'object' ? String(row[colIdx].text || '') : String(row[colIdx]);
        maxLen = Math.max(maxLen, cellText.length);
      }
    }
    // Apply minimum length to avoid zero-width columns
    maxLengths.push(Math.max(maxLen, 5));
  }

  // Calculate total length for proportional distribution
  const totalLength = maxLengths.reduce((sum, len) => sum + len, 0);

  // Calculate proportional widths
  let widths = maxLengths.map((len) => (len / totalLength) * totalWidth);

  // Apply min/max constraints
  widths = widths.map((w) => Math.max(minColWidth, Math.min(maxColWidth, w)));

  // Normalize to ensure widths sum to totalWidth
  const currentTotal = widths.reduce((sum, w) => sum + w, 0);
  if (currentTotal > 0 && currentTotal !== totalWidth) {
    const scale = totalWidth / currentTotal;
    widths = widths.map((w) => w * scale);
  }

  return widths;
}

// Helper: create table row options with proper styling
function createTableRowOptions(isHeader = false, isAlternate = false, COLORS = {}) {
  const options = {
    fontFace: 'Segoe UI',
    fontSize: TP_FONTS.tableBody?.size || 14,
    valign: 'top',
    margin: TABLE_CELL_MARGIN,
  };

  if (isHeader) {
    options.bold = TP_FONTS.tableHeader?.bold !== undefined ? TP_FONTS.tableHeader.bold : false;
    options.fontSize = TP_FONTS.tableHeader?.size || 14;
    options.fill = { color: 'FFFFFF' };
    options.color = '000000';
  } else {
    options.color = COLORS.black || '333333';
  }

  return options;
}

// Helper: add source footnote to slide
// Uses widescreen dimensions (13.333" x 7.5" = 16:9)
// Supports hyperlinks for {url, title} source objects
function addSourceFootnote(slide, sources, COLORS, FONT) {
  if (!sources || (Array.isArray(sources) && sources.length === 0)) return;

  const fontSize = templatePatterns.style?.fonts?.source?.size || 10;
  const fontColor = COLORS?.footerText || C_MUTED;
  const hlinkColor = TP_COLORS.hlink || '0563C1';

  // Build rich text parts with hyperlinks
  if (Array.isArray(sources)) {
    const footerParts = [
      { text: 'Sources: ', options: { fontSize, fontFace: FONT, color: fontColor } },
    ];

    sources.slice(0, 3).forEach((source, idx) => {
      if (idx > 0) {
        footerParts.push({
          text: ', ',
          options: { fontSize, fontFace: FONT, color: fontColor },
        });
      }

      const sourceUrlRaw = typeof source === 'object' ? source.url : null;
      const sourceUrl = sanitizeHyperlinkUrl(sourceUrlRaw);
      const sourceTitle =
        typeof source === 'object' ? source.title || source.name || source.source : String(source);

      if (sourceUrl) {
        let displayText;
        try {
          const url = new URL(sourceUrl);
          displayText = sourceTitle || url.hostname.replace('www.', '');
        } catch {
          displayText = sourceTitle || sourceUrl.substring(0, 30);
        }
        footerParts.push({
          text: displayText,
          options: {
            fontSize,
            fontFace: FONT,
            color: hlinkColor,
            hyperlink: { url: sourceUrl },
          },
        });
      } else {
        footerParts.push({
          text: sourceTitle || String(source),
          options: { fontSize, fontFace: FONT, color: fontColor },
        });
      }
    });

    slide.addText(footerParts, {
      x: TEMPLATE.sourceBar.x,
      y: TEMPLATE.sourceBar.y,
      w: TEMPLATE.sourceBar.w,
      h: TEMPLATE.sourceBar.h || 0.27,
      valign: 'top',
    });
  } else if (typeof sources === 'string') {
    slide.addText(`Source: ${sources}`, {
      x: TEMPLATE.sourceBar.x,
      y: TEMPLATE.sourceBar.y,
      w: TEMPLATE.sourceBar.w,
      h: TEMPLATE.sourceBar.h || 0.27,
      fontSize,
      fontFace: FONT,
      color: fontColor,
      valign: 'top',
    });
  }
}

// Helper: add callout/insight box to slide (single shape to avoid overlap detection)
// Uses widescreen dimensions (13.333" x 7.5" = 16:9)
function addCalloutBox(slide, title, content, options = {}) {
  const boxX = options.x || TEMPLATE.contentArea.x; // LEFT_MARGIN for widescreen
  const boxY = options.y || 5.3;
  const boxW = options.w || TEMPLATE.contentArea.w; // CONTENT_WIDTH for widescreen
  const boxH = options.h || 1.2;
  const boxType = options.type || 'insight'; // insight, warning, recommendation
  const FONT = 'Segoe UI';

  // Box colors based on type
  const accent2 = TP_COLORS.accent2 || 'EDFDFF';
  const typeColors = {
    insight: {
      fill: C_CALLOUT_FILL,
      border: C_CALLOUT_BORDER,
      titleColor: C_DK2,
    },
    warning: { fill: C_WHITE, border: C_BORDER, titleColor: C_BLACK },
    recommendation: {
      fill: accent2,
      border: C_ACCENT1,
      titleColor: C_ACCENT1,
    },
    positive: {
      fill: accent2,
      border: C_ACCENT1,
      titleColor: C_ACCENT1,
    },
    negative: {
      fill: C_WHITE,
      border: C_DK2,
      titleColor: C_DK2,
    },
  };
  const colors = typeColors[boxType] || typeColors.insight;

  // Use single addText shape with fill+border to avoid shape overlap
  const textParts = [];
  const contentStr = String(content || '');
  if (title) {
    textParts.push({
      text: (title || '') + '\n',
      options: { fontSize: 12, bold: true, color: colors.titleColor, fontFace: FONT },
    });
  }

  // Calculate available height for content text:
  // margins = 5pt top + 5pt bottom = ~0.14 inches
  // title line = ~0.22 inches (12pt bold + newline)
  const marginInches = 0.14;
  const titleInches = title ? 0.22 : 0;
  const maxBottom = TEMPLATE.sourceBar.y;
  const availableBottom = Math.min(boxY + boxH, maxBottom);
  const totalBoxH = Math.max(0.3, availableBottom - boxY);
  const contentMaxH = Math.max(0.1, totalBoxH - marginInches - titleInches);

  if (contentStr) {
    // Fit content by shrinking font (min 7pt), never truncate to "..."
    const contentMaxW = boxW - 0.24; // 8pt left + 8pt right margins
    const finalText = contentStr;
    let finalFontSize = 11;

    // Try font sizes from 11 down to 7
    let fits = false;
    for (let fs = 11; fs >= 7; fs--) {
      const cw = fs * 0.006;
      const lh = fs * 0.017;
      const cpl = Math.max(1, Math.floor(contentMaxW / cw));
      const ml = Math.max(1, Math.floor(contentMaxH / lh));
      if (Math.ceil(contentStr.length / cpl) <= ml) {
        finalFontSize = fs;
        fits = true;
        break;
      }
    }
    if (!fits) finalFontSize = 7;

    textParts.push({
      text: finalText,
      options: { fontSize: finalFontSize, color: C_BLACK, fontFace: FONT },
    });
  }
  if (textParts.length > 0 && boxY < maxBottom) {
    slide.addText(textParts, {
      x: boxX,
      y: boxY,
      w: boxW,
      h: totalBoxH,
      fill: { color: colors.fill },
      line: {
        color: colors.border,
        pt: templatePatterns.patterns?.calloutOverlay?.borderWidth || 0.75,
      },
      margin: [5, 8, 5, 8],
      valign: 'top',
      fit: 'shrink',
    });
  }
}

// Helper: add insights panel to chart slides (right side of chart)
// Displays key insights as bullet points next to charts for YCP-quality output
function addInsightsPanel(slide, insights = [], options = {}) {
  if (!insights || insights.length === 0) return;

  // Delegate to pattern-based implementation
  const insightObjects = insights.slice(0, 4).map((insight) => ({
    title: typeof insight === 'string' ? '' : insight.title || '',
    body: typeof insight === 'string' ? insight : insight.text || insight.body || String(insight),
  }));

  addInsightPanelsFromPattern(slide, insightObjects, {
    insightPanels: [
      {
        x: options.x || 8.5,
        y: options.y || 1.3,
        w: options.w || 4.4,
        h: Math.min((options.h || 4.0) / Math.min(insights.length, 3), 1.5),
      },
      {
        x: options.x || 8.5,
        y:
          (options.y || 1.3) +
          Math.min((options.h || 4.0) / Math.min(insights.length, 3), 1.5) +
          0.1,
        w: options.w || 4.4,
        h: Math.min((options.h || 4.0) / Math.min(insights.length, 3), 1.5),
      },
      {
        x: options.x || 8.5,
        y:
          (options.y || 1.3) +
          2 * (Math.min((options.h || 4.0) / Math.min(insights.length, 3), 1.5) + 0.1),
        w: options.w || 4.4,
        h: Math.min((options.h || 4.0) / Math.min(insights.length, 3), 1.5),
      },
    ],
  });
}

// Helper: add section divider slide (Table of Contents style)
// Creates a visual break between major sections with section title
function addSectionDivider(
  pptx,
  sectionTitle,
  sectionNumber,
  totalSections,
  masterName = 'DIVIDER_NAVY'
) {
  const FONT = 'Segoe UI';
  const dividerPos = templatePatterns.patterns?.section_divider?.elements?.title || {
    x: 0.74,
    y: 2.99,
    w: 8.19,
    h: 1.51,
    fontSize: 44,
    color: 'FFFFFF',
  };

  // Use master slide for background (no manual background shape needed)
  const slide = pptx.addSlide({ masterName });

  // Section title (large, positioned from template pattern)
  slide.addText(truncate(sectionTitle, 50), {
    x: dividerPos.x,
    y: dividerPos.y,
    w: dividerPos.w,
    h: dividerPos.h,
    fontSize: dividerPos.fontSize || 44,
    bold: true,
    color: dividerPos.color || 'FFFFFF',
    fontFace: FONT,
    align: 'center',
    valign: 'middle',
  });

  // Decorative line under title (position from JSON)
  const divLine = templatePatterns.style?.dividerLine || {};
  const lineX = divLine.x || dividerPos.x;
  const lineW = divLine.w || 4.5;
  const lineThickness = divLine.thickness || 1.75;
  slide.addShape('line', {
    x: lineX,
    y: dividerPos.y + dividerPos.h + 0.2,
    w: lineW,
    h: 0,
    line: { color: dividerPos.color || 'FFFFFF', width: lineThickness },
  });

  return slide;
}

// Helper: create Opportunities & Obstacles summary slide (two-column layout)
// Uses single shapes per section to avoid overlap detection between rect+text
function addOpportunitiesObstaclesSummary(slide, opportunities = [], obstacles = [], options = {}) {
  if (!Array.isArray(opportunities)) opportunities = [];
  if (!Array.isArray(obstacles)) obstacles = [];
  const FONT = 'Segoe UI';
  const LEFT_MARGIN = options.x || TEMPLATE.contentArea.x;
  const contentY = options.y || TEMPLATE.contentArea.y;
  const colWidth = (TEMPLATE.contentArea.w - 0.5) / 2;
  const gap = 0.5;
  const COLORS = {
    green: '2E7D32',
    orange: 'E46C0A',
    white: 'FFFFFF',
    lightGreen: 'E8F5E9',
    lightOrange: 'FFF3E0',
  };

  // Left column: Opportunities
  slide.addText('Opportunities', {
    x: LEFT_MARGIN,
    y: contentY,
    w: colWidth,
    h: 0.4,
    fontSize: 13,
    bold: true,
    color: COLORS.white,
    fontFace: FONT,
    valign: 'middle',
    margin: [0, 8, 0, 8],
    fill: { color: COLORS.green },
  });

  const oppBullets = (opportunities || []).slice(0, 4).map((opp) => ({
    text: String(opp),
    options: {
      fontSize: 10,
      color: C_BLACK,
      fontFace: FONT,
      bullet: { type: 'bullet', code: '2714', color: COLORS.green },
      paraSpaceBefore: 6,
      paraSpaceAfter: 3,
    },
  }));

  const obsBullets = (obstacles || []).slice(0, 4).map((obs) => ({
    text: String(obs),
    options: {
      fontSize: 10,
      color: C_BLACK,
      fontFace: FONT,
      bullet: { type: 'bullet', code: '26A0', color: COLORS.orange },
      paraSpaceBefore: 6,
      paraSpaceAfter: 3,
    },
  }));

  const bulletH = Math.min(
    4.5,
    Math.max(0.6, Math.max(oppBullets.length, obsBullets.length, 1) * 0.4 + 0.2)
  );
  if (oppBullets.length > 0) {
    slide.addText(oppBullets, {
      x: LEFT_MARGIN,
      y: contentY + 0.5,
      w: colWidth,
      h: bulletH,
      valign: 'top',
      fill: { color: COLORS.lightGreen },
    });
  }

  // Right column: Obstacles
  const rightX = LEFT_MARGIN + colWidth + gap;
  slide.addText('Obstacles & Risks', {
    x: rightX,
    y: contentY,
    w: colWidth,
    h: 0.4,
    fontSize: 13,
    bold: true,
    color: COLORS.white,
    fontFace: FONT,
    valign: 'middle',
    margin: [0, 8, 0, 8],
    fill: { color: COLORS.orange },
  });

  if (obsBullets.length > 0) {
    slide.addText(obsBullets, {
      x: rightX,
      y: contentY + 0.5,
      w: colWidth,
      h: bulletH,
      valign: 'top',
      fill: { color: COLORS.lightOrange },
    });
  }
}

// ============ CHART GENERATION ============
// Chart palette from Escort template extraction (chartPalette.extended)
const TP_CHART = templatePatterns.chartPalette || {};
const chartSeries = templatePatterns.style?.colors?.chartSeries || [];
const extendedPalette = TP_CHART.extended || [
  '007FFF',
  '011AB7',
  'E46C0A',
  '1524A9',
  '001C44',
  'C0504D',
  '4F81BD',
  '2E7D32',
];
const CHART_COLORS =
  chartSeries.length > 0
    ? [...chartSeries, ...extendedPalette.filter((c) => !chartSeries.includes(c))]
    : extendedPalette;

const PIE_COLORS = TP_CHART.themeAccents || [
  '007FFF',
  '011AB7',
  'EDFDFF',
  '1524A9',
  '001C44',
  'E46C0A',
];

// Extended palette for more than 6 categories
const CHART_COLORS_EXTENDED = [
  ...CHART_COLORS,
  '4F81BD', // steel blue
  '2E7D32', // green
  '7B1FA2', // purple
  '00838F', // teal
];

// Semantic colors for specific meanings (opportunities, risks, etc.)
const SEMANTIC_COLORS = {
  positive: '2E7D32',
  negative: 'B71C1C',
  warning: 'E46C0A',
  neutral: '666666',
  primary: '4F81BD',
  accent: C_DK2,
};

// Helper to merge historical and projected data into unified chart format
// Input: { historical: { 2020: { coal: 40, gas: 30 }, 2021: { coal: 38, gas: 32 } },
//          projected: { 2030: { coal: 20, gas: 40 }, 2040: { coal: 10, gas: 50 } } }
// Output: { categories: ['2020', '2021', '2030', '2040'], series: [...], projectedStartIndex: 2 }
function mergeHistoricalProjected(data, options = {}) {
  if (!data) return null;

  // If data is already in unified format, return it
  if (data.categories && data.series) {
    return data;
  }

  // Handle historical/projected format
  const historical = data.historical || {};
  const projected = data.projected || {};
  const allYears = [...Object.keys(historical), ...Object.keys(projected)].sort();

  if (allYears.length === 0) return null;

  // Identify all data series (e.g., coal, gas, renewable)
  const seriesNames = new Set();
  Object.values(historical).forEach((yearData) => {
    if (typeof yearData === 'object') {
      Object.keys(yearData).forEach((k) => seriesNames.add(k));
    }
  });
  Object.values(projected).forEach((yearData) => {
    if (typeof yearData === 'object') {
      Object.keys(yearData).forEach((k) => seriesNames.add(k));
    }
  });

  if (seriesNames.size === 0) return null;

  // Build series data
  const series = [];
  seriesNames.forEach((seriesName) => {
    const values = allYears.map((year) => {
      const yearData = historical[year] || projected[year] || {};
      return typeof yearData === 'object' ? yearData[seriesName] || 0 : 0;
    });
    series.push({ name: seriesName, values });
  });

  // Find where projections start
  const projectedStartIndex = Object.keys(historical).length;

  return {
    categories: allYears,
    series,
    projectedStartIndex, // For visual differentiation
    unit: data.unit || options.unit || '',
  };
}

// Add a stacked bar chart to a slide
// data format: { categories: ['2020', '2021', '2022'], series: [{ name: 'Coal', values: [40, 38, 35] }, { name: 'Gas', values: [30, 32, 35] }] }
// Also supports: { historical: {...}, projected: {...} } format which gets auto-converted
function addStackedBarChart(slide, title, data, options = {}) {
  // Try to convert historical/projected format
  let chartData = data;
  if (data && (data.historical || data.projected) && !data.categories) {
    chartData = mergeHistoricalProjected(data);
  }

  if (!chartData || !chartData.categories || !chartData.series || chartData.series.length === 0) {
    console.warn('[PPT] Chart skipped - invalid data:', JSON.stringify(data).substring(0, 200));
    slide.addText('Chart data unavailable', {
      x: options.x || TEMPLATE.contentArea.x,
      y: options.y || TEMPLATE.contentArea.y,
      w: options.w || TEMPLATE.contentArea.w,
      h: options.h || TEMPLATE.contentArea.h,
      fontSize: 14,
      color: C_MUTED,
      fontFace: 'Segoe UI',
      align: 'center',
      valign: 'middle',
    });
    return;
  }

  // Validate series values are all numbers
  const hasInvalidValues = chartData.series.some(
    (s) => s.values && s.values.some((v) => typeof v !== 'number' || !isFinite(v))
  );
  if (hasInvalidValues) {
    console.warn('[PPT] Chart skipped - invalid data:', JSON.stringify(data).substring(0, 200));
    slide.addText('Chart data unavailable', {
      x: options.x || TEMPLATE.contentArea.x,
      y: options.y || TEMPLATE.contentArea.y,
      w: options.w || TEMPLATE.contentArea.w,
      h: options.h || TEMPLATE.contentArea.h,
      fontSize: 14,
      color: C_MUTED,
      fontFace: 'Segoe UI',
      align: 'center',
      valign: 'middle',
    });
    return;
  }

  // Downsample if too many categories (max 12)
  if (chartData.categories.length > 12) {
    const step = Math.ceil(chartData.categories.length / 12);
    const indices = [];
    for (let i = 0; i < chartData.categories.length; i += step) indices.push(i);
    if (indices[indices.length - 1] !== chartData.categories.length - 1) {
      indices.push(chartData.categories.length - 1);
    }
    chartData = {
      ...chartData,
      categories: indices.map((i) => chartData.categories[i]),
      series: chartData.series.map((s) => ({
        ...s,
        values: indices.map((i) => s.values[i]),
      })),
    };
  }

  // Add visual indicator for projected data in title if applicable
  const hasProjections =
    chartData.projectedStartIndex && chartData.projectedStartIndex < chartData.categories.length;
  const chartTitle =
    hasProjections && !title.includes('Projected') ? `${title} (includes projections)` : title;
  const safeCategories = (chartData.categories || []).map((c) => ensureString(c));
  const safeChartTitle = ensureString(chartTitle);

  const pptxChartData = chartData.series.map((s, idx) => ({
    name: ensureString(s.name),
    labels: safeCategories,
    values: (s.values || []).map((v) =>
      typeof v === 'number' && isFinite(v) ? v : Number(v) || 0
    ),
    color: CHART_COLORS[idx % CHART_COLORS.length],
  }));

  slide.addChart('bar', pptxChartData, {
    x: options.x || TEMPLATE.contentArea.x,
    y: options.y || TEMPLATE.contentArea.y,
    w: options.w || TEMPLATE.contentArea.w,
    h: options.h || TEMPLATE.contentArea.h,
    barDir: options.barDir || 'col',
    barGrouping: 'stacked',
    barGapWidthPct: 50,
    barOverlapPct: 100,
    showLegend: true,
    legendPos: 'b',
    showTitle: !!safeChartTitle,
    title: safeChartTitle,
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    ...CHART_AXIS_DEFAULTS,
    catAxisLabelFontFace: 'Segoe UI',
    catAxisLabelFontSize: 12,
    valAxisLabelFontFace: 'Segoe UI',
    valAxisLabelFontSize: 12,
    showValue: true,
    dataLabelFontFace: 'Segoe UI',
    dataLabelFontSize: 10,
    dataLabelColor: C_WHITE,
    dataLabelPosition: 'ctr',
  });
}

// Add a line chart to a slide
// data format: { categories: ['2020', '2021', '2022'], series: [{ name: 'Price', values: [10, 12, 14] }] }
// Also supports: { historical: {...}, projected: {...} } format which gets auto-converted
function addLineChart(slide, title, data, options = {}) {
  // Try to convert historical/projected format
  let chartData = data;
  if (data && (data.historical || data.projected) && !data.categories) {
    chartData = mergeHistoricalProjected(data);
  }

  if (!chartData || !chartData.categories || !chartData.series || chartData.series.length === 0) {
    console.warn('[PPT] Chart skipped - invalid data:', JSON.stringify(data).substring(0, 200));
    slide.addText('Chart data unavailable', {
      x: options.x || TEMPLATE.contentArea.x,
      y: options.y || TEMPLATE.contentArea.y,
      w: options.w || TEMPLATE.contentArea.w,
      h: options.h || TEMPLATE.contentArea.h,
      fontSize: 14,
      color: C_MUTED,
      fontFace: 'Segoe UI',
      align: 'center',
      valign: 'middle',
    });
    return;
  }

  // Validate series values are all numbers
  const hasInvalidValues = chartData.series.some(
    (s) => s.values && s.values.some((v) => typeof v !== 'number' || !isFinite(v))
  );
  if (hasInvalidValues) {
    console.warn('[PPT] Chart skipped - invalid data:', JSON.stringify(data).substring(0, 200));
    slide.addText('Chart data unavailable', {
      x: options.x || TEMPLATE.contentArea.x,
      y: options.y || TEMPLATE.contentArea.y,
      w: options.w || TEMPLATE.contentArea.w,
      h: options.h || TEMPLATE.contentArea.h,
      fontSize: 14,
      color: C_MUTED,
      fontFace: 'Segoe UI',
      align: 'center',
      valign: 'middle',
    });
    return;
  }

  // Downsample if too many categories (max 12)
  if (chartData.categories.length > 12) {
    const step = Math.ceil(chartData.categories.length / 12);
    const indices = [];
    for (let i = 0; i < chartData.categories.length; i += step) indices.push(i);
    if (indices[indices.length - 1] !== chartData.categories.length - 1) {
      indices.push(chartData.categories.length - 1);
    }
    chartData = {
      ...chartData,
      categories: indices.map((i) => chartData.categories[i]),
      series: chartData.series.map((s) => ({
        ...s,
        values: indices.map((i) => s.values[i]),
      })),
    };
  }

  // Add visual indicator for projected data in title if applicable
  const hasProjections =
    chartData.projectedStartIndex && chartData.projectedStartIndex < chartData.categories.length;
  const chartTitle =
    hasProjections && !title.includes('Projected') ? `${title} (includes projections)` : title;
  const safeCategories = (chartData.categories || []).map((c) => ensureString(c));
  const safeChartTitle = ensureString(chartTitle);

  const pptxChartData = chartData.series.map((s, idx) => ({
    name: ensureString(s.name),
    labels: safeCategories,
    values: (s.values || []).map((v) =>
      typeof v === 'number' && isFinite(v) ? v : Number(v) || 0
    ),
    color: CHART_COLORS[idx % CHART_COLORS.length],
  }));

  slide.addChart('line', pptxChartData, {
    x: options.x || TEMPLATE.contentArea.x,
    y: options.y || TEMPLATE.contentArea.y,
    w: options.w || TEMPLATE.contentArea.w,
    h: options.h || TEMPLATE.contentArea.h,
    showLegend: chartData.series.length > 1,
    legendPos: 'b',
    showTitle: !!safeChartTitle,
    title: safeChartTitle,
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    ...CHART_AXIS_DEFAULTS,
    catAxisLabelFontFace: 'Segoe UI',
    catAxisLabelFontSize: 12,
    valAxisLabelFontFace: 'Segoe UI',
    valAxisLabelFontSize: 12,
    lineDataSymbol: 'circle',
    lineDataSymbolSize: 6,
    lineWidth: 2,
    showValue: options.showValues !== undefined ? options.showValues : true,
    dataLabelFontFace: 'Segoe UI',
    dataLabelFontSize: 10,
    dataLabelPosition: 't',
  });
}

// Add a bar chart (horizontal or vertical) to a slide
function addBarChart(slide, title, data, options = {}) {
  // Convert series format to values format if needed (synthesis returns series, bar chart needs values)
  if (data && data.series && data.series.length > 0 && !data.values) {
    data = { ...data, values: data.series[0].values || [] };
  }
  if (!data || !data.categories || !data.values || data.values.length === 0) {
    console.warn('[PPT] Chart skipped - invalid data:', JSON.stringify(data).substring(0, 200));
    slide.addText('Chart data unavailable', {
      x: options.x || TEMPLATE.contentArea.x,
      y: options.y || TEMPLATE.contentArea.y,
      w: options.w || TEMPLATE.contentArea.w,
      h: options.h || TEMPLATE.contentArea.h,
      fontSize: 14,
      color: C_MUTED,
      fontFace: 'Segoe UI',
      align: 'center',
      valign: 'middle',
    });
    return;
  }

  // Validate values are all numbers
  if (data.values.some((v) => typeof v !== 'number' || !isFinite(v))) {
    console.warn('[PPT] Chart skipped - invalid data:', JSON.stringify(data).substring(0, 200));
    slide.addText('Chart data unavailable', {
      x: options.x || TEMPLATE.contentArea.x,
      y: options.y || TEMPLATE.contentArea.y,
      w: options.w || TEMPLATE.contentArea.w,
      h: options.h || TEMPLATE.contentArea.h,
      fontSize: 14,
      color: C_MUTED,
      fontFace: 'Segoe UI',
      align: 'center',
      valign: 'middle',
    });
    return;
  }

  const chartData = [
    {
      name: ensureString(data.name || 'Value'),
      labels: (data.categories || []).map((c) => ensureString(c)),
      values: (data.values || []).map((v) =>
        typeof v === 'number' && isFinite(v) ? v : Number(v) || 0
      ),
      color: CHART_COLORS[0],
    },
  ];

  slide.addChart('bar', chartData, {
    x: options.x || TEMPLATE.contentArea.x,
    y: options.y || TEMPLATE.contentArea.y,
    w: options.w || TEMPLATE.contentArea.w,
    h: options.h || TEMPLATE.contentArea.h,
    barDir: options.horizontal ? 'bar' : 'col',
    showLegend: false,
    showTitle: !!title,
    title: ensureString(title),
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    ...CHART_AXIS_DEFAULTS,
    catAxisLabelFontFace: 'Segoe UI',
    catAxisLabelFontSize: 12,
    valAxisLabelFontFace: 'Segoe UI',
    valAxisLabelFontSize: 12,
    showValue: true,
    dataLabelFontFace: 'Segoe UI',
    dataLabelFontSize: 10,
  });
}

// Add a pie/doughnut chart to a slide
function addPieChart(slide, title, data, options = {}) {
  // Convert series format to values format if needed (synthesis returns series, pie chart needs values)
  if (data && data.series && data.series.length > 0 && !data.values) {
    data = { ...data, values: data.series[0].values || [] };
  }
  if (!data || !data.categories || !data.values || data.values.length === 0) {
    console.warn('[PPT] Chart skipped - invalid data:', JSON.stringify(data).substring(0, 200));
    slide.addText('Chart data unavailable', {
      x: options.x || TEMPLATE.contentArea.x,
      y: options.y || TEMPLATE.contentArea.y,
      w: options.w || TEMPLATE.contentArea.w,
      h: options.h || 5.2,
      fontSize: 14,
      color: C_MUTED,
      fontFace: 'Segoe UI',
      align: 'center',
      valign: 'middle',
    });
    return;
  }

  // Validate values are all numbers
  if (data.values.some((v) => typeof v !== 'number' || !isFinite(v))) {
    console.warn('[PPT] Chart skipped - invalid data:', JSON.stringify(data).substring(0, 200));
    slide.addText('Chart data unavailable', {
      x: options.x || TEMPLATE.contentArea.x,
      y: options.y || TEMPLATE.contentArea.y,
      w: options.w || TEMPLATE.contentArea.w,
      h: options.h || 5.2,
      fontSize: 14,
      color: C_MUTED,
      fontFace: 'Segoe UI',
      align: 'center',
      valign: 'middle',
    });
    return;
  }

  // Use PIE_COLORS as base, extend with CHART_COLORS for more categories
  const pieColors =
    data.categories.length <= PIE_COLORS.length
      ? PIE_COLORS.slice(0, data.categories.length)
      : [...PIE_COLORS, ...CHART_COLORS].slice(0, data.categories.length);

  const chartData = [
    {
      name: ensureString(data.name || 'Share'),
      labels: (data.categories || []).map((c) => ensureString(c)),
      values: (data.values || []).map((v) =>
        typeof v === 'number' && isFinite(v) ? v : Number(v) || 0
      ),
    },
  ];

  slide.addChart(options.doughnut ? 'doughnut' : 'pie', chartData, {
    x: options.x || TEMPLATE.contentArea.x,
    y: options.y || TEMPLATE.contentArea.y,
    w: options.w || TEMPLATE.contentArea.w,
    h: options.h || TEMPLATE.contentArea.h,
    showLegend: true,
    legendPos: 'r',
    showTitle: !!title,
    title: ensureString(title),
    titleFontFace: 'Segoe UI',
    titleFontSize: 14,
    titleColor: C_TRUE_BLACK,
    showPercent: true,
    chartColors: pieColors,
  });
}

// ============ STORY ARCHITECT ============
// Transforms raw research data into a narrative with key insights
// Returns a universal slide structure based on the story, not hardcoded slides
async function buildStoryNarrative(countryAnalysis, scope) {
  console.log('\n  [STORY ARCHITECT] Building narrative from research...');

  const systemPrompt = `You are a senior partner at McKinsey preparing a board presentation. Your job is to transform raw research into a compelling narrative that drives a decision.

=== STORYTELLING PRINCIPLES ===
1. LEAD WITH THE VERDICT: Executives want the answer first, then the reasoning.
2. EVERY SLIDE = ONE INSIGHT: Not "here's information about X" but "here's what X means for you"
3. CONNECT THE DOTS: Each slide should logically lead to the next
4. CUT RUTHLESSLY: If a fact doesn't support the decision, delete it. 8 great slides beat 25 mediocre ones.
5. QUANTIFY EVERYTHING: "Big market" → "$1.5B market growing 12% annually"

=== ASSERTIVE SLIDE TITLES (CRITICAL) ===
Generate conclusion-driven titles that tell the story, NOT descriptive labels.
BAD (descriptive): "Thailand - Market Size", "Vietnam - Energy Policy"
GOOD (assertive): "$50 billion total market, $5 billion addressable for client", "Electricity liberalization creates 18-month JV window"
Each title should be a conclusion the reader can act on, not a topic they need to read about.

=== INSIGHT QUALITY ===
BAD (information): "Thailand requires 50% local content for energy services"
GOOD (insight): "The 50% local content rule means you can't compete on cost alone—local partnerships aren't optional, they're your competitive moat"

BAD (list): "Key players include Schlumberger, Halliburton, Baker Hughes"
GOOD (insight): "The Big 3 dominate offshore, but none have cracked the industrial efficiency market—a $200M segment growing 15% annually"

=== SLIDE TYPES TO USE ===
1. VERDICT: Go/No-Go with conditions (always first after title)
2. OPPORTUNITY: Market size, growth, timing window
3. BARRIER: What makes this hard (regulatory, competitive, operational)
4. COMPETITIVE_LANDSCAPE: Who's winning, who's losing, white spaces
5. ENTRY_PATH: How to get in (JV, acquisition, greenfield)
6. ECONOMICS: Deal sizes, margins, investment required
7. RISKS: Top 3-5 risks with mitigations
8. ACTION: Specific next steps with timeline

Return 8-12 slides maximum. Quality over quantity.`;

  const prompt = `RESEARCH DATA:
${JSON.stringify(countryAnalysis, null, 2)}

CLIENT CONTEXT:
- Industry: ${scope.industry}
- Project Type: ${scope.projectType}
- Client: ${scope.clientContext || 'Not specified'}
- Target Market: ${scope.targetMarkets?.join(', ') || countryAnalysis.country}

Transform this research into a narrative. Return JSON:

{
  "storyHook": "One sentence that frames the entire presentation (e.g., 'The 2025 deadline changes everything')",

  "verdict": {
    "decision": "GO" | "CONDITIONAL_GO" | "NO_GO",
    "confidence": "HIGH" | "MEDIUM" | "LOW",
    "conditions": ["condition 1", "condition 2"],
    "oneLiner": "One sentence summary of recommendation"
  },

  "slides": [
    {
      "type": "VERDICT" | "OPPORTUNITY" | "BARRIER" | "COMPETITIVE_LANDSCAPE" | "ENTRY_PATH" | "ECONOMICS" | "RISKS" | "ACTION",
      "title": "ASSERTIVE title that states a conclusion (e.g. '$50B market, $5B addressable' NOT 'Market Size')",
      "insight": "The 'so what' - one sentence that makes this slide matter",
      "content": {
        // Type-specific content structure
        // For VERDICT: { decision, conditions, ratings: {attractiveness, feasibility} }
        // For OPPORTUNITY: { marketSize, growth, timingWindow, keyDrivers }
        // For BARRIER: { barriers: [{name, severity, mitigation}] }
        // For COMPETITIVE_LANDSCAPE: { leaders: [{name, strength, weakness}], whiteSpaces }
        // For ENTRY_PATH: { options: [{name, timeline, investment, pros, cons}], recommended }
        // For ECONOMICS: { dealSize, margins, investment, breakeven }
        // For RISKS: { risks: [{name, severity, likelihood, mitigation}] }
        // For ACTION: { steps: [{action, owner, timeline}] }
      },
      "sources": ["source URLs or names relevant to this slide"]
    }
  ],

  "aggregatedSources": [
    {"url": "actual URL", "title": "source name"}
  ]
}`;

  try {
    let response;
    try {
      const geminiResult = await callGemini(prompt, {
        temperature: 0.3,
        maxTokens: 8192,
        systemPrompt,
      });
      const content = typeof geminiResult === 'string' ? geminiResult : geminiResult.content || '';
      response = { content };
    } catch (e) {
      console.warn('Gemini failed for story architect, falling back to Gemini Pro:', e.message);
      const proResult = await callGeminiPro(prompt, { systemPrompt, maxTokens: 8192 });
      response = { content: typeof proResult === 'string' ? proResult : proResult.content || '' };
    }

    // Parse response
    let story;
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        story = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('  [STORY ARCHITECT] Failed to parse response:', parseError.message);
      // Return minimal default structure
      return {
        storyHook: `${countryAnalysis.country} Market Entry Analysis`,
        verdict: {
          decision: 'CONDITIONAL_GO',
          confidence: 'MEDIUM',
          conditions: ['Further analysis required'],
          oneLiner: 'Proceed with caution',
        },
        slides: [],
        aggregatedSources: [],
      };
    }

    console.log(`  [STORY ARCHITECT] Generated ${story.slides?.length || 0} slides with narrative`);
    return story;
  } catch (error) {
    console.error('  [STORY ARCHITECT] Error:', error.message);
    return {
      storyHook: `${countryAnalysis.country} Market Entry Analysis`,
      verdict: { decision: 'CONDITIONAL_GO', confidence: 'LOW', conditions: [], oneLiner: '' },
      slides: [],
      aggregatedSources: [],
    };
  }
}

// Helper: calculate safe table height based on row count to prevent overlap
// Uses generous row heights to account for text wrapping in cells
function safeTableHeight(rowCount, opts = {}) {
  const { fontSize = 11, maxH = 5.0 } = opts;
  // Increase row height estimates to prevent tables from auto-expanding past declared h
  const rowH = fontSize <= 9 ? 0.4 : fontSize >= 12 ? 0.5 : 0.45;
  return Math.max(0.6, Math.min(rowH * rowCount + 0.2, maxH));
}

// ============ SMART LAYOUT PATTERN FUNCTIONS ============

/**
 * Pattern selection: classify data type and choose the best layout pattern
 */
function choosePattern(dataType, data) {
  switch (dataType) {
    case 'time_series_multi_insight':
      return 'chart_insight_panels';
    case 'time_series_annotated':
      return 'chart_with_grid';
    case 'two_related_series':
      return 'chart_callout_dual';
    case 'time_series_simple':
      return 'chart_with_grid';
    case 'composition_breakdown':
      return 'chart_with_grid';
    case 'company_comparison':
      return 'company_comparison';
    case 'regulation_list':
      return 'regulatory_table';
    case 'policy_analysis':
      return 'regulatory_table';
    case 'case_study':
      return 'case_study_rows';
    case 'financial_performance':
      return 'dual_chart_financial';
    case 'opportunities_vs_barriers':
      return 'regulatory_table';
    case 'section_summary':
      return 'regulatory_table';
    case 'definitions':
      return 'glossary';
    default:
      // Auto-detect from data shape
      if (data?.chartData?.series && data.chartData.series.length >= 2) return 'chart_callout_dual';
      if (data?.chartData?.series) return 'chart_with_grid';
      if (data?.chartData?.values) return 'chart_with_grid';
      if (data?.players || data?.companies) return 'company_comparison';
      if (data?.rows || data?.acts || data?.regulations) return 'regulatory_table';
      return 'regulatory_table';
  }
}

// Deterministic block -> template pattern mapping so styling stays close to Escort source slides.
const BLOCK_TEMPLATE_PATTERN_MAP = Object.freeze({
  foundationalActs: 'regulatory_table',
  nationalPolicy: 'regulatory_table',
  investmentRestrictions: 'regulatory_table',
  keyIncentives: 'regulatory_table',
  regulatorySummary: 'regulatory_table',
  tpes: 'chart_insight_panels',
  finalDemand: 'chart_insight_panels',
  electricity: 'chart_insight_panels',
  gasLng: 'chart_with_grid',
  pricing: 'chart_insight_panels',
  escoMarket: 'chart_insight_panels',
  japanesePlayers: 'company_comparison',
  localMajor: 'company_comparison',
  foreignPlayers: 'company_comparison',
  caseStudy: 'case_study_rows',
  maActivity: 'company_comparison',
  dealEconomics: 'dual_chart_financial',
  partnerAssessment: 'company_comparison',
  entryStrategy: 'regulatory_table',
  implementation: 'case_study_rows',
  targetSegments: 'company_comparison',
  goNoGo: 'regulatory_table',
  opportunitiesObstacles: 'regulatory_table',
  keyInsights: 'regulatory_table',
  timingIntelligence: 'regulatory_table',
  lessonsLearned: 'regulatory_table',
});

// Deterministic block -> template slide mapping (pixel-exact source slide from Escort repository).
// This is intentionally explicit so each generated block can inherit geometry from a known template slide.
const BLOCK_TEMPLATE_SLIDE_MAP = Object.freeze({
  foundationalActs: 7,
  nationalPolicy: 8,
  investmentRestrictions: 9,
  keyIncentives: 10,
  regulatorySummary: 6,
  tpes: 13,
  finalDemand: 14,
  electricity: 15,
  gasLng: 17,
  pricing: 16,
  escoMarket: 18,
  japanesePlayers: 22,
  localMajor: 22,
  foreignPlayers: 22,
  caseStudy: 23,
  maActivity: 24,
  dealEconomics: 26,
  partnerAssessment: 22,
  entryStrategy: 12,
  implementation: 28,
  targetSegments: 22,
  goNoGo: 12,
  opportunitiesObstacles: 12,
  keyInsights: 12,
  timingIntelligence: 12,
  lessonsLearned: 12,
});

function getPatternKeyForSlideId(slideId) {
  if (!Number.isFinite(Number(slideId))) return null;
  const numericId = Number(slideId);
  const patterns = templatePatterns.patterns || {};
  for (const [patternKey, patternDef] of Object.entries(patterns)) {
    if (
      Array.isArray(patternDef?.templateSlides) &&
      patternDef.templateSlides.includes(numericId)
    ) {
      return patternKey;
    }
  }
  return null;
}

function getTemplateSlideDetail(slideNumber) {
  const numeric = Number(slideNumber);
  if (!Number.isFinite(numeric)) return null;
  return (
    (templatePatterns.slideDetails || []).find((s) => Number(s?.slideNumber) === numeric) || null
  );
}

function _isValidPos(pos) {
  return (
    pos &&
    Number.isFinite(pos.x) &&
    Number.isFinite(pos.y) &&
    Number.isFinite(pos.w) &&
    Number.isFinite(pos.h)
  );
}

function _rectFromPos(pos) {
  return { x: pos.x, y: pos.y, w: pos.w, h: pos.h };
}

function _rectArea(r) {
  if (!_isValidPos(r)) return 0;
  return Math.max(0, r.w) * Math.max(0, r.h);
}

function _getTextHint(el) {
  const paragraphs = el?.textBody?.paragraphs;
  if (!Array.isArray(paragraphs)) return '';
  const parts = [];
  for (const p of paragraphs) {
    const runs = Array.isArray(p?.runs) ? p.runs : [];
    for (const run of runs) {
      if (run?.textHint) parts.push(String(run.textHint));
    }
  }
  return parts.join(' ').trim();
}

function _computeBounds(rects, fallbackRect, sourceYLimit) {
  if (!Array.isArray(rects) || rects.length === 0) {
    return { ...fallbackRect };
  }
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxRight = Math.max(...rects.map((r) => r.x + r.w));
  const maxBottom = Math.max(...rects.map((r) => r.y + r.h));
  const limitedBottom = Number.isFinite(sourceYLimit)
    ? Math.min(maxBottom, sourceYLimit)
    : maxBottom;
  return {
    x: minX,
    y: minY,
    w: Math.max(0.1, maxRight - minX),
    h: Math.max(0.1, limitedBottom - minY),
  };
}

const _templateSlideLayoutCache = new Map();

function getTemplateSlideLayout(slideNumber) {
  const numeric = Number(slideNumber);
  if (!Number.isFinite(numeric)) return null;
  if (_templateSlideLayoutCache.has(numeric)) return _templateSlideLayoutCache.get(numeric);

  const slide = getTemplateSlideDetail(numeric);
  if (!slide) {
    _templateSlideLayoutCache.set(numeric, null);
    return null;
  }

  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  const shapes = elements.filter((e) => e?.type === 'shape' && _isValidPos(e?.position));
  const tables = elements
    .filter((e) => e?.type === 'table' && _isValidPos(e?.position))
    .map((e) => _rectFromPos(e.position));
  const charts = elements
    .filter((e) => e?.type === 'chart' && _isValidPos(e?.position))
    .map((e) => _rectFromPos(e.position))
    .filter((r) => r.w > 0.2 && r.h > 0.2)
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const titleShape = shapes
    .filter((s) => /^title/i.test(String(s?.name || '')) && s.position.y < 1.3)
    .sort((a, b) => a.position.y - b.position.y)[0];
  const title = titleShape ? _rectFromPos(titleShape.position) : { ...TEMPLATE.title };

  const sourceShape = shapes
    .map((s) => ({ s, hint: _getTextHint(s).toLowerCase() }))
    .filter(
      ({ s, hint }) =>
        s.position.y >= 6.2 &&
        (hint.includes('source') || hint.includes('note') || /^textbox/i.test(String(s.name || '')))
    )
    .sort((a, b) => a.s.position.y - b.s.position.y)[0]?.s;
  const source = sourceShape ? _rectFromPos(sourceShape.position) : { ...TEMPLATE.sourceBar };

  const callouts = shapes
    .map((s) => ({ s, hint: _getTextHint(s) }))
    .filter(({ s, hint }) => {
      const nm = String(s.name || '').toLowerCase();
      return (
        s.position.y > 1.2 &&
        s.position.y < 6.6 &&
        s.position.w > 0.8 &&
        s.position.h > 0.25 &&
        hint.length > 2 &&
        (nm.includes('speech bubble') ||
          nm.includes('autoshape') ||
          nm.includes('rectangle') ||
          nm.includes('oval'))
      );
    })
    .map(({ s }) => _rectFromPos(s.position))
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  const largestTable = tables.slice().sort((a, b) => _rectArea(b) - _rectArea(a))[0] || null;

  const contentCandidates = [];
  if (largestTable) contentCandidates.push(largestTable);
  contentCandidates.push(...charts);
  contentCandidates.push(...callouts);

  if (contentCandidates.length === 0) {
    const largeShapes = shapes
      .map((s) => ({
        rect: _rectFromPos(s.position),
        hint: _getTextHint(s),
        name: String(s.name || ''),
      }))
      .filter(({ rect, hint, name }) => {
        const lname = name.toLowerCase();
        if (/^title/i.test(name)) return false;
        if (lname.includes('columnheader')) return false;
        if (rect.y < 1.2 || rect.y > 6.6) return false;
        return rect.w > 2.0 && rect.h > 0.3 && hint.length > 2;
      })
      .map((x) => x.rect);
    contentCandidates.push(...largeShapes);
  }

  const content = _computeBounds(
    contentCandidates,
    TEMPLATE.contentArea,
    source?.y || TEMPLATE.sourceBar.y
  );

  const layout = {
    slideNumber: numeric,
    title,
    source,
    content,
    table: largestTable,
    charts,
    callouts,
  };
  _templateSlideLayoutCache.set(numeric, layout);
  return layout;
}

/**
 * Resolve a template pattern deterministically with optional user override:
 * - override by slide id (preferred for "pick from template repository")
 * - override by pattern key
 * - default mapping by block key
 * - fallback by data type inference
 */
function resolveTemplatePattern({ blockKey, dataType, data, templateSelection } = {}) {
  const patterns = templatePatterns.patterns || {};
  const defaultPattern = BLOCK_TEMPLATE_PATTERN_MAP[blockKey] || choosePattern(dataType, data);
  let patternKey = defaultPattern;
  let source = BLOCK_TEMPLATE_PATTERN_MAP[blockKey] ? 'block-default' : 'dataType-fallback';
  let selectedSlide = null;

  let overridePattern = null;
  let overrideSlide = null;
  if (templateSelection && typeof templateSelection === 'object') {
    overridePattern = templateSelection.pattern || null;
    overrideSlide = templateSelection.slide ?? null;
  } else if (Number.isFinite(Number(templateSelection))) {
    overrideSlide = Number(templateSelection);
  } else if (typeof templateSelection === 'string' && templateSelection.trim()) {
    const trimmed = templateSelection.trim();
    if (Number.isFinite(Number(trimmed))) overrideSlide = Number(trimmed);
    else overridePattern = trimmed;
  }

  if (overridePattern && patterns[overridePattern]) {
    patternKey = overridePattern;
    source = 'override-pattern';
  }

  if (overrideSlide != null) {
    const fromSlide = getPatternKeyForSlideId(overrideSlide);
    if (fromSlide) {
      patternKey = fromSlide;
      selectedSlide = Number(overrideSlide);
      source = 'override-slide';
    }
  }

  if (!patterns[patternKey]) {
    patternKey = defaultPattern;
    source = 'fallback';
  }

  let patternDef = patterns[patternKey] || null;
  let templateSlides = Array.isArray(patternDef?.templateSlides) ? patternDef.templateSlides : [];
  let isTemplateBacked = templateSlides.length > 0;

  // If override landed on a non-template custom pattern, pull back to a template-backed default.
  if (!isTemplateBacked && patternKey !== defaultPattern) {
    const defaultDef = patterns[defaultPattern];
    const defaultSlides = Array.isArray(defaultDef?.templateSlides)
      ? defaultDef.templateSlides
      : [];
    if (defaultDef && defaultSlides.length > 0) {
      patternKey = defaultPattern;
      patternDef = defaultDef;
      templateSlides = defaultSlides;
      isTemplateBacked = true;
      source = `${source}-nonTemplateFallback`;
    }
  }

  if (selectedSlide == null && templateSlides.length > 0) {
    const mappedSlide = BLOCK_TEMPLATE_SLIDE_MAP[blockKey];
    if (Number.isFinite(Number(mappedSlide)) && templateSlides.includes(Number(mappedSlide))) {
      selectedSlide = Number(mappedSlide);
      source = source === 'block-default' ? 'block-default-slide' : `${source}-blockSlide`;
    } else {
      selectedSlide = templateSlides[0];
    }
  }

  return {
    patternKey,
    patternDef,
    templateSlides,
    selectedSlide,
    isTemplateBacked,
    source,
  };
}

/**
 * Add dual charts side by side (Pattern 8A, 10)
 */
function addDualChart(slide, leftData, rightData, patternDef, opts = {}) {
  const p = patternDef || templatePatterns.patterns?.chart_callout_dual?.elements || {};
  const leftPos = p.chartLeft || {
    x: TEMPLATE.contentArea.x,
    y: TEMPLATE.contentArea.y,
    w: TEMPLATE.contentArea.w / 2 - 0.15,
    h: 4.2,
  };
  const rightPos = p.chartRight || {
    x: TEMPLATE.contentArea.x + TEMPLATE.contentArea.w / 2 + 0.15,
    y: TEMPLATE.contentArea.y,
    w: TEMPLATE.contentArea.w / 2 - 0.15,
    h: 4.2,
  };
  const style = templatePatterns.style || {};
  const colors = style.colors || {};

  // Left chart
  if (leftData.chartData) {
    const chartType = leftData.type || (leftData.chartData.series ? 'bar' : 'pie');
    if (chartType === 'bar' && leftData.chartData.series) {
      addStackedBarChart(slide, leftData.title || '', leftData.chartData, leftPos);
    } else if (chartType === 'line' && leftData.chartData.series) {
      addLineChart(slide, leftData.title || '', leftData.chartData, leftPos);
    } else if (leftData.chartData.values) {
      addPieChart(slide, leftData.title || '', leftData.chartData, leftPos);
    }
  }

  // Right chart
  if (rightData.chartData) {
    const chartType = rightData.type || (rightData.chartData.series ? 'bar' : 'pie');
    if (chartType === 'bar' && rightData.chartData.series) {
      addStackedBarChart(slide, rightData.title || '', rightData.chartData, rightPos);
    } else if (chartType === 'line' && rightData.chartData.series) {
      addLineChart(slide, rightData.title || '', rightData.chartData, rightPos);
    } else if (rightData.chartData.values) {
      addPieChart(slide, rightData.title || '', rightData.chartData, rightPos);
    }
  }

  // Bottom callout
  if (opts.callout) {
    const calloutPos = p.quoteCallout || {
      x: TEMPLATE.contentArea.x,
      y: 5.7,
      w: TEMPLATE.contentArea.w,
      h: 0.8,
    };
    addCalloutBox(slide, opts.callout.title || 'Key Insight', opts.callout.text || '', {
      x: calloutPos.x,
      y: calloutPos.y,
      w: calloutPos.w,
      h: calloutPos.h,
      type: 'insight',
    });
  }
}

/**
 * Add chevron process flow (Pattern 9A, 9B)
 */
function addChevronFlow(slide, phases, patternDef, opts = {}) {
  const p = patternDef || templatePatterns.patterns?.case_study_rows?.elements?.chevronFlow || {};
  const baseX = p.x || 2.5;
  const baseY = opts.y || p.y || 4.1;
  const totalW = p.w || 10.4;
  const h = p.h || 1.1;
  const maxPhases = p.maxPhases || 5;
  const colors = p.chevronColors || ['007FFF', '2E7D32', 'E46C0A', '4F81BD', 'C0504D'];
  const spacing = p.spacing || 0.05;

  const count = Math.min(phases.length, maxPhases);
  const chevronW = (totalW - spacing * (count - 1)) / count;

  const chevronShape = p.shape || 'homePlate';

  phases.slice(0, count).forEach((phase, idx) => {
    const x = baseX + idx * (chevronW + spacing);
    slide.addShape(chevronShape, {
      x,
      y: baseY,
      w: chevronW,
      h,
      fill: { color: colors[idx % colors.length] },
    });
    slide.addText(typeof phase === 'string' ? phase : phase.name || phase.label || '', {
      x: x + 0.1,
      y: baseY + 0.1,
      w: chevronW - 0.2,
      h: h - 0.2,
      fontSize: p.fontSize || 8,
      color: p.textColor || 'FFFFFF',
      fontFace: 'Segoe UI',
      align: 'center',
      valign: 'middle',
    });
  });
}

/**
 * Add insight panels with blue bar (Pattern 7A, 7B)
 */
function addInsightPanelsFromPattern(slide, insights, patternDef) {
  const p = patternDef || templatePatterns.patterns?.chart_insight_panels?.elements || {};
  const panelDefs = p.insightPanels || [
    { x: 8.5, y: TEMPLATE.contentArea.y, w: 4.4, h: 1.5 },
    { x: 8.5, y: TEMPLATE.contentArea.y + 1.5, w: 4.4, h: 1.5 },
    { x: 8.5, y: TEMPLATE.contentArea.y + 3.2, w: 4.4, h: 1.5 },
  ];
  const barColor = C_DK2;

  insights.slice(0, panelDefs.length).forEach((insight, idx) => {
    const def = panelDefs[idx];
    // Blue vertical bar
    slide.addShape('rect', {
      x: def.x,
      y: def.y,
      w: 0.08,
      h: def.h,
      fill: { color: barColor },
    });
    // Panel background
    slide.addShape('rect', {
      x: def.x + 0.12,
      y: def.y,
      w: def.w - 0.12,
      h: def.h,
      fill: { color: C_WHITE },
      line: { color: C_BORDER, width: 1 },
    });
    // Title — ensureString guards against AI returning object/array for title
    const titleRaw =
      typeof insight === 'string'
        ? `Insight ${idx + 1}`
        : ensureString(insight.title) || `Insight ${idx + 1}`;
    const title = safeText(titleRaw);
    slide.addText(title, {
      x: def.x + 0.2,
      y: def.y + 0.05,
      w: def.w - 0.3,
      h: 0.35,
      fontSize: 14,
      bold: true,
      color: C_DK2,
      fontFace: 'Segoe UI',
    });
    // Body — use structured fields with labels if available, fallback to text/body
    let body = '';
    if (typeof insight === 'string') {
      body = insight;
    } else if (insight.data || insight.pattern || insight.implication || insight.timing) {
      const parts = [];
      if (insight.data) parts.push(ensureString(insight.data));
      if (insight.pattern) parts.push(`So what: ${ensureString(insight.pattern)}`);
      if (insight.implication) parts.push(`Action: ${ensureString(insight.implication)}`);
      if (insight.timing) parts.push(`Timing: ${ensureString(insight.timing)}`);
      body = parts.join('\n');
    } else {
      body = insight.text || insight.body || '';
    }
    const fittedBody = fitTextToShape(String(body || ''), def.w - 0.3, def.h - 0.5, 11);
    slide.addText(fittedBody.text, {
      x: def.x + 0.2,
      y: def.y + 0.4,
      w: def.w - 0.3,
      h: def.h - 0.5,
      fontSize: fittedBody.fontSize,
      color: C_TRUE_BLACK,
      fontFace: 'Segoe UI',
      valign: 'top',
      fit: 'shrink',
    });
  });
}

/**
 * Add callout overlay on chart (Pattern 7A, 8B)
 */
function addCalloutOverlay(slide, text, pos) {
  const p = pos || templatePatterns.patterns?.chart_insight_panels?.elements?.calloutOverlay || {};
  const x = p.x || 1.0;
  const y = p.y || 4.8;
  const w = p.w || 5.5;
  const h = p.h || 1.2;

  slide.addShape('rect', {
    x,
    y,
    w,
    h,
    fill: { color: p.fill || C_CALLOUT_FILL },
    line: { color: p.border || C_CALLOUT_BORDER, width: p.borderWidth || 0.75 },
    rectRadius: p.cornerRadius || 0,
  });
  const fitted = fitTextToShape(String(text || ''), w - 0.2, h - 0.2, 9);
  slide.addText(fitted.text, {
    x: x + 0.1,
    y: y + 0.1,
    w: w - 0.2,
    h: h - 0.2,
    fontSize: fitted.fontSize,
    color: C_BLACK,
    fontFace: 'Segoe UI',
    valign: 'middle',
    fit: 'shrink',
  });
}

/**
 * Add 2x2 matrix (Pattern 3)
 */
function addMatrix(slide, quadrants, patternDef) {
  const p = patternDef || templatePatterns.patterns?.matrix_2x2?.elements || {};
  const cy = TEMPLATE.contentArea.y;
  const cx = TEMPLATE.contentArea.x;
  const halfW = TEMPLATE.contentArea.w / 2 - 0.15;
  const rightX = cx + halfW + 0.3;
  const rightW = TEMPLATE.contentArea.w - halfW - 0.3;
  const quads = p.quadrants || [
    { x: cx, y: cy, w: halfW, h: 2.5, fill: C_LIGHT_BLUE },
    { x: rightX, y: cy, w: rightW, h: 2.5, fill: C_WHITE },
    { x: cx, y: cy + 2.7, w: halfW, h: 2.5, fill: C_WHITE },
    { x: rightX, y: cy + 2.7, w: rightW, h: 2.5, fill: C_LIGHT_BLUE },
  ];

  quadrants.slice(0, 4).forEach((q, idx) => {
    const qDef = quads[idx];
    // Background
    slide.addShape('rect', {
      x: qDef.x,
      y: qDef.y,
      w: qDef.w,
      h: qDef.h,
      fill: { color: qDef.fill || C_WHITE },
      line: { color: C_BORDER, width: 1 },
    });
    // Label
    slide.addText(safeText(q.label || q.title || ''), {
      x: qDef.x + 0.15,
      y: qDef.y + 0.1,
      w: qDef.w - 0.3,
      h: 0.35,
      fontSize: 14,
      bold: true,
      color: C_DK2,
      fontFace: 'Segoe UI',
    });
    // Items
    const items = Array.isArray(q.items) ? q.items : typeof q.text === 'string' ? [q.text] : [];
    const itemText = items
      .slice(0, 5)
      .map((i) => `• ${typeof i === 'string' ? i : i.text || ''}`)
      .join('\n');
    slide.addText(itemText, {
      x: qDef.x + 0.15,
      y: qDef.y + 0.5,
      w: qDef.w - 0.3,
      h: qDef.h - 0.6,
      fontSize: 12,
      color: C_BLACK,
      fontFace: 'Segoe UI',
      valign: 'top',
    });
  });
}

/**
 * Add case study rows with optional chevron (Pattern 9)
 */
function addCaseStudyRows(slide, rows, chevrons, patternDef) {
  const p = patternDef || templatePatterns.patterns?.case_study_rows?.elements || {};
  const csY = TEMPLATE.contentArea.y;
  const rowDefs = p.rows || [
    { label: 'Business Overview', y: csY, h: 0.8 },
    { label: 'Context', y: csY + 0.9, h: 1.0 },
    { label: 'Objective', y: csY + 2.0, h: 0.6 },
    { label: 'Scope', y: csY + 2.7, h: 1.3 },
    { label: 'Outcome', y: csY + 4.1, h: 0.8 },
  ];
  const labelStyle = p.labelStyle || {
    fill: C_DK2,
    color: C_WHITE,
    fontSize: 12,
    bold: true,
  };
  const contentStyle = p.contentStyle || { fill: C_WHITE, color: C_BLACK, fontSize: 11 };
  const labelX = TEMPLATE.contentArea.x;
  const labelW = 2.0;
  const contentX = TEMPLATE.contentArea.x + 2.1;
  const contentW = TEMPLATE.contentArea.w - 2.1;

  rows.slice(0, rowDefs.length).forEach((row, idx) => {
    const def = rowDefs[idx];
    const label = row.label || def.label;
    const content = row.content || row.text || row.value || '';

    // Label cell
    slide.addShape('rect', {
      x: labelX,
      y: def.y,
      w: labelW,
      h: def.h,
      fill: { color: labelStyle.fill },
    });
    slide.addText(label, {
      x: labelX + 0.1,
      y: def.y,
      w: labelW - 0.2,
      h: def.h,
      fontSize: labelStyle.fontSize,
      bold: labelStyle.bold,
      color: labelStyle.color,
      fontFace: 'Segoe UI',
      valign: 'middle',
    });

    // Content cell
    slide.addShape('rect', {
      x: contentX,
      y: def.y,
      w: contentW,
      h: def.h,
      fill: { color: contentStyle.fill },
      line: { color: C_BORDER, width: 1 },
    });
    const fittedContent = fitTextToShape(
      String(content || ''),
      contentW - 0.2,
      def.h - 0.1,
      contentStyle.fontSize
    );
    slide.addText(fittedContent.text, {
      x: contentX + 0.1,
      y: def.y + 0.05,
      w: contentW - 0.2,
      h: def.h - 0.1,
      fontSize: fittedContent.fontSize,
      color: contentStyle.color,
      fontFace: 'Segoe UI',
      valign: 'top',
      fit: 'shrink',
    });
  });

  // Add chevron flow if provided
  if (chevrons && Array.isArray(chevrons) && chevrons.length > 0) {
    addChevronFlow(slide, chevrons, p.chevronFlow);
  }
}

/**
 * Add financial dual charts (Pattern 10)
 */
function addFinancialCharts(slide, incomeData, balanceData, patternDef) {
  const p = patternDef || templatePatterns.patterns?.dual_chart_financial?.elements || {};

  // Use addDualChart for the charts
  addDualChart(
    slide,
    { chartData: incomeData.chartData, title: incomeData.title || 'Income Statement', type: 'bar' },
    { chartData: balanceData.chartData, title: balanceData.title || 'Balance Sheet', type: 'bar' },
    p
  );

  // Add metrics row below charts
  const metricsRow = p.metricsRow || { y: 5.5, h: 0.6 };
  const metrics = incomeData.metrics || [];
  const metricW = metricsRow.metricBoxWidth || 3.0;

  metrics.slice(0, 4).forEach((metric, idx) => {
    const x = TEMPLATE.contentArea.x + idx * (metricW + 0.3);
    slide.addText(ensureString(metric.value || ''), {
      x,
      y: metricsRow.y,
      w: metricW,
      h: 0.3,
      fontSize: metricsRow.metricValueFontSize || 16,
      bold: true,
      color: metricsRow.metricValueColor || C_DK2,
      fontFace: 'Segoe UI',
      align: 'center',
    });
    slide.addText(ensureString(metric.label || ''), {
      x,
      y: metricsRow.y + 0.3,
      w: metricW,
      h: 0.25,
      fontSize: metricsRow.metricLabelFontSize || 9,
      color: metricsRow.metricLabelColor || '666666',
      fontFace: 'Segoe UI',
      align: 'center',
    });
  });
}

// ============ TOC SLIDE ============
// Creates a Table of Contents slide with highlighted active section
function addTocSlide(pptx, activeSectionIdx, sectionNames, COLORS, FONT, countryName) {
  const slide = pptx.addSlide({ masterName: 'YCP_MAIN' });

  // Fix 6: TOC title font size from JSON (default 18, not TITLE_FONT_SIZE which is 20)
  const tocTitleSize = templatePatterns.style?.toc?.fontSize || 18;

  // Title "Table of Contents"
  slide.addText('Table of Contents', {
    x: TEMPLATE.title.x,
    y: TEMPLATE.title.y,
    w: TEMPLATE.title.w,
    h: TEMPLATE.title.h,
    fontSize: tocTitleSize,
    fontFace: FONT,
    color: C_DK2,
    bold: TITLE_BOLD,
  });

  // Build table rows
  const tableRows = [];

  // TOC border: top/bottom dashed, NO left/right (matches template slide2.xml)
  const tocBorderTB = {
    type: C_BORDER_STYLE,
    pt: TABLE_BORDER_WIDTH,
    color: C_BORDER,
  };
  const tocBorderNone = { pt: 0, color: 'FFFFFF' };
  const tocSectionIndentPt = Number(templatePatterns.style?.toc?.sectionIndentPt || 35);
  const tocSectionIndent = Number.isFinite(tocSectionIndentPt)
    ? Number((Math.max(0, tocSectionIndentPt) / 72).toFixed(4))
    : Number((35 / 72).toFixed(4));

  // Fix 4: TOC active section fill from JSON
  const tocActiveFill = TP_COLORS.tocActiveSectionFill || 'CCE5FF';
  // Fix 5: TOC country row fill from JSON
  const tocCountryFill = TP_COLORS.tocFirstRowFill || '99CBFF';

  // Country header row (light blue tint fill) if countryName provided
  if (countryName) {
    tableRows.push([
      {
        text: countryName,
        options: {
          fontSize: templatePatterns.style?.toc?.countryRowFontSize || 18,
          fontFace: FONT,
          color: C_BLACK,
          bold: false,
          fill: { color: tocCountryFill },
          border: [tocBorderTB, tocBorderNone, tocBorderTB, tocBorderNone],
          valign: 'middle',
        },
      },
    ]);
  }

  // Section name rows
  sectionNames.forEach((name, idx) => {
    const isActive = idx === activeSectionIdx;
    tableRows.push([
      {
        text: name,
        options: {
          fontSize: 18,
          fontFace: FONT,
          color: C_BLACK,
          bold: isActive,
          fill: isActive ? { color: tocActiveFill } : undefined,
          border: [tocBorderTB, tocBorderNone, tocBorderTB, tocBorderNone],
          valign: 'middle',
          margin: [
            TABLE_CELL_MARGIN[0],
            TABLE_CELL_MARGIN[1],
            TABLE_CELL_MARGIN[2],
            Number((TABLE_CELL_MARGIN[3] + tocSectionIndent).toFixed(4)),
          ],
        },
      },
    ]);
  });

  safeAddTable(
    slide,
    tableRows,
    {
      x: TEMPLATE.contentArea.x,
      y: TEMPLATE.contentArea.y,
      w: TEMPLATE.contentArea.w,
      rowH: 0.59,
      border: [tocBorderTB, tocBorderNone, tocBorderTB, tocBorderNone],
    },
    'toc'
  );

  return slide;
}

// ============ OPPORTUNITIES & BARRIERS SLIDE ============
// Creates a 2-column table slide with opportunities on left, barriers on right
function addOpportunitiesBarriersSlide(pptx, synthesis, FONT) {
  const slide = pptx.addSlide({ masterName: 'YCP_MAIN' });
  slide.addText('Opportunities & Barriers', {
    x: TEMPLATE.title.x,
    y: TEMPLATE.title.y,
    w: TEMPLATE.title.w,
    h: TEMPLATE.title.h,
    fontSize: TITLE_FONT_SIZE,
    fontFace: FONT,
    color: C_DK2,
    bold: TITLE_BOLD,
  });

  const opportunities = synthesis.opportunities || synthesis.summary?.opportunities || [];
  const barriers =
    synthesis.barriers ||
    synthesis.obstacles ||
    synthesis.summary?.barriers ||
    synthesis.summary?.obstacles ||
    [];

  // Left table: Opportunities
  const colW = (TEMPLATE.contentArea.w - 0.5) / 2;
  const oppRows = [
    [
      {
        text: 'Opportunities',
        options: {
          bold: true,
          fontSize: 14,
          fontFace: FONT,
          fill: { color: SEMANTIC_COLORS.positive },
          color: C_WHITE,
          border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: C_BORDER },
          valign: 'middle',
        },
      },
    ],
    ...safeArray(opportunities, 4).map((opp) => [
      {
        text:
          typeof opp === 'string'
            ? opp
            : opp.description || opp.title || opp.opportunity || ensureString(opp),
        options: {
          fontSize: 12,
          fontFace: FONT,
          color: C_TRUE_BLACK,
          border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: C_BORDER },
          valign: 'middle',
        },
      },
    ]),
  ];

  // Right table: Barriers
  const barRows = [
    [
      {
        text: 'Barriers',
        options: {
          bold: true,
          fontSize: 14,
          fontFace: FONT,
          fill: { color: C_ACCENT6 },
          color: C_WHITE,
          border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: C_BORDER },
          valign: 'middle',
        },
      },
    ],
    ...safeArray(barriers, 4).map((bar) => [
      {
        text:
          typeof bar === 'string'
            ? bar
            : bar.description || bar.title || bar.obstacle || ensureString(bar),
        options: {
          fontSize: 12,
          fontFace: FONT,
          color: C_TRUE_BLACK,
          border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: C_BORDER },
          valign: 'middle',
        },
      },
    ]),
  ];

  safeAddTable(
    slide,
    oppRows,
    {
      x: TEMPLATE.contentArea.x,
      y: TEMPLATE.contentArea.y,
      w: colW,
      rowH: 0.8,
      border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: C_BORDER },
    },
    'opportunities'
  );
  safeAddTable(
    slide,
    barRows,
    {
      x: TEMPLATE.contentArea.x + colW + 0.5,
      y: TEMPLATE.contentArea.y,
      w: colW,
      rowH: 0.8,
      border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: C_BORDER },
    },
    'barriers'
  );

  return slide;
}

// ============ HORIZONTAL FLOW TABLE ============
// For policy regulatory summary (6-column current -> transition -> future layout)
function addHorizontalFlowTable(slide, data, options = {}) {
  if (!Array.isArray(data)) return;
  const {
    x = TEMPLATE.contentArea.x,
    y = TEMPLATE.contentArea.y,
    w = TEMPLATE.contentArea.w,
    font = 'Segoe UI',
  } = options;

  // data is array of { label, currentState, transition, futureState }
  const colWidths = [1.2, 3.2, 0.5, 4.0, 0.5, 3.2]; // total ~12.6

  const headerRow = [
    {
      text: 'Domain',
      options: {
        bold: true,
        fontSize: 12,
        fill: { color: C_TABLE_HEADER },
        color: C_BLACK,
        fontFace: font,
      },
    },
    {
      text: 'Current State',
      options: {
        bold: true,
        fontSize: 12,
        fill: { color: C_TABLE_HEADER },
        color: C_BLACK,
        fontFace: font,
      },
    },
    {
      text: '\u2192',
      options: {
        fontSize: 12,
        fill: { color: C_WHITE },
        color: C_BLACK,
        align: 'center',
        fontFace: font,
      },
    },
    {
      text: 'Transition',
      options: {
        bold: true,
        fontSize: 12,
        fill: { color: C_ACCENT1 },
        color: C_WHITE,
        fontFace: font,
      },
    },
    {
      text: '\u2192',
      options: {
        fontSize: 12,
        fill: { color: C_WHITE },
        color: C_BLACK,
        align: 'center',
        fontFace: font,
      },
    },
    {
      text: 'Future State',
      options: {
        bold: true,
        fontSize: 12,
        fill: { color: TP_COLORS.accent2 || 'EDFDFF' },
        color: C_BLACK,
        fontFace: font,
      },
    },
  ];

  const dataRows = (data || []).map((row) => [
    {
      text: ensureString(row.label || row.domain || ''),
      options: {
        fontSize: 12,
        fontFace: font,
        color: C_BLACK,
        bold: true,
        fill: { color: C_BORDER },
      },
    },
    {
      text: ensureString(row.currentState || ''),
      options: { fontSize: 12, fontFace: font, color: C_BLACK },
    },
    {
      text: '\u2192',
      options: { fontSize: 12, align: 'center', color: C_BLACK, fontFace: font },
    },
    {
      text: ensureString(row.transition || ''),
      options: { fontSize: 12, fontFace: font, color: C_BLACK },
    },
    {
      text: '\u2192',
      options: { fontSize: 12, align: 'center', color: C_BLACK, fontFace: font },
    },
    {
      text: ensureString(row.futureState || ''),
      options: { fontSize: 12, fontFace: font, color: C_BLACK },
    },
  ]);

  const maxRows = Math.min(dataRows.length, 3);
  const rowH = Math.min(1.6, (TEMPLATE.sourceBar.y - TEMPLATE.contentArea.y - 0.5) / (maxRows + 1));

  safeAddTable(
    slide,
    [headerRow, ...dataRows],
    {
      x,
      y,
      w,
      colW: colWidths,
      rowH,
      border: { type: C_BORDER_STYLE, pt: TABLE_BORDER_WIDTH, color: C_BORDER },
    },
    'horizontalFlow'
  );
}

module.exports = {
  truncate,
  truncateSubtitle,
  safeArray,
  safeText,
  sanitizeHyperlinkUrl,
  ensureWebsite,
  isValidCompany,
  dedupeCompanies,
  enrichCompanyDesc,
  flattenPlayerProfile,
  fitTextToShape,
  calculateColumnWidths,
  createTableRowOptions,
  addSourceFootnote,
  addCalloutBox,
  addInsightsPanel,
  addSectionDivider,
  addOpportunitiesObstaclesSummary,
  CHART_COLORS,
  PIE_COLORS,
  CHART_COLORS_EXTENDED,
  SEMANTIC_COLORS,
  mergeHistoricalProjected,
  addStackedBarChart,
  addLineChart,
  addBarChart,
  addPieChart,
  buildStoryNarrative,
  safeTableHeight,
  choosePattern,
  resolveTemplatePattern,
  getPatternKeyForSlideId,
  BLOCK_TEMPLATE_PATTERN_MAP,
  BLOCK_TEMPLATE_SLIDE_MAP,
  getTemplateSlideDetail,
  getTemplateSlideLayout,
  addDualChart,
  addChevronFlow,
  addInsightPanelsFromPattern,
  addCalloutOverlay,
  addMatrix,
  addCaseStudyRows,
  addFinancialCharts,
  templatePatterns,
  TEMPLATE,
  CHART_AXIS_DEFAULTS,
  C_WHITE,
  C_BLACK,
  C_TRUE_BLACK,
  C_BORDER,
  C_BORDER_STYLE,
  TABLE_BORDER_WIDTH,
  C_MUTED,
  C_AXIS_GRAY,
  C_LIGHT_GRAY,
  C_GRAY_BG,
  C_SECONDARY,
  C_LIGHT_BLUE,
  C_CALLOUT_FILL,
  C_CALLOUT_BORDER,
  C_TABLE_HEADER,
  TABLE_CELL_MARGIN,
  addTocSlide,
  addOpportunitiesBarriersSlide,
  addHorizontalFlowTable,
};
