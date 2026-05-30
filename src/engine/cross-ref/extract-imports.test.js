import { describe, expect, it } from "bun:test";
import { extractImports } from "../cross-ref.js";

// ---------------------------------------------------------------------------
// extractImports — TypeScript
// ---------------------------------------------------------------------------

describe("extractImports — TypeScript", () => {
  it("extracts named imports", () => {
    const result = extractImports("import { useState, useEffect } from 'react';", "typescript");
    expect(result).toContain("useState");
    expect(result).toContain("useEffect");
  });

  it("extracts default import", () => {
    const result = extractImports("import React from 'react';", "typescript");
    expect(result).toContain("React");
  });

  it("extracts namespace import", () => {
    const result = extractImports("import * as path from 'node:path';", "typescript");
    expect(result).toContain("path");
  });

  it("extracts require destructure", () => {
    const result = extractImports("const { readFile } = require('fs');", "typescript");
    expect(result).toContain("readFile");
  });

  it("extracts require default", () => {
    const result = extractImports("const fs = require('fs');", "typescript");
    expect(result).toContain("fs");
  });

  it("handles aliased imports — records exported name (not local alias) for cross-ref matching", () => {
    // extractImports is used for dead-code cross-referencing; we need the exported name
    // so it can be matched against exports from other files.
    const result = extractImports("import { Component as Comp } from 'framework';", "typescript");
    expect(result).toContain("Component");
    expect(result).not.toContain("Comp");
  });
});

describe("extractImports — TypeScript alias handling (exported name)", () => {
  it("records the exported name, not the local alias", () => {
    const result = extractImports("import { foo as bar } from './module';", "typescript");
    // For dead-code cross-referencing we need the exported name ("foo")
    expect(result).toContain("foo");
    expect(result).not.toContain("bar");
  });

  it("records both exported names when multiple aliased imports are present", () => {
    const result = extractImports(
      "import { alpha as a, beta as b, gamma } from './module';",
      "typescript",
    );
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).toContain("gamma");
    expect(result).not.toContain("a");
    expect(result).not.toContain("b");
  });
});

describe("extractImports — inline type modifier (U1)", () => {
  it("records the bare name for an inline `type` specifier, not 'type Foo'", () => {
    const result = extractImports("import { type Foo, Bar } from './x';", "typescript");
    expect(result).toContain("Foo");
    expect(result).toContain("Bar");
    expect(result).not.toContain("type Foo");
  });

  it("handles a multi-line block with inline type modifiers", () => {
    const result = extractImports(
      ["import {", "  type Alpha,", "  Beta,", "} from './x';"].join("\n"),
      "typescript",
    );
    expect(result).toContain("Alpha");
    expect(result).toContain("Beta");
    expect(result).not.toContain("type Alpha");
  });
});

describe("extractImports — re-exports count as uses (D1)", () => {
  it("treats `export { Foo } from` as a use of Foo", () => {
    const result = extractImports(
      "export { CampaignsPage } from './campaigns-page';",
      "typescript",
    );
    expect(result).toContain("CampaignsPage");
  });

  it("records the exported name for an aliased re-export (`export { Foo as default }`)", () => {
    const result = extractImports("export { CampaignsPage as default } from './x';", "typescript");
    expect(result).toContain("CampaignsPage");
  });

  it("handles multi-line re-exports", () => {
    const result = extractImports(
      ["export {", "  One,", "  Two,", "} from './barrel';"].join("\n"),
      "typescript",
    );
    expect(result).toContain("One");
    expect(result).toContain("Two");
  });

  it("ignores a local `export { Foo }` with no `from` (not a cross-module use)", () => {
    const result = extractImports("const Foo = 1;\nexport { Foo };", "typescript");
    expect(result).not.toContain("Foo");
  });
});

describe("extractImports — comments don't pollute the import set (U2)", () => {
  it("ignores imports written inside a JSDoc @example block", () => {
    const src = [
      "/**",
      " * @example",
      " * import { Button } from './ui'",
      " */",
      "export * from './button';",
    ].join("\n");
    expect(extractImports(src, "typescript")).not.toContain("Button");
  });
});

describe("extractImports — destructured require with colon rename", () => {
  it("records the local name for { foo: bar } = require(...)", () => {
    const result = extractImports("const { foo: bar } = require('module');", "typescript");
    expect(result).toContain("bar");
    expect(result).not.toContain("foo");
    expect(result).not.toContain("foo: bar");
  });

  it("handles mixed renamed and plain destructured require", () => {
    const result = extractImports(
      "const { readFile: read, writeFile } = require('fs');",
      "typescript",
    );
    expect(result).toContain("read");
    expect(result).toContain("writeFile");
    expect(result).not.toContain("readFile");
    expect(result).not.toContain("readFile: read");
  });
});

// ---------------------------------------------------------------------------
// extractImports — Go
// ---------------------------------------------------------------------------

