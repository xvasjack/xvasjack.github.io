/**
 * Shared utility functions for all backend services
 * These are commonly used pure functions extracted from individual services
 */

/**
 * Ensure a value is a string (AI models may return objects/arrays instead of strings)
 */
function ensureString(value, defaultValue = '') {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return defaultValue;
  if (Array.isArray(value)) return value.map((v) => ensureString(v)).join(', ');
  if (typeof value === 'object') {
    if (value.city && value.country) return `${value.city}, ${value.country}`;
    if (value.text) return ensureString(value.text);
    if (value.value) return ensureString(value.value);
    if (value.name) return ensureString(value.name);
    try {
      return JSON.stringify(value);
    } catch {
      return defaultValue;
    }
  }
  return String(value);
}

/**
 * Normalize company name for deduplication
 */
function normalizeCompanyName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(
      /\s*(sdn\.?\s*bhd\.?|bhd\.?|pte\.?\s*ltd\.?|ltd\.?|inc\.?|corp\.?|corporation|llc|l\.l\.c\.?|co\.?\s*ltd\.?|gmbh|s\.?a\.?|s\.?r\.?l\.?|jsc|pjsc|plc|tbk|pt\.?\s*tbk\.?)\s*$/gi,
      ''
    )
    .replace(/^(pt\.?\s*|cv\.?\s*)/gi, '')
    .replace(/\s*\([^)]*\)\s*/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize website URL for comparison
 */
function normalizeWebsite(url) {
  if (!url || typeof url !== 'string') return '';
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .replace(
      /\/(home|index|about|contact|products|services|company|main|default|en|id|th|vi|jp|cn|kr|de|fr)\/?$/i,
      ''
    )
    .replace(/\.(html|htm|php|aspx|jsp)$/i, '');
}

/**
 * Extract domain root from URL
 */
function extractDomainRoot(url) {
  if (!url || typeof url !== 'string') return '';
  const normalized = normalizeWebsite(url);
  return normalized.split('/')[0].replace(/^www\./, '');
}

/**
 * Check if URL is spam or directory (social media, Wikipedia, etc.)
 */
function isSpamOrDirectoryURL(url) {
  if (!url || typeof url !== 'string') return true;
  const spamPatterns = [
    /wikipedia\.org/i,
    /facebook\.com/i,
    /twitter\.com/i,
    /linkedin\.com/i,
    /instagram\.com/i,
    /youtube\.com/i,
    /tiktok\.com/i,
  ];
  return spamPatterns.some((pattern) => pattern.test(url));
}

/**
 * Remove duplicate companies by website, domain, and name
 */
function dedupeCompanies(companies) {
  if (!Array.isArray(companies)) return [];

  const seen = {
    websites: new Set(),
    domains: new Set(),
    names: new Set(),
  };

  return companies.filter((c) => {
    if (!c || !c.website || !c.company_name) return false;
    if (!/^https?:\/\//i.test(c.website)) return false;
    if (isSpamOrDirectoryURL(c.website)) return false;

    const normalizedWebsite = normalizeWebsite(c.website);
    const domain = extractDomainRoot(c.website);
    const normalizedName = normalizeCompanyName(c.company_name);

    if (seen.websites.has(normalizedWebsite)) return false;
    if (seen.domains.has(domain)) return false;
    if (seen.names.has(normalizedName)) return false;

    seen.websites.add(normalizedWebsite);
    seen.domains.add(domain);
    seen.names.add(normalizedName);

    return true;
  });
}

/**
 * Build exclusion rules based on user criteria
 */
function buildExclusionRules(exclusion) {
  if (!exclusion || typeof exclusion !== 'string') return '';

  const rules = [];
  const lower = exclusion.toLowerCase();

  if (
    lower.includes('large') ||
    lower.includes('big') ||
    lower.includes('mnc') ||
    lower.includes('multinational')
  ) {
    rules.push('- Exclude large multinationals (>1000 employees, >$100M revenue)');
    rules.push('- Exclude well-known global brands');
  }

  if (lower.includes('listed') || lower.includes('public')) {
    rules.push('- Exclude publicly listed companies');
    rules.push('- Exclude companies with stock tickers');
  }

  if (lower.includes('distributor')) {
    rules.push('- Exclude pure distributors/resellers');
    rules.push('- Focus on manufacturers and service providers');
  }

  return rules.join('\n');
}

/**
 * Detect meeting domain from text for translation context
 */
function detectMeetingDomain(text) {
  if (!text || typeof text !== 'string') return 'general';
  const lower = text.toLowerCase();

  if (
    /ebitda|revenue|m&a|acquisition|valuation|irr|npv|dcf|wacc|eps|pe ratio|dividend|capex|opex/i.test(
      lower
    )
  )
    return 'financial';
  if (
    /contract|nda|liability|indemnity|jurisdiction|clause|arbitration|compliance|litigation|patent|trademark/i.test(
      lower
    )
  )
    return 'legal';
  if (
    /clinical|fda|ema|pharmaceutical|patient|diagnosis|therapeutic|dosage|efficacy|trial|drug/i.test(
      lower
    )
  )
    return 'medical';
  if (
    /api|infrastructure|deployment|kubernetes|docker|microservice|database|latency|throughput|scalability/i.test(
      lower
    )
  )
    return 'technical';
  if (
    /compensation|benefits|hiring|recruitment|onboarding|retention|performance review|salary|bonus/i.test(
      lower
    )
  )
    return 'hr';

  return 'general';
}

/**
 * Get domain-specific translation instructions
 */
function getDomainInstructions(domain) {
  const instructions = {
    financial:
      'Preserve financial terms, metrics, and abbreviations exactly. Use standard financial translation conventions.',
    legal:
      'Maintain legal precision. Preserve contract terms, clause references, and legal terminology.',
    medical:
      'Use approved medical terminology. Preserve drug names, dosages, and clinical terms exactly.',
    technical:
      'Keep technical terms, acronyms, and code references in original form. Translate explanations only.',
    hr: 'Use standard HR terminology. Preserve job titles and organizational terms appropriately.',
    general: 'Provide clear, professional translation maintaining the original meaning and tone.',
  };
  return instructions[domain] || instructions.general;
}

/**
 * Build consistent output format instructions
 */
function buildOutputFormat() {
  return `Return a JSON array of companies. Each company must have:
- company_name: Official company name
- website: Full URL starting with http:// or https://
- hq: Headquarters location as "City, Country" format
- description: Brief 1-2 sentence description of what they do`;
}

module.exports = {
  ensureString,
  normalizeCompanyName,
  normalizeWebsite,
  extractDomainRoot,
  isSpamOrDirectoryURL,
  dedupeCompanies,
  buildExclusionRules,
  detectMeetingDomain,
  getDomainInstructions,
  buildOutputFormat,
};
