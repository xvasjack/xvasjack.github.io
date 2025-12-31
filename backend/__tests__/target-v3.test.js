/**
 * Unit tests for target-v3 service
 * Tests pure functions for data transformation, validation, search strategies, and utilities
 */

// Re-implement testable utilities here (extracted from target-v3/server.js)
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

function preFilterCompanies(companies) {
  return companies.filter((c) => {
    if (!c || !c.website) return false;
    if (isSpamOrDirectoryURL(c.website)) {
      return false;
    }
    return true;
  });
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

// ============ EMAIL BUILDER ============

// Mock escapeHtml for testing
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailHTML(companies, business, country, exclusion) {
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

// ============ SEARCH STRATEGIES ============

function strategy1_BroadSerpAPI(business, country, exclusion) {
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

function strategy2_BroadPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  queries.push(
    `Find ALL ${business} companies headquartered in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Complete list of ${business} manufacturers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} producers and makers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `All local ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `SME and family-owned ${business} businesses in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `Independent ${business} companies in ${country} not owned by multinationals. ${outputFormat}`
  );

  for (const c of countries) {
    queries.push(
      `List all ${business} companies based in ${c}. ${outputFormat}`,
      `${business} factories and plants in ${c}. ${outputFormat}`,
      `Local ${business} manufacturers in ${c}. ${outputFormat}`
    );
  }

  return queries;
}

function strategy3_ListsSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  for (const c of countries) {
    queries.push(
      `top ${business} companies ${c}`,
      `biggest ${business} ${c}`,
      `leading ${business} manufacturers ${c}`,
      `list of ${business} ${c}`,
      `best ${business} suppliers ${c}`,
      `${business} industry ${c} overview`,
      `major ${business} players ${c}`
    );
  }

  return queries;
}

function strategy4_CitiesPerplexity(business, country, exclusion) {
  const CITY_MAP = {
    malaysia: [
      'Kuala Lumpur',
      'Penang',
      'Johor Bahru',
      'Shah Alam',
      'Petaling Jaya',
      'Selangor',
      'Ipoh',
      'Klang',
      'Subang',
      'Melaka',
      'Kuching',
      'Kota Kinabalu',
    ],
    singapore: ['Singapore', 'Jurong', 'Tuas', 'Woodlands'],
    thailand: [
      'Bangkok',
      'Chonburi',
      'Rayong',
      'Samut Prakan',
      'Ayutthaya',
      'Chiang Mai',
      'Pathum Thani',
      'Nonthaburi',
      'Samut Sakhon',
    ],
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

function strategy5_IndustrialSerpAPI(business, country, exclusion) {
  const LOCAL_SUFFIXES = {
    malaysia: ['Sdn Bhd', 'Berhad'],
    singapore: ['Pte Ltd', 'Private Limited'],
    thailand: ['Co Ltd', 'Co., Ltd.'],
  };

  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  for (const c of countries) {
    const suffixes = LOCAL_SUFFIXES[c.toLowerCase()] || [];

    for (const suffix of suffixes) {
      queries.push(`${business} ${suffix} ${c}`);
    }

    queries.push(
      `${business} industrial estate ${c}`,
      `${business} manufacturing zone ${c}`,
      `${business} factory ${c}`
    );
  }

  return queries;
}

function strategy6_DirectoriesPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} companies in trade associations in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} firms in Kompass directory for ${country}. Not ${exclusion}. ${outputFormat}`,
    `Chamber of commerce ${business} members in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${country} ${business} industry association member list. No ${exclusion}. ${outputFormat}`,
    `${business} companies on Yellow Pages ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} business directory ${country}. Exclude ${exclusion}. ${outputFormat}`,
  ];
}

function strategy7_ExhibitionsPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} exhibitors at trade shows in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} companies at industry exhibitions in ${country} region. Not ${exclusion}. ${outputFormat}`,
    `${business} participants at expos and conferences in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} exhibitors at international fairs from ${country}. Not ${exclusion}. ${outputFormat}`,
  ];
}

function strategy8_TradePerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} importers and exporters in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} suppliers on Alibaba from ${country}. Not ${exclusion}. ${outputFormat}`,
    `${country} ${business} companies on Global Sources. Exclude ${exclusion}. ${outputFormat}`,
    `${business} OEM suppliers in ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} contract manufacturers in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} approved vendors in ${country}. Exclude ${exclusion}. ${outputFormat}`,
  ];
}

