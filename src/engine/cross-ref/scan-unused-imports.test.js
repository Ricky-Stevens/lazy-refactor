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
// scanUnusedImports — TypeScript precision (U1 inline type, U2 comments)
// ---------------------------------------------------------------------------

describe("scanUnusedImports — TypeScript precision", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "unused-ts-precision-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not flag an inline `type` import used in a type position (U1)", async () => {
    const sub = join(dir, "u1");
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(sub, "a.ts"),
      ["import { type Foo, useState } from './x';", "const v: Foo = useState();"].join("\n"),
    );
    const symbols = (await scanUnusedImports(sub, {})).map((f) => f.symbol);
    expect(symbols).not.toContain("Foo");
    expect(symbols).not.toContain("type Foo");
    expect(symbols).not.toContain("useState");
  });

  it("still flags a genuinely unused inline `type` import (U1 doesn't over-suppress)", async () => {
    const sub = join(dir, "u1-unused");
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(sub, "a.ts"),
      ["import { type Used, type Dead } from './x';", "const v: Used = 1;"].join("\n"),
    );
    const symbols = (await scanUnusedImports(sub, {})).map((f) => f.symbol);
    expect(symbols).toContain("Dead");
    expect(symbols).not.toContain("Used");
  });

  it("does not parse imports written inside comments (U2)", async () => {
    const sub = join(dir, "u2");
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(sub, "barrel.ts"),
      [
        "/**",
        " * @example",
        " * import { Button, Badge } from './ui'",
        " */",
        "export * from './button';",
        "// import { Legacy } from './old'",
      ].join("\n"),
    );
    const symbols = (await scanUnusedImports(sub, {})).map((f) => f.symbol);
    expect(symbols).not.toContain("Button");
    expect(symbols).not.toContain("Badge");
    expect(symbols).not.toContain("Legacy");
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
// scanUnusedImports — Python backslash line-continuation
// ---------------------------------------------------------------------------

describe("scanUnusedImports — Python backslash continuation", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "unused-py-backslash-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("parses backslash-continued names and never emits a '\\' symbol", async () => {
    const sub = join(dir, "cont");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "a.py"), ["from mod import foo, \\", "    bar", "foo()"].join("\n"));

    const findings = await scanUnusedImports(sub, {});
    const symbols = findings.filter((f) => f.file.endsWith("a.py")).map((f) => f.symbol);
    // The continued name `bar` is parsed (and unused -> flagged); `foo` is used.
    expect(symbols).toContain("bar");
    expect(symbols).not.toContain("foo");
    // No garbage backslash token leaks through.
    expect(symbols).not.toContain("\\");
  });

  it("does not flag a continued name used after the continuation line", async () => {
    const sub = join(dir, "used-later");
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(sub, "b.py"),
      ["from mod import foo, \\", "    bar", "foo()", "bar()"].join("\n"),
    );

    const findings = await scanUnusedImports(sub, {});
    const symbols = findings.filter((f) => f.file.endsWith("b.py")).map((f) => f.symbol);
    expect(symbols).not.toContain("bar");
    expect(symbols).not.toContain("foo");
  });

  it("does not crash on parenthesized imports (regex-safe symbol interpolation)", async () => {
    const sub = join(dir, "paren");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "c.py"), ["from mod import (foo, bar)", "foo()"].join("\n"));

    // The contract here is "does not throw"; paren-stripping is a separate concern.
    await expect(scanUnusedImports(sub, {})).resolves.toBeArray();
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
