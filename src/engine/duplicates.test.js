import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clusterDuplicates,
  findMatches,
  normalizeTokens,
  rollingHash,
  scanDuplicates,
  tokenize,
  verifyMatch,
} from "./duplicates.js";

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("splits on whitespace and operators", () => {
    const tokens = tokenize("a + b");
    expect(tokens).toEqual(["a", "+", "b"]);
  });

  it("handles function declaration", () => {
    const tokens = tokenize("function add(x, y) { return x + y; }");
    expect(tokens).toContain("function");
    expect(tokens).toContain("add");
    expect(tokens).toContain("return");
    expect(tokens).toContain("+");
  });

  it("emits string literals as a single STR-sentinel token", () => {
    const tokens = tokenize('"hello world"');
    expect(tokens).toEqual(['"..."']);
  });

  it("handles single-quoted strings", () => {
    const tokens = tokenize("const x = 'foo';");
    expect(tokens).toContain('"..."');
    expect(tokens).not.toContain("foo");
  });

  it("handles backtick strings", () => {
    const tokens = tokenize("const msg = `hello ${name}`;");
    // backtick string is emitted as one sentinel; the interpolated part is consumed
    expect(tokens.filter((t) => t === '"..."').length).toBeGreaterThanOrEqual(1);
  });

  it("strips line comments", () => {
    const tokens = tokenize("x = 1; // this is a comment\ny = 2;");
    expect(tokens).not.toContain("this");
    expect(tokens).not.toContain("comment");
    expect(tokens).toContain("x");
    expect(tokens).toContain("y");
  });

  it("strips block comments", () => {
    const tokens = tokenize("/* block comment */ x = 1;");
    expect(tokens).not.toContain("block");
    expect(tokens).toContain("x");
  });

  it("handles numeric literals", () => {
    const tokens = tokenize("const n = 42;");
    expect(tokens).toContain("42");
  });

  it("handles operators as individual tokens", () => {
    const tokens = tokenize("a === b");
    expect(tokens).toContain("=");
    expect(tokens).toContain("=");
    expect(tokens).toContain("a");
    expect(tokens).toContain("b");
  });
});

// ---------------------------------------------------------------------------
// normalizeTokens
// ---------------------------------------------------------------------------

describe("normalizeTokens", () => {
  it("replaces identifiers with IDENT", () => {
    const result = normalizeTokens(["myVar"]);
    expect(result).toEqual(["IDENT"]);
  });

  it("replaces numbers with NUM", () => {
    const result = normalizeTokens(["42", "3.14", "0xFF"]);
    expect(result).toEqual(["NUM", "NUM", "NUM"]);
  });

  it("replaces string sentinel with STR", () => {
    const result = normalizeTokens(['"..."']);
    expect(result).toEqual(["STR"]);
  });

  it("keeps keywords as-is", () => {
    const keywords = [
      "if",
      "else",
      "for",
      "while",
      "return",
      "function",
      "class",
      "const",
      "let",
      "var",
      "import",
      "export",
    ];
    const result = normalizeTokens(keywords);
    expect(result).toEqual(keywords);
  });

  it("keeps Go keywords as-is", () => {
    const goKeywords = ["func", "defer", "go", "select", "chan", "range"];
    const result = normalizeTokens(goKeywords);
    expect(result).toEqual(goKeywords);
  });

  it("keeps Python keywords as-is", () => {
    const pyKeywords = ["def", "pass", "with", "as", "from", "lambda", "yield"];
    const result = normalizeTokens(pyKeywords);
    expect(result).toEqual(pyKeywords);
  });

  it("keeps operator tokens as-is", () => {
    const ops = ["+", "-", "=", "{", "}", "(", ")", ";"];
    const result = normalizeTokens(ops);
    expect(result).toEqual(ops);
  });

  it("normalises a realistic snippet", () => {
    const tokens = tokenize("function add(x, y) { return x + y; }");
    const normalised = normalizeTokens(tokens);
    expect(normalised).toContain("function");
    expect(normalised).toContain("return");
    expect(normalised).toContain("IDENT");
    expect(normalised).not.toContain("add");
    expect(normalised).not.toContain("x");
    expect(normalised).not.toContain("y");
  });
});

