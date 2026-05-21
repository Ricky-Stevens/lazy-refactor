import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanInconsistentPatterns } from "../patterns.js";

// ---------------------------------------------------------------------------
// scanInconsistentPatterns
// ---------------------------------------------------------------------------

describe("scanInconsistentPatterns", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "inconsistent-patterns-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty array when only 1-2 approaches are used", async () => {
    const subDir = join(dir, "few-approaches");
    await mkdir(subDir, { recursive: true });
    // Only fetch API used — one approach
    await writeFile(join(subDir, "a.js"), "async function load() { return fetch('/api'); }");
    await writeFile(join(subDir, "b.js"), "async function load2() { return fetch('/other'); }");

    const findings = await scanInconsistentPatterns(subDir, {});
    const fetchFindings = findings.filter((f) => f.concern === "data-fetching");
    expect(fetchFindings).toHaveLength(0);
  });

  it("flags concern when 3+ approaches are detected", async () => {
    const subDir = join(dir, "many-approaches");
    await mkdir(subDir, { recursive: true });

    // Three different data-fetching approaches
    await writeFile(join(subDir, "fetch-file.js"), "async function a() { return fetch('/api'); }");
    await writeFile(join(subDir, "axios-file.js"), "const res = await axios.get('/api');");
    await writeFile(join(subDir, "request-file.js"), "request('/api', callback);");

    const findings = await scanInconsistentPatterns(subDir, {});
    const fetchFindings = findings.filter((f) => f.concern === "data-fetching");
    expect(fetchFindings.length).toBeGreaterThanOrEqual(1);
    expect(fetchFindings[0].check).toBe("inconsistent-patterns");
    expect(Array.isArray(fetchFindings[0].approaches)).toBe(true);
    expect(fetchFindings[0].approaches.length).toBeGreaterThanOrEqual(3);
  });

  it("finding shape has required fields", async () => {
    const subDir = join(dir, "shape-check");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "a.js"), "async function a() { return fetch('/api'); }");
    await writeFile(join(subDir, "b.js"), "const res = await axios.get('/api');");
    await writeFile(join(subDir, "c.js"), "request('/api', callback);");

    const findings = await scanInconsistentPatterns(subDir, {});
    for (const f of findings) {
      expect(f.check).toBe("inconsistent-patterns");
      expect(typeof f.concern).toBe("string");
      expect(Array.isArray(f.approaches)).toBe(true);
      for (const approach of f.approaches) {
        expect(typeof approach.pattern).toBe("string");
        expect(Array.isArray(approach.files)).toBe(true);
        expect(typeof approach.count).toBe("number");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// scanInconsistentPatterns — word-boundary guard
// ---------------------------------------------------------------------------

describe("scanInconsistentPatterns — no false positives on substring matches", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "patterns-wordboundary-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does not classify files as logging concern when "log" only appears inside "dialog"', async () => {
    const subDir = join(dir, "substring-log");
    await mkdir(subDir, { recursive: true });
    // "dialog" contains "log" as substring but is not a logging keyword
    await writeFile(join(subDir, "a.js"), "function openDialog() { return dialog.show(); }");
    await writeFile(join(subDir, "b.js"), "const catalog = getCatalog();");
    await writeFile(join(subDir, "c.js"), "const blog = getBlog();");

    const findings = await scanInconsistentPatterns(subDir, {});
    const loggingFindings = findings.filter((f) => f.concern === "logging");
    expect(loggingFindings).toHaveLength(0);
  });

  it('does not classify files as config concern when "config" only appears inside "reconfigure"', async () => {
    const subDir = join(dir, "substring-config");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "a.js"), "function reconfigure() {}");
    await writeFile(join(subDir, "b.js"), "function misconfiguration() {}");

    const findings = await scanInconsistentPatterns(subDir, {});
    const configFindings = findings.filter((f) => f.concern === "config");
    expect(configFindings).toHaveLength(0);
  });
});
