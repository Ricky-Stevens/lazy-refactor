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
    if (!rg) return; // skip if rg not installed
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
        // no match — unexpected but grep is present
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
// runPatternSearch grep-fallback chunking: ensure large file sets don't blow ARG_MAX
// and that matches across multiple chunks are aggregated into the returned output.
// ---------------------------------------------------------------------------
describe("runPatternSearch grep fallback chunking", () => {
  let tmpDir;
  const FILE_COUNT = 5200; // > CHUNK_SIZE (5000) so we exercise multiple grep calls

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "grep-chunk-test-"));
    // Half the files contain a match, half do not — across the chunk boundary.
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
    // We wrote FILE_COUNT/2 matching files. Expect roughly that many match lines.
    expect(matchLines.length).toBe(FILE_COUNT / 2);
  });
});

// ---------------------------------------------------------------------------
// scanPatterns — integration tests with temp directory
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
    const findings = await scanPatterns(tmpDir, [consoleRule], {
      exclude: ["**/vendor.js"],
    });
    const vendorFinding = findings.find((f) => f.file.includes("vendor.js"));
    expect(vendorFinding).toBeUndefined();
  });

  test("anti-pattern exclusion: file containing antiPattern is skipped", async () => {
    const findings = await scanPatterns(tmpDir, [todoRule], {});
    const todoFinding = findings.find((f) => f.file.includes("todo.ts"));
    expect(todoFinding).toBeDefined();
    const skipFinding = findings.find((f) => f.file.includes("skip.ts"));
    expect(skipFinding).toBeUndefined();
  });

  test("language filter: rules not matching requested languages are skipped", async () => {
    const findings = await scanPatterns(tmpDir, [consoleRule], {
      languages: ["python"],
    });
    expect(findings.length).toBe(0);
  });

  test("language filter: common rules apply regardless of language filter", async () => {
    const findings = await scanPatterns(tmpDir, [todoRule], {
      languages: ["typescript"],
    });
    const todoFinding = findings.find((f) => f.file.includes("todo.ts"));
    expect(todoFinding).toBeDefined();
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
// Behavioural tests for rewritten/added rules — verify each rule matches its
// intended target and (where applicable) is suppressed by its antiPattern.
// ---------------------------------------------------------------------------
describe("rule behaviour: rewritten and added rules", () => {
  let tmpDir;

  // Hoist the imports — done at module level via dynamic import inside beforeAll
  // would be awkward, so use static imports below.

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "rule-behaviour-"));

    // TS: empty one-line catch (should match empty-catch-ts)
    await writeFile(join(tmpDir, "empty-catch.ts"), "try { foo(); } catch (e) {}\n");

    // TS: async useEffect (should match async-useeffect-ts)
    await writeFile(
      join(tmpDir, "async-effect.tsx"),
      "useEffect(async () => { await fetch('/x'); }, []);\n",
    );

    // TS: dangerouslySetInnerHTML — once with sanitizer (suppressed), once without
    await writeFile(
      join(tmpDir, "xss-bad.tsx"),
      "<div dangerouslySetInnerHTML={{ __html: html }} />\n",
    );
    await writeFile(
      join(tmpDir, "xss-good.tsx"),
      [
        "import DOMPurify from 'dompurify';",
        "<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />",
      ].join("\n"),
    );

    // Python: bare except (should match), wildcard import, mutable default arg
    await writeFile(join(tmpDir, "bare.py"), "try:\n    x = 1\nexcept:\n    pass\n");
    await writeFile(join(tmpDir, "wildcard.py"), "from os import *\n");
    await writeFile(join(tmpDir, "mutable.py"), "def foo(items=[]):\n    return items\n");

    // Python: open() without context manager — bad file has open(), good file has `with open(`
    await writeFile(join(tmpDir, "open-bad.py"), "f = open('x.txt')\n");
    await writeFile(join(tmpDir, "open-good.py"), "with open('x.txt') as f:\n    pass\n");

    // Go: discarded error in single-return form (on its own line so `^\s*_` matches)
    await writeFile(join(tmpDir, "discard.go"), "package x\nfunc f() {\n    _ = doThing()\n}\n");
    // Go: range loop — should NOT trigger discarded-error (antiPattern excludes range)
    await writeFile(
      join(tmpDir, "range.go"),
      "package x\nfunc f() {\n    for _, v := range items {\n        _ = v\n    }\n}\n",
    );
    // Go: SQL string concat (should match sql-string-concat-go)
    await writeFile(
      join(tmpDir, "sql.go"),
      'package x\nfunc q(id string) string { return fmt.Sprintf("SELECT * FROM users WHERE id=%s", id) }\n',
    );

    // Java: broad catch
    await writeFile(
      join(tmpDir, "Broad.java"),
      "class X { void f() { try {} catch (Exception e) {} } }\n",
    );

    // C#: sync-over-async
    await writeFile(join(tmpDir, "Sync.cs"), "class X { void F() { var r = task.Result; } }\n");

    // Common: hardcoded secret — bad has real-looking key, good is placeholder
    await writeFile(join(tmpDir, "secret-bad.js"), 'const api_key = "sk_live_abc123def456";\n');
    await writeFile(
      join(tmpDir, "secret-placeholder.js"),
      'const api_key = "your-api-key-here";\n',
    );

    // TS: promise chain with callback containing parentheses (should match promise-no-catch-ts)
    await writeFile(join(tmpDir, "promise-paren.ts"), "fetch('/api').then(res => process(res));\n");

    // Common: ai-step-comment with capital S (should match ai-step-comment)
    await writeFile(
      join(tmpDir, "step-cap.js"),
      "// Step 1: initialize the config\nconst x = 1;\n",
    );

    // Common: hardcoded-secret with Go camelCase apiKey (should match hardcoded-secret)
    await writeFile(
      join(tmpDir, "secret-go.go"),
      'package x\nvar apiKey = "sk_live_abc123def456"\n',
    );

    // Python: percent format with single quotes (should match percent-string-format-py)
    await writeFile(join(tmpDir, "pctfmt.py"), "x = '%s is %d' % (name, age)\n");

    // Python: str.format with single quotes (should match str-format-method-py)
    await writeFile(join(tmpDir, "strfmt.py"), "x = '{} is {}'.format(name, age)\n");

    // Go: SQL string concatenation (should match sql-string-concat-go)
    await writeFile(
      join(tmpDir, "sql-concat.go"),
      'package x\nfunc q(id string) string { return "SELECT * FROM users WHERE id=" + id }\n',
    );

    // Go: goroutine with named function (should match goroutine-no-context-go)
    await writeFile(
      join(tmpDir, "goroutine-named.go"),
      "package x\nfunc f() {\n    go handleRequest(conn)\n}\n",
    );

    // Fix 1: hardcoded-secret case-insensitive — SCREAMING_CASE key names
    await writeFile(
      join(tmpDir, "secret-screaming.js"),
      'const API_KEY = "sk_live_abc123def456";\n',
    );
    await writeFile(
      join(tmpDir, "secret-openai.js"),
      'const OPENAI_API_KEY = "sk_live_abc123def456";\n',
    );

    // Fix 2: SQL string concatenation in TS
    await writeFile(
      join(tmpDir, "sql-concat.ts"),
      'const q = "SELECT * FROM users WHERE id=" + userId;\n',
    );
    await writeFile(
      join(tmpDir, "sql-template.ts"),
      "const q = `SELECT * FROM users WHERE id=${userId}`;\n",
    );
    await writeFile(
      join(tmpDir, "sql-safe.ts"),
      '// parameterized\nconst q = "SELECT * FROM users WHERE id=$1";\n',
    );

    // Fix 3: any-type in non-first generic param
    await writeFile(join(tmpDir, "any-generic.ts"), "const m: Map<string, any> = new Map();\n");

    // Fix 4: Vector raw type without generics
    await writeFile(join(tmpDir, "VectorRaw.java"), "class X { Vector items = new Vector(); }\n");
    await writeFile(
      join(tmpDir, "HashtableRaw.java"),
      "class X { Hashtable map = new Hashtable(); }\n",
    );

    // Fix 5: eval/new Function usage
    await writeFile(join(tmpDir, "eval-bad.js"), 'const result = eval("1 + 2");\n');
    await writeFile(
      join(tmpDir, "new-function.js"),
      'const fn = new Function("a", "b", "return a + b");\n',
    );

    // Fix 8: magic-number with ML antiPattern terms (should be suppressed)
    await writeFile(join(tmpDir, "magic-ml.py"), "batch = 256  # batch size for training\n");
    await writeFile(join(tmpDir, "magic-seed.py"), "seed = 42  # SEED for reproducibility\n");

    // Fix 9: factory method try-with-resources
    await writeFile(
      join(tmpDir, "FactoryMethod.java"),
      "class X { void f() { Connection c = ds.getConnection(); } }\n",
    );

    // Fix 10: expanded C# disposable types
    await writeFile(
      join(tmpDir, "TcpClient.cs"),
      "class X { void F() { var c = new TcpClient(); } }\n",
    );
    await writeFile(
      join(tmpDir, "Process.cs"),
      "class X { void F() { var p = new Process(); } }\n",
    );
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("empty-catch-ts matches empty one-line catch", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "empty-catch-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("empty-catch.ts"))).toBe(true);
  });

  test("async-useeffect-ts matches useEffect(async ...)", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "async-useeffect-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("async-effect.tsx"))).toBe(true);
  });

  test("dangerously-set-inner-html-ts: flagged without sanitizer, suppressed with one", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "dangerously-set-inner-html-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("xss-bad.tsx"))).toBe(true);
    expect(findings.some((f) => f.file.includes("xss-good.tsx"))).toBe(false);
  });

  test("bare-except-py matches bare except clause", async () => {
    const { default: pyRules } = await import("../rules/python.js");
    const rule = pyRules.find((r) => r.id === "bare-except-py");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("bare.py"))).toBe(true);
  });

  test("wildcard-import-py matches `from x import *`", async () => {
    const { default: pyRules } = await import("../rules/python.js");
    const rule = pyRules.find((r) => r.id === "wildcard-import-py");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("wildcard.py"))).toBe(true);
  });

  test("mutable-default-arg-py matches `def f(x=[])`", async () => {
    const { default: pyRules } = await import("../rules/python.js");
    const rule = pyRules.find((r) => r.id === "mutable-default-arg-py");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("mutable.py"))).toBe(true);
  });

  test("open-without-context-manager-py: flagged when no `with open(`, suppressed when present", async () => {
    const { default: pyRules } = await import("../rules/python.js");
    const rule = pyRules.find((r) => r.id === "open-without-context-manager-py");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("open-bad.py"))).toBe(true);
    expect(findings.some((f) => f.file.includes("open-good.py"))).toBe(false);
  });

  test("discarded-error-go: matches `_ = call()` but not range loops", async () => {
    const { default: goRules } = await import("../rules/go.js");
    const rule = goRules.find((r) => r.id === "discarded-error-go");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("discard.go"))).toBe(true);
    // range.go contains `for _, v := range` which the antiPattern should suppress.
    expect(findings.some((f) => f.file.includes("range.go"))).toBe(false);
  });

  test("sql-string-concat-go matches fmt.Sprintf with SQL keyword", async () => {
    const { default: goRules } = await import("../rules/go.js");
    const rule = goRules.find((r) => r.id === "sql-string-concat-go");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("sql.go"))).toBe(true);
  });

  test("catch-broad-exception-java matches `catch (Exception e)`", async () => {
    const { default: javaRules } = await import("../rules/java.js");
    const rule = javaRules.find((r) => r.id === "catch-broad-exception-java");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("Broad.java"))).toBe(true);
  });

  test("sync-over-async-cs matches `.Result`", async () => {
    const { default: csRules } = await import("../rules/csharp.js");
    const rule = csRules.find((r) => r.id === "sync-over-async-cs");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("Sync.cs"))).toBe(true);
  });

  test("hardcoded-secret: flagged for real-looking key, suppressed for placeholder", async () => {
    const { default: commonRules } = await import("../rules/common.js");
    const rule = commonRules.find((r) => r.id === "hardcoded-secret");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("secret-bad.js"))).toBe(true);
    expect(findings.some((f) => f.file.includes("secret-placeholder.js"))).toBe(false);
  });

  test("promise-no-catch-ts matches .then() with callback containing parentheses", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "promise-no-catch-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("promise-paren.ts"))).toBe(true);
  });

  test("ai-step-comment matches capital-S 'Step 1:'", async () => {
    const { default: commonRules } = await import("../rules/common.js");
    const rule = commonRules.find((r) => r.id === "ai-step-comment");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("step-cap.js"))).toBe(true);
  });

  test("hardcoded-secret matches Go camelCase apiKey", async () => {
    const { default: commonRules } = await import("../rules/common.js");
    const rule = commonRules.find((r) => r.id === "hardcoded-secret");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("secret-go.go"))).toBe(true);
  });

  test("percent-string-format-py matches single-quoted strings", async () => {
    const { default: pyRules } = await import("../rules/python.js");
    const rule = pyRules.find((r) => r.id === "percent-string-format-py");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("pctfmt.py"))).toBe(true);
  });

  test("str-format-method-py matches single-quoted strings", async () => {
    const { default: pyRules } = await import("../rules/python.js");
    const rule = pyRules.find((r) => r.id === "str-format-method-py");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("strfmt.py"))).toBe(true);
  });

  test("sql-string-concat-go matches string concatenation with SQL keyword", async () => {
    const { default: goRules } = await import("../rules/go.js");
    const rule = goRules.find((r) => r.id === "sql-string-concat-go");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("sql-concat.go"))).toBe(true);
  });

  test("goroutine-no-context-go matches named function goroutine", async () => {
    const { default: goRules } = await import("../rules/go.js");
    const rule = goRules.find((r) => r.id === "goroutine-no-context-go");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("goroutine-named.go"))).toBe(true);
  });

  // Fix 1: hardcoded-secret case-insensitive
  test("hardcoded-secret matches SCREAMING_CASE API_KEY", async () => {
    const { default: commonRules } = await import("../rules/common.js");
    const rule = commonRules.find((r) => r.id === "hardcoded-secret");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("secret-screaming.js"))).toBe(true);
  });

  test("hardcoded-secret matches OPENAI_API_KEY (SCREAMING_CASE with prefix)", async () => {
    const { default: commonRules } = await import("../rules/common.js");
    const rule = commonRules.find((r) => r.id === "hardcoded-secret");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("secret-openai.js"))).toBe(true);
  });

  // Fix 2: SQL string concatenation TS
  test("sql-string-concat-ts matches string concatenation with SQL keyword", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "sql-string-concat-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("sql-concat.ts"))).toBe(true);
  });

  test("sql-string-concat-ts matches template literal with SQL keyword", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "sql-string-concat-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("sql-template.ts"))).toBe(true);
  });

  test("sql-string-concat-ts suppressed by parameterized antiPattern", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "sql-string-concat-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("sql-safe.ts"))).toBe(false);
  });

  // Fix 3: any-type non-first generic param
  test("any-type-ts matches Map<string, any>", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "any-type-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("any-generic.ts"))).toBe(true);
  });

  // Fix 4: Vector/Hashtable raw types without generics
  test("vector-deprecated-java matches raw Vector without generics", async () => {
    const { default: javaRules } = await import("../rules/java.js");
    const rule = javaRules.find((r) => r.id === "vector-deprecated-java");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("VectorRaw.java"))).toBe(true);
  });

  test("hashtable-deprecated-java matches raw Hashtable without generics", async () => {
    const { default: javaRules } = await import("../rules/java.js");
    const rule = javaRules.find((r) => r.id === "hashtable-deprecated-java");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("HashtableRaw.java"))).toBe(true);
  });

  // Fix 5: eval/new Function
  test("eval-usage-ts matches eval()", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "eval-usage-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("eval-bad.js"))).toBe(true);
  });

  test("eval-usage-ts matches new Function()", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "eval-usage-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("new-function.js"))).toBe(true);
  });

  // Fix 8: magic-number ML antiPattern suppression
  test("magic-number suppressed by batch antiPattern term", async () => {
    const { default: commonRules } = await import("../rules/common.js");
    const rule = commonRules.find((r) => r.id === "magic-number");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("magic-ml.py"))).toBe(false);
  });

  test("magic-number suppressed by SEED antiPattern term", async () => {
    const { default: commonRules } = await import("../rules/common.js");
    const rule = commonRules.find((r) => r.id === "magic-number");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("magic-seed.py"))).toBe(false);
  });

  // Fix 9: factory method try-with-resources
  test("missing-try-with-resources-java matches .getConnection() factory method", async () => {
    const { default: javaRules } = await import("../rules/java.js");
    const rule = javaRules.find((r) => r.id === "missing-try-with-resources-java");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("FactoryMethod.java"))).toBe(true);
  });

  // Fix 10: expanded C# disposable types
  test("missing-using-disposal-cs matches new TcpClient()", async () => {
    const { default: csRules } = await import("../rules/csharp.js");
    const rule = csRules.find((r) => r.id === "missing-using-disposal-cs");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("TcpClient.cs"))).toBe(true);
  });

  test("missing-using-disposal-cs matches new Process()", async () => {
    const { default: csRules } = await import("../rules/csharp.js");
    const rule = csRules.find((r) => r.id === "missing-using-disposal-cs");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("Process.cs"))).toBe(true);
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
