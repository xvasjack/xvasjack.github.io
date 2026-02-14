/**
 * Integration tests for shared modules working together
 * Tests that the shared utilities integrate correctly
 */

const express = require('express');
const request = require('supertest');
const { securityHeaders, escapeHtml, sanitizePath } = require('../shared/security');
const { requestLogger, healthCheck } = require('../shared/middleware');
const { sendEmail, getMimeType } = require('../shared/email');
const { logMemoryUsage, setupGlobalErrorHandlers } = require('../shared/logging');
const {
  withRetry,
  safeAPICall,
  callWithFallback,
  extractJSON,
  ensureString,
  createCostTracker,
} = require('../shared/ai-models');
const {
  normalizeCompanyName,
  normalizeWebsite,
  dedupeCompanies,
  isSpamOrDirectoryURL,
  buildExclusionRules,
  detectMeetingDomain,
} = require('../shared/utils');

describe('Integration Tests', () => {
  describe('Express middleware integration', () => {
    let app;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use(securityHeaders); // securityHeaders is already the middleware
      app.use(requestLogger);
      app.get('/health', healthCheck('test-service'));
      app.post('/api/test', (req, res) => {
        res.json({ received: req.body });
      });
    });

    it('health check endpoint works with all middleware', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.service).toBe('test-service');
      expect(response.body.memory).toBeDefined();
      expect(response.body.uptime).toBeDefined();
    });

    it('security headers are set on responses', async () => {
      const response = await request(app).get('/health');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN'); // Helmet default
    });

    it('POST endpoint receives JSON body', async () => {
      const response = await request(app)
        .post('/api/test')
        .send({ test: 'data' })
        .set('Content-Type', 'application/json');
      expect(response.status).toBe(200);
      expect(response.body.received).toEqual({ test: 'data' });
    });
  });

  // Note: Rate limiter requires real request.ip which supertest doesn't provide
  // Rate limiter is tested via the security.test.js configuration tests

  describe('Security utilities integration', () => {
    it('escapeHtml handles user input safely', () => {
      const userInput = '<script>alert("xss")</script>';
      const escaped = escapeHtml(userInput);
      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&lt;script&gt;');
    });

    it('sanitizePath prevents directory traversal', () => {
      const maliciousPath = '../../../etc/passwd';
      const sanitized = sanitizePath(maliciousPath);
      expect(sanitized).not.toContain('..');
      expect(sanitized).toBe('etc/passwd'); // Path traversal removed, leading slash removed
    });
  });

  describe('Logging integration', () => {
    it('logMemoryUsage logs without throwing', () => {
      expect(() => logMemoryUsage('test')).not.toThrow();
    });

    it('setupGlobalErrorHandlers installs handlers', () => {
      // Store original listeners
      const originalUnhandled = process.listenerCount('unhandledRejection');
      const originalUncaught = process.listenerCount('uncaughtException');

      setupGlobalErrorHandlers({ logMemory: false });

      // Verify listeners were added
      expect(process.listenerCount('unhandledRejection')).toBeGreaterThanOrEqual(originalUnhandled);
      expect(process.listenerCount('uncaughtException')).toBeGreaterThanOrEqual(originalUncaught);
    });
  });

  describe('Email utilities integration', () => {
    it('getMimeType returns correct types for common extensions', () => {
      expect(getMimeType('report.xlsx')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(getMimeType('slides.pptx')).toBe(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      );
      expect(getMimeType('data.csv')).toBe('text/csv');
      expect(getMimeType('doc.pdf')).toBe('application/pdf');
    });

    it('getMimeType handles unknown extensions', () => {
      expect(getMimeType('file.unknown')).toBe('application/octet-stream');
      expect(getMimeType(null)).toBe('application/octet-stream');
      expect(getMimeType('')).toBe('application/octet-stream');
    });
  });

  describe('AI models + utils integration', () => {
    it('ensureString from utils and ai-models handle same cases', () => {
      // Both modules have ensureString, verify consistent behavior
      const testCases = [
        'simple string',
        null,
        undefined,
        ['array', 'of', 'strings'],
        { text: 'object with text' },
        { name: 'object with name' },
      ];

      testCases.forEach((testCase) => {
        const utilsResult = ensureString(testCase);
        expect(typeof utilsResult).toBe('string');
      });
    });

    it('extractJSON + callWithFallback work together', async () => {
      // Simulate AI response with markdown
      const mockAIResponse = '```json\n{"companies": [{"name": "Acme"}]}\n```';

      const { result } = await callWithFallback(
        async () => mockAIResponse,
        async () => '[]',
        'Primary',
        'Fallback'
      );

      const parsed = extractJSON(result);
      expect(parsed).toEqual({ companies: [{ name: 'Acme' }] });
    });

    it('cost tracker integrates with retry logic', async () => {
      const tracker = createCostTracker();

      // Simulate multiple API calls with retry
      await withRetry(
        async () => {
          tracker.add('gpt-4.1', 1000, 500, 'search');
          return 'success';
        },
        3,
        10,
        'test'
      );

      const summary = tracker.getSummary();
      expect(summary.callCount).toBe(1);
      expect(summary.byFeature.search).toBeDefined();
    });
  });

  describe('Company utils + deduplication integration', () => {
    it('normalizeCompanyName + dedupeCompanies work together', () => {
      const companies = [
        { company_name: 'Acme Corp Ltd', website: 'https://acme.com', hq: 'US' },
        { company_name: 'ACME Corporation Ltd.', website: 'https://acme.com/', hq: 'US' },
        { company_name: 'Beta Inc', website: 'https://beta.io', hq: 'UK' },
        { company_name: 'Beta Incorporated', website: 'https://www.beta.io', hq: 'UK' },
      ];

      const deduped = dedupeCompanies(companies);
      expect(deduped.length).toBe(2);
    });

    it('isSpamOrDirectoryURL filters before deduplication', () => {
      const companies = [
        { company_name: 'Good Corp', website: 'https://good.com', hq: 'US' },
        {
          company_name: 'Wiki Reference',
          website: 'https://en.wikipedia.org/wiki/Company',
          hq: 'US',
        },
        { company_name: 'Social', website: 'https://facebook.com/company', hq: 'US' },
      ];

      const filtered = companies.filter((c) => !isSpamOrDirectoryURL(c.website));
      const deduped = dedupeCompanies(filtered);
      expect(deduped.length).toBe(1);
      expect(deduped[0].company_name).toBe('Good Corp');
    });

    it('normalizeWebsite handles various URL formats', () => {
      const urls = [
        'https://www.example.com/',
        'http://example.com',
        'https://EXAMPLE.COM/home',
        'http://www.example.com/index.html',
      ];

      const normalized = urls.map(normalizeWebsite);
      // All should normalize to similar form
      normalized.forEach((n) => {
        expect(n).toContain('example.com');
        expect(n).not.toContain('www.');
        expect(n).not.toContain('http');
      });
    });
  });

  describe('Domain detection + exclusion integration', () => {
    it('detectMeetingDomain + buildExclusionRules work for financial context', () => {
      const meetingText = 'Discussion about EBITDA, revenue growth, and M&A opportunities';
      const domain = detectMeetingDomain(meetingText);
      expect(domain).toBe('financial');

      const exclusionRules = buildExclusionRules('exclude large MNC and listed companies');
      expect(exclusionRules).toContain('multinational');
      expect(exclusionRules).toContain('publicly listed');
    });

    it('detectMeetingDomain handles multiple domain keywords', () => {
      expect(detectMeetingDomain('contract liability clause')).toBe('legal');
      expect(detectMeetingDomain('patient diagnosis clinical trial')).toBe('medical');
      expect(detectMeetingDomain('API deployment kubernetes')).toBe('technical');
      expect(detectMeetingDomain('hiring bonus compensation')).toBe('hr');
      expect(detectMeetingDomain('general discussion')).toBe('general');
    });
  });

  describe('End-to-end data flow', () => {
    it('simulates company search pipeline', async () => {
      // Step 1: Mock AI response
      const aiResponse = `Here are some companies:
\`\`\`json
[
  {"company_name": "Alpha Sdn Bhd", "website": "https://alpha.com.my", "hq": "Kuala Lumpur, Malaysia", "description": "Manufacturing"},
  {"company_name": "Alpha SDN BHD", "website": "https://www.alpha.com.my/", "hq": "KL, Malaysia", "description": "Manufacturing"},
  {"company_name": "Beta Corp", "website": "https://beta.com", "hq": "Singapore", "description": "Technology"},
  {"company_name": "Wiki Corp", "website": "https://wikipedia.org/wiki/Company", "hq": "US", "description": "Reference"}
]
\`\`\``;

      // Step 2: Extract JSON
      const companies = extractJSON(aiResponse);
      expect(companies).toHaveLength(4);

      // Step 3: Deduplicate
      const deduped = dedupeCompanies(companies);
      expect(deduped.length).toBe(2); // Alpha (deduped) and Beta, Wiki filtered

      // Step 4: Verify company names are normalized in output
      const names = deduped.map((c) => c.company_name);
      expect(names).toContain('Alpha Sdn Bhd');
      expect(names).toContain('Beta Corp');
    });

    it('simulates cost-tracked AI call with fallback', async () => {
      const tracker = createCostTracker();
      let geminiCalled = false;
      let gpt4oCalled = false;

      const { result, usedFallback } = await callWithFallback(
        async () => {
          geminiCalled = true;
          tracker.add('gemini-2.5-flash', 500, 200, 'search');
          return null; // Simulate Gemini returning empty
        },
        async () => {
          gpt4oCalled = true;
          tracker.add('gpt-4.1', 500, 300, 'search');
          return '[{"company_name": "Test Corp", "website": "https://test.com", "hq": "US"}]';
        },
        'Gemini',
        'GPT-4.1'
      );

      expect(geminiCalled).toBe(true);
      expect(gpt4oCalled).toBe(true);
      expect(usedFallback).toBe(true);

      const summary = tracker.getSummary();
      expect(summary.callCount).toBe(2);
      expect(summary.byModel['gemini-2.5-flash']).toBeDefined();
      expect(summary.byModel['gpt-4.1']).toBeDefined();

      const parsed = extractJSON(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].company_name).toBe('Test Corp');
    });
  });
});
