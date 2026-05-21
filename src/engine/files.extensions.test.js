import { describe, expect, test } from "bun:test";
import { ALL_SOURCE_EXTENSIONS, LANGUAGE_EXTENSIONS } from "./files.js";

// ---------------------------------------------------------------------------
// LANGUAGE_EXTENSIONS
// ---------------------------------------------------------------------------

describe("LANGUAGE_EXTENSIONS", () => {
  test("has entries for all expected languages", () => {
    const expected = ["typescript", "javascript", "go", "python", "csharp", "java", "common"];
    for (const lang of expected) {
      expect(LANGUAGE_EXTENSIONS).toHaveProperty(lang);
      expect(Array.isArray(LANGUAGE_EXTENSIONS[lang])).toBe(true);
      expect(LANGUAGE_EXTENSIONS[lang].length).toBeGreaterThan(0);
    }
  });

  test("typescript includes .ts, .tsx, .js, .jsx", () => {
    expect(LANGUAGE_EXTENSIONS.typescript).toContain(".ts");
    expect(LANGUAGE_EXTENSIONS.typescript).toContain(".tsx");
    expect(LANGUAGE_EXTENSIONS.typescript).toContain(".js");
    expect(LANGUAGE_EXTENSIONS.typescript).toContain(".jsx");
  });

  test("go includes .go", () => {
    expect(LANGUAGE_EXTENSIONS.go).toContain(".go");
  });

  test("python includes .py", () => {
    expect(LANGUAGE_EXTENSIONS.python).toContain(".py");
  });

  test("csharp includes .cs", () => {
    expect(LANGUAGE_EXTENSIONS.csharp).toContain(".cs");
  });

  test("java includes .java", () => {
    expect(LANGUAGE_EXTENSIONS.java).toContain(".java");
  });

  test("common includes all language extensions", () => {
    const common = LANGUAGE_EXTENSIONS.common;
    expect(common).toContain(".ts");
    expect(common).toContain(".tsx");
    expect(common).toContain(".js");
    expect(common).toContain(".jsx");
    expect(common).toContain(".go");
    expect(common).toContain(".py");
    expect(common).toContain(".cs");
    expect(common).toContain(".java");
  });
});

// ---------------------------------------------------------------------------
// ALL_SOURCE_EXTENSIONS
// ---------------------------------------------------------------------------

describe("ALL_SOURCE_EXTENSIONS", () => {
  test("is a Set", () => {
    expect(ALL_SOURCE_EXTENSIONS).toBeInstanceOf(Set);
  });

  test("contains all expected extensions", () => {
    for (const ext of [".ts", ".tsx", ".js", ".jsx", ".go", ".py", ".cs", ".java"]) {
      expect(ALL_SOURCE_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});
