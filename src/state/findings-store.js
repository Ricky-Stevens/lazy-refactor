/**
 * SQL primitives over the findings table. Connection, schema, mapping, meta, and
 * lifecycle live in findings-db.js; run CRUD lives in runs.js; business logic
 * (merge/stale/filter semantics, active-run resolution) lives in findings.js.
 *
 * Every primitive is scoped to a single `runId` — findings from other runs share
 * the table but are never touched. Writes here run no internal transaction; callers
 * wrap multi-statement ops in db.transaction() so they are atomic and fast.
 */

import { findingToRow, getStateDb, rowToFinding, SELECT_COLS } from "./findings-db.js";

// Re-export the connection/meta/lifecycle facade so consumers import from one place.
export { closeAllConnections, metaGet, metaSet, reclaimSpace } from "./findings-db.js";

// Open the single state database. Findings primitives also need the active run id,
// which findings.js resolves via runs.ensureActiveRunId and threads in as `runId`.
export function getDb(projectPath) {
  return getStateDb(projectPath);
}

// SQLite bounds bound variables (~999 by default); chunk id lists below that.
const ID_CHUNK = 500;

const INSERT_COLS =
  "INSERT INTO findings (run_id, id, check_name, severity, category, status, language, notes, data)";

function runInsert(stmt, runId, f) {
  const r = findingToRow(runId, f);
  stmt.run(
    r.run_id,
    r.id,
    r.check_name,
    r.severity,
    r.category,
    r.status,
    r.language,
    r.notes,
    r.data,
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function selectAll(db, runId) {
  return db.query(`${SELECT_COLS} WHERE run_id = ? ORDER BY rowid`).all(runId).map(rowToFinding);
}

/**
 * Fetch findings by explicit id list within a run, status-agnostic (no stale
 * exclusion). The single id-read primitive — pass `[id]` for one. Chunked for the
 * SQLite bound-variable limit.
 */
export function selectByIds(db, runId, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    for (const row of db
      .query(`${SELECT_COLS} WHERE run_id = ? AND id IN (${placeholders})`)
      .all(runId, ...chunk)) {
      out.push(rowToFinding(row));
    }
  }
  return out;
}

// Build the WHERE clause for a run plus the scalar filter keys (severity/category/
// language/check/status). Stale findings are excluded unless the filter constrains
// status. The `file` dimension is intentionally left to findings.js#matchesFilter
// (multi-location semantics).
function buildScalarWhere(runId, filter) {
  const conds = ["run_id = ?"];
  const params = [runId];
  const inClause = (col, val) => {
    const arr = Array.isArray(val) ? val : [val];
    conds.push(`${col} IN (${arr.map(() => "?").join(",")})`);
    params.push(...arr);
  };

  if (filter.severity != null) inClause("severity", filter.severity);
  if (filter.category != null) inClause("category", filter.category);
  if (filter.language != null) inClause("language", filter.language);
  if (filter.check != null) inClause("check_name", filter.check);
  if (filter.status != null) inClause("status", filter.status);
  else conds.push("status != 'stale'");

  return { where: `WHERE ${conds.join(" AND ")}`, params };
}

/**
 * Fetch findings narrowed by the scalar filter keys, optionally paginated via SQL
 * LIMIT/OFFSET (so only the requested page is read and parsed, not the whole set).
 */
export function selectScalar(db, runId, filter = {}, { limit, offset } = {}) {
  const { where, params } = buildScalarWhere(runId, filter);
  const args = [...params];
  let sql = `${SELECT_COLS} ${where} ORDER BY rowid`;
  if (limit != null) {
    sql += " LIMIT ?";
    args.push(limit);
    if (offset) {
      sql += " OFFSET ?";
      args.push(offset);
    }
  }
  return db
    .query(sql)
    .all(...args)
    .map(rowToFinding);
}

/** Count findings matching the scalar filter — no blob parsing. */
export function countScalar(db, runId, filter = {}) {
  const { where, params } = buildScalarWhere(runId, filter);
  return db.query(`SELECT COUNT(*) AS c FROM findings ${where}`).get(...params).c;
}

/** Return the subset of `ids` that exist in the run (chunked for var limits). */
export function existingIds(db, runId, ids) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    for (const row of db
      .query(`SELECT id FROM findings WHERE run_id = ? AND id IN (${placeholders})`)
      .all(runId, ...chunk)) {
      found.add(row.id);
    }
  }
  return found;
}

export function summary(db, runId) {
  const groupBy = (col, extra = "") =>
    db
      .query(
        `SELECT ${col} AS k, COUNT(*) AS c FROM findings WHERE run_id = ? AND status != 'stale' ${extra} GROUP BY ${col}`,
      )
      .all(runId);
  const fold = (rows) => Object.fromEntries(rows.map((r) => [r.k, r.c]));
  return {
    totalFindings: db
      .query("SELECT COUNT(*) AS c FROM findings WHERE run_id = ? AND status != 'stale'")
      .get(runId).c,
    bySeverity: fold(groupBy("severity", "AND severity IS NOT NULL")),
    byCategory: fold(groupBy("category", "AND category IS NOT NULL")),
    byStatus: fold(groupBy("status")),
  };
}

const EMPTY_SUMMARY = () => ({ totalFindings: 0, bySeverity: {}, byCategory: {}, byStatus: {} });

/**
 * Summaries for ALL runs in a FIXED 4 grouped queries (not 4 per run), so list_runs
 * never fans out a per-run statement no matter how many runs exist. Cost scales with
 * total live findings (4 index scans), not run count. Returns a Map<runId, summary>;
 * callers default missing runs to an empty summary.
 */
