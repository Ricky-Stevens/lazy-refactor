import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDivergentExports } from "./scan-divergent-exports.js";

describe("scanDivergentExports", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "divergent-exports-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flags a specific symbol exported from two different files", async () => {
    const sub = join(dir, "basic");
    await mkdir(sub, { recursive: true });

    await writeFile(
      join(sub, "auth.js"),
      "export function isPathTraversal(p) { return p.includes('..'); }",
    );
    await writeFile(
      join(sub, "validator.js"),
      "export function isPathTraversal(p) { return p.startsWith('/'); }",
    );

    const findings = await scanDivergentExports(sub, {});
    const hit = findings.find((f) => f.symbol === "isPathTraversal");
    expect(hit).toBeDefined();
    expect(hit.check).toBe("divergent-export");
    expect(hit.fileCount).toBe(2);
    expect(hit.locations).toHaveLength(2);
  });

  it("does not flag short generic names", async () => {
    const sub = join(dir, "short-names");
    await mkdir(sub, { recursive: true });

    await writeFile(join(sub, "a.js"), "export function parse(s) { return s; }");
    await writeFile(join(sub, "b.js"), "export function parse(s) { return s; }");

    const findings = await scanDivergentExports(sub, {});
    expect(findings.find((f) => f.symbol === "parse")).toBeUndefined();
  });

  it("accepts multi-segment camelCase names >= 6 chars", async () => {
    const sub = join(dir, "camelcase");
    await mkdir(sub, { recursive: true });

    await writeFile(join(sub, "a.js"), "export function resolveBaseRef() { return 'a'; }");
    await writeFile(join(sub, "b.js"), "export function resolveBaseRef() { return 'b'; }");

    const findings = await scanDivergentExports(sub, {});
    expect(findings.find((f) => f.symbol === "resolveBaseRef")).toBeDefined();
  });

  it("accepts SCREAMING_SNAKE_CASE names >= 6 chars", async () => {
    const sub = join(dir, "snake-case");
    await mkdir(sub, { recursive: true });

    await writeFile(join(sub, "a.js"), "export const AGENT_MODEL = { a: 1 };");
    await writeFile(join(sub, "b.js"), "export const AGENT_MODEL = { b: 2 };");

    const findings = await scanDivergentExports(sub, {});
    expect(findings.find((f) => f.symbol === "AGENT_MODEL")).toBeDefined();
  });

  it("skips re-exports (barrel files)", async () => {
    const sub = join(dir, "barrel");
    await mkdir(sub, { recursive: true });

    await writeFile(join(sub, "impl.js"), "export function acquireLock() { return true; }");
    await writeFile(join(sub, "barrel.js"), "export { acquireLock } from './impl.js';");

    const findings = await scanDivergentExports(sub, {});
    expect(findings.find((f) => f.symbol === "acquireLock")).toBeUndefined();
  });

  it("returns empty array when no duplicates exist", async () => {
    const sub = join(dir, "unique");
    await mkdir(sub, { recursive: true });

    await writeFile(join(sub, "a.js"), "export function doSomethingSpecific() {}");
    await writeFile(join(sub, "b.js"), "export function doAnotherThing() {}");

    const findings = await scanDivergentExports(sub, {});
    expect(findings).toHaveLength(0);
  });

  it("skips test files", async () => {
    const sub = join(dir, "test-filter");
    await mkdir(sub, { recursive: true });

    await writeFile(join(sub, "impl.js"), "export function findMostRecent() { return null; }");
    await writeFile(
      join(sub, "impl.test.js"),
      "export function findMostRecent() { return 'mock'; }",
    );

    const findings = await scanDivergentExports(sub, {});
    expect(findings.find((f) => f.symbol === "findMostRecent")).toBeUndefined();
  });

  it("finding shape has required fields", async () => {
    const sub = join(dir, "shape");
    await mkdir(sub, { recursive: true });

    await writeFile(join(sub, "a.js"), "export function validateInputs(x) { return x; }");
    await writeFile(join(sub, "b.js"), "export function validateInputs(x) { return !x; }");

    const findings = await scanDivergentExports(sub, {});
    for (const f of findings) {
      expect(f.check).toBe("divergent-export");
      expect(typeof f.symbol).toBe("string");
      expect(typeof f.fileCount).toBe("number");
      expect(Array.isArray(f.locations)).toBe(true);
      for (const loc of f.locations) {
        expect(typeof loc.file).toBe("string");
        expect(typeof loc.line).toBe("number");
      }
      expect(typeof f.description).toBe("string");
    }
  });
});