// ---------------------------------------------------------------------------
// rollingHash
// ---------------------------------------------------------------------------

describe("rollingHash", () => {
  it("returns empty array when tokens fewer than window", () => {
    const result = rollingHash(["a", "b"], 5);
    expect(result).toEqual([]);
  });

  it("returns one entry when tokens exactly equal window", () => {
    const tokens = ["a", "b", "c"];
    const result = rollingHash(tokens, 3);
    expect(result).toHaveLength(1);
    expect(result[0].startIndex).toBe(0);
    expect(result[0].endIndex).toBe(2);
  });

  it("returns tokens.length - windowSize + 1 entries", () => {
    const tokens = ["a", "b", "c", "d", "e"];
    const result = rollingHash(tokens, 3);
    expect(result).toHaveLength(3);
  });

  it("produces the same hash for identical token windows", () => {
    const tokensA = ["if", "IDENT", "===", "NUM", "{", "return", "NUM", "}"];
    const tokensB = ["if", "IDENT", "===", "NUM", "{", "return", "NUM", "}"];
    const hashA = rollingHash(tokensA, 4);
    const hashB = rollingHash(tokensB, 4);
    // First windows should have identical hashes
    expect(hashA[0].hash).toBe(hashB[0].hash);
  });

  it("produces different hashes for different token windows", () => {
    const tokensA = ["if", "IDENT", "===", "NUM"];
    const tokensB = ["while", "IDENT", "!==", "STR"];
    const hashA = rollingHash(tokensA, 4);
    const hashB = rollingHash(tokensB, 4);
    expect(hashA[0].hash).not.toBe(hashB[0].hash);
  });

  it("consecutive windows share overlapping token positions", () => {
    const tokens = ["a", "b", "c", "d"];
    const result = rollingHash(tokens, 3);
    expect(result[0]).toEqual({ hash: expect.any(Number), startIndex: 0, endIndex: 2 });
    expect(result[1]).toEqual({ hash: expect.any(Number), startIndex: 1, endIndex: 3 });
  });

  it("sliding hash matches a hash computed from scratch for the same window", () => {
    // Build a token sequence long enough to slide several positions
    const tokens = ["if", "IDENT", "===", "NUM", "{", "return", "STR", "}", "else", "IDENT"];
    const windowSize = 4;
    const slid = rollingHash(tokens, windowSize);

    // For every window position, compute the hash from scratch and compare
    for (let start = 0; start < slid.length; start++) {
      const window = tokens.slice(start, start + windowSize);
      const [scratch] = rollingHash(window, windowSize);
      expect(slid[start].hash).toBe(scratch.hash);
    }
  });
});

// ---------------------------------------------------------------------------
// verifyMatch
// ---------------------------------------------------------------------------

