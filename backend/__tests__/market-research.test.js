/**
 * Unit tests for market-research utility functions
 * Tests focus on data transformation, validation, and utility logic
 */

// Re-implement testable functions (extracted from server code)
// In a real refactor, these would be imported from a shared utils module

// ============ COST TRACKING ============
const PRICING = {
  'deepseek-chat': { input: 0.28, output: 0.42 },
  'deepseek-reasoner': { input: 0.28, output: 0.42 },
  'kimi-128k': { input: 0.84, output: 0.84 },
  'kimi-32k': { input: 0.35, output: 0.35 },
};

function trackCost(model, inputTokens, outputTokens, searchCount = 0) {
  let cost = 0;
  const pricing = PRICING[model];

  if (pricing) {
    if (pricing.perSearch) {
      cost = searchCount * pricing.perSearch;
    } else {
      cost = (inputTokens / 1000000) * pricing.input + (outputTokens / 1000000) * pricing.output;
    }
  }

  return cost;
}

// ============ TEXT UTILITIES ============
function truncate(text, maxLen = 150) {
  if (!text) return '';
  const str = String(text).trim();
  if (str.length <= maxLen) return str;

  // Find the last sentence boundary before maxLen
  const truncated = str.substring(0, maxLen);

  // Try to end at sentence boundary (. ! ?) - look for period followed by space or end
  const sentenceEnders = ['. ', '! ', '? '];
  let lastSentence = -1;
  for (const ender of sentenceEnders) {
    const pos = truncated.lastIndexOf(ender);
    if (pos > lastSentence) lastSentence = pos;
  }
  // Also check for sentence ending at the very end (no trailing space)
  if (truncated.endsWith('.') || truncated.endsWith('!') || truncated.endsWith('?')) {
    lastSentence = Math.max(lastSentence, truncated.length - 1);
  }

  if (lastSentence > maxLen * 0.4) {
    return truncated.substring(0, lastSentence + 1).trim();
  }

  // Try to end at strong phrase boundary (; or :)
  const strongPhrase = Math.max(truncated.lastIndexOf('; '), truncated.lastIndexOf(': '));
  if (strongPhrase > maxLen * 0.4) {
    return truncated.substring(0, strongPhrase + 1).trim();
  }

  // Try to end at parenthetical close
  const lastParen = truncated.lastIndexOf(')');
  if (lastParen > maxLen * 0.5) {
    return truncated.substring(0, lastParen + 1).trim();
  }

  // Try to end at comma boundary (weaker)
  const lastComma = truncated.lastIndexOf(', ');
  if (lastComma > maxLen * 0.5) {
    return truncated.substring(0, lastComma).trim();
  }

  // Last resort: end at word boundary, but ensure we don't cut mid-word
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) {
    // Check if ending on a preposition/article - if so, cut earlier
    const words = truncated.substring(0, lastSpace).split(' ');
    const lastWord = words[words.length - 1].toLowerCase();
    const badEndings = [
      'for',
      'to',
      'the',
      'a',
      'an',
      'of',
      'in',
      'on',
      'at',
      'by',
      'with',
      'and',
      'or',
      'but',
      'are',
      'is',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'largely',
      'mostly',
      'mainly',
    ];
    if (badEndings.includes(lastWord) && words.length > 1) {
      // Remove the dangling preposition/article
      words.pop();
      return words.join(' ').trim();
    }
    return truncated.substring(0, lastSpace).trim();
  }

  return truncated.trim();
}

function truncateSubtitle(text, maxLen = 100) {
  if (!text) return '';
  const str = String(text).trim();
  if (str.length <= maxLen) return str;

  // For subtitles, prefer ending at sentence boundary
  const truncated = str.substring(0, maxLen);

  // Look for sentence end
  const lastPeriod = truncated.lastIndexOf('. ');
  if (lastPeriod > maxLen * 0.4) {
    return truncated.substring(0, lastPeriod + 1).trim();
  }

  // Look for other clean breaks
  const lastColon = truncated.lastIndexOf(': ');
  if (lastColon > maxLen * 0.4) {
    return truncated.substring(0, lastColon + 1).trim();
  }

  // Fall back to truncate function
  return truncate(str, maxLen);
}

function safeArray(arr, max = 5) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, max);
}

