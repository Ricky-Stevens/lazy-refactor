import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  addFindings,
  generateFindingId,
  getFinding,
  getFindings,
  getSummary,
  loadFindings,
  saveFindings,
  updateFinding,
} from "./findings.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides = {}) {
  return {
    check: "no-unused-vars",
    severity: "medium",
    confidence: 0.9,
    risk: "low",
    status: "open",
    category: "maintainability",
    language: "javascript",
    description: "Unused variable",
    locations: [{ file: "src/index.js", startLine: 10, endLine: 10 }],
    suggestion: "Remove unused variable",
    fixable: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown — each test gets its own temp directory
// ---------------------------------------------------------------------------

let projectPath;

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), "lazy-findings-test-"));
});

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// generateFindingId
// ---------------------------------------------------------------------------

describe("generateFindingId", () => {
  it("is deterministic — same input yields same id", () => {
    const f = makeFinding();
    expect(generateFindingId(f)).toBe(generateFindingId(f));
  });

  it("produces different ids for different inputs", () => {
    const a = makeFinding({ check: "check-a" });
    const b = makeFinding({ check: "check-b" });
    expect(generateFindingId(a)).not.toBe(generateFindingId(b));
  });

  it("starts with 'f-' and has 10 chars total", () => {
    const id = generateFindingId(makeFinding());
    expect(id).toMatch(/^f-[0-9a-f]{8}$/);
  });

  it("is stable across separate calls (pure function)", () => {
    const f = makeFinding({ check: "stable", locations: [{ file: "x.js", startLine: 42 }] });
    const id1 = generateFindingId(f);
    const id2 = generateFindingId(f);
    expect(id1).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// loadFindings
// ---------------------------------------------------------------------------

describe("loadFindings", () => {
  it("returns default state when file does not exist", async () => {
    const state = await loadFindings(projectPath);
    expect(state.scanId).toBeNull();
    expect(state.path).toBeNull();
    expect(state.findings).toEqual([]);
    expect(state.summary.totalFindings).toBe(0);
    expect(state.summary.bySeverity).toEqual({});
    expect(state.summary.byCategory).toEqual({});
    expect(state.summary.byStatus).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// saveFindings
// ---------------------------------------------------------------------------

describe("saveFindings", () => {
  it("creates the .lazy-refactor directory and writes JSON", async () => {
    const state = { scanId: "s1", path: "/repo", findings: [], summary: { totalFindings: 0 } };
    await saveFindings(projectPath, state);

    const loaded = await loadFindings(projectPath);
    expect(loaded.scanId).toBe("s1");
  });

  it("round-trips data faithfully", async () => {
    const f = { ...makeFinding(), id: "f-abc12345" };
    const state = {
      scanId: "scan-42",
      path: "/my/project",
      findings: [f],
      summary: { totalFindings: 1, bySeverity: { medium: 1 }, byCategory: {} },
    };
    await saveFindings(projectPath, state);
    const loaded = await loadFindings(projectPath);
    expect(loaded).toEqual(state);
  });
});

// ---------------------------------------------------------------------------
// addFindings
// ---------------------------------------------------------------------------

describe("addFindings", () => {
  it("stores findings and computes summary", async () => {
    const findings = [makeFinding({ check: "a" }), makeFinding({ check: "b", severity: "high" })];
    await addFindings(projectPath, findings, "scan-1", "/repo");

    const state = await loadFindings(projectPath);
    expect(state.findings).toHaveLength(2);
    expect(state.summary.totalFindings).toBe(2);
    expect(state.summary.bySeverity.medium).toBe(1);
    expect(state.summary.bySeverity.high).toBe(1);
  });

  it("replaces findings when same scanId is used", async () => {
    await addFindings(projectPath, [makeFinding({ check: "a" })], "scan-1", "/repo");
    await addFindings(projectPath, [makeFinding({ check: "b" })], "scan-1", "/repo");

    const state = await loadFindings(projectPath);
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0].check).toBe("b");
  });

  it("appends findings when scanId differs", async () => {
    await addFindings(projectPath, [makeFinding({ check: "a" })], "scan-1", "/repo");
    await addFindings(projectPath, [makeFinding({ check: "b" })], "scan-2", "/repo");

    const state = await loadFindings(projectPath);
    expect(state.findings).toHaveLength(2);
  });

  it("assigns generated ids to findings that lack one", async () => {
    const f = makeFinding({ check: "no-id" });
    delete f.id;
    await addFindings(projectPath, [f], "scan-1", "/repo");

    const state = await loadFindings(projectPath);
    expect(state.findings[0].id).toMatch(/^f-[0-9a-f]{8}$/);
  });

  it("preserves existing id if provided", async () => {
    const f = { ...makeFinding(), id: "f-custom01" };
    await addFindings(projectPath, [f], "scan-1", "/repo");

    const state = await loadFindings(projectPath);
    expect(state.findings[0].id).toBe("f-custom01");
  });
});

// ---------------------------------------------------------------------------
// updateFinding
// ---------------------------------------------------------------------------

describe("updateFinding", () => {
  it("changes status on a known finding", async () => {
    const f = { ...makeFinding(), id: "f-00000001" };
    await addFindings(projectPath, [f], "scan-1", "/repo");

    const updated = await updateFinding(projectPath, "f-00000001", { status: "fixed" });
    expect(updated.status).toBe("fixed");

    const loaded = await getFinding(projectPath, "f-00000001");
    expect(loaded.status).toBe("fixed");
  });

  it("adds notes to a finding", async () => {
    const f = { ...makeFinding(), id: "f-00000002" };
    await addFindings(projectPath, [f], "scan-1", "/repo");

    const updated = await updateFinding(projectPath, "f-00000002", {
      notes: "Confirmed false positive",
    });
    expect(updated.notes).toBe("Confirmed false positive");
  });

  it("returns null when finding does not exist", async () => {
    const result = await updateFinding(projectPath, "f-nonexistent", { status: "fixed" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getFindings
// ---------------------------------------------------------------------------

describe("getFindings", () => {
  beforeEach(async () => {
    const findings = [
      { ...makeFinding(), id: "f-00000001", severity: "critical", category: "security", language: "javascript", status: "open" },
      { ...makeFinding(), id: "f-00000002", severity: "high", category: "security", language: "typescript", status: "open" },
      { ...makeFinding(), id: "f-00000003", severity: "medium", category: "maintainability", language: "javascript", status: "fixed" },
      { ...makeFinding(), id: "f-00000004", severity: "low", category: "style", language: "go", status: "ignored" },
    ];
    await addFindings(projectPath, findings, "scan-1", "/repo");
  });

  it("returns all findings when no filter", async () => {
    const results = await getFindings(projectPath);
    expect(results).toHaveLength(4);
  });

  it("filters by single severity string", async () => {
    const results = await getFindings(projectPath, { severity: "critical" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("f-00000001");
  });

  it("filters by severity array", async () => {
    const results = await getFindings(projectPath, { severity: ["critical", "high"] });
    expect(results).toHaveLength(2);
  });

  it("filters by category", async () => {
    const results = await getFindings(projectPath, { category: "security" });
    expect(results).toHaveLength(2);
  });

  it("filters by status", async () => {
    const results = await getFindings(projectPath, { status: "fixed" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("f-00000003");
  });

  it("filters by language", async () => {
    const results = await getFindings(projectPath, { language: "go" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("f-00000004");
  });

  it("combines multiple filters", async () => {
    const results = await getFindings(projectPath, { severity: "high", category: "security" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("f-00000002");
  });
});

// ---------------------------------------------------------------------------
// getFinding
// ---------------------------------------------------------------------------

describe("getFinding", () => {
  it("returns single finding by id", async () => {
    const f = { ...makeFinding(), id: "f-00000001" };
    await addFindings(projectPath, [f], "scan-1", "/repo");

    const result = await getFinding(projectPath, "f-00000001");
    expect(result).not.toBeNull();
    expect(result.id).toBe("f-00000001");
  });

  it("returns null when id is not found", async () => {
    const result = await getFinding(projectPath, "f-missing");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------

describe("getSummary", () => {
  it("returns correct counts", async () => {
    const findings = [
      { ...makeFinding(), id: "f-00000001", severity: "critical", category: "security", status: "open" },
      { ...makeFinding(), id: "f-00000002", severity: "critical", category: "security", status: "fixed" },
      { ...makeFinding(), id: "f-00000003", severity: "medium", category: "style", status: "open" },
    ];
    await addFindings(projectPath, findings, "scan-1", "/repo");

    const summary = await getSummary(projectPath);
    expect(summary.totalFindings).toBe(3);
    expect(summary.bySeverity.critical).toBe(2);
    expect(summary.bySeverity.medium).toBe(1);
    expect(summary.byCategory.security).toBe(2);
    expect(summary.byCategory.style).toBe(1);
    expect(summary.byStatus.open).toBe(2);
    expect(summary.byStatus.fixed).toBe(1);
  });

  it("returns zeroed summary when there are no findings", async () => {
    const summary = await getSummary(projectPath);
    expect(summary.totalFindings).toBe(0);
    expect(summary.bySeverity).toEqual({});
    expect(summary.byCategory).toEqual({});
    expect(summary.byStatus).toEqual({});
  });
});
