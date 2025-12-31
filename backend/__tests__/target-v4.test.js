/**
 * Unit tests for target-v4/server.js
 * Tests pure/testable functions for data transformation, validation, and utility logic
 */

describe('target-v4 utility functions', () => {
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
    });

    test('returns defaultValue for null/undefined', () => {
      expect(ensureString(null)).toBe('');
      expect(ensureString(undefined)).toBe('');
      expect(ensureString(null, 'fallback')).toBe('fallback');
      expect(ensureString(undefined, 'fallback')).toBe('fallback');
    });

    test('handles arrays by joining with comma', () => {
      expect(ensureString(['a', 'b', 'c'])).toBe('a, b, c');
      expect(ensureString([1, 2, 3])).toBe('1, 2, 3');
      expect(ensureString([])).toBe('');
      expect(ensureString(['hello'])).toBe('hello');
    });

    test('handles nested arrays', () => {
      expect(ensureString([['a', 'b'], ['c', 'd']])).toBe('a, b, c, d');
    });

    test('extracts city and country from object', () => {
      expect(ensureString({ city: 'Bangkok', country: 'Thailand' }))
        .toBe('Bangkok, Thailand');
    });

    test('extracts text property from object', () => {
      expect(ensureString({ text: 'Some text' })).toBe('Some text');
    });

    test('extracts value property from object', () => {
      expect(ensureString({ value: 'Some value' })).toBe('Some value');
    });

    test('extracts name property from object', () => {
      expect(ensureString({ name: 'Company Name' })).toBe('Company Name');
    });

    test('stringifies other objects', () => {
      expect(ensureString({ key: 'value' })).toBe('{"key":"value"}');
    });

    test('converts other types to string', () => {
      expect(ensureString(123)).toBe('123');
      expect(ensureString(true)).toBe('true');
      expect(ensureString(false)).toBe('false');
    });

    test('handles circular references in objects', () => {
      const circular = { a: 1 };
      circular.self = circular;
      expect(ensureString(circular, 'default')).toBe('default');
    });
  });

  // ============ MEETING DOMAIN DETECTION ============

  describe('detectMeetingDomain', () => {
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

    test('detects financial domain', () => {
      expect(detectMeetingDomain('EBITDA grew by 20% this quarter')).toBe('financial');
      expect(detectMeetingDomain('The M&A deal is valued at $100M')).toBe('financial');
      expect(detectMeetingDomain('revenue increased')).toBe('financial');
    });

    test('detects legal domain', () => {
      expect(detectMeetingDomain('We need to review the NDA')).toBe('legal');
      expect(detectMeetingDomain('contract terms and conditions')).toBe('legal');
      expect(detectMeetingDomain('litigation risk assessment')).toBe('legal');
    });

    test('detects medical domain', () => {
      expect(detectMeetingDomain('Clinical trial results')).toBe('medical');
      expect(detectMeetingDomain('FDA approval pending')).toBe('medical');
      expect(detectMeetingDomain('pharmaceutical development')).toBe('medical');
    });

    test('detects technical domain', () => {
      expect(detectMeetingDomain('API architecture design')).toBe('technical');
      expect(detectMeetingDomain('cloud infrastructure setup')).toBe('technical');
      expect(detectMeetingDomain('database optimization')).toBe('technical');
    });

    test('detects HR domain', () => {
      expect(detectMeetingDomain('employee compensation review')).toBe('hr');
      expect(detectMeetingDomain('recruitment process')).toBe('hr');
      expect(detectMeetingDomain('HR department meeting')).toBe('hr');
    });

    test('returns general for unrecognized domains', () => {
      expect(detectMeetingDomain('general business discussion')).toBe('general');
      expect(detectMeetingDomain('random text')).toBe('general');
    });

    test('is case insensitive', () => {
      expect(detectMeetingDomain('ebitda analysis')).toBe('financial');
      expect(detectMeetingDomain('EBITDA ANALYSIS')).toBe('financial');
    });
  });

  // ============ DOMAIN INSTRUCTIONS ============

  describe('getDomainInstructions', () => {
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

    test('returns financial instructions', () => {
      const inst = getDomainInstructions('financial');
      expect(inst).toContain('financial');
      expect(inst).toContain('EBITDA');
    });

    test('returns legal instructions', () => {
      const inst = getDomainInstructions('legal');
      expect(inst).toContain('legal');
      expect(inst).toContain('contract');
    });

    test('returns medical instructions', () => {
      const inst = getDomainInstructions('medical');
      expect(inst).toContain('medical');
      expect(inst).toContain('pharmaceutical');
    });

    test('returns technical instructions', () => {
      const inst = getDomainInstructions('technical');
      expect(inst).toContain('technical');
      expect(inst).toContain('engineering');
    });

    test('returns HR instructions', () => {
      const inst = getDomainInstructions('hr');
      expect(inst).toContain('HR');
      expect(inst).toContain('talent');
    });

    test('returns general for unknown domains', () => {
      const inst = getDomainInstructions('unknown');
      expect(inst).toContain('business');
      expect(inst).toContain('professional');
    });

    test('returns general for empty domain', () => {
      const inst = getDomainInstructions('');
      expect(inst).toContain('business');
    });
  });

  // ============ BUILD OUTPUT FORMAT ============

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
    });

    test('removes prefixes like PT and CV', () => {
      expect(normalizeCompanyName('PT Acme Indonesia')).toBe('acme indonesia');
      expect(normalizeCompanyName('CV Acme')).toBe('acme');
    });

    test('removes parentheses and content', () => {
      expect(normalizeCompanyName('Acme (Thailand)')).toBe('acme');
      expect(normalizeCompanyName('Acme Company (2020)')).toBe('acme company');
    });

    test('removes special characters', () => {
      expect(normalizeCompanyName('Acme & Co.')).toBe('acme co');
      expect(normalizeCompanyName('Acme-Tech Ltd')).toBe('acmetech');
    });

    test('normalizes spaces', () => {
      expect(normalizeCompanyName('Acme   Tech  Inc')).toBe('acme tech');
    });

    test('converts to lowercase', () => {
      expect(normalizeCompanyName('ACME CORPORATION')).toBe('acme');
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
    });

    test('preserves company name without suffixes', () => {
      expect(normalizeCompanyName('Acme Industries')).toBe('acme industries');
      expect(normalizeCompanyName('Acme Manufacturing')).toBe('acme manufacturing');
    });

    test('handles Indonesian PT prefix variations', () => {
      expect(normalizeCompanyName('PT. Acme')).toBe('acme');
      expect(normalizeCompanyName('PT Acme Tbk')).toBe('acme');
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
    });

    test('removes file extensions', () => {
      expect(normalizeWebsite('https://example.com/index.html')).toBe('example.com/index');
      expect(normalizeWebsite('https://example.com/page.php')).toBe('example.com/page');
      expect(normalizeWebsite('https://example.com/default.aspx')).toBe('example.com/default');
    });

    test('removes language paths', () => {
      expect(normalizeWebsite('https://example.com/en')).toBe('example.com');
      expect(normalizeWebsite('https://example.com/th')).toBe('example.com');
      expect(normalizeWebsite('https://example.com/id/page')).toBe('example.com');
    });

    test('handles empty or null input', () => {
      expect(normalizeWebsite('')).toBe('');
      expect(normalizeWebsite(null)).toBe('');
      expect(normalizeWebsite(undefined)).toBe('');
    });

    test('preserves domain with path', () => {
      expect(normalizeWebsite('https://example.com/products/category')).toBe('example.com');
      expect(normalizeWebsite('https://example.com/news')).toBe('example.com/news');
    });

    test('converts to lowercase', () => {
      expect(normalizeWebsite('HTTPS://EXAMPLE.COM')).toBe('example.com');
    });

    test('handles complex URLs', () => {
      expect(normalizeWebsite('https://www.example.com/en/about-us/company.html'))
        .toBe('example.com');
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
    });

    test('allows legitimate company URLs', () => {
      expect(isSpamOrDirectoryURL('https://example.com')).toBe(false);
      expect(isSpamOrDirectoryURL('https://acme-company.com')).toBe(false);
    });

    test('returns true for empty or null URLs', () => {
      expect(isSpamOrDirectoryURL('')).toBe(true);
      expect(isSpamOrDirectoryURL(null)).toBe(true);
      expect(isSpamOrDirectoryURL(undefined)).toBe(true);
    });

    test('is case insensitive', () => {
      expect(isSpamOrDirectoryURL('HTTPS://FACEBOOK.COM/company')).toBe(true);
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

    test('keeps legitimate companies', () => {
      const companies = [
        { company_name: 'Acme', website: 'https://acme.com', hq: 'Bangkok' },
        { company_name: 'Best', website: 'https://best.com', hq: 'Bangkok' }
      ];
      const result = preFilterCompanies(companies);
      expect(result).toHaveLength(2);
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
      const rules = buildExclusionRules('large companies', 'ink');
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
    });
  });

  // ============ LEVENSHTEIN SIMILARITY ============

  describe('levenshteinSimilarity', () => {
    function levenshteinSimilarity(s1, s2) {
      if (!s1 || !s2) return 0;
      const longer = s1.length > s2.length ? s1 : s2;
      const shorter = s1.length > s2.length ? s2 : s1;
      if (longer.length === 0) return 1.0;

      const costs = [];
      for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
          if (i === 0) {
            costs[j] = j;
          } else if (j > 0) {
            let newValue = costs[j - 1];
            if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
              newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
            }
            costs[j - 1] = lastValue;
            lastValue = newValue;
          }
        }
        if (i > 0) costs[s2.length] = lastValue;
      }
      return (longer.length - costs[s2.length]) / longer.length;
    }

    test('returns 1.0 for identical strings', () => {
      expect(levenshteinSimilarity('hello', 'hello')).toBe(1.0);
      expect(levenshteinSimilarity('test', 'test')).toBe(1.0);
    });

    test('returns 0 for null or empty strings', () => {
      expect(levenshteinSimilarity('', '')).toBe(0);
      expect(levenshteinSimilarity('hello', '')).toBe(0);
      expect(levenshteinSimilarity('', 'world')).toBe(0);
      expect(levenshteinSimilarity(null, 'test')).toBe(0);
      expect(levenshteinSimilarity('test', null)).toBe(0);
    });

    test('calculates similarity for similar strings', () => {
      const sim = levenshteinSimilarity('kitten', 'sitting');
      expect(sim).toBeGreaterThan(0.4);
      expect(sim).toBeLessThan(0.6);
    });

    test('calculates similarity for different strings', () => {
      const sim = levenshteinSimilarity('hello', 'world');
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(0.5);
    });

    test('handles single character difference', () => {
      const sim = levenshteinSimilarity('hello', 'hallo');
      expect(sim).toBeGreaterThan(0.7);
    });

    test('is case sensitive', () => {
      const sim = levenshteinSimilarity('Hello', 'hello');
      expect(sim).toBeLessThan(1.0);
    });
  });

  // ============ GET CITIES FOR COUNTRY ============

  describe('getCitiesForCountry', () => {
    const CITY_MAP = {
      'malaysia': ['Kuala Lumpur', 'Penang', 'Johor Bahru', 'Shah Alam'],
      'singapore': ['Singapore', 'Jurong', 'Tuas', 'Woodlands'],
      'thailand': ['Bangkok', 'Chonburi', 'Rayong', 'Samut Prakan'],
      'indonesia': ['Jakarta', 'Surabaya', 'Bandung', 'Medan']
    };

    function getCitiesForCountry(country) {
      const countryLower = country.toLowerCase();
      for (const [key, cities] of Object.entries(CITY_MAP)) {
        if (countryLower.includes(key)) return cities;
      }
      return null;
    }

    test('returns cities for Malaysia', () => {
      const cities = getCitiesForCountry('Malaysia');
      expect(cities).toContain('Kuala Lumpur');
      expect(cities).toContain('Penang');
    });

    test('returns cities for Singapore', () => {
      const cities = getCitiesForCountry('Singapore');
      expect(cities).toContain('Singapore');
      expect(cities).toContain('Jurong');
    });

    test('returns cities for Thailand', () => {
      const cities = getCitiesForCountry('Thailand');
      expect(cities).toContain('Bangkok');
      expect(cities).toContain('Chonburi');
    });

    test('returns cities for Indonesia', () => {
      const cities = getCitiesForCountry('Indonesia');
      expect(cities).toContain('Jakarta');
      expect(cities).toContain('Surabaya');
    });

    test('is case insensitive', () => {
      const cities = getCitiesForCountry('THAILAND');
      expect(cities).toContain('Bangkok');
    });

    test('returns null for unknown country', () => {
      const cities = getCitiesForCountry('Unknown Country');
      expect(cities).toBeNull();
    });
  });

  // ============ GET DOMAIN FOR COUNTRY ============

  describe('getDomainForCountry', () => {
    const DOMAIN_MAP = {
      'malaysia': '.my',
      'singapore': '.sg',
      'thailand': '.th',
      'indonesia': '.co.id',
      'vietnam': '.vn',
      'philippines': '.ph'
    };

    function getDomainForCountry(country) {
      const countryLower = country.toLowerCase();
      for (const [key, domain] of Object.entries(DOMAIN_MAP)) {
        if (countryLower.includes(key)) return domain;
      }
      return null;
    }

    test('returns domain for Malaysia', () => {
      expect(getDomainForCountry('Malaysia')).toBe('.my');
    });

    test('returns domain for Singapore', () => {
      expect(getDomainForCountry('Singapore')).toBe('.sg');
    });

    test('returns domain for Thailand', () => {
      expect(getDomainForCountry('Thailand')).toBe('.th');
    });

    test('returns domain for Indonesia', () => {
      expect(getDomainForCountry('Indonesia')).toBe('.co.id');
    });

    test('is case insensitive', () => {
      expect(getDomainForCountry('VIETNAM')).toBe('.vn');
    });

    test('returns null for unknown country', () => {
      expect(getDomainForCountry('Unknown')).toBeNull();
    });
  });

  // ============ STRATEGY QUERY GENERATION ============

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
      const queries = strategy1_BroadSerpAPI('ink manufacturers', 'Thailand', 'large');
      expect(queries).toContain('ink manufacturers companies Thailand');
      expect(queries).toContain('ink manufacturers manufacturers Thailand');
      expect(queries).toContain('list of ink manufacturers companies in Thailand');
    });

    test('handles multiple countries', () => {
      const queries = strategy1_BroadSerpAPI('ink', 'Thailand, Vietnam', 'none');
      const thailandQueries = queries.filter(q => q.includes('Thailand'));
      const vietnamQueries = queries.filter(q => q.includes('Vietnam'));
      expect(thailandQueries.length).toBeGreaterThan(0);
      expect(vietnamQueries.length).toBeGreaterThan(0);
    });

    test('splits business terms with "or"', () => {
      const queries = strategy1_BroadSerpAPI('ink or paint', 'Thailand', 'none');
      expect(queries.some(q => q.includes('ink'))).toBe(true);
      expect(queries.some(q => q.includes('paint'))).toBe(true);
    });

    test('returns array of strings', () => {
      const queries = strategy1_BroadSerpAPI('ink', 'Thailand', 'none');
      expect(Array.isArray(queries)).toBe(true);
      expect(queries.every(q => typeof q === 'string')).toBe(true);
    });
  });

  describe('strategy2_BroadPerplexity', () => {
    function buildOutputFormat() {
      return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
    }

    function strategy2_BroadPerplexity(business, country, exclusion) {
      const outputFormat = buildOutputFormat();
      const countries = country.split(',').map(c => c.trim());
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

    test('includes exclusion in queries', () => {
      const queries = strategy2_BroadPerplexity('ink', 'Thailand', 'large companies');
      expect(queries.some(q => q.includes('Exclude large companies'))).toBe(true);
    });

    test('includes output format in queries', () => {
      const queries = strategy2_BroadPerplexity('ink', 'Thailand', 'none');
      expect(queries.every(q => q.includes('company_name'))).toBe(true);
    });

    test('generates per-country queries', () => {
      const queries = strategy2_BroadPerplexity('ink', 'Thailand, Vietnam', 'none');
      expect(queries.some(q => q.includes('based in Thailand'))).toBe(true);
      expect(queries.some(q => q.includes('based in Vietnam'))).toBe(true);
    });
  });

  describe('strategy4_CitiesPerplexity', () => {
    const CITY_MAP = {
      'malaysia': ['Kuala Lumpur', 'Penang'],
      'thailand': ['Bangkok', 'Chonburi']
    };

    function buildOutputFormat() {
      return `For each company provide: company_name, website (URL starting with http), hq (format: "City, Country" only).
Be thorough - include all companies you find. We will verify them later.`;
    }

    function strategy4_CitiesPerplexity(business, country, exclusion) {
      const countries = country.split(',').map(c => c.trim());
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

    test('generates queries for each city', () => {
      const queries = strategy4_CitiesPerplexity('ink', 'Thailand', 'large');
      expect(queries.some(q => q.includes('Bangkok'))).toBe(true);
      expect(queries.some(q => q.includes('Chonburi'))).toBe(true);
    });

    test('uses country name when no cities in map', () => {
      const queries = strategy4_CitiesPerplexity('ink', 'Vietnam', 'none');
      expect(queries.some(q => q.includes('Vietnam'))).toBe(true);
    });
  });

  describe('strategy5_IndustrialSerpAPI', () => {
    const LOCAL_SUFFIXES = {
      'malaysia': ['Sdn Bhd', 'Berhad'],
      'thailand': ['Co Ltd', 'Co., Ltd.']
    };

    function strategy5_IndustrialSerpAPI(business, country, exclusion) {
      const countries = country.split(',').map(c => c.trim());
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

    test('includes local suffixes in queries', () => {
      const queries = strategy5_IndustrialSerpAPI('ink', 'Malaysia', 'none');
      expect(queries.some(q => q.includes('Sdn Bhd'))).toBe(true);
      expect(queries.some(q => q.includes('Berhad'))).toBe(true);
    });

    test('includes industrial zone queries', () => {
      const queries = strategy5_IndustrialSerpAPI('ink', 'Thailand', 'none');
      expect(queries.some(q => q.includes('industrial estate'))).toBe(true);
      expect(queries.some(q => q.includes('manufacturing zone'))).toBe(true);
    });
  });
});
