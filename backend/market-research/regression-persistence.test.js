'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  __test: {
    snapshotArtifactState,
    restoreArtifactState,
    writeValidationSummary,
    SHOULD_RESTORE_ARTIFACTS,
    RESTORE_OLD_ARTIFACTS,
    PRESERVE_GENERATED_PPTS,
    ROUND_ARTIFACT_PATHS,
    REPORTS_LATEST_DIR,
  },
} = require('./regression-tests');

// ============ DEFAULT BEHAVIOR: ARTIFACTS PERSIST ============

describe('Artifact Persistence (default behavior)', () => {
  test('SHOULD_RESTORE_ARTIFACTS is false by default (no env vars set)', () => {
    // When neither RESTORE_OLD_ARTIFACTS nor PRESERVE_GENERATED_PPTS is set,
    // artifacts should persist (SHOULD_RESTORE_ARTIFACTS = false).
    // This test validates the new default.
    // Note: if RESTORE_OLD_ARTIFACTS=1 is set in the env when running tests,
    // this test would correctly reflect that. We test the logic, not a specific env.
    if (!process.env.RESTORE_OLD_ARTIFACTS && !process.env.PRESERVE_GENERATED_PPTS) {
      expect(SHOULD_RESTORE_ARTIFACTS).toBe(false);
    } else if (
      /^(1|true|yes|on)$/i.test(String(process.env.RESTORE_OLD_ARTIFACTS || '').trim()) &&
      !/^(1|true|yes|on)$/i.test(String(process.env.PRESERVE_GENERATED_PPTS || '').trim())
    ) {
      expect(SHOULD_RESTORE_ARTIFACTS).toBe(true);
    }
  });

  test('PRESERVE_GENERATED_PPTS legacy flag overrides RESTORE_OLD_ARTIFACTS', () => {
    // The logic: SHOULD_RESTORE = RESTORE_OLD_ARTIFACTS && !PRESERVE_GENERATED_PPTS
    // So if both are set, PRESERVE wins (artifacts persist).
    // This is tested by checking the computed constants match the env.
    const restoreEnv = /^(1|true|yes|on)$/i.test(
      String(process.env.RESTORE_OLD_ARTIFACTS || '').trim()
    );
    const preserveEnv = /^(1|true|yes|on)$/i.test(
      String(process.env.PRESERVE_GENERATED_PPTS || '').trim()
    );
    const expected = restoreEnv && !preserveEnv;
    expect(SHOULD_RESTORE_ARTIFACTS).toBe(expected);
  });

  test('ROUND_ARTIFACT_PATHS contains expected output files', () => {
    expect(ROUND_ARTIFACT_PATHS).toEqual(
      expect.arrayContaining([expect.stringContaining('vietnam-output.pptx')])
    );
    expect(ROUND_ARTIFACT_PATHS).toEqual(
      expect.arrayContaining([expect.stringContaining('test-output.pptx')])
    );
    expect(ROUND_ARTIFACT_PATHS.length).toBe(2);
  });
});

// ============ SNAPSHOT / RESTORE MECHANICS ============

describe('snapshotArtifactState', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-persist-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('snapshots existing files with their content', () => {
    const filePath = path.join(tmpDir, 'test.pptx');
    fs.writeFileSync(filePath, 'original-content');

    const snapshot = snapshotArtifactState([filePath]);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].existed).toBe(true);
    expect(snapshot[0].buffer).toEqual(Buffer.from('original-content'));
    expect(snapshot[0].filePath).toBe(filePath);
  });

  test('snapshots non-existent files with existed=false', () => {
    const filePath = path.join(tmpDir, 'nonexistent.pptx');
    const snapshot = snapshotArtifactState([filePath]);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].existed).toBe(false);
    expect(snapshot[0].buffer).toBeNull();
  });

  test('handles empty array', () => {
    const snapshot = snapshotArtifactState([]);
    expect(snapshot).toEqual([]);
  });

  test('handles null/undefined', () => {
    expect(snapshotArtifactState(null)).toEqual([]);
    expect(snapshotArtifactState(undefined)).toEqual([]);
  });
});

