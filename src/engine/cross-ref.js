import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';

// Language -> file extensions
const LANGUAGE_EXTENSIONS = {
  typescript: ['.ts', '.tsx', '.js', '.jsx'],
  go: ['.go'],
  python: ['.py'],
  csharp: ['.cs'],
  java: ['.java'],
};

// Entry-point filenames that should never be flagged as dead code
const ENTRY_POINT_NAMES = new Set([
  'index.js', 'index.ts', 'index.jsx', 'index.tsx',
  'main.js', 'main.ts', 'main.go',
  'app.js', 'app.ts',
  'server.js', 'server.ts',
  '__init__.py', '__main__.py',
  'Program.cs', 'Main.java',
]);

// Glob-style patterns for test files
const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /_test\.go$/,
  /test_.*\.py$/,
  /.*_test\.py$/,
  /.*Test\.java$/,
  /.*Tests\.cs$/,
];

/**
 * Detect the language of a file by its extension.
 * @param {string} filePath
 * @returns {string|null}
 */
function detectLanguage(filePath) {
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
function isTestFile(filePath) {
  const name = basename(filePath);
  return TEST_FILE_PATTERNS.some((re) => re.test(name));
}

/**
 * Check if a file is an entry point.
 * @param {string} filePath
 * @returns {boolean}
 */
function isEntryPoint(filePath) {
  return ENTRY_POINT_NAMES.has(basename(filePath));
}

/**
 * Recursively collect source files in a directory.
 * @param {string} dir
 * @param {object} options
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<string[]>}
 */
async function collectFiles(dir, options = {}) {
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
      const full = join(current, entry.name);
      const rel = full.slice(dir.length + 1);

      const excluded = exclude.some((pattern) => {
        // Simple glob: support **/segment and *.ext
        const re = pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '@@GLOBSTAR@@')
          .replace(/\*/g, '[^/]*')
          .replace(/@@GLOBSTAR@@/g, '.*');
        return new RegExp(`^${re}$`).test(rel) || new RegExp(`^${re}$`).test(entry.name);
      });
      if (excluded) continue;

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && allowedExts.includes(extname(entry.name))) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

/**
 * Extract exported symbols from file content for a given language.
 * Returns array of {name, line} objects (line is 0-based).
 * @param {string} content
 * @param {string} language
 * @returns {Array<{name: string, line: number}>}
 */
