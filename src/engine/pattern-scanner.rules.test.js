import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPatterns } from "./pattern-scanner.js";

// Rule behaviour: verify each rule matches its intended target and is
// suppressed by its antiPattern where applicable.
describe("rule behaviour: rewritten and added rules", () => {
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "rule-behaviour-"));

    // Fixture map: filename -> content. Written in parallel via Promise.all.
    const fixtures = {
      "empty-catch.ts": "try { foo(); } catch (e) {}\n",
      "async-effect.tsx": "useEffect(async () => { await fetch('/x'); }, []);\n",
      "xss-bad.tsx": "<div dangerouslySetInnerHTML={{ __html: html }} />\n",
      "xss-good.tsx":
        "import DOMPurify from 'dompurify';\n<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />\n",
      "bare.py": "try:\n    x = 1\nexcept:\n    pass\n",
      "wildcard.py": "from os import *\n",
      "mutable.py": "def foo(items=[]):\n    return items\n",
      "open-bad.py": "f = open('x.txt')\n",
      "open-good.py": "with open('x.txt') as f:\n    pass\n",
      "discard.go": "package x\nfunc f() {\n    _ = doThing()\n}\n",
      "range.go": "package x\nfunc f() {\n    for _, v := range items {\n        _ = v\n    }\n}\n",
      "sql.go":
        'package x\nfunc q(id string) string { return fmt.Sprintf("SELECT * FROM users WHERE id=%s", id) }\n',
      "Broad.java": "class X { void f() { try {} catch (Exception e) {} } }\n",
      "Sync.cs": "class X { void F() { var r = task.Result; } }\n",
      "secret-bad.js": 'const api_key = "sk_live_abc123def456";\n',
      "secret-placeholder.js": 'const api_key = "your-api-key-here";\n',
      "promise-paren.ts": "fetch('/api').then(res => process(res));\n",
      "step-cap.js": "// Step 1: initialize the config\nconst x = 1;\n",
      "secret-go.go": 'package x\nvar apiKey = "sk_live_abc123def456"\n',
      "pctfmt.py": "x = '%s is %d' % (name, age)\n",
      "strfmt.py": "x = '{} is {}'.format(name, age)\n",
      "sql-concat.go":
        'package x\nfunc q(id string) string { return "SELECT * FROM users WHERE id=" + id }\n',
      "goroutine-named.go": "package x\nfunc f() {\n    go handleRequest(conn)\n}\n",
      "secret-screaming.js": 'const API_KEY = "sk_live_abc123def456";\n',
      "secret-openai.js": 'const OPENAI_API_KEY = "sk_live_abc123def456";\n',
      "sql-concat.ts": 'const q = "SELECT * FROM users WHERE id=" + userId;\n',
      "sql-template.ts": "const q = `SELECT * FROM users WHERE id=${userId}`;\n",
      "sql-safe.ts": '// parameterized\nconst q = "SELECT * FROM users WHERE id=$1";\n',
      "any-generic.ts": "const m: Map<string, any> = new Map();\n",
      "VectorRaw.java": "class X { Vector items = new Vector(); }\n",
      "HashtableRaw.java": "class X { Hashtable map = new Hashtable(); }\n",
      "eval-bad.js": 'const result = eval("1 + 2");\n',
      "new-function.js": 'const fn = new Function("a", "b", "return a + b");\n',
      "magic-ml.py": "batch = 256  # batch size for training\n",
      "magic-seed.py": "seed = 42  # SEED for reproducibility\n",
      "FactoryMethod.java": "class X { void f() { Connection c = ds.getConnection(); } }\n",
      "TcpClient.cs": "class X { void F() { var c = new TcpClient(); } }\n",
      "Process.cs": "class X { void F() { var p = new Process(); } }\n",
    };
    await Promise.all(
      Object.entries(fixtures).map(([name, content]) => writeFile(join(tmpDir, name), content)),
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

  test("promise-no-catch-ts matches .then() with callback containing parentheses", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "promise-no-catch-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("promise-paren.ts"))).toBe(true);
  });

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

  test("any-type-ts matches Map<string, any>", async () => {
    const { default: tsRules } = await import("../rules/typescript.js");
    const rule = tsRules.find((r) => r.id === "any-type-ts");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("any-generic.ts"))).toBe(true);
  });

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

  test("discarded-error-go: matches `_ = call()` but not range loops", async () => {
    const { default: goRules } = await import("../rules/go.js");
    const rule = goRules.find((r) => r.id === "discarded-error-go");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("discard.go"))).toBe(true);
    expect(findings.some((f) => f.file.includes("range.go"))).toBe(false);
  });

  test("sql-string-concat-go matches fmt.Sprintf and string concatenation", async () => {
    const { default: goRules } = await import("../rules/go.js");
    const rule = goRules.find((r) => r.id === "sql-string-concat-go");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("sql.go"))).toBe(true);
    expect(findings.some((f) => f.file.includes("sql-concat.go"))).toBe(true);
  });

  test("goroutine-no-context-go matches named function goroutine", async () => {
    const { default: goRules } = await import("../rules/go.js");
    const rule = goRules.find((r) => r.id === "goroutine-no-context-go");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("goroutine-named.go"))).toBe(true);
  });

  test("catch-broad-exception-java matches `catch (Exception e)`", async () => {
    const { default: javaRules } = await import("../rules/java.js");
    const rule = javaRules.find((r) => r.id === "catch-broad-exception-java");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("Broad.java"))).toBe(true);
  });

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

  test("missing-try-with-resources-java matches .getConnection() factory method", async () => {
    const { default: javaRules } = await import("../rules/java.js");
    const rule = javaRules.find((r) => r.id === "missing-try-with-resources-java");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("FactoryMethod.java"))).toBe(true);
  });

  test("sync-over-async-cs matches `.Result`", async () => {
    const { default: csRules } = await import("../rules/csharp.js");
    const rule = csRules.find((r) => r.id === "sync-over-async-cs");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("Sync.cs"))).toBe(true);
  });

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

  test("hardcoded-secret: flagged for real-looking key, suppressed for placeholder", async () => {
    const { default: commonRules } = await import("../rules/common.js");
    const rule = commonRules.find((r) => r.id === "hardcoded-secret");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("secret-bad.js"))).toBe(true);
    expect(findings.some((f) => f.file.includes("secret-placeholder.js"))).toBe(false);
  });

  test("hardcoded-secret matches Go camelCase apiKey", async () => {
    const { default: commonRules } = await import("../rules/common.js");
    const rule = commonRules.find((r) => r.id === "hardcoded-secret");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("secret-go.go"))).toBe(true);
  });

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

  test("ai-step-comment matches capital-S 'Step 1:'", async () => {
    const { default: commonRules } = await import("../rules/common.js");
    const rule = commonRules.find((r) => r.id === "ai-step-comment");
    const findings = await scanPatterns(tmpDir, [rule], {});
    expect(findings.some((f) => f.file.includes("step-cap.js"))).toBe(true);
  });
});
