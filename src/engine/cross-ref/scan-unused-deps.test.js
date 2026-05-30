import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanUnusedDeps } from "./scan-unused-deps.js";

/** Create a temp project with a package.json and a set of files. */
async function makeProject(pkg, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), "unused-deps-"));
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

const flagged = (findings) => new Set(findings.map((f) => f.dep));

describe("scanUnusedDeps", () => {
  it("flags a genuinely unused dependency", async () => {
    const dir = await makeProject(
      { dependencies: { leftpad: "^1.0.0" } },
      { "src/index.ts": "export const x = 1;\n" },
    );
    const findings = await scanUnusedDeps(dir);
    expect(flagged(findings).has("leftpad")).toBe(true);
  });

  it("does not flag a dependency imported in source", async () => {
    const dir = await makeProject(
      { dependencies: { lodash: "^4.0.0" } },
      { "src/index.ts": "import { merge } from 'lodash';\nexport const x = merge({}, {});\n" },
    );
    const findings = await scanUnusedDeps(dir);
    expect(flagged(findings).has("lodash")).toBe(false);
  });

  it("does not flag a scoped package imported in source (leading @ boundary)", async () => {
    // Regression: `\b@scope/...` never matched, so every @scope/* dep was flagged.
    const dir = await makeProject(
      { dependencies: { "@radix-ui/react-dialog": "^1.0.0" } },
      { "src/ui.tsx": "import { Dialog } from '@radix-ui/react-dialog';\nexport { Dialog };\n" },
    );
    const findings = await scanUnusedDeps(dir);
    expect(flagged(findings).has("@radix-ui/react-dialog")).toBe(false);
  });

  it("does not flag @types/* when its runtime package is used", async () => {
    const dir = await makeProject(
      { devDependencies: { "@types/react": "^18.0.0" } },
      { "src/app.tsx": "import React from 'react';\nexport const A = () => null;\n" },
    );
    const findings = await scanUnusedDeps(dir);
    expect(flagged(findings).has("@types/react")).toBe(false);
  });

  it("maps @types/scope__name to @scope/name", async () => {
    const dir = await makeProject(
      { devDependencies: { "@types/babel__core": "^7.0.0" } },
      { "src/x.ts": "import { transform } from '@babel/core';\nexport const t = transform;\n" },
    );
    const findings = await scanUnusedDeps(dir);
    expect(flagged(findings).has("@types/babel__core")).toBe(false);
  });

  it("does not flag a package referenced only in a (non-source) config file", async () => {
    // .prettierrc.json is not a source extension, so collectFiles never reads it —
    // only the config corpus can surface the plugin reference.
    const dir = await makeProject(
      { devDependencies: { "prettier-plugin-tailwindcss": "^0.5.0" } },
      {
        ".prettierrc.json": JSON.stringify({ plugins: ["prettier-plugin-tailwindcss"] }),
        "src/index.ts": "export const x = 1;\n",
      },
    );
    const findings = await scanUnusedDeps(dir);
    expect(flagged(findings).has("prettier-plugin-tailwindcss")).toBe(false);
  });

  it("does not flag a CLI tool invoked by bin name in scripts", async () => {
    // typescript's package name never appears, but its `tsc` bin does. Resolve
    // bins from node_modules to recognise this.
    const dir = await makeProject(
      { devDependencies: { typescript: "^5.0.0" }, scripts: { build: "tsc -b" } },
      {
        "node_modules/typescript/package.json": JSON.stringify({
          name: "typescript",
          bin: { tsc: "./bin/tsc", tsserver: "./bin/tsserver" },
        }),
        "src/index.ts": "export const x = 1;\n",
      },
    );
    const findings = await scanUnusedDeps(dir);
    expect(flagged(findings).has("typescript")).toBe(false);
  });

  it("returns nothing when there is no manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unused-deps-none-"));
    await writeFile(join(dir, "src.ts"), "export const x = 1;\n");
    const findings = await scanUnusedDeps(dir);
    expect(findings).toEqual([]);
  });
});
