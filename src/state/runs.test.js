import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFindings,
  getFindings,
  getFindingsByIds,
  getSummary,
  updateFinding,
} from "./findings.js";
import { closeAllConnections } from "./findings-store.js";
import {
  createRun,
  deleteRun,
  getActiveRunId,
  listRuns,
  setActiveRun,
  setRunStatus,
} from "./runs.js";

const mk = (o = {}) => ({
  check: "c",
  severity: "low",
  category: "metrics",
  status: "open",
  description: "d",
  locations: [{ file: "x.js", startLine: 1 }],
  ...o,
});

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lazy-runs-"));
});
afterEach(async () => {
  closeAllConnections();
  await rm(dir, { recursive: true, force: true });
});

describe("run lifecycle", () => {
  it("auto-creates a default active run on first findings access", async () => {
    await addFindings(dir, [mk({ id: "f-1" })], "s1", "/repo");
    const runs = listRuns(dir);
    expect(runs).toHaveLength(1);
    expect(runs[0].active).toBe(true);
    expect(getActiveRunId(dir)).toBe(runs[0].id);
  });

  it("run_scan-style new runs coexist without purging older ones", async () => {
    createRun(dir, { label: "A" });
    await addFindings(dir, [mk({ id: "f-a" })], "s1", "/repo");
    await updateFinding(dir, "f-a", { status: "fixed" });

    const b = createRun(dir, { label: "B" });
    await addFindings(dir, [mk({ id: "f-b" })], "s2", "/repo");

    // Active run is B — only B's finding is visible.
    expect((await getFindings(dir, {})).map((f) => f.id)).toEqual(["f-b"]);
    expect(getActiveRunId(dir)).toBe(b.id);
    // Both runs still exist.
    expect(listRuns(dir)).toHaveLength(2);
  });

  it("resuming a run restores its findings with triage edits intact", async () => {
    const a = createRun(dir, { label: "A" });
    await addFindings(dir, [mk({ id: "f-a" })], "s1", "/repo");
    await updateFinding(dir, "f-a", { status: "fixed", notes: "done" });

    createRun(dir, { label: "B" }); // switch active away
    await addFindings(dir, [mk({ id: "f-b" })], "s2", "/repo");

    setActiveRun(dir, a.id); // resume A
    const found = (await getFindingsByIds(dir, ["f-a"])).findings[0];
    expect(found.status).toBe("fixed");
    expect(found.notes).toBe("done");
    expect((await getFindings(dir, {})).map((f) => f.id)).toEqual(["f-a"]);
  });

  it("persists the active run across a lost session (registry survives close)", async () => {
    const a = createRun(dir, {});
    createRun(dir, {}); // active is now the second run
    setActiveRun(dir, a.id);

    closeAllConnections(); // simulate the session ending

    // A fresh read re-opens the registry from disk and recovers the active run.
    expect(getActiveRunId(dir)).toBe(a.id);
  });

  it("lists runs most-recently-touched first, marking the active one", async () => {
    const a = createRun(dir, { label: "A" });
    const b = createRun(dir, { label: "B" });
    // Touch A last by re-activating + scanning into it.
    setActiveRun(dir, a.id);
    await addFindings(dir, [mk({ id: "f-a" })], "s", "/repo");

    const runs = listRuns(dir);
    expect(runs[0].id).toBe(a.id); // most recently touched first
    expect(runs.find((r) => r.id === a.id).active).toBe(true);
    expect(runs.find((r) => r.id === b.id).active).toBe(false);
  });

  it("setActiveRun rejects an unknown id", () => {
    expect(() => setActiveRun(dir, "r-nope")).toThrow("not found");
  });

  it("setRunStatus updates a valid status and rejects an invalid one", () => {
    const a = createRun(dir, {});
    expect(setRunStatus(dir, a.id, "complete")).toEqual({ id: a.id, status: "complete" });
    expect(listRuns(dir).find((r) => r.id === a.id).status).toBe("complete");
    expect(() => setRunStatus(dir, a.id, "bogus")).toThrow("Invalid run status");
  });

  it("a pure read does NOT create a run (no phantom runs)", async () => {
    // get_summary / get_findings on a never-scanned project must not mutate state.
    const summary = await getSummary(dir);
    expect(summary.totalFindings).toBe(0);
    expect(await getFindings(dir, {})).toEqual([]);
    expect(getActiveRunId(dir)).toBeNull();
    expect(listRuns(dir)).toHaveLength(0);
  });

  it("ordering is deterministic when touches share a millisecond", async () => {
    // No awaits between these — without the monotonic touch_seq, equal ISO
    // timestamps would tie and the order would be undefined.
    const a = createRun(dir, { label: "A" });
    const b = createRun(dir, { label: "B" });
    const c = createRun(dir, { label: "C" });
    setActiveRun(dir, b.id);
    await addFindings(dir, [mk({ id: "f-b" })], "s", "/repo"); // touch B last
    const ids = listRuns(dir).map((r) => r.id);
    expect(ids[0]).toBe(b.id); // most recently touched
    expect(ids).toEqual([b.id, c.id, a.id]); // then by creation/touch order
  });

  it("hides archived runs by default, shows them with includeArchived", () => {
    const a = createRun(dir, { label: "A" });
    const b = createRun(dir, { label: "B" }); // b is active
    setRunStatus(dir, a.id, "archived");
    expect(listRuns(dir).map((r) => r.id)).not.toContain(a.id);
    expect(listRuns(dir, { includeArchived: true }).map((r) => r.id)).toContain(a.id);
    expect(b.id).toBeDefined();
  });

  it("always surfaces the active run even when it is archived", () => {
    const a = createRun(dir, { label: "A" });
    setRunStatus(dir, a.id, "archived");
    setActiveRun(dir, a.id); // activating an archived run must not make it invisible
    const listed = listRuns(dir);
    expect(listed.map((r) => r.id)).toContain(a.id);
    expect(listed.find((r) => r.id === a.id).active).toBe(true);
  });

  it("deleteRun removes the run and its findings, repointing the active pointer", async () => {
    const a = createRun(dir, { label: "A" });
    await addFindings(dir, [mk({ id: "f-a" })], "s1", "/repo");
    const b = createRun(dir, { label: "B" });
    await addFindings(dir, [mk({ id: "f-b" })], "s2", "/repo"); // active is B

    const res = deleteRun(dir, b.id);
    expect(res.deletedFindings).toBe(1);
    expect(res.newActiveRunId).toBe(a.id); // repointed to the remaining run
    expect(getActiveRunId(dir)).toBe(a.id);
    expect(listRuns(dir).map((r) => r.id)).toEqual([a.id]);
    // B's findings are gone; A's are intact and now visible (A is active).
    expect((await getFindingsByIds(dir, ["f-b"])).notFound).toEqual(["f-b"]);
    expect((await getFindings(dir, {})).map((f) => f.id)).toEqual(["f-a"]);
  });

  it("deleteRun returns null for an unknown id and clears the pointer when last run goes", async () => {
    expect(deleteRun(dir, "r-nope")).toBeNull();
    const a = createRun(dir, {});
    await addFindings(dir, [mk({ id: "f-a" })], "s1", "/repo");
    const res = deleteRun(dir, a.id);
    expect(res.deletedFindings).toBe(1);
    expect(res.newActiveRunId).toBeNull();
    expect(getActiveRunId(dir)).toBeNull();
    expect(listRuns(dir)).toHaveLength(0);
  });
});
