/**
 * Unit tests for UTB service
 * Tests pure/testable functions: data transformation, validation, and utility functions
 */

// ============ PURE FUNCTIONS (copied from server.js) ============

function ensureString(value, defaultValue = '') {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return defaultValue;
  if (Array.isArray(value)) return value.map(v => ensureString(v)).join(', ');
  if (typeof value === 'object') {
    if (value.city && value.country) return `${value.city}, ${value.country}`;
    if (value.text) return ensureString(value.text);
    if (value.value) return ensureString(value.value);
    if (value.name) return ensureString(value.name);
    try { return JSON.stringify(value); } catch { return defaultValue; }
  }
  return String(value);
}

function buildOutputFormat() {
  return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
}

function normalizeCompanyName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\s*(sdn\.?\s*bhd\.?|bhd\.?|berhad|pte\.?\s*ltd\.?|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|co\.?,?\s*ltd\.?|llc|llp|gmbh|s\.?a\.?|pt\.?|cv\.?|tbk\.?|jsc|plc|public\s*limited|private\s*limited|joint\s*stock|company|\(.*?\))$/gi, '')
    .replace(/^(pt\.?|cv\.?)\s+/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWebsite(url) {
  if (!url) return '';
  return url.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .replace(/\/(home|index|main|default|about|about-us|contact|products?|services?|en|th|id|vn|my|sg|ph|company)(\/.*)?$/i, '')
    .replace(/\.(html?|php|aspx?|jsp)$/i, '');
}

function extractDomainRoot(url) {
  const normalized = normalizeWebsite(url);
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

function isSpamOrDirectoryURL(url) {
  if (!url) return true;
  const urlLower = url.toLowerCase();

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

function buildExclusionRules(exclusion, business) {
  const exclusionLower = exclusion.toLowerCase();
  let rules = '';

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

function buildEmailHTML(companies, business, country, exclusion) {
  // Mock escapeHtml function for testing
  const escapeHtml = (str) => {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  };

  let html = `
    <h2>Find Target Results</h2>
    <p><strong>Business:</strong> ${escapeHtml(business)}</p>
    <p><strong>Country:</strong> ${escapeHtml(country)}</p>
    <p><strong>Exclusion:</strong> ${escapeHtml(exclusion)}</p>
    <p><strong>Companies Found:</strong> ${companies.length}</p>
    <br>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
      <thead style="background-color: #f0f0f0;">
        <tr><th>#</th><th>Company</th><th>Website</th><th>Headquarters</th></tr>
      </thead>
      <tbody>
  `;
  companies.forEach((c, i) => {
    html += `<tr><td>${i + 1}</td><td>${escapeHtml(c.company_name)}</td><td><a href="${escapeHtml(c.website)}">${escapeHtml(c.website)}</a></td><td>${escapeHtml(c.hq)}</td></tr>`;
  });
  html += '</tbody></table>';
  return html;
}

function detectLanguage(website) {
  const domainMatch = website.match(/\.([a-z]{2,3})(?:\/|$)/i);
  const tld = domainMatch ? domainMatch[1].toLowerCase() : '';
  const languageMap = {
    'jp': { lang: 'Japanese', native: '日本語', searchPrefix: '日本語で' },
    'cn': { lang: 'Chinese', native: '中文', searchPrefix: '用中文' },
    'kr': { lang: 'Korean', native: '한국어', searchPrefix: '한국어로' },
    'de': { lang: 'German', native: 'Deutsch', searchPrefix: 'Auf Deutsch:' },
    'fr': { lang: 'French', native: 'Français', searchPrefix: 'En français:' },
    'th': { lang: 'Thai', native: 'ไทย', searchPrefix: 'ภาษาไทย:' },
    'vn': { lang: 'Vietnamese', native: 'Tiếng Việt', searchPrefix: 'Bằng tiếng Việt:' },
    'id': { lang: 'Indonesian', native: 'Indonesia', searchPrefix: 'Dalam Bahasa Indonesia:' },
    'tw': { lang: 'Chinese (Traditional)', native: '繁體中文', searchPrefix: '用繁體中文' }
  };
  return languageMap[tld] || null;
}

// ============ TESTS ============

describe('ensureString', () => {
  test('returns string as-is', () => {
    expect(ensureString('hello')).toBe('hello');
    expect(ensureString('test string')).toBe('test string');
  });

  test('returns default value for null/undefined', () => {
    expect(ensureString(null)).toBe('');
    expect(ensureString(undefined)).toBe('');
    expect(ensureString(null, 'default')).toBe('default');
  });

  test('joins arrays with comma', () => {
    expect(ensureString(['a', 'b', 'c'])).toBe('a, b, c');
    expect(ensureString([1, 2, 3])).toBe('1, 2, 3');
  });

  test('handles nested arrays', () => {
    expect(ensureString(['a', ['b', 'c']])).toBe('a, b, c');
  });

  test('extracts city/country from objects', () => {
    expect(ensureString({ city: 'Bangkok', country: 'Thailand' })).toBe('Bangkok, Thailand');
  });

  test('extracts text property from objects', () => {
    expect(ensureString({ text: 'hello' })).toBe('hello');
  });

  test('extracts value property from objects', () => {
    expect(ensureString({ value: 'world' })).toBe('world');
  });

  test('extracts name property from objects', () => {
    expect(ensureString({ name: 'Company Name' })).toBe('Company Name');
  });

  test('stringifies other objects', () => {
    expect(ensureString({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  test('converts numbers to strings', () => {
    expect(ensureString(123)).toBe('123');
    expect(ensureString(45.67)).toBe('45.67');
  });

  test('converts booleans to strings', () => {
    expect(ensureString(true)).toBe('true');
    expect(ensureString(false)).toBe('false');
  });
});

describe('buildOutputFormat', () => {
  test('returns consistent format string', () => {
    const format = buildOutputFormat();
    expect(format).toContain('company_name');
    expect(format).toContain('website');
    expect(format).toContain('hq');
    expect(format).toContain('City, Country');
    expect(format).toContain('http');
  });

  test('returns same value on multiple calls', () => {
    expect(buildOutputFormat()).toBe(buildOutputFormat());
  });
});

describe('normalizeCompanyName', () => {
  test('removes common legal suffixes', () => {
    expect(normalizeCompanyName('ABC Company Sdn Bhd')).toBe('abc company');
    expect(normalizeCompanyName('XYZ Pte Ltd')).toBe('xyz');
    expect(normalizeCompanyName('Test Inc.')).toBe('test');
    expect(normalizeCompanyName('Business Corp.')).toBe('business');
    expect(normalizeCompanyName('Sample Corporation')).toBe('sample');
    expect(normalizeCompanyName('Global Ltd')).toBe('global');
  });

  test('removes PT/CV prefixes', () => {
    expect(normalizeCompanyName('PT Acme Indonesia')).toBe('acme indonesia');
    expect(normalizeCompanyName('CV Test Company')).toBe('test');
    expect(normalizeCompanyName('PT. Sample Sdn Bhd')).toBe('sample');
  });

  test('removes special characters and normalizes spaces', () => {
    expect(normalizeCompanyName('ABC-Company  Ltd.')).toBe('abccompany');
    expect(normalizeCompanyName('Test & Co.')).toBe('test co');
    expect(normalizeCompanyName('Multi   Space   Company')).toBe('multi space');
  });

  test('handles empty/null input', () => {
    expect(normalizeCompanyName('')).toBe('');
    expect(normalizeCompanyName(null)).toBe('');
    expect(normalizeCompanyName(undefined)).toBe('');
  });

  test('removes parenthetical content', () => {
    expect(normalizeCompanyName('ABC (Thailand) Ltd')).toBe('abc thailand');
    expect(normalizeCompanyName('Test (Asia Pacific)')).toBe('test');
  });

  test('handles Indonesian Tbk suffix', () => {
    expect(normalizeCompanyName('PT Industri Tbk')).toBe('industri');
  });

  test('handles JSC and PLC suffixes', () => {
    expect(normalizeCompanyName('Tech JSC')).toBe('tech');
    expect(normalizeCompanyName('Business PLC')).toBe('business');
  });

  test('lowercases all text', () => {
    expect(normalizeCompanyName('ACME CORPORATION')).toBe('acme');
    expect(normalizeCompanyName('TeSt CoMpAnY')).toBe('test');
  });
});

describe('normalizeWebsite', () => {
  test('removes protocol and www', () => {
    expect(normalizeWebsite('https://www.example.com')).toBe('example.com');
    expect(normalizeWebsite('http://example.com')).toBe('example.com');
    expect(normalizeWebsite('https://example.com')).toBe('example.com');
  });

  test('removes trailing slashes', () => {
    expect(normalizeWebsite('https://example.com/')).toBe('example.com');
    expect(normalizeWebsite('https://example.com///')).toBe('example.com');
  });

  test('removes common path suffixes', () => {
    expect(normalizeWebsite('https://example.com/home')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/about-us')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/contact')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/products')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/services')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/en')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/th')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/company')).toBe('example.com');
  });

  test('removes file extensions', () => {
    expect(normalizeWebsite('https://example.com/index.html')).toBe('example.com/index');
    expect(normalizeWebsite('https://example.com/page.php')).toBe('example.com/page');
    expect(normalizeWebsite('https://example.com/about.aspx')).toBe('example.com/about');
  });

  test('handles empty input', () => {
    expect(normalizeWebsite('')).toBe('');
    expect(normalizeWebsite(null)).toBe('');
    expect(normalizeWebsite(undefined)).toBe('');
  });

  test('preserves significant paths', () => {
    expect(normalizeWebsite('https://example.com/special-page')).toBe('example.com/special-page');
    expect(normalizeWebsite('https://example.com/products/category')).toBe('example.com');
  });

  test('lowercases URLs', () => {
    expect(normalizeWebsite('HTTPS://WWW.EXAMPLE.COM')).toBe('example.com');
    expect(normalizeWebsite('https://Example.COM/Home')).toBe('example.com');
  });
});

describe('extractDomainRoot', () => {
  test('extracts domain without path', () => {
    expect(extractDomainRoot('https://example.com/path/to/page')).toBe('example.com');
    expect(extractDomainRoot('https://www.test.com/home')).toBe('test.com');
    expect(extractDomainRoot('http://business.co.id/products')).toBe('business.co.id');
  });

  test('handles URLs without path', () => {
    expect(extractDomainRoot('https://example.com')).toBe('example.com');
    expect(extractDomainRoot('http://test.net')).toBe('test.net');
  });

  test('removes www from domain', () => {
    expect(extractDomainRoot('https://www.example.com/page')).toBe('example.com');
  });

  test('handles empty/null URLs', () => {
    expect(extractDomainRoot('')).toBe('');
    expect(extractDomainRoot(null)).toBe('');
  });
});

describe('dedupeCompanies', () => {
  test('removes duplicate websites', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://example.com', hq: 'City, Country' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('removes duplicate domains', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com/home', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://example.com/about', hq: 'City, Country' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicate company names', () => {
    const companies = [
      { company_name: 'ABC Ltd', website: 'https://abc1.com', hq: 'City, Country' },
      { company_name: 'ABC Limited', website: 'https://abc2.com', hq: 'City, Country' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('filters out invalid entries', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: null, hq: 'City, Country' },
      { company_name: null, website: 'https://test.com', hq: 'City, Country' },
      { company_name: 'DEF', website: 'not-http-url', hq: 'City, Country' },
      null,
      undefined
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('keeps unique companies', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://abc.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://xyz.com', hq: 'City, Country' },
      { company_name: 'DEF', website: 'https://def.com', hq: 'City, Country' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(3);
  });

  test('handles www variations', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://www.example.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://example.com', hq: 'City, Country' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('handles empty array', () => {
    expect(dedupeCompanies([])).toEqual([]);
  });
});

describe('isSpamOrDirectoryURL', () => {
  test('detects social media URLs', () => {
    expect(isSpamOrDirectoryURL('https://facebook.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://twitter.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://www.instagram.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://youtube.com/channel/123')).toBe(true);
  });

  test('detects Wikipedia URLs', () => {
    expect(isSpamOrDirectoryURL('https://en.wikipedia.org/wiki/Company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://wikipedia.org/Company')).toBe(true);
  });

  test('accepts valid company URLs', () => {
    expect(isSpamOrDirectoryURL('https://mycompany.com')).toBe(false);
    expect(isSpamOrDirectoryURL('https://business.co.id')).toBe(false);
    expect(isSpamOrDirectoryURL('https://example-company.net')).toBe(false);
  });

  test('returns true for null/empty URLs', () => {
    expect(isSpamOrDirectoryURL(null)).toBe(true);
    expect(isSpamOrDirectoryURL('')).toBe(true);
    expect(isSpamOrDirectoryURL(undefined)).toBe(true);
  });

  test('is case insensitive', () => {
    expect(isSpamOrDirectoryURL('https://FACEBOOK.COM/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://YouTube.com/channel')).toBe(true);
  });
});

describe('buildExclusionRules', () => {
  test('builds rules for large company exclusion', () => {
    const rules = buildExclusionRules('large companies', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('global presence');
    expect(rules).toContain('NYSE');
    expect(rules).toContain('multinational');
  });

  test('detects "big" as synonym for large', () => {
    const rules = buildExclusionRules('big companies', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('detects "mnc" as large companies', () => {
    const rules = buildExclusionRules('MNC companies', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('builds rules for listed company exclusion', () => {
    const rules = buildExclusionRules('listed companies', 'ink');
    expect(rules).toContain('LISTED COMPANY DETECTION');
    expect(rules).toContain('publicly traded');
    expect(rules).toContain('Stock ticker');
  });

  test('builds rules for distributor exclusion', () => {
    const rules = buildExclusionRules('distributors', 'ink');
    expect(rules).toContain('DISTRIBUTOR DETECTION');
    expect(rules).toContain('distributes/resells');
    expect(rules).toContain('manufacture');
  });

  test('combines multiple exclusion types', () => {
    const rules = buildExclusionRules('large multinational listed companies', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('LISTED COMPANY DETECTION');
  });

  test('returns empty for no exclusions', () => {
    const rules = buildExclusionRules('', 'ink');
    expect(rules).toBe('');
  });

  test('is case insensitive', () => {
    const rules = buildExclusionRules('LARGE COMPANIES', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('detects "multinational" keyword', () => {
    const rules = buildExclusionRules('exclude multinational corporations', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('detects "public" as synonym for listed', () => {
    const rules = buildExclusionRules('public companies', 'ink');
    expect(rules).toContain('LISTED COMPANY DETECTION');
  });
});

describe('buildEmailHTML', () => {
  test('builds valid HTML with company data', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://abc.com', hq: 'Bangkok, Thailand' },
      { company_name: 'XYZ', website: 'https://xyz.com', hq: 'Jakarta, Indonesia' }
    ];
    const html = buildEmailHTML(companies, 'ink manufacturing', 'Thailand', 'large companies');

    expect(html).toContain('<h2>Find Target Results</h2>');
    expect(html).toContain('ink manufacturing');
    expect(html).toContain('Thailand');
    expect(html).toContain('large companies');
    expect(html).toContain('Companies Found:</strong> 2');
    expect(html).toContain('ABC');
    expect(html).toContain('XYZ');
    expect(html).toContain('https://abc.com');
    expect(html).toContain('Bangkok, Thailand');
  });

  test('escapes HTML in company data', () => {
    const companies = [
      { company_name: 'A&B <Script>', website: 'https://test.com', hq: 'City' }
    ];
    const html = buildEmailHTML(companies, 'test', 'country', 'none');

    expect(html).toContain('A&amp;B &lt;Script&gt;');
    expect(html).not.toContain('<Script>');
  });

  test('handles empty company list', () => {
    const html = buildEmailHTML([], 'business', 'country', 'exclusion');
    expect(html).toContain('Companies Found:</strong> 0');
    expect(html).toContain('<tbody>');
  });

  test('generates table rows with correct numbering', () => {
    const companies = [
      { company_name: 'A', website: 'https://a.com', hq: 'City' },
      { company_name: 'B', website: 'https://b.com', hq: 'City' },
      { company_name: 'C', website: 'https://c.com', hq: 'City' }
    ];
    const html = buildEmailHTML(companies, 'test', 'country', 'none');

    expect(html).toContain('<td>1</td>');
    expect(html).toContain('<td>2</td>');
    expect(html).toContain('<td>3</td>');
  });

  test('creates clickable links for websites', () => {
    const companies = [
      { company_name: 'Test', website: 'https://test.com', hq: 'City' }
    ];
    const html = buildEmailHTML(companies, 'test', 'country', 'none');

    expect(html).toContain('<a href="https://test.com">https://test.com</a>');
  });
});

describe('detectLanguage', () => {
  test('detects Japanese domains', () => {
    const lang = detectLanguage('https://example.jp');
    expect(lang).toEqual({
      lang: 'Japanese',
      native: '日本語',
      searchPrefix: '日本語で'
    });
  });

  test('detects Chinese domains', () => {
    const lang = detectLanguage('https://example.cn');
    expect(lang).toEqual({
      lang: 'Chinese',
      native: '中文',
      searchPrefix: '用中文'
    });
  });

  test('detects Korean domains', () => {
    const lang = detectLanguage('https://example.kr');
    expect(lang).toEqual({
      lang: 'Korean',
      native: '한국어',
      searchPrefix: '한국어로'
    });
  });

  test('detects German domains', () => {
    const lang = detectLanguage('https://example.de');
    expect(lang).toEqual({
      lang: 'German',
      native: 'Deutsch',
      searchPrefix: 'Auf Deutsch:'
    });
  });

  test('detects French domains', () => {
    const lang = detectLanguage('https://example.fr');
    expect(lang).toEqual({
      lang: 'French',
      native: 'Français',
      searchPrefix: 'En français:'
    });
  });

  test('detects Thai domains', () => {
    const lang = detectLanguage('https://example.th');
    expect(lang).toEqual({
      lang: 'Thai',
      native: 'ไทย',
      searchPrefix: 'ภาษาไทย:'
    });
  });

  test('detects Vietnamese domains', () => {
    const lang = detectLanguage('https://example.vn');
    expect(lang).toEqual({
      lang: 'Vietnamese',
      native: 'Tiếng Việt',
      searchPrefix: 'Bằng tiếng Việt:'
    });
  });

  test('detects Indonesian domains', () => {
    const lang = detectLanguage('https://example.id');
    expect(lang).toEqual({
      lang: 'Indonesian',
      native: 'Indonesia',
      searchPrefix: 'Dalam Bahasa Indonesia:'
    });
  });

  test('detects Taiwanese domains', () => {
    const lang = detectLanguage('https://example.tw');
    expect(lang).toEqual({
      lang: 'Chinese (Traditional)',
      native: '繁體中文',
      searchPrefix: '用繁體中文'
    });
  });

  test('returns null for unknown TLDs', () => {
    expect(detectLanguage('https://example.com')).toBe(null);
    expect(detectLanguage('https://example.net')).toBe(null);
    expect(detectLanguage('https://example.org')).toBe(null);
  });

  test('handles URLs with paths', () => {
    const lang = detectLanguage('https://example.jp/path/to/page');
    expect(lang).not.toBe(null);
    expect(lang.lang).toBe('Japanese');
  });

  test('handles URLs with subdomains', () => {
    const lang = detectLanguage('https://www.example.cn');
    expect(lang).not.toBe(null);
    expect(lang.lang).toBe('Chinese');
  });

  test('is case insensitive', () => {
    const lang = detectLanguage('https://example.JP');
    expect(lang).not.toBe(null);
    expect(lang.lang).toBe('Japanese');
  });
});
