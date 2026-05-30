/**
 * Scan "run" registry. All runs live in the single shared state database
 * (`.lazy-refactor/state.db`); a run is just a row in the `runs` table, and its
 * findings are rows in `findings` tagged with `run_id`. The active-run pointer is
 * held in `meta` under `activeRunId`.
 *
 * `run_scan` creates a new run; `resume_scan` re-activates an existing one. All
 * findings/triage tools operate on whichever run is active (see findings.js, which
 * resolves the active run id and scopes every query to it).
 */

import { randomBytes } from "node:crypto";
import { getStateDb, metaGet, metaSet, reclaimSpace } from "./findings-db.js";

export const RUN_STATUSES = ["in-progress", "complete", "archived"];

function db(projectPath) {
  return getStateDb(projectPath);
}

function genRunId() {
  return `r-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

// Strictly increasing per-project counter, persisted in meta. Drives list_runs
// ordering so it's deterministic regardless of wall-clock resolution.
function nextTouchSeq(conn) {
  const n = (metaGet(conn, "runTouchSeq") ?? 0) + 1;
  metaSet(conn, "runTouchSeq", n);
  return n;
}

function runExists(conn, id) {
  return conn.query("SELECT 1 FROM runs WHERE id = ?").get(id) != null;
}

function rowToRun(r, activeId) {
  return {
    id: r.id,
    label: r.label,
    status: r.status,
    path: r.path,
    scanId: r.scan_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    active: r.id === activeId,
  };
}

function insertRun(conn, { label = null, path = null, scanId = null, status = "in-progress" }) {
  const id = genRunId();
  const now = new Date().toISOString();
  const seq = nextTouchSeq(conn);
  conn
    .query(
      "INSERT INTO runs (id, label, status, path, scan_id, created_at, updated_at, touch_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, label, status, path, scanId, now, now, seq);
  metaSet(conn, "activeRunId", id);
  return rowToRun(
    { id, label, status, path, scan_id: scanId, created_at: now, updated_at: now },
    id,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve the active run id, creating a default run if none exists or it's gone. */
export function ensureActiveRunId(projectPath) {
  const conn = db(projectPath);
  const id = metaGet(conn, "activeRunId");
  return id && runExists(conn, id) ? id : insertRun(conn, {}).id;
}

export function createRun(projectPath, opts = {}) {
  return insertRun(db(projectPath), opts);
}

export function getActiveRunId(projectPath) {
  return metaGet(db(projectPath), "activeRunId");
}

export function getRun(projectPath, id) {
  const conn = db(projectPath);
  const r = conn.query("SELECT * FROM runs WHERE id = ?").get(id);
  return r ? rowToRun(r, metaGet(conn, "activeRunId")) : null;
}

export function setActiveRun(projectPath, id) {
  const conn = db(projectPath);
  if (!runExists(conn, id)) throw new Error(`Run '${id}' not found`);
  metaSet(conn, "activeRunId", id);
  return id;
}

/**
 * Update a run's scan metadata (scanId/path) and bump updated_at, against a caller-
 * supplied connection so it can join the findings write transaction in addFindings.
 */
export function touchRunOn(conn, id, { scanId, path } = {}) {
  conn
    .query(
      "UPDATE runs SET scan_id = COALESCE(?, scan_id), path = COALESCE(?, path), updated_at = ?, touch_seq = ? WHERE id = ?",
    )
    .run(scanId ?? null, path ?? null, new Date().toISOString(), nextTouchSeq(conn), id);
}

/** Reset a run's scan metadata (scanId/path) — used when its findings are cleared. */
export function clearRunScanMetaOn(conn, id) {
  conn
    .query(
      "UPDATE runs SET scan_id = NULL, path = NULL, updated_at = ?, touch_seq = ? WHERE id = ?",
    )
    .run(new Date().toISOString(), nextTouchSeq(conn), id);
}

export function setRunStatus(projectPath, id, status) {
  if (!RUN_STATUSES.includes(status)) throw new Error(`Invalid run status: ${status}`);
  const conn = db(projectPath);
  if (!runExists(conn, id)) return null;
  conn
    .query("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), id);
  return { id, status };
}

// Most-recently-touched first, so a caller resuming after a lost session sees their
// last run at the top. addFindings bumps updated_at when a scan writes into a run.
// Archived runs are hidden by default so the list stays usable as runs accumulate.
export function listRuns(projectPath, { includeArchived = false } = {}) {
  const conn = db(projectPath);
  const activeId = metaGet(conn, "activeRunId");
  // The active run is ALWAYS shown, even if archived — otherwise activating/resuming
  // an archived run would leave it operating invisibly (no active marker anywhere).
  const rows = includeArchived
    ? conn.query("SELECT * FROM runs ORDER BY touch_seq DESC").all()
    : conn
        .query("SELECT * FROM runs WHERE status != 'archived' OR id = ? ORDER BY touch_seq DESC")
        .all(activeId);
  return rows.map((r) => rowToRun(r, activeId));
}

/**
 * Permanently delete a run and all its findings. If the deleted run was active, the
 * pointer is repointed to the most-recently-touched remaining run (or cleared if
 * none remain) so the user is never stranded on a dangling active run. Returns null
 * if the run doesn't exist.
 */
export function deleteRun(projectPath, id) {
  const conn = db(projectPath);
  if (!runExists(conn, id)) return null;
  const wasActive = metaGet(conn, "activeRunId") === id;
  const deleted = conn
    .transaction(() => {
      const findings = conn.run("DELETE FROM findings WHERE run_id = ?", [id]).changes;
      conn.run("DELETE FROM runs WHERE id = ?", [id]);
      if (wasActive) {
        const next = conn.query("SELECT id FROM runs ORDER BY touch_seq DESC LIMIT 1").get();
        metaSet(conn, "activeRunId", next ? next.id : null);
      }
      return findings;
    })
    .immediate();
  reclaimSpace(conn); // return the deleted run's pages to the OS (INCREMENTAL vacuum)
  // newActiveRunId always reflects the active pointer AFTER the delete — unchanged
  // when a non-active run was removed, repointed/cleared when the active one was.
  return { id, deletedFindings: deleted, newActiveRunId: getActiveRunId(projectPath) };
}
