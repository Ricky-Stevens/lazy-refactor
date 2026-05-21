/** Tests for state delegation, language fields, pagination, and javax patterns. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFindings,
  getFinding,
  getFindings,
  getSummary,
  updateFinding,
} from "../state/findings.js";
import { checkOutdatedDeps } from "./server.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "lazy-refactor-test-"));
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}

// ─── State delegation: get_findings, get_finding, update_finding, get_summary ─

describe("state delegation", () => {
  let dir;

  const sampleFindings = [
    {
      check: "dead-code",
      severity: "low",
      category: "dead-code",
      locations: [{ file: "src/utils.js", startLine: 10 }],
      description: "Exported symbol unused",
      confidence: 0.9,
    },
    {
      check: "metrics-long-file",
      severity: "medium",
      category: "metrics",
      locations: [{ file: "src/main.js", startLine: 1 }],
      description: "File exceeds line threshold",
      confidence: 0.95,
    },
  ];

  beforeEach(async () => {
    dir = await makeTempDir();
    await addFindings(dir, sampleFindings, "test-scan-1", dir);
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it("getFindings returns all findings when no filter", async () => {
    const findings = await getFindings(dir, {});
    expect(findings).toHaveLength(2);
  });

  it("getFindings filters by severity", async () => {
    const findings = await getFindings(dir, { severity: "medium" });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("medium");
  });

  it("getFindings filters by category", async () => {
    const findings = await getFindings(dir, { category: "dead-code" });
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("dead-code");
  });

  it("getFindings filters by status", async () => {
    const findings = await getFindings(dir, { status: "open" });
    expect(findings).toHaveLength(2);

    const noneFixed = await getFindings(dir, { status: "fixed" });
    expect(noneFixed).toHaveLength(0);
  });

  it("getFinding returns a finding by id", async () => {
    const all = await getFindings(dir, {});
    const id = all[0].id;
    const found = await getFinding(dir, id);
    expect(found).not.toBeNull();
    expect(found.id).toBe(id);
  });

  it("getFinding returns null for an unknown id", async () => {
    const result = await getFinding(dir, "f-nonexistent");
    expect(result).toBeNull();
  });

  it("updateFinding changes status and adds notes", async () => {
    const all = await getFindings(dir, {});
    const id = all[0].id;

    const updated = await updateFinding(dir, id, { status: "fixed", notes: "Resolved in PR #42" });
    expect(updated).not.toBeNull();
    expect(updated.status).toBe("fixed");
    expect(updated.notes).toBe("Resolved in PR #42");

    const refetched = await getFinding(dir, id);
    expect(refetched.status).toBe("fixed");
  });

  it("updateFinding returns null for unknown id", async () => {
    const result = await updateFinding(dir, "f-nonexistent", { status: "fixed" });
    expect(result).toBeNull();
  });

  it("getSummary returns correct counts", async () => {
    const summary = await getSummary(dir);
    expect(summary.totalFindings).toBe(2);
    expect(summary.bySeverity.low).toBe(1);
    expect(summary.bySeverity.medium).toBe(1);
    expect(summary.byCategory["dead-code"]).toBe(1);
    expect(summary.byCategory.metrics).toBe(1);
    expect(summary.byStatus.open).toBe(2);
  });

  it("getSummary reflects status changes", async () => {
    const all = await getFindings(dir, {});
    await updateFinding(dir, all[0].id, { status: "fixed" });
    const summary = await getSummary(dir);
    expect(summary.byStatus.fixed).toBe(1);
    expect(summary.byStatus.open).toBe(1);
  });
});

// ─── Language field on findings ───────────────────────────────────────────────

describe("language field on findings", () => {
  let stateDir;

  beforeEach(async () => {
    stateDir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanup(stateDir);
  });

  it("run_scan finding mappings include language field for pattern findings", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const helpersSrc = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "mappers.js"),
      "utf8",
    );

    const languageMatches = helpersSrc.match(/language:/g) ?? [];
    expect(languageMatches.length).toBeGreaterThanOrEqual(7);

    const mapperFns = helpersSrc.match(/export function map\w+/g) ?? [];
    expect(mapperFns.length).toBeGreaterThanOrEqual(7);
    expect(languageMatches.length).toBeGreaterThanOrEqual(mapperFns.length);
  });

  it("persisted findings have language field when added via addFindings", async () => {
    const findingsWithLang = [
      {
        check: "test-check",
        severity: "medium",
        category: "test",
        locations: [{ file: "src/test.ts", startLine: 1 }],
        description: "Test finding",
        confidence: 0.9,
        language: "typescript",
      },
      {
        check: "test-check-2",
        severity: "low",
        category: "test",
        locations: [{ file: "src/test.go", startLine: 1 }],
        description: "Test finding go",
        confidence: 0.9,
        language: "go",
      },
    ];
    await addFindings(stateDir, findingsWithLang, "scan-lang-1", stateDir);

    const results = await getFindings(stateDir, { language: "typescript" });
    expect(results).toHaveLength(1);
    expect(results[0].language).toBe("typescript");

    const goResults = await getFindings(stateDir, { language: "go" });
    expect(goResults).toHaveLength(1);
    expect(goResults[0].language).toBe("go");
  });
});

// ─── Pagination awareness ─────────────────────────────────────────────────────

describe("pagination awareness", () => {
  it("get_findings tool response includes truncated field in source", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const stateSrc = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "tools-state.js"),
      "utf8",
    );
    expect(stateSrc).toContain("truncated:");
  });

  it("pagination returns truncated=false when all results fit", async () => {
    const stateDir = await makeTempDir();
    try {
      const findings = [
        {
          check: "a",
          severity: "low",
          category: "test",
          locations: [{ file: "a.js", startLine: 1 }],
          description: "Finding A",
          confidence: 0.9,
        },
      ];
      await addFindings(stateDir, findings, "scan-1", stateDir);
      const results = await getFindings(stateDir, {});
      expect(results.length).toBeLessThanOrEqual(200);
    } finally {
      await cleanup(stateDir);
    }
  });
});

// ─── javax to jakarta outdated patterns ──────────────────────────────────────

describe("javax to jakarta outdated patterns", () => {
  let dir;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it("outdated-patterns.js contains javax.servlet entry", async () => {
    const mod = await import("../rules/outdated-patterns.js");
    const java = mod.default.java;
    const servletEntry = java.find((e) => e.from === "javax.servlet");
    expect(servletEntry).toBeDefined();
    expect(servletEntry.to).toBe("jakarta.servlet");
    expect(servletEntry.severity).toBe("high");
    expect(servletEntry.detectPattern).toContain("javax\\.servlet");
  });

  it("outdated-patterns.js contains all 6 javax entries", async () => {
    const mod = await import("../rules/outdated-patterns.js");
    const java = mod.default.java;
    const javaxFroms = [
      "javax.servlet",
      "javax.persistence",
      "javax.validation",
      "javax.inject",
      "javax.annotation",
      "javax.ws.rs",
    ];
    for (const from of javaxFroms) {
      const entry = java.find((e) => e.from === from);
      expect(entry).toBeDefined();
      expect(entry.severity).toBe("high");
      expect(entry.confidence).toBe(0.95);
    }
  });

  it("detects javax.servlet usage in Java source files", async () => {
    await writeFile(join(dir, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>");
    await writeFile(
      join(dir, "Servlet.java"),
      "import javax.servlet.http.HttpServlet;\npublic class Servlet extends HttpServlet {}\n",
    );
    const findings = await checkOutdatedDeps(dir, ["java"]);
    const match = findings.find((f) => f.from === "javax.servlet");
    expect(match).toBeDefined();
    expect(match.check).toBe("outdated-pattern");
    expect(match.severity).toBe("high");
  });

  it("detects javax.persistence usage in Java source files", async () => {
    await writeFile(join(dir, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>");
    await writeFile(
      join(dir, "Entity.java"),
      "import javax.persistence.Entity;\n@Entity\npublic class MyEntity {}\n",
    );
    const findings = await checkOutdatedDeps(dir, ["java"]);
    const match = findings.find((f) => f.from === "javax.persistence");
    expect(match).toBeDefined();
    expect(match.severity).toBe("high");
  });
});
