import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAliasResolver } from "./tsconfig-paths.js";

describe("loadAliasResolver", () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lazy-refactor-tsconfig-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when there is no tsconfig", async () => {
    expect(await loadAliasResolver(dir)).toBeNull();
  });

  it("returns null when tsconfig declares no paths", async () => {
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    expect(await loadAliasResolver(dir)).toBeNull();
  });

  it("resolves a `@/*` alias against baseUrl", async () => {
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
    );
    const resolveAlias = await loadAliasResolver(dir);
    expect(resolveAlias("@/components/ui")).toEqual([resolve(dir, "src/components/ui")]);
    expect(resolveAlias("./relative")).toEqual([]); // relative specifiers aren't aliases
  });

  it("parses JSONC (comments + trailing commas) and an exact (starless) alias", async () => {
    await writeFile(
      join(dir, "tsconfig.json"),
      `{
        // project config
        "compilerOptions": {
          "baseUrl": "./app",
          "paths": {
            "@/*": ["lib/*"],
            "config": ["config/index.ts"], /* exact match */
          },
        },
      }`,
    );
    const resolveAlias = await loadAliasResolver(dir);
    expect(resolveAlias("@/utils")).toEqual([resolve(dir, "app/lib/utils")]);
    expect(resolveAlias("config")).toEqual([resolve(dir, "app/config/index.ts")]);
  });

  it("merges paths from one `extends` level (child wins)", async () => {
    await writeFile(
      join(dir, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: {} }),
    );
    const resolveAlias = await loadAliasResolver(dir);
    expect(resolveAlias("@/x")).toEqual([resolve(dir, "src/x")]);
  });
});
