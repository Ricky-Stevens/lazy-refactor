import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFileCache, collectFiles, SKIP_DIRS } from "./files.js";

// Generated coverage/build-output dirs are not first-party source. They were
// previously scanned unless .gitignored, producing duplication/metrics noise in
// generated bundles (the coverage-merged/ leakage in the v0.11 run).
describe("collectFiles skips generated coverage/output dirs", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "skipdirs-test-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "coverage"), { recursive: true });
    await mkdir(join(dir, "out"), { recursive: true });
    await mkdir(join(dir, ".nyc_output"), { recursive: true });
    await writeFile(join(dir, "src", "keep.ts"), "export const a = 1;");
    await writeFile(join(dir, "coverage", "gen.ts"), "export const b = 2;");
    await writeFile(join(dir, "out", "built.ts"), "export const c = 3;");
    await writeFile(join(dir, ".nyc_output", "cov.ts"), "export const d = 4;");
    clearFileCache();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("includes real source but not coverage/out/.nyc_output", async () => {
    const files = await collectFiles(dir, { respectGitignore: false });
    expect(files.some((f) => f.endsWith("src/keep.ts"))).toBe(true);
    expect(files.some((f) => f.includes("/coverage/"))).toBe(false);
    expect(files.some((f) => f.includes("/out/"))).toBe(false);
    expect(files.some((f) => f.includes("/.nyc_output/"))).toBe(false);
  });

  it("SKIP_DIRS is the shared canonical set including the generated dirs", () => {
    for (const d of ["coverage", "out", ".nyc_output", ".turbo", ".cache"]) {
      expect(SKIP_DIRS.has(d)).toBe(true);
    }
  });
});
