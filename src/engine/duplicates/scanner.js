import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { collectFiles } from "../files.js";
import { clusterDuplicates } from "./clustering.js";
import { findMatches, rollingHash, verifyMatch } from "./hashing.js";
import {
  classifyRefactoring,
  computeRegionDensities,
  computeStructuralRatio,
  computeTokenDiversity,
  scoreConfidence,
} from "./scoring.js";
import { normalizeTokens, tokenizeWithPositions } from "./tokenizer.js";

const MAX_SNIPPET_LINES = 30;

const TEST_FILE_RE =
  /(?:\.test\.[^.]+|\.spec\.[^.]+|_test\.go|test_[^/]+\.py|[^/]+_test\.py|[^/]+Tests?\.(?:java|cs))$/;

function isTestFile(filePath) {
  return TEST_FILE_RE.test(basename(filePath));
}

function tokenIndexToLine(content, tokenPositions, tokenIndex) {
  if (tokenIndex >= tokenPositions.length) return 0;
  const charPos = tokenPositions[tokenIndex].pos;
  return content.slice(0, charPos).split("\n").length - 1;
}

function extractSnippet(content, startLine, endLine) {
  const lines = content.split("\n");
  const clamped = Math.min(endLine, startLine + MAX_SNIPPET_LINES - 1);
  const slice = lines.slice(startLine, clamped + 1).join("\n");
  if (endLine > clamped) return `${slice}\n// ... ${endLine - clamped} more lines`;
  return slice;
}

function extendMatch(normA, normB, startA, startB, minTokens) {
  let extent = minTokens;
  while (
    startA + extent < normA.length &&
    startB + extent < normB.length &&
    normA[startA + extent] === normB[startB + extent]
  ) {
    extent++;
  }
  return extent;
}

function buildFinding(dataA, dataB, startA, startB, extent, sim) {
  const extendedEndA = startA + extent - 1;
  const extendedEndB = startB + extent - 1;

  const ratioA = computeStructuralRatio(dataA.normalised, startA, extent);
  const ratioB = computeStructuralRatio(dataB.normalised, startB, extent);
  const structuralRatio = Math.round(((ratioA + ratioB) / 2) * 1000) / 1000;

  const divA = computeTokenDiversity(dataA.normalised, startA, extent);
  const divB = computeTokenDiversity(dataB.normalised, startB, extent);
  const tokenDiversity = Math.round(((divA + divB) / 2) * 1000) / 1000;

  const startLineA = tokenIndexToLine(dataA.content, dataA.tokenPositions, startA);
  const endLineA = tokenIndexToLine(dataA.content, dataA.tokenPositions, extendedEndA);
  const startLineB = tokenIndexToLine(dataB.content, dataB.tokenPositions, startB);
  const endLineB = tokenIndexToLine(dataB.content, dataB.tokenPositions, extendedEndB);

  const category = classifyRefactoring(dataA.normalised, startA, extent, structuralRatio);

  return {
    check: "duplicate",
    fileA: dataA.file,
    fileB: dataB.file,
    startLineA,
    endLineA,
    startLineB,
    endLineB,
    similarity: Math.round(sim * 100) / 100,
    tokenCount: extent,
    structuralRatio,
    tokenDiversity,
    confidence: 0,
    category,
    snippet: extractSnippet(dataA.content, startLineA, endLineA),
  };
}

async function tokenizeFile(file, minTokens) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const tokenPositions = tokenizeWithPositions(content);
  const raw = tokenPositions.map((t) => t.token);
  const normalised = normalizeTokens(raw);
  if (normalised.length < minTokens) return null;
  return { file, content, tokenPositions, raw, normalised };
}

function normalizeCandidate(c) {
  if (c.fileA === c.fileB) {
    if (c.startA > c.startB) {
      return {
        fileA: c.fileA,
        fileB: c.fileB,
        startA: c.startB,
        startB: c.startA,
        endA: c.endB,
        endB: c.endA,
      };
    }
    return c;
  }
  if (c.fileA > c.fileB) {
    return {
      fileA: c.fileB,
      fileB: c.fileA,
      startA: c.startB,
      startB: c.startA,
      endA: c.endB,
      endB: c.endA,
    };
  }
  return c;
}

function isOverlapping(ranges, startA, startB) {
  for (const r of ranges) {
    if (startA >= r.startA && startA < r.endA) return true;
    if (startB >= r.startB && startB < r.endB) return true;
  }
  return false;
}

/**
 * Enrich cluster findings with impact scoring and representative context.
 * Mutates clusters in place.
 */
