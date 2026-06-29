/**
 * Unit tests for the Company Metrics engine in target-v6/server.js.
 *
 * These import the REAL functions from server.js (exported at the bottom of
 * that file) so the tests guard the shipping code, not a copy. Importing
 * server.js has no side effects — the HTTP server only starts when the file
 * is run directly.
 *
 * Network/AI/Playwright functions are intentionally not exercised here; only
 * pure, deterministic logic is covered (parsing, normalization, the SSRF host
 * guard, result selection, currency math with no remote lookup, Excel/email
 * building).
 */

const XLSX = require('xlsx');
const metrics = require('../target-v6/server');

describe('company-metrics: number + string helpers', () => {
  describe('cleanMetricString', () => {
    test('trims strings and coerces nullish to empty', () => {
      expect(metrics.cleanMetricString('  hi  ')).toBe('hi');
      expect(metrics.cleanMetricString(null)).toBe('');
      expect(metrics.cleanMetricString(undefined)).toBe('');
      expect(metrics.cleanMetricString(42)).toBe('42');
    });
  });

  describe('parseMetricNumber', () => {
    test('returns finite numbers unchanged', () => {
      expect(metrics.parseMetricNumber(1234)).toBe(1234);
      expect(metrics.parseMetricNumber(0)).toBe(0);
      expect(metrics.parseMetricNumber(-5)).toBe(-5);
    });

    test('parses numeric strings with commas and symbols', () => {
      expect(metrics.parseMetricNumber('1,234.5')).toBe(1234.5);
      expect(metrics.parseMetricNumber('¥1,234')).toBe(1234);
      expect(metrics.parseMetricNumber('-50')).toBe(-50);
    });

    test('returns null for empty / non-numeric / nullish input', () => {
      expect(metrics.parseMetricNumber('')).toBeNull();
      expect(metrics.parseMetricNumber('abc')).toBeNull();
      expect(metrics.parseMetricNumber(null)).toBeNull();
      expect(metrics.parseMetricNumber(undefined)).toBeNull();
      expect(metrics.parseMetricNumber(NaN)).toBeNull();
    });
  });

  describe('formatMetricNumber', () => {
    test('formats with thousands separators', () => {
      expect(metrics.formatMetricNumber(1234.5, 1)).toBe('1,234.5');
      expect(metrics.formatMetricNumber(1000000, 0)).toBe('1,000,000');
    });

    test('returns empty string for null / undefined / NaN', () => {
      expect(metrics.formatMetricNumber(null)).toBe('');
      expect(metrics.formatMetricNumber(undefined)).toBe('');
      expect(metrics.formatMetricNumber('abc')).toBe('');
    });
  });
});

describe('company-metrics: currency + unit normalization', () => {
  describe('normalizeCurrencyCode', () => {
    test('maps symbols to ISO codes', () => {
      expect(metrics.normalizeCurrencyCode('$')).toBe('USD');
      expect(metrics.normalizeCurrencyCode('¥')).toBe('JPY');
      expect(metrics.normalizeCurrencyCode('€')).toBe('EUR');
      expect(metrics.normalizeCurrencyCode('£')).toBe('GBP');
      expect(metrics.normalizeCurrencyCode('RMB')).toBe('CNY');
    });

    test('passes through and upper-cases known codes', () => {
      expect(metrics.normalizeCurrencyCode('usd')).toBe('USD');
      expect(metrics.normalizeCurrencyCode('jpy')).toBe('JPY');
    });

    test('strips non-letters and caps at 3 chars for unknown input', () => {
      expect(metrics.normalizeCurrencyCode('')).toBe('');
      expect(metrics.normalizeCurrencyCode('xyz')).toBe('XYZ');
    });
  });

  describe('normalizeRevenueUnit', () => {
    test('keeps recognized short and long units', () => {
      expect(metrics.normalizeRevenueUnit('mn')).toBe('mn');
      expect(metrics.normalizeRevenueUnit('m')).toBe('m');
      expect(metrics.normalizeRevenueUnit('million')).toBe('million');
      expect(metrics.normalizeRevenueUnit('bn')).toBe('bn');
    });

    test('fuzzy-matches descriptive units', () => {
      expect(metrics.normalizeRevenueUnit('USD millions')).toBe('million');
      expect(metrics.normalizeRevenueUnit('billions')).toBe('billion');
      expect(metrics.normalizeRevenueUnit('thousands')).toBe('thousand');
      expect(metrics.normalizeRevenueUnit('trillions')).toBe('trillion');
    });

    test('defaults to million when unknown or empty', () => {
      expect(metrics.normalizeRevenueUnit('')).toBe('million');
      expect(metrics.normalizeRevenueUnit('widgets')).toBe('million');
    });
  });
});

