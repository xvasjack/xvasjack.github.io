#!/usr/bin/env node
/**
 * Repair a generated PPTX by normalizing duplicate non-visual shape IDs
 * and reconciling [Content_Types].xml overrides.
 *
 * Usage:
 *   node repair-pptx.js <input.pptx> [output.pptx]
 */

const fs = require('fs');
const path = require('path');
const {
  readPPTX,
  validatePPTX,
  scanRelationshipTargets,
  scanPackageConsistency,
  normalizeSlideNonVisualIds,
  reconcileContentTypesAndPackage,
} = require('./deck-file-check');

function buildIssues(packageConsistency) {
  const issues = [];
  if ((packageConsistency.missingCriticalParts || []).length > 0) {
    issues.push(`missing critical parts: ${packageConsistency.missingCriticalParts.join(', ')}`);
  }
  if ((packageConsistency.duplicateRelationshipIds || []).length > 0) {
    issues.push(
      `duplicate relationship ids: ${packageConsistency.duplicateRelationshipIds.length}`
    );
  }
  if ((packageConsistency.duplicateSlideIds || []).length > 0) {
    issues.push(`duplicate slide ids: ${packageConsistency.duplicateSlideIds.join(', ')}`);
  }
  if ((packageConsistency.duplicateSlideRelIds || []).length > 0) {
    issues.push(`duplicate slide rel ids: ${packageConsistency.duplicateSlideRelIds.join(', ')}`);
  }
  if ((packageConsistency.missingRelationshipReferences || []).length > 0) {
    const preview = packageConsistency.missingRelationshipReferences
      .slice(0, 5)
      .map((x) => `${x.ownerPart}:${x.relId}`)
      .join(', ');
    issues.push(`dangling xml relationship refs: ${preview}`);
  }
  if ((packageConsistency.duplicateNonVisualShapeIds || []).length > 0) {
    const preview = packageConsistency.duplicateNonVisualShapeIds
      .slice(0, 5)
      .map((x) => `${x.slide}:id=${x.id}(x${x.count})`)
      .join(', ');
    issues.push(`duplicate non-visual shape ids: ${preview}`);
  }
  if ((packageConsistency.danglingOverrides || []).length > 0) {
    issues.push(
      `dangling overrides: ${packageConsistency.danglingOverrides.slice(0, 10).join(', ')}`
    );
  }
  if ((packageConsistency.missingExpectedOverrides || []).length > 0) {
    issues.push(
      `missing expected overrides: ${packageConsistency.missingExpectedOverrides.length}`
    );
  }
  if ((packageConsistency.contentTypeMismatches || []).length > 0) {
    issues.push(`content type mismatches: ${packageConsistency.contentTypeMismatches.length}`);
  }
  return issues;
}

async function repair(inputPath, outputPath) {
  const raw = fs.readFileSync(inputPath);
  let buffer = raw;

  const idNormalize = await normalizeSlideNonVisualIds(buffer);
  buffer = idNormalize.buffer;

  const ctReconcile = await reconcileContentTypesAndPackage(buffer);
  buffer = ctReconcile.buffer;

  const { zip } = await readPPTX(buffer);
  const relIntegrity = await scanRelationshipTargets(zip);
  const packageConsistency = await scanPackageConsistency(zip);
  const packageIssues = buildIssues(packageConsistency);

  const check = await validatePPTX(buffer, {
    minFileSize: 50 * 1024,
    minSlides: 5,
    minCharts: 0,
    minTables: 0,
    requireInsights: false,
  });

  fs.writeFileSync(outputPath, buffer);

  console.log(`Input:  ${inputPath}`);
  console.log(`Output: ${outputPath}`);
  console.log(
    `[Repair] ID normalization: changed=${idNormalize.changed}, reassignedIds=${idNormalize.stats?.reassignedIds || 0}`
  );
  console.log(
    `[Repair] Content types reconcile: changed=${ctReconcile.changed}, removedDangling=${(ctReconcile.stats?.removedDangling || []).length}, addedOverrides=${(ctReconcile.stats?.addedOverrides || []).length}, correctedOverrides=${(ctReconcile.stats?.correctedOverrides || []).length}`
  );
  console.log(
    `[Repair] Relationship fileSafety: brokenTargets=${relIntegrity.missingInternalTargets.length}, invalidExternal=${(relIntegrity.invalidExternalTargets || []).length}`
  );
  console.log(
    `[Repair] Package consistency: ${packageIssues.length === 0 ? 'PASS' : packageIssues.join(' | ')}`
  );
  console.log(
    `[Repair] Checker: ${check.valid ? 'PASS' : `FAIL (${check.summary.failed} failed checks)`}`
  );

  if (
    relIntegrity.missingInternalTargets.length > 0 ||
    (relIntegrity.invalidExternalTargets || []).length > 0 ||
    packageIssues.length > 0 ||
    !check.valid
  ) {
    process.exitCode = 1;
  }
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node repair-pptx.js <input.pptx> [output.pptx]');
    process.exit(1);
  }
  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(1);
  }
  const outputArg = process.argv[3];
  const outputPath = outputArg
    ? path.resolve(outputArg)
    : inputPath.replace(/\.pptx$/i, '_repaired.pptx');
  await repair(inputPath, outputPath);
}

main().catch((err) => {
  console.error('Repair failed:', err?.message || err);
  process.exit(1);
});
