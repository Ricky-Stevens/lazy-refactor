import { readFile } from "node:fs/promises";
import { collectFiles } from "../files.js";
import { detectLanguage, isTestFile } from "./classify.js";

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