describe('company-metrics: SSRF host guard (security)', () => {
  describe('isBlockedMetricsHost', () => {
    test('blocks localhost and loopback', () => {
      expect(metrics.isBlockedMetricsHost('localhost')).toBe(true);
      expect(metrics.isBlockedMetricsHost('api.localhost')).toBe(true);
      expect(metrics.isBlockedMetricsHost('127.0.0.1')).toBe(true);
      expect(metrics.isBlockedMetricsHost('0.0.0.0')).toBe(true);
    });

    test('blocks RFC1918 private ranges', () => {
      expect(metrics.isBlockedMetricsHost('10.0.0.5')).toBe(true);
      expect(metrics.isBlockedMetricsHost('192.168.1.1')).toBe(true);
      expect(metrics.isBlockedMetricsHost('172.16.0.1')).toBe(true);
      expect(metrics.isBlockedMetricsHost('172.31.255.255')).toBe(true);
    });

    test('allows public hosts, including 172 addresses outside the private block', () => {
      expect(metrics.isBlockedMetricsHost('google.com')).toBe(false);
      expect(metrics.isBlockedMetricsHost('8.8.8.8')).toBe(false);
      expect(metrics.isBlockedMetricsHost('172.15.0.1')).toBe(false);
      expect(metrics.isBlockedMetricsHost('172.32.0.1')).toBe(false);
    });
  });

  describe('normalizeMetricsUrl', () => {
    test('adds https and a trailing slash for bare domains', () => {
      expect(metrics.normalizeMetricsUrl('toyota.com')).toBe('https://toyota.com/');
      expect(metrics.normalizeMetricsUrl('http://x.com')).toBe('http://x.com/');
    });

    test('strips wrapping brackets and trailing punctuation', () => {
      expect(metrics.normalizeMetricsUrl('<https://x.com>')).toBe('https://x.com/');
      expect(metrics.normalizeMetricsUrl('toyota.com.')).toBe('https://toyota.com/');
    });

    test('rejects hosts without a dot', () => {
      expect(() => metrics.normalizeMetricsUrl('localhost')).toThrow();
    });

    test('rejects private / loopback addresses', () => {
      expect(() => metrics.normalizeMetricsUrl('http://127.0.0.1')).toThrow();
      expect(() => metrics.normalizeMetricsUrl('http://192.168.0.1')).toThrow();
    });
  });
});

describe('company-metrics: input parsing', () => {
  describe('deriveCompanyFromWebsite', () => {
    test('derives a title-cased name from the domain', () => {
      expect(metrics.deriveCompanyFromWebsite('https://www.toyota-motor.com')).toBe('Toyota Motor');
      expect(metrics.deriveCompanyFromWebsite('https://sony.co.jp')).toBe('Sony');
    });

    test('returns empty string for unparseable input', () => {
      expect(metrics.deriveCompanyFromWebsite('not a url')).toBe('');
    });
  });

  describe('extractWebsiteFromLine', () => {
    test('finds full URLs, www hosts, and bare domains', () => {
      expect(metrics.extractWebsiteFromLine('Toyota https://toyota.com')).toBe(
        'https://toyota.com'
      );
      expect(metrics.extractWebsiteFromLine('see www.sony.com today')).toBe('www.sony.com');
      expect(metrics.extractWebsiteFromLine('Panasonic panasonic.com here')).toBe('panasonic.com');
    });

    test('returns empty string when no website is present', () => {
      expect(metrics.extractWebsiteFromLine('Just A Company Name')).toBe('');
    });
  });

  describe('parseCompanyMetricsItems', () => {
    test('parses company names, websites, and "company, website" rows', () => {
      const items = metrics.parseCompanyMetricsItems(
        'Toyota, https://toyota.com\nhttps://www.panasonic.com/\nSony'
      );
      expect(items).toHaveLength(3);

      expect(items[0]).toMatchObject({ companyName: 'Toyota', website: 'https://toyota.com/' });
      // website-only row derives a company name from the domain
      expect(items[1]).toMatchObject({
        companyName: 'Panasonic',
        website: 'https://www.panasonic.com/',
      });
      // company-only row has no website
      expect(items[2]).toMatchObject({ companyName: 'Sony', website: '' });
    });

    test('deduplicates identical rows', () => {
      const items = metrics.parseCompanyMetricsItems('Sony\nSony\nSony');
      expect(items).toHaveLength(1);
    });

    test('records a parse error for invalid / private URLs instead of throwing', () => {
      const items = metrics.parseCompanyMetricsItems('Local http://localhost');
      expect(items).toHaveLength(1);
      expect(items[0].parseError).toBeTruthy();
      expect(items[0].website).toBe('');
    });

    test('ignores blank lines', () => {
      const items = metrics.parseCompanyMetricsItems('\n\nSony\n   \n');
      expect(items).toHaveLength(1);
      expect(items[0].companyName).toBe('Sony');
    });
  });
});

