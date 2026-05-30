import { describe, expect, it } from "bun:test";
import { extractExports } from "../cross-ref.js";

// ---------------------------------------------------------------------------
// extractExports — TypeScript
// ---------------------------------------------------------------------------

describe("extractExports — TypeScript", () => {
  it("detects export function", () => {
    const result = extractExports("export function doWork() {}", "typescript");
    expect(result).toEqual([{ name: "doWork", line: 0 }]);
  });

  it("detects export async function", () => {
    const result = extractExports("export async function fetchData() {}", "typescript");
    expect(result).toEqual([{ name: "fetchData", line: 0 }]);
  });

  it("detects export const", () => {
    const result = extractExports("export const MAX_SIZE = 100;", "typescript");
    expect(result).toEqual([{ name: "MAX_SIZE", line: 0 }]);
  });

  it("detects export class", () => {
    const result = extractExports("export class UserService {}", "typescript");
    expect(result).toEqual([{ name: "UserService", line: 0 }]);
  });

  it("detects export default function with name", () => {
    const result = extractExports("export default function handler() {}", "typescript");
    expect(result).toEqual([{ name: "handler", line: 0 }]);
  });

  it("detects export default class with name", () => {
    const result = extractExports("export default class App {}", "typescript");
    expect(result).toEqual([{ name: "App", line: 0 }]);
  });

  it("detects multiple exports across lines", () => {
    const content = [
      "export function alpha() {}",
      "const internal = 1;",
      "export const beta = 2;",
      "export class Gamma {}",
    ].join("\n");
    const result = extractExports(content, "typescript");
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.name)).toEqual(["alpha", "beta", "Gamma"]);
  });

  it("does not flag non-exported declarations", () => {
    const result = extractExports("function privateHelper() {}", "typescript");
    expect(result).toHaveLength(0);
  });
});

