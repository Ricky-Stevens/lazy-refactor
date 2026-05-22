import { readdir, readFile, stat } from "node:fs/promises";
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
const _globCache = new Map();

export function globToRegex(pattern) {
  const cached = _globCache.get(pattern);
  if (cached) return cached;

  const expanded = pattern.replace(/\{([^}]+)\}/g, (_, inner) => {
    const alts = inner.split(",").map((s) => s.trim());
    return `(${alts.map((a) => a.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("|")})`;
  });

  const rx = new RegExp(`^${buildRegexString(expanded)}$`);
  _globCache.set(pattern, rx);
  return rx;
}

/**
 * Build a regex string from an already-brace-expanded glob pattern.
 * @param {string} expanded
 * @returns {string}
 */
function buildRegexString(expanded) {
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
  return regStr;
}

/**
 * Precompile an array of glob patterns into regexes for repeated matching.
 * @param {string[]} patterns
 * @returns {RegExp[]}
 */
export function compileExcludes(patterns) {
  return patterns.map((p) => globToRegex(p));
}

function isExcluded(compiledPatterns, rel, name) {
  return compiledPatterns.some((rx) => rx.test(rel) || rx.test(name));
}

/**
 * Follow a symlink and push the target path if it resolves to a regular file.
 * @param {string} full - absolute path of the symlink
 * @param {string[]} results
 */
async function pushSymlinkIfFile(full, results) {
  try {
    const target = await stat(full);
    if (target.isFile()) results.push(full);
  } catch {
    // Broken symlink — skip silently.
  }
}

/**
 * Recursively collect source files in a directory.
 * @param {string} dir
 * @param {object} options
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<string[]>}
 */
const _fileListCache = new Map();

export function clearFileCache() {
  _fileListCache.clear();
}

export async function collectFiles(dir, options = {}) {
  const { exclude = [], languages } = options;

  const cacheKey = `${dir}|${JSON.stringify(exclude)}|${languages ? languages.join(",") : ""}`;
  const cached = _fileListCache.get(cacheKey);
  if (cached) return [...cached];

  const results = [];
  const compiledExcludes = compileExcludes(exclude);
  const allowedExts = new Set(
    languages
      ? languages.flatMap((l) => LANGUAGE_EXTENSIONS[l] ?? [])
      : Object.values(LANGUAGE_EXTENSIONS).flat(),
  );

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = [];
    for (const entry of entries) {
      if (entry.isDirectory() && (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)))
        continue;

      const full = join(current, entry.name);

      if (entry.isDirectory() && /worktree/i.test(full)) continue;

      const rel = full.slice(dir.length + 1);

      if (compiledExcludes.length > 0 && isExcluded(compiledExcludes, rel, entry.name)) continue;

      if (entry.isDirectory()) {
        dirs.push(full);
      } else if (entry.isFile() && allowedExts.has(extname(entry.name))) {
        results.push(full);
      } else if (entry.isSymbolicLink() && allowedExts.has(extname(entry.name))) {
        await pushSymlinkIfFile(full, results);
      }
    }
    const DIR_CONCURRENCY = 16;
    for (let j = 0; j < dirs.length; j += DIR_CONCURRENCY) {
      await Promise.all(dirs.slice(j, j + DIR_CONCURRENCY).map((d) => walk(d)));
    }
  }

  await walk(dir);
  _fileListCache.set(cacheKey, results);
  return [...results];
}

const BATCH_SIZE = 64;

/**
 * Read multiple files concurrently in batches.
 * @param {string[]} files
 * @param {number} [concurrency]
 * @returns {Promise<Map<string, string>>} file path -> content (skips unreadable)
 */
export async function readFilesBatched(files, concurrency = BATCH_SIZE) {
  const contents = new Map();
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (f) => {
        try {
          return [f, await readFile(f, "utf8")];
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) contents.set(r[0], r[1]);
    }
  }
  return contents;
}
