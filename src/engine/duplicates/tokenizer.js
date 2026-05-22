import { normalizeToken, scanNextToken } from "./tokenizer-helpers.js";

// Re-export constants used by scanner.js and tests
export { NUMBER_RE, STRING_SENTINEL } from "./tokenizer-helpers.js";
export { KEYWORDS } from "./tokenizer-keywords.js";

/**
 * Tokenize source content, returning tokens with their start character positions.
 * Internal implementation used by both tokenize() and scanDuplicates().
 * @param {string} content
 * @returns {Array<{token: string, pos: number}>}
 */
export function tokenizeWithPositions(content) {
  const tokens = [];
  const len = content.length;
  let i = 0;
  while (i < len) i = scanNextToken(content, i, len, tokens);
  return tokens;
}

/**
 * Tokenize source content into an array of token strings.
 * Splits on whitespace and operators/delimiters: (){}[];,.<>+-*\/=!&|?:
 * String literals (single/double/backtick-quoted) are emitted as a single '"..."' token.
 * @param {string} content
 * @returns {string[]}
 */
export function tokenize(content) {
  return tokenizeWithPositions(content).map((t) => t.token);
}

/**
 * Normalise a token array: replace identifiers with IDENT, numbers with NUM,
 * string sentinels with STR. Keep keywords as-is.
 * @param {string[]} tokens
 * @returns {string[]}
 */
export function normalizeTokens(tokens) {
  return tokens.map(normalizeToken);
}
