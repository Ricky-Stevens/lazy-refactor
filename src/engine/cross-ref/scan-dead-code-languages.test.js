import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDeadCode } from "../cross-ref.js";

// ---------------------------------------------------------------------------
// scanDeadCode — C# grep-based dead code detection
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
    expect(deadSymbols).not.toContain("Types");
  });
});

// ---------------------------------------------------------------------------
// scanDeadCode — Python decorated functions
// ---------------------------------------------------------------------------

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
// scanDeadCode — per-language import isolation
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
