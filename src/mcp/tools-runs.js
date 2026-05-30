/**
 * Run-management tool registrations for the lazy-refactor MCP server.
 *
 * Tools: list_runs, set_active_run, set_run_status, delete_run
 *
 * (run_scan creates a new run and resume_scan re-activates one + re-scans — both
 * live in tools-scan.js since they share the scan pipeline. set_active_run is the
 * lightweight switch that does NOT re-scan.)
 */

import { emptySummary, getDb, summariesByRun } from "../state/findings-store.js";
import { deleteRun, getActiveRunId, listRuns, setActiveRun, setRunStatus } from "../state/runs.js";
import { fail, ok } from "./helpers.js";
import { listRunsSchema, runIdSchema, setRunStatusSchema } from "./tools-schemas.js";

function makeListRunsHandler(projectPath) {
  return async ({ includeArchived } = {}) => {
    try {
      // One grouped pass over all runs' findings (4 queries total, not 4 per run),
      // so listing stays cheap no matter how many runs have accumulated.
      const summaries = summariesByRun(getDb(projectPath));
      const runs = listRuns(projectPath, { includeArchived }).map((r) => ({
        ...r,
        summary: summaries.get(r.id) ?? emptySummary(),
      }));
      return ok({ runs });
    } catch (err) {
      return fail(err);
    }
  };
}

function makeSetActiveRunHandler(projectPath) {
  return async ({ id }) => {
    try {
      // setActiveRun throws on an unknown id before mutating the pointer.
      setActiveRun(projectPath, id);
      return ok({ activeRunId: id });
    } catch (err) {
      return fail(err);
    }
  };
}

function makeSetRunStatusHandler(projectPath) {
  return async ({ id, status }) => {
    try {
      const runId = id ?? getActiveRunId(projectPath);
      if (!runId) return fail(new Error("No run specified and no active run"));
      const result = setRunStatus(projectPath, runId, status);
      if (!result) return fail(new Error(`Run '${runId}' not found`));
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  };
}

function makeDeleteRunHandler(projectPath) {
  return async ({ id }) => {
    try {
      const result = deleteRun(projectPath, id);
      if (!result) return fail(new Error(`Run '${id}' not found`));
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  };
}

/**
 * Register the run-management tools on the given McpServer instance.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {string} projectPath
 */
export function registerRunTools(server, projectPath) {
  server.registerTool(
    "list_runs",
    {
      description:
        "List scan runs (most recent first) with status, scan path, timestamps, the active " +
        "marker, and a findings summary for each. Archived runs are hidden unless " +
        "includeArchived is set. Use to find a run ID to set_active_run or resume_scan.",
      inputSchema: listRunsSchema,
    },
    makeListRunsHandler(projectPath),
  );

  server.registerTool(
    "set_active_run",
    {
      description:
        "Switch the active run WITHOUT re-scanning (unlike resume_scan). All findings/triage " +
        "tools then operate on this run. Use to inspect or report on a prior run cheaply.",
      inputSchema: runIdSchema,
    },
    makeSetActiveRunHandler(projectPath),
  );

  server.registerTool(
    "set_run_status",
    {
      description:
        "Set a run's status (in-progress | complete | archived). Defaults to the active run. " +
        "Archived runs are hidden from list_runs by default.",
      inputSchema: setRunStatusSchema,
    },
    makeSetRunStatusHandler(projectPath),
  );

  server.registerTool(
    "delete_run",
    {
      description:
        "Permanently delete a run and all its findings. If it was the active run, the pointer " +
        "moves to the most recent remaining run. Returns { id, deletedFindings, newActiveRunId }.",
      inputSchema: runIdSchema,
    },
    makeDeleteRunHandler(projectPath),
  );
}