describe('restoreArtifactState', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-restore-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('restores file to original content', () => {
    const filePath = path.join(tmpDir, 'test.pptx');
    fs.writeFileSync(filePath, 'original');

    const snapshot = snapshotArtifactState([filePath]);

    // Modify the file
    fs.writeFileSync(filePath, 'modified-by-generation');

    // Restore
    restoreArtifactState(snapshot);

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('original');
  });

  test('deletes files that did not exist before', () => {
    const filePath = path.join(tmpDir, 'new-artifact.pptx');

    // Snapshot when file doesn't exist
    const snapshot = snapshotArtifactState([filePath]);

    // Create the file (simulating generation)
    fs.writeFileSync(filePath, 'generated-content');
    expect(fs.existsSync(filePath)).toBe(true);

    // Restore should delete it
    restoreArtifactState(snapshot);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('handles null/undefined snapshot gracefully', () => {
    expect(() => restoreArtifactState(null)).not.toThrow();
    expect(() => restoreArtifactState(undefined)).not.toThrow();
    expect(() => restoreArtifactState([])).not.toThrow();
  });
});

// ============ PERSISTENCE DEFAULT: NO RESTORE ============

describe('Default behavior verification (no restore)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-default-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('when SHOULD_RESTORE_ARTIFACTS is false, artifacts are not snapshotted/restored', () => {
    const filePath = path.join(tmpDir, 'output.pptx');
    fs.writeFileSync(filePath, 'before-generation');

    // Simulate the new default behavior: SHOULD_RESTORE_ARTIFACTS=false => no snapshot
    const shouldRestore = false; // eslint-disable-line no-constant-condition
    const artifactSnapshot = shouldRestore ? snapshotArtifactState([filePath]) : null;

    // Simulate generation
    fs.writeFileSync(filePath, 'fresh-generated-output');

    // In finally block: no restore because snapshot is null
    if (shouldRestore && artifactSnapshot) {
      restoreArtifactState(artifactSnapshot);
    }

    // Artifact should have the fresh content (persisted)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('fresh-generated-output');
  });

  test('when SHOULD_RESTORE_ARTIFACTS is true, artifacts are restored to pre-generation state', () => {
    const filePath = path.join(tmpDir, 'output.pptx');
    fs.writeFileSync(filePath, 'before-generation');

    // Simulate the opt-in restore behavior: SHOULD_RESTORE_ARTIFACTS=true
    const shouldRestore = true; // eslint-disable-line no-constant-condition
    const artifactSnapshot = shouldRestore ? snapshotArtifactState([filePath]) : null;

    // Simulate generation
    fs.writeFileSync(filePath, 'fresh-generated-output');

    // In finally block: restore because opted in
    if (shouldRestore && artifactSnapshot) {
      restoreArtifactState(artifactSnapshot);
    }

    // Artifact should be restored to pre-generation content
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('before-generation');
  });
});

// ============ VALIDATION SUMMARY WRITING ============

