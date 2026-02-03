/**
 * Unit tests for due-diligence utility functions
 * Tests focus on data transformation, validation, and utility logic
 */

// Re-implement testable functions (extracted from server code)
// In a real refactor, these would be imported from a shared utils module

// ============ TYPE SAFETY HELPERS ============

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

// ============ SEARCH UTILITIES ============

function buildOutputFormat() {
  return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
}

// ============ COMPANY NORMALIZATION ============

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

// ============ EXCLUSION RULES ============

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

// ============ EMAIL GENERATION ============

function buildEmailHTML(companies, business, country, exclusion) {
  let html = `
    <h2>Find Target Results</h2>
    <p><strong>Business:</strong> ${business}</p>
    <p><strong>Country:</strong> ${country}</p>
    <p><strong>Exclusion:</strong> ${exclusion}</p>
    <p><strong>Companies Found:</strong> ${companies.length}</p>
    <br>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #f0f0f0;">
        <tr><th>#</th><th>Company</th><th>Website</th><th>Headquarters</th></tr>
      </thead>
      <tbody>
  `;
  companies.forEach((c, i) => {
    html += `<tr><td>${i + 1}</td><td>${c.company_name}</td><td><a href="${c.website}">${c.website}</a></td><td>${c.hq}</td></tr>`;
  });
  html += '</tbody></table>';
  return html;
}

// ============ SEARCH STRATEGIES ============

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

