import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

export const LANGUAGE_EXTENSIONS = {
  typescript: [".ts", ".tsx", ".js", ".jsx"],
  javascript: [".js", ".jsx"],
  go: [".go"],
  python: [".py"],
  csharp: [".cs"],
  java: [".java"],
  common: [".ts", ".tsx", ".js", ".jsx", ".go", ".py", ".cs", ".java"],
};

export const ALL_SOURCE_EXTENSIONS = new Set(Object.values(LANGUAGE_EXTENSIONS).flat());

// Common non-source directories that should never be scanned.
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "build",
  ".next",
  "__pycache__",
  "obj",
  "bin",
  "target",
  ".gradle",
  "venv",
  ".venv",
]);

/**
 * Convert a glob pattern to a RegExp for path matching.
 * Supports `*`, `**`, `?`, and `{a,b,c}` brace alternation.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegex(pattern) {
  // First expand brace alternation `{a,b}` into a regex group `(a|b)` with
  // the contents already escaped.
  const expanded = pattern.replace(/\{([^}]+)\}/g, (_, inner) => {
    const alts = inner.split(",").map((s) => s.trim());
    return `(${alts.map((a) => a.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("|")})`;
  });

  // Now walk character-by-character. The `(`, `)`, and `|` produced by the
  // brace expansion above must pass through untouched; every other char is
  // either a glob wildcard or a literal we escape.
  let regStr = "";
  let i = 0;
  while (i < expanded.length) {
    const ch = expanded[i];
    if (ch === "(" || ch === ")" || ch === "|") {
      regStr += ch;
      i++;
    } else if (expanded.startsWith("**/", i)) {
      regStr += "(.+/)?";
      i += 3;
    } else if (expanded.startsWith("**", i)) {
      regStr += ".*";
      i += 2;
    } else if (ch === "*") {
      regStr += "[^/]*";
      i++;
    } else if (ch === "?") {
      regStr += "[^/]";
      i++;
    } else {
      regStr += ch.replace(/[.+^${}[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${regStr}$`);
}

/**
 * Recursively collect source files in a directory.
 * @param {string} dir
 * @param {object} options
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<string[]>}
 */
export async function collectFiles(dir, options = {}) {
  const { exclude = [], languages } = options;
  const results = [];

  const allowedExts = languages
    ? languages.flatMap((l) => LANGUAGE_EXTENSIONS[l] ?? [])
    : Object.values(LANGUAGE_EXTENSIONS).flat();

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Hard-coded skip for common non-source directories. These should never
      // be scanned regardless of user-supplied exclude patterns.
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

      const full = join(current, entry.name);
      const rel = full.slice(dir.length + 1);

      const excluded = exclude.some((pattern) => {
        const rx = globToRegex(pattern);
        return rx.test(rel) || rx.test(entry.name);
      });
      if (excluded) continue;

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && allowedExts.includes(extname(entry.name))) {
        results.push(full);
      } else if (entry.isSymbolicLink() && allowedExts.includes(extname(entry.name))) {
        // Follow symlinks only when they resolve to a regular file. We do not
        // follow directory symlinks because they can introduce cycles.
        try {
          const target = await stat(full);
          if (target.isFile()) results.push(full);
        } catch {
          // Broken symlink — skip silently.
        }
      }
    }
  }

  await walk(dir);
  return results;
}
