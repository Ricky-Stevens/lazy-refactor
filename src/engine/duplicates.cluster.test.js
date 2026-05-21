import { describe, expect, it } from "bun:test";
import { clusterDuplicates } from "./duplicates.js";

// ---------------------------------------------------------------------------
// clusterDuplicates unit tests
// ---------------------------------------------------------------------------

describe("clusterDuplicates", () => {
  it("returns empty array for empty input", () => {
    expect(clusterDuplicates([])).toEqual([]);
    expect(clusterDuplicates(null)).toEqual([]);
    expect(clusterDuplicates(undefined)).toEqual([]);
  });

  it("groups a single pair into one cluster with 2 members", () => {
    const matches = [
      {
        check: "duplicate",
        fileA: "a.js",
        fileB: "b.js",
        startLineA: 0,
        endLineA: 10,
        startLineB: 5,
        endLineB: 15,
        similarity: 0.95,
        tokenCount: 50,
      },
    ];
    const clusters = clusterDuplicates(matches);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].check).toBe("duplicate-cluster");
    expect(clusters[0].memberCount).toBe(2);
    expect(clusters[0].files).toHaveLength(2);
    expect(clusters[0].avgSimilarity).toBe(0.95);
    expect(clusters[0].avgTokenCount).toBe(50);
  });

  it("merges transitive pairs into a single cluster (A-B + B-C = 1 cluster)", () => {
    const matches = [
      { check: "duplicate", fileA: "a.js", fileB: "b.js", startLineA: 0, endLineA: 10, startLineB: 0, endLineB: 10, similarity: 0.9, tokenCount: 60 },
      { check: "duplicate", fileA: "b.js", fileB: "c.js", startLineA: 0, endLineA: 10, startLineB: 0, endLineB: 10, similarity: 0.8, tokenCount: 40 },
    ];
    const clusters = clusterDuplicates(matches);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberCount).toBe(3);
    expect(clusters[0].avgSimilarity).toBe(0.85);
    expect(clusters[0].avgTokenCount).toBe(50);
  });

  it("keeps disconnected pairs as separate clusters", () => {
    const matches = [
      { check: "duplicate", fileA: "a.js", fileB: "b.js", startLineA: 0, endLineA: 10, startLineB: 0, endLineB: 10, similarity: 0.9, tokenCount: 60 },
      { check: "duplicate", fileA: "c.js", fileB: "d.js", startLineA: 0, endLineA: 10, startLineB: 0, endLineB: 10, similarity: 0.8, tokenCount: 40 },
    ];
    const clusters = clusterDuplicates(matches);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].memberCount).toBe(2);
    expect(clusters[1].memberCount).toBe(2);
  });

  it("includes a representative pair from the original matches", () => {
    const matches = [
      { check: "duplicate", fileA: "x.js", fileB: "y.js", startLineA: 5, endLineA: 15, startLineB: 10, endLineB: 20, similarity: 0.92, tokenCount: 55 },
    ];
    const clusters = clusterDuplicates(matches);
    expect(clusters[0].representativePair).toEqual({
      fileA: "x.js",
      startLineA: 5,
      endLineA: 15,
      fileB: "y.js",
      startLineB: 10,
      endLineB: 20,
    });
  });

  it("distinguishes same file with different line ranges as separate regions", () => {
    const matches = [
      { check: "duplicate", fileA: "a.js", fileB: "a.js", startLineA: 0, endLineA: 10, startLineB: 50, endLineB: 60, similarity: 0.95, tokenCount: 50 },
    ];
    const clusters = clusterDuplicates(matches);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberCount).toBe(2);
    expect(clusters[0].files[0].file).toBe("a.js");
    expect(clusters[0].files[1].file).toBe("a.js");
    expect(clusters[0].files[0].startLine).not.toBe(clusters[0].files[1].startLine);
  });
});
