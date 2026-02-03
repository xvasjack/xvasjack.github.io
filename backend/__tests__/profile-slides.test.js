/**
 * Unit tests for profile-slides service
 * Tests pure/testable functions: data transformation, validation, and utility functions
 */

// ============ CONSTANTS (copied from server.js) ============

const COUNTRY_FLAG_MAP = {
  philippines: 'PH',
  ph: 'PH',
  manila: 'PH',
  thailand: 'TH',
  th: 'TH',
  bangkok: 'TH',
  malaysia: 'MY',
  my: 'MY',
  'kuala lumpur': 'MY',
  indonesia: 'ID',
  id: 'ID',
  jakarta: 'ID',
  singapore: 'SG',
  sg: 'SG',
  vietnam: 'VN',
  vn: 'VN',
  'ho chi minh': 'VN',
  hanoi: 'VN',
  japan: 'JP',
  jp: 'JP',
  tokyo: 'JP',
  china: 'CN',
  cn: 'CN',
  beijing: 'CN',
  shanghai: 'CN',
  korea: 'KR',
  kr: 'KR',
  seoul: 'KR',
  taiwan: 'TW',
  tw: 'TW',
  taipei: 'TW',
  usa: 'US',
  us: 'US',
  'united states': 'US',
  america: 'US',
  uk: 'GB',
  'united kingdom': 'GB',
  england: 'GB',
  london: 'GB',
  australia: 'AU',
  au: 'AU',
  sydney: 'AU',
  india: 'IN',
  in: 'IN',
  mumbai: 'IN',
  delhi: 'IN',
  'hong kong': 'HK',
  hk: 'HK',
};

const SHORTFORM_DEFINITIONS = {
  SEA: 'Southeast Asia',
  OEM: 'Original Equipment Manufacturer',
  SKU: 'Stock Keeping Unit',
  ERP: 'Enterprise Resource Planning',
  CRM: 'Customer Relationship Management',
};

const COMMON_SHORTFORMS = [
  'M',
  'B',
  'K',
  'HQ',
  'CEO',
  'CFO',
  'COO',
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CNY',
  'KRW',
  'TWD',
  'IDR',
  'SGD',
  'MYR',
  'THB',
  'PHP',
  'VND',
  'INR',
  'HKD',
  'AUD',
  'ISO',
  'FY',
  'YoY',
  'QoQ',
  'B2B',
  'B2C',
  'AI',
  'IT',
  'IoT',
];

// ============ PURE FUNCTIONS (copied from server.js) ============

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

