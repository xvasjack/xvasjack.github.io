'use strict';

/**
 * Public stage definitions for the phase-tracker pipeline.
 *
 * Each stage has:
 *  - id:          Unique string identifier (e.g. '2', '2a')
 *  - label:       Human-readable name
 *  - description: One-line purpose
 *  - kind:        'primary' (data-producing) | 'review' (quality-gate / improve loop)
 *  - inputs:      Array of artifact filenames consumed
 *  - outputs:     Array of artifact filenames produced
 */

const STAGES = Object.freeze({
  2: {
    id: '2',
    label: 'Country Research',
    description: 'Collect policy, market, competitor, and depth data via research agents',
    kind: 'primary',
    inputs: [],
    outputs: ['research-raw.json', 'research-raw.md'],
  },
  '2a': {
    id: '2a',
    label: 'Research Review',
    description: 'Review and fix weak/missing research sections using Gemini Pro',
    kind: 'review',
    inputs: ['research-raw.json'],
    outputs: ['research-reviewed.json', 'research-reviewed.md', 'review-issues.json'],
  },
  3: {
    id: '3',
    label: 'Synthesis',
    description: 'Synthesize raw research into structured country analysis',
    kind: 'primary',
    inputs: ['research-reviewed.json'],
    outputs: ['synthesis.json', 'synthesis.md'],
  },
  '3a': {
    id: '3a',
    label: 'Synthesis Review',
    description: 'Score and improve synthesis quality using Gemini Pro',
    kind: 'review',
    inputs: ['synthesis.json'],
    outputs: ['synthesis-reviewed.json', 'synthesis-reviewed.md', 'synthesis-scores.json'],
  },
  4: {
    id: '4',
    label: 'Content Quality Check',
    description: 'Hard check for depth, insight, evidence, and action value',
    kind: 'primary',
    inputs: ['synthesis-reviewed.json'],
    outputs: ['content-check.json'],
  },
  '4a': {
    id: '4a',
    label: 'Content Improve',
    description: 'Rewrite synthesis to pass content quality thresholds',
    kind: 'review',
    inputs: ['synthesis-reviewed.json', 'content-check.json'],
    outputs: ['synthesis-improved.json', 'synthesis-improved.md'],
  },
  5: {
    id: '5',
    label: 'Pre-build Check',
    description: 'Clean transient keys and validate PPT data structure',
    kind: 'primary',
    inputs: ['synthesis-improved.json'],
    outputs: ['ppt-data.json', 'prebuild-check.json'],
  },
  6: {
    id: '6',
    label: 'Content-Size Scan',
    description: 'Identify overly dense text, tables, and charts',
    kind: 'primary',
    inputs: ['ppt-data.json'],
    outputs: ['size-scan.json'],
  },
  '6a': {
    id: '6a',
    label: 'Readability Rewrite',
    description: 'Rewrite dense sections for slide readability',
    kind: 'review',
    inputs: ['ppt-data.json', 'size-scan.json'],
    outputs: ['ppt-data-readable.json', 'ppt-data-readable.md'],
  },
  7: {
    id: '7',
    label: 'Build PPT',
    description: 'Generate PowerPoint deck from structured data',
    kind: 'primary',
    inputs: ['ppt-data-readable.json'],
    outputs: ['deck.pptx', 'build-meta.json'],
  },
  8: {
    id: '8',
    label: 'PPT Health Check',
    description: 'Validate PPTX structure, file safety, and package consistency',
    kind: 'primary',
    inputs: ['deck.pptx'],
    outputs: ['health-check.json'],
  },
  '8a': {
    id: '8a',
    label: 'Final Review',
    description: 'AI review of generated deck for quality issues',
    kind: 'review',
    inputs: ['deck.pptx', 'health-check.json'],
    outputs: ['final-review.json', 'final-review.md'],
  },
  9: {
    id: '9',
    label: 'Delivery',
    description: 'Email the final deck and persist run metadata',
    kind: 'primary',
    inputs: ['deck.pptx'],
    outputs: ['delivery-receipt.json'],
  },
});

/** Ordered array of stage IDs in execution order */
const STAGE_ORDER = Object.freeze([
  '2',
  '2a',
  '3',
  '3a',
  '4',
  '4a',
  '5',
  '6',
  '6a',
  '7',
  '8',
  '8a',
  '9',
]);

/** Set of valid stage IDs for fast lookup */
const VALID_STAGE_IDS = Object.freeze(new Set(STAGE_ORDER));

/** Primary stages only (no review sub-stages) */
const PRIMARY_STAGES = Object.freeze(STAGE_ORDER.filter((id) => STAGES[id].kind === 'primary'));

/** Review stages only */
const REVIEW_STAGES = Object.freeze(STAGE_ORDER.filter((id) => STAGES[id].kind === 'review'));

/** First and last stage IDs */
const FIRST_STAGE = STAGE_ORDER[0];
const LAST_STAGE = STAGE_ORDER[STAGE_ORDER.length - 1];

module.exports = {
  STAGES,
  STAGE_ORDER,
  VALID_STAGE_IDS,
  PRIMARY_STAGES,
  REVIEW_STAGES,
  FIRST_STAGE,
  LAST_STAGE,
};
