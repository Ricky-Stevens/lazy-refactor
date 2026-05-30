/**
 * Pure, DB-free helpers for findings state: id generation, summary aggregation,
 * filter matching, and incoming-finding stamping. No I/O — safe to unit test in
 * isolation and shared by findings.js.
 */

import { createHash } from "node:crypto";

export const VALID_STATUSES = [
  "open",
  "fixed",
  "ignored",
  "in-progress",
  "false-positive",
  "stale",
];

export function generateFindingId(finding) {
  const location = finding.locations?.[0] ?? {};
  const raw = `${finding.check ?? ""}:${location.file ?? ""}:${location.startLine ?? ""}:${finding.description ?? ""}`;
  return `f-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

// Stale findings are excluded from summary counts. Used by the loadFindings compat
// helper and tests; the live read path uses the SQL GROUP-BY summary in the store.
export function computeSummary(findings) {
  const bySeverity = {};
  const byCategory = {};
  const byStatus = {};
  const active = findings.filter((f) => (f.status ?? "open") !== "stale");
  for (const f of active) {
    if (f.severity) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    if (f.category) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    const status = f.status ?? "open";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return { totalFindings: active.length, bySeverity, byCategory, byStatus };
}

/** Extract a status/notes/severity patch, including only fields that were supplied. */
export function pickPatch({ status, notes, severity } = {}) {
  const patch = {};
  if (status !== undefined) patch.status = status;
  if (notes !== undefined) patch.notes = notes;
  if (severity !== undefined) patch.severity = severity;
  return patch;
}

/**
 * Decide whether a finding matches a filter. Each filter value may be a string or
 * an array of strings. Stale findings are excluded unless the filter constrains
 * `status`. SQL is authoritative for the scalar keys; this runs for the
 * multi-location `file` dimension it alone can express.
 *
 * @param {object} finding
 * @param {{ severity?, category?, status?, language?, check?, file?, minConfidence? }} [filter]
 */
export function matchesFilter(finding, filter = {}) {
  const match = (value, filterValue) => {
    if (filterValue == null) return true;
    const allowed = Array.isArray(filterValue) ? filterValue : [filterValue];
    return allowed.includes(value);
  };

  const status = finding.status ?? "open";
  if (filter.status === undefined && status === "stale") return false;

  const fileMatch =
    filter.file == null || (finding.locations ?? []).some((l) => match(l.file, filter.file));

  // Missing confidence defaults to 1, matching the SQL path and prioritizer.js.
  const confidenceMatch =
    filter.minConfidence == null || (finding.confidence ?? 1) >= filter.minConfidence;

  return (
    match(finding.severity, filter.severity) &&
    match(finding.category, filter.category) &&
    match(status, filter.status) &&
    match(finding.language, filter.language) &&
    match(finding.check, filter.check) &&
    fileMatch &&
    confidenceMatch
  );
}

/** Assign IDs and default status to incoming raw findings. */
export function stampFindings(findings) {
  return findings.map((f) => ({ status: "open", ...f, id: f.id ?? generateFindingId(f) }));
}
