import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLanguages } from "./detect.js";

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lazy-detect-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detectLanguages — extension-sampling fallback (monorepo)", () => {
  it("detects languages from nested package source when root has no markers", async () => {
    // Monorepo layout: no root manifest, source lives under packages/<pkg>/src.
    await mkdir(join(dir, "packages", "app", "src"), { recursive: true });
    await writeFile(join(dir, "packages", "app", "src", "index.ts"), "export const x = 1;");
    await writeFile(join(dir, "packages", "app", "package.json"), "{}");

    const { languages, markers } = await detectLanguages(dir);
    expect(languages).toContain("typescript");
    expect(markers._extensionFallback).toBe(true);
  });

  it("samples Go sources in a nested layout", async () => {
    await mkdir(join(dir, "services", "api"), { recursive: true });
    await writeFile(join(dir, "services", "api", "main.go"), "package main");

    const { languages } = await detectLanguages(dir);
    expect(languages).toContain("go");
  });

  it("returns an empty list for a tree with no recognised source", async () => {
    await writeFile(join(dir, "README.md"), "# docs only");
    const { languages } = await detectLanguages(dir);
    expect(languages).toEqual([]);
  });

  it("does not run the fallback when root markers already detect a language", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "^5.0.0" } }),
    );
    // A stray .go file must NOT be picked up, since markers already resolved the language.
    await writeFile(join(dir, "stray.go"), "package main");

    const { languages, markers } = await detectLanguages(dir);
    expect(languages).toEqual(["typescript"]);
    expect(markers._extensionFallback).toBeUndefined();
  });
});
