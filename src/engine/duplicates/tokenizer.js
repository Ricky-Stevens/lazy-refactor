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

    // Line comments (// or #)
    if (ch === "/" && content[i + 1] === "/") {
      while (i < len && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "#") {
      while (i < len && content[i] !== "\n") i++;
      continue;
    }
    // Block comments /* ... */
    if (ch === "/" && content[i + 1] === "*") {
      i += 2;
      while (i < len - 1 && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // String literals: single, double, backtick
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      const quote = ch;
      i++;
      while (i < len) {
        if (content[i] === "\\") {
          i += 2;
          continue;
        }
        if (content[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      tokens.push({ token: STRING_SENTINEL, pos: start });
      continue;
    }

    // Identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      let j = i;
      while (j < len && /[\w$]/.test(content[j])) j++;
      tokens.push({ token: content.slice(i, j), pos: start });
      i = j;
      continue;
    }

    // Numeric literals. A leading `-` is part of the number only when it
    // appears at the start of an expression — i.e. after an operator, an
    // opening bracket, or whitespace — not after an identifier or closing
    // bracket where it would actually be a subtraction operator.
    const prevCh = i === 0 ? "" : content[i - 1];
    const negativeNumber =
      ch === "-" &&
      /\d/.test(content[i + 1] ?? "") &&
      (i === 0 || /[=(<>+\-*/,;:?&|![{]/.test(prevCh) || /\s/.test(prevCh));
    if (/\d/.test(ch) || negativeNumber) {
      const start = i;
      let j = i;
      if (ch === "-") j++;
      while (j < len && /[\dA-Fa-fxXbBoO.]/.test(content[j])) j++;
      tokens.push({ token: content.slice(i, j), pos: start });
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