function strategy9_DomainsPerplexity(business, country, exclusion) {
  const DOMAIN_MAP = {
    malaysia: '.my',
    singapore: '.sg',
    thailand: '.th',
  };

  const countries = country.split(',').map((c) => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  for (const c of countries) {
    const domain = DOMAIN_MAP[c.toLowerCase()];
    if (domain) {
      queries.push(
        `${business} companies with ${domain} websites. Exclude ${exclusion}. ${outputFormat}`
      );
    }
  }

  queries.push(
    `Recent news about ${business} companies in ${country}. Not ${exclusion}. ${outputFormat}`,
    `${business} company announcements and press releases ${country}. Exclude ${exclusion}. ${outputFormat}`
  );

  return queries;
}

function strategy10_RegistriesSerpAPI(business, country, exclusion) {
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  for (const c of countries) {
    queries.push(
      `${business} company registration ${c}`,
      `${business} registered companies ${c}`,
      `${business} business registry ${c}`
    );
  }

  return queries;
}

function strategy11_CityIndustrialSerpAPI(business, country, exclusion) {
  const CITY_MAP = {
    malaysia: ['Kuala Lumpur', 'Penang', 'Johor Bahru'],
    singapore: ['Singapore', 'Jurong'],
    thailand: ['Bangkok', 'Chonburi'],
  };

  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  for (const c of countries) {
    const cities = CITY_MAP[c.toLowerCase()] || [c];
    for (const city of cities) {
      queries.push(
        `${business} ${city}`,
        `${business} companies ${city}`,
        `${business} factory ${city}`,
        `${business} manufacturer ${city}`
      );
    }
  }

  return queries;
}

function strategy12_DeepOpenAISearch(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  const countries = country.split(',').map((c) => c.trim());
  const queries = [];

  queries.push(
    `Search the web for ${business} companies in ${country}. Find company websites, LinkedIn profiles, industry directories. Exclude ${exclusion}. ${outputFormat}`,
    `Find lesser-known ${business} companies in ${country} that may not appear in top search results. ${outputFormat}`,
    `Search for small and medium ${business} enterprises (SMEs) in ${country}. ${outputFormat}`,
    `Find independent local ${business} companies in ${country}, not subsidiaries of multinationals. ${outputFormat}`,
    `Search industry news and press releases for ${business} companies in ${country}. ${outputFormat}`,
    `Find ${business} startups and new companies in ${country}. ${outputFormat}`
  );

  for (const c of countries) {
    queries.push(
      `Search for all ${business} manufacturers in ${c}. Include company name, website, and location. ${outputFormat}`,
      `Find ${business} producers in ${c} with their official websites. ${outputFormat}`
    );
  }

  return queries;
}

function strategy13_PublicationsPerplexity(business, country, exclusion) {
  const outputFormat = buildOutputFormat();
  return [
    `${business} companies mentioned in industry magazines and trade publications for ${country}. Exclude ${exclusion}. ${outputFormat}`,
    `${business} market report ${country} - list all companies mentioned. Not ${exclusion}. ${outputFormat}`,
    `${business} industry analysis ${country} - companies covered. Exclude ${exclusion}. ${outputFormat}`,
    `${business} ${country} magazine articles listing companies. Not ${exclusion}. ${outputFormat}`,
  ];
}

function strategy14_LocalLanguageOpenAISearch(business, country, exclusion) {
  const LOCAL_LANGUAGE_MAP = {
    thailand: { lang: 'Thai', examples: ['หมึก', 'สี', 'เคมี'] },
    vietnam: { lang: 'Vietnamese', examples: ['mực in', 'sơn', 'hóa chất'] },
    malaysia: { lang: 'Bahasa Malaysia', examples: ['dakwat', 'cat'] },
  };

  const countries = country.split(',').map((c) => c.trim());
  const outputFormat = buildOutputFormat();
  const queries = [];

  queries.push(
    `Search for ${business} companies in ${country} using local language terms. Translate "${business}" to Thai, Vietnamese, Bahasa Indonesia, Tagalog, Malay as appropriate. ${outputFormat}`
  );

  for (const c of countries) {
    const langInfo = LOCAL_LANGUAGE_MAP[c.toLowerCase()];
    if (langInfo) {
      queries.push(
        `Search in ${langInfo.lang} for ${business} companies in ${c}. ${outputFormat}`,
        `Find ${business} manufacturers in ${c} using local language search terms. ${outputFormat}`
      );
    }
  }

  queries.push(
    `Find companies in the ${business} supply chain in ${country}. Include raw material suppliers and equipment makers. ${outputFormat}`,
    `Search for ${business} related companies in ${country}: formulators, blenders, repackagers. ${outputFormat}`,
    `Find niche and specialty ${business} companies in ${country}. ${outputFormat}`
  );

  queries.push(
    `Comprehensive search: Find ALL ${business} companies in ${country} that have not been mentioned yet. Search obscure directories, local business listings, industry forums. ${outputFormat}`
  );

  return queries;
}

// ============ TESTS ============

describe('ensureString', () => {
  test('returns string as-is', () => {
    expect(ensureString('hello')).toBe('hello');
    expect(ensureString('')).toBe('');
    expect(ensureString('test 123')).toBe('test 123');
  });

  test('returns default for null/undefined', () => {
    expect(ensureString(null)).toBe('');
    expect(ensureString(undefined)).toBe('');
    expect(ensureString(null, 'N/A')).toBe('N/A');
    expect(ensureString(undefined, 'default')).toBe('default');
  });

  test('joins arrays with comma', () => {
    expect(ensureString(['a', 'b', 'c'])).toBe('a, b, c');
    expect(ensureString([])).toBe('');
    expect(ensureString(['single'])).toBe('single');
  });

  test('extracts city/country from object', () => {
    expect(ensureString({ city: 'Bangkok', country: 'Thailand' })).toBe('Bangkok, Thailand');
    expect(ensureString({ city: 'Singapore', country: 'Singapore' })).toBe('Singapore, Singapore');
  });

  test('extracts text/value/name from object', () => {
    expect(ensureString({ text: 'hello world' })).toBe('hello world');
    expect(ensureString({ value: 'test value' })).toBe('test value');
    expect(ensureString({ name: 'company name' })).toBe('company name');
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

describe('preFilterCompanies', () => {
  test('filters out companies with spam URLs', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://company.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://wikipedia.org/wiki/Company', hq: 'City, Country' },
      { company_name: 'DEF', website: 'https://facebook.com/company', hq: 'City, Country' },
    ];
    const result = preFilterCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('filters out companies without website', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://company.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: null, hq: 'City, Country' },
      { company_name: 'DEF', hq: 'City, Country' },
    ];
    const result = preFilterCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('filters out null/undefined entries', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://company.com', hq: 'City, Country' },
      null,
      undefined,
      { company_name: 'XYZ', website: 'https://xyz.com', hq: 'City, Country' },
    ];
    const result = preFilterCompanies(companies);
    expect(result).toHaveLength(2);
  });

  test('accepts valid company URLs', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://abc.com', hq: 'KL, Malaysia' },
      { company_name: 'XYZ', website: 'https://xyz.co.th', hq: 'Bangkok, Thailand' },
      { company_name: 'DEF', website: 'http://def.sg', hq: 'Singapore, Singapore' },
    ];
    const result = preFilterCompanies(companies);
    expect(result).toHaveLength(3);
  });

  test('handles empty array', () => {
    expect(preFilterCompanies([])).toEqual([]);
  });
});

describe('buildOutputFormat', () => {
  test('returns output format string with required fields', () => {
    const format = buildOutputFormat();
    expect(format).toContain('company_name');
    expect(format).toContain('website');
    expect(format).toContain('hq');
  });

  test('specifies URL format requirement', () => {
    const format = buildOutputFormat();
    expect(format).toContain('URL starting with http');
  });

  test('specifies HQ format requirement', () => {
    const format = buildOutputFormat();
    expect(format).toContain('City, Country');
  });

  test('includes thoroughness instruction', () => {
    const format = buildOutputFormat();
    expect(format).toContain('thorough');
    expect(format).toContain('verify them later');
  });
});

describe('buildExclusionRules', () => {
  test('builds large company exclusion rules', () => {
    const rules = buildExclusionRules('exclude large companies', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('global presence');
    expect(rules).toContain('NYSE');
    expect(rules).toContain('NASDAQ');
    expect(rules).toContain('Fortune 500');
    expect(rules).toContain('subsidiary of');
  });

  test('detects "big" keyword', () => {
    const rules = buildExclusionRules('exclude big companies', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('detects "MNC" keyword', () => {
    const rules = buildExclusionRules('exclude MNC', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('multinational');
  });

  test('detects "multinational" keyword', () => {
    const rules = buildExclusionRules('no multinationals', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('builds listed company exclusion rules', () => {
    const rules = buildExclusionRules('exclude listed companies', 'ink');
    expect(rules).toContain('LISTED COMPANY DETECTION');
    expect(rules).toContain('publicly traded');
    expect(rules).toContain('Stock ticker');
    expect(rules).toContain('Tbk');
  });

  test('detects "public" keyword for listed companies', () => {
    const rules = buildExclusionRules('exclude public companies', 'ink');
    expect(rules).toContain('LISTED COMPANY DETECTION');
  });

  test('builds distributor exclusion rules', () => {
    const rules = buildExclusionRules('exclude distributors', 'ink');
    expect(rules).toContain('DISTRIBUTOR DETECTION');
    expect(rules).toContain('manufacturing');
    expect(rules).toContain('factory');
  });

  test('builds multiple exclusion rules when combined', () => {
    const rules = buildExclusionRules('exclude large listed companies and distributors', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('LISTED COMPANY DETECTION');
    expect(rules).toContain('DISTRIBUTOR DETECTION');
  });

  test('returns empty string for non-matching exclusion', () => {
    const rules = buildExclusionRules('no exclusions', 'ink');
    expect(rules).toBe('');
  });

  test('handles case-insensitive matching', () => {
    const rules = buildExclusionRules('EXCLUDE LARGE COMPANIES', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('includes known MNC names in large company rules', () => {
    const rules = buildExclusionRules('exclude large', 'ink');
    expect(rules).toContain('Toyo Ink');
    expect(rules).toContain('Sakata');
    expect(rules).toContain('Sun Chemical');
  });
});

describe('buildEmailHTML', () => {
  test('builds valid HTML structure', () => {
    const companies = [{ company_name: 'ABC Co', website: 'https://abc.com', hq: 'KL, Malaysia' }];
    const html = buildEmailHTML(companies, 'ink', 'Malaysia', 'large');

    expect(html).toContain('<h2>Find Target Results</h2>');
    expect(html).toContain('<table');
    expect(html).toContain('<thead');
    expect(html).toContain('<tbody');
  });

  test('includes search parameters in email', () => {
    const companies = [];
    const html = buildEmailHTML(companies, 'ink manufacturers', 'Thailand', 'large MNC');

    expect(html).toContain('ink manufacturers');
    expect(html).toContain('Thailand');
    expect(html).toContain('large MNC');
  });

  test('shows company count', () => {
    const companies = [
      { company_name: 'A', website: 'https://a.com', hq: 'City, Country' },
      { company_name: 'B', website: 'https://b.com', hq: 'City, Country' },
      { company_name: 'C', website: 'https://c.com', hq: 'City, Country' },
    ];
    const html = buildEmailHTML(companies, 'ink', 'Malaysia', 'large');

    expect(html).toContain('Companies Found:</strong> 3');
  });

  test('includes table headers', () => {
    const companies = [];
    const html = buildEmailHTML(companies, 'ink', 'Malaysia', 'large');

    expect(html).toContain('<th>#</th>');
    expect(html).toContain('<th>Company</th>');
    expect(html).toContain('<th>Website</th>');
    expect(html).toContain('<th>Headquarters</th>');
  });

  test('renders company data in table rows', () => {
    const companies = [
      { company_name: 'ABC Ink', website: 'https://abc-ink.com', hq: 'Bangkok, Thailand' },
      { company_name: 'XYZ Paint', website: 'https://xyz.com', hq: 'Singapore, Singapore' },
    ];
    const html = buildEmailHTML(companies, 'ink', 'Thailand', 'large');

    expect(html).toContain('ABC Ink');
    expect(html).toContain('https://abc-ink.com');
    expect(html).toContain('Bangkok, Thailand');
    expect(html).toContain('XYZ Paint');
    expect(html).toContain('https://xyz.com');
    expect(html).toContain('Singapore, Singapore');
  });

  test('numbers rows correctly', () => {
    const companies = [
      { company_name: 'A', website: 'https://a.com', hq: 'City, Country' },
      { company_name: 'B', website: 'https://b.com', hq: 'City, Country' },
    ];
    const html = buildEmailHTML(companies, 'ink', 'Malaysia', 'large');

    expect(html).toContain('<td>1</td>');
    expect(html).toContain('<td>2</td>');
  });

  test('escapes HTML in company data', () => {
    const companies = [
      { company_name: 'A&B <Script>', website: 'https://test.com', hq: 'City, Country' },
    ];
    const html = buildEmailHTML(companies, 'ink', 'Malaysia', 'large');

    expect(html).toContain('&amp;');
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    expect(html).not.toContain('<Script>');
  });

  test('creates clickable website links', () => {
    const companies = [{ company_name: 'ABC', website: 'https://abc.com', hq: 'City, Country' }];
    const html = buildEmailHTML(companies, 'ink', 'Malaysia', 'large');

    expect(html).toContain('<a href="https://abc.com">https://abc.com</a>');
  });

  test('handles empty company list', () => {
    const html = buildEmailHTML([], 'ink', 'Malaysia', 'large');

    expect(html).toContain('Companies Found:</strong> 0');
    expect(html).toContain('<tbody>');
  });
});

describe('strategy1_BroadSerpAPI', () => {
  test('generates basic search queries for single country', () => {
    const queries = strategy1_BroadSerpAPI('ink', 'Malaysia', 'large');

    expect(queries).toContain('ink companies Malaysia');
    expect(queries).toContain('ink manufacturers Malaysia');
    expect(queries).toContain('ink suppliers Malaysia');
    expect(queries).toContain('list of ink companies in Malaysia');
    expect(queries).toContain('ink industry Malaysia');
  });

  test('generates queries for multiple countries', () => {
    const queries = strategy1_BroadSerpAPI('ink', 'Malaysia, Thailand', 'large');

    expect(queries.some((q) => q.includes('Malaysia'))).toBe(true);
    expect(queries.some((q) => q.includes('Thailand'))).toBe(true);
  });

  test('splits business terms with "or"', () => {
    const queries = strategy1_BroadSerpAPI('ink or paint', 'Malaysia', 'large');

    expect(queries.some((q) => q === 'ink Malaysia')).toBe(true);
    expect(queries.some((q) => q === 'paint Malaysia')).toBe(true);
  });

  test('splits business terms with "and"', () => {
    const queries = strategy1_BroadSerpAPI('ink and chemicals', 'Malaysia', 'large');

    expect(queries.some((q) => q === 'ink Malaysia')).toBe(true);
    expect(queries.some((q) => q === 'chemicals Malaysia')).toBe(true);
  });

  test('handles comma-separated business terms', () => {
    const queries = strategy1_BroadSerpAPI('ink, paint, coatings', 'Malaysia', 'large');

    expect(queries.some((q) => q === 'ink Malaysia')).toBe(true);
    expect(queries.some((q) => q === 'paint Malaysia')).toBe(true);
    expect(queries.some((q) => q === 'coatings Malaysia')).toBe(true);
  });

  test('returns non-empty array', () => {
    const queries = strategy1_BroadSerpAPI('ink', 'Malaysia', 'large');
    expect(queries.length).toBeGreaterThan(0);
  });
});

describe('strategy2_BroadPerplexity', () => {
  test('generates comprehensive search queries', () => {
    const queries = strategy2_BroadPerplexity('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('Find ALL'))).toBe(true);
    expect(queries.some((q) => q.includes('Complete list'))).toBe(true);
    expect(queries.some((q) => q.includes('SME and family-owned'))).toBe(true);
  });

  test('includes output format in queries', () => {
    const queries = strategy2_BroadPerplexity('ink', 'Malaysia', 'large');

    queries.forEach((q) => {
      expect(q).toContain('company_name');
    });
  });

  test('includes exclusion in queries', () => {
    const queries = strategy2_BroadPerplexity('ink', 'Malaysia', 'large companies');

    expect(queries.some((q) => q.includes('Exclude large companies'))).toBe(true);
  });

  test('generates per-country queries', () => {
    const queries = strategy2_BroadPerplexity('ink', 'Malaysia, Thailand', 'large');

    expect(queries.some((q) => q.includes('List all ink companies based in Malaysia'))).toBe(true);
    expect(queries.some((q) => q.includes('List all ink companies based in Thailand'))).toBe(true);
  });
});

describe('strategy3_ListsSerpAPI', () => {
  test('generates list and ranking queries', () => {
    const queries = strategy3_ListsSerpAPI('ink', 'Malaysia', 'large');

    expect(queries).toContain('top ink companies Malaysia');
    expect(queries).toContain('biggest ink Malaysia');
    expect(queries).toContain('leading ink manufacturers Malaysia');
    expect(queries).toContain('list of ink Malaysia');
  });

  test('includes best/major variations', () => {
    const queries = strategy3_ListsSerpAPI('ink', 'Thailand', 'large');

    expect(queries).toContain('best ink suppliers Thailand');
    expect(queries).toContain('major ink players Thailand');
  });

  test('handles multiple countries', () => {
    const queries = strategy3_ListsSerpAPI('ink', 'Malaysia, Singapore', 'large');

    expect(queries.some((q) => q.includes('Malaysia'))).toBe(true);
    expect(queries.some((q) => q.includes('Singapore'))).toBe(true);
  });
});

describe('strategy4_CitiesPerplexity', () => {
  test('generates city-specific queries', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('Kuala Lumpur'))).toBe(true);
    expect(queries.some((q) => q.includes('Penang'))).toBe(true);
    expect(queries.some((q) => q.includes('Johor Bahru'))).toBe(true);
  });

  test('includes manufacturers near city queries', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Thailand', 'large');

    expect(queries.some((q) => q.includes('manufacturers near'))).toBe(true);
  });

  test('includes output format', () => {
    const queries = strategy4_CitiesPerplexity('ink', 'Malaysia', 'large');

    queries.forEach((q) => {
      expect(q).toContain('company_name');
    });
  });
});

describe('strategy5_IndustrialSerpAPI', () => {
  test('generates queries with local suffixes', () => {
    const queries = strategy5_IndustrialSerpAPI('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('Sdn Bhd'))).toBe(true);
    expect(queries.some((q) => q.includes('Berhad'))).toBe(true);
  });

  test('generates industrial zone queries', () => {
    const queries = strategy5_IndustrialSerpAPI('ink', 'Thailand', 'large');

    expect(queries.some((q) => q.includes('industrial estate'))).toBe(true);
    expect(queries.some((q) => q.includes('manufacturing zone'))).toBe(true);
    expect(queries.some((q) => q.includes('factory'))).toBe(true);
  });

  test('uses correct suffixes for Singapore', () => {
    const queries = strategy5_IndustrialSerpAPI('ink', 'Singapore', 'large');

    expect(queries.some((q) => q.includes('Pte Ltd'))).toBe(true);
    expect(queries.some((q) => q.includes('Private Limited'))).toBe(true);
  });
});

describe('strategy6_DirectoriesPerplexity', () => {
  test('generates directory and association queries', () => {
    const queries = strategy6_DirectoriesPerplexity('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('trade associations'))).toBe(true);
    expect(queries.some((q) => q.includes('Kompass directory'))).toBe(true);
    expect(queries.some((q) => q.includes('Chamber of commerce'))).toBe(true);
    expect(queries.some((q) => q.includes('Yellow Pages'))).toBe(true);
  });

  test('returns fixed number of queries', () => {
    const queries = strategy6_DirectoriesPerplexity('ink', 'Malaysia', 'large');
    expect(queries).toHaveLength(6);
  });
});

describe('strategy7_ExhibitionsPerplexity', () => {
  test('generates trade show and exhibition queries', () => {
    const queries = strategy7_ExhibitionsPerplexity('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('exhibitors at trade shows'))).toBe(true);
    expect(queries.some((q) => q.includes('industry exhibitions'))).toBe(true);
    expect(queries.some((q) => q.includes('expos and conferences'))).toBe(true);
    expect(queries.some((q) => q.includes('international fairs'))).toBe(true);
  });

  test('returns fixed number of queries', () => {
    const queries = strategy7_ExhibitionsPerplexity('ink', 'Thailand', 'large');
    expect(queries).toHaveLength(4);
  });
});

describe('strategy8_TradePerplexity', () => {
  test('generates import/export and supplier queries', () => {
    const queries = strategy8_TradePerplexity('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('importers and exporters'))).toBe(true);
    expect(queries.some((q) => q.includes('Alibaba'))).toBe(true);
    expect(queries.some((q) => q.includes('Global Sources'))).toBe(true);
    expect(queries.some((q) => q.includes('OEM suppliers'))).toBe(true);
    expect(queries.some((q) => q.includes('contract manufacturers'))).toBe(true);
  });

  test('returns fixed number of queries', () => {
    const queries = strategy8_TradePerplexity('ink', 'Malaysia', 'large');
    expect(queries).toHaveLength(6);
  });
});

describe('strategy9_DomainsPerplexity', () => {
  test('generates domain-specific queries', () => {
    const queries = strategy9_DomainsPerplexity('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('.my websites'))).toBe(true);
  });

  test('generates news and press release queries', () => {
    const queries = strategy9_DomainsPerplexity('ink', 'Thailand', 'large');

    expect(queries.some((q) => q.includes('Recent news'))).toBe(true);
    expect(queries.some((q) => q.includes('announcements and press releases'))).toBe(true);
  });

  test('uses correct domain for each country', () => {
    expect(
      strategy9_DomainsPerplexity('ink', 'Malaysia', 'large').some((q) => q.includes('.my'))
    ).toBe(true);
    expect(
      strategy9_DomainsPerplexity('ink', 'Singapore', 'large').some((q) => q.includes('.sg'))
    ).toBe(true);
    expect(
      strategy9_DomainsPerplexity('ink', 'Thailand', 'large').some((q) => q.includes('.th'))
    ).toBe(true);
  });
});

describe('strategy10_RegistriesSerpAPI', () => {
  test('generates government registry queries', () => {
    const queries = strategy10_RegistriesSerpAPI('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('company registration'))).toBe(true);
    expect(queries.some((q) => q.includes('registered companies'))).toBe(true);
    expect(queries.some((q) => q.includes('business registry'))).toBe(true);
  });

  test('handles multiple countries', () => {
    const queries = strategy10_RegistriesSerpAPI('ink', 'Malaysia, Thailand', 'large');

    expect(queries.some((q) => q.includes('Malaysia'))).toBe(true);
    expect(queries.some((q) => q.includes('Thailand'))).toBe(true);
  });
});

describe('strategy11_CityIndustrialSerpAPI', () => {
  test('generates city-based industrial queries', () => {
    const queries = strategy11_CityIndustrialSerpAPI('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('Kuala Lumpur'))).toBe(true);
    expect(queries.some((q) => q.includes('companies'))).toBe(true);
    expect(queries.some((q) => q.includes('factory'))).toBe(true);
    expect(queries.some((q) => q.includes('manufacturer'))).toBe(true);
  });

  test('covers multiple cities', () => {
    const queries = strategy11_CityIndustrialSerpAPI('ink', 'Thailand', 'large');

    expect(queries.some((q) => q.includes('Bangkok'))).toBe(true);
    expect(queries.some((q) => q.includes('Chonburi'))).toBe(true);
  });
});

describe('strategy12_DeepOpenAISearch', () => {
  test('generates deep web search queries', () => {
    const queries = strategy12_DeepOpenAISearch('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('Search the web'))).toBe(true);
    expect(queries.some((q) => q.includes('lesser-known'))).toBe(true);
    expect(queries.some((q) => q.includes('SMEs'))).toBe(true);
    expect(queries.some((q) => q.includes('independent local'))).toBe(true);
  });

  test('includes startups and news queries', () => {
    const queries = strategy12_DeepOpenAISearch('ink', 'Thailand', 'large');

    expect(queries.some((q) => q.includes('startups'))).toBe(true);
    expect(queries.some((q) => q.includes('industry news'))).toBe(true);
  });

  test('generates per-country detailed queries', () => {
    const queries = strategy12_DeepOpenAISearch('ink', 'Malaysia, Thailand', 'large');

    expect(queries.some((q) => q.includes('manufacturers in Malaysia'))).toBe(true);
    expect(queries.some((q) => q.includes('manufacturers in Thailand'))).toBe(true);
  });
});

describe('strategy13_PublicationsPerplexity', () => {
  test('generates industry publication queries', () => {
    const queries = strategy13_PublicationsPerplexity('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('industry magazines'))).toBe(true);
    expect(queries.some((q) => q.includes('market report'))).toBe(true);
    expect(queries.some((q) => q.includes('industry analysis'))).toBe(true);
    expect(queries.some((q) => q.includes('magazine articles'))).toBe(true);
  });

  test('returns fixed number of queries', () => {
    const queries = strategy13_PublicationsPerplexity('ink', 'Malaysia', 'large');
    expect(queries).toHaveLength(4);
  });
});

describe('strategy14_LocalLanguageOpenAISearch', () => {
  test('generates local language search queries', () => {
    const queries = strategy14_LocalLanguageOpenAISearch('ink', 'Thailand', 'large');

    expect(queries.some((q) => q.includes('local language terms'))).toBe(true);
    expect(queries.some((q) => q.includes('Thai'))).toBe(true);
  });

  test('generates supply chain queries', () => {
    const queries = strategy14_LocalLanguageOpenAISearch('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('supply chain'))).toBe(true);
    expect(queries.some((q) => q.includes('formulators, blenders'))).toBe(true);
    expect(queries.some((q) => q.includes('niche and specialty'))).toBe(true);
  });

  test('includes comprehensive final sweep', () => {
    const queries = strategy14_LocalLanguageOpenAISearch('ink', 'Malaysia', 'large');

    expect(queries.some((q) => q.includes('Comprehensive search'))).toBe(true);
    expect(queries.some((q) => q.includes('obscure directories'))).toBe(true);
  });

  test('uses language info for specific countries', () => {
    const thailandQueries = strategy14_LocalLanguageOpenAISearch('ink', 'Thailand', 'large');
    expect(thailandQueries.some((q) => q.includes('Thai'))).toBe(true);

    const vietnamQueries = strategy14_LocalLanguageOpenAISearch('ink', 'Vietnam', 'large');
    expect(vietnamQueries.some((q) => q.includes('Vietnamese'))).toBe(true);
  });
});