function extractCompanyNameFromUrl(url) {
  try {
    const urlObj = new URL(url);
    let domain = urlObj.hostname.replace(/^www\./, '');
    domain = domain.replace(
      /\.(com|co|org|net|io|ai|jp|cn|kr|sg|my|th|vn|id|ph|tw|hk|in|de|uk|fr|it|es|au|nz|ca|us|br|mx|ru|nl|be|ch|at|se|no|dk|fi|pl|cz|hu|ro|bg|gr|tr|ae|sa|il|za|ng|eg|ke)(\.[a-z]{2,3})?$/i,
      ''
    );
    const name = domain
      .split(/[-_.]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
    return name || domain;
  } catch (e) {
    return url;
  }
}

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

function getCountryCode(location) {
  if (!location) return null;
  const loc = location.toLowerCase();

  const hqMatch = loc.match(/hq:\s*([^\n]+)/i);
  if (hqMatch) {
    const hqLocation = hqMatch[1].trim();
    const parts = hqLocation.split(',').map((p) => p.trim());
    const country = parts[parts.length - 1];
    for (const [key, code] of Object.entries(COUNTRY_FLAG_MAP)) {
      if (country.includes(key)) return code;
    }
  }

  const parts = loc.split(',').map((p) => p.trim());
  if (parts.length >= 1) {
    const lastPart = parts[parts.length - 1];
    for (const [key, code] of Object.entries(COUNTRY_FLAG_MAP)) {
      if (lastPart.includes(key)) return code;
    }
  }

  for (const [key, code] of Object.entries(COUNTRY_FLAG_MAP)) {
    if (loc.includes(key)) return code;
  }
  return null;
}

function filterEmptyMetrics(keyMetrics) {
  if (!keyMetrics || !Array.isArray(keyMetrics)) return [];

  const emptyValuePatterns = [
    /no specific/i,
    /not specified/i,
    /not stated/i,
    /not available/i,
    /not found/i,
    /not provided/i,
    /not mentioned/i,
    /not disclosed/i,
    /unknown/i,
    /n\/a/i,
    /none listed/i,
    /none specified/i,
    /none stated/i,
    /no information/i,
    /no data/i,
    /^\s*-?\s*$/,
    /client\s*\d+/i,
    /client\s*[a-e]/i,
    /customer\s*\d+/i,
    /customer\s*[a-e]/i,
    /supplier\s*\d+/i,
    /partner\s*\d+/i,
    /company\s*\d+/i,
    /various\s+(printers|companies|manufacturers|customers|suppliers|partners)/i,
    /multiple\s+(printers|companies|manufacturers|customers|suppliers|partners)/i,
    /local\s+printers\s+and\s+multinational/i,
  ];

  const badLabels = [
    /corporate vision/i,
    /vision statement/i,
    /mission statement/i,
    /company values/i,
    /core values/i,
    /our philosophy/i,
    /company motto/i,
    /slogan/i,
    /tagline/i,
    /years of experience/i,
    /awards/i,
    /achievements/i,
    /recognitions/i,
    /quality standards/i,
    /quality assurance/i,
    /quality control/i,
    /quality focus/i,
    /innovation focus/i,
    /r&d focus/i,
    /research focus/i,
    /customer service/i,
    /service excellence/i,
    /technical support/i,
    /customer satisfaction/i,
    /commitment/i,
    /dedication/i,
  ];

  return keyMetrics.filter((metric) => {
    if (!metric || !metric.value) return false;
    const value = String(metric.value).trim();
    const label = String(metric.label || '').trim();
    if (!value) return false;

    for (const pattern of badLabels) {
      if (pattern.test(label)) {
        return false;
      }
    }

    for (const pattern of emptyValuePatterns) {
      if (pattern.test(value)) {
        return false;
      }
    }

    return true;
  });
}

function detectShortforms(companyData) {
  const textParts = [
    companyData.company_name,
    companyData.location,
    companyData.business,
    companyData.metrics,
    companyData.footnote,
  ];

  if (companyData.key_metrics && Array.isArray(companyData.key_metrics)) {
    companyData.key_metrics.forEach((metric) => {
      if (metric?.label) textParts.push(ensureString(metric.label));
      if (metric?.value) textParts.push(ensureString(metric.value));
    });
  }

  if (companyData.breakdown_items && Array.isArray(companyData.breakdown_items)) {
    companyData.breakdown_items.forEach((item) => {
      if (item?.label) textParts.push(ensureString(item.label));
      if (item?.value) textParts.push(ensureString(item.value));
    });
  }

  const allText = textParts.filter(Boolean).join(' ');
  const foundShortforms = [];

  for (const [shortform, definition] of Object.entries(SHORTFORM_DEFINITIONS)) {
    if (COMMON_SHORTFORMS.includes(shortform)) continue;
    const regex = new RegExp(`\\b${shortform}\\b`, 'i');
    if (regex.test(allText)) {
      foundShortforms.push(`${shortform} (${definition})`);
    }
  }

  if (foundShortforms.length > 0) {
    return 'Note: ' + foundShortforms.join(', ');
  }
  return null;
}

function validateAndFixHQFormat(location, websiteUrl) {
  if (!location || typeof location !== 'string') return location;

  let loc = location.trim();
  loc = loc.replace(/^-?\s*HQ:\s*/i, '').trim();

  const parts = loc
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p);
  const lastPart = parts[parts.length - 1]?.toLowerCase() || '';

  const isSingapore = lastPart === 'singapore' || loc.toLowerCase() === 'singapore';

  if (isSingapore) {
    if (parts.length === 1 || loc.toLowerCase() === 'singapore') {
      const domain =
        websiteUrl
          ?.replace(/^https?:\/\//, '')
          .replace(/^www\./, '')
          .split('/')[0] || '';

      const areaHints = {
        jurong: 'Jurong',
        tuas: 'Tuas',
        woodlands: 'Woodlands',
        ubi: 'Ubi',
        changi: 'Changi',
        bedok: 'Bedok',
        tampines: 'Tampines',
        'ang mo kio': 'Ang Mo Kio',
        amk: 'Ang Mo Kio',
        'paya lebar': 'Paya Lebar',
        kallang: 'Kallang',
        geylang: 'Geylang',
      };

      let area = null;
      for (const [hint, areaName] of Object.entries(areaHints)) {
        if (domain.toLowerCase().includes(hint)) {
          area = areaName;
          break;
        }
      }

      if (!area) {
        return 'Singapore';
      }

      return `${area}, Singapore`;
    }
    if (parts.length > 2) {
      return `${parts[0]}, Singapore`;
    }
    return loc;
  } else {
    if (parts.length > 3) {
      return parts.slice(-3).join(', ');
    }
    return loc;
  }
}

// ============ TESTS ============

describe('extractCompanyNameFromUrl', () => {
  test('extracts domain and converts to title case', () => {
    expect(extractCompanyNameFromUrl('https://www.example.com')).toBe('Example');
    expect(extractCompanyNameFromUrl('https://acme-corp.com')).toBe('Acme Corp');
    expect(extractCompanyNameFromUrl('https://my_company.net')).toBe('My Company');
  });

  test('handles various TLDs', () => {
    expect(extractCompanyNameFromUrl('https://company.co.id')).toBe('Company');
    expect(extractCompanyNameFromUrl('https://business.com.my')).toBe('Business');
    expect(extractCompanyNameFromUrl('https://test.io')).toBe('Test');
  });

  test('handles invalid URLs gracefully', () => {
    expect(extractCompanyNameFromUrl('not-a-url')).toBe('not-a-url');
    expect(extractCompanyNameFromUrl('')).toBe('');
  });

  test('removes www prefix', () => {
    expect(extractCompanyNameFromUrl('https://www.mycompany.com')).toBe('Mycompany');
  });
});

describe('detectMeetingDomain', () => {
  test('detects financial domain', () => {
    expect(detectMeetingDomain('We discussed the EBITDA and valuation')).toBe('financial');
    expect(detectMeetingDomain('The M&A deal includes revenue of $10M')).toBe('financial');
    expect(detectMeetingDomain('Cash flow analysis for the merger')).toBe('financial');
  });

  test('detects legal domain', () => {
    expect(detectMeetingDomain('The contract has a liability clause')).toBe('legal');
    expect(detectMeetingDomain('NDA was signed with the attorney')).toBe('legal');
  });

  test('detects medical domain', () => {
    expect(detectMeetingDomain('The clinical trial showed good efficacy')).toBe('medical');
    expect(detectMeetingDomain('FDA approval for the pharmaceutical drug')).toBe('medical');
  });

  test('detects technical domain', () => {
    expect(detectMeetingDomain('The API infrastructure uses cloud deployment')).toBe('technical');
    expect(detectMeetingDomain('Database architecture for the software')).toBe('technical');
  });

  test('detects HR domain', () => {
    expect(detectMeetingDomain('Employee compensation and benefits')).toBe('hr');
    expect(detectMeetingDomain('Hiring new talent for recruitment')).toBe('hr');
  });

  test('defaults to general for non-matching text', () => {
    expect(detectMeetingDomain('General business discussion')).toBe('general');
    expect(detectMeetingDomain('Meeting about project timeline')).toBe('general');
  });
});

describe('getDomainInstructions', () => {
  test('returns correct instructions for each domain', () => {
    expect(getDomainInstructions('financial')).toContain('financial/investment due diligence');
    expect(getDomainInstructions('legal')).toContain('legal due diligence');
    expect(getDomainInstructions('medical')).toContain('medical/pharmaceutical');
    expect(getDomainInstructions('technical')).toContain('technical due diligence');
    expect(getDomainInstructions('hr')).toContain('HR/talent');
  });

  test('returns general instructions for unknown domain', () => {
    expect(getDomainInstructions('unknown')).toContain('business due diligence');
    expect(getDomainInstructions('general')).toContain('business due diligence');
  });
});

describe('normalizeCompanyName', () => {
  test('removes common legal suffixes', () => {
    expect(normalizeCompanyName('ABC Company Sdn Bhd')).toBe('abc company');
    expect(normalizeCompanyName('XYZ Pte Ltd')).toBe('xyz');
    expect(normalizeCompanyName('Test Inc.')).toBe('test');
    expect(normalizeCompanyName('Business Corp.')).toBe('business');
  });

  test('removes PT/CV prefixes', () => {
    expect(normalizeCompanyName('PT Acme Indonesia')).toBe('acme indonesia');
    // Note: 'company' is also removed as a suffix
    expect(normalizeCompanyName('CV Test Company')).toBe('test');
  });

  test('removes special characters and normalizes spaces', () => {
    expect(normalizeCompanyName('ABC-Company  Ltd.')).toBe('abccompany');
    expect(normalizeCompanyName('Test (Malaysia)')).toBe('test');
  });

  test('handles empty/null input', () => {
    expect(normalizeCompanyName('')).toBe('');
    expect(normalizeCompanyName(null)).toBe('');
    expect(normalizeCompanyName(undefined)).toBe('');
  });

  test('removes parenthetical content', () => {
    // Parentheses are removed as special chars, but content remains
    expect(normalizeCompanyName('ABC (Thailand) Ltd')).toBe('abc thailand');
  });
});

describe('normalizeWebsite', () => {
  test('removes protocol and www', () => {
    expect(normalizeWebsite('https://www.example.com')).toBe('example.com');
    expect(normalizeWebsite('http://example.com')).toBe('example.com');
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
  });

  test('removes file extensions', () => {
    // Extension removed but path remains
    expect(normalizeWebsite('https://example.com/index.html')).toBe('example.com/index');
    expect(normalizeWebsite('https://example.com/page.php')).toBe('example.com/page');
  });

  test('handles empty input', () => {
    expect(normalizeWebsite('')).toBe('');
    expect(normalizeWebsite(null)).toBe('');
  });

  test('preserves significant paths', () => {
    expect(normalizeWebsite('https://example.com/special-page')).toBe('example.com/special-page');
  });
});

describe('extractDomainRoot', () => {
  test('extracts domain without path', () => {
    expect(extractDomainRoot('https://example.com/path/to/page')).toBe('example.com');
    expect(extractDomainRoot('https://www.test.com/home')).toBe('test.com');
  });

  test('handles URLs without path', () => {
    expect(extractDomainRoot('https://example.com')).toBe('example.com');
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
  });

  test('removes duplicate domains', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com/home', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://example.com/about', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicate company names', () => {
    const companies = [
      { company_name: 'ABC Ltd', website: 'https://abc1.com', hq: 'City, Country' },
      { company_name: 'ABC Limited', website: 'https://abc2.com', hq: 'City, Country' },
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
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('keeps unique companies', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://abc.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://xyz.com', hq: 'City, Country' },
      { company_name: 'DEF', website: 'https://def.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(3);
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
  });

  test('accepts valid company URLs', () => {
    expect(isSpamOrDirectoryURL('https://mycompany.com')).toBe(false);
    expect(isSpamOrDirectoryURL('https://business.co.id')).toBe(false);
  });

  test('returns true for null/empty URLs', () => {
    expect(isSpamOrDirectoryURL(null)).toBe(true);
    expect(isSpamOrDirectoryURL('')).toBe(true);
  });
});

describe('preFilterCompanies', () => {
  test('filters out spam URLs', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://facebook.com/abc' },
      { company_name: 'XYZ', website: 'https://mycompany.com' },
    ];
    const result = preFilterCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('XYZ');
  });

  test('filters out companies without websites', () => {
    const companies = [
      { company_name: 'ABC', website: null },
      { company_name: 'XYZ', website: 'https://mycompany.com' },
    ];
    const result = preFilterCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('XYZ');
  });

  test('filters out null companies', () => {
    const companies = [null, { company_name: 'XYZ', website: 'https://mycompany.com' }, undefined];
    const result = preFilterCompanies(companies);
    expect(result).toHaveLength(1);
  });
});

describe('buildOutputFormat', () => {
  test('returns consistent format string', () => {
    const format = buildOutputFormat();
    expect(format).toContain('company_name');
    expect(format).toContain('website');
    expect(format).toContain('hq');
    expect(format).toContain('City, Country');
  });
});

describe('buildExclusionRules', () => {
  test('builds rules for large company exclusion', () => {
    const rules = buildExclusionRules('large companies', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('global presence');
    expect(rules).toContain('NYSE');
  });

  test('builds rules for listed company exclusion', () => {
    const rules = buildExclusionRules('listed companies', 'ink');
    expect(rules).toContain('LISTED COMPANY DETECTION');
    expect(rules).toContain('publicly traded');
  });

  test('builds rules for distributor exclusion', () => {
    const rules = buildExclusionRules('distributors', 'ink');
    expect(rules).toContain('DISTRIBUTOR DETECTION');
    expect(rules).toContain('distributes/resells');
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
});

describe('getCountryCode', () => {
  test('extracts country code from simple location', () => {
    expect(getCountryCode('Jakarta, Indonesia')).toBe('ID');
    expect(getCountryCode('Bangkok, Thailand')).toBe('TH');
    expect(getCountryCode('Kuala Lumpur, Malaysia')).toBe('MY');
    expect(getCountryCode('Singapore')).toBe('SG');
  });

  test('extracts country code from HQ format', () => {
    expect(getCountryCode('HQ: Jakarta, Indonesia')).toBe('ID');
    expect(getCountryCode('HQ: Manila, Philippines')).toBe('PH');
  });

  test('handles multi-level locations', () => {
    expect(getCountryCode('District, City, Indonesia')).toBe('ID');
    expect(getCountryCode('Area, State, Thailand')).toBe('TH');
  });

  test('returns null for unknown countries', () => {
    expect(getCountryCode('Unknown City, Unknown Country')).toBe(null);
  });

  test('returns null for empty input', () => {
    expect(getCountryCode(null)).toBe(null);
    expect(getCountryCode('')).toBe(null);
  });

  test('handles case insensitivity', () => {
    expect(getCountryCode('JAKARTA, INDONESIA')).toBe('ID');
    expect(getCountryCode('singapore')).toBe('SG');
  });
});

describe('filterEmptyMetrics', () => {
  test('removes metrics with empty values', () => {
    const metrics = [
      { label: 'Revenue', value: 'Not specified' },
      { label: 'Employees', value: '500' },
      { label: 'Market', value: 'N/A' },
    ];
    const result = filterEmptyMetrics(metrics);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Employees');
  });

  test('removes metrics with placeholder values', () => {
    const metrics = [
      { label: 'Clients', value: 'Client 1, Client 2, Client 3' },
      { label: 'Revenue', value: '$10M' },
      { label: 'Customers', value: 'Customer A, Customer B' },
    ];
    const result = filterEmptyMetrics(metrics);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Revenue');
  });

  test('removes metrics with bad labels', () => {
    const metrics = [
      { label: 'Mission Statement', value: 'We strive for excellence' },
      { label: 'Revenue', value: '$10M' },
      { label: 'Company Values', value: 'Integrity, Quality' },
    ];
    const result = filterEmptyMetrics(metrics);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Revenue');
  });

  test('keeps valid metrics', () => {
    const metrics = [
      { label: 'Revenue', value: '$10M' },
      { label: 'Employees', value: '500' },
      { label: 'Factory Size', value: '50,000 sqm' },
    ];
    const result = filterEmptyMetrics(metrics);
    expect(result).toHaveLength(3);
  });

  test('handles empty/null input', () => {
    expect(filterEmptyMetrics(null)).toEqual([]);
    expect(filterEmptyMetrics(undefined)).toEqual([]);
    expect(filterEmptyMetrics([])).toEqual([]);
  });

  test('filters out generic descriptions', () => {
    const metrics = [
      { label: 'Quality', value: 'Various printers and companies' },
      { label: 'Capacity', value: '1000 units/day' },
    ];
    const result = filterEmptyMetrics(metrics);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Capacity');
  });
});

describe('detectShortforms', () => {
  test('detects uncommon shortforms', () => {
    const data = {
      company_name: 'ABC Company',
      business: 'We provide OEM services in SEA region',
      key_metrics: [{ label: 'SKU Count', value: '500' }],
    };
    const result = detectShortforms(data);
    expect(result).toContain('OEM');
    expect(result).toContain('SEA');
    expect(result).toContain('SKU');
  });

  test('ignores common shortforms', () => {
    const data = {
      company_name: 'ABC Ltd',
      business: 'B2B solutions',
      key_metrics: [{ label: 'Revenue', value: '10M USD' }],
    };
    const result = detectShortforms(data);
    expect(result).toBe(null); // B2B, M, USD are common
  });

  test('returns null when no shortforms found', () => {
    const data = {
      company_name: 'ABC Company',
      business: 'Manufacturing and distribution',
    };
    const result = detectShortforms(data);
    expect(result).toBe(null);
  });

  test('handles empty data', () => {
    const data = {};
    const result = detectShortforms(data);
    expect(result).toBe(null);
  });

  test('checks breakdown_items', () => {
    const data = {
      company_name: 'ABC',
      breakdown_items: [{ label: 'OEM Products', value: '40%' }],
    };
    const result = detectShortforms(data);
    expect(result).toContain('OEM');
  });
});

describe('validateAndFixHQFormat', () => {
  test('fixes Singapore location with only country', () => {
    const result = validateAndFixHQFormat('Singapore', 'https://jurong-company.com.sg');
    expect(result).toBe('Jurong, Singapore');
  });

  test('keeps valid Singapore location', () => {
    const result = validateAndFixHQFormat('Jurong, Singapore', 'https://example.com');
    expect(result).toBe('Jurong, Singapore');
  });

  test('fixes Singapore location with too many levels', () => {
    const result = validateAndFixHQFormat('District, Area, City, Singapore', 'https://example.com');
    expect(result).toBe('District, Singapore');
  });

  test('returns Singapore when no area can be determined', () => {
    const result = validateAndFixHQFormat('Singapore', 'https://example.com');
    expect(result).toBe('Singapore');
  });

  test('fixes non-Singapore location with too many levels', () => {
    const result = validateAndFixHQFormat('A, B, C, D, Thailand', 'https://example.com');
    expect(result).toBe('C, D, Thailand');
  });

  test('keeps valid non-Singapore location', () => {
    const result = validateAndFixHQFormat('Bangkok, Thailand', 'https://example.com');
    expect(result).toBe('Bangkok, Thailand');
  });

  test('removes HQ prefix', () => {
    const result = validateAndFixHQFormat('HQ: Jakarta, Indonesia', 'https://example.com');
    expect(result).toBe('Jakarta, Indonesia');
  });

  test('handles null/empty input', () => {
    expect(validateAndFixHQFormat(null, 'https://example.com')).toBe(null);
    expect(validateAndFixHQFormat('', 'https://example.com')).toBe('');
  });

  test('detects area from URL for Singapore', () => {
    expect(validateAndFixHQFormat('Singapore', 'https://tuas-company.com')).toBe('Tuas, Singapore');
    expect(validateAndFixHQFormat('Singapore', 'https://woodlands-business.sg')).toBe(
      'Woodlands, Singapore'
    );
  });
});
