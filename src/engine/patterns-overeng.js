import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  detectLanguage,
  extractExports,
  extractImports,
  isEntryPoint,
  isTestFile,
} from "./cross-ref.js";
import { collectFiles } from "./files.js";

// ---------------------------------------------------------------------------
// Check 13 — Over-engineering
// ---------------------------------------------------------------------------

/**
 * Scan for over-engineered code: single-method classes, pass-through functions,
 * low fan-in abstractions, and single-implementation interfaces.
 * @param {string} path - Directory to scan
 * @param {object} [options]
 * @param {string[]} [options.exclude]
 * @param {string[]} [options.languages]
 * @returns {Promise<Array<{check: string, file: string, symbol: string, description: string}>>}
 */
export async function scanOverEngineering(path, options = {}) {
  const files = await collectFiles(path, options);
  const findings = [];

  // Build import graph: for each file, which other files import it?
  // fan-in[file] = set of files that import symbols from `file`
  const fileContents = new Map();
  const fileLanguages = new Map();
  const fileExports = new Map();
  const fileImportedSymbols = new Map(); // file -> Set<symbol name>

  for (const file of files) {
    const language = detectLanguage(file);
    if (!language) continue;
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    fileContents.set(file, content);
    fileLanguages.set(file, language);
    fileExports.set(file, extractExports(content, language));
    fileImportedSymbols.set(file, new Set(extractImports(content, language)));
  }

  // fan-in count: how many files import at least one symbol from a given file
  const fanIn = new Map();
  for (const file of fileContents.keys()) {
    fanIn.set(file, 0);
  }
  const exportedByFile = new Map();
  for (const [file, exps] of fileExports) {
    exportedByFile.set(file, new Set(exps.map((e) => e.name)));
  }

  for (const [importerFile, importedSymbols] of fileImportedSymbols) {
    for (const [providerFile, providedSymbols] of exportedByFile) {
      if (providerFile === importerFile) continue;
      // For C# namespace-qualified imports (e.g. "MyApp.IService"), also check
      // whether the last segment matches an exported symbol name.
      const overlap = [...importedSymbols].some((sym) => {
        if (providedSymbols.has(sym)) return true;
        if (sym.includes(".")) {
          const lastSeg = sym.split(".").pop();
          return providedSymbols.has(lastSeg);
        }
        return false;
      });
      if (overlap) {
        fanIn.set(providerFile, (fanIn.get(providerFile) ?? 0) + 1);
      }
    }
  }

  // Regex to detect pass-through functions (single-statement body that returns a call)
  const passThroughRe =
    /(?:function\s+\w+\s*\([^)]*\)|(?:const|let|var)\s+\w+\s*=\s*(?:\([^)]*\)|[^=])\s*=>)\s*\{?\s*return\s+\w+[\w.]*\([^)]*\)\s*;?\s*\}?/g;

  // Regex to find class definitions and their methods (TypeScript/JS)
  const classRe = /class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const methodRe =
    /^\s+(?:(?:public|private|protected|static|async|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;
  const interfaceRe = /interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  // Capture the entire implements clause (may include multiple comma-separated
  // interfaces, e.g. `class Foo implements A, B, C {`). Each interface name is
  // extracted by splitting the captured group on `,`.
  const implementsClauseRe = /implements\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/g;

  for (const [file, content] of fileContents) {
    if (isTestFile(file) || isEntryPoint(file)) continue;
    const language = fileLanguages.get(file);

    // Low fan-in check (imported by 1–2 other files; 0 = dead code, handled by Check 1)
    const fi = fanIn.get(file) ?? 0;
    const isLowFanIn = fi >= 1 && fi <= 2;

    // Pass-through / delegation functions
    if (isLowFanIn) {
      // For Go, use a Go-specific pass-through pattern since JS syntax doesn't apply
      let effectivePassThroughRe = passThroughRe;
      if (language === "go") {
        effectivePassThroughRe = /func\s+\w+\s*\([^)]*\)[^{]*\{\s*return\s+\w+\s*\([^)]*\)\s*\}/g;
      }
      const passThroughs = content.match(effectivePassThroughRe) ?? [];
      // Count free functions, arrow expressions, AND class methods so the
      // denominator isn't artificially small for class-heavy files.
      const totalFunctions = (
        content.match(/(?:function\s+\w+|=>\s*[{(]|\w+\s*\([^)]*\)\s*\{)/g) ?? []
      ).length;
      if (
        passThroughs.length > 0 &&
        totalFunctions > 0 &&
        passThroughs.length / totalFunctions >= 0.5
      ) {
        findings.push({
          check: "over-engineering",
          file,
          symbol: basename(file),
          description: `Low fan-in (${fi} importers) with ${passThroughs.length}/${totalFunctions} pass-through functions — may be unnecessary abstraction layer`,
        });
      }
    }

    // Single-method classes and single-impl interfaces — only flag at low fan-in.
    // Class/method/interface regexes are syntactically compatible with Java/C#
    // (both use `class X { method() { ... } }` and `interface Y { ... }`).
    if ((language === "typescript" || language === "java" || language === "csharp") && isLowFanIn) {
      let classMatch;
      classRe.lastIndex = 0;
      while ((classMatch = classRe.exec(content)) !== null) {
        const className = classMatch[1];
        // Extract the class body (rough: from { to matching })
        const startIdx = content.indexOf("{", classMatch.index);
        if (startIdx === -1) continue;
        let depth = 0;
        let endIdx = startIdx;
        for (let i = startIdx; i < content.length; i++) {
          if (content[i] === "{") depth++;
          else if (content[i] === "}") {
            depth--;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
        }
        const classBody = content.slice(startIdx, endIdx + 1);

        // Count methods (excluding constructor)
        const methods = [];
        let methodMatch;
        methodRe.lastIndex = 0;
        while ((methodMatch = methodRe.exec(classBody)) !== null) {
          if (methodMatch[1] !== "constructor") methods.push(methodMatch[1]);
        }

        if (methods.length === 1) {
          findings.push({
            check: "over-engineering",
            file,
            symbol: className,
            description: `Single-method class (only method: ${methods[0]}) — a plain function may suffice`,
          });
        }
      }

      // Single-implementation interfaces
      // Collect all interface names and all implements clauses
      const interfaces = new Map(); // name -> 0
      let ifaceMatch;
      interfaceRe.lastIndex = 0;
      while ((ifaceMatch = interfaceRe.exec(content)) !== null) {
        interfaces.set(ifaceMatch[1], 0);
      }
      if (interfaces.size > 0) {
        // Count across all files how many classes implement each interface.
        // A single `implements A, B, C` clause counts as one implementation
        // for each of A, B and C — so we split the captured clause on `,`.
        for (const [, otherContent] of fileContents) {
          let implMatch;
          implementsClauseRe.lastIndex = 0;
          while ((implMatch = implementsClauseRe.exec(otherContent)) !== null) {
            for (const raw of implMatch[1].split(",")) {
              const name = raw.trim();
              if (interfaces.has(name)) {
                interfaces.set(name, interfaces.get(name) + 1);
              }
            }
          }
          // For C#, also check colon-based implementation syntax: class Foo : IBar, IBaz
          if (language === "csharp") {
            const colonImplRe = /class\s+\w+\s*:\s*([A-Za-z_][\w]*(?:\s*,\s*[A-Za-z_][\w]*)*)/g;
            let colonMatch;
            while ((colonMatch = colonImplRe.exec(otherContent)) !== null) {
              for (const name of colonMatch[1].split(",")) {
                const trimmed = name.trim();
                if (trimmed && interfaces.has(trimmed)) {
                  interfaces.set(trimmed, interfaces.get(trimmed) + 1);
                }
              }
            }
          }
        }
        for (const [ifaceName, count] of interfaces) {
          if (count === 1) {
            findings.push({
              check: "over-engineering",
              file,
              symbol: ifaceName,
              description: `Interface ${ifaceName} has only one implementation — may be unnecessary abstraction`,
            });
          }
        }
      }
    }
  }

  return findings;
}
