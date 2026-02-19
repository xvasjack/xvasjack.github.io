'use strict';

const fs = require('fs');
const path = require('path');

const {
  SEVERITY,
  GATE_MODES,
  FORMATTING_AUDIT_WARNING_CODES,
  applyModePolicy,
  checkFormattingAudit,
  generateJsonReport,
  generateMarkdownReport,
  computeStructuredReadiness,
  runFull,
} = require('./preflight-gates');

const PROJECT_ROOT = path.resolve(__dirname);
const REPORTS_DIR = path.join(PROJECT_ROOT, 'preflight-reports');

// ---------------------------------------------------------------------------
// Helpers: create/remove temporary report files for test isolation
// ---------------------------------------------------------------------------
function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

function writeTestReport(filename, data) {
  ensureReportsDir();
  fs.writeFileSync(path.join(REPORTS_DIR, filename), JSON.stringify(data, null, 2));
}

function removeTestReport(filename) {
  const filePath = path.join(REPORTS_DIR, filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

const TEST_REPORT_FILE = '__test-formatting-audit-strict.json';

afterEach(() => {
  removeTestReport(TEST_REPORT_FILE);
});

// ---------------------------------------------------------------------------
// 1. checkFormattingAudit basic behavior
// ---------------------------------------------------------------------------
describe('Formatting Audit Gate', () => {
  test('checkFormattingAudit returns valid check result shape', () => {
    const r = checkFormattingAudit();
    expect(r).toHaveProperty('name', 'Formatting audit');
    expect(r).toHaveProperty('pass');
    expect(typeof r.pass).toBe('boolean');
    expect(r).toHaveProperty('severity');
    expect(r).toHaveProperty('durationMs');
    expect(r).toHaveProperty('details');
    expect(r).toHaveProperty('remediation');
  });

  test('checkFormattingAudit passes when no issues exist in reports', () => {
    // Write a clean report with no formatting issues
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: [],
      formattingWarnings: [],
    });
    const r = checkFormattingAudit();
    expect(r.pass).toBe(true);
  });

  test('checkFormattingAudit fails when drift warning codes are present', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['header_footer_line_drift', 'table_margin_drift'],
    });
    const r = checkFormattingAudit();
    expect(r.pass).toBe(false);
    expect(r.severity).toBe(SEVERITY.DEGRADED);
    expect(r.details).toContain('drift/mismatch');
    expect(r.details).toContain('Blocking slide keys');
  });

  test('checkFormattingAudit fails when mismatch codes are present', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['line_width_signature_mismatch', 'slide_size_mismatch'],
    });
    const r = checkFormattingAudit();
    expect(r.pass).toBe(false);
    expect(r.details).toContain('Blocking slide keys');
    expect(r.details).toContain('line_width_signature_mismatch');
  });

  test('checkFormattingAudit evidence lists exact blocking slide keys', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['table_anchor_top_heavy', 'table_outer_border_missing'],
    });
    const r = checkFormattingAudit();
    expect(r.pass).toBe(false);
    expect(Array.isArray(r.evidence)).toBe(true);
    const evidenceText = r.evidence.join(' ');
    expect(evidenceText).toContain('table_anchor_top_heavy');
    expect(evidenceText).toContain('table_outer_border_missing');
  });

  test('checkFormattingAudit detects server formattingWarnings', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingWarnings: ['formatAuditWarnings=3', 'geometryIssues=2'],
    });
    const r = checkFormattingAudit();
    expect(r.pass).toBe(false);
    expect(r.details).toContain('drift/mismatch');
  });

  test('checkFormattingAudit detects drift from template-contract-compiler', () => {
    writeTestReport(TEST_REPORT_FILE, {
      driftDetected: true,
      summary: { totalIssues: 5, errorCount: 1, warningCount: 4 },
      allIssues: [
        { blockKey: 'market_size_chart', type: 'geometry_mismatch' },
        { blockKey: 'competitor_table', type: 'layout_drift' },
      ],
    });
    const r = checkFormattingAudit();
    expect(r.pass).toBe(false);
    expect(r.details).toContain('Blocking slide keys');
    expect(r.details).toContain('market_size_chart');
  });

  test('checkFormattingAudit ignores unknown codes not in FORMATTING_AUDIT_WARNING_CODES', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['some_unknown_code_xyz'],
    });
    const r = checkFormattingAudit();
    // Unknown codes should not trigger failure
    expect(r.pass).toBe(true);
  });

  test('checkFormattingAudit handles empty reports directory', () => {
    ensureReportsDir();
    // Remove our test report to ensure clean state
    removeTestReport(TEST_REPORT_FILE);
    const r = checkFormattingAudit();
    // Should pass or skip (no issues found)
    expect(r).toHaveProperty('pass');
    expect(r).toHaveProperty('name', 'Formatting audit');
  });
});

