import { describe, expect, it } from "bun:test";
import { mapCluster, mapDupe } from "./mappers.js";

// Regression: duplicate findings must store paths RELATIVE to the scan root, like
// every other mapper (mapDeadExport etc.). Before this, mapDupe/mapCluster copied
// the engine's absolute fileA/fileB verbatim, so the same physical file landed in
// the store under both an absolute and a relative path — splitting group_findings
// groups and breaking dedup. See review of the v0.11 fix-all run.
describe("duplicate mappers normalise paths to the scan root", () => {
  const root = "/home/ricky/project";

  it("mapDupe strips the resolved root from fileA and fileB", () => {
    const mapped = mapDupe(
      {
        check: "duplicate",
        fileA: `${root}/src/a.ts`,
        fileB: `${root}/src/b.ts`,
        startLineA: 1,
        endLineA: 10,
        startLineB: 5,
        endLineB: 14,
        similarity: 0.9,
        tokenCount: 120,
      },
      root,
    );
    expect(mapped.locations[0].file).toBe("src/a.ts");
    expect(mapped.fileB).toBe("src/b.ts");
    expect(mapped.description).toContain("src/a.ts");
    expect(mapped.description).toContain("src/b.ts");
    expect(mapped.description).not.toContain(root);
  });

  it("mapCluster strips the resolved root from every member location", () => {
    const mapped = mapCluster(
      {
        check: "duplicate-cluster",
        files: [
          { file: `${root}/src/x.ts`, startLine: 1, endLine: 8 },
          { file: `${root}/src/y.ts`, startLine: 2, endLine: 9 },
        ],
        avgSimilarity: 0.85,
      },
      root,
    );
    expect(mapped.locations.map((l) => l.file)).toEqual(["src/x.ts", "src/y.ts"]);
  });

  it("is a no-op when no resolvedPath is supplied (paths already relative)", () => {
    const mapped = mapDupe(
      { check: "duplicate", fileA: "src/a.ts", fileB: "src/b.ts", similarity: 0.9 },
      undefined,
    );
    expect(mapped.locations[0].file).toBe("src/a.ts");
    expect(mapped.fileB).toBe("src/b.ts");
  });
});