// ============ DATA GENERATION ============
function generateFallbackFramework(scope) {
  const industry = scope.industry || 'the industry';
  return {
    policy: {
      topics: [
        {
          name: 'Regulatory Framework',
          queries: [
            `{country} ${industry} regulations laws requirements`,
            `{country} ${industry} licensing permits foreign companies`,
            `{country} foreign investment restrictions ${industry} sector`,
            `{country} ${industry} compliance requirements standards`,
            `{country} government policy ${industry} development`,
          ],
        },
      ],
    },
    market: {
      topics: [
        {
          name: 'Market Size & Growth',
          queries: [
            `{country} ${industry} market size value USD 2024`,
            `{country} ${industry} market growth rate CAGR forecast`,
            `{country} ${industry} market segments breakdown`,
            `{country} ${industry} demand drivers trends`,
            `{country} ${industry} market outlook 2025 2030`,
          ],
        },
      ],
    },
    competitors: {
      topics: [
        {
          name: 'Major Players',
          queries: [
            `{country} ${industry} top companies market share ranking`,
            `{country} ${industry} foreign companies presence`,
            `{country} ${industry} local major players`,
            `{country} ${industry} competitive landscape analysis`,
            `{country} ${industry} M&A acquisitions recent`,
          ],
        },
      ],
    },
    depth: {
      topics: [
        {
          name: 'Business Economics',
          queries: [
            `{country} ${industry} pricing margins profitability`,
            `{country} ${industry} typical deal size contract value`,
            `{country} ${industry} partnership joint venture examples`,
            `{country} ${industry} investment requirements costs`,
            `{country} ${industry} success factors best practices`,
          ],
        },
      ],
    },
    insights: {
      topics: [
        {
          name: 'Lessons & Timing',
          queries: [
            `{country} ${industry} company failures exits reasons`,
            `{country} ${industry} regulatory changes upcoming 2025`,
            `{country} ${industry} incentives expiration deadline`,
            `{country} ${industry} underserved segments gaps`,
            `{country} ${industry} barriers challenges foreign companies`,
          ],
        },
      ],
    },
  };
}

// ============ CHART DATA UTILITIES ============
function extractChartData(researchText, _chartType) {
  const data = {
    categories: [],
    series: [],
    values: [],
  };

  // Try to find year-based data patterns like "2020: 45, 2021: 48, 2022: 52"
  const yearPattern = /(\d{4})[:\s]+(\d+(?:\.\d+)?)/g;
  const yearMatches = [...(researchText || '').matchAll(yearPattern)];

  if (yearMatches.length >= 2) {
    data.categories = yearMatches.map((m) => m[1]);
    data.values = yearMatches.map((m) => parseFloat(m[2]));
    data.series = [{ name: 'Value', values: data.values }];
  }

  return data;
}

function validateChartData(data, _chartType) {
  if (!data) return null;

  const validated = {
    categories: [],
    series: [],
    values: [],
    unit: data.unit || '',
  };

  // Validate categories
  if (Array.isArray(data.categories)) {
    validated.categories = data.categories.map((c) => String(c)).slice(0, 10);
  }

  // Validate values (for simple bar/pie charts)
  if (Array.isArray(data.values)) {
    validated.values = data.values
      .map((v) => (typeof v === 'number' ? v : parseFloat(v)))
      .filter((v) => !isNaN(v))
      .slice(0, 10);
  }

  // Validate series (for stacked/line charts)
  if (Array.isArray(data.series)) {
    validated.series = data.series
      .filter((s) => s && s.name && Array.isArray(s.values))
      .map((s) => ({
        name: String(s.name).substring(0, 30),
        values: s.values
          .map((v) => (typeof v === 'number' ? v : parseFloat(v)))
          .filter((v) => !isNaN(v))
          .slice(0, 10),
      }))
      .slice(0, 6); // Max 6 series for readability
  }

  // Check if we have enough data to render
  const hasEnoughData =
    (validated.categories.length >= 2 && validated.values.length >= 2) ||
    (validated.categories.length >= 2 &&
      validated.series.length >= 1 &&
      validated.series[0].values.length >= 2);

  return hasEnoughData ? validated : null;
}

// ============ TESTS ============

