import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDeadCode } from "../cross-ref.js";

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
// scanDeadCode — Go text-based dead code detection
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

