const { extractJsonFromContent } = require('../market-research/research-agents');

describe('extractJsonFromContent', () => {
  test('strategy 1: ```json block', () => {
    const r = extractJsonFromContent('text\n```json\n{"key":"val"}\n```\nmore');
    expect(r.status).toBe('success');
    expect(r.data).toEqual({ key: 'val' });
  });

  test('strategy 2: ``` block without json label', () => {
    const r = extractJsonFromContent('```\n{"key":"val"}\n```');
    expect(r.status).toBe('success');
    expect(r.data).toEqual({ key: 'val' });
  });

  test('strategy 2.5: array JSON', () => {
    const r = extractJsonFromContent('[{"a":1},{"a":2}]');
    expect(r.status).toBe('success');
    expect(r.data).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test('strategy 3: raw JSON object', () => {
    const r = extractJsonFromContent('{"key":"val"}');
    expect(r.status).toBe('success');
  });

  test('strategy 4: JSON embedded in prose', () => {
    const r = extractJsonFromContent('Here is data: {"key":"val"} end');
    expect(r.status).toBe('success');
  });

  test('no JSON', () => {
    const r = extractJsonFromContent('just text');
    expect(r.status).toBe('no_json_found');
    expect(r.data).toBeNull();
  });

  test('empty content', () => {
    const r = extractJsonFromContent('');
    expect(r.status).toBe('no_content');
  });

  test('null content', () => {
    const r = extractJsonFromContent(null);
    expect(r.status).toBe('no_content');
  });

  test('malformed JSON in fenced block', () => {
    const r = extractJsonFromContent('```json\n{not valid json}\n```');
    expect(r.data).toBeNull();
  });

  test('nested JSON with markdown', () => {
    const content =
      'Analysis:\n\n```json\n{"policy":{"acts":[{"name":"Act 1","year":2020}]}}\n```\n\nEnd.';
    const r = extractJsonFromContent(content);
    expect(r.status).toBe('success');
    expect(r.data.policy.acts[0].name).toBe('Act 1');
  });
});