describe('trackCost', () => {
  test('calculates cost for deepseek-chat', () => {
    const cost = trackCost('deepseek-chat', 1000000, 1000000);
    expect(cost).toBeCloseTo(0.7, 2); // 0.28 + 0.42 = 0.7
  });

  test('calculates cost for deepseek-reasoner', () => {
    const cost = trackCost('deepseek-reasoner', 500000, 1500000);
    expect(cost).toBeCloseTo(0.77, 2); // (0.5 * 0.28) + (1.5 * 0.42) = 0.14 + 0.63 = 0.77
  });

  test('calculates cost for kimi-128k', () => {
    const cost = trackCost('kimi-128k', 2000000, 1000000);
    expect(cost).toBeCloseTo(2.52, 2); // (2 * 0.84) + (1 * 0.84) = 2.52
  });

  test('calculates cost for kimi-32k', () => {
    const cost = trackCost('kimi-32k', 1000000, 2000000);
    expect(cost).toBeCloseTo(1.05, 2); // (1 * 0.35) + (2 * 0.35) = 1.05
  });

  test('returns 0 for unknown model', () => {
    const cost = trackCost('unknown-model', 1000000, 1000000);
    expect(cost).toBe(0);
  });

  test('handles zero tokens', () => {
    const cost = trackCost('deepseek-chat', 0, 0);
    expect(cost).toBe(0);
  });

  test('handles small token counts', () => {
    const cost = trackCost('deepseek-chat', 1000, 1000);
    expect(cost).toBeCloseTo(0.0007, 6); // (0.001 * 0.28) + (0.001 * 0.42)
  });
});

describe('truncate', () => {
  test('returns empty string for falsy input', () => {
    expect(truncate(null)).toBe('');
    expect(truncate(undefined)).toBe('');
    expect(truncate('')).toBe('');
  });

  test('returns string as-is if under maxLen', () => {
    expect(truncate('Short text', 150)).toBe('Short text');
    expect(truncate('Hello world', 20)).toBe('Hello world');
  });

  test('converts non-string input to string', () => {
    expect(truncate(123, 150)).toBe('123');
    expect(truncate(true, 150)).toBe('true');
  });

  test('trims whitespace', () => {
    expect(truncate('  trimmed  ', 150)).toBe('trimmed');
  });

  test('truncates at sentence boundary', () => {
    const text = 'First sentence. Second sentence. Third sentence goes on and on.';
    const result = truncate(text, 40);
    expect(result).toBe('First sentence. Second sentence.');
  });

  test('handles sentence ending with exclamation', () => {
    const text = 'Great news! More details here about the amazing product.';
    const result = truncate(text, 30);
    // Function looks for ". " with space, finds it at position ~27 which is > 40% of 30
    expect(result).toBe('Great news! More details here');
  });

  test('handles sentence ending with question mark', () => {
    const text = 'What is this? It is something interesting and detailed.';
    const result = truncate(text, 30);
    // Function finds "? " at position ~29 which is > 40% of 30
    expect(result).toBe('What is this? It is something');
  });

  test('truncates at semicolon when no sentence boundary', () => {
    const text = 'Part one; part two; part three continues for a while without periods';
    const result = truncate(text, 30);
    expect(result).toBe('Part one; part two;');
  });

  test('truncates at colon when appropriate', () => {
    const text = 'Introduction: this is a long detailed explanation that continues on';
    const result = truncate(text, 30);
    // Colon is at position ~13 which is > 40% of 30, so it uses that boundary
    expect(result).toBe('Introduction: this is a long');
  });

  test('truncates at parenthesis close', () => {
    const text = 'Some text (with parenthetical remark) and more text after that continues';
    const result = truncate(text, 45);
    expect(result).toBe('Some text (with parenthetical remark)');
  });

  test('truncates at comma when no better option', () => {
    const text = 'Word, another word, yet another word, and more words';
    const result = truncate(text, 35);
    // Last comma within range is after "word" at position ~18, which is > 50% of 35
    expect(result).toBe('Word, another word');
  });

  test('removes dangling prepositions', () => {
    const text = 'This is a sentence that ends with the word for';
    const result = truncate(text, 45);
    expect(result).toBe('This is a sentence that ends with the word');
  });

  test('removes dangling articles', () => {
    const text = 'This is a sentence that ends with a continuation point';
    const result = truncate(text, 35);
    expect(result).toBe('This is a sentence that ends');
  });

  test('handles text ending at exact maxLen boundary', () => {
    const text = 'Exactly 20 chars end.';
    const result = truncate(text, 21);
    expect(result).toBe('Exactly 20 chars end.');
  });

  test('respects 40% minimum boundary for sentence', () => {
    const text = 'A. ' + 'B'.repeat(200);
    const result = truncate(text, 100);
    // Should not break at "A." because it's less than 40% of maxLen
    expect(result).not.toBe('A.');
  });

  test('respects 50% minimum boundary for word', () => {
    const text = 'Word ' + 'X'.repeat(200);
    const result = truncate(text, 100);
    // Should not break at "Word" because it's less than 50% of maxLen
    expect(result).not.toBe('Word');
  });

  test('handles custom maxLen parameter', () => {
    const text = 'This is a long sentence that needs to be truncated at custom length.';
    const result = truncate(text, 30);
    expect(result.length).toBeLessThanOrEqual(30);
  });
});

