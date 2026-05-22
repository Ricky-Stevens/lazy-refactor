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

// High ratio (~0.25+) = real logic; low (~0.05–0.10) = data/config
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

// Low diversity (~0.02–0.05) = repetitive data; high (~0.15+) = varied logic
export function computeTokenDiversity(normalisedTokens, start, length) {
  const end = Math.min(start + length, normalisedTokens.length);
  const actual = end - start;
  if (actual === 0) return 0;
  const unique = new Set();
  for (let i = start; i < end; i++) unique.add(normalisedTokens[i]);
  return unique.size / actual;
}

// High density = region appears in many findings = likely structural repetition, not copy-paste
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

// Combines structural ratio, token diversity, and region density into a 0–1 confidence
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
