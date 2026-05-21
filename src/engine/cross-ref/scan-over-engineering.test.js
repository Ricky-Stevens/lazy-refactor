import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanOverEngineering } from "../patterns.js";

// ---------------------------------------------------------------------------
// scanOverEngineering — zero-importer pre-filter
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
// scanOverEngineering — core checks
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
// scanOverEngineering — C# colon-based interface implementation
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
