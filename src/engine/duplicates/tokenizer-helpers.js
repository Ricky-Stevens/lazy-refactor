import { KEYWORDS } from "./tokenizer-keywords.js";

// Number literal patterns
export const NUMBER_RE = /^-?(?:0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

// Prefix-anchored variant of NUMBER_RE (no end anchor) used to consume exactly
// the numeric portion at a position without swallowing following identifiers.
export const NUMBER_PREFIX_RE =
  /^-?(?:0[xX][\dA-Fa-f]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

// String token sentinel emitted whenever a quoted literal is encountered.
export const STRING_SENTINEL = '"..."';

/**
 * Skip past a line comment (// or #), returning the new position.
 * @param {string} content
 * @param {number} i  position of the comment-start character
 * @param {number} len
 * @returns {number}
 */
export function skipLineComment(content, i, len) {
  while (i < len && content[i] !== "\n") i++;
  return i;
}

/**
 * Skip past a block comment (slash-star ... star-slash), returning the new position.
 * @param {string} content
 * @param {number} i  position just after the opening slash-star
 * @param {number} len
 * @returns {number}
 */
export function skipBlockComment(content, i, len) {
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
export function scanStringLiteral(content, i, len, quote) {
  i++; // skip opening quote
  while (i < len && content[i] !== quote) {
    if (content[i] === "\\") i++; // skip escaped character
    i++;
  }
  return i < len ? i + 1 : i; // skip closing quote if present
}

/**
 * Return true when the character at position i is the start of a negative
 * numeric literal rather than a subtraction operator.
 * @param {string} content
 * @param {number} i
 * @returns {boolean}
 */
export function isNegativeNumberStart(content, i) {
  if (content[i] !== "-" || !/\d/.test(content[i + 1] ?? "")) return false;
  return i === 0 || /[=(<>+\-*/,;:?&|![{\s]/.test(content[i - 1]);
}

/**
 * Scan an identifier starting at position i.
 * @param {string} content
 * @param {number} i
 * @param {number} len
 * @returns {{ token: string, end: number }}
 */
export function scanIdentifier(content, i, len) {
  const start = i;
  while (i < len && /[\w$]/.test(content[i])) i++;
  return { token: content.slice(start, i), end: i };
}

/**
 * Scan a numeric literal starting at position i. Consumes exactly the numeric
 * prefix (hex/binary/octal/decimal with optional fraction and exponent) so that
 * trailing member access or identifiers (e.g. `1.toFixed`, `0xFF.bar`) are not
 * swallowed into the number token.
 * @param {string} content
 * @param {number} i
 * @param {number} _len - unused; kept for signature symmetry with the other scanX helpers
 * @returns {{ token: string, end: number }}
 */
export function scanNumber(content, i, _len) {
  const m = NUMBER_PREFIX_RE.exec(content.slice(i));
  if (!m) return { token: content[i], end: i + 1 };
  return { token: content.slice(i, i + m[0].length), end: i + m[0].length };
}

/**
 * Normalise a single token: map identifiers to IDENT, numbers to NUM,
 * string sentinels to STR. Keep keywords and operators as-is.
 * @param {string} tok
 * @returns {string}
 */
export function normalizeToken(tok) {
  if (KEYWORDS.has(tok)) return tok;
  if (tok === STRING_SENTINEL) return "STR";
  if (NUMBER_RE.test(tok)) return "NUM";
  if (/^[A-Za-z_$][\w$]*$/.test(tok)) return "IDENT";
  return tok;
}

/**
 * Process one character at position i, appending any produced token to `tokens`.
 * Returns the new position after consuming the character (and any associated lexeme).
 * @param {string} content
 * @param {number} i
 * @param {number} len
 * @param {Array<{token: string, pos: number}>} tokens  mutated in place
 * @returns {number}
 */
export function scanNextToken(content, i, len, tokens) {
  const ch = content[i];
  if (/\s/.test(ch)) return i + 1;
  if (ch === "#" || (ch === "/" && content[i + 1] === "/")) return skipLineComment(content, i, len);
  if (ch === "/" && content[i + 1] === "*") return skipBlockComment(content, i + 2, len);
  if (ch === '"' || ch === "'" || ch === "`") {
    tokens.push({ token: STRING_SENTINEL, pos: i });
    return scanStringLiteral(content, i, len, ch);
  }
  if (/[A-Za-z_$]/.test(ch)) {
    const { token, end } = scanIdentifier(content, i, len);
    tokens.push({ token, pos: i });
    return end;
  }
  if (/\d/.test(ch) || isNegativeNumberStart(content, i)) {
    const { token, end } = scanNumber(content, i, len);
    tokens.push({ token, pos: i });
    return end;
  }
  if (/[(){}[\];,.<>+\-*/=!&|?:]/.test(ch)) {
    tokens.push({ token: ch, pos: i });
    return i + 1;
  }
  return i + 1;
}
