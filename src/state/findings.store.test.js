import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFindings,
  getFinding,
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
  it("creates the .lazy-refactor directory and writes JSON", async () => {
    const state = { scanId: "s1", path: "/repo", findings: [], summary: { totalFindings: 0 } };
    await saveFindings(projectPath, state);
    expect((await loadFindings(projectPath)).scanId).toBe("s1");
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
    expect(await loadFindings(projectPath)).toEqual(state);
  });

  it("does not leave a tmp file behind after a successful write", async () => {
    const { readdir } = await import("node:fs/promises");
    await saveFindings(projectPath, {
      scanId: "s1",
      path: "/repo",
      findings: [],
      summary: { totalFindings: 0 },
    });
    const contents = await readdir(join(projectPath, ".lazy-refactor"));
    expect(contents).toContain("findings.json");
    expect(contents.filter((n) => n.includes(".tmp."))).toHaveLength(0);
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
    expect((await getFinding(projectPath, "f-00000001")).status).toBe("fixed");
  });

  it("adds notes to a finding", async () => {
    const f = { ...makeFinding(), id: "f-00000002" };
    await addFindings(projectPath, [f], "scan-1", "/repo");
    const updated = await updateFinding(projectPath, "f-00000002", { notes: "Confirmed false positive" });
    expect(updated.notes).toBe("Confirmed false positive");
  });

  it("returns null when finding does not exist", async () => {
    expect(await updateFinding(projectPath, "f-nonexistent", { status: "fixed" })).toBeNull();
  });
});

