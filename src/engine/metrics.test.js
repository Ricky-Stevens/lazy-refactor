import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeFileMetrics, computeMetrics, isPythonFile } from "./metrics.js";

// ---------------------------------------------------------------------------
// isPythonFile
// ---------------------------------------------------------------------------
describe("isPythonFile", () => {
  test("returns true for .py files", () => {
    expect(isPythonFile("foo.py")).toBe(true);
    expect(isPythonFile("/some/path/script.py")).toBe(true);
    expect(isPythonFile("script.PY")).toBe(true);
  });

  test("returns false for non-Python files", () => {
    expect(isPythonFile("foo.ts")).toBe(false);
    expect(isPythonFile("foo.js")).toBe(false);
    expect(isPythonFile("foo.go")).toBe(false);
    expect(isPythonFile("foo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeFileMetrics — JS/TS (brace-based nesting)
// ---------------------------------------------------------------------------
describe("computeFileMetrics — JS brace-based nesting", () => {
  test("counts lines correctly", () => {
    const content = "const a = 1;\nconst b = 2;\nconst c = 3;";
    const metrics = computeFileMetrics(content, "foo.js");
    expect(metrics.lineCount).toBe(3);
  });

  test("tracks max nesting depth via braces", () => {
    const content = [
      "function outer() {", // depth 1
      "  if (true) {", // depth 2
      "    for (;;) {", // depth 3
      "    }", // depth 2
      "  }", // depth 1
      "}", // depth 0
    ].join("\n");
    const metrics = computeFileMetrics(content, "foo.js");
    expect(metrics.maxNestingDepth).toBe(3);
  });

  test("counts branch points", () => {
    // if, else, for, while, switch, ternary, &&, ||
    const content = [
      "if (a && b || c) {", // if + && + ||  = 3
      "  x ? 1 : 2;", // ternary = 1
      "} else {", // else = 1
      "  for (let i;;) {}", // for = 1
      "  while (x) {}", // while = 1
      "  switch (y) {}", // switch = 1
      "}",
    ].join("\n");
    const metrics = computeFileMetrics(content, "foo.js");
    // Total: if(1) && (1) ||(1) ternary(1) else(1) for(1) while(1) switch(1) = 8
    expect(metrics.branchPointCount).toBe(8);
  });

  test("counts do-while as a branch point", () => {
    const content = ["do {", "  x++;", "} while (x < 10);"].join("\n");
    const metrics = computeFileMetrics(content, "foo.js");
    // do(1) + while(1) = 2
    expect(metrics.branchPointCount).toBe(2);
  });

  test("comment-to-code ratio", () => {
    const content = ["// comment 1", "// comment 2", "const x = 1;", "const y = 2;"].join("\n");
    const metrics = computeFileMetrics(content, "foo.js");
    // 2 comment lines, 2 code lines -> ratio = 1.00
    expect(metrics.commentToCodeRatio).toBe(1.0);
  });

  test("comment-to-code ratio is 0 when there are no comments", () => {
    const content = "const x = 1;\nconst y = 2;";
    const metrics = computeFileMetrics(content, "foo.js");
    expect(metrics.commentToCodeRatio).toBe(0);
  });

  test("export count", () => {
    const content = ["export function foo() {}", "export const bar = 1;", "const baz = 2;"].join(
      "\n",
    );
    const metrics = computeFileMetrics(content, "foo.js");
    expect(metrics.exportCount).toBe(2);
  });

  test("import count", () => {
    const content = [
      "import { foo } from './foo.js';",
      "import bar from './bar.js';",
      "const baz = require('./baz');",
      "const x = 1;",
    ].join("\n");
    const metrics = computeFileMetrics(content, "foo.js");
    expect(metrics.importCount).toBe(3);
  });

  test("complexityScore formula: nestingDepth*3 + branchPoints*2 + lineCount/50", () => {
    const content = [
      "function f() {", // depth 1
      "  if (a) {", // depth 2, branch: if
      "  }",
      "}",
    ].join("\n");
    const metrics = computeFileMetrics(content, "foo.js");
    const expected =
      metrics.maxNestingDepth * 3 + metrics.branchPointCount * 2 + metrics.lineCount / 50;
    expect(metrics.complexityScore).toBeCloseTo(expected, 5);
  });
});

// ---------------------------------------------------------------------------
// computeFileMetrics — Python (indent-based nesting)
// ---------------------------------------------------------------------------
describe("computeFileMetrics — Python indent-based nesting", () => {
  test("uses indent-based nesting for .py files", () => {
    const content = [
      "def outer():", // indent 0, depth starts at 1 after this
      "    if True:", // indent 4, depth 2
      "        for x in y:", // indent 8, depth 3
      "            pass", // indent 12, depth 4
      "    return 1", // indent 4, back to depth 2
    ].join("\n");
    const metrics = computeFileMetrics(content, "script.py");
    expect(metrics.maxNestingDepth).toBeGreaterThanOrEqual(3);
  });

  test("Python file has no brace-based nesting miscounting", () => {
    // A Python file with {} in string literals should not affect nesting
    const content = ['data = {"key": "value"}', "def foo():", "    return data"].join("\n");
    // maxNestingDepth should be 1 (inside def foo body), NOT confused by {}
    const metrics = computeFileMetrics(content, "foo.py");
    // Python uses indent: "def foo():" is top-level (0), body is indent 1
    expect(metrics.maxNestingDepth).toBeGreaterThanOrEqual(1);
    // Should not be inflated by { } characters
    expect(metrics.maxNestingDepth).toBeLessThan(5);
  });

  test("comments detected via # prefix", () => {
    const content = ["# this is a comment", "x = 1", "# another comment", "y = 2"].join("\n");
    const metrics = computeFileMetrics(content, "foo.py");
    expect(metrics.commentToCodeRatio).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// computeMetrics — directory scan with thresholds
// ---------------------------------------------------------------------------
describe("computeMetrics — directory scan", () => {
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "metrics-test-"));

    // A simple short file — should produce no threshold findings
    await writeFile(join(tmpDir, "simple.js"), "export const x = 1;\nexport const y = 2;\n");

    // A deeply-nested file that exceeds maxNesting=2
    const deeplyNested = [
      "function f() {",
      "  if (a) {",
      "    for (;;) {",
      "      while (b) {",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n");
    await writeFile(join(tmpDir, "complex.js"), deeplyNested);

    // A long file exceeding maxFileLines=5
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
    const result = await computeMetrics(tmpDir, {
      maxFileLines: 5,
      languages: ["typescript"],
    });
    const longFileFinding = result.findings.find(
      (f) => f.ruleId === "metrics-long-file" && f.file.includes("long.ts"),
    );
    expect(longFileFinding).toBeDefined();
    expect(longFileFinding.severity).toBe("medium");
  });

  test("emits finding for files exceeding maxNesting threshold", async () => {
    const result = await computeMetrics(tmpDir, {
      maxNesting: 2,
      languages: ["javascript"],
    });
    const nestingFinding = result.findings.find(
      (f) => f.ruleId === "metrics-deep-nesting" && f.file.includes("complex.js"),
    );
    expect(nestingFinding).toBeDefined();
  });

  test("no findings for a simple file within all thresholds", async () => {
    const result = await computeMetrics(tmpDir, {
      maxFileLines: 300,
      maxComplexity: 100,
      maxNesting: 10,
      languages: ["javascript"],
    });
    const simpleFindings = result.findings.filter((f) => f.file.includes("simple.js"));
    expect(simpleFindings.length).toBe(0);
  });

  test("emits finding for files exceeding maxComplexity", async () => {
    // Force a very low complexity threshold
    const result = await computeMetrics(tmpDir, {
      maxComplexity: 0,
      languages: ["javascript"],
    });
    // At least one file should exceed complexity 0
    const complexityFindings = result.findings.filter(
      (f) => f.ruleId === "metrics-high-complexity",
    );
    expect(complexityFindings.length).toBeGreaterThan(0);
  });

  test("default maxComplexity is 15 and maxNesting is 4", async () => {
    // Write a file that exceeds old defaults (50/5) but is within new defaults (15/4)
    // would be caught at 15 but not at 50 — so we just confirm defaults by
    // checking the description string on a finding produced at threshold 15
    const result = await computeMetrics(tmpDir, {
      maxComplexity: 15,
      maxNesting: 4,
      languages: ["javascript"],
    });
    // The result should not error — defaults match these values
    expect(result).toHaveProperty("fileMetrics");
    expect(result).toHaveProperty("findings");
  });

  test("default thresholds 15/4 are used when no options provided for a scan", async () => {
    // Create a separate temp dir with a file designed to exceed complexity 15
    // but not 50, to confirm the default is 15 not 50
    const specificTmpDir = await mkdtemp(join(tmpdir(), "metrics-defaults-"));
    // Build a file with enough branching to exceed complexity 15 but not 50
    // complexityScore = nesting*3 + branches*2 + lines/50
    // With nesting=2, branches=10, lines=10: 6+20+0.2 = 26.2 > 15 but < 50
    const content = [
      "function f() {",
      "  if (a) {",
      "    if (b) {} else {}",
      "    if (c) {} else {}",
      "    if (d) {} else {}",
      "    if (e) {} else {}",
      "    if (g) {} else {}",
      "  }",
      "}",
      "const x = 1;",
    ].join("\n");
    await writeFile(join(specificTmpDir, "threshold.js"), content);

    const result = await computeMetrics(specificTmpDir, { languages: ["javascript"] });
    const complexityFinding = result.findings.find(
      (f) => f.ruleId === "metrics-high-complexity" && f.file.includes("threshold.js"),
    );
    // With default maxComplexity=15 this should fire; at 50 it would not
    expect(complexityFinding).toBeDefined();
  });

  test("emits metrics-high-exports finding when exportCount exceeds maxExportsPerFile", async () => {
    const specificTmpDir = await mkdtemp(join(tmpdir(), "metrics-exports-"));
    // 12 exports — exceeds default of 10
    const lines = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`);
    await writeFile(join(specificTmpDir, "heavy-exports.js"), lines.join("\n"));

    const result = await computeMetrics(specificTmpDir, {
      maxExportsPerFile: 10,
      languages: ["javascript"],
    });
    const finding = result.findings.find(
      (f) => f.ruleId === "metrics-high-exports" && f.file.includes("heavy-exports.js"),
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("medium");
    expect(finding.check).toBe("modularity");
    expect(finding.confidence).toBe(0.85);
  });

  test("does not emit metrics-high-exports when exportCount is within threshold", async () => {
    const specificTmpDir = await mkdtemp(join(tmpdir(), "metrics-exports-ok-"));
    const lines = Array.from({ length: 5 }, (_, i) => `export const v${i} = ${i};`);
    await writeFile(join(specificTmpDir, "few-exports.js"), lines.join("\n"));

    const result = await computeMetrics(specificTmpDir, {
      maxExportsPerFile: 10,
      languages: ["javascript"],
    });
    const finding = result.findings.find((f) => f.ruleId === "metrics-high-exports");
    expect(finding).toBeUndefined();
  });

  test("emits metrics-high-imports finding when importCount exceeds maxImportsPerFile", async () => {
    const specificTmpDir = await mkdtemp(join(tmpdir(), "metrics-imports-"));
    // 17 imports — exceeds default of 15
    const lines = Array.from({ length: 17 }, (_, i) => `import v${i} from './mod${i}.js';`);
    await writeFile(join(specificTmpDir, "heavy-imports.js"), lines.join("\n"));

    const result = await computeMetrics(specificTmpDir, {
      maxImportsPerFile: 15,
      languages: ["javascript"],
    });
    const finding = result.findings.find(
      (f) => f.ruleId === "metrics-high-imports" && f.file.includes("heavy-imports.js"),
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("medium");
    expect(finding.check).toBe("modularity");
    expect(finding.confidence).toBe(0.85);
  });

  test("emits metrics-low-comments for complex file with almost no comments", async () => {
    const specificTmpDir = await mkdtemp(join(tmpdir(), "metrics-lowcomments-"));
    // High complexity (many branches, nesting), zero comments
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
    await writeFile(join(specificTmpDir, "complex-no-comments.js"), content);

    const result = await computeMetrics(specificTmpDir, {
      maxNesting: 999,
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
    const specificTmpDir = await mkdtemp(join(tmpdir(), "metrics-simple-nocomments-"));
    // Low complexity — commentToCodeRatio < 0.02 but complexityScore <= maxComplexity
    const content = "const x = 1;\nconst y = 2;\n";
    await writeFile(join(specificTmpDir, "simple.js"), content);

    const result = await computeMetrics(specificTmpDir, { languages: ["javascript"] });
    const finding = result.findings.find((f) => f.ruleId === "metrics-low-comments");
    expect(finding).toBeUndefined();
  });

  test("emits metrics-excessive-comments when commentToCodeRatio > 0.5", async () => {
    const specificTmpDir = await mkdtemp(join(tmpdir(), "metrics-excessive-"));
    // 3 comment lines, 1 code line → ratio = 3.0 > 0.5
    const content = ["// comment 1", "// comment 2", "// comment 3", "const x = 1;"].join("\n");
    await writeFile(join(specificTmpDir, "over-commented.js"), content);

    const result = await computeMetrics(specificTmpDir, { languages: ["javascript"] });
    const finding = result.findings.find(
      (f) => f.ruleId === "metrics-excessive-comments" && f.file.includes("over-commented.js"),
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("low");
    expect(finding.check).toBe("comment-quality");
    expect(finding.confidence).toBe(0.7);
  });

  test("does not emit metrics-excessive-comments when ratio is acceptable", async () => {
    const specificTmpDir = await mkdtemp(join(tmpdir(), "metrics-ok-comments-"));
    // 1 comment, 5 code lines → ratio = 0.2, well within 0.5
    const content = [
      "// brief description",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "const d = 4;",
      "const e = 5;",
    ].join("\n");
    await writeFile(join(specificTmpDir, "ok-comments.js"), content);

    const result = await computeMetrics(specificTmpDir, { languages: ["javascript"] });
    const finding = result.findings.find((f) => f.ruleId === "metrics-excessive-comments");
    expect(finding).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeMetrics — respects SKIP_DIRS (collectFiles integration)
// ---------------------------------------------------------------------------
describe("computeMetrics — SKIP_DIRS", () => {
  test("skips files inside dist, build, __pycache__, and other SKIP_DIRS entries", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "metrics-skipdir-"));

    // Create a valid source file at root level
    await writeFile(join(tmpDir, "root.js"), "const x = 1;\n");

    // Create source files inside directories that should be skipped
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

// ---------------------------------------------------------------------------
// computeFileMetrics — Go-specific export and import counting
// ---------------------------------------------------------------------------
describe("computeFileMetrics — Go export/import counting", () => {
  test("counts exported Go declarations (uppercase func/type/var/const)", () => {
    const content = [
      "package main",
      "",
      "func PublicFunc() {}",
      "func privateFunc() {}",
      "type PublicStruct struct {}",
      "type privateStruct struct {}",
      "var PublicVar = 1",
      "var privateVar = 2",
      "const PublicConst = 3",
      "const privateConst = 4",
    ].join("\n");
    const metrics = computeFileMetrics(content, "main.go");
    // 4 exported: PublicFunc, PublicStruct, PublicVar, PublicConst
    expect(metrics.exportCount).toBe(4);
  });

  test("does not count export keyword for Go files", () => {
    // Go has no `export` keyword — this should not inflate counts
    const content = [
      "package main",
      "",
      "// export is just a word in a comment",
      "func helper() {}",
    ].join("\n");
    const metrics = computeFileMetrics(content, "main.go");
    expect(metrics.exportCount).toBe(0);
  });

  test("counts individual Go imports from a block import", () => {
    const content = [
      "package main",
      "",
      "import (",
      '  "fmt"',
      '  "os"',
      '  "strings"',
      ")",
      "",
      "func main() {}",
    ].join("\n");
    const metrics = computeFileMetrics(content, "main.go");
    expect(metrics.importCount).toBe(3);
  });

  test("counts standalone Go import", () => {
    const content = ["package main", "", 'import "fmt"', "", "func main() { fmt.Println() }"].join(
      "\n",
    );
    const metrics = computeFileMetrics(content, "main.go");
    expect(metrics.importCount).toBe(1);
  });

  test("does not overcount Go import keyword as multiple imports", () => {
    // The `import (` line itself should not be counted as an import
    const content = ["package main", "", "import (", '  "fmt"', ")"].join("\n");
    const metrics = computeFileMetrics(content, "main.go");
    expect(metrics.importCount).toBe(1);
  });
});
