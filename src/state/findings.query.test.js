import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFindings,
  clearFindings,
  countFindings,
  getFindings,
  getFindingsByIds,
  getFindingsPage,
  getSummary,
  groupFindings,
  loadFindings,
  updateFindings,
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
// fixable filter (blob-extracted, SQL-native)
// ---------------------------------------------------------------------------

describe("fixable filter", () => {
  beforeEach(async () => {
    await addFindings(
      projectPath,
      [
        { ...makeFinding(), id: "f-fix-1", severity: "high", fixable: true },
        { ...makeFinding(), id: "f-fix-2", severity: "low", fixable: true },
        { ...makeFinding(), id: "f-manual", severity: "critical", fixable: false },
        // No fixable key at all — must default to fixable (matches mapper default).
        { ...makeFinding(), id: "f-default", severity: "medium", fixable: undefined },
      ],
      "scan-1",
      "/repo",
    );
  });

  it("fixable:true selects fixable findings and treats a missing flag as fixable", async () => {
    const ids = (await getFindings(projectPath, { fixable: true })).map((f) => f.id).sort();
    expect(ids).toEqual(["f-default", "f-fix-1", "f-fix-2"]);
  });

  it("fixable:false selects only explicitly non-fixable findings", async () => {
    const results = await getFindings(projectPath, { fixable: false });
    expect(results.map((f) => f.id)).toEqual(["f-manual"]);
  });

  it("combines fixable with a scalar filter", async () => {
    const results = await getFindings(projectPath, { fixable: true, severity: "high" });
    expect(results.map((f) => f.id)).toEqual(["f-fix-1"]);
  });

  it("countFindings honors the fixable filter without materialising", async () => {
    expect(await countFindings(projectPath, { fixable: true })).toBe(3);
    expect(await countFindings(projectPath, { fixable: false })).toBe(1);
  });

  it("update_findings filter mode is scoped by fixable in a single set-based update", async () => {
    const { updated } = await updateFindings(projectPath, {
      filter: { fixable: false },
      status: "ignored",
    });
    expect(updated).toBe(1);
    expect((await getFindings(projectPath, { status: "ignored" })).map((f) => f.id)).toEqual([
      "f-manual",
    ]);
    // Fixable findings are untouched.
    expect(await countFindings(projectPath, { fixable: true, status: "open" })).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// file filter — indexed candidate path preserves multi-location semantics
// ---------------------------------------------------------------------------

describe("file filter (multi-location)", () => {
  beforeEach(async () => {
    await addFindings(
      projectPath,
      [
        // Single-location finding in a.js (matched via the primary-file index).
        { ...makeFinding(), id: "f-single", locations: [{ file: "a.js", startLine: 1 }] },
        // Duplicate cluster whose PRIMARY file is a.js but ALSO spans b.js — the case the
        // primary-file column alone would drop. Must still match a `file: "b.js"` filter.
        {
          ...makeFinding(),
          id: "f-cluster",
          check: "duplicate-cluster",
          locations: [
            { file: "a.js", startLine: 5 },
            { file: "b.js", startLine: 9 },
          ],
        },
        { ...makeFinding(), id: "f-other", locations: [{ file: "c.js", startLine: 1 }] },
      ],
      "scan-1",
      "/repo",
    );
  });

  it("matches a cluster on a NON-primary location file (not dropped)", async () => {
    const ids = (await getFindings(projectPath, { file: "b.js" })).map((f) => f.id).sort();
    expect(ids).toEqual(["f-cluster"]);
  });

  it("matches by primary file, returning both the single finding and the cluster", async () => {
    const ids = (await getFindings(projectPath, { file: "a.js" })).map((f) => f.id).sort();
    expect(ids).toEqual(["f-cluster", "f-single"]);
  });

  it("countFindings agrees with the materialised file-filter result", async () => {
    expect(await countFindings(projectPath, { file: "b.js" })).toBe(1);
    expect(await countFindings(projectPath, { file: "a.js" })).toBe(2);
    expect(await countFindings(projectPath, { file: "nope.js" })).toBe(0);
  });

  it("combines file with a scalar (status) filter", async () => {
    await updateFindings(projectPath, { ids: ["f-cluster"], status: "fixed" });
    // status:"open" excludes the now-fixed cluster, leaving no open finding in b.js.
    expect((await getFindings(projectPath, { file: "b.js", status: "open" })).length).toBe(0);
    // status:"fixed" finds it again — the scalar filter is applied alongside the file match.
    expect(
      (await getFindings(projectPath, { file: "b.js", status: "fixed" })).map((f) => f.id),
    ).toEqual(["f-cluster"]);
  });
});

// ---------------------------------------------------------------------------
// orderBy (severity CASE rank / confidence / rowid default)
// ---------------------------------------------------------------------------

describe("orderBy", () => {
  beforeEach(async () => {
    await addFindings(
      projectPath,
      [
        {
          ...makeFinding(),
          id: "f-low",
          severity: "low",
          confidence: 0.9,
          locations: [{ file: "a.js" }],
        },
        {
          ...makeFinding(),
          id: "f-crit",
          severity: "critical",
          confidence: 0.3,
          locations: [{ file: "a.js" }],
        },
        {
          ...makeFinding(),
          id: "f-med",
          severity: "medium",
          confidence: 0.6,
          locations: [{ file: "a.js" }],
        },
      ],
      "scan-1",
      "/repo",
    );
  });

  it("orderBy severity returns most-severe first (SQL path)", async () => {
    const { findings } = await getFindingsPage(projectPath, {}, { orderBy: "severity" });
    expect(findings.map((f) => f.id)).toEqual(["f-crit", "f-med", "f-low"]);
  });

  it("orderBy confidence returns highest-confidence first (SQL path)", async () => {
    const { findings } = await getFindingsPage(projectPath, {}, { orderBy: "confidence" });
    expect(findings.map((f) => f.id)).toEqual(["f-low", "f-med", "f-crit"]);
  });

  it("orderBy severity applies on the JS file-filter path too", async () => {
    const { findings } = await getFindingsPage(
      projectPath,
      { file: "a.js" },
      { orderBy: "severity" },
    );
    expect(findings.map((f) => f.id)).toEqual(["f-crit", "f-med", "f-low"]);
  });

  it("defaults to insertion order when orderBy is omitted", async () => {
    const { findings } = await getFindingsPage(projectPath, {}, {});
    expect(findings.map((f) => f.id)).toEqual(["f-low", "f-crit", "f-med"]);
  });
});

// ---------------------------------------------------------------------------
// minConfidence filter (blob-extracted, SQL-native + JS file path)
// ---------------------------------------------------------------------------

describe("minConfidence filter", () => {
  beforeEach(async () => {
    await addFindings(
      projectPath,
      [
        { ...makeFinding(), id: "f-hi", confidence: 0.95, locations: [{ file: "a.js" }] },
        { ...makeFinding(), id: "f-mid", confidence: 0.6, locations: [{ file: "a.js" }] },
        { ...makeFinding(), id: "f-lo", confidence: 0.2, locations: [{ file: "a.js" }] },
        // No confidence key — must default to 1 (matches prioritizer.js / SQL IFNULL).
        { ...makeFinding(), id: "f-none", confidence: undefined, locations: [{ file: "a.js" }] },
      ],
      "scan-1",
      "/repo",
    );
  });

  it("selects findings at or above the threshold, treating missing confidence as 1", async () => {
    const ids = (await getFindings(projectPath, { minConfidence: 0.7 })).map((f) => f.id).sort();
    expect(ids).toEqual(["f-hi", "f-none"]);
  });

  it("countFindings honors minConfidence without materialising", async () => {
    expect(await countFindings(projectPath, { minConfidence: 0.5 })).toBe(3);
    expect(await countFindings(projectPath, { minConfidence: 0.99 })).toBe(1);
  });

  it("enforces minConfidence on the JS file-filter path too (matchesFilter)", async () => {
    const ids = (await getFindings(projectPath, { minConfidence: 0.7, file: "a.js" }))
      .map((f) => f.id)
      .sort();
    expect(ids).toEqual(["f-hi", "f-none"]);
  });
});

// ---------------------------------------------------------------------------
// groupFindings
// ---------------------------------------------------------------------------

describe("groupFindings", () => {
  beforeEach(async () => {
    await addFindings(
      projectPath,
      [
        {
          ...makeFinding(),
          id: "f-a1",
          category: "dead-code",
          locations: [{ file: "src/a.js", startLine: 1, endLine: 1 }],
        },
        {
          ...makeFinding(),
          id: "f-a2",
          category: "metrics",
          locations: [{ file: "src/a.js", startLine: 9, endLine: 9 }],
        },
        {
          ...makeFinding(),
          id: "f-b1",
          category: "dead-code",
          locations: [{ file: "src/b.js", startLine: 3, endLine: 3 }],
        },
        // No locations — groups under the null key, not dropped.
        { ...makeFinding(), id: "f-none", category: "metrics", locations: [] },
      ],
      "scan-1",
      "/repo",
    );
  });

  it("groups by file (default), returning ids per file without bodies", async () => {
    const { by, groups, totalGroups, totalFindings } = await groupFindings(projectPath);
    expect(by).toBe("file");
    expect(totalFindings).toBe(4);
    expect(totalGroups).toBe(3);
    // Sorted by count desc — src/a.js (2) leads.
    expect(groups[0]).toEqual({ key: "src/a.js", count: 2, ids: ["f-a1", "f-a2"] });
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(byKey["src/b.js"].ids).toEqual(["f-b1"]);
    expect(byKey.null.ids).toEqual(["f-none"]);
    // No finding bodies leak into the grouping payload.
    expect(groups[0]).not.toHaveProperty("description");
  });

  it("honors the filter when grouping", async () => {
    const { groups, totalFindings } = await groupFindings(projectPath, { category: "dead-code" });
    expect(totalFindings).toBe(2);
    expect(groups.map((g) => g.key).sort()).toEqual(["src/a.js", "src/b.js"]);
  });

  it("groups by an indexed column via SQL", async () => {
    const { groups, totalFindings } = await groupFindings(projectPath, {}, "category");
    expect(totalFindings).toBe(4);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(byKey["dead-code"].ids.sort()).toEqual(["f-a1", "f-b1"]);
    expect(byKey.metrics.ids.sort()).toEqual(["f-a2", "f-none"]);
  });
});

// ---------------------------------------------------------------------------
// addFindings — path normalization (one physical file => one group)
// ---------------------------------------------------------------------------

describe("addFindings — path normalization", () => {
  it("collapses absolute and relative paths for the same file into one group", async () => {
    await addFindings(
      projectPath,
      [
        // Same physical file, emitted absolute (collectFiles-based scanners)...
        {
          ...makeFinding(),
          check: "dead-code",
          locations: [{ file: "/repo/src/x.ts", startLine: 1 }],
        },
        // ...and relative (grep-based pattern scanner).
        {
          ...makeFinding(),
          check: "eval-usage-ts",
          locations: [{ file: "src/x.ts", startLine: 2 }],
        },
      ],
      "scan-1",
      "/repo",
    );

    const { groups, totalGroups } = await groupFindings(projectPath);
    expect(totalGroups).toBe(1);
    expect(groups[0].key).toBe("src/x.ts");
    expect(groups[0].count).toBe(2);
  });

  it("normalizes the secondary file (fileB) of a duplicate pair", async () => {
    await addFindings(
      projectPath,
      [
        {
          ...makeFinding(),
          check: "duplicate",
          locations: [{ file: "/repo/src/a.ts", startLine: 1 }],
          fileB: "/repo/src/b.ts",
        },
      ],
      "scan-1",
      "/repo",
    );

    const { groups } = await groupFindings(projectPath);
    const { findings } = await getFindingsByIds(projectPath, [groups[0].ids[0]]);
    expect(findings[0].locations[0].file).toBe("src/a.ts");
    expect(findings[0].fileB).toBe("src/b.ts");
  });
});

// ---------------------------------------------------------------------------
// groupFindings — pagination
// ---------------------------------------------------------------------------

describe("groupFindings pagination", () => {
  beforeEach(async () => {
    // 5 files with descending finding counts (5,4,3,2,1) for a deterministic order.
    const findings = [];
    const counts = { "a.ts": 5, "b.ts": 4, "c.ts": 3, "d.ts": 2, "e.ts": 1 };
    for (const [file, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) {
        findings.push({
          ...makeFinding(),
          check: `chk-${file}-${i}`,
          locations: [{ file: `src/${file}`, startLine: i + 1 }],
        });
      }
    }
    await addFindings(projectPath, findings, "scan-1", "/repo");
  });

  it("returns a bounded page with paging metadata and truncated flag", async () => {
    const page = await groupFindings(projectPath, {}, "file", { limit: 2, offset: 0 });
    expect(page.totalGroups).toBe(5);
    expect(page.totalFindings).toBe(15);
    expect(page.returnedGroups).toBe(2);
    expect(page.truncated).toBe(true);
    // Count-desc order: a.ts (5), b.ts (4).
    expect(page.groups.map((g) => g.key)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("pages deterministically across offsets with no overlap or gaps", async () => {
    const seen = [];
    for (let offset = 0; ; offset += 2) {
      const page = await groupFindings(projectPath, {}, "file", { limit: 2, offset });
      seen.push(...page.groups.map((g) => g.key));
      if (!page.truncated) break;
    }
    expect(seen).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
    expect(new Set(seen).size).toBe(5);
  });

  it("returns all groups (truncated false) when no limit is given", async () => {
    const page = await groupFindings(projectPath, {}, "file");
    expect(page.returnedGroups).toBe(5);
    expect(page.truncated).toBe(false);
    expect(page.limit).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getFindingsByIds
// ---------------------------------------------------------------------------

describe("getFindingsByIds", () => {
  it("returns findings for known ids", async () => {
    const f = { ...makeFinding(), id: "f-00000001" };
    await addFindings(projectPath, [f], "scan-1", "/repo");
    const { findings, notFound } = await getFindingsByIds(projectPath, ["f-00000001"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("f-00000001");
    expect(notFound).toEqual([]);
  });

  it("reports unknown ids in notFound", async () => {
    const { findings, notFound } = await getFindingsByIds(projectPath, ["f-missing"]);
    expect(findings).toEqual([]);
    expect(notFound).toEqual(["f-missing"]);
  });

  it("fetches a batch, partitioning known from unknown", async () => {
    await addFindings(
      projectPath,
      [
        { ...makeFinding(), id: "f-1" },
        { ...makeFinding(), id: "f-2" },
      ],
      "scan-1",
      "/repo",
    );
    const { findings, notFound } = await getFindingsByIds(projectPath, ["f-1", "f-x", "f-2"]);
    expect(findings.map((f) => f.id).sort()).toEqual(["f-1", "f-2"]);
    expect(notFound).toEqual(["f-x"]);
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
