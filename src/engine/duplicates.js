// Barrel re-export — all public API from the duplicates sub-modules.
// Existing imports from '../engine/duplicates.js' or './duplicates.js' continue to work.

export { clusterDuplicates } from "./duplicates/clustering.js";
export { findMatches, rollingHash, verifyMatch } from "./duplicates/hashing.js";
export { scanDuplicates } from "./duplicates/scanner.js";
export {
  classifyRefactoring,
  computeRegionDensities,
  computeStructuralRatio,
  computeTokenDiversity,
  scoreConfidence,
} from "./duplicates/scoring.js";
export { normalizeTokens, tokenize, tokenizeWithPositions } from "./duplicates/tokenizer.js";
