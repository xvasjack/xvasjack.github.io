const crypto = require('crypto');

/**
 * Guard for the report fetch endpoints.
 * Reports can hold confidential deal content, so these routes stay closed
 * unless DD_REPORTS_TOKEN is set and the caller sends it in X-Report-Token.
 * A closed route answers 404 so it does not reveal that it exists.
 */
function requireReportToken(req, res, next) {
  const expected = process.env.DD_REPORTS_TOKEN || '';
  const given = (req.get && req.get('x-report-token')) || '';

  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  const ok = expected.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  return next();
}

module.exports = { requireReportToken };
