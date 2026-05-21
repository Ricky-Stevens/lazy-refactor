import { readFile } from "node:fs/promises";
import { collectFiles } from "./files.js";

// Rabin-Karp constants
const RK_BASE = 31;
const RK_MOD = 1_000_000_007;

// BigInt versions for overflow-safe modular arithmetic in rollingHash
const BIG_BASE = BigInt(RK_BASE);
const BIG_MOD = BigInt(RK_MOD);

// Keywords to preserve as-is during normalisation
const KEYWORDS = new Set([
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
  // The loop condition `i + windowSize <= tokens.length` ensures we emit a
  // window for the final valid position (previous `<` form was off-by-one and
  // dropped the last window).
  for (let i = 1; i + windowSize <= tokens.length; i++) {
    const leaving = tokenValue(tokens[i - 1]);
    const entering = tokenValue(tokens[i + windowSize - 1]);
    hash = ((hash - ((leaving * basePow) % BIG_MOD) + BIG_MOD) * BIG_BASE + entering) % BIG_MOD;
    result.push({ hash: Number(hash), startIndex: i, endIndex: i + windowSize - 1 });
  }

  return result;
}

/**
 * Hash comparison across files. Returns candidate pairs where the same hash
 * appears in two distinct hash entries. Cross-file pairs are always emitted;
 * intra-file pairs are emitted only when the two windows are at least
 * `windowSize` tokens apart (so overlapping windows over the same code are
 * not reported as duplicates of themselves).
 *
 * @param {Array<{file: string, hashes: Array<{hash: number, startIndex: number, endIndex: number}>}>} hashMaps
 * @param {number} [windowSize=50] - Minimum index distance between two
 *   intra-file windows for them to count as a duplicate pair.
 * @returns {Array<{fileA: string, fileB: string, startA: number, endA: number, startB: number, endB: number}>}
 */
export function findMatches(hashMaps, windowSize = 50) {
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
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        if (a.file === b.file) {
          // Same-file pair: require non-overlapping windows so we don't
          // report a window against itself or its neighbour.
          if (Math.abs(a.startIndex - b.startIndex) < windowSize) continue;
        }
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
 * Map token index to line number in source content using exact character positions.
 * @param {string} content
 * @param {Array<{token: string, pos: number}>} tokenPositions - tokens with start char positions
 * @param {number} tokenIndex
 * @returns {number} 0-based line number
 */
function tokenIndexToLine(content, tokenPositions, tokenIndex) {
  if (tokenIndex >= tokenPositions.length) return 0;
  const charPos = tokenPositions[tokenIndex].pos;
  return content.slice(0, charPos).split("\n").length - 1;
}

/**
 * Group pairwise duplicate findings into clusters using union-find (disjoint sets).
 * Two files/regions are in the same cluster if they share at least one duplicate pair.
 * Each region is keyed by "file:startLine-endLine".
 *
 * @param {Array<{check: string, fileA: string, fileB: string, startLineA: number, endLineA: number, startLineB: number, endLineB: number, similarity: number, tokenCount: number}>} matches
 * @returns {Array<{check: string, files: Array<{file: string, startLine: number, endLine: number}>, representativePair: {fileA: string, startLineA: number, endLineA: number, fileB: string, startLineB: number, endLineB: number}, memberCount: number, avgSimilarity: number, avgTokenCount: number}>}
 */
export function clusterDuplicates(matches) {
  if (!matches || matches.length === 0) return [];

  // Union-Find data structure
  const parent = new Map();
  const rank = new Map();

  function find(x) {
    if (!parent.has(x)) {
      parent.set(x, x);
      rank.set(x, 0);
    }
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x))); // path compression
    }
    return parent.get(x);
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const rankA = rank.get(ra);
    const rankB = rank.get(rb);
    if (rankA < rankB) {
      parent.set(ra, rb);
    } else if (rankA > rankB) {
      parent.set(rb, ra);
    } else {
      parent.set(rb, ra);
      rank.set(ra, rankA + 1);
    }
  }

  // Region metadata keyed by regionKey
  const regionMeta = new Map();

  function regionKey(file, startLine, endLine) {
    return `${file}:${startLine}-${endLine}`;
  }

  // Build union-find from pairs
  for (const m of matches) {
    const keyA = regionKey(m.fileA, m.startLineA, m.endLineA);
    const keyB = regionKey(m.fileB, m.startLineB, m.endLineB);
    regionMeta.set(keyA, { file: m.fileA, startLine: m.startLineA, endLine: m.endLineA });
    regionMeta.set(keyB, { file: m.fileB, startLine: m.startLineB, endLine: m.endLineB });
    union(keyA, keyB);
  }

  // Group regions by their root
  const groups = new Map();
  for (const key of regionMeta.keys()) {
    const root = find(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(key);
  }

  // Collect per-cluster similarity and token count from the original pairs
  const clusterStats = new Map();
  for (const m of matches) {
    const root = find(regionKey(m.fileA, m.startLineA, m.endLineA));
    if (!clusterStats.has(root)) clusterStats.set(root, { totalSim: 0, totalTokens: 0, count: 0 });
    const stats = clusterStats.get(root);
    stats.totalSim += m.similarity;
    stats.totalTokens += m.tokenCount;
    stats.count++;
  }

  // Build cluster findings
  const clusters = [];
  for (const [root, keys] of groups) {
    if (keys.length < 2) continue; // single region, no cluster

    const files = keys.map((k) => regionMeta.get(k));
    const stats = clusterStats.get(root) || { totalSim: 0, totalTokens: 0, count: 1 };

    // Pick the first pair that belongs to this cluster as representative
    const repPair = matches.find(
      (m) => find(regionKey(m.fileA, m.startLineA, m.endLineA)) === root,
    );

    clusters.push({
      check: "duplicate-cluster",
      files,
      representativePair: repPair
        ? {
            fileA: repPair.fileA,
            startLineA: repPair.startLineA,
            endLineA: repPair.endLineA,
            fileB: repPair.fileB,
            startLineB: repPair.startLineB,
            endLineB: repPair.endLineB,
          }
        : null,
      memberCount: files.length,
      avgSimilarity: Math.round((stats.totalSim / stats.count) * 100) / 100,
      avgTokenCount: Math.round(stats.totalTokens / stats.count),
    });
  }

  return clusters;
}

