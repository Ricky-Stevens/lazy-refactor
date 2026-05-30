import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDeadCode } from "../cross-ref.js";
import { computeReachableFiles } from "./reachability.js";

// computeReachableFiles is pure over synthetic fileData (no fs needed).
describe("computeReachableFiles", () => {
  const root = "/proj/src";
  const fd = (file, content) => ({ file: `${root}/${file}`, language: "typescript", content });

  it("marks a file re-exported via `export * from` as reachable", () => {
    const data = [
      fd("index.ts", "export * from './widget';"),
      fd("widget.ts", "export function Widget() {}"),
    ];
    const reachable = computeReachableFiles(data);
    expect(reachable.has(`${root}/widget.ts`)).toBe(true);
  });

  it("marks a dynamically-imported file as reachable (await import / arrow import)", () => {
    const data = [
      fd("loader.ts", "const m = async () => (await import('./lazy')).run();"),
      fd("lazy.ts", "export function run() {}"),
    ];
    const reachable = computeReachableFiles(data);
    expect(reachable.has(`${root}/lazy.ts`)).toBe(true);
  });

  it("resolves a directory specifier to its index file", () => {
    const data = [
      fd("app.ts", "export * from './feature';"),
      fd("feature/index.ts", "export const thing = 1;"),
    ];
    const reachable = computeReachableFiles(data);
    expect(reachable.has(`${root}/feature/index.ts`)).toBe(true);
  });

  it("resolves a nodenext `.js` specifier to the `.ts` file on disk", () => {
    const data = [
      fd("index.ts", "export * from './widget.js';"),
      fd("widget.ts", "export function Widget() {}"),
    ];
    const reachable = computeReachableFiles(data);
    expect(reachable.has(`${root}/widget.ts`)).toBe(true);
  });

  it("does not mark unrelated files, and leaves alias imports unresolved", () => {
    const data = [fd("a.ts", "export * from '@/aliased';"), fd("b.ts", "export const z = 1;")];
    expect(computeReachableFiles(data).size).toBe(0);
  });
});

// End-to-end: a symbol consumed only through a barrel must NOT be flagged dead,
// because the fixer's remedy is deletion — and deleting it breaks live code.
describe("scanDeadCode respects barrel/dynamic reachability", () => {
  let dir;
  it("does not flag a symbol reachable only via an export* barrel", async () => {
    dir = await mkdtemp(join(tmpdir(), "reach-test-"));
    try {
      // widget.ts exports Widget; no file imports it BY NAME — it's only reachable
      // through the barrel's `export *`, then a namespace/star consumer.
      await writeFile(join(dir, "widget.ts"), "export function Widget() { return 1; }");
      await writeFile(join(dir, "index.ts"), "export * from './widget';");
      await writeFile(join(dir, "consumer.ts"), "import * as ui from './index';\nui.Widget();");

      const findings = await scanDeadCode(dir, {});
      expect(findings.map((f) => f.symbol)).not.toContain("Widget");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
