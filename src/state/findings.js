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
 * Finding statuses: 'open' | 'fixed' | 'ignored' | 'in-progress' | 'false-positive' | 'stale'
 *
 * Dedup invariant: addFindings merges by ID. User-set statuses and notes are
 * preserved across repeated scans. Findings absent from the latest scan are
 * marked stale if they were previously open.
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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function generateFindingId(finding) {
  const location = finding.locations?.[0] ?? {};
  const raw = `${finding.check ?? ""}:${location.file ?? ""}:${location.startLine ?? ""}:${finding.description ?? ""}`;
  const digest = createHash("sha256").update(raw).digest("hex");
  return `f-${digest.slice(0, 16)}`;
}

export function computeSummary(findings) {
  const bySeverity = {};
  const byCategory = {};
  const byStatus = {};

  // Stale findings are excluded from summary counts
  const active = findings.filter((f) => (f.status ?? "open") !== "stale");

  for (const f of active) {
    if (f.severity) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    if (f.category) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    const status = f.status ?? "open";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return { totalFindings: active.length, bySeverity, byCategory, byStatus };
}

/** Assign IDs and default status to incoming raw findings. */
function stampFindings(findings) {
  return findings.map((f) => ({
    status: "open",
    ...f,
    id: f.id ?? generateFindingId(f),
  }));
}

/**
 * Merge stamped findings into an existing ID→finding map.
 * Preserves non-open status and notes set by the user.
 */
function mergeById(existingById, stamped) {
  for (const f of stamped) {
    const existing = existingById.get(f.id);
    if (!existing) {
      existingById.set(f.id, f);
      continue;
    }
    existingById.set(f.id, {
      ...f,
      status: existing.status !== "open" ? existing.status : f.status,
      notes: existing.notes ?? f.notes,
    });
  }
}

/**
 * Mark previously-open findings that did not appear in this scan as stale.
 * Findings with user-set statuses (fixed, ignored, etc.) are left alone.
 */
function markStale(existingById, newIds) {
  for (const [id, f] of existingById) {
    if (!newIds.has(id) && (f.status ?? "open") === "open") {
      existingById.set(id, { ...f, status: "stale" });
    }
  }
}

// ---------------------------------------------------------------------------
// Exported state mutators
// ---------------------------------------------------------------------------

export async function addFindings(projectPath, newFindings, scanId, scanPath) {
  await acquireLock(projectPath);
  try {
    const state = await loadFindings(projectPath);
    const stamped = stampFindings(newFindings);
    const newIds = new Set(stamped.map((f) => f.id));

    const existingById = new Map(state.findings.map((f) => [f.id, f]));
    mergeById(existingById, stamped);
    markStale(existingById, newIds);

    state.findings = [...existingById.values()];
    state.scanId = scanId ?? state.scanId;
    state.path = scanPath ?? state.path;
    state.summary = computeSummary(state.findings);

    await saveFindings(projectPath, state);
  } finally {
    await releaseLock(projectPath);
  }
}

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
 * Stale findings are excluded unless status filter explicitly includes 'stale'.
 *
 * @param {string} projectPath
 * @param {{ severity?: string|string[], category?: string|string[], status?: string|string[], language?: string|string[] }} [filter]
 */
export async function getFindings(projectPath, filter = {}) {
  const state = await loadFindings(projectPath);

  const match = (value, filterValue) => {
    if (filterValue == null) return true;
    const allowed = Array.isArray(filterValue) ? filterValue : [filterValue];
    return allowed.includes(value);
  };

  const excludeStale = filter.status === undefined;

  return state.findings.filter((f) => {
    const status = f.status ?? "open";
    if (excludeStale && status === "stale") return false;
    return (
      match(f.severity, filter.severity) &&
      match(f.category, filter.category) &&
      match(status, filter.status) &&
      match(f.language, filter.language)
    );
  });
}

export async function getFinding(projectPath, findingId) {
  const state = await loadFindings(projectPath);
  return state.findings.find((f) => f.id === findingId) ?? null;
}

export async function getSummary(projectPath) {
  const state = await loadFindings(projectPath);
  return computeSummary(state.findings);
}
