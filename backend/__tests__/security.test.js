/**
 * Tests for shared security utilities
 */

const {
  escapeHtml,
  sanitizePath,
  isValidEmail,
  corsOptions,
} = require('../shared/security');

describe('escapeHtml', () => {
  test('escapes ampersand', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  test('escapes less than', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  test('escapes greater than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  test('escapes double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  test('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe("it&#039;s");
  });

  test('handles multiple special chars', () => {
    expect(escapeHtml('<a href="test">link</a>')).toBe(
      '&lt;a href=&quot;test&quot;&gt;link&lt;/a&gt;'
    );
  });

  test('returns empty string for non-string input', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(123)).toBe('');
    expect(escapeHtml({})).toBe('');
  });

  test('preserves safe text', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });
});

describe('sanitizePath', () => {
  test('removes path traversal sequences', () => {
    expect(sanitizePath('../../../etc/passwd')).toBe('etc/passwd');
    expect(sanitizePath('foo/../bar')).toBe('foo/bar');
  });

  test('removes double slashes', () => {
    expect(sanitizePath('foo//bar//baz')).toBe('foo/bar/baz');
  });

  test('removes leading slash', () => {
    expect(sanitizePath('/etc/passwd')).toBe('etc/passwd');
  });

  test('handles combined attacks', () => {
    expect(sanitizePath('/..//..//foo/../bar')).toBe('foo/bar');
  });

  test('returns empty string for non-string input', () => {
    expect(sanitizePath(null)).toBe('');
    expect(sanitizePath(undefined)).toBe('');
    expect(sanitizePath(123)).toBe('');
  });

  test('preserves safe paths', () => {
    expect(sanitizePath('uploads/file.txt')).toBe('uploads/file.txt');
  });
});

describe('isValidEmail', () => {
  test('accepts valid emails', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('user.name@example.co.uk')).toBe(true);
    expect(isValidEmail('user+tag@example.com')).toBe(true);
  });

  test('rejects invalid emails', () => {
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('missing@domain')).toBe(false);
    expect(isValidEmail('@nodomain.com')).toBe(false);
    expect(isValidEmail('spaces in@email.com')).toBe(false);
  });

  test('returns false for non-string input', () => {
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(123)).toBe(false);
    expect(isValidEmail({})).toBe(false);
  });
});

describe('corsOptions', () => {
  test('has required properties', () => {
    expect(corsOptions).toHaveProperty('origin');
    expect(corsOptions).toHaveProperty('methods');
    expect(corsOptions).toHaveProperty('allowedHeaders');
  });

  test('allows expected methods', () => {
    expect(corsOptions.methods).toContain('GET');
    expect(corsOptions.methods).toContain('POST');
    expect(corsOptions.methods).toContain('OPTIONS');
  });

  test('has maxAge set', () => {
    expect(corsOptions.maxAge).toBeGreaterThan(0);
  });
});