describe('company-metrics: AI response parsing', () => {
  describe('extractMetricsJson', () => {
    test('parses raw JSON', () => {
      expect(metrics.extractMetricsJson('{"a":1}')).toEqual({ a: 1 });
    });

    test('parses JSON inside a markdown code fence', () => {
      expect(metrics.extractMetricsJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    });

    test('parses a JSON object embedded in surrounding prose', () => {
      expect(metrics.extractMetricsJson('here you go {"a":3} thanks')).toEqual({ a: 3 });
    });

    test('returns null for non-JSON or empty text', () => {
      expect(metrics.extractMetricsJson('no json here')).toBeNull();
      expect(metrics.extractMetricsJson('')).toBeNull();
      expect(metrics.extractMetricsJson(null)).toBeNull();
    });
  });

  describe('extractOpenAIResponseText', () => {
    test('prefers output_text when present', () => {
      expect(metrics.extractOpenAIResponseText({ output_text: 'hello' })).toBe('hello');
    });

    test('joins text parts from the output array', () => {
      const data = { output: [{ content: [{ text: 'a' }, { text: 'b' }] }] };
      expect(metrics.extractOpenAIResponseText(data)).toBe('a\nb');
    });

    test('returns empty string for empty / missing data', () => {
      expect(metrics.extractOpenAIResponseText({})).toBe('');
      expect(metrics.extractOpenAIResponseText(null)).toBe('');
    });
  });
});

describe('company-metrics: final result selection', () => {
  const baseItem = { input: 'Toyota', companyName: 'Toyota', website: 'https://toyota.com/' };
  const screenshot = { finalUrl: 'https://toyota.com/', screenshotBase64: 'abc' };
  const extraction = {
    company_name: 'Toyota Motor',
    revenue: {
      amount: 100,
      currency: 'JPY',
      unit: 'billion',
      period: 'FY2024',
      evidence: 'Revenue ¥100B',
    },
    headcount: { amount: 70000, period: '2024', evidence: '70,000 employees' },
  };

  test('uses validator final values when provided', () => {
    const validation = {
      revenue_validation: {
        status: 'verified',
        confidence: 0.9,
        final_amount: 100,
        final_currency: 'JPY',
        final_unit: 'billion',
        final_period: 'FY2024',
        reason: 'ok',
      },
      headcount_validation: {
        status: 'verified',
        confidence: 0.8,
        final_amount: 70000,
        final_period: '2024',
      },
      overall_note: 'looks good',
    };
    const r = metrics.buildFinalCompanyMetricsResult(
      baseItem,
      screenshot.finalUrl,
      screenshot,
      extraction,
      validation
    );
    expect(r.companyName).toBe('Toyota Motor');
    expect(r.screenshotStatus).toBe('Captured');
    expect(r.revenue.amount).toBe(100);
    expect(r.revenue.currency).toBe('JPY');
    expect(r.revenue.unit).toBe('billion');
    expect(r.revenue.status).toBe('verified');
    expect(r.headcount.amount).toBe(70000);
  });

  test('falls back to extraction value when validator gives no number but does not reject it', () => {
    const validation = {
      revenue_validation: { status: 'needs_review', confidence: 0.3, final_amount: null },
      headcount_validation: { status: 'needs_review', confidence: 0.3, final_amount: null },
    };
    const r = metrics.buildFinalCompanyMetricsResult(
      baseItem,
      screenshot.finalUrl,
      screenshot,
      extraction,
      validation
    );
    expect(r.revenue.amount).toBe(100); // from extraction
    expect(r.headcount.amount).toBe(70000); // from extraction
  });

  test('does NOT fall back when validator status is not_found', () => {
    const validation = {
      revenue_validation: { status: 'not_found', confidence: 0.9, final_amount: null },
      headcount_validation: { status: 'not_found', confidence: 0.9, final_amount: null },
    };
    const r = metrics.buildFinalCompanyMetricsResult(
      baseItem,
      screenshot.finalUrl,
      screenshot,
      extraction,
      validation
    );
    expect(r.revenue.amount).toBeNull();
    expect(r.headcount.amount).toBeNull();
  });

  test('uses a corrected validator amount over the extraction amount', () => {
    const validation = {
      revenue_validation: {
        status: 'corrected',
        confidence: 0.7,
        final_amount: 250,
        final_currency: 'JPY',
        final_unit: 'billion',
      },
      headcount_validation: { status: 'corrected', confidence: 0.7, final_amount: 65000 },
    };
    const r = metrics.buildFinalCompanyMetricsResult(
      baseItem,
      screenshot.finalUrl,
      screenshot,
      extraction,
      validation
    );
    expect(r.revenue.amount).toBe(250);
    expect(r.headcount.amount).toBe(65000);
  });

  test('marks screenshot as not captured when no image was taken', () => {
    const r = metrics.buildFinalCompanyMetricsResult(
      baseItem,
      'https://toyota.com/',
      { finalUrl: 'https://toyota.com/' },
      extraction,
      {}
    );
    expect(r.screenshotStatus).toBe('Not captured');
  });
});

describe('company-metrics: currency conversion (no network)', () => {
  test('returns null with a note when the amount is missing', async () => {
    const out = await metrics.convertCompanyMetricsRevenue(
      { amount: null, currency: 'JPY', unit: 'million' },
      'JPY',
      'million'
    );
    expect(out.amount).toBeNull();
    expect(out.note).toMatch(/could not be converted/i);
  });

  test('rescales units within the same currency without a remote lookup', async () => {
    // JPY million -> JPY thousand: rate is 1 (same currency), so no fetch happens.
    const out = await metrics.convertCompanyMetricsRevenue(
      { amount: 1000, currency: 'JPY', unit: 'million' },
      'JPY',
      'thousand'
    );
    expect(out.currency).toBe('JPY');
    expect(out.unit).toBe('thousand');
    expect(out.amount).toBe((1000 * 1_000_000) / 1_000); // 1,000,000 thousand
  });

  test('keeps the amount when currency and unit already match', async () => {
    const out = await metrics.convertCompanyMetricsRevenue(
      { amount: 1000, currency: 'JPY', unit: 'million' },
      'JPY',
      'million'
    );
    expect(out.amount).toBe(1000);
    expect(out.note).toMatch(/no currency conversion needed/i);
  });
});

describe('company-metrics: output building', () => {
  const results = [
    {
      input: 'Toyota, https://toyota.com',
      companyName: 'Toyota Motor',
      website: 'https://toyota.com/',
      finalUrl: 'https://toyota.com/',
      screenshotStatus: 'Captured',
      revenue: {
        amount: 100,
        currency: 'JPY',
        unit: 'billion',
        period: 'FY2024',
        evidence: 'Revenue ¥100B',
        status: 'verified',
        confidence: 0.9,
      },
      headcount: {
        amount: 70000,
        period: '2024',
        evidence: '70,000 employees',
        status: 'verified',
        confidence: 0.8,
      },
      convertedRevenue: { amount: 100000, currency: 'JPY', unit: 'million', note: 'normalized' },
      overallNote: 'looks good',
      error: '',
    },
    {
      input: 'Nope',
      companyName: 'Nope',
      website: '',
      finalUrl: '',
      screenshotStatus: 'Failed',
      revenue: {},
      headcount: {},
      overallNote: '',
      error: 'Official website could not be found.',
    },
  ];

  describe('formatOriginalRevenue', () => {
    test('formats currency + amount + unit', () => {
      expect(
        metrics.formatOriginalRevenue({ amount: 1234.5, currency: 'JPY', unit: 'billion' })
      ).toBe('JPY 1,234.5 billion');
      // trailing zeros are dropped (minimumFractionDigits: 0)
      expect(
        metrics.formatOriginalRevenue({ amount: 1000, currency: 'USD', unit: 'million' })
      ).toBe('USD 1,000 million');
    });

    test('returns empty string when amount or currency is missing', () => {
      expect(metrics.formatOriginalRevenue({ amount: null, currency: 'JPY' })).toBe('');
      expect(metrics.formatOriginalRevenue({ amount: 100, currency: '' })).toBe('');
    });
  });

  describe('buildCompanyMetricsExcel', () => {
    test('produces a decodable workbook with headers and data', () => {
      const base64 = metrics.buildCompanyMetricsExcel(results, 'JPY', 'million');
      expect(typeof base64).toBe('string');
      expect(base64.length).toBeGreaterThan(0);

      const wb = XLSX.read(base64, { type: 'base64' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      const headers = rows[0];
      expect(headers).toContain('Company Name');
      expect(headers).toContain('Revenue Original');
      expect(headers).toContain('Revenue (JPY million)');
      expect(headers).toContain('Headcount');
      expect(headers).toContain('Error');

      // header row + 2 data rows
      expect(rows.length).toBe(3);
      const firstDataRow = rows[1];
      expect(firstDataRow).toContain('Toyota Motor');
    });
  });

  describe('buildCompanyMetricsEmailHtml', () => {
    test('summarizes processed counts and found metrics', () => {
      const html = metrics.buildCompanyMetricsEmailHtml(results, 'JPY', 'million');
      expect(html).toContain('Company Metrics Complete');
      expect(html).toContain('Processed 1/2 rows.'); // one row has an error
      expect(html).toContain('Revenue found: 1');
      expect(html).toContain('Headcount found: 1');
    });
  });
});
