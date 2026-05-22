// Tokens that indicate control flow and logic — used by computeStructuralRatio.
// Deliberately excludes import/export/from/const/let/var/default: those appear
// heavily in data files and import blocks, inflating the structural ratio.
const STRUCTURAL_TOKENS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "return",
  "function",
  "class",
  "try",
  "catch",
  "finally",
  "throw",
  "async",
  "await",
  "yield",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "break",
  "continue",
  "void",
  "in",
  "of",
  "static",
  "public",
  "private",
  "protected",
  "interface",
  "type",
  "enum",
  "func",
  "go",
  "defer",
  "select",
  "chan",
  "range",
  "struct",
  "package",
  "def",
  "pass",
  "with",
  "lambda",
  "global",
  "nonlocal",
  "assert",
  "raise",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  "&&",
  "||",
  "?",
  "!",
]);

/**
 * Compute the ratio of structural tokens (control-flow, declarations, scope
 * delimiters) to total tokens within a normalised token window.
 *
 * High ratio (~0.25+) → the window contains real logic.
 * Low ratio (~0.05–0.10) → the window is mostly data/config.
 *
 * @param {string[]} normalisedTokens
 * @param {number} start
 * @param {number} length
 * @returns {number} 0–1
 */
export function computeStructuralRatio(normalisedTokens, start, length) {
  let structural = 0;
  const end = Math.min(start + length, normalisedTokens.length);
  const actual = end - start;
  if (actual === 0) return 0;
  for (let i = start; i < end; i++) {
    if (STRUCTURAL_TOKENS.has(normalisedTokens[i])) structural++;
  }
  return structural / actual;
}

/**
 * Compute the ratio of unique normalised tokens to total tokens in the window.
 *
 * Repetitive data structures (rule arrays, config maps) repeat the same few
 * normalised tokens over and over: { IDENT : STR , IDENT : STR , ... }.
 * Real logic tends to use a wider vocabulary of operators and keywords.
 *
 * Low diversity (~0.02–0.05) → highly repetitive, almost certainly data.
 * High diversity (~0.15+) → varied token usage, more likely logic.
 *
 * @param {string[]} normalisedTokens
 * @param {number} start
 * @param {number} length
 * @returns {number} 0–1
 */
export function computeTokenDiversity(normalisedTokens, start, length) {
  const end = Math.min(start + length, normalisedTokens.length);
  const actual = end - start;
  if (actual === 0) return 0;
  const unique = new Set();
  for (let i = start; i < end; i++) unique.add(normalisedTokens[i]);
  return unique.size / actual;
}

/**
 * Count how many findings each file-region participates in.
 * Returns a Map keyed by "file:startLine-endLine" → count.
 *
 * When a region appears in many findings (e.g. every entry in a rule array
 * matching every other entry), that's a signal the matches are structural
 * repetition rather than copy-pasted logic.
 *
 * @param {Array<{fileA: string, startLineA: number, endLineA: number, fileB: string, startLineB: number, endLineB: number}>} findings
 * @returns {Map<string, number>}
 */
export function computeRegionDensities(findings) {
  const counts = new Map();
  for (const f of findings) {
    const keyA = `${f.fileA}:${f.startLineA}-${f.endLineA}`;
    const keyB = `${f.fileB}:${f.startLineB}-${f.endLineB}`;
    counts.set(keyA, (counts.get(keyA) || 0) + 1);
    counts.set(keyB, (counts.get(keyB) || 0) + 1);
  }
  return counts;
}

/**
 * Compute a confidence score (0–1) indicating how likely a duplicate finding
 * represents genuinely duplicated logic rather than structural data repetition.
 *
 * Three signals are combined:
 *
 * 1. **Structural ratio** — what fraction of the matched tokens are control-flow
 *    keywords, declarations, and scope operators vs data placeholders (IDENT/STR/NUM).
 *    Pure data arrays score ~0.05; real functions score ~0.25+.
 *
 * 2. **Token diversity** — how many unique normalised tokens appear in the window
 *    relative to its length. Data structures repeat `{ IDENT : STR , }` with very
 *    low diversity; logic uses a wider token vocabulary.
 *
 * 3. **Region density** — how many other findings share the same file-region.
 *    A region that matches 8 other regions is likely one cell in a repeated data
 *    structure. Genuine copy-paste rarely fans out beyond 2–3 matches.
 *
 * @param {number} structuralRatio  0–1 from computeStructuralRatio
 * @param {number} tokenDiversity   0–1 from computeTokenDiversity
 * @param {number} regionDensity    positive integer, 1 = unique match
 * @param {number} similarity       0–1 token-level similarity
 * @returns {number} 0–1 confidence
 */
export function scoreConfidence(structuralRatio, tokenDiversity, regionDensity, similarity) {
  const structuralScore = Math.min(1.0, structuralRatio / 0.25);
  const diversityScore = Math.min(1.0, tokenDiversity / 0.15);
  const densityScore = Math.min(1.0, 3 / Math.max(1, regionDensity));

  const contentSignal = 0.6 * structuralScore + 0.4 * diversityScore;
  return Math.round(contentSignal * densityScore * similarity * 100) / 100;
}

const DECLARATION_STARTS = new Set([
  "function",
  "class",
  "def",
  "func",
  "async",
  "export",
  "const",
  "let",
  "var",
]);
const WRAPPER_TOKENS = new Set(["try", "catch", "finally"]);

/**
 * Classify the likely refactoring strategy for a duplicate finding based on
 * the token structure of the matched window. Returns a short category string
 * that hints the fixer agent toward the right extraction approach.
 *
 * Categories:
 * - "extract-and-share"  — a complete function/method was independently written
 *                          in multiple places; extract to a shared module and import.
 * - "extract-wrapper"    — a try/catch or setup/teardown wrapper pattern;
 *                          extract a higher-order function.
 * - "extract-function"   — inline logic block duplicated across call sites;
 *                          extract into a named function.
 * - "extract-config"     — mostly data/config with light logic;
 *                          extract a shared constant or factory.
 *
 * @param {string[]} normalisedTokens
 * @param {number} start
 * @param {number} length
 * @param {number} structuralRatio  pre-computed from computeStructuralRatio
 * @returns {string}
 */
export function classifyRefactoring(normalisedTokens, start, length, structuralRatio) {
  if (structuralRatio < 0.15) return "extract-config";

  const end = Math.min(start + length, normalisedTokens.length);
  const first = normalisedTokens[start];
  const second = start + 1 < end ? normalisedTokens[start + 1] : "";

  const startsWithDeclaration =
    DECLARATION_STARTS.has(first) || (first === "export" && DECLARATION_STARTS.has(second));

  let hasWrapper = false;
  for (let i = start; i < end; i++) {
    if (WRAPPER_TOKENS.has(normalisedTokens[i])) {
      hasWrapper = true;
      break;
    }
  }

  if (hasWrapper) return "extract-wrapper";
  if (startsWithDeclaration) return "extract-and-share";
  return "extract-function";
}
