'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  checkRealOutputValidation,
  SEVERITY,
  FULL_GATES,
  ENVIRONMENT_CONTRACTS,
  REMEDIATION_MAP,
  generateJsonReport,
  generateMarkdownReport,
  parseArgs,
  runFull,
} = require('./preflight-gates');

const PROJECT_ROOT = path.resolve(__dirname);

// ---------------------------------------------------------------------------
// Helpers — create temp directories with controlled content
// ---------------------------------------------------------------------------
function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'real-output-gate-'));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// 1. SKIP path — no deck directory
// ---------------------------------------------------------------------------
describe('Real output check gate — SKIP paths', () => {
  test('returns INFO/skip when deck directory does not exist', () => {
    const r = checkRealOutputValidation({
      deckDir: '/tmp/nonexistent-real-output-gate-test-dir-xyz-99999',
    });
    expect(r.name).toBe('Real output check');
    expect(r.pass).toBe(true);
    expect(r.severity).toBe(SEVERITY.INFO);
    expect(r.details).toMatch(/no deck directory|skipped/i);
    expect(typeof r.durationMs).toBe('number');
  });

  test('returns INFO/skip when deck directory exists but has no .pptx files', () => {
    const dir = makeTempDir('no-pptx-');
    try {
      // Create a non-pptx file so the dir isn't empty
      fs.writeFileSync(path.join(dir, 'readme.txt'), 'not a pptx');

      const r = checkRealOutputValidation({ deckDir: dir });
      expect(r.name).toBe('Real output check');
      expect(r.pass).toBe(true);
      expect(r.severity).toBe(SEVERITY.INFO);
      expect(r.details).toMatch(/no .pptx files|skipped/i);
    } finally {
      cleanupDir(dir);
    }
  });

  test('returns INFO/skip when using default deckDir and dir does not exist', () => {
    // Default deckDir is preflight-reports/decks/ which likely doesn't exist
    const defaultDir = path.join(PROJECT_ROOT, 'preflight-reports', 'decks');
    if (!fs.existsSync(defaultDir)) {
      const r = checkRealOutputValidation();
      expect(r.pass).toBe(true);
      expect(r.severity).toBe(SEVERITY.INFO);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. FAIL path — invalid PPTX files
// ---------------------------------------------------------------------------
describe('Real output check gate — FAIL paths', () => {
  test('fails when deck directory contains an invalid .pptx file', () => {
    const dir = makeTempDir('bad-pptx-');
    try {
      // Create a file with .pptx extension but invalid content
      fs.writeFileSync(path.join(dir, 'broken.pptx'), 'this is not a valid pptx');

      const r = checkRealOutputValidation({ deckDir: dir });
      expect(r.name).toBe('Real output check');
      expect(r.pass).toBe(false);
      expect(r.severity).toBe(SEVERITY.BLOCKING);
      expect(r.details).toMatch(/0\/1.*deck/i);
      expect(Array.isArray(r.evidence)).toBe(true);
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.evidence[0]).toMatch(/broken\.pptx.*FAILED/i);
    } finally {
      cleanupDir(dir);
    }
  });

  test('fails with multiple invalid .pptx files and reports all', () => {
    const dir = makeTempDir('multi-bad-');
    try {
      fs.writeFileSync(path.join(dir, 'bad1.pptx'), 'invalid1');
      fs.writeFileSync(path.join(dir, 'bad2.pptx'), 'invalid2');

      const r = checkRealOutputValidation({ deckDir: dir });
      expect(r.pass).toBe(false);
      expect(r.details).toMatch(/0\/2.*deck/i);
      expect(r.evidence.length).toBe(2);
      expect(r.evidence[0]).toMatch(/bad1\.pptx/);
      expect(r.evidence[1]).toMatch(/bad2\.pptx/);
    } finally {
      cleanupDir(dir);
    }
  });

  test('failure result includes remediation hint', () => {
    const dir = makeTempDir('remediation-');
    try {
      fs.writeFileSync(path.join(dir, 'test.pptx'), 'not valid');

      const r = checkRealOutputValidation({ deckDir: dir });
      expect(r.pass).toBe(false);
      // Remediation comes from REMEDIATION_MAP via makeCheckResult
      expect(r.remediation).toBeTruthy();
      expect(r.remediation).toMatch(/validate-real-output|pptx/i);
    } finally {
      cleanupDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Result shape contract
// ---------------------------------------------------------------------------
describe('Real output check gate — result shape', () => {
  test('always returns standard check result shape', () => {
    const r = checkRealOutputValidation({ deckDir: '/nonexistent' });
    expect(r).toHaveProperty('name');
    expect(r).toHaveProperty('pass');
    expect(r).toHaveProperty('severity');
    expect(r).toHaveProperty('status');
    expect(r).toHaveProperty('durationMs');
    expect(r).toHaveProperty('details');
    expect(r).toHaveProperty('evidence');
    expect(r).toHaveProperty('remediation');
    expect(typeof r.pass).toBe('boolean');
    expect(typeof r.durationMs).toBe('number');
  });

  test('durationMs is non-negative', () => {
    const r = checkRealOutputValidation({ deckDir: '/nonexistent' });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Integration with preflight-gates infrastructure
// ---------------------------------------------------------------------------
describe('Real output check — infrastructure integration', () => {
  test('FULL_GATES includes Real output check', () => {
    expect(FULL_GATES).toContain('Real output check');
  });

  test('ENVIRONMENT_CONTRACTS release mode requires Real output check', () => {
    expect(ENVIRONMENT_CONTRACTS.release.required).toContain('Real output check');
  });

  test('ENVIRONMENT_CONTRACTS dev mode skips Real output check', () => {
    expect(ENVIRONMENT_CONTRACTS.dev.skip).toContain('Real output check');
  });

  test('ENVIRONMENT_CONTRACTS test mode has Real output check as optional', () => {
    expect(ENVIRONMENT_CONTRACTS.test.optional).toContain('Real output check');
  });

  test('REMEDIATION_MAP has entry for Real output check', () => {
    expect(REMEDIATION_MAP['Real output check']).toBeTruthy();
    expect(typeof REMEDIATION_MAP['Real output check']).toBe('string');
  });

  test('runFull includes Real output check gate', () => {
    const results = runFull();
    const names = results.map((r) => r.name);
    expect(names).toContain('Real output check');
  });

  test('runFull Real output check defaults to skip when no decks dir', () => {
    const defaultDeckDir = path.join(PROJECT_ROOT, 'preflight-reports', 'decks');
    if (!fs.existsSync(defaultDeckDir)) {
      const results = runFull();
      const realOutput = results.find((r) => r.name === 'Real output check');
      expect(realOutput).toBeDefined();
      expect(realOutput.pass).toBe(true);
      // Either INFO or promoted severity depending on mode
      expect(realOutput.details).toMatch(/skipped|no deck|no .pptx/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Report integration
// ---------------------------------------------------------------------------
describe('Real output check — report integration', () => {
  test('JSON report includes real-output check when present', () => {
    const checks = [
      {
        name: 'Clean working tree',
        pass: true,
        severity: SEVERITY.BLOCKING,
        status: 'PASS',
        durationMs: 1,
        remediation: null,
      },
      {
        name: 'Real output check',
        pass: false,
        severity: SEVERITY.BLOCKING,
        status: 'FAIL',
        durationMs: 500,
        details: '0/1 deck(s) passed real-output check',
        evidence: ['broken.pptx: FAILED (3 check(s)) — Slide count: expected >= 20, got 0'],
        remediation: 'Fix PPTX output issues.',
      },
    ];
    const meta = {
      timestamp: '2026-02-15T00:00:00Z',
      nodeVersion: 'v22.0.0',
      gitBranch: 'main',
      mode: 'release',
      strict: true,
    };
    const report = generateJsonReport(checks, meta);
    expect(report.overallPass).toBe(false);
    const realOutputCheck = report.checks.find((c) => c.name === 'Real output check');
    expect(realOutputCheck).toBeDefined();
    expect(realOutputCheck.pass).toBe(false);
    expect(realOutputCheck.status).toBe('FAIL');
    expect(realOutputCheck.evidence).toContain(
      'broken.pptx: FAILED (3 check(s)) — Slide count: expected >= 20, got 0'
    );
    expect(realOutputCheck.remediation).toBe('Fix PPTX output issues.');
  });

  test('Markdown report includes real-output failure details', () => {
    const checks = [
      {
        name: 'Real output check',
        pass: false,
        severity: SEVERITY.BLOCKING,
        status: 'FAIL',
        durationMs: 500,
        details: '0/1 deck(s) passed',
        evidence: ['broken.pptx: FAILED'],
        remediation: 'Run validate-real-output.js',
      },
    ];
    const meta = {
      timestamp: '2026-02-15',
      nodeVersion: 'v22',
      gitBranch: 'main',
      mode: 'release',
    };
    const md = generateMarkdownReport(checks, meta);
    expect(md).toContain('Real output check');
    expect(md).toContain('FAIL');
    expect(md).toContain('0/1 deck(s) passed');
    expect(md).toContain('broken.pptx: FAILED');
    expect(md).toContain('Remediation');
    expect(md).toContain('validate-real-output.js');
  });

  test('JSON report overallPass is true when real-output passes', () => {
    const checks = [
      {
        name: 'Real output check',
        pass: true,
        severity: SEVERITY.BLOCKING,
        status: 'PASS',
        durationMs: 200,
        details: '1/1 deck(s) passed',
        evidence: ['good.pptx: PASSED (34 checks, 0 warnings)'],
        remediation: null,
      },
    ];
    const meta = { timestamp: 'now', nodeVersion: 'v22', gitBranch: 'main', mode: 'dev' };
    const report = generateJsonReport(checks, meta);
    expect(report.overallPass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. parseArgs --deck-dir
// ---------------------------------------------------------------------------
describe('parseArgs --deck-dir', () => {
  test('parseArgs parses --deck-dir flag', () => {
    const args = parseArgs(['--deck-dir=/tmp/my-decks']);
    expect(args.deckDir).toBe('/tmp/my-decks');
  });

  test('parseArgs deckDir defaults to null', () => {
    const args = parseArgs([]);
    expect(args.deckDir).toBeNull();
  });

  test('parseArgs combined with other flags', () => {
    const args = parseArgs([
      '--mode=full',
      '--gate-mode=release',
      '--deck-dir=/tmp/decks',
      '--strict',
    ]);
    expect(args.mode).toBe('full');
    expect(args.gateMode).toBe('release');
    expect(args.deckDir).toBe('/tmp/decks');
    expect(args.strict).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Edge cases
// ---------------------------------------------------------------------------
describe('Real output check — edge cases', () => {
  test('handles unreadable deck directory gracefully', () => {
    // Use a path that exists but is not a directory (e.g., a file)
    const tmpFile = path.join(os.tmpdir(), 'not-a-dir-real-output-test.txt');
    try {
      fs.writeFileSync(tmpFile, 'file, not directory');
      const r = checkRealOutputValidation({ deckDir: tmpFile });
      // Should fail gracefully since it can't readdir a file
      expect(r).toHaveProperty('pass');
      expect(r).toHaveProperty('details');
      // Either fails to read or treats as no .pptx files
      expect(typeof r.pass).toBe('boolean');
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  });

  test('options object is optional', () => {
    // Should not throw when called with no arguments
    const r = checkRealOutputValidation();
    expect(r).toHaveProperty('name', 'Real output check');
    expect(r).toHaveProperty('pass');
  });

  test('accepts custom country and industry options', () => {
    const r = checkRealOutputValidation({
      deckDir: '/nonexistent',
      country: 'Thailand',
      industry: 'Renewable Energy',
    });
    expect(r.pass).toBe(true);
    expect(r.severity).toBe(SEVERITY.INFO);
  });
});
