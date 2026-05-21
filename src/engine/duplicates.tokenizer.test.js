import { describe, expect, it } from "bun:test";
import { normalizeTokens, tokenize } from "./duplicates.js";

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("splits on whitespace and operators", () => {
    const tokens = tokenize("a + b");
    expect(tokens).toEqual(["a", "+", "b"]);
  });

  it("handles function declaration", () => {
    const tokens = tokenize("function add(x, y) { return x + y; }");
    expect(tokens).toContain("function");
    expect(tokens).toContain("add");
    expect(tokens).toContain("return");
    expect(tokens).toContain("+");
  });

  it("emits string literals as a single STR-sentinel token", () => {
    const tokens = tokenize('"hello world"');
    expect(tokens).toEqual(['"..."']);
  });

  it("handles single-quoted strings", () => {
    const tokens = tokenize("const x = 'foo';");
    expect(tokens).toContain('"..."');
    expect(tokens).not.toContain("foo");
  });

  it("handles backtick strings", () => {
    const tokens = tokenize("const msg = `hello ${name}`;");
    // backtick string is emitted as one sentinel; the interpolated part is consumed
    expect(tokens.filter((t) => t === '"..."').length).toBeGreaterThanOrEqual(1);
  });

  it("strips line comments", () => {
    const tokens = tokenize("x = 1; // this is a comment\ny = 2;");
    expect(tokens).not.toContain("this");
    expect(tokens).not.toContain("comment");
    expect(tokens).toContain("x");
    expect(tokens).toContain("y");
  });

  it("strips block comments", () => {
    const tokens = tokenize("/* block comment */ x = 1;");
    expect(tokens).not.toContain("block");
    expect(tokens).toContain("x");
  });

  it("handles numeric literals", () => {
    const tokens = tokenize("const n = 42;");
    expect(tokens).toContain("42");
  });

  it("handles operators as individual tokens", () => {
    const tokens = tokenize("a === b");
    expect(tokens).toContain("=");
    expect(tokens).toContain("a");
    expect(tokens).toContain("b");
  });
});

// ---------------------------------------------------------------------------
// normalizeTokens
// ---------------------------------------------------------------------------

describe("normalizeTokens", () => {
  it("replaces identifiers with IDENT", () => {
    const result = normalizeTokens(["myVar"]);
    expect(result).toEqual(["IDENT"]);
  });

  it("replaces numbers with NUM", () => {
    const result = normalizeTokens(["42", "3.14", "0xFF"]);
    expect(result).toEqual(["NUM", "NUM", "NUM"]);
  });

  it("replaces string sentinel with STR", () => {
    const result = normalizeTokens(['"..."']);
    expect(result).toEqual(["STR"]);
  });

  it("keeps keywords as-is", () => {
    const keywords = [
      "if",
      "else",
      "for",
      "while",
      "return",
      "function",
      "class",
      "const",
      "let",
      "var",
      "import",
      "export",
    ];
    const result = normalizeTokens(keywords);
    expect(result).toEqual(keywords);
  });

  it("keeps Go keywords as-is", () => {
    const goKeywords = ["func", "defer", "go", "select", "chan", "range"];
    const result = normalizeTokens(goKeywords);
    expect(result).toEqual(goKeywords);
  });

  it("keeps Python keywords as-is", () => {
    const pyKeywords = ["def", "pass", "with", "as", "from", "lambda", "yield"];
    const result = normalizeTokens(pyKeywords);
    expect(result).toEqual(pyKeywords);
  });

  it("keeps operator tokens as-is", () => {
    const ops = ["+", "-", "=", "{", "}", "(", ")", ";"];
    const result = normalizeTokens(ops);
    expect(result).toEqual(ops);
  });

  it("normalises a realistic snippet", () => {
    const tokens = tokenize("function add(x, y) { return x + y; }");
    const normalised = normalizeTokens(tokens);
    expect(normalised).toContain("function");
    expect(normalised).toContain("return");
    expect(normalised).toContain("IDENT");
    expect(normalised).not.toContain("add");
    expect(normalised).not.toContain("x");
    expect(normalised).not.toContain("y");
  });
});
