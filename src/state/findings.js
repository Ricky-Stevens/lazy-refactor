/**
 * Public API for findings state.
 *
 * State shape:
 * {
 *   scanId: string | null,
 *   path: string | null,
 *   findings: Finding[],
 *   summary: { totalFindings, bySeverity, byCategory, byStatus }
 * }
 *
 * Finding statuses: 'open' | 'fixed' | 'ignored' | 'in-progress' | 'false-positive'
 */

import { createHash } from "node:crypto";
import { acquireLock, loadFindings, releaseLock, saveFindings } from "./findings-store.js";

export { loadFindings, saveFindings } from "./findings-store.js";

export const VALID_STATUSES = [
  "open",
  "fixed",
  "ignored",
  "in-progress",
  "false-positive",
  "stale",
];

/**
 * Deterministic ID from finding content.
 * Uses: check + file (first location) + startLine (first location) + description.
 *
 * @param {object} finding
 * @returns {string}
 */
export function generateFindingId(finding) {
  const location = finding.locations?.[0] ?? {};
  const raw = `${finding.check ?? ""}:${location.file ?? ""}:${location.startLine ?? ""}:${finding.description ?? ""}`;
  const digest = createHash("sha256").update(raw).digest("hex");
  return `f-${digest.slice(0, 16)}`;
}

/**
 * Compute summary statistics from a findings array.
 *
 * @param {object[]} findings
 * @returns {{ totalFindings: number, bySeverity: object, byCategory: object, byStatus: object }}
 */
export function computeSummary(findings) {
  const bySeverity = {};
  const byCategory = {};
  const byStatus = {};

  // Exclude stale findings from summary counts
  const active = findings.filter((f) => (f.status ?? "open") !== "stale");

  for (const f of active) {
    if (f.severity) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    if (f.category) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    const status = f.status ?? "open";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return { totalFindings: active.length, bySeverity, byCategory, byStatus };
}

/**
 * Merge new findings into existing state with deduplication by ID.
 *
 * New findings with the same ID as existing ones replace the existing entry
 * (preserving user-set status/notes if the new finding doesn't override them).
 * Recomputes summary before saving.
 *
 * @param {string} projectPath
 * @param {object[]} newFindings
 * @param {string | null} scanId
 * @param {string | null} scanPath
 * @returns {Promise<void>}
 */
export async function addFindings(projectPath, newFindings, scanId, scanPath) {
  await acquireLock(projectPath);
  try {
    const state = await loadFindings(projectPath);

    const stamped = newFindings.map((f) => ({
      status: "open",
      ...f,
      id: f.id ?? generateFindingId(f),
    }));

    // Build a map of existing findings by ID for dedup
    const existingById = new Map();
    for (const f of state.findings) {
      existingById.set(f.id, f);
    }

    // Build a set of new finding IDs for stale detection
    const newIds = new Set();
    for (const f of stamped) {
      newIds.add(f.id);
    }

    // Merge: new findings replace existing ones by ID, preserve user status/notes
    for (const f of stamped) {
      const existing = existingById.get(f.id);
      if (existing) {
        existingById.set(f.id, {
          ...f,
          status: existing.status !== "open" ? existing.status : f.status,
          notes: existing.notes ?? f.notes,
        });
      } else {
        existingById.set(f.id, f);
      }
    }

    // Mark existing open findings that are not in the new scan as stale
    for (const [id, f] of existingById) {
      if (!newIds.has(id) && (f.status ?? "open") === "open") {
        existingById.set(id, { ...f, status: "stale" });
      }
    }

    state.findings = [...existingById.values()];
    state.scanId = scanId ?? state.scanId;
    state.path = scanPath ?? state.path;
    state.summary = computeSummary(state.findings);

    await saveFindings(projectPath, state);
  } finally {
    await releaseLock(projectPath);
  }
}

/**
 * Clear all findings and reset scan state, with proper advisory locking.
 *
 * @param {string} projectPath
 * @returns {Promise<void>}
 */
export async function clearFindings(projectPath) {
  await acquireLock(projectPath);
  try {
    await saveFindings(projectPath, {
      scanId: null,
      path: null,
      findings: [],
      summary: { totalFindings: 0, bySeverity: {}, byCategory: {}, byStatus: {} },
    });
  } finally {
    await releaseLock(projectPath);
  }
}

/**
 * Update status and/or notes on a finding by id.
 *
 * @param {string} projectPath
 * @param {string} findingId
 * @param {{ status?: string, notes?: string }} updates
 * @returns {Promise<object | null>}
 */
export async function updateFinding(projectPath, findingId, updates) {
  await acquireLock(projectPath);
  try {
    const state = await loadFindings(projectPath);
    const idx = state.findings.findIndex((f) => f.id === findingId);
    if (idx === -1) return null;

    state.findings[idx] = { ...state.findings[idx], ...updates };
    state.summary = computeSummary(state.findings);

    await saveFindings(projectPath, state);
    return state.findings[idx];
  } finally {
    await releaseLock(projectPath);
  }
}

/**
 * Return findings filtered by severity, category, status, and/or language.
 * Each filter value may be a string or array of strings.
 *
 * @param {string} projectPath
 * @param {{ severity?: string|string[], category?: string|string[], status?: string|string[], language?: string|string[] }} [filter]
 * @returns {Promise<object[]>}
 */
export async function getFindings(projectPath, filter = {}) {
  const state = await loadFindings(projectPath);

  const match = (value, filterValue) => {
    if (filterValue === undefined || filterValue === null) return true;
    const allowed = Array.isArray(filterValue) ? filterValue : [filterValue];
    return allowed.includes(value);
  };

  return state.findings.filter((f) => {
    const status = f.status ?? "open";
    // Exclude stale findings by default unless explicitly filtering for stale
    if (status === "stale" && filter.status === undefined) return false;
    return (
      match(f.severity, filter.severity) &&
      match(f.category, filter.category) &&
      match(status, filter.status) &&
      match(f.language, filter.language)
    );
  });
}

/**
 * Return a single finding by id, or null if not found.
 *
 * @param {string} projectPath
 * @param {string} findingId
 * @returns {Promise<object | null>}
 */
export async function getFinding(projectPath, findingId) {
  const state = await loadFindings(projectPath);
  return state.findings.find((f) => f.id === findingId) ?? null;
}

/**
 * Return summary statistics for the project's findings.
 *
 * @param {string} projectPath
 * @returns {Promise<{ totalFindings: number, bySeverity: object, byCategory: object, byStatus: object }>}
 */
export async function getSummary(projectPath) {
  const state = await loadFindings(projectPath);
  return computeSummary(state.findings);
}
