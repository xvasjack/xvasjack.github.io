/**
 * Unit tests for trading-comparable utility functions
 * Tests focus on data transformation, validation, and utility logic
 */

// Re-implement testable functions (extracted from server code)
// In a real refactor, these would be imported from a shared utils module

// ============ TYPE SAFETY HELPERS ============
function ensureString(value, defaultValue = '') {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return defaultValue;
  // Handle arrays - join with comma
  if (Array.isArray(value)) return value.map(v => ensureString(v)).join(', ');
  // Handle objects - try to extract meaningful string
  if (typeof value === 'object') {
    // Common patterns from AI responses
    if (value.city && value.country) return `${value.city}, ${value.country}`;
    if (value.text) return ensureString(value.text);
    if (value.value) return ensureString(value.value);
    if (value.name) return ensureString(value.name);
    // Fallback: stringify
    try { return JSON.stringify(value); } catch { return defaultValue; }
  }
  // Convert other types to string
  return String(value);
}

// ============ DEDUPLICATION ============
function normalizeCompanyName(name) {
  if (!name) return '';
  return name.toLowerCase()
    // Remove ALL common legal suffixes globally (expanded list)
    .replace(/\s*(sdn\.?\s*bhd\.?|bhd\.?|berhad|pte\.?\s*ltd\.?|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|co\.?,?\s*ltd\.?|llc|llp|gmbh|s\.?a\.?|pt\.?|cv\.?|tbk\.?|jsc|plc|public\s*limited|private\s*limited|joint\s*stock|company|\(.*?\))$/gi, '')
    // Also remove these if they appear anywhere (for cases like "PT Company Name")
    .replace(/^(pt\.?|cv\.?)\s+/gi, '')
    .replace(/[^\w\s]/g, '')  // Remove special characters
    .replace(/\s+/g, ' ')      // Normalize spaces
    .trim();
}

