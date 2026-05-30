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

/**
 * Candidate rows for a `file` filter, read via index instead of scanning the run:
 * those whose PRIMARY location file matches (idx_findings_locfile) UNIONed with ALL
 * multi-location findings (partial idx_findings_multiloc). This is a strict SUPERSET of
 * the true matches — a cluster matched on a non-primary file has >1 location so it's in
 * the second branch — so findings.js' matchesFilter still decides exactly; we only shrink
 * the set of blobs parsed. Ordered by rowid to preserve default (insertion) order.
 */
export function selectFileCandidates(db, runId, filter) {
  const files = Array.isArray(filter.file) ? filter.file : [filter.file];
  const { where, params } = buildScalarWhere(runId, filter);
  const ph = files.map(() => "?").join(",");
  const cols = "SELECT id, status, notes, data, rowid AS _rowid FROM findings";
  const sql =
    `${cols} ${where} AND json_extract(data, '$.locations[0].file') IN (${ph})\n` +
    `UNION\n` +
    `${cols} ${where} AND json_array_length(data, '$.locations') > 1\n` +
    `ORDER BY _rowid`;
  return db
    .query(sql)
    .all(...params, ...files, ...params)
    .map(rowToFinding);
}

// Build the WHERE clause for a run plus the scalar filter keys (severity/category/
// language/check/status, plus blob-extracted `fixable`/`minConfidence`). Stale findings
// are excluded unless the filter constrains status. The `file` dimension is NOT added here:
// selectFileCandidates layers the indexed file/multi-location pre-filter on top of this
// clause, and findings.js#matchesFilter makes the exact multi-location decision in JS.
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

  // `fixable` is not a denormalised column (it's not a filterable index dimension):
  // extract it straight from the JSON blob. A missing flag defaults to fixable, matching
  // the mapper default, so fixable:true never silently drops an un-flagged finding.
  if (filter.fixable != null) {
    conds.push(
      filter.fixable
        ? "IFNULL(json_extract(data, '$.fixable'), 1) = 1"
        : "json_extract(data, '$.fixable') = 0",
    );
  }

  // `confidence` also lives in the blob, not a column. A missing confidence defaults
  // to 1 (matching prioritizer.js), so minConfidence never drops an un-scored finding.
  if (filter.minConfidence != null) {
    conds.push("IFNULL(json_extract(data, '$.confidence'), 1) >= ?");
    params.push(filter.minConfidence);
  }

  return { where: `WHERE ${conds.join(" AND ")}`, params };
}

// ORDER BY expressions, keyed by the validated `orderBy` enum. Values are fixed
// SQL fragments (never raw caller input), so interpolation is injection-safe. Each
// falls back to rowid as a stable tiebreaker so ordering is deterministic.
const ORDER_EXPRESSIONS = {
  rowid: "rowid",
  severity:
    "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 " +
    "WHEN 'low' THEN 3 ELSE 4 END, rowid",
  confidence: "IFNULL(json_extract(data, '$.confidence'), 1) DESC, rowid",
};

/**
 * Fetch findings narrowed by the scalar filter keys, optionally paginated via SQL
 * LIMIT/OFFSET (so only the requested page is read and parsed, not the whole set)
 * and ordered by `orderBy` (rowid | severity | confidence; default rowid).
 */
export function selectScalar(db, runId, filter = {}, { limit, offset, orderBy } = {}) {
  const { where, params } = buildScalarWhere(runId, filter);
  const args = [...params];
  const order = ORDER_EXPRESSIONS[orderBy] ?? ORDER_EXPRESSIONS.rowid;
  let sql = `${SELECT_COLS} ${where} ORDER BY ${order}`;
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

// Columns groupable in pure SQL (no blob parsing). `file` is NOT here — it's
// multi-location and lives in the blob, so findings.js groups it in JS.
const GROUPABLE_COLUMNS = {
  category: "category",
  check: "check_name",
  severity: "severity",
  language: "language",
  status: "status",
};

/**
 * Group findings matching the scalar filter by an indexed column, returning each
 * group's key, count, and member ids — all in one SQL pass (group_concat), no blob
 * parsing. `key` is the column name from the lookup, never raw caller input, so the
 * interpolation is injection-safe. Finding ids contain no commas, so the split is safe.
 */
export function groupByColumn(db, runId, filter, by) {
  const col = GROUPABLE_COLUMNS[by];
  if (!col) throw new Error(`Cannot group by '${by}' in SQL`);
  const { where, params } = buildScalarWhere(runId, filter);
  return db
    .query(
      `SELECT ${col} AS k, COUNT(*) AS c, group_concat(id) AS ids
       FROM findings ${where} GROUP BY ${col} ORDER BY c DESC`,
    )
    .all(...params)
    .map((r) => ({ key: r.k, count: r.c, ids: r.ids ? r.ids.split(",") : [] }));
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
    // Keyed on the raw `check_name`/`language` values — `byCheck` uses the SQL column
    // name `check_name`, which is what get_findings filters accept (the public `check`
    // alias maps to it via the COLUMN/GROUPABLE_COLUMNS lookups).
    byCheck: fold(groupBy("check_name", "AND check_name IS NOT NULL")),
    byLanguage: fold(groupBy("language", "AND language IS NOT NULL")),
  };
}

