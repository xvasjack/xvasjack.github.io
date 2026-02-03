/**
 * Unit tests for transcription service
 * Tests pure/testable functions: audio processing, data transformation, validation, and utility functions
 */

// ============ PURE FUNCTIONS (copied from server.js) ============

function ensureString(value, defaultValue = '') {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return defaultValue;
  // Handle arrays - join with comma
  if (Array.isArray(value)) return value.map((v) => ensureString(v)).join(', ');
  // Handle objects - try to extract meaningful string
  if (typeof value === 'object') {
    // Common patterns from AI responses
    if (value.city && value.country) return `${value.city}, ${value.country}`;
    if (value.text) return ensureString(value.text);
    if (value.value) return ensureString(value.value);
    if (value.name) return ensureString(value.name);
    // Fallback: stringify
    try {
      return JSON.stringify(value);
    } catch {
      return defaultValue;
    }
  }
  // Convert other types to string
  return String(value);
}

function pcmToWav(pcmBuffer, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
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
  wavBuffer.writeUInt32LE(16, 16); // fmt chunk size
  wavBuffer.writeUInt16LE(1, 20); // audio format (1 = PCM)
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

// ============ TESTS ============

describe('ensureString', () => {
  test('returns string as-is', () => {
    expect(ensureString('hello')).toBe('hello');
    expect(ensureString('test 123')).toBe('test 123');
  });

  test('returns default for null/undefined', () => {
    expect(ensureString(null)).toBe('');
    expect(ensureString(undefined)).toBe('');
    expect(ensureString(null, 'default')).toBe('default');
    expect(ensureString(undefined, 'default')).toBe('default');
  });

  test('joins arrays with commas', () => {
    expect(ensureString(['a', 'b', 'c'])).toBe('a, b, c');
    expect(ensureString([1, 2, 3])).toBe('1, 2, 3');
    expect(ensureString(['single'])).toBe('single');
    expect(ensureString([])).toBe('');
  });

  test('extracts city and country from object', () => {
    expect(ensureString({ city: 'Bangkok', country: 'Thailand' })).toBe('Bangkok, Thailand');
    expect(ensureString({ city: 'Singapore', country: 'Singapore' })).toBe('Singapore, Singapore');
  });

  test('extracts text property from object', () => {
    expect(ensureString({ text: 'hello' })).toBe('hello');
    expect(ensureString({ text: { text: 'nested' } })).toBe('nested');
  });

  test('extracts value property from object', () => {
    expect(ensureString({ value: 'test' })).toBe('test');
  });

  test('extracts name property from object', () => {
    expect(ensureString({ name: 'John' })).toBe('John');
  });

  test('stringifies complex objects', () => {
    const result = ensureString({ a: 1, b: 2 });
    expect(result).toBe('{"a":1,"b":2}');
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

  test('handles nested arrays in objects', () => {
    expect(ensureString({ value: ['a', 'b'] })).toBe('a, b');
  });
});

describe('pcmToWav', () => {
  test('creates valid WAV header with default parameters', () => {
    const pcmData = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const wavBuffer = pcmToWav(pcmData);

    // Check RIFF header
    expect(wavBuffer.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wavBuffer.toString('ascii', 8, 12)).toBe('WAVE');

    // Check fmt chunk
    expect(wavBuffer.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wavBuffer.readUInt32LE(16)).toBe(16); // fmt chunk size
    expect(wavBuffer.readUInt16LE(20)).toBe(1); // PCM format

    // Check data chunk
    expect(wavBuffer.toString('ascii', 36, 40)).toBe('data');
  });

  test('calculates correct file size', () => {
    const pcmData = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const wavBuffer = pcmToWav(pcmData);
    const expectedSize = 44 + pcmData.length;

    expect(wavBuffer.length).toBe(expectedSize);
    expect(wavBuffer.readUInt32LE(4)).toBe(expectedSize - 8); // RIFF chunk size
  });

  test('uses correct sample rate', () => {
    const pcmData = Buffer.from([0, 1, 2, 3]);
    const sampleRate = 48000;
    const wavBuffer = pcmToWav(pcmData, sampleRate);

    expect(wavBuffer.readUInt32LE(24)).toBe(sampleRate);
  });

  test('uses correct number of channels', () => {
    const pcmData = Buffer.from([0, 1, 2, 3]);
    const numChannels = 2;
    const wavBuffer = pcmToWav(pcmData, 16000, numChannels);

    expect(wavBuffer.readUInt16LE(22)).toBe(numChannels);
  });

  test('uses correct bits per sample', () => {
    const pcmData = Buffer.from([0, 1, 2, 3]);
    const bitsPerSample = 24;
    const wavBuffer = pcmToWav(pcmData, 16000, 1, bitsPerSample);

    expect(wavBuffer.readUInt16LE(34)).toBe(bitsPerSample);
  });

  test('calculates correct byte rate', () => {
    const pcmData = Buffer.from([0, 1, 2, 3]);
    const sampleRate = 16000;
    const numChannels = 2;
    const bitsPerSample = 16;
    const wavBuffer = pcmToWav(pcmData, sampleRate, numChannels, bitsPerSample);

    const expectedByteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    expect(wavBuffer.readUInt32LE(28)).toBe(expectedByteRate);
  });

  test('calculates correct block align', () => {
    const pcmData = Buffer.from([0, 1, 2, 3]);
    const numChannels = 2;
    const bitsPerSample = 16;
    const wavBuffer = pcmToWav(pcmData, 16000, numChannels, bitsPerSample);

    const expectedBlockAlign = (numChannels * bitsPerSample) / 8;
    expect(wavBuffer.readUInt16LE(32)).toBe(expectedBlockAlign);
  });

  test('copies PCM data to correct position', () => {
    const pcmData = Buffer.from([10, 20, 30, 40]);
    const wavBuffer = pcmToWav(pcmData);

    const copiedData = wavBuffer.slice(44, 44 + pcmData.length);
    expect(copiedData).toEqual(pcmData);
  });

  test('sets correct data chunk size', () => {
    const pcmData = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const wavBuffer = pcmToWav(pcmData);

    expect(wavBuffer.readUInt32LE(40)).toBe(pcmData.length);
  });

  test('handles empty PCM buffer', () => {
    const pcmData = Buffer.from([]);
    const wavBuffer = pcmToWav(pcmData);

    expect(wavBuffer.length).toBe(44); // Just header
    expect(wavBuffer.readUInt32LE(40)).toBe(0); // No data
  });

  test('handles large PCM buffer', () => {
    const largeBuffer = Buffer.alloc(10000);
    const wavBuffer = pcmToWav(largeBuffer);

    expect(wavBuffer.length).toBe(44 + 10000);
    expect(wavBuffer.readUInt32LE(40)).toBe(10000);
  });
});

describe('detectMeetingDomain', () => {
  test('detects financial domain', () => {
    expect(detectMeetingDomain('We discussed the EBITDA and valuation')).toBe('financial');
    expect(detectMeetingDomain('The M&A deal includes revenue of $10M')).toBe('financial');
    expect(detectMeetingDomain('Cash flow analysis for the merger')).toBe('financial');
    expect(detectMeetingDomain('IPO and equity discussion')).toBe('financial');
    expect(detectMeetingDomain('P&L and balance sheet review')).toBe('financial');
    expect(detectMeetingDomain('ROI analysis and debt structuring')).toBe('financial');
  });

  test('detects legal domain', () => {
    expect(detectMeetingDomain('The contract has a liability clause')).toBe('legal');
    expect(detectMeetingDomain('NDA was signed with the attorney')).toBe('legal');
    expect(detectMeetingDomain('Agreement on compliance and litigation')).toBe('legal');
    expect(detectMeetingDomain('Intellectual property and IP rights')).toBe('legal');
    expect(detectMeetingDomain('Legal terms discussion with lawyer')).toBe('legal');
  });

  test('detects medical domain', () => {
    expect(detectMeetingDomain('The clinical trial showed good efficacy')).toBe('medical');
    expect(detectMeetingDomain('FDA approval for the pharmaceutical drug')).toBe('medical');
    expect(detectMeetingDomain('Patient therapeutic outcomes and dosage')).toBe('medical');
    expect(detectMeetingDomain('Biotech development discussion')).toBe('medical');
  });

  test('detects technical domain', () => {
    expect(detectMeetingDomain('The API infrastructure uses cloud deployment')).toBe('technical');
    expect(detectMeetingDomain('Database architecture for the software')).toBe('technical');
    expect(detectMeetingDomain('Server configuration and engineering')).toBe('technical');
    expect(detectMeetingDomain('Code review and infrastructure setup')).toBe('technical');
  });

  test('detects HR domain', () => {
    expect(detectMeetingDomain('Employee compensation and benefits')).toBe('hr');
    expect(detectMeetingDomain('Hiring new talent for recruitment')).toBe('hr');
    expect(detectMeetingDomain('Performance review and HR policies')).toBe('hr');
  });

  test('defaults to general for non-matching text', () => {
    expect(detectMeetingDomain('General business discussion')).toBe('general');
    expect(detectMeetingDomain('Meeting about project timeline')).toBe('general');
    expect(detectMeetingDomain('Random conversation')).toBe('general');
    expect(detectMeetingDomain('')).toBe('general');
  });

  test('is case insensitive', () => {
    expect(detectMeetingDomain('EBITDA and VALUATION')).toBe('financial');
    expect(detectMeetingDomain('contract and agreement')).toBe('legal');
    expect(detectMeetingDomain('api and database')).toBe('technical');
  });

  test('detects first matching domain', () => {
    // Should return the first match found
    const text = 'We discussed revenue (financial) and contract (legal)';
    const result = detectMeetingDomain(text);
    expect(['financial', 'legal']).toContain(result);
  });
});

describe('getDomainInstructions', () => {
  test('returns correct instructions for financial domain', () => {
    const instructions = getDomainInstructions('financial');
    expect(instructions).toContain('financial/investment due diligence');
    expect(instructions).toContain('M&A');
    expect(instructions).toContain('EBITDA');
  });

  test('returns correct instructions for legal domain', () => {
    const instructions = getDomainInstructions('legal');
    expect(instructions).toContain('legal due diligence');
    expect(instructions).toContain('legal terms');
    expect(instructions).toContain('formal legal register');
  });

  test('returns correct instructions for medical domain', () => {
    const instructions = getDomainInstructions('medical');
    expect(instructions).toContain('medical/pharmaceutical');
    expect(instructions).toContain('medical terminology');
  });

  test('returns correct instructions for technical domain', () => {
    const instructions = getDomainInstructions('technical');
    expect(instructions).toContain('technical due diligence');
    expect(instructions).toContain('technical terms');
  });

  test('returns correct instructions for HR domain', () => {
    const instructions = getDomainInstructions('hr');
    expect(instructions).toContain('HR/talent');
    expect(instructions).toContain('HR terminology');
  });

  test('returns correct instructions for general domain', () => {
    const instructions = getDomainInstructions('general');
    expect(instructions).toContain('business due diligence');
    expect(instructions).toContain('business terminology');
  });

  test('returns general instructions for unknown domain', () => {
    const instructions = getDomainInstructions('unknown');
    expect(instructions).toContain('business due diligence');
  });

  test('returns general instructions for empty string', () => {
    const instructions = getDomainInstructions('');
    expect(instructions).toContain('business due diligence');
  });
});

describe('normalizeCompanyName', () => {
  test('removes Sdn Bhd suffix', () => {
    expect(normalizeCompanyName('ABC Sdn Bhd')).toBe('abc');
    expect(normalizeCompanyName('Test Sdn. Bhd.')).toBe('test');
    expect(normalizeCompanyName('XYZ Bhd')).toBe('xyz');
  });

  test('removes Pte Ltd suffix', () => {
    expect(normalizeCompanyName('ABC Pte Ltd')).toBe('abc');
    expect(normalizeCompanyName('Test Pte. Ltd.')).toBe('test');
  });

  test('removes common English legal suffixes', () => {
    expect(normalizeCompanyName('Test Inc.')).toBe('test');
    expect(normalizeCompanyName('Business Corp.')).toBe('business');
    expect(normalizeCompanyName('ABC Limited')).toBe('abc');
    expect(normalizeCompanyName('XYZ LLC')).toBe('xyz');
    expect(normalizeCompanyName('Acme LLP')).toBe('acme');
  });

  test('removes PT/CV prefixes', () => {
    expect(normalizeCompanyName('PT Acme Indonesia')).toBe('acme indonesia');
    expect(normalizeCompanyName('CV Test Company')).toBe('test');
    expect(normalizeCompanyName('PT. Business')).toBe('business');
  });

  test('removes Indonesian suffixes', () => {
    expect(normalizeCompanyName('ABC Tbk')).toBe('abc');
    expect(normalizeCompanyName('Test Tbk.')).toBe('test');
  });

  test('removes international suffixes', () => {
    expect(normalizeCompanyName('ABC GmbH')).toBe('abc');
    expect(normalizeCompanyName('Test S.A.')).toBe('test');
    expect(normalizeCompanyName('Acme JSC')).toBe('acme');
    expect(normalizeCompanyName('Business PLC')).toBe('business');
  });

  test('removes parenthetical content', () => {
    expect(normalizeCompanyName('ABC (Thailand) Ltd')).toBe('abc thailand');
    expect(normalizeCompanyName('Test (Asia) Company')).toBe('test asia');
  });

  test('removes special characters', () => {
    expect(normalizeCompanyName('ABC-Company Ltd.')).toBe('abccompany');
    expect(normalizeCompanyName('Test & Co.')).toBe('test co'); // Spaces normalized
  });

  test('normalizes multiple spaces', () => {
    expect(normalizeCompanyName('ABC   Trading  Ltd')).toBe('abc trading');
  });

  test('converts to lowercase', () => {
    expect(normalizeCompanyName('ABC TRADING LTD')).toBe('abc trading');
    expect(normalizeCompanyName('Test Business Inc')).toBe('test business');
  });

  test('handles empty/null input', () => {
    expect(normalizeCompanyName('')).toBe('');
    expect(normalizeCompanyName(null)).toBe('');
    expect(normalizeCompanyName(undefined)).toBe('');
  });

  test('handles complex real-world examples', () => {
    expect(normalizeCompanyName('PT. Indofood Sukses Makmur Tbk.')).toBe('indofood sukses makmur');
    expect(normalizeCompanyName('Thai Union Group PLC')).toBe('thai union group');
    expect(normalizeCompanyName('Singapore Airlines Ltd.')).toBe('singapore airlines');
  });
});

describe('normalizeWebsite', () => {
  test('removes https protocol', () => {
    expect(normalizeWebsite('https://example.com')).toBe('example.com');
  });

  test('removes http protocol', () => {
    expect(normalizeWebsite('http://example.com')).toBe('example.com');
  });

  test('removes www prefix', () => {
    expect(normalizeWebsite('https://www.example.com')).toBe('example.com');
    expect(normalizeWebsite('http://www.test.com')).toBe('test.com');
  });

  test('removes trailing slashes', () => {
    expect(normalizeWebsite('https://example.com/')).toBe('example.com');
    expect(normalizeWebsite('https://example.com///')).toBe('example.com');
  });

  test('removes common path suffixes', () => {
    expect(normalizeWebsite('https://example.com/home')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/index')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/about-us')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/contact')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/products')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/services')).toBe('example.com');
  });

  test('removes language codes', () => {
    expect(normalizeWebsite('https://example.com/en')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/th')).toBe('example.com');
    expect(normalizeWebsite('https://example.com/id')).toBe('example.com');
  });

  test('removes file extensions', () => {
    expect(normalizeWebsite('https://example.com/index.html')).toBe('example.com/index');
    expect(normalizeWebsite('https://example.com/page.php')).toBe('example.com/page');
    expect(normalizeWebsite('https://example.com/test.aspx')).toBe('example.com/test');
    expect(normalizeWebsite('https://example.com/page.jsp')).toBe('example.com/page');
  });

  test('converts to lowercase', () => {
    expect(normalizeWebsite('HTTPS://EXAMPLE.COM')).toBe('example.com');
    expect(normalizeWebsite('HTTP://Test.COM/HOME')).toBe('test.com');
  });

  test('preserves significant paths', () => {
    expect(normalizeWebsite('https://example.com/special-page')).toBe('example.com/special-page');
    expect(normalizeWebsite('https://example.com/solutions/enterprise')).toBe(
      'example.com/solutions/enterprise'
    );
  });

  test('handles empty/null input', () => {
    expect(normalizeWebsite('')).toBe('');
    expect(normalizeWebsite(null)).toBe('');
  });

  test('handles complex real-world URLs', () => {
    expect(normalizeWebsite('https://www.company.co.th/en/about-us')).toBe('company.co.th');
    expect(normalizeWebsite('http://business.com.my/solutions')).toBe('business.com.my/solutions');
  });
});

describe('extractDomainRoot', () => {
  test('extracts domain without path', () => {
    expect(extractDomainRoot('https://example.com/path/to/page')).toBe('example.com');
    expect(extractDomainRoot('https://www.test.com/home')).toBe('test.com');
  });

  test('handles URLs without path', () => {
    expect(extractDomainRoot('https://example.com')).toBe('example.com');
    expect(extractDomainRoot('http://test.com')).toBe('test.com');
  });

  test('handles complex paths', () => {
    expect(extractDomainRoot('https://example.com/a/b/c/d')).toBe('example.com');
  });

  test('handles subdomains', () => {
    expect(extractDomainRoot('https://subdomain.example.com/path')).toBe('subdomain.example.com');
  });

  test('handles URLs with query parameters', () => {
    expect(extractDomainRoot('https://example.com/page?id=123')).toBe('example.com');
  });
});

describe('dedupeCompanies', () => {
  test('removes duplicate websites (exact match)', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://example.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('removes duplicate websites (with different paths)', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com/home', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://example.com/about', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicate domains', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com/path1', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'https://example.com/path2', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('removes duplicate company names (normalized)', () => {
    const companies = [
      { company_name: 'ABC Ltd', website: 'https://abc1.com', hq: 'City, Country' },
      { company_name: 'ABC Limited', website: 'https://abc2.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
  });

  test('filters out companies without website', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: null, hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('filters out companies without company_name', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com', hq: 'City, Country' },
      { company_name: null, website: 'https://test.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('filters out companies with non-http URLs', () => {
    const companies = [
      { company_name: 'ABC', website: 'https://example.com', hq: 'City, Country' },
      { company_name: 'XYZ', website: 'ftp://test.com', hq: 'City, Country' },
      { company_name: 'DEF', website: 'example.com', hq: 'City, Country' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('ABC');
  });

  test('filters out null companies', () => {
    const companies = [
      null,
      { company_name: 'ABC', website: 'https://example.com', hq: 'City, Country' },
      undefined,
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
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

  test('handles empty array', () => {
    const result = dedupeCompanies([]);
    expect(result).toEqual([]);
  });

  test('preserves first occurrence', () => {
    const companies = [
      { company_name: 'First', website: 'https://example.com', hq: 'City1, Country1' },
      { company_name: 'Second', website: 'https://example.com', hq: 'City2, Country2' },
    ];
    const result = dedupeCompanies(companies);
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe('First');
    expect(result[0].hq).toBe('City1, Country1');
  });
});

describe('isSpamOrDirectoryURL', () => {
  test('detects Wikipedia URLs', () => {
    expect(isSpamOrDirectoryURL('https://en.wikipedia.org/wiki/Company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://wikipedia.org/page')).toBe(true);
  });

  test('detects Facebook URLs', () => {
    expect(isSpamOrDirectoryURL('https://facebook.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://www.facebook.com/page')).toBe(true);
  });

  test('detects Twitter URLs', () => {
    expect(isSpamOrDirectoryURL('https://twitter.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://www.twitter.com/handle')).toBe(true);
  });

  test('detects Instagram URLs', () => {
    expect(isSpamOrDirectoryURL('https://instagram.com/company')).toBe(true);
    expect(isSpamOrDirectoryURL('https://www.instagram.com/profile')).toBe(true);
  });

  test('detects YouTube URLs', () => {
    expect(isSpamOrDirectoryURL('https://youtube.com/channel/123')).toBe(true);
    expect(isSpamOrDirectoryURL('https://www.youtube.com/watch?v=abc')).toBe(true);
  });

  test('accepts valid company URLs', () => {
    expect(isSpamOrDirectoryURL('https://mycompany.com')).toBe(false);
    expect(isSpamOrDirectoryURL('https://business.co.id')).toBe(false);
    expect(isSpamOrDirectoryURL('https://test.com.my')).toBe(false);
  });

  test('returns true for null URL', () => {
    expect(isSpamOrDirectoryURL(null)).toBe(true);
  });

  test('returns true for empty URL', () => {
    expect(isSpamOrDirectoryURL('')).toBe(true);
    expect(isSpamOrDirectoryURL('   ')).toBe(false); // Empty after trim, but has spaces
  });

  test('is case insensitive', () => {
    expect(isSpamOrDirectoryURL('HTTPS://FACEBOOK.COM/page')).toBe(true);
    expect(isSpamOrDirectoryURL('https://WIKIPEDIA.ORG/page')).toBe(true);
  });

  test('detects spam patterns anywhere in URL', () => {
    expect(isSpamOrDirectoryURL('https://subdomain.facebook.com/page')).toBe(true);
    expect(isSpamOrDirectoryURL('https://facebook.com.fake.com')).toBe(true);
  });
});

describe('buildOutputFormat', () => {
  test('returns consistent format string', () => {
    const format = buildOutputFormat();
    expect(format).toContain('company_name');
    expect(format).toContain('website');
    expect(format).toContain('hq');
  });

  test('specifies URL format', () => {
    const format = buildOutputFormat();
    expect(format).toContain('URL starting with http');
  });

  test('specifies HQ format', () => {
    const format = buildOutputFormat();
    expect(format).toContain('City, Country');
  });

  test('returns same format on multiple calls', () => {
    const format1 = buildOutputFormat();
    const format2 = buildOutputFormat();
    expect(format1).toBe(format2);
  });
});

describe('buildExclusionRules', () => {
  test('builds rules for "large" exclusion', () => {
    const rules = buildExclusionRules('large companies', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('global presence');
    expect(rules).toContain('NYSE');
    expect(rules).toContain('Fortune 500');
  });

  test('builds rules for "big" exclusion', () => {
    const rules = buildExclusionRules('big corporations', 'manufacturing');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('builds rules for "mnc" exclusion', () => {
    const rules = buildExclusionRules('mnc companies', 'trading');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('multinational');
  });

  test('builds rules for "multinational" exclusion', () => {
    const rules = buildExclusionRules('multinational corporations', 'retail');
    expect(rules).toContain('LARGE COMPANY DETECTION');
  });

  test('builds rules for "listed" exclusion', () => {
    const rules = buildExclusionRules('listed companies', 'ink');
    expect(rules).toContain('LISTED COMPANY DETECTION');
    expect(rules).toContain('publicly traded');
    expect(rules).toContain('stock exchange');
  });

  test('builds rules for "public" exclusion', () => {
    const rules = buildExclusionRules('public companies', 'manufacturing');
    expect(rules).toContain('LISTED COMPANY DETECTION');
  });

  test('builds rules for "distributor" exclusion', () => {
    const rules = buildExclusionRules('distributors', 'ink');
    expect(rules).toContain('DISTRIBUTOR DETECTION');
    expect(rules).toContain('distributes/resells');
    expect(rules).toContain('ACCEPT if they manufacture');
  });

  test('combines multiple exclusion types', () => {
    const rules = buildExclusionRules(
      'large multinational listed companies and distributors',
      'ink'
    );
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('LISTED COMPANY DETECTION');
    expect(rules).toContain('DISTRIBUTOR DETECTION');
  });

  test('returns empty string for no exclusions', () => {
    const rules = buildExclusionRules('', 'ink');
    expect(rules).toBe('');
  });

  test('returns empty string for unrelated exclusion text', () => {
    const rules = buildExclusionRules('some random text', 'ink');
    expect(rules).toBe('');
  });

  test('is case insensitive', () => {
    const rules1 = buildExclusionRules('LARGE COMPANIES', 'ink');
    const rules2 = buildExclusionRules('Large Companies', 'ink');
    expect(rules1).toContain('LARGE COMPANY DETECTION');
    expect(rules2).toContain('LARGE COMPANY DETECTION');
  });

  test('handles partial word matches', () => {
    const rules = buildExclusionRules('excluding large and listed', 'ink');
    expect(rules).toContain('LARGE COMPANY DETECTION');
    expect(rules).toContain('LISTED COMPANY DETECTION');
  });
});
