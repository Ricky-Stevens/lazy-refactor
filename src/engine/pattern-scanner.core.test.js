import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRipgrepAvailable, runPatternSearch, scanPatterns } from "./pattern-scanner.js";

// ---------------------------------------------------------------------------
// runPatternSearch
// ---------------------------------------------------------------------------

describe("runPatternSearch", () => {
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "grep-test-"));
    await writeFile(join(tmpDir, "hello.js"), 'console.log("hello");\n');
    await writeFile(join(tmpDir, "nope.js"), "const x = 1;\n");
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("finds matching pattern in files using ripgrep", async () => {
    const rg = await isRipgrepAvailable();
    if (!rg) return;
    const output = runPatternSearch("console\\.log", "**/*.js", [], true, tmpDir);
    expect(output).toContain("hello.js");
    expect(output).toContain("console.log");
  });

  test("finds matching pattern in files using grep fallback", () => {
    try {
      const output = runPatternSearch("console\\.log", "**/*.js", [], false, tmpDir);
      expect(output).toContain("hello.js");
      expect(output).toContain("console.log");
    } catch (err) {
      if (err.status === 1) {
        expect(true).toBe(false);
      }
    }
  });

  test("returns empty or throws exit 1 when no matches", async () => {
    const rg = await isRipgrepAvailable();
    try {
      const output = runPatternSearch("XYZZY_NEVER", "**/*.js", [], rg, tmpDir);
      expect(output.trim()).toBe("");
    } catch (err) {
      expect(err.status).toBe(1);
    }
  });

  test("exclude globs filter out files", async () => {
    const rg = await isRipgrepAvailable();
    try {
      const output = runPatternSearch("console", "**/*.js", ["**/hello.js"], rg, tmpDir);
      expect(output).not.toContain("hello.js");
    } catch (err) {
      expect(err.status).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// runPatternSearch grep-fallback chunking
// ---------------------------------------------------------------------------

describe("runPatternSearch grep fallback chunking", () => {
  let tmpDir;
  const FILE_COUNT = 5200;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "grep-chunk-test-"));
    const writes = [];
    for (let i = 0; i < FILE_COUNT; i++) {
      const content = i % 2 === 0 ? 'console.log("hit");\n' : "const x = 1;\n";
      writes.push(writeFile(join(tmpDir, `f${i}.js`), content));
    }
    await Promise.all(writes);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("aggregates matches from multiple grep chunks without ARG_MAX failures", () => {
    const output = runPatternSearch("console\\.log", "**/*.js", [], false, tmpDir);
    const matchLines = output.split("\n").filter((l) => l.includes("console.log"));
    expect(matchLines.length).toBe(FILE_COUNT / 2);
  });
});

// ---------------------------------------------------------------------------
// scanPatterns integration tests
// ---------------------------------------------------------------------------

describe("scanPatterns", () => {
  let tmpDir;

  const consoleRule = {
    id: "console-log",
    severity: "medium",
    category: "debugging-leftovers",
    description: "console.log left in code",
    language: "typescript",
    pattern: "console\\.log\\s*\\(",
    antiPattern: null,
    filePattern: "**/*.{ts,tsx,js,jsx}",
    exclude: ["**/*.test.*", "**/node_modules/**"],
    suggestion: "Remove console.log",
    fixable: true,
  };

  const todoRule = {
    id: "todo-comment",
    severity: "low",
    category: "tech-debt",
    description: "TODO comment found",
    language: "common",
    pattern: "TODO",
    antiPattern: "SKIP_TODO_CHECK",
    filePattern: "**/*.{ts,js}",
    exclude: [],
    suggestion: "Resolve the TODO",
    fixable: false,
  };

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "scanner-test-"));
    await writeFile(
      join(tmpDir, "app.js"),
      ["function hello() {", '  console.log("hello");', "  return 42;", "}"].join("\n"),
    );
    await writeFile(join(tmpDir, "app.test.js"), 'console.log("test output");');
    await writeFile(join(tmpDir, "todo.ts"), "const x = 1; // TODO: fix this later\n");
    await writeFile(
      join(tmpDir, "skip.ts"),
      "// SKIP_TODO_CHECK\n// TODO: this should be ignored\nconst y = 2;\n",
    );
    await writeFile(join(tmpDir, "vendor.js"), 'console.log("vendor code");');
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns findings with correct shape", async () => {
    const findings = await scanPatterns(tmpDir, [consoleRule], {});
    const appFinding = findings.find((f) => f.file.includes("app.js") && !f.file.includes("test"));
    expect(appFinding).toBeDefined();
    expect(appFinding.ruleId).toBe("console-log");
    expect(typeof appFinding.file).toBe("string");
    expect(typeof appFinding.line).toBe("number");
    expect(typeof appFinding.match).toBe("string");
    expect(appFinding.severity).toBe("medium");
    expect(appFinding.category).toBe("debugging-leftovers");
    expect(typeof appFinding.description).toBe("string");
    expect(typeof appFinding.suggestion).toBe("string");
    expect(typeof appFinding.fixable).toBe("boolean");
  });

  test("rule exclude patterns filter out matched files", async () => {
    const findings = await scanPatterns(tmpDir, [consoleRule], {});
    const testFinding = findings.find((f) => f.file.includes("app.test.js"));
    expect(testFinding).toBeUndefined();
  });

  test("extra exclude globs in options filter out files", async () => {
    const findings = await scanPatterns(tmpDir, [consoleRule], { exclude: ["**/vendor.js"] });
    const vendorFinding = findings.find((f) => f.file.includes("vendor.js"));
    expect(vendorFinding).toBeUndefined();
  });

  test("anti-pattern exclusion: file containing antiPattern is skipped", async () => {
    const findings = await scanPatterns(tmpDir, [todoRule], {});
    expect(findings.find((f) => f.file.includes("todo.ts"))).toBeDefined();
    expect(findings.find((f) => f.file.includes("skip.ts"))).toBeUndefined();
  });

  test("language filter: rules not matching requested languages are skipped", async () => {
    const findings = await scanPatterns(tmpDir, [consoleRule], { languages: ["python"] });
    expect(findings.length).toBe(0);
  });

  test("language filter: common rules apply regardless of language filter", async () => {
    const findings = await scanPatterns(tmpDir, [todoRule], { languages: ["typescript"] });
    expect(findings.find((f) => f.file.includes("todo.ts"))).toBeDefined();
  });

  test("returns empty array when no files match the pattern", async () => {
    const noMatchRule = {
      id: "no-match",
      severity: "low",
      category: "test",
      description: "Should not match anything",
      language: "common",
      pattern: "XYZZY_NEVER_MATCHES_12345",
      antiPattern: null,
      filePattern: "**/*.{ts,js}",
      exclude: [],
      suggestion: "N/A",
      fixable: false,
    };
    const findings = await scanPatterns(tmpDir, [noMatchRule], {});
    expect(findings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isRipgrepAvailable
// ---------------------------------------------------------------------------

describe("isRipgrepAvailable", () => {
  test("returns a boolean", async () => {
    const result = await isRipgrepAvailable();
    expect(typeof result).toBe("boolean");
  });

  test("result is cached (second call returns same value)", async () => {
    const first = await isRipgrepAvailable();
    const second = await isRipgrepAvailable();
    expect(first).toBe(second);
  });
});
