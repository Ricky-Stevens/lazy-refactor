/**
 * Public API for findings state (SQLite-backed via findings-store.js).
 *
 * All operations target the ACTIVE run (see readCtx/writeCtx below); run
 * selection/creation lives in runs.js. loadFindings returns
 * { scanId, path, findings, summary }; scan metadata lives on the run row.
 *
 * Finding statuses: 'open' | 'fixed' | 'ignored' | 'in-progress' | 'false-positive' | 'stale'
 *
 * Dedup invariant: addFindings merges by ID. User-set statuses and notes are
 * preserved across repeated scans. Findings absent from the latest scan are marked
 * stale if they were previously open. Functions stay async even though bun:sqlite is
 * synchronous, so existing callers/tests need no changes.
 */

import {
  computeSummary,
  matchesFilter,
  pickPatch,
  stampFindings,
  VALID_STATUSES,
} from "./findings-helpers.js";
import {
  applyPatchByScalar,
  applyPatches,
  applyUniformPatch,
  clearAll,
  countScalar,
  deleteByStatus,
  existingIds,
  getDb,
  groupByColumn,
  markStaleExcept,
  reclaimSpace,
  replaceAll,
  selectAll,
  selectByIds,
  selectFileCandidates,
  selectScalar,
  summary,
  upsertMany,
} from "./findings-store.js";
import {
  clearRunScanMetaOn,
  ensureActiveRunId,
  getActiveRunId,
  getRun,
  touchRunOn,
} from "./runs.js";

// Re-export the pure helpers that form part of this module's public/test surface.
export {
  computeSummary,
  generateFindingId,
  matchesFilter,
  VALID_STATUSES,
} from "./findings-helpers.js";

// Reads resolve the active run WITHOUT creating one: on a never-scanned project
// runId is null and every `WHERE run_id = ?` matches zero rows, so a pure read
// returns empty and never mutates state. Writes create a default run if none exists.
function readCtx(projectPath) {
  return { db: getDb(projectPath), runId: getActiveRunId(projectPath) };
}
function writeCtx(projectPath) {
  return { db: getDb(projectPath), runId: ensureActiveRunId(projectPath) };
}

// ---------------------------------------------------------------------------
// Compatibility helpers: full-state load/replace (used by tools and tests)
// ---------------------------------------------------------------------------

export async function loadFindings(projectPath) {
  const { db, runId } = readCtx(projectPath);
  const findings = selectAll(db, runId);
  const run = runId ? getRun(projectPath, runId) : null;
  return {
    scanId: run?.scanId ?? null,
    path: run?.path ?? null,
    findings,
    summary: computeSummary(findings),
  };
}

export async function saveFindings(projectPath, state) {
  const { db, runId } = writeCtx(projectPath);
  db.transaction(() => {
    replaceAll(db, runId, state.findings ?? []);
    touchRunOn(db, runId, { scanId: state.scanId, path: state.path });
  }).immediate();
}

// ---------------------------------------------------------------------------
// State mutators
// ---------------------------------------------------------------------------

export async function addFindings(projectPath, newFindings, scanId, scanPath) {
  const { db, runId } = writeCtx(projectPath);
  const stamped = stampFindings(newFindings);
  const newIds = stamped.map((f) => f.id);

  db.transaction(() => {
    upsertMany(db, runId, stamped);
    markStaleExcept(db, runId, newIds);
    // Record scan metadata on the run row and bump updated_at, so list_runs orders
    // most-recently-scanned first. COALESCE leaves unset fields intact.
    touchRunOn(db, runId, { scanId, path: scanPath });
  }).immediate();
}

export async function clearFindings(projectPath) {
  const { db, runId } = readCtx(projectPath);
  db.transaction(() => {
    clearAll(db, runId);
    clearRunScanMetaOn(db, runId);
  }).immediate();
}

export async function updateFinding(projectPath, findingId, updates = {}) {
  const { db, runId } = readCtx(projectPath);
  const prev = selectByIds(db, runId, [findingId])[0];
  if (!prev) return null;
  applyPatches(db, runId, [{ id: findingId, status: updates.status, notes: updates.notes }]);
  // Overlay the patch in JS (?? mirrors the COALESCE: undefined leaves prior value)
  // instead of a second read.
  const next = { ...prev, status: updates.status ?? prev.status };
  const notes = updates.notes ?? prev.notes;
  if (notes != null) next.notes = notes;
  else delete next.notes;
  return next;
}

