/**
 * Pure, DB-free helpers for findings state: id generation, summary aggregation,
 * filter matching, and incoming-finding stamping. No I/O — safe to unit test in
 * isolation and shared by findings.js.
 */

import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";

export const VALID_STATUSES = [
  "open",
  "fixed",
  "ignored",
  "in-progress",
  "false-positive",
  "stale",
];

/**
 * The line-INDEPENDENT identity of a finding: check + file + description + symbol.
 * Deliberately excludes `startLine` so a finding keeps its id when surrounding edits
 * shift it to a new line — that's what lets a triage verdict (false-positive/ignored)
 * survive a re-scan instead of resurfacing as a "new" finding (the corrupt-memory
 * workaround this replaces). `description`/`symbol` carry the per-finding specifics
 * (the unused symbol's name, the duplicated file pair) that keep distinct findings
 * distinct; `occurrence` (assigned in scan order by stampFindings) disambiguates the
 * rare case of multiple findings sharing all of those in one file (e.g. two
 * console.logs), preserving collision-safety without reintroducing the line number.
 * @param {object} finding
 * @param {number} [occurrence=0]
 */
export function findingSignature(finding) {
  const location = finding.locations?.[0] ?? {};
  return `${finding.check ?? ""}:${location.file ?? ""}:${finding.description ?? ""}:${finding.symbol ?? ""}`;
}

export function generateFindingId(finding, occurrence = 0) {
  const raw = `${findingSignature(finding)}:${occurrence}`;
  return `f-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

/**
 * Make a single file path root-relative with forward-slash separators. Absolute
 * paths are rebased onto `root`; already-relative paths are left as-is (only
 * separator-normalised). This is the canonical representation for a finding's
 * file — group keys, the locations[0].file index, and the finding-id hash all
 * depend on it being consistent regardless of how a scanner emitted the path.
 * @param {string} file
 * @param {string} root
 * @returns {string}
 */
function toRootRelative(file, root) {
  let rel = isAbsolute(file) ? relative(root, file) : file;
  if (sep !== "/") rel = rel.split(sep).join("/");
  return rel;
}

/**
 * Normalise every finding's location paths to root-relative, IN PLACE. The
 * engine's scanners are inconsistent — `collectFiles` yields absolute paths
 * (dead-code, metrics, duplicates) while the grep-based pattern scanner yields
 * relative ones — so without this, the SAME physical file lands under both an
 * absolute and a relative key. That fragments `group_findings by:file` (two
 * fixer agents dispatched against one file) and destabilises the id hash. Run
 * this at the ingestion chokepoint BEFORE stamping so ids are computed from the
 * canonical path.
 * @param {Array<object>} findings
 * @param {string} root  Absolute scan root.
 * @returns {Array<object>} the same array (mutated)
 */
export function normalizeFindingPaths(findings, root) {
  if (!root) return findings;
  for (const f of findings) {
    if (Array.isArray(f.locations)) {
      for (const loc of f.locations) {
        if (loc && typeof loc.file === "string") loc.file = toRootRelative(loc.file, root);
      }
    }
    // Duplicate-pair findings carry a second file outside `locations`.
    if (typeof f.fileB === "string") f.fileB = toRootRelative(f.fileB, root);
  }
  return findings;
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

/**
 * Assign IDs and default status to incoming raw findings. IDs are content-based
 * and line-independent (see generateFindingId); `occurrence` is counted per
 * signature ACROSS this scan's batch so multiple same-signature findings in one
 * file get stable, distinct ids in scan order.
 */
export function stampFindings(findings) {
  const occurrences = new Map();
  return findings.map((f) => {
    if (f.id) return { status: "open", ...f };
    const sig = findingSignature(f);
    const n = occurrences.get(sig) ?? 0;
    occurrences.set(sig, n + 1);
    return { status: "open", ...f, id: generateFindingId(f, n) };
  });
}