function enrichClusters(clusters, pairFindings) {
  for (const cluster of clusters) {
    const rep = cluster.representativePair;
    if (!rep) continue;
    const repFinding = pairFindings.find(
      (f) =>
        f.fileA === rep.fileA &&
        f.startLineA === rep.startLineA &&
        f.fileB === rep.fileB &&
        f.startLineB === rep.startLineB,
    );

    const linesPerRegion = cluster.files.map((r) => r.endLine - r.startLine + 1);
    const totalDuplicatedLines = linesPerRegion.reduce((sum, n) => sum + n, 0);
    const filesAffected = new Set(cluster.files.map((r) => r.file)).size;

    cluster.totalDuplicatedLines = totalDuplicatedLines;
    cluster.filesAffected = filesAffected;
    cluster.impact = Math.round(filesAffected * cluster.avgSimilarity * totalDuplicatedLines) / 100;
    cluster.category = repFinding?.category ?? "extract-function";
    cluster.snippet = repFinding?.snippet ?? null;
  }
  clusters.sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0));
}

/**
 * Scan for duplicate code blocks using Rabin-Karp rolling hash with
 * structural-entropy confidence scoring.
 *
 * Each pair finding includes:
 * - `confidence`       — 0–1 likelihood this is actionable duplication
 * - `category`         — refactoring hint: extract-function, extract-and-share,
 *                        extract-wrapper, or extract-config
 * - `snippet`          — source code of side A (up to 30 lines)
 *
 * Each cluster finding includes:
 * - `impact`           — prioritisation score (filesAffected × avgSimilarity × totalLines)
 * - `totalDuplicatedLines` — sum of line spans across all cluster members
 * - `filesAffected`    — count of distinct files in the cluster
 * - `category`         — inherited from representative pair
 * - `snippet`          — representative source code
 *
 * @param {string} path - Directory to scan
 * @param {object} [options]
 * @param {number}   [options.minTokens=100]     - Minimum token window size
 * @param {number}   [options.similarity=0.80]    - Minimum similarity ratio
 * @param {number}   [options.minLines=5]         - Minimum source-line span to report
 * @param {number}   [options.minConfidence=0.5]  - Minimum confidence to include
 * @param {boolean}  [options.excludeTests=true]  - Skip test files
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array>}
 */
export async function scanDuplicates(path, options = {}) {
  const {
    minTokens = 100,
    similarity: minSimilarity = 0.8,
    minLines = 5,
    minConfidence = 0.5,
    excludeTests = true,
    exclude,
    languages,
  } = options;

  let files = await collectFiles(path, { exclude, languages });
  if (excludeTests) files = files.filter((f) => !isTestFile(f));

  const CONCURRENCY = 32;
  const fileTokenData = [];
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((f) => tokenizeFile(f, minTokens)));
    for (const data of results) {
      if (data) fileTokenData.push(data);
    }
  }

  if (fileTokenData.length < 1) return [];

  const hashMaps = fileTokenData.map(({ file, normalised }) => ({
    file,
    hashes: rollingHash(normalised, minTokens),
  }));

  const candidates = findMatches(hashMaps, minTokens);

  const sorted = candidates.map(normalizeCandidate);
  sorted.sort((a, b) => {
    if (a.fileA < b.fileA) return -1;
    if (a.fileA > b.fileA) return 1;
    if (a.fileB < b.fileB) return -1;
    if (a.fileB > b.fileB) return 1;
    return a.startA - b.startA;
  });

  const rawFindings = [];
  const covered = new Map();
  const tokenDataByFile = new Map(fileTokenData.map((d) => [d.file, d]));

  for (const { fileA, fileB, startA, startB } of sorted) {
    const dataA = tokenDataByFile.get(fileA);
    const dataB = tokenDataByFile.get(fileB);
    if (!dataA || !dataB) continue;

    const pairKey = `${fileA}|${fileB}`;
    const ranges = covered.get(pairKey);
    if (ranges && isOverlapping(ranges, startA, startB)) continue;

    const sim = verifyMatch(dataA.normalised, dataB.normalised, startA, startB, minTokens);
    if (sim < minSimilarity) continue;

    const extent = extendMatch(dataA.normalised, dataB.normalised, startA, startB, minTokens);
    const finding = buildFinding(dataA, dataB, startA, startB, extent, sim);

    if (finding.endLineA - finding.startLineA + 1 < minLines) continue;

    if (!covered.has(pairKey)) covered.set(pairKey, []);
    covered.get(pairKey).push({ startA, endA: startA + extent, startB, endB: startB + extent });

    rawFindings.push(finding);
  }

  const densities = computeRegionDensities(rawFindings);
  for (const f of rawFindings) {
    const keyA = `${f.fileA}:${f.startLineA}-${f.endLineA}`;
    const keyB = `${f.fileB}:${f.startLineB}-${f.endLineB}`;
    const density = Math.max(densities.get(keyA) || 1, densities.get(keyB) || 1);
    f.confidence = scoreConfidence(f.structuralRatio, f.tokenDiversity, density, f.similarity);
  }

  const findings = rawFindings.filter((f) => f.confidence >= minConfidence);
  const clusters = clusterDuplicates(findings);
  enrichClusters(clusters, findings);
  return [...findings, ...clusters];
}
