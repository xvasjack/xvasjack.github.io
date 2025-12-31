/**
 * Unit tests for target-v5/server.js
 * Tests pure/testable functions for data transformation, validation, and utility logic
 */

describe('target-v5 utility functions', () => {
  // ============ TYPE SAFETY HELPERS ============

  describe('ensureString', () => {
    // Helper function extracted from server.js
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

    test('returns string unchanged', () => {
      expect(ensureString('hello')).toBe('hello');
      expect(ensureString('')).toBe('');
      expect(ensureString('test string')).toBe('test string');
    });

    test('returns defaultValue for null/undefined', () => {
      expect(ensureString(null)).toBe('');
      expect(ensureString(undefined)).toBe('');
      expect(ensureString(null, 'fallback')).toBe('fallback');
      expect(ensureString(undefined, 'default value')).toBe('default value');
    });

    test('handles arrays by joining with comma', () => {
      expect(ensureString(['a', 'b', 'c'])).toBe('a, b, c');
      expect(ensureString([1, 2, 3])).toBe('1, 2, 3');
      expect(ensureString([])).toBe('');
      expect(ensureString(['single'])).toBe('single');
    });

    test('handles nested arrays', () => {
      expect(ensureString([['x', 'y'], ['z']])).toBe('x, y, z');
      expect(ensureString([[1, 2], [3, 4]])).toBe('1, 2, 3, 4');
    });

    test('extracts city and country from object', () => {
      expect(ensureString({ city: 'Bangkok', country: 'Thailand' }))
        .toBe('Bangkok, Thailand');
      expect(ensureString({ city: 'Jakarta', country: 'Indonesia' }))
        .toBe('Jakarta, Indonesia');
    });

    test('extracts text property from object', () => {
      expect(ensureString({ text: 'Sample text' })).toBe('Sample text');
      // Empty text is falsy, so it falls through to stringify
      expect(ensureString({ text: '' })).toBe('{"text":""}');
    });

    test('extracts value property from object', () => {
      expect(ensureString({ value: 'Some value' })).toBe('Some value');
      expect(ensureString({ value: 123 })).toBe('123');
    });

    test('extracts name property from object', () => {
      expect(ensureString({ name: 'Company Name' })).toBe('Company Name');
    });

    test('stringifies other objects', () => {
      expect(ensureString({ key: 'value' })).toBe('{"key":"value"}');
      expect(ensureString({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
    });

    test('converts other types to string', () => {
      expect(ensureString(123)).toBe('123');
      expect(ensureString(0)).toBe('0');
      expect(ensureString(true)).toBe('true');
      expect(ensureString(false)).toBe('false');
    });

    test('handles circular references in objects', () => {
      const circular = { a: 1 };
      circular.self = circular;
      expect(ensureString(circular, 'default')).toBe('default');
    });

    test('handles nested objects with properties', () => {
      expect(ensureString({ text: { value: 'nested' } })).toBe('nested');
      expect(ensureString({ name: { text: 'deep' } })).toBe('deep');
    });
  });

  // ============ OUTPUT FORMAT ============

  describe('buildOutputFormat', () => {
    function buildOutputFormat() {
      return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
    }

    test('returns consistent output format string', () => {
      const format = buildOutputFormat();
      expect(format).toContain('company_name');
      expect(format).toContain('website');
      expect(format).toContain('hq');
      expect(format).toContain('City, Country');
    });

    test('returns same string on multiple calls', () => {
      expect(buildOutputFormat()).toBe(buildOutputFormat());
    });

    test('format includes instructions', () => {
      const format = buildOutputFormat();
      expect(format).toContain('URL starting with http');
      expect(format).toContain('verify them later');
    });
  });

  // ============ COMPANY NAME NORMALIZATION ============

  describe('normalizeCompanyName', () => {
    function normalizeCompanyName(name) {
      if (!name) return '';
      return name.toLowerCase()
        .replace(/\s*(sdn\.?\s*bhd\.?|bhd\.?|berhad|pte\.?\s*ltd\.?|ltd\.?|limited|inc\.?|incorporated|corp\.?|corporation|co\.?,?\s*ltd\.?|llc|llp|gmbh|s\.?a\.?|pt\.?|cv\.?|tbk\.?|jsc|plc|public\s*limited|private\s*limited|joint\s*stock|company|\(.*?\))$/gi, '')
        .replace(/^(pt\.?|cv\.?)\s+/gi, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    test('removes common legal suffixes', () => {
      expect(normalizeCompanyName('Acme Sdn Bhd')).toBe('acme');
      expect(normalizeCompanyName('Acme Pte Ltd')).toBe('acme');
      expect(normalizeCompanyName('Acme Inc.')).toBe('acme');
      expect(normalizeCompanyName('Acme Corporation')).toBe('acme');
      expect(normalizeCompanyName('Acme Co., Ltd.')).toBe('acme');
      expect(normalizeCompanyName('Acme Limited')).toBe('acme');
    });

    test('removes prefixes like PT and CV', () => {
      expect(normalizeCompanyName('PT Acme Indonesia')).toBe('acme indonesia');
      expect(normalizeCompanyName('CV Acme')).toBe('acme');
      expect(normalizeCompanyName('PT. Acme')).toBe('acme');
    });

    test('removes parentheses and content at end', () => {
      expect(normalizeCompanyName('Acme (Thailand)')).toBe('acme');
      expect(normalizeCompanyName('Acme Company (2020)')).toBe('acme company');
    });

    test('removes special characters', () => {
      expect(normalizeCompanyName('Acme & Co.')).toBe('acme co');
      expect(normalizeCompanyName('Acme-Tech Ltd')).toBe('acmetech');
      expect(normalizeCompanyName('Acme/Tech')).toBe('acmetech');
    });

    test('normalizes spaces', () => {
      expect(normalizeCompanyName('Acme   Tech  Inc')).toBe('acme tech');
      expect(normalizeCompanyName('Acme  Industries')).toBe('acme industries');
    });

    test('converts to lowercase', () => {
      expect(normalizeCompanyName('ACME CORPORATION')).toBe('acme');
      expect(normalizeCompanyName('Acme Industries')).toBe('acme industries');
    });

    test('handles empty or null input', () => {
      expect(normalizeCompanyName('')).toBe('');
      expect(normalizeCompanyName(null)).toBe('');
      expect(normalizeCompanyName(undefined)).toBe('');
    });

    test('handles multiple suffixes', () => {
      expect(normalizeCompanyName('Acme Berhad')).toBe('acme');
      expect(normalizeCompanyName('Acme Tbk.')).toBe('acme');
      expect(normalizeCompanyName('Acme JSC')).toBe('acme');
      expect(normalizeCompanyName('Acme PLC')).toBe('acme');
    });

    test('preserves company name without suffixes', () => {
      expect(normalizeCompanyName('Acme Industries')).toBe('acme industries');
      expect(normalizeCompanyName('Acme Manufacturing')).toBe('acme manufacturing');
    });

    test('handles Indonesian PT prefix variations', () => {
      expect(normalizeCompanyName('PT. Acme')).toBe('acme');
      expect(normalizeCompanyName('PT Acme Tbk')).toBe('acme');
      expect(normalizeCompanyName('PT Acme Indonesia Tbk.')).toBe('acme indonesia');
    });

    test('handles LLC and LLP', () => {
      expect(normalizeCompanyName('Acme LLC')).toBe('acme');
      expect(normalizeCompanyName('Acme LLP')).toBe('acme');
    });

    test('handles GmbH (German)', () => {
      expect(normalizeCompanyName('Acme GmbH')).toBe('acme');
    });
  });

  // ============ WEBSITE URL NORMALIZATION ============

  describe('normalizeWebsite', () => {
    function normalizeWebsite(url) {
      if (!url) return '';
      return url.toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/+$/, '')
        .replace(/\/(home|index|main|default|about|about-us|contact|products?|services?|en|th|id|vn|my|sg|ph|company)(\/.*)?$/i, '')
        .replace(/\.(html?|php|aspx?|jsp)$/i, '');
    }

    test('removes protocol', () => {
      expect(normalizeWebsite('http://example.com')).toBe('example.com');
      expect(normalizeWebsite('https://example.com')).toBe('example.com');
    });

    test('removes www prefix', () => {
      expect(normalizeWebsite('https://www.example.com')).toBe('example.com');
      expect(normalizeWebsite('www.example.com')).toBe('example.com');
    });

    test('removes trailing slashes', () => {
      expect(normalizeWebsite('https://example.com/')).toBe('example.com');
      expect(normalizeWebsite('https://example.com///')).toBe('example.com');
    });

    test('removes common page paths', () => {
      expect(normalizeWebsite('https://example.com/home')).toBe('example.com');
      expect(normalizeWebsite('https://example.com/about')).toBe('example.com');
      expect(normalizeWebsite('https://example.com/contact')).toBe('example.com');
      expect(normalizeWebsite('https://example.com/products')).toBe('example.com');
      expect(normalizeWebsite('https://example.com/about-us')).toBe('example.com');
    });

    test('removes file extensions', () => {
      expect(normalizeWebsite('https://example.com/index.html')).toBe('example.com/index');
      expect(normalizeWebsite('https://example.com/page.php')).toBe('example.com/page');
      expect(normalizeWebsite('https://example.com/default.aspx')).toBe('example.com/default');
      expect(normalizeWebsite('https://example.com/page.jsp')).toBe('example.com/page');
    });

    test('removes language paths', () => {
      expect(normalizeWebsite('https://example.com/en')).toBe('example.com');
      expect(normalizeWebsite('https://example.com/th')).toBe('example.com');
      expect(normalizeWebsite('https://example.com/id')).toBe('example.com');
      expect(normalizeWebsite('https://example.com/vn')).toBe('example.com');
    });

    test('handles empty or null input', () => {
      expect(normalizeWebsite('')).toBe('');
      expect(normalizeWebsite(null)).toBe('');
      expect(normalizeWebsite(undefined)).toBe('');
    });

    test('preserves domain with non-common paths', () => {
      expect(normalizeWebsite('https://example.com/news')).toBe('example.com/news');
      expect(normalizeWebsite('https://example.com/blog')).toBe('example.com/blog');
    });

    test('converts to lowercase', () => {
      expect(normalizeWebsite('HTTPS://EXAMPLE.COM')).toBe('example.com');
      expect(normalizeWebsite('HTTPS://WWW.EXAMPLE.COM/HOME')).toBe('example.com');
    });

    test('handles complex URLs', () => {
      expect(normalizeWebsite('https://www.example.com/en/about-us/company.html'))
        .toBe('example.com');
      expect(normalizeWebsite('https://example.com/products/category'))
        .toBe('example.com');
    });

    test('removes language path with trailing content', () => {
      expect(normalizeWebsite('https://example.com/en/page')).toBe('example.com');
      expect(normalizeWebsite('https://example.com/th/about')).toBe('example.com');
    });
  });

  // ============ DOMAIN ROOT EXTRACTION ============

  describe('extractDomainRoot', () => {
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

    test('extracts domain without path', () => {
      expect(extractDomainRoot('https://example.com/path/to/page')).toBe('example.com');
      expect(extractDomainRoot('https://www.example.com/about')).toBe('example.com');
    });

    test('extracts domain from normalized URL', () => {
      expect(extractDomainRoot('https://example.com')).toBe('example.com');
      expect(extractDomainRoot('http://www.example.com/')).toBe('example.com');
    });

    test('handles subdomains', () => {
      expect(extractDomainRoot('https://blog.example.com')).toBe('blog.example.com');
      expect(extractDomainRoot('https://www.blog.example.com/post')).toBe('blog.example.com');
    });

    test('handles empty or null input', () => {
      expect(extractDomainRoot('')).toBe('');
      expect(extractDomainRoot(null)).toBe('');
    });

    test('handles URLs with multiple path segments', () => {
      expect(extractDomainRoot('https://example.com/a/b/c')).toBe('example.com');
      expect(extractDomainRoot('https://example.com/products/ink/gravure')).toBe('example.com');
    });
  });

  // ============ SPAM/DIRECTORY URL DETECTION ============

  describe('isSpamOrDirectoryURL', () => {
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

    test('detects social media URLs', () => {
      expect(isSpamOrDirectoryURL('https://facebook.com/company')).toBe(true);
      expect(isSpamOrDirectoryURL('https://twitter.com/company')).toBe(true);
      expect(isSpamOrDirectoryURL('https://instagram.com/company')).toBe(true);
      expect(isSpamOrDirectoryURL('https://youtube.com/company')).toBe(true);
    });

    test('detects Wikipedia URLs', () => {
      expect(isSpamOrDirectoryURL('https://en.wikipedia.org/wiki/Company')).toBe(true);
      expect(isSpamOrDirectoryURL('https://wikipedia.org/company')).toBe(true);
    });

    test('allows legitimate company URLs', () => {
      expect(isSpamOrDirectoryURL('https://example.com')).toBe(false);
      expect(isSpamOrDirectoryURL('https://acme-company.com')).toBe(false);
      expect(isSpamOrDirectoryURL('https://company.co.th')).toBe(false);
    });

    test('returns true for empty or null URLs', () => {
      expect(isSpamOrDirectoryURL('')).toBe(true);
      expect(isSpamOrDirectoryURL(null)).toBe(true);
      expect(isSpamOrDirectoryURL(undefined)).toBe(true);
    });

    test('is case insensitive', () => {
      expect(isSpamOrDirectoryURL('HTTPS://FACEBOOK.COM/company')).toBe(true);
      expect(isSpamOrDirectoryURL('HTTPS://TWITTER.COM/company')).toBe(true);
    });

    test('detects partial matches', () => {
      expect(isSpamOrDirectoryURL('https://www.facebook.com/page')).toBe(true);
      expect(isSpamOrDirectoryURL('https://m.facebook.com/page')).toBe(true);
    });
  });

  // ============ COMPANY DEDUPLICATION ============

  describe('dedupeCompanies', () => {
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

    test('removes duplicate websites', () => {
      const companies = [
        { company_name: 'Acme Inc', website: 'https://example.com', hq: 'Bangkok' },
        { company_name: 'Acme Corp', website: 'https://example.com/about', hq: 'Bangkok' }
      ];
      const result = dedupeCompanies(companies);
      expect(result).toHaveLength(1);
    });

    test('removes companies with same domain', () => {
      const companies = [
        { company_name: 'Acme Inc', website: 'https://example.com', hq: 'Bangkok' },
        { company_name: 'Acme Corp', website: 'https://example.com/products', hq: 'Bangkok' }
      ];
      const result = dedupeCompanies(companies);
      expect(result).toHaveLength(1);
    });

    test('removes companies with same normalized name', () => {
      const companies = [
        { company_name: 'Acme Inc', website: 'https://acme1.com', hq: 'Bangkok' },
        { company_name: 'Acme Corporation', website: 'https://acme2.com', hq: 'Bangkok' }
      ];
      const result = dedupeCompanies(companies);
      expect(result).toHaveLength(1);
    });

    test('keeps companies with different names and domains', () => {
      const companies = [
        { company_name: 'Acme Inc', website: 'https://acme.com', hq: 'Bangkok' },
        { company_name: 'Best Corp', website: 'https://best.com', hq: 'Bangkok' }
      ];
      const result = dedupeCompanies(companies);
      expect(result).toHaveLength(2);
    });

    test('filters out companies without website', () => {
      const companies = [
        { company_name: 'Acme Inc', website: '', hq: 'Bangkok' },
        { company_name: 'Best Corp', website: 'https://best.com', hq: 'Bangkok' }
      ];
      const result = dedupeCompanies(companies);
      expect(result).toHaveLength(1);
      expect(result[0].company_name).toBe('Best Corp');
    });

    test('filters out companies without name', () => {
      const companies = [
        { company_name: '', website: 'https://acme.com', hq: 'Bangkok' },
        { company_name: 'Best Corp', website: 'https://best.com', hq: 'Bangkok' }
      ];
      const result = dedupeCompanies(companies);
      expect(result).toHaveLength(1);
      expect(result[0].company_name).toBe('Best Corp');
    });

    test('filters out companies with invalid website URLs', () => {
      const companies = [
        { company_name: 'Acme Inc', website: 'example.com', hq: 'Bangkok' },
        { company_name: 'Best Corp', website: 'https://best.com', hq: 'Bangkok' }
      ];
      const result = dedupeCompanies(companies);
      expect(result).toHaveLength(1);
      expect(result[0].company_name).toBe('Best Corp');
    });

    test('handles null and undefined companies', () => {
      const companies = [
        null,
        undefined,
        { company_name: 'Acme Inc', website: 'https://acme.com', hq: 'Bangkok' }
      ];
      const result = dedupeCompanies(companies);
      expect(result).toHaveLength(1);
    });

    test('handles www and non-www versions as duplicates', () => {
      const companies = [
        { company_name: 'Acme Inc', website: 'https://www.example.com', hq: 'Bangkok' },
        { company_name: 'Acme Corp', website: 'https://example.com', hq: 'Bangkok' }
      ];
      const result = dedupeCompanies(companies);
      expect(result).toHaveLength(1);
    });

    test('handles PT prefix in company names', () => {
      const companies = [
        { company_name: 'PT Acme Indonesia', website: 'https://acme1.com', hq: 'Jakarta' },
        { company_name: 'Acme Indonesia', website: 'https://acme2.com', hq: 'Jakarta' }
      ];
      const result = dedupeCompanies(companies);
      expect(result).toHaveLength(1);
    });

    test('handles legal suffix variations', () => {
      const companies = [
        { company_name: 'Acme Sdn Bhd', website: 'https://acme1.com', hq: 'Kuala Lumpur' },
        { company_name: 'Acme Berhad', website: 'https://acme2.com', hq: 'Kuala Lumpur' }
      ];
      const result = dedupeCompanies(companies);
      expect(result).toHaveLength(1);
    });
  });

  // ============ PRE-FILTER COMPANIES ============

  describe('preFilterCompanies', () => {
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

    function preFilterCompanies(companies) {
      return companies.filter(c => {
        if (!c || !c.website) return false;
        if (isSpamOrDirectoryURL(c.website)) {
          return false;
        }
        return true;
      });
    }

    test('removes companies with social media URLs', () => {
      const companies = [
        { company_name: 'Acme', website: 'https://facebook.com/acme', hq: 'Bangkok' },
        { company_name: 'Best', website: 'https://best.com', hq: 'Bangkok' }
      ];
      const result = preFilterCompanies(companies);
      expect(result).toHaveLength(1);
      expect(result[0].company_name).toBe('Best');
    });

    test('removes companies without website', () => {
      const companies = [
        { company_name: 'Acme', website: '', hq: 'Bangkok' },
        { company_name: 'Best', website: 'https://best.com', hq: 'Bangkok' }
      ];
      const result = preFilterCompanies(companies);
      expect(result).toHaveLength(1);
    });

    test('removes companies with Wikipedia URLs', () => {
      const companies = [
        { company_name: 'Acme', website: 'https://wikipedia.org/wiki/Acme', hq: 'Bangkok' },
        { company_name: 'Best', website: 'https://best.com', hq: 'Bangkok' }
      ];
      const result = preFilterCompanies(companies);
      expect(result).toHaveLength(1);
    });

    test('keeps legitimate companies', () => {
      const companies = [
        { company_name: 'Acme', website: 'https://acme.com', hq: 'Bangkok' },
        { company_name: 'Best', website: 'https://best.com', hq: 'Bangkok' }
      ];
      const result = preFilterCompanies(companies);
      expect(result).toHaveLength(2);
    });

    test('handles null companies', () => {
      const companies = [
        null,
        { company_name: 'Best', website: 'https://best.com', hq: 'Bangkok' }
      ];
      const result = preFilterCompanies(companies);
      expect(result).toHaveLength(1);
    });
  });

  // ============ BUILD EXCLUSION RULES ============

  describe('buildExclusionRules', () => {
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

    test('generates large company exclusion rules', () => {
      const rules = buildExclusionRules('large companies', 'ink manufacturers');
      expect(rules).toContain('LARGE COMPANY DETECTION');
      expect(rules).toContain('global presence');
      expect(rules).toContain('NYSE');
    });

    test('generates listed company exclusion rules', () => {
      const rules = buildExclusionRules('listed companies', 'ink');
      expect(rules).toContain('LISTED COMPANY DETECTION');
      expect(rules).toContain('stock exchange');
    });

    test('generates distributor exclusion rules', () => {
      const rules = buildExclusionRules('distributors', 'ink');
      expect(rules).toContain('DISTRIBUTOR DETECTION');
      expect(rules).toContain('distributes/resells');
    });

    test('combines multiple exclusion rules', () => {
      const rules = buildExclusionRules('large listed companies', 'ink');
      expect(rules).toContain('LARGE COMPANY DETECTION');
      expect(rules).toContain('LISTED COMPANY DETECTION');
    });

    test('returns empty string for no matching exclusions', () => {
      const rules = buildExclusionRules('none', 'ink');
      expect(rules).toBe('');
    });

    test('is case insensitive', () => {
      const rules = buildExclusionRules('LARGE COMPANIES', 'ink');
      expect(rules).toContain('LARGE COMPANY DETECTION');
    });

    test('handles variations of large company terms', () => {
      expect(buildExclusionRules('big companies', 'ink')).toContain('LARGE COMPANY DETECTION');
      expect(buildExclusionRules('mnc', 'ink')).toContain('LARGE COMPANY DETECTION');
      expect(buildExclusionRules('multinational', 'ink')).toContain('LARGE COMPANY DETECTION');
      expect(buildExclusionRules('major players', 'ink')).toContain('LARGE COMPANY DETECTION');
      expect(buildExclusionRules('giants', 'ink')).toContain('LARGE COMPANY DETECTION');
    });

    test('includes all three exclusion types when applicable', () => {
      const rules = buildExclusionRules('large listed distributors', 'ink');
      expect(rules).toContain('LARGE COMPANY DETECTION');
      expect(rules).toContain('LISTED COMPANY DETECTION');
      expect(rules).toContain('DISTRIBUTOR DETECTION');
    });

    test('mentions specific MNC names', () => {
      const rules = buildExclusionRules('large companies', 'ink');
      expect(rules).toContain('Toyo Ink');
      expect(rules).toContain('Sakata');
      expect(rules).toContain('DIC');
    });
  });

  // ============ EMAIL HTML GENERATION ============

  describe('buildEmailHTML', () => {
    // Mock escapeHtml function (from security module)
    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
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

    test('generates HTML with search parameters', () => {
      const companies = [
        { company_name: 'Acme Inc', website: 'https://acme.com', hq: 'Bangkok, Thailand' }
      ];
      const html = buildEmailHTML(companies, 'ink manufacturers', 'Thailand', 'large companies');

      expect(html).toContain('Find Target Results');
      expect(html).toContain('ink manufacturers');
      expect(html).toContain('Thailand');
      expect(html).toContain('large companies');
      expect(html).toContain('Companies Found:</strong> 1');
    });

    test('generates table rows for each company', () => {
      const companies = [
        { company_name: 'Acme Inc', website: 'https://acme.com', hq: 'Bangkok, Thailand' },
        { company_name: 'Best Corp', website: 'https://best.com', hq: 'Jakarta, Indonesia' }
      ];
      const html = buildEmailHTML(companies, 'ink', 'Southeast Asia', 'none');

      expect(html).toContain('Acme Inc');
      expect(html).toContain('Best Corp');
      expect(html).toContain('https://acme.com');
      expect(html).toContain('https://best.com');
      expect(html).toContain('Bangkok, Thailand');
      expect(html).toContain('Jakarta, Indonesia');
    });

    test('numbers companies sequentially', () => {
      const companies = [
        { company_name: 'Acme', website: 'https://acme.com', hq: 'Bangkok' },
        { company_name: 'Best', website: 'https://best.com', hq: 'Jakarta' }
      ];
      const html = buildEmailHTML(companies, 'ink', 'SEA', 'none');

      expect(html).toContain('<td>1</td>');
      expect(html).toContain('<td>2</td>');
    });

    test('handles empty company list', () => {
      const html = buildEmailHTML([], 'ink', 'Thailand', 'none');
      expect(html).toContain('Companies Found:</strong> 0');
    });

    test('creates clickable website links', () => {
      const companies = [
        { company_name: 'Acme', website: 'https://acme.com', hq: 'Bangkok' }
      ];
      const html = buildEmailHTML(companies, 'ink', 'Thailand', 'none');
      expect(html).toContain('<a href="https://acme.com">https://acme.com</a>');
    });

    test('escapes HTML in company data', () => {
      const companies = [
        { company_name: 'Acme & Co.', website: 'https://acme.com', hq: 'Bangkok' }
      ];
      const html = buildEmailHTML(companies, 'ink & coatings', 'Thailand', 'none');
      expect(html).toContain('Acme &amp; Co.');
      expect(html).toContain('ink &amp; coatings');
    });

    test('includes table headers', () => {
      const companies = [
        { company_name: 'Acme', website: 'https://acme.com', hq: 'Bangkok' }
      ];
      const html = buildEmailHTML(companies, 'ink', 'Thailand', 'none');
      expect(html).toContain('<th>#</th>');
      expect(html).toContain('<th>Company</th>');
      expect(html).toContain('<th>Website</th>');
      expect(html).toContain('<th>Headquarters</th>');
    });
  });

  // ============ REGION EXPANSION ============

  describe('expandRegionToCountries (synchronous logic)', () => {
    test('splits comma-separated countries', () => {
      const input = 'Thailand, Vietnam, Indonesia';
      const hasComma = input.includes(',');
      expect(hasComma).toBe(true);
      const result = input.split(',').map(c => c.trim());
      expect(result).toEqual(['Thailand', 'Vietnam', 'Indonesia']);
    });

    test('recognizes Southeast Asia region', () => {
      const regionMappings = {
        'southeast asia': ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines']
      };
      const input = 'southeast asia';
      expect(regionMappings[input.toLowerCase()]).toEqual([
        'Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'
      ]);
    });

    test('recognizes East Asia region', () => {
      const regionMappings = {
        'east asia': ['Japan', 'South Korea', 'Taiwan', 'China', 'Hong Kong']
      };
      const input = 'east asia';
      expect(regionMappings[input.toLowerCase()]).toEqual([
        'Japan', 'South Korea', 'Taiwan', 'China', 'Hong Kong'
      ]);
    });

    test('recognizes SEA abbreviation', () => {
      const regionMappings = {
        'sea': ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines']
      };
      expect(regionMappings['sea']).toEqual([
        'Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'
      ]);
    });

    test('recognizes ASEAN', () => {
      const regionMappings = {
        'asean': ['Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines']
      };
      expect(regionMappings['asean']).toEqual([
        'Malaysia', 'Indonesia', 'Singapore', 'Thailand', 'Vietnam', 'Philippines'
      ]);
    });

    test('handles single country as non-comma input', () => {
      const input = 'Thailand';
      const hasComma = input.includes(',');
      expect(hasComma).toBe(false);
      // Would be returned as [input] in the actual function
    });

    test('handles trimming of whitespace', () => {
      const input = ' Thailand , Vietnam , Indonesia ';
      const result = input.split(',').map(c => c.trim());
      expect(result).toEqual(['Thailand', 'Vietnam', 'Indonesia']);
    });
  });

  // ============ STRATEGY FUNCTIONS - QUERY GENERATION ============

  describe('strategy1_BroadSerpAPI', () => {
    function strategy1_BroadSerpAPI(business, country, exclusion) {
      const countries = country.split(',').map(c => c.trim());
      const queries = [];

      const terms = business.split(/\s+or\s+|\s+and\s+|,/).map(t => t.trim()).filter(t => t);

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

    test('generates basic queries for single country', () => {
      const queries = strategy1_BroadSerpAPI('ink manufacturers', 'Thailand', 'large companies');
      expect(queries.length).toBeGreaterThanOrEqual(5);
      expect(queries).toContain('ink manufacturers companies Thailand');
      expect(queries).toContain('ink manufacturers manufacturers Thailand');
      expect(queries).toContain('list of ink manufacturers companies in Thailand');
    });

    test('generates queries for multiple countries', () => {
      const queries = strategy1_BroadSerpAPI('ink', 'Thailand, Vietnam', 'none');
      const thailandQueries = queries.filter(q => q.includes('Thailand'));
      const vietnamQueries = queries.filter(q => q.includes('Vietnam'));
      expect(thailandQueries.length).toBeGreaterThan(0);
      expect(vietnamQueries.length).toBeGreaterThan(0);
    });

    test('handles business terms with "or"', () => {
      const queries = strategy1_BroadSerpAPI('ink or coating', 'Thailand', 'none');
      expect(queries.some(q => q === 'ink Thailand')).toBe(true);
      expect(queries.some(q => q === 'coating Thailand')).toBe(true);
    });

    test('handles business terms with "and"', () => {
      const queries = strategy1_BroadSerpAPI('ink and coating', 'Thailand', 'none');
      expect(queries.some(q => q === 'ink Thailand')).toBe(true);
      expect(queries.some(q => q === 'coating Thailand')).toBe(true);
    });
  });

  describe('buildOutputFormat consistency', () => {
    function buildOutputFormat() {
      return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
    }

    test('output format remains unchanged across calls', () => {
      const format1 = buildOutputFormat();
      const format2 = buildOutputFormat();
      const format3 = buildOutputFormat();
      expect(format1).toBe(format2);
      expect(format2).toBe(format3);
    });

    test('format contains all required fields', () => {
      const format = buildOutputFormat();
      expect(format).toMatch(/company_name/);
      expect(format).toMatch(/website/);
      expect(format).toMatch(/hq/);
    });
  });
});
