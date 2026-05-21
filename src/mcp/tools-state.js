/**
 * State and config tool registrations for the lazy-refactor MCP server.
 *
 * Tools: get_findings, get_finding, update_finding, clear_findings,
 *        get_summary, get_config, update_config
 */

import * as z from "zod";
import {
  clearFindings,
  getFinding,
  getFindings,
  getSummary,
  updateFinding,
} from "../state/findings.js";
import { deepMerge, fail, ok, readConfig, writeConfig } from "./helpers.js";

// ---------------------------------------------------------------------------
// Handler factories — each returns an async handler closed over projectPath
// ---------------------------------------------------------------------------

function makeFindingsHandler(projectPath) {
  return async ({ filter, limit, offset }) => {
    try {
      const filtered = await getFindings(projectPath, filter ?? {});
      const total = filtered.length;
      const effectiveOffset = offset ?? 0;
      const effectiveLimit = limit ?? 200;
      let results = filtered;
      if (effectiveOffset) results = results.slice(effectiveOffset);
      results = results.slice(0, effectiveLimit);
      return ok({
        findings: results,
        total,
        offset: effectiveOffset,
        limit: effectiveLimit,
        truncated: total > effectiveOffset + effectiveLimit,
      });
    } catch (err) {
      return fail(err);
    }
  };
}

function makeFindingHandler(projectPath) {
  return async ({ id }) => {
    try {
      const finding = await getFinding(projectPath, id);
      if (!finding) return fail(new Error(`Finding '${id}' not found`));
      return ok(finding);
    } catch (err) {
      return fail(err);
    }
  };
}

function makeUpdateFindingHandler(projectPath) {
  return async ({ id, status, notes }) => {
    try {
      const updated = await updateFinding(projectPath, id, { status, notes });
      if (!updated) return fail(new Error(`Finding '${id}' not found`));
      return ok(updated);
    } catch (err) {
      return fail(err);
    }
  };
}

function makeClearFindingsHandler(projectPath) {
  return async () => {
    try {
      await clearFindings(projectPath);
      return ok({ cleared: true });
    } catch (err) {
      return fail(err);
    }
  };
}

function makeSummaryHandler(projectPath) {
  return async () => {
    try {
      return ok(await getSummary(projectPath));
    } catch (err) {
      return fail(err);
    }
  };
}

function makeGetConfigHandler(projectPath) {
  return async () => {
    try {
      return ok(await readConfig(projectPath));
    } catch (err) {
      return fail(err);
    }
  };
}

function makeUpdateConfigHandler(projectPath) {
  return async ({ overrides }) => {
    try {
      const current = await readConfig(projectPath);
      const updated = deepMerge(current, overrides);
      await writeConfig(projectPath, updated);
      return ok(updated);
    } catch (err) {
      return fail(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const findingsSchema = z.object({
  filter: z
    .object({
      severity: z.union([z.string(), z.array(z.string())]).optional(),
      category: z.union([z.string(), z.array(z.string())]).optional(),
      status: z.union([z.string(), z.array(z.string())]).optional(),
      language: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .optional(),
  limit: z.number().optional().describe("Maximum findings to return (default 200)"),
  offset: z.number().optional().describe("Skip this many findings (for pagination)"),
});

const idSchema = z.object({ id: z.string().describe("Finding ID") });

const updateFindingSchema = z.object({
  id: z.string().describe("Finding ID"),
  status: z
    .enum(["open", "fixed", "ignored", "in-progress", "false-positive", "stale"])
    .describe("New status"),
  notes: z.string().optional().describe("Optional notes"),
});

const overridesSchema = z.object({
  overrides: z.record(z.unknown()).describe("Config fields to merge"),
});

const emptySchema = z.object({});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all 5 state tools and 2 config tools on the given McpServer instance.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {string} projectPath
 */
export function registerStateTools(server, projectPath) {
  server.registerTool(
    "get_findings",
    { description: "Return persisted findings, optionally filtered. Supports pagination.", inputSchema: findingsSchema },
    makeFindingsHandler(projectPath),
  );

  server.registerTool(
    "get_finding",
    { description: "Return a single finding by ID.", inputSchema: idSchema },
    makeFindingHandler(projectPath),
  );

  server.registerTool(
    "update_finding",
    { description: "Update the status and/or notes on a finding.", inputSchema: updateFindingSchema },
    makeUpdateFindingHandler(projectPath),
  );

  server.registerTool(
    "clear_findings",
    { description: "Clear all persisted findings and reset scan state.", inputSchema: emptySchema },
    makeClearFindingsHandler(projectPath),
  );

  server.registerTool(
    "get_summary",
    { description: "Return summary statistics for all persisted findings.", inputSchema: emptySchema },
    makeSummaryHandler(projectPath),
  );

  server.registerTool(
    "get_config",
    { description: "Read project config, merged with defaults.", inputSchema: emptySchema },
    makeGetConfigHandler(projectPath),
  );

  server.registerTool(
    "update_config",
    { description: "Deep-merge overrides into project config and write .lazy-refactor.json.", inputSchema: overridesSchema },
    makeUpdateConfigHandler(projectPath),
  );
}
