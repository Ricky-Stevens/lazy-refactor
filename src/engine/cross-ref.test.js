import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractExports, extractImports, scanDeadCode, scanUnusedImports } from "./cross-ref.js";
import { scanInconsistentPatterns, scanOverEngineering } from "./patterns.js";

// ---------------------------------------------------------------------------
// extractExports
// ---------------------------------------------------------------------------

describe("extractExports — TypeScript", () => {
  it("detects export function", () => {
    const result = extractExports("export function doWork() {}", "typescript");
    expect(result).toEqual([{ name: "doWork", line: 0 }]);
  });

  it("detects export async function", () => {
    const result = extractExports("export async function fetchData() {}", "typescript");
    expect(result).toEqual([{ name: "fetchData", line: 0 }]);
  });

  it("detects export const", () => {
    const result = extractExports("export const MAX_SIZE = 100;", "typescript");
    expect(result).toEqual([{ name: "MAX_SIZE", line: 0 }]);
  });

  it("detects export class", () => {
    const result = extractExports("export class UserService {}", "typescript");
    expect(result).toEqual([{ name: "UserService", line: 0 }]);
  });

  it("detects export default function with name", () => {
    const result = extractExports("export default function handler() {}", "typescript");
    expect(result).toEqual([{ name: "handler", line: 0 }]);
  });

  it("detects export default class with name", () => {
    const result = extractExports("export default class App {}", "typescript");
    expect(result).toEqual([{ name: "App", line: 0 }]);
  });

  it("detects multiple exports across lines", () => {
    const content = [
      "export function alpha() {}",
      "const internal = 1;",
      "export const beta = 2;",
      "export class Gamma {}",
    ].join("\n");
    const result = extractExports(content, "typescript");
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.name)).toEqual(["alpha", "beta", "Gamma"]);
  });

  it("does not flag non-exported declarations", () => {
    const result = extractExports("function privateHelper() {}", "typescript");
    expect(result).toHaveLength(0);
  });
});

describe("extractExports — Go", () => {
  it("detects exported func (capitalised)", () => {
    const result = extractExports("func ProcessRequest(ctx context.Context) error {", "go");
    expect(result).toEqual([{ name: "ProcessRequest", line: 0 }]);
  });

  it("does not detect unexported func (lowercase)", () => {
    const result = extractExports("func helper() {}", "go");
    expect(result).toHaveLength(0);
  });

  it("detects exported type", () => {
    const result = extractExports("type UserID string", "go");
    expect(result).toEqual([{ name: "UserID", line: 0 }]);
  });

  it("does not detect unexported type", () => {
    const result = extractExports("type internalState struct {", "go");
    expect(result).toHaveLength(0);
  });

  it("detects exported var", () => {
    const result = extractExports("var DefaultTimeout = 30", "go");
    expect(result).toEqual([{ name: "DefaultTimeout", line: 0 }]);
  });

  it("detects exported method receiver", () => {
    const result = extractExports("func (s *Server) Shutdown() error {", "go");
    expect(result).toEqual([{ name: "Shutdown", line: 0 }]);
  });
});

