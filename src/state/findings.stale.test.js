import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFindings,
  computeSummary,
  generateFindingId,
  getFindings,
  loadFindings,
  updateFinding,
  VALID_STATUSES,
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
  projectPath = await mkdtemp(join(tmpdir(), "lazy-findings-stale-"));
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
    expect(generateFindingId(makeFinding({ check: "check-a" }))).not.toBe(
      generateFindingId(makeFinding({ check: "check-b" })),
    );
  });

  it("starts with 'f-' and has 18 chars total", () => {
    expect(generateFindingId(makeFinding())).toMatch(/^f-[0-9a-f]{16}$/);
  });

  it("is stable across separate calls (pure function)", () => {
    const f = makeFinding({ check: "stable", locations: [{ file: "x.js", startLine: 42 }] });
    expect(generateFindingId(f)).toBe(generateFindingId(f));
  });
});

// ---------------------------------------------------------------------------
// SQLite persistence / durability
// ---------------------------------------------------------------------------

describe("SQLite persistence", () => {
  it("a separate connection sees committed writes (WAL durability)", async () => {
    await addFindings(projectPath, [makeFinding({ check: "x" })], "scan-1", "/repo");
    const { Database } = await import("bun:sqlite");
    const { stateDbPath } = await import("./findings-db.js");
    const db = new Database(stateDbPath(projectPath));
    const count = db.query("SELECT COUNT(*) AS c FROM findings").get().c;
    db.close();
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stale finding pruning
// ---------------------------------------------------------------------------

describe("stale finding pruning", () => {
  it("VALID_STATUSES includes 'stale'", () => {
    expect(VALID_STATUSES).toContain("stale");
  });

  it("marks open findings not in new scan as stale", async () => {
    const f1 = { ...makeFinding(), id: "f-stale-test001", check: "check-a" };
    const f2 = { ...makeFinding(), id: "f-stale-test002", check: "check-b" };
    await addFindings(projectPath, [f1, f2], "scan-1", "/repo");
    await addFindings(projectPath, [f1], "scan-2", "/repo");

    const state = await loadFindings(projectPath);
    expect(state.findings.find((f) => f.id === "f-stale-test002").status).toBe("stale");
    expect(state.findings.find((f) => f.id === "f-stale-test001").status).toBe("open");
  });

  it("revives a stale finding to open when it reappears in a later scan", async () => {
    const f1 = { ...makeFinding(), id: "f-revive-001", check: "check-a" };
    const f2 = { ...makeFinding(), id: "f-revive-002", check: "check-b" };
    await addFindings(projectPath, [f1, f2], "scan-1", "/repo");
    await addFindings(projectPath, [f1], "scan-2", "/repo"); // f2 disappears -> stale
    expect((await getFindings(projectPath, { status: "stale" })).map((f) => f.id)).toEqual([
      "f-revive-002",
    ]);
    await addFindings(projectPath, [f1, f2], "scan-3", "/repo"); // f2 reappears -> open

    const open = await getFindings(projectPath);
    expect(open.map((f) => f.id).sort()).toEqual(["f-revive-001", "f-revive-002"]);
    expect(await getFindings(projectPath, { status: "stale" })).toHaveLength(0);
  });

  it("does NOT revive a user-set status when a finding reappears", async () => {
    const f1 = { ...makeFinding(), id: "f-revive-keep", check: "check-a" };
    await addFindings(projectPath, [f1], "scan-1", "/repo");
    await updateFinding(projectPath, "f-revive-keep", { status: "fixed" });
    await addFindings(projectPath, [f1], "scan-2", "/repo"); // reappears, but user said fixed
    expect((await getFindings(projectPath, { status: "fixed" })).map((f) => f.id)).toEqual([
      "f-revive-keep",
    ]);
  });

  it("does not mark non-open findings as stale", async () => {
    const f1 = { ...makeFinding(), id: "f-stale-test003", check: "check-a" };
    const f2 = { ...makeFinding(), id: "f-stale-test004", check: "check-b" };
    await addFindings(projectPath, [f1, f2], "scan-1", "/repo");
    await updateFinding(projectPath, "f-stale-test004", { status: "ignored" });
    await addFindings(projectPath, [f1], "scan-2", "/repo");

    const state = await loadFindings(projectPath);
    expect(state.findings.find((f) => f.id === "f-stale-test004").status).toBe("ignored");
  });

  it("stale findings are excluded from getFindings by default", async () => {
    const f1 = { ...makeFinding(), id: "f-stale-test005", check: "check-a" };
    const f2 = { ...makeFinding(), id: "f-stale-test006", check: "check-b" };
    await addFindings(projectPath, [f1, f2], "scan-1", "/repo");
    await addFindings(projectPath, [f1], "scan-2", "/repo");

    const results = await getFindings(projectPath);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("f-stale-test005");
  });

  it("stale findings can be retrieved when explicitly filtering for stale status", async () => {
    const f1 = { ...makeFinding(), id: "f-stale-test007", check: "check-a" };
    const f2 = { ...makeFinding(), id: "f-stale-test008", check: "check-b" };
    await addFindings(projectPath, [f1, f2], "scan-1", "/repo");
    await addFindings(projectPath, [f1], "scan-2", "/repo");

    const staleResults = await getFindings(projectPath, { status: "stale" });
    expect(staleResults).toHaveLength(1);
    expect(staleResults[0].id).toBe("f-stale-test008");
  });

  it("stale findings are excluded from getSummary counts", async () => {
    const f1 = { ...makeFinding(), id: "f-stale-test009", check: "check-a", severity: "high" };
    const f2 = { ...makeFinding(), id: "f-stale-test010", check: "check-b", severity: "low" };
    await addFindings(projectPath, [f1, f2], "scan-1", "/repo");
    await addFindings(projectPath, [f1], "scan-2", "/repo");

    const summary = await loadFindings(projectPath).then((_s) =>
      import("./findings.js").then(({ getSummary }) => getSummary(projectPath)),
    );
    expect(summary.totalFindings).toBe(1);
    expect(summary.bySeverity.high).toBe(1);
    expect(summary.bySeverity.low).toBeUndefined();
  });

  it("computeSummary excludes stale findings", () => {
    const findings = [
      { ...makeFinding(), status: "open", severity: "high" },
      { ...makeFinding(), status: "stale", severity: "low" },
      { ...makeFinding(), status: "fixed", severity: "medium" },
    ];
    const summary = computeSummary(findings);
    expect(summary.totalFindings).toBe(2);
    expect(summary.bySeverity.high).toBe(1);
    expect(summary.bySeverity.medium).toBe(1);
    expect(summary.bySeverity.low).toBeUndefined();
    expect(summary.byStatus.stale).toBeUndefined();
  });
});
