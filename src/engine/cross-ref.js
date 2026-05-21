import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { collectFiles, LANGUAGE_EXTENSIONS } from "./files.js";

// Entry-point filenames that should never be flagged as dead code
const ENTRY_POINT_NAMES = new Set([
  // Generic
  "index.js",
  "index.ts",
  "index.jsx",
  "index.tsx",
  "main.js",
  "main.ts",
  "main.go",
  "app.js",
  "app.ts",
  "server.js",
  "server.ts",
  "__init__.py",
  "__main__.py",
  "Program.cs",
  "Main.java",
  // Next.js App Router conventional files
  "page.js",
  "page.ts",
  "page.jsx",
  "page.tsx",
  "layout.js",
  "layout.ts",
  "layout.jsx",
  "layout.tsx",
  "loading.js",
  "loading.ts",
  "loading.jsx",
  "loading.tsx",
  "error.js",
  "error.ts",
  "error.jsx",
  "error.tsx",
  "not-found.js",
  "not-found.ts",
  "not-found.jsx",
  "not-found.tsx",
  "route.js",
  "route.ts",
  "middleware.js",
  "middleware.ts",
  "template.js",
  "template.ts",
  "template.jsx",
  "template.tsx",
  // Nuxt
  "app.vue",
  // Remix
  "root.tsx",
  "root.jsx",
  "entry.client.tsx",
  "entry.server.tsx",
  // SvelteKit
  "+page.svelte",
  "+layout.svelte",
  "+server.ts",
  "+server.js",
  // CLI / bin
  "cli.js",
  "cli.ts",
  "bin.js",
  "bin.ts",
  // Deno-style
  "mod.ts",
  "mod.js",
  // Python tooling
  "setup.py",
  "setup.cfg",
  "conftest.py",
  // Next.js Pages Router
  "_app.tsx",
  "_app.ts",
  "_app.jsx",
  "_app.js",
  "_document.tsx",
  "_document.ts",
  "_document.jsx",
  "_document.js",
  "_error.tsx",
  "_error.ts",
  "_error.jsx",
  "_error.js",
  // Django
  "manage.py",
  // Python WSGI/ASGI
  "wsgi.py",
  "asgi.py",
  // .NET / Java
  "Startup.cs",
  "Application.java",
  // Next.js App Router — additional conventional files
  "global-error.tsx",
  "global-error.ts",
  "global-error.jsx",
  "global-error.js",
  "default.tsx",
  "default.ts",
  "default.jsx",
  "default.js",
  "instrumentation.ts",
  "instrumentation.js",
  "opengraph-image.tsx",
  "opengraph-image.ts",
  "opengraph-image.js",
  "twitter-image.tsx",
  "twitter-image.ts",
  "twitter-image.js",
  "sitemap.ts",
  "sitemap.js",
  "robots.ts",
  "robots.js",
  "manifest.ts",
  "manifest.js",
]);

// Glob-style patterns for test files
const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /_test\.go$/,
  /test_.*\.py$/,
  /.*_test\.py$/,
  /.*Test\.java$/,
  /.*Tests\.java$/,
  /.*Tests\.cs$/,
];

/**
 * Detect the language of a file by its extension.
 * @param {string} filePath
 * @returns {string|null}
 */