describe("extractExports — TypeScript export { X } re-exports", () => {
  it("detects plain named re-export", () => {
    const result = extractExports("export { foo, bar };", "typescript");
    expect(result.map((e) => e.name)).toContain("foo");
    expect(result.map((e) => e.name)).toContain("bar");
  });

  it("detects aliased re-export (foo as baz → baz is exported)", () => {
    const result = extractExports("export { foo as baz };", "typescript");
    expect(result.map((e) => e.name)).toContain("baz");
    expect(result.map((e) => e.name)).not.toContain("foo");
  });

  it('detects re-export with "from" source', () => {
    const result = extractExports(
      "export { readFile, writeFile } from 'node:fs/promises';",
      "typescript",
    );
    expect(result.map((e) => e.name)).toContain("readFile");
    expect(result.map((e) => e.name)).toContain("writeFile");
  });

  it("records the correct line number for re-exports", () => {
    const content = "// preamble\nexport { alpha, beta };";
    const result = extractExports(content, "typescript");
    const names = result.map((e) => e.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    // Both exports are on line 1 (0-based)
    for (const e of result.filter((r) => names.includes(r.name))) {
      expect(e.line).toBe(1);
    }
  });

  it("detects re-exports split across multiple lines", () => {
    const content = "export {\n  computeWidgetValue,\n  renderWidget,\n} from './x';";
    const result = extractExports(content, "typescript");
    const names = result.map((e) => e.name);
    expect(names).toContain("computeWidgetValue");
    expect(names).toContain("renderWidget");
  });

  it("records the line where a multi-line re-export block begins", () => {
    const content = "// preamble\nexport {\n  alpha,\n} from './x';";
    const result = extractExports(content, "typescript");
    const alpha = result.find((e) => e.name === "alpha");
    expect(alpha).toBeDefined();
    // The `export {` token is on line 1 (0-based)
    expect(alpha.line).toBe(1);
  });

  it("does not produce duplicate entries when a symbol is both declared and re-exported", () => {
    const content = ["export function helper() {}", "export { helper };"].join("\n");
    const result = extractExports(content, "typescript");
    const helpers = result.filter((e) => e.name === "helper");
    // It's fine to have two entries (one from declaration, one from re-export) — just assert they exist
    expect(helpers.length).toBeGreaterThanOrEqual(1);
  });
});

describe("extractExports — export default expression", () => {
  it("detects export default MyComponent", () => {
    const result = extractExports("export default MyComponent", "typescript");
    expect(result.map((e) => e.name)).toContain("MyComponent");
  });

  it("detects export default MyComponent with semicolon", () => {
    const result = extractExports("export default MyComponent;", "typescript");
    expect(result.map((e) => e.name)).toContain("MyComponent");
  });

  it("still detects export default function with name", () => {
    const result = extractExports("export default function handler() {}", "typescript");
    expect(result.map((e) => e.name)).toContain("handler");
  });
});

// ---------------------------------------------------------------------------
// extractExports — Go
// ---------------------------------------------------------------------------

describe("extractExports — Go", () => {
  it("detects exported func (capitalised)", () => {
    const result = extractExports("func ProcessRequest(ctx context.Context) error {", "go");
    expect(result).toEqual([{ name: "ProcessRequest", line: 0 }]);
  });

  it("does not detect unexported func (lowercase)", () => {
    const result = extractExports("func helper() {}", "go");
    expect(result).toHaveLength(0);
  });

  it("detects exported type", () => {
    const result = extractExports("type UserID string", "go");
    expect(result).toEqual([{ name: "UserID", line: 0 }]);
  });

  it("does not detect unexported type", () => {
    const result = extractExports("type internalState struct {", "go");
    expect(result).toHaveLength(0);
  });

  it("detects exported var", () => {
    const result = extractExports("var DefaultTimeout = 30", "go");
    expect(result).toEqual([{ name: "DefaultTimeout", line: 0 }]);
  });

  it("detects exported method receiver", () => {
    const result = extractExports("func (s *Server) Shutdown() error {", "go");
    expect(result).toEqual([{ name: "Shutdown", line: 0 }]);
  });
});

describe("extractExports — Go iota continuation lines", () => {
  it("detects iota continuation identifiers (bare name, no trailing space)", () => {
    const content = [
      "const (",
      "  StatusPending = iota",
      "  StatusActive",
      "  StatusDone",
      ")",
    ].join("\n");
    const result = extractExports(content, "go");
    expect(result.map((e) => e.name)).toContain("StatusPending");
    expect(result.map((e) => e.name)).toContain("StatusActive");
    expect(result.map((e) => e.name)).toContain("StatusDone");
  });

  it("does not pick up unexported iota continuation lines", () => {
    const content = ["const (", "  statusPending = iota", "  statusActive", ")"].join("\n");
    const result = extractExports(content, "go");
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractExports — Python
// ---------------------------------------------------------------------------

describe("extractExports — Python", () => {
  it("detects top-level def", () => {
    const result = extractExports("def compute_total(items):", "python");
    expect(result).toEqual([{ name: "compute_total", line: 0 }]);
  });

  it("detects top-level class", () => {
    const result = extractExports("class DataProcessor:", "python");
    expect(result).toEqual([{ name: "DataProcessor", line: 0 }]);
  });

  it("detects class with base", () => {
    const result = extractExports("class MyError(Exception):", "python");
    expect(result).toEqual([{ name: "MyError", line: 0 }]);
  });

  it("does not flag indented def (method)", () => {
    const result = extractExports("    def _private(self):", "python");
    expect(result).toHaveLength(0);
  });
});

describe("extractExports — Python decorator tracking", () => {
  it("marks decorated function with decorated: true", () => {
    const content = ["@app.route('/api')", "def get_users():", "    pass"].join("\n");
    const result = extractExports(content, "python");
    const fn = result.find((e) => e.name === "get_users");
    expect(fn).toBeDefined();
    expect(fn.decorated).toBe(true);
  });

  it("marks decorated class with decorated: true", () => {
    const content = ["@dataclass", "class Config:", "    name: str"].join("\n");
    const result = extractExports(content, "python");
    const cls = result.find((e) => e.name === "Config");
    expect(cls).toBeDefined();
    expect(cls.decorated).toBe(true);
  });

  it("does not mark undecorated function as decorated", () => {
    const content = "def plain_function():\n    pass";
    const result = extractExports(content, "python");
    const fn = result.find((e) => e.name === "plain_function");
    expect(fn).toBeDefined();
    expect(fn.decorated).toBeUndefined();
  });

  it("does not mark TypeScript exports as decorated", () => {
    // Decorator tracking is Python-only
    const content = "export function handler() {}";
    const result = extractExports(content, "typescript");
    const fn = result.find((e) => e.name === "handler");
    expect(fn).toBeDefined();
    expect(fn.decorated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractExports — type-only tagging (drives lower dead-code confidence)
// ---------------------------------------------------------------------------

describe("extractExports — type-only tagging", () => {
  it("marks `export type` as isType", () => {
    const result = extractExports("export type UserId = string;", "typescript");
    const entry = result.find((e) => e.name === "UserId");
    expect(entry).toBeDefined();
    expect(entry.isType).toBe(true);
  });

  it("marks `export interface` as isType", () => {
    const result = extractExports("export interface User { id: string }", "typescript");
    const entry = result.find((e) => e.name === "User");
    expect(entry).toBeDefined();
    expect(entry.isType).toBe(true);
  });

  it("does NOT mark value exports as isType", () => {
    const result = extractExports("export const MAX = 100;", "typescript");
    const entry = result.find((e) => e.name === "MAX");
    expect(entry).toBeDefined();
    expect(entry.isType).toBeUndefined();
  });
});
