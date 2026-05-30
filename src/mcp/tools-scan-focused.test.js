import { describe, expect, it } from "bun:test";
import { boundFindings, compactFinding } from "./tools-scan-focused.js";

describe("compactFinding", () => {
  it("drops the bulky snippet field, keeps the rest", () => {
    const f = { check: "dup", severity: "low", snippet: "x".repeat(5000) };
    expect(compactFinding(f)).toEqual({ check: "dup", severity: "low" });
  });

  it("passes through non-objects unchanged", () => {
    expect(compactFinding(null)).toBeNull();
    expect(compactFinding("s")).toBe("s");
  });
});

describe("boundFindings", () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ id: i, snippet: "s" }));

  it("applies the default limit of 200 and reports truncation", () => {
    const r = boundFindings(items, {});
    expect(r.findings).toHaveLength(200);
    expect(r.total).toBe(250);
    expect(r.limit).toBe(200);
    expect(r.offset).toBe(0);
    expect(r.truncated).toBe(true);
  });

  it("honors limit + offset and clears truncated on the last page", () => {
    const r = boundFindings(items, { limit: 100, offset: 200 });
    expect(r.findings).toHaveLength(50);
    expect(r.truncated).toBe(false);
    expect(r.findings[0].id).toBe(200);
  });

  it("compact mode strips snippets from every returned finding", () => {
    const r = boundFindings(items, { limit: 3, compact: true });
    expect(r.findings.every((f) => !("snippet" in f))).toBe(true);
  });

  it("tolerates a non-array input", () => {
    const r = boundFindings(undefined, {});
    expect(r.total).toBe(0);
    expect(r.findings).toEqual([]);
  });
});
