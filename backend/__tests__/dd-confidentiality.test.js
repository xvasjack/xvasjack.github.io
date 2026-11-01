/**
 * Confidentiality checks for the due-diligence service.
 * - Report fetch endpoints must not be open to anyone with the URL.
 * - No real client or target names may be hard-coded in prompts or defaults.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DD_DIR = path.join(__dirname, '..', 'due-diligence');

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function mockReq(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()] };
}

describe('requireReportToken', () => {
  const ORIGINAL = process.env.DD_REPORTS_TOKEN;
  let requireReportToken;

  beforeAll(() => {
    ({ requireReportToken } = require('../due-diligence/report-access'));
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DD_REPORTS_TOKEN;
    else process.env.DD_REPORTS_TOKEN = ORIGINAL;
  });

  test('blocks every request when no token is configured', () => {
    delete process.env.DD_REPORTS_TOKEN;
    const next = jest.fn();
    const res = mockRes();
    requireReportToken(mockReq({ 'x-report-token': 'anything' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });

  test('blocks a request with a missing or wrong token', () => {
    process.env.DD_REPORTS_TOKEN = 'correct-token-123';
    for (const headers of [
      {},
      { 'x-report-token': 'wrong-token-1234' },
      { 'x-report-token': '' },
    ]) {
      const next = jest.fn();
      const res = mockRes();
      requireReportToken(mockReq(headers), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(404);
    }
  });

  test('allows a request with the right token', () => {
    process.env.DD_REPORTS_TOKEN = 'correct-token-123';
    const next = jest.fn();
    const res = mockRes();
    requireReportToken(mockReq({ 'X-Report-Token': 'correct-token-123' }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('due-diligence report routes', () => {
  const serverSrc = fs.readFileSync(path.join(DD_DIR, 'server.js'), 'utf8');

  test('every /api/reports route is guarded by requireReportToken', () => {
    const routes = serverSrc.match(/app\.get\(\s*'\/api\/reports[^']*'[^\n]*/g) || [];
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const line of routes) {
      expect(line).toContain('requireReportToken');
    }
  });
});

describe('no client or target names in DD source', () => {
  // SHA-256 of lowercase names that must never appear, so this test does not
  // itself publish them. Checks single words and two-word phrases.
  const BANNED_HASHES = new Set([
    '3ec829928b33bb01978dbbe4c2598378242e309edd3b1304924f6e4a53afebac',
    '5b3cccf643b91a1684f7c6120e573dcfad3a44f0191ff6b84464ce906693cdb0',
    '5f67d85e58bd667facec9a9fba0ef69ade3b0db4ca3aef0adbdcc3b0fac1f8a3',
  ]);
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

  function bannedPhrases(src) {
    const words = src.toLowerCase().match(/[a-z]+/g) || [];
    const hits = [];
    for (let i = 0; i < words.length; i++) {
      if (BANNED_HASHES.has(sha(words[i]))) hits.push(words[i]);
      if (i + 1 < words.length) {
        const pair = `${words[i]} ${words[i + 1]}`;
        if (BANNED_HASHES.has(sha(pair))) hits.push(pair);
      }
    }
    return hits;
  }

  for (const file of ['server.js', 'docx-generator.js']) {
    test(`${file} has no client or target names`, () => {
      const src = fs.readFileSync(path.join(DD_DIR, file), 'utf8');
      expect(bannedPhrases(src)).toEqual([]);
    });
  }
});
