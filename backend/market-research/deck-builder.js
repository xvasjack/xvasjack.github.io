'use strict';

const { generateSingleCountryPPT } = require('./deck-builder-single');

// Single-country deck entrypoint.
// Multi-country building is intentionally disabled to keep runtime simple.
async function generatePPT(synthesis, countryAnalyses, scope) {
  const analyses = Array.isArray(countryAnalyses) ? countryAnalyses.filter(Boolean) : [];
  if (analyses.length === 0) {
    throw new Error('PPT build failed: missing country analysis');
  }

  const countryAnalysis = analyses[0];
  if (analyses.length > 1) {
    console.warn(
      `[PPT] Single-country mode: keeping "${countryAnalysis.country || 'unknown'}" and skipping ${analyses.length - 1} extra country payload(s)`
    );
  }

  const normalizedScope = {
    ...(scope && typeof scope === 'object' ? scope : {}),
    targetMarkets: [countryAnalysis.country || (scope?.targetMarkets || [])[0] || 'Unknown'],
    singleCountryMode: true,
  };

  return generateSingleCountryPPT(synthesis, countryAnalysis, normalizedScope);
}

module.exports = { generatePPT };