describe("verifyMatch", () => {
  it("returns 1.0 for identical windows", () => {
    const tokens = ["if", "IDENT", "===", "NUM", "return"];
    const sim = verifyMatch(tokens, tokens, 0, 0, 5);
    expect(sim).toBe(1.0);
  });

  it("returns 0.0 for completely different windows", () => {
    const a = ["a", "b", "c", "d"];
    const b = ["w", "x", "y", "z"];
    const sim = verifyMatch(a, b, 0, 0, 4);
    expect(sim).toBe(0.0);
  });

  it("returns intermediate value for partial match", () => {
    const a = ["a", "b", "c", "d"];
    const b = ["a", "b", "x", "y"];
    const sim = verifyMatch(a, b, 0, 0, 4);
    expect(sim).toBe(0.5);
  });

  it("respects startIndex offsets", () => {
    const a = ["x", "y", "a", "b"];
    const b = ["m", "n", "a", "b"];
    const sim = verifyMatch(a, b, 2, 2, 2);
    expect(sim).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// findMatches
// ---------------------------------------------------------------------------

describe("findMatches", () => {
  it("returns empty array when no cross-file matches", () => {
    const hashMaps = [
      { file: "a.js", hashes: [{ hash: 1, startIndex: 0, endIndex: 4 }] },
      { file: "b.js", hashes: [{ hash: 2, startIndex: 0, endIndex: 4 }] },
    ];
    expect(findMatches(hashMaps)).toHaveLength(0);
  });

  it("finds a pair when both files share a hash", () => {
    const hashMaps = [
      { file: "a.js", hashes: [{ hash: 42, startIndex: 0, endIndex: 4 }] },
      { file: "b.js", hashes: [{ hash: 42, startIndex: 10, endIndex: 14 }] },
    ];
    const pairs = findMatches(hashMaps);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].fileA).toBe("a.js");
    expect(pairs[0].fileB).toBe("b.js");
  });

  it("does not report same-file matches", () => {
    const hashMaps = [
      {
        file: "a.js",
        hashes: [
          { hash: 42, startIndex: 0, endIndex: 4 },
          { hash: 42, startIndex: 10, endIndex: 14 },
        ],
      },
    ];
    expect(findMatches(hashMaps)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scanDuplicates end-to-end
// ---------------------------------------------------------------------------

describe("scanDuplicates integration", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dup-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Build a code block that, when tokenised and normalised, produces >= 50 tokens
  function makeCodeBlock(varA, varB, returnVal) {
    return `
function compute(${varA}, ${varB}) {
  const result = ${varA} + ${varB};
  const doubled = result * 2;
  const squared = doubled * doubled;
  const clamped = squared > 1000 ? 1000 : squared;
  const offset = clamped - 5;
  const scaled = offset * 3;
  const final = scaled + ${returnVal};
  if (final > 100) {
    return final - 100;
  }
  return final;
}
`.trim();
  }

  it("detects two files with same logic but different variable names as duplicates", async () => {
    const subDir = join(dir, "dup-basic");
    await mkdir(subDir, { recursive: true });

    await writeFile(join(subDir, "fileA.js"), makeCodeBlock("alpha", "beta", "alpha"));
    await writeFile(join(subDir, "fileB.js"), makeCodeBlock("foo", "bar", "foo"));

    const allFindings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7 });
    const findings = allFindings.filter((f) => f.check === "duplicate");
    expect(findings.length).toBeGreaterThan(0);
    const files = findings.flatMap((f) => [f.fileA, f.fileB]);
    expect(files.some((f) => f.endsWith("fileA.js"))).toBe(true);
    expect(files.some((f) => f.endsWith("fileB.js"))).toBe(true);
  });

  it("respects the similarity threshold — below threshold is not flagged", async () => {
    const subDir = join(dir, "dup-threshold");
    await mkdir(subDir, { recursive: true });

    // File A: standard block
    await writeFile(join(subDir, "a.js"), makeCodeBlock("x", "y", "x"));
    // File B: completely different content
    await writeFile(
      join(subDir, "b.js"),
      `
class EventEmitter {
  constructor() { this.listeners = {}; }
  on(event, handler) { (this.listeners[event] = this.listeners[event] || []).push(handler); }
  emit(event, data) { (this.listeners[event] || []).forEach(h => h(data)); }
  off(event, handler) { this.listeners[event] = (this.listeners[event] || []).filter(h => h !== handler); }
  once(event, handler) { const wrap = (d) => { handler(d); this.off(event, wrap); }; this.on(event, wrap); }
}
`.trim(),
    );

    const allFindings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.95 });
    // With high similarity threshold, the very different file should not match
    const findings = allFindings.filter((f) => f.check === "duplicate");
    expect(findings).toHaveLength(0);
  });

  it("does not flag blocks shorter than minTokens", async () => {
    const subDir = join(dir, "dup-minTokens");
    await mkdir(subDir, { recursive: true });

    // Tiny blocks — same content, but far fewer than minTokens=100
    const tiny = "function tiny() { return 1; }";
    await writeFile(join(subDir, "tiny1.js"), tiny);
    await writeFile(join(subDir, "tiny2.js"), tiny);

    // minTokens set high so these blocks are not considered
    const allFindings = await scanDuplicates(subDir, { minTokens: 100, similarity: 0.8 });
    const findings = allFindings.filter((f) => f.check === "duplicate");
    expect(findings).toHaveLength(0);
  });

  it("finding shape has required fields", async () => {
    const subDir = join(dir, "dup-shape");
    await mkdir(subDir, { recursive: true });

    await writeFile(join(subDir, "x.js"), makeCodeBlock("a", "b", "a"));
    await writeFile(join(subDir, "y.js"), makeCodeBlock("p", "q", "p"));

    const allFindings = await scanDuplicates(subDir, { minTokens: 10, similarity: 0.7 });
    const pairFindings = allFindings.filter((f) => f.check === "duplicate");
    expect(pairFindings.length).toBeGreaterThan(0);
    for (const f of pairFindings) {
      expect(f.check).toBe("duplicate");
      expect(typeof f.fileA).toBe("string");
      expect(typeof f.fileB).toBe("string");
      expect(typeof f.startLineA).toBe("number");
      expect(typeof f.endLineA).toBe("number");
      expect(typeof f.startLineB).toBe("number");
      expect(typeof f.endLineB).toBe("number");
      expect(typeof f.similarity).toBe("number");
      expect(f.similarity).toBeGreaterThanOrEqual(0);
      expect(f.similarity).toBeLessThanOrEqual(1);
      expect(typeof f.tokenCount).toBe("number");
    }
  });

  it("returns empty array when no files have enough tokens", async () => {
    const subDir = join(dir, "dup-none");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "tiny.js"), "const x = 1;");

    const allFindings = await scanDuplicates(subDir, { minTokens: 100 });
    expect(allFindings).toHaveLength(0);
  });

  it("reports accurate line numbers for blocks with repeated short tokens", async () => {
    const subDir = join(dir, "dup-lines");
    await mkdir(subDir, { recursive: true });

    // Shared block uses a structurally unique mix of keywords so its normalised form
    // cannot match the preamble lines (which are all `const IDENT = { IDENT : NUM } ;`).
    // This lets us isolate findings that come from the shared block itself.
    const sharedBlock = [
      "if (a > 0) {",
      "  while (b < 10) {",
      "    for (let i = 0; i < b; i++) {",
      "      try {",
      "        return a + b + i;",
      "      } catch (e) {",
      "        throw e;",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n");

    // File A: 5 preamble lines then the block (block starts at line 5, 0-based)
    const preambleA = [
      "const pa1 = { x: 1 };",
      "const pa2 = { y: 2 };",
      "const pa3 = { z: 3 };",
      "const pa4 = { w: 4 };",
      "const pa5 = { v: 5 };",
    ].join("\n");

    // File B: 2 preamble lines then the block (block starts at line 2, 0-based)
    const preambleB = ["const pb1 = { a: 10 };", "const pb2 = { b: 20 };"].join("\n");

    const contentA = `${preambleA}\n${sharedBlock}`;
    const contentB = `${preambleB}\n${sharedBlock}`;

    await writeFile(join(subDir, "la.js"), contentA);
    await writeFile(join(subDir, "lb.js"), contentB);

    // minTokens=20: the shared block has ~52 normalised tokens so it definitely fires.
    // Use a lower similarity threshold since normalisation makes it 1.0 anyway.
    const allFindings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.9 });
    const findings = allFindings.filter((f) => f.check === "duplicate");
    expect(findings.length).toBeGreaterThan(0);

    // All findings should have end >= start in both files
    for (const f of findings) {
      expect(f.endLineA).toBeGreaterThanOrEqual(f.startLineA);
      expect(f.endLineB).toBeGreaterThanOrEqual(f.startLineB);
    }

    // Findings whose windows land inside the shared block must show the preamble offset.
    // File A preamble = 5 lines → block at line 5+; File B preamble = 2 lines → block at line 2+.
    // So any finding from within the shared block satisfies startLineA >= 5 and startLineB >= 2,
    // and critically startLineA > startLineB (offset difference = 3 lines).
    const blockFindings = findings.filter((f) => f.startLineA >= 5 && f.startLineB >= 2);
    expect(blockFindings.length).toBeGreaterThan(0);

    for (const f of blockFindings) {
      // The preamble offset difference between the two files is 3 lines (5 vs 2).
      // fileA/fileB assignment order is not guaranteed, so check the absolute difference.
      expect(Math.abs(f.startLineA - f.startLineB)).toBe(3);
    }
  });

  it("finds intra-file duplicates when blocks are far apart", async () => {
    const subDir = join(dir, "dup-intra");
    await mkdir(subDir, { recursive: true });

    // Two identical code blocks separated by enough different code
    // that the windows don't overlap
    const block = makeCodeBlock("a", "b", "a");
    const filler = Array.from(
      { length: 40 },
      (_, i) => `const unique${i} = ${i} * ${i + 7} + ${i * 3};`,
    ).join("\n");

    // fileA.js has: block1, filler, block2 (same as block1)
    await writeFile(join(subDir, "fileA.js"), `${block}\n${filler}\n${block}`);
    // Add a second file so we also verify intra-file is not blocked by multi-file logic
    await writeFile(join(subDir, "fileB.js"), "const z = 1;");

    const allFindings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.8 });
    const findings = allFindings.filter((f) => f.check === "duplicate");

    // Should find at least one intra-file duplicate in fileA.js
    const intraFile = findings.filter((f) => f.fileA === f.fileB && f.fileA.endsWith("fileA.js"));
    expect(intraFile.length).toBeGreaterThan(0);
  });

  it("finds duplicates in single file", async () => {
    const subDir = join(dir, "dup-single-file");
    await mkdir(subDir, { recursive: true });

    // ONE file with two identical code blocks separated by filler
    const block = makeCodeBlock("x", "y", "x");
    const filler = Array.from({ length: 40 }, (_, i) => `const solo${i} = ${i} + ${i * 2};`).join(
      "\n",
    );

    await writeFile(join(subDir, "solo.js"), `${block}\n${filler}\n${block}`);

    // With the fix (< 1 instead of < 2), a single file should still be scanned
    const allFindings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.8 });
    const findings = allFindings.filter((f) => f.check === "duplicate");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].fileA).toContain("solo.js");
    expect(findings[0].fileB).toContain("solo.js");
  });

  it("appends cluster summary findings alongside pair findings", async () => {
    const subDir = join(dir, "dup-clusters");
    await mkdir(subDir, { recursive: true });

    await writeFile(join(subDir, "c1.js"), makeCodeBlock("a", "b", "a"));
    await writeFile(join(subDir, "c2.js"), makeCodeBlock("x", "y", "x"));

    const allFindings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7 });
    const pairs = allFindings.filter((f) => f.check === "duplicate");
    const clusters = allFindings.filter((f) => f.check === "duplicate-cluster");

    expect(pairs.length).toBeGreaterThan(0);
    expect(clusters.length).toBeGreaterThan(0);

    for (const c of clusters) {
      expect(c.check).toBe("duplicate-cluster");
      expect(Array.isArray(c.files)).toBe(true);
      expect(c.memberCount).toBeGreaterThanOrEqual(2);
      expect(typeof c.avgSimilarity).toBe("number");
      expect(typeof c.avgTokenCount).toBe("number");
      expect(c.representativePair).not.toBeNull();
      expect(typeof c.representativePair.fileA).toBe("string");
      expect(typeof c.representativePair.fileB).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// clusterDuplicates (unit tests)
// ---------------------------------------------------------------------------

describe("clusterDuplicates", () => {
  it("returns empty array for empty input", () => {
    expect(clusterDuplicates([])).toEqual([]);
    expect(clusterDuplicates(null)).toEqual([]);
    expect(clusterDuplicates(undefined)).toEqual([]);
  });

  it("groups a single pair into one cluster with 2 members", () => {
    const matches = [
      {
        check: "duplicate",
        fileA: "a.js",
        fileB: "b.js",
        startLineA: 0,
        endLineA: 10,
        startLineB: 5,
        endLineB: 15,
        similarity: 0.95,
        tokenCount: 50,
      },
    ];
    const clusters = clusterDuplicates(matches);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].check).toBe("duplicate-cluster");
    expect(clusters[0].memberCount).toBe(2);
    expect(clusters[0].files).toHaveLength(2);
    expect(clusters[0].avgSimilarity).toBe(0.95);
    expect(clusters[0].avgTokenCount).toBe(50);
  });

  it("merges transitive pairs into a single cluster (A-B + B-C = 1 cluster)", () => {
    const matches = [
      {
        check: "duplicate",
        fileA: "a.js",
        fileB: "b.js",
        startLineA: 0,
        endLineA: 10,
        startLineB: 0,
        endLineB: 10,
        similarity: 0.9,
        tokenCount: 60,
      },
      {
        check: "duplicate",
        fileA: "b.js",
        fileB: "c.js",
        startLineA: 0,
        endLineA: 10,
        startLineB: 0,
        endLineB: 10,
        similarity: 0.8,
        tokenCount: 40,
      },
    ];
    const clusters = clusterDuplicates(matches);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberCount).toBe(3);
    expect(clusters[0].avgSimilarity).toBe(0.85);
    expect(clusters[0].avgTokenCount).toBe(50);
  });

  it("keeps disconnected pairs as separate clusters", () => {
    const matches = [
      {
        check: "duplicate",
        fileA: "a.js",
        fileB: "b.js",
        startLineA: 0,
        endLineA: 10,
        startLineB: 0,
        endLineB: 10,
        similarity: 0.9,
        tokenCount: 60,
      },
      {
        check: "duplicate",
        fileA: "c.js",
        fileB: "d.js",
        startLineA: 0,
        endLineA: 10,
        startLineB: 0,
        endLineB: 10,
        similarity: 0.8,
        tokenCount: 40,
      },
    ];
    const clusters = clusterDuplicates(matches);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].memberCount).toBe(2);
    expect(clusters[1].memberCount).toBe(2);
  });

  it("includes a representative pair from the original matches", () => {
    const matches = [
      {
        check: "duplicate",
        fileA: "x.js",
        fileB: "y.js",
        startLineA: 5,
        endLineA: 15,
        startLineB: 10,
        endLineB: 20,
        similarity: 0.92,
        tokenCount: 55,
      },
    ];
    const clusters = clusterDuplicates(matches);
    expect(clusters[0].representativePair).toEqual({
      fileA: "x.js",
      startLineA: 5,
      endLineA: 15,
      fileB: "y.js",
      startLineB: 10,
      endLineB: 20,
    });
  });

  it("distinguishes same file with different line ranges as separate regions", () => {
    const matches = [
      {
        check: "duplicate",
        fileA: "a.js",
        fileB: "a.js",
        startLineA: 0,
        endLineA: 10,
        startLineB: 50,
        endLineB: 60,
        similarity: 0.95,
        tokenCount: 50,
      },
    ];
    const clusters = clusterDuplicates(matches);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberCount).toBe(2);
    expect(clusters[0].files[0].file).toBe("a.js");
    expect(clusters[0].files[1].file).toBe("a.js");
    // Different line ranges
    expect(clusters[0].files[0].startLine).not.toBe(clusters[0].files[1].startLine);
  });
});
