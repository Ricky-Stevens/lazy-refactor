import { describe, expect, it } from "bun:test";
import { groupBySeverity, scoreFinding, scoreFindings } from "./prioritizer.js";

// Helper to build a minimal finding
function finding(overrides = {}) {
  return {
    id: "f-test",
    check: "test-check",
    severity: "medium",
    confidence: 1.0,
    ...overrides,
  };
}

describe("scoreFinding", () => {
  it("produces the expected numeric score", () => {
    // critical(4) * confidence(0.8) = 3.2
    const result = scoreFinding(finding({ severity: "critical", confidence: 0.8 }));
    expect(result.score).toBeCloseTo(3.2);
  });

  it("adds score field without mutating other fields", () => {
    const f = finding({ severity: "high", confidence: 1.0 });
    const result = scoreFinding(f);
    expect(result.id).toBe(f.id);
    expect(result.check).toBe(f.check);
    expect(typeof result.score).toBe("number");
    // Original should be unchanged (we use spread)
    expect(f.score).toBeUndefined();
  });

  it("critical severity scores higher than high", () => {
    const base = { confidence: 1.0 };
    const critical = scoreFinding(finding({ ...base, severity: "critical" }));
    const high = scoreFinding(finding({ ...base, severity: "high" }));
    expect(critical.score).toBeGreaterThan(high.score);
  });

  it("high severity scores higher than medium", () => {
    const base = { confidence: 1.0 };
    const high = scoreFinding(finding({ ...base, severity: "high" }));
    const medium = scoreFinding(finding({ ...base, severity: "medium" }));
    expect(high.score).toBeGreaterThan(medium.score);
  });

  it("medium severity scores higher than low", () => {
    const base = { confidence: 1.0 };
    const medium = scoreFinding(finding({ ...base, severity: "medium" }));
    const low = scoreFinding(finding({ ...base, severity: "low" }));
    expect(medium.score).toBeGreaterThan(low.score);
  });

  it("higher confidence scores higher than lower confidence at the same severity", () => {
    const base = { severity: "high" };
    const high = scoreFinding(finding({ ...base, confidence: 0.9 }));
    const low = scoreFinding(finding({ ...base, confidence: 0.3 }));
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("defaults missing confidence to 1", () => {
    const result = scoreFinding({ severity: "medium" });
    // medium(2) * confidence(1) = 2
    expect(result.score).toBe(2);
  });

  it("zero confidence produces zero score", () => {
    const result = scoreFinding(finding({ confidence: 0, severity: "critical" }));
    expect(result.score).toBe(0);
  });

  it("ignores legacy risk field", () => {
    // Risk dimension was removed; presence of the field must not affect score.
    const withRisk = scoreFinding(finding({ severity: "high", confidence: 1.0, risk: "high" }));
    const withoutRisk = scoreFinding(finding({ severity: "high", confidence: 1.0 }));
    expect(withRisk.score).toBe(withoutRisk.score);
  });
});

describe("scoreFindings", () => {
  it("returns an array of the same length", () => {
    const findings = [
      finding({ severity: "low", confidence: 1.0 }),
      finding({ severity: "critical", confidence: 1.0 }),
      finding({ severity: "medium", confidence: 1.0 }),
    ];
    expect(scoreFindings(findings)).toHaveLength(findings.length);
  });

  it("sorts by score descending", () => {
    const findings = [
      finding({ id: "1", severity: "low", confidence: 1.0 }),
      finding({ id: "2", severity: "critical", confidence: 1.0 }),
      finding({ id: "3", severity: "medium", confidence: 1.0 }),
    ];
    const sorted = scoreFindings(findings);
    expect(sorted[0].id).toBe("2"); // critical
    expect(sorted[1].id).toBe("3"); // medium
    expect(sorted[2].id).toBe("1"); // low
  });

  it("all findings have a score field after sorting", () => {
    const findings = [
      finding({ severity: "high", confidence: 0.5 }),
      finding({ severity: "low", confidence: 0.9 }),
    ];
    for (const f of scoreFindings(findings)) {
      expect(typeof f.score).toBe("number");
    }
  });

  it("handles an empty array", () => {
    expect(scoreFindings([])).toEqual([]);
  });
});

describe("groupBySeverity", () => {
  it("groups findings into the correct buckets", () => {
    const findings = [
      finding({ id: "1", severity: "critical" }),
      finding({ id: "2", severity: "high" }),
      finding({ id: "3", severity: "high" }),
      finding({ id: "4", severity: "medium" }),
      finding({ id: "5", severity: "low" }),
      finding({ id: "6", severity: "low" }),
    ];
    const groups = groupBySeverity(findings);
    expect(groups.critical).toHaveLength(1);
    expect(groups.high).toHaveLength(2);
    expect(groups.medium).toHaveLength(1);
    expect(groups.low).toHaveLength(2);
  });

  it("returns empty arrays for absent severities", () => {
    const groups = groupBySeverity([finding({ severity: "critical" })]);
    expect(groups.high).toEqual([]);
    expect(groups.medium).toEqual([]);
    expect(groups.low).toEqual([]);
  });

  it("always returns all four keys", () => {
    const groups = groupBySeverity([]);
    expect(Object.keys(groups).sort()).toEqual(["critical", "high", "low", "medium"]);
  });

  it("ignores unknown severities", () => {
    const groups = groupBySeverity([finding({ severity: "unknown" })]);
    const total =
      groups.critical.length + groups.high.length + groups.medium.length + groups.low.length;
    expect(total).toBe(0);
  });
});
