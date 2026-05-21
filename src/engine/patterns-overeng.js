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

// Regex to detect pass-through functions (single-statement body that returns a call)
const passThroughRe =
  /(?:function\s+\w+\s*\([^)]*\)|(?:const|let|var)\s+\w+\s*=\s*(?:\([^)]*\)|[^=])\s*=>)\s*\{?\s*return\s+\w+[\w.]*\([^)]*\)\s*;?\s*\}?/g;
const goPasThroughRe = /func\s+\w+\s*\([^)]*\)[^{]*\{\s*return\s+\w+\s*\([^)]*\)\s*\}/g;

// Regex to find class definitions and their methods (TypeScript/JS/Java/C#)
const classRe = /class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const methodRe =
  /^\s+(?:(?:public|private|protected|static|async|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;
const interfaceRe = /interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
// Capture the entire implements clause (may include multiple comma-separated
// interfaces, e.g. `class Foo implements A, B, C {`).
const implementsClauseRe = /implements\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `importedSymbols` overlaps with `providedSymbols`.
 * Handles C# namespace-qualified imports by checking the last segment.
 */
function hasSymbolOverlap(importedSymbols, providedSymbols) {
  return [...importedSymbols].some((sym) => {
    if (providedSymbols.has(sym)) return true;
    if (sym.includes(".")) {
      return providedSymbols.has(sym.split(".").pop());
    }
    return false;
  });
}

/**
 * Build a fan-in count map: file -> number of other files that import from it.
 */
function buildFanIn(fileContents, fileImportedSymbols, exportedByFile) {
  const fanIn = new Map();
  for (const file of fileContents.keys()) {
    fanIn.set(file, 0);
  }
  for (const [importerFile, importedSymbols] of fileImportedSymbols) {
    for (const [providerFile, providedSymbols] of exportedByFile) {
      if (providerFile === importerFile) continue;
      if (hasSymbolOverlap(importedSymbols, providedSymbols)) {
        fanIn.set(providerFile, (fanIn.get(providerFile) ?? 0) + 1);
      }
    }
  }
  return fanIn;
}

/**
 * Extract the class body substring starting at `startSearchIdx` in `content`.
 * Returns null if no opening brace is found.
 */
function extractClassBody(content, startSearchIdx) {
  const startIdx = content.indexOf("{", startSearchIdx);
  if (startIdx === -1) return null;
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
  return content.slice(startIdx, endIdx + 1);
}

/**
 * Check for pass-through / delegation functions and emit a finding if warranted.
 * Only called for files with fan-in in 1–2 range.
 */
function checkPassThrough(file, content, language, fi, findings) {
  const re = language === "go" ? goPasThroughRe : passThroughRe;
  const passThroughs = content.match(re) ?? [];
  const totalFunctions = (
    content.match(/(?:function\s+\w+|=>\s*[{(]|\w+\s*\([^)]*\)\s*\{)/g) ?? []
  ).length;

  if (passThroughs.length === 0) return;
  if (totalFunctions === 0) return;
  if (passThroughs.length / totalFunctions < 0.5) return;

  findings.push({
    check: "over-engineering",
    file,
    symbol: basename(file),
    description: `Low fan-in (${fi} importers) with ${passThroughs.length}/${totalFunctions} pass-through functions — may be unnecessary abstraction layer`,
  });
}

/**
 * Check for single-method classes and emit a finding for each one found.
 */
function checkSingleMethodClasses(file, content, findings) {
  classRe.lastIndex = 0;
  let classMatch;
  while ((classMatch = classRe.exec(content)) !== null) {
    const className = classMatch[1];
    const classBody = extractClassBody(content, classMatch.index);
    if (!classBody) continue;

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
}

/**
 * Count implementations for each interface in this file, scanning all files
 * for `implements` and C# colon-based syntax.
 */
function countInterfaceImplementations(interfaces, language, fileContents) {
  for (const [, otherContent] of fileContents) {
    implementsClauseRe.lastIndex = 0;
    let implMatch;
    while ((implMatch = implementsClauseRe.exec(otherContent)) !== null) {
      for (const raw of implMatch[1].split(",")) {
        const name = raw.trim();
        if (interfaces.has(name)) {
          interfaces.set(name, interfaces.get(name) + 1);
        }
      }
    }

    if (language !== "csharp") continue;
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

/**
 * Check for single-implementation interfaces and emit findings.
 */
function checkSingleImplInterfaces(file, content, language, fileContents, findings) {
  const interfaces = new Map(); // name -> count
  interfaceRe.lastIndex = 0;
  let ifaceMatch;
  while ((ifaceMatch = interfaceRe.exec(content)) !== null) {
    interfaces.set(ifaceMatch[1], 0);
  }
  if (interfaces.size === 0) return;

  countInterfaceImplementations(interfaces, language, fileContents);

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

// ---------------------------------------------------------------------------
// Main scan
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

  const fileContents = new Map();
  const fileLanguages = new Map();
  const fileExports = new Map();
  const fileImportedSymbols = new Map();

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

  const exportedByFile = new Map();
  for (const [file, exps] of fileExports) {
    exportedByFile.set(file, new Set(exps.map((e) => e.name)));
  }

  // fan-in[file] = number of other files that import at least one symbol from it
  const fanIn = buildFanIn(fileContents, fileImportedSymbols, exportedByFile);

  for (const [file, content] of fileContents) {
    if (isTestFile(file) || isEntryPoint(file)) continue;
    const language = fileLanguages.get(file);

    // Low fan-in: imported by 1–2 files. 0 = dead code (Check 1), not over-engineering.
    const fi = fanIn.get(file) ?? 0;
    const isLowFanIn = fi >= 1 && fi <= 2;

    if (isLowFanIn) {
      checkPassThrough(file, content, language, fi, findings);
    }

    // Single-method classes and single-impl interfaces — only for typed OO languages at low fan-in.
    if ((language === "typescript" || language === "java" || language === "csharp") && isLowFanIn) {
      checkSingleMethodClasses(file, content, findings);
      checkSingleImplInterfaces(file, content, language, fileContents, findings);
    }
  }

  return findings;
}
