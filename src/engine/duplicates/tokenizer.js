// Keywords to preserve as-is during normalisation
export const KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "return",
  "function",
  "class",
  "const",
  "let",
  "var",
  "import",
  "export",
  "default",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "void",
  "in",
  "of",
  "try",
  "catch",
  "finally",
  "throw",
  "async",
  "await",
  "yield",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "super",
  "static",
  "public",
  "private",
  "protected",
  "interface",
  "type",
  "enum",
  // Go keywords
  "func",
  "go",
  "defer",
  "select",
  "chan",
  "map",
  "range",
  "struct",
  "package",
  "nil",
  "make",
  "len",
  "cap",
  "append",
  "copy",
  "close",
  // Python keywords
  "def",
  "pass",
  "with",
  "as",
  "from",
  "not",
  "and",
  "or",
  "is",
  "lambda",
  "global",
  "nonlocal",
  "assert",
  "del",
  "raise",
]);

// Number literal patterns
export const NUMBER_RE = /^-?(?:0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

// String token sentinel (produced by tokenize when it encounters a quoted literal)
export const STRING_SENTINEL = '"..."';

/**
 * Skip past a line comment (// or #), returning the new position.
 * @param {string} content
 * @param {number} i  position of the comment start character
 * @param {number} len
 * @returns {number}
 */
function skipLineComment(content, i, len) {
  while (i < len && content[i] !== "\n") i++;
  return i;
}

/**
 * Skip past a block comment (/* ... *\/), returning the new position.
 * @param {string} content
 * @param {number} i  position just after the opening `/*`
 * @param {number} len
 * @returns {number}
 */
function skipBlockComment(content, i, len) {
  while (i < len - 1 && !(content[i] === "*" && content[i + 1] === "/")) i++;
  return i + 2;
}

/**
 * Scan a quoted string literal, returning the position after the closing quote.
 * @param {string} content
 * @param {number} i  position of the opening quote character
 * @param {number} len
 * @param {string} quote  the quote character (" ' `)
 * @returns {number}
 */
function scanStringLiteral(content, i, len, quote) {
  i++; // skip opening quote
  while (i < len) {
    if (content[i] === "\\") {
      i += 2; // skip escaped character
      continue;
    }
    if (content[i] === quote) {
      i++; // skip closing quote
      break;
    }
    i++;
  }
  return i;
}

/**
 * Determine whether a `-` at position i should be treated as part of a
 * negative numeric literal rather than a subtraction operator.
 * @param {string} content
 * @param {number} i
 * @returns {boolean}
 */
function isNegativeNumberStart(content, i) {
  if (content[i] !== "-") return false;
  if (!/\d/.test(content[i + 1] ?? "")) return false;
  if (i === 0) return true;
  const prev = content[i - 1];
  return /[=(<>+\-*/,;:?&|![{]/.test(prev) || /\s/.test(prev);
}

/**
 * Tokenize source content, returning tokens with their start character positions.
 * Internal implementation used by both tokenize() and scanDuplicates().
 * @param {string} content
 * @returns {Array<{token: string, pos: number}>}
 */
export function tokenizeWithPositions(content) {
  const tokens = [];
  let i = 0;
  const len = content.length;

  while (i < len) {
    const ch = content[i];

    // Skip whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Line comments: // or #
    if (ch === "#" || (ch === "/" && content[i + 1] === "/")) {
      i = skipLineComment(content, i, len);
      continue;
    }

    // Block comments: /* ... */
    if (ch === "/" && content[i + 1] === "*") {
      i = skipBlockComment(content, i + 2, len);
      continue;
    }

    // String literals: single, double, backtick
    if (ch === '"' || ch === "'" || ch === "`") {
      tokens.push({ token: STRING_SENTINEL, pos: i });
      i = scanStringLiteral(content, i, len, ch);
      continue;
    }

    // Identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      let j = i;
      while (j < len && /[\w$]/.test(content[j])) j++;
      tokens.push({ token: content.slice(start, j), pos: start });
      i = j;
      continue;
    }

    // Numeric literals (including leading-minus negatives)
    if (/\d/.test(ch) || isNegativeNumberStart(content, i)) {
      const start = i;
      let j = ch === "-" ? i + 1 : i;
      while (j < len && /[\dA-Fa-fxXbBoO.]/.test(content[j])) j++;
      tokens.push({ token: content.slice(start, j), pos: start });
      i = j;
      continue;
    }

    // Operators and delimiters — emit each character as its own token
    if (/[(){}[\];,.<>+\-*/=!&|?:]/.test(ch)) {
      tokens.push({ token: ch, pos: i });
      i++;
      continue;
    }

    // Anything else: skip
    i++;
  }

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
  return tokens.map((tok) => {
    if (KEYWORDS.has(tok)) return tok;
    if (tok === STRING_SENTINEL) return "STR";
    if (NUMBER_RE.test(tok)) return "NUM";
    if (/^[A-Za-z_$][\w$]*$/.test(tok)) return "IDENT";
    return tok;
  });
}
