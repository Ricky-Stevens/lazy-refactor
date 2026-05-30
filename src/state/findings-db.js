/**
 * SQLite connection, schema, mapping, and lifecycle for all lazy-refactor state
 * (Bun's built-in `bun:sqlite`).
 *
 * Storage model — a SINGLE database, `.lazy-refactor/state.db` (WAL mode):
 *   - `runs`     one row per scan run (id, label, status, path, scan_id, timestamps).
 *   - `findings` one row per finding, scoped by `run_id`. Filterable fields (check,
 *                severity, category, status, language) are denormalised into indexed
 *                columns; the full scan-derived shape lives in a `data` JSON blob.
 *                Finding IDs are content hashes, so the SAME finding can recur across
 *                runs — the primary key is therefore `(run_id, id)`.
 *   - `meta`     key/value table; holds the active-run pointer.
 *
 * `status` and `notes` are columns ONLY (stripped from the blob), so status/notes
 * mutations are pure indexed column UPDATEs — no JSON re-serialisation. On read,
 * columns are overlaid back onto the parsed blob.
 *
 * Designed for a single long-lived writer process per project. WAL allows
 * concurrent readers and `busy_timeout` absorbs brief overlap; there is no advisory
 * file lock. SQL primitives live in findings-store.js; run CRUD lives in runs.js;
 * business logic lives in findings.js.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const DIR_NAME = ".lazy-refactor";
const STATE_DB = "state.db";

// One open connection per database path, paired with the file's inode so a cache
// hit can detect a DB that was deleted/recreated out-of-band and re-open.
const connections = new Map();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY NOT NULL,
  label      TEXT,
  status     TEXT NOT NULL DEFAULT 'in-progress',
  path       TEXT,
  scan_id    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Monotonic counter bumped on create and on every scan/clear "touch". updated_at
  -- is wall-clock (ms resolution) for display; touch_seq is what list_runs ORDERs by,
  -- so ordering is deterministic even when two touches share a millisecond.
  touch_seq  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS findings (
  run_id     TEXT NOT NULL,
  id         TEXT NOT NULL,
  check_name TEXT,
  severity   TEXT,
  category   TEXT,
  status     TEXT NOT NULL DEFAULT 'open',
  language   TEXT,
  notes      TEXT,
  data       TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);
-- A plain (run_id) index stores entries as (run_id, rowid), so the default read
-- (WHERE run_id = ? ... ORDER BY rowid LIMIT n) is served in insertion order
-- straight from the index — no temp B-tree sort, and LIMIT stops early. The
-- composite indexes below lead with run_id too but carry a second column, so they
-- do NOT satisfy the rowid ordering; this one is load-bearing for the hot path.
CREATE INDEX IF NOT EXISTS idx_findings_run      ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_status   ON findings(run_id, status);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(run_id, severity);
CREATE INDEX IF NOT EXISTS idx_findings_category ON findings(run_id, category);
CREATE INDEX IF NOT EXISTS idx_findings_language ON findings(run_id, language);
CREATE INDEX IF NOT EXISTS idx_findings_check    ON findings(run_id, check_name);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export const SELECT_COLS = "SELECT id, status, notes, data FROM findings";

export function stateDbPath(projectPath) {
  return join(projectPath, DIR_NAME, STATE_DB);
}

// ---------------------------------------------------------------------------
// Row <-> finding mapping
// ---------------------------------------------------------------------------

/**
 * Split a finding into indexed columns + a JSON blob. id/status/notes are excluded
 * from the blob (status/notes are authoritative columns; id is part of the key). The
 * remaining columns (check/severity/category/language) are denormalised copies of
 * blob fields, kept for indexed SQL filtering/GROUP BY — rowToFinding reads those
 * back from the blob, so the duplication is load-bearing; do not strip them.
 */
function findingToRow(runId, f) {
  const { id, status, notes, ...rest } = f;
  return {
    run_id: runId,
    id,
    check_name: f.check ?? null,
    severity: f.severity ?? null,
    category: f.category ?? null,
    status: status ?? "open",
    language: f.language ?? null,
    notes: notes ?? null,
    data: JSON.stringify(rest),
  };
}

/** Reconstruct a finding, overlaying the authoritative status/notes columns. */
function rowToFinding(row) {
  const f = JSON.parse(row.data);
  f.id = row.id;
  f.status = row.status;
  if (row.notes != null) f.notes = row.notes;
  return f;
}

export { findingToRow, rowToFinding };

// ---------------------------------------------------------------------------
// Connection + schema
// ---------------------------------------------------------------------------

function inodeOf(path) {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
}

/**
 * Get-or-open the cached SQLite connection at `dbPath`. The cache is keyed by path
 * and inode, so a DB deleted/recreated out-of-band is detected and re-opened. On a
 * fresh open, applies the WAL/PRAGMA setup then `db.exec(SCHEMA)`.
 */
function openConnection(dbPath) {
  const cached = connections.get(dbPath);
  if (cached) {
    if (cached.ino === inodeOf(dbPath)) return cached.db;
    try {
      cached.db.close();
    } catch {
      // Best-effort: the underlying file may already be gone.
    }
    connections.delete(dbPath);
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  // INCREMENTAL auto-vacuum lets delete_run/prune reclaim freed pages via
  // `PRAGMA incremental_vacuum` instead of the file growing to its high-water mark
  // forever. Must be set before any table is created, so it only takes effect on a
  // fresh DB (a no-op on a pre-existing NONE db — harmless, just won't shrink).
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // The server is single-process and bun:sqlite is synchronous, so a write-lock wait
  // blocks the whole process. We assume one writer per project; this timeout only
  // bites if a SECOND session writes concurrently. Keep it short enough that such a
  // collision can't freeze the client for long. (See CLAUDE.md single-writer note.)
  db.exec("PRAGMA busy_timeout = 5000");
  // WAL is fastest but unsupported on network filesystems (NFS/SMB, some WSL
  // mounts). The PRAGMA reports the mode actually in effect; if WAL didn't take,
  // fall back to TRUNCATE — portable and safe for our single-writer model.
  const journalMode = db.query("PRAGMA journal_mode = WAL").get()?.journal_mode;
  if (journalMode !== "wal") db.exec("PRAGMA journal_mode = TRUNCATE");
  db.exec(SCHEMA);
  connections.set(dbPath, { db, ino: inodeOf(dbPath) });
  return db;
}

/** Open (creating if needed) the single state database for `projectPath`. */
export function getStateDb(projectPath) {
  return openConnection(stateDbPath(projectPath));
}

// ---------------------------------------------------------------------------
// Meta + shutdown
// ---------------------------------------------------------------------------

// Return freed pages to the OS after a large delete. Only does work under INCREMENTAL
// auto-vacuum (a no-op otherwise) and must run OUTSIDE a transaction. Best-effort.
export function reclaimSpace(db) {
  try {
    db.run("PRAGMA incremental_vacuum");
  } catch {
    // Non-fatal — reclamation is opportunistic; a busy/locked db just keeps the pages.
  }
}

export function metaGet(db, key) {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : null;
}

export function metaSet(db, key, value) {
  db.query(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value ?? null));
}

/**
 * Checkpoint and close all cached connections. Wired to graceful-shutdown signals
 * and the process `exit` event so the WAL is folded back into the main db and the
 * -wal/-shm sidecars are not orphaned. Best-effort and idempotent.
 */
export function closeAllConnections() {
  for (const { db } of connections.values()) {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    } catch {
      // Best-effort during shutdown — nothing actionable if a handle is already gone.
    }
  }
  connections.clear();
}
