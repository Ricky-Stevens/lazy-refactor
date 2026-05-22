import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanToctou } from "./toctou.js";

describe("scanToctou", () => {
  let dir;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "toctou-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flags existsSync followed by writeFileSync in JS", async () => {
    const sub = join(dir, "js-toctou");
    await mkdir(sub, { recursive: true });

    await writeFile(
      join(sub, "lock.js"),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        "function acquireLock(path) {",
        "  if (!existsSync(path)) {",
        "    writeFileSync(path, process.pid.toString());",
        "  }",
        "}",
      ].join("\n"),
    );

    const findings = await scanToctou(sub, {});
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].check).toBe("toctou-race");
  });

  it("flags existsSync followed by unlinkSync in JS", async () => {
    const sub = join(dir, "js-unlink");
    await mkdir(sub, { recursive: true });

    await writeFile(
      join(sub, "cleanup.js"),
      [
        "import { existsSync, unlinkSync } from 'node:fs';",
        "function cleanup(path) {",
        "  if (existsSync(path)) {",
        "    unlinkSync(path);",
        "  }",
        "}",
      ].join("\n"),
    );

    const findings = await scanToctou(sub, {});
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag when wx flag is used on the same write (safe alternative)", async () => {
    const sub = join(dir, "js-safe");
    await mkdir(sub, { recursive: true });

    await writeFile(
      join(sub, "safe-lock.js"),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        "function acquireLock(path) {",
        "  if (!existsSync(path)) {",
        '    writeFileSync(path, process.pid.toString(), { flag: "wx" });',
        "  }",
        "}",
      ].join("\n"),
    );

    const findings = await scanToctou(sub, {});
    expect(findings).toHaveLength(0);
  });

  it("flags unsafe check-then-write even when safe pattern exists elsewhere in file", async () => {
    const sub = join(dir, "mixed-safe-unsafe");
    await mkdir(sub, { recursive: true });

    await writeFile(
      join(sub, "mixed.js"),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        "function safeLock(path) {",
        '  writeFileSync(path, "data", { flag: "wx" });',
        "}",
        "function unsafeLock(path) {",
        "  if (!existsSync(path)) {",
        "    writeFileSync(path, process.pid.toString());",
        "  }",
        "}",
      ].join("\n"),
    );

    const findings = await scanToctou(sub, {});
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  it("flags os.path.exists followed by os.remove in Python", async () => {
    const sub = join(dir, "py-toctou");
    await mkdir(sub, { recursive: true });

    await writeFile(
      join(sub, "cleanup.py"),
      [
        "import os",
        "def cleanup(path):",
        "    if os.path.exists(path):",
        "        os.remove(path)",
      ].join("\n"),
    );

    const findings = await scanToctou(sub, {});
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].check).toBe("toctou-race");
  });

  it("does not flag when exist_ok=True is used in Python", async () => {
    const sub = join(dir, "py-safe");
    await mkdir(sub, { recursive: true });

    await writeFile(
      join(sub, "safe.py"),
      [
        "import os",
        "def ensure_dir(path):",
        "    if not os.path.exists(path):",
        "        os.makedirs(path, exist_ok=True)",
      ].join("\n"),
    );

    const findings = await scanToctou(sub, {});
    expect(findings).toHaveLength(0);
  });

  it("does not flag existsSync without a conditional", async () => {
    const sub = join(dir, "no-conditional");
    await mkdir(sub, { recursive: true });

    await writeFile(
      join(sub, "check.js"),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        "const exists = existsSync('/some/path');",
        "console.log(exists);",
        "writeFileSync('/other/path', 'data');",
      ].join("\n"),
    );

    const findings = await scanToctou(sub, {});
    expect(findings).toHaveLength(0);
  });

  it("does not flag when write is too far from check", async () => {
    const sub = join(dir, "far-apart");
    await mkdir(sub, { recursive: true });

    const lines = [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "function f(path) {",
      "  if (!existsSync(path)) {",
      "    const a = 1;",
      "    const b = 2;",
      "    const c = 3;",
      "    const d = 4;",
      "    const e = 5;",
      "    const f = 6;",
      "    const g = 7;",
      "    const h = 8;",
      "    const i = 9;",
      "    writeFileSync(path, 'data');",
      "  }",
      "}",
    ];
    await writeFile(join(sub, "far.js"), lines.join("\n"));

    const findings = await scanToctou(sub, {});
    expect(findings).toHaveLength(0);
  });

  it("skips test files", async () => {
    const sub = join(dir, "test-filter");
    await mkdir(sub, { recursive: true });

    await writeFile(
      join(sub, "bad.test.js"),
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        "if (!existsSync('/tmp/test')) {",
        "  writeFileSync('/tmp/test', 'x');",
        "}",
      ].join("\n"),
    );

    const findings = await scanToctou(sub, {});
    expect(findings).toHaveLength(0);
  });

  it("finding shape has required fields", async () => {
    const sub = join(dir, "shape");
    await mkdir(sub, { recursive: true });

    await writeFile(
      join(sub, "race.js"),
      [
        "import { existsSync, mkdirSync } from 'node:fs';",
        "if (!existsSync('/tmp/dir')) {",
        "  mkdirSync('/tmp/dir');",
        "}",
      ].join("\n"),
    );

    const findings = await scanToctou(sub, {});
    for (const f of findings) {
      expect(f.check).toBe("toctou-race");
      expect(typeof f.file).toBe("string");
      expect(typeof f.line).toBe("number");
      expect(typeof f.description).toBe("string");
    }
  });
});