export function summariesByRun(db) {
  const m = new Map();
  const ensure = (runId) => {
    if (!m.has(runId)) m.set(runId, EMPTY_SUMMARY());
    return m.get(runId);
  };
  const each = (sql, apply) => {
    for (const r of db.query(sql).all()) apply(ensure(r.run_id), r);
  };
  each(
    "SELECT run_id, COUNT(*) AS c FROM findings WHERE status != 'stale' GROUP BY run_id",
    (s, r) => {
      s.totalFindings = r.c;
    },
  );
  each(
    "SELECT run_id, severity AS k, COUNT(*) AS c FROM findings WHERE status != 'stale' AND severity IS NOT NULL GROUP BY run_id, severity",
    (s, r) => {
      s.bySeverity[r.k] = r.c;
    },
  );
  each(
    "SELECT run_id, category AS k, COUNT(*) AS c FROM findings WHERE status != 'stale' AND category IS NOT NULL GROUP BY run_id, category",
    (s, r) => {
      s.byCategory[r.k] = r.c;
    },
  );
  each(
    "SELECT run_id, status AS k, COUNT(*) AS c FROM findings WHERE status != 'stale' GROUP BY run_id, status",
    (s, r) => {
      s.byStatus[r.k] = r.c;
    },
  );
  return m;
}

export const emptySummary = EMPTY_SUMMARY;

// ---------------------------------------------------------------------------
// Writes (no internal transactions — callers wrap multi-statement ops)
// ---------------------------------------------------------------------------

/** Upsert findings into a run, preserving any existing non-open status and notes. */
export function upsertMany(db, runId, findings) {
  // db.query caches the compiled statement by SQL string, so this single statement
  // is reused across calls (no per-call prepare/finalize churn in a long-lived proc).
  const stmt = db.query(
    `${INSERT_COLS}
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, id) DO UPDATE SET
       check_name = excluded.check_name,
       severity   = excluded.severity,
       category   = excluded.category,
       language   = excluded.language,
       data       = excluded.data,
       -- Preserve USER-set statuses (fixed/ignored/false-positive/in-progress), but a
       -- reappearing finding that was system-marked 'stale' must revive to 'open'
       -- (excluded.status) — otherwise a re-introduced issue stays silently hidden.
       status     = CASE WHEN findings.status NOT IN ('open', 'stale') THEN findings.status ELSE excluded.status END,
       notes      = COALESCE(findings.notes, excluded.notes)`,
  );
  for (const f of findings) runInsert(stmt, runId, f);
}

// Mark previously-open findings in this run that are absent from `newIds` as stale.
// Passes the keep-set as a JSON array bound to a single `json_each` table-valued
// subquery — one statement, no per-row inserts, no connection-scoped temp table, and
// no bound-variable-limit concern. An empty keep-set ([]) correctly stales every open
// finding in the run. Null/undefined ids are filtered out first: a NULL in the
// subquery would make `id NOT IN (...)` evaluate to NULL (never true) and stale
// nothing. (Real ids are always non-null strings, but the guard is cheap insurance.)
export function markStaleExcept(db, runId, newIds) {
  const keep = (newIds ?? []).filter((id) => id != null);
  db.run(
    "UPDATE findings SET status = 'stale' WHERE run_id = ? AND status = 'open' AND id NOT IN (SELECT value FROM json_each(?))",
    [runId, JSON.stringify(keep)],
  );
}

/** Apply per-item status/notes patches within a run. Undefined fields leave columns intact. */
export function applyPatches(db, runId, patches) {
  const stmt = db.query(
    "UPDATE findings SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE run_id = ? AND id = ?",
  );
  for (const p of patches) stmt.run(p.status ?? null, p.notes ?? null, runId, p.id);
}

/** Apply ONE shared status/notes patch to many ids in a run — set-based, chunked. */
export function applyUniformPatch(db, runId, ids, { status, notes }) {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    db.query(
      `UPDATE findings SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE run_id = ? AND id IN (${placeholders})`,
    ).run(status ?? null, notes ?? null, runId, ...chunk);
  }
}

/**
 * Apply ONE shared patch to every finding in a run matching a scalar filter, set-
 * based in a single UPDATE (no materialisation). Returns the number of rows matched.
 */
export function applyPatchByScalar(db, runId, filter, { status, notes }) {
  const { where, params } = buildScalarWhere(runId, filter);
  return db
    .query(`UPDATE findings SET status = COALESCE(?, status), notes = COALESCE(?, notes) ${where}`)
    .run(status ?? null, notes ?? null, ...params).changes;
}

/** Delete every finding in a run whose status is in `statuses`. Returns the count. */
export function deleteByStatus(db, runId, statuses) {
  const placeholders = statuses.map(() => "?").join(",");
  return db
    .query(`DELETE FROM findings WHERE run_id = ? AND status IN (${placeholders})`)
    .run(runId, ...statuses).changes;
}

/** Replace a run's findings entirely (used by the saveFindings compat helper). */
export function replaceAll(db, runId, findings) {
  db.run("DELETE FROM findings WHERE run_id = ?", [runId]);
  const stmt = db.query(`${INSERT_COLS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const f of findings) runInsert(stmt, runId, f);
}

/** Delete all findings in a run. */
export function clearAll(db, runId) {
  db.run("DELETE FROM findings WHERE run_id = ?", [runId]);
}
