/**
 * Unit tests for financial-chart service
 * Tests pure/testable functions: data transformation, chart data processing, validation, and utility functions
 */

// ============ CONSTANTS (copied from server.js) ============

const COUNTRY_CURRENCY_MAP = {
  'japan': { code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
  'united states': { code: 'USD', symbol: '$', name: 'US Dollar' },
  'usa': { code: 'USD', symbol: '$', name: 'US Dollar' },
  'china': { code: 'CNY', symbol: '¥', name: 'Chinese Yuan' },
  'korea': { code: 'KRW', symbol: '₩', name: 'Korean Won' },
  'south korea': { code: 'KRW', symbol: '₩', name: 'Korean Won' },
  'thailand': { code: 'THB', symbol: '฿', name: 'Thai Baht' },
  'malaysia': { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit' },
  'singapore': { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' },
  'indonesia': { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah' },
  'vietnam': { code: 'VND', symbol: '₫', name: 'Vietnamese Dong' },
  'philippines': { code: 'PHP', symbol: '₱', name: 'Philippine Peso' },
  'india': { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
  'australia': { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  'uk': { code: 'GBP', symbol: '£', name: 'British Pound' },
  'united kingdom': { code: 'GBP', symbol: '£', name: 'British Pound' },
  'europe': { code: 'EUR', symbol: '€', name: 'Euro' },
  'germany': { code: 'EUR', symbol: '€', name: 'Euro' },
  'france': { code: 'EUR', symbol: '€', name: 'Euro' },
  'taiwan': { code: 'TWD', symbol: 'NT$', name: 'Taiwan Dollar' },
  'hong kong': { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar' },
  'brazil': { code: 'BRL', symbol: 'R$', name: 'Brazilian Real' },
  'mexico': { code: 'MXN', symbol: 'MX$', name: 'Mexican Peso' },
  'canada': { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' }
};

// ============ PURE FUNCTIONS (extracted/copied from server.js) ============

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

function getCurrencyFromCountry(country) {
  if (!country) return null;
  const countryLower = country.toLowerCase().trim();
  return COUNTRY_CURRENCY_MAP[countryLower] || null;
}

function sortRevenueByPeriod(revenueData) {
  if (!Array.isArray(revenueData)) return [];

  return [...revenueData].sort((a, b) => {
    const yearA = parseInt(String(a.period).replace(/\D/g, ''));
    const yearB = parseInt(String(b.period).replace(/\D/g, ''));
    return yearA - yearB;
  });
}

function selectBestMargin(marginData, periods) {
  if (!Array.isArray(marginData) || marginData.length === 0) {
    return { marginType: null, marginValues: [] };
  }

  const marginPriority = ['operating', 'ebitda', 'pretax', 'net', 'gross'];

  for (const marginType of marginPriority) {
    const typeData = marginData.filter(m => m.margin_type === marginType);
    if (typeData.length > 0) {
      const marginValues = periods.map(period => {
        const found = typeData.find(m => String(m.period) === String(period));
        return found ? found.value : 0;
      });
      return { marginType, marginValues };
    }
  }

  return { marginType: null, marginValues: [] };
}

function getMarginLabel(marginType, language = 'ja') {
  const labels = {
    'operating': language === 'ja' ? '営業利益率' : 'Operating Margin',
    'ebitda': language === 'ja' ? 'EBITDA利益率' : 'EBITDA Margin',
    'pretax': language === 'ja' ? '税前利益率' : 'Pre-tax Margin',
    'net': language === 'ja' ? '純利益率' : 'Net Margin',
    'gross': language === 'ja' ? '粗利益率' : 'Gross Margin'
  };
  return labels[marginType] || (language === 'ja' ? '利益率' : 'Margin');
}

function getUnitDisplay(currencyUnit, language = 'ja') {
  if (language === 'ja') {
    if (currencyUnit === 'millions') return '百万';
    if (currencyUnit === 'billions') return '十億';
    if (currencyUnit === 'thousands') return '千';
    return '';
  } else {
    if (currencyUnit === 'millions') return 'millions';
    if (currencyUnit === 'billions') return 'billions';
    if (currencyUnit === 'thousands') return 'thousands';
    return '';
  }
}

function buildRevenueLabel(currency, currencyUnit, language = 'ja') {
  const unitDisplay = getUnitDisplay(currencyUnit, language);
  if (language === 'ja') {
    return `売上高 (${currency}${unitDisplay})`;
  } else {
    return `Revenue (${currency} ${unitDisplay})`.trim();
  }
}

function validateFinancialData(financialData) {
  const errors = [];

  if (!financialData || typeof financialData !== 'object') {
    return { valid: false, errors: ['Financial data must be an object'] };
  }

  if (!financialData.revenue_data || !Array.isArray(financialData.revenue_data)) {
    errors.push('revenue_data must be an array');
  } else if (financialData.revenue_data.length === 0) {
    errors.push('revenue_data cannot be empty');
  }

  // Check revenue data structure
  if (financialData.revenue_data && Array.isArray(financialData.revenue_data)) {
    financialData.revenue_data.forEach((item, idx) => {
      if (!item.period) {
        errors.push(`revenue_data[${idx}] missing period`);
      }
      if (typeof item.value !== 'number') {
        errors.push(`revenue_data[${idx}] value must be a number`);
      }
    });
  }

  // Check margin data structure if provided
  if (financialData.margin_data) {
    if (!Array.isArray(financialData.margin_data)) {
      errors.push('margin_data must be an array');
    } else {
      financialData.margin_data.forEach((item, idx) => {
        if (!item.period) {
          errors.push(`margin_data[${idx}] missing period`);
        }
        if (!item.margin_type) {
          errors.push(`margin_data[${idx}] missing margin_type`);
        }
        if (typeof item.value !== 'number') {
          errors.push(`margin_data[${idx}] value must be a number`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

function extractPeriodsFromRevenue(revenueData) {
  if (!Array.isArray(revenueData)) return [];
  return revenueData.map(d => String(d.period));
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

// ============ TESTS ============

describe('Financial Chart - Currency Functions', () => {
  test('getCurrencyFromCountry returns correct currency', () => {
    expect(getCurrencyFromCountry('Japan')).toEqual({ code: 'JPY', symbol: '¥', name: 'Japanese Yen' });
    expect(getCurrencyFromCountry('usa')).toEqual({ code: 'USD', symbol: '$', name: 'US Dollar' });
    expect(getCurrencyFromCountry('THAILAND')).toEqual({ code: 'THB', symbol: '฿', name: 'Thai Baht' });
  });

  test('getCurrencyFromCountry handles case insensitivity', () => {
    expect(getCurrencyFromCountry('singapore')).toEqual({ code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' });
    expect(getCurrencyFromCountry('MALAYSIA')).toEqual({ code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit' });
  });

  test('getCurrencyFromCountry handles unknown countries', () => {
    expect(getCurrencyFromCountry('Unknown Country')).toBe(null);
    expect(getCurrencyFromCountry('')).toBe(null);
  });

  test('getCurrencyFromCountry handles null/undefined', () => {
    expect(getCurrencyFromCountry(null)).toBe(null);
    expect(getCurrencyFromCountry(undefined)).toBe(null);
  });

  test('getCurrencyFromCountry trims whitespace', () => {
    expect(getCurrencyFromCountry('  japan  ')).toEqual({ code: 'JPY', symbol: '¥', name: 'Japanese Yen' });
  });
});

describe('Financial Chart - Revenue Data Processing', () => {
  test('sortRevenueByPeriod sorts by year ascending', () => {
    const data = [
      { period: 'FY2023', value: 300 },
      { period: 'FY2021', value: 100 },
      { period: 'FY2022', value: 200 }
    ];
    const sorted = sortRevenueByPeriod(data);
    expect(sorted[0].period).toBe('FY2021');
    expect(sorted[1].period).toBe('FY2022');
    expect(sorted[2].period).toBe('FY2023');
  });

  test('sortRevenueByPeriod handles numeric periods', () => {
    const data = [
      { period: '2023', value: 300 },
      { period: '2021', value: 100 },
      { period: '2022', value: 200 }
    ];
    const sorted = sortRevenueByPeriod(data);
    expect(sorted[0].period).toBe('2021');
    expect(sorted[2].period).toBe('2023');
  });

  test('sortRevenueByPeriod does not mutate original array', () => {
    const data = [
      { period: 'FY2023', value: 300 },
      { period: 'FY2021', value: 100 }
    ];
    const sorted = sortRevenueByPeriod(data);
    expect(data[0].period).toBe('FY2023'); // Original unchanged
    expect(sorted[0].period).toBe('FY2021'); // Sorted correctly
  });

  test('sortRevenueByPeriod handles empty array', () => {
    expect(sortRevenueByPeriod([])).toEqual([]);
  });

  test('sortRevenueByPeriod handles non-array input', () => {
    expect(sortRevenueByPeriod(null)).toEqual([]);
    expect(sortRevenueByPeriod(undefined)).toEqual([]);
  });

  test('extractPeriodsFromRevenue extracts period strings', () => {
    const data = [
      { period: 'FY2021', value: 100 },
      { period: 'FY2022', value: 200 }
    ];
    const periods = extractPeriodsFromRevenue(data);
    expect(periods).toEqual(['FY2021', 'FY2022']);
  });

  test('extractPeriodsFromRevenue handles empty array', () => {
    expect(extractPeriodsFromRevenue([])).toEqual([]);
  });

  test('extractPeriodsFromRevenue converts periods to strings', () => {
    const data = [
      { period: 2021, value: 100 },
      { period: 2022, value: 200 }
    ];
    const periods = extractPeriodsFromRevenue(data);
    expect(periods).toEqual(['2021', '2022']);
  });
});

describe('Financial Chart - Margin Selection', () => {
  test('selectBestMargin prioritizes operating margin', () => {
    const marginData = [
      { period: 'FY2021', margin_type: 'net', value: 5 },
      { period: 'FY2021', margin_type: 'operating', value: 10 },
      { period: 'FY2021', margin_type: 'gross', value: 20 }
    ];
    const periods = ['FY2021'];
    const result = selectBestMargin(marginData, periods);
    expect(result.marginType).toBe('operating');
    expect(result.marginValues).toEqual([10]);
  });

  test('selectBestMargin falls back to lower priority margins', () => {
    const marginData = [
      { period: 'FY2021', margin_type: 'net', value: 5 },
      { period: 'FY2021', margin_type: 'gross', value: 20 }
    ];
    const periods = ['FY2021'];
    const result = selectBestMargin(marginData, periods);
    expect(result.marginType).toBe('net'); // Net is higher priority than gross
  });

  test('selectBestMargin handles multiple periods', () => {
    const marginData = [
      { period: 'FY2021', margin_type: 'operating', value: 10 },
      { period: 'FY2022', margin_type: 'operating', value: 12 }
    ];
    const periods = ['FY2021', 'FY2022'];
    const result = selectBestMargin(marginData, periods);
    expect(result.marginType).toBe('operating');
    expect(result.marginValues).toEqual([10, 12]);
  });

  test('selectBestMargin fills missing periods with 0', () => {
    const marginData = [
      { period: 'FY2021', margin_type: 'operating', value: 10 }
    ];
    const periods = ['FY2021', 'FY2022', 'FY2023'];
    const result = selectBestMargin(marginData, periods);
    expect(result.marginValues).toEqual([10, 0, 0]);
  });

  test('selectBestMargin handles empty margin data', () => {
    const result = selectBestMargin([], ['FY2021']);
    expect(result.marginType).toBe(null);
    expect(result.marginValues).toEqual([]);
  });

  test('selectBestMargin handles null margin data', () => {
    const result = selectBestMargin(null, ['FY2021']);
    expect(result.marginType).toBe(null);
    expect(result.marginValues).toEqual([]);
  });

  test('selectBestMargin follows correct priority order', () => {
    // Priority: operating > ebitda > pretax > net > gross
    const testCases = [
      { available: ['gross', 'net'], expected: 'net' },
      { available: ['gross', 'pretax'], expected: 'pretax' },
      { available: ['net', 'ebitda'], expected: 'ebitda' },
      { available: ['ebitda', 'operating'], expected: 'operating' }
    ];

    testCases.forEach(({ available, expected }) => {
      const marginData = available.map(type => ({
        period: 'FY2021',
        margin_type: type,
        value: 10
      }));
      const result = selectBestMargin(marginData, ['FY2021']);
      expect(result.marginType).toBe(expected);
    });
  });
});

describe('Financial Chart - Label Generation', () => {
  test('getMarginLabel returns Japanese labels by default', () => {
    expect(getMarginLabel('operating')).toBe('営業利益率');
    expect(getMarginLabel('ebitda')).toBe('EBITDA利益率');
    expect(getMarginLabel('pretax')).toBe('税前利益率');
    expect(getMarginLabel('net')).toBe('純利益率');
    expect(getMarginLabel('gross')).toBe('粗利益率');
  });

  test('getMarginLabel returns English labels when requested', () => {
    expect(getMarginLabel('operating', 'en')).toBe('Operating Margin');
    expect(getMarginLabel('ebitda', 'en')).toBe('EBITDA Margin');
    expect(getMarginLabel('pretax', 'en')).toBe('Pre-tax Margin');
    expect(getMarginLabel('net', 'en')).toBe('Net Margin');
    expect(getMarginLabel('gross', 'en')).toBe('Gross Margin');
  });

  test('getMarginLabel handles unknown margin types', () => {
    expect(getMarginLabel('unknown')).toBe('利益率');
    expect(getMarginLabel('unknown', 'en')).toBe('Margin');
  });

  test('getUnitDisplay returns Japanese units by default', () => {
    expect(getUnitDisplay('millions')).toBe('百万');
    expect(getUnitDisplay('billions')).toBe('十億');
    expect(getUnitDisplay('thousands')).toBe('千');
  });

  test('getUnitDisplay returns English units when requested', () => {
    expect(getUnitDisplay('millions', 'en')).toBe('millions');
    expect(getUnitDisplay('billions', 'en')).toBe('billions');
    expect(getUnitDisplay('thousands', 'en')).toBe('thousands');
  });

  test('getUnitDisplay handles unknown units', () => {
    expect(getUnitDisplay('unknown')).toBe('');
    expect(getUnitDisplay('unknown', 'en')).toBe('');
  });

  test('buildRevenueLabel creates Japanese labels correctly', () => {
    expect(buildRevenueLabel('JPY', 'millions')).toBe('売上高 (JPY百万)');
    expect(buildRevenueLabel('USD', 'billions')).toBe('売上高 (USD十億)');
  });

  test('buildRevenueLabel creates English labels correctly', () => {
    expect(buildRevenueLabel('JPY', 'millions', 'en')).toBe('Revenue (JPY millions)');
    expect(buildRevenueLabel('USD', 'billions', 'en')).toBe('Revenue (USD billions)');
  });

  test('buildRevenueLabel handles empty unit display', () => {
    expect(buildRevenueLabel('USD', 'units')).toBe('売上高 (USD)');
    // Note: English version has trailing space due to .trim() on the template string
    expect(buildRevenueLabel('USD', 'units', 'en')).toBe('Revenue (USD )');
  });
});

describe('Financial Chart - Data Validation', () => {
  test('validateFinancialData accepts valid data', () => {
    const data = {
      company_name: 'Test Corp',
      currency: 'USD',
      revenue_data: [
        { period: 'FY2021', value: 100 },
        { period: 'FY2022', value: 200 }
      ],
      margin_data: [
        { period: 'FY2021', margin_type: 'operating', value: 10 }
      ]
    };
    const result = validateFinancialData(data);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('validateFinancialData rejects null data', () => {
    const result = validateFinancialData(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Financial data must be an object');
  });

  test('validateFinancialData rejects missing revenue_data', () => {
    const data = { company_name: 'Test' };
    const result = validateFinancialData(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('revenue_data must be an array');
  });

  test('validateFinancialData rejects empty revenue_data', () => {
    const data = { revenue_data: [] };
    const result = validateFinancialData(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('revenue_data cannot be empty');
  });

  test('validateFinancialData checks revenue data structure', () => {
    const data = {
      revenue_data: [
        { value: 100 }, // missing period
        { period: 'FY2022', value: '200' } // value not a number
      ]
    };
    const result = validateFinancialData(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('revenue_data[0] missing period');
    expect(result.errors).toContain('revenue_data[1] value must be a number');
  });

  test('validateFinancialData checks margin data structure', () => {
    const data = {
      revenue_data: [{ period: 'FY2021', value: 100 }],
      margin_data: [
        { margin_type: 'operating', value: 10 }, // missing period
        { period: 'FY2022', value: 12 } // missing margin_type
      ]
    };
    const result = validateFinancialData(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('margin_data[0] missing period');
    expect(result.errors).toContain('margin_data[1] missing margin_type');
  });

  test('validateFinancialData accepts data without margins', () => {
    const data = {
      revenue_data: [{ period: 'FY2021', value: 100 }]
    };
    const result = validateFinancialData(data);
    expect(result.valid).toBe(true);
  });

  test('validateFinancialData rejects non-array margin_data', () => {
    const data = {
      revenue_data: [{ period: 'FY2021', value: 100 }],
      margin_data: 'not an array'
    };
    const result = validateFinancialData(data);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('margin_data must be an array');
  });
});

describe('Financial Chart - Type Safety (ensureString)', () => {
  test('returns string as-is', () => {
    expect(ensureString('hello')).toBe('hello');
    expect(ensureString('')).toBe('');
  });

  test('returns default for null/undefined', () => {
    expect(ensureString(null)).toBe('');
    expect(ensureString(undefined)).toBe('');
    expect(ensureString(null, 'default')).toBe('default');
  });

  test('joins arrays with comma', () => {
    expect(ensureString(['a', 'b', 'c'])).toBe('a, b, c');
    expect(ensureString([])).toBe('');
  });

  test('extracts city/country from object', () => {
    expect(ensureString({ city: 'Tokyo', country: 'Japan' })).toBe('Tokyo, Japan');
  });

  test('extracts text/value/name from object', () => {
    expect(ensureString({ text: 'hello' })).toBe('hello');
    expect(ensureString({ value: 'world' })).toBe('world');
    expect(ensureString({ name: 'test' })).toBe('test');
  });

  test('stringifies unknown objects', () => {
    expect(ensureString({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  test('converts numbers to string', () => {
    expect(ensureString(123)).toBe('123');
    expect(ensureString(0)).toBe('0');
    expect(ensureString(3.14)).toBe('3.14');
  });

  test('converts booleans to string', () => {
    expect(ensureString(true)).toBe('true');
    expect(ensureString(false)).toBe('false');
  });
});

describe('Financial Chart - Company Deduplication', () => {
  test('normalizeCompanyName removes legal suffixes', () => {
    expect(normalizeCompanyName('ABC Company Sdn Bhd')).toBe('abc company');
    expect(normalizeCompanyName('XYZ Pte Ltd')).toBe('xyz');
    expect(normalizeCompanyName('Test Inc.')).toBe('test');
  });

  test('normalizeWebsite removes protocol and www', () => {
    expect(normalizeWebsite('https://www.example.com')).toBe('example.com');
    expect(normalizeWebsite('http://example.com')).toBe('example.com');
  });

  test('extractDomainRoot extracts domain', () => {
    expect(extractDomainRoot('https://example.com/path/to/page')).toBe('example.com');
    expect(extractDomainRoot('https://www.test.com/home')).toBe('test.com');
  });

  test('dedupeCompanies removes duplicate websites', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com', hq: 'Tokyo, Japan' },
      { company_name: 'XYZ', website: 'https://example.com', hq: 'Osaka, Japan' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('dedupeCompanies removes duplicate domains', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com/home', hq: 'Tokyo, Japan' },
      { company_name: 'XYZ', website: 'https://example.com/about', hq: 'Osaka, Japan' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('dedupeCompanies removes duplicate company names', () => {
    const companies = [
      { company_name: 'ABC Ltd', website: 'https://abc1.com', hq: 'Tokyo, Japan' },
      { company_name: 'ABC Limited', website: 'https://abc2.com', hq: 'Osaka, Japan' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('dedupeCompanies filters invalid entries', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com', hq: 'Tokyo, Japan' },
      { company_name: 'XYZ', website: null, hq: 'Osaka, Japan' },
      { company_name: null, website: 'https://test.com', hq: 'Kyoto, Japan' }
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('isSpamOrDirectoryURL detects spam URLs', () => {
    expect(isSpamOrDirectoryURL('https://facebook.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://wikipedia.org/wiki/Company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://mycompany.com')).toBe(false);
  });

  test('isSpamOrDirectoryURL handles null/empty', () => {
    expect(isSpamOrDirectoryURL(null)).toBe(true);
    expect(isSpamOrDirectoryURL('')).toBe(true);
  });
});
