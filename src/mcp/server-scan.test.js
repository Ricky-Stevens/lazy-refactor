/**
 * Tests for language detection and scan integration in src/mcp/server.js
 *
 * Covers: detectLanguages (root and subdirectory), run_scan integration.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFindings, getSummary } from "../state/findings.js";
import { detectLanguages } from "./server.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "lazy-refactor-test-"));
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}

// ─── detect_language ──────────────────────────────────────────────────────────

describe("detectLanguages", () => {
  let dir;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it("detects typescript from package.json with typescript dependency", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { typescript: "^5.0.0" } }),
    );
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("typescript");
    expect(result.markers["package.json"]).toBe(true);
    expect(result.markers.typescript).toBe(true);
  });

  it("detects typescript from tsconfig.json when no package.json", async () => {
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("typescript");
    expect(result.markers["tsconfig.json"]).toBe(true);
  });

  it("detects go from go.mod", async () => {
    await writeFile(join(dir, "go.mod"), "module example.com/myapp\n\ngo 1.21\n");
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("go");
    expect(result.markers["go.mod"]).toBe(true);
  });

  it("detects python from requirements.txt", async () => {
    await writeFile(join(dir, "requirements.txt"), "requests==2.31.0\nflask>=3.0\n");
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("python");
    expect(result.markers["requirements.txt"]).toBe(true);
  });

  it("detects python from pyproject.toml", async () => {
    await writeFile(join(dir, "pyproject.toml"), '[tool.poetry]\nname = "myapp"\n');
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("python");
    expect(result.markers["pyproject.toml"]).toBe(true);
  });

  it("detects csharp from .csproj file", async () => {
    await writeFile(join(dir, "MyApp.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("csharp");
    expect(result.markers["MyApp.csproj"]).toBe(true);
  });

  it("detects csharp from .sln file", async () => {
    await writeFile(join(dir, "MySolution.sln"), "Microsoft Visual Studio Solution File");
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("csharp");
    expect(result.markers["MySolution.sln"]).toBe(true);
  });

  it("detects java from pom.xml", async () => {
    await writeFile(join(dir, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>");
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("java");
    expect(result.markers["pom.xml"]).toBe(true);
  });

  it("detects java from build.gradle", async () => {
    await writeFile(join(dir, "build.gradle"), "plugins { id 'java' }");
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("java");
    expect(result.markers["build.gradle"]).toBe(true);
  });

  it("detects multiple languages in the same project", async () => {
    await writeFile(join(dir, "go.mod"), "module example.com/app\ngo 1.21\n");
    await writeFile(join(dir, "requirements.txt"), "requests==2.31.0\n");
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("go");
    expect(result.languages).toContain("python");
  });

  it("detects python from setup.py", async () => {
    await writeFile(join(dir, "setup.py"), 'from setuptools import setup\nsetup(name="myapp")\n');
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("python");
    expect(result.markers["setup.py"]).toBe(true);
  });

  it("returns empty languages for an empty directory", async () => {
    const result = await detectLanguages(dir);
    expect(result.languages).toEqual([]);
    expect(Object.keys(result.markers)).toHaveLength(0);
  });
});

// ─── run_scan integration (small fixture) ─────────────────────────────────────

describe("run_scan integration", () => {
  let scanDir;
  let stateDir;

  beforeEach(async () => {
    scanDir = await makeTempDir();
    stateDir = await makeTempDir();

    await writeFile(
      join(scanDir, "package.json"),
      JSON.stringify({
        name: "test-fixture",
        dependencies: { typescript: "^5.0.0" },
      }),
    );
    await writeFile(
      join(scanDir, "src.ts"),
      [
        "export function unusedHelper() { return 42; }",
        "export function add(a: number, b: number): number { return a + b; }",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await cleanup(scanDir);
    await cleanup(stateDir);
  });

  it("detectLanguages resolves typescript from fixture", async () => {
    const result = await detectLanguages(scanDir);
    expect(result.languages).toContain("typescript");
  });

  it("addFindings stores and getSummary reflects findings from a scan run", async () => {
    const { scoreFindings } = await import("../scoring/prioritizer.js");

    const rawFindings = [
      {
        check: "metrics-long-file",
        severity: "medium",
        category: "metrics",
        locations: [{ file: "src.ts", startLine: 1 }],
        description: "File too long",
        confidence: 0.95,
      },
    ];
    const scored = scoreFindings(rawFindings);
    await addFindings(stateDir, scored, "scan-integration-1", scanDir);

    const summary = await getSummary(stateDir);
    expect(summary.totalFindings).toBe(1);
    expect(summary.bySeverity.medium).toBe(1);
  });
});

// ─── Root-aware language detection ────────────────────────────────────────────

describe("root-aware language detection", () => {
  let dir;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it("detects typescript from web/package.json in subdirectory", async () => {
    await mkdir(join(dir, "web"), { recursive: true });
    await writeFile(
      join(dir, "web", "package.json"),
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
    );
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("typescript");
    expect(result.markers["web/package.json"]).toBe(true);
  });

  it("detects go from api/go.mod in subdirectory", async () => {
    await mkdir(join(dir, "api"), { recursive: true });
    await writeFile(join(dir, "api", "go.mod"), "module example.com/api\ngo 1.21\n");
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("go");
    expect(result.markers["api/go.mod"]).toBe(true);
  });

  it("detects python from ml/requirements.txt in subdirectory", async () => {
    await mkdir(join(dir, "ml"), { recursive: true });
    await writeFile(join(dir, "ml", "requirements.txt"), "numpy==1.24.0\n");
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("python");
    expect(result.markers["ml/requirements.txt"]).toBe(true);
  });

  it("detects java from services/pom.xml in subdirectory", async () => {
    await mkdir(join(dir, "services"), { recursive: true });
    await writeFile(
      join(dir, "services", "pom.xml"),
      "<project><modelVersion>4.0.0</modelVersion></project>",
    );
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("java");
    expect(result.markers["services/pom.xml"]).toBe(true);
  });

  it("detects csharp from backend/*.csproj in subdirectory", async () => {
    await mkdir(join(dir, "backend"), { recursive: true });
    await writeFile(
      join(dir, "backend", "App.csproj"),
      '<Project Sdk="Microsoft.NET.Sdk"></Project>',
    );
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("csharp");
    expect(result.markers["backend/App.csproj"]).toBe(true);
  });

  it("does not duplicate language when found in both root and subdirectory", async () => {
    await writeFile(join(dir, "go.mod"), "module example.com/root\ngo 1.21\n");
    await mkdir(join(dir, "api"), { recursive: true });
    await writeFile(join(dir, "api", "go.mod"), "module example.com/api\ngo 1.21\n");
    const result = await detectLanguages(dir);
    const goCount = result.languages.filter((l) => l === "go").length;
    expect(goCount).toBe(1);
  });

  it("does not recurse into .hidden or node_modules subdirectories", async () => {
    await mkdir(join(dir, ".hidden"), { recursive: true });
    await writeFile(join(dir, ".hidden", "go.mod"), "module hidden\ngo 1.21\n");
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "go.mod"), "module nm\ngo 1.21\n");
    const result = await detectLanguages(dir);
    expect(result.languages).not.toContain("go");
  });

  it("detects multiple languages from different subdirectories", async () => {
    await mkdir(join(dir, "web"), { recursive: true });
    await writeFile(join(dir, "web", "package.json"), JSON.stringify({ dependencies: {} }));
    await mkdir(join(dir, "api"), { recursive: true });
    await writeFile(join(dir, "api", "go.mod"), "module example.com/api\ngo 1.21\n");
    await mkdir(join(dir, "ml"), { recursive: true });
    await writeFile(join(dir, "ml", "requirements.txt"), "torch==2.0\n");
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("typescript");
    expect(result.languages).toContain("go");
    expect(result.languages).toContain("python");
  });

  it("detects python from subdir pyproject.toml", async () => {
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(join(dir, "data", "pyproject.toml"), '[tool.poetry]\nname = "data"\n');
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("python");
    expect(result.markers["data/pyproject.toml"]).toBe(true);
  });

  it("detects java from subdir build.gradle", async () => {
    await mkdir(join(dir, "svc"), { recursive: true });
    await writeFile(join(dir, "svc", "build.gradle"), "plugins { id 'java' }");
    const result = await detectLanguages(dir);
    expect(result.languages).toContain("java");
    expect(result.markers["svc/build.gradle"]).toBe(true);
  });
});
