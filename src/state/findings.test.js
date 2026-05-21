import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFindings,
  clearFindings,
  computeSummary,
  generateFindingId,
  getFinding,
  getFindings,
  getSummary,
  loadFindings,
  saveFindings,
  updateFinding,
  VALID_STATUSES,
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

  it("starts with 'f-' and has 18 chars total", () => {
    const id = generateFindingId(makeFinding());
    expect(id).toMatch(/^f-[0-9a-f]{16}$/);
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

  it("does not leave a tmp file behind after a successful write", async () => {
    const { readdir } = await import("node:fs/promises");
    await saveFindings(projectPath, {
      scanId: "s1",
      path: "/repo",
      findings: [],
      summary: { totalFindings: 0 },
    });
    const stateDirContents = await readdir(join(projectPath, ".lazy-refactor"));
    expect(stateDirContents).toContain("findings.json");
    // No half-written .tmp.* files should remain
    expect(stateDirContents.filter((n) => n.includes(".tmp."))).toHaveLength(0);
  });
});

describe("stale lock recovery", () => {
  it("acquires lock after the previous holder process is gone (stale)", async () => {
    // Manually plant a lock file referencing a PID that almost certainly is not running.
    const { writeFile, readFile, mkdir } = await import("node:fs/promises");
    const stateDir = join(projectPath, ".lazy-refactor");
    await mkdir(stateDir, { recursive: true });
    // PID 1 will exist on Unix, so use a very high unlikely PID instead.
    const stalePid = 2_147_483_640;
    await writeFile(join(stateDir, "findings.lock"), String(stalePid), "utf8");

    // addFindings should successfully acquire the lock by detecting the stale holder
    await addFindings(
      projectPath,
      [makeFinding({ check: "stale-recovery" })],
      "scan-stale",
      "/repo",
    );

    const state = await loadFindings(projectPath);
    expect(state.findings).toHaveLength(1);

    // Lock file should be cleaned up after releaseLock
    let lockStillThere = true;
    try {
      await readFile(join(stateDir, "findings.lock"), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") lockStillThere = false;
    }
    expect(lockStillThere).toBe(false);
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

  it("deduplicates findings by ID across scans", async () => {
    const f = makeFinding({ check: "a" });
    await addFindings(projectPath, [f], "scan-1", "/repo");
    await addFindings(projectPath, [f], "scan-2", "/repo");

    const state = await loadFindings(projectPath);
    expect(state.findings).toHaveLength(1);
  });

  it("merges new findings with different IDs", async () => {
    await addFindings(projectPath, [makeFinding({ check: "a" })], "scan-1", "/repo");
    await addFindings(projectPath, [makeFinding({ check: "b" })], "scan-2", "/repo");

    const state = await loadFindings(projectPath);
    expect(state.findings).toHaveLength(2);
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

    const state = await loadFindings(projectPath);
    expect(state.findings[0].id).toMatch(/^f-[0-9a-f]{16}$/);
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

// ---------------------------------------------------------------------------
// clearFindings
// ---------------------------------------------------------------------------

describe("clearFindings", () => {
  it("clears all findings and resets state", async () => {
    // Add some findings first
    await addFindings(
      projectPath,
      [makeFinding({ check: "a" }), makeFinding({ check: "b", severity: "high" })],
      "scan-1",
      "/repo",
    );

    // Verify findings exist
    let state = await loadFindings(projectPath);
    expect(state.findings).toHaveLength(2);

    // Clear
    await clearFindings(projectPath);

    // Verify everything is reset
    state = await loadFindings(projectPath);
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

    // Should be able to add findings again without lock contention
    await addFindings(projectPath, [makeFinding({ check: "after-clear" })], "scan-2", "/repo");
    const state = await loadFindings(projectPath);
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0].check).toBe("after-clear");
  });

  it("works correctly even when no findings existed", async () => {
    // Clear on empty state should not error
    await clearFindings(projectPath);
    const state = await loadFindings(projectPath);
    expect(state.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fix 1: Stale finding pruning
// ---------------------------------------------------------------------------

describe("stale finding pruning", () => {
  it("VALID_STATUSES includes 'stale'", () => {
    expect(VALID_STATUSES).toContain("stale");
  });

  it("marks open findings not in new scan as stale", async () => {
    const f1 = { ...makeFinding(), id: "f-stale-test001", check: "check-a" };
    const f2 = { ...makeFinding(), id: "f-stale-test002", check: "check-b" };
    await addFindings(projectPath, [f1, f2], "scan-1", "/repo");

    // Second scan only produces f1 — f2 should become stale
    await addFindings(projectPath, [f1], "scan-2", "/repo");

    const state = await loadFindings(projectPath);
    const staleF = state.findings.find((f) => f.id === "f-stale-test002");
    expect(staleF).toBeDefined();
    expect(staleF.status).toBe("stale");

    const activeF = state.findings.find((f) => f.id === "f-stale-test001");
    expect(activeF.status).toBe("open");
  });

  it("does not mark non-open findings as stale", async () => {
    const f1 = { ...makeFinding(), id: "f-stale-test003", check: "check-a" };
    const f2 = { ...makeFinding(), id: "f-stale-test004", check: "check-b" };
    await addFindings(projectPath, [f1, f2], "scan-1", "/repo");

    // User marks f2 as ignored
    await updateFinding(projectPath, "f-stale-test004", { status: "ignored" });

    // Second scan only produces f1 — f2 should stay ignored (not become stale)
    await addFindings(projectPath, [f1], "scan-2", "/repo");

    const state = await loadFindings(projectPath);
    const f2State = state.findings.find((f) => f.id === "f-stale-test004");
    expect(f2State.status).toBe("ignored");
  });

  it("stale findings are excluded from getFindings by default", async () => {
    const f1 = { ...makeFinding(), id: "f-stale-test005", check: "check-a" };
    const f2 = { ...makeFinding(), id: "f-stale-test006", check: "check-b" };
    await addFindings(projectPath, [f1, f2], "scan-1", "/repo");

    // Second scan only produces f1
    await addFindings(projectPath, [f1], "scan-2", "/repo");

    const results = await getFindings(projectPath);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("f-stale-test005");
  });

  it("stale findings can be retrieved when explicitly filtering for stale status", async () => {
    const f1 = { ...makeFinding(), id: "f-stale-test007", check: "check-a" };
    const f2 = { ...makeFinding(), id: "f-stale-test008", check: "check-b" };
    await addFindings(projectPath, [f1, f2], "scan-1", "/repo");

    // Second scan only produces f1
    await addFindings(projectPath, [f1], "scan-2", "/repo");

    const staleResults = await getFindings(projectPath, { status: "stale" });
    expect(staleResults).toHaveLength(1);
    expect(staleResults[0].id).toBe("f-stale-test008");
  });

  it("stale findings are excluded from getSummary counts", async () => {
    const f1 = { ...makeFinding(), id: "f-stale-test009", check: "check-a", severity: "high" };
    const f2 = { ...makeFinding(), id: "f-stale-test010", check: "check-b", severity: "low" };
    await addFindings(projectPath, [f1, f2], "scan-1", "/repo");

    // Second scan only produces f1 — f2 becomes stale
    await addFindings(projectPath, [f1], "scan-2", "/repo");

    const summary = await getSummary(projectPath);
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
