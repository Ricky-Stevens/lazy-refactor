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

  const uf = makeUnionFind();

  // Region metadata keyed by regionKey
  const regionMeta = new Map();

  // Build union-find from pairs
  for (const m of matches) {
    const keyA = regionKey(m.fileA, m.startLineA, m.endLineA);
    const keyB = regionKey(m.fileB, m.startLineB, m.endLineB);
    regionMeta.set(keyA, { file: m.fileA, startLine: m.startLineA, endLine: m.endLineA });
    regionMeta.set(keyB, { file: m.fileB, startLine: m.startLineB, endLine: m.endLineB });
    uf.union(keyA, keyB);
  }

  const groups = buildGroups(regionMeta, uf);
  const clusterStats = collectStats(matches, uf);
  return buildClusters(groups, regionMeta, clusterStats, matches, uf);
}

// ---------------------------------------------------------------------------
// Region key helper
// ---------------------------------------------------------------------------

function regionKey(file, startLine, endLine) {
  return `${file}:${startLine}-${endLine}`;
}

// ---------------------------------------------------------------------------
// Union-Find factory
// ---------------------------------------------------------------------------

function makeUnionFind() {
  const parent = new Map();
  const rank = new Map();

  // Iterative (not recursive) so a pathological parent chain can't overflow the
  // stack; two passes give the same full path compression as the recursive form.
  function find(x) {
    if (!parent.has(x)) {
      parent.set(x, x);
      rank.set(x, 0);
      return x;
    }
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // Point every node on the path directly at the root (path compression).
    let node = x;
    while (node !== root) {
      const next = parent.get(node);
      parent.set(node, root);
      node = next;
    }
    return root;
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

  return { find, union };
}

// ---------------------------------------------------------------------------
// Group and stats helpers
// ---------------------------------------------------------------------------

/**
 * Group region keys by their union-find root.
 * @param {Map<string, object>} regionMeta
 * @param {{find: function}} uf
 * @returns {Map<string, string[]>}
 */
function buildGroups(regionMeta, uf) {
  const groups = new Map();
  for (const key of regionMeta.keys()) {
    const root = uf.find(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(key);
  }
  return groups;
}

/**
 * Collect per-cluster similarity and token-count stats.
 * @param {object[]} matches
 * @param {{find: function}} uf
 * @returns {Map<string, {totalSim: number, totalTokens: number, count: number}>}
 */
function collectStats(matches, uf) {
  const clusterStats = new Map();
  for (const m of matches) {
    const root = uf.find(regionKey(m.fileA, m.startLineA, m.endLineA));
    if (!clusterStats.has(root)) clusterStats.set(root, { totalSim: 0, totalTokens: 0, count: 0 });
    const stats = clusterStats.get(root);
    stats.totalSim += m.similarity;
    stats.totalTokens += m.tokenCount;
    stats.count++;
  }
  return clusterStats;
}

/**
 * Build the final cluster findings from grouped regions.
 * @param {Map<string, string[]>} groups
 * @param {Map<string, object>} regionMeta
 * @param {Map<string, object>} clusterStats
 * @param {object[]} matches
 * @param {{find: function}} uf
 * @returns {object[]}
 */
function buildClusters(groups, regionMeta, clusterStats, matches, uf) {
  const clusters = [];
  for (const [root, keys] of groups) {
    if (keys.length < 2) continue; // single region, no cluster

    const files = keys.map((k) => regionMeta.get(k));
    const stats = clusterStats.get(root) || { totalSim: 0, totalTokens: 0, count: 1 };

    // Pick the first pair that belongs to this cluster as representative
    const repPair = matches.find(
      (m) => uf.find(regionKey(m.fileA, m.startLineA, m.endLineA)) === root,
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