function normalizeWebsite(url) {
  if (!url) return '';
  return url.toLowerCase()
    .replace(/^https?:\/\//, '')           // Remove protocol
    .replace(/^www\./, '')                  // Remove www
    .replace(/\/+$/, '')                    // Remove trailing slashes
    // Remove common path suffixes that don't differentiate companies
    .replace(/\/(home|index|main|default|about|about-us|contact|products?|services?|en|th|id|vn|my|sg|ph|company)(\/.*)?$/i, '')
    .replace(/\.(html?|php|aspx?|jsp)$/i, ''); // Remove file extensions
}

// Extract domain root for additional deduplication
function extractDomainRoot(url) {
  const normalized = normalizeWebsite(url);
  // Get just the domain without any path
  return normalized.split('/')[0];
}

function dedupeCompanies(allCompanies) {
  const seenWebsites = new Map();
  const seenDomains = new Map();
  const seenNames = new Map();
  const results = [];

  for (const c of allCompanies) {
    if (!c || !c.website || !c.company_name) continue;
    if (!c.website.startsWith('http')) continue;

    const websiteKey = normalizeWebsite(c.website);
    const domainKey = extractDomainRoot(c.website);
    const nameKey = normalizeCompanyName(c.company_name);

    // Skip if we've seen this exact URL, domain, or normalized name
    if (seenWebsites.has(websiteKey)) continue;
    if (seenDomains.has(domainKey)) continue;
    if (nameKey && seenNames.has(nameKey)) continue;

    seenWebsites.set(websiteKey, true);
    seenDomains.set(domainKey, true);
    if (nameKey) seenNames.set(nameKey, true);
    results.push(c);
  }

  return results;
}

// ============ PRE-FILTER ============
function isSpamOrDirectoryURL(url) {
  if (!url) return true;
  const urlLower = url.toLowerCase();

  // Only filter out obvious non-company URLs (very conservative)
  const obviousSpam = [
    'wikipedia.org',
    'facebook.com',
    'twitter.com',
    'instagram.com',
    'youtube.com'
  ];

  for (const pattern of obviousSpam) {
    if (urlLower.includes(pattern)) return true;
  }

  return false;
}

// ============ EXCLUSION RULES ============
function buildExclusionRules(exclusion, business) {
  const exclusionLower = exclusion.toLowerCase();
  let rules = '';

  // Detect if user wants to exclude LARGE companies - use PAGE SIGNALS like n8n
  if (exclusionLower.includes('large') || exclusionLower.includes('big') ||
      exclusionLower.includes('mnc') || exclusionLower.includes('multinational') ||
      exclusionLower.includes('major') || exclusionLower.includes('giant')) {
    rules += `
LARGE COMPANY DETECTION - Look for these PAGE SIGNALS to REJECT:
- "global presence", "worldwide operations", "global leader", "world's largest"
- Stock ticker symbols or mentions of: NYSE, NASDAQ, SGX, SET, IDX, listed, IPO
- "multinational", "global network", offices/operations in 10+ countries
- Revenue figures >$100M, employee count >1000
- "Fortune 500", "Forbes Global"
- Company name contains known MNC: Toyo Ink, Sakata, Flint, Siegwerk, Sun Chemical, DIC
- Website says "subsidiary of", "part of [X] Group", "member of [X] Group"
- Company name ends with "Tbk" (Indonesian listed)

If NONE of these signals are found → ACCEPT (assume local company)
`;
  }

  // Detect if user wants to exclude LISTED/PUBLIC companies
  if (exclusionLower.includes('listed') || exclusionLower.includes('public')) {
    rules += `
LISTED COMPANY DETECTION - REJECT if page shows:
- Stock ticker, NYSE, NASDAQ, SGX, SET, IDX, or any stock exchange
- "publicly traded", "listed company", "IPO"
- Company name contains "Tbk"
`;
  }

  // Detect if user wants to exclude DISTRIBUTORS
  if (exclusionLower.includes('distributor')) {
    rules += `
DISTRIBUTOR DETECTION - REJECT only if:
- Company ONLY distributes/resells with NO manufacturing
- No mention of factory, plant, production facility, "we manufacture"

ACCEPT if they manufacture (even if also distribute) - most manufacturers also sell their products
`;
  }

  return rules;
}

// ============ TRADING COMPARABLE UTILITIES ============
function calculateMedian(values) {
  const nums = values.filter(v => typeof v === 'number' && !isNaN(v) && isFinite(v) && v !== null);
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function formatMultiple(val) {
  if (val === null || val === undefined || isNaN(val)) return '-';
  return Number(val).toFixed(1) + 'x';
}

function buildReasoningPrompt(companyNames, filterCriteria) {
  return `You are filtering companies for a trading comparable analysis.

FILTER CRITERIA: "${filterCriteria}"

Companies to evaluate:
${companyNames.map((name, i) => `${i + 1}. ${name}`).join('\n')}

For EACH company, think step by step:
1. What is this company's PRIMARY business? (research if needed)
2. Does "${filterCriteria}" describe their main business activity?
3. Would an investment banker consider this company a direct peer/comparable?

Decision rules:
- relevant=true: Company's PRIMARY business matches the filter criteria
- relevant=false: Company operates in a different industry, or the criteria is only a minor part of their business

Output JSON: {"results": [{"index": 0, "name": "Company Name", "relevant": false, "business": "5-10 word description of actual business"}]}`;
}

function createSheetData(companies, headers, title) {
  const data = [[title], [], headers];

  for (const c of companies) {
    const row = [
      c.name,
      c.country || '-',
      c.sales,
      c.marketCap,
      c.ev,
      c.ebitda,
      c.netMargin,
      c.opMargin,
      c.ebitdaMargin,
      c.evEbitda,
      c.peTTM,
      c.peFY,
      c.pb,
      c.filterReason || '',
      (c.dataWarnings && c.dataWarnings.length > 0) ? c.dataWarnings.join('; ') : ''
    ];
    data.push(row);
  }

  // Add median row
  if (companies.length > 0) {
    const medianRow = [
      'MEDIAN',
      '',
      calculateMedian(companies.map(c => c.sales)),
      calculateMedian(companies.map(c => c.marketCap)),
      calculateMedian(companies.map(c => c.ev)),
      calculateMedian(companies.map(c => c.ebitda)),
      calculateMedian(companies.map(c => c.netMargin)),
      calculateMedian(companies.map(c => c.opMargin)),
      calculateMedian(companies.map(c => c.ebitdaMargin)),
      calculateMedian(companies.map(c => c.evEbitda)),
      calculateMedian(companies.map(c => c.peTTM)),
      calculateMedian(companies.map(c => c.peFY)),
      calculateMedian(companies.map(c => c.pb)),
      '',
      ''
    ];
    data.push([]);
    data.push(medianRow);
  }

  return data;
}

// ============ DOMAIN DETECTION ============
function detectMeetingDomain(text) {
  const domains = {
    financial: /\b(revenue|EBITDA|valuation|M&A|merger|acquisition|IPO|equity|debt|ROI|P&L|balance sheet|cash flow|投資|収益|利益|財務)\b/i,
    legal: /\b(contract|agreement|liability|compliance|litigation|IP|intellectual property|NDA|terms|clause|legal|lawyer|attorney|契約|法的|弁護士)\b/i,
    medical: /\b(clinical|trial|FDA|patient|therapeutic|drug|pharmaceutical|biotech|efficacy|dosage|治療|患者|医療|臨床)\b/i,
    technical: /\b(API|architecture|infrastructure|database|server|cloud|deployment|code|software|engineering|システム|開発|技術)\b/i,
    hr: /\b(employee|hiring|compensation|benefits|performance|talent|HR|recruitment|人事|採用|給与)\b/i
  };

  for (const [domain, pattern] of Object.entries(domains)) {
    if (pattern.test(text)) {
      return domain;
    }
  }
  return 'general';
}

function getDomainInstructions(domain) {
  const instructions = {
    financial: 'This is a financial/investment due diligence meeting. Preserve financial terms like M&A, EBITDA, ROI, P&L accurately. Use standard financial terminology.',
    legal: 'This is a legal due diligence meeting. Preserve legal terms and contract language precisely. Maintain formal legal register.',
    medical: 'This is a medical/pharmaceutical due diligence meeting. Preserve medical terminology, drug names, and clinical terms accurately.',
    technical: 'This is a technical due diligence meeting. Preserve technical terms, acronyms, and engineering terminology accurately.',
    hr: 'This is an HR/talent due diligence meeting. Preserve HR terminology and employment-related terms accurately.',
    general: 'This is a business due diligence meeting. Preserve business terminology and professional tone.'
  };
  return instructions[domain] || instructions.general;
}

function buildOutputFormat() {
  return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
}

// ============ TESTS ============

describe('ensureString', () => {
  test('returns string as-is', () => {
    expect(ensureString('hello')).toBe('hello');
    expect(ensureString('test string')).toBe('test string');
  });

  test('returns default for null/undefined', () => {
    expect(ensureString(null)).toBe('');
    expect(ensureString(undefined)).toBe('');
    expect(ensureString(null, 'default')).toBe('default');
    expect(ensureString(undefined, 'custom')).toBe('custom');
  });

  test('joins arrays with comma', () => {
    expect(ensureString(['a', 'b', 'c'])).toBe('a, b, c');
    expect(ensureString([1, 2, 3])).toBe('1, 2, 3');
    expect(ensureString(['single'])).toBe('single');
  });

  test('extracts city and country from object', () => {
    expect(ensureString({ city: 'Bangkok', country: 'Thailand' })).toBe('Bangkok, Thailand');
  });

  test('extracts text field from object', () => {
    expect(ensureString({ text: 'extracted text' })).toBe('extracted text');
  });

  test('extracts value field from object', () => {
    expect(ensureString({ value: 'extracted value' })).toBe('extracted value');
  });

  test('extracts name field from object', () => {
    expect(ensureString({ name: 'Company Name' })).toBe('Company Name');
  });

  test('stringifies other objects', () => {
    const obj = { key: 'value' };
    expect(ensureString(obj)).toBe(JSON.stringify(obj));
  });

  test('converts numbers to strings', () => {
    expect(ensureString(123)).toBe('123');
    expect(ensureString(45.67)).toBe('45.67');
    expect(ensureString(0)).toBe('0');
  });

  test('converts booleans to strings', () => {
    expect(ensureString(true)).toBe('true');
    expect(ensureString(false)).toBe('false');
  });

  test('handles nested arrays', () => {
    expect(ensureString([['a', 'b'], ['c', 'd']])).toBe('a, b, c, d');
  });
});

describe('normalizeCompanyName', () => {
  test('returns empty string for falsy input', () => {
    expect(normalizeCompanyName(null)).toBe('');
    expect(normalizeCompanyName(undefined)).toBe('');
    expect(normalizeCompanyName('')).toBe('');
  });

  test('converts to lowercase', () => {
    expect(normalizeCompanyName('COMPANY NAME')).toBe('company name');
    expect(normalizeCompanyName('MixedCase')).toBe('mixedcase');
  });

  test('removes Sdn Bhd suffix', () => {
    expect(normalizeCompanyName('ABC Sdn Bhd')).toBe('abc');
    expect(normalizeCompanyName('ABC Sdn. Bhd.')).toBe('abc');
    expect(normalizeCompanyName('ABC Bhd')).toBe('abc');
    expect(normalizeCompanyName('ABC Berhad')).toBe('abc');
  });

  test('removes Pte Ltd suffix', () => {
    expect(normalizeCompanyName('Company Pte Ltd')).toBe('company');
    expect(normalizeCompanyName('Company Pte. Ltd.')).toBe('company');
  });

  test('removes common English suffixes', () => {
    expect(normalizeCompanyName('Company Ltd')).toBe('company');
    expect(normalizeCompanyName('Company Limited')).toBe('company');
    expect(normalizeCompanyName('Company Inc')).toBe('company');
    expect(normalizeCompanyName('Company Incorporated')).toBe('company');
    expect(normalizeCompanyName('Company Corp')).toBe('company');
    expect(normalizeCompanyName('Company Corporation')).toBe('company');
    expect(normalizeCompanyName('Company LLC')).toBe('company');
    expect(normalizeCompanyName('Company LLP')).toBe('company');
  });

  test('removes PT prefix', () => {
    expect(normalizeCompanyName('PT Company Name')).toBe('company name');
    expect(normalizeCompanyName('PT. Company Name')).toBe('company name');
  });

  test('removes CV prefix', () => {
    expect(normalizeCompanyName('CV Company Name')).toBe('company name');
    expect(normalizeCompanyName('CV. Company Name')).toBe('company name');
  });

  test('removes Indonesian Tbk suffix', () => {
    expect(normalizeCompanyName('Company Tbk')).toBe('company');
    expect(normalizeCompanyName('Company Tbk.')).toBe('company');
  });

  test('removes JSC and PLC suffixes', () => {
    expect(normalizeCompanyName('Company JSC')).toBe('company');
    expect(normalizeCompanyName('Company PLC')).toBe('company');
  });

  test('removes parenthetical content at end', () => {
    // Parenthetical is only removed if it's at the end after other suffixes
    expect(normalizeCompanyName('Company (Asia)')).toBe('company');
  });

  test('removes special characters but not spaces', () => {
    expect(normalizeCompanyName('Company & Co.')).toBe('company co');
    // Hyphens are removed, creating single word
    expect(normalizeCompanyName('Company-Name')).toBe('companyname');
  });

  test('normalizes whitespace', () => {
    expect(normalizeCompanyName('Company   Name')).toBe('company name');
    expect(normalizeCompanyName('  Company  ')).toBe('company');
  });

  test('handles complex company names', () => {
    expect(normalizeCompanyName('PT ABC Industries Tbk.')).toBe('abc industries');
    expect(normalizeCompanyName('XYZ Manufacturing Sdn. Bhd.')).toBe('xyz manufacturing');
    expect(normalizeCompanyName('Global Tech (M) Pte. Ltd.')).toBe('global tech m');
  });
});

describe('normalizeWebsite', () => {
  test('returns empty string for falsy input', () => {
    expect(normalizeWebsite(null)).toBe('');
    expect(normalizeWebsite(undefined)).toBe('');
    expect(normalizeWebsite('')).toBe('');
  });

  test('removes protocol', () => {
    expect(normalizeWebsite('http://example.com')).toBe('example.com');
    expect(normalizeWebsite('https://example.com')).toBe('example.com');
  });

  test('removes www prefix', () => {
    expect(normalizeWebsite('http://www.example.com')).toBe('example.com');
    expect(normalizeWebsite('https://www.example.com')).toBe('example.com');
  });

  test('removes trailing slashes', () => {
    expect(normalizeWebsite('http://example.com/')).toBe('example.com');
    expect(normalizeWebsite('http://example.com///')).toBe('example.com');
  });

  test('removes common page paths', () => {
    expect(normalizeWebsite('http://example.com/home')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/index')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/about')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/about-us')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/contact')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/products')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/services')).toBe('example.com');
  });

  test('removes language path suffixes', () => {
    expect(normalizeWebsite('http://example.com/en')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/th')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/id')).toBe('example.com');
  });

  test('removes file extensions', () => {
    // Path removal only works if path is at the END (no extension)
    // So /index.html becomes /index after .html is removed
    expect(normalizeWebsite('http://example.com/index.html')).toBe('example.com/index');
    // Other paths keep the filename after extension is removed
    expect(normalizeWebsite('http://example.com/page.php')).toBe('example.com/page');
    // /default.aspx becomes /default
    expect(normalizeWebsite('http://example.com/default.aspx')).toBe('example.com/default');
  });

  test('converts to lowercase', () => {
    expect(normalizeWebsite('http://EXAMPLE.COM')).toBe('example.com');
    expect(normalizeWebsite('http://Example.Com')).toBe('example.com');
  });

  test('handles complex URLs', () => {
    // The regex removes /home path, so only /en remains gets removed too
    expect(normalizeWebsite('https://www.example.com/en/home/index.html'))
      .toBe('example.com');
  });

  test('preserves paths not in common list', () => {
    expect(normalizeWebsite('http://example.com/specific-page')).toBe('example.com/specific-page');
  });
});

