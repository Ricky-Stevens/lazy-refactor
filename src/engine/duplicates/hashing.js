// Rabin-Karp constants
const RK_BASE = 31;
const RK_MOD = 1_000_000_007;

// BigInt versions for overflow-safe modular arithmetic in rollingHash
const BIG_BASE = BigInt(RK_BASE);
const BIG_MOD = BigInt(RK_MOD);

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
