import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFindings,
  clearFindings,
  getFinding,
  getFindings,
  getSummary,
  loadFindings,
} from "./findings.js";

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

let projectPath;

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), "lazy-findings-query-"));
});

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getFindings
// ---------------------------------------------------------------------------

describe("getFindings", () => {
  beforeEach(async () => {
    await addFindings(
      projectPath,
      [
        {
          ...makeFinding(),
          id: "f-00000001",
          severity: "critical",
          category: "security",
          language: "javascript",
          status: "open",
        },
        {
          ...makeFinding(),
          id: "f-00000002",
          severity: "high",
          category: "security",
          language: "typescript",
          status: "open",
        },
        {
          ...makeFinding(),
          id: "f-00000003",
          severity: "medium",
          category: "maintainability",
          language: "javascript",
          status: "fixed",
        },
        {
          ...makeFinding(),
          id: "f-00000004",
          severity: "low",
          category: "style",
          language: "go",
          status: "ignored",
        },
      ],
      "scan-1",
      "/repo",
    );
  });

  it("returns all findings when no filter", async () => {
    expect(await getFindings(projectPath)).toHaveLength(4);
  });

  it("filters by single severity string", async () => {
    const results = await getFindings(projectPath, { severity: "critical" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("f-00000001");
  });

  it("filters by severity array", async () => {
    expect(await getFindings(projectPath, { severity: ["critical", "high"] })).toHaveLength(2);
  });

  it("filters by category", async () => {
    expect(await getFindings(projectPath, { category: "security" })).toHaveLength(2);
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
    expect(await getFinding(projectPath, "f-missing")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------

describe("getSummary", () => {
  it("returns correct counts", async () => {
    await addFindings(
      projectPath,
      [
        {
          ...makeFinding(),
          id: "f-00000001",
          severity: "critical",
          category: "security",
          status: "open",
        },
        {
          ...makeFinding(),
          id: "f-00000002",
          severity: "critical",
          category: "security",
          status: "fixed",
        },
        {
          ...makeFinding(),
          id: "f-00000003",
          severity: "medium",
          category: "style",
          status: "open",
        },
      ],
      "scan-1",
      "/repo",
    );
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

// ---------------------------------------------------------------------------
// clearFindings
// ---------------------------------------------------------------------------

describe("clearFindings", () => {
  it("clears all findings and resets state", async () => {
    await addFindings(
      projectPath,
      [makeFinding({ check: "a" }), makeFinding({ check: "b", severity: "high" })],
      "scan-1",
      "/repo",
    );
    expect((await loadFindings(projectPath)).findings).toHaveLength(2);

    await clearFindings(projectPath);
    const state = await loadFindings(projectPath);
    expect(state.scanId).toBeNull();
    expect(state.path).toBeNull();
    expect(state.findings).toEqual([]);
    expect(state.summary.totalFindings).toBe(0);
    expect(state.summary.bySeverity).toEqual({});
    expect(state.summary.byCategory).toEqual({});
    expect(state.summary.byStatus).toEqual({});
  });

  it("releases the lock after clearing so subsequent writes work", async () => {
    await addFindings(projectPath, [makeFinding({ check: "before-clear" })], "scan-1", "/repo");
    await clearFindings(projectPath);
    await addFindings(projectPath, [makeFinding({ check: "after-clear" })], "scan-2", "/repo");
    const state = await loadFindings(projectPath);
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0].check).toBe("after-clear");
  });

  it("works correctly even when no findings existed", async () => {
    await clearFindings(projectPath);
    expect((await loadFindings(projectPath)).findings).toEqual([]);
  });
});
