import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharesEnclosingContainer } from "./duplicates/intra-container.js";
import { scanDuplicates } from "./duplicates.js";

// A logic-heavy block (high structural ratio) used as the duplicated body.
const LOGIC = `
    const result = a + b;
    const doubled = result * 2;
    const squared = doubled * doubled;
    const clamped = squared > 1000 ? 1000 : squared;
    const offset = clamped - 5;
    if (offset > 100) { return offset - 100; }
    return offset;`;

// A data row (low structural ratio) repeated to build a single array literal.
const ROW = `  {
    id: 1, name: "alpha", active: true,
    score: 100, tag: "beta", region: "gamma",
  },`;

// sharesEnclosingContainer drives the intra-structure confidence cap: same-file
// repetition fully nested in ONE bracket container (array rows, object literals)
// is repetition within a single data structure, not extractable copy-paste.
describe("sharesEnclosingContainer", () => {
  it("true when both windows are rows of one array literal", () => {
    // const X = [ {a:1}, {b:2} ]
    const t = "const IDENT = [ { IDENT : NUM } , { IDENT : NUM } ]".split(" ");
    // window A starts at the first '{' (idx 4), window B span ends at the ']' .
    expect(sharesEnclosingContainer(t, 4, 15)).toBe(true);
  });

  it("false for two sibling top-level declarations (no enclosing container)", () => {
    // function f(){} function g(){}
    const t = "function IDENT ( ) { } function IDENT ( ) { }".split(" ");
    expect(sharesEnclosingContainer(t, 0, 12)).toBe(false);
  });

  it("false when the container closes between the two windows", () => {
    // [ {a:1} ] ; [ {b:2} ]  — two separate arrays
    const t = "[ { IDENT : NUM } ] ; [ { IDENT : NUM } ]".split(" ");
    expect(sharesEnclosingContainer(t, 1, 14)).toBe(false);
  });
});

// The cap must distinguish data repetition (suppress) from extractable logic
// copy-paste (keep) — both can be same-file and inside one container.
describe("intra-structure cap respects structural ratio", () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "intra-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does NOT cap genuine logic copy-paste inside one container", async () => {
    // Two identical logic-heavy methods inside one object literal: same-file,
    // intra-container, but high structural ratio — this is real, extractable dup.
    const sub = join(dir, "logic");
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(sub, "handlers.js"),
      `const handlers = {\n  alpha(a, b) {${LOGIC}\n  },\n  beta(a, b) {${LOGIC}\n  },\n};\n`,
    );
    const findings = await scanDuplicates(sub, {
      minTokens: 20,
      similarity: 0.7,
      minConfidence: 0,
    });
    const sameFile = findings.filter((f) => f.check === "duplicate" && f.fileA === f.fileB);
    expect(sameFile.length).toBeGreaterThan(0);
    // Not forced below the cap — the logic block stays surfaceable as real dup.
    expect(Math.max(...sameFile.map((f) => f.confidence))).toBeGreaterThan(0.45);
  });

  it("caps data-row repetition within one array literal", async () => {
    const sub = join(dir, "data");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "rows.js"), `const rows = [\n${ROW.repeat(8)}\n];\n`);
    const findings = await scanDuplicates(sub, {
      minTokens: 20,
      similarity: 0.7,
      minConfidence: 0,
    });
    const sameFile = findings.filter((f) => f.check === "duplicate" && f.fileA === f.fileB);
    expect(sameFile.length).toBeGreaterThan(0);
    // Data repetition is held at/below the cap so it never auto-feeds the fixer.
    expect(Math.max(...sameFile.map((f) => f.confidence))).toBeLessThanOrEqual(0.45);
  });
});
