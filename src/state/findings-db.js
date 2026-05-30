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
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
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
-- severity/category carry a trailing status column so summary()'s
-- status != 'stale' predicate is satisfied from the index itself, avoiding a
-- per-candidate-row main-table lookup that dominates summary() cost at scale.
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(run_id, severity, status);
CREATE INDEX IF NOT EXISTS idx_findings_category ON findings(run_id, category, status);
CREATE INDEX IF NOT EXISTS idx_findings_language ON findings(run_id, language);
CREATE INDEX IF NOT EXISTS idx_findings_check    ON findings(run_id, check_name);
-- Expression index on each finding's PRIMARY location file, plus a partial index over
-- multi-location findings (duplicate clusters). Together they let a file filter read only
-- candidate rows (primary-file matches plus all multi-location findings) instead of the
-- whole run; findings.js still applies matchesFilter for exact multi-location semantics, so
-- a cluster matched via a NON-primary file is never dropped. These index the existing JSON
-- blob (no schema column, no write-path change) and are created on open for existing DBs
-- too, so there is no migration. JSON1 is built into bun:sqlite, so both always apply.
CREATE INDEX IF NOT EXISTS idx_findings_locfile  ON findings(run_id, json_extract(data, '$.locations[0].file'));
CREATE INDEX IF NOT EXISTS idx_findings_multiloc ON findings(run_id) WHERE json_array_length(data, '$.locations') > 1;
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
  let f;
  try {
    f = JSON.parse(row.data);
  } catch {
    // A corrupt/truncated blob (crash mid-write, partial WAL apply) must not make the
    // whole run unreadable — fall back to a placeholder built from the indexed columns
    // so the rest of the .map() in selectAll/selectByIds/loadFindings still completes.
    f = {
      check: row.check_name ?? undefined,
      severity: row.severity ?? undefined,
      category: row.category ?? undefined,
      language: row.language ?? undefined,
      _unreadable: true,
    };
  }
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

// Apply the connection PRAGMAs and create the schema on a freshly-opened handle.
function applySchema(db) {
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
}

// A non-SQLite or structurally-broken file surfaces as one of these. Detected so a
// corrupt state.db can self-heal rather than wedging every tool until manual deletion.
function isCorruptionError(err) {
  const msg = String(err?.message ?? "");
  return (
    err?.code === "SQLITE_CORRUPT" ||
    err?.code === "SQLITE_NOTADB" ||
    /not a database|malformed|disk image|file is encrypted/i.test(msg)
  );
}

// Move a corrupt db (and its -wal/-shm sidecars) aside instead of deleting it, so the
// bytes are preserved for forensics while a fresh db takes its place. Best-effort.
function quarantineCorruptDb(dbPath) {
  const stamp = Date.now();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${dbPath}${suffix}`;
    try {
      if (existsSync(p)) renameSync(p, `${p}.corrupt-${stamp}`);
    } catch {
      // Best-effort: if the rename fails, the fresh open below surfaces a clear error.
    }
  }
}

/**
 * Get-or-open the cached SQLite connection at `dbPath`. The cache is keyed by path
 * and inode, so a DB deleted/recreated out-of-band is detected and re-opened. On a
 * fresh open, applies the WAL/PRAGMA setup then `db.exec(SCHEMA)`. If the file is
 * corrupt/not-a-database, it is quarantined aside and a fresh DB is created — state
 * is fully regenerable by re-scanning, so self-healing beats wedging all 25 tools.
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
  let db;
  try {
    db = new Database(dbPath, { create: true });
    applySchema(db);
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    try {
      db?.close();
    } catch {
      // Best-effort close of the bad handle before quarantining the file.
    }
    // stderr only — stdout is the JSON-RPC channel and must not be polluted.
    process.stderr.write(
      `lazy-refactor: state database at ${dbPath} is unreadable (${err.message}); ` +
        "moving it aside as .corrupt-<ts> and starting fresh. Re-scan to repopulate findings.\n",
    );
    quarantineCorruptDb(dbPath);
    db = new Database(dbPath, { create: true });
    applySchema(db);
  }
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
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    // A corrupt/foreign meta value (e.g. a bare-string activeRunId from an older
    // writer) is treated as absent rather than wedging all run resolution.
    return null;
  }
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
