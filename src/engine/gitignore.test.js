import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFileCache, collectFiles } from "./files.js";
import { clearGitignoreConfig, configureGitignore } from "./gitignore.js";

function gitInit(dir) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
}

const rel = (dir, files) => files.map((f) => f.slice(dir.length + 1)).sort();

describe("collectFiles respects .gitignore", () => {
  let dir;

  afterEach(async () => {
    clearFileCache();
    clearGitignoreConfig();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("drops gitignored dirs + patterns, honors negation, keeps real source", async () => {
    dir = await mkdtemp(join(tmpdir(), "gi-on-"));
    gitInit(dir);
    // `reports/*` + `!reports/keep.js` is git's canonical "ignore all but one":
    // the directory itself isn't excluded, so the negation can re-include a file.
    await writeFile(
      join(dir, ".gitignore"),
      "coverage-merged/\n*.min.js\nreports/*\n!reports/keep.js\n",
    );
    await writeFile(join(dir, "app.ts"), "export const a = 1;");
    await writeFile(join(dir, "worker.min.js"), "var y;");
    await mkdir(join(dir, "coverage-merged"), { recursive: true });
    await writeFile(join(dir, "coverage-merged", "report.js"), "var x;");
    await mkdir(join(dir, "reports"), { recursive: true });
    await writeFile(join(dir, "reports", "out.js"), "var z;");
    await writeFile(join(dir, "reports", "keep.js"), "var kept;");

    const files = rel(dir, await collectFiles(dir));
    expect(files).toContain("app.ts");
    expect(files).toContain("reports/keep.js"); // negated re-include
    expect(files).not.toContain("worker.min.js");
    expect(files).not.toContain("coverage-merged/report.js");
    expect(files).not.toContain("reports/out.js");
  });

  test("config opt-out via configureGitignore(root, false) keeps ignored files", async () => {
    dir = await mkdtemp(join(tmpdir(), "gi-cfg-"));
    gitInit(dir);
    await writeFile(join(dir, ".gitignore"), "*.min.js\n");
    await writeFile(join(dir, "app.ts"), "1");
    await writeFile(join(dir, "vendor.min.js"), "2");

    // The production opt-out: set the module-map switch, NOT the per-call option.
    // collectFiles is then called with respectGitignore defaulting to true, proving
    // the config switch alone disables filtering.
    configureGitignore(dir, false);
    const files = rel(dir, await collectFiles(dir));
    expect(files).toContain("vendor.min.js");
    expect(files).toContain("app.ts");
  });

  test("keeps everything when the repo ignores nothing relevant (check-ignore exits 1)", async () => {
    dir = await mkdtemp(join(tmpdir(), "gi-none-"));
    gitInit(dir);
    await writeFile(join(dir, ".gitignore"), "*.log\n"); // matches no source file
    await writeFile(join(dir, "app.ts"), "1");
    await writeFile(join(dir, "util.ts"), "2");

    // No input path is ignored, so `git check-ignore` exits status 1 — the branch
    // that must be read as "keep everything", not as an error.
    const files = rel(dir, await collectFiles(dir));
    expect(files).toEqual(["app.ts", "util.ts"]);
  });

  test("respectGitignore:false keeps files git would ignore", async () => {
    dir = await mkdtemp(join(tmpdir(), "gi-off-"));
    gitInit(dir);
    await writeFile(join(dir, ".gitignore"), "*.min.js\n");
    await writeFile(join(dir, "app.ts"), "1");
    await writeFile(join(dir, "vendor.min.js"), "2");

    const files = rel(dir, await collectFiles(dir, { respectGitignore: false }));
    expect(files).toContain("vendor.min.js");
    expect(files).toContain("app.ts");
  });

  test("no-ops in a non-git directory (a .gitignore alone means nothing)", async () => {
    dir = await mkdtemp(join(tmpdir(), "gi-nogit-"));
    await writeFile(join(dir, ".gitignore"), "*.min.js\n");
    await writeFile(join(dir, "app.ts"), "1");
    await writeFile(join(dir, "vendor.min.js"), "2");

    const files = rel(dir, await collectFiles(dir));
    expect(files).toContain("vendor.min.js");
    expect(files).toContain("app.ts");
  });
});
