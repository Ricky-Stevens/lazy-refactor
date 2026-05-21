// Barrel file — re-exports everything from the cross-ref sub-modules so that
// existing imports like `import { scanDeadCode } from '../engine/cross-ref.js'`
// continue to work without modification.

export { detectLanguage, isEntryPoint, isTestFile } from "./cross-ref/classify.js";
export { ENTRY_POINT_NAMES, TEST_FILE_PATTERNS } from "./cross-ref/constants.js";
export { extractExports } from "./cross-ref/extract-exports.js";
export { extractImports } from "./cross-ref/extract-imports.js";
export { getRecentlyAddedFiles, scanDeadCode } from "./cross-ref/scan-dead-code.js";
export { detectManifest, scanUnusedDeps } from "./cross-ref/scan-unused-deps.js";
export { scanUnusedImports } from "./cross-ref/scan-unused-imports.js";