/**
 * Apply many status/notes changes in one transaction — the batch path for large
 * refactors. Three mutually exclusive selection modes:
 *
 *   { updates: [{ id, status?, notes? }, ...] }   per-item patches (heterogeneous)
 *   { ids: [...], status?, notes? }               one patch applied to listed ids
 *   { filter: {...}, status?, notes? }            one patch applied to matching findings
 *
 * `ids` and `filter` modes apply the shared patch set-based (single/chunked
 * UPDATE, no row materialisation). The presence check and the write share one
 * IMMEDIATE transaction so `notFound` can't drift from what was applied. Returns
 * counts, not findings.
 *
 * @returns {Promise<{ updated: number, notFound: string[], summary: object }>}
 */
export async function updateFindings(projectPath, { updates, ids, status, notes, filter } = {}) {
  const { db, runId } = readCtx(projectPath);

  // Per-item heterogeneous patches: validate presence + apply atomically.
  if (Array.isArray(updates)) {
    const patches = updates.map((u) => ({ id: u.id, ...pickPatch(u) }));
    const { updated, notFound } = db
      .transaction(() => {
        const present = existingIds(
          db,
          runId,
          patches.map((p) => p.id),
        );
        const missing = [];
        const missingSeen = new Set();
        // Dedup by id: last conflicting patch wins (preserves prior observable
        // last-write-wins) while reporting distinct-id counts.
        const byId = new Map();
        for (const p of patches) {
          if (!present.has(p.id)) {
            if (!missingSeen.has(p.id)) {
              missingSeen.add(p.id);
              missing.push(p.id);
            }
          } else if (p.status !== undefined || p.notes !== undefined) {
            byId.set(p.id, p);
          }
        }
        const toApply = [...byId.values()];
        if (toApply.length) applyPatches(db, runId, toApply);
        return { updated: toApply.length, notFound: missing };
      })
      .immediate();
    return { updated, notFound, summary: summary(db, runId) };
  }

  const patch = pickPatch({ status, notes });

  // Filter mode: a single set-based UPDATE when no multi-location file dimension.
  if (filter) {
    if (filter.file == null) {
      const updated = db
        .transaction(() => applyPatchByScalar(db, runId, filter, patch))
        .immediate();
      return { updated, notFound: [], summary: summary(db, runId) };
    }
    const fileIds = (await getFindings(projectPath, filter)).map((f) => f.id);
    if (fileIds.length) {
      db.transaction(() => applyUniformPatch(db, runId, fileIds, patch)).immediate();
    }
    return { updated: fileIds.length, notFound: [], summary: summary(db, runId) };
  }

  // Ids mode: validate presence (for notFound) + apply atomically.
  const idList = Array.isArray(ids) ? ids : [];
  const { updated, notFound } = db
    .transaction(() => {
      const present = existingIds(db, runId, idList);
      const missing = [];
      const toApply = [];
      const seen = new Set();
      for (const id of idList) {
        if (!present.has(id)) missing.push(id);
        else if (!seen.has(id)) {
          seen.add(id);
          toApply.push(id);
        }
      }
      if (toApply.length) applyUniformPatch(db, runId, toApply, patch);
      return { updated: toApply.length, notFound: missing };
    })
    .immediate();
  return { updated, notFound, summary: summary(db, runId) };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// JS comparators mirroring selectScalar's ORDER BY, for the materialised `file` path.
// Returns null for rowid (already in insertion order). Stable sort keeps rowid as tiebreak.
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
function orderComparator(orderBy) {
  if (orderBy === "severity") {
    return (a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4);
  }
  if (orderBy === "confidence") {
    return (a, b) => (b.confidence ?? 1) - (a.confidence ?? 1);
  }
  return null;
}

/**
 * Return findings matching the given filter (see matchesFilter for semantics).
 * Supported keys are severity, category, status, language, check, fixable, and file.
 * SQL is authoritative for the scalar keys (including blob-extracted `fixable`);
 * matchesFilter runs only for the multi-location `file` dimension it alone can express.
 *
 * @param {string} projectPath
 * @param {{ severity?, category?, status?, language?, check?, fixable?, file? }} [filter]
 */
export async function getFindings(projectPath, filter = {}) {
  const { db, runId } = readCtx(projectPath);
  if (filter.file == null) return selectScalar(db, runId, filter);
  // File filter: read only candidate blobs (indexed), then narrow exactly in JS.
  return selectFileCandidates(db, runId, filter).filter((f) => matchesFilter(f, filter));
}

/**
 * Paginated query for the get_findings tool. Returns `{ findings, total }` where
 * `total` is the full match count (for the `truncated` flag) and `findings` is the
 * requested page. When no `file` filter is present, LIMIT/OFFSET and COUNT are
 * pushed to SQL so only the page is parsed; the multi-location `file` dimension
 * requires materialising the matches and slicing in JS.
 *
 * @param {string} projectPath
 * @param {object} [filter]
 * @param {{ limit?: number, offset?: number, orderBy?: string }} [page]
 */
export async function getFindingsPage(projectPath, filter = {}, { limit, offset, orderBy } = {}) {
  const { db, runId } = readCtx(projectPath);
  const start = offset ?? 0;

  if (filter.file != null) {
    // Read only candidate blobs (indexed superset), then narrow exactly in JS and sort
    // by the same key the SQL path uses. Array.sort is stable, so candidate rowid order
    // is preserved as the tiebreaker.
    const all = selectFileCandidates(db, runId, filter).filter((f) => matchesFilter(f, filter));
    const cmp = orderComparator(orderBy);
    if (cmp) all.sort(cmp);
    const findings = limit == null ? all.slice(start) : all.slice(start, start + limit);
    return { findings, total: all.length };
  }

  return {
    findings: selectScalar(db, runId, filter, { limit, offset: start, orderBy }),
    total: countScalar(db, runId, filter),
  };
}

/**
 * Fetch findings by an explicit id list — the single id-read entry point (pass
 * `[id]` for one). Status-agnostic (returns findings regardless of status, since
 * the caller chose these ids), mirroring the write-side ids mode. Returns
 * `{ findings, notFound }`.
 */
export async function getFindingsByIds(projectPath, ids = []) {
  const { db, runId } = readCtx(projectPath);
  const findings = selectByIds(db, runId, ids);
  const present = new Set(findings.map((f) => f.id));
  return { findings, notFound: ids.filter((id) => !present.has(id)) };
}

export async function getSummary(projectPath) {
  const { db, runId } = readCtx(projectPath);
  return summary(db, runId);
}

/** Count findings matching a filter (exact, including the multi-location file dimension). */
export async function countFindings(projectPath, filter = {}) {
  const { db, runId } = readCtx(projectPath);
  if (filter.file == null) return countScalar(db, runId, filter);
  return selectFileCandidates(db, runId, filter).filter((f) => matchesFilter(f, filter)).length;
}

/**
 * Group findings matching a filter by `by` (default 'file'), returning
 * `{ by, groups: [{ key, count, ids }], totalGroups, totalFindings }` sorted by count
 * desc. The point is to plan work (e.g. one fixer per file) WITHOUT pulling every
 * finding into the caller's context: only keys + ids are returned, never the bulky
 * `data` blobs. Indexed columns group in SQL (group_concat). `file` is multi-location
 * (it lives in each finding's `locations[]`), so it materialises the run and groups by
 * each finding's PRIMARY location in JS — matching how the fixer dispatches per file.
 *
 * @param {string} projectPath
 * @param {object} [filter]
 * @param {'file'|'category'|'check'|'severity'|'language'|'status'} [by]
 */
export async function groupFindings(projectPath, filter = {}, by = "file") {
  const { db, runId } = readCtx(projectPath);

  if (by !== "file") {
    const groups = groupByColumn(db, runId, filter, by);
    const totalFindings = groups.reduce((n, g) => n + g.count, 0);
    return { by, groups, totalGroups: groups.length, totalFindings };
  }

  const rows = selectScalar(db, runId, filter);
  const matched = filter.file == null ? rows : rows.filter((f) => matchesFilter(f, filter));
  const map = new Map();
  for (const f of matched) {
    const key = f.locations?.[0]?.file ?? null;
    let g = map.get(key);
    if (!g) {
      g = { key, count: 0, ids: [] };
      map.set(key, g);
    }
    g.count += 1;
    g.ids.push(f.id);
  }
  const groups = [...map.values()].sort((a, b) => b.count - a.count);
  return { by, groups, totalGroups: groups.length, totalFindings: matched.length };
}

/**
 * Permanently delete findings by status (defaults to 'stale' only). Statuses are
 * validated against VALID_STATUSES so a typo can't silently no-op or over-delete.
 * Returns `{ deleted }`.
 */
export async function pruneFindings(projectPath, { statuses = ["stale"] } = {}) {
  const invalid = statuses.filter((s) => !VALID_STATUSES.includes(s));
  if (invalid.length) throw new Error(`Invalid status(es): ${invalid.join(", ")}`);
  const { db, runId } = readCtx(projectPath);
  const deleted = db.transaction(() => deleteByStatus(db, runId, statuses)).immediate();
  if (deleted > 0) reclaimSpace(db); // return freed pages to the OS (INCREMENTAL vacuum)
  return { deleted };
}
