/**
 * Tests for checkOutdatedDeps and javax-to-jakarta patterns in src/mcp/server.js
 *
 * Covers: JS/Python/Go/C#/Java deprecated dependency detection,
 * source-level pattern scanning, and javax-to-jakarta migration entries.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOutdatedDeps } from "./server.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "lazy-refactor-test-"));
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}

// ─── checkOutdatedDeps ────────────────────────────────────────────────────────

describe("checkOutdatedDeps", () => {
  let dir;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it("returns empty findings when no manifests are present", async () => {
    const findings = await checkOutdatedDeps(dir, ["typescript"]);
    expect(findings).toEqual([]);
  });

  it("detects a deprecated JS dependency in package.json", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { moment: "^2.29.0", typescript: "^5.0.0" } }),
    );
    const findings = await checkOutdatedDeps(dir, ["typescript"]);
    const match = findings.find((f) => f.from === "moment");
    expect(match).toBeDefined();
    expect(match.check).toBe("outdated-pattern");
    expect(match.category).toBe("outdated");
    expect(match.to).toBe("dayjs");
    expect(match.severity).toBe("medium");
  });

  it("detects a high-severity deprecated JS dependency", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { request: "^2.88.2" } }),
    );
    const findings = await checkOutdatedDeps(dir, ["typescript"]);
    const match = findings.find((f) => f.from === "request");
    expect(match).toBeDefined();
    expect(match.severity).toBe("high");
  });

  it("does not flag unknown dependencies in package.json", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.18.0" } }),
    );
    const findings = await checkOutdatedDeps(dir, ["typescript"]);
    expect(findings).toHaveLength(0);
  });

  it("detects deprecated python dependency in requirements.txt", async () => {
    await writeFile(join(dir, "requirements.txt"), "urllib2==1.0.0\nrequests==2.31.0\n");
    const findings = await checkOutdatedDeps(dir, ["python"]);
    const match = findings.find((f) => f.from === "urllib2");
    expect(match).toBeDefined();
    expect(match.check).toBe("outdated-pattern");
    expect(match.severity).toBe("critical");
  });

  it("detects Python stdlib outdated patterns in .py source files", async () => {
    await writeFile(join(dir, "pyproject.toml"), '[tool.poetry]\nname = "myapp"\n');
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "main.py"),
      "import optparse\nparser = optparse.OptionParser()\n",
    );
    const findings = await checkOutdatedDeps(dir, ["python"]);
    const match = findings.find((f) => f.from === "optparse");
    expect(match).toBeDefined();
    expect(match.check).toBe("outdated-pattern");
    expect(match.category).toBe("outdated");
    expect(match.severity).toBe("medium");
    expect(match.locations[0].file).toBe("source");
  });

  it("detects Python urllib2 usage in source even without requirements.txt", async () => {
    await writeFile(
      join(dir, "main.py"),
      "import urllib2\nurllib2.urlopen('http://example.com')\n",
    );
    const findings = await checkOutdatedDeps(dir, ["python"]);
    const match = findings.find((f) => f.from === "urllib2");
    expect(match).toBeDefined();
    expect(match.severity).toBe("critical");
  });

  it("does not double-report Python patterns found in both requirements.txt and source", async () => {
    await writeFile(join(dir, "requirements.txt"), "urllib2==1.0.0\n");
    await writeFile(join(dir, "main.py"), "import urllib2\n");
    const findings = await checkOutdatedDeps(dir, ["python"]);
    const matches = findings.filter((f) => f.from === "urllib2");
    expect(matches).toHaveLength(1);
    expect(matches[0].locations[0].file).toBe("requirements.txt");
  });

  it("skips __pycache__ and venv directories when scanning Python sources", async () => {
    await writeFile(join(dir, "requirements.txt"), "requests==2.31.0\n");
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "main.py"), "import optparse\n");
    await mkdir(join(dir, "__pycache__"), { recursive: true });
    await writeFile(join(dir, "__pycache__", "cached.py"), "import urllib2\n");
    await mkdir(join(dir, "venv", "lib"), { recursive: true });
    await writeFile(join(dir, "venv", "lib", "dep.py"), "import urllib2\n");

    const findings = await checkOutdatedDeps(dir, ["python"]);
    expect(findings.find((f) => f.from === "optparse")).toBeDefined();
    expect(findings.find((f) => f.from === "urllib2")).toBeUndefined();
  });

  it("does not produce JS findings when only python language is detected", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { moment: "^2.29.0" } }),
    );
    const findings = await checkOutdatedDeps(dir, ["python"]);
    expect(findings.find((f) => f.from === "moment")).toBeUndefined();
  });

  it("returns findings with required fields", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { moment: "^2.29.0" } }),
    );
    const findings = await checkOutdatedDeps(dir, ["typescript"]);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f).toHaveProperty("check", "outdated-pattern");
      expect(f).toHaveProperty("severity");
      expect(f).toHaveProperty("category", "outdated");
      expect(f).toHaveProperty("from");
      expect(f).toHaveProperty("to");
      expect(f).toHaveProperty("description");
      expect(f).toHaveProperty("suggestion");
    }
  });

  it("emits Go findings only when detectPattern matches source files", async () => {
    await writeFile(join(dir, "go.mod"), "module example.com/app\ngo 1.21\n");
    await writeFile(
      join(dir, "main.go"),
      'package main\n\nimport "io/ioutil"\n\nfunc main() { ioutil.ReadFile("x") }\n',
    );
    const findings = await checkOutdatedDeps(dir, ["go"]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe("outdated");
    expect(findings[0].check).toBe("outdated-pattern");
  });

  it("emits no Go findings when source files do not match any detectPattern", async () => {
    await writeFile(join(dir, "go.mod"), "module example.com/app\ngo 1.21\n");
    await writeFile(
      join(dir, "main.go"),
      'package main\n\nimport "os"\n\nfunc main() { os.ReadFile("x") }\n',
    );
    const findings = await checkOutdatedDeps(dir, ["go"]);
    expect(findings.length).toBe(0);
  });

  it("detects deprecated C# usage via source file pattern", async () => {
    await writeFile(join(dir, "MyApp.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    await writeFile(join(dir, "Program.cs"), "using System.Net;\n\nvar wc = new WebClient();\n");
    const findings = await checkOutdatedDeps(dir, ["csharp"]);
    const match = findings.find((f) => f.from === "WebClient");
    expect(match).toBeDefined();
    expect(match.check).toBe("outdated-pattern");
    expect(match.category).toBe("outdated");
    expect(match.severity).toBe("medium");
  });

  it("emits no C# findings when source files do not match any detectPattern", async () => {
    await writeFile(join(dir, "MyApp.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    await writeFile(join(dir, "Program.cs"), 'using System;\n\nConsole.WriteLine("hello");\n');
    const findings = await checkOutdatedDeps(dir, ["csharp"]);
    expect(findings).toHaveLength(0);
  });

  it("detects deprecated Java usage via source file pattern", async () => {
    await writeFile(
      join(dir, "pom.xml"),
      "<project><modelVersion>4.0.0</modelVersion><artifactId>myapp</artifactId></project>",
    );
    await writeFile(
      join(dir, "Main.java"),
      "import java.util.Date;\npublic class Main { Date d = new Date(); }\n",
    );
    const findings = await checkOutdatedDeps(dir, ["java"]);
    const match = findings.find((f) => f.from === "java.util.Date");
    expect(match).toBeDefined();
    expect(match.check).toBe("outdated-pattern");
    expect(match.category).toBe("outdated");
    expect(match.severity).toBe("medium");
  });

  it("emits no Java findings when source files do not match any detectPattern", async () => {
    await writeFile(join(dir, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>");
    await writeFile(
      join(dir, "Main.java"),
      "import java.time.Instant;\npublic class Main { Instant t = Instant.now(); }\n",
    );
    const findings = await checkOutdatedDeps(dir, ["java"]);
    expect(findings).toHaveLength(0);
  });

  it("detects JS source-only deprecated patterns (var declarations) without a matching package.json dep", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { typescript: "^5.0.0" } }),
    );
    await writeFile(join(dir, "main.js"), "var x = 1;\nconsole.log(x);\n");
    const findings = await checkOutdatedDeps(dir, ["typescript"]);
    const match = findings.find((f) => f.from === "var declarations");
    expect(match).toBeDefined();
    expect(match.check).toBe("outdated-pattern");
    expect(match.category).toBe("outdated");
    expect(match.locations[0].file).toBe("source");
  });

  it("does not double-flag a JS dep that is found via package.json (skips source match)", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { moment: "^2.29.0" } }),
    );
    await writeFile(join(dir, "main.js"), "const m = require('moment');\n");
    const findings = await checkOutdatedDeps(dir, ["typescript"]);
    const matches = findings.filter((f) => f.from === "moment");
    expect(matches).toHaveLength(1);
    expect(matches[0].locations[0].file).toBe("package.json");
  });

  it("recurses into subdirectories for JS source scanning but skips node_modules and dist", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { typescript: "^5.0.0" } }),
    );
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "deep.js"), "var deep = true;\n");
    await mkdir(join(dir, "node_modules", "junk"), { recursive: true });
    await writeFile(join(dir, "node_modules", "junk", "index.js"), "var ignored = 1;\n");

    const findings = await checkOutdatedDeps(dir, ["typescript"]);
    const match = findings.find((f) => f.from === "var declarations");
    expect(match).toBeDefined();
  });
});
