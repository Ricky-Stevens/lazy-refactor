import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFindings } from "../state/findings.js";
import { closeAllConnections } from "../state/findings-store.js";
import { createRun, getActiveRunId } from "../state/runs.js";
import { registerRunTools } from "./tools-runs.js";

let dir;
let tools;
const payload = (res) => JSON.parse(res.content[0].text);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lazy-toolsruns-"));
  tools = {};
  registerRunTools({ registerTool: (name, _def, handler) => (tools[name] = handler) }, dir);
});
afterEach(async () => {
  closeAllConnections();
  await rm(dir, { recursive: true, force: true });
});

describe("list_runs tool", () => {
  it("lists runs with status, active marker, and a findings summary", async () => {
    createRun(dir, { label: "A" });
    await addFindings(
      dir,
      [
        {
          check: "c",
          severity: "low",
          category: "m",
          description: "d",
          locations: [{ file: "x.js", startLine: 1 }],
        },
      ],
      "s1",
      "/repo",
    );
    const { runs } = payload(await tools.list_runs({}));
    expect(runs).toHaveLength(1);
    expect(runs[0].active).toBe(true);
    expect(runs[0].status).toBe("in-progress");
    expect(runs[0].summary.totalFindings).toBe(1);
  });
});

describe("get_active_run tool", () => {
  it("returns null run on a never-scanned project (no phantom run created)", async () => {
    const { run } = payload(await tools.get_active_run({}));
    expect(run).toBeNull();
    // Confirm the read did not mint a run.
    expect(getActiveRunId(dir)).toBeNull();
  });

  it("returns the active run identity and its findings summary", async () => {
    createRun(dir, { label: "A" });
    await addFindings(
      dir,
      [
        {
          check: "c",
          severity: "high",
          category: "m",
          description: "d",
          locations: [{ file: "x.js", startLine: 1 }],
        },
      ],
      "s1",
      "/repo",
    );
    const { run, summary } = payload(await tools.get_active_run({}));
    expect(run.id).toBe(getActiveRunId(dir));
    expect(run.path).toBe("/repo");
    expect(run.scanId).toBe("s1");
    expect(summary.totalFindings).toBe(1);
  });
});

describe("set_run_status tool", () => {
  it("defaults to the active run and updates status", async () => {
    createRun(dir, {});
    const res = await tools.set_run_status({ status: "complete" });
    expect(payload(res).status).toBe("complete");
    const { runs } = payload(await tools.list_runs({}));
    expect(runs.find((r) => r.id === getActiveRunId(dir)).status).toBe("complete");
  });

  it("errors on an unknown run id", async () => {
    const res = await tools.set_run_status({ id: "r-nope", status: "complete" });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toContain("not found");
  });
});