export function detectLanguage(filePath) {
  const ext = extname(filePath);
  for (const [lang, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (exts.includes(ext)) return lang;
  }
  return null;
}

/**
 * Check if a file is a test file.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isTestFile(filePath) {
  const name = basename(filePath);
  return TEST_FILE_PATTERNS.some((re) => re.test(name));
}

/**
 * Check if a file is an entry point.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isEntryPoint(filePath) {
  return ENTRY_POINT_NAMES.has(basename(filePath));
}

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

/**
 * Extract imported symbols/modules from file content for a given language.
 * Returns array of symbol names.
 * @param {string} content
 * @param {string} language
 * @returns {string[]}
 */
export function extractImports(content, language) {
  const lines = content.split("\n");
  const imports = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (language === "typescript") {
      // import React, { useState } from 'react' — default + named together
      const mixed = trimmed.match(/^import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]+)\}\s+from/);
      if (mixed) {
        imports.push(mixed[1]);
        for (const sym of mixed[2].split(",")) {
          const parts = sym.trim().split(/\s+as\s+/);
          const name = parts[0].trim();
          if (name) imports.push(name);
        }
        continue;
      }
      // import type { Foo } from './bar'
      const typeOnly = trimmed.match(/^import\s+type\s+\{([^}]+)\}\s+from/);
      if (typeOnly) {
        for (const sym of typeOnly[1].split(",")) {
          const parts = sym.trim().split(/\s+as\s+/);
          const name = parts[0].trim();
          if (name) imports.push(name);
        }
        continue;
      }
      // import { foo, bar } from '...'
      const named = trimmed.match(/^import\s+\{([^}]+)\}\s+from/);
      if (named) {
        for (const sym of named[1].split(",")) {
          const parts = sym.trim().split(/\s+as\s+/);
          const name = parts[0].trim(); // exported name, not the local alias
          if (name) imports.push(name);
        }
        continue;
      }
      // import defaultExport from '...'
      const defaultImp = trimmed.match(/^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from/);
      if (defaultImp) {
        imports.push(defaultImp[1]);
        continue;
      }
      // import * as ns from '...'
      const star = trimmed.match(/^import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from/);
      if (star) {
        imports.push(star[1]);
        continue;
      }
      // const { foo } = require('...')
      const req = trimmed.match(/(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(/);
      if (req) {
        for (const sym of req[1].split(",")) {
          // Handle JS destructuring rename syntax: { foo: bar } → bar
          const renamed = sym.trim().split(":");
          const afterColon = renamed.length > 1 ? renamed[1].trim() : renamed[0].trim();
          // Also handle `as` aliases (less common in require, but possible)
          const name = afterColon
            .split(/\s+as\s+/)
            .pop()
            .trim();
          if (name) imports.push(name);
        }
        continue;
      }
      // const foo = require('...')
      const reqDefault = trimmed.match(
        /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\s*\(/,
      );
      if (reqDefault) {
        imports.push(reqDefault[1]);
        continue;
      }
    }

    // Go imports are handled in a dedicated block after this per-line loop
    // (state tracking for `import (...)` cannot be done correctly inline here).

    if (language === "python") {
      // from module import foo, bar
      const fromImp = trimmed.match(/^from\s+\S+\s+import\s+(.+)/);
      if (fromImp) {
        for (const sym of fromImp[1].split(",")) {
          const parts = sym.trim().split(/\s+as\s+/);
          const name = parts[0].trim(); // exported name, not the local alias
          if (name && name !== "*") imports.push(name);
        }
        continue;
      }
      // import module as alias
      const imp = trimmed.match(/^import\s+(.+)/);
      if (imp) {
        for (const sym of imp[1].split(",")) {
          const parts = sym.trim().split(/\s+as\s+/);
          const name = parts[parts.length - 1].trim();
          if (name) imports.push(name);
        }
      }
    }

    if (language === "csharp") {
      // using X.Y.Z;  or  using Alias = X.Y.Z;
      // For "using Alias = X.Y.Z;" we want the alias (left of =)
      const aliasMatch = trimmed.match(/^using\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (aliasMatch) {
        imports.push(aliasMatch[1]);
        continue;
      }
      // Plain using directive — push the FULL namespace path instead of just
      // the last segment. The last segment (e.g. "Generic" from
      // "System.Collections.Generic") never matches actual type usage (List<T>),
      // causing ~250 false positives per C# project. scanDeadCode handles C#
      // via grep instead of import-set matching, so these full paths are only
      // informational.
      const plainMatch = trimmed.match(/^using\s+([\w.]+)\s*;/);
      if (plainMatch) {
        imports.push(plainMatch[1]);
        continue;
      }
    }

    if (language === "java") {
      // import static X.Y.Z;  or  import X.Y.Z;
      const javaMatch = trimmed.match(/^import\s+(?:static\s+)?([\w.]+)\s*;/);
      if (javaMatch) {
        const segments = javaMatch[1].split(".");
        imports.push(segments[segments.length - 1]);
      }
    }
  }

  // Go: parse imports with proper block tracking so quoted strings outside
  // an `import (...)` block don't get treated as imports.
  if (language === "go") {
    let inImportBlock = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.match(/^import\s*\($/)) {
        inImportBlock = true;
        continue;
      }
      if (inImportBlock && trimmed === ")") {
        inImportBlock = false;
        continue;
      }

      // Single-line import (always valid)
      const single = trimmed.match(/^import\s+(?:([A-Za-z_.][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
      if (single) {
        const alias = single[1] ?? single[2].split("/").pop();
        imports.push(alias);
        continue;
      }

      // Inside import block only: alias "path" or just "path"
      if (inImportBlock) {
        const block = trimmed.match(/^(?:([A-Za-z_.][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
        if (block) {
          const alias = block[1] ?? block[2].split("/").pop();
          imports.push(alias);
        }
      }
    }
  }

  // TypeScript: second pass over the full file to catch multi-line named imports
  // like `import {\n  foo,\n  bar,\n} from '...'` which the per-line loop misses.
  if (language === "typescript") {
    const multiLineRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
    let mlMatch;
    while ((mlMatch = multiLineRe.exec(content)) !== null) {
      for (const sym of mlMatch[1].split(",")) {
        const name = sym
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (name && !imports.includes(name)) imports.push(name);
      }
    }
  }

  return imports;
}

/**
 * Detect and parse the package manifest file in a directory.
 * Returns { type, deps } where deps is an array of dependency names.
 * @param {string} dir
 * @returns {Promise<{type: string, deps: string[]}|null>}
 */
export async function detectManifest(dir) {
  // Aggregate across every manifest we can find — polyglot repos (e.g. a Go
  // backend alongside a Node.js frontend) need all dependencies considered,
  // not just whichever file we happened to try first.
  let type = null;
  const deps = [];

  // package.json
  try {
    const pkgJson = await readFile(join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgJson);
    type = type ?? "npm";
    deps.push(
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    );
  } catch {
    // not found or parse error
  }

  // go.mod
  try {
    const goMod = await readFile(join(dir, "go.mod"), "utf8");
    type = type ?? "go";
    for (const line of goMod.split("\n")) {
      const m = line.trim().match(/^([a-zA-Z][^\s]+)\s+v[\d.]/);
      if (m) deps.push(m[1].split("/").pop());
    }
  } catch {
    // not found
  }

  // requirements.txt
  try {
    const req = await readFile(join(dir, "requirements.txt"), "utf8");
    type = type ?? "python";
    deps.push(
      ...req
        .split("\n")
        .map((l) =>
          l
            .trim()
            .split(/[>=<!]/)[0]
            .trim(),
        )
        .filter(Boolean),
    );
  } catch {
    // not found
  }

  // *.csproj — basic heuristic
  try {
    const entries = await readdir(dir);
    const csproj = entries.find((e) => e.endsWith(".csproj"));
    if (csproj) {
      const xml = await readFile(join(dir, csproj), "utf8");
      type = type ?? "csharp";
      for (const m of xml.matchAll(/<PackageReference\s+Include="([^"]+)"/g)) {
        deps.push(m[1]);
      }
    }
  } catch {
    // not found
  }

  // pom.xml
  try {
    const pom = await readFile(join(dir, "pom.xml"), "utf8");
    type = type ?? "java";
    for (const m of pom.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
      deps.push(m[1]);
    }
  } catch {
    // not found
  }

  if (deps.length === 0 && type === null) return null;
  return { type: type ?? "unknown", deps };
}

/**
 * Return a Set of absolute file paths that were added to git within the last `days` days.
 * Returns an empty Set if git is unavailable or the directory is not a repository.
 * @param {string} repoPath
 * @param {number} [days=30]
 * @returns {Promise<Set<string>>}
 */
export async function getRecentlyAddedFiles(repoPath, days = 30) {
  return new Promise((resolve) => {
    const args = [
      "-C",
      repoPath,
      "log",
      "--diff-filter=A",
      `--since=${days} days ago`,
      "--name-only",
      "--pretty=format:",
    ];
    execFile("git", args, (err, stdout) => {
      if (err) {
        resolve(new Set());
        return;
      }
      const files = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((rel) => join(repoPath, rel));
      resolve(new Set(files));
    });
  });
}

/**
 * Scan for dead code (exported symbols with no matching imports anywhere else).
 * @param {string} path - Directory to scan
 * @param {object} [rules] - Optional rule overrides (unused currently; patterns are built-in)
 * @param {object} [options]
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array<{check: string, file: string, symbol: string, exportLine: number, confidence: number}>>}
 */
export async function scanDeadCode(path, _rules = {}, options = {}) {
  const files = await collectFiles(path, options);

  // Step 1: extract exports and imports per file
  const fileData = [];
  for (const file of files) {
    const language = detectLanguage(file);
    if (!language) continue;
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const exports = extractExports(content, language);
    const imports = extractImports(content, language);
    fileData.push({ file, language, content, exports, imports });
  }

  // Step 2: build per-language import sets to avoid cross-language false negatives
  // (e.g. TS and Python sharing common names like "parse", "validate", "transform")
  const importsByLanguage = {};
  for (const { language, imports } of fileData) {
    if (!importsByLanguage[language]) importsByLanguage[language] = new Set();
    for (const sym of imports) {
      importsByLanguage[language].add(sym);
    }
  }

  // Step 3: cross-reference — exports with zero matching imports = dead code
  // Optionally boost confidence for recently-added files (likely AI pivot debris)
  const recentFiles = await getRecentlyAddedFiles(path, 30);

  const findings = [];
  for (const { file, language, exports } of fileData) {
    // Skip entry points and test files
    if (isEntryPoint(file) || isTestFile(file)) continue;

    let baseConfidence = language === "python" ? 0.6 : 0.9;
    // Boost confidence for files recently added to git — more likely to be unused pivot code
    if (recentFiles.has(file)) baseConfidence = Math.min(1, baseConfidence + 0.05);

    for (const exp of exports) {
      const { name, line } = exp;
      // Go imports packages, not symbols — import sets will never contain
      // Go exported symbol names. Instead, grep all other Go file content for the
      // symbol name as a word boundary match.
      if (language === "go") {
        const otherContents = fileData
          .filter((fd) => fd.file !== file && fd.file.endsWith(".go"))
          .map((fd) => fd.content)
          .join("\n");
        const used = new RegExp(`\\b${name}\\b`).test(otherContents);
        if (!used) {
          findings.push({
            check: "dead-code",
            file,
            symbol: name,
            exportLine: line,
            confidence: 0.7,
          });
        }
        continue;
      }

      // C# namespace using directives don't map to symbol names — grep other
      // .cs files for the symbol as a word boundary match (same approach as Go).
      if (language === "csharp") {
        const otherContents = fileData
          .filter((fd) => fd.file !== file && fd.file.endsWith(".cs"))
          .map((fd) => fd.content)
          .join("\n");
        const used = new RegExp(`\\b${name}\\b`).test(otherContents);
        if (!used) {
          findings.push({
            check: "dead-code",
            file,
            symbol: name,
            exportLine: line,
            confidence: 0.7,
          });
        }
        continue;
      }

      // For TS/Python/Java: check against the matching language's import set
      const langImports = importsByLanguage[language] ?? new Set();

      // Python: decorated functions/classes get lower confidence (0.3) because
      // decorators like @app.route, @pytest.fixture etc. register symbols
      // without explicit imports (~60-100 FPs per Flask project otherwise).
      let confidence = baseConfidence;
      if (language === "python" && exp.decorated) {
        confidence = 0.3;
      }

      if (!langImports.has(name)) {
        findings.push({
          check: "dead-code",
          file,
          symbol: name,
          exportLine: line,
          confidence,
        });
      }
    }
  }

  return findings;
}

/**
 * Scan for unused dependencies declared in the package manifest.
 * @param {string} path - Directory to scan
 * @param {object} [options]
 * @param {string[]} [options.exclude]
 * @returns {Promise<Array<{check: string, dep: string, manifest: string}>>}
 */
export async function scanUnusedDeps(path, options = {}) {
  const manifest = await detectManifest(path);
  if (!manifest) return [];

  const files = await collectFiles(path, options);

  // Build combined content from all source files for grep-style check
  const contents = [];
  for (const file of files) {
    try {
      contents.push(await readFile(file, "utf8"));
    } catch {
      // skip unreadable
    }
  }
  const combined = contents.join("\n");

  const findings = [];
  for (const dep of manifest.deps) {
    // Word-boundary check avoids false-negatives where a dep name (e.g. "lodash")
    // appears as a substring of an unrelated identifier (e.g. "lodash-es" in
    // another dep's metadata, or "fooexpress" in source).
    const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\b${escaped}\\b`).test(combined)) {
      findings.push({
        check: "unused-dep",
        dep,
        manifest: manifest.type,
      });
    }
  }

  return findings;
}

/**
 * Scan for unused imports within individual files.
 * @param {string} path - Directory to scan
 * @param {object} [options]
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array<{check: string, file: string, symbol: string, importLine: number}>>}
 */
export async function scanUnusedImports(path, options = {}) {
  const files = await collectFiles(path, options);
  const findings = [];

  for (const file of files) {
    if (isTestFile(file)) continue;
    const language = detectLanguage(file);
    if (!language) continue;

    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");

    // For TypeScript: find import lines and check symbol usage
    if (language === "typescript") {
      // Track which symbols we've already checked (to avoid duplicates from
      // the multi-line second pass below)
      const checkedSymbols = new Set();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Fix 5: mixed default+named imports — import React, { useState } from 'react'
        const mixed = line.match(/^import\s+\w+\s*,\s*\{([^}]+)\}\s+from/);
        if (mixed) {
          for (const sym of mixed[1].split(",")) {
            const name = sym
              .trim()
              .split(/\s+as\s+/)
              .pop()
              .trim();
            if (!name) continue;
            checkedSymbols.add(name);
            const rest = lines.slice(i + 1).join("\n");
            if (!new RegExp(`\\b${name}\\b`).test(rest)) {
              findings.push({ check: "unused-import", file, symbol: name, importLine: i });
            }
          }
          continue;
        }

        const named = line.match(/^import\s+\{([^}]+)\}\s+from/);
        if (named) {
          for (const sym of named[1].split(",")) {
            const name = sym
              .trim()
              .split(/\s+as\s+/)
              .pop()
              .trim();
            if (!name) continue;
            checkedSymbols.add(name);
            // Check usage beyond the import lines (rough: check rest of file)
            const rest = lines.slice(i + 1).join("\n");
            if (!new RegExp(`\\b${name}\\b`).test(rest)) {
              findings.push({ check: "unused-import", file, symbol: name, importLine: i });
            }
          }
          continue;
        }
        const defaultImp = line.match(/^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from/);
        if (defaultImp) {
          const name = defaultImp[1];
          checkedSymbols.add(name);
          const rest = lines.slice(i + 1).join("\n");
          if (!new RegExp(`\\b${name}\\b`).test(rest)) {
            findings.push({ check: "unused-import", file, symbol: name, importLine: i });
          }
        }
      }

      // Fix 6: second pass for multi-line import blocks like:
      //   import {
      //     foo,
      //     bar,
      //   } from '...'
      // The per-line loop above misses these because `{` and `}` are on different lines.
      const multiLineRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
      let mlMatch;
      while ((mlMatch = multiLineRe.exec(content)) !== null) {
        for (const sym of mlMatch[1].split(",")) {
          const name = sym
            .trim()
            .split(/\s+as\s+/)
            .pop()
            .trim();
          if (!name || checkedSymbols.has(name)) continue;
          checkedSymbols.add(name);
          // Find the line number of the opening import for this match
          const upToMatch = content.slice(0, mlMatch.index);
          const importLine = upToMatch.split("\n").length - 1;
          // Check usage after the entire import block
          const afterImport = content.slice(mlMatch.index + mlMatch[0].length);
          if (!new RegExp(`\\b${name}\\b`).test(afterImport)) {
            findings.push({ check: "unused-import", file, symbol: name, importLine });
          }
        }
      }
    }

    if (language === "go") {
      let inImportBlock = false;
      for (let i = 0; i < lines.length; i++) {
        const trimmedLine = lines[i].trim();
        if (trimmedLine === "import (") {
          inImportBlock = true;
          continue;
        }
        if (inImportBlock && trimmedLine === ")") {
          inImportBlock = false;
          continue;
        }

        let alias = null;
        if (inImportBlock) {
          const m = trimmedLine.match(/^(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
          if (m) alias = m[1] ?? m[2].split("/").pop();
        } else {
          const m = trimmedLine.match(/^import\s+(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
          if (m) alias = m[1] ?? m[2].split("/").pop();
        }
        if (!alias || alias === "_" || alias === ".") continue;
        const rest = lines.slice(i + 1).join("\n");
        if (!new RegExp(`\\b${alias}\\b`).test(rest)) {
          findings.push({ check: "unused-import", file, symbol: alias, importLine: i });
        }
      }
    }

    if (language === "python") {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const fromImp = line.match(/^from\s+\S+\s+import\s+(.+)/);
        if (fromImp) {
          for (const sym of fromImp[1].split(",")) {
            const name = sym
              .trim()
              .split(/\s+as\s+/)
              .pop()
              .trim();
            if (!name || name === "*") continue;
            const rest = lines.slice(i + 1).join("\n");
            if (!new RegExp(`\\b${name}\\b`).test(rest)) {
              findings.push({ check: "unused-import", file, symbol: name, importLine: i });
            }
          }
        }
      }
    }

    // C# is intentionally skipped for unused-import scanning. Namespace `using`
    // directives (e.g. `using System.Collections.Generic;`) cannot be reliably
    // checked with regex — you'd need type resolution to know which types from
    // the namespace are actually referenced. Checking the last segment causes
    // false positives (e.g. "Generic" never appears in code that uses List<T>).

    if (language === "java") {
      for (let i = 0; i < lines.length; i++) {
        const trimmedLine = lines[i].trim();
        const javaMatch = trimmedLine.match(/^import\s+(?:static\s+)?([\w.]+)\s*;/);
        if (javaMatch) {
          const segments = javaMatch[1].split(".");
          const name = segments[segments.length - 1];
          const rest = lines.slice(i + 1).join("\n");
          if (!new RegExp(`\\b${name}\\b`).test(rest)) {
            findings.push({ check: "unused-import", file, symbol: name, importLine: i });
          }
        }
      }
    }
  }

  return findings;
}

// scanInconsistentPatterns and scanOverEngineering have moved to ./patterns.js
