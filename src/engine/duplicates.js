import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

// Rabin-Karp constants
const RK_BASE = 31;
const RK_MOD = 1_000_000_007;

// BigInt versions for overflow-safe modular arithmetic in rollingHash
const BIG_BASE = BigInt(RK_BASE);
const BIG_MOD = BigInt(RK_MOD);

// Language -> file extensions (same mapping as cross-ref)
const LANGUAGE_EXTENSIONS = {
  typescript: ['.ts', '.tsx', '.js', '.jsx'],
  go: ['.go'],
  python: ['.py'],
  csharp: ['.cs'],
  java: ['.java'],
};

// Keywords to preserve as-is during normalisation
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'function', 'class', 'const', 'let', 'var', 'import', 'export',
  'default', 'new', 'delete', 'typeof', 'instanceof', 'void', 'in', 'of',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
  'true', 'false', 'null', 'undefined', 'this', 'super', 'static',
  'public', 'private', 'protected', 'interface', 'type', 'enum',
  // Go keywords
  'func', 'go', 'defer', 'select', 'chan', 'map', 'range', 'struct',
  'package', 'nil', 'make', 'len', 'cap', 'append', 'copy', 'close',
  // Python keywords
  'def', 'pass', 'with', 'as', 'from', 'not', 'and', 'or', 'is',
  'lambda', 'global', 'nonlocal', 'assert', 'del', 'raise',
]);

// Number literal patterns
const NUMBER_RE = /^-?(?:0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

// String token sentinel (produced by tokenize when it encounters a quoted literal)
const STRING_SENTINEL = '"..."';

/**
 * Tokenize source content, returning tokens with their start character positions.
 * Internal implementation used by both tokenize() and scanDuplicates().
 * @param {string} content
 * @returns {Array<{token: string, pos: number}>}
 */
function tokenizeWithPositions(content) {
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
    if (ch === '/' && content[i + 1] === '/') {
      while (i < len && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '#') {
      while (i < len && content[i] !== '\n') i++;
      continue;
    }
    // Block comments /* ... */
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < len - 1 && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // String literals: single, double, backtick
    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i;
      const quote = ch;
      i++;
      while (i < len) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === quote) { i++; break; }
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

    // Numeric literals
    if (/\d/.test(ch) || (ch === '-' && /\d/.test(content[i + 1] ?? ''))) {
      const start = i;
      let j = i;
      if (ch === '-') j++;
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
    if (tok === STRING_SENTINEL) return 'STR';
    if (NUMBER_RE.test(tok)) return 'NUM';
    if (/^[A-Za-z_$][\w$]*$/.test(tok)) return 'IDENT';
    return tok;
  });
}

/**
 * Compute Rabin-Karp rolling hashes over a sliding window of tokens.
 * Returns an array of {hash, startIndex, endIndex} for each window position.
 * @param {string[]} tokens
 * @param {number} windowSize
 * @returns {Array<{hash: number, startIndex: number, endIndex: number}>}
 */
export function rollingHash(tokens, windowSize) {
  if (tokens.length < windowSize) return [];

  const result = [];

  // Pre-compute per-token numeric values using a simple string hash.
  // Returns a BigInt to avoid overflow in subsequent arithmetic.
  function tokenValue(tok) {
    let h = 0n;
    for (let k = 0; k < tok.length; k++) {
      h = (h * BIG_BASE + BigInt(tok.charCodeAt(k))) % BIG_MOD;
    }
    return h + 1n; // avoid zero
  }

  // base^(windowSize-1) mod MOD — coefficient of the leading term in the polynomial
  let basePow = 1n;
  for (let k = 0; k < windowSize - 1; k++) {
    basePow = (basePow * BIG_BASE) % BIG_MOD;
  }

  // Initial window hash: hash = v[0]*base^(w-1) + v[1]*base^(w-2) + ... + v[w-1]
  let hash = 0n;
  for (let k = 0; k < windowSize; k++) {
    hash = (hash * BIG_BASE + tokenValue(tokens[k])) % BIG_MOD;
  }
  result.push({ hash: Number(hash), startIndex: 0, endIndex: windowSize - 1 });

  // Slide window: new_hash = (old_hash - leaving * base^(w-1)) * base + entering
  for (let i = 1; i + windowSize - 1 < tokens.length; i++) {
    const leaving = tokenValue(tokens[i - 1]);
    const entering = tokenValue(tokens[i + windowSize - 1]);
    hash = ((hash - leaving * basePow % BIG_MOD + BIG_MOD) * BIG_BASE + entering) % BIG_MOD;
    result.push({ hash: Number(hash), startIndex: i, endIndex: i + windowSize - 1 });
  }

  return result;
}

/**
 * Cross-file hash comparison. Returns candidate pairs where the same hash
 * appears in different files.
 * @param {Array<{file: string, hashes: Array<{hash: number, startIndex: number, endIndex: number}>}>} hashMaps
 * @returns {Array<{fileA: string, fileB: string, startA: number, endA: number, startB: number, endB: number}>}
 */
