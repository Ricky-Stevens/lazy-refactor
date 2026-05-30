/** Tests for state delegation, language fields, pagination, and javax patterns. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFindings,
  getFindings,
  getFindingsByIds,
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

// Single-finding fetch over the id-list API (the only id-read path).
const oneFinding = async (dir, id) => (await getFindingsByIds(dir, [id])).findings[0] ?? null;

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

  it("getFindingsByIds returns a finding by id", async () => {
    const all = await getFindings(dir, {});
    const id = all[0].id;
    const found = await oneFinding(dir, id);
    expect(found).not.toBeNull();
    expect(found.id).toBe(id);
  });

  it("getFindingsByIds reports an unknown id as notFound", async () => {
    const { findings, notFound } = await getFindingsByIds(dir, ["f-nonexistent"]);
    expect(findings).toEqual([]);
    expect(notFound).toEqual(["f-nonexistent"]);
  });

  it("updateFinding changes status and adds notes", async () => {
    const all = await getFindings(dir, {});
    const id = all[0].id;

    const updated = await updateFinding(dir, id, { status: "fixed", notes: "Resolved in PR #42" });
    expect(updated).not.toBeNull();
    expect(updated.status).toBe("fixed");
    expect(updated.notes).toBe("Resolved in PR #42");

    const refetched = await oneFinding(dir, id);
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

// ─── update_findings batch tool + compact projection ─────────────────────────

describe("update_findings tool and compact get_findings", () => {
  let dir;
  let tools;

  beforeEach(async () => {
    dir = await makeTempDir();
    await addFindings(
      dir,
      [
        {
          check: "dead-code",
          severity: "low",
          category: "dead-code",
          locations: [{ file: "src/utils.js", startLine: 10 }],
          description: "Exported symbol unused",
          confidence: 0.9,
          snippet: "x".repeat(500),
        },
        {
          check: "metrics-long-file",
          severity: "medium",
          category: "metrics",
          locations: [{ file: "src/main.js", startLine: 1 }],
          description: "File exceeds line threshold",
          confidence: 0.95,
        },
      ],
      "scan-1",
      dir,
    );

    // Capture the real tool handlers by passing a minimal fake server.
    const { registerStateTools } = await import("./tools-state.js");
    tools = {};
    registerStateTools({ registerTool: (name, _def, handler) => (tools[name] = handler) }, dir);
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  const payload = (res) => JSON.parse(res.content[0].text);

  it("get_findings compact mode drops bulky fields and flattens location", async () => {
    const res = await tools.get_findings({ compact: true });
    const { findings } = payload(res);
    expect(findings).toHaveLength(2);
    const f = findings[0];
    expect(f).toHaveProperty("id");
    expect(f).toHaveProperty("file");
    expect(f).toHaveProperty("startLine");
    expect(f).not.toHaveProperty("locations");
    expect(f).not.toHaveProperty("snippet");
  });

  it("update_findings applies per-item updates and returns counts", async () => {
    const all = await getFindings(dir, {});
    const res = await tools.update_findings({
      updates: [{ id: all[0].id, status: "fixed" }],
    });
    const out = payload(res);
    expect(out.updated).toBe(1);
    expect(out.notFound).toEqual([]);
    expect((await oneFinding(dir, all[0].id)).status).toBe("fixed");
  });

  it("update_findings applies a filter-mode bulk change in one call", async () => {
    const res = await tools.update_findings({
      filter: { category: "metrics" },
      status: "ignored",
    });
    expect(payload(res).updated).toBe(1);
    const metrics = await getFindings(dir, { category: "metrics", status: "ignored" });
    expect(metrics).toHaveLength(1);
  });

  it("update_findings rejects more than one selection mode", async () => {
    const res = await tools.update_findings({ ids: ["x"], filter: {}, status: "fixed" });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toContain("exactly one");
  });

  it("update_findings rejects ids/filter mode without status, notes, or severity", async () => {
    const res = await tools.update_findings({ ids: ["x"] });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toContain("status, notes, or severity");
  });

  it("update_findings patches severity in both the indexed column and the blob", async () => {
    // The dead-code finding starts at 'low'. Upgrade it via the ids mode.
    const lows = await getFindings(dir, { severity: "low" });
    expect(lows).toHaveLength(1);
    const id = lows[0].id;

    const res = await tools.update_findings({ ids: [id], severity: "critical" });
    expect(payload(res).updated).toBe(1);

    // Blob read (getFindingsByIds → rowToFinding parses the data blob).
    expect((await oneFinding(dir, id)).severity).toBe("critical");
    // Indexed-column read (getFindings severity filter hits the column).
    const criticals = await getFindings(dir, { severity: "critical" });
    expect(criticals.map((f) => f.id)).toContain(id);
    expect(await getFindings(dir, { severity: "low" })).toHaveLength(0);
  });

  it("update_findings sets severity per-item alongside status", async () => {
    const all = await getFindings(dir, {});
    const res = await tools.update_findings({
      updates: [{ id: all[0].id, status: "in-progress", severity: "high" }],
    });
    expect(payload(res).updated).toBe(1);
    const f = await oneFinding(dir, all[0].id);
    expect(f.status).toBe("in-progress");
    expect(f.severity).toBe("high");
  });

  it("update_finding (singular) patches severity alone and rejects an empty patch", async () => {
    const all = await getFindings(dir, {});
    const ok = await tools.update_finding({ id: all[0].id, severity: "critical" });
    expect(payload(ok).severity).toBe("critical");
    expect((await oneFinding(dir, all[0].id)).severity).toBe("critical");

    const bad = await tools.update_finding({ id: all[0].id });
    expect(bad.isError).toBe(true);
    expect(payload(bad).error).toContain("at least one");
  });

  it("preserves an assessor severity override across a re-scan, but lets the engine update non-overridden findings", async () => {
    const all = await getFindings(dir, {});
    const deadCode = all.find((f) => f.check === "dead-code"); // engine: low
    const metric = all.find((f) => f.check === "metrics-long-file"); // engine: medium

    // Assessor overrides the dead-code finding low -> critical.
    await tools.update_findings({ ids: [deadCode.id], severity: "critical" });

    // Re-scan the SAME findings (same check/file/line/description => same ids), but the
    // engine now reports DIFFERENT severities for both.
    await addFindings(
      dir,
      [
        {
          check: "dead-code",
          severity: "high", // engine low -> high
          category: "dead-code",
          locations: [{ file: "src/utils.js", startLine: 10 }],
          description: "Exported symbol unused",
          confidence: 0.9,
        },
        {
          check: "metrics-long-file",
          severity: "low", // engine medium -> low
          category: "metrics",
          locations: [{ file: "src/main.js", startLine: 1 }],
          description: "File exceeds line threshold",
          confidence: 0.95,
        },
      ],
      "scan-2",
      dir,
    );

    const deadAfter = await oneFinding(dir, deadCode.id);
    const metricAfter = await oneFinding(dir, metric.id);

    // Override survived (engine's 'high' ignored) in BOTH the blob (read) ...
    expect(deadAfter.severity).toBe("critical");
    // ... and the indexed column (filter).
    expect((await getFindings(dir, { severity: "critical" })).map((f) => f.id)).toContain(
      deadCode.id,
    );
    // The non-overridden finding follows the engine's fresh value.
    expect(metricAfter.severity).toBe("low");
  });

  it("update_findings rejects an oversized batch", async () => {
    const big = Array.from({ length: 10001 }, (_, i) => ({ id: `f-${i}`, status: "fixed" }));
    const res = await tools.update_findings({ updates: big });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toContain("too large");
  });

  it("update_findings rejects over-long notes", async () => {
    const all = await getFindings(dir, {});
    const res = await tools.update_findings({
      ids: [all[0].id],
      status: "fixed",
      notes: "x".repeat(8193),
    });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toContain("too long");
  });

  it("get_findings paginates via SQL limit/offset and preserves total", async () => {
    const d2 = await makeTempDir();
    try {
      const five = Array.from({ length: 5 }, (_, i) => ({
        check: "c",
        severity: "low",
        category: "metrics",
        locations: [{ file: `p${i}.js`, startLine: 1 }],
        description: `p${i}`,
        confidence: 0.9,
        id: `p-${i}`,
      }));
      await addFindings(d2, five, "scan-page", d2);
      const t2 = {};
      const { registerStateTools } = await import("./tools-state.js");
      registerStateTools({ registerTool: (name, _def, handler) => (t2[name] = handler) }, d2);

      const res = await t2.get_findings({ limit: 2, offset: 1 });
      const p = payload(res);
      expect(p.total).toBe(5);
      expect(p.findings).toHaveLength(2);
      expect(p.offset).toBe(1);
      expect(p.limit).toBe(2);
      expect(p.truncated).toBe(true);
    } finally {
      await cleanup(d2);
    }
  });

  it("get_findings_by_ids fetches by id list (compact) and reports notFound", async () => {
    const all = await getFindings(dir, {});
    const res = await tools.get_findings_by_ids({ ids: [all[0].id, "f-missing"], compact: true });
    const out = payload(res);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toHaveProperty("file");
    expect(out.findings[0]).not.toHaveProperty("locations");
    expect(out.notFound).toEqual(["f-missing"]);
  });

  it("count_findings counts by filter without fetching", async () => {
    const res = await tools.count_findings({ filter: { category: "metrics" } });
    expect(payload(res).count).toBe(1);
  });

  it("prune_findings deletes stale findings only", async () => {
    const all = await getFindings(dir, {});
    await tools.update_findings({ ids: [all[0].id], status: "stale" });
    const res = await tools.prune_findings({});
    expect(payload(res).deleted).toBe(1);
    // The other finding is untouched.
    expect((await getFindings(dir, {})).length).toBe(1);
  });

  it("prune_findings rejects an invalid status", async () => {
    const res = await tools.prune_findings({ status: ["bogus"] });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toContain("Invalid status");
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
