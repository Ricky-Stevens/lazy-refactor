/**
 * Extract exported symbols from file content for a given language.
 * Returns array of {name, line} objects (line is 0-based).
 * @param {string} content
 * @param {string} language
 * @returns {Array<{name: string, line: number}>}
 */
export function extractExports(content, language) {
  const lines = content.split("\n");
  const exports = [];

  const patterns = {
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

  const langPatterns = patterns[language] ?? [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of langPatterns) {
      const match = line.match(pattern);
      if (match) {
        const entry = { name: match[1], line: i };
        // Python: mark functions/classes preceded by a decorator line
        if (language === "python" && i > 0 && lines[i - 1].trim().startsWith("@")) {
          entry.decorated = true;
        }
        exports.push(entry);
        break;
      }
    }
  }

  // Go: grouped var/const declarations — inside `var (...)` or `const (...)` blocks
  // entries look like `Foo = 1` without the var/const keyword, so the single-line
  // patterns above don't catch them.
  if (language === "go") {
    let inVarBlock = false;
    let inConstBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^var\s*\(/.test(t)) {
        inVarBlock = true;
        continue;
      }
      if (/^const\s*\(/.test(t)) {
        inConstBlock = true;
        continue;
      }
      if ((inVarBlock || inConstBlock) && t === ")") {
        inVarBlock = false;
        inConstBlock = false;
        continue;
      }
      if (inVarBlock || inConstBlock) {
        const m = t.match(/^([A-Z][A-Za-z0-9_]*)(?:\s|$)/);
        if (m && !exports.some((e) => e.name === m[1])) {
          exports.push({ name: m[1], line: i });
        }
      }
    }
  }

  // TypeScript: handle named re-export blocks — export { foo, bar } / export { foo as bar }
  // These appear as a brace group that does not start with `export default` or keyword.
  if (language === "typescript") {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Match: export { ... } with optional "from '...'"
      const m = line.match(/^export\s+\{([^}]+)\}/);
      if (m) {
        for (const segment of m[1].split(",")) {
          // "foo as bar" → exported name is "bar"; plain "foo" → "foo"
          const parts = segment.trim().split(/\s+as\s+/);
          const exportedName = parts[parts.length - 1].trim();
          if (exportedName) exports.push({ name: exportedName, line: i });
        }
      }
    }
  }

  return exports;
}