export function findMatches(hashMaps) {
  // hash -> [{file, startIndex, endIndex}]
  const table = new Map();

  for (const { file, hashes } of hashMaps) {
    for (const { hash, startIndex, endIndex } of hashes) {
      if (!table.has(hash)) table.set(hash, []);
      table.get(hash).push({ file, startIndex, endIndex });
    }
  }

  const pairs = [];
  const seen = new Set();

  for (const entries of table.values()) {
    if (entries.length < 2) continue;
    // Emit unique cross-file pairs
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        if (a.file === b.file) continue;
        // Dedup by file pair + token positions
        const key = `${a.file}:${a.startIndex}-${b.file}:${b.startIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({
          fileA: a.file,
          fileB: b.file,
          startA: a.startIndex,
          endA: a.endIndex,
          startB: b.startIndex,
          endB: b.endIndex,
        });
      }
    }
  }

  return pairs;
}

/**
 * Verify that two token windows actually match (eliminate hash collisions).
 * Returns a similarity ratio (0–1).
 * @param {string[]} tokensA
 * @param {string[]} tokensB
 * @param {number} startA
 * @param {number} startB
 * @param {number} windowSize
 * @returns {number}
 */
export function verifyMatch(tokensA, tokensB, startA, startB, windowSize) {
  let matches = 0;
  const end = windowSize;
  for (let i = 0; i < end; i++) {
    if (tokensA[startA + i] === tokensB[startB + i]) matches++;
  }
  return matches / windowSize;
}

/**
 * Collect all source files under a directory.
 * @param {string} dir
 * @param {object} options
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<string[]>}
 */
async function collectFiles(dir, options = {}) {
  const { exclude = [], languages } = options;
  const allowedExts = languages
    ? languages.flatMap((l) => LANGUAGE_EXTENSIONS[l] ?? [])
    : Object.values(LANGUAGE_EXTENSIONS).flat();

  const results = [];

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = full.slice(dir.length + 1);

      const excluded = exclude.some((pattern) => {
        const re = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '@@GLOBSTAR@@')
          .replace(/\*/g, '[^/]*')
          .replace(/@@GLOBSTAR@@/g, '.*');
        return new RegExp(`^${re}$`).test(rel) || new RegExp(`^${re}$`).test(entry.name);
      });
      if (excluded) continue;

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && allowedExts.includes(extname(entry.name))) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

/**
 * Map token index to line number in source content using exact character positions.
 * @param {string} content
 * @param {Array<{token: string, pos: number}>} tokenPositions - tokens with start char positions
 * @param {number} tokenIndex
 * @returns {number} 0-based line number
 */
function tokenIndexToLine(content, tokenPositions, tokenIndex) {
  if (tokenIndex >= tokenPositions.length) return 0;
  const charPos = tokenPositions[tokenIndex].pos;
  return content.slice(0, charPos).split('\n').length - 1;
}

/**
 * Scan for duplicate code blocks using Rabin-Karp rolling hash.
 * @param {string} path - Directory to scan
 * @param {object} [options]
 * @param {number} [options.minTokens=50] - Minimum token window size
 * @param {number} [options.similarity=0.80] - Minimum similarity ratio
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array<{check: string, fileA: string, fileB: string, startLineA: number, endLineA: number, startLineB: number, endLineB: number, similarity: number, tokenCount: number}>>}
 */
export async function scanDuplicates(path, options = {}) {
  const { minTokens = 50, similarity: minSimilarity = 0.8, exclude, languages } = options;

  const files = await collectFiles(path, { exclude, languages });

  // Tokenize and normalise each file
  const fileTokenData = [];
  for (const file of files) {
    let content;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const tokenPositions = tokenizeWithPositions(content);
    const raw = tokenPositions.map((t) => t.token);
    const normalised = normalizeTokens(raw);
    if (normalised.length < minTokens) continue;
    fileTokenData.push({ file, content, tokenPositions, raw, normalised });
  }

  if (fileTokenData.length < 2) return [];

  // Compute rolling hashes for each file
  const hashMaps = fileTokenData.map(({ file, normalised }) => ({
    file,
    hashes: rollingHash(normalised, minTokens),
  }));

  // Find candidate pairs by hash collision
  const candidates = findMatches(hashMaps);

  const findings = [];
  const emitted = new Set();

  for (const { fileA, fileB, startA, endA, startB, endB } of candidates) {
    const dataA = fileTokenData.find((d) => d.file === fileA);
    const dataB = fileTokenData.find((d) => d.file === fileB);
    if (!dataA || !dataB) continue;

    const sim = verifyMatch(dataA.normalised, dataB.normalised, startA, startB, minTokens);
    if (sim < minSimilarity) continue;

    // Dedup: same pair of files + overlapping regions
    const key = `${fileA}|${fileB}|${startA}|${startB}`;
    if (emitted.has(key)) continue;
    emitted.add(key);

    const startLineA = tokenIndexToLine(dataA.content, dataA.tokenPositions, startA);
    const endLineA = tokenIndexToLine(dataA.content, dataA.tokenPositions, endA);
    const startLineB = tokenIndexToLine(dataB.content, dataB.tokenPositions, startB);
    const endLineB = tokenIndexToLine(dataB.content, dataB.tokenPositions, endB);

    findings.push({
      check: 'duplicate',
      fileA,
      fileB,
      startLineA,
      endLineA,
      startLineB,
      endLineB,
      similarity: Math.round(sim * 100) / 100,
      tokenCount: minTokens,
    });
  }

  return findings;
}
