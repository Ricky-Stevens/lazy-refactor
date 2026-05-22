import { describe, expect, it } from "bun:test";
import {
  classifyRefactoring,
  computeRegionDensities,
  computeStructuralRatio,
  computeTokenDiversity,
  scoreConfidence,
} from "./duplicates/scoring.js";

describe("computeStructuralRatio", () => {
  it("returns high ratio for control-flow-heavy windows", () => {
    const tokens = ["function", "IDENT", "(", "IDENT", ")", "{", "if", "(", "IDENT", ">", "NUM", ")", "{", "return", "IDENT", "}", "return", "IDENT", "}"];
    const ratio = computeStructuralRatio(tokens, 0, tokens.length);
    expect(ratio).toBeGreaterThan(0.3);
  });

  it("returns low ratio for data-heavy windows", () => {
    const tokens = ["{", "IDENT", ":", "STR", ",", "IDENT", ":", "STR", ",", "IDENT", ":", "STR", ",", "IDENT", ":", "NUM", ",", "IDENT", ":", "STR", "}"];
    const ratio = computeStructuralRatio(tokens, 0, tokens.length);
    expect(ratio).toBeLessThan(0.1);
  });

  it("handles window offsets correctly", () => {
    const tokens = ["STR", "STR", "STR", "if", "else", "return", "IDENT", "IDENT"];
    const fullRatio = computeStructuralRatio(tokens, 0, tokens.length);
    const tailRatio = computeStructuralRatio(tokens, 3, 3);
    expect(tailRatio).toBe(1.0);
    expect(fullRatio).toBeLessThan(tailRatio);
  });

  it("returns 0 for empty window", () => {
    expect(computeStructuralRatio([], 0, 0)).toBe(0);
  });

  it("clamps to array bounds", () => {
    const tokens = ["if", "else"];
    const ratio = computeStructuralRatio(tokens, 0, 100);
    expect(ratio).toBe(1.0);
  });
});

describe("computeTokenDiversity", () => {
  it("returns high diversity for varied tokens", () => {
    const tokens = ["function", "IDENT", "(", ")", "{", "const", "=", "IDENT", "+", "NUM", ";", "if", ">", "return", "}"];
    const diversity = computeTokenDiversity(tokens, 0, tokens.length);
    expect(diversity).toBeGreaterThan(0.7);
  });

  it("returns low diversity for repetitive data structures", () => {
    const tokens = [];
    for (let i = 0; i < 40; i++) {
      tokens.push("IDENT", ":", "STR", ",");
    }
    const diversity = computeTokenDiversity(tokens, 0, tokens.length);
    expect(diversity).toBeLessThan(0.05);
  });

  it("returns 0 for empty window", () => {
    expect(computeTokenDiversity([], 0, 0)).toBe(0);
  });
});

describe("computeRegionDensities", () => {
  it("counts single-appearance regions as 1", () => {
    const findings = [
      { fileA: "a.js", startLineA: 1, endLineA: 10, fileB: "b.js", startLineB: 1, endLineB: 10 },
    ];
    const densities = computeRegionDensities(findings);
    expect(densities.get("a.js:1-10")).toBe(1);
    expect(densities.get("b.js:1-10")).toBe(1);
  });

  it("counts regions appearing in multiple findings", () => {
    const findings = [
      { fileA: "a.js", startLineA: 1, endLineA: 10, fileB: "b.js", startLineB: 1, endLineB: 10 },
      { fileA: "a.js", startLineA: 1, endLineA: 10, fileB: "c.js", startLineB: 5, endLineB: 15 },
      { fileA: "a.js", startLineA: 1, endLineA: 10, fileB: "d.js", startLineB: 1, endLineB: 10 },
    ];
    const densities = computeRegionDensities(findings);
    expect(densities.get("a.js:1-10")).toBe(3);
    expect(densities.get("b.js:1-10")).toBe(1);
    expect(densities.get("c.js:5-15")).toBe(1);
  });
});

describe("scoreConfidence", () => {
  it("scores high for logic-heavy, low-density duplicates", () => {
    const score = scoreConfidence(0.35, 0.25, 1, 1.0);
    expect(score).toBeGreaterThan(0.8);
  });

  it("scores low for data-heavy duplicates", () => {
    const score = scoreConfidence(0.05, 0.03, 1, 1.0);
    expect(score).toBeLessThan(0.3);
  });

  it("penalises high-density regions", () => {
    const lowDensity = scoreConfidence(0.20, 0.15, 1, 1.0);
    const highDensity = scoreConfidence(0.20, 0.15, 8, 1.0);
    expect(highDensity).toBeLessThan(lowDensity * 0.5);
  });

  it("incorporates similarity", () => {
    const perfect = scoreConfidence(0.30, 0.20, 1, 1.0);
    const partial = scoreConfidence(0.30, 0.20, 1, 0.85);
    expect(partial).toBeLessThan(perfect);
    expect(partial).toBeGreaterThan(perfect * 0.7);
  });

  it("returns 0 when all signals are minimal", () => {
    const score = scoreConfidence(0, 0, 10, 0.8);
    expect(score).toBe(0);
  });

  it("caps at 1.0", () => {
    const score = scoreConfidence(0.5, 0.5, 1, 1.0);
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

describe("classifyRefactoring", () => {
  it("returns extract-config for low structural ratio", () => {
    const tokens = ["{", "IDENT", ":", "STR", ",", "IDENT", ":", "STR", "}"];
    expect(classifyRefactoring(tokens, 0, tokens.length, 0.08)).toBe("extract-config");
  });

  it("returns extract-and-share when starting with function declaration", () => {
    const tokens = ["function", "IDENT", "(", "IDENT", ")", "{", "return", "IDENT", "}"];
    expect(classifyRefactoring(tokens, 0, tokens.length, 0.4)).toBe("extract-and-share");
  });

  it("returns extract-and-share for export function", () => {
    const tokens = ["export", "function", "IDENT", "(", ")", "{", "return", "NUM", "}"];
    expect(classifyRefactoring(tokens, 0, tokens.length, 0.4)).toBe("extract-and-share");
  });

  it("returns extract-and-share for async function", () => {
    const tokens = ["async", "IDENT", "(", "IDENT", ")", "{", "await", "IDENT", "(", ")", "}"];
    expect(classifyRefactoring(tokens, 0, tokens.length, 0.35)).toBe("extract-and-share");
  });

  it("returns extract-wrapper when try/catch is present", () => {
    const tokens = ["IDENT", "=", "IDENT", "(", ")", "try", "{", "IDENT", "}", "catch", "{", "}"];
    expect(classifyRefactoring(tokens, 0, tokens.length, 0.3)).toBe("extract-wrapper");
  });

  it("returns extract-function for inline logic without declaration", () => {
    const tokens = ["if", "(", "IDENT", ">", "NUM", ")", "{", "IDENT", "=", "IDENT", "+", "NUM", "}"];
    expect(classifyRefactoring(tokens, 0, tokens.length, 0.35)).toBe("extract-function");
  });

  it("prefers extract-wrapper over extract-and-share when both match", () => {
    const tokens = ["function", "IDENT", "(", ")", "{", "try", "{", "IDENT", "}", "catch", "{", "}", "}"];
    expect(classifyRefactoring(tokens, 0, tokens.length, 0.4)).toBe("extract-wrapper");
  });
});
