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

export const filterShape = z
  .object({
    severity: z.union([z.string(), z.array(z.string())]).optional(),
    category: z.union([z.string(), z.array(z.string())]).optional(),
    status: z.union([z.string(), z.array(z.string())]).optional(),
    language: z.union([z.string(), z.array(z.string())]).optional(),
    check: z.union([z.string(), z.array(z.string())]).optional(),
    file: z.union([z.string(), z.array(z.string())]).optional(),
    fixable: z.boolean().optional(),
  })
  .describe(
    "Filter by severity, category, status, language, check, file, and/or fixable. " +
      "fixable:true selects findings the fixer can auto-apply (missing flag defaults to fixable); " +
      "fixable:false selects findings that need manual intervention.",
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
  status: STATUS_ENUM.describe("New status"),
  notes: z.string().max(MAX_NOTES).optional().describe("Optional notes"),
});

export const updateFindingsSchema = z.object({
  updates: z
    .array(
      z.object({
        id: z.string(),
        status: STATUS_ENUM.optional(),
        notes: z.string().max(MAX_NOTES).optional(),
      }),
    )
    .max(MAX_BATCH)
    .optional()
    .describe("Per-item patches: [{id, status?, notes?}]. Use for mixed changes."),
  ids: z
    .array(z.string())
    .max(MAX_BATCH)
    .optional()
    .describe("Apply the same status/notes to these finding IDs."),
  filter: filterShape
    .optional()
    .describe(
      "Apply the same status/notes to all findings matching this filter. Stale findings " +
        "are excluded unless the filter sets status explicitly.",
    ),
  status: STATUS_ENUM.optional().describe("New status (for ids/filter modes)"),
  notes: z.string().max(MAX_NOTES).optional().describe("Notes (for ids/filter modes)"),
});

export const countSchema = z.object({ filter: filterShape.optional() });

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
