/**
 * Tests for the user-curated ignore list (src/engine/ignore-list.js) and its
 * integration with collectFiles via the exclude pipeline.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFileCache, collectFiles, countMatchingFiles } from "./files.js";
import { expandIgnorePatterns, normalizeIgnoreEntry } from "./ignore-list.js";

describe("normalizeIgnoreEntry", () => {
  it("trims and strips a leading ./ and trailing /", () => {
    expect(normalizeIgnoreEntry("  ./scripts/seed/  ")).toBe("scripts/seed");
  });

  it("returns '' for blanks, comments, and bare dot", () => {
    expect(normalizeIgnoreEntry("")).toBe("");
    expect(normalizeIgnoreEntry("   ")).toBe("");
    expect(normalizeIgnoreEntry("# a comment")).toBe("");
    expect(normalizeIgnoreEntry(".")).toBe("");
    expect(normalizeIgnoreEntry("./")).toBe("");
  });

  it("returns '' for non-strings", () => {
    expect(normalizeIgnoreEntry(null)).toBe("");
    expect(normalizeIgnoreEntry(42)).toBe("");
  });
});

describe("expandIgnorePatterns", () => {
  it("expands a plain path to the literal AND its directory contents", () => {
    expect(expandIgnorePatterns(["scripts/seed"])).toEqual(["scripts/seed", "scripts/seed/**"]);
  });

  it("expands a bare filename the same way (matched by basename or as a dir)", () => {
    expect(expandIgnorePatterns(["seed.ts"])).toEqual(["seed.ts", "seed.ts/**"]);
  });

  it("passes glob entries through unchanged (no /** expansion)", () => {
    expect(expandIgnorePatterns(["scripts/*.seed.js"])).toEqual(["scripts/*.seed.js"]);
    expect(expandIgnorePatterns(["**/fixtures/**"])).toEqual(["**/fixtures/**"]);
  });

  it("normalizes and de-duplicates entries", () => {
    expect(expandIgnorePatterns(["./scripts/seed/", "scripts/seed", "  "])).toEqual([
      "scripts/seed",
      "scripts/seed/**",
    ]);
  });

  it("returns [] for a non-array", () => {
    expect(expandIgnorePatterns(undefined)).toEqual([]);
    expect(expandIgnorePatterns(null)).toEqual([]);
  });
});

describe("collectFiles honours expanded ignore patterns", () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lazy-refactor-ignore-"));
    clearFileCache();
  });

  afterEach(async () => {
    clearFileCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("excludes a flagged directory and a flagged file, keeps the rest", async () => {
    await mkdir(join(dir, "scripts", "seed"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "scripts", "seed", "data.ts"), "export const x = 1;\n");
    await writeFile(join(dir, "scripts", "deploy.ts"), "export const y = 2;\n");
    await writeFile(join(dir, "src", "app.ts"), "export const z = 3;\n");

    const exclude = expandIgnorePatterns(["scripts/seed", "scripts/deploy.ts"]);
    const files = await collectFiles(dir, { exclude, respectGitignore: false });
    const rel = files.map((f) => f.slice(dir.length + 1)).sort();

    expect(rel).toEqual(["src/app.ts"]);
  });

  it("a bare filename excludes that file anywhere in the tree", async () => {
    await mkdir(join(dir, "a"), { recursive: true });
    await mkdir(join(dir, "b"), { recursive: true });
    await writeFile(join(dir, "a", "seed.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "b", "seed.ts"), "export const b = 2;\n");
    await writeFile(join(dir, "a", "keep.ts"), "export const k = 3;\n");

    const exclude = expandIgnorePatterns(["seed.ts"]);
    const files = await collectFiles(dir, { exclude, respectGitignore: false });
    const rel = files.map((f) => f.slice(dir.length + 1)).sort();

    expect(rel).toEqual(["a/keep.ts"]);
  });
});

describe("countMatchingFiles", () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lazy-refactor-count-"));
    clearFileCache();
  });

  afterEach(async () => {
    clearFileCache();
    await rm(dir, { recursive: true, force: true });
  });

  it("counts how many collected files a flagged directory + file would suppress", async () => {
    await mkdir(join(dir, "scripts", "seed"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "scripts", "seed", "a.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "scripts", "seed", "b.ts"), "export const b = 2;\n");
    await writeFile(join(dir, "scripts", "deploy.ts"), "export const d = 3;\n");
    await writeFile(join(dir, "src", "app.ts"), "export const z = 4;\n");

    // Walk WITHOUT the ignore list (the base set the scan would otherwise see).
    const baseFiles = await collectFiles(dir, { respectGitignore: false });
    expect(baseFiles.length).toBe(4);

    const patterns = expandIgnorePatterns(["scripts/seed", "scripts/deploy.ts"]);
    // 2 files under scripts/seed + 1 deploy.ts = 3 suppressed.
    expect(countMatchingFiles(baseFiles, dir, patterns)).toBe(3);
  });

  it("returns 0 for empty patterns", () => {
    expect(countMatchingFiles(["/x/a.ts"], "/x", [])).toBe(0);
  });
});
