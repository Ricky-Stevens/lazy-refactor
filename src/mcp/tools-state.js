/**
 * Finding-state tool registrations for the lazy-refactor MCP server.
 *
 * Tools: get_findings, get_findings_by_ids, count_findings, get_summary,
 *        update_finding, update_findings, prune_findings, clear_findings
 *
 * Reads and writes are id-list based (pass a single-element array for one) — there
 * is no separate single-id read tool. Config tools live in tools-config.js.
 */

import {
  clearFindings,
  countFindings,
  getFindingsByIds,
  getFindingsPage,
  getSummary,
  pruneFindings,
  updateFinding,
  updateFindings,
} from "../state/findings.js";
import { fail, ok } from "./helpers.js";
import {
  byIdsSchema,
  countSchema,
  emptySchema,
  findingsSchema,
  MAX_BATCH,
  MAX_NOTES,
  pruneSchema,
  updateFindingSchema,
  updateFindingsSchema,
} from "./tools-schemas.js";

// Project a finding to a lightweight shape for large result sets — drops snippets
// and other bulky fields, keeping just what's needed to triage and select work.
function toCompact(f) {
  const loc = f.locations?.[0] ?? {};
  return {
    id: f.id,
    check: f.check,
    severity: f.severity,
    category: f.category,
    status: f.status ?? "open",
    description: f.description,
    file: loc.file ?? null,
    startLine: loc.startLine ?? null,
    fixable: f.fixable,
    confidence: f.confidence,
  };
}

// ---------------------------------------------------------------------------
// Handler factories — each returns an async handler closed over projectPath
// ---------------------------------------------------------------------------

function makeFindingsHandler(projectPath) {
  return async ({ filter, limit, offset, compact }) => {
    try {
      const effectiveOffset = Math.max(0, offset ?? 0);
      const effectiveLimit = Math.max(0, limit ?? 200);
      const { findings, total } = await getFindingsPage(projectPath, filter ?? {}, {
        limit: effectiveLimit,
        offset: effectiveOffset,
      });
      return ok({
        findings: compact ? findings.map(toCompact) : findings,
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

function makeFindingsByIdsHandler(projectPath) {
  return async ({ ids, compact }) => {
    try {
      const { findings, notFound } = await getFindingsByIds(projectPath, ids);
      return ok({ findings: compact ? findings.map(toCompact) : findings, notFound });
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

function makeUpdateFindingsHandler(projectPath) {
  return async ({ updates, ids, status, notes, filter }) => {
    try {
      // Cross-field validation lives here, not in the schema: a .refine()-wrapped
      // schema normalizes to an empty advertised inputSchema in the MCP SDK,
      // which would hide the parameters from the model.
      const modes = [updates, ids, filter].filter((x) => x !== undefined);
      if (modes.length !== 1) {
        return fail(new Error("Provide exactly one of: updates, ids, or filter"));
      }
      if (updates === undefined && status === undefined && notes === undefined) {
        return fail(new Error("ids and filter modes require at least one of status or notes"));
      }
      if ((updates?.length ?? 0) > MAX_BATCH || (ids?.length ?? 0) > MAX_BATCH) {
        return fail(new Error(`Batch too large (max ${MAX_BATCH} items per call)`));
      }
      if (
        (notes?.length ?? 0) > MAX_NOTES ||
        (updates ?? []).some((u) => (u.notes?.length ?? 0) > MAX_NOTES)
      ) {
        return fail(new Error(`Notes too long (max ${MAX_NOTES} characters)`));
      }
      return ok(await updateFindings(projectPath, { updates, ids, status, notes, filter }));
    } catch (err) {
      return fail(err);
    }
  };
}

function makeCountHandler(projectPath) {
  return async ({ filter }) => {
    try {
      return ok({ count: await countFindings(projectPath, filter ?? {}) });
    } catch (err) {
      return fail(err);
    }
  };
}

function makePruneHandler(projectPath) {
  return async ({ status }) => {
    try {
      return ok(await pruneFindings(projectPath, status ? { statuses: status } : {}));
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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the 8 finding-state tools on the given McpServer instance.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {string} projectPath
 */
export function registerStateTools(server, projectPath) {
  server.registerTool(
    "get_findings",
    {
      description: "Return persisted findings, optionally filtered. Supports pagination.",
      inputSchema: findingsSchema,
    },
    makeFindingsHandler(projectPath),
  );

  server.registerTool(
    "get_findings_by_ids",
    {
      description:
        "Fetch findings by an explicit id list (pass a single-element array for one). " +
        "Status-agnostic. Returns { findings, notFound }.",
      inputSchema: byIdsSchema,
    },
    makeFindingsByIdsHandler(projectPath),
  );

  server.registerTool(
    "count_findings",
    {
      description: "Count findings matching a filter, without fetching them. Returns { count }.",
      inputSchema: countSchema,
    },
    makeCountHandler(projectPath),
  );

  server.registerTool(
    "get_summary",
    {
      description: "Return summary statistics for all persisted findings.",
      inputSchema: emptySchema,
    },
    makeSummaryHandler(projectPath),
  );

  server.registerTool(
    "update_finding",
    {
      description: "Update the status and/or notes on a single finding.",
      inputSchema: updateFindingSchema,
    },
    makeUpdateFindingHandler(projectPath),
  );

  server.registerTool(
    "update_findings",
    {
      description:
        "Batch-update finding statuses/notes in one call. Use this instead of repeated " +
        "update_finding calls when triaging many findings. Provide exactly one of: " +
        "`updates` (per-item patches), `ids` + status/notes, or `filter` + status/notes. " +
        "Returns { updated, notFound, summary }.",
      inputSchema: updateFindingsSchema,
    },
    makeUpdateFindingsHandler(projectPath),
  );

  server.registerTool(
    "prune_findings",
    {
      description:
        "Permanently delete findings by status (default: 'stale'). Frees space from " +
        "findings that accumulate across repeated focused scans. Returns { deleted }.",
      inputSchema: pruneSchema,
    },
    makePruneHandler(projectPath),
  );

  server.registerTool(
    "clear_findings",
    { description: "Clear all persisted findings and reset scan state.", inputSchema: emptySchema },
    makeClearFindingsHandler(projectPath),
  );
}
