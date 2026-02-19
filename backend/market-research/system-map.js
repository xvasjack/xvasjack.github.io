'use strict';

/**
 * Plain-English system map.
 * Purpose: make flow understandable without reading the full codebase.
 */

const SYSTEM_MAP = {
  name: 'Market Research Deck Generator',
  oneLinePurpose:
    'Takes one request (country + industry) and generates a client-facing market research deck.',
  priorities: ['Content depth', 'Insight quality', 'Story flow', 'File safety', 'Formatting'],
  mainEndpoint: '/api/market-research',
  stages: [
    {
      id: 1,
      name: 'Read request',
      plain: 'Parse country/industry/client details and set run options.',
      file: 'server.js',
    },
    {
      id: 2,
      name: 'Research',
      plain: 'Collect market/policy/competitor/depth data for one target country.',
      file: 'research-engine.js',
    },
    {
      id: 3,
      name: 'Synthesize',
      plain: 'Convert research into one coherent strategic story.',
      file: 'research-engine.js',
    },
    {
      id: 4,
      name: 'Content checks',
      plain: 'Check if content is complete enough for presentation.',
      file: 'content-gates.js, content-quality-check.js',
    },
    {
      id: 5,
      name: 'Build deck',
      plain: 'Build slides from template-backed layouts.',
      file: 'deck-builder-single.js, deck-builder.js, ppt-utils.js',
    },
    {
      id: 6,
      name: 'File safety checks',
      plain: 'Ensure PPT opens cleanly and package structure is valid.',
      file: 'deck-file-check.js',
    },
    {
      id: 7,
      name: 'Deliver',
      plain: 'Email deck and expose runInfo/latest artifact endpoints.',
      file: 'server.js',
    },
  ],
  keyFiles: {
    apiEntry: 'server.js',
    researchEngine: 'research-engine.js',
    deckRenderer: 'deck-builder-single.js',
    contentChecks: 'content-gates.js',
    contentScoring: 'content-quality-check.js',
    fileSafety: 'deck-file-check.js',
    runInfo: 'post-run-summary.js',
    releaseGates: 'scripts/preflight-release.js',
  },
  wordsYouWillSee: {
    'Content check': 'Quality score for depth and clarity.',
    'Content size check': 'Warns if sections are very large (default does not cut text).',
    'File safety': 'Checks that PPT package is healthy and opens correctly.',
    'Style match': 'How visually close output is to template.',
  },
  defaultMode: {
    contentFirstMode: true,
    meaning:
      'By default, keep content depth and avoid automatic text cutting.',
  },
  whereToStartReading: [
    'README.md',
    'docs/logic-flow.md',
    'docs/file-map.md',
    'server.js (stages are commented in order)',
  ],
};

module.exports = { SYSTEM_MAP };
