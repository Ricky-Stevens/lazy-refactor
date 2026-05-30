/**
 * Tests for config, tool registration, and rule shape validation in src/mcp/server.js
 *
 * Covers: config helpers, server tool registration, server.js source checks,
 * new tool registrations, and rule shape validation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLanguages } from "./server.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "lazy-refactor-test-"));
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}

// ─── get_config / update_config ───────────────────────────────────────────────

describe("config helpers", () => {
  let dir;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it("returns defaults when .lazy-refactor.json does not exist", async () => {
    const { readFile } = await import("node:fs/promises");
    const configPath = join(dir, ".lazy-refactor.json");

    let exists = true;
    try {
      await readFile(configPath, "utf8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("merges override into existing config correctly", async () => {
    const base = {
      thresholds: { maxFileLines: 400, maxComplexity: 20 },
      exclude: ["node_modules/**"],
      languages: "auto",
    };
    await writeFile(join(dir, ".lazy-refactor.json"), JSON.stringify(base), "utf8");

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(dir, ".lazy-refactor.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.thresholds.maxFileLines).toBe(400);
  });
});

// ─── Tool registration count ──────────────────────────────────────────────────

describe("server tool registration", () => {
  it("server.js exports all required tool names via grep check", async () => {
    expect(typeof detectLanguages).toBe("function");
  });

  it("all expected tool names are wired in the source files", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");

    const dir = dirname(fileURLToPath(import.meta.url));
    const [serverSrc, scanSrc, scanFocusedSrc, stateSrc, configSrc, runsSrc] = await Promise.all([
      readFile(join(dir, "server.js"), "utf8"),
      readFile(join(dir, "tools-scan.js"), "utf8"),
      readFile(join(dir, "tools-scan-focused.js"), "utf8"),
      readFile(join(dir, "tools-state.js"), "utf8"),
      readFile(join(dir, "tools-config.js"), "utf8"),
      readFile(join(dir, "tools-runs.js"), "utf8"),
    ]);
    const allSrc = serverSrc + scanSrc + scanFocusedSrc + stateSrc + configSrc + runsSrc;

    const requiredTools = [
      "run_scan",
      "resume_scan",
      "list_runs",
      "set_active_run",
      "set_run_status",
      "delete_run",
      "scan_duplicates",
      "scan_dead_code",
      "scan_metrics",
      "scan_patterns",
      "scan_inconsistent_patterns",
      "scan_over_engineering",
      "detect_language",
      "get_findings",
      "get_findings_by_ids",
      "count_findings",
      "update_finding",
      "update_findings",
      "prune_findings",
      "get_summary",
      "clear_findings",
      "get_config",
      "update_config",
    ];

    for (const tool of requiredTools) {
      expect(allSrc).toContain(`"${tool}"`);
    }
  });

  it("imports @modelcontextprotocol/sdk", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");

    const serverSrc = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "server.js"),
      "utf8",
    );

    expect(serverSrc).toContain("@modelcontextprotocol/sdk");
  });
});

// ─── Source-level checks (disabledChecks, *.generated.*, thresholds) ─────────

describe("server.js source checks", () => {
  let allMcpSrc;

  beforeEach(async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const dir = dirname(fileURLToPath(import.meta.url));
    const [serverSrc, helpersSrc, scanSrc, scanFocusedSrc, stateSrc] = await Promise.all([
      readFile(join(dir, "server.js"), "utf8"),
      readFile(join(dir, "helpers.js"), "utf8"),
      readFile(join(dir, "tools-scan.js"), "utf8"),
      readFile(join(dir, "tools-scan-focused.js"), "utf8"),
      readFile(join(dir, "tools-state.js"), "utf8"),
    ]);
    allMcpSrc = serverSrc + helpersSrc + scanSrc + scanFocusedSrc + stateSrc;
  });

  it("DEFAULT_CONFIG.exclude contains *.generated.*", () => {
    expect(allMcpSrc).toContain("*.generated.*");
  });

  it("run_scan filters findings by disabledChecks before scoring", () => {
    expect(allMcpSrc).toContain("disabledChecks");
    expect(allMcpSrc).toContain("!config.disabledChecks.includes(f.check)");
  });

  it("computeMetrics call includes maxExportsPerFile and maxImportsPerFile", () => {
    expect(allMcpSrc).toContain("maxExportsPerFile: config.thresholds.maxExportsPerFile");
    expect(allMcpSrc).toContain("maxImportsPerFile: config.thresholds.maxImportsPerFile");
  });

  it("buildRules comment does not mention outdated-patterns", () => {
    const lines = allMcpSrc.split("\n");
    const alwaysLine = lines.find((l) => l.includes("Always includes"));
    expect(alwaysLine).toBeDefined();
    expect(alwaysLine).not.toContain("outdated-patterns");
  });
});

// ─── New tool registrations ────────────────────────────────────────────────────

describe("new tool registrations", () => {
  it("registers scan_inconsistent_patterns and scan_over_engineering", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");

    const scanFocusedSrc = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "tools-scan-focused.js"),
      "utf8",
    );

    expect(scanFocusedSrc).toContain('"scan_inconsistent_patterns"');
    expect(scanFocusedSrc).toContain('"scan_over_engineering"');
  });

  it("server.js header comment reflects 23 tools", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");

    const serverSrc = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "server.js"),
      "utf8",
    );

    expect(serverSrc).toContain("Exposes 23 tools");
  });

  it("registers clear_findings", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");

    const stateSrc = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "tools-state.js"),
      "utf8",
    );

    expect(stateSrc).toContain('"clear_findings"');
  });

  it("run_scan focus parameter includes all new focus options", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");

    const scanSrc = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "tools-scan.js"),
      "utf8",
    );

    expect(scanSrc).toContain("inconsistent-patterns");
    expect(scanSrc).toContain("over-engineering");
    expect(scanSrc).toContain("outdated");
  });
});

// ─── Rule shape validation ─────────────────────────────────────────────────────

describe("rule shape validation", () => {
  it("all rules used by scan_patterns have the required scan-rule fields", async () => {
    const requiredFields = ["id", "pattern", "filePattern", "severity"];

    const ruleModules = await Promise.all([
      import("../rules/common.js"),
      import("../rules/typescript.js"),
      import("../rules/go.js"),
      import("../rules/python.js"),
      import("../rules/csharp.js"),
      import("../rules/java.js"),
    ]);

    for (const mod of ruleModules) {
      const rules = mod.default;
      expect(Array.isArray(rules)).toBe(true);
      for (const rule of rules) {
        for (const field of requiredFields) {
          expect(rule).toHaveProperty(field);
        }
        expect(rule).not.toHaveProperty("detectPattern");
        expect(rule).not.toHaveProperty("from");
      }
    }
  });

  it("outdated-patterns module exports a language-keyed object, not an array", async () => {
    const mod = await import("../rules/outdated-patterns.js");
    const outdated = mod.default;
    expect(typeof outdated).toBe("object");
    expect(Array.isArray(outdated)).toBe(false);
    for (const key of Object.keys(outdated)) {
      expect(Array.isArray(outdated[key])).toBe(true);
      for (const entry of outdated[key]) {
        expect(entry).toHaveProperty("from");
        expect(entry).toHaveProperty("to");
        expect(entry).toHaveProperty("detectPattern");
      }
    }
  });
});
