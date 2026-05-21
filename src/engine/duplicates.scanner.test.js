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

    const blockFindings = findings.filter((f) => f.startLineA >= 5 && f.startLineB >= 2);
    expect(blockFindings.length).toBeGreaterThan(0);
    for (const f of blockFindings) {
      expect(Math.abs(f.startLineA - f.startLineB)).toBe(3);
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
    }
  });
});
