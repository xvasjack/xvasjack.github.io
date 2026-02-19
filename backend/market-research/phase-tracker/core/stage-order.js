'use strict';

const {
  STAGE_ORDER,
  VALID_STAGE_IDS,
  STAGES,
  FIRST_STAGE,
  LAST_STAGE,
} = require('../contracts/stages');

/**
 * Get the 0-based index of a stage in the execution order.
 * Returns -1 if the stage ID is invalid.
 */
function stageIndex(stageId) {
  return STAGE_ORDER.indexOf(stageId);
}

/**
 * Check if a stage ID is valid.
 */
function isValidStage(stageId) {
  return VALID_STAGE_IDS.has(stageId);
}

/**
 * Get the next stage after the given one, or null if it's the last.
 */
function nextStage(stageId) {
  const idx = stageIndex(stageId);
  if (idx < 0 || idx >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

/**
 * Get the previous stage before the given one, or null if it's the first.
 */
function prevStage(stageId) {
  const idx = stageIndex(stageId);
  if (idx <= 0) return null;
  return STAGE_ORDER[idx - 1];
}

/**
 * Return the ordered slice of stages from FIRST_STAGE through `throughStageId` (inclusive).
 * Throws if throughStageId is invalid.
 */
function stagesThrough(throughStageId) {
  if (!isValidStage(throughStageId)) {
    throw new Error(`Invalid stage ID: "${throughStageId}". Valid: ${STAGE_ORDER.join(', ')}`);
  }
  const idx = stageIndex(throughStageId);
  return STAGE_ORDER.slice(0, idx + 1);
}

/**
 * Return the ordered slice of stages from `fromStageId` through `throughStageId` (inclusive).
 * Throws if either is invalid or from > through.
 */
function stagesFromThrough(fromStageId, throughStageId) {
  if (!isValidStage(fromStageId)) {
    throw new Error(`Invalid from-stage: "${fromStageId}". Valid: ${STAGE_ORDER.join(', ')}`);
  }
  if (!isValidStage(throughStageId)) {
    throw new Error(`Invalid through-stage: "${throughStageId}". Valid: ${STAGE_ORDER.join(', ')}`);
  }
  const fromIdx = stageIndex(fromStageId);
  const throughIdx = stageIndex(throughStageId);
  if (fromIdx > throughIdx) {
    throw new Error(`from-stage "${fromStageId}" comes after through-stage "${throughStageId}"`);
  }
  return STAGE_ORDER.slice(fromIdx, throughIdx + 1);
}

/**
 * Check if stageA comes before stageB in execution order.
 */
function isBefore(stageA, stageB) {
  return stageIndex(stageA) < stageIndex(stageB);
}

/**
 * Check if stageA comes after stageB in execution order.
 */
function isAfter(stageA, stageB) {
  return stageIndex(stageA) > stageIndex(stageB);
}

/**
 * Get stage metadata by ID.
 */
function getStage(stageId) {
  return STAGES[stageId] || null;
}

/**
 * Format a stage for display: "2 — Country Research"
 */
function formatStage(stageId) {
  const stage = STAGES[stageId];
  if (!stage) return `${stageId} — (unknown)`;
  return `${stageId} — ${stage.label}`;
}

/**
 * Return stage IDs as a display string for help text.
 */
function stageListDisplay() {
  return STAGE_ORDER.map((id) => `  ${id.padEnd(3)} ${STAGES[id].label}`).join('\n');
}

module.exports = {
  stageIndex,
  isValidStage,
  nextStage,
  prevStage,
  stagesThrough,
  stagesFromThrough,
  isBefore,
  isAfter,
  getStage,
  formatStage,
  stageListDisplay,
  STAGE_ORDER,
  FIRST_STAGE,
  LAST_STAGE,
};
