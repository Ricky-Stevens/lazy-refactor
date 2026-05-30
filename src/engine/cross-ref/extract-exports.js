/**
 * Extract exported symbols from file content for a given language.
 * Returns array of {name, line} objects (line is 0-based).
 * @param {string} content
 * @param {string} language
 * @returns {Array<{name: string, line: number}>}
 */

const PATTERNS = {
  typescript: [
    // export function foo / export async function foo
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    // export const/let/var foo
    /^export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    // export class Foo / export abstract class Foo
    /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    // export interface Foo
    /^export\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    // export type Foo
    /^export\s+type\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    // export enum Foo
    /^export\s+enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    // export default function / export default class
    /^export\s+default\s+(?:(?:async\s+)?function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    // export default MyComponent / export default MyComponent;
    /^export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;?$/,
  ],
  go: [
    // Exported (capitalised) func
    /^func\s+([A-Z][A-Za-z0-9_]*)\s*[([]/,
    // Exported method — func (r Receiver) MethodName(
    /^func\s+\([^)]+\)\s+([A-Z][A-Za-z0-9_]*)\s*\(/,
    // Exported type
    /^type\s+([A-Z][A-Za-z0-9_]*)\s+/,
    // Exported var / const
    /^var\s+([A-Z][A-Za-z0-9_]*)\s/,
    /^const\s+([A-Z][A-Za-z0-9_]*)\s/,
  ],
  python: [
    // top-level def (sync or async)
    /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    // top-level class
    /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/,
  ],
  csharp: [
    /public\s+(?:static\s+)?(?:class|interface|struct|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /public\s+(?:static\s+)?(?:\w+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  ],
  java: [
    /public\s+(?:static\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /public\s+(?:static\s+)?(?:\w+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  ],
};

/**
 * Go: collect exports from grouped var/const blocks — `var (...)` / `const (...)`
 * Single-line patterns don't cover these because entries lack the var/const keyword.
 */
function extractGoGroupedExports(lines, existingExports) {
  const result = [];
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();

    if (/^(?:var|const)\s*\(/.test(t)) {
      inBlock = true;
      continue;
    }
    if (inBlock && t === ")") {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;

    const m = t.match(/^([A-Z][A-Za-z0-9_]*)(?:\s|$)/);
    if (m && !existingExports.some((e) => e.name === m[1])) {
      result.push({ name: m[1], line: i });
    }
  }

  return result;
}

/**
 * TypeScript: collect re-exported names from `export { foo, bar }` / `export { foo as bar }` blocks.
 * The exported name is the alias when present ("foo as bar" → "bar").
 * Scans full content with a global regex so blocks split across multiple lines are captured.
 */
function extractTypeScriptReExports(content) {
  const result = [];
  const re = /export\s+\{([^}]+)\}/g;
  let m;

  while ((m = re.exec(content))) {
    const line = content.slice(0, m.index).split("\n").length - 1;

    for (const segment of m[1].split(",")) {
      const parts = segment.trim().split(/\s+as\s+/);
      const exportedName = parts[parts.length - 1].trim();
      if (exportedName) result.push({ name: exportedName, line });
    }
  }

  return result;
}

/**
 * Scan lines with the given patterns, returning matched export entries.
 * For Python, marks entries that are preceded by a decorator line.
 */
function extractPatternMatches(lines, langPatterns, language) {
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of langPatterns) {
      const match = line.match(pattern);
      if (!match) continue;

      const entry = { name: match[1], line: i };
      if (language === "python" && i > 0 && lines[i - 1].trim().startsWith("@")) {
        entry.decorated = true;
      }
      // Type-only exports (export type / export interface) carry no runtime
      // value and are disproportionately re-exported through `export * from`
      // barrels — a documented dead-code false-positive source — so the scanner
      // surfaces them at lower confidence (see scan-dead-code.checkExport).
      if (language === "typescript" && /^export\s+(?:type|interface)\b/.test(line)) {
        entry.isType = true;
      }
      result.push(entry);
      break;
    }
  }

  return result;
}

export function extractExports(content, language) {
  const lines = content.split("\n");
  const langPatterns = PATTERNS[language] ?? [];

  const exports = extractPatternMatches(lines, langPatterns, language);

  if (language === "go") {
    exports.push(...extractGoGroupedExports(lines, exports));
  }

  if (language === "typescript") {
    exports.push(...extractTypeScriptReExports(content));
  }

  return exports;
}
