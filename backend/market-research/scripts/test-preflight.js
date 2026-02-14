#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { verifyHeadContent } = require('./preflight-release');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function main() {
  console.log('');
  console.log('test-preflight.js');
  console.log('');

  // -----------------------------------------------------------------------
  // Test 1: Passing case — real files with real patterns
  // -----------------------------------------------------------------------
  test('passing case: real files and patterns found in HEAD', () => {
    const result = verifyHeadContent([
      { file: 'server.js', patterns: ['collectPreRenderStructureIssues'] },
      { file: 'quality-gates.js', patterns: ['validatePptData'] },
    ]);

    assert.strictEqual(result.pass, true, `expected pass=true, got ${result.pass}`);
    assert.strictEqual(
      result.failures.length,
      0,
      `expected 0 failures, got ${JSON.stringify(result.failures)}`
    );
  });

  // -----------------------------------------------------------------------
  // Test 2: Failing case — pattern that does not exist
  // -----------------------------------------------------------------------
  test('failing case: pattern missing from file', () => {
    const badPattern = 'THIS_PATTERN_DOES_NOT_EXIST_ANYWHERE_12345';
    const result = verifyHeadContent([{ file: 'server.js', patterns: [badPattern] }]);

    assert.strictEqual(result.pass, false, `expected pass=false, got ${result.pass}`);
    assert.ok(result.failures.length > 0, 'expected at least one failure entry');

    const entry = result.failures.find((f) => f.file === 'server.js');
    assert.ok(entry, 'expected a failure entry for server.js');
    assert.ok(
      entry.missing.includes(badPattern),
      `expected missing list to include "${badPattern}", got ${JSON.stringify(entry.missing)}`
    );
  });

  // -----------------------------------------------------------------------
  // Test 3: Failing case — file that does not exist
  // -----------------------------------------------------------------------
  test('failing case: nonexistent file', () => {
    const result = verifyHeadContent([{ file: 'nonexistent-file-xyz.js', patterns: ['anything'] }]);

    assert.strictEqual(result.pass, false, `expected pass=false, got ${result.pass}`);
    assert.ok(result.failures.length > 0, 'expected at least one failure entry');

    const entry = result.failures.find((f) => f.file === 'nonexistent-file-xyz.js');
    assert.ok(entry, 'expected a failure entry for nonexistent-file-xyz.js');
    assert.ok(
      entry.missing.includes('anything'),
      `expected missing list to include "anything", got ${JSON.stringify(entry.missing)}`
    );
  });

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}
