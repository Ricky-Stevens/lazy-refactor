import { describe, expect, it } from "bun:test";
import { findMatches, rollingHash, verifyMatch } from "./duplicates.js";

// ---------------------------------------------------------------------------
// rollingHash
// ---------------------------------------------------------------------------

describe("rollingHash", () => {
  it("returns empty array when tokens fewer than window", () => {
    const result = rollingHash(["a", "b"], 5);
    expect(result).toEqual([]);
  });

  it("returns one entry when tokens exactly equal window", () => {
    const tokens = ["a", "b", "c"];
    const result = rollingHash(tokens, 3);
    expect(result).toHaveLength(1);
    expect(result[0].startIndex).toBe(0);
    expect(result[0].endIndex).toBe(2);
  });

  it("returns tokens.length - windowSize + 1 entries", () => {
    const tokens = ["a", "b", "c", "d", "e"];
    const result = rollingHash(tokens, 3);
    expect(result).toHaveLength(3);
  });

  it("produces the same hash for identical token windows", () => {
    const tokensA = ["if", "IDENT", "===", "NUM", "{", "return", "NUM", "}"];
    const tokensB = ["if", "IDENT", "===", "NUM", "{", "return", "NUM", "}"];
    const hashA = rollingHash(tokensA, 4);
    const hashB = rollingHash(tokensB, 4);
    expect(hashA[0].hash).toBe(hashB[0].hash);
  });

  it("produces different hashes for different token windows", () => {
    const tokensA = ["if", "IDENT", "===", "NUM"];
    const tokensB = ["while", "IDENT", "!==", "STR"];
    const hashA = rollingHash(tokensA, 4);
    const hashB = rollingHash(tokensB, 4);
    expect(hashA[0].hash).not.toBe(hashB[0].hash);
  });

  it("consecutive windows share overlapping token positions", () => {
    const tokens = ["a", "b", "c", "d"];
    const result = rollingHash(tokens, 3);
    expect(result[0]).toEqual({ hash: expect.any(Number), startIndex: 0, endIndex: 2 });
    expect(result[1]).toEqual({ hash: expect.any(Number), startIndex: 1, endIndex: 3 });
  });

  it("sliding hash matches a hash computed from scratch for the same window", () => {
    const tokens = ["if", "IDENT", "===", "NUM", "{", "return", "STR", "}", "else", "IDENT"];
    const windowSize = 4;
    const slid = rollingHash(tokens, windowSize);

    for (let start = 0; start < slid.length; start++) {
      const window = tokens.slice(start, start + windowSize);
      const [scratch] = rollingHash(window, windowSize);
      expect(slid[start].hash).toBe(scratch.hash);
    }
  });
});

// ---------------------------------------------------------------------------
// verifyMatch
// ---------------------------------------------------------------------------

describe("verifyMatch", () => {
  it("returns 1.0 for identical windows", () => {
    const tokens = ["if", "IDENT", "===", "NUM", "return"];
    const sim = verifyMatch(tokens, tokens, 0, 0, 5);
    expect(sim).toBe(1.0);
  });

  it("returns 0.0 for completely different windows", () => {
    const a = ["a", "b", "c", "d"];
    const b = ["w", "x", "y", "z"];
    const sim = verifyMatch(a, b, 0, 0, 4);
    expect(sim).toBe(0.0);
  });

  it("returns intermediate value for partial match", () => {
    const a = ["a", "b", "c", "d"];
    const b = ["a", "b", "x", "y"];
    const sim = verifyMatch(a, b, 0, 0, 4);
    expect(sim).toBe(0.5);
  });

  it("respects startIndex offsets", () => {
    const a = ["x", "y", "a", "b"];
    const b = ["m", "n", "a", "b"];
    const sim = verifyMatch(a, b, 2, 2, 2);
    expect(sim).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// findMatches
// ---------------------------------------------------------------------------

describe("findMatches", () => {
  it("returns empty array when no cross-file matches", () => {
    const hashMaps = [
      { file: "a.js", hashes: [{ hash: 1, startIndex: 0, endIndex: 4 }] },
      { file: "b.js", hashes: [{ hash: 2, startIndex: 0, endIndex: 4 }] },
    ];
    expect(findMatches(hashMaps)).toHaveLength(0);
  });

  it("finds a pair when both files share a hash", () => {
    const hashMaps = [
      { file: "a.js", hashes: [{ hash: 42, startIndex: 0, endIndex: 4 }] },
      { file: "b.js", hashes: [{ hash: 42, startIndex: 10, endIndex: 14 }] },
    ];
    const pairs = findMatches(hashMaps);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].fileA).toBe("a.js");
    expect(pairs[0].fileB).toBe("b.js");
  });

  it("does not report same-file matches", () => {
    const hashMaps = [
      {
        file: "a.js",
        hashes: [
          { hash: 42, startIndex: 0, endIndex: 4 },
          { hash: 42, startIndex: 10, endIndex: 14 },
        ],
      },
    ];
    expect(findMatches(hashMaps)).toHaveLength(0);
  });
});
