#!/usr/bin/env node
'use strict';

/**
 * Simple stage-by-stage checker (starting with stage 2 and 2a).
 *
 * Output answers:
 * 1) Does the stage work? (pass/fail)
 * 2) How well does the stage work? (score + grade)
 *
 * Usage:
 *   node scripts/stage-check.js --stage=2 --prompt="Energy Services in Vietnam"
 *   node scripts/stage-check.js --stage=2a --prompt="Energy Services in Vietnam"
 *   node scripts/stage-check.js --through=2a --prompt="Energy Services in Vietnam"
 *   node scripts/stage-check.js --stage=2 --country=Vietnam --industry="Energy Services"
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { readRequestType } = require('../research-framework');
const { researchCountry } = require('../research-engine');
const { validateResearchQuality } = require('../content-gates');

const REPORT_DIR = path.join(__dirname, '..', 'reports', 'latest');
const MAX_STAGE2A_RETRIES = 3;
const CORE_SECTIONS = ['policy', 'market', 'competitors', 'depth', 'summary'];

let cachedServerTest = null;
function getServerTestHelpers() {
  if (cachedServerTest) return cachedServerTest;
  // Silence unrelated env warnings when importing server test helpers.
  if (!process.env.SENDGRID_API_KEY) process.env.SENDGRID_API_KEY = 'stage-check-local';
  if (!process.env.SENDER_EMAIL) process.env.SENDER_EMAIL = 'stage-check@example.com';
  // Lazy require so --help and stage 2-only checks stay clean.
  // eslint-disable-next-line global-require
  const { __test } = require('../server');
  cachedServerTest = __test;
  return cachedServerTest;
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq < 0) {
      out[arg.slice(2)] = true;
      continue;
    }
    out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function parseBoolArg(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function gradeFromScore(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function sectionPresenceScore(countryAnalysis) {
  let present = 0;
  for (const key of CORE_SECTIONS) {
    const section = countryAnalysis?.[key];
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      present += 1;
    }
  }
  return { present, total: CORE_SECTIONS.length };
}

async function resolveScope(args) {
  const country = String(args.country || '').trim();
  const industry = String(args.industry || '').trim();
  const clientContext = String(args['client-context'] || '').trim();
  const prompt = String(args.prompt || '').trim();

  if (country && industry) {
    return {
      prompt: prompt || `${industry} in ${country}`,
      scope: {
        projectType: 'market_entry',
        industry,
        targetMarkets: [country],
        clientContext,
        clientName: '',
        projectName: '',
        focusAreas: [],
      },
      country,
      industry,
      clientContext,
    };
  }

  if (!prompt) {
    throw new Error('Provide --prompt OR both --country and --industry');
  }

  const scope = await readRequestType(prompt);
  const parsedCountry =
    Array.isArray(scope?.targetMarkets) && scope.targetMarkets.length > 0
      ? String(scope.targetMarkets[0] || '').trim()
      : '';
  const parsedIndustry = String(scope?.industry || '').trim();
  if (!parsedCountry || !parsedIndustry) {
    throw new Error('Request reader did not return country/industry');
  }
  return {
    prompt,
    scope,
    country: parsedCountry,
    industry: parsedIndustry,
    clientContext: String(scope?.clientContext || ''),
  };
}

async function runStage2(context) {
  const started = Date.now();
  let countryAnalysis = null;
  let error = null;
  try {
    countryAnalysis = await researchCountry(
      context.country,
      context.industry,
      context.clientContext,
      context.scope
    );
  } catch (err) {
    error = err;
  }

  const works =
    !error &&
    countryAnalysis &&
    !countryAnalysis.error &&
    countryAnalysis.rawData &&
    typeof countryAnalysis.rawData === 'object' &&
    Object.keys(countryAnalysis.rawData).length > 0;

  const rawData = works ? countryAnalysis.rawData : {};
  const topicKeys = Object.keys(rawData || {});
  const topicChars = topicKeys.map((k) => String(rawData[k]?.content || '').length);
  const qualityGate = works
    ? validateResearchQuality(rawData)
    : { pass: false, score: 0, issues: ['stage failed before quality check'] };

  let qualityScore = 0;
  qualityScore += Math.min(60, Number(qualityGate.score || 0));
  qualityScore += Math.min(20, Math.round((topicKeys.length / 25) * 20));
  qualityScore += Math.min(20, Math.round((median(topicChars) / 300) * 20));
  qualityScore = Math.max(0, Math.min(100, qualityScore));

  return {
    stage: '2',
    pass: Boolean(works),
    score: qualityScore,
    grade: gradeFromScore(qualityScore),
    durationMs: Date.now() - started,
    details: {
      country: context.country,
      industry: context.industry,
      topicCount: topicKeys.length,
      medianTopicChars: median(topicChars),
      qualityGatePass: Boolean(qualityGate.pass),
      qualityGateScore: Number(qualityGate.score || 0),
      topIssues: Array.isArray(qualityGate.issues) ? qualityGate.issues.slice(0, 8) : [],
      error: error ? String(error.message || error) : countryAnalysis?.error || null,
    },
    countryAnalysis,
  };
}

async function runStage2a(context, stage2Result) {
  const started = Date.now();
  const serverTest = getServerTestHelpers();
  if (!stage2Result?.countryAnalysis || stage2Result.pass !== true) {
    return {
      stage: '2a',
      pass: false,
      score: 0,
      grade: 'F',
      durationMs: Date.now() - started,
      details: {
        error: 'Stage 2 output missing or failed',
      },
      countryAnalysis: stage2Result?.countryAnalysis || null,
    };
  }

  let current = stage2Result.countryAnalysis;
  const before = sectionPresenceScore(current);
  const attempts = [];

  for (let attempt = 1; attempt <= MAX_STAGE2A_RETRIES; attempt++) {
    const needsReview = serverTest.countryNeedsReview(current);
    if (!needsReview) break;

    const issues = [];
    if (current?.readyForClient === false) {
      issues.push('readyForClient flag is false');
    }
    for (const section of CORE_SECTIONS) {
      const value = current?.[section];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        issues.push(`missing/invalid section: ${section}`);
      }
    }
    if (issues.length === 0) {
      issues.push('improve section completeness and decision usefulness');
    }

    let reviewed = null;
    try {
      reviewed = await serverTest.reviewCountryAnalysisWithGeminiPro({
        countryAnalysis: current,
        scope: context.scope,
        issues,
        attempt,
        maxRetries: MAX_STAGE2A_RETRIES,
      });
    } catch (err) {
      attempts.push({
        attempt,
        applied: false,
        stillNeedsReview: true,
        error: String(err.message || err),
      });
      continue;
    }

    if (reviewed && typeof reviewed === 'object' && !Array.isArray(reviewed)) {
      current = serverTest.mergeCountryAnalysis(current, reviewed);
      attempts.push({
        attempt,
        applied: true,
        stillNeedsReview: serverTest.countryNeedsReview(current),
      });
    } else {
      attempts.push({
        attempt,
        applied: false,
        stillNeedsReview: true,
        error: 'review output was not valid JSON object',
      });
    }
  }

  const after = sectionPresenceScore(current);
  const pass = !serverTest.countryNeedsReview(current);
  let qualityScore = 0;
  qualityScore += pass ? 50 : 0;
  qualityScore += Math.round((after.present / after.total) * 30);
  qualityScore += current?.readyForClient === true ? 20 : 0;
  qualityScore = Math.max(0, Math.min(100, qualityScore));

  return {
    stage: '2a',
    pass,
    score: qualityScore,
    grade: gradeFromScore(qualityScore),
    durationMs: Date.now() - started,
    details: {
      beforeSectionsPresent: `${before.present}/${before.total}`,
      afterSectionsPresent: `${after.present}/${after.total}`,
      attempts,
      finalNeedsReview: serverTest.countryNeedsReview(current),
      readyForClient: current?.readyForClient === true,
    },
    countryAnalysis: current,
  };
}

function printSummaryRow(result) {
  const id = String(result.stage || '').padEnd(4, ' ');
  const works = (result.pass ? 'YES' : 'NO').padEnd(6, ' ');
  const score = String(result.score).padStart(3, ' ');
  const grade = String(result.grade || '-').padEnd(2, ' ');
  const ms = String(result.durationMs || 0).padStart(6, ' ');
  console.log(`| ${id} | ${works} | ${score}/100 | ${grade} | ${ms} |`);
}

function ensureReportDir() {
  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }
}

function saveReport(report, fileName) {
  ensureReportDir();
  const outputPath = path.join(REPORT_DIR, fileName);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  return outputPath;
}

function safeFileToken(value, fallback = 'output') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function pickTopicText(topicValue) {
  if (typeof topicValue === 'string') return topicValue.trim();
  if (!topicValue || typeof topicValue !== 'object' || Array.isArray(topicValue)) return '';
  const textKeys = ['content', 'analysis', 'summary', 'findings', 'text', 'details', 'insight'];
  for (const key of textKeys) {
    const value = topicValue[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return JSON.stringify(topicValue, null, 2);
}

function pickTopicSources(topicValue) {
  if (!topicValue || typeof topicValue !== 'object' || Array.isArray(topicValue)) return [];
  const sourceKeys = ['sources', 'citations', 'references'];
  for (const key of sourceKeys) {
    const value = topicValue[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === 'string') return item.trim();
          if (item && typeof item === 'object') {
            const link = String(item.url || item.link || item.source || item.title || '').trim();
            return link;
          }
          return '';
        })
        .filter(Boolean);
    }
  }
  if (typeof topicValue.source === 'string' && topicValue.source.trim()) {
    return [topicValue.source.trim()];
  }
  return [];
}

function buildStageOutputMarkdown(stageResult, context) {
  const analysis = stageResult?.countryAnalysis || {};
  const lines = [];
  lines.push(`# Stage ${stageResult.stage} output`);
  lines.push('');
  lines.push(`- country: ${context.country}`);
  lines.push(`- industry: ${context.industry}`);
  lines.push(`- works: ${stageResult.pass ? 'YES' : 'NO'}`);
  lines.push(`- quality: ${stageResult.score}/100 (${stageResult.grade})`);
  lines.push(`- time_ms: ${stageResult.durationMs}`);
  lines.push('');

  const sectionNames = ['policy', 'market', 'competitors', 'depth', 'summary'];
  for (const sectionName of sectionNames) {
    if (!analysis || typeof analysis !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(analysis, sectionName)) continue;
    lines.push(`## ${sectionName}`);
    lines.push('```json');
    lines.push(JSON.stringify(analysis[sectionName], null, 2));
    lines.push('```');
    lines.push('');
  }

  const rawData = analysis?.rawData && typeof analysis.rawData === 'object' ? analysis.rawData : {};
  const topicKeys = Object.keys(rawData);
  lines.push(`## raw topics (${topicKeys.length})`);
  lines.push('');
  if (topicKeys.length === 0) {
    lines.push('(none)');
    lines.push('');
  } else {
    for (const topicKey of topicKeys) {
      const topicValue = rawData[topicKey];
      const topicText = pickTopicText(topicValue);
      const sources = pickTopicSources(topicValue);
      lines.push(`### ${topicKey}`);
      lines.push('');
      lines.push(topicText || '(no text)');
      lines.push('');
      if (sources.length > 0) {
        lines.push('sources:');
        for (const source of sources) {
          lines.push(`- ${source}`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

function saveStageOutputFiles(stageResult, context, runId) {
  ensureReportDir();
  const countryToken = safeFileToken(context.country, 'country');
  const industryToken = safeFileToken(context.industry, 'industry');
  const stageToken = safeFileToken(stageResult.stage, 'stage');
  const baseName = `${stageToken}-output-${countryToken}-${industryToken}-${runId}`;
  const mdPath = path.join(REPORT_DIR, `${baseName}.md`);
  const jsonPath = path.join(REPORT_DIR, `${baseName}.json`);
  const mdContent = buildStageOutputMarkdown(stageResult, context);
  fs.writeFileSync(mdPath, mdContent);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        stage: stageResult.stage,
        country: context.country,
        industry: context.industry,
        works: stageResult.pass,
        score: stageResult.score,
        grade: stageResult.grade,
        durationMs: stageResult.durationMs,
        details: stageResult.details || {},
        output: stageResult.countryAnalysis || null,
      },
      null,
      2
    )
  );
  return { mdPath, jsonPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log('Stage check (simple)');
    console.log('');
    console.log('Usage:');
    console.log('  npm run stage:check -- --stage=2 --prompt="Energy Services in Vietnam"');
    console.log('  npm run stage:check -- --stage=2a --prompt="Energy Services in Vietnam"');
    console.log('  npm run stage:check -- --through=2a --prompt="Energy Services in Vietnam"');
    console.log('  npm run stage:check -- --stage=2 --country=Vietnam --industry="Energy Services"');
    console.log('');
    console.log('Flags:');
    console.log('  --stage=2|2a');
    console.log('  --through=2a');
    console.log('  --prompt="..."');
    console.log('  --country=...');
    console.log('  --industry=...');
    console.log('  --client-context=...');
    console.log('  --api-key=...');
    console.log('  --save-output=true|false (default: true)');
    console.log('  --print-output=true|false (default: false)');
    process.exit(0);
  }
  const stage = String(args.stage || '').trim().toLowerCase();
  const through = String(args.through || '').trim().toLowerCase();
  const target = through || stage || '2';
  const saveOutput = parseBoolArg(args['save-output'], true);
  const printOutput = parseBoolArg(args['print-output'], false);

  const explicitApiKey = String(args['api-key'] || '').trim();
  if (explicitApiKey) {
    process.env.GEMINI_API_KEY = explicitApiKey;
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not visible to this process. Set env var or pass --api-key=...'
    );
  }
  if (!['2', '2a'].includes(target)) {
    throw new Error(`Unsupported stage target: ${target}. Use --stage=2, --stage=2a, or --through=2a`);
  }

  const context = await resolveScope(args);
  const stageResults = [];

  const stage2 = await runStage2(context);
  stageResults.push(stage2);

  if (target === '2a') {
    const stage2a = await runStage2a(context, stage2);
    stageResults.push(stage2a);
  }

  console.log('');
  console.log('+------+--------+----------+----+--------+');
  console.log('| ID   | Works? | Quality  | G  | ms     |');
  console.log('+------+--------+----------+----+--------+');
  for (const result of stageResults) {
    printSummaryRow(result);
  }
  console.log('+------+--------+----------+----+--------+');
  console.log('');

  for (const result of stageResults) {
    console.log(`Stage ${result.stage} details:`);
    const details = result.details || {};
    for (const [key, value] of Object.entries(details)) {
      const printable =
        value && typeof value === 'object' ? JSON.stringify(value).slice(0, 500) : String(value);
      console.log(`- ${key}: ${printable}`);
    }
    console.log('');
  }

  const outputFiles = [];
  if (saveOutput) {
    const runId = Date.now();
    for (const result of stageResults) {
      if (!result || !['2', '2a'].includes(String(result.stage || ''))) continue;
      const files = saveStageOutputFiles(result, context, runId);
      outputFiles.push({
        stage: result.stage,
        md: files.mdPath,
        json: files.jsonPath,
      });
      if (printOutput) {
        console.log('');
        console.log(`Stage ${result.stage} output (preview):`);
        const preview = buildStageOutputMarkdown(result, context).slice(0, 4000);
        console.log(preview);
        console.log(preview.length >= 4000 ? '\n[preview cut at 4000 chars]\n' : '');
      }
    }
    if (outputFiles.length > 0) {
      console.log('Output files:');
      for (const entry of outputFiles) {
        console.log(`- stage ${entry.stage} md: ${entry.md}`);
        console.log(`- stage ${entry.stage} json: ${entry.json}`);
      }
      console.log('');
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    prompt: context.prompt,
    country: context.country,
    industry: context.industry,
    ranTo: target,
    results: stageResults.map((r) => ({
      stage: r.stage,
      pass: r.pass,
      score: r.score,
      grade: r.grade,
      durationMs: r.durationMs,
      details: r.details,
    })),
    outputFiles,
  };
  const reportName = `stage-check-${target}-${Date.now()}.json`;
  const reportPath = saveReport(report, reportName);
  console.log(`Report saved: ${reportPath}`);

  const failed = stageResults.find((r) => !r.pass);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`Stage check failed: ${err.message}`);
  process.exit(1);
});
