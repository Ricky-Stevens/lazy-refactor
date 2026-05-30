import { dirname, resolve } from "node:path";

/**
 * Module-resolution + reachability analysis for dead-code detection.
 *
 * The import-set approach in scan-dead-code can't see two ways a symbol stays
 * reachable without ever appearing in a named import, so it would flag live code
 * as dead — the dangerous class, since the fixer's remedy is deletion:
 *
 *   1. `export * from './x'` barrels — re-export every symbol of `./x` without
 *      naming any, so a symbol consumed only through the barrel looks unused.
 *   2. dynamic `import('./x')` (incl. `await import()`, `import().then()`,
 *      next/dynamic's `dynamic(() => import('./x'))`) — the module is loaded but
 *      its symbols are reached via the namespace object, not a static import.
 *
 * Both reduce to: the *whole module* is externally reachable. We resolve the
 * specifier to a real corpus file and mark that file so dead-code skips ALL its
 * exports. Skipping (vs lowering confidence) is deliberate: a missed dead export
 * is harmless, a deleted live one breaks the build.
 *
 * Only relative specifiers (`./`, `../`) are resolved — path aliases (`@/…`) need
 * tsconfig `paths` we don't parse, so alias-only barrels remain a residual FP
 * source (documented, not silently wrong).
 */

const TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

// A source extension on a specifier. Under nodenext, a barrel re-exports a `.ts`
// file using a `.js` specifier (`export * from './x.js'` for x.ts on disk), so we
// also try the extension-stripped base — otherwise the live file resolves to
// nothing and its exports get flagged dead (the one residual that fails UNSAFE).
const SRC_EXT_RE = /\.(?:m|c)?[jt]sx?$/;

// `export *` / `export * as ns` re-export of another module.
const STAR_REEXPORT_RE = /export\s+\*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s+from\s+["'`]([^"'`]+)["'`]/g;
// Dynamic import of a string-literal specifier — the `import("…")` core covers
// await import, .then chaining, and the next/dynamic arrow-import wrapper alike.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

/**
 * Resolve a relative module specifier to a file that exists in the scanned corpus.
 * Tries the bare path, each source extension, and an index file under a directory.
 * @param {string} fromFile - absolute path of the file containing the specifier
 * @param {string} spec - the import/re-export specifier
 * @param {Set<string>} corpus - absolute paths of all scanned files
 * @returns {string|null} the resolved corpus path, or null if unresolved
 */
function resolveSpec(fromFile, spec, corpus) {
  if (!spec.startsWith(".")) return null;
  const fromDir = dirname(fromFile);
  // Try the specifier as written, then with a source extension stripped (nodenext).
  const bases = [resolve(fromDir, spec)];
  const stripped = spec.replace(SRC_EXT_RE, "");
  if (stripped !== spec) bases.push(resolve(fromDir, stripped));

  for (const base of bases) {
    if (corpus.has(base)) return base;
    for (const ext of TS_EXTS) if (corpus.has(base + ext)) return base + ext;
    for (const ext of TS_EXTS) {
      const idx = `${base}/index${ext}`;
      if (corpus.has(idx)) return idx;
    }
  }
  return null;
}

/**
 * Compute the set of files whose exports are reachable via an `export *` barrel
 * or a dynamic `import()` and must therefore be exempt from dead-code flagging.
 * @param {Array<{file: string, language: string, content: string}>} fileData
 * @returns {Set<string>} absolute paths of barrel/dynamic-reachable files
 */
export function computeReachableFiles(fileData) {
  const corpus = new Set(fileData.map((fd) => fd.file));
  const reachable = new Set();

  for (const { file, language, content } of fileData) {
    // Barrels and dynamic import() are a JS/TS construct; other languages route
    // dead-code through their own (grep/import-set) paths.
    if (language !== "typescript") continue;
    for (const re of [STAR_REEXPORT_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      for (let m = re.exec(content); m; m = re.exec(content)) {
        const target = resolveSpec(file, m[1], corpus);
        if (target) reachable.add(target);
      }
    }
  }

  return reachable;
}
