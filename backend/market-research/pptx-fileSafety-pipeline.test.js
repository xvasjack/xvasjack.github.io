/**
 * Tests for PPTX FileSafety Pipeline
 */

const JSZip = require('jszip');
const crypto = require('crypto');
const {
  runPipeline,
  getQualityScore,
  InvariantError,
  __stages,
} = require('./pptx-fileSafety-pipeline');

const {
  stage1RelationshipTargetNormalization,
  stage2NonVisualIdNormalization,
  stage3ContentTypesReconciliation,
  stage4RelationshipReferenceFileSafety,
} = __stages;

// ---------------------------------------------------------------------------
// Helpers: Build synthetic PPTX buffers
// ---------------------------------------------------------------------------

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function buildMinimalPptx(overrides = {}) {
  const zip = new JSZip();

  // [Content_Types].xml
  zip.file(
    '[Content_Types].xml',
    overrides.contentTypes ||
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>
`
  );

  // _rels/.rels
  zip.file(
    '_rels/.rels',
    overrides.rootRels ||
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>
`
  );

  // ppt/presentation.xml
  zip.file(
    'ppt/presentation.xml',
    overrides.presentation ||
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
  </p:sldIdLst>
</p:presentation>
`
  );

  // ppt/_rels/presentation.xml.rels
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    overrides.presentationRels ||
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>
`
  );

  // ppt/slides/slide1.xml
  zip.file(
    'ppt/slides/slide1.xml',
    overrides.slide1 ||
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="1" name="Title 1"/>
        </p:nvSpPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Content 2"/>
        </p:nvSpPr>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>
`
  );

  // ppt/slides/_rels/slide1.xml.rels
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    overrides.slide1Rels ||
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>
`
  );

  // Add any extra files
  if (overrides.extraFiles) {
    for (const [name, content] of Object.entries(overrides.extraFiles)) {
      zip.file(name, content);
    }
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PPTX FileSafety Pipeline', () => {
  // Test 1: Clean PPTX passes all stages
  test('clean PPTX passes all pipeline stages', async () => {
    const buffer = await buildMinimalPptx();
    const result = await runPipeline(buffer);

    expect(result.success).toBe(true);
    expect(result.failedStage).toBeNull();
    expect(result.metrics).toHaveLength(4);
    expect(result.metrics[0].stage).toBe('stage1_relationship_target_normalization');
    expect(result.metrics[1].stage).toBe('stage2_nonvisual_id_normalization');
    expect(result.metrics[2].stage).toBe('stage3_content_types_reconciliation');
    expect(result.metrics[3].stage).toBe('stage4_relationship_reference_fileSafety');
  });

  // Test 2: Stage 1 — normalizes absolute relationship targets
  test('stage 1 normalizes absolute targets to relative', async () => {
    const buffer = await buildMinimalPptx({
      presentationRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide1.xml"/>
</Relationships>
`,
    });

    const result = await stage1RelationshipTargetNormalization(buffer);
    expect(result.metrics.stage).toBe('stage1_relationship_target_normalization');
    expect(result.metrics.changed).toBe(true);
    expect(result.metrics.stats.normalizedTargets).toBeGreaterThanOrEqual(1);
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.inputHash).not.toBe(result.metrics.outputHash);
  });

  // Test 3: Stage 2 — deduplicates non-visual IDs within a slide
  test('stage 2 fixes duplicate non-visual shape IDs', async () => {
    const buffer = await buildMinimalPptx({
      slide1: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="1" name="Title 1"/></p:nvSpPr></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="1" name="Duplicate 1"/></p:nvSpPr></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Content 2"/></p:nvSpPr></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Duplicate 2"/></p:nvSpPr></p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>
`,
    });

    const result = await stage2NonVisualIdNormalization(buffer);
    expect(result.metrics.stage).toBe('stage2_nonvisual_id_normalization');
    expect(result.metrics.changed).toBe(true);
    expect(result.metrics.stats.reassignedIds).toBeGreaterThanOrEqual(2);
    expect(result.metrics.stats.postDuplicateIds).toBe(0);
  });

  // Test 4: Stage 3 — reconciles content types
  test('stage 3 adds missing content type overrides', async () => {
    // Create a PPTX with slide2 present but no override for it
    const buffer = await buildMinimalPptx({
      contentTypes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>
`,
      extraFiles: {
        'ppt/slides/slide2.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>`,
      },
    });

    const result = await stage3ContentTypesReconciliation(buffer);
    expect(result.metrics.stage).toBe('stage3_content_types_reconciliation');
    expect(result.metrics.changed).toBe(true);
    expect(result.metrics.stats.diff.addedOverrides).toBeGreaterThanOrEqual(1);
  });

  // Test 5: Stage 3 — removes dangling overrides
  test('stage 3 removes dangling content type overrides', async () => {
    const buffer = await buildMinimalPptx({
      contentTypes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide99.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>
`,
    });

    const result = await stage3ContentTypesReconciliation(buffer);
    expect(result.metrics.changed).toBe(true);
    expect(result.metrics.stats.diff.removedDangling).toBeGreaterThanOrEqual(1);
  });

  // Test 6: Stage 4 — detects dangling relationship references
  test('stage 4 detects dangling r:id references', async () => {
    // Slide XML references rId5 but the .rels file has no such relationship
    const buffer = await buildMinimalPptx({
      slide1: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="1" name="Title"/></p:nvSpPr>
        <p:blipFill><a:blip r:embed="rId5"/></p:blipFill>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>
`,
      slide1Rels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>
`,
    });

    const result = await stage4RelationshipReferenceFileSafety(buffer);
    expect(result.metrics.stage).toBe('stage4_relationship_reference_fileSafety');
    expect(result.metrics.stats.danglingReferences).toBeGreaterThanOrEqual(1);
    expect(result.metrics.passed).toBe(false);
  });

  // Test 7: Idempotency — running pipeline twice produces identical output
  test('pipeline is idempotent', async () => {
    const buffer = await buildMinimalPptx({
      slide1: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="1" name="Title"/></p:nvSpPr></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="1" name="Duplicate"/></p:nvSpPr></p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>
`,
    });

    const result = await runPipeline(buffer, { checkIdempotency: true });
    expect(result.success).toBe(true);
    expect(result.idempotency).toBeTruthy();
    expect(result.idempotency.passed).toBe(true);
    expect(result.idempotency.firstHash).toBe(result.idempotency.secondHash);
  });

  // Test 8: Quality score — clean PPTX gets high score
  test('quality score is 100 for clean PPTX', async () => {
    const buffer = await buildMinimalPptx();
    const score = await getQualityScore(buffer);

    expect(score.score).toBe(100);
    expect(score.issues).toHaveLength(0);
    expect(score.breakdown.criticalParts).toBe(25);
    expect(score.breakdown.relationshipIdUniqueness).toBe(10);
  });

  // Test 9: Quality score — PPTX with issues gets lower score
  test('quality score decreases for PPTX with duplicate IDs', async () => {
    const buffer = await buildMinimalPptx({
      slide1: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="1" name="T1"/></p:nvSpPr></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="1" name="T2"/></p:nvSpPr></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="1" name="T3"/></p:nvSpPr></p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>
`,
    });

    const score = await getQualityScore(buffer);
    expect(score.score).toBeLessThan(100);
    expect(score.issues.length).toBeGreaterThan(0);
  });

  // Test 10: Quality score — empty buffer returns 0
  test('quality score returns 0 for empty buffer', async () => {
    const score = await getQualityScore(Buffer.alloc(0));
    expect(score.score).toBe(0);
    expect(score.issues).toContain('Empty or invalid buffer');
  });

  // Test 11: Pipeline rejects non-buffer input
  test('pipeline throws on non-buffer input', async () => {
    await expect(runPipeline(null)).rejects.toThrow('non-empty Buffer');
    await expect(runPipeline(Buffer.alloc(0))).rejects.toThrow('non-empty Buffer');
  });

  // Test 12: Metrics have correct structure
  test('metrics contain all required fields', async () => {
    const buffer = await buildMinimalPptx();
    const result = await runPipeline(buffer);

    for (const metric of result.metrics) {
      expect(metric).toHaveProperty('stage');
      expect(metric).toHaveProperty('inputHash');
      expect(metric).toHaveProperty('outputHash');
      expect(metric).toHaveProperty('changed');
      expect(metric).toHaveProperty('stats');
      expect(metric).toHaveProperty('durationMs');
      expect(typeof metric.inputHash).toBe('string');
      expect(metric.inputHash).toHaveLength(64); // SHA-256 hex
      expect(typeof metric.durationMs).toBe('number');
    }
  });

  // Test 13: Pipeline handles PPTX with missing [Content_Types].xml
  test('stage 3 handles PPTX with missing Content_Types.xml', async () => {
    const zip = new JSZip();
    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>
`
    );
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"></p:presentation>`
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
    );

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    // Stage 3 should handle gracefully (skipped flag)
    const result = await stage3ContentTypesReconciliation(buffer);
    expect(result.metrics.stage).toBe('stage3_content_types_reconciliation');
    // Should not throw
  });

  // Test 14: Full pipeline with multiple issues fixes them all
  test('full pipeline fixes multiple issues in one pass', async () => {
    const buffer = await buildMinimalPptx({
      // Absolute target that should be normalized
      presentationRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide1.xml"/>
</Relationships>
`,
      // Duplicate non-visual IDs
      slide1: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="1" name="T1"/></p:nvSpPr></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="1" name="T2"/></p:nvSpPr></p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>
`,
      // Dangling override for nonexistent slide
      contentTypes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide50.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>
`,
    });

    const result = await runPipeline(buffer);
    expect(result.success).toBe(true);

    // Stage 1 should have normalized the absolute target
    expect(result.metrics[0].changed).toBe(true);
    // Stage 2 should have fixed duplicate IDs
    expect(result.metrics[1].changed).toBe(true);
    // Stage 3 should have removed dangling override
    expect(result.metrics[2].changed).toBe(true);
  });

  // Test 15: Pipeline totalDurationMs is reasonable
  test('pipeline reports totalDurationMs', async () => {
    const buffer = await buildMinimalPptx();
    const result = await runPipeline(buffer);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.totalDurationMs).toBe('number');
  });

  // Test 16: Stage 1 — no change on already-relative targets
  test('stage 1 reports no change for already-relative targets', async () => {
    const buffer = await buildMinimalPptx();
    const result = await stage1RelationshipTargetNormalization(buffer);
    expect(result.metrics.changed).toBe(false);
    expect(result.metrics.inputHash).toBe(result.metrics.outputHash);
  });

  // Test 17: Quality score breakdown sums correctly
  test('quality score breakdown components are non-negative', async () => {
    const buffer = await buildMinimalPptx();
    const result = await getQualityScore(buffer);
    for (const [key, value] of Object.entries(result.breakdown)) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
