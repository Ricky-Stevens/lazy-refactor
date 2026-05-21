import { readFile } from "node:fs/promises";
import { collectFiles } from "../files.js";
import { detectLanguage, isTestFile } from "./classify.js";

/**
 * Returns true if `name` does not appear after `afterIndex` in `lines`.
 * @param {string[]} lines
 * @param {string} name - local alias to check
 * @param {number} afterIndex - line index to start checking from
 */
function isUnused(lines, name, afterIndex) {
  const rest = lines.slice(afterIndex + 1).join("\n");
  return !new RegExp(`\\b${name}\\b`).test(rest);
}

/**
 * Extract the local alias from a "foo" or "foo as bar" symbol fragment.
 * scanUnusedImports checks local usage, so the alias (bar) is what matters here.
 * @param {string} sym
 * @returns {string}
 */
function localAlias(sym) {
  return sym.trim().split(/\s+as\s+/).pop().trim();
}

/**
 * Scan named symbols from a braces string like "foo, bar as b, baz".
 * Returns findings for any locally unused symbols.
 * @param {string} bracesContent
 * @param {string[]} lines
 * @param {number} importLine
 * @param {string} file
 * @param {Set<string>} checkedSymbols - mutated in place to track seen names
 */
function findUnusedNamedSymbols(bracesContent, lines, importLine, file, checkedSymbols) {
  const findings = [];
  for (const sym of bracesContent.split(",")) {
    const name = localAlias(sym);
    if (!name) continue;
    if (checkedSymbols.has(name)) continue;
    checkedSymbols.add(name);
    if (isUnused(lines, name, importLine)) {
      findings.push({ check: "unused-import", file, symbol: name, importLine });
    }
  }
  return findings;
}

/**
 * Scan a TypeScript/JavaScript file for unused imports.
 * Uses local alias for usage checking (scanUnusedImports semantics).
 */
function scanTypeScript(lines, file) {
  const findings = [];
  const checkedSymbols = new Set();

  // Single-line pass
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Mixed: import React, { useState } from 'react'
    const mixed = line.match(/^import\s+\w+\s*,\s*\{([^}]+)\}\s+from/);
    if (mixed) {
      findings.push(...findUnusedNamedSymbols(mixed[1], lines, i, file, checkedSymbols));
      continue;
    }

    // Named: import { foo, bar as b } from '...'
    const named = line.match(/^import\s+\{([^}]+)\}\s+from/);
    if (named) {
      findings.push(...findUnusedNamedSymbols(named[1], lines, i, file, checkedSymbols));
      continue;
    }

    // Default: import Foo from '...'
    const defaultImp = line.match(/^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from/);
    if (defaultImp) {
      const name = defaultImp[1];
      checkedSymbols.add(name);
      if (isUnused(lines, name, i)) {
        findings.push({ check: "unused-import", file, symbol: name, importLine: i });
      }
    }
  }

  // Multi-line import blocks: import {\n  foo,\n  bar,\n} from '...'
  const content = lines.join("\n");
  const multiLineRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
  let mlMatch;
  while ((mlMatch = multiLineRe.exec(content)) !== null) {
    const importLine = content.slice(0, mlMatch.index).split("\n").length - 1;
    const afterImport = content.slice(mlMatch.index + mlMatch[0].length);

    for (const sym of mlMatch[1].split(",")) {
      const name = localAlias(sym);
      if (!name || checkedSymbols.has(name)) continue;
      checkedSymbols.add(name);
      if (!new RegExp(`\\b${name}\\b`).test(afterImport)) {
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

    if (isUnused(lines, alias, i)) {
      findings.push({ check: "unused-import", file, symbol: alias, importLine: i });
    }
  }

  return findings;
}

/**
 * Parse a Go import line and return the local alias.
 * @param {string} trimmedLine
 * @param {boolean} inImportBlock
 * @returns {string|null}
 */
function parseGoImportAlias(trimmedLine, inImportBlock) {
  if (inImportBlock) {
    const m = trimmedLine.match(/^(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
    if (m) return m[1] ?? m[2].split("/").pop();
  } else {
    const m = trimmedLine.match(/^import\s+(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"/);
    if (m) return m[1] ?? m[2].split("/").pop();
  }
  return null;
}

/**
 * Scan a Python file for unused imports.
 */
function scanPython(lines, file) {
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const fromImp = line.match(/^from\s+\S+\s+import\s+(.+)/);
    if (!fromImp) continue;

    for (const sym of fromImp[1].split(",")) {
      const name = localAlias(sym);
      if (!name || name === "*") continue;
      if (isUnused(lines, name, i)) {
        findings.push({ check: "unused-import", file, symbol: name, importLine: i });
      }
    }
  }

  return findings;
}

/**
 * Scan a Java file for unused imports.
 */
function scanJava(lines, file) {
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmedLine = lines[i].trim();
    const javaMatch = trimmedLine.match(/^import\s+(?:static\s+)?([\w.]+)\s*;/);
    if (!javaMatch) continue;

    const segments = javaMatch[1].split(".");
    const name = segments[segments.length - 1];
    if (isUnused(lines, name, i)) {
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

    if (language === "typescript") findings.push(...scanTypeScript(lines, file));
    if (language === "go") findings.push(...scanGo(lines, file));
    if (language === "python") findings.push(...scanPython(lines, file));
    if (language === "java") findings.push(...scanJava(lines, file));
  }

  return findings;
}