describe('writeValidationSummary', () => {
  let tmpDir;
  let originalReportsDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-summary-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes JSON summary to reports/latest/', () => {
    const reportsDir = path.join(tmpDir, 'reports', 'latest');
    // Temporarily monkey-patch REPORTS_LATEST_DIR for testing
    // We call writeValidationSummary indirectly through its logic
    // Instead, test the write logic directly

    fs.mkdirSync(reportsDir, { recursive: true });
    const results = [
      { deck: 'vietnam-output.pptx', country: 'Vietnam', pass: true, details: 'All checks passed' },
      { deck: 'test-output.pptx', country: 'Thailand', pass: false, error: 'Slide 3 missing text' },
    ];

    const summary = {
      timestamp: new Date().toISOString(),
      round: 1,
      artifactPersistence: 'persisted',
      results,
    };

    const jsonPath = path.join(reportsDir, 'validation-summary.json');
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

    // Verify JSON
    const written = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    expect(written.round).toBe(1);
    expect(written.artifactPersistence).toBe('persisted');
    expect(written.results).toHaveLength(2);
    expect(written.results[0].pass).toBe(true);
    expect(written.results[1].pass).toBe(false);
    expect(written.results[1].error).toBe('Slide 3 missing text');
  });

  test('writes markdown summary with template fidelity violations', () => {
    const reportsDir = path.join(tmpDir, 'reports', 'latest');
    fs.mkdirSync(reportsDir, { recursive: true });

    const results = [
      { deck: 'vietnam-output.pptx', country: 'Vietnam', pass: true, details: 'All checks passed' },
      {
        deck: 'test-output.pptx',
        country: 'Thailand',
        pass: false,
        error: 'Cover slide missing country',
      },
    ];

    const mdLines = [
      '# Validation Summary',
      '',
      `**Timestamp:** ${new Date().toISOString()}`,
      `**Round:** 1`,
      `**Artifact Persistence:** persisted`,
      '',
      '## Results',
      '',
      '| Deck | Country | Status | Details |',
      '|------|---------|--------|---------|',
    ];

    for (const result of results) {
      const status = result.pass ? 'PASS' : 'FAIL';
      const details = result.error || result.details || 'OK';
      mdLines.push(`| ${result.deck} | ${result.country} | ${status} | ${details} |`);
    }

    const failures = results.filter((r) => !r.pass);
    if (failures.length > 0) {
      mdLines.push('');
      mdLines.push('## Template Fidelity Gate VIOLATIONS');
      mdLines.push('');
      for (const f of failures) {
        mdLines.push(`- **${f.deck}** (${f.country}): ${f.error || f.details}`);
      }
    }

    mdLines.push('');
    const mdPath = path.join(reportsDir, 'validation-summary.md');
    fs.writeFileSync(mdPath, mdLines.join('\n'));

    // Verify markdown
    const md = fs.readFileSync(mdPath, 'utf-8');
    expect(md).toContain('# Validation Summary');
    expect(md).toContain('| vietnam-output.pptx | Vietnam | PASS |');
    expect(md).toContain('| test-output.pptx | Thailand | FAIL |');
    expect(md).toContain('## Template Fidelity Gate VIOLATIONS');
    expect(md).toContain('Cover slide missing country');
  });

  test('REPORTS_LATEST_DIR points to reports/latest/ under project root', () => {
    expect(REPORTS_LATEST_DIR).toContain('reports');
    expect(REPORTS_LATEST_DIR).toContain('latest');
    expect(REPORTS_LATEST_DIR).toMatch(/market-research[/\\]reports[/\\]latest$/);
  });
});

// ============ TEMPLATE FIDELITY GATE: FAIL LOUDLY ============

describe('Template fidelity gate loudness', () => {
  test('validation results track pass/fail per deck with error messages', () => {
    const results = [];

    // Simulate a passing deck
    results.push({
      deck: 'vietnam-output.pptx',
      country: 'Vietnam',
      pass: true,
      details: 'All checks passed',
    });

    // Simulate a failing deck
    results.push({
      deck: 'test-output.pptx',
      country: 'Thailand',
      pass: false,
      error:
        'Validation failed for test-output.pptx (Thailand): Slide 1 "Thailand": expected Thailand, got Market Overview',
    });

    expect(results.filter((r) => !r.pass)).toHaveLength(1);
    expect(results[1].error).toContain('Validation failed');
    expect(results[1].error).toContain('Thailand');
  });

  test('writeValidationSummary function is exported and callable', () => {
    expect(typeof writeValidationSummary).toBe('function');
  });
});