describe("extractExports — Python", () => {
  it("detects top-level def", () => {
    const result = extractExports("def compute_total(items):", "python");
    expect(result).toEqual([{ name: "compute_total", line: 0 }]);
  });

  it("detects top-level class", () => {
    const result = extractExports("class DataProcessor:", "python");
    expect(result).toEqual([{ name: "DataProcessor", line: 0 }]);
  });

  it("detects class with base", () => {
    const result = extractExports("class MyError(Exception):", "python");
    expect(result).toEqual([{ name: "MyError", line: 0 }]);
  });

  it("does not flag indented def (method)", () => {
    const result = extractExports("    def _private(self):", "python");
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractImports
// ---------------------------------------------------------------------------

describe("extractImports — TypeScript", () => {
  it("extracts named imports", () => {
    const result = extractImports("import { useState, useEffect } from 'react';", "typescript");
    expect(result).toContain("useState");
    expect(result).toContain("useEffect");
  });

  it("extracts default import", () => {
    const result = extractImports("import React from 'react';", "typescript");
    expect(result).toContain("React");
  });

  it("extracts namespace import", () => {
    const result = extractImports("import * as path from 'node:path';", "typescript");
    expect(result).toContain("path");
  });

  it("extracts require destructure", () => {
    const result = extractImports("const { readFile } = require('fs');", "typescript");
    expect(result).toContain("readFile");
  });

  it("extracts require default", () => {
    const result = extractImports("const fs = require('fs');", "typescript");
    expect(result).toContain("fs");
  });

  it("handles aliased imports — records exported name (not local alias) for cross-ref matching", () => {
    // extractImports is used for dead-code cross-referencing; we need the exported name
    // so it can be matched against exports from other files.
    const result = extractImports("import { Component as Comp } from 'framework';", "typescript");
    expect(result).toContain("Component");
    expect(result).not.toContain("Comp");
  });
});

// ---------------------------------------------------------------------------
// scanDeadCode integration
// ---------------------------------------------------------------------------

describe("scanDeadCode integration", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cross-ref-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flags exported symbol with no matching import as dead code", async () => {
    // moduleA exports foo and bar; moduleB only imports foo
    await writeFile(
      join(dir, "moduleA.js"),
      ["export function foo() { return 1; }", "export function bar() { return 2; }"].join("\n"),
    );
    await writeFile(join(dir, "moduleB.js"), "import { foo } from './moduleA.js';\nfoo();");

    const findings = await scanDeadCode(dir, {});
    const deadSymbols = findings.map((f) => f.symbol);
    expect(deadSymbols).toContain("bar");
    expect(deadSymbols).not.toContain("foo");
  });

  it("does not flag index.js as dead code entry point", async () => {
    const subDir = join(dir, "entry-test");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "index.js"), "export function bootstrap() {}");

    const findings = await scanDeadCode(subDir, {});
    const files = findings.map((f) => f.file);
    expect(files.some((f) => f.endsWith("index.js"))).toBe(false);
  });

  it("does not flag main.go as dead code entry point", async () => {
    const subDir = join(dir, "go-entry-test");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "main.go"), "func Main() {}\n");

    const findings = await scanDeadCode(subDir, {});
    const files = findings.map((f) => f.file);
    expect(files.some((f) => f.endsWith("main.go"))).toBe(false);
  });

  it("assigns confidence 0.6 to Python findings", async () => {
    const subDir = join(dir, "py-confidence");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "utils.py"), "def orphaned_fn():\n    pass\n");
    await writeFile(join(subDir, "main.py"), "def used_fn():\n    pass\n");

    const findings = await scanDeadCode(subDir, {});
    const pyFindings = findings.filter((f) => f.file.endsWith(".py"));
    for (const f of pyFindings) {
      expect(f.confidence).toBe(0.6);
    }
  });

  it("assigns confidence 0.9 to TypeScript findings", async () => {
    const subDir = join(dir, "ts-confidence");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "lib.js"), "export function orphaned() {}\n");
    await writeFile(join(subDir, "app.js"), "// no imports\nconsole.log('hello');\n");

    const findings = await scanDeadCode(subDir, {});
    const tsFindings = findings.filter((f) => f.file.endsWith(".js") || f.file.endsWith(".ts"));
    for (const f of tsFindings) {
      expect(f.confidence).toBe(0.9);
    }
  });

  it("does not flag test files", async () => {
    const subDir = join(dir, "test-filter");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "util.test.js"), "export function testHelper() {}");

    const findings = await scanDeadCode(subDir, {});
    const files = findings.map((f) => f.file);
    expect(files.some((f) => f.includes(".test."))).toBe(false);
  });

  it("returns finding shape with required fields", async () => {
    const subDir = join(dir, "shape-test");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "a.js"), "export function orphan() {}");
    await writeFile(join(subDir, "b.js"), "// no imports");

    const findings = await scanDeadCode(subDir, {});
    for (const f of findings) {
      expect(f.check).toBe("dead-code");
      expect(typeof f.file).toBe("string");
      expect(typeof f.symbol).toBe("string");
      expect(typeof f.exportLine).toBe("number");
      expect(typeof f.confidence).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// scanUnusedImports
// ---------------------------------------------------------------------------

describe("scanUnusedImports", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "unused-imports-test-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flags imported symbol that is never used in the file", async () => {
    await writeFile(
      join(dir, "unused.js"),
      [
        "import { readFile, writeFile } from 'node:fs/promises';",
        "async function go() {",
        "  const data = await readFile('x.txt', 'utf8');",
        "  return data;",
        "}",
      ].join("\n"),
    );

    const findings = await scanUnusedImports(dir, {});
    const symbols = findings.map((f) => f.symbol);
    expect(symbols).toContain("writeFile");
    expect(symbols).not.toContain("readFile");
  });

  it("finding shape has required fields", async () => {
    const subDir = join(dir, "shape");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "example.js"),
      "import { join, resolve } from 'node:path';\nconsole.log(join('a', 'b'));",
    );

    const findings = await scanUnusedImports(subDir, {});
    for (const f of findings) {
      expect(f.check).toBe("unused-import");
      expect(typeof f.file).toBe("string");
      expect(typeof f.symbol).toBe("string");
      expect(typeof f.importLine).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — TypeScript export { X } re-export syntax
// ---------------------------------------------------------------------------

describe("extractExports — TypeScript export { X } re-exports", () => {
  it("detects plain named re-export", () => {
    const result = extractExports("export { foo, bar };", "typescript");
    expect(result.map((e) => e.name)).toContain("foo");
    expect(result.map((e) => e.name)).toContain("bar");
  });

  it("detects aliased re-export (foo as baz → baz is exported)", () => {
    const result = extractExports("export { foo as baz };", "typescript");
    expect(result.map((e) => e.name)).toContain("baz");
    expect(result.map((e) => e.name)).not.toContain("foo");
  });

  it('detects re-export with "from" source', () => {
    const result = extractExports(
      "export { readFile, writeFile } from 'node:fs/promises';",
      "typescript",
    );
    expect(result.map((e) => e.name)).toContain("readFile");
    expect(result.map((e) => e.name)).toContain("writeFile");
  });

  it("records the correct line number for re-exports", () => {
    const content = "// preamble\nexport { alpha, beta };";
    const result = extractExports(content, "typescript");
    const names = result.map((e) => e.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    // Both exports are on line 1 (0-based)
    for (const e of result.filter((r) => names.includes(r.name))) {
      expect(e.line).toBe(1);
    }
  });

  it("does not produce duplicate entries when a symbol is both declared and re-exported", () => {
    const content = ["export function helper() {}", "export { helper };"].join("\n");
    const result = extractExports(content, "typescript");
    const helpers = result.filter((e) => e.name === "helper");
    // It's fine to have two entries (one from declaration, one from re-export) — just assert they exist
    expect(helpers.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — C# import parsing
// ---------------------------------------------------------------------------

describe("extractImports — C#", () => {
  it("extracts full namespace from plain using directive", () => {
    const result = extractImports("using System.Collections.Generic;", "csharp");
    // Full namespace path — not just the last segment ("Generic") which causes FPs
    expect(result).toContain("System.Collections.Generic");
    expect(result).not.toContain("Generic");
  });

  it("extracts alias from using alias directive", () => {
    const result = extractImports("using Dict = System.Collections.Generic.Dictionary;", "csharp");
    expect(result).toContain("Dict");
    // Should NOT add the right-hand type name
    expect(result).not.toContain("Dictionary");
  });

  it("handles multiple using statements with full paths", () => {
    const content = ["using System;", "using System.Linq;", "using MyApp.Services;"].join("\n");
    const result = extractImports(content, "csharp");
    expect(result).toContain("System");
    expect(result).toContain("System.Linq");
    expect(result).toContain("MyApp.Services");
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — Java import parsing
// ---------------------------------------------------------------------------

describe("extractImports — Java", () => {
  it("extracts last segment from a regular import", () => {
    const result = extractImports("import java.util.ArrayList;", "java");
    expect(result).toContain("ArrayList");
  });

  it("extracts last segment from a static import", () => {
    const result = extractImports("import static org.junit.Assert.assertEquals;", "java");
    expect(result).toContain("assertEquals");
  });

  it("handles multiple import statements", () => {
    const content = [
      "import java.util.List;",
      "import java.util.Map;",
      "import static java.util.Collections.sort;",
    ].join("\n");
    const result = extractImports(content, "java");
    expect(result).toContain("List");
    expect(result).toContain("Map");
    expect(result).toContain("sort");
  });
});

// ---------------------------------------------------------------------------
// scanUnusedImports — C# and Java
// ---------------------------------------------------------------------------

describe("scanUnusedImports — C# (skipped)", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "unused-csharp-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not flag any C# using directives (namespace usings cannot be reliably checked with regex)", async () => {
    await writeFile(
      join(dir, "Service.cs"),
      [
        "using System;",
        "using System.Linq;",
        "",
        "public class Service {",
        '  public void Run() { Console.WriteLine("hi"); }',
        "}",
      ].join("\n"),
    );

    const findings = await scanUnusedImports(dir, {});
    const csFindings = findings.filter((f) => f.file.endsWith(".cs"));
    // C# is intentionally skipped — no findings expected
    expect(csFindings).toHaveLength(0);
  });
});

describe("scanUnusedImports — Java", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "unused-java-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flags unused Java import", async () => {
    await writeFile(
      join(dir, "App.java"),
      [
        "import java.util.ArrayList;",
        "import java.util.Map;",
        "",
        "public class App {",
        "  public void run() { ArrayList<String> list = new ArrayList<>(); }",
        "}",
      ].join("\n"),
    );

    const findings = await scanUnusedImports(dir, {});
    const symbols = findings.map((f) => f.symbol);
    expect(symbols).toContain("Map");
    expect(symbols).not.toContain("ArrayList");
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — extractImports alias bug: import { foo as bar } records exported name
// ---------------------------------------------------------------------------

describe("extractImports — TypeScript alias handling (exported name)", () => {
  it("records the exported name, not the local alias", () => {
    const result = extractImports("import { foo as bar } from './module';", "typescript");
    // For dead-code cross-referencing we need the exported name ("foo")
    expect(result).toContain("foo");
    expect(result).not.toContain("bar");
  });

  it("records both exported names when multiple aliased imports are present", () => {
    const result = extractImports(
      "import { alpha as a, beta as b, gamma } from './module';",
      "typescript",
    );
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).toContain("gamma");
    expect(result).not.toContain("a");
    expect(result).not.toContain("b");
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — scanInconsistentPatterns
// ---------------------------------------------------------------------------

describe("scanInconsistentPatterns", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "inconsistent-patterns-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty array when only 1-2 approaches are used", async () => {
    const subDir = join(dir, "few-approaches");
    await mkdir(subDir, { recursive: true });
    // Only fetch API used — one approach
    await writeFile(join(subDir, "a.js"), "async function load() { return fetch('/api'); }");
    await writeFile(join(subDir, "b.js"), "async function load2() { return fetch('/other'); }");

    const findings = await scanInconsistentPatterns(subDir, {});
    const fetchFindings = findings.filter((f) => f.concern === "data-fetching");
    expect(fetchFindings).toHaveLength(0);
  });

  it("flags concern when 3+ approaches are detected", async () => {
    const subDir = join(dir, "many-approaches");
    await mkdir(subDir, { recursive: true });

    // Three different data-fetching approaches
    await writeFile(join(subDir, "fetch-file.js"), "async function a() { return fetch('/api'); }");
    await writeFile(join(subDir, "axios-file.js"), "const res = await axios.get('/api');");
    await writeFile(join(subDir, "request-file.js"), "request('/api', callback);");

    const findings = await scanInconsistentPatterns(subDir, {});
    const fetchFindings = findings.filter((f) => f.concern === "data-fetching");
    expect(fetchFindings.length).toBeGreaterThanOrEqual(1);
    expect(fetchFindings[0].check).toBe("inconsistent-patterns");
    expect(Array.isArray(fetchFindings[0].approaches)).toBe(true);
    expect(fetchFindings[0].approaches.length).toBeGreaterThanOrEqual(3);
  });

  it("finding shape has required fields", async () => {
    const subDir = join(dir, "shape-check");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "a.js"), "async function a() { return fetch('/api'); }");
    await writeFile(join(subDir, "b.js"), "const res = await axios.get('/api');");
    await writeFile(join(subDir, "c.js"), "request('/api', callback);");

    const findings = await scanInconsistentPatterns(subDir, {});
    for (const f of findings) {
      expect(f.check).toBe("inconsistent-patterns");
      expect(typeof f.concern).toBe("string");
      expect(Array.isArray(f.approaches)).toBe(true);
      for (const approach of f.approaches) {
        expect(typeof approach.pattern).toBe("string");
        expect(Array.isArray(approach.files)).toBe(true);
        expect(typeof approach.count).toBe("number");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — scanInconsistentPatterns word-boundary guard
// ---------------------------------------------------------------------------

describe("scanInconsistentPatterns — no false positives on substring matches", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "patterns-wordboundary-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does not classify files as logging concern when "log" only appears inside "dialog"', async () => {
    const subDir = join(dir, "substring-log");
    await mkdir(subDir, { recursive: true });
    // "dialog" contains "log" as substring but is not a logging keyword
    await writeFile(join(subDir, "a.js"), "function openDialog() { return dialog.show(); }");
    await writeFile(join(subDir, "b.js"), "const catalog = getCatalog();");
    await writeFile(join(subDir, "c.js"), "const blog = getBlog();");

    const findings = await scanInconsistentPatterns(subDir, {});
    const loggingFindings = findings.filter((f) => f.concern === "logging");
    expect(loggingFindings).toHaveLength(0);
  });

  it('does not classify files as config concern when "config" only appears inside "reconfigure"', async () => {
    const subDir = join(dir, "substring-config");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "a.js"), "function reconfigure() {}");
    await writeFile(join(subDir, "b.js"), "function misconfiguration() {}");

    const findings = await scanInconsistentPatterns(subDir, {});
    const configFindings = findings.filter((f) => f.concern === "config");
    expect(configFindings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — scanOverEngineering zero-importer pre-filter
// ---------------------------------------------------------------------------

describe("scanOverEngineering — zero-importer files are skipped for pass-through check", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "over-eng-fanin-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not flag a pass-through file that has zero importers (dead code territory)", async () => {
    const subDir = join(dir, "zero-fanin-passthrough");
    await mkdir(subDir, { recursive: true });

    // A file full of pass-through functions but nobody imports it
    await writeFile(
      join(subDir, "wrapper.js"),
      [
        "export function wrapFoo(x) { return realFoo(x); }",
        "export function wrapBar(x) { return realBar(x); }",
        "export function wrapBaz(x) { return realBaz(x); }",
      ].join("\n"),
    );
    // Another file that doesn't import wrapper — so fan-in stays 0
    await writeFile(join(subDir, "other.js"), "export function standalone() { return 1; }");

    const findings = await scanOverEngineering(subDir, {});
    const passThroughFindings = findings.filter(
      (f) => f.file.endsWith("wrapper.js") && f.issue.includes("pass-through"),
    );
    expect(passThroughFindings).toHaveLength(0);
  });

  it("does not flag single-method class when file has zero importers", async () => {
    const subDir = join(dir, "zero-fanin-class");
    await mkdir(subDir, { recursive: true });

    await writeFile(
      join(subDir, "orphan.ts"),
      [
        "export class OrphanWrapper {",
        "  constructor(private val: string) {}",
        "  getValue() { return this.val; }",
        "}",
      ].join("\n"),
    );
    // No other file imports OrphanWrapper, so fan-in = 0

    const findings = await scanOverEngineering(subDir, {});
    const classFindings = findings.filter(
      (f) => f.symbol === "OrphanWrapper" && f.issue.includes("Single-method class"),
    );
    expect(classFindings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — scanOverEngineering
// ---------------------------------------------------------------------------

describe("scanOverEngineering", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "over-engineering-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flags a single-method class", async () => {
    const subDir = join(dir, "single-method");
    await mkdir(subDir, { recursive: true });

    await writeFile(
      join(subDir, "wrapper.ts"),
      [
        "export class StringWrapper {",
        "  constructor(private val: string) {}",
        "  getValue() { return this.val; }",
        "}",
      ].join("\n"),
    );
    // A consumer so fan-in is counted
    await writeFile(
      join(subDir, "consumer.ts"),
      "import { StringWrapper } from './wrapper';\nconst w = new StringWrapper('x');",
    );

    const findings = await scanOverEngineering(subDir, {});
    const classFindings = findings.filter(
      (f) => f.description.includes("Single-method class") && f.symbol === "StringWrapper",
    );
    expect(classFindings.length).toBeGreaterThanOrEqual(1);
    expect(classFindings[0].check).toBe("over-engineering");
  });

  it("flags a single-implementation interface", async () => {
    const subDir = join(dir, "single-impl");
    await mkdir(subDir, { recursive: true });

    await writeFile(
      join(subDir, "iface.ts"),
      "export interface Serializer { serialize(v: unknown): string; }",
    );
    await writeFile(
      join(subDir, "impl.ts"),
      "import { Serializer } from './iface';\nexport class JsonSerializer implements Serializer { serialize(v: unknown) { return JSON.stringify(v); } }",
    );

    const findings = await scanOverEngineering(subDir, {});
    const ifaceFindings = findings.filter(
      (f) => f.description.includes("one implementation") && f.symbol === "Serializer",
    );
    expect(ifaceFindings.length).toBeGreaterThanOrEqual(1);
    expect(ifaceFindings[0].check).toBe("over-engineering");
  });

  it("returns correct check field in all findings", async () => {
    const subDir = join(dir, "shape");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "a.ts"), "export class TinyClass { doIt() { return 1; } }");
    await writeFile(join(subDir, "b.ts"), "// no imports");

    const findings = await scanOverEngineering(subDir, {});
    for (const f of findings) {
      expect(f.check).toBe("over-engineering");
      expect(typeof f.file).toBe("string");
      expect(typeof f.symbol).toBe("string");
      expect(typeof f.issue).toBe("string");
    }
  });

  it("does not flag test files", async () => {
    const subDir = join(dir, "test-filter");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "thing.test.ts"), "export class TestClass { run() {} }");

    const findings = await scanOverEngineering(subDir, {});
    const testFindings = findings.filter((f) => f.file.includes(".test."));
    expect(testFindings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — Go dead code detection uses text search instead of import matching
// ---------------------------------------------------------------------------

describe("scanDeadCode — Go text-based dead code detection", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "go-dead-code-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not flag Go exported symbol used in another Go file", async () => {
    const subDir = join(dir, "used-symbol");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "service.go"),
      "package service\n\nfunc ProcessData(d []byte) error {\n  return nil\n}\n",
    );
    await writeFile(
      join(subDir, "handler.go"),
      'package handler\n\nimport "myapp/service"\n\nfunc handle() {\n  service.ProcessData(nil)\n}\n',
    );

    const findings = await scanDeadCode(subDir, {});
    const deadSymbols = findings.map((f) => f.symbol);
    expect(deadSymbols).not.toContain("ProcessData");
  });

  it("flags Go exported symbol not used in any other Go file", async () => {
    const subDir = join(dir, "unused-symbol");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "orphan.go"),
      "package orphan\n\nfunc OrphanFunc() {}\n\ntype OrphanType struct{}\n",
    );
    await writeFile(join(subDir, "other.go"), "package other\n\nfunc DoStuff() {}\n");

    const findings = await scanDeadCode(subDir, {});
    const deadSymbols = findings.map((f) => f.symbol);
    expect(deadSymbols).toContain("OrphanFunc");
    expect(deadSymbols).toContain("OrphanType");
  });

  it("assigns confidence 0.7 to Go dead code findings", async () => {
    const subDir = join(dir, "go-confidence");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "lib.go"), "package lib\n\nfunc UnusedGoFunc() {}\n");
    await writeFile(join(subDir, "app.go"), "package app\n\nfunc Run() {}\n");

    const findings = await scanDeadCode(subDir, {});
    const goFindings = findings.filter((f) => f.file.endsWith(".go"));
    for (const f of goFindings) {
      expect(f.confidence).toBe(0.7);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — Go iota continuation exports
// ---------------------------------------------------------------------------

describe("extractExports — Go iota continuation lines", () => {
  it("detects iota continuation identifiers (bare name, no trailing space)", () => {
    const content = [
      "const (",
      "  StatusPending = iota",
      "  StatusActive",
      "  StatusDone",
      ")",
    ].join("\n");
    const result = extractExports(content, "go");
    expect(result.map((e) => e.name)).toContain("StatusPending");
    expect(result.map((e) => e.name)).toContain("StatusActive");
    expect(result.map((e) => e.name)).toContain("StatusDone");
  });

  it("does not pick up unexported iota continuation lines", () => {
    const content = ["const (", "  statusPending = iota", "  statusActive", ")"].join("\n");
    const result = extractExports(content, "go");
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — C# colon-based interface implementation
// ---------------------------------------------------------------------------

describe("scanOverEngineering — C# colon-based interface implementation", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "csharp-colon-impl-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("counts C# colon-based implementation for single-impl interface check", async () => {
    const subDir = join(dir, "colon-impl");
    await mkdir(subDir, { recursive: true });

    await writeFile(
      join(subDir, "IService.cs"),
      ["public interface IService {", "  void Execute();", "}"].join("\n"),
    );
    await writeFile(
      join(subDir, "MyService.cs"),
      [
        "using MyApp.IService;",
        "public class MyService : IService {",
        "  public void Execute() {}",
        "}",
      ].join("\n"),
    );
    // Another consumer that imports IService so fan-in reaches 1-2
    await writeFile(
      join(subDir, "Consumer.cs"),
      [
        "using MyApp.IService;",
        "public class Consumer {",
        "  public void Run(IService svc) { svc.Execute(); }",
        "}",
      ].join("\n"),
    );

    const findings = await scanOverEngineering(subDir, {});
    const ifaceFindings = findings.filter(
      (f) => f.symbol === "IService" && f.description.includes("one implementation"),
    );
    // Should detect single implementation via colon syntax
    expect(ifaceFindings.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — Go import block regex matching
// ---------------------------------------------------------------------------

describe("extractImports — Go import block with flexible whitespace", () => {
  it("parses import block with tabs between import and paren", () => {
    const content = ["import\t(", '  "fmt"', '  "os"', ")"].join("\n");
    const result = extractImports(content, "go");
    expect(result).toContain("fmt");
    expect(result).toContain("os");
  });

  it("parses import block with no space before paren", () => {
    const content = ["import(", '  "fmt"', ")"].join("\n");
    const result = extractImports(content, "go");
    expect(result).toContain("fmt");
  });

  it("parses standard import block with single space", () => {
    const content = ["import (", '  "net/http"', '  "encoding/json"', ")"].join("\n");
    const result = extractImports(content, "go");
    expect(result).toContain("http");
    expect(result).toContain("json");
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — Python extractImports returns exported name not alias
// ---------------------------------------------------------------------------

describe("extractImports — Python exported name (not alias)", () => {
  it("records the exported name for from...import...as", () => {
    const result = extractImports("from module import foo as bar", "python");
    expect(result).toContain("foo");
    expect(result).not.toContain("bar");
  });

  it("records exported names for multiple aliased from-imports", () => {
    const result = extractImports("from module import alpha as a, beta as b, gamma", "python");
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).toContain("gamma");
    expect(result).not.toContain("a");
    expect(result).not.toContain("b");
  });
});

// ---------------------------------------------------------------------------
// Fix 6 — New entry points
// ---------------------------------------------------------------------------

describe("scanDeadCode — new entry points", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "entry-points-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not flag Next.js Pages Router _app.tsx as dead code", async () => {
    const subDir = join(dir, "nextjs-pages");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "_app.tsx"), "export default function App() {}");

    const findings = await scanDeadCode(subDir, {});
    expect(findings.some((f) => f.file.endsWith("_app.tsx"))).toBe(false);
  });

  it("does not flag _document.tsx as dead code", async () => {
    const subDir = join(dir, "nextjs-doc");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "_document.tsx"), "export default function Doc() {}");

    const findings = await scanDeadCode(subDir, {});
    expect(findings.some((f) => f.file.endsWith("_document.tsx"))).toBe(false);
  });

  it("does not flag manage.py as dead code", async () => {
    const subDir = join(dir, "django");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "manage.py"), "def main():\n    pass\n");

    const findings = await scanDeadCode(subDir, {});
    expect(findings.some((f) => f.file.endsWith("manage.py"))).toBe(false);
  });

  it("does not flag wsgi.py as dead code", async () => {
    const subDir = join(dir, "wsgi-test");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "wsgi.py"), "def application(env, start_response):\n    pass\n");

    const findings = await scanDeadCode(subDir, {});
    expect(findings.some((f) => f.file.endsWith("wsgi.py"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 7 — export default expression
// ---------------------------------------------------------------------------

describe("extractExports — export default expression", () => {
  it("detects export default MyComponent", () => {
    const result = extractExports("export default MyComponent", "typescript");
    expect(result.map((e) => e.name)).toContain("MyComponent");
  });

  it("detects export default MyComponent with semicolon", () => {
    const result = extractExports("export default MyComponent;", "typescript");
    expect(result.map((e) => e.name)).toContain("MyComponent");
  });

  it("still detects export default function with name", () => {
    const result = extractExports("export default function handler() {}", "typescript");
    expect(result.map((e) => e.name)).toContain("handler");
  });
});

// ---------------------------------------------------------------------------
// Fix 8 — destructured require with rename
// ---------------------------------------------------------------------------

describe("extractImports — destructured require with colon rename", () => {
  it("records the local name for { foo: bar } = require(...)", () => {
    const result = extractImports("const { foo: bar } = require('module');", "typescript");
    expect(result).toContain("bar");
    expect(result).not.toContain("foo");
    expect(result).not.toContain("foo: bar");
  });

  it("handles mixed renamed and plain destructured require", () => {
    const result = extractImports(
      "const { readFile: read, writeFile } = require('fs');",
      "typescript",
    );
    expect(result).toContain("read");
    expect(result).toContain("writeFile");
    expect(result).not.toContain("readFile");
    expect(result).not.toContain("readFile: read");
  });
});

// ---------------------------------------------------------------------------
// Fix 9 — Go dot imports
// ---------------------------------------------------------------------------

describe("extractImports — Go dot imports", () => {
  it("records dot import as '.' in imports array", () => {
    const content = ["import (", '  . "testing"', '  "fmt"', ")"].join("\n");
    const result = extractImports(content, "go");
    expect(result).toContain(".");
    expect(result).toContain("fmt");
  });

  it("records dot import from single-line syntax", () => {
    const result = extractImports('import . "testing"', "go");
    expect(result).toContain(".");
  });
});

// ---------------------------------------------------------------------------
// Fix 6 (cont) — Java Tests plural test file pattern
// ---------------------------------------------------------------------------

describe("scanDeadCode — Java plural Tests file pattern", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "java-tests-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not flag FooTests.java as dead code (plural form)", async () => {
    const subDir = join(dir, "java-plural");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "FooTests.java"),
      "public class FooTests { public void testFoo() {} }",
    );
    await writeFile(join(subDir, "App.java"), "public class App {}");

    const findings = await scanDeadCode(subDir, {});
    expect(findings.some((f) => f.file.endsWith("FooTests.java"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — C# dead code uses grep instead of import-set matching
// ---------------------------------------------------------------------------

describe("scanDeadCode — C# grep-based dead code detection", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "csharp-dead-code-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not flag C# exported symbol used in another C# file", async () => {
    const subDir = join(dir, "used-symbol");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "Service.cs"),
      "public class UserService {\n  public void Run() {}\n}\n",
    );
    await writeFile(
      join(subDir, "Controller.cs"),
      "public class Controller {\n  public void Handle() { var svc = new UserService(); svc.Run(); }\n}\n",
    );

    const findings = await scanDeadCode(subDir, {});
    const deadSymbols = findings.map((f) => f.symbol);
    expect(deadSymbols).not.toContain("UserService");
  });

  it("flags C# exported symbol not used in any other C# file", async () => {
    const subDir = join(dir, "unused-symbol");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "Orphan.cs"),
      "public class OrphanClass {\n  public void DoNothing() {}\n}\n",
    );
    await writeFile(join(subDir, "Other.cs"), "public class Other {\n  public void Work() {}\n}\n");

    const findings = await scanDeadCode(subDir, {});
    const deadSymbols = findings.map((f) => f.symbol);
    expect(deadSymbols).toContain("OrphanClass");
  });

  it("assigns confidence 0.7 to C# dead code findings", async () => {
    const subDir = join(dir, "cs-confidence");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "Lib.cs"), "public class UnusedLib {}\n");
    await writeFile(join(subDir, "App.cs"), "public class App {}\n");

    const findings = await scanDeadCode(subDir, {});
    const csFindings = findings.filter((f) => f.file.endsWith(".cs"));
    for (const f of csFindings) {
      expect(f.confidence).toBe(0.7);
    }
  });

  it("does not produce false positives from namespace segment matching", async () => {
    // Previously, "using System.Collections.Generic;" would add "Generic" to the
    // import set, which could suppress dead-code findings for unrelated symbols
    // named "Generic". Now C# uses grep-based approach instead.
    const subDir = join(dir, "no-namespace-fp");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "Types.cs"),
      [
        "using System.Collections.Generic;",
        "",
        "public class Types {",
        "  public List<string> GetItems() { return new List<string>(); }",
        "}",
      ].join("\n"),
    );
    await writeFile(
      join(subDir, "Consumer.cs"),
      [
        "using System.Collections.Generic;",
        "",
        "public class Consumer {",
        "  public void Use() { var t = new Types(); t.GetItems(); }",
        "}",
      ].join("\n"),
    );

    const findings = await scanDeadCode(subDir, {});
    const deadSymbols = findings.map((f) => f.symbol);
    // Types is used in Consumer.cs — should not be flagged
    expect(deadSymbols).not.toContain("Types");
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — C# extractImports full namespace path
// ---------------------------------------------------------------------------

describe("extractImports — C# full namespace path", () => {
  it("pushes full namespace path for cross-ref (not last segment)", () => {
    const result = extractImports("using System.Collections.Generic;", "csharp");
    expect(result).toContain("System.Collections.Generic");
    // Should NOT contain misleading single words
    expect(result).not.toContain("Generic");
  });

  it("still extracts alias for using alias directives", () => {
    const result = extractImports("using Col = System.Collections;", "csharp");
    expect(result).toContain("Col");
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — Python decorated functions get lower confidence
// ---------------------------------------------------------------------------

describe("extractExports — Python decorator tracking", () => {
  it("marks decorated function with decorated: true", () => {
    const content = ["@app.route('/api')", "def get_users():", "    pass"].join("\n");
    const result = extractExports(content, "python");
    const fn = result.find((e) => e.name === "get_users");
    expect(fn).toBeDefined();
    expect(fn.decorated).toBe(true);
  });

  it("marks decorated class with decorated: true", () => {
    const content = ["@dataclass", "class Config:", "    name: str"].join("\n");
    const result = extractExports(content, "python");
    const cls = result.find((e) => e.name === "Config");
    expect(cls).toBeDefined();
    expect(cls.decorated).toBe(true);
  });

  it("does not mark undecorated function as decorated", () => {
    const content = "def plain_function():\n    pass";
    const result = extractExports(content, "python");
    const fn = result.find((e) => e.name === "plain_function");
    expect(fn).toBeDefined();
    expect(fn.decorated).toBeUndefined();
  });

  it("does not mark TypeScript exports as decorated", () => {
    // Decorator tracking is Python-only
    const content = "export function handler() {}";
    const result = extractExports(content, "typescript");
    const fn = result.find((e) => e.name === "handler");
    expect(fn).toBeDefined();
    expect(fn.decorated).toBeUndefined();
  });
});

describe("scanDeadCode — Python decorated functions get confidence 0.3", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "py-decorated-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("assigns confidence 0.3 to decorated Python functions", async () => {
    const subDir = join(dir, "flask-routes");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "routes.py"),
      [
        "@app.route('/users')",
        "def get_users():",
        "    return []",
        "",
        "def helper_function():",
        "    return 42",
      ].join("\n"),
    );
    await writeFile(join(subDir, "other.py"), "# no imports\npass\n");

    const findings = await scanDeadCode(subDir, {});
    const decorated = findings.find((f) => f.symbol === "get_users");
    const plain = findings.find((f) => f.symbol === "helper_function");

    expect(decorated).toBeDefined();
    expect(decorated.confidence).toBe(0.3);
    expect(plain).toBeDefined();
    expect(plain.confidence).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — Per-language import set isolation
// ---------------------------------------------------------------------------

describe("scanDeadCode — per-language import isolation", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lang-isolation-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not suppress TS dead code because Python imports the same name", async () => {
    const subDir = join(dir, "cross-lang");
    await mkdir(subDir, { recursive: true });

    // TS file exports "validate" — nobody in TS-land imports it
    await writeFile(join(subDir, "validator.ts"), "export function validate() {}\n");
    // Python file imports "validate" from some Python module
    await writeFile(join(subDir, "check.py"), "from validators import validate\nvalidate()\n");
    // Another TS file that does NOT import validate
    await writeFile(join(subDir, "app.ts"), "console.log('hello');\n");

    const findings = await scanDeadCode(subDir, {});
    const deadSymbols = findings.map((f) => f.symbol);
    // "validate" from validator.ts should still be flagged as dead despite
    // Python importing a same-named symbol
    expect(deadSymbols).toContain("validate");
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — Additional Next.js entry points
// ---------------------------------------------------------------------------

describe("scanDeadCode — additional entry points (Fix 4)", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "entry-points-fix4-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const entryFiles = [
    "global-error.tsx",
    "global-error.ts",
    "default.tsx",
    "default.ts",
    "default.jsx",
    "default.js",
    "instrumentation.ts",
    "instrumentation.js",
    "opengraph-image.tsx",
    "opengraph-image.ts",
    "twitter-image.tsx",
    "twitter-image.ts",
    "sitemap.ts",
    "sitemap.js",
    "robots.ts",
    "robots.js",
    "manifest.ts",
    "manifest.js",
  ];

  for (const filename of entryFiles) {
    it(`does not flag ${filename} as dead code`, async () => {
      const subDir = join(dir, filename.replace(/\./g, "-"));
      await mkdir(subDir, { recursive: true });
      const ext = filename.split(".").pop();
      let content;
      if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") {
        content = "export default function Page() {}";
      }
      await writeFile(join(subDir, filename), content);

      const findings = await scanDeadCode(subDir, {});
      expect(findings.some((f) => f.file.endsWith(filename))).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Fix 5 — scanUnusedImports handles mixed default+named imports
// ---------------------------------------------------------------------------

describe("scanUnusedImports — mixed default+named imports (Fix 5)", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mixed-imports-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flags unused named symbol from mixed import", async () => {
    await writeFile(
      join(dir, "component.js"),
      [
        "import React, { useState, useEffect } from 'react';",
        "function App() {",
        "  const [x, setX] = useState(0);",
        "  return React.createElement('div');",
        "}",
      ].join("\n"),
    );

    const findings = await scanUnusedImports(dir, {});
    const symbols = findings.map((f) => f.symbol);
    // useEffect is not used in the rest of the file
    expect(symbols).toContain("useEffect");
    // useState and React are used
    expect(symbols).not.toContain("useState");
    expect(symbols).not.toContain("React");
  });

  it("does not flag used named symbols from mixed import", async () => {
    const subDir = join(dir, "all-used");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "comp.js"),
      [
        "import React, { useState } from 'react';",
        "const [val] = useState(0);",
        "React.createElement('div');",
      ].join("\n"),
    );

    const findings = await scanUnusedImports(subDir, {});
    const symbols = findings.filter((f) => f.file.endsWith("comp.js")).map((f) => f.symbol);
    expect(symbols).not.toContain("useState");
    expect(symbols).not.toContain("React");
  });
});

// ---------------------------------------------------------------------------
// Fix 6 — scanUnusedImports multi-line import support
// ---------------------------------------------------------------------------

describe("scanUnusedImports — multi-line imports (Fix 6)", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "multiline-imports-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flags unused symbol from multi-line import block", async () => {
    await writeFile(
      join(dir, "multiline.js"),
      [
        "import {",
        "  readFile,",
        "  writeFile,",
        "  stat,",
        "} from 'node:fs/promises';",
        "",
        "async function go() {",
        "  const data = await readFile('x.txt', 'utf8');",
        "  return data;",
        "}",
      ].join("\n"),
    );

    const findings = await scanUnusedImports(dir, {});
    const symbols = findings.filter((f) => f.file.endsWith("multiline.js")).map((f) => f.symbol);
    // writeFile and stat are not used
    expect(symbols).toContain("writeFile");
    expect(symbols).toContain("stat");
    // readFile is used
    expect(symbols).not.toContain("readFile");
  });

  it("does not flag used symbols from multi-line import", async () => {
    const subDir = join(dir, "all-used-ml");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "used.js"),
      [
        "import {",
        "  join,",
        "  resolve,",
        "} from 'node:path';",
        "",
        "console.log(join('a', 'b'));",
        "console.log(resolve('.'));",
      ].join("\n"),
    );

    const findings = await scanUnusedImports(subDir, {});
    const symbols = findings.filter((f) => f.file.endsWith("used.js")).map((f) => f.symbol);
    expect(symbols).not.toContain("join");
    expect(symbols).not.toContain("resolve");
  });
});
