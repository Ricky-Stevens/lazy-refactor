import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFindings, getFindingsByIds, updateFindings } from "./findings.js";

function makeFinding(overrides = {}) {
  return {
    check: "no-unused-vars",
    severity: "medium",
    category: "maintainability",
    status: "open",
    language: "javascript",
    description: "Unused variable",
    locations: [{ file: "src/index.js", startLine: 10 }],
    fixable: false,
    ...overrides,
  };
}

// Single-finding fetch over the id-list API (the only id-read path).
const oneFinding = async (p, id) => (await getFindingsByIds(p, [id])).findings[0] ?? null;

let projectPath;

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), "lazy-findings-update-"));
});

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

async function seed() {
  const a = { ...makeFinding({ check: "a", severity: "low" }), id: "f-a" };
  const b = { ...makeFinding({ check: "b", severity: "high" }), id: "f-b" };
  await addFindings(projectPath, [a, b], "scan-1", "/repo");
}

describe("updateFindings", () => {
  it("applies per-item updates in a single call", async () => {
    await seed();
    const res = await updateFindings(projectPath, {
      updates: [
        { id: "f-a", status: "fixed" },
        { id: "f-b", status: "ignored", notes: "later" },
      ],
    });
    expect(res.updated).toBe(2);
    expect(res.notFound).toEqual([]);
    expect((await oneFinding(projectPath, "f-a")).status).toBe("fixed");
    const b = await oneFinding(projectPath, "f-b");
    expect(b.status).toBe("ignored");
    expect(b.notes).toBe("later");
  });

  it("applies one status to a list of ids (set-based)", async () => {
    await seed();
    const res = await updateFindings(projectPath, { ids: ["f-a", "f-b"], status: "fixed" });
    expect(res.updated).toBe(2);
    expect((await oneFinding(projectPath, "f-a")).status).toBe("fixed");
    expect((await oneFinding(projectPath, "f-b")).status).toBe("fixed");
  });

  it("applies one status to all findings matching a filter (set-based)", async () => {
    await seed();
    const res = await updateFindings(projectPath, {
      filter: { severity: "low" },
      status: "ignored",
    });
    expect(res.updated).toBe(1);
    expect((await oneFinding(projectPath, "f-a")).status).toBe("ignored");
    expect((await oneFinding(projectPath, "f-b")).status).toBe("open");
  });

  it("reports unknown ids in notFound and still applies the rest (updates mode)", async () => {
    await seed();
    const res = await updateFindings(projectPath, {
      updates: [
        { id: "f-a", status: "fixed" },
        { id: "f-missing", status: "fixed" },
      ],
    });
    expect(res.updated).toBe(1);
    expect(res.notFound).toEqual(["f-missing"]);
  });

  it("ids mode reports notFound while applying the present ids", async () => {
    await seed();
    const res = await updateFindings(projectPath, {
      ids: ["f-a", "f-missing", "f-b"],
      status: "fixed",
    });
    expect(res.updated).toBe(2);
    expect(res.notFound).toEqual(["f-missing"]);
    expect((await oneFinding(projectPath, "f-a")).status).toBe("fixed");
    expect((await oneFinding(projectPath, "f-b")).status).toBe("fixed");
  });

  it("recomputes the summary after the batch", async () => {
    await seed();
    const res = await updateFindings(projectPath, { ids: ["f-a", "f-b"], status: "fixed" });
    expect(res.summary.byStatus.fixed).toBe(2);
    expect(res.summary.byStatus.open ?? 0).toBe(0);
  });

  it("does no work and reports zero when nothing matches", async () => {
    await seed();
    const res = await updateFindings(projectPath, { ids: ["f-missing"], status: "fixed" });
    expect(res.updated).toBe(0);
    expect(res.notFound).toEqual(["f-missing"]);
  });

  it("dedups duplicate ids in updates mode, counting distinct findings (last-write-wins)", async () => {
    await seed();
    const res = await updateFindings(projectPath, {
      updates: [
        { id: "f-a", status: "fixed" },
        { id: "f-a", status: "ignored" },
      ],
    });
    expect(res.updated).toBe(1);
    // Last conflicting patch wins.
    expect((await oneFinding(projectPath, "f-a")).status).toBe("ignored");
  });

  it("dedups repeated unknown ids in updates-mode notFound", async () => {
    await seed();
    const res = await updateFindings(projectPath, {
      updates: [
        { id: "f-missing", status: "fixed" },
        { id: "f-missing", status: "ignored" },
      ],
    });
    expect(res.updated).toBe(0);
    expect(res.notFound).toEqual(["f-missing"]);
  });
});
