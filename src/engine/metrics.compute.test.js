import { describe, expect, test } from "bun:test";
import { computeFileMetrics, isPythonFile } from "./metrics.js";

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
    expect(computeFileMetrics(content, "foo.js").lineCount).toBe(3);
  });

  test("tracks max nesting depth via braces", () => {
    const content = [
      "function outer() {",
      "  if (true) {",
      "    for (;;) {",
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(computeFileMetrics(content, "foo.js").maxNestingDepth).toBe(3);
  });

  test("counts branch points", () => {
    // if, else, for, while, switch, ternary, &&, ||
    const content = [
      "if (a && b || c) {", // if + && + || = 3
      "  x ? 1 : 2;", // ternary = 1
      "} else {", // else = 1
      "  for (let i;;) {}", // for = 1
      "  while (x) {}", // while = 1
      "  switch (y) {}", // switch = 1
      "}",
    ].join("\n");
    // Total: if(1) &&(1) ||(1) ternary(1) else(1) for(1) while(1) switch(1) = 8
    expect(computeFileMetrics(content, "foo.js").branchPointCount).toBe(8);
  });

  test("counts do-while as a branch point", () => {
    const content = ["do {", "  x++;", "} while (x < 10);"].join("\n");
    // do(1) + while(1) = 2
    expect(computeFileMetrics(content, "foo.js").branchPointCount).toBe(2);
  });

  test("comment-to-code ratio", () => {
    const content = ["// comment 1", "// comment 2", "const x = 1;", "const y = 2;"].join("\n");
    // 2 comment lines, 2 code lines -> ratio = 1.00
    expect(computeFileMetrics(content, "foo.js").commentToCodeRatio).toBe(1.0);
  });

  test("comment-to-code ratio is 0 when there are no comments", () => {
    const content = "const x = 1;\nconst y = 2;";
    expect(computeFileMetrics(content, "foo.js").commentToCodeRatio).toBe(0);
  });

  test("export count", () => {
    const content = ["export function foo() {}", "export const bar = 1;", "const baz = 2;"].join(
      "\n",
    );
    expect(computeFileMetrics(content, "foo.js").exportCount).toBe(2);
  });

  test("import count", () => {
    const content = [
      "import { foo } from './foo.js';",
      "import bar from './bar.js';",
      "const baz = require('./baz');",
      "const x = 1;",
    ].join("\n");
    expect(computeFileMetrics(content, "foo.js").importCount).toBe(3);
  });

  test("complexityScore formula: nestingDepth*3 + branchPoints*2 + lineCount/50", () => {
    const content = ["function f() {", "  if (a) {", "  }", "}"].join("\n");
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
      "def outer():", // indent 0
      "    if True:", // indent 4
      "        for x in y:", // indent 8
      "            pass", // indent 12
      "    return 1", // indent 4
    ].join("\n");
    expect(computeFileMetrics(content, "script.py").maxNestingDepth).toBeGreaterThanOrEqual(3);
  });

  test("Python file has no brace-based nesting miscounting", () => {
    const content = ['data = {"key": "value"}', "def foo():", "    return data"].join("\n");
    const metrics = computeFileMetrics(content, "foo.py");
    expect(metrics.maxNestingDepth).toBeGreaterThanOrEqual(1);
    expect(metrics.maxNestingDepth).toBeLessThan(5);
  });

  test("comments detected via # prefix", () => {
    const content = ["# this is a comment", "x = 1", "# another comment", "y = 2"].join("\n");
    expect(computeFileMetrics(content, "foo.py").commentToCodeRatio).toBe(1.0);
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
    // 4 exported: PublicFunc, PublicStruct, PublicVar, PublicConst
    expect(computeFileMetrics(content, "main.go").exportCount).toBe(4);
  });

  test("does not count export keyword for Go files", () => {
    const content = [
      "package main",
      "",
      "// export is just a word in a comment",
      "func helper() {}",
    ].join("\n");
    expect(computeFileMetrics(content, "main.go").exportCount).toBe(0);
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
    expect(computeFileMetrics(content, "main.go").importCount).toBe(3);
  });

  test("counts standalone Go import", () => {
    const content = ["package main", "", 'import "fmt"', "", "func main() { fmt.Println() }"].join(
      "\n",
    );
    expect(computeFileMetrics(content, "main.go").importCount).toBe(1);
  });

  test("does not overcount Go import keyword as multiple imports", () => {
    const content = ["package main", "", "import (", '  "fmt"', ")"].join("\n");
    expect(computeFileMetrics(content, "main.go").importCount).toBe(1);
  });
});
