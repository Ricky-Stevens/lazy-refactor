import { collectFiles, readFilesBatched } from "../files.js";
import { detectLanguage, isTestFile } from "./classify.js";
import { stripTsComments, stripTypeModifier } from "./ts-text.js";

/** Escape regex metacharacters so an arbitrary symbol fragment can't break (or inject into) a RegExp. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Prefix-offset table: offsets[i] is the char index where line i starts within
 * lines.join("\n"). Built once per file so isUnused slices the joined content
 * without re-joining per import (keeps barrel/index files linear, not quadratic).
 * @param {string[]} lines
 */
function buildLineOffsets(lines) {
  const offsets = new Array(lines.length);
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = acc;
    acc += lines[i].length + 1; // +1 for the "\n" join separator
  }
  return offsets;
}

/**
 * Returns true if `name` does not appear after line `afterIndex` in the file.
 * @param {string} joined - lines.join("\n"), built once per file
 * @param {number[]} offsets - prefix-offset table from buildLineOffsets
 * @param {string} name - local alias to check
 * @param {number} afterIndex - line index to start checking AFTER
 */
function isUnused(joined, offsets, name, afterIndex) {
  // Start at the char index where the line after `afterIndex` begins.
  const start = afterIndex + 1 < offsets.length ? offsets[afterIndex + 1] : joined.length;
  return !new RegExp(`\\b${escapeRe(name)}\\b`).test(joined.slice(start));
}

/**
 * Extract the local alias from a "foo" or "foo as bar" symbol fragment.
 * scanUnusedImports checks local usage, so the alias (bar) is what matters here.
 * @param {string} sym
 * @returns {string}
 */
function localAlias(sym) {
  const alias = sym
    .trim()
    .split(/\s+as\s+/)
    .pop()
    .trim();
  // Strip the inline `type` modifier AFTER taking the alias: for `type Foo`
  // (no alias) the local name is `Foo`; for `type Foo as Bar` it's `Bar`.
  return stripTypeModifier(alias);
}

/**
 * Scan named symbols from a braces string like "foo, bar as b, baz".
 * Returns findings for any locally unused symbols.
 * @param {string} bracesContent
 * @param {string} joined
 * @param {number[]} offsets
 * @param {number} importLine
 * @param {string} file
 * @param {Set<string>} checkedSymbols - mutated in place to track seen names
 */
function findUnusedNamedSymbols(bracesContent, joined, offsets, importLine, file, checkedSymbols) {
  const findings = [];
  for (const sym of bracesContent.split(",")) {
    const name = localAlias(sym);
    if (!name) continue;
    if (checkedSymbols.has(name)) continue;
    checkedSymbols.add(name);
    if (isUnused(joined, offsets, name, importLine)) {
      findings.push({ check: "unused-import", file, symbol: name, importLine });
    }
  }
  return findings;
}

/**
 * Scan a TypeScript/JavaScript file for unused imports.
 * Uses local alias for usage checking (scanUnusedImports semantics).
 *
 * Two-pass strategy:
 *  Pass 1: handles mixed default+named and plain default imports (single-line only).
 *  Pass 2: handles named import blocks via regex — covers both single-line and multi-line
 *          forms including "import type { ... }". Skips already-checked symbols.
 */
function scanTypeScript(rawLines, file) {
  // Blank out comments first so imports written inside JSDoc @example blocks or
  // commented-out code aren't parsed as real imports (a major false-positive source).
  // stripTsComments preserves line count, so reported importLine indices stay correct.
  const lines = stripTsComments(rawLines.join("\n")).split("\n");
  const joined = lines.join("\n");
  const offsets = buildLineOffsets(lines);
  const findings = [];
  const checkedSymbols = new Set();

  // Pass 1: mixed default+named and plain default imports
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Mixed: import React, { useState } from 'react'
    const mixed = line.match(/^import\s+\w+\s*,\s*\{([^}]+)\}\s+from/);
    if (mixed) {
      findings.push(...findUnusedNamedSymbols(mixed[1], joined, offsets, i, file, checkedSymbols));
      continue;
    }

    // Default: import Foo from '...'
    const defaultImp = line.match(/^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from/);
    if (defaultImp) {
      const name = defaultImp[1];
      checkedSymbols.add(name);
      if (isUnused(joined, offsets, name, i)) {
        findings.push({ check: "unused-import", file, symbol: name, importLine: i });
      }
    }
  }

  // Pass 2: named import blocks (single-line or multi-line, including import type)
  const multiLineRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
  let mlMatch;
  while ((mlMatch = multiLineRe.exec(joined)) !== null) {
    const importLine = joined.slice(0, mlMatch.index).split("\n").length - 1;
    const afterImport = joined.slice(mlMatch.index + mlMatch[0].length);
    const regexCache = new Map();

    for (const sym of mlMatch[1].split(",")) {
      const name = localAlias(sym);
      if (!name || checkedSymbols.has(name)) continue;
      checkedSymbols.add(name);
      let re = regexCache.get(name);
      if (!re) {
        re = new RegExp(`\\b${escapeRe(name)}\\b`);
        regexCache.set(name, re);
      }
      if (!re.test(afterImport)) {
        findings.push({ check: "unused-import", file, symbol: name, importLine });
      }
    }
  }

  return findings;
}

