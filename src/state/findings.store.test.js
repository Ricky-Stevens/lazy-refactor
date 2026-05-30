import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFindings,
  computeSummary,
  getFindings,
  getFindingsByIds,
  loadFindings,
  saveFindings,
  updateFinding,
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

// Single-finding fetch over the id-list API (the only id-read path).
const oneFinding = async (p, id) => (await getFindingsByIds(p, [id])).findings[0] ?? null;

let projectPath;

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), "lazy-findings-test-"));
});

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
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
  it("creates the .lazy-refactor directory and persists state", async () => {
    const state = { scanId: "s1", path: "/repo", findings: [], summary: { totalFindings: 0 } };
    await saveFindings(projectPath, state);
    expect((await loadFindings(projectPath)).scanId).toBe("s1");
  });

  it("round-trips findings faithfully with a derived summary", async () => {
    const f = { ...makeFinding(), id: "f-abc12345" };
    await saveFindings(projectPath, { scanId: "scan-42", path: "/my/project", findings: [f] });
    const loaded = await loadFindings(projectPath);
    expect(loaded.scanId).toBe("scan-42");
    expect(loaded.path).toBe("/my/project");
    expect(loaded.findings).toEqual([f]);
    // Summary is always derived from the findings, not trusted from input.
    expect(loaded.summary).toEqual(computeSummary([f]));
  });

  it("writes a single SQLite state database, not a JSON file", async () => {
    const { existsSync } = await import("node:fs");
    const { stateDbPath } = await import("./findings-db.js");
    await saveFindings(projectPath, { scanId: "s1", path: "/repo", findings: [] });
    expect(existsSync(stateDbPath(projectPath))).toBe(true);
    expect(existsSync(join(projectPath, ".lazy-refactor", "findings.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addFindings
// ---------------------------------------------------------------------------

describe("addFindings", () => {
  it("stores findings and computes summary", async () => {
    await addFindings(
      projectPath,
      [makeFinding({ check: "a" }), makeFinding({ check: "b", severity: "high" })],
      "scan-1",
      "/repo",
    );
    const state = await loadFindings(projectPath);
    expect(state.findings).toHaveLength(2);
    expect(state.summary.totalFindings).toBe(2);
    expect(state.summary.bySeverity.medium).toBe(1);
    expect(state.summary.bySeverity.high).toBe(1);
  });

  it("deduplicates findings by ID across scans", async () => {
    const f = makeFinding({ check: "a" });
    await addFindings(projectPath, [f], "scan-1", "/repo");
    await addFindings(projectPath, [f], "scan-2", "/repo");
    expect((await loadFindings(projectPath)).findings).toHaveLength(1);
  });

  it("merges new findings with different IDs", async () => {
    await addFindings(projectPath, [makeFinding({ check: "a" })], "scan-1", "/repo");
    await addFindings(projectPath, [makeFinding({ check: "b" })], "scan-2", "/repo");
    expect((await loadFindings(projectPath)).findings).toHaveLength(2);
  });

  it("preserves user-set status on dedup merge", async () => {
    const f = { ...makeFinding({ check: "a" }), id: "f-dedup-test00001" };
    await addFindings(projectPath, [f], "scan-1", "/repo");
    await updateFinding(projectPath, "f-dedup-test00001", { status: "ignored" });
    await addFindings(projectPath, [{ ...f, status: "open" }], "scan-2", "/repo");
    const state = await loadFindings(projectPath);
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0].status).toBe("ignored");
  });

  it("assigns generated ids to findings that lack one", async () => {
    const f = makeFinding({ check: "no-id" });
    delete f.id;
    await addFindings(projectPath, [f], "scan-1", "/repo");
    expect((await loadFindings(projectPath)).findings[0].id).toMatch(/^f-[0-9a-f]{16}$/);
  });

  it("preserves existing id if provided", async () => {
    const f = { ...makeFinding(), id: "f-custom01" };
    await addFindings(projectPath, [f], "scan-1", "/repo");
    expect((await loadFindings(projectPath)).findings[0].id).toBe("f-custom01");
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
    expect((await oneFinding(projectPath, "f-00000001")).status).toBe("fixed");
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
    expect(await updateFinding(projectPath, "f-nonexistent", { status: "fixed" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadFindings cache
// ---------------------------------------------------------------------------

describe("loadFindings", () => {
  it("returns fresh objects each call so mutations do not leak into the store", async () => {
    await addFindings(projectPath, [{ ...makeFinding(), id: "f-x" }], "scan-1", "/repo");
    const first = await loadFindings(projectPath);
    first.findings[0].status = "MUTATED";
    first.findings.push({ id: "junk" });
    const second = await loadFindings(projectPath);
    expect(second.findings).toHaveLength(1);
    expect(second.findings[0].status).toBe("open");
  });

  it("immediately reflects committed writes", async () => {
    await addFindings(projectPath, [{ ...makeFinding(), id: "f-x" }], "scan-1", "/repo");
    await updateFinding(projectPath, "f-x", { status: "fixed", notes: "done" });
    const reloaded = await loadFindings(projectPath);
    expect(reloaded.findings[0].status).toBe("fixed");
    expect(reloaded.findings[0].notes).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// getFindings: file and check filters
// ---------------------------------------------------------------------------

describe("getFindings file/check filters", () => {
  beforeEach(async () => {
    await addFindings(
      projectPath,
      [
        {
          ...makeFinding({ check: "rule-x" }),
          id: "f-x",
          locations: [{ file: "src/a.js", startLine: 1 }],
        },
        {
          ...makeFinding({ check: "rule-y" }),
          id: "f-y",
          locations: [{ file: "src/b.js", startLine: 2 }],
        },
      ],
      "scan-1",
      "/repo",
    );
  });

  it("filters by file (matches any location)", async () => {
    const results = await getFindings(projectPath, { file: "src/a.js" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("f-x");
  });

  it("filters by check", async () => {
    const results = await getFindings(projectPath, { check: "rule-y" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("f-y");
  });
});
