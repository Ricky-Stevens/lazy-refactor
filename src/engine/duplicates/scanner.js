import { readFile } from "node:fs/promises";
import { collectFiles } from "../files.js";
import { clusterDuplicates } from "./clustering.js";
import { findMatches, rollingHash, verifyMatch } from "./hashing.js";
import { normalizeTokens, tokenizeWithPositions } from "./tokenizer.js";

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
