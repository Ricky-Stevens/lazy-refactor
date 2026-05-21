import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDeadCode } from "../cross-ref.js";

// ---------------------------------------------------------------------------
// scanDeadCode — entry point exclusions
// ---------------------------------------------------------------------------

describe("scanDeadCode — new entry points", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "entry-points-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not flag Next.js Pages Router _app.tsx as dead code", async () => {
    const subDir = join(dir, "nextjs-pages");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "_app.tsx"), "export default function App() {}");

    const findings = await scanDeadCode(subDir, {});
    expect(findings.some((f) => f.file.endsWith("_app.tsx"))).toBe(false);
  });

  it("does not flag _document.tsx as dead code", async () => {
    const subDir = join(dir, "nextjs-doc");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "_document.tsx"), "export default function Doc() {}");

    const findings = await scanDeadCode(subDir, {});
    expect(findings.some((f) => f.file.endsWith("_document.tsx"))).toBe(false);
  });

  it("does not flag manage.py as dead code", async () => {
    const subDir = join(dir, "django");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "manage.py"), "def main():\n    pass\n");

    const findings = await scanDeadCode(subDir, {});
    expect(findings.some((f) => f.file.endsWith("manage.py"))).toBe(false);
  });

  it("does not flag wsgi.py as dead code", async () => {
    const subDir = join(dir, "wsgi-test");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "wsgi.py"), "def application(env, start_response):\n    pass\n");

    const findings = await scanDeadCode(subDir, {});
    expect(findings.some((f) => f.file.endsWith("wsgi.py"))).toBe(false);
  });
});

describe("scanDeadCode — Java plural Tests file pattern", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "java-tests-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not flag FooTests.java as dead code (plural form)", async () => {
    const subDir = join(dir, "java-plural");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "FooTests.java"),
      "public class FooTests { public void testFoo() {} }",
    );
    await writeFile(join(subDir, "App.java"), "public class App {}");

    const findings = await scanDeadCode(subDir, {});
    expect(findings.some((f) => f.file.endsWith("FooTests.java"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanDeadCode — additional Next.js entry points (Fix 4)
// ---------------------------------------------------------------------------

describe("scanDeadCode — additional entry points (Fix 4)", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "entry-points-fix4-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const entryFiles = [
    "global-error.tsx",
    "global-error.ts",
    "default.tsx",
    "default.ts",
    "default.jsx",
    "default.js",
    "instrumentation.ts",
    "instrumentation.js",
    "opengraph-image.tsx",
    "opengraph-image.ts",
    "twitter-image.tsx",
    "twitter-image.ts",
    "sitemap.ts",
    "sitemap.js",
    "robots.ts",
    "robots.js",
    "manifest.ts",
    "manifest.js",
  ];

  for (const filename of entryFiles) {
    it(`does not flag ${filename} as dead code`, async () => {
      const subDir = join(dir, filename.replace(/\./g, "-"));
      await mkdir(subDir, { recursive: true });
      const ext = filename.split(".").pop();
      let content;
      if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") {
        content = "export default function Page() {}";
      }
      await writeFile(join(subDir, filename), content);

      const findings = await scanDeadCode(subDir, {});
      expect(findings.some((f) => f.file.endsWith(filename))).toBe(false);
    });
  }
});
