#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const SLIDE_XML_RE = /^ppt\/slides\/slide\d+\.xml$/i;

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/check-japanese-translation-regression.js --input <source.pptx> --output <translated.pptx>',
      '',
      'Env fallback:',
      '  TRANSLATION_REGRESSION_INPUT',
      '  TRANSLATION_REGRESSION_OUTPUT',
      '',
      'What this checks:',
      '  1) Source contains Banking/Transportation terms.',
      '  2) Output contains expected JP replacements for key phrases.',
      '  3) Output does not retain unresolved English generic terms.',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function decodeXmlText(value) {
  if (typeof value !== 'string' || !value) return '';
  const toCodePoint = (num) => {
    if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return '';
    try {
      return String.fromCodePoint(num);
    } catch {
      return '';
    }
  };

  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => toCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => toCodePoint(parseInt(dec, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function normalizeLooseText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

async function extractSlideTextRuns(pptxPath) {
  const buffer = await fs.promises.readFile(pptxPath);
  const zip = await JSZip.loadAsync(buffer);
  const parts = Object.keys(zip.files)
    .filter((part) => !zip.files[part].dir && SLIDE_XML_RE.test(part))
    .sort();

  const runs = [];
  for (const part of parts) {
    const file = zip.file(part);
    if (!file) continue;
    const xml = await file.async('string');
    const regex = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
    let match;

    while ((match = regex.exec(xml)) !== null) {
      const decoded = normalizeLooseText(decodeXmlText(match[1] || ''));
      if (!decoded) continue;
      runs.push({ part, text: decoded });
    }
  }

  return runs;
}

function hasMatch(runs, re) {
  return runs.some((r) => re.test(r.text));
}

function collectMatches(runs, re, limit = 20) {
  const out = [];
  for (const run of runs) {
    if (!re.test(run.text)) continue;
    out.push(run);
    if (out.length >= limit) break;
  }
  return out;
}

function resolvePaths(args) {
  const input = args.input || process.env.TRANSLATION_REGRESSION_INPUT;
  const output = args.output || process.env.TRANSLATION_REGRESSION_OUTPUT;

  if (!input || !output) {
    throw new Error(
      'Missing required paths. Provide --input/--output or TRANSLATION_REGRESSION_INPUT/TRANSLATION_REGRESSION_OUTPUT.'
    );
  }

  return {
    input: path.resolve(input),
    output: path.resolve(output),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const { input, output } = resolvePaths(args);
  if (!fs.existsSync(input)) {
    throw new Error(`Input PPTX not found: ${input}`);
  }
  if (!fs.existsSync(output)) {
    throw new Error(`Output PPTX not found: ${output}`);
  }

  const sourceRuns = await extractSlideTextRuns(input);
  const outputRuns = await extractSlideTextRuns(output);

  const sourceHasBanking = hasMatch(sourceRuns, /\bbanking\b/i);
  const sourceHasTransportation = hasMatch(sourceRuns, /\btransportation\b/i);
  const sourceHasBankingFinancial = hasMatch(sourceRuns, /\bbanking\s*&\s*financial\s*services\b/i);
  const sourceHasAirportsTransportation = hasMatch(
    sourceRuns,
    /\bairports?\s*&\s*transportation\b/i
  );

  const errors = [];
  if (!sourceHasBanking) {
    errors.push('Source fixture does not contain "Banking" in slide text.');
  }
  if (!sourceHasTransportation) {
    errors.push('Source fixture does not contain "Transportation" in slide text.');
  }
  if (sourceHasBankingFinancial && !hasMatch(outputRuns, /銀行・金融サービス/)) {
    errors.push('Missing expected JP replacement: "銀行・金融サービス".');
  }
  if (sourceHasAirportsTransportation && !hasMatch(outputRuns, /空港・交通/)) {
    errors.push('Missing expected JP replacement: "空港・交通".');
  }
  if (!hasMatch(outputRuns, /(銀行|交通)/)) {
    errors.push('Output does not contain expected Japanese generic terms ("銀行" or "交通").');
  }

  const unresolvedEnglish = collectMatches(
    outputRuns,
    /\b(banking|transportation|financial services)\b/i
  );
  if (unresolvedEnglish.length > 0) {
    errors.push(
      `Output still contains unresolved English generic terms (${unresolvedEnglish.length} sample matches).`
    );
  }

  if (errors.length > 0) {
    console.error('[FAIL] Japanese translation regression check failed.');
    for (const err of errors) {
      console.error(`- ${err}`);
    }
    if (unresolvedEnglish.length > 0) {
      console.error('Unresolved output examples:');
      for (const run of unresolvedEnglish) {
        console.error(`- ${run.part}: ${run.text}`);
      }
    }
    process.exit(1);
  }

  console.log('[PASS] Japanese translation regression check passed.');
  console.log(`Input:  ${input}`);
  console.log(`Output: ${output}`);
  console.log(`Slide runs scanned (source/output): ${sourceRuns.length}/${outputRuns.length}`);
}

main().catch((error) => {
  console.error(`[FAIL] ${error.message}`);
  process.exit(1);
});
