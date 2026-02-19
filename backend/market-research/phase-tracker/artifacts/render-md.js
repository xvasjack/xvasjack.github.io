'use strict';

const { writeArtifact } = require('./write-artifact');
const { ARTIFACT_FILES } = require('./pathing');

/**
 * Render a stage output object as a Markdown file.
 * Creates a human-readable .md artifact alongside the .json.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.stage
 * @param {number} opts.attempt
 * @param {object} opts.output - the stage output data
 * @param {object} [opts.meta] - optional metadata to include
 * @param {string} [opts.dbPath]
 */
function renderMd({ runId, stage, attempt, output, meta, dbPath }) {
  const lines = [];

  lines.push(`# Stage ${stage} — Attempt ${attempt}`);
  lines.push(`**Run:** \`${runId}\``);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');

  // Meta section
  if (meta) {
    lines.push('## Metadata');
    lines.push('');
    for (const [k, v] of Object.entries(meta)) {
      if (v !== null && v !== undefined) {
        const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
        lines.push(`- **${k}:** ${val}`);
      }
    }
    lines.push('');
  }

  // Output section
  lines.push('## Output');
  lines.push('');

  if (output === null || output === undefined) {
    lines.push('*No output data*');
  } else if (typeof output === 'string') {
    lines.push(output);
  } else if (Array.isArray(output)) {
    renderArray(lines, output, 0);
  } else if (typeof output === 'object') {
    renderObject(lines, output, 0);
  } else {
    lines.push(String(output));
  }

  lines.push('');

  const md = lines.join('\n');
  return writeArtifact({
    runId,
    stage,
    attempt,
    filename: ARTIFACT_FILES.OUTPUT_MD,
    content: md,
    contentType: 'text/markdown',
    dbPath,
  });
}

function renderObject(lines, obj, depth) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;

    if (typeof value === 'object' && !Array.isArray(value)) {
      const heading = depth < 3 ? '#'.repeat(depth + 3) : '**';
      const suffix = depth < 3 ? '' : '**';
      lines.push(`${heading} ${formatKey(key)}${suffix}`);
      lines.push('');
      renderObject(lines, value, depth + 1);
    } else if (Array.isArray(value)) {
      lines.push(`**${formatKey(key)}:**`);
      lines.push('');
      renderArray(lines, value, depth + 1);
    } else {
      lines.push(`- **${formatKey(key)}:** ${String(value)}`);
    }
  }
  lines.push('');
}

function renderArray(lines, arr, depth) {
  for (const item of arr) {
    if (typeof item === 'object' && item !== null) {
      // Compact object rendering for list items
      const keys = Object.keys(item);
      if (keys.length <= 3 && keys.every((k) => typeof item[k] !== 'object')) {
        const parts = keys.map((k) => `**${formatKey(k)}:** ${item[k]}`);
        lines.push(`- ${parts.join(' | ')}`);
      } else {
        lines.push('---');
        renderObject(lines, item, depth);
      }
    } else {
      lines.push(`- ${String(item)}`);
    }
  }
  lines.push('');
}

function formatKey(key) {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

module.exports = { renderMd };
