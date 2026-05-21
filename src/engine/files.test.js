import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_SOURCE_EXTENSIONS, collectFiles, LANGUAGE_EXTENSIONS } from "./files.js";

// ---------------------------------------------------------------------------
// LANGUAGE_EXTENSIONS
// ---------------------------------------------------------------------------

describe("LANGUAGE_EXTENSIONS", () => {
  test("has entries for all expected languages", () => {
    const expected = ["typescript", "javascript", "go", "python", "csharp", "java", "common"];
    for (const lang of expected) {
      expect(LANGUAGE_EXTENSIONS).toHaveProperty(lang);
      expect(Array.isArray(LANGUAGE_EXTENSIONS[lang])).toBe(true);
      expect(LANGUAGE_EXTENSIONS[lang].length).toBeGreaterThan(0);
    }
  });

  test("typescript includes .ts, .tsx, .js, .jsx", () => {
    expect(LANGUAGE_EXTENSIONS.typescript).toContain(".ts");
    expect(LANGUAGE_EXTENSIONS.typescript).toContain(".tsx");
    expect(LANGUAGE_EXTENSIONS.typescript).toContain(".js");
    expect(LANGUAGE_EXTENSIONS.typescript).toContain(".jsx");
  });

  test("go includes .go", () => {
    expect(LANGUAGE_EXTENSIONS.go).toContain(".go");
  });

  test("python includes .py", () => {
    expect(LANGUAGE_EXTENSIONS.python).toContain(".py");
  });

  test("csharp includes .cs", () => {
    expect(LANGUAGE_EXTENSIONS.csharp).toContain(".cs");
  });

  test("java includes .java", () => {
    expect(LANGUAGE_EXTENSIONS.java).toContain(".java");
  });

  test("common includes all language extensions", () => {
    const common = LANGUAGE_EXTENSIONS.common;
    expect(common).toContain(".ts");
    expect(common).toContain(".tsx");
    expect(common).toContain(".js");
    expect(common).toContain(".jsx");
    expect(common).toContain(".go");
    expect(common).toContain(".py");
    expect(common).toContain(".cs");
    expect(common).toContain(".java");
  });
});

// ---------------------------------------------------------------------------
// ALL_SOURCE_EXTENSIONS
// ---------------------------------------------------------------------------