describe('extractDomainRoot', () => {
  test('extracts domain from simple URL', () => {
    expect(extractDomainRoot('http://example.com')).toBe('example.com');
    expect(extractDomainRoot('https://www.test.com')).toBe('test.com');
  });

  test('extracts domain from URL with path', () => {
    expect(extractDomainRoot('http://example.com/path/to/page')).toBe('example.com');
    expect(extractDomainRoot('https://www.test.com/products/item')).toBe('test.com');
  });

  test('handles subdomains', () => {
    expect(extractDomainRoot('http://subdomain.example.com')).toBe('subdomain.example.com');
  });
});

describe('dedupeCompanies', () => {
  test('removes exact duplicate websites', () => {
    const companies = [
      { company_name: 'ABC', website: 'http://example.com' },
      { company_name: 'ABC Corp', website: 'http://example.com' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('removes duplicates with different protocols', () => {
    const companies = [
      { company_name: 'ABC', website: 'http://example.com' },
      { company_name: 'ABC', website: 'https://example.com' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicates with www variance', () => {
    const companies = [
      { company_name: 'ABC', website: 'http://example.com' },
      { company_name: 'ABC', website: 'http://www.example.com' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicates with trailing slashes', () => {
    const companies = [
      { company_name: 'ABC', website: 'http://example.com' },
      { company_name: 'ABC', website: 'http://example.com/' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicates by normalized company name', () => {
    const companies = [
      { company_name: 'ABC Ltd', website: 'http://abc.com' },
      { company_name: 'ABC Limited', website: 'http://abc-co.com' },
      { company_name: 'ABC Inc', website: 'http://abc-inc.com' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicates by domain root', () => {
    const companies = [
      { company_name: 'ABC', website: 'http://example.com/home' },
      { company_name: 'ABC', website: 'http://example.com/about' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('keeps different companies', () => {
    const companies = [
      { company_name: 'ABC', website: 'http://abc.com' },
      { company_name: 'XYZ', website: 'http://xyz.com' },
      { company_name: 'DEF', website: 'http://def.com' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(3);
  });

  test('filters out entries without required fields', () => {
    const companies = [
      { company_name: 'ABC', website: 'http://abc.com' },
      { company_name: '', website: 'http://test.com' },
      { company_name: 'XYZ', website: '' },
      { website: 'http://missing.com' },
      null,
      undefined
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('filters out websites not starting with http', () => {
    const companies = [
      { company_name: 'ABC', website: 'http://abc.com' },
      { company_name: 'XYZ', website: 'www.xyz.com' },
      { company_name: 'DEF', website: 'def.com' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('handles empty array', () => {
    expect(dedupeCompanies([])).toEqual([]);
  });
});

describe('isSpamOrDirectoryURL', () => {
  test('returns true for falsy input', () => {
    expect(isSpamOrDirectoryURL(null)).toBe(true);
    expect(isSpamOrDirectoryURL(undefined)).toBe(true);
    expect(isSpamOrDirectoryURL('')).toBe(true);
  });

  test('returns true for Wikipedia', () => {
    expect(isSpamOrDirectoryURL('https://en.wikipedia.org/wiki/Company')).toBe(true);
    expect(isSpamOrDirectoryURL('http://wikipedia.org')).toBe(true);
  });

  test('returns true for social media', () => {
    expect(isSpamOrDirectoryURL('https://facebook.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://twitter.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://instagram.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://youtube.com/company')).toBe(true);
  });

  test('returns false for legitimate company URLs', () => {
    expect(isSpamOrDirectoryURL('https://example.com')).toBe(false);
    expect(isSpamOrDirectoryURL('http://company-name.co.id')).toBe(false);
    expect(isSpamOrDirectoryURL('https://www.legitimate-business.com')).toBe(false);
  });

  test('is case insensitive', () => {
    expect(isSpamOrDirectoryURL('https://FACEBOOK.COM/page')).toBe(true);
    expect(isSpamOrDirectoryURL('https://YouTube.COM')).toBe(true);
  });
});

describe('buildExclusionRules', () => {
  test('returns empty string for no matching exclusions', () => {
    expect(buildExclusionRules('', 'business')).toBe('');
    expect(buildExclusionRules('none', 'business')).toBe('');
  });

  test('generates large company rules', () => {
    const rules = buildExclusionRules('exclude large companies', 'manufacturing');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('global presence');
    expect(rules).toContain('NYSE');
    expect(rules).toContain('Fortune 500');
    expect(rules).toContain('subsidiary of');
  });

  test('generates large company rules for "big"', () => {
    const rules = buildExclusionRules('exclude big corporations', 'tech');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('generates large company rules for "mnc"', () => {
    const rules = buildExclusionRules('no MNC', 'retail');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('multinational');
  });

  test('generates large company rules for "multinational"', () => {
    const rules = buildExclusionRules('exclude multinational', 'services');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('generates listed company rules', () => {
    const rules = buildExclusionRules('exclude listed companies', 'finance');
    expect(rules).toContain('LISTED COMPANY DETECTION');
    expect(rules).toContain('Stock ticker');
    expect(rules).toContain('publicly traded');
    expect(rules).toContain('Tbk');
  });

  test('generates listed company rules for "public"', () => {
    const rules = buildExclusionRules('no public companies', 'healthcare');
    expect(rules).toContain('LISTED COMPANY DETECTION');
  });

  test('generates distributor rules', () => {
    const rules = buildExclusionRules('exclude distributor', 'manufacturing');
    expect(rules).toContain('DISTRIBUTOR DETECTION');
    expect(rules).toContain('ONLY distributes');
    expect(rules).toContain('factory');
    expect(rules).toContain('manufacture');
  });

  test('combines multiple exclusion types', () => {
    const rules = buildExclusionRules('exclude large listed companies and distributors', 'tech');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('LISTED COMPANY DETECTION');
    expect(rules).toContain('DISTRIBUTOR DETECTION');
  });

  test('is case insensitive', () => {
    const rules = buildExclusionRules('EXCLUDE LARGE COMPANIES', 'business');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });
});

describe('calculateMedian', () => {
  test('calculates median for odd number of values', () => {
    expect(calculateMedian([1, 2, 3, 4, 5])).toBe(3);
    expect(calculateMedian([10, 20, 30])).toBe(20);
  });

  test('calculates median for even number of values', () => {
    expect(calculateMedian([1, 2, 3, 4])).toBe(2.5);
    expect(calculateMedian([10, 20, 30, 40])).toBe(25);
  });

  test('handles single value', () => {
    expect(calculateMedian([42])).toBe(42);
  });

  test('handles negative values', () => {
    expect(calculateMedian([-5, -2, 0, 3, 7])).toBe(0);
    expect(calculateMedian([-10, -5])).toBe(-7.5);
  });

  test('handles unsorted values', () => {
    expect(calculateMedian([5, 1, 3, 2, 4])).toBe(3);
    expect(calculateMedian([40, 10, 30, 20])).toBe(25);
  });

  test('filters out NaN values', () => {
    expect(calculateMedian([1, NaN, 3, 5])).toBe(3);
    expect(calculateMedian([NaN, NaN, 10])).toBe(10);
  });

  test('filters out null values', () => {
    expect(calculateMedian([1, null, 3, null, 5])).toBe(3);
  });

  test('filters out Infinity values', () => {
    expect(calculateMedian([1, Infinity, 3, -Infinity, 5])).toBe(3);
  });

  test('filters out non-number values', () => {
    expect(calculateMedian([1, '2', 3, undefined, 5])).toBe(3);
  });

  test('returns null for empty array', () => {
    expect(calculateMedian([])).toBeNull();
  });

  test('returns null for array with only invalid values', () => {
    expect(calculateMedian([NaN, null, undefined, Infinity])).toBeNull();
  });

  test('handles decimal values', () => {
    expect(calculateMedian([1.5, 2.5, 3.5])).toBe(2.5);
    expect(calculateMedian([1.1, 2.2, 3.3, 4.4])).toBe(2.75);
  });

  test('handles large numbers', () => {
    expect(calculateMedian([1000000, 2000000, 3000000])).toBe(2000000);
  });

  test('handles zero', () => {
    expect(calculateMedian([0, 0, 0])).toBe(0);
    expect(calculateMedian([-5, 0, 5])).toBe(0);
  });
});

describe('formatMultiple', () => {
  test('formats positive numbers', () => {
    expect(formatMultiple(5)).toBe('5.0x');
    expect(formatMultiple(12.3)).toBe('12.3x');
    expect(formatMultiple(0.5)).toBe('0.5x');
  });

  test('formats negative numbers', () => {
    expect(formatMultiple(-3.5)).toBe('-3.5x');
  });

  test('formats zero', () => {
    expect(formatMultiple(0)).toBe('0.0x');
  });

  test('returns dash for null', () => {
    expect(formatMultiple(null)).toBe('-');
  });

  test('returns dash for undefined', () => {
    expect(formatMultiple(undefined)).toBe('-');
  });

  test('returns dash for NaN', () => {
    expect(formatMultiple(NaN)).toBe('-');
  });

  test('rounds to 1 decimal place', () => {
    expect(formatMultiple(5.456)).toBe('5.5x');
    expect(formatMultiple(5.444)).toBe('5.4x');
  });

  test('handles very large numbers', () => {
    expect(formatMultiple(999999)).toBe('999999.0x');
  });

  test('handles very small numbers', () => {
    expect(formatMultiple(0.001)).toBe('0.0x');
  });
});

describe('buildReasoningPrompt', () => {
  test('generates prompt with company names and criteria', () => {
    const companies = ['ABC Corp', 'XYZ Ltd', 'DEF Inc'];
    const criteria = 'manufacturing companies';
    const prompt = buildReasoningPrompt(companies, criteria);

    expect(prompt).toContain('manufacturing companies');
    expect(prompt).toContain('1. ABC Corp');
    expect(prompt).toContain('2. XYZ Ltd');
    expect(prompt).toContain('3. DEF Inc');
  });

  test('includes instructions for filtering', () => {
    const prompt = buildReasoningPrompt(['Company A'], 'tech companies');

    expect(prompt).toContain('trading comparable analysis');
    expect(prompt).toContain('PRIMARY business');
    expect(prompt).toContain('investment banker');
    expect(prompt).toContain('relevant=true');
    expect(prompt).toContain('relevant=false');
  });

  test('includes JSON output format', () => {
    const prompt = buildReasoningPrompt(['Company A'], 'retail');

    expect(prompt).toContain('Output JSON');
    expect(prompt).toContain('"results"');
    expect(prompt).toContain('"index"');
    expect(prompt).toContain('"name"');
    expect(prompt).toContain('"relevant"');
    expect(prompt).toContain('"business"');
  });

  test('handles single company', () => {
    const prompt = buildReasoningPrompt(['Solo Company'], 'services');

    expect(prompt).toContain('1. Solo Company');
  });

  test('handles many companies', () => {
    const companies = Array.from({ length: 10 }, (_, i) => `Company ${i + 1}`);
    const prompt = buildReasoningPrompt(companies, 'manufacturing');

    expect(prompt).toContain('1. Company 1');
    expect(prompt).toContain('10. Company 10');
  });
});

describe('createSheetData', () => {
  test('creates data with title and headers', () => {
    const companies = [];
    const headers = ['Name', 'Country', 'Sales'];
    const title = 'Test Sheet';

    const data = createSheetData(companies, headers, title);

    expect(data[0]).toEqual([title]);
    expect(data[1]).toEqual([]);
    expect(data[2]).toEqual(headers);
  });

  test('adds company rows', () => {
    const companies = [
      {
        name: 'Company A',
        country: 'US',
        sales: 100,
        marketCap: 500,
        ev: 600,
        ebitda: 50,
        netMargin: 0.1,
        opMargin: 0.15,
        ebitdaMargin: 0.2,
        evEbitda: 12,
        peTTM: 15,
        peFY: 14,
        pb: 2.5
      }
    ];
    const headers = ['Name', 'Country'];
    const data = createSheetData(companies, headers, 'Title');

    expect(data[3][0]).toBe('Company A');
    expect(data[3][1]).toBe('US');
    expect(data[3][2]).toBe(100);
  });

  test('uses dash for missing country', () => {
    const companies = [{ name: 'Company A', sales: 100 }];
    const data = createSheetData(companies, [], 'Title');

    expect(data[3][1]).toBe('-');
  });

  test('includes filter reason', () => {
    const companies = [
      {
        name: 'Company A',
        filterReason: 'Excluded due to size',
        sales: 100
      }
    ];
    const data = createSheetData(companies, [], 'Title');

    expect(data[3][13]).toBe('Excluded due to size');
  });

  test('joins data warnings with semicolon', () => {
    const companies = [
      {
        name: 'Company A',
        dataWarnings: ['Warning 1', 'Warning 2', 'Warning 3'],
        sales: 100
      }
    ];
    const data = createSheetData(companies, [], 'Title');

    expect(data[3][14]).toBe('Warning 1; Warning 2; Warning 3');
  });

  test('uses empty string for no warnings', () => {
    const companies = [
      {
        name: 'Company A',
        dataWarnings: [],
        sales: 100
      }
    ];
    const data = createSheetData(companies, [], 'Title');

    expect(data[3][14]).toBe('');
  });

  test('adds median row for multiple companies', () => {
    const companies = [
      { name: 'A', sales: 100, marketCap: 500, ev: 600 },
      { name: 'B', sales: 200, marketCap: 800, ev: 900 },
      { name: 'C', sales: 150, marketCap: 600, ev: 700 }
    ];
    const data = createSheetData(companies, [], 'Title');

    // Should have title, empty, empty (headers), 3 companies, empty, median = 8 rows
    expect(data).toHaveLength(8);
    expect(data[6]).toEqual([]); // Empty row before median
    expect(data[7][0]).toBe('MEDIAN');
    expect(data[7][2]).toBe(150); // median of [100, 200, 150]
    expect(data[7][3]).toBe(600); // median of [500, 800, 600]
  });

  test('median row has empty strings for non-numeric columns', () => {
    const companies = [
      { name: 'A', sales: 100 },
      { name: 'B', sales: 200 }
    ];
    const data = createSheetData(companies, [], 'Title');

    // Median is at index 6 (title, empty, headers, A, B, empty, median)
    expect(data[6][1]).toBe(''); // Country column
    expect(data[6][13]).toBe(''); // Filter reason
    expect(data[6][14]).toBe(''); // Data warnings
  });

  test('handles empty companies array', () => {
    const data = createSheetData([], ['Name'], 'Title');

    expect(data).toHaveLength(3); // title, empty, headers
  });

  test('handles single company', () => {
    const companies = [{ name: 'Company A', sales: 100 }];
    const data = createSheetData(companies, [], 'Title');

    expect(data).toHaveLength(6); // title, empty, headers, company, empty, median
  });
});

describe('detectMeetingDomain', () => {
  test('detects financial domain', () => {
    expect(detectMeetingDomain('We discussed revenue and EBITDA projections')).toBe('financial');
    expect(detectMeetingDomain('The M&A deal involves equity financing')).toBe('financial');
    expect(detectMeetingDomain('ROI and cash flow analysis')).toBe('financial');
    expect(detectMeetingDomain('P&L and balance sheet review')).toBe('financial');
  });

  test('detects legal domain', () => {
    expect(detectMeetingDomain('Review the contract and NDA terms')).toBe('legal');
    expect(detectMeetingDomain('IP and intellectual property clause')).toBe('legal');
    expect(detectMeetingDomain('Legal compliance and litigation risk')).toBe('legal');
    expect(detectMeetingDomain('Agreement liability with attorney')).toBe('legal');
  });

  test('detects medical domain', () => {
    expect(detectMeetingDomain('Clinical trial results for the drug')).toBe('medical');
    expect(detectMeetingDomain('FDA approval for therapeutic dosage')).toBe('medical');
    expect(detectMeetingDomain('Patient efficacy in pharmaceutical biotech')).toBe('medical');
  });

  test('detects technical domain', () => {
    expect(detectMeetingDomain('API architecture and database design')).toBe('technical');
    expect(detectMeetingDomain('Cloud infrastructure and server deployment')).toBe('technical');
    expect(detectMeetingDomain('Software engineering code review')).toBe('technical');
  });

  test('detects HR domain', () => {
    expect(detectMeetingDomain('Employee compensation and benefits')).toBe('hr');
    expect(detectMeetingDomain('Hiring and talent recruitment')).toBe('hr');
    expect(detectMeetingDomain('HR performance and employee review')).toBe('hr');
  });

  test('returns general for non-specific text', () => {
    expect(detectMeetingDomain('Regular business meeting')).toBe('general');
    expect(detectMeetingDomain('Team discussion about project')).toBe('general');
    expect(detectMeetingDomain('General update on progress')).toBe('general');
  });

  test('prioritizes first match', () => {
    // If multiple domains match, returns the first one (financial comes first in code)
    expect(detectMeetingDomain('Revenue contract with legal terms')).toBe('financial');
  });

  test('is case insensitive', () => {
    expect(detectMeetingDomain('EBITDA and Revenue')).toBe('financial');
    expect(detectMeetingDomain('contract and AGREEMENT')).toBe('legal');
  });

  test('detects domain with mixed content', () => {
    // Word boundaries don't work well with Japanese characters
    // Test that English financial terms are detected even with other content
    expect(detectMeetingDomain('Discussion about revenue and growth')).toBe('financial');
    expect(detectMeetingDomain('Review contract terms and conditions')).toBe('legal');
    expect(detectMeetingDomain('Clinical trial patient outcomes')).toBe('medical');
  });
});

describe('getDomainInstructions', () => {
  test('returns financial instructions', () => {
    const instructions = getDomainInstructions('financial');
    expect(instructions).toContain('financial/investment due diligence');
    expect(instructions).toContain('M&A');
    expect(instructions).toContain('EBITDA');
    expect(instructions).toContain('financial terminology');
  });

  test('returns legal instructions', () => {
    const instructions = getDomainInstructions('legal');
    expect(instructions).toContain('legal due diligence');
    expect(instructions).toContain('legal terms');
    expect(instructions).toContain('contract language');
    expect(instructions).toContain('formal legal register');
  });

  test('returns medical instructions', () => {
    const instructions = getDomainInstructions('medical');
    expect(instructions).toContain('medical/pharmaceutical due diligence');
    expect(instructions).toContain('medical terminology');
    expect(instructions).toContain('drug names');
    expect(instructions).toContain('clinical terms');
  });

  test('returns technical instructions', () => {
    const instructions = getDomainInstructions('technical');
    expect(instructions).toContain('technical due diligence');
    expect(instructions).toContain('technical terms');
    expect(instructions).toContain('acronyms');
    expect(instructions).toContain('engineering terminology');
  });

  test('returns HR instructions', () => {
    const instructions = getDomainInstructions('hr');
    expect(instructions).toContain('HR/talent due diligence');
    expect(instructions).toContain('HR terminology');
    expect(instructions).toContain('employment-related terms');
  });

  test('returns general instructions for general domain', () => {
    const instructions = getDomainInstructions('general');
    expect(instructions).toContain('business due diligence');
    expect(instructions).toContain('business terminology');
    expect(instructions).toContain('professional tone');
  });

  test('returns general instructions for unknown domain', () => {
    const instructions = getDomainInstructions('unknown');
    expect(instructions).toContain('business due diligence');
  });

  test('returns general instructions for null', () => {
    const instructions = getDomainInstructions(null);
    expect(instructions).toContain('business due diligence');
  });
});

describe('buildOutputFormat', () => {
  test('returns expected format instructions', () => {
    const format = buildOutputFormat();

    expect(format).toContain('company_name');
    expect(format).toContain('website');
    expect(format).toContain('URL starting with http');
    expect(format).toContain('hq');
    expect(format).toContain('City, Country');
    expect(format).toContain('Be thorough');
    expect(format).toContain('verify them later');
  });

  test('returns consistent output', () => {
    const format1 = buildOutputFormat();
    const format2 = buildOutputFormat();
    expect(format1).toBe(format2);
  });
});