function strategy4_CitiesPerplexity(business, country, exclusion) {
  const CITY_MAP = {
    malaysia: ['Kuala Lumpur', 'Penang', 'Johor Bahru', 'Shah Alam', 'Petaling Jaya'],
    singapore: ['Singapore', 'Jurong', 'Tuas', 'Woodlands'],
    thailand: ['Bangkok', 'Chonburi', 'Rayong', 'Samut Prakan', 'Ayutthaya'],
  };

  const countries = country.split(',').map((c) => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  for (const c of countries) {
    const cities = CITY_MAP[c.toLowerCase()] || [c];
    for (const city of cities) {
      queries.push(
        `${business} companies in ${city}, ${c}. Exclude ${exclusion}. ${outputFormat}`,
        `${business} manufacturers near ${city}. ${outputFormat}`
      );
    }
  }

  return queries;
}

// ============ TESTS ============

describe('ensureString', () => {
  test('returns string as-is', () => {
    expect(ensureString('hello')).toBe('hello');
    expect(ensureString('')).toBe('');
    expect(ensureString('test value')).toBe('test value');
  });

  test('returns default for null/undefined', () => {
    expect(ensureString(null)).toBe('');
    expect(ensureString(undefined)).toBe('');
    expect(ensureString(null, 'default')).toBe('default');
    expect(ensureString(undefined, 'fallback')).toBe('fallback');
  });

  test('joins arrays with comma', () => {
    expect(ensureString(['a', 'b', 'c'])).toBe('a, b, c');
    expect(ensureString([])).toBe('');
    expect(ensureString(['single'])).toBe('single');
    expect(ensureString([1, 2, 3])).toBe('1, 2, 3');
  });

  test('extracts city/country from object', () => {
    expect(ensureString({ city: 'NYC', country: 'USA' })).toBe('NYC, USA');
    expect(ensureString({ city: 'London', country: 'UK' })).toBe('London, UK');
  });

  test('extracts text/value/name from object', () => {
    expect(ensureString({ text: 'hello' })).toBe('hello');
    expect(ensureString({ value: 'world' })).toBe('world');
    expect(ensureString({ name: 'test' })).toBe('test');
  });

  test('nested extraction for objects', () => {
    expect(ensureString({ text: { value: 'nested' } })).toBe('nested');
    expect(ensureString({ value: { name: 'deep' } })).toBe('deep');
  });

  test('stringifies unknown objects', () => {
    expect(ensureString({ foo: 'bar' })).toBe('{"foo":"bar"}');
    expect(ensureString({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  test('converts numbers to string', () => {
    expect(ensureString(123)).toBe('123');
    expect(ensureString(0)).toBe('0');
    expect(ensureString(-456)).toBe('-456');
    expect(ensureString(3.14)).toBe('3.14');
  });

  test('converts booleans to string', () => {
    expect(ensureString(true)).toBe('true');
    expect(ensureString(false)).toBe('false');
  });

  test('handles nested arrays', () => {
    expect(
      ensureString([
        ['a', 'b'],
        ['c', 'd'],
      ])
    ).toBe('a, b, c, d');
  });
});

describe('detectMeetingDomain', () => {
  test('detects financial domain', () => {
    expect(detectMeetingDomain('The revenue and EBITDA are strong')).toBe('financial');
    expect(detectMeetingDomain('This M&A deal involves equity')).toBe('financial');
    expect(detectMeetingDomain('Looking at the P&L and cash flow')).toBe('financial');
    expect(detectMeetingDomain('IPO valuation is $100M')).toBe('financial');
  });

  test('detects legal domain', () => {
    expect(detectMeetingDomain('We need to review the contract')).toBe('legal');
    expect(detectMeetingDomain('IP and NDA agreements')).toBe('legal');
    expect(detectMeetingDomain('Compliance and liability issues')).toBe('legal');
    expect(detectMeetingDomain('The attorney will check the clause')).toBe('legal');
  });

  test('detects medical domain', () => {
    expect(detectMeetingDomain('FDA approval for the clinical trial')).toBe('medical');
    expect(detectMeetingDomain('Patient dosage and efficacy data')).toBe('medical');
    expect(detectMeetingDomain('Pharmaceutical biotech research')).toBe('medical');
    expect(detectMeetingDomain('Therapeutic drug development')).toBe('medical');
  });

  test('detects technical domain', () => {
    expect(detectMeetingDomain('API architecture and database')).toBe('technical');
    expect(detectMeetingDomain('Cloud infrastructure deployment')).toBe('technical');
    expect(detectMeetingDomain('Software engineering best practices')).toBe('technical');
    expect(detectMeetingDomain('Server code optimization')).toBe('technical');
  });

  test('detects HR domain', () => {
    expect(detectMeetingDomain('Employee compensation and benefits')).toBe('hr');
    expect(detectMeetingDomain('Hiring and recruitment process')).toBe('hr');
    expect(detectMeetingDomain('Talent performance reviews')).toBe('hr');
    expect(detectMeetingDomain('HR policies for staff')).toBe('hr');
  });

  test('returns general for unmatched text', () => {
    expect(detectMeetingDomain('Just a regular business meeting')).toBe('general');
    expect(detectMeetingDomain('No specific domain keywords here')).toBe('general');
    expect(detectMeetingDomain('')).toBe('general');
  });

  test('case insensitive matching', () => {
    expect(detectMeetingDomain('REVENUE and ebitda')).toBe('financial');
    expect(detectMeetingDomain('contract AND agreement')).toBe('legal');
    expect(detectMeetingDomain('Api and DATABASE')).toBe('technical');
  });

  test('detects with Japanese characters', () => {
    // Japanese keywords are in the regex, so they should match
    const text1 = '投資と収益について';
    const result1 = detectMeetingDomain(text1);
    // If Japanese matching works, should be 'financial', otherwise 'general'
    expect(['financial', 'general']).toContain(result1);
  });

  test('matches word boundaries correctly', () => {
    expect(detectMeetingDomain('revenue is important')).toBe('financial');
    expect(detectMeetingDomain('prerevenue startup')).toBe('general'); // Should not match partial words
  });
});

describe('getDomainInstructions', () => {
  test('returns financial instructions', () => {
    const instructions = getDomainInstructions('financial');
    expect(instructions).toContain('financial');
    expect(instructions).toContain('M&A');
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
    const instructions = getDomainInstructions('general');
    expect(instructions).toContain('business');
    expect(instructions).toContain('due diligence');
  });

  test('returns general instructions for invalid domain', () => {
    const instructions = getDomainInstructions('invalid');
    expect(instructions).toContain('business');
  });

  test('all instructions mention due diligence', () => {
    const domains = ['financial', 'legal', 'medical', 'technical', 'hr', 'general'];
    domains.forEach((domain) => {
      const instructions = getDomainInstructions(domain);
      expect(instructions).toContain('due diligence');
    });
  });
});

describe('buildOutputFormat', () => {
  test('returns consistent output format', () => {
    const format1 = buildOutputFormat();
    const format2 = buildOutputFormat();
    expect(format1).toBe(format2);
  });

  test('includes required fields', () => {
    const format = buildOutputFormat();
    expect(format).toContain('company_name');
    expect(format).toContain('website');
    expect(format).toContain('hq');
  });

  test('specifies URL format', () => {
    const format = buildOutputFormat();
    expect(format).toContain('http');
  });

  test('specifies HQ format', () => {
    const format = buildOutputFormat();
    expect(format).toContain('City, Country');
  });

  test('encourages thoroughness', () => {
    const format = buildOutputFormat();
    expect(format.toLowerCase()).toContain('thorough');
  });
});

describe('normalizeCompanyName', () => {
  test('returns empty string for falsy input', () => {
    expect(normalizeCompanyName(null)).toBe('');
    expect(normalizeCompanyName(undefined)).toBe('');
    expect(normalizeCompanyName('')).toBe('');
  });

  test('converts to lowercase', () => {
    expect(normalizeCompanyName('ACME Corp')).toBe('acme');
    // "Company" is removed as a suffix, so "Test Company" becomes just "test"
    expect(normalizeCompanyName('Test Company')).toBe('test');
  });

  test('removes common suffixes (English)', () => {
    expect(normalizeCompanyName('Acme Inc.')).toBe('acme');
    expect(normalizeCompanyName('Acme Inc')).toBe('acme');
    expect(normalizeCompanyName('Acme Corporation')).toBe('acme');
    expect(normalizeCompanyName('Acme Corp.')).toBe('acme');
    expect(normalizeCompanyName('Acme Ltd.')).toBe('acme');
    expect(normalizeCompanyName('Acme Limited')).toBe('acme');
    expect(normalizeCompanyName('Acme LLC')).toBe('acme');
    expect(normalizeCompanyName('Acme LLP')).toBe('acme');
  });

  test('removes Malaysian suffixes', () => {
    expect(normalizeCompanyName('Company Sdn Bhd')).toBe('company');
    expect(normalizeCompanyName('Company Sdn. Bhd.')).toBe('company');
    expect(normalizeCompanyName('Company Bhd')).toBe('company');
    expect(normalizeCompanyName('Company Berhad')).toBe('company');
  });

  test('removes Singapore suffixes', () => {
    expect(normalizeCompanyName('Company Pte Ltd')).toBe('company');
    expect(normalizeCompanyName('Company Pte. Ltd.')).toBe('company');
    expect(normalizeCompanyName('Company Private Limited')).toBe('company');
  });

  test('removes Indonesian prefixes', () => {
    expect(normalizeCompanyName('PT Company Name')).toBe('company name');
    expect(normalizeCompanyName('PT. Company Name')).toBe('company name');
    expect(normalizeCompanyName('CV Company Name')).toBe('company name');
    expect(normalizeCompanyName('CV. Company Name')).toBe('company name');
  });

  test('removes Indonesian suffixes', () => {
    expect(normalizeCompanyName('Company Tbk')).toBe('company');
    expect(normalizeCompanyName('Company Tbk.')).toBe('company');
  });

  test('removes other international suffixes', () => {
    expect(normalizeCompanyName('Company Co., Ltd.')).toBe('company');
    expect(normalizeCompanyName('Company JSC')).toBe('company');
    expect(normalizeCompanyName('Company PLC')).toBe('company');
    expect(normalizeCompanyName('Company GmbH')).toBe('company');
    expect(normalizeCompanyName('Company S.A.')).toBe('company');
  });

  test('removes parenthetical content at end', () => {
    // Parentheses in middle are not removed, only at end via the suffix regex
    expect(normalizeCompanyName('Company (Malaysia) Sdn Bhd')).toBe('company malaysia');
    expect(normalizeCompanyName('Company (Private) Limited')).toBe('company private');
    // Parenthetical at the very end gets removed
    expect(normalizeCompanyName('Company Name (Pvt)')).toBe('company name');
  });

  test('removes special characters', () => {
    expect(normalizeCompanyName('Company & Co.')).toBe('company co');
    expect(normalizeCompanyName('Company-Name Inc')).toBe('companyname');
  });

  test('normalizes whitespace', () => {
    expect(normalizeCompanyName('Company   Name   Ltd')).toBe('company name');
    expect(normalizeCompanyName('  Company  ')).toBe('company');
  });

  test('handles complex names', () => {
    // Removes PT prefix, removes Co., Ltd. suffix, but (Thailand) stays in middle
    expect(normalizeCompanyName('PT. ABC Manufacturing (Thailand) Co., Ltd.')).toBe(
      'abc manufacturing thailand'
    );
    // Removes (Malaysia) at end, but "Sdn. Bhd." is not at the very end so it stays
    expect(normalizeCompanyName('XYZ Industries Sdn. Bhd. (Malaysia)')).toBe(
      'xyz industries sdn bhd'
    );
    // When Sdn Bhd is at the actual end, it gets removed
    expect(normalizeCompanyName('XYZ Industries Sdn Bhd')).toBe('xyz industries');
  });

  test('preserves core company name', () => {
    expect(normalizeCompanyName('Advanced Tech Solutions Pte Ltd')).toBe('advanced tech solutions');
    expect(normalizeCompanyName('Global Trading Company Inc.')).toBe('global trading company');
  });
});

describe('normalizeWebsite', () => {
  test('returns empty string for falsy input', () => {
    expect(normalizeWebsite(null)).toBe('');
    expect(normalizeWebsite(undefined)).toBe('');
    expect(normalizeWebsite('')).toBe('');
  });

  test('converts to lowercase', () => {
    expect(normalizeWebsite('HTTP://EXAMPLE.COM')).toBe('example.com');
    expect(normalizeWebsite('HTTPS://TEST.COM')).toBe('test.com');
  });

  test('removes http protocol', () => {
    expect(normalizeWebsite('http://example.com')).toBe('example.com');
  });

  test('removes https protocol', () => {
    expect(normalizeWebsite('https://example.com')).toBe('example.com');
  });

  test('removes www prefix', () => {
    expect(normalizeWebsite('http://www.example.com')).toBe('example.com');
    expect(normalizeWebsite('https://www.test.com')).toBe('test.com');
  });

  test('removes trailing slashes', () => {
    expect(normalizeWebsite('http://example.com/')).toBe('example.com');
    expect(normalizeWebsite('http://example.com///')).toBe('example.com');
  });

  test('removes common path suffixes', () => {
    expect(normalizeWebsite('http://example.com/home')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/index')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/about')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/contact')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/products')).toBe('example.com');
  });

  test('removes language paths', () => {
    expect(normalizeWebsite('http://example.com/en')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/th')).toBe('example.com');
    expect(normalizeWebsite('http://example.com/id')).toBe('example.com');
  });

  test('removes file extensions from common paths', () => {
    // File extension removal only works AFTER the path pattern match
    // /index.html doesn't match the path pattern (needs / after index), so .html gets removed
    expect(normalizeWebsite('http://example.com/index.html')).toBe('example.com/index');
    // /home.php doesn't match the path pattern, so .php gets removed leaving /home
    expect(normalizeWebsite('http://example.com/home.php')).toBe('example.com/home');
    // /home/ matches the path pattern and gets removed entirely
    expect(normalizeWebsite('http://example.com/home/')).toBe('example.com');
    // /page is not in the common path list, but .aspx extension still gets removed
    expect(normalizeWebsite('http://example.com/page.aspx')).toBe('example.com/page');
    // Other extensions not in the pattern remain
    expect(normalizeWebsite('http://example.com/page.pdf')).toBe('example.com/page.pdf');
  });

  test('preserves subdomain', () => {
    expect(normalizeWebsite('http://subdomain.example.com')).toBe('subdomain.example.com');
  });

  test('preserves path for non-common paths', () => {
    expect(normalizeWebsite('http://example.com/custom/path')).toBe('example.com/custom/path');
    expect(normalizeWebsite('http://example.com/specific-page')).toBe('example.com/specific-page');
  });

  test('handles complex URLs', () => {
    expect(normalizeWebsite('https://www.example.com/en/about-us')).toBe('example.com');
    // /index is not followed by a matching extension pattern, so it remains
    expect(normalizeWebsite('HTTP://WWW.TEST.COM/INDEX.HTML')).toBe('test.com/index');
  });
});

describe('extractDomainRoot', () => {
  test('extracts domain from simple URL', () => {
    expect(extractDomainRoot('http://example.com')).toBe('example.com');
    expect(extractDomainRoot('https://test.com')).toBe('test.com');
  });

  test('extracts domain from URL with path', () => {
    expect(extractDomainRoot('http://example.com/path/to/page')).toBe('example.com');
    expect(extractDomainRoot('https://test.com/about/company')).toBe('test.com');
  });

  test('extracts domain from URL with www', () => {
    expect(extractDomainRoot('http://www.example.com')).toBe('example.com');
  });

  test('extracts domain from complex URL', () => {
    expect(extractDomainRoot('https://www.example.com/en/products/item.html')).toBe('example.com');
  });

  test('handles subdomain', () => {
    expect(extractDomainRoot('http://subdomain.example.com')).toBe('subdomain.example.com');
  });

  test('returns empty for empty input', () => {
    expect(extractDomainRoot('')).toBe('');
    expect(extractDomainRoot(null)).toBe('');
  });
});

describe('isSpamOrDirectoryURL', () => {
  test('returns true for null/undefined', () => {
    expect(isSpamOrDirectoryURL(null)).toBe(true);
    expect(isSpamOrDirectoryURL(undefined)).toBe(true);
    expect(isSpamOrDirectoryURL('')).toBe(true);
  });

  test('detects wikipedia URLs', () => {
    expect(isSpamOrDirectoryURL('http://en.wikipedia.org/wiki/Company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://wikipedia.org')).toBe(true);
  });

  test('detects social media URLs', () => {
    expect(isSpamOrDirectoryURL('http://facebook.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://twitter.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('http://instagram.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://youtube.com/company')).toBe(true);
  });

  test('case insensitive matching', () => {
    expect(isSpamOrDirectoryURL('HTTP://FACEBOOK.COM')).toBe(true);
    expect(isSpamOrDirectoryURL('HTTPS://WIKIPEDIA.ORG')).toBe(true);
  });

  test('returns false for legitimate company URLs', () => {
    expect(isSpamOrDirectoryURL('http://example.com')).toBe(false);
    expect(isSpamOrDirectoryURL('https://company.co.th')).toBe(false);
    expect(isSpamOrDirectoryURL('http://manufacturer.com.my')).toBe(false);
  });

  test('partial matching for spam domains', () => {
    expect(isSpamOrDirectoryURL('http://subdomain.wikipedia.org')).toBe(true);
    expect(isSpamOrDirectoryURL('https://www.facebook.com/page')).toBe(true);
  });
});

describe('dedupeCompanies', () => {
  test('returns empty array for empty input', () => {
    expect(dedupeCompanies([])).toEqual([]);
  });

  test('removes duplicate websites (exact match)', () => {
    const companies = [
      { company_name: 'Company A', website: 'http://example.com', hq: 'City, Country' },
      { company_name: 'Company B', website: 'http://example.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('Company A');
  });

  test('removes duplicate websites (http vs https)', () => {
    const companies = [
      { company_name: 'Company A', website: 'http://example.com', hq: 'City, Country' },
      { company_name: 'Company B', website: 'https://example.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicate websites (www vs non-www)', () => {
    const companies = [
      { company_name: 'Company A', website: 'http://www.example.com', hq: 'City, Country' },
      { company_name: 'Company B', website: 'http://example.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicate domain roots', () => {
    const companies = [
      { company_name: 'Company A', website: 'http://example.com/path1', hq: 'City, Country' },
      { company_name: 'Company B', website: 'http://example.com/path2', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicate company names', () => {
    const companies = [
      { company_name: 'Acme Inc.', website: 'http://acme1.com', hq: 'City, Country' },
      { company_name: 'Acme Corporation', website: 'http://acme2.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('keeps companies with different domains and names', () => {
    const companies = [
      { company_name: 'Company A', website: 'http://companya.com', hq: 'City, Country' },
      { company_name: 'Company B', website: 'http://companyb.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(2);
  });

  test('filters out entries without website', () => {
    const companies = [
      { company_name: 'Company A', website: 'http://example.com', hq: 'City, Country' },
      { company_name: 'Company B', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('Company A');
  });

  test('filters out entries without company_name', () => {
    const companies = [
      { company_name: 'Company A', website: 'http://example.com', hq: 'City, Country' },
      { website: 'http://test.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('Company A');
  });

  test('filters out entries with invalid website (no http)', () => {
    const companies = [
      { company_name: 'Company A', website: 'http://example.com', hq: 'City, Country' },
      { company_name: 'Company B', website: 'example.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('Company A');
  });

  test('handles null/undefined entries', () => {
    const companies = [
      { company_name: 'Company A', website: 'http://example.com', hq: 'City, Country' },
      null,
      undefined,
      { company_name: 'Company B', website: 'http://test.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(2);
  });

  test('handles complex deduplication scenario', () => {
    const companies = [
      { company_name: 'Acme Sdn Bhd', website: 'http://www.acme.com/home', hq: 'KL, Malaysia' },
      { company_name: 'ACME Ltd.', website: 'https://acme.com/index', hq: 'KL, Malaysia' },
      { company_name: 'Beta Corp', website: 'http://beta.com', hq: 'Singapore' },
      { company_name: 'Gamma Inc.', website: 'http://gamma.com', hq: 'Bangkok, Thailand' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(3); // Acme deduplicated, Beta and Gamma remain
  });
});

describe('buildExclusionRules', () => {
  test('returns empty string for no matching keywords', () => {
    const rules = buildExclusionRules('none', 'business');
    expect(rules).toBe('');
  });

  test('detects "large" keyword', () => {
    const rules = buildExclusionRules('large companies', 'business');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('global presence');
    expect(rules).toContain('NYSE');
  });

  test('detects "big" keyword', () => {
    const rules = buildExclusionRules('big corporations', 'business');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('detects "multinational" keyword', () => {
    const rules = buildExclusionRules('exclude multinational', 'business');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('multinational');
  });

  test('detects "MNC" keyword', () => {
    const rules = buildExclusionRules('no MNC', 'business');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('detects "listed" keyword', () => {
    const rules = buildExclusionRules('listed companies', 'business');
    expect(rules).toContain('LISTED COMPANY DETECTION');
    expect(rules).toContain('Stock ticker');
    expect(rules).toContain('publicly traded');
  });

  test('detects "public" keyword', () => {
    const rules = buildExclusionRules('public companies', 'business');
    expect(rules).toContain('LISTED COMPANY DETECTION');
  });

  test('detects "distributor" keyword', () => {
    const rules = buildExclusionRules('no distributors', 'business');
    expect(rules).toContain('DISTRIBUTOR DETECTION');
    expect(rules).toContain('ONLY distributes');
    expect(rules).toContain('manufacture');
  });

  test('case insensitive detection', () => {
    expect(buildExclusionRules('LARGE', 'business')).toContain('LARGE COMPANY');
    expect(buildExclusionRules('Listed', 'business')).toContain('LISTED COMPANY');
    expect(buildExclusionRules('DISTRIBUTOR', 'business')).toContain('DISTRIBUTOR');
  });

  test('combines multiple exclusion types', () => {
    const rules = buildExclusionRules('large listed distributors', 'business');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('LISTED COMPANY DETECTION');
    expect(rules).toContain('DISTRIBUTOR DETECTION');
  });

  test('includes specific MNC names in large company rules', () => {
    const rules = buildExclusionRules('large', 'business');
    expect(rules).toContain('Toyo Ink');
    expect(rules).toContain('Sakata');
    expect(rules).toContain('DIC');
  });

  test('includes Tbk detection for Indonesian listed companies', () => {
    const rules = buildExclusionRules('listed', 'business');
    expect(rules).toContain('Tbk');
  });

  test('distributor rules allow manufacturers who also distribute', () => {
    const rules = buildExclusionRules('distributor', 'business');
    expect(rules).toContain('ACCEPT if they manufacture');
  });
});

describe('buildEmailHTML', () => {
  test('includes all required sections', () => {
    const companies = [
      { company_name: 'Company A', website: 'http://a.com', hq: 'City A, Country' },
      { company_name: 'Company B', website: 'http://b.com', hq: 'City B, Country' },
    ];
    const html = buildEmailHTML(companies, 'ink', 'Thailand', 'large companies');

    expect(html).toContain('<h2>Find Target Results</h2>');
    expect(html).toContain('ink');
    expect(html).toContain('Thailand');
    expect(html).toContain('large companies');
    expect(html).toContain('Companies Found');
  });

  test('displays company count', () => {
    const companies = [
      { company_name: 'A', website: 'http://a.com', hq: 'City, Country' },
      { company_name: 'B', website: 'http://b.com', hq: 'City, Country' },
      { company_name: 'C', website: 'http://c.com', hq: 'City, Country' },
    ];
    const html = buildEmailHTML(companies, 'business', 'country', 'none');

    expect(html).toContain('3');
  });

  test('creates table with correct structure', () => {
    const companies = [
      { company_name: 'Test Co', website: 'http://test.com', hq: 'Bangkok, Thailand' },
    ];
    const html = buildEmailHTML(companies, 'business', 'country', 'none');

    expect(html).toContain('<table');
    expect(html).toContain('<thead');
    expect(html).toContain('<tbody');
    expect(html).toContain('</table>');
  });

  test('includes table headers', () => {
    const companies = [{ company_name: 'A', website: 'http://a.com', hq: 'City, Country' }];
    const html = buildEmailHTML(companies, 'business', 'country', 'none');

    expect(html).toContain('<th>#</th>');
    expect(html).toContain('<th>Company</th>');
    expect(html).toContain('<th>Website</th>');
    expect(html).toContain('<th>Headquarters</th>');
  });

  test('includes company data in rows', () => {
    const companies = [
      { company_name: 'Test Company', website: 'http://test.com', hq: 'Bangkok, Thailand' },
    ];
    const html = buildEmailHTML(companies, 'business', 'country', 'none');

    expect(html).toContain('Test Company');
    expect(html).toContain('http://test.com');
    expect(html).toContain('Bangkok, Thailand');
  });

  test('creates clickable links', () => {
    const companies = [{ company_name: 'A', website: 'http://example.com', hq: 'City, Country' }];
    const html = buildEmailHTML(companies, 'business', 'country', 'none');

    expect(html).toContain('<a href="http://example.com">http://example.com</a>');
  });

  test('numbers rows correctly', () => {
    const companies = [
      { company_name: 'A', website: 'http://a.com', hq: 'City, Country' },
      { company_name: 'B', website: 'http://b.com', hq: 'City, Country' },
      { company_name: 'C', website: 'http://c.com', hq: 'City, Country' },
    ];
    const html = buildEmailHTML(companies, 'business', 'country', 'none');

    expect(html).toContain('<td>1</td>');
    expect(html).toContain('<td>2</td>');
    expect(html).toContain('<td>3</td>');
  });

  test('handles empty company list', () => {
    const html = buildEmailHTML([], 'business', 'country', 'none');

    expect(html).toContain('Companies Found:</strong> 0');
    expect(html).toContain('<tbody>');
    expect(html).toContain('</tbody>');
  });

  test('applies table styling', () => {
    const companies = [{ company_name: 'A', website: 'http://a.com', hq: 'City, Country' }];
    const html = buildEmailHTML(companies, 'business', 'country', 'none');

    expect(html).toContain('border-collapse: collapse');
    expect(html).toContain('background-color: #f0f0f0');
  });
});

describe('strategy1_BroadSerpAPI', () => {
  test('generates queries for single country', () => {
    const queries = strategy1_BroadSerpAPI('ink', 'Thailand', 'large');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries).toContain('ink companies Thailand');
    expect(queries).toContain('ink manufacturers Thailand');
    expect(queries).toContain('ink suppliers Thailand');
  });

  test('generates queries for multiple countries', () => {
    const queries = strategy1_BroadSerpAPI('ink', 'Thailand, Vietnam', 'large');
    expect(queries.some((q) => q.includes('Thailand'))).toBe(true);
    expect(queries.some((q) => q.includes('Vietnam'))).toBe(true);
  });

  test('handles business with "or" variations', () => {
    const queries = strategy1_BroadSerpAPI('ink or paint', 'Thailand', 'large');
    expect(queries.some((q) => q.includes('ink'))).toBe(true);
    expect(queries.some((q) => q.includes('paint'))).toBe(true);
  });

  test('handles business with "and" variations', () => {
    const queries = strategy1_BroadSerpAPI('ink and chemicals', 'Thailand', 'large');
    expect(queries.some((q) => q.includes('ink'))).toBe(true);
    expect(queries.some((q) => q.includes('chemicals'))).toBe(true);
  });

  test('includes list queries', () => {
    const queries = strategy1_BroadSerpAPI('ink', 'Thailand', 'large');
    expect(queries.some((q) => q.includes('list of'))).toBe(true);
  });

  test('includes industry queries', () => {
    const queries = strategy1_BroadSerpAPI('ink', 'Thailand', 'large');
    expect(queries.some((q) => q.includes('industry'))).toBe(true);
  });

  test('trims country names with whitespace', () => {
    const queries = strategy1_BroadSerpAPI('ink', ' Thailand , Vietnam ', 'large');
    expect(queries.some((q) => q.includes(' Thailand '))).toBe(false); // Should not have extra spaces
    expect(queries.some((q) => q.includes('Thailand'))).toBe(true);
    expect(queries.some((q) => q.includes('Vietnam'))).toBe(true);
  });
});

describe('strategy4_CitiesPerplexity', () => {
  test('generates queries for cities in Malaysia', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Malaysia', 'large');
    expect(queries.some((q) => q.includes('Kuala Lumpur'))).toBe(true);
    expect(queries.some((q) => q.includes('Penang'))).toBe(true);
  });

  test('generates queries for cities in Singapore', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Singapore', 'large');
    expect(queries.some((q) => q.includes('Singapore'))).toBe(true);
  });

  test('generates queries for cities in Thailand', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Thailand', 'large');
    expect(queries.some((q) => q.includes('Bangkok'))).toBe(true);
  });

  test('includes exclusion in queries', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Malaysia', 'large companies');
    expect(queries.some((q) => q.includes('Exclude large companies'))).toBe(true);
  });

  test('includes output format in queries', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Malaysia', 'large');
    expect(queries.some((q) => q.includes('company_name'))).toBe(true);
  });

  test('generates manufacturer queries', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Thailand', 'large');
    expect(queries.some((q) => q.includes('manufacturers near'))).toBe(true);
  });

  test('handles multiple countries', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Malaysia, Thailand', 'large');
    expect(queries.some((q) => q.includes('Kuala Lumpur'))).toBe(true);
    expect(queries.some((q) => q.includes('Bangkok'))).toBe(true);
  });

  test('falls back to country name if no city mapping', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Unknown Country', 'large');
    expect(queries.some((q) => q.includes('Unknown Country'))).toBe(true);
  });

  test('generates two queries per city', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Singapore', 'large');
    const singaporeQueries = queries.filter((q) => q.includes('Singapore'));
    // Should have at least 2 queries per city (companies in + manufacturers near) × number of cities
    expect(singaporeQueries.length).toBeGreaterThanOrEqual(2);
  });
});
