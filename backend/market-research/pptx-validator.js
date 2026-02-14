/**
 * PPTX Validator - Read and validate PPTX files using JSZip
 * Run: node pptx-validator.js <file.pptx> [--validate]
 */
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const CONTENT_TYPE_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CONTENT_TYPE_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const EXPECTED_CONTENT_TYPE_RULES = [
  {
    re: /^ppt\/presentation\.xml$/i,
    contentType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  },
  {
    re: /^ppt\/slides\/slide\d+\.xml$/i,
    contentType: CONTENT_TYPE_SLIDE,
  },
  {
    re: /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  },
  {
    re: /^ppt\/slideMasters\/slideMaster\d+\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  },
  {
    re: /^ppt\/theme\/theme\d+\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.theme+xml',
  },
  {
    re: /^ppt\/notesSlides\/notesSlide\d+\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  },
  {
    re: /^ppt\/notesMasters\/notesMaster\d+\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  },
  {
    re: /^ppt\/handoutMasters\/handoutMaster\d+\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.handoutMaster+xml',
  },
  {
    re: /^ppt\/charts\/chart\d+\.xml$/i,
    contentType: CONTENT_TYPE_CHART,
  },
  {
    re: /^ppt\/charts\/style\d+\.xml$/i,
    contentType: 'application/vnd.ms-office.chartstyle+xml',
  },
  {
    re: /^ppt\/charts\/colors\d+\.xml$/i,
    contentType: 'application/vnd.ms-office.chartcolorstyle+xml',
  },
  {
    re: /^ppt\/tableStyles\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  },
  {
    re: /^ppt\/presProps\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  },
  {
    re: /^ppt\/viewProps\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  },
  {
    re: /^ppt\/commentAuthors\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml',
  },
  {
    re: /^ppt\/embeddings\/.*\.xlsx$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    re: /^ppt\/embeddings\/.*\.xlsm$/i,
    contentType: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  },
  {
    re: /^ppt\/printerSettings\/printerSettings\d+\.bin$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.printerSettings',
  },
  {
    re: /^docProps\/core\.xml$/i,
    contentType: 'application/vnd.openxmlformats-package.core-properties+xml',
  },
  {
    re: /^docProps\/app\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  },
  {
    re: /^docProps\/custom\.xml$/i,
    contentType: 'application/vnd.openxmlformats-officedocument.custom-properties+xml',
  },
];

const EXPECTED_DEFAULT_CONTENT_TYPES = new Map([
  ['rels', 'application/vnd.openxmlformats-package.relationships+xml'],
  ['xml', 'application/xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['bmp', 'image/bmp'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['emf', 'image/x-emf'],
  ['wmf', 'image/x-wmf'],
  ['svg', 'image/svg+xml'],
  ['bin', 'application/vnd.openxmlformats-officedocument.oleObject'],
]);

function getExpectedContentTypeForPart(partName) {
  const normalized = String(partName || '').replace(/^\/+/, '');
  if (!normalized) return null;
  for (const rule of EXPECTED_CONTENT_TYPE_RULES) {
    if (rule.re.test(normalized)) return rule.contentType;
  }
  return null;
}

function getExpectedDefaultContentTypeForExtension(ext) {
  const normalized = String(ext || '')
    .replace(/^\./, '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return EXPECTED_DEFAULT_CONTENT_TYPES.get(normalized) || null;
}

function sameContentType(a, b) {
  return (
    String(a || '')
      .trim()
      .toLowerCase() ===
    String(b || '')
      .trim()
      .toLowerCase()
  );
}

async function readPPTX(input) {
  const buffer = typeof input === 'string' ? fs.readFileSync(input) : input;
  return { zip: await JSZip.loadAsync(buffer), fileSize: buffer.length };
}

function findInvalidXmlCharIndex(text) {
  if (typeof text !== 'string' || text.length === 0) return -1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    // Invalid XML 1.0 control chars (allow tab/newline/carriage return).
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      return i;
    }

    // Unpaired high surrogate.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return i;
      i++; // Skip valid surrogate pair.
      continue;
    }

    // Unpaired low surrogate.
    if (code >= 0xdc00 && code <= 0xdfff) {
      return i;
    }
  }
  return -1;
}

async function scanXmlIntegrity(zip) {
  const xmlFiles = Object.keys(zip.files).filter((f) => /\.xml$/i.test(f));
  const issues = [];

  for (const filePath of xmlFiles) {
    const file = zip.file(filePath);
    if (!file) continue;
    const xml = await file.async('string');
    const badIdx = findInvalidXmlCharIndex(xml);
    if (badIdx >= 0) {
      issues.push({ file: filePath, index: badIdx });
      if (issues.length >= 25) break;
    }
  }

  return { issueCount: issues.length, issues };
}

function decodeXmlAttr(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function ownerPartFromRelPath(relFile) {
  const normalized = String(relFile || '');
  if (normalized === '_rels/.rels') return '';
  const match = normalized.match(/^(.*)\/_rels\/([^/]+)\.rels$/);
  if (!match) return '';
  const baseDir = match[1];
  const ownerPart = match[2];
  return baseDir ? `${baseDir}/${ownerPart}` : ownerPart;
}

function resolveRelationshipTarget(ownerDir, target) {
  if (!target) return '';
  if (target.startsWith('/')) return path.posix.normalize(target.replace(/^\/+/, ''));
  return path.posix.normalize(ownerDir ? path.posix.join(ownerDir, target) : target);
}

function hasAsciiControlChars(value) {
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}

function isValidExternalRelationshipTarget(rawTarget) {
  const target = String(rawTarget || '').trim();
  if (!target) return { valid: false, reason: 'empty_target' };
  if (hasAsciiControlChars(target)) {
    return { valid: false, reason: 'control_chars' };
  }
  if (/\s/.test(target)) {
    return { valid: false, reason: 'contains_whitespace' };
  }
  try {
    const parsed = new URL(target);
    const protocol = String(parsed.protocol || '').toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') {
      return { valid: false, reason: `unsupported_scheme:${protocol || 'none'}` };
    }
    if ((protocol === 'http:' || protocol === 'https:') && !parsed.hostname) {
      return { valid: false, reason: 'missing_hostname' };
    }
    return { valid: true, reason: '' };
  } catch {
    return { valid: false, reason: 'invalid_url' };
  }
}

