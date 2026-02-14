#!/usr/bin/env node
/**
 * PPTX Integrity Pipeline
 *
 * Staged pipeline that normalizes and validates PPTX files:
 *   Stage 1: Relationship Target Normalization
 *   Stage 2: Non-Visual ID Normalization
 *   Stage 3: Content Types Reconciliation
 *   Stage 4: Relationship Reference Integrity Verification
 *
 * Each stage takes a Buffer in, returns a Buffer out, emits metrics,
 * and has invariant validators that fail loudly if output is worse.
 *
 * Usage: node pptx-integrity-pipeline.js <file.pptx>
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const {
  normalizeAbsoluteRelationshipTargets,
  normalizeSlideNonVisualIds,
  reconcileContentTypesAndPackage,
  scanRelationshipReferenceIntegrity,
  scanRelationshipTargets,
  scanSlideNonVisualIdIntegrity,
  scanPackageConsistency,
  readPPTX,
} = require('./pptx-validator');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

class InvariantError extends Error {
  constructor(stage, message, details) {
    super(`Invariant violation in ${stage}: ${message}`);
    this.name = 'InvariantError';
    this.stage = stage;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Stage 1: Relationship Target Normalization
// ---------------------------------------------------------------------------

async function stage1RelationshipTargetNormalization(inputBuffer) {
  const start = Date.now();
  const inputHash = sha256(inputBuffer);

  // Pre-scan: count broken internal targets before normalization
  const { zip: preZip } = await readPPTX(inputBuffer);
  const preScan = await scanRelationshipTargets(preZip);
  const preBroken = preScan.missingInternalTargets.length;

  // Run normalization
  const result = await normalizeAbsoluteRelationshipTargets(inputBuffer);
  const outputBuffer = result.buffer;
  const outputHash = sha256(outputBuffer);

  // Post-scan: count broken internal targets after normalization
  const { zip: postZip } = await readPPTX(outputBuffer);
  const postScan = await scanRelationshipTargets(postZip);
  const postBroken = postScan.missingInternalTargets.length;

  // Invariant: normalization must not create MORE broken targets
  if (postBroken > preBroken) {
    throw new InvariantError(
      'stage1_relationship_target_normalization',
      'Output has more broken relationship targets than input',
      {
        preBroken,
        postBroken,
      }
    );
  }

  return {
    buffer: outputBuffer,
    metrics: {
      stage: 'stage1_relationship_target_normalization',
      inputHash,
      outputHash,
      changed: result.changed,
      stats: {
        ...result.stats,
        preBrokenTargets: preBroken,
        postBrokenTargets: postBroken,
      },
      durationMs: Date.now() - start,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 2: Non-Visual ID Normalization
// ---------------------------------------------------------------------------

async function stage2NonVisualIdNormalization(inputBuffer) {
  const start = Date.now();
  const inputHash = sha256(inputBuffer);

  // Pre-scan: count duplicate non-visual IDs before normalization
  const { zip: preZip } = await readPPTX(inputBuffer);
  const preScan = await scanSlideNonVisualIdIntegrity(preZip);
  const preDuplicates = preScan.duplicateNonVisualShapeIds.length;

  // Run normalization
  const result = await normalizeSlideNonVisualIds(inputBuffer);
  const outputBuffer = result.buffer;
  const outputHash = sha256(outputBuffer);

  // Post-scan: count duplicate non-visual IDs after normalization
  const { zip: postZip } = await readPPTX(outputBuffer);
  const postScan = await scanSlideNonVisualIdIntegrity(postZip);
  const postDuplicates = postScan.duplicateNonVisualShapeIds.length;

  // Invariant: normalization must not create MORE duplicate IDs
  if (postDuplicates > preDuplicates) {
    throw new InvariantError(
      'stage2_nonvisual_id_normalization',
      'Output has more duplicate non-visual IDs than input',
      {
        preDuplicates,
        postDuplicates,
      }
    );
  }

  return {
    buffer: outputBuffer,
    metrics: {
      stage: 'stage2_nonvisual_id_normalization',
      inputHash,
      outputHash,
      changed: result.changed,
      stats: {
        ...result.stats,
        preDuplicateIds: preDuplicates,
        postDuplicateIds: postDuplicates,
        perSlide: postScan.duplicateNonVisualShapeIds,
      },
      durationMs: Date.now() - start,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 3: Content Types Reconciliation
// ---------------------------------------------------------------------------

async function stage3ContentTypesReconciliation(inputBuffer) {
  const start = Date.now();
  const inputHash = sha256(inputBuffer);

  // Pre-scan: snapshot content types issues
  const { zip: preZip } = await readPPTX(inputBuffer);
  const preConsistency = await scanPackageConsistency(preZip);
  const preIssueCount =
    preConsistency.danglingOverrides.length +
    preConsistency.missingExpectedOverrides.length +
    preConsistency.contentTypeMismatches.length;

  // Run reconciliation
  const result = await reconcileContentTypesAndPackage(inputBuffer);
  const outputBuffer = result.buffer;
  const outputHash = sha256(outputBuffer);

  // Post-scan
  const { zip: postZip } = await readPPTX(outputBuffer);
  const postConsistency = await scanPackageConsistency(postZip);
  const postIssueCount =
    postConsistency.danglingOverrides.length +
    postConsistency.missingExpectedOverrides.length +
    postConsistency.contentTypeMismatches.length;

  // Invariant: reconciliation must not create MORE content type issues
  if (postIssueCount > preIssueCount) {
    throw new InvariantError(
      'stage3_content_types_reconciliation',
      'Output has more content type issues than input',
      {
        preIssueCount,
        postIssueCount,
        postDangling: postConsistency.danglingOverrides,
        postMissing: postConsistency.missingExpectedOverrides,
        postMismatches: postConsistency.contentTypeMismatches,
      }
    );
  }

  return {
    buffer: outputBuffer,
    metrics: {
      stage: 'stage3_content_types_reconciliation',
      inputHash,
      outputHash,
      changed: result.changed,
      stats: {
        ...result.stats,
        preIssueCount,
        postIssueCount,
        diff: {
          removedDangling: (result.stats.removedDangling || []).length,
          addedOverrides: (result.stats.addedOverrides || []).length,
          correctedOverrides: (result.stats.correctedOverrides || []).length,
          dedupedOverrides: (result.stats.dedupedOverrides || []).length,
        },
      },
      durationMs: Date.now() - start,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 4: Relationship Reference Integrity Verification
// ---------------------------------------------------------------------------

async function stage4RelationshipReferenceIntegrity(inputBuffer) {
  const start = Date.now();
  const inputHash = sha256(inputBuffer);

  const { zip } = await readPPTX(inputBuffer);
  const result = await scanRelationshipReferenceIntegrity(zip);

  // This stage is read-only verification — no buffer modification.
  // Invariant: report any dangling references as failures.
  const danglingCount = result.missingRelationshipReferences.length;

  return {
    buffer: inputBuffer,
    metrics: {
      stage: 'stage4_relationship_reference_integrity',
      inputHash,
      outputHash: inputHash,
      changed: false,
      stats: {
        checkedReferences: result.checkedRelationshipReferences,
        danglingReferences: danglingCount,
        details: result.missingRelationshipReferences.slice(0, 20),
      },
      durationMs: Date.now() - start,
      passed: danglingCount === 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Quality Score
// ---------------------------------------------------------------------------

async function getQualityScore(pptxBuffer) {
  if (!Buffer.isBuffer(pptxBuffer) || pptxBuffer.length === 0) {
    return { score: 0, breakdown: {}, issues: ['Empty or invalid buffer'] };
  }

  const { zip } = await readPPTX(pptxBuffer);
  const consistency = await scanPackageConsistency(zip);
  const relTargets = await scanRelationshipTargets(zip);

  // Scoring: start at 100 and subtract for each class of issue.
  let score = 100;
  const breakdown = {};

  // Critical parts (25 points)
  const criticalDeduction = Math.min(25, consistency.missingCriticalParts.length * 25);
  score -= criticalDeduction;
  breakdown.criticalParts = 25 - criticalDeduction;

  // Duplicate relationship IDs (10 points)
  const dupRelDeduction = Math.min(10, consistency.duplicateRelationshipIds.length * 2);
  score -= dupRelDeduction;
  breakdown.relationshipIdUniqueness = 10 - dupRelDeduction;

  // Duplicate slide/rel IDs (10 points)
  const dupSlideDeduction = Math.min(
    10,
    (consistency.duplicateSlideIds.length + consistency.duplicateSlideRelIds.length) * 2
  );
  score -= dupSlideDeduction;
  breakdown.slideIdIntegrity = 10 - dupSlideDeduction;

  // Dangling relationship references (15 points)
  const danglingRefDeduction = Math.min(15, consistency.missingRelationshipReferences.length * 1);
  score -= danglingRefDeduction;
  breakdown.relationshipReferenceIntegrity = 15 - danglingRefDeduction;

  // Non-visual shape ID duplicates (10 points)
  const nvIdDeduction = Math.min(10, consistency.duplicateNonVisualShapeIds.length * 2);
  score -= nvIdDeduction;
  breakdown.nonVisualIdIntegrity = 10 - nvIdDeduction;

  // Content types (15 points)
  const ctIssues =
    consistency.danglingOverrides.length +
    consistency.missingExpectedOverrides.length +
    consistency.contentTypeMismatches.length;
  const ctDeduction = Math.min(15, ctIssues * 1);
  score -= ctDeduction;
  breakdown.contentTypesConsistency = 15 - ctDeduction;

  // Relationship targets (15 points)
  const relDeduction = Math.min(
    15,
    relTargets.missingInternalTargets.length * 2 + relTargets.invalidExternalTargets.length * 1
  );
  score -= relDeduction;
  breakdown.relationshipTargets = 15 - relDeduction;

  score = Math.max(0, Math.min(100, score));

  const issues = [];
  if (consistency.missingCriticalParts.length > 0)
    issues.push(`Missing critical parts: ${consistency.missingCriticalParts.join(', ')}`);
  if (consistency.duplicateRelationshipIds.length > 0)
    issues.push(`${consistency.duplicateRelationshipIds.length} duplicate relationship ID(s)`);
  if (consistency.duplicateSlideIds.length > 0)
    issues.push(`${consistency.duplicateSlideIds.length} duplicate slide ID(s)`);
  if (consistency.missingRelationshipReferences.length > 0)
    issues.push(
      `${consistency.missingRelationshipReferences.length} dangling relationship reference(s)`
    );
  if (consistency.duplicateNonVisualShapeIds.length > 0)
    issues.push(
      `${consistency.duplicateNonVisualShapeIds.length} duplicate non-visual shape ID(s)`
    );
  if (ctIssues > 0) issues.push(`${ctIssues} content type issue(s)`);
  if (relTargets.missingInternalTargets.length > 0)
    issues.push(
      `${relTargets.missingInternalTargets.length} broken internal relationship target(s)`
    );
  if (relTargets.invalidExternalTargets.length > 0)
    issues.push(
      `${relTargets.invalidExternalTargets.length} invalid external relationship target(s)`
    );

  return { score, breakdown, issues };
}

// ---------------------------------------------------------------------------
// Pipeline Runner
// ---------------------------------------------------------------------------

async function runPipeline(inputBuffer, options = {}) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new Error('runPipeline requires a non-empty Buffer');
  }

  const stages = [
    stage1RelationshipTargetNormalization,
    stage2NonVisualIdNormalization,
    stage3ContentTypesReconciliation,
    stage4RelationshipReferenceIntegrity,
  ];

  let currentBuffer = inputBuffer;
  const pipelineMetrics = [];
  const pipelineStart = Date.now();
  let failedStage = null;

  for (const stageFn of stages) {
    try {
      const result = await stageFn(currentBuffer);
      pipelineMetrics.push(result.metrics);
      currentBuffer = result.buffer;
    } catch (err) {
      if (err instanceof InvariantError) {
        failedStage = {
          stage: err.stage,
          message: err.message,
          details: err.details,
        };
        // Block further stages
        break;
      }
      throw err;
    }
  }

  // Idempotency proof: run pipeline again and verify same output hash
  let idempotent = null;
  if (!failedStage && options.checkIdempotency !== false) {
    const secondPassStart = Date.now();
    let secondBuffer = currentBuffer;
    for (const stageFn of stages.slice(0, 3)) {
      // Only run mutation stages (1-3); stage 4 is read-only
      const result = await stageFn(secondBuffer);
      secondBuffer = result.buffer;
    }
    const firstHash = sha256(currentBuffer);
    const secondHash = sha256(secondBuffer);
    idempotent = {
      passed: firstHash === secondHash,
      firstHash,
      secondHash,
      durationMs: Date.now() - secondPassStart,
    };
  }

  // Quality score on final output
  const qualityScore = await getQualityScore(currentBuffer);

  return {
    buffer: currentBuffer,
    success: !failedStage,
    failedStage,
    metrics: pipelineMetrics,
    idempotency: idempotent,
    qualityScore,
    totalDurationMs: Date.now() - pipelineStart,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node pptx-integrity-pipeline.js <file.pptx>');
    process.exit(1);
  }

  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const inputBuffer = fs.readFileSync(resolved);
  const result = await runPipeline(inputBuffer);

  const output = {
    file: resolved,
    success: result.success,
    failedStage: result.failedStage,
    metrics: result.metrics,
    idempotency: result.idempotency,
    qualityScore: result.qualityScore,
    totalDurationMs: result.totalDurationMs,
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(result.success ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  });
}

module.exports = {
  runPipeline,
  getQualityScore,
  InvariantError,
  // Expose individual stages for testing
  __stages: {
    stage1RelationshipTargetNormalization,
    stage2NonVisualIdNormalization,
    stage3ContentTypesReconciliation,
    stage4RelationshipReferenceIntegrity,
  },
};