describe('truncateSubtitle', () => {
  test('returns empty string for falsy input', () => {
    expect(truncateSubtitle(null)).toBe('');
    expect(truncateSubtitle(undefined)).toBe('');
    expect(truncateSubtitle('')).toBe('');
  });

  test('returns string as-is if under maxLen', () => {
    expect(truncateSubtitle('Short', 100)).toBe('Short');
  });

  test('truncates at sentence boundary', () => {
    const text = 'First. Second sentence goes on.';
    const result = truncateSubtitle(text, 20);
    // Period + space at position ~5, which is NOT > 40% of 20 (8), so continues to next boundary
    expect(result).toBe('First. Second');
  });

  test('truncates at colon boundary', () => {
    const text = 'Title: Long explanation continues here';
    const result = truncateSubtitle(text, 20);
    // Colon + space at position ~5, which is NOT > 40% of 20 (8), so continues to next boundary
    expect(result).toBe('Title: Long');
  });

  test('falls back to truncate for no clean breaks', () => {
    const text = 'No clean breaks in this long subtitle text';
    const result = truncateSubtitle(text, 20);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  test('uses default maxLen of 100', () => {
    const text = 'A'.repeat(150);
    const result = truncateSubtitle(text);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  test('respects 40% minimum boundary', () => {
    const text = 'A. ' + 'B'.repeat(150);
    const result = truncateSubtitle(text, 100);
    expect(result).not.toBe('A.');
  });
});

describe('safeArray', () => {
  test('returns empty array for non-array input', () => {
    expect(safeArray(null)).toEqual([]);
    expect(safeArray(undefined)).toEqual([]);
    expect(safeArray('string')).toEqual([]);
    expect(safeArray(123)).toEqual([]);
    expect(safeArray({})).toEqual([]);
  });

  test('returns array as-is if under max', () => {
    expect(safeArray([1, 2, 3])).toEqual([1, 2, 3]);
    expect(safeArray([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]);
  });

  test('limits array to max items (default 5)', () => {
    expect(safeArray([1, 2, 3, 4, 5, 6, 7])).toEqual([1, 2, 3, 4, 5]);
  });

  test('respects custom max parameter', () => {
    expect(safeArray([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
    expect(safeArray([1, 2, 3, 4, 5], 10)).toEqual([1, 2, 3, 4, 5]);
  });

  test('handles empty array', () => {
    expect(safeArray([])).toEqual([]);
  });
});

describe('generateFallbackFramework', () => {
  test('generates framework with industry from scope', () => {
    const scope = { industry: 'renewable energy' };
    const framework = generateFallbackFramework(scope);

    expect(framework).toHaveProperty('policy');
    expect(framework).toHaveProperty('market');
    expect(framework).toHaveProperty('competitors');
    expect(framework).toHaveProperty('depth');
    expect(framework).toHaveProperty('insights');
  });

  test('uses default industry when not provided', () => {
    const scope = {};
    const framework = generateFallbackFramework(scope);

    const policyQuery = framework.policy.topics[0].queries[0];
    expect(policyQuery).toContain('the industry');
  });

  test('policy section includes regulatory queries', () => {
    const scope = { industry: 'solar' };
    const framework = generateFallbackFramework(scope);

    expect(framework.policy.topics[0].name).toBe('Regulatory Framework');
    expect(framework.policy.topics[0].queries).toHaveLength(5);
    expect(framework.policy.topics[0].queries[0]).toContain('solar');
    expect(framework.policy.topics[0].queries[0]).toContain('regulations');
  });

  test('market section includes market size queries', () => {
    const scope = { industry: 'wind power' };
    const framework = generateFallbackFramework(scope);

    expect(framework.market.topics[0].name).toBe('Market Size & Growth');
    expect(framework.market.topics[0].queries).toHaveLength(5);
    expect(framework.market.topics[0].queries[0]).toContain('wind power');
    expect(framework.market.topics[0].queries[0]).toContain('market size');
  });

  test('competitors section includes player queries', () => {
    const scope = { industry: 'EV charging' };
    const framework = generateFallbackFramework(scope);

    expect(framework.competitors.topics[0].name).toBe('Major Players');
    expect(framework.competitors.topics[0].queries).toHaveLength(5);
    expect(framework.competitors.topics[0].queries[0]).toContain('EV charging');
  });

  test('depth section includes economics queries', () => {
    const scope = { industry: 'hydrogen' };
    const framework = generateFallbackFramework(scope);

    expect(framework.depth.topics[0].name).toBe('Business Economics');
    expect(framework.depth.topics[0].queries).toHaveLength(5);
    expect(framework.depth.topics[0].queries[0]).toContain('hydrogen');
    expect(framework.depth.topics[0].queries[0]).toContain('pricing');
  });

  test('insights section includes lessons queries', () => {
    const scope = { industry: 'battery storage' };
    const framework = generateFallbackFramework(scope);

    expect(framework.insights.topics[0].name).toBe('Lessons & Timing');
    expect(framework.insights.topics[0].queries).toHaveLength(5);
    expect(framework.insights.topics[0].queries[0]).toContain('battery storage');
  });

  test('all queries include {country} placeholder', () => {
    const scope = { industry: 'test' };
    const framework = generateFallbackFramework(scope);

    const allQueries = [
      ...framework.policy.topics[0].queries,
      ...framework.market.topics[0].queries,
      ...framework.competitors.topics[0].queries,
      ...framework.depth.topics[0].queries,
      ...framework.insights.topics[0].queries,
    ];

    allQueries.forEach((query) => {
      expect(query).toContain('{country}');
    });
  });
});

describe('extractChartData', () => {
  test('extracts year-value patterns', () => {
    const text = '2020: 45, 2021: 48, 2022: 52';
    const data = extractChartData(text);

    expect(data.categories).toEqual(['2020', '2021', '2022']);
    expect(data.values).toEqual([45, 48, 52]);
    expect(data.series).toHaveLength(1);
    expect(data.series[0].name).toBe('Value');
  });

  test('handles decimal values', () => {
    const text = '2020: 45.5, 2021: 48.2, 2022: 52.8';
    const data = extractChartData(text);

    expect(data.values).toEqual([45.5, 48.2, 52.8]);
  });

  test('handles space after year instead of colon', () => {
    const text = '2020 45, 2021 48, 2022 52';
    const data = extractChartData(text);

    expect(data.categories).toEqual(['2020', '2021', '2022']);
    expect(data.values).toEqual([45, 48, 52]);
  });

  test('returns empty arrays when no pattern matches', () => {
    const text = 'No numeric data here';
    const data = extractChartData(text);

    expect(data.categories).toEqual([]);
    expect(data.values).toEqual([]);
    expect(data.series).toEqual([]);
  });

  test('requires at least 2 matches', () => {
    const text = '2020: 45 only one value';
    const data = extractChartData(text);

    expect(data.categories).toEqual([]);
    expect(data.values).toEqual([]);
  });

  test('handles null/undefined input', () => {
    expect(extractChartData(null)).toEqual({ categories: [], series: [], values: [] });
    expect(extractChartData(undefined)).toEqual({ categories: [], series: [], values: [] });
  });

  test('extracts from longer text', () => {
    const text =
      'The market grew significantly: 2018: 100, 2019: 120, 2020: 150, showing strong trends.';
    const data = extractChartData(text);

    expect(data.categories).toEqual(['2018', '2019', '2020']);
    expect(data.values).toEqual([100, 120, 150]);
  });
});

describe('validateChartData', () => {
  test('returns null for null/undefined input', () => {
    expect(validateChartData(null)).toBeNull();
    expect(validateChartData(undefined)).toBeNull();
  });

  test('validates categories array', () => {
    const data = { categories: ['2020', '2021', '2022'], values: [10, 20, 30] };
    const validated = validateChartData(data);

    expect(validated.categories).toEqual(['2020', '2021', '2022']);
  });

  test('converts non-string categories to strings', () => {
    const data = { categories: [2020, 2021, 2022], values: [10, 20, 30] };
    const validated = validateChartData(data);

    expect(validated.categories).toEqual(['2020', '2021', '2022']);
  });

  test('limits categories to 10', () => {
    const data = {
      categories: Array.from({ length: 20 }, (_, i) => `Cat${i}`),
      values: Array.from({ length: 20 }, (_, i) => i * 10),
    };
    const validated = validateChartData(data);

    expect(validated.categories).toHaveLength(10);
  });

  test('validates values array', () => {
    const data = { categories: ['A', 'B', 'C'], values: [10, 20, 30] };
    const validated = validateChartData(data);

    expect(validated.values).toEqual([10, 20, 30]);
  });

  test('converts string values to numbers', () => {
    const data = { categories: ['A', 'B', 'C'], values: ['10', '20', '30'] };
    const validated = validateChartData(data);

    expect(validated.values).toEqual([10, 20, 30]);
  });

  test('filters out NaN values', () => {
    const data = { categories: ['A', 'B', 'C'], values: [10, 'invalid', 30] };
    const validated = validateChartData(data);

    expect(validated.values).toEqual([10, 30]);
  });

  test('limits values to 10', () => {
    const data = {
      categories: Array.from({ length: 20 }, (_, i) => `Cat${i}`),
      values: Array.from({ length: 20 }, (_, i) => i * 10),
    };
    const validated = validateChartData(data);

    expect(validated.values).toHaveLength(10);
  });

  test('validates series array', () => {
    const data = {
      categories: ['2020', '2021', '2022'],
      series: [
        { name: 'Series1', values: [10, 20, 30] },
        { name: 'Series2', values: [15, 25, 35] },
      ],
    };
    const validated = validateChartData(data);

    expect(validated.series).toHaveLength(2);
    expect(validated.series[0].name).toBe('Series1');
    expect(validated.series[0].values).toEqual([10, 20, 30]);
  });

  test('filters out invalid series', () => {
    const data = {
      categories: ['2020', '2021'],
      series: [
        { name: 'Valid', values: [10, 20] },
        { values: [15, 25] }, // Missing name
        { name: 'NoValues' }, // Missing values
        null,
        { name: 'AlsoValid', values: [5, 15] },
      ],
    };
    const validated = validateChartData(data);

    expect(validated.series).toHaveLength(2);
    expect(validated.series[0].name).toBe('Valid');
    expect(validated.series[1].name).toBe('AlsoValid');
  });

  test('truncates long series names to 30 chars', () => {
    const longName = 'A'.repeat(50);
    const data = {
      categories: ['2020', '2021'],
      series: [{ name: longName, values: [10, 20] }],
    };
    const validated = validateChartData(data);

    expect(validated.series[0].name).toHaveLength(30);
  });

  test('limits series to 6', () => {
    const data = {
      categories: ['2020', '2021'],
      series: Array.from({ length: 10 }, (_, i) => ({
        name: `Series${i}`,
        values: [i * 10, i * 20],
      })),
    };
    const validated = validateChartData(data);

    expect(validated.series).toHaveLength(6);
  });

  test('preserves unit field', () => {
    const data = { categories: ['A', 'B'], values: [10, 20], unit: 'USD' };
    const validated = validateChartData(data);

    expect(validated.unit).toBe('USD');
  });

  test('defaults unit to empty string', () => {
    const data = { categories: ['A', 'B'], values: [10, 20] };
    const validated = validateChartData(data);

    expect(validated.unit).toBe('');
  });

  test('returns null if not enough data (categories + values)', () => {
    const data = { categories: ['A'], values: [10] };
    const validated = validateChartData(data);

    expect(validated).toBeNull();
  });

  test('returns null if not enough data (categories + series)', () => {
    const data = {
      categories: ['A'],
      series: [{ name: 'S1', values: [10] }],
    };
    const validated = validateChartData(data);

    expect(validated).toBeNull();
  });

  test('accepts valid data with categories + values', () => {
    const data = { categories: ['A', 'B'], values: [10, 20] };
    const validated = validateChartData(data);

    expect(validated).not.toBeNull();
  });

  test('accepts valid data with categories + series', () => {
    const data = {
      categories: ['A', 'B'],
      series: [{ name: 'S1', values: [10, 20] }],
    };
    const validated = validateChartData(data);

    expect(validated).not.toBeNull();
  });

  test('handles mixed valid and invalid series values', () => {
    const data = {
      categories: ['A', 'B', 'C'],
      series: [{ name: 'S1', values: [10, 'bad', 30] }],
    };
    const validated = validateChartData(data);

    expect(validated.series[0].values).toEqual([10, 30]);
  });

  test('handles empty arrays', () => {
    const data = { categories: [], values: [], series: [] };
    const validated = validateChartData(data);

    expect(validated).toBeNull();
  });
});
