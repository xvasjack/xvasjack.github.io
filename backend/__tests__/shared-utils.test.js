/**
 * Tests for shared utility functions
 */

const {
  ensureString,
  normalizeCompanyName,
  normalizeWebsite,
  extractDomainRoot,
  isSpamOrDirectoryURL,
  dedupeCompanies,
  buildExclusionRules,
  detectMeetingDomain,
  getDomainInstructions,
  buildOutputFormat,
} = require('../shared/utils');

describe('ensureString', () => {
  test('returns string as-is', () => {
    expect(ensureString('hello')).toBe('hello');
  });

  test('returns default for null/undefined', () => {
    expect(ensureString(null)).toBe('');
    expect(ensureString(undefined)).toBe('');
    expect(ensureString(null, 'default')).toBe('default');
  });

  test('joins arrays', () => {
    expect(ensureString(['a', 'b'])).toBe('a, b');
  });

  test('extracts city/country from object', () => {
    expect(ensureString({ city: 'NYC', country: 'USA' })).toBe('NYC, USA');
  });

  test('extracts text/value/name from object', () => {
    expect(ensureString({ text: 'hello' })).toBe('hello');
    expect(ensureString({ value: 'world' })).toBe('world');
    expect(ensureString({ name: 'test' })).toBe('test');
  });

  test('stringifies unknown objects', () => {
    expect(ensureString({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  test('converts primitives', () => {
    expect(ensureString(123)).toBe('123');
    expect(ensureString(true)).toBe('true');
  });
});

describe('normalizeCompanyName', () => {
  test('removes legal suffixes', () => {
    expect(normalizeCompanyName('Acme Inc.')).toBe('acme');
    expect(normalizeCompanyName('Test Corp')).toBe('test');
    expect(normalizeCompanyName('Company Sdn Bhd')).toBe('company');
    expect(normalizeCompanyName('Firm Pte Ltd')).toBe('firm');
  });

  test('removes prefixes', () => {
    expect(normalizeCompanyName('PT Acme')).toBe('acme');
    expect(normalizeCompanyName('CV Test')).toBe('test');
  });

  test('handles empty/null', () => {
    expect(normalizeCompanyName(null)).toBe('');
    expect(normalizeCompanyName('')).toBe('');
  });
});

describe('normalizeWebsite', () => {
  test('removes protocol and www', () => {
    expect(normalizeWebsite('https://www.example.com')).toBe('example.com');
    expect(normalizeWebsite('http://example.com')).toBe('example.com');
  });

  test('removes trailing slashes', () => {
    expect(normalizeWebsite('https://example.com/')).toBe('example.com');
  });

  test('removes common paths', () => {
    expect(normalizeWebsite('https://example.com/home')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/about')).toBe('example.com');
  });

  test('handles empty/null', () => {
    expect(normalizeWebsite(null)).toBe('');
    expect(normalizeWebsite('')).toBe('');
  });
});

describe('extractDomainRoot', () => {
  test('extracts domain from URL', () => {
    expect(extractDomainRoot('https://www.example.com/path')).toBe('example.com');
    expect(extractDomainRoot('https://sub.example.com')).toBe('sub.example.com');
  });

  test('handles empty/null', () => {
    expect(extractDomainRoot(null)).toBe('');
  });
});

describe('isSpamOrDirectoryURL', () => {
  test('detects spam URLs', () => {
    expect(isSpamOrDirectoryURL('https://facebook.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://en.wikipedia.org/wiki/Test')).toBe(true);
  });

  test('accepts valid company URLs', () => {
    expect(isSpamOrDirectoryURL('https://acme.com')).toBe(false);
  });

  test('returns true for null/empty', () => {
    expect(isSpamOrDirectoryURL(null)).toBe(true);
    expect(isSpamOrDirectoryURL('')).toBe(true);
  });
});

describe('dedupeCompanies', () => {
  test('removes duplicates', () => {
    const companies = [
      { company_name: 'Acme', website: 'https://acme.com' },
      { company_name: 'Acme Inc', website: 'https://acme.com' },
    ];
    expect(dedupeCompanies(companies)).toHaveLength(1);
  });

  test('filters invalid entries', () => {
    const companies = [
      { company_name: 'Acme', website: 'https://acme.com' },
      { company_name: '', website: 'https://test.com' },
      { company_name: 'Test', website: '' },
    ];
    expect(dedupeCompanies(companies)).toHaveLength(1);
  });

  test('handles non-array input', () => {
    expect(dedupeCompanies(null)).toEqual([]);
    expect(dedupeCompanies('string')).toEqual([]);
  });
});

describe('buildExclusionRules', () => {
  test('builds large company rules', () => {
    const rules = buildExclusionRules('no large companies');
    expect(rules).toContain('Exclude large multinationals');
  });

  test('builds listed company rules', () => {
    const rules = buildExclusionRules('no public listed');
    expect(rules).toContain('publicly listed');
  });

  test('builds distributor rules', () => {
    const rules = buildExclusionRules('exclude distributors');
    expect(rules).toContain('distributor');
  });

  test('handles empty input', () => {
    expect(buildExclusionRules('')).toBe('');
    expect(buildExclusionRules(null)).toBe('');
  });
});

describe('detectMeetingDomain', () => {
  test('detects financial domain', () => {
    expect(detectMeetingDomain('discussing EBITDA margins')).toBe('financial');
  });

  test('detects legal domain', () => {
    expect(detectMeetingDomain('review the NDA clause')).toBe('legal');
  });

  test('detects medical domain', () => {
    expect(detectMeetingDomain('FDA approval for drug')).toBe('medical');
  });

  test('detects technical domain', () => {
    expect(detectMeetingDomain('deploy to kubernetes')).toBe('technical');
  });

  test('detects HR domain', () => {
    expect(detectMeetingDomain('compensation and benefits')).toBe('hr');
  });

  test('returns general for unmatched', () => {
    expect(detectMeetingDomain('hello world')).toBe('general');
    expect(detectMeetingDomain(null)).toBe('general');
  });
});

describe('getDomainInstructions', () => {
  test('returns instructions for each domain', () => {
    expect(getDomainInstructions('financial')).toContain('financial');
    expect(getDomainInstructions('legal')).toContain('legal');
    expect(getDomainInstructions('medical')).toContain('medical');
    expect(getDomainInstructions('technical')).toContain('technical');
    expect(getDomainInstructions('hr')).toContain('HR');
  });

  test('returns general for unknown', () => {
    expect(getDomainInstructions('unknown')).toContain('professional');
  });
});

describe('buildOutputFormat', () => {
  test('returns format with required fields', () => {
    const format = buildOutputFormat();
    expect(format).toContain('company_name');
    expect(format).toContain('website');
    expect(format).toContain('hq');
    expect(format).toContain('description');
  });
});