describe("ALL_SOURCE_EXTENSIONS", () => {
  test("is a Set", () => {
    expect(ALL_SOURCE_EXTENSIONS).toBeInstanceOf(Set);
  });

  test("contains all expected extensions", () => {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".go", ".py", ".cs", ".java"]) {
      expect(ALL_SOURCE_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// collectFiles
// ---------------------------------------------------------------------------

describe("collectFiles", () => {
  let rootDir;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "files-test-"));
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  // -- basic behaviour -------------------------------------------------------

  describe("basic behaviour", () => {
    let dir;

    beforeAll(async () => {
      dir = join(rootDir, "basic");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "hello.ts"), "export const x = 1;");
      await writeFile(join(dir, "main.go"), "package main");
      await writeFile(join(dir, "app.py"), "print('hi')");
      await writeFile(join(dir, "Program.cs"), "class P {}");
      await writeFile(join(dir, "Main.java"), "class Main {}");
      await writeFile(join(dir, "notes.txt"), "just notes");
      await writeFile(join(dir, "image.png"), "not really a png");
    });

    test("returns only source files, not .txt or .png", async () => {
      const files = await collectFiles(dir);
      expect(files.length).toBe(5);
      const names = files.map((f) => f.split("/").pop()).sort();
      expect(names).toEqual(["Main.java", "Program.cs", "app.py", "hello.ts", "main.go"]);
    });

    test("no file has a non-source extension", async () => {
      const files = await collectFiles(dir);
      for (const f of files) {
        const ext = `.${f.split(".").pop()}`;
        expect(ALL_SOURCE_EXTENSIONS.has(ext)).toBe(true);
      }
    });
  });

  // -- language filter -------------------------------------------------------

  describe("language filter", () => {
    let dir;

    beforeAll(async () => {
      dir = join(rootDir, "lang-filter");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "a.ts"), "");
      await writeFile(join(dir, "b.tsx"), "");
      await writeFile(join(dir, "c.js"), "");
      await writeFile(join(dir, "d.jsx"), "");
      await writeFile(join(dir, "e.go"), "");
      await writeFile(join(dir, "f.py"), "");
    });

    test("languages: ['go'] returns only .go files", async () => {
      const files = await collectFiles(dir, { languages: ["go"] });
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.go$/);
    });

    test("languages: ['typescript'] returns .ts, .tsx, .js, .jsx", async () => {
      const files = await collectFiles(dir, { languages: ["typescript"] });
      expect(files.length).toBe(4);
      const exts = files.map((f) => `.${f.split(".").pop()}`).sort();
      expect(exts).toEqual([".js", ".jsx", ".ts", ".tsx"]);
    });

    test("languages: ['python'] returns only .py files", async () => {
      const files = await collectFiles(dir, { languages: ["python"] });
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.py$/);
    });
  });

  // -- SKIP_DIRS -------------------------------------------------------------

  describe("SKIP_DIRS", () => {
    let dir;

    beforeAll(async () => {
      dir = join(rootDir, "skip-dirs");
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "app.ts"), "export default 1;");
      // Create files inside each skip directory
      for (const skipDir of ["node_modules", ".git", "vendor", "dist", "build", "__pycache__"]) {
        await mkdir(join(dir, skipDir), { recursive: true });
      }
      await writeFile(join(dir, "node_modules", "dep.js"), "module.exports = 1;");
      await writeFile(join(dir, ".git", "objects.js"), "");
      await writeFile(join(dir, "vendor", "lib.go"), "package vendor");
      await writeFile(join(dir, "dist", "bundle.js"), "");
      await writeFile(join(dir, "build", "output.js"), "");
      await writeFile(join(dir, "__pycache__", "cache.py"), "");
    });

    test("only returns src/app.ts, all SKIP_DIRS are skipped", async () => {
      const files = await collectFiles(dir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/src\/app\.ts$/);
    });
  });

  // -- exclude patterns ------------------------------------------------------

  describe("exclude patterns", () => {
    let dir;

    beforeAll(async () => {
      dir = join(rootDir, "exclude");
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "app.ts"), "export const x = 1;");
      await writeFile(join(dir, "src", "app.test.ts"), "test()");
      await writeFile(join(dir, "src", "utils.spec.ts"), "spec()");
    });

    test("exclude test and spec files", async () => {
      const files = await collectFiles(dir, { exclude: ["**/*.test.*", "**/*.spec.*"] });
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/src\/app\.ts$/);
    });
  });

  // -- brace expansion in exclude --------------------------------------------

  describe("brace expansion in exclude", () => {
    let dir;

    beforeAll(async () => {
      dir = join(rootDir, "brace");
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "hello.ts"), "");
      await writeFile(join(dir, "src", "hello.tsx"), "");
      await writeFile(join(dir, "src", "hello.go"), "");
    });

    test("exclude {ts,tsx} with brace expansion", async () => {
      const files = await collectFiles(dir, { exclude: ["**/*.{ts,tsx}"] });
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.go$/);
    });
  });

  // -- recursive traversal ---------------------------------------------------

  describe("recursive traversal", () => {
    let dir;

    beforeAll(async () => {
      dir = join(rootDir, "recursive");
      await mkdir(join(dir, "a", "b", "c"), { recursive: true });
      await writeFile(join(dir, "a", "b", "c", "deep.ts"), "export const deep = true;");
    });

    test("finds deeply nested files", async () => {
      const files = await collectFiles(dir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/a\/b\/c\/deep\.ts$/);
    });
  });

  // -- empty directory -------------------------------------------------------

  describe("empty directory", () => {
    let dir;

    beforeAll(async () => {
      dir = join(rootDir, "empty");
      await mkdir(dir, { recursive: true });
    });

    test("returns empty array", async () => {
      const files = await collectFiles(dir);
      expect(files).toEqual([]);
    });
  });

  // -- unreadable directory --------------------------------------------------

  describe("unreadable directory", () => {
    test("returns empty array for non-existent directory", async () => {
      const files = await collectFiles(join(rootDir, "does-not-exist"));
      expect(files).toEqual([]);
    });
  });

  // -- symlinks --------------------------------------------------------------

  describe("symlinks", () => {
    let dir;

    beforeAll(async () => {
      dir = join(rootDir, "symlinks");
      await mkdir(join(dir, "real"), { recursive: true });
      await mkdir(join(dir, "links"), { recursive: true });
      await writeFile(join(dir, "real", "target.ts"), "export const s = 1;");

      // File symlink pointing to real/target.ts
      try {
        await symlink(join(dir, "real", "target.ts"), join(dir, "links", "linked.ts"));
      } catch {
        // Symlinks may not be supported; tests using this will handle it
      }

      // Directory symlink pointing to real/
      try {
        await symlink(join(dir, "real"), join(dir, "links", "real-dir"));
      } catch {
        // Symlinks may not be supported
      }
    });

    test("follows file symlinks", async () => {
      const files = await collectFiles(join(dir, "links"));
      const names = files.map((f) => f.split("/").pop());
      // linked.ts should appear (it's a symlink to a regular file)
      expect(names).toContain("linked.ts");
    });

    test("does not follow directory symlinks", async () => {
      const files = await collectFiles(join(dir, "links"));
      // If directory symlinks were followed, we'd see target.ts from real-dir/
      // We should only see linked.ts, not real-dir/target.ts
      const fromDirLink = files.filter((f) => f.includes("real-dir"));
      expect(fromDirLink.length).toBe(0);
    });
  });

  // -- glob patterns via collectFiles exclude (indirect test of globToExcludeRegex) ---

  describe("glob patterns", () => {
    let dir;

    beforeAll(async () => {
      dir = join(rootDir, "glob");
      await mkdir(join(dir, "src"), { recursive: true });
      await mkdir(join(dir, "src", "vendor"), { recursive: true });
      await mkdir(join(dir, "src", "__tests__"), { recursive: true });
      await writeFile(join(dir, "src", "main.ts"), "");
      await writeFile(join(dir, "src", "main.test.ts"), "");
      await writeFile(join(dir, "src", "__tests__", "suite.ts"), "");
      // Note: src/vendor is NOT in SKIP_DIRS (only top-level vendor is),
      // so we test via exclude pattern
      await writeFile(join(dir, "src", "vendor", "lib.ts"), "");
    });

    test("**/vendor/** pattern excludes nested vendor dirs", async () => {
      const files = await collectFiles(dir, { exclude: ["**/vendor/**"] });
      const names = files.map((f) => f.split("/").pop());
      expect(names).not.toContain("lib.ts");
      expect(names).toContain("main.ts");
    });

    test("*.test.* pattern excludes test files", async () => {
      const files = await collectFiles(dir, { exclude: ["*.test.*"] });
      const names = files.map((f) => f.split("/").pop());
      expect(names).not.toContain("main.test.ts");
      expect(names).toContain("main.ts");
    });

    test("**/__tests__/** pattern excludes __tests__ directories", async () => {
      const files = await collectFiles(dir, { exclude: ["**/__tests__/**"] });
      const names = files.map((f) => f.split("/").pop());
      expect(names).not.toContain("suite.ts");
      expect(names).toContain("main.ts");
    });
  });
});
