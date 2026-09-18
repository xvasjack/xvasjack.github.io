/**
 * Shared security utilities for all backend services
 */

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

/**
 * Security headers middleware
 */
const securityHeaders = helmet({
  contentSecurityPolicy: false, // Disable CSP for API-only services
  crossOriginEmbedderPolicy: false,
});

/**
 * Rate limiting - 100 requests per minute per IP
 */
const rateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Stricter rate limit for expensive operations (AI calls, file generation)
 */
const strictRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Rate limit exceeded for this operation' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * HTML escape to prevent XSS
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Sanitize file path to prevent path traversal
 */
function sanitizePath(filePath) {
  if (typeof filePath !== 'string') return '';
  // Remove any path traversal attempts
  let result = filePath.replace(/\.\./g, '');
  // Collapse multiple slashes (loop until no more double slashes)
  while (result.includes('//')) {
    result = result.replace(/\/\//g, '/');
  }
  // Remove leading slash
  return result.replace(/^\//, '');
}

/**
 * Validate email format
 */
function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Allowed CORS origins (configure per environment)
 */
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['https://xvasjack.github.io', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
};

module.exports = {
  securityHeaders,
  rateLimiter,
  strictRateLimiter,
  escapeHtml,
  sanitizePath,
  isValidEmail,
  corsOptions,
};
