const crypto = require('crypto');

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

/**
 * Guard for routes that return transcripts or recordings.
 * They can hold confidential meeting content, so they stay closed unless
 * TRANSCRIPTION_ACCESS_TOKEN is set and the caller sends it in X-Access-Token.
 * A closed route answers 404 so it does not reveal that it exists.
 * Both values are hashed first so the compare is constant-time and length-independent.
 */
function requireAccessToken(req, res, next) {
  const expected = process.env.TRANSCRIPTION_ACCESS_TOKEN || '';
  const given = (req.get && req.get('x-access-token')) || '';

  const ok = expected.length > 0 && crypto.timingSafeEqual(digest(given), digest(expected));

  if (!ok) {
    return res.status(404).json({ error: 'Not found' });
  }
  return next();
}

module.exports = { requireAccessToken };
