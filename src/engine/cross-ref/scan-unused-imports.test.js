import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanUnusedImports } from "../cross-ref.js";

// ---------------------------------------------------------------------------
// scanUnusedImports — core
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
// scanUnusedImports — C# (skipped)
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

// ---------------------------------------------------------------------------
// scanUnusedImports — Java
// ---------------------------------------------------------------------------

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
// scanUnusedImports — mixed default+named imports (Fix 5)
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
// scanUnusedImports — multi-line import support (Fix 6)
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
