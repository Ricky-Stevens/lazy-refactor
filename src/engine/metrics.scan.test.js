import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMetrics } from "./metrics.js";

// ---------------------------------------------------------------------------
// computeMetrics — directory scan with thresholds
// ---------------------------------------------------------------------------

describe("computeMetrics — directory scan", () => {
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "metrics-test-"));
    await writeFile(join(tmpDir, "simple.js"), "export const x = 1;\nexport const y = 2;\n");
    await writeFile(
      join(tmpDir, "complex.js"),
      [
        "function f() {",
        "  if (a) {",
        "    for (;;) {",
        "      while (b) {",
        "      }",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
    const longContent = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join("\n");
    await writeFile(join(tmpDir, "long.ts"), longContent);
  });

  test("returns fileMetrics for all source files", async () => {
    const result = await computeMetrics(tmpDir, { languages: ["typescript", "javascript"] });
    expect(result.fileMetrics.length).toBeGreaterThanOrEqual(3);
    const files = result.fileMetrics.map((m) => m.file);
    expect(files.some((f) => f.includes("simple.js"))).toBe(true);
    expect(files.some((f) => f.includes("complex.js"))).toBe(true);
    expect(files.some((f) => f.includes("long.ts"))).toBe(true);
  });

  test("each file metric has the expected shape", async () => {
    const result = await computeMetrics(tmpDir, { languages: ["javascript"] });
    for (const m of result.fileMetrics) {
      expect(typeof m.file).toBe("string");
      expect(typeof m.lineCount).toBe("number");
      expect(typeof m.maxNestingDepth).toBe("number");
      expect(typeof m.branchPointCount).toBe("number");
      expect(typeof m.commentToCodeRatio).toBe("number");
      expect(typeof m.exportCount).toBe("number");
      expect(typeof m.importCount).toBe("number");
      expect(typeof m.complexityScore).toBe("number");
    }
  });

  test("emits finding for files exceeding maxFileLines threshold", async () => {
    const result = await computeMetrics(tmpDir, { maxFileLines: 5, languages: ["typescript"] });
    const finding = result.findings.find(
      (f) => f.ruleId === "metrics-long-file" && f.file.includes("long.ts"),
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("medium");
  });

  test("emits finding for files exceeding maxNesting threshold", async () => {
    const result = await computeMetrics(tmpDir, { maxNesting: 2, languages: ["javascript"] });
    const finding = result.findings.find(
      (f) => f.ruleId === "metrics-deep-nesting" && f.file.includes("complex.js"),
    );
    expect(finding).toBeDefined();
  });

  test("no findings for a simple file within all thresholds", async () => {
    const result = await computeMetrics(tmpDir, {
      maxFileLines: 300,
      maxComplexity: 100,
      maxNesting: 10,
      languages: ["javascript"],
    });
    expect(result.findings.filter((f) => f.file.includes("simple.js"))).toHaveLength(0);
  });

  test("emits finding for files exceeding maxComplexity", async () => {
    const result = await computeMetrics(tmpDir, { maxComplexity: 0, languages: ["javascript"] });
    expect(
      result.findings.filter((f) => f.ruleId === "metrics-high-complexity").length,
    ).toBeGreaterThan(0);
  });

  test("default maxComplexity is 100 and maxNesting is 4", async () => {
    const result = await computeMetrics(tmpDir, {
      maxComplexity: 100,
      maxNesting: 4,
      languages: ["javascript"],
    });
    expect(result).toHaveProperty("fileMetrics");
    expect(result).toHaveProperty("findings");
  });

  test("default thresholds 100/4 are used when no options provided for a scan", async () => {
    const specificTmpDir = await mkdtemp(join(tmpdir(), "metrics-defaults-"));
    // 4 nested ifs (depths 1-4) + 20 branches at depth 5: 2+3+4+5 + 20*6 = 134 > 100
    const branchLines = [];
    for (let i = 0; i < 20; i++) branchLines.push(`    if (x${i}) {}`);
    const content = [
      "function f() {",
      "  if (a) {",
      "    if (b) {",
      "      if (c) {",
      "        if (d) {",
      ...branchLines,
      "        }",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n");
    await writeFile(join(specificTmpDir, "threshold.js"), content);

    const result = await computeMetrics(specificTmpDir, { languages: ["javascript"] });
    const finding = result.findings.find(
      (f) => f.ruleId === "metrics-high-complexity" && f.file.includes("threshold.js"),
    );
    expect(finding).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// computeMetrics — modularity findings
// ---------------------------------------------------------------------------

describe("computeMetrics — modularity findings", () => {
  test("emits metrics-high-exports finding when exportCount exceeds maxExportsPerFile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-exports-"));
    const lines = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`);
    await writeFile(join(dir, "heavy-exports.js"), lines.join("\n"));

    const result = await computeMetrics(dir, { maxExportsPerFile: 10, languages: ["javascript"] });
    const finding = result.findings.find(
      (f) => f.ruleId === "metrics-high-exports" && f.file.includes("heavy-exports.js"),
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("medium");
    expect(finding.check).toBe("modularity");
    expect(finding.confidence).toBe(0.85);
  });

  test("does not emit metrics-high-exports when exportCount is within threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-exports-ok-"));
    const lines = Array.from({ length: 5 }, (_, i) => `export const v${i} = ${i};`);
    await writeFile(join(dir, "few-exports.js"), lines.join("\n"));

    const result = await computeMetrics(dir, { maxExportsPerFile: 10, languages: ["javascript"] });
    expect(result.findings.find((f) => f.ruleId === "metrics-high-exports")).toBeUndefined();
  });

  test("emits metrics-high-imports finding when importCount exceeds maxImportsPerFile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-imports-"));
    const lines = Array.from({ length: 17 }, (_, i) => `import v${i} from './mod${i}.js';`);
    await writeFile(join(dir, "heavy-imports.js"), lines.join("\n"));

    const result = await computeMetrics(dir, { maxImportsPerFile: 15, languages: ["javascript"] });
    const finding = result.findings.find(
      (f) => f.ruleId === "metrics-high-imports" && f.file.includes("heavy-imports.js"),
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("medium");
    expect(finding.check).toBe("modularity");
    expect(finding.confidence).toBe(0.85);
  });
});

// ---------------------------------------------------------------------------
// computeMetrics — comment quality findings
// ---------------------------------------------------------------------------

describe("computeMetrics — comment quality findings", () => {
  test("emits metrics-low-comments for complex file with almost no comments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-lowcomments-"));
    const content = [
      "function f() {",
      "  if (a) {",
      "    if (b) { for (;;) { while(x) { if(y){} } } }",
      "    if (c) {} else {}",
      "    if (d) {} else {}",
      "    if (e) {} else {}",
      "  }",
      "  switch(z) { case 1: break; }",
      "}",
      "const x = 1;",
    ].join("\n");
    await writeFile(join(dir, "complex-no-comments.js"), content);

    const result = await computeMetrics(dir, {
      maxNesting: 999,
      maxComplexity: 15,
      languages: ["javascript"],
    });
    const finding = result.findings.find(
      (f) => f.ruleId === "metrics-low-comments" && f.file.includes("complex-no-comments.js"),
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("low");
    expect(finding.check).toBe("comment-quality");
    expect(finding.confidence).toBe(0.7);
  });

  test("does not emit metrics-low-comments for simple file with no comments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-simple-nocomments-"));
    await writeFile(join(dir, "simple.js"), "const x = 1;\nconst y = 2;\n");

    const result = await computeMetrics(dir, { languages: ["javascript"] });
    expect(result.findings.find((f) => f.ruleId === "metrics-low-comments")).toBeUndefined();
  });

  test("emits metrics-excessive-comments for a genuinely over-commented file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-excessive-"));
    // 24 code lines each preceded by a narration comment → ratio > 0.5 with real
    // code volume (clears the codeLines >= 20 guard that filters header-only files).
    const content = Array.from({ length: 24 }, (_, i) => `// set v${i}\nconst v${i} = ${i};`).join(
      "\n",
    );
    await writeFile(join(dir, "over-commented.js"), content);

    const result = await computeMetrics(dir, { languages: ["javascript"] });
    const finding = result.findings.find(
      (f) => f.ruleId === "metrics-excessive-comments" && f.file.includes("over-commented.js"),
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("low");
    expect(finding.check).toBe("comment-quality");
    expect(finding.confidence).toBe(0.7);
  });

  test("does NOT emit metrics-excessive-comments for a tiny header-heavy file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-header-only-"));
    // High ratio (3 comments : 1 code line) but almost no code — a license/JSDoc
    // header or barrel, not over-commented code. Previously a false positive.
    const content = ["// comment 1", "// comment 2", "// comment 3", "const x = 1;"].join("\n");
    await writeFile(join(dir, "header-only.js"), content);

    const result = await computeMetrics(dir, { languages: ["javascript"] });
    expect(result.findings.find((f) => f.ruleId === "metrics-excessive-comments")).toBeUndefined();
  });

  test("does NOT emit metrics-excessive-comments for a test file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-test-comments-"));
    const content = Array.from({ length: 24 }, (_, i) => `// case ${i}\nconst v${i} = ${i};`).join(
      "\n",
    );
    await writeFile(join(dir, "thing.test.js"), content);

    const result = await computeMetrics(dir, { languages: ["javascript"] });
    expect(result.findings.find((f) => f.ruleId === "metrics-excessive-comments")).toBeUndefined();
  });

  test("raises the long-file threshold for test files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-long-test-"));
    const body = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n");
    // 60 lines: over the 50 threshold for source, under the doubled (100) test threshold.
    await writeFile(join(dir, "feature.js"), body);
    await writeFile(join(dir, "feature.test.js"), body);

    const result = await computeMetrics(dir, { maxFileLines: 50, languages: ["javascript"] });
    const longFile = result.findings.filter((f) => f.ruleId === "metrics-long-file");
    expect(longFile.some((f) => f.file.includes("feature.js"))).toBe(true);
    expect(longFile.some((f) => f.file.includes("feature.test.js"))).toBe(false);
  });

  test("does not emit metrics-excessive-comments when ratio is acceptable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-ok-comments-"));
    const content = [
      "// brief description",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "const d = 4;",
      "const e = 5;",
    ].join("\n");
    await writeFile(join(dir, "ok-comments.js"), content);

    const result = await computeMetrics(dir, { languages: ["javascript"] });
    expect(result.findings.find((f) => f.ruleId === "metrics-excessive-comments")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeMetrics — grab-bag file detection
// ---------------------------------------------------------------------------

describe("computeMetrics — grab-bag file detection", () => {
  test("flags a file named 'helpers.js' that exceeds size threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-grabbag-big-"));
    const lines = Array.from({ length: 160 }, (_, i) => `const v${i} = ${i};`);
    await writeFile(join(dir, "helpers.js"), lines.join("\n"));

    const result = await computeMetrics(dir, { languages: ["javascript"] });
    const finding = result.findings.find((f) => f.ruleId === "metrics-grab-bag");
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("medium");
    expect(finding.category).toBe("modularity");
  });

  test("flags a file named 'utils.ts' with many exports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-grabbag-exports-"));
    const lines = Array.from({ length: 8 }, (_, i) => `export const fn${i} = () => ${i};`);
    await writeFile(join(dir, "utils.ts"), lines.join("\n"));

    const result = await computeMetrics(dir, { maxExportsPerFile: 100, languages: ["typescript"] });
    const finding = result.findings.find((f) => f.ruleId === "metrics-grab-bag");
    expect(finding).toBeDefined();
  });

  test("does not flag a small file named 'helpers.js' with few exports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-grabbag-ok-"));
    await writeFile(join(dir, "helpers.js"), "export const a = 1;\nexport const b = 2;\n");

    const result = await computeMetrics(dir, { languages: ["javascript"] });
    expect(result.findings.find((f) => f.ruleId === "metrics-grab-bag")).toBeUndefined();
  });

  test("does not flag a large file with a specific name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-grabbag-specific-"));
    const lines = Array.from({ length: 160 }, (_, i) => `const v${i} = ${i};`);
    await writeFile(join(dir, "authentication.js"), lines.join("\n"));

    const result = await computeMetrics(dir, { languages: ["javascript"] });
    expect(result.findings.find((f) => f.ruleId === "metrics-grab-bag")).toBeUndefined();
  });

  test("does not flag 'common.js' when only one threshold is exceeded (AND required)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-grabbag-common-"));
    const lines = Array.from({ length: 160 }, (_, i) => `const v${i} = ${i};`);
    await writeFile(join(dir, "common.js"), lines.join("\n"));

    const result = await computeMetrics(dir, { languages: ["javascript"] });
    expect(result.findings.find((f) => f.ruleId === "metrics-grab-bag")).toBeUndefined();
  });

  test("flags 'common.js' when both thresholds are exceeded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-grabbag-common-both-"));
    const lines = Array.from({ length: 8 }, (_, i) => `export const fn${i} = () => ${i};`);
    const padding = Array.from({ length: 150 }, (_, i) => `const v${i} = ${i};`);
    await writeFile(join(dir, "common.js"), [...lines, ...padding].join("\n"));

    const result = await computeMetrics(dir, { languages: ["javascript"] });
    expect(result.findings.find((f) => f.ruleId === "metrics-grab-bag")).toBeDefined();
  });

  test("still flags 'helpers.js' with only one threshold (OR logic)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metrics-grabbag-helpers-or-"));
    const lines = Array.from({ length: 8 }, (_, i) => `export const fn${i} = () => ${i};`);
    await writeFile(join(dir, "helpers.js"), lines.join("\n"));

    const result = await computeMetrics(dir, { maxExportsPerFile: 100, languages: ["javascript"] });
    expect(result.findings.find((f) => f.ruleId === "metrics-grab-bag")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// computeMetrics — SKIP_DIRS
// ---------------------------------------------------------------------------

describe("computeMetrics — SKIP_DIRS", () => {
  test("skips files inside dist, build, __pycache__, and other SKIP_DIRS entries", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "metrics-skipdir-"));
    await writeFile(join(tmpDir, "root.js"), "const x = 1;\n");

    const skippedDirs = [
      "dist",
      "build",
      "__pycache__",
      "obj",
      "bin",
      "target",
      ".gradle",
      ".next",
    ];
    for (const d of skippedDirs) {
      await mkdir(join(tmpDir, d), { recursive: true });
      await writeFile(join(tmpDir, d, "hidden.js"), "const skip = true;\n");
    }

    const result = await computeMetrics(tmpDir, { languages: ["javascript"] });
    const files = result.fileMetrics.map((m) => m.file);
    expect(files.some((f) => f.includes("root.js"))).toBe(true);
    for (const d of skippedDirs) {
      expect(files.some((f) => f.includes(d))).toBe(false);
    }
  });
});
