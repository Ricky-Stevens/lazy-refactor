import { describe, expect, it } from "bun:test";
import { stripTsComments, stripTypeModifier } from "./ts-text.js";

describe("stripTypeModifier", () => {
  it("strips a leading inline `type` modifier", () => {
    expect(stripTypeModifier("type Foo")).toBe("Foo");
  });

  it("leaves a symbol literally named `type` intact", () => {
    expect(stripTypeModifier("type")).toBe("type");
  });

  it("does not touch names that merely start with 'type'", () => {
    expect(stripTypeModifier("typeName")).toBe("typeName");
  });

  it("is a no-op for ordinary names", () => {
    expect(stripTypeModifier("Foo")).toBe("Foo");
  });
});

describe("stripTsComments", () => {
  it("removes line comments", () => {
    expect(stripTsComments("const x = 1; // import { Foo } from './x'")).not.toContain("import");
  });

  it("blanks block comments while preserving line count", () => {
    const src = ["/**", " * import { Button } from './ui'", " */", "export const x = 1;"].join(
      "\n",
    );
    const out = stripTsComments(src);
    expect(out.split("\n")).toHaveLength(4);
    expect(out).not.toContain("import");
    expect(out).toContain("export const x = 1;");
  });
});