describe("extractImports — Go import block with flexible whitespace", () => {
  it("parses import block with tabs between import and paren", () => {
    const content = ["import\t(", '  "fmt"', '  "os"', ")"].join("\n");
    const result = extractImports(content, "go");
    expect(result).toContain("fmt");
    expect(result).toContain("os");
  });

  it("parses import block with no space before paren", () => {
    const content = ["import(", '  "fmt"', ")"].join("\n");
    const result = extractImports(content, "go");
    expect(result).toContain("fmt");
  });

  it("parses standard import block with single space", () => {
    const content = ["import (", '  "net/http"', '  "encoding/json"', ")"].join("\n");
    const result = extractImports(content, "go");
    expect(result).toContain("http");
    expect(result).toContain("json");
  });
});

describe("extractImports — Go dot imports", () => {
  it("records dot import as '.' in imports array", () => {
    const content = ["import (", '  . "testing"', '  "fmt"', ")"].join("\n");
    const result = extractImports(content, "go");
    expect(result).toContain(".");
    expect(result).toContain("fmt");
  });

  it("records dot import from single-line syntax", () => {
    const result = extractImports('import . "testing"', "go");
    expect(result).toContain(".");
  });
});

// ---------------------------------------------------------------------------
// extractImports — Python
// ---------------------------------------------------------------------------

describe("extractImports — Python exported name (not alias)", () => {
  it("records the exported name for from...import...as", () => {
    const result = extractImports("from module import foo as bar", "python");
    expect(result).toContain("foo");
    expect(result).not.toContain("bar");
  });

  it("records exported names for multiple aliased from-imports", () => {
    const result = extractImports("from module import alpha as a, beta as b, gamma", "python");
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).toContain("gamma");
    expect(result).not.toContain("a");
    expect(result).not.toContain("b");
  });
});

describe("extractImports — Python parenthesized from-import", () => {
  it("captures symbols from a multi-line parenthesized import", () => {
    const content = ["from helpers import (", "  compute_total_amount,", ")"].join("\n");
    const result = extractImports(content, "python");
    expect(result).toContain("compute_total_amount");
    expect(result).not.toContain("(");
  });

  it("captures multiple symbols across continuation lines", () => {
    const content = ["from mod import (", "  foo,", "  bar,", ")"].join("\n");
    const result = extractImports(content, "python");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
    expect(result).not.toContain("(");
  });

  it("strips parens from a single-line parenthesized import", () => {
    const result = extractImports("from mod import (foo, bar)", "python");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
    expect(result).not.toContain("(foo");
    expect(result).not.toContain("bar)");
  });
});

// ---------------------------------------------------------------------------
// extractImports — C#
// ---------------------------------------------------------------------------

describe("extractImports — C#", () => {
  it("extracts full namespace from plain using directive", () => {
    const result = extractImports("using System.Collections.Generic;", "csharp");
    // Full namespace path — not just the last segment ("Generic") which causes FPs
    expect(result).toContain("System.Collections.Generic");
    expect(result).not.toContain("Generic");
  });

  it("extracts alias from using alias directive", () => {
    const result = extractImports("using Dict = System.Collections.Generic.Dictionary;", "csharp");
    expect(result).toContain("Dict");
    // Should NOT add the right-hand type name
    expect(result).not.toContain("Dictionary");
  });

  it("handles multiple using statements with full paths", () => {
    const content = ["using System;", "using System.Linq;", "using MyApp.Services;"].join("\n");
    const result = extractImports(content, "csharp");
    expect(result).toContain("System");
    expect(result).toContain("System.Linq");
    expect(result).toContain("MyApp.Services");
  });
});

describe("extractImports — C# full namespace path", () => {
  it("pushes full namespace path for cross-ref (not last segment)", () => {
    const result = extractImports("using System.Collections.Generic;", "csharp");
    expect(result).toContain("System.Collections.Generic");
    // Should NOT contain misleading single words
    expect(result).not.toContain("Generic");
  });

  it("still extracts alias for using alias directives", () => {
    const result = extractImports("using Col = System.Collections;", "csharp");
    expect(result).toContain("Col");
  });
});

// ---------------------------------------------------------------------------
// extractImports — Java
// ---------------------------------------------------------------------------

describe("extractImports — Java", () => {
  it("extracts last segment from a regular import", () => {
    const result = extractImports("import java.util.ArrayList;", "java");
    expect(result).toContain("ArrayList");
  });

  it("extracts last segment from a static import", () => {
    const result = extractImports("import static org.junit.Assert.assertEquals;", "java");
    expect(result).toContain("assertEquals");
  });

  it("handles multiple import statements", () => {
    const content = [
      "import java.util.List;",
      "import java.util.Map;",
      "import static java.util.Collections.sort;",
    ].join("\n");
    const result = extractImports(content, "java");
    expect(result).toContain("List");
    expect(result).toContain("Map");
    expect(result).toContain("sort");
  });
});
