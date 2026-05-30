/**
 * Zod input schemas and shared constants for the lazy-refactor MCP tools.
 * Kept separate so the tool modules stay focused on handlers/registration.
 */

import * as z from "zod";
import { RUN_STATUSES } from "../state/runs.js";

// Bounds on batch mutations. The MCP server is a single long-lived process and
// bun:sqlite is synchronous, so an unbounded batch would block every other tool
// call while it runs. These caps turn an oversized request into a clean error.
export const MAX_BATCH = 10000;
export const MAX_NOTES = 8192;

export const STATUS_ENUM = z.enum([
  "open",
  "fixed",
  "ignored",
  "in-progress",
  "false-positive",
  "stale",
]);

export const SEVERITY_ENUM = z.enum(["critical", "high", "medium", "low"]);

export const filterShape = z
  .object({
    severity: z.union([z.string(), z.array(z.string())]).optional(),
    category: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.union([z.string(), z.array(z.string())]).optional(),
    language: z.union([z.string(), z.array(z.string())]).optional(),
    check: z.union([z.string(), z.array(z.string())]).optional(),
    file: z.union([z.string(), z.array(z.string())]).optional(),
    fixable: z.boolean().optional(),
    minConfidence: z.number().min(0).max(1).optional(),
  })
  .describe(
    "Filter by severity, category, status, language, check, file, fixable, and/or minConfidence. " +
      "fixable:true selects findings the fixer can auto-apply (missing flag defaults to fixable); " +
      "fixable:false selects findings that need manual intervention. " +
      "minConfidence keeps only findings whose confidence score is >= the given value " +
      "(0-1; a missing confidence defaults to 1, i.e. fully confident).",
  );

export const findingsSchema = z.object({
  filter: filterShape.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum findings to return (default 200, max 1000)"),
  offset: z.number().int().min(0).optional().describe("Skip this many findings (for pagination)"),
  compact: z
    .boolean()
    .optional()
    .describe("Return a lightweight projection (drops snippets/bulky fields) — use at scale"),
  orderBy: z
    .enum(["rowid", "severity", "confidence"])
    .optional()
    .describe(
      "Result ordering (default 'rowid' = scan-insertion order). 'severity' returns most-severe " +
        "first (critical→low); 'confidence' returns highest-confidence first. Lets a single bounded " +
        "page surface the top-priority findings without pulling and sorting the whole set.",
    ),
});

export const byIdsSchema = z.object({
  ids: z
    .array(z.string())
    .min(1)
    .max(MAX_BATCH)
    .describe("Finding IDs to fetch (pass a single-element array for one)."),
  compact: z.boolean().optional().describe("Return the lightweight projection."),
});

export const updateFindingSchema = z.object({
  id: z.string().describe("Finding ID"),
  status: STATUS_ENUM.optional().describe("New status"),
  notes: z.string().max(MAX_NOTES).optional().describe("Optional notes"),
  severity: SEVERITY_ENUM.optional().describe(
    "Override the finding's severity (e.g. after assessment). Updates the indexed column " +
      "used by report ordering and `/fix <severity>`.",
  ),
});

export const updateFindingsSchema = z.object({
  updates: z
    .array(
      z.object({
        id: z.string(),
        status: STATUS_ENUM.optional(),
        notes: z.string().max(MAX_NOTES).optional(),
        severity: SEVERITY_ENUM.optional(),
      }),
    )
    .max(MAX_BATCH)
    .optional()
    .describe("Per-item patches: [{id, status?, notes?, severity?}]. Use for mixed changes."),
  ids: z
    .array(z.string())
    .max(MAX_BATCH)
    .optional()
    .describe("Apply the same status/notes/severity to these finding IDs."),
  filter: filterShape
    .optional()
    .describe(
      "Apply the same status/notes/severity to all findings matching this filter. Stale " +
        "findings are excluded unless the filter sets status explicitly.",
    ),
  status: STATUS_ENUM.optional().describe("New status (for ids/filter modes)"),
  notes: z.string().max(MAX_NOTES).optional().describe("Notes (for ids/filter modes)"),
  severity: SEVERITY_ENUM.optional().describe(
    "New severity (for ids/filter modes). Updates the indexed severity column + the blob.",
  ),
});

export const countSchema = z.object({ filter: filterShape.optional() });

export const groupSchema = z.object({
  by: z
    .enum(["file", "category", "check", "severity", "language", "status"])
    .optional()
    .describe("Dimension to group by (default 'file')."),
  filter: filterShape.optional(),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max groups to return per call (default 200). Page with offset while truncated."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Group offset for paging (default 0)."),
});

export const pruneSchema = z.object({
  status: z
    .array(STATUS_ENUM)
    .optional()
    .describe("Statuses to permanently delete (default: ['stale'])."),
});

export const overridesSchema = z.object({
  overrides: z.record(z.unknown()).describe("Config fields to merge"),
});

export const setRunStatusSchema = z.object({
  id: z.string().optional().describe("Run ID (defaults to the active run)"),
  status: z.enum(RUN_STATUSES).describe("New run status"),
});

export const listRunsSchema = z.object({
  includeArchived: z
    .boolean()
    .optional()
    .describe("Include archived runs (default: false — archived runs are hidden)"),
});

export const runIdSchema = z.object({ id: z.string().describe("Run ID") });

export const emptySchema = z.object({});
