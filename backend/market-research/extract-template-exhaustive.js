#!/usr/bin/env node
/**
 * Exhaustive template extractor.
 * Captures the full PPTX package: every part, every relationship, raw XML,
 * binary payloads (base64), content types, hashes, and inventory summaries.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

const DEFAULT_TEMPLATE = path.resolve(
  __dirname,
  '..',
  '..',
  '251219_Escort_Phase 1 Market Selection_V3.pptx'
);
const DEFAULT_OUTPUT = path.resolve(__dirname, 'template-extracted-exhaustive.json');

function parseArgs(argv) {
  const args = { template: DEFAULT_TEMPLATE, out: DEFAULT_OUTPUT, includeBinary: true };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--template' && argv[i + 1]) {
      args.template = path.resolve(argv[++i]);
    } else if (token === '--out' && argv[i + 1]) {
      args.out = path.resolve(argv[++i]);
    } else if (token === '--no-binary') {
      args.includeBinary = false;
    }
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseAttrs(fragment) {
  const attrs = {};
  String(fragment || '').replace(/([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g, (_m, k, v) => {
    attrs[k] = v;
    return _m;
  });
  return attrs;
}

function parseContentTypes(xml) {
  const defaults = {};
  const overrides = {};

  String(xml || '').replace(/<Default\b([^>]*)\/>/g, (_m, attrText) => {
    const attrs = parseAttrs(attrText);
    if (attrs.Extension && attrs.ContentType) {
      defaults[String(attrs.Extension).toLowerCase()] = attrs.ContentType;
    }
    return _m;
  });

  String(xml || '').replace(/<Override\b([^>]*)\/>/g, (_m, attrText) => {
    const attrs = parseAttrs(attrText);
    if (attrs.PartName && attrs.ContentType) {
      overrides[attrs.PartName] = attrs.ContentType;
    }
    return _m;
  });

  return { defaults, overrides };
}

function partKind(partPath) {
  if (partPath.endsWith('.rels')) return 'rels';
  if (partPath.endsWith('.xml')) return 'xml';
  return 'binary';
}

function resolveContentType(partPath, contentTypes) {
  const key = `/${partPath}`;
  if (contentTypes.overrides[key]) return contentTypes.overrides[key];
  const ext = String(path.posix.extname(partPath) || '').replace(/^\./, '').toLowerCase();
  if (!ext) return null;
  return contentTypes.defaults[ext] || null;
}

function relSourceFromPath(relPath) {
  const normalized = String(relPath || '').replace(/^\/+/, '');
  if (normalized === '_rels/.rels') return '/';

  const parent = path.posix.dirname(normalized); // e.g. ppt/slides/_rels
  const ownerDir = parent.endsWith('/_rels') ? parent.slice(0, -6) : parent;
  const relFile = path.posix.basename(normalized); // slide1.xml.rels
  const ownerFile = relFile.endsWith('.rels') ? relFile.slice(0, -5) : relFile;
  if (!ownerDir || ownerDir === '.') return ownerFile;
  return `${ownerDir}/${ownerFile}`;
}

function resolveInternalTarget(sourcePart, target) {
  const cleanTarget = String(target || '').trim();
  if (!cleanTarget) return null;
  if (cleanTarget.startsWith('/')) return cleanTarget.replace(/^\//, '');

  const source = String(sourcePart || '').trim();
  const baseDir = source === '/' ? '' : path.posix.dirname(source);
  const joined = baseDir && baseDir !== '.' ? path.posix.join(baseDir, cleanTarget) : cleanTarget;
  return path.posix.normalize(joined).replace(/^\//, '');
}

function parseRelationships(xml, relPath, existingPartSet) {
  const sourcePart = relSourceFromPath(relPath);
  const rels = [];

  String(xml || '').replace(/<Relationship\b([^>]*)\/>/g, (_m, attrText) => {
    const attrs = parseAttrs(attrText);
    const targetMode = String(attrs.TargetMode || 'Internal');
    const isExternal = /^external$/i.test(targetMode);
    const resolvedTarget = isExternal
      ? String(attrs.Target || '')
      : resolveInternalTarget(sourcePart, attrs.Target || '');

    rels.push({
      relsPath: relPath,
      sourcePart,
      id: attrs.Id || null,
      type: attrs.Type || null,
      target: attrs.Target || null,
      targetMode: targetMode,
      resolvedTarget,
      existsInPackage: isExternal ? null : existingPartSet.has(String(resolvedTarget || '')),
    });
    return _m;
  });

  return rels;
}

function countTag(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s|>)`, 'g');
  const matches = String(xml || '').match(re);
  return matches ? matches.length : 0;
}

function buildSlideInventory(partMap, relationships) {
  const slidePaths = [...partMap.keys()]
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const ai = Number((a.match(/slide(\d+)\.xml/) || [])[1] || 0);
      const bi = Number((b.match(/slide(\d+)\.xml/) || [])[1] || 0);
      return ai - bi;
    });

  return slidePaths.map((slidePath) => {
    const xml = partMap.get(slidePath)?.text || '';
    const rels = relationships.filter((r) => r.sourcePart === slidePath);
    const layoutRel = rels.find((r) => /\/slideLayout$/.test(String(r.type || '')));
    const chartRels = rels.filter((r) => /\/chart$/.test(String(r.type || '')));
    const mediaRels = rels.filter((r) => /\/image$/.test(String(r.type || '')));
    const notesRel = rels.find((r) => /\/notesSlide$/.test(String(r.type || '')));

    return {
      slideNumber: Number((slidePath.match(/slide(\d+)\.xml/) || [])[1] || 0),
      path: slidePath,
      layoutTarget: layoutRel?.resolvedTarget || null,
      notesTarget: notesRel?.resolvedTarget || null,
      chartTargets: chartRels.map((r) => r.resolvedTarget).filter(Boolean),
      imageTargets: mediaRels.map((r) => r.resolvedTarget).filter(Boolean),
      counts: {
        shapes: countTag(xml, 'p:sp'),
        groups: countTag(xml, 'p:grpSp'),
        connectors: countTag(xml, 'p:cxnSp'),
        pictures: countTag(xml, 'p:pic'),
        graphicFrames: countTag(xml, 'p:graphicFrame'),
        tables: countTag(xml, 'a:tbl'),
        charts: countTag(xml, 'c:chart'),
        paragraphs: countTag(xml, 'a:p'),
        runs: countTag(xml, 'a:r'),
      },
    };
  });
}

async function extractExhaustivePackage({ templatePath, outputPath, includeBinary = true }) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template file not found: ${templatePath}`);
  }

  const buffer = fs.readFileSync(templatePath);
  const zip = await JSZip.loadAsync(buffer);
  const partNames = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir)
    .sort();
  const partSet = new Set(partNames);

  const contentTypesXml = await zip.file('[Content_Types].xml').async('string');
  const contentTypes = parseContentTypes(contentTypesXml);

  const parts = [];
  const partMap = new Map();
  for (const partPath of partNames) {
    const file = zip.file(partPath);
    const raw = await file.async('nodebuffer');
    const kind = partKind(partPath);

    const entry = {
      path: partPath,
      kind,
      size: raw.length,
      sha256: sha256(raw),
      contentType: resolveContentType(partPath, contentTypes),
    };

    if (kind === 'xml' || kind === 'rels') {
      entry.text = raw.toString('utf8');
      entry.textLength = entry.text.length;
    } else if (includeBinary) {
      entry.base64 = raw.toString('base64');
      entry.base64Length = entry.base64.length;
    }

    parts.push(entry);
    partMap.set(partPath, entry);
  }

  const relationships = [];
  for (const part of parts) {
    if (part.kind !== 'rels') continue;
    relationships.push(...parseRelationships(part.text, part.path, partSet));
  }

  const slideInventory = buildSlideInventory(partMap, relationships);

  const report = {
    _meta: {
      sourcePptx: path.basename(templatePath),
      sourcePath: templatePath,
      extractedAt: new Date().toISOString(),
      schema: 'template-extracted-exhaustive.v1',
      includeBinaryPayloads: !!includeBinary,
      packageSha256: sha256(buffer),
      packageSize: buffer.length,
      partCount: parts.length,
      relationshipCount: relationships.length,
      slideCount: slideInventory.length,
    },
    package: {
      contentTypes: {
        defaults: contentTypes.defaults,
        overrides: contentTypes.overrides,
        rawXml: contentTypesXml,
      },
      parts,
      relationships,
    },
    inventory: {
      slides: slideInventory,
      charts: [...partMap.keys()]
        .filter((p) => /^ppt\/charts\/chart\d+\.xml$/.test(p))
        .sort(),
      slideLayouts: [...partMap.keys()]
        .filter((p) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(p))
        .sort(),
      slideMasters: [...partMap.keys()]
        .filter((p) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(p))
        .sort(),
      themes: [...partMap.keys()].filter((p) => /^ppt\/theme\/.*\.xml$/.test(p)).sort(),
      media: [...partMap.keys()].filter((p) => /^ppt\/media\//.test(p)).sort(),
      notesSlides: [...partMap.keys()]
        .filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p))
        .sort(),
      notesMasters: [...partMap.keys()]
        .filter((p) => /^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(p))
        .sort(),
    },
    summary: {
      xmlParts: parts.filter((p) => p.kind === 'xml').length,
      relsParts: parts.filter((p) => p.kind === 'rels').length,
      binaryParts: parts.filter((p) => p.kind === 'binary').length,
      missingInternalRelationshipTargets: relationships
        .filter((r) => r.targetMode.toLowerCase() !== 'external')
        .filter((r) => r.existsInPackage === false)
        .map((r) => ({ sourcePart: r.sourcePart, relsPath: r.relsPath, id: r.id, target: r.target })),
    },
  };

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[extract-template-exhaustive] template: ${args.template}`);
  console.log(`[extract-template-exhaustive] output:   ${args.out}`);
  console.log(`[extract-template-exhaustive] includeBinary: ${args.includeBinary}`);

  const report = await extractExhaustivePackage({
    templatePath: args.template,
    outputPath: args.out,
    includeBinary: args.includeBinary,
  });

  console.log(
    `[extract-template-exhaustive] done: slides=${report._meta.slideCount}, parts=${report._meta.partCount}, relationships=${report._meta.relationshipCount}`
  );
  if (report.summary.missingInternalRelationshipTargets.length > 0) {
    console.warn(
      `[extract-template-exhaustive] warning: missing relationship targets=${report.summary.missingInternalRelationshipTargets.length}`
    );
  }
}

main().catch((err) => {
  console.error(`[extract-template-exhaustive] failed: ${err.message}`);
  process.exit(1);
});