// ---------------------------------------------------------------------------
// 2. Strict mode: formatting warnings become hard failures
// ---------------------------------------------------------------------------
describe('Strict Mode Formatting Audit', () => {
  test('strict mode promotes DEGRADED formatting audit failure to BLOCKING', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['header_footer_line_drift'],
    });
    const rawResult = checkFormattingAudit();
    expect(rawResult.pass).toBe(false);
    expect(rawResult.severity).toBe(SEVERITY.DEGRADED);

    // Apply strict mode policy
    const strictResult = applyModePolicy(rawResult, GATE_MODES.DEV, true);
    expect(strictResult.severity).toBe(SEVERITY.BLOCKING);
    expect(strictResult.status).toBe('FAIL');
  });

  test('strict mode + release mode promotes formatting audit failure to BLOCKING', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['table_margin_drift'],
    });
    const rawResult = checkFormattingAudit();
    const strictResult = applyModePolicy(rawResult, GATE_MODES.RELEASE, true);
    expect(strictResult.severity).toBe(SEVERITY.BLOCKING);
    expect(strictResult.status).toBe('FAIL');
  });

  test('non-strict mode keeps formatting audit as DEGRADED warning', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['table_margin_drift'],
    });
    const rawResult = checkFormattingAudit();
    const nonStrictResult = applyModePolicy(rawResult, GATE_MODES.DEV, false);
    expect(nonStrictResult.severity).toBe(SEVERITY.DEGRADED);
    expect(nonStrictResult.status).toBe('WARN');
  });

  test('non-strict release mode promotes DEGRADED to BLOCKING but is not strict-fail', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['header_footer_line_drift'],
    });
    const rawResult = checkFormattingAudit();
    // Release mode (non-strict) promotes DEGRADED to BLOCKING
    const releaseResult = applyModePolicy(rawResult, GATE_MODES.RELEASE, false);
    expect(releaseResult.severity).toBe(SEVERITY.BLOCKING);
    expect(releaseResult.status).toBe('FAIL');
  });

  test('passing formatting audit is not affected by strict mode', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: [],
    });
    const rawResult = checkFormattingAudit();
    expect(rawResult.pass).toBe(true);
    const strictResult = applyModePolicy(rawResult, GATE_MODES.RELEASE, true);
    expect(strictResult.pass).toBe(true);
    // Severity is promoted but pass remains true
    expect(strictResult.severity).toBe(SEVERITY.BLOCKING);
  });
});

// ---------------------------------------------------------------------------
// 3. Failure message lists exact blocking slide keys
// ---------------------------------------------------------------------------
describe('Blocking Slide Keys in Failure Messages', () => {
  test('failure details contain blocking slide keys from formattingAuditIssueCodes', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: [
        'slide_size_mismatch',
        'table_margin_runaway',
        'header_footer_line_drift',
      ],
    });
    const r = checkFormattingAudit();
    expect(r.pass).toBe(false);
    expect(r.details).toContain('slide_size_mismatch');
    expect(r.details).toContain('table_margin_runaway');
    expect(r.details).toContain('header_footer_line_drift');
  });

  test('failure details contain blocking slide keys from drift allIssues', () => {
    writeTestReport(TEST_REPORT_FILE, {
      driftDetected: true,
      summary: { totalIssues: 2, errorCount: 0, warningCount: 2 },
      allIssues: [{ blockKey: 'policy_regulatory_overview' }, { blockKey: 'market_growth_chart' }],
    });
    const r = checkFormattingAudit();
    expect(r.pass).toBe(false);
    expect(r.details).toContain('policy_regulatory_overview');
    expect(r.details).toContain('market_growth_chart');
  });

  test('root causes section present in evidence', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['table_outer_border_missing'],
    });
    const r = checkFormattingAudit();
    expect(r.pass).toBe(false);
    const evidenceText = r.evidence.join('\n');
    expect(evidenceText).toContain('Root causes');
  });
});

