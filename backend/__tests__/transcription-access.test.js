/**
 * Access checks for the transcription service.
 * - Routes that return transcripts or recordings must not be open to anyone with the URL.
 * - Session IDs must not be guessable (no timestamps).
 */
const fs = require('fs');
const path = require('path');

const TRANSCRIPTION_DIR = path.join(__dirname, '..', 'transcription');

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

describe('requireAccessToken', () => {
  const ORIGINAL = process.env.TRANSCRIPTION_ACCESS_TOKEN;
  let requireAccessToken;

  beforeAll(() => {
    ({ requireAccessToken } = require('../transcription/access-guard'));
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TRANSCRIPTION_ACCESS_TOKEN;
    else process.env.TRANSCRIPTION_ACCESS_TOKEN = ORIGINAL;
  });

  test('blocks every request when no token is configured', () => {
    delete process.env.TRANSCRIPTION_ACCESS_TOKEN;
    for (const headers of [{}, { 'x-access-token': 'anything' }, { 'x-access-token': '' }]) {
      const next = jest.fn();
      const res = mockRes();
      requireAccessToken(mockReq(headers), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(404);
    }
  });

  test('blocks a request with a missing or wrong token', () => {
    process.env.TRANSCRIPTION_ACCESS_TOKEN = 'correct-token-123';
    for (const headers of [
      {},
      { 'x-access-token': 'wrong-token-1234' },
      { 'x-access-token': 'correct-token-12' },
      { 'x-access-token': '' },
    ]) {
      const next = jest.fn();
      const res = mockRes();
      requireAccessToken(mockReq(headers), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(404);
    }
  });

  test('allows a request with the right token', () => {
    process.env.TRANSCRIPTION_ACCESS_TOKEN = 'correct-token-123';
    const next = jest.fn();
    const res = mockRes();
    requireAccessToken(mockReq({ 'X-Access-Token': 'correct-token-123' }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('transcription data routes', () => {
  const serverSrc = fs.readFileSync(path.join(TRANSCRIPTION_DIR, 'server.js'), 'utf8');

  test('every route that returns transcripts or recordings is guarded', () => {
    const routes =
      serverSrc.match(
        /app\.get\(\s*'\/api\/(transcription-session|recording|recording-status)\/[^']*'[^\n]*/g
      ) || [];
    expect(routes.length).toBeGreaterThanOrEqual(4);
    for (const line of routes) {
      expect(line).toContain('requireAccessToken');
    }
  });

  test('session IDs are random, not timestamps', () => {
    expect(serverSrc).not.toMatch(/sessionId\s*=\s*Date\.now\(\)/);
    expect(serverSrc).toMatch(/sessionId\s*=\s*crypto\.randomUUID\(\)/);
  });
});
