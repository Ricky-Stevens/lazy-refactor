import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStateDb, stateDbPath } from "./findings-db.js";
import { closeAllConnections } from "./findings-store.js";

let dir;
afterEach(async () => {
  closeAllConnections();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("corrupt state.db self-recovery", () => {
  it("quarantines a non-SQLite file aside and opens a fresh, working db", async () => {
    dir = await mkdtemp(join(tmpdir(), "lazy-corrupt-"));
    const lr = join(dir, ".lazy-refactor");
    await mkdir(lr, { recursive: true });
    // A garbage (non-SQLite) file is exactly the post-crash / wrong-file scenario.
    await writeFile(join(lr, "state.db"), "this is definitely not a sqlite database");

    const db = getStateDb(dir);

    // The fresh db is usable: the schema applied and findings is queryable + empty.
    expect(db.query("SELECT COUNT(*) AS c FROM findings").get().c).toBe(0);

    // The corrupt bytes were preserved aside (non-destructive), not deleted.
    const files = await readdir(lr);
    expect(files.some((f) => f.startsWith("state.db.corrupt-"))).toBe(true);
  });
});

describe("schema-current-on-open (legacy DB upgrade)", () => {
  it("adds severity_overridden to a pre-0.8 findings table without losing data", async () => {
    dir = await mkdtemp(join(tmpdir(), "lazy-legacy-"));
    await mkdir(join(dir, ".lazy-refactor"), { recursive: true });

    // Hand-build a legacy (0.7.x) findings table — note: NO severity_overridden column.
    const legacy = new Database(stateDbPath(dir));
    legacy.exec(`CREATE TABLE findings (
      run_id TEXT NOT NULL, id TEXT NOT NULL, check_name TEXT, severity TEXT,
      category TEXT, status TEXT NOT NULL DEFAULT 'open', language TEXT, notes TEXT,
      data TEXT NOT NULL, PRIMARY KEY (run_id, id));`);
    legacy
      .query("INSERT INTO findings (run_id, id, severity, status, data) VALUES (?, ?, ?, ?, ?)")
      .run("r1", "f1", "low", "open", JSON.stringify({ severity: "low" }));
    legacy.close();

    // Opening through the real path must bring the schema current, not error out.
    const db = getStateDb(dir);
    const cols = db.query("PRAGMA table_info(findings)").all();
    expect(cols.some((c) => c.name === "severity_overridden")).toBe(true);

    // The pre-existing row survives and backfills to 0 (engine-assigned until overridden).
    const row = db
      .query("SELECT severity, severity_overridden FROM findings WHERE id = ?")
      .get("f1");
    expect(row.severity).toBe("low");
    expect(row.severity_overridden).toBe(0);
  });
});