/**
 * Scan a Go file for unused imports.
 */
function scanGo(lines, file) {
  const joined = lines.join("\n");
  const offsets = buildLineOffsets(lines);
  const findings = [];
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

    const alias = parseGoImportAlias(trimmedLine, inImportBlock);
    if (!alias || alias === "_" || alias === ".") continue;

    if (isUnused(joined, offsets, alias, i)) {
      findings.push({ check: "unused-import", file, symbol: alias, importLine: i });
    }
  }

  return findings;
}

/**
 * Parse a Go import line and return the local alias.
 * Block form:  `alias "path"` or `"path"`.
 * Inline form: `import alias "path"` or `import "path"`.
 * @param {string} trimmedLine
 * @param {boolean} inImportBlock
 * @returns {string|null}
 */
function parseGoImportAlias(trimmedLine, inImportBlock) {
  const re = inImportBlock
    ? /^(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"/
    : /^import\s+(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"/;
  const m = trimmedLine.match(re);
  if (m) return m[1] ?? m[2].split("/").pop();
  return null;
}

/**
 * Scan a Python file for unused imports. Handles backslash line-continuation
 * (`from mod import foo, \` + continuation lines): symbol fragments are
 * accumulated across physical lines before splitting on comma. importLine stays
 * pinned to the original `from` line; the usage check starts after the LAST
 * consumed continuation line so a continued name used later isn't falsely flagged.
 */
function scanPython(lines, file) {
  const joined = lines.join("\n");
  const offsets = buildLineOffsets(lines);
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const fromImp = line.match(/^from\s+\S+\s+import\s+(.+)/);
    if (!fromImp) continue;

    // Accumulate backslash-continued fragments; `last` = index of the final
    // consumed physical line (usage is checked after it).
    let symbols = fromImp[1];
    let last = i;
    while (symbols.trimEnd().endsWith("\\")) {
      symbols = symbols.trimEnd().slice(0, -1);
      if (last + 1 >= lines.length) break;
      last += 1;
      symbols += ` ${lines[last]}`;
    }

    for (const sym of symbols.split(",")) {
      const name = localAlias(sym);
      if (!name || name === "*" || name === "\\") continue;
      if (isUnused(joined, offsets, name, last)) {
        findings.push({ check: "unused-import", file, symbol: name, importLine: i });
      }
    }

    i = last; // skip past consumed continuation lines
  }

  return findings;
}

/**
 * Scan a Java file for unused imports.
 */
function scanJava(lines, file) {
  const joined = lines.join("\n");
  const offsets = buildLineOffsets(lines);
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmedLine = lines[i].trim();
    const javaMatch = trimmedLine.match(/^import\s+(?:static\s+)?([\w.]+)\s*;/);
    if (!javaMatch) continue;

    const segments = javaMatch[1].split(".");
    const name = segments[segments.length - 1];
    if (isUnused(joined, offsets, name, i)) {
      findings.push({ check: "unused-import", file, symbol: name, importLine: i });
    }
  }

  return findings;
}

// C# is intentionally skipped for unused-import scanning. Namespace `using`
// directives (e.g. `using System.Collections.Generic;`) cannot be reliably
// checked with regex — you'd need type resolution to know which types from
// the namespace are actually referenced. Checking the last segment causes
// false positives (e.g. "Generic" never appears in code that uses List<T>).

/** Per-language scanner dispatch map. C# is intentionally absent (see note above). */
const LANGUAGE_SCANNERS = {
  typescript: scanTypeScript,
  go: scanGo,
  python: scanPython,
  java: scanJava,
};

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
  const contents = await readFilesBatched(files);
  const findings = [];

  for (const [file, content] of contents) {
    if (isTestFile(file)) continue;
    const language = detectLanguage(file);
    if (!language) continue;

    const scanFn = LANGUAGE_SCANNERS[language];
    if (!scanFn) continue;

    const lines = content.split("\n");
    findings.push(...scanFn(lines, file));
  }

  return findings;
}