const EMPTY_SUMMARY = () => ({
  totalFindings: 0,
  bySeverity: {},
  byCategory: {},
  byStatus: {},
  byCheck: {},
  byLanguage: {},
});

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

/** Upsert findings into a run, preserving any existing non-open status, notes, and
 *  assessor-overridden severity. */
export function upsertMany(db, runId, findings) {
  // db.query caches the compiled statement by SQL string, so this single statement
  // is reused across calls (no per-call prepare/finalize churn in a long-lived proc).
  // `severity_overridden` is intentionally NOT in the SET list: a fresh scan never sets
  // it, and omitting it from DO UPDATE leaves the existing flag untouched (1 stays 1).
  const stmt = db.query(
    `${INSERT_COLS}
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, id) DO UPDATE SET
       check_name = excluded.check_name,
       category   = excluded.category,
       language   = excluded.language,
       -- Preserve an assessor/human severity override (severity_overridden = 1) against
       -- the engine's fresh value, in BOTH the column and the blob's $.severity (the
       -- rest of the blob is taken fresh). Non-overridden findings follow the engine.
       severity   = CASE WHEN findings.severity_overridden = 1 THEN findings.severity ELSE excluded.severity END,
       data       = CASE WHEN findings.severity_overridden = 1
                         THEN json_set(excluded.data, '$.severity', findings.severity)
                         ELSE excluded.data END,
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

/**
 * Apply per-item status/notes patches within a run. Undefined fields leave columns
 * intact. Patches sharing the same (status, notes) tuple are grouped and routed through
 * the set-based applyUniformPatch (chunked IN-clause UPDATE), so the common bulk-triage
 * case (one status across many ids) collapses to a handful of UPDATEs; only genuinely
 * heterogeneous patches remain multi-statement. COALESCE semantics are unchanged — a
 * null/undefined status or notes leaves that column intact.
 */
export function applyPatches(db, runId, patches) {
  const groups = new Map();
  for (const p of patches) {
    const status = p.status ?? null;
    const notes = p.notes ?? null;
    const severity = p.severity ?? null;
    const key = `${status ?? " "}|${notes ?? " "}|${severity ?? " "}`;
    const group = groups.get(key);
    if (group) group.ids.push(p.id);
    else groups.set(key, { status, notes, severity, ids: [p.id] });
  }
  for (const { status, notes, severity, ids } of groups.values()) {
    applyUniformPatch(db, runId, ids, { status, notes, severity });
  }
}

// Severity is denormalised: it lives in both the indexed `severity` column AND the
// `data` blob (rowToFinding reads it back from the blob). A patch must write both, or
// reads and indexed filters/ordering would disagree. The blob write is guarded by a
// CASE so a null (absent) severity leaves the blob untouched — same COALESCE semantics
// as the column. Patching severity also flips `severity_overridden` to 1 so a later
// re-scan preserves this value instead of clobbering it with the engine's (see
// upsertMany). The flag, column, and blob all move together or not at all.
const SET_PATCH =
  "status = COALESCE(?, status), notes = COALESCE(?, notes), " +
  "severity = COALESCE(?, severity), " +
  "severity_overridden = CASE WHEN ? IS NOT NULL THEN 1 ELSE severity_overridden END, " +
  "data = CASE WHEN ? IS NOT NULL THEN json_set(data, '$.severity', ?) ELSE data END";
const patchParams = ({ status, notes, severity }) => [
  status ?? null,
  notes ?? null,
  severity ?? null, // severity column (COALESCE)
  severity ?? null, // severity_overridden flag (CASE guard)
  severity ?? null, // data blob (CASE guard)
  severity ?? null, // json_set value
];

/** Apply ONE shared status/notes/severity patch to many ids in a run — set-based, chunked. */
export function applyUniformPatch(db, runId, ids, patch) {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    db.query(`UPDATE findings SET ${SET_PATCH} WHERE run_id = ? AND id IN (${placeholders})`).run(
      ...patchParams(patch),
      runId,
      ...chunk,
    );
  }
}

/**
 * Apply ONE shared patch to every finding in a run matching a scalar filter, set-
 * based in a single UPDATE (no materialisation). Returns the number of rows matched.
 */
export function applyPatchByScalar(db, runId, filter, patch) {
  const { where, params } = buildScalarWhere(runId, filter);
  return db.query(`UPDATE findings SET ${SET_PATCH} ${where}`).run(...patchParams(patch), ...params)
    .changes;
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
