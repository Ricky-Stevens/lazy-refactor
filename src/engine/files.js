import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";

import { gitignoredPaths } from "./gitignore.js";

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

// Files larger than this are skipped — minified bundles / generated blobs blow up
// the duplicate detector (char-by-char tokenize + per-window BigInt rolling hash)
// and metrics. Centralized here so both engines inherit the cap via collectFiles.
export const MAX_FILE_BYTES = 1_000_000;

// Common non-source directories that should never be scanned. Includes generated
// test-coverage and build-cache output (coverage/out/.nyc_output/.turbo/.cache):
// these are not first-party source, so scanning them only produces noise
// (duplication/metrics findings in generated bundles). This set is the always-on
// safety net — shared with the language detector (detect.js) so the two can't
// drift — and is independent of .gitignore, which catches the rest.
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
  "coverage",
  "out",
  ".nyc_output",
  ".turbo",
  ".cache",
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

  // Build the regex segment-by-segment: literal runs go through buildRegexString
  // (which escapes `(`/`)`/`|`), while brace alternations are turned into regex
  // groups directly. This way a literal `(`/`)`/`|` in a user pattern is NOT
  // mistaken for grouping syntax, while `{a,b}` brace expansion still works.
  let body = "";
  let pos = 0;
  const braceRe = /\{([^}]+)\}/g;
  for (let m = braceRe.exec(pattern); m; m = braceRe.exec(pattern)) {
    body += buildRegexString(pattern.slice(pos, m.index));
    const alts = m[1].split(",").map((s) => buildRegexString(s.trim()));
    body += `(${alts.join("|")})`;
    pos = m.index + m[0].length;
  }
  body += buildRegexString(pattern.slice(pos));

  let rx;
  try {
    rx = new RegExp(`^${body}$`);
  } catch {
    // Malformed user glob (e.g. unbalanced literal parens). Fall back to an
    // anchored fully-escaped literal match so one bad pattern can't abort the scan.
    console.warn(`lazy-refactor: ignoring malformed exclude glob "${pattern}" (matched literally)`);
    rx = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  }
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
    if (expanded.startsWith("**/", i)) {
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
      regStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
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
    if (target.isFile() && target.size <= MAX_FILE_BYTES) results.push(full);
  } catch {
    // Broken symlink — skip silently.
  }
}

// Errors that mean a real part of the tree is invisible (vs benign ENOENT/ENOTDIR
// races or broken symlinks). These are surfaced so a scan can't silently miss a
// permission-protected subtree and still report "success".
const PERMISSION_ERROR = /^(EACCES|EPERM|EIO|EMFILE|ENFILE)$/;

/**
 * Recursively collect source files in a directory.
 * @param {string} dir
 * @param {object} options
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @param {Array<{path: string, code: string}>} [options.skipped] - if provided,
 *   permission/IO errors that hid a path are recorded here (benign skips stay silent).
 * @returns {Promise<string[]>}
 */
const _fileListCache = new Map();

export function clearFileCache() {
  _fileListCache.clear();
}

export async function collectFiles(dir, options = {}) {
  const { exclude = [], languages, skipped, respectGitignore = true } = options;

  const cacheKey = `${dir}|${JSON.stringify(exclude)}|${languages ? languages.join(",") : ""}|${respectGitignore}`;
  const cached = _fileListCache.get(cacheKey);
  if (cached) return [...cached];

  const results = [];
  const compiledExcludes = compileExcludes(exclude);
  const allowedExts = new Set(
    languages
      ? languages.flatMap((l) => LANGUAGE_EXTENSIONS[l] ?? [])
      : Object.values(LANGUAGE_EXTENSIONS).flat(),
  );

  // Record a permission/IO error against a path; benign races (ENOENT/ENOTDIR) are
  // intentionally ignored. No-op unless the caller passed a `skipped` accumulator.
  const recordSkip = (err, path) => {
    if (skipped && PERMISSION_ERROR.test(err?.code ?? "")) skipped.push({ path, code: err.code });
  };

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      // A permission/IO error hides this whole subtree — surface it; benign skips silent.
      recordSkip(err, current);
      return;
    }
    const dirs = [];
    for (const entry of entries) {
      if (entry.isDirectory() && (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)))
        continue;

      const full = join(current, entry.name);

      if (entry.isDirectory() && /worktree/i.test(entry.name)) continue;

      const rel = full.slice(dir.length + 1);

      if (compiledExcludes.length > 0 && isExcluded(compiledExcludes, rel, entry.name)) continue;

      if (entry.isDirectory()) {
        dirs.push(full);
      } else if (entry.isFile() && allowedExts.has(extname(entry.name))) {
        // Skip oversized files (minified bundles / generated blobs) — see MAX_FILE_BYTES.
        try {
          if ((await stat(full)).size <= MAX_FILE_BYTES) results.push(full);
        } catch (err) {
          // Unreadable file — record permission/IO errors, skip benign ones silently.
          recordSkip(err, full);
        }
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

  // Drop anything git would ignore. SKIP_DIRS + the dotfile skip already prune
  // node_modules/.next/build/etc., so the gitignored files reaching here live in
  // non-dot dirs (coverage/report output, generated bundles) — a small set, so a
  // single post-walk batch is cheaper than spawning git per directory level.
  let final = results;
  if (respectGitignore && results.length > 0) {
    const ignored = gitignoredPaths(dir, results);
    if (ignored.size > 0) final = results.filter((p) => !ignored.has(p));
  }

  _fileListCache.set(cacheKey, final);
  return [...final];
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
          // Best-effort per-file read: a file that vanished or became unreadable between
          // collectFiles' stat and now is dropped. Directory-level permission losses (the
          // case that hides a whole subtree) are surfaced by collectFiles' `skipped`.
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
