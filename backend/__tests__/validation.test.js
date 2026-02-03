/**
 * Unit tests for validation service utilities
 * Tests pure functions for data transformation, validation, and string processing
 */

// Re-implement testable utilities here (extracted from validation/server.js)
// In a real refactor, these would be imported from a shared utils module

// ============ STRING NORMALIZATION ============

function normalizeCompanyName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(
      /\s*(sdn\.?\s*bhd\.?|bhd\.?|berhad|pte\.?\s*ltd\.?|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|co\.?,?\s*ltd\.?|llc|llp|gmbh|s\.?a\.?|pt\.?|cv\.?|tbk\.?|jsc|plc|public\s*limited|private\s*limited|joint\s*stock|company|\(.*?\))$/gi,
      ''
    )
    .replace(/^(pt\.?|cv\.?)\s+/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWebsite(url) {
  if (!url) return '';
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .replace(
      /\/(home|index|main|default|about|about-us|contact|products?|services?|en|th|id|vn|my|sg|ph|company)(\/.*)?$/i,
      ''
    )
    .replace(/\.(html?|php|aspx?|jsp)$/i, '');
}

function extractDomainRoot(url) {
  const normalized = normalizeWebsite(url);
  return normalized.split('/')[0];
}

// ============ DEDUPLICATION ============

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

// ============ URL VALIDATION ============

function isSpamOrDirectoryURL(url) {
  if (!url) return true;
  const urlLower = url.toLowerCase();

  const obviousSpam = [
    'wikipedia.org',
    'facebook.com',
    'twitter.com',
    'instagram.com',
    'youtube.com',
  ];

  for (const pattern of obviousSpam) {
    if (urlLower.includes(pattern)) return true;
  }

  return false;
}

function isValidCompanyWebsite(url) {
  if (!url) return false;
  const urlLower = url.toLowerCase();

  if (urlLower.endsWith('.pdf') || urlLower.includes('.pdf?') || urlLower.includes('.pdf#'))
    return false;
  if (
    urlLower.endsWith('.doc') ||
    urlLower.endsWith('.docx') ||
    urlLower.endsWith('.xls') ||
    urlLower.endsWith('.xlsx')
  )
    return false;

  const invalidPatterns = [
    'google.com/maps',
    'google.com/search',
    'maps.google',
    'facebook.com',
    'linkedin.com',
    'twitter.com',
    'instagram.com',
    'youtube.com',
    'wikipedia.org',
    'bloomberg.com',
    'reuters.com',
    'alibaba.com',
    'made-in-china.com',
    'globalsources.com',
    'indiamart.com',
    'yellowpages',
    'yelp.com',
    'trustpilot.com',
    'glassdoor.com',
    'crunchbase.com',
    'zoominfo.com',
    'dnb.com',
    'opencorporates.com',
    'scribd.com',
    'listedcompany.com',
    'sec.gov',
    'annualreports.com',
    '/investor',
    '/annual-report',
    '/newsroom/',
    '/misc/',
    'pwc.com',
    'deloitte.com',
    'ey.com',
    'kpmg.com',
    'marketwatch.com',
    'yahoo.com/finance',
    'finance.yahoo',
  ];

  for (const pattern of invalidPatterns) {
    if (urlLower.includes(pattern)) return false;
  }

  if (!url.startsWith('http')) return false;

  return true;
}

function extractCleanURL(text) {
  if (!text) return null;

  const urlMatches = text.match(/https?:\/\/[^\s"'<>\])+,]+/gi);
  if (!urlMatches) return null;

  for (const url of urlMatches) {
    const cleanUrl = url.replace(/[.,;:!?)]+$/, '');
    if (isValidCompanyWebsite(cleanUrl)) {
      return cleanUrl;
    }
  }

  return null;
}

// ============ TEXT PARSING ============

function parseCompanyList(text) {
  if (!text) return [];
  return text
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length < 200);
}

function parseCountries(text) {
  if (!text) return [];
  return text
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ============ DOMAIN DETECTION ============

function detectMeetingDomain(text) {
  const domains = {
    financial:
      /\b(revenue|EBITDA|valuation|M&A|merger|acquisition|IPO|equity|debt|ROI|P&L|balance sheet|cash flow|投資|収益|利益|財務)\b/i,
    legal:
      /\b(contract|agreement|liability|compliance|litigation|IP|intellectual property|NDA|terms|clause|legal|lawyer|attorney|契約|法的|弁護士)\b/i,
    medical:
      /\b(clinical|trial|FDA|patient|therapeutic|drug|pharmaceutical|biotech|efficacy|dosage|治療|患者|医療|臨床)\b/i,
    technical:
      /\b(API|architecture|infrastructure|database|server|cloud|deployment|code|software|engineering|システム|開発|技術)\b/i,
    hr: /\b(employee|hiring|compensation|benefits|performance|talent|HR|recruitment|人事|採用|給与)\b/i,
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
    financial:
      'This is a financial/investment due diligence meeting. Preserve financial terms like M&A, EBITDA, ROI, P&L accurately. Use standard financial terminology.',
    legal:
      'This is a legal due diligence meeting. Preserve legal terms and contract language precisely. Maintain formal legal register.',
    medical:
      'This is a medical/pharmaceutical due diligence meeting. Preserve medical terminology, drug names, and clinical terms accurately.',
    technical:
      'This is a technical due diligence meeting. Preserve technical terms, acronyms, and engineering terminology accurately.',
    hr: 'This is an HR/talent due diligence meeting. Preserve HR terminology and employment-related terms accurately.',
    general:
      'This is a business due diligence meeting. Preserve business terminology and professional tone.',
  };
  return instructions[domain] || instructions.general;
}

// ============ QUERY BUILDERS ============

function buildOutputFormat() {
  return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
}

function buildExclusionRules(exclusion, _business) {
  const exclusionLower = exclusion.toLowerCase();
  let rules = '';

  if (
    exclusionLower.includes('large') ||
    exclusionLower.includes('big') ||
    exclusionLower.includes('mnc') ||
    exclusionLower.includes('multinational') ||
    exclusionLower.includes('major') ||
    exclusionLower.includes('giant')
  ) {
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

  if (exclusionLower.includes('listed') || exclusionLower.includes('public')) {
    rules += `
LISTED COMPANY DETECTION - REJECT if page shows:
- Stock ticker, NYSE, NASDAQ, SGX, SET, IDX, or any stock exchange
- "publicly traded", "listed company", "IPO"
- Company name contains "Tbk"
`;
  }

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

// Strategy function example
function strategy1_BroadSerpAPI(business, country, _exclusion) {
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  const terms = business
    .split(/\s+or\s+|\s+and\s+|,/)
    .map((t) => t.trim())
    .filter((t) => t);

  for (const c of countries) {
    queries.push(
      `${business} companies ${c}`,
      `${business} manufacturers ${c}`,
      `${business} suppliers ${c}`,
      `list of ${business} companies in ${c}`,
      `${business} industry ${c}`
    );
    for (const term of terms) {
      queries.push(`${term} ${c}`);
    }
  }

  return queries;
}

// ============ TESTS ============

describe('normalizeCompanyName', () => {
  test('removes common legal suffixes', () => {
    expect(normalizeCompanyName('ABC Company Sdn Bhd')).toBe('abc company');
    expect(normalizeCompanyName('XYZ Pte Ltd')).toBe('xyz');
    expect(normalizeCompanyName('Test Inc.')).toBe('test');
    expect(normalizeCompanyName('Demo Corporation')).toBe('demo');
  });

  test('removes PT prefix (Indonesian)', () => {
    expect(normalizeCompanyName('PT ABC Indonesia')).toBe('abc indonesia');
    expect(normalizeCompanyName('PT. XYZ')).toBe('xyz');
  });

  test('removes Tbk suffix (Indonesian listed)', () => {
    expect(normalizeCompanyName('ABC Tbk')).toBe('abc');
  });

  test('removes special characters', () => {
    expect(normalizeCompanyName('ABC & Co.')).toBe('abc co');
    expect(normalizeCompanyName('Test-Industries')).toBe('testindustries');
  });

  test('normalizes spaces', () => {
    expect(normalizeCompanyName('ABC   Industries')).toBe('abc industries');
  });

  test('converts to lowercase', () => {
    expect(normalizeCompanyName('ABC INDUSTRIES')).toBe('abc industries');
  });

  test('handles empty/null input', () => {
    expect(normalizeCompanyName('')).toBe('');
    expect(normalizeCompanyName(null)).toBe('');
    expect(normalizeCompanyName(undefined)).toBe('');
  });

  test('removes content in parentheses', () => {
    expect(normalizeCompanyName('ABC Company (Thailand)')).toBe('abc company');
  });
});

describe('normalizeWebsite', () => {
  test('removes protocol', () => {
    expect(normalizeWebsite('https://example.com')).toBe('example.com');
    expect(normalizeWebsite('http://example.com')).toBe('example.com');
  });

  test('removes www', () => {
    expect(normalizeWebsite('https://www.example.com')).toBe('example.com');
  });

  test('removes trailing slashes', () => {
    expect(normalizeWebsite('https://example.com/')).toBe('example.com');
    expect(normalizeWebsite('https://example.com///')).toBe('example.com');
  });

  test('removes common path suffixes', () => {
    expect(normalizeWebsite('https://example.com/home')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/about-us')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/contact')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/en')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/products')).toBe('example.com');
  });

  test('removes file extensions', () => {
    expect(normalizeWebsite('https://example.com/index.html')).toBe('example.com/index');
    expect(normalizeWebsite('https://example.com/page.php')).toBe('example.com/page');
  });

  test('converts to lowercase', () => {
    expect(normalizeWebsite('https://EXAMPLE.COM')).toBe('example.com');
  });

  test('handles empty/null input', () => {
    expect(normalizeWebsite('')).toBe('');
    expect(normalizeWebsite(null)).toBe('');
    expect(normalizeWebsite(undefined)).toBe('');
  });

  test('preserves path for non-common pages', () => {
    expect(normalizeWebsite('https://example.com/special-page')).toBe('example.com/special-page');
  });
});

describe('extractDomainRoot', () => {
  test('extracts domain from URL', () => {
    expect(extractDomainRoot('https://example.com/path/to/page')).toBe('example.com');
    expect(extractDomainRoot('https://www.example.com/page')).toBe('example.com');
  });

  test('handles URLs with query strings', () => {
    expect(extractDomainRoot('https://example.com/page?id=123')).toBe('example.com');
  });

  test('handles subdomains', () => {
    expect(extractDomainRoot('https://subdomain.example.com')).toBe('subdomain.example.com');
  });

  test('handles empty input', () => {
    expect(extractDomainRoot('')).toBe('');
  });
});

describe('dedupeCompanies', () => {
  test('removes duplicate websites', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://example.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('removes duplicate domains', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com/page1', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://example.com/page2', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicate normalized names', () => {
    const companies = [
      { company_name: 'ABC Sdn Bhd', website: 'https://abc.com', hq: 'City, Country' },
      { company_name: 'ABC Company', website: 'https://abc-company.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('keeps different companies', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://abc.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://xyz.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(2);
  });

  test('filters out invalid entries', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://abc.com', hq: 'City, Country' },
      { company_name: '', website: 'https://xyz.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: '', hq: 'City, Country' },
      null,
      { company_name: 'Valid', website: 'not-a-url', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('handles empty array', () => {
    expect(dedupeCompanies([])).toEqual([]);
  });
});

describe('isSpamOrDirectoryURL', () => {
  test('detects Wikipedia URLs', () => {
    expect(isSpamOrDirectoryURL('https://en.wikipedia.org/wiki/Company')).toBe(true);
  });

  test('detects social media URLs', () => {
    expect(isSpamOrDirectoryURL('https://facebook.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://twitter.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://instagram.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://youtube.com/company')).toBe(true);
  });

  test('accepts valid company URLs', () => {
    expect(isSpamOrDirectoryURL('https://company.com')).toBe(false);
    expect(isSpamOrDirectoryURL('https://example.co.th')).toBe(false);
  });

  test('handles empty/null input', () => {
    expect(isSpamOrDirectoryURL('')).toBe(true);
    expect(isSpamOrDirectoryURL(null)).toBe(true);
    expect(isSpamOrDirectoryURL(undefined)).toBe(true);
  });
});

describe('isValidCompanyWebsite', () => {
  test('rejects PDF files', () => {
    expect(isValidCompanyWebsite('https://example.com/document.pdf')).toBe(false);
    expect(isValidCompanyWebsite('https://example.com/doc.pdf?download=1')).toBe(false);
  });

  test('rejects document files', () => {
    expect(isValidCompanyWebsite('https://example.com/file.doc')).toBe(false);
    expect(isValidCompanyWebsite('https://example.com/file.docx')).toBe(false);
    expect(isValidCompanyWebsite('https://example.com/file.xls')).toBe(false);
    expect(isValidCompanyWebsite('https://example.com/file.xlsx')).toBe(false);
  });

  test('rejects social media', () => {
    expect(isValidCompanyWebsite('https://facebook.com/company')).toBe(false);
    expect(isValidCompanyWebsite('https://linkedin.com/company/abc')).toBe(false);
    expect(isValidCompanyWebsite('https://twitter.com/company')).toBe(false);
  });

  test('rejects directory sites', () => {
    expect(isValidCompanyWebsite('https://yellowpages.com/company')).toBe(false);
    expect(isValidCompanyWebsite('https://crunchbase.com/organization/company')).toBe(false);
    expect(isValidCompanyWebsite('https://opencorporates.com/companies/us/123')).toBe(false);
  });

  test('rejects news/finance sites', () => {
    expect(isValidCompanyWebsite('https://bloomberg.com/news/company')).toBe(false);
    expect(isValidCompanyWebsite('https://reuters.com/article/company')).toBe(false);
    expect(isValidCompanyWebsite('https://finance.yahoo.com/quote/ABC')).toBe(false);
  });

  test('rejects investor relations pages', () => {
    expect(isValidCompanyWebsite('https://company.com/investor')).toBe(false);
    expect(isValidCompanyWebsite('https://company.com/annual-report')).toBe(false);
  });

  test('rejects URLs without http/https', () => {
    expect(isValidCompanyWebsite('company.com')).toBe(false);
    expect(isValidCompanyWebsite('www.company.com')).toBe(false);
  });

  test('accepts valid company websites', () => {
    expect(isValidCompanyWebsite('https://company.com')).toBe(true);
    expect(isValidCompanyWebsite('http://example.co.th')).toBe(true);
    expect(isValidCompanyWebsite('https://www.business.com/about')).toBe(true);
  });

  test('handles empty/null input', () => {
    expect(isValidCompanyWebsite('')).toBe(false);
    expect(isValidCompanyWebsite(null)).toBe(false);
    expect(isValidCompanyWebsite(undefined)).toBe(false);
  });
});

describe('extractCleanURL', () => {
  test('extracts URL from text', () => {
    const text = 'Visit our website at https://company.com for more info';
    expect(extractCleanURL(text)).toBe('https://company.com');
  });

  test('removes trailing punctuation', () => {
    const text = 'Website: https://company.com.';
    expect(extractCleanURL(text)).toBe('https://company.com');
  });

  test('skips invalid URLs', () => {
    const text = 'See https://facebook.com/company and https://company.com';
    expect(extractCleanURL(text)).toBe('https://company.com');
  });

  test('returns null if no valid URL found', () => {
    expect(extractCleanURL('No URLs here')).toBe(null);
    expect(extractCleanURL('Only invalid: https://facebook.com/page')).toBe(null);
  });

  test('handles empty/null input', () => {
    expect(extractCleanURL('')).toBe(null);
    expect(extractCleanURL(null)).toBe(null);
    expect(extractCleanURL(undefined)).toBe(null);
  });

  test('extracts first valid URL', () => {
    const text = 'Check https://company.com or https://example.com';
    expect(extractCleanURL(text)).toBe('https://company.com');
  });
});

describe('parseCompanyList', () => {
  test('parses newline-separated companies', () => {
    const text = 'ABC Company\nXYZ Corp\nTest Ltd';
    const result = parseCompanyList(text);
    expect(result).toEqual(['ABC Company', 'XYZ Corp', 'Test Ltd']);
  });

  test('trims whitespace', () => {
    const text = '  ABC Company  \n  XYZ Corp  ';
    const result = parseCompanyList(text);
    expect(result).toEqual(['ABC Company', 'XYZ Corp']);
  });

  test('filters empty lines', () => {
    const text = 'ABC Company\n\n\nXYZ Corp\n';
    const result = parseCompanyList(text);
    expect(result).toEqual(['ABC Company', 'XYZ Corp']);
  });

  test('filters lines that are too long', () => {
    const text = 'ABC Company\n' + 'X'.repeat(250);
    const result = parseCompanyList(text);
    expect(result).toEqual(['ABC Company']);
  });

  test('handles Windows line endings', () => {
    const text = 'ABC Company\r\nXYZ Corp\r\nTest Ltd';
    const result = parseCompanyList(text);
    expect(result).toEqual(['ABC Company', 'XYZ Corp', 'Test Ltd']);
  });

  test('handles empty/null input', () => {
    expect(parseCompanyList('')).toEqual([]);
    expect(parseCompanyList(null)).toEqual([]);
    expect(parseCompanyList(undefined)).toEqual([]);
  });
});

describe('parseCountries', () => {
  test('parses newline-separated countries', () => {
    const text = 'Malaysia\nThailand\nVietnam';
    const result = parseCountries(text);
    expect(result).toEqual(['Malaysia', 'Thailand', 'Vietnam']);
  });

  test('trims whitespace', () => {
    const text = '  Malaysia  \n  Thailand  ';
    const result = parseCountries(text);
    expect(result).toEqual(['Malaysia', 'Thailand']);
  });

  test('filters empty lines', () => {
    const text = 'Malaysia\n\n\nThailand\n';
    const result = parseCountries(text);
    expect(result).toEqual(['Malaysia', 'Thailand']);
  });

  test('handles empty/null input', () => {
    expect(parseCountries('')).toEqual([]);
    expect(parseCountries(null)).toEqual([]);
    expect(parseCountries(undefined)).toEqual([]);
  });
});

describe('detectMeetingDomain', () => {
  test('detects financial domain', () => {
    expect(detectMeetingDomain('Discussion about EBITDA and revenue growth')).toBe('financial');
    expect(detectMeetingDomain('M&A valuation and ROI analysis')).toBe('financial');
    expect(detectMeetingDomain('Balance sheet review')).toBe('financial');
  });

  test('detects legal domain', () => {
    expect(detectMeetingDomain('Contract review and NDA signing')).toBe('legal');
    expect(detectMeetingDomain('Intellectual property litigation')).toBe('legal');
    expect(detectMeetingDomain('Compliance requirements')).toBe('legal');
  });

  test('detects medical domain', () => {
    expect(detectMeetingDomain('Clinical trial results and FDA approval')).toBe('medical');
    expect(detectMeetingDomain('Pharmaceutical dosage recommendations')).toBe('medical');
    expect(detectMeetingDomain('Patient therapeutic outcomes')).toBe('medical');
  });

  test('detects technical domain', () => {
    expect(detectMeetingDomain('API architecture and database infrastructure')).toBe('technical');
    expect(detectMeetingDomain('Cloud deployment strategy')).toBe('technical');
    expect(detectMeetingDomain('Software engineering practices')).toBe('technical');
  });

  test('detects HR domain', () => {
    expect(detectMeetingDomain('Employee compensation and benefits')).toBe('hr');
    expect(detectMeetingDomain('Talent recruitment strategy')).toBe('hr');
    expect(detectMeetingDomain('Performance review process')).toBe('hr');
  });

  test('defaults to general for non-matching text', () => {
    expect(detectMeetingDomain('General business discussion')).toBe('general');
    expect(detectMeetingDomain('Meeting about company strategy')).toBe('general');
  });

  test('detects mixed English/Japanese terms', () => {
    expect(detectMeetingDomain('Discussion about 投資 and revenue')).toBe('financial');
    expect(detectMeetingDomain('Meeting about 契約 and contract')).toBe('legal');
  });
});

describe('getDomainInstructions', () => {
  test('returns financial instructions', () => {
    const instructions = getDomainInstructions('financial');
    expect(instructions).toContain('financial');
    expect(instructions).toContain('EBITDA');
  });

  test('returns legal instructions', () => {
    const instructions = getDomainInstructions('legal');
    expect(instructions).toContain('legal');
    expect(instructions).toContain('contract');
  });

  test('returns medical instructions', () => {
    const instructions = getDomainInstructions('medical');
    expect(instructions).toContain('medical');
    expect(instructions).toContain('pharmaceutical');
  });

  test('returns technical instructions', () => {
    const instructions = getDomainInstructions('technical');
    expect(instructions).toContain('technical');
    expect(instructions).toContain('engineering');
  });

  test('returns HR instructions', () => {
    const instructions = getDomainInstructions('hr');
    expect(instructions).toContain('HR');
    expect(instructions).toContain('employment');
  });

  test('returns general instructions for unknown domain', () => {
    expect(getDomainInstructions('unknown')).toContain('business');
    expect(getDomainInstructions('')).toContain('business');
  });

  test('returns general instructions for general domain', () => {
    const instructions = getDomainInstructions('general');
    expect(instructions).toContain('business');
  });
});

describe('buildOutputFormat', () => {
  test('returns output format string', () => {
    const format = buildOutputFormat();
    expect(format).toContain('company_name');
    expect(format).toContain('website');
    expect(format).toContain('hq');
    expect(format).toContain('City, Country');
  });

  test('includes instruction about thoroughness', () => {
    const format = buildOutputFormat();
    expect(format).toContain('thorough');
  });
});

describe('buildExclusionRules', () => {
  test('builds large company exclusion rules', () => {
    const rules = buildExclusionRules('exclude large companies', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('global presence');
    expect(rules).toContain('NYSE');
    expect(rules).toContain('Fortune 500');
  });

  test('builds MNC exclusion rules', () => {
    const rules = buildExclusionRules('exclude MNC', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('multinational');
  });

  test('builds listed company exclusion rules', () => {
    const rules = buildExclusionRules('exclude listed companies', 'ink');
    expect(rules).toContain('LISTED COMPANY DETECTION');
    expect(rules).toContain('publicly traded');
    expect(rules).toContain('Stock ticker');
  });

  test('builds distributor exclusion rules', () => {
    const rules = buildExclusionRules('exclude distributors', 'ink');
    expect(rules).toContain('DISTRIBUTOR DETECTION');
    expect(rules).toContain('manufacturing');
  });

  test('builds multiple rules when multiple exclusions', () => {
    const rules = buildExclusionRules('exclude large listed companies', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('LISTED COMPANY DETECTION');
  });

  test('returns empty string for non-matching exclusion', () => {
    const rules = buildExclusionRules('no exclusions', 'ink');
    expect(rules).toBe('');
  });

  test('handles case-insensitive matching', () => {
    const rules = buildExclusionRules('EXCLUDE LARGE COMPANIES', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });
});

describe('strategy1_BroadSerpAPI', () => {
  test('generates queries for single country', () => {
    const queries = strategy1_BroadSerpAPI('ink manufacturers', 'Malaysia', 'large');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries).toContain('ink manufacturers companies Malaysia');
    expect(queries).toContain('ink manufacturers manufacturers Malaysia');
    expect(queries).toContain('ink manufacturers suppliers Malaysia');
  });

  test('generates queries for multiple countries', () => {
    const queries = strategy1_BroadSerpAPI('ink', 'Malaysia, Thailand', 'large');
    expect(queries.some((q) => q.includes('Malaysia'))).toBe(true);
    expect(queries.some((q) => q.includes('Thailand'))).toBe(true);
  });

  test('splits business terms with "or"', () => {
    const queries = strategy1_BroadSerpAPI('ink or paint', 'Malaysia', 'large');
    expect(queries.some((q) => q.includes('ink'))).toBe(true);
    expect(queries.some((q) => q.includes('paint'))).toBe(true);
  });

  test('splits business terms with "and"', () => {
    const queries = strategy1_BroadSerpAPI('ink and chemicals', 'Malaysia', 'large');
    expect(queries.some((q) => q.includes('ink'))).toBe(true);
    expect(queries.some((q) => q.includes('chemicals'))).toBe(true);
  });

  test('includes industry variations', () => {
    const queries = strategy1_BroadSerpAPI('ink', 'Malaysia', 'large');
    expect(queries.some((q) => q.includes('list of'))).toBe(true);
    expect(queries.some((q) => q.includes('industry'))).toBe(true);
  });

  test('generates unique queries', () => {
    const queries = strategy1_BroadSerpAPI('ink', 'Malaysia', 'large');
    expect(queries.length).toBeGreaterThan(5);
  });
});
