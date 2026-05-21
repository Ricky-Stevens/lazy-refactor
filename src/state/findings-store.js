/**
 * Low-level I/O and advisory locking for findings state.
 *
 * Handles lock acquisition/release, disk reads, and atomic writes.
 * No business logic lives here — see findings.js for that.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DIR_NAME = ".lazy-refactor";
const FILE_NAME = "findings.json";
const LOCK_FILE = "findings.lock";
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;

function findingsPath(projectPath) {
  return join(projectPath, DIR_NAME, FILE_NAME);
}

function lockPath(projectPath) {
  return join(projectPath, DIR_NAME, LOCK_FILE);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Attempt to remove a stale lock file. Errors are silenced — a concurrent
// process may have already cleaned it up, which is fine.
async function tryRemoveStaleLock(lock) {
  try {
    const pid = Number.parseInt(await readFile(lock, "utf8"), 10);
    if (pid && !isProcessRunning(pid)) {
      try {
        await unlink(lock);
      } catch {
        // Another process may have already cleaned it
      }
    }
  } catch {
    // Lock file disappeared between check and read — retry will handle it
  }
}

/**
 * Acquire an advisory file lock. Retries until timeout.
 *
 * @param {string} projectPath
 * @returns {Promise<void>}
 */
export async function acquireLock(projectPath) {
  const lock = lockPath(projectPath);
  const dir = join(projectPath, DIR_NAME);
  await mkdir(dir, { recursive: true });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await tryRemoveStaleLock(lock);
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  throw new Error("Timed out acquiring findings lock");
}

/**
 * Release the advisory file lock.
 *
 * @param {string} projectPath
 * @returns {Promise<void>}
 */
export async function releaseLock(projectPath) {
  try {
    await unlink(lockPath(projectPath));
  } catch {
    // Already gone — fine
  }
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
      return {
        scanId: null,
        path: null,
        findings: [],
        summary: {
          totalFindings: 0,
          bySeverity: {},
          byCategory: {},
          byStatus: {},
        },
      };
    }
    throw err;
  }
}

/**
 * Write state to findings.json, creating the .lazy-refactor/ dir if needed.
 * Uses an atomic rename via a per-process temp file.
 *
 * @param {string} projectPath
 * @param {object} state
 * @returns {Promise<void>}
 */
export async function saveFindings(projectPath, state) {
  const dir = join(projectPath, DIR_NAME);
  await mkdir(dir, { recursive: true });
  const target = findingsPath(projectPath);
  const tmp = `${target}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, target);
}