// ---------------------------------------------------------------------------
// 4. Integration: strict preflight fails when formatting warning injected
// ---------------------------------------------------------------------------
describe('Integration: Strict Preflight with Formatting Warnings', () => {
  test('strict full preflight fails when formatting drift is injected', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['header_footer_line_drift', 'table_margin_drift'],
    });

    // Run full gates with strict mode
    const results = runFull({ gateMode: GATE_MODES.DEV, strict: true });
    const formattingResult = results.find((r) => r.name === 'Formatting audit');

    expect(formattingResult).toBeDefined();
    expect(formattingResult.pass).toBe(false);
    expect(formattingResult.severity).toBe(SEVERITY.BLOCKING);
    expect(formattingResult.status).toBe('FAIL');

    // Overall readiness should fail
    const readiness = computeStructuredReadiness(results, { mode: 'dev', strict: true });
    expect(readiness.passes).toBe(false);
  });

  test('non-strict full preflight warns but continues on formatting drift', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['header_footer_line_drift'],
    });

    const results = runFull({ gateMode: GATE_MODES.DEV, strict: false });
    const formattingResult = results.find((r) => r.name === 'Formatting audit');

    expect(formattingResult).toBeDefined();
    expect(formattingResult.pass).toBe(false);
    expect(formattingResult.severity).toBe(SEVERITY.DEGRADED);
    expect(formattingResult.status).toBe('WARN');

    // Overall should still pass (DEGRADED doesn't block in dev mode)
    const hasBlockingFailure = results.some((r) => !r.pass && r.severity === SEVERITY.BLOCKING);
    // Note: there may be other blocking failures from other gates, but formatting
    // audit specifically is not blocking in non-strict dev mode.
    expect(formattingResult.severity).not.toBe(SEVERITY.BLOCKING);
  });

  test('runFull includes Formatting audit gate in results', () => {
    const results = runFull();
    const names = results.map((r) => r.name);
    expect(names).toContain('Formatting audit');
  });
});

// ---------------------------------------------------------------------------
// 5. Report generation includes formatting audit
// ---------------------------------------------------------------------------
describe('Report Generation with Formatting Audit', () => {
  test('JSON report includes formatting audit check', () => {
    writeTestReport(TEST_REPORT_FILE, {
      formattingAuditIssueCodes: ['slide_size_mismatch'],
    });

    const results = [
      {
        name: 'Clean working tree',
        pass: true,
        severity: SEVERITY.BLOCKING,
        status: 'PASS',
        durationMs: 1,
        remediation: null,
      },
      checkFormattingAudit(),
    ];
    const meta = {
      timestamp: '2026-02-15T00:00:00Z',
      nodeVersion: 'v22.0.0',
      gitBranch: 'test',
      mode: 'dev',
      strict: true,
    };
    const report = generateJsonReport(results, meta);
    const fmtCheck = report.checks.find((c) => c.name === 'Formatting audit');
    expect(fmtCheck).toBeDefined();
    expect(fmtCheck.pass).toBe(false);
    expect(fmtCheck.details).toContain('Blocking slide keys');
  });

  test('Markdown report includes formatting audit failure with remediation', () => {
    const results = [
      {
        name: 'Formatting audit',
        pass: false,
        severity: SEVERITY.BLOCKING,
        status: 'FAIL',
        durationMs: 5,
        details: 'Formatting drift detected. Blocking slide keys: header_footer_line_drift',
        evidence: ['header_footer_line_drift: delta > 2500 EMU'],
        remediation:
          'Review formatting audit results in preflight-reports/. Fix drift/mismatch issues in deck-builder-single.js or template-patterns.json',
      },
    ];
    const meta = {
      timestamp: '2026-02-15',
      nodeVersion: 'v22',
      gitBranch: 'main',
      mode: 'release',
      strict: true,
    };
    const md = generateMarkdownReport(results, meta);
    expect(md).toContain('Formatting audit');
    expect(md).toContain('FAIL');
    expect(md).toContain('Remediation');
    expect(md).toContain('header_footer_line_drift');
  });
});

// ---------------------------------------------------------------------------
// 6. FORMATTING_AUDIT_WARNING_CODES constant
// ---------------------------------------------------------------------------
describe('FORMATTING_AUDIT_WARNING_CODES', () => {
  test('contains all known drift/mismatch codes', () => {
    expect(FORMATTING_AUDIT_WARNING_CODES).toContain('header_footer_line_drift');
    expect(FORMATTING_AUDIT_WARNING_CODES).toContain('line_width_signature_mismatch');
    expect(FORMATTING_AUDIT_WARNING_CODES).toContain('table_margin_drift');
    expect(FORMATTING_AUDIT_WARNING_CODES).toContain('slide_size_mismatch');
    expect(FORMATTING_AUDIT_WARNING_CODES).toContain('table_margin_runaway');
    expect(FORMATTING_AUDIT_WARNING_CODES).toContain('format_audit_exception');
  });

  test('is a non-empty array of strings', () => {
    expect(Array.isArray(FORMATTING_AUDIT_WARNING_CODES)).toBe(true);
    expect(FORMATTING_AUDIT_WARNING_CODES.length).toBeGreaterThan(0);
    for (const code of FORMATTING_AUDIT_WARNING_CODES) {
      expect(typeof code).toBe('string');
    }
  });
});
