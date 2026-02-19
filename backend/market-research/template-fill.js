const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { fitTokensToTemplateSlots } = require('./context-fit-agent');

const BOOLEAN_FALSE_RE = /^(0|false|no|off)$/i;

function decodeXmlText(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function encodeXmlText(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeToken(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLockedTemplateText(text) {
  const t = normalizeToken(text);
  // Empty text runs are writable slots in many template slides.
  if (!t) return false;
  if (/^\(c\)\s*ycp/i.test(t)) return true;
  if (/^shizuoka\s+gas\s+company$/i.test(t)) return true;
  if (/^project\s+escort\s*[–-]\s*phase\s*1$/i.test(t)) return true;
  if (/^table\s+of\s+contents$/i.test(t)) return true;
  if (/^[0-9]+$/.test(t)) return true;
  return false;
}

function shouldSkipGeneratedToken(text) {
  const t = normalizeToken(text);
  if (!t) return true;
  if (/^\(c\)\s*ycp/i.test(t)) return true;
  if (/^table\s+of\s+contents$/i.test(t)) return true;
  if (/^[0-9]+$/.test(t)) return true;
  return false;
}

function extractTextTokens(slideXml) {
  const tokens = [];
  const re = /<a:t(\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  for (const m of slideXml.matchAll(re)) {
    const decoded = normalizeToken(decodeXmlText(m[2]));
    if (!decoded) continue;
    if (shouldSkipGeneratedToken(decoded)) continue;
    tokens.push(decoded);
  }
  return tokens;
}

function tokenCharCount(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return 0;
  return tokens.reduce((sum, token) => sum + normalizeToken(token).length, 0);
}

async function replaceTemplateTextWithTokens(templateSlideXml, generatedTokens, options = {}) {
  const templateTexts = [];
  const textRe = /<a:t(\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  for (const m of templateSlideXml.matchAll(textRe)) {
    templateTexts.push({ attrs: m[1] || '', text: decodeXmlText(m[2]) });
  }
  const candidateSlots = templateTexts.filter((node) => !isLockedTemplateText(node.text)).length;
  if (candidateSlots === 0 || generatedTokens.length === 0) {
    return {
      xml: templateSlideXml,
      replacedCount: 0,
      slotCount: candidateSlots,
      droppedTokens: 0,
      fitMethod: 'none',
      fitStats: { inputTokens: generatedTokens.length, slotCount: candidateSlots, outputTokens: 0 },
    };
  }

  const fitContext = [
    options.blockKey ? `blockKey=${options.blockKey}` : null,
    options.templateSlideNo ? `templateSlide=${options.templateSlideNo}` : null,
    options.generatedSlideNo ? `generatedSlide=${options.generatedSlideNo}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const fitResult = await fitTokensToTemplateSlots(generatedTokens, candidateSlots, {
    allowAI: options.allowAI !== false,
    forceAI: options.forceAI === true,
    context: fitContext || 'template clone fit',
  });
  const fittedTokens = Array.isArray(fitResult.tokens) ? fitResult.tokens : [];
  const droppedTokens = Math.max(0, generatedTokens.length - fittedTokens.length);
  let cursor = 0;
  let replacedCount = 0;

  const nextXml = templateSlideXml.replace(textRe, (full, attrs, body) => {
    const decoded = decodeXmlText(body);
    if (isLockedTemplateText(decoded)) {
      return full;
    }
    if (cursor >= fittedTokens.length) {
      return `<a:t${attrs || ''}></a:t>`;
    }
    const replacement = encodeXmlText(fittedTokens[cursor++]);
    replacedCount++;
    return `<a:t${attrs || ''}>${replacement}</a:t>`;
  });

  return {
    xml: nextXml,
    replacedCount,
    slotCount: candidateSlots,
    droppedTokens,
    fitMethod: fitResult.method || 'rule',
    fitStats: fitResult.stats || {
      inputTokens: generatedTokens.length,
      slotCount: candidateSlots,
      outputTokens: fittedTokens.length,
    },
  };
}

function getSlideNumbers(zip) {
  return Object.keys(zip.files)
    .map((name) => {
      const m = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      return m ? Number(m[1]) : null;
    })
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

function parseChartTargets(relXml) {
  const targets = [];
  const re = /<Relationship\b[^>]*>/g;
  for (const m of relXml.matchAll(re)) {
    const tag = m[0];
    const type = (tag.match(/\bType=(['"])(.*?)\1/i) || [])[2] || '';
    const target = (tag.match(/\bTarget=(['"])(.*?)\1/i) || [])[2] || '';
    if (/\/chart$/i.test(String(type))) targets.push(target);
  }
  return targets;
}

function ownerPartFromRel(relFile) {
  const normalized = normalizeToken(relFile);
  if (normalized === '_rels/.rels') return '';
  const m = normalized.match(/^(.*)\/_rels\/([^/]+)\.rels$/);
  if (!m) return '';
  const baseDir = m[1];
  const ownerPart = m[2];
  return baseDir ? `${baseDir}/${ownerPart}` : ownerPart;
}

function resolveRelationshipTargetPart(relFile, target) {
  const raw = String(target || '').trim();
  if (!raw) return '';
  if (/^(https?:|mailto:|file:)/i.test(raw)) return '';
  if (raw.startsWith('#')) return '';
  if (raw.startsWith('/')) {
    return raw.replace(/^\/+/, '');
  }
  const ownerPart = ownerPartFromRel(relFile);
  const ownerDir = ownerPart ? path.posix.dirname(ownerPart) : '';
  const resolved = ownerDir ? path.posix.normalize(path.posix.join(ownerDir, raw)) : raw;
  if (!resolved || resolved.startsWith('../')) return '';
  return resolved;
}

function patchTemplateSlideRels(templateRelXml, generatedRelXml) {
  if (!templateRelXml || !generatedRelXml) return { xml: templateRelXml, chartPatched: 0 };
  const generatedChartTargets = parseChartTargets(generatedRelXml);
  if (generatedChartTargets.length === 0) return { xml: templateRelXml, chartPatched: 0 };

  let chartIdx = 0;
  const patched = templateRelXml.replace(/<Relationship\b[^>]*>/g, (tag) => {
    const type = (tag.match(/\bType=(['"])(.*?)\1/i) || [])[2] || '';
    if (!/\/chart$/i.test(String(type))) return tag;
    const replacementTarget = generatedChartTargets[chartIdx++];
    if (!replacementTarget) return tag;
    if (/\bTarget=(['"])(.*?)\1/i.test(tag)) {
      return tag.replace(/\bTarget=(['"])(.*?)\1/i, (_m, q) => `Target=${q}${replacementTarget}${q}`);
    }
    return tag;
  });

  return { xml: patched, chartPatched: Math.min(chartIdx, generatedChartTargets.length) };
}

async function maybeCopyTemplatePart(templateZip, generatedZip, partName, { overwrite = false } = {}) {
  const templatePart = templateZip.file(partName);
  if (!templatePart) return false;
  const hasExisting = Boolean(generatedZip.file(partName));
  if (hasExisting && !overwrite) return false;
  const partBuffer = await templatePart.async('nodebuffer');
  generatedZip.file(partName, partBuffer);
  return true;
}

async function copyTemplateSupportParts(templateZip, generatedZip) {
  const files = Object.keys(templateZip.files);
  const prefixRules = [
    { prefix: 'ppt/slideLayouts/', overwrite: true },
    { prefix: 'ppt/slideMasters/', overwrite: true },
    { prefix: 'ppt/theme/', overwrite: true },
    { prefix: 'ppt/notesMasters/', overwrite: true },
    { prefix: 'ppt/notesSlides/', overwrite: true },
    { prefix: 'ppt/media/', overwrite: true },
  ];
  const explicitRules = [
    { name: 'ppt/presProps.xml', overwrite: true },
    { name: 'ppt/viewProps.xml', overwrite: true },
    { name: 'ppt/tableStyles.xml', overwrite: true },
  ];

  let copied = 0;
  for (const name of files) {
    if (templateZip.files[name].dir) continue;
    const prefixRule = prefixRules.find((rule) => name.startsWith(rule.prefix));
    const explicitRule = explicitRules.find((rule) => rule.name === name);
    if (!prefixRule && !explicitRule) continue;
    const overwrite = (prefixRule || explicitRule).overwrite;
    const changed = await maybeCopyTemplatePart(templateZip, generatedZip, name, { overwrite });
    if (changed) copied++;
  }
  return copied;
}

async function copyMissingTemplateReferencedParts(templateZip, generatedZip, { maxPasses = 5 } = {}) {
  let copied = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    let copiedThisPass = 0;
    const relFiles = Object.keys(generatedZip.files).filter((name) => /\.rels$/i.test(name));
    for (const relFile of relFiles) {
      const relEntry = generatedZip.file(relFile);
      if (!relEntry) continue;
      const relXml = await relEntry.async('string');
      const relTags = relXml.match(/<Relationship\b[^>]*>/g) || [];
      for (const tag of relTags) {
        const targetMode = (tag.match(/\bTargetMode=(['"])(.*?)\1/i) || [])[2] || '';
        if (/external/i.test(targetMode)) continue;
        const target = (tag.match(/\bTarget=(['"])(.*?)\1/i) || [])[2] || '';
        const targetPart = resolveRelationshipTargetPart(relFile, target);
        if (!targetPart) continue;
        if (generatedZip.file(targetPart)) continue;
        const templatePart = templateZip.file(targetPart);
        if (!templatePart) continue;
        const templateBuffer = await templatePart.async('nodebuffer');
        generatedZip.file(targetPart, templateBuffer);
        copiedThisPass++;
      }
    }
    copied += copiedThisPass;
    if (copiedThisPass === 0) break;
  }
  return copied;
}

async function applyTemplateClonePostprocess(generatedBuffer, {
  templatePath,
  maxSlides = 34,
  slideTemplateMap = [],
  enabled = true,
} = {}) {
  if (!enabled || BOOLEAN_FALSE_RE.test(String(process.env.TEMPLATE_CLONE_MODE || 'true'))) {
    return {
      buffer: generatedBuffer,
      changed: false,
      stats: {
        mappedPairs: 0,
        clonedSlides: 0,
        textReplacements: 0,
        droppedTokens: 0,
        chartRelPatched: 0,
        copiedSupportParts: 0,
        copiedReferencedParts: 0,
        fallbackSlides: 0,
        contextFitAISlides: 0,
        contextFitHeuristicSlides: 0,
        contextFitNoneSlides: 0,
      },
    };
  }

  const resolvedTemplate = path.resolve(templatePath || path.join(__dirname, '..', '..', '251219_Escort_Phase 1 Market Selection_V3.pptx'));
  if (!fs.existsSync(resolvedTemplate)) {
    throw new Error(`Template clone mode failed: template file not found at ${resolvedTemplate}`);
  }

  const templateBuffer = fs.readFileSync(resolvedTemplate);
  const templateZip = await JSZip.loadAsync(templateBuffer);
  const generatedZip = await JSZip.loadAsync(generatedBuffer);

  const generatedSlides = getSlideNumbers(generatedZip);
  const templateSlides = getSlideNumbers(templateZip);
  const generatedSlideSet = new Set(generatedSlides);
  const templateSlideSet = new Set(templateSlides);
  const maxSlidesCap = Number(maxSlides) || 34;
  let clonePairs = [];

  if (Array.isArray(slideTemplateMap) && slideTemplateMap.length > 0) {
    const dedup = new Map();
    for (const entry of slideTemplateMap) {
      const generatedSlideNumber = Number(entry?.generatedSlideNumber);
      const templateSlideNumber = Number(entry?.templateSlideNumber);
      if (!Number.isFinite(generatedSlideNumber) || generatedSlideNumber <= 0) continue;
      if (!Number.isFinite(templateSlideNumber) || templateSlideNumber <= 0) continue;
      if (generatedSlideNumber > maxSlidesCap) continue;
      if (!generatedSlideSet.has(generatedSlideNumber)) continue;
      if (!templateSlideSet.has(templateSlideNumber)) continue;
      dedup.set(generatedSlideNumber, {
        templateSlideNumber,
        blockKey: normalizeToken(entry?.blockKey || ''),
      });
    }
    clonePairs = Array.from(dedup.entries())
      .map(([generatedSlideNumber, payload]) => ({
        generatedSlideNumber,
        templateSlideNumber: payload.templateSlideNumber,
        blockKey: payload.blockKey || '',
      }))
      .sort((a, b) => a.generatedSlideNumber - b.generatedSlideNumber);
  } else {
    const slideCount = Math.min(generatedSlides.length, templateSlides.length, maxSlidesCap);
    clonePairs = Array.from({ length: slideCount }, (_, idx) => ({
      generatedSlideNumber: generatedSlides[idx],
      templateSlideNumber: templateSlides[idx],
      blockKey: '',
    }));
  }

  const mappedPairs = clonePairs.length;
  let clonedSlides = 0;
  let fallbackSlides = 0;
  let textReplacements = 0;
  let droppedTokens = 0;
  let chartRelPatched = 0;
  let contextFitAISlides = 0;
  let contextFitHeuristicSlides = 0;
  let contextFitNoneSlides = 0;

  const MIN_GENERATED_CHARS_FOR_RETENTION_CHECK = 120;
  const MIN_CLONED_CHARS = 80;
  const MIN_CONTENT_RETENTION_RATIO = 0.5;
  const CONTEXT_FIT_MODE = String(process.env.CONTEXT_FIT_AGENT_MODE || 'auto')
    .trim()
    .toLowerCase();
  const CONTEXT_FIT_MAX_AI_SLIDES = Math.max(
    0,
    Number.parseInt(process.env.CONTEXT_FIT_AGENT_MAX_AI_SLIDES || '6', 10) || 0
  );

  const copiedSupportParts = await copyTemplateSupportParts(templateZip, generatedZip);

  for (const pair of clonePairs) {
    const slideNo = Number(pair.generatedSlideNumber);
    const templateSlideNo = Number(pair.templateSlideNumber);
    if (!Number.isFinite(slideNo) || !Number.isFinite(templateSlideNo)) continue;

    const slidePath = `ppt/slides/slide${slideNo}.xml`;
    const relPath = `ppt/slides/_rels/slide${slideNo}.xml.rels`;
    const templateSlidePath = `ppt/slides/slide${templateSlideNo}.xml`;
    const templateRelPath = `ppt/slides/_rels/slide${templateSlideNo}.xml.rels`;

    const generatedSlideEntry = generatedZip.file(slidePath);
    const templateSlideEntry = templateZip.file(templateSlidePath);
    if (!generatedSlideEntry || !templateSlideEntry) continue;

    const generatedSlideXml = await generatedSlideEntry.async('string');
    const generatedTokens = extractTextTokens(generatedSlideXml);
    const generatedCharCount = tokenCharCount(generatedTokens);
    const templateSlideXml = await templateSlideEntry.async('string');
    const allowAIForSlide =
      CONTEXT_FIT_MODE !== 'rule' &&
      CONTEXT_FIT_MODE !== 'off' &&
      contextFitAISlides < CONTEXT_FIT_MAX_AI_SLIDES;
    const replaced = await replaceTemplateTextWithTokens(templateSlideXml, generatedTokens, {
      templateSlideNo,
      generatedSlideNo: slideNo,
      blockKey: pair.blockKey || '',
      allowAI: allowAIForSlide,
      forceAI: CONTEXT_FIT_MODE === 'ai',
    });
    if (replaced.fitMethod === 'ai') contextFitAISlides++;
    else if (replaced.fitMethod === 'rule') contextFitHeuristicSlides++;
    else contextFitNoneSlides++;

    const generatedRelXml = generatedZip.file(relPath)
      ? await generatedZip.file(relPath).async('string')
      : '';
    const templateRelXml = templateZip.file(templateRelPath)
      ? await templateZip.file(templateRelPath).async('string')
      : '';

    let nextRelXml = generatedRelXml;
    if (templateRelXml) {
      const patchedRels = patchTemplateSlideRels(templateRelXml, generatedRelXml);
      nextRelXml = patchedRels.xml;
      chartRelPatched += patchedRels.chartPatched;
    }

    const clonedTokens = extractTextTokens(replaced.xml);
    const clonedCharCount = tokenCharCount(clonedTokens);
    const retentionRatio = generatedCharCount > 0 ? clonedCharCount / generatedCharCount : 1;
    const failsRetention =
      generatedCharCount >= MIN_GENERATED_CHARS_FOR_RETENTION_CHECK &&
      (clonedCharCount < MIN_CLONED_CHARS || retentionRatio < MIN_CONTENT_RETENTION_RATIO);

    if (failsRetention) {
      // Keep generated slide content when template-clone token transfer would blank/truncate too much.
      generatedZip.file(slidePath, generatedSlideXml);
      if (generatedRelXml) generatedZip.file(relPath, generatedRelXml);
      fallbackSlides++;
      continue;
    }

    generatedZip.file(slidePath, replaced.xml);
    if (nextRelXml) generatedZip.file(relPath, nextRelXml);

    clonedSlides++;
    textReplacements += replaced.replacedCount;
    droppedTokens += replaced.droppedTokens;
  }

  if (clonedSlides === 0) {
    return {
      buffer: generatedBuffer,
      changed: false,
      stats: {
        clonedSlides: 0,
        mappedPairs,
        textReplacements: 0,
        droppedTokens: 0,
        chartRelPatched: 0,
        copiedSupportParts,
        copiedReferencedParts: 0,
        fallbackSlides,
        contextFitAISlides,
        contextFitHeuristicSlides,
        contextFitNoneSlides,
      },
    };
  }

  const copiedReferencedParts = await copyMissingTemplateReferencedParts(templateZip, generatedZip);

  const buffer = await generatedZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    buffer,
    changed: true,
    stats: {
      mappedPairs,
      clonedSlides,
      textReplacements,
      droppedTokens,
      chartRelPatched,
      copiedSupportParts,
      copiedReferencedParts,
      fallbackSlides,
      contextFitAISlides,
      contextFitHeuristicSlides,
      contextFitNoneSlides,
    },
  };
}

module.exports = {
  applyTemplateClonePostprocess,
  __test: {
    isLockedTemplateText,
    shouldSkipGeneratedToken,
    extractTextTokens,
    replaceTemplateTextWithTokens,
  },
};