/**
 * Scan for duplicate code blocks using Rabin-Karp rolling hash.
 *
 * Returns an array of findings. Each finding has `check: 'duplicate'` (raw pair)
 * or `check: 'duplicate-cluster'` (cluster summary). Raw pairs are always present;
 * cluster summaries are appended when pairs can be grouped into clusters of 2+
 * distinct regions. Callers that only care about raw pairs can filter by
 * `check === 'duplicate'`.
 *
 * @param {string} path - Directory to scan
 * @param {object} [options]
 * @param {number} [options.minTokens=50] - Minimum token window size
 * @param {number} [options.similarity=0.80] - Minimum similarity ratio
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array<{check: string, fileA?: string, fileB?: string, startLineA?: number, endLineA?: number, startLineB?: number, endLineB?: number, similarity?: number, tokenCount?: number, files?: Array, representativePair?: object, memberCount?: number, avgSimilarity?: number, avgTokenCount?: number}>>}
 */
export async function scanDuplicates(path, options = {}) {
  const { minTokens = 50, similarity: minSimilarity = 0.8, exclude, languages } = options;

  const files = await collectFiles(path, { exclude, languages });

  // Tokenize and normalise each file
  const fileTokenData = [];
  for (const file of files) {
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const tokenPositions = tokenizeWithPositions(content);
    const raw = tokenPositions.map((t) => t.token);
    const normalised = normalizeTokens(raw);
    if (normalised.length < minTokens) continue;
    fileTokenData.push({ file, content, tokenPositions, raw, normalised });
  }

  if (fileTokenData.length < 1) return [];

  // Compute rolling hashes for each file
  const hashMaps = fileTokenData.map(({ file, normalised }) => ({
    file,
    hashes: rollingHash(normalised, minTokens),
  }));

  // Find candidate pairs by hash collision. Pass minTokens so intra-file
  // pairs require non-overlapping windows.
  const candidates = findMatches(hashMaps, minTokens);

  const findings = [];
  const emitted = new Set();
  const tokenDataByFile = new Map(fileTokenData.map((d) => [d.file, d]));

  for (const { fileA, fileB, startA, startB } of candidates) {
    const dataA = tokenDataByFile.get(fileA);
    const dataB = tokenDataByFile.get(fileB);
    if (!dataA || !dataB) continue;

    const sim = verifyMatch(dataA.normalised, dataB.normalised, startA, startB, minTokens);
    if (sim < minSimilarity) continue;

    // Extend the match forward past the minimum window for as long as the
    // normalised tokens still match exactly. This gives the finding the true
    // duplicate extent instead of always reporting `minTokens`.
    let extent = minTokens;
    while (
      startA + extent < dataA.normalised.length &&
      startB + extent < dataB.normalised.length &&
      dataA.normalised[startA + extent] === dataB.normalised[startB + extent]
    ) {
      extent++;
    }

    // Dedup: same pair of files + same start positions
    const key = `${fileA}|${fileB}|${startA}|${startB}`;
    if (emitted.has(key)) continue;
    emitted.add(key);

    const extendedEndA = startA + extent - 1;
    const extendedEndB = startB + extent - 1;

    const startLineA = tokenIndexToLine(dataA.content, dataA.tokenPositions, startA);
    const endLineA = tokenIndexToLine(dataA.content, dataA.tokenPositions, extendedEndA);
    const startLineB = tokenIndexToLine(dataB.content, dataB.tokenPositions, startB);
    const endLineB = tokenIndexToLine(dataB.content, dataB.tokenPositions, extendedEndB);

    findings.push({
      check: "duplicate",
      fileA,
      fileB,
      startLineA,
      endLineA,
      startLineB,
      endLineB,
      similarity: Math.round(sim * 100) / 100,
      tokenCount: extent,
    });
  }

  // Cluster the raw pairs and append cluster summaries
  const clusters = clusterDuplicates(findings);
  return [...findings, ...clusters];
}
