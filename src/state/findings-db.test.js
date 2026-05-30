import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStateDb } from "./findings-db.js";
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
