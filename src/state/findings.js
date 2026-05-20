/**
 * JSON state persistence for findings.
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DIR_NAME = ".lazy-refactor";
const FILE_NAME = "findings.json";

const DEFAULT_STATE = () => ({
  scanId: null,
  path: null,
  findings: [],
  summary: {
    totalFindings: 0,
    bySeverity: {},
    byCategory: {},
    byStatus: {},
  },
});

/**
 * Deterministic ID from finding content.
 * Uses: check + file (first location) + startLine (first location).
 *
 * @param {object} finding
 * @returns {string}
 */
export function generateFindingId(finding) {
  const location = finding.locations?.[0] ?? {};
  const raw = `${finding.check ?? ""}:${location.file ?? ""}:${location.startLine ?? ""}`;
  const digest = createHash("sha256").update(raw).digest("hex");
  return `f-${digest.slice(0, 8)}`;
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

  for (const f of findings) {
    if (f.severity) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    if (f.category) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    const status = f.status ?? "open";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return { totalFindings: findings.length, bySeverity, byCategory, byStatus };
}

/**
 * Resolve the path to findings.json for the given project.
 *
 * @param {string} projectPath
 * @returns {string}
 */
function findingsPath(projectPath) {
  return join(projectPath, DIR_NAME, FILE_NAME);
}

/**
 * Load findings state from disk. Returns default state if file doesn't exist.
 *
 * @param {string} projectPath
 * @returns {Promise<object>}
 */
export async function loadFindings(projectPath) {
  try {
    const raw = await readFile(findingsPath(projectPath), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      return DEFAULT_STATE();
    }
    throw err;
  }
}

/**
 * Write state to findings.json, creating the .lazy-refactor/ dir if needed.
 *
 * @param {string} projectPath
 * @param {object} state
 * @returns {Promise<void>}
 */
export async function saveFindings(projectPath, state) {
  const dir = join(projectPath, DIR_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(findingsPath(projectPath), JSON.stringify(state, null, 2), "utf8");
}

/**
 * Merge new findings into existing state.
 *
 * - If scanId matches existing state, replace findings entirely.
 * - If scanId is different (or null), append findings.
 * Recomputes summary before saving.
 *
 * @param {string} projectPath
 * @param {object[]} newFindings
 * @param {string | null} scanId
 * @param {string | null} scanPath
 * @returns {Promise<void>}
 */
export async function addFindings(projectPath, newFindings, scanId, scanPath) {
  const state = await loadFindings(projectPath);

  // Assign IDs and default status to incoming findings
  const stamped = newFindings.map((f) => ({
    status: "open",
    ...f,
    id: f.id ?? generateFindingId(f),
  }));

  if (scanId !== null && scanId !== undefined && state.scanId === scanId) {
    // Same scan — replace
    state.findings = stamped;
  } else {
    // Different or first scan — append
    state.findings = [...state.findings, ...stamped];
  }

  state.scanId = scanId ?? state.scanId;
  state.path = scanPath ?? state.path;
  state.summary = computeSummary(state.findings);

  await saveFindings(projectPath, state);
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
  const state = await loadFindings(projectPath);
  const idx = state.findings.findIndex((f) => f.id === findingId);
  if (idx === -1) return null;

  state.findings[idx] = { ...state.findings[idx], ...updates };
  state.summary = computeSummary(state.findings);

  await saveFindings(projectPath, state);
  return state.findings[idx];
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

  return state.findings.filter(
    (f) =>
      match(f.severity, filter.severity) &&
      match(f.category, filter.category) &&
      match(f.status ?? "open", filter.status) &&
      match(f.language, filter.language),
  );
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
  // Recompute to include byStatus even if stored summary is older
  return computeSummary(state.findings);
}
