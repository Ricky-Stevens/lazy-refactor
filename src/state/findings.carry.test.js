import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFindings, carryForwardDismissals, getFindings, updateFinding } from "./findings.js";
import { createRun, setActiveRun } from "./runs.js";

function makeFinding(overrides = {}) {
  return {
    check: "any-type-ts",
    severity: "low",
    confidence: 0.9,
    category: "type-safety",
    language: "typescript",
    description: "Uses any",
    locations: [{ file: "src/a.ts", startLine: 10 }],
    suggestion: "Type it",
    fixable: true,
    ...overrides,
  };
}

let projectPath;

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), "lazy-findings-carry-"));
});

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe("carryForwardDismissals", () => {
  it("carries false-positive/ignored from a prior run onto matching ids in the active run", async () => {
    // Run A: scan two findings, dismiss them.
    const runA = createRun(projectPath, {});
    setActiveRun(projectPath, runA.id);
    const keepFp = makeFinding({ check: "fp-check", description: "fp finding" });
    const keepIgnored = makeFinding({ check: "ig-check", description: "ignored finding" });
    await addFindings(projectPath, [keepFp, keepIgnored], "scan-a", "/repo");
    const aFindings = await getFindings(projectPath, {});
    const fpId = aFindings.find((f) => f.check === "fp-check").id;
    const igId = aFindings.find((f) => f.check === "ig-check").id;
    await updateFinding(projectPath, fpId, { status: "false-positive" });
    await updateFinding(projectPath, igId, { status: "ignored" });

    // Run B: a fresh scan reproduces the same findings (same stable ids → all open).
    const runB = createRun(projectPath, {});
    setActiveRun(projectPath, runB.id);
    await addFindings(projectPath, [keepFp, keepIgnored], "scan-b", "/repo");
    expect((await getFindings(projectPath, { status: "open" })).length).toBe(2);

    const carried = await carryForwardDismissals(projectPath, runA.id);
    expect(carried).toEqual({
      applied: 2,
      byStatus: { "false-positive": 1, ignored: 1 },
      fromRunId: runA.id,
    });
    expect((await getFindings(projectPath, { status: "false-positive" }))[0].id).toBe(fpId);
    expect((await getFindings(projectPath, { status: "ignored" }))[0].id).toBe(igId);
  });

  it("returns null when there is no prior run or nothing was dismissed", async () => {
    const runB = createRun(projectPath, {});
    setActiveRun(projectPath, runB.id);
    await addFindings(projectPath, [makeFinding()], "scan-b", "/repo");
    expect(await carryForwardDismissals(projectPath, null)).toBeNull();
    // A prior run with no dismissals carries nothing.
    const runA = createRun(projectPath, {});
    expect(await carryForwardDismissals(projectPath, runA.id)).toBeNull();
  });

  it("does not carry a 'fixed' status (run-specific; a reappearance is a regression signal)", async () => {
    const runA = createRun(projectPath, {});
    setActiveRun(projectPath, runA.id);
    const f = makeFinding({ check: "fixed-check" });
    await addFindings(projectPath, [f], "scan-a", "/repo");
    const id = (await getFindings(projectPath, {}))[0].id;
    await updateFinding(projectPath, id, { status: "fixed" });

    const runB = createRun(projectPath, {});
    setActiveRun(projectPath, runB.id);
    await addFindings(projectPath, [f], "scan-b", "/repo");
    expect(await carryForwardDismissals(projectPath, runA.id)).toBeNull();
    expect((await getFindings(projectPath, { status: "open" }))[0].id).toBe(id);
  });
});
