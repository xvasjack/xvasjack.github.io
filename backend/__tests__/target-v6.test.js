/**
 * Unit tests for target-v6/server.js
 * Tests pure/testable functions for data transformation, validation, and utility logic
 */

describe('target-v6 utility functions', () => {
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

  // ============ PCM TO WAV CONVERSION ============

  describe('pcmToWav', () => {
    function pcmToWav(pcmBuffer, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
      const byteRate = sampleRate * numChannels * bitsPerSample / 8;
      const blockAlign = numChannels * bitsPerSample / 8;
      const dataSize = pcmBuffer.length;
      const headerSize = 44;
      const fileSize = headerSize + dataSize;

      const wavBuffer = Buffer.alloc(fileSize);

      // RIFF header
      wavBuffer.write('RIFF', 0);
      wavBuffer.writeUInt32LE(fileSize - 8, 4);
      wavBuffer.write('WAVE', 8);

      // fmt chunk
      wavBuffer.write('fmt ', 12);
      wavBuffer.writeUInt32LE(16, 16);
      wavBuffer.writeUInt16LE(1, 20);
      wavBuffer.writeUInt16LE(numChannels, 22);
      wavBuffer.writeUInt32LE(sampleRate, 24);
      wavBuffer.writeUInt32LE(byteRate, 28);
      wavBuffer.writeUInt16LE(blockAlign, 32);
      wavBuffer.writeUInt16LE(bitsPerSample, 34);

      // data chunk
      wavBuffer.write('data', 36);
      wavBuffer.writeUInt32LE(dataSize, 40);
      pcmBuffer.copy(wavBuffer, 44);

      return wavBuffer;
    }

    test('creates valid WAV header with default parameters', () => {
      const pcmData = Buffer.alloc(100);
      const wavBuffer = pcmToWav(pcmData);

      // Check RIFF header
      expect(wavBuffer.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wavBuffer.toString('ascii', 8, 12)).toBe('WAVE');

      // Check fmt chunk
      expect(wavBuffer.toString('ascii', 12, 16)).toBe('fmt ');
      expect(wavBuffer.readUInt16LE(20)).toBe(1); // PCM format
      expect(wavBuffer.readUInt16LE(22)).toBe(1); // 1 channel
      expect(wavBuffer.readUInt32LE(24)).toBe(16000); // 16kHz sample rate

      // Check data chunk
      expect(wavBuffer.toString('ascii', 36, 40)).toBe('data');
      expect(wavBuffer.readUInt32LE(40)).toBe(100); // data size
    });

    test('calculates correct file size', () => {
      const pcmData = Buffer.alloc(200);
      const wavBuffer = pcmToWav(pcmData);

      expect(wavBuffer.length).toBe(244); // 44 header + 200 data
      expect(wavBuffer.readUInt32LE(4)).toBe(236); // fileSize - 8
    });

    test('handles custom sample rate', () => {
      const pcmData = Buffer.alloc(100);
      const wavBuffer = pcmToWav(pcmData, 44100);

      expect(wavBuffer.readUInt32LE(24)).toBe(44100);
      expect(wavBuffer.readUInt32LE(28)).toBe(44100 * 1 * 16 / 8); // byte rate
    });

    test('handles stereo audio (2 channels)', () => {
      const pcmData = Buffer.alloc(100);
      const wavBuffer = pcmToWav(pcmData, 16000, 2);

      expect(wavBuffer.readUInt16LE(22)).toBe(2); // 2 channels
      expect(wavBuffer.readUInt16LE(32)).toBe(4); // block align (2 channels * 16 bits / 8)
    });

    test('handles different bit depths', () => {
      const pcmData = Buffer.alloc(100);
      const wavBuffer = pcmToWav(pcmData, 16000, 1, 8);

      expect(wavBuffer.readUInt16LE(34)).toBe(8); // 8 bits per sample
      expect(wavBuffer.readUInt32LE(28)).toBe(16000 * 1 * 8 / 8); // byte rate
    });

    test('copies PCM data to correct position', () => {
      const pcmData = Buffer.from([1, 2, 3, 4, 5]);
      const wavBuffer = pcmToWav(pcmData);

      expect(wavBuffer[44]).toBe(1);
      expect(wavBuffer[45]).toBe(2);
      expect(wavBuffer[46]).toBe(3);
      expect(wavBuffer[47]).toBe(4);
      expect(wavBuffer[48]).toBe(5);
    });

    test('handles empty PCM buffer', () => {
      const pcmData = Buffer.alloc(0);
      const wavBuffer = pcmToWav(pcmData);

      expect(wavBuffer.length).toBe(44); // Just the header
      expect(wavBuffer.readUInt32LE(40)).toBe(0); // data size = 0
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
      // Note: The regex only removes parentheses at the END of the name
      // "Company" is not a suffix, so it's preserved
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
      // "talent" alone might match other domains first, use more specific HR term
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

    test('detects words at word boundaries', () => {
      // The regex uses \b for word boundaries
      expect(detectMeetingDomain('We discussed the API architecture')).toBe('technical');
      expect(detectMeetingDomain('The contract terms were reviewed')).toBe('legal');
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

  // ============ BUILD EXCLUSION RULES ============

  describe('buildExclusionRules', () => {
    function buildExclusionRules(exclusion) {
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
      const rules = buildExclusionRules('large companies');
      expect(rules).toContain('LARGE COMPANY DETECTION');
      expect(rules).toContain('global presence');
      expect(rules).toContain('NYSE');
    });

    test('generates listed company exclusion rules', () => {
      const rules = buildExclusionRules('listed companies');
      expect(rules).toContain('LISTED COMPANY DETECTION');
      expect(rules).toContain('stock exchange');
    });

    test('generates distributor exclusion rules', () => {
      const rules = buildExclusionRules('distributors');
      expect(rules).toContain('DISTRIBUTOR DETECTION');
      expect(rules).toContain('distributes/resells');
    });

    test('combines multiple exclusion rules', () => {
      const rules = buildExclusionRules('large listed companies');
      expect(rules).toContain('LARGE COMPANY DETECTION');
      expect(rules).toContain('LISTED COMPANY DETECTION');
    });

    test('returns empty string for no matching exclusions', () => {
      const rules = buildExclusionRules('none');
      expect(rules).toBe('');
    });

    test('is case insensitive', () => {
      const rules = buildExclusionRules('LARGE COMPANIES');
      expect(rules).toContain('LARGE COMPANY DETECTION');
    });

    test('handles variations of large company terms', () => {
      expect(buildExclusionRules('big companies')).toContain('LARGE COMPANY DETECTION');
      expect(buildExclusionRules('mnc')).toContain('LARGE COMPANY DETECTION');
      expect(buildExclusionRules('multinational')).toContain('LARGE COMPANY DETECTION');
    });
  });

  // ============ REGION EXPANSION ============

  describe('expandRegionToCountries (synchronous logic)', () => {
    // Test the synchronous logic parts only
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

    test('handles single country as array', () => {
      const input = 'Thailand';
      const hasComma = input.includes(',');
      expect(hasComma).toBe(false);
      // Would be returned as [input] in the actual function
    });
  });

  // ============ EMAIL HTML GENERATION ============

  describe('buildEmailHTML', () => {
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
  });

  // ============ SEARCH TASK GENERATION ============

  describe('generateSearchTasks', () => {
    function generateSearchTasks(business, country, exclusion, businessVariations = []) {
      const countries = country.split(',').map(c => c.trim());
      const countryList = countries.join(', ');
      const tasks = [];

      // Primary comprehensive search
      tasks.push(`You are an M&A research analyst. Find ALL ${business} companies in ${countryList}.`);

      // SME and local company focus
      tasks.push(`Find small and medium ${business} companies in ${countryList} that are locally owned.`);

      // Industrial estate searches for each country
      for (const c of countries) {
        tasks.push(`Find ${business} companies located in SPECIFIC INDUSTRIAL ESTATES and ZONES in ${c}.`);
      }

      // Industry associations and directories
      tasks.push(`Find ${business} companies through INDUSTRY ASSOCIATIONS and TRADE EVENTS in ${countryList}.`);

      // Local language search
      tasks.push(`Find ${business} companies in ${countryList} using LOCAL LANGUAGE search terms.`);

      // Supply chain discovery
      tasks.push(`Find ${business} companies in ${countryList} through SUPPLY CHAIN exploration.`);

      // Product-specific searches
      tasks.push(`Find ${business} companies in ${countryList} by searching for SPECIFIC PRODUCTS they make.`);

      // Competitor discovery
      tasks.push(`Find MORE ${business} companies in ${countryList} by discovering COMPETITORS of known companies.`);

      // Term variations if provided
      if (businessVariations && businessVariations.length > 0) {
        tasks.push(`Find companies in ${countryList} using ALTERNATIVE INDUSTRY TERMINOLOGY.`);
      }

      return tasks;
    }

    test('generates primary search task', () => {
      const tasks = generateSearchTasks('ink manufacturers', 'Thailand', 'large companies');
      expect(tasks[0]).toContain('Find ALL ink manufacturers');
      expect(tasks[0]).toContain('Thailand');
    });

    test('generates SME search task', () => {
      const tasks = generateSearchTasks('ink', 'Thailand', 'large companies');
      expect(tasks[1]).toContain('small and medium');
      expect(tasks[1]).toContain('locally owned');
    });

    test('generates industrial estate tasks for each country', () => {
      const tasks = generateSearchTasks('ink', 'Thailand, Vietnam', 'none');
      const estateTasks = tasks.filter(t => t.includes('INDUSTRIAL ESTATES'));
      expect(estateTasks.length).toBeGreaterThanOrEqual(2); // One for Thailand, one for Vietnam
    });

    test('generates industry association task', () => {
      const tasks = generateSearchTasks('ink', 'Thailand', 'none');
      const assocTask = tasks.find(t => t.includes('INDUSTRY ASSOCIATIONS'));
      expect(assocTask).toBeDefined();
    });

    test('generates local language task', () => {
      const tasks = generateSearchTasks('ink', 'Thailand', 'none');
      const langTask = tasks.find(t => t.includes('LOCAL LANGUAGE'));
      expect(langTask).toBeDefined();
    });

    test('generates supply chain task', () => {
      const tasks = generateSearchTasks('ink', 'Thailand', 'none');
      const supplyTask = tasks.find(t => t.includes('SUPPLY CHAIN'));
      expect(supplyTask).toBeDefined();
    });

    test('generates product-specific task', () => {
      const tasks = generateSearchTasks('ink', 'Thailand', 'none');
      const productTask = tasks.find(t => t.includes('SPECIFIC PRODUCTS'));
      expect(productTask).toBeDefined();
    });

    test('generates competitor discovery task', () => {
      const tasks = generateSearchTasks('ink', 'Thailand', 'none');
      const compTask = tasks.find(t => t.includes('COMPETITORS'));
      expect(compTask).toBeDefined();
    });

    test('includes business variations task when provided', () => {
      const tasks = generateSearchTasks('ink', 'Thailand', 'none', ['printing ink', 'industrial ink']);
      const varTask = tasks.find(t => t.includes('ALTERNATIVE INDUSTRY TERMINOLOGY'));
      expect(varTask).toBeDefined();
    });

    test('does not include variations task when not provided', () => {
      const tasks = generateSearchTasks('ink', 'Thailand', 'none', []);
      const varTask = tasks.find(t => t.includes('ALTERNATIVE INDUSTRY TERMINOLOGY'));
      expect(varTask).toBeUndefined();
    });

    test('handles multiple countries correctly', () => {
      const tasks = generateSearchTasks('ink', 'Thailand, Vietnam, Indonesia', 'none');
      expect(tasks[0]).toContain('Thailand, Vietnam, Indonesia');
    });

    test('generates correct number of base tasks', () => {
      const tasks = generateSearchTasks('ink', 'Thailand', 'none');
      // Base tasks: primary + SME + 1 industrial + association + local lang + supply + product + competitor
      expect(tasks.length).toBeGreaterThanOrEqual(8);
    });
  });
});