async function scanRelationshipTargets(zip) {
  const relFiles = Object.keys(zip.files).filter((f) => /\.rels$/i.test(f));
  const missingInternalTargets = [];
  const invalidExternalTargets = [];
  let checkedInternal = 0;
  let checkedExternal = 0;

  for (const relFile of relFiles) {
    const relEntry = zip.file(relFile);
    if (!relEntry) continue;
    const xml = await relEntry.async('string');
    const ownerPart = ownerPartFromRelPath(relFile);
    const ownerDir = ownerPart ? path.posix.dirname(ownerPart) : '';

    const relationshipMatches = xml.matchAll(/<Relationship\b[^>]*>/g);
    for (const match of relationshipMatches) {
      const tag = match[0];
      const targetMatch = tag.match(/\bTarget=(["'])(.*?)\1/);
      if (!targetMatch) continue;
      const targetModeMatch = tag.match(/\bTargetMode=(["'])(.*?)\1/i);
      const targetMode = String(targetModeMatch?.[2] || '').toLowerCase();
      const rawTarget = decodeXmlAttr(targetMatch[2]).trim();
      if (targetMode === 'external') {
        checkedExternal++;
        const validation = isValidExternalRelationshipTarget(rawTarget);
        if (!validation.valid) {
          invalidExternalTargets.push({
            relFile,
            target: rawTarget,
            reason: validation.reason,
          });
        }
        continue;
      }

      if (!rawTarget || rawTarget.startsWith('#')) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;

      const targetPathOnly = rawTarget.split('#')[0].split('?')[0];
      const resolvedTarget = resolveRelationshipTarget(ownerDir, targetPathOnly);
      checkedInternal++;

      if (!resolvedTarget || resolvedTarget.startsWith('../')) {
        missingInternalTargets.push({
          relFile,
          target: rawTarget,
          resolvedTarget,
          reason: 'outside_package',
        });
        continue;
      }

      if (!zip.file(resolvedTarget)) {
        missingInternalTargets.push({
          relFile,
          target: rawTarget,
          resolvedTarget,
          reason: 'missing_part',
        });
      }
    }
  }

  return { checkedInternal, checkedExternal, missingInternalTargets, invalidExternalTargets };
}

// Normalize absolute internal relationship targets (Target="/ppt/...") into
// owner-relative paths to keep package relationships canonical across clients.
async function normalizeAbsoluteRelationshipTargets(pptxBuffer) {
  if (!Buffer.isBuffer(pptxBuffer) || pptxBuffer.length === 0) {
    return {
      buffer: pptxBuffer,
      changed: false,
      stats: { normalizedTargets: 0, filesChanged: 0 },
    };
  }

  const zip = await JSZip.loadAsync(pptxBuffer);
  const relFiles = Object.keys(zip.files).filter((name) => /\.rels$/i.test(name));
  let normalizedTargets = 0;
  let filesChanged = 0;

  for (const relFile of relFiles) {
    const relEntry = zip.file(relFile);
    if (!relEntry) continue;
    const xml = await relEntry.async('string');
    const ownerPart = ownerPartFromRelPath(relFile);
    const ownerDir = ownerPart ? path.posix.dirname(ownerPart) : '';

    const nextXml = xml.replace(/Target=(["'])\/ppt\/([^"']+)\1/g, (full, quote, absolutePath) => {
      const packageTarget = `ppt/${absolutePath}`;
      const relative = ownerDir ? path.posix.relative(ownerDir, packageTarget) : packageTarget;
      const normalized = path.posix.normalize(String(relative || '')).replace(/\\/g, '/');
      if (!normalized) return full;
      normalizedTargets++;
      return `Target=${quote}${normalized}${quote}`;
    });

    if (nextXml !== xml) {
      zip.file(relFile, nextXml);
      filesChanged++;
    }
  }

  if (filesChanged === 0) {
    return {
      buffer: pptxBuffer,
      changed: false,
      stats: { normalizedTargets: 0, filesChanged: 0 },
    };
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    buffer,
    changed: true,
    stats: { normalizedTargets, filesChanged },
  };
}

async function scanRelationshipReferenceIntegrity(zip) {
  const relFiles = Object.keys(zip.files).filter((f) => /\.rels$/i.test(f));
  const missingRelationshipReferences = [];
  let checkedRelationshipReferences = 0;

  for (const relFile of relFiles) {
    const ownerPart = ownerPartFromRelPath(relFile);
    if (!ownerPart || !/\.xml$/i.test(ownerPart)) continue;

    const relEntry = zip.file(relFile);
    const ownerEntry = zip.file(ownerPart);
    if (!relEntry || !ownerEntry) continue;

    const relXml = await relEntry.async('string');
    const ownerXml = await ownerEntry.async('string');
    const relIds = new Set();

    for (const match of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = extractXmlAttr(match[0], 'Id');
      if (id) relIds.add(id);
    }
    if (relIds.size === 0) continue;

    for (const match of ownerXml.matchAll(/\br:(?:id|embed|link|href)=(["'])(.*?)\1/gi)) {
      const relId = decodeXmlAttr(match[2]).trim();
      if (!relId) continue;
      checkedRelationshipReferences++;
      if (!relIds.has(relId)) {
        missingRelationshipReferences.push({
          ownerPart,
          relFile,
          relId,
        });
      }
    }
  }

  return { checkedRelationshipReferences, missingRelationshipReferences };
}

async function scanSlideNonVisualIdIntegrity(zip) {
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
    .sort((a, b) => {
      const ai = Number((a.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      const bi = Number((b.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      return ai - bi;
    });
  const duplicateNonVisualShapeIds = [];

  for (const slideFile of slideFiles) {
    const slideEntry = zip.file(slideFile);
    if (!slideEntry) continue;
    const xml = await slideEntry.async('string');
    const idCounts = new Map();
    for (const match of xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/gi)) {
      const id = String(match[1] || '').trim();
      if (!id) continue;
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
    }
    for (const [id, count] of idCounts.entries()) {
      if (count <= 1) continue;
      duplicateNonVisualShapeIds.push({
        slide: slideFile.replace(/^ppt\/slides\//i, ''),
        id,
        count,
      });
    }
  }

  return { checkedSlides: slideFiles.length, duplicateNonVisualShapeIds };
}

async function normalizeSlideNonVisualIds(pptxBuffer) {
  if (!Buffer.isBuffer(pptxBuffer) || pptxBuffer.length === 0) {
    return { buffer: pptxBuffer, changed: false, stats: { skipped: true } };
  }

  const zip = await JSZip.loadAsync(pptxBuffer);
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
    .sort((a, b) => {
      const ai = Number((a.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      const bi = Number((b.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      return ai - bi;
    });

  const stats = {
    slidesScanned: slideFiles.length,
    slidesAdjusted: 0,
    reassignedIds: 0,
  };
  let changed = false;

  for (const slideFile of slideFiles) {
    const slideEntry = zip.file(slideFile);
    if (!slideEntry) continue;
    const xml = await slideEntry.async('string');
    if (!xml.includes('<p:cNvPr')) continue;

    let maxExistingId = 1;
    for (const match of xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/gi)) {
      const idNum = Number.parseInt(match[1], 10);
      if (Number.isFinite(idNum) && idNum > maxExistingId) maxExistingId = idNum;
    }

    const seen = new Set();
    let reassignedOnSlide = 0;
    const updated = xml.replace(/<p:cNvPr\b[^>]*>/gi, (tag) => {
      const idMatch = tag.match(/\bid="(\d+)"/i);
      if (!idMatch) return tag;
      const originalId = String(idMatch[1]);
      let resolvedId = originalId;

      if (seen.has(resolvedId)) {
        do {
          maxExistingId += 1;
          resolvedId = String(maxExistingId);
        } while (seen.has(resolvedId));
        reassignedOnSlide++;
      }

      seen.add(resolvedId);
      if (resolvedId === originalId) return tag;
      return tag.replace(/\bid="(\d+)"/i, `id="${resolvedId}"`);
    });

    if (updated !== xml) {
      zip.file(slideFile, updated);
      changed = true;
      stats.slidesAdjusted += 1;
      stats.reassignedIds += reassignedOnSlide;
    }
  }

  if (!changed) return { buffer: pptxBuffer, changed: false, stats };
  return {
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    changed: true,
    stats,
  };
}

function extractXmlAttr(tag, attrName) {
  const re = new RegExp(`\\b${attrName}=(["'])(.*?)\\1`, 'i');
  const m = tag.match(re);
  return m ? decodeXmlAttr(m[2]).trim() : '';
}

function escapeXmlAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}

function parseContentTypesXml(xml) {
  const contentXml = String(xml || '');
  const xmlDecl = (contentXml.match(/^\s*<\?xml[^>]*\?>/i) || [])[0] || '';
  const typesOpen =
    (contentXml.match(/<Types\b[^>]*>/i) || [])[0] ||
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">';
  const defaults = [];
  const defaultByExtension = new Map();
  for (const match of contentXml.matchAll(/<Default\b[^>]*\/>/gi)) {
    const tag = match[0].trim();
    defaults.push(tag);
    const extension = extractXmlAttr(tag, 'Extension').replace(/^\./, '').toLowerCase();
    const contentType = extractXmlAttr(tag, 'ContentType');
    if (extension && contentType) defaultByExtension.set(extension, contentType);
  }
  const overrides = [];
  for (const match of contentXml.matchAll(
    /<Override\b[^>]*\/>|<Override\b[^>]*>[\s\S]*?<\/Override>/gi
  )) {
    const tag = (match && match[0]) || '';
    const partName = extractXmlAttr(tag, 'PartName').replace(/^\/+/, '');
    const contentType = extractXmlAttr(tag, 'ContentType');
    if (!partName) continue;
    overrides.push({ partName, contentType });
  }
  return {
    xmlDecl,
    typesOpen,
    defaults,
    defaultByExtension,
    overrides,
    newline: contentXml.includes('\r\n') ? '\r\n' : '\n',
  };
}

function buildContentTypesXml(parsed, overrideMap) {
  const out = [];
  const newline = parsed.newline || '\n';
  if (parsed.xmlDecl) out.push(parsed.xmlDecl.trim());
  out.push(parsed.typesOpen.trim());

  for (const tag of parsed.defaults || []) {
    out.push(`  ${tag.trim()}`);
  }

  const sortedOverrides = Array.from(overrideMap.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  for (const [partName, contentType] of sortedOverrides) {
    out.push(
      `  <Override PartName="/${escapeXmlAttr(partName)}" ContentType="${escapeXmlAttr(contentType)}"/>`
    );
  }

  out.push('</Types>');
  return `${out.join(newline)}${newline}`;
}

async function reconcileContentTypesAndPackage(pptxBuffer) {
  if (!Buffer.isBuffer(pptxBuffer) || pptxBuffer.length === 0) {
    return { buffer: pptxBuffer, changed: false, stats: { skipped: true } };
  }
  const zip = await JSZip.loadAsync(pptxBuffer);
  const contentTypesEntry = zip.file('[Content_Types].xml');
  if (!contentTypesEntry) {
    return {
      buffer: pptxBuffer,
      changed: false,
      stats: { skipped: true, reason: 'missing_[Content_Types].xml' },
    };
  }

  const rawXml = await contentTypesEntry.async('string');
  const parsed = parseContentTypesXml(rawXml);
  const defaultByExtension = new Map(parsed.defaultByExtension || []);
  const defaults = Array.isArray(parsed.defaults) ? [...parsed.defaults] : [];
  const stats = {
    addedDefaults: [],
    correctedDefaults: [],
    removedDangling: [],
    addedOverrides: [],
    correctedOverrides: [],
    dedupedOverrides: [],
  };
  let changed = false;

  const overrideMap = new Map();
  for (const { partName, contentType } of parsed.overrides) {
    if (!partName) continue;
    if (overrideMap.has(partName)) stats.dedupedOverrides.push(partName);
    overrideMap.set(partName, contentType || '');
  }

  const packageParts = new Set(Object.keys(zip.files).filter((name) => !zip.files[name].dir));

  const ensureDefault = (extension, contentType) => {
    const ext = String(extension || '')
      .replace(/^\./, '')
      .trim()
      .toLowerCase();
    if (!ext || !contentType) return;
    const existing = defaultByExtension.get(ext);
    if (existing && sameContentType(existing, contentType)) return;
    const rebuiltTag = `<Default Extension="${escapeXmlAttr(ext)}" ContentType="${escapeXmlAttr(contentType)}"/>`;
    if (!existing) {
      defaults.push(rebuiltTag);
      defaultByExtension.set(ext, contentType);
      stats.addedDefaults.push(ext);
      changed = true;
      return;
    }
    let replaced = false;
    for (let i = 0; i < defaults.length; i++) {
      const candidate = defaults[i];
      const candidateExt = extractXmlAttr(candidate, 'Extension').replace(/^\./, '').toLowerCase();
      if (candidateExt !== ext) continue;
      defaults[i] = rebuiltTag;
      replaced = true;
      break;
    }
    if (!replaced) defaults.push(rebuiltTag);
    defaultByExtension.set(ext, contentType);
    stats.correctedDefaults.push(ext);
    changed = true;
  };

  for (const partName of Array.from(overrideMap.keys())) {
    if (!packageParts.has(partName)) {
      overrideMap.delete(partName);
      stats.removedDangling.push(partName);
      changed = true;
    }
  }

  for (const partName of Array.from(packageParts)) {
    const extension = path.posix.extname(partName).replace(/^\./, '').toLowerCase();
    const expectedDefaultContentType = getExpectedDefaultContentTypeForExtension(extension);
    if (expectedDefaultContentType) {
      ensureDefault(extension, expectedDefaultContentType);
    }

    const expected = getExpectedContentTypeForPart(partName);
    if (!expected) continue;

    const existing = overrideMap.get(partName);
    if (!existing) {
      overrideMap.set(partName, expected);
      stats.addedOverrides.push(partName);
      changed = true;
      continue;
    }
    if (!sameContentType(existing, expected)) {
      overrideMap.set(partName, expected);
      stats.correctedOverrides.push(partName);
      changed = true;
    }
  }

  const rebuiltXml = buildContentTypesXml({ ...parsed, defaults }, overrideMap);
  if (rebuiltXml !== rawXml) {
    zip.file('[Content_Types].xml', rebuiltXml);
    changed = true;
  }

  if (!changed) return { buffer: pptxBuffer, changed: false, stats };
  return {
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    changed: true,
    stats,
  };
}

async function scanPackageConsistency(zip) {
  const criticalParts = [
    '[Content_Types].xml',
    '_rels/.rels',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
  ];
  const missingCriticalParts = criticalParts.filter((part) => !zip.file(part));

  const duplicateRelationshipIds = [];
  const relFiles = Object.keys(zip.files).filter((f) => /\.rels$/i.test(f));
  for (const relFile of relFiles) {
    const relEntry = zip.file(relFile);
    if (!relEntry) continue;
    const xml = await relEntry.async('string');
    const seen = new Set();
    for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = match[0];
      const relId = extractXmlAttr(tag, 'Id');
      if (!relId) continue;
      if (seen.has(relId)) {
        duplicateRelationshipIds.push({ relFile, relId });
        continue;
      }
      seen.add(relId);
    }
  }

  const duplicateSlideIds = [];
  const duplicateSlideRelIds = [];
  const relationshipReferenceIntegrity = await scanRelationshipReferenceIntegrity(zip);
  const presentationEntry = zip.file('ppt/presentation.xml');
  if (presentationEntry) {
    const xml = await presentationEntry.async('string');
    const seenSlideIds = new Set();
    const seenRelIds = new Set();
    for (const match of xml.matchAll(/<p:sldId\b[^>]*>/g)) {
      const tag = match[0];
      const slideId = extractXmlAttr(tag, 'id');
      const relId = extractXmlAttr(tag, 'r:id');

      if (slideId) {
        if (seenSlideIds.has(slideId)) duplicateSlideIds.push(slideId);
        else seenSlideIds.add(slideId);
      }
      if (relId) {
        if (seenRelIds.has(relId)) duplicateSlideRelIds.push(relId);
        else seenRelIds.add(relId);
      }
    }
  }

  const danglingOverrides = [];
  const missingSlideOverrides = [];
  const missingChartOverrides = [];
  const missingExpectedOverrides = [];
  const contentTypeMismatches = [];
  const nonVisualIdIntegrity = await scanSlideNonVisualIdIntegrity(zip);
  const contentTypesEntry = zip.file('[Content_Types].xml');
  if (contentTypesEntry) {
    const xml = await contentTypesEntry.async('string');
    const parsed = parseContentTypesXml(xml);
    const overrides = new Map(parsed.overrides.map((x) => [x.partName, x.contentType]));
    const defaultByExtension = parsed.defaultByExtension || new Map();

    for (const [partName] of overrides.entries()) {
      if (!zip.file(partName)) {
        danglingOverrides.push(partName);
      }
    }

    const packageParts = Object.keys(zip.files).filter((f) => !zip.files[f].dir);
    for (const partName of packageParts) {
      const expectedContentType = getExpectedContentTypeForPart(partName);
      if (!expectedContentType) continue;

      const hasOverride = overrides.has(partName);
      const overrideContentType = hasOverride ? overrides.get(partName) || '' : '';
      if (!hasOverride) {
        const extension = path.posix.extname(partName).replace(/^\./, '').toLowerCase();
        const defaultContentType = defaultByExtension.get(extension) || '';
        if (defaultContentType && sameContentType(defaultContentType, expectedContentType)) {
          continue;
        }
        missingExpectedOverrides.push({ part: partName, expectedContentType });
        if (/^ppt\/slides\/slide\d+\.xml$/i.test(partName)) {
          missingSlideOverrides.push(partName);
        }
        if (/^ppt\/charts\/chart\d+\.xml$/i.test(partName)) {
          missingChartOverrides.push(partName);
        }
        continue;
      }

      if (!sameContentType(overrideContentType, expectedContentType)) {
        contentTypeMismatches.push({
          part: partName,
          contentType: overrideContentType,
          expectedContentType,
        });
      }
    }
  }

  return {
    missingCriticalParts,
    duplicateRelationshipIds,
    duplicateSlideIds,
    duplicateSlideRelIds,
    duplicateNonVisualShapeIds: nonVisualIdIntegrity.duplicateNonVisualShapeIds,
    slidesCheckedForNonVisualShapeIds: nonVisualIdIntegrity.checkedSlides,
    danglingOverrides,
    missingSlideOverrides,
    missingChartOverrides,
    missingExpectedOverrides,
    contentTypeMismatches,
    checkedRelationshipReferences: relationshipReferenceIntegrity.checkedRelationshipReferences,
    missingRelationshipReferences: relationshipReferenceIntegrity.missingRelationshipReferences,
  };
}

function countSlides(zip) {
  return Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length;
}

function extractTextFromXML(xml) {
  return (xml.match(/<a:t>([^<]*)<\/a:t>/g) || [])
    .map((m) => (m.match(/<a:t>([^<]*)<\/a:t>/) || [])[1]?.trim())
    .filter(Boolean);
}

async function extractSlideText(zip, slideNum) {
  const file = zip.file(`ppt/slides/slide${slideNum}.xml`);
  if (!file) return { slideNum, exists: false, texts: [], fullText: '', charCount: 0 };
  const texts = extractTextFromXML(await file.async('string'));
  return {
    slideNum,
    exists: true,
    texts,
    fullText: texts.join(' '),
    charCount: texts.join('').length,
  };
}

async function extractAllText(zip) {
  const slides = await Promise.all(
    Array.from({ length: countSlides(zip) }, (_, i) => extractSlideText(zip, i + 1))
  );
  return {
    slideCount: slides.length,
    slides,
    totalCharCount: slides.reduce((s, x) => s + x.charCount, 0),
  };
}

function scanSuspiciousEllipsis(textData) {
  const suspiciousHits = [];
  let ellipsisCount = 0;

  for (const slide of textData?.slides || []) {
    for (const rawText of slide?.texts || []) {
      const text = String(rawText || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      if (!/(?:\.\.\.|…)$/.test(text)) continue;

      ellipsisCount++;
      const stem = text.replace(/(?:\.\.\.|…)$/, '').trim();
      if (!stem) continue;
      const lastToken = (stem.split(/\s+/).pop() || '').trim();
      const hasStrongEnding = /[.!?:;)]$/.test(stem);
      const numericLike = /^[\d%+/$(),.-]+$/.test(lastToken);
      const abbreviationLike = /^(etc|approx|est|avg|min|max)$/i.test(lastToken);

      if (!hasStrongEnding && !numericLike && !abbreviationLike && lastToken.length >= 4) {
        suspiciousHits.push({
          slide: slide.slideNum,
          text: text.substring(0, 180),
        });
      }
    }
  }

  return {
    ellipsisCount,
    suspiciousCount: suspiciousHits.length,
    suspiciousHits,
  };
}

async function countCharts(zip) {
  const chartFiles = Object.keys(zip.files).filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f));
  return { chartFiles: chartFiles.length, chartFilesList: chartFiles };
}

async function countTables(zip) {
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort();
  const tables = [];
  for (const sf of slideFiles) {
    const content = await zip.file(sf).async('string');
    const tableCount = (content.match(/<a:tbl[^>]*>/g) || []).length;
    const rowCount = (content.match(/<a:tr[^>]*>/g) || []).length;
    const colCount = (content.match(/<a:tc[^>]*>/g) || []).length;
    if (tableCount > 0) {
      tables.push({ slide: parseInt(sf.match(/slide(\d+)/)[1]), tableCount, rowCount, colCount });
    }
  }
  return { totalTables: tables.reduce((s, t) => s + t.tableCount, 0), tablesBySlide: tables };
}

async function findText(zip, searchText) {
  const textData = await extractAllText(zip);
  const searchLower = searchText.toLowerCase();
  const matches = textData.slides
    .filter((s) => s.fullText.toLowerCase().includes(searchLower))
    .map((s) => ({ slide: s.slideNum, context: s.fullText.substring(0, 200) }));
  return { found: matches.length > 0, matchCount: matches.length, matches };
}

async function countImages(zip) {
  const imageFiles = Object.keys(zip.files).filter((f) =>
    /^ppt\/media\/(image|picture)\d+\.(png|jpg|jpeg|gif|svg)$/i.test(f)
  );
  return { imageCount: imageFiles.length, imageFiles };
}

async function validatePPTX(input, exp = {}) {
  const results = { passed: [], failed: [], warnings: [] };
  const pass = (check, msg) => results.passed.push({ check, message: msg });
  const fail = (check, expected, actual) => results.failed.push({ check, expected, actual });
  const warn = (check, msg) => results.warnings.push({ check, message: msg });

  try {
    const { zip, fileSize } = await readPPTX(input);
    pass('File integrity', 'PPTX parsed successfully');

    const xmlIntegrity = await scanXmlIntegrity(zip);
    if (xmlIntegrity.issueCount > 0) {
      fail(
        'XML character integrity',
        'No invalid XML chars or unpaired surrogates',
        `${xmlIntegrity.issueCount} issue(s), e.g. ${xmlIntegrity.issues
          .slice(0, 3)
          .map((x) => `${x.file}@${x.index}`)
          .join(', ')}`
      );
    } else {
      pass('XML character integrity', 'No invalid characters found');
    }

    const relIntegrity = await scanRelationshipTargets(zip);
    if (relIntegrity.missingInternalTargets.length > 0) {
      const examples = relIntegrity.missingInternalTargets
        .slice(0, 3)
        .map((x) => `${x.relFile}: ${x.target} -> ${x.resolvedTarget || '(empty)'}`)
        .join('; ');
      fail(
        'Relationship target integrity',
        'All internal .rels targets resolve to existing package parts',
        `${relIntegrity.missingInternalTargets.length} broken internal target(s), e.g. ${examples}`
      );
    } else {
      pass(
        'Relationship target integrity',
        `${relIntegrity.checkedInternal} internal targets resolved`
      );
    }
    if (relIntegrity.invalidExternalTargets.length > 0) {
      const examples = relIntegrity.invalidExternalTargets
        .slice(0, 3)
        .map((x) => `${x.relFile}: ${x.target || '(empty)'} (${x.reason})`)
        .join('; ');
      fail(
        'External relationship target integrity',
        'External targets are valid absolute URLs (http/https/mailto) with no whitespace',
        `${relIntegrity.invalidExternalTargets.length} invalid external target(s), e.g. ${examples}`
      );
    } else {
      pass(
        'External relationship target integrity',
        `${relIntegrity.checkedExternal} external targets validated`
      );
    }

    const packageConsistency = await scanPackageConsistency(zip);
    if (packageConsistency.missingCriticalParts.length > 0) {
      fail(
        'Package critical parts',
        'All required core parts are present',
        packageConsistency.missingCriticalParts.join(', ')
      );
    } else {
      pass('Package critical parts', 'Core package parts present');
    }

    if (packageConsistency.duplicateRelationshipIds.length > 0) {
      const examples = packageConsistency.duplicateRelationshipIds
        .slice(0, 3)
        .map((x) => `${x.relFile}:${x.relId}`)
        .join(', ');
      fail(
        'Relationship Id uniqueness',
        'No duplicate relationship Ids within a .rels file',
        examples
      );
    } else {
      pass('Relationship Id uniqueness', 'No duplicate relationship Ids detected');
    }

    if (
      packageConsistency.duplicateSlideIds.length > 0 ||
      packageConsistency.duplicateSlideRelIds.length > 0
    ) {
      const parts = [];
      if (packageConsistency.duplicateSlideIds.length > 0) {
        parts.push(
          `duplicate slide id(s): ${packageConsistency.duplicateSlideIds.slice(0, 5).join(', ')}`
        );
      }
      if (packageConsistency.duplicateSlideRelIds.length > 0) {
        parts.push(
          `duplicate slide rel id(s): ${packageConsistency.duplicateSlideRelIds.slice(0, 5).join(', ')}`
        );
      }
      fail(
        'Presentation slide ID integrity',
        'Unique p:sldId id and r:id entries',
        parts.join(' | ')
      );
    } else {
      pass('Presentation slide ID integrity', 'Slide IDs and relationship IDs are unique');
    }

    if (packageConsistency.missingRelationshipReferences.length > 0) {
      const examples = packageConsistency.missingRelationshipReferences
        .slice(0, 5)
        .map((x) => `${x.ownerPart}:${x.relId}`)
        .join(', ');
      fail(
        'Relationship reference integrity',
        'Every r:id/r:embed/r:link/r:href resolves within owner .rels file',
        `${packageConsistency.missingRelationshipReferences.length} dangling reference(s), e.g. ${examples}`
      );
    } else {
      pass(
        'Relationship reference integrity',
        `${packageConsistency.checkedRelationshipReferences || 0} XML relationship references resolved`
      );
    }

    if (packageConsistency.duplicateNonVisualShapeIds.length > 0) {
      const examples = packageConsistency.duplicateNonVisualShapeIds
        .slice(0, 5)
        .map((x) => `${x.slide}:id=${x.id} (x${x.count})`)
        .join(', ');
      fail('Slide non-visual shape ID integrity', 'Unique p:cNvPr id values per slide', examples);
    } else {
      pass(
        'Slide non-visual shape ID integrity',
        `No duplicate p:cNvPr ids across ${packageConsistency.slidesCheckedForNonVisualShapeIds || 0} slide(s)`
      );
    }

    if (
      packageConsistency.danglingOverrides.length > 0 ||
      packageConsistency.missingSlideOverrides.length > 0 ||
      packageConsistency.missingChartOverrides.length > 0 ||
      packageConsistency.missingExpectedOverrides.length > 0 ||
      packageConsistency.contentTypeMismatches.length > 0
    ) {
      const details = [];
      if (packageConsistency.danglingOverrides.length > 0) {
        details.push(
          `dangling overrides: ${packageConsistency.danglingOverrides.slice(0, 5).join(', ')}`
        );
      }
      if (packageConsistency.missingSlideOverrides.length > 0) {
        details.push(
          `missing slide overrides: ${packageConsistency.missingSlideOverrides.slice(0, 5).join(', ')}`
        );
      }
      if (packageConsistency.missingChartOverrides.length > 0) {
        details.push(
          `missing chart overrides: ${packageConsistency.missingChartOverrides.slice(0, 5).join(', ')}`
        );
      }
      if (packageConsistency.missingExpectedOverrides.length > 0) {
        details.push(
          `missing expected overrides: ${packageConsistency.missingExpectedOverrides
            .slice(0, 5)
            .map((x) => `${x.part}->${x.expectedContentType}`)
            .join(', ')}`
        );
      }
      if (packageConsistency.contentTypeMismatches.length > 0) {
        details.push(
          `content type mismatches: ${packageConsistency.contentTypeMismatches
            .slice(0, 5)
            .map((x) => `${x.part}:${x.contentType || '(empty)'}=>${x.expectedContentType}`)
            .join(', ')}`
        );
      }
      fail(
        'Content types consistency',
        'No dangling/missing overrides and all expected package parts have correct content types',
        details.join(' | ')
      );
    } else {
      pass('Content types consistency', 'Overrides align with expected package parts');
    }

    const minSize = exp.minFileSize || 50 * 1024,
      maxSize = exp.maxFileSize || 3 * 1024 * 1024;
    if (fileSize < minSize)
      fail('File size', `>= ${(minSize / 1024).toFixed(0)}KB`, `${(fileSize / 1024).toFixed(1)}KB`);
    else if (fileSize > maxSize)
      warn('File size', `${(fileSize / 1024 / 1024).toFixed(1)}MB (large)`);
    else pass('File size', `${(fileSize / 1024).toFixed(1)}KB`);

    const slideCount = countSlides(zip);
    if (exp.minSlides && slideCount < exp.minSlides)
      fail('Slide count', `>= ${exp.minSlides}`, slideCount);
    else pass('Slide count', `${slideCount} slides`);

    if (exp.titleContains) {
      const s1 = await extractSlideText(zip, 1);
      if (exp.titleContains.some((t) => s1.fullText.toLowerCase().includes(t.toLowerCase())))
        pass('Title content', 'Found');
      else fail('Title content', exp.titleContains.join(' OR '), s1.fullText.substring(0, 100));
    }

    if (exp.minCharts !== undefined) {
      const { chartFiles } = await countCharts(zip);
      if (chartFiles < exp.minCharts) fail('Chart count', `>= ${exp.minCharts}`, chartFiles);
      else pass('Chart count', `${chartFiles} charts`);
    }

    if (exp.minTables !== undefined) {
      const { totalTables } = await countTables(zip);
      if (totalTables < exp.minTables) fail('Table count', `>= ${exp.minTables}`, totalTables);
      else pass('Table count', `${totalTables} tables`);
    }

    if (exp.minImages !== undefined) {
      const { imageCount } = await countImages(zip);
      if (imageCount < exp.minImages) fail('Image count', `>= ${exp.minImages}`, imageCount);
      else pass('Image count', `${imageCount} images`);
    }

    if (exp.requireInsights) {
      const textData = await extractAllText(zip);
      if (textData.slides.some((s) => s.fullText.toLowerCase().includes('key insights')))
        pass('Insights panels', 'Found');
      else fail('Insights panels', 'Contains "Key Insights"', 'Not found');
    }

    if (exp.noEmptySlides !== false) {
      const textData = await extractAllText(zip);
      const empty = textData.slides.filter((s) => s.charCount < 50);
      if (empty.length > 0)
        warn('Empty slides', `Slides with <50 chars: ${empty.map((s) => s.slideNum).join(', ')}`);
      else pass('No empty slides', 'All slides have content');
    }

    if (
      exp.maxSuspiciousEllipsis !== undefined ||
      exp.maxEllipsisTexts !== undefined ||
      exp.maxTotalEllipsis !== undefined
    ) {
      const textData = await extractAllText(zip);
      const ellipsisScan = scanSuspiciousEllipsis(textData);

      const maxSuspicious =
        exp.maxSuspiciousEllipsis !== undefined ? exp.maxSuspiciousEllipsis : exp.maxEllipsisTexts;
      if (maxSuspicious !== undefined) {
        if (ellipsisScan.suspiciousCount > maxSuspicious) {
          const preview = ellipsisScan.suspiciousHits
            .slice(0, 8)
            .map((h) => `slide ${h.slide}: "${h.text}"`)
            .join(' | ');
          fail(
            'Text truncation artifacts',
            `<= ${maxSuspicious} suspicious ellipsis snippets`,
            `${ellipsisScan.suspiciousCount} found${preview ? ` (${preview})` : ''}`
          );
        } else {
          pass(
            'Text truncation artifacts',
            `${ellipsisScan.suspiciousCount} suspicious ellipsis snippets`
          );
        }
      }

      if (exp.maxTotalEllipsis !== undefined) {
        if (ellipsisScan.ellipsisCount > exp.maxTotalEllipsis) {
          fail(
            'Ellipsis density',
            `<= ${exp.maxTotalEllipsis} total ellipsis snippets`,
            ellipsisScan.ellipsisCount
          );
        } else {
          pass('Ellipsis density', `${ellipsisScan.ellipsisCount} ellipsis snippets`);
        }
      }
    }

    if (exp.requiredText) {
      for (const text of exp.requiredText) {
        const r = await findText(zip, text);
        if (r.found)
          pass(`Text: "${text}"`, `Found on slides ${r.matches.map((m) => m.slide).join(', ')}`);
        else fail(`Text: "${text}"`, `Contains "${text}"`, 'Not found');
      }
    }

    if (exp.forbiddenText) {
      for (const text of exp.forbiddenText) {
        const r = await findText(zip, text);
        if (r.found) {
          fail(
            `Forbidden text: "${text}"`,
            `Must not contain "${text}"`,
            `Found on slides ${r.matches.map((m) => m.slide).join(', ')}`
          );
        } else {
          pass(`Forbidden text: "${text}"`, 'Not found');
        }
      }
    }

    if (exp.slideChecks) {
      const textData = await extractAllText(zip);
      for (const chk of exp.slideChecks) {
        const slide = textData.slides.find((s) => s.slideNum === chk.slide);
        if (!slide?.exists) {
          fail(`Slide ${chk.slide} exists`, 'Exists', 'Not found');
          continue;
        }
        if (chk.minChars && slide.charCount < chk.minChars)
          fail(`Slide ${chk.slide} length`, `>= ${chk.minChars}`, slide.charCount);
        else if (chk.minChars) pass(`Slide ${chk.slide} length`, `${slide.charCount} chars`);
        if (chk.mustContain) {
          for (const t of chk.mustContain) {
            if (slide.fullText.toLowerCase().includes(t.toLowerCase()))
              pass(`Slide ${chk.slide} "${t}"`, 'Found');
            else
              fail(`Slide ${chk.slide} "${t}"`, `Contains "${t}"`, slide.fullText.substring(0, 80));
          }
        }
      }
    }

    if (exp.tableChecks) {
      const tableData = await countTables(zip);
      for (const chk of exp.tableChecks) {
        const slideTable = tableData.tablesBySlide.find((t) => t.slide === chk.slide);
        if (chk.minTables && (!slideTable || slideTable.tableCount < chk.minTables))
          fail(`Slide ${chk.slide} tables`, `>= ${chk.minTables}`, slideTable?.tableCount || 0);
        else if (chk.minTables) pass(`Slide ${chk.slide} tables`, `${slideTable.tableCount}`);
        if (chk.minRows && (!slideTable || slideTable.rowCount < chk.minRows))
          fail(`Slide ${chk.slide} rows`, `>= ${chk.minRows}`, slideTable?.rowCount || 0);
        else if (chk.minRows) pass(`Slide ${chk.slide} rows`, `${slideTable?.rowCount || 0}`);
      }
    }
  } catch (err) {
    fail('File integrity', 'Valid PPTX', err.message);
  }

  return {
    valid: results.failed.length === 0,
    summary: {
      passed: results.passed.length,
      failed: results.failed.length,
      warnings: results.warnings.length,
    },
    ...results,
  };
}

async function generateReport(input) {
  const { zip, fileSize } = await readPPTX(input);
  const [chartData, tableData, textData, imageData] = await Promise.all([
    countCharts(zip),
    countTables(zip),
    extractAllText(zip),
    countImages(zip),
  ]);
  return {
    metadata: { fileSize: `${(fileSize / 1024).toFixed(1)}KB`, fileSizeBytes: fileSize },
    slides: {
      count: textData.slideCount,
      details: textData.slides.map((s) => ({
        slide: s.slideNum,
        chars: s.charCount,
        preview: s.fullText.substring(0, 100),
      })),
    },
    charts: chartData,
    tables: tableData,
    images: imageData,
    text: {
      total: textData.totalCharCount,
      avgPerSlide: Math.round(textData.totalCharCount / textData.slideCount),
    },
  };
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const flags = args.filter((a) => a.startsWith('--'));

  if (!file) {
    console.log('Usage: node pptx-validator.js <file.pptx> [--validate] [--country=Vietnam]');
    process.exit(0);
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  // Parse country flag
  const countryArg = flags.find((f) => f.startsWith('--country='));
  const country = countryArg ? countryArg.split('=')[1] : 'Vietnam';

  (async () => {
    if (flags.some((f) => f === '--validate')) {
      const r = await validatePPTX(file, {
        minSlides: 7,
        minCharts: 1,
        minTables: 3,
        requireInsights: true,
        titleContains: [country, 'Market'],
      });
      console.log(`Validating for: ${country}`);
      console.log(
        `Result: ${r.valid ? 'PASSED' : 'FAILED'} (${r.summary.passed}/${r.summary.passed + r.summary.failed})`
      );
      r.failed.forEach((f) =>
        console.log(`  [FAIL] ${f.check}: expected ${f.expected}, got ${f.actual}`)
      );
      process.exit(r.valid ? 0 : 1);
    } else {
      const r = await generateReport(file);
      console.log(
        `Size: ${r.metadata.fileSize} | Slides: ${r.slides.count} | Charts: ${r.charts.chartFiles} | Tables: ${r.tables.totalTables} | Images: ${r.images.imageCount}`
      );
      r.slides.details.forEach((s) =>
        console.log(`  Slide ${s.slide}: ${s.chars} chars - "${s.preview.substring(0, 60)}..."`)
      );
    }
  })();
}

module.exports = {
  readPPTX,
  scanXmlIntegrity,
  scanRelationshipTargets,
  normalizeAbsoluteRelationshipTargets,
  scanRelationshipReferenceIntegrity,
  scanSlideNonVisualIdIntegrity,
  normalizeSlideNonVisualIds,
  scanPackageConsistency,
  reconcileContentTypesAndPackage,
  countSlides,
  extractSlideText,
  extractAllText,
  countCharts,
  countTables,
  countImages,
  findText,
  validatePPTX,
  generateReport,
};