export function extractExports(content, language) {
  const lines = content.split('\n');
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
      // top-level def
      /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
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
        exports.push({ name: match[1], line: i });
        break;
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
  const lines = content.split('\n');
  const imports = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (language === 'typescript') {
      // import { foo, bar } from '...'
      const named = trimmed.match(/^import\s+\{([^}]+)\}\s+from/);
      if (named) {
        for (const sym of named[1].split(',')) {
          const name = sym.trim().split(/\s+as\s+/).pop().trim();
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
        for (const sym of req[1].split(',')) {
          const name = sym.trim().split(/\s+as\s+/).pop().trim();
          if (name) imports.push(name);
        }
        continue;
      }
      // const foo = require('...')
      const reqDefault = trimmed.match(/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\s*\(/);
      if (reqDefault) {
        imports.push(reqDefault[1]);
        continue;
      }
    }

    if (language === 'go') {
      // import "pkg" or import alias "pkg"
      const single = trimmed.match(/^import\s+(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
      if (single) {
        const alias = single[1] ?? single[2].split('/').pop();
        imports.push(alias);
        continue;
      }
      // Inside import block: alias "path" or just "path"
      const block = trimmed.match(/^(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
      if (block) {
        const alias = block[1] ?? block[2].split('/').pop();
        imports.push(alias);
        continue;
      }
    }

    if (language === 'python') {
      // from module import foo, bar
      const fromImp = trimmed.match(/^from\s+\S+\s+import\s+(.+)/);
      if (fromImp) {
        for (const sym of fromImp[1].split(',')) {
          const name = sym.trim().split(/\s+as\s+/).pop().trim();
          if (name && name !== '*') imports.push(name);
        }
        continue;
      }
      // import module as alias
      const imp = trimmed.match(/^import\s+(.+)/);
      if (imp) {
        for (const sym of imp[1].split(',')) {
          const parts = sym.trim().split(/\s+as\s+/);
          const name = parts[parts.length - 1].trim();
          if (name) imports.push(name);
        }
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
  // package.json
  try {
    const pkgJson = await readFile(join(dir, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgJson);
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    return { type: 'npm', deps };
  } catch {
    // not found or parse error — try next
  }

  // go.mod
  try {
    const goMod = await readFile(join(dir, 'go.mod'), 'utf8');
    const deps = [];
    for (const line of goMod.split('\n')) {
      const m = line.trim().match(/^([a-zA-Z][^\s]+)\s+v[\d.]/);
      if (m) deps.push(m[1].split('/').pop());
    }
    return { type: 'go', deps };
  } catch {
    // not found
  }

  // requirements.txt
  try {
    const req = await readFile(join(dir, 'requirements.txt'), 'utf8');
    const deps = req
      .split('\n')
      .map((l) => l.trim().split(/[>=<!]/)[0].trim())
      .filter(Boolean);
    return { type: 'python', deps };
  } catch {
    // not found
  }

  // *.csproj — basic heuristic
  try {
    const entries = await readdir(dir);
    const csproj = entries.find((e) => e.endsWith('.csproj'));
    if (csproj) {
      const xml = await readFile(join(dir, csproj), 'utf8');
      const deps = [];
      for (const m of xml.matchAll(/<PackageReference\s+Include="([^"]+)"/g)) {
        deps.push(m[1]);
      }
      return { type: 'csharp', deps };
    }
  } catch {
    // not found
  }

  // pom.xml
  try {
    const pom = await readFile(join(dir, 'pom.xml'), 'utf8');
    const deps = [];
    for (const m of pom.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
      deps.push(m[1]);
    }
    return { type: 'java', deps };
  } catch {
    // not found
  }

  return null;
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
export async function scanDeadCode(path, rules = {}, options = {}) {
  const files = await collectFiles(path, options);

  // Step 1: extract exports and imports per file
  const fileData = [];
  for (const file of files) {
    const language = detectLanguage(file);
    if (!language) continue;
    let content;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const exports = extractExports(content, language);
    const imports = extractImports(content, language);
    fileData.push({ file, language, exports, imports });
  }

  // Step 2: build a global set of all imported symbol names
  const allImportedSymbols = new Set();
  for (const { imports } of fileData) {
    for (const sym of imports) {
      allImportedSymbols.add(sym);
    }
  }

  // Step 3: cross-reference — exports with zero matching imports = dead code
  const findings = [];
  for (const { file, language, exports } of fileData) {
    // Skip entry points and test files
    if (isEntryPoint(file) || isTestFile(file)) continue;

    const confidence = language === 'python' ? 0.6 : 0.9;

    for (const { name, line } of exports) {
      if (!allImportedSymbols.has(name)) {
        findings.push({
          check: 'dead-code',
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
      contents.push(await readFile(file, 'utf8'));
    } catch {
      // skip unreadable
    }
  }
  const combined = contents.join('\n');

  const findings = [];
  for (const dep of manifest.deps) {
    // Check if dep name appears anywhere in the source (loose heuristic)
    if (!combined.includes(dep)) {
      findings.push({
        check: 'unused-dep',
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
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');

    // For TypeScript: find import lines and check symbol usage
    if (language === 'typescript') {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const named = line.match(/^import\s+\{([^}]+)\}\s+from/);
        if (named) {
          for (const sym of named[1].split(',')) {
            const name = sym.trim().split(/\s+as\s+/).pop().trim();
            if (!name) continue;
            // Check usage beyond the import lines (rough: check rest of file)
            const rest = lines.slice(i + 1).join('\n');
            if (!new RegExp(`\\b${name}\\b`).test(rest)) {
              findings.push({ check: 'unused-import', file, symbol: name, importLine: i });
            }
          }
          continue;
        }
        const defaultImp = line.match(/^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from/);
        if (defaultImp) {
          const name = defaultImp[1];
          const rest = lines.slice(i + 1).join('\n');
          if (!new RegExp(`\\b${name}\\b`).test(rest)) {
            findings.push({ check: 'unused-import', file, symbol: name, importLine: i });
          }
        }
      }
    }

    if (language === 'python') {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const fromImp = line.match(/^from\s+\S+\s+import\s+(.+)/);
        if (fromImp) {
          for (const sym of fromImp[1].split(',')) {
            const name = sym.trim().split(/\s+as\s+/).pop().trim();
            if (!name || name === '*') continue;
            const rest = lines.slice(i + 1).join('\n');
            if (!new RegExp(`\\b${name}\\b`).test(rest)) {
              findings.push({ check: 'unused-import', file, symbol: name, importLine: i });
            }
          }
        }
      }
    }
  }

  return findings;
}
