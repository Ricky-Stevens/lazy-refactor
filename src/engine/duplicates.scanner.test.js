import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDuplicates } from "./duplicates.js";

// Builds a code block that, when tokenised and normalised, produces >= 50 tokens.
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
    await writeFile(join(subDir, "a.js"), makeCodeBlock("x", "y", "x"));
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
    const findings = allFindings.filter((f) => f.check === "duplicate");
    expect(findings).toHaveLength(0);
  });

  it("does not flag blocks shorter than minTokens", async () => {
    const subDir = join(dir, "dup-minTokens");
    await mkdir(subDir, { recursive: true });
    const tiny = "function tiny() { return 1; }";
    await writeFile(join(subDir, "tiny1.js"), tiny);
    await writeFile(join(subDir, "tiny2.js"), tiny);

    const allFindings = await scanDuplicates(subDir, { minTokens: 100, similarity: 0.8 });
    const findings = allFindings.filter((f) => f.check === "duplicate");
    expect(findings).toHaveLength(0);
  });

  it("finding shape has required fields including confidence scores", async () => {
    const subDir = join(dir, "dup-shape");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "x.js"), makeCodeBlock("a", "b", "a"));
    await writeFile(join(subDir, "y.js"), makeCodeBlock("p", "q", "p"));

    const allFindings = await scanDuplicates(subDir, { minTokens: 10, similarity: 0.7, minConfidence: 0 });
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
      expect(typeof f.confidence).toBe("number");
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
      expect(typeof f.structuralRatio).toBe("number");
      expect(typeof f.tokenDiversity).toBe("number");
      expect(typeof f.category).toBe("string");
      expect(["extract-function", "extract-and-share", "extract-wrapper", "extract-config"]).toContain(f.category);
      expect(typeof f.snippet).toBe("string");
      expect(f.snippet.length).toBeGreaterThan(0);
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

    const preambleA = [
      "const pa1 = { x: 1 };",
      "const pa2 = { y: 2 };",
      "const pa3 = { z: 3 };",
      "const pa4 = { w: 4 };",
      "const pa5 = { v: 5 };",
    ].join("\n");
    const preambleB = ["const pb1 = { a: 10 };", "const pb2 = { b: 20 };"].join("\n");

    await writeFile(join(subDir, "la.js"), `${preambleA}\n${sharedBlock}`);
    await writeFile(join(subDir, "lb.js"), `${preambleB}\n${sharedBlock}`);

    const allFindings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.9 });
    const findings = allFindings.filter((f) => f.check === "duplicate");
    expect(findings.length).toBeGreaterThan(0);

    for (const f of findings) {
      expect(f.endLineA).toBeGreaterThanOrEqual(f.startLineA);
      expect(f.endLineB).toBeGreaterThanOrEqual(f.startLineB);
    }

    // The shared block starts at line 5 in A and line 2 in B.
    // Overlap suppression may merge it with matching preamble tokens,
    // so verify the finding *covers* the shared block rather than starting exactly there.
    const coveringFindings = findings.filter((f) => f.endLineA >= 10 && f.endLineB >= 7);
    expect(coveringFindings.length).toBeGreaterThan(0);
    for (const f of coveringFindings) {
      expect(Math.abs(f.startLineA - f.startLineB)).toBeLessThanOrEqual(3);
    }
  });

  it("finds intra-file duplicates when blocks are far apart", async () => {
    const subDir = join(dir, "dup-intra");
    await mkdir(subDir, { recursive: true });

    const block = makeCodeBlock("a", "b", "a");
    const filler = Array.from(
      { length: 40 },
      (_, i) => `const unique${i} = ${i} * ${i + 7} + ${i * 3};`,
    ).join("\n");

    await writeFile(join(subDir, "fileA.js"), `${block}\n${filler}\n${block}`);
    await writeFile(join(subDir, "fileB.js"), "const z = 1;");

    const allFindings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.8 });
    const findings = allFindings.filter((f) => f.check === "duplicate");
    const intraFile = findings.filter((f) => f.fileA === f.fileB && f.fileA.endsWith("fileA.js"));
    expect(intraFile.length).toBeGreaterThan(0);
  });

  it("finds duplicates in single file", async () => {
    const subDir = join(dir, "dup-single-file");
    await mkdir(subDir, { recursive: true });

    const block = makeCodeBlock("x", "y", "x");
    const filler = Array.from({ length: 40 }, (_, i) => `const solo${i} = ${i} + ${i * 2};`).join(
      "\n",
    );

    await writeFile(join(subDir, "solo.js"), `${block}\n${filler}\n${block}`);

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
      expect(typeof c.totalDuplicatedLines).toBe("number");
      expect(c.totalDuplicatedLines).toBeGreaterThan(0);
      expect(typeof c.filesAffected).toBe("number");
      expect(c.filesAffected).toBeGreaterThanOrEqual(1);
      expect(typeof c.impact).toBe("number");
      expect(typeof c.category).toBe("string");
      expect(typeof c.snippet).toBe("string");
    }
  });

  it("excludeTests=true skips test files", async () => {
    const subDir = join(dir, "dup-exclude-tests");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "lib.js"), makeCodeBlock("a", "b", "a"));
    await writeFile(join(subDir, "lib.test.js"), makeCodeBlock("x", "y", "x"));

    const withTests = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7, excludeTests: false, minConfidence: 0 });
    const withoutTests = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7, excludeTests: true, minConfidence: 0 });

    const pairsWith = withTests.filter((f) => f.check === "duplicate");
    const pairsWithout = withoutTests.filter((f) => f.check === "duplicate");

    expect(pairsWith.length).toBeGreaterThan(0);
    expect(pairsWithout).toHaveLength(0);
  });

  it("excludeTests defaults to true", async () => {
    const subDir = join(dir, "dup-exclude-default");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "mod.js"), makeCodeBlock("a", "b", "a"));
    await writeFile(join(subDir, "mod.spec.js"), makeCodeBlock("x", "y", "x"));

    const findings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7, minConfidence: 0 });
    const pairs = findings.filter((f) => f.check === "duplicate");
    expect(pairs).toHaveLength(0);
  });

  it("data-heavy files score low confidence and are filtered by default", async () => {
    const subDir = join(dir, "dup-data-confidence");
    await mkdir(subDir, { recursive: true });

    const makeRuleEntry = (id, desc) => `  {
    id: "${id}",
    severity: "high",
    category: "error-handling",
    description: "${desc}",
    pattern: "some-pattern-${id}",
    antiPattern: null,
    filePattern: "**/*.js",
    exclude: ["**/test/**"],
    suggestion: "Fix this issue by doing the right thing.",
    fixable: true,
  }`;

    const ruleFileA = `export default [\n${Array.from({ length: 8 }, (_, i) => makeRuleEntry(`rule-a-${i}`, `Rule A ${i}`)).join(",\n")}\n];`;
    const ruleFileB = `export default [\n${Array.from({ length: 8 }, (_, i) => makeRuleEntry(`rule-b-${i}`, `Rule B ${i}`)).join(",\n")}\n];`;

    await writeFile(join(subDir, "rules-a.js"), ruleFileA);
    await writeFile(join(subDir, "rules-b.js"), ruleFileB);

    const unfiltered = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7, minConfidence: 0 });
    const filtered = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7 });

    const unfilteredPairs = unfiltered.filter((f) => f.check === "duplicate");
    const filteredPairs = filtered.filter((f) => f.check === "duplicate");

    expect(unfilteredPairs.length).toBeGreaterThan(0);
    for (const f of unfilteredPairs) {
      expect(f.confidence).toBeLessThan(0.5);
    }
    expect(filteredPairs).toHaveLength(0);
  });

  it("logic-heavy duplicates score high confidence and survive filtering", async () => {
    const subDir = join(dir, "dup-logic-confidence");
    await mkdir(subDir, { recursive: true });

    await writeFile(join(subDir, "util-a.js"), makeCodeBlock("x", "y", "x"));
    await writeFile(join(subDir, "util-b.js"), makeCodeBlock("a", "b", "a"));

    const findings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7 });
    const pairs = findings.filter((f) => f.check === "duplicate");

    expect(pairs.length).toBeGreaterThan(0);
    for (const f of pairs) {
      expect(f.confidence).toBeGreaterThan(0.5);
      expect(f.structuralRatio).toBeGreaterThan(0.15);
    }
  });

  it("minConfidence=0 returns all findings regardless of score", async () => {
    const subDir = join(dir, "dup-no-filter");
    await mkdir(subDir, { recursive: true });

    const dataBlock = Array.from({ length: 15 }, (_, i) =>
      `  { name: "item${i}", value: ${i}, label: "Label ${i}" }`
    ).join(",\n");
    const file = `export const data = [\n${dataBlock}\n];`;

    await writeFile(join(subDir, "data-a.js"), file);
    await writeFile(join(subDir, "data-b.js"), file);

    const findings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7, minConfidence: 0 });
    const pairs = findings.filter((f) => f.check === "duplicate");

    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.some((f) => f.confidence < 0.5)).toBe(true);
  });

  it("snippet contains actual source code from side A", async () => {
    const subDir = join(dir, "dup-snippet");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "s1.js"), makeCodeBlock("alpha", "beta", "alpha"));
    await writeFile(join(subDir, "s2.js"), makeCodeBlock("foo", "bar", "foo"));

    const findings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7 });
    const pairs = findings.filter((f) => f.check === "duplicate");
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0].snippet).toContain("function");
    expect(pairs[0].snippet).toContain("return");
  });

  it("classifies function duplicates as extract-and-share", async () => {
    const subDir = join(dir, "dup-category-func");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "f1.js"), makeCodeBlock("x", "y", "x"));
    await writeFile(join(subDir, "f2.js"), makeCodeBlock("a", "b", "a"));

    const findings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7 });
    const pairs = findings.filter((f) => f.check === "duplicate");
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0].category).toBe("extract-and-share");
  });

  it("classifies data duplicates as extract-config", async () => {
    const subDir = join(dir, "dup-category-data");
    await mkdir(subDir, { recursive: true });

    const dataBlock = Array.from({ length: 15 }, (_, i) =>
      `  { name: "item${i}", value: ${i}, label: "Label ${i}" }`
    ).join(",\n");
    const file = `export const data = [\n${dataBlock}\n];`;

    await writeFile(join(subDir, "d1.js"), file);
    await writeFile(join(subDir, "d2.js"), file);

    const findings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7, minConfidence: 0 });
    const pairs = findings.filter((f) => f.check === "duplicate");
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0].category).toBe("extract-config");
  });

  it("classifies try/catch duplicates as extract-wrapper", async () => {
    const subDir = join(dir, "dup-category-wrapper");
    await mkdir(subDir, { recursive: true });

    const wrapper = (name) => `
async function ${name}(url) {
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || "Request failed");
    }
    return { success: true, data };
  } catch (error) {
    console.error("Failed:", error);
    return { success: false, error: error.message };
  }
}`.trim();

    await writeFile(join(subDir, "w1.js"), wrapper("fetchUser"));
    await writeFile(join(subDir, "w2.js"), wrapper("fetchOrder"));

    const findings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7 });
    const pairs = findings.filter((f) => f.check === "duplicate");
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0].category).toBe("extract-wrapper");
  });

  it("clusters are sorted by impact descending", async () => {
    const subDir = join(dir, "dup-impact-sort");
    await mkdir(subDir, { recursive: true });

    const smallBlock = makeCodeBlock("a", "b", "a");
    const bigBlock = `${makeCodeBlock("x", "y", "x")}\n${makeCodeBlock("p", "q", "p")}`;

    await writeFile(join(subDir, "small1.js"), smallBlock);
    await writeFile(join(subDir, "small2.js"), smallBlock);
    await writeFile(join(subDir, "big1.js"), bigBlock);
    await writeFile(join(subDir, "big2.js"), bigBlock);
    await writeFile(join(subDir, "big3.js"), bigBlock);

    const findings = await scanDuplicates(subDir, { minTokens: 20, similarity: 0.7 });
    const clusters = findings.filter((f) => f.check === "duplicate-cluster");

    if (clusters.length >= 2) {
      for (let i = 1; i < clusters.length; i++) {
        expect(clusters[i - 1].impact).toBeGreaterThanOrEqual(clusters[i].impact);
      }
    }
  });
});
