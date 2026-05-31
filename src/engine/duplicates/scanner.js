import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { collectFiles } from "../files.js";
import { clusterDuplicates } from "./clustering.js";
import { findMatches, rollingHash, verifyMatch } from "./hashing.js";
import {
  INTRA_CONTAINER_CAP,
  INTRA_CONTAINER_MAX_DIVERSITY,
  INTRA_CONTAINER_MAX_STRUCTURAL,
  sharesEnclosingContainer,
} from "./intra-container.js";
import {
  classifyRefactoring,
  computeRegionDensities,
  computeStructuralRatio,
  computeTokenDiversity,
  scoreConfidence,
} from "./scoring.js";
import { NUMBER_RE, normalizeTokens, STRING_SENTINEL, tokenizeWithPositions } from "./tokenizer.js";
import { scanStringLiteral } from "./tokenizer-helpers.js";

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

// Recover a literal's actual source text. Numbers/identifiers keep their value in
// the raw token; strings are tokenized to a content-free sentinel (so near-dup
// strings hash equal), so the source slice is re-read from the original position.
function literalSource(data, idx) {
  const raw = data.raw[idx];
  if (raw !== STRING_SENTINEL) return raw;
  const { pos } = data.tokenPositions[idx];
  const end = scanStringLiteral(data.content, pos, data.content.length, data.content[pos]);
  return data.content.slice(pos, end);
}

/**
 * Detect positions where the two matched windows share token STRUCTURE but differ
 * in a string or number LITERAL — the silent-behaviour-change trap. The tokenizer
 * collapses every string to one sentinel, so two blocks differing only in string
 * content score similarity 1.0 and look safely mergeable; a fixer that dedups them
 * by collapsing to one value changes behaviour (the error-message and Tailwind-tint
 * regressions). Reporting these lets the fixer parameterise the differing literals
 * instead of picking one. Identifier-only divergence is the ordinary extract-and-
 * rename case and is intentionally NOT counted here.
 * @returns {{ count: number, samples: Array<{a: string, b: string}> }}
 */
function computeLiteralDivergence(dataA, dataB, startA, startB, extent) {
  let count = 0;
  const samples = [];
  for (let i = 0; i < extent; i++) {
    const ia = startA + i;
    const ib = startB + i;
    const ra = dataA.raw[ia];
    const rb = dataB.raw[ib];
    const bothStr = ra === STRING_SENTINEL && rb === STRING_SENTINEL;
    const bothNum = NUMBER_RE.test(ra) && NUMBER_RE.test(rb);
    if (!bothStr && !bothNum) continue;
    const va = literalSource(dataA, ia);
    const vb = literalSource(dataB, ib);
    if (va !== vb) {
      count++;
      if (samples.length < 3) samples.push({ a: va, b: vb });
    }
  }
  return { count, samples };
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

  const { count: divergentLiterals, samples: divergenceSamples } = computeLiteralDivergence(
    dataA,
    dataB,
    startA,
    startB,
    extent,
  );

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
    divergentLiterals,
    divergenceSamples,
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
    cluster.divergentLiterals = repFinding?.divergentLiterals ?? 0;
    cluster.divergenceSamples = repFinding?.divergenceSamples ?? [];
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

    // Same-file repetition fully nested in one container is intra-structure, not
    // extractable duplication — flag it so its confidence is capped below.
    if (fileA === fileB && sharesEnclosingContainer(dataA.normalised, startA, startB + extent)) {
      finding.intraContainer = true;
    }

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
    // Cap ONLY data-like intra-structure repetition — both structural ratio AND
    // token diversity must read as data. Real logic copy-paste inside one container
    // (even straight-line assignment code, which has a low structural ratio) keeps
    // high diversity and stays at full confidence — it's extractable, which is
    // exactly what the tool is here to surface.
    if (f.intraContainer) {
      const dataLike =
        f.structuralRatio < INTRA_CONTAINER_MAX_STRUCTURAL &&
        f.tokenDiversity < INTRA_CONTAINER_MAX_DIVERSITY;
      if (dataLike) f.confidence = Math.min(f.confidence, INTRA_CONTAINER_CAP);
      delete f.intraContainer;
    }
  }

  const findings = rawFindings.filter((f) => f.confidence >= minConfidence);
  const clusters = clusterDuplicates(findings);
  enrichClusters(clusters, findings);
  return [...findings, ...clusters];
}
